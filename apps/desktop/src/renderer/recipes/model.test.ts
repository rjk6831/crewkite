import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PlanRecipe, PlanRecipeSchema } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import {
  type AnswerPlan,
  changeWords,
  type EditorNow,
  offLines,
  planAnswer,
  prepare,
  recipeChanges,
  recipeProblems,
  recipeSteps,
  revertChange,
  saveBody,
  stripCounts,
  tidy,
} from './model.ts';

const member = (role: string, family: string, model = 'model-a') => ({
  role,
  selection: { family, model, effort: 'default' },
});
const base = PlanRecipeSchema.parse({
  schema: 1,
  name: 'Build and review',
  description: '',
  shape: 'change',
  crew: {
    name: 'Crew',
    members: [member('orchestrator', 'anthropic'), member('builder', 'openai')],
  },
  run: {
    flightMode: 'balanced',
    permissionPolicy: 'ask',
    handoff: { auto: false, mode: 'most-left' },
    maxSlices: 4,
  },
  checks: [],
  trigger: { kind: 'manual' },
  budget: null,
  work: null,
});
const withCrew = (roles: string[], extra: Partial<PlanRecipe> = {}): PlanRecipe => ({
  ...base,
  crew: {
    name: 'Crew',
    members: [...base.crew.members, ...roles.map((role) => member(role, 'google'))],
  } as PlanRecipe['crew'],
  ...extra,
});
const interval = { kind: 'interval', everyMinutes: 60 } as const;
// A controller with both switches on, so the contract alone decides.
const ON = { checklistWork: true, reportRuns: true };
const scheduled: PlanRecipe = {
  ...base,
  trigger: interval,
  work: { kind: 'request', text: 'Fix the oldest failing test.' },
  budget: { maxRuns: 5, maxUsedPercent: { openai: 70, anthropic: 80 }, maxWaiting: 3 },
};

test('the steps and the schedule strip say what a run of the recipe does', () => {
  // Claim: the list shows only the steps a run of this recipe reaches, in the runner's order,
  // and the strip counts the runs waiting unless its own line already does.
  for (const [name, recipe, keys] of [
    ['a builder alone', base, ['split', 'build', 'merge', 'resolve', 'end']],
    [
      'checks gate the slice and the merge',
      { ...base, checks: [{ command: 'pnpm test' }] },
      ['split', 'build', 'check', 'merge', 'check-merge', 'resolve', 'end'],
    ],
    [
      'a reviewer brings the fix, a challenger the challenge',
      withCrew(['reviewer', 'challenger']),
      ['split', 'build', 'review', 'fix', 'merge', 'resolve', 'challenge', 'end'],
    ],
    [
      'a report only reads',
      withCrew(['challenger'], { shape: 'report' }),
      ['split', 'read', 'challenge', 'report', 'end-report'],
    ],
  ] as const)
    assert.deepEqual(
      recipeSteps(recipe as PlanRecipe).map((step) => step.key),
      keys,
      name,
    );
  const steps = recipeSteps(withCrew(['reviewer']));
  // With no fixer in the crew the slice's own model fixes, and the row says so.
  assert.equal(steps.find((step) => step.key === 'fix')?.who, "The slice's own model");
  assert.equal(steps[0]?.text, 'Split the request into up to 4 slices.');
  // A cleared slice count has no number worth reading back.
  const cleared = recipeSteps({ ...base, run: { ...base.run, maxSlices: 0 } });
  assert.equal(cleared[0]?.text, 'Split the request into slices.');
  const counts = { runsStarted: 5, maxRuns: 12, waiting: 3 };
  assert.equal(stripCounts({ ...counts, note: null }), '5 of 12 runs started. 3 waiting for you.');
  assert.equal(
    stripCounts({
      ...counts,
      note: { code: 'waiting-limit', at: '2026-10-15T17:00:00.000Z', waiting: 3 },
    }),
    '5 of 12 runs started.',
  );
});

