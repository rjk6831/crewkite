import { performance } from 'node:perf_hooks';
import { logEvent } from './timing.ts';

export type ConnectFamily = 'openai' | 'anthropic' | 'google' | 'local';
export type ConnectMode = 'auto' | 'manual';

// A reason is a code the controller chose, such as client-unavailable. Anything else is logged as
// unknown, so a provider's own words or a path never reach the log.
const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function connectLine(
  family: ConnectFamily,
  mode: ConnectMode,
  result: { ms: number } | { reason: string | null | undefined },
): string {
  if ('ms' in result)
    return `connect ${family} ${mode} ok ms=${Math.max(0, Math.round(result.ms))}`;
  const reason = result.reason && CODE.test(result.reason) ? result.reason : 'unknown';
  return `connect ${family} ${mode} failed reason=${reason}`;
}

/**
 * One line per provider connect: when it reaches connected or fails. A launch reconnects each
 * provider connected once on this device on its own (auto); the card's Connect is manual. Local's
 * launch reconnect tries again every few seconds while the runtime is down, so its first failure
 * is logged once and the attempt stays open until it connects.
 */
export class ConnectLog {
  private readonly pending = new Map<
    ConnectFamily,
    { mode: ConnectMode; started: number; failed: boolean }
  >();
  private readonly now: () => number;
  private readonly write: (line: string) => void;
  constructor(
    now: () => number = () => performance.now(),
    write: (line: string) => void = logEvent,
  ) {
    this.now = now;
    this.write = write;
  }

  /** A connect starts. One already open in the same mode keeps its start time. */
  begin(family: ConnectFamily, mode: ConnectMode) {
    if (this.pending.get(family)?.mode === mode) return;
    this.pending.set(family, { mode, started: this.now(), failed: false });
  }

  mode(family: ConnectFamily): ConnectMode | undefined {
    return this.pending.get(family)?.mode;
  }

  ok(family: ConnectFamily) {
    const open = this.pending.get(family);
    if (!open) return;
    this.pending.delete(family);
    this.write(connectLine(family, open.mode, { ms: this.now() - open.started }));
  }

  /** `keep` leaves the attempt open for a later success, as Local's launch retries need. */
  failed(family: ConnectFamily, reason: string | null | undefined, keep = false) {
    const open = this.pending.get(family);
    if (!open) return;
    if (!open.failed) this.write(connectLine(family, open.mode, { reason }));
    if (keep) open.failed = true;
    else this.pending.delete(family);
  }

  /** The attempt ended with no outcome to report, such as a Disconnect. */
  drop(family: ConnectFamily) {
    this.pending.delete(family);
  }
}
