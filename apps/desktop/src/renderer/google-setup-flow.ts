import type { DesktopCommand } from '@crewkite/client';
import {
  type CommandResult,
  GOOGLE_TERMS_VERSION,
  googleTermsCurrent,
  type WorkspaceState,
} from '@crewkite/contracts';
import { formatSize } from './format-size.ts';

type GoogleState = Pick<WorkspaceState, 'googleAcpInstall' | 'googleAcpSetup'>;
type GoogleCommand = Extract<
  DesktopCommand,
  {
    command:
      | 'AcknowledgeGoogleTerms'
      | 'InstallGoogleAcp'
      | 'InitializeGoogleAcp'
      | 'AuthenticateGoogleAcp'
      | 'DiscoverGoogleAcp'
      | 'StopGoogleAcpSetup';
  }
>;
export type GoogleSetupStage = 'clear' | 'install' | 'initialize' | 'authenticate' | 'discover';
export type GoogleSetupFlowResult =
  | { kind: 'ready' }
  | { kind: 'stopped' }
  | { kind: 'blocked'; result?: CommandResult };

const applied = (result: CommandResult) =>
  result.outcome === 'applied' || result.outcome === 'already-applied';

/** Tries per step: the first and up to two more when the step ends by a transient failure. */
export const GOOGLE_STEP_TRIES = 3;
/**
 * Status reads in a row that may fail before Connect pauses. A read can fail once while the
 * browser sign-in ends and the controller saves it, and the next read a second later succeeds.
 */
export const GOOGLE_READ_TRIES = 3;
/** One Connect runs for at most this long, whatever it waits on. */
export const GOOGLE_CONNECT_LIMIT_MS = 20 * 60_000;

/**
 * Reasons another try of the same step can clear with nothing done by the person: a stall or a
 * timeout, a download that broke, a signature or unpack check that did not finish (each try runs
 * every check again from the start), a client that ended the step early, and an initialize or
 * discovery that reported no capabilities yet.
 */
const TRANSIENT_REASONS = new Set([
  // Install
  'stalled',
  'download-unavailable',
  'archive-refused',
  'invalid-import',
  'install-unavailable',
  'signature-timeout',
  'signature-refused',
  'google-install-interrupted',
  'google-install-busy',
  // Setup steps
  'acp-setup-timeout',
  'acp-setup-failed',
  'acp-setup-interrupted',
  'acp-capability-missing',
  'acp-proof-unavailable',
  'acp-setup-not-current',
  // The command got no answer. The step itself may have ended either way, and the state says how.
  'response-timeout',
  'connection-lost',
]);
/**
 * Reasons that wait for the person and are never retried: their own Stop, a terms
 * acknowledgement the controller refused, a sign-in cancelled or refused in the browser, a
 * different client in this home, a Mac the client does not run on, and a step whose process may
 * still run. Every reason not listed as transient waits for the person too.
 */
const PERSON_REASONS = new Set([
  'acp-setup-stopped',
  'cancelled',
  'authentication-required',
  'consent-required',
  'google-terms-not-acknowledged',
  'pin-conflict',
  'unsupported-platform',
  'google-ownership-unknown',
  'google-install-ownership-unknown',
]);
// Another Google step holds the journal, such as a coding turn. The step is sent again a second
// later, and that costs none of its tries.
const BUSY_REASONS = new Set(['google-operation-active', 'google-install-active']);

export type GoogleFailure = 'transient' | 'person';

/**
 * Whether a step that ended without moving the setup on can run again by itself. The command
 * result names the failure when it has one. A step that applied, or got no answer, leaves the
 * reason in the state it saved.
 */
