// The scripted adapter emits the AgentEvent stream every real adapter must produce:
//   turn.started, then per text item text.delta... and text.completed,
//   permission.requested -> (respondPermission) -> permission.resolved,
//   and turn.completed { stopReason, failure } before the result settles.
// On stop it reports only completed items, like a native client that drops the open item.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  ChatAttachment,
  ChatCatalogRead,
  ChatCrew,
  ChatFamily,
  ChatHandoffMode,
  ChatModelSelection,
  ChatThread,
  ChatThreadRead,
  ChatToolKind,
  ChatTurn,
  ChatTurnEventsRead,
  CommandResult,
  Event,
  Project,
  Task,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import {
  type ChatScriptStep,
  createScriptedChatAdapter,
  type ScriptedChatRequest,
} from '@crewkite/testkit/chat-adapter';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import type { Controller } from '../commands/controller.ts';
import { git } from '../host/source.ts';
import { setup } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import {
  type ChatAdapter,
  type ChatTurnRequest,
  type ChatTurnResult,
  chatFailure,
} from './adapter.ts';
import { deleteThreadBaseRef, threadBaseRef } from './changes.ts';
import { detectType } from './files.ts';
import { ChatService, type ChatServiceDeps } from './service.ts';

const selection = { family: 'openai', model: 'fixture-model', effort: 'default' } as const;

async function open<Adapter extends ChatAdapter>(t: TestContext, adapter: Adapter) {
  const context = await setup(t, {
    chatAdapters: new Map([['openai', adapter]]),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
  });
  const { controller, command, source } = context;
  const task = (await controller.execute(context.draft, 'local-owner')).entity as Task;
  const run = (name: string, payload: object, revision?: number) =>
    controller.execute(command(name, { taskId: task.id, ...payload }, revision), 'local-owner');
  const send = (text: string) =>
    run('SendChatMessage', { text, selection }, task.revision) as Promise<CommandResult>;
  const read = async (payload: object = {}) =>
    (await run('ReadChatThread', payload)).data as ChatThreadRead & { kind: 'chat-thread' };
  return { controller, adapter, task, run, send, read, source, command, draft: context.draft };
}

const chat = (t: TestContext, turns: ChatScriptStep[][]) =>
  open(t, createScriptedChatAdapter({ family: 'openai', turns }));

/** Subscribe before the command that causes the event, then await. */
function next(
  controller: Pick<Controller, 'store'>,
  match: (event: Event) => boolean,
): Promise<Event> {
  return new Promise((resolve) => {
    const stop = controller.store.subscribe((event) => {
      if (!match(event)) return;
      stop();
      resolve(event);
    });
  });
}

function turnReaches(
  controller: Pick<Controller, 'store'>,
  state: ChatTurn['state'],
): Promise<ChatTurn> {
  return next(
    controller,
    (event) => event.type === 'chat.turn' && event.payload.state === state,
  ).then((event) => event.payload as ChatTurn);
}

/** The thread is free and no message waits. */
function settles(controller: Pick<Controller, 'store'>): Promise<Event> {
  return next(controller, (event) => {
    if (event.type !== 'chat.thread') return false;
    const thread = event.payload as ChatThread;
    return thread.activeTurnId === null && thread.queued.length === 0;
  });
}

function agentEvents(controller: Pick<Controller, 'store'>): AgentEvent[] {
  return controller.store
    .eventsAfter('0')
    .flatMap((event) => (event.type === 'agent.event' ? [event.payload] : []));
}

test('a sent message streams agent events and saves the reply when the turn finishes', {
  timeout: 30000,
}, async (t) => {
  const { controller, adapter, task, run, read, source } = await chat(t, [
    [{ kind: 'text', itemId: 'reply', chunks: ['It sells ', 'things.'] }],
  ]);
  const states: string[] = [];
  controller.store.subscribe((event) => {
    if (event.type === 'chat.turn') states.push(event.payload.state);
  });
  const done = turnReaches(controller, 'done');
  const message = {
    text: 'What does this project do?',
    selection,
    attachments: ['net.mjs', join(source.directory, 'package.json'), '../outside.txt'],
  };
  assert.equal((await run('SendChatMessage', message, task.revision)).outcome, 'applied');
  const turn = await done;

  assert.deepEqual(states, ['running', 'done']);
  assert.deepEqual(
    agentEvents(controller).map((event) => event.type),
    ['turn.started', 'text.delta', 'text.delta', 'text.completed', 'turn.completed'],
  );
  const thread = await read();
  assert.deepEqual(
    thread.messages.map((message) => [message.author.kind, message.text]),
    [
      ['user', 'What does this project do?'],
      ['assistant', 'It sells things.'],
    ],
  );
  assert.equal(turn.assistantMessageId, thread.messages[1].id);
  assert.equal(thread.thread.activeTurnId, null);
  assert.equal(thread.thread.sessions[0]?.sessionId, `session-${turn.id}`);
  const [request] = adapter.requests;
  assert.equal(
    request.prompt,
    'What does this project do?\n\nAttached paths:\nnet.mjs\npackage.json\n\nAttachment outside the scratch copy was not included: ../outside.txt',
  );
  assert.deepEqual(request.history, []);
  assert.match(request.systemContext, /demo-shop/);
  assert.match(request.systemContext, /no `\.git` folder and no installed dependencies/);
  assert.ok(existsSync(join(request.scratch.directory, 'net.mjs')));
});

test('a permission request parks the turn until the person answers through the command', {
  timeout: 30000,
}, async (t) => {
  const { controller, run, send } = await chat(t, [
    [
      { kind: 'permission', requestId: 'edit-1', question: 'Edit net.mjs?' },
      { kind: 'text', itemId: 'reply', chunks: ['Edited.'] },
    ],
  ]);
  const parked = turnReaches(controller, 'waiting-permission');
  await send('Fix the rounding.');
  const turn = await parked;

  const answer = (choice: string) =>
    run('ResolveChatPermission', { turnId: turn.id, requestId: 'edit-1', choice }, 0);
  assert.equal((await answer('always')).reason, 'permission-not-pending');
  const resumed = turnReaches(controller, 'running');
  const done = turnReaches(controller, 'done');
  assert.equal((await answer('allow-once')).outcome, 'applied');
  await resumed;
  await done;
  assert.ok(
    agentEvents(controller).some(
      (event) => event.type === 'permission.resolved' && event.choice === 'allow-once',
    ),
  );
});

test('stop ends the turn as stopped and keeps the text already streamed', {
  timeout: 30000,
}, async (t) => {
  const { controller, run, send, read } = await chat(t, [
    [
      { kind: 'text', itemId: 'reply', chunks: ['Partial ', 'answer'], complete: false },
      { kind: 'wait' },
    ],
  ]);
  const streamed = next(
    controller,
    (event) =>
      event.type === 'agent.event' &&
      event.payload.type === 'text.delta' &&
      event.payload.text === 'answer',
  );
  await send('Explain the checkout flow.');
  const { turnId } = (await streamed).payload as AgentEvent;
  const stopped = turnReaches(controller, 'stopped');
  assert.equal((await run('StopChatTurn', { turnId }, 0)).outcome, 'applied');
  const turn = await stopped;

  assert.equal(turn.failure, null);
  const thread = await read();
  assert.equal(thread.messages.at(-1)?.text, 'Partial answer');
  assert.equal(thread.messages.at(-1)?.id, turn.assistantMessageId);
  assert.equal(thread.thread.activeTurnId, null);
  assert.equal((await run('StopChatTurn', { turnId }, 0)).reason, 'no-active-turn');
});

test('a failed turn keeps its failure and tells the person the next action', {
  timeout: 30000,
}, async (t) => {
  const failure = chatFailure({
    stage: 'stream',
    kind: 'usage-limit',
    message: 'The weekly limit is reached.',
    resetsAt: '2026-10-20T00:00:00.000Z',
  });
  const { controller, send, read } = await chat(t, [
    [{ kind: 'fail', stopReason: 'limit', failure }],
  ]);
  const failed = turnReaches(controller, 'failed');
  await send('Refactor the cart.');
  const turn = await failed;

  assert.deepEqual(turn.failure, failure);
  assert.equal(turn.assistantMessageId, null);
  const thread = await read();
  assert.deepEqual(thread.messages.at(-1)?.author, { kind: 'system', turnId: turn.id });
  assert.equal(thread.messages.at(-1)?.text, `${failure.message} ${failure.nextAction}`);
  assert.equal(thread.thread.activeTurnId, null);
});

// Tests that need their own catalog, adapters or process checks build the service directly. The
// controller fixture reads its catalog from the clients on this machine. `start` builds another
// service on the same store, the way a controller restart does.
function standalone(t: TestContext, deps: Partial<ChatServiceDeps> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-chat-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = createTestClock();
  const ids = createTestIds(clock.now());
  const fixtures = createDemoFixtures(clock.now());
  const repository = createSyntheticRepository(join(directory, 'demo-shop'));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const project: Project = { id: fixtures.task.projectId, name: 'demo-shop', revision: 0 };
  store.transaction(() => {
    store.put('project', project.id, 0, project);
    store.put('task', fixtures.task.id, 0, fixtures.task);
  });
  const taskId = fixtures.task.id;
  const start = () =>
    new ChatService({
      store,
      artifacts: new ArtifactFiles(join(directory, 'artifacts')),
      home: directory,
      now: clock.now,
      id: (prefix) => (prefix === 'trn' ? `trn_${ids('msg').slice(4)}` : ids(prefix)),
      emit: (type, taskId, revision, payload) =>
        store.append({
          protocol: 1,
          id: ids('evt'),
          at: clock.now(),
          taskId,
          revision,
          type,
          payload,
        }),
      adapters: new Map(),
      resolveEnvironment: () => ({}),
      projectPath: () => repository.directory,
      resolveSelection: (_taskId, value) => value ?? null,
      catalog: () => ({ families: [] }),
      ...deps,
    });
  const service = start();
  const send = (
    text: string,
    choice: ChatModelSelection | null = selection,
    on = service,
  ): CommandResult => {
    const effects: (() => void)[] = [];
    const result = store.transaction(() =>
      on.sendMessage(
        {
          taskId,
          text,
          role: 'assistant',
          attachments: [],
          files: [],
          ...(choice ? { selection: choice } : {}),
        },
        effects,
      ),
    );
    for (const effect of effects) effect();
    return result;
  };
  const read = (on = service) => on.readThread({ taskId, limit: 100 });
  return { clock, store, taskId, service, start, send, read, root: repository.directory };
}

