import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ChatThread,
  ChatThreadSchema,
  type ChatTurn,
  ChatTurnSchema,
  type Task,
} from '@crewkite/contracts';
import { Store } from '../store/index.ts';
import { BRACKET_MS, readAnalytics } from './analytics.ts';

// Claim: the analytics a thread and a project report are derived from the rows the controller
// already keeps, a value no client reported stays null, and allowance is charged to a turn only
// when two readings bracket it without another turn of the family in between. The fixture thread
// has two families, a handoff, a failed and a passed check, an accepted branch, a turn that
// reported tokens in and not out, turns that reported none and a turn still running.

const id = (prefix: string, number: number) => `${prefix}_${String(number).padStart(26, '0')}`;
const at = (time: string) => `2026-10-20T${time}.000Z`;
const RESET = '2026-10-20T15:00:00.000Z';
const projectId = id('prj', 1);
const threadId = id('tsk', 1);
const otherId = id('tsk', 2);

function fixture(t: { after: (run: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-analytics-'));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  let events = 0;
  const task = (taskId: string, title: string): Task => ({
    id: taskId,
    projectId,
    title,
    outcome: 'Measure the thread',
    criteria: ['The numbers match the rows'],
    state: 'draft',
    waitingReason: null,
    revision: 0,
    runId: null,
    next: null,
  });
  const append = (type: string, taskId: string | null, payload: unknown) =>
    store.transaction(() =>
      store.append({
        protocol: 1,
        id: id('evt', ++events),
        at: at('09:00:00'),
        taskId,
        revision: 0,
        type,
        payload,
      } as never),
    );
  store.transaction(() => {
    store.put('project', projectId, 0, { id: projectId, name: 'demo-shop', revision: 0 });
    store.put('task', threadId, 0, task(threadId, 'Fixture thread'));
    store.put('task', otherId, 0, task(otherId, 'Second thread'));
    store.put('route', id('rte', 1), 0, { id: id('rte', 1), family: 'openai' });
  });
  const stats = (tokensIn: number | null, tokensOut: number | null) => ({
    tokensIn,
    tokensOut,
    tokensPerSecond: null,
    firstTokenMs: null,
    turnMs: 1000,
    contextUsed: null,
    contextCapacity: null,
    summaries: 0,
  });
  let sequence = 0;
  const turn = (
    taskId: string,
    family: ChatTurn['selection']['family'],
    startedAt: string,
    endedAt: string | null,
    extra: Partial<ChatTurn> = {},
  ) => {
    const value = ChatTurnSchema.parse({
      id: id('trn', ++sequence),
      taskId,
      sequence,
      role: 'assistant',
      selection: { family, model: 'model-a', effort: 'default' },
      userMessageId: id('msg', sequence),
      assistantMessageId: null,
      state: endedAt === null ? 'running' : 'done',
      startedAt,
      endedAt,
      failure: null,
      ...extra,
    });
    store.db
      .prepare('INSERT INTO chat_turns(id,task_id,sequence,body) VALUES (?,?,?,?)')
      .run(value.id, taskId, sequence, JSON.stringify(value));
    return value;
  };
  const run = (number: number, status: 'passed' | 'failed') => ({
    id: `chk_${number.toString(16).padStart(32, '0')}`,
    checkId: 'package.json:test',
    label: 'test',
    command: 'npm run test',
    trigger: 'fix' as const,
    status,
    reason: null,
    startedAt: at('10:05:00'),
    durationMs: 1000,
    exitCode: status === 'passed' ? 0 : 1,
    tail: '',
    stdout: null,
    stderr: null,
  });
  const record = (taskId: string, extra: Partial<ChatThread>) =>
    ChatThreadSchema.parse({ taskId, scratchReady: true, base: null, selection: null, ...extra });
  const putThread = (value: ChatThread, journal: boolean) => {
    store.db
      .prepare(
        'INSERT INTO chat_threads(task_id,body) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body',
      )
      .run(value.taskId, JSON.stringify(value));
    if (journal) append('chat.thread', value.taskId, value);
  };
  const reading = (clock: string, value: number, resetsAt = RESET) =>
    append('usage.observed', null, {
      routeId: id('rte', 1),
      windowId: 'primary',
      kind: 'rolling',
      remaining: { value, unit: 'percent' },
      resetsAt,
      observedAt: at(clock),
      source: 'provider',
      confidence: 'reported',
    });
  const anthropicReading = (clock: string, value: number) =>
    append('usage.reader-updated', null, {
      id: 'anthropic-usage-v1',
      family: 'anthropic',
      clientVersion: 'client-a',
      available: true,
      reason: 'available',
      lastObservedAt: null,
      reading: {
        source: 'turn-rate-limit',
        status: 'reported',
        receivedAt: at(clock),
        observedAt: null,
        freshness: 'unknown',
        windows: [
          { windowId: 'five-hour', remaining: { value, unit: 'percent' }, resetsAt: RESET },
        ],
        extraUsage: null,
        model: null,
        modelTurns: 0,
        qualified: false,
      },
    });
  return { store, turn, stats, run, record, putThread, reading, anthropicReading };
}

test('thread analytics count what the rows hold and leave unreported values unknown', (t) => {
  const f = fixture(t);
  const first = f.turn(threadId, 'openai', at('10:00:00'), at('10:01:00'), {
    stats: f.stats(1000, 200),
  });
  const second = f.turn(threadId, 'openai', at('10:02:00'), at('10:02:30'), {
    role: 'reviewer',
    stats: f.stats(500, null),
  });
  const third = f.turn(threadId, 'anthropic', at('10:10:00'), at('10:12:00'), {
    handoffFrom: 'openai',
  });
  const fourth = f.turn(threadId, 'anthropic', at('10:30:00'), at('10:31:00'), {
    state: 'stopped',
  });
  const fifth = f.turn(threadId, 'anthropic', at('10:40:00'), null);

  // The gauge: OpenAI reads before and after both turns, Anthropic before and after the third.
  f.reading('09:59:00', 90);
  f.reading('10:01:30', 88);
  f.reading('10:03:00', 87.5);
  f.anthropicReading('10:09:00', 70);
  f.anthropicReading('10:12:30', 66);

  // The journal holds an older version of the record with a run and a branch that the newest
  // record, which keeps a shorter list of runs and only the last branch, no longer names.
  f.putThread(
    f.record(threadId, {
      checks: {
        items: [],
        ask: null,
        approved: null,
        runs: [f.run(1, 'passed')],
        detectedAt: null,
      },
      lastAcceptance: { branch: 'feat/first', at: at('10:20:00'), fileCount: 2, commit: null },
    }),
    true,
  );
  f.putThread(
    f.record(threadId, {
      checks: {
        items: [],
        ask: null,
        approved: null,
        runs: [f.run(2, 'failed'), f.run(3, 'passed')],
        detectedAt: null,
      },
      lastAcceptance: { branch: 'feat/second', at: at('10:50:00'), fileCount: 3, commit: null },
      plan: {
        planId: 'plan-a',
        orchestratorTurnId: first.id,
        goal: 'Measure it',
        phase: 'finished',
        slices: [1, 2, 3].map((number) => ({
          id: number,
          title: `Slice ${number}`,
          difficulty: 'easy' as const,
          depends: [],
          readOnly: false,
          status: number === 3 ? ('failed' as const) : ('done' as const),
          assignment: null,
          candidates: [],
          turnId: null,
        })),
      },
    }),
    true,
  );
  assert.ok(second && third && fourth && fifth);

  const read = readAnalytics(f.store, { scope: 'thread', taskId: threadId }, at('11:00:00'));
  assert.ok(read);
  assert.deepEqual(
    {
      name: read.name,
      turns: read.turns,
      openTurns: read.openTurns,
      handoffs: read.handoffs,
      wallMs: read.wallMs,
      tokensIn: read.tokensIn,
      tokensOut: read.tokensOut,
      tokenTurns: read.tokenTurns,
      checks: [read.checksRun, read.checksPassed, read.checksFailed],
      branchesAccepted: read.branchesAccepted,
      slices: read.slices,
      threads: read.threads,
    },
    {
      name: 'Fixture thread',
      turns: 5,
      openTurns: 1,
      handoffs: 1,
      wallMs: 60_000 + 30_000 + 120_000 + 60_000,
      tokensIn: 1500,
      tokensOut: 200,
      tokenTurns: 2,
      checks: [3, 2, 1],
      branchesAccepted: 2,
      slices: { total: 3, done: 2, failed: 1, blocked: 0 },
      threads: [],
    },
  );
  // Anthropic reported no tokens, so its sums stay null. They are not zero.
  assert.deepEqual(read.families, [
    {
      family: 'openai',
      turns: 2,
      wallMs: 90_000,
      tokensIn: 1500,
      tokensOut: 200,
      tokenTurns: 2,
      allowance: [
        {
          windowId: 'primary',
          unit: 'percent',
          consumed: 2.5,
          measuredTurns: 2,
          unmeasuredTurns: 0,
        },
      ],
    },
    {
      family: 'anthropic',
      turns: 3,
      wallMs: 180_000,
      tokensIn: null,
      tokensOut: null,
      tokenTurns: 0,
      // The fourth turn starts further from the last reading than a bracket allows, and the
      // fifth is still open.
      allowance: [
        {
          windowId: 'five-hour',
          unit: 'percent',
          consumed: 4,
          measuredTurns: 1,
          unmeasuredTurns: 2,
        },
      ],
    },
  ]);
  assert.equal(BRACKET_MS, 900_000);
  assert.deepEqual(
    read.turnRows.map((row) => [
      row.sequence,
      row.role,
      row.wallMs,
      row.tokensIn,
      row.tokensOut,
      row.handoffFrom,
      row.allowance.map((entry) => `${entry.windowId}=${entry.consumed}`),
    ]),
    [
      [1, 'assistant', 60_000, 1000, 200, null, ['primary=2']],
      [2, 'reviewer', 30_000, 500, null, null, ['primary=0.5']],
      [3, 'assistant', 120_000, null, null, 'openai', ['five-hour=4']],
      [4, 'assistant', 60_000, null, null, null, []],
      [5, 'assistant', null, null, null, null, []],
    ],
  );

  // Another thread's turn on the same family inside the two readings makes the bracket unsafe.
  f.turn(otherId, 'openai', at('10:00:30'), at('10:00:40'));
  const shared = readAnalytics(f.store, { scope: 'thread', taskId: threadId }, at('11:00:00'));
  assert.deepEqual(shared?.turnRows[0].allowance, []);
  assert.deepEqual(shared?.turnRows[1].allowance, [
    { windowId: 'primary', unit: 'percent', consumed: 0.5 },
  ]);

  // An allowance that rose between the readings leaves the turn unmeasured, and so does a reset.
  const lastAllowance = () =>
    readAnalytics(f.store, { scope: 'thread', taskId: threadId }, at('11:00:00'))?.turnRows.at(-1)
      ?.allowance;
  f.reading('10:04:00', 100);
  f.turn(threadId, 'openai', at('10:03:30'), at('10:03:50'));
  assert.deepEqual(lastAllowance(), []);
  f.reading('10:05:00', 50, '2026-10-20T20:00:00.000Z');
  f.turn(threadId, 'openai', at('10:04:30'), at('10:04:50'));
  assert.deepEqual(lastAllowance(), []);
  f.reading('10:06:00', 49, '2026-10-20T20:00:00.000Z');
  f.turn(threadId, 'openai', at('10:05:30'), at('10:05:50'));
  assert.deepEqual(lastAllowance(), [{ windowId: 'primary', unit: 'percent', consumed: 1 }]);
});

test('project analytics add the threads and list them by title', (t) => {
  const f = fixture(t);
  f.turn(threadId, 'openai', at('10:00:00'), at('10:01:00'), { stats: f.stats(1000, 200) });
  f.turn(otherId, 'local', at('11:00:00'), at('11:00:10'), { stats: f.stats(10, 20) });
  f.putThread(f.record(threadId, {}), false);
  f.putThread(f.record(otherId, {}), false);
  const read = readAnalytics(f.store, { scope: 'project', projectId }, at('12:00:00'));
  assert.ok(read);
  assert.deepEqual(
    read.threads.map((row) => [row.title, row.turns, row.tokensIn, row.tokensOut, row.wallMs]),
    [
      ['Fixture thread', 1, 1000, 200, 60_000],
      ['Second thread', 1, 10, 20, 10_000],
    ],
  );
  assert.deepEqual(
    [read.name, read.threadCount, read.turns, read.tokensIn, read.tokensOut, read.wallMs],
    ['demo-shop', 2, 2, 1010, 220, 70_000],
  );
  assert.deepEqual(
    read.families.map((row) => [row.family, row.turns, row.allowance]),
    [
      ['openai', 1, []],
      ['local', 1, []],
    ],
  );
  // A thread with no turns reports zero turns and unknown tokens, and a missing thread is null.
  f.store.transaction(() => {
    f.store.put('task', id('tsk', 3), 0, {
      id: id('tsk', 3),
      projectId,
      title: 'Empty thread',
      outcome: 'Nothing yet',
      criteria: ['None'],
      state: 'draft',
      waitingReason: null,
      revision: 0,
      runId: null,
      next: null,
    });
  });
  f.putThread(f.record(id('tsk', 3), {}), false);
  const empty = readAnalytics(f.store, { scope: 'thread', taskId: id('tsk', 3) }, at('12:00:00'));
  assert.deepEqual(
    [empty?.turns, empty?.tokensIn, empty?.tokensOut, empty?.slices],
    [0, null, null, null],
  );
  assert.equal(
    readAnalytics(f.store, { scope: 'thread', taskId: id('tsk', 9) }, at('12:00:00')),
    null,
  );
  assert.equal(
    readAnalytics(f.store, { scope: 'project', projectId: id('prj', 9) }, at('12:00:00')),
    null,
  );
});
