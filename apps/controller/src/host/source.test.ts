import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ReadDataSchema } from '@crewkite/contracts';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import {
  applyReplacement,
  type FileEntry,
  git,
  inspectSource,
  inspectSourceDetails,
  readFiles,
} from './source.ts';

test('source inspection bounds file metadata without running filters or reading special files', (t) => {
  mkdirSync(resolve('internal'), { recursive: true });
  const directory = mkdtempSync(join(resolve('internal'), 'source-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = createSyntheticRepository(join(directory, 'demo-shop'));
  const projectId = `prj_${'0'.repeat(26)}`;
  const canary = join(directory, 'filter-executed');
  writeFileSync(join(source.directory, '.gitattributes'), '*.mjs filter=canary\n');
  git(source.directory, ['config', 'filter.canary.clean', `touch '${canary}'`]);
  const index = readFileSync(join(source.directory, '.git', 'index'));
  unlinkSync(join(source.directory, 'cli.mjs'));
  execFileSync('mkfifo', [join(source.directory, 'cli.mjs')]);
  const inspected = inspectSourceDetails(projectId, source.directory);
  assert.deepEqual(inspected.source, inspectSource(projectId, source.directory));
  assert.ok(
    inspected.details.files.some(
      (file) => file.path === 'cli.mjs' && file.status === 'type-changed' && file.unstaged,
    ),
  );
  assert.ok(
    inspected.details.files.some(
      (file) => file.path === 'sentinels/staged.txt' && file.staged && !file.unstaged,
    ),
  );
  assert.ok(
    inspected.details.files.some(
      (file) => file.path === 'sentinels/unstaged.txt' && !file.staged && file.unstaged,
    ),
  );
  assert.ok(inspected.details.files.some((file) => file.status === 'untracked' && !file.staged));
  ReadDataSchema.parse({ kind: 'source', ...inspected });
  const longDirectory = join(
    source.directory,
    'inventory-bound',
    'a'.repeat(230),
    'b'.repeat(230),
    'c'.repeat(230),
  );
  mkdirSync(longDirectory, { recursive: true });
  for (let index = 0; index < 110; index++) writeFileSync(join(longDirectory, `file-${index}`), '');
  const bounded = inspectSourceDetails(projectId, source.directory);
  assert.ok(bounded.details.omittedUntracked > 0);
  assert.ok(bounded.details.files.length < 200);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.details)) <= 65_536);
  ReadDataSchema.parse({ kind: 'source', ...bounded });
  const special = join(directory, 'special');
  mkdirSync(special);
  execFileSync('mkfifo', [join(special, 'pipe')]);
  assert.throws(() => readFiles(special), /unsupported|regular/);
  assert.equal(existsSync(canary), false);
  assert.deepEqual(readFileSync(join(source.directory, '.git', 'index')), index);
});

test('replacement checks the full source before writing and preserves mode with exact truncation', (t) => {
  mkdirSync(resolve('internal'), { recursive: true });
  const directory = mkdtempSync(join(resolve('internal'), 'replacement-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const snapshot = (root: string) =>
    readdirSync(root)
      .sort()
      .map((path) => {
        const file = join(root, path);
        const state = lstatSync(file);
        return {
          path,
          mode: state.mode,
          bytes: state.isFile()
            ? readFileSync(file)
            : state.isSymbolicLink()
              ? readlinkSync(file)
              : null,
        };
      });
  const cases: {
    name: string;
    setup?: (root: string, expected: FileEntry[]) => void;
    proposal?: { path?: string; baseHash?: string; content?: string };
    accept?: boolean;
  }[] = [
    { name: 'shorter executable', accept: true },
    { name: 'empty text', proposal: { content: '' }, accept: true },
    { name: 'UTF-8 byte limit', proposal: { content: 'é'.repeat(32_768) }, accept: true },
    { name: 'wrong base', proposal: { baseHash: '0'.repeat(64) } },
    { name: 'unsafe target', proposal: { path: '../net.mjs' } },
    { name: 'invalid UTF-8', proposal: { content: '\ud800' } },
    { name: 'binary text', proposal: { content: '\0' } },
    { name: 'oversized UTF-8', proposal: { content: 'é'.repeat(32_769) } },
    {
      name: 'changed sibling',
      setup: (root) => writeFileSync(join(root, 'sibling.mjs'), 'changed\n'),
    },
    { name: 'added file', setup: (root) => writeFileSync(join(root, 'extra.mjs'), '') },
    { name: 'missing target', setup: (root) => unlinkSync(join(root, 'net.mjs')) },
    { name: 'changed target', setup: (root) => writeFileSync(join(root, 'net.mjs'), 'changed\n') },
    { name: 'changed mode', setup: (root) => chmodSync(join(root, 'net.mjs'), 0o644) },
    {
      name: 'duplicate manifest entry',
      setup: (_root, expected) => {
        expected[1] = { ...expected[0] };
      },
    },
    {
      name: 'invalid manifest bytes',
      setup: (_root, expected) => {
        expected[0].bytes = -1;
      },
    },
    {
      name: 'changed manifest hash',
      setup: (_root, expected) => {
        expected[0].hash = '0'.repeat(64);
      },
    },
    {
      name: 'symlink target',
      setup: (root) => {
        unlinkSync(join(root, 'net.mjs'));
        symlinkSync('sibling.mjs', join(root, 'net.mjs'));
      },
    },
    {
      name: 'hardlink target',
      setup: (root) => linkSync(join(root, 'net.mjs'), join(root, 'alias.mjs')),
    },
    {
      name: 'special target',
      setup: (root) => {
        unlinkSync(join(root, 'net.mjs'));
        execFileSync('mkfifo', [join(root, 'net.mjs')]);
      },
    },
  ];
  for (const [index, example] of cases.entries()) {
    const root = join(directory, String(index));
    mkdirSync(root);
    writeFileSync(join(root, 'net.mjs'), 'export const total = 123456789;\n');
    chmodSync(join(root, 'net.mjs'), 0o751);
    writeFileSync(join(root, 'sibling.mjs'), 'export const unchanged = true;\n');
    const expected = readFiles(root).map(({ path, mode, hash, bytes }) => ({
      path,
      mode,
      hash,
      bytes,
    }));
    const replacement = {
      path: 'net.mjs',
      baseHash: expected[0].hash,
      content: 'export {};\n',
      ...example.proposal,
    };
    example.setup?.(root, expected);
    const before = snapshot(root);
    if (example.accept) {
      applyReplacement(root, expected, replacement);
      assert.equal(readFileSync(join(root, 'net.mjs'), 'utf8'), replacement.content, example.name);
      assert.equal(lstatSync(join(root, 'net.mjs')).mode & 0o777, 0o751, example.name);
      assert.deepEqual(snapshot(root)[1], before[1], example.name);
    } else {
      assert.throws(() => applyReplacement(root, expected, replacement), Error, example.name);
      assert.deepEqual(snapshot(root), before, example.name);
    }
  }
});
