import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type Task, TaskPageSchema } from '@crewkite/contracts';
import { Store } from './index.ts';
import { projectPage, taskPage } from './workspace.ts';

const id = (kind: string, number: number) => `${kind}_${String(number).padStart(26, '0')}`;
test('workspace pages traverse indexed summaries through status churn and bounded search', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ck-pages-'));
  const store = new Store(join(directory, 'state.db'));
  store.applyMigrations(resolve('apps/controller/migrations'));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const projectId = id('prj', 1);
  const makeTask = (number: number): Task => ({
    id: id('tsk', number),
    projectId,
    title: number === 205 ? 'Éclair [literal]' : `Task ${number}`,
    outcome: 'Keep the change',
    criteria: ['Retain evidence'],
    revision: 0,
    state: 'draft',
    waitingReason: null,
    runId: null,
    next: null,
  });
  store.transaction(() => {
    store.put('project', projectId, 0, { id: projectId, name: 'Éclair [literal]', revision: 0 });
    for (let number = 1; number <= 205; number++)
      store.put('task', id('tsk', number), 0, makeTask(number));
  });
  const stamp = store.workspaceStamp();
  assert.equal(projectPage(store, { stamp }).projects[0].taskCount, 205);
  const plans = [
    [
      "SELECT id FROM entities WHERE kind='task' AND id>? ORDER BY id LIMIT ?",
      ['', 51],
      'entities_kind_id',
    ],
    [
      "SELECT id FROM entities WHERE kind='task' AND json_extract(body,'$.projectId')=? AND id>? ORDER BY id LIMIT ?",
      [projectId, '', 51],
      'task_project_id',
    ],
    [
      "SELECT body FROM entities WHERE kind=? AND json_extract(body,'$.taskId') IN (?) ORDER BY id",
      ['run', id('tsk', 1)],
      'entities_task_id',
    ],
    [
      "SELECT body FROM entities WHERE kind=? AND json_extract(body,'$.runId') IN (?) ORDER BY id",
      ['attempt', id('run', 1)],
      'entities_run_id',
    ],
  ] as const;
  for (const [sql, parameters, index] of plans)
    assert.match(
      JSON.stringify(store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)),
      new RegExp(index),
    );
  let page = taskPage(store, { stamp, limit: 50 });
  const seen = page.tasks.map((task) => task.id);
  store.transaction(() =>
    store.put('task', id('tsk', 1), 1, { ...makeTask(1), revision: 1, next: 'Inspect status.' }),
  );
  assert.deepEqual(store.workspaceStamp(), stamp);
  while (page.next) {
    page = taskPage(store, { stamp, after: page.next, limit: 50 });
    seen.push(...page.tasks.map((task) => task.id));
  }
  assert.equal(seen.length, 205);
  assert.equal(new Set(seen).size, 205);
  assert.equal(seen.at(-1), id('tsk', 205));
  let search = taskPage(store, { stamp, query: 'éCLAIR [literal]' }, () => 0);
  const matches = search.tasks.map((task) => task.id);
  while (search.next) {
    search = taskPage(store, { stamp, query: 'éCLAIR [literal]', after: search.next }, () => 0);
    matches.push(...search.tasks.map((task) => task.id));
  }
  assert.equal(matches.length, 205);
  assert.equal(new Set(matches).size, 205);
  assert.equal(matches[0], id('tsk', 205));
  const noMatch = taskPage(store, { stamp, query: 'absent' }, () => 0);
  assert.equal(noMatch.tasks.length, 0);
  assert.equal(noMatch.complete, false);
  assert.ok(noMatch.next);
  const noMatchNext = noMatch.next;
  assert.throws(
    () => taskPage(store, { stamp, query: 'changed', after: noMatchNext }),
    /workspace-page-invalid/,
  );
  assert.throws(() =>
    store.transaction(() => {
      store.put('task', id('tsk', 1), 2, { ...makeTask(1), title: 'Changed' });
      throw Error('rollback');
    }),
  );
  assert.deepEqual(store.workspaceStamp(), stamp);
  store.transaction(() => store.put('task', id('tsk', 1), 2, { ...makeTask(1), title: 'Changed' }));
  assert.throws(() => taskPage(store, { stamp }), /workspace-page-stale/);
  assert.throws(
    () => taskPage(store, { stamp: { ...store.workspaceStamp(), epoch: '0'.repeat(32) } }),
    /workspace-page-stale/,
  );
  assert.equal(
    TaskPageSchema.safeParse({ ...page, tasks: [page.tasks[0], page.tasks[0]] }).success,
    false,
  );
  store.transaction(() => {
    for (let number = 1; number <= 205; number++)
      store.put('task', id('tsk', number), 3, { ...makeTask(number), outcome: '界'.repeat(4096) });
  });
  const byteStamp = store.workspaceStamp();
  let bytePage = taskPage(store, { stamp: byteStamp, query: '界', limit: 100 }, () => 0);
  while (bytePage.tasks.length === 0 && bytePage.next)
    bytePage = taskPage(
      store,
      { stamp: byteStamp, query: '界', limit: 100, after: bytePage.next },
      () => 0,
    );
  assert.ok(bytePage.tasks.length > 0 && bytePage.tasks.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(bytePage)) <= 524288);
  assert.ok(bytePage.next);
  const afterBytePage = taskPage(
    store,
    { stamp: byteStamp, query: '界', limit: 100, after: bytePage.next },
    () => 0,
  );
  const lastByteTask = bytePage.tasks.at(-1);
  assert.ok(lastByteTask);
  assert.ok(afterBytePage.tasks[0].id > lastByteTask.id);
});
