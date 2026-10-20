import type { Snapshot } from '@crewkite/contracts';
import { useState } from 'react';
import { googleAcpLabel } from './launch.tsx';
import type { Workspace } from './source.ts';

const setupLabels: Record<string, string> = {
  uninitialized: 'Not initialized',
  initializing: 'Initializing',
  'authentication-required': 'Sign-in required',
  'discovery-required': 'Signed in, discover choices',
  authenticating: 'Signing in',
  discovering: 'Discovering choices',
  ready: 'Ready',
  stopping: 'Stopping',
  blocked: 'Setup blocked',
  unknown: 'Setup status unknown',
};

export function GoogleSetup({
  snapshot,
  workspace,
}: {
  snapshot: Pick<Snapshot, 'googleAcpSetup' | 'googleAcpInstall' | 'nativeProfiles'>;
  workspace: Workspace;
}) {
  const setup = snapshot.googleAcpSetup;
  const installation = snapshot.googleAcpInstall;
  const profile = snapshot.nativeProfiles.find(
    (value) => value.family === 'google' && 'configOptions' in value,
  );
  const [requested, setRequested] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const connected = workspace.connection === 'connected' && !workspace.preview;
  const active = !!setup?.operationId;
  const installing = !!installation?.operationId;
  const installed =
    installation?.state === 'installed' || !!setup?.client || !!profile?.configOptions;
  const working = !!requested || active || installing;
  async function action(
    kind: 'install' | 'initialize' | 'authenticate' | 'discover' | 'stop' | 'stop-install',
  ) {
    setMessage(null);
    if (kind !== 'stop' && kind !== 'stop-install') setRequested(kind);
    try {
      const fresh =
        kind === 'stop' || kind === 'stop-install' ? await workspace.refresh() : snapshot;
      const current = fresh.googleAcpSetup;
      if (kind === 'stop-install' && !fresh.googleAcpInstall?.operationId) {
        setMessage('No exact installation is active. Refresh status before retrying.');
        return;
      }
      if (kind === 'stop' && !current?.operationId) {
        setMessage('No exact setup operation is active. Refresh status before retrying.');
        return;
      }
      if ((kind === 'authenticate' || kind === 'discover') && !current?.proofId) {
        setMessage('Initialize Google ACP and inspect its retained proof first.');
        return;
      }
      const result = await workspace.metadataCommand(
        kind === 'install'
          ? {
              command: 'InstallGoogleAcp',
              expectedRevision: 0,
              payload: { profileId: 'google-acp-v1', consent: 'explicit' },
            }
          : kind === 'stop-install'
            ? {
                command: 'StopGoogleAcpInstall',
                expectedRevision: 0,
                payload: {
                  profileId: 'google-acp-v1',
                  operationId: fresh.googleAcpInstall?.operationId as string,
                },
              }
            : kind === 'stop'
              ? {
                  command: 'StopGoogleAcpSetup',
                  expectedRevision: current?.revision ?? 0,
                  payload: {
                    profileId: 'google-acp-v1',
                    operationId: current?.operationId as string,
                  },
                }
              : kind === 'initialize'
                ? {
                    command: 'InitializeGoogleAcp',
                    expectedRevision: current?.revision ?? 0,
                    payload: { profileId: 'google-acp-v1', consent: 'explicit' },
                  }
                : kind === 'authenticate'
                  ? {
                      command: 'AuthenticateGoogleAcp',
                      expectedRevision: current?.revision ?? 0,
                      payload: {
                        profileId: 'google-acp-v1',
                        proofId: current?.proofId as string,
                        method: 'oauth-personal',
                        consent: 'explicit',
                      },
                    }
                  : {
                      command: 'DiscoverGoogleAcp',
                      expectedRevision: current?.revision ?? 0,
                      payload: {
                        profileId: 'google-acp-v1',
                        proofId: current?.proofId as string,
                        consent: 'explicit',
                      },
                    },
      );
      const signedIn =
        kind === 'authenticate' &&
        (result.outcome === 'applied' || result.outcome === 'already-applied') &&
        result.data?.kind === 'google-acp-setup' &&
        result.data.setup.auth.status === 'authenticated';
      setMessage(
        result.reason
          ? [result.reason, result.next].filter(Boolean).join(' ')
          : signedIn
            ? 'Signed in. Discover Google choices to finish setup.'
            : result.next ||
              (result.data?.kind === 'google-acp-install'
                ? `Installation ${result.data.install.state}. ${result.data.install.next}`
                : result.data?.kind === 'google-acp-setup'
                  ? `${setupLabels[result.data.setup.state] ?? result.data.setup.state}${result.data.setup.reason ? `: ${result.data.setup.reason}` : ''}.`
                  : result.outcome),
      );
    } catch {
      setMessage('The setup action could not be confirmed. Refresh status before retrying.');
    } finally {
      if (kind !== 'stop' && kind !== 'stop-install') setRequested(null);
    }
  }
  return (
    <section className="card view-stack" aria-labelledby="google-setup-title">
      <div className="section-heading">
        <h2 id="google-setup-title">Google ACP setup</h2>
        <span>{setupLabels[setup?.state ?? 'uninitialized'] ?? setup?.state}</span>
      </div>
      <p className="muted small">{googleAcpLabel}</p>
      <p className="muted small">
        Install the official client, initialize it, then sign in and discover your choices.
        Installation downloads and verifies the client; an existing valid client skips the download.
        Initialization and discovery use no model prompt. Sign-in is a separate step that may open
        your browser, contact Google and save native authentication state.
      </p>
      <div className="dialog-footer">
        <button
          className="button secondary"
          type="button"
          disabled={!connected || working}
          onClick={() => void action('install')}
        >
          {installed ? 'Verify installed Google client' : 'Install official Google client'}
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!connected || (!installing && requested !== 'install')}
          onClick={() => void action('stop-install')}
        >
          Stop installation
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!connected || working || !installed}
          onClick={() => void action('initialize')}
        >
          Initialize Google ACP
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!connected || working || !setup?.proofId}
          onClick={() => void action('authenticate')}
        >
          Sign in with Google
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={
            !connected || working || !setup?.proofId || setup.auth.status !== 'authenticated'
          }
          onClick={() => void action('discover')}
        >
          Discover Google choices
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={
            !connected ||
            (!active && !['initialize', 'authenticate', 'discover'].includes(requested ?? ''))
          }
          onClick={() => void action('stop')}
        >
          Stop setup
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!connected}
          onClick={() =>
            void workspace.refresh().catch(() => setMessage('Setup status could not be read.'))
          }
        >
          Refresh setup status
        </button>
      </div>
      {requested && (
        <p role="status">
          {requested === 'install'
            ? 'Installation'
            : requested === 'authenticate'
              ? 'Sign-in'
              : requested === 'discover'
                ? 'Discovery'
                : 'Initialization'}{' '}
          in progress. You can stop the operation or refresh its status.
        </p>
      )}
      {installation?.reason && (
        <p className="muted small">
          {installation.reason}. {installation.next}
        </p>
      )}
      <p className="muted small">
        Official client: {installation?.state ?? (installed ? 'installed' : 'not installed')}.
      </p>
      <p className="muted small">
        Authentication: {setup?.auth.status ?? 'unknown'}. Availability:{' '}
        {profile?.reason ?? 'not-configured'}. Setup revision: {setup?.revision ?? 0}.
      </p>
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
