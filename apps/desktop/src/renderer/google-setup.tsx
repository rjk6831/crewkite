import type { Snapshot } from '@crewkite/contracts';
import { useEffect, useRef, useState } from 'react';
import { Fact } from './components.tsx';
import {
  type GoogleSetupStage,
  pollGoogleSetupStatus,
  runGoogleSetupFlow,
} from './google-setup-flow.ts';
import { googleAcpLabel } from './launch.tsx';
import type { Workspace } from './source.ts';

const setupLabels: Record<string, string> = {
  uninitialized: 'Not initialized',
  initializing: 'Initializing',
  'authentication-required': 'Sign-in required',
  'discovery-required': 'Signed in, discovering choices',
  authenticating: 'Signing in',
  discovering: 'Discovering choices',
  ready: 'Ready',
  stopping: 'Stopping',
  blocked: 'Setup blocked',
  unknown: 'Setup status unknown',
};

const stageLabels: Record<GoogleSetupStage, string> = {
  install: 'Installing and verifying the official client',
  initialize: 'Initializing Google ACP',
  authenticate: 'Waiting for Google account sign-in',
  discover: 'Discovering Google choices',
};

export function GoogleSetup({
  snapshot,
  workspace,
}: {
  snapshot: Pick<
    Snapshot,
    'googleAcpSetup' | 'googleAcpInstall' | 'nativeProfiles' | 'usageReaders'
  >;
  workspace: Workspace;
}) {
  const setup = snapshot.googleAcpSetup;
  const installation = snapshot.googleAcpInstall;
  const profile = snapshot.nativeProfiles.find(
    (value) => value.family === 'google' && 'configOptions' in value,
  );
  const reader = snapshot.usageReaders.find((value) => value.family === 'google');
  const [requested, setRequested] = useState<GoogleSetupStage | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const pollAbort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const connected = workspace.connection === 'connected' && !workspace.preview;
  const active = !!setup?.operationId;
  const installing = !!installation?.operationId;
  const installed = installation?.state === 'installed' || !!setup?.client;
  const unknown = setup?.state === 'unknown' || installation?.state === 'unknown';
  const needsRepair = unknown || setup?.state === 'blocked' || installation?.state === 'blocked';
  const ready = setup?.state === 'ready';
  const working = !!requested || active || installing || cancelBusy;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      pollAbort.current?.abort();
    };
  }, []);

  function stopPolling() {
    generation.current += 1;
    pollAbort.current?.abort();
    pollAbort.current = null;
  }

  function startPolling(currentGeneration: number) {
    const controller = new AbortController();
    pollAbort.current = controller;
    void pollGoogleSetupStatus({
      wait: () =>
        new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 1_000);
          controller.signal.addEventListener(
            'abort',
            () => {
              window.clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
      read: workspace.refresh,
      active: () =>
        mounted.current && generation.current === currentGeneration && !controller.signal.aborted,
    })
      .then((result) => {
        if (result === 'timeout' && mounted.current && generation.current === currentGeneration) {
          setPollTimedOut(true);
        }
      })
      .catch(() => {
        if (!mounted.current || generation.current !== currentGeneration) return;
        generation.current += 1;
        controller.abort();
        if (pollAbort.current === controller) pollAbort.current = null;
        setRequested(null);
        setMessage('Setup status could not be read. Automatic setup is paused.');
      });
  }

  async function connectGoogle() {
    if (!connected || working || unknown) return;
    stopPolling();
    const currentGeneration = generation.current;
    setMessage(null);
    setPollTimedOut(false);
    startPolling(currentGeneration);
    try {
      const result = await runGoogleSetupFlow({
        read: workspace.refresh,
        command: workspace.metadataCommand,
        active: () => mounted.current && generation.current === currentGeneration,
        onStage: (stage) => {
          if (mounted.current && generation.current === currentGeneration) setRequested(stage);
        },
      });
      if (!mounted.current || generation.current !== currentGeneration) return;
      if (result.kind === 'ready') {
        setMessage('Google coding setup is ready. Quota reporting remains a separate status.');
      } else if (result.kind === 'blocked') {
        setMessage(
          result.result?.reason
            ? [result.result.reason, result.result.next].filter(Boolean).join(' ')
            : 'Setup stopped before the next step could be confirmed. Review status before retrying.',
        );
      }
    } catch {
      if (mounted.current && generation.current === currentGeneration) {
        setMessage('The setup outcome could not be confirmed. Review status before retrying.');
      }
    } finally {
      if (mounted.current && generation.current === currentGeneration) {
        pollAbort.current?.abort();
        pollAbort.current = null;
        setRequested(null);
      }
    }
  }

  async function cancelCurrent() {
    if (!connected || cancelBusy) return;
    stopPolling();
    setRequested(null);
    setPollTimedOut(false);
    setCancelBusy(true);
    try {
      const fresh = await workspace.refresh();
      if (!mounted.current) return;
      const currentInstall = fresh.googleAcpInstall;
      const currentSetup = fresh.googleAcpSetup;
      const result = currentInstall?.operationId
        ? await workspace.metadataCommand({
            command: 'StopGoogleAcpInstall',
            expectedRevision: 0,
            payload: {
              profileId: 'google-acp-v1',
              operationId: currentInstall.operationId,
            },
          })
        : currentSetup?.operationId
          ? await workspace.metadataCommand({
              command: 'StopGoogleAcpSetup',
              expectedRevision: currentSetup.revision,
              payload: {
                profileId: 'google-acp-v1',
                operationId: currentSetup.operationId,
              },
            })
          : null;
      if (!mounted.current) return;
      setMessage(
        result
          ? result.reason || result.next || 'Cancellation requested for the active operation.'
          : 'No exact Google setup operation is active.',
      );
    } catch {
      if (mounted.current) {
        setMessage('Cancellation could not be confirmed. Review status before retrying.');
      }
    } finally {
      if (mounted.current) setCancelBusy(false);
    }
  }

  const primaryLabel =
    setup?.state === 'authentication-required' ? 'Sign in with Google' : 'Connect Google';
  const googleAccount =
    setup?.auth.status === 'authenticated'
      ? 'Signed in'
      : setup?.auth.status === 'required'
        ? 'Sign-in required'
        : 'Unknown';
  const codingReady = ready && profile?.available === true;
  const officialClient = installed
    ? 'Installed'
    : installation?.state === 'idle'
      ? 'Not installed'
      : 'Unknown';
  const quotaAvailable = reader?.lastObservedAt
    ? 'Reported'
    : reader?.available
      ? 'Reader ready, not read'
      : 'Unknown';

  return (
    <section className="card view-stack" aria-labelledby="google-setup-title">
      <div className="section-heading">
        <h2 id="google-setup-title">Google ACP setup</h2>
        <span>{setupLabels[setup?.state ?? 'uninitialized'] ?? setup?.state}</span>
      </div>
      <p className="muted small">{googleAcpLabel}</p>
      <p className="muted small">
        Connect Google downloads and verifies the official client when needed, initializes it, then
        opens browser sign-in for your Google account and discovers your choices. You complete and
        control the Google sign-in. Initialization and discovery use no model prompt.
      </p>
      <div className="facts-grid compact">
        <Fact label="Official client" value={officialClient} />
        <Fact label="Google account" value={googleAccount} />
        <Fact label="Coding setup ready" value={codingReady ? 'Yes' : 'No'} />
        <Fact label="Quota available" value={quotaAvailable} />
      </div>
      <div className="dialog-footer">
        {!ready && !working && !needsRepair && (
          <button
            className="button primary"
            type="button"
            disabled={!connected}
            onClick={() => void connectGoogle()}
          >
            {primaryLabel}
          </button>
        )}
        {working && (active || installing) && (
          <button
            className="button secondary"
            type="button"
            disabled={!connected || cancelBusy}
            onClick={() => void cancelCurrent()}
          >
            {cancelBusy ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>
      {requested && <p role="status">{stageLabels[requested]}…</p>}
      {ready && <p role="status">Google coding setup is ready.</p>}
      {pollTimedOut && (
        <p role="status">Taking longer than expected. Review status before retrying.</p>
      )}
      {installation?.reason && (
        <p className="muted small">
          {installation.reason}. {installation.next}
        </p>
      )}
      <p className="muted small">
        Discovery choices establish configuration facts. A verified review mapping and route
        qualification remain separate requirements.
      </p>
      {profile && (
        <p className="muted small">
          Models: {profile.configOptions?.model.supported.join(', ') ?? 'unknown'}. Thought levels:{' '}
          {profile.configOptions?.thoughtLevel?.supported.join(', ') ?? 'unknown'}.
        </p>
      )}
      {needsRepair && (
        <details>
          <summary>Advanced repair controls</summary>
          <p className="muted small">
            Setup needs a fresh status check before another action. Automatic setup is paused to
            avoid repeating an operation with uncertain ownership.
          </p>
          <button
            className="button secondary"
            type="button"
            disabled={!connected || working}
            onClick={() =>
              void workspace.refresh().catch(() => setMessage('Setup status could not be read.'))
            }
          >
            Refresh status
          </button>
        </details>
      )}
      {setup?.client && (
        <details>
          <summary>Client and proof identity</summary>
          <p>
            Version {setup.client.version}. Digest {setup.client.sha256}. Signer{' '}
            {setup.client.signerTeamId}. Proof {setup.proofId ?? 'none'}. Operation{' '}
            {setup.operationId ?? 'none'}.
          </p>
        </details>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
