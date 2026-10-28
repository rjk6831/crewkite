import { closeSync, existsSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ChatCatalogRead,
  type ChatCrewChain,
  type ChatFamily,
  ChatFamilySchema,
  type ChatModelSelection,
  type ChatPlan,
  type ChatPlanState,
  type ChatQueuedMessage,
  type ChatThread,
  type ChatTurn,
  type Command,
  type CommandResult,
  type Task,
  writesScratch,
} from '@crewkite/contracts';
import type { ChecksOutcome } from './checks.ts';
import { detectType } from './files.ts';
import { assignPlan, type PlanFile, type PlanInputs, parsePlan } from './plan.ts';
import {
  laneCopy,
  laneFolder,
  listedConflicts,
  order,
  prepareLaneCopy,
  readySlices,
  replayLane,
  resolveBrief,
} from './plan-lanes.ts';
import { familyName, fixerBrief, PLAN_RETRY, planRetryText, sliceBrief } from './prompt.ts';

type Payload<C extends Command['command']> = Extract<Command, { command: C }>['payload'];
type Effects = (() => void)[];
type Message = Pick<ChatQueuedMessage, 'text' | 'role' | 'selection' | 'attachments' | 'files'>;
type Slice = ChatPlanState['slices'][number];
type Lane = NonNullable<Slice['lane']>;

/**
 * True when the person sent a message that waits in the thread. A queued Ask is a read-only side
 * question, so it leaves a crew chain or a plan running and starts once they end.
 */
export function sentMessage(thread: ChatThread): boolean {
  return thread.queued.some((message) => message.role !== 'ask');
}

/** What the runner needs from the chat service. Every call runs inside the caller's transaction. */
export type PlanHost = {
  transaction: <T>(work: () => T) => T;
  call: (work: () => void) => void;
  catalog: (taskId: string) => ChatCatalogRead;
  now: () => string;
  task: (taskId: string) => Task | undefined;
  thread: (taskId: string) => ChatThread;
  putThread: (task: Task, thread: ChatThread) => ChatThread;
  line: (task: Task, text: string) => void;
  turn: (turnId: string) => ChatTurn | undefined;
  turns: (taskId: string) => ChatTurn[];
  /** The text of a turn's reply, and of the message it answered. */
  reply: (turn: ChatTurn) => string | undefined;
  message: (turn: ChatTurn) => string | undefined;
  begin: (task: Task, thread: ChatThread, input: Message, effects: Effects) => CommandResult;
  /**
   * Open a turn in a slice's lane. It leaves the thread's pick, its handoff and its sessions
   * alone. Returns the new turn's ID, or the refusal.
   */
  beginLane: (
    task: Task,
    thread: ChatThread,
    input: Message & { slice: number },
    effects: Effects,
  ) => string | CommandResult;
  /** Start a crew step on the thread copy. A fix step answers `brief`. */
  crewStep: (
    task: Task,
    thread: ChatThread,
    chain: ChatCrewChain,
    effects: Effects,
    brief?: string,
  ) => void;
  /** The `Findings: N` count a review states, or null. */
  findings: (review: string) => number | null;
  /** The message every crew review answers. */
  reviewBrief: string;
  /** Whether a turn on this family is open in any thread, this one included. */
  familyBusy: (family: ChatFamily) => boolean;
  /** Ask the running turn to stop. Its settle finishes the rest. */
  stopActive: (taskId: string, effects: Effects) => void;
  /** Ask one open turn of the thread to stop, after the caller's transaction commits. */
  stopTurn: (taskId: string, turnId: string) => void;
  /** Whether no process of an earlier turn may still write to the scratch copy. */
  free: (task: Task) => boolean;
  /** The task IDs of threads whose plan runs. */
  planThreads: () => string[];
  /** Start what waits in each thread's queue, once the thread is free. */
  wakeQueues: () => void;
  projectPath: (task: Task) => string | undefined;
  scratchDirectory: (taskId: string) => string;
  /** The project checks on a merged copy, before the challenger. They ask like any run. */
  runCombinedChecks: (taskId: string, directory: string) => Promise<ChecksOutcome>;
  /** End the runs on merged copies, and the question before them. Only the plan calls it. */
  stopCombinedChecks: (taskId: string) => boolean;
  /** The loaded Local model's context length, or null. */
  localContext: () => number | null;
  localSliceFits: PlanInputs['localSliceFits'];
};

