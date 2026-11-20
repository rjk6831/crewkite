import type {
  ChatCheckRun,
  ChatStopCause,
  ChatThread,
  ChatThreadRead,
  ChatTurn,
  Event,
} from '@crewkite/contracts';

// Follows one thread until its whole workflow has ended. A message starts a turn, and that turn
// can start a crew chain (review, fix, challenge), after-write checks, plan slices and combined
// checks. Following the first turn only reports the start of that, so this waits for the thread to
// go quiet and then says how it ended. It reacts to the event stream and reads the thread again
// before it ends, so an event that arrived ahead of its neighbours never ends it early. The only
// timer is the optional deadline, which runs on the clock the caller passes in.

/** The part of the controller client the follower uses. */
export type WorkflowSource = {
  readThread(taskId: string): Promise<ChatThreadRead>;
  subscribe(
    after: string,
    onEvent: (event: Event) => void,
    onResync?: () => void,
  ): Promise<() => void>;
  /** Called once the client stops trying to reconnect. Returns the call that removes it. */
  onLost?(listener: () => void): () => void;
};

export type WorkflowClock = {
  now(): number;
  /** Runs `fn` after `ms` and returns the call that cancels it. */
  after(ms: number, fn: () => void): () => void;
};

export type WorkflowStep =
  | { kind: 'turn'; turnId: string; role: ChatTurn['role']; state: ChatTurn['state'] }
  | { kind: 'slice'; id: number; title: string; status: string }
  | {
      kind: 'check';
      label: string;
      trigger: ChatCheckRun['trigger'];
      status: ChatCheckRun['status'];
    };

export type WorkflowEnd =
  | { state: 'done' }
  /** The person has to answer: a permission ask, a checks question or a proposed plan. */
  | { state: 'waiting'; on: 'permission' | 'checks' | 'plan'; detail: string }
  /** Nothing runs and nothing will start by itself. */
  | {
      state: 'blocked';
      reason: 'queue-paused' | 'unknown-process' | 'slice-blocked' | 'deadline';
      detail: string;
    }
  | { state: 'failed'; step: string; detail: string }
  | { state: 'stopped'; step: string; cause: ChatStopCause | null };

export type WorkflowResult = WorkflowEnd & { steps: WorkflowStep[] };

export type WorkflowOptions = {
  /** Turns with this sequence or a later one belong to the workflow. */
  since: number;
  /** Give up after this long on `clock`. Needs `clock`. */
  deadlineMs?: number;
  clock?: WorkflowClock;
  /**
   * Questions the caller knows another command or window will answer. The follow keeps waiting
   * through these and ends on any other question.
   */
  keepWaiting?: readonly ('permission' | 'checks' | 'plan')[];
};

/** The sequence of the next turn a thread opens, for a workflow that starts with a send. */
export const sinceNextTurn = (read: ChatThreadRead): number =>
  read.turns.reduce((most, turn) => Math.max(most, turn.sequence + 1), 0);

/**
 * Where the work under way in a thread began, for a follow that attaches to it, or null when
 * nothing is under way. Plan slices run beside the thread's turn and checks run with no turn, so
 * the running turn alone says neither. The start is the plan's orchestrator turn while a plan is
 * open, the builder turn of an open crew chain, the running turn, and for checks running after a
 * turn with no chain, that turn. A queue that will start a message on its own begins at the next
 * turn.
 */
export function sinceUnderWay(read: ChatThreadRead): number | null {
  const { thread } = read;
  const at = (id: string | null | undefined) => read.turns.find((turn) => turn.id === id)?.sequence;
  const starts: (number | undefined)[] = [];
  if (thread.plan && (thread.plan.phase === 'proposed' || thread.plan.phase === 'running'))
    starts.push(at(thread.plan.orchestratorTurnId));
  const chain = thread.crewChain;
  if (chain && chain.step !== 'finished' && chain.step !== 'stopped')
    starts.push(at(chain.builderTurnId));
  starts.push(at(thread.activeTurnId));
  for (const turn of read.turns) if (!finished(turn.state)) starts.push(turn.sequence);
  if (thread.checks?.runs.some((run) => run.status === 'running'))
    starts.push(read.turns.at(-1) && Math.max(...read.turns.map((turn) => turn.sequence)));
  if (thread.queued.length > 0 && !thread.queuePaused) starts.push(sinceNextTurn(read));
  const known = starts.filter((value): value is number => value !== undefined);
  return known.length ? Math.min(...known) : null;
}

