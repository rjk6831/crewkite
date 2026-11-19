import {
  ChatCrewRoleSchema,
  ChatEffortSchema,
  type ChatFamily,
  type ChatTurn,
  ChatTurnSchema,
  MAX_RESULT_RECORDS,
  MAX_RESULT_RUNS,
  type MeteredFamily,
  MeteredFamilySchema,
  ObservationSchema,
  type PlanRecipeRun,
  PlanRecipeRunSchema,
  PlanRecipeSchema,
  type ResultsExport,
  type ResultsRead,
  ResultsReadSchema,
  type Route,
  type SliceResult,
  SliceResultSchema,
  type Task,
  UsageReaderSchema,
  windowAppliesTo,
} from '@crewkite/contracts';
import { BRACKET_MS } from '../chat/analytics.ts';
import { listChanges } from '../chat/changes.ts';
import { failedByRestart } from '../chat/restart-failure.ts';
import { chatScratchDirectory } from '../chat/scratch-folder.ts';
import type { Store } from '../store/index.ts';
import type { PlanEvent } from './events.ts';

// What each step of a plan produced (ADR 0059). The recorder hears the same events as the run
// tracker and writes one record per anchor and step in the transaction that decided the fact. A
// value it did not see stays unknown or null. The final state is the one value that moves later,
// from waiting or unknown to what the person decided. Nothing here calls a provider or leaves
// the device.

type StepEnded = Extract<PlanEvent, { kind: 'step-ended' }>;

/** What the record cannot say about the moment an event lands. The recorder reads them. */
export type ResultFacts = {
  /** For a step that opens with no record yet: the new record's ID, project and run. */
  open: { id: string; projectId: string; run: PlanRecipeRun | null } | null;
  /**
   * What the thread leaves the person to decide, read at a plan's end and at a discard: waiting
   * while its copy may hold changes, none once nothing is left.
   */
  left: 'waiting' | 'none';
  /**
   * While the thread's plan is at work, by the phase its record holds: the slices it shows done.
   * Null when no plan is at work.
   */
  running: ReadonlySet<number> | null;
};

const HASH = /^[a-f0-9]{64}$/;
const hashOrNull = (value: string | null) => (value !== null && HASH.test(value) ? value : null);
const countOrNull = (value: number | null) =>
  value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
const round = (value: number) => Math.round(value * 1e6) / 1e6;
/** Not decided yet: the plan has not ended, or it ended with changes the person has not judged. */
const undecided = (record: SliceResult) => record.final === 'waiting' || record.final === 'unknown';

/**
 * The record after this event, or the same record when the event moves nothing. Undefined in,
 * with a step that opens, gives the new record. Every other event needs a record to fold into, so
 * an end, a gate or a decision for a step nobody saw open writes nothing.
 */
export function nextRecord(
  record: SliceResult | undefined,
  event: PlanEvent,
  facts: ResultFacts,
): SliceResult | undefined {
  if (!record)
    return event.kind === 'step-started' && facts.open ? opened(event, facts.open) : undefined;
  switch (event.kind) {
    case 'step-ended':
      return ended(record, event);
    case 'gate':
      // A slice step reads the checks of its own slice once it has ended. A step of the whole
      // plan has no slice of its own to check, so it keeps none.
      if (record.slice === null || record.endedAt === null || record.firstGate !== 'none')
        return record;
      return record.anchorTurnId === event.anchorTurnId
        ? { ...record, firstGate: event.result }
        : record;
    case 'plan-ended':
      // A paused plan has slices the person can still run, so nothing is decided yet.
      if (event.outcome === 'paused' || record.final !== 'unknown') return record;
      return { ...record, final: facts.left };
    // Accept is refused while a plan runs, so a record still unknown here belongs to a plan that
    // stopped, and the person decided on what it left.
    case 'accepted':
      return undecided(record) ? { ...record, final: 'accepted' } : record;
    // An emptied copy settles what it emptied: every record of a plan no longer at work, and of a
    // plan at work the records of the slices it shows done. The rest of that plan can still
    // write, so those records wait for its end.
    case 'changes-discarded':
      if (facts.left !== 'none' || !undecided(record)) return record;
      return record.final === 'waiting' ||
        facts.running === null ||
        (record.slice !== null && facts.running.has(record.slice))
        ? { ...record, final: 'discarded' }
        : record;
    case 'thread-deleted':
      return undecided(record) ? { ...record, final: 'discarded' } : record;
    default:
      return record;
  }
}

function opened(
  event: Extract<PlanEvent, { kind: 'step-started' }>,
  open: NonNullable<ResultFacts['open']>,
): SliceResult {
  const effort = event.effort === null ? null : ChatEffortSchema.safeParse(event.effort);
  return {
    id: open.id,
    projectId: open.projectId,
    taskId: event.taskId,
    anchorTurnId: event.anchorTurnId,
    recipeId: open.run?.recipeId ?? null,
    recipeHash: open.run?.versionHash ?? null,
    runId: open.run?.id ?? null,
    slice: event.slice,
    step: event.step,
    role: event.role,
    family: event.family,
    model: event.model && event.model.length <= 200 ? event.model : null,
    effort: effort?.success ? effort.data : null,
    rulesDigest: null,
    designVersionHash: null,
    firstGate: 'none',
    firstReview: 'none',
    findings: null,
    fixRounds: event.step === 'build' ? 0 : null,
    final: 'unknown',
    durationMs: null,
    allowanceUsed: null,
    allowanceWindow: null,
    startedAt: event.at,
    endedAt: null,
  };
}

