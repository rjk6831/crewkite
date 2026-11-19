import {
  type AcceptanceAttempt,
  type ChatCheckRun,
  type ChatPlanLaneStep,
  type ChatPlanSliceStatus,
  type ChatPlanState,
  type ChatThread,
  type ChatTurn,
  type CommandResult,
  DEPENDENCIES_NEED_PREPARATION,
  type DependencyPreparation,
  planOrder,
  preparationLine,
  type RemoteEffect,
  type RemoteEffectKind,
} from '@crewkite/contracts';
import { formatSize } from '../format-size.ts';
import { sliceStatusLabel } from './plan-card.ts';

// What the Work tab shows: each plan slice with its owner, where it stands, the slices it runs
// after and what its checks found, and each thing that holds the thread with the next step. Every
// value comes from a record the controller wrote, so a window opened later shows the same.

type Slice = ChatPlanState['slices'][number];

/** The newest run of each check in one group of runs, taken together. */
export type CheckEvidence = {
  result: 'running' | 'passed' | 'failed' | 'unknown';
  /** When the newest run ended, or when it started while one still runs. */
  at: string;
  /** The checks that did not pass. */
  failed: string[];
};

export type WorkTone = 'queued' | 'running' | 'waiting' | 'blocked' | 'done' | 'failed';

export type WorkRow = {
  id: number;
  title: string;
  owner: Slice['assignment'];
  status: string;
  tone: WorkTone;
  /** The slices it runs after, in words. Null when it depends on none. */
  after: string | null;
  depends: readonly number[];
  /** The slice's builder turn, or its lane's newest turn while it runs. Null until it starts. */
  turnId: string | null;
  /** The checks in the slice's own copy after its writing turn. */
  checks: CheckEvidence | null;
  /** The checks on the thread's copy right after the slice merged into it. */
  merged: CheckEvidence | null;
  /** The longest chain of slices it runs after. The diagram puts it in that column. */
  depth: number;
};

const stepWords: Record<ChatPlanLaneStep, string> = {
  build: 'Building',
  review: 'Reviewing',
  fix: 'Fixing',
  merge: 'Merging',
  resolve: 'Resolving',
};
const tones: Record<ChatPlanSliceStatus, WorkTone> = {
  queued: 'queued',
  'not-run': 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  blocked: 'blocked',
};
// A slice after one of these cannot start until that one runs again.
const stuck: ReadonlySet<ChatPlanSliceStatus | undefined> = new Set([
  'failed',
  'blocked',
  'not-run',
]);

const slicesNamed = (ids: readonly number[]) =>
  ids.length === 1 ? `slice ${ids[0]}` : `slices ${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`;

const endOf = (run: ChatCheckRun) =>
  run.status === 'running' || run.durationMs === null
    ? Date.parse(run.startedAt)
    : Date.parse(run.startedAt) + run.durationMs;

function evidence(runs: readonly ChatCheckRun[]): CheckEvidence | null {
  // Runs come oldest first, so the last one of each check is its newest.
  const newest = [...new Map(runs.map((run) => [run.checkId, run])).values()];
  if (newest.length === 0) return null;
  const has = (status: ChatCheckRun['status']) => newest.some((run) => run.status === status);
  return {
    result: has('running')
      ? 'running'
      : has('unknown')
        ? 'unknown'
        : newest.every((run) => run.status === 'passed')
          ? 'passed'
          : 'failed',
    at: new Date(Math.max(...newest.map(endOf))).toISOString(),
    failed: newest
      .filter((run) => run.status !== 'passed' && run.status !== 'running')
      .map((run) => run.label),
  };
}

function standing(
  slice: Slice,
  plan: ChatPlanState,
  status: ReadonlyMap<number, ChatPlanSliceStatus>,
): Pick<WorkRow, 'status' | 'tone'> {
  if (slice.status === 'running')
    return { status: slice.lane ? stepWords[slice.lane.step] : 'Running', tone: 'running' };
  const unmet = slice.depends.filter((id) => status.get(id) !== 'done');
  const waiting = slice.status === 'queued' || slice.status === 'not-run';
  // A proposed plan has run nothing yet, so every slice waits for Run plan.
  if (waiting && unmet.length > 0 && plan.phase !== 'proposed') {
    const held = unmet.filter((id) => stuck.has(status.get(id)));
    if (held.length > 0) return { status: `Blocked by ${slicesNamed(held)}`, tone: 'blocked' };
    if (plan.phase === 'running')
      return { status: `Waiting on ${slicesNamed(unmet)}`, tone: 'waiting' };
  }
  return { status: sliceStatusLabel[slice.status], tone: tones[slice.status] };
}

