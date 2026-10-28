import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type McpServerInput, mcpSecrets, scrubSecrets } from '@crewkite/contracts';
import type { SecretStorage } from './local-token.ts';
import { McpVault, NO_KEYCHAIN } from './mcp-vault.ts';

const storage = (backend: string): SecretStorage => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => backend,
  encryptString: (value) => Buffer.from(value.split('').reverse().join('')),
  decryptString: (blob) => blob.toString().split('').reverse().join(''),
});
const task = 'tsk_00000000000000000000000001';
const input: McpServerInput = {
  name: 'notes',
  command: 'notes-server',
  args: ['--root', 'docs'],
  secretArgs: ['--token=arg-secret-1'],
  env: { NOTES_KEY: 'env-secret-1' },
  readTools: ['read_*'],
};

test('a stored secret is sealed on disk, never returned to the window, and removed from the events of a turn', (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'crewkite-mcp-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const vault = new McpVault(profile, storage('gnome_libsecret'));
  const view = vault.save(input);
  // The window's view holds the plain arguments, a count of secret ones and the variable names.
  assert.deepEqual(view.servers, [
    {
      name: 'notes',
      command: 'notes-server',
      args: ['--root', 'docs'],
      secretArgCount: 1,
      envKeys: ['NOTES_KEY'],
      readTools: ['read_*'],
    },
  ]);
  const file = readFileSync(join(profile, 'mcp-servers.json'), 'utf8');
  for (const secret of mcpSecrets(input)) assert.ok(!file.includes(secret), 'secret on disk');
  assert.ok(!JSON.stringify(vault.state()).includes('env-secret-1'));
  // Edit keeps the sealed values. A server is off for a thread until the person turns it on.
  vault.save({ ...input, secretArgs: [], env: {}, readTools: ['list_*'], keepSecrets: true });
  assert.deepEqual(vault.supply().threads, {});
  vault.setThread(task, 'notes', 'reads');
  const supplied = vault.supply();
  assert.deepEqual(supplied.servers[0]?.env, { NOTES_KEY: 'env-secret-1' });
  assert.deepEqual(supplied.servers[0]?.secretArgs, ['--token=arg-secret-1']);
  assert.deepEqual(supplied.threads, { [task]: { notes: 'reads' } });
  // The values come out of every string of an event, keys included, and short values stay.
  const event = {
    type: 'tool.output',
    chunk: 'ran with --token=arg-secret-1 and env-secret-1',
    nested: [{ 'env-secret-1': 'ok', n: 12 }],
  };
  assert.deepEqual(scrubSecrets(event, mcpSecrets(supplied.servers[0] as never)), {
    type: 'tool.output',
    chunk: 'ran with [redacted] and [redacted]',
    nested: [{ '[redacted]': 'ok', n: 12 }],
  });
  assert.equal(scrubSecrets('a b', ['a']), 'a b');
  // With no keychain a server with secrets is refused and one without them is kept.
  const bare = new McpVault(mkdtempSync(join(profile, 'x-')), storage('basic_text'));
  assert.throws(() => bare.save(input), { message: NO_KEYCHAIN });
  assert.equal(bare.save({ ...input, secretArgs: [], env: {} }).servers.length, 1);
  // Removing a server removes it from every thread.
  assert.deepEqual(vault.remove('notes').threads, {});
});
