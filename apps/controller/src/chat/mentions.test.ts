import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { instructionFileNames } from '../providers/instruction-files.ts';
import { createMentionIndex, readInstructions } from './mentions.ts';

const [agents, linked, , rules] = instructionFileNames;

function scratch(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'crewkite-mentions-'));
  const copy = join(root, 'scratch');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    writeFileSync(join(copy, path), text);
  }
  return { root, copy };
}

test('mention completion stays inside the copy, skips ignored and linked entries and feeds the instruction chip', (t) => {
  const { root, copy } = scratch({
    'src/app.ts': 'export {};\n',
    'src/lib/util.ts': 'export {};\n',
    'node_modules/dep/index.js': '',
    '.git/config': '',
    [agents]: 'Use tabs.\n',
    [rules]: 'Be brief.\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'secret.txt'), 'outside');
  symlinkSync(join(root, 'secret.txt'), join(copy, 'linked.txt'));
  symlinkSync(join(root, 'secret.txt'), join(copy, linked));

  const index = createMentionIndex(() => 0);
  const ask = (query: string, limit = 10) =>
    index.complete(copy, process.env, query, limit).map(({ path, kind }) => `${kind}:${path}`);
  assert.deepEqual(ask('util'), ['file:src/lib/util.ts']);
  assert.deepEqual(ask('lib'), ['folder:src/lib', 'file:src/lib/util.ts']);
  assert.deepEqual(ask('dep'), []);
  assert.deepEqual(ask('config'), []);
  assert.deepEqual(ask('secret'), []);
  assert.deepEqual(ask('linked'), []);
  assert.deepEqual(ask('../'), []);
  for (const path of ask('', 3)) assert.equal(path.includes('..'), false);
  assert.equal(ask('s', 2).length, 2);

  // The chip lists plain instruction files at the root. A link to a file outside is not one.
  assert.deepEqual(readInstructions('tsk_x', copy, undefined).files, [agents, rules]);
  const opened = readInstructions('tsk_x', copy, agents);
  assert.deepEqual([opened.name, opened.text, opened.truncated], [agents, 'Use tabs.\n', false]);
  assert.equal(readInstructions('tsk_x', copy, linked).text, null);
  assert.equal(readInstructions('tsk_x', copy, 'src/app.ts').text, null);
  // A folder replaced by a link to somewhere else lists its old files, so completion checks the
  // parent of every candidate and offers nothing that resolves outside the copy.
  const swapped = scratch({ 'real/inside.txt': 'a', 'keep/ok.txt': 'b' });
  t.after(() => rmSync(swapped.root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: swapped.copy, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  mkdirSync(join(swapped.root, 'elsewhere'));
  writeFileSync(join(swapped.root, 'elsewhere', 'inside.txt'), 'outside');
  rmSync(join(swapped.copy, 'real'), { recursive: true });
  symlinkSync(join(swapped.root, 'elsewhere'), join(swapped.copy, 'real'));
  const found = createMentionIndex(() => 0)
    .complete(swapped.copy, process.env, 'txt', 10)
    .map(({ path }) => path);
  assert.deepEqual(found, ['keep/ok.txt']);
  const bare = scratch({ 'src/app.ts': '' });
  t.after(() => rmSync(bare.root, { recursive: true, force: true }));
  assert.deepEqual(readInstructions('tsk_x', bare.copy, undefined).files, []);
});
