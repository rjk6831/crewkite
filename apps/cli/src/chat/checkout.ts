import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { ProjectPage } from '@crewkite/contracts';
import { applied, type ChatClient } from './client.ts';

// Which registered project the shell is in. pnpm runs scripts from the package root and keeps the
// caller's directory in INIT_CWD, so that comes first. Git runs with every GIT_ variable removed,
// so a GIT_DIR or GIT_WORK_TREE from the caller cannot point it elsewhere.

/** The directory the person ran the command in. */
export const callerDirectory = (env: NodeJS.ProcessEnv, cwd: string) => env.INIT_CWD || cwd;

/** The environment for read-only git calls: no GIT_ variable, no optional locks. */
export function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env))
    if (!name.startsWith('GIT_')) clean[name] = value;
  return { ...clean, GIT_OPTIONAL_LOCKS: '0' };
}

function git(directory: string, env: NodeJS.ProcessEnv, args: string[]): string | null {
  const found = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10_000,
    env: gitEnvironment(env),
  });
  return found.status === 0 ? found.stdout.trim() : null;
}

export type Checkout = { root: string; base: string; branch: string };

/** The Git checkout around `directory`, its HEAD commit and branch, or null outside one. */
export function checkoutAt(directory: string, env: NodeJS.ProcessEnv): Checkout | null {
  const top = git(directory, env, ['rev-parse', '--show-toplevel']);
  const base = top ? git(top, env, ['rev-parse', '--verify', 'HEAD^{commit}']) : null;
  if (!top || !base) return null;
  return {
    root: realpathSync(top),
    base,
    branch: git(top, env, ['symbolic-ref', '--quiet', '--short', 'HEAD']) ?? 'detached',
  };
}

/**
 * The registered projects that are this checkout. The controller does not hand out project
 * paths, so a project matches when its folder name, HEAD commit and branch, read through
 * InspectSource, are the checkout's. Nothing is registered here.
 */
export async function projectsForCheckout(
  client: ChatClient,
  checkout: Checkout,
  projects?: ProjectPage['projects'],
): Promise<ProjectPage['projects']> {
  const named = (projects ?? (await client.listProjects())).filter(
    (project) => project.name === basename(checkout.root),
  );
  const matching: ProjectPage['projects'] = [];
  for (const project of named) {
    const result = await client.send('InspectSource', { projectId: project.id });
    const source = (result.data as { source?: { base: string; branch: string } } | undefined)
      ?.source;
    if (applied(result) && source?.base === checkout.base && source.branch === checkout.branch)
      matching.push(project);
  }
  return matching;
}
