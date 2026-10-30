import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Check } from './manifest.ts';

export const CheckResultSchema = z.strictObject({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  passed: z.boolean(),
  /** Null when the process was killed or never started. */
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  /** The end of the combined output, with control characters removed. */
  tail: z.string(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

const TAIL = 2000;

const printable = (text: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: output from a child is sanitized here
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');

/** The harness environment without the marker that makes a child `node --test` act as a subtest. */
function checkEnvironment(): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _context, ...rest } = process.env;
  return rest;
}

/**
 * Runs each check in `directory`, in order, without a shell. A check that cannot start counts as
 * failed with the reason in its tail. `node` means the Node that runs the harness.
 */
export async function runChecks(
  directory: string,
  checks: readonly Check[],
  now: () => number = Date.now,
  environment: NodeJS.ProcessEnv = checkEnvironment(),
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const started = now();
    const outcome = await new Promise<{ code: number | null; timedOut: boolean; output: string }>(
      (resolve) => {
        let output = '';
        let timedOut = false;
        const child = spawn(
          check.command === 'node' ? process.execPath : check.command,
          check.args,
          {
            cwd: directory,
            env: environment,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        const keep = (chunk: Buffer) => {
          output = `${output}${chunk.toString('utf8')}`.slice(-TAIL * 4);
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const timer = setTimeout(() => {
          timedOut = true;
          // A negative pid signals the whole group, so a test runner's children stop too.
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        }, check.timeoutMs);
        child.once('error', (error) => {
          clearTimeout(timer);
          resolve({ code: null, timedOut: false, output: `Could not start: ${error.message}` });
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve({ code, timedOut, output });
        });
      },
    );
    results.push({
      name: check.name,
      command: check.command,
      args: check.args,
      passed: outcome.code === 0 && !outcome.timedOut,
      exitCode: outcome.code,
      timedOut: outcome.timedOut,
      durationMs: Math.max(0, Math.round(now() - started)),
      tail: printable(outcome.output).slice(-TAIL),
    });
  }
  return results;
}