test('the review lists every field that differs, and a revert takes back one line alone', () => {
  // Claim: two versions that hash apart differ in a line the person can read, unless all that
  // differs is the spaces around a command, which a save drops. Revert on a line restores that
  // field and leaves every other change in place.
  const draft: PlanRecipe = {
    ...withCrew(['reviewer']),
    name: 'Build, review',
    run: { ...base.run, flightMode: 'glide', maxSlices: 6 },
    checks: [{ command: 'pnpm test' }],
  };
  assert.deepEqual(recipeChanges(base, draft).map(changeWords), [
    'Name: Build and review to Build, review',
    'Reviewer model: Google model-a (new)',
    'Reviewer effort: default (new)',
    'Reviewer subagents: Provider default (new)',
    'Flight mode: Balanced to Glide',
    'Most slices: 4 to 6',
    'Check: pnpm test (new)',
  ]);
  assert.deepEqual(recipeChanges(base, base), []);
  // Fields the form does not show still get a line, and so does a value that reads like another:
  // the hash covers them.
  for (const [name, other] of [
    ['the crew name', { ...base, crew: { ...base.crew, name: 'Other' } }],
    ['a description that reads as the empty one', { ...base, description: 'None' }],
    [
      'a handoff mode while handoff is off',
      { ...base, run: { ...base.run, handoff: { auto: false, mode: 'local-first' } } },
    ],
    [
      'a subagent switch',
      {
        ...base,
        crew: {
          ...base.crew,
          members: base.crew.members.map((item) => ({ ...item, allowSubagents: true })),
        },
      },
    ],
  ] as const) {
    assert.notEqual(hashCanonical(other), hashCanonical(base), name);
    assert.ok(recipeChanges(base, other as PlanRecipe).length > 0, name);
  }
  // One line back, the rest kept.
  const paths = (recipe: PlanRecipe) => recipeChanges(base, recipe).map((line) => line.path);
  assert.deepEqual(paths(revertChange(base, draft, 'run.maxSlices')), [
    'name',
    'crew.reviewer.model',
    'crew.reviewer.effort',
    'crew.reviewer.subagents',
    'run.flightMode',
    'checks.pnpm test',
  ]);
  assert.deepEqual(paths(revertChange(base, draft, 'crew.reviewer.model')), [
    'name',
    'run.flightMode',
    'run.maxSlices',
    'checks.pnpm test',
  ]);
  const limits: PlanRecipe = {
    ...scheduled,
    budget: { maxRuns: 9, maxUsedPercent: { openai: 50, anthropic: 80 }, maxWaiting: 3 },
  };
  assert.deepEqual(
    recipeChanges(scheduled, revertChange(scheduled, limits, 'budget.maxRuns')).map(
      (line) => line.path,
    ),
    ['budget.maxUsedPercent.openai'],
  );
  // Half a schedule does not validate, so a manual recipe gets all of it back at once.
  assert.deepEqual(recipeChanges(base, revertChange(base, scheduled, 'budget.maxRuns')), []);
  // Checks run in list order, so the same commands in another order are a change with its own
  // line, and a removed check comes back at its saved place, leaving no order change behind.
  const [test, lint, build] = ['pnpm test', 'pnpm lint', 'pnpm build'].map((command) => ({
    command,
  }));
  const three: PlanRecipe = { ...base, checks: [test, lint, build] as PlanRecipe['checks'] };
  const swapped: PlanRecipe = { ...three, checks: [lint, test, build] as PlanRecipe['checks'] };
  assert.deepEqual(recipeChanges(three, swapped).map(changeWords), [
    'Check order: pnpm test, pnpm lint, pnpm build to pnpm lint, pnpm test, pnpm build',
  ]);
  assert.deepEqual(revertChange(three, swapped, 'check-order').checks, three.checks);
  const removed: PlanRecipe = { ...three, checks: [test, build] as PlanRecipe['checks'] };
  assert.deepEqual(revertChange(three, removed, 'checks.pnpm lint').checks, three.checks);
  // The order line reads only the checks both versions hold, whatever was added or removed
  // around them, and its revert moves only those. A removed check comes back without moving
  // the others.
  const e2e = { command: 'pnpm e2e' };
  const around: PlanRecipe = { ...three, checks: [lint, e2e, test] as PlanRecipe['checks'] };
  assert.deepEqual(recipeChanges(three, around).map(changeWords), [
    'Check: pnpm e2e (new)',
    'Check order: pnpm test, pnpm lint to pnpm lint, pnpm test',
    'Check: pnpm build (removed)',
  ]);
  const commandsOf = (recipe: PlanRecipe) => recipe.checks.map((check) => check.command);
  assert.deepEqual(commandsOf(revertChange(three, around, 'check-order')), [
    'pnpm test',
    'pnpm e2e',
    'pnpm lint',
  ]);
  assert.deepEqual(commandsOf(revertChange(three, around, 'checks.pnpm build')), [
    'pnpm lint',
    'pnpm e2e',
    'pnpm test',
    'pnpm build',
  ]);
  // A command saved with stray spaces reads as the same command, and the Revert of its line
  // brings that row back.
  const padded: PlanRecipe = { ...base, checks: [{ command: ' pnpm test ' }] };
  const plusLint: PlanRecipe = { ...padded, checks: [...padded.checks, lint] };
  assert.deepEqual(recipeChanges(padded, prepare(plusLint, false)).map(changeWords), [
    'Check: pnpm lint (new)',
  ]);
  const dropped: PlanRecipe = { ...padded, checks: [] };
  const [line] = recipeChanges(padded, dropped);
  assert.equal(line && changeWords(line), 'Check: pnpm test (removed)');
  assert.deepEqual(revertChange(padded, dropped, line?.path ?? '').checks, [
    { command: 'pnpm test' },
  ]);
  // Members come back to their saved places in whichever order they are reverted, and the order
  // of the members both versions hold gets a line of its own.
  const crew = withCrew(['reviewer', 'fixer', 'challenger']);
  const roleOrder = (recipe: PlanRecipe) => recipe.crew.members.map((item) => item.role);
  const thinned: PlanRecipe = {
    ...crew,
    crew: {
      ...crew.crew,
      members: crew.crew.members.filter((item) => !['reviewer', 'fixer'].includes(item.role)),
    },
  };
  for (const order of [
    ['crew.reviewer.model', 'crew.fixer.model'],
    ['crew.fixer.model', 'crew.reviewer.model'],
  ])
    assert.deepEqual(
      roleOrder(order.reduce((next, path) => revertChange(crew, next, path), thinned)),
      roleOrder(crew),
      order.join(' then '),
    );
  const swappedCrew: PlanRecipe = {
    ...base,
    crew: { ...base.crew, members: [...base.crew.members].reverse() },
  };
  assert.deepEqual(recipeChanges(base, swappedCrew).map(changeWords), [
    'Crew order: Orchestrator, Builder to Builder, Orchestrator',
  ]);
  assert.deepEqual(roleOrder(revertChange(base, swappedCrew, 'crew-order')), roleOrder(base));
  // The crew order line reverts the order of the members both hold, and only that: a member the
  // draft added stays, and one it removed stays removed.
  const reshaped: PlanRecipe = {
    ...crew,
    crew: {
      ...crew.crew,
      members: [
        ...crew.crew.members.filter((item) => item.role === 'builder'),
        ...crew.crew.members.filter((item) => item.role === 'orchestrator'),
        ...crew.crew.members.filter((item) => item.role === 'challenger'),
      ],
    },
  };
  const withReviewer = { ...crew, crew: { ...crew.crew, members: crew.crew.members.slice(0, 3) } };
  assert.deepEqual(roleOrder(revertChange(withReviewer, reshaped, 'crew-order')), [
    'orchestrator',
    'builder',
    'challenger',
  ]);
  // The runs waiting before a schedule pauses get their own line.
  const waiting = { ...scheduled, budget: { ...scheduled.budget, maxWaiting: 5 } } as PlanRecipe;
  assert.deepEqual(recipeChanges(scheduled, waiting).map(changeWords), [
    'Most runs waiting for you: 3 to 5',
  ]);
  // Two start times in the same minute read alike and still get a line.
  const minute = (iso: string) => iso.slice(0, 16);
  const once = (at: string): PlanRecipe => ({ ...scheduled, trigger: { kind: 'once', at } });
  assert.equal(
    recipeChanges(
      once('2026-12-01T09:00:00.000Z'),
      once('2026-12-01T09:00:30.000Z'),
      undefined,
      minute,
    ).length,
    1,
  );
  // A name saved with stray spaces reads as the same name, and a Revert of its line acts.
  const paddedName: PlanRecipe = { ...base, name: ' Build and review ' };
  assert.deepEqual(recipeChanges(paddedName, prepare(paddedName, false)), []);
  const renamed: PlanRecipe = { ...paddedName, name: 'Builder' };
  assert.deepEqual(recipeChanges(paddedName, renamed).map(changeWords), [
    'Name: Build and review to Builder',
  ]);
  assert.deepEqual(
    recipeChanges(paddedName, prepare(revertChange(paddedName, renamed, 'name'), false)),
    [],
  );
  // A check the draft added with stray spaces goes on the Revert of its line.
  const addedPadded: PlanRecipe = { ...base, checks: [{ command: ' pnpm build ' }] };
  assert.deepEqual(revertChange(base, addedPadded, 'checks.pnpm build').checks, []);
});

