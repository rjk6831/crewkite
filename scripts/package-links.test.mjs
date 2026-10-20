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
import { copyPackagePayload } from './package.mjs';

test('runtime package aliases stay contained after copying and relocation', (t) => {
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
});
