import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../apps/controller/src/store/index.ts';
import { CommandReceipts } from '../apps/desktop/src/main/receipts.ts';
import { upgradePackage } from './package-upgrade.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function payload(path, id, revision) {
  mkdirSync(join(path, 'Electron.app'), { recursive: true });
  writeFileSync(join(path, 'runtime'), id, { mode: 0o755 });
  writeFileSync(join(path, 'Electron.app/runtime'), id, { mode: 0o644 });
  writeFileSync(
    join(path, 'manifest.json'),
    JSON.stringify({
      format: 1,
      mode: 'workspace',
      platform: 'darwin',
      architecture: 'arm64',
      id,
      revision,
      electron: { signature: { kind: 'ad-hoc', verified: 'deep-strict' } },
      files: [
        { path: 'runtime', bytes: id.length, sha256: hash(id), mode: 0o755 },
        { path: 'Electron.app/runtime', bytes: id.length, sha256: hash(id), mode: 0o644 },
      ],
    }),
  );
}

test('package upgrade preserves fixed-path state and refuses unsafe swaps', async (t) => {
  for (const scenario of [
    'installed',
    'old-re-signed',
    'finder-metadata',
    'finder-link',
    'finder-large',
    'old-payload-drift',
    'source-state-link',
    'lease',
    'second-rename',
    'active',
    'profile-lock',
    'tampered',
    'external-link',
  ]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ck-up-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, 'new'),
      target = join(root, 'old');
    payload(source, 'replacement', 'a'.repeat(40));
    payload(target, 'previous', 'b'.repeat(40));
    const state = join(target, 'state'),
      home = join(state, 'home'),
      profile = join(state, 'profile');
    for (const path of [state, home, profile]) mkdirSync(path, { mode: 0o700 });
    const ownerPath = join(home, 'owner.sqlite');
    const owner = new DatabaseSync(ownerPath);
    chmodSync(ownerPath, 0o600);
    const store = new Store(join(home, 'state.sqlite'));
    store.applyMigrations(new URL('../apps/controller/migrations', import.meta.url).pathname);
    const local = {
      revision: 2,
      connectionRevision: 1,
      endpoint: 'ws://127.0.0.1:1234',
      authMode: 'none',
      noneConnected: true,
      observation: null,
      selection: null,
      setupHash: null,
      operation: null,
    };
    store.transaction(() => store.putLocalControl(local));
    store.close();
    chmodSync(join(home, 'state.sqlite'), 0o600);
    writeFileSync(join(profile, 'preferences'), 'retained profile', { mode: 0o600 });
    writeFileSync(join(home, 'token'), 'a'.repeat(64), { mode: 0o600 });
    const receipts = new CommandReceipts(home, profile);
    const command = {
      protocol: 1,
      key: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      actor: { id: 'desktop', kind: 'desktop' },
      command: 'RegisterProject',
      expectedRevision: 0,
      payload: { path: join(root, 'project') },
    };
    receipts.retain(command, true);
    const before = readFileSync(join(home, 'state.sqlite'));
    const receiptBefore = readFileSync(receipts.path);
    if (scenario === 'lease') owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    if (scenario === 'profile-lock')
      symlinkSync('stale-host-999999', join(profile, 'SingletonLock'));
    if (scenario === 'tampered') writeFileSync(join(source, 'runtime'), 'changed');
    if (scenario === 'old-re-signed')
      writeFileSync(join(target, 'Electron.app/runtime'), 'locally re-signed');
    if (scenario === 'old-payload-drift') writeFileSync(join(target, 'runtime'), 'changed');
    if (scenario === 'finder-metadata') {
      writeFileSync(join(source, '.DS_Store'), 'new folder view', { mode: 0o600 });
      writeFileSync(join(target, '.DS_Store'), 'old folder view', { mode: 0o600 });
    }
    if (scenario === 'finder-link') symlinkSync('runtime', join(source, '.DS_Store'));
    if (scenario === 'finder-large')
      writeFileSync(join(source, '.DS_Store'), Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
    if (scenario === 'source-state-link') {
      const outside = join(root, 'outside-empty');
      mkdirSync(outside);
      symlinkSync(outside, join(source, 'state'));
    }
    if (scenario === 'external-link') symlinkSync(root, join(state, 'external'));
    let renames = 0;
    const execute = (path) =>
      path === '/usr/sbin/lsof'
        ? {
            status: scenario === 'active' ? 0 : 1,
            stdout: scenario === 'active' ? 'p999999\n' : '',
            stderr: '',
          }
        : { status: 0, stdout: '', stderr: '' };
    let plan;
    try {
      const pending = upgradePackage(
        {
          source,
          target,
          confirm: (value) => {
            plan = value;
            return true;
          },
        },
        {
          execute,
          rename: (from, to) => {
            if (++renames === 2 && scenario === 'second-rename')
              throw Error('injected swap failure');
            renameSync(from, to);
          },
        },
      );
      if (['installed', 'old-re-signed', 'finder-metadata'].includes(scenario)) {
        const result = await pending;
        assert.equal(result.outcome, 'installed');
        assert.equal(result.target, target);
        assert.equal(readFileSync(join(target, 'runtime'), 'utf8'), 'replacement');
        assert.equal(readFileSync(join(result.backup, 'runtime'), 'utf8'), 'previous');
        assert.deepEqual(readFileSync(join(result.backup, 'state/home/state.sqlite')), before);
        assert.equal(result.stateDigest.length, 64);
        assert.equal(result.previousRuntimeChanged, scenario === 'old-re-signed');
        assert.equal(result.previousFinderMetadataEntries, scenario === 'finder-metadata' ? 1 : 0);
        if (scenario === 'finder-metadata') {
          assert.equal(readFileSync(join(result.backup, '.DS_Store'), 'utf8'), 'old folder view');
          assert.equal(readFileSync(join(target, '.DS_Store'), 'utf8'), 'new folder view');
        }
        assert.equal(plan.previousRuntimeChanged, scenario === 'old-re-signed');
        assert.equal(
          readFileSync(join(result.backup, 'Electron.app/runtime'), 'utf8'),
          scenario === 'old-re-signed' ? 'locally re-signed' : 'previous',
        );
        const copied = new Store(join(home, 'state.sqlite'));
        assert.deepEqual(copied.localControl(), local);
        copied.close();
        const retained = new CommandReceipts(home, profile);
        retained.load();
        assert.deepEqual(retained.commands, [command]);
        assert.equal(retained.path, receipts.path);
        assert.deepEqual(readFileSync(retained.path), receiptBefore);
      } else {
        const reasons = {
          lease: /ownership lease/,
          'old-payload-drift': /inventory differs/,
          'finder-link': /inventory differs/,
          'finder-large': /inventory differs/,
          'source-state-link': /replacement state path/,
          'second-rename': /injected swap failure/,
          active: /still in use/,
          'profile-lock': /profile lock/,
          tampered: /inventory differs/,
          'external-link': /symbolic link leaves/,
        };
        await assert.rejects(pending, reasons[scenario]);
        assert.equal(
          readFileSync(join(target, 'runtime'), 'utf8'),
          scenario === 'old-payload-drift' ? 'changed' : 'previous',
          scenario,
        );
        assert.deepEqual(readFileSync(join(home, 'state.sqlite')), before, scenario);
        assert.deepEqual(readFileSync(receipts.path), receiptBefore, scenario);
        if (scenario === 'second-rename') {
          assert.equal(renames, 3);
          assert(!existsSync(plan.backup));
        } else assert.equal(renames, 0);
      }
      assert(existsSync(source));
    } finally {
      owner.close();
    }
    assert(readdirSync(root).includes('old'));
  }
});
