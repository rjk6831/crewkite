import {
  type ChatCatalogEntry,
  type CommandResult,
  canonicalJson,
  MAX_PLAN_SCHEDULES,
  type MeteredFamily,
  MeteredFamilySchema,
  PLAN_SCHEDULE_CATCH_UP,
  PLAN_SCHEDULE_DRY_RUNS,
  type PlanRecipe,
  type PlanRecipeRecord,
  type PlanRecipeRun,
  type PlanRecipeTrigger,
  type PlanSchedule,
  type PlanScheduleNote,
  type PlanScheduleRecord,
  type PlanSchedulesRead,
  planScheduleLine,
} from '@crewkite/contracts';
import { ZodError } from 'zod';
import { defaultSchedule, type Schedule } from '../host/worker.ts';
import type { WebhookNotice } from '../notices/webhook.ts';
import type { Store } from '../store/index.ts';
import { type ChecklistItem, checklistRequest, nextChecklistItem } from './checklist.ts';
import type { RecipeRuns } from './run.ts';
import { type RecipeApproval, RecipeRefused, type Recipes, recipeFileRefusal } from './service.ts';
import {
  allowanceOf,
  decideStart,
  memberReadings,
  type Precondition,
  type PreconditionInput,
  precondition,
  type StartAnswer,
  tightestWindow,
} from './start-rule.ts';

// A schedule starts recipe runs with nobody watching (ADR 0058), so every start goes through one
// path: a timer comes due, the scheduler reads what the start rule needs and decides, and the
// run starts in the same transaction that moves the schedule's next start. A timer that fires
// twice for one due time, or late, finds the next start moved and does nothing. A start comes
// only from a timer of an active schedule, while a client is attached. A schedule's next start
// is always a real start time. A reset trigger with no reset time known has none, and its only
// timer reads the usage again to look for one.

/** The wait start at reset uses before it tries a reading again. */
const RETRY_MS = 15 * 60_000;
/** The longest wait a timer takes. A later start wakes early and arms again. */
const MAX_WAIT = 2 ** 31 - 1;
/** Pauses the recipe file caused. Only a save lifts them. */
const FILE_PAUSES = new Set(['recipe-changed', 'recipe-missing', 'recipe-invalid']);

type LastRun = PlanSchedule['lastRun'];
type Tally = ReturnType<Store['recipeRunTally']>;
type Effects = (() => void)[];
/** A schedule's next start, with the note it keeps beside it. */
type Next = Pick<PlanScheduleRecord, 'nextAt' | 'note'>;

const lastRun = (run: PlanRecipeRun | undefined): LastRun =>
  run
    ? {
        id: run.id,
        taskId: run.taskId,
        state: run.state,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      }
    : null;
const later = (at: string, milliseconds: number) =>
  new Date(Date.parse(at) + milliseconds).toISOString();

/** The notes that say what a reset schedule waits for. A next start found makes them untrue. */
const WAITING_NOTES = new Set(['reset-unknown', 'allowance-unknown']);

/**
 * The earliest a reset trigger may start again: the retry interval after the schedule's last run
 * started, so a reading that reports the reset just used a moment late is no second start.
 */
const resetFloor = (schedule: Pick<PlanScheduleRecord, 'lastRun'>): string | null =>
  schedule.lastRun ? later(schedule.lastRun.startedAt, RETRY_MS) : null;

/**
 * The next start of a trigger after `after`, with `note` kept. An interval's grid starts at
 * `armedAt` and steps by its minutes, so a late timer never moves it, and its first start is one
 * step after arming. A once trigger keeps its time. A reset trigger starts only at a reset a
 * reading reported, after `after` and no sooner than the retry interval after `last`'s newest
 * run. Every caller hands over the schedule it works on, so none can leave that floor out. With
 * no such reset it has no next start, and the note says its provider has not reported when the
 * allowance resets. A reset found clears a note that said what the schedule waited for.
 */
export function nextStart(
  trigger: PlanRecipeTrigger,
  armedAt: string,
  after: string,
  reset: string | null,
  note: PlanScheduleNote | null,
  last: Pick<PlanScheduleRecord, 'lastRun'>,
): Next {
  const notBefore = resetFloor(last);
  switch (trigger.kind) {
    case 'manual':
      return { nextAt: null, note };
    case 'once':
      return { nextAt: trigger.at, note };
    case 'interval': {
      const step = trigger.everyMinutes * 60_000;
      const passed = Math.floor((Date.parse(after) - Date.parse(armedAt)) / step);
      return { nextAt: later(armedAt, Math.max(1, passed + 1) * step), note };
    }
    case 'reset':
      return reset !== null &&
        Date.parse(reset) > Date.parse(after) &&
        (notBefore === null || Date.parse(reset) >= Date.parse(notBefore))
        ? { nextAt: reset, note: note && WAITING_NOTES.has(note.code) ? null : note }
        : { nextAt: null, note: { code: 'reset-unknown', at: after, family: trigger.family } };
  }
}

