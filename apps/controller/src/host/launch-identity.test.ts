import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GoogleAcpSetupSchema } from '@crewkite/contracts';
import { OperationStore } from '../commands/operation-store.ts';
import {
  acknowledgeGoogleTerms,
  fixtureClientHash,
  nativeSetup,
} from '../store/controller-fixture.ts';
import { type LaunchIdentity, Store } from '../store/index.ts';
import { spawnCheckChild } from './check-ownership.ts';
import { type PlatformReads, readLaunchIdentity } from './launch-identity.ts';

const KEY = 'launch-identity.key';
const BOOT = '3C2A6E1D-58B0-4F7E-9A51-0D3F2B7C9E14';
const PLATFORM_UUID = 'B9E7D4A2-1C6F-4E38-8D05-7A3F92C1E6B0';
const BOOT_ID = '6f1c2a9e-0b47-4d3a-9e58-21c7b4f0d6a3';
const MACHINE_ID = '4b8e2f6a1c9d07e35a2b8c4f6e1d9a07';
const IOREG = `+-o Mac  <class IOPlatformExpertDevice>\n  {\n    "IOPlatformSerialNumber" = "SERIAL0001"\n    "IOPlatformUUID" = "${PLATFORM_UUID}"\n  }\n`;
const identity: LaunchIdentity = {
  boot: { source: 'linux-boot-id-v1', digest: 'b'.repeat(64) },
  machine: { source: 'linux-machine-id-v1', digest: 'c'.repeat(64) },
};

const unavailable = (): string => {
  throw Error('unavailable');
};
const darwin = (boot: () => string, ioreg: () => string): PlatformReads => ({
  platform: 'darwin',
  run: (file, args) =>
    file === '/usr/sbin/sysctl' && args.join(' ') === '-n kern.bootsessionuuid'
      ? boot()
      : file === '/usr/sbin/ioreg' && args.join(' ') === '-rd1 -c IOPlatformExpertDevice'
        ? ioreg()
        : unavailable(),
  read: unavailable,
});
const linux = (bootId: () => string, machineId: () => string): PlatformReads => ({
  platform: 'linux',
  run: unavailable,
  read: (path) =>
    path === '/proc/sys/kernel/random/boot_id'
      ? bootId()
      : path === '/etc/machine-id'
        ? machineId()
        : unavailable(),
});

test('the reader digests each value with the home key, gives null when a read fails and never returns a raw value', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ck-launch-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows = [
    {
      name: 'darwin',
      reads: darwin(
        () => `${BOOT}\n`,
        () => IOREG,
      ),
      boot: 'darwin-boot-session-v1',
      machine: 'darwin-platform-uuid-v1',
    },
    {
      name: 'linux',
      reads: linux(
        () => `${BOOT_ID}\n`,
        () => `${MACHINE_ID}\n`,
      ),
      boot: 'linux-boot-id-v1',
      machine: 'linux-machine-id-v1',
    },
    {
      name: 'sysctl times out',
      reads: darwin(unavailable, () => IOREG),
      boot: null,
      machine: 'darwin-platform-uuid-v1',
    },
    {
      name: 'ioreg names no platform',
      reads: darwin(
        () => BOOT,
        () => '{}\n',
      ),
      boot: 'darwin-boot-session-v1',
      machine: null,
    },
    {
      name: 'a malformed machine-id',
      reads: linux(
        () => BOOT_ID,
        () => `${MACHINE_ID.slice(1)}\n`,
      ),
      boot: 'linux-boot-id-v1',
      machine: null,
    },
    { name: 'no proc files', reads: linux(unavailable, unavailable), boot: null, machine: null },
    {
      name: 'another platform',
      reads: { platform: 'win32', run: unavailable, read: unavailable } satisfies PlatformReads,
      boot: null,
      machine: null,
    },
  ] as const;
  for (const row of rows) {
    const [home, other, copy] = ['home', 'other', 'copy'].map((name) => {
      const path = join(root, `${row.name}-${name}`);
      mkdirSync(path, { mode: 0o700 });
      return path;
    });
    const seen = readLaunchIdentity(home, row.reads);
    assert.deepEqual(
      [seen.boot?.source ?? null, seen.machine?.source ?? null],
      [row.boot, row.machine],
      row.name,
    );
    for (const pair of [seen.boot, seen.machine])
      if (pair) assert.match(pair.digest, /^[0-9a-f]{64}$/, row.name);
    const text = JSON.stringify(seen).toLowerCase();
    for (const raw of [BOOT, PLATFORM_UUID, BOOT_ID, MACHINE_ID])
      assert.equal(text.includes(raw.toLowerCase()), false, row.name);
    // Another home has another key, so the same values digest differently. A copied home keeps
    // its key and its digests.
    const elsewhere = readLaunchIdentity(other, row.reads);
    if (seen.boot) assert.notEqual(elsewhere.boot?.digest, seen.boot.digest, row.name);
    if (seen.machine) assert.notEqual(elsewhere.machine?.digest, seen.machine.digest, row.name);
    copyFileSync(join(home, KEY), join(copy, KEY));
    assert.deepEqual(readLaunchIdentity(copy, row.reads), seen, row.name);
    assert.deepEqual(readLaunchIdentity(home, row.reads), seen, row.name);
    const key = statSync(join(home, KEY));
    assert.deepEqual([key.mode & 0o777, key.size], [0o600, 32], row.name);
  }
  assert.deepEqual(
    readLaunchIdentity(join(root, 'missing'), rows[0].reads),
    { boot: null, machine: null },
    'a home that cannot hold the key gives no identity',
  );
});

