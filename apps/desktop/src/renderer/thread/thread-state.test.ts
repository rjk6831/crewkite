// Frames assumed from the controller, one per event:
//   { type: 'agent.event', cursor: '12', taskId: <tsk>, payload: <AgentEvent> }
//   { type: 'conversation.entry', cursor: '10', taskId: <tsk>, payload: <ChatMessage> }
// A thread read carries the log cursor it reflects when the controller sends one. The live events
// inside a read carry no cursor of their own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AgentEvent,
  ChatCatalogRead,
  ChatFailure,
  ChatFamily,
  ChatMessage,
  ChatRole,
  ChatThread,
  ChatThreadRead,
  ChatTurn,
  ChatTurnStats,
} from '@crewkite/contracts';
import { acceptsType, deliveryNote, deliveryOf, tryWithChoices } from './file-fit.ts';
import { limitOffer, offerChoices } from './handoff-offer.ts';
import { outputLimitLine, outputSplit, statsSplit } from './output-limit.ts';
import {
  earlierCursor,
  FIRST_READ_BACKOFF,
  initialThreadState,
  lastFamily,
  lastReply,
  newestTurnId,
  reduceThread,
  retryRead,
  THREAD_PAGE_SIZE,
  type ThreadEvent,
  type ThreadItem,
  TRY_AGAIN_AFTER_MS,
  threadItems,
} from './thread-state.ts';
import { type Block, runLabel, type ToolBlock, viewBlocks } from './turn-fold.ts';

const id = (prefix: string, n: number) => `${prefix}_0${String(n).padStart(25, '0')}`;
const task = id('tsk', 1);
const turn = id('trn', 1);
const stamp = '2026-10-23T10:00:00.000Z';

type Body = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'turnId'> : never) : never;
const on = (turnId: string, cursor: number, event: Body): ThreadEvent => ({
  type: 'agent.event',
  cursor: String(cursor),
  taskId: task,
  payload: { ...event, turnId },
});
const agent = (cursor: number, event: Body) => on(turn, cursor, event);
const begin = (turnId: string, cursor: number) =>
  on(turnId, cursor, {
    type: 'turn.started',
    family: 'openai',
    model: 'large-1',
    effort: 'default',
    role: 'assistant',
  });
const user = (cursor: number, text: string): ThreadEvent => {
  const message: ChatMessage = {
    id: id('msg', cursor),
    taskId: task,
    at: stamp,
    cursor: String(cursor),
    author: { kind: 'user' },
    text,
    attachments: [],
    files: [],
  };
  return { type: 'conversation.entry', cursor: String(cursor), taskId: task, payload: message };
};
const started = (cursor: number) => begin(turn, cursor);
const run = (events: ThreadEvent[]) =>
  threadItems(reduceThread(initialThreadState(task), { type: 'events', events }));
const turnOf = (items: ThreadItem[]) => {
  const found = items.find((item) => item.kind === 'turn');
  assert.ok(found && found.kind === 'turn');
  return found.turn;
};

test('events fold into one timeline in cursor order', () => {
  const items = run([
    agent(13, { type: 'text.completed', itemId: 'a', text: 'Done.' }),
    started(11),
    user(10, 'Add the guard'),
    agent(12, { type: 'tool.started', callId: 'c1', kind: 'read', title: 'Read net.mjs' }),
  ]);
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'turn'],
  );
  assert.deepEqual(
    turnOf(items).blocks.map((block) => block.kind),
    ['tool', 'text'],
  );
});

test('a turn sits right after the user message that started it', () => {
  // Messages count on the conversation, 13 and 15, and agent events on the event log, 616 and 657.
  // The message decides where the turn goes.
  const [first, second] = [id('trn', 2), id('trn', 3)];
  const thread: ChatThread = {
    taskId: task,
    scratchReady: true,
    base: null,
    selection: null,
    permissionPolicy: 'ask',
    sessions: [],
    activeTurnId: null,
    autoHandoff: false,
    handoffMode: 'most-left',
    crew: null,
    flightMode: 'manual',
    crewChain: null,
    queued: [],
  };
  const at = (minutes: number) => new Date(Date.parse(stamp) + minutes * 60_000).toISOString();
  const record = (turnId: string, sequence: number, asked: number, more: Partial<ChatTurn> = {}) =>
    ({
      id: turnId,
      taskId: task,
      sequence,
      role: 'assistant',
      selection: { family: 'openai', model: 'large-1', effort: 'default' },
      userMessageId: id('msg', asked),
      assistantMessageId: null,
      state: 'done',
      startedAt: stamp,
      endedAt: stamp,
      failure: null,
      handoffFrom: null,
      ...more,
    }) satisfies ChatTurn;
  const meta = (turn: ChatTurn, cursor: number): ThreadEvent => ({
    type: 'chat.turn',
    cursor: String(cursor),
    taskId: task,
    payload: turn,
  });
  const line = (cursor: number, author: ChatMessage['author'], text: string, written = stamp) => ({
    ...(user(cursor, text).payload as ChatMessage),
    author,
    at: written,
  });
  const reply = (cursor: number, turnId: string, written = stamp) =>
    line(
      cursor,
      { kind: 'assistant', turnId, family: 'openai', model: 'large-1', role: 'assistant' },
      'Done.',
      written,
    );
  const asked = (cursor: number) => user(cursor, `Question ${cursor}`).payload as ChatMessage;
  const keys = (state: ReturnType<typeof initialThreadState>) =>
    threadItems(state).map((item) => item.key);
  const load = (turns: ChatTurn[], messages: ChatMessage[]) =>
    reduceThread(initialThreadState(task), {
      type: 'loaded',
      read: { thread, turns, messages, liveEvents: [], cursor: '700' },
    });
  const interleaved = [id('msg', 13), `turn:${first}`, id('msg', 15), `turn:${second}`];

  // Two finished turns restored from a read, with every message written in the same minute.
  assert.deepEqual(
    keys(
      load(
        [record(first, 0, 13), record(second, 1, 15)],
        [asked(13), reply(14, first), asked(15), reply(16, second)],
      ),
    ),
    interleaved,
  );

  // Both turns built from the stream. The second is still running when its record arrives.
  let live = reduceThread(initialThreadState(task), {
    type: 'events',
    events: [
      user(13, 'Question 13'),
      begin(first, 616),
      on(first, 617, { type: 'text.completed', itemId: 'a', text: 'Done.' }),
      on(first, 618, { type: 'turn.completed', stopReason: 'done', failure: null }),
      meta(record(first, 0, 13), 619),
      user(15, 'Question 15'),
      begin(second, 657),
      on(second, 658, { type: 'text.delta', itemId: 'a', text: 'Look' }),
    ],
  });
  assert.deepEqual(keys(live), interleaved);
  live = reduceThread(live, {
    type: 'events',
    events: [meta(record(second, 1, 15, { state: 'running', endedAt: null }), 659)],
  });
  assert.deepEqual(keys(live), interleaved);

  // A limit handoff runs the same message again. The rerun follows the handoff line, and the
  // first turn's failure stays above both.
  const limit: ChatFailure = {
    stage: 'stream',
    kind: 'usage-limit',
    message: 'The weekly limit is reached.',
    providerMessage: null,
    method: null,
    code: null,
    resetsAt: null,
    nextAction: 'Continue on another provider.',
  };
  assert.deepEqual(
    keys(
      load(
        [
          record(first, 0, 10, { state: 'failed', failure: limit }),
          record(second, 1, 10, { startedAt: at(2) }),
        ],
        [
          asked(10),
          line(11, { kind: 'system', turnId: first }, 'OpenAI reached its usage limit.', at(1)),
          line(12, { kind: 'system', turnId: null }, 'Continued on Anthropic from OpenAI.', at(2)),
          reply(13, second, at(3)),
        ],
      ),
    ),
    [id('msg', 10), `failure:${first}`, id('msg', 12), `turn:${second}`],
  );
});

