import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type AcceptanceAttempt,
  type ChatCheckRun,
  ChatCheckRunSchema,
  type ChatPlanState,
  type ChatThread,
  ChatThreadSchema,
  type DependencyPreparation,
  type RemoteEffect,
} from '@crewkite/contracts';
import { holds, workRows } from './work-view.ts';

const turn = (n: number) => `trn_0${String(n).padStart(25, '0')}`;
const owner = { family: 'openai' as const, model: 'gpt-5.2', reason: "Builder, the crew's model" };

function plan(
  phase: ChatPlanState['phase'],
  statuses: ChatPlanState['slices'][number]['status'][],
  lane?: NonNullable<ChatPlanState['slices'][number]['lane']>,
): ChatPlanState {
  // Slices 1 and 2 start together, 3 runs after both and 4 after 3.
  const depends = [[], [], [1, 2], [3]];
  return {
    planId: 'net-minor',
    orchestratorTurnId: turn(9),
    goal: 'Add netMinor to net.mjs',
    phase,
    slices: statuses.map((status, index) => ({
      id: index + 1,
      title: `Slice ${index + 1}`,
      difficulty: 'medium',
      depends: depends[index],
      readOnly: false,
      status,
      assignment: owner,
      candidates: [],
      turnId: status === 'queued' ? null : turn(index + 1),
      ...(status === 'running' && lane ? { lane } : {}),
    })),
  };
}

let minted = 0;
const run = (
  slice: number | undefined,
  trigger: ChatCheckRun['trigger'],
  label: string,
  status: ChatCheckRun['status'],
  startedAt: string,
  durationMs: number,
): ChatCheckRun =>
  ChatCheckRunSchema.parse({
    id: `chk_${String(++minted).padStart(32, '0')}`,
    checkId: label,
    label,
    command: `npm run ${label}`,
    trigger,
    ...(slice === undefined ? {} : { slice }),
    status,
    reason: status === 'failed' ? 'Exit code 1.' : null,
    startedAt,
    durationMs: status === 'running' ? null : durationMs,
    exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
    tail: '',
    stdout: null,
    stderr: null,
  });

// Claim: each slice row names its owner, its standing in words, the slices it runs after and the
// newest result of its own checks and of the checks after it merged. A slice waits on slices that
// still run and is blocked by ones that failed or did not run, and a proposed plan only queues.
// A run counts for a slice only when the controller recorded that slice on it.
test('slice rows carry owner, standing, dependencies and their own check results', () => {
  const runs = [
    run(1, 'after-write', 'test', 'passed', '2026-11-18T10:00:00.000Z', 2000),
    run(1, 'after-write', 'lint', 'passed', '2026-11-18T10:00:03.000Z', 1000),
    run(1, 'combined', 'test', 'passed', '2026-11-18T10:05:00.000Z', 3000),
    run(2, 'after-write', 'test', 'failed', '2026-11-18T10:01:00.000Z', 1500),
    run(2, 'after-write', 'lint', 'passed', '2026-11-18T10:01:02.000Z', 500),
    run(2, 'after-write', 'test', 'failed', '2026-11-18T10:04:00.000Z', 1200),
    run(undefined, 'manual', 'test', 'passed', '2026-11-18T10:06:00.000Z', 900),
  ];
  const running = workRows(
    plan('running', ['done', 'running', 'queued', 'queued'], {
      step: 'fix',
      pending: false,
      rounds: 0,
      fixes: 1,
      build: turn(2),
    }),
    runs,
  );
  assert.deepEqual(
    running.map(({ id, owner: who, status, tone, after, turnId, checks, merged, depth }) => ({
      id,
      who,
      status,
      tone,
      after,
      turnId,
      checks,
      merged,
      depth,
    })),
    [
      {
        id: 1,
        who: owner,
        status: 'Done',
        tone: 'done',
        after: null,
        turnId: turn(1),
        checks: { result: 'passed', at: '2026-11-18T10:00:04.000Z', failed: [] },
        merged: { result: 'passed', at: '2026-11-18T10:05:03.000Z', failed: [] },
        depth: 0,
      },
      {
        id: 2,
        who: owner,
        status: 'Fixing',
        tone: 'running',
        after: null,
        turnId: turn(2),
        checks: { result: 'failed', at: '2026-11-18T10:04:01.200Z', failed: ['test'] },
        merged: null,
        depth: 0,
      },
      {
        id: 3,
        who: owner,
        status: 'Waiting on slice 2',
        tone: 'waiting',
        after: 'After slices 1 and 2',
        turnId: null,
        checks: null,
        merged: null,
        depth: 1,
      },
      {
        id: 4,
        who: owner,
        status: 'Waiting on slice 3',
        tone: 'waiting',
        after: 'After slice 3',
        turnId: null,
        checks: null,
        merged: null,
        depth: 2,
      },
    ],
  );
  const standing = (rows: ReturnType<typeof workRows>) => rows.map(({ status }) => status);
  assert.deepEqual(
    standing(workRows(plan('stopped', ['done', 'failed', 'not-run', 'not-run']), [])),
    ['Done', 'Failed', 'Blocked by slice 2', 'Blocked by slice 3'],
  );
  assert.deepEqual(
    standing(workRows(plan('proposed', ['queued', 'queued', 'queued', 'queued']), [])),
    ['Queued', 'Queued', 'Queued', 'Queued'],
  );
});

