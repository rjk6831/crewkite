import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CheckResultSchema } from './checks.ts';

// One run is one JSON file. Every task the person asked for appears in it, either as a result or
// as an exclusion with its reason, so a reader can count what was left out.

const count = z.number().int().nonnegative();

const ReviewSchema = z.strictObject({
  state: z.enum(['done', 'stopped', 'failed', 'timed-out']),
  /** The number the reviewer stated on its `Findings: N` line. Null when it stated none. */
  findings: count.nullable(),
  wallMs: count,
  tokensIn: count.nullable(),
  tokensOut: count.nullable(),
  text: z.string().max(20_000),
});

export const TaskResultSchema = z.strictObject({
  taskId: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  /** False when the task carries no verification record and was named by id. */
  verified: z.boolean(),
  outcome: z.enum(['passed', 'failed', 'errored', 'timed-out']),
  turn: z.strictObject({
    state: z.enum(['done', 'stopped', 'failed', 'timed-out', 'not-started']),
    failure: z.strictObject({ kind: z.string(), message: z.string() }).nullable(),
  }),
  wallMs: count,
  /** Null where the client reported nothing. A missing report is never counted as zero. */
  tokensIn: count.nullable(),
  tokensOut: count.nullable(),
  changedFiles: count.nullable(),
  checks: z.array(CheckResultSchema),
  review: ReviewSchema.nullable(),
  /** Filled by hand after a later pass over the accepted changes. Null means not looked at yet. */
  bugsFoundAfter: count.nullable(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const ExclusionSchema = z.strictObject({
  taskId: z.string(),
  reason: z.enum([
    'unverified',
    'unknown-task',
    'repository-missing',
    'commit-missing',
    'family-not-connected',
  ]),
  detail: z.string().max(1000),
});
export type Exclusion = z.infer<typeof ExclusionSchema>;

export const RunReportSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string(),
  startedAt: z.iso.datetime(),
  /** Null while the run is still going. */
  finishedAt: z.iso.datetime().nullable(),
  mode: z.enum(['scripted', 'live']),
  selection: z.strictObject({ family: z.string(), model: z.string(), effort: z.string() }),
  reviewStep: z.boolean(),
  host: z.strictObject({ node: z.string(), platform: z.string(), arch: z.string() }),
  results: z.array(TaskResultSchema),
  exclusions: z.array(ExclusionSchema),
});
export type RunReport = z.infer<typeof RunReportSchema>;

const sum = (values: readonly (number | null)[]) => {
  const known = values.filter((value): value is number => value !== null);
  return {
    total: known.reduce((left, right) => left + right, 0),
    unknown: values.length - known.length,
  };
};

/** Counts that go with every claim made from a run. */
export function summarize(report: RunReport) {
  const outcomes = (name: TaskResult['outcome']) =>
    report.results.filter((result) => result.outcome === name).length;
  return {
    requested: report.results.length + report.exclusions.length,
    ran: report.results.length,
    passed: outcomes('passed'),
    failed: outcomes('failed'),
    errored: outcomes('errored'),
    timedOut: outcomes('timed-out'),
    excluded: report.exclusions.length,
    wallMs: report.results.reduce((total, result) => total + result.wallMs, 0),
    tokensIn: sum(report.results.map((result) => result.tokensIn)),
    tokensOut: sum(report.results.map((result) => result.tokensOut)),
  };
}

const cell = (value: string | number | null, unknown = 'unknown') =>
  value === null ? unknown : String(value).replace(/\|/g, '/').replace(/\s+/g, ' ');
const seconds = (ms: number) => (ms / 1000).toFixed(1);

export function renderMarkdown(report: RunReport): string {
  const { family, model, effort } = report.selection;
  const total = summarize(report);
  const lines = [
    `# Bench run ${report.runId}`,
    '',
    `Family ${family}, model ${model}, effort ${effort}. Mode ${report.mode}. Started ${report.startedAt}${report.finishedAt ? '' : ', still running'}. Review step ${report.reviewStep ? 'on' : 'off'}.`,
    '',
    '| Task | Difficulty | Outcome | Checks passed | Wall s | Tokens in | Tokens out | Review findings | Bugs found after |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.results
      .map((result) =>
        [
          result.verified ? result.taskId : `${result.taskId} (unverified)`,
          result.difficulty,
          result.outcome,
          `${result.checks.filter((check) => check.passed).length}/${result.checks.length}`,
          seconds(result.wallMs),
          cell(result.tokensIn),
          cell(result.tokensOut),
          result.review ? cell(result.review.findings) : 'no review',
          cell(result.bugsFoundAfter, 'not checked'),
        ].join(' | '),
      )
      .map((row) => `| ${row} |`),
    '',
    `Requested ${total.requested}, ran ${total.ran}, passed ${total.passed}, failed ${total.failed}, errored ${total.errored}, timed out ${total.timedOut}, excluded ${total.excluded}.`,
    `Tokens in ${total.tokensIn.total} known and ${total.tokensIn.unknown} unknown. Tokens out ${total.tokensOut.total} known and ${total.tokensOut.unknown} unknown. Wall time ${seconds(total.wallMs)} s.`,
  ];
  const failures = report.results.filter((result) => result.turn.failure);
  if (failures.length > 0)
    lines.push(
      '',
      '## Failures',
      '',
      '| Task | Kind | Message |',
      '| --- | --- | --- |',
      ...failures.map(
        (result) =>
          `| ${result.taskId} | ${cell(result.turn.failure?.kind ?? null)} | ${cell(result.turn.failure?.message ?? null)} |`,
      ),
    );
  if (report.exclusions.length > 0)
    lines.push(
      '',
      '## Exclusions',
      '',
      '| Task | Reason | Detail |',
      '| --- | --- | --- |',
      ...report.exclusions.map(
        (item) => `| ${item.taskId} | ${item.reason} | ${cell(item.detail)} |`,
      ),
    );
  return `${lines.join('\n')}\n`;
}

/** Writes the run's JSON file and its table, named by run id, and returns both paths. */
export function writeRun(directory: string, report: RunReport): { json: string; markdown: string } {
  mkdirSync(directory, { recursive: true });
  const json = join(directory, `${report.runId}.json`);
  const markdown = join(directory, `${report.runId}.md`);
  writeFileSync(json, `${JSON.stringify(RunReportSchema.parse(report), null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}
