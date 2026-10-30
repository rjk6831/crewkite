import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CLIENT_VERSIONS,
  type ClientReads,
  clientFileTrust,
  clientVersionState,
  clientVersionStatus,
  findClient,
  forgetClientReads,
  foundLocationTrust,
  parseClientVersion,
  unreadableRetryMs,
} from './client-versions.ts';

const row = { tested: '0.163.0', minimum: '0.150.0' };

test('the chat path accepts a client at or above the minimum within the tested major and refuses the rest', () => {
  for (const [output, state] of [
    ['codex-cli 0.163.0', 'tested'],
    ['codex-cli 0.170.2', 'newer'],
    ['0.163.1', 'newer'],
    ['codex-cli 0.155.4', 'supported'],
    ['0.150.0', 'supported'],
    ['codex-cli 0.149.9', 'older'],
    ['0.9.0', 'older'],
    // A later major release is where native frames change without notice, so it is refused.
    ['1.0.0', 'new-major'],
    ['codex-cli 2.3.1', 'new-major'],
    // A prerelease ranks below its own release.
    ['0.163.0-alpha.2', 'supported'],
    ['0.164.0-beta.1', 'newer'],
    ['0.150.0-rc.1', 'older'],
    // A leading v and build metadata change nothing.
    ['v0.163.0', 'tested'],
    ['v0.171.0+build.7', 'newer'],
    ['agy v0.149.0', 'older'],
    // No version in the output is unreadable.
    ['', 'unreadable'],
    ['codex-cli unknown', 'unreadable'],
    ['0.163', 'unreadable'],
    ['00.163.0', 'unreadable'],
    // Under major 0 a newer minor is accepted as newer: one client ships a new 0.minor weekly.
    ['0.200.0', 'newer'],
    // A line announcing an update names another version and is skipped.
    ['Update available: 0.180.0 -> run npm install\ncodex-cli 0.163.0', 'tested'],
    ['codex-cli 0.164.0\nThe latest version is 1.0.0', 'newer'],
    // When every line is a notice, the first version on the first line is the client's own.
    ['0.163.0 (x) update available 0.170.0', 'tested'],
    ['codex-cli 0.164.0, latest is 0.171.0\nRun the update to get it', 'newer'],
    ['An update is available', 'unreadable'],
  ] as const)
    assert.equal(clientVersionState(output, row), state, output);
  assert.equal(clientVersionState(null, row), 'unreadable');
});

test('prerelease builds order by semantic versioning, numbers by value', () => {
  const rows = [
    ['0.164.0-alpha', '0.164.0-alpha.1'],
    ['0.164.0-alpha.1', '0.164.0-alpha.beta'],
    ['0.164.0-alpha.2', '0.164.0-alpha.10'],
    ['0.164.0-beta.2', '0.164.0-beta.11'],
    ['0.164.0-rc.1', '0.164.0'],
    ['0.164.0-9', '0.164.0-10'],
    ['0.164.0-10', '0.164.0-alpha'],
  ] as const;
  for (const [lower, higher] of rows) {
    // With the lower build as the tested one the higher reads as newer, and never the reverse.
    assert.equal(
      clientVersionState(higher, { tested: lower, minimum: '0.1.0' }),
      'newer',
      `${higher} > ${lower}`,
    );
    assert.equal(
      clientVersionState(lower, { tested: higher, minimum: '0.1.0' }),
      'supported',
      `${lower} < ${higher}`,
    );
  }
});

test('each family names its own tested build, minimum and update command, with the minimum in the tested major', () => {
  for (const [family, value] of Object.entries(CLIENT_VERSIONS)) {
    const tested = parseClientVersion(value.tested);
    const minimum = parseClientVersion(value.minimum);
    assert(tested && minimum, family);
    assert.equal(tested.core[0], minimum.core[0], family);
    assert.equal(clientVersionState(value.tested, value), 'tested', family);
    assert.equal(
      clientVersionState(value.minimum, value),
      value.minimum === value.tested ? 'tested' : 'supported',
      family,
    );
    assert(value.update.length > 0, family);
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(CLIENT_VERSIONS).map(([family, value]) => [
        family,
        [value.tested, value.minimum],
      ]),
    ),
    { openai: ['0.163.0', '0.163.0'], anthropic: ['2.1.302', '2.1.0'], google: ['1.4.2', '1.4.0'] },
  );
});