/**
 * One row per slice, in plan order. A running slice reads as its lane's step. A slice that waits
 * on others names them: Waiting while they run, Blocked by the ones that failed, were blocked or
 * did not run. A check run counts for a slice only when the controller recorded that slice on it.
 */
export function workRows(plan: ChatPlanState, runs: readonly ChatCheckRun[]): WorkRow[] {
  const status = new Map(plan.slices.map((slice) => [slice.id, slice.status]));
  const depth = new Map<number, number>();
  const byId = new Map(plan.slices.map((slice) => [slice.id, slice]));
  for (const id of planOrder(plan.slices) ?? []) {
    const before = byId.get(id)?.depends ?? [];
    depth.set(id, before.length ? 1 + Math.max(...before.map((dep) => depth.get(dep) ?? 0)) : 0);
  }
  return plan.slices.map((slice) => ({
    id: slice.id,
    title: slice.title,
    owner: slice.assignment,
    ...standing(slice, plan, status),
    after: slice.depends.length ? `After ${slicesNamed(slice.depends)}` : null,
    depends: slice.depends,
    turnId: slice.turnId,
    checks: evidence(runs.filter((run) => run.slice === slice.id && run.trigger === 'after-write')),
    merged: evidence(runs.filter((run) => run.slice === slice.id && run.trigger === 'combined')),
    depth: depth.get(slice.id) ?? 0,
  }));
}

/**
 * One thing that holds the thread. `prepare` offers Prepare dependencies beside it, and `release`
 * offers the release of a held thread.
 */
export type Hold = { reason: string; action: string; prepare?: true; release?: true };

/**
 * The line for a held thread, as two sentences. The desktop cannot tell which process holds it, so
 * it names none. The release answers with what it found.
 */
export const HELD = [
  'CrewKite cannot confirm that a process this thread started has ended, so the thread is held.',
  'It checks again with each message.',
] as const;

/** What the thread's own dependency copy needs: the controller's line, and whether preparing helps. */
export type CopyNeed = { line: string; preparable: boolean; preparing: boolean };

/**
 * Whether the thread's own dependency copy needs the person, in the controller's words. The newest
 * record decides when it is not prepared: a stale copy or a failed one can be prepared again, an
 * unsupported layout or a tree over the size limit cannot. A copy that was never prepared has no
 * record. Then the thread line the checks wrote when they could not run says so, unless a
 * preparation finished after it.
 */
export function copyNeed(
  preparations: readonly DependencyPreparation[],
  lines: readonly { text: string; at: string }[] = [],
): CopyNeed | null {
  const copy = preparations.at(-1);
  if (copy?.state === 'preparing')
    return {
      line: 'Dependencies are being prepared for this copy.',
      preparable: false,
      preparing: true,
    };
  if (copy && copy.state !== 'prepared')
    return {
      line: preparationLine(copy),
      preparable:
        copy.state === 'stale' || (copy.state === 'failed' && copy.reason !== 'size-limit'),
      preparing: false,
    };
  const said = lines.findLast((line) => line.text.includes(DEPENDENCIES_NEED_PREPARATION));
  return said && said.at > (copy?.preparedAt ?? '')
    ? { line: DEPENDENCIES_NEED_PREPARATION, preparable: true, preparing: false }
    : null;
}

/** The line Prepare dependencies ends with, from the desktop or the CLI. */
export function preparationResultLine(result: CommandResult): { prepared: boolean; line: string } {
  const record = (result.data as { preparations?: DependencyPreparation[] } | undefined)
    ?.preparations?.[0];
  if (result.outcome !== 'applied' || !record)
    return { prepared: false, line: result.next ?? 'The dependencies were not prepared.' };
  if (record.state !== 'prepared') return { prepared: false, line: preparationLine(record) };
  return {
    prepared: true,
    line:
      record.layout === 'none'
        ? 'This project declares no dependencies. The checks can run.'
        : `Dependencies prepared. ${formatSize(record.bytes ?? 0)} copied into this thread's copy.`,
  };
}

