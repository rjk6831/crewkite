import type { DesktopCommand } from '@crewkite/client';
import type { CommandResult, LocalSetup } from '@crewkite/contracts';
import { formatSize } from './format-size.ts';
import { localResultLine } from './source.ts';

/** Why the saved setup is where it is. The card and the rail say the same sentence. */
export const setupReasons: Record<NonNullable<LocalSetup['reason']>, string> = {
  unconfigured: 'Configure a loopback endpoint first.',
  'connection-required': 'Press Connect. CrewKite checks whether the runtime wants a token.',
  'connection-unavailable':
    'Local connection failed. Check that the runtime is running, then press Connect.',
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

/**
 * How long a card follows a model read it started on its own. The controller gives discovery 20
 * seconds, so the follow outlasts it.
 */
export const DISCOVERY_FOLLOW_MS = 30_000;

export const WITHOUT_TOKEN = 'Connected without a token. The runtime has auth off on loopback.';

/** The line while a Connect waits for the connection and the first model read. */
export const WAITING_LINE = 'Waiting for the connection and model metadata.';

const ready = (
  setup:
    | Pick<LocalSetup, 'connected' | 'observation' | 'observationStale' | 'operation'>
    | null
    | undefined,
) => !!setup?.connected && !!setup.observation && !setup.observationStale && !setup.operation;

/**
 * The notices under the status line, kept to what is true now. The line from the last action
 * goes when its condition ends: the waiting line once the connection is read or the follow
 * stops. The last-seen age shows while the list is not being read again, and the no-token line
 * once a Connect has finished.
 */
export function localNotices({
  setup,
  message,
  following,
  connected,
  stamp,
}: {
  setup:
    | Pick<
        LocalSetup,
        'connected' | 'observation' | 'observationStale' | 'operation' | 'connectedWithoutToken'
      >
    | null
    | undefined;
  message: string | null;
  /** A Connect is following the connection to its first read. */
  following: boolean;
  /** The connection the card counts as up. */
  connected: boolean;
  stamp: string | null;
}): { message: string | null; stamp: string | null; withoutToken: boolean } {
  const done = ready(setup);
  const settling = (following && !done) || !!setup?.operation;
  return {
    message: message === WAITING_LINE && (!following || done) ? null : message,
    stamp: stamp && !(connected && settling) ? stamp : null,
    withoutToken: connected && setup?.connectedWithoutToken === true && !settling,
  };
}

/** The port the Local runtime listens on unless the person changed it. */
export const DEFAULT_LOCAL_ENDPOINT = 'ws://127.0.0.1:1234';

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
  return `Low memory: ${formatSize(available)} available with ${loaded} ${loaded === 1 ? 'model' : 'models'} loaded. Replies may slow.`;
}

/**
 * The one status line under the card heading. A lost selection comes first, then the message from
 * the last action, then a confirmed selection, then the reason the saved setup is where it is. A
 * read the card started on its own changes nothing the person asked for, so while one runs the
 * reason line stays as it was before the read began (`held`).
 */
export function statusLine({
  setup,
  message,
  lost,
  confirmed,
  quiet,
  held,
}: {
  setup: Pick<LocalSetup, 'reason' | 'notice'> | null | undefined;
  message: string | null;
  lost: string | null;
  confirmed: boolean;
  quiet: boolean;
  held: string | null;
}): string {
  if (lost) return lost;
  if (message) return message;
  if (confirmed) return 'Model selection confirmed';
  if (!setup) return 'Local setup is unavailable. Reconnect to recover current status.';
  if (setup.notice) return setup.notice;
  if (!setup.reason) return 'Inspect the saved connection and model state.';
  if (quiet && setup.reason === 'discovery-active' && held) return held;
  return setupReasons[setup.reason];
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
        message: localResultLine(started, 'Local did not connect.'),
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
        message: now.notice ?? (now.reason ? setupReasons[now.reason] : 'Local did not connect.'),
      };
    if (now.operation) continue;
    if (!now.connected)
      return {
        kind: 'blocked',
        message: now.notice ?? (now.reason ? setupReasons[now.reason] : 'Local did not connect.'),
      };
    if (now.observation && !now.observationStale && (discovered || !setup.connected))
      return {
        kind: 'connected',
        withoutToken: now.connectedWithoutToken ?? !now.secretConfigured,
      };
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
          message: localResultLine(read, 'The models were not read.'),
        };
    }
  }
  return {
    kind: 'blocked',
    message: 'Taking longer than expected. Open Settings and try Refresh model list.',
  };
}

export type LocalReadinessResult = 'ready' | 'stopped' | 'timeout';
type LocalConnectResult =
  | { kind: 'started' }
  | { kind: 'stopped' }
  | { kind: 'blocked'; result: CommandResult };

const applied = (result: CommandResult) =>
  result.outcome === 'applied' || result.outcome === 'already-applied';

/**
 * Connect always detects: the controller probes the runtime and asks for a token only on 401 or
 * 403. The saved mode is token wherever this computer can take one. A computer without the macOS
 * keychain refuses token mode, and Connect saves the no-token loopback mode there (ADR 0043,
 * amendment of 2026-11-01).
 */
