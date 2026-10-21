import type { DesktopCommand } from '@crewkite/client';
import type { CommandResult, WorkspaceState } from '@crewkite/contracts';

type GoogleState = Pick<WorkspaceState, 'googleAcpInstall' | 'googleAcpSetup'>;
type GoogleCommand = Extract<
  DesktopCommand,
  {
    command:
      | 'InstallGoogleAcp'
      | 'InitializeGoogleAcp'
      | 'AuthenticateGoogleAcp'
      | 'DiscoverGoogleAcp';
  }
>;
export type GoogleSetupStage = 'install' | 'initialize' | 'authenticate' | 'discover';
export type GoogleSetupFlowResult =
  | { kind: 'ready' }
  | { kind: 'stopped' }
  | { kind: 'blocked'; result?: CommandResult };

const applied = (result: CommandResult) =>
  result.outcome === 'applied' || result.outcome === 'already-applied';

function nextGoogleStage(state: GoogleState): GoogleSetupStage | 'ready' | null {
  const setup = state.googleAcpSetup;
  const installation = state.googleAcpInstall;
  if (
    installation?.state === 'unknown' ||
    installation?.state === 'blocked' ||
    setup?.state === 'unknown' ||
    setup?.state === 'blocked'
  ) {
    return null;
  }
  if (installation?.operationId || setup?.operationId) return null;
  if (
    !setup?.client &&
    installation &&
    installation.state !== 'idle' &&
    installation.state !== 'installed'
  ) {
    return null;
  }
  const installed = installation?.state === 'installed' || !!setup?.client;
  if (!installed) return 'install';
  if (setup?.state === 'ready') return 'ready';
  if (!setup || setup.state === 'uninitialized') return 'initialize';
  if (setup.state === 'authentication-required') {
    return setup.proofId ? 'authenticate' : null;
  }
  if (setup.state === 'discovery-required') {
    return setup.proofId && setup.auth.status === 'authenticated' ? 'discover' : null;
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
  for (;;) {
    const state = await read();
    if (!active()) return { kind: 'stopped' };
    const stage = nextGoogleStage(state);
    if (stage === 'ready') return { kind: 'ready' };
    if (!stage || attempted.has(stage)) return { kind: 'blocked' };
    attempted.add(stage);
    onStage(stage);
    const setup = state.googleAcpSetup;
    let input: GoogleCommand;
    if (stage === 'install') {
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
