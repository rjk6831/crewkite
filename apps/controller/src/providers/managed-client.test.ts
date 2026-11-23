import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { forgetProbes, probeClient } from './anthropic/client-probe.ts';
import { PASSED_FLAGS } from './anthropic/protocol.ts';
import { forgetClientRecord } from './client-record.ts';
import { clientCopies, findClient, managedClientRoot } from './client-versions.ts';
import { fetchNewerClient, refuseManagedClient } from './managed-client.ts';

const mac = { platform: 'darwin', arch: 'arm64' };
const script = (line: string) => `#!/bin/sh\necho "${line}"\n`;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function setup(t: { after(work: () => void): void }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-managed-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = join(base, 'bin');
  const home = join(base, 'home');
  mkdirSync(bin, { mode: 0o755 });
  mkdirSync(home, { mode: 0o700 });
  const environment = { HOME: userInfo().homedir, CREWKITE_HOME: home };
  const root = managedClientRoot(environment) as string;
  return { base, bin, home, environment, root };
}

/** A client file as an installer leaves it. */
function client(folder: string, name: string, line: string) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, name), script(line), { mode: 0o755 });
  return join(folder, name);
}

/** Answers the vendor's published files from memory and lists every URL asked for. */
function vendor(files: Record<string, Buffer | string>) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const body = files[url];
    return body === undefined
      ? new Response('not found', { status: 404 })
      : new Response(new Uint8Array(Buffer.from(body)), { status: 200 });
  }) as typeof fetch;
  return { asked, fetcher };
}

const releases = 'https://downloads.claude.ai/claude-code-releases';
function anthropicRelease(version: string, binary: string, checksum = sha256(binary)) {
  return {
    [`${releases}/latest`]: `${version}\n`,
    [`${releases}/${version}/manifest.json`]: JSON.stringify({
      version,
      platforms: { 'darwin-arm64': { checksum, size: Buffer.byteLength(binary) } },
    }),
    [`${releases}/${version}/darwin-arm64/claude`]: binary,
  };
}

/** The platform package as npm publishes it: the native build under package/vendor. */
function openAiRelease(base: string, version: string, host = 'registry.npmjs.org') {
  const build = join(base, 'pack/package/vendor/aarch64-apple-darwin');
  client(join(build, 'bin'), 'codex', `codex-cli ${version}`);
  // A helper program beside the client, as the package brings its search tool. Mach-O by its
  // first four bytes.
  mkdirSync(join(build, 'codex-path'));
  writeFileSync(join(build, 'codex-path/rg'), Buffer.from('cffaedfe0c000001', 'hex'));
  const made = spawnSync('/usr/bin/tar', [
    '-czf',
    join(base, 'codex.tgz'),
    '-C',
    join(base, 'pack'),
    'package',
  ]);
  assert.equal(made.status, 0);
  const tarball = readFileSync(join(base, 'codex.tgz'));
  const registry = 'https://registry.npmjs.org/@openai%2fcodex';
  const url = `https://${host}/@openai/codex/-/codex-${version}-darwin-arm64.tgz`;
  return {
    [`${registry}/latest`]: JSON.stringify({ version }),
    [`${registry}/${version}-darwin-arm64`]: JSON.stringify({
      dist: {
        tarball: url,
        integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
      },
    }),
    [url]: tarball,
  };
}

const find = (
  family: 'openai' | 'anthropic',
  at: ReturnType<typeof setup>,
  directories: string[] = [at.bin],
) =>
  findClient(family, {
    directories,
    // The provider apps on this computer are left out. Only CrewKite's own folder is listed.
    copies: clientCopies(family, at.environment, { platform: 'linux' }),
    managed: at.root,
    home: at.environment.HOME,
    cache: new Map(),
  } as Parameters<typeof findClient>[1]);

