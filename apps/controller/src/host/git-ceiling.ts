import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The folder Git must not search from a scratch copy: the copy's parent. A scratch copy has no
 * `.git` of its own, so a Git command inside it walks up into any repository above the copy, such
 * as a home folder kept as a dotfiles repository. Git compares the ceiling with the resolved
 * working directory, so the parent is resolved too.
 */
export function gitCeiling(copy: string): string {
  const parent = dirname(resolve(copy));
  try {
    return realpathSync.native(parent);
  } catch {
    return parent;
  }
}

/** The turn environment for a process that runs in a scratch copy: the source plus the ceiling. */
export function withGitCeiling(environment: NodeJS.ProcessEnv, copy: string): NodeJS.ProcessEnv {
  return { ...environment, GIT_CEILING_DIRECTORIES: gitCeiling(copy) };
}
