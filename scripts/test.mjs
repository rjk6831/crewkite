import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';

const files = [
  ...globSync(['apps/**/*.test.{ts,mjs}', 'packages/**/*.test.{ts,mjs}', 'scripts/**/*.test.{ts,mjs}'], {
    exclude: ['**/node_modules/**', '**/out/**', '**/dist/**'],
  }),
].sort();
if (files.length === 0) throw new Error('No repository tests were found.');
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
