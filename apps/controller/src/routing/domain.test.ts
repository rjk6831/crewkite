import assert from 'node:assert/strict';
import test from 'node:test';
import type { Attempt, HandoffPacket, Observation, Policy, Route, Run } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { buildHandoff, verifyHandoff } from '../continuity/index.ts';
import { availableAllowance, deriveWindow } from '../usage/index.ts';
import { chooseRoute, type RoutingInput } from './index.ts';

const id = (prefix: string, digit: string) => `${prefix}_${'0'.repeat(25)}${digit}`;
const a = id('rte', '1');
const b = id('rte', '2');
const c = id('rte', '3');
const nowMs = Date.parse('2026-10-16T00:00:00.000Z');
const hour = 60 * 60 * 1000;
const stamp = (offset: number) => new Date(nowMs + offset).toISOString();

function route(routeId: string, family: Route['family']): Route {
  return {
    id: routeId,
    family,
    displayName: family,
    model: 'fixture',
    effort: { requested: 'standard', effective: 'standard', supported: ['standard'] },
    billing: family === 'local' ? 'local' : 'included',
    qualified: true,
    fake: true,
  };
}

function observation(routeId: string, value: number, reset: number): Observation {
  return {
    routeId,
    windowId: 'weekly',
    kind: 'weekly',
    remaining: { value, unit: 'percent' },
    resetsAt: stamp(reset),
    observedAt: stamp(0),
    source: 'fixture',
    confidence: 'reported',
  };
}

function input(): RoutingInput {
  return {
    nowMs,
    maxAgeMs: hour,
    candidates: [
      { route: route(a, 'openai'), windowIds: ['weekly'], availableSlots: 1 },
      { route: route(b, 'anthropic'), windowIds: ['weekly'], availableSlots: 1 },
    ],
    observations: [observation(a, 80, 48 * hour), observation(b, 30, 2 * hour)],
    reserves: [
      { routeId: a, windowId: 'weekly', value: 40, unit: 'percent' },
      { routeId: b, windowId: 'weekly', value: 5, unit: 'percent' },
    ],
    reservations: [],
    role: { role: 'coder', routeId: a, pinned: false, approvedFallbacks: [b] },
    baseOrder: [a, b],
    unknownUsage: { rule: 'waiting' },
    fixedUsage: [],
  };
}

test('reset preference uses the near-reset route until its reserve is reached', () => {
  for (const [remainingA, remainingB, chosen] of [
    [80, 30, b],
    [80, 5, a],
    [40, 5, null],
  ] as const) {
    const value = input();
    value.observations = [
      observation(a, remainingA, 48 * hour),
      observation(b, remainingB, 2 * hour),
    ];
    const result = chooseRoute(value);
    assert.equal(result.chosen, chosen);
    assert.deepEqual(chooseRoute(value), result);
    assert.equal(result.rejected.length, chosen === null ? 2 : 1);
  }
});

test('every window protects same-unit reserves and all outstanding reservations', () => {
  const value = input();
  value.candidates = [
    value.candidates[0],
    { ...value.candidates[1], windowIds: ['weekly', 'short'] },
  ];
  value.observations = [
    ...value.observations,
    {
      ...observation(b, 3, hour),
      windowId: 'short',
      kind: 'rolling',
      remaining: { value: 3, unit: 'requests' },
    },
  ];
  value.reservations = [{ routeId: b, windowId: 'short', value: 3, unit: 'requests' }];
  assert.equal(chooseRoute(value).chosen, a);
  value.reservations = [{ routeId: b, windowId: 'short', value: 1, unit: 'percent' }];
  assert.match(
    chooseRoute(value).rejected.find(({ routeId }) => routeId === b)?.reason ?? '',
    /units/,
  );
  const remaining = { value: 10, unit: 'requests' } as const;
  assert.equal(
    availableAllowance({
      remaining,
      reserve: { value: 2, unit: 'requests' },
      reservations: [{ value: 3, unit: 'requests' }],
      requested: { value: 1, unit: 'requests' },
    }),
    4,
  );
  for (const unit of ['percent', 'tokens', 'credits', 'minutes'] as const) {
    assert.throws(
      () => availableAllowance({ remaining, reservations: [{ value: 1, unit }] }),
      /units/,
    );
  }
  for (const invalid of [-1, NaN, Infinity]) {
    assert.throws(() =>
      availableAllowance({ remaining, requested: { value: invalid, unit: 'requests' } }),
    );
  }
  value.observations = value.observations.map((item) =>
    item.windowId === 'short' ? { ...item, kind: 'pool' } : item,
  );
  value.reservations = [{ routeId: a, windowId: 'short', value: 3, unit: 'requests' }];
  assert.equal(chooseRoute(value).chosen, a);
  value.reservations = [];
  value.requestedReservations = [{ routeId: b, windowId: 'short', value: 3, unit: 'requests' }];
  assert.equal(chooseRoute(value).chosen, a);
});

