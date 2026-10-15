import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { devNull } from 'node:os';
import { join, resolve } from 'node:path';

const baseline = `export function netMinor() {
  throw new Error('netMinor is not implemented.');
}
`;
const solution = `export function netMinor(subtotalMinor, discountMinor) {
  if (![subtotalMinor, discountMinor].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new RangeError('Amounts must be non-negative safe integers.');
  }
  return Math.max(0, subtotalMinor - discountMinor);
}
`;
const cli = `import { netMinor } from './net.mjs';
const args = process.argv.slice(2);
try {
  if (args.length !== 2 || args.some((value) => !/^\\d+$/.test(value))) {
    throw new Error('Provide subtotal and discount as integer minor amounts.');
  }
  console.log(JSON.stringify({ netMinor: netMinor(...args.map(Number)) }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`;
const checks = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { netMinor } from './net.mjs';

test('discounts clamp at the subtotal', () => {
  for (const [subtotal, discount, expected] of [[3000, 500, 2500], [3000, 4000, 0], [0, 0, 0], [Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER]]) {
    assert.equal(netMinor(subtotal, discount), expected);
  }
});

test('amounts reject negative fractional and unsafe integers', () => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '3000']) {
    assert.throws(() => netMinor(value, 0));
    assert.throws(() => netMinor(3000, value));
  }
});
`;
const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo shop</title>
<h1>Net amount</h1>
<form id="amounts">
  <label>Subtotal in minor units <input name="subtotal" type="number" min="0" step="1" required></label>
  <label>Discount in minor units <input name="discount" type="number" min="0" step="1" required></label>
  <button>Calculate</button>
</form>
<output id="result" aria-live="polite"></output>
<script type="module">
import { netMinor } from './net.mjs';
document.querySelector('#amounts').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const output = document.querySelector('#result');
  try {
    output.textContent = String(netMinor(Number(form.get('subtotal')), Number(form.get('discount'))));
  } catch (error) {
    output.textContent = error.message;
  }
});
</script>
</html>
`;

export function writeChallengeSolution(directory: string) {
  const root = resolve(directory);
  const rootState = lstatSync(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new Error('Scratch root must be a directory.');
  }
  const destination = join(root, 'net.mjs');
  const file = openSync(destination, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const state = fstatSync(file);
    if (!state.isFile() || state.nlink !== 1) {
      throw new Error('Challenge source must be an independent regular file.');
    }
    ftruncateSync(file, 0);
    writeFileSync(file, solution);
  } finally {
    closeSync(file);
  }
  return ['net.mjs'];
}

export function createSyntheticRepository(directory: string) {
  const root = resolve(directory);
  try {
    mkdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (
      !lstatSync(root).isDirectory() ||
      lstatSync(root).isSymbolicLink() ||
      readdirSync(root).length
    ) {
      throw new Error('Synthetic repository needs a new or empty directory.');
    }
  }
  const environment = {
    PATH: process.env.PATH,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_AUTHOR_NAME: 'CrewKite fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'CrewKite fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-10-15T17:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-15T17:00:00Z',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8' });
  mkdirSync(join(root, 'sentinels'));
  const files = {
    'net.mjs': baseline,
    'cli.mjs': cli,
    'index.html': page,
    'net.test.mjs': checks,
    'sentinels/staged.txt': 'committed staged sentinel\n',
    'sentinels/unstaged.txt': 'committed unstaged sentinel\n',
    'sentinels/binary.bin': Buffer.from([0, 255, 1, 128, 0, 42]),
    'sentinels/executable.sh': '#!/bin/sh\nexit 0\n',
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  chmodSync(join(root, 'sentinels/executable.sh'), 0o755);
  git('init', '--initial-branch=main', '--quiet');
  git('add', '--', ...Object.keys(files));
  git(
    'commit',
    '-s',
    '--quiet',
    '-m',
    'test: seed the minor amount challenge',
    '-m',
    'Keep source sentinels separate from the challenge so source preservation can be checked.',
  );
  const base = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(root, 'sentinels/staged.txt'), 'staged changes must survive\n');
  git('add', '--', 'sentinels/staged.txt');
  writeFileSync(join(root, 'sentinels/unstaged.txt'), 'unstaged changes must survive\n');
  writeFileSync(join(root, 'sentinels/untracked.txt'), 'untracked changes must survive\n');
  const sentinels = [
    ...Object.keys(files).filter((path) => path.startsWith('sentinels/')),
    'sentinels/untracked.txt',
  ].map((path) => ({
    path,
    hash: createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex'),
    mode: lstatSync(join(root, path)).mode & 0o777,
  }));
  return {
    directory: root,
    base,
    branch: 'main',
    sentinels,
    status: git('status', '--porcelain=v1', '-z'),
    index: git('ls-files', '--stage', '-z'),
  };
}