test('Settings and the CLI name the found version and the state in plain words', () => {
  const at = (family: keyof typeof CLIENT_VERSIONS, version: string | null) =>
    clientVersionStatus(family, { state: 'version', path: '/opt/homebrew/bin/client', version });
  for (const [status, accepted, message] of [
    [
      at('openai', 'codex-cli 0.170.2'),
      true,
      'Codex 0.170.2 found. Tested with 0.163.0; newer builds usually work.',
    ],
    [
      at('openai', '0.163.0'),
      true,
      'Codex 0.163.0 found. This is the build CrewKite was tested with.',
    ],
    [
      at('anthropic', '1.9.0 (Claude Code)'),
      false,
      'Claude Code 1.9.0 is older than the minimum 2.1.0. Update it with claude update, then press Check again.',
    ],
    [
      at('anthropic', '2.1.120 (Claude Code)'),
      true,
      'Claude Code 2.1.120 found. Tested with 2.1.302; builds from 2.1.0 on are supported.',
    ],
    [
      at('google', '2.0.0'),
      false,
      'Antigravity CLI 2.0.0 found. CrewKite is tested with 1.4.2 and does not run a new major version yet. Install a 1.x build, or update CrewKite.',
    ],
    [
      at('google', null),
      false,
      'CrewKite could not read the version of Antigravity CLI at /opt/homebrew/bin/client. Run agy --version in a terminal to see why, then check again.',
    ],
    [
      clientVersionStatus('openai', { state: 'missing' }),
      false,
      'Codex was not found. Install it and sign in, then check again.',
    ],
  ] as const) {
    assert.equal(status.accepted, accepted, message);
    assert.equal(status.message, message);
    assert(!/[\u2013\u2014]/.test(status.message), 'no en or em dash in UI copy');
  }
});

test('the chat path still refuses a client file its group or other users can write, in a shared folder or owned by another account', () => {
  const uid = process.getuid?.() ?? 0;
  const other = uid + 1;
  const file = (mode: number, owner = uid, size = 10, regular = true) => ({
    isFile: () => regular,
    size,
    uid: owner,
    mode: 0o100000 | mode,
  });
  const folder = (mode: number) => ({ mode: 0o040000 | mode });
  for (const [stat, parent, verdict] of [
    [file(0o755), folder(0o755), 'trusted'],
    [file(0o700), folder(0o700), 'trusted'],
    [file(0o555), folder(0o775), 'trusted'],
    [file(0o755, 0), folder(0o755), 'trusted'],
    [file(0o775), folder(0o755), 'shared-write'],
    [file(0o757), folder(0o755), 'shared-write'],
    [file(0o777), folder(0o755), 'shared-write'],
    [file(0o755), folder(0o757), 'shared-folder'],
    [file(0o755), folder(0o1777), 'shared-folder'],
    [file(0o755, other), folder(0o755), 'foreign-owner'],
    [file(0o777, other), folder(0o777), 'foreign-owner'],
    [file(0o755, uid, 2048), folder(0o755), 'not-a-client'],
    [file(0o755, uid, 10, false), folder(0o755), 'not-a-client'],
  ] as const)
    assert.equal(
      clientFileTrust(stat, 1024, uid, parent),
      verdict,
      `${stat.mode.toString(8)} in ${parent.mode.toString(8)}`,
    );
});

function scratch() {
  // The real path, because the finder reports resolved paths and macOS links /var to /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-client-versions-')));
  const bin = join(root, 'bin');
  const store = join(root, 'store');
  mkdirSync(bin);
  mkdirSync(store);
  chmodSync(store, 0o755);
  const log = join(root, 'runs.log');
  // A script stands in for the client. It records each run, then runs the body it is given.
  const client = (name: string, body: string, mode = 0o755) => {
    const path = join(store, name);
    writeFileSync(path, `#!/bin/sh\necho "$0 $1" >> '${log}'\n${body}\n`);
    chmodSync(path, mode);
    return path;
  };
  const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0);
  const link = (path: string) => {
    rmSync(join(bin, 'codex'), { force: true });
    symlinkSync(path, join(bin, 'codex'));
  };
  return { root, bin, store, client, runs, link };
}

