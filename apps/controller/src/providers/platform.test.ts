import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { biomePackageName } from '../host/biome-package.ts';
import {
  clientDirectories,
  clientHostGate,
  findClient,
  openAiNativeSibling,
} from './client-versions.ts';
import { resolveLocalConnection } from './local/connection.ts';
import {
  LOCAL_TOKEN_NEEDS_MACOS,
  localTokenRefusal,
  type PlatformFamily,
  platformGate,
} from './platform.ts';

const hosts = {
  'macOS arm64': { platform: 'darwin', arch: 'arm64' },
  'macOS x64': { platform: 'darwin', arch: 'x64' },
  'Linux x64': { platform: 'linux', arch: 'x64' },
  'Linux arm64': { platform: 'linux', arch: 'arm64' },
  'Linux riscv64': { platform: 'linux', arch: 'riscv64' },
  'Windows x64': { platform: 'win32', arch: 'x64' },
} as const;

const unsupported = (name: string) =>
  `${name} runs from CrewKite on macOS with Apple silicon, or on Linux x64 or arm64 in this preview.`;
const googleMacOnly = 'Antigravity CLI runs from CrewKite on macOS with Apple silicon only.';
const googleOnLinux = 'Google is not available on Linux in this preview.';
const windows = 'CrewKite does not run on Windows.';

// Claim (ADR 0013, amendment of 2026-10-31): Linux x64 and arm64 run the OpenAI, Anthropic and
// Local families in the preview, Google is held, Windows is refused, and every refusal is one
// plain sentence.
const names = { openai: 'Codex', anthropic: 'Claude Code', local: 'Local' } as const;
type Row = [PlatformFamily, keyof typeof hosts, true | string];
const shared = (family: keyof typeof names): Row[] => [
  [family, 'macOS arm64', true],
  [family, 'Linux x64', true],
  [family, 'Linux arm64', true],
  [family, 'macOS x64', unsupported(names[family])],
  [family, 'Linux riscv64', unsupported(names[family])],
  [family, 'Windows x64', windows],
];
const table: Row[] = [
  ...shared('openai'),
  ...shared('anthropic'),
  ...shared('local'),
  ['google', 'macOS arm64', true],
  ['google', 'Linux x64', googleOnLinux],
  ['google', 'Linux arm64', googleOnLinux],
  ['google', 'macOS x64', googleMacOnly],
  ['google', 'Linux riscv64', googleMacOnly],
  ['google', 'Windows x64', windows],
];

test('the platform gate allows or refuses each family on each computer with one plain line', () => {
  for (const [family, host, expected] of table) {
    const gate = platformGate(family, hosts[host]);
    const label = `${family} on ${host}`;
    if (expected === true) assert.deepEqual(gate, { allowed: true }, label);
    else {
      assert.deepEqual(gate, { allowed: false, line: expected }, label);
      assert(!expected.includes('\n') && expected.endsWith('.'), `${label} is one sentence`);
    }
  }
  assert.equal(table.length, 4 * 6, 'every family meets every computer');
});

test('the shared client gate gives the platform line first and then the home line', () => {
  const home = { HOME: userInfo().homedir };
  for (const family of ['openai', 'anthropic'] as const)
    for (const [name, host] of Object.entries(hosts)) {
      const gate = platformGate(family, host);
      const found = clientHostGate(family, home, host);
      if (gate.allowed) assert.equal(found, null, `${family} on ${name}`);
      else assert.deepEqual(found, { reason: 'unsupported-platform', detail: gate.line });
    }
  const noHome = clientHostGate('openai', {}, hosts['Linux x64']);
  assert.equal(noHome?.reason, 'native-home-unavailable');
  assert.equal(noHome?.detail, 'Codex needs HOME set to your own home folder.');
});

test('the Local writer connection stays on macOS arm64 and refuses Linux with the platform reason', () => {
  const secretConfigured = false;
  for (const [name, expected] of [
    ['macOS arm64', 'not-configured'],
    ['Linux x64', 'unsupported-platform'],
    ['Linux arm64', 'unsupported-platform'],
    ['macOS x64', 'unsupported-platform'],
    ['Windows x64', 'unsupported-platform'],
  ] as const)
    assert.equal(
      resolveLocalConnection(null, { ...hosts[name], secretConfigured }).facts.reason,
      expected,
      name,
    );
});

test('Local token entry is refused with the keychain line everywhere except macOS', () => {
  assert.equal(localTokenRefusal('darwin'), null);
  for (const platform of ['linux', 'win32', 'freebsd'])
    assert.equal(localTokenRefusal(platform), LOCAL_TOKEN_NEEDS_MACOS, platform);
  assert.match(LOCAL_TOKEN_NEEDS_MACOS, /^Token entry needs the macOS keychain in this preview/);
  assert(LOCAL_TOKEN_NEEDS_MACOS.endsWith('.') && !LOCAL_TOKEN_NEEDS_MACOS.includes('\n'));
});

