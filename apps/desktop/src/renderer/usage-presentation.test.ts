import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservationSchema, type Route, type Window } from '@crewkite/contracts';
import { createDemoFixtures, createTestIds, DEMO_TIME } from '@crewkite/testkit';
import { projectUsagePresentation } from './usage-presentation.ts';

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