test('a Google metadata intent and a native phase intent commit their identity before the group is owned', async (t) => {
  let metadata: unknown;
  const context = await nativeSetup(t, 'success', {
    launchIdentity: () => identity,
    googleUsageClient: () => ({
      available: true,
      reason: 'available',
      client: { executable: process.execPath, version: '1.4.0', sha256: fixtureClientHash },
      environment: { HOME: userInfo().homedir },
    }),
    googleUsageSpawn: (_, __, options) => {
      const row = context.controller.store.heldGoogleMetadata()[0];
      metadata = [
        row?.state,
        context.controller.store.launchIdentity('google-metadata', row?.command_id ?? ''),
      ];
      return spawnCheckChild(process.execPath, ['-e', ''], options);
    },
  });
  const { controller } = context;
  await acknowledgeGoogleTerms(context);
  const setup = controller.store.googleAcpSetup();
  controller.store.transaction(() => controller.store.markConnectedOnce('google'));
  controller.store.transaction(() =>
    controller.store.putGoogleAcpSetup(
      GoogleAcpSetupSchema.parse({
        ...setup,
        revision: setup.revision + 1,
        state: 'ready',
        proofId: 'art_01K7M1N2P3Q4R5S6T7V8W9X0YZ',
        client: { version: '1.4.0', sha256: 'a'.repeat(64), signerTeamId: 'EQHXZ8M8AV' },
        auth: { method: 'oauth-personal', status: 'authenticated' },
      }),
    ),
  );
  await controller.execute(
    context.command('ObserveUsage', { family: 'google' }, 0) as never,
    'local-owner',
  );
  assert.deepEqual(metadata, ['intent', identity]);

  // Each spawn sees its phase still at intent. The launch and the phase already hold identity.
  const spawned: unknown[] = [];
  context.onSpawn(() => {
    const intent = controller.store.intents().at(-1);
    const phase = intent && controller.store.nativeProcesses(intent.attempt_id).at(-1);
    spawned.push([
      phase?.phase,
      phase?.state,
      intent && controller.store.launchIdentity('launch', intent.attempt_id),
      phase &&
        controller.store.launchIdentity('native-phase', `${phase.attempt_id}:${phase.sequence}`),
    ]);
  });
  const sealed = new Promise<void>((resolve) => {
    const off = controller.subscribe((event) => {
      if (event.type !== 'candidate.sealed') return;
      off();
      resolve();
    });
  });
  assert.equal(controller.startNativePilot(context.appointment).outcome, 'applied');
  await context.wait('candidate', sealed);
  assert.deepEqual(
    spawned,
    ['effective-features', 'metadata-preparation', 'app-server-task'].map((phase) => [
      phase,
      'intent',
      identity,
      identity,
    ]),
  );
});

test('a second launch under one operation replaces its identity observation', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ck-launch-identity-operation-'));
  const store = new Store(join(home, 'state.sqlite'));
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const id = (prefix: string, value: number) => `${prefix}_${String(value).padStart(26, '0')}`;
  const definition = {
    id: id('art', 1),
    hash: 'a'.repeat(64),
    bytes: 0,
    mediaType: 'application/json',
  };
  store.transaction(() => {
    store.put('task', id('tsk', 1), 0, {
      id: id('tsk', 1),
      projectId: id('prj', 1),
      title: 'Read a pull request',
      outcome: 'Retain the read',
      criteria: ['Owned phases close'],
      state: 'draft',
      waitingReason: null,
      revision: 0,
      runId: null,
      next: null,
    });
    store.put('artifact', definition.id, 0, definition);
  });
  let now = '2026-11-18T10:00:00.000Z';
  const journal = new OperationStore(store, () => now, undefined, identity);
  const operation = id('cmd', 1);
  const recorded = () =>
    store.db
      .prepare("SELECT owner_id,recorded_at FROM launch_identity WHERE owner_kind='operation'")
      .all()
      .map((row) => ({ ...row }));
  journal.createAndBegin(
    { id: operation, taskId: id('tsk', 1), kind: 'github-read', definition },
    id('cmd', 2),
    'd'.repeat(64),
    () => {},
    () => {},
  );
  journal.phase(operation, 'metadata', 'intent', null);
  assert.deepEqual(recorded(), [{ owner_id: operation, recorded_at: now }]);
  journal.phase(operation, 'metadata', 'owned', 4101);
  journal.phase(operation, 'metadata', 'closed', 4101);
  now = '2026-11-18T10:00:05.000Z';
  journal.phase(operation, 'content', 'intent', null);
  assert.deepEqual(recorded(), [{ owner_id: operation, recorded_at: now }]);
  assert.deepEqual(store.launchIdentity('operation', operation), identity);
});