const blocked = (reason: string, next?: string): CommandResult => ({
  outcome: 'blocked',
  reason,
  ...(next ? { next } : {}),
});
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const OPEN = new Set<ChatTurn['state']>(['queued', 'running', 'waiting-permission']);
/** The crew chain's cap: at most two fixes, so at most three reviews per slice. */
const MAX_FIXES = 2;

/**
 * Runs an orchestrator plan (ADR 0045). The orchestrator turn replaces the builder turn and the
 * controller assigns each slice. Slices whose dependencies are done start together, each in its
 * own scratch copy with its own review chain, and at most one turn runs per family. A finished
 * slice replays onto the thread copy in plan order. After the last slice the project checks run
 * on the merged copy, then the challenger.
 */
export class PlanRunner {
  private readonly host: PlanHost;
  /**
   * Threads whose plan has every slice done: `checks` while the merged copy is in the project
   * checks, then `chain` while the fix or the challenge after them runs on the thread copy.
   */
  private readonly closing = new Map<string, 'checks' | 'chain'>();

  constructor(host: PlanHost) {
    this.host = host;
  }

  /**
   * A message from the person goes to the orchestrator when the crew has one and the thread runs
   * on its own. Manual keeps the builder, since nothing would run the plan.
   */
  route<M extends Message>(thread: ChatThread, message: M): M {
    const orchestrator = thread.crew?.members.find((member) => member.role === 'orchestrator');
    if (message.role !== 'assistant' || !orchestrator || thread.flightMode === 'manual')
      return message;
    return { ...message, role: 'orchestrator', selection: orchestrator.selection };
  }

  /** A running plan holds the thread: a message waits in the queue until the plan ends. */
  holds(thread: ChatThread): boolean {
    return thread.plan?.phase === 'running';
  }

  /**
   * The scratch copy a lane turn works in, made fresh for a slice's builder turn. Null for a turn
   * that runs in the thread copy, which includes the orchestrator's resolve turn.
   */
  laneScratch(task: Task, turn: ChatTurn): string | null {
    if (turn.slice === undefined) return null;
    const thread = this.host.thread(task.id);
    const slice = thread.plan && find(thread.plan, turn.slice);
    const own = slice?.turnId === turn.id ? slice.lane : undefined;
    if (own?.step === 'resolve') return null;
    const folder = laneFolder(this.host.scratchDirectory(task.id), turn.slice);
    const root = this.host.projectPath(task);
    if (!root || !thread.base) throw Error('The project is no longer registered.');
    if (own?.step === 'build' || !existsSync(laneCopy(folder)))
      prepareLaneCopy({
        root,
        base: thread.base,
        threadScratch: this.host.scratchDirectory(task.id),
        folder,
      });
    return laneCopy(folder);
  }

  /** After any turn settles and the crew chain has moved: read a plan, or move a lane on. */
  settled(turnId: string) {
    this.work((effects) => {
      const turn = this.host.turn(turnId);
      const task = turn && this.host.task(turn.taskId);
      if (!turn || !task) return;
      const thread = this.host.thread(task.id);
      if (turn.role === 'orchestrator') return this.propose(task, thread, turn, effects);
      const plan = thread.plan;
      if (turn.slice === undefined || plan?.phase !== 'running') return;
      const slice = find(plan, turn.slice);
      if (!slice?.lane || slice.turnId !== turn.id) return;
      if (this.step(task, thread, plan, slice, turn)) this.pump(task, effects);
    });
  }

  /** Move every running plan on. A family that freed in another thread may let a lane start. */
  wake() {
    for (const taskId of this.host.planThreads())
      this.work((effects) => {
        const task = this.host.task(taskId);
        if (task) this.pump(task, effects);
      });
  }

  /** The chain finished after the last slice. True when the plan wrote the closing line. */
  finished(task: Task): boolean {
    const thread = this.host.thread(task.id);
    const plan = thread.plan;
    if (plan?.phase !== 'running' || !ended(plan)) return false;
    this.finish(task, thread, plan);
    return true;
  }

