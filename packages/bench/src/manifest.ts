import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

// One task is one JSON file. The schema is the only description of the format, and the loader
// refuses a file that does not match it, so a malformed task never reaches a run.

const commit = z.string().regex(/^[0-9a-f]{40}$/, 'Use a full 40 character commit hash.');

/** A path inside the repository, written with forward slashes and no way out of the copy. */
const relativePath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (path) =>
      !isAbsolute(path) &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Use a relative path inside the repository.',
  );

export const CheckSchema = z.strictObject({
  name: z.string().min(1).max(80),
  /** A program name or path. It runs without a shell, so a pipe or a redirect is not available. */
  command: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !/\s/.test(value), 'Put arguments in args, not in command.'),
  args: z.array(z.string().max(500)).max(40).default([]),
  timeoutMs: z.number().int().min(1000).max(1_800_000).default(300_000),
});
export type Check = z.infer<typeof CheckSchema>;

/** How a task was proved solvable. `bench verify` writes it, and nothing else should. */
export const VerificationSchema = z.strictObject({
  method: z.string().min(1).max(600),
  verifiedAt: z.iso.datetime(),
  node: z.string().min(1).max(40),
  /** Checks that failed on the base commit with the hidden files in place. */
  failedOnBase: z.array(z.string().min(1).max(80)).min(1).max(8),
  /**
   * Why the checks failed on the base. A missing module means the hidden test imports a module or
   * an export that the change adds, so the base fails to load it and no assertion about behavior
   * ran. An assertion means the test ran and its claim did not hold.
   */
  baseFailure: z.enum(['assertion', 'missing-module']),
  /** Checks that passed on the solution commit. */
  passedOnSolution: z.array(z.string().min(1).max(80)).min(1).max(8),
});
export type Verification = z.infer<typeof VerificationSchema>;

// A task text states the intent. A pasted patch would hand over the answer.
const DIFF_LINE = /^(diff --git |@@ -\d|\+\+\+ [ab/]|--- [ab/])/m;

export const TaskSchema = z
  .strictObject({
    id: z
      .string()
      .min(3)
      .max(60)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower case words joined by hyphens.'),
    title: z.string().min(3).max(120),
    /** `self` is the checkout the harness runs from. Otherwise an absolute path on this machine. */
    repository: z
      .union([
        z.literal('self'),
        z
          .string()
          .refine(
            (path) => isAbsolute(path) && !path.includes('\0'),
            'Use `self` or an absolute path.',
          ),
      ])
      .default('self'),
    /** The commit the model starts from. */
    base: commit,
    /** The commit that solves the task. Needed to verify the task and to supply the hidden files. */
    solution: commit.optional(),
    /** What the person asks for. It describes the intent and never quotes a diff. */
    text: z
      .string()
      .min(20)
      .max(4000)
      .refine((value) => !DIFF_LINE.test(value), 'The task text must not quote a diff.'),
    /** Files taken from the solution commit and placed in the copy before the checks run. */
    hidden: z.array(relativePath).max(20).default([]),
    checks: z.array(CheckSchema).min(1).max(8),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    tags: z
      .array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/))
      .max(8)
      .default([]),
    verification: VerificationSchema.optional(),
  })
  .superRefine((task, context) => {
    if (task.hidden.length > 0 && !task.solution)
      context.addIssue({
        code: 'custom',
        path: ['solution'],
        message: 'Hidden files come from the solution commit, so name it.',
      });
    if (task.verification && !task.solution)
      context.addIssue({
        code: 'custom',
        path: ['verification'],
        message: 'A verified task names its solution commit.',
      });
    if (new Set(task.checks.map((check) => check.name)).size !== task.checks.length)
      context.addIssue({ code: 'custom', path: ['checks'], message: 'Check names must differ.' });
  });
export type Task = z.infer<typeof TaskSchema>;

/** Reads every `*.json` file in a directory, in name order. The first bad file stops the load. */
export function loadTasks(directory: string): Task[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const tasks = names.map((name) => {
    const parsed = TaskSchema.safeParse(JSON.parse(readFileSync(join(directory, name), 'utf8')));
    if (!parsed.success)
      throw new Error(`${name} is not a valid task: ${z.prettifyError(parsed.error)}`);
    if (`${parsed.data.id}.json` !== name)
      throw new Error(`${name} must be named ${parsed.data.id}.json.`);
    return parsed.data;
  });
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`Task id ${task.id} appears twice.`);
    seen.add(task.id);
  }
  return tasks;
}

/** Verified means a recorded proof exists. A task without one runs only when it is named. */
export const isVerified = (task: Task) => task.verification !== undefined;
