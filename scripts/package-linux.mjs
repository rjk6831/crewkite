import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryTree } from '../apps/controller/src/host/toolchain.ts';
import { verifyRuntimeIntegrity } from '../packages/client/src/runtime-integrity.ts';

const assets = fileURLToPath(new URL('../packaging/linux/', import.meta.url));
const targets = {
  x64: { deb: 'amd64', rpm: 'x86_64', machine: 62 },
  arm64: { deb: 'arm64', rpm: 'aarch64', machine: 183 },
};

export function linuxTarget(arch) {
  if (!Object.hasOwn(targets, arch)) throw new Error('Linux packages support x64 and arm64.');
  return targets[arch];
}

/** Read static ELF requirements without executing packaged programs. */
export function inspectLinuxElf(root, execute = execFileSync) {
  const files = [];
  const options = { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 };
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const state = lstatSync(path);
      if (state.isDirectory()) walk(path);
      else if (state.isFile()) {
        const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const header = Buffer.alloc(4);
        let count;
        try {
          count = readSync(file, header);
        } finally {
          closeSync(file);
        }
        if (count === 4 && header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
          files.push({
            path: relative(root, path),
            readelf: execute(
              'readelf',
              ['--wide', '--file-header', '--program-headers', '--dynamic', '--version-info', path],
              options,
            ),
          });
      }
    }
  };
  walk(root);
  if (!files.length) throw new Error('The Linux payload contains no ELF files.');
  return files;
}

function regular(path, maximum = 256 * 1024 * 1024) {
  if (realpathSync(path) !== resolve(path)) throw new Error('A Linux runtime input uses a link.');
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size === 0n ||
      before.size > BigInt(maximum) ||
      (before.mode & 0o022n) !== 0n
    )
      throw new Error('A Linux runtime input must be a bounded, unshared regular file.');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (
      BigInt(bytes.length) !== before.size ||
      !current.isFile() ||
      ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].some(
        (key) => before[key] !== after[key] || after[key] !== current[key],
      )
    )
      throw new Error('A Linux runtime input changed while reading.');
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function assertLinuxExecutable(bytes, arch) {
  const target = linuxTarget(arch);
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== target.machine
  )
    throw new Error('The Linux executable architecture does not match its target.');
}

/** Missing reviewed pins block staging before any bundled runtime is executed. */
export function verifyLinuxNode(
  { node, archive, sha256, archiveSha256, arch },
  execute = execFileSync,
) {
  linuxTarget(arch);
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || !/^[a-f0-9]{64}$/.test(archiveSha256 ?? ''))
    throw new Error('Reviewed Linux Node archive and executable checksums are required.');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  if (hash(regular(archive, 512 * 1024 * 1024)) !== archiveSha256)
    throw new Error('The pinned Linux Node archive checksum changed.');
  const bytes = regular(node);
  if (hash(bytes) !== sha256) throw new Error('The pinned Linux Node executable checksum changed.');
  assertLinuxExecutable(bytes, arch);
  const identity = execute(
    node,
    [
      '--eval',
      'process.stdout.write([process.versions.node,process.platform,process.arch].join("\\n"))',
    ],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 128, env: {} },
  );
  if (identity !== `24.22.0\nlinux\n${arch}`)
    throw new Error('The bundled Linux Node identity does not match.');
  return { version: '24.22.0', platform: 'linux', arch, sha256, archiveSha256 };
}

function requireEntry(root, entry, directory = false) {
  const path = join(root, entry);
  const actual = realpathSync(path);
  const child = relative(root, actual);
  const state = lstatSync(path);
  if (
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child) ||
    (directory ? !state.isDirectory() : !state.isFile())
  )
    throw new Error(`The Linux package entry is unavailable: ${entry}.`);
}

