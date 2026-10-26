import type { DesktopCommand } from '@crewkite/client';
import type { CommandResult, LocalSetup } from '@crewkite/contracts';

/** Why the saved setup is where it is. The card and the rail say the same sentence. */
export const setupReasons: Record<NonNullable<LocalSetup['reason']>, string> = {
  unconfigured: 'Configure a loopback endpoint first.',
  'connection-required': 'Connect through the native input window.',
  'connection-unavailable':
    'Local connection failed. Confirm the server authentication setting matches this connection.',
  'input-active': 'The native connection input window is open.',
  'input-unknown': 'Connection input ownership is unknown. Reconnect before continuing.',
  'discovery-required': 'Read the connected runtime to find its loaded model.',
  'discovery-active': 'The controller is reading model metadata.',
  'discovery-unknown': 'Model discovery ownership is unknown. Reconnect before continuing.',
  'model-selection-required': 'Choose an observed model.',
  'model-unloaded':
    'The selected model is installed and unloaded. Load it in the Local app, then refresh.',
  'model-incompatible':
    'The selected model does not meet this profile. Inspect its observed reasons.',
  'selection-stale': 'The selected model changed. Refresh and choose from the current observation.',
  'generation-active':
    'A Local generation is active. Stop its task before changing this connection.',
  'generation-unknown': 'Local generation ownership is unknown. Connection changes remain blocked.',
  'capability-unavailable': 'The native Local connection input is unavailable.',
  'setup-unavailable': 'The Local setup is unavailable. Reconnect to recover current status.',
  'qualification-pending': 'Connected. The loaded model is eligible for chat.',
};

/** How often an open Settings page or model picker reads the runtime again. */
export const REOBSERVE_MS = 15_000;

export const WITHOUT_TOKEN = 'Connected without a token. The runtime has auth off on loopback.';

/**
 * The label on a cached observation. Null when nothing says when it was read. `connected` is a new
 * connection whose first read has not landed, so only the age shows.
 */
export function lastSeen(
  observedAt: string | null | undefined,
  now: number,
  connected = false,
): string | null {
  if (!observedAt) return null;
  const minutes = Math.max(0, Math.floor((now - Date.parse(observedAt)) / 60_000));
  const age =
    minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes} min ago`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)} h ago`
          : `${Math.floor(minutes / 1440)} d ago`;
  return connected ? `Last seen ${age}.` : `Last seen ${age}. Not connected.`;
}

const GIB = 1024 ** 3;
const gigabytes = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

/**
 * The warning when memory runs short with models resident: under 4 GiB available, or under a tenth
 * of the unified memory. Null when the read has no figure to compare.
 */
export function lowMemory(
  setup: Pick<LocalSetup, 'availableMemoryBytes' | 'observation'> | null | undefined,
  hardware:
    | { totalMemoryBytes: number | null; availableMemoryBytes: number | null }
    | null
    | undefined,
): string | null {
  const available = setup?.availableMemoryBytes ?? hardware?.availableMemoryBytes ?? null;
  const total = hardware?.totalMemoryBytes ?? null;
  const loaded = setup?.observation?.residentLlms ?? 0;
  if (available === null || loaded === 0) return null;
  if (available >= 4 * GIB && (total === null || available >= total / 10)) return null;
  return `Low memory: ${gigabytes(available)} available with ${loaded} ${loaded === 1 ? 'model' : 'models'} loaded. Replies may slow.`;
}

/**
 * What to say after a fresh read when the model that was selected is gone. `previous` is the name
 * the card showed for the selection. The controller keeps a selection whose model key is still
 * loaded, so a cleared one means no loaded instance matches.
 */
export function selectionLost(
  previous: string | null,
  setup:
    | Pick<LocalSetup, 'connected' | 'selection' | 'operation' | 'observation' | 'observationStale'>
    | null
    | undefined,
): string | null {
  return previous &&
    setup?.connected &&
    !setup.operation &&
    setup.observation &&
    !setup.observationStale &&
    !setup.selection
    ? `${previous} is no longer loaded. Pick a model.`
    : null;
}

/**
 * Whether a selection is confirmed: a read made after the request, on a live connection, that still
 * holds the selected instance as loaded. The command's own answer does not count.
 */
