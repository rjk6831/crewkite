import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { Task } from './manifest.ts';
import { TaskSchema } from './manifest.ts';
import { RunReportSchema, writeRun } from './report.ts';
import { runBench, selectTasks } from './runner.ts';
import type { ScriptedPlan } from './scripted.ts';
import { verificationRecord, verifyTask } from './verify.ts';

// A small repository on disk stands in for any project: a base commit where two files are wrong
// and a solution commit that fixes them and adds one checking script.

function sandbox(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'bench-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = join(directory, 'project');
  const run = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repository,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), text);
  };
  mkdirSync(repository, { recursive: true });
  run('init', '-q');
  write('a.txt', 'wrong\n');
  write('b.txt', 'wrong\n');
  const script = (file: string) =>
    `import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('${file}', 'utf8') === 'right\\n' ? 0 : 1);\n`;
  write('check-a.mjs', script('a.txt'));
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  const base = run('rev-parse', 'HEAD');
  write('a.txt', 'right\n');
  write('b.txt', 'right\n');
  write('check-b.mjs', script('b.txt'));
  run('add', '-A');
  run('commit', '-q', '-m', 'solution');
  const solution = run('rev-parse', 'HEAD');
  const task = (id: string, extra: Record<string, unknown>): Task =>
    TaskSchema.parse({
      id,
      title: `Fixture task ${id}`,
      repository,
      base,
      solution,
      text: 'Make the file named in the check hold the word right on one line.',
      difficulty: 'easy',
      tags: ['fixture'],
      ...extra,
    });
  return { directory, repository, base, solution, task };
}

const nodeCheck = (name: string, file: string) => ({ name, command: 'node', args: [file] });

test('a task verifies only when its checks fail on the base commit and pass on the solution', async (t) => {
  const { task, directory } = sandbox(t);
  const cases = [
    {
      name: 'a visible check that fails on base and passes on solution',
      task: task('visible', { checks: [nodeCheck('a', 'check-a.mjs')] }),
      ok: true,
      failedOnBase: ['a'],
    },
    {
      name: 'a hidden check taken from the solution commit',
      task: task('hidden', { hidden: ['check-b.mjs'], checks: [nodeCheck('b', 'check-b.mjs')] }),
      ok: true,
      failedOnBase: ['b'],
    },
    {
      name: 'a check that already passes on base proves nothing',
      task: task('passing', {
        checks: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'] }],
      }),
      ok: false,
      failedOnBase: [],
    },
    {
      name: 'a check that still fails on the solution commit',
      task: task('broken', {
        checks: [{ name: 'never', command: 'node', args: ['-e', 'process.exit(1)'] }],
      }),
      ok: false,
      failedOnBase: ['never'],
    },
    {
      name: 'a task with no solution commit',
      task: task('no-solution', { solution: undefined, checks: [nodeCheck('a', 'check-a.mjs')] }),
      ok: false,
      failedOnBase: [],
    },
  ];
  for (const item of cases) {
    const outcome = await verifyTask(item.task, { self: directory });
    assert.equal(outcome.ok, item.ok, item.name);
    assert.deepEqual(outcome.failedOnBase, item.failedOnBase, item.name);
    assert.equal(outcome.reason === null, item.ok, item.name);
  }
});

test('a scripted run of two tasks writes one JSON file and a table that disclose every task asked for', async (t) => {
  const { task, directory } = sandbox(t);
  const verified = async (item: Task): Promise<Task> => ({
    ...item,
    verification: verificationRecord(
      await verifyTask(item, { self: directory }),
      '2026-01-01T00:00:00.000Z',
    ),
  });
  const fixed = await verified(task('fixed', { checks: [nodeCheck('a', 'check-a.mjs')] }));
  const missed = await verified(
    task('missed', { hidden: ['check-b.mjs'], checks: [nodeCheck('b', 'check-b.mjs')] }),
  );
  const loose = task('loose', { checks: [nodeCheck('a', 'check-a.mjs')] });

  // The first task gets its fix and reports tokens. The second gets nothing, and reports none.
  const plan: ScriptedPlan = (item, role) => {
    if (role === 'reviewer')
      return { steps: [{ kind: 'text', itemId: 'review', chunks: ['One thing.\nFindings: 1'] }] };
    return item.id === 'fixed'
      ? {
          steps: [
            {
              kind: 'tool',
              callId: 'write-a',
              toolKind: 'edit',
              title: 'Write a.txt',
              write: { path: 'a.txt', content: 'right\n' },
            },
            { kind: 'text', itemId: 'reply', chunks: ['Done.'] },
          ],
          tokens: { in: 120, out: 30 },
        }
      : { steps: [{ kind: 'text', itemId: 'reply', chunks: ['I left it as it was.'] }] };
  };

  let tick = 0;
  const picked = selectTasks([fixed, missed, loose], 'all');
  const out = join(directory, 'out');
  const report = await runBench({
    self: directory,
    workDirectory: join(directory, 'work'),
    selection: { family: 'openai', model: 'model-a', effort: 'default' },
    tasks: picked.tasks,
    exclusions: picked.exclusions,
    review: true,
    scripted: plan,
    timeoutMs: 120_000,
    runId: 'fixture-run',
    now: () => (tick += 1000),
  });
  const files = writeRun(out, report);

  const saved = RunReportSchema.parse(JSON.parse(readFileSync(files.json, 'utf8')));
  const byId = new Map(saved.results.map((result) => [result.taskId, result]));
  assert.deepEqual([...byId.keys()], ['fixed', 'missed']);

  const fixedResult = byId.get('fixed');
  assert.equal(fixedResult?.outcome, 'passed');
  assert.equal(fixedResult?.tokensIn, 120);
  assert.equal(fixedResult?.tokensOut, 30);
  assert.equal(fixedResult?.changedFiles, 1);
  assert.equal(fixedResult?.review?.findings, 1);
  assert.equal(fixedResult?.bugsFoundAfter, null);

  const missedResult = byId.get('missed');
  assert.equal(missedResult?.outcome, 'failed');
  assert.equal(missedResult?.tokensIn, null, 'a client that reports no tokens stays unknown');
  assert.equal(missedResult?.checks[0]?.passed, false);
  assert.equal(missedResult?.checks[0]?.exitCode, 1);

  assert.deepEqual(
    saved.exclusions.map((item) => [item.taskId, item.reason]),
    [['loose', 'unverified']],
  );
  assert.equal(saved.finishedAt !== null, true);

  const table = readFileSync(files.markdown, 'utf8');
  assert.match(table, /\| fixed \| easy \| passed \| 1\/1 \|/);
  assert.match(table, /\| missed \| easy \| failed \| 0\/1 \|/);
  assert.match(table, /unknown/);
  assert.match(
    table,
    /Requested 3, ran 2, passed 1, failed 1, errored 0, timed out 0, excluded 1\./,
  );
  assert.match(table, /\| loose \| unverified \|/);
});