/**
 * An ending folds into the step's own record and into the records of its anchor it speaks about:
 * a fix counts on the build, and a review done is the first review of a build or fix that had
 * ended before it.
 */
function ended(record: SliceResult, event: StepEnded): SliceResult {
  if (record.anchorTurnId !== event.anchorTurnId) return record;
  if (record.step === event.step) {
    // The first round's turn holds the rules and the design system. A later round adds its time,
    // and an unknown in any round leaves the sum unknown for good. The allowance is written apart,
    // once the reading after the last round has come.
    const first = record.endedAt === null;
    const duration = countOrNull(event.durationMs);
    return {
      ...record,
      ...(first
        ? {
            rulesDigest: hashOrNull(event.rulesDigest),
            designVersionHash: hashOrNull(event.designVersionHash),
          }
        : {}),
      durationMs: first
        ? duration
        : record.durationMs === null || duration === null
          ? null
          : record.durationMs + duration,
      endedAt: event.at,
    };
  }
  if (record.step === 'build' && event.step === 'fix')
    return { ...record, fixRounds: record.fixRounds === null ? null : record.fixRounds + 1 };
  // A review that failed or was stopped stated nothing, so it is no review.
  if (
    event.step === 'review' &&
    event.outcome === 'done' &&
    (record.step === 'build' || record.step === 'fix') &&
    record.endedAt !== null &&
    record.firstReview === 'none'
  ) {
    const findings = countOrNull(event.findings);
    return {
      ...record,
      firstReview: findings === null ? 'unknown' : findings === 0 ? 'clean' : 'findings',
      findings,
    };
  }
  return record;
}

/** One reading of one usage window, as the journal holds it. `at` is when it was observed. */
type Reading = {
  windowId: string;
  scope?: 'provider' | 'model' | 'pool';
  value: number;
  resetsAt: string | null;
  at: number;
};

/**
 * The percent readings of one family the journal received at or after `since`, oldest first.
 * They are the rows analytics reads for its brackets, parsed the same way: an observation of a
 * route on the family, or a reading the Anthropic reader reported. Rows that do not parse are
 * skipped. The scan walks back from the newest row and stops at the first one journaled before
 * `since`, so it reads only the last few minutes.
 */
function journaled(store: Store, family: MeteredFamily, since: number): Reading[] {
  const routes = new Map<string, ChatFamily | undefined>();
  const familyOf = (routeId: string) => {
    if (!routes.has(routeId)) routes.set(routeId, store.get<Route>('route', routeId)?.family);
    return routes.get(routeId);
  };
  const readings: Reading[] = [];
  const rows = store.db
    .prepare(
      `SELECT json_extract(body,'$.type') AS type, json_extract(body,'$.at') AS at,
         json_extract(body,'$.payload') AS payload
       FROM events WHERE task_id IS NULL ORDER BY cursor DESC`,
    )
    .iterate();
  for (const row of rows) {
    if (!(Date.parse(row.at as string) >= since)) break;
    if (row.type !== 'usage.observed' && row.type !== 'usage.reader-updated') continue;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload as string);
    } catch {
      continue;
    }
    if (row.type === 'usage.observed') {
      const parsed = ObservationSchema.safeParse(payload);
      const value = parsed.success ? parsed.data : null;
      if (value?.remaining?.unit !== 'percent' || familyOf(value.routeId) !== family) continue;
      readings.push({
        windowId: value.windowId,
        ...(value.semantics ? { scope: value.semantics.scope } : {}),
        value: value.remaining.value,
        resetsAt: value.resetsAt,
        at: Date.parse(value.observedAt),
      });
      continue;
    }
    const reader = UsageReaderSchema.safeParse(payload);
    const reading = reader.success && reader.data.family === family ? reader.data.reading : null;
    if (reading?.status !== 'reported') continue;
    for (const window of reading.windows)
      readings.push({
        windowId: window.windowId,
        value: window.remaining.value,
        resetsAt: window.resetsAt,
        at: Date.parse(reading.receivedAt),
      });
  }
  return readings.sort((left, right) => left.at - right.at);
}

export type ResultRecorderDeps = {
  store: Store;
  /** A new record ID. */
  id: () => string;
  home: string;
  projectPath: (projectId: string) => string | undefined;
  /** The time, for giving up on a reading that did not come. The default is the system clock. */
  now?: () => string;
  /** Where a turn the startup pass cannot close is reported. The default is standard error. */
  log?: (line: string) => void;
};