export function selectionConfirmed(setup: LocalSetup | null | undefined, since: number): boolean {
  const chosen = setup?.selection;
  return (
    !!setup?.connected &&
    !!chosen &&
    !!setup.observedAt &&
    Date.parse(setup.observedAt) >= since &&
    !!setup.observation?.models.some(
      (model) => model.selectionId === chosen.selectionId && model.state === 'loaded-eligible',
    )
  );
}

export type RailConnectResult =
  /** Open Settings on the Local card. `token` means the token window is already up. */
  | { kind: 'settings'; why: 'unconfigured' | 'token' }
  | { kind: 'connected'; withoutToken: boolean }
  | { kind: 'blocked'; message: string }
  | { kind: 'stopped' };

/**
 * The rail's Connect for Local. It connects with the saved endpoint and auth mode and reads the
 * models, and it asks for Settings only when the runtime wants a token this window does not hold:
 * the connection then shows an input operation, which is the token window.
 */
export async function connectInPlace({
  setup,
  command,
  read,
  wait,
  active,
  attempts = 20,
}: {
  setup: LocalSetup;
  command: (input: DesktopCommand) => Promise<CommandResult>;
  read: () => Promise<LocalSetup | null | undefined>;
  wait: () => Promise<void>;
  active: () => boolean;
  attempts?: number;
}): Promise<RailConnectResult> {
  if (!setup.endpoint) return { kind: 'settings', why: 'unconfigured' };
  if (!setup.connected) {
    const started = await command({
      command: 'BeginLocalConnectionInput',
      expectedRevision: setup.revision,
      payload: { consent: 'explicit' },
    });
    if (!active()) return { kind: 'stopped' };
    if (!applied(started))
      return {
        kind: 'blocked',
        message: started.next ?? started.reason ?? 'Local did not connect.',
      };
  }
  let discovered = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 || !setup.connected) await wait();
    if (!active()) return { kind: 'stopped' };
    const now = await read();
    if (!active() || !now) return { kind: 'stopped' };
    // The controller probes loopback before it opens the token window, so an input operation is
    // the window only once it is owned. The probe can still end it and connect with no token.
    if (now.operation?.kind === 'input' && now.operation.state === 'owned')
      return { kind: 'settings', why: 'token' };
    if (now.operation?.state === 'unknown')
      return {
        kind: 'blocked',
        message: now.reason ? setupReasons[now.reason] : 'Local did not connect.',
      };
    if (now.operation) continue;
    if (!now.connected)
      return {
        kind: 'blocked',
        message: now.reason ? setupReasons[now.reason] : 'Local did not connect.',
      };
    if (now.observation && !now.observationStale && (discovered || !setup.connected))
      return { kind: 'connected', withoutToken: !now.secretConfigured };
    if (!discovered) {
      discovered = true;
      const read = await command({
        command: 'RefreshLocalModels',
        expectedRevision: now.revision,
        payload: { consent: 'explicit' },
      });
      if (!active()) return { kind: 'stopped' };
      if (!applied(read))
        return {
          kind: 'blocked',
          message: read.next ?? read.reason ?? 'The models were not read.',
        };
    }
  }
  return {
    kind: 'blocked',
    message: 'Taking longer than expected. Open Settings and try Refresh.',
  };
}

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
    if (setup.observation && !setup.observationStale && !setup.operation) return 'ready';
    if (setup.operation) continue;
    if (!setup.connected) return 'stopped';
    if (!discoveryRequested) {
      discoveryRequested = true;
      if (!(await discover(setup))) return 'stopped';
    }
  }
  return 'timeout';
}

/**
 * One read of the runtime on an open connection, with no token. Returns false when there was
 * nothing to read: not connected, an operation or a generation in flight.
 */
export async function observeOpenConnection(
  read: () => Promise<LocalSetup | null | undefined>,
  command: (input: DesktopCommand) => Promise<CommandResult>,
): Promise<boolean> {
  const setup = await read();
  if (!setup?.connected || setup.operation || setup.generation !== 'idle') return false;
  return applied(
    await command({
      command: 'RefreshLocalModels',
      expectedRevision: setup.revision,
      payload: { consent: 'explicit' },
    }),
  );
}
