import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  copyInstalledDependencies,
  inspectInstalledDependencies,
} from '../apps/controller/src/host/toolchain.ts';
import { stageCliRuntime } from './cli-runtime.ts';
import { copyRuntimePackages } from './runtime-packages.ts';

const helperSourcePath = 'apps/controller/src/providers/local/secure-input.m';
const helperTarget = 'darwin-arm64';
const helperMinimumOS = '13.5.0';
const compilerPath = '/Library/Developer/CommandLineTools/usr/bin/clang';
const sdkPath = '/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk';

function regularBytes(path, limit) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size === 0 || before.size > limit)
      throw new Error('The native helper build needs a bounded regular file.');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(descriptor);
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error('The native helper build input changed.');
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Installed self-aliases must resolve within the relocated package. */
export function copyPackagePayload(from, to, excluded = []) {
  const source = realpathSync(from);
  const target = resolve(to);
  if (
    realpathSync(dirname(target)) !== dirname(target) ||
    lstatSync(target, { throwIfNoEntry: false })
  )
    throw new Error('Runtime package destination must be new and canonical.');
  const links = [];
  cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true,
    filter: (entry, destination) => {
      if (excluded.includes(relative(source, entry).split(sep)[0])) return false;
      if (!lstatSync(entry).isSymbolicLink()) return true;
      const child = relative(source, realpathSync(entry));
      if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
        throw new Error('Runtime package link escapes its source.');
      const mapped = join(target, child);
      symlinkSync(relative(dirname(destination), mapped) || '.', destination);
      links.push(destination);
      return false;
    },
  });
  for (const link of links) {
    const child = relative(target, realpathSync(link));
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error('Runtime package link escapes its destination.');
  }
}

/** The fixed target prevents a newer build host from raising the package's OS floor. */
export function inspectLocalInputArtifact(bytes) {
  if (
    bytes.length < 32 ||
    bytes.readUInt32LE(0) !== 0xfeedfacf ||
    bytes.readUInt32LE(4) !== 0x0100000c ||
    bytes.readUInt32LE(12) !== 2
  )
    throw new Error('The native helper must be an arm64 Mach-O executable.');
  const commands = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  if (commands === 0 || commands > 1024 || commandBytes > bytes.length - 32)
    throw new Error('The native helper load commands are invalid.');
  let position = 32;
  let version;
  for (let index = 0; index < commands; index++) {
    if (position + 8 > 32 + commandBytes)
      throw new Error('The native helper load commands are incomplete.');
    const command = bytes.readUInt32LE(position);
    const length = bytes.readUInt32LE(position + 4);
    if (length < 8 || length % 8 !== 0 || position + length > 32 + commandBytes)
      throw new Error('The native helper load command escapes its bounds.');
    if (command === 0x32) {
      if (version || length < 24 || bytes.readUInt32LE(position + 8) !== 1)
        throw new Error('The native helper build target is ambiguous.');
      const minimumOS = bytes.readUInt32LE(position + 12);
      if (minimumOS !== 0x000d0500) throw new Error('The native helper minimum OS changed.');
      const sdk = bytes.readUInt32LE(position + 16);
      version = {
        target: helperTarget,
        minOS: helperMinimumOS,
        sdk: `${sdk >>> 16}.${(sdk >>> 8) & 255}.${sdk & 255}`,
      };
    }
    position += length;
  }
  if (!version || position !== 32 + commandBytes)
    throw new Error('The native helper build version is missing.');
  return version;
}