test('text deltas accumulate into one assistant message that the completed text replaces', () => {
  const deltas = ['The ', 'guard ', 'is in.'].map((text, index) =>
    agent(11 + index, { type: 'text.delta', itemId: 'a', text }),
  );
  const streaming = turnOf(run([started(10), ...deltas])).blocks;
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0].kind === 'text' && streaming[0].text, 'The guard is in.');
  const completed = turnOf(
    run([
      started(10),
      ...deltas.slice(0, 2),
      agent(14, { type: 'text.completed', itemId: 'a', text: 'The guard is in.' }),
    ]),
  ).blocks;
  assert.equal(completed.length, 1);
  assert.equal(completed[0].kind === 'text' && completed[0].text, 'The guard is in.');
});

test('a permission request holds the turn until its resolution arrives', () => {
  const request = agent(11, {
    type: 'permission.requested',
    requestId: 'p1',
    callId: null,
    question: 'Run the tests?',
    detail: null,
    options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }],
  });
  assert.equal(turnOf(run([started(10), request])).status, 'waiting-permission');
  const resolved = turnOf(
    run([
      started(10),
      request,
      agent(12, { type: 'permission.resolved', requestId: 'p1', choice: 'once' }),
    ]),
  );
  assert.equal(resolved.status, 'running');
  const card = resolved.blocks[0];
  assert.equal(card.kind === 'permission' && card.choice, 'once');
});

test('a failed turn adds a system line with the cause and the next action', () => {
  const failure: ChatFailure = {
    stage: 'prompt',
    kind: 'usage-limit',
    message: 'The weekly limit is reached.',
    providerMessage: 'rate_limit_exceeded',
    method: 'turn/start',
    code: 429,
    resetsAt: null,
    nextAction: 'Continue on another provider.',
  };
  const items = run([
    started(10),
    agent(11, { type: 'turn.completed', stopReason: 'limit', failure }),
  ]);
  // The turn produced nothing to show, so the line stands alone.
  assert.deepEqual(
    items.map((item) => item.kind),
    ['failure'],
  );
  const line = items[0];
  assert.ok(line.kind === 'failure');
  assert.equal(line.failure.nextAction, 'Continue on another provider.');
});

test('a stopped turn ends quietly with its partial text and no failure line', () => {
  const stop: ChatFailure = {
    stage: 'stream',
    kind: 'stopped',
    message: 'The turn was stopped.',
    providerMessage: null,
    method: null,
    code: null,
    resetsAt: null,
    nextAction: 'Send a new message to continue.',
  };
  const end = (cursor: number) =>
    agent(cursor, { type: 'turn.completed', stopReason: 'stopped', failure: stop });
  const items = run([
    started(10),
    agent(11, { type: 'text.delta', itemId: 'a', text: 'The guard ' }),
    end(12),
  ]);
  assert.deepEqual(
    items.map((item) => item.kind),
    ['turn'],
  );
  const view = turnOf(items);
  assert.equal(view.status, 'stopped');
  assert.equal(view.failure, null);
  assert.equal(view.blocks[0].kind === 'text' && view.blocks[0].text, 'The guard ');
  // A stop before any output still leaves a row, so the person sees that it stopped.
  assert.equal(turnOf(run([started(10), end(11)])).status, 'stopped');
});