  /**
   * Stop the plan: every running slice stops and shows not run, a blocked slice stays blocked,
   * and a finished slice keeps its merge. `line` writes the reason; a stopped chain has already
   * written its own.
   */
  halt(task: Task, cause: string, line = false) {
    let thread = this.host.thread(task.id);
    if (thread.plan?.phase !== 'running') return;
    for (const slice of thread.plan.slices)
      if (slice.lane && !slice.lane.pending && slice.turnId && this.open(slice.turnId))
        this.host.stopTurn(task.id, slice.turnId);
    if (this.closing.get(task.id) === 'checks') this.host.stopCombinedChecks(task.id);
    this.closing.delete(task.id);
    // A slice whose chain finished and only waited for its turn to merge keeps its work: it
    // merges now, in plan order, ahead of the stop.
    for (const id of order(thread.plan)) {
      const slice = find(thread.plan as ChatPlanState, id);
      if (slice?.status === 'running' && slice.lane?.step === 'merge')
        thread = this.merge(task, thread, slice, true);
    }
    const plan = thread.plan as ChatPlanState;
    const slices = plan.slices.map(({ lane: _lane, ...slice }) =>
      slice.status === 'queued' || slice.status === 'running'
        ? { ...slice, status: 'not-run' as const }
        : slice,
    );
    this.host.putThread(task, { ...thread, plan: { ...plan, phase: 'stopped', slices } });
    if (line) this.host.line(task, `Plan stopped: ${cause}.`);
  }

  /** Stop every running plan after a restart. Called with the IDs of threads whose plan runs. */
  recoverThreads(taskIds: readonly string[]) {
    for (const taskId of taskIds) {
      this.closing.delete(taskId);
      const task = this.host.task(taskId);
      if (task) this.halt(task, 'restarted', true);
    }
  }

  /** Run a proposed plan, or one slice of it. */
  run(payload: Payload<'RunChatPlan'>, effects: Effects): CommandResult {
    const task = this.host.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const thread = this.host.thread(task.id);
    const plan = thread.plan;
    if (!plan || plan.planId !== payload.planId)
      return blocked('plan-not-found', 'Refresh the thread and use the plan card shown.');
    if (plan.phase === 'running') return blocked('plan-running', 'Stop the plan first.');
    if (thread.activeTurnId || !this.host.free(task))
      return blocked('turn-running', 'Wait for the reply or stop it, then run the plan.');
    const done = new Set(plan.slices.filter((s) => s.status === 'done').map((s) => s.id));
    const one = payload.sliceId === undefined ? undefined : find(plan, payload.sliceId);
    if (payload.sliceId !== undefined) {
      const ready =
        one &&
        (one.status === 'failed' ||
          one.status === 'not-run' ||
          one.status === 'blocked' ||
          (one.status === 'queued' && plan.phase === 'proposed'));
      if (!one || !ready)
        return blocked(
          'slice-not-runnable',
          'Only a slice that failed, is blocked or has not run can run.',
        );
      if (!one.depends.every((id) => done.has(id)))
        return blocked('slice-waiting', 'Run the slices it depends on first.');
    } else if (plan.phase === 'finished')
      return blocked('plan-finished', 'Every slice of this plan is done.');
    const changes: Record<number, Partial<Slice>> = {};
    const picked: string[] = [];
    for (const override of payload.overrides ?? []) {
      const slice = find(plan, override.sliceId);
      const candidate = slice?.candidates.find(
        (value) => value.family === override.family && value.model === override.model,
      );
      if (!slice || !candidate || slice.status === 'done')
        return blocked('override-not-ranked', 'Pick a family the card lists for that slice.');
      if (
        slice.assignment?.family === candidate.family &&
        slice.assignment.model === candidate.model
      )
        continue;
      const reason = `Slice ${slice.id} (${slice.difficulty}) assigned to ${familyName[candidate.family]}: picked on the plan card.`;
      changes[slice.id] = { assignment: { ...candidate, reason } };
      picked.push(reason);
    }
    // One slice runs alone, so every other slice that is not done waits as not run. A blocked
    // slice runs again from a fresh copy.
    for (const slice of plan.slices)
      if (slice.status !== 'done') {
        const runs = !one || slice.id === one.id;
        changes[slice.id] = {
          ...changes[slice.id],
          status: runs ? 'queued' : 'not-run',
          ...(runs ? { turnId: null, lane: undefined, conflicts: undefined } : {}),
        };
      }
    this.put(task, thread, { ...plan, phase: 'running' }, changes);
    for (const reason of picked) this.host.line(task, reason);
    this.pump(task, effects);
    return { outcome: 'applied' };
  }

