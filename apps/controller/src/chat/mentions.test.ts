import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createMentionIndex, readInstructions } from './mentions.ts';

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
    'AGENTS.md': 'Use tabs.\n',
    '.cursorrules': 'Be brief.\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'secret.txt'), 'outside');
  symlinkSync(join(root, 'secret.txt'), join(copy, 'linked.txt'));
  symlinkSync(join(root, 'secret.txt'), join(copy, 'CLAUDE.md'));

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
  assert.deepEqual(readInstructions('tsk_x', copy, undefined).files, ['AGENTS.md', '.cursorrules']);
  const opened = readInstructions('tsk_x', copy, 'AGENTS.md');
  assert.deepEqual(
    [opened.name, opened.text, opened.truncated],
    ['AGENTS.md', 'Use tabs.\n', false],
  );
  assert.equal(readInstructions('tsk_x', copy, 'CLAUDE.md').text, null);
  assert.equal(readInstructions('tsk_x', copy, 'src/app.ts').text, null);
  const bare = scratch({ 'src/app.ts': '' });
  t.after(() => rmSync(bare.root, { recursive: true, force: true }));
  assert.deepEqual(readInstructions('tsk_x', bare.copy, undefined).files, []);
});
