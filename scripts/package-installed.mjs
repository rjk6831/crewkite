import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const bundleId = 'com.rootsnolimits.crewkite';
const helpers = ['', ' (GPU)', ' (Plugin)', ' (Renderer)'];

function updatePlist(path, values) {
  const options = { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 };
  const plist = JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], options),
  );
  Object.assign(plist, values);
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', path, '-'], {
    ...options,
    input: JSON.stringify(plist),
  });
}

/** Bundle names and identifiers must agree before macOS seals the copied runtime. */
export function brandMacPackage({ stage, version, icon }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new Error('The application needs its release version.');
  if (icon !== undefined && (!lstatSync(icon).isFile() || lstatSync(icon).isSymbolicLink()))
    throw new Error('The application icon must be a regular file.');
  const app = join(stage, 'CrewKite.app');
  if (existsSync(app)) throw new Error('The application destination already exists.');
  renameSync(join(stage, 'Electron.app'), app);
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  const packagePath = join(stage, 'app/package.json');
  const desktop = JSON.parse(readFileSync(packagePath, 'utf8'));
  Object.assign(desktop, { name: 'crewkite', productName: 'CrewKite', version });
  writeFileSync(packagePath, `${JSON.stringify(desktop, null, 2)}\n`);
  renameSync(join(contents, 'MacOS/Electron'), join(contents, 'MacOS/CrewKite'));
  const metadata = {
    CFBundleName: 'CrewKite',
    CFBundleDisplayName: 'CrewKite',
    CFBundleExecutable: 'CrewKite',
    CFBundleIdentifier: bundleId,
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
  };
  if (icon !== undefined) {
    copyFileSync(icon, join(resources, 'CrewKite.icns'));
    metadata.CFBundleIconFile = 'CrewKite.icns';
  }
  updatePlist(join(contents, 'Info.plist'), metadata);
  for (const suffix of helpers) {
    const name = `CrewKite Helper${suffix}`;
    const oldName = `Electron Helper${suffix}`;
    const helper = join(contents, 'Frameworks', `${name}.app`);
    renameSync(join(contents, 'Frameworks', `${oldName}.app`), helper);
    renameSync(join(helper, 'Contents/MacOS', oldName), join(helper, 'Contents/MacOS', name));
    const role = suffix ? `.${suffix.slice(2, -1).toLowerCase()}` : '';
    updatePlist(join(helper, 'Contents/Info.plist'), {
      CFBundleName: name,
      CFBundleDisplayName: name,
      CFBundleExecutable: name,
      CFBundleIdentifier: `${bundleId}.helper${role}`,
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
    });
  }
  return app;
}

/** Installed state lives outside the bundle, so replacing application files preserves its path. */
export function assembleInstalledPackage({ stage, platform = process.platform, version, icon }) {
  if (platform !== 'darwin') throw new Error('Installed assembly currently requires macOS.');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new Error('The installed application needs its release version.');
  stage = resolve(stage);
  const allowed = new Set([
    'Electron.app',
    'app',
    'notices',
    'docs',
    'LICENSE',
    'NOTICE',
    'README.md',
    'CrewKite.command',
    'Upgrade Existing.command',
    'bin',
    'scripts',
  ]);
  if (readdirSync(stage).some((entry) => !allowed.has(entry)))
    throw new Error('Installed assembly refuses unrecognized staged entries or state.');
  for (const [directory, entries] of [
    ['bin', ['desktop', 'crewkite']],
    ['scripts', ['package-upgrade.mjs']],
  ]) {
    const path = join(stage, directory);
    const state = lstatSync(path);
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      readdirSync(path).some((entry) => !entries.includes(entry))
    )
      throw new Error('Installed assembly refuses unrecognized legacy launcher files.');
  }
  for (const entry of ['Electron.app', 'app', 'notices', 'docs']) {
    const state = lstatSync(join(stage, entry));
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error('Installed assembly needs a real staged payload.');
  }
  const app = brandMacPackage({ stage, version, icon });
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  const appRoot = join(resources, 'app');
  renameSync(join(stage, 'app'), appRoot);
  const runtime = join(appRoot, 'runtime');
  const manifestPath = join(runtime, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.layout = 'installed';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const distribution = join(resources, 'distribution');
  mkdirSync(distribution);
  for (const entry of ['LICENSE', 'NOTICE', 'README.md', 'notices', 'docs'])
    renameSync(join(stage, entry), join(distribution, entry));
  const bin = join(resources, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'crewkite'),
    '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd "$(dirname "$0")/../app/runtime" && pwd -P)\nexec "$root/bin/node" "$root/apps/cli/src/installed.ts" "$@"\n',
    { mode: 0o755, flag: 'wx' },
  );
  for (const entry of [
    'CrewKite.command',
    'Upgrade Existing.command',
    'bin/desktop',
    'bin/crewkite',
    'scripts/package-upgrade.mjs',
  ]) {
    const path = join(stage, entry);
    const state = lstatSync(path);
    if (!state.isFile() || state.isSymbolicLink())
      throw new Error('A legacy launcher must be a regular file.');
    rmSync(path);
  }
  rmdirSync(join(stage, 'bin'));
  rmdirSync(join(stage, 'scripts'));
  const requiredEntries = [
    'CrewKite.app/Contents/MacOS/CrewKite',
    'CrewKite.app/Contents/Info.plist',
    'CrewKite.app/Contents/Resources/app/package.json',
    'CrewKite.app/Contents/Resources/app/runtime/manifest.json',
    'CrewKite.app/Contents/Resources/app/runtime/bin/node',
    'CrewKite.app/Contents/Resources/app/runtime/bin/local-secure-input',
    'CrewKite.app/Contents/Resources/app/runtime/apps/cli/src/installed.ts',
    'CrewKite.app/Contents/Resources/app/runtime/apps/controller/src/providers/file-digest-worker.ts',
    'CrewKite.app/Contents/Resources/bin/crewkite',
    ...helpers.flatMap((suffix) => [
      `CrewKite.app/Contents/Frameworks/CrewKite Helper${suffix}.app/Contents/Info.plist`,
      `CrewKite.app/Contents/Frameworks/CrewKite Helper${suffix}.app/Contents/MacOS/CrewKite Helper${suffix}`,
    ]),
    ...['LICENSE', 'NOTICE', 'README.md', 'notices', 'docs'].map(
      (entry) => `CrewKite.app/Contents/Resources/distribution/${entry}`,
    ),
  ];
  return {
    root: stage,
    app,
    runtime,
    executable: join(contents, 'MacOS/CrewKite'),
    requiredEntries,
  };
}
