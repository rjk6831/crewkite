import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, ChatThreadRead } from '@crewkite/contracts';
import {
  initialThreadState as initialThread,
  liveSignals,
  reduceThread,
  threadItems,
} from './thread-state.ts';
import { applyEvent, blankTurn } from './turn-fold.ts';

// Claim: a turn's blocks read in the order they arrived, also when a client sends a later message
// under an item id it used before (H6).
test('a later message under a reused item id lands after the tool calls that came before it', () => {
  const turnId = 'trn_01M51M322B2AEBXD9MA74CBCFM';
  const events: AgentEvent[] = [
    { type: 'text.delta', turnId, itemId: 'm', text: 'I will read the files.' },
    { type: 'text.completed', turnId, itemId: 'm', text: 'I will read the files.' },
    { type: 'tool.started', turnId, callId: 'c1', kind: 'read', title: 'src/money.js', input: {} },
    { type: 'tool.completed', turnId, callId: 'c1', status: 'ok' },
    { type: 'text.delta', turnId, itemId: 'm', text: 'The total ' },
    { type: 'text.delta', turnId, itemId: 'm', text: 'rounds once.' },
    { type: 'text.completed', turnId, itemId: 'm', text: 'The total rounds once.' },
    // A repeat of the finished text changes nothing.
    { type: 'text.completed', turnId, itemId: 'm', text: 'The total rounds once.' },
  ];
  const view = events.reduce(applyEvent, blankTurn(turnId));
  assert.deepEqual(
    view.blocks.map((block) =>
      block.kind === 'text' ? `text:${block.text}` : `${block.kind}:${block.id}`,
    ),
    ['text:I will read the files.', 'tool:tool:c1', 'text:The total rounds once.'],
  );
});

// Claim: once the controller says a turn stopped, its history shows no running tool and no ask
// with live buttons, also when the stream never delivered the turn's end.
test('a turn the controller reports stopped shows nothing running and no open ask', () => {
  const taskId = 'tsk_01M51M322B2AEBXD9MA74CBCFM';
  const turnId = 'trn_01M51M322B2AEBXD9MA74CBCFM';
  const stamp = '2026-11-04T10:00:00.000Z';
  const events: AgentEvent[] = [
    {
      type: 'turn.started',
      turnId,
      family: 'openai',
      model: 'm',
      effort: 'default',
      role: 'assistant',
    },
    { type: 'tool.started', turnId, callId: 'c1', kind: 'command', title: 'sleep 120', input: {} },
    {
      type: 'permission.requested',
      turnId,
      requestId: 'p1',
      callId: null,
      question: 'Run this command?',
      detail: '/bin/sleep 120',
      options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }],
    },
  ];
  const read: ChatThreadRead = {
    thread: {
      taskId,
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
        id: turnId,
        taskId,
        sequence: 0,
        role: 'assistant',
        selection: { family: 'openai', model: 'm', effort: 'default' },
        userMessageId: 'msg_01M51M322B2AEBXD9MA74CBCFM',
        assistantMessageId: null,
        state: 'stopped',
        startedAt: stamp,
        endedAt: stamp,
        failure: null,
        handoffFrom: null,
        stopReason: 'stopped',
      },
    ],
    messages: [],
    liveEvents: [],
    cursor: '20',
  };
  let state = reduceThread(initialThread(taskId), {
    type: 'events',
    events: events.map((payload, at) => ({
      type: 'agent.event',
      cursor: String(at + 10),
      taskId,
      payload,
    })),
  });
  state = reduceThread(state, { type: 'loaded', read });
  const items = threadItems(state);
  const found = items.find((item) => item.kind === 'turn');
  assert.ok(found?.kind === 'turn');
  const { turn } = found;
  assert.equal(turn.ended, true);
  assert.equal(turn.status, 'stopped');
  const tool = turn.blocks.find((block) => block.kind === 'tool');
  assert.equal(tool?.kind === 'tool' && tool.status, 'stopped');
  assert.equal(liveSignals(items).requests.size, 0);
});