/** A catalog entry with one model and one weekly window. */
function familyEntry(
  family: ChatFamily,
  percent: number,
  resetsAt: string | null,
  observedAt: string,
): ChatCatalogRead['families'][number] {
  return {
    family,
    connected: true,
    reason: null,
    models: [
      { model: `${family}-model`, label: family, efforts: ['default'], defaultEffort: 'default' },
    ],
    defaultModel: `${family}-model`,
    remaining: [{ windowId: 'weekly', label: 'weekly', percent, resetsAt, observedAt }],
    accepts: null,
  };
}

test('startup recovery fails a turn whose controller stopped before it finished', (t) => {
  const { store, taskId, start, read } = standalone(t, {
    adapters: new Map([['openai', createScriptedChatAdapter({ family: 'openai', turns: [] })]]),
  });
  // The command commits, then the process ends before its launch effect runs.
  store.transaction(() =>
    start().sendMessage(
      {
        taskId,
        text: 'Start the change.',
        selection,
        role: 'assistant',
        attachments: [],
        files: [],
      },
      [],
    ),
  );

  const restarted = start();
  restarted.recover();
  const thread = read(restarted);
  const [turn] = thread.turns;
  assert.equal(turn.state, 'failed');
  assert.equal(turn.failure?.kind, 'internal');
  assert.equal(turn.failure?.message, 'The turn did not finish before the controller restarted.');
  assert.equal(thread.thread.activeTurnId, null);
  assert.deepEqual(thread.messages.at(-1)?.author, { kind: 'system', turnId: turn.id });
});

// The test replaces the process table and the boot instant, so no group number is signaled for
// real.
test('a provider process that outlives its turn blocks the thread until a later check finds it gone', {
  timeout: 30000,
}, async (t) => {
  const group = 4242;
  const reused = 4300;
  const present = new Set([group]);
  const signals: string[] = [];
  let booted = new Date(0).toISOString();
  const thread = standalone(t, {
    adapters: new Map([
      [
        'openai',
        createScriptedChatAdapter({
          family: 'openai',
          groups: [group, reused],
          turns: [[{ kind: 'text', itemId: 'reply', chunks: ['Done.'] }]],
        }),
      ],
    ]),
    groupAbsent: (value) => !present.has(value),
    signalGroup: (value, signal) => {
      signals.push(`${value} ${signal}`);
    },
    schedule: (work) => {
      setImmediate(work);
      return () => {};
    },
    bootedAt: () => booted,
  });
  const { store, taskId } = thread;
  // The second group has exited by the time the turn row first saves its groups. Later in the
  // turn its number belongs to another process.
  const stop = store.subscribe((event) => {
    if (event.type !== 'chat.turn' || !event.payload.groups) return;
    present.add(reused);
    stop();
  });
  const failed = turnReaches(thread, 'failed');
  thread.send('Fix the rounding.');
  const turn = await failed;
  present.delete(reused);

  assert.deepEqual(signals, [`${group} SIGTERM`, `${group} SIGKILL`]);
  assert.deepEqual(
    [turn.failure?.message, turn.failure?.nextAction],
    [
      'The provider process (group 4242) did not exit.',
      'Quit process group 4242, then send again.',
    ],
  );
  assert.deepEqual(turn.groups, [group]);
  const completed = agentEvents(thread).at(-1);
  assert.equal(completed?.type === 'turn.completed' && completed.stopReason, 'error');
  assert.equal(thread.read().thread.ownershipUnknown, true);
  const accept = store.transaction(() =>
    thread.service.accept({ taskId, branch: 'crewkite/fix-rounding' }, undefined),
  );
  assert.deepEqual(
    [accept.reason, accept.next],
    ['ownership-unknown', 'Quit process group 4242, then accept.'],
  );

  // A message sent meanwhile waits. A restart while the group is present keeps the block and
  // starts nothing.
  assert.equal(thread.send('Again.').outcome, 'applied');
  const restarted = thread.start();
  restarted.recover();
  const blocked = thread.read(restarted);
  assert.equal(blocked.thread.ownershipUnknown, true);
  assert.deepEqual(
    blocked.thread.queued.map((message) => message.text),
    ['Again.'],
  );
  assert.equal(blocked.turns.length, 1);
  // Once the group is gone, the next send checks again without a restart. The waiting message
  // goes first.
  present.clear();
  const idle = settles(thread);
  assert.equal(thread.send('And again.', selection, restarted).outcome, 'applied');
  const after = thread.read(restarted);
  assert.equal(after.thread.ownershipUnknown, undefined);
  assert.equal(after.turns[0].groups, undefined);
  assert.equal(after.messages.at(-1)?.text, 'Again.');
  assert.deepEqual(
    after.thread.queued.map((message) => message.text),
    ['And again.'],
  );
  await idle;

  // No process survives a reboot, so a group saved before one is gone even when its number is
  // in use again.
  present.add(group);
  const held = turnReaches(thread, 'failed');
  thread.send('Once more.', selection, restarted);
  assert.deepEqual((await held).groups, [group]);
  booted = thread.clock.advance(60_000);
  const rebooted = thread.start();
  rebooted.recover();
  const clear = thread.read(rebooted);
  assert.equal(clear.thread.ownershipUnknown, undefined);
  assert.equal(clear.turns.at(-1)?.groups, undefined);
});

// The first turn parks on a permission request, so later messages have a turn to wait behind. Each
// row ends that turn its own way: the answer lets it finish, or Stop ends it.
test('a message sent during a turn waits and starts when the turn ends', {
  timeout: 30000,
}, async (t) => {
  const first = 'Fix the rounding.';
  const later = ['Then the totals.', 'Then the docs.'];
  const many = Array.from({ length: 9 }, (_, index) => `Step ${index + 1}.`);
  const full = ['queue-full', 'Wait for a queued message to start, or remove one.'];
  const cases = [
    {
      name: 'queue then start',
      send: later,
      remove: null,
      end: 'answer',
      asked: [first, ...later],
    },
    { name: 'stop clears', send: later, remove: null, end: 'stop', asked: [first] },
    {
      name: 'dequeue removes',
      send: later,
      remove: later[0],
      end: 'answer',
      asked: [first, later[1]],
    },
    { name: 'queue-full refuses', send: many, remove: null, end: 'stop', asked: [first] },
  ];
  const users = (read: ChatThreadRead) => read.messages.filter((m) => m.author.kind === 'user');
  for (const row of cases) {
    const thread = standalone(t, {
      adapters: new Map([
        [
          'openai',
          createScriptedChatAdapter({
            family: 'openai',
            turns: [
              [
                { kind: 'permission', requestId: 'edit-1', question: 'Edit net.mjs?' },
                { kind: 'text', itemId: 'reply', chunks: ['Done.'] },
              ],
              [{ kind: 'text', itemId: 'reply', chunks: ['Done.'] }],
            ],
          }),
        ],
      ]),
    });
    const { store, service, taskId } = thread;
    const parked = turnReaches(thread, 'waiting-permission');
    thread.send(first);
    const { id: turnId } = await parked;
    const refused = row.send
      .map((text) => thread.send(text))
      .flatMap((result) => (result.outcome === 'applied' ? [] : [[result.reason, result.next]]));
    assert.deepEqual(refused, row.send.length > 8 ? [full] : [], row.name);
    const waiting = thread.read();
    assert.deepEqual(
      users(waiting).map((message) => message.text),
      [first],
      row.name,
    );
    assert.deepEqual(
      waiting.thread.queued.map((message) => message.text),
      row.send.slice(0, 8),
      row.name,
    );
    const removed = waiting.thread.queued.find((message) => message.text === row.remove);
    if (removed) store.transaction(() => service.configure({ taskId, dequeue: removed.id }));

    const idle = settles(thread);
    const effects: (() => void)[] = [];
    const ended = store.transaction(() =>
      row.end === 'stop'
        ? service.stopTurn({ taskId, turnId }, effects)
        : service.resolvePermission(
            { taskId, turnId, requestId: 'edit-1', choice: 'allow-once' },
            effects,
          ),
    );
    // Stop hands the cleared messages back, so the composer can offer the text again.
    if (row.end === 'stop')
      assert.deepEqual(
        ended.data?.kind === 'chat-queue' ? ended.data.messages.map((m) => m.text) : null,
        row.send.slice(0, 8),
        row.name,
      );
    for (const effect of effects) effect();
    await idle;

    const after = thread.read();
    assert.deepEqual(
      users(after).map((message) => message.text),
      row.asked,
      row.name,
    );
    // A queued message joins the conversation under the ID it had while it waited.
    const started = waiting.thread.queued
      .filter((message) => row.asked.includes(message.text))
      .map((message) => message.id);
    assert.deepEqual(
      users(after)
        .slice(1)
        .map((message) => message.id),
      started,
      row.name,
    );
    assert.deepEqual(
      after.turns.slice(1).map((turn) => turn.userMessageId),
      started,
      row.name,
    );
  }
});