test('a draft shows a problem line exactly when the contract refuses it', () => {
  // Claim: every rule the contract refuses has a line under its field, and a draft with no line
  // passes the contract, so nothing reaches the person as a raw schema error.
  for (const [name, recipe, expected] of [
    ['a valid manual recipe', base, []],
    ['a valid schedule', scheduled, []],
    ['no name', { ...base, name: ' ' }, ['A recipe needs a name.']],
    ['a tab in the name', { ...base, name: 'Build\tand review' }, ['A name is one line.']],
    ['tabs and line breaks in a description', { ...base, description: 'One\n\ttwo\r\n' }, []],
    [
      'any other control character in a description',
      { ...base, description: 'Exit code\u0007' },
      ['A description cannot hold control characters.'],
    ],
    ['a report with no challenger', { ...base, shape: 'report' }, ['A report needs a challenger.']],
    [
      'a report that takes its work from a checklist',
      {
        ...scheduled,
        crew: withCrew(['challenger']).crew,
        shape: 'report',
        work: { kind: 'checklist', path: 'docs/TODO.md' },
        budget: { ...scheduled.budget, maxUsedPercent: { openai: 70, anthropic: 80, google: 75 } },
      },
      ['A report run takes a fixed request.'],
    ],
    [
      'a check typed twice',
      { ...base, checks: [{ command: 'pnpm test' }, { command: 'pnpm test' }] },
      ['This command is already in the list.'],
    ],
    [
      'a tab in a command',
      { ...base, checks: [{ command: 'pnpm\ttest' }] },
      ['A command is one line.'],
    ],
    ['nine slices', { ...base, run: { ...base.run, maxSlices: 9 } }, ['Between 1 and 8.']],
    [
      // The run limit and each provider's limit start empty. The person states them.
      'a schedule with nothing stated yet',
      {
        ...base,
        trigger: interval,
        work: { kind: 'request', text: '' },
        budget: { maxRuns: 0, maxUsedPercent: {}, maxWaiting: 3 },
      },
      [
        'A loop needs its work.',
        'A loop needs a run limit.',
        'Set a limit for OpenAI.',
        'Set a limit for Anthropic.',
      ],
    ],
    [
      'automatic handoff needs a limit for every metered provider',
      { ...scheduled, run: { ...base.run, handoff: { auto: true, mode: 'most-left' } } },
      ['Set a limit for Google.'],
    ],
    [
      'an interval under fifteen minutes',
      { ...scheduled, trigger: { kind: 'interval', everyMinutes: 5 } },
      ['At least 15 minutes.'],
    ],
    [
      'an interval over seven days',
      { ...scheduled, trigger: { kind: 'interval', everyMinutes: 8 * 1440 } },
      ['At most 7 days.'],
    ],
    [
      'a fixed request over several lines',
      { ...scheduled, work: { kind: 'request', text: 'Fix it.\n\tThen test.' } },
      [],
    ],
    [
      'a control character in a fixed request',
      { ...scheduled, work: { kind: 'request', text: 'Fix it\u001b[0m' } },
      ['A request cannot hold control characters.'],
    ],
    [
      'as many runs as a schedule takes',
      { ...scheduled, budget: { ...scheduled.budget, maxRuns: 1000 } },
      [],
    ],
    [
      'more runs than a schedule takes',
      { ...scheduled, budget: { ...scheduled.budget, maxRuns: 1001 } },
      ['Between 1 and 1000.'],
    ],
    [
      'a checklist outside the project',
      { ...scheduled, work: { kind: 'checklist', path: '../TODO.md' } },
      ['A path inside the project.'],
    ],
  ] as const) {
    // The page checks the draft with stray spaces gone, and the save drops empty check rows.
    assert.deepEqual(
      recipeProblems(tidy(recipe as PlanRecipe), ON).map((problem) => problem.text),
      expected,
      name,
    );
    const saved = prepare(recipe as PlanRecipe, false);
    assert.equal(PlanRecipeSchema.safeParse(saved).success, expected.length === 0, name);
  }
  assert.deepEqual(
    recipeProblems(base, ON, '/etc/recipe.json').map((problem) => problem.field),
    ['path'],
  );
  // An empty row keeps its place and has no line, so the line lands under the row it is about.
  const rows = {
    ...base,
    checks: [{ command: 'pnpm test' }, { command: ' ' }, { command: 'a\tb' }],
  };
  assert.deepEqual(recipeProblems(tidy(rows), ON), [
    { field: 'checks.2', text: 'A command is one line.' },
  ]);
});