/** How many starts came due from `nextAt` up to `now`. One for any due once or reset trigger. */
export function dueStarts(trigger: PlanRecipeTrigger, nextAt: string, now: string): number {
  const late = Date.parse(now) - Date.parse(nextAt);
  if (late < 0) return 0;
  return trigger.kind === 'interval' ? Math.floor(late / (trigger.everyMinutes * 60_000)) + 1 : 1;
}

/**
 * A run started. Its start counts at once, and the schedule keeps `note`, which is null unless the
 * start itself had something to say, such as the starts it made up for. A once schedule is then
 * done, and a schedule at its run limit stops while its last run keeps going. A reset trigger's
 * next start comes no sooner than the retry interval after this one.
 */
export function afterStart(
  schedule: PlanScheduleRecord,
  run: PlanRecipeRun,
  trigger: PlanRecipeTrigger,
  now: string,
  reset: string | null,
  note: PlanScheduleNote | null = null,
): PlanScheduleRecord {
  const next = {
    ...schedule,
    runsStarted: schedule.runsStarted + 1,
    lastRun: lastRun(run),
    note,
  };
  if (trigger.kind === 'once')
    return { ...next, state: 'stopped', note: { code: 'once-done', at: now }, nextAt: null };
  if (next.runsStarted >= next.maxRuns)
    return {
      ...next,
      state: 'stopped',
      note: { code: 'run-limit', at: now, runs: next.maxRuns },
      nextAt: null,
    };
  return { ...next, ...nextStart(trigger, schedule.armedAt, now, reset, note, next) };
}

/**
 * A start was passed over. `note` says why, or is null to keep the note the schedule holds. A
 * once schedule stops with that note as its reason. A reset start passed over for want of a
 * reading tries again 15 minutes later: only a start at a reported reset can be passed over.
 */
export function afterSkip(
  schedule: PlanScheduleRecord,
  note: PlanScheduleNote | null,
  trigger: PlanRecipeTrigger,
  now: string,
  reset: string | null,
): PlanScheduleRecord {
  const kept = note ?? schedule.note;
  if (trigger.kind === 'once') return { ...schedule, state: 'stopped', note: kept, nextAt: null };
  if (trigger.kind === 'reset' && note?.code === 'allowance-unknown')
    return { ...schedule, note: kept, nextAt: later(now, RETRY_MS) };
  return {
    ...schedule,
    ...nextStart(trigger, schedule.armedAt, now, reset, kept, schedule),
  };
}

/** A run that changed nothing and found nothing, or a report that kept no finding. */
const dry = (run: PlanRecipeRun) =>
  (run.state === 'no-change' && !run.findings) || (run.state === 'reported' && run.findings === 0);

/**
 * A run of the recipe moved. The waiting count and the last run follow the runs as they stand.
 * When a run the schedule started first ends, the dry count moves: a dry run adds one, a failed
 * or stopped run leaves it, and any other end sets it to zero. Two dry runs stop the schedule,
 * and that stop wins over any pause. Reaching the waiting limit pauses an active schedule, and a
 * schedule paused there runs again once the count drops under it, from the next start after now.
 */
export function settleRun(
  schedule: PlanScheduleRecord,
  next: PlanRecipeRun,
  before: PlanRecipeRun,
  tally: Pick<Tally, 'waiting' | 'newest'>,
  recipe: Pick<PlanRecipe, 'trigger'> & { budget: { maxWaiting: number } },
  now: string,
  reset: string | null,
): PlanScheduleRecord {
  let dryRuns = schedule.dryRuns;
  if (next.origin === 'schedule' && before.endedAt === null && next.endedAt !== null)
    if (next.state !== 'failed' && next.state !== 'stopped')
      dryRuns = dry(next) ? Math.min(dryRuns + 1, PLAN_SCHEDULE_DRY_RUNS) : 0;
  const settled = {
    ...schedule,
    waiting: tally.waiting,
    lastRun: lastRun(tally.newest),
    dryRuns,
  };
  if (settled.state !== 'stopped' && dryRuns >= PLAN_SCHEDULE_DRY_RUNS)
    return { ...settled, state: 'stopped', note: { code: 'dry-runs', at: now }, nextAt: null };
  return waitingPause(settled, recipe.trigger, recipe.budget.maxWaiting, now, reset);
}

/**
 * The waiting limit against the count as it stands. An active schedule at the limit pauses. One
 * paused there runs again once the count is under it, from the next start after now, and keeps
 * its pause with the count while it is not. A schedule paused for any other reason or stopped
 * stays as it is.
 */
