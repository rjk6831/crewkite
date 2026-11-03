import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildDmg } from './package-dmg.mjs';
import { packageInventory } from './package-sign.mjs';

const revision = 'a'.repeat(40);
const environment = {
  CREWKITE_SIGN_IDENTITY: 'Developer ID Application: SYNTHETIC_IDENTITY',
  CREWKITE_NOTARY_PROFILE: 'SYNTHETIC_PROFILE',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const id = '12345678-1234-1234-1234-123456789abc';

test('macOS disk images retain the attested app and hash only final stapled bytes', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async (t) => {
  for (const scenario of [
    'accepted',
    'changed-source',
    'linked-destination',
    'wrong-identity',
    'notary-rejected',
    'mounted-change',
    'mounted-extra',
    'failed-detach',
  ]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ck-dmg-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, 'signed');
    const linked = join(root, 'linked');
    const destination =
      scenario === 'linked-destination' ? join(linked, 'image') : join(root, 'image');
    const app = join(source, 'CrewKite.app');
    const runtime = join(app, 'Contents/Resources/app/runtime');
    const put = (path, bytes) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    };
    put(join(runtime, 'bin/node'), 'node');
    put(join(runtime, 'bin/local-secure-input'), 'helper');
    put(join(runtime, 'apps/controller/src/providers/local/secure-input.m'), 'source');
    put(
      join(runtime, 'manifest.json'),
      JSON.stringify({
        version: 1,
        mode: 'workspace',
        layout: 'installed',
        node: { version: '24.22.0', platform: 'darwin', arch: 'arm64', sha256: hash('node') },
        localInput: {
          sha256: hash('helper'),
          sourceHash: hash('source'),
          target: 'darwin-arm64',
          minOS: '13.5.0',
        },
      }),
    );
    put(
      join(source, 'release-receipt.json'),
      JSON.stringify({
        version: 1,
        kind: 'signed-app',
        productVersion: '0.1.0',
        revision,
        app: 'CrewKite.app',
        developerID: true,
        hardenedRuntime: true,
        notary: { status: 'Accepted', stapled: true },
        assessment: { accepted: true },
        files: packageInventory(app),
      }),
    );
    if (scenario === 'changed-source') appendFileSync(join(runtime, 'bin/node'), 'changed');
    if (scenario === 'linked-destination') symlinkSync(source, linked);
    const before = packageInventory(source);
    let detached = false;
    const execute = async (tool, args) => {
      const path = args.at(-1);
      if (tool.endsWith('/codesign') && args.includes('--display'))
        return {
          status: 0,
          stdout: '',
          stderr: `Authority=${scenario === 'wrong-identity' ? 'different' : environment.CREWKITE_SIGN_IDENTITY}\nflags=0x10000(runtime)`,
        };
      if (tool.endsWith('/codesign') && args.includes('--force')) appendFileSync(path, '\nsigned');
      if (tool.endsWith('/ditto'))
        cpSync(args[0], args[1], { recursive: true, verbatimSymlinks: true });
      if (tool.endsWith('/hdiutil')) {
        if (args[0] === 'create') put(path, 'image');
        if (args[0] === 'attach') {
          const mount = args[args.indexOf('-mountpoint') + 1];
          cpSync(join(destination, 'image-source/CrewKite.app'), join(mount, 'CrewKite.app'), {
            recursive: true,
          });
          symlinkSync('/Applications', join(mount, 'Applications'));
          if (scenario === 'mounted-change')
            appendFileSync(
              join(mount, 'CrewKite.app/Contents/Resources/app/runtime/bin/node'),
              'changed',
            );
          if (scenario === 'mounted-extra') put(join(mount, 'unexpected'), 'unrecorded payload');
        }
        if (args[0] === 'detach') {
          detached = true;
          if (scenario === 'failed-detach')
            return { status: 1, stdout: '', stderr: 'SYNTHETIC_SECRET' };
        }
      }
      if (args[0] === 'notarytool') {
        if (args[1] === 'submit') return { status: 0, stderr: '', stdout: JSON.stringify({ id }) };
        if (args[1] === 'wait')
          return {
            status: 0,
            stderr: '',
            stdout: JSON.stringify({
              id,
              status: scenario === 'notary-rejected' ? 'Invalid' : 'Accepted',
            }),
          };
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({ status: 'Accepted', issues: null }),
        };
      }
      if (args[0] === 'stapler' && args[1] === 'staple') appendFileSync(path, '\nstapled');
      return { status: 0, stdout: '', stderr: '' };
    };
    if (scenario === 'accepted') {
      const result = await buildDmg({ source, destination, revision, environment }, { execute });
      assert.equal(result.image, join(destination, 'CrewKite-macOS-arm64.dmg'));
      assert.equal(result.sha256, hash('image\nsigned\nstapled'));
      assert.equal(
        readFileSync(join(destination, 'SHA256SUMS'), 'utf8'),
        `${result.sha256}  CrewKite-macOS-arm64.dmg\n`,
      );
      assert.ok(!readFileSync(result.receipt, 'utf8').includes('SYNTHETIC'));
      assert.equal(detached, true);
    } else {
      await assert.rejects(
        buildDmg({ source, destination, revision, environment }, { execute }),
        (error) => !error.message.includes('SYNTHETIC'),
      );
      assert.equal(existsSync(join(destination, 'dmg-receipt.json')), false);
      assert.equal(existsSync(join(destination, 'SHA256SUMS')), false);
      if (
        scenario === 'mounted-change' ||
        scenario === 'mounted-extra' ||
        scenario === 'failed-detach'
      )
        assert.equal(detached, true);
    }
    assert.deepEqual(packageInventory(source), before);
  }
});
