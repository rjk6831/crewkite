import {
  type PlanRecipe,
  type PlanRecipeChecks,
  PlanRecipeChecksSchema,
  type PlanRecipeRead,
  PlanRecipeReadSchema,
  type PlanRecipeRun,
  PlanRecipeRunStartedSchema,
  type PlanRecipeRunsRead,
  PlanRecipeRunsReadSchema,
  PlanRecipeSavedSchema,
  type PlanRecipesRead,
  PlanRecipesReadSchema,
  type PlanSchedulesRead,
  PlanSchedulesReadSchema,
  RunRecipePayloadSchema,
  SaveRecipePayloadSchema,
  SetRecipeFolderPayloadSchema,
} from '@crewkite/contracts';
import { dispatch, read, run, type ThreadSource } from '../thread/commands.ts';

// The recipe commands the page sends. A save answers with a value for every outcome, since a
// stale version and a refusal are states the page shows. A save, a run and a folder change are
// parsed with the contract's schemas first, so a payload the form let through wrongly is refused
// with a sentence before it is sent. The other commands send what the controller handed the page,
// and the check read sends only commands of a review that opened, which had no problem line.

type Saved = ReturnType<typeof PlanRecipeSavedSchema.parse>;

export const readRecipes = (source: ThreadSource, projectId: string): Promise<PlanRecipesRead> =>
  read(source, 'ReadRecipes', { projectId }, PlanRecipesReadSchema);

export const readRecipe = (
  source: ThreadSource,
  input: { projectId: string; recipeId?: string; path?: string; version?: number },
): Promise<PlanRecipeRead> => read(source, 'ReadRecipe', input, PlanRecipeReadSchema);

export const resolveRecipeChecks = (
  source: ThreadSource,
  projectId: string,
  commands: string[],
): Promise<PlanRecipeChecks> =>
  read(source, 'ResolveRecipeChecks', { projectId, commands }, PlanRecipeChecksSchema);

export const readRecipeRuns = (
  source: ThreadSource,
  recipeId: string,
): Promise<PlanRecipeRunsRead> =>
  read(source, 'ReadRecipeRuns', { recipeId, limit: 20 }, PlanRecipeRunsReadSchema);

export const readSchedules = (
  source: ThreadSource,
  projectId?: string,
): Promise<PlanSchedulesRead> =>
  read(source, 'ReadSchedules', projectId ? { projectId } : {}, PlanSchedulesReadSchema);

export async function setRecipeFolder(source: ThreadSource, projectId: string, path: string) {
  // The project ID comes from the controller, so a payload that does not parse has a bad path.
  const parsed = SetRecipeFolderPayloadSchema.safeParse({ projectId, path });
  if (!parsed.success) throw new Error('A path inside the project.');
  return run(source, 'SetRecipeFolder', parsed.data);
}

export const forgetRecipe = (source: ThreadSource, recipeId: string) =>
  run(source, 'ForgetRecipe', { recipeId, confirm: 'explicit' });

export const setRecipeSchedule = (
  source: ThreadSource,
  recipeId: string,
  action: 'pause' | 'resume' | 'restart',
) => run(source, 'SetRecipeSchedule', { recipeId, action });

export type RecipeSave =
  | { saved: Saved }
  | { stale: number; next: string }
  | { refused: string; next: string };

/** Only Save version in the review calls this, so `confirm` is always the person's click. */
export async function saveRecipe(
  source: ThreadSource,
  input: {
    projectId: string;
    recipeId?: string;
    path: string;
    body: PlanRecipe;
    expectedVersion: number;
    seen?: { command: string; digest: string }[];
  },
): Promise<RecipeSave> {
  const parsed = SaveRecipePayloadSchema.safeParse({ ...input, confirm: 'explicit' });
  if (!parsed.success)
    return { refused: 'recipe-invalid', next: 'This recipe does not pass its rules yet.' };
  const result = await dispatch(source, 'SaveRecipe', parsed.data);
  if (result.outcome === 'applied' || result.outcome === 'already-applied') {
    const { kind: _kind, ...rest } = (result.data ?? {}) as Record<string, unknown>;
    return { saved: PlanRecipeSavedSchema.parse(rest) };
  }
  if (result.outcome === 'stale-revision' && typeof result.revision === 'number')
    return {
      stale: result.revision,
      next:
        result.next ??
        `This recipe was saved again as version ${result.revision}. Review your changes against it.`,
    };
  return {
    refused: result.reason ?? 'not-saved',
    next: result.next ?? 'The recipe could not be saved.',
  };
}

export type RecipeStart = { run: PlanRecipeRun } | { refused: string; next: string };

export async function runRecipe(
  source: ThreadSource,
  input: { recipeId: string; request: string; versionHash?: string },
): Promise<RecipeStart> {
  const parsed = RunRecipePayloadSchema.safeParse(input);
  if (!parsed.success) return { refused: 'recipe-invalid', next: 'This request cannot be sent.' };
  const result = await dispatch(source, 'RunRecipe', parsed.data);
  if (result.outcome === 'applied' || result.outcome === 'already-applied') {
    const { kind: _kind, ...rest } = (result.data ?? {}) as Record<string, unknown>;
    return PlanRecipeRunStartedSchema.parse(rest);
  }
  return {
    refused: result.reason ?? 'not-started',
    next: result.next ?? 'The run could not start.',
  };
}