/** Events that can change a record. The rest are the run tracker's. */
const RECORDED = new Set<PlanEvent['kind']>([
  'step-started',
  'step-ended',
  'gate',
  'plan-ended',
  'accepted',
  'changes-discarded',
  'thread-deleted',
]);

/**
 * The most turns and steps the recorder follows at once, each. Past it the oldest is given up and
 * its step keeps no allowance.
 */
export const MAX_OPEN_STEPS = 256;

/** A step turn that opened: the tightest window's reading at its start, if one stood. */
type Start = { taskId: string; key: string; before: Reading | null };
/** A step turn that ended and waits for the first reading of its window after its end. */
type Pending = { taskId: string; key: string; family: MeteredFamily; end: number; before: Reading };
/** What a step's turns used so far, and whether every one of them has stood so far. */
type Tally = {
  taskId: string;
  anchorTurnId: string;
  step: SliceResult['step'];
  family: MeteredFamily | null;
  window: string | null;
  used: number;
  rounds: number;
  /** Turns that opened and have no standing or lost bracket yet. */
  open: number;
  lost: boolean;
  /** No later round can come: the build ended, the slice merged or the plan ended. */
  over: boolean;
};
const keyOf = (anchorTurnId: string, step: string) => `${anchorTurnId} ${step}`;

/** Keeps at most MAX_OPEN_STEPS entries, oldest out first, and hands back the ones it dropped. */
function bounded<T>(map: Map<string, T>, key: string, value: T): T[] {
  map.delete(key);
  map.set(key, value);
  const dropped: T[] = [];
  for (const [oldest, entry] of map) {
    if (map.size <= MAX_OPEN_STEPS) break;
    map.delete(oldest);
    dropped.push(entry);
  }
  return dropped;
}

/** Applies `nextRecord` to a thread's records, in the caller's transaction. */
export class ResultRecorder {
  private readonly deps: ResultRecorderDeps;
  /**
   * The allowance follows each step turn in memory, oldest first: its start, then its end waiting
   * for a reading, and per step the sum so far. A restart drops them, so a step that was open
   * then keeps no allowance.
   */
  private readonly starts = new Map<string, Start>();
  private readonly pending = new Map<string, Pending>();
  private readonly tallies = new Map<string, Tally>();
  /**
   * The newest time a thread's turns left the table: the recorder's own start, then each delete
   * it hears. A bracket that opened before it cannot be checked against those turns.
   */
  private deleted: number;

  constructor(deps: ResultRecorderDeps) {
    this.deps = deps;
    this.deleted = this.now();
  }

  private now(): number {
    return Date.parse(this.deps.now?.() ?? new Date().toISOString());
  }

  /**
   * Never throws: the work that sent the event goes on, and the records keep what they had. Each
   * event first closes the turns whose reading has come.
   */
  observe(event: PlanEvent) {
    // The deleted thread's turns are gone already, so no turn waiting now can be checked.
    if (event.kind === 'thread-deleted') {
      const at = Date.parse(event.at);
      this.deleted = Math.max(this.deleted, Number.isNaN(at) ? this.now() : at);
    }
    this.sweep();
    if (!RECORDED.has(event.kind)) return;
    try {
      const opened = this.atomically(() => this.fold(event));
      // The allowance follows the step only once the fold's own writes went through.
      this.follow(event, opened);
    } catch {
      // Only this event's writes are undone. The caller's transaction commits as it would have.
    }
    this.sweep();
  }

  /**
   * Once, after startup recovery: a step whose turn recovery failed never heard its end. It ends
   * now from the turn's row, at the turn's end time, as failed. The row's end is the restart, which
   * counts the downtime, so its duration is unknown. A step closed once is not closed again.
   */
  reconcile() {
    const { store } = this.deps;
    const log = this.deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
    const rows = store.db
      .prepare(
        `SELECT id, body FROM chat_turns
         WHERE task_id IN (SELECT DISTINCT task_id FROM slice_results)
           AND json_extract(body,'$.state')='failed' AND json_extract(body,'$.failure.kind')='internal'
         ORDER BY task_id, sequence`,
      )
      .all();
    for (const row of rows)
      try {
        const turn = ChatTurnSchema.parse(JSON.parse(row.body as string));
        if (!failedByRestart(turn.failure)) continue;
        store.transaction(() => {
          const records = this.records(turn.taskId);
          const event = this.cutOff(turn, records);
          if (event) this.apply(records, event, { open: null, left: 'waiting', running: null });
        });
      } catch (error) {
        // The record stays open, and the next startup reads it again. One line says which turn.
        log(`${String(row.id)}: ${String(error).split('\n')[0]}`);
      }
  }

