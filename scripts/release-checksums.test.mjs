import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { releaseChecksums } from './release-checksums.mjs';

test('release checksums admit only the complete asset set and verify final bytes', (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'crewkite-release-sums-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const required = [
    'CrewKite-macOS-arm64.dmg',
    'crewkite_amd64.deb',
    'crewkite_arm64.deb',
    'crewkite.x86_64.rpm',
    'crewkite.aarch64.rpm',
  ];
  for (const kind of [
    'five',
    'seven',
    'single image',
    'missing',
    'extra',
    'empty',
    'linked',
    'changed',
    'duplicate checksum',
  ]) {
    const root = join(temporary, kind);
    mkdirSync(root);
    for (const name of required) writeFileSync(join(root, name), name);
    if (kind === 'seven' || kind === 'single image')
      writeFileSync(join(root, 'CrewKite-linux-x86_64.AppImage'), 'x64');
    if (kind === 'seven') writeFileSync(join(root, 'CrewKite-linux-arm64.AppImage'), 'arm64');
    if (kind === 'missing') rmSync(join(root, required[0]));
    if (kind === 'extra') writeFileSync(join(root, 'unreviewed.zip'), 'extra');
    if (kind === 'empty') writeFileSync(join(root, required[0]), '');
    if (kind === 'linked') {
      rmSync(join(root, required[0]));
      symlinkSync(join(root, required[1]), join(root, required[0]));
    }
    if (['single image', 'missing', 'extra', 'empty', 'linked'].includes(kind)) {
      assert.throws(() => releaseChecksums(root), Error, kind);
      continue;
    }
    const result = releaseChecksums(root);
    assert.equal(result.assets.length, kind === 'seven' ? 7 : 5);
    for (const name of required)
      assert.ok(
        readFileSync(result.sha256sums, 'utf8').includes(
          `${createHash('sha256').update(name).digest('hex')}  ${name}\n`,
        ),
      );
    assert.deepEqual(releaseChecksums(root, { check: true }), result);
    assert.throws(() => releaseChecksums(root), /EEXIST/);
    if (kind === 'changed') writeFileSync(join(root, required[0]), 'later signed bytes');
    if (kind === 'duplicate checksum')
      writeFileSync(result.sha256sums, readFileSync(result.sha256sums, 'utf8').repeat(2));
    if (kind === 'changed' || kind === 'duplicate checksum')
      assert.throws(() => releaseChecksums(root, { check: true }), /differs/);
  }
});
