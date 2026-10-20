import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sealElectronBundle } from './package.mjs';

test('a staged app resource seal rejects changed resources', {
  skip: process.platform !== 'darwin',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'package-seal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'Fixture.app');
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(bundle, 'Contents/Resources'));
  copyFileSync('/usr/bin/true', join(bundle, 'Contents/MacOS/Fixture'));
  writeFileSync(
    join(bundle, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleIdentifier</key><string>org.example.package-seal</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
  );
  const resource = join(bundle, 'Contents/Resources/value.txt');
  writeFileSync(resource, 'original');
  const verify = () =>
    spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
      timeout: 30000,
      maxBuffer: 65536,
    });
  assert.notEqual(verify().status, 0);
  assert.deepEqual(sealElectronBundle(bundle), {
    kind: 'ad-hoc',
    verified: 'deep-strict',
    developerID: false,
    notarized: false,
  });
  assert.equal(verify().status, 0);
  writeFileSync(resource, 'changed');
  assert.notEqual(verify().status, 0);
});

test('staging refuses a failed or unfinished seal or verification', () => {
  for (const failedStep of [0, 1]) {
    for (const result of [
      { status: 1 },
      { status: null, signal: 'SIGTERM' },
      { error: new Error('timeout') },
    ]) {
      let calls = 0;
      assert.throws(
        () =>
          sealElectronBundle('/staged/Electron.app', () => {
            return calls++ === failedStep ? result : { status: 0 };
          }),
        /resource seal/,
      );
      assert.equal(calls, failedStep + 1);
    }
  }
});
