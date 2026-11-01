import {
  type CommandResult,
  GOOGLE_TERMS_CHECKBOX,
  GOOGLE_TERMS_SUMMARY,
  GOOGLE_TERMS_VERSION,
  googleTermsCurrent,
  type Snapshot,
} from '@crewkite/contracts';
import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Fact } from './components.tsx';
import { formatLocalTime } from './format-time.ts';
import {
  GOOGLE_CONNECT_LIMIT_MS,
  GOOGLE_PROGRESS_STEPS,
  type GoogleSetupProgress,
  type GoogleSetupStage,
  googleConnectButton,
  googleSetupProgress,
  pollGoogleSetupStatus,
  runGoogleSetupFlow,
  startingGoogleStage,
} from './google-setup-flow.ts';
import type { Workspace } from './source.ts';
import './google-setup.css';

// A first connect downloads about 110 MB and waits on a browser sign-in, so the card reads the
// status each second for as long as one Connect may run.
const POLL_ATTEMPTS = GOOGLE_CONNECT_LIMIT_MS / 1_000;

/** The whole connect as one bar, the current step named, and every step listed under it. */
function GoogleProgress({ progress }: { progress: GoogleSetupProgress }) {
  const index = GOOGLE_PROGRESS_STEPS.findIndex(({ id }) => id === progress.step);
  const position = `Step ${index + 1} of ${GOOGLE_PROGRESS_STEPS.length}`;
  const label = GOOGLE_PROGRESS_STEPS[index]?.label ?? '';
  return (
    <div className="gs-progress">
      <p className="gs-progress-head" role="status">
        {position}: {label}
      </p>
      <div
        className="gs-progress-track"
        role="progressbar"
        aria-label="Google connect progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-valuetext={`${progress.percent} percent. ${position}, ${label}. ${progress.detail}`}
      >
        <div className="gs-progress-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <p className="muted small">{progress.detail}</p>
      <ol className="gs-progress-steps" aria-label="Connect steps">
        {GOOGLE_PROGRESS_STEPS.map((step, at) => (
          <li
            key={step.id}
            className={at < index ? 'is-done' : at === index ? 'is-current' : undefined}
            aria-current={at === index ? 'step' : undefined}
          >
            <span className="gs-progress-mark" aria-hidden="true">
              {at < index && <Check size={12} />}
            </span>
            {at < index && <span className="gs-sr-only">Done: </span>}
            {step.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

const googleAcpLabel =
  'Google’s published ACP agent, signed in with your own Google account. Google documents this agent for editors; CrewKite is not named.';

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

// Refusal codes the controller sends when setup cannot start, in the words the card shows.
const refusalText: Record<string, string> = {
  'google-operation-active':
    'Another Google step is running, such as the quota read or a coding turn. Try again when it ends.',
  'google-ownership-unknown':
    'CrewKite cannot prove the last Google step ended, so Google setup is paused. Press Try again.',
  'google-install-active': 'The official client is still installing. This card follows it.',
  'google-install-ownership-unknown':
    'CrewKite cannot prove the last install check ended. Refresh status in a minute.',
  'acp-setup-timeout': 'The Google client did not answer in time. Press Try again.',
  'acp-setup-failed': 'The Google client stopped before the step finished. Press Try again.',
  'acp-setup-stopped': 'The step was stopped before it finished.',
  'acp-proof-unavailable': 'The saved setup no longer matches the client. Press Try again.',
  'acp-setup-not-current': 'The setup moved on since this card read it. Press Try again.',
  'acp-capability-missing':
    'The client did not report the model choices CrewKite needs. Press Try again.',
  'authentication-required': 'The Google sign-in did not finish. Press Try again to sign in.',
  'google-status-unreadable':
    'Setup status could not be read three times in a row, so Connect paused. Press it again to continue.',
  'google-connect-limit':
    'Connect did not finish within 20 minutes. Press Try again to continue from this step.',
};

// Why the coding setup is not ready, from the Google profile, in plain words.
const profileText: Record<string, string> = {
  'client-unavailable': 'The official client is not installed.',
  'client-build-mismatch': 'The installed client does not match the reviewed build.',
  'unsupported-platform': 'Google coding setup needs a Mac with Apple silicon.',
  'native-home-unavailable': 'The client cannot read your home folder from this controller.',
  'auth-method-mismatch': 'The client does not offer personal Google sign-in.',
  'authentication-required': 'Google sign-in has not finished.',
  'qualification-pending': 'Setup is complete. The route still needs qualification.',
};

/** True when a command result is the install's own outcome, which the install line shows. */
function installOutcome(result: CommandResult | undefined) {
  return (
    result?.data?.kind === 'google-acp-install' &&
    !!result.reason &&
    result.data.install.reason === result.reason
  );
}

const stageLabels: Record<GoogleSetupStage, string> = {
  clear: 'Clearing the stuck setup step',
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
  // A follow that could not read the status three times in a row stays off until the card opens again.
  const [pollUnreadable, setPollUnreadable] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [termsChecked, setTermsChecked] = useState(false);
  const pollAbort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const connected = workspace.connection === 'connected' && !workspace.preview;
  // A step whose ownership is unknown runs nothing this card can follow. It waits for Clear.
  const active = !!setup?.operationId && setup.state !== 'unknown';
  const installing = !!installation?.operationId && installation.state !== 'unknown';
  const installed = installation?.state === 'installed' || !!setup?.client;
  const installUnknown = installation?.state === 'unknown';
  const unknown = setup?.state === 'unknown' || installUnknown;
  const needsRepair = unknown || setup?.state === 'blocked' || installation?.state === 'blocked';
  const ready = setup?.state === 'ready';
  const working = !!requested || active || installing || cancelBusy;
  const termsAcknowledged = googleTermsCurrent(setup?.googleTerms);
  const termsAccepted = termsAcknowledged || termsChecked;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      pollAbort.current?.abort();
    };
  }, []);

  // A setup started from another card, or before this one opened, keeps running in the controller.
  // Follow it, so the card shows the step and turns Connect off until it ends.
  useEffect(() => {
    // After a 15-minute follow times out the card stops reading every second and says so.
    if (!(active || installing) || requested || pollAbort.current || pollTimedOut || pollUnreadable)
      return;
    startPolling(generation.current, false);
  });

  function stopPolling() {
    generation.current += 1;
    pollAbort.current?.abort();
    pollAbort.current = null;
  }

  /**
   * Reads the status each second so the card follows a running step. During a Connect the flow
   * reads the state itself and decides when to pause, so a poll that cannot read leaves it alone.
   */
  function startPolling(currentGeneration: number, connecting: boolean) {
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
      attempts: POLL_ATTEMPTS,
    }).then((result) => {
      if (pollAbort.current === controller) pollAbort.current = null;
      if (!mounted.current || generation.current !== currentGeneration) return;
      if (result === 'timeout') setPollTimedOut(true);
      if (result === 'unreadable' && !connecting) {
        setPollUnreadable(true);
        setMessage(
          'Setup status could not be read three times in a row. Open Settings again to read it.',
        );
      }
    });
  }

  async function connectGoogle() {
    if (!connected || working || installUnknown || !termsAccepted) return;
    stopPolling();
    const currentGeneration = generation.current;
    // The press shows its first step at once. The first status read can take a few seconds.
    setRequested(startingGoogleStage({ googleAcpInstall: installation, googleAcpSetup: setup }));
    setMessage(null);
    setPollTimedOut(false);
    setPollUnreadable(false);
    startPolling(currentGeneration, true);
    try {
      const result = await runGoogleSetupFlow({
        read: workspace.refresh,
        command: workspace.metadataCommand,
        active: () => mounted.current && generation.current === currentGeneration,
        // A transient failure runs its step again with no word here. The bar shows the step.
        onStage: (stage) => {
          if (mounted.current && generation.current === currentGeneration) setRequested(stage);
        },
      });
      if (!mounted.current || generation.current !== currentGeneration) return;
      if (result.kind === 'ready') {
        // The heading says Ready, so the card shows no second line for it.
        setMessage(null);
      } else if (result.kind === 'blocked' && installOutcome(result.result)) {
        // The install line under the progress shows the install outcome once.
        setMessage(null);
      } else if (result.kind === 'blocked') {
        const reason = result.result?.reason;
        // A refused clear names the process that still runs in its next step.
        const known =
          result.result?.next && reason === 'google-ownership-unknown'
            ? result.result.next
            : reason
              ? refusalText[reason]
              : undefined;
        setMessage(
          known ??
            (reason
              ? [reason, result.result?.next].filter(Boolean).join(' ')
              : 'Setup stopped before the next step could be confirmed. Review status before retrying.'),
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
        // The poll gives up after 15 minutes, and a browser sign-in can take longer. Once the
        // flow ends, the slow-setup line no longer describes anything.
        setPollTimedOut(false);
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
      // A stopped install shows its sentence in the install line below.
      setMessage(
        !result
          ? 'No exact Google setup operation is active.'
          : installOutcome(result)
            ? null
            : (refusalText[result.reason ?? ''] ??
              result.next ??
              'Cancellation requested for the active operation.'),
      );
    } catch {
      if (mounted.current) {
        setMessage('Cancellation could not be confirmed. Review status before retrying.');
      }
    } finally {
      if (mounted.current) setCancelBusy(false);
    }
  }

  // One button. Connect runs every step to the end, sign-in included, and Try again resumes at
  // the step that failed, clearing a stuck step first when its process has ended.
  const primaryLabel = needsRepair ? 'Try again' : 'Connect Google';
  const primary = googleConnectButton({
    working,
    running: active || installing,
    cancelling: cancelBusy,
    label: primaryLabel,
  });
  const profileReason =
    profile && !profile.available && 'reason' in profile
      ? profile.reason === 'acp-capability-missing'
        ? setup?.proofId
          ? 'The client did not report the model choices or review mode CrewKite needs.'
          : 'The client is installed and has not finished initializing.'
        : profileText[profile.reason]
      : undefined;
  const googleAccount =
    setup?.auth.status === 'authenticated'
      ? 'Signed in'
      : setup?.auth.status === 'required'
        ? 'Sign-in required'
        : 'Unknown';
  const codingReady = ready && profile?.available === true;
  const progress = googleSetupProgress(
    { googleAcpInstall: installation, googleAcpSetup: setup },
    requested,
  );
  const officialClient = installed
    ? 'Installed'
    : installation?.state === 'idle'
      ? 'Not installed'
      : 'Unknown';
  // The quota read waits for Connect.
  const quotaAvailable = !ready
    ? 'Read after Connect'
    : reader?.lastObservedAt
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
      {/* The terms and the acknowledgement lead the card, at body size. */}
      <div className="gs-terms">
        {GOOGLE_TERMS_SUMMARY.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {termsAcknowledged ? (
          <p className="muted small">
            You acknowledged this on {formatLocalTime(setup?.googleTerms?.at) ?? 'an unknown date'}.
          </p>
        ) : (
          <label className="check-row gs-terms-check">
            <input
              type="checkbox"
              checked={termsChecked}
              onChange={(event) => setTermsChecked(event.target.checked)}
            />
            <span>{GOOGLE_TERMS_CHECKBOX}</span>
          </label>
        )}
      </div>
      {!termsAcknowledged && (ready || needsRepair) && (
        <button
          className="button secondary"
          type="button"
          disabled={!connected || !termsChecked}
          onClick={() =>
            void workspace
              .metadataCommand({
                command: 'AcknowledgeGoogleTerms',
                expectedRevision: 0,
                payload: { textVersion: GOOGLE_TERMS_VERSION },
              })
              .catch(() => setMessage('The acknowledgement could not be confirmed.'))
          }
        >
          Acknowledge
        </button>
      )}
      <details className="gs-how">
        <summary>How Connect works</summary>
        <p className="muted small">
          Connect Google downloads and verifies the official client when needed, initializes it,
          then opens browser sign-in for your Google account and discovers your choices. You
          complete and control the Google sign-in. Initialization and discovery use no model prompt.
        </p>
      </details>
      <div className="facts-grid compact">
        <Fact label="Official client" value={officialClient} />
        <Fact label="Google account" value={googleAccount} />
        <Fact label="Coding setup ready" value={codingReady ? 'Yes' : 'No'} />
        <Fact label="Quota available" value={quotaAvailable} />
      </div>
      <div className="gs-actions">
        {/* The button stays where it is while Connect runs, so Cancel never takes its place. */}
        {!ready && !installUnknown && (
          <button
            className="button primary"
            type="button"
            disabled={!connected || !termsAccepted || primary.disabled}
            onClick={() => void connectGoogle()}
          >
            {primary.label}
          </button>
        )}
        {working && (active || installing) && (
          <button
            className="button secondary gs-cancel"
            type="button"
            disabled={!connected || cancelBusy}
            onClick={() => void cancelCurrent()}
          >
            {cancelBusy ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>
      {progress ? (
        <GoogleProgress progress={progress} />
      ) : requested ? (
        <p role="status">{stageLabels[requested]}…</p>
      ) : active ? (
        <p role="status">Google setup is running…</p>
      ) : null}
      {pollTimedOut && !ready && (
        <p role="status">Taking longer than expected. Review status before retrying.</p>
      )}
      {!working && installation?.reason && (
        <p className="muted small">{refusalText[installation.reason] ?? installation.next}</p>
      )}
      {installed && !codingReady && !working && !message && profileReason && (
        <p className="muted small">{profileReason}</p>
      )}
      {/* The model list is known once discovery ends. Until then the line would only say unknown. */}
      {!working && profile?.configOptions && (
        <p className="muted small">
          Models: {profile.configOptions.model.supported.join(', ')}.
          {profile.configOptions.thoughtLevel &&
            ` Thought levels: ${profile.configOptions.thoughtLevel.supported.join(', ')}.`}
        </p>
      )}
      {needsRepair && (
        <details>
          <summary>Advanced repair controls</summary>
          <p className="muted small">
            Automatic setup is paused so no step runs twice. {primaryLabel} clears a step whose
            process has ended and starts it again. Refresh status reads the setup again.
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
      {message && !working && <p role="status">{message}</p>}
    </section>
  );
}
