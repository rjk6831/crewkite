import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type AllowanceReading,
  type ChatCatalogEntry,
  type ChatCatalogRead,
  type ChatFamily,
  type ChatTurn,
  type Event,
  type PlanRecipe,
  type PlanRecipeRun,
  type PlanRecipeTrigger,
  type PlanScheduleNote,
  type PlanScheduleRecord,
  planScheduleLine,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { type ChatScriptStep, createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import { ChatService } from '../chat/service.ts';
import { RemoteEffects } from '../github/effects.ts';
import { installedTools } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import { afterSkip, nextStart } from './scheduler.ts';
import {
  type Allowance,
  allowanceOf,
  decideStart,
  memberReadings,
  type PreconditionInput,
  precondition,
  type StartInput,
} from './start-rule.ts';
import { crewReadings, RunTracker } from './tracker.ts';

const at = '2026-10-15T17:00:00.000Z';
const minutes = (count: number) => new Date(Date.parse(at) - count * 60_000).toISOString();

// The decision table, one row per combination: allowance, runs left, waiting, dry runs and last
// run, then the action, the note code and the line the person reads. The sample lines use
// Anthropic at 86% against a limit of 80%, a run limit of 5 and 3 runs waiting.
const TABLE: [string, string, string, string, string, string, string, string][] = [
  ['ok', 'left', 'under', '0-1', 'idle', 'start', '', ''],
  [
    'ok',
    'left',
    'under',
    '0-1',
    'running',
    'skip',
    'run-active',
    'Skipped. The last run is still going.',
  ],
  ['ok', 'left', 'under', '0-1', 'waiting', 'start', '', ''],
  [
    'ok',
    'left',
    'under',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'left',
    'under',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'left',
    'under',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'left',
    'at-limit',
    '0-1',
    'idle',
    'pause',
    'waiting-limit',
    'Paused. 3 runs are waiting for you.',
  ],
  [
    'ok',
    'left',
    'at-limit',
    '0-1',
    'running',
    'pause',
    'waiting-limit',
    'Paused. 3 runs are waiting for you.',
  ],
  [
    'ok',
    'left',
    'at-limit',
    '0-1',
    'waiting',
    'pause',
    'waiting-limit',
    'Paused. 3 runs are waiting for you.',
  ],
  [
    'ok',
    'left',
    'at-limit',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'left',
    'at-limit',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'left',
    'at-limit',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'none',
    'under',
    '0-1',
    'idle',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'ok',
    'none',
    'under',
    '0-1',
    'running',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'ok',
    'none',
    'under',
    '0-1',
    'waiting',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'ok',
    'none',
    'under',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'none',
    'under',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'none',
    'under',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'none',
    'at-limit',
    '0-1',
    'idle',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'ok',
    'none',
    'at-limit',
    '0-1',
    'running',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'ok',
    'none',
    'at-limit',
    '0-1',
    'waiting',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'ok',
    'none',
    'at-limit',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'none',
    'at-limit',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'ok',
    'none',
    'at-limit',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'left',
    'under',
    '0-1',
    'idle',
    'skip',
    'allowance-limit',
    'Did not start. Anthropic is at 86% used. The limit for this loop is 80%.',
  ],
  [
    'over',
    'left',
    'under',
    '0-1',
    'running',
    'skip',
    'run-active',
    'Skipped. The last run is still going.',
  ],
  [
    'over',
    'left',
    'under',
    '0-1',
    'waiting',
    'skip',
    'allowance-limit',
    'Did not start. Anthropic is at 86% used. The limit for this loop is 80%.',
  ],
  [
    'over',
    'left',
    'under',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'left',
    'under',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'left',
    'under',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'left',
    'at-limit',
    '0-1',
    'idle',
    'pause',
    'waiting-limit',
    'Paused. 3 runs are waiting for you.',
  ],
  [
    'over',
    'left',
    'at-limit',
    '0-1',
    'running',
    'pause',
    'waiting-limit',
    'Paused. 3 runs are waiting for you.',
  ],
  [
    'over',
    'left',
    'at-limit',
    '0-1',
    'waiting',
    'pause',
    'waiting-limit',
    'Paused. 3 runs are waiting for you.',
  ],
  [
    'over',
    'left',
    'at-limit',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'left',
    'at-limit',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'left',
    'at-limit',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'none',
    'under',
    '0-1',
    'idle',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'over',
    'none',
    'under',
    '0-1',
    'running',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'over',
    'none',
    'under',
    '0-1',
    'waiting',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'over',
    'none',
    'under',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'none',
    'under',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'none',
    'under',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'none',
    'at-limit',
    '0-1',
    'idle',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'over',
    'none',
    'at-limit',
    '0-1',
    'running',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'over',
    'none',
    'at-limit',
    '0-1',
    'waiting',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'over',
    'none',
    'at-limit',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'none',
    'at-limit',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'over',
    'none',
    'at-limit',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'left',
    'under',
    '0-1',
    'idle',
    'skip',
    'allowance-unknown',
    'Did not start. CrewKite has no current allowance reading for Anthropic.',
  ],
  [
    'unknown',
    'left',
    'under',
    '0-1',
    'running',
    'skip',
    'run-active',
    'Skipped. The last run is still going.',
  ],
  [
    'unknown',
    'left',
    'under',
    '0-1',
    'waiting',
    'skip',
    'allowance-unknown',
    'Did not start. CrewKite has no current allowance reading for Anthropic.',
  ],
  [
    'unknown',
    'left',
    'under',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'left',
    'under',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'left',
    'under',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'left',
    'at-limit',
    '0-1',
    'idle',
    'pause',
    'waiting-limit',
    'Paused. 3 runs are waiting for you.',
  ],
  [
    'unknown',
    'left',
    'at-limit',
    '0-1',
    'running',
    'pause',
    'waiting-limit',
    'Paused. 3 runs are waiting for you.',
  ],
  [
    'unknown',
    'left',
    'at-limit',
    '0-1',
    'waiting',
    'pause',
    'waiting-limit',
    'Paused. 3 runs are waiting for you.',
  ],
  [
    'unknown',
    'left',
    'at-limit',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'left',
    'at-limit',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'left',
    'at-limit',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'none',
    'under',
    '0-1',
    'idle',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'unknown',
    'none',
    'under',
    '0-1',
    'running',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'unknown',
    'none',
    'under',
    '0-1',
    'waiting',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'unknown',
    'none',
    'under',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'none',
    'under',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'none',
    'under',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'none',
    'at-limit',
    '0-1',
    'idle',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'unknown',
    'none',
    'at-limit',
    '0-1',
    'running',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'unknown',
    'none',
    'at-limit',
    '0-1',
    'waiting',
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'unknown',
    'none',
    'at-limit',
    '2',
    'idle',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'none',
    'at-limit',
    '2',
    'running',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'unknown',
    'none',
    'at-limit',
    '2',
    'waiting',
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
];

const VALUES = {
  allowance: {
    ok: { kind: 'ok' },
    over: { kind: 'over', family: 'anthropic', used: 86, limit: 80 },
    unknown: { kind: 'unknown', family: 'anthropic' },
  } satisfies Record<string, Allowance>,
  runs: { left: { started: 4, max: 5 }, none: { started: 5, max: 5 } },
  waiting: { under: { count: 2, max: 3 }, 'at-limit': { count: 3, max: 3 } },
  // Both counts below two stand for 0-1.
  dryRuns: { '0-1': [0, 1], '2': [2] },
} as const;

const said = (answer: { action: string; note: Parameters<typeof planScheduleLine>[0] | null }) => [
  answer.action,
  answer.note?.code ?? '',
  answer.note ? planScheduleLine(answer.note) : '',
];

// The checks before the table, in order: the condition, what differs from an active schedule
// whose file is current, whose crew is ready and whose work is a fixed request, then the answer.
// `go on` means the usage reads come next.
const base: PreconditionInput = {
  at,
  state: 'active',
  file: 'current',
  table: {
    runs: { started: 0, max: 5 },
    waiting: { count: 0, max: 3 },
    dryRuns: 0,
    lastRun: 'idle',
  },
  unready: null,
  checklist: null,
};
const table = (change: Partial<PreconditionInput['table']>) => ({
  table: { ...base.table, ...change },
});
const BEFORE: [string, Partial<PreconditionInput>, string, string, string][] = [
  ['paused', { state: 'paused' }, 'none', '', ''],
  ['stopped', { state: 'stopped' }, 'none', '', ''],
  ['a stopped schedule whose file is gone', { state: 'stopped', file: 'missing' }, 'none', '', ''],
  [
    'file missing',
    { file: 'missing' },
    'pause',
    'recipe-missing',
    'Paused. The recipe file is missing. Open the recipe to write it again or forget it.',
  ],
  [
    'file does not read',
    { file: 'invalid' },
    'pause',
    'recipe-invalid',
    'Paused. The recipe file no longer reads as a recipe. Open the recipe to see why.',
  ],
  [
    'file differs from the armed version',
    { file: 'changed' },
    'pause',
    'recipe-changed',
    'Paused. The recipe file changed on disk. Review it and save to continue.',
  ],
  [
    'a changed file comes before the table',
    { file: 'changed', ...table({ dryRuns: 2 }) },
    'pause',
    'recipe-changed',
    'Paused. The recipe file changed on disk. Review it and save to continue.',
  ],
  [
    'no ready connection',
    { unready: { reason: 'not-connected', family: 'google' } },
    'skip',
    'not-connected',
    'Did not start. Google is not connected.',
  ],
  [
    'the model is gone',
    { unready: { reason: 'model-unknown', family: 'openai' } },
    'skip',
    'model-unknown',
    'Did not start. OpenAI no longer lists a model this recipe names.',
  ],
  [
    'terms pending',
    { unready: { reason: 'terms-pending', family: 'google' } },
    'skip',
    'terms-pending',
    'Did not start. Accept the Google terms in Settings first.',
  ],
  [
    'two dry runs beat a crew that is not ready',
    { unready: { reason: 'not-connected', family: 'google' }, ...table({ dryRuns: 2 }) },
    'stop',
    'dry-runs',
    'Stopped. Two runs in a row changed nothing and found nothing.',
  ],
  [
    'the run limit beats a crew that is not ready',
    {
      unready: { reason: 'not-connected', family: 'google' },
      ...table({ runs: { started: 5, max: 5 } }),
    },
    'stop',
    'run-limit',
    'Stopped. The run limit of 5 is reached.',
  ],
  [
    'the waiting limit beats a crew that is not ready',
    {
      unready: { reason: 'not-connected', family: 'google' },
      ...table({ waiting: { count: 3, max: 3 } }),
    },
    'pause',
    'waiting-limit',
    'Paused. 3 runs are waiting for you.',
  ],
  [
    'a running run beats a crew that is not ready',
    { unready: { reason: 'not-connected', family: 'google' }, ...table({ lastRun: 'running' }) },
    'skip',
    'run-active',
    'Skipped. The last run is still going.',
  ],
  [
    'a crew that is not ready comes before the checklist',
    {
      unready: { reason: 'not-connected', family: 'google' },
      checklist: { path: 'TODO.md', next: 'unreadable' },
    },
    'skip',
    'not-connected',
    'Did not start. Google is not connected.',
  ],
  [
    'checklist cannot be read',
    { checklist: { path: 'TODO.md', next: 'unreadable' } },
    'pause',
    'checklist-unreadable',
    'Paused. TODO.md cannot be read. Fix the file, then resume.',
  ],
  [
    'checklist has no unchecked item',
    { checklist: { path: 'TODO.md', next: 'done' } },
    'stop',
    'checklist-done',
    'Stopped. Every item in TODO.md is checked.',
  ],
  [
    'every unchecked item is held, so the note stays',
    { checklist: { path: 'TODO.md', next: 'held' } },
    'skip',
    '',
    '',
  ],
  ['a checklist item is free', { checklist: { path: 'TODO.md', next: 'item' } }, 'go on', '', ''],
  ['a fixed request', {}, 'go on', '', ''],
];

// The allowance input: one reading per metered family in crew order, against limits of 80% for
// OpenAI and Anthropic and none for Google.
const reading = (
  family: AllowanceReading['family'],
  used: number | null,
  observedAt: string | null = minutes(1),
): AllowanceReading => ({ family, used, window: 'weekly', observedAt });
const READINGS: [string, AllowanceReading[], Allowance][] = [
  ['a crew on Local alone reads nothing', [], { kind: 'ok' }],
  ['under the limit', [reading('openai', 40)], { kind: 'ok' }],
  ['at the limit is not over it', [reading('openai', 80)], { kind: 'ok' }],
  [
    'over the limit, rounded up',
    [reading('openai', 80.2)],
    { kind: 'over', family: 'openai', used: 81, limit: 80 },
  ],
  ['no value', [reading('openai', null)], { kind: 'unknown', family: 'openai' }],
  ['never observed', [reading('openai', 40, null)], { kind: 'unknown', family: 'openai' }],
  ['fourteen minutes old', [reading('openai', 40, minutes(14))], { kind: 'ok' }],
  [
    'as old as the age limit',
    [reading('openai', 40, minutes(15))],
    { kind: 'unknown', family: 'openai' },
  ],
  ['from the future', [reading('openai', 40, minutes(-1))], { kind: 'unknown', family: 'openai' }],
  ['a family with no limit', [reading('google', 10)], { kind: 'unknown', family: 'google' }],
  [
    'an unknown family beats one over its limit, and the first unknown is named',
    [reading('anthropic', 86), reading('openai', null), reading('google', 10)],
    { kind: 'unknown', family: 'openai' },
  ],
  [
    'the first family over its limit in crew order is named',
    [reading('anthropic', 86), reading('openai', 90)],
    { kind: 'over', family: 'anthropic', used: 86, limit: 80 },
  ],
];

// Each member's reading from OpenAI's catalog. `weekly` limits every model and `weekly-beta` only
// the beta model. The crew names its members in this order, Local ones included.
const windowOf = (windowId: string, percent: number | null, observedAt: string) => ({
  windowId,
  label: 'Weekly',
  percent,
  resetsAt: null,
  observedAt,
});
const catalogOf = (remaining: ReturnType<typeof windowOf>[]): ChatCatalogEntry[] => [
  {
    family: 'openai',
    connected: true,
    reason: null,
    models: ['fixture-alpha', 'fixture-beta'].map((model) => ({
      model,
      label: model,
      efforts: ['default'],
      defaultEffort: 'default',
    })),
    defaultModel: 'fixture-alpha',
    remaining,
    accepts: null,
  },
];
const membersOf = (...models: string[]) => ({
  members: models.map((model) => ({
    role: 'builder' as const,
    selection: {
      family: model === 'local' ? ('local' as const) : ('openai' as const),
      model,
      effort: 'default',
    },
  })),
});
const read = (used: number | null, window: string | null, observedAt: string | null) => ({
  family: 'openai' as const,
  used,
  window,
  observedAt,
});
const MEMBERS: [string, ReturnType<typeof windowOf>[], string[], AllowanceReading[], Allowance][] =
  [
    [
      'each member reads the window that limits its own model',
      [windowOf('weekly', 60, minutes(2)), windowOf('weekly-beta', 30, minutes(3))],
      ['fixture-alpha', 'fixture-beta'],
      [read(40, 'weekly', minutes(2)), read(70, 'weekly-beta', minutes(3))],
      { kind: 'ok' },
    ],
    [
      'a member whose model has no reading makes the family unknown',
      [windowOf('weekly', null, minutes(2)), windowOf('weekly-beta', 30, minutes(3))],
      ['fixture-alpha', 'fixture-beta'],
      [read(null, null, null), read(70, 'weekly-beta', minutes(3))],
      { kind: 'unknown', family: 'openai' },
    ],
    [
      "the time is the read window's own, not that of another window at the same value",
      [windowOf('weekly-beta', 20, minutes(30)), windowOf('weekly', 20, minutes(1))],
      ['fixture-alpha'],
      [read(80, 'weekly', minutes(1))],
      { kind: 'ok' },
    ],
    [
      'a Local member is never read',
      [windowOf('weekly', 60, minutes(2))],
      ['local', 'fixture-alpha'],
      [read(40, 'weekly', minutes(2))],
      { kind: 'ok' },
    ],
  ];

// When a schedule tries next, by trigger. Times are minutes after `at`, which is when the
// schedule was armed. A reset trigger starts only at a reset a reading reported.
const later = (count: number) => new Date(Date.parse(at) + count * 60_000).toISOString();
const unknownReading: PlanScheduleNote = { code: 'allowance-unknown', at, family: 'openai' };
const overLimit: PlanScheduleNote = {
  code: 'allowance-limit',
  at,
  family: 'openai',
  used: 86,
  limit: 80,
};
const reset: PlanRecipeTrigger = { kind: 'reset', family: 'openai' };
// Each row: the trigger, how many minutes after arming it is asked, the reset a reading reports,
// the note of a start just passed over (none for a start or a move), then the next start and the
// code of the note it keeps.
const NEXT: [
  string,
  PlanRecipeTrigger,
  number,
  string | null,
  PlanScheduleNote | null,
  string | null,
  string,
][] = [
  [
    'an interval starts one step after arming',
    { kind: 'interval', everyMinutes: 30 },
    0,
    null,
    null,
    later(30),
    '',
  ],
  [
    'a late interval keeps its grid',
    { kind: 'interval', everyMinutes: 30 },
    70,
    null,
    null,
    later(90),
    '',
  ],
  ['a once trigger keeps its time', { kind: 'once', at: later(10) }, 0, null, null, later(10), ''],
  ['a reset trigger takes a reported reset ahead', reset, 0, later(60), null, later(60), ''],
  ['a reset already passed is no next start', reset, 0, later(-5), null, null, 'reset-unknown'],
  ['no reset time known is no next start', reset, 0, null, null, null, 'reset-unknown'],
  [
    'a reset start with no reading tries again in 15 minutes',
    reset,
    0,
    null,
    unknownReading,
    later(15),
    'allowance-unknown',
  ],
  [
    'a reset start over its limit waits for the next reset',
    reset,
    0,
    later(300),
    overLimit,
    later(300),
    'allowance-limit',
  ],
  [
    'over its limit with no reset known, it has no next start',
    reset,
    0,
    null,
    overLimit,
    null,
    'reset-unknown',
  ],
];

// Claim: a schedule starts, skips, pauses or stops exactly as the decision table says for every
// combination of its inputs, the checks before the table come in their order, the allowance input
// is read the way the table defines it, and each answer carries the line the person reads.
test('the start rule answers every combination', () => {
  assert.equal(TABLE.length, 72);
  assert.equal(new Set(TABLE.map((row) => row.slice(0, 5).join())).size, 72);
  for (const [index, row] of TABLE.entries()) {
    const [allowance, runs, waiting, dry, last, ...expected] = row;
    for (const dryRuns of VALUES.dryRuns[dry as keyof typeof VALUES.dryRuns]) {
      const input: StartInput = {
        at,
        allowance: VALUES.allowance[allowance as keyof typeof VALUES.allowance],
        runs: VALUES.runs[runs as keyof typeof VALUES.runs],
        waiting: VALUES.waiting[waiting as keyof typeof VALUES.waiting],
        dryRuns,
        lastRun: last as StartInput['lastRun'],
      };
      assert.deepEqual(said(decideStart(input)), expected, `row ${index + 1}, ${dryRuns} dry`);
    }
  }

  assert.equal(BEFORE.length, 20);
  for (const [name, change, ...expected] of BEFORE) {
    const answer = precondition({ ...base, ...change });
    const got =
      answer === null
        ? ['go on', '', '']
        : answer.action === 'none'
          ? ['none', '', '']
          : said(answer);
    assert.deepEqual(got, expected, name);
  }

  assert.equal(READINGS.length, 12);
  for (const [name, readings, expected] of READINGS)
    assert.deepEqual(allowanceOf(readings, { openai: 80, anthropic: 80 }, at), expected, name);

  assert.equal(MEMBERS.length, 4);
  for (const [name, remaining, models, readings, allowance] of MEMBERS) {
    const got = memberReadings(membersOf(...models), catalogOf(remaining));
    assert.deepEqual(got, readings, name);
    assert.deepEqual(allowanceOf(got, { openai: 80 }, at), allowance, name);
  }

  assert.equal(NEXT.length, 9);
  const never = { lastRun: null };
  const ranAt = { lastRun: { startedAt: at } } as unknown as Pick<PlanScheduleRecord, 'lastRun'>;
  const schedule = { armedAt: at, note: null, nextAt: at } as unknown as PlanScheduleRecord;
  for (const [name, trigger, asked, resetAt, skipped, nextAt, code] of NEXT) {
    const next =
      skipped === null
        ? nextStart(trigger, at, later(asked), resetAt, null, never)
        : afterSkip(schedule, skipped, trigger, later(asked), resetAt);
    assert.deepEqual([next.nextAt, next.note?.code ?? ''], [nextAt, code], name);
  }
  // A reset found clears the note that said what the schedule waited for, and a reset sooner
  // than the retry interval after the last start is the one just used, reported late.
  const waiting: PlanScheduleNote = { code: 'reset-unknown', at, family: 'openai' };
  assert.deepEqual(nextStart(reset, at, at, later(60), waiting, never), {
    nextAt: later(60),
    note: null,
  });
  assert.deepEqual(nextStart(reset, at, at, later(60), unknownReading, never), {
    nextAt: later(60),
    note: null,
  });
  // The floor is the function's own, read from the schedule's last run, so a save, a skip, a
  // lifted pause, resume, restart and the look all get it with the one call they share.
  assert.deepEqual(nextStart(reset, at, at, later(14), null, ranAt).nextAt, null);
  assert.deepEqual(nextStart(reset, at, at, later(15), null, ranAt).nextAt, later(15));
  assert.deepEqual(nextStart(reset, at, at, later(1), null, never).nextAt, later(1));
  // A run's stored reading per provider is the tightest member's window, with its own time.
  assert.deepEqual(
    crewReadings(
      membersOf('fixture-alpha', 'fixture-beta').members.map((member) => member.selection),
      catalogOf([windowOf('weekly', 60, minutes(2)), windowOf('weekly-beta', 30, minutes(3))]),
    ),
    [read(70, 'weekly-beta', minutes(3))],
  );
});

const PATH = process.env.PATH;
const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];
const onePlan = reply(
  `\`\`\`json plan\n${JSON.stringify({
    planId: 'p1',
    goal: 'Tidy it.',
    slices: [
      {
        id: 1,
        title: 'Part 1',
        brief: 'Do part 1.',
        files: [],
        depends: [],
        difficulty: 'medium',
        readOnly: false,
      },
    ],
  })}\n\`\`\``,
);

const readPlan = reply(
  `\`\`\`json plan\n${JSON.stringify({
    planId: 'p1',
    goal: 'Read it.',
    slices: [
      {
        id: 1,
        title: 'Part 1',
        brief: 'Read part 1.',
        files: [],
        depends: [],
        difficulty: 'medium',
        readOnly: true,
      },
    ],
  })}\n\`\`\``,
);

type Family = 'openai' | 'anthropic' | 'google' | 'local';

/**
 * A recipe run on its own chat service, set up the way RunRecipe does it, by default with a crew
 * on Anthropic and automatic handoff on. Anthropic reads 86% used and OpenAI 40%, both just now.
 * Google reads 5% used, so it ranks first for a handoff, but its reading is twenty minutes old.
 * Local has no window. The budget stops starting at 80% for each metered family. With `refresh`,
 * a usage read marks the family's reading as observed now. With `read`, a usage read waits for it
 * first. `settled` runs as each turn settles, before what follows it starts, and may change the
 * readings. PATH holds git alone.
 */
function turnRun(
  t: TestContext,
  origin: PlanRecipeRun['origin'],
  scripts: Partial<Record<Family, ChatScriptStep[][]>>,
  options: {
    crew?: [PlanRecipe['crew']['members'][number]['role'], Family][];
    auto?: boolean;
    left?: Partial<Record<'openai' | 'anthropic' | 'google', [number, string]>>;
    refresh?: boolean;
    read?: Promise<void>;
    shape?: PlanRecipe['shape'];
    settled?: (
      family: ChatFamily,
      left: Record<'openai' | 'anthropic' | 'google', [number, string]>,
    ) => void;
  } = {},
) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'ck-turn-rule-'));
  process.env.PATH = PATH;
  process.env.PATH = installedTools(directory, 'git');
  t.after(() => {
    process.env.PATH = PATH;
    rmSync(directory, { recursive: true, force: true });
  });
  const clock = createTestClock();
  const now = clock.now();
  const ids = createTestIds(now);
  const fixtures = createDemoFixtures(now);
  const root = createSyntheticRepository(join(directory, 'demo-shop')).directory;
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const task = fixtures.task;
  store.transaction(() => {
    store.put('project', task.projectId, 0, { id: task.projectId, name: 'demo-shop', revision: 0 });
    store.put('task', task.id, 0, task);
  });
  const left: Record<'openai' | 'anthropic' | 'google', [number, string]> = {
    anthropic: [14, now],
    openai: [60, now],
    google: [95, new Date(Date.parse(now) - 20 * 60_000).toISOString()],
    ...options.left,
  };
  const adapters = new Map(
    (Object.keys(scripts) as Family[]).map((family) => [
      family,
      createScriptedChatAdapter({ family, turns: scripts[family] ?? [] }),
    ]),
  );
  const catalog = (): ChatCatalogRead => ({
    families: [...adapters.keys()].map((family) => ({
      family,
      connected: true,
      reason: null,
      models: [
        { model: `${family}-model`, label: family, efforts: ['default'], defaultEffort: 'default' },
      ],
      defaultModel: `${family}-model`,
      remaining:
        family === 'local'
          ? []
          : [
              {
                windowId: 'weekly',
                label: 'weekly',
                percent: left[family][0],
                resetsAt: null,
                observedAt: left[family][1],
              },
            ],
      accepts: null,
    })),
  });
  const notices: { kind: string; line: string }[] = [];
  const refreshes: string[] = [];
  const observed: string[] = [];
  const tracker = new RunTracker({
    store,
    now: clock.now,
    home: directory,
    projectPath: () => root,
    families: () => catalog().families,
    changed: (projectId, recipeId) =>
      store.append({
        protocol: 1,
        id: ids('evt'),
        at: now,
        taskId: null,
        revision: 0,
        type: 'recipes.changed',
        payload: { projectId, recipeId },
      }),
  });
  const chat = new ChatService({
    store,
    artifacts: new ArtifactFiles(join(directory, 'artifacts')),
    home: directory,
    googleTermsAcknowledged: () => true,
    now: clock.now,
    id: (prefix) => (prefix === 'trn' ? `trn_${ids('msg').slice(4)}` : ids(prefix)),
    emit: (type, id, revision, payload) =>
      store.append({ protocol: 1, id: ids('evt'), at: now, taskId: id, revision, type, payload }),
    adapters,
    resolveEnvironment: () => ({}),
    projectPath: () => root,
    resolveSelection: (_taskId, value) => value ?? null,
    catalog,
    remoteEffects: new RemoteEffects({
      store,
      home: directory,
      now: clock.now,
      id: () => ids('rfx'),
      projectPath: () => root,
    }),
    notice: (event) => notices.push({ kind: event.kind, line: event.line }),
    observe: (event) => {
      observed.push(event.kind);
      tracker.observe(event);
    },
    ...(options.settled
      ? { onTurnSettled: (family: ChatFamily) => options.settled?.(family, left) }
      : {}),
    ...(options.refresh || options.read
      ? {
          refreshUsage: async (family: ChatFamily) => {
            refreshes.push(family);
            await options.read;
            if (options.refresh && family !== 'local')
              left[family] = [left[family][0], clock.now()];
          },
        }
      : {}),
  });
  t.after(() => chat.close());
  const on = (family: ChatFamily) => ({ family, model: `${family}-model`, effort: 'default' });
  const recipe: PlanRecipe = {
    schema: 1,
    name: 'Tidy',
    description: '',
    shape: options.shape ?? 'change',
    crew: {
      name: 'Run crew',
      members: (
        options.crew ?? [
          ['orchestrator', 'anthropic'],
          ['builder', 'anthropic'],
        ]
      ).map(([role, family]) => ({ role, selection: on(family) })),
    },
    run: {
      flightMode: 'glide',
      permissionPolicy: 'allow-all',
      handoff: { auto: options.auto ?? true, mode: 'most-left' },
      maxSlices: 2,
    },
    checks: [],
    trigger: { kind: 'interval', everyMinutes: 30 },
    budget: {
      maxRuns: 5,
      maxUsedPercent: { openai: 80, anthropic: 80, google: 80 },
      maxWaiting: 3,
    },
    work: { kind: 'request', text: 'Tidy the module.' },
  };
  const recipeId = `rcp_${ids('msg').slice(4)}`;
  const versionHash = 'b'.repeat(64);
  const effects: (() => void)[] = [];
  const started = store.transaction(() => {
    store.putRecipe({
      id: recipeId,
      projectId: task.projectId,
      path: '.crewkite/recipes/tidy.json',
      version: 1,
      versionHash,
      updatedAt: now,
    });
    store.putRecipeVersion(recipeId, 1, versionHash, recipe, now);
    const result = chat.startRecipeThread(
      task,
      {
        crew: recipe.crew,
        flightMode: recipe.run.flightMode,
        permissionPolicy: recipe.run.permissionPolicy,
        handoff: recipe.run.handoff,
        checks: [],
        line: 'Run of Tidy, version 1, started by its loop.',
        request: 'Tidy the module.',
      },
      effects,
    );
    store.putRecipeRun({
      id: `rrn_${ids('msg').slice(4)}`,
      recipeId,
      projectId: task.projectId,
      taskId: task.id,
      version: 1,
      versionHash,
      origin,
      item: null,
      state: 'running',
      findings: null,
      changedFiles: null,
      reason: null,
      startedAt: now,
      endedAt: null,
      allowance: { start: [], end: null },
    });
    return result;
  });
  for (const effect of effects) effect();
  assert.equal(started.outcome, 'applied', JSON.stringify(started));
  const turns = () =>
    store.db
      .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence')
      .all(task.id)
      .map((row) => JSON.parse(row.body as string) as ChatTurn)
      .map((turn) => ({
        role: turn.role,
        family: turn.selection.family,
        state: turn.state,
        line: turn.failure && `${turn.failure.message} ${turn.failure.nextAction}`,
      }));
  const lines = () =>
    store.db
      .prepare(
        "SELECT json_extract(body,'$.text') AS text FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='chat-system' ORDER BY sequence",
      )
      .all(task.id)
      .map((row) => String(row.text));
  const run = () => store.recipeRunOf(task.id) as PlanRecipeRun;
  const until = (check: () => boolean) =>
    new Promise<void>((resolve) => {
      if (check()) return resolve();
      const stop = store.subscribe((_event: Event) => {
        if (!check()) return;
        stop();
        resolve();
      });
    });
  const quiet = async () => {
    for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  };
  const act = (work: (effects: (() => void)[]) => { outcome: string }) => {
    const effects: (() => void)[] = [];
    const result = store.transaction(() => work(effects));
    for (const effect of effects) effect();
    return result;
  };
  const requests = (family: Family) => adapters.get(family)?.requests ?? [];
  const lastTurnId = () =>
    String(
      store.db
        .prepare('SELECT id FROM chat_turns WHERE task_id=? ORDER BY sequence DESC LIMIT 1')
        .get(task.id)?.id,
    );
  return {
    chat,
    task,
    turns,
    lines,
    run,
    notices,
    refreshes,
    observed,
    requests,
    lastTurnId,
    until,
    quiet,
    act,
  };
}