export function classifyGoogleFailure(
  stage: GoogleSetupStage,
  result: CommandResult | undefined,
  state: GoogleState,
): GoogleFailure {
  const saved = stage === 'install' ? state.googleAcpInstall?.reason : state.googleAcpSetup?.reason;
  const data = result?.data;
  const reported =
    data?.kind === 'google-acp-setup'
      ? data.setup.reason
      : data?.kind === 'google-acp-install'
        ? data.install.reason
        : null;
  // A sign-in the person cancelled or refused ends the step early too, and the setup then says the
  // sign-in is still required.
  if ([saved, reported].includes('authentication-required')) return 'person';
  const reason =
    result && !applied(result) && result.outcome !== 'outcome-unknown'
      ? result.reason
      : (saved ?? result?.reason);
  if (!reason || PERSON_REASONS.has(reason)) return 'person';
  return TRANSIENT_REASONS.has(reason) ? 'transient' : 'person';
}

const stepRunning = (state: GoogleState) =>
  (!!state.googleAcpInstall?.operationId && state.googleAcpInstall.state !== 'unknown') ||
  (!!state.googleAcpSetup?.operationId && state.googleAcpSetup.state !== 'unknown');

export function nextGoogleStage(state: GoogleState): GoogleSetupStage | 'ready' | null {
  const setup = state.googleAcpSetup;
  const installation = state.googleAcpInstall;
  if (installation?.state === 'unknown' || installation?.operationId) return null;
  // A step whose ownership was lost is cleared first. The controller clears it only when it can
  // prove the step's process ended, and the setup then starts that step again.
  if (setup?.state === 'unknown') return setup.operationId ? 'clear' : null;
  if (setup?.operationId) return null;
  const installed = installation?.state === 'installed' || !!setup?.client;
  if (!installed)
    return !installation || ['idle', 'blocked'].includes(installation.state) ? 'install' : null;
  if (setup?.state === 'ready') return 'ready';
  if (!setup || setup.state === 'uninitialized') return 'initialize';
  if (setup.state === 'authentication-required') {
    return setup.proofId ? 'authenticate' : null;
  }
  if (setup.state === 'discovery-required') {
    return setup.proofId && setup.auth.status === 'authenticated' ? 'discover' : null;
  }
  // A blocked setup resumes at the step its saved proof reached.
  if (setup.state === 'blocked') {
    if (!setup.proofId) return 'initialize';
    return setup.auth.status === 'authenticated' ? 'discover' : 'authenticate';
  }
  return null;
}

/**
 * One Connect: the terms, then install, initialize, sign-in and discovery in order until the
 * setup is ready. The step to take always comes from the saved state, so a Connect pressed again
 * resumes at the step that failed. Sign-in is an ordinary step; the client opens the browser.
 * A step that ends by a transient failure runs again from that step, up to three tries, with no
 * word to the person. A step whose command gets no answer is followed in the state, never sent
 * again blind. The whole Connect stops after 20 minutes.
 */
