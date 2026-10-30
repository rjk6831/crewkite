import { execFileSync } from 'node:child_process';

// Every project, thread and acceptance step runs git, so the controller asks whether it can.
// Without this, a computer with no git reports a ready controller and a project folder that is
// "not a readable repository".

export type GitState = 'ready' | 'missing' | 'broken';

const PROBE_MS = 5_000;

/**
 * Runs `git --version` as a direct child that is killed after PROBE_MS. A launch that fails with
 * ENOENT means git is not on the path. Any other failure, a non-zero exit or a timeout means it
 * is there and does not run.
 */
export function detectGit(path: string | undefined = process.env.PATH): GitState {
  try {
    execFileSync('git', ['--version'], {
      env: { PATH: path, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4096,
      timeout: PROBE_MS,
      killSignal: 'SIGKILL',
    });
    return 'ready';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'broken';
  }
}

const RETRY_MS = 30_000;

/**
 * A reader of the git state. A working git is kept for good. A failure is kept for about 30
 * seconds, so installing git or fixing the path shows up without restarting the controller.
 */
export function cachedGitState(
  detect: () => GitState = detectGit,
  now: () => number = Date.now,
): () => GitState {
  let found: { state: GitState; at: number } | undefined;
  return () => {
    if (!found || (found.state !== 'ready' && now() - found.at >= RETRY_MS))
      found = { state: detect(), at: now() };
    return found.state;
  };
}

/** The answer for this process. */
export const gitState = cachedGitState();

/** The sentence health and a refused project registration give, or null when git runs. */
export const gitProblem = (state: GitState): string | null =>
  state === 'missing' ? 'git was not found' : state === 'broken' ? 'git failed to run' : null;
