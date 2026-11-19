import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { replaceFile } from './whole-file.ts';

test('a file is replaced whole or left as it was, and never through a link', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'ck-whole-file-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const at = (name: string) => join(folder, name);

  replaceFile(at('new.json'), 'one');
  assert.equal(readFileSync(at('new.json'), 'utf8'), 'one');
  assert.equal(statSync(at('new.json')).mode & 0o777, 0o600);

  writeFileSync(at('shared.json'), 'old', { mode: 0o644 });
  chmodSync(at('shared.json'), 0o644);
  // A reader that already holds the old file keeps reading it whole: the new text arrives as a
  // new file under the same name, never as a write into the old one.
  const held = openSync(at('shared.json'), 'r');
  const before = statSync(at('shared.json')).ino;
  const mask = process.umask(0o077);
  try {
    replaceFile(at('shared.json'), 'two');
  } finally {
    process.umask(mask);
  }
  assert.equal(readFileSync(held, 'utf8'), 'old');
  closeSync(held);
  assert.notEqual(statSync(at('shared.json')).ino, before);
  assert.equal(readFileSync(at('shared.json'), 'utf8'), 'two');
  assert.equal(statSync(at('shared.json')).mode & 0o777, 0o644);

  writeFileSync(at('keep.txt'), 'keep');
  symlinkSync(at('keep.txt'), at('link.json'));
  symlinkSync(at('nowhere.txt'), at('dangling.json'));
  linkSync(at('keep.txt'), at('hard.json'));
  mkdirSync(at('folder.json'));
  writeFileSync(at('locked.json'), 'locked');
  chmodSync(at('locked.json'), 0o400);
  for (const name of [
    'link.json',
    'dangling.json',
    'hard.json',
    'folder.json',
    'locked.json',
    join('missing', 'x.json'),
  ])
    assert.throws(() => replaceFile(at(name), 'no'), name);
  assert.equal(readFileSync(at('keep.txt'), 'utf8'), 'keep');
  assert.equal(readFileSync(at('locked.json'), 'utf8'), 'locked');
  // A refusal and a success both leave no file of the write's own behind.
  assert.deepEqual(
    readdirSync(folder).filter((name) => name.endsWith('.tmp')),
    [],
  );
  assert.equal(readdirSync(folder).includes('nowhere.txt'), false);
});
