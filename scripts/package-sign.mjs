import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  cpSync,
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
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyRuntimeIntegrity } from '../packages/client/src/runtime-integrity.ts';
import { CREWKITE_VERSION } from '../packages/contracts/src/version.ts';

const application = 'CrewKite.app';
const runtimePath = 'Contents/Resources/app/runtime';
const developerID =
  '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
const unchanged = (before, after) =>
  ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeNs', 'ctimeNs'].every(
    (key) => before[key] === after[key],
  );
const failure = (phase) => new Error(`Release preparation failed during ${phase}.`);
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

export function releaseDestination(source, destination) {
  const path = resolve(destination);
  const parent = dirname(path);
  if (
    realpathSync(parent) !== parent ||
    !lstatSync(parent).isDirectory() ||
    inside(source, path) ||
    inside(path, source)
  )
    throw failure('separate release destination');
  return path;
}

export function createReleaseDirectory(path) {
  mkdirSync(path, { mode: 0o700 });
  const state = lstatSync(path);
  if (
    realpathSync(path) !== path ||
    !state.isDirectory() ||
    state.uid !== process.getuid?.() ||
    (state.mode & 0o777) !== 0o700
  )
    throw failure('private release destination');
}

export function fileHash(path) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.mode & 0o022n)
      throw failure('file identity');
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(512 * 1024);
    let total = 0n;
    for (;;) {
      const count = readSync(file, bytes);
      if (!count) break;
      total += BigInt(count);
      hash.update(bytes.subarray(0, count));
    }
    if (
      total !== before.size ||
      !unchanged(before, fstatSync(file, { bigint: true })) ||
      !unchanged(before, lstatSync(path, { bigint: true }))
    )
      throw failure('file identity');
    return hash.digest('hex');
  } finally {
    closeSync(file);
  }
}

/** The inventory uses the directory stage's file and contained-link records. */
export function packageInventory(root, omit = []) {
  root = realpathSync(root);
  const rows = [];
  let total = 0;
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const entry = relative(root, path);
      if (omit.includes(entry)) continue;
      if (rows.length >= 100000) throw failure('inventory limit');
      const state = lstatSync(path);
      if (state.uid !== process.getuid?.()) throw failure('file ownership');
      if (state.isSymbolicLink()) {
        if (isAbsolute(readlinkSync(path)) || !inside(root, realpathSync(path)))
          throw failure('contained links');
        rows.push({ path: entry, target: relative(root, realpathSync(path)) });
      } else if (state.isDirectory()) walk(path);
      else if (state.isFile()) {
        total += state.size;
        if (total > 8 * 1024 ** 3) throw failure('inventory limit');
        rows.push({
          path: entry,
          bytes: state.size,
          sha256: fileHash(path),
          mode: state.mode & 0o777,
        });
      } else throw failure('regular payload');
    }
  };
  walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function assertInventory(root, expected, omit = []) {
  if (!Array.isArray(expected) || expected.length > 100000) throw failure('inventory');
  const seen = new Set();
  const normalized = expected
    .map((row) => {
      if (
        !row ||
        typeof row.path !== 'string' ||
        !row.path ||
        isAbsolute(row.path) ||
        row.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        seen.has(row.path) ||
        omit.includes(row.path)
      )
        throw failure('inventory');
      seen.add(row.path);
      return row.target === undefined
        ? { path: row.path, bytes: row.bytes, sha256: row.sha256, mode: row.mode }
        : { path: row.path, target: row.target };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (JSON.stringify(packageInventory(root, omit)) !== JSON.stringify(normalized))
    throw failure('inventory');
}

export function readReleaseRecord(path) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(file, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid()) ||
      before.mode & 0o022n ||
      before.size > 16n * 1024n * 1024n
    )
      throw failure('release record');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const length = readSync(file, bytes, count, bytes.length - count, null);
      if (!length) break;
      count += length;
    }
    if (
      BigInt(count) !== before.size ||
      !unchanged(before, fstatSync(file, { bigint: true })) ||
      !unchanged(before, lstatSync(path, { bigint: true }))
    )
      throw failure('release record');
    const held = bytes.subarray(0, count);
    let value;
    try {
      value = JSON.parse(held.toString('utf8'));
    } catch {
      throw failure('release record');
    }
    return { value, sha256: createHash('sha256').update(held).digest('hex') };
  } finally {
    closeSync(file);
  }
}

