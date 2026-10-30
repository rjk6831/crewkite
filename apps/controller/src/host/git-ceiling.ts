import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The folder Git must not search from a scratch copy: the copy's parent. A scratch copy has no
 * `.git` of its own, so a Git command inside it walks up into any repository above the copy, such
 * as a home folder kept as a dotfiles repository. Git compares the ceiling with the resolved
 * working directory, so the parent comes from the copy's real path when the copy exists, and
 * from the real path of its parent folder when it does not exist yet.
 *
 * Git splits the variable at colons, so a folder with a colon in its name cannot be named in it.
 * That case throws a plain line instead of leaving Git without a ceiling.
 */
export class GitCeilingError extends Error {}

export function gitCeiling(copy: string): string {
  const full = resolve(copy);
  let parent: string;
  try {
    parent = dirname(realpathSync.native(full));
  } catch {
    try {
      parent = realpathSync.native(dirname(full));
    } catch {
      parent = dirname(full);
    }
  }
  if (parent.includes(':'))
    throw new GitCeilingError(
      `CrewKite cannot hold Git to the folder ${parent} because its name has a colon. Move the CrewKite home and the project folders to a path without one.`,
    );
  return parent;
}

/** The turn environment for a process that runs in a scratch copy: the source plus the ceiling. */
export function withGitCeiling(environment: NodeJS.ProcessEnv, copy: string): NodeJS.ProcessEnv {
  return { ...environment, GIT_CEILING_DIRECTORIES: gitCeiling(copy) };
}