  /** Cancel a proposed plan, or stop a running one. */
  cancel(payload: Payload<'CancelChatPlan'>, effects: Effects): CommandResult {
    const task = this.host.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const thread = this.host.thread(task.id);
    const plan = thread.plan;
    if (!plan || plan.planId !== payload.planId)
      return blocked('plan-not-found', 'Refresh the thread and use the plan card shown.');
    if (plan.phase === 'proposed') {
      const slices = plan.slices.map((slice) => ({ ...slice, status: 'not-run' as const }));
      this.host.putThread(task, { ...thread, plan: { ...plan, phase: 'stopped', slices } });
      this.host.line(task, 'Plan cancelled.');
      return { outcome: 'applied' };
    }
    if (plan.phase !== 'running') return blocked('plan-not-running', 'The plan is not running.');
    this.halt(task, 'you cancelled it', true);
    if (thread.activeTurnId) this.host.stopActive(task.id, effects);
    return { outcome: 'applied' };
  }

  /** Run `work` in one transaction, then its effects. A failure leaves the card as it was. */
  private work(work: (effects: Effects) => void) {
    const effects: Effects = [];
    try {
      this.host.transaction(() => work(effects));
    } catch {
      // The card keeps its state, and each slice can still run from it.
      return;
    }
    for (const effect of effects) this.host.call(effect);
  }

  /** Read the orchestrator's plan: send a bad one back once, then assign and show the card. */
  private propose(task: Task, thread: ChatThread, turn: ChatTurn, effects: Effects) {
    if (turn.state !== 'done') return;
    const builder = thread.crew?.members.find((member) => member.role === 'builder')?.selection;
    if (!builder) return;
    const parsed = parsePlan(this.host.reply(turn) ?? '');
    if ('error' in parsed) {
      const retried = this.host.message(turn)?.startsWith(PLAN_RETRY);
      if (!retried && !sentMessage(thread) && !thread.activeTurnId) {
        const again = this.host.begin(
          task,
          thread,
          {
            text: planRetryText(parsed.error, this.host.message(turn) ?? ''),
            role: 'orchestrator',
            selection: turn.selection,
            attachments: [],
            files: [],
          },
          effects,
        );
        if (again.outcome === 'applied') return;
      }
      this.host.line(task, `Plan stopped: the plan did not pass validation. ${parsed.error}`);
      return;
    }
    const plan = parsed.plan;
    const slices = assignPlan(plan, {
      families: this.host.catalog(task.id).families,
      mode: thread.handoffMode,
      now: Date.parse(this.host.now()),
      builder,
      localContext: this.host.localContext(),
      localSliceFits: this.host.localSliceFits,
      files: this.files(task.id, plan),
    });
    const state: ChatPlanState = {
      planId: plan.planId,
      orchestratorTurnId: turn.id,
      goal: plan.goal,
      phase: thread.flightMode === 'glide' ? 'running' : 'proposed',
      slices,
    };
    this.host.putThread(task, { ...thread, plan: state });
    for (const slice of slices)
      this.host.line(
        task,
        slice.assignment?.reason ??
          `Slice ${slice.id} (${slice.difficulty}) has no family to run on: no connected family has allowance left.`,
      );
    if (state.phase === 'running') this.pump(task, effects);
  }