export const readReleaseJson = (path) => readReleaseRecord(path).value;

export function releaseEnvironment(environment = process.env) {
  for (const key of ['CREWKITE_SIGN_IDENTITY', 'CREWKITE_NOTARY_PROFILE'])
    if (!environment[key]?.trim() || /[\r\n]/.test(environment[key]))
      throw new Error(`Set ${key} before preparing a release.`);
  return {
    identity: environment.CREWKITE_SIGN_IDENTITY,
    profile: environment.CREWKITE_NOTARY_PROFILE,
  };
}

/** Tool output stays in bounded pipes. Errors never include arguments or raw diagnostics. */
async function executeTool(executable, args, { timeout = 30000 } = {}) {
  return new Promise((done) => {
    const child = spawn(executable, args, {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', HOME: homedir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      failed = false;
    const stop = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, timeout);
    for (const [stream, key] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ])
      stream.on('data', (chunk) => {
        if (key === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 8 * 1024 * 1024) stop();
      });
    child.on('error', () => {
      failed = true;
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      done({ status, signal, failed, stdout, stderr });
    });
  });
}

export function releaseTools(dependencies = {}) {
  const execute = dependencies.execute ?? executeTool;
  return async (phase, executable, args, { allowFailure = false, ...options } = {}) => {
    let result;
    try {
      result = await execute(executable, args, options);
    } catch {
      throw failure(phase);
    }
    if (
      !result ||
      result.failed ||
      result.error ||
      result.signal ||
      !Number.isInteger(result.status) ||
      (!allowFailure && result.status !== 0)
    )
      throw failure(phase);
    return result;
  };
}

const jsonResult = (result, phase) => {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw failure(phase);
  }
};