test('stale and missing windows use only the selected finite fallback policy', () => {
  const base = input();
  base.candidates = [base.candidates[1]];
  base.observations = [];
  const fixed: Policy['unknownUsage'] = {
    rule: 'fixed-allowance',
    allowance: { launches: 2, minutes: 10 },
  };
  const cases: Array<{
    policy: Policy['unknownUsage'];
    usage: RoutingInput['fixedUsage'];
    chosen: string | null;
  }> = [
    { policy: { rule: 'waiting' }, usage: [], chosen: null },
    { policy: { rule: 'manual', approvedRouteIds: [b] }, usage: [], chosen: b },
    { policy: { rule: 'manual', approvedRouteIds: [a] }, usage: [], chosen: null },
    { policy: fixed, usage: [], chosen: null },
    { policy: fixed, usage: [{ routeId: b, launches: 1, minutes: 3 }], chosen: b },
    {
      policy: fixed,
      usage: [{ routeId: b, launches: 1, minutes: 3, reservedLaunches: 1 }],
      chosen: null,
    },
    {
      policy: fixed,
      usage: [{ routeId: b, launches: 0, minutes: 3, reservedMinutes: 7 }],
      chosen: null,
    },
    {
      policy: fixed,
      usage: [{ routeId: b, launches: 0, minutes: 3, requestedMinutes: 8 }],
      chosen: null,
    },
  ];
  for (const entry of cases) {
    assert.equal(
      chooseRoute({ ...base, unknownUsage: entry.policy, fixedUsage: entry.usage }).chosen,
      entry.chosen,
    );
  }
  base.observations = [{ ...observation(b, 30, 2 * hour), observedAt: stamp(-2 * hour) }];
  assert.equal(chooseRoute(base).chosen, null);
  assert.equal(
    chooseRoute({ ...base, unknownUsage: { rule: 'manual', approvedRouteIds: [b] } }).chosen,
    b,
  );
  base.observations = [observation(b, 30, 2 * hour)];
  base.candidates = [{ ...base.candidates[0], windowIds: ['weekly', 'missing'] }];
  assert.equal(chooseRoute(base).chosen, null);
  base.observations = [observation(b, 5, 2 * hour)];
  assert.equal(
    chooseRoute({ ...base, unknownUsage: { rule: 'manual', approvedRouteIds: [b] } }).chosen,
    null,
  );
  const local = {
    ...input(),
    candidates: [{ route: route(c, 'local'), windowIds: [], availableSlots: 1 }],
  };
  assert.equal(chooseRoute(local).chosen, c);
  assert.equal(
    chooseRoute({ ...local, candidates: [{ ...local.candidates[0], windowIds: ['quota'] }] })
      .chosen,
    null,
  );
  const remote = { ...route(c, 'local'), billing: 'credits' as const };
  assert.equal(
    chooseRoute({ ...local, candidates: [{ ...local.candidates[0], route: remote }] }).chosen,
    null,
  );
});

test('passing a reset does not restore allowance until a new observation confirms it', () => {
  const before = observation(b, 30, hour);
  assert.equal(
    deriveWindow(before, { nowMs: nowMs + hour, maxAgeMs: 4 * hour }).state,
    'reset-pending',
  );
  const repeated = { ...before, observedAt: stamp(hour) };
  assert.equal(
    deriveWindow(repeated, { nowMs: nowMs + hour, maxAgeMs: 4 * hour }).state,
    'reset-pending',
  );
  const confirmed = { ...repeated, resetsAt: stamp(2 * hour) };
  assert.equal(deriveWindow(confirmed, { nowMs: nowMs + hour, maxAgeMs: 4 * hour }).state, 'fresh');
  assert.equal(
    deriveWindow({ ...before, remaining: null }, { nowMs, maxAgeMs: hour }).state,
    'unknown',
  );
  assert.equal(
    deriveWindow({ ...before, observedAt: stamp(1) }, { nowMs, maxAgeMs: hour }).state,
    'unknown',
  );
  assert.equal(deriveWindow(before, { nowMs: nowMs + hour / 2, maxAgeMs: 1 }).state, 'stale');
});