  /**
   * A lane's turn settled: move the lane to its next step. False when the plan stopped. A failed
   * or stopped step stops the plan, as one slice may be what the others wait on.
   */
  private step(task: Task, thread: ChatThread, plan: ChatPlanState, slice: Slice, turn: ChatTurn) {
    const lane = slice.lane as Lane;
    const id = slice.id;
    if (turn.state !== 'done') {
      const stopped = turn.state === 'stopped';
      const status = lane.step === 'resolve' ? 'blocked' : stopped ? 'not-run' : 'failed';
      this.put(task, thread, plan, { [id]: { status, lane: undefined } });
      this.halt(
        task,
        sentMessage(thread)
          ? 'you sent a new message'
          : stopped
            ? 'you stopped the reply'
            : lane.step === 'resolve'
              ? `the orchestrator could not resolve slice ${id}`
              : `slice ${id} failed. Run it again from the plan card`,
        true,
      );
      return false;
    }
    const next = (change: Partial<Lane>) => ({ [id]: { lane: { ...lane, ...change } } });
    if (lane.step === 'resolve') {
      this.put(task, thread, plan, {
        [id]: { status: 'done', turnId: lane.build, lane: undefined, conflicts: undefined },
      });
      this.host.line(task, `Slice ${id} finished: the orchestrator merged it in the thread copy.`);
      return true;
    }
    if (lane.step === 'build') {
      const reviewer = thread.crew?.members.some((member) => member.role === 'reviewer');
      const chain = !slice.readOnly && reviewer && thread.flightMode !== 'manual';
      this.put(task, thread, plan, next(chain ? { step: 'review', pending: true } : merge));
      return true;
    }
    if (lane.step === 'fix') {
      this.put(task, thread, plan, next({ step: 'review', pending: true, fixes: lane.fixes + 1 }));
      return true;
    }
    const review = this.host.reply(turn) ?? '';
    const findings = this.host.findings(review);
    const rounds = lane.rounds + 1;
    if (findings === null) {
      this.put(task, thread, plan, { [id]: { status: 'failed', lane: undefined } });
      this.halt(task, `the review of slice ${id} did not state its findings`, true);
      return false;
    }
    const fix = findings > 0 && lane.fixes < MAX_FIXES;
    this.put(
      task,
      thread,
      plan,
      next(fix ? { step: 'fix', pending: true, rounds } : { ...merge, rounds }),
    );
    return true;
  }

  /**
   * Move the plan as far as it goes now: merge finished slices in plan order, open every lane
   * step whose family is free, start every ready slice, and close the plan after the last one.
   */
  private pump(task: Task, effects: Effects) {
    let thread = this.host.thread(task.id);
    // After the last slice the checks and the crew chain move the plan on.
    if (thread.plan?.phase !== 'running' || this.closing.has(task.id)) return;
    const lanes = () =>
      (thread.plan as ChatPlanState).slices.filter(
        (slice) => slice.lane && !slice.lane.pending && slice.turnId && this.open(slice.turnId),
      );
    // A message from the person ends the plan once its running turns end.
    if (sentMessage(thread)) {
      if (!lanes().length) this.halt(task, 'you sent a new message', true);
      return;
    }
    const done = new Set(thread.plan.slices.filter((s) => s.status === 'done').map((s) => s.id));
    const homeless = thread.plan.slices.find(
      (s) => s.status === 'queued' && !s.assignment && s.depends.every((dep) => done.has(dep)),
    );
    if (homeless) return this.halt(task, `slice ${homeless.id} has no family to run on`, true);
    for (const id of order(thread.plan)) {
      const slice = find(thread.plan, id) as Slice;
      if (slice.status === 'done') continue;
      if (slice.status !== 'running' || slice.lane?.step !== 'merge') break;
      thread = this.merge(task, thread, slice);
      if (thread.plan?.phase !== 'running') return;
      if (find(thread.plan, id)?.status !== 'done') break;
    }
    for (const slice of thread.plan.slices) {
      if (!slice.lane?.pending) continue;
      const selection = this.laneSelection(task.id, thread, slice, slice.lane.step);
      if (!selection) {
        this.halt(
          task,
          `slice ${slice.id} has no ${slice.lane.step === 'resolve' ? 'orchestrator' : 'model'} to run on`,
          true,
        );
        return;
      }
      if (this.host.familyBusy(selection.family)) continue;
      thread = this.openStep(task, thread, slice, selection, effects);
      if (thread.plan?.phase !== 'running') return;
    }
    const busy = new Set(ChatFamilySchema.options.filter((family) => this.host.familyBusy(family)));
    for (const slice of readySlices(thread.plan, busy)) {
      thread = this.startSlice(task, thread, slice, effects);
      if (thread.plan?.phase !== 'running') return;
    }
    const plan = thread.plan;
    if (ended(plan)) return this.close(task, thread, plan, effects);
    const moving = plan.slices.some(
      (slice) =>
        slice.status === 'running' ||
        (slice.status === 'blocked' && slice.lane) ||
        (slice.status === 'queued' &&
          slice.depends.every((dep) => find(plan, dep)?.status === 'done')),
    );
    if (moving) return;
    const left = plan.slices.filter((slice) => slice.status !== 'done').length;
    this.halt(task, `${plural(left, 'slice has', 'slices have')} not run`);
    this.host.line(
      task,
      `Plan paused: ${plural(left, 'slice has', 'slices have')} not run. Run ${left === 1 ? 'it' : 'them'} from the plan card.`,
    );
  }