export async function notarizeArtifact(path, profile, run, ticket = path, checkpoint) {
  const submitted = jsonResult(
    await run(
      'notary submission',
      '/usr/bin/xcrun',
      ['notarytool', 'submit', path, '--keychain-profile', profile, '--output-format', 'json'],
      { timeout: 120000 },
    ),
    'notary response',
  );
  if (!/^[0-9a-f-]{36}$/i.test(submitted.id ?? '')) throw failure('notary response');
  if (checkpoint)
    writeFileSync(
      checkpoint,
      `${JSON.stringify({ id: submitted.id, sha256: fileHash(path), status: 'Submitted' }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  const completed = jsonResult(
    await run(
      'notary completion',
      '/usr/bin/xcrun',
      [
        'notarytool',
        'wait',
        submitted.id,
        '--keychain-profile',
        profile,
        '--output-format',
        'json',
      ],
      { timeout: 20 * 60 * 1000 },
    ),
    'notary response',
  );
  if (completed.id !== submitted.id || completed.status !== 'Accepted')
    throw failure('notary acceptance');
  const log = jsonResult(
    await run('notary log', '/usr/bin/xcrun', [
      'notarytool',
      'log',
      submitted.id,
      '--keychain-profile',
      profile,
    ]),
    'notary log',
  );
  if (log.status !== 'Accepted' || (log.issues !== null && !Array.isArray(log.issues)))
    throw failure('notary log');
  const warnings = (log.issues ?? []).filter((issue) => issue.severity === 'warning').length;
  if ((log.issues ?? []).some((issue) => issue.severity !== 'warning')) throw failure('notary log');
  await run('ticket stapling', '/usr/bin/xcrun', ['stapler', 'staple', ticket]);
  await run('ticket validation', '/usr/bin/xcrun', ['stapler', 'validate', ticket]);
  return { id: submitted.id, status: 'Accepted', warnings, stapled: true };
}

export async function assessArtifact(path, kind, run) {
  const args =
    kind === 'app'
      ? ['--assess', '--type', 'execute', '--verbose=4', path]
      : [
          '--assess',
          '--type',
          'open',
          '--context',
          'context:primary-signature',
          '--verbose=4',
          path,
        ];
  await run('Gatekeeper assessment', '/usr/sbin/spctl', args);
  const requested = await run(
    'install assessment',
    '/usr/sbin/spctl',
    ['-a', '-vvv', '-t', 'install', path],
    { allowFailure: true },
  );
  return {
    assessed: kind === 'app' ? 'execute' : 'open-primary-signature',
    accepted: true,
    requestedInstallExit: requested.status,
  };
}

export async function verifyDeveloperSignature(
  path,
  { identity, executable = false, deep = false },
  run,
) {
  await run('Developer ID verification', '/usr/bin/codesign', [
    '--verify',
    ...(deep ? ['--deep'] : []),
    '--strict',
    '-R',
    developerID,
    path,
  ]);
  const detail = await run('signing identity verification', '/usr/bin/codesign', [
    '--display',
    '--verbose=4',
    path,
  ]);
  if (!detail.stderr.split(/\r?\n/).includes(`Authority=${identity}`))
    throw failure('signing identity verification');
  if (executable && !/flags=.*\bruntime\b/.test(detail.stderr))
    throw failure('hardened runtime verification');
}

function signingPlan(app, rows) {
  const objects = new Map();
  let main = false;
  const helpers = new Map([
    ['CrewKite Helper', false],
    ['CrewKite Helper (GPU)', false],
    ['CrewKite Helper (Plugin)', false],
    ['CrewKite Helper (Renderer)', true],
  ]);
  for (const row of rows.filter((entry) => entry.target === undefined)) {
    const path = join(app, row.path);
    const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const header = Buffer.alloc(4);
    let count;
    try {
      count = readSync(file, header);
    } finally {
      closeSync(file);
    }
    if (count < 4) continue;
    const magic = header.readUInt32BE(0);
    const native = [
      0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe, 0xcafebabf, 0xbebafeca,
      0xbfbafeca,
    ].includes(magic);
    if (!native) {
      if (magic === 0x7f454c46 || header.toString('ascii', 0, 2) === 'MZ')
        throw failure('native classification');
      continue;
    }
    const entry = row.path;
    let target = path,
      jit = false,
      executable = true,
      identifier,
      order = 0;
    if (entry === 'Contents/MacOS/CrewKite') {
      main = true;
      continue;
    }
    if (entry === `${runtimePath}/bin/node`) {
      jit = true;
      identifier = 'node';
    } else if (entry === `${runtimePath}/bin/local-secure-input`) identifier = 'local-input';
    else if (entry === `${runtimePath}/node_modules/@biomejs/cli-darwin-arm64/biome`)
      identifier = 'formatter';
    else if (
      entry === 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
    ) {
      target = join(app, 'Contents/Frameworks/Electron Framework.framework');
      executable = false;
      order = 3;
    } else if (
      /^Contents\/Frameworks\/(Mantle|ReactiveObjC|Squirrel)\.framework\/Versions\/A\/\1$/.test(
        entry,
      )
    ) {
      const name = entry.split('/')[2];
      target = join(app, 'Contents/Frameworks', name);
      executable = false;
      order = name === 'Squirrel.framework' ? 2 : 1;
    } else if (entry === 'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt') {
      identifier = 'shipit';
    } else if (
      /^Contents\/Frameworks\/Electron Framework\.framework\/Versions\/A\/Libraries\/[a-zA-Z0-9_.-]+\.dylib$/.test(
        entry,
      )
    )
      executable = false;
    else if (
      entry ===
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler'
    )
      identifier = 'crash-handler';
    else {
      const helper = [...helpers].find(
        ([name]) => entry === `Contents/Frameworks/${name}.app/Contents/MacOS/${name}`,
      );
      if (!helper) throw failure('native classification');
      target = join(app, `Contents/Frameworks/${helper[0]}.app`);
      jit = helper[1];
      order = 4;
    }
    objects.set(target, { path: target, jit, executable, identifier, order });
  }
  if (
    !main ||
    [...helpers].some(([name]) => !objects.has(join(app, `Contents/Frameworks/${name}.app`)))
  )
    throw failure('native classification');
  return [...objects.values()].sort(
    (a, b) =>
      a.order - b.order ||
      b.path.split(sep).length - a.path.split(sep).length ||
      a.path.localeCompare(b.path),
  );
}

function writeEntitlements(path, jit) {
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${jit ? '<key>com.apple.security.cs.allow-jit</key><true/>' : ''}</dict></plist>\n`,
    { mode: 0o600, flag: 'wx' },
  );
}