// The view only guesses whether a message will wait. When the controller queues one the view
// thought would start, the queued list shows it and the bubble goes.
test('a message the controller queued leaves no pending bubble', () => {
  const text = 'Then the totals.';
  const thread: ChatThread = {
    taskId: task,
    scratchReady: true,
    base: null,
    selection: null,
    permissionPolicy: 'ask',
    sessions: [],
    activeTurnId: turn,
    autoHandoff: false,
    handoffMode: 'most-left',
    crew: null,
    flightMode: 'manual',
    crewChain: null,
    queued: [{ id: id('msg', 9), at: stamp, text, role: 'assistant', attachments: [], files: [] }],
  };
  const pending = { localId: 'local-1', text, files: [], at: stamp };
  const sent = reduceThread(initialThreadState(task), { type: 'sending', pending });
  const event: ThreadEvent = { type: 'chat.thread', cursor: '20', taskId: task, payload: thread };
  const queued = reduceThread(sent, { type: 'events', events: [event] });
  assert.deepEqual(threadItems(queued), []);
  assert.deepEqual(
    queued.thread?.queued.map((message) => message.text),
    [text],
  );

  // The chips show on the pending message and stay when the stored entry replaces it. The entry
  // arrives in its stored shape, which names the files.
  const file = { id: 'a'.repeat(64), name: 'plan.pdf', mimeType: 'application/pdf', bytes: 9 };
  const sentFiles = reduceThread(initialThreadState(task), {
    type: 'sending',
    pending: { localId: 'local-2', text: 'See the plan', files: [file], at: stamp },
  });
  const userItem = (state: typeof sentFiles) => {
    const item = threadItems(state).find((row) => row.kind === 'user');
    return item?.kind === 'user' ? item : undefined;
  };
  assert.deepEqual(userItem(sentFiles)?.files, [file]);
  const stored = reduceThread(sentFiles, {
    type: 'events',
    events: [
      {
        type: 'conversation.entry',
        cursor: '30',
        taskId: task,
        payload: {
          kind: 'user-message',
          id: id('msg', 30),
          taskId: task,
          revision: 1,
          cursor: '30',
          at: stamp,
          author: { kind: 'user' },
          text: 'See the plan',
          files: [file],
        },
      },
    ],
  });
  assert.equal(userItem(stored)?.pending, false);
  assert.deepEqual(userItem(stored)?.files, [file]);
});

test('the limit offer shows only while the newest turn is the one that hit a limit', () => {
  const second = id('trn', 2);
  const failure = (kind: ChatFailure['kind']): ChatFailure => ({
    stage: 'stream',
    kind,
    message: 'The turn stopped.',
    providerMessage: null,
    method: null,
    code: null,
    resetsAt: null,
    nextAction: 'Continue on another provider.',
  });
  const end = (turnId: string, cursor: number, stopReason: 'limit' | 'error' | 'done') =>
    on(turnId, cursor, {
      type: 'turn.completed',
      stopReason,
      failure:
        stopReason === 'done'
          ? null
          : failure(stopReason === 'limit' ? 'usage-limit' : 'client-exit'),
    });
  const offer = (events: ThreadEvent[], pending = false) => {
    let state = reduceThread(initialThreadState(task), { type: 'events', events });
    if (pending)
      state = reduceThread(state, {
        type: 'sending',
        pending: { localId: 'local-1', text: 'Add the guard', files: [], at: stamp },
      });
    return limitOffer(state);
  };
  const stopped = [user(10, 'Add the guard'), begin(turn, 11), end(turn, 12, 'limit')];

  assert.deepEqual(offer(stopped), { turnId: turn, family: 'openai', mode: 'most-left' });
  // The message is on its way to another provider, so the choice is made.
  assert.equal(offer(stopped, true), null);
  // A newer turn that finished, or stopped for another reason, leaves nothing to offer.
  const newer = (stopReason: 'limit' | 'error' | 'done') => [
    ...stopped,
    user(13, 'Try again'),
    begin(second, 14),
    end(second, 15, stopReason),
  ];
  assert.equal(offer(newer('done')), null);
  assert.equal(offer(newer('error')), null);
  // A newer turn that also hit a limit moves the offer to it.
  assert.equal(offer(newer('limit'))?.turnId, second);

  // A reopened thread has the stored turns and no stream. The stored failure carries the cause.
  const stored = (
    n: number,
    state: ChatTurn['state'],
    cause: ChatFailure['kind'],
    stopReason?: ChatTurn['stopReason'],
  ): ChatTurn => ({
    id: id('trn', n),
    taskId: task,
    sequence: n - 1,
    role: 'assistant',
    selection: { family: 'anthropic', model: 'large-2', effort: 'default' },
    userMessageId: id('msg', 10 * n),
    assistantMessageId: null,
    state,
    startedAt: stamp,
    endedAt: stamp,
    failure: state === 'failed' ? failure(cause) : null,
    handoffFrom: null,
    ...(stopReason ? { stopReason } : {}),
  });
  const thread: ChatThread = {
    taskId: task,
    scratchReady: false,
    base: null,
    selection: null,
    permissionPolicy: 'ask',
    sessions: [],
    activeTurnId: null,
    autoHandoff: false,
    handoffMode: 'most-left',
    crew: null,
    flightMode: 'manual',
    crewChain: null,
    queued: [],
  };
  const reopened = (turns: ChatTurn[]) =>
    limitOffer(
      reduceThread(initialThreadState(task), {
        type: 'loaded',
        read: {
          thread,
          turns,
          messages: [user(10, 'Add the guard'), user(20, 'Try again')].map(
            (event) => event.payload as ChatMessage,
          ),
          liveEvents: [],
          cursor: '20',
        },
      }),
    );
  const first = stored(1, 'failed', 'usage-limit');
  assert.equal(reopened([first])?.family, 'anthropic');
  assert.equal(reopened([first, stored(2, 'done', 'usage-limit')]), null);
  assert.equal(reopened([first, stored(2, 'failed', 'client-exit')]), null);
  // A stored stop reason decides before the failure kind. Turns without one keep the fallback above.
  assert.equal(reopened([stored(1, 'failed', 'client-exit', 'limit')])?.family, 'anthropic');
  assert.equal(reopened([stored(1, 'failed', 'usage-limit', 'error')]), null);
});

