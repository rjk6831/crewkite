import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Command } from '@crewkite/contracts';
import {
  controllerPort,
  type LocalTokenPort,
  LocalTokenVault,
  PORT_REASON,
  RememberedLocalToken,
  type SecretStorage,
  UNAVAILABLE_REASON,
  unsupportedPort,
} from './local-token.ts';

const endpoint = 'ws://127.0.0.1:1234';
const actor = { id: 'desktop', kind: 'desktop' as const };
const storage = (
  backend: string | undefined,
  options: { encryption?: boolean; broken?: boolean } = {},
): SecretStorage => ({
  isEncryptionAvailable: () => options.encryption ?? true,
  ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
  encryptString: (value) => Buffer.from(`sealed:${value}`.split('').reverse().join('')),
  decryptString: (blob) => {
    if (options.broken) throw new Error('keychain changed');
    return blob.toString().split('').reverse().join('').slice('sealed:'.length);
  },
});

test('a remembered Local token needs a real backend and goes with a changed endpoint or mode', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'crewkite-token-'));
  const file = join(profile, 'local-token.json');
  try {
    // Only a fixed-key or unchosen backend, or no encryption at all, is unusable.
    const backends: [string | undefined, boolean, boolean][] = [
      ['basic_text', true, false],
      ['unknown', true, false],
      ['gnome_libsecret', true, true],
      ['kwallet6', true, true],
      [undefined, true, true],
      ['gnome_libsecret', false, false],
    ];
    for (const [backend, encryption, available] of backends) {
      const found = new LocalTokenVault(profile, storage(backend, { encryption })).capability(
        endpoint,
        'token',
      );
      assert.equal(found.available, available, `${backend} ${encryption}`);
      assert.equal(found.reason, available ? undefined : UNAVAILABLE_REASON);
    }
    assert.throws(
      () => new LocalTokenVault(profile, storage('basic_text')).remember(endpoint, 'token', 'abc'),
      /keychain/,
    );
    assert.equal(existsSync(file), false);

    const vault = new LocalTokenVault(profile, storage('kwallet6'));
    vault.remember(endpoint, 'token', 'abc123');
    assert.equal(readFileSync(file, 'utf8').includes('abc123'), false);
    assert.equal(vault.read(endpoint, 'token'), 'abc123');
    assert.equal(vault.capability(endpoint, 'token').remembered, true);
    // Another port deletes the blob, and the first endpoint does not find it again.
    assert.equal(vault.capability('ws://127.0.0.1:1235', 'token').remembered, false);
    assert.equal(existsSync(file), false);
    assert.equal(vault.read(endpoint, 'token'), null);
    vault.remember(endpoint, 'token', 'abc123');
    assert.equal(vault.read(endpoint, 'none'), null);
    assert.equal(existsSync(file), false);
    assert.throws(() => vault.remember(endpoint, 'none', 'abc123'), /token connection/);
    vault.remember(endpoint, 'token', 'abc123');
    vault.forget();
    assert.equal(existsSync(file), false);
    // A blob the keychain cannot open is deleted, not retried.
    vault.remember(endpoint, 'token', 'abc123');
    assert.equal(
      new LocalTokenVault(profile, storage('kwallet6', { broken: true })).read(endpoint, 'token'),
      null,
    );
    assert.equal(existsSync(file), false);
    writeFileSync(file, '{"version":2}');
    assert.equal(vault.read(endpoint, 'token'), null);

    // The renderer calls over the real port: the controller hands the token over on
    // ReadLocalToken, takes it back on SupplyLocalToken, and Forget clears its copy.
    let held: string | null = 'live-token';
    const given: string[] = [];
    const sent: Command[] = [];
    const port = controllerPort(async (command) => {
      sent.push(command);
      if (command.command === 'ReadLocalToken')
        return { outcome: 'applied', data: { kind: 'local-token', token: held } };
      if (command.command !== 'SupplyLocalToken') throw new Error('Not a token command.');
      given.push(command.payload.token);
      return { outcome: 'applied' };
    }, actor);
    const disconnects: number[] = [];
    const setup = { endpoint, authMode: 'token' as const, secretConfigured: true, revision: 7 };
    const calls = (use: LocalTokenPort) =>
      new RememberedLocalToken(
        new LocalTokenVault(profile, storage('kwallet6')),
        use,
        async () => setup,
        async (revision) => {
          disconnects.push(revision);
        },
      );
    const none = await calls(unsupportedPort).status();
    assert.deepEqual(none, { available: false, reason: PORT_REASON, remembered: false });
    const remembered = calls(port);
    assert.deepEqual(await remembered.remember(), { available: true, remembered: true });
    assert.equal(await remembered.supply(), true);
    assert.deepEqual(given, ['live-token']);
    // Reads with the desktop actor and no expected revision, so no receipt holds the token.
    assert.deepEqual(
      sent.map((command) => [command.command, command.actor, 'expectedRevision' in command]),
      [
        ['ReadLocalToken', actor, false],
        ['SupplyLocalToken', actor, false],
      ],
    );
    held = null;
    await remembered.forget();
    assert.deepEqual(disconnects, [7]);
    assert.equal(existsSync(file), false);
    await assert.rejects(remembered.remember(), /no token/);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
