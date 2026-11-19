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
import { basename, dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  AcceptanceAttempt,
  AgentEvent,
  Artifact,
  BillingMode,
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
  Connection,
  ConnectionAssignment,
  DependencyPreparation,
  DesignSystem,
  Event,
  Project,
  RemoteEffect,
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
import { Controller } from '../commands/controller.ts';
import { liveOperations } from '../commands/live-operations.ts';
import { OperationStore } from '../commands/operation-store.ts';
import type {
  OwnedProjectCommandRunner,
  OwnedProjectCommandTerminal,
} from '../commands/project-command.ts';
import { designBrief } from '../design/brief.ts';
import { DesignSystems } from '../design/service.ts';
import { RemoteEffects } from '../github/effects.ts';
import { DependencyPreparer, detectDependencies } from '../host/dependencies.ts';
import { git } from '../host/source.ts';
import { localChatAdapter } from '../providers/local/chat.ts';
import { fakeModel } from '../providers/local/chat-fake.ts';
import { installedTools, setup } from '../store/controller-fixture.ts';
import { type LaunchIdentity, Store } from '../store/index.ts';
import {
  type ChatAdapter,
  type ChatTurnRequest,
  type ChatTurnResult,
  chatFailure,
} from './adapter.ts';
import { deleteThreadBaseRef, threadBaseRef } from './changes.ts';
import { Connections } from './connections.ts';
import { detectType } from './files.ts';
import { McpRegistry } from './mcp-servers.ts';
import { parsePlan } from './plan.ts';
import { stripTurnNotes } from './prompt.ts';
import { chatScratchDirectory } from './scratch-folder.ts';
import { ChatService, type ChatServiceDeps } from './service.ts';
import { redact } from './thread-reader.ts';
import { AskingTurnError, answer } from './thread-tools/broker.ts';

const selection = { family: 'openai', model: 'fixture-model', effort: 'default' } as const;

async function open<Adapter extends ChatAdapter>(t: TestContext, adapter: Adapter) {
  // A push runs git from a PATH that holds git alone, so no installed gh is ever found.
  const tools = mkdtempSync(join(tmpdir(), 'ck-chat-git-'));
  t.after(() => rmSync(tools, { recursive: true, force: true }));
  const context = await setup(t, {
    chatAdapters: new Map([['openai', adapter]]),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
    gitEnvironment: { HOME: tools, PATH: installedTools(tools, 'git') },
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
  // A new thread's copy is named after the project, so a client that lists saved sessions by
  // folder shows the project name.
  assert.equal(basename(request.scratch.directory), 'demo-shop');
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

test('stop ends the turn as stopped, keeps the text already streamed and says the person stopped it', {
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
  assert.equal(turn.stopCause, 'person');
  const thread = await read();
  assert.equal(thread.messages.at(-2)?.text, 'Partial answer');
  assert.equal(thread.messages.at(-2)?.id, turn.assistantMessageId);
  assert.deepEqual(
    [thread.messages.at(-1)?.author, thread.messages.at(-1)?.text],
    [{ kind: 'system', turnId }, 'Stopped: you pressed Stop.'],
  );
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
  const terms = { acknowledged: true };
  const start = () =>
    new ChatService({
      store,
      artifacts: new ArtifactFiles(join(directory, 'artifacts')),
      home: directory,
      googleTermsAcknowledged: () => terms.acknowledged,
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
      remoteEffects: new RemoteEffects({
        store,
        home: directory,
        now: clock.now,
        id: () => ids('rfx'),
        projectPath: () => repository.directory,
        // An ssh configuration that maps every name to itself, so no real one is read.
        sshHost: (alias) => alias,
      }),
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
  return { clock, store, taskId, service, start, send, read, terms, root: repository.directory };
}

/** A catalog entry with one model and one weekly window. */
function familyEntry(
  family: ChatFamily,
  percent: number | null,
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

test('recovery removes the folders one-off turns left behind and leaves a linked folder alone', (t) => {
  for (const linked of ['nothing', 'one-turns', 'chat'] as const) {
    const home = mkdtempSync(join(tmpdir(), 'crewkite-home-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    // A folder outside the home shaped like the one the sweep removes.
    const outside = mkdtempSync(join(tmpdir(), 'crewkite-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(outside, 'one-turns', 'x'), { recursive: true });
    writeFileSync(join(outside, 'one-turns', 'x', 'file'), 'kept');
    const chat = join(home, 'chat');
    const root = join(chat, 'one-turns');
    if (linked === 'nothing') {
      mkdirSync(join(root, 'trn_left', 'scratch'), { recursive: true });
      writeFileSync(join(root, 'trn_left', 'scratch', 'file'), 'left');
    } else if (linked === 'one-turns') {
      mkdirSync(chat);
      symlinkSync(join(outside, 'one-turns'), root);
    } else symlinkSync(outside, chat);

    standalone(t, { home }).service.recover();

    if (linked === 'nothing') assert.equal(existsSync(root), false);
    else if (linked === 'one-turns') assert.equal(readlinkSync(root), join(outside, 'one-turns'));
    else assert.equal(readFileSync(join(outside, 'one-turns', 'x', 'file'), 'utf8'), 'kept');
  }
});

// The test replaces the process table, so no group number is signaled for real.
test('a provider process that outlives its turn blocks the thread until a later check finds it gone', {
  timeout: 30000,
}, async (t) => {
  const group = 4242;
  const reused = 4300;
  const present = new Set([group]);
  const signals: string[] = [];
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
      'CrewKite checks again before the next command. If it stays, export diagnostics before taking further action.',
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
    [
      'ownership-unknown',
      'CrewKite cannot confirm that provider process group 4242 ended. This process number may now belong to another program. Other threads still work. Export diagnostics from Settings, under General, before taking further action.',
    ],
  );
  // Preparing the copy's dependencies waits the same way, since the process may still use them.
  const prepare = store.transaction(() => thread.service.preparationRefusal(taskId));
  assert.deepEqual([prepare?.reason, prepare?.next], [accept.reason, accept.next]);

  // A message sent meanwhile waits. A restart while the group is present keeps the block and
  // starts nothing, after a reboot too: a clock comparison never proves a process ended.
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
    { name: 'stop pauses', send: later, remove: null, end: 'stop', asked: [first] },
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
    const scripted = createScriptedChatAdapter({
      family: 'openai',
      turns: [
        [
          { kind: 'permission', requestId: 'edit-1', question: 'Edit net.mjs?' },
          { kind: 'text', itemId: 'reply', chunks: ['Done.'] },
        ],
        [{ kind: 'text', itemId: 'reply', chunks: ['Done.'] }],
      ],
    });
    const mcp = new McpRegistry();
    const thread = standalone(t, {
      // The thread tools socket failed to open: every cloud turn says so and runs without them.
      threadToolsDown: () => true,
      mcp,
      adapters: new Map([['openai', scripted]]),
    });
    const { store, service, taskId } = thread;
    // The thread turned a server on. OpenAI cannot route its calls through the gate, so the
    // controller leaves it out of the request and says so in the request's notes.
    mcp.set({
      servers: [
        {
          name: 'notes',
          command: 'notes-server',
          args: [],
          secretArgs: [],
          env: {},
          readTools: [],
        },
      ],
      threads: { [taskId]: { notes: 'all' } },
    });
    const parked = turnReaches(thread, 'waiting-permission');
    thread.send(first);
    const { id: turnId } = await parked;
    const sent = (scripted.requests as unknown as ChatTurnRequest[])[0]?.mcp;
    assert.deepEqual(sent?.servers, []);
    assert.match(sent?.notes[0] ?? '', /^MCP server notes is off for this turn\./);
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

    // A stopped turn leaves its queue paused, so the thread frees with messages still waiting.
    const idle =
      row.end === 'stop'
        ? next(
            thread,
            (event) =>
              event.type === 'chat.thread' && (event.payload as ChatThread).activeTurnId === null,
          )
        : settles(thread);
    const effects: (() => void)[] = [];
    const ended = store.transaction(() =>
      row.end === 'stop'
        ? service.stopTurn({ taskId, turnId }, effects)
        : service.resolvePermission(
            { taskId, turnId, requestId: 'edit-1', choice: 'allow-once' },
            effects,
          ),
    );
    // Stop names the messages still waiting. Nothing goes back to the composer.
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
    // The paused queue keeps every message, in order, and starts none of them by itself.
    assert.deepEqual(
      [after.thread.queued.map((message) => message.text), after.thread.queuePaused],
      row.end === 'stop' ? [row.send.slice(0, 8), true] : [[], undefined],
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

    // A side question carries the thread packet. With no thread tools, the packet does not name
    // them, and the turn carries the same answer for the client's config.
    // A new message starts at once beside a paused queue.
    const asking = turnReaches(thread, 'done');
    const effects2: (() => void)[] = [];
    store.transaction(() =>
      service.ask(
        { taskId, family: 'openai', model: selection.model, question: 'Which file?' },
        effects2,
      ),
    );
    for (const effect of effects2) effect();
    await asking;
    const side = (scripted.requests as unknown as ChatTurnRequest[]).at(-1);
    assert.match(side?.prompt ?? '', /^This is a side question to OpenAI/, row.name);
    assert.doesNotMatch(side?.prompt ?? '', /Thread tools are available/, row.name);
    assert.equal(side?.threadTools, false, row.name);
    if (row.end !== 'stop') continue;
    assert.equal(thread.read().thread.queued.length, Math.min(row.send.length, 8), row.name);

    // Send now on a paused message starts that one. The rest stay paused, and the queue clears
    // its pause once it empties.
    const chosen = thread.read().thread.queued[1];
    const sentNow = turnReaches(thread, 'done');
    const now = act(store, (work) => service.steer({ taskId, messageId: chosen.id }, work));
    assert.equal(now.outcome, 'applied', row.name);
    await sentNow;
    const resumed = thread.read();
    assert.equal(users(resumed).at(-1)?.id, chosen.id, row.name);
    assert.deepEqual(
      resumed.thread.queued.map((message) => message.id),
      waiting.thread.queued.filter((message) => message.id !== chosen.id).map((m) => m.id),
      row.name,
    );
    assert.equal(resumed.thread.queuePaused, true, row.name);
    store.transaction(() => {
      for (const message of resumed.thread.queued)
        service.configure({ taskId, dequeue: message.id });
    });
    assert.equal(thread.read().thread.queuePaused, undefined, row.name);
  }

  // One running turn per family: a second thread's message on the same family waits in its own
  // queue and starts when the first thread's turn ends. Another family starts at once, and here
  // it stops on its limit.
  const shared = createScriptedChatAdapter({
    family: 'openai',
    turns: [
      [{ kind: 'wait' }],
      [{ kind: 'text', itemId: 'reply', chunks: ['Answered.'] }],
      [{ kind: 'text', itemId: 'reply', chunks: ['Second.'] }],
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
  const usage: [ChatFamily, string][] = [];
  const one = standalone(t, {
    adapters: new Map<ChatFamily, ChatAdapter>([
      ['openai', shared],
      ['google', other],
    ]),
    onTurnSettled: (family, taskId) => usage.push([family, taskId]),
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
  // Google stays off until the current terms are acknowledged, whatever the pick.
  one.terms.acknowledged = false;
  assert.equal(sendTo(third.id, 'Too early.', google).reason, 'google-terms-not-acknowledged');
  one.terms.acknowledged = true;
  assert.equal(sendTo(third.id, 'On Google.', google).next, undefined);
  await elsewhere;
  assert.equal(other.requests.length, 1);
  // A side question reads only and runs in a fresh session of its own, so it starts at once on a
  // family busy in another thread, and it never joins the queue. Its usage is read when it ends,
  // like any turn's.
  const answered = next(
    one,
    (event) =>
      event.type === 'chat.turn' &&
      event.taskId === third.id &&
      (event.payload as ChatTurn).role === 'ask' &&
      (event.payload as ChatTurn).state === 'done',
  );
  const asked = act(one.store, (effects) =>
    one.service.ask(
      { taskId: third.id, family: 'openai', model: 'fixture-model', question: 'Why?' },
      effects,
    ),
  );
  assert.deepEqual([asked.outcome, asked.next], ['applied', undefined]);
  assert.deepEqual(one.service.readThread({ taskId: third.id, limit: 100 }).thread.queued, []);
  await answered;
  assert.deepEqual(usage.at(-1), ['openai', third.id]);
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
  assert.deepEqual(
    shared.requests.map((request) => [request.role, request.prompt.split('\n').at(-1)]),
    [
      ['assistant', 'First thread.'],
      ['ask', 'Why?'],
      ['assistant', 'Second thread.'],
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
  // Each turn carries CrewKite's reading of its family's tightest window, so the adapter can
  // tell a client's early usage warning from a low allowance.
  assert.deepEqual(
    (['openai', 'google'] as const).map(
      (family) =>
        (on.adapters.get(family)?.requests as unknown as ChatTurnRequest[] | undefined)?.[0]
          ?.allowanceLeft,
    ),
    [99, 80],
  );
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
  // This controller has its thread tools, so the packet names them.
  assert.match(request.prompt, /^Thread tools are available: thread_turns,/m);
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
  // The resumed message carries only the writing rules block in front of it.
  assert.equal(stripTurnNotes(google[3].prompt), 'Think harder.');
  await answer('Try the new model.', { ...pick('google'), model: 'google-model-2' });
  assert.equal(google[4].session, null);
  assert.match(
    google[4].prompt,
    /^This thread continues on Google in a new session\. Reason: model changed in the composer\.$/m,
  );
  assert.match(google[4].prompt, /^Person:\nThink harder\.$/m);
  const changed = off.read();
  assert.equal(changed.turns.at(-1)?.handoffFrom, 'google');
  // The listed model shows its picker label (the fixture labels google-model as google), and an
  // ID the catalog does not list shows as itself.
  assert.equal(
    changed.messages.at(-2)?.text,
    'Continued on Google (google-model-2) from Google (google). Reason: model changed in the composer.',
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
  // Only the builder's session is resumed, so the other two open no saved session.
  assert.equal(assistant.resumable, true);
  assert.equal(reviewer.resumable, false);
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
  assert.equal(side.resumable, false);
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
// asks about `asks[N]`: a tool kind, null for a request with no tool call, `{ first }` for a call
// whose ask names its kind and comes before its tool starts, or nothing once the list runs out.
// It keeps every request it receives.
function editingAdapter(
  asks: readonly (ChatToolKind | null | { first: ChatToolKind })[],
  input?: unknown,
) {
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
          if (typeof ask === 'string')
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
            ...(ask && typeof ask === 'object' ? { kind: ask.first } : {}),
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
// An ask that names its kind before its tool starts is kept by that kind.
test('allow for this thread records the tool kind for later assistant turns and nothing else', {
  timeout: 30000,
}, async (t) => {
  const { controller, adapter, task, run, send, read } = await open(
    t,
    editingAdapter(['edit', null, 'command', { first: 'command' }]),
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
  await allow(() => send('Now the totals.'));
  assert.deepEqual((await read()).thread.permissionGrants, ['edit', 'command']);
  // The person's answer comes back from the adapter without a source, and the thread names them.
  assert.ok(
    agentEvents(controller).every(
      (event) => event.type !== 'permission.resolved' || event.answeredBy === 'person',
    ),
  );

  const last = turnReaches(controller, 'done');
  await send('Then the docs.');
  await last;
  assert.deepEqual(
    adapter.requests.map((request) => request.permissionGrants),
    [[], ['edit'], [], ['edit'], ['edit', 'command']],
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
  const branch = 'refs/heads/feat/fix-rounding';
  const accept = () => run('AcceptChatChanges', { branch: 'feat/fix-rounding' }, task.revision);

  const result = await accept();
  assert.equal(result.outcome, 'applied');
  const commit = repo('rev-parse', branch);
  assert.deepEqual(result.data, {
    kind: 'chat-acceptance',
    branch: 'feat/fix-rounding',
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
    // The title's plain first word goes to lower case, as the Changes tab suggests it.
    'feat: add netMinor(subtotalMinor, discountMinor)|Fixture owner <owner@example.invalid>',
  );
  assert.deepEqual(checkout(), before);
  assert.equal(pinned(), commit);
  const thread = await read();
  assert.equal(thread.thread.lastAcceptance?.commit, commit);
  assert.equal(thread.messages.at(-1)?.text, 'Accepted 1 file to branch feat/fix-rounding.');

  assert.equal((await accept()).reason, 'branch-exists');
  assert.equal(repo('rev-parse', branch), commit);

  // The push runs outside the command transaction and still journals the thread. Fetches name a
  // github.com repository and pushes go to a local bare one, so no network is used.
  const remote = join(source.directory, '..', 'remote.git');
  git(source.directory, ['init', '--quiet', '--bare', remote]);
  repo('remote', 'add', 'origin', 'git@github.com:crew-kite/demo-shop.git');
  repo('remote', 'set-url', '--push', 'origin', remote);
  const pushed = await run(
    'PushChatBranch',
    { branch: 'feat/fix-rounding', commit, confirmed: true },
    task.revision,
  );
  assert.equal(pushed.outcome, 'applied');
  assert.equal(git(remote, ['rev-parse', branch]).toString('utf8').trim(), commit);
  const after = await read();
  assert.equal(after.thread.lastPush?.commit, commit);
  assert.equal(after.messages.at(-1)?.text, 'Pushed feat/fix-rounding to origin.');

  // The base advanced to the accepted commit, so Changes is empty and the next Accept stacks on it.
  // Every read loads the thread record from the store, so a restarted controller sees the same base.
  assert.equal(after.thread.base, commit);
  const changes = await run('ReadChatChanges', {});
  assert.deepEqual(
    { ...(changes.data as object), listing: null },
    {
      kind: 'chat-changes',
      taskId: task.id,
      base: commit,
      files: [],
      total: 0,
      next: null,
      listing: null,
    },
  );
  // HEAD moves on. Accept still starts from the thread's base and leaves HEAD where it is.
  advance(repo('rev-parse', 'HEAD^{tree}'));
  const moved = checkout();
  appendFileSync(join(scratch, 'net.mjs'), '// second\n');
  const second = await run('AcceptChatChanges', { branch: 'feat/second' }, task.revision);
  const note = `The branch starts at this thread's base commit ${commit.slice(0, 7)}. HEAD stays where it is.`;
  assert.deepEqual([second.outcome, second.next], ['applied', note]);
  const stacked = repo('rev-parse', 'refs/heads/feat/second');
  assert.equal(repo('rev-parse', 'refs/heads/feat/second^'), commit);
  assert.equal(repo('diff', '--name-only', commit, stacked), 'net.mjs');
  assert.deepEqual(checkout(), moved);
  const last = await read();
  assert.equal(last.thread.base, stacked);
  assert.equal(pinned(), stacked);
  assert.equal(last.messages.at(-1)?.text, `Accepted 1 file to branch feat/second. ${note}`);
  // Thread delete removes the ref and nothing else.
  deleteThreadBaseRef(source.directory, task.id);
  assert.equal(repo('for-each-ref', 'refs/crewkite/'), '');
  assert.deepEqual(checkout(), moved);
});

test('accept, discard and a dependency preparation are refused while a turn is running', {
  timeout: 30000,
}, async (t) => {
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
  // Preparing would remove the copy's node_modules under the turn.
  const prepare = await run(
    'PrepareDependencies',
    { scope: 'thread', scopeKey: task.id, consent: 'explicit' },
    task.revision,
  );
  assert.deepEqual([prepare.outcome, prepare.reason], ['blocked', 'thread-busy']);
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
      accept: 'feat/link-replaced',
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
      accept: 'feat/link-removed',
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
test('the crew chain runs review, fix, second review and challenger, and stops where a step stops', async (t) => {
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
        ['fixer', 'openai'],
        ['reviewer', 'anthropic'],
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
        ['fixer', 'openai'],
        ['reviewer', 'anthropic'],
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
      // An Ask sent while the orchestrator reads stops neither the plan nor a chain. It runs at
      // once beside the orchestrator.
      ask: 'Why two parts?',
      turns: [
        ['orchestrator', 'openai'],
        ['ask', 'google'],
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
        ['assistant', 'openai'],
        ['reviewer', 'anthropic'],
        ['challenger', 'google'],
      ],
      line: 'Crew finished: 2 slices, 2 reviews, 0 fixes.',
      // Each slice reviews in its own lane. The thread's chain holds the challenge alone.
      chain: { step: 'finished', reviewRounds: 0, fixes: 0, reason: null },
      builderAt: 4,
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
      name: "balanced waits for Run plan, and an override moves a slice to the crew's fixer model",
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
      chain: { step: 'finished', reviewRounds: 0, fixes: 0, reason: null },
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
        // Retry under the failed slice runs it again, and the plan goes on to slice 2 (H9).
        reply('Built 1.'),
        reply('Built 2.'),
      ],
      retry: true,
      reviews: [reply('Clean.\nFindings: 0'), reply('Clean.\nFindings: 0')],
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
      plan: [
        reply('```json plan\n{"planId": "p1"}\n```'),
        reply('```json plan\n{"planId": "p1"}\n```'),
      ],
      builds: [reply('Unused.')],
      reviews: [reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      turns: [
        ['orchestrator', 'openai'],
        ['orchestrator', 'openai'],
      ],
      line: `Plan stopped: the plan did not pass validation. ${(parsePlan('```json plan\n{"planId": "p1"}\n```') as { error: string }).error}`,
      chain: null,
      card: null,
    },
    {
      // A question gets its answer from the orchestrator, with no plan and nothing after it (H13).
      name: 'an orchestrator that answers directly runs no plan',
      plan: [reply('Halloween 2027 falls on a Sunday.')],
      builds: [reply('Unused.')],
      reviews: [reply('Clean.\nFindings: 0')],
      autoHandoff: undefined,
      turns: [['orchestrator', 'openai']],
      line: 'Halloween 2027 falls on a Sunday.',
      chain: null,
      card: null,
      answered: true,
    },
  ] as const;
  // Each row is a subtest with its own budget, and its thread closes when the row ends.
  for (const row of cases)
    await t.test(row.name, { timeout: 30000 }, async (t) => {
      const now = createTestClock().now();
      const planned = 'plan' in row;
      // The gate script lives in the scratch copy, as a project's own script would. It fails the
      // first time it runs, after the builder, and passes after the fixer it sends. Its marker
      // sits outside the copy, because a check that changes the copy cannot pass. The row turns
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
            appendFileSync(
              join(request.scratch.directory, 'gate.mjs'),
              '\n// edited by the fixer\n',
            );
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
          // The card offers the crew's own models, so the override picks the fixer's.
          ...('balanced' in row ? [{ role: 'fixer', selection: pick('anthropic') } as const] : []),
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
              `const marker = ${JSON.stringify(join(dirname(thread.root), 'gate-ran'))};`,
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
      // A direct answer writes no closing line, so the row waits for its reply.
      const ended =
        'answered' in row
          ? settles(thread)
          : next(
              thread,
              (event) =>
                event.type === 'conversation.entry' &&
                /^(Crew|Plan) (finished|stopped)/.test((event.payload as { text: string }).text),
            );
      if (balanced) {
        const proposed = next(
          thread,
          (event) =>
            event.type === 'chat.thread' &&
            (event.payload as ChatThread).plan?.phase === 'proposed',
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
        // Only a candidate on the card can take a slice.
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
        // Only the gate after the builder ran before the question.
        const raised = (
          await next(
            thread,
            (event) => event.type === 'chat.thread' && !!(event.payload as ChatThread).checks?.ask,
          )
        ).payload as ChatThread;
        assert.equal(raised.checks?.runs.length, 1, row.name);
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
      assert.equal(read.messages.at(-1)?.text, row.line, row.name);
      if (row.chain === null) assert.equal(read.thread.crewChain, null, row.name);
      else {
        const { builderTurnId, ...chain } = read.thread.crewChain ?? {};
        assert.equal(
          builderTurnId,
          read.turns['builderAt' in row ? row.builderAt : 0].id,
          row.name,
        );
        assert.deepEqual(chain, row.chain, row.name);
      }
      if (planned) {
        const card = read.thread.plan;
        assert.deepEqual(
          card ? [card.phase, ...card.slices.map((value) => value.status)] : null,
          row.card,
          row.name,
        );
        if ('retry' in row) {
          const failed = read.turns.find((turn) => turn.slice === 1);
          const finished = next(
            thread,
            (event) =>
              event.type === 'conversation.entry' &&
              /^Crew finished/.test((event.payload as { text: string }).text),
          );
          // A slice turn takes no Regenerate, and Retry runs only the slice, not a new message.
          assert.equal(
            act(store, (effects) =>
              service.retryTurn(
                { taskId, turnId: failed?.id as string, mode: 'regenerate' },
                effects,
              ),
            ).reason,
            'slice-turn',
            row.name,
          );
          assert.equal(
            act(store, (effects) =>
              service.retryTurn({ taskId, turnId: failed?.id as string, mode: 'retry' }, effects),
            ).outcome,
            'applied',
            row.name,
          );
          await finished;
          const again = thread.read();
          const plan = again.thread.plan;
          assert.deepEqual(
            plan ? [plan.phase, ...plan.slices.map((value) => value.status)] : null,
            ['finished', 'done', 'done'],
            row.name,
          );
          assert.equal(
            plan?.slices[0].assignment?.reason,
            "Slice 1 (medium) assigned to OpenAI (openai-model): Builder, the crew's model.",
            row.name,
          );
          // No turn ran outside the plan: every turn after the orchestrator is a slice or the
          // challenge after the last one.
          assert.deepEqual(
            again.turns.map((turn) => [turn.role, turn.slice ?? null]),
            [
              ['orchestrator', null],
              ['assistant', 1],
              ['assistant', 1],
              ['reviewer', 1],
              ['assistant', 2],
              ['reviewer', 2],
              ['challenger', null],
            ],
            row.name,
          );
          return;
        }
        const asked = adapters.get('openai')?.requests ?? [];
        assert.equal(asked[0]?.role, 'orchestrator', row.name);
        assert.match(asked[0]?.systemContext ?? '', /```json plan/, row.name);
        if ('answered' in row) {
          assert.equal(asked.length, 1, row.name);
          return;
        }
        if (row.card === null) {
          assert.match(asked[1]?.prompt ?? '', /^The plan did not pass validation\. /m, row.name);
          assert.match(asked[1]?.prompt ?? '', /^> Fix the rounding\.$/m, row.name);
          return;
        }
        const lines = read.messages.map((message) => message.text);
        // The card carries the assignment reason, so the thread writes no line that repeats it.
        assert.ok(
          !lines.some(
            (line) =>
              /^Slice \d+ \(\w+\) assigned to /.test(line) &&
              !line.endsWith('picked on the plan card.'),
          ),
          row.name,
        );
        // An override adds the person's pick as a line.
        if ('picked' in row) assert.ok(lines.includes(row.picked), row.name);
        const builtOn = 'builtOn' in row ? row.builtOn : 'openai';
        assert.equal(card?.slices[0].assignment?.family, builtOn, row.name);
        const brief = (builtOn === 'openai' ? asked[1] : adapters.get(builtOn)?.requests[0])
          ?.prompt;
        const of = `Slice 1 of ${row.card.length - 1} in plan p1: Part 1`;
        assert.match(brief ?? '', new RegExp(`^${of}$`, 'm'), row.name);
        assert.match(brief ?? '', /^Do part 1\.$/m, row.name);
        if ('readOnlyAt' in row) {
          const readOnly = asked[row.readOnlyAt] as unknown as ChatTurnRequest | undefined;
          assert.match(readOnly?.prompt ?? '', /^Slice 2 of 2 in plan p1: Part 2$/m, row.name);
          assert.equal(readOnly?.role, 'ask', row.name);
          assert.equal(readOnly?.readOnly, true, row.name);
        }
        return;
      }
      // The person's pick stays on the builder whatever the crew borrowed.
      assert.equal(read.thread.selection?.family, 'openai', row.name);
      if ('gate' in row) {
        // The gate after the builder fails, and its fixer runs on the output before any review.
        const requests = adapters.get('openai')?.requests ?? [];
        assert.equal(requests[1]?.role, 'fixer');
        assert.match(requests[1]?.prompt ?? '', /^The project checks failed in the scratch copy\./);
        assert.match(requests[1]?.prompt ?? '', /gate: expected 3 got 2/);
        // The gate runs again after each fix and passes. The review's fix is the second and last.
        const runs = read.thread.checks?.runs ?? [];
        assert.deepEqual(
          runs.map((run) => [run.status, run.exitCode, run.reason, run.trigger]),
          [
            ['failed', 1, 'Exit code 1.', 'after-write'],
            ['passed', 0, null, 'after-write'],
            ['passed', 0, null, 'after-write'],
          ],
        );
        assert.equal(runs[0].tail, 'gate: expected 3 got 2');
        const files = new ArtifactFiles(join(dirname(thread.root), 'artifacts'));
        assert.equal(
          files.read(runs[0].stdout?.hash ?? '').toString('utf8'),
          'gate: expected 3 got 2\n',
        );
        // Only the edited script asked, and the gate after the second fix ran on the pin the
        // answer renewed.
        assert.equal(asks.length, 'edit' in row ? 1 : 0, row.name);
        const lines = read.messages.map((message) => message.text);
        assert.ok(lines.some((line) => line.startsWith('Checks failed: node ')));
        assert.ok(lines.some((line) => line.startsWith('Checks passed: node ')));
        // A provider reads the newest run of each check through thread_checks.
        const seen = service.threadReads(taskId).checks().lines;
        assert.match(seen.join('\n'), /\): passed in \d+\.\d s/);
        return;
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
      if (row.name !== 'findings 2 then 0') return;
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
    });
});

// A plan's slices run side by side, each in its own scratch copy, and merge in plan order.
// The crew builder on OpenAI takes the medium slices and its fixer on Local the hard ones, so two
// families answer at once.
test('plan slices run side by side in their own copies, merge in plan order and stop together', {
  timeout: 60000,
}, async (t) => {
  const pick = (family: ChatFamily): ChatModelSelection => ({
    family,
    model: `${family}-model`,
    effort: 'default',
  });
  const reply = (text: string): ChatScriptStep => ({ kind: 'text', itemId: 'r', chunks: [text] });
  const write = (path: string, content: string): ChatScriptStep => ({
    kind: 'tool',
    callId: `w-${path}`,
    toolKind: 'edit',
    title: `Write ${path}`,
    write: { path, content },
  });
  const park: ChatScriptStep = { kind: 'permission', requestId: 'park', question: 'Go on?' };
  const failed: ChatScriptStep = {
    kind: 'fail',
    stopReason: 'error',
    failure: chatFailure({ stage: 'stream', kind: 'internal', message: 'Broke.' }),
  };
  const slice = (id: number, difficulty: 'hard' | 'medium', depends: number[] = []) => ({
    id,
    title: `Part ${id}`,
    brief: `Do part ${id}.`,
    files: [],
    depends,
    difficulty,
    readOnly: false,
  });
  const planned = (slices: object[]): ChatScriptStep[] => [
    reply(
      `\`\`\`json plan\n${JSON.stringify({ planId: 'p1', goal: 'Split it.', slices })}\n\`\`\``,
    ),
  ];
  const rows = [
    {
      name: 'two families at once, a shared family waits, a dependency starts from merged work',
      slices: [slice(1, 'medium'), slice(2, 'hard'), slice(3, 'medium'), slice(4, 'hard', [1])],
      openai: [
        [park, write('a.txt', 'one\n'), reply('Built 1.')],
        [write('c.txt', 'three\n')],
        // The message queued during the plan, answered once the plan finished.
        [reply('Queued answer.')],
      ],
      local: [[write('b.txt', 'two\n')], [write('d.txt', 'four\n')]],
      line: 'Crew finished: 4 slices, 0 reviews, 0 fixes.',
      card: ['finished', 'done', 'done', 'done', 'done'],
      files: { 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n', 'd.txt': 'four\n' },
    },
    {
      name: 'a conflict blocks the slice and the orchestrator merges it in one turn',
      slices: [slice(1, 'medium'), slice(2, 'hard')],
      openai: [[write('net.mjs', 'one\n')], [write('net.mjs', 'one\ntwo\n'), reply('Merged.')]],
      // The clean c.txt merges only after the resolve turn ends done.
      local: [[write('net.mjs', 'two\n'), write('c.txt', 'clean\n')]],
      line: 'Crew finished: 2 slices, 0 reviews, 1 fix.',
      card: ['finished', 'done', 'done'],
      files: { 'net.mjs': 'one\ntwo\n', 'c.txt': 'clean\n' },
      conflict: true,
    },
    {
      // No part of the blocked slice reaches the thread copy, its clean c.txt included.
      name: 'a conflict the orchestrator cannot resolve stops the plan with the slice blocked',
      slices: [slice(1, 'medium'), slice(2, 'hard')],
      openai: [[write('net.mjs', 'one\n')], [failed]],
      local: [[write('net.mjs', 'two\n'), write('c.txt', 'clean\n')]],
      line: 'Plan stopped: the orchestrator could not resolve slice 2.',
      card: ['stopped', 'done', 'blocked'],
      files: { 'net.mjs': 'one\n', 'c.txt': null },
      conflict: true,
    },
    {
      // Slice 2 finished while slice 1 runs, so it merges before the stop and is not lost.
      name: 'stop ends every running slice and keeps the finished one',
      slices: [slice(1, 'medium'), slice(2, 'hard'), slice(3, 'hard', [2])],
      openai: [[{ kind: 'wait' } as const]],
      local: [[write('b.txt', 'two\n')]],
      line: 'Plan stopped: you cancelled it.',
      card: ['stopped', 'not-run', 'done', 'not-run'],
      files: { 'b.txt': 'two\n' },
      stop: true,
    },
    {
      // Slice 2 cannot start, and the slice 1 turn opened in the same step never runs.
      name: 'a slice that cannot start stops the plan before a sibling opened beside it runs',
      slices: [slice(1, 'medium'), slice(2, 'hard')],
      openai: [[write('a.txt', 'one\n')]],
      local: [],
      line: 'Plan stopped: slice 2 could not start. Connect this provider in Settings or pick another.',
      card: ['stopped', 'not-run', 'failed'],
      files: {},
      unplugged: true,
    },
    {
      // The thread copy replaced a base link, which never reaches a slice copy. The read-only
      // slice's packet lists what its own copy changed against the base, so it lists nothing.
      name: "a read-only slice's packet carries its own copy's diff, not the thread copy's",
      slices: [{ ...slice(1, 'hard'), readOnly: true }],
      openai: [],
      local: [[reply('Read it.')]],
      line: 'Crew finished: 1 slice, 0 reviews, 0 fixes.',
      card: ['finished', 'done'],
      files: { 'NOTES.md': 'a file now\n' },
      linked: true,
    },
  ];
  for (const row of rows) {
    const now = createTestClock().now();
    const scripted = (family: ChatFamily, turns: ChatScriptStep[][]) =>
      createScriptedChatAdapter({ family, turns });
    const openai = scripted('openai', [planned(row.slices), ...row.openai]);
    const local = scripted('local', row.local);
    // What each slice's copy held when its turn started.
    const held: Record<string, boolean> = {};
    const watch = (adapter: typeof openai) => ({
      ...adapter,
      startTurn(request: ScriptedChatRequest, emit: (event: AgentEvent) => void) {
        held[request.turnId] = existsSync(join(request.scratch.directory, 'a.txt'));
        if ('linked' in row && request.role === 'orchestrator') {
          rmSync(join(request.scratch.directory, 'NOTES.md'));
          writeFileSync(join(request.scratch.directory, 'NOTES.md'), 'a file now\n');
        }
        return adapter.startTurn(request, emit);
      },
    });
    const families = [familyEntry('openai', 10, null, now), familyEntry('local', 90, null, now)];
    const thread = standalone(t, {
      adapters: new Map([
        ['openai', watch(openai)],
        ...('unplugged' in row ? [] : [['local', watch(local)] as const]),
      ]),
      catalog: () => ({ families }),
      localContext: () => 32_768,
      localSliceFits: () => true,
    });
    const { store, service, taskId } = thread;
    if ('linked' in row) {
      // The base gains a link to net.mjs, committed without touching the checkout.
      const repo = (args: string[], input?: string) =>
        git(thread.root, args, input, {
          name: 'Fixture',
          email: 'fixture@example.invalid',
          at: '2026-10-15T18:00:00Z',
        })
          .toString('utf8')
          .trim();
      const blob = repo(['hash-object', '-w', '--stdin'], 'net.mjs');
      const tree = repo(
        ['mktree'],
        `${repo(['ls-tree', 'HEAD'])}\n120000 blob ${blob}\tNOTES.md\n`,
      );
      repo(['update-ref', 'refs/heads/main', repo(['commit-tree', tree, '-p', 'HEAD'], 'link\n')]);
    }
    const crew: ChatCrew = {
      name: 'Plan crew',
      members: [
        { role: 'builder', selection: pick('openai') },
        { role: 'fixer', selection: pick('local') },
        { role: 'orchestrator', selection: pick('openai') },
      ],
    };
    store.transaction(() => service.configure({ taskId, crew, flightMode: 'glide' }));
    const cards: ChatThread[] = [];
    store.subscribe((event) => {
      if (event.type === 'chat.thread' && (event.payload as ChatThread).plan)
        cards.push(event.payload as ChatThread);
    });
    const ended = next(
      thread,
      (event) =>
        event.type === 'conversation.entry' &&
        /^(Crew finished|Plan stopped)/.test((event.payload as { text: string }).text),
    );
    const parked = next(
      thread,
      (event) => event.type === 'agent.event' && event.payload.type === 'permission.requested',
    );
    const merging = next(
      thread,
      (event) =>
        event.type === 'chat.thread' &&
        (event.payload as ChatThread).plan?.slices[1]?.lane?.step === 'merge',
    );
    const queuedAnswer =
      row.name.startsWith('two families') &&
      next(
        thread,
        (event) =>
          event.type === 'conversation.entry' &&
          (event.payload as { text: string }).text === 'Queued answer.',
      );
    thread.send('Split the work.', pick('openai'));
    if (row.name.startsWith('two families')) {
      await parked;
      // Slice 2 ran and finished while slice 1 still waits on its question. It merges after slice
      // 1, in plan order. Slice 3 waits for OpenAI, and slice 4 for slice 1.
      const shown = ((await merging).payload as ChatThread).plan;
      assert.deepEqual(
        shown?.slices.map((value) => [value.status, value.lane?.step ?? null]),
        [
          ['running', 'build'],
          ['running', 'merge'],
          ['queued', null],
          ['queued', null],
        ],
        row.name,
      );
      // A message sent while the plan runs waits in the queue, and the plan goes on (H16).
      assert.equal(thread.send('One more thing.', pick('openai')).outcome, 'applied', row.name);
      const waiting = thread.read().thread;
      assert.deepEqual(
        [waiting.plan?.phase, waiting.queued.map((message) => message.text)],
        ['running', ['One more thing.']],
        row.name,
      );
      const open = thread.read().turns.find((turn) => turn.slice === 1);
      assert.equal(
        act(store, (effects) =>
          service.resolvePermission(
            { taskId, turnId: open?.id as string, requestId: 'park', choice: 'allow-once' },
            effects,
          ),
        ).outcome,
        'applied',
        row.name,
      );
    }
    if ('stop' in row) {
      await merging;
      assert.equal(
        act(store, (effects) => service.cancelPlan({ taskId, planId: 'p1' }, effects)).outcome,
        'applied',
        row.name,
      );
    }
    await ended;
    if ('stop' in row || 'unplugged' in row) await settles(thread);
    const read = thread.read();
    const lines = read.messages.map((message) => message.text);
    // The message queued during the plan starts after the closing line. Each slice turn the stop
    // ended says so on a line of its own once it settles.
    const queuedLines = ['One more thing.', 'Queued answer.'];
    const own = (line: string) => !queuedLines.includes(line) && !line.startsWith('Stopped: ');
    assert.equal(lines.filter(own).at(-1), row.line, row.name);
    if ('stop' in row) assert.ok(lines.includes('Stopped: the plan was cancelled.'), row.name);
    const card = read.thread.plan;
    assert.deepEqual(
      card ? [card.phase, ...card.slices.map((value) => value.status)] : null,
      row.card,
      row.name,
    );
    const scratch = chatScratchDirectory(dirname(thread.root), taskId);
    // A null file is absent from the thread copy.
    for (const [path, content] of Object.entries(row.files as Record<string, string | null>))
      assert.equal(
        existsSync(join(scratch, path)) ? readFileSync(join(scratch, path), 'utf8') : null,
        content,
        `${row.name}: ${path}`,
      );
    // Every slice turn worked in its own copy, never in the thread's or another slice's.
    const requests = [...openai.requests, ...local.requests];
    const copies = requests.flatMap((request) => {
      const turn = read.turns.find((value) => value.id === request.turnId);
      return turn?.slice !== undefined && turn.role === 'assistant'
        ? [[turn.slice, request.scratch.directory] as const]
        : [];
    });
    assert.equal(new Set(copies.map(([, directory]) => directory)).size, copies.length, row.name);
    for (const [id, directory] of copies) {
      assert.notEqual(directory, scratch, row.name);
      assert.ok(directory.endsWith(join('slices', String(id), 'copy')), row.name);
    }
    if (row.name.startsWith('two families')) {
      // Slices start in one turn per family. Slice 4 started from slice 1's merged work.
      assert.deepEqual(
        read.turns.slice(0, 5).map((turn) => [turn.selection.family, turn.slice ?? null]),
        [
          ['openai', null],
          ['openai', 1],
          ['local', 2],
          ['openai', 3],
          ['local', 4],
        ],
        row.name,
      );
      // The queued message starts once the plan has finished, as the orchestrator's next turn.
      await queuedAnswer;
      const after = thread.read();
      assert.deepEqual(
        after.turns.slice(5).map((turn) => [turn.role, turn.state]),
        [['orchestrator', 'done']],
        row.name,
      );
      assert.ok(!after.messages.some((message) => message.text.startsWith('Plan stopped')));
      // The next orchestrator turn reads the earlier plan and its slice results (H10).
      const planning = openai.requests.at(-1)?.prompt ?? '';
      assert.match(planning, /^Conversation so far, oldest first:/m, row.name);
      assert.match(planning, /^Slice 1 of 4 in plan p1: Part 1$/m, row.name);
      assert.match(
        planning,
        /^The last plan in this thread:\nGoal: Split it\.\nPlan: finished\.$/m,
        row.name,
      );
      assert.match(planning, /^Slice 1, Part 1: done, on OpenAI \(openai-model\)\.$/m, row.name);
      assert.match(planning, /^Slice 2, Part 2: done, on Local \(local-model\)\.$/m, row.name);
      const fourth = read.turns.find((turn) => turn.slice === 4);
      assert.equal(held[fourth?.id ?? ''], true, row.name);
      // A slice and the orchestrator never resume their sessions, so neither saves one.
      const sent = openai.requests as unknown as ChatTurnRequest[];
      const lanes = sent.filter((request) => request.slice !== undefined);
      assert.ok(lanes.length > 0, row.name);
      assert.ok(
        lanes.every((request) => request.resumable === false),
        row.name,
      );
      assert.equal(sent.at(-1)?.resumable, false, row.name);
      const finished = lines.filter((line) => /^Slice \d finished/.test(line));
      assert.deepEqual(
        finished,
        [1, 2, 3, 4].map((id) => `Slice ${id} finished: 1 file merged.`),
        row.name,
      );
      assert.ok(lines.includes('Slice 2 started on Local (local-model).'), row.name);
      // Each start line sits just before its slice's brief, so it reads ahead of the turn.
      for (const turn of read.turns.filter(
        (value) => value.slice !== undefined && value.role === 'assistant',
      )) {
        const brief = read.messages.findIndex((message) => message.id === turn.userMessageId);
        assert.match(
          read.messages[brief - 1]?.text ?? '',
          new RegExp(`^Slice ${turn.slice} started on `),
          row.name,
        );
      }
    }
    if ('conflict' in row) {
      const blocked = cards.find((value) => value.plan?.slices[1]?.status === 'blocked')?.plan;
      assert.deepEqual(blocked?.slices[1]?.conflicts, ['net.mjs'], row.name);
      assert.ok(
        lines.includes(
          'Slice 2 blocked: 1 file conflicts with the thread copy: net.mjs. The orchestrator gets one turn to resolve it.',
        ),
        row.name,
      );
      // The orchestrator's model resolves in the thread copy, with the slice's version quoted.
      const resolve = openai.requests.at(-1);
      assert.equal(resolve?.role, 'fixer', row.name);
      assert.equal(resolve?.scratch.directory, scratch, row.name);
      assert.match(resolve?.prompt ?? '', /^net\.mjs, as the slice left it:\n\n```\ntwo\n```$/m);
    }
    if ('stop' in row) {
      const stopped = read.turns.find((turn) => turn.slice === 1);
      assert.equal(stopped?.state, 'stopped', row.name);
      assert.ok(lines.includes('Slice 2 finished: 1 file merged.'), row.name);
    }
    if ('linked' in row) {
      const asked = local.requests.at(-1);
      assert.equal(asked?.role, 'ask', row.name);
      assert.ok(asked?.scratch.directory.endsWith(join('slices', '1', 'copy')), row.name);
      assert.match(
        asked?.prompt ?? '',
        /^Files changed in the scratch copy against the base commit:\nNo files changed yet\.$/m,
        row.name,
      );
      assert.ok(lines.includes('Slice 1 finished. No files changed.'), row.name);
    }
    if ('unplugged' in row) {
      assert.equal(read.turns.find((turn) => turn.slice === 1)?.state, 'stopped', row.name);
      assert.equal(openai.requests.length, 1, row.name);
      assert.ok(!existsSync(join(scratch, 'a.txt')), row.name);
    }
  }
});

// A new thread's first message goes to the orchestrator. The thread then holds the crew builder
// as its pick, so the composer offers the builder for the next message (H2).
test('the first message to an orchestrator leaves the crew builder as the thread pick', {
  timeout: 30000,
}, async (t) => {
  const builder: ChatModelSelection = { family: 'openai', model: 'openai-model', effort: 'high' };
  const orchestrator: ChatModelSelection = {
    family: 'anthropic',
    model: 'anthropic-model',
    effort: 'medium',
  };
  const thread = standalone(t, {
    adapters: new Map([
      [
        'anthropic',
        createScriptedChatAdapter({
          family: 'anthropic',
          turns: [[{ kind: 'text', itemId: 'r', chunks: ['No plan needed.'] }]],
        }),
      ],
    ]),
  });
  const { store, service, taskId } = thread;
  const crew: ChatCrew = {
    name: 'Plan crew',
    members: [
      { role: 'builder', selection: builder },
      { role: 'orchestrator', selection: orchestrator },
    ],
  };
  store.transaction(() => service.configure({ taskId, crew, flightMode: 'glide' }));
  assert.equal(thread.read().thread.selection, null);
  const idle = settles(thread);
  thread.send('What does this do?', builder);
  await idle;
  const read = thread.read();
  assert.deepEqual(read.turns[0] && [read.turns[0].role, read.turns[0].selection.family], [
    'orchestrator',
    'anthropic',
  ]);
  assert.deepEqual(read.thread.selection, builder);
  await service.close();
});

// Startup recovery stops a plan whose slice was mid-review with one plain line.
test('a restart during a plan shows the plan stopped with a line', {
  timeout: 30000,
}, async (t) => {
  const pick = (family: ChatFamily): ChatModelSelection => ({
    family,
    model: `${family}-model`,
    effort: 'default',
  });
  const plan = {
    planId: 'p1',
    goal: 'One part.',
    slices: [
      {
        id: 1,
        title: 'Part 1',
        brief: 'Do it.',
        files: [],
        depends: [],
        difficulty: 'medium',
        readOnly: false,
      },
    ],
  };
  const now = createTestClock().now();
  const families = [familyEntry('openai', 10, null, now), familyEntry('anthropic', 50, null, now)];
  const { store, service, taskId, start, send, read } = standalone(t, {
    adapters: new Map([
      [
        'openai',
        createScriptedChatAdapter({
          family: 'openai',
          turns: [
            [
              {
                kind: 'text',
                itemId: 'r',
                chunks: [`\`\`\`json plan\n${JSON.stringify(plan)}\n\`\`\``],
              },
            ],
            [{ kind: 'text', itemId: 'r', chunks: ['Built.'] }],
          ],
        }),
      ],
      [
        'anthropic',
        createScriptedChatAdapter({ family: 'anthropic', turns: [[{ kind: 'wait' }]] }),
      ],
    ]),
    catalog: () => ({ families }),
  });
  const crew: ChatCrew = {
    name: 'Plan crew',
    members: [
      { role: 'builder', selection: pick('openai') },
      { role: 'reviewer', selection: pick('anthropic') },
      { role: 'orchestrator', selection: pick('openai') },
    ],
  };
  store.transaction(() => service.configure({ taskId, crew, flightMode: 'glide' }));
  const reviewing = next(
    { store },
    (event) =>
      event.type === 'chat.turn' &&
      (event.payload as ChatTurn).role === 'reviewer' &&
      (event.payload as ChatTurn).state === 'running',
  );
  send('Do the part.', pick('openai'));
  await reviewing;
  t.after(() => service.close());

  const restarted = start();
  restarted.recover();
  const after = read(restarted);
  assert.equal(after.messages.at(-1)?.text, 'Plan stopped: restarted.');
  assert.deepEqual(
    after.thread.plan && [
      after.thread.plan.phase,
      ...after.thread.plan.slices.map((s) => s.status),
    ],
    ['stopped', 'not-run'],
  );
  assert.equal(after.turns.at(-1)?.state, 'failed');
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

// The person changes the flight mode or the policy while a turn waits on an ask. Each row sends
// the changes one at a time, as the composer does. The open ask is answered when the new policy
// covers it, and the adapter hears the narrower policy for the asks still to come.
test('a flight mode or policy change answers the open ask the new setting covers', {
  timeout: 30000,
}, async (t) => {
  const crew: ChatCrew = {
    name: 'Pair',
    members: [
      { role: 'builder', selection },
      { role: 'reviewer', selection },
    ],
  };
  type Setting = {
    flightMode?: 'manual' | 'balanced' | 'glide';
    permissionPolicy?: 'ask' | 'allow-edits' | 'allow-all';
  };
  const cases: {
    name: string;
    start: Setting;
    change: Setting[];
    answered: boolean;
    narrowed: string[];
  }[] = [
    {
      name: 'manual to glide',
      start: { flightMode: 'manual', permissionPolicy: 'ask' },
      change: [{ flightMode: 'glide' }, { permissionPolicy: 'allow-all' }],
      answered: true,
      narrowed: [],
    },
    {
      name: 'glide to manual',
      start: { flightMode: 'glide', permissionPolicy: 'allow-edits' },
      change: [{ flightMode: 'manual' }, { permissionPolicy: 'ask' }],
      answered: false,
      narrowed: ['ask'],
    },
    {
      name: 'balanced to glide',
      start: { flightMode: 'balanced', permissionPolicy: 'allow-all' },
      change: [{ flightMode: 'glide' }],
      answered: true,
      narrowed: [],
    },
  ];
  for (const row of cases) {
    const inner = editingAdapter(['command'], { command: 'npm i' });
    const narrowed: string[] = [];
    const adapter: ChatAdapter = {
      family: 'openai',
      startTurn: (request, emit) => ({
        ...inner.startTurn(request, emit),
        setPermissionPolicy: (policy) => narrowed.push(policy),
      }),
    };
    const thread = standalone(t, { adapters: new Map([['openai', adapter]]) });
    const { store, service, taskId } = thread;
    store.transaction(() => service.configure({ taskId, crew, ...row.start }));
    const parked = turnReaches(thread, 'waiting-permission');
    const idle = settles(thread);
    thread.send('Go.');
    const turn = await parked;
    for (const change of row.change) {
      const effects: (() => void)[] = [];
      store.transaction(() => service.configure({ taskId, ...change }, effects));
      for (const effect of effects) effect();
    }
    await new Promise((resolve) => setImmediate(resolve));
    const open = thread.read().turns[0].state === 'waiting-permission';
    assert.equal(open, !row.answered, row.name);
    assert.deepEqual(narrowed, row.narrowed, row.name);
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
    const resolved = agentEvents(thread).find((event) => event.type === 'permission.resolved');
    assert.equal(
      resolved?.type === 'permission.resolved' && resolved.choice,
      row.answered ? 'allow-once' : 'deny',
      row.name,
    );
    // Stop whatever the crew chain started after the builder.
    await service.close();
  }
});

// Balanced and Glide answer a read-only command inside the scratch copy under any policy, in the
// shape each family sends it. Manual leaves it to the policy.
test('balanced and glide run read-only commands without asking under the ask policy', {
  timeout: 30000,
}, async (t) => {
  const crew: ChatCrew = { name: 'Solo', members: [{ role: 'builder', selection }] };
  const cases = [
    {
      mode: 'glide',
      input: { CommandLine: 'grep -rn "createUser(" src', Cwd: '.' },
      answered: true,
    },
    { mode: 'glide', input: { command: "sed -n '1,40p' src/app.ts" }, answered: true },
    { mode: 'glide', input: { command: "/bin/zsh -lc 'ls -la src'" }, answered: true },
    { mode: 'glide', input: { command: 'git log --oneline -5' }, answered: true },
    { mode: 'balanced', input: { command: "rg -n 'a b' ." }, answered: true },
    { mode: 'glide', input: { command: "sed -i 's/a/b/' src/app.ts" }, answered: false },
    { mode: 'glide', input: { command: "sed -n '1p;w out' src/app.ts" }, answered: false },
    { mode: 'glide', input: { command: 'grep -rn x src | sh' }, answered: false },
    { mode: 'glide', input: { command: 'cat "$HOME/.ssh/id"' }, answered: false },
    { mode: 'glide', input: { command: "bash -c 'ls' && rm x" }, answered: false },
    { mode: 'glide', input: { command: 'npm i' }, answered: false },
    { mode: 'glide', input: { CommandLine: 'ls', Cwd: '/etc' }, answered: false },
    // A read-only command on a file outside the copy follows the policy (H11).
    {
      mode: 'glide',
      input: { command: "rg -n 'x' /Users/raykraft/.agent/memories/MEMORY.md" },
      answered: false,
    },
    {
      mode: 'glide',
      input: {
        command: '/bin/zsh -lc "sed -n \'46,51p\' /Users/raykraft/.agent/memories/MEMORY.md"',
      },
      answered: false,
    },
    { mode: 'manual', input: { command: 'ls' }, answered: false },
  ] as const;
  for (const row of cases) {
    const adapter = editingAdapter(['command'], row.input);
    const thread = standalone(t, { adapters: new Map([['openai', adapter]]) });
    const { store, service, taskId } = thread;
    store.transaction(() =>
      service.configure({
        taskId,
        permissionPolicy: 'ask',
        ...(row.mode === 'manual' ? {} : { crew, flightMode: row.mode }),
      }),
    );
    const name = `${row.mode} ${JSON.stringify(row.input)}`;
    const parked = turnReaches(thread, 'waiting-permission');
    const idle = settles(thread);
    thread.send('Go.');
    const turn = await parked;
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
    await service.close();
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

  // A kept Anthropic session gets the writing rules and a large design brief in front of Send
  // now's full packet. The block's bytes come off the packet's cap, so the whole prompt stays
  // inside it however long the thread is.
  const reply = (n: number) => [
    { kind: 'text' as const, itemId: 'r', chunks: [`${n} ${'w'.repeat(8000)}`] },
  ];
  const anthropic = createScriptedChatAdapter({
    family: 'anthropic',
    turns: [
      ...Array.from({ length: 6 }, (_, n) => reply(n)),
      [{ kind: 'text', itemId: 'reply', chunks: ['Half'], complete: false }, { kind: 'wait' }],
      [{ kind: 'text', itemId: 'reply', chunks: ['Done.'] }],
    ],
  });
  const kept = standalone(t, {
    adapters: new Map([['anthropic', anthropic]]),
    writingRules: () => [],
  });
  const tokens = Object.fromEntries(
    Array.from({ length: 200 }, (_, n) => [
      `shade${n}`,
      {
        $type: 'color' as const,
        $value: '#2f6feb',
        $description: `Shade ${n}. ${'For one state of one control, and only that one. '.repeat(3)}`,
      },
    ]),
  );
  const system: DesignSystem = {
    schema: 1,
    tokens: { color: tokens, type: {}, spacing: {}, radius: {}, shadow: {}, motion: {} },
    components: [],
    rules: [],
  };
  const saved = kept.store.transaction(() =>
    new DesignSystems({
      store: kept.store,
      now: kept.clock.now,
      projectPath: () => kept.root,
    }).save({
      projectId: (kept.store.get<Task>('task', kept.taskId) as Task).projectId,
      path: 'design-system.json',
      body: system,
      expectedVersion: 0,
      confirm: 'explicit',
    }),
  );
  assert.ok('record' in saved);
  const on = { family: 'anthropic', model: 'anthropic-model', effort: 'default' } as const;
  for (let n = 0; n < 6; n++) {
    const done = settles(kept);
    kept.send(`Turn ${n}.`, on);
    await done;
  }
  // A large change in the copy fills the packet's patch share.
  writeFileSync(
    join(chatScratchDirectory(dirname(kept.root), kept.taskId), 'big.txt'),
    Array.from({ length: 2000 }, (_, n) => `line ${n} of a long generated file`).join('\n'),
  );
  const half = next(
    kept,
    (event) => event.type === 'agent.event' && event.payload.type === 'text.delta',
  );
  kept.send('Stop here.', on);
  await half;
  kept.send('Then this.', on);
  const [queued] = kept.read().thread.queued;
  const finished = settles(kept);
  const nowEffects: (() => void)[] = [];
  assert.equal(
    kept.store.transaction(() =>
      kept.service.steer({ taskId: kept.taskId, messageId: queued.id }, nowEffects),
    ).outcome,
    'applied',
  );
  for (const effect of nowEffects) effect();
  await finished;
  const sent = anthropic.requests.at(-1);
  assert.notEqual(sent?.session, null);
  assert.ok(sent?.prompt.includes(designBrief(system)));
  assert.ok(sent?.prompt.includes('line 0 of a long generated file'));
  assert.ok(Buffer.byteLength(sent?.prompt ?? '') <= 96 * 1024);
});

/** Run one service command in its own transaction, then its effects, as the controller does. */
function act(store: Store, work: (effects: (() => void)[]) => CommandResult): CommandResult {
  const effects: (() => void)[] = [];
  const result = store.transaction(() => work(effects));
  for (const effect of effects) effect();
  return result;
}

/** The turn's state once a chat.turn event names it in that state. */
function turnState(
  controller: Pick<Controller, 'store'>,
  turnId: string,
  state: ChatTurn['state'],
) {
  return next(
    controller,
    (event) =>
      event.type === 'chat.turn' &&
      (event.payload as ChatTurn).id === turnId &&
      (event.payload as ChatTurn).state === state,
  );
}

/** The first agent event of a turn in this role, once the adapter has the turn. */
function launched(controller: Pick<Controller, 'store'>, role: ChatTurn['role']) {
  return next(
    controller,
    (event) =>
      event.type === 'agent.event' &&
      event.payload.type === 'turn.started' &&
      event.payload.role === role,
  ).then((event) => (event.payload as AgentEvent).turnId);
}

test('a side question runs beside a builder that waits on an approval and leaves it the thread turn', {
  timeout: 30000,
}, async (t) => {
  const scripted = createScriptedChatAdapter({
    family: 'openai',
    turns: [
      [
        { kind: 'permission', requestId: 'p1', question: 'Run the tests?', toolKind: 'command' },
        { kind: 'text', itemId: 'r', chunks: ['Built.'] },
      ],
      [{ kind: 'wait' }],
    ],
  });
  const thread = standalone(t, { adapters: new Map([['openai', scripted]]) });
  const { store, service, taskId } = thread;
  const ask = (question: string) =>
    act(store, (effects) =>
      service.ask({ taskId, family: 'openai', model: selection.model, question }, effects),
    );
  const parked = turnReaches(thread, 'waiting-permission');
  thread.send('Fix the rounding.');
  const builder = await parked;
  // The question goes to the family that waits on the approval, in this thread, and starts now.
  const asking = launched(thread, 'ask');
  assert.equal(ask('Which file rounds?').outcome, 'applied');
  const side = await asking;
  const during = thread.read();
  assert.deepEqual(
    [during.thread.activeTurnId, during.thread.queued, during.turns.map((turn) => turn.state)],
    [builder.id, [], ['waiting-permission', 'running']],
  );
  assert.deepEqual(
    scripted.requests.map((request) => request.role),
    ['assistant', 'ask'],
  );
  // One side question at a time per thread.
  assert.equal(ask('And the totals?').reason, 'ask-running');
  // The approval is still the builder's to answer, and the builder ends while the question runs.
  const built = turnState(thread, builder.id, 'done');
  const answer = act(store, (effects) =>
    service.resolvePermission(
      { taskId, turnId: builder.id, requestId: 'p1', choice: 'allow-once' },
      effects,
    ),
  );
  assert.equal(answer.outcome, 'applied');
  await built;
  const after = thread.read();
  assert.equal(after.thread.activeTurnId, null);
  assert.equal(after.turns.find((turn) => turn.id === side)?.state, 'running');
  const stopped = turnState(thread, side, 'stopped');
  act(store, (effects) => service.stopTurn({ taskId, turnId: side }, effects));
  await stopped;
});

test('stop ends only the turn it names, the builder or the side question beside it', {
  timeout: 30000,
}, async (t) => {
  const scripted = createScriptedChatAdapter({ family: 'openai', turns: [[{ kind: 'wait' }]] });
  const thread = standalone(t, { adapters: new Map([['openai', scripted]]) });
  const { store, service, taskId } = thread;
  const ask = () => {
    const started = launched(thread, 'ask');
    const question = {
      taskId,
      family: 'openai' as const,
      model: selection.model,
      question: 'Why?',
    };
    assert.equal(act(store, (effects) => service.ask(question, effects)).outcome, 'applied');
    return started;
  };
  const stop = (turnId: string) => {
    const stopped = turnState(thread, turnId, 'stopped');
    assert.equal(
      act(store, (effects) => service.stopTurn({ taskId, turnId }, effects)).outcome,
      'applied',
    );
    return stopped;
  };
  const states = () => Object.fromEntries(thread.read().turns.map((turn) => [turn.id, turn.state]));
  // A free thread runs the question at once, and a message sent then starts beside it.
  const first = await ask();
  assert.equal(thread.read().thread.activeTurnId, null);
  const building = launched(thread, 'assistant');
  assert.equal(thread.send('Fix the rounding.').outcome, 'applied');
  const builder = await building;
  assert.deepEqual(thread.read().thread.queued, []);
  await stop(first);
  assert.equal(states()[builder], 'running');
  assert.equal(thread.read().thread.activeTurnId, builder);
  const second = await ask();
  await stop(builder);
  assert.equal(states()[second], 'running');
  assert.equal(thread.read().thread.activeTurnId, null);
  await stop(second);
});

test('every stop writes its cause into the thread', { timeout: 30000 }, async (t) => {
  const interrupted: ChatAdapter = {
    family: 'openai',
    startTurn: () => ({
      respondPermission() {},
      stop() {},
      groups: [],
      result: Promise.resolve({
        stopReason: 'stopped',
        failure: chatFailure({
          stage: 'stream',
          kind: 'stopped',
          message: 'The client interrupted the turn (too many denials).',
        }),
        assistantText: '',
        session: null,
        usage: null,
        changedPaths: [],
      }),
    }),
  };
  const waits = () =>
    createScriptedChatAdapter({
      family: 'openai',
      turns: [[{ kind: 'wait' }], [{ kind: 'text', itemId: 'r', chunks: ['Next.'] }]],
    });
  const rows = [
    {
      name: 'the client stopped it',
      adapter: interrupted,
      end: async () => {},
      cause: 'client',
      line: 'Stopped: The client interrupted the turn (too many denials).',
    },
    {
      name: 'send now',
      adapter: waits(),
      // The next message runs to its end before the thread is read.
      end: async (thread: ReturnType<typeof standalone>) => {
        thread.send('Then the totals.');
        const queued = thread.read().thread.queued[0];
        const answered = turnReaches(thread, 'done');
        act(thread.store, (effects) =>
          thread.service.steer({ taskId: thread.taskId, messageId: queued.id }, effects),
        );
        await answered;
      },
      cause: 'send-now',
      line: 'Stopped: Send now started the next message.',
    },
    {
      name: 'a restart',
      adapter: waits(),
      end: async (thread: ReturnType<typeof standalone>) => {
        await thread.service.close();
      },
      cause: 'restart',
      line: 'Stopped: CrewKite restarted.',
    },
  ];
  for (const row of rows) {
    const thread = standalone(t, { adapters: new Map([['openai', row.adapter]]) });
    const stopped = turnReaches(thread, 'stopped');
    const running = launched(thread, 'assistant');
    thread.send('Fix the rounding.');
    await running;
    await row.end(thread);
    const turn = await stopped;
    const lines = thread
      .read()
      .messages.flatMap((message) =>
        message.author.kind === 'system' && message.author.turnId === turn.id ? [message.text] : [],
      );
    assert.deepEqual([turn.stopCause, lines], [row.cause, [row.line]], row.name);
  }
});

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
  const scripted = createScriptedChatAdapter({
    family: 'openai',
    turns: [[{ kind: 'wait' }], [{ kind: 'wait' }]],
  });
  // The project has a package to copy, so a delete can meet a preparation of the thread's copy.
  const late: { preparer?: DependencyPreparer } = {};
  const preparer = () => late.preparer as DependencyPreparer;
  // The process table the services read. A group is present only while the test says so.
  const present = new Set<number>();
  const { store, service, taskId, start, send, root, clock } = standalone(t, {
    adapters: new Map([['openai', scripted]]),
    groupAbsent: (value) => !present.has(value),
    dependencies: {
      prepare: (...input) => preparer().prepare(...input),
      environment: (...input) => preparer().environment(...input),
      preparing: (taskId) => preparer().preparing(taskId),
    },
  });
  installTiny(root);
  late.preparer = new DependencyPreparer({
    store,
    home: dirname(root),
    now: clock.now,
    id: () => `prp_${'0'.repeat(25)}1`,
    projectPath: () => root,
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
  // A side question runs beside the thread's own turn and sets none, so a delete waits for it too
  // and removes nothing. Once it ends, the delete at the end of this test goes through.
  const asking = turnReaches({ store }, 'running');
  const asked = next(
    { store },
    (event) => event.type === 'agent.event' && event.payload.type === 'turn.started',
  );
  act(store, (effects) =>
    service.ask(
      { taskId, family: 'openai', model: selection.model, question: 'What does this do?' },
      effects,
    ),
  );
  const question = await asking;
  await asked;
  const beside = remove();
  assert.deepEqual(
    [beside.reason, beside.next],
    [
      'turn-running',
      'A turn of this thread is still running. Stop it or wait for it, then delete the thread.',
    ],
  );
  assert.ok(store.get<Task>('task', taskId));
  const rows = store.db.prepare('SELECT count(*) AS n FROM chat_turns WHERE task_id=?');
  assert.equal(rows.get(taskId)?.n, 2);
  const answered = turnReaches({ store }, 'stopped');
  act(store, (effects) => service.stopTurn({ taskId, turnId: question.id }, effects));
  await answered;

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

  // A record in each table a thread holds alone. An Accept still checking and a push whose result
  // is unknown keep the thread. Once they settle, every record goes with it.
  const stamp = '2026-11-18T09:00:00.000Z';
  const recordId = (prefix: string) => `${prefix}_01JB7Q0V2N8W3X4Y5Z6A7B8C9D`;
  const connectionId = recordId('con');
  const checking: AcceptanceAttempt = {
    id: recordId('acc'),
    taskId,
    state: 'checking',
    baseCommit: 'e'.repeat(40),
    candidateTree: 'a'.repeat(40),
    commandsDigest: 'b'.repeat(64),
    choicesDigest: 'f'.repeat(64),
    preparationId: recordId('prp'),
    requiredChecks: [],
    mutatedPaths: [],
    mutatedCount: 0,
    refusal: null,
    branch: 'feat/sales-chart',
    commit: null,
  };
  const unknownPush: RemoteEffect = {
    id: recordId('rfx'),
    taskId,
    kind: 'push',
    state: 'unknown',
    target: {
      repo: { host: 'github.com', owner: 'crew-kite', name: 'demo-shop' },
      branch: 'feat/sales-chart',
      pr: null,
      headSha: 'd'.repeat(40),
      baseRef: null,
    },
    request: { kind: 'push', remote: 'origin', commit: 'd'.repeat(40), expectedRemote: null },
    confirmation: { at: stamp, by: 'person' },
    observed: null,
    reason: null,
  };
  store.transaction(() => {
    store.putDependencyPreparation(
      {
        id: recordId('prp'),
        taskId,
        scope: 'thread',
        scopeKey: taskId,
        state: 'preparing',
        layout: 'none',
        inputs: {
          manifestDigests: {},
          lockfileDigest: null,
          workspaceDigest: null,
          runtime: 'node@24.22.0',
          packageManager: null,
          platform: 'darwin',
          arch: 'arm64',
        },
        treeDigest: null,
        bytes: null,
        limitBytes: 1024,
        reason: null,
        preparedAt: null,
      },
      stamp,
    );
    store.putAcceptanceAttempt(checking, stamp);
    store.putConnection(
      {
        connectionId,
        family: 'openai',
        backend: 'native-client',
        billingMode: 'api',
        profileId: 'openai-api',
        keepConnected: false,
        readiness: 'ready',
        proofGeneration: 1,
        observedMode: 'api',
        observedAt: stamp,
      },
      stamp,
    );
    store.putConnectionAssignment({ taskId, role: 'builder', connectionId }, stamp);
    store.putDesignFinding(
      {
        id: recordId('dsf'),
        taskId,
        file: 'src/chart.css',
        line: 3,
        rule: 'raw-color',
        found: '#3b82f6',
        nearestToken: 'color.accent',
        state: 'open',
        reason: null,
        versionHash: 'c'.repeat(64),
      },
      (store.get<Task>('task', taskId) as Task).projectId,
      stamp,
    );
    store.putRemoteEffect(unknownPush, stamp);
  });
  const held = remove();
  assert.deepEqual(
    [held.reason, held.next],
    [
      'work-in-flight',
      'Wait for the push, pull request or acceptance to settle, or reconcile it, then delete the thread.',
    ],
  );
  store.transaction(() =>
    store.putAcceptanceAttempt({ ...checking, state: 'refused', refusal: 'check-failed' }, stamp),
  );
  assert.equal(remove().reason, 'work-in-flight');
  store.transaction(() =>
    store.putRemoteEffect(
      {
        ...unknownPush,
        state: 'applied',
        observed: { at: stamp, result: 'applied', created: { sha: 'd'.repeat(40) } },
      },
      stamp,
    ),
  );
  // A copy being prepared writes into the thread's folder until it ends, so it keeps the thread too.
  const preparing = preparer().prepare(taskId, 'thread', taskId);
  assert.deepEqual(
    [remove().reason, remove().next],
    ['work-in-flight', 'Wait for the dependency preparation to finish, then delete the thread.'],
  );
  const prepared = await preparing;
  assert.equal(prepared && prepared !== 'busy' && prepared.state, 'prepared');

  // A thread that ran checks deletes with their records, and an unresolved check keeps it. The
  // settled check's row, launch identity, receipt and artifacts go with the thread, and so does a
  // command that was prepared and never started. A check left at intent refuses with the hold's
  // sentence until the person releases it.
  const identity: LaunchIdentity = {
    boot: { source: 'darwin-boot-session-v1', digest: '1'.repeat(64) },
    machine: null,
  };
  const output = {
    id: `art_${'9'.padStart(26, '0')}`,
    ...artifacts.publish(Buffer.from('ok 1')),
    mediaType: 'text/plain; charset=utf-8',
  };
  store.transaction(() => store.put('artifact', output.id, 0, output));
  const ran = settledCheck(store, clock.now, taskId, 1, { identity, stdout: output });
  const lost = journaledCheck(store, clock.now, taskId, 2);
  // A command prepared and never started has no process, and nothing ends it.
  const draft = {
    id: `art_${'3'.padStart(26, '0')}`,
    hash: 'a'.repeat(64),
    bytes: 0,
    mediaType: 'application/json',
  };
  store.transaction(() => {
    store.put('artifact', draft.id, 0, draft);
    new OperationStore(store, clock.now).create({
      id: `cmd_${'3'.padStart(26, '0')}`,
      taskId,
      kind: 'project-command',
      definition: draft,
    });
  });
  // Its run ended without proof that the process did, so the record reads unknown.
  new OperationStore(store, clock.now).finish(
    lost,
    { state: 'unknown', reason: 'operation-ownership-unknown', next: null },
    { outcome: 'blocked', reason: 'operation-ownership-unknown' },
  );
  const unresolved = remove();
  assert.deepEqual(
    [unresolved.reason, unresolved.next],
    [
      'ownership-unknown',
      'A check recorded no process identity, so CrewKite cannot confirm it ended. Other threads still work. Export diagnostics from Settings, under General, before taking further action.',
    ],
  );
  const released = act(store, (effects) =>
    service.releaseCheck({ taskId, confirm: 'explicit', note: 'Nothing was running.' }, effects),
  );
  assert.equal(released.outcome, 'applied');
  const keys = [ran, lost].map((id) => new OperationStore(store, clock.now).get(id)?.key as string);
  // A check this process still runs answers with the checks' own refusal until it ends.
  const owned = journaledCheck(store, clock.now, taskId, 4);
  liveOperations.add(owned);
  const busy = remove();
  assert.deepEqual(
    [busy.reason, busy.next],
    ['checks-running', 'Wait for the checks to finish or stop them, then try again.'],
  );
  liveOperations.delete(owned);
  const journal = new OperationStore(store, clock.now);
  journal.unlaunched(owned, 'command');
  journal.finish(
    owned,
    { state: 'failed', reason: 'operation-failed', next: null },
    { outcome: 'blocked', reason: 'operation-failed' },
  );
  // A check left a child in its group and ended unknown, so the thread is held while it runs.
  const child = 4242;
  present.add(child);
  const orphan = journaledCheck(store, clock.now, taskId, 5, child);
  journal.finish(
    orphan,
    { state: 'unknown', reason: 'operation-ownership-unknown', next: null },
    { outcome: 'blocked', reason: 'operation-ownership-unknown' },
  );
  store.db
    .prepare(
      "UPDATE chat_threads SET body=json_set(body,'$.ownershipUnknown',json('true')) WHERE task_id=?",
    )
    .run(taskId);
  assert.equal(remove().reason, 'ownership-unknown');
  // With no hold on the thread, the presence check the delete settles by still finds the child,
  // so the record stays and the delete refuses.
  store.db
    .prepare("UPDATE chat_threads SET body=json_remove(body,'$.ownershipUnknown') WHERE task_id=?")
    .run(taskId);
  assert.equal(remove().reason, 'ownership-unknown');
  // The child exits. The hold lifts, and the delete settles the record as recovery would.
  present.delete(child);
  // The settled check ran in a folder of its own, and another record names its output's bytes.
  const workFolder = join(dirname(root), 'operations', ran);
  mkdirSync(join(workFolder, 'environment'), { recursive: true });
  const elsewhere = { ...output, id: `art_${'98'.padStart(26, '0')}` };
  store.transaction(() => store.put('artifact', elsewhere.id, 0, elsewhere));

  // The controller stops after the delete commits and before its folder goes. Startup finishes it.
  const folder = dirname(scripted.requests[0].scratch.directory);
  const ref = `refs/crewkite/threads/${taskId}`;
  git(root, ['update-ref', ref, scripted.requests[0].scratch.base]);
  const afterCommit: (() => void)[] = [];
  assert.equal(
    store.transaction(() => service.deleteThread({ taskId }, afterCommit)).outcome,
    'applied',
  );
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
  for (const table of [
    'conversation_entries',
    'chat_turns',
    'chat_threads',
    'events',
    'dependency_preparations',
    'acceptance_attempts',
    'connection_assignments',
    'design_findings',
    'remote_effects',
  ])
    assert.equal(
      store.db.prepare(`SELECT count(*) AS rows FROM ${table} WHERE task_id=?`).get(taskId)?.rows,
      0,
      table,
    );
  assert.equal(
    store.db.prepare('SELECT count(*) AS rows FROM task_operations WHERE task_id=?').get(taskId)
      ?.rows,
    0,
  );
  assert.equal(
    store.db
      .prepare("SELECT count(*) AS rows FROM launch_identity WHERE owner_kind='operation'")
      .get()?.rows,
    0,
  );
  assert.deepEqual(
    keys.map((key) => store.receipt(key)),
    [undefined, undefined],
  );
  // The definitions are named like their operations.
  assert.deepEqual(
    [ran.replace('cmd_', 'art_'), lost.replace('cmd_', 'art_'), draft.id, output.id].map((id) =>
      store.get('artifact', id),
    ),
    [undefined, undefined, undefined, undefined],
  );
  // The step after commit removes the operation's folder and keeps a file another record names.
  for (const effect of afterCommit) effect();
  assert.equal(existsSync(workFolder), false);
  assert.equal(artifacts.read(output.hash).toString(), 'ok 1');
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
  // The turn that asks reads the thread without itself: thread_turns and thread_live leave it
  // out, and thread_turn on its id says so, through the broker too.
  const asking = thread.read().thread.activeTurnId as string;
  const own = thread.service.threadReads(thread.taskId, undefined, asking);
  assert.deepEqual(
    reads.turns({ limit: 50 }).turns.map((turn) => turn.id),
    [first.id, asking],
  );
  assert.deepEqual(
    own.turns({ limit: 50 }).turns.map((turn) => turn.id),
    [first.id],
  );
  assert.equal(own.live().state, 'none');
  assert.throws(() => own.turn({ id: asking }), AskingTurnError);
  assert.equal(own.turn({ id: first.id }).id, first.id);
  assert.deepEqual(await answer(own, 'thread_turn', { id: asking }), {
    error: 'That id is the turn asking, which has no reply yet. Read an earlier turn.',
  });
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
// until it is gone. A restart reads the open check as failed with the reason and stops the chain
// that waited on it.
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
  // The gate after the builder runs the check, and the thread takes no turn meanwhile.
  assert.equal(thread.send('One more thing.', pick('openai')).outcome, 'applied');
  assert.equal(thread.read().thread.queued.length, 1);
  assert.equal(thread.read().turns.length, 1);

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
  // The queued message runs after the chain stopped, and its own gate runs the check again.
  await second;
  const again = thread.read();
  assert.deepEqual(
    again.turns.map((turn) => turn.role),
    ['assistant', 'assistant'],
  );
  assert.equal(again.thread.queued.length, 0);

  // The controller stops with that check open. Its process is alive, so the journal cannot prove
  // it gone: the thread takes no turn, and the open run reads as unknown with the reason.
  present = true;
  const restarted = thread.start();
  restarted.recover();
  const held = thread.read(restarted);
  assert.equal(held.thread.ownershipUnknown, true);
  // The second builder's gate held its fresh chain, so the restart stops it with a line and no
  // review waits on a gate that will never end.
  assert.equal(held.thread.crewChain?.step, 'stopped');
  assert.equal(
    held.messages.filter((message) => message.text.startsWith('Crew stopped')).at(-1)?.text,
    'Crew stopped: CrewKite restarted.',
  );
  const [, orphan] = held.thread.checks?.runs ?? [];
  assert.equal(orphan.status, 'unknown');
  assert.match(orphan.reason ?? '', /^CrewKite restarted while this check ran\./);
  // A message waits in the queue while the hold stands.
  assert.equal(thread.send('Go on.', pick('openai'), restarted).outcome, 'applied');
  assert.equal(thread.read(restarted).thread.queued.length, 1);
  assert.equal(thread.read(restarted).turns.length, 2);
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
    last.turns.slice(2).map((turn) => turn.state),
    ['done', 'done'],
  );
  // The check of the first service is still running; closing it ends the process.
  service.close();
});

// Claim: a check is plain words the controller resolves itself. Balanced asks before every run,
// naming the exact commands, and a no skips the checks. Glide runs them when its policy covers
// commands and asks again when the script changed. The same checks run on a merged copy, and
// Manual runs none there and asks nothing.
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
  writeFileSync(join(chatScratchDirectory(dirname(thread.root), taskId), 'gate.mjs'), gate);
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
  // Manual runs nothing on its own, whatever the policy.
  configure({ permissionPolicy: 'allow-all' });
  const first = merged('first', false);
  assert.deepEqual(await service.runCombinedChecks(taskId, first), {
    outcome: 'held',
    cause: 'the thread is in manual mode',
    runs: [],
    brief: null,
  });
  assert.equal(thread.read().thread.checks?.ask, null);
  // Balanced asks, whatever the policy. The question names the exact command.
  configure({
    crew: { name: 'Solo', members: [{ role: 'builder', selection }] },
    flightMode: 'balanced',
  });
  const refused = service.runCombinedChecks(taskId, first);
  const ask = answer('deny');
  assert.deepEqual(ask.commands, [{ label: 'node gate.mjs', resolved: 'node gate.mjs' }]);
  assert.deepEqual(ask.changed, []);
  assert.equal((await refused).outcome, 'denied');
  assert.equal(thread.read().thread.checks?.runs.length, 0);
  assert.equal(thread.read().thread.checks?.ask, null);

  // Glide with Allow all runs without a question.
  configure({ flightMode: 'glide' });
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

/** A thread with a scratch copy, in Glide with Allow all, so a check runs without a question. */
async function checkCopy(
  t: TestContext,
  setup: {
    /** The scripted replies, the first one to "Build it.". */
    turns?: ChatScriptStep[][];
    deps?: Partial<ChatServiceDeps>;
    /** Runs on the new thread before its first turn copies the project. */
    before?: (thread: ReturnType<typeof standalone>) => void;
  } = {},
) {
  const thread = standalone(t, {
    adapters: new Map([
      [
        'openai',
        createScriptedChatAdapter({
          family: 'openai',
          turns: setup.turns ?? [textReply('Built.')],
        }),
      ],
    ]),
    ...setup.deps,
  });
  setup.before?.(thread);
  const done = turnReaches(thread, 'done');
  thread.send('Build it.');
  const built = await done;
  const configure = (patch: object) =>
    thread.store.transaction(() => thread.service.configure({ taskId: thread.taskId, ...patch }));
  configure({
    crew: { name: 'Solo', members: [{ role: 'builder', selection }] },
    flightMode: 'glide',
    permissionPolicy: 'allow-all',
  });
  const scratch = realpathSync(chatScratchDirectory(dirname(thread.root), thread.taskId));
  return { ...thread, built, configure, scratch };
}

// Claim: a check whose process CrewKite cannot confirm ended reads as unknown, never as a pass,
// and the thread takes no turn meanwhile. No later check starts in the copy that process may
// still write.
test('a check that leaves a process behind reads as unknown and holds the thread', {
  timeout: 30000,
}, async (t) => {
  const { service, taskId, scratch, configure, read } = await checkCopy(t);
  // The check exits and leaves a process in its group, so it did not end on its own.
  writeFileSync(
    join(scratch, 'linger.mjs'),
    "import { spawn } from 'node:child_process';\nspawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' }).unref();\n",
  );
  configure({ checks: { add: 'node linger.mjs' } });
  configure({ checks: { add: 'node --version' } });
  assert.equal((await service.runCombinedChecks(taskId, scratch)).outcome, 'failed');
  const after = read();
  assert.deepEqual(
    after.thread.checks?.runs.map((run) => [run.label, run.status, run.reason, run.exitCode]),
    [
      [
        'node linger.mjs',
        'unknown',
        'CrewKite could not confirm the process exited. It checks again before the next turn.',
        0,
      ],
      [
        'node --version',
        'failed',
        'A check before this one may still be running in the copy, so this one did not start.',
        null,
      ],
    ],
  );
  assert.equal(after.thread.ownershipUnknown, true);
});

// Claim: an allow covers the commands the question showed. A script that changed before the
// answer runs nothing, and a fresh question shows what would run now.
test('a check script changed between the question and the answer does not run', {
  timeout: 30000,
}, async (t) => {
  const { store, service, taskId, scratch, configure, read, built } = await checkCopy(t);
  writeFileSync(join(scratch, 'gate.mjs'), 'process.exit(0);\n');
  configure({ flightMode: 'balanced', checks: { add: 'node gate.mjs' } });
  const answer = (requestId: string, choice: 'allow' | 'deny') =>
    act(store, (effects) =>
      service.resolvePermission({ taskId, turnId: built.id, requestId, choice }, effects),
    ).outcome;
  const pending = service.runCombinedChecks(taskId, scratch);
  const first = read().thread.checks?.ask;
  assert.deepEqual(first?.changed, []);
  writeFileSync(join(scratch, 'gate.mjs'), 'process.exit(1);\n');
  assert.equal(answer(first?.requestId ?? '', 'allow'), 'applied');
  const fresh = read().thread.checks?.ask;
  assert.notEqual(fresh?.requestId, first?.requestId);
  assert.deepEqual(fresh?.changed, ['node gate.mjs']);
  assert.equal(read().thread.checks?.runs.length, 0);
  assert.equal(answer(fresh?.requestId ?? '', 'deny'), 'applied');
  assert.equal((await pending).outcome, 'denied');
  assert.equal(read().thread.checks?.runs.length, 0);
});

// Claim: nothing publishes or changes the copy while a check runs in it, its dependencies included.
test('accept, discard, the hunk commands and a dependency preparation refuse while a check runs in the copy', {
  timeout: 30000,
}, async (t) => {
  const { store, service, taskId, scratch, configure } = await checkCopy(t);
  writeFileSync(join(scratch, 'block.mjs'), 'setInterval(() => {}, 60_000);\n');
  configure({ checks: { add: 'node block.mjs' } });
  const running = service.runCombinedChecks(taskId, scratch);
  const hunk = 'a'.repeat(64);
  const identity = { name: 'Fixture owner', email: 'owner@example.invalid' };
  const attempts: [string, () => CommandResult][] = [
    ['accept', () => service.accept({ taskId, branch: 'crewkite/checked' }, identity)],
    [
      'accept a hunk',
      () => service.decideHunk({ taskId, path: 'block.mjs', hunk, decision: 'accepted' }),
    ],
    ['discard a hunk', () => service.discardHunk({ taskId, path: 'block.mjs', hunk })],
    ['discard', () => service.discardChange({ taskId, path: 'block.mjs' })],
    [
      'prepare the dependencies',
      () => service.preparationRefusal(taskId) ?? { outcome: 'applied' },
    ],
  ];
  for (const [name, attempt] of attempts) {
    const result = store.transaction(attempt);
    assert.deepEqual(
      [result.outcome, result.reason, result.next],
      ['blocked', 'checks-running', 'Wait for the checks to finish or stop them, then try again.'],
      name,
    );
  }
  assert.equal(service.stopCombinedChecks(taskId), true);
  assert.equal((await running).outcome, 'stopped');
});

// Claim: a check that changes the files Accept would publish cannot pass, whatever it exits
// with. The run names the files, and they stay for the person to review.
test('a check that writes into the copy fails, names the files and leaves them', {
  timeout: 30000,
}, async (t) => {
  const { service, taskId, scratch, configure, read } = await checkCopy(t);
  writeFileSync(
    join(scratch, 'format.mjs'),
    [
      "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
      "mkdirSync('out');",
      "writeFileSync('out/report.txt', 'ok\\n');",
      "appendFileSync('net.mjs', '// formatted\\n');",
    ].join('\n'),
  );
  configure({ checks: { add: 'node format.mjs' } });
  assert.equal((await service.runCombinedChecks(taskId, scratch)).outcome, 'failed');
  const run = read().thread.checks?.runs.at(-1);
  assert.deepEqual(
    [run?.status, run?.exitCode, run?.reason, run?.changedPaths, run?.changedCount],
    [
      'failed',
      0,
      'This check changed files in the copy. Review the changes before running it again.',
      ['net.mjs', 'out/report.txt'],
      2,
    ],
  );
  assert.equal(readFileSync(join(scratch, 'out/report.txt'), 'utf8'), 'ok\n');
  assert.match(readFileSync(join(scratch, 'net.mjs'), 'utf8'), /\/\/ formatted\n$/);
});

/** Only git and node on PATH, so nothing a test runs can find gh or a provider client. */
function lockPath(t: TestContext) {
  const tools = mkdtempSync(join(tmpdir(), 'ck-locked-path-'));
  const saved = process.env.PATH;
  process.env.PATH = installedTools(tools, 'git', 'node');
  t.after(() => {
    process.env.PATH = saved;
    rmSync(tools, { recursive: true, force: true });
  });
}

/**
 * A check command the journal opened, the way a controller leaves it when it stops between the
 * intent and the spawn, or with `group` once the spawn recorded one. Returns the operation's id.
 */
function journaledCheck(
  store: Store,
  now: () => string,
  taskId: string,
  n: number,
  group?: number,
): string {
  const id = (prefix: string, value: number) => `${prefix}_${String(value).padStart(26, '0')}`;
  const definition = {
    id: id('art', n),
    hash: 'a'.repeat(64),
    bytes: 0,
    mediaType: 'application/json',
  };
  const journal = new OperationStore(store, now);
  journal.createAndBegin(
    { id: id('cmd', n), taskId, kind: 'project-command', definition },
    id('cmd', n + 100),
    'b'.repeat(64),
    () => {},
    () => store.put('artifact', definition.id, 0, definition),
  );
  journal.phase(id('cmd', n), 'command', 'intent', null);
  if (group !== undefined) journal.phase(id('cmd', n), 'command', 'owned', group);
  return id('cmd', n);
}

/**
 * A check command that ran and ended: intent, its group, the group closed and a pass. `stdout`
 * names an output artifact the caller stored. Returns the operation's id.
 */
function settledCheck(
  store: Store,
  now: () => string,
  taskId: string,
  n: number,
  options: { identity?: LaunchIdentity; stdout?: Artifact } = {},
): string {
  const id = (prefix: string, value: number) => `${prefix}_${String(value).padStart(26, '0')}`;
  const definition = {
    id: id('art', n),
    hash: 'a'.repeat(64),
    bytes: 0,
    mediaType: 'application/json',
  };
  const journal = new OperationStore(store, now, undefined, options.identity);
  journal.createAndBegin(
    { id: id('cmd', n), taskId, kind: 'project-command', definition },
    id('cmd', n + 100),
    'b'.repeat(64),
    () => {},
    () => store.put('artifact', definition.id, 0, definition),
  );
  journal.phase(id('cmd', n), 'command', 'intent', null);
  journal.phase(id('cmd', n), 'command', 'owned', 4000 + n);
  journal.phase(id('cmd', n), 'command', 'closed', 4000 + n);
  journal.finish(
    id('cmd', n),
    { state: 'succeeded', reason: 'exit-zero', next: null, stdout: options.stdout ?? null },
    { outcome: 'applied' },
  );
  return id('cmd', n);
}

const RELEASED_LINE =
  "You released this thread. CrewKite never confirmed the check's process ended.";

// Claim: a check journaled at intent never recorded its process group, so nothing can prove its
// process gone. A restart holds the thread, and only the person's release lets it go. The record
// fails with their note, the run says they released it, the thread gets one line, the message
// that waited starts and the thread can be deleted. Nothing reads a process table for it.
test('a check that crashed before its process was recorded holds the thread until a person releases it', {
  timeout: 30000,
}, async (t) => {
  lockPath(t);
  const thread = await checkCopy(t, {
    turns: [textReply('Built.'), textReply('Went on.')],
    deps: { groupAbsent: () => assert.fail('No process table is read for this release.') },
  });
  const { store, taskId, clock, configure } = thread;
  configure({ checks: { add: 'node --version' } });
  const operation = journaledCheck(store, clock.now, taskId, 1);
  // The old controller had saved the run as running before it stopped.
  const saved = thread.read().thread;
  const run: ChatCheckRun = {
    id: `chk_${'1'.repeat(32)}`,
    checkId: 'custom:1',
    label: 'node --version',
    command: 'node --version',
    trigger: 'manual',
    status: 'running',
    reason: null,
    startedAt: clock.now(),
    durationMs: null,
    exitCode: null,
    tail: '',
    stdout: null,
    stderr: null,
  };
  store.db
    .prepare('UPDATE chat_threads SET body=? WHERE task_id=?')
    .run(JSON.stringify({ ...saved, checks: { ...saved.checks, runs: [run] } }), taskId);
  const restarted = thread.start();
  restarted.recover();
  assert.equal(thread.read(restarted).thread.ownershipUnknown, true);
  assert.equal(thread.read(restarted).thread.checks?.runs[0].status, 'unknown');
  assert.equal(thread.send('Go on.', selection, restarted).outcome, 'applied');
  assert.equal(thread.read(restarted).thread.queued.length, 1);
  const identity = { name: 'Fixture owner', email: 'owner@example.invalid' };
  const accept = store.transaction(() =>
    restarted.accept({ taskId, branch: 'crewkite/held' }, identity),
  );
  assert.deepEqual([accept.outcome, accept.reason], ['blocked', 'ownership-unknown']);
  const remove = () => act(store, (effects) => restarted.deleteThread({ taskId }, effects));
  const held = remove();
  assert.deepEqual([held.outcome, held.reason], ['blocked', 'ownership-unknown']);

  const started = turnReaches(thread, 'done');
  const note = 'No test or build process was left in Activity Monitor.';
  const released = act(store, (effects) =>
    restarted.releaseCheck({ taskId, confirm: 'explicit', note }, effects),
  );
  assert.deepEqual(released, {
    outcome: 'applied',
    data: { kind: 'chat-check-released', taskId, released: 1, held: false },
  });
  const record = new OperationStore(store, clock.now).get(operation);
  assert.deepEqual(
    [record?.state, record?.reason, record?.phases],
    ['failed', `operation-released-by-person: ${note}`, []],
  );
  assert.equal(store.receipt(record?.key ?? '')?.result.reason, 'operation-released-by-person');
  const after = thread.read(restarted);
  assert.deepEqual(
    [after.thread.checks?.runs[0].status, after.thread.checks?.runs[0].reason],
    ['failed', "Released by you. CrewKite never confirmed this check's process ended."],
  );
  assert.equal(after.thread.ownershipUnknown, undefined);
  assert.deepEqual(after.messages.filter((message) => message.text === RELEASED_LINE).length, 1);
  assert.equal((await started).state, 'done');
  assert.equal(thread.read(restarted).turns.length, 2);
  // The hold no longer refuses the delete.
  assert.notEqual(remove().reason, 'ownership-unknown');
});

// Claim: the hold reads every check that has not ended, so no number of later checks lifts it.
// Run tests on a held thread refuses with the hold's sentence before it opens an operation. The
// release reads the same checks, so a recorded group older than any page of the journal still
// refuses it.
test('a hold outlasts any number of later checks, and Run tests refuses on a held thread', {
  timeout: 30000,
}, async (t) => {
  lockPath(t);
  const group = 4242;
  const thread = await checkCopy(t, {
    // A stand-in process table: only the recorded group below is present, and nothing else is
    // looked up.
    deps: {
      groupAbsent: (value) => (value === group ? false : assert.fail('Only the group is read.')),
    },
  });
  const { store, taskId, clock, scratch, configure } = thread;
  writeFileSync(join(scratch, 'package.json'), '{"scripts":{"test":"node --version"}}');
  configure({ checks: { refresh: true } });
  journaledCheck(store, clock.now, taskId, 1);
  // More checks ran and ended after it than any page of the journal holds.
  for (let n = 2; n <= 30; n++) settledCheck(store, clock.now, taskId, n);
  const restarted = thread.start();
  restarted.recover();
  const count = () =>
    store.db.prepare('SELECT count(*) AS rows FROM task_operations WHERE task_id=?').get(taskId)
      ?.rows;
  const before = count();
  const sentence =
    'A check recorded no process identity, so CrewKite cannot confirm it ended. Other threads still work. Export diagnostics from Settings, under General, before taking further action.';
  const tests = act(store, (effects) => restarted.runTests({ taskId }, effects));
  assert.deepEqual(
    [tests.outcome, tests.reason, tests.next],
    ['blocked', 'ownership-unknown', sentence],
  );
  assert.equal(count(), before);
  const removed = act(store, (effects) => restarted.deleteThread({ taskId }, effects));
  assert.deepEqual([removed.reason, removed.next], ['ownership-unknown', sentence]);
  assert.equal(thread.read(restarted).thread.ownershipUnknown, true);
  // The oldest check of all recorded a group that is still present.
  journaledCheck(store, clock.now, taskId, 0, group);
  const release = act(store, (effects) =>
    restarted.releaseCheck({ taskId, confirm: 'explicit', note: 'I looked.' }, effects),
  );
  assert.deepEqual([release.outcome, release.reason], ['blocked', 'check-process-recorded']);
});

// Claim: a release is a thread command like the others. A retried key answers from its receipt
// and releases nothing again, and a new key finds nothing left to release.
test('a repeated release key answers from its receipt and releases nothing twice', {
  timeout: 30000,
}, async (t) => {
  lockPath(t);
  const tools = mkdtempSync(join(tmpdir(), 'ck-chat-git-'));
  t.after(() => rmSync(tools, { recursive: true, force: true }));
  const options = { gitEnvironment: { HOME: tools, PATH: installedTools(tools, 'git') } };
  const context = await setup(t, options);
  const task = (await context.controller.execute(context.draft, 'local-owner')).entity as Task;
  journaledCheck(context.controller.store, context.clock.now, task.id, 1);
  await context.controller.close();
  const controller = new Controller({
    ...options,
    home: context.controller.home,
    now: context.clock.now,
    id: context.id,
    routes: context.fixtures.snapshot.routes,
    observations: context.fixtures.snapshot.usage.map((window) => window.observation),
  });
  t.after(() => controller.close());
  const payload = { taskId: task.id, confirm: 'explicit', note: 'Nothing was left running.' };
  const release = context.command('ReleaseChatCheck', payload, 0);
  const first = await controller.execute(release, 'local-owner');
  assert.deepEqual(first, {
    outcome: 'applied',
    data: { kind: 'chat-check-released', taskId: task.id, released: 1, held: false },
  });
  assert.deepEqual(await controller.execute(release, 'local-owner'), {
    ...first,
    outcome: 'already-applied',
  });
  const fresh = await controller.execute(
    context.command('ReleaseChatCheck', payload, 0),
    'local-owner',
  );
  assert.deepEqual([fresh.outcome, fresh.reason], ['blocked', 'check-release-not-needed']);
  const read = (
    await controller.execute(
      context.command('ReadChatThread', { taskId: task.id, limit: 100 }),
      'local-owner',
    )
  ).data as ChatThreadRead;
  assert.equal(read.messages.filter((message) => message.text === RELEASED_LINE).length, 1);
});

// Claim: a release answers by what holds the thread. Nothing held, even with a check running,
// answers that nothing holds it. A check open in this process, a recorded group still present and
// a hold that is only a provider process each refuse with the reason and the sentence for the
// person, and the journal stays as it was. A check left at intent with no owner is released, and
// the line and the result say whether a provider process still holds the thread.
test('a release answers by what holds the thread and says whether a provider process still holds it', {
  timeout: 60000,
}, async (t) => {
  lockPath(t);
  const group = 4242;
  const provider = 4343;
  // Ends a running row's check once the release has answered.
  let ending = () => {};
  const runner: OwnedProjectCommandRunner = {
    launch(request, lifecycle) {
      lifecycle.intent(request);
      lifecycle.owned(group);
      const none = async function* (): AsyncGenerator<Uint8Array> {};
      const terminal = Promise.withResolvers<OwnedProjectCommandTerminal>();
      ending = () => {
        lifecycle.quiescent(group);
        terminal.resolve({ code: 0, signal: null, quiescent: true, reason: 'exit' });
      };
      return { stdout: none(), stderr: none(), terminal: terminal.promise, stop: () => {} };
    },
  };
  type Thread = Awaited<ReturnType<typeof checkCopy>>;
  // The thread's first turn left a provider process the stand-in process table still shows.
  const providerHold = ({ store, taskId }: Thread) =>
    store.db
      .prepare("UPDATE chat_turns SET body=json_set(body,'$.groups',json(?)) WHERE task_id=?")
      .run(JSON.stringify([provider]), taskId);
  const running = async (thread: Thread) => {
    thread.configure({ checks: { add: 'node --version' } });
    const open = next(
      thread,
      (event) =>
        event.type === 'chat.thread' &&
        (event.payload as ChatThread).checks?.runs.at(-1)?.status === 'running',
    );
    const run = thread.service.runCombinedChecks(thread.taskId, thread.scratch);
    await open;
    return {
      service: thread.service,
      done: () => {
        ending();
        return run;
      },
    };
  };
  const rows: {
    name: string;
    reason?: string;
    next?: string;
    /** For a release that applies: whether a provider process still holds the thread. */
    held?: boolean;
    /** The answer also clears a flag nothing stands behind. */
    cleared?: true;
    deps?: Partial<ChatServiceDeps>;
    hold?: (thread: Thread) => Promise<{ service: ChatService; done?: () => Promise<unknown> }>;
  }[] = [
    {
      name: 'a thread nothing holds',
      reason: 'check-release-not-needed',
      next: 'Nothing holds this thread.',
    },
    {
      name: 'a flag left set with nothing holding',
      reason: 'check-release-not-needed',
      next: 'Nothing holds this thread.',
      cleared: true,
      hold: async (thread) => {
        thread.store.db
          .prepare(
            "UPDATE chat_threads SET body=json_set(body,'$.ownershipUnknown',json('true')) WHERE task_id=?",
          )
          .run(thread.taskId);
        return { service: thread.service };
      },
    },
    {
      name: 'a running check and nothing held',
      reason: 'check-release-not-needed',
      next: 'Nothing holds this thread.',
      deps: { groupAbsent: () => true, checkRunner: runner },
      hold: running,
    },
    {
      name: 'a running check beside a held one',
      reason: 'check-running',
      next: 'A check is running in this thread. Stop it, then try again.',
      deps: { groupAbsent: () => true, checkRunner: runner },
      hold: async (thread) => {
        journaledCheck(thread.store, thread.clock.now, thread.taskId, 1);
        return running(thread);
      },
    },
    {
      name: 'a recorded process that is still present',
      reason: 'check-process-recorded',
      next: 'A check process CrewKite recorded is still running. The thread stays held until it ends.',
      deps: { groupAbsent: (value) => value !== group },
      hold: async ({ store, clock, taskId, start }) => {
        journaledCheck(store, clock.now, taskId, 1, group);
        // A check that never recorded its group sits beside it, and still nothing is released.
        journaledCheck(store, clock.now, taskId, 2);
        const service = start();
        service.recover();
        return { service };
      },
    },
    {
      name: 'only a provider process',
      reason: 'hold-not-releasable',
      next: 'A provider process holds this thread. CrewKite checks again with each message, and the hold lifts when the process ends.',
      deps: { groupAbsent: (value) => value !== provider },
      hold: async (thread) => {
        providerHold(thread);
        return { service: thread.service };
      },
    },
    {
      name: 'a check left running with no owner',
      held: false,
      hold: async ({ store, clock, taskId, service }) => {
        // A journal write failed after the intent, and the run that owned it has ended.
        journaledCheck(store, clock.now, taskId, 1);
        return { service };
      },
    },
    {
      name: 'a check with a provider process left',
      held: true,
      deps: { groupAbsent: (value) => value !== provider },
      hold: async (thread) => {
        providerHold(thread);
        journaledCheck(thread.store, thread.clock.now, thread.taskId, 1);
        return { service: thread.service };
      },
    },
  ];
  for (const row of rows) {
    const thread = await checkCopy(t, { deps: row.deps });
    const { service, done } = (await row.hold?.(thread)) ?? { service: thread.service };
    const before = thread.store.db
      .prepare('SELECT operation_id,state,revision FROM task_operations ORDER BY operation_id')
      .all();
    const answer = act(thread.store, (effects) =>
      service.releaseCheck(
        { taskId: thread.taskId, confirm: 'explicit', note: 'I looked.' },
        effects,
      ),
    );
    const lines = thread
      .read(service)
      .messages.filter((message) => message.text.startsWith('You released'))
      .map((message) => message.text);
    if (row.held !== undefined) {
      assert.deepEqual(
        answer,
        {
          outcome: 'applied',
          data: { kind: 'chat-check-released', taskId: thread.taskId, released: 1, held: row.held },
        },
        row.name,
      );
      assert.deepEqual(
        thread.store.db
          .prepare('SELECT state FROM task_operations')
          .all()
          .map((value) => value.state),
        ['failed'],
        row.name,
      );
      assert.deepEqual(
        lines,
        [
          row.held
            ? 'You released the check. A provider process still holds this thread.'
            : RELEASED_LINE,
        ],
        row.name,
      );
      continue;
    }
    assert.deepEqual(answer, { outcome: 'blocked', reason: row.reason, next: row.next }, row.name);
    assert.deepEqual(
      thread.store.db
        .prepare('SELECT operation_id,state,revision FROM task_operations ORDER BY operation_id')
        .all(),
      before,
      row.name,
    );
    assert.deepEqual(lines, [], row.name);
    if (row.cleared)
      assert.equal(thread.read(service).thread.ownershipUnknown, undefined, row.name);
    await done?.();
  }
});

const pick = (family: ChatFamily): ChatModelSelection => ({
  family,
  model: `${family}-model`,
  effort: 'default',
});

/**
 * A thread for the gate after a writing turn, with Allow all. The builder and the fixer write on
 * OpenAI, and a review runs on Anthropic when the row has one. The row's scripts go into the copy
 * and its checks are added as the first turn starts, once the copy exists, the way a project's
 * own scripts would be there. `scripts` gets the project folder.
 */
function gated(
  t: TestContext,
  row: {
    flightMode: 'manual' | 'balanced' | 'glide';
    writes: string[];
    reviews?: string[];
    scripts?: (project: string) => Record<string, string>;
    checks: string[];
    deps?: Partial<ChatServiceDeps>;
  },
) {
  const now = createTestClock().now();
  const openai = createScriptedChatAdapter({ family: 'openai', turns: row.writes.map(textReply) });
  const reviewer = createScriptedChatAdapter({
    family: 'anthropic',
    turns: (row.reviews ?? []).map(textReply),
  });
  const thread = standalone(t, {
    adapters: new Map([
      [
        'openai',
        {
          ...openai,
          startTurn(request: ScriptedChatRequest, emit: (event: AgentEvent) => void) {
            if (openai.requests.length === 0) {
              for (const [name, text] of Object.entries(row.scripts?.(thread.root) ?? {}))
                writeFileSync(join(request.scratch.directory, name), text);
              for (const add of row.checks) configure({ checks: { add } });
            }
            return openai.startTurn(request, emit);
          },
        },
      ],
      ['anthropic', reviewer],
    ] as const),
    catalog: () => ({
      families: [familyEntry('openai', 10, null, now), familyEntry('anthropic', 50, null, now)],
    }),
    ...row.deps,
  });
  const configure = (patch: object) =>
    thread.store.transaction(() => thread.service.configure({ taskId: thread.taskId, ...patch }));
  configure({
    crew: {
      name: row.reviews ? 'Tandem' : 'Solo',
      members: [
        { role: 'builder', selection: pick('openai') },
        ...(row.reviews ? [{ role: 'reviewer', selection: pick('anthropic') } as const] : []),
      ],
    },
    flightMode: row.flightMode,
    permissionPolicy: 'allow-all',
  });
  /** The text of the next thread line the pattern matches. */
  const line = (pattern: RegExp) =>
    next(
      thread,
      (event) =>
        event.type === 'conversation.entry' &&
        pattern.test((event.payload as { text: string }).text),
    ).then((event) => (event.payload as { text: string }).text);
  /** The thread's lines about checks and the crew, in order. */
  const lines = () =>
    thread
      .read()
      .messages.map((message) => message.text)
      .filter((text) => /^(Checks|Crew) /.test(text));
  return { ...thread, openai, line, lines };
}

// Claim: when the step after a builder turn cannot be opened, the chain stops with a line. A chain
// left as it was would read as one that never opened, and anything that follows the thread,
// such as the CLI's watch, would wait for it forever.
test('a chain whose next step cannot open stops with a line', { timeout: 30000 }, async (t) => {
  const now = createTestClock().now();
  const openai = createScriptedChatAdapter({ family: 'openai', turns: [textReply('Built it.')] });
  const thread = standalone(t, {
    adapters: new Map([
      ['openai', openai],
      ['anthropic', createScriptedChatAdapter({ family: 'anthropic', turns: [] })],
    ] as const),
    catalog: () => ({
      families: [familyEntry('openai', 10, null, now), familyEntry('anthropic', 50, null, now)],
    }),
    // Opening the review fails inside the step's own transaction, as a store error would.
    resolveSelection: (_taskId, value) => {
      if (value?.family === 'anthropic') throw new Error('The selection could not be read.');
      return value ?? null;
    },
  });
  thread.store.transaction(() =>
    thread.service.configure({
      taskId: thread.taskId,
      crew: {
        name: 'Tandem',
        members: [
          { role: 'builder', selection: pick('openai') },
          { role: 'reviewer', selection: pick('anthropic') },
        ],
      },
      flightMode: 'balanced',
      permissionPolicy: 'allow-all',
    }),
  );
  const done = turnReaches(thread, 'done');
  thread.send('Build it.', pick('openai'));
  const builder = await done;
  await new Promise((resolve) => setImmediate(resolve));
  const read = thread.read();
  assert.deepEqual(
    [read.thread.crewChain?.builderTurnId, read.thread.crewChain?.step],
    [builder.id, 'stopped'],
  );
  assert.equal(
    read.messages.at(-1)?.text,
    'Crew stopped: the next step could not start. The selection could not be read.',
  );
});

// Claim: in Balanced the gate after a builder turn asks first, then runs the enabled checks in the
// copy as after-write runs. Each failure goes to the fixer once, the gate runs again after each
// fix, and after two fixes the chain goes on to the review with no more repair.
test('a builder turn in Balanced runs the gate, each failure goes to the fixer once, and two fixes is the most', {
  timeout: 30000,
}, async (t) => {
  const thread = gated(t, {
    flightMode: 'balanced',
    writes: ['Built it.', 'Fixed one.', 'Fixed two.'],
    reviews: ['Totals skip tax.\nFindings: 1'],
    scripts: () => ({
      'gate.mjs': "console.log('gate: expected 3 got 2');\nprocess.exitCode = 1;\n",
    }),
    checks: ['node gate.mjs'],
  });
  const { store, service, taskId } = thread;
  const asks = new Set<string>();
  store.subscribe((event) => {
    const ask = event.type === 'chat.thread' ? (event.payload as ChatThread).checks?.ask : null;
    if (ask) asks.add(ask.requestId);
  });
  const asked = next(
    thread,
    (event) => event.type === 'chat.thread' && !!(event.payload as ChatThread).checks?.ask,
  );
  const ended = thread.line(/^Crew (finished|stopped)/);
  thread.send('Fix the rounding.', pick('openai'));
  const ask = ((await asked).payload as ChatThread).checks?.ask;
  assert.equal(ask?.trigger, 'after-write');
  assert.deepEqual(thread.read().thread.checks?.runs, [], 'nothing runs before the answer');
  const answered = act(store, (effects) =>
    service.resolvePermission(
      {
        taskId,
        turnId: thread.read().turns[0].id,
        requestId: ask?.requestId ?? '',
        choice: 'allow-thread',
      },
      effects,
    ),
  );
  assert.equal(answered.outcome, 'applied');
  assert.equal(await ended, 'Crew finished: 1 review round, 2 fixes.');

  const read = thread.read();
  assert.deepEqual(
    read.turns.map((turn) => turn.role),
    ['assistant', 'fixer', 'fixer', 'reviewer'],
  );
  assert.equal(asks.size, 1, 'one allow for the thread covers the gate after each fix');
  assert.deepEqual(
    read.thread.checks?.runs.map((run) => [run.trigger, run.status]),
    [
      ['after-write', 'failed'],
      ['after-write', 'failed'],
      ['after-write', 'failed'],
    ],
  );
  for (const fix of thread.openai.requests.slice(1)) {
    assert.equal(fix.role, 'fixer');
    assert.match(fix.prompt, /^The project checks failed in the scratch copy\./);
    assert.match(fix.prompt, /gate: expected 3 got 2/);
  }
  assert.deepEqual(thread.lines(), [
    'Checks failed: node gate.mjs. The fixer runs on their output.',
    'Checks failed: node gate.mjs. The fixer runs on their output.',
    'Checks failed: node gate.mjs. They still fail after 2 fixes, so the chain goes on.',
    'Crew finished: 1 review round, 2 fixes.',
  ]);
});

// Claim: the checks after one writing turn get fifteen minutes in all. When the time runs out the
// open check stops through its runner, and nothing goes on until the runner reports the process
// closed. The checks left never start. A proven close fails the gate into the fixer. A close that
// cannot be proven stops the chain and holds the thread.
test('the gate total stops the open check and nothing goes on until its process is closed', {
  timeout: 60000,
}, async (t) => {
  for (const proven of [true, false])
    await t.test(proven ? 'a proven close' : 'an unknown close', { timeout: 30000 }, async (t) => {
      const group = 4242;
      const timers: { work: () => void; ms: number }[] = [];
      const launches: {
        stops: number;
        close: (quiescent: boolean, code: number | null) => void;
      }[] = [];
      const runner: OwnedProjectCommandRunner = {
        launch(request, lifecycle) {
          lifecycle.intent(request);
          lifecycle.owned(group);
          const terminal = Promise.withResolvers<OwnedProjectCommandTerminal>();
          const none = async function* (): AsyncGenerator<Uint8Array> {};
          const launch = {
            stops: 0,
            close: (quiescent: boolean, code: number | null) => {
              if (quiescent) lifecycle.quiescent(group);
              terminal.resolve({
                code,
                signal: null,
                quiescent,
                reason: code === 0 ? 'exit' : 'stopped',
              });
            },
          };
          launches.push(launch);
          // The gate after the fix passes at once.
          if (launches.length > 1) launch.close(true, 0);
          return {
            stdout: none(),
            stderr: none(),
            terminal: terminal.promise,
            stop: () => {
              launch.stops += 1;
            },
          };
        },
      };
      const thread = gated(t, {
        flightMode: 'glide',
        writes: ['Built it.', 'Fixed it.'],
        checks: ['node first.mjs', 'node second.mjs'],
        deps: {
          schedule: (work, ms) => {
            timers.push({ work, ms });
            return () => {};
          },
          checkRunner: runner,
          groupAbsent: (value) => proven || value !== group,
        },
      });
      const running = next(
        thread,
        (event) =>
          event.type === 'chat.thread' &&
          (event.payload as ChatThread).checks?.runs.at(-1)?.status === 'running',
      );
      thread.send('Build it.', pick('openai'));
      await running;
      assert.equal(launches.length, 1);
      const total = timers.find((timer) => timer.ms === 15 * 60_000);
      assert.ok(total, 'the gate set its total');
      total.work();
      assert.equal(launches[0].stops, 1);
      // A stop only asks the process to end. The run stays open, and no step starts until the
      // runner reports the process closed.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(thread.read().thread.checks?.runs.at(-1)?.status, 'running');
      assert.deepEqual(thread.lines(), []);
      assert.equal(thread.read().turns.length, 1);

      const ended = thread.line(/^Crew (finished|stopped)/);
      launches[0].close(proven, null);
      const over =
        'The checks after this turn reached their 15-minute total, so this one did not finish.';
      if (proven) {
        assert.equal(await ended, 'Crew finished: 0 review rounds, 1 fix.');
        const read = thread.read();
        assert.deepEqual(
          read.thread.checks?.runs.map((run) => [run.label, run.status, run.reason]),
          [
            ['node first.mjs', 'failed', over],
            ['node second.mjs', 'failed', over],
            ['node first.mjs', 'passed', null],
            ['node second.mjs', 'passed', null],
          ],
        );
        assert.equal(launches.length, 3, 'the first gate never started its second check');
        assert.deepEqual(
          read.turns.map((turn) => turn.role),
          ['assistant', 'fixer'],
        );
        assert.match(thread.openai.requests[1]?.prompt ?? '', /reached their 15-minute total/);
        // The finished chain stays on the record and holds nothing, so Run tests starts.
        const scratch = chatScratchDirectory(dirname(thread.root), thread.taskId);
        writeFileSync(join(scratch, 'package.json'), '{"scripts":{"test":"node first.mjs"}}');
        thread.store.transaction(() =>
          thread.service.configure({ taskId: thread.taskId, checks: { refresh: true } }),
        );
        const tested = thread.line(/^Tests (passed|failed)/);
        const runTests = act(thread.store, (effects) =>
          thread.service.runTests({ taskId: thread.taskId }, effects),
        );
        assert.equal(runTests.outcome, 'applied', runTests.next);
        assert.equal(await tested, 'Tests passed: npm run test (exit 0).');
        return;
      }
      assert.equal(await ended, 'Crew stopped: a check process may still be running.');
      const read = thread.read();
      assert.deepEqual(
        read.thread.checks?.runs.map((run) => [run.label, run.status]),
        [
          ['node first.mjs', 'unknown'],
          ['node second.mjs', 'failed'],
        ],
      );
      assert.equal(launches.length, 1);
      assert.equal(read.thread.ownershipUnknown, true);
      // No turn starts while the process may still write the copy.
      assert.equal(thread.send('Go on.', pick('openai')).outcome, 'applied');
      assert.equal(thread.read().thread.queued.length, 1);
      assert.deepEqual(
        thread.read().turns.map((turn) => turn.role),
        ['assistant'],
      );
    });
});

// Claim: when the copy's dependencies must be prepared again and the preparation produces nothing,
// the gate runs nothing. Checks on the old dependencies would fail for a reason that is not in
// the code and send that failure to the fixer.
test('a copy that needs preparing and whose preparation fails runs no checks and sends nothing to the fixer', {
  timeout: 30000,
}, async (t) => {
  const late: { preparer?: DependencyPreparer } = {};
  const thread = gated(t, {
    flightMode: 'glide',
    writes: ['Built it.', 'Fixed it.'],
    // The copy gains a manifest the prepared record never saw, so the copy moved.
    scripts: () => ({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { tiny: '^1.0.0' } }),
      'gate.mjs': "console.log('Cannot find module tiny');\nprocess.exitCode = 1;\n",
    }),
    checks: ['node gate.mjs'],
    deps: {
      dependencies: {
        prepare: async () => {
          throw new Error('The copy could not be prepared.');
        },
        preparing: () => false,
        environment: (...input) => (late.preparer as DependencyPreparer).environment(...input),
      },
    },
  });
  const { store, taskId, root, clock } = thread;
  const id = `prp_${'0'.repeat(25)}2`;
  late.preparer = new DependencyPreparer({
    store,
    home: dirname(root),
    now: clock.now,
    id: () => id,
    projectPath: () => root,
  });
  const at = clock.now();
  store.transaction(() =>
    store.putDependencyPreparation(
      {
        id,
        taskId,
        scope: 'thread',
        scopeKey: taskId,
        state: 'prepared',
        layout: 'none',
        inputs: detectDependencies(root).inputs,
        treeDigest: null,
        bytes: null,
        limitBytes: 1024 * 1024,
        reason: null,
        preparedAt: at,
      },
      at,
    ),
  );
  const ended = thread.line(/^(Crew (finished|stopped)|Checks passed)/);
  thread.send('Build it.', pick('openai'));
  assert.equal(
    await ended,
    'Crew stopped: the checks could not run. Dependencies need preparation.',
  );
  const read = thread.read();
  assert.deepEqual(read.thread.checks?.runs ?? [], []);
  assert.deepEqual(
    read.turns.map((turn) => turn.role),
    ['assistant'],
  );
});

// Claim: the gate runs only in a current dependency copy. A copy nobody prepared is prepared by
// the gate, and the checks run with it. A copy whose preparation finds it stale, or one gone
// stale while the question waited, stops the chain with its line and runs nothing. A copy that
// turns stale while the checks run leaves their result saying nothing, so a failed check goes to
// no fixer, and the line names what changed. A read of the copy that throws counts as not ready.
test('a stale dependency copy blocks the gate with its line and starts no repair', {
  timeout: 90000,
}, async (t) => {
  const lock = (version: string) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/tiny': { version } },
    });
  const rows = [
    {
      // The project installs tiny 1.2.3 and the copy's lockfile asks for 1.2.4, so preparing the
      // copy finds it stale.
      name: 'stale before the gate',
      npm: lock('1.2.4'),
      line: 'Crew stopped: the checks could not run. Dependencies need preparation. The lockfile changed.',
      runs: [],
      record: ['stale', 'stale-lockfile'],
    },
    {
      // The copy asks for what the project installed, so the gate prepares it and the check
      // finds tiny in the copy.
      name: 'unprepared before the gate',
      npm: lock('1.2.3'),
      line: 'Checks passed: node gate.mjs.',
      runs: ['passed'],
      record: ['prepared', null],
    },
    {
      name: 'stale while the checks run',
      line: 'Crew stopped: the dependencies changed while the checks ran. Dependencies need preparation. A package.json changed.',
      runs: ['failed'],
    },
    {
      name: 'stale while the question waits',
      asks: true,
      line: 'Crew stopped: the checks could not run. Dependencies need preparation. A package.json changed.',
      runs: [],
    },
    {
      name: 'a read that throws before the gate',
      throws: 'always',
      line: 'Crew stopped: the checks could not run. Dependencies need preparation.',
      runs: [],
    },
    {
      name: 'a read that throws after the checks',
      throws: 'after',
      line: 'Crew stopped: the dependencies changed while the checks ran. Dependencies need preparation.',
      runs: ['failed'],
    },
  ] as const;
  for (const row of rows)
    await t.test(row.name, { timeout: 30000 }, async (t) => {
      const late: { preparer?: DependencyPreparer } = {};
      const preparer = () => late.preparer as DependencyPreparer;
      // The check writes the project's package.json, so its presence says the check has run.
      const throws = () =>
        'throws' in row &&
        (row.throws === 'always' || existsSync(join(thread.root, 'package.json')));
      const manifest = JSON.stringify({ name: 'shop', dependencies: { tiny: '^1.0.0' } });
      const thread = gated(t, {
        flightMode: 'asks' in row ? 'balanced' : 'glide',
        writes: ['Built it.', 'Unused.'],
        // An npm row's copy holds the manifest and its lockfile, and the check passes only when
        // tiny resolves from the copy. Any other row's check fails, so a current copy would send
        // it to the fixer, and it writes a package.json into the project, which moves what the
        // copy was prepared from.
        scripts: (project): Record<string, string> =>
          'npm' in row
            ? {
                'package.json': manifest,
                'package-lock.json': row.npm,
                'gate.mjs': [
                  "import { createRequire } from 'node:module';",
                  "console.log(createRequire(process.cwd() + '/').resolve('tiny'));",
                ].join('\n'),
              }
            : {
                'gate.mjs': [
                  "import { writeFileSync } from 'node:fs';",
                  `writeFileSync(${JSON.stringify(join(project, 'package.json'))}, '{"name":"shop"}');`,
                  "console.log('gate: expected 3 got 2');",
                  'process.exitCode = 1;',
                ].join('\n'),
              },
        checks: ['node gate.mjs'],
        deps: {
          dependencies: {
            prepare: (...input) => preparer().prepare(...input),
            preparing: (taskId) => preparer().preparing(taskId),
            environment: (...input) => {
              if (throws()) throw new Error('The preparation record could not be read.');
              return preparer().environment(...input);
            },
          },
        },
      });
      const { store, taskId, root, clock } = thread;
      const id = `prp_${'0'.repeat(25)}1`;
      late.preparer = new DependencyPreparer({
        store,
        home: dirname(root),
        now: clock.now,
        id: () => id,
        projectPath: () => root,
      });
      if ('npm' in row) {
        // The project installs tiny 1.2.3, and nobody prepared the thread's copy.
        writeFileSync(join(root, 'package.json'), manifest);
        writeFileSync(join(root, 'package-lock.json'), lock('1.2.3'));
        mkdirSync(join(root, 'node_modules/tiny'), { recursive: true });
        writeFileSync(
          join(root, 'node_modules/tiny/package.json'),
          JSON.stringify({ name: 'tiny', version: '1.2.3' }),
        );
        writeFileSync(join(root, 'node_modules/tiny/index.js'), 'module.exports = 1;\n');
      } else {
        const at = clock.now();
        const copy: DependencyPreparation = {
          id,
          taskId,
          scope: 'thread',
          scopeKey: taskId,
          state: 'prepared',
          layout: 'none',
          inputs: detectDependencies(root).inputs,
          treeDigest: null,
          bytes: null,
          limitBytes: 1024 * 1024,
          reason: null,
          preparedAt: at,
        };
        store.transaction(() => store.putDependencyPreparation(copy, at));
      }
      const ended = thread.line(/^(Crew (finished|stopped)|Checks passed)/);
      const asked = next(
        thread,
        (event) => event.type === 'chat.thread' && !!(event.payload as ChatThread).checks?.ask,
      );
      thread.send('Build it.', pick('openai'));
      if ('asks' in row) {
        // The project's manifest moves while the question waits, and the allow comes after.
        const ask = ((await asked).payload as ChatThread).checks?.ask;
        writeFileSync(join(root, 'package.json'), '{"name":"shop"}');
        const answer = act(store, (effects) =>
          thread.service.resolvePermission(
            {
              taskId,
              turnId: thread.read().turns[0].id,
              requestId: ask?.requestId ?? '',
              choice: 'allow',
            },
            effects,
          ),
        );
        assert.equal(answer.outcome, 'applied');
      }
      assert.equal(await ended, row.line);
      const read = thread.read();
      assert.deepEqual(
        read.thread.checks?.runs.map((run) => run.status),
        row.runs,
      );
      assert.deepEqual(
        read.turns.map((turn) => turn.role),
        ['assistant'],
      );
      if ('record' in row) {
        const record = store
          .dependencyPreparations(taskId)
          .find((value) => value.scope === 'thread');
        assert.deepEqual([record?.state, record?.reason], row.record);
      }
    });
});

// Claim: only Balanced and Glide run the gate after a writing turn. Manual runs nothing after a
// reply, whatever checks are on.
test('the gate runs after a writing turn in Glide and never in Manual', {
  timeout: 60000,
}, async (t) => {
  for (const flightMode of ['manual', 'glide'] as const)
    await t.test(flightMode, { timeout: 30000 }, async (t) => {
      const thread = gated(t, { flightMode, writes: ['Built it.'], checks: ['node --version'] });
      const done = turnReaches(thread, 'done');
      const passed = thread.line(/^Checks passed/);
      thread.send('Build it.', pick('openai'));
      await done;
      if (flightMode === 'glide') await passed;
      const read = thread.read();
      assert.deepEqual(
        read.thread.checks?.runs.map((run) => [run.trigger, run.status]),
        flightMode === 'glide' ? [['after-write', 'passed']] : [],
      );
      assert.equal(read.thread.checks?.ask, null);
      // A Solo crew whose gate passed has no chain to show.
      assert.equal(read.thread.crewChain, null);
      assert.deepEqual(
        thread.lines(),
        flightMode === 'glide' ? ['Checks passed: node --version.'] : [],
      );
    });
});

/** A turn that writes one file. */
const writes = (path: string, content: string): ChatScriptStep[] => [
  {
    kind: 'tool',
    callId: `w-${path}`,
    toolKind: 'edit',
    title: `Write ${path}`,
    write: { path, content },
  },
];

/**
 * A plan thread in Glide over a project that installs one npm package, with Allow all unless the
 * row allows edits only. The base commits the manifest, the lockfile and `gate.mjs`, and
 * `node gate.mjs` is the one check on. The thread copy is prepared before the plan, the way a
 * person prepares it, unless the row says nobody did. Slice 1 is medium and builds on OpenAI.
 * Slice 2 is hard, so the crew's fixer on Local builds it beside slice 1, or after it when the
 * row says so, and Local runs every fix in a lane. Local offers Allow for this thread on its
 * questions, and a row can leave it unconnected. The check prints where it ran and where `tiny`
 * resolved from, then runs the row's gate body, which gets the controller home.
 */
async function lanePlan(
  t: TestContext,
  row: {
    slices: 1 | 2;
    gate: (home: string) => string;
    openai: ChatScriptStep[][];
    local?: ChatScriptStep[][];
    prepared?: false;
    policy?: 'allow-edits';
    after?: true;
    unplugged?: true;
  },
) {
  const now = createTestClock().now();
  const slices = [1, 2].slice(0, row.slices).map((id) => ({
    id,
    title: `Part ${id}`,
    brief: `Do part ${id}.`,
    files: [],
    depends: id === 2 && row.after ? [1] : [],
    difficulty: id === 1 ? 'medium' : 'hard',
    readOnly: false,
  }));
  const plan = textReply(
    `\`\`\`json plan\n${JSON.stringify({ planId: 'p1', goal: 'Split it.', slices })}\n\`\`\``,
  );
  const openai = createScriptedChatAdapter({
    family: 'openai',
    turns: [textReply('Read it.'), plan, ...row.openai],
  });
  const local = createScriptedChatAdapter({ family: 'local', turns: row.local ?? [] });
  const allowThread = {
    id: 'allow-thread',
    label: 'Allow for this thread',
    kind: 'allow-thread',
  } as const;
  const offering = {
    ...local,
    startTurn(request: ScriptedChatRequest, emit: (event: AgentEvent) => void) {
      return local.startTurn(request, (event) =>
        emit(
          event.type === 'permission.requested'
            ? { ...event, options: [...event.options, allowThread] }
            : event,
        ),
      );
    },
  } as typeof local;
  const late: { preparer?: DependencyPreparer } = {};
  const preparer = () => late.preparer as DependencyPreparer;
  const thread = standalone(t, {
    adapters: new Map([
      ['openai', openai],
      ...(row.unplugged ? [] : [['local', offering] as const]),
    ] as const),
    catalog: () => ({
      families: [familyEntry('openai', 10, null, now), familyEntry('local', 90, null, now)],
    }),
    localContext: () => 32_768,
    localSliceFits: () => true,
    dependencies: {
      prepare: (...input) => preparer().prepare(...input),
      environment: (...input) => preparer().environment(...input),
      preparing: (taskId) => preparer().preparing(taskId),
    },
  });
  const { store, service, taskId, root, clock } = thread;
  const home = dirname(root);
  let records = 0;
  late.preparer = new DependencyPreparer({
    store,
    home,
    now: clock.now,
    id: () => `prp_${String(++records).padStart(26, '0')}`,
    projectPath: () => root,
  });
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { tiny: '^1.0.0' } }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/tiny': { version: '1.2.3' } },
    }),
    '.gitignore': 'node_modules\n',
    'gate.mjs': [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { createRequire } from 'node:module';",
      "console.log(process.cwd(), createRequire(process.cwd() + '/').resolve('tiny'));",
      row.gate(home),
    ].join('\n'),
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  mkdirSync(join(root, 'node_modules/tiny'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules/tiny/package.json'),
    JSON.stringify({ name: 'tiny', version: '1.2.3' }),
  );
  writeFileSync(join(root, 'node_modules/tiny/index.js'), 'module.exports = 1;\n');
  const paths = Object.keys(files);
  git(root, ['add', '--', ...paths]);
  git(root, ['commit', '-q', '-m', 'Add the package.', '--', ...paths], undefined, {
    name: 'Fixture',
    email: 'fixture@example.invalid',
    at: '2026-10-15T18:00:00Z',
  });
  const read = turnReaches(thread, 'done');
  thread.send('Read the project.', pick('openai'));
  await read;
  if (row.prepared !== false) {
    const prepared = await preparer().prepare(taskId, 'thread', taskId);
    assert.equal(prepared && prepared !== 'busy' ? prepared.state : prepared, 'prepared');
  }
  store.transaction(() =>
    service.configure({
      taskId,
      crew: {
        name: 'Plan crew',
        members: [
          { role: 'builder', selection: pick('openai') },
          { role: 'fixer', selection: pick('local') },
          { role: 'orchestrator', selection: pick('openai') },
        ],
      },
      flightMode: 'glide',
      permissionPolicy: row.policy ?? 'allow-all',
      checks: { add: 'node gate.mjs' },
    }),
  );
  const ended = next(
    thread,
    (event) =>
      event.type === 'conversation.entry' &&
      /^(Crew finished|Plan stopped)/.test((event.payload as { text: string }).text),
  ).then((event) => (event.payload as { text: string }).text);
  thread.send('Split the work.', pick('openai'));
  const scratch = realpathSync(chatScratchDirectory(home, taskId));
  const copy = (id: number) =>
    realpathSync(join(home, 'chat', taskId, 'slices', String(id), 'copy'));
  /** Each run as its trigger, its status and its first output line: the folder and `tiny`. */
  const runs = () =>
    (thread.read().thread.checks?.runs ?? []).map(
      (run) => [run.trigger, run.status, run.tail.split('\n')[0]] as const,
    );
  const lines = () =>
    thread
      .read()
      .messages.map((message) => message.text)
      .filter((text) => /^(Checks|Plan|Crew|Slice \d+ finished)/.test(text));
  const lanes = () =>
    store
      .dependencyPreparations(taskId)
      .filter((record) => record.scope === 'lane')
      .map((record) => [record.scopeKey, record.state, record.reason, record.id] as const)
      .sort();
  const threadCopy = () =>
    store.dependencyPreparations(taskId).find((record) => record.scope === 'thread')?.state ?? null;
  const tiny = (folder: string) => `${folder} ${join(folder, 'node_modules/tiny/index.js')}`;
  /** Resolves once the thread reads as `ok`, now or after a later event. */
  const until = (ok: (read: ChatThreadRead) => boolean) =>
    ok(thread.read())
      ? Promise.resolve()
      : next(thread, () => ok(thread.read())).then(() => undefined);
  /** Answer the open checks question. */
  const answer = (choice: 'allow' | 'allow-thread') =>
    act(store, (effects) =>
      service.resolvePermission(
        {
          taskId,
          turnId: thread.read().turns[0].id,
          requestId: thread.read().thread.checks?.ask?.requestId ?? '',
          choice,
        },
        effects,
      ),
    ).outcome;
  return {
    ...thread,
    openai,
    local,
    ended,
    scratch,
    copy,
    runs,
    lines,
    lanes,
    threadCopy,
    tiny,
    until,
    answer,
  };
}

// Claim: a slice's writing turn passes its gate in the slice's own copy, with the slice's own
// prepared dependencies, before anything of it merges. A failure goes to the slice's fixer with
// the checks' output within the crew's two fixes. A slice that still fails stops the plan as
// failed, and nothing of it reaches the thread copy. A thread copy nobody prepared is prepared
// before the checks after the first merge, so they run with its dependencies.
test("a slice's gate runs in its own copy before the merge, and a failure repairs within the bound or fails the slice", {
  timeout: 60000,
}, async (t) => {
  const failing = "console.log('gate: expected 3 got 2');\nprocess.exitCode = 1;";
  const rows = [
    {
      name: 'a failure the first fix repairs',
      // Nobody prepared the thread copy before the plan.
      prepared: false,
      // It fails once, after the builder. Its marker sits outside every copy.
      gate: (home: string) =>
        `const marker = ${JSON.stringify(join(home, 'gate-ran'))};\nif (!existsSync(marker)) {\nwriteFileSync(marker, 'x');\n${failing}\n}`,
      local: [textReply('Fixed it.')],
      lines: [
        'Checks failed in slice 1: node gate.mjs. The fixer runs on their output.',
        'Checks passed in slice 1: node gate.mjs.',
        'Slice 1 finished: 1 file merged.',
        'Checks passed after slice 1 merged: node gate.mjs.',
        'Crew finished: 1 slice, 0 reviews, 1 fix.',
      ],
      card: ['finished', 'done'],
      runs: [
        ['after-write', 'failed', 1],
        ['after-write', 'passed', 1],
        ['combined', 'passed', 0],
      ],
      merged: 'one\n',
    },
    {
      name: 'a failure that outlasts two fixes',
      gate: () => failing,
      local: [textReply('Fixed one.'), textReply('Fixed two.')],
      lines: [
        'Checks failed in slice 1: node gate.mjs. The fixer runs on their output.',
        'Checks failed in slice 1: node gate.mjs. The fixer runs on their output.',
        'Plan stopped at slice 1: node gate.mjs still failed after 2 fixes. Run slice 1 again from the plan card.',
      ],
      card: ['stopped', 'failed'],
      runs: [
        ['after-write', 'failed', 1],
        ['after-write', 'failed', 1],
        ['after-write', 'failed', 1],
      ],
      merged: null,
    },
  ] as const;
  for (const row of rows)
    await t.test(row.name, { timeout: 30000 }, async (t) => {
      const plan = await lanePlan(t, {
        slices: 1,
        gate: row.gate,
        openai: [writes('a.txt', 'one\n')],
        local: [...row.local],
        ...('prepared' in row ? { prepared: row.prepared } : {}),
      });
      await plan.ended;
      assert.deepEqual(plan.lines(), row.lines);
      assert.equal(plan.threadCopy(), 'prepared');
      const read = plan.read();
      assert.deepEqual(
        [read.thread.plan?.phase, ...(read.thread.plan?.slices.map((slice) => slice.status) ?? [])],
        row.card,
      );
      // Each gate ran in the slice's copy and found `tiny` in the slice's own prepared tree.
      const where = (folder: number) =>
        folder ? plan.tiny(plan.copy(1)) : plan.tiny(plan.scratch);
      assert.deepEqual(
        plan.runs(),
        row.runs.map(([trigger, status, folder]) => [trigger, status, where(folder)]),
      );
      assert.deepEqual(
        plan.lanes().map(([key, state]) => [key, state]),
        [['1', 'prepared']],
      );
      for (const fix of plan.local.requests) {
        assert.equal(fix.role, 'fixer');
        assert.ok(fix.scratch.directory.endsWith(join('slices', '1', 'copy')));
        assert.match(fix.prompt, /^The project checks failed in the scratch copy\./);
        assert.match(fix.prompt, /gate: expected 3 got 2/);
      }
      assert.equal(plan.local.requests.length, row.local.length);
      const merged = join(plan.scratch, 'a.txt');
      assert.equal(existsSync(merged) ? readFileSync(merged, 'utf8') : null, row.merged);
    });
});

// Claim: each merge runs the checks on the thread copy, so two slices that pass alone and break
// together are caught at the second merge. The plan stops there with the slice named, and the
// slice shows failed on its builder turn, where Retry runs it again. Each run names the slice it
// checked. A plan that stops in the same step that merged runs no check after that merge.
test('the checks after a merge catch a break each slice passed alone and stop the plan naming the slice', {
  timeout: 60000,
}, async (t) => {
  await t.test('two slices that clash', { timeout: 30000 }, async (t) => {
    const plan = await lanePlan(t, {
      slices: 2,
      gate: () =>
        "if (existsSync('a.txt') && existsSync('b.txt')) {\nconsole.log('a.txt and b.txt clash');\nprocess.exitCode = 1;\n}",
      openai: [writes('a.txt', 'one\n')],
      local: [writes('b.txt', 'two\n')],
    });
    assert.equal(
      await plan.ended,
      'Plan stopped after slice 2 merged: node gate.mjs failed. Run slice 2 again from the plan card.',
    );
    const read = plan.read();
    assert.deepEqual(
      [read.thread.plan?.phase, ...(read.thread.plan?.slices.map((slice) => slice.status) ?? [])],
      ['stopped', 'done', 'failed'],
    );
    const built = read.turns.find((turn) => turn.slice === 2 && turn.role === 'assistant');
    assert.equal(read.thread.plan?.slices[1].turnId, built?.id);
    const runs = plan.runs();
    assert.deepEqual(
      runs.filter(([trigger]) => trigger === 'after-write').map(([, status]) => status),
      ['passed', 'passed'],
    );
    assert.deepEqual(
      runs.filter(([trigger]) => trigger === 'combined'),
      [
        ['combined', 'passed', plan.tiny(plan.scratch)],
        ['combined', 'failed', plan.tiny(plan.scratch)],
      ],
    );
    // A lane's runs name its slice, and so do the runs after that slice merged.
    assert.deepEqual(
      (read.thread.checks?.runs ?? []).map((run) => `${run.trigger} ${run.slice}`).sort(),
      ['after-write 1', 'after-write 2', 'combined 1', 'combined 2'],
    );
    // Each lane's own pass lands when that lane finishes, so only the merges are in a fixed order.
    const merges = plan.lines().filter((line) => !line.startsWith('Checks passed in slice'));
    assert.deepEqual(merges, [
      'Slice 1 finished: 1 file merged.',
      'Checks passed after slice 1 merged: node gate.mjs.',
      'Slice 2 finished: 1 file merged.',
      'Plan stopped after slice 2 merged: node gate.mjs failed. Run slice 2 again from the plan card.',
    ]);
    assert.match(read.thread.checks?.runs.at(-1)?.tail ?? '', /a\.txt and b\.txt clash$/);
  });
  await t.test('a plan that stops in the step that merged', { timeout: 30000 }, async (t) => {
    // Slice 2 waits for slice 1 and its provider is not connected, so the step that merges
    // slice 1 also stops the plan when slice 2 cannot start.
    const plan = await lanePlan(t, {
      slices: 2,
      after: true,
      unplugged: true,
      gate: () => '',
      openai: [writes('a.txt', 'one\n')],
    });
    assert.equal(
      await plan.ended,
      'Plan stopped: slice 2 could not start. Connect this provider in Settings or pick another.',
    );
    // A merge check would have started its run within this turn of the event loop.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(plan.runs(), [['after-write', 'passed', plan.tiny(plan.copy(1))]]);
    const read = plan.read();
    assert.deepEqual(
      [read.thread.plan?.phase, ...(read.thread.plan?.slices.map((slice) => slice.status) ?? [])],
      ['stopped', 'done', 'failed'],
    );
    assert.equal(readFileSync(join(plan.scratch, 'a.txt'), 'utf8'), 'one\n');
  });
});

// Claim: slices that run at once each gate in their own copy with their own preparation of the
// dependencies. Neither lane reads the other's copy or its prepared tree. A grant one lane's turn
// adds while the other lane's checks run leaves those checks standing.
test('two slices in parallel gate in their own copies with their own dependency preparations', {
  timeout: 30000,
}, async (t) => {
  const plan = await lanePlan(t, {
    slices: 2,
    policy: 'allow-edits',
    // The check holds until the test releases it, so slice 2's question lands while it runs.
    gate: (home) =>
      [
        `const release = ${JSON.stringify(join(home, 'release'))};`,
        'const end = Date.now() + 20000;',
        'while (!existsSync(release) && Date.now() < end)',
        '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);',
      ].join('\n'),
    openai: [writes('a.txt', 'one\n')],
    local: [
      [
        { kind: 'permission', requestId: 'p-cmd', question: 'Run the tests?' },
        { kind: 'tool', callId: 'c-cmd', toolKind: 'command', title: 'npm test' },
        ...writes('b.txt', 'two\n'),
      ],
    ],
  });
  // The thread allows edits only, so the checks ask once and Allow for this thread covers the rest.
  await plan.until((read) => !!read.thread.checks?.ask);
  assert.equal(plan.answer('allow-thread'), 'applied');
  const asking = (read: ChatThreadRead) =>
    read.turns.find((turn) => turn.slice === 2 && turn.state === 'waiting-permission');
  await plan.until(
    (read) => !!asking(read) && !!read.thread.checks?.runs.some((run) => run.status === 'running'),
  );
  const granted = act(plan.store, (effects) =>
    plan.service.resolvePermission(
      {
        taskId: plan.taskId,
        turnId: asking(plan.read())?.id ?? '',
        requestId: 'p-cmd',
        choice: 'allow-thread',
      },
      effects,
    ),
  );
  assert.equal(granted.outcome, 'applied');
  assert.deepEqual(plan.read().thread.permissionGrants, ['command']);
  writeFileSync(join(dirname(plan.root), 'release'), '');
  assert.equal(await plan.ended, 'Crew finished: 2 slices, 0 reviews, 0 fixes.');
  const runs = plan.runs();
  assert.deepEqual(
    runs
      .filter(([trigger]) => trigger === 'after-write')
      .map(([, status, where]) => [status, where])
      .sort(),
    [
      ['passed', plan.tiny(plan.copy(1))],
      ['passed', plan.tiny(plan.copy(2))],
    ].sort(),
  );
  const lanes = plan.lanes();
  assert.deepEqual(
    lanes.map(([key, state]) => [key, state]),
    [
      ['1', 'prepared'],
      ['2', 'prepared'],
    ],
  );
  assert.notEqual(lanes[0][3], lanes[1][3]);
  assert.deepEqual(
    [1, 2].map((id) => ['a.txt', 'b.txt'].filter((name) => existsSync(join(plan.copy(id), name)))),
    [['a.txt'], ['b.txt']],
  );
});

// Claim: a slice's checks run only outside Manual and in a current preparation of the slice's own
// copy. A lockfile the builder or a fixer rewrote in the slice, or one that moved in the project
// while the checks' question waited, stops the plan with the preparation line. A switch to Manual
// while the question waited stops it too. No check runs after that, no further fix starts and
// nothing of the slice merges.
test('a stale slice preparation or a switch to Manual stops that slice with its line and starts no repair', {
  timeout: 120000,
}, async (t) => {
  const moved = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/tiny': { version: '1.2.4' } },
  });
  const stale =
    'Plan stopped at slice 1: the checks could not run. Dependencies need preparation. The lockfile changed.';
  type Plan = Awaited<ReturnType<typeof lanePlan>>;
  const rows: {
    name: string;
    policy?: 'allow-edits';
    gate?: (home: string) => string;
    openai: ChatScriptStep[][];
    local?: ChatScriptStep[][];
    waits?: (plan: Plan) => void;
    line: string;
    runs: string[];
    lane: (string | null)[];
  }[] = [
    {
      name: 'the builder rewrites the lockfile',
      openai: [writes('package-lock.json', moved)],
      line: stale,
      runs: [],
      lane: ['stale', 'stale-lockfile'],
    },
    {
      name: 'a fixer rewrites the lockfile',
      // The check fails once, so the fixer runs. The gate after the fix finds the slice's own
      // lockfile moved since the build's preparation.
      gate: (home) =>
        `const marker = ${JSON.stringify(join(home, 'gate-ran'))};\nif (!existsSync(marker)) {\nwriteFileSync(marker, 'x');\nprocess.exitCode = 1;\n}`,
      openai: [writes('a.txt', 'one\n')],
      local: [writes('package-lock.json', moved)],
      line: stale,
      runs: ['failed'],
      lane: ['stale', 'stale-lockfile'],
    },
    {
      name: 'the project lockfile moves while the question waits',
      policy: 'allow-edits',
      openai: [writes('a.txt', 'one\n')],
      waits: (plan) => writeFileSync(join(plan.root, 'package-lock.json'), moved),
      line: stale,
      runs: [],
      lane: ['stale', 'stale-lockfile'],
    },
    {
      name: 'a switch to Manual while the question waits',
      policy: 'allow-edits',
      openai: [writes('a.txt', 'one\n')],
      waits: (plan) =>
        plan.store.transaction(() =>
          plan.service.configure({ taskId: plan.taskId, flightMode: 'manual' }),
        ),
      line: 'Plan stopped at slice 1: the thread is in manual mode.',
      runs: [],
      lane: ['prepared', null],
    },
  ];
  for (const row of rows)
    await t.test(row.name, { timeout: 30000 }, async (t) => {
      const plan = await lanePlan(t, {
        slices: 1,
        gate: row.gate ?? (() => ''),
        openai: row.openai,
        local: row.local,
        ...(row.policy ? { policy: row.policy } : {}),
      });
      if (row.waits) {
        await plan.until((read) => !!read.thread.checks?.ask);
        row.waits(plan);
        assert.equal(plan.answer('allow'), 'applied');
      }
      assert.equal(await plan.ended, row.line);
      const read = plan.read();
      assert.deepEqual(
        [read.thread.plan?.phase, ...(read.thread.plan?.slices.map((slice) => slice.status) ?? [])],
        ['stopped', 'failed'],
      );
      assert.deepEqual(
        plan.runs().map(([, status]) => status),
        row.runs,
      );
      assert.equal(plan.local.requests.length, row.local?.length ?? 0);
      assert.deepEqual(
        plan.lanes().map(([key, state, reason]) => [key, state, reason]),
        [['1', ...row.lane]],
      );
      assert.notEqual(readFileSync(join(plan.scratch, 'package-lock.json'), 'utf8'), moved);
      assert.equal(existsSync(join(plan.scratch, 'a.txt')), false);
    });
});

/** A thread ready for a checked Accept, with what the tests read back from it. */
/** A committed npm manifest and lockfile, with the one package they name installed. */
function installTiny(root: string) {
  const files = {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { tiny: '^1.0.0' } }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/tiny': { version: '1.2.3' } },
    }),
    '.gitignore': 'node_modules\n',
  };
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  mkdirSync(join(root, 'node_modules/tiny'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules/tiny/package.json'),
    JSON.stringify({ name: 'tiny', version: '1.2.3' }),
  );
  writeFileSync(join(root, 'node_modules/tiny/index.js'), 'module.exports = 1;\n');
  const paths = Object.keys(files);
  git(root, ['add', '--', ...paths]);
  git(root, ['commit', '--quiet', '--message', 'Add the manifest.', '--', ...paths], undefined, {
    name: 'Fixture',
    email: 'fixture@example.invalid',
    at: '2026-10-15T18:00:00Z',
  });
}

/**
 * A thread ready for a checked Accept, with what the tests read back from it. `plan` makes the
 * first reply an orchestrator's plan, left proposed. `dependencies` gives the project an installed
 * npm package and the service the dependency copy.
 */
async function acceptCopy(
  t: TestContext,
  options: { turns?: ChatScriptStep[][]; plan?: boolean; dependencies?: boolean } = {},
) {
  // The copy needs the thread's store, which exists only once the thread does.
  let preparer: DependencyPreparer | undefined;
  const prepared = () => preparer as DependencyPreparer;
  const thread = await checkCopy(t, {
    turns: options.turns,
    deps: options.dependencies
      ? {
          dependencies: {
            prepare: (...args) => prepared().prepare(...args),
            environment: (...args) => prepared().environment(...args),
            preparing: (taskId) => prepared().preparing(taskId),
          },
        }
      : {},
    before: (start) => {
      if (options.dependencies) {
        installTiny(start.root);
        const ids = createTestIds(start.clock.now(), 1000n);
        preparer = new DependencyPreparer({
          store: start.store,
          home: dirname(start.root),
          now: start.clock.now,
          id: () => `prp_${ids('msg').slice(4)}`,
          projectPath: () => start.root,
        });
      }
      if (options.plan)
        start.store.transaction(() =>
          start.service.configure({
            taskId: start.taskId,
            crew: {
              name: 'Planned',
              members: [
                { role: 'orchestrator', selection },
                { role: 'builder', selection },
              ],
            },
            flightMode: 'balanced',
          }),
        );
    },
  });
  const { taskId, root } = thread;
  const identity = { name: 'Fixture owner', email: 'owner@example.invalid' };
  const accept = (branch: string, on = thread.service) =>
    act(thread.store, (effects) => on.accept({ taskId, branch }, identity, effects));
  const acceptance = (on = thread.service) => {
    const read = on.readAcceptance({ taskId });
    assert(read.data?.kind === 'acceptance');
    return read.data;
  };
  /** Resolves once no attempt holds the thread. Subscribe before the step that ends it. */
  const settled = (on = thread.service) =>
    next(thread, (event) => event.type === 'chat.thread' && !on.accepting(taskId));
  /** Resolves once an Accept's check runs. Subscribe before the Accept. */
  const running = () =>
    next(thread, (event) => {
      const run = event.type === 'chat.thread' && (event.payload as ChatThread).checks?.runs.at(-1);
      return !!run && run.trigger === 'accept' && run.status === 'running';
    });
  const branch = (name: string) => {
    try {
      return git(root, ['rev-parse', '--verify', `refs/heads/${name}`])
        .toString('utf8')
        .trim();
    } catch {
      return null;
    }
  };
  const tree = (commit: string) =>
    git(root, ['rev-parse', `${commit}^{tree}`])
      .toString('utf8')
      .trim();
  // Each attempt's copy and repository sit beside the scratch copy.
  const folder = dirname(thread.scratch);
  // A check that waits for a file outside its copy, so a test can act while it runs.
  const signal = join(mkdtempSync(join(tmpdir(), 'crewkite-signal-')), 'go');
  t.after(() => rmSync(dirname(signal), { recursive: true, force: true }));
  writeFileSync(
    join(thread.scratch, 'wait.mjs'),
    [
      "import { existsSync } from 'node:fs';",
      `const wait = () => (existsSync(${JSON.stringify(signal)}) ? undefined : setTimeout(wait, 10));`,
      'wait();',
    ].join('\n'),
  );
  const release = () => writeFileSync(signal, '');
  const hold = () => rmSync(signal, { force: true });
  return {
    ...thread,
    hold,
    accept,
    acceptance,
    settled,
    running,
    branch,
    tree,
    folder,
    release,
    preparer: prepared,
  };
}

// Claim: with a check on, Accept freezes the candidate, runs the check in a copy of exactly that
// tree, never in the scratch copy, and publishes the frozen tree once the check passes. The thread
// is held meanwhile: a plan cannot start, and a message waits and starts once the branch is written.
test('accept runs the required checks in a copy of the frozen tree and publishes it when they pass', {
  timeout: 30000,
}, async (t) => {
  const slice = (id: number) => ({
    id,
    title: `Part ${id}`,
    brief: `Do part ${id}.`,
    files: [],
    depends: [],
    difficulty: 'medium',
    readOnly: false,
  });
  const plan = { planId: 'p1', goal: 'Split it.', slices: [slice(1), slice(2)] };
  const thread = await acceptCopy(t, {
    plan: true,
    turns: [textReply(`\`\`\`json plan\n${JSON.stringify(plan)}\n\`\`\``), textReply('Next.')],
  });
  const { store, service, taskId, scratch, configure, accept, acceptance, settled, branch } =
    thread;
  const { tree, folder, read, send } = thread;
  assert.equal(read().thread.plan?.phase, 'proposed');
  writeFileSync(join(scratch, 'where.mjs'), 'console.log(process.cwd());\n');
  appendFileSync(join(scratch, 'net.mjs'), '// checked\n');
  configure({ checks: { add: 'node where.mjs' } });
  const done = settled();
  const answered = turnReaches(thread, 'done');
  const started = accept('feat/checked');
  assert.equal(send('Next step.').outcome, 'applied');
  assert.equal(read().thread.queued.length, 1);
  const planned = act(store, (effects) => service.runPlan({ taskId, planId: 'p1' }, effects));
  assert.deepEqual([planned.outcome, planned.reason], ['blocked', 'turn-running']);
  assert(started.data?.kind === 'acceptance');
  const frozen = started.data.current as AcceptanceAttempt;
  assert.deepEqual(
    [frozen.state, frozen.requiredChecks.map((check) => [check.checkId, check.status])],
    ['checking', [['custom:1', 'pending']]],
  );
  assert.equal(branch('feat/checked'), null);
  await done;
  const { current, last } = acceptance();
  const run = read().thread.checks?.runs.at(-1);
  assert.equal(current, null);
  assert.deepEqual(
    [last?.id, last?.state, last?.requiredChecks],
    [
      frozen.id,
      'published',
      [{ checkId: 'custom:1', label: 'node where.mjs', runId: run?.id, status: 'passed' }],
    ],
  );
  // The check ran in the attempt's own copy, which goes once the branch is written.
  assert.deepEqual([run?.trigger, run?.tail], ['accept', join(folder, `accept-${frozen.id}`)]);
  assert.deepEqual(
    readdirSync(folder).filter((name) => name.startsWith('accept-')),
    [],
  );
  const commit = branch('feat/checked') as string;
  assert.equal(last?.commit, commit);
  assert.equal(tree(commit), frozen.candidateTree);
  assert.equal(read().thread.base, commit);
  await answered;
  assert.deepEqual(
    read()
      .messages.slice(-3)
      .map((message) => message.text),
    ['Accepted 3 files to branch feat/checked.', 'Next step.', 'Next.'],
  );
  assert.equal(read().thread.queued.length, 0);
});

// Claim: a check that fails refuses the attempt, and so does one that changes a publishable file
// even when it exits zero. The refusal names the file, the change stays out of every branch, and
// the next Accept publishes the tree the person reviewed.
test('a failing check refuses check-failed, and a check that writes a file refuses check-mutated without publishing it', {
  timeout: 30000,
}, async (t) => {
  const { scratch, configure, accept, acceptance, settled, branch, tree, folder, read } =
    await acceptCopy(t);
  writeFileSync(join(scratch, 'gate.mjs'), 'process.exit(1);\n');
  writeFileSync(
    join(scratch, 'format.mjs'),
    [
      "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
      "mkdirSync('out');",
      "writeFileSync('out/report.txt', 'ok\\n');",
      "appendFileSync('net.mjs', '// formatted\\n');",
    ].join('\n'),
  );
  configure({ checks: { add: 'node gate.mjs' } });
  let done = settled();
  accept('feat/checked');
  await done;
  const failed = acceptance().last;
  assert.deepEqual(
    [failed?.state, failed?.refusal, failed?.requiredChecks.map((check) => check.status)],
    ['refused', 'check-failed', ['failed']],
  );
  assert.equal(
    read().messages.at(-1)?.text,
    'Accept to feat/checked stopped. node gate.mjs did not pass. Nothing was published.',
  );

  configure({ checks: { remove: 'custom:1' } });
  configure({ checks: { add: 'node format.mjs' } });
  done = settled();
  accept('feat/checked');
  await done;
  const mutated = acceptance().last as AcceptanceAttempt;
  assert.deepEqual(
    [
      mutated.state,
      mutated.refusal,
      mutated.requiredChecks[0].status,
      mutated.mutatedPaths,
      mutated.mutatedCount,
    ],
    ['refused', 'check-mutated', 'mutated', ['net.mjs', 'out/report.txt'], 2],
  );
  assert.equal(branch('feat/checked'), null);
  // The change stays in the attempt's copy for review. The scratch copy never sees it.
  const kept = join(folder, `accept-${mutated.id}`);
  assert.equal(readFileSync(join(kept, 'out/report.txt'), 'utf8'), 'ok\n');
  assert.equal(existsSync(join(scratch, 'out')), false);
  assert.doesNotMatch(readFileSync(join(scratch, 'net.mjs'), 'utf8'), /formatted/);

  // With the check off, Accept publishes the very tree the refused attempt checked.
  assert.equal(configure({ checks: { remove: 'custom:1' } }).outcome, 'applied');
  assert.equal(accept('feat/checked').outcome, 'applied');
  assert.equal(acceptance().last?.state, 'published');
  assert.equal(tree(branch('feat/checked') as string), mutated.candidateTree);
  assert.equal(existsSync(kept), false);
});

// Claim: Accept publishes only what the person chose and what the checks ran with. While its
// checks run, an edit to the copy waits. A hunk decision made meanwhile, or a dependency copy that
// goes stale or is prepared again meanwhile, refuses the attempt as a changed choice, though every
// check passed.
test('a hunk decision or dependency change while the checks run refuses choice-changed', {
  timeout: 30000,
}, async (t) => {
  const thread = await acceptCopy(t, { dependencies: true });
  const { store, service, taskId, scratch, configure, accept, acceptance, branch, root } = thread;
  appendFileSync(join(scratch, 'net.mjs'), '// checked\n');
  configure({ checks: { add: 'node wait.mjs' } });
  let started = thread.running();
  let done = thread.settled();
  accept('feat/checked');
  await started;
  const changes = service.readChanges({ taskId, limit: 500 });
  const hunk = 'files' in changes ? changes.files[0]?.hunks[0] : undefined;
  assert.equal('files' in changes && changes.files[0]?.path, 'net.mjs');
  assert(hunk);
  const discard = store.transaction(() =>
    service.discardHunk({ taskId, path: 'net.mjs', hunk: hunk.key }),
  );
  assert.deepEqual([discard.outcome, discard.reason], ['blocked', 'checks-running']);
  const decided = store.transaction(() =>
    service.decideHunk({ taskId, path: 'net.mjs', hunk: hunk.key, decision: 'accepted' }),
  );
  assert.equal(decided.outcome, 'applied');
  thread.release();
  await done;
  const { last } = acceptance();
  assert.deepEqual(
    [last?.state, last?.refusal, last?.requiredChecks.map((check) => check.status)],
    ['refused', 'choice-changed', ['passed']],
  );
  assert.match(last?.preparationId ?? '', /^prp_/);

  // The person installs a newer package while the checks run. The copy they ran with no longer
  // matches, and the attempt still settles.
  thread.hold();
  started = thread.running();
  done = thread.settled();
  accept('feat/checked');
  await started;
  const lock = join(root, 'package-lock.json');
  writeFileSync(lock, readFileSync(lock, 'utf8').replace('1.2.3', '1.2.4'));
  thread.release();
  await done;
  const stale = acceptance().last;
  assert.deepEqual(
    [stale?.state, stale?.refusal, stale?.requiredChecks.map((check) => check.status)],
    ['refused', 'choice-changed', ['passed']],
  );
  assert.notEqual(stale?.preparationId, last?.preparationId);
  assert.equal(branch('feat/checked'), null);

  // The copy is prepared again while the checks run. It keeps its record and its inputs, but the
  // tree the checks ran with is gone, so the attempt refuses all the same.
  writeFileSync(lock, readFileSync(lock, 'utf8').replace('1.2.4', '1.2.3'));
  thread.hold();
  started = thread.running();
  done = thread.settled();
  accept('feat/checked');
  await started;
  const checking = acceptance().current as AcceptanceAttempt;
  thread.clock.advance(1000);
  const again = await thread.preparer().prepare(taskId, 'acceptance', checking.id);
  thread.release();
  await done;
  assert.equal(again && again !== 'busy' && again.id, checking.preparationId);
  assert.deepEqual(
    [acceptance().last?.state, acceptance().last?.refusal],
    ['refused', 'choice-changed'],
  );
  assert.equal(branch('feat/checked'), null);
});

// Claim: an attempt that does not finish its checks never publishes. Cancel stops its check, a
// controller that stops mid-check leaves it unknown at startup, and only a new Accept, which runs
// the checks again, writes the branch.
test('a cancelled attempt and one cut off by a restart never publish, and a new Accept checks again', {
  timeout: 30000,
}, async (t) => {
  const thread = await acceptCopy(t);
  const { store, service, taskId, scratch, configure, accept, acceptance, branch, read } = thread;
  appendFileSync(join(scratch, 'net.mjs'), '// checked\n');
  configure({ checks: { add: 'node wait.mjs' } });
  const stopped = () =>
    next(
      thread,
      (event) =>
        event.type === 'chat.thread' &&
        (event.payload as ChatThread).checks?.runs.at(-1)?.status === 'stopped',
    );
  let started = thread.running();
  accept('feat/checked');
  await started;
  const cancelled = acceptance().current as AcceptanceAttempt;
  let ended = stopped();
  const cancel = store.transaction(() => service.cancelAcceptance({ attemptId: cancelled.id }));
  assert.equal(cancel.outcome, 'applied');
  await ended;
  assert.equal(
    read().messages.at(-1)?.text,
    'Accept to feat/checked stopped: you cancelled it. Nothing was published.',
  );

  started = thread.running();
  accept('feat/checked');
  await started;
  const cut = acceptance().current as AcceptanceAttempt;
  // The controller stops mid-check. The check stops with it and the attempt is left as it was.
  ended = stopped();
  service.close();
  await ended;
  assert.equal(acceptance().current?.state, 'checking');
  const restarted = thread.start();
  t.after(() => restarted.close());
  restarted.recover();
  assert.deepEqual([acceptance(restarted).current, acceptance(restarted).last?.id], [null, cut.id]);
  assert.deepEqual(
    readdirSync(thread.folder).filter((name) => name.startsWith(`accept-${cut.id}`)),
    [],
  );
  assert.equal(branch('feat/checked'), null);

  thread.release();
  const done = thread.settled(restarted);
  accept('feat/checked', restarted);
  await done;
  const attempts = store.acceptanceAttempts(taskId);
  const runs = read(restarted).thread.checks?.runs.filter((run) => run.trigger === 'accept');
  assert.deepEqual(
    attempts.map((attempt) => [attempt.state, attempt.commit !== null]),
    [
      ['cancelled', false],
      ['unknown', false],
      ['published', true],
    ],
  );
  assert.deepEqual(
    runs?.map((run) => run.status),
    ['stopped', 'stopped', 'passed'],
  );
  assert.equal(attempts[2].requiredChecks[0].runId, runs?.[2].id);
  assert.equal(branch('feat/checked'), attempts[2].commit);
});

// Claim: with a saved design system, Accept runs the design check first and refuses while a value
// in a changed file goes around the system. A value the person allowed no longer holds it back.
test('a value outside the saved design system refuses Accept until the person settles it', {
  timeout: 30000,
}, async (t) => {
  const { controller, adapter, task, run, send, command, draft, source } = await chat(t, [
    textReply('Styled the card.'),
  ]);
  const { projectId } = draft.payload as { projectId: string };
  const execute = (name: string, payload: object, revision?: number) =>
    controller.execute(command(name, payload, revision), 'local-owner');
  const system = {
    schema: 1,
    tokens: {
      color: { accent: { $type: 'color', $value: '#2f6feb' } },
      type: {},
      spacing: {},
      radius: {},
      shadow: {},
      motion: {},
    },
    components: [],
    rules: [],
  };
  const saved = await execute(
    'SaveDesignSystem',
    {
      projectId,
      path: 'design-system.json',
      body: system,
      expectedVersion: 0,
      confirm: 'explicit',
    },
    0,
  );
  assert.equal(saved.outcome, 'applied', saved.next);
  const done = turnReaches(controller, 'done');
  await send('Style the card.');
  await done;
  writeFileSync(
    join(adapter.requests[0].scratch.directory, 'card.css'),
    '.card { color: #ff0000; }\n',
  );
  const accept = () => run('AcceptChatChanges', { branch: 'feat/card' }, task.revision);
  const acceptance = async () => {
    const read = await run('ReadAcceptance', {});
    assert(read.data?.kind === 'acceptance');
    return read.data;
  };

  const refused = await accept();
  assert.deepEqual(
    [refused.outcome, refused.reason, refused.next],
    [
      'blocked',
      'design-system-findings',
      '1 value goes around the design system. Settle the values under Design, then accept. Nothing was published.',
    ],
  );
  const first = (await acceptance()).last;
  assert.deepEqual(
    [
      first?.state,
      first?.refusal,
      first?.requiredChecks.map((check) => [check.checkId, check.status]),
    ],
    ['refused', 'design-system-findings', [['design-system', 'failed']]],
  );
  assert.throws(() => git(source.directory, ['rev-parse', '--verify', 'refs/heads/feat/card']));

  const findings = await run('ReadDesignFindings', {});
  assert(findings.data?.kind === 'design-findings');
  const allowed = await execute(
    'ResolveDesignFinding',
    {
      findingId: findings.data.findings[0].id,
      action: 'allow-once',
      reason: 'The brand red stays.',
    },
    task.revision,
  );
  assert.equal(allowed.outcome, 'applied');
  const published = await accept();
  assert.equal(published.data?.kind, 'chat-acceptance');
  const second = (await acceptance()).last;
  assert.deepEqual(
    [second?.state, second?.requiredChecks.map((check) => [check.checkId, check.status])],
    ['published', [['design-system', 'passed']]],
  );
});

test('startup recovery lets a queued message start, and any other failed turn still holds the queue', {
  timeout: 30000,
}, async (t) => {
  const failed = chatFailure({
    stage: 'stream',
    kind: 'client-exit',
    message: 'The client exited.',
  });
  const rows = [
    {
      name: 'the controller stopped mid-turn',
      // The first turn never launches: the process ends after the command commits. The only
      // scripted turn belongs to the queued message.
      crash: true,
      turns: [[{ kind: 'text' as const, itemId: 'reply', chunks: ['Done.'] }]],
      started: true,
    },
    {
      name: 'the client failed on its own',
      crash: false,
      turns: [[{ kind: 'fail' as const, stopReason: 'error' as const, failure: failed }]],
      started: false,
    },
    {
      name: 'the client output repeats the restart text',
      crash: false,
      turns: [
        [
          {
            kind: 'fail' as const,
            stopReason: 'error' as const,
            failure: {
              ...chatFailure({
                stage: 'stream',
                kind: 'internal',
                message: 'The turn did not finish before the controller restarted.',
              }),
              detail: 'The client wrote this to its error output.',
            },
          },
        ],
      ],
      started: false,
    },
  ];
  for (const row of rows) {
    const thread = standalone(t, {
      adapters: new Map([
        ['openai', createScriptedChatAdapter({ family: 'openai', turns: row.turns })],
      ]),
    });
    const { store, taskId } = thread;
    const ended = turnReaches(thread, row.crash ? 'done' : 'failed');
    if (row.crash)
      store.transaction(() =>
        thread.service.sendMessage(
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
    else thread.send('Start the change.');
    assert.equal(thread.send('Then the totals.').outcome, 'applied', row.name);
    assert.deepEqual(
      thread.read().thread.queued.map((message) => message.text),
      ['Then the totals.'],
      row.name,
    );
    if (!row.crash) await ended;
    const restarted = thread.start();
    restarted.recover();
    if (row.crash) await ended;
    const after = thread.read(restarted);
    assert.equal(after.turns.length, row.started ? 2 : 1, row.name);
    assert.equal(after.turns[0].state, 'failed', row.name);
    assert.deepEqual(
      after.thread.queued.map((message) => message.text),
      row.started ? [] : ['Then the totals.'],
      row.name,
    );
    if (row.started) assert.equal(after.turns[1].state, 'done', row.name);
  }
});

test('a Local slice that cannot fit goes to the crew builder in balanced and glide with one line', {
  timeout: 60000,
}, async (t) => {
  const pick = (family: ChatFamily): ChatModelSelection => ({
    family,
    model: `${family}-model`,
    effort: 'default',
  });
  const reply = (text: string): ChatScriptStep => ({ kind: 'text', itemId: 'r', chunks: [text] });
  const plan = {
    planId: 'p1',
    goal: 'Add tax to the order total.',
    slices: [
      {
        id: 1,
        title: 'Apply tax',
        brief: 'Use TAX_RATE in orderTotal.',
        files: [],
        depends: [],
        difficulty: 'hard',
        readOnly: false,
      },
    ],
  };
  for (const flightMode of ['balanced', 'glide'] as const) {
    const now = createTestClock().now();
    const openai = createScriptedChatAdapter({
      family: 'openai',
      turns: [
        [reply(`\`\`\`json plan\n${JSON.stringify(plan)}\n\`\`\``)],
        [
          {
            kind: 'tool',
            callId: 'w',
            toolKind: 'edit',
            title: 'Write a.txt',
            write: { path: 'a.txt', content: 'taxed\n' },
          },
        ],
      ],
    });
    // The scripted LM Studio model: the compact brief alone leaves less than the reply floor.
    const prompts: string[] = [];
    const { model, calls } = fakeModel([], { now: Date.parse(now) }, (text) =>
      text.includes('Task: Use TAX_RATE in orderTotal.') ? 7000 : Math.ceil(text.length / 4),
    );
    const local = localChatAdapter({
      connect: async (request) => {
        prompts.push(request.prompt);
        return {
          model,
          contextLength: 8192,
          modelKey: 'local-model',
          fellBack: false,
          vision: false,
          files: { prepareImageBase64: async () => ({}) as never },
          dispose: async () => {},
        };
      },
    });
    const families = [familyEntry('openai', 10, null, now), familyEntry('local', 90, null, now)];
    const thread = standalone(t, {
      adapters: new Map<ChatFamily, ChatAdapter>([
        ['openai', openai],
        ['local', local],
      ]),
      catalog: () => ({ families }),
      localContext: () => 8192,
      localSliceFits: () => true,
    });
    const { store, service, taskId } = thread;
    const crew: ChatCrew = {
      name: 'Plan crew',
      members: [
        { role: 'builder', selection: pick('openai') },
        // Local is in the crew as its fixer, so it takes the hard slice.
        { role: 'fixer', selection: pick('local') },
        { role: 'orchestrator', selection: pick('openai') },
      ],
    };
    store.transaction(() => service.configure({ taskId, crew, flightMode }));
    const ended = next(
      thread,
      (event) =>
        event.type === 'conversation.entry' &&
        /^(Crew finished|Plan stopped)/.test((event.payload as { text: string }).text),
    );
    const proposed = next(
      thread,
      (event) =>
        event.type === 'chat.thread' && (event.payload as ChatThread).plan?.phase === 'proposed',
    );
    const free = settles(thread);
    thread.send('Add tax.', pick('openai'));
    if (flightMode === 'balanced') {
      await proposed;
      await free;
      assert.equal(
        act(store, (effects) => service.runPlan({ taskId, planId: 'p1' }, effects)).outcome,
        'applied',
        flightMode,
      );
    }
    await ended;
    const read = thread.read();
    const lines = read.messages.map((message) => message.text);
    assert.equal(lines.at(-1), 'Crew finished: 1 slice, 0 reviews, 0 fixes.', flightMode);
    assert.ok(
      lines.some((line) =>
        /^Slice 1 did not fit on Local, so the builder on OpenAI takes it\. This request takes [\d,]+ tokens of the Local model's 8,192 token context and leaves [\d,]+ for the reply, short of the 2,458 it needs\.$/.test(
          line,
        ),
      ),
      flightMode,
    );
    // Local got the compact brief and never ran the model; the builder ran the slice.
    assert.equal(calls.length, 0, flightMode);
    assert.match(
      prompts[0] ?? '',
      /Goal: Add tax to the order total\.\n\nTask: Use TAX_RATE in orderTotal\./,
    );
    assert.ok(!(prompts[0] ?? '').includes('assigned to'), flightMode);
    assert.deepEqual(
      read.turns.map((turn) => [turn.selection.family, turn.slice ?? null, turn.state]),
      [
        ['openai', null, 'done'],
        ['local', 1, 'failed'],
        ['openai', 1, 'done'],
      ],
      flightMode,
    );
    assert.equal(read.thread.plan?.slices[0]?.assignment?.family, 'openai', flightMode);
    const scratch = chatScratchDirectory(dirname(thread.root), taskId);
    assert.equal(readFileSync(join(scratch, 'a.txt'), 'utf8'), 'taxed\n', flightMode);
  }
});

// Claim: a turn whose completion is unknown fails once and keeps what it wrote. Nothing moves on
// from it: no retry, no handoff, no crew step and no plan step. A Local slice that ended this way
// is no fit failure, so the builder does not take it over.
test('a turn whose completion is unknown fails once, keeps its files and starts nothing after it', {
  timeout: 60000,
}, async (t) => {
  const pick = (family: ChatFamily): ChatModelSelection => ({
    family,
    model: `${family}-model`,
    effort: 'default',
  });
  const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];
  const plan = {
    planId: 'p1',
    goal: 'Add tax to the order total.',
    slices: [
      {
        id: 1,
        title: 'Apply tax',
        brief: 'Use TAX_RATE in orderTotal.',
        files: [],
        depends: [],
        difficulty: 'hard',
        readOnly: false,
      },
    ],
  };
  const rows = [
    {
      name: 'a Local builder turn in a crew',
      members: [{ role: 'builder', selection: pick('local') }] as ChatCrew['members'],
      send: pick('local'),
      expected: [['assistant', 'local', null, 'failed']],
      // OpenAI, Anthropic and Google requests.
      requests: [0, 0, 0],
      line: null,
    },
    {
      name: 'a Local plan slice',
      // Local is the fixer, so it takes the hard slice, and the builder is on another family.
      members: [
        { role: 'builder', selection: pick('openai') },
        { role: 'fixer', selection: pick('local') },
        { role: 'orchestrator', selection: pick('openai') },
      ] as ChatCrew['members'],
      send: pick('openai'),
      expected: [
        ['orchestrator', 'openai', null, 'done'],
        ['assistant', 'local', 1, 'failed'],
      ],
      requests: [1, 0, 0],
      line: 'Plan stopped: slice 1 failed. Run it again from the plan card.',
    },
  ] as const;
  for (const row of rows) {
    const now = createTestClock().now();
    // The Local model writes a file, then its last round reports no stop reason.
    const { model } = fakeModel(
      [
        { steps: [{ call: 'write', args: { path: 'a.txt', content: 'half done\n' } }], stats: {} },
        { steps: [{ text: 'Part of it is in.' }], stats: { stopReason: undefined } },
      ],
      { now: Date.parse(now) },
    );
    const scratches: string[] = [];
    const local = localChatAdapter({
      connect: async (request) => {
        scratches.push(request.scratch.directory);
        return {
          model,
          contextLength: 8192,
          modelKey: 'local-model',
          fellBack: false,
          vision: false,
          files: { prepareImageBase64: async () => ({}) as never },
          dispose: async () => {},
        };
      },
    });
    const openai = createScriptedChatAdapter({
      family: 'openai',
      turns: [reply(`\`\`\`json plan\n${JSON.stringify(plan)}\n\`\`\``)],
    });
    const anthropic = createScriptedChatAdapter({
      family: 'anthropic',
      turns: [reply('Clean.\nFindings: 0')],
    });
    const google = createScriptedChatAdapter({ family: 'google', turns: [reply('It holds.')] });
    const adapters = new Map<ChatFamily, ChatAdapter>([
      ['openai', openai],
      ['anthropic', anthropic],
      ['google', google],
      ['local', local],
    ]);
    const families = [
      familyEntry('openai', 10, null, now),
      familyEntry('anthropic', 50, null, now),
      familyEntry('google', 50, null, now),
      familyEntry('local', 90, null, now),
    ];
    const thread = standalone(t, {
      adapters,
      catalog: () => ({ families }),
      localContext: () => 8192,
      localSliceFits: () => true,
    });
    const { store, service, taskId } = thread;
    const crew: ChatCrew = {
      name: 'Crew',
      members: [...row.members, { role: 'reviewer', selection: pick('anthropic') }],
    };
    // Glide turns automatic handoff on, so a limit here would move the work. Local writes inside
    // its copy without asking under allow-edits.
    store.transaction(() =>
      service.configure({ taskId, crew, flightMode: 'glide', permissionPolicy: 'allow-edits' }),
    );
    const settled = next(thread, (event) => {
      if (event.type !== 'chat.turn') return false;
      const value = event.payload as ChatTurn;
      return value.selection.family === 'local' && ['done', 'failed'].includes(value.state);
    });
    thread.send('Add tax.', row.send);
    const turn = (await settled).payload as ChatTurn;
    // Every step after a settled turn runs before the turn's event reaches this test.
    const read = thread.read();
    assert.equal(read.thread.autoHandoff, true, row.name);
    assert.deepEqual(
      read.turns.map((value) => [
        value.role,
        value.selection.family,
        value.slice ?? null,
        value.state,
      ]),
      row.expected,
      row.name,
    );
    assert.equal(turn.failure?.kind, 'completion-unknown', row.name);
    assert.equal(read.thread.activeTurnId, null, row.name);
    const lines = read.messages.map((message) => message.text);
    assert.ok(lines.includes(`${turn.failure?.message} ${turn.failure?.nextAction}`), row.name);
    if (row.line) assert.equal(lines.at(-1), row.line, row.name);
    assert.deepEqual(
      [openai, anthropic, google].map((adapter) => adapter.requests.length),
      row.requests,
      row.name,
    );
    assert.equal(scratches.length, 1, row.name);
    assert.equal(readFileSync(join(scratches[0], 'a.txt'), 'utf8'), 'half done\n', row.name);
  }
});

/** A catalog entry with a credit reading and the Allow credit spending switch. */
function creditEntry(
  family: ChatFamily,
  percent: number,
  creditSpending: boolean | undefined,
  observedAt: string,
): ChatCatalogRead['families'][number] {
  return {
    ...familyEntry(family, percent, null, observedAt),
    ...(creditSpending === undefined
      ? {}
      : {
          creditSpending,
          credits: { state: 'available', balance: '5', limitReached: false, observedAt },
        }),
  };
}

function creditAdapters() {
  const reply = (family: ChatFamily) =>
    createScriptedChatAdapter({
      family,
      turns: [[{ kind: 'text', itemId: 'r', chunks: [`${family} answered.`] }]],
    });
  return new Map((['openai', 'anthropic', 'google', 'local'] as const).map((f) => [f, reply(f)]));
}

test('an exhausted family with credit spending off hands the turn on before it starts', {
  timeout: 30000,
}, async (t) => {
  const now = createTestClock().now();
  const paused =
    'OpenAI is out of included allowance and credit spending is off. Turn credit spending on in Settings or pick another provider.';
  const pick = (family: ChatFamily): ChatModelSelection => ({
    family,
    model: `${family}-model`,
    effort: 'default',
  });
  const cases = [
    {
      claim: 'a single thread moves to the next family with allowance',
      families: [creditEntry('openai', 0, false, now), creditEntry('google', 50, undefined, now)],
      send: pick('openai'),
      turns: ['google'],
      line: 'Continued on Google from OpenAI. Reason: usage limit reached.',
    },
    {
      claim: 'the switch on lets the turn start there',
      families: [creditEntry('openai', 0, true, now), creditEntry('google', 50, undefined, now)],
      send: pick('openai'),
      turns: ['openai'],
      line: 'Fix the rounding.',
    },
    {
      claim: 'Local is never gated',
      families: [
        creditEntry('local', 0, undefined, now),
        creditEntry('google', 50, undefined, now),
      ],
      send: pick('local'),
      turns: ['local'],
      line: 'Fix the rounding.',
    },
    {
      claim: 'with no taker the turn does not start',
      families: [creditEntry('openai', 0, false, now), creditEntry('google', 0, undefined, now)],
      send: pick('openai'),
      turns: [],
      line: paused,
    },
    {
      claim: 'a side question gets the line and never moves the thread',
      families: [creditEntry('openai', 0, false, now), creditEntry('google', 50, undefined, now)],
      ask: true,
      turns: [],
      line: paused,
    },
  ];
  for (const row of cases) {
    const thread = standalone(t, {
      adapters: creditAdapters(),
      catalog: () => ({ families: row.families }),
    });
    const { store, service, taskId } = thread;
    const done = turnReaches(thread, 'done');
    if ('ask' in row)
      act(store, (effects) =>
        service.ask({ taskId, family: 'openai', model: 'openai-model', question: 'Why?' }, effects),
      );
    else thread.send('Fix the rounding.', row.send);
    if (row.turns.length) await done;
    const read = thread.read();
    assert.deepEqual(
      read.turns.map((turn) => turn.selection.family),
      row.turns,
      row.claim,
    );
    const lines = read.messages.map((message) => message.text);
    assert.equal(lines.at(row.turns.length ? -2 : -1), row.line, row.claim);
    if (row.turns.length) assert.equal(read.thread.selection?.family, row.turns[0], row.claim);
    else assert.equal(read.thread.activeTurnId, null, row.claim);
  }
});

// Claim: a send that opens no turn answers blocked with the refusal's reason and next step, so a
// caller never waits for a turn that will not come.
test('a send whose only provider has credit spending off is refused and opens no turn', async (t) => {
  const now = createTestClock().now();
  const thread = standalone(t, {
    adapters: creditAdapters(),
    catalog: () => ({ families: [creditEntry('openai', 0, false, now)] }),
  });
  const result = thread.send('Fix the rounding.', {
    family: 'openai',
    model: 'openai-model',
    effort: 'default',
  });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'credits-paused');
  assert.equal(result.next, 'Turn credit spending on in Settings or pick another provider.');
  const read = thread.read();
  assert.deepEqual(read.turns, []);
  assert.equal(read.thread.activeTurnId, null);
});

test('a crew step on a family whose credits are paused runs on the next family', {
  timeout: 30000,
}, async (t) => {
  const now = createTestClock().now();
  const pick = (family: ChatFamily): ChatModelSelection => ({
    family,
    model: `${family}-model`,
    effort: 'default',
  });
  const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];
  const adapters = new Map([
    ['openai', createScriptedChatAdapter({ family: 'openai', turns: [reply('Built.')] })],
    ['anthropic', createScriptedChatAdapter({ family: 'anthropic', turns: [] })],
    [
      'google',
      createScriptedChatAdapter({
        family: 'google',
        turns: [reply('Clean.\nFindings: 0'), reply('It holds.')],
      }),
    ],
  ] as const);
  const families = [
    creditEntry('openai', 10, false, now),
    creditEntry('anthropic', 0, false, now),
    creditEntry('google', 50, undefined, now),
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
  const ended = next(
    thread,
    (event) =>
      event.type === 'conversation.entry' &&
      /^Crew (finished|stopped)/.test((event.payload as { text: string }).text),
  );
  thread.send('Fix the rounding.', pick('openai'));
  await ended;
  const read = thread.read();
  assert.deepEqual(
    read.turns.map((turn) => [turn.role, turn.selection.family]),
    [
      ['assistant', 'openai'],
      ['reviewer', 'google'],
      ['challenger', 'google'],
    ],
  );
  assert.ok(
    read.messages.some(
      (message) =>
        message.text === 'Continued on Google from Anthropic. Reason: usage limit reached.',
    ),
  );
  assert.equal(adapters.get('anthropic')?.requests.length, 0);
  // The step borrowed a model. The thread keeps its own pick.
  assert.equal(read.thread.selection?.family, 'openai');
});

test('a turn that ends with its allowance used up and credits off says so and the next turn moves', {
  timeout: 30000,
}, async (t) => {
  const now = createTestClock().now();
  const families = [
    creditEntry('openai', 40, false, now),
    creditEntry('google', 50, undefined, now),
  ];
  const adapters = creditAdapters();
  const openai = adapters.get('openai');
  assert.ok(openai);
  // The allowance runs out while the turn runs, and the provider keeps going on credits.
  adapters.set('openai', {
    ...openai,
    startTurn(request, emit) {
      families[0] = creditEntry('openai', 0, false, now);
      return openai.startTurn(request, emit);
    },
  });
  const thread = standalone(t, { adapters, catalog: () => ({ families }) });
  const first = turnReaches(thread, 'done');
  thread.send('Fix the rounding.');
  await first;
  assert.deepEqual(
    thread
      .read()
      .messages.slice(-2)
      .map((message) => message.text),
    [
      'openai answered.',
      'OpenAI reached its included allowance during this turn. Credit spending is off, so the next turn moves to another provider.',
    ],
  );
  const second = turnReaches(thread, 'done');
  thread.send('Then the totals.');
  await second;
  assert.deepEqual(
    thread.read().turns.map((turn) => [turn.state, turn.selection.family]),
    [
      ['done', 'openai'],
      ['done', 'google'],
    ],
  );
});

test('a writing rule switch round trips through its command', { timeout: 30000 }, async (t) => {
  const { controller, command } = await chat(t, []);
  const enabled = async () => {
    const read = await controller.execute(command('ReadWritingRules', {}), 'local-owner');
    assert(read.data?.kind === 'writing-rules');
    return read.data.rules.find((rule) => rule.id === 'search-first')?.enabled;
  };
  assert.equal(await enabled(), true);
  const set = await controller.execute(
    command('SetWritingRule', { ruleId: 'search-first', enabled: false }, 0),
    'local-owner',
  );
  assert.equal(set.outcome, 'applied', set.reason);
  assert.equal(await enabled(), false);
});

test('the credit spending switch is off by default and round trips through its command', {
  timeout: 30000,
}, async (t) => {
  const { controller, command } = await chat(t, []);
  const catalog = async () =>
    (
      (await controller.execute(command('ReadChatCatalog', {}), 'local-owner'))
        .data as ChatCatalogRead
    ).families.map((entry) => [entry.family, entry.creditSpending]);
  const set = (family: string, allowed: boolean) =>
    controller.execute(command('SetCreditSpending', { family, allowed }, 0), 'local-owner');
  assert.deepEqual(await catalog(), [
    ['openai', false],
    ['anthropic', false],
    ['google', undefined],
    ['local', undefined],
  ]);
  assert.equal((await set('openai', true)).outcome, 'applied');
  assert.deepEqual((await catalog()).slice(0, 2), [
    ['openai', true],
    ['anthropic', false],
  ]);
  assert.equal((await set('openai', false)).outcome, 'applied');
  assert.deepEqual((await catalog())[0], ['openai', false]);
  // Google reports no credit state, so it has no switch to set.
  assert.notEqual((await set('google', true)).outcome, 'applied');
});

// Claim: work that moves to a family on its own starts on the model this thread last ran there,
// else on the person's Settings default for that family, else on the client's own default. A
// Settings choice the family no longer lists falls back to the client's default.
test('an automatic handoff starts on the thread or Settings model, never silently on the client default', {
  timeout: 30000,
}, async (t) => {
  const now = createTestClock().now();
  const google = {
    ...creditEntry('google', 50, undefined, now),
    models: [
      {
        model: 'google-model',
        label: 'Flash',
        efforts: ['default', 'high'],
        defaultEffort: 'default',
      },
      {
        model: 'google-argon',
        label: 'Argon',
        efforts: ['default', 'high'],
        defaultEffort: 'high',
      },
    ],
  } as ChatCatalogRead['families'][number];
  const cases = [
    {
      claim: 'the Settings choice wins over the client default',
      chosen: 'google-argon',
      model: 'google-argon',
      effort: 'high',
    },
    {
      claim: 'with no choice the client default runs',
      chosen: null,
      model: 'google-model',
      effort: 'default',
    },
    {
      claim: 'a choice the family dropped falls back',
      chosen: 'google-gone',
      model: 'google-model',
      effort: 'default',
    },
  ];
  for (const row of cases) {
    const thread = standalone(t, {
      adapters: creditAdapters(),
      catalog: () => ({ families: [creditEntry('openai', 0, false, now), google] }),
      familyModel: (family) => (family === 'google' && row.chosen ? { model: row.chosen } : null),
    });
    const done = turnReaches(thread, 'done');
    thread.send('Fix the rounding.', {
      family: 'openai',
      model: 'openai-model',
      effort: 'default',
    });
    await done;
    const [turn] = thread.read().turns;
    assert.deepEqual(
      [turn?.selection.family, turn?.selection.model, turn?.selection.effort],
      ['google', row.model, row.effort],
      row.claim,
    );
  }
  // The model this thread last ran on Google beats the Settings choice.
  const thread = standalone(t, {
    adapters: creditAdapters(),
    catalog: () => ({ families: [creditEntry('openai', 0, false, now), google] }),
    familyModel: () => ({ model: 'google-argon' }),
  });
  const first = turnReaches(thread, 'done');
  thread.send('Look first.', { family: 'google', model: 'google-model', effort: 'high' });
  await first;
  const second = turnReaches(thread, 'done');
  thread.send('Fix the rounding.', { family: 'openai', model: 'openai-model', effort: 'default' });
  await second;
  const last = thread.read().turns.at(-1);
  assert.deepEqual(
    [last?.selection.family, last?.selection.model, last?.selection.effort],
    ['google', 'google-model', 'high'],
    'the thread keeps its own Google model',
  );
});

// Claim: the handoff ranks a family on the model that will run there. A used-up default model must
// not drop a family whose running model has allowance, and a default with room must not keep a
// family whose running model is used up.
test('an automatic handoff ranks each family on the model that will run', {
  timeout: 30000,
}, async (t) => {
  const now = createTestClock().now();
  const window = (windowId: string, percent: number) => ({
    windowId,
    label: windowId,
    percent,
    resetsAt: null,
    observedAt: now,
  });
  const google = (running: number, other: number) =>
    ({
      ...creditEntry('google', 50, undefined, now),
      models: [
        { model: 'google-flash', label: 'Flash', efforts: ['default'], defaultEffort: 'default' },
        { model: 'google-argon', label: 'Argon', efforts: ['default'], defaultEffort: 'default' },
      ],
      defaultModel: 'google-flash',
      remaining: [window('flash-weekly', other), window('argon-weekly', running)],
    }) as ChatCatalogRead['families'][number];
  const cases = [
    {
      claim: 'a used-up default does not drop the running model',
      running: 60,
      other: 0,
      family: 'google',
    },
    {
      claim: 'a default with room does not rescue a used-up running model',
      running: 0,
      other: 60,
      family: 'local',
    },
  ];
  for (const row of cases) {
    const thread = standalone(t, {
      adapters: creditAdapters(),
      catalog: () => ({
        families: [
          creditEntry('openai', 0, false, now),
          google(row.running, row.other),
          familyEntry('local', 10, null, now),
        ],
      }),
      familyModel: () => ({ model: 'google-argon' }),
    });
    const done = turnReaches(thread, 'done');
    thread.send('Fix the rounding.', {
      family: 'openai',
      model: 'openai-model',
      effort: 'default',
    });
    await done;
    assert.equal(thread.read().turns[0]?.selection.family, row.family, row.claim);
  }
});

// Claim: a plan slice passes the credit switch the way a single turn does. A slice whose family is
// out of included allowance with credits off moves to the family a handoff picks, and that family
// never gets a request it would pay for.
test('a plan slice on a family whose credits are paused runs on the next family', {
  timeout: 60000,
}, async (t) => {
  const now = createTestClock().now();
  const pick = (family: ChatFamily): ChatModelSelection => ({
    family,
    model: `${family}-model`,
    effort: 'default',
  });
  const reply = (text: string): ChatScriptStep => ({ kind: 'text', itemId: 'r', chunks: [text] });
  const plan = {
    planId: 'p1',
    goal: 'Add tax to the order total.',
    slices: [
      {
        id: 1,
        title: 'Apply tax',
        brief: 'Use TAX_RATE in orderTotal.',
        files: [],
        depends: [],
        difficulty: 'hard',
        readOnly: false,
      },
    ],
  };
  const write: ChatScriptStep = {
    kind: 'tool',
    callId: 'w',
    toolKind: 'edit',
    title: 'Write a.txt',
    write: { path: 'a.txt', content: 'taxed\n' },
  };
  const adapters = new Map<ChatFamily, ChatAdapter>([
    [
      'openai',
      createScriptedChatAdapter({
        family: 'openai',
        turns: [[reply(`\`\`\`json plan\n${JSON.stringify(plan)}\n\`\`\``)]],
      }),
    ],
    ['anthropic', createScriptedChatAdapter({ family: 'anthropic', turns: [] })],
    ['google', createScriptedChatAdapter({ family: 'google', turns: [[write]] })],
  ]);
  // Anthropic has allowance when the plan is made and runs out before the slice starts.
  const families = [
    creditEntry('openai', 40, false, now),
    creditEntry('anthropic', 50, false, now),
    creditEntry('google', 50, undefined, now),
  ];
  const thread = standalone(t, { adapters, catalog: () => ({ families }) });
  const { store, service, taskId } = thread;
  const crew: ChatCrew = {
    name: 'Plan crew',
    members: [
      { role: 'builder', selection: pick('openai') },
      // The fixer takes the hard slice, and its family has no allowance left.
      { role: 'fixer', selection: pick('anthropic') },
      { role: 'orchestrator', selection: pick('openai') },
    ],
  };
  store.transaction(() => service.configure({ taskId, crew, flightMode: 'balanced' }));
  const proposed = next(
    thread,
    (event) =>
      event.type === 'chat.thread' && (event.payload as ChatThread).plan?.phase === 'proposed',
  );
  const free = settles(thread);
  const ended = next(
    thread,
    (event) =>
      event.type === 'conversation.entry' &&
      /^(Crew finished|Plan stopped|Plan paused)/.test((event.payload as { text: string }).text),
  );
  thread.send('Add tax.', pick('openai'));
  await proposed;
  await free;
  assert.equal(thread.read().thread.plan?.slices[0]?.assignment?.family, 'anthropic');
  families[1] = creditEntry('anthropic', 0, false, now);
  assert.equal(
    act(store, (effects) => service.runPlan({ taskId, planId: 'p1' }, effects)).outcome,
    'applied',
  );
  await ended;
  const read = thread.read();
  const anthropic = adapters.get('anthropic') as ReturnType<typeof createScriptedChatAdapter>;
  assert.equal(anthropic.requests.length, 0, 'no paid request');
  assert.deepEqual(
    read.turns.filter((turn) => turn.slice === 1).map((turn) => turn.selection.family),
    ['google'],
  );
  assert.ok(
    read.messages.some(
      (message) =>
        message.text === 'Slice 1 continued on Google from Anthropic. Reason: usage limit reached.',
    ),
  );
});

// Claim: Run tests runs the project's test command in the scratch copy with no model turn, asks
// first unless the thread allows the command, keeps the run with the thread's checks with its
// real exit status and output, writes one result line, and refuses a second start while the first
// runs. The Tests switch stays as it was.
test('run tests runs the test command alone and keeps its real result', {
  timeout: 60000,
}, async (t) => {
  const thread = standalone(t, {
    adapters: new Map([
      ['openai', createScriptedChatAdapter({ family: 'openai', turns: [textReply('Built.')] })],
    ]),
  });
  const { store, service, taskId } = thread;
  const done = turnReaches(thread, 'done');
  thread.send('Build it.');
  const built = await done;
  const scratch = chatScratchDirectory(dirname(thread.root), taskId);
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node gate.mjs' } }),
  );
  writeFileSync(
    join(scratch, 'gate.mjs'),
    "import { existsSync } from 'node:fs';\nif (existsSync('ok')) { console.log('8 of 8 passed'); process.exit(0); }\nconsole.log('1 of 8 passed');\nprocess.exitCode = 1;\n",
  );
  store.transaction(() => service.configure({ taskId, checks: { refresh: true } }));
  const tests = thread.read().thread.checks?.items.filter((item) => item.kind === 'test') ?? [];
  assert.equal(tests.length, 1, 'the package.json test script is the test check');
  assert.equal(tests[0]?.enabled, false, 'the Tests switch starts off');
  const turns = thread.read().turns.length;
  const line = (pattern: RegExp) =>
    next(
      thread,
      (event) =>
        event.type === 'conversation.entry' &&
        pattern.test((event.payload as { text?: string }).text ?? ''),
    );

  // The thread asks each time, so the first run waits for the person's answer.
  const failedLine = line(/^Tests failed: /);
  assert.equal(act(store, (fx) => service.runTests({ taskId }, fx)).outcome, 'applied');
  const ask = thread.read().thread.checks?.ask;
  assert.equal(ask?.trigger, 'manual');
  assert.deepEqual(
    ask?.commands.map((command) => command.label),
    tests.map((item) => item.label),
  );
  assert.equal(
    act(store, (fx) => service.runTests({ taskId }, fx)).reason,
    'checks-running',
    'a second start waits while the question is open',
  );
  act(store, (fx) =>
    service.resolvePermission(
      { taskId, turnId: built.id, requestId: ask?.requestId ?? '', choice: 'allow-thread' },
      fx,
    ),
  );
  const failed = await failedLine;
  assert.match(
    (failed.payload as { text: string }).text,
    /\(exit 1\)\. The output is under Checks\.$/,
  );
  const firstRun = thread.read().thread.checks?.runs.at(-1);
  assert.deepEqual(
    [firstRun?.trigger, firstRun?.status, firstRun?.exitCode],
    ['manual', 'failed', 1],
  );
  assert.match(firstRun?.tail ?? '', /1 of 8 passed/);

  // Allowed for the thread now: the next run starts at once and passes.
  writeFileSync(join(scratch, 'ok'), '');
  const passedLine = line(/^Tests passed: /);
  assert.equal(act(store, (fx) => service.runTests({ taskId }, fx)).outcome, 'applied');
  assert.equal(thread.read().thread.checks?.ask, null, 'no question the second time');
  assert.equal(
    act(store, (fx) => service.runTests({ taskId }, fx)).reason,
    'checks-running',
    'no duplicate start',
  );
  const passed = await passedLine;
  assert.match((passed.payload as { text: string }).text, /\(exit 0\)\.$/);
  const secondRun = thread.read().thread.checks?.runs.at(-1);
  assert.deepEqual([secondRun?.status, secondRun?.exitCode], ['passed', 0]);
  assert.match(secondRun?.tail ?? '', /8 of 8 passed/);

  const after = thread.read();
  assert.equal(after.turns.length, turns, 'no model turn ran');
  assert.equal(
    after.thread.checks?.items.find((item) => item.kind === 'test')?.enabled,
    false,
    'the Tests switch is untouched',
  );
});

// Claim (Part 14, U22): with several test commands, the thread line names the command that
// failed and its own exit status, never a later command that passed. Each run keeps its own
// result and output under Checks, one line is written per run, and the guards still hold.
test('run tests names the failing command when a later test command passes', {
  timeout: 60000,
}, async (t) => {
  const thread = standalone(t, {
    adapters: new Map([
      ['openai', createScriptedChatAdapter({ family: 'openai', turns: [textReply('Built.')] })],
    ]),
  });
  const { store, service, taskId } = thread;
  const done = turnReaches(thread, 'done');
  thread.send('Build it.');
  const built = await done;
  // The polyglot fixture of the Part 14 repro, file for file.
  const scratch = chatScratchDirectory(dirname(thread.root), taskId);
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({
      name: 'p14-polyglot-fixture',
      private: true,
      scripts: { test: 'node gate.mjs' },
    }),
  );
  writeFileSync(
    join(scratch, 'gate.mjs'),
    "console.log('synthetic npm failure');\nprocess.exitCode = 1;\n",
  );
  writeFileSync(join(scratch, 'Makefile'), 'test:\n\t@echo synthetic make success\n');
  store.transaction(() => service.configure({ taskId, checks: { refresh: true } }));
  const tests = thread.read().thread.checks?.items.filter((item) => item.kind === 'test') ?? [];
  assert.deepEqual(
    tests.map((item) => [item.command, item.enabled]),
    [
      ['npm run test', false],
      ['make test', false],
    ],
  );
  const turns = thread.read().turns.length;
  const lines = () =>
    thread
      .read()
      .messages.filter((message) => /^Tests /.test((message as { text?: string }).text ?? ''));
  const failedLine = next(
    thread,
    (event) =>
      event.type === 'conversation.entry' &&
      /^Tests failed: /.test((event.payload as { text?: string }).text ?? ''),
  );
  assert.equal(act(store, (fx) => service.runTests({ taskId }, fx)).outcome, 'applied');
  const ask = thread.read().thread.checks?.ask;
  assert.equal(
    act(store, (fx) => service.runTests({ taskId }, fx)).reason,
    'checks-running',
    'a second start waits while the question is open',
  );
  act(store, (fx) =>
    service.resolvePermission(
      { taskId, turnId: built.id, requestId: ask?.requestId ?? '', choice: 'allow' },
      fx,
    ),
  );
  assert.equal(
    act(store, (fx) => service.runTests({ taskId }, fx)).reason,
    'checks-running',
    'a second start waits while the commands run',
  );
  assert.equal(
    (await failedLine.then((event) => event.payload as { text: string })).text,
    'Tests failed: npm run test (exit 1), 1 of 2 commands failed. The output is under Checks.',
  );
  const runs = thread.read().thread.checks?.runs.slice(-2) ?? [];
  assert.deepEqual(
    runs.map((run) => [run.command, run.trigger, run.status, run.exitCode]),
    [
      ['npm run test', 'manual', 'failed', 1],
      ['make test', 'manual', 'passed', 0],
    ],
  );
  assert.match(runs[0]?.tail ?? '', /synthetic npm failure/);
  assert.match(runs[1]?.tail ?? '', /synthetic make success/);
  assert.equal(lines().length, 1, 'one thread line for the run');
  const after = thread.read();
  assert.equal(after.turns.length, turns, 'no model turn ran');
  assert.deepEqual(
    after.thread.checks?.items.filter((item) => item.kind === 'test').map((item) => item.enabled),
    [false, false],
    'the Tests switches are untouched',
  );
});

// Claim: Run tests says why it cannot start: no test command, or a turn still running.
test('run tests explains when it cannot start', { timeout: 30000 }, async (t) => {
  const thread = standalone(t, {
    adapters: new Map([
      ['openai', createScriptedChatAdapter({ family: 'openai', turns: [textReply('Built.')] })],
    ]),
  });
  const { store, service, taskId } = thread;
  const done = turnReaches(thread, 'done');
  thread.send('Build it.');
  await done;
  store.transaction(() => service.configure({ taskId, checks: { refresh: true } }));
  const refused = act(store, (fx) => service.runTests({ taskId }, fx));
  assert.deepEqual([refused.outcome, refused.reason], ['blocked', 'no-test-command']);
  assert.match(refused.next ?? '', /Add one under Project checks/);
});

// A start at reset waits for the recorded reset time, which the test clock and a captured timer
// stand in for. Usage reads come from the test, so the window opens only when the test says so.
function resetThread(t: TestContext, later: ChatScriptStep[][] = []) {
  const limit = chatFailure({
    stage: 'stream',
    kind: 'usage-limit',
    message: 'The weekly limit is reached.',
  });
  const stop: ChatScriptStep[] = [{ kind: 'fail', stopReason: 'limit', failure: limit }];
  const adapters = new Map([
    [
      'anthropic',
      createScriptedChatAdapter({
        family: 'anthropic',
        turns: [stop, ...later, [{ kind: 'text', itemId: 'reply', chunks: ['Back at it.'] }]],
      }),
    ],
  ] as const);
  const now = createTestClock().now();
  const inHours = (count: number) => new Date(Date.parse(now) + count * 3_600_000).toISOString();
  const reading = { percent: 0 as number | null, resetsAt: inHours(5) as string | null };
  const timers: { work: () => void; ms: number; cancelled: boolean }[] = [];
  const refreshed: ChatFamily[] = [];
  const on = standalone(t, {
    adapters,
    catalog: () => ({
      families: [familyEntry('anthropic', reading.percent, reading.resetsAt, now)],
    }),
    schedule: (work, ms) => {
      const timer = { work, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    refreshUsage: async (family) => {
      refreshed.push(family);
    },
  });
  const anthropic = { family: 'anthropic', model: 'anthropic-model', effort: 'default' } as const;
  const stopped = turnReaches(on, 'failed');
  on.send('Fix the rounding.', anthropic);
  const schedule = (startAtReset: boolean) =>
    on.store.transaction(() => on.service.configure({ taskId: on.taskId, startAtReset }));
  return { ...on, reading, timers, refreshed, inHours, stopped, schedule };
}

test('a limit stop runs again at its recorded reset once usage reads open, and a restart keeps the wait', {
  timeout: 30000,
}, async (t) => {
  const on = resetThread(t);
  await on.stopped;
  const [first] = on.read().turns;
  assert.equal(on.schedule(true).outcome, 'applied');
  assert.deepEqual(on.read().thread.startAt, {
    turnId: first.id,
    family: 'anthropic',
    at: on.reading.resetsAt,
  });

  // The controller restarts. The wait is in the thread record, so the new service arms it again.
  const restarted = on.start();
  restarted.recover();
  const timer = on.timers.at(-1);
  assert.equal(timer?.ms, 5 * 3_600_000);

  on.clock.advance(5 * 3_600_000);
  on.reading.percent = 80;
  const done = turnReaches(on, 'done');
  timer?.work();
  const second = await done;
  const thread = on.read(restarted);
  assert.deepEqual(on.refreshed, ['anthropic']);
  assert.equal(thread.thread.startAt, undefined);
  assert.equal(second.selection.family, 'anthropic');
  // The same message ran again. The thread holds it once.
  assert.equal(second.userMessageId, first.userMessageId);
  assert.equal(thread.messages.filter((message) => message.text === 'Fix the rounding.').length, 1);
});

// Claim: a side question runs beside the thread and leaves its waiting start alone. When the
// reset comes, the message the limit stopped runs again.
test('a side question asked while a start waits for the reset leaves the start in place', {
  timeout: 30000,
}, async (t) => {
  const on = resetThread(t, [[{ kind: 'text', itemId: 'side', chunks: ['It rounds half up.'] }]]);
  await on.stopped;
  const [first] = on.read().turns;
  assert.equal(on.schedule(true).outcome, 'applied');
  const answered = turnReaches(on, 'done');
  const asked = act(on.store, (effects) =>
    on.service.ask(
      { taskId: on.taskId, family: 'anthropic', model: 'anthropic-model', question: 'Why?' },
      effects,
    ),
  );
  assert.equal(asked.outcome, 'applied', JSON.stringify(asked));
  assert.equal((await answered).role, 'ask');
  assert.equal(on.read().thread.startAt?.turnId, first.id);

  on.clock.advance(5 * 3_600_000);
  on.reading.percent = 80;
  const rerun = turnReaches(on, 'done');
  on.timers.at(-1)?.work();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    on.read().messages.filter((message) => /start cancelled/.test(message.text)),
    [],
  );
  const second = await rerun;
  assert.equal(second.userMessageId, first.userMessageId);
  assert.equal(on.read().thread.startAt, undefined);
});

// Claim: a usage reading that cannot be had says so once and tries again every 15 minutes, for a
// day at most. It never writes a line per try, and after a day the wait ends with one line.
test('an unreadable usage reading at the reset says so once and gives up after a day', {
  timeout: 30000,
}, async (t) => {
  const on = resetThread(t);
  await on.stopped;
  assert.equal(on.schedule(true).outcome, 'applied');
  on.reading.percent = null;
  on.reading.resetsAt = null;
  on.clock.advance(5 * 3_600_000);
  const fire = async () => {
    on.timers.at(-1)?.work();
    await new Promise((resolve) => setImmediate(resolve));
  };
  // Four tries an hour, for two hours.
  for (let index = 0; index < 8; index++) {
    await fire();
    assert.equal(on.timers.at(-1)?.ms, 15 * 60_000);
    on.clock.advance(15 * 60_000);
  }
  const lines = () =>
    on
      .read()
      .messages.map((message) => message.text)
      .filter((text) => /reopened|could not be read|could not read|start cancelled/.test(text));
  assert.deepEqual(lines(), [
    "Anthropic's usage could not be read. CrewKite reads it again every 15 minutes, for a day at most.",
  ]);
  assert.equal(on.read().thread.startAt?.turnId, on.read().turns[0]?.id);
  on.clock.advance(24 * 3_600_000);
  await fire();
  assert.equal(on.read().thread.startAt, undefined);
  assert.deepEqual(lines().slice(1), [
    "Anthropic start cancelled. CrewKite could not read Anthropic's usage for a day. Send the message again when it can run.",
  ]);
  assert.equal(on.read().turns.length, 1);
});

test('a reset that usage does not confirm starts nothing, and Cancel removes the wait', {
  timeout: 30000,
}, async (t) => {
  const on = resetThread(t);
  await on.stopped;
  on.reading.resetsAt = null;
  const refused = on.schedule(true);
  assert.equal(refused.outcome, 'blocked');
  assert.equal((refused as { reason: string }).reason, 'no-reset-time');

  on.reading.resetsAt = on.inHours(5);
  on.schedule(true);
  // The window reads zero when the time comes, with a later reset. Nothing starts and the wait moves.
  on.clock.advance(5 * 3_600_000);
  on.reading.resetsAt = on.inHours(10);
  on.timers.at(-1)?.work();
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = on.read();
  assert.equal(waiting.turns.length, 1);
  assert.equal(waiting.thread.startAt?.at, on.inHours(10));
  assert.equal(on.timers.at(-1)?.ms, 5 * 3_600_000);

  const armed = on.timers.at(-1);
  on.schedule(false);
  assert.equal(on.read().thread.startAt, undefined);
  assert.equal(armed?.cancelled, true);

  // An API connection assigned while the start waits would bill the message per token. The
  // window opens, and the wait ends with nothing sent.
  assert.equal(on.schedule(true).outcome, 'applied');
  assignConnection(
    on.store,
    on.taskId,
    'thread',
    apiConnection('con_01KA0000000000000000000005', 'anthropic', on.clock.now()),
  );
  on.clock.advance(5 * 3_600_000);
  on.reading.percent = 80;
  on.timers.at(-1)?.work();
  await new Promise((resolve) => setImmediate(resolve));
  const ended = on.read();
  assert.equal(ended.turns.length, 1);
  assert.equal(ended.thread.startAt, undefined);
  assert.match(
    ended.messages.at(-1)?.text ?? '',
    /^Anthropic start cancelled\. .*assigned connection/,
  );
});

/** An API connection, ready on its last proof unless the change says otherwise. */
function apiConnection(
  connectionId: string,
  family: ChatFamily,
  at: string,
  change: Partial<Connection> = {},
): Connection {
  return {
    connectionId,
    family,
    backend: 'native-client',
    billingMode: 'api',
    profileId: `${family}-api`,
    keepConnected: false,
    readiness: 'ready',
    proofGeneration: 1,
    observedMode: 'api',
    observedAt: at,
    ...change,
  };
}

function assignConnection(
  store: Store,
  taskId: string,
  role: ConnectionAssignment['role'],
  connection: Connection,
) {
  store.transaction(() => {
    store.putConnection(connection, connection.observedAt ?? '2026-10-23T09:00:00.000Z');
    store.putConnectionAssignment(
      { taskId, role, connectionId: connection.connectionId },
      '2026-10-23T09:00:00.000Z',
    );
  });
}

// Claim: a subscription limit never moves work onto API billing, even where the thread has a ready
// API connection on the family the ranking puts first. A fixer's limit that moves the thread's own
// pick checks the builder's slot too, since the builder runs there next. A turn that ran on an API
// connection never moves to another connection on its own, and never waits for a reset.
test('a limit never moves work onto an API connection, and a turn on one never moves on its own', {
  timeout: 30000,
}, async (t) => {
  const on = limitThread(t, { autoHandoff: true, resetsAt: null });
  const now = createTestClock().now();
  // Google ranks first after OpenAI stops, and this thread uses API billing there.
  assignConnection(
    on.store,
    on.taskId,
    'thread',
    apiConnection('con_01KA0000000000000000000001', 'google', now),
  );
  const moved = turnReaches(on, 'done');
  on.send('Fix the rounding.');
  await moved;
  assert.deepEqual(
    on.read().turns.map((turn) => [turn.state, turn.selection.family, turn.connectionId ?? null]),
    [
      ['failed', 'openai', null],
      ['done', 'anthropic', null],
    ],
  );
  assert.equal(on.adapters.get('google')?.requests.length, 0);

  // A fixer on the thread's own family stops on a limit, so the thread moves. Google ranks first,
  // and only the builder runs there on API billing.
  const fixer = limitThread(t, { autoHandoff: true, resetsAt: null });
  assignConnection(
    fixer.store,
    fixer.taskId,
    'builder',
    apiConnection('con_01KA0000000000000000000004', 'google', now),
  );
  const openaiPick = { family: 'openai', model: 'openai-model', effort: 'default' } as const;
  fixer.store.transaction(() =>
    fixer.service.configure({ taskId: fixer.taskId, selection: openaiPick }),
  );
  const fixed = turnReaches(fixer, 'done');
  act(fixer.store, (effects) =>
    fixer.service.sendMessage(
      {
        taskId: fixer.taskId,
        text: 'Fix the review findings.',
        role: 'fixer',
        selection: openaiPick,
        attachments: [],
        files: [],
      },
      effects,
    ),
  );
  await fixed;
  assert.deepEqual(
    fixer.read().turns.map((turn) => [turn.state, turn.selection.family]),
    [
      ['failed', 'openai'],
      ['done', 'anthropic'],
    ],
  );
  assert.equal(fixer.adapters.get('google')?.requests.length, 0);

  // A builder on OpenAI API billing stops on a limit. Google has allowance and handoff is on.
  const limit = chatFailure({ stage: 'stream', kind: 'usage-limit', message: 'Rate limit.' });
  const openai = createScriptedChatAdapter({
    family: 'openai',
    turns: [[{ kind: 'fail', stopReason: 'limit', failure: limit }]],
  });
  const google = createScriptedChatAdapter({
    family: 'google',
    turns: [[{ kind: 'text', itemId: 'r', chunks: ['Not chosen.'] }]],
  });
  const pinned = standalone(t, {
    adapters: new Map<ChatFamily, ChatAdapter>([
      ['openai', { ...openai, connectionModes: ['api'] }],
      ['google', google],
    ]),
    // OpenAI's own window resets in an hour. It is not the connection's limit.
    catalog: () => ({
      families: [
        familyEntry('openai', 90, new Date(Date.parse(now) + 3_600_000).toISOString(), now),
        familyEntry('google', 80, null, now),
      ],
    }),
  });
  pinned.store.transaction(() =>
    pinned.service.configure({ taskId: pinned.taskId, autoHandoff: true }),
  );
  assignConnection(
    pinned.store,
    pinned.taskId,
    'builder',
    apiConnection('con_01KA0000000000000000000002', 'openai', now),
  );
  const failed = turnReaches(pinned, 'failed');
  pinned.send('Fix the rounding.', { family: 'openai', model: 'openai-model', effort: 'default' });
  await failed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    pinned.read().turns.map((turn) => [turn.state, turn.connectionId]),
    [['failed', 'con_01KA0000000000000000000002']],
  );
  assert.equal(google.requests.length, 0);
  assert.deepEqual(
    pinned.store.transaction(() =>
      pinned.service.configure({ taskId: pinned.taskId, startAtReset: true }),
    ),
    {
      outcome: 'blocked',
      reason: 'assigned-connection',
      next: 'This message ran on an assigned connection, which has no reset time CrewKite reads. Send it again when the connection can run.',
    },
  );
});

// Claim: a turn assigned to an API connection starts only while the mode its client last proved is
// the mode the person chose, and the controller checks again right before the adapter sends. A
// turn running on it stops when the person disconnects or forgets it. An API turn that reported no
// cost counts as unreported, never as free.
test('a turn on an API connection starts only on a proven matching mode, and its cost is never zero', {
  timeout: 30000,
}, async (t) => {
  const now = createTestClock().now();
  const connectionId = 'con_01KA0000000000000000000003';
  const pick = { family: 'openai', model: 'openai-model', effort: 'default' } as const;
  const refused = (message: string) => ({
    outcome: 'blocked',
    reason: 'provider-not-ready',
    next: 'Reconnect it in Settings, or clear its assignment for this thread or role.',
    message,
  });
  const rows: {
    claim: string;
    change: Partial<Connection>;
    modes: BillingMode[];
    message: string;
  }[] = [
    {
      claim: 'the client reported another mode',
      change: { readiness: 'needs-attention', observedMode: 'subscription' },
      modes: ['api'],
      message: 'Sign-in changed. Reconnect this API connection.',
    },
    {
      claim: 'no proof since a restart',
      change: { readiness: 'needs-attention', observedMode: null, observedAt: null },
      modes: ['api'],
      message: 'API billing has not confirmed its billing mode.',
    },
    {
      claim: 'the person disconnected it',
      change: { readiness: 'disconnected', observedMode: null, observedAt: null },
      modes: ['api'],
      message: 'API billing is disconnected.',
    },
    {
      claim: 'the adapter cannot run API billing on its own profile',
      change: {},
      modes: [],
      message: 'Provider API billing is not verified for this client.',
    },
  ];
  for (const row of rows) {
    const adapter = createScriptedChatAdapter({ family: 'openai', turns: [] });
    const thread = standalone(t, {
      adapters: new Map([['openai', { ...adapter, connectionModes: row.modes }]]),
    });
    assignConnection(
      thread.store,
      thread.taskId,
      'thread',
      apiConnection(connectionId, 'openai', now, row.change),
    );
    const result = thread.send('Fix the rounding.', pick);
    const { message, ...answer } = refused(row.message);
    assert.deepEqual(result, answer, row.claim);
    const read = thread.read();
    assert.deepEqual(read.turns, [], row.claim);
    assert.equal(read.messages.at(-1)?.text, `${message} ${answer.next}`, row.claim);
    assert.equal(adapter.requests.length, 0, row.claim);
  }

  // A matching proof starts the turn on the connection, with no credit switch or allowance of
  // the family's own route.
  const adapter = createScriptedChatAdapter({
    family: 'openai',
    turns: [[{ kind: 'text', itemId: 'r', chunks: ['Done.'] }]],
  });
  const thread = standalone(t, {
    adapters: new Map([['openai', { ...adapter, connectionModes: ['api'] as BillingMode[] }]]),
    catalog: () => ({ families: [creditEntry('openai', 50, true, now)] }),
  });
  assignConnection(
    thread.store,
    thread.taskId,
    'thread',
    apiConnection(connectionId, 'openai', now),
  );
  const done = turnReaches(thread, 'done');
  assert.equal(thread.send('Fix the rounding.', pick).outcome, 'applied');
  await done;
  const [request] = adapter.requests as unknown as ChatTurnRequest[];
  assert.deepEqual(request.connection, {
    connectionId,
    billingMode: 'api',
    profileId: 'openai-api',
    proofGeneration: 1,
  });
  assert.equal(request.creditSpending, undefined);
  assert.equal(request.allowanceLeft, null);
  const [turn] = thread.read().turns;
  assert.equal(turn.connectionId, connectionId);
  // The client reported no cost, so the turn stays unreported and the connection's sum says so.
  assert.deepEqual(turn.spend, { reported: null, estimated: null, unreportedTurns: 1 });
  const connections = new Connections({
    store: thread.store,
    now: () => now,
    id: () => connectionId,
    client: {
      prepare: () => {},
      loginLine: () => 'sign in',
      readMode: async () => undefined,
      signOut: async () => {},
    },
  });
  assert.deepEqual(connections.read().spend, [
    { connectionId, spend: { reported: null, estimated: null, unreportedTurns: 1 } },
  ]);

  // Admitted, then disconnected before the adapter was called: the turn fails unsent and cost
  // nothing.
  const unsent = turnReaches(thread, 'failed');
  thread.send('Then the totals.', pick);
  thread.store.transaction(() =>
    thread.store.putConnection(
      apiConnection(connectionId, 'openai', now, {
        readiness: 'disconnected',
        observedMode: null,
        observedAt: null,
      }),
      now,
    ),
  );
  const failed = await unsent;
  assert.equal(failed.failure?.message, 'API billing is disconnected.');
  assert.equal(failed.spend, null);
  assert.equal(adapter.requests.length, 1);

  // A turn already running on the connection stops when the person disconnects or forgets it.
  const waiting = createScriptedChatAdapter({ family: 'openai', turns: [[{ kind: 'wait' }]] });
  const running = standalone(t, {
    adapters: new Map([['openai', { ...waiting, connectionModes: ['api'] as BillingMode[] }]]),
  });
  assignConnection(
    running.store,
    running.taskId,
    'thread',
    apiConnection(connectionId, 'openai', now),
  );
  const started = next(
    running,
    (event) =>
      event.type === 'agent.event' && (event.payload as AgentEvent).type === 'turn.started',
  );
  running.send('Fix the rounding.', pick);
  await started;
  const stopped = turnReaches(running, 'stopped');
  running.service.stopConnectionTurns(connectionId);
  const ended = await stopped;
  assert.equal(ended.stopCause, 'person');
  assert.deepEqual(ended.spend, { reported: null, estimated: null, unreportedTurns: 1 });
  assert.equal(
    running.read().messages.at(-1)?.text,
    'Stopped: you disconnected or forgot the connection this turn ran on.',
  );
});
