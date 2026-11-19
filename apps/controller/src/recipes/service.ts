import { lstatSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  type ChatCrew,
  type ChatModelSelection,
  type Command,
  type CommandResult,
  canonicalJson,
  MAX_PLAN_RECIPE_VERSIONS,
  MAX_PLAN_RECIPES,
  type PlanRecipe,
  type PlanRecipeChecks,
  type PlanRecipeEntry,
  type PlanRecipeFile,
  type PlanRecipeRead,
  type PlanRecipeReadinessSchema,
  type PlanRecipeRecord,
  PlanRecipeRecordSchema,
  type PlanRecipeSavedSchema,
  PlanRecipeSchema,
  type PlanRecipesRead,
  type PlanSchedule,
  type PlanScheduleApprovalSchema,
  type PlanScheduleRecord,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { ZodError, type z } from 'zod';
import { commandWords } from '../chat/checks.ts';
import { jsonIndex, lineAt } from '../design/import.ts';
import {
  type ProjectFileRefusal,
  projectFile,
  readText,
  writeAtomically,
} from '../host/project-file.ts';
import type { Store } from '../store/index.ts';
import { checkCommandProblem, type ResolvedCheck, resolveAtHead } from './checks.ts';

// A recipe is one JSON file in the project, and the controller records each version it saved
// (ADR 0057). Only a recorded version runs, so a read compares every file with its record, and a
// save writes the file only after the person confirmed the diff. A save never writes over an
// edit made on disk. Saving a recipe with a trigger approves what its checks run at the committed
// HEAD (ADR 0058), and the person must have seen exactly that.

export type RecipeCommand = Extract<
  Command,
  {
    command:
      | 'ReadRecipes'
      | 'ReadRecipe'
      | 'ResolveRecipeChecks'
      | 'SetRecipeFolder'
      | 'SaveRecipe'
      | 'ForgetRecipe';
  }
>;
type Payload<T extends RecipeCommand['command']> = Extract<
  RecipeCommand,
  { command: T }
>['payload'];
export type RecipeReadiness = z.infer<typeof PlanRecipeReadinessSchema>;
export type RecipeApproval = z.infer<typeof PlanScheduleApprovalSchema>;
export type RecipeSaved = z.infer<typeof PlanRecipeSavedSchema>;

/** The recipe commands that change something. They belong to a project, not a task. */
export const recipeMutations = ['SetRecipeFolder', 'SaveRecipe', 'ForgetRecipe'];

const RecipePathSchema = PlanRecipeRecordSchema.shape.path;

export class RecipeRefused extends Error {
  reason: string;
  next: string;
  constructor(reason: string, next: string) {
    super(next);
    this.reason = reason;
    this.next = next;
  }
}

/**
 * Why a saved recipe does not run or arm while its file is not the saved version. A run, a
 * resume and a restart refuse with these words, so they never drift apart. Any state other than
 * missing or invalid reads as changed.
 */
export function recipeFileRefusal(file: string): RecipeRefused {
  if (file === 'missing')
    return new RecipeRefused(
      'recipe-file-missing',
      'The recipe file is missing. Write it again, or forget the recipe.',
    );
  if (file === 'invalid')
    return new RecipeRefused(
      'recipe-file-invalid',
      'The recipe file no longer reads as a recipe. Fix it, then try again.',
    );
  return new RecipeRefused(
    'recipe-file-changed',
    'The recipe file changed on disk. Review it and save, then try again.',
  );
}

/** The refusal for a choice a controller option has switched off. A save and a run share it. */
export function switchedOff(option: 'checklistWork' | 'reportRuns'): RecipeRefused {
  return option === 'checklistWork'
    ? new RecipeRefused(
        'recipe-work-unavailable',
        'Checklist work is not available in this version. Give the loop a fixed request.',
      )
    : new RecipeRefused(
        'recipe-shape-unavailable',
        'Report only runs are not available in this version. Set Run type to Changes files.',
      );
}

const notFound = () => new RecipeRefused('recipe-not-found', 'That recipe is not saved here.');

export type RecipeDeps = {
  store: Store;
  now: () => string;
  /** A new recipe ID. */
  id: () => string;
  /** The controller home. Resolving checks at HEAD writes a private folder under it. */
  home: string;
  projectPath: (projectId: string) => string | undefined;
  /**
   * Why each crew member cannot take a turn now, in order, or null for one who can. It reads what
   * a turn start checks, from one catalog for the whole crew.
   */
  readiness: (selections: readonly ChatModelSelection[]) => RecipeReadiness['reason'][];
  /**
   * Called inside the save's transaction once the new version is recorded, with what the person
   * approved for scheduled runs. It answers the schedule it armed, or null.
   */
  armed?: (
    record: PlanRecipeRecord,
    body: PlanRecipe,
    approved: RecipeApproval[],
  ) => PlanSchedule | null;
  /** Called inside the forget's transaction once the record and its schedule are gone. */
  forgotten?: (recipeId: string) => void;
  /** A project's recipes changed, so clients read them again. */
  changed: (projectId: string, recipeId: string | null) => void;
  /**
   * Whether a loop may take its work from a checklist file. Off unless set: the reader reads the
   * file line by line and does not follow every rule of the markup, so it can take a line that
   * is no visible open item. Upgrade: read the file with a full parser, then turn this on.
   */
  checklistWork?: boolean;
  /** Whether a report recipe may run, so whether one may be given a loop. See RunDeps. */
  reportRuns?: boolean;
};

export class Recipes {
  private readonly deps: RecipeDeps;

  constructor(deps: RecipeDeps) {
    this.deps = deps;
  }

  /**
   * Every recorded recipe, then the picked folder's files CrewKite never saved, each sorted by
   * path. Records come first so a folder full of strangers' files never hides a saved recipe. A
   * file whose path differs from a record's only by letter case is that record's file when both
   * paths name one file, as on a case-insensitive disk. On a case-sensitive disk it is a file of
   * its own.
   */
  list(projectId: string): PlanRecipesRead {
    const root = this.root(projectId);
    const folder = this.deps.store.recipeFolder(projectId) ?? null;
    const records = this.deps.store.recipes(projectId);
    const files = (folder ? jsonFiles(root, folder).map((name) => `${folder}/${name}`) : [])
      .filter(
        (path) =>
          !records.some(
            (record) =>
              record.path === path ||
              (record.path.toLowerCase() === path.toLowerCase() &&
                sameFile(root, record.path, path)),
          ),
      )
      .sort();
    const shown = [
      ...records.map((record) => ({ path: record.path, record })),
      ...files.map((path) => ({ path, record: null })),
    ].slice(0, MAX_PLAN_RECIPES);
    return {
      projectId,
      folder,
      recipes: shown.map(({ path, record }) => this.entry(root, path, record).entry),
      more: records.length + files.length - shown.length,
      available: {
        checklistWork: this.deps.checklistWork === true,
        reportRuns: this.deps.reportRuns === true,
      },
    };
  }

  /** One recipe by its record or by its path, with a saved version and its readiness. */
  read(payload: Payload<'ReadRecipe'>): PlanRecipeRead {
    const { projectId } = payload;
    const root = this.root(projectId);
    const record =
      payload.recipeId !== undefined
        ? this.record(payload.recipeId, projectId)
        : (this.deps.store.recipes(projectId).find((value) => value.path === payload.path) ?? null);
    const path = record?.path ?? payload.path;
    if (path === undefined) throw notFound();
    const { entry, recipe } = this.entry(root, path, record);
    if (!record && entry.file === 'missing') throw notFound();
    const version = payload.version ?? record?.version;
    const saved =
      record && version !== undefined
        ? this.deps.store.recipeVersion(record.id, version)
        : undefined;
    if (record && !saved) throw notFound();
    const listed = record
      ? this.deps.store.recipeVersions(record.id, MAX_PLAN_RECIPE_VERSIONS)
      : { versions: [], more: 0 };
    const crew = (recipe ?? saved?.recipe)?.crew;
    return {
      entry,
      recipe,
      saved: saved?.recipe ?? null,
      savedVersion: saved && version !== undefined ? version : null,
      versions: listed.versions,
      moreVersions: listed.more,
      readiness: crew ? this.readiness(crew) : [],
      approved: (record && this.schedule(record.id)?.approved) ?? [],
    };
  }

  /** What each command runs at the committed HEAD. A command a thread would refuse refuses. */
  resolveChecks(payload: Payload<'ResolveRecipeChecks'>): PlanRecipeChecks {
    const root = this.root(payload.projectId);
    refuseCommands(payload.commands, root);
    return { resolved: resolveAtHead(root, this.deps.home, payload.commands) };
  }

  /** Stores the folder the list reads. Nothing moves. */
  setFolder(payload: Payload<'SetRecipeFolder'>) {
    const { projectId, path } = payload;
    const root = this.root(projectId);
    projectFile(
      root,
      path,
      fileRefusal(path, () => folderUnsafe(path)),
      'folder',
    );
    this.deps.store.putRecipeFolder(projectId, path, this.deps.now());
    this.deps.changed(projectId, null);
  }

  /**
   * Writes the file and records the next version. A stale expected version returns the current
   * one. The file goes first: if recording fails after it, the file reads as changed and saving
   * its content records it. A record ahead of its file would name a version nobody can read.
   */
  save(payload: Payload<'SaveRecipe'>): RecipeSaved | { stale: number } {
    const { projectId, path } = payload;
    const { store } = this.deps;
    const root = this.root(projectId);
    const record =
      payload.recipeId === undefined ? undefined : this.record(payload.recipeId, projectId);
    const current = record?.version ?? 0;
    if (payload.expectedVersion !== current) return { stale: current };
    // A case-insensitive disk holds Tidy.json and tidy.json as one file, so they are one path.
    const holder = store
      .recipes(projectId)
      .find((value) => value.path.toLowerCase() === path.toLowerCase());
    if (holder && holder.id !== record?.id)
      throw new RecipeRefused(
        'recipe-path-taken',
        `${path} already holds another recipe. Pick another path.`,
      );
    const recipe = PlanRecipeSchema.parse(payload.body);
    if (recipe.work?.kind === 'checklist' && !this.deps.checklistWork)
      throw switchedOff('checklistWork');
    // A report recipe with a trigger would arm a loop whose every start is refused.
    if (recipe.shape === 'report' && recipe.trigger.kind !== 'manual' && !this.deps.reportRuns)
      throw switchedOff('reportRuns');
    // A once loop whose time has passed would start the moment it is armed. The editor refuses
    // such a time under its field, and another client gets the same answer here.
    if (
      recipe.trigger.kind === 'once' &&
      Date.parse(recipe.trigger.at) <= Date.parse(this.deps.now())
    )
      throw new RecipeRefused(
        'schedule-time-passed',
        "This loop's time has passed. Give it a new time.",
      );
    const commands = recipe.checks.map((check) => check.command);
    refuseCommands(commands, root);
    if (recipe.trigger.kind !== 'manual' && commands.length && payload.seen === undefined)
      throw new RecipeRefused('recipe-checks-unseen', 'Open the review again, then save.');
    const approved =
      recipe.trigger.kind === 'manual'
        ? []
        : approval(resolveAtHead(root, this.deps.home, commands), payload.seen);
    const versionHash = hashCanonical(recipe);
    const refuse = fileRefusal(path, () => pathUnsafe(path));
    const file = projectFile(root, path, refuse);
    let onDisk: string | null | undefined;
    try {
      onDisk = readText(file, refuse);
    } catch (failure) {
      // A file too large to read is someone else's content all the same.
      if (!(failure instanceof RecipeRefused && failure.reason === 'recipe-file-too-large'))
        throw failure;
      onDisk = null;
    }
    if (onDisk !== undefined) {
      const read = onDisk === null ? null : readRecipeFile(onDisk);
      const hash = read && 'recipe' in read ? hashCanonical(read.recipe) : null;
      // The file may hold what was saved last, or exactly what is being saved. Anything else is
      // someone's edit, and writing over it would lose that edit.
      const ours = record?.path === path && hash === record.versionHash;
      if (!ours && hash !== versionHash)
        throw record?.path === path
          ? new RecipeRefused(
              'recipe-file-changed',
              `${path} changed on disk since the last save. Review the file's version first.`,
            )
          : new RecipeRefused(
              'recipe-file-exists',
              `${path} already exists. Open it from the list, or pick another path.`,
            );
    }
    writeAtomically(file, `${JSON.stringify(recipe, null, 2)}\n`, refuse);
    const at = this.deps.now();
    const saved: PlanRecipeRecord = {
      id: record?.id ?? this.deps.id(),
      projectId,
      path,
      version: current + 1,
      versionHash,
      updatedAt: at,
    };
    const previous = record && store.recipeVersion(record.id, record.version)?.recipe;
    store.putRecipe(saved);
    store.putRecipeVersion(saved.id, saved.version, versionHash, recipe, at);
    // A first save with no folder picked shows its own folder from then on. A file at the
    // project's top level names no folder the list could read.
    const folder = posix.dirname(path);
    if (!store.recipeFolder(projectId) && folder !== '.')
      store.putRecipeFolder(projectId, folder, at);
    const schedule = this.deps.armed?.(saved, recipe, approved) ?? null;
    this.deps.changed(projectId, saved.id);
    return { record: saved, changed: changedFields(previous ?? null, recipe), schedule, approved };
  }

  /** Drops the record, its versions and its schedule. The file, runs and results stay. */
  forget(payload: Payload<'ForgetRecipe'>) {
    const record = this.deps.store.recipe(payload.recipeId);
    if (!record) throw notFound();
    if (this.deps.store.recipeRunning(record.id))
      throw new RecipeRefused(
        'recipe-run-active',
        'A run of this recipe is still going or waits on you. Finish or delete it first.',
      );
    this.deps.store.deleteRecipe(record.id);
    this.deps.forgotten?.(record.id);
    this.deps.changed(record.projectId, record.id);
  }

  /** Whether each crew member can take a turn now. Nothing starts. */
  readiness(crew: ChatCrew): RecipeReadiness[] {
    const reasons = this.deps.readiness(crew.members.map((member) => member.selection));
    return crew.members.map(({ role, selection }, index) => {
      const reason = reasons[index] ?? null;
      return { role, family: selection.family, ready: reason === null, reason };
    });
  }

  /** The schedule armed for a recipe, with what the person approved, or null. */
  schedule(recipeId: string): PlanScheduleRecord | null {
    try {
      return this.deps.store.recipeSchedule(recipeId) ?? null;
    } catch (error) {
      // A row this build cannot parse, such as one a newer build wrote, must not hide the recipe.
      // The scheduler logs and skips the same row, so it starts nothing. Any other failure, a
      // database error among them, still goes up.
      if (error instanceof ZodError || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private entry(
    root: string,
    path: string,
    record: PlanRecipeRecord | null,
  ): { entry: PlanRecipeEntry; recipe: PlanRecipe | null } {
    const read = readProjectRecipe(root, path);
    const recipe = 'recipe' in read ? read.recipe : null;
    const file: PlanRecipeFile = recipe
      ? !record
        ? 'unrecorded'
        : hashCanonical(recipe) === record.versionHash
          ? 'current'
          : 'changed'
      : 'missing' in read
        ? 'missing'
        : 'invalid';
    const shown =
      recipe ?? (record && this.deps.store.recipeVersion(record.id, record.version)?.recipe);
    const armed = record && this.schedule(record.id);
    let schedule: PlanSchedule | null = null;
    if (armed) {
      const { approved: _approved, ...rest } = armed;
      schedule = rest;
    }
    return {
      entry: {
        path,
        record,
        file,
        name: shown?.name ?? null,
        description: shown?.description ?? null,
        trigger: shown?.trigger ?? null,
        problem: 'problem' in read ? read.problem : null,
        schedule,
      },
      recipe,
    };
  }

  private record(recipeId: string, projectId: string) {
    const record = this.deps.store.recipe(recipeId);
    if (!record || record.projectId !== projectId) throw notFound();
    return record;
  }

  private root(projectId: string) {
    const root = this.deps.projectPath(projectId);
    if (!root) throw new RecipeRefused('project-not-found', 'Choose a registered project.');
    return root;
  }
}

export function recipesCommand(recipes: Recipes, command: RecipeCommand): CommandResult {
  try {
    switch (command.command) {
      case 'ReadRecipes':
        return {
          outcome: 'applied',
          data: { kind: 'recipes', ...recipes.list(command.payload.projectId) },
        };
      case 'ReadRecipe':
        return { outcome: 'applied', data: { kind: 'recipe', ...recipes.read(command.payload) } };
      case 'ResolveRecipeChecks':
        return {
          outcome: 'applied',
          data: { kind: 'recipe-checks', ...recipes.resolveChecks(command.payload) },
        };
      case 'SetRecipeFolder':
        recipes.setFolder(command.payload);
        return { outcome: 'applied' };
      case 'SaveRecipe': {
        const saved = recipes.save(command.payload);
        return 'stale' in saved
          ? {
              outcome: 'stale-revision',
              revision: saved.stale,
              next: `This recipe was saved again as version ${saved.stale}. Review your changes against it.`,
            }
          : { outcome: 'applied', data: { kind: 'recipe-saved', ...saved } };
      }
      case 'ForgetRecipe':
        recipes.forget(command.payload);
        return { outcome: 'applied' };
    }
  } catch (failure) {
    if (failure instanceof RecipeRefused)
      return { outcome: 'blocked', reason: failure.reason, next: failure.next };
    throw failure;
  }
}

/** A recipe file as JSON, or its first problem with its line. */
export function readRecipeFile(text: string): { recipe: PlanRecipe } | { problem: string } {
  const body = text.replace(/^\uFEFF/, '');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { problem: `Line ${lineAt(body, jsonIndex(body))} is not valid JSON.` };
  }
  const parsed = PlanRecipeSchema.safeParse(value);
  if (parsed.success) return { recipe: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.map(String).join('.');
  const said = `${where ? `${where}: ` : ''}${issue?.message ?? 'Not a recipe.'}`;
  // A key or message from the file may hold control characters. The problem stays one line.
  const clean = said
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .slice(0, 300)
    .toWellFormed()
    .replace(/[^.]$/, '$&.');
  return { problem: `Line ${lineAt(body, jsonIndex(body, issue?.path ?? []))}: ${clean}` };
}

/** What a save changed, by field path. Crew members are keyed by role and checks by command. */
export function changedFields(before: PlanRecipe | null, after: PlanRecipe): string[] {
  const old = recipeFields(before);
  const next = recipeFields(after);
  return [...new Set([...next.keys(), ...old.keys()])]
    .filter((key) => old.get(key) !== next.get(key))
    .map((key) => key.slice(0, 200));
}

function recipeFields(recipe: PlanRecipe | null): Map<string, string> {
  const fields = new Map<string, string>();
  if (!recipe) return fields;
  const walk = (value: unknown, path: string) => {
    if (value === undefined) return;
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
    else fields.set(path, canonicalJson(value));
  };
  const { crew, checks, ...rest } = recipe;
  for (const [key, value] of Object.entries(rest)) walk(value, key);
  walk(crew.name, 'crew.name');
  for (const { role, selection, ...member } of crew.members)
    walk({ ...selection, ...member }, `crew.${role}`);
  for (const { command } of checks) fields.set(`checks.${command}`, 'on');
  return fields;
}

/**
 * What a save with a trigger approves. Every check must resolve, and the person must have seen
 * the same commands with the same digests in the same order, so nothing is approved unseen.
 */
function approval(
  resolved: ResolvedCheck[],
  seen: Payload<'SaveRecipe'>['seen'],
): RecipeApproval[] {
  const approved: RecipeApproval[] = [];
  for (const check of resolved) {
    if (check.resolved === null || check.digest === null)
      throw new RecipeRefused(
        'recipe-check-unresolved',
        `${check.command} resolves to nothing in this project. Fix the command or remove the check.`,
      );
    approved.push({ command: check.command, resolved: check.resolved, digest: check.digest });
  }
  const normal = (command: string) => commandWords(command)?.join(' ') ?? command;
  const shown = seen ?? [];
  if (
    shown.length !== approved.length ||
    approved.some(
      (check, index) =>
        normal(check.command) !== normal(shown[index].command) ||
        check.digest !== shown[index].digest,
    )
  )
    throw new RecipeRefused(
      'recipe-checks-moved',
      'A check changed since you opened this review. Look at it again, then save.',
    );
  return approved;
}

function refuseCommands(commands: readonly string[], root: string) {
  for (const command of commands) {
    const problem = checkCommandProblem(command, root);
    if (problem) throw new RecipeRefused('recipe-check-refused', problem);
  }
}

/** The file a path names, read as a recipe. Any file it cannot read reads as invalid. */
function readProjectRecipe(
  root: string,
  path: string,
): { recipe: PlanRecipe } | { missing: true } | { problem: string | null } {
  let text: string | undefined;
  try {
    const refuse = fileRefusal(path, () => pathUnsafe(path));
    text = readText(projectFile(root, path, refuse), refuse);
  } catch (failure) {
    if (failure instanceof RecipeRefused) return { problem: null };
    throw failure;
  }
  if (text === undefined) return { missing: true };
  return readRecipeFile(text);
}

/** True when two project paths name one file on this disk. */
function sameFile(root: string, a: string, b: string): boolean {
  const first = lstatSync(join(root, a), { throwIfNoEntry: false });
  const second = lstatSync(join(root, b), { throwIfNoEntry: false });
  return !!first && !!second && first.dev === second.dev && first.ino === second.ino;
}

/** The names of the `*.json` files directly in the folder. No link is followed. */
function jsonFiles(root: string, folder: string): string[] {
  let directory: string;
  try {
    directory = projectFile(
      root,
      folder,
      fileRefusal(folder, () => folderUnsafe(folder)),
      'folder',
    );
  } catch (failure) {
    if (failure instanceof RecipeRefused && failure.reason === 'recipe-folder-unsafe') return [];
    throw failure;
  }
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.json') &&
          RecipePathSchema.safeParse(`${folder}/${entry.name}`).success,
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const pathUnsafe = (path: string) =>
  new RecipeRefused(
    'recipe-path-unsafe',
    `${path} is not a plain file inside the project. Pick another path.`,
  );
const folderUnsafe = (path: string) =>
  new RecipeRefused('recipe-folder-unsafe', `${path} is not a folder inside the project.`);

/** A recipe's words for a project file it cannot read or write. */
const fileRefusal =
  (path: string, unsafe: () => RecipeRefused): ProjectFileRefusal =>
  (problem) => {
    switch (problem.kind) {
      case 'folder-unavailable':
        return new RecipeRefused(
          'project-folder-unavailable',
          'The project folder cannot be read.',
        );
      case 'path-unsafe':
        return unsafe();
      case 'too-large':
        return new RecipeRefused('recipe-file-too-large', `${path} is larger than 1 MiB.`);
      case 'write-failed':
        return new RecipeRefused(
          'recipe-write-failed',
          `The file could not be written: ${problem.code}. Nothing was saved.`,
        );
    }
  };