  /** Open a slice's builder turn in its own scratch copy. */
  private startSlice(task: Task, thread: ChatThread, slice: Slice, effects: Effects): ChatThread {
    const plan = thread.plan as ChatPlanState;
    if (!slice.assignment) {
      this.put(task, thread, plan, { [slice.id]: { status: 'failed' } });
      this.halt(task, `slice ${slice.id} has no family to run on`, true);
      return this.host.thread(task.id);
    }
    const lane: Lane = { step: 'build', pending: true, rounds: 0, fixes: 0, build: null };
    const saved = this.put(task, thread, plan, { [slice.id]: { status: 'running', lane } });
    const selection = this.selection(task.id, saved, slice.assignment);
    return this.openStep(task, saved, { ...slice, status: 'running', lane }, selection, effects);
  }

  /** Open the turn of a lane's pending step. */
  private openStep(
    task: Task,
    thread: ChatThread,
    slice: Slice,
    selection: ChatModelSelection,
    effects: Effects,
  ): ChatThread {
    const plan = thread.plan as ChatPlanState;
    const lane = slice.lane as Lane;
    const id = slice.id;
    const source = this.source(task.id, plan);
    const brief = source?.slices.find((value) => value.id === id);
    let text: string;
    if (lane.step === 'build') {
      if (!source || !brief || !slice.assignment) {
        this.put(task, thread, plan, { [id]: { status: 'failed', lane: undefined } });
        this.halt(task, `the orchestrator's reply for slice ${id} is gone`, true);
        return this.host.thread(task.id);
      }
      text = sliceBrief(source, brief, slice.assignment.reason);
    } else if (lane.step === 'review') text = this.host.reviewBrief;
    else if (lane.step === 'fix') {
      const last = slice.turnId ? this.host.turn(slice.turnId) : undefined;
      text = fixerBrief((last && this.host.reply(last)) ?? '');
    } else
      text = resolveBrief({
        slice,
        brief: brief?.brief ?? null,
        folder: laneFolder(this.host.scratchDirectory(task.id), id),
        conflicts: slice.conflicts ?? [],
      });
    // A read-only slice runs as an ask, the read-only role every adapter enforces. The resolve
    // turn writes the thread copy, so it runs as a fixer on the orchestrator's model.
    const role =
      lane.step === 'build'
        ? slice.readOnly
          ? 'ask'
          : 'assistant'
        : lane.step === 'review'
          ? 'reviewer'
          : 'fixer';
    const started = this.host.beginLane(
      task,
      thread,
      { text, role, selection, attachments: [], files: [], slice: id },
      effects,
    );
    const after = this.host.thread(task.id);
    if (typeof started !== 'string') {
      const status = lane.step === 'resolve' ? 'blocked' : 'failed';
      this.put(task, after, plan, { [id]: { status, lane: undefined } });
      this.halt(
        task,
        `slice ${id} could not start.${started.next ? ` ${started.next}` : ''}`.replace(/\.$/, ''),
        true,
      );
      return this.host.thread(task.id);
    }
    const build = lane.step === 'build' ? started : lane.build;
    const saved = this.put(task, after, after.plan as ChatPlanState, {
      [id]: { turnId: started, lane: { ...lane, pending: false, build } },
    });
    if (lane.step === 'build')
      this.host.line(
        task,
        `Slice ${id} started on ${familyName[selection.family]} (${selection.model}).`,
      );
    return saved;
  }

