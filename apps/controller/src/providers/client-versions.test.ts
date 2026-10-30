import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CLIENT_VERSIONS,
  clientFileTrust,
  clientVersionState,
  clientVersionStatus,
  findClient,
  parseClientVersion,
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
  ] as const)
    assert.equal(clientVersionState(output, row), state, output);
  assert.equal(clientVersionState(null, row), 'unreadable');
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

test('the chat path still refuses a client file that other users can write or another account owns', () => {
  const uid = process.getuid?.() ?? 0;
  const other = uid + 1;
  const file = (mode: number, owner = uid, size = 10, regular = true) => ({
    isFile: () => regular,
    size,
    uid: owner,
    mode: 0o100000 | mode,
  });
  for (const [stat, verdict] of [
    [file(0o755), 'trusted'],
    [file(0o700), 'trusted'],
    [file(0o775), 'trusted'],
    [file(0o755, 0), 'trusted'],
    [file(0o757), 'shared-write'],
    [file(0o777), 'shared-write'],
    [file(0o755, other), 'foreign-owner'],
    [file(0o777, other), 'foreign-owner'],
    [file(0o755, uid, 2048), 'not-a-client'],
    [file(0o755, uid, 10, false), 'not-a-client'],
  ] as const)
    assert.equal(clientFileTrust(stat, 1024, uid), verdict, JSON.stringify(stat));
});

test('finding a client runs its version flag once per build and refuses a world-writable file before it runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'crewkite-client-versions-'));
  try {
    const bin = join(root, 'bin');
    const store = join(root, 'store');
    mkdirSync(bin);
    mkdirSync(store);
    const log = join(root, 'runs.log');
    // A script stands in for the client. It records each run and prints the version it is given.
    const client = (name: string, output: string, mode = 0o755) => {
      const path = join(store, name);
      writeFileSync(
        path,
        `#!/bin/sh\necho "$0 $1" >> '${log}'\n[ "$1" = --version ] || exit 2\necho '${output}'\n`,
      );
      chmodSync(path, mode);
      return path;
    };
    const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0);
    const cache = new Map();
    const find = () =>
      findClient('openai', { directories: [bin], home: userInfo().homedir, cache, now: () => 0 });

    assert.equal(find().status.state, 'missing');

    const newer = client('codex-newer', 'codex-cli 0.170.2');
    symlinkSync(newer, join(bin, 'codex'));
    const found = find();
    assert.equal(found.status.state, 'newer');
    assert.equal(found.status.version, '0.170.2');
    assert.equal(found.client?.executable, newer);
    assert.match(found.client?.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(runs(), 1);
    find();
    assert.equal(runs(), 1, 'an unchanged build is not run again');

    chmodSync(newer, 0o757);
    const shared = find();
    assert.equal(shared.status.state, 'untrusted');
    assert.equal(shared.client, undefined);
    assert.equal(runs(), 1, 'a world-writable client never runs');

    rmSync(join(bin, 'codex'));
    symlinkSync(client('codex-old', '0.120.0'), join(bin, 'codex'));
    const old = find();
    assert.equal(old.status.state, 'older');
    assert.equal(old.client, undefined);

    rmSync(join(bin, 'codex'));
    symlinkSync(client('codex-silent', 'no version here'), join(bin, 'codex'));
    assert.equal(find().status.state, 'unreadable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
