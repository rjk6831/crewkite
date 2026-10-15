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

export function deriveWindow(
  observation: Observation,
  clock: { nowMs: number; maxAgeMs: number },
): Window {
  const parsed = ObservationSchema.parse(observation);
  nonnegative(clock.nowMs, 'Time');
  nonnegative(clock.maxAgeMs, 'Maximum age');
  const observedAt = Date.parse(parsed.observedAt);
  let state: Window['state'];
  if (observedAt > clock.nowMs) state = 'unknown';
  else if (parsed.resetsAt !== null && Date.parse(parsed.resetsAt) <= clock.nowMs)
    state = 'reset-pending';
  else if (parsed.remaining === null) state = 'unknown';
  else state = clock.nowMs - observedAt > clock.maxAgeMs ? 'stale' : 'fresh';
  return { observation: parsed, state };
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
