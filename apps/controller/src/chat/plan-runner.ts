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
  type ChatRole,
  type ChatThread,
  type ChatTurn,
  type Command,
  type CommandResult,
  type Task,
  type WebhookEventKind,
  writesScratch,
} from '@crewkite/contracts';
import { z } from 'zod';
import { isLocalFitFailure } from '../providers/local/chat.ts';
import {
  type PlanEnding,
  type PlanEvent,
  type PlanEventBody,
  stepTurn,
} from '../recipes/events.ts';
import { listChanges } from './changes.ts';
import { type ChecksOutcome, enabledChecks } from './checks.ts';
import { detectType } from './files.ts';
import {
  type AssignedRoute,
  assignPlan,
  hasPlanBlock,
  type PlanFile,
  type PlanInputs,
  parsePlan,
  ruledOut,
  type SliceRole,
} from './plan.ts';
import {
  laneCopy,
  laneFolder,
  listedConflicts,
  order,
  prepareLaneCopy,
  readySlices,
  recordStep,
  replayLane,
  resolveBrief,
} from './plan-lanes.ts';
import {
  familyName,
  fixerBrief,
  localSliceBrief,
  PLAN_RETRY,
  planRetryText,
  reportBrief,
  reportChallengeBrief,
  sliceBrief,
} from './prompt.ts';

type Payload<C extends Command['command']> = Extract<Command, { command: C }>['payload'];
type Effects = (() => void)[];
type Message = Pick<ChatQueuedMessage, 'text' | 'role' | 'selection' | 'attachments' | 'files'>;
type Slice = ChatPlanState['slices'][number];
/** A thread a report recipe's run started. `going` says that run has not ended yet. */
type ReportThread = { going: boolean };
type Lane = NonNullable<Slice['lane']>;

/**
 * A plan with more slices than a recipe run allows fails the way one with more than the schema's
 * limit does, with the same words, so the orchestrator hears it once and tries again.
 */
function withinCap(
  parsed: ReturnType<typeof parsePlan>,
  cap: number | undefined,
): ReturnType<typeof parsePlan> {
  if (cap === undefined || 'error' in parsed || parsed.plan.slices.length <= cap) return parsed;
  const over = z.array(z.unknown()).max(cap).safeParse(parsed.plan.slices);
  return {
    error: `The plan does not match the schema. slices: ${over.error?.issues[0]?.message ?? ''}`,
  };
}

/**
 * A thread that reports only reads, so a plan with a slice that writes fails the way one over the
 * cap does, and the orchestrator hears it once and tries again.
 */
function onlyReads(parsed: ReturnType<typeof parsePlan>, report: ReportThread | null) {
  if (!report || 'error' in parsed || parsed.plan.slices.every((slice) => slice.readOnly))
    return parsed;
  return { error: writes(report) };
}

/** Why a thread that reports refuses a slice that writes, while its run is going and after. */
const writes = (report: ReportThread) =>
  report.going
    ? 'A report run only reads. The plan has a slice that writes.'
    : 'This thread reports and only reads. Start a new thread to change files.';

/**
 * True when the person sent a message that waits in the thread. A queued Ask is a read-only side
 * question, so it leaves a crew chain or a plan running and starts once they end.
 */
export function sentMessage(thread: ChatThread): boolean {
  return thread.queued.some((message) => message.role !== 'ask');
}

/**
 * How a plan's checks ended. `held` says nothing may go on, for `cause`: a process may still
 * write the copy, the dependency copy is not ready, or the checks, their permissions or the
 * dependencies moved while they ran.
 */
