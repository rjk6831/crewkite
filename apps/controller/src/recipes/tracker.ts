import {
  type AllowanceReading,
  type ChatCatalogEntry,
  type ChatFamily,
  type ChatPlanState,
  ChatTurnSchema,
  type MeteredFamily,
  MeteredFamilySchema,
  type PlanRecipe,
  type PlanRecipeRun,
  PlanRecipeRunSchema,
  type PlanRecipeRunState,
} from '@crewkite/contracts';
import { listChanges } from '../chat/changes.ts';
import { failedByRestart } from '../chat/restart-failure.ts';
import { chatScratchDirectory } from '../chat/scratch-folder.ts';
import type { Store } from '../store/index.ts';
import type { PlanEvent } from './events.ts';
import { memberReading } from './start-rule.ts';

// A recipe run's row follows its thread. The chat service and the plan runner send what they
// decide, and `nextRun` turns each event into the run's next row. A thread that is no recipe run
// sends the same events, and nothing here reads them. Most events go out inside the transaction
// that wrote their fact, so the row moves with the thread. Two go out right after it, in a
// transaction of their own: `asked` for a permission request, once the client did not answer it
// in the same tick, and the `plan-ended` of an orchestrator turn that wrote no plan, once nothing
// moved the work on. A crash between the two leaves the row behind, and `reconcile` reads it
// again from the thread at the next start.

/** States a run never leaves. */
const FINAL = new Set<PlanRecipeRunState>([
  'accepted',
  'discarded',
  'no-change',
  'reported',
  'failed',
  'stopped',
]);

/** What the row cannot say about the moment an event lands. The tracker reads them. */
export type RunFacts = {
  /** The shape of the version the run used. A version that is gone counts as a change. */
  shape: PlanRecipe['shape'];
  /**
   * Files the thread's copy changed from its base, or null when they could not be listed. Read
   * only for a finished plan and a discard.
   */
  changedFiles: number | null;
  /** The catalog's readings now, for a run that has not been stamped with its end yet. */
  readings: AllowanceReading[];
  /** The phase of the thread's plan as its records hold it, or null with no plan. */
  phase: ChatPlanState['phase'] | null;
};

/** The events that can stamp a run's end, so the tracker reads the catalog only for them. */
const ENDING = new Set<PlanEvent['kind']>([
  'plan-ended',
  'accepted',
  'changes-discarded',
  'thread-deleted',
]);

/**
 * The run after this event, or the same run when the event moves nothing. A run is its first
 * plan, to that plan's end: a ready run stays ready through a later plan on its thread, until the
 * person accepts, discards or deletes, and a final state never moves. A run waits on the person
 * while any question of its thread is open and while its plan is paused, so only an answer, Run
 * plan or the end moves it on. A run that has not ended and whose plan is stopped is paused: it
 * reads asked through any question that comes and goes, until Run plan, Accept, an emptied copy
 * or a delete moves it. The first move into ready or a final state stamps the end and its
 * readings, and later moves keep them.
 */
export function nextRun(run: PlanRecipeRun, event: PlanEvent, facts: RunFacts): PlanRecipeRun {
  if (FINAL.has(run.state)) return run;
  const going = run.state === 'running' || run.state === 'asked';
  const to = (state: PlanRecipeRunState, change: Partial<PlanRecipeRun> = {}): PlanRecipeRun =>
    state === 'running' || state === 'asked' || run.endedAt !== null
      ? { ...run, ...change, state }
      : {
          ...run,
          ...change,
          state,
          endedAt: event.at,
          allowance: { ...run.allowance, end: facts.readings },
        };
  switch (event.kind) {
    case 'asked':
      return run.state === 'running' ? to('asked') : run;
    case 'answered':
      // An answer inside a paused plan leaves the plan waiting on the person.
      if (facts.phase === 'stopped') return run.state === 'running' ? to('asked') : run;
      return run.state === 'asked' ? to('running') : run;
    case 'plan-started':
      return run.state === 'asked' ? to('running') : run;
    case 'plan-ended':
      if (!going) return run;
      // The person runs the rest from the plan card, or accepts or discards what is there.
      if (event.outcome === 'paused') return run.state === 'running' ? to('asked') : run;
      if (event.outcome === 'failed' || event.outcome === 'stopped')
        return to(event.outcome, { reason: reason(event.line) });
      if (facts.shape === 'report') return to('reported', { findings: event.findings });
      // A copy whose changes could not be listed may hold some, so the person decides.
      return to(facts.changedFiles === 0 ? 'no-change' : 'ready', {
        changedFiles: facts.changedFiles,
        findings: event.findings,
      });
    // The person decided on what the thread holds, so the run is over whatever it waited on.
    case 'accepted':
      return to('accepted');
    case 'changes-discarded':
      // A running run's plan is still at work, and its next step writes again.
      return run.state !== 'running' && facts.changedFiles === 0 ? to('discarded') : run;
    case 'thread-deleted':
      // A run never waits on a thread that is gone.
      return to(run.state === 'ready' ? 'discarded' : 'stopped');
    default:
      return run;
  }
}