test('finished reads and searches in a row fold into one line, and anything to act on stands alone', () => {
  const tool = (call: string, toolKind: ToolBlock['toolKind'], more: Partial<ToolBlock> = {}) =>
    ({
      kind: 'tool',
      id: `tool:${call}`,
      toolKind,
      title: call,
      input: undefined,
      output: '',
      truncated: false,
      status: 'ok',
      diff: null,
      summary: null,
      ...more,
    }) satisfies ToolBlock;
  const thought = (item: string, text: string, done = true): Block => ({
    kind: 'thinking',
    id: `thinking:${item}`,
    text,
    done,
  });
  const said: Block = { kind: 'text', id: 'text:a', text: 'Now the tests.', done: true };
  const asked: Block = {
    kind: 'permission',
    id: 'permission:p1',
    requestId: 'p1',
    callId: 'r3',
    question: 'Read the key file?',
    detail: null,
    options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }],
    choice: 'once',
  };
  // A run shows as its label and any other block as its id.
  const cases: { name: string; blocks: Block[]; ended?: boolean; want: string[] }[] = [
    {
      name: 'reads and searches fold',
      blocks: [tool('r1', 'read'), tool('r2', 'read'), tool('s1', 'search')],
      want: ['Read 2 files, searched once'],
    },
    { name: 'a lone read keeps its card', blocks: [tool('r1', 'read')], want: ['tool:r1'] },
    {
      name: 'a running read ends the run',
      blocks: [tool('r1', 'read'), tool('r2', 'read'), tool('r3', 'read', { status: 'running' })],
      ended: false,
      want: ['Read 2 files', 'tool:r3'],
    },
    {
      name: 'an edit, a command, a failure and text stand alone',
      blocks: [
        tool('s1', 'search'),
        tool('s2', 'search'),
        tool('e1', 'edit'),
        tool('r1', 'read'),
        said,
        tool('r2', 'read'),
        tool('c1', 'command'),
        tool('r3', 'read', { status: 'error' }),
      ],
      want: ['Searched 2 times', 'tool:e1', 'tool:r1', 'text:a', 'tool:r2', 'tool:c1', 'tool:r3'],
    },
    {
      name: 'a read that asked first stands alone',
      blocks: [tool('r1', 'read'), tool('r2', 'read'), tool('r3', 'read'), asked],
      want: ['Read 2 files', 'tool:r3', 'permission:p1'],
    },
    {
      name: 'a thought that ended with no text draws nothing and keeps the run',
      blocks: [tool('r1', 'read'), thought('a', ''), tool('r2', 'read'), thought('b', 'Tests.')],
      want: ['Read 2 files', 'thinking:b'],
    },
    {
      name: 'a live thought with no text yet still shows',
      blocks: [thought('a', '', false)],
      ended: false,
      want: ['thinking:a'],
    },
  ];
  for (const { name, blocks, ended = true, want } of cases)
    assert.deepEqual(
      viewBlocks(blocks, ended).map((item) => (item.kind === 'run' ? runLabel(item) : item.id)),
      want,
      name,
    );
});

test('the thread moves away from the family of its newest assistant turn, even one with no text', () => {
  const second = id('trn', 2);
  const limit: ChatFailure = {
    stage: 'stream',
    kind: 'usage-limit',
    message: 'The weekly limit is reached.',
    providerMessage: null,
    method: null,
    code: null,
    resetsAt: null,
    nextAction: 'Continue on another provider.',
  };
  const opened = (turnId: string, cursor: number, family: ChatFamily, role: ChatRole) =>
    on(turnId, cursor, { type: 'turn.started', family, model: 'large-1', effort: 'default', role });
  const done = (turnId: string, cursor: number) =>
    on(turnId, cursor, { type: 'turn.completed', stopReason: 'done', failure: null });
  const record = (
    turnId: string,
    sequence: number,
    family: ChatFamily,
    state: ChatTurn['state'],
  ): ThreadEvent => ({
    type: 'chat.turn',
    cursor: String(30 + sequence),
    taskId: task,
    payload: {
      id: turnId,
      taskId: task,
      sequence,
      role: 'assistant',
      selection: { family, model: 'large-1', effort: 'default' },
      userMessageId: id('msg', 10),
      assistantMessageId: null,
      state,
      startedAt: stamp,
      endedAt: stamp,
      failure: state === 'failed' ? limit : null,
      handoffFrom: null,
    } satisfies ChatTurn,
  });
  const fold = (events: ThreadEvent[]) =>
    reduceThread(initialThreadState(task), { type: 'events', events });
  const family = (events: ThreadEvent[]) => {
    const state = fold(events);
    return lastFamily(state, threadItems(state));
  };
  // The controller reruns only the newest turn. Retry and Try with show on it alone, and
  // Regenerate shows only when it finished with a reply.
  const rerun = (events: ThreadEvent[]) => {
    const state = fold(events);
    return { newest: newestTurnId(state), regenerate: lastReply(state, threadItems(state)) };
  };

  // Anthropic answered, then OpenAI hit its limit before any text. That turn has no row, and the
  // controller still counts it as the family the thread is on.
  const limited = [
    user(10, 'Add the guard'),
    record(turn, 0, 'anthropic', 'done'),
    opened(turn, 11, 'anthropic', 'assistant'),
    agent(12, { type: 'text.completed', itemId: 'a', text: 'Done.' }),
    done(turn, 13),
    record(second, 1, 'openai', 'failed'),
    opened(second, 14, 'openai', 'assistant'),
    on(second, 15, { type: 'turn.completed', stopReason: 'limit', failure: limit }),
  ];
  assert.equal(family(limited), 'openai');
  assert.deepEqual(
    rerun(limited),
    { newest: second, regenerate: null },
    'a failed turn after a reply leaves the reply without Regenerate',
  );

  // Before any record arrives the rows decide. A second opinion borrows another family for one
  // turn, so it is never the family the thread moves away from.
  const opinion = [
    opened(turn, 11, 'openai', 'assistant'),
    agent(12, { type: 'text.completed', itemId: 'a', text: 'Done.' }),
    done(turn, 13),
    opened(second, 14, 'local', 'advisor'),
    on(second, 15, { type: 'text.completed', itemId: 'a', text: 'Looks right.' }),
    done(second, 16),
  ];
  assert.equal(family(opinion), 'openai');
  assert.deepEqual(
    rerun(opinion),
    { newest: second, regenerate: second },
    'Regenerate goes to the second opinion, the newest turn, and skips the reply before it',
  );
  assert.deepEqual(
    rerun(opinion.slice(0, 5)),
    { newest: second, regenerate: null },
    'a newest turn still running offers no Regenerate',
  );
});