const TASK = 'tsk_01JQ0000000000000000000000';
const thread = (patch: Partial<ChatThread> = {}): ChatThread =>
  ChatThreadSchema.parse({
    taskId: TASK,
    scratchReady: true,
    base: null,
    selection: null,
    ...patch,
  });
const effect = (kind: RemoteEffect['kind'], state: RemoteEffect['state']) =>
  ({ kind, state }) as RemoteEffect;
const prepared = (state: DependencyPreparation['state'], reason: DependencyPreparation['reason']) =>
  ({ scope: 'thread', state, reason }) as DependencyPreparation;
const proposed = plan('proposed', ['queued', 'queued', 'queued', 'queued']);
const stopped = 'Crew stopped: the checks could not run. Dependencies need preparation.';
const ask = {
  items: [],
  ask: {
    requestId: `chkask_${'a'.repeat(32)}`,
    trigger: 'after-write' as const,
    commands: [],
    changed: [],
  },
  approved: null,
  runs: [],
  detectedAt: null,
};

// Claim: the Work tab names everything that holds the thread now, one line each with the step
// that clears it, and nothing that has ended or settled. The newest record of the thread's own
// dependency copy decides whether it needs preparing. A copy never prepared has no record, so the
// line the checks wrote when they could not run names it until a preparation ends after it. Only
// a copy that preparing again can fix offers Prepare dependencies.
test('holds name what blocks the thread and the next step for each', () => {
  type Input = Parameters<typeof holds>[0];
  const none: Input = { thread: thread(), turns: [], accept: null, effects: [], preparations: [] };
  const rows: [string, Partial<Input>, string[]][] = [
    ['nothing holds', {}, []],
    [
      'an unconfirmed process',
      { thread: thread({ ownershipUnknown: true }) },
      [
        'CrewKite cannot confirm that a process this thread started has ended, so the thread is held. It checks again with each message. [Release the thread]',
      ],
    ],
    [
      'a permission question',
      { turns: [{ state: 'done' }, { state: 'waiting-permission' }] },
      ['A turn waits for your permission. Answer it in the thread.'],
    ],
    [
      'a checks question',
      { thread: thread({ checks: ask }) },
      ['The checks wait for your answer. Allow or deny them on the Checks card in the thread.'],
    ],
    [
      'a plan Balanced has not run',
      { thread: thread({ plan: proposed, flightMode: 'balanced' }) },
      ['The plan waits for you. Choose Run plan on the plan card.'],
    ],
    [
      'a plan Manual has not run',
      { thread: thread({ plan: proposed, flightMode: 'manual' }) },
      ['The plan waits for you. Choose Run plan, or Run on one slice, on the plan card.'],
    ],
    ['a plan Glide starts itself', { thread: thread({ plan: proposed, flightMode: 'glide' }) }, []],
    [
      'an Accept running its checks',
      { accept: { state: 'checking', branch: 'feat/net-minor' } as AcceptanceAttempt },
      [
        'Accept is running the required checks for feat/net-minor. Wait for them, or cancel the Accept in Changes.',
      ],
    ],
    [
      'an Accept writing its branch',
      { accept: { state: 'publishing', branch: 'feat/net-minor' } as AcceptanceAttempt },
      ['Accept is writing feat/net-minor. Wait for it to finish.'],
    ],
    [
      'GitHub writes without a result',
      {
        effects: [
          effect('push', 'unknown'),
          effect('push', 'unknown'),
          effect('pr-open', 'sent'),
          effect('merge', 'applied'),
          effect('pr-update', 'proposed'),
        ],
      },
      [
        'A push is unknown. Check it under GitHub in Changes.',
        'A new pull request is on its way to GitHub. Wait for its result in Changes.',
      ],
    ],
    [
      'a stale dependency copy',
      { preparations: [prepared('prepared', null), prepared('stale', 'stale-lockfile')] },
      [
        'Dependencies need preparation. The lockfile changed. Prepare them again before the next check or Accept. [Prepare dependencies]',
      ],
    ],
    [
      'a copy prepared again since',
      { preparations: [prepared('stale', 'stale-lockfile'), prepared('prepared', null)] },
      [],
    ],
    [
      'an unsupported dependency copy',
      { preparations: [prepared('unsupported', 'yarn-pnp')] },
      [
        'Yarn Plug and Play is not supported. Checks and Accept cannot run in this copy until that changes.',
      ],
    ],
    [
      'a copy over the size limit',
      { preparations: [prepared('failed', 'size-limit')] },
      [
        'The installed dependencies are larger than the copy limit. Nothing was copied. Checks and Accept cannot run in this copy until that changes.',
      ],
    ],
    [
      'a copy never prepared that the checks named',
      { lines: [{ text: stopped, at: '2026-11-18T10:05:00.000Z' }] },
      [
        'Dependencies need preparation. Prepare them before the next check or Accept. [Prepare dependencies]',
      ],
    ],
    [
      'a copy prepared after the checks named it',
      {
        preparations: [{ ...prepared('prepared', null), preparedAt: '2026-11-18T10:06:00.000Z' }],
        lines: [{ text: stopped, at: '2026-11-18T10:05:00.000Z' }],
      },
      [],
    ],
    [
      'a copy being prepared',
      { preparations: [prepared('preparing', null)] },
      [
        'Dependencies are being prepared for this copy. Wait for it before the next check or Accept.',
      ],
    ],
    [
      'a merge waiting in the copy',
      {
        thread: thread({
          pendingMerge: {
            remote: 'origin',
            branch: 'main',
            target: 'feat/net-minor',
            paths: ['net.mjs'],
          },
        }),
      },
      ['A merge from origin/main waits in the copy. Accept it to feat/net-minor in Changes.'],
    ],
    [
      'a paused queue',
      {
        thread: thread({
          queuePaused: true,
          queued: [
            {
              id: 'msg_01JQ0000000000000000000001',
              at: '2026-11-18T10:00:00.000Z',
              text: 'Also cover zero.',
              role: 'assistant',
              attachments: [],
              files: [],
            },
          ],
        }),
      },
      ['The queue is paused. Send now or remove each waiting message.'],
    ],
  ];
  for (const [name, patch, expected] of rows)
    assert.deepEqual(
      holds({ ...none, ...patch }).map(
        ({ reason, action, prepare, release }) =>
          `${reason} ${action}${prepare ? ' [Prepare dependencies]' : ''}${release ? ' [Release the thread]' : ''}`,
      ),
      expected,
      name,
    );
});
