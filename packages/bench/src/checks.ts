import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  /** True when the output said a module or an export could not be found, anywhere in the run. */
  missingModule: z.boolean(),
  /** The end of the combined output, with control characters removed. */
  tail: z.string(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

const TAIL = 2000;

const printable = (text: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: output from a child is sanitized here
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');

// Text Node prints when an import cannot be resolved. A check that fails this way fails because
// the change adds the module or the export, and no assertion about behavior ran.
const MISSING_MODULE =
  /ERR_MODULE_NOT_FOUND|does not provide an export named|Cannot find module|Cannot find package/;

/**
 * The environment a check runs in. It holds the PATH of the harness, a home and a temporary folder
 * made for this run, and the ceiling that stops git from climbing out of `directory`. Provider
 * keys, NODE_OPTIONS and every other variable of the person's shell stay out. A check still runs
 * unsandboxed with the person's file permissions.
 */
export function checkEnvironment(
  workFolder: string,
  ceiling?: string,
  path: string | undefined = process.env.PATH,
): NodeJS.ProcessEnv {
  const home = join(workFolder, 'check-home');
  const temporary = join(workFolder, 'check-tmp');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  return {
    PATH: path ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: temporary,
    LANG: 'C',
    ...(ceiling ? { GIT_CEILING_DIRECTORIES: ceiling } : {}),
  };
}

/**
 * Runs each check in `directory`, in order, without a shell. A check that cannot start counts as
 * failed with the reason in its tail. `node` means the Node that runs the harness.
 */
export async function runChecks(
  directory: string,
  checks: readonly Check[],
  now: () => number,
  environment: NodeJS.ProcessEnv,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const started = now();
    const outcome = await new Promise<{
      code: number | null;
      timedOut: boolean;
      output: string;
      missing: boolean;
    }>((resolve) => {
      let output = '';
      let missing = false;
      let timedOut = false;
      const child = spawn(check.command === 'node' ? process.execPath : check.command, check.args, {
        cwd: directory,
        env: environment,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const keep = (chunk: Buffer) => {
        // The window starts 200 characters back, so a line split across two chunks still matches.
        const text = chunk.toString('utf8');
        if (MISSING_MODULE.test(`${output.slice(-200)}${text}`)) missing = true;
        output = `${output}${text}`.slice(-TAIL * 4);
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
        resolve({
          code: null,
          timedOut: false,
          output: `Could not start: ${error.message}`,
          missing: false,
        });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut, output, missing });
      });
    });
    results.push({
      name: check.name,
      command: check.command,
      args: check.args,
      passed: outcome.code === 0 && !outcome.timedOut,
      exitCode: outcome.code,
      timedOut: outcome.timedOut,
      durationMs: Math.max(0, Math.round(now() - started)),
      missingModule: outcome.missing,
      tail: printable(outcome.output).slice(-TAIL),
    });
  }
  return results;
}
