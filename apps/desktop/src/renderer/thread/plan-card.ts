import type {
  ChatFlightMode,
  ChatPlanAssignment,
  ChatPlanSliceStatus,
  ChatPlanState,
} from '@crewkite/contracts';

type Slice = ChatPlanState['slices'][number];

export const sliceStatusLabel: Record<ChatPlanSliceStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  'not-run': 'Not run',
  blocked: 'Blocked',
};

export type PlanSliceView = {
  slice: Slice;
  statusLabel: string;
  /** Per-slice Run is on. */
  canRun: boolean;
  /** The slices this one waits on, so each row shows its part of the dependency graph. */
  waitsOn: string | null;
  /** The paths a blocked slice conflicts on in the thread copy. */
  conflicts: string | null;
  /** Balanced lets the person pick among these before the plan runs. */
  picker: readonly ChatPlanAssignment[] | null;
};

export type PlanCardView = {
  summary: string;
  runPlan: boolean;
  cancel: boolean;
  stop: boolean;
  rows: PlanSliceView[];
};

const waiting = (slice: Slice) => slice.status === 'queued' || slice.status === 'not-run';
const runnable = (slice: Slice) =>
  waiting(slice) || slice.status === 'failed' || slice.status === 'blocked';

/**
 * What the plan card shows and offers, from the controller's plan state and the thread's flight
 * mode. The controller decides the plan and runs it; the card only asks.
 *
 * Manual runs nothing on its own: Run plan, and Run on each slice. Balanced waits for Run plan, with
 * a family picker per slice and Cancel. Glide starts at once and shows status with Stop. A plan that
 * stopped or finished lets a failed or unrun slice be run on its own in every mode, once the slices
 * it depends on are done.
 */
export function planCard(plan: ChatPlanState, flight: ChatFlightMode): PlanCardView {
  const done = plan.slices.filter((slice) => slice.status === 'done').length;
  const total = plan.slices.length;
  const running = plan.phase === 'running';
  const open = plan.phase === 'proposed';
  const settled = plan.phase === 'stopped' || plan.phase === 'finished';
  const status = new Map(plan.slices.map((slice) => [slice.id, slice.status]));
  const rows = plan.slices.map((slice): PlanSliceView => {
    const unmet = slice.depends.filter((id) => status.get(id) !== 'done');
    const offered = (flight === 'manual' && open) || settled;
    const canRun = offered && runnable(slice) && !running && unmet.length === 0;
    return {
      slice,
      statusLabel: sliceStatusLabel[slice.status],
      canRun,
      waitsOn: slice.depends.length
        ? `Runs after slice ${slice.depends.join(', ')}${unmet.length ? '' : ', done'}`
        : null,
      conflicts:
        slice.status === 'blocked' && slice.conflicts?.length
          ? `Conflicts in the thread copy: ${slice.conflicts.join(', ')}`
          : null,
      picker:
        flight === 'balanced' && open && waiting(slice) && slice.candidates.length > 1
          ? slice.candidates
          : null,
    };
  });
  const summary =
    plan.phase === 'proposed'
      ? flight === 'glide'
        ? 'Plan ready. It starts on its own.'
        : flight === 'balanced'
          ? 'Plan ready. Check where each slice goes, then run it.'
          : 'Plan ready. Nothing runs until you choose Run.'
      : plan.phase === 'running'
        ? `Running: ${done} of ${total} slices done.`
        : plan.phase === 'finished'
          ? `Plan finished: ${done} of ${total} slices done.`
          : `Plan stopped: ${done} of ${total} slices done.`;
  const unfinished = plan.slices.some((slice) => slice.status !== 'done');
  return {
    summary,
    runPlan:
      !running &&
      unfinished &&
      ((open && flight !== 'glide') || (settled && plan.slices.some(runnable))),
    cancel: open && flight === 'balanced',
    stop: running || plan.phase === 'running' || (open && flight === 'glide'),
    rows,
  };
}

/** The slices whose picked candidate is not the one the controller assigned. */
export function planOverrides(
  plan: ChatPlanState,
  picks: Readonly<Record<number, number>>,
): { sliceId: number; family: ChatPlanAssignment['family']; model: string }[] {
  return plan.slices.flatMap((slice) => {
    const pick = slice.candidates[picks[slice.id] ?? -1];
    const same =
      pick && slice.assignment?.family === pick.family && slice.assignment.model === pick.model;
    return pick && !same ? [{ sliceId: slice.id, family: pick.family, model: pick.model }] : [];
  });
}