/** Compilation produces an artifact; it never runs the helper. */
export function buildLocalInputHelper(checkout, build, dependencies = {}) {
  const execute = dependencies.execute ?? spawnSync;
  const read = dependencies.read ?? regularBytes;
  const source = join(checkout, helperSourcePath);
  if (realpathSync(source) !== source)
    throw new Error('The native helper source cannot use symbolic paths.');
  const sourceHash = digest(read(source, 1024 * 1024));
  const compilerHash = digest(read(compilerPath, 512 * 1024 * 1024));
  const sdkSettingsHash = digest(read(join(sdkPath, 'SDKSettings.json'), 1024 * 1024));
  const output = join(build, 'local-secure-input');
  if (existsSync(output)) throw new Error('The native helper output already exists.');
  const args = [
    '-fobjc-arc',
    '-fblocks',
    '-arch',
    'arm64',
    '-mmacosx-version-min=13.5',
    '-isysroot',
    sdkPath,
    '-framework',
    'AppKit',
    '-framework',
    'Foundation',
    source,
    '-o',
    output,
  ];
  const result = execute(compilerPath, args, {
    cwd: checkout,
    env: { LANG: 'C', PATH: '/usr/bin:/bin', TMPDIR: build },
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || result.signal)
    throw new Error('The native helper compiler did not finish successfully.');
  if (
    digest(read(source, 1024 * 1024)) !== sourceHash ||
    digest(read(compilerPath, 512 * 1024 * 1024)) !== compilerHash ||
    digest(read(join(sdkPath, 'SDKSettings.json'), 1024 * 1024)) !== sdkSettingsHash
  )
    throw new Error('The native helper build inputs changed.');
  const bytes = read(output, 1024 * 1024);
  const { target, minOS, sdk } = inspectLocalInputArtifact(bytes);
  return {
    path: output,
    identity: { sha256: digest(bytes), sourceHash, target, minOS },
    compiler: {
      sha256: compilerHash,
      sdkSettingsHash,
      sdk,
      pathsRelativeTo: 'build-source',
      args: args.map((value) =>
        value === source || value === output ? relative(checkout, value) : value,
      ),
    },
  };
}

/** A resource seal lets macOS check the copied runtime before its files are inventoried. */
export function sealElectronBundle(bundle, execute = spawnSync) {
  const options = {
    env: { LANG: 'C', PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  for (const args of [
    ['--force', '--deep', '--sign', '-', '--preserve-metadata=identifier,entitlements', bundle],
    ['--verify', '--deep', '--strict', '--verbose=2', bundle],
  ]) {
    const result = execute('/usr/bin/codesign', args, options);
    if (result.error || result.status !== 0 || result.signal)
      throw new Error('The staged Electron resource seal did not finish successfully.');
  }
  return { kind: 'ad-hoc', verified: 'deep-strict', developerID: false, notarized: false };
}

export async function packageDesktop() {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  const primary = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  let provenancePattern = process.env.PROVENANCE_PATTERN?.trim() ?? '';
  const policyPath = join(primary, 'internal/provenance-pattern.txt');
  if (!provenancePattern && lstatSync(policyPath, { throwIfNoEntry: false })) {
    const file = openSync(
      policyPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const state = fstatSync(file);
      if (!state.isFile() || state.size > 16384)
        throw new Error('The build provenance policy must be a bounded regular file.');
      provenancePattern = readFileSync(file, 'utf8').trim();
      if (!provenancePattern) throw new Error('The selected build provenance policy is empty.');
    } finally {
      closeSync(file);
    }
  }
  if (provenancePattern.length > 4096)
    throw new Error('The build provenance policy exceeds the verification limit.');
  if (provenancePattern)
    try {
      new RegExp(provenancePattern, 'i');
    } catch {
      throw new Error('The build provenance policy must be a valid regular expression.');
    }
  const { values } = parseArgs({
    options: { id: { type: 'string' }, demo: { type: 'boolean', default: false } },
  });
  const mode = values.demo ? 'demo' : 'workspace';
  const controllerEntry =
    mode === 'demo' ? 'scripts/demo-controller.ts' : 'apps/controller/src/main.ts';
  if (!values.id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(values.id))
    throw new Error('Supply --id with a new lowercase build name.');
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('The local package currently supports macOS arm64.');

  const nodeVersion = '24.22.0';
  const nodeHash = 'b468fb9c67427c9d3aec07ee1105e63020923a631a9a2a00beb71a7ba3768bfd';
  const tools = join(primary, 'internal/tools');
  const nodeRoot = join(tools, `node-v${nodeVersion}-darwin-arm64`);
  const node = join(nodeRoot, 'bin/node');
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (hash(node) !== nodeHash) throw new Error('The pinned Node binary checksum changed.');
  if (execFileSync(node, ['--version'], { encoding: 'utf8' }).trim() !== `v${nodeVersion}`)
    throw new Error('The pinned Node binary version changed.');

  const stage = join(primary, 'internal/packages/d0', values.id);
  const build = join(primary, 'internal/package-build', values.id);
  if (existsSync(stage) || existsSync(build))
    throw new Error('Build or package directory already exists. Choose an unused --id.');
  if (git('status', '--porcelain', '--untracked-files=no'))
    throw new Error('Commit the tracked source changes before packaging.');
  const revision = git('rev-parse', 'HEAD');
  // A package built from a checkout that fell behind its remote branch tests old code and the
  // live check then reports fixed bugs again. The warning names the gap; it does not stop the build.
  for (const ref of ['origin/feat/chat-thread', 'origin/main']) {
    let behind = '';
    try {
      behind = git('rev-list', '--count', `HEAD..${ref}`);
    } catch {
      continue;
    }
    if (behind !== '0')
      console.warn(
        `Warning: ${ref} is ${behind} commits ahead of this checkout (${revision.slice(0, 7)}).`,
      );
  }
  const bootstrapFiles = ['scripts/demo-controller.ts', 'scripts/demo-state.ts'];
  const committedInputs = [...bootstrapFiles, 'apps/controller/src/main.ts', helperSourcePath];
  for (const path of committedInputs) {
    try {
      execFileSync('git', ['cat-file', '-e', `${revision}:${path}`], {
        cwd: source,
        stdio: 'ignore',
      });
    } catch {
      throw new Error(`The committed package input is unavailable: ${path}.`);
    }
  }
  mkdirSync(build, { recursive: true });
  const checkout = join(build, 'source');
  mkdirSync(checkout);
  const archive = execFileSync('git', ['archive', '--format=tar', revision], {
    cwd: source,
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync('tar', ['-xf', '-', '-C', checkout], { input: archive });
  for (const path of committedInputs)
    if (!lstatSync(join(checkout, path)).isFile())
      throw new Error(`The committed package input must be a regular file: ${path}.`);
  const lockHash = hash(join(checkout, 'pnpm-lock.yaml'));
  const workspaces = [
    'apps/controller',
    'apps/cli',
    'apps/desktop',
    'packages/contracts',
    'packages/client',
    'packages/testkit',
  ];
  const copyBudget = {
    deadline: Date.now() + 120000,
    now: Date.now,
    maximumEntries: 500000,
    maximumBytes: 8 * 1024 * 1024 * 1024,
  };
  // The existing installation has already passed repository checks. No lifecycle code runs here.
  const dependencies = await inspectInstalledDependencies(source, workspaces, copyBudget);
  const { buildDependencies } = await copyInstalledDependencies(
    source,
    checkout,
    dependencies,
    copyBudget,
  );
  function validateLinks(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      inside(path, checkout);
      if (lstatSync(path).isDirectory()) validateLinks(path);
    }
  }
  validateLinks(checkout);
  const verificationFiles = [];
  if (provenancePattern) {
    const { frozenVerificationPath } = await import(
      pathToFileURL(join(checkout, 'apps/controller/src/evidence/toolchain-definition.ts')).href
    );
    const tracked = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', revision], {
      cwd: source,
      encoding: 'utf8',
    });
    for (const path of tracked.split('\0').filter(Boolean).filter(frozenVerificationPath)) {
      const from = join(checkout, path);
      inside(from, checkout);
      const state = lstatSync(from);
      if (!state.isFile()) throw new Error(`The frozen grader must be a regular file: ${path}.`);
      verificationFiles.push({
        path,
        bytes: state.size,
        sha256: hash(from),
        mode: state.mode & 0o7777,
      });
    }
  }
  const environment = {
    PATH: `${join(nodeRoot, 'bin')}:${process.env.PATH ?? ''}`,
    HOME: join(build, 'environment'),
    LANG: 'C',
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  };
  mkdirSync(environment.HOME, { recursive: true });
  const builder = createRequire(join(checkout, 'apps/desktop/package.json')).resolve(
    'electron-vite/package.json',
  );
  const built = spawnSync(node, [join(dirname(builder), 'bin/electron-vite.js'), 'build'], {
    cwd: join(checkout, 'apps/desktop'),
    env: environment,
    stdio: 'inherit',
    timeout: 120000,
  });
  if (built.error) throw built.error;
  if (built.status !== 0) throw new Error('The isolated package build failed.');
  const localInput = buildLocalInputHelper(checkout, build);
  const preload = join(checkout, 'apps/desktop/out/preload/index.cjs');
  if (!existsSync(preload) || !lstatSync(preload).isFile() || lstatSync(preload).size === 0)
    throw new Error('The desktop build must produce the sandboxed CommonJS preload.');

  mkdirSync(stage, { recursive: true });
  function copy(from, to) {
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  }
  function json(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  const sourceDesktop = createRequire(join(source, 'apps/desktop/package.json'));
  const electron = dirname(sourceDesktop.resolve('electron/package.json'));
  const electronVersion = json(join(electron, 'package.json')).version;
  if (
    electronVersion !== json(join(checkout, 'apps/desktop/package.json')).devDependencies.electron
  )
    throw new Error('The installed Electron version differs from the frozen desktop manifest.');
  if (readFileSync(join(electron, 'dist/version'), 'utf8').trim() !== electronVersion)
    throw new Error('The installed Electron payload version differs from its package.');
  copy(join(electron, 'dist/Electron.app'), join(stage, 'Electron.app'));
  copy(join(checkout, 'apps/desktop/out'), join(stage, 'app/out'));
  const desktop = json(join(checkout, 'apps/desktop/package.json'));
  writeFileSync(
    join(stage, 'app/package.json'),
    `${JSON.stringify({ name: desktop.name, version: desktop.version, type: 'module', main: desktop.main }, null, 2)}\n`,
  );
  const runtime = join(stage, 'app/runtime');
  copy(localInput.path, join(runtime, 'bin/local-secure-input'));
  chmodSync(join(runtime, 'bin/local-secure-input'), 0o755);
  if (
    digest(regularBytes(join(runtime, 'bin/local-secure-input'), 1024 * 1024)) !==
    localInput.identity.sha256
  )
    throw new Error('The staged native helper checksum changed.');
  copy(node, join(runtime, 'bin/node'));
  chmodSync(join(runtime, 'bin/node'), 0o755);
  if (hash(join(runtime, 'bin/node')) !== nodeHash)
    throw new Error('The staged Node binary checksum changed.');
  const { RuntimeManifestSchema } = await import(
    pathToFileURL(join(checkout, 'packages/contracts/src/index.ts')).href
  );
  writeFileSync(
    join(runtime, 'manifest.json'),
    `${JSON.stringify(
      RuntimeManifestSchema.parse({
        version: 1,
        node: { version: nodeVersion, platform: 'darwin', arch: 'arm64', sha256: nodeHash },
        mode,
        localInput: localInput.identity,
      }),
      null,
      2,
    )}\n`,
  );
  for (const path of bootstrapFiles) copy(join(checkout, path), join(runtime, path));
  mkdirSync(join(stage, 'bin'));
  const launcherRoot = '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)\n';
  writeFileSync(
    join(stage, 'bin/crewkite'),
    `${launcherRoot}exec "$root/app/runtime/bin/node" "$root/app/runtime/apps/cli/src/main.ts" "$@" --home "$root/state/home"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(stage, 'bin/desktop'),
    `${launcherRoot}test -f "$root/app/runtime/${controllerEntry}" || { echo 'The packaged controller entry is unavailable.' >&2; exit 1; }\nexport CREWKITE_HOME="$root/state/home"\nexport CREWKITE_PROFILE="$root/state/profile"\nexec "$root/Electron.app/Contents/MacOS/Electron" "$root/app"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(stage, 'CrewKite.command'),
    '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd "$(dirname "$0")" && pwd -P)\nexec "$root/bin/desktop"\n',
    { mode: 0o755 },
  );
  copy(join(checkout, 'scripts/package-upgrade.mjs'), join(stage, 'scripts/package-upgrade.mjs'));
  writeFileSync(
    join(stage, 'Upgrade Existing.command'),
    '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd "$(dirname "$0")" && pwd -P)\nexec "$root/app/runtime/bin/node" "$root/scripts/package-upgrade.mjs" --source "$root"\n',
    { mode: 0o755 },
  );
  const workspace = [
    'apps/controller',
    'apps/cli',
    'packages/contracts',
    'packages/client',
    'packages/testkit',
  ];
  for (const path of workspace) {
    const from = join(checkout, path);
    const manifest = json(join(from, 'package.json'));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {}))
      if (
        !(name.startsWith('@crewkite/') && version === 'workspace:*') &&
        name !== 'zod' &&
        !(path === 'apps/controller' && name === '@lmstudio/sdk' && version === '2.1.0') &&
        // The CLI's terminal interface ships in its own store, staged by stageCliRuntime below.
        !(
          path === 'apps/cli' &&
          ((name === 'ink' && version === '8.0.0') || (name === 'react' && version === '19.3.1'))
        )
      )
        throw new Error(`Unqualified runtime dependency: ${name}.`);
    copy(join(from, 'package.json'), join(runtime, path, 'package.json'));
    cpSync(join(from, 'src'), join(runtime, path, 'src'), {
      recursive: true,
      filter: (entry) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry),
    });
  }
  copy(join(checkout, 'apps/controller/migrations'), join(runtime, 'apps/controller/migrations'));
  mkdirSync(join(runtime, 'node_modules/@crewkite'), { recursive: true });
  for (const name of ['contracts', 'client', 'testkit'])
    symlinkSync(`../../packages/${name}`, join(runtime, 'node_modules/@crewkite', name));
  const contracts = createRequire(join(checkout, 'packages/contracts/package.json'));
  const zod = dirname(contracts.resolve('zod/package.json'));
  copyPackagePayload(zod, join(runtime, 'node_modules/zod'), ['src']);
  const rootPackages = createRequire(join(checkout, 'package.json'));
  const biome = dirname(rootPackages.resolve('@biomejs/biome/package.json'));
  const biomeManifest = json(join(biome, 'package.json'));
  const biomeBinary = dirname(
    createRequire(join(biome, 'package.json')).resolve('@biomejs/cli-darwin-arm64/package.json'),
  );
  const biomeBinaryManifest = json(join(biomeBinary, 'package.json'));
  if (
    biomeManifest.version !==
      json(join(checkout, 'package.json')).devDependencies['@biomejs/biome'] ||
    biomeBinaryManifest.version !== biomeManifest.version
  )
    throw new Error('The installed Biome payload differs from the frozen root manifest.');
  mkdirSync(join(runtime, 'node_modules/@biomejs'), { recursive: true });
  copyPackagePayload(biome, join(runtime, 'node_modules/@biomejs/biome'), ['node_modules']);
  copyPackagePayload(biomeBinary, join(runtime, 'node_modules/@biomejs/cli-darwin-arm64'));
  const runtimePackages = await copyRuntimePackages({
    source: checkout,
    from: 'apps/controller/package.json',
    destination: runtime,
    root: '@lmstudio/sdk',
    packages: [
      {
        name: '@lmstudio/sdk',
        version: '2.1.0',
        edges: ['@lmstudio/lms-isomorphic', 'chalk', 'jsonschema', 'zod', 'zod-to-json-schema'],
        license: 'LICENSE',
      },
      { name: '@lmstudio/lms-isomorphic', version: '0.5.0', edges: ['ws'], license: 'LICENSE' },
      {
        name: 'chalk',
        version: '4.1.2',
        edges: ['ansi-styles', 'supports-color'],
        license: 'license',
      },
      { name: 'jsonschema', version: '1.5.0', edges: [], license: 'LICENSE' },
      { name: 'zod', version: '3.25.76', edges: [], license: 'LICENSE' },
      { name: 'zod-to-json-schema', version: '3.25.2', edges: ['zod'], license: 'LICENSE' },
      {
        name: 'ws',
        version: '8.22.0',
        edges: [],
        optionalPeers: ['bufferutil', 'utf-8-validate'],
        license: 'LICENSE',
      },
      { name: 'ansi-styles', version: '4.3.0', edges: ['color-convert'], license: 'license' },
      { name: 'supports-color', version: '7.2.0', edges: ['has-flag'], license: 'license' },
      { name: 'color-convert', version: '2.0.1', edges: ['color-name'], license: 'LICENSE' },
      { name: 'has-flag', version: '4.0.0', edges: [], license: 'license' },
      { name: 'color-name', version: '1.1.4', edges: [], license: 'LICENSE' },
    ],
    budget: copyBudget,
  });
  // Ink, React and the renderer modules the interactive CLI imports, in a store under apps/cli.
  const cliRuntime = await stageCliRuntime({ source: checkout, runtime, budget: copyBudget });
  for (const entry of verificationFiles) {
    const from = join(checkout, entry.path);
    const to = join(runtime, entry.path);
    const matches = (path) => {
      const state = lstatSync(path);
      return (
        state.isFile() &&
        state.size === entry.bytes &&
        (state.mode & 0o7777) === entry.mode &&
        hash(path) === entry.sha256
      );
    };
    if (!matches(from)) throw new Error(`The frozen grader changed during build: ${entry.path}.`);
    mkdirSync(dirname(to), { recursive: true });
    inside(dirname(to), runtime);
    if (!existsSync(to)) copy(from, to);
    inside(to, runtime);
    if (!matches(to)) throw new Error(`The packaged grader differs: ${entry.path}.`);
  }
  if (provenancePattern) {
    mkdirSync(join(runtime, 'internal'), { mode: 0o700 });
    writeFileSync(join(runtime, 'internal/provenance-pattern.txt'), `${provenancePattern}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  }

  const notices = [];
  function notice(name, version, from, filename) {
    const destination = `notices/${filename}`;
    copy(from, join(stage, destination));
    notices.push({ name, version, license: destination, sha256: hash(from) });
  }
  for (const item of [...runtimePackages, ...cliRuntime.packages])
    notice(
      item.name,
      item.version,
      item.license,
      `${item.name.replaceAll('@', '').replaceAll('/', '-')}-${item.version}-LICENSE`,
    );
  for (const filename of ['LICENSE', 'NOTICE'])
    notice('CrewKite', desktop.version, join(checkout, filename), filename);
  for (const filename of ['LICENSE', 'NOTICE', 'README.md', 'docs'])
    copy(join(checkout, filename), join(stage, filename));
  notice('CrewKite source credits', revision, join(checkout, 'docs/credits.md'), 'credits.md');
  notice('Node', nodeVersion, join(nodeRoot, 'LICENSE'), 'node-LICENSE');
  notice(
    '@biomejs/biome',
    biomeManifest.version,
    join(biome, 'LICENSE-APACHE'),
    'biome-LICENSE-APACHE',
  );
  notice('@biomejs/biome', biomeManifest.version, join(biome, 'LICENSE-MIT'), 'biome-LICENSE-MIT');
  notice('Electron', electronVersion, join(electron, 'dist/LICENSE'), 'electron-LICENSE');
  notice(
    'Chromium and Electron components',
    electronVersion,
    join(electron, 'dist/LICENSES.chromium.html'),
    'LICENSES.chromium.html',
  );
  const fromDesktop = createRequire(join(checkout, 'apps/desktop/package.json'));
  const reactDom = fromDesktop.resolve('react-dom/package.json');
  // Some packages keep package.json out of their exports. Their main entry still resolves, so the
  // manifest is the nearest package.json above it that carries the package's name.
  const manifestOf = (locator, name) => {
    try {
      return locator.resolve(`${name}/package.json`);
    } catch (error) {
      if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    }
    for (let directory = dirname(locator.resolve(name)); ; directory = dirname(directory)) {
      const candidate = join(directory, 'package.json');
      if (existsSync(candidate) && json(candidate).name === name) return candidate;
      if (dirname(directory) === directory) throw new Error(`No manifest found for ${name}.`);
    }
  };
  const fromLowlight = createRequire(manifestOf(fromDesktop, 'lowlight'));
  for (const [name, locator, file = 'LICENSE'] of [
    ['react', fromDesktop],
    ['react-dom', fromDesktop],
    ['scheduler', createRequire(reactDom)],
    ['lucide-react', fromDesktop],
    ['lowlight', fromDesktop, 'license'],
    ['highlight.js', fromLowlight],
    ['devlop', fromLowlight, 'license'],
    ['@fontsource/inter', fromDesktop],
    ['@fontsource/jetbrains-mono', fromDesktop],
    ['tailwindcss', fromDesktop],
    ['zod', contracts],
    ['rolldown', createRequire(fromDesktop.resolve('vite/package.json'))],
  ]) {
    const manifestPath = manifestOf(locator, name);
    const manifest = json(manifestPath);
    notice(
      name,
      manifest.version,
      join(dirname(manifestPath), file),
      `${name.replaceAll('@', '').replaceAll('/', '-')}-LICENSE`,
    );
  }

  function inside(path, root = stage) {
    const child = relative(realpathSync(root), realpathSync(path));
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error(`Path leaves its isolated root: ${relative(root, path)}.`);
  }
  const files = [];
  function inspect(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      inside(path);
      const state = lstatSync(path);
      if (state.isSymbolicLink())
        files.push({ path: relative(stage, path), target: relative(stage, realpathSync(path)) });
      else if (state.isDirectory()) inspect(path);
      else if (state.isFile())
        files.push({
          path: relative(stage, path),
          bytes: state.size,
          sha256: hash(path),
          mode: state.mode & 0o777,
        });
      else throw new Error(`Unsupported packaged file: ${relative(stage, path)}.`);
    }
  }
  for (const entry of [
    'CrewKite.command',
    'Upgrade Existing.command',
    'scripts/package-upgrade.mjs',
    'Electron.app/Contents/MacOS/Electron',
    `app/${desktop.main}`,
    'app/out/preload/index.cjs',
    'app/runtime/bin/node',
    'app/runtime/bin/local-secure-input',
    'app/runtime/apps/controller/src/providers/local/sdk-child.ts',
    'app/runtime/apps/controller/src/providers/local/secure-input.ts',
    'app/runtime/apps/controller/src/providers/google/acp/writer.ts',
    'app/runtime/apps/controller/src/providers/google/native-extension/connector.ts',
    'app/runtime/scripts/demo-controller.ts',
    'app/runtime/scripts/demo-state.ts',
    'app/runtime/apps/controller/src/main.ts',
    'app/runtime/apps/controller/src/evidence/reporter.ts',
    'app/runtime/apps/cli/src/main.ts',
    'app/runtime/packages/testkit/src/providers/worker.ts',
    'app/runtime/packages/testkit/src/providers/review-worker.ts',
    'bin/crewkite',
    'bin/desktop',
  ])
    inside(join(stage, entry));
  const electronSignature = sealElectronBundle(join(stage, 'Electron.app'));
  inspect(stage);
  writeFileSync(
    join(stage, 'manifest.json'),
    `${JSON.stringify(
      {
        format: 1,
        id: values.id,
        mode,
        revision,
        lockHash,
        buildDependencies,
        platform: 'darwin',
        architecture: 'arm64',
        minimumOS: helperMinimumOS,
        localInput: { ...localInput.identity, compiler: localInput.compiler },
        qualification: 'static-stage-only',
        bootstrap: 'present',
        runtime: { path: 'app/runtime/bin/node', version: nodeVersion, sha256: nodeHash },
        electron: { version: electronVersion, signature: electronSignature },
        notices,
        files,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Static package staged at ${stage} from revision ${revision.slice(0, 7)}`);
  console.log(`Disposable build source retained at ${checkout}`);
  console.log('Desktop, relocation and recovery journeys remain unqualified.');
  console.log(
    provenancePattern
      ? 'Verification policy and graders staged. Checks still need a matching source checkout with installed dependencies.'
      : 'Verification unavailable: this build carries no trusted provenance policy.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await packageDesktop();