const writeNames: Record<RemoteEffectKind, string> = {
  push: 'A push',
  'pr-open': 'A new pull request',
  'pr-update': 'A pull request edit',
  'pr-ready': 'A ready for review request',
  'pr-draft': 'A draft request',
  'review-reply': 'A review reply',
  rerun: 'A CI rerun',
  merge: 'A merge',
};

/**
 * What holds the thread now, one line each with the next step: a process nobody can confirm
 * ended, a question for the person, an Accept that holds the thread, a GitHub write still on its
 * way or with no known result, the thread's dependency copy when it is not current, a merge that
 * waits in the copy, and a paused queue. `accept` is the attempt that holds the thread, and
 * `preparations` the records of the thread's own copy, oldest first. Lines that say the same
 * thing show once.
 */
export function holds(input: {
  thread: ChatThread;
  turns: readonly Pick<ChatTurn, 'state'>[];
  accept: AcceptanceAttempt | null;
  effects: readonly RemoteEffect[];
  preparations: readonly DependencyPreparation[];
  /** The thread's own lines, which name a copy that was never prepared. */
  lines?: readonly { text: string; at: string }[];
}): Hold[] {
  const { thread, accept } = input;
  const lines: Hold[] = [];
  if (thread.ownershipUnknown) lines.push({ reason: HELD[0], action: HELD[1], release: true });
  if (input.turns.some((turn) => turn.state === 'waiting-permission'))
    lines.push({ reason: 'A turn waits for your permission.', action: 'Answer it in the thread.' });
  if (thread.checks?.ask)
    lines.push({
      reason: 'The checks wait for your answer.',
      action: 'Allow or deny them on the Checks card in the thread.',
    });
  // Glide starts a proposed plan on its own. Balanced waits for Run plan, and Manual also offers
  // Run on each slice.
  if (thread.plan?.phase === 'proposed' && thread.flightMode !== 'glide')
    lines.push({
      reason: 'The plan waits for you.',
      action:
        thread.flightMode === 'manual'
          ? 'Choose Run plan, or Run on one slice, on the plan card.'
          : 'Choose Run plan on the plan card.',
    });
  if (accept)
    lines.push(
      accept.state === 'publishing'
        ? { reason: `Accept is writing ${accept.branch}.`, action: 'Wait for it to finish.' }
        : {
            reason: `Accept is running the required checks for ${accept.branch}.`,
            action: 'Wait for them, or cancel the Accept in Changes.',
          },
    );
  for (const effect of input.effects) {
    if (effect.state === 'unknown')
      lines.push({
        reason: `${writeNames[effect.kind]} is unknown.`,
        action: 'Check it under GitHub in Changes.',
      });
    else if (effect.state === 'confirmed' || effect.state === 'sent')
      lines.push({
        reason: `${writeNames[effect.kind]} is on its way to GitHub.`,
        action: 'Wait for its result in Changes.',
      });
  }
  const copy = input.preparations.at(-1);
  const need = copyNeed(input.preparations, input.lines);
  if (need?.preparing)
    lines.push({ reason: need.line, action: 'Wait for it before the next check or Accept.' });
  else if (need)
    lines.push({
      reason: need.line,
      action:
        copy?.state === 'stale'
          ? 'Prepare them again before the next check or Accept.'
          : copy && copy.state !== 'prepared'
            ? 'Checks and Accept cannot run in this copy until that changes.'
            : 'Prepare them before the next check or Accept.',
      ...(need.preparable ? { prepare: true as const } : {}),
    });
  if (thread.pendingMerge)
    lines.push({
      reason: `A merge from ${thread.pendingMerge.remote}/${thread.pendingMerge.branch} waits in the copy.`,
      action: `Accept it to ${thread.pendingMerge.target} in Changes.`,
    });
  if (thread.queuePaused && thread.queued.length > 0)
    lines.push({
      reason: 'The queue is paused.',
      action: 'Send now or remove each waiting message.',
    });
  // Two writes of one kind that are both unknown read as one line with one step.
  return lines.filter(
    (line, at) =>
      lines.findIndex((other) => other.reason === line.reason && other.action === line.action) ===
      at,
  );
}
