// The scripted adapter emits the AgentEvent stream every real adapter must produce:
//   turn.started, then per text item text.delta... and text.completed,
//   permission.requested -> (respondPermission) -> permission.resolved,
//   and turn.completed { stopReason, failure } before the result settles.
// On stop it reports only completed items, like a native client that drops the open item.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  ChatCatalogRead,
  ChatFamily,
  ChatModelSelection,
  ChatThreadRead,
  ChatToolKind,
  ChatTurn,
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
  return { controller, adapter, task, run, send, read, source };
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

function agentEvents(controller: Pick<Controller, 'store'>): AgentEvent[] {
  return controller.store
    .eventsAfter('0')
    .flatMap((event) => (event.type === 'agent.event' ? [event.payload] : []));
}

test('a sent message streams agent events and saves the reply when the turn finishes', {
  timeout: 30000,
}, async (t) => {
  const { controller, adapter, send, read } = await chat(t, [
    [{ kind: 'text', itemId: 'reply', chunks: ['It sells ', 'things.'] }],
  ]);
  const states: string[] = [];
  controller.store.subscribe((event) => {
    if (event.type === 'chat.turn') states.push(event.payload.state);
  });
  const done = turnReaches(controller, 'done');
  assert.equal((await send('What does this project do?')).outcome, 'applied');
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
  assert.equal(request.prompt, 'What does this project do?');
  assert.deepEqual(request.history, []);
  assert.match(request.systemContext, /demo-shop/);
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
          ...(choice ? { selection: choice } : {}),
        },
        effects,
      ),
    );
    for (const effect of effects) effect();
    return result;
  };
  const read = (on = service) => on.readThread({ taskId, limit: 100 });
  return { clock, store, taskId, service, start, send, read };
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
  };
}

test('startup recovery fails a turn whose controller stopped before it finished', (t) => {
  const { store, taskId, start, read } = standalone(t, {
    adapters: new Map([['openai', createScriptedChatAdapter({ family: 'openai', turns: [] })]]),
  });
  // The command commits, then the process ends before its launch effect runs.
  store.transaction(() =>
    start().sendMessage(
      { taskId, text: 'Start the change.', selection, role: 'assistant', attachments: [] },
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

// The test replaces the process table, so the group number is never signaled for real.
test('a provider process that outlives its turn blocks the thread until a restart finds it gone', {
  timeout: 30000,
}, async (t) => {
  const group = 4242;
  const present = new Set([group]);
  const signals: string[] = [];
  const thread = standalone(t, {
    adapters: new Map([
      [
        'openai',
        createScriptedChatAdapter({
          family: 'openai',
          groups: [group],
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
  const failed = turnReaches(thread, 'failed');
  thread.send('Fix the rounding.');
  const turn = await failed;

  assert.deepEqual(signals, [`${group} SIGTERM`, `${group} SIGKILL`]);
  assert.equal(turn.failure?.message, 'The provider process did not exit.');
  assert.deepEqual(turn.groups, [group]);
  const completed = agentEvents(thread).at(-1);
  assert.equal(completed?.type === 'turn.completed' && completed.stopReason, 'error');
  assert.equal(thread.read().thread.ownershipUnknown, true);
  const accept = store.transaction(() =>
    thread.service.accept({ taskId, branch: 'crewkite/fix-rounding' }, undefined),
  );
  assert.deepEqual(
    [thread.send('Again.').reason, accept.reason],
    ['ownership-unknown', 'ownership-unknown'],
  );

  // A restart while the group is present keeps the block. The next one, once it is gone, lifts it.
  let restarted = thread.start();
  restarted.recover();
  assert.equal(thread.read(restarted).thread.ownershipUnknown, true);
  present.clear();
  restarted = thread.start();
  restarted.recover();
  const after = thread.read(restarted);
  assert.equal(after.thread.ownershipUnknown, undefined);
  assert.equal(after.turns[0].groups, undefined);
  const done = turnReaches(thread, 'done');
  assert.equal(thread.send('Again.', selection, restarted).outcome, 'applied');
  await done;
});

test('a thread read returns messages in cursor order and the live events of the open turn', {
  timeout: 30000,
}, async (t) => {
  const { controller, send, read } = await chat(t, [
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
});

// A limit stop needs a second connected family, so these tests bring a catalog of their own.
function limitThread(t: TestContext, options: { autoHandoff: boolean; resetsAt: string | null }) {
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
  const thread = standalone(t, { adapters, catalog: () => ({ families }) });
  const { store, service, taskId } = thread;
  store.transaction(() => service.configure({ taskId, autoHandoff: options.autoHandoff }));
  return { ...thread, adapters, limit };
}

test('a usage limit writes a system line, and auto handoff runs the same message once on the next family', {
  timeout: 30000,
}, async (t) => {
  const on = limitThread(t, { autoHandoff: true, resetsAt: '2026-10-23T14:00:00.000Z' });
  const continued = turnReaches(on, 'done');
  on.send('Fix the rounding.');
  const second = await continued;

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
    ],
  );
  assert.equal(thread.turns[1].userMessageId, thread.turns[0].userMessageId);
  assert.equal(thread.thread.selection?.model, 'google-model');
  assert.equal(thread.thread.sessions[0]?.sessionId, `session-${second.id}`);
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

  const off = limitThread(t, { autoHandoff: false, resetsAt: null });
  const stopped = turnReaches(off, 'failed');
  off.send('Fix the rounding.');
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
function editingAdapter(asks: readonly (ChatToolKind | null)[]) {
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
            emit({ type: 'tool.started', turnId, callId: 'call-1', kind: ask, title: 'net' });
          emit({
            type: 'permission.requested',
            turnId,
            requestId: 'edit-1',
            callId: ask ? 'call-1' : null,
            question: 'Go ahead?',
            detail: null,
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
  const done = turnReaches(controller, 'done');
  await send('Fix the rounding.');
  await done;
  appendFileSync(join(adapter.requests[0].scratch.directory, 'net.mjs'), '// accepted\n');
  const repo = (...args: string[]) => git(source.directory, args).toString('utf8').trim();
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
    repo('log', '-1', '--format=%s|%an <%ae>', branch),
    `CrewKite: ${task.title}|Fixture owner <owner@example.invalid>`,
  );
  assert.deepEqual(checkout(), before);
  const thread = await read();
  assert.equal(thread.thread.lastAcceptance?.commit, commit);
  assert.equal(thread.messages.at(-1)?.text, 'Accepted 1 file to branch crewkite/fix-rounding.');

  assert.equal((await accept()).reason, 'branch-exists');
  assert.equal(repo('rev-parse', branch), commit);
});

test('accept is refused while a turn is running', { timeout: 30000 }, async (t) => {
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
});
