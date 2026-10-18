import { globSync } from 'node:fs';
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
tests.on('test:summary', ({ success }) => {
  if (!success) process.exitCode = 1;
});
const report = tests.compose(spec);
report.pipe(process.stdout);
await finished(report);
