import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { canonicalJson, ReadDataSchema } from '@crewkite/contracts';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { copyRuntimePackages } from '../../../../scripts/runtime-packages.ts';
import { resolveRuntime } from '../../../desktop/src/main/runtime.ts';
import { checkOwner } from './check-ownership.ts';
import {
  applyReplacement,
  captureSingleFileEdit,
  committedFiles,
  type FileContent,
  type FileEntry,
  git,
  inspectSource,
  inspectSourceDetails,
  readCandidateFiles,
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

  const ignoreRepository = join(directory, 'ignore-repository');
  const ignoreScratch = join(directory, 'ignore-scratch');
  const originalFiles = [
    ['.gitignore', 'node_modules/\n*.log\n'],
    ['nested/.gitignore', 'generated/*\n!generated/keep.txt\n'],
    ['node_modules/tracked.txt', 'original\n'],
    ['deleted.log', 'remove me\n'],
    ['tracked.log', 'original\n'],
    ['ordinary.txt', 'original\n'],
  ].map(([path, text]) => {
    const content = Buffer.from(text);
    return {
      path,
      mode: '100644' as const,
      hash: createHash('sha256').update(content).digest('hex'),
      bytes: content.length,
      content,
    };
  });
  const ignoreTree = treeFromFiles(ignoreRepository, originalFiles);
  const ignoreBase = git(ignoreRepository, ['commit-tree', ignoreTree, '-m', 'base'], undefined, {
    name: 'Source test',
    email: 'source@example.test',
    at: '2026-01-01T00:00:00.000Z',
  })
    .toString()
    .trim();
  for (const file of originalFiles) {
    mkdirSync(dirname(join(ignoreScratch, file.path)), { recursive: true });
    writeFileSync(join(ignoreScratch, file.path), file.content);
  }
  writeFileSync(join(ignoreScratch, 'tracked.log'), 'changed\n');
  chmodSync(join(ignoreScratch, 'tracked.log'), 0o755);
  writeFileSync(join(ignoreScratch, 'node_modules/tracked.txt'), 'changed tracked dependency\n');
  unlinkSync(join(ignoreScratch, 'deleted.log'));
  writeFileSync(join(ignoreScratch, 'ordinary.txt'), 'changed ordinary\n');
  writeFileSync(join(ignoreScratch, 'new-source.txt'), 'new source\n');
  // New ignore rules cannot conceal source edits from the frozen source policy.
  writeFileSync(join(ignoreScratch, '.gitignore'), '*\n');
  mkdirSync(join(ignoreScratch, 'node_modules/.pnpm-store'), { recursive: true });
  writeFileSync(join(ignoreScratch, 'node_modules/.pnpm-store/index.db'), 'generated cache');
  mkdirSync(join(ignoreScratch, 'nested/generated'), { recursive: true });
  writeFileSync(join(ignoreScratch, 'nested/generated/drop.txt'), 'generated');
  writeFileSync(join(ignoreScratch, 'nested/generated/keep.txt'), 'retained');
  assert.ok(
    readFiles(ignoreScratch).some((file) => file.path === 'node_modules/.pnpm-store/index.db'),
  );
  const selected = readCandidateFiles(ignoreScratch, ignoreRepository, ignoreBase);
  assert.deepEqual(
    selected.map((file) => file.path),
    [
      '.gitignore',
      'nested/.gitignore',
      'nested/generated/keep.txt',
      'new-source.txt',
      'node_modules/tracked.txt',
      'ordinary.txt',
      'tracked.log',
    ],
  );
  assert.equal(selected.find((file) => file.path === 'tracked.log')?.mode, '100755');
  assert.equal(
    selected.find((file) => file.path === 'node_modules/tracked.txt')?.content.toString(),
    'changed tracked dependency\n',
  );
  assert.equal(
    selected.find((file) => file.path === 'ordinary.txt')?.content.toString(),
    'changed ordinary\n',
  );
  // Ignored generated special files are skipped before any content is opened.
  execFileSync('mkfifo', [join(ignoreScratch, 'node_modules/cache.pipe')]);
  assert.deepEqual(readCandidateFiles(ignoreScratch, ignoreRepository, ignoreBase), selected);
  execFileSync('mkfifo', [join(ignoreScratch, 'selected.pipe')]);
  assert.throws(() => readCandidateFiles(ignoreScratch, ignoreRepository, ignoreBase), /special/);
  unlinkSync(join(ignoreScratch, 'selected.pipe'));
  assert.deepEqual(git(ignoreRepository, ['for-each-ref']).toString(), '');

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

  const primary = dirname(
    git(resolve('.'), ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      .toString()
      .trim(),
  );
  const runtimeRootDirectory = checkOwner()?.stateRoot ?? join(primary, 'internal');
  const runtimeDirectory = mkdtempSync(join(runtimeRootDirectory, 'rt-'));
  t.after(() => rmSync(runtimeDirectory, { recursive: true, force: true }));
  const app = join(runtimeDirectory, 'app');
  const runtimeRoot = join(app, 'runtime');
  const workspaceEntry = join(runtimeRoot, 'apps/controller/src/main.ts');
  const demoEntry = join(runtimeRoot, 'scripts/demo-controller.ts');
  for (const path of [dirname(workspaceEntry), dirname(demoEntry), join(runtimeRoot, 'bin')])
    mkdirSync(path, { recursive: true });
  writeFileSync(workspaceEntry, 'export {};\n');
  writeFileSync(demoEntry, 'export {};\n');
  const bundledNode = join(runtimeRoot, 'bin/node');
  copyFileSync(process.execPath, bundledNode);
  chmodSync(bundledNode, 0o700);
  const environment = {
    CREWKITE_HOME: join(runtimeDirectory, 'home'),
    CREWKITE_PROFILE: join(runtimeDirectory, 'profile'),
  };
  mkdirSync(environment.CREWKITE_HOME, { mode: 0o700 });
  const retained = new Map([
    ['demo-catalog.json', 'historical catalog'],
    ['state.sqlite', 'historical database'],
  ]);
  for (const [name, bytes] of retained)
    writeFileSync(join(environment.CREWKITE_HOME, name), bytes, { mode: 0o600 });
  for (const mode of ['workspace', 'demo'] as const) {
    writeFileSync(
      join(runtimeRoot, 'manifest.json'),
      JSON.stringify({
        version: 1,
        node: {
          version: '24.22.0',
          platform: process.platform,
          arch: process.arch,
          sha256: createHash('sha256').update(readFileSync(bundledNode)).digest('hex'),
        },
        mode,
      }),
    );
    const paths = resolveRuntime(app, environment);
    assert.equal(paths.mode, mode);
    assert.equal(paths.controller, mode === 'workspace' ? workspaceEntry : demoEntry);
    assert.equal(paths.home, environment.CREWKITE_HOME);
    for (const [name, bytes] of retained)
      assert.equal(readFileSync(join(paths.home, name), 'utf8'), bytes);
    assert.equal(existsSync(join(paths.home, 'demo-shop')), false);
  }

  const { buildLocalInputHelper, inspectLocalInputArtifact } = await import(
    new URL('../../../../scripts/package.mjs', import.meta.url).href
  );
  const { resolvePackagedLocalInput } = await import('../main.ts');
  for (const row of [
    'missing manifest',
    'missing capability',
    'fixed capability',
    'directory URL root',
    'changed node',
    'changed helper',
    'changed source',
    'linked helper',
    'shared helper',
    'special helper',
    'writable manifest',
    'caller path',
  ]) {
    const root = join(directory, 'packaged-input', row);
    const source = join(root, 'apps/controller/src/providers/local/secure-input.m');
    const helper = join(root, 'bin/local-secure-input');
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(helper));
    writeFileSync(source, 'synthetic source');
    writeFileSync(helper, 'synthetic helper');
    writeFileSync(join(root, 'bin/node'), 'synthetic node');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const localInput = {
      sha256: hash('synthetic helper'),
      sourceHash: hash('synthetic source'),
      target: 'darwin-arm64',
      minOS: '13.5.0',
    };
    const manifest = {
      version: 1,
      node: {
        version: '24.22.0',
        platform: 'darwin',
        arch: 'arm64',
        sha256: hash('synthetic node'),
      },
      mode: 'demo',
      ...(row === 'missing capability' ? {} : { localInput }),
    };
    const manifestPath = join(root, 'manifest.json');
    if (row !== 'missing manifest')
      writeFileSync(
        manifestPath,
        JSON.stringify(
          row === 'caller path'
            ? { ...manifest, localInput: { ...localInput, path: helper } }
            : manifest,
        ),
      );
    if (row === 'changed node') writeFileSync(join(root, 'bin/node'), 'changed node');
    if (row === 'changed helper') writeFileSync(helper, 'changed helper');
    if (row === 'changed source') writeFileSync(source, 'changed source');
    if (row === 'writable manifest') chmodSync(manifestPath, 0o666);
    if (row === 'shared helper') linkSync(helper, join(root, 'shared-helper'));
    if (row === 'linked helper' || row === 'special helper') {
      unlinkSync(helper);
      if (row === 'linked helper') symlinkSync(source, helper);
      else execFileSync('mkfifo', [helper]);
    }
    if (row === 'missing manifest' || row === 'missing capability')
      assert.equal(resolvePackagedLocalInput(root), undefined, row);
    else if (
      row === 'caller path' ||
      row === 'writable manifest' ||
      (!['fixed capability', 'directory URL root'].includes(row) &&
        process.platform === 'darwin' &&
        process.arch === 'arm64')
    )
      assert.throws(() => resolvePackagedLocalInput(root), Error, row);
    else
      assert.deepEqual(
        resolvePackagedLocalInput(row === 'directory URL root' ? `${root}/` : root),
        process.platform === 'darwin' && process.arch === 'arm64'
          ? {
              root,
              sha256: localInput.sha256,
              sourceHash: localInput.sourceHash,
              target: localInput.target,
            }
          : undefined,
        row,
      );
  }
  const helperArtifact = Buffer.alloc(56);
  for (const [offset, value] of [
    [0, 0xfeedfacf],
    [4, 0x0100000c],
    [12, 2],
    [16, 1],
    [20, 24],
    [32, 0x32],
    [36, 24],
    [40, 1],
    [44, 0x000d0500],
    [48, 0x001a0500],
  ])
    helperArtifact.writeUInt32LE(value, offset);
  assert.deepEqual(inspectLocalInputArtifact(helperArtifact), {
    target: 'darwin-arm64',
    minOS: '13.5.0',
    sdk: '26.5.0',
  });
  for (const [offset, value] of [
    [0, 0xcafebabe],
    [4, 0x01000007],
    [12, 6],
    [16, 0],
    [20, 25],
    [32, 0x24],
    [36, 16],
    [40, 2],
    [44, 0x000e0000],
  ]) {
    const invalid = Buffer.from(helperArtifact);
    invalid.writeUInt32LE(value, offset);
    assert.throws(() => inspectLocalInputArtifact(invalid));
  }
  assert.throws(() => inspectLocalInputArtifact(helperArtifact.subarray(0, 55)));
  for (const row of [
    'build',
    'compiler failed',
    'compiler missing',
    'compiler timeout',
    'compiler signalled',
    'no output',
    'changed source',
    'wrong target',
    'source link',
  ] as const) {
    const checkout = join(directory, 'native-helper', row);
    const build = join(checkout, 'build');
    const source = join(checkout, 'apps/controller/src/providers/local/secure-input.m');
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(build);
    writeFileSync(source, 'synthetic helper source');
    if (row === 'source link') {
      unlinkSync(source);
      symlinkSync(join(checkout, 'absent'), source);
    }
    let invoked = 0;
    const compile = () =>
      buildLocalInputHelper(checkout, build, {
        read: (path: string) =>
          path === source || path === join(build, 'local-secure-input')
            ? readFileSync(path)
            : Buffer.from('synthetic tool input'),
        execute: (
          compiler: string,
          args: string[],
          settings: {
            timeout: number;
            maxBuffer: number;
            env: Record<string, string>;
            stdio: string[];
          },
        ) => {
          invoked++;
          assert.equal(compiler, '/Library/Developer/CommandLineTools/usr/bin/clang');
          assert.deepEqual(args, [
            '-fobjc-arc',
            '-fblocks',
            '-arch',
            'arm64',
            '-mmacosx-version-min=13.5',
            '-isysroot',
            '/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk',
            '-framework',
            'AppKit',
            '-framework',
            'Foundation',
            source,
            '-o',
            join(build, 'local-secure-input'),
          ]);
          assert.equal(settings.timeout, 30000);
          assert.equal(settings.maxBuffer, 65536);
          assert.deepEqual(settings.stdio, ['ignore', 'pipe', 'pipe']);
          assert.deepEqual(settings.env, { LANG: 'C', PATH: '/usr/bin:/bin', TMPDIR: build });
          if (row === 'changed source') writeFileSync(source, 'changed helper source');
          const output = Buffer.from(helperArtifact);
          if (row === 'wrong target') output.writeUInt32LE(0x000e0000, 44);
          if (row !== 'no output') writeFileSync(join(build, 'local-secure-input'), output);
          return {
            status: row === 'compiler failed' ? 1 : row === 'compiler missing' ? null : 0,
            signal: row === 'compiler signalled' ? 'SIGTERM' : null,
            error: row === 'compiler timeout' ? new Error('synthetic timeout') : undefined,
          };
        },
      });
    if (row !== 'build') assert.throws(compile);
    else {
      const result = compile();
      assert.deepEqual(result.identity, {
        sha256: createHash('sha256').update(helperArtifact).digest('hex'),
        sourceHash: createHash('sha256').update('synthetic helper source').digest('hex'),
        target: 'darwin-arm64',
        minOS: '13.5.0',
      });
      assert.throws(compile, /already exists/);
    }
    assert.equal(invoked, row === 'source link' ? 0 : 1);
  }

  for (const name of [
    'copy',
    'exports',
    'version',
    'missing',
    'extra',
    'escape',
    'conflicting resolution',
    'changed donor',
    'changed manifest',
  ]) {
    const root = join(directory, 'runtime', name);
    const donor = join(root, 'donor');
    const stage = join(root, 'stage');
    const sdk = join(donor, 'node_modules/fixture');
    const parser = join(sdk, 'node_modules/parser');
    mkdirSync(parser, { recursive: true });
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(donor, 'package.json'), '{}');
    writeFileSync(
      join(sdk, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        ...(name === 'exports' ? { exports: { '.': './index.js' } } : { main: 'index.js' }),
        dependencies: {
          converter: '1.0.0',
          parser: '^3.0.0',
          ...(name === 'extra' ? { unexpected: '*' } : {}),
        },
      }),
    );
    writeFileSync(join(sdk, 'index.js'), "module.exports = require('converter');\n");
    writeFileSync(join(sdk, 'LICENSE'), 'exact fixture license\n');
    writeFileSync(
      join(parser, 'package.json'),
      JSON.stringify({
        name: 'parser',
        version: name === 'version' ? '4.0.0' : '3.0.0',
        main: 'index.js',
      }),
    );
    writeFileSync(join(parser, 'index.js'), 'module.exports = 3;\n');
    writeFileSync(join(parser, 'LICENSE'), 'exact parser license\n');
    // Installed package stores keep dependency links beside each package, not inside its payload.
    const payload = join(donor, 'store/fixture');
    mkdirSync(dirname(payload), { recursive: true });
    renameSync(sdk, payload);
    renameSync(join(payload, 'node_modules'), join(donor, 'store/node_modules'));
    const converter = join(donor, 'store/node_modules/converter');
    mkdirSync(converter);
    writeFileSync(
      join(converter, 'package.json'),
      '{"name":"converter","version":"1.0.0","main":"index.js","peerDependencies":{"parser":"^3"}}',
    );
    writeFileSync(join(converter, 'index.js'), "module.exports = require('parser');\n");
    writeFileSync(join(converter, 'LICENSE'), 'exact converter license\n');
    symlinkSync('../store/fixture', sdk);
    if (name === 'missing') rmSync(join(donor, 'store/node_modules/parser'), { recursive: true });
    if (name === 'escape') {
      unlinkSync(sdk);
      writeFileSync(
        join(stage, 'package.json'),
        '{"name":"fixture","version":"1.0.0","main":"index.js"}',
      );
      writeFileSync(join(stage, 'index.js'), 'module.exports = 1;\n');
      symlinkSync(stage, sdk);
    }
    if (name === 'conflicting resolution') {
      mkdirSync(join(donor, 'other/node_modules/parser'), { recursive: true });
      for (const file of ['package.json', 'index.js', 'LICENSE'])
        writeFileSync(
          join(donor, 'other/node_modules/parser', file),
          readFileSync(join(donor, 'store/node_modules/parser', file)),
        );
      renameSync(converter, join(donor, 'other/converter'));
      symlinkSync('../../other/converter', converter);
    }
    let changed = false;
    const limits = budget();
    limits.maximumEntries = 200;
    limits.now = () => {
      if (name === 'changed manifest' && !changed) {
        changed = true;
        writeFileSync(join(payload, 'package.json'), '{"name":"fixture","version":"9.0.0"}');
      }
      if (
        name === 'changed donor' &&
        !changed &&
        existsSync(join(stage, 'node_modules/.runtime/node_modules/fixture/index.js'))
      ) {
        changed = true;
        writeFileSync(join(payload, 'index.js'), 'module.exports = 9;\n');
      }
      return 0;
    };
    const run = () =>
      copyRuntimePackages({
        source: donor,
        from: 'package.json',
        destination: stage,
        root: 'fixture',
        packages: [
          { name: 'fixture', version: '1.0.0', edges: ['converter', 'parser'], license: 'LICENSE' },
          { name: 'converter', version: '1.0.0', edges: ['parser'], license: 'LICENSE' },
          { name: 'parser', version: '3.0.0', edges: [], license: 'LICENSE' },
        ],
        budget: limits,
      });
    if (!['copy', 'exports'].includes(name)) {
      await assert.rejects(run(), Error, name);
      if (name === 'changed donor') assert(changed);
      continue;
    }
    const notices = await run();
    assert.equal(notices.length, 3);
    assert.equal(readFileSync(notices[0].license, 'utf8'), 'exact fixture license\n');
    mkdirSync(join(stage, 'node_modules/parser'));
    writeFileSync(
      join(stage, 'node_modules/parser/package.json'),
      '{"name":"parser","version":"4.0.0","main":"index.js"}',
    );
    writeFileSync(join(stage, 'node_modules/parser/index.js'), 'module.exports = 4;\n');
    const require = createRequire(join(stage, 'package.json'));
    assert.equal(require('fixture'), 3);
    assert.equal(require('parser'), 4);
    if (name === 'exports') assert.throws(() => require.resolve('fixture/package.json'));
    await assert.rejects(run(), /EEXIST/);
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

