import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import { cliRendererModules } from './cli-runtime.ts';
import { copyPackagePayload } from './package.mjs';
import { copyRuntimeStore } from './runtime-packages.ts';

test('runtime package aliases stay contained after copying and relocation', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'package-links-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const kind of [
    'store self alias',
    'relative alias',
    'absolute alias',
    'escape',
    'excluded target',
  ]) {
    const root = join(directory, kind);
    const donor = join(root, 'donor');
    const source = join(donor, 'store/fixture');
    const stage = join(root, 'stage');
    const destination = join(stage, 'node_modules/fixture');
    mkdirSync(join(source, 'lib'), { recursive: true });
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(join(source, 'package.json'), '{"name":"fixture","main":"index.cjs"}');
    writeFileSync(join(source, 'index.cjs'), 'module.exports = 42;\n');
    writeFileSync(join(source, 'lib/value.cjs'), 'module.exports = 42;\n');
    let alias = join(source, 'alias.cjs');
    let target = 'lib/value.cjs';
    if (kind === 'store self alias') {
      const installed = join(donor, 'packages/contracts/node_modules/fixture');
      mkdirSync(dirname(installed), { recursive: true });
      symlinkSync(relative(dirname(installed), source), installed);
      alias = join(source, 'fixture');
      target = relative(source, installed);
    } else if (kind === 'absolute alias') target = join(source, 'lib/value.cjs');
    else if (kind === 'escape') {
      target = join(donor, 'outside.cjs');
      writeFileSync(target, 'module.exports = 99;\n');
    } else if (kind === 'excluded target') {
      mkdirSync(join(source, 'src'));
      writeFileSync(join(source, 'src/value.cjs'), 'module.exports = 99;\n');
      target = 'src/value.cjs';
    }
    symlinkSync(target, alias);
    if (kind === 'escape' || kind === 'excluded target') {
      assert.throws(() => copyPackagePayload(source, destination, ['src']), Error, kind);
      assert.equal(readlinkSync(alias), target);
      continue;
    }
    copyPackagePayload(source, destination, ['src']);
    assert.equal(readlinkSync(alias), target);
    const copied = join(destination, relative(source, alias));
    assert(lstatSync(copied).isSymbolicLink());
    assert(!isAbsolute(readlinkSync(copied)));
    const relocated = join(root, 'relocated');
    renameSync(stage, relocated);
    rmSync(donor, { recursive: true });
    const require = createRequire(join(relocated, 'package.json'));
    assert.equal(require('fixture'), 42);
    assert.equal(
      require(kind === 'store self alias' ? 'fixture/fixture' : 'fixture/alias.cjs'),
      42,
    );
    assert(realpathSync(require.resolve('fixture')).startsWith(`${relocated}/`));
    assert.equal(
      readFileSync(join(relocated, 'node_modules/fixture/lib/value.cjs'), 'utf8'),
      'module.exports = 42;\n',
    );
    assert.equal(existsSync(donor), false);
  }

  // A store holds two versions of one package, each reached only by the package that asked for
  // it, drops the installer's command shims, takes an upstream notice for a package without a
  // license file, and still resolves after the stage moves.
  const store = join(directory, 'store');
  const installed = join(store, 'source/node_modules/.pnpm');
  const put = (name, version, dependencies, license = true) => {
    const folder = join(installed, `${name}@${version}/node_modules/${name}`);
    mkdirSync(join(folder, 'node_modules/.bin'), { recursive: true });
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({ name, version, main: 'index.cjs', dependencies }),
    );
    const requires = Object.keys(dependencies)
      .map((dependency) => `require('${dependency}')`)
      .join(', ');
    writeFileSync(
      join(folder, 'index.cjs'),
      `module.exports = ['${name}@${version}', ${requires}].flat();\n`,
    );
    if (license) writeFileSync(join(folder, 'LICENSE'), `${name} license\n`);
    for (const [dependency, wanted] of Object.entries(dependencies))
      symlinkSync(
        join(installed, `${dependency}@${wanted}/node_modules/${dependency}`),
        join(dirname(folder), dependency),
      );
  };
  put('shade', '2.0.0', {});
  put('shade', '1.0.0', {});
  put('wrap', '1.0.0', { shade: '1.0.0' }, false);
  put('top', '1.0.0', { shade: '2.0.0', wrap: '1.0.0' });
  mkdirSync(join(store, 'source/apps/cli/node_modules'), { recursive: true });
  mkdirSync(join(store, 'source/notices'));
  writeFileSync(join(store, 'source/notices/wrap-LICENSE'), 'wrap upstream license\n');
  writeFileSync(join(store, 'source/apps/cli/package.json'), '{"dependencies":{"top":"1.0.0"}}');
  symlinkSync(
    join(installed, 'top@1.0.0/node_modules/top'),
    join(store, 'source/apps/cli/node_modules/top'),
  );
  mkdirSync(join(store, 'stage/apps/cli'), { recursive: true });
  const budget = {
    deadline: Date.now() + 60_000,
    now: Date.now,
    maximumEntries: 10_000,
    maximumBytes: 1 << 24,
  };
  const copied = await copyRuntimeStore({
    source: join(store, 'source'),
    from: 'apps/cli/package.json',
    destination: join(store, 'stage/apps/cli'),
    realm: '.cli-store',
    roots: ['top'],
    packages: [
      { name: 'top', version: '1.0.0', edges: ['shade', 'wrap'], license: 'LICENSE' },
      {
        name: 'wrap',
        version: '1.0.0',
        edges: ['shade'],
        license: 'LICENSE',
        notice: 'notices/wrap-LICENSE',
      },
      { name: 'shade', version: '1.0.0', edges: [], license: 'LICENSE' },
      { name: 'shade', version: '2.0.0', edges: [], license: 'LICENSE' },
    ],
    budget,
  });
  assert.deepEqual(copied.map((item) => `${item.name}@${item.version}`).sort(), [
    'shade@1.0.0',
    'shade@2.0.0',
    'top@1.0.0',
    'wrap@1.0.0',
  ]);
  assert.equal(
    readFileSync(copied.find((item) => item.name === 'wrap').license, 'utf8'),
    'wrap upstream license\n',
  );
  renameSync(join(store, 'stage'), join(store, 'moved'));
  rmSync(join(store, 'source'), { recursive: true });
  const fromCli = createRequire(join(store, 'moved/apps/cli/package.json'));
  assert.deepEqual(fromCli('top'), ['top@1.0.0', 'shade@2.0.0', 'wrap@1.0.0', 'shade@1.0.0']);
  assert.equal(
    existsSync(
      join(store, 'moved/apps/cli/node_modules/.cli-store/top@1.0.0/node_modules/top/node_modules'),
    ),
    false,
  );
  // The interactive CLI's renderer imports are found from its entry, value imports only.
  const modules = cliRendererModules(join(import.meta.dirname, '..'));
  assert(modules.includes('apps/desktop/src/renderer/thread/thread-state.ts'));
  assert(!modules.some((path) => path.endsWith('.tsx') || path.endsWith('/source.ts')));
});