export function waitingPause(
  schedule: PlanScheduleRecord,
  trigger: PlanRecipeTrigger,
  max: number,
  now: string,
  reset: string | null,
): PlanScheduleRecord {
  if (schedule.state === 'active' && schedule.waiting >= max)
    return {
      ...schedule,
      state: 'paused',
      note: { code: 'waiting-limit', at: now, waiting: schedule.waiting },
      nextAt: null,
    };
  if (schedule.state !== 'paused' || schedule.note?.code !== 'waiting-limit') return schedule;
  if (schedule.waiting < max)
    return {
      ...schedule,
      state: 'active',
      ...nextStart(trigger, schedule.armedAt, now, reset, null, schedule),
    };
  return { ...schedule, note: { ...schedule.note, waiting: schedule.waiting } };
}

export type SchedulerDeps = {
  store: Store;
  now: () => string;
  recipes: Recipes;
  runs: RecipeRuns;
  projectPath: (projectId: string) => string | undefined;
  /** The catalog as it stands, with no provider call. */
  families: () => ChatCatalogEntry[];
  /** One usage read of a family through the controller's own path, which limits how often. */
  refreshUsage: (family: MeteredFamily) => Promise<void>;
  /** True while at least one client, the desktop or a CLI session, is attached. */
  attached: () => boolean;
  schedule?: Schedule;
  /** Posts a schedule's pause or stop to the person's webhook. */
  notify: (notice: WebhookNotice) => void;
  /** A project's schedules changed, so clients read them again. */
  changed: (projectId: string, recipeId: string | null) => void;
  log?: (line: string) => void;
};

/** What a start reads before it decides, all from rows and files with no provider call. */
type Facts = {
  schedule: PlanScheduleRecord;
  record: PlanRecipeRecord;
  recipe: PlanRecipe & { budget: NonNullable<PlanRecipe['budget']> };
  root: string | undefined;
  now: string;
  tally: Tally;
  input: Omit<PreconditionInput, 'checklist'>;
};

/** The schedule a start or a move left behind, and the one it replaced. */
type Change = { before: PlanScheduleRecord; after: PlanScheduleRecord; name: string };