export async function runGoogleSetupFlow({
  read,
  command,
  active,
  onStage,
  onRetry,
  wait = () => new Promise((resolve) => setTimeout(resolve, 1_000)),
  now = Date.now,
}: {
  read: () => Promise<GoogleState>;
  command: (input: GoogleCommand) => Promise<CommandResult>;
  active: () => boolean;
  onStage: (stage: GoogleSetupStage) => void;
  /** A step failed by a transient failure and starts again: this is try `attempt` of `tries`. */
  onRetry?: (stage: GoogleSetupStage, attempt: number, tries: number) => void;
  wait?: () => Promise<void>;
  now?: () => number;
}): Promise<GoogleSetupFlowResult> {
  const deadline = now() + GOOGLE_CONNECT_LIMIT_MS;
  const tries = new Map<GoogleSetupStage, number>();
  // The last step sent and what its command answered. When the next read asks for the same step
  // again, that step ended without moving the setup on.
  let last = null as { stage: GoogleSetupStage; result: CommandResult } | null;
  let acknowledged = false;
  const limit = (): GoogleSetupFlowResult => ({
    kind: 'blocked',
    result: { outcome: 'blocked', reason: 'google-connect-limit' },
  });
  const pause = async () => {
    await wait();
    return active();
  };
  let failedReads = 0;
  for (;;) {
    if (now() >= deadline) return limit();
    let state: GoogleState;
    try {
      state = await read();
      failedReads = 0;
    } catch {
      if (!active()) return { kind: 'stopped' };
      // The steps already sent are saved in the controller, so the next good read resumes them.
      failedReads += 1;
      if (failedReads >= GOOGLE_READ_TRIES)
        return {
          kind: 'blocked',
          result: { outcome: 'blocked', reason: 'google-status-unreadable' },
        };
      if (!(await pause())) return { kind: 'stopped' };
      continue;
    }
    if (!active()) return { kind: 'stopped' };
    // The person ticked the box in this click. The controller stores it and refuses every
    // connection step until it holds the current text version.
    if (!acknowledged && !googleTermsCurrent(state.googleAcpSetup?.googleTerms)) {
      acknowledged = true;
      const result = await command({
        command: 'AcknowledgeGoogleTerms',
        expectedRevision: 0,
        payload: { textVersion: GOOGLE_TERMS_VERSION },
      });
      if (!active()) return { kind: 'stopped' };
      if (!applied(result)) return { kind: 'blocked', result };
      continue;
    }
    const stage = nextGoogleStage(state);
    if (stage === 'ready') return { kind: 'ready' };
    // A step runs in the controller: one this flow sent and is still waiting on, or one the
    // controller started on its own, such as the initialize after the install. Follow it.
    if (!stage) {
      if (stepRunning(state)) {
        if (!(await pause())) return { kind: 'stopped' };
        continue;
      }
      return { kind: 'blocked', ...(last ? { result: last.result } : {}) };
    }
    const attempt = (tries.get(stage) ?? 0) + 1;
    if (last?.stage === stage) {
      const failure = classifyGoogleFailure(stage, last.result, state);
      if (failure === 'person' || attempt > GOOGLE_STEP_TRIES) {
        const saved =
          stage === 'install' ? state.googleAcpInstall?.reason : state.googleAcpSetup?.reason;
        const result =
          applied(last.result) && saved
            ? { outcome: 'blocked' as const, reason: saved }
            : last.result;
        return { kind: 'blocked', result };
      }
      onRetry?.(stage, attempt, GOOGLE_STEP_TRIES);
    }
    tries.set(stage, attempt);
    onStage(stage);
    const input = googleStepCommand(stage, state);
    if (!input) return { kind: 'blocked' };
    const result = await command(input);
    if (!active()) return { kind: 'stopped' };
    if (BUSY_REASONS.has(result.reason ?? '')) {
      tries.set(stage, attempt - 1);
      last = null;
      if (!(await pause())) return { kind: 'stopped' };
      continue;
    }
    last = { stage, result };
  }
}

function googleStepCommand(stage: GoogleSetupStage, state: GoogleState): GoogleCommand | null {
  const setup = state.googleAcpSetup;
  if (stage === 'clear')
    return setup?.operationId
      ? {
          command: 'StopGoogleAcpSetup',
          expectedRevision: setup.revision,
          payload: { profileId: 'google-acp-v1', operationId: setup.operationId },
        }
      : null;
  if (stage === 'install')
    return {
      command: 'InstallGoogleAcp',
      expectedRevision: 0,
      payload: { profileId: 'google-acp-v1', consent: 'explicit' },
    };
  if (stage === 'initialize')
    return {
      command: 'InitializeGoogleAcp',
      expectedRevision: setup?.revision ?? 0,
      payload: { profileId: 'google-acp-v1', consent: 'explicit' },
    };
  if (!setup?.proofId) return null;
  return stage === 'authenticate'
    ? {
        command: 'AuthenticateGoogleAcp',
        expectedRevision: setup.revision,
        payload: {
          profileId: 'google-acp-v1',
          proofId: setup.proofId,
          method: 'oauth-personal',
          consent: 'explicit',
        },
      }
    : {
        command: 'DiscoverGoogleAcp',
        expectedRevision: setup.revision,
        payload: { profileId: 'google-acp-v1', proofId: setup.proofId, consent: 'explicit' },
      };
}