test('single-file capture retains only the exact bounded target edit', (t) => {
  mkdirSync(resolve('internal'), { recursive: true });
  const directory = mkdtempSync(join(resolve('internal'), 'capture-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cases: {
    name: string;
    content?: Buffer;
    change?: (root: string, manifest: FileEntry[]) => void;
    accept?: boolean;
  }[] = [
    { name: 'actual edited bytes', content: Buffer.from('export {};\n'), accept: true },
    { name: 'unchanged target', accept: true },
    { name: 'empty target', content: Buffer.alloc(0), accept: true },
    { name: 'UTF-8 byte boundary', content: Buffer.from('é'.repeat(32_768)), accept: true },
    { name: 'oversized UTF-8', content: Buffer.from('é'.repeat(32_769)) },
    { name: 'invalid UTF-8', content: Buffer.from([0xc0, 0xaf]) },
    { name: 'NUL text', content: Buffer.from('a\0b') },
    { name: 'target mode drift', change: (root) => chmodSync(join(root, 'net.mjs'), 0o644) },
    { name: 'missing target', change: (root) => unlinkSync(join(root, 'net.mjs')) },
    {
      name: 'changed sibling',
      change: (root) => writeFileSync(join(root, 'sibling.bin'), 'changed'),
    },
    { name: 'deleted sibling', change: (root) => unlinkSync(join(root, 'sibling.bin')) },
    { name: 'sibling mode drift', change: (root) => chmodSync(join(root, 'sibling.bin'), 0o755) },
    { name: 'added path', change: (root) => writeFileSync(join(root, 'extra'), '') },
    {
      name: 'hardlink target',
      change: (root) => linkSync(join(root, 'net.mjs'), join(root, 'alias')),
    },
    {
      name: 'symlink target',
      change: (root) => {
        unlinkSync(join(root, 'net.mjs'));
        symlinkSync('sibling.bin', join(root, 'net.mjs'));
      },
    },
    {
      name: 'special target',
      change: (root) => {
        unlinkSync(join(root, 'net.mjs'));
        execFileSync('mkfifo', [join(root, 'net.mjs')]);
      },
    },
    {
      name: 'changed base identity',
      change: (_root, manifest) => {
        manifest[0].hash = '0'.repeat(64);
      },
    },
  ];
  for (const [index, example] of cases.entries()) {
    const root = join(directory, String(index));
    mkdirSync(root);
    const original = Buffer.from('export const original = true;\n');
    writeFileSync(join(root, 'net.mjs'), original, { mode: 0o751 });
    writeFileSync(join(root, 'sibling.bin'), Buffer.from([255, 0]));
    const manifest = readFiles(root).map(({ content: _content, ...entry }) => entry);
    const target = { path: 'net.mjs', baseHash: manifest[0].hash };
    if (example.content) writeFileSync(join(root, 'net.mjs'), example.content);
    example.change?.(root, manifest);
    if (!example.accept) {
      assert.throws(
        () => captureSingleFileEdit({ directory: root, manifest, target }),
        Error,
        example.name,
      );
      continue;
    }
    const result = captureSingleFileEdit({ directory: root, manifest, target });
    assert.deepEqual(result.files, readFiles(root), example.name);
    assert.deepEqual(
      result.files.find((file) => file.path === target.path)?.content,
      example.content ?? original,
      example.name,
    );
    assert.deepEqual(result.files[1].content, Buffer.from([255, 0]), example.name);
    assert.equal(result.target.baseHash, target.baseHash, example.name);
    assert.equal(result.target.mode, '100755', example.name);
    assert.equal(lstatSync(join(root, 'net.mjs')).mode & 0o777, 0o751, example.name);
  }
});