export type PlanChecks =
  | ChecksOutcome
  | Readonly<{ outcome: 'held'; cause: string; runs: ChecksOutcome['runs']; brief: null }>;

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
  /**
   * Tell the notice listener how the plan ended, once the line that says so is written. `line` is
   * that line, or empty when the thread shows none, such as a plan that waits for the person.
   */
  notice: (kind: WebhookEventKind, task: Task, line: string) => void;
  /** Hears each fact the plan decides, inside the transaction that writes it. */
  observe?: (event: PlanEvent) => void;
  turn: (turnId: string) => ChatTurn | undefined;
  turns: (taskId: string) => ChatTurn[];
  /** The text of a turn's reply, and of the message it answered. */
  reply: (turn: ChatTurn) => string | undefined;
  message: (turn: ChatTurn) => string | undefined;
  /** Send a message. With `say`, a refusal that wrote no line of its own writes `next` as one. */
  begin: (
    task: Task,
    thread: ChatThread,
    input: Message,
    effects: Effects,
    say?: boolean,
  ) => CommandResult;
  /**
   * Open a turn in a slice's lane. It leaves the thread's pick, its handoff and its sessions
   * alone. Returns the new turn's ID, or the refusal. `line` goes into the thread just before the
   * turn's brief, so it reads ahead of the turn's output, and only when the turn opens.
   */
  beginLane: (
    task: Task,
    thread: ChatThread,
    input: Message & { slice: number },
    effects: Effects,
    line?: string,
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
  /**
   * The family is out of included allowance and its credit switch is off, so a turn of this role
   * there would spend credits the person did not allow. Absent means never.
   */
  creditsPaused?: (taskId: string, selection: ChatModelSelection, role: ChatRole) => boolean;
  /** Where an automatic handoff would move this role's work off `from`, or null. */
  nextFamily?: (taskId: string, from: ChatFamily, role: ChatRole) => ChatModelSelection | null;
  /**
   * The connection the person assigned for this role on this family, and whether it can run now,
   * or null for the family's own route. Absent means no role has one.
   */
  assigned?: (taskId: string, family: ChatFamily, role: SliceRole) => AssignedRoute;
  /** The most slices a plan on this thread may hold, when a recipe run set one. */
  sliceCap?: (taskId: string) => number | undefined;
  /**
   * Whether a report recipe's run started the thread, whatever the run's state, or null. Every
   * plan on such a thread is a report plan. The one answer every report rule reads.
   */
  reportThread?: (taskId: string) => ReportThread | null;
  /**
   * The line of a turn a schedule's limit kept back before it was sent, or undefined. The stop it
   * causes carries that line, since the provider never saw the turn.
   */
  keptBack?: (turnId: string) => string | undefined;
  /** Ask the running turn to stop. Its settle finishes the rest. */
  stopActive: (taskId: string, effects: Effects) => void;
  /**
   * Ask one open turn of the thread to stop, after the caller's transaction commits. `why` is the
   * plan's reason, which the turn's stop line repeats.
   */
  stopTurn: (taskId: string, turnId: string, why: string) => void;
  /** Whether no process of an earlier turn may still write to the scratch copy. */
  free: (task: Task) => boolean;
  /** The task IDs of threads whose plan runs. */
  planThreads: () => string[];
  /** Start what waits in each thread's queue, once the thread is free. */
  wakeQueues: () => void;
  projectPath: (task: Task) => string | undefined;
  scratchDirectory: (taskId: string) => string;
  /**
   * The gate after a slice's builder or fixer turn, in the slice's own copy with its own
   * dependency copy. It asks like any run.
   */
  runLaneChecks: (taskId: string, slice: number, directory: string) => Promise<PlanChecks>;
  /**
   * The project checks on the thread copy after slice `slice` merged into it. They ask like any
   * run.
   */
  runCombinedChecks: (taskId: string, directory: string, slice: number) => Promise<PlanChecks>;
  /** End the plan's runs, and the question before them. Only the plan calls it. */
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
 * own scratch copy with its own review chain, and at most one turn runs per family. Each writing
 * turn of a slice passes its gate in the slice's copy before anything else runs there. A finished
 * slice replays onto the thread copy in plan order, and the project checks run on the merged copy
 * before the next slice merges. After the last slice the challenger runs. A report run has no
 * writing slice: after the last one the challenger argues against the findings and the
 * orchestrator writes the report, both read only.
 */
export class PlanRunner {
  private readonly host: PlanHost;
  /** Threads whose plan has every slice done while the challenge runs on the thread copy. */
  private readonly closing = new Set<string>();
  /**
   * The checks of each thread's plan, one event after another: a slice's gate, or the checks of
   * the thread copy after a merge. They share the thread's one question, so they never overlap.
   */
  private readonly checking = new Map<string, Promise<void>>();
  /**
   * The thread copy's checks after a merge, by thread. No other slice merges and the plan does not
   * close until they end. The mark tells a stopped plan's late result from the current one.
   */
  private readonly combining = new Map<string, symbol>();
  /** The checks' output for a slice's fix, by the turn whose gate sent it. */
  private readonly briefs = new Map<string, string>();
  /** The model and effort a Retry picked for a slice, by task and slice, until the slice starts. */
  private readonly retried = new Map<string, ChatModelSelection>();

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
      if (this.isReportTurn(turn)) return this.reported(task, thread, turn);
      if (turn.role === 'orchestrator') return this.propose(task, thread, turn, effects);
      const plan = thread.plan;
      if (turn.slice === undefined || plan?.phase !== 'running') return;
      const slice = find(plan, turn.slice);
      if (!slice?.lane || slice.turnId !== turn.id) return;
      if (this.step(task, thread, plan, slice, turn, effects)) this.pump(task, effects);
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

  /**
   * The chain finished after the last slice. True when the plan wrote the closing line, or in a
   * report run opened the turn that writes it.
   */
  finished(task: Task, effects: Effects): boolean {
    const thread = this.host.thread(task.id);
    const plan = thread.plan;
    if (plan?.phase !== 'running' || !ended(plan)) return false;
    if (this.host.reportThread?.(task.id)) this.report(task, thread, plan, effects);
    else this.finish(task, thread, plan);
    return true;
  }

  /**
   * Whether the turn is its plan's report turn: an orchestrator turn that answers the message the
   * plan wrote to ask for the report. That message exists only once every slice is done and the
   * challenge has ended. A rerun after a limit, Continue on the limit card, the start at reset,
   * Retry and Regenerate answer the same message, so the turn is the report turn on whichever
   * provider it runs. A continuation answers a message of its own, which then names it.
   */
  isReportTurn(turn: ChatTurn): boolean {
    const messageId = this.host.thread(turn.taskId).plan?.report?.messageId;
    return turn.role === 'orchestrator' && !!messageId && turn.userMessageId === messageId;
  }

  /**
   * A turn just opened that runs `earlier`, a report turn, again after its plan ended: Retry,
   * Regenerate, a continuation, Continue on the limit card or the start at reset. The plan runs
   * again from its report and ends the way the new turn ends, with its line and notice. The run's
   * row has ended and stays as it is.
   */
  reportRerun(task: Task, earlier: ChatTurn, effects: Effects) {
    if (!this.isReportTurn(earlier)) return;
    const thread = this.host.thread(task.id);
    const plan = thread.plan;
    const turn = thread.activeTurnId ? this.host.turn(thread.activeTurnId) : undefined;
    if (!plan || plan.phase === 'running' || turn?.role !== 'orchestrator') return;
    // A continuation answers a message of its own, so the plan names that one from now on.
    const report = { messageId: turn.userMessageId };
    this.host.putThread(task, { ...thread, plan: { ...plan, phase: 'running', report } });
    this.observe(task, { kind: 'plan-started' });
    this.reportStep(task, plan, turn);
    // The report closes the plan, so nothing may start the challenge again meanwhile.
    effects.push(() => {
      if (this.host.thread(task.id).plan?.phase === 'running') this.closing.add(task.id);
    });
  }

  /**
   * Stop the plan: every running slice stops and shows not run, a blocked slice stays blocked,
   * and a finished slice keeps its merge. `line` writes the reason; a stopped chain has already
   * written its own. `outcome` is what the stop means for the work, when the person did not cause
   * it: a failure or a usage limit. A cancel, a restart or a pause has none. `ending` is how the
   * plan ended for its listener, when this writes the line.
   */
  halt(
    task: Task,
    cause: string,
    line = false,
    outcome?: 'failed' | 'limit',
    ending: PlanEnding = outcome ? 'failed' : 'stopped',
  ) {
    let thread = this.host.thread(task.id);
    if (thread.plan?.phase !== 'running') return;
    for (const slice of thread.plan.slices) {
      if (slice.lane && !slice.lane.pending && slice.turnId && this.open(slice.turnId))
        this.host.stopTurn(task.id, slice.turnId, cause);
      if (slice.turnId) this.briefs.delete(slice.turnId);
    }
    // The open check stops. A check event still waiting its turn finds the plan stopped and runs
    // nothing.
    if (this.checking.has(task.id)) this.host.stopCombinedChecks(task.id);
    this.closing.delete(task.id);
    this.combining.delete(task.id);
    // A slice whose chain finished and only waited for its turn to merge keeps its work: it
    // merges now, in plan order, ahead of the stop.
    for (const id of order(thread.plan)) {
      const slice = find(thread.plan as ChatPlanState, id);
      if (slice?.status === 'running' && slice.lane?.step === 'merge')
        thread = this.merge(task, thread, slice, true).thread;
    }
    const plan = thread.plan as ChatPlanState;
    const slices = plan.slices.map(({ lane: _lane, ...slice }) =>
      slice.status === 'queued' || slice.status === 'running'
        ? { ...slice, status: 'not-run' as const }
        : slice,
    );
    this.host.putThread(task, { ...thread, plan: { ...plan, phase: 'stopped', slices } });
    if (!line) return;
    const text = `Plan stopped: ${cause}.`;
    this.host.line(task, text);
    this.ended(task, ending, text);
    if (outcome) this.host.notice(outcome, task, text);
  }

  /** Stop every running plan after a restart. Called with the IDs of threads whose plan runs. */
  recoverThreads(taskIds: readonly string[]) {
    for (const taskId of taskIds) {
      this.closing.delete(taskId);
      this.combining.delete(taskId);
      const task = this.host.task(taskId);
      // Nobody stopped the work, and it does not go on by itself, so it ended as failed.
      if (task) this.halt(task, 'restarted', true, undefined, 'failed');
    }
  }

  /**
   * Retry under a failed slice turn runs that slice again, on the model the person picked, the
   * crew builder unless they picked another. In Balanced and Glide the plan goes on from there:
   * the slices not done queue behind it. Manual runs the one slice.
   */
  retrySlice(
    task: Task,
    turn: ChatTurn,
    picked: ChatModelSelection | undefined,
    effects: Effects,
  ): CommandResult {
    const thread = this.host.thread(task.id);
    const plan = thread.plan;
    const slice = plan && turn.slice !== undefined ? find(plan, turn.slice) : undefined;
    if (!plan || !slice)
      return blocked('plan-not-found', 'Refresh the thread and use the plan card shown.');
    const builder = thread.crew?.members.find((member) => member.role === 'builder')?.selection;
    const selection = picked ?? builder;
    if (!selection) return blocked('selection-unavailable', 'Pick a provider and model.');
    const listed = this.host
      .catalog(task.id)
      .families.find((entry) => entry.family === selection.family && entry.connected)
      ?.models.some((model) => model.model === selection.model);
    if (!listed)
      return blocked('selection-unavailable', 'Pick a model a connected provider lists.');
    const own = selection.family === builder?.family && selection.model === builder.model;
    const reason = `Slice ${slice.id} (${slice.difficulty}) assigned to ${familyName[selection.family]} (${selection.model}): ${own ? "Builder, the crew's model" : 'picked on Retry'}.`;
    return this.run({ taskId: task.id, planId: plan.planId, sliceId: slice.id }, effects, {
      assignment: { family: selection.family, model: selection.model, reason },
      selection,
    });
  }

  /** Run a proposed plan, or one slice of it. */
  run(
    payload: Payload<'RunChatPlan'>,
    effects: Effects,
    retry?: { assignment: NonNullable<Slice['assignment']>; selection: ChatModelSelection },
  ): CommandResult {
    const task = this.host.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const thread = this.host.thread(task.id);
    const plan = thread.plan;
    if (!plan || plan.planId !== payload.planId)
      return blocked('plan-not-found', 'Refresh the thread and use the plan card shown.');
    if (plan.phase === 'running') return blocked('plan-running', 'Stop the plan first.');
    // A card stored before plans carried the report mark may hold a slice that writes.
    const reporting = this.host.reportThread?.(task.id) ?? null;
    if (reporting && plan.slices.some((slice) => !slice.readOnly && slice.status !== 'done'))
      return blocked('report-reads', writes(reporting));
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
    if (retry && one) {
      changes[one.id] = { assignment: retry.assignment };
      this.retried.set(`${task.id}:${one.id}`, retry.selection);
    }
    // One slice runs alone, so every other slice that is not done waits as not run. A retry in
    // Balanced or Glide goes on with the plan, so the rest queue behind it. A blocked slice runs
    // again from a fresh copy.
    const continues = !!retry && thread.flightMode !== 'manual';
    for (const slice of plan.slices)
      if (slice.status !== 'done') {
        const runs = !one || slice.id === one.id || continues;
        changes[slice.id] = {
          ...changes[slice.id],
          status: runs ? 'queued' : 'not-run',
          ...(runs ? { turnId: null, lane: undefined, conflicts: undefined } : {}),
        };
      }
    // Every plan on a thread that reports is a report plan, a card stored without the mark too. It
    // names no report message until it writes a new one.
    const report = reporting ? { report: { messageId: null } } : {};
    this.put(task, thread, { ...plan, ...report, phase: 'running' }, changes);
    this.observe(task, { kind: 'plan-started' });
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
      this.ended(task, 'stopped', 'Plan cancelled.');
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
    const reply = this.host.reply(turn) ?? '';
    // A reply with no plan block answered the person directly, as the brief asks for a question
    // or a request that changes no file. Nothing more runs, so that reply ends the work.
    // A thread that reports always plans, so a reply with no plan block goes back like a refused
    // plan.
    const report = this.host.reportThread?.(task.id) ?? null;
    if (!report && !hasPlanBlock(reply)) {
      this.ended(task, 'finished', '');
      return this.host.notice('finished', task, '');
    }
    const parsed = onlyReads(withinCap(parsePlan(reply), this.host.sliceCap?.(task.id)), report);
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
      const text = `Plan stopped: the plan did not pass validation. ${parsed.error}`;
      this.host.line(task, text);
      this.ended(task, 'failed', text);
      this.host.notice('failed', task, text);
      return;
    }
    const plan = parsed.plan;
    const fixer = thread.crew?.members.find((member) => member.role === 'fixer')?.selection;
    const { rows: slices, unassigned } = assignPlan(plan, {
      families: this.host.catalog(task.id).families,
      mode: thread.handoffMode,
      now: Date.parse(this.host.now()),
      builder,
      fixer: fixer ?? null,
      autoHandoff: thread.autoHandoff,
      // The message the orchestrator answered, or on its retry the request it quotes.
      excluded: ruledOut(this.host.message(turn) ?? ''),
      localContext: this.host.localContext(),
      localSliceFits: this.host.localSliceFits,
      files: this.files(task.id, plan),
      assigned: (family, role) => this.host.assigned?.(task.id, family, role) ?? null,
    });
    const state: ChatPlanState = {
      planId: plan.planId,
      orchestratorTurnId: turn.id,
      goal: plan.goal,
      phase: thread.flightMode === 'glide' ? 'running' : 'proposed',
      slices,
      ...(report ? { report: { messageId: null } } : {}),
    };
    this.host.putThread(task, { ...thread, plan: state });
    const waits = state.phase === 'proposed';
    this.observe(task, {
      kind: 'plan-proposed',
      orchestratorTurnId: turn.id,
      slices: slices.length,
      waits,
    });
    this.observe(task, waits ? { kind: 'asked', question: 'plan' } : { kind: 'plan-started' });
    // The plan card shows each assignment and its reason, so only a slice with no model to run
    // on gets a line of its own.
    for (const slice of slices) {
      const why = unassigned[slice.id];
      if (!slice.assignment && why) this.host.line(task, why);
    }
    if (state.phase === 'running') this.pump(task, effects);
    // Balanced and Manual wait for Run plan. Each orchestrator turn proposes one plan.
    else this.host.notice('approval-needed', task, 'waiting for approval');
  }

  /**
   * A lane's turn settled: move the lane to its next step. False when the plan stopped, or when
   * the thread copy's checks run first. A failed or stopped step stops the plan, as one slice may
   * be what the others wait on.
   */
  private step(
    task: Task,
    thread: ChatThread,
    plan: ChatPlanState,
    slice: Slice,
    turn: ChatTurn,
    effects: Effects,
  ) {
    const lane = slice.lane as Lane;
    const id = slice.id;
    if (turn.state !== 'done' && this.handOn(task, thread, plan, slice, turn)) return true;
    if (turn.state !== 'done') {
      const stopped = turn.state === 'stopped';
      const status = lane.step === 'resolve' ? 'blocked' : stopped ? 'not-run' : 'failed';
      this.put(task, thread, plan, { [id]: { status, lane: undefined } });
      // A turn the client ended on its own is a failure. Any other stop was asked for.
      const limited =
        turn.stopReason === 'limit' ||
        (turn.state === 'failed' && turn.failure?.kind === 'usage-limit');
      // A step a schedule's limit kept back says so in the plan's own line.
      const kept = limited ? this.host.keptBack?.(turn.id) : undefined;
      this.halt(
        task,
        stopped
          ? turn.stopCause === 'client'
            ? 'the provider ended the turn'
            : 'you stopped the reply'
          : kept
            ? `${kept} Run it again from the plan card`
            : lane.step === 'resolve'
              ? `the orchestrator could not resolve slice ${id}`
              : `slice ${id} failed. Run it again from the plan card`,
        true,
        stopped
          ? turn.stopCause === 'client'
            ? 'failed'
            : undefined
          : limited
            ? 'limit'
            : 'failed',
      );
      return false;
    }
    const next = (change: Partial<Lane>) => ({ [id]: { lane: { ...lane, ...change } } });
    if (lane.step === 'resolve') {
      // The slice's clean paths go in only now, beside the conflicts the orchestrator merged.
      const merged = this.merge(task, thread, slice, false, true);
      if (merged.thread.plan?.phase !== 'running') return false;
      if (!merged.changed || !checksOn(merged.thread)) return true;
      effects.push(() => this.combine(task.id, id));
      return false;
    }
    const chain = chained(thread, slice);
    // A slice's own changes are what its builder and fixes changed. What only a review changed,
    // such as another slice's merged work in this copy, stays out of the replay.
    if (lane.step !== 'build' || chain)
      try {
        const root = this.host.projectPath(task);
        if (!root || !thread.base) throw Error('The project is no longer registered.');
        recordStep({
          root,
          base: thread.base,
          folder: laneFolder(this.host.scratchDirectory(task.id), id),
          writer: lane.step !== 'review',
        });
      } catch (error) {
        this.put(task, thread, plan, { [id]: { status: 'failed', lane: undefined } });
        const why = error instanceof Error ? ` ${error.message}` : '';
        this.halt(
          task,
          `slice ${id} could not record its changes.${why}`.replace(/\.$/, ''),
          true,
          'failed',
        );
        return false;
      }
    // The slice's writing turn passes its gate in its own copy before the lane moves on.
    if ((lane.step === 'build' || lane.step === 'fix') && !slice.readOnly && checksOn(thread)) {
      const step = lane.step;
      effects.push(() => this.gate(task.id, id, turn.id, step));
      return true;
    }
    if (lane.step === 'build') {
      this.put(task, thread, plan, next(chain ? { step: 'review', pending: true } : merge));
      return true;
    }
    if (lane.step === 'fix') {
      // A crew with no reviewer gets a fix only from the gate. With the checks switched off
      // since, that fix merges.
      const after = chain ? { step: 'review' as const, pending: true } : merge;
      this.put(task, thread, plan, next({ ...after, fixes: lane.fixes + 1 }));
      return true;
    }
    const review = this.host.reply(turn) ?? '';
    const findings = this.host.findings(review);
    const rounds = lane.rounds + 1;
    if (findings === null) {
      this.put(task, thread, plan, { [id]: { status: 'failed', lane: undefined } });
      this.halt(task, `the review of slice ${id} did not state its findings`, true, 'failed');
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
   * A Local slice whose work did not fit the window goes to the crew builder, once, when the crew
   * runs on its own. The slice starts over from a fresh copy. True when it was handed on.
   */
  private handOn(
    task: Task,
    thread: ChatThread,
    plan: ChatPlanState,
    slice: Slice,
    turn: ChatTurn,
  ) {
    const builder = thread.crew?.members.find((member) => member.role === 'builder')?.selection;
    if (
      turn.state !== 'failed' ||
      slice.lane?.step !== 'build' ||
      turn.selection.family !== 'local' ||
      !isLocalFitFailure(turn.failure) ||
      thread.flightMode === 'manual' ||
      sentMessage(thread) ||
      !builder ||
      builder.family === 'local'
    )
      return false;
    const name = familyName[builder.family];
    this.put(task, thread, plan, {
      [slice.id]: {
        status: 'queued',
        turnId: null,
        lane: undefined,
        assignment: {
          family: builder.family,
          model: builder.model,
          reason: `Slice ${slice.id} (${slice.difficulty}) assigned to ${name}: it did not fit Local's context.`,
        },
      },
    });
    this.host.line(
      task,
      `Slice ${slice.id} did not fit on Local, so the builder on ${name} takes it. ${turn.failure?.message ?? ''}`.trim(),
    );
    return true;
  }

  /**
   * Move the plan as far as it goes now: merge finished slices in plan order, open every lane
   * step whose family is free, start every ready slice, and close the plan after the last one. A
   * merge that changed the thread copy starts its checks, and nothing else merges and the plan
   * does not close until they end.
   */
  private pump(task: Task, effects: Effects) {
    let thread = this.host.thread(task.id);
    // After the last slice the crew chain moves the plan on.
    if (thread.plan?.phase !== 'running' || this.closing.has(task.id)) return;
    // A message from the person waits in the queue while the plan runs, like any other message,
    // and starts once the plan has ended.
    const done = new Set(thread.plan.slices.filter((s) => s.status === 'done').map((s) => s.id));
    const homeless = thread.plan.slices.find(
      (s) => s.status === 'queued' && !s.assignment && s.depends.every((dep) => done.has(dep)),
    );
    if (homeless)
      return this.halt(task, `slice ${homeless.id} has no family to run on`, true, 'failed');
    let checking = this.combining.has(task.id);
    if (!checking)
      for (const id of order(thread.plan)) {
        const slice = find(thread.plan, id) as Slice;
        if (slice.status === 'done') continue;
        if (slice.status !== 'running' || slice.lane?.step !== 'merge') break;
        const merged = this.merge(task, thread, slice);
        thread = merged.thread;
        if (thread.plan?.phase !== 'running') return;
        if (find(thread.plan, id)?.status !== 'done') break;
        if (merged.changed && checksOn(thread)) {
          checking = true;
          effects.push(() => this.combine(task.id, id));
          break;
        }
      }
    for (const slice of thread.plan.slices) {
      if (!slice.lane?.pending) continue;
      const selection = this.laneSelection(task.id, thread, slice, slice.lane.step);
      if (!selection) {
        this.halt(
          task,
          `slice ${slice.id} has no ${slice.lane.step === 'resolve' ? 'orchestrator' : 'model'} to run on`,
          true,
          'failed',
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
    if (checking) return;
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
    const text = `Plan paused: ${plural(left, 'slice has', 'slices have')} not run. Run ${left === 1 ? 'it' : 'them'} from the plan card.`;
    this.host.line(task, text);
    this.ended(task, 'paused', text);
  }

  /** Open a slice's builder turn in its own scratch copy. */
  private startSlice(task: Task, thread: ChatThread, slice: Slice, effects: Effects): ChatThread {
    const plan = thread.plan as ChatPlanState;
    if (!slice.assignment) {
      this.put(task, thread, plan, { [slice.id]: { status: 'failed' } });
      this.halt(task, `slice ${slice.id} has no family to run on`, true, 'failed');
      return this.host.thread(task.id);
    }
    const lane: Lane = { step: 'build', pending: true, rounds: 0, fixes: 0, build: null };
    const saved = this.put(task, thread, plan, { [slice.id]: { status: 'running', lane } });
    // A Retry keeps the effort the person picked with the model.
    const key = `${task.id}:${slice.id}`;
    const chosen = this.retried.get(key);
    this.retried.delete(key);
    const selection =
      chosen && chosen.family === slice.assignment.family && chosen.model === slice.assignment.model
        ? chosen
        : this.selection(task.id, saved, slice.assignment);
    return this.openStep(task, saved, { ...slice, status: 'running', lane }, selection, effects);
  }

  /** Open the turn of a lane's pending step. */
  private openStep(
    task: Task,
    thread: ChatThread,
    slice: Slice,
    chosen: ChatModelSelection,
    effects: Effects,
  ): ChatThread {
    const lane = slice.lane as Lane;
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
    // Every step of a slice, the build, review, fix and resolve, passes the credit switch the
    // way a single turn does. It moves to the family a handoff would pick, or the plan pauses.
    let selection = chosen;
    if (this.host.creditsPaused?.(task.id, selection, role)) {
      const next = this.host.nextFamily?.(task.id, selection.family, role);
      if (!next || this.host.familyBusy(next.family)) {
        this.halt(task, `slice ${slice.id} needs credits that are off`);
        const text = `Plan paused: ${familyName[selection.family]} is out of included allowance and credit spending is off. Turn it on in Settings or run the slice from the plan card later.`;
        this.host.line(task, text);
        this.ended(task, 'paused', text);
        // The plan waits on an allowance the person has to free, so this pause posts the limit.
        this.host.notice('limit', task, text);
        return this.host.thread(task.id);
      }
      this.host.line(
        task,
        `Slice ${slice.id} continued on ${familyName[next.family]} from ${familyName[selection.family]}. Reason: usage limit reached.`,
      );
      selection = next;
    }
    const plan = thread.plan as ChatPlanState;
    const id = slice.id;
    const source = this.source(task.id, plan);
    const brief = source?.slices.find((value) => value.id === id);
    let text: string;
    if (lane.step === 'build') {
      if (!source || !brief || !slice.assignment) {
        this.put(task, thread, plan, { [id]: { status: 'failed', lane: undefined } });
        this.halt(task, `the orchestrator's reply for slice ${id} is gone`, true, 'failed');
        return this.host.thread(task.id);
      }
      // Local gets the compact brief, since its window has to hold the files as well.
      const report = !!this.host.reportThread?.(task.id);
      text =
        selection.family === 'local'
          ? localSliceBrief(source, brief, report)
          : sliceBrief(source, brief, slice.assignment.reason, report);
    } else if (lane.step === 'review') text = this.host.reviewBrief;
    else if (lane.step === 'fix') {
      // A fix the slice's gate sent works from the checks' output. One a review sent works from
      // the review.
      const checked = slice.turnId ? this.briefs.get(slice.turnId) : undefined;
      if (slice.turnId) this.briefs.delete(slice.turnId);
      const last = slice.turnId ? this.host.turn(slice.turnId) : undefined;
      text = checked ?? fixerBrief((last && this.host.reply(last)) ?? '');
    } else
      text = resolveBrief({
        slice,
        brief: brief?.brief ?? null,
        folder: laneFolder(this.host.scratchDirectory(task.id), id),
        conflicts: slice.conflicts ?? [],
      });
    const started = this.host.beginLane(
      task,
      thread,
      { text, role, selection, attachments: [], files: [], slice: id },
      effects,
      lane.step === 'build'
        ? `Slice ${id} started on ${familyName[selection.family]} (${selection.model}).`
        : undefined,
    );
    const after = this.host.thread(task.id);
    if (typeof started !== 'string') {
      const status = lane.step === 'resolve' ? 'blocked' : 'failed';
      this.put(task, after, plan, { [id]: { status, lane: undefined } });
      this.halt(
        task,
        `slice ${id} could not start.${started.next ? ` ${started.next}` : ''}`.replace(/\.$/, ''),
        true,
        'failed',
      );
      return this.host.thread(task.id);
    }
    const build = lane.step === 'build' ? started : lane.build;
    const saved = this.put(task, after, after.plan as ChatPlanState, {
      [id]: { turnId: started, lane: { ...lane, pending: false, build } },
    });
    this.observe(task, {
      kind: 'step-started',
      slice: id,
      step: lane.step,
      anchorTurnId: build ?? started,
      role: LANE_ROLE[lane.step],
      ...stepTurn(this.host.turn(started) ?? { id: started, selection }),
    });
    return saved;
  }

  /**
   * Replay a finished slice onto the thread copy. A conflict blocks it for the orchestrator, or,
   * while the plan stops, for the card to run again, and a blocked slice writes nothing until
   * its resolve turn ends done. `resolved` replays after that turn. `changed` says the thread copy
   * holds something new, which its checks then read.
   */
  private merge(
    task: Task,
    thread: ChatThread,
    slice: Slice,
    stopping = false,
    resolved = false,
  ): { thread: ChatThread; changed: boolean } {
    const plan = thread.plan as ChatPlanState;
    const lane = slice.lane as Lane;
    const id = slice.id;
    const root = this.host.projectPath(task);
    const folder = laneFolder(this.host.scratchDirectory(task.id), id);
    const anchor = lane.build ?? slice.turnId;
    // A merge runs no turn, so it opens and ends in this one call.
    const step = (outcome?: 'done' | 'failed') => {
      if (!anchor) return;
      const merged = { slice: id, step: 'merge', anchorTurnId: anchor, ...NO_TURN } as const;
      this.observe(
        task,
        outcome
          ? { kind: 'step-ended', ...merged, ...NO_RECORD, outcome }
          : { kind: 'step-started', ...merged },
      );
    };
    step();
    let replay: ReturnType<typeof replayLane>;
    try {
      if (!root || !thread.base) throw Error('The project is no longer registered.');
      replay = slice.readOnly
        ? { applied: [], conflicts: [], dropped: [], skipped: [] }
        : replayLane({
            root,
            base: thread.base,
            threadScratch: this.host.scratchDirectory(task.id),
            folder,
            resolved,
          });
    } catch (error) {
      const failed = this.put(task, thread, plan, { [id]: { status: 'failed', lane: undefined } });
      step('failed');
      const why = error instanceof Error ? ` ${error.message}` : '';
      if (stopping) return { thread: failed, changed: false };
      this.halt(task, `slice ${id} could not merge.${why}`.replace(/\.$/, ''), true, 'failed');
      return { thread: this.host.thread(task.id), changed: false };
    }
    const { applied, conflicts, dropped, skipped } = replay;
    if (!conflicts.length) {
      const saved = this.put(task, thread, plan, {
        [id]: { status: 'done', turnId: lane.build, lane: undefined, conflicts: undefined },
      });
      step('done');
      const named = (paths: readonly string[]) =>
        `${listedConflicts(paths).join(', ')}${paths.length > listedConflicts(paths).length ? ' and more' : ''}`;
      const left = [
        dropped.length
          ? ` Left out ${plural(dropped.length, 'path', 'paths')} the review chain changed outside the slice's own changes: ${named(dropped)}.`
          : '',
        skipped.length
          ? ` Left out ${plural(skipped.length, 'path', 'paths')} that lead out of the thread copy through a link: ${named(skipped)}.`
          : '',
      ].join('');
      this.host.line(
        task,
        slice.readOnly
          ? `Slice ${id} finished. No files changed.`
          : resolved
            ? `Slice ${id} finished: the orchestrator merged it in the thread copy.${left}`
            : `Slice ${id} finished: ${plural(applied.length, 'file', 'files')} merged.${left}`,
      );
      return { thread: saved, changed: applied.length > 0 || resolved };
    }
    const saved = this.put(task, thread, plan, {
      [id]: {
        status: 'blocked',
        conflicts: listedConflicts(conflicts),
        lane: stopping ? undefined : { ...lane, step: 'resolve', pending: true },
      },
    });
    // A conflict leaves the merge undone. The resolve step, when it runs, merges again.
    step('failed');
    const named = listedConflicts(conflicts).join(', ');
    const more = conflicts.length > listedConflicts(conflicts).length ? ' and more' : '';
    this.host.line(
      task,
      `Slice ${id} blocked: ${plural(conflicts.length, 'file conflicts', 'files conflict')} with the thread copy: ${named}${more}. ${stopping ? 'Run it again from the plan card.' : 'The orchestrator gets one turn to resolve it.'}`,
    );
    return { thread: saved, changed: false };
  }

  /**
   * Every slice is done and each merge passed the checks of the thread copy. The challenger argues
   * against the last slice that wrote. A plan whose slices only read closes without one.
   */
  private close(task: Task, thread: ChatThread, plan: ChatPlanState, effects: Effects) {
    if (this.host.reportThread?.(task.id)) return this.challengeReport(task, thread, plan, effects);
    const last = plan.slices.findLast((slice) => {
      const turn = slice.turnId ? this.host.turn(slice.turnId) : undefined;
      return turn && writesScratch(turn.role);
    })?.turnId;
    // Manual runs nothing after a builder turn, so the plan closes without a challenge.
    if (thread.flightMode === 'manual' || !last) return this.finish(task, thread, plan);
    // The chain moves the plan on from here. Marked once the transaction commits, so a rollback
    // leaves the plan free to move on. A crew with no challenger has finished the plan by then.
    effects.push(() => {
      if (this.host.thread(task.id).plan?.phase === 'running') this.closing.add(task.id);
    });
    this.host.crewStep(
      task,
      thread,
      { builderTurnId: last, step: 'challenge', reviewRounds: 0, fixes: 0, reason: null },
      effects,
    );
  }

  /**
   * A report run's slices are done. The challenger takes one read-only turn on every slice's
   * findings, the way the challenger of a change plan does after the last slice. Manual runs
   * nothing after a slice turn, and a report has nothing to show without the challenge.
   */
  private challengeReport(task: Task, thread: ChatThread, plan: ChatPlanState, effects: Effects) {
    if (thread.flightMode === 'manual')
      return this.halt(task, 'the thread is in manual mode', true);
    if (!thread.crew?.members.some((member) => member.role === 'challenger'))
      return this.halt(task, 'the crew has no challenger', true, 'failed');
    // The chain moves the plan on from here, as after a change plan's last slice.
    effects.push(() => {
      if (this.host.thread(task.id).plan?.phase === 'running') this.closing.add(task.id);
    });
    this.host.crewStep(
      task,
      thread,
      {
        builderTurnId: plan.orchestratorTurnId,
        step: 'challenge',
        reviewRounds: 0,
        fixes: 0,
        reason: null,
      },
      effects,
      reportChallengeBrief(this.sliceReplies(plan)),
    );
  }

  /** The orchestrator takes one read-only turn and writes the report from what the slices found. */
  private report(task: Task, thread: ChatThread, plan: ChatPlanState, effects: Effects) {
    const orchestrator = thread.crew?.members.find(
      (member) => member.role === 'orchestrator',
    )?.selection;
    if (!orchestrator) return this.halt(task, 'the crew has no orchestrator', true, 'failed');
    const challenge = this.host
      .turns(task.id)
      .findLast((turn) => turn.role === 'challenger' && turn.state === 'done');
    const started = this.host.begin(
      task,
      thread,
      {
        text: reportBrief(this.sliceReplies(plan), (challenge && this.host.reply(challenge)) ?? ''),
        role: 'orchestrator',
        selection: orchestrator,
        attachments: [],
        files: [],
      },
      effects,
      true,
    );
    const turn = started.outcome === 'applied' ? this.host.turns(task.id).at(-1) : undefined;
    // No turn answers the message, so nothing after this reads as the report turn.
    if (turn?.role !== 'orchestrator')
      return this.halt(task, 'the report could not start', true, 'failed');
    const after = this.host.thread(task.id);
    const opened = { ...(after.plan as ChatPlanState), report: { messageId: turn.userMessageId } };
    this.host.putThread(task, { ...after, plan: opened });
    this.reportStep(task, plan, turn);
  }

  private reportStep(task: Task, plan: ChatPlanState, turn: ChatTurn) {
    this.observe(task, {
      kind: 'step-started',
      slice: null,
      step: 'report',
      anchorTurnId: plan.orchestratorTurnId,
      role: 'orchestrator',
      ...stepTurn(turn),
    });
  }

  /** What each slice's turn answered, in plan order. */
  private sliceReplies(plan: ChatPlanState) {
    return plan.slices.map((slice) => {
      const turn = slice.turnId ? this.host.turn(slice.turnId) : undefined;
      return { id: slice.id, title: slice.title, findings: (turn && this.host.reply(turn)) ?? '' };
    });
  }

  /**
   * The report turn settled. A done turn ends the plan finished, with the count its last line
   * states. A limit a handoff moved to another provider leaves the plan waiting for that rerun,
   * which settles the same way. A turn that failed, hit a limit with nowhere to go or was stopped
   * ends the plan the way the same turn ends a change plan's challenge.
   */
  private reported(task: Task, thread: ChatThread, turn: ChatTurn) {
    const plan = thread.plan;
    if (plan?.phase !== 'running') return;
    if (turn.state === 'done') return this.reportDone(task, thread, plan, turn);
    if (thread.activeTurnId) return;
    const stopped = turn.state === 'stopped';
    const limited =
      turn.stopReason === 'limit' ||
      (turn.state === 'failed' && turn.failure?.kind === 'usage-limit');
    if (stopped && turn.stopCause !== 'client')
      return this.halt(task, 'you stopped the reply', true);
    this.halt(
      task,
      stopped
        ? 'the provider ended the turn'
        : limited
          ? (this.host.keptBack?.(turn.id)?.replace(/\.$/, '') ??
            `${familyName[turn.selection.family]} reached its usage limit`)
          : 'the report failed',
      true,
      limited && !stopped ? 'limit' : 'failed',
    );
  }

  /** The report is written. A copy that changed makes it no report. Otherwise the plan finishes. */
  private reportDone(task: Task, thread: ChatThread, plan: ChatPlanState, turn: ChatTurn) {
    this.closing.delete(task.id);
    const changed = this.copyChanged(task, thread);
    if (changed !== false) {
      const text = changed
        ? 'Report stopped: the run changed files, and a report only reads.'
        : "Report stopped: the run's copy could not be compared, and a report only reads.";
      this.host.putThread(task, { ...thread, plan: { ...plan, phase: 'stopped' } });
      this.host.line(task, text);
      this.ended(task, 'failed', text);
      return this.host.notice('failed', task, text);
    }
    const reply = this.host.reply(turn) ?? '';
    const count = reportCount(reply);
    this.host.putThread(task, { ...thread, plan: { ...plan, phase: 'finished' } });
    const text =
      count === null && statedCount(reply) === 0
        ? 'Report finished. Its count says no finding stands, and it lists findings.'
        : count === null
          ? 'Report finished. It did not state how many findings stand.'
          : count === 0
            ? 'Report finished: no finding stands.'
            : `Report finished: ${count} ${count === 1 ? 'finding stands' : 'findings stand'}.`;
    this.host.line(task, text);
    this.ended(task, 'finished', text, count);
    this.host.notice('finished', task, text);
  }

  /**
   * Whether the thread's copy differs from its base, or null when it cannot be compared, which a
   * report cannot pass, since the copy may hold a change. A thread that never made its copy
   * changed nothing.
   */
  private copyChanged(task: Task, thread: ChatThread): boolean | null {
    if (!thread.scratchReady) return false;
    const root = this.host.projectPath(task);
    if (!root || !thread.base) return null;
    try {
      return listChanges(root, this.host.scratchDirectory(task.id), thread.base).files > 0;
    } catch {
      return null;
    }
  }

  /** Run one check event of a thread's plan once the ones before it have ended. */
  private queue(taskId: string, event: () => Promise<void>) {
    const tail: Promise<void> = (this.checking.get(taskId) ?? Promise.resolve())
      .then(event)
      // An event that throws leaves the card as it was, and the next one still runs.
      .catch(() => {})
      .then(() => {
        if (this.checking.get(taskId) === tail) this.checking.delete(taskId);
      });
    this.checking.set(taskId, tail);
  }

  /**
   * The gate after a slice's builder or fixer turn, in the slice's own copy. It waits behind the
   * plan's other checks and runs only while the slice still stands on that turn.
   */
  private gate(taskId: string, id: number, turnId: string, step: 'build' | 'fix') {
    const current = () => {
      const plan = this.host.thread(taskId).plan;
      const slice = plan?.phase === 'running' ? find(plan, id) : undefined;
      const lane = slice?.lane;
      return slice?.turnId === turnId && lane?.step === step && !lane.pending ? slice : undefined;
    };
    this.queue(taskId, async () => {
      if (!current()) return;
      const copy = laneCopy(laneFolder(this.host.scratchDirectory(taskId), id));
      const result = await this.host.runLaneChecks(taskId, id, copy).catch(() => null);
      this.work((effects) => {
        const task = this.host.task(taskId);
        const slice = current();
        if (task && slice) this.gateEnded(task, slice, step, result, effects);
      });
      this.host.wakeQueues();
    });
  }

  /**
   * A slice's gate ended. A failure goes to the slice's fixer while fixes remain, with the checks'
   * output as its message. A slice that still fails, or whose checks say nothing about its copy,
   * stops the plan before anything it left reaches the thread copy.
   */
  private gateEnded(
    task: Task,
    slice: Slice,
    step: 'build' | 'fix',
    result: PlanChecks | null,
    effects: Effects,
  ) {
    const thread = this.host.thread(task.id);
    const plan = thread.plan as ChatPlanState;
    const lane = slice.lane as Lane;
    const id = slice.id;
    const fail = (cause: string) => {
      // A stop from the person leaves the slice not run, as a stopped turn does.
      const status = result?.outcome === 'stopped' ? 'not-run' : 'failed';
      this.put(task, thread, plan, { [id]: { status, lane: undefined } });
      this.stopAt(task, `at slice ${id}`, cause, !byPerson(result, thread));
    };
    const outcome = standing(result, thread);
    if (lane.build)
      this.observe(task, {
        kind: 'gate',
        slice: id,
        anchorTurnId: lane.build,
        trigger: 'after-write',
        result: gateResult(outcome),
      });
    if (typeof outcome === 'string') return fail(outcome);
    const fixes = lane.fixes + (step === 'fix' ? 1 : 0);
    if (outcome.outcome === 'failed') {
      const failed = labels(outcome, 'failed');
      if (fixes >= MAX_FIXES)
        return fail(
          `${failed} still failed after ${plural(fixes, 'fix', 'fixes')}. Run slice ${id} again from the plan card`,
        );
      this.host.line(
        task,
        `Checks failed in slice ${id}: ${failed}. The fixer runs on their output.`,
      );
      if (slice.turnId) this.briefs.set(slice.turnId, outcome.brief ?? '');
      this.put(task, thread, plan, {
        [id]: { lane: { ...lane, step: 'fix', pending: true, fixes } },
      });
      return this.pump(task, effects);
    }
    if (outcome.outcome === 'denied')
      this.host.line(
        task,
        `The project checks did not run in slice ${id}. The commands were not allowed.`,
      );
    if (outcome.outcome === 'passed')
      this.host.line(task, `Checks passed in slice ${id}: ${labels(outcome, 'passed')}.`);
    const next: Partial<Lane> = chained(thread, slice) ? { step: 'review', pending: true } : merge;
    this.put(task, thread, plan, { [id]: { lane: { ...lane, ...next, fixes } } });
    this.pump(task, effects);
  }

  /**
   * The project checks on the thread copy after slice `id` merged into it, so a slice that passed
   * alone and breaks what merged before it is caught here. They wait behind the plan's other
   * checks. A plan that stopped in the step that merged, as when the next slice could not start,
   * runs none.
   */
  private combine(taskId: string, id: number) {
    if (this.host.thread(taskId).plan?.phase !== 'running') return;
    const mark = Symbol(String(id));
    this.combining.set(taskId, mark);
    const current = () =>
      this.combining.get(taskId) === mark && this.host.thread(taskId).plan?.phase === 'running';
    this.queue(taskId, async () => {
      const result = current()
        ? await this.host
            .runCombinedChecks(taskId, this.host.scratchDirectory(taskId), id)
            .catch(() => null)
        : null;
      if (!current()) return;
      this.combining.delete(taskId);
      this.work((effects) => {
        const task = this.host.task(taskId);
        if (task) this.combined(task, id, result, effects);
      });
      this.host.wakeQueues();
    });
  }

  /**
   * The checks after a merge ended. A failure leaves the slice failed, so Retry runs it again,
   * and stops the plan with the slice named. A pass lets the next slice merge.
   */
  private combined(task: Task, id: number, result: PlanChecks | null, effects: Effects) {
    const thread = this.host.thread(task.id);
    const where = `after slice ${id} merged`;
    // `failed` also covers a check whose process may still run.
    if (result?.outcome === 'failed')
      this.put(task, thread, thread.plan as ChatPlanState, { [id]: { status: 'failed' } });
    const outcome = standing(result, thread);
    const anchor = thread.plan && find(thread.plan, id)?.turnId;
    if (anchor)
      this.observe(task, {
        kind: 'gate',
        slice: id,
        anchorTurnId: anchor,
        trigger: 'combined',
        result: gateResult(outcome),
      });
    if (typeof outcome === 'string')
      return this.stopAt(task, where, outcome, !byPerson(result, thread));
    if (outcome.outcome === 'failed')
      return this.stopAt(
        task,
        where,
        `${labels(outcome, 'failed')} failed. Run slice ${id} again from the plan card`,
        true,
      );
    if (outcome.outcome === 'denied')
      this.host.line(
        task,
        `The project checks did not run after slice ${id} merged. The commands were not allowed.`,
      );
    if (outcome.outcome === 'passed')
      this.host.line(task, `Checks passed after slice ${id} merged: ${labels(outcome, 'passed')}.`);
    this.pump(task, effects);
  }

  /**
   * Stop the plan over its checks. The line says where, and each turn it stops gives the cause.
   * `failed` is false when the person stopped the checks.
   */
  private stopAt(task: Task, where: string, cause: string, failed: boolean) {
    const why = cause.replace(/\.$/, '');
    this.halt(task, why);
    const text = `Plan stopped ${where}: ${why}.`;
    this.host.line(task, text);
    this.ended(task, failed ? 'failed' : 'stopped', text);
    if (failed) this.host.notice('failed', task, text);
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
    const text = `Crew finished: ${plural(plan.slices.length, 'slice', 'slices')}, ${plural(reviews, 'review', 'reviews')}, ${plural(fixes, 'fix', 'fixes')}.`;
    this.host.line(task, text);
    this.ended(task, 'finished', text, firstReviews(after, this.host));
    this.host.notice('finished', task, text);
  }

  /** Tell the listener a fact this plan decided, stamped with its thread and the time. */
  private observe(task: Task, body: PlanEventBody) {
    this.host.observe?.({ ...body, taskId: task.id, at: this.host.now() });
  }

  private ended(task: Task, outcome: PlanEnding, line: string, findings: number | null = null) {
    this.observe(task, { kind: 'plan-ended', outcome, line, findings });
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

  /**
   * The crew member's effort on a crew model, the builder's first, otherwise the model's own
   * default, as on a slice the handoff rule moved out of the crew.
   */
  private selection(
    taskId: string,
    thread: ChatThread,
    assignment: NonNullable<Slice['assignment']>,
  ): ChatModelSelection {
    const own = ['builder', 'fixer']
      .map((role) => thread.crew?.members.find((member) => member.role === role)?.selection)
      .find((value) => value?.family === assignment.family && value.model === assignment.model);
    if (own) return own;
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

/** The crew role whose model runs each lane step. The resolve turn runs on the orchestrator's. */
const LANE_ROLE = {
  build: 'builder',
  review: 'reviewer',
  fix: 'fixer',
  resolve: 'orchestrator',
  merge: null,
} as const;
const NO_TURN = { turnId: null, role: null, family: null, model: null, effort: null } as const;
const NO_RECORD = {
  rulesDigest: null,
  designVersionHash: null,
  durationMs: null,
  findings: null,
} as const;

/** A report's lines that are not empty, trimmed. */
const reportLines = (reply: string) =>
  reply
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/**
 * The count a report's last line that is not empty states: `Findings: n`, with n from 0 to 9999,
 * a period after it allowed and matching bold marks allowed around it. Anything else states none.
 */
export function statedCount(reply: string): number | null {
  const last = reportLines(reply).at(-1);
  const match =
    last === undefined ? null : /^(\*\*|__)?Findings: ([0-9]{1,4})(?:\.\1|\1\.?)$/.exec(last);
  return match ? Number(match[2]) : null;
}

/**
 * The count a report is stored with. A stated zero after lines that are findings contradicts the
 * report, and text a slice read could have steered it, so the count is unknown.
 */
export function reportCount(reply: string): number | null {
  const count = statedCount(reply);
  return count === 0 && reportLines(reply).slice(0, -1).some(isFinding) ? null : count;
}

/**
 * Whether a line is a finding the way slices write them: its first word, after a list marker, is
 * a file and line such as net.mjs:12 or src/totals.ts:4. A sentence that mentions a file and line
 * further on, a time of day and an address with a port are no findings.
 */
function isFinding(line: string): boolean {
  const word = (line.replace(/^(?:[-*+]|[0-9]+[.)])\s+/, '').split(/\s/)[0] ?? '')
    .replace(/^[`*_]+/, '')
    .replace(/[`*_,.;:)]+$/, '');
  return /^(?=[^:]*[A-Za-z])[\w./-]*[./][\w./-]*:[0-9]+(?::[0-9]+)?$/.test(word);
}

/** A gate's result as a plan reads it. Anything that is not a pass or a failure stands for none. */
const gateResult = (outcome: ChecksOutcome | string) =>
  typeof outcome === 'string' || (outcome.outcome !== 'passed' && outcome.outcome !== 'failed')
    ? 'unknown'
    : outcome.outcome;

/**
 * The findings each slice's first done review stated, summed over the slices. A review that
 * stated none counts nothing. Null when no review ran.
 */
function firstReviews(
  turns: readonly ChatTurn[],
  host: Pick<PlanHost, 'reply' | 'findings'>,
): number | null {
  const first = new Map<number, ChatTurn>();
  for (const turn of turns)
    if (turn.role === 'reviewer' && turn.slice !== undefined && !first.has(turn.slice))
      first.set(turn.slice, turn);
  if (!first.size) return null;
  let sum = 0;
  for (const turn of first.values()) sum += host.findings(host.reply(turn) ?? '') ?? 0;
  return sum;
}

/** A plan gates its slices' writing turns and checks each merge when checks are on, outside Manual. */
const checksOn = (thread: ChatThread) =>
  thread.flightMode !== 'manual' && enabledChecks(thread).length > 0;

/** A slice that writes runs a review chain in its lane when the crew has a reviewer. */
const chained = (thread: ChatThread, slice: Slice) =>
  !slice.readOnly &&
  thread.flightMode !== 'manual' &&
  !!thread.crew?.members.some((member) => member.role === 'reviewer');

/**
 * A plan's checks as the plan reads them: the outcome when it stands, or why nothing may go on. A
 * check whose process may still run never counts, and the thread already holds until a later
 * check finds the process gone.
 */
function standing(result: PlanChecks | null, thread: ChatThread): ChecksOutcome | string {
  if (!result) return 'the checks could not run';
  if (result.outcome === 'held') return result.cause;
  if (result.outcome === 'stopped') return 'you stopped the checks';
  if (result.runs.some((run) => run.status === 'unknown'))
    return 'a check process may still be running';
  if (thread.flightMode === 'manual') return 'the thread is in manual mode';
  return result;
}

/**
 * The checks ended because of the person: they stopped them or their question, or switched the
 * thread to Manual while the checks or the question waited.
 */
const byPerson = (result: PlanChecks | null, thread: ChatThread) =>
  result?.outcome === 'stopped' || thread.flightMode === 'manual';

const labels = (outcome: ChecksOutcome, status: 'passed' | 'failed') =>
  outcome.runs
    .filter((run) => run.status === status)
    .map((run) => run.label)
    .join(', ');

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