test('client discovery on Linux searches PATH and fixed install locations only', () => {
  const environment = { HOME: '/home/person', PATH: '/opt/node/bin:relative/bin:/usr/bin' };
  const linux = { platform: 'linux' };
  assert.deepEqual(clientDirectories('openai', environment, linux), [
    '/opt/node/bin',
    '/usr/bin',
    '/home/person/.local/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]);
  assert.deepEqual(
    clientDirectories('anthropic', environment, linux),
    clientDirectories('openai', environment, linux),
  );
  assert.deepEqual(clientDirectories('openai', { PATH: '' }, linux), [
    '/usr/local/bin',
    '/usr/bin',
  ]);
  // macOS keeps its own list, in its own order.
  const mac = { platform: 'darwin' };
  assert.deepEqual(clientDirectories('openai', environment, mac), [
    '/opt/node/bin',
    '/usr/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]);
  assert.deepEqual(clientDirectories('anthropic', environment, mac), [
    '/opt/node/bin',
    '/usr/bin',
    '/home/person/.local/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]);
});

test('the Codex native build sits beside the npm script for each supported computer', () => {
  const entry = '/usr/local/lib/node_modules/@openai/codex/bin/codex.js';
  const package_ = '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai';
  assert.deepEqual(openAiNativeSibling(entry, hosts['macOS arm64']), [
    `${package_}/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`,
  ]);
  assert.deepEqual(openAiNativeSibling(entry, hosts['Linux x64']), [
    `${package_}/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`,
  ]);
  assert.deepEqual(openAiNativeSibling(entry, hosts['Linux arm64']), [
    `${package_}/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex`,
  ]);
  assert.deepEqual(openAiNativeSibling(entry, hosts['Linux riscv64']), []);
});

test('a Linux npm layout resolves to the native build through the shared trust checks', () => {
  // The real path, because the finder reports resolved paths and macOS links /var to /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-linux-client-')));
  try {
    const bin = join(root, 'bin');
    const lib = join(root, 'lib/node_modules/@openai/codex');
    const native = join(
      lib,
      'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin',
    );
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(lib, 'bin'), { recursive: true });
    mkdirSync(native, { recursive: true });
    const script = (path: string, output: string, mode = 0o755) => {
      writeFileSync(path, `#!/bin/sh\n[ "$1" = --version ] || exit 2\necho '${output}'\n`);
      chmodSync(path, mode);
    };
    // The script entry would be refused as too old; the native build beside it is accepted.
    script(join(lib, 'bin/codex.js'), 'codex-cli 0.100.0');
    script(join(native, 'codex'), 'codex-cli 0.170.2');
    symlinkSync(join(lib, 'bin/codex.js'), join(bin, 'codex'));
    const find = () =>
      findClient('openai', {
        directories: [bin],
        home: userInfo().homedir,
        siblings: (entry) => openAiNativeSibling(entry, hosts['Linux x64']),
        cache: new Map(),
        now: () => 0,
      });
    const found = find();
    assert.equal(found.status.accepted, true);
    assert.equal(found.client?.executable, join(native, 'codex'));
    assert.equal(found.client?.version, '0.170.2');

    // Another user can write the native build, so it never runs and the older script explains.
    chmodSync(join(native, 'codex'), 0o757);
    const shared = find();
    assert.equal(shared.client, undefined);
    assert.equal(shared.status.state, 'untrusted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Biome platform package follows the computer and refuses musl and unknown systems', () => {
  for (const [host, glibc, expected] of [
    [hosts['macOS arm64'], true, '@biomejs/cli-darwin-arm64'],
    [hosts['Linux x64'], true, '@biomejs/cli-linux-x64'],
    [hosts['Linux arm64'], true, '@biomejs/cli-linux-arm64'],
    [hosts['Linux x64'], false, null],
    [hosts['Linux arm64'], false, null],
    [hosts['Linux riscv64'], true, null],
    [hosts['macOS x64'], true, null],
    [hosts['Windows x64'], true, null],
    [{ platform: 'constructor', arch: 'x64' }, true, null],
  ] as const)
    assert.equal(biomePackageName(host, glibc), expected, `${host.platform} ${host.arch} ${glibc}`);
});

test('this computer finds an installed Biome platform package at the root version', () => {
  const name = biomePackageName();
  if (name === null) return;
  const manifest = createRequire(join(process.cwd(), 'package.json')).resolve(
    '@biomejs/biome/package.json',
  );
  const binary = createRequire(manifest).resolve(`${name}/package.json`);
  assert.equal(
    JSON.parse(readFileSync(binary, 'utf8')).version,
    JSON.parse(readFileSync(manifest, 'utf8')).version,
  );
});