test('a thread read returns messages in cursor order and the live events of the open turn', {
  timeout: 30000,
}, async (t) => {
  const { controller, send, read, run, command, draft } = await chat(t, [
    [{ kind: 'text', itemId: 'first', chunks: ['First reply.'] }],
    [{ kind: 'text', itemId: 'second', chunks: ['Working'], complete: false }, { kind: 'wait' }],
  ]);
  const first = turnReaches(controller, 'done');
  await send('First question.');
  await first;
  const streaming = next(
    controller,
    (event) => event.type === 'agent.event' && event.payload.type === 'text.delta',
  );
  await send('Second question.');
  const streamed = await streaming;
  const { turnId } = streamed.payload as AgentEvent;

  const thread = await read();
  assert.deepEqual(
    thread.messages.map((message) => message.text),
    ['First question.', 'First reply.', 'Second question.'],
  );
  // The open turn waits after its delta, so the delta is the newest event the read reflects.
  assert.equal(thread.cursor, streamed.cursor);
  const cursors = thread.messages.map((message) => BigInt(message.cursor));
  assert.deepEqual(
    cursors,
    [...cursors].sort((left, right) => (left < right ? -1 : 1)),
  );
  assert.deepEqual(
    thread.liveEvents.map((event) => [event.type, event.turnId]),
    [
      ['turn.started', turnId],
      ['text.delta', turnId],
    ],
  );
  assert.deepEqual(
    thread.turns.map((turn) => turn.state),
    ['done', 'running'],
  );
  const earlier = await read({ beforeCursor: thread.messages[2].cursor, limit: 1 });
  assert.deepEqual(
    earlier.messages.map((message) => message.text),
    ['First reply.'],
  );

  // A turn's stored events read back whole, oldest first, a page at a time under the cap.
  const [done, running] = thread.turns;
  const turnEvents = (payload: object) => run('ReadChatTurnEvents', payload);
  const pageOf = (result: CommandResult) => {
    assert.equal(result.outcome, 'applied', result.next);
    return result.data as ChatTurnEventsRead;
  };
  const stored = (turnId: string) =>
    agentEvents(controller).filter((event) => event.turnId === turnId);
  const whole = pageOf(await turnEvents({ turnId: done.id }));
  assert.deepEqual(whole.events, stored(done.id));
  assert.equal(whole.nextAfterCursor, null);
  assert.deepEqual(pageOf(await turnEvents({ turnId: running.id })).events, stored(running.id));
  let serial = 0;
  const append = (event: AgentEvent) => {
    serial += 1;
    return controller.store.transaction(() =>
      controller.store.append({
        protocol: 1,
        id: `evt_7${String(serial).padStart(25, '0')}`,
        at: '2026-10-25T10:00:00.000Z',
        taskId: done.taskId,
        revision: 0,
        type: 'agent.event',
        payload: event,
      }),
    );
  };
  const large = Array.from({ length: 12 }, (_, index) =>
    append({
      type: 'text.delta',
      turnId: done.id,
      itemId: 'large',
      text: 'abcdefghijkl'[index].repeat(60_000),
    }),
  );
  // The cursor is exclusive, so the read starts after the last event the turn already had.
  const pages = [pageOf(await turnEvents({ turnId: done.id, afterCursor: thread.cursor }))];
  for (let after = pages[0].nextAfterCursor; after; after = pages.at(-1)?.nextAfterCursor ?? null)
    pages.push(pageOf(await turnEvents({ turnId: done.id, afterCursor: after })));
  assert.ok(pages.length > 1);
  for (const page of pages)
    assert.ok(Buffer.byteLength(JSON.stringify({ kind: 'chat-turn-events', ...page })) <= 524_288);
  assert.deepEqual(
    pages.flatMap((page) => page.events),
    large.map((event) => event.payload),
  );
  // An event that alone exceeds the page is refused, and no later event is skipped past it.
  const oversized = append({
    type: 'tool.started',
    turnId: done.id,
    callId: 'call-1',
    kind: 'read',
    title: 'Read a large file',
    input: 'x'.repeat(600_000),
  });
  const refused = await turnEvents({ turnId: done.id, afterCursor: large.at(-1)?.cursor });
  assert.equal(refused.outcome, 'blocked');
  assert.equal(refused.reason, 'turn-event-too-large');
  assert.equal(
    pageOf(await turnEvents({ turnId: done.id, afterCursor: oversized.cursor })).events.length,
    0,
  );
  // A turn is read only through the thread it belongs to.
  const other = (await controller.execute(command('CreateTask', draft.payload, 0), 'local-owner'))
    .entity as Task;
  const foreign = await controller.execute(
    command('ReadChatTurnEvents', { taskId: other.id, turnId: done.id }),
    'local-owner',
  );
  assert.equal(foreign.outcome, 'blocked');
  assert.equal(foreign.reason, 'turn-not-found');
});

// A limit stop needs a second connected family, so these tests bring a catalog of their own.
function limitThread(
  t: TestContext,
  options: { autoHandoff: boolean; resetsAt: string | null; handoffMode?: ChatHandoffMode },
) {
  const limit = chatFailure({
    stage: 'stream',
    kind: 'usage-limit',
    message: 'The weekly limit is reached.',
    resetsAt: options.resetsAt,
  });
  const reply = (text: string): ChatScriptStep[][] => [
    [{ kind: 'text', itemId: 'reply', chunks: [text] }],
  ];
  const scripted = createScriptedChatAdapter({
    family: 'openai',
    turns: [[{ kind: 'fail', stopReason: 'limit', failure: limit }]],
  });
  // The stopped provider had edited a file and was in the middle of a command when the limit hit.
  const stopped = {
    ...scripted,
    startTurn(request: ScriptedChatRequest, emit: (event: AgentEvent) => void) {
      appendFileSync(join(request.scratch.directory, 'net.mjs'), '// half done\n');
      const handle = scripted.startTurn(request, emit);
      emit({
        type: 'tool.started',
        turnId: request.turnId,
        callId: 'call-1',
        kind: 'command',
        title: 'Run the tests',
      });
      return handle;
    },
  };
  const adapters = new Map([
    ['openai', stopped],
    ['anthropic', createScriptedChatAdapter({ family: 'anthropic', turns: reply('Not chosen.') })],
    ['google', createScriptedChatAdapter({ family: 'google', turns: reply('Carrying on.') })],
    ['local', createScriptedChatAdapter({ family: 'local', turns: reply('Not chosen.') })],
  ] as const);
  // The test clock starts at the same fixed time in every service it builds.
  const now = createTestClock().now();
  const inHours = (count: number) => new Date(Date.parse(now) + count * 3_600_000).toISOString();
  // OpenAI has the most left but it is the family that stopped. Google and Anthropic tie on
  // percent, so the sooner reset decides. Local resets first but has less left.
  const families = [
    familyEntry('openai', 99, inHours(1), now),
    familyEntry('anthropic', 80, inHours(5), now),
    familyEntry('google', 80, inHours(2), now),
    familyEntry('local', 60, inHours(1), now),
  ];
  const settled: [string, string][] = [];
  const thread = standalone(t, {
    adapters,
    catalog: () => ({ families }),
    onTurnSettled: (family, taskId) => settled.push([family, taskId]),
  });
  const { store, service, taskId } = thread;
  store.transaction(() =>
    service.configure({
      taskId,
      autoHandoff: options.autoHandoff,
      ...(options.handoffMode ? { handoffMode: options.handoffMode } : {}),
    }),
  );
  return { ...thread, adapters, limit, settled };
}

