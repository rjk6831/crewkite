import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { type PlanRecipe, type PlanRecipeTrigger, PlanScheduleSchema } from '@crewkite/contracts';
import { createTestIds } from '../../../../packages/testkit/src/index.ts';
import { createSyntheticRepository } from '../../../../packages/testkit/src/repository.ts';
import type { ControllerOptions } from '../../../controller/src/commands/controller.ts';
import { installedTools } from '../../../controller/src/store/controller-fixture.ts';
import { runCli } from '../main.ts';
import { startScriptedController } from '../scripted-controller.ts';
import { connectChat } from './connect.ts';
import { scheduleListText } from './schedules.ts';
import type { Connect } from './scripting.ts';

function capture() {
  const seen = { out: '', err: '' };
  return {
    seen,
    output: {
      out: (text: string) => {
        seen.out += text;
      },
      err: (text: string) => {
        seen.err += text;
      },
    },
  };
}

const pick = { family: 'anthropic', model: 'model-b', effort: 'default' } as const;
const recipe = (name: string, trigger: PlanRecipeTrigger): PlanRecipe => ({
  schema: 1,
  name,
  description: '',
  shape: 'change',
  crew: {
    name: 'Pair',
    members: [
      { role: 'orchestrator', selection: pick },
      { role: 'builder', selection: pick },
    ],
  },
  run: {
    flightMode: 'glide',
    permissionPolicy: 'allow-edits',
    handoff: { auto: false, mode: 'most-left' },
    maxSlices: 3,
  },
  checks: [],
  trigger,
  budget:
    trigger.kind === 'manual'
      ? null
      : { maxRuns: 3, maxUsedPercent: { anthropic: 80 }, maxWaiting: 3 },
  work: trigger.kind === 'manual' ? null : { kind: 'request', text: 'Tidy the module.' },
});

/**
 * A scripted controller whose schedule timers only record, so no run can start. The clock is
 * fixed and no test fires a timer.
 */
async function open(t: TestContext) {
  // Only git on PATH, so nothing can find gh or a provider client.
  const tools = mkdtempSync(join(tmpdir(), 'ck-cli-schedules-'));
  const saved = process.env.PATH;
  process.env.PATH = installedTools(tools, 'git');
  t.after(() => {
    process.env.PATH = saved;
    rmSync(tools, { recursive: true, force: true });
  });
  // The scripted controller's own type names one option, but it passes every option on.
  const options: Partial<ControllerOptions> = {
    now: () => '2026-03-02T10:00:00.000Z',
    // Nothing fires: a start can only come from a timer.
    scheduleStarts: () => () => {},
  };
  const started = await startScriptedController(t, [], options);
  const { home, repository, controller, directory } = started;
  const run = async (...args: string[]) => {
    const { seen, output } = capture();
    const code = await runCli([...args, '--home', home], output);
    return { code, ...seen };
  };
  const added = await run('project', 'add', repository);
  const project = /Project (prj_[0-9A-Z]{26})/.exec(added.out)?.[1] ?? '';
  assert.ok(project);
  const ids = createTestIds(new Date(0).toISOString());
  const save = async (path: string, body: PlanRecipe, projectId = project) => {
    const result = await controller.execute(
      {
        protocol: 1,
        key: ids('cmd'),
        actor: { id: 'terminal', kind: 'cli' },
        command: 'SaveRecipe',
        payload: { projectId, path, body, expectedVersion: 0, confirm: 'explicit' },
        expectedRevision: 0,
      },
      'local-owner',
    );
    assert.equal(result.outcome, 'applied', JSON.stringify(result));
    return result.data?.kind === 'recipe-saved' ? result.data.record.id : '';
  };
  // A second registered project, for rows that must be told apart across projects.
  const second = async () => {
    const other = createSyntheticRepository(join(directory, 'shop-two')).directory;
    const added = await run('project', 'add', other);
    return /Project (prj_[0-9A-Z]{26})/.exec(added.out)?.[1] ?? '';
  };
  return { run, project, save, controller, second, repository, home };
}

const everyDay: PlanRecipeTrigger = { kind: 'interval', everyMinutes: 1440 };

