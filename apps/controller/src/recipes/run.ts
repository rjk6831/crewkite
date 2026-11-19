import type {
  AllowanceReading,
  ChatCatalogEntry,
  ChatCrew,
  CommandResult,
  PlanRecipe,
  PlanRecipeRecord,
  PlanRecipeRun,
  PlanRecipeRunsRead,
  Task,
} from '@crewkite/contracts';
import { commandWords } from '../chat/checks.ts';
import { familyName } from '../chat/prompt.ts';
import type { RecipeThreadSetup } from '../chat/service.ts';
import type { Store } from '../store/index.ts';
import {
  checkCommandProblem,
  MAX_THREAD_CHECKS,
  resolveCheck,
  threadCheckCount,
} from './checks.ts';
import {
  type RecipeApproval,
  RecipeRefused,
  type Recipes,
  recipeFileRefusal,
  switchedOff,
} from './service.ts';
import { crewReadings } from './tracker.ts';

// A manual run does what a person does by hand: it makes a thread in the project, sets it up from
// the saved version of a recipe and sends the request (ADR 0057). A refused run leaves nothing
// behind: no thread, no row, no copy and no ref. A schedule starts a run through the same
// function with its own origin and what the person approved for its checks.

type Effects = (() => void)[];

/** The commands that start or read runs. RunRecipe belongs to a project, not a task. */
export const runMutations = ['RunRecipe'];

export type RunDeps = {
  store: Store;
  now: () => string;
  /** A new run ID. */
  id: () => string;
  home: string;
  projectPath: (projectId: string) => string | undefined;
  recipes: Recipes;
  /** Creates the thread's task the way a new thread does. */
  createTask: (input: {
    projectId: string;
    title: string;
    outcome: string;
    criteria: string[];
  }) => Task;
  /** Sets the new thread up and sends the request. See ChatService.startRecipeThread. */
  startThread: (
    task: Task,
    setup: RecipeThreadSetup,
    effects: Effects,
    matches?: (directory: string) => boolean,
  ) => CommandResult;
  /** The catalog as it stands, with no provider call. */
  families: () => ChatCatalogEntry[];
  /** A project's recipes, schedules or runs changed, so clients read them again. */
  changed: (projectId: string, recipeId: string | null) => void;
  /**
   * Whether a report recipe may run. Off unless set: on a thread that only reports, Accept still
   * takes a file left in the copy, and a continued report can end on a zero its first part
   * contradicts. Upgrade: refuse Accept on a report thread, check the zero against every reply to
   * the report's message, then turn this on.
   */
  reportRuns?: boolean;
  /** Whether a run may take its work from a checklist file. See RecipeDeps. */
  checklistWork?: boolean;
};

export type RunInput = {
  /** The recipe's current record. A record that is no longer current refuses. */
  record: PlanRecipeRecord;
  request: string;
  origin: PlanRecipeRun['origin'];
  /** The checklist item a scheduled run took, or null. */
  item: string | null;
  /**
   * What the person approved for scheduled runs. The thread's check approval is set only when
   * every check of the recipe resolves to the same digest in the new copy. Left out, the thread
   * asks before it runs a check.
   */
  approved?: readonly RecipeApproval[];
};

export class RecipeRuns {
  private readonly deps: RunDeps;

  constructor(deps: RunDeps) {
    this.deps = deps;
  }

  /**
   * RunRecipe: the record is gone, then `versionHash` names another version than the current one,
   * then everything `startRun` refuses.
   */
  run(
    payload: { recipeId: string; request: string; versionHash?: string },
    effects?: Effects,
  ): PlanRecipeRun {
    const record = this.deps.store.recipe(payload.recipeId);
    if (!record) throw notFound();
    if (payload.versionHash !== undefined && payload.versionHash !== record.versionHash)
      throw moved(record.version);
    return this.startRun(
      { record, request: payload.request, origin: 'manual', item: null },
      effects,
    );
  }

