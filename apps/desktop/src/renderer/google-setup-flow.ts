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
  // A blocked setup retries the step its saved proof reached, one attempt per click.
  if (setup.state === 'blocked') {
    if (!setup.proofId) return 'initialize';
    return setup.auth.status === 'authenticated' ? 'discover' : 'authenticate';
  }
  return null;
}

export async function runGoogleSetupFlow({
  read,
  command,
  active,
  onStage,
}: {
  read: () => Promise<GoogleState>;
  command: (input: GoogleCommand) => Promise<CommandResult>;
  active: () => boolean;
  onStage: (stage: GoogleSetupStage) => void;
}): Promise<GoogleSetupFlowResult> {
  const attempted = new Set<GoogleSetupStage>();
  let acknowledged = false;
  for (;;) {
    const state = await read();
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
    if (!stage || attempted.has(stage)) return { kind: 'blocked' };
    attempted.add(stage);
    onStage(stage);
    const setup = state.googleAcpSetup;
    let input: GoogleCommand;
    if (stage === 'clear') {
      if (!setup?.operationId) return { kind: 'blocked' };
      input = {
        command: 'StopGoogleAcpSetup',
        expectedRevision: setup.revision,
        payload: { profileId: 'google-acp-v1', operationId: setup.operationId },
      };
    } else if (stage === 'install') {
      input = {
        command: 'InstallGoogleAcp',
        expectedRevision: 0,
        payload: { profileId: 'google-acp-v1', consent: 'explicit' },
      };
    } else if (stage === 'initialize') {
      input = {
        command: 'InitializeGoogleAcp',
        expectedRevision: setup?.revision ?? 0,
        payload: { profileId: 'google-acp-v1', consent: 'explicit' },
      };
    } else if (stage === 'authenticate') {
      if (!setup?.proofId) return { kind: 'blocked' };
      input = {
        command: 'AuthenticateGoogleAcp',
        expectedRevision: setup.revision,
        payload: {
          profileId: 'google-acp-v1',
          proofId: setup.proofId,
          method: 'oauth-personal',
          consent: 'explicit',
        },
      };
    } else {
      if (!setup?.proofId) return { kind: 'blocked' };
      input = {
        command: 'DiscoverGoogleAcp',
        expectedRevision: setup.revision,
        payload: {
          profileId: 'google-acp-v1',
          proofId: setup.proofId,
          consent: 'explicit',
        },
      };
    }
    const result = await command(input);
    if (!active()) return { kind: 'stopped' };
    if (!applied(result)) return { kind: 'blocked', result };
  }
}

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
}): Promise<'stopped' | 'timeout'> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait();
    if (!active()) return 'stopped';
    await read();
    if (!active()) return 'stopped';
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
          ? `Downloading the official client: ${Math.floor(fraction * 100)} percent, ${amount}.`
          : `Unpacking the client: ${Math.floor(fraction * 100)} percent, ${amount}.`;
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
