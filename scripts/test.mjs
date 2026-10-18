import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';

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
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=3', ...files], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
