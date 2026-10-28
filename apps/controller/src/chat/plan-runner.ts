import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ChatCatalogRead,
  type ChatCrewChain,
  type ChatModelSelection,
  type ChatPlan,
  type ChatPlanState,
  type ChatQueuedMessage,
  type ChatThread,
  type ChatTurn,
  type Command,
  type CommandResult,
  planOrder,
  type Task,
} from '@crewkite/contracts';
import { detectType } from './files.ts';
import { assignPlan, type PlanFile, type PlanInputs, parsePlan } from './plan.ts';
import { familyName, PLAN_RETRY, planRetryText, sliceBrief } from './prompt.ts';

type Payload<C extends Command['command']> = Extract<Command, { command: C }>['payload'];
type Effects = (() => void)[];
type Message = Pick<ChatQueuedMessage, 'text' | 'role' | 'selection' | 'attachments' | 'files'>;
type Slice = ChatPlanState['slices'][number];

/** What the runner needs from the chat service. Every call runs inside the caller's transaction. */
/**
 * True when the person sent a message that waits in the thread. A queued Ask is a read-only side
 * question, so it leaves a crew chain or a plan running and starts once they end.
 */
export function sentMessage(thread: ChatThread): boolean {
  return thread.queued.some((message) => message.role !== 'ask');
}

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
  crewStep: (task: Task, thread: ChatThread, chain: ChatCrewChain, effects: Effects) => void;
  /** Ask the running turn to stop. Its settle finishes the rest. */
  stopActive: (taskId: string, effects: Effects) => void;
  /** Whether no process of an earlier turn may still write to the scratch copy. */
  free: (task: Task) => boolean;
  scratchDirectory: (taskId: string) => string;
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

/**
 * Runs an orchestrator plan through the ordinary crew chain (ADR 0045). The orchestrator turn
 * replaces the builder turn, the controller assigns each slice, and each slice runs as a builder
 * turn followed by the ADR 0038 review chain. One slice runs at a time.
 */
export class PlanRunner {
  private readonly host: PlanHost;

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

  /** After any turn settles and the crew chain has moved: read a plan, or move the plan on. */
  settled(turnId: string) {
    const effects: Effects = [];
    try {
      this.host.transaction(() => {
        const turn = this.host.turn(turnId);
        const task = turn && this.host.task(turn.taskId);
        if (!turn || !task) return;
        const thread = this.host.thread(task.id);
        if (turn.role === 'orchestrator') return this.propose(task, thread, turn, effects);
        const plan = thread.plan;
        const slice = plan?.phase === 'running' && plan.slices.find((s) => s.turnId === turn.id);
        if (!plan || !slice) return;
        const active = thread.activeTurnId ? this.host.turn(thread.activeTurnId) : undefined;
        if (turn.state === 'done') {
          const saved = this.put(task, thread, plan, { [slice.id]: { status: 'done' } });
          // A review chain started on this slice moves the plan on when it ends.
          if (!active) this.advance(task, saved, effects);
          return;
        }
        // A usage limit moved the slice to another family. That turn now carries it.
        if (active && active.userMessageId === turn.userMessageId) {
          this.put(task, thread, plan, { [slice.id]: { turnId: active.id } });
          return;
        }
        const stopped = turn.state === 'stopped';
        this.put(task, thread, plan, { [slice.id]: { status: stopped ? 'not-run' : 'failed' } });
        this.halt(
          task,
          sentMessage(thread)
            ? 'you sent a new message'
            : stopped
              ? 'you stopped the reply'
              : `slice ${slice.id} failed. Run it again from the plan card`,
          true,
        );
      });
    } catch {
      // The card keeps its state, and each slice can still run from it.
      return;
    }
    for (const effect of effects) this.host.call(effect);
  }