test('a choice the controller switched off shows its line, holds the save and the run, and comes back when switched on', () => {
  // Claim: while an option is off the editor names that choice as unavailable and never sends a
  // save or run the controller refuses, and the same draft is offered again once the option is on.
  const checklist: PlanRecipe = { ...scheduled, work: { kind: 'checklist', path: 'TODO.md' } };
  const report = withCrew(['challenger'], { shape: 'report' });
  const off = { checklistWork: false, reportRuns: false };
  const checklistLine = 'Checklist work is not available in this version.';
  const reportLine = 'Report only runs are not available in this version.';
  // Each row: the lines under Run type and Work, the line that keeps Run off, the save's problems.
  for (const [name, recipe, available, lines, problems] of [
    ['both off, nothing picked', scheduled, off, [reportLine, checklistLine, null], []],
    [
      'a checklist loop while checklist work is off',
      checklist,
      off,
      [reportLine, `${checklistLine} Give the loop a fixed request.`, null],
      [`${checklistLine} Give the loop a fixed request.`],
    ],
    [
      'a report while report runs are off',
      report,
      off,
      [`${reportLine} Set Run type to Changes files.`, checklistLine, reportLine],
      [`${reportLine} Set Run type to Changes files.`],
    ],
    ['a checklist loop with the switch on', checklist, ON, [null, null, null], []],
    ['a report with the switch on', report, ON, [null, null, null], []],
  ] as const) {
    const shown = offLines(recipe, available);
    assert.deepEqual([shown.shape, shown.work, shown.run], lines, name);
    assert.deepEqual(
      recipeProblems(tidy(recipe), available).map((problem) => problem.text),
      problems,
      name,
    );
  }
});

