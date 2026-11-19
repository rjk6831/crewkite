import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type PlanSchedule,
  type PlanScheduleNote,
  PlanScheduleNoteSchema,
  PlanScheduleSchema,
  planScheduleLine,
} from '@crewkite/contracts';
import {
  changedLine,
  lastResultCell,
  moreLine,
  nextRunCell,
  type ScheduleItem,
  scheduleActions,
  scheduleLine,
  scheduleRows,
} from './schedules-model.ts';

const mint = (prefix: string, n: number) => `${prefix}_0${String(n).padStart(25, '0')}`;
const at = (minutes: number) =>
  new Date(Date.UTC(2026, 9, 15, 17) + minutes * 60_000).toISOString();
const when = (iso: string) => `at ${iso}`;
const listed = () => true;
const lastRun = {
  id: mint('rrn', 1),
  taskId: mint('tsk', 1),
  state: 'accepted',
  startedAt: at(-120),
  endedAt: at(-90),
} as const;
const schedule = (extra: Partial<PlanSchedule>): PlanSchedule =>
  PlanScheduleSchema.parse({
    recipeId: mint('rcp', 1),
    projectId: mint('prj', 1),
    version: 2,
    versionHash: 'a'.repeat(64),
    state: 'active',
    note: null,
    armedAt: at(-600),
    nextAt: at(60),
    runsStarted: 3,
    maxRuns: 10,
    waiting: 0,
    dryRuns: 0,
    lastRun,
    ...extra,
  });
const item = (n: number, name: string, extra: Partial<PlanSchedule>): ScheduleItem => ({
  schedule: schedule({ recipeId: mint('rcp', n), ...extra }),
  name,
  path: `.crewkite/recipes/r${n}.json`,
  trigger: { kind: 'interval', everyMinutes: 60 },
});

// One note of every code, each newer than the last run's end.
const NOTES: PlanScheduleNote[] = [
  { code: 'run-limit', at: at(-10), runs: 10 },
  { code: 'dry-runs', at: at(-10) },
  { code: 'once-done', at: at(-10) },
  { code: 'checklist-done', at: at(-10), path: 'docs/TODO.md' },
  { code: 'by-person', at: at(-10) },
  { code: 'waiting-limit', at: at(-10), waiting: 3 },
  { code: 'recipe-changed', at: at(-10) },
  { code: 'recipe-missing', at: at(-10) },
  { code: 'recipe-invalid', at: at(-10) },
  { code: 'checklist-unreadable', at: at(-10), path: 'docs/TODO.md' },
  { code: 'start-refused', at: at(-10), reason: 'This project has no commit to start from.' },
  { code: 'run-active', at: at(-10) },
  { code: 'allowance-unknown', at: at(-10), family: 'openai' },
  { code: 'reset-unknown', at: at(-10), family: 'openai' },
  { code: 'allowance-limit', at: at(-10), family: 'openai', used: 81, limit: 80 },
  { code: 'not-connected', at: at(-10), family: 'google' },
  { code: 'model-unknown', at: at(-10), family: 'google' },
  { code: 'terms-pending', at: at(-10), family: 'anthropic' },
  { code: 'missed', at: at(-10), runs: 2 },
];
const SKIP_CODES = [
  'run-active',
  'allowance-unknown',
  'allowance-limit',
  'not-connected',
  'model-unknown',
  'terms-pending',
  'missed',
];