  /**
   * Replay a finished slice onto the thread copy. A conflict blocks it for the orchestrator, or,
   * while the plan stops, for the card to run again.
   */
  private merge(task: Task, thread: ChatThread, slice: Slice, stopping = false): ChatThread {
    const plan = thread.plan as ChatPlanState;
    const lane = slice.lane as Lane;
    const id = slice.id;
    const root = this.host.projectPath(task);
    const folder = laneFolder(this.host.scratchDirectory(task.id), id);
    let replay: ReturnType<typeof replayLane>;
    try {
      if (!root || !thread.base) throw Error('The project is no longer registered.');
      replay = slice.readOnly
        ? { applied: [], conflicts: [] }
        : replayLane({
            root,
            base: thread.base,
            threadScratch: this.host.scratchDirectory(task.id),
            folder,
          });
    } catch (error) {
      const failed = this.put(task, thread, plan, { [id]: { status: 'failed', lane: undefined } });
      const why = error instanceof Error ? ` ${error.message}` : '';
      if (stopping) return failed;
      this.halt(task, `slice ${id} could not merge.${why}`.replace(/\.$/, ''), true);
      return this.host.thread(task.id);
    }
    const { applied, conflicts } = replay;
    if (!conflicts.length) {
      const saved = this.put(task, thread, plan, {
        [id]: { status: 'done', turnId: lane.build, lane: undefined },
      });
      this.host.line(
        task,
        slice.readOnly
          ? `Slice ${id} finished: it only read.`
          : `Slice ${id} finished: ${plural(applied.length, 'file', 'files')} merged.`,
      );
      return saved;
    }
    const saved = this.put(task, thread, plan, {
      [id]: {
        status: 'blocked',
        conflicts: listedConflicts(conflicts),
        lane: stopping ? undefined : { ...lane, step: 'resolve', pending: true },
      },
    });
    const named = listedConflicts(conflicts).join(', ');
    const more = conflicts.length > listedConflicts(conflicts).length ? ' and more' : '';
    this.host.line(
      task,
      `Slice ${id} blocked: ${plural(conflicts.length, 'file conflicts', 'files conflict')} with the thread copy: ${named}${more}. ${stopping ? 'Run it again from the plan card.' : 'The orchestrator gets one turn to resolve it.'}`,
    );
    return saved;
  }

  /**
   * Every slice is done. The project checks run on the merged copy, then the challenger argues
   * against the last slice that wrote. A plan whose slices only read closes without either.
   */
  private close(task: Task, thread: ChatThread, plan: ChatPlanState, effects: Effects) {
    const last = plan.slices.findLast((slice) => {
      const turn = slice.turnId ? this.host.turn(slice.turnId) : undefined;
      return turn && writesScratch(turn.role);
    })?.turnId;
    // Manual runs nothing after a builder turn, so the plan closes without a challenge.
    if (thread.flightMode === 'manual' || !last) return this.finish(task, thread, plan);
    const directory = this.host.scratchDirectory(task.id);
    // Marked once the transaction commits, so a rollback leaves the plan free to move on.
    effects.push(() => {
      this.closing.set(task.id, 'checks');
      this.host.runCombinedChecks(task.id, directory).then(
        (result) => this.checked(task.id, last, result),
        () => this.checked(task.id, last, null),
      );
    });
  }

  /** The checks on the merged copy ended. A failure goes to the fixer once, then the challenge. */
  private checked(taskId: string, last: string, result: ChecksOutcome | null) {
    if (this.closing.get(taskId) !== 'checks') return;
    this.closing.set(taskId, 'chain');
    this.work((effects) => {
      const task = this.host.task(taskId);
      const thread = this.host.thread(taskId);
      if (!task || thread.plan?.phase !== 'running') return;
      if (!result) return this.halt(task, 'the checks could not run', true);
      if (result.outcome === 'stopped') return this.halt(task, 'you stopped the checks', true);
      if (sentMessage(thread)) return this.halt(task, 'you sent a new message', true);
      const labels = (status: 'passed' | 'failed') =>
        result.runs
          .filter((run) => run.status === status)
          .map((run) => run.label)
          .join(', ');
      const chain: ChatCrewChain = {
        builderTurnId: last,
        step: 'challenge',
        reviewRounds: 0,
        fixes: 0,
        reason: null,
      };
      if (result.outcome === 'denied')
        this.host.line(task, 'The project checks did not run. The commands were not allowed.');
      if (result.outcome === 'passed') this.host.line(task, `Checks passed: ${labels('passed')}.`);
      if (result.outcome === 'failed') {
        this.host.line(task, `Checks failed: ${labels('failed')}. The fixer runs on their output.`);
        return this.host.crewStep(
          task,
          thread,
          { ...chain, step: 'fix' },
          effects,
          result.brief ?? undefined,
        );
      }
      this.host.crewStep(task, thread, chain, effects);
    });
    this.host.wakeQueues();
  }

