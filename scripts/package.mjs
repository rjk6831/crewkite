import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
const primary = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
const { values } = parseArgs({ options: { id: { type: 'string' } } });
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
if (Buffer.byteLength(join(stage, 'state/home/control.sock')) > 100)
  throw new Error('Choose a shorter build name for the packaged controller socket.');
if (existsSync(stage) || existsSync(build))
  throw new Error('Build or package directory already exists. Choose an unused --id.');
const revision = git('rev-parse', 'HEAD');
const bootstrapFiles = ['scripts/demo-controller.ts', 'scripts/demo-state.ts'];
for (const path of bootstrapFiles) {
  try {
    execFileSync('git', ['cat-file', '-e', `${revision}:${path}`], {
      cwd: source,
      stdio: 'ignore',
    });
  } catch {
    throw new Error(`The committed desktop bootstrap is unavailable: ${path}.`);
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
for (const path of bootstrapFiles)
  if (!lstatSync(join(checkout, path)).isFile())
    throw new Error(`The committed desktop bootstrap must be a regular file: ${path}.`);
const lockHash = hash(join(checkout, 'pnpm-lock.yaml'));
if (hash(join(primary, 'pnpm-lock.yaml')) !== lockHash)
  throw new Error('The installed dependency source uses a different lockfile.');
// The existing installation has already passed repository checks. No lifecycle code runs here.
cpSync(join(primary, 'node_modules'), join(checkout, 'node_modules'), {
  recursive: true,
  verbatimSymlinks: true,
  filter: (path) => !['.pnpm-store', '.pnpm-cache', '.pnpm-state'].includes(basename(path)),
});
const workspaces = [
  'apps/controller',
  'apps/cli',
  'apps/desktop',
  'packages/contracts',
  'packages/client',
  'packages/testkit',
];
const buildDependencies = [];
for (const path of ['.', ...workspaces]) {
  if (path !== '.') copy(join(primary, path, 'node_modules'), join(checkout, path, 'node_modules'));
  const manifestPath = join(checkout, path, 'package.json');
  const manifest = json(manifestPath);
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    if (version === 'workspace:*') continue;
    const installedPath = realpathSync(
      join(dirname(manifestPath), 'node_modules', name, 'package.json'),
    );
    inside(installedPath, checkout);
    const installed = json(installedPath);
    if (installed.name !== name || installed.version !== version)
      throw new Error(`Installed dependency identity changed: ${name}.`);
    buildDependencies.push({ name, version, manifest: hash(installedPath) });
  }
}
function validateLinks(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    inside(path, checkout);
    if (lstatSync(path).isDirectory()) validateLinks(path);
  }
}
validateLinks(checkout);
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
const primaryDesktop = createRequire(join(primary, 'apps/desktop/package.json'));
const electron = dirname(primaryDesktop.resolve('electron/package.json'));
const electronVersion = json(join(electron, 'package.json')).version;
if (electronVersion !== json(join(checkout, 'apps/desktop/package.json')).devDependencies.electron)
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
      mode: 'demo',
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
  `${launcherRoot}test -f "$root/app/runtime/scripts/demo-controller.ts" || { echo 'The packaged demo bootstrap is unavailable.' >&2; exit 1; }\nexport CREWKITE_HOME="$root/state/home"\nexport CREWKITE_PROFILE="$root/state/profile"\nexec "$root/Electron.app/Contents/MacOS/Electron" "$root/app"\n`,
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
    if (!(name.startsWith('@crewkite/') && version === 'workspace:*') && name !== 'zod')
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
cpSync(zod, join(runtime, 'node_modules/zod'), {
  recursive: true,
  filter: (path) => relative(zod, path).split(sep)[0] !== 'src',
});

const notices = [];
function notice(name, version, from, filename) {
  const destination = `notices/${filename}`;
  copy(from, join(stage, destination));
  notices.push({ name, version, license: destination, sha256: hash(from) });
}
for (const filename of ['LICENSE', 'NOTICE'])
  notice('CrewKite', desktop.version, join(checkout, filename), filename);
for (const filename of ['LICENSE', 'NOTICE', 'docs/credits.md'])
  copy(join(checkout, filename), join(stage, filename));
notice('CrewKite source credits', revision, join(checkout, 'docs/credits.md'), 'credits.md');
notice('Node', nodeVersion, join(nodeRoot, 'LICENSE'), 'node-LICENSE');
notice('Electron', electronVersion, join(electron, 'dist/LICENSE'), 'electron-LICENSE');
notice(
  'Chromium and Electron components',
  electronVersion,
  join(electron, 'dist/LICENSES.chromium.html'),
  'LICENSES.chromium.html',
);
const fromDesktop = createRequire(join(checkout, 'apps/desktop/package.json'));
const reactDom = fromDesktop.resolve('react-dom/package.json');
for (const [name, locator] of [
  ['react', fromDesktop],
  ['react-dom', fromDesktop],
  ['scheduler', createRequire(reactDom)],
  ['lucide-react', fromDesktop],
  ['@fontsource/inter', fromDesktop],
  ['@fontsource/jetbrains-mono', fromDesktop],
  ['tailwindcss', fromDesktop],
  ['zod', contracts],
  ['rolldown', createRequire(fromDesktop.resolve('vite/package.json'))],
]) {
  const manifestPath = locator.resolve(`${name}/package.json`);
  const manifest = json(manifestPath);
  notice(
    name,
    manifest.version,
    join(dirname(manifestPath), 'LICENSE'),
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
  'Electron.app/Contents/MacOS/Electron',
  `app/${desktop.main}`,
  'app/out/preload/index.cjs',
  'app/runtime/bin/node',
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
inspect(stage);
writeFileSync(
  join(stage, 'manifest.json'),
  `${JSON.stringify(
    {
      format: 1,
      id: values.id,
      revision,
      lockHash,
      buildDependencies,
      platform: 'darwin',
      architecture: 'arm64',
      qualification: 'static-stage-only',
      bootstrap: 'present',
      runtime: { path: 'app/runtime/bin/node', version: nodeVersion, sha256: nodeHash },
      electron: { version: electronVersion },
      notices,
      files,
    },
    null,
    2,
  )}\n`,
);
console.log(`Static package staged at ${stage}`);
console.log(`Disposable build source retained at ${checkout}`);
console.log('Desktop, relocation and recovery journeys remain unqualified.');
