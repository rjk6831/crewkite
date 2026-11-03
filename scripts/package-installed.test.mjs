import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assembleInstalledPackage, brandMacPackage } from './package-installed.mjs';

test('installed assembly preserves runtime bytes and refuses directory state', {
  skip: process.platform !== 'darwin',
}, (t) => {
  for (const installed of [false, true]) {
    const stage = mkdtempSync(join(tmpdir(), 'package-installed-'));
    t.after(() => rmSync(stage, { recursive: true, force: true }));
    const put = (path, content = path) => {
      mkdirSync(dirname(join(stage, path)), { recursive: true });
      writeFileSync(join(stage, path), content);
    };
    const plist = JSON.stringify({ CFBundleName: 'Electron', LSMinimumSystemVersion: '13.0' });
    put('Electron.app/Contents/Info.plist', plist);
    put('Electron.app/Contents/MacOS/Electron', 'main-executable');
    put('Electron.app/Contents/Resources/default_app.asar', 'upstream-resource');
    for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
      const base = `Electron.app/Contents/Frameworks/Electron Helper${suffix}.app/Contents`;
      put(`${base}/Info.plist`, plist);
      put(`${base}/MacOS/Electron Helper${suffix}`, `helper${suffix}`);
    }
    const node = { version: '24.22.0', platform: 'darwin', arch: 'arm64', sha256: 'node-hash' };
    put('app/runtime/manifest.json', JSON.stringify({ version: 1, mode: 'workspace', node }));
    put('app/runtime/bin/node', 'node-bytes');
    put('app/runtime/bin/local-secure-input', 'helper-bytes');
    put('app/runtime/apps/cli/src/installed.ts', 'cli-entry');
    put('app/runtime/apps/controller/src/providers/file-digest-worker.ts', 'digest-worker');
    put(
      'app/package.json',
      JSON.stringify({ name: '@crewkite/desktop', main: 'out/main/index.js' }),
    );
    for (const entry of [
      'LICENSE',
      'NOTICE',
      'README.md',
      'docs/credits.md',
      'notices/node-LICENSE',
      'CrewKite.command',
      'Upgrade Existing.command',
      'bin/desktop',
      'bin/crewkite',
      'scripts/package-upgrade.mjs',
    ])
      put(entry);
    if (installed) {
      mkdirSync(join(stage, 'state'));
      assert.throws(() => assembleInstalledPackage({ stage, version: '0.1.0' }), /state/);
      assert.ok(existsSync(join(stage, 'Electron.app')));
      rmSync(join(stage, 'state'), { recursive: true });
    }
    const result = installed
      ? assembleInstalledPackage({ stage, version: '0.1.0' })
      : {
          app: brandMacPackage({ stage, version: '0.1.0' }),
          runtime: join(stage, 'app/runtime'),
          requiredEntries: [],
        };
    for (const entry of result.requiredEntries) assert.ok(existsSync(join(stage, entry)), entry);
    assert.equal(readFileSync(join(result.runtime, 'bin/node'), 'utf8'), 'node-bytes');
    assert.equal(
      readFileSync(join(result.runtime, 'bin/local-secure-input'), 'utf8'),
      'helper-bytes',
    );
    assert.deepEqual(JSON.parse(readFileSync(join(result.runtime, 'manifest.json'), 'utf8')), {
      version: 1,
      mode: 'workspace',
      node,
      ...(installed ? { layout: 'installed' } : {}),
    });
    const branded = JSON.parse(
      execFileSync(
        '/usr/bin/plutil',
        ['-convert', 'json', '-o', '-', join(result.app, 'Contents/Info.plist')],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(branded.CFBundleIdentifier, 'com.rootsnolimits.crewkite');
    assert.equal(branded.CFBundleExecutable, 'CrewKite');
    assert.equal(branded.LSMinimumSystemVersion, '13.0');
    assert.equal(existsSync(join(stage, 'bin')), !installed);
    assert.equal(existsSync(join(stage, 'CrewKite.command')), !installed);
    for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
      const base = join(result.app, 'Contents/Frameworks', `CrewKite Helper${suffix}.app/Contents`);
      const helper = JSON.parse(
        execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(base, 'Info.plist')], {
          encoding: 'utf8',
        }),
      );
      assert.equal(helper.CFBundleExecutable, `CrewKite Helper${suffix}`);
      assert.equal(helper.CFBundleName, `CrewKite Helper${suffix}`);
      assert.equal(
        helper.CFBundleIdentifier,
        `com.rootsnolimits.crewkite.helper${suffix ? `.${suffix.slice(2, -1).toLowerCase()}` : ''}`,
      );
      assert.equal(
        readFileSync(join(base, 'MacOS', helper.CFBundleExecutable), 'utf8'),
        `helper${suffix}`,
      );
    }
  }
});
