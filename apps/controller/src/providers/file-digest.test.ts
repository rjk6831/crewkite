import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digestHeldFile, fileDigestSync } from './file-digest.ts';

test('the digest cache answers a known file identity and hashes again when its mtime or size changes', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ck-digest-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'client');
  writeFileSync(path, 'first build');
  let reads = 0;
  const read = (file: string, identity: string) => {
    reads++;
    return digestHeldFile(file, identity);
  };
  const expected = () => createHash('sha256').update(readFileSync(path)).digest('hex');
  const steps: [string, () => void, number][] = [
    ['first read', () => {}, 1],
    ['same identity', () => {}, 1],
    ['new mtime', () => utimesSync(path, new Date(1_000_000), new Date(2_000_000)), 2],
    ['same identity again', () => {}, 2],
    ['new size', () => appendFileSync(path, ' and more'), 3],
  ];
  for (const [step, change, count] of steps) {
    change();
    assert.equal(fileDigestSync(path, { read }), expected(), step);
    assert.equal(reads, count, step);
  }
});