async function verifyBranding(app, run) {
  for (const suffix of [null, '', ' (GPU)', ' (Plugin)', ' (Renderer)']) {
    const main = suffix === null;
    const name = main ? 'CrewKite' : `CrewKite Helper${suffix}`;
    const role = suffix ? `.${suffix.slice(2, -1).toLowerCase()}` : '';
    const plist = main
      ? join(app, 'Contents/Info.plist')
      : join(app, `Contents/Frameworks/${name}.app/Contents/Info.plist`);
    const metadata = jsonResult(
      await run('application metadata', '/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]),
      'application metadata',
    );
    const expected = {
      CFBundleName: name,
      CFBundleDisplayName: name,
      CFBundleExecutable: name,
      CFBundleIdentifier: `com.rootsnolimits.crewkite${main ? '' : `.helper${role}`}`,
      CFBundleVersion: CREWKITE_VERSION,
      CFBundleShortVersionString: CREWKITE_VERSION,
      ...(main ? { CFBundleIconFile: 'CrewKite.icns' } : {}),
    };
    if (Object.entries(expected).some(([key, value]) => metadata[key] !== value))
      throw failure('application metadata');
  }
  const desktop = readReleaseJson(join(app, 'Contents/Resources/app/package.json'));
  if (
    desktop.name !== 'crewkite' ||
    desktop.productName !== 'CrewKite' ||
    desktop.version !== CREWKITE_VERSION
  )
    throw failure('product version');
}

export async function signPackage(
  { source, destination, revision, environment = process.env },
  dependencies = {},
) {
  const { identity, profile } = releaseEnvironment(environment);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw failure('macOS arm64 host');
  source = realpathSync(source);
  destination = releaseDestination(source, destination);
  if (
    !/^[0-9a-f]{40}$/.test(revision ?? '') ||
    inside(source, destination) ||
    inside(destination, source)
  )
    throw failure('source selection');
  const inputRecord = readReleaseRecord(join(source, 'manifest.json'));
  const manifest = inputRecord.value;
  if (readdirSync(source).sort().join('\n') !== 'CrewKite.app\nmanifest.json')
    throw failure('committed stage shape');
  if (
    manifest.format !== 2 ||
    manifest.layout !== 'installed' ||
    manifest.mode !== 'workspace' ||
    manifest.platform !== 'darwin' ||
    manifest.architecture !== 'arm64' ||
    manifest.revision !== revision ||
    manifest.electron?.bundle !== application ||
    manifest.buildInputs?.nodeSha256 !==
      'b468fb9c67427c9d3aec07ee1105e63020923a631a9a2a00beb71a7ba3768bfd' ||
    !/^[0-9a-f]{64}$/.test(manifest.buildInputs?.localInputSha256 ?? '')
  )
    throw failure('committed stage provenance');
  assertInventory(source, manifest.files, ['manifest.json']);
  const sourceHash = inputRecord.sha256;
  const original = verifyRuntimeIntegrity(join(source, application, runtimePath));
  if (original.manifest.node.platform !== 'darwin' || original.manifest.node.arch !== 'arm64')
    throw failure('runtime target');
  const icon = join(source, application, 'Contents/Resources/CrewKite.icns');
  if (!lstatSync(icon).isFile() || readFileSync(icon).subarray(0, 4).toString('ascii') !== 'icns')
    throw failure('application icon');
  const plan = signingPlan(join(source, application), packageInventory(join(source, application)));
  if (
    !plan.some((item) => item.identifier === 'node') ||
    !plan.some((item) => item.identifier === 'local-input')
  )
    throw failure('native classification');
  const run = releaseTools(dependencies);
  await run('source application integrity', '/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    join(source, application),
  ]);
  await verifyBranding(join(source, application), run);
  createReleaseDirectory(destination);
  for (const entry of readdirSync(source))
    cpSync(join(source, entry), join(destination, entry), {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
  assertInventory(destination, manifest.files, ['manifest.json']);
  renameSync(join(destination, 'manifest.json'), join(destination, 'input-manifest.json'));
  const app = join(destination, application);
  const runtime = join(app, runtimePath);
  const entitlements = join(destination, 'jit-entitlements.plist');
  const emptyEntitlements = join(destination, 'empty-entitlements.plist');
  writeEntitlements(entitlements, true);
  writeEntitlements(emptyEntitlements, false);
  const signed = [];
  for (const item of plan) {
    const path = join(app, relative(join(source, application), item.path));
    const args = ['--force', '--sign', identity, '--timestamp'];
    if (item.executable) args.push('--options', 'runtime');
    if (item.identifier) args.push('--identifier', `com.rootsnolimits.crewkite.${item.identifier}`);
    if (item.executable) args.push('--entitlements', item.jit ? entitlements : emptyEntitlements);
    await run('nested code signing', '/usr/bin/codesign', [...args, path]);
    signed.push({ path: relative(app, path), executable: item.executable, jit: item.jit });
  }
  const finalManifest = {
    ...original.manifest,
    node: { ...original.manifest.node, sha256: fileHash(join(runtime, 'bin/node')) },
    localInput: {
      ...original.manifest.localInput,
      sha256: fileHash(join(runtime, 'bin/local-secure-input')),
    },
  };
  writeFileSync(join(runtime, 'manifest.json'), `${JSON.stringify(finalManifest, null, 2)}\n`);
  verifyRuntimeIntegrity(runtime);
  await run('application signing', '/usr/bin/codesign', [
    '--force',
    '--sign',
    identity,
    '--timestamp',
    '--options',
    'runtime',
    '--entitlements',
    entitlements,
    app,
  ]);
  for (const item of [...signed, { path: '', executable: true, jit: true }]) {
    const path = join(app, item.path);
    await verifyDeveloperSignature(path, { identity, executable: item.executable }, run);
    if (item.executable) {
      const entitlements = await run('entitlement verification', '/usr/bin/codesign', [
        '--display',
        '--entitlements',
        '-',
        '--xml',
        path,
      ]);
      const keys = [...entitlements.stdout.matchAll(/<key>([^<]+)<\/key>/g)].map(
        (match) => match[1],
      );
      if (
        JSON.stringify(keys) !==
          JSON.stringify(item.jit ? ['com.apple.security.cs.allow-jit'] : []) ||
        (item.jit &&
          !/<key>com.apple.security.cs.allow-jit<\/key>\s*<true\s*\/>/.test(entitlements.stdout))
      )
        throw failure('entitlement verification');
    }
  }
  await run('application integrity', '/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const zip = join(destination, 'notary-app.zip');
  await run('notary archive', '/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  const notary = await notarizeArtifact(
    zip,
    profile,
    run,
    app,
    join(destination, 'notary-app-state.json'),
  );
  await run('application integrity', '/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  verifyRuntimeIntegrity(runtime);
  const assessment = await assessArtifact(app, 'app', run);
  assertInventory(source, manifest.files, ['manifest.json']);
  if (fileHash(join(source, 'manifest.json')) !== sourceHash) throw failure('immutable source');
  const receipt = {
    version: 1,
    kind: 'signed-app',
    productVersion: CREWKITE_VERSION,
    revision,
    app: application,
    inputManifest: 'input-manifest.json',
    inputManifestSha256: sourceHash,
    buildInputs: manifest.buildInputs,
    runtime: finalManifest,
    developerID: true,
    hardenedRuntime: true,
    notary,
    assessment,
    files: packageInventory(app),
  };
  const receiptPath = join(destination, 'release-receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { app, receipt: receiptPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        source: { type: 'string' },
        destination: { type: 'string' },
        revision: { type: 'string' },
      },
    });
    const result = await signPackage(values);
    console.log(`Signed application receipt: ${result.receipt}`);
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith('Set CREWKITE_')
        ? error.message
        : 'Release signing failed. The source stage was preserved.',
    );
    process.exitCode = 1;
  }
}