test('a fetched client is kept and run only when its bytes match the published checksum and its signature names the vendor', async (t) => {
  const now = () => '2026-11-21T00:00:00.000Z';
  const binary = script('2.1.400 (Claude Code)');

  // The manifest names another checksum, so the download is dropped before any signature check.
  const tampered = setup(t);
  let verified = 0;
  const wrong = await fetchNewerClient('anthropic', {
    root: tampered.root,
    installed: '2.1.300',
    fetch: vendor(anthropicRelease('2.1.400', binary, sha256('another build'))).fetcher,
    verify: async () => void verified++,
    host: mac,
    now,
  });
  assert.equal(wrong.outcome, 'refused');
  assert.equal(verified, 0);
  assert.deepEqual(clientCopies('anthropic', tampered.environment, { platform: 'linux' }), []);

  // The checksum matches and the file carries no signature. The default check refuses it: on
  // macOS codesign does, and where there is no codesign nothing passes.
  const unsigned = setup(t);
  const refused = await fetchNewerClient('anthropic', {
    root: unsigned.root,
    installed: '2.1.300',
    fetch: vendor(anthropicRelease('2.1.400', binary)).fetcher,
    host: mac,
    now,
  });
  assert.equal(refused.outcome, 'refused');
  assert.match(refused.outcome === 'refused' ? refused.reason : '', /signature/);
  assert.deepEqual(clientCopies('anthropic', unsigned.environment, { platform: 'linux' }), []);
  assert.equal(find('anthropic', unsigned, []).client, undefined);
  // The same build would fail the same way, so the next look does not download it again.
  const again = vendor(anthropicRelease('2.1.400', binary));
  const second = await fetchNewerClient('anthropic', {
    root: unsigned.root,
    installed: '2.1.300',
    fetch: again.fetcher,
    verify: async () => {},
    host: mac,
    now,
  });
  assert.deepEqual(second, { outcome: 'current' });
  assert.deepEqual(again.asked, [`${releases}/latest`]);

  // The registry names a tarball on another host. It is never asked and nothing is kept.
  const elsewhere = setup(t);
  const moved = vendor(openAiRelease(elsewhere.base, '0.200.0', 'downloads.example'));
  const stray = await fetchNewerClient('openai', {
    root: elsewhere.root,
    installed: '0.163.0',
    fetch: moved.fetcher,
    verify: async () => {},
    host: mac,
    now,
  });
  assert.deepEqual(stray, { outcome: 'unavailable' });
  assert.equal(
    moved.asked.some((url) => url.includes('downloads.example')),
    false,
  );
  assert.deepEqual(clientCopies('openai', elsewhere.environment, { platform: 'linux' }), []);

  // The registry's integrity hash matches and the signature check names the vendor's team.
  const signed = setup(t);
  const checked: string[] = [];
  const published = vendor(openAiRelease(signed.base, '0.200.0'));
  const kept = await fetchNewerClient('openai', {
    root: signed.root,
    installed: '0.163.0',
    fetch: published.fetcher,
    verify: async (program, team) => void checked.push(`${basename(program)} ${team}`),
    host: mac,
    now,
  });
  assert.deepEqual(kept, { outcome: 'fetched', version: '0.200.0' });
  // The client and the helper beside it are each checked against the vendor's team.
  assert.deepEqual(checked.sort(), ['codex 2DC432GLL2', 'rg 2DC432GLL2']);
  // Only the npm registry was asked.
  assert.deepEqual(
    [...new Set(published.asked.map((url) => new URL(url).host))],
    ['registry.npmjs.org'],
  );
  const found = find('openai', signed, []);
  assert.equal(found.client?.version, '0.200.0');
  assert.equal(found.client?.executable.startsWith(`${signed.root}/openai/0.200.0/`), true);
  assert.deepEqual(found.status.copy?.fetched, { version: '0.200.0', at: now() });
  assert.equal(found.status.copy?.place, 'crewkite');
});

test('a fetched client that fails its connect-time read is not used and the last good copy runs', (t) => {
  const at = setup(t);
  t.after(() => {
    forgetProbes();
    forgetClientRecord('anthropic');
  });
  forgetProbes();
  client(at.bin, 'claude', '2.1.300 (Claude Code)');
  client(join(at.root, 'anthropic/2.1.400'), 'claude', '2.1.400 (Claude Code)');
  const fetched = find('anthropic', at);
  assert.equal(fetched.client?.version, '2.1.400');

  // The fetched build's help does not list a flag that limits the client.
  const lists = PASSED_FLAGS.filter((flag) => flag !== '--permission-prompts');
  probeClient({
    executable: fetched.client?.executable as string,
    sha256: fetched.client?.sha256 as string,
    version: '2.1.400',
    environment: at.environment,
    help: () => lists.map((flag) => `  ${flag}  described`).join('\n'),
    now: () => '2026-11-21T00:00:00.000Z',
  } as Parameters<typeof probeClient>[0]);

  const after = find('anthropic', at);
  assert.equal(after.client?.version, '2.1.300');
  assert.equal(after.client?.executable, join(at.bin, 'claude'));
  assert.equal(existsSync(join(at.root, 'anthropic/2.1.400')), false);
  // The record says which fetched build is not used and why, for the card's one line.
  assert.equal(after.status.copy?.place, 'search-path');
  assert.equal(after.status.copy?.notUsed?.version, '2.1.400');
  assert.match(after.status.copy?.notUsed?.reason ?? '', /--permission-prompts/);
});

test('fetching touches only the folder CrewKite owns: a client the person installed is never changed and one earlier fetched copy stays', async (t) => {
  const at = setup(t);
  const mine = client(at.bin, 'claude', '2.1.300 (Claude Code)');
  const before = { bytes: readFileSync(mine, 'utf8'), stat: lstatSync(mine, { bigint: true }) };
  client(join(at.root, 'anthropic/2.1.350'), 'claude', '2.1.350 (Claude Code)');
  client(join(at.root, 'anthropic/2.1.360'), 'claude', '2.1.360 (Claude Code)');

  const result = await fetchNewerClient('anthropic', {
    root: at.root,
    installed: '2.1.360',
    fetch: vendor(anthropicRelease('2.1.400', script('2.1.400 (Claude Code)'))).fetcher,
    verify: async () => {},
    host: mac,
    now: () => '2026-11-21T00:00:00.000Z',
  });
  assert.deepEqual(result, { outcome: 'fetched', version: '2.1.400' });
  // The new copy and the one before it stay. The older one goes.
  assert.deepEqual(
    readdirSync(join(at.root, 'anthropic'))
      .filter((name) => /^\d/.test(name))
      .sort(),
    ['2.1.360', '2.1.400'],
  );
  // A failed connect-time read of the person's own client removes nothing.
  assert.equal(
    refuseManagedClient(at.root, 'anthropic', mine, 'It did not answer.', () => 'now'),
    false,
  );
  const after = lstatSync(mine, { bigint: true });
  assert.equal(readFileSync(mine, 'utf8'), before.bytes);
  for (const field of ['ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const)
    assert.equal(after[field], before.stat[field], field);
  assert.deepEqual(readdirSync(at.bin), ['claude']);
});
