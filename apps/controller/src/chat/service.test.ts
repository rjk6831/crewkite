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
  readlinkSync,
  realpathSync,
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
  ChatCheckRun,
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
import { redact } from './thread-reader.ts';

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
      // The thread tools socket failed to open: every cloud turn says so and runs without them.
      threadToolsDown: () => true,
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
    const ran = after.turns.map((turn) => turn.id);
    assert.deepEqual(
      after.messages
        .filter((message) => message.text.startsWith('Thread tools are unavailable'))
        .map((message) => message.author.kind === 'system' && message.author.turnId),
      ran,
      row.name,
    );
    assert.deepEqual(
      agentEvents(thread).flatMap((event) =>
        event.type === 'provider.notice' && event.trace && /thread_live/.test(event.message)
          ? [event.turnId]
          : [],
      ),
      ran,
      row.name,
    );
  }

  // One running turn per family: a second thread's message on the same family waits in its own
  // queue and starts when the first thread's turn ends. Another family starts at once, and here
  // it stops on its limit.
  const shared = createScriptedChatAdapter({
    family: 'openai',
    turns: [
      [{ kind: 'wait' }],
      [{ kind: 'text', itemId: 'reply', chunks: ['Second.'] }],
      [{ kind: 'text', itemId: 'reply', chunks: ['Answered.'] }],
    ],
  });
  const other = createScriptedChatAdapter({
    family: 'google',
    turns: [
      [
        {
          kind: 'fail',
          stopReason: 'limit',
          failure: chatFailure({
            stage: 'stream',
            kind: 'usage-limit',
            message: 'The weekly limit is reached.',
          }),
        },
      ],
    ],
  });
  const one = standalone(t, {
    adapters: new Map<ChatFamily, ChatAdapter>([
      ['openai', shared],
      ['google', other],
    ]),
  });
  const [second, third] = ['1', '2'].map((digit) => ({
    ...(one.store.get<Task>('task', one.taskId) as Task),
    id: `tsk_${digit.repeat(26)}`,
  }));
  one.store.transaction(() => {
    for (const task of [second, third]) one.store.put('task', task.id, 0, task);
  });
  const sendTo = (taskId: string, text: string, choice: ChatModelSelection) =>
    act(one.store, (effects) =>
      one.service.sendMessage(
        { taskId, text, selection: choice, role: 'assistant', attachments: [], files: [] },
        effects,
      ),
    );
  const busy = turnReaches(one, 'running');
  const launched = next(
    one,
    (event) => event.type === 'agent.event' && event.payload.type === 'turn.started',
  );
  one.send('First thread.');
  const held = await busy;
  await launched;
  const queued = sendTo(second.id, 'Second thread.', selection);
  assert.deepEqual(
    [queued.outcome, queued.next],
    ['applied', 'OpenAI is answering in another thread. This message starts when that reply ends.'],
  );
  assert.equal(shared.requests.length, 1);
  const google = { family: 'google', model: 'google-model', effort: 'default' } as const;
  const elsewhere = turnReaches(one, 'failed');
  assert.equal(sendTo(third.id, 'On Google.', google).next, undefined);
  await elsewhere;
  assert.equal(other.requests.length, 1);
  // An ask on a busy family waits like a message, behind the thread that waited first. It was
  // sent after the limit stopped this thread, so that stop does not hold it.
  one.clock.advance(1000);
  const asked = act(one.store, (effects) =>
    one.service.ask(
      { taskId: third.id, family: 'openai', model: 'fixture-model', question: 'Why?' },
      effects,
    ),
  );
  assert.equal(
    asked.next,
    'OpenAI is answering in another thread. This message starts when that reply ends.',
  );
  assert.deepEqual(
    one.service
      .readThread({ taskId: third.id, limit: 100 })
      .thread.queued.map((message) => [message.role, message.text]),
    [['ask', 'Why?']],
  );
  const answered = next(
    one,
    (event) =>
      event.type === 'chat.turn' &&
      event.taskId === third.id &&
      (event.payload as ChatTurn).role === 'ask' &&
      (event.payload as ChatTurn).state === 'done',
  );
  const freed = next(
    one,
    (event) =>
      event.type === 'chat.turn' &&
      event.taskId === second.id &&
      (event.payload as ChatTurn).state === 'done',
  );
  act(one.store, (effects) =>
    one.service.stopTurn({ taskId: one.taskId, turnId: held.id }, effects),
  );
  await freed;
  await answered;
  assert.deepEqual(
    shared.requests.map((request) => [request.role, request.prompt.split('\n').at(-1)]),
    [
      ['assistant', 'First thread.'],
      ['assistant', 'Second thread.'],
      ['ask', 'Why?'],
    ],
  );
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
  assert.equal(thread.more, false);
  const earlier = await read({ beforeCursor: thread.messages[2].cursor, limit: 1 });
  assert.deepEqual(
    earlier.messages.map((message) => message.text),
    ['First reply.'],
  );
  assert.equal(earlier.more, true);

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
  options: {
    autoHandoff: boolean;
    resetsAt: string | null;
    handoffMode?: ChatHandoffMode;
    google?: ChatScriptStep[][];
  },
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
    [
      'google',
      createScriptedChatAdapter({
        family: 'google',
        turns: options.google ?? reply('Carrying on.'),
      }),
    ],
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
  const ended: string[] = [];
  const thread = standalone(t, {
    adapters,
    catalog: () => ({ families }),
    onTurnSettled: (family, taskId) => settled.push([family, taskId]),
    onTurnEnded: (turnId) => ended.push(turnId),
  });
  const { store, service, taskId } = thread;
  store.transaction(() =>
    service.configure({
      taskId,
      autoHandoff: options.autoHandoff,
      ...(options.handoffMode ? { handoffMode: options.handoffMode } : {}),
    }),
  );
  return { ...thread, adapters, limit, settled, ended };
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
  // Each turn's thread tools token ends with the turn, the failed one too.
  assert.deepEqual(
    on.ended,
    thread.turns.map((turn) => turn.id),
  );
  assert.equal(thread.thread.selection?.model, 'google-model');
  assert.equal(thread.thread.sessions[0]?.sessionId, `session-${thread.turns[2].id}`);
  const [request] = on.adapters.get('google')?.requests ?? [];
  assert.match(request.prompt, /moved from OpenAI to Google\. Reason: usage limit reached\./);
  assert.match(request.prompt, /New message from the person:\nFix the rounding\./);
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
  // Back on Google after Local and Anthropic, the session resumes and hears exactly those two
  // turns. Nothing changed in the scratch copy since Google last ran.
  const answer = (text: string, choice: ChatModelSelection) => {
    const done = turnReaches(off, 'done');
    off.send(text, choice);
    return done;
  };
  const seen = off.read().turns.find((turn) => turn.selection.family === 'google') as ChatTurn;
  await answer('Then the tests.', pick('anthropic'));
  await answer('Back to you.', pick('google'));
  const google = off.adapters.get('google')?.requests ?? [];
  const back = google[1];
  assert.equal(back.session?.sessionId, `session-${seen.id}`);
  assert.match(
    back.prompt,
    /^This thread moved from Anthropic to Google\. Reason: switched in the composer\. This session holds the thread up to its last turn on Google\.$/m,
  );
  assert.deepEqual(back.prompt.match(/^Person:\n.+$/gm), [
    'Person:\nKeep going.',
    'Person:\nThen the tests.',
  ]);
  assert.match(back.prompt, /^Local, builder \(local-model\):\nNot chosen\.$/m);
  assert.match(back.prompt, /^Anthropic, builder \(anthropic-model\):\nNot chosen\.$/m);
  assert.match(back.prompt, /^No files changed in the scratch copy since then\.$/m);
  assert.match(
    back.prompt,
    /^Thread tools are available: thread_turns, thread_turn, thread_diff, thread_checks, thread_live\.$/m,
  );
  assert.doesNotMatch(back.prompt, /Go on\.|Fix the rounding\./);
  assert.match(back.prompt, /New message from the person:\nBack to you\.$/);

  // A delta past the 96 KiB cap, even with each message cut, gives way to a new session with the
  // full packet, and the thread says so.
  const long = '\u20ac'.repeat(9000);
  for (let index = 0; index < 5; index++) await answer(`${index} ${long}`, pick('anthropic'));
  await answer('Still there?', pick('google'));
  const fresh = google[2];
  assert.equal(fresh.session, null);
  assert.match(
    fresh.prompt,
    /^This thread moved from Anthropic to Google\. Reason: switched in the composer\.$/m,
  );
  assert.ok(Buffer.byteLength(fresh.prompt) <= 96 * 1024);
  assert.equal(
    off.read().messages.at(-2)?.text,
    'Started a new Google session. The thread moved past what the old session could carry.',
  );

  // The same family at another effort resumes its session. Another model starts a new session
  // with the full packet, and the thread says why.
  await answer('Think harder.', { ...pick('google'), effort: 'high' });
  assert.equal(google[3].session?.sessionId, `session-${off.read().turns.at(-2)?.id}`);
  assert.equal(google[3].prompt, 'Think harder.');
  await answer('Try the new model.', { ...pick('google'), model: 'google-model-2' });
  assert.equal(google[4].session, null);
  assert.match(
    google[4].prompt,
    /^This thread continues on Google in a new session\. Reason: model changed in the composer\.$/m,
  );
  assert.match(google[4].prompt, /^Person:\nThink harder\.$/m);
  const changed = off.read();
  assert.equal(changed.turns.at(-1)?.handoffFrom, 'google');
  assert.equal(
    changed.messages.at(-2)?.text,
    'Continued on Google (google-model-2) from Google (google-model). Reason: model changed in the composer.',
  );

  // The cap decision clears the saved session before the turn runs. When that turn fails, the
  // next one starts fresh with the full packet and the thread says so only once.
  const broke = chatFailure({ stage: 'stream', kind: 'internal', message: 'Broke.' });
  const capped = limitThread(t, {
    autoHandoff: false,
    resetsAt: null,
    google: [
      [{ kind: 'text', itemId: 'reply', chunks: ['Carrying on.'] }],
      [{ kind: 'fail', stopReason: 'error', failure: broke }],
      [{ kind: 'text', itemId: 'reply', chunks: ['Back.'] }],
    ],
  });
  const step = (text: string, choice: ChatModelSelection, state: ChatTurn['state'] = 'done') => {
    const ended = turnReaches(capped, state);
    capped.send(text, choice);
    return ended;
  };
  await step('Start here.', pick('google'));
  for (let index = 0; index < 5; index++) await step(`${index} ${long}`, pick('anthropic'));
  await step('Still there?', pick('google'), 'failed');
  assert.deepEqual(
    capped.read().thread.sessions.map((value) => value.family),
    ['anthropic'],
  );
  await step('Try again.', pick('google'));
  const retried = capped.adapters.get('google')?.requests[2];
  assert.equal(retried?.session, null);
  assert.match(
    retried?.prompt ?? '',
    /^This thread continues on Google in a new session\. Reason: the thread moved past what the old session could carry\.$/m,
  );
  assert.equal(
    capped
      .read()
      .messages.filter((message) => message.text.startsWith('Started a new Google session')).length,
    1,
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
    [{ kind: 'text', itemId: 'ask', chunks: ['It rounds half up.'] }],
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

  // Ask: a read-only side question with the thread packet, posted as a turn with the ask role.
  // The thread keeps its own pick and its builder session.
  const asked = turnReaches(controller, 'done');
  const question = { family: 'openai', model: 'fixture-model', question: 'How does it round?' };
  assert.equal((await run('AskChatFamily', question, task.revision)).outcome, 'applied');
  await asked;
  const side = requests[2];
  assert.equal(side.role, 'ask');
  assert.equal(side.readOnly, true);
  assert.equal(side.permissionPolicy, 'ask');
  assert.equal(side.session, null);
  assert.match(side.systemContext, /answering a side question/);
  assert.match(side.prompt, /^This is a side question to OpenAI about the thread below\./);
  assert.match(side.prompt, /^Person:\nChange net\.mjs\.$/m);
  assert.match(side.prompt, /New message from the person:\nHow does it round\?$/);
  const after = await read();
  assert.equal(after.turns.at(-1)?.role, 'ask');
  assert.deepEqual(after.messages.at(-1)?.author, {
    kind: 'assistant',
    turnId: after.turns.at(-1)?.id,
    family: 'openai',
    model: 'fixture-model',
    role: 'ask',
    effort: 'default',
  });
  assert.deepEqual(after.thread.selection, selection);
  assert.deepEqual(after.thread.sessions, thread.thread.sessions);
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
  assert.equal(started.thread.skippedTotal, 1);
  const skippedLine =
    'The scratch copy skipped 1 entry it cannot hold, such as submodules and links that lead outside. Changes lists them.';
  assert.equal(started.messages.filter((message) => message.text === skippedLine).length, 1);
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
  const { controller, adapter, task, run, send, read, source, command } = await chat(t, [
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
  const listed = async (path: string) =>
    ((await run('ReadChatChanges', {})).data as { files: { path: string; patch: string }[] }).files
      .find((file) => file.path === path)
      ?.patch.split('\n')[0];
  const relinked = () => assert.equal(readlinkSync(join(scratch, 'NOTES.md')), 'net.mjs');
  const replaceLink = () => {
    rmSync(join(scratch, 'NOTES.md'));
    writeFileSync(join(scratch, 'NOTES.md'), 'a file now\n');
  };
  const rows: {
    path: string;
    reason?: string;
    line?: string;
    check?: () => void;
    before?: () => void;
    /** The first patch line Changes shows for the path before the discard. */
    listed?: string;
    /** Accept to this branch first. It takes the link from the base. */
    accept?: string;
    /** The receipt commit fails after the restore, and the same key runs again. */
    crash?: boolean;
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
    {
      path: 'net.mjs',
      line: 'Discarded the changes to net.mjs. It matches the base commit',
      crash: true,
      check: () => assert.deepEqual(readFileSync(join(scratch, 'net.mjs')), committed('net.mjs')),
    },
    { path: 'NOTES.md', reason: 'not-changed' },
    {
      path: 'NOTES.md',
      before: replaceLink,
      listed: 'Link replaced',
      line: 'Restored the link NOTES.md from the base commit',
      check: relinked,
    },
    {
      path: 'NOTES.md',
      before: () => rmSync(join(scratch, 'NOTES.md')),
      listed: 'Link removed',
      line: 'Restored the link NOTES.md from the base commit',
      check: relinked,
    },
    {
      path: 'NOTES.md',
      before: () => {
        replaceLink();
        appendFileSync(join(scratch, 'net.mjs'), '// changed\n');
      },
      listed: 'Link replaced',
      accept: 'crewkite/link-replaced',
      line: 'Restored the link NOTES.md from the base commit',
      check: relinked,
    },
    {
      path: 'NOTES.md',
      before: () => {
        rmSync(join(scratch, 'NOTES.md'));
        appendFileSync(join(scratch, 'net.mjs'), '// changed\n');
      },
      listed: 'Link removed',
      accept: 'crewkite/link-removed',
      line: 'Restored the link NOTES.md from the base commit',
      check: relinked,
    },
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
    if (row.listed) assert.equal(await listed(row.path), row.listed, row.path);
    if (row.accept) {
      const accepted = await run('AcceptChatChanges', { branch: row.accept }, task.revision);
      assert.deepEqual(accepted.data, {
        kind: 'chat-acceptance',
        branch: row.accept,
        commit: repo('rev-parse', row.accept),
        fileCount: 1,
      });
      assert.equal(repo('ls-tree', row.accept, 'NOTES.md'), repo('ls-tree', 'HEAD', 'NOTES.md'));
      // The copy's version is still there, and Changes still says it will not be accepted.
      assert.equal(await listed(row.path), row.listed, row.accept);
    }
    let result: CommandResult;
    if (row.crash) {
      const once = command('DiscardChatChange', { taskId: task.id, path: row.path }, task.revision);
      const save = controller.store.saveReceipt;
      controller.store.saveReceipt = () => {
        throw new Error('Crash before the receipt commits.');
      };
      await assert.rejects(controller.execute(once, 'local-owner'), /Crash/);
      controller.store.saveReceipt = save;
      result = await controller.execute(once, 'local-owner');
      const lines = (await read()).messages.filter((message) =>
        message.text.startsWith(row.line ?? ''),
      );
      assert.equal(lines.length, 1, row.path);
    } else result = await discard(row.path);
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
  const slice = (id: number, difficulty: string, depends: number[]) => ({
    id,
    title: `Part ${id}`,
    brief: `Do part ${id}.`,
    files: ['src/net.mjs'],
    depends,
    difficulty,
    readOnly: false,
  });
  const twoSlices = {
    planId: 'p1',
    goal: 'Fix the rounding.',
    slices: [slice(1, 'medium', []), slice(2, 'hard', [1])],
  };
  const planReply = (plan: object) =>
    reply(`Two parts.\n\n\`\`\`json plan\n${JSON.stringify(plan)}\n\`\`\``);
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
      name: 'a failing check goes to the fixer as its message, then the chain goes on',
      reviews: [reply(twoFindings), reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      gate: true,
      turns: [
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
        ['fixer', 'openai'],
        ['fixer', 'openai'],
        ['reviewer', 'anthropic'],
        ['challenger', 'google'],
      ],
      line: 'Crew finished: 2 review rounds, 2 fixes.',
      chain: { step: 'finished', reviewRounds: 2, fixes: 2, reason: null },
    },
    {
      name: 'a fixer that edits the check script makes the chain ask before the check runs',
      reviews: [reply(twoFindings), reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      gate: true,
      edit: true,
      turns: [
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
        ['fixer', 'openai'],
        ['fixer', 'openai'],
        ['reviewer', 'anthropic'],
        ['challenger', 'google'],
      ],
      line: 'Crew finished: 2 review rounds, 2 fixes.',
      chain: { step: 'finished', reviewRounds: 2, fixes: 2, reason: null },
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
    {
      name: 'a plan runs each slice with its review, then one challenge',
      plan: [planReply(twoSlices)],
      builds: [reply('Built part 1.'), reply('Built part 2.')],
      reviews: [reply('Clean.\nFindings: 0'), reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      // An Ask sent while the orchestrator reads stops neither the plan nor a chain. It runs last.
      ask: 'Why two parts?',
      turns: [
        ['orchestrator', 'openai'],
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
        ['challenger', 'google'],
        ['ask', 'google'],
      ],
      line: 'Crew finished: 2 slices, 2 reviews, 0 fixes.',
      // The challenge follows the last slice's own review chain.
      chain: { step: 'finished', reviewRounds: 1, fixes: 0, reason: null },
      builderAt: 3,
      card: ['finished', 'done', 'done'],
    },
    {
      name: 'a read-only slice runs as an ask with no review, and the challenge follows the last write',
      plan: [
        planReply({
          ...twoSlices,
          slices: [twoSlices.slices[0], { ...twoSlices.slices[1], readOnly: true }],
        }),
      ],
      builds: [reply('Built part 1.'), reply('Part 2 reads fine.')],
      reviews: [reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      turns: [
        ['orchestrator', 'openai'],
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
        ['ask', 'openai'],
        ['challenger', 'google'],
      ],
      line: 'Crew finished: 2 slices, 1 review, 0 fixes.',
      chain: { step: 'finished', reviewRounds: 0, fixes: 0, reason: null },
      builderAt: 1,
      card: ['finished', 'done', 'done'],
      // The adapter request that carried the read-only slice.
      readOnlyAt: 2,
    },
    {
      name: 'balanced waits for Run plan, and an override moves a slice to a ranked family',
      plan: [planReply({ ...twoSlices, slices: [twoSlices.slices[0]] })],
      // OpenAI would build the slice without the override.
      builds: [reply('Unused.')],
      reviews: [reply('Built on Anthropic.'), reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      balanced: true,
      builtOn: 'anthropic',
      picked: 'Slice 1 (medium) assigned to Anthropic: picked on the plan card.',
      turns: [
        ['orchestrator', 'openai'],
        ['assistant', 'anthropic'],
        ['reviewer', 'anthropic'],
        ['challenger', 'google'],
      ],
      line: 'Crew finished: 1 slice, 1 review, 0 fixes.',
      chain: { step: 'finished', reviewRounds: 1, fixes: 0, reason: null },
      builderAt: 1,
      card: ['finished', 'done'],
    },
    {
      name: 'a failed slice stops the plan and the rest do not run',
      plan: [planReply(twoSlices)],
      builds: [
        [
          {
            kind: 'fail',
            stopReason: 'error',
            failure: chatFailure({ stage: 'stream', kind: 'internal', message: 'Broke.' }),
          },
        ],
      ],
      reviews: [reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      turns: [
        ['orchestrator', 'openai'],
        ['assistant', 'openai'],
      ],
      line: 'Plan stopped: slice 1 failed. Run it again from the plan card.',
      chain: null,
      card: ['stopped', 'failed', 'not-run'],
    },
    {
      name: 'a plan that fails validation goes back once, then stops',
      plan: [reply('Here is my plan in prose.'), reply('Still prose.')],
      builds: [reply('Unused.')],
      reviews: [reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      turns: [
        ['orchestrator', 'openai'],
        ['orchestrator', 'openai'],
      ],
      line: 'Plan stopped: the plan did not pass validation. The reply has no fenced json block tagged plan.',
      chain: null,
      card: null,
    },
  ] as const;
  for (const row of cases) {
    const now = createTestClock().now();
    const planned = 'plan' in row;
    // The gate script lives in the scratch copy, as a project's own script would. It fails the
    // first time it runs and passes after, so the first fix does not satisfy it. The row turns
    // the check on when the builder starts, once the copy exists.
    let begun: ((scratch: string) => void) | undefined;
    let fixers = 0;
    const openai = createScriptedChatAdapter({
      family: 'openai',
      turns: planned
        ? [...row.plan, ...row.builds]
        : [reply('Built it.'), reply('Fixed both.'), reply('Fixed the gate.')],
    });
    const gateAdapter = {
      ...openai,
      startTurn(request: ScriptedChatRequest, emit: (event: AgentEvent) => void) {
        if (openai.requests.length === 0) begun?.(request.scratch.directory);
        if ('edit' in row && request.role === 'fixer' && fixers++ === 0)
          appendFileSync(join(request.scratch.directory, 'gate.mjs'), '\n// edited by the fixer\n');
        return openai.startTurn(request, emit);
      },
    };
    const adapters = new Map([
      ['openai', 'gate' in row ? gateAdapter : openai],
      ['anthropic', createScriptedChatAdapter({ family: 'anthropic', turns: row.reviews })],
      [
        'google',
        createScriptedChatAdapter({
          family: 'google',
          turns: [reply('It holds.'), reply('One part waits on the other.')],
        }),
      ],
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
        ...(planned ? [{ role: 'orchestrator', selection: pick('openai') } as const] : []),
      ],
    };
    const balanced = 'balanced' in row;
    store.transaction(() =>
      service.configure({ taskId, crew, flightMode: balanced ? 'balanced' : 'glide' }),
    );
    // Entering glide turns automatic handoff on. The person may turn it off again.
    assert.equal(thread.read().thread.autoHandoff, !balanced, row.name);
    if (row.autoHandoff === false)
      store.transaction(() => service.configure({ taskId, autoHandoff: false }));
    const asks: ChatThread[] = [];
    store.subscribe((event) => {
      if (event.type === 'chat.thread' && (event.payload as ChatThread).checks?.ask)
        asks.push(event.payload as ChatThread);
    });
    if ('gate' in row)
      begun = (scratch) => {
        writeFileSync(
          join(scratch, 'gate.mjs'),
          [
            "import { existsSync, writeFileSync } from 'node:fs';",
            "const marker = new URL('ran', import.meta.url);",
            'if (existsSync(marker)) process.exit(0);',
            "writeFileSync(marker, 'x');",
            "console.log('gate: expected 3 got 2');",
            'process.exitCode = 1;',
          ].join('\n'),
        );
        store.transaction(() =>
          service.configure({
            taskId,
            permissionPolicy: 'allow-all',
            checks: { add: 'node gate.mjs' },
          }),
        );
      };
    const ended = next(
      thread,
      (event) =>
        event.type === 'conversation.entry' &&
        /^(Crew|Plan) (finished|stopped)/.test((event.payload as { text: string }).text),
    );
    if (balanced) {
      const proposed = next(
        thread,
        (event) =>
          event.type === 'chat.thread' && (event.payload as ChatThread).plan?.phase === 'proposed',
      );
      thread.send('Fix the rounding.', pick('openai'));
      const shown = (await proposed).payload as ChatThread;
      const card = shown.plan;
      // Balanced runs nothing until Run plan: the card arrives on a free thread.
      assert.equal(shown.activeTurnId, null, row.name);
      assert.equal(thread.read().turns.length, 1, row.name);
      const run = (overrides: { sliceId: number; family: ChatFamily; model: string }[]) => {
        const effects: (() => void)[] = [];
        const result = store.transaction(() =>
          service.runPlan({ taskId, planId: 'p1', overrides }, effects),
        );
        for (const effect of effects) effect();
        return result;
      };
      // Only a ranked candidate on the card can take a slice.
      assert.equal(
        run([{ sliceId: 1, family: 'google', model: 'google-unranked' }]).reason,
        'override-not-ranked',
        row.name,
      );
      const other = card?.slices[0].candidates.find((value) => value.family === 'anthropic');
      assert.ok(other, row.name);
      assert.equal(
        run([{ sliceId: 1, family: other.family, model: other.model }]).outcome,
        'applied',
        row.name,
      );
    } else thread.send('Fix the rounding.', pick('openai'));
    if ('edit' in row) {
      // The fixer changed the script the person turned on, so Glide asks even with Allow all.
      const raised = (
        await next(
          thread,
          (event) => event.type === 'chat.thread' && !!(event.payload as ChatThread).checks?.ask,
        )
      ).payload as ChatThread;
      assert.equal(raised.checks?.runs.length, 0, row.name);
      assert.deepEqual(raised.checks?.ask?.changed, ['node gate.mjs'], row.name);
      assert.deepEqual(
        raised.checks?.ask?.commands,
        [{ label: 'node gate.mjs', resolved: 'node gate.mjs' }],
        row.name,
      );
      const answer = act(store, (effects) =>
        service.resolvePermission(
          {
            taskId,
            turnId: thread.read().turns.at(-1)?.id as string,
            requestId: raised.checks?.ask?.requestId as string,
            choice: 'allow',
          },
          effects,
        ),
      );
      assert.equal(answer.outcome, 'applied', row.name);
    }
    const answered =
      'ask' in row &&
      next(
        thread,
        (event) =>
          event.type === 'chat.turn' &&
          (event.payload as ChatTurn).role === 'ask' &&
          (event.payload as ChatTurn).state === 'done',
      );
    if ('ask' in row) {
      const asked = act(store, (effects) =>
        service.ask(
          { taskId, family: 'google', model: 'google-model', question: row.ask },
          effects,
        ),
      );
      assert.equal(asked.outcome, 'applied', row.name);
    }
    await ended;
    await answered;

    const read = thread.read();
    assert.deepEqual(
      read.turns.map((turn) => [turn.role, turn.selection.family]),
      row.turns,
      row.name,
    );
    // The Ask's question and answer follow the closing line.
    assert.equal(read.messages.at('ask' in row ? -3 : -1)?.text, row.line, row.name);
    if (row.chain === null) assert.equal(read.thread.crewChain, null, row.name);
    else {
      const { builderTurnId, ...chain } = read.thread.crewChain ?? {};
      assert.equal(builderTurnId, read.turns['builderAt' in row ? row.builderAt : 0].id, row.name);
      assert.deepEqual(chain, row.chain, row.name);
    }
    if (planned) {
      const card = read.thread.plan;
      assert.deepEqual(
        card ? [card.phase, ...card.slices.map((value) => value.status)] : null,
        row.card,
        row.name,
      );
      const asked = adapters.get('openai')?.requests ?? [];
      assert.equal(asked[0]?.role, 'orchestrator', row.name);
      assert.match(asked[0]?.systemContext ?? '', /```json plan/, row.name);
      if (row.card === null) {
        assert.match(asked[1]?.prompt ?? '', /^The plan did not pass validation\. /, row.name);
        assert.match(asked[1]?.prompt ?? '', /^> Fix the rounding\.$/m, row.name);
        continue;
      }
      const lines = read.messages.map((message) => message.text);
      assert.ok(
        lines.includes(
          'Slice 1 (medium) assigned to OpenAI: the crew builder, ranked 2 of 3 by Most allowance left.',
        ),
        row.name,
      );
      // An override keeps the controller's line and adds the person's pick after it.
      if ('picked' in row) assert.ok(lines.includes(row.picked), row.name);
      const builtOn = 'builtOn' in row ? row.builtOn : 'openai';
      assert.equal(card?.slices[0].assignment?.family, builtOn, row.name);
      const brief = (builtOn === 'openai' ? asked[1] : adapters.get(builtOn)?.requests[0])?.prompt;
      const of = `Slice 1 of ${row.card.length - 1} in plan p1: Part 1`;
      assert.match(brief ?? '', new RegExp(`^${of}$`, 'm'), row.name);
      assert.match(brief ?? '', /^Do part 1\.$/m, row.name);
      if ('readOnlyAt' in row) {
        const readOnly = asked[row.readOnlyAt] as unknown as ChatTurnRequest | undefined;
        assert.match(readOnly?.prompt ?? '', /^Slice 2 of 2 in plan p1: Part 2$/m, row.name);
        assert.equal(readOnly?.role, 'ask', row.name);
        assert.equal(readOnly?.readOnly, true, row.name);
      }
      continue;
    }
    // The person's pick stays on the builder whatever the crew borrowed.
    assert.equal(read.thread.selection?.family, 'openai', row.name);
    if ('gate' in row) {
      const requests = adapters.get('openai')?.requests ?? [];
      assert.equal(requests[2]?.role, 'fixer');
      assert.match(requests[2]?.prompt ?? '', /^The project checks failed in the scratch copy\./);
      assert.match(requests[2]?.prompt ?? '', /gate: expected 3 got 2/);
      // The second fix is the last one the chain allows, and the second run passes.
      const runs = read.thread.checks?.runs ?? [];
      assert.deepEqual(
        runs.map((run) => [run.status, run.exitCode, run.reason, run.trigger]),
        [
          ['failed', 1, 'Exit code 1.', 'fix'],
          ['passed', 0, null, 'fix'],
        ],
      );
      assert.equal(runs[0].tail, 'gate: expected 3 got 2');
      const files = new ArtifactFiles(join(dirname(thread.root), 'artifacts'));
      assert.equal(
        files.read(runs[0].stdout?.hash ?? '').toString('utf8'),
        'gate: expected 3 got 2\n',
      );
      // Only the edited script asked, and the second fix ran on the pin the answer renewed.
      assert.equal(asks.length, 'edit' in row ? 1 : 0, row.name);
      const lines = read.messages.map((message) => message.text);
      assert.ok(lines.some((line) => line.startsWith('Checks failed: node ')));
      assert.ok(lines.some((line) => line.startsWith('Checks passed: node ')));
      // A provider reads the newest run of each check through thread_checks.
      const seen = service.threadReads(taskId).checks().lines;
      assert.match(seen.join('\n'), /\): passed in \d+\.\d s/);
      continue;
    }
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
    // The builder's next message hears the reviews and the challenge, each named by family
    // and role.
    store.transaction(() => service.configure({ taskId, flightMode: 'manual' }));
    const after = turnReaches(thread, 'done');
    thread.send('Ship it.', pick('openai'));
    await after;
    const delta = adapters.get('openai')?.requests[2]?.prompt ?? '';
    assert.match(delta, /^Anthropic, reviewer \(anthropic-model\):\nClean\.\nFindings: 0$/m);
    assert.match(delta, /^Google, challenger \(google-model\):\nIt holds\.$/m);
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
  assert.match(packet, /New message from the person:\nThird\.$/);
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
  const { store, service, taskId, read, root } = standalone(t, { adapters });
  const outside = mkdtempSync(join(tmpdir(), 'crewkite-attach-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 7)]);
  writeFileSync(join(outside, 'chart.png'), png);
  // The copy is whole before the transaction opens, and a partial one a crash left goes first.
  const folder = join(dirname(root), 'chat', taskId, 'files');
  const partials = () => readdirSync(folder).filter((name) => name.startsWith('.import-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.import-0123456789ab-0123456789abcdef'), 'partial');
  const staged: number[] = [];
  const importing = (source: Parameters<ChatService['importAttachment']>[0]['source']) => {
    const payload = { taskId, source };
    return service.importing(payload, () => {
      staged.push(...partials().map((name) => statSync(join(folder, name)).size));
      return store.transaction(() => service.importAttachment(payload));
    });
  };
  const first = await importing({ path: join(outside, 'chart.png') });
  assert.deepEqual(staged, [png.length]);
  assert.deepEqual(partials(), []);
  assert.deepEqual(first.data, {
    kind: 'chat-attachment',
    id: createHash('sha256').update(png).digest('hex'),
    name: 'chart.png',
    mimeType: 'image/png',
    bytes: png.length,
  });
  assert.deepEqual(await importing({ path: join(outside, 'chart.png') }), first);
  const pasted = { name: 'chart.png', mimeType: 'image/png', base64: png.toString('base64') };
  assert.deepEqual(await importing(pasted), first);
  for (const path of [outside, join(outside, 'missing.png'), '/dev/null'])
    assert.equal((await importing({ path })).reason, 'file-refused', path);
  assert.deepEqual(partials(), []);

  // A large copy reports progress every 4 MiB and holds no transaction while it runs, so another
  // command commits mid-copy. The command answers with the stored file as its receipt.
  const big = join(outside, 'big.log');
  writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 97));
  const seen: [string, number, number][] = [];
  const slow = standalone(t, {
    onImportProgress: (id, progress) => {
      seen.push([progress.name, progress.bytes, progress.total]);
      if (seen.length === 1)
        assert.equal(
          slow.store.transaction(() => slow.service.renameThread({ taskId: id, title: 'Mid copy' }))
            .outcome,
          'applied',
        );
    },
  });
  const large = { taskId: slow.taskId, source: { path: big } };
  const receipt = await slow.service.importing(large, () =>
    slow.store.transaction(() => slow.service.importAttachment(large)),
  );
  const MiB = 1024 * 1024;
  assert.deepEqual(seen, [
    ['big.log', 4 * MiB, 9 * MiB],
    ['big.log', 8 * MiB, 9 * MiB],
    ['big.log', 9 * MiB, 9 * MiB],
  ]);
  assert.equal(slow.store.get<Task>('task', slow.taskId)?.title, 'Mid copy');
  assert.equal((receipt.data as ChatAttachment).bytes, 9 * MiB);
  assert.equal(
    slow.store.receipt(`chat-file:${slow.taskId}:${(receipt.data as ChatAttachment).id}:big.log`)
      ?.result.outcome,
    'applied',
  );

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
  // Rows: an unknown id or name is refused, and the type comes from the import, whatever the
  // payload says.
  assert.equal(ask([{ ...file, id: 'f'.repeat(64) }]).reason, 'file-not-found');
  assert.equal(ask([{ ...file, name: 'other.png' }]).reason, 'file-not-found');
  const failed = turnReaches({ store }, 'failed');
  assert.equal(ask([{ ...file, mimeType: 'text/plain' }]).outcome, 'applied');
  const turn = await failed;
  const [sent] = (adapters.get('openai')?.requests ?? []) as ChatTurnRequest[];
  const path = sent.files?.[0]?.path ?? '';
  assert.deepEqual(sent.files, [{ attachment: file, path }]);
  assert.deepEqual(readFileSync(path), png);
  // One folder per hash, and one copy in it.
  assert.deepEqual(readdirSync(dirname(dirname(path))), [file.id]);
  assert.deepEqual(readdirSync(dirname(path)), ['chart.png']);

  // Try with Google takes the handoff path, and the file travels in the request's files.
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
  // The adapter lists the file of the message itself under the text, so the packet holds no line for it.
  assert.doesNotMatch(carried.prompt, /chart\.png/);
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
  assert.match(again.prompt, /New message from the person:\nWhat is in this chart\?$/);
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
      assert.match(request.prompt, /New message from the person:\nSecond\.$/, family);
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
  const notes: ChatAttachment[] = [];
  for (let index = 0; index < 34; index++) {
    const source = { name: `n${index}.txt`, mimeType: 'text/plain', base64: btoa(`note ${index}`) };
    const payload = { taskId: carry.taskId, source };
    const stored = await carry.service.importing(payload, () =>
      carry.store.transaction(() => carry.service.importAttachment(payload)),
    );
    const { kind: _kind, ...attachment } = stored.data as ChatAttachment & {
      kind: 'chat-attachment';
    };
    notes.push(attachment);
  }
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
  // The handoff packet lists the earlier files once, ahead of the message, and not the file the
  // message itself carries.
  const sentToGoogle = families.get('google')?.requests[0] as unknown as ChatTurnRequest;
  const packetText = sentToGoogle.prompt;
  assert.equal(
    packetText.match(
      /^n\d+\.txt, text\/plain, .*came with "Read these\.", sent as a file link below$/gm,
    )?.length,
    32,
  );
  assert.ok(
    packetText.indexOf('Files attached earlier in this thread.') <
      packetText.indexOf('New message from the person:'),
  );
  assert.doesNotMatch(packetText, /^n33\.txt/m);
  // Files alone: the request text is empty, the file goes in the request's files, and a later
  // packet names the files where the message would be.
  const silent = async (files: ChatAttachment[], choice: ChatModelSelection, text = '') => {
    const done = turnReaches({ store: carry.store }, 'done');
    act(carry.store, (effects) =>
      carry.service.sendMessage(
        {
          taskId: carry.taskId,
          text,
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
  await silent([notes[0]], selection);
  const filesOnly = families.get('openai')?.requests.at(-1) as unknown as ChatTurnRequest;
  assert.equal(filesOnly.prompt, '');
  assert.deepEqual(
    filesOnly.files?.map((entry) => entry.attachment.name),
    ['n0.txt'],
  );
  await silent([], google, 'And now?');
  assert.match(
    families.get('google')?.requests.at(-1)?.prompt ?? '',
    /^Person:\n\(Files only: n0\.txt\)$/m,
  );
  // A Local reply that stops at its output limit writes the counts, and Continue asks the same
  // model for the rest in a new message. The partial reply stays in the thread.
  const local = { family: 'local', model: 'local-model', effort: 'default' } as const;
  const limited = createScriptedChatAdapter({
    family: 'local',
    turns: [reply('Partial.'), reply('The rest.')],
  });
  const outputLimit = { reasoningTokens: 3900, replyTokens: 700, allowedTokens: 4600 };
  const capped = {
    ...limited,
    startTurn(request: ScriptedChatRequest, emit: (event: AgentEvent) => void) {
      const handle = limited.startTurn(request, emit);
      const first = limited.requests.length === 1;
      return {
        ...handle,
        result: handle.result.then((result) => (first ? { ...result, outputLimit } : result)),
      };
    },
  };
  const cont = standalone(t, { adapters: new Map([['local', capped]]) });
  const stoppedAtLimit = turnReaches({ store: cont.store }, 'done');
  cont.send('Write the guide.', local);
  const partial = await stoppedAtLimit;
  assert.deepEqual(partial.outputLimit, outputLimit);
  const continued = turnReaches({ store: cont.store }, 'done');
  const resume = (effects: (() => void)[]) =>
    cont.service.retryTurn({ taskId: cont.taskId, turnId: partial.id, mode: 'continue' }, effects);
  assert.equal(act(cont.store, resume).outcome, 'applied');
  await continued;
  assert.deepEqual(
    cont.read().messages.map((entry) => entry.text),
    [
      'Write the guide.',
      'Partial.',
      'Reply stopped at the output limit: 3,900 reasoning and 700 reply of 4,600 allowed.',
      'Continue the reply from where it stopped. Do not repeat what you already wrote.',
      'The rest.',
    ],
  );
  assert.deepEqual(limited.requests[1].selection, local);
  assert.deepEqual(limited.requests[1].history.at(-1), { role: 'assistant', text: 'Partial.' });
});

test('rename sets the thread title, and delete removes the thread, its scratch copy and files for good', {
  timeout: 30000,
}, async (t) => {
  const scripted = createScriptedChatAdapter({ family: 'openai', turns: [[{ kind: 'wait' }]] });
  const { store, service, taskId, start, send, root } = standalone(t, {
    adapters: new Map([['openai', scripted]]),
  });
  const pasted = { name: 'note.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' };
  const imported = { taskId, source: pasted };
  await service.importing(imported, () =>
    store.transaction(() => service.importAttachment(imported)),
  );
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
  // A plan command for a plan the thread does not hold changes nothing.
  for (const planned of [
    act(store, (effects) => service.runPlan({ taskId, planId: 'plan-1' }, effects)),
    act(store, (effects) => service.runPlan({ taskId, planId: 'plan-1', sliceId: 1 }, effects)),
    act(store, (effects) => service.cancelPlan({ taskId, planId: 'plan-1' }, effects)),
  ])
    assert.equal(planned.reason, 'plan-not-found');
  const renamed = rename('  Sales\n chart ').entity as Task;
  assert.deepEqual([renamed.title, renamed.revision], ['Sales chart', 1]);
  assert.deepEqual(store.get<Task>('task', taskId), renamed);

  // A run that names the task keeps it.
  store.transaction(() => store.put('run', 'run_held', 0, { id: 'run_held', taskId }));
  assert.equal(remove().reason, 'thread-has-runs');
  store.db.prepare("DELETE FROM entities WHERE id='run_held'").run();

  // Rows: large events keep their output in artifacts. One holds a hash nothing else names, and
  // its file goes. The other shares its hash with an artifact outside the thread, and the file stays.
  const artifacts = new ArtifactFiles(join(dirname(root), 'artifacts'));
  const cursors = store.db
    .prepare('SELECT cursor,event_id FROM events WHERE task_id=? ORDER BY cursor LIMIT 2')
    .all(taskId) as { cursor: number; event_id: string }[];
  const outputs = ['alone', 'shared'].map((content, index) => ({
    id: `art_output${index}`,
    ...artifacts.publish(Buffer.from(content)),
    mediaType: 'application/vnd.crewkite.event+json',
  }));
  const kept = { ...outputs[1], id: 'art_kept', mediaType: 'text/plain' };
  store.transaction(() => {
    for (const [index, artifact] of [...outputs, kept].entries()) {
      store.put('artifact', artifact.id, 0, artifact);
      if (artifact !== kept)
        store.db
          .prepare('INSERT INTO activity_output(cursor,event_id,artifact_id) VALUES (?,?,?)')
          .run(cursors[index].cursor, cursors[index].event_id, artifact.id);
    }
  });

  // The controller stops after the delete commits and before its folder goes. Startup finishes it.
  const folder = dirname(scripted.requests[0].scratch.directory);
  const ref = `refs/crewkite/threads/${taskId}`;
  git(root, ['update-ref', ref, scripted.requests[0].scratch.base]);
  assert.equal(store.transaction(() => service.deleteThread({ taskId }, [])).outcome, 'applied');
  assert.deepEqual(
    store
      .eventsAfter('0')
      .flatMap((event) => (event.type === 'task.removed' ? [[event.taskId, event.payload]] : [])),
    [[null, { taskId }]],
  );
  assert.ok(existsSync(join(folder, 'files')));
  const restarted = start();
  restarted.recover();
  assert.equal(existsSync(folder), false);
  assert.equal(git(root, ['for-each-ref', ref]).toString(), '');
  assert.equal(store.get('task', taskId), undefined);
  assert.deepEqual(
    [...outputs, kept].map((artifact) => store.get('artifact', artifact.id) !== undefined),
    [false, false, true],
  );
  assert.throws(() => artifacts.read(outputs[0].hash), /ENOENT/);
  assert.equal(artifacts.read(kept.hash).toString(), 'shared');
  for (const table of ['conversation_entries', 'chat_turns', 'chat_threads', 'events'])
    assert.equal(
      store.db.prepare(`SELECT count(*) AS rows FROM ${table} WHERE task_id=?`).get(taskId)?.rows,
      0,
      table,
    );
  assert.equal(remove(restarted).reason, 'task-not-found');
});

test('the thread reader returns bounded, redacted reads of its own thread only', {
  timeout: 30000,
}, async (t) => {
  const secret = 'sk-live0123456789abcdef';
  const long = `${'Plain words. '.repeat(3000)}API_KEY=hunter2 ${secret}`;
  const scripted = createScriptedChatAdapter({
    family: 'openai',
    turns: [
      [{ kind: 'text', itemId: 'reply', chunks: [long] }],
      [
        { kind: 'text', itemId: 'live', chunks: [`Working. TOKEN: abc123 ${'x'.repeat(9000)}`] },
        { kind: 'wait' },
      ],
    ],
  });
  const adapter = {
    ...scripted,
    startTurn(request: ScriptedChatRequest, emit: (event: AgentEvent) => void) {
      if (scripted.requests.length === 0) {
        writeFileSync(join(request.scratch.directory, 'big.txt'), `${'line\n'.repeat(30_000)}`);
        const tool = (callId: string, kind: ChatToolKind, title: string, input: object) => {
          emit({ type: 'tool.started', turnId: request.turnId, callId, kind, title, input });
          emit({ type: 'tool.completed', turnId: request.turnId, callId, status: 'ok' });
        };
        tool('c1', 'edit', 'Write big.txt', { file_path: 'big.txt' });
        tool('c2', 'command', 'Fetch', {
          command: `curl -H "Authorization: Bearer ${secret}" https://example.invalid`,
          stdin: 'stdin-body-never-shown',
        });
      }
      return scripted.startTurn(request, emit);
    },
  };
  const thread = standalone(t, {
    adapters: new Map([['openai', adapter]]),
    resolveEnvironment: () => ({ CREWKITE_SECRET: 'env-value-never-shown' }),
  });
  const done = turnReaches(thread, 'done');
  thread.send('Write it.');
  const first = await done;
  const reads = thread.service.threadReads(thread.taskId);
  const all: unknown[] = [];
  const keep = <T>(value: T) => {
    all.push(value);
    return value;
  };

  const listed = keep(reads.turns({ limit: 50 })).turns;
  assert.deepEqual(
    listed.map((turn) => [turn.id, turn.role, turn.status, turn.changedFiles]),
    [[first.id, 'assistant', 'done', 1]],
  );
  assert.equal(listed[0].reply.length, 300);
  assert.deepEqual(keep(reads.turns({ since: first.sequence, limit: 50 })).turns, []);

  const one = keep(reads.turn({ id: first.id }));
  assert.equal(one.truncated, true);
  assert.ok(Buffer.byteLength(one.reply) <= 32 * 1024);
  assert.match(one.reply, /\n\[truncated\]$/);
  assert.deepEqual(one.files, ['big.txt']);
  assert.deepEqual(
    one.trace.map((entry) => [entry.kind, entry.target, entry.outcome]),
    [
      ['edit', 'big.txt', 'ok'],
      ['command', 'curl -H "Authorization: Bearer [redacted]" https://example.invalid', 'ok'],
    ],
  );
  assert.throws(() => reads.turn({ id: `trn_${'9'.repeat(26)}` }), /No turn with that id/);

  // The diff pages at 64 KiB on a line, and the pages put together are the whole diff.
  const pages: string[] = [];
  let cursor: string | undefined;
  do {
    const page = keep(reads.diff({ path: 'big.txt', ...(cursor ? { cursor } : {}) }));
    assert.ok(Buffer.byteLength(page.diff) <= 64 * 1024);
    pages.push(page.diff);
    cursor = page.more ?? undefined;
  } while (cursor);
  assert.ok(pages.length > 1);
  assert.equal(pages.join('').split('\n+line').length - 1, 30_000);
  assert.equal(keep(reads.live()).state, 'none');
  assert.deepEqual(keep(reads.checks()).lines, []);

  const streaming = next(
    thread,
    (event) => event.type === 'agent.event' && event.payload.type === 'text.delta',
  );
  thread.send('Keep going.');
  await streaming;
  const live = keep(reads.live());
  assert.equal(live.state, 'running');
  if (live.state === 'running') {
    assert.ok(Buffer.byteLength(live.text) <= 8 * 1024);
    assert.equal(live.role, 'assistant');
  }
  // Rows: what the redaction catches before any text leaves.
  for (const [raw, shown] of [
    [`key ${secret} here`, 'key [redacted] here'],
    ['Authorization: Bearer abc.def-ghi', 'Authorization: Bearer [redacted]'],
    ['export OPENAI_API_KEY=abc123', 'export OPENAI_API_KEY=[redacted]'],
    ['"client_secret": "s3cr3t"', '"client_secret": [redacted]'],
    ['GITHUB_TOKEN: ghp_x1', 'GITHUB_TOKEN: [redacted]'],
    ['monkey business = fine', 'monkey business = fine'],
  ] as const)
    assert.equal(redact(raw), shown, raw);
  // The reads never carry the secrets, stdin or environment values.
  const text = JSON.stringify(all);
  for (const hidden of [secret, 'hunter2', 'stdin-body-never-shown', 'env-value-never-shown'])
    assert.equal(text.includes(hidden), false, hidden);
  const running = thread.read().thread.activeTurnId as string;
  act(thread.store, (effects) =>
    thread.service.stopTurn({ taskId: thread.taskId, turnId: running }, effects),
  );
  await turnReaches(thread, 'stopped');
});

const textReply = (text: string): ChatScriptStep[] => [
  { kind: 'text', itemId: 'r', chunks: [text] },
];

// Claim: Stop ends an open project check and the chain, a message sent meanwhile waits and then
// runs, and a check process the journal cannot prove gone keeps the thread from taking a turn
// until it is gone. A restart reads the open check as failed with the reason.
test('stop during a check keeps the queue, and an orphan check holds the thread', {
  timeout: 60000,
}, async (t) => {
  const now = createTestClock().now();
  const pick = (family: ChatFamily): ChatModelSelection => ({
    family,
    model: `${family}-model`,
    effort: 'default',
  });
  const findings = textReply('Rounding drops a cent.\nFindings: 1');
  const openai = createScriptedChatAdapter({
    family: 'openai',
    turns: ['Built it.', 'Fixed it.', 'Built again.', 'Fixed again.', 'Went on.', 'Then this.'].map(
      textReply,
    ),
  });
  let begun: ((scratch: string) => void) | undefined;
  const adapters = new Map([
    [
      'openai',
      {
        ...openai,
        startTurn(request: ScriptedChatRequest, emit: (event: AgentEvent) => void) {
          if (openai.requests.length === 0) begun?.(request.scratch.directory);
          return openai.startTurn(request, emit);
        },
      },
    ],
    ['anthropic', createScriptedChatAdapter({ family: 'anthropic', turns: [findings, findings] })],
  ] as const);
  const families = [familyEntry('openai', 10, null, now), familyEntry('anthropic', 50, null, now)];
  // The process table the services read. Nothing is present until the restart below.
  let present = false;
  const thread = standalone(t, {
    adapters,
    catalog: () => ({ families }),
    groupAbsent: () => !present,
  });
  const { store, service, taskId } = thread;
  const running = (state: ChatCheckRun['status']) => (event: Event) =>
    event.type === 'chat.thread' &&
    (event.payload as ChatThread).checks?.runs.at(-1)?.status === state;
  // The check runs until the controller stops it.
  begun = (scratch) => {
    writeFileSync(join(scratch, 'block.mjs'), 'setInterval(() => {}, 60_000);\n');
    store.transaction(() =>
      service.configure({
        taskId,
        crew: {
          name: 'Pair',
          members: [
            { role: 'builder', selection: pick('openai') },
            { role: 'reviewer', selection: pick('anthropic') },
          ],
        },
        flightMode: 'glide',
        permissionPolicy: 'allow-all',
        checks: { add: 'node block.mjs' },
      }),
    );
  };
  const open = next(thread, running('running'));
  thread.send('Fix the rounding.', pick('openai'));
  await open;
  // The thread takes no turn while the check runs.
  assert.equal(thread.send('One more thing.', pick('openai')).outcome, 'applied');
  assert.equal(thread.read().thread.queued.length, 1);
  assert.equal(thread.read().turns.length, 3);

  const stoppedLine = next(
    thread,
    (event) =>
      event.type === 'conversation.entry' &&
      /^Crew stopped/.test((event.payload as { text: string }).text),
  );
  const second = next(thread, (event) => {
    const checks = event.type === 'chat.thread' ? (event.payload as ChatThread).checks : undefined;
    return checks?.runs.length === 2 && checks.runs[1].status === 'running';
  });
  const stopped = act(store, (effects) =>
    service.stopTurn({ taskId, turnId: thread.read().turns.at(-1)?.id as string }, effects),
  );
  assert.equal(stopped.outcome, 'applied');
  // Stop keeps what the person queued. It is not handed back to the composer.
  assert.equal(stopped.data?.kind === 'chat-queue' && stopped.data.messages.length, 0);
  assert.equal(thread.read().thread.queued.length, 1);
  await stoppedLine;
  const after = thread.read();
  assert.equal(
    after.messages.find((m) => m.text.startsWith('Crew stopped'))?.text,
    'Crew stopped: you stopped the checks.',
  );
  const [first] = after.thread.checks?.runs ?? [];
  assert.deepEqual([first.status, first.reason], ['stopped', 'You stopped it.']);
  // The queued message runs after the chain stopped, and its own chain reaches the check again.
  await second;
  const again = thread.read();
  assert.deepEqual(
    again.turns.map((turn) => turn.role),
    ['assistant', 'reviewer', 'fixer', 'assistant', 'reviewer', 'fixer'],
  );
  assert.equal(again.thread.queued.length, 0);

  // The controller stops with that check open. Its process is alive, so the journal cannot prove
  // it gone: the thread takes no turn, and the open run reads as failed with the reason.
  present = true;
  const restarted = thread.start();
  restarted.recover();
  const held = thread.read(restarted);
  assert.equal(held.thread.ownershipUnknown, true);
  const [, orphan] = held.thread.checks?.runs ?? [];
  assert.equal(orphan.status, 'failed');
  assert.match(orphan.reason ?? '', /^CrewKite restarted while this check ran\./);
  // A message waits in the queue while the hold stands.
  assert.equal(thread.send('Go on.', pick('openai'), restarted).outcome, 'applied');
  assert.equal(thread.read(restarted).thread.queued.length, 1);
  assert.equal(thread.read(restarted).turns.length, 6);
  // Once the process table shows the group gone, the next command lifts the hold and the queue
  // runs.
  present = false;
  store.transaction(() => restarted.configure({ taskId, flightMode: 'manual' }));
  const done = settles(thread);
  assert.equal(thread.send('Then this.', pick('openai'), restarted).outcome, 'applied');
  await done;
  const last = thread.read(restarted);
  assert.equal(last.thread.ownershipUnknown, undefined);
  assert.deepEqual(
    last.turns.slice(6).map((turn) => turn.state),
    ['done', 'done'],
  );
  // The check of the first service is still running; closing it ends the process.
  service.close();
});

// Claim: a check is plain words the controller resolves itself. Balanced asks before every run,
// naming the exact commands, and a no skips the checks. Glide runs them when its policy covers
// commands and asks again when the script changed. The same checks run on a merged copy.
test('checks refuse shell lines, ask before running and run on a merged copy', {
  timeout: 30000,
}, async (t) => {
  const thread = standalone(t, {
    adapters: new Map([
      ['openai', createScriptedChatAdapter({ family: 'openai', turns: [textReply('Built.')] })],
    ]),
  });
  const { store, service, taskId } = thread;
  const dir = mkdtempSync(join(tmpdir(), 'crewkite-merged-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gate =
    "import { existsSync } from 'node:fs';\nif (existsSync('ok')) process.exit(0);\nconsole.log('broken total');\nprocess.exitCode = 1;\n";
  const merged = (name: string, ok: boolean, script = gate) => {
    mkdirSync(join(dir, name));
    if (ok) writeFileSync(join(dir, name, 'ok'), '');
    writeFileSync(join(dir, name, 'gate.mjs'), script);
    return realpathSync(join(dir, name));
  };
  const done = turnReaches(thread, 'done');
  thread.send('Build it.');
  const built = await done;
  const configure = (patch: object) =>
    store.transaction(() => service.configure({ taskId, ...patch }));
  // The same script as the merged copies hold, in the scratch copy the person turns it on from.
  writeFileSync(join(dirname(thread.root), 'chat', taskId, 'scratch', 'gate.mjs'), gate);
  for (const add of [
    'sh -c x',
    'npm test | cat',
    'node "a b"',
    'env FOO=1 node gate.mjs',
    'node -e 1',
    'python3 -c x',
    'node /etc/passwd',
    'node ../gate.mjs',
  ]) {
    const refused = configure({ checks: { add } });
    assert.deepEqual([refused.outcome, refused.reason], ['blocked', 'checks-invalid'], add);
  }
  assert.equal(configure({ checks: { add: 'node gate.mjs' } }).outcome, 'applied');
  assert.equal(configure({ checks: { add: 'node gate.mjs' } }).reason, 'checks-invalid');
  assert.equal(
    configure({ checks: { switch: { id: 'nothing:test', enabled: true } } }).reason,
    'checks-invalid',
  );

  const answer = (choice: 'allow' | 'allow-thread' | 'deny') => {
    const ask = thread.read().thread.checks?.ask;
    assert.ok(ask, 'a question is waiting');
    const result = act(store, (effects) =>
      service.resolvePermission(
        { taskId, turnId: built.id, requestId: ask.requestId, choice },
        effects,
      ),
    );
    assert.equal(result.outcome, 'applied');
    return ask;
  };
  // Manual and Balanced ask, whatever the policy. The question names the exact command.
  configure({ permissionPolicy: 'allow-all' });
  const first = merged('first', false);
  const refused = service.runCombinedChecks(taskId, first);
  const ask = answer('deny');
  assert.deepEqual(ask.commands, [{ label: 'node gate.mjs', resolved: 'node gate.mjs' }]);
  assert.deepEqual(ask.changed, []);
  assert.equal((await refused).outcome, 'denied');
  assert.equal(thread.read().thread.checks?.runs.length, 0);
  assert.equal(thread.read().thread.checks?.ask, null);

  // Glide with Allow all runs without a question.
  configure({
    crew: { name: 'Solo', members: [{ role: 'builder', selection }] },
    flightMode: 'glide',
  });
  const quiet = service.runCombinedChecks(taskId, merged('second', true));
  assert.equal(thread.read().thread.checks?.ask, null);
  assert.equal((await quiet).outcome, 'passed');

  // Balanced asks again. Allow for this thread covers the same command set afterwards.
  configure({ flightMode: 'balanced' });
  const pending = service.runCombinedChecks(taskId, first);
  answer('allow-thread');
  const failed = await pending;
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.brief ?? '', /broken total/);
  assert.deepEqual(
    failed.runs.map((run) => [run.status, run.trigger]),
    [['failed', 'combined']],
  );
  const covered = service.runCombinedChecks(taskId, merged('fourth', true));
  assert.equal(thread.read().thread.checks?.ask, null);
  assert.equal((await covered).outcome, 'passed');

  // A changed script asks in every mode, even for an allowed command set.
  const edited = service.runCombinedChecks(taskId, merged('third', true, `${gate}// edited\n`));
  assert.deepEqual(answer('deny').changed, ['node gate.mjs']);
  assert.equal((await edited).outcome, 'denied');
  // A service that has closed refuses, and so does a task it does not know.
  await assert.rejects(service.runCombinedChecks(`tsk_${'9'.repeat(26)}`, first), /No thread/);
  configure({ checks: { switch: { id: 'custom:1', enabled: false } } });
  assert.equal((await service.runCombinedChecks(taskId, first)).outcome, 'none');
  assert.equal(configure({ checks: { remove: 'custom:1' } }).outcome, 'applied');
  service.close();
  await assert.rejects(service.runCombinedChecks(taskId, first), /closed/);
});
