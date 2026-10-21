import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectController, readControllerEndpoint } from '@crewkite/client/node';
import {
  CommandSchema,
  type Event,
  EventSchema,
  MAX_TASK_ACTIVITY_PAGE_BYTES,
  type Task,
  TaskActivityPageSchema,
  type TaskActivityRequest,
  TaskActivityRequestSchema,
} from '@crewkite/contracts';
import { transferArtifact } from '../../../../packages/client/src/output.ts';
import { Controller } from '../commands/controller.ts';
import { serve } from '../server/index.ts';
import { taskActivityPage } from './activity.ts';
import { Store } from './index.ts';

test('task activity pages retain every whole event across cursor and byte boundaries', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ck-activity-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  let controller: Controller | undefined;
  t.after(async () => {
    if (controller) await controller.close();
    else store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const id = (prefix: string, number: number) => `${prefix}_${String(number).padStart(26, '0')}`;
  const task: Task = {
    id: id('tsk', 1),
    projectId: id('prj', 1),
    title: 'Retain task history',
    outcome: 'Read the original events after reconnecting',
    criteria: ['Events retain their identity and order'],
    state: 'draft',
    waitingReason: null,
    revision: 0,
    runId: null,
    next: null,
  };
  const other = { ...task, id: id('tsk', 2) };
  store.transaction(() => {
    store.put('task', task.id, 0, task);
    store.put('task', other.id, 0, other);
  });
  let sequence = 0;
  const append = (taskId: string | null, text = 'Retained output.') =>
    store.transaction(() =>
      store.append({
        protocol: 1,
        id: id('evt', ++sequence),
        at: '2026-10-18T00:00:00.000Z',
        taskId,
        revision: 0,
        type: 'attempt.output',
        payload: { attemptId: id('att', 1), generation: 0, channel: 'stdout', text },
      }),
    );
  const original: Event[] = [];
  for (let index = 0; index < 120; index++) {
    original.push(append(task.id));
    if (index % 3 === 0) append(other.id);
    if (index % 5 === 0) append(null);
  }
  const read = (beforeCursor?: string, limit = 17) =>
    taskActivityPage(store.db, { taskId: task.id, limit, beforeCursor });
  const first = read();
  assert.deepEqual(first.events, original.slice(-17));
  const late = append(task.id, 'Arrived between page reads.');
  const received = [...first.events];
  let before = first.nextBeforeCursor;
  while (before !== null) {
    const page = read(before);
    assert(page.events.every((event) => BigInt(event.cursor) < BigInt(before as string)));
    received.push(...page.events);
    before = page.nextBeforeCursor;
  }
  received.sort((left, right) => (BigInt(left.cursor) < BigInt(right.cursor) ? -1 : 1));
  assert.deepEqual(received, original);
  assert.equal(new Set(received.map((event) => event.id)).size, original.length);
  assert.deepEqual(read('0').events, []);
  assert.equal(read('0').nextBeforeCursor, null);
  assert.deepEqual(read(late.cursor, 1).events, original.slice(-1));
  assert.equal(TaskActivityRequestSchema.parse({ taskId: task.id }).limit, 100);
  const wide = Array.from({ length: 12 }, () => append(task.id, 'é'.repeat(50000)));
  const byteLimited = read(undefined, 100);
  assert(byteLimited.events.length > 0 && byteLimited.events.length < 12);
  assert(Buffer.byteLength(JSON.stringify(byteLimited)) <= MAX_TASK_ACTIVITY_PAGE_BYTES);
  const complete = [...byteLimited.events];
  before = byteLimited.nextBeforeCursor;
  while (before !== null) {
    const page = read(before, 100);
    complete.push(...page.events);
    before = page.nextBeforeCursor;
  }
  complete.sort((left, right) => (BigInt(left.cursor) < BigInt(right.cursor) ? -1 : 1));
  assert.deepEqual(complete, [...original, late, ...wide]);
  const beforeReopen = read(undefined, 100);
  const changes = store.db.prepare('SELECT total_changes() AS count').get()?.count;
  assert.deepEqual(read(undefined, 100), beforeReopen);
  assert.equal(store.db.prepare('SELECT total_changes() AS count').get()?.count, changes);
  store.close();
  controller = new Controller({
    home: directory,
    now: () => '2026-10-18T00:00:00.000Z',
    nativeProfiles: () => [],
    googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
  });
  store = controller.store;
  assert.deepEqual(read(undefined, 100), beforeReopen);

  const envelope = {
    protocol: 1,
    key: id('cmd', 1),
    actor: { id: 'terminal', kind: 'cli' },
    command: 'GetTaskActivity',
  };
  const dispatch = (payload: unknown) =>
    controller?.execute({ ...envelope, payload }, 'local-owner');
  const stateBeforeRead = store.db.prepare('SELECT total_changes() AS count').get()?.count;
  assert.deepEqual(await dispatch({ taskId: task.id, limit: 17 }), {
    outcome: 'applied',
    data: read(undefined, 17),
  });
  assert.deepEqual(
    await dispatch({ taskId: task.id, beforeCursor: first.nextBeforeCursor, limit: 9 }),
    {
      outcome: 'applied',
      data: read(first.nextBeforeCursor as string, 9),
    },
  );
  assert.deepEqual(await dispatch({ taskId: id('tsk', 999) }), {
    outcome: 'blocked',
    reason: 'task-not-found',
  });
  assert.equal(store.db.prepare('SELECT total_changes() AS count').get()?.count, stateBeforeRead);
  assert(CommandSchema.safeParse({ ...envelope, payload: { taskId: task.id } }).success);
  assert.equal(
    CommandSchema.safeParse({ ...envelope, expectedRevision: 0, payload: { taskId: task.id } })
      .success,
    false,
  );
  for (const payload of [
    { taskId: task.id, limit: 0 },
    { taskId: task.id, limit: 101 },
    { taskId: task.id, limit: 1.5 },
    { taskId: task.id, beforeCursor: '01' },
    { taskId: task.id, beforeCursor: '-1' },
    { taskId: task.id, after: '1' },
    { taskId: 'invalid' },
  ]) {
    assert.equal(CommandSchema.safeParse({ ...envelope, payload }).success, false);
    assert.throws(() => taskActivityPage(store.db, payload as TaskActivityRequest));
  }
  for (const invalid of [
    { ...first, events: first.events.toReversed() },
    { ...first, taskId: other.id },
    { ...first, events: [first.events[0], first.events[0]] },
    { ...first, nextBeforeCursor: '0' },
    { ...first, events: [], nextBeforeCursor: '1' },
  ])
    assert.equal(TaskActivityPageSchema.safeParse(invalid).success, false);

  const high = '9007199254740993';
  const highEvent = EventSchema.parse({ ...original[0], id: id('evt', ++sequence), cursor: high });
  store.db
    .prepare('INSERT INTO events(cursor,event_id,task_id,body) VALUES (?,?,?,?)')
    .run(BigInt(high), highEvent.id, task.id, JSON.stringify(highEvent));
  assert.deepEqual(read('99999999999999999999', 1).events, [highEvent]);
  assert.equal(read(high, 1).events[0].cursor, beforeReopen.events.at(-1)?.cursor);

  const tooLarge = store.transaction(() =>
    store.append({
      protocol: 1,
      id: id('evt', ++sequence),
      taskId: task.id,
      at: original[0].at,
      revision: 0,
      type: 'task.updated',
      payload: { ...task, criteria: Array.from({ length: 100 }, () => '界'.repeat(4096)) },
    }),
  );
  assert.throws(() => read(), /activity-event-too-large/);
  assert.deepEqual(await dispatch({ taskId: task.id }), {
    outcome: 'blocked',
    reason: 'activity-event-too-large',
    next: 'One retained event exceeds the page size. No history was skipped.',
  });
  const outputResult = await controller.execute(
    { ...envelope, command: 'GetTaskActivityPage', payload: { taskId: task.id, limit: 1 } },
    'local-owner',
  );
  assert.equal(outputResult.outcome, 'applied');
  assert.equal(outputResult.data?.kind, 'task-activity-page');
  if (outputResult.data?.kind !== 'task-activity-page') throw Error('Missing output page.');
  const reference = outputResult.data.entries[0];
  assert.equal(reference.kind, 'event-body');
  if (reference.kind !== 'event-body') throw Error('Missing event body reference.');
  assert.equal(reference.id, tooLarge.id);
  assert.equal(reference.cursor, tooLarge.cursor);
  const chunks: Buffer[] = [];
  await transferArtifact(
    reference.artifact,
    async (payload) => {
      assert(controller);
      const result = await controller.execute(
        { ...envelope, command: 'GetArtifactRange', payload },
        'local-owner',
      );
      if (result.data?.kind !== 'artifact-range') throw Error('Missing event body range.');
      return result.data;
    },
    (bytes) => {
      chunks.push(Buffer.from(bytes));
    },
  );
  assert.equal(
    Buffer.concat(chunks).toString(),
    store.db.prepare('SELECT body FROM events WHERE event_id=?').get(tooLarge.id)?.body,
  );
  assert.equal(outputResult.data.nextBeforeCursor, tooLarge.cursor);
  const following = await controller.execute(
    {
      ...envelope,
      command: 'GetTaskActivityPage',
      payload: { taskId: task.id, beforeCursor: tooLarge.cursor, limit: 1 },
    },
    'local-owner',
  );
  assert.equal(following.data?.kind, 'task-activity-page');
  if (following.data?.kind === 'task-activity-page')
    assert.deepEqual(following.data.entries, [{ kind: 'event', event: highEvent }]);
  const server = await serve(controller);
  const client = await connectController({
    ...readControllerEndpoint(directory),
    actor: { id: 'terminal', kind: 'cli' },
  });
  const gap = Promise.withResolvers<void>();
  try {
    await client.subscribe(
      '0',
      () => {},
      () => assert.fail('Workspace recovery cannot request a global snapshot.'),
      {
        resync: 'workspace',
        onResync: (header) => {
          assert.equal(header.kind, 'workspace-state');
          gap.resolve();
        },
      },
    );
    await gap.promise;
    assert.equal((await client.workspaceState()).kind, 'workspace-state');
  } finally {
    client.close();
    await server.close();
  }
  store.db.prepare('DELETE FROM activity_output WHERE event_id=?').run(tooLarge.id);
  const interrupted = controller.execute(
    { ...envelope, command: 'GetTaskActivityPage', payload: { taskId: task.id, limit: 1 } },
    'local-owner',
  );
  await controller.close();
  assert.equal((await interrupted).reason, 'output-read-unavailable');
  controller = new Controller({
    home: directory,
    nativeProfiles: () => [],
    googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
  });
  store = controller.store;
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM activity_output').get()?.count, 0);
  const retried = await controller.execute(
    { ...envelope, command: 'GetTaskActivityPage', payload: { taskId: task.id, limit: 1 } },
    'local-owner',
  );
  assert.equal(retried.data?.kind, 'task-activity-page');
  store.db.prepare('DELETE FROM activity_output WHERE event_id=?').run(tooLarge.id);

  assert.deepEqual(read(tooLarge.cursor, 1).events, [highEvent]);
  const afterLarge = append(task.id, 'A small event after the oversized row.');
  const boundary = read();
  assert.deepEqual(boundary.events, [afterLarge]);
  assert.equal(boundary.nextBeforeCursor, afterLarge.cursor);
  assert.throws(() => read(boundary.nextBeforeCursor as string), /activity-event-too-large/);
  store.db.prepare('DELETE FROM events WHERE event_id=?').run(afterLarge.id);
  store.db.prepare('DELETE FROM events WHERE event_id=?').run(tooLarge.id);
  store.db
    .prepare('UPDATE events SET body=? WHERE event_id=?')
    .run(JSON.stringify({ ...highEvent, cursor: '1' }), highEvent.id);
  assert.throws(() => read(), /activity-history-invalid/);
  assert.deepEqual(await dispatch({ taskId: task.id }), {
    outcome: 'blocked',
    reason: 'activity-history-unavailable',
    next: 'Retained activity could not be read. No history was skipped.',
  });
});