test('loop list prints each loop with its next run and says why one paused or stopped', {
  timeout: 60_000,
}, async (t) => {
  const { run, project, save, controller, second, repository } = await open(t);

  const none = await run('loop', 'list', '--project', project);
  assert.deepEqual([none.code, none.out], [0, 'No loops.\nLoops run while CrewKite is open.\n']);

  await save('.crewkite/recipes/a-daily.json', recipe('Daily', everyDay));
  await save('.crewkite/recipes/b-paused.json', recipe('Paused one', everyDay));
  const limitedId = await save('.crewkite/recipes/c-limited.json', recipe('Limited', everyDay));
  const resetId = await save(
    '.crewkite/recipes/c-reset.json',
    recipe('On reset', { kind: 'reset', family: 'anthropic' }),
  );
  await save('.crewkite/recipes/d-manual.json', recipe('By hand', { kind: 'manual' }));
  assert.equal((await run('loop', 'pause', 'Paused one')).code, 0);
  // No reading has given the reset a time yet, so the schedule is active with no next run.
  const waiting = controller.store.recipeSchedule(resetId);
  assert.ok(waiting);
  controller.store.transaction(() =>
    controller.store.putRecipeSchedule(
      {
        ...waiting,
        nextAt: null,
        note: { code: 'allowance-unknown', at: '2026-03-02T09:00:00.000Z', family: 'anthropic' },
      },
      '2026-03-02T10:00:00.000Z',
    ),
  );
  // A run limit stops a schedule only after a run starts, and a test starts none.
  const stored = controller.store.recipeSchedule(limitedId);
  assert.ok(stored);
  controller.store.transaction(() =>
    controller.store.putRecipeSchedule(
      {
        ...stored,
        state: 'stopped',
        nextAt: null,
        runsStarted: 3,
        // The third run started, ended and stopped the loop, so the row has a last run.
        lastRun: {
          id: `rrn_${'0'.repeat(25)}1`,
          taskId: `tsk_${'0'.repeat(25)}1`,
          state: 'accepted',
          startedAt: '2026-03-02T08:00:00.000Z',
          endedAt: '2026-03-02T08:30:00.000Z',
        },
        note: { code: 'run-limit', at: '2026-03-02T08:00:00.000Z', runs: 3 },
      },
      '2026-03-02T10:00:00.000Z',
    ),
  );

  const listed = await run('loop', 'list');
  assert.equal(listed.code, 0);
  assert.equal(
    listed.out,
    [
      'RECIPE      STATE    NEXT                  LAST                           RUNS',
      'Daily       Active   2026-03-03 10:00 UTC  None yet                       0',
      'Paused one  Paused                         None yet                       0',
      '  Paused by you.',
      'Limited     Stopped                        Accepted 2026-03-02 08:30 UTC  3',
      '  Stopped. The run limit of 3 is reached.',
      'On reset    Active                         None yet                       0',
      '  Did not start. CrewKite has no current allowance reading for Anthropic.',
      'Loops run while CrewKite is open.',
      '',
    ].join('\n'),
  );

  // A list takes no recipe.
  const withRecipe = await run('loop', 'list', 'Daily');
  assert.deepEqual(
    [withRecipe.code, withRecipe.out, withRecipe.err],
    [2, '', 'Loop list takes no recipe.\n'],
  );

  // The same recipe in two projects: the list gains a PROJECT column with each project's name,
  // and a name that matches in both asks for --project, which then picks one.
  const other = await second();
  await save('.crewkite/recipes/a-daily.json', recipe('Daily', everyDay), other);
  const across = await run('loop', 'list');
  const rows = across.out.split('\n');
  assert.match(rows[0], /^RECIPE\s+PROJECT\s+STATE\s+NEXT\s+LAST\s+RUNS$/);
  assert.equal(rows.filter((row) => /^Daily\s+shop(-two)?\s+Active/.test(row)).length, 2);
  const oneProject = await run('loop', 'list', '--project', other);
  assert.match(oneProject.out.split('\n')[0], /^RECIPE\s+STATE\s+NEXT\s+LAST\s+RUNS$/);
  const both = 'More than one project has a recipe that matches "Daily". Add --project.\n';
  for (const args of [
    ['loop', 'pause', 'Daily'],
    ['loop', 'resume', 'Daily'],
    ['loop', 'restart', 'Daily'],
    ['recipe', 'show', 'Daily'],
    ['recipe', 'run', 'Daily', 'Go.'],
    ['results', '--recipe', 'Daily'],
  ]) {
    const refused = await run(...args);
    assert.deepEqual([refused.code, refused.out, refused.err], [2, '', both], args.join(' '));
  }
  // --project picks the project: the pause lands there and only there.
  assert.equal((await run('loop', 'pause', 'Daily', '--project', other)).out, 'Paused.\n');
  const afterPause = (await run('loop', 'list')).out;
  assert.match(afterPause, /^Daily\s+shop-two\s+Paused/m);
  assert.match(afterPause, /^Daily\s+shop\s+Active/m);

  // A file on disk that CrewKite never saved has no loop to change.
  writeFileSync(
    join(repository, '.crewkite/recipes/unsaved.json'),
    JSON.stringify(recipe('Unsaved', everyDay)),
  );
  const unsaved = await run(
    'loop',
    'pause',
    '.crewkite/recipes/unsaved.json',
    '--project',
    project,
  );
  assert.deepEqual(
    [unsaved.code, unsaved.out, unsaved.err],
    [2, '', 'That recipe is not saved here.\n'],
  );
});