test('a client found through a folder other users can write is refused unless the folder is sticky and the entry is mine', () => {
  const uid = process.getuid?.() ?? 0;
  const other = uid + 1;
  const folder = (mode: number) => ({ mode: 0o040000 | mode });
  for (const [parent, owner, verdict] of [
    [folder(0o755), uid, 'trusted'],
    [folder(0o775), other, 'trusted'],
    [folder(0o777), uid, 'shared-folder'],
    [folder(0o757), 0, 'shared-folder'],
    [folder(0o1777), uid, 'trusted'],
    [folder(0o1777), 0, 'trusted'],
    [folder(0o1777), other, 'shared-folder'],
  ] as const)
    assert.equal(
      foundLocationTrust(parent, { uid: owner }, uid),
      verdict,
      `${parent.mode.toString(8)} owner ${owner === uid ? 'me' : owner}`,
    );

  // A world-writable folder on PATH holds a link to a trusted client. The client never runs.
  const { root, bin, client, runs, link } = scratch();
  try {
    link(client('codex', "echo '0.170.2'"));
    const find = () =>
      findClient('openai', { directories: [bin], home: userInfo().homedir, cache: new Map() });
    chmodSync(bin, 0o777);
    const refused = find();
    assert.equal(refused.status.state, 'untrusted');
    assert.equal(
      refused.status.message,
      `Codex at ${join(bin, 'codex')} is in a folder other users can change, so CrewKite will not run it.`,
    );
    assert.equal(runs(), 0);
    // The same folder with the sticky bit and a link I own is safe to search.
    chmodSync(bin, 0o1777);
    assert.equal(find().status.state, 'newer');
    assert.equal(runs(), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finding a client runs its version flag once per build and refuses an unsafe file before it runs', () => {
  const { root, bin, store, client, runs, link } = scratch();
  try {
    const cache: ClientReads = new Map();
    const find = () =>
      findClient('openai', { directories: [bin], home: userInfo().homedir, cache, now: () => 0 });

    assert.equal(find().status.state, 'missing');

    const newer = client('codex-newer', "echo 'codex-cli 0.170.2'");
    link(newer);
    const found = find();
    assert.equal(found.status.state, 'newer');
    assert.equal(found.status.version, '0.170.2');
    assert.equal(found.client?.executable, newer);
    assert.match(found.client?.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(runs(), 1);
    find();
    assert.equal(runs(), 1, 'an unchanged build is not run again');

    for (const [mode, folder, message] of [
      [0o757, 0o755, 'can be changed by other users'],
      [0o775, 0o755, 'can be changed by other users'],
      [0o755, 0o757, 'is in a folder other users can change'],
    ] as const) {
      chmodSync(newer, mode);
      chmodSync(store, folder);
      const refused = find();
      assert.equal(refused.status.state, 'untrusted', mode.toString(8));
      assert.match(refused.status.message, new RegExp(message));
      assert.equal(refused.client, undefined);
      assert.equal(runs(), 1, 'an unsafe client never runs');
    }
    chmodSync(store, 0o755);

    link(client('codex-old', "echo '0.120.0'"));
    const old = find();
    assert.equal(old.status.state, 'older');
    assert.equal(old.client, undefined);

    link(client('codex-silent', "echo 'no version here'"));
    assert.equal(find().status.state, 'unreadable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a client file CrewKite cannot read is unreadable and never stops the search or its caller', () => {
  const { root, bin, client, runs, link } = scratch();
  try {
    link(client('codex', "echo '0.170.2'"));
    for (const code of ['EACCES', 'ENOENT']) {
      const found = findClient('openai', {
        directories: [bin],
        home: userInfo().homedir,
        cache: new Map(),
        hash: () => {
          throw Object.assign(new Error(code), { code });
        },
      });
      assert.equal(found.status.state, 'unreadable', code);
      assert.equal(found.client, undefined, code);
      assert.equal(runs(), 0, `${code}: a file that cannot be hashed is not run`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable version is read again after a backoff, at once when the file changes or on Check again, and never inside a transaction', () => {
  const { root, bin, client, runs, link } = scratch();
  try {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map(unreadableRetryMs),
      [60_000, 120_000, 240_000, 480_000, 900_000, 900_000],
    );
    const silent = client('codex', "echo 'no version'");
    link(silent);
    const cache: ClientReads = new Map();
    let now = 0;
    const find = (cachedOnly = false) =>
      findClient('openai', {
        directories: [bin],
        home: userInfo().homedir,
        cache,
        now: () => now,
        cachedOnly,
      }).status.state;

    assert.equal(find(true), 'unreadable');
    assert.equal(runs(), 0, 'a cached-only resolution runs nothing');
    // An accepted build that changes reads as unreadable to a cached-only caller, without a run.
    const good = client('codex-good', "echo '0.170.2'");
    link(good);
    assert.equal(find(), 'newer');
    writeFileSync(good, `${readFileSync(good, 'utf8')}\n# changed\n`);
    assert.equal(find(true), 'unreadable');
    assert.equal(runs(), 1);
    link(silent);
    rmSync(join(root, 'runs.log'));
    assert.equal(find(), 'unreadable');
    assert.equal(runs(), 1);
    for (const [at, expected] of [
      [59_999, 1],
      [60_000, 2],
      [179_999, 2],
      [180_000, 3],
    ] as const) {
      now = at;
      find();
      assert.equal(runs(), expected, `at ${at}`);
    }
    forgetClientReads('openai', cache);
    find();
    assert.equal(runs(), 4, 'Check again reads at once');
    forgetClientReads('anthropic', cache);
    find();
    assert.equal(runs(), 4, 'another family keeps its reads');
    writeFileSync(silent, `${readFileSync(silent, 'utf8')}\n# changed\n`);
    find();
    assert.equal(runs(), 5, 'a changed file reads at once');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the version read is bounded, kills its whole process group and passes a minimal environment', () => {
  const { root, bin, store, client, link } = scratch();
  try {
    const pids = join(root, 'pids');
    link(client('codex', `sleep 30 &\necho $! > '${pids}'\nsleep 30`));
    const started = Date.now();
    const hung = findClient('openai', {
      directories: [bin],
      home: userInfo().homedir,
      cache: new Map(),
      timeoutMs: 300,
    });
    assert.equal(hung.status.state, 'unreadable');
    assert(Date.now() - started < 5000, 'the read stops at its bound');
    const left = Number(readFileSync(pids, 'utf8').trim());
    assert(left > 0);
    assert(gone(left), 'a process the client left in its group is killed');

    // A client that reports its own environment. Nothing of the controller's reaches it.
    const seen = join(root, 'env.json');
    const script = join(store, 'codex-env');
    writeFileSync(
      script,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env).sort()));\nconsole.log('0.170.2');\n`,
    );
    chmodSync(script, 0o755);
    link(script);
    process.env.CREWKITE_FIXTURE_SECRET = 'canary';
    try {
      const found = findClient('openai', {
        directories: [bin],
        home: userInfo().homedir,
        path: '/usr/bin:/bin',
        cache: new Map(),
      });
      assert.equal(found.status.state, 'newer');
    } finally {
      delete process.env.CREWKITE_FIXTURE_SECRET;
    }
    // macOS adds __CF_USER_TEXT_ENCODING to every process it starts; CrewKite does not pass it.
    const passed = (JSON.parse(readFileSync(seen, 'utf8')) as string[]).filter(
      (name) => !name.startsWith('__CF_'),
    );
    assert.deepEqual(passed, ['HOME', 'LANG', 'NO_COLOR', 'PATH']);

    // A file that changes while its version runs keeps no version.
    link(client('codex-changing', `echo '# touched' >> "$0"\necho '0.170.2'`));
    const swapped = findClient('openai', {
      directories: [bin],
      home: userInfo().homedir,
      cache: new Map(),
    });
    assert.equal(swapped.status.state, 'unreadable');
    assert.equal(swapped.client, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The process is gone or only waits to be reaped. Checked a bounded number of times, no sleep. */
function gone(pid: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    const stat = state.stdout.trim();
    if (!stat || stat.startsWith('Z')) return true;
  }
  return false;
}
