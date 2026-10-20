import {
  type Observation,
  ObservationSchema,
  type Policy,
  ReserveSchema,
  type Role,
  RoleSchema,
  type Route,
  type RouterDecision,
  RouterDecisionSchema,
  RouteSchema,
  UnknownUsagePolicySchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { availableAllowance, deriveWindow, nonnegative, type Reservation } from '../usage/index.ts';

export interface RouteCandidate {
  route: Route;
  windowIds: readonly string[];
  availableSlots: number;
  blockedReason?: string;
}

export interface FixedUsage {
  routeId: string;
  launches: number;
  minutes: number;
  reservedLaunches?: number;
  reservedMinutes?: number;
  requestedMinutes?: number;
}

export interface RoutingInput {
  nowMs: number;
  maxAgeMs: number;
  candidates: readonly RouteCandidate[];
  observations: readonly Observation[];
  reserves: Policy['reserves'];
  reservations: readonly Reservation[];
  requestedReservations?: readonly Reservation[];
  role: Role;
  baseOrder: readonly string[];
  unknownUsage: Policy['unknownUsage'];
  fixedUsage: readonly FixedUsage[];
  previous?: { routeId: string; sinceMs: number };
  minimumTenureMs?: number;
  resetPreferenceHysteresisMs?: number;
}

interface Eligible {
  id: string;
  rule: RouterDecision['rule'];
  reset: number | null;
}

export function chooseRoute(input: RoutingInput): RouterDecision {
  nonnegative(input.nowMs, 'Time');
  nonnegative(input.maxAgeMs, 'Maximum age');
  const minimumTenureMs = nonnegative(input.minimumTenureMs ?? 0, 'Minimum tenure');
  const hysteresisMs = nonnegative(input.resetPreferenceHysteresisMs ?? 0, 'Reset hysteresis');
  const role = RoleSchema.parse(input.role);
  const unknownUsage = UnknownUsagePolicySchema.parse(input.unknownUsage);
  const observations = input.observations.map((observation) =>
    ObservationSchema.parse(observation),
  );
  const reserves = input.reserves.map((reserve) => ReserveSchema.parse(reserve));
  const reservations = [...input.reservations];
  const requestedReservations = [...(input.requestedReservations ?? [])];
  for (const amount of [...reservations, ...requestedReservations]) ReserveSchema.parse(amount);
  const fixedUsage = input.fixedUsage.map((usage) => ({
    routeId: usage.routeId,
    launches: nonnegative(usage.launches, 'Launch count'),
    minutes: nonnegative(usage.minutes, 'Active minutes'),
    reservedLaunches: nonnegative(usage.reservedLaunches ?? 0, 'Reserved launches'),
    reservedMinutes: nonnegative(usage.reservedMinutes ?? 0, 'Reserved minutes'),
    requestedMinutes: nonnegative(usage.requestedMinutes ?? 0, 'Requested minutes'),
  }));
  for (const usage of fixedUsage) {
    if (!Number.isSafeInteger(usage.launches) || !Number.isSafeInteger(usage.reservedLaunches)) {
      throw new TypeError('Launch counters must be safe integers.');
    }
  }
  if (new Set(fixedUsage.map(({ routeId }) => routeId)).size !== fixedUsage.length) {
    throw new TypeError('Fixed usage counters must be unique per route.');
  }
  if (input.previous !== undefined) {
    nonnegative(input.previous.sinceMs, 'Selection time');
    if (input.previous.sinceMs > input.nowMs)
      throw new TypeError('Selection time is in the future.');
  }
  const candidates = input.candidates.map((candidate) => {
    nonnegative(candidate.availableSlots, 'Available slots');
    if (!Number.isSafeInteger(candidate.availableSlots))
      throw new TypeError('Slots must be integers.');
    if (new Set(candidate.windowIds).size !== candidate.windowIds.length) {
      throw new TypeError('Expected window IDs must be unique.');
    }
    return {
      route: RouteSchema.parse(candidate.route),
      windowIds: [...candidate.windowIds],
      availableSlots: candidate.availableSlots,
      blockedReason: candidate.blockedReason ?? null,
    };
  });
  if (new Set(candidates.map(({ route }) => route.id)).size !== candidates.length) {
    throw new TypeError('Candidate route IDs must be unique.');
  }
  const inputsHash = hashCanonical({
    nowMs: input.nowMs,
    maxAgeMs: input.maxAgeMs,
    candidates,
    observations,
    reserves,
    reservations,
    requestedReservations,
    role,
    baseOrder: input.baseOrder,
    unknownUsage,
    fixedUsage,
    previous: input.previous ?? null,
    minimumTenureMs,
    hysteresisMs,
  });
  const rejected: RouterDecision['rejected'] = [];
  const eligible: Eligible[] = [];
  for (const candidate of candidates) {
    const { route } = candidate;
    let reason = candidate.blockedReason;
    if (!route.qualified) reason ??= 'Route is not qualified for this work.';
    if (candidate.availableSlots === 0) reason ??= 'No execution slot is available.';
    if (role.pinned && route.id !== role.routeId && !role.approvedFallbacks.includes(route.id)) {
      reason ??= 'Role pin does not permit this route.';
    }
    let unknown = candidate.windowIds.length === 0;
    let percentage = false;
    let reset: number | null = null;
    for (const windowId of candidate.windowIds) {
      const observation = observations
        .filter((value) => value.routeId === route.id && value.windowId === windowId)
        .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
      if (observation === undefined) {
        unknown = true;
        continue;
      }
      const window = deriveWindow(observation, input);
      if (window.state !== 'fresh') unknown = true;
      if (observation.remaining === null) continue;
      const matching = (amount: Reservation) =>
        amount.windowId === windowId &&
        (observation.kind === 'pool' || amount.routeId === route.id);
      const reserve = reserves.filter(
        (value) => value.routeId === route.id && value.windowId === windowId,
      );
      if (reserve.length > 1) throw new TypeError('A window has more than one reserve.');
      if (window.state !== 'fresh') continue;
      const requested = requestedReservations.filter(matching);
      try {
        const available = availableAllowance({
          remaining: observation.remaining,
          reserve: reserve[0],
          reservations: [...reservations.filter(matching), ...requested],
        });
        if (available <= 0) reason ??= `Window ${windowId} has reached its reserve.`;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        reason ??= `Window ${windowId} has incompatible allowance units.`;
      }
      if (window.state === 'fresh' && observation.remaining.unit === 'percent') {
        percentage = true;
        if (observation.resetsAt !== null && Date.parse(observation.resetsAt) > input.nowMs) {
          const value = Date.parse(observation.resetsAt);
          reset = reset === null ? value : Math.min(reset, value);
        }
      }
    }
    const local =
      route.family === 'local' && route.billing === 'local' && candidate.windowIds.length === 0;
    let rule: RouterDecision['rule'] = local ? 'fixed-allowance' : 'percentage';
    if (!local && (unknown || !percentage)) {
      rule = unknownUsage.rule;
      if (unknownUsage.rule === 'waiting')
        reason ??= 'Usage is unknown; waiting for a fresh observation.';
      if (unknownUsage.rule === 'manual' && !unknownUsage.approvedRouteIds.includes(route.id)) {
        reason ??= 'Unknown usage has no manual approval for this route.';
      }
      if (unknownUsage.rule === 'fixed-allowance') {
        const usage = fixedUsage.find((value) => value.routeId === route.id);
        const allowance = unknownUsage.allowance;
        if (
          usage === undefined ||
          usage.launches + usage.reservedLaunches + 1 > allowance.launches ||
          usage.minutes + usage.reservedMinutes >= allowance.minutes ||
          usage.minutes + usage.reservedMinutes + usage.requestedMinutes > allowance.minutes
        ) {
          reason ??= 'Unknown usage has exhausted its fixed launch or time allowance.';
        }
      }
      reset = null;
    }
    if (reason !== null) rejected.push({ routeId: route.id, reason });
    else eligible.push({ id: route.id, rule, reset });
  }
  const rank = (id: string) => {
    const index = input.baseOrder.indexOf(id);
    return index < 0 ? input.baseOrder.length : index;
  };
  const ordered = role.selection === 'ordered';
  eligible.sort(
    (a, b) =>
      (ordered ? 0 : (a.reset ?? Infinity) - (b.reset ?? Infinity)) ||
      rank(a.id) - rank(b.id) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  let chosen = eligible[0];
  const pinned = role.pinned ? eligible.find(({ id }) => id === role.routeId) : undefined;
  if (pinned !== undefined) chosen = pinned;
  else if (!ordered && chosen !== undefined && input.previous !== undefined) {
    const previous = eligible.find(({ id }) => id === input.previous?.routeId);
    if (
      previous !== undefined &&
      (input.nowMs - input.previous.sinceMs < minimumTenureMs ||
        (previous.reset ?? Infinity) - (chosen.reset ?? Infinity) <= hysteresisMs)
    ) {
      chosen = previous;
    }
  }
  for (const candidate of eligible) {
    if (candidate.id !== chosen?.id)
      rejected.push({
        routeId: candidate.id,
        reason:
          pinned !== undefined
            ? 'The available pinned route takes priority.'
            : ordered
              ? 'An earlier eligible route takes priority in the saved order.'
              : 'Another eligible route takes priority under reset order or selection tenure.',
      });
  }
  return RouterDecisionSchema.parse({
    chosen: chosen?.id ?? null,
    rejected,
    rule: chosen?.rule ?? 'waiting',
    inputsHash,
  });
}
