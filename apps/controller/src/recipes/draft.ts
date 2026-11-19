import {
  type CommandResult,
  type PlanRecipe,
  PlanRecipeCheckSchema,
  type PlanRecipeDraft,
  PlanRecipeSchema,
} from '@crewkite/contracts';
import { enabledChecks } from '../chat/checks.ts';
import type { Store } from '../store/index.ts';
import { RecipeRefused } from './service.ts';

/**
 * A recipe body from what a finished plan thread holds. The thread keeps its crew, flight mode,
 * permission policy, handoff settings and enabled checks as they stand now, and its plan card
 * keeps the slices. A Manual thread runs no plan, so a recipe from it takes Balanced and says
 * so. Nothing is saved: the person reviews the draft, names it and saves it.
 */
export function draftRecipe(store: Store, taskId: string): PlanRecipeDraft {
  const task = store.get<{ id: string; title: string }>('task', taskId);
  if (!task) throw new RecipeRefused('task-not-found', 'Choose a registered task.');
  const thread = store.chatThread(taskId);
  const crew = thread?.crew;
  const noPlan = () =>
    new RecipeRefused('recipe-no-plan', 'This thread has no finished plan to save.');
  if (
    !thread ||
    !crew ||
    thread.plan?.phase !== 'finished' ||
    !crew.members.some((member) => member.role === 'orchestrator') ||
    !crew.members.some((member) => member.role === 'builder')
  )
    throw noPlan();
  const defaults: string[] = [];
  const manual = thread.flightMode === 'manual';
  if (manual) defaults.push('Flight mode: Balanced');
  const flightMode: PlanRecipe['run']['flightMode'] =
    thread.flightMode === 'glide' ? 'glide' : 'balanced';
  // A check the recipe cannot hold stays out, so the rest of the draft still saves.
  const checks = enabledChecks(thread).flatMap((check) => {
    if (PlanRecipeCheckSchema.safeParse({ command: check.command }).success)
      return [{ command: check.command }];
    defaults.push('Check: one command is longer than a recipe holds and was left out.');
    return [];
  });
  const name = title(task.title);
  if (!name) defaults.push('Name: Recipe');
  const recipe = PlanRecipeSchema.parse({
    schema: 1,
    name: name || 'Recipe',
    description: '',
    shape: 'change',
    crew,
    run: {
      flightMode,
      permissionPolicy: thread.permissionPolicy,
      handoff: { auto: thread.autoHandoff, mode: thread.handoffMode },
      maxSlices: thread.plan.slices.length,
    },
    checks,
    trigger: { kind: 'manual' },
    budget: null,
    work: null,
  });
  return { recipe, defaults };
}

/** The thread title as a recipe name: one line, at most 80 characters. */
function title(text: string): string {
  return text
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .trim()
    .slice(0, 80)
    .toWellFormed()
    .trim();
}

export function draftCommand(store: Store, payload: { taskId: string }): CommandResult {
  try {
    return {
      outcome: 'applied',
      data: { kind: 'recipe-draft', ...draftRecipe(store, payload.taskId) },
    };
  } catch (failure) {
    if (failure instanceof RecipeRefused)
      return { outcome: 'blocked', reason: failure.reason, next: failure.next };
    throw failure;
  }
}
