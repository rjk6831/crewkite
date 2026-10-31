import assert from 'node:assert/strict';
import {
  mkdtempSync,
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
import { saveTextFile } from './save-file.ts';

// Claim: saving a file the person chose writes a new file with owner-only access and renames it
// over the destination, so nothing is truncated in place, no temporary file stays behind and a
// link at the destination is replaced and never written through.
test('saveTextFile replaces a file whole and leaves nothing else behind', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-save-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'usage.csv');
  saveTextFile(target, 'first\r\n');
  assert.equal(readFileSync(target, 'utf8'), 'first\r\n');
  assert.equal(statSync(target).mode & 0o777, 0o600);
  saveTextFile(target, 'second\r\n');
  assert.equal(readFileSync(target, 'utf8'), 'second\r\n');
  assert.deepEqual(readdirSync(directory), ['usage.csv']);

  const other = join(directory, 'other.txt');
  writeFileSync(other, 'untouched');
  const link = join(directory, 'link.csv');
  symlinkSync(other, link);
  saveTextFile(link, 'not through the link');
  assert.equal(readFileSync(other, 'utf8'), 'untouched');
  assert.equal(readFileSync(link, 'utf8'), 'not through the link');
  assert.equal(statSync(link).isFile(), true);
  assert.deepEqual(readdirSync(directory).sort(), ['link.csv', 'other.txt', 'usage.csv']);
});
