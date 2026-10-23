import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservationSchema, type Route, type Window } from '@crewkite/contracts';
import { createDemoFixtures, createTestIds, DEMO_TIME } from '@crewkite/testkit';
import {
  anthropicUsageCard,
  nativeUsageClients,
  projectUsagePresentation,
} from './usage-presentation.ts';

const id = createTestIds(DEMO_TIME, 9000n);
const base = createDemoFixtures().snapshot.routes;
const live = (family: Route['family']): Route => ({
  ...(base.find((route) => route.family === family) as Route),
  id: id('rte'),
  fake: false,
});
const nowMs = Date.parse(DEMO_TIME) + 60_000;
const window = (
  route: Route,
  windowId: string,
  value: number,
  semantics?: { scope: 'provider' | 'model' | 'pool'; periodSeconds?: number },
): Window => ({
  observation: ObservationSchema.parse({
    routeId: route.id,
    windowId,
    kind: 'weekly',
    ...(semantics ? { semantics } : {}),
    remaining: { value, unit: 'percent' },
    resetsAt: new Date(nowMs + 3_600_000).toISOString(),
    observedAt: DEMO_TIME,
    source: 'client',
    confidence: 'reported',
  }),
  state: 'fresh',
});
const reader = {
  id: 'google-usage-v1' as const,
  family: 'google' as const,
  clientVersion: '1.4.0',
  available: true,
  reason: 'available' as const,
  lastObservedAt: DEMO_TIME,
  lastAttemptAt: DEMO_TIME,
};

test('usage projection features a lone model pool by semantics and keeps provider sessions apart', () => {
  const google = live('google');
  const openaiA = live('openai');
  const openaiB = live('openai');
  const anthropic = live('anthropic');
  const weekly = { scope: 'provider', periodSeconds: 604800 } as const;
  const fiveHour = { scope: 'provider', periodSeconds: 18000 } as const;
  const model = { scope: 'model', periodSeconds: 604800 } as const;
  const cases: {
    claim: string;
    routes: Route[];
    usage: Window[];
    expect: { featured: (string | null)[]; satellites: string[][] };
  }[] = [
    {
      claim: 'a lone model pool is featured and stays listed for hosts without a center dial',
      routes: [google],
      usage: [
        window(google, 'weekly', 99, weekly),
        window(google, 'five-hour', 100, fiveHour),
        window(google, 'model-weekly', 99, model),
        window(google, 'other-5h', 100),
      ],
      expect: { featured: ['model-weekly'], satellites: [['model-weekly', 'other-5h']] },
    },
    {
      claim: 'several model pools are never promoted',
      routes: [anthropic],
      usage: [window(anthropic, 'pool-a', 40, model), window(anthropic, 'pool-b', 60, model)],
      expect: { featured: [null], satellites: [['pool-a', 'pool-b']] },
    },
    {
      claim: 'equal readings on two sessions of one provider stay separate cards',
      routes: [openaiA, openaiB],
      usage: [
        window(openaiA, 'limit:primary', 72, weekly),
        window(openaiB, 'limit:primary', 72, weekly),
      ],
      expect: { featured: [null, null], satellites: [[], []] },
    },
    {
      claim: 'equal readings from two providers stay separate cards',
      routes: [openaiA, anthropic],
      usage: [
        window(openaiA, 'limit:primary', 72, weekly),
        window(anthropic, 'limit:primary', 72, weekly),
      ],
      expect: { featured: [null, null], satellites: [[], []] },
    },
  ];
  for (const { claim, routes, usage, expect } of cases) {
    const cards = projectUsagePresentation({ routes, usage, usageReaders: [reader] }, null, nowMs);
    assert.deepEqual(
      cards.map((card) => card.featured?.windowId ?? null),
      expect.featured,
      claim,
    );
    assert.deepEqual(
      cards.map((card) => card.satellites.map((reading) => reading.windowId)),
      expect.satellites,
      claim,
    );
  }
});

test('native clients remain visible before any usage route exists', () => {
  const clients = nativeUsageClients({
    usageReaders: [],
    nativeProfiles: [
      { id: 'openai-file-v1', family: 'openai', available: true, reason: 'available' },
      {
        id: 'anthropic-file-v1',
        family: 'anthropic',
        available: true,
        reason: 'qualification-pending',
      },
      {
        id: 'anthropic-file-compact-v1',
        family: 'anthropic',
        available: true,
        reason: 'qualification-pending',
      },
      { id: 'google-acp-v1', family: 'google', available: false, reason: 'client-unavailable' },
    ],
  });
  assert.deepEqual(
    clients.map(({ family, profiles, reader }) => [family, profiles.length, reader]),
    [
      ['openai', 1, null],
      ['anthropic', 2, null],
      ['google', 1, null],
      ['local', 0, null],
    ],
  );
});

test('native usage gauges show the remaining percent without inventing freshness', () => {
  const scopeHash = 'a'.repeat(64);
  const reader = {
    id: 'anthropic-usage-v1' as const,
    family: 'anthropic' as const,
    clientVersion: 'fixture',
    available: true,
    reason: 'available' as const,
    lastObservedAt: null,
    readingScopeHash: scopeHash,
    trust: {
      scopeHash,
      clientSha256: 'b'.repeat(64),
      command: '/usage' as const,
      generationRequest: false as const,
      policyHooks: 'covered-by-native-client-trust' as const,
      accepted: true,
    },
    reading: {
      status: 'reported' as const,
      source: 'native-local-command' as const,
      receivedAt: DEMO_TIME,
      observedAt: null,
      freshness: 'unknown' as const,
      windows: [
        { windowId: 'scoped-pool', value: 100 },
        { windowId: 'five-hour', value: 63 },
        { windowId: 'weekly', value: 0 },
      ].map(({ windowId, value }) => ({
        windowId,
        remaining: { value, unit: 'percent' as const },
        resetsAt: DEMO_TIME,
      })),
      extraUsage: null,
      modelTurns: 0 as const,
      qualified: false as const,
    },
  };
  const before = JSON.stringify(reader);
  const card = anthropicUsageCard({ usageReaders: [reader] });
  assert(card);
  const rows = [...card.primary, ...(card.auxiliary ?? [])];
  assert.deepEqual(
    rows.map((row) => [row.label, row.remaining?.value]),
    [
      ['Weekly', 0],
      ['Five-hour', 63],
      ['scoped-pool', 100],
    ],
  );
  assert(
    rows.every(
      (row) =>
        row.state === 'reported' &&
        row.observedAt === null &&
        row.resetsAt === DEMO_TIME &&
        row.reserve === undefined,
    ),
  );
  assert(card.tags?.includes('Current scope'));
  assert(card.notice?.includes('cache age unknown'));
  assert(rows.every((row) => row.note?.includes(scopeHash)));
  const repeated = anthropicUsageCard({
    usageReaders: [
      {
        ...reader,
        reading: {
          ...reader.reading,
          windows: [reader.reading.windows[1], reader.reading.windows[1]],
        },
      },
    ],
  });
  assert.equal(new Set(repeated?.primary.map((row) => row.id)).size, 2);
  assert.equal(JSON.stringify(reader), before);
  const prior = anthropicUsageCard({
    usageReaders: [{ ...reader, readingScopeHash: 'c'.repeat(64) }],
  });
  assert(prior?.tags?.includes('Earlier or unknown scope'));
  assert.equal(anthropicUsageCard({ usageReaders: [] }), null);
});