type Model = {
  thread: ChatThread;
  turns: Map<string, ChatTurn>;
  /** Open permission asks by request ID. */
  asks: Map<string, { turnId: string; question: string }>;
  runs: Map<string, ChatCheckRun>;
  /**
   * The cursor at which each item last changed: `thread`, `turn:<id>`, `run:<id>`, `ask:<id>`,
   * and `end:<turn id>` for the turn's end.
   */
  changed: Map<string, bigint>;
  cursor: bigint;
};

const finished = (state: ChatTurn['state']) =>
  state === 'done' || state === 'stopped' || state === 'failed';

function fromRead(read: ChatThreadRead, model?: Model): Model {
  const next: Model = model ?? {
    thread: read.thread,
    turns: new Map(),
    asks: new Map(),
    runs: new Map(),
    changed: new Map(),
    cursor: 0n,
  };
  // A read shows the thread as of its cursor. Events can reach the follow while the read is on its
  // way, and whatever they changed after that cursor is newer than the read. Taking the read over
  // them would put an ended turn back to running, and no later event comes to correct it.
  const cursor = BigInt(read.cursor);
  const take = (key: string) => {
    if ((next.changed.get(key) ?? -1n) > cursor) return false;
    next.changed.set(key, cursor);
    return true;
  };
  if (take('thread')) next.thread = read.thread;
  for (const turn of read.turns) if (take(`turn:${turn.id}`)) next.turns.set(turn.id, turn);
  for (const run of read.thread.checks?.runs ?? [])
    if (take(`run:${run.id}`)) next.runs.set(run.id, run);
  const asks = new Map<string, { turnId: string; question: string }>();
  for (const event of read.liveEvents) {
    if (event.type === 'permission.requested')
      asks.set(event.requestId, { turnId: event.turnId, question: event.question });
    else if (event.type === 'permission.resolved') asks.delete(event.requestId);
  }
  for (const id of next.asks.keys()) if (!asks.has(id) && take(`ask:${id}`)) next.asks.delete(id);
  // A question can reach the follow only through a read when its request fell in a gap of the
  // stream. Its turn may have ended after the read, and then the question went with it.
  for (const [id, ask] of asks)
    if ((next.changed.get(`end:${ask.turnId}`) ?? -1n) <= cursor && take(`ask:${id}`))
      next.asks.set(id, ask);
  if (cursor > next.cursor) next.cursor = cursor;
  return next;
}

type Assessment = { end: WorkflowEnd } | { running: string };

const unknownProcess: WorkflowEnd = {
  state: 'blocked',
  reason: 'unknown-process',
  detail: 'A provider process outlived its turn and is not proven gone.',
};
const queuePaused: WorkflowEnd = {
  state: 'blocked',
  reason: 'queue-paused',
  detail: 'Queued messages wait for Send now or Remove.',
};

/** Where the workflow stands in `model`: how it ended, or what still runs. */
function assessWorkflow(
  model: Model,
  since: number,
  baseline: ReadonlySet<string>,
  keepWaiting: readonly string[] = [],
): Assessment {
  const asked = assessOnce(model, since, baseline);
  if ('end' in asked && asked.end.state === 'waiting' && keepWaiting.includes(asked.end.on))
    return { running: `an answer to the ${asked.end.on} question` };
  return asked;
}