/** A thread line as a run's reason: control characters as spaces, cut at 300 characters. */
function reason(line: string): string | null {
  const text = line
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .slice(0, 300)
    .toWellFormed();
  return text.trim() ? text : null;
}

export type RunTrackerDeps = {
  store: Store;
  now: () => string;
  home: string;
  projectPath: (projectId: string) => string | undefined;
  /** The catalog as it stands, with no provider call. */
  families: () => ChatCatalogEntry[];
  /** A project's runs changed, so clients read them again. */
  changed: (projectId: string, recipeId: string | null) => void;
  /**
   * Runs inside the caller's transaction after every change of a run's row. It may only write
   * rows: a throw rolls the move back with everything it wrote.
   */
  onRun?: (next: PlanRecipeRun, before: PlanRecipeRun) => void;
  /** Where a row that cannot be read is reported. The default is standard error. */
  log?: (line: string) => void;
};

/** Applies `nextRun` to the run of each event's thread, in the caller's transaction. */
export class RunTracker {
  private readonly deps: RunTrackerDeps;

  constructor(deps: RunTrackerDeps) {
    this.deps = deps;
  }

  observe(event: PlanEvent) {
    const { store } = this.deps;
    const apply = () => {
      const run = store.recipeRunOf(event.taskId);
      if (run) this.apply(run, event);
    };
    if (store.inTransaction) apply();
    else store.transaction(apply);
  }

  /**
   * Once, after startup recovery: each run still running, asked or ready is read again from its
   * thread as recovery left it, one row at a time, so one row that cannot be read is logged and
   * the rest still are. A thread that is gone settles the run as a delete does. For a run that
   * has not ended: a plan waiting for Run plan means asked, a newest turn that recovery failed
   * means failed with the thread's newest line, a finished plan means ready or no-change, a plan
   * the records show stopped means asked while its copy holds changes and stopped otherwise,
   * and an orchestrator turn that ended without a plan
   * ends the run the way the turn ended, with the line it wrote. An asked run whose question is
   * gone runs again, unless its plan is paused.
   */
  reconcile() {
    const { store } = this.deps;
    const log = this.deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
    const rows = store.db
      .prepare(
        "SELECT id,body FROM recipe_runs WHERE state IN ('running','asked','ready') ORDER BY started_at,id",
      )
      .all();
    for (const row of rows)
      try {
        const run = PlanRecipeRunSchema.parse(JSON.parse(row.body as string));
        store.transaction(() => {
          const event = this.recorded(run);
          if (event) this.apply(run, event);
        });
      } catch (error) {
        // The row stays as it was, and the next startup reads it again.
        log(`${String(row.id)}: ${String(error)}`);
      }
  }

  private apply(run: PlanRecipeRun, event: PlanEvent) {
    // A run that cannot move reads nothing, so a final run never lists its copy.
    if (FINAL.has(run.state)) return;
    const next = nextRun(run, event, this.facts(run, event));
    if (next === run) return;
    this.deps.store.updateRecipeRun(next);
    this.deps.changed(run.projectId, run.recipeId);
    this.deps.onRun?.(next, run);
  }

  /**
   * Reads only what this event can use: the copy at a finished plan or a discard, and the
   * readings for a run whose end is not stamped yet.
   */
  private facts(run: PlanRecipeRun, event: PlanEvent): RunFacts {
    const recipe = this.deps.store.recipeVersion(run.recipeId, run.version)?.recipe;
    const counted =
      (event.kind === 'plan-ended' && event.outcome === 'finished') ||
      event.kind === 'changes-discarded';
    return {
      shape: recipe?.shape ?? 'change',
      changedFiles: counted ? this.changedFiles(run) : null,
      readings: ENDING.has(event.kind) && run.endedAt === null ? this.readings(run, recipe) : [],
      phase: this.deps.store.chatThread(run.taskId)?.plan?.phase ?? null,
    };
  }

