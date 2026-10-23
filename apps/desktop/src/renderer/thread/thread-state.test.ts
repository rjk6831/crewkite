// Frames assumed from the controller, one per event:
//   { type: 'agent.event', cursor: '12', taskId: <tsk>, payload: <AgentEvent> }
//   { type: 'conversation.entry', cursor: '10', taskId: <tsk>, payload: <ChatMessage> }
// A thread read has no cursor of its own. Messages carry theirs and live events do not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, ChatFailure, ChatMessage, ChatThreadRead } from '@crewkite/contracts';
import {
  initialThreadState,
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
const agent = (cursor: number, event: Body): ThreadEvent => ({
  type: 'agent.event',
  cursor: String(cursor),
  taskId: task,
  payload: { ...event, turnId: turn },
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
const started = (cursor: number) =>
  agent(cursor, {
    type: 'turn.started',
    family: 'openai',
    model: 'large-1',
    effort: 'default',
    role: 'assistant',
  });
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
