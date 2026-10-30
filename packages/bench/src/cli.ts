import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ChatEffortSchema, ChatFamilySchema } from '@crewkite/contracts';
import { loadTasks, type Task } from './manifest.ts';
import { type RunReport, RunReportSchema, renderMarkdown, summarize, writeRun } from './report.ts';
import { runBench, selectTasks } from './runner.ts';
import { oraclePlan } from './scripted.ts';
import { verificationRecord, verifyTask } from './verify.ts';

const SELF = resolve(import.meta.dirname, '../../..');
const DEFAULT_TASKS = resolve(import.meta.dirname, '../tasks');

export const usage = `Usage: pnpm bench --family <family> --model <id> --effort <effort> --tasks <ids|all> [options]
       pnpm bench verify [--tasks <ids|all>] [--write]
       pnpm bench report <run.json>

Run options:
  --review                 run a review turn after each finished task and record its findings
  --scripted               use the scripted adapter that writes each task's solution (no provider)
  --timeout-minutes <n>    limit for one work turn, default 30
  --out <folder>           where run files go, default internal/bench
  --keep                   keep the work folder, with each task's scratch copy and check copy
Every command takes --tasks-dir <folder> more than once to add task folders. The default folder is
packages/bench/tasks. A live run uses the clients installed on this machine through the normal
adapters. Task files, run files and the table are described in docs/bench.md.
`;

class UsageError extends Error {}

function load(folders: readonly string[]): Task[] {
  const tasks = folders.flatMap((folder) => loadTasks(folder));
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new UsageError(`Task id ${task.id} appears in two folders.`);
    seen.add(task.id);
  }
  return tasks;
}

const spec = (value: string | undefined): 'all' | string[] => {
  if (!value) throw new UsageError('Give --tasks as a comma separated list of ids, or all.');
  return value === 'all'
    ? 'all'
    : value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
};

const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '');

export async function main(
  args: string[],
  log: (line: string) => void = console.log,
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        family: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        tasks: { type: 'string' },
        review: { type: 'boolean' },
        scripted: { type: 'boolean' },
        write: { type: 'boolean' },
        keep: { type: 'boolean' },
        out: { type: 'string' },
        'tasks-dir': { type: 'string', multiple: true },
        'timeout-minutes': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      log(usage);
      return 0;
    }
    const folders = (values['tasks-dir'] ?? []).map((folder) => resolve(folder));
    const all = load([DEFAULT_TASKS, ...folders]);
    const [command] = positionals;

    if (command === 'report') {
      const file = positionals[1];
      if (!file) throw new UsageError('Give the run file to render.');
      const report = RunReportSchema.parse(JSON.parse(readFileSync(resolve(file), 'utf8')));
      writeFileSync(resolve(file).replace(/\.json$/, '.md'), renderMarkdown(report));
      log(`Wrote ${resolve(file).replace(/\.json$/, '.md')}`);
      return 0;
    }

    if (command === 'verify') {
      const wanted = values.tasks ? spec(values.tasks) : 'all';
      const named = wanted === 'all' ? all : selectTasks(all, wanted).tasks;
      let failed = wanted === 'all' ? 0 : wanted.length - named.length;
      if (failed > 0) log(`${failed} named task ids have no file.`);
      for (const task of named) {
        const outcome = await verifyTask(task, { self: SELF });
        log(
          outcome.ok
            ? `${task.id}: verified (failed on base: ${outcome.failedOnBase.join(', ')})`
            : `${task.id}: NOT verified. ${outcome.reason}`,
        );
        if (!outcome.ok) {
          failed += 1;
          continue;
        }
        if (values.write) {
          const file = [DEFAULT_TASKS, ...folders]
            .map((folder) => join(folder, `${task.id}.json`))
            .find((path) => {
              try {
                readFileSync(path);
                return true;
              } catch {
                return false;
              }
            });
          if (!file) continue;
          const raw = JSON.parse(readFileSync(file, 'utf8'));
          raw.verification = verificationRecord(outcome, new Date().toISOString());
          writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
        }
      }
      return failed === 0 ? 0 : 1;
    }

    if (command) throw new UsageError(`Unknown command ${command}.`);
    const family = ChatFamilySchema.safeParse(values.family);
    if (!family.success)
      throw new UsageError(`Give --family as one of ${ChatFamilySchema.options.join(', ')}.`);
    const model = values.model ?? (values.scripted ? 'model-a' : undefined);
    if (!model) throw new UsageError('Give --model.');
    const effort = ChatEffortSchema.safeParse(
      values.effort ?? (values.scripted ? 'default' : undefined),
    );
    if (!effort.success)
      throw new UsageError(`Give --effort as one of ${ChatEffortSchema.options.join(', ')}.`);
    const minutes = Number(values['timeout-minutes'] ?? 30);
    if (!Number.isFinite(minutes) || minutes <= 0)
      throw new UsageError('Give --timeout-minutes as a positive number.');

    const picked = selectTasks(all, spec(values.tasks));
    const out = resolve(values.out ?? join(SELF, 'internal/bench'));
    const startedAt = Date.now();
    const runId = `${stamp(startedAt)}-${family.data}-${slug(model)}-${effort.data}`;
    const write = (report: RunReport) => void writeRun(out, report);
    const report = await runBench({
      self: SELF,
      workDirectory: join(out, 'work', runId),
      selection: { family: family.data, model, effort: effort.data },
      tasks: picked.tasks,
      exclusions: picked.exclusions,
      review: values.review === true,
      ...(values.scripted ? { scripted: oraclePlan(SELF) } : {}),
      timeoutMs: minutes * 60_000,
      runId,
      now: Date.now,
      keepWork: values.keep === true,
      onProgress: write,
    });
    write(report);
    const total = summarize(report);
    log(
      `${runId}: ran ${total.ran} of ${total.requested}, passed ${total.passed}, excluded ${total.excluded}. Files are in ${out}.`,
    );
    return total.ran === 0 ? 1 : 0;
  } catch (error) {
    if (
      error instanceof UsageError ||
      (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      console.error(`${(error as Error).message}\n\n${usage}`);
      return 2;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