test('a usage limit writes a system line, and auto handoff runs the same message once on the next family', {
  timeout: 30000,
}, async (t) => {
  const on = limitThread(t, { autoHandoff: true, resetsAt: '2026-10-23T14:00:00.000Z' });
  const idle = settles(on);
  on.send('Fix the rounding.');
  // Sent while the first turn runs. It waits for the rerun and follows the thread to Google.
  on.send('Then the totals.');
  await idle;

  const thread = on.read();
  const line = 'OpenAI reached its usage limit. Resets at 2026-10-23 14:00 UTC.';
  assert.deepEqual(
    thread.messages.map((message) => message.text),
    [
      'Fix the rounding.',
      line,
      `${on.limit.message} ${on.limit.nextAction}`,
      'Continued on Google from OpenAI. Reason: usage limit reached.',
      'Carrying on.',
      'Then the totals.',
      'Carrying on.',
    ],
  );
  assert.deepEqual(
    thread.turns.map((turn) => [
      turn.state,
      turn.stopReason,
      turn.selection.family,
      turn.handoffFrom,
    ]),
    [
      ['failed', 'limit', 'openai', null],
      ['done', 'done', 'google', 'openai'],
      ['done', 'done', 'google', null],
    ],
  );
  assert.equal(thread.turns[1].userMessageId, thread.turns[0].userMessageId);
  assert.deepEqual(on.settled, [
    ['openai', on.taskId],
    ['google', on.taskId],
    ['google', on.taskId],
  ]);
  assert.equal(thread.thread.selection?.model, 'google-model');
  assert.equal(thread.thread.sessions[0]?.sessionId, `session-${thread.turns[2].id}`);
  const [request] = on.adapters.get('google')?.requests ?? [];
  assert.match(request.prompt, /moved from OpenAI to Google\. Reason: usage limit reached\./);
  assert.match(request.prompt, /New message:\nFix the rounding\./);
  assert.match(request.prompt, /^net\.mjs \+1 -0$/m);
  assert.match(request.prompt, /^\+\/\/ half done$/m);
  assert.match(
    request.prompt,
    /^OpenAI ended its last turn early\. Reason: usage limit reached\./m,
  );
  assert.match(request.prompt, /^In progress when it stopped: Run the tests \(command\)\.$/m);
  assert.ok(Buffer.byteLength(request.prompt) < 96 * 1024);
  for (const family of ['anthropic', 'local'] as const)
    assert.equal(on.adapters.get(family)?.requests.length, 0);

  // Under resets-first, Local's allowance goes before Google's: it resets in an hour.
  const soonest = limitThread(t, {
    autoHandoff: true,
    resetsAt: null,
    handoffMode: 'resets-first',
  });
  const moved = settles(soonest);
  soonest.send('Fix the rounding.');
  await moved;
  assert.deepEqual(
    soonest.read().turns.map((turn) => [turn.selection.family, turn.handoffFrom]),
    [
      ['openai', null],
      ['local', 'openai'],
    ],
  );

  const off = limitThread(t, { autoHandoff: false, resetsAt: null });
  const stopped = turnReaches(off, 'failed');
  off.send('Fix the rounding.');
  // Queued during the turn. With no move it would stop on the same limit, so it waits.
  off.send('Then the totals.');
  await stopped;

  const kept = off.read();
  assert.deepEqual(
    kept.messages.map((message) => message.text),
    [
      'Fix the rounding.',
      'OpenAI reached its usage limit. Resets at an unknown time.',
      `${off.limit.message} ${off.limit.nextAction}`,
    ],
  );
  assert.equal(kept.turns.length, 1);
  assert.equal(kept.thread.selection?.family, 'openai');
  assert.equal(kept.thread.activeTurnId, null);
  assert.deepEqual(
    kept.thread.queued.map((message) => message.text),
    ['Then the totals.'],
  );
  off.store.transaction(() =>
    off.service.configure({ taskId: off.taskId, dequeue: kept.thread.queued[0].id }),
  );

  // A family picked in the composer starts cold, so it gets the packet too.
  const picked = { family: 'google', model: 'google-model', effort: 'default' } as const;
  off.store.transaction(() => off.service.configure({ taskId: off.taskId, selection: picked }));
  const switched = turnReaches(off, 'done');
  off.send('Go on.', null);
  await switched;
  assert.match(
    off.adapters.get('google')?.requests[0]?.prompt ?? '',
    /^This thread moved from OpenAI to Google\. Reason: switched in the composer\.$/m,
  );

  // Google answered last. A pick of Local in the composer, a Continue on Anthropic and a second
  // pick of Local still leave Local starting cold, so it gets the packet from Google.
  const pick = (family: ChatFamily): ChatModelSelection => ({
    family,
    model: `${family}-model`,
    effort: 'default',
  });
  const { store, service, taskId } = off;
  store.transaction(() => service.configure({ taskId, selection: pick('local') }));
  store.transaction(() =>
    service.handoff({ taskId, selection: pick('anthropic'), reason: 'manual' }),
  );
  store.transaction(() => service.configure({ taskId, selection: pick('local') }));
  const local = turnReaches(off, 'done');
  off.send('Keep going.', null);
  await local;
  assert.equal(
    off.read().messages.at(-3)?.text,
    'Continued on Anthropic from Google. Reason: switched in the composer.',
  );
  assert.match(
    off.adapters.get('local')?.requests[0]?.prompt ?? '',
    /^This thread moved from Google to Local\. Reason: switched in the composer\.$/m,
  );
});

// Every connected family stops on its limit. At zero the catalog offers nothing. At 50 percent it
// is stale, so the thread moves once, stops on the second limit and leaves the choice to the
// person.
test('auto handoff moves a message at most once and never to a family at zero', {
  timeout: 30000,
}, async (t) => {
  const limit = chatFailure({ stage: 'stream', kind: 'usage-limit', message: 'Limit.' });
  const failing = (family: ChatFamily) =>
    createScriptedChatAdapter({
      family,
      turns: [[{ kind: 'fail', stopReason: 'limit', failure: limit }]],
    });
  // Each turn as [family, handoffFrom], and the last line the thread shows.
  const cases = [
    { percent: 0, turns: [['openai', null]], line: limit.nextAction },
    {
      percent: 50,
      turns: [
        ['openai', null],
        ['google', 'openai'],
      ],
      line: 'Automatic handoff already moved this message once. Pick a provider to continue.',
    },
  ] as const;
  for (const { percent, turns, line } of cases) {
    const now = createTestClock().now();
    const families = [
      familyEntry('openai', percent, null, now),
      familyEntry('google', percent, null, now),
    ];
    const thread = standalone(t, {
      adapters: new Map([
        ['openai', failing('openai')],
        ['google', failing('google')],
      ]),
      catalog: () => ({ families }),
    });
    thread.store.transaction(() =>
      thread.service.configure({ taskId: thread.taskId, autoHandoff: true }),
    );
    const last = turns.at(-1)?.[0];
    // A further move would open its turn before this event's listeners run.
    const settled = next(
      thread,
      (event) =>
        event.type === 'chat.turn' &&
        event.payload.state === 'failed' &&
        event.payload.selection.family === last,
    );
    thread.send('Go.');
    await settled;

    const read = thread.read();
    assert.deepEqual(
      read.turns.map((turn) => [turn.selection.family, turn.handoffFrom]),
      turns,
      `${percent} percent`,
    );
    assert.ok(read.turns.every((turn) => turn.stopReason === 'limit'));
    assert.equal(read.thread.activeTurnId, null);
    assert.ok(read.messages.at(-1)?.text.endsWith(line), `${percent} percent`);
  }
});

test('a reviewer turn runs read only with the review brief and the ask policy, whatever the thread allows', {
  timeout: 30000,
}, async (t) => {
  const { controller, adapter, task, run, send, read } = await chat(t, [
    [{ kind: 'text', itemId: 'answer', chunks: ['Changed net.mjs.'] }],
    [{ kind: 'text', itemId: 'review', chunks: ['One finding.'] }],
  ]);
  const configure = { permissionPolicy: 'allow-all' };
  assert.equal((await run('ConfigureChatThread', configure, task.revision)).outcome, 'applied');
  const first = turnReaches(controller, 'done');
  await send('Change net.mjs.');
  await first;
  // The scripted adapter hands back the request it received, which carries these two fields.
  const requests = adapter.requests as unknown as ChatTurnRequest[];
  appendFileSync(join(requests[0].scratch.directory, 'net.mjs'), '// reviewed\n');

  const second = turnReaches(controller, 'done');
  const review = { text: 'Review the current changes.', role: 'reviewer', selection };
  assert.equal((await run('SendChatMessage', review, task.revision)).outcome, 'applied');
  await second;

  const [assistant, reviewer] = requests;
  assert.equal(assistant.permissionPolicy, 'allow-all');
  assert.equal(assistant.readOnly, false);
  assert.equal(reviewer.permissionPolicy, 'ask');
  assert.equal(reviewer.readOnly, true);
  assert.equal(reviewer.session, null);
  assert.match(reviewer.systemContext, /ordered by severity/);
  assert.match(reviewer.systemContext, /Do not edit/);
  assert.match(reviewer.systemContext, /^net\.mjs \+1 -0$/m);
  assert.match(reviewer.systemContext, /^\+\/\/ reviewed$/m);
  const thread = await read();
  assert.equal(thread.thread.permissionPolicy, 'allow-all');
  assert.equal(thread.thread.sessions.length, 1);
  assert.equal(thread.turns.at(-1)?.role, 'reviewer');
});

// The scripted adapter has no allow-thread option and no tool event, so this one plays what a real
// adapter emits for a tool call: tool.started, then permission.requested for the same call. Turn N
// asks about `asks[N]`: a tool kind, null for a request with no tool call, or nothing once the
// list runs out. It keeps every request it receives.
function editingAdapter(asks: readonly (ChatToolKind | null)[], input?: unknown) {
  const requests: ChatTurnRequest[] = [];
  const adapter: ChatAdapter = {
    family: 'openai',
    startTurn(request, emit) {
      const ask = asks[requests.length];
      requests.push(request);
      const { turnId } = request;
      let answer = (_choice: string) => {};
      const result = (async (): Promise<ChatTurnResult> => {
        await Promise.resolve();
        emit({
          type: 'turn.started',
          turnId,
          family: 'openai',
          model: request.selection.model,
          effort: request.selection.effort,
          role: request.role,
        });
        if (ask !== undefined) {
          const choice = new Promise<string>((resolve) => {
            answer = resolve;
          });
          if (ask)
            emit({
              type: 'tool.started',
              turnId,
              callId: 'call-1',
              kind: ask,
              title: 'net',
              input,
            });
          emit({
            type: 'permission.requested',
            turnId,
            requestId: 'edit-1',
            callId: ask ? 'call-1' : null,
            question: 'Go ahead?',
            detail: null,
            ...((input as { deletes?: boolean } | undefined)?.deletes ? { deletes: true } : {}),
            options: [
              { id: 'allow-once', label: 'Allow once', kind: 'allow-once' },
              { id: 'allow-thread', label: 'Allow for this thread', kind: 'allow-thread' },
              { id: 'deny', label: 'Deny', kind: 'deny' },
            ],
          });
          emit({ type: 'permission.resolved', turnId, requestId: 'edit-1', choice: await choice });
        }
        emit({ type: 'turn.completed', turnId, stopReason: 'done', failure: null });
        return {
          stopReason: 'done',
          failure: null,
          assistantText: '',
          session: null,
          usage: null,
          changedPaths: [],
        };
      })();
      return { respondPermission: (_id, choice) => answer(choice), stop() {}, groups: [], result };
    },
  };
  return Object.assign(adapter, { requests });
}

