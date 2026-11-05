import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { _electron, expect } from '@playwright/test';
import { inspectLinuxElf, linuxTarget } from './package-linux.mjs';

const { values } = parseArgs({ options: { arch: { type: 'string' }, id: { type: 'string' } } });
assert.equal(process.platform, 'linux');
assert.equal(process.arch, values.arch);
assert.notEqual(process.getuid(), 0, 'Desktop smoke must run as an ordinary account.');
assert.match(values.id ?? '', /^[a-z0-9][a-z0-9-]{0,63}$/);
const target = linuxTarget(values.arch);
const root = resolve(import.meta.dirname, '..');
const output = join(root, 'internal/evidence', values.id);
mkdirSync(output, { recursive: true });
const inputs = JSON.parse(readFileSync(process.env.CREWKITE_LINUX_INPUTS, 'utf8'));
assert.match(
  inputs.fedoraImage ?? '',
  /^registry\.fedoraproject\.org\/fedora:[0-9]+@sha256:[a-f0-9]{64}$/,
);
const packages = join(root, 'internal/packages/d0', `${values.id}-installers`);
const deb = join(packages, `crewkite_${target.deb}.deb`);
const rpm = join(packages, `crewkite.${target.rpm}.rpm`);
// The Fedora container installs a few hundred packages from public mirrors before it checks
// anything, and a slow mirror takes minutes. That one step gets a longer limit; nothing it checks
// is relaxed.
const run = (command, args, timeout = 120000) =>
  execFileSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
const hashes = Object.fromEntries(
  [deb, rpm].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
);
writeFileSync(join(output, 'package-sha256.json'), `${JSON.stringify(hashes, null, 2)}\n`);
const extracted = mkdtempSync(join(tmpdir(), 'crewkite-elf-'));
try {
  run('dpkg-deb', ['--extract', deb, extracted]);
  writeFileSync(
    join(output, 'elf-requirements.json'),
    `${JSON.stringify(inspectLinuxElf(join(extracted, 'opt/crewkite')), null, 2)}\n`,
  );
} finally {
  rmSync(extracted, { recursive: true, force: true });
}
const payloadProbe = `
const { readFileSync } = await import('node:fs');
const { inventoryTree } = await import('/opt/crewkite/resources/app/runtime/apps/controller/src/host/toolchain.ts');
const receipt = JSON.parse(readFileSync('/opt/crewkite/manifest.json', 'utf8'));
if (receipt.platform !== 'linux' || receipt.architecture !== process.arch || !Array.isArray(receipt.files))
  throw Error('Installed payload receipt is unavailable');
const inventory = await inventoryTree('/opt/crewkite', {
  now: Date.now, deadline: Date.now() + 120000, maximumEntries: 500000,
  maximumBytes: 8 * 1024 ** 3,
});
const actual = inventory.entries.filter(entry => entry.kind !== 'directory' && entry.path !== 'manifest.json')
  .map(entry => entry.kind === 'link' ? { path: entry.path, target: entry.resolved }
    : { path: entry.path, bytes: entry.bytes, sha256: entry.hash, mode: entry.mode & 0o777 });
const normalize = row => row.target === undefined
  ? { path: row.path, bytes: row.bytes, sha256: row.sha256, mode: row.mode }
  : { path: row.path, target: row.target };
const order = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
if (JSON.stringify(actual.sort(order)) !== JSON.stringify(receipt.files.map(normalize).sort(order)))
  throw Error('Installed payload differs from its staged inventory');
console.log('Verified installed payload entries:', actual.length);
`;
run('sudo', ['apt-get', 'install', '--yes', deb]);
writeFileSync(
  join(output, 'deb-payload.txt'),
  run('sudo', [
    '/opt/crewkite/resources/app/runtime/bin/node',
    '--input-type=module',
    '--eval',
    payloadProbe,
  ]),
);