export async function connectLocalFlow({
  setup,
  endpoint,
  command: send,
  active,
  wait,
  tries = 30,
}: {
  setup: LocalSetup;
  endpoint: string;
  command: (input: DesktopCommand) => Promise<CommandResult>;
  active: () => boolean;
  /**
   * Pause before a command the controller refused because a model read runs. Without it the
   * refusal ends the connect.
   */
  wait?: () => Promise<void>;
  tries?: number;
}): Promise<LocalConnectResult> {
  let revision = setup.revision;
  // A model read started elsewhere holds the runtime until it ends. Connect waits for it and
  // then goes on, on the revision the read left.
  const command = async (
    input: Extract<DesktopCommand, { command: 'ConfigureLocal' | 'BeginLocalConnectionInput' }>,
  ) => {
    let result = await send(input);
    for (let attempt = 1; wait && attempt < tries; attempt++) {
      if (result.reason !== 'local-operation-active' || !active()) break;
      await wait();
      if (!active()) break;
      result = await send({ ...input, expectedRevision: result.revision ?? revision });
      if (result.outcome === 'stale-revision' && result.revision !== undefined) {
        revision = result.revision;
        result = await send({ ...input, expectedRevision: revision });
      }
    }
    return result;
  };
  const saved = setup.authMode ?? 'token';
  const configure = async (authMode: 'token' | 'none') => {
    const result = await command({
      command: 'ConfigureLocal',
      expectedRevision: revision,
      payload: { endpoint, authMode },
    });
    if (applied(result)) revision = result.revision ?? revision;
    return result;
  };
  if (endpoint !== setup.endpoint || (saved === 'none' && !tokenModeRefused)) {
    let configured: CommandResult | null = await configure(tokenModeRefused ? 'none' : 'token');
    if (!active()) return { kind: 'stopped' };
    if (configured.reason === 'local-token-needs-macos') {
      tokenModeRefused = true;
      // On the saved endpoint, the saved no-token mode is already what this computer takes.
      configured = endpoint === setup.endpoint ? null : await configure('none');
      if (!active()) return { kind: 'stopped' };
    }
    if (configured && !applied(configured)) return { kind: 'blocked', result: configured };
  }
  const started = await command({
    command: 'BeginLocalConnectionInput',
    expectedRevision: revision,
    payload: { consent: 'explicit' },
  });
  if (!active()) return { kind: 'stopped' };
  return applied(started) ? { kind: 'started' } : { kind: 'blocked', result: started };
}

// Set once this computer refuses token mode, so a later Connect does not ask again.
let tokenModeRefused = false;

/**
 * Follows one Connect until the models are read. A connect that ends with the endpoint saved, no
 * failure and still no connection is sent once more: on a first Connect the card stopped there and
 * the person had to press Connect a second time. `reconnect` sends it and is false when refused.
 */
export async function waitForLocalReadiness({
  endpoint,
  read,
  discover,
  reconnect,
  wait,
  active,
  attempts = 20,
}: {
  endpoint: string;
  read: () => Promise<LocalSetup | null | undefined>;
  discover: (setup: LocalSetup) => Promise<boolean>;
  reconnect?: (setup: LocalSetup) => Promise<boolean>;
  wait: () => Promise<void>;
  active: () => boolean;
  attempts?: number;
}): Promise<LocalReadinessResult> {
  let discoveryRequested = false;
  let reconnected = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait();
    if (!active()) return 'stopped';
    const setup = await read();
    if (!active() || !setup || setup.endpoint !== endpoint) return 'stopped';
    if (setup.observation && !setup.observationStale && !setup.operation) return 'ready';
    if (setup.operation) continue;
    if (
      !setup.connected &&
      reconnect &&
      !reconnected &&
      setup.reason === 'connection-required' &&
      !setup.notice
    ) {
      reconnected = true;
      if (!(await reconnect(setup))) return 'stopped';
      continue;
    }
    if (!setup.connected) return 'stopped';
    if (!discoveryRequested) {
      discoveryRequested = true;
      if (!(await discover(setup))) return 'stopped';
    }
  }
  return 'timeout';
}

/**
 * Follows a model read the card started on its own until the controller ends it, so the card can
 * keep its controls as they were for the whole read. A runtime busy loading a model can use the
 * whole of the controller's discovery deadline. A follow that stopped after about 10 seconds left
 * a longer read on screen as an owned operation: the controls greyed, the status line changed and
 * the operation row appeared until the read ended. True when the read ended within the follow.
 */
export async function followDiscovery({
  read,
  wait,
  active,
  now = Date.now,
  followMs = DISCOVERY_FOLLOW_MS,
}: {
  read: () => Promise<Pick<LocalSetup, 'operation'> | null | undefined>;
  wait: () => Promise<void>;
  active: () => boolean;
  now?: () => number;
  followMs?: number;
}): Promise<boolean> {
  const until = now() + followMs;
  while (active() && now() < until) {
    if (!(await read())?.operation) return true;
    await wait();
  }
  return false;
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
