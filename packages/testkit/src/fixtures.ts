import {
  PolicySchema,
  RoleSchema,
  SnapshotSchema,
  TaskSchema,
  TimestampSchema,
} from '@crewkite/contracts';

export const DEMO_TIME = '2026-10-15T17:00:00.000Z';
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function createTestClock(start = DEMO_TIME) {
  let current = Date.parse(TimestampSchema.parse(start));
  return {
    now: () => new Date(current).toISOString(),
    advance(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new RangeError('Clock advances require non-negative integer milliseconds.');
      }
      const next = current + milliseconds;
      if (!Number.isSafeInteger(next) || next > 8_640_000_000_000_000) {
        throw new RangeError('Clock advance exceeds the supported date range.');
      }
      current = next;
      return new Date(current).toISOString();
    },
  };
}

export function createTestIds(start = DEMO_TIME, seed = 0n) {
  const milliseconds = Date.parse(TimestampSchema.parse(start));
  if (milliseconds < 0 || milliseconds > 281_474_976_710_655 || seed < 0n) {
    throw new RangeError('ID inputs exceed ULID bounds.');
  }
  let counter = seed;
  function encode(value: bigint, length: number) {
    let encoded = '';
    for (let index = 0; index < length; index++) {
      encoded = alphabet[Number(value & 31n)] + encoded;
      value >>= 5n;
    }
    if (value !== 0n) throw new RangeError('ID sequence exhausted.');
    return encoded;
  }
  const timestamp = encode(BigInt(milliseconds), 10);
  return (
    prefix:
      | 'prj'
      | 'tsk'
      | 'run'
      | 'att'
      | 'rte'
      | 'apr'
      | 'art'
      | 'cnd'
      | 'hnd'
      | 'evt'
      | 'cmd'
      | 'msg',
  ) => {
    const suffix = encode(counter, 16);
    counter++;
    return `${prefix}_${timestamp}${suffix}`;
  };
}

export function createDemoFixtures(now = DEMO_TIME) {
  TimestampSchema.parse(now);
  const id = createTestIds(now);
  const projectId = id('prj');
  const taskId = id('tsk');
  const families = ['openai', 'anthropic', 'google', 'local'] as const;
  const names = ['OpenAI', 'Anthropic', 'Google', 'Local'];
  const routes = families.map((family, index) => ({
    id: id('rte'),
    family,
    displayName: `${names[index]} fixture`,
    model: `${family}-fixture`,
    effort: { requested: 'standard', effective: 'standard', supported: ['standard'] },
    billing: family === 'local' ? ('local' as const) : ('included' as const),
    qualified: true,
    fake: true,
  }));
  const observed = Date.parse(now);
  const usage = routes.map((route, index) => ({
    observation: {
      routeId: route.id,
      windowId: route.family === 'local' ? 'hardware' : 'weekly',
      kind: route.family === 'local' ? ('local' as const) : ('weekly' as const),
      remaining: index < 2 ? { value: index === 0 ? 80 : 30, unit: 'percent' as const } : null,
      resetsAt:
        index < 2
          ? new Date(observed + (index === 0 ? 172_800_000 : 7_200_000)).toISOString()
          : null,
      observedAt: now,
      source: 'fixture' as const,
      confidence: 'reported' as const,
    },
    state: index < 2 ? ('fresh' as const) : ('unknown' as const),
  }));
  const task = TaskSchema.parse({
    id: taskId,
    projectId,
    title: 'Add netMinor(subtotalMinor, discountMinor)',
    outcome: 'Calculate the net amount and expose it through the CLI and browser form.',
    criteria: [
      'Accept non-negative safe integers in minor units.',
      'Return 2500 for 3000 and 500, and 0 for 3000 and 4000.',
      'Reject negative, fractional and unsafe integer inputs.',
      'Keep every source sentinel unchanged.',
    ],
    state: 'draft',
    waitingReason: null,
    revision: 0,
    runId: null,
    next: 'Prepare the run.',
  });
  const snapshot = SnapshotSchema.parse({
    protocol: 1,
    cursor: '0',
    projects: [{ id: projectId, name: 'demo-shop', revision: 0 }],
    tasks: [],
    runs: [],
    attempts: [],
    routes,
    artifacts: [],
    evidence: [],
    approvals: [],
    usage,
    candidates: [],
  });
  const roles = [
    RoleSchema.parse({
      role: 'coder',
      routeId: routes[1].id,
      pinned: false,
      approvedFallbacks: [routes[0].id],
    }),
  ];
  const policy = PolicySchema.parse({
    authority: 'balanced',
    quality: 'standard',
    effects: [
      { action: 'write-scratch', target: 'demo-shop' },
      { action: 'run-check', target: 'node --test' },
      { action: 'accept-candidate', target: 'refs/heads/feat/net-minor' },
      { action: 'export-patch', target: taskId },
    ].map((effect) => ({
      ...effect,
      taskId,
      expiresAt: new Date(observed + 86_400_000).toISOString(),
      revoked: false,
      usesRemaining: 1,
    })),
    limits: { attempts: 4, minutes: 30, concurrency: 1 },
    reserves: routes.slice(0, 2).map((route, index) => ({
      routeId: route.id,
      windowId: 'weekly',
      value: index === 0 ? 40 : 5,
      unit: 'percent',
    })),
    unknownUsage: { rule: 'waiting' },
  });
  return { snapshot, task, roles, policy };
}