/** The common stage owns source, dependency closure and notices before platform assembly. */
export async function assembleLinuxPackage({ stage, arch, version, icon, budget }) {
  linuxTarget(arch);
  if (process.platform !== 'linux' || process.arch !== arch)
    throw new Error('Linux assembly requires the matching native Linux host.');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new Error('The Linux package needs its release version.');
  stage = realpathSync(stage);
  for (const entry of [
    'state',
    'CrewKite.command',
    'Upgrade Existing.command',
    'scripts/package-upgrade.mjs',
    'app/runtime/bin/local-secure-input',
  ])
    if (lstatSync(join(stage, entry), { throwIfNoEntry: false }))
      throw new Error('The Linux stage contains state or a macOS-only package entry.');
  const app = join(stage, 'resources/app');
  if (existsSync(app)) throw new Error('The Linux application destination already exists.');
  for (const entry of [
    'electron',
    'chrome-sandbox',
    'icudtl.dat',
    'resources/default_app.asar',
    'LICENSE',
    'LICENSES.chromium.html',
    'app/package.json',
    'app/out/main/index.js',
    'app/out/preload/index.cjs',
    'app/runtime/manifest.json',
    'app/runtime/bin/node',
    'app/runtime/apps/cli/src/installed.ts',
    'app/runtime/apps/controller/src/main.ts',
    'app/runtime/apps/controller/src/store/schema-compatibility.ts',
    'app/runtime/apps/controller/src/providers/file-digest-worker.ts',
  ])
    requireEntry(stage, entry);
  for (const entry of ['locales', 'app/runtime/apps/controller/migrations', 'notices', 'docs'])
    requireEntry(stage, entry, true);
  assertLinuxExecutable(regular(join(stage, 'electron')), arch);
  assertLinuxExecutable(regular(join(stage, 'chrome-sandbox')), arch);
  // Native installers assign root ownership; Chromium's helper requires this exact mode.
  chmodSync(join(stage, 'chrome-sandbox'), 0o4755);
  assertLinuxExecutable(regular(join(stage, 'app/runtime/bin/node')), arch);
  const manifestPath = join(stage, 'app/runtime/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.node?.platform !== 'linux' || manifest.node.arch !== arch || manifest.localInput)
    throw new Error('The Linux runtime manifest has an unsupported native identity.');
  manifest.layout = 'installed';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const packagePath = join(stage, 'app/package.json');
  const desktop = JSON.parse(readFileSync(packagePath, 'utf8'));
  Object.assign(desktop, { name: 'crewkite', productName: 'CrewKite', version });
  writeFileSync(packagePath, `${JSON.stringify(desktop, null, 2)}\n`);
  renameSync(join(stage, 'electron'), join(stage, 'crewkite'));
  renameSync(join(stage, 'app'), app);
  const distribution = join(stage, 'resources/distribution');
  mkdirSync(distribution);
  // Electron keeps its own LICENSE at the distribution root; CrewKite's text has its own name.
  for (const entry of ['NOTICE', 'README.md', 'notices', 'docs'])
    renameSync(join(stage, entry), join(distribution, entry));
  requireEntry(stage, 'resources/distribution/notices/LICENSE');
  copyFileSync(join(distribution, 'notices/LICENSE'), join(distribution, 'LICENSE'));
  requireEntry(stage, 'resources/distribution/notices/electron-LICENSE');
  copyFileSync(join(distribution, 'notices/electron-LICENSE'), join(stage, 'LICENSE'));
  mkdirSync(join(stage, 'resources/bin'));
  writeFileSync(
    join(stage, 'resources/bin/crewkite'),
    '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd "$(dirname "$0")/../app/runtime" && pwd -P)\nexec "$root/bin/node" "$root/apps/cli/src/installed.ts" "$@"\n',
    { mode: 0o755, flag: 'wx' },
  );
  const artwork = regular(icon, 16 * 1024 * 1024);
  if (
    !artwork.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    artwork.length < 24 ||
    artwork.readUInt32BE(16) !== 256 ||
    artwork.readUInt32BE(20) !== 256
  )
    throw new Error('The Linux icon must be a 256 pixel square PNG.');
  copyFileSync(icon, join(stage, 'crewkite.png'));
  copyFileSync(join(assets, 'crewkite.desktop'), join(stage, 'crewkite.desktop'));
  verifyRuntimeIntegrity(join(app, 'runtime'));
  const inventory = await inventoryTree(
    stage,
    budget ?? {
      now: Date.now,
      deadline: Date.now() + 120000,
      maximumEntries: 500000,
      maximumBytes: 8 * 1024 * 1024 * 1024,
    },
  );
  return { app, runtime: join(app, 'runtime'), executable: join(stage, 'crewkite'), inventory };
}

function packageCopy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true,
  });
}

function metadataLines(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some(
      (value) => typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.+:()>=< _-]*$/.test(value),
    )
  )
    throw new Error('Reviewed Linux package dependencies are required.');
  return values;
}

