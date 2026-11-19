import {
  type AllowanceReading,
  type ChatCatalogEntry,
  type ChatCrew,
  type ChatFamily,
  type MeteredFamily,
  MeteredFamilySchema,
  PLAN_SCHEDULE_DRY_RUNS,
  PLAN_SCHEDULE_READING_MS,
  type PlanRecipeBudget,
  type PlanScheduleNote,
  type PlanScheduleState,
  windowAppliesTo,
} from '@crewkite/contracts';
import { familyName } from '../chat/prompt.ts';
import type { ChecklistItem } from './checklist.ts';

// When a schedule starts a run, and when a turn of a scheduled run may start (ADR 0058). Every
// function here is pure. The scheduler and the chat service gather the facts, call one of these
// and act on the answer, so the rule lives in one place and a test can walk every combination.

/** What the crew's metered families read against the budget. */
export type Allowance =
  | { kind: 'ok' }
  | { kind: 'unknown'; family: MeteredFamily }
  | { kind: 'over'; family: MeteredFamily; used: number; limit: number };

/** The inputs of the start table, with the values its lines name. */
export type StartInput = {
  at: string;
  allowance: Allowance;
  runs: { started: number; max: number };
  /** This recipe's runs that wait on the person, against the budget's most waiting. */
  waiting: { count: number; max: number };
  dryRuns: number;
  /** idle: no run yet or the last one ended. waiting: the last run is asked or ready. */
  lastRun: 'idle' | 'running' | 'waiting';
};

export type StartAnswer = {
  action: 'start' | 'skip' | 'pause' | 'stop';
  /** Null on a start, and on a skip that keeps the note the schedule holds. */
  note: PlanScheduleNote | null;
};

/**
 * The start table, first match wins. A stop beats a pause and a pause beats a skip, so a stopped
 * schedule says so even when a smaller reason also holds. An unknown reading beats one over the
 * limit, since an unknown reading cannot be judged at all.
 */
export function decideStart(input: StartInput): StartAnswer {
  const { at, allowance } = input;
  if (input.dryRuns >= PLAN_SCHEDULE_DRY_RUNS)
    return { action: 'stop', note: { code: 'dry-runs', at } };
  if (input.runs.started >= input.runs.max)
    return { action: 'stop', note: { code: 'run-limit', at, runs: input.runs.max } };
  if (input.waiting.count >= input.waiting.max)
    return { action: 'pause', note: { code: 'waiting-limit', at, waiting: input.waiting.count } };
  if (input.lastRun === 'running') return { action: 'skip', note: { code: 'run-active', at } };
  if (allowance.kind === 'unknown')
    return { action: 'skip', note: { code: 'allowance-unknown', at, family: allowance.family } };
  if (allowance.kind === 'over')
    return {
      action: 'skip',
      note: {
        code: 'allowance-limit',
        at,
        family: allowance.family,
        used: allowance.used,
        limit: allowance.limit,
      },
    };
  return { action: 'start', note: null };
}

export type PreconditionInput = {
  at: string;
  state: PlanScheduleState;
  /** The recipe file against the version the schedule armed. */
  file: 'current' | 'changed' | 'missing' | 'invalid';
  /** Rows 1 to 4 of the table read these, and they come before the crew check. */
  table: Omit<StartInput, 'at' | 'allowance'>;
  /** The first crew member that cannot take a turn, in crew order, or null when all can. */
  unready: {
    reason: 'not-connected' | 'model-unknown' | 'terms-pending';
    family: ChatFamily;
  } | null;
  /** What the checklist offers, for a schedule whose work is a checklist. */
  checklist: { path: string; next: ChecklistItem['kind'] } | null;
};

export type Precondition =
  | { action: 'none' }
  | { action: 'skip' | 'pause' | 'stop'; note: PlanScheduleNote | null };

/**
 * What decides a start before the allowance is read, or null when only the allowance is left. A
 * schedule that is not active does nothing. A recipe file that is not the armed version pauses.
 * Rows 1 to 4 of the table come next, so a stop or a pause still wins over a crew member who is
 * not ready. The checklist is read last, before any usage read.
 */
export function precondition(input: PreconditionInput): Precondition | null {
  const { at } = input;
  if (input.state !== 'active') return { action: 'none' };
  if (input.file === 'missing') return { action: 'pause', note: { code: 'recipe-missing', at } };
  if (input.file === 'invalid') return { action: 'pause', note: { code: 'recipe-invalid', at } };
  if (input.file === 'changed') return { action: 'pause', note: { code: 'recipe-changed', at } };
  const table = decideStart({ ...input.table, at, allowance: { kind: 'ok' } });
  if (table.action !== 'start') return { action: table.action, note: table.note };
  if (input.unready)
    return {
      action: 'skip',
      note: { code: input.unready.reason, at, family: input.unready.family },
    };
  const checklist = input.checklist;
  if (checklist?.next === 'unreadable')
    return { action: 'pause', note: { code: 'checklist-unreadable', at, path: checklist.path } };
  if (checklist?.next === 'done')
    return { action: 'stop', note: { code: 'checklist-done', at, path: checklist.path } };
  // Every unchecked item is held by an earlier run, so nothing is new to say.
  if (checklist?.next === 'held') return { action: 'skip', note: null };
  return null;
}

