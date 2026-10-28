import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
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
import {
  hashCandidateFiles,
  readPlannedBlobs,
  scratchPlan,
  treeFromScratch,
} from '../host/source.ts';
import { discardScratchPath, scratchChanges } from './changes.ts';
import type { ImportProgress } from './files.ts';
import { type CloneFile, copyScratch } from './scratch-copy.ts';

// Over the 64 MiB the older whole-base read allowed, so the copy and every later read must not
// load the base at once.
const BIG = 66 * 1024 * 1024;

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
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(BIG, 7));
  writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  execFileSync('ln', ['-s', 'src/deep/a.txt', join(root, 'inside')]);
  execFileSync('ln', ['-s', '../outside', join(root, 'outside')]);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  return { root, base: git(root, 'rev-parse', 'HEAD') };
}

// Path, mode bit and content hash of every entry, links by target.
function treeHash(directory: string, skip: readonly string[] = []): string {
  const lines: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (skip.includes(path)) continue;
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

function copy(
  clone: CloneFile | undefined,
  dirty = false,
  inspect?: (at: { root: string; base: string; target: string; out: string }) => void,
) {
  const { root, base } = repository();
  const out = mkdtempSync(join(tmpdir(), 'scratch-out-'));
  const target = join(out, 'target');
  try {
    // The clean checkout is the reference: the base's files, and no entry the copy leaves out.
    const expected = treeHash(root, ['.git', 'outside']);
    if (dirty) writeFileSync(join(root, 'src/deep/a.txt'), 'edited\n');
    const plan = scratchPlan(root, base);
    const progress: ImportProgress[] = [];
    const reads: number[] = [];
    const result = copyScratch(target, plan.files, plan.links, {
      checkout: { root, base },
      clone,
      chunkBytes: 1024 * 1024,
      read: (files) => {
        reads.push(files.reduce((sum, file) => sum + file.bytes, 0));
        return readPlannedBlobs(root, files as typeof plan.files);
      },
      onProgress: (update) => progress.push(update),
    });
    const same = treeHash(target) === expected;
    inspect?.({ root, base, target, out });
    return {
      result,
      progress,
      reads,
      same,
      files: plan.files,
      skipped: plan.skipped.map((entry) => entry.reason),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

test('a clean checkout on the base is cloned and the copy holds the same tree as a plain copy', () => {
  const calls: string[] = [];
  const { result, progress, same, files, skipped, reads } = copy((from, to) => {
    calls.push(from);
    copyFileSync(from, to);
  });
  assert.equal(same, true);
  assert.deepEqual(result, { cloned: files.length, written: 0 });
  assert.equal(calls.length, files.length);
  assert.deepEqual(skipped, ['link-outside']);
  assert.deepEqual(reads, []);
  // The 66 MiB file crosses the 4 MiB step once, then the copy reports its end.
  assert.equal(progress.length, 2);
  assert.equal(progress.at(-1)?.bytes, progress.at(-1)?.total);
});

test('a volume that cannot clone and an edited checkout both fall back to writing the same tree', () => {
  let attempts = 0;
  const unsupported = copy(
    () => {
      attempts++;
      throw Object.assign(new Error('no reflink'), { code: 'ENOTSUP' });
    },
    false,
    ({ root, base, target, out }) => {
      // The base is over 64 MiB. Changes, Discard and Accept still work, reading only what changed.
      appendFileSync(join(target, 'src/deep/a.txt'), 'beta\n');
      appendFileSync(join(target, 'big.bin'), 'x');
      rmSync(join(target, 'run.sh'));
      const diffs = scratchChanges(root, target, base);
      assert.deepEqual(
        diffs.map((diff) => diff.path),
        ['big.bin', 'run.sh', 'src/deep/a.txt'],
      );
      // The two 66 MiB reads of big.bin do not fit one comparison, and the note names that cause.
      assert.match(diffs[0].patch ?? '', /^Not compared\nThis change reads 132\.0 MiB/);
      assert.match(diffs[1].patch ?? '', /^--- a\/run\.sh\n\+\+\+ \/dev\/null/);
      assert.match(diffs[2].patch ?? '', /\+beta/);
      const plan = scratchPlan(root, base);
      const tree = treeFromScratch({
        repository: join(out, 'work'),
        source: root,
        scratch: target,
        plan,
        candidates: hashCandidateFiles(target, root, plan),
      });
      // Only the changed files were written. The tree holds the edit and keeps the base's links.
      const listing = git(root, 'ls-tree', '-r', base).split('\n');
      const baseOid = (path: string) =>
        listing.find((line) => line.endsWith(`\t${path}`))?.split(/\s+/)[2];
      const entries = git(join(out, 'work'), 'ls-tree', '-r', tree).split('\n');
      assert.equal(entries.length, listing.length - 1);
      assert.ok(!entries.some((line) => line.endsWith('\trun.sh')));
      assert.notEqual(
        entries.find((l) => l.endsWith('\ta.txt'))?.split(/\s+/)[2],
        baseOid('src/deep/a.txt'),
      );
      assert.deepEqual(
        entries.filter((l) => l.includes('\toutside')).map((l) => l.split(/\s+/)[2]),
        [baseOid('outside')],
      );
      for (const path of ['big.bin', 'run.sh', 'src/deep/a.txt'])
        assert.deepEqual(discardScratchPath(root, target, base, path), {
          done: path === 'run.sh' ? 'recovered' : 'restored',
        });
      assert.deepEqual(scratchChanges(root, target, base), []);
    },
  );
  assert.equal(unsupported.same, true);
  // The 66 MiB file is over the 1 MiB run limit, so it is read alone and the small ones together.
  assert.deepEqual(unsupported.reads, [BIG, 16]);
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
