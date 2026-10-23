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
  ChatThreadRead,
  ChatTurn,
  CommandResult,
  Event,
  Project,
  Task,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { type ChatScriptStep, createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import type { Controller } from '../commands/controller.ts';
import { setup } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import { type ChatTurnRequest, chatFailure } from './adapter.ts';
import { ChatService } from './service.ts';

const selection = { family: 'openai', model: 'fixture-model', effort: 'default' } as const;

async function chat(t: TestContext, turns: ChatScriptStep[][]) {
  const adapter = createScriptedChatAdapter({ family: 'openai', turns });
  const context = await setup(t, { chatAdapters: new Map([['openai', adapter]]) });
  const { controller, command } = context;
  const task = (await controller.execute(context.draft, 'local-owner')).entity as Task;
  const run = (name: string, payload: object, revision?: number) =>
    controller.execute(command(name, { taskId: task.id, ...payload }, revision), 'local-owner');
  const send = (text: string) =>
    run('SendChatMessage', { text, selection }, task.revision) as Promise<CommandResult>;
  const read = async (payload: object = {}) =>
    (await run('ReadChatThread', payload)).data as ChatThreadRead & { kind: 'chat-thread' };
  return { controller, adapter, task, run, send, read };
}

/** Subscribe before the command that causes the event, then await. */
function next(controller: Controller, match: (event: Event) => boolean): Promise<Event> {
  return new Promise((resolve) => {
    const stop = controller.store.subscribe((event) => {
      if (!match(event)) return;
      stop();
      resolve(event);
    });
  });
}

function turnReaches(controller: Controller, state: ChatTurn['state']): Promise<ChatTurn> {
  return next(
    controller,
    (event) => event.type === 'chat.turn' && event.payload.state === state,
  ).then((event) => event.payload as ChatTurn);
}

function agentEvents(controller: Controller): AgentEvent[] {
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

test('startup recovery fails a turn whose controller stopped before it finished', (t) => {
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
  const service = () =>
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
      adapters: new Map([['openai', createScriptedChatAdapter({ family: 'openai', turns: [] })]]),
      resolveEnvironment: () => ({}),
      projectPath: () => repository.directory,
      resolveSelection: (_taskId, value) => value ?? null,
      catalog: () => ({ families: [] }),
    });
  const taskId = fixtures.task.id;
  // The command commits, then the process ends before its launch effect runs.
  store.transaction(() =>
    service().sendMessage(
      { taskId, text: 'Start the change.', selection, role: 'assistant', attachments: [] },
      [],
    ),
  );

  const restarted = service();
  restarted.recover();
  const thread = restarted.readThread({ taskId, limit: 100 });
  const [turn] = thread.turns;
  assert.equal(turn.state, 'failed');
  assert.equal(turn.failure?.kind, 'internal');
  assert.equal(turn.failure?.message, 'The turn did not finish before the controller restarted.');
  assert.equal(thread.thread.activeTurnId, null);
  assert.deepEqual(thread.messages.at(-1)?.author, { kind: 'system', turnId: turn.id });
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
  const { turnId } = (await streaming).payload as AgentEvent;

  const thread = await read();
  assert.deepEqual(
    thread.messages.map((message) => message.text),
    ['First question.', 'First reply.', 'Second question.'],
  );
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
