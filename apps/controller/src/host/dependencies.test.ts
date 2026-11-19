import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEPENDENCIES_NEED_PREPARATION, DEPENDENCIES_OVER_LIMIT } from '@crewkite/contracts';
import { createTestClock, createTestIds } from '@crewkite/testkit';
import { Store } from '../store/index.ts';
import { DependencyPreparer } from './dependencies.ts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));

const LOCKS = {
  npm: {
    file: 'package-lock.json',
    body: JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/tiny': { version: '1.2.3' } },
    }),
  },
  pnpm: {
    file: 'pnpm-lock.yaml',
    body: [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      tiny:',
      '        specifier: ^1.0.0',
      '        version: 1.2.3',
      '',
    ].join('\n'),
  },
} as const;

type Options = {
  lock?: keyof typeof LOCKS;
  /** Committed files added to the project and its copy, or replacing the default ones. */
  files?: Record<string, string>;
  extra?: (project: string) => void;
  limitBytes?: number;
};

/**
 * A project folder with an installed tree, the thread's scratch copy of its committed files, and a
 * preparer over a real store. The manifest asks for a range. The lockfile resolved 1.2.3.
 */
function harness(t: TestContext, options: Options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'crewkite-deps-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'shop');
  const home = join(base, 'home');
  const lock = LOCKS[options.lock ?? 'npm'];
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { tiny: '^1.0.0' } }),
    [lock.file]: lock.body,
    '.gitignore': 'node_modules\n',
    ...options.files,
  };
  mkdirSync(join(project, 'node_modules/tiny'), { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), body);
  }
  writeFileSync(
    join(project, 'node_modules/tiny/package.json'),
    JSON.stringify({ name: 'tiny', version: '1.2.3' }),
  );
  writeFileSync(join(project, 'node_modules/tiny/index.js'), 'module.exports = 1;\n');
  symlinkSync('tiny/index.js', join(project, 'node_modules/tiny-main'));
  options.extra?.(project);
  const run = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: project, stdio: 'pipe' },
    );
  run('init', '-q');
  run('add', '.');
  run('commit', '-q', '-m', 'init');

  const clock = createTestClock();
  const ids = createTestIds(clock.now());
  const taskId = ids('tsk');
  const scratch = join(home, 'chat', taskId, 'scratch');
  mkdirSync(scratch, { recursive: true });
  for (const path of Object.keys(files)) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), files[path]);
  }

  const store = new Store(join(base, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(migrations);
  store.transaction(() => store.put('task', taskId, 0, { id: taskId, projectId: 'prj_x' }));
  const preparer = (runtime?: string) =>
    new DependencyPreparer({
      store,
      home,
      now: clock.now,
      id: () => `prp_${ids('msg').slice(4)}`,
      projectPath: () => project,
      runtime,
      limitBytes: options.limitBytes,
    });
  return { base, project, home, scratch, taskId, store, preparer };
}

const links = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => join(entry.parentPath, entry.name));

test('npm and pnpm projects each prepare an independent copy and record what it came from', async (t) => {
  for (const lock of ['npm', 'pnpm'] as const) {
    const { project, scratch, taskId, store, preparer } = harness(t, { lock });
    const record = await preparer().prepare(taskId, 'thread', 'main');
    assert(record && record !== 'busy');
    assert.deepEqual([record.state, record.layout, record.reason], ['prepared', lock, null]);
    assert.deepEqual(Object.keys(record.inputs.manifestDigests), ['package.json']);
    assert.match(record.inputs.lockfileDigest ?? '', /^[a-f0-9]{64}$/);
    assert.match(record.treeDigest ?? '', /^[a-f0-9]{64}$/);
    assert.equal(record.inputs.runtime, `node@${process.versions.node}`);
    assert.ok((record.bytes ?? 0) > 0);
    assert.deepEqual(store.dependencyPreparations(taskId), [record]);

    // Files are copies, and the one link points inside the copy.
    const copy = join(scratch, 'node_modules/tiny/index.js');
    assert.notEqual(
      lstatSync(copy).ino,
      lstatSync(join(project, 'node_modules/tiny/index.js')).ino,
    );
    const copied = links(join(scratch, 'node_modules'));
    assert.equal(copied.length, 1);
    assert(realpathSync(copied[0]).startsWith(`${realpathSync(scratch)}/`));
    const ready = preparer().environment(taskId, 'thread', 'main');
    assert.deepEqual(ready, { ok: true, directory: scratch, layout: lock, env: { NODE_PATH: '' } });
  }
});

test('a changed lockfile or runtime marks the preparation stale and shows the need line', async (t) => {
  const { project, taskId, store, preparer } = harness(t);
  await preparer().prepare(taskId, 'thread', 'main');
  for (const [name, reason, change] of [
    [
      'runtime',
      'stale-runtime',
      () => preparer('node@1.0.0').environment(taskId, 'thread', 'main'),
    ],
    [
      'lockfile',
      'stale-lockfile',
      () => {
        writeFileSync(join(project, 'package-lock.json'), LOCKS.npm.body.replace('1.2.3', '1.2.4'));
        return preparer().environment(taskId, 'thread', 'main');
      },
    ],
  ] as const) {
    const result = change();
    assert(!result.ok, name);
    assert.equal(result.reason, reason);
    assert(result.message.startsWith(DEPENDENCIES_NEED_PREPARATION), name);
    assert.equal(store.dependencyPreparations(taskId)[0]?.state, 'stale');
    assert.equal(store.dependencyPreparations(taskId)[0]?.reason, reason);
    // A stale record stays stale until the person prepares again.
    assert(!preparer().environment(taskId, 'thread', 'main').ok);
    if (name === 'runtime') await preparer().prepare(taskId, 'thread', 'main');
  }
});

