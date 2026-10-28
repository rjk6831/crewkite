import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type NoticeMemory,
  type NoticeView,
  type RailEvent,
  removedThread,
  threadNotices,
} from './rail-activity.ts';

const open = `tsk_${'0'.repeat(25)}1`;
const other = `tsk_${'0'.repeat(25)}2`;
const turn = `trn_${'0'.repeat(25)}1`;

test('a finished or failed reply, a waiting permission and a crew end post a notice unless that thread is in view', () => {
  let cursor = 10;
  const at = (taskId: string, type: string, payload: object): RailEvent => {
    cursor += 1;
    return { type, cursor: String(cursor), taskId, payload };
  };
  const streamed = (taskId: string, payload: object) =>
    at(taskId, 'agent.event', { turnId: turn, ...payload });
  const done = (taskId: string) => streamed(taskId, { type: 'turn.completed', stopReason: 'done' });
  const asked = (taskId: string, requestId = 'ask-1') =>
    streamed(taskId, { type: 'permission.requested', requestId });
  const chain = (taskId: string, step: string | null) =>
    at(taskId, 'chat.thread', { crewChain: step ? { step } : null });
  const focusedOn = (openThreadId: string | null): NoticeView => ({ focused: true, openThreadId });
  const away: NoticeView = { focused: false, openThreadId: open };
  const rows: [string, () => RailEvent[], NoticeView, string[]][] = [
    ['a reply finishing in the open thread posts nothing', () => [done(open)], focusedOn(open), []],
    ['a reply finishing while unfocused posts one', () => [done(open)], away, [`${open}:reply`]],
    [
      'a reply finishing in another thread posts one',
      () => [done(other)],
      focusedOn(open),
      [`${other}:reply`],
    ],
    [
      'a stopped reply posts nothing',
      () => [streamed(other, { type: 'turn.completed', stopReason: 'stopped' })],
      away,
      [],
    ],
    [
      'a reply that ends in an error or a usage limit while unfocused posts a failed notice',
      () => [
        streamed(other, { type: 'turn.completed', stopReason: 'error' }),
        streamed(open, { type: 'turn.completed', stopReason: 'limit' }),
      ],
      away,
      [`${other}:failed`, `${open}:failed`],
    ],
    [
      'a failed reply in the open thread posts nothing',
      () => [streamed(open, { type: 'turn.completed', stopReason: 'error' })],
      focusedOn(open),
      [],
    ],
    [
      'a failed step inside a running crew chain posts nothing',
      () => [chain(other, 'fix'), streamed(other, { type: 'turn.completed', stopReason: 'error' })],
      away,
      [],
    ],
    [
      'a permission request in another thread posts one',
      () => [asked(other)],
      focusedOn(open),
      [`${other}:permission`],
    ],
    [
      'a request answered within the batch posts nothing',
      () => [asked(other), streamed(other, { type: 'permission.resolved', requestId: 'ask-1' })],
      away,
      [],
    ],
    [
      'two requests on one thread in a batch post one notice',
      () => [asked(other, 'ask-1'), asked(other, 'ask-2')],
      away,
      [`${other}:permission`],
    ],
    [
      'turns inside a crew chain post nothing until the chain finishes',
      () => [
        done(other),
        chain(other, 'review'),
        done(other),
        chain(other, 'fix'),
        done(other),
        chain(other, 'finished'),
      ],
      focusedOn(open),
      [`${other}:reply`, `${other}:crew`],
    ],
    [
      'a chain that stops says so',
      () => [chain(other, 'challenge'), chain(other, 'stopped')],
      away,
      [`${other}:crew-stopped`],
    ],
    [
      'a finished chain read again posts nothing',
      () => [chain(other, 'finished'), chain(other, 'finished')],
      away,
      [],
    ],
    [
      'the crew end in the open thread posts nothing',
      () => [chain(open, 'review'), chain(open, 'finished')],
      focusedOn(open),
      [],
    ],
  ];
  for (const [claim, events, view, expected] of rows) {
    const batch = events();
    const memory: NoticeMemory = { since: 10n, chains: new Map() };
    const first = threadNotices(batch, view, memory);
    assert.deepEqual(
      first.notices.map((notice) => `${notice.taskId}:${notice.kind}`),
      expected,
      claim,
    );
    // Events the window already folded, or that came before it opened, never post again.
    assert.deepEqual(threadNotices(batch, away, first.memory).notices, [], `${claim} (replay)`);
  }

  // A deleted thread leaves the rail on the controller's task.removed event, whoever deleted it,
  // and the event posts no notice.
  const removal = (type: string, payload: unknown): RailEvent => ({
    type,
    cursor: '99',
    taskId: open,
    payload,
  });
  assert.equal(removedThread(removal('task.removed', { taskId: other })), other);
  assert.equal(removedThread(removal('task.removed', null)), open);
  assert.equal(removedThread(removal('task.updated', { taskId: other })), null);
  assert.deepEqual(
    threadNotices([removal('task.removed', { taskId: open })], away, {
      since: 10n,
      chains: new Map(),
    }).notices,
    [],
  );
});
