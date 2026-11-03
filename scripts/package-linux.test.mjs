import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertLinuxExecutable,
  inspectLinuxElf,
  linuxTarget,
  verifyLinuxNode,
} from './package-linux.mjs';

test('Linux dependency evidence inspects every real ELF without executing payloads', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'linux-elf-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => inspectLinuxElf(root), /no ELF/);
  mkdirSync(join(root, 'nested'));
  for (const path of ['crewkite', 'nested/lib.so'])
    writeFileSync(join(root, path), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  writeFileSync(join(root, 'resource'), 'data');
  symlinkSync('crewkite', join(root, 'alias'));
  const calls = [];
  const evidence = inspectLinuxElf(root, (command, args) => {
    assert.equal(command, 'readelf');
    assert.deepEqual(args.slice(0, -1), [
      '--wide',
      '--file-header',
      '--program-headers',
      '--dynamic',
      '--version-info',
    ]);
    calls.push(args.at(-1));
    return 'NEEDED libc.so.6 GLIBC_2.34';
  });
  assert.deepEqual(
    evidence.map((file) => file.path),
    ['crewkite', 'nested/lib.so'],
  );
  assert.equal(calls.length, 2);
  assert.ok(evidence.every((file) => file.readelf === 'NEEDED libc.so.6 GLIBC_2.34'));
  assert.throws(
    () =>
      inspectLinuxElf(root, () => {
        throw new Error('inspection failed');
      }),
    /inspection failed/,
  );
});

test('Linux runtime inputs refuse changed pins and mismatched executable identities', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'linux-runtime-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  for (const arch of ['x64', 'arm64']) {
    const directory = join(root, arch);
    mkdirSync(directory);
    const bytes = Buffer.alloc(64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
    const node = join(directory, 'node');
    const archive = join(directory, 'archive');
    writeFileSync(node, bytes, { mode: 0o755 });
    writeFileSync(archive, 'archive', { mode: 0o644 });
    const values = { node, archive, arch, sha256: hash(bytes), archiveSha256: hash('archive') };
    for (const [change, failure, calls] of [
      [{}, null, 1],
      [{ sha256: undefined }, /Reviewed/, 0],
      [{ archiveSha256: undefined }, /Reviewed/, 0],
      [{ sha256: '0'.repeat(64) }, /executable checksum/, 0],
      [{ archiveSha256: '0'.repeat(64) }, /archive checksum/, 0],
      [{ arch: arch === 'x64' ? 'arm64' : 'x64' }, /architecture/, 0],
      [{ arch: 'ia32' }, /x64 and arm64/, 0],
    ]) {
      let executions = 0;
      const run = () =>
        verifyLinuxNode({ ...values, ...change }, (_executable, _args, options) => {
          executions++;
          assert.deepEqual(options.env, {});
          return `24.22.0\nlinux\n${arch}`;
        });
      if (failure) assert.throws(run, failure);
      else assert.equal(run().sha256, values.sha256);
      assert.equal(executions, calls);
    }
    for (const identity of [`24.22.0\ndarwin\n${arch}`, `24.21.0\nlinux\n${arch}`])
      assert.throws(() => verifyLinuxNode(values, () => identity), /identity/);
    assert.throws(() => assertLinuxExecutable(Buffer.alloc(64), arch), /architecture/);
  }
  assert.deepEqual(linuxTarget('x64'), { deb: 'amd64', rpm: 'x86_64', machine: 62 });
  assert.deepEqual(linuxTarget('arm64'), { deb: 'arm64', rpm: 'aarch64', machine: 183 });
});
