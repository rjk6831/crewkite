import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const fail = (message) => {
  throw Error(message);
};
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const exists = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function rootPath(path) {
  const value = resolve(path);
  if (value !== realpathSync(value) || !lstatSync(value).isDirectory())
    fail('Choose a canonical package directory without symbolic links.');
  if (lstatSync(value).uid !== process.getuid()) fail('The package must belong to this account.');
  return value;
}
function regularHash(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) fail('A package file has an unsupported identity.');
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(512 * 1024);
    for (;;) {
      const length = readSync(fd, buffer);
      if (length === 0) break;
      digest.update(buffer.subarray(0, length));
    }
    const after = fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail('A file changed while it was read. Keep the app closed.');
    return digest.digest('hex');
  } finally {
    closeSync(fd);
  }
}
function inventory(root, { omitState = false, privateState = false } = {}) {
  const rows = [];
  const deadline = Date.now() + 120000;
  let bytes = 0;
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      if (rows.length > 100000 || Date.now() > deadline)
        fail('The package inventory exceeded its bound.');
      const path = join(directory, name),
        entry = relative(root, path);
      if (omitState && (entry === 'state' || entry === 'manifest.json')) continue;
      const state = lstatSync(path);
      if (state.uid !== process.getuid()) fail('Package entries must belong to this account.');
      if (state.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target) || !inside(root, realpathSync(path)))
          fail('A symbolic link leaves the selected tree.');
        rows.push({ path: entry, target: relative(root, realpathSync(path)), link: target });
      } else if (state.isDirectory()) {
        if (privateState && (state.mode & 0o077) !== 0) {
          fail('State directories must be private.');
        }
        rows.push({ path: entry, directory: true, mode: state.mode & 0o777 });
        walk(path);
      } else if (state.isFile()) {
        bytes += state.size;
        if (bytes > 8 * 1024 ** 3) fail('The package copy exceeds eight GiB.');
        rows.push({
          path: entry,
          bytes: state.size,
          mode: state.mode & 0o777,
          sha256: regularHash(path),
        });
      } else
        fail('A socket or special file remains. Quit the app and controller before upgrading.');
    }
  };
  walk(root);
  return rows;
}
function readManifest(root) {
  const path = join(root, 'manifest.json');
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.size > 16 * 1024 * 1024)
    fail('The package manifest is unavailable.');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (
    value.format !== 1 ||
    value.mode !== 'workspace' ||
    value.platform !== 'darwin' ||
    value.architecture !== 'arm64' ||
    !/^[0-9a-f]{40}$/.test(value.revision) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) ||
    !Array.isArray(value.files)
  )
    fail('Choose a supported workspace package with its original manifest.');
  return value;
}
function verifyPayload(root, manifest, allowOldRuntimeChanges = false) {
  const rows = inventory(root, { omitState: true });
  const actual = rows.filter((row) => !row.directory).map(({ link: _link, ...row }) => row);
  const normalize = (row) =>
    row.target === undefined
      ? { path: row.path, bytes: row.bytes, sha256: row.sha256, mode: row.mode }
      : { path: row.path, target: row.target };
  const expected = [...manifest.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (
    expected.some(
      (row) =>
        typeof row.path !== 'string' ||
        !row.path ||
        isAbsolute(row.path) ||
        !inside(root, resolve(root, row.path)) ||
        row.path === 'manifest.json' ||
        row.path.startsWith('state/'),
    ) ||
    new Set(expected.map((row) => row.path)).size !== expected.length ||
    JSON.stringify(
      actual
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .filter((row) => !allowOldRuntimeChanges || !row.path.startsWith('Electron.app/'))
        .map(normalize),
    ) !==
      JSON.stringify(
        expected
          .filter((row) => !allowOldRuntimeChanges || !row.path.startsWith('Electron.app/'))
          .map(normalize),
      )
  )
    fail('The package inventory differs from its manifest. No files were replaced.');
  return {
    rows,
    runtimeChanged:
      JSON.stringify(actual.map(normalize)) !== JSON.stringify(expected.map(normalize)),
  };
}
function copyRegular(from, to, mode) {
  const input = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    if (!fstatSync(input).isFile() || fstatSync(input).nlink !== 1)
      fail('A copy source changed identity.');
    output = openSync(
      to,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    const buffer = Buffer.alloc(512 * 1024);
    for (;;) {
      const length = readSync(input, buffer);
      if (length === 0) break;
      let position = 0;
      while (position < length) position += writeSync(output, buffer, position, length - position);
    }
    fchmodSync(output, mode);
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
  }
}
function copyTree(source, destination, rows) {
  for (const row of rows) {
    const from = join(source, row.path),
      to = join(destination, row.path);
    if (row.directory) mkdirSync(to, { mode: row.mode });
    else if (row.link !== undefined) symlinkSync(row.link, to);
    else copyRegular(from, to, row.mode);
  }
}
function run(executable, args, timeout = 15000) {
  return spawnSync(executable, args, {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C' },
    encoding: 'utf8',
    timeout,
    maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function assertInactive(target, execute = run) {
  const profile = join(target, 'state/profile');
  if (readdirSync(profile).some((name) => name.startsWith('Singleton')))
    fail('Quit the app first. A desktop profile lock remains; no lock was deleted.');
  const result = execute('/usr/sbin/lsof', ['-nP', '-F', 'p', '+D', target]);
  if (
    result.error ||
    result.signal ||
    ![0, 1].includes(result.status) ||
    result.stderr ||
    (result.stdout && !/^(p[0-9]+\n)+$/.test(result.stdout))
  )
    fail('App activity could not be established. Keep the app closed and try again.');
  const pids = (result.stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((row) => Number(row.slice(1)));
  if (pids.some((pid) => pid !== process.pid && pid !== result.pid))
    fail('The selected package is still in use. Quit its app and controller first.');
}

export async function upgradePackage({ source, target, confirm }, dependencies = {}) {
  source = rootPath(source);
  target = rootPath(target);
  if (inside(source, target) || inside(target, source))
    fail('Select separate old and new package folders.');
  if (Buffer.byteLength(join(target, 'state/home/control.sock')) > 100)
    fail('The installed path exceeds the controller socket bound.');
  const beforeRoot = lstatSync(target);
  const candidate = readManifest(source),
    previous = readManifest(target);
  const candidateManifest = regularHash(join(source, 'manifest.json'));
  const previousManifest = regularHash(join(target, 'manifest.json'));
  if (candidate.revision === previous.revision)
    fail('These packages have the same source revision.');
  verifyPayload(source, candidate);
  const previousPayload = verifyPayload(target, previous, true);
  const sourceState = join(source, 'state');
  const sourceStateEntry = lstatSync(sourceState, { throwIfNoEntry: false });
  if (sourceStateEntry && (sourceStateEntry.isSymbolicLink() || !sourceStateEntry.isDirectory()))
    fail('The replacement state path must be a real, contained directory.');
  if (
    sourceStateEntry &&
    (realpathSync(sourceState) !== sourceState || readdirSync(sourceState).length)
  )
    fail('Use a fresh, unopened replacement package.');
  if (
    candidate.electron?.signature?.kind !== 'ad-hoc' ||
    candidate.electron.signature.verified !== 'deep-strict'
  )
    fail('The replacement package lacks its runtime seal record.');
  const execute = dependencies.execute ?? run;
  const signature = execute('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    join(source, 'Electron.app'),
  ]);
  if (signature.error || signature.signal || signature.status !== 0)
    fail('The replacement runtime seal failed verification.');
  const state = join(target, 'state'),
    home = join(state, 'home');
  for (const directory of [state, home, join(state, 'profile')]) {
    if (rootPath(directory) !== directory || lstatSync(directory).mode & 0o077)
      fail('The existing state must be private.');
  }
  assertInactive(target, execute);
  const suffix = randomUUID(),
    stage = join(dirname(target), `.${basename(target)}.upgrade-${suffix}`);
  const backup = join(dirname(target), `${basename(target)}.backup-${suffix}`);
  const plan = {
    target,
    backup,
    stage,
    previous: previous.id,
    replacement: candidate.id,
    previousRuntimeChanged: previousPayload.runtimeChanged,
  };
  if (!(await confirm(plan))) return { outcome: 'cancelled' };
  const ownerPath = join(home, 'owner.sqlite');
  const ownerStat = lstatSync(ownerPath);
  if (
    !ownerStat.isFile() ||
    ownerStat.isSymbolicLink() ||
    ownerStat.nlink !== 1 ||
    ownerStat.mode & 0o077
  )
    fail('The existing controller ownership file is unavailable.');
  const owner = new DatabaseSync(ownerPath);
  let moved = false;
  const move = dependencies.rename ?? renameSync;
  try {
    try {
      owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    } catch {
      fail(
        'The controller is active or its ownership lease is unavailable. Quit it before upgrading.',
      );
    }
    assertInactive(target, execute);
    const originalState = inventory(state, { privateState: true });
    const payload = inventory(source, { omitState: true });
    mkdirSync(stage, { mode: 0o700 });
    copyTree(source, stage, payload);
    copyRegular(
      join(source, 'manifest.json'),
      join(stage, 'manifest.json'),
      lstatSync(join(source, 'manifest.json')).mode & 0o777,
    );
    mkdirSync(join(stage, 'state'), { mode: lstatSync(state).mode & 0o777 });
    copyTree(state, join(stage, 'state'), originalState);
    verifyPayload(stage, candidate);
    if (
      JSON.stringify(inventory(join(stage, 'state'), { privateState: true })) !==
        JSON.stringify(originalState) ||
      JSON.stringify(inventory(state, { privateState: true })) !== JSON.stringify(originalState)
    )
      fail('State changed during copying. No upgrade was installed.');
    const currentPayload = verifyPayload(target, previous, true);
    if (JSON.stringify(currentPayload.rows) !== JSON.stringify(previousPayload.rows))
      fail('The existing payload changed during copying. No upgrade was installed.');
    if (
      regularHash(join(source, 'manifest.json')) !== candidateManifest ||
      regularHash(join(stage, 'manifest.json')) !== candidateManifest ||
      regularHash(join(target, 'manifest.json')) !== previousManifest
    )
      fail('A package manifest changed during preparation.');
    const currentRoot = lstatSync(target);
    if (currentRoot.dev !== beforeRoot.dev || currentRoot.ino !== beforeRoot.ino || exists(backup))
      fail('The selected package identity changed.');
    assertInactive(target, execute);
    move(target, backup);
    moved = true;
    try {
      assertInactive(backup, execute);
      if (exists(target)) fail('The installed path was occupied during upgrade.');
      move(stage, target);
      moved = false;
    } catch (error) {
      if (!exists(target)) {
        move(backup, target);
        moved = false;
      }
      throw error;
    }
    return {
      outcome: 'installed',
      target,
      backup,
      revision: candidate.revision,
      previousRuntimeChanged: previousPayload.runtimeChanged,
      previousPayloadEntries: previousPayload.rows.length,
      previousPayloadDigest: hash(JSON.stringify(previousPayload.rows)),
      stateEntries: originalState.length,
      stateDigest: hash(JSON.stringify(originalState)),
    };
  } catch (error) {
    if (moved)
      fail('The original package remains at its named backup. Keep all folders for recovery.');
    throw error;
  } finally {
    owner.close();
  }
}

function dialog(script, args = []) {
  const result = run('/usr/bin/osascript', ['-e', script, ...args], 120000);
  if (result.error || result.signal || result.status !== 0)
    fail('Upgrade cancelled. No package was replaced.');
  return result.stdout.trim();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: { source: { type: 'string' }, target: { type: 'string' } },
    });
    const target =
      values.target ??
      dialog(
        'POSIX path of (choose folder with prompt "Choose the existing CrewKite package. Keep its app closed.")',
      );
    const result = await upgradePackage({
      source: values.source,
      target,
      confirm: (plan) =>
        dialog(
          'on run argv\ndisplay dialog (item 1 of argv) buttons {"Cancel", "Upgrade"} default button "Cancel" cancel button "Cancel"\nreturn button returned of result\nend run',
          [
            `Upgrade ${plan.previous} to ${plan.replacement} at:\n${plan.target}\n\nKeep the app closed until this finishes. Verify the release checksum first.\n\nThe original package will be kept at:\n${plan.backup}\n\n${plan.previousRuntimeChanged ? 'The old Electron runtime differs from its original inventory. Its actual bytes will be retained in the backup; no old runtime will be executed.\n\n' : ''}Rollback requires restoring the whole original folder to its original path.`,
          ],
        ) === 'Upgrade',
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Upgrade failed.');
    process.exitCode = 1;
  }
}