test('each schedule row says when it runs next, what its last run came to and why it paused or stopped', () => {
  const skip = NOTES.find((note) => note.code === 'allowance-limit') as PlanScheduleNote;
  const paused = { code: 'waiting-limit', at: at(-60), waiting: 3 } as const;
  const stopped = { code: 'run-limit', at: at(-80), runs: 10 } as const;
  const unknown = { code: 'allowance-unknown', at: at(-30), family: 'openai' } as const;
  const notConnected = { code: 'not-connected', at: at(-1), family: 'openai' } as const;
  for (const [name, input, next, last, line] of [
    [
      'an active schedule with a finished run',
      schedule({}),
      `at ${at(60)}`,
      ['Accepted', `at ${at(-90)}`],
      null,
    ],
    [
      'a schedule with no run yet',
      schedule({ lastRun: null }),
      `at ${at(60)}`,
      ['None yet', null],
      null,
    ],
    [
      'a run still going reads by its start',
      schedule({ lastRun: { ...lastRun, state: 'running', endedAt: null } }),
      `at ${at(60)}`,
      ['Running', `at ${at(-120)}`],
      null,
    ],
    [
      'a skipped start newer than the last run',
      schedule({ note: skip }),
      `at ${at(60)}`,
      [planScheduleLine(skip), null],
      null,
    ],
    [
      'a skip between the run start and its end gives way to the run',
      schedule({ note: { ...skip, at: at(-100) } }),
      `at ${at(60)}`,
      ['Accepted', `at ${at(-90)}`],
      null,
    ],
    [
      'a skip older than the last run gives way to the run',
      schedule({ note: { ...skip, at: at(-200) } }),
      `at ${at(60)}`,
      ['Accepted', `at ${at(-90)}`],
      null,
    ],
    [
      'a paused schedule that still holds a next start shows none',
      schedule({ state: 'paused', note: paused }),
      '',
      ['Accepted', `at ${at(-90)}`],
      planScheduleLine(paused),
    ],
    [
      'a stopped schedule keeps no next run even if one was stored',
      schedule({ state: 'stopped', note: stopped, runsStarted: 10 }),
      '',
      ['Accepted', `at ${at(-90)}`],
      planScheduleLine(stopped),
    ],
    [
      'a once start that could not happen says so once, under the row',
      schedule({ state: 'stopped', note: notConnected, lastRun: null }),
      '',
      ['None yet', null],
      planScheduleLine(notConnected),
    ],
    [
      'an active reset schedule with no reset reported says why under the row',
      schedule({ nextAt: null, note: unknown }),
      '',
      ['Accepted', `at ${at(-90)}`],
      planScheduleLine(unknown),
    ],
  ] as const) {
    assert.equal(nextRunCell(input, when), next, name);
    const result = lastResultCell(input, when);
    assert.deepEqual([result.text, result.time], last, name);
    assert.equal(scheduleLine(input), line, name);
  }

  // Which notes count as a passed-over start in Last result. The table covers every code.
  assert.deepEqual(
    NOTES.map((note) => note.code).sort(),
    PlanScheduleNoteSchema.options.map((option) => option.shape.code.value).sort(),
  );
  for (const note of NOTES)
    assert.equal(
      lastResultCell(schedule({ note }), when).text,
      SKIP_CODES.includes(note.code) ? planScheduleLine(note) : 'Accepted',
      note.code,
    );

  // The rows of a mixed read: their order, their project, their runs.
  const rows = scheduleRows(
    [
      item(1, 'Alpha', { state: 'stopped', note: stopped, nextAt: null }),
      item(2, 'Zeta', { nextAt: at(30) }),
      item(3, 'Yankee', { nextAt: at(10), projectId: mint('prj', 2) }),
      item(4, 'Bravo', { nextAt: null, note: unknown }),
      item(5, 'Mike', { state: 'paused', note: paused, nextAt: at(5) }),
      item(6, 'Charlie', { state: 'paused', note: paused, nextAt: null }),
      item(7, 'Whiskey', { nextAt: at(10), projectId: mint('prj', 9) }),
      item(8, 'Delta', { state: 'stopped', note: stopped, nextAt: at(1), runsStarted: 10 }),
    ],
    [
      { id: mint('prj', 1), name: 'demo-shop' },
      { id: mint('prj', 2), name: 'billing' },
    ],
    when,
    listed,
  );
  assert.deepEqual(
    rows.map((row) => [row.name, row.project, row.runs]),
    [
      ['Charlie', 'demo-shop', '3 of 10'],
      ['Mike', 'demo-shop', '3 of 10'],
      ['Whiskey', 'Unknown', '3 of 10'],
      ['Yankee', 'billing', '3 of 10'],
      ['Zeta', 'demo-shop', '3 of 10'],
      ['Bravo', 'demo-shop', '3 of 10'],
      ['Alpha', 'demo-shop', '3 of 10'],
      ['Delta', 'demo-shop', '10 of 10'],
    ],
  );

  // What a row says after its action, and the line under a read that held back some rows.
  assert.equal(changedLine('pause', at(5), when), 'Paused.');
  assert.equal(changedLine('resume', at(5), when), `Resumed. Next run at ${at(5)}.`);
  assert.equal(changedLine('restart', at(5), when), `Restarted. Next run at ${at(5)}.`);
  assert.equal(changedLine('restart', null, when), 'Restarted.');
  assert.equal(moreLine(1), '1 more loop is not shown.');
  assert.equal(moreLine(3), '3 more loops are not shown.');
});

test('a row offers only the actions its state allows', () => {
  const note = (code: PlanScheduleNote['code']) =>
    NOTES.find((entry) => entry.code === code) as PlanScheduleNote;
  const gone = mint('tsk', 7);
  const hasThread = (taskId: string) => taskId !== gone;
  for (const [name, input, actions] of [
    ['active', schedule({}), ['pause', 'open-recipe', 'open-last-run']],
    ['active with no run yet', schedule({ lastRun: null }), ['pause', 'open-recipe']],
    [
      'a last run whose thread the app saw deleted',
      schedule({ lastRun: { ...lastRun, taskId: gone } }),
      ['pause', 'open-recipe'],
    ],
    [
      'a last run whose thread the read says is gone',
      schedule({ lastRun: { ...lastRun, thread: false } }),
      ['pause', 'open-recipe'],
    ],
    [
      'a last run whose thread the read says is there',
      schedule({ lastRun: { ...lastRun, thread: true } }),
      ['pause', 'open-recipe', 'open-last-run'],
    ],
    ...(['by-person', 'checklist-unreadable', 'start-refused'] as const).map(
      (code) =>
        [
          `paused, ${code}, lifts on resume`,
          schedule({ state: 'paused', note: note(code) }),
          ['resume', 'open-recipe', 'open-last-run'],
        ] as const,
    ),
    ...(['waiting-limit', 'recipe-changed', 'recipe-missing', 'recipe-invalid'] as const).map(
      (code) =>
        [
          `paused, ${code}, lifts on its own or on a save`,
          schedule({ state: 'paused', note: note(code) }),
          ['open-recipe', 'open-last-run'],
        ] as const,
    ),
    [
      'stopped',
      schedule({ state: 'stopped', note: { code: 'dry-runs', at: at(-5) } }),
      ['restart', 'open-recipe', 'open-last-run'],
    ],
  ] as const)
    assert.deepEqual(scheduleActions(input, hasThread), actions, name);

  // The row carries no thread to open for a run whose thread is gone.
  const [row] = scheduleRows(
    [item(1, 'Gone', { lastRun: { ...lastRun, taskId: gone } })],
    [],
    when,
    hasThread,
  );
  assert.equal(row?.lastRunTask, null);
  assert.equal(row?.lastResult.text, 'Accepted');
});