test('tenure and hysteresis protect healthy selections without bypassing hard gates', () => {
  const value = input();
  value.previous = { routeId: a, sinceMs: nowMs - 1000 };
  value.minimumTenureMs = 2000;
  assert.equal(chooseRoute(value).chosen, a);
  value.minimumTenureMs = 0;
  value.resetPreferenceHysteresisMs = 47 * hour;
  assert.equal(chooseRoute(value).chosen, a);
  value.resetPreferenceHysteresisMs = hour;
  assert.equal(chooseRoute(value).chosen, b);
  value.minimumTenureMs = 2000;
  value.observations = [observation(a, 40, 48 * hour), observation(b, 30, 2 * hour)];
  assert.equal(chooseRoute(value).chosen, b);
  value.observations = input().observations;
  value.candidates = [{ ...value.candidates[0], availableSlots: 0 }, value.candidates[1]];
  assert.equal(chooseRoute(value).chosen, b);
  for (const family of ['local', 'google'] as const) {
    const recovered = input();
    recovered.candidates = [
      recovered.candidates[0],
      {
        route: route(c, family),
        windowIds: [],
        availableSlots: 1,
      },
    ];
    recovered.unknownUsage = { rule: 'manual', approvedRouteIds: [c] };
    recovered.previous = { routeId: c, sinceMs: nowMs - hour };
    recovered.minimumTenureMs = 1000;
    assert.equal(chooseRoute(recovered).chosen, a);
  }
});

test('pins prefer the primary and permit only explicitly approved fallback routes', () => {
  const value = input();
  value.role = { ...value.role, pinned: true };
  assert.equal(chooseRoute(value).chosen, a);
  value.observations = [observation(a, 40, 48 * hour), observation(b, 30, 2 * hour)];
  assert.equal(chooseRoute(value).chosen, b);
  value.role = { ...value.role, approvedFallbacks: [] };
  assert.equal(chooseRoute(value).chosen, null);
});

function handoff(): { packet: HandoffPacket; outgoing: Attempt; run: Run; quiescent: boolean } {
  const policy: Policy = {
    authority: 'guided',
    quality: 'standard',
    effects: [],
    limits: { attempts: 3, minutes: 10, concurrency: 1 },
    reserves: [],
    unknownUsage: { rule: 'waiting' },
  };
  const source = {
    projectId: id('prj', '1'),
    base: 'a'.repeat(40),
    branch: 'main',
    dirtyCount: 0,
    untrackedCount: 0,
  };
  const resolved = { policy, hash: hashCanonical(policy) };
  const packet: HandoffPacket = {
    version: 1,
    id: id('hnd', '1'),
    taskId: id('tsk', '1'),
    runId: id('run', '1'),
    attemptId: id('att', '1'),
    generation: 1,
    outcome: 'Retain the edit',
    criteria: ['The edit is inspectable'],
    decisions: [],
    deniedActions: [],
    source,
    candidate: null,
    artifacts: [],
    unfinished: ['Run checks'],
    unverified: ['The retained edit'],
    failedChecks: [],
    unrunChecks: ['unit'],
    scope: ['src'],
    remainingBudgets: { attempts: 0, minutes: 0, concurrency: 0 },
    unresolvedExposure: [],
    policy: resolved,
    allowedRouteIds: [b],
    createdAt: stamp(0),
  };
  return {
    packet,
    quiescent: true,
    outgoing: {
      id: packet.attemptId,
      runId: packet.runId,
      routeId: a,
      generation: 1,
      state: 'stopped',
      revision: 1,
    },
    run: {
      id: packet.runId,
      taskId: packet.taskId,
      source,
      policy: resolved,
      roles: [input().role],
      decision: { chosen: a, rejected: [], rule: 'percentage', inputsHash: 'a'.repeat(64) },
      revision: 1,
    },
  };
}

test('handoff sealing requires stopped ownership and unchanged lineage and detects tampering', () => {
  const value = handoff();
  const sealed = buildHandoff(value);
  assert.ok(verifyHandoff(sealed));
  assert.deepEqual(sealed.packet.remainingBudgets, { attempts: 0, minutes: 0, concurrency: 0 });
  assert.equal(
    verifyHandoff({ ...sealed, packet: { ...sealed.packet, unfinished: ['Changed'] } }),
    false,
  );
  assert.throws(() => buildHandoff({ ...value, quiescent: false }), /quiescence/);
  for (const state of ['running', 'stopping', 'unknown', 'interrupted'] as const) {
    assert.throws(
      () => buildHandoff({ ...value, outgoing: { ...value.outgoing, state } }),
      /stopped/,
    );
  }
  for (const packet of [
    { ...value.packet, taskId: id('tsk', '2') },
    { ...value.packet, generation: 2 },
    { ...value.packet, source: { ...value.packet.source, base: 'b'.repeat(40) } },
    { ...value.packet, policy: { ...value.packet.policy, hash: 'b'.repeat(64) } },
    { ...value.packet, allowedRouteIds: [c] },
    { ...value.packet, remainingBudgets: { attempts: 4, minutes: 0, concurrency: 0 } },
    {
      ...value.packet,
      candidate: {
        id: id('cnd', '1'),
        taskId: value.packet.taskId,
        artifactId: id('art', '1'),
        hash: 'a'.repeat(64),
        revision: 1,
      },
    },
  ])
    assert.throws(() => buildHandoff({ ...value, packet }));
});
