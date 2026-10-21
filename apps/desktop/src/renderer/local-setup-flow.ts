import type { DesktopCommand } from '@crewkite/client';
import type { CommandResult, LocalSetup } from '@crewkite/contracts';

export type LocalReadinessResult = 'ready' | 'stopped' | 'timeout';
type LocalConnectResult =
  | { kind: 'started' }
  | { kind: 'stopped' }
  | { kind: 'blocked'; result: CommandResult };

const applied = (result: CommandResult) =>
  result.outcome === 'applied' || result.outcome === 'already-applied';

export async function connectLocalFlow({
  setup,
  endpoint,
  authMode,
  command,
  active,
}: {
  setup: LocalSetup;
  endpoint: string;
  authMode: 'token' | 'none';
  command: (input: DesktopCommand) => Promise<CommandResult>;
  active: () => boolean;
}): Promise<LocalConnectResult> {
  let revision = setup.revision;
  if (endpoint !== setup.endpoint) {
    const configured = await command({
      command: 'ConfigureLocal',
      expectedRevision: revision,
      payload: { endpoint, authMode },
    });
    if (!active()) return { kind: 'stopped' };
    if (!applied(configured)) return { kind: 'blocked', result: configured };
    revision = configured.revision ?? revision;
  }
  const started = await command({
    command: 'BeginLocalConnectionInput',
    expectedRevision: revision,
    payload: { consent: 'explicit' },
  });
  if (!active()) return { kind: 'stopped' };
  return applied(started) ? { kind: 'started' } : { kind: 'blocked', result: started };
}

export async function waitForLocalReadiness({
  endpoint,
  read,
  discover,
  wait,
  active,
  attempts = 20,
}: {
  endpoint: string;
  read: () => Promise<LocalSetup | null | undefined>;
  discover: (setup: LocalSetup) => Promise<boolean>;
  wait: () => Promise<void>;
  active: () => boolean;
  attempts?: number;
}): Promise<LocalReadinessResult> {
  let discoveryRequested = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait();
    if (!active()) return 'stopped';
    const setup = await read();
    if (!active() || !setup || setup.endpoint !== endpoint) return 'stopped';
    if (setup.observation && !setup.operation) return 'ready';
    if (setup.operation) continue;
    if (!setup.connected) return 'stopped';
    if (!discoveryRequested) {
      discoveryRequested = true;
      if (!(await discover(setup))) return 'stopped';
    }
  }
  return 'timeout';
}