test('a reply restored from a thread read keeps the role, effort and stats of its turn', () => {
  const read = (role: 'reviewer' | 'advisor' | 'fixer', effort?: 'ultra'): ChatThreadRead => ({
    thread: {
      taskId: task,
      scratchReady: true,
      base: null,
      selection: null,
      permissionPolicy: 'ask',
      sessions: [],
      activeTurnId: null,
      autoHandoff: false,
      handoffMode: 'most-left',
      crew: null,
      flightMode: 'manual',
      crewChain: null,
      queued: [],
    },
    turns: [
      {
        id: turn,
        taskId: task,
        sequence: 0,
        role,
        selection: { family: 'google', model: 'large-2', effort: 'default' },
        userMessageId: id('msg', 10),
        assistantMessageId: id('msg', 11),
        state: 'done',
        startedAt: stamp,
        endedAt: stamp,
        failure: null,
        handoffFrom: null,
        stats,
      },
    ],
    messages: [
      {
        id: id('msg', 11),
        taskId: task,
        at: stamp,
        cursor: '11',
        author: {
          kind: 'assistant',
          turnId: turn,
          family: 'google',
          model: 'large-2',
          role,
          ...(effort ? { effort } : {}),
        },
        text: 'Two findings.',
        attachments: [],
        files: [],
      },
    ],
    liveEvents: [],
    cursor: '11',
  });
  const stats = {
    tokensIn: 5800,
    tokensOut: 300,
    tokensPerSecond: 18,
    firstTokenMs: 900,
    turnMs: 21000,
    contextUsed: 6097,
    contextCapacity: 8192,
    summaries: 2,
  };
  for (const [role, effort] of [
    ['reviewer', undefined],
    ['advisor', undefined],
    ['fixer', 'ultra'],
  ] as const) {
    const state = reduceThread(initialThreadState(task), {
      type: 'loaded',
      read: read(role, effort),
    });
    assert.deepEqual(
      turnOf(threadItems(state)).identity,
      { family: 'google', model: 'large-2', effort: effort ?? 'default', role },
      role,
    );
    // The live events are gone after a reload; the turn row still carries the stats line.
    assert.deepEqual(turnOf(threadItems(state)).stats, stats, role);
  }
});

test('events that a thread read or a stored turn read already covers apply once', () => {
  const thread: ChatThread = {
    taskId: task,
    scratchReady: true,
    base: null,
    selection: null,
    permissionPolicy: 'ask',
    sessions: [],
    activeTurnId: turn,
    autoHandoff: false,
    handoffMode: 'most-left',
    crew: null,
    flightMode: 'manual',
    crewChain: null,
    queued: [],
  };
  const delta = (cursor: number, text: string) =>
    agent(cursor, { type: 'text.delta', itemId: 'a', text });
  const output = (cursor: number, chunk: string) =>
    agent(cursor, { type: 'tool.output', callId: 'c1', chunk });
  const done = (cursor: number) =>
    agent(cursor, { type: 'turn.completed', stopReason: 'done', failure: null });
  const shown = (state: ReturnType<typeof initialThreadState>) => {
    const { blocks } = turnOf(threadItems(state));
    const text = blocks.find((block) => block.kind === 'text');
    const tool = blocks.find((block) => block.kind === 'tool');
    return {
      text: text?.kind === 'text' ? text.text : '',
      output: tool?.kind === 'tool' ? tool.output : '',
    };
  };
  // Every case is a view that folded `before`, then reloaded while `after` was still queued.
  const fresh = [started(10), delta(11, 'Hello'), output(12, 'line\n')];
  const cases = [
    {
      name: 'view had folded nothing',
      before: [],
      live: fresh,
      cursor: '12',
      after: [...fresh, delta(13, ' there'), output(14, 'more\n')],
      want: { text: 'Hello there', output: 'line\nmore\n' },
    },
    {
      name: 'view had folded part of the read',
      before: [started(10), delta(11, 'Hel')],
      live: [started(10), delta(11, 'Hel'), delta(12, 'lo')],
      cursor: '12',
      after: [delta(12, 'lo'), delta(13, '!')],
      want: { text: 'Hello!', output: '' },
    },
    {
      // The stream got past the read before the read returned. The snapshot must not erase what
      // the stream already delivered, because the stream will not send it again.
      name: 'view had folded an event past the read cursor',
      before: [started(10), delta(11, 'Hel'), delta(12, 'lo'), delta(13, '!')],
      live: [started(10), delta(11, 'Hel'), delta(12, 'lo')],
      cursor: '12',
      after: [delta(14, '?')],
      want: { text: 'Hello!?', output: '' },
    },
    // A finished turn after a reopen. Its stored events come from ReadChatTurnEvents, which carry
    // no cursor of their own.
    {
      name: 'stored events rebuild a finished turn the view never streamed',
      before: [],
      live: [],
      cursor: '20',
      after: [],
      stored: [[...fresh, done(13)]],
      want: { text: 'Hello', output: 'line\n' },
    },
    {
      name: 'stored events replace the tail the stream replayed before the read',
      before: [delta(11, 'Hello'), output(12, 'line\n')],
      live: [],
      cursor: '20',
      after: [],
      stored: [[...fresh, done(13)]],
      want: { text: 'Hello', output: 'line\n' },
    },
    {
      name: 'a stored turn read that lands twice shows its events once',
      before: [],
      live: [],
      cursor: '20',
      after: [],
      stored: [
        [...fresh, done(13)],
        [...fresh, done(13)],
      ],
      want: { text: 'Hello', output: 'line\n' },
    },
    {
      name: 'a stream event replayed after the stored events adds nothing',
      before: [],
      live: [],
      cursor: '10',
      after: [],
      stored: [[...fresh, done(13)]],
      late: [delta(11, 'Hello'), output(12, 'line\n')],
      want: { text: 'Hello', output: 'line\n' },
    },
    {
      // A later page failed, or the page cap ended the read. The turn shows what was read.
      name: 'a stored turn read that stopped early shows what it read and says so',
      before: [],
      live: [],
      cursor: '20',
      after: [],
      stored: [[started(10), delta(11, 'Hello')]],
      partial: true,
      want: { text: 'Hello', output: '' },
      note: "Part of this turn's history could not load.",
    },
  ];
  for (const {
    name,
    before,
    live,
    cursor,
    after,
    stored = [],
    late = [],
    partial = false,
    want,
    note,
  } of cases) {
    let state = reduceThread(initialThreadState(task), { type: 'events', events: before });
    state = reduceThread(state, {
      type: 'loaded',
      read: {
        thread,
        turns: [],
        messages: [],
        liveEvents: live.map((event) => event.payload as AgentEvent),
        cursor,
      },
    });
    state = reduceThread(state, { type: 'events', events: after });
    for (const events of stored)
      state = reduceThread(state, {
        type: 'history',
        turnId: turn,
        events: events.map((event) => event.payload as AgentEvent),
        partial,
      });
    state = reduceThread(state, { type: 'events', events: late });
    assert.deepEqual(shown(state), want, name);
    assert.equal(state.historyNotes[turn], note, `${name} (note)`);
  }
});

