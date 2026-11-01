import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { outsidePaths, readOnlyCommand } from './read-only-command.ts';

// The commands an OpenAI read-only turn ran on a memory file outside the copy (H11), with the
// client's folder name swapped for a neutral one. providers/openai/chat.test.ts keeps the exact path.
const MEMORY = '/Users/raykraft/.agent/memories/MEMORY.md';

test('a read-only command runs without a question only when every path stays in the copy', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crewkite-readonly-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, 'scratch');
  const outside = join(root, 'outside');
  mkdirSync(join(scratch, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(scratch, 'src', 'app.ts'), 'x\n');
  writeFileSync(join(outside, 'secret.txt'), 'x\n');
  // A link inside the copy that leads out of it, at the root and in a folder.
  symlinkSync(join(outside, 'secret.txt'), join(scratch, 'leak.txt'));
  symlinkSync(outside, join(scratch, 'src', 'out'));
  const rows: [string, Record<string, string>, boolean][] = [
    ['inside, relative', { command: "rg -n 'x' src/app.ts" }, true],
    ['inside, absolute', { command: `sed -n '1,2p' ${join(scratch, 'src', 'app.ts')}` }, true],
    ['inside, from a folder', { command: 'cat app.ts', cwd: join(scratch, 'src') }, true],
    ['the memory file', { command: `rg -n 'x' ${MEMORY}` }, false],
    ['the memory file through sed', { command: `sed -n '46,51p' ${MEMORY}` }, false],
    ['the memory file in a shell', { command: `/bin/zsh -lc "sed -n '46,51p' ${MEMORY}"` }, false],
    ['home', { command: 'cat ~/.zshrc' }, false],
    ['home in quotes', { command: 'cat "~/.zshrc"' }, false],
    ['up and out', { command: 'cat ../outside/secret.txt' }, false],
    [
      'up from a folder',
      { command: 'cat ../../outside/secret.txt', cwd: join(scratch, 'src') },
      false,
    ],
    ['a link out of the copy', { command: 'cat leak.txt' }, false],
    ['a linked folder', { command: 'cat src/out/secret.txt' }, false],
    [
      'a link reached from a folder',
      { command: 'cat out/secret.txt', cwd: join(scratch, 'src') },
      false,
    ],
    ['a flag that carries a path', { command: `rg --ignore-file=${MEMORY} x src` }, false],
    ['rg following links', { command: 'rg -L x .' }, false],
    ['rg following links, joined flags', { command: 'rg -nL x .' }, false],
    ['grep following links', { command: 'grep -R x .' }, false],
    ['find following links', { command: 'find -L . -name x' }, false],
    ['a folder outside', { command: 'ls', cwd: outside }, false],
  ];
  for (const [name, input, allowed] of rows)
    assert.equal(readOnlyCommand(input, scratch), allowed, name);

  // A turn that runs commands without a question is checked for every path it names.
  assert.deepEqual(outsidePaths({ command: `rg -n 'x' ${MEMORY}` }, scratch), [MEMORY]);
  assert.deepEqual(
    outsidePaths({ command: `/bin/zsh -lc "sed -n '46,51p' ${MEMORY} | head -3"` }, scratch),
    [MEMORY],
  );
  assert.deepEqual(outsidePaths({ command: 'cat src/out/secret.txt' }, scratch), [
    'src/out/secret.txt',
  ]);
  assert.deepEqual(outsidePaths({ command: 'cat "$HOME/notes"' }, scratch), ['$HOME/notes']);
  assert.deepEqual(outsidePaths({ command: 'ls', cwd: outside }, scratch), [outside]);
  assert.deepEqual(
    outsidePaths({ command: "/bin/zsh -lc 'rg --files src && sed -n 1,5p src/app.ts'" }, scratch),
    [],
  );
});