test('loop pause, resume and restart change the loop and print what happened', {
  timeout: 60_000,
}, async (t) => {
  const { run, save, controller, home } = await open(t);
  const daily = await save('.crewkite/recipes/daily.json', recipe('Daily', everyDay));
  await save('.crewkite/recipes/hand.json', recipe('By hand', { kind: 'manual' }));

  const said = async (...args: string[]) => {
    const result = await run('loop', ...args);
    return [result.code, result.out, result.err];
  };
  assert.deepEqual(await said('pause', 'Daily'), [0, 'Paused.\n', '']);
  assert.deepEqual(await said('resume', 'Daily'), [
    0,
    'Resumed. Next run 2026-03-03 10:00 UTC.\n',
    '',
  ]);

  // Resume on a schedule that is not paused, and a recipe with no schedule.
  assert.deepEqual(await said('resume', 'Daily'), [2, '', 'This loop is not paused.\n']);
  assert.deepEqual(await said('pause', 'By hand'), [2, '', 'This recipe has no loop.\n']);
  assert.deepEqual(await said('restart', 'Daily'), [2, '', 'This loop is not stopped.\n']);

  const stored = controller.store.recipeSchedule(daily);
  assert.ok(stored);
  controller.store.transaction(() =>
    controller.store.putRecipeSchedule(
      {
        ...stored,
        state: 'stopped',
        nextAt: null,
        runsStarted: 3,
        note: { code: 'run-limit', at: '2026-03-02T09:00:00.000Z', runs: 3 },
      },
      '2026-03-02T10:00:00.000Z',
    ),
  );
  assert.deepEqual(await said('restart', 'Daily'), [
    0,
    'Restarted. Next run 2026-03-03 10:00 UTC.\n',
    '',
  ]);
  assert.equal(controller.store.recipeSchedule(daily)?.runsStarted, 0);

  const asJson = await run('loop', 'pause', 'Daily', '--json');
  const line = JSON.parse(asJson.out);
  assert.deepEqual(
    [asJson.code, line.kind, line.command, line.outcome],
    [0, 'result', 'SetRecipeSchedule', 'applied'],
  );
  assert.equal(controller.store.recipeSchedule(daily)?.state, 'paused');

  // The change went through and the read after it fails: the line loses its second sentence and
  // the command still succeeds.
  const flaky: Connect = async (where) => {
    const client = await connectChat(where);
    return {
      ...client,
      send: (command, payload) =>
        command === 'ReadSchedules'
          ? Promise.reject(new Error('The read failed.'))
          : client.send(command, payload),
    };
  };
  const seen = { out: '', err: '' };
  const code = await runCli(
    ['loop', 'resume', 'Daily', '--home', home],
    {
      out: (text) => {
        seen.out += text;
      },
      err: (text) => {
        seen.err += text;
      },
    },
    flaky,
  );
  assert.deepEqual([code, seen.out, seen.err], [0, 'Resumed.\n', '']);
  assert.equal(controller.store.recipeSchedule(daily)?.state, 'active');
});

test('a loop list says how many more loops are not shown', () => {
  const schedule = PlanScheduleSchema.parse({
    recipeId: `rcp_${'0'.repeat(25)}1`,
    projectId: `prj_${'0'.repeat(25)}1`,
    version: 1,
    versionHash: 'a'.repeat(64),
    state: 'active',
    note: null,
    armedAt: '2026-03-02T08:00:00.000Z',
    nextAt: '2026-03-03T10:00:00.000Z',
    runsStarted: 0,
    maxRuns: 3,
    waiting: 0,
    dryRuns: 0,
    lastRun: null,
  });
  const read = (more: number) => ({
    schedules: [{ schedule, name: 'Daily', path: 'd.json', trigger: everyDay }],
    more,
  });
  // The more line sits before the closing line, with its singular.
  for (const [more, line] of [
    [0, null],
    [1, '1 more loop is not shown.'],
    [3, '3 more loops are not shown.'],
  ] as const) {
    const lines = scheduleListText(read(more)).split('\n');
    assert.equal(lines.at(-1), 'Loops run while CrewKite is open.');
    assert.equal(lines.at(-2) === line, line !== null, String(more));
  }
});
