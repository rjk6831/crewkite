import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AgentEvent,
  AgentEventSchema,
  type ChatThread,
  ChatThreadSchema,
  type ChatTurn,
  ChatTurnSchema,
  type Event,
} from '@crewkite/contracts';
import { followWorkflow, sinceNextTurn, sinceUnderWay, type WorkflowResult } from './workflow.ts';

const ulid = (n: number) => `0${String(n).padStart(25, '0')}`;
const taskId = `tsk_${ulid(1)}`;
const selection = { family: 'openai', model: 'm', effort: 'default' } as const;
const at = '2026-01-01T00:00:00.000Z';

const turn = (n: number, role: ChatTurn['role'], state: ChatTurn['state'], more = {}): ChatTurn =>
  ChatTurnSchema.parse({
    id: `trn_${ulid(n)}`,
    taskId,
    sequence: n,
    role,
    selection,
    userMessageId: `msg_${ulid(n)}`,
    assistantMessageId: null,
    state,
    startedAt: at,
    endedAt: state === 'running' ? null : at,
    failure: null,
    ...more,
  });

const run = (n: number, status: 'running' | 'passed' | 'failed') => ({
  id: `chk_${String(n).padStart(32, '0')}`,
  checkId: 'test',
  label: 'test',
  command: 'pnpm test',
  trigger: 'after-write' as const,
  status,
  reason: status === 'failed' ? 'Two tests failed.' : null,
  startedAt: at,
  durationMs: status === 'running' ? null : 5,
  exitCode: status === 'failed' ? 1 : status === 'passed' ? 0 : null,
  tail: '',
  stdout: null,
  stderr: null,
});