/** Native wrappers consume the already inventoried payload without changing executable bytes. */
export function buildLinuxPackages(
  { stage, work, output, arch, version, debDepends, rpmRequires },
  execute = execFileSync,
) {
  const target = linuxTarget(arch);
  if (process.platform !== 'linux' || process.arch !== arch)
    throw new Error('Linux packaging requires the matching native Linux host.');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('A release version is required.');
  const deb = metadataLines(debDepends);
  const rpm = metadataLines(rpmRequires);
  if (!deb.includes('git') || !rpm.includes('git')) throw new Error('Linux packages require Git.');
  for (const path of [work, output]) {
    const child = relative(realpathSync(stage), resolve(path));
    if (
      !isAbsolute(path) ||
      existsSync(path) ||
      /[\r\n"\\$`%]/.test(path) ||
      (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
    )
      throw new Error('Use new absolute Linux package directories.');
    mkdirSync(path, { recursive: true });
  }
  const root = join(work, 'root');
  packageCopy(stage, join(root, 'opt/crewkite'));
  mkdirSync(join(root, 'usr/bin'), { recursive: true });
  writeFileSync(
    join(root, 'usr/bin/crewkite'),
    '#!/bin/sh\nset -eu\nexec /opt/crewkite/resources/bin/crewkite "$@"\n',
    { mode: 0o755 },
  );
  packageCopy(
    join(assets, 'crewkite.desktop'),
    join(root, 'usr/share/applications/crewkite.desktop'),
  );
  packageCopy(
    join(stage, 'crewkite.png'),
    join(root, 'usr/share/icons/hicolor/256x256/apps/crewkite.png'),
  );
  const options = { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, cwd: work };
  const control = join(root, 'DEBIAN');
  mkdirSync(control);
  writeFileSync(
    join(control, 'control'),
    `Package: crewkite\nVersion: ${version}\nArchitecture: ${target.deb}\nMaintainer: Raymond J. Kraft <admin@rootsnolimits.com>\nSection: devel\nPriority: optional\nDepends: ${deb.join(', ')}\nHomepage: https://github.com/rjk6831/crewkite\nDescription: Desktop workspace for supervised coding\n`,
  );
  chmodSync(control, 0o755);
  const debPath = join(output, `crewkite_${target.deb}.deb`);
  execute('dpkg-deb', ['--root-owner-group', '--build', root, debPath], options);
  const rpmRoot = join(work, 'rpm');
  for (const directory of ['BUILD', 'BUILDROOT', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS'])
    mkdirSync(join(rpmRoot, directory), { recursive: true });
  const spec = readFileSync(join(assets, 'crewkite.spec'), 'utf8')
    .replaceAll('@VERSION@', version)
    .replaceAll('@ARCH@', target.rpm)
    .replace('@REQUIRES@', rpm.map((value) => `Requires: ${value}`).join('\n'));
  const specPath = join(rpmRoot, 'SPECS/crewkite.spec');
  writeFileSync(specPath, spec);
  execute(
    'rpmbuild',
    [
      '--define',
      `_topdir ${rpmRoot}`,
      '--define',
      `payload_root ${root}`,
      '--target',
      target.rpm,
      '-bb',
      specPath,
    ],
    options,
  );
  const rpmPath = join(output, `crewkite.${target.rpm}.rpm`);
  copyFileSync(
    join(rpmRoot, `RPMS/${target.rpm}/crewkite-${version}-1.${target.rpm}.rpm`),
    rpmPath,
  );
  return { deb: debPath, rpm: rpmPath, appImages: [], qualification: 'build-only' };
}

/** Package-manager inspection checks the native metadata before a separate install smoke. */
export function inspectLinuxPackages({ deb, rpm, arch, version }, execute = execFileSync) {
  const target = linuxTarget(arch);
  const options = { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 };
  for (const [field, expected] of [
    ['Package', 'crewkite'],
    ['Version', version],
    ['Architecture', target.deb],
  ]) {
    if (execute('dpkg-deb', ['--field', deb, field], options).trim() !== expected)
      throw new Error('The Debian package identity differs from its target.');
  }
  if (
    execute('rpm', ['-qp', '--qf', '%{NAME}\n%{VERSION}\n%{ARCH}\n', rpm], options).trim() !==
    `crewkite\n${version}\n${target.rpm}`
  )
    throw new Error('The RPM package identity differs from its target.');
  const scripts = execute('rpm', ['-qp', '--scripts', rpm], options).trim();
  if (scripts) throw new Error('The RPM unexpectedly contains installation scripts.');
  // The file lists name every payload file, several megabytes for the full desktop runtime.
  const listing = { ...options, maxBuffer: 64 * 1024 * 1024 };
  return {
    debContents: execute('dpkg-deb', ['--contents', deb], listing),
    debDepends: execute('dpkg-deb', ['--field', deb, 'Depends'], options),
    rpmContents: execute('rpm', ['-qpl', rpm], listing),
    rpmRequires: execute('rpm', ['-qpR', rpm], options),
    qualification: 'metadata-only',
  };
}
