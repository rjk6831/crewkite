import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PlanRecipe, ResultsRead, SliceResult } from '@crewkite/contracts';
import { createTestIds } from '../../../../packages/testkit/src/index.ts';
import type { ControllerOptions } from '../../../controller/src/commands/controller.ts';
import { installedTools } from '../../../controller/src/store/controller-fixture.ts';
import { runCli } from '../main.ts';
import { startScriptedController } from '../scripted-controller.ts';
import { connectChat } from './connect.ts';
import { resultsText } from './results.ts';
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
const recipe: PlanRecipe = {
  schema: 1,
  name: 'Tidy',
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
  trigger: { kind: 'manual' },
  budget: null,
  work: null,
};

test('results prints both tables and the export writes one file', {
  timeout: 60_000,
}, async (t) => {
  // Only git on PATH, so nothing can find gh or a provider client.
  const tools = mkdtempSync(join(tmpdir(), 'ck-cli-results-'));
  const saved = process.env.PATH;
  process.env.PATH = installedTools(tools, 'git');
  t.after(() => {
    process.env.PATH = saved;
    rmSync(tools, { recursive: true, force: true });
  });
  const options: Partial<ControllerOptions> = { now: () => '2026-03-02T10:00:00.000Z' };
  const { home, repository, controller } = await startScriptedController(t, [], options);
  const run = async (...args: string[]) => {
    const { seen, output } = capture();
    const code = await runCli([...args, '--home', home], output);
    return { code, ...seen };
  };
  const added = await run('project', 'add', repository);
  const project = /Project (prj_[0-9A-Z]{26})/.exec(added.out)?.[1] ?? '';
  assert.ok(project);

  const none = await run('results', '--project', project);
  assert.deepEqual(
    [none.code, none.out],
    [0, 'No results yet.\nCounts from this device. Nothing here is uploaded.\n'],
  );

  const ids = createTestIds('2026-03-02T09:00:00.000Z');
  const saveResult = await controller.execute(
    {
      protocol: 1,
      key: ids('cmd'),
      actor: { id: 'terminal', kind: 'cli' },
      command: 'SaveRecipe',
      payload: {
        projectId: project,
        path: '.crewkite/recipes/tidy.json',
        body: recipe,
        expectedVersion: 0,
        confirm: 'explicit',
      },
      expectedRevision: 0,
    },
    'local-owner',
  );
  assert.equal(saveResult.data?.kind, 'recipe-saved');
  const recipeId = saveResult.data?.kind === 'recipe-saved' ? saveResult.data.record.id : '';
  const as = (prefix: string) => `${prefix}_${ids('msg').slice(4)}`;
  const forgotten = as('rcp');
  let minute = 0;
  const record = (change: Partial<SliceResult>): SliceResult => ({
    id: as('srs'),
    projectId: project,
    taskId: ids('tsk'),
    anchorTurnId: as('trn'),
    recipeId,
    recipeHash: 'a'.repeat(64),
    runId: null,
    slice: 1,
    step: 'build',
    role: 'builder',
    family: 'anthropic',
    model: 'model-b',
    effort: 'default',
    rulesDigest: null,
    designVersionHash: null,
    firstGate: 'none',
    firstReview: 'none',
    findings: null,
    fixRounds: 0,
    final: 'waiting',
    durationMs: 1000,
    allowanceUsed: null,
    allowanceWindow: null,
    startedAt: new Date(Date.parse('2026-03-02T09:00:00.000Z') + 60_000 * minute++).toISOString(),
    endedAt: null,
    ...change,
  });
  const build = record({
    firstReview: 'findings',
    findings: 2,
    fixRounds: 2,
    final: 'accepted',
    allowanceUsed: 5,
    allowanceWindow: 'weekly',
  });
  controller.store.transaction(() => {
    for (const value of [
      build,
      // A reviewer whose effort the record does not hold, with no allowance figure.
      record({
        anchorTurnId: build.anchorTurnId,
        step: 'review',
        role: 'reviewer',
        effort: null,
        fixRounds: null,
        final: 'accepted',
      }),
      // A planner with plan steps only, on a second provider and window.
      record({
        slice: null,
        step: 'challenge',
        role: 'orchestrator',
        family: 'openai',
        model: 'model-a',
        allowanceUsed: 3,
        allowanceWindow: 'weekly',
      }),
      record({ recipeId: forgotten, allowanceUsed: 4, allowanceWindow: 'five-hour' }),
    ])
      controller.store.insertSliceResult(value);
  });

  const shown = await run('results', '--project', project);
  assert.equal(shown.code, 0, shown.err);
  assert.equal(
    shown.out,
    [
      'By recipe',
      'RECIPE            RUNS  SLICES  PASSED FIRST REVIEW  FIX ROUNDS  ACCEPTED  ALLOWANCE USED',
      'Tidy              0     1       0 of 1               2.0         1 of 1    OpenAI, Weekly: 3.0%',
      '                                                                           Anthropic, Weekly: 5.0%',
      '                                                                           Anthropic: 1 step unknown',
      'Forgotten recipe  0     1       None                 0.0         None      Anthropic, Five-hour: 4.0%',
      '',
      'By role and model',
      'ROLE          MODEL      EFFORT            STEPS  SLICES  PASSED FIRST REVIEW  FIX ROUNDS  ACCEPTED  ALLOWANCE USED',
      'Builder       model-b    Default           2      2       0 of 1               1.0         1 of 1    Five-hour: 4.0% (1 unknown)',
      '              Anthropic',
      'Reviewer      model-b    Provider default  1      1       0 of 1               2.0         1 of 1    Unknown',
      '              Anthropic',
      'Orchestrator  model-a    Default           1      None    None                 None        None      Weekly: 3.0%',
      '              OpenAI',
      '',
      'Counts from this device. Nothing here is uploaded.',
      '',
    ].join('\n'),
  );

  // One recipe's records only, by name.
  const one = await run('results', '--recipe', 'Tidy');
  assert.equal(one.code, 0, one.err);
  assert.ok(one.out.includes('Tidy '));
  assert.equal(one.out.includes('Forgotten recipe'), false);

  const directory = mkdtempSync(join(tmpdir(), 'ck-cli-results-out-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'out.json');
  const written = await run('results', '--export', target, '--project', project);
  assert.deepEqual(
    [written.code, written.out, written.err],
    [0, 'Wrote 4 records to out.json.\n', ''],
  );
  assert.equal(statSync(target).mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(
    [file.schema, file.projectId, file.runs, typeof file.exportedAt],
    [1, project, [], 'string'],
  );
  const stored = controller.store.sliceResults(project);
  assert.deepEqual(
    file.records.map((value: SliceResult) => value.id).sort(),
    stored.map((value: SliceResult) => value.id).sort(),
  );
  assert.deepEqual(
    file.records.find((value: SliceResult) => value.id === build.id),
    build,
  );
  const named = await run('results', '--export', join(directory, 'tidy.json'), '--recipe', 'Tidy');
  assert.equal(named.out, 'Wrote 3 records to tidy.json.\n');

  // A path that is not a plain file with one link is refused and nothing it leads to changes: a
  // symbolic link, a dangling one, a hard link to another file, a folder and a pipe.
  const unwritable = [2, '', 'The file could not be written there. Choose another place.\n'];
  const elsewhere = join(directory, 'elsewhere.txt');
  writeFileSync(elsewhere, 'keep');
  const link = join(directory, 'link.json');
  symlinkSync(elsewhere, link);
  const dangling = join(directory, 'dangling.json');
  symlinkSync(join(directory, 'nowhere.txt'), dangling);
  const hard = join(directory, 'hard.json');
  linkSync(elsewhere, hard);
  const folder = join(directory, 'folder.json');
  mkdirSync(folder);
  const pipe = join(directory, 'pipe.json');
  assert.equal(spawnSync('/usr/bin/mkfifo', [pipe]).status, 0);
  for (const refused of [link, dangling, hard, folder, pipe]) {
    const answer = await run('results', '--export', refused, '--project', project);
    assert.deepEqual([answer.code, answer.out, answer.err], unwritable, refused);
  }
  assert.equal(readFileSync(elsewhere, 'utf8'), 'keep');
  assert.equal(existsSync(join(directory, 'nowhere.txt')), false);
  // A missing folder is refused the same way.
  const missing = await run(
    'results',
    '--export',
    join(directory, 'no', 'out.json'),
    '--project',
    project,
  );
  assert.deepEqual([missing.code, missing.out, missing.err], unwritable);

  // A file already there is replaced whole, with the mode it had.
  const old = join(directory, 'old.json');
  writeFileSync(old, 'x'.repeat(100_000));
  chmodSync(old, 0o640);
  const replaced = await run('results', '--export', old, '--project', project);
  assert.deepEqual([replaced.code, replaced.err], [0, '']);
  assert.equal(JSON.parse(readFileSync(old, 'utf8')).records.length, 4);
  assert.equal(statSync(old).mode & 0o777, 0o640);

  // --export writes a file and takes no --json. A project ID no project holds is refused before
  // anything is read or written, for the counts and for the export.
  const asked = await run('results', '--export', join(directory, 'json.json'), '--json');
  assert.deepEqual([asked.code, existsSync(join(directory, 'json.json'))], [2, false]);
  assert.match(asked.out, /--export writes a file and takes no --json\./);
  const stranger = `prj_${'0'.repeat(26)}`;
  const unknown = await run('results', '--project', stranger);
  assert.deepEqual(
    [unknown.code, unknown.out, unknown.err],
    [2, '', 'Choose a registered project.\n'],
  );
  const strange = join(directory, 'stranger.json');
  const unknownExport = await run('results', '--export', strange, '--project', stranger);
  assert.deepEqual(
    [unknownExport.code, unknownExport.err, existsSync(strange)],
    [2, 'Choose a registered project.\n', false],
  );

  // A file CrewKite never saved has no results. A refused page ends the export with the
  // controller's sentence and writes nothing.
  writeFileSync(
    join(repository, '.crewkite/recipes/unsaved.json'),
    JSON.stringify({ ...recipe, name: 'Unsaved' }),
  );
  const unsaved = await run('results', '--recipe', '.crewkite/recipes/unsaved.json');
  assert.deepEqual(
    [unsaved.code, unsaved.out, unsaved.err],
    [2, '', 'That recipe is not saved here.\n'],
  );
  const refusing: Connect = async (where) => {
    const client = await connectChat(where);
    return {
      ...client,
      send: async (command, payload) =>
        command === 'ExportResults'
          ? { outcome: 'blocked', reason: 'read-unavailable', next: 'Inspect it.' }
          : client.send(command, payload),
    };
  };
  const refusedTarget = join(directory, 'refused.json');
  const seen = { out: '', err: '' };
  const code = await runCli(
    ['results', '--export', refusedTarget, '--project', project, '--home', home],
    {
      out: (text) => {
        seen.out += text;
      },
      err: (text) => {
        seen.err += text;
      },
    },
    refusing,
  );
  assert.deepEqual(
    [code, seen.out, seen.err, existsSync(refusedTarget)],
    [2, '', 'Inspect it.\n', false],
  );

  // Rows past a bound are counted under their table, and a name cannot carry an escape to the
  // terminal.
  const crew = (model: string) => ({
    role: 'builder',
    family: 'openai',
    model,
    effort: 'high',
    steps: 1,
    slices: 1,
    reviewed: 0,
    passedFirstReview: 0,
    fixRounds: 0,
    settled: 0,
    accepted: 0,
    allowanceUsed: null,
    allowanceWindow: null,
    allowanceUnknown: 1,
  });
  const long = resultsText({
    projectId: project,
    records: 5,
    first: null,
    last: null,
    recipes: [],
    crew: [crew('plain\u001b[31mred')],
    moreRecipes: 2,
    moreCrew: 1,
  } as unknown as ResultsRead);
  assert.ok(long.includes('2 more recipes are not shown.'));
  assert.ok(long.includes('1 more row is not shown.'));
  assert.equal(long.includes('\u001b'), false);

  const asJson = await run('results', '--project', project, '--json');
  const line = JSON.parse(asJson.out);
  assert.deepEqual(
    [asJson.code, line.kind, line.command, line.outcome, line.data.records],
    [0, 'result', 'ReadResults', 'applied', 4],
  );
});