test('an over-limit tree keeps nothing, and yarn PnP and a tracked node_modules are unsupported', async (t) => {
  const big = harness(t, { limitBytes: 10 });
  const record = await big.preparer().prepare(big.taskId, 'thread', 'main');
  assert(record && record !== 'busy');
  assert.deepEqual([record.state, record.reason], ['failed', 'size-limit']);
  assert.equal(existsSync(join(big.scratch, 'node_modules')), false);
  const refused = big.preparer().environment(big.taskId, 'thread', 'main');
  assert(!refused.ok);
  assert.equal(refused.message, DEPENDENCIES_OVER_LIMIT);

  for (const [reason, extra] of [
    ['yarn-pnp', (project: string) => writeFileSync(join(project, '.pnp.cjs'), '')],
    [
      'tracked-dependency-root',
      (project: string) => {
        execFileSync('git', ['init', '-q'], { cwd: project });
        execFileSync('git', ['add', '-f', 'node_modules/tiny/index.js'], { cwd: project });
      },
    ],
  ] as const) {
    const unsupported = harness(t, { extra });
    const result = await unsupported.preparer().prepare(unsupported.taskId, 'thread', 'main');
    assert(result && result !== 'busy');
    assert.deepEqual(
      [result.state, result.layout, result.reason],
      ['unsupported', 'unsupported', reason],
    );
    assert.equal(existsSync(join(unsupported.scratch, 'node_modules')), false);
  }
});

test('a module in an ancestor node_modules is not found from the prepared directory', async (t) => {
  const leak = (root: string) => {
    mkdirSync(join(root, 'node_modules/leak'), { recursive: true });
    writeFileSync(join(root, 'node_modules/leak/index.js'), 'module.exports = 2;\n');
  };
  const clean = harness(t);
  leak(join(clean.base, 'elsewhere'));
  await clean.preparer().prepare(clean.taskId, 'thread', 'main');
  const from = createRequire(join(clean.scratch, 'check.js'));
  assert.equal(from('tiny'), 1);
  assert.throws(() => from.resolve('leak'), { code: 'MODULE_NOT_FOUND' });

  // With a node_modules above the copy, Node would find that package, so no copy is made.
  const leaky = harness(t);
  leak(leaky.base);
  const record = await leaky.preparer().prepare(leaky.taskId, 'thread', 'main');
  assert(record && record !== 'busy');
  assert.deepEqual([record.state, record.reason], ['failed', 'copy-failed']);
  assert.equal(existsSync(join(leaky.scratch, 'node_modules')), false);
});

test('a pnpm workspace prepares with its workspace links, and a link that leaves the project is refused', async (t) => {
  // pnpm 9 writes link: in the lockfile for every workspace:* dependency. CrewKite's own
  // repository is such a workspace, so refusing them left every gate without dependencies.
  const workspace = (link: string) => ({
    'package.json': JSON.stringify({
      name: 'shop',
      dependencies: { tiny: '^1.0.0', lib: 'workspace:*' },
    }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'packages/lib/package.json': JSON.stringify({ name: 'lib', version: '0.0.0' }),
    'pnpm-lock.yaml': [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      lib:',
      '        specifier: workspace:*',
      `        version: ${link}`,
      '      tiny:',
      '        specifier: ^1.0.0',
      '        version: 1.2.3',
      '',
      '  packages/lib: {}',
      '',
    ].join('\n'),
  });
  const installed = (project: string) => {
    mkdirSync(join(project, 'packages/lib/node_modules'), { recursive: true });
    symlinkSync('../packages/lib', join(project, 'node_modules/lib'));
  };
  for (const [link, state, reason] of [
    ['link:packages/lib', 'prepared', null],
    ['link:../outside', 'unsupported', 'external-link'],
  ] as const) {
    const { scratch, taskId, preparer } = harness(t, {
      lock: 'pnpm',
      files: workspace(link),
      extra: installed,
    });
    const record = await preparer().prepare(taskId, 'thread', 'main');
    assert(record && record !== 'busy');
    assert.deepEqual([record.state, record.reason], [state, reason], link);
    if (state !== 'prepared') continue;
    assert.equal(record.layout, 'pnpm-workspace');
    // The workspace link is carried as a link that stays inside the copy.
    const copied = join(scratch, 'node_modules/lib');
    assert(lstatSync(copied).isSymbolicLink());
    assert.equal(realpathSync(copied), realpathSync(join(scratch, 'packages/lib')));
    assert.equal(preparer().environment(taskId, 'thread', 'main').ok, true);
  }
});

test('a copy whose manifest moved is stale for that reason, even when its package manager line moved too', async (t) => {
  // A packageManager difference reads as a runtime reason, which a prepare passes over. It must
  // not hide the manifest difference behind it. The copy's own file check still stops the copy,
  // but it says the copy failed, where the true answer is that the copy's manifest moved.
  const { scratch, taskId, preparer } = harness(t);
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({
      name: 'shop',
      packageManager: 'npm@10.0.0',
      dependencies: { tiny: '^1.0.0', other: '^2.0.0' },
    }),
  );
  const record = await preparer().prepare(taskId, 'thread', 'main');
  assert(record && record !== 'busy');
  assert.deepEqual([record.state, record.reason], ['stale', 'stale-manifest']);
  assert.equal(existsSync(join(scratch, 'node_modules')), false);
});
