import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isVerified, loadTasks, TaskSchema } from './manifest.ts';

const hash = 'a'.repeat(40);
const valid = {
  id: 'fix-queue-order',
  title: 'Keep queued messages in order',
  base: hash,
  solution: 'b'.repeat(40),
  text: 'Queued messages start in the order they were sent. Today the newest one starts first.',
  checks: [{ name: 'queue', command: 'node', args: ['--test', 'a.test.ts'] }],
  difficulty: 'easy',
  tags: ['chat'],
};

const record = {
  method: 'by hand',
  verifiedAt: '2026-01-01T00:00:00.000Z',
  node: 'v24.0.0',
  failedOnBase: ['queue'],
  baseFailure: 'assertion',
  passedOnSolution: ['queue'],
};

test('the task format accepts a complete task and refuses each malformed one', () => {
  const cases: [string, object, boolean][] = [
    ['a complete task', valid, true],
    ['an external repository by absolute path', { ...valid, repository: '/Users/me/pull' }, true],
    ['hidden files that come from the solution', { ...valid, hidden: ['src/a.test.ts'] }, true],
    ['an id with capitals', { ...valid, id: 'Fix-Queue' }, false],
    ['a short commit hash', { ...valid, base: 'abc123' }, false],
    ['a relative repository path', { ...valid, repository: '../pull' }, false],
    ['no checks', { ...valid, checks: [] }, false],
    [
      'a command with arguments inside it',
      { ...valid, checks: [{ name: 'a', command: 'node --test' }] },
      false,
    ],
    ['two checks with one name', { ...valid, checks: [valid.checks[0], valid.checks[0]] }, false],
    ['a difficulty outside the three', { ...valid, difficulty: 'trivial' }, false],
    ['a hidden file that leaves the repository', { ...valid, hidden: ['../secret'] }, false],
    ['an absolute hidden path', { ...valid, hidden: ['/etc/passwd'] }, false],
    [
      'hidden files with no solution commit',
      { ...valid, solution: undefined, hidden: ['a.ts'] },
      false,
    ],
    [
      'a verification record that names how the base failed',
      { ...valid, verification: { ...record, baseFailure: 'missing-module' } },
      true,
    ],
    [
      'a verification record that omits how the base failed',
      { ...valid, verification: { ...record, baseFailure: undefined } },
      false,
    ],
    [
      'a verification record with an unknown kind of base failure',
      { ...valid, verification: { ...record, baseFailure: 'crash' } },
      false,
    ],
    [
      'a verification record with no solution commit',
      {
        ...valid,
        solution: undefined,
        verification: {
          method: 'by hand',
          verifiedAt: '2026-01-01T00:00:00.000Z',
          node: 'v24.0.0',
          failedOnBase: ['queue'],
          baseFailure: 'assertion',
          passedOnSolution: ['queue'],
        },
      },
      false,
    ],
    [
      'a task text that quotes a diff',
      { ...valid, text: `Fix this.\n@@ -1,3 +1,4 @@\n-old\n+new\nso the queue works.` },
      false,
    ],
    ['a field the format does not define', { ...valid, owner: 'someone' }, false],
  ];
  for (const [name, input, accepted] of cases)
    assert.equal(TaskSchema.safeParse(input).success, accepted, name);
});

test('the repository field defaults to the checkout the harness runs from', () => {
  assert.equal(TaskSchema.parse(valid).repository, 'self');
});

test('a task folder loads only when every file matches its id and no id repeats', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bench-manifest-'));
  try {
    writeFileSync(join(directory, 'fix-queue-order.json'), JSON.stringify(valid));
    assert.deepEqual(
      loadTasks(directory).map((task) => task.id),
      ['fix-queue-order'],
    );
    writeFileSync(join(directory, 'other-name.json'), JSON.stringify(valid));
    assert.throws(() => loadTasks(directory), /must be named fix-queue-order\.json/);
    rmSync(join(directory, 'other-name.json'));
    writeFileSync(join(directory, 'bad.json'), JSON.stringify({ ...valid, id: 'bad', base: 'x' }));
    assert.throws(() => loadTasks(directory), /bad\.json is not a valid task/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every task shipped with the harness carries a verification record and a solution commit', () => {
  const tasks = loadTasks(fileURLToPath(new URL('../tasks', import.meta.url)));
  assert.ok(tasks.length > 0);
  for (const task of tasks) {
    assert.equal(isVerified(task), true, `${task.id} is not verified`);
    assert.ok(task.solution, `${task.id} names no solution`);
    assert.ok(task.verification?.failedOnBase.length, `${task.id} records no failing check`);
    assert.ok(task.verification?.baseFailure, `${task.id} records no base failure kind`);
  }
});
