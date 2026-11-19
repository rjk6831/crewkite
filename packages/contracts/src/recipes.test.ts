import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashCanonical } from './hash.ts';
import {
  PlanRecipeSchema,
  type PlanScheduleNote,
  PlanScheduleNoteSchema,
  planScheduleLine,
} from './recipes.ts';

const member = (role: string, family: string) => ({
  role,
  selection: { family, model: 'model-a', effort: 'default' },
  allowSubagents: false,
});
const manual = {
  schema: 1,
  name: 'Build and review',
  description: '',
  shape: 'change',
  crew: {
    name: 'Two providers',
    members: [
      member('orchestrator', 'anthropic'),
      member('builder', 'openai'),
      member('fixer', 'local'),
    ],
  },
  run: {
    flightMode: 'balanced',
    permissionPolicy: 'ask',
    handoff: { auto: false, mode: 'most-left' },
    maxSlices: 4,
  },
  checks: [{ command: 'pnpm test' }],
  trigger: { kind: 'manual' },
  budget: null,
  work: null,
};
const interval = { kind: 'interval', everyMinutes: 60 };
const budget = { maxRuns: 5, maxUsedPercent: { anthropic: 80, openai: 70 }, maxWaiting: 3 };
const work = { kind: 'request', text: 'Fix the oldest failing test.' };
const scheduled = { ...manual, trigger: interval, budget, work };

test('a schedule needs a budget, its work and a limit for every metered provider a run can reach, and a manual recipe holds neither', () => {
  for (const [name, recipe, valid] of [
    ['a manual recipe with no budget and no work', manual, true],
    ['a schedule with budget and work', scheduled, true],
    ['a schedule with no budget', { ...scheduled, budget: null }, false],
    ['a schedule with no work', { ...scheduled, work: null }, false],
    ['a manual recipe that carries a budget', { ...manual, budget }, false],
    ['a manual recipe that carries work', { ...manual, work }, false],
    [
      // Local has no metered allowance, so only the two metered providers need a limit.
      'a budget that leaves out a metered provider the crew names',
      { ...scheduled, budget: { ...budget, maxUsedPercent: { openai: 70 } } },
      false,
    ],
    [
      // A handoff can move a step to Google, which this budget sets no limit for.
      'automatic handoff with a limit missing for a provider outside the crew',
      { ...scheduled, run: { ...manual.run, handoff: { auto: true, mode: 'most-left' } } },
      false,
    ],
    [
      'automatic handoff with a limit for every metered provider',
      {
        ...scheduled,
        run: { ...manual.run, handoff: { auto: true, mode: 'most-left' } },
        budget: { ...budget, maxUsedPercent: { anthropic: 80, openai: 70, google: 60 } },
      },
      true,
    ],
    [
      'a crew with no orchestrator',
      { ...manual, crew: { name: 'Solo', members: [member('builder', 'openai')] } },
      false,
    ],
    // Manual flight mode runs no plan, so the crew, the checks and the slice limit would be ignored.
    ['manual flight mode', { ...manual, run: { ...manual.run, flightMode: 'manual' } }, false],
    ['a report with no challenger', { ...manual, shape: 'report' }, false],
    [
      'the same check command twice',
      { ...manual, checks: [{ command: 'pnpm test' }, { command: 'pnpm test' }] },
      false,
    ],
  ] as const)
    assert.equal(PlanRecipeSchema.safeParse(recipe).success, valid, name);
});

test('a recipe written to disk and read back keeps its hash, and the hash is over the parsed value', () => {
  // Parsing fills the effort and the waiting limit when the file leaves them out. A hash over the
  // file's own text would then differ from the record's, and the file would read as changed.
  const sparse = {
    ...scheduled,
    crew: {
      name: 'Two providers',
      members: scheduled.crew.members.map((entry) => ({
        ...entry,
        selection: { family: entry.selection.family, model: entry.selection.model },
      })),
    },
    budget: { maxRuns: 5, maxUsedPercent: budget.maxUsedPercent },
  };
  const parsed = PlanRecipeSchema.parse(sparse);
  const reread = PlanRecipeSchema.parse(JSON.parse(JSON.stringify(parsed, null, 2)));
  assert.equal(hashCanonical(reread), hashCanonical(parsed));
  assert.equal(hashCanonical(parsed), hashCanonical(PlanRecipeSchema.parse(scheduled)));
  assert.notEqual(hashCanonical(sparse), hashCanonical(parsed));
});

test('every schedule note reads as one plain line', () => {
  const at = '2026-11-18T08:00:00.000Z';
  const notes: PlanScheduleNote[] = [
    { code: 'run-limit', at, runs: 5 },
    { code: 'dry-runs', at },
    { code: 'once-done', at },
    { code: 'checklist-done', at, path: 'TODO.md' },
    { code: 'by-person', at },
    { code: 'waiting-limit', at, waiting: 1 },
    { code: 'waiting-limit', at, waiting: 3 },
    { code: 'recipe-changed', at },
    { code: 'recipe-missing', at },
    { code: 'recipe-invalid', at },
    { code: 'checklist-unreadable', at, path: 'TODO.md' },
    { code: 'start-refused', at, reason: 'This project has no commit yet.' },
    { code: 'run-active', at },
    { code: 'allowance-unknown', at, family: 'anthropic' },
    { code: 'reset-unknown', at, family: 'anthropic' },
    { code: 'allowance-limit', at, family: 'openai', used: 86, limit: 80 },
    { code: 'not-connected', at, family: 'local' },
    { code: 'model-unknown', at, family: 'openai' },
    { code: 'terms-pending', at, family: 'google' },
    { code: 'missed', at, runs: 1 },
    { code: 'missed', at, runs: 4 },
  ];
  // A code added to the contract with no sample here would ship a line nobody read.
  assert.deepEqual(
    [...new Set(notes.map((note) => note.code))].sort(),
    PlanScheduleNoteSchema.options.map((option) => option.shape.code.value).sort(),
  );
  for (const note of notes) {
    const line = planScheduleLine(PlanScheduleNoteSchema.parse(note));
    assert.match(line, /^[A-Z][^\n]*\.$/, note.code);
    assert.doesNotMatch(line, /undefined|\$\{/, note.code);
  }
  assert.equal(
    planScheduleLine({ code: 'waiting-limit', at, waiting: 1 }),
    'Paused. 1 run is waiting for you.',
  );
  assert.equal(
    planScheduleLine({ code: 'allowance-limit', at, family: 'openai', used: 86, limit: 80 }),
    'Did not start. OpenAI is at 86% used. The limit for this loop is 80%.',
  );
});