  /**
   * Starts one run and answers its row, in the state running. It writes, so it runs inside a
   * transaction: the caller's when it passes `effects`, which it must run after the commit, and
   * its own otherwise. It throws RecipeRefused, with the reason and the sentence, and then has
   * left nothing written.
   */
  startRun(input: RunInput, effects?: Effects): PlanRecipeRun {
    if (effects) return this.begin(input, effects);
    const own: Effects = [];
    const run = this.deps.store.transaction(() => this.begin(input, own));
    for (const effect of own) effect();
    return run;
  }

  /** A recipe's runs, newest first, or the one run of a thread. */
  read(payload: { recipeId?: string; taskId?: string; limit: number }): PlanRecipeRunsRead {
    const { store } = this.deps;
    const one = payload.taskId === undefined ? undefined : store.recipeRunOf(payload.taskId);
    const recipeId = payload.recipeId ?? one?.recipeId;
    const { runs, more } = one
      ? { runs: [one], more: 0 }
      : payload.recipeId
        ? store.recipeRuns(payload.recipeId, payload.limit)
        : { runs: [], more: 0 };
    const record = recipeId ? store.recipe(recipeId) : undefined;
    const name = (record && store.recipeVersion(record.id, record.version)?.recipe.name) ?? null;
    return { runs, more, name };
  }

  private begin(input: RunInput, effects: Effects): PlanRecipeRun {
    const { store, now } = this.deps;
    const record = store.recipe(input.record.id);
    if (!record) throw notFound();
    if (record.versionHash !== input.record.versionHash) throw moved(record.version);
    const { entry, saved } = this.deps.recipes.read({
      projectId: record.projectId,
      recipeId: record.id,
    });
    if (entry.file === 'changed' || entry.file === 'missing' || entry.file === 'invalid')
      throw recipeFileRefusal(entry.file);
    if (!saved) throw notFound();
    if (saved.shape === 'report' && !this.deps.reportRuns) throw switchedOff('reportRuns');
    // The save refuses checklist work while it is off. A loop armed before that still holds a
    // version that names a checklist, and it starts nothing either.
    if (saved.work?.kind === 'checklist' && !this.deps.checklistWork)
      throw switchedOff('checklistWork');
    this.refuseCrew(saved.crew);
    const root = this.deps.projectPath(record.projectId);
    if (!root) throw new RecipeRefused('project-not-found', 'Choose a registered project.');
    const commands = saved.checks.map((check) => check.command);
    for (const command of commands) {
      const problem = checkCommandProblem(command, root);
      if (problem) throw new RecipeRefused('recipe-check-refused', problem);
    }
    const used = threadCheckCount(root, this.deps.home, commands);
    if (used === null)
      throw new RecipeRefused(
        'project-head-unavailable',
        'Commit once in this project, then send again.',
      );
    if (used > MAX_THREAD_CHECKS)
      throw new RecipeRefused(
        'recipe-checks-full',
        "This project's checks and the recipe's do not fit in one thread, which holds 16. Remove a check from the recipe.",
      );

    // Read before anything is written, so nothing after the thread exists can throw on it.
    const start = this.readings(saved);
    const first = input.request.split('\n').find((line) => line.trim() !== '') ?? input.request;
    const task = this.deps.createTask({
      projectId: record.projectId,
      title:
        first
          .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
          .trim()
          .slice(0, 80) || 'New thread',
      outcome: input.request.slice(0, 4096) || 'New thread',
      criteria: ['The request in this thread is addressed.'],
    });
    const started = this.deps.startThread(
      task,
      {
        crew: saved.crew,
        flightMode: saved.run.flightMode,
        permissionPolicy: saved.run.permissionPolicy,
        handoff: saved.run.handoff,
        checks: commands,
        line: `Run of ${saved.name}, version ${record.version}${input.origin === 'schedule' ? ', started by its loop' : ''}.`,
        request: input.request,
      },
      effects,
      input.approved && commands.length
        ? (directory) => approvalHolds(commands, input.approved ?? [], directory)
        : undefined,
    );
    if (started.outcome !== 'applied') {
      // The caller's transaction may still commit, so the new task goes with everything the
      // thread wrote. The chat service already removed the copy and its ref.
      // A task that cannot go would commit with the refusal, so the whole start rolls back.
      if (!store.removeTask(task.id)) throw new Error('A refused run could not remove its thread.');
      throw new RecipeRefused(started.reason ?? 'recipe-run-blocked', started.next ?? '');
    }

    const run: PlanRecipeRun = {
      id: this.deps.id(),
      recipeId: record.id,
      projectId: record.projectId,
      taskId: task.id,
      version: record.version,
      versionHash: record.versionHash,
      shape: saved.shape,
      origin: input.origin,
      item: input.item,
      state: 'running',
      findings: null,
      changedFiles: null,
      reason: null,
      startedAt: now(),
      endedAt: null,
      allowance: { start, end: null },
    };
    store.putRecipeRun(run);
    this.deps.changed(record.projectId, record.id);
    return run;
  }