const writes: ChatScriptStep[] = [
  {
    kind: 'tool',
    callId: 'w',
    toolKind: 'edit',
    title: 'Write net.mjs',
    write: { path: 'net.mjs', content: 'export const net = 1;\n' },
  },
  ...reply('Built.'),
];
const ended = (state: string) => ['failed', 'ready', 'no-change', 'stopped'].includes(state);

// Claim: before every plan and crew step on the thread of a run a schedule started, the step's
// family is held to the schedule's limit, whatever the run's state. A step over the limit never
// reaches the provider and ends the way a usage limit ends it, with a line that names the step,
// and the stop it causes carries that line. The handoff that follows passes over a family the
// rule would refuse, even one that ranks first, and gives the schedule's limit as its reason in
// the thread and in the next provider's packet. A slice run again after the run failed, a
// review, a fix, the plan's retry, the challenge and the report are held the same way, and a
// report that moves to another provider still ends the plan once. A reading too old to judge is
// read once more, and a fresh one under the limit lets the step start. A Stop during that read
// stops the step before it starts. A message the person sends, Local and a run started by hand
// are never checked.
test('a scheduled turn does not start above its limit, and a manual run is never checked', {
  timeout: 60000,
}, async (t) => {
  const over = 'Anthropic is at 86% used. The limit for this loop is 80%.';
  const sliceStop = `Plan stopped: Slice 1 did not start. ${over} Run it again from the plan card.`;
  const scheduled = turnRun(t, 'schedule', {
    anthropic: [],
    openai: [onePlan],
    google: [reply('This family was refused.')],
  });
  await scheduled.until(() => scheduled.run().state === 'failed');
  await scheduled.quiet();
  assert.deepEqual(scheduled.turns(), [
    {
      role: 'orchestrator',
      family: 'anthropic',
      state: 'failed',
      line: `The plan did not start. ${over}`,
    },
    { role: 'orchestrator', family: 'openai', state: 'done', line: null },
    {
      role: 'assistant',
      family: 'anthropic',
      state: 'failed',
      line: `Slice 1 did not start. ${over}`,
    },
  ]);
  const lines = scheduled.lines();
  assert(lines.includes(`The plan did not start. ${over}`), lines.join('\n'));
  assert(lines.includes(`Slice 1 did not start. ${over}`), lines.join('\n'));
  assert(lines.includes(sliceStop), lines.join('\n'));
  assert(!lines.some((line) => /reached its usage limit/.test(line)), lines.join('\n'));
  // The plan moved to OpenAI with the schedule's reason.
  const moved = "Continued on OpenAI from Anthropic. Reason: the loop's limit for Anthropic.";
  assert(lines.includes(moved), lines.join('\n'));
  assert(!lines.some((line) => /usage limit reached/.test(line)), lines.join('\n'));
  assert.deepEqual(scheduled.notices, [{ kind: 'limit', line: sliceStop }]);
  assert.equal(scheduled.run().reason, sliceStop);
  // The run has failed. Running the slice again from the plan card is still held to the limit.
  const again = scheduled.act((effects) =>
    scheduled.chat.runPlan({ taskId: scheduled.task.id, planId: 'p1', sliceId: 1 }, effects),
  );
  assert.equal(again.outcome, 'applied', JSON.stringify(again));
  await scheduled.until(
    () => scheduled.turns().length === 4 && scheduled.turns()[3].state !== 'running',
  );
  assert.deepEqual(scheduled.turns()[3], {
    role: 'assistant',
    family: 'anthropic',
    state: 'failed',
    line: `Slice 1 did not start. ${over}`,
  });

  // The plan moves to OpenAI and answers there. The next turn that carries the thread to OpenAI,
  // here a message the person sends the fixer, gets the schedule's reason in its packet.
  const carried = turnRun(
    t,
    'schedule',
    { anthropic: [], openai: [reply('Nothing to change.'), reply('Fixed.')] },
    {
      crew: [
        ['orchestrator', 'anthropic'],
        ['builder', 'anthropic'],
        ['fixer', 'openai'],
      ],
    },
  );
  await carried.until(() => ended(carried.run().state));
  const sent = carried.act((effects) =>
    carried.chat.sendMessage(
      { taskId: carried.task.id, text: 'Fix it.', role: 'fixer', attachments: [], files: [] },
      effects,
    ),
  );
  assert.equal(sent.outcome, 'applied', JSON.stringify(sent));
  await carried.until(() => carried.turns().length === 3 && carried.turns()[2].state !== 'running');
  const packet = carried.requests('openai')[1]?.prompt ?? '';
  assert(
    packet.startsWith(
      "This thread moved from Anthropic to OpenAI. Reason: the loop's limit for Anthropic.",
    ),
    packet,
  );
  assert(!packet.includes('usage limit reached'), packet);

  // A slice held back with no move was never sent. The packet the next provider gets says the
  // turn did not start and why, and never that Anthropic ended a turn on its own limit.
  const unsent = turnRun(
    t,
    'schedule',
    { anthropic: [], openai: [onePlan, reply('Fixed.')] },
    {
      auto: false,
      crew: [
        ['orchestrator', 'openai'],
        ['builder', 'anthropic'],
        ['fixer', 'openai'],
      ],
    },
  );
  await unsent.until(() => ended(unsent.run().state));
  await unsent.quiet();
  const fixing = unsent.act((effects) =>
    unsent.chat.sendMessage(
      {
        taskId: unsent.task.id,
        text: 'Fix it.',
        role: 'fixer',
        selection: { family: 'openai', model: 'openai-model', effort: 'default' },
        attachments: [],
        files: [],
      },
      effects,
    ),
  );
  assert.equal(fixing.outcome, 'applied', JSON.stringify(fixing));
  await unsent.until(() => unsent.turns().length === 3 && unsent.turns()[2].state !== 'running');
  await unsent.quiet();
  const told = unsent.requests('openai').at(-1)?.prompt ?? '';
  assert(
    told.includes(
      `Stopped turn:\nAnthropic's last turn was never sent. Slice 1 did not start. ${over}\n`,
    ),
    told,
  );
  assert(!/usage limit reached|ended its last turn early/.test(told), told);

  // A review on Anthropic after a build on OpenAI.
  const review = turnRun(
    t,
    'schedule',
    { openai: [onePlan, writes], anthropic: [] },
    {
      auto: false,
      crew: [
        ['orchestrator', 'openai'],
        ['builder', 'openai'],
        ['reviewer', 'anthropic'],
      ],
    },
  );
  await review.until(() => ended(review.run().state));
  await review.quiet();
  assert.deepEqual(review.turns().at(-1), {
    role: 'reviewer',
    family: 'anthropic',
    state: 'failed',
    line: `The review of slice 1 did not start. ${over}`,
  });
  assert.equal(
    review.run().reason,
    `Plan stopped: The review of slice 1 did not start. ${over} Run it again from the plan card.`,
  );

  // The plan's closing challenge on Anthropic. The crew's stop line carries the step's own.
  const challenge = turnRun(
    t,
    'schedule',
    { openai: [onePlan, writes], anthropic: [] },
    {
      auto: false,
      crew: [
        ['orchestrator', 'openai'],
        ['builder', 'openai'],
        ['challenger', 'anthropic'],
      ],
    },
  );
  await challenge.until(() => ended(challenge.run().state));
  await challenge.quiet();
  const crewStop = `Crew stopped: The challenge did not start. ${over}`;
  assert.deepEqual(challenge.turns().at(-1), {
    role: 'challenger',
    family: 'anthropic',
    state: 'failed',
    line: `The challenge did not start. ${over}`,
  });
  assert.deepEqual(
    [challenge.run().state, challenge.run().reason, challenge.notices],
    ['failed', crewStop, [{ kind: 'limit', line: crewStop }]],
  );
  assert(!challenge.lines().some((line) => /reached its usage limit/.test(line)));

  // A fix for a slice on Anthropic, after a review on OpenAI found something.
  const fix = turnRun(
    t,
    'schedule',
    { openai: [onePlan, writes, reply('One issue.\nFindings: 1')], anthropic: [] },
    {
      auto: false,
      crew: [
        ['orchestrator', 'openai'],
        ['builder', 'openai'],
        ['reviewer', 'openai'],
        ['fixer', 'anthropic'],
      ],
    },
  );
  await fix.until(() => ended(fix.run().state));
  await fix.quiet();
  assert.deepEqual(fix.turns().at(-1), {
    role: 'fixer',
    family: 'anthropic',
    state: 'failed',
    line: `The fix for slice 1 did not start. ${over}`,
  });

  // The plan's retry. Anthropic passes the limit as the first plan settles, and that plan does
  // not pass validation, so its retry is held back.
  const retry = turnRun(
    t,
    'schedule',
    { anthropic: [reply('```json plan\n{}\n```'), reply('This retry was refused.')] },
    {
      auto: false,
      left: { anthropic: [60, at] },
      settled: (_family, left) => {
        left.anthropic = [14, at];
      },
    },
  );
  await retry.until(() => ended(retry.run().state));
  await retry.quiet();
  assert.deepEqual(
    retry.turns().map(({ state, line }) => [state, line]),
    [
      ['done', null],
      ['failed', `The plan did not start. ${over}`],
    ],
  );

  // The report of a report run, on Anthropic, which passes the limit while the challenge runs on
  // OpenAI. Held back with handoff off, the plan stops with the report's own line.
  const reportCrew: [PlanRecipe['crew']['members'][number]['role'], Family][] = [
    ['orchestrator', 'anthropic'],
    ['builder', 'anthropic'],
    ['challenger', 'openai'],
  ];
  const reportScripts = () => ({
    anthropic: [readPlan, reply('Read it.')],
    openai: [reply('Challenged.\nFindings: 0'), reply('Report.\nFindings: 0')],
  });
  const overOnChallenge = (
    family: ChatFamily,
    left: Record<'openai' | 'anthropic' | 'google', [number, string]>,
  ) => {
    if (family === 'openai') left.anthropic = [14, at];
  };
  const held = turnRun(t, 'schedule', reportScripts(), {
    auto: false,
    shape: 'report',
    crew: reportCrew,
    left: { anthropic: [60, at] },
    settled: overOnChallenge,
  });
  await held.until(() => ended(held.run().state) || held.run().state === 'reported');
  await held.quiet();
  const reportStop = `Plan stopped: The report did not start. ${over}`;
  assert.deepEqual(held.turns().at(-1), {
    role: 'orchestrator',
    family: 'anthropic',
    state: 'failed',
    line: `The report did not start. ${over}`,
  });
  assert.deepEqual(
    [held.run().state, held.run().reason, held.notices],
    ['failed', reportStop, [{ kind: 'limit', line: reportStop }]],
  );
  // With handoff on, the report moves to OpenAI with the schedule's reason and ends the plan as
  // the report, once.
  const handed = turnRun(t, 'schedule', reportScripts(), {
    auto: true,
    shape: 'report',
    crew: reportCrew,
    left: { anthropic: [60, at] },
    settled: overOnChallenge,
  });
  await handed.until(() => handed.run().state === 'reported');
  await handed.quiet();
  assert.deepEqual(handed.turns().slice(-2), [
    {
      role: 'orchestrator',
      family: 'anthropic',
      state: 'failed',
      line: `The report did not start. ${over}`,
    },
    { role: 'orchestrator', family: 'openai', state: 'done', line: null },
  ]);
  assert.deepEqual(handed.lines().slice(-3), [
    `The report did not start. ${over}`,
    moved,
    'Report finished: no finding stands.',
  ]);
  assert.deepEqual(
    [handed.observed.filter((kind) => kind === 'plan-ended').length, handed.notices],
    [1, [{ kind: 'finished', line: 'Report finished: no finding stands.' }]],
  );

  // Anthropic's reading is twenty minutes old. One read brings it back, under the limit.
  const stale = turnRun(
    t,
    'schedule',
    { anthropic: [reply('Nothing to change.')] },
    {
      auto: false,
      refresh: true,
      left: { anthropic: [60, new Date(Date.parse(at) - 20 * 60_000).toISOString()] },
    },
  );
  await stale.until(() => ended(stale.run().state));
  assert.deepEqual(
    [stale.turns(), stale.refreshes],
    [[{ role: 'orchestrator', family: 'anthropic', state: 'done', line: null }], ['anthropic']],
  );

  // Stop while that read runs, with a message sent meanwhile. The step never starts. The
  // person's message runs on the stale reading, since what the person sends is not checked.
  const read = Promise.withResolvers<void>();
  const stopped = turnRun(
    t,
    'schedule',
    { anthropic: [reply('This step was stopped.'), reply('Second.')] },
    {
      auto: false,
      read: read.promise,
      left: { anthropic: [60, new Date(Date.parse(at) - 20 * 60_000).toISOString()] },
    },
  );
  // A usage read is no store event, so the turn's start is given a few turns of the loop.
  for (let n = 0; n < 50 && stopped.refreshes.length === 0; n++) await stopped.quiet();
  assert.deepEqual(stopped.refreshes, ['anthropic']);
  const first = stopped.lastTurnId();
  for (const work of [
    (effects: (() => void)[]) =>
      stopped.chat.stopTurn({ taskId: stopped.task.id, turnId: first }, effects),
    (effects: (() => void)[]) =>
      stopped.chat.sendMessage(
        {
          taskId: stopped.task.id,
          text: 'Another message.',
          role: 'assistant',
          attachments: [],
          files: [],
        },
        effects,
      ),
  ])
    assert.equal(stopped.act(work).outcome, 'applied');
  read.resolve();
  for (
    let n = 0;
    n < 50 && !(stopped.turns().length === 2 && stopped.turns()[1].state !== 'running');
    n++
  )
    await stopped.quiet();
  await stopped.quiet();
  assert.deepEqual(
    [stopped.turns().map(({ state }) => state), stopped.requests('anthropic').length],
    [['stopped', 'done'], 1],
  );

  // A crew on Local runs with no reading at all.
  const local = turnRun(
    t,
    'schedule',
    { local: [reply('Nothing to change.')] },
    {
      auto: false,
      crew: [
        ['orchestrator', 'local'],
        ['builder', 'local'],
      ],
    },
  );
  await local.until(() => ended(local.run().state));
  assert.deepEqual(local.turns(), [
    { role: 'orchestrator', family: 'local', state: 'done', line: null },
  ]);

  const manual = turnRun(t, 'manual', {
    anthropic: [reply('Nothing to change.')],
    openai: [],
    google: [],
  });
  await manual.until(() => manual.run().state === 'no-change');
  assert.deepEqual(manual.turns(), [
    { role: 'orchestrator', family: 'anthropic', state: 'done', line: null },
  ]);
});