function assessOnce(model: Model, since: number, baseline: ReadonlySet<string>): Assessment {
  const { thread } = model;
  const turns = [...model.turns.values()]
    .filter((turn) => turn.sequence >= since)
    .sort((a, b) => a.sequence - b.sequence);
  const own = new Set(turns.map((turn) => turn.id));
  const runs = [...model.runs.values()].filter((run) => !baseline.has(run.id));
  const plan = thread.plan && own.has(thread.plan.orchestratorTurnId) ? thread.plan : null;
  const chain =
    thread.crewChain && own.has(thread.crewChain.builderTurnId) ? thread.crewChain : null;

  // The person has to act. This comes first, since a turn waits on the answer.
  const ask = [...model.asks.values()][0];
  if (ask || turns.some((turn) => turn.state === 'waiting-permission'))
    return {
      end: {
        state: 'waiting',
        on: 'permission',
        detail: ask?.question ?? 'A permission question is open.',
      },
    };
  if (thread.checks?.ask)
    return {
      end: {
        state: 'waiting',
        on: 'checks',
        detail: `The checks question for ${thread.checks.ask.trigger} is open.`,
      },
    };
  if (plan?.phase === 'proposed')
    return { end: { state: 'waiting', on: 'plan', detail: 'The plan waits for Run plan.' } };

  // A message that waits in a paused queue or behind a held thread opens no first turn, so the
  // follow says why before it waits for one.
  if (turns.length === 0 && thread.ownershipUnknown) return { end: unknownProcess };
  if (turns.length === 0 && thread.queued.length > 0 && thread.queuePaused)
    return { end: queuePaused };
  // Work still in flight. A workflow whose first turn has not appeared yet has not begun.
  if (turns.length === 0) return { running: 'the first turn' };
  if (thread.activeTurnId || turns.some((turn) => !finished(turn.state)))
    return { running: 'a turn' };
  const running = runs.find((run) => run.status === 'running');
  if (running) return { running: `the check ${running.label}` };
  if (plan?.phase === 'running') return { running: 'the plan' };
  if (chain && (chain.step === 'review' || chain.step === 'fix' || chain.step === 'challenge'))
    return { running: `the crew ${chain.step}` };
  if (thread.queued.length > 0 && !thread.queuePaused) return { running: 'a queued message' };
  // A done builder turn in a crew with a reviewer opens a chain in the step that settles it.
  const builder = turns.findLast((turn) => turn.role === 'assistant' && turn.slice === undefined);
  if (
    builder?.state === 'done' &&
    thread.flightMode !== 'manual' &&
    thread.crew?.members.some((member) => member.role === 'reviewer') &&
    thread.crewChain?.builderTurnId !== builder.id
  )
    return { running: 'the crew chain' };

  // Nothing runs. Say how it ended.
  if (thread.ownershipUnknown) return { end: unknownProcess };
  if (plan) {
    const failed = plan.slices.find((slice) => slice.status === 'failed');
    if (failed)
      return {
        end: {
          state: 'failed',
          step: `slice ${failed.id}: ${failed.title}`,
          detail: 'The slice failed.',
        },
      };
    const held = plan.slices.find((slice) => slice.status === 'blocked');
    if (held)
      return {
        end: {
          state: 'blocked',
          reason: 'slice-blocked',
          detail: `Slice ${held.id}: ${held.title} is blocked by changes in the thread copy.`,
        },
      };
    if (plan.phase === 'stopped') return { end: { state: 'stopped', step: 'plan', cause: 'plan' } };
  }
  const last = turns.findLast((turn) => turn.slice === undefined);
  if (last?.state === 'failed')
    return {
      end: {
        state: 'failed',
        step: `${last.role} turn`,
        detail: last.failure?.message ?? 'The turn failed.',
      },
    };
  if (last?.state === 'stopped')
    return {
      end: { state: 'stopped', step: `${last.role} turn`, cause: last.stopCause ?? null },
    };
  if (thread.queued.length > 0) return { end: queuePaused };
  if (chain?.step === 'stopped')
    return {
      end: {
        state: 'failed',
        step: 'crew chain',
        detail: chain.reason ?? 'The chain stopped.',
      },
    };
  // The newest run of each check decides, so a fix that made it pass clears an earlier failure.
  const latest = new Map<string, ChatCheckRun>();
  for (const run of runs) latest.set(run.checkId, run);
  for (const run of latest.values()) {
    if (run.status === 'unknown')
      return {
        end: {
          state: 'blocked',
          reason: 'unknown-process',
          detail: `The check ${run.label} left processes that are not proven gone.`,
        },
      };
    if (run.status === 'stopped')
      return { end: { state: 'stopped', step: `check ${run.label}`, cause: null } };
    if (run.status === 'failed')
      return {
        end: {
          state: 'failed',
          step: `check ${run.label}`,
          detail: run.reason ?? `The command exited with ${run.exitCode ?? 'an unknown code'}.`,
        },
      };
  }
  return { end: { state: 'done' } };
}

function stepsOf(model: Model, since: number, baseline: ReadonlySet<string>): WorkflowStep[] {
  const turns = [...model.turns.values()]
    .filter((turn) => turn.sequence >= since)
    .sort((a, b) => a.sequence - b.sequence);
  const steps: WorkflowStep[] = turns
    .filter((turn) => turn.slice === undefined)
    .map((turn) => ({ kind: 'turn', turnId: turn.id, role: turn.role, state: turn.state }));
  const own = new Set(turns.map((turn) => turn.id));
  if (model.thread.plan && own.has(model.thread.plan.orchestratorTurnId))
    for (const slice of model.thread.plan.slices)
      steps.push({ kind: 'slice', id: slice.id, title: slice.title, status: slice.status });
  for (const run of model.runs.values())
    if (!baseline.has(run.id))
      steps.push({ kind: 'check', label: run.label, trigger: run.trigger, status: run.status });
  return steps;
}

/**
 * Follows `taskId` from `read` until the workflow ends. Resolves with how it ended and the steps
 * it saw, and rejects when the connection is lost for good. `stop` ends the follow without a
 * result.
 */