/** One metered family's reading judged against its limit. */
export type Verdict =
  | { kind: 'ok' }
  | { kind: 'no-limit' | 'unknown'; family: MeteredFamily }
  | { kind: 'over'; family: MeteredFamily; used: number; limit: number };

/**
 * A reading with no value, none observed, one from the future and one as old as
 * PLAN_SCHEDULE_READING_MS or older are unknown. Over means used above the limit. The used value
 * is rounded up, so a line never shows a value equal to the limit it crossed. A family the budget
 * sets no limit for cannot be judged.
 */
export function judge(reading: AllowanceReading, limit: number | undefined, at: string): Verdict {
  const { family } = reading;
  if (limit === undefined) return { kind: 'no-limit', family };
  const age =
    reading.observedAt === null ? Number.NaN : Date.parse(at) - Date.parse(reading.observedAt);
  if (reading.used === null || !(age >= 0 && age < PLAN_SCHEDULE_READING_MS))
    return { kind: 'unknown', family };
  if (reading.used > limit)
    return { kind: 'over', family, used: Math.min(100, Math.ceil(reading.used)), limit };
  return { kind: 'ok' };
}

/**
 * The tightest window that limits a model: the lowest value among the windows that apply to it,
 * or null when none of them has one. A window named for another model of the family does not
 * count, as in the contract's `tightestAllowance`, and with no model every window counts.
 */
export function tightestWindow(
  entry: Pick<ChatCatalogEntry, 'remaining'>,
  model: string | null,
): ChatCatalogEntry['remaining'][number] | null {
  const reported = entry.remaining.map((window) => window.windowId);
  let tightest: ChatCatalogEntry['remaining'][number] | null = null;
  for (const window of entry.remaining)
    if (
      window.percent !== null &&
      windowAppliesTo(window, model, reported) &&
      (tightest === null || window.percent < (tightest.percent ?? 100))
    )
      tightest = window;
  return tightest;
}

/**
 * One crew member's reading: the tightest window that limits that member's model, as percent
 * used, with the time that same window was observed. A model that no window with a value limits
 * reads unknown, and so does a family the catalog does not list.
 */
export function memberReading(
  family: MeteredFamily,
  model: string,
  families: readonly ChatCatalogEntry[],
): AllowanceReading {
  const entry = families.find((value) => value.family === family);
  const window = entry ? tightestWindow(entry, model) : null;
  if (window?.percent == null) return { family, used: null, window: null, observedAt: null };
  return {
    family,
    used: 100 - window.percent,
    window: window.windowId.slice(0, 60),
    observedAt: window.observedAt,
  };
}

/** Each metered member's reading, in crew order. Local has no allowance and is never read. */
export function memberReadings(
  crew: Pick<ChatCrew, 'members'>,
  families: readonly ChatCatalogEntry[],
): AllowanceReading[] {
  return crew.members.flatMap(({ selection }) => {
    const family = MeteredFamilySchema.safeParse(selection.family);
    return family.success ? [memberReading(family.data, selection.model, families)] : [];
  });
}

/**
 * The table's allowance input from one reading per metered crew member, in crew order. Any unknown
 * family makes it unknown and names the first. Otherwise any family over its limit makes it over
 * and names the first. A family with no limit counts as unknown, which the recipe schema already
 * rules out.
 */
export function allowanceOf(
  readings: readonly AllowanceReading[],
  limits: PlanRecipeBudget['maxUsedPercent'],
  at: string,
): Allowance {
  let over: Allowance | null = null;
  for (const reading of readings) {
    const verdict = judge(reading, limits[reading.family], at);
    if (verdict.kind === 'unknown' || verdict.kind === 'no-limit')
      return { kind: 'unknown', family: verdict.family };
    if (verdict.kind === 'over') over ??= verdict;
  }
  return over ?? { kind: 'ok' };
}

/**
 * Why a turn of a scheduled run does not start, as two sentences: the step, then the reason. The
 * thread writes them as one line, so the line names the step.
 */
export function turnRefusal(
  step: string,
  verdict: Exclude<Verdict, { kind: 'ok' }>,
): { message: string; next: string } {
  const provider = familyName[verdict.family];
  return {
    message: `${step} did not start.`,
    next:
      verdict.kind === 'over'
        ? `${provider} is at ${verdict.used}% used. The limit for this loop is ${verdict.limit}%.`
        : verdict.kind === 'unknown'
          ? `CrewKite has no current allowance reading for ${provider}.`
          : `This loop sets no limit for ${provider}.`,
  };
}
