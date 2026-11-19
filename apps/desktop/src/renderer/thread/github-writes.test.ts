import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatBranchStatus, RemoteEffect } from '@crewkite/contracts';
import {
  checksSummary,
  mergeWait,
  pushShown,
  UNKNOWN_LINE,
  writeOpen,
  writeView,
} from './github-writes.ts';

// Claim: every write in the Changes tab reads as one of the six states, Cancel shows only while
// nothing was sent, Check only while the result is unknown, a refusal carries GitHub's reason, and
// a write the person settled after checking GitHub reads as their word. A push still unknown on an
// earlier branch is the push the tab shows, so its Check stays in reach and Push waits for it.
test('each write state reads as one label and offers only the actions it allows', () => {
  const refusedBy = 'Required checks are not green on 777777777777: verify (failure).';
  const done = 'You checked GitHub and marked this as done.';
  const notSent = 'You checked GitHub and marked this as not sent.';
  const rows: [
    RemoteEffect['state'],
    string | null,
    boolean,
    string,
    string | null,
    string[],
    settled?: true,
  ][] = [
    ['proposed', null, false, 'Waiting for you', null, ['confirm', 'cancel']],
    ['proposed', null, true, 'Sending', null, []],
    ['confirmed', null, false, 'Sending', null, ['cancel']],
    ['confirmed', null, true, 'Sending', null, []],
    ['sent', null, false, 'Sending', null, []],
    [
      'applied',
      'A pull request from this branch was already open.',
      false,
      'Done',
      'A pull request from this branch was already open.',
      [],
    ],
    ['refused', refusedBy, false, 'Refused', refusedBy, []],
    ['refused', null, false, 'Refused', 'GitHub refused it, and nothing changed there.', []],
    [
      'unknown',
      'gh ended without a result CrewKite can trust.',
      false,
      'Unknown',
      UNKNOWN_LINE,
      ['check'],
    ],
    ['cancelled', null, false, 'Cancelled', null, []],
    ['applied', done, false, 'Done', done, [], true],
    ['refused', notSent, false, 'Not sent', notSent, [], true],
  ];
  const by = { at: '2026-11-18T09:00:00.000Z', by: 'person', note: 'PR #42 is open.' } as const;
  for (const [state, reason, sending, label, text, actions, settled] of rows) {
    const view = writeView({ state, reason, ...(settled ? { settled: by } : {}) }, sending);
    assert.deepEqual([view.label, view.text, [...view.actions]], [label, text, actions], state);
  }

  const pushTo = (id: string, branch: string, state: RemoteEffect['state']) =>
    ({
      id,
      kind: 'push',
      state,
      target: { branch },
      request: { kind: 'push', remote: 'origin', commit: id.repeat(40), expectedRemote: null },
    }) as unknown as RemoteEffect;
  const earlier = pushTo('a', 'feat/net', 'unknown');
  const later = pushTo('b', 'feat/net-merge', 'applied');
  const touched = new Set(['b']);
  assert.equal(pushShown([earlier, later], 'feat/net-merge', touched), earlier);
  assert.equal(writeOpen(pushShown([earlier, later], 'feat/net-merge', touched)), true);
  const settledEarlier = { ...earlier, state: 'refused' } as RemoteEffect;
  assert.equal(pushShown([settledEarlier, later], 'feat/net-merge', touched), later);
  assert.equal(pushShown([settledEarlier, later], 'feat/other', touched), null);
});

const run = (name: string, status: string, conclusion: string | null) =>
  ({ name, status, conclusion }) as NonNullable<ChatBranchStatus['runs']>[number];

// Claim: Merge is offered only when nothing the tab can see stops it, and its reason says which
// check, head or draft state stops it, or what GitHub said when it refused. Unread runs leave the
// decision to the merge's own read.
test('merge waits with the reason while a check on the head is red or running, the head moved or the pull request is a draft', () => {
  const head = '7'.repeat(40);
  const green = [run('verify', 'completed', 'success'), run('lint', 'completed', 'skipped')];
  const blocked =
    'Branch protection blocks this merge. Get the reviews or checks it asks for, then merge.';
  const rows: [
    string,
    Pick<ChatBranchStatus, 'runs' | 'reason'>,
    { headMoved?: boolean; draft?: boolean; refused?: string },
    string,
    string | null,
  ][] = [
    ['green', { runs: green, reason: null }, {}, '2 checks passed on 7777777.', null],
    ['none ran', { runs: [], reason: null }, {}, 'No checks ran on 7777777.', null],
    ['unread', { runs: null, reason: 'gh is not installed.' }, {}, 'gh is not installed.', null],
    [
      'running',
      { runs: [green[0], run('e2e', 'in_progress', null)], reason: null },
      {},
      '1 of 2 checks still running on 7777777.',
      'Checks are still running on 7777777.',
    ],
    [
      'red',
      {
        runs: [green[0], run('e2e', 'completed', 'failure'), run('docs', 'completed', null)],
        reason: null,
      },
      {},
      'e2e, docs did not pass on 7777777. 1 of 3 passed.',
      'A check did not pass on 7777777. Rerun it or fix it, then merge.',
    ],
    [
      'head moved',
      { runs: green, reason: null },
      { headMoved: true, draft: true },
      '2 checks passed on 7777777.',
      'The branch moved on GitHub after 7777777, so this head cannot merge.',
    ],
    [
      'draft',
      { runs: green, reason: null },
      { draft: true },
      '2 checks passed on 7777777.',
      'The pull request is a draft. Mark it ready for review, then merge.',
    ],
    [
      'refused by GitHub',
      { runs: green, reason: null },
      { refused: blocked },
      '2 checks passed on 7777777.',
      blocked,
    ],
  ];
  for (const [name, status, pr, line, wait] of rows) {
    const checks = checksSummary({ ...status, commit: head });
    const why = mergeWait({ headMoved: false, draft: false, ...pr, head, checks });
    assert.deepEqual([checks.line, why], [line, wait], name);
  }
});
