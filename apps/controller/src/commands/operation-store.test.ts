import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../store/index.ts';
import { OperationRecordSchema, OperationStore } from './operation-store.ts';

test('task operation ownership recovers without replay or unrelated mutation uncertainty', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ck-operation-journal-'));
  let store = new Store(join(home, 'state.sqlite'));
  const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
  store.applyMigrations(migrations);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const id = (prefix: string, value: number) => `${prefix}_${String(value).padStart(26, '0')}`;
  const task = {
    id: id('tsk', 1),
    projectId: id('prj', 1),
    title: 'Run explicit commands',
    outcome: 'Retain operation output',
    criteria: ['Owned phases close'],
    state: 'draft',
    waitingReason: null,
    revision: 0,
    runId: null,
    next: null,
  };
  const definition = {
    id: id('art', 1),
    hash: 'a'.repeat(64),
    bytes: 0,
    mediaType: 'application/json',
  };
  store.transaction(() => {
    store.put('task', task.id, 0, task);
    store.put('artifact', definition.id, 0, definition);
  });
  let journal = new OperationStore(store, () => '2026-10-21T00:00:00.000Z');
  const create = (number: number) =>
    store.transaction(() =>
      journal.create({
        id: id('cmd', number),
        taskId: task.id,
        kind: 'project-command',
        definition,
      }),
    );
  const first = create(1);
  let admissions = 0;
  journal.begin(first.id, id('cmd', 101), 'b'.repeat(64), () => {
    admissions++;
  });
  assert.throws(
    () =>
      journal.begin(first.id, id('cmd', 101), 'b'.repeat(64), () => {
        admissions++;
      }),
    /already-recorded/,
  );
  assert.throws(
    () =>
      journal.begin(first.id, id('cmd', 101), 'c'.repeat(64), () => {
        admissions++;
      }),
    /idempotency/,
  );
  assert.throws(
    () =>
      journal.begin(first.id, id('cmd', 199), 'd'.repeat(64), () => {
        admissions++;
      }),
    /cannot start/,
  );
  assert.equal(admissions, 1);
  assert.throws(
    () =>
      store.transaction(() =>
        journal.create({
          id: id('cmd', 999),
          taskId: id('tsk', 999),
          kind: 'project-command',
          definition,
        }),
      ),
    /task/,
  );
  for (const phase of [
    { name: 'command', state: 'intent', group: 111 },
    { name: 'command', state: 'closed', group: null },
    { name: 'metadata', state: 'owned', group: 111 },
  ])
    assert.equal(
      OperationRecordSchema.safeParse({ ...journal.get(first.id), phases: [phase] }).success,
      false,
    );
  journal.phase(first.id, 'command', 'intent', null);
  journal.phase(first.id, 'command', 'owned', 111);
  assert.throws(() => journal.phase(first.id, 'command', 'closed', 222), /transition/);
  const changes = store.db.prepare('SELECT total_changes() AS count').get()?.count;
  assert.equal(journal.get(first.id)?.state, 'running');
  assert.equal(store.db.prepare('SELECT total_changes() AS count').get()?.count, changes);
  journal.recover((group) => {
    assert.equal(group, 111);
    return true;
  });
  assert.equal(journal.get(first.id)?.state, 'failed');
  assert.equal(store.receipt(id('cmd', 101))?.result.reason, 'operation-interrupted');
  const second = create(2);
  journal.begin(second.id, id('cmd', 102), 'b'.repeat(64), () => {});
  journal.phase(second.id, 'command', 'intent', null);
  journal.recover(() => assert.fail('An unbound intent has no group to inspect.'));
  assert.equal(journal.get(second.id)?.state, 'unknown');
  assert.equal(store.receipt(id('cmd', 102))?.result.reason, 'operation-ownership-unknown');
  const unknownRevision = journal.get(second.id)?.revision;
  const third = create(3);
  journal.begin(third.id, id('cmd', 103), 'b'.repeat(64), () => {});
  journal.phase(third.id, 'command', 'intent', null);
  journal.phase(third.id, 'command', 'owned', 222);
  assert.throws(
    () =>
      journal.finish(
        third.id,
        { state: 'succeeded', reason: null, next: null },
        { outcome: 'applied' },
      ),
    /ownership/,
  );
  journal.phase(third.id, 'command', 'closed', 222);
  journal.finish(
    third.id,
    { state: 'succeeded', reason: null, next: null },
    { outcome: 'applied' },
  );
  assert.throws(() => journal.stopping(third.id), /complete/);
  assert.equal(journal.list(task.id, third.id).length, 2);
  store.transaction(() => store.put('task', id('tsk', 2), 0, { ...task, id: id('tsk', 2) }));
  store.close();
  store = new Store(join(home, 'state.sqlite'));
  store.applyMigrations(migrations);
  journal = new OperationStore(store, () => '2026-10-21T00:01:00.000Z');
  journal.recover(() => assert.fail('Historical unbound ownership cannot be guessed or signaled.'));
  assert.equal(journal.get(second.id)?.state, 'unknown');
  assert.equal(journal.get(second.id)?.revision, unknownRevision);
  assert.equal(store.receipt(id('cmd', 102))?.result.reason, 'operation-ownership-unknown');
  assert.equal(journal.get(third.id)?.state, 'succeeded');
});