assert.match(
  readFileSync('/usr/share/applications/crewkite.desktop', 'utf8'),
  /^Exec=\/opt\/crewkite\/crewkite$/m,
);
const helper = lstatSync('/opt/crewkite/chrome-sandbox');
assert.equal(helper.uid, 0);
assert.equal(helper.mode & 0o7777, 0o4755);
const state = mkdtempSync(join(tmpdir(), 'crewkite-installed-'));
const environment = {
  ...process.env,
  HOME: state,
  CREWKITE_HOME: join(state, 'home'),
  CREWKITE_PROFILE: join(state, 'profile'),
};
for (const key of Object.keys(environment))
  if (key.startsWith('CREWKITE_') && !['CREWKITE_HOME', 'CREWKITE_PROFILE'].includes(key))
    delete environment[key];
writeFileSync(
  join(output, 'provider-observation.txt'),
  'Process snapshots and controller logs record observed startup activity. They do not establish absence of short-lived provider processes. Exact provider UAT remains pending.\n',
);
let evidence;
try {
  for (let pass = 0; pass < 2; pass++) {
    const application = await _electron.launch({
      executablePath: '/opt/crewkite/crewkite',
      args: [],
      chromiumSandbox: true,
      env: environment,
      timeout: 30000,
    });
    try {
      const window = await application.firstWindow();
      await expect(window.getByRole('heading', { name: 'Welcome to CrewKite' })).toBeVisible({
        timeout: 30000,
      });
      evidence = await application.evaluate(({ BrowserWindow, app }) => {
        const web = BrowserWindow.getAllWindows()[0].webContents;
        const preferences = web.getLastWebPreferences();
        return {
          appPath: app.getAppPath(),
          renderer: web.getOSProcessId(),
          sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
          argv: process.argv,
        };
      });
      const descendants = new Set([application.process().pid]);
      const processes = readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .flatMap((name) => {
          try {
            const status = readFileSync(`/proc/${name}/status`, 'utf8');
            return [
              {
                pid: Number(name),
                parent: Number(status.match(/^PPid:\s+(\d+)$/m)[1]),
                args: readFileSync(`/proc/${name}/cmdline`, 'utf8'),
              },
            ];
          } catch {
            return [];
          }
        });
      for (let changed = true; changed; ) {
        changed = false;
        for (const child of processes)
          if (descendants.has(child.parent) && !descendants.has(child.pid)) {
            descendants.add(child.pid);
            changed = true;
          }
      }
      const children = processes.filter((child) => descendants.has(child.pid));
      assert.ok(
        children.some((child) =>
          child.args.includes('/opt/crewkite/resources/app/runtime/apps/controller/src/main.ts'),
        ),
      );
      for (const child of children)
        assert.ok(
          child.args.startsWith('/opt/crewkite/'),
          'Installed children must execute from the immutable payload.',
        );
      writeFileSync(
        join(output, `processes-${pass}.json`),
        `${JSON.stringify(children, null, 2)}\n`,
      );
      assert.equal(evidence.appPath, '/opt/crewkite/resources/app');
      assert.equal(evidence.sandbox, true);
      assert.equal(evidence.contextIsolation, true);
      assert.equal(evidence.nodeIntegration, false);
      assert.ok(!evidence.argv.includes('--no-sandbox'));
      const status = readFileSync(`/proc/${evidence.renderer}/status`, 'utf8');
      assert.match(status, /^Seccomp:\s+2$/m);
      assert.ok(
        !readFileSync(`/proc/${evidence.renderer}/cmdline`, 'utf8').includes('--no-sandbox'),
      );
      for (const path of ['home', 'profile'])
        assert.equal(lstatSync(join(state, path)).mode & 0o777, 0o700);
      const marker = join(state, 'home/smoke-reopen');
      if (pass === 0) writeFileSync(marker, values.id, { mode: 0o600 });
      else assert.equal(readFileSync(marker, 'utf8'), values.id);
      await window.screenshot({ path: join(output, `welcome-${pass}.png`) });
      writeFileSync(
        join(output, `renderer-${pass}.json`),
        `${JSON.stringify({ ...evidence, status }, null, 2)}\n`,
      );
    } finally {
      await application.close();
    }
  }
} finally {
  const log = join(state, 'home/controller.log');
  if (existsSync(log)) writeFileSync(join(output, 'controller.log'), readFileSync(log));
}
const log = join(state, 'home/controller.log');
assert.ok(existsSync(log));
const controllerLog = readFileSync(log, 'utf8');
writeFileSync(join(output, 'controller.log'), controllerLog);
const probe =
  'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(":memory:");if(db.prepare("select 1 as n").get().n!==1)process.exit(1);console.log(process.version,process.platform,process.arch)';
