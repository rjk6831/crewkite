import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
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
import { packageInventory, releaseEnvironment, signPackage } from './package-sign.mjs';

const environment = {
  CREWKITE_SIGN_IDENTITY: 'Developer ID Application: SYNTHETIC_IDENTITY',
  CREWKITE_NOTARY_PROFILE: 'SYNTHETIC_PROFILE',
};
const revision = 'a'.repeat(40);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const id = '12345678-1234-1234-1234-123456789abc';

test('release signing requires named configuration without exposing its values', () => {
  for (const key of Object.keys(environment)) {
    assert.throws(
      () => releaseEnvironment({ ...environment, [key]: '' }),
      (error) => error.message.includes(key) && !error.message.includes('SYNTHETIC'),
    );
  }
});

test('macOS release signing freezes signed hashes before the outer seal and refuses incomplete evidence', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async (t) => {
  for (const scenario of [
    'accepted',
    'changed-input',
    'linked-destination',
    'unknown-native',
    'unknown-native-swapped',
    'missing-icon',
    'nested-failure',
    'wrong-authority',
    'missing-runtime',
    'extra-entitlement',
    'notary-rejected',
    'notary-timeout',
    'staple-failure',
    'assessment-failure',
  ]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ck-sign-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, 'source');
    const linked = join(root, 'linked');
    const destination =
      scenario === 'linked-destination' ? join(linked, 'signed') : join(root, 'signed');
    const app = join(source, 'CrewKite.app');
    const runtime = join(app, 'Contents/Resources/app/runtime');
    const put = (path, bytes) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { mode: 0o644 });
    };
    const native = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
    put(join(app, 'Contents/MacOS/CrewKite'), native);
    put(join(app, 'Contents/Info.plist'), '<plist/>');
    put(
      join(app, 'Contents/Resources/app/package.json'),
      JSON.stringify({ name: 'crewkite', productName: 'CrewKite', version: '0.1.0' }),
    );
    if (scenario !== 'missing-icon')
      put(join(app, 'Contents/Resources/CrewKite.icns'), 'icnsfixture');
    for (const suffix of ['', ' (GPU)', ' (Plugin)', ' (Renderer)'])
      put(
        join(
          app,
          `Contents/Frameworks/CrewKite Helper${suffix}.app/Contents/MacOS/CrewKite Helper${suffix}`,
        ),
        native,
      );
    for (const name of ['Mantle', 'ReactiveObjC', 'Squirrel'])
      put(join(app, `Contents/Frameworks/${name}.framework/Versions/A/${name}`), native);
    put(join(app, 'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt'), native);
    put(
      join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'),
      native,
    );
    put(
      join(
        app,
        'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib',
      ),
      native,
    );
    put(join(runtime, 'bin/node'), native);
    put(join(runtime, 'bin/local-secure-input'), native);
    put(join(runtime, 'apps/controller/src/providers/local/secure-input.m'), 'helper source');
    if (scenario === 'unknown-native') put(join(runtime, 'bin/unreviewed'), native);
    if (scenario === 'unknown-native-swapped')
      put(join(runtime, 'bin/unreviewed'), Buffer.from([0xbf, 0xba, 0xfe, 0xca]));
    const runtimeManifest = {
      version: 1,
      mode: 'workspace',
      layout: 'installed',
      node: { version: '24.22.0', platform: 'darwin', arch: 'arm64', sha256: hash(native) },
      localInput: {
        sha256: hash(native),
        sourceHash: hash('helper source'),
        target: 'darwin-arm64',
        minOS: '13.5.0',
      },
    };
    put(join(runtime, 'manifest.json'), JSON.stringify(runtimeManifest));
    put(
      join(source, 'manifest.json'),
      JSON.stringify({
        format: 2,
        layout: 'installed',
        mode: 'workspace',
        revision,
        platform: 'darwin',
        architecture: 'arm64',
        electron: { bundle: 'CrewKite.app' },
        buildInputs: {
          nodeSha256: 'b468fb9c67427c9d3aec07ee1105e63020923a631a9a2a00beb71a7ba3768bfd',
          localInputSha256: hash(native),
        },
        files: packageInventory(source),
      }),
    );
    if (scenario === 'changed-input') appendFileSync(join(runtime, 'bin/node'), 'changed');
    if (scenario === 'linked-destination') symlinkSync(source, linked);
    const sourceBefore = packageInventory(source);
    const calls = [],
      signatures = new Map();
    const execute = async (tool, args) => {
      calls.push([tool, args]);
      const path = args.at(-1);
      if (tool.endsWith('/plutil')) {
        const helper = path.match(/Frameworks\/(CrewKite Helper[^/]*).app\/Contents/);
        const name = helper ? helper[1] : 'CrewKite';
        const role = name.match(/\(([^)]+)\)/)?.[1]?.toLowerCase();
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({
            CFBundleName: name,
            CFBundleDisplayName: name,
            CFBundleExecutable: name,
            CFBundleIdentifier: `com.rootsnolimits.crewkite${helper ? `.helper${role ? `.${role}` : ''}` : ''}`,
            CFBundleVersion: '0.1.0',
            CFBundleShortVersionString: '0.1.0',
            CFBundleIconFile: 'CrewKite.icns',
          }),
        };
      }
      if (tool.endsWith('/codesign') && args.includes('--force')) {
        assert.ok(!args.includes('--deep'));
        if (scenario === 'nested-failure')
          throw Error(
            `${environment.CREWKITE_SIGN_IDENTITY} ${environment.CREWKITE_NOTARY_PROFILE}`,
          );
        const entitlements = args.includes('--entitlements')
          ? readFileSync(args[args.indexOf('--entitlements') + 1], 'utf8')
          : '';
        signatures.set(path, entitlements.includes('allow-jit'));
        if (lstatSync(path).isFile()) appendFileSync(path, '\nsigned');
        if (path === join(destination, 'CrewKite.app')) {
          const current = JSON.parse(
            readFileSync(join(path, 'Contents/Resources/app/runtime/manifest.json'), 'utf8'),
          );
          assert.equal(
            current.node.sha256,
            hash(readFileSync(join(path, 'Contents/Resources/app/runtime/bin/node'))),
          );
          assert.equal(
            current.localInput.sha256,
            hash(readFileSync(join(path, 'Contents/Resources/app/runtime/bin/local-secure-input'))),
          );
        }
      }
      if (tool.endsWith('/codesign') && args.includes('--display')) {
        if (args.includes('--entitlements'))
          return {
            status: 0,
            stderr: '',
            stdout: `<plist><dict>${signatures.get(path) ? '<key>com.apple.security.cs.allow-jit</key><true/>' : ''}${scenario === 'extra-entitlement' ? '<key>com.apple.security.get-task-allow</key><true/>' : ''}</dict></plist>`,
          };
        return {
          status: 0,
          stdout: '',
          stderr: `Authority=${scenario === 'wrong-authority' ? 'different' : environment.CREWKITE_SIGN_IDENTITY}\nflags=${scenario === 'missing-runtime' ? '0' : '0x10000(runtime)'}`,
        };
      }
      if (tool.endsWith('/ditto')) put(path, 'notary archive');
      if (args[0] === 'notarytool') {
        if (args[1] === 'submit') return { status: 0, stderr: '', stdout: JSON.stringify({ id }) };
        if (args[1] === 'wait') {
          if (scenario === 'notary-timeout')
            return { status: null, signal: 'SIGKILL', stderr: 'SYNTHETIC_SECRET', stdout: '' };
          return {
            status: 0,
            stderr: '',
            stdout: JSON.stringify({
              id,
              status: scenario === 'notary-rejected' ? 'Invalid' : 'Accepted',
            }),
          };
        }
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({
            status: 'Accepted',
            issues: [{ severity: 'warning', message: 'SYNTHETIC_SECRET' }],
          }),
        };
      }
      if (args[0] === 'stapler') {
        assert.ok(path.endsWith('CrewKite.app'));
        if (scenario === 'staple-failure')
          return { status: 1, stderr: 'SYNTHETIC_SECRET', stdout: '' };
      }
      if (tool.endsWith('/spctl') && scenario === 'assessment-failure')
        return { status: 1, stderr: 'SYNTHETIC_SECRET', stdout: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    if (scenario === 'accepted') {
      const result = await signPackage({ source, destination, revision, environment }, { execute });
      const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'));
      assert.equal(receipt.notary.warnings, 1);
      assert.notEqual(receipt.runtime.node.sha256, runtimeManifest.node.sha256);
      assert.deepEqual(receipt.buildInputs.localInputSha256, runtimeManifest.localInput.sha256);
      assert.ok(!readFileSync(result.receipt, 'utf8').includes('SYNTHETIC'));
      assert.ok(signatures.get(join(result.app, 'Contents/Resources/app/runtime/bin/node')));
      assert.equal(
        signatures.get(join(result.app, 'Contents/Resources/app/runtime/bin/local-secure-input')),
        false,
      );
      const signed = calls
        .filter(([tool, args]) => tool.endsWith('/codesign') && args.includes('--force'))
        .map(([, args]) => args.at(-1));
      assert.ok(
        signed.indexOf(
          join(
            result.app,
            'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib',
          ),
        ) < signed.indexOf(join(result.app, 'Contents/Frameworks/Electron Framework.framework')),
      );
      assert.equal(signed.at(-1), result.app);
    } else {
      await assert.rejects(
        signPackage({ source, destination, revision, environment }, { execute }),
        (error) => !error.message.includes('SYNTHETIC'),
      );
      assert.equal(existsSync(join(destination, 'release-receipt.json')), false);
      if (scenario === 'notary-timeout')
        assert.equal(
          JSON.parse(readFileSync(join(destination, 'notary-app-state.json'), 'utf8')).id,
          id,
        );
    }
    assert.deepEqual(packageInventory(source), sourceBefore, scenario);
  }
});
