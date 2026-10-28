import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { committedFiles } from '../host/source.ts';
import type { ImportProgress } from './files.ts';
import { type CloneFile, copyScratch } from './scratch-copy.ts';

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'scratch-copy-'));
  git(root, 'init', '-q');
  mkdirSync(join(root, 'src/deep'), { recursive: true });
  writeFileSync(join(root, 'src/deep/a.txt'), 'alpha\n');
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(5 * 1024 * 1024, 7));
  writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  execFileSync('ln', ['-s', 'src/deep/a.txt', join(root, 'inside')]);
  execFileSync('ln', ['-s', '../outside', join(root, 'outside')]);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  return { root, base: git(root, 'rev-parse', 'HEAD') };
}

// Path, mode bit and content hash of every entry, links by target.
function treeHash(directory: string): string {
  const lines: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isSymbolicLink())
        lines.push(`${path} link ${execFileSync('readlink', [join(directory, path)])}`);
      else {
        const mode = statSync(join(directory, path)).mode & 0o111 ? 'x' : '-';
        lines.push(
          `${path} ${mode} ${createHash('sha256')
            .update(readFileSync(join(directory, path)))
            .digest('hex')}`,
        );
      }
    }
  };
  walk('');
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

function copy(clone: CloneFile | undefined, dirty = false) {
  const { root, base } = repository();
  const out = mkdtempSync(join(tmpdir(), 'scratch-out-'));
  const plain = join(out, 'plain');
  const target = join(out, 'target');
  try {
    if (dirty) writeFileSync(join(root, 'src/deep/a.txt'), 'edited\n');
    const source = committedFiles(root, base, { scratch: true });
    copyScratch(plain, source.files, source.links);
    const progress: ImportProgress[] = [];
    const result = copyScratch(target, source.files, source.links, {
      checkout: { root, base },
      clone,
      onProgress: (update) => progress.push(update),
    });
    return { result, progress, same: treeHash(plain) === treeHash(target), files: source.files };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

test('a clean checkout on the base is cloned and the copy holds the same tree as a plain copy', () => {
  const calls: string[] = [];
  const { result, progress, same, files } = copy((from, to) => {
    calls.push(from);
    copyFileSync(from, to);
  });
  assert.equal(same, true);
  assert.deepEqual(result, { cloned: files.length, written: 0 });
  assert.equal(calls.length, files.length);
  // The 5 MiB file crosses the 4 MiB step once, then the copy reports its end.
  assert.equal(progress.length, 2);
  assert.equal(progress.at(-1)?.bytes, progress.at(-1)?.total);
});

test('a volume that cannot clone and an edited checkout both fall back to writing the same tree', () => {
  let attempts = 0;
  const unsupported = copy(() => {
    attempts++;
    throw Object.assign(new Error('no reflink'), { code: 'ENOTSUP' });
  });
  assert.equal(unsupported.same, true);
  assert.equal(attempts, 1);
  assert.deepEqual(unsupported.result, { cloned: 0, written: unsupported.files.length });
  let calls = 0;
  const edited = copy(() => {
    calls++;
  }, true);
  assert.equal(edited.same, true);
  assert.equal(calls, 0);
  assert.equal(edited.result.cloned, 0);
});