// The edit grant is kept. An ask with no tool call and an ask during a review stay with their turn.
test('allow for this thread records the tool kind for later assistant turns and nothing else', {
  timeout: 30000,
}, async (t) => {
  const { controller, adapter, task, run, send, read } = await open(
    t,
    editingAdapter(['edit', null, 'command']),
  );
  const allow = async (sent: () => Promise<CommandResult>) => {
    const parked = turnReaches(controller, 'waiting-permission');
    const done = turnReaches(controller, 'done');
    await sent();
    const turn = await parked;
    const answer = { turnId: turn.id, requestId: 'edit-1', choice: 'allow-thread' };
    assert.equal((await run('ResolveChatPermission', answer, 0)).outcome, 'applied');
    await done;
  };
  await allow(() => send('Fix the rounding.'));
  await allow(() => send('Run the build.'));
  const review = { text: 'Review it.', role: 'reviewer', selection };
  await allow(() => run('SendChatMessage', review, task.revision));
  assert.deepEqual((await read()).thread.permissionGrants, ['edit']);

  const last = turnReaches(controller, 'done');
  await send('Now the totals.');
  await last;
  assert.deepEqual(
    adapter.requests.map((request) => request.permissionGrants),
    [[], ['edit'], [], ['edit']],
  );
});

test('accept commits the scratch edit on the base as a new branch and leaves the checkout alone', {
  timeout: 30000,
}, async (t) => {
  const { controller, adapter, task, run, send, read, source } = await chat(t, [
    [{ kind: 'text', itemId: 'reply', chunks: ['Edited.'] }],
  ]);
  const repo = (...args: string[]) => git(source.directory, args).toString('utf8').trim();
  const identity = {
    name: 'Fixture',
    email: 'fixture@example.invalid',
    at: '2026-10-15T18:00:00Z',
  };
  // Commit a tree on main without touching the checkout or the index.
  const advance = (tree: string) =>
    repo(
      'update-ref',
      'refs/heads/main',
      git(source.directory, ['commit-tree', tree, '-p', 'HEAD'], 'move\n', identity)
        .toString()
        .trim(),
    );
  // The base holds a link that stays inside and a submodule the copy skips.
  const blob = git(source.directory, ['hash-object', '-w', '--stdin'], 'net.mjs').toString().trim();
  const vendor = git(source.directory, ['mktree'], `160000 commit ${'c'.repeat(40)}\tlib\n`)
    .toString()
    .trim();
  advance(
    git(
      source.directory,
      ['mktree'],
      `${repo('ls-tree', 'HEAD')}\n120000 blob ${blob}\tNOTES.md\n040000 tree ${vendor}\tvendor\n`,
    )
      .toString()
      .trim(),
  );
  const done = turnReaches(controller, 'done');
  await send('Fix the rounding.');
  await done;
  const pinned = () => repo('rev-parse', threadBaseRef(task.id));
  const started = await read();
  assert.deepEqual(started.thread.skipped, [{ path: 'vendor/lib', reason: 'submodule' }]);
  assert.equal(pinned(), started.thread.base);
  const scratch = adapter.requests[0].scratch.directory;
  // The edit goes through the link. The file under the skipped submodule is never accepted.
  appendFileSync(join(scratch, 'NOTES.md'), '// accepted\n');
  mkdirSync(join(scratch, 'vendor', 'lib'), { recursive: true });
  writeFileSync(join(scratch, 'vendor', 'lib', 'extra.txt'), 'local only\n');
  const checkout = () => [
    repo('rev-parse', 'HEAD'),
    repo('symbolic-ref', 'HEAD'),
    repo('status', '--porcelain=v1', '--untracked-files=all'),
  ];
  const before = checkout();
  const base = before[0];
  const branch = 'refs/heads/crewkite/fix-rounding';
  const accept = () => run('AcceptChatChanges', { branch: 'crewkite/fix-rounding' }, task.revision);

  const result = await accept();
  assert.equal(result.outcome, 'applied');
  const commit = repo('rev-parse', branch);
  assert.deepEqual(result.data, {
    kind: 'chat-acceptance',
    branch: 'crewkite/fix-rounding',
    commit,
    fileCount: 1,
  });
  assert.equal(repo('rev-parse', `${branch}^`), base);
  assert.equal(repo('rev-list', '--count', `${base}..${branch}`), '1');
  assert.equal(repo('diff', '--name-only', base, branch), 'net.mjs');
  assert.match(repo('show', `${branch}:net.mjs`), /\/\/ accepted$/);
  assert.equal(
    repo('ls-tree', '-r', branch, 'NOTES.md', 'vendor'),
    repo('ls-tree', '-r', base, 'NOTES.md', 'vendor'),
  );
  assert.equal(
    repo('log', '-1', '--format=%s|%an <%ae>', branch),
    `CrewKite: ${task.title}|Fixture owner <owner@example.invalid>`,
  );
  assert.deepEqual(checkout(), before);
  assert.equal(pinned(), commit);
  const thread = await read();
  assert.equal(thread.thread.lastAcceptance?.commit, commit);
  assert.equal(thread.messages.at(-1)?.text, 'Accepted 1 file to branch crewkite/fix-rounding.');

  assert.equal((await accept()).reason, 'branch-exists');
  assert.equal(repo('rev-parse', branch), commit);

  // The push runs outside the command transaction and still journals the thread.
  const remote = join(source.directory, '..', 'remote.git');
  git(source.directory, ['init', '--quiet', '--bare', remote]);
  repo('remote', 'add', 'origin', remote);
  const pushed = await run(
    'PushChatBranch',
    { branch: 'crewkite/fix-rounding', confirmed: true },
    task.revision,
  );
  assert.equal(pushed.outcome, 'applied');
  assert.equal(git(remote, ['rev-parse', branch]).toString('utf8').trim(), commit);
  const after = await read();
  assert.equal(after.thread.lastPush?.commit, commit);
  assert.equal(after.messages.at(-1)?.text, 'Pushed crewkite/fix-rounding to origin.');

  // The base advanced to the accepted commit, so Changes is empty and the next Accept stacks on it.
  // Every read loads the thread record from the store, so a restarted controller sees the same base.
  assert.equal(after.thread.base, commit);
  const changes = await run('ReadChatChanges', {});
  assert.deepEqual(changes.data, {
    kind: 'chat-changes',
    taskId: task.id,
    base: commit,
    files: [],
  });
  // HEAD moves on. Accept still starts from the thread's base and leaves HEAD where it is.
  advance(repo('rev-parse', 'HEAD^{tree}'));
  const moved = checkout();
  appendFileSync(join(scratch, 'net.mjs'), '// second\n');
  const second = await run('AcceptChatChanges', { branch: 'crewkite/second' }, task.revision);
  const note = `The branch starts at this thread's base commit ${commit.slice(0, 7)}. HEAD stays where it is.`;
  assert.deepEqual([second.outcome, second.next], ['applied', note]);
  const stacked = repo('rev-parse', 'refs/heads/crewkite/second');
  assert.equal(repo('rev-parse', 'refs/heads/crewkite/second^'), commit);
  assert.equal(repo('diff', '--name-only', commit, stacked), 'net.mjs');
  assert.deepEqual(checkout(), moved);
  const last = await read();
  assert.equal(last.thread.base, stacked);
  assert.equal(pinned(), stacked);
  assert.equal(last.messages.at(-1)?.text, `Accepted 1 file to branch crewkite/second. ${note}`);
  // Thread delete removes the ref and nothing else.
  deleteThreadBaseRef(source.directory, task.id);
  assert.equal(repo('for-each-ref', 'refs/crewkite/'), '');
  assert.deepEqual(checkout(), moved);
});

test('accept and discard are refused while a turn is running', { timeout: 30000 }, async (t) => {
  const { controller, task, run, send } = await chat(t, [
    [{ kind: 'text', itemId: 'reply', chunks: ['Working'], complete: false }, { kind: 'wait' }],
  ]);
  const streaming = next(
    controller,
    (event) => event.type === 'agent.event' && event.payload.type === 'text.delta',
  );
  await send('Fix the rounding.');
  await streaming;

  const result = await run('AcceptChatChanges', { branch: 'crewkite/fix-rounding' }, task.revision);
  assert.deepEqual([result.outcome, result.reason], ['blocked', 'turn-running']);
  const discard = await run('DiscardChatChange', { path: 'net.mjs' }, task.revision);
  assert.deepEqual([discard.outcome, discard.reason], ['blocked', 'turn-running']);
});