  private changedFiles(run: PlanRecipeRun): number | null {
    const thread = this.deps.store.chatThread(run.taskId);
    // A thread that never made its copy changed nothing.
    if (!thread?.base || !thread.scratchReady) return 0;
    const root = this.deps.projectPath(run.projectId);
    if (!root) return null;
    try {
      return listChanges(root, chatScratchDirectory(this.deps.home, run.taskId), thread.base).files;
    } catch {
      return null;
    }
  }

  /**
   * One reading per metered family the crew names, the way the start was read. A run whose
   * version is gone keeps the start's families with no reading.
   */
  private readings(run: PlanRecipeRun, recipe: PlanRecipe | undefined): AllowanceReading[] {
    if (!recipe)
      return run.allowance.start.map(({ family }) => ({
        family,
        used: null,
        window: null,
        observedAt: null,
      }));
    return crewReadings(
      recipe.crew.members.map((member) => member.selection),
      this.deps.families(),
    );
  }

  /** The event the thread's records stand for, or null when they move nothing. */
  private recorded(run: PlanRecipeRun): PlanEvent | null {
    const { store } = this.deps;
    const stamp = { taskId: run.taskId, at: this.deps.now() };
    if (!store.get('task', run.taskId)) return { ...stamp, kind: 'thread-deleted' };
    if (run.state === 'ready') return null;
    const plan = store.chatThread(run.taskId)?.plan;
    if (plan?.phase === 'proposed') return { ...stamp, kind: 'asked', question: 'plan' };
    const newest = store.db
      .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence DESC LIMIT 1')
      .get(run.taskId);
    const turn = newest && ChatTurnSchema.parse(JSON.parse(newest.body as string));
    const line = (author?: string) =>
      (store.db
        .prepare(
          `SELECT json_extract(body,'$.text') AS text FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='chat-system'${author ? " AND json_extract(body,'$.author.turnId')=? ORDER BY sequence" : ' ORDER BY sequence DESC'} LIMIT 1`,
        )
        .get(...(author ? [run.taskId, author] : [run.taskId]))?.text as string | undefined) ?? '';
    const ended = (outcome: 'failed' | 'stopped', text: string): PlanEvent => ({
      ...stamp,
      kind: 'plan-ended',
      outcome,
      line: text,
      findings: null,
    });
    if (turn && failedByRestart(turn.failure)) return ended('failed', line());
    // The review counts live in the reviews' text, which only the plan reads.
    if (plan?.phase === 'finished')
      return { ...stamp, kind: 'plan-ended', outcome: 'finished', line: '', findings: null };
    // A stopped plan with changes in its copy is a pause the person can still finish, so it waits.
    if (plan?.phase === 'stopped')
      return run.state !== 'running'
        ? null
        : this.changedFiles(run) === 0
          ? ended('stopped', line())
          : { ...stamp, kind: 'asked', question: 'plan' };
    if (
      !plan &&
      turn?.role === 'orchestrator' &&
      (turn.state === 'failed' || turn.state === 'stopped')
    )
      return ended(
        turn.state === 'stopped' && turn.stopCause !== 'client' ? 'stopped' : 'failed',
        line(turn.id),
      );
    if (run.state === 'asked') return { ...stamp, kind: 'answered' };
    return null;
  }
}

/**
 * One reading per metered family these selections name, from the catalog as it stands. A run
 * reads its start and its end by this rule.
 */
export function crewReadings(
  named: readonly { family: ChatFamily; model: string }[],
  families: readonly ChatCatalogEntry[],
): AllowanceReading[] {
  return MeteredFamilySchema.options
    .filter((family) => named.some((selection) => selection.family === family))
    .map((family) => reading(family, families, named));
}

/**
 * The tightest window across the crew's models on one family, as percent used, with the time
 * that same window was observed. Percents of two windows never add, so the reading names the
 * window it is of by its ID, which stays unique where two windows share a label.
 */
function reading(
  family: MeteredFamily,
  families: readonly ChatCatalogEntry[],
  named: readonly { family: ChatFamily; model: string }[],
): AllowanceReading {
  const known = named
    .filter((selection) => selection.family === family)
    .map((selection) => memberReading(family, selection.model, families))
    .filter((value) => value.used !== null);
  const tightest = known.reduce<AllowanceReading | null>(
    (high, value) => (high === null || (value.used ?? 0) > (high.used ?? 0) ? value : high),
    null,
  );
  return tightest ?? { family, used: null, window: null, observedAt: null };
}