writeFileSync(
  join(output, 'node-sqlite.txt'),
  run('/opt/crewkite/resources/app/runtime/bin/node', ['--eval', probe]),
);
// This container proves package installation and headless runtime integrity only.
// Fedora desktop, SELinux and kernel sandbox qualification remain separate.
const runtimeProbe = `
const { verifyRuntimeIntegrity } = await import('/opt/crewkite/resources/app/runtime/packages/client/src/runtime-integrity.ts');
const { DatabaseSync } = await import('node:sqlite');
const runtime = verifyRuntimeIntegrity('/opt/crewkite/resources/app/runtime');
if (runtime.manifest.layout !== 'installed' || runtime.manifest.node.version !== '24.22.0' ||
    runtime.manifest.node.platform !== 'linux' || runtime.manifest.node.arch !== process.arch ||
    process.arch !== process.argv[1] || process.versions.node !== runtime.manifest.node.version ||
    process.execPath !== runtime.node) throw Error('Installed runtime identity differs');
const database = new DatabaseSync(':memory:');
if (database.prepare('select 1 as n').get().n !== 1) throw Error('SQLite probe failed');
database.close();
if (process.getuid() === 0) throw Error('Runtime probe requires an ordinary account');
console.log(process.version, process.platform, process.arch);
`;
const fedoraScript = `
set -eu
cat /etc/os-release
uname -m
rpm --version
dnf --version
test "$(uname -m)" = "$1"
test "$(sha256sum /tmp/crewkite.rpm | cut -d ' ' -f1)" = "$3"
test -z "$(rpm -qp --scripts /tmp/crewkite.rpm)"
rpm -qpi /tmp/crewkite.rpm
rpm -qpl /tmp/crewkite.rpm
rpm -qpR /tmp/crewkite.rpm
dnf install -y /tmp/crewkite.rpm
test "$(rpm -q --qf '%{NAME} %{VERSION} %{ARCH}' crewkite)" = "crewkite 0.1.0 $1"
rpm -V crewkite
test "$(stat -c '%u:%g:%a' /opt/crewkite/chrome-sandbox)" = '0:0:4755'
for program in /opt/crewkite/crewkite /usr/bin/crewkite /opt/crewkite/resources/bin/crewkite; do
  test "$(stat -c '%u:%g:%a' "$program")" = '0:0:755'
done
test -f /usr/share/icons/hicolor/256x256/apps/crewkite.png
test -f /usr/share/applications/crewkite.desktop
/opt/crewkite/resources/app/runtime/bin/node --input-type=module --eval "$5"
dnf install -y shadow-utils util-linux
useradd -m smoke
runuser -u smoke -- env HOME=/home/smoke /opt/crewkite/resources/app/runtime/bin/node --input-type=module --eval "$4" "$2"
test "$(runuser -u smoke -- env HOME=/home/smoke /usr/bin/crewkite --version)" = '0.1.0'
case "$(runuser -u smoke -- env HOME=/home/smoke /usr/bin/crewkite --help)" in
  'Usage: crewkite'*) ;;
  *) echo 'Installed CLI help failed' >&2; exit 1 ;;
esac
`;
const container = run(
  'docker',
  [
    'run',
    '--rm',
    '--network=bridge',
    '--mount',
    `type=bind,src=${rpm},dst=/tmp/crewkite.rpm,readonly`,
    inputs.fedoraImage,
    'sh',
    '-ec',
    fedoraScript,
    '--',
    target.rpm,
    values.arch,
    hashes[rpm],
    runtimeProbe,
    payloadProbe,
  ],
  600000,
);
writeFileSync(join(output, 'fedora-install.txt'), container);
