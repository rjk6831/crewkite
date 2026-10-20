import { globSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { finished } from 'node:stream/promises';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const priority = new Map([
  ['apps/controller/src/store/combined.test.ts', 0],
  ['apps/controller/src/store/controller.test.ts', 1],
]);
const files = [
  ...globSync(
    ['apps/**/*.test.{ts,mjs}', 'packages/**/*.test.{ts,mjs}', 'scripts/**/*.test.{ts,mjs}'],
    {
      exclude: ['**/node_modules/**', '**/out/**', '**/dist/**'],
    },
  ),
].sort(
  (left, right) =>
    (priority.get(left) ?? priority.size) - (priority.get(right) ?? priority.size) ||
    left.localeCompare(right),
);
if (files.length === 0) throw new Error('No repository tests were found.');
const tests = run({ files, concurrency: 3 });
const label = (value, limit) =>
  typeof value === 'string'
    ? Array.from(value.replace(/\p{Cc}/gu, ' ').toWellFormed())
        .slice(0, limit)
        .join('')
    : 'unknown';
const progress = (phase, data) => {
  const path = typeof data.file === 'string' ? relative(process.cwd(), data.file) : '';
  const file =
    path && path !== '..' && !path.startsWith('../') && !isAbsolute(path)
      ? label(path, 240)
      : 'unknown';
  const outcome =
    phase === 'complete'
      ? ` (${data.details?.passed === true ? 'passed' : data.details?.passed === false ? 'failed' : 'unknown'})`
      : '';
  process.stderr.write(`Verification ${phase}: ${file} :: ${label(data.name, 160)}${outcome}\n`);
};
// Execution events remain live while the ordered report waits for an earlier file.
tests.on('test:dequeue', (data) => progress('start', data));
tests.on('test:complete', (data) => progress('complete', data));
tests.on('test:summary', ({ success }) => {
  if (!success) process.exitCode = 1;
});
const report = tests.compose(spec);
report.pipe(process.stdout);
await finished(report);