/** Owns every schedule's timer. Only `fire` starts a run, and only from a start time. */
export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly timers = new Map<string, () => void>();
  /** What was logged once, so a row that never reads does not fill the log. */
  private readonly logged = new Set<string>();
  private closed = false;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  /**
   * At startup, once recovery and the run tracker are done, and again when the first client
   * attaches after a time with none. A schedule whose start is still ahead gets its timer. One
   * whose start came due meanwhile makes one catch-up start now, while a client is attached,
   * through the same rule as any start, and the starts it missed past that one are logged as one
   * note. With no client attached it waits for the first one. A reset schedule with no reset time
   * known looks for one now. A row that does not read is logged once and left.
   */
  wake() {
    if (this.closed) return;
    const now = this.deps.now();
    const { schedules, unreadable } = this.deps.store.recipeSchedules();
    for (const recipeId of unreadable) this.logOnce(recipeId, 'the schedule row does not read');
    for (const schedule of schedules) {
      if (schedule.state !== 'active') continue;
      if (schedule.nextAt === null) {
        if (this.deps.attached()) void this.look(schedule.recipeId);
      } else if (Date.parse(schedule.nextAt) > Date.parse(now))
        this.arm(schedule.recipeId, schedule.nextAt);
      else if (this.deps.attached()) void this.fire(schedule.recipeId, schedule.nextAt);
    }
  }

  close() {
    this.closed = true;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  /**
   * Called inside a save's transaction. A version with a trigger creates the schedule or arms it
   * for the new version with the new approval, and keeps its state and counts. A pause the file
   * caused lifts, a pause at the waiting limit follows the saved limit, and a stopped schedule
   * stays stopped. The grid moves only when the trigger changed. A manual version drops the
   * schedule. A row that does not read is replaced by a fresh schedule, since nothing could start
   * from it and the save is the person's way back. The timer follows once the save commits.
   */
  armed(
    record: PlanRecipeRecord,
    body: PlanRecipe,
    approved: RecipeApproval[],
  ): PlanSchedule | null {
    const { store } = this.deps;
    const before = this.readable(record.id);
    this.afterCommit(() => this.sync(record.id));
    if (body.trigger.kind === 'manual' || body.budget === null) {
      // Deleted whether or not it read, so no row that does not read outlives a manual version.
      store.deleteRecipeSchedule(record.id);
      return null;
    }
    const now = this.deps.now();
    const previous = before && store.recipeVersion(record.id, before.version)?.recipe.trigger;
    const same = !!previous && canonicalJson(previous) === canonicalJson(body.trigger);
    const armedAt = before && same ? before.armedAt : now;
    const lifted = before?.state === 'paused' && FILE_PAUSES.has(before.note?.code ?? '');
    const state = lifted || !before ? 'active' : before.state;
    const note = lifted ? null : (before?.note ?? null);
    const reset = this.resetAt(body);
    const tally = store.recipeRunTally(record.id);
    const next: Next =
      state !== 'active'
        ? { nextAt: null, note }
        : before?.state === 'active' && same && before.nextAt
          ? { nextAt: before.nextAt, note }
          : nextStart(body.trigger, armedAt, now, reset, note, { lastRun: lastRun(tally.newest) });
    const schedule = waitingPause(
      {
        recipeId: record.id,
        projectId: record.projectId,
        version: record.version,
        versionHash: record.versionHash,
        state,
        ...next,
        armedAt,
        runsStarted: before?.runsStarted ?? 0,
        maxRuns: body.budget.maxRuns,
        waiting: tally.waiting,
        dryRuns: before?.dryRuns ?? 0,
        lastRun: lastRun(tally.newest),
        approved,
      },
      body.trigger,
      body.budget.maxWaiting,
      now,
      reset,
    );
    store.putRecipeSchedule(schedule, now);
    return shown(schedule);
  }

  /** Called inside a forget's transaction, after the schedule's row is gone. */
  forgotten(recipeId: string) {
    this.afterCommit(() => this.sync(recipeId));
  }

  /**
   * The run tracker's hook, inside its transaction: a run of a recipe moved. It writes only the
   * schedule's row, and posts and arms once that commits. A failure here leaves the schedule as it
   * was, never undoes the run's move and never throws.
   */
  settled(next: PlanRecipeRun, before: PlanRecipeRun) {
    try {
      const { store } = this.deps;
      const schedule = store.recipeSchedule(next.recipeId);
      const recipe = schedule && store.recipeVersion(next.recipeId, schedule.version)?.recipe;
      if (!schedule || !recipe?.budget) return;
      const now = this.deps.now();
      const after = settleRun(
        schedule,
        next,
        before,
        store.recipeRunTally(next.recipeId),
        { trigger: recipe.trigger, budget: recipe.budget },
        now,
        this.resetAt(recipe),
      );
      if (canonicalJson(after) === canonicalJson(schedule)) return;
      store.putRecipeSchedule(after, now);
      this.deps.changed(after.projectId, after.recipeId);
      const change = { before: schedule, after, name: recipe.name };
      this.afterCommit(() => this.committed(change));
    } catch (error) {
      this.logOnce(next.recipeId, String(error));
    }
  }

  /**
   * SetRecipeSchedule, inside the command's transaction. pause holds any schedule that is not
   * stopped as a pause by the person, whatever paused it before, and only resume lifts that.
   * resume lifts a pause the person, an unreadable checklist or a refused start set. restart arms
   * a stopped schedule with its counts at zero. Both refuse while the recipe file is not the armed
   * version.
   */
  set(payload: { recipeId: string; action: 'pause' | 'resume' | 'restart' }, effects: Effects) {
    const { store } = this.deps;
    const record = store.recipe(payload.recipeId);
    if (!record) throw new RecipeRefused('recipe-not-found', 'That recipe is not saved here.');
    const schedule = this.readable(record.id, true);
    const recipe = schedule && store.recipeVersion(record.id, schedule.version)?.recipe;
    if (!schedule || !recipe) throw new RecipeRefused('schedule-none', 'This recipe has no loop.');
    const now = this.deps.now();
    let after: PlanScheduleRecord;
    if (payload.action === 'pause') {
      if (
        schedule.state === 'stopped' ||
        (schedule.state === 'paused' && schedule.note?.code === 'by-person')
      )
        return;
      after = { ...schedule, state: 'paused', note: { code: 'by-person', at: now }, nextAt: null };
    } else {
      if (payload.action === 'resume' && schedule.state !== 'paused')
        throw new RecipeRefused('schedule-not-paused', 'This loop is not paused.');
      if (payload.action === 'restart' && schedule.state !== 'stopped')
        throw new RecipeRefused('schedule-not-stopped', 'This loop is not stopped.');
      const note = schedule.note;
      if (payload.action === 'resume' && note?.code === 'waiting-limit')
        throw new RecipeRefused(
          'schedule-waiting',
          `${note.waiting === 1 ? '1 run is' : `${note.waiting} runs are`} waiting for you. Accept or discard one, and the loop resumes on its own.`,
        );
      // A pause the file caused lifts only on a save, so resume refuses it whatever the file
      // reads now.
      const file =
        payload.action === 'resume' && note && FILE_PAUSES.has(note.code)
          ? note.code.replace('recipe-', '')
          : this.file(record, schedule);
      if (file !== 'current') throw recipeFileRefusal(file);
      // A once schedule past its time would start at once or show a next run in the past.
      if (recipe.trigger.kind === 'once' && Date.parse(recipe.trigger.at) <= Date.parse(now))
        throw new RecipeRefused(
          'schedule-time-passed',
          "This loop's time has passed. Save the recipe with a new time, then restart it.",
        );
      after = {
        ...schedule,
        state: 'active',
        ...nextStart(recipe.trigger, schedule.armedAt, now, this.resetAt(recipe), null, schedule),
        ...(payload.action === 'restart' ? { runsStarted: 0, dryRuns: 0 } : {}),
      };
    }
    store.putRecipeSchedule(after, now);
    this.deps.changed(after.projectId, after.recipeId);
    effects.push(() => this.sync(after.recipeId));
  }

  /** Every schedule, or one project's, by project and path, up to the read's bound. */
  read(payload: { projectId?: string }): PlanSchedulesRead {
    const { store } = this.deps;
    const { schedules, more, unreadable } = store.recipeSchedules(
      payload.projectId,
      MAX_PLAN_SCHEDULES,
    );
    for (const recipeId of unreadable) this.logOnce(recipeId, 'the schedule row does not read');
    return {
      schedules: schedules.flatMap((schedule) => {
        const record = store.recipe(schedule.recipeId);
        const recipe = store.recipeVersion(schedule.recipeId, schedule.version)?.recipe;
        return record && recipe
          ? [
              {
                schedule: {
                  ...shown(schedule),
                  // A run outlives its thread. The list says whether the thread is still there.
                  lastRun: schedule.lastRun && {
                    ...schedule.lastRun,
                    // The task's row is enough. Parsing the whole thread here would let one
                    // unreadable thread fail every project's list.
                    thread: store.get('task', schedule.lastRun.taskId) !== undefined,
                  },
                },
                name: recipe.name,
                path: record.path,
                trigger: recipe.trigger,
              },
            ]
          : [];
      }),
      more,
    };
  }

  /**
   * A timer came due. Nothing happens unless the schedule is still active with this exact next
   * start and a client is attached. A timer that woke early arms again before anything else is
   * read. The checklist and one fresh usage read per metered family are read outside any
   * transaction, and only when the checks before them let the start go on. The decision and the
   * start, or the move of the next start, then commit together on the rows as they stand, for the
   * version those reads were for.
   */
  private async fire(recipeId: string, due: string) {
    if (this.closed) return;
    try {
      const row = this.deps.store.recipeSchedule(recipeId);
      if (row?.state !== 'active' || row.nextAt !== due) return;
      if (Date.parse(due) > Date.parse(this.deps.now())) return this.arm(recipeId, due);
    } catch (error) {
      this.logOnce(recipeId, String(error));
      if (Date.parse(due) > Date.parse(this.deps.now())) this.arm(recipeId, due);
      return;
    }
    try {
      const facts = this.facts(recipeId, due);
      if (!facts || !this.deps.attached()) return;
      const work = facts.recipe.work;
      const item =
        work?.kind === 'checklist' && facts.root
          ? nextChecklistItem(facts.root, work.path, new Set(facts.tally.items))
          : work?.kind === 'checklist'
            ? ({ kind: 'unreadable' } as const)
            : null;
      if (!this.checks(facts, item))
        await Promise.all(
          metered(facts.recipe).map((family) => this.deps.refreshUsage(family).catch(() => {})),
        );
      if (this.closed) return;
      const read = { versionHash: facts.schedule.versionHash, item };
      const effects: Effects = [];
      const change = this.deps.store.transaction(() => this.decide(recipeId, due, read, effects));
      for (const effect of effects) effect();
      if (change) this.committed(change);
    } catch (error) {
      this.logOnce(recipeId, String(error));
      this.moveOn(recipeId, due);
    }
  }

  /** The checks before the usage reads, or null when the start goes on to them. */
  private checks(facts: Facts, item: ChecklistItem | null): Precondition | null {
    const work = facts.recipe.work;
    return precondition({
      ...facts.input,
      checklist: work?.kind === 'checklist' && item ? { path: work.path, next: item.kind } : null,
    });
  }

  /**
   * Inside the transaction: decide on the rows as they stand now, and act. A schedule armed for
   * another version since the fire read its work and its usage passes this start over, since
   * what was read belongs to a version that no longer runs.
   */
  private decide(
    recipeId: string,
    due: string,
    read: { versionHash: string; item: ChecklistItem | null },
    effects: Effects,
  ): Change | null {
    const facts = this.facts(recipeId, due);
    if (!facts || Date.parse(due) > Date.parse(facts.now) || !this.deps.attached()) return null;
    const { schedule, recipe, now, tally } = facts;
    const missed = dueStarts(recipe.trigger, due, now) - PLAN_SCHEDULE_CATCH_UP;
    const missedNote: PlanScheduleNote | null =
      missed > 0 ? { code: 'missed', at: now, runs: missed } : null;
    const counted: PlanScheduleRecord = {
      ...schedule,
      waiting: tally.waiting,
      lastRun: lastRun(tally.newest),
      ...(missedNote ? { note: missedNote } : {}),
    };
    const reset = this.resetAt(recipe);
    const skip = (note: PlanScheduleNote | null) =>
      afterSkip(counted, note, recipe.trigger, now, reset);
    const hold = (state: 'paused' | 'stopped', note: PlanScheduleNote | null) => ({
      ...counted,
      state,
      note,
      nextAt: null,
    });
    let after: PlanScheduleRecord;
    if (schedule.versionHash !== read.versionHash) after = skip(null);
    else {
      // An item a run took while the usage was read is held now.
      const item: ChecklistItem | null =
        read.item?.kind === 'item' && tally.items.includes(read.item.text)
          ? { kind: 'held' }
          : read.item;
      const answer: Precondition | StartAnswer =
        this.checks(facts, item) ??
        decideStart({
          ...facts.input.table,
          at: now,
          allowance: allowanceOf(
            memberReadings(recipe.crew, this.deps.families()),
            recipe.budget.maxUsedPercent,
            now,
          ),
        });
      if (answer.action === 'none') return null;
      const work = recipe.work;
      const text = item?.kind === 'item' ? item.text : null;
      const request =
        work?.kind === 'request'
          ? work.text
          : work?.kind === 'checklist' && text
            ? checklistRequest(work.path, text)
            : null;
      if (answer.action === 'start' && request !== null)
        try {
          const run = this.deps.runs.startRun(
            {
              record: facts.record,
              request,
              origin: 'schedule',
              item: text,
              approved: schedule.approved,
            },
            effects,
          );
          after = afterStart(counted, run, recipe.trigger, now, reset, missedNote);
        } catch (failure) {
          if (!(failure instanceof RecipeRefused)) throw failure;
          // The run wrote nothing. Its refusal says why, in a note of its own when no other
          // note names that reason.
          const refused = this.refused(failure, recipe, now);
          after = refused.action === 'skip' ? skip(refused.note) : hold('paused', refused.note);
        }
      else if (answer.action === 'start') after = skip(null);
      else if (answer.action === 'skip') after = skip(answer.note);
      else after = hold(answer.action === 'pause' ? 'paused' : 'stopped', answer.note);
    }
    this.deps.store.putRecipeSchedule(after, now);
    this.deps.changed(after.projectId, after.recipeId);
    return { before: schedule, after, name: recipe.name };
  }

  /**
   * The note a refused start leaves. A file that is not the armed version pauses as the start
   * rule pauses for it, and a crew member who is not ready passes the start over. Any other
   * refusal pauses the schedule with its own sentence, a once schedule too, so the person sees
   * why and resumes it.
   */
  private refused(
    failure: RecipeRefused,
    recipe: PlanRecipe,
    now: string,
  ): { action: 'pause' | 'skip'; note: PlanScheduleNote } {
    const file = {
      'recipe-file-changed': 'recipe-changed',
      'recipe-file-missing': 'recipe-missing',
      'recipe-file-invalid': 'recipe-invalid',
    } as const;
    const code = file[failure.reason as keyof typeof file];
    if (code) return { action: 'pause', note: { code, at: now } };
    if (
      ['recipe-not-connected', 'recipe-model-unknown', 'recipe-terms-pending'].includes(
        failure.reason,
      )
    ) {
      const member = this.deps.recipes.readiness(recipe.crew).find((value) => value.reason);
      if (member?.reason)
        return { action: 'skip', note: { code: member.reason, at: now, family: member.family } };
    }
    const reason = failure.next
      .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
      .trim()
      .slice(0, 300)
      .toWellFormed()
      .trim();
    return {
      action: 'pause',
      note: { code: 'start-refused', at: now, reason: reason || 'That did not go through.' },
    };
  }

  /**
   * A recipe's schedule row, or undefined when it has none or the row does not read. A row that
   * does not read is logged. With `refuse`, it refuses with the generic line for a command that
   * did not go through, so a schedule action on it never throws.
   */
  private readable(recipeId: string, refuse = false): PlanScheduleRecord | undefined {
    try {
      return this.deps.store.recipeSchedule(recipeId);
    } catch (error) {
      if (!(error instanceof ZodError || error instanceof SyntaxError)) throw error;
      this.logOnce(recipeId, 'the schedule row does not read');
      if (refuse) throw new RecipeRefused('schedule-unreadable', 'That did not go through.');
      return undefined;
    }
  }

  /**
   * What a start reads from rows and files, or null when the schedule is not active with this
   * exact next start. The recipe file is only hashed and compared with the armed version.
   */
  private facts(recipeId: string, due: string): Facts | null {
    const { store } = this.deps;
    const schedule = store.recipeSchedule(recipeId);
    if (schedule?.state !== 'active' || schedule.nextAt !== due) return null;
    const record = store.recipe(recipeId);
    const recipe = store.recipeVersion(recipeId, schedule.version)?.recipe;
    if (!record || !recipe?.budget) return null;
    const budget = recipe.budget;
    const now = this.deps.now();
    const tally = store.recipeRunTally(recipeId);
    const newest = tally.newest?.state;
    const unready = this.deps.recipes
      .readiness(recipe.crew)
      .find((member) => member.reason !== null);
    return {
      schedule,
      record,
      recipe: { ...recipe, budget },
      root: this.deps.projectPath(record.projectId),
      now,
      tally,
      input: {
        at: now,
        state: schedule.state,
        file: this.file(record, schedule),
        table: {
          runs: { started: schedule.runsStarted, max: schedule.maxRuns },
          waiting: { count: tally.waiting, max: budget.maxWaiting },
          dryRuns: schedule.dryRuns,
          lastRun: tally.running
            ? 'running'
            : newest === 'asked' || newest === 'ready'
              ? 'waiting'
              : 'idle',
        },
        unready: unready?.reason ? { reason: unready.reason, family: unready.family } : null,
      },
    };
  }

  /** The recipe file against the armed version, as RunRecipe compares it. */
  private file(record: PlanRecipeRecord, schedule: PlanScheduleRecord): PreconditionInput['file'] {
    if (record.versionHash !== schedule.versionHash) return 'changed';
    try {
      const { entry } = this.deps.recipes.read({
        projectId: record.projectId,
        recipeId: record.id,
      });
      return entry.file === 'unrecorded' ? 'changed' : entry.file;
    } catch (failure) {
      // A project that is no longer registered has no file to read.
      if (failure instanceof RecipeRefused) return 'missing';
      throw failure;
    }
  }

  /**
   * The reset of a reset trigger's family, from the catalog as it stands: the reset of the
   * tightest window across the crew's models there, or across every window when the crew names
   * none. Null while no window with a value reports one.
   */
  private resetAt(recipe: Pick<PlanRecipe, 'trigger' | 'crew'>): string | null {
    const trigger = recipe.trigger;
    if (trigger.kind !== 'reset') return null;
    try {
      const entry = this.deps.families().find((value) => value.family === trigger.family);
      if (!entry) return null;
      const models = recipe.crew.members
        .filter((member) => member.selection.family === trigger.family)
        .map((member) => member.selection.model);
      let tightest: ChatCatalogEntry['remaining'][number] | null = null;
      for (const model of models.length ? models : [null]) {
        const window = tightestWindow(entry, model);
        if (window && (tightest === null || (window.percent ?? 100) < (tightest.percent ?? 100)))
          tightest = window;
      }
      return tightest?.resetsAt ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A reset schedule with no reset time known reads its provider's usage again and only looks
   * for one. It never starts a run. Once a reading reports a reset ahead, that is its next start.
   * It looks every 15 minutes while a client is attached.
   */
  private async look(recipeId: string) {
    if (this.closed || !this.deps.attached()) return;
    try {
      const first = this.looking(recipeId);
      if (!first) return;
      await this.deps.refreshUsage(first.trigger.family).catch(() => {});
      if (this.closed) return;
      this.deps.store.transaction(() => {
        const schedule = this.deps.store.recipeSchedule(recipeId);
        const recipe = this.looking(recipeId);
        if (!schedule || !recipe) return;
        const now = this.deps.now();
        // The same rule as every other next start: a reset ahead, no sooner than the retry
        // interval after the last run, and the waiting note gone once it no longer holds.
        const next = nextStart(
          recipe.trigger,
          schedule.armedAt,
          now,
          this.resetAt(recipe),
          schedule.note,
          schedule,
        );
        if (next.nextAt === null) return;
        this.deps.store.putRecipeSchedule({ ...schedule, ...next }, now);
        this.deps.changed(schedule.projectId, schedule.recipeId);
      });
    } catch (error) {
      this.logOnce(recipeId, String(error));
    }
    this.sync(recipeId);
  }

  /** The armed version of a reset schedule that is active with no next start, or null. */
  private looking(
    recipeId: string,
  ): (PlanRecipe & { trigger: Extract<PlanRecipeTrigger, { kind: 'reset' }> }) | null {
    const schedule = this.deps.store.recipeSchedule(recipeId);
    if (schedule?.state !== 'active' || schedule.nextAt !== null) return null;
    const recipe = this.deps.store.recipeVersion(recipeId, schedule.version)?.recipe;
    if (recipe?.trigger.kind !== 'reset') return null;
    return { ...recipe, trigger: recipe.trigger };
  }

  /**
   * After an error that rolled the decision back, the schedule moves to its next start with no
   * run, so it neither stalls nor tries again at once.
   */
  private moveOn(recipeId: string, due: string) {
    try {
      this.deps.store.transaction(() => {
        const schedule = this.deps.store.recipeSchedule(recipeId);
        const recipe =
          schedule && this.deps.store.recipeVersion(recipeId, schedule.version)?.recipe;
        if (!schedule || !recipe || schedule.state !== 'active' || schedule.nextAt !== due) return;
        const now = this.deps.now();
        const after = afterSkip(schedule, null, recipe.trigger, now, this.resetAt(recipe));
        this.deps.store.putRecipeSchedule(after, now);
        this.deps.changed(after.projectId, after.recipeId);
      });
      this.sync(recipeId);
    } catch (error) {
      this.logOnce(recipeId, String(error));
    }
  }

  /**
   * Once a change committed: a schedule that paused or stopped posts its line, and the timer
   * follows the row. Its own pause or stop is what must stand in the row, so a later change in
   * the same transaction that only moved a count still lets it post, and a change whose
   * transaction rolled back posts nothing.
   */
  private committed({ before, after, name }: Change) {
    let row: PlanScheduleRecord | undefined;
    try {
      row = this.deps.store.recipeSchedule(after.recipeId);
    } catch (error) {
      this.logOnce(after.recipeId, String(error));
    }
    const stands =
      row?.state === after.state &&
      row.note?.code === after.note?.code &&
      row.note?.at === after.note?.at;
    if (stands && after.state !== before.state && after.state !== 'active' && after.note)
      this.deps.notify({ kind: after.state, schedule: name, line: planScheduleLine(after.note) });
    this.sync(after.recipeId);
  }

  /**
   * The timer follows the row: a start timer for an active schedule with a next start, a timer
   * that looks for a reset for an active reset schedule with none while a client is attached,
   * and else none.
   */
  private sync(recipeId: string) {
    if (this.closed) return;
    let schedule: PlanScheduleRecord | undefined;
    let trigger: PlanRecipeTrigger | undefined;
    try {
      schedule = this.deps.store.recipeSchedule(recipeId);
      trigger =
        schedule && this.deps.store.recipeVersion(recipeId, schedule.version)?.recipe.trigger;
    } catch (error) {
      this.logOnce(recipeId, String(error));
    }
    if (schedule?.state === 'active' && schedule.nextAt) return this.arm(recipeId, schedule.nextAt);
    if (schedule?.state === 'active' && trigger?.kind === 'reset' && this.deps.attached())
      return this.timer(recipeId, RETRY_MS, () => void this.look(recipeId));
    this.timers.get(recipeId)?.();
    this.timers.delete(recipeId);
  }

  /** A start timer. Arming again cancels the one before. */
  private arm(recipeId: string, at: string) {
    const wait = Math.min(Math.max(Date.parse(at) - Date.parse(this.deps.now()), 0), MAX_WAIT);
    this.timer(recipeId, wait, () => void this.fire(recipeId, at));
  }

  /** One timer per schedule, whatever it waits for. Setting one cancels the one before. */
  private timer(recipeId: string, wait: number, work: () => void) {
    if (this.closed) return;
    this.timers.get(recipeId)?.();
    const cancel = (this.deps.schedule ?? defaultSchedule)(() => {
      if (this.timers.get(recipeId) === cancel) this.timers.delete(recipeId);
      work();
    }, wait);
    this.timers.set(recipeId, cancel);
  }

  /**
   * Work that must wait for the caller's transaction. The transaction is synchronous, so a
   * microtask runs after its commit or its rollback.
   */
  private afterCommit(work: () => void) {
    queueMicrotask(() => {
      try {
        work();
      } catch (error) {
        this.log(String(error));
      }
    });
  }

  /**
   * Logs one failure of one schedule once, so a row that never reads does not fill the log and a
   * different failure of the same schedule is still heard.
   */
  private logOnce(recipeId: string, line: string) {
    const key = `${recipeId}: ${line}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(key);
  }

  private log(line: string) {
    (this.deps.log ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);
  }
}

/** The schedule as clients list it, without what the person approved. */
function shown(schedule: PlanScheduleRecord): PlanSchedule {
  const { approved: _approved, ...rest } = schedule;
  return rest;
}

/** The metered families a crew names, in crew order. Local has no allowance to read. */
function metered(recipe: Pick<PlanRecipe, 'crew'>): MeteredFamily[] {
  return [
    ...new Set(
      recipe.crew.members.flatMap(({ selection }) => {
        const family = MeteredFamilySchema.safeParse(selection.family);
        return family.success ? [family.data] : [];
      }),
    ),
  ];
}

/** The schedule commands, answered with the contract's shapes. */
export function schedulesCommand(
  scheduler: Scheduler,
  command:
    | {
        command: 'SetRecipeSchedule';
        payload: { recipeId: string; action: 'pause' | 'resume' | 'restart' };
      }
    | { command: 'ReadSchedules'; payload: { projectId?: string } },
  effects: Effects,
): CommandResult {
  try {
    if (command.command === 'ReadSchedules')
      return {
        outcome: 'applied',
        data: { kind: 'schedules', ...scheduler.read(command.payload) },
      };
    scheduler.set(command.payload, effects);
    return { outcome: 'applied' };
  } catch (failure) {
    if (failure instanceof RecipeRefused)
      return { outcome: 'blocked', reason: failure.reason, next: failure.next };
    throw failure;
  }
}
