import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CheckResult, checkEnvironment, runChecks } from './checks.ts';
import type { Task, Verification } from './manifest.ts';
import {
  exportCommit,
  hasCommit,
  linkDependencies,
  placeHidden,
  repositoryOf,
} from './workspace.ts';

export type VerifyOutcome = {
  taskId: string;
  ok: boolean;
  /** Why the task did not verify. Null when it did. */
  reason: string | null;
  failedOnBase: string[];
  /** Null when no check failed on the base. */
  baseFailure: 'assertion' | 'missing-module' | null;
  passedOnSolution: string[];
  base: CheckResult[];
  solution: CheckResult[];
};

export const VERIFY_METHOD =
  'The checks ran in a clean export of the base commit with the hidden files from the solution commit in place, and had to fail. They then ran in a clean export of the solution commit, and had to pass. Installed dependencies were linked from the checkout, and the checks ran with a minimal environment and a temporary home.';

/**
 * A task is verified when its checks fail on the base commit and pass on the solution commit.
 * Both runs happen in fresh exports, so nothing from the checkout's working tree leaks in.
 */
export async function verifyTask(
  task: Task,
  options: { self: string; now?: () => number; path?: string },
): Promise<VerifyOutcome> {
  const outcome: VerifyOutcome = {
    taskId: task.id,
    ok: false,
    reason: null,
    failedOnBase: [],
    baseFailure: null,
    passedOnSolution: [],
    base: [],
    solution: [],
  };
  const repository = repositoryOf(task, options.self);
  if (!task.solution) return { ...outcome, reason: 'The task names no solution commit.' };
  for (const [label, commit] of [
    ['base', task.base],
    ['solution', task.solution],
  ] as const)
    if (!hasCommit(repository, commit))
      return { ...outcome, reason: `The ${label} commit ${commit} is not in ${repository}.` };
  const directory = mkdtempSync(join(tmpdir(), 'bench-verify-'));
  try {
    const base = join(directory, 'base');
    exportCommit(repository, task.base, base);
    placeHidden(repository, task.solution, task.hidden, base);
    linkDependencies(repository, base);
    const environment = checkEnvironment(directory, undefined, options.path);
    const now = options.now ?? Date.now;
    outcome.base = await runChecks(base, task.checks, now, environment);
    const solution = join(directory, 'solution');
    exportCommit(repository, task.solution, solution);
    linkDependencies(repository, solution);
    outcome.solution = await runChecks(solution, task.checks, now, environment);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const failed = outcome.base.filter((check) => !check.passed);
  outcome.failedOnBase = failed.map((check) => check.name);
  // A task counts as missing-module only when every failing check failed before it could run.
  if (failed.length > 0)
    outcome.baseFailure = failed.every((check) => check.missingModule)
      ? 'missing-module'
      : 'assertion';
  outcome.passedOnSolution = outcome.solution
    .filter((check) => check.passed)
    .map((check) => check.name);
  if (outcome.failedOnBase.length === 0)
    outcome.reason = 'No check failed on the base commit, so the checks do not prove the task.';
  else if (outcome.passedOnSolution.length !== task.checks.length)
    outcome.reason = 'A check failed on the solution commit.';
  outcome.ok = outcome.reason === null;
  return outcome;
}

export const verificationRecord = (outcome: VerifyOutcome, at: string): Verification => {
  if (!outcome.baseFailure)
    throw new Error('A task that failed nowhere on the base has no record.');
  return {
    method: VERIFY_METHOD,
    verifiedAt: at,
    node: process.version,
    failedOnBase: outcome.failedOnBase,
    baseFailure: outcome.baseFailure,
    passedOnSolution: outcome.passedOnSolution,
  };
};