export function followWorkflow(
  source: WorkflowSource,
  read: ChatThreadRead,
  options: WorkflowOptions,
): { done: Promise<WorkflowResult>; stop: () => void } {
  const taskId = read.thread.taskId;
  const model = fromRead(read);
  // Runs that were already settled when the follow began belong to an earlier workflow.
  const baseline = new Set(
    [...model.runs.values()].filter((run) => run.status !== 'running').map((run) => run.id),
  );
  const settled = Promise.withResolvers<WorkflowResult>();
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  let evaluating = false;
  let again = false;
  let inFlight = 'the thread';
  const cleanups: Array<() => void> = [];
  const close = () => {
    closed = true;
    unsubscribe?.();
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  const finish = (end: WorkflowEnd) => {
    if (closed) return;
    const result = { ...end, steps: stepsOf(model, options.since, baseline) };
    close();
    settled.resolve(result);
  };

  // An end counts once a fresh read agrees with it, so events that arrive out of step with each
  // other never end the follow on a gap between two steps.
  const evaluate = async (): Promise<void> => {
    if (evaluating) {
      again = true;
      return;
    }
    evaluating = true;
    try {
      do {
        again = false;
        const first = assessWorkflow(model, options.since, baseline, options.keepWaiting);
        if ('running' in first) {
          inFlight = first.running;
          continue;
        }
        const fresh = await source.readThread(taskId);
        if (closed) return;
        fromRead(fresh, model);
        const second = assessWorkflow(model, options.since, baseline, options.keepWaiting);
        if ('running' in second) inFlight = second.running;
        else if (second.end.state === first.end.state) finish(second.end);
        else again = true;
      } while (again && !closed);
    } catch (error) {
      if (!closed) {
        close();
        settled.reject(error);
      }
    } finally {
      evaluating = false;
    }
  };

  const apply = (event: Event) => {
    if (event.taskId !== taskId) return;
    const cursor = BigInt(event.cursor);
    if (cursor <= model.cursor) return;
    model.cursor = cursor;
    const changed = (key: string) => model.changed.set(key, cursor);
    if (event.type === 'chat.thread') {
      model.thread = event.payload;
      changed('thread');
      for (const run of event.payload.checks?.runs ?? []) {
        model.runs.set(run.id, run);
        changed(`run:${run.id}`);
      }
    } else if (event.type === 'chat.turn') {
      model.turns.set(event.payload.id, event.payload);
      changed(`turn:${event.payload.id}`);
    } else if (event.type === 'agent.event') {
      const item = event.payload;
      if (item.type === 'permission.requested') {
        model.asks.set(item.requestId, { turnId: item.turnId, question: item.question });
        changed(`ask:${item.requestId}`);
      } else if (item.type === 'permission.resolved') {
        model.asks.delete(item.requestId);
        changed(`ask:${item.requestId}`);
      } else if (item.type === 'turn.completed') {
        // Every question of the ended turn goes, whatever other turns still ask.
        changed(`end:${item.turnId}`);
        for (const [id, ask] of model.asks)
          if (ask.turnId === item.turnId) {
            model.asks.delete(id);
            changed(`ask:${id}`);
          }
      } else return;
    } else return;
    void evaluate();
  };

  if (options.deadlineMs !== undefined) {
    const clock = options.clock;
    if (!clock) throw new Error('A workflow deadline needs a clock.');
    cleanups.push(
      clock.after(options.deadlineMs, () =>
        finish({
          state: 'blocked',
          reason: 'deadline',
          detail: `The workflow was still running ${inFlight} at the limit.`,
        }),
      ),
    );
  }
  const stopLost = source.onLost?.(() => {
    if (closed) return;
    close();
    settled.reject(
      new Error(
        `The connection to the controller ended. The workflow may still be running; read the thread with crewkite thread show ${taskId}.`,
      ),
    );
  });
  if (stopLost) cleanups.push(stopLost);
  source
    .subscribe(read.cursor, apply, () => {
      // After a gap in the stream the thread is read again, so an end that passed is not missed.
      void source.readThread(taskId).then(
        (fresh) => {
          if (closed) return;
          fromRead(fresh, model);
          void evaluate();
        },
        (error) => {
          if (closed) return;
          close();
          settled.reject(error);
        },
      );
    })
    .then(
      (stop) => {
        if (closed) stop();
        else unsubscribe = stop;
        // The thread may already be quiet when the follow begins.
        void evaluate();
      },
      (error) => {
        if (closed) return;
        close();
        settled.reject(error);
      },
    );
  return { done: settled.promise, stop: close };
}
