import {
  type PlanSchedule,
  type PlanScheduleNote,
  type PlanScheduleState,
  type PlanSchedulesRead,
  planScheduleLine,
} from '@crewkite/contracts';
import { runWords, scheduleWords, triggerWords, type When } from './model.ts';

// What the Schedules view shows for each schedule, worked out before anything is drawn. Every
// sentence about a pause, a stop or a skipped start comes from `planScheduleLine`, so the view says
// what the CLI and the webhook say.

export type ScheduleItem = PlanSchedulesRead['schedules'][number];
export type ScheduleChange = 'pause' | 'resume' | 'restart';
export type ScheduleAction = ScheduleChange | 'open-recipe' | 'open-last-run';
/** True when the app lists the thread, so opening it lands somewhere. */
export type HasThread = (taskId: string) => boolean;

// Notes about a start the schedule passed over. The others say why it paused or stopped, and the
// line under the row already reads them.
const SKIPS: ReadonlySet<PlanScheduleNote['code']> = new Set([
  'run-active',
  'allowance-unknown',
  'allowance-limit',
  'not-connected',
  'model-unknown',
  'terms-pending',
  'missed',
]);
// Pauses that resume lifts. A pause at the waiting limit lifts on its own when a run stops
// waiting, and one the recipe file caused lifts only on a save, so the controller refuses both.
const RESUMABLE: ReadonlySet<PlanScheduleNote['code']> = new Set([
  'by-person',
  'checklist-unreadable',
  'start-refused',
]);
/** Whether Resume is offered: the Schedules view and a recipe's own strip ask the same rule. */
export const resumable = (schedule: Pick<PlanSchedule, 'state' | 'note'>): boolean =>
  schedule.state === 'paused' && schedule.note !== null && RESUMABLE.has(schedule.note.code);

/** The local time of the next start. Empty while none is due or the schedule is not active. */
export function nextRunCell(schedule: PlanSchedule, when: When): string {
  return schedule.state === 'active' && schedule.nextAt ? when(schedule.nextAt) : '';
}

/**
 * The full line under a row: why a schedule paused or stopped, or why an active one has no next
 * start, such as a reset trigger whose reset time no reading reported yet. A paused schedule with
 * no note has no line; the controller always writes one.
 */
export function scheduleLine(schedule: PlanSchedule): string | null {
  if (!schedule.note) return null;
  if (schedule.state !== 'active' || schedule.nextAt === null)
    return planScheduleLine(schedule.note);
  return null;
}

/**
 * What the last start came to. While the schedule is active and has no line of its own, a skip
 * newer than the last run reads as its line. A run reads as its state word and the time it ended,
 * or started while it runs, and a schedule with neither has run nothing.
 */
export function lastResultCell(
  schedule: PlanSchedule,
  when: When,
): { text: string; time: string | null } {
  const run = schedule.lastRun;
  const note = schedule.note;
  // A paused or stopped row, and an active one with no next start, read the note under the row.
  if (
    note &&
    schedule.state === 'active' &&
    schedule.nextAt !== null &&
    SKIPS.has(note.code) &&
    (!run || Date.parse(note.at) > Date.parse(run.endedAt ?? run.startedAt))
  )
    return { text: planScheduleLine(note), time: null };
  if (!run) return { text: 'None yet', time: null };
  return { text: runWords[run.state], time: when(run.endedAt ?? run.startedAt) };
}

/**
 * The actions a row offers. Resume shows only for a pause the controller lifts on resume, so the
 * other paused rows offer the recipe, whose line says what to do. Open last run needs a thread
 * that still exists: the read says when it is gone, and the app knows the ones deleted since.
 */
export function scheduleActions(schedule: PlanSchedule, hasThread: HasThread): ScheduleAction[] {
  const actions: ScheduleAction[] = [];
  if (schedule.state === 'active') actions.push('pause');
  else if (resumable(schedule)) actions.push('resume');
  else if (schedule.state === 'stopped') actions.push('restart');
  actions.push('open-recipe');
  const last = schedule.lastRun;
  if (last && last.thread !== false && hasThread(last.taskId)) actions.push('open-last-run');
  return actions;
}

/** The line a row shows once its action went through and the schedules were read again. */
export function changedLine(action: ScheduleChange, nextAt: string | null, when: When): string {
  if (action === 'pause') return 'Paused.';
  const done = action === 'resume' ? 'Resumed.' : 'Restarted.';
  return nextAt ? `${done} Next run ${when(nextAt)}.` : done;
}

/** The line under the table when a read holds fewer schedules than there are. */
export const moreLine = (count: number) =>
  count === 1 ? '1 more loop is not shown.' : `${count} more loops are not shown.`;

export type ScheduleRow = {
  recipeId: string;
  projectId: string;
  name: string;
  project: string;
  starts: string;
  nextRun: string;
  lastResult: { text: string; time: string | null };
  runs: string;
  state: PlanScheduleState;
  /** The schedule's next start as the controller holds it, which a row's status line may name. */
  nextAt: string | null;
  stateWord: string;
  line: string | null;
  change: ScheduleChange | null;
  lastRunTask: string | null;
};

const GROUP: Record<PlanScheduleState, number> = { paused: 0, active: 1, stopped: 2 };

/**
 * Every row with its cells: paused first, then active by next run with those that have none
 * after, then stopped. Rows that tie keep the order of their names.
 */
export function scheduleRows(
  items: readonly ScheduleItem[],
  projects: readonly { id: string; name: string }[],
  when: When,
  hasThread: HasThread,
): ScheduleRow[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const next = (item: ScheduleItem) =>
    item.schedule.state === 'active' && item.schedule.nextAt
      ? Date.parse(item.schedule.nextAt)
      : Number.POSITIVE_INFINITY;
  const byNext = (a: ScheduleItem, b: ScheduleItem) =>
    next(a) === next(b) ? 0 : next(a) < next(b) ? -1 : 1;
  return [...items]
    .sort(
      (a, b) =>
        GROUP[a.schedule.state] - GROUP[b.schedule.state] ||
        byNext(a, b) ||
        a.name.localeCompare(b.name),
    )
    .map(({ schedule, name, trigger }) => {
      const actions = scheduleActions(schedule, hasThread);
      return {
        recipeId: schedule.recipeId,
        projectId: schedule.projectId,
        name,
        project: names.get(schedule.projectId) ?? 'Unknown',
        starts: triggerWords(trigger, when),
        nextRun: nextRunCell(schedule, when),
        lastResult: lastResultCell(schedule, when),
        runs: `${schedule.runsStarted} of ${schedule.maxRuns}`,
        state: schedule.state,
        nextAt: schedule.nextAt,
        stateWord: scheduleWords[schedule.state],
        line: scheduleLine(schedule),
        change:
          actions.find(
            (action): action is ScheduleChange =>
              action === 'pause' || action === 'resume' || action === 'restart',
          ) ?? null,
        lastRunTask: actions.includes('open-last-run') ? (schedule.lastRun?.taskId ?? null) : null,
      };
    });
}