  private finish(task: Task, thread: ChatThread, plan: ChatPlanState) {
    this.closing.delete(task.id);
    this.host.putThread(task, { ...thread, plan: { ...plan, phase: 'finished' } });
    const start = this.host.turn(plan.orchestratorTurnId)?.sequence ?? 0;
    const after = this.host
      .turns(task.id)
      .filter((turn) => turn.sequence > start && turn.state === 'done');
    const reviews = after.filter((turn) => turn.role === 'reviewer').length;
    const fixes = after.filter((turn) => turn.role === 'fixer').length;
    this.host.line(
      task,
      `Crew finished: ${plural(plan.slices.length, 'slice', 'slices')}, ${plural(reviews, 'review', 'reviews')}, ${plural(fixes, 'fix', 'fixes')}.`,
    );
  }

  /** The model a lane step runs on. A slice's fixer is the crew's fixer, else its own builder. */
  private laneSelection(
    taskId: string,
    thread: ChatThread,
    slice: Slice,
    step: Lane['step'],
  ): ChatModelSelection | null {
    const member = (role: string) =>
      thread.crew?.members.find((entry) => entry.role === role)?.selection;
    if (step === 'review') return member('reviewer') ?? null;
    if (step === 'resolve') return member('orchestrator') ?? null;
    if (step === 'fix' && member('fixer')) return member('fixer') ?? null;
    return slice.assignment ? this.selection(taskId, thread, slice.assignment) : null;
  }

  private open(turnId: string): boolean {
    return OPEN.has(this.host.turn(turnId)?.state ?? 'done');
  }

  /** The plan as the orchestrator wrote it. The card leaves the briefs in its reply. */
  private source(taskId: string, plan: ChatPlanState): ChatPlan | null {
    const turn = this.host.turn(plan.orchestratorTurnId);
    const parsed = turn?.taskId === taskId ? parsePlan(this.host.reply(turn) ?? '') : null;
    return parsed && 'plan' in parsed && parsed.plan.planId === plan.planId ? parsed.plan : null;
  }

  /** The builder's effort on the builder's model, otherwise the model's own default. */
  private selection(
    taskId: string,
    thread: ChatThread,
    assignment: NonNullable<Slice['assignment']>,
  ): ChatModelSelection {
    const builder = thread.crew?.members.find((member) => member.role === 'builder')?.selection;
    if (builder?.family === assignment.family && builder.model === assignment.model) return builder;
    const effort = this.host
      .catalog(taskId)
      .families.find((entry) => entry.family === assignment.family)
      ?.models.find((model) => model.model === assignment.model)?.defaultEffort;
    return { family: assignment.family, model: assignment.model, effort: effort ?? 'default' };
  }

  /** Size and kind of each named file in the scratch copy. A file not there yet counts as empty. */
  private files(taskId: string, plan: ChatPlan): Record<string, PlanFile> {
    const scratch = this.host.scratchDirectory(taskId);
    const files: Record<string, PlanFile> = {};
    for (const path of new Set(plan.slices.flatMap((slice) => slice.files)))
      files[path] = readFile(join(scratch, path), path);
    return files;
  }

  private put(
    task: Task,
    thread: ChatThread,
    plan: ChatPlanState,
    changes: Record<number, Partial<Slice>>,
  ): ChatThread {
    // A field set to undefined leaves the record, so the card never carries a stale lane.
    const slices = plan.slices.map((slice) => {
      const { lane, conflicts, ...rest } = { ...slice, ...changes[slice.id] };
      return { ...rest, ...(lane ? { lane } : {}), ...(conflicts ? { conflicts } : {}) };
    });
    return this.host.putThread(task, { ...thread, plan: { ...plan, slices } });
  }
}

const merge: Partial<Lane> = { step: 'merge', pending: false };

const find = (plan: Pick<ChatPlanState, 'slices'>, id: number) =>
  plan.slices.find((slice) => slice.id === id);

/** Every slice is done and nothing waits to run. */
const ended = (plan: ChatPlanState) => plan.slices.every((slice) => slice.status === 'done');

function readFile(path: string, name: string): PlanFile {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { bytes: 0, image: false };
    const head = Buffer.alloc(Math.min(stat.size, 64));
    const fd = openSync(path, 'r');
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    return { bytes: stat.size, image: detectType(head, name, null).startsWith('image/') };
  } catch {
    return { bytes: 0, image: false };
  }
}