// A connected family on one model with one weekly window, or no window when the percent is null.
const connected = (name: ChatFamily, percent: number | null) => ({
  family: name,
  connected: true,
  reason: null,
  models: [{ model: 'm', label: 'M', efforts: [], defaultEffort: 'default' as const }],
  defaultModel: 'm',
  remaining:
    percent === null
      ? []
      : [{ windowId: 'weekly', label: 'Weekly', percent, resetsAt: null, observedAt: null }],
  accepts: null,
});

test('the offer ranks the other connected families by the thread mode and leaves out one at zero', () => {
  const catalog: ChatCatalogRead = {
    families: [
      connected('openai', 5),
      connected('anthropic', 60.9),
      connected('google', 0),
      connected('local', null),
    ],
  };
  // Anthropic leads on allowance, the local family has no figure and ranks last, and Google is
  // out because a turn there would end on the limit it already hit. OpenAI stopped.
  assert.deepEqual(
    offerChoices(catalog, 'openai').map(({ family, percent }) => [family, percent]),
    [
      ['anthropic', 60],
      ['local', null],
    ],
  );
  assert.deepEqual(
    offerChoices(catalog, 'anthropic').map(({ family }) => family),
    ['openai', 'local'],
  );
  // In resets-first mode the allowance that resets soonest goes first, while it lasts.
  const soon = {
    ...connected('google', 20),
    remaining: [
      { windowId: 'weekly', label: 'Weekly', percent: 20, resetsAt: stamp, observedAt: null },
    ],
  };
  const families = [connected('anthropic', 60.9), soon];
  assert.deepEqual(
    offerChoices({ families }, 'openai', 'resets-first').map(({ family }) => family),
    ['google', 'anthropic'],
  );
});

test("an empty pool for another model does not hold back the family's default model", () => {
  // Google reports a weekly pool for one model next to the family's own windows. The default
  // model still has 95% of the weekly window.
  const pooled = (percent: number, windowId: string) => ({
    windowId,
    label: windowId,
    percent,
    resetsAt: null,
    observedAt: null,
  });
  const google = {
    ...connected('google', null),
    models: [
      { model: 'acme-quick', label: 'Quick', efforts: [], defaultEffort: 'default' as const },
      { model: 'acme-deep', label: 'Deep', efforts: [], defaultEffort: 'default' as const },
    ],
    defaultModel: 'acme-quick',
    remaining: [pooled(95, 'acme-weekly'), pooled(100, 'acme-5h'), pooled(0, 'acme-deep-weekly')],
  };
  assert.deepEqual(
    offerChoices({ families: [connected('anthropic', 60.9), google] }, 'openai').map(
      ({ family, selection, percent }) => [family, selection.model, percent],
    ),
    [
      ['google', 'acme-quick', 95],
      ['anthropic', 'm', 60],
    ],
  );
});

