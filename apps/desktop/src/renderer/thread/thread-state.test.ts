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
  ChatMessage,
  ChatThread,
  ChatThreadRead,
  ChatTurn,
} from '@crewkite/contracts';
import { limitOffer, offerChoices } from './handoff-offer.ts';
import {
  initialThreadState,
  lastFamily,
  reduceThread,
  type ThreadEvent,
  type ThreadItem,
  threadItems,
} from './thread-state.ts';

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

  // Messages count on the conversation, 13 and 15, and agent events on the event log, 616 and 657.
  // A turn still sits right after the user message that started it.
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
        pending: { localId: 'local-1', text: 'Add the guard', attachments: [], at: stamp },
      });
    return limitOffer(state);
  };
  const stopped = [user(10, 'Add the guard'), begin(turn, 11), end(turn, 12, 'limit')];

  assert.deepEqual(offer(stopped), { turnId: turn, family: 'openai' });
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

  // A second opinion borrows another family for one turn. The picker still moves the thread away
  // from the family that answered, so it never offers that family as the place to continue.
  const advisor = id('trn', 3);
  const advised = run([
    begin(turn, 11),
    agent(12, { type: 'text.completed', itemId: 'a', text: 'Done.' }),
    end(turn, 13, 'done'),
    on(advisor, 14, {
      type: 'turn.started',
      family: 'local',
      model: 'local-1',
      effort: 'default',
      role: 'advisor',
    }),
    on(advisor, 15, { type: 'text.completed', itemId: 'a', text: 'Looks right.' }),
    end(advisor, 16, 'done'),
  ]);
  assert.equal(lastFamily(advised), 'openai');
});

test('a reply restored from a thread read keeps the role of its turn for the badge', () => {
  const read = (role: 'reviewer' | 'advisor'): ChatThreadRead => ({
    thread: {
      taskId: task,
      scratchReady: true,
      base: null,
      selection: null,
      permissionPolicy: 'ask',
      sessions: [],
      activeTurnId: null,
      autoHandoff: false,
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
      },
    ],
    messages: [
      {
        id: id('msg', 11),
        taskId: task,
        at: stamp,
        cursor: '11',
        author: { kind: 'assistant', turnId: turn, family: 'google', model: 'large-2', role },
        text: 'Two findings.',
        attachments: [],
      },
    ],
    liveEvents: [],
    cursor: '11',
  });
  for (const role of ['reviewer', 'advisor'] as const) {
    const state = reduceThread(initialThreadState(task), { type: 'loaded', read: read(role) });
    assert.deepEqual(
      turnOf(threadItems(state)).identity,
      { family: 'google', model: 'large-2', effort: 'default', role },
      role,
    );
  }
});

test('stream events that a thread read already covers apply once', () => {
  const thread: ChatThread = {
    taskId: task,
    scratchReady: true,
    base: null,
    selection: null,
    permissionPolicy: 'ask',
    sessions: [],
    activeTurnId: turn,
    autoHandoff: false,
  };
  const delta = (cursor: number, text: string) =>
    agent(cursor, { type: 'text.delta', itemId: 'a', text });
  const output = (cursor: number, chunk: string) =>
    agent(cursor, { type: 'tool.output', callId: 'c1', chunk });
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
  ];
  for (const { name, before, live, cursor, after, want } of cases) {
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
    assert.deepEqual(shown(state), want, name);
  }
});

test('the offer ranks the other connected families by allowance and leaves out one at zero', () => {
  const models = [{ model: 'm', label: 'M', efforts: [], defaultEffort: 'default' as const }];
  const family = (name: ChatCatalogRead['families'][number]['family'], percent: number | null) => ({
    family: name,
    connected: true,
    reason: null,
    models,
    defaultModel: 'm',
    remaining:
      percent === null
        ? []
        : [{ windowId: 'weekly', label: 'Weekly', percent, resetsAt: null, observedAt: null }],
  });
  const catalog: ChatCatalogRead = {
    families: [
      family('openai', 5),
      family('anthropic', 60.9),
      family('google', 0),
      family('local', null),
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

  // Google reports a weekly pool for one model next to the family's own windows. The empty pool
  // does not hold back the default model, which still has 95% of the weekly window.
  const pooled = (percent: number, windowId: string) => ({
    windowId,
    label: windowId,
    percent,
    resetsAt: null,
    observedAt: null,
  });
  const google = {
    ...family('google', null),
    models: [
      { model: 'acme-quick', label: 'Quick', efforts: [], defaultEffort: 'default' as const },
      { model: 'acme-deep', label: 'Deep', efforts: [], defaultEffort: 'default' as const },
    ],
    defaultModel: 'acme-quick',
    remaining: [pooled(95, 'acme-weekly'), pooled(100, 'acme-5h'), pooled(0, 'acme-deep-weekly')],
  };
  assert.deepEqual(
    offerChoices({ families: [catalog.families[1], google] }, 'openai').map(
      ({ family, selection, percent }) => [family, selection.model, percent],
    ),
    [
      ['google', 'acme-quick', 95],
      ['anthropic', 'm', 60],
    ],
  );
});
