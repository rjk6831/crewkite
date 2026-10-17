import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { setImmediate } from 'node:timers';
import { canonicalJson, ReadDataSchema } from '@crewkite/contracts';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import {
  applyReplacement,
  committedFiles,
  type FileContent,
  type FileEntry,
  git,
  inspectSource,
  inspectSourceDetails,
  readFiles,
  treeFromFiles,
} from './source.ts';
import {
  type CopyBudget,
  copyInstalledDependencies,
  inspectInstalledDependencies,
  inventoryTree,
} from './toolchain.ts';

test('source inspection bounds file metadata without running filters or reading special files', async (t) => {
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

  const blobFiles: FileContent[] = [
    { path: '.gitattributes', mode: '100644', content: Buffer.from('*.bin filter=canary\n') },
    {
      path: 'binary.bin',
      mode: '100644',
      content: Buffer.concat([
        Buffer.from([0, 255, 10, 13]),
        Buffer.from('done\ncommit refs/heads/no\n'),
      ]),
    },
    { path: 'empty', mode: '100644', content: Buffer.alloc(0) },
    { path: 'executable', mode: '100755', content: Buffer.from('same\n') },
    { path: 'nested/é\tquote"\nfile', mode: '100644', content: Buffer.from('last line') },
    { path: 'ordinary', mode: '100644', content: Buffer.from('same\n') },
  ].map((file) => ({
    ...file,
    mode: file.mode as FileContent['mode'],
    bytes: file.content.length,
    hash: createHash('sha256').update(file.content).digest('hex'),
  }));
  for (const format of ['sha1', 'sha256']) {
    const repository = join(directory, format);
    mkdirSync(repository);
    git(repository, ['init', '--quiet', `--object-format=${format}`]);
    git(repository, ['config', 'filter.canary.clean', `touch '${canary}'`]);
    git(repository, ['read-tree', '--empty']);
    const entries = blobFiles.map((file) => {
      const oid = git(repository, ['hash-object', '-w', '--stdin'], file.content).toString().trim();
      return `${file.mode} ${oid}\t${file.path}\0`;
    });
    git(repository, ['update-index', '-z', '--index-info'], entries.join(''));
    const expected = git(repository, ['write-tree']).toString().trim();
    const references = git(repository, ['for-each-ref']);
    assert.equal(treeFromFiles(repository, blobFiles), expected);
    assert.deepEqual(git(repository, ['for-each-ref']), references);
    const identity = {
      name: 'Fixture',
      email: 'fixture@example.invalid',
      at: '2026-01-01T00:00:00Z',
    };
    const commit = (tree: string) =>
      git(repository, ['commit-tree', tree], 'fixture\n', identity).toString().trim();
    assert.deepEqual(committedFiles(repository, commit(expected)), blobFiles);
    const empty = treeFromFiles(repository, []);
    assert.deepEqual(committedFiles(repository, commit(empty)), []);
    const missing = git(
      repository,
      ['mktree', '--missing', '-z'],
      `100644 blob ${'0'.repeat(format === 'sha1' ? 40 : 64)}\tmissing\0`,
    )
      .toString()
      .trim();
    assert.throws(() => committedFiles(repository, commit(missing)), /unavailable/);
    assert.equal(existsSync(canary), false);
  }
  assert.throws(
    () => treeFromFiles(join(directory, 'too-many'), Array(10001).fill(blobFiles[0])),
    /file limit/,
  );
  assert.throws(
    () =>
      treeFromFiles(join(directory, 'too-large'), [
        { ...blobFiles[0], content: Buffer.alloc(64 * 1024 * 1024 + 1) },
      ]),
    /byte limit/,
  );

  const budget = (): CopyBudget => ({
    deadline: 1000,
    now: () => 0,
    maximumEntries: 100,
    maximumBytes: 1024 * 1024,
  });
  const workspace = 'apps/local';
  const installed = 'node_modules/.pnpm/tiny@1.0.0/node_modules/tiny';
  const executable = `${installed}/cli.mjs`;
  const cases = [
    'copy',
    'nested package copy',
    'canonical inventory',
    'inventory hash',
    'inventory order',
    'donor bytes',
    'donor mode',
    'donor link',
    'nested task state bytes',
    'workspace task state bytes',
    'staged bytes',
    'staged mode',
    'staged link',
    'lock',
    'workspace manifest',
    'workspace configuration',
    'settings',
    'installed version',
    'escaping link',
    'dangling link',
    'cyclic link',
    'special file',
    'entries',
    'bytes',
    'deadline',
    'cancel during copy',
  ];
  for (const name of cases) {
    const donor = join(directory, 'closure', name, 'donor');
    const candidate =
      name === 'nested package copy'
        ? join(donor, 'internal/package-source')
        : join(directory, 'closure', name, 'candidate');
    for (const root of [donor, candidate]) {
      mkdirSync(join(root, workspace), { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'fixture',
          packageManager: 'pnpm@12.11.2',
          dependencies: { tiny: '1.0.0', '@tiny/local': 'workspace:*' },
        }),
      );
      writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: [apps/*]\n');
      writeFileSync(join(root, '.npmrc'), 'engine-strict=true\n');
      writeFileSync(
        join(root, workspace, 'package.json'),
        JSON.stringify({
          name: '@tiny/local',
          dependencies: { tiny: '1.0.0' },
        }),
      );
    }
    mkdirSync(join(donor, installed), { recursive: true });
    writeFileSync(
      join(donor, installed, 'package.json'),
      JSON.stringify({ name: 'tiny', version: '1.0.0' }),
    );
    writeFileSync(join(donor, executable), 'export {};\n');
    chmodSync(join(donor, executable), 0o751);
    mkdirSync(join(donor, 'node_modules/@tiny'));
    symlinkSync('../../apps/local', join(donor, 'node_modules/@tiny/local'));
    symlinkSync('.pnpm/tiny@1.0.0/node_modules/tiny', join(donor, 'node_modules/tiny'));
    mkdirSync(join(donor, workspace, 'node_modules/.pnpm-cache'), { recursive: true });
    writeFileSync(join(donor, workspace, 'node_modules/.pnpm-cache/keep'), 'kept');
    symlinkSync(
      '../../../node_modules/.pnpm/tiny@1.0.0/node_modules/tiny',
      join(donor, workspace, 'node_modules/tiny'),
    );
    mkdirSync(join(donor, installed, '.pnpm-cache'));
    writeFileSync(join(donor, installed, '.pnpm-cache/omit'), 'omitted');
    const taskState = 'node_modules/.pnpm-task-run-state-v1';
    const retainedState = [
      'node_modules/other/.pnpm-task-run-state-v1',
      `${workspace}/${taskState}`,
    ];
    for (const path of [taskState, ...retainedState]) {
      mkdirSync(join(donor, path), { recursive: true });
      writeFileSync(join(donor, path, 'run.finished'), '');
      writeFileSync(join(donor, path, 'latest.json'), '{"run":"first"}');
    }
    if (name === 'installed version')
      writeFileSync(join(donor, installed, 'package.json'), '{"name":"tiny","version":"2.0.0"}');
    if (name === 'escaping link') symlinkSync('../../candidate', join(donor, 'node_modules/extra'));
    if (name === 'dangling link') symlinkSync('missing', join(donor, 'node_modules/extra'));
    if (name === 'cyclic link') symlinkSync('extra', join(donor, 'node_modules/extra'));
    if (name === 'special file') execFileSync('mkfifo', [join(donor, 'node_modules/pipe')]);
    if (
      [
        'installed version',
        'escaping link',
        'dangling link',
        'cyclic link',
        'special file',
      ].includes(name)
    ) {
      await assert.rejects(inspectInstalledDependencies(donor, [workspace], budget()), Error, name);
      continue;
    }
    if (name === 'cancel during copy')
      writeFileSync(join(donor, installed, 'large'), Buffer.alloc(600000));
    const expected = await inspectInstalledDependencies(donor, [workspace], budget());
    assert.ok(Object.isFrozen(expected) && Object.isFrozen(expected.tree.entries));
    assert.ok(expected.tree.entries.every(Object.isFrozen));
    const supplied =
      name === 'canonical inventory' || name.startsWith('inventory ')
        ? JSON.parse(canonicalJson(expected))
        : expected;
    if (name === 'canonical inventory')
      assert.notEqual(JSON.stringify(supplied), JSON.stringify(expected));
    if (name === 'inventory hash') supplied.hash = '0'.repeat(64);
    if (name === 'inventory order') supplied.tree.entries.reverse();
    if (name === 'donor bytes') writeFileSync(join(donor, executable), 'changed');
    if (name === 'donor mode') chmodSync(join(donor, executable), 0o644);
    if (name === 'donor link') {
      unlinkSync(join(donor, 'node_modules/@tiny/local'));
      symlinkSync('../tiny', join(donor, 'node_modules/@tiny/local'));
    }
    if (name === 'copy') {
      unlinkSync(join(donor, taskState, 'run.finished'));
      writeFileSync(join(donor, taskState, 'next.finished'), '');
      writeFileSync(join(donor, taskState, 'latest.json'), '{"run":"next"}');
    }
    if (name === 'nested task state bytes' || name === 'workspace task state bytes')
      writeFileSync(
        join(donor, retainedState[name === 'nested task state bytes' ? 0 : 1], 'latest.json'),
        '{"run":"changed"}',
      );
    const changed = (
      {
        lock: 'pnpm-lock.yaml',
        'workspace manifest': `${workspace}/package.json`,
        'workspace configuration': 'pnpm-workspace.yaml',
        settings: '.npmrc',
      } as Record<string, string>
    )[name];
    if (changed) writeFileSync(join(candidate, changed), 'changed');
    const limits = budget();
    if (name === 'entries') limits.maximumEntries = 1;
    if (name === 'bytes') limits.maximumBytes = 1;
    if (name === 'deadline') {
      let ticks = 0;
      limits.now = () => ++ticks;
      limits.deadline = 10;
    }
    let mutated = false;
    if (name.startsWith('staged'))
      limits.now = () => {
        if (!mutated && existsSync(join(candidate, 'node_modules/tiny'))) {
          mutated = true;
          if (name === 'staged bytes') writeFileSync(join(candidate, executable), 'changed');
          if (name === 'staged mode') chmodSync(join(candidate, executable), 0o644);
          if (name === 'staged link') {
            unlinkSync(join(candidate, 'node_modules/@tiny/local'));
            symlinkSync('../tiny', join(candidate, 'node_modules/@tiny/local'));
          }
        }
        return 0;
      };
    if (name === 'cancel during copy') {
      const stop = new AbortController();
      limits.signal = stop.signal;
      limits.now = () => {
        if (!mutated && existsSync(join(candidate, installed, 'large'))) {
          mutated = true;
          setImmediate(() => stop.abort());
        }
        return 0;
      };
    }
    if (!['copy', 'nested package copy', 'canonical inventory'].includes(name)) {
      await assert.rejects(
        copyInstalledDependencies(donor, candidate, supplied, limits),
        Error,
        name,
      );
      if (name.startsWith('staged') || name === 'cancel during copy')
        assert.equal(mutated, true, name);
      if (name === 'cancel during copy') assert.equal(limits.signal?.aborted, true);
      continue;
    }
    assert.deepEqual(await copyInstalledDependencies(donor, candidate, supplied, limits), expected);
    assert.deepEqual(await inspectInstalledDependencies(donor, [workspace], budget()), expected);
    assert.equal(lstatSync(join(candidate, executable)).mode & 0o777, 0o751);
    assert.notEqual(
      lstatSync(join(candidate, executable)).ino,
      lstatSync(join(donor, executable)).ino,
    );
    assert.equal(readlinkSync(join(candidate, 'node_modules/@tiny/local')), '../../apps/local');
    assert.ok(
      expected.tree.entries.some(
        (entry) => entry.path === `${workspace}/node_modules/.pnpm-cache/keep`,
      ),
    );
    assert.ok(!expected.tree.entries.some((entry) => entry.path === `${installed}/.pnpm-cache`));
    assert.ok(!expected.tree.entries.some((entry) => entry.path === taskState));
    assert.equal(existsSync(join(candidate, taskState)), false);
    for (const path of retainedState) {
      assert.ok(expected.tree.entries.some((entry) => entry.path === `${path}/latest.json`));
      assert.equal(readFileSync(join(candidate, path, 'latest.json'), 'utf8'), '{"run":"first"}');
    }
    const tools = await inventoryTree(join(candidate, installed), budget());
    assert.equal(tools.files, 2);
    assert.equal(tools.entries.find((entry) => entry.path === 'cli.mjs')?.kind, 'file');
    await assert.rejects(copyInstalledDependencies(donor, candidate, expected, budget()), /EEXIST/);
  }
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