test('reported file types decide the chip note and lead the Try with order', () => {
  // The chip note shows only on false. Null means the client reported nothing.
  const matches: [readonly string[] | null, string, boolean | null][] = [
    [null, 'image/png', null],
    [['image/*'], 'image/png', true],
    [['image/*'], 'application/pdf', false],
    [['application/pdf'], 'Application/PDF; version=1.7', true],
    [['*/*'], 'application/zip', true],
    [[], 'text/plain', false],
  ];
  for (const [accepts, mimeType, want] of matches)
    assert.equal(acceptsType(accepts, mimeType), want, `${accepts} ${mimeType}`);
  // The state a file gets: listed is native, unlisted is what the catalog says, nothing reported
  // says nothing. Only a file the family cannot receive at all warns on the chip.
  const delivery: [string[] | null, 'path' | 'none' | undefined, string, string | null, boolean][] =
    [
      [['image/*'], 'path', 'image/png', 'Anthropic takes this file as an image.', false],
      [
        ['image/*'],
        'path',
        'application/zip',
        'Sent as a file path. Anthropic can open it with its tools.',
        false,
      ],
      [
        ['image/*'],
        'none',
        'application/zip',
        'Anthropic cannot take this file. The turn will stop and offer another provider.',
        true,
      ],
      [null, 'none', 'application/zip', null, false],
      [['image/*'], undefined, 'application/zip', null, false],
    ];
  for (const [accepts, unlisted, mimeType, title, warn] of delivery) {
    const how = deliveryOf({ accepts, unlisted }, mimeType);
    const note = how && deliveryNote('Anthropic', how, mimeType);
    assert.equal(note?.title ?? null, title, `${accepts} ${unlisted} ${mimeType}`);
    assert.equal(note?.warn ?? false, warn, `${accepts} ${unlisted} ${mimeType}`);
  }
  const family = (name: ChatFamily, percent: number, accepts: string[] | null) => ({
    ...connected(name, percent),
    accepts,
  });
  const catalog: ChatCatalogRead = {
    families: [
      family('openai', 90, ['image/*']),
      family('anthropic', 60, ['image/*', 'application/pdf']),
      family('google', 80, null),
      family('local', 70, ['text/*']),
    ],
  };
  const order = (tried: ChatFamily[], types: string[], mode?: 'most-left' | 'local-first') =>
    tryWithChoices(catalog, tried, types, mode, (entry) => entry.defaultModel, 0).map(
      ({ family }) => family,
    );
  const rows: [string, ChatFamily[], string[], ChatFamily[], ('most-left' | 'local-first')?][] = [
    // Anthropic reports both types, so it leads although it has the least left.
    [
      'a family that takes every file leads',
      ['openai'],
      ['image/png', 'application/pdf'],
      ['anthropic', 'google', 'local'],
    ],
    [
      'the rest keep the allowance order',
      ['anthropic'],
      ['application/zip'],
      ['openai', 'google', 'local'],
    ],
    [
      'two that take the file keep their own order',
      ['google'],
      ['image/png'],
      ['openai', 'anthropic', 'local'],
    ],
    [
      'the handoff mode orders the rest',
      ['openai'],
      ['application/zip'],
      ['local', 'google', 'anthropic'],
      'local-first',
    ],
    [
      'every family tried leaves nothing',
      ['openai', 'anthropic', 'google', 'local'],
      ['image/png'],
      [],
    ],
  ];
  for (const [name, tried, types, want, mode] of rows)
    assert.deepEqual(order(tried, types, mode), want, name);
  // Each choice runs the family's default model.
  assert.deepEqual(
    tryWithChoices(
      catalog,
      ['openai', 'anthropic', 'google'],
      [],
      'most-left',
      (entry) => entry.defaultModel,
      0,
    ),
    [
      {
        family: 'local',
        selection: { family: 'local', model: 'm', effort: 'default' },
        label: 'M',
      },
    ],
  );
});

test('Load earlier pages older messages in by the oldest cursor until a page says there are none', () => {
  const message = (cursor: number): ChatMessage => ({
    id: id('msg', cursor),
    taskId: task,
    at: stamp,
    cursor: String(cursor),
    author: { kind: 'user' },
    text: `m${cursor}`,
    attachments: [],
    files: [],
  });
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => message(from + index));
  const thread: ChatThread = {
    taskId: task,
    scratchReady: true,
    base: null,
    selection: null,
    permissionPolicy: 'ask',
    sessions: [],
    activeTurnId: null,
    autoHandoff: false,
    handoffMode: 'most-left',
    crew: null,
    flightMode: 'manual',
    crewChain: null,
    queued: [],
  };
  const asking = (turnId: string, cursor: number): ChatTurn => ({
    id: turnId,
    taskId: task,
    sequence: 0,
    role: 'assistant',
    selection: { family: 'openai', model: 'large-1', effort: 'default' },
    userMessageId: id('msg', cursor),
    assistantMessageId: null,
    state: 'done',
    startedAt: stamp,
    endedAt: stamp,
    failure: null,
    handoffFrom: null,
  });
  const read = (messages: ChatMessage[], turns: ChatTurn[] = []): ChatThreadRead => ({
    thread,
    turns,
    messages,
    liveEvents: [],
    cursor: '9000',
  });
  const cursors = (state: ReturnType<typeof initialThreadState>) =>
    state.messages.map((item) => Number(item.cursor));
  const rows: {
    name: string;
    first: ChatThreadRead;
    pages: ChatMessage[][];
    want: string | null;
    count: number;
  }[] = [
    {
      name: 'a short thread has nothing older',
      first: read(page(1, 3)),
      pages: [],
      want: null,
      count: 3,
    },
    {
      name: 'a full page may have more behind it',
      first: read(page(500, THREAD_PAGE_SIZE)),
      pages: [],
      want: '500',
      count: THREAD_PAGE_SIZE,
    },
    {
      name: 'a turn whose message is not loaded says there is more',
      first: read(page(500, 3), [asking(turn, 7)]),
      pages: [],
      want: '500',
      count: 3,
    },
    {
      name: 'a short older page ends the paging and merges in order',
      first: read(page(500, THREAD_PAGE_SIZE)),
      pages: [page(400, 5)],
      want: null,
      count: THREAD_PAGE_SIZE + 5,
    },
    {
      name: 'a full older page asks from its own oldest cursor',
      first: read(page(500, THREAD_PAGE_SIZE)),
      pages: [page(100, THREAD_PAGE_SIZE)],
      want: '100',
      count: 2 * THREAD_PAGE_SIZE,
    },
    {
      name: 'an empty older page ends the paging',
      first: read(page(500, 3), [asking(turn, 7)]),
      pages: [[]],
      want: null,
      count: 3,
    },
  ];
  for (const { name, first, pages, want, count } of rows) {
    let state = reduceThread(initialThreadState(task), { type: 'loaded', read: first });
    for (const messages of pages)
      state = reduceThread(state, { type: 'earlier', read: read(messages, first.turns) });
    assert.equal(earlierCursor(state), want, name);
    assert.equal(state.messages.length, count, name);
    assert.deepEqual(
      cursors(state),
      cursors(state).toSorted((a, b) => a - b),
      name,
    );
    // The reload after a turn ends reads the newest page again and keeps the older pages.
    const reloaded = reduceThread(state, { type: 'loaded', read: first });
    assert.equal(reloaded.messages.length, count, `${name}, after a reload`);
    assert.equal(earlierCursor(reloaded), want, `${name}, after a reload`);
  }
});

