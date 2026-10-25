import { type Observation, ObservationSchema, type Window } from '@crewkite/contracts';

export type Allowance = NonNullable<Observation['remaining']>;
export interface Reservation extends Allowance {
  routeId: string;
  windowId: string;
}

export function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new TypeError(`${name} must be finite and nonnegative.`);
  return value;
}

/**
 * The state of one window from its fields: a future observation or a missing remaining says
 * nothing, a passed reset says nothing about now, and past the maximum age it is stale.
 */
export function windowState(
  observation: Pick<Observation, 'observedAt' | 'resetsAt' | 'remaining'>,
  clock: { nowMs: number; maxAgeMs: number },
): Window['state'] {
  const observedAt = Date.parse(observation.observedAt);
  if (!(observedAt <= clock.nowMs)) return 'unknown';
  if (observation.resetsAt !== null && Date.parse(observation.resetsAt) <= clock.nowMs)
    return 'reset-pending';
  if (observation.remaining === null) return 'unknown';
  return clock.nowMs - observedAt > clock.maxAgeMs ? 'stale' : 'fresh';
}

export function deriveWindow(
  observation: Observation,
  clock: { nowMs: number; maxAgeMs: number },
): Window {
  const parsed = ObservationSchema.parse(observation);
  nonnegative(clock.nowMs, 'Time');
  nonnegative(clock.maxAgeMs, 'Maximum age');
  return { observation: parsed, state: windowState(parsed, clock) };
}

export function availableAllowance(input: {
  remaining: Allowance;
  reserve?: Allowance;
  reservations?: readonly Allowance[];
  requested?: Allowance;
}): number {
  const { remaining } = input;
  if (!['percent', 'tokens', 'requests', 'credits', 'minutes'].includes(remaining.unit)) {
    throw new TypeError('Unknown allowance unit.');
  }
  nonnegative(remaining.value, 'Remaining allowance');
  if (remaining.unit === 'percent' && remaining.value > 100) {
    throw new TypeError('A percentage cannot exceed 100.');
  }
  let available = remaining.value;
  for (const amount of [input.reserve, ...(input.reservations ?? []), input.requested]) {
    if (amount === undefined) continue;
    if (amount.unit !== remaining.unit) throw new TypeError('Allowance units must match.');
    available -= nonnegative(amount.value, 'Reserved allowance');
  }
  return available;
}