test('discard restores, removes or recovers one path and refuses links and entries the copy never held', {
  timeout: 30000,
}, async (t) => {
  const { controller, adapter, task, run, send, read, source } = await chat(t, [
    [{ kind: 'text', itemId: 'reply', chunks: ['Edited.'] }],
  ]);
  const repo = (...args: string[]) => git(source.directory, args).toString('utf8').trim();
  // The base gains a link that stays inside and a submodule the copy skips.
  const blob = git(source.directory, ['hash-object', '-w', '--stdin'], 'net.mjs').toString().trim();
  const vendor = git(source.directory, ['mktree'], `160000 commit ${'c'.repeat(40)}\tlib\n`)
    .toString()
    .trim();
  const tree = git(
    source.directory,
    ['mktree'],
    `${repo('ls-tree', 'HEAD')}\n120000 blob ${blob}\tNOTES.md\n040000 tree ${vendor}\tvendor\n`,
  )
    .toString()
    .trim();
  const identity = {
    name: 'Fixture',
    email: 'fixture@example.invalid',
    at: '2026-10-15T18:00:00Z',
  };
  repo(
    'update-ref',
    'refs/heads/main',
    git(source.directory, ['commit-tree', tree, '-p', 'HEAD'], 'link\n', identity)
      .toString()
      .trim(),
  );
  const done = turnReaches(controller, 'done');
  await send('Fix the rounding.');
  await done;
  const scratch = adapter.requests[0].scratch.directory;
  const outside = mkdtempSync(join(tmpdir(), 'crewkite-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const committed = (path: string) => git(source.directory, ['show', `HEAD:${path}`]);
  appendFileSync(join(scratch, 'net.mjs'), '// changed\n');
  appendFileSync(join(scratch, 'sentinels/executable.sh'), '# changed\n');
  chmodSync(join(scratch, 'sentinels/executable.sh'), 0o644);
  mkdirSync(join(scratch, 'notes/new'), { recursive: true });
  writeFileSync(join(scratch, 'notes/new/added.txt'), 'added\n');
  rmSync(join(scratch, 'index.html'));
  const discard = (path: string) => run('DiscardChatChange', { path }, task.revision);
  const changed = async () =>
    ((await run('ReadChatChanges', {})).data as { files: { path: string }[] }).files.map(
      (file) => file.path,
    );
  assert.deepEqual(await changed(), [
    'index.html',
    'net.mjs',
    'notes/new/added.txt',
    'sentinels/executable.sh',
  ]);
  const rows: {
    path: string;
    reason?: string;
    line?: string;
    check?: () => void;
    before?: () => void;
  }[] = [
    {
      path: 'sentinels/executable.sh',
      line: 'Discarded the changes to sentinels/executable.sh. It matches the base commit',
      check: () => {
        assert.deepEqual(
          readFileSync(join(scratch, 'sentinels/executable.sh')),
          committed('sentinels/executable.sh'),
        );
        assert.equal(statSync(join(scratch, 'sentinels/executable.sh')).mode & 0o777, 0o755);
      },
    },
    {
      path: 'notes/new/added.txt',
      line: 'Discarded notes/new/added.txt, a file added in this thread.',
      check: () => assert.equal(existsSync(join(scratch, 'notes')), false),
    },
    {
      path: 'index.html',
      line: 'Restored index.html from the base commit',
      check: () =>
        assert.deepEqual(readFileSync(join(scratch, 'index.html')), committed('index.html')),
    },
    { path: 'index.html', reason: 'not-changed' },
    { path: 'NOTES.md', reason: 'link-path' },
    { path: 'vendor/lib', reason: 'skipped-path' },
    {
      path: 'vendor/lib/extra.txt',
      reason: 'skipped-path',
      before: () => {
        mkdirSync(join(scratch, 'vendor/lib'), { recursive: true });
        writeFileSync(join(scratch, 'vendor/lib/extra.txt'), 'local only\n');
      },
    },
    {
      path: 'linked.md',
      reason: 'link-path',
      before: () => symlinkSync('net.mjs', join(scratch, 'linked.md')),
    },
    {
      path: 'away/secret.txt',
      reason: 'outside-copy',
      before: () => {
        writeFileSync(join(outside, 'secret.txt'), 'keep\n');
        symlinkSync(outside, join(scratch, 'away'));
      },
    },
  ];
  for (const row of rows) {
    row.before?.();
    const result = await discard(row.path);
    if (row.reason) {
      assert.deepEqual([result.outcome, result.reason], ['blocked', row.reason], row.path);
      continue;
    }
    assert.equal(result.outcome, 'applied', row.path);
    assert.ok((await read()).messages.at(-1)?.text.startsWith(row.line ?? ''), row.path);
    row.check?.();
    // Accept carries only what is left.
    if (row.path === 'index.html') assert.deepEqual(await changed(), ['net.mjs']);
  }
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'keep\n');
  assert.match(readFileSync(join(scratch, 'net.mjs'), 'utf8'), /\/\/ changed\n$/);
});

// Builder and fixer run on OpenAI, the reviewer on Anthropic, the challenger on Google. The crew
// has no fixer of its own, so the fix runs on the builder's pick. A limit row stops the first
// review on Anthropic; Local has the most allowance left, so the step reruns there.
test('the crew chain runs review, fix, second review and challenger, and stops where a step stops', {
  timeout: 30000,
}, async (t) => {
  const pick = (family: ChatFamily): ChatModelSelection => ({
    family,
    model: `${family}-model`,
    effort: 'default',
  });
  const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];
  const limit = chatFailure({ stage: 'stream', kind: 'usage-limit', message: 'Limit.' });
  const limited: ChatScriptStep[] = [{ kind: 'fail', stopReason: 'limit', failure: limit }];
  const twoFindings = 'Rounding drops a cent in net.mjs.\nTotals skip tax.\nFindings: 2';
  const cases = [
    {
      name: 'findings 2 then 0',
      reviews: [reply(twoFindings), reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      turns: [
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
        ['fixer', 'openai'],
        ['reviewer', 'anthropic'],
        ['challenger', 'google'],
      ],
      line: 'Crew finished: 2 review rounds, 1 fix.',
      chain: { step: 'finished', reviewRounds: 2, fixes: 1, reason: null },
    },
    {
      name: 'findings 0 at once',
      reviews: [reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      turns: [
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
        ['challenger', 'google'],
      ],
      line: 'Crew finished: 1 review round, 0 fixes.',
      chain: { step: 'finished', reviewRounds: 1, fixes: 0, reason: null },
    },
    {
      name: 'no findings line',
      reviews: [reply('Looks fine to me.')],
      autoHandoff: undefined,
      turns: [
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
      ],
      line: 'Crew stopped: the review did not state its findings. Ask for a fix or review again.',
      chain: {
        step: 'stopped',
        reviewRounds: 1,
        fixes: 0,
        reason: 'The review did not state its findings.',
      },
    },
    {
      name: 'limit with handoff on',
      reviews: [limited],
      autoHandoff: undefined,
      turns: [
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
        ['reviewer', 'local'],
        ['challenger', 'google'],
      ],
      line: 'Crew finished: 1 review round, 0 fixes.',
      chain: { step: 'finished', reviewRounds: 1, fixes: 0, reason: null },
    },
    {
      name: 'limit with handoff off',
      reviews: [limited],
      autoHandoff: false,
      turns: [
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
      ],
      line: 'Crew stopped: Anthropic reached its usage limit.',
      chain: {
        step: 'stopped',
        reviewRounds: 0,
        fixes: 0,
        reason: 'Anthropic reached its usage limit.',
      },
    },
  ] as const;
  for (const row of cases) {
    const now = createTestClock().now();
    const adapters = new Map([
      [
        'openai',
        createScriptedChatAdapter({
          family: 'openai',
          turns: [reply('Built it.'), reply('Fixed both.')],
        }),
      ],
      ['anthropic', createScriptedChatAdapter({ family: 'anthropic', turns: row.reviews })],
      ['google', createScriptedChatAdapter({ family: 'google', turns: [reply('It holds.')] })],
      [
        'local',
        createScriptedChatAdapter({ family: 'local', turns: [reply('Clean.\nFindings: 0')] }),
      ],
    ] as const);
    const families = [
      familyEntry('openai', 10, null, now),
      familyEntry('anthropic', 50, null, now),
      familyEntry('google', 10, null, now),
      familyEntry('local', 90, null, now),
    ];
    const thread = standalone(t, { adapters, catalog: () => ({ families }) });
    const { store, service, taskId } = thread;
    const crew: ChatCrew = {
      name: 'Full crew',
      members: [
        { role: 'builder', selection: pick('openai') },
        { role: 'reviewer', selection: pick('anthropic') },
        { role: 'challenger', selection: pick('google') },
      ],
    };
    store.transaction(() => service.configure({ taskId, crew, flightMode: 'glide' }));
    // Entering glide turns automatic handoff on. The person may turn it off again.
    assert.equal(thread.read().thread.autoHandoff, true, row.name);
    if (row.autoHandoff === false)
      store.transaction(() => service.configure({ taskId, autoHandoff: false }));
    const ended = next(
      thread,
      (event) =>
        event.type === 'conversation.entry' &&
        (event.payload as { text: string }).text.startsWith('Crew '),
    );
    thread.send('Fix the rounding.', pick('openai'));
    await ended;

    const read = thread.read();
    assert.deepEqual(
      read.turns.map((turn) => [turn.role, turn.selection.family]),
      row.turns,
      row.name,
    );
    assert.equal(read.messages.at(-1)?.text, row.line, row.name);
    const { builderTurnId, ...chain } = read.thread.crewChain ?? {};
    assert.equal(builderTurnId, read.turns[0].id, row.name);
    assert.deepEqual(chain, row.chain, row.name);
    // The person's pick stays on the builder whatever the crew borrowed.
    assert.equal(read.thread.selection?.family, 'openai', row.name);
    const reviewed = adapters.get('anthropic')?.requests[0];
    assert.match(reviewed?.systemContext ?? '', /reads exactly `Findings: N`/, row.name);
    assert.equal(reviewed?.prompt, 'Review the current changes.', row.name);
    const assistant = read.messages.find((message) => message.author.kind === 'assistant');
    assert.equal(
      assistant?.author.kind === 'assistant' && assistant.author.effort,
      'default',
      row.name,
    );
    if (row.name !== 'findings 2 then 0') continue;
    const fix = adapters.get('openai')?.requests[1];
    assert.equal(fix?.role, 'fixer');
    assert.match(fix?.prompt ?? '', /^> Totals skip tax\.$/m);
    assert.match(fix?.prompt ?? '', /Fix each one in the scratch copy/);
    // The fixer is the builder again: it resumes the builder's session.
    assert.equal(fix?.session?.sessionId, `session-${read.turns[0].id}`);
  }
});

// Each row parks a turn on one ask. Balanced answers safe asks at ask time. A policy changed
// while the ask is open answers what it covers. Anything else waits for the person.
test('a policy change acts on the running turn, and balanced answers only safe asks', {
  timeout: 30000,
}, async (t) => {
  const crew: ChatCrew = {
    name: 'Pair',
    members: [
      { role: 'builder', selection },
      { role: 'reviewer', selection },
    ],
  };
  const cases = [
    {
      kind: 'edit',
      input: { path: 'net.mjs' },
      mode: 'manual',
      policy: 'allow-edits',
      answered: true,
    },
    {
      kind: 'command',
      input: { command: 'ls' },
      mode: 'manual',
      policy: 'allow-edits',
      answered: false,
    },
    {
      kind: 'command',
      input: { command: 'npm i' },
      mode: 'manual',
      policy: 'allow-all',
      answered: true,
    },
    {
      kind: 'command',
      input: { command: 'git diff --stat' },
      mode: 'balanced',
      policy: null,
      answered: true,
    },
    {
      kind: 'command',
      input: { command: 'find . -delete' },
      mode: 'balanced',
      policy: null,
      answered: false,
    },
    {
      kind: 'edit',
      input: { path: '../outside.mjs' },
      mode: 'balanced',
      policy: null,
      answered: false,
    },
    // The shell joins quoted pieces and short flags carry their value, so each of these does
    // more than read. An edit inside .git could make a later git command run code.
    {
      kind: 'command',
      input: { command: "find . -del''ete" },
      mode: 'balanced',
      policy: null,
      answered: false,
    },
    {
      kind: 'command',
      input: { command: 'rg "--pr"e sh notes.txt' },
      mode: 'balanced',
      policy: null,
      answered: false,
    },
    {
      kind: 'command',
      input: { command: 'grep -f/etc/passwd x' },
      mode: 'balanced',
      policy: null,
      answered: false,
    },
    {
      kind: 'command',
      input: { command: 'rg --hostname-bin=./x foo' },
      mode: 'balanced',
      policy: null,
      answered: false,
    },
    {
      kind: 'edit',
      input: { paths: ['net.mjs'] },
      mode: 'balanced',
      policy: null,
      answered: true,
    },
    // The adapter marks a change the client names a delete or a move. The title says nothing.
    {
      kind: 'edit',
      input: { paths: ['net.mjs'], deletes: true },
      mode: 'balanced',
      policy: null,
      answered: false,
    },
    {
      kind: 'edit',
      input: { path: '.git/config' },
      mode: 'balanced',
      policy: null,
      answered: false,
    },
  ] as const;
  for (const row of cases) {
    const adapter = editingAdapter([row.kind], row.input);
    const thread = standalone(t, { adapters: new Map([['openai', adapter]]) });
    const { store, service, taskId } = thread;
    // The thread allows everything. Balanced still asks before a risky action.
    store.transaction(() =>
      service.configure({
        taskId,
        permissionPolicy: 'allow-all',
        ...(row.mode === 'balanced' ? { crew, flightMode: 'balanced' } : {}),
      }),
    );
    if (row.mode === 'manual')
      store.transaction(() => service.configure({ taskId, permissionPolicy: 'ask' }));
    const name = `${row.mode} ${row.policy} ${JSON.stringify(row.input)}`;
    const parked = turnReaches(thread, 'waiting-permission');
    const idle = settles(thread);
    // A balanced thread has a reviewer. Its review turn starts after the builder settles, so the
    // row ends at the crew's closing line.
    const ended =
      row.mode === 'balanced'
        ? next(
            thread,
            (event) =>
              event.type === 'conversation.entry' &&
              (event.payload as { text: string }).text.startsWith('Crew '),
          )
        : null;
    thread.send('Go.');
    const turn = await parked;
    assert.equal(adapter.requests[0].permissionPolicy, 'ask', name);
    if (row.policy) {
      const effects: (() => void)[] = [];
      store.transaction(() => service.configure({ taskId, permissionPolicy: row.policy }, effects));
      for (const effect of effects) effect();
    }
    await new Promise((resolve) => setImmediate(resolve));
    const open = thread.read().turns[0].state === 'waiting-permission';
    assert.equal(open, !row.answered, name);
    if (open) {
      const effects: (() => void)[] = [];
      store.transaction(() =>
        service.resolvePermission(
          { taskId, turnId: turn.id, requestId: 'edit-1', choice: 'deny' },
          effects,
        ),
      );
      for (const effect of effects) effect();
    }
    await idle;
    if (ended) await ended;
    const resolved = agentEvents(thread).find((event) => event.type === 'permission.resolved');
    assert.equal(
      resolved?.type === 'permission.resolved' && resolved.choice,
      row.answered ? 'allow-once' : 'deny',
      name,
    );
  }
});

test('send now stops the running turn and starts the queued message with its packet', {
  timeout: 30000,
}, async (t) => {
  // Send now: the queued message goes first, the reply stops, and the message starts on the same
  // family with what the stopped reply left behind. The rest of the queue keeps its place.
  const scripted = createScriptedChatAdapter({
    family: 'openai',
    turns: [
      [{ kind: 'text', itemId: 'reply', chunks: ['Half'], complete: false }, { kind: 'wait' }],
      [{ kind: 'text', itemId: 'reply', chunks: ['Done.'] }],
    ],
  });
  const thread = standalone(t, { adapters: new Map([['openai', scripted]]) });
  const { store, service, taskId } = thread;
  const steer = (messageId: string) => {
    const effects: (() => void)[] = [];
    const result = store.transaction(() => service.steer({ taskId, messageId }, effects));
    for (const effect of effects) effect();
    return result;
  };
  assert.equal(
    steer('msg_0000000000000000000000000000').next,
    'Nothing is running. Send the message.',
  );
  const streaming = next(
    thread,
    (event) => event.type === 'agent.event' && event.payload.type === 'text.delta',
  );
  thread.send('First.');
  await streaming;
  thread.send('Second.');
  thread.send('Third.');
  const [second, third] = thread.read().thread.queued;
  assert.equal(steer('msg_0000000000000000000000000000').reason, 'message-not-queued');
  const idle = settles(thread);
  assert.equal(steer(third.id).outcome, 'applied');
  await idle;
  const read = thread.read();
  assert.deepEqual(
    read.turns.map((turn) => [turn.state, turn.userMessageId]),
    [
      ['stopped', read.turns[0].userMessageId],
      ['done', third.id],
      ['done', second.id],
    ],
  );
  const packet = scripted.requests[1].prompt;
  assert.match(packet, /^The last reply on OpenAI was stopped before it finished\./m);
  assert.match(packet, /^OpenAI ended its last turn early\. Reason: stopped by the person\.$/m);
  assert.match(packet, /New message:\nThird\.$/);
  assert.equal(scripted.requests[2].prompt, 'Second.');
});

/** Run one service command in its own transaction, then its effects, as the controller does. */
function act(store: Store, work: (effects: (() => void)[]) => CommandResult): CommandResult {
  const effects: (() => void)[] = [];
  const result = store.transaction(() => work(effects));
  for (const effect of effects) effect();
  return result;
}

test('a file is stored once by its hash, and its path reaches every turn that runs its message', {
  timeout: 30000,
}, async (t) => {
  // Rows: the start of the bytes, the name, what a paste declared, and the type CrewKite names.
  const zip = Buffer.from('PK\x03\x04', 'latin1');
  const types = [
    [Buffer.from('%PDF-1.7'), 'report', null, 'application/pdf'],
    [Buffer.concat([zip, Buffer.alloc(26), Buffer.from('word/document.xml')]), 'a.bin', null],
    [zip, 'sheet.xlsx', null, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    [zip, 'archive', null, 'application/zip'],
    [Buffer.from('ID3\x04', 'latin1'), 'voice.bin', null, 'audio/mpeg'],
    [Buffer.from('\x1a\x45\xdf\xa3....webm', 'latin1'), 'clip', null, 'video/webm'],
    [Buffer.from('const a = 1;'), 'service.ts', null, 'text/x-typescript'],
    [Buffer.from('hello'), 'paste', 'text/plain', 'text/plain'],
    [Buffer.from('hello'), 'paste', null, 'application/octet-stream'],
  ] as const;
  for (const [head, name, declared, type] of types)
    assert.equal(
      detectType(head, name, declared),
      type ?? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      name,
    );

  const rejected = chatFailure({
    stage: 'stream',
    kind: 'attachment-rejected',
    message: 'The model cannot read this file.',
  });
  const reply = (text: string): ChatScriptStep[] => [
    { kind: 'text', itemId: 'reply', chunks: [text] },
  ];
  const adapters = new Map([
    [
      'openai',
      createScriptedChatAdapter({
        family: 'openai',
        turns: [[{ kind: 'fail', stopReason: 'error', failure: rejected }]],
      }),
    ],
    [
      'google',
      createScriptedChatAdapter({
        family: 'google',
        turns: [reply('A bar chart.'), reply('A chart of sales.')],
      }),
    ],
  ] as const);
  const { store, service, taskId, read } = standalone(t, { adapters });
  const outside = mkdtempSync(join(tmpdir(), 'crewkite-attach-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 7)]);
  writeFileSync(join(outside, 'chart.png'), png);
  const importing = (source: Parameters<ChatService['importAttachment']>[0]['source']) =>
    store.transaction(() => service.importAttachment({ taskId, source }));
  const first = importing({ path: join(outside, 'chart.png') });
  assert.deepEqual(first.data, {
    kind: 'chat-attachment',
    id: createHash('sha256').update(png).digest('hex'),
    name: 'chart.png',
    mimeType: 'image/png',
    bytes: png.length,
  });
  assert.deepEqual(importing({ path: join(outside, 'chart.png') }), first);
  const pasted = { name: 'chart.png', mimeType: 'image/png', base64: png.toString('base64') };
  assert.deepEqual(importing(pasted), first);
  for (const path of [outside, join(outside, 'missing.png'), '/dev/null'])
    assert.equal(importing({ path }).reason, 'file-refused', path);

  const { kind: _, ...file } = first.data as ChatAttachment & { kind: 'chat-attachment' };
  const ask = (files: ChatAttachment[]) =>
    act(store, (effects) =>
      service.sendMessage(
        {
          taskId,
          text: 'What is in this chart?',
          selection,
          role: 'assistant',
          attachments: [],
          files,
        },
        effects,
      ),
    );
  assert.equal(ask([{ ...file, id: 'f'.repeat(64) }]).reason, 'file-not-found');
  const failed = turnReaches({ store }, 'failed');
  assert.equal(ask([file]).outcome, 'applied');
  const turn = await failed;
  const [sent] = (adapters.get('openai')?.requests ?? []) as ChatTurnRequest[];
  const path = sent.files?.[0]?.path ?? '';
  assert.deepEqual(sent.files, [{ attachment: file, path }]);
  assert.deepEqual(readFileSync(path), png);
  // One folder per hash, and one copy in it.
  assert.deepEqual(readdirSync(dirname(dirname(path))), [file.id]);
  assert.deepEqual(readdirSync(dirname(path)), ['chart.png']);

  // Try with Google takes the handoff path, and the packet names the file it carries.
  const google = { family: 'google', model: 'google-model', effort: 'default' } as const;
  const retry = (mode: 'retry' | 'regenerate', turnId: string, choice?: ChatModelSelection) =>
    act(store, (effects) =>
      service.retryTurn(
        { taskId, turnId, mode, ...(choice ? { selection: choice } : {}) },
        effects,
      ),
    );
  const moved = turnReaches({ store }, 'done');
  assert.equal(retry('retry', turn.id, google).outcome, 'applied');
  const answered = await moved;
  const requests = (adapters.get('google')?.requests ?? []) as ChatTurnRequest[];
  const [carried] = requests;
  assert.match(carried.prompt, /^This thread moved from OpenAI to Google\./);
  assert.match(carried.prompt, /^chart\.png \(image\/png, 40 bytes\)$/m);
  assert.deepEqual(carried.files, sent.files);

  // Regenerate keeps the first reply. The rerun starts a fresh session, since the old one holds
  // the reply it replaces.
  assert.equal(retry('retry', answered.id).reason, 'turn-not-retryable');
  assert.equal(retry('regenerate', turn.id).reason, 'turn-not-latest');
  const regenerated = turnReaches({ store }, 'done');
  assert.equal(retry('regenerate', answered.id).outcome, 'applied');
  await regenerated;
  const again = requests[1];
  assert.match(again.prompt, /^This message runs again on Google in a new session\./);
  assert.match(again.prompt, /New message:\nWhat is in this chart\?$/);
  assert.equal(again.session, null);
  assert.deepEqual(again.files, sent.files);
  const thread = read();
  assert.deepEqual(
    thread.messages.map((message) => message.text),
    [
      'What is in this chart?',
      `${rejected.message} ${rejected.nextAction}`,
      'Continued on Google from OpenAI. Reason: switched in the composer.',
      'A bar chart.',
      'Regenerated',
      'A chart of sales.',
    ],
  );
  assert.ok(thread.turns.every((value) => value.userMessageId === turn.userMessageId));

  // Rows: Regenerate, then Retry after it fails, on the family that answered. Anthropic and Google
  // read no history in a new session, so each rerun carries the conversation before the message.
  const broke = chatFailure({ stage: 'stream', kind: 'internal', message: 'The reply broke.' });
  for (const family of ['anthropic', 'google'] as const) {
    const pick = { family, model: `${family}-model`, effort: 'default' } as const;
    const scripted = createScriptedChatAdapter({
      family,
      turns: [
        reply('One.'),
        reply('Two.'),
        [{ kind: 'fail', stopReason: 'error', failure: broke }],
        reply('Three.'),
      ],
    });
    const rerun = standalone(t, { adapters: new Map([[family, scripted]]) });
    const again = (mode: 'retry' | 'regenerate', turnId: string, state: ChatTurn['state']) => {
      const reached = turnReaches({ store: rerun.store }, state);
      act(rerun.store, (effects) =>
        rerun.service.retryTurn({ taskId: rerun.taskId, turnId, mode }, effects),
      );
      return reached;
    };
    for (const text of ['First.', 'Second.']) {
      const done = turnReaches({ store: rerun.store }, 'done');
      rerun.send(text, pick);
      await done;
    }
    const answered = rerun.read().turns.at(-1) as ChatTurn;
    const failed = await again('regenerate', answered.id, 'failed');
    await again('retry', failed.id, 'done');
    assert.equal(scripted.requests[1].session?.sessionId, `session-${scripted.requests[0].turnId}`);
    for (const request of scripted.requests.slice(2)) {
      assert.equal(request.session, null, family);
      assert.deepEqual(request.history, [], family);
      assert.match(request.prompt, /^This message runs again on .+ in a new session\./, family);
      assert.match(request.prompt, /^Person:\nFirst\.\n\nAssistant:\nOne\.$/m, family);
      assert.match(request.prompt, /New message:\nSecond\.$/, family);
      assert.doesNotMatch(request.prompt, /Two\./, family);
    }
  }

  // Rows: a handoff to Google carries the newest 32 earlier files marked earlier, and the file of
  // the message itself unmarked. Back on OpenAI the resumed session already holds the files of the
  // messages it ran, so only the one Google saw travels.
  const families = new Map(
    (['openai', 'google'] as const).map((family) => [
      family,
      createScriptedChatAdapter({ family, turns: [reply('Seen.')] }),
    ]),
  );
  const carry = standalone(t, { adapters: families });
  const notes = Array.from({ length: 34 }, (_value, index) => {
    const source = { name: `n${index}.txt`, mimeType: 'text/plain', base64: btoa(`note ${index}`) };
    const stored = carry.store.transaction(() =>
      carry.service.importAttachment({ taskId: carry.taskId, source }),
    ).data as ChatAttachment & { kind: 'chat-attachment' };
    const { kind: _kind, ...attachment } = stored;
    return attachment;
  });
  const message = async (files: ChatAttachment[], choice: ChatModelSelection) => {
    const done = turnReaches({ store: carry.store }, 'done');
    act(carry.store, (effects) =>
      carry.service.sendMessage(
        {
          taskId: carry.taskId,
          text: 'Read these.',
          selection: choice,
          role: 'assistant',
          attachments: [],
          files,
        },
        effects,
      ),
    );
    await done;
  };
  await message(notes.slice(0, 32), selection);
  await message(notes.slice(32), selection);
  await message([notes[33]], google);
  await message([], selection);
  const names = (request: ScriptedChatRequest) =>
    ((request as ChatTurnRequest).files ?? []).map(
      (file) => `${file.attachment.name}${file.earlier ? ' earlier' : ''}`,
    );
  assert.deepEqual(names(families.get('google')?.requests[0] as ScriptedChatRequest), [
    ...notes.slice(1, 33).map((note) => `${note.name} earlier`),
    'n33.txt',
  ]);
  assert.deepEqual(names(families.get('openai')?.requests[2] as ScriptedChatRequest), [
    'n33.txt earlier',
  ]);
});

test('rename sets the thread title, and delete removes the thread, its scratch copy and files for good', {
  timeout: 30000,
}, async (t) => {
  const scripted = createScriptedChatAdapter({ family: 'openai', turns: [[{ kind: 'wait' }]] });
  const { store, service, taskId, start, send, root } = standalone(t, {
    adapters: new Map([['openai', scripted]]),
  });
  const pasted = { name: 'note.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' };
  store.transaction(() => service.importAttachment({ taskId, source: pasted }));
  const running = turnReaches({ store }, 'running');
  const launched = next(
    { store },
    (event) => event.type === 'agent.event' && event.payload.type === 'turn.started',
  );
  send('Read the note.');
  const turn = await running;
  await launched;
  const remove = (on = service) => act(store, (effects) => on.deleteThread({ taskId }, effects));
  assert.equal(remove().reason, 'turn-running');
  const stopped = turnReaches({ store }, 'stopped');
  act(store, (effects) => service.stopTurn({ taskId, turnId: turn.id }, effects));
  await stopped;

  const rename = (title: string) =>
    store.transaction(() => service.renameThread({ taskId, title }));
  assert.equal(rename(' \n ').reason, 'title-empty');
  const renamed = rename('  Sales\n chart ').entity as Task;
  assert.deepEqual([renamed.title, renamed.revision], ['Sales chart', 1]);
  assert.deepEqual(store.get<Task>('task', taskId), renamed);

  // A run that names the task keeps it.
  store.transaction(() => store.put('run', 'run_held', 0, { id: 'run_held', taskId }));
  assert.equal(remove().reason, 'thread-has-runs');
  store.db.prepare("DELETE FROM entities WHERE id='run_held'").run();

  // The controller stops after the delete commits and before its folder goes. Startup finishes it.
  const folder = dirname(scripted.requests[0].scratch.directory);
  const ref = `refs/crewkite/threads/${taskId}`;
  git(root, ['update-ref', ref, scripted.requests[0].scratch.base]);
  assert.equal(store.transaction(() => service.deleteThread({ taskId }, [])).outcome, 'applied');
  assert.ok(existsSync(join(folder, 'files')));
  const restarted = start();
  restarted.recover();
  assert.equal(existsSync(folder), false);
  assert.equal(git(root, ['for-each-ref', ref]).toString(), '');
  assert.equal(store.get('task', taskId), undefined);
  for (const table of ['conversation_entries', 'chat_turns', 'chat_threads', 'events'])
    assert.equal(
      store.db.prepare(`SELECT count(*) AS rows FROM ${table} WHERE task_id=?`).get(taskId)?.rows,
      0,
      table,
    );
  assert.equal(remove(restarted).reason, 'task-not-found');
});