  /**
   * The chain reached the challenge after a slice's reviews. With slices left, the next one starts
   * and the challenger waits for the end of the plan. True when the plan took the step.
   */
  beforeChallenge(task: Task, thread: ChatThread, chain: ChatCrewChain, effects: Effects): boolean {
    const plan = thread.plan;
    if (plan?.phase !== 'running' || ended(plan)) return false;
    const saved = this.host.putThread(task, {
      ...thread,
      crewChain: { ...chain, step: 'finished', reason: null },
    });
    this.advance(task, saved, effects);
    return true;
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
   * Stop the plan: every slice that has not finished shows not run. `line` writes the reason; a
   * stopped chain has already written its own.
   */
  halt(task: Task, cause: string, line = false) {
    const thread = this.host.thread(task.id);
    const plan = thread.plan;
    if (plan?.phase !== 'running') return;
    const slices = plan.slices.map((slice) => {
      if (slice.status === 'queued') return { ...slice, status: 'not-run' as const };
      if (slice.status !== 'running') return slice;
      const done = slice.turnId && this.host.turn(slice.turnId)?.state === 'done';
      return { ...slice, status: done ? ('done' as const) : ('not-run' as const) };
    });
    this.host.putThread(task, { ...thread, plan: { ...plan, phase: 'stopped', slices } });
    if (line) this.host.line(task, `Plan stopped: ${cause}.`);
  }

  /** Stop every running plan after a restart. Called with the IDs of threads whose plan runs. */
  recoverThreads(taskIds: readonly string[]) {
    for (const taskId of taskIds) {
      const task = this.host.task(taskId);
      if (task) this.halt(task, 'CrewKite restarted', true);
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
          (one.status === 'queued' && plan.phase === 'proposed'));
      if (!one || !ready)
        return blocked('slice-not-runnable', 'Only a slice that failed or has not run can run.');
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
    // One slice runs alone, so every other slice that is not done waits as not run.
    for (const slice of plan.slices)
      if (slice.status !== 'done')
        changes[slice.id] = {
          ...changes[slice.id],
          status: !one || slice.id === one.id ? 'queued' : 'not-run',
          ...(!one || slice.id === one.id ? { turnId: null } : {}),
        };
    const saved = this.put(task, thread, { ...plan, phase: 'running' }, changes);
    for (const reason of picked) this.host.line(task, reason);
    this.advance(task, saved, effects);
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
    const saved = this.host.putThread(task, { ...thread, plan: state });
    for (const slice of slices)
      this.host.line(
        task,
        slice.assignment?.reason ??
          `Slice ${slice.id} (${slice.difficulty}) has no family to run on: no connected family has allowance left.`,
      );
    if (state.phase === 'running') this.advance(task, saved, effects);
  }

  /** Start the next queued slice whose dependencies are done, or end the plan. */
  private advance(task: Task, thread: ChatThread, effects: Effects) {
    const plan = thread.plan;
    if (plan?.phase !== 'running' || thread.activeTurnId) return;
    if (sentMessage(thread)) return this.halt(task, 'you sent a new message', true);
    const done = new Set(plan.slices.filter((s) => s.status === 'done').map((s) => s.id));
    const order = planOrder(plan.slices) ?? plan.slices.map((slice) => slice.id);
    const next = order
      .map((id) => find(plan, id) as Slice)
      .find((slice) => slice.status === 'queued' && slice.depends.every((id) => done.has(id)));
    if (next) return this.start(task, thread, plan, next, effects);
    if (!ended(plan)) {
      const left = plan.slices.filter((slice) => slice.status !== 'done').length;
      this.halt(task, `${plural(left, 'slice has', 'slices have')} not run`);
      this.host.line(
        task,
        `Plan paused: ${plural(left, 'slice has', 'slices have')} not run. Run ${left === 1 ? 'it' : 'them'} from the plan card.`,
      );
      return;
    }
    const last = plan.slices.findLast((slice) => slice.turnId)?.turnId;
    // Manual runs nothing after a builder turn, so the plan closes without a challenge.
    if (thread.flightMode === 'manual' || !last) return this.finish(task, thread, plan);
    this.host.crewStep(
      task,
      thread,
      { builderTurnId: last, step: 'challenge', reviewRounds: 0, fixes: 0, reason: null },
      effects,
    );
  }

  private start(
    task: Task,
    thread: ChatThread,
    plan: ChatPlanState,
    slice: Slice,
    effects: Effects,
  ) {
    const source = this.source(task.id, plan);
    const brief = source?.slices.find((value) => value.id === slice.id);
    if (!slice.assignment || !brief || !source) {
      this.put(task, thread, plan, { [slice.id]: { status: 'failed' } });
      return this.halt(
        task,
        slice.assignment
          ? `the orchestrator's reply for slice ${slice.id} is gone`
          : `slice ${slice.id} has no family to run on`,
        true,
      );
    }
    const selection = this.selection(task.id, thread, slice.assignment);
    const text = sliceBrief(source, brief, slice.assignment.reason);
    const started = this.host.begin(
      task,
      thread,
      { text, role: 'assistant', selection, attachments: [], files: [] },
      effects,
    );
    const after = this.host.thread(task.id);
    if (started.outcome !== 'applied' || !after.activeTurnId) {
      this.put(task, after, plan, { [slice.id]: { status: 'failed' } });
      return this.halt(
        task,
        `slice ${slice.id} could not start.${started.next ? ` ${started.next}` : ''}`.replace(
          /\.$/,
          '',
        ),
        true,
      );
    }
    // The slice's family becomes the thread's pick, as a builder turn's does, so a usage limit
    // moves the slice through the thread's own handoff.
    this.put(task, after, plan, {
      [slice.id]: { status: 'running', turnId: after.activeTurnId },
    });
  }

  private finish(task: Task, thread: ChatThread, plan: ChatPlanState) {
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
    const slices = plan.slices.map((slice) => ({ ...slice, ...changes[slice.id] }));
    return this.host.putThread(task, { ...thread, plan: { ...plan, slices } });
  }
}

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