  /** The first crew member that cannot take a turn, named by provider and role. */
  private refuseCrew(crew: ChatCrew) {
    const readiness = this.deps.recipes.readiness(crew);
    const at = readiness.findIndex((member) => member.reason !== null);
    if (at < 0) return;
    const { role, family, reason } = readiness[at];
    const provider = familyName[family];
    if (reason === 'not-connected')
      throw new RecipeRefused(
        'recipe-not-connected',
        `${provider} is not connected. Connect it in Settings, or change the recipe's ${role}.`,
      );
    if (reason === 'model-unknown')
      throw new RecipeRefused(
        'recipe-model-unknown',
        `${provider} does not list ${crew.members[at].selection.model}. Pick another model for the ${role}.`,
      );
    throw new RecipeRefused(
      'recipe-terms-pending',
      `Accept the ${provider} terms in Settings, then run again.`,
    );
  }

  /**
   * One reading per metered family the crew names, from the catalog as it stands. A family the
   * catalog has no reading for is unknown. No provider is called.
   */
  private readings(recipe: PlanRecipe): AllowanceReading[] {
    return crewReadings(
      recipe.crew.members.map((member) => member.selection),
      this.deps.families(),
    );
  }
}

/** True when every check resolves, in the new copy, to the digest the person approved. */
function approvalHolds(
  commands: readonly string[],
  approved: readonly RecipeApproval[],
  directory: string,
): boolean {
  const normal = (command: string) => commandWords(command)?.join(' ') ?? command;
  return commands.every((command) => {
    const match = approved.find((value) => normal(value.command) === normal(command));
    const digest = resolveCheck(command, directory).digest;
    return match !== undefined && digest !== null && digest === match.digest;
  });
}

const notFound = () => new RecipeRefused('recipe-not-found', 'That recipe is not saved here.');
const moved = (version: number) =>
  new RecipeRefused(
    'recipe-version-moved',
    `This recipe was saved again as version ${version}. Look at it, then run.`,
  );

/** The run commands, answered with the contract's shapes. */
export function runsCommand(
  runs: RecipeRuns,
  command:
    | { command: 'RunRecipe'; payload: { recipeId: string; request: string; versionHash?: string } }
    | {
        command: 'ReadRecipeRuns';
        payload: { recipeId?: string; taskId?: string; limit: number };
      },
  effects: Effects,
): CommandResult {
  try {
    if (command.command === 'ReadRecipeRuns')
      return { outcome: 'applied', data: { kind: 'recipe-runs', ...runs.read(command.payload) } };
    const run = runs.run(command.payload, effects);
    return { outcome: 'applied', data: { kind: 'recipe-run', run } };
  } catch (failure) {
    if (failure instanceof RecipeRefused)
      return { outcome: 'blocked', reason: failure.reason, next: failure.next };
    throw failure;
  }
}