  /**
   * Counts per recipe and per role and model, over a project's records or one recipe's. A row
   * that does not parse is left out, and the rest are counted.
   */
  read(projectId: string, recipeId?: string): ResultsRead {
    this.sweep();
    const { store } = this.deps;
    const records = this.rows(
      SliceResultSchema,
      `SELECT body FROM slice_results WHERE project_id=?${recipeId === undefined ? '' : ' AND recipe_id=?'} ORDER BY started_at, id`,
      projectId,
      ...(recipeId === undefined ? [] : [recipeId]),
    );
    // A recipe counts every run it started here, also one that ended before any step opened.
    const runs = new Map(
      store.db
        .prepare(
          `SELECT recipe_id AS id, count(*) AS runs FROM recipe_runs WHERE project_id=?${recipeId === undefined ? '' : ' AND recipe_id=?'} GROUP BY recipe_id`,
        )
        .all(projectId, ...(recipeId === undefined ? [] : [recipeId]))
        .map((row) => [row.id as string, row.runs as number]),
    );
    const byRecipe = group(
      records.filter((record) => record.recipeId !== null),
      (record) => record.recipeId as string,
    );
    for (const id of runs.keys()) if (!byRecipe.has(id)) byRecipe.set(id, []);
    const recipes = [...byRecipe]
      .map(([id, own]) => ({
        recipeId: id,
        name: this.recipeName(id),
        runs: runs.get(id) ?? 0,
        ...tally(own),
        allowance: allowanceByWindow(own),
      }))
      .sort(
        (left, right) =>
          Number(left.name === null) - Number(right.name === null) ||
          (left.name ?? '').localeCompare(right.name ?? '') ||
          left.recipeId.localeCompare(right.recipeId),
      );
    const builds = new Map(
      records
        .filter((record) => record.step === 'build')
        .map((record) => [record.anchorTurnId, record]),
    );
    const crew = [
      ...group(
        records.filter((record) => record.role && record.family && record.model),
        (record) => JSON.stringify([record.role, record.family, record.model, record.effort]),
      ).values(),
    ]
      .map((own) => {
        const { role, family, model, effort } = own[0];
        // A slice counts on the row of every role that ran a step on it. A plan step has no slice.
        const slices = [
          ...new Set(own.flatMap((record) => (record.slice === null ? [] : [record.anchorTurnId]))),
        ].flatMap((anchor) => builds.get(anchor) ?? []);
        return {
          role: role as NonNullable<SliceResult['role']>,
          family: family as ChatFamily,
          model: model as string,
          effort,
          steps: own.length,
          ...tally(slices),
          ...commonWindow(own),
        };
      })
      .sort(
        (left, right) =>
          ROLES.indexOf(left.role) - ROLES.indexOf(right.role) ||
          left.family.localeCompare(right.family) ||
          left.model.localeCompare(right.model) ||
          (left.effort ?? '').localeCompare(right.effort ?? ''),
      );
    return ResultsReadSchema.parse({
      projectId,
      records: records.length,
      first: records[0]?.startedAt ?? null,
      last: records.at(-1)?.startedAt ?? null,
      recipes: recipes.slice(0, MAX_RECIPES),
      crew: crew.slice(0, MAX_CREW),
      moreRecipes: Math.max(0, recipes.length - MAX_RECIPES),
      moreCrew: Math.max(0, crew.length - MAX_CREW),
    });
  }