/** A controller double: the thread the reads return, and the events the stream carries. */
function world(thread: Partial<ChatThread>, turns: ChatTurn[]) {
  let cursor = 10;
  const state = {
    thread: ChatThreadSchema.parse({
      taskId,
      scratchReady: true,
      base: null,
      selection,
      ...thread,
    }),
    turns,
  };
  let listener: (event: Event) => void = () => {};
  const read = () => ({
    thread: state.thread,
    turns: state.turns,
    messages: [],
    liveEvents: [],
    cursor: String(cursor),
  });
  return {
    read,
    source: {
      readThread: async () => read(),
      subscribe: async (_after: string, onEvent: (event: Event) => void) => {
        listener = onEvent;
        return () => {};
      },
    },
    /** Streams one agent event, such as a permission question or a turn's end. */
    agent(payload: Record<string, unknown>) {
      listener({ type: 'agent.event', cursor: String(++cursor), taskId, payload } as Event);
    },
    /** Applies a change to the controller state and streams it, thread record last. */
    change(patch: Partial<ChatThread>, ...changed: ChatTurn[]) {
      state.thread = ChatThreadSchema.parse({ ...state.thread, ...patch });
      for (const item of changed)
        state.turns = [...state.turns.filter((value) => value.id !== item.id), item];
      for (const item of changed)
        listener({ type: 'chat.turn', cursor: String(++cursor), taskId, payload: item } as Event);
      listener({
        type: 'chat.thread',
        cursor: String(++cursor),
        taskId,
        payload: state.thread,
      } as Event);
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const crew: ChatThread['crew'] = {
  name: 'crew',
  members: [
    { role: 'builder', selection },
    { role: 'reviewer', selection },
  ],
};
const chain = (step: 'review' | 'fix' | 'finished', builder: ChatTurn) => ({
  builderTurnId: builder.id,
  step,
  reviewRounds: 1,
  fixes: step === 'review' ? 0 : 1,
  reason: null,
});
const follow = (
  w: ReturnType<typeof world>,
  since = 1,
  keepWaiting?: readonly ('permission' | 'checks' | 'plan')[],
) => {
  let result: WorkflowResult | null = null;
  const handle = followWorkflow(w.source, w.read(), { since, keepWaiting });
  void handle.done.then((value) => {
    result = value;
  });
  return { result: () => result, stop: handle.stop };
};

test('a crew chain with a fix and a gate ends done only after its last step', async () => {
  const build = turn(1, 'assistant', 'running');
  const w = world({ crew, flightMode: 'balanced', activeTurnId: build.id }, [build]);
  const followed = follow(w);
  const builder = turn(1, 'assistant', 'done');
  // The builder is done and the chain has not opened yet. The follower must not end here.
  w.change({ activeTurnId: null }, builder);
  await flush();
  assert.equal(followed.result(), null);
  const review = turn(2, 'reviewer', 'running');
  w.change({ crewChain: chain('review', builder), activeTurnId: review.id }, review);
  w.change({ crewChain: chain('fix', builder), activeTurnId: null }, turn(2, 'reviewer', 'done'));
  const fix = turn(3, 'fixer', 'running');
  w.change({ activeTurnId: fix.id }, fix);
  w.change({ activeTurnId: null }, turn(3, 'fixer', 'done'));
  // The after-write gate runs between the fix and the next review.
  w.change({
    checks: { items: [], ask: null, approved: null, runs: [run(1, 'running')], detectedAt: null },
  });
  await flush();
  assert.equal(followed.result(), null);
  w.change({
    crewChain: chain('finished', builder),
    checks: { items: [], ask: null, approved: null, runs: [run(1, 'passed')], detectedAt: null },
  });
  await flush();
  const result = followed.result() as WorkflowResult | null;
  assert.equal(result?.state, 'done');
  assert.deepEqual(
    result?.steps.map((step) => (step.kind === 'turn' ? step.role : step.kind)),
    ['assistant', 'reviewer', 'fixer', 'check'],
  );
  followed.stop();
});

test('an open checks question ends the follow as waiting', async () => {
  const build = turn(1, 'assistant', 'running');
  const w = world({ activeTurnId: build.id }, [build]);
  const followed = follow(w);
  const ask = {
    requestId: `chkask_${'0'.repeat(32)}`,
    trigger: 'after-write' as const,
    commands: [{ label: 'test', resolved: 'vitest' }],
    changed: [],
  };
  w.change(
    {
      activeTurnId: null,
      checks: { items: [], ask, approved: null, runs: [], detectedAt: null },
    },
    turn(1, 'assistant', 'done'),
  );
  await flush();
  const result = followed.result() as WorkflowResult | null;
  assert.equal(result?.state, 'waiting');
  assert.equal(result?.state === 'waiting' && result.on, 'checks');
});

test('a plan whose slice fails ends failed and names the slice', async () => {
  const plan = turn(1, 'orchestrator', 'running');
  const w = world({ activeTurnId: plan.id }, [plan]);
  const followed = follow(w);
  const slice = (status: 'running' | 'failed') => ({
    id: 2,
    title: 'Parser',
    difficulty: 'easy' as const,
    depends: [],
    readOnly: false,
    status,
    assignment: null,
    candidates: [],
    turnId: null,
  });
  const state = (phase: 'running' | 'finished', status: 'running' | 'failed') => ({
    planId: 'p1',
    orchestratorTurnId: plan.id,
    goal: 'Split the parser',
    phase,
    slices: [slice(status)],
  });
  w.change(
    { activeTurnId: null, plan: state('running', 'running') },
    turn(1, 'orchestrator', 'done'),
  );
  await flush();
  assert.equal(followed.result(), null);
  w.change({ plan: state('finished', 'failed') });
  await flush();
  const result = followed.result() as WorkflowResult | null;
  assert.equal(result?.state, 'failed');
  assert.equal(result?.state === 'failed' && result.step, 'slice 2: Parser');
  assert.equal(sinceNextTurn(w.read()), 2);
});

// Claim: a turn that ends takes every open question of its own with it, whatever other turns
// still ask, so a follow that waits through questions ends once the work does.
test('a turn that ends clears its own questions while another turn still asks', async () => {
  const first = turn(1, 'assistant', 'running', { slice: 1 });
  const second = turn(2, 'assistant', 'running', { slice: 2 });
  const w = world({ activeTurnId: first.id }, [first, second]);
  const followed = follow(w, 1, ['permission']);
  const ask = (n: number, turnId: string) =>
    w.agent({
      type: 'permission.requested',
      turnId,
      requestId: `req-${n}`,
      question: `Question ${n}?`,
      at,
    });
  ask(1, first.id);
  ask(2, second.id);
  // The second turn is stopped with its question open, and the first one's question is answered.
  w.agent({ type: 'turn.completed', turnId: second.id, stopReason: 'stopped', at });
  w.change({}, turn(2, 'assistant', 'stopped', { slice: 2 }));
  w.agent({ type: 'permission.resolved', turnId: first.id, requestId: 'req-1', at });
  w.change({ activeTurnId: null }, turn(1, 'assistant', 'done', { slice: 1 }));
  await flush();
  assert.notEqual(followed.result(), null, 'The follow ends once both turns ended.');
  followed.stop();
});

// Claim: a send whose message waits in a paused queue, or behind a held thread, ends the follow
// with that reason. No first turn is coming, so waiting for one would never end.
test('a message held in a paused queue or behind a held thread ends the follow at once', async () => {
  const queued = { id: `msg_${ulid(9)}`, at, text: 'Go on.' };
  const rows: [Partial<ChatThread>, string][] = [
    [{ queued: [queued] as ChatThread['queued'], queuePaused: true }, 'queue-paused'],
    [{ queued: [queued] as ChatThread['queued'], ownershipUnknown: true }, 'unknown-process'],
  ];
  for (const [thread, reason] of rows) {
    const w = world(thread, []);
    const followed = follow(w, 1);
    await flush();
    const result = followed.result() as WorkflowResult | null;
    assert.deepEqual(
      [result?.state, result?.state === 'blocked' && result.reason],
      ['blocked', reason],
    );
    followed.stop();
  }
});

// Claim: watch finds the work under way however it runs, and starts at its beginning. A crew chain
// mid-review, a running plan, checks with no turn and a queue that starts on its own are all work,
// and an attach mid-chain still follows the chain from its builder turn.
test('the work under way starts at its plan, its chain or its running turn, and an idle thread has none', () => {
  const builder = turn(1, 'assistant', 'done');
  const read = (thread: Partial<ChatThread>, turns: ChatTurn[]) =>
    world(thread, turns).read() as Parameters<typeof sinceUnderWay>[0];
  const plan = {
    planId: 'p1',
    orchestratorTurnId: builder.id,
    goal: 'Split it',
    phase: 'running' as const,
    slices: [
      {
        id: 1,
        title: 'Parser',
        difficulty: 'easy' as const,
        depends: [],
        readOnly: false,
        status: 'running' as const,
        assignment: null,
        candidates: [],
        turnId: null,
      },
    ],
  };
  const checks = (status: 'running' | 'passed') => ({
    items: [],
    ask: null,
    approved: null,
    runs: [run(1, status)],
    detectedAt: null,
  });
  const rows: [string, Partial<ChatThread>, ChatTurn[], number | null][] = [
    ['an idle thread', {}, [builder], null],
    [
      'a review under way',
      {
        crew,
        flightMode: 'balanced',
        crewChain: chain('review', builder),
        activeTurnId: `trn_${ulid(2)}`,
      },
      [builder, turn(2, 'reviewer', 'running')],
      1,
    ],
    [
      'a chain between steps with no running turn',
      { crew, flightMode: 'balanced', crewChain: chain('fix', builder) },
      [builder, turn(2, 'reviewer', 'done')],
      1,
    ],
    ['a running plan', { plan }, [builder, turn(2, 'assistant', 'running', { slice: 1 })], 1],
    ['checks with no turn', { checks: checks('running') }, [builder], 1],
    ['finished checks', { checks: checks('passed') }, [builder], null],
    [
      'a queue that starts on its own',
      { queued: [{ id: `msg_${ulid(9)}`, at, text: 'Next.' }] as ChatThread['queued'] },
      [builder],
      2,
    ],
  ];
  for (const [name, thread, turns, since] of rows)
    assert.equal(sinceUnderWay(read(thread, turns)), since, name);
});

// Claim: a thread read answers from its own cursor. Events that reach the follow while that read is
// on its way are newer, and the read must not undo them, since no later event may come to correct
// it. The first case is a crew step that starts and ends while the read is out. The second is a
// question whose request fell in a gap of the stream: the read made after the gap still holds it,
// but its turn ends before the read comes back.
test('a thread read older than events the follow already holds never undoes them', async () => {
  // Events reach the follow only when the test lets them through, reads answer with the thread as
  // it stood when asked, once released, and `live` sets the questions a read reports.
  const lagging = (w: ReturnType<typeof world>, keepWaiting?: readonly 'permission'[]) => {
    const queue: Event[] = [];
    let deliver: (event: Event) => void = () => {};
    let resync: () => void = () => {};
    const held: (() => void)[] = [];
    const lag = {
      live: [] as AgentEvent[],
      held,
      release(count = queue.length) {
        for (const event of queue.splice(0, count)) deliver(event);
      },
      drop: (count: number) => queue.splice(0, count),
      gap: () => resync(),
      result: null as WorkflowResult | null,
      stop: () => {},
    };
    const source = {
      readThread: () => {
        const snapshot = { ...w.read(), liveEvents: lag.live };
        return new Promise<typeof snapshot>((resolve) => held.push(() => resolve(snapshot)));
      },
      subscribe: async (after: string, onEvent: (event: Event) => void, onResync?: () => void) => {
        deliver = onEvent;
        resync = onResync ?? (() => {});
        return w.source.subscribe(after, (event) => queue.push(event));
      },
    };
    const handle = followWorkflow(source, w.read(), { since: 1, keepWaiting });
    lag.stop = handle.stop;
    void handle.done.then((value) => {
      lag.result = value;
    });
    return lag;
  };

  const first = turn(1, 'assistant', 'running');
  const w = world({ activeTurnId: first.id }, [first]);
  const step = lagging(w);
  await flush();
  const second = turn(2, 'assistant', 'running');
  w.change({ activeTurnId: null }, turn(1, 'assistant', 'done'));
  w.change({ activeTurnId: second.id }, second);
  // Only the first turn's end has arrived, so the follow asks for a read. The controller answers
  // it from a thread where the second turn runs.
  step.release(2);
  await flush();
  assert.equal(step.held.length, 1);
  w.change({ activeTurnId: null }, turn(2, 'assistant', 'done'));
  step.release();
  step.held[0]();
  await flush();
  assert.equal(step.result?.state, 'done', 'A turn that ended stays ended.');
  step.stop();

  const asking = turn(1, 'assistant', 'running');
  const v = world({ activeTurnId: asking.id }, [asking]);
  const question = lagging(v, ['permission']);
  await flush();
  const request = AgentEventSchema.parse({
    type: 'permission.requested',
    turnId: asking.id,
    requestId: 'req-1',
    question: 'Run it?',
    options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
  });
  v.agent(request);
  question.drop(1);
  question.live = [request];
  question.gap();
  v.agent({ type: 'turn.completed', turnId: asking.id, stopReason: 'stopped', at });
  v.change({}, turn(1, 'assistant', 'stopped'));
  // The turn's end arrives before the read made after the gap, which still holds the question.
  question.release(2);
  question.held[0]();
  question.live = [];
  await flush();
  v.change({ activeTurnId: null });
  question.release();
  await flush();
  for (const release of question.held.slice(1)) release();
  await flush();
  assert.notEqual(question.result, null, 'A question of an ended turn holds nothing open.');
  question.stop();
});