test('the first read retries on the backoff and offers Try again only after ten seconds', async () => {
  let now = 0;
  const waits: number[] = [];
  const clock = {
    now: () => now,
    wait: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
  const options = { delays: FIRST_READ_BACKOFF, giveUpAfter: TRY_AGAIN_AFTER_MS };
  // A controller busy for a second and a half answers on the fourth try, with no failure shown.
  let calls = 0;
  const slow = () => (++calls < 4 ? Promise.reject(new Error('busy')) : Promise.resolve('read'));
  assert.equal(await retryRead(slow, clock, options), 'read');
  assert.deepEqual(waits, [250, 500, 1000]);
  // One that never answers fails once ten seconds have passed, the last delay repeating.
  now = 0;
  waits.length = 0;
  await assert.rejects(
    retryRead(() => Promise.reject(new Error('down')), clock, options),
    /down/,
  );
  assert.deepEqual(waits, [250, 500, 1000, 2000, 2000, 2000, 2000, 2000]);
  assert.ok(now >= TRY_AGAIN_AFTER_MS && now - 2000 < TRY_AGAIN_AFTER_MS);
});

test('an output limit and a model change reach the view with the numbers and the line the controller stored', () => {
  const limit = { reasoningTokens: 3900, replyTokens: 700, allowedTokens: 4600 };
  assert.equal(
    outputLimitLine(limit),
    'Reply stopped at the output limit: 3,900 reasoning and 700 reply of 4,600 allowed.',
  );
  assert.equal(outputSplit(limit), 'reasoning 3,900 · reply 700');
  // Every Local turn shows its split from the stats. The limit stands in for a turn without one.
  const stats: ChatTurnStats = {
    tokensIn: 5000,
    tokensOut: 1950,
    tokensPerSecond: null,
    firstTokenMs: null,
    turnMs: 1000,
    contextUsed: 6950,
    contextCapacity: 8192,
    summaries: 0,
  };
  const splits: [ChatTurnStats, typeof limit | null, string | null][] = [
    [{ ...stats, reasoningTokens: 1310, replyTokens: 640 }, null, 'reasoning 1,310 · reply 640'],
    [{ ...stats, reasoningTokens: 0, replyTokens: 1950 }, limit, 'reasoning 0 · reply 1,950'],
    [stats, limit, 'reasoning 3,900 · reply 700'],
    [stats, null, null],
  ];
  for (const [given, stopped, want] of splits) assert.equal(statsSplit(given, stopped), want);
  const meta = (
    n: number,
    model: string,
    startedAt: string,
    outputLimit?: typeof limit,
  ): ChatTurn => ({
    id: id('trn', n),
    taskId: task,
    sequence: n - 1,
    role: 'assistant',
    selection: { family: 'openai', model, effort: 'default' },
    userMessageId: id('msg', 10),
    assistantMessageId: null,
    state: 'done',
    startedAt,
    endedAt: startedAt,
    failure: null,
    handoffFrom: null,
    ...(outputLimit ? { outputLimit } : {}),
  });
  const note: ChatMessage = {
    id: id('msg', 20),
    taskId: task,
    at: '2026-10-23T10:05:00.000Z',
    cursor: '20',
    author: { kind: 'system', turnId: null },
    text: 'Continued on OpenAI (large-2) from OpenAI (large-1). Reason: model changed in the composer.',
    attachments: [],
    files: [],
  };
  const state = reduceThread(initialThreadState(task), {
    type: 'loaded',
    read: {
      thread: {
        taskId: task,
        scratchReady: true,
        base: null,
        selection: null,
        permissionPolicy: 'ask',
        sessions: [],
        activeTurnId: null,
        autoHandoff: false,
        handoffMode: 'most-left',
        crew: null,
        flightMode: 'manual',
        crewChain: null,
        queued: [],
      },
      turns: [
        meta(1, 'large-1', '2026-10-23T10:00:00.000Z', limit),
        meta(2, 'large-2', '2026-10-23T10:06:00.000Z'),
      ],
      messages: [
        user(10, 'Go').payload as ChatMessage,
        {
          ...note,
          id: id('msg', 11),
          cursor: '11',
          at: '2026-10-23T10:01:00.000Z',
          author: {
            kind: 'assistant',
            turnId: id('trn', 1),
            family: 'openai',
            model: 'large-1',
            role: 'assistant',
          },
          text: 'Partial reply',
        },
        note,
      ],
      liveEvents: [],
      cursor: '20',
    } as ChatThreadRead,
  });
  const items = threadItems(state);
  const first = items.find((row) => row.kind === 'turn' && row.turn.id === id('trn', 1));
  assert.deepEqual(first?.kind === 'turn' && first.turn.outputLimit, limit);
  // The view shows the line the controller stored, which already names both models.
  const line = items.find((row) => row.kind === 'system');
  assert.equal(line?.kind === 'system' && line.text, note.text);
});