test("a file's own version is saved as read, and only a form draft is tidied", () => {
  // Claim: the controller records a file's version only when the body hashes like the file, so
  // the body a save sends for it is the file untouched, and only while the editor's state says
  // the form shows that very file. A draft from the form loses stray spaces and empty check rows,
  // and only a recipe never saved takes its name as its crew's name.
  const file: PlanRecipe = {
    ...base,
    crew: { ...base.crew, name: 'A crew named by hand' },
    checks: [{ command: ' pnpm test ' }],
  };
  // A file CrewKite never saved: its own version keeps its crew name and its padded command.
  const shown = { draft: structuredClone(file), showsFile: true, fresh: true };
  const read = { file: 'unrecorded', recipe: file } as const;
  assert.equal(hashCanonical(saveBody({ ...shown, read })), hashCanonical(file));
  // A flag that does not match the file makes the body a form draft.
  const tidied = hashCanonical(prepare(file, true));
  for (const [name, state] of [
    ['the file reads as saved', { ...shown, read: { file: 'current', recipe: file } }],
    [
      'the file moved since',
      { ...shown, read: { ...read, recipe: { ...file, description: 'x' } } },
    ],
    ['the form shows a draft', { ...shown, read, showsFile: false }],
  ] as const)
    assert.equal(hashCanonical(saveBody(state)), tidied, name);
  const typed: PlanRecipe = {
    ...file,
    name: '  Build and review ',
    checks: [{ command: ' pnpm test ' }, { command: '  ' }],
  };
  const draft = { draft: typed, read: null, showsFile: false };
  assert.deepEqual(saveBody({ ...draft, fresh: false }), {
    ...file,
    checks: [{ command: 'pnpm test' }],
  });
  assert.equal(saveBody({ ...draft, fresh: true }).crew.name, 'Build and review');
});

test('the refresh rule decides an answer by what the editor holds when it lands', () => {
  // Claim: whatever the editor holds when an answer lands, a busy step holds the answer, edits
  // are kept and only measured against a newer version, and an untouched form takes the answer,
  // closing a review or run that was open against a version that moved and saying so.
  const panels = [null, 'review', 'run', 'forget'] as const;
  const flags = [false, true];
  let walked = 0;
  for (const busy of flags)
    for (const touched of flags)
      for (const panel of panels)
        for (const older of flags)
          for (const showsFile of flags)
            for (const moved of flags)
              for (const fileVersion of flags) {
                const now: EditorNow = { busy, touched, panel, older, showsFile, version: 4 };
                const version = moved ? 5 : 4;
                const expected: AnswerPlan = busy
                  ? { act: 'hold' }
                  : touched
                    ? moved
                      ? { act: 'rebase', stale: 5 }
                      : { act: 'read' }
                    : {
                        act: 'adopt',
                        closePanel: moved && (panel === 'review' || panel === 'run'),
                        keepFile: showsFile && !moved && fileVersion,
                        said: moved ? 5 : null,
                      };
                const name = JSON.stringify({ ...now, moved, fileVersion });
                assert.deepEqual(planAnswer(now, { version, fileVersion }), expected, name);
                walked += 1;
              }
  assert.equal(walked, 256);
});