  /**
   * One export page of records or runs, newest first. `next` names the page after it. A row that
   * does not parse is left out of the page, and the paging goes on past it.
   */
  page(payload: {
    projectId: string;
    recipeId?: string;
    part: 'records' | 'runs';
    before?: string;
  }): ResultsExport {
    this.sweep();
    const { projectId, recipeId, part } = payload;
    const before = payload.before === undefined ? undefined : cursor(payload.before);
    const limit = part === 'records' ? MAX_RESULT_RECORDS : MAX_RESULT_RUNS;
    const where = ['project_id=?'];
    const params: (string | number)[] = [projectId];
    if (recipeId !== undefined) {
      where.push('recipe_id=?');
      params.push(recipeId);
    }
    if (before) {
      where.push('(started_at<? OR (started_at=? AND id<?))');
      params.push(before.startedAt, before.startedAt, before.id);
    }
    // One row past the page says whether another page follows.
    const rows = this.deps.store.db
      .prepare(
        `SELECT id, started_at, body FROM ${part === 'records' ? 'slice_results' : 'recipe_runs'}
         WHERE ${where.join(' AND ')} ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit + 1);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    const shown = rows.slice(0, limit).map((row) => row.body as string);
    return {
      schema: 1,
      projectId,
      part,
      records: part === 'records' ? parsed(SliceResultSchema, shown) : [],
      runs: part === 'runs' ? parsed(PlanRecipeRunSchema, shown) : [],
      next: last ? `${last.started_at as string}|${last.id as string}` : null,
    };
  }

  /** Runs inside the caller's transaction, and undoes only its own writes when one fails. */
  private atomically<T>(work: () => T): T {
    const { store } = this.deps;
    if (!store.inTransaction) return store.transaction(work);
    store.db.exec('SAVEPOINT slice_results');
    try {
      return work();
    } catch (error) {
      store.db.exec('ROLLBACK TO slice_results');
      throw error;
    } finally {
      store.db.exec('RELEASE slice_results');
    }
  }

  /**
   * Folds the event. For a step turn that opens it hands back the reading that stood at its start
   * and whether an earlier round of the step was recorded.
   */
  private fold(event: PlanEvent): { before: Reading | null; known: boolean } | null {
    const records = this.records(event.taskId);
    let open: ResultFacts['open'] = null;
    let opened: { before: Reading | null; known: boolean } | null = null;
    if (event.kind === 'step-started') {
      // A later round of a step folds into the record its first round opened.
      const known = records.some(
        (record) => record.anchorTurnId === event.anchorTurnId && record.step === event.step,
      );
      if (!known) open = this.opening(event.taskId);
      if (event.turnId)
        opened = {
          before: this.startReading(event.family, event.model, Date.parse(event.at)),
          known,
        };
    }
    const decides =
      (event.kind === 'plan-ended' && records.some((record) => record.final === 'unknown')) ||
      (event.kind === 'changes-discarded' && records.some(undecided));
    this.apply(records, event, {
      open,
      left: decides ? this.leftToDecide(event.taskId) : 'waiting',
      running: event.kind === 'changes-discarded' ? this.planRunning(event.taskId) : null,
    });
    return opened;
  }

  private apply(records: SliceResult[], event: PlanEvent, facts: ResultFacts) {
    const { store } = this.deps;
    if (facts.open) {
      const created = nextRecord(undefined, event, facts);
      if (created) store.insertSliceResult(created);
    }
    for (const record of records) {
      const next = nextRecord(record, event, facts);
      if (next && next !== record) store.updateSliceResult(next);
    }
  }

  /** A thread's records, oldest first. A row that does not parse is left out. */
  private records(taskId: string): SliceResult[] {
    return this.rows(
      SliceResultSchema,
      'SELECT body FROM slice_results WHERE task_id=? ORDER BY started_at, id',
      taskId,
    );
  }

  private rows<T>(
    schema: { safeParse(value: unknown): ParseResult<T> },
    sql: string,
    ...params: string[]
  ) {
    return parsed(
      schema,
      this.deps.store.db
        .prepare(sql)
        .all(...params)
        .map((row) => row.body as string),
    );
  }

  /** Moves the allowance's memory on with an event whose fold went through. */
  private follow(event: PlanEvent, opened: { before: Reading | null; known: boolean } | null) {
    // The delete's time already refuses every bracket open now. The deleted thread's own steps
    // have no record left to write.
    if (event.kind === 'thread-deleted') {
      for (const map of [this.starts, this.pending, this.tallies] as Map<
        string,
        { taskId: string }
      >[])
        for (const [key, value] of map) if (value.taskId === event.taskId) map.delete(key);
      return;
    }
    if (event.kind === 'plan-ended')
      for (const tally of this.tallies.values())
        if (tally.taskId === event.taskId) tally.over = true;
    if (event.kind !== 'step-started' && event.kind !== 'step-ended') return;
    if (event.kind === 'step-ended' && event.step === 'merge' && event.outcome === 'done')
      for (const tally of this.tallies.values())
        if (tally.anchorTurnId === event.anchorTurnId) tally.over = true;
    if (!event.turnId) return;
    const key = keyOf(event.anchorTurnId, event.step);
    if (event.kind === 'step-started') {
      let tally = this.tallies.get(key);
      if (!tally) {
        tally = {
          taskId: event.taskId,
          anchorTurnId: event.anchorTurnId,
          step: event.step,
          family: null,
          window: null,
          used: 0,
          rounds: 0,
          open: 0,
          // An earlier round this memory never saw has no bracket.
          lost: opened?.known === true,
          over: false,
        };
        for (const dropped of bounded(this.tallies, key, tally)) dropped.lost = true;
      }
      tally.open += 1;
      for (const dropped of bounded(this.starts, event.turnId, {
        taskId: event.taskId,
        key,
        before: opened?.before ?? null,
      }))
        this.lose(dropped.key);
      return;
    }
    const start = this.starts.get(event.turnId);
    this.starts.delete(event.turnId);
    const tally = this.tallies.get(key);
    // A build has one round. A retried slice is a new anchor.
    if (tally && event.step === 'build') tally.over = true;
    const family = MeteredFamilySchema.safeParse(event.family);
    if (!start?.before || !family.success || Number.isNaN(Date.parse(event.at)))
      return start ? this.lose(key) : undefined;
    for (const dropped of bounded(this.pending, event.turnId, {
      taskId: event.taskId,
      key,
      family: family.data,
      end: Date.parse(event.at),
      before: start.before,
    }))
      this.lose(dropped.key);
  }

  /** One turn of the step has no bracket, so the step keeps none. */
  private lose(key: string) {
    const tally = this.tallies.get(key);
    if (!tally) return;
    tally.lost = true;
    tally.open = Math.max(0, tally.open - 1);
  }

  /**
   * Closes each ended turn whose window has its first reading after the turn's end, then writes
   * the allowance of each step that is over with every turn closed. It reads the journal and the
   * turn rows and writes only this table, inside the caller's transaction when there is one. A
   * turn whose reading is past the bracket limit is given up. Never throws.
   */
  private sweep() {
    const writes = [...this.tallies.values()].some((tally) => tally.over && tally.open === 0);
    if (!this.starts.size && !this.pending.size && !writes) return;
    try {
      this.atomically(() => this.close());
    } catch {
      // Nothing is written, and the next event or read tries again.
    }
  }

  private close() {
    const { store } = this.deps;
    const now = this.now();
    const row = store.db.prepare(
      "SELECT json_extract(body,'$.endedAt') AS ended, json_extract(body,'$.connectionId') AS connection FROM chat_turns WHERE id=?",
    );
    // A start whose turn row is gone came from a write that did not commit.
    for (const [turnId, start] of this.starts)
      if (!row.get(turnId)) {
        this.starts.delete(turnId);
        const tally = this.tallies.get(start.key);
        if (tally) tally.open = Math.max(0, tally.open - 1);
      }
    for (const [turnId, turn] of this.pending) {
      const tally = this.tallies.get(turn.key);
      const settled = row.get(turnId);
      // A turn on an assigned connection spends that connection's own allowance, which the
      // family's window does not show.
      if (!tally || !settled || settled.ended === null || settled.connection !== null) {
        this.pending.delete(turnId);
        this.lose(turn.key);
        continue;
      }
      // The first reading of the window at or after the end. A later one never stands in for it.
      const after = journaled(store, turn.family, turn.end).find(
        (reading) => reading.windowId === turn.before.windowId && reading.at >= turn.end,
      );
      if (!after) {
        if (now - turn.end > BRACKET_MS) {
          this.pending.delete(turnId);
          this.lose(turn.key);
        }
        continue;
      }
      this.pending.delete(turnId);
      const stands =
        after.at - turn.end <= BRACKET_MS &&
        // With no reset time on either side a reset between the two cannot be ruled out.
        turn.before.resetsAt !== null &&
        // A thread deleted since the opening reading took turns this check can no longer see.
        turn.before.at >= this.deleted &&
        after.resetsAt === turn.before.resetsAt &&
        after.value <= turn.before.value &&
        !this.shared(turn.family, turnId, turn.before.at, after.at) &&
        (tally.rounds === 0 ||
          (tally.family === turn.family && tally.window === turn.before.windowId));
      if (!stands) {
        this.lose(turn.key);
        continue;
      }
      tally.family = turn.family;
      tally.window = turn.before.windowId;
      tally.used = round(tally.used + turn.before.value - after.value);
      tally.rounds += 1;
      tally.open = Math.max(0, tally.open - 1);
    }
    for (const [key, tally] of this.tallies) {
      if (!tally.over || tally.open > 0) continue;
      this.tallies.delete(key);
      if (tally.lost || tally.rounds === 0 || tally.window === null || tally.window.length > 60)
        continue;
      if (tally.used > 100) continue;
      const record = this.records(tally.taskId).find(
        (value) => value.anchorTurnId === tally.anchorTurnId && value.step === tally.step,
      );
      if (record && record.allowanceUsed === null)
        store.updateSliceResult({
          ...record,
          allowanceUsed: tally.used,
          allowanceWindow: tally.window,
        });
    }
  }

  /**
   * A new record's ID and project, and the run while the thread is a recipe run. A run is its
   * first plan, to that plan's end, so a later plan on the thread records no recipe.
   */
  private opening(taskId: string): ResultFacts['open'] {
    const { store } = this.deps;
    const task = store.get<Task>('task', taskId);
    if (!task) return null;
    const row = store.db.prepare('SELECT body FROM recipe_runs WHERE task_id=?').get(taskId);
    const run = row ? parsed(PlanRecipeRunSchema, [row.body as string])[0] : undefined;
    return {
      id: this.deps.id(),
      projectId: task.projectId,
      run: run && run.endedAt === null ? run : null,
    };
  }

  /** The recipe's name in its current saved version, or null once it is forgotten. */
  private recipeName(id: string): string | null {
    const row = this.deps.store.db
      .prepare(
        'SELECT v.body FROM recipes r JOIN recipe_versions v ON v.recipe_id=r.id AND v.version=r.version WHERE r.id=?',
      )
      .get(id);
    return (row && parsed(PlanRecipeSchema, [row.body as string])[0]?.name) ?? null;
  }

  /**
   * The tightest window that limits the model, from the newest reading of each window journaled
   * at most BRACKET_MS before the start. Local has no window. A read that fails is no reading.
   */
  private startReading(
    family: ChatFamily | null,
    model: string | null,
    at: number,
  ): Reading | null {
    const metered = MeteredFamilySchema.safeParse(family);
    if (!metered.success || Number.isNaN(at)) return null;
    try {
      const latest = new Map<string, Reading>();
      for (const reading of journaled(this.deps.store, metered.data, at - BRACKET_MS))
        if (reading.at <= at && at - reading.at <= BRACKET_MS)
          latest.set(reading.windowId, reading);
      const reported = [...latest.keys()];
      let tightest: Reading | undefined;
      for (const reading of latest.values())
        if (
          windowAppliesTo(reading, model, reported) &&
          (!tightest || reading.value < tightest.value)
        )
          tightest = reading;
      return tightest ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Whether another chat turn on the family overlaps the two readings, in any thread of any
   * project: the window is the account's. A turn overlaps when it started before the closing
   * reading and had not ended by the opening one. A turn whose time cannot be read counts as
   * overlapping. The two halves, turns that ended at or after the opening reading and turns not
   * ended, are each a search on the family and the end in the index migration 027 adds, so only
   * those turns are read. The index serves the query only while both repeat its expressions. A
   * task run and a design preview's own turn write no chat turn row, and use of the account
   * outside CrewKite leaves none, so the check cannot see them.
   */
  private shared(family: ChatFamily, turnId: string, from: number, to: number) {
    return this.deps.store.db
      .prepare(
        `SELECT json_extract(body,'$.startedAt') AS started, json_extract(body,'$.endedAt') AS ended
         FROM chat_turns
         WHERE json_extract(body,'$.selection.family')=? AND json_extract(body,'$.endedAt')>=?
           AND id<>?
         UNION ALL
         SELECT json_extract(body,'$.startedAt') AS started, NULL AS ended
         FROM chat_turns
         WHERE json_extract(body,'$.selection.family')=? AND json_extract(body,'$.endedAt') IS NULL
           AND id<>?`,
      )
      .all(family, new Date(from).toISOString(), turnId, family, turnId)
      .some(
        (turn) =>
          !(Date.parse(turn.started as string) >= to) &&
          (turn.ended === null || !(Date.parse(turn.ended as string) <= from)),
      );
  }

  /**
   * The slices a plan at work shows done, with the phase read the way the run tracker reads it,
   * or null when no plan is at work. A thread record that cannot be read counts as a plan at work
   * with nothing done.
   */
  private planRunning(taskId: string): ReadonlySet<number> | null {
    try {
      const plan = this.deps.store.chatThread(taskId)?.plan;
      if (plan?.phase !== 'running') return null;
      return new Set(plan.slices.filter((slice) => slice.status === 'done').map(({ id }) => id));
    } catch {
      return new Set();
    }
  }

  /**
   * A report leaves nothing to decide, and so does a copy with no change. A copy that cannot be
   * listed may hold changes, so the person decides.
   */
  private leftToDecide(taskId: string): ResultFacts['left'] {
    const { store } = this.deps;
    try {
      const run = store.recipeRunOf(taskId);
      if (run && store.recipeVersion(run.recipeId, run.version)?.recipe.shape === 'report')
        return 'none';
      const thread = store.chatThread(taskId);
      if (!thread?.base || !thread.scratchReady) return 'none';
      const task = store.get<Task>('task', taskId);
      const root = task && this.deps.projectPath(task.projectId);
      if (!root) return 'waiting';
      const { files } = listChanges(
        root,
        chatScratchDirectory(this.deps.home, taskId),
        thread.base,
      );
      return files === 0 ? 'none' : 'waiting';
    } catch {
      return 'waiting';
    }
  }

  /**
   * The end a turn recovery failed stands for, or null when no open step owns it. The turn's role
   * and slice name the step. A build is its own anchor. A challenge or a report is the current
   * plan's record of that step, anchored on the plan's orchestrator turn. Any other step is the
   * newest record of its kind for the slice in the thread's current plan, opened before the turn
   * ended. A record that
   * ended at or after the turn began already holds this round, so a step is never closed twice.
   */
  private cutOff(turn: ChatTurn, records: SliceResult[]): StepEnded | null {
    if (turn.endedAt === null) return null;
    const began = Date.parse(turn.startedAt);
    const stopped = Date.parse(turn.endedAt);
    const plan = this.deps.store.chatThread(turn.taskId)?.plan;
    // The report turn is an orchestrator turn of the plan after the one that wrote it. The plan
    // runner keeps which one in memory only, so the open report record of the plan stands for it.
    const steps: SliceResult['step'][] =
      turn.slice === undefined
        ? turn.role === 'challenger'
          ? ['challenge']
          : turn.role === 'orchestrator' && plan && turn.id !== plan.orchestratorTurnId
            ? ['report']
            : []
        : turn.role === 'assistant' || turn.role === 'ask'
          ? ['build']
          : turn.role === 'reviewer'
            ? ['review']
            : turn.role === 'fixer'
              ? ['fix', 'resolve']
              : [];
    if (!steps.length || !plan) return null;
    const planStart = this.deps.store.db
      .prepare("SELECT json_extract(body,'$.startedAt') AS at FROM chat_turns WHERE id=?")
      .get(plan.orchestratorTurnId)?.at as string | undefined;
    const record = records.findLast((value) =>
      value.step === 'build'
        ? steps.includes('build') && value.anchorTurnId === turn.id
        : steps.includes(value.step) &&
          value.slice === (turn.slice ?? null) &&
          Date.parse(value.startedAt) <= stopped &&
          (value.step === 'challenge' || value.step === 'report'
            ? value.anchorTurnId === plan.orchestratorTurnId
            : planStart !== undefined && Date.parse(value.startedAt) >= Date.parse(planStart)),
    );
    if (!record) return null;
    if (record.endedAt !== null && Date.parse(record.endedAt) >= began) return null;
    // A later orchestrator turn may be the person's next request, so only a report that never
    // ended is taken as cut off.
    if (record.step === 'report' && record.endedAt !== null) return null;
    return {
      kind: 'step-ended',
      taskId: turn.taskId,
      at: turn.endedAt,
      slice: record.slice,
      step: record.step,
      turnId: turn.id,
      anchorTurnId: record.anchorTurnId,
      role: record.role,
      family: turn.selection.family,
      model: turn.selection.model,
      effort: turn.selection.effort,
      rulesDigest: turn.rules?.digest ?? null,
      designVersionHash: turn.designSystem?.versionHash ?? null,
      outcome: 'failed',
      durationMs: null,
      findings: null,
    };
  }
}

type ParseResult<T> = { success: true; data: T } | { success: false };

/** The bodies that parse, in order. */
function parsed<T>(schema: { safeParse(value: unknown): ParseResult<T> }, bodies: string[]): T[] {
  return bodies.flatMap((body) => {
    try {
      const result = schema.safeParse(JSON.parse(body));
      return result.success ? [result.data] : [];
    } catch {
      return [];
    }
  });
}

const ROLES = ChatCrewRoleSchema.options;
const MAX_RECIPES = 200;
const MAX_CREW = 500;
const MAX_WINDOWS = 24;

function group<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const list = groups.get(key(value)) ?? [];
    list.push(value);
    groups.set(key(value), list);
  }
  return groups;
}

/**
 * The contract's figures, each counted over the build steps of the slices given. A slice counts
 * as reviewed when its first review gave a verdict: one that stated no count gave none. The mean
 * of fix rounds takes only builds whose plan has ended, since a build still at work has not had
 * its fixes yet.
 */
function tally(records: readonly SliceResult[]) {
  const builds = records.filter((record) => record.step === 'build');
  const rounds = builds.flatMap((record) =>
    record.fixRounds === null || record.final === 'unknown' ? [] : [record.fixRounds],
  );
  return {
    slices: builds.length,
    reviewed: builds.filter(
      (record) => record.firstReview === 'clean' || record.firstReview === 'findings',
    ).length,
    passedFirstReview: builds.filter((record) => record.firstReview === 'clean').length,
    fixRounds: rounds.length
      ? round(rounds.reduce((total, value) => total + value, 0) / rounds.length)
      : null,
    settled: builds.filter((record) => record.final === 'accepted' || record.final === 'discarded')
      .length,
    accepted: builds.filter((record) => record.final === 'accepted').length,
  };
}

/**
 * One sum per metered family and window ID. Percents of two windows never add. Steps with no
 * value count on their family's row with a null window. A merge has no family and Local no
 * window. The rows with the most steps come first, and the first 24 are kept.
 */
function allowanceByWindow(records: readonly SliceResult[]) {
  const rows = new Map<
    string,
    { family: MeteredFamily; window: string | null; used: number; steps: number }
  >();
  for (const record of records) {
    const family = MeteredFamilySchema.safeParse(record.family);
    if (!family.success) continue;
    const window = record.allowanceUsed === null ? null : record.allowanceWindow;
    const key = JSON.stringify([family.data, window]);
    const row = rows.get(key) ?? { family: family.data, window, used: 0, steps: 0 };
    row.used = round(row.used + (record.allowanceUsed ?? 0));
    row.steps += 1;
    rows.set(key, row);
  }
  const families = MeteredFamilySchema.options;
  return [...rows.values()]
    .sort(
      (left, right) =>
        right.steps - left.steps ||
        families.indexOf(left.family) - families.indexOf(right.family) ||
        Number(left.window === null) - Number(right.window === null) ||
        (left.window ?? '').localeCompare(right.window ?? ''),
    )
    .slice(0, MAX_WINDOWS);
}

/**
 * The row's sum over the steps read on its most common window ID, which a tie gives to the first
 * ID. Every other step counts as unknown.
 */
function commonWindow(records: readonly SliceResult[]) {
  const counts = new Map<string, number>();
  for (const record of records)
    if (record.allowanceUsed !== null && record.allowanceWindow !== null)
      counts.set(record.allowanceWindow, (counts.get(record.allowanceWindow) ?? 0) + 1);
  const [window] = [...counts].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0] ?? [undefined];
  const counted = records.filter(
    (record) =>
      window !== undefined && record.allowanceWindow === window && record.allowanceUsed !== null,
  );
  return {
    allowanceUsed: counted.length
      ? round(counted.reduce((total, record) => total + (record.allowanceUsed as number), 0))
      : null,
    allowanceWindow: counted.length ? (window ?? null) : null,
    allowanceUnknown: records.length - counted.length,
  };
}

/** A `next` this recorder gave: the start time and ID of the last record on the page before. */
function cursor(value: string): { startedAt: string; id: string } {
  const [startedAt, id, ...rest] = value.split('|');
  if (rest.length || !id || Number.isNaN(Date.parse(startedAt)))
    throw new Error('The page cursor is not one the controller gave.');
  return { startedAt, id };
}