/**
 * Reads the status once a second. A failed read is tried again at the next tick, and the poll
 * ends as 'unreadable' only after GOOGLE_READ_TRIES failed reads in a row.
 */
export async function pollGoogleSetupStatus({
  wait,
  read,
  active,
  attempts = 20,
}: {
  wait: () => Promise<void>;
  read: () => Promise<unknown>;
  active: () => boolean;
  attempts?: number;
}): Promise<'stopped' | 'timeout' | 'unreadable'> {
  let failed = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait();
    if (!active()) return 'stopped';
    try {
      await read();
      failed = 0;
    } catch {
      failed += 1;
    }
    if (!active()) return 'stopped';
    if (failed >= GOOGLE_READ_TRIES) return 'unreadable';
  }
  return 'timeout';
}

export type GoogleProgressStep = 'download' | 'verify' | 'initialize' | 'authenticate' | 'discover';
export const GOOGLE_PROGRESS_STEPS: readonly { id: GoogleProgressStep; label: string }[] = [
  { id: 'download', label: 'Download the official client' },
  { id: 'verify', label: 'Unpack and verify it' },
  { id: 'initialize', label: 'Initialize' },
  { id: 'authenticate', label: 'Sign in with Google' },
  { id: 'discover', label: 'Discover models' },
];
// Shares of the whole bar. The download takes most of a first connect.
const weights: Record<GoogleProgressStep, number> = {
  download: 50,
  verify: 15,
  initialize: 10,
  authenticate: 15,
  discover: 10,
};
const setupSteps: Partial<Record<string, GoogleProgressStep>> = {
  initializing: 'initialize',
  authenticating: 'authenticate',
  discovering: 'discover',
};

export type GoogleSetupProgress = {
  step: GoogleProgressStep;
  /** The whole connect, 0 to 100. */
  percent: number;
  /** What the current step is doing, in a sentence. */
  detail: string;
};

/**
 * Where a running connect stands: the step the controller reports first, then the step this card
 * asked for. The install reports bytes while it downloads and unpacks; the later steps report
 * only that they run. Null when nothing runs.
 */
export function googleSetupProgress(
  state: GoogleState,
  requested: GoogleSetupStage | null,
): GoogleSetupProgress | null {
  const install = state.googleAcpInstall;
  const setup = state.googleAcpSetup;
  let step: GoogleProgressStep | undefined;
  let fraction = 0;
  let detail = '';
  if (install?.operationId && (install.state === 'installing' || install.state === 'stopping')) {
    const progress = install.progress;
    step = !progress || progress.step === 'download' ? 'download' : 'verify';
    if (progress && progress.step !== 'verify') {
      fraction = Math.min(1, progress.bytes / progress.totalBytes);
      const amount = `${formatSize(progress.bytes)} of ${formatSize(progress.totalBytes)}`;
      detail =
        progress.step === 'download'
          ? `Downloading the official client: ${Math.floor(fraction * 100)}%, ${amount}.`
          : `Unpacking the client: ${Math.floor(fraction * 100)}%, ${amount}.`;
    } else
      detail = progress
        ? 'Checking the Google signatures on the client.'
        : 'Starting the download of the official client.';
  } else if (setup?.operationId && setup.state !== 'unknown') {
    step = setupSteps[setup.state];
  }
  if (!step && requested && requested !== 'clear')
    step = requested === 'install' ? 'download' : requested;
  if (!step) return null;
  if (!detail)
    detail = {
      download: 'Starting the download of the official client.',
      verify: 'Checking the Google signatures on the client.',
      initialize: 'Starting the client and reading what it offers. No prompt is sent.',
      authenticate: 'Finish the Google sign-in in your browser.',
      discover: 'Reading the models and modes your account offers. No prompt is sent.',
    }[step];
  let before = 0;
  for (const { id } of GOOGLE_PROGRESS_STEPS) {
    if (id === step) break;
    before += weights[id];
  }
  return { step, percent: Math.round(before + weights[step] * fraction), detail };
}
