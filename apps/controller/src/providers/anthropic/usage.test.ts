import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservationSchema } from '@crewkite/contracts';
import {
  anthropicUsageObservations,
  projectAnthropicUsage,
  ReplacementError,
} from './replacement.ts';

// Event shapes follow the rate_limit_info schema that client 2.1.302 declares for its stream,
// including the per-response unifiedWindows readings it attaches to each event.
const event = (info: Record<string, unknown>) => ({
  type: 'rate_limit_event',
  session_id: '46eb17cd-01e8-480d-99f4-a741f189715d',
  uuid: '46eb17cd-01e8-480d-99f4-a741f189715f',
  rate_limit_info: { status: 'allowed', ...info },
});
const fiveHourReset = 1_792_000_000;
const weeklyReset = 1_792_500_000;
const fiveHourAt = '2026-10-14T17:46:40.000Z';
const weeklyAt = '2026-10-20T12:40:00.000Z';
const reading = (utilization: number, resetsAt = fiveHourReset) => ({ utilization, resetsAt });
const fiveHour = (remainingPercent: number, resetsAt: string | null = fiveHourAt) => ({
  windowId: 'five_hour',
  kind: 'rolling',
  semantics: { scope: 'provider', periodSeconds: 18_000 },
  remainingPercent,
  resetsAt,
});
const sevenDay = (remainingPercent: number) => ({
  windowId: 'seven_day',
  kind: 'weekly',
  semantics: { scope: 'provider', periodSeconds: 604_800 },
  remainingPercent,
  resetsAt: weeklyAt,
});
const model = (windowId: string, remainingPercent: number) => ({
  windowId,
  kind: 'model',
  semantics: { scope: 'model' },
  remainingPercent,
  resetsAt: weeklyAt,
});
const none = { windows: [], paid: null };

test('a rate limit event yields exactly the valid included readings it carries', () => {
  const rows: Array<[string, Record<string, unknown>, unknown]> = [
    ...[
      [0, 100],
      [0.25, 75],
      [0.2504, 74.96],
      [1, 0],
      [1.5, 0],
    ].map(([utilization, remaining]): [string, Record<string, unknown>, unknown] => [
      `utilization ${utilization} is a used fraction`,
      { unifiedWindows: { five_hour: reading(utilization) } },
      { windows: [fiveHour(remaining)], paid: null },
    ]),
    [
      'each per-response window keeps its own semantics',
      {
        unifiedWindows: {
          five_hour: reading(0.5),
          seven_day: reading(0.75, weeklyReset),
          seven_day_overage_included: reading(0.25, weeklyReset),
        },
      },
      {
        windows: [fiveHour(50), sevenDay(25), model('seven_day_overage_included', 75)],
        paid: null,
      },
    ],
    [
      'a partial event reports only its own window',
      { unifiedWindows: { seven_day: reading(0.75, weeklyReset) } },
      { windows: [sevenDay(25)], paid: null },
    ],
    ...['seven_day_opus', 'seven_day_sonnet'].map(
      (rateLimitType): [string, Record<string, unknown>, unknown] => [
        `top-level ${rateLimitType} is a model pool`,
        { status: 'allowed_warning', rateLimitType, utilization: 0.75, resetsAt: weeklyReset },
        { windows: [model(rateLimitType, 25)], paid: null },
      ],
    ),
    [
      'a top-level reading without a reset keeps the reset unknown',
      { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.75 },
      { windows: [fiveHour(25, null)], paid: null },
    ],
    [
      'per-response readings replace the top-level reading, even for another window',
      {
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        utilization: 0.75,
        resetsAt: weeklyReset,
        unifiedWindows: { five_hour: reading(0.5) },
      },
      { windows: [fiveHour(50)], paid: null },
    ],
    ['status alone is missing', {}, none],
    ['a window name without utilization is missing', { rateLimitType: 'five_hour' }, none],
    ['utilization without a window name is missing', { utilization: 0.5 }, none],
    ['empty per-response readings are missing', { unifiedWindows: {} }, none],
    [
      'utilization past twice the cap stays missing',
      {
        unifiedWindows: { five_hour: reading(2.01), seven_day: reading(0.75, weeklyReset) },
      },
      { windows: [sevenDay(25)], paid: null },
    ],
    [
      'the usage credit window stays apart',
      {
        rateLimitType: 'overage',
        utilization: 0.5,
        resetsAt: weeklyReset,
        isUsingOverage: true,
        unifiedWindows: { five_hour: reading(1) },
      },
      { windows: [fiveHour(0)], paid: { inUse: true, usedPercent: 50, resetsAt: weeklyAt } },
    ],
    [
      'a malformed paid reset keeps the included windows',
      { overageInUse: true, overageResetsAt: 1.5, unifiedWindows: { five_hour: reading(0.5) } },
      { windows: [fiveHour(50)], paid: { inUse: true, usedPercent: null, resetsAt: null } },
    ],
  ];
  for (const [name, info, expected] of rows)
    assert.deepEqual(projectAnthropicUsage(event(info)), expected, name);

  for (const invalid of [
    event({ unifiedWindows: { five_hour: reading(-0.1) } }),
    event({ unifiedWindows: { five_hour: { utilization: '0.5', resetsAt: fiveHourReset } } }),
    event({ unifiedWindows: { five_hour: { utilization: 0.5 } } }),
    event({ unifiedWindows: { five_hour: reading(0.5, 1.5) } }),
    event({ unifiedWindows: { five_hour: reading(0.5, 253_402_300_800) } }),
    event({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1.5 }),
    event({ rateLimitType: 'six_hour', utilization: 0.5 }),
    event({ status: 'private-status' }),
    { ...event({}), type: 'assistant' },
    { ...event({}), session_id: undefined },
  ])
    assert.throws(() => projectAnthropicUsage(invalid), ReplacementError);

  const { windows } = projectAnthropicUsage(event({ unifiedWindows: { five_hour: reading(0.5) } }));
  for (const draft of anthropicUsageObservations(windows, '2026-10-14T13:00:00.000Z'))
    ObservationSchema.parse({ routeId: 'rte_01M51M322B2AEBXD9MA74CBCFM', ...draft });
});
