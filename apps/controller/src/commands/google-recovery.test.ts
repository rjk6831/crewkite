import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type CommandResult,
  CommandSchema,
  GOOGLE_TERMS_VERSION,
  type GoogleMetadataRecovery,
} from '@crewkite/contracts';
import { createTestClock, createTestIds } from '../../../../packages/testkit/src/fixtures.ts';
import { spawnCheckChild } from '../host/check-ownership.ts';
import { groupAbsent } from '../host/worker.ts';
import type { AcpSpawn } from '../providers/google/acp/client.ts';
import {
  type AcpReviewMapping,
  acpClientPin,
  resolveGoogleAcpProfile,
} from '../providers/google/acp/profile.ts';
import { fixtureClientHash } from '../store/controller-fixture.ts';
import { Controller, type ControllerOptions } from './controller.ts';
import { googleMetadataHolds, recoverGoogleMetadata } from './google-recovery.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const harness = '#!/bin/sh\nexit 99\n';
const usageReport = {
  status: 'SUCCESS',
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          buckets: [
            { id: 'gemini-weekly', remaining_fraction: 0.8, reset_time: '2026-10-23T14:13:03Z' },
            { id: 'gemini-5h', remaining_fraction: 0.3, reset_time: '2026-10-16T19:13:03Z' },
          ],
        },
      ],
    },
  },
};

/**
 * A private home with the scripted ACP client and the usage reader. `afterSpawn` runs as a
 * microtask once a client starts, after the controller recorded its group.
 */
function googleHome(t: TestContext) {
  mkdirSync(resolve('internal'), { recursive: true });
  const directory = mkdtempSync(resolve('internal/google-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const peer = new URL('../../../../packages/testkit/src/providers/acp-peer.ts', import.meta.url);
  const executable = join(directory, 'peer');
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport {runAcpPeer} from ${JSON.stringify(peer.href)};runAcpPeer('complete');\n`,
    { mode: 0o500 },
  );
  writeFileSync(join(directory, 'localharness_external'), harness, { mode: 0o500 });
  const client = {
    executable,
    harnessSha256: sha(harness),
    version: '1.4.0' as const,
    sha256: sha(readFileSync(executable)),
    signerTeamId: 'TESTTEAM01',
  };
  const mapping: AcpReviewMapping = {
    client: acpClientPin(client),
    surface: 'config',
    configId: 'mode-slot',
    valueId: 'fixture-review',
    semantics: 'request-review',
    evidenceHash: 'e'.repeat(64),
  };
  const environment = { HOME: userInfo().homedir, PATH: process.env.PATH };
  const clock = createTestClock();
  const id = createTestIds();
  const home = {
    clock,
    id,
    launches: 0,
    afterSpawn: undefined as (() => void) | undefined,
    spawned() {
      home.launches++;
      const after = home.afterSpawn;
      home.afterSpawn = undefined;
      if (after) queueMicrotask(after);
    },
    open: (options: Partial<ControllerOptions> = {}) =>
      new Controller({
        home: join(directory, 'controller'),
        now: clock.now,
        id,
        googleUsageClient: () => ({
          available: true,
          reason: 'available',
          client: { executable: process.execPath, version: '1.4.0', sha256: fixtureClientHash },
          environment: { HOME: userInfo().homedir },
        }),
        googleUsageSpawn: (_, __, spawnOptions) => {
          const child = spawnCheckChild(
            process.execPath,
            ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(usageReport))})`],
            spawnOptions,
          );
          home.spawned();
          return child;
        },
        googleAcp: {
          reviewMappings: [mapping],
          spawn: ((...args: Parameters<AcpSpawn>) => {
            const child = spawnCheckChild(...args);
            home.spawned();
            return child;
          }) as AcpSpawn,
          resolve: (proof) => ({
            ...resolveGoogleAcpProfile({ home: directory, proof, environment }),
            client,
            environment,
          }),
        },
        ...options,
      }),
    send: (controller: Controller, command: string, payload: object): Promise<CommandResult> =>
      controller.execute(
        CommandSchema.parse({
          protocol: 1,
          key: id('cmd'),
          actor: { id: 'terminal', kind: 'cli' },
          command,
          expectedRevision: ['AcknowledgeGoogleTerms', 'ObserveUsage'].includes(command)
            ? 0
            : controller.store.googleAcpSetup().revision,
          payload,
        }),
        'local-owner',
      ),
    /** The person's Connect: terms, initialize, sign-in and discovery, ending Ready. */
    async ready(controller: Controller) {
      const steps: [string, object][] = [
        ['AcknowledgeGoogleTerms', { textVersion: GOOGLE_TERMS_VERSION }],
        ['InitializeGoogleAcp', { profileId: 'google-acp-v1', consent: 'explicit' }],
        ['AuthenticateGoogleAcp', { method: 'oauth-personal', consent: 'explicit' }],
        ['DiscoverGoogleAcp', { consent: 'explicit' }],
      ];
      for (const [command, payload] of steps) {
        const proofId = controller.store.googleAcpSetup().proofId;
        const result = await home.send(controller, command, {
          ...payload,
          ...(['AuthenticateGoogleAcp', 'DiscoverGoogleAcp'].includes(command)
            ? { profileId: 'google-acp-v1', proofId }
            : {}),
        });
        assert.equal(result.outcome, 'applied', `${command}: ${result.reason}`);
      }
      assert.equal(controller.store.googleAcpSetup().state, 'ready');
    },
    /** The number of a process group that existed and is gone. */
    async goneGroup() {
      const exited = spawnProcess(process.execPath, ['-e', ''], {
        detached: true,
        stdio: 'ignore',
      });
      await new Promise((done) => exited.once('close', done));
      const group = exited.pid as number;
      assert(groupAbsent(group));
      return group;
    },
  };
  return home;
}

test('recovery settles a Google metadata row only when a zero probe finds its group gone', (t) => {
  const { clock, id, open } = googleHome(t);
  const controller = open();
  t.after(() => controller.close());
  const rows = [
    { kind: 'usage', group: 4101, probe: 'ESRCH', hold: 'recoverable' },
    { kind: 'usage', group: 4102, probe: 'EPERM', hold: 'owner-unconfirmed' },
    { kind: 'acp-discover', group: 4103, probe: 'present', hold: 'owner-present' },
    { kind: 'usage', group: null, probe: 'ESRCH', hold: 'no-process-identity' },
    { kind: 'usage', group: 4104, probe: 'ESRCH', hold: 'runtime-active', running: true },
    { kind: 'acp-authenticate', group: 4105, probe: 'ESRCH', hold: 'authentication-needs-person' },
    { kind: 'acp-authenticate', group: 4106, probe: 'present', hold: 'owner-present' },
  ] as const;
  for (const row of rows) {
    const key = id('cmd');
    controller.store.transaction(() => {
      controller.store.beginGoogleMetadata(key, row.kind, 0, clock.now());
      if (row.group) controller.store.ownGoogleMetadata(key, row.group);
      controller.store.unknownGoogleMetadata(key);
    });
    if ('running' in row)
      controller.usageRead = {
        key,
        hash: 'a'.repeat(64),
        principal: 'local-owner',
        abort: new AbortController(),
        promise: new Promise(() => {}),
        resolve: () => {},
      };
    const kill = process.kill;
    const signals: Parameters<typeof process.kill>[] = [];
    process.kill = ((...args: Parameters<typeof process.kill>) => {
      signals.push(args);
      if (row.probe === 'present') return true;
      throw Object.assign(new Error(row.probe), { code: row.probe });
    }) as typeof process.kill;
    let shown: GoogleMetadataRecovery['held'];
    let recovery: GoogleMetadataRecovery;
    try {
      shown = googleMetadataHolds(controller);
      recovery = controller.store.transaction(() => recoverGoogleMetadata(controller, 'automatic'));
    } finally {
      process.kill = kill;
      controller.usageRead = undefined;
    }
    const operation = row.kind;
    assert.deepEqual(shown, [{ commandId: key, operation, reason: row.hold }], row.hold);
    const stored = controller.store.googleMetadataOperations().find((r) => r.command_id === key);
    if (row.hold === 'recoverable') {
      assert.deepEqual(recovery.settled, [{ commandId: key, operation }]);
      assert.equal(stored?.settlement, 'owner-absent');
      assert.ok(controller.store.receipt(`google-metadata-settled:${key}`));
    } else {
      assert.deepEqual(recovery.held, [{ commandId: key, operation, reason: row.hold }], row.hold);
      assert.equal(stored?.state, 'unknown', row.hold);
      controller.store.db
        .prepare('DELETE FROM google_metadata_operations WHERE command_id=?')
        .run(key);
    }
    // The snapshot and the recovery each probe once with signal 0. Rows held before the probe get
    // none at all.
    const probe = [-(row.group ?? 0), 0];
    const probed = row.group && !('running' in row);
    assert.deepEqual(signals, probed ? [probe, probe] : [], row.hold);
  }
});

test('a late completion after recovery settled its row publishes nothing and leaves newer setup alone', async (t) => {
  const home = googleHome(t);
  const controller = home.open();
  t.after(() => controller.close());
  await home.ready(controller);
  const artifacts = controller.store.list('artifact').length;
  // Recovery from elsewhere settles the row while the client still runs. For a setup step it also
  // moves the setup on, the way recovery releases a step.
  const settleNow = () => {
    const row = controller.store.googleMetadataOperations().at(-1);
    assert(row?.state === 'owned');
    controller.store.transaction(() => {
      controller.store.finishGoogleMetadata(
        row.command_id,
        row.process_group,
        home.clock.now(),
        'owner-absent',
      );
      const setup = controller.store.googleAcpSetup();
      if (setup.operationId === row.command_id)
        controller.store.putGoogleAcpSetup({
          ...setup,
          revision: setup.revision + 1,
          state: 'blocked',
          operationId: null,
        });
    });
  };
  for (const operation of ['usage', 'acp-discover'] as const) {
    const before = controller.store.googleAcpSetup();
    const observedAt = controller.store.googleUsageReader().last_observed_at;
    home.afterSpawn = settleNow;
    const result =
      operation === 'usage'
        ? await home.send(controller, 'ObserveUsage', { family: 'google' })
        : await home.send(controller, 'DiscoverGoogleAcp', {
            profileId: 'google-acp-v1',
            proofId: before.proofId,
            consent: 'explicit',
          });
    assert.equal(result.outcome, 'outcome-unknown', operation);
    const row = controller.store.googleMetadataOperations().at(-1);
    assert(row?.kind === operation);
    assert.equal(row.settlement, 'owner-absent');
    assert.equal(controller.store.receipt(row.command_id)?.result.outcome, 'outcome-unknown');
    assert.equal(controller.store.googleUsageReader().last_observed_at, observedAt, operation);
    assert.equal(controller.googleUsageReport, undefined, operation);
    assert.equal(controller.store.list('artifact').length, artifacts, operation);
    const setup = controller.store.googleAcpSetup();
    if (operation === 'usage') assert.deepEqual(setup, before);
    else {
      assert.equal(setup.revision, before.revision + 2, 'begin, then recovery, and no more');
      assert.equal(setup.state, 'blocked');
      assert.equal(setup.proofId, before.proofId);
    }
  }
});

// The incident: Ready setup with no operation of its own, and an acp-discover row left unknown.
// The second row is the same home with a model refresh that was running.
for (const refreshing of [false, true])
  test(`startup releases a Ready home's interrupted discover whose group is gone${refreshing ? ', with a running refresh' : ''}`, async (t) => {
    const home = googleHome(t);
    let controller = home.open();
    t.after(() => controller.close());
    await home.ready(controller);
    const ready = controller.store.googleAcpSetup();
    const group = await home.goneGroup();
    const key = home.id('cmd');
    controller.store.transaction(() => {
      if (refreshing)
        controller.store.putGoogleAcpSetup({
          ...ready,
          revision: ready.revision + 1,
          modelRefresh: {
            commandId: key,
            at: home.clock.now(),
            outcome: 'running',
            reason: null,
            evidenceId: null,
          },
        });
      controller.store.beginGoogleMetadata(
        key,
        'acp-discover',
        ready.revision + (refreshing ? 1 : 0),
        home.clock.now(),
      );
      controller.store.ownGoogleMetadata(key, group);
      controller.store.unknownGoogleMetadata(key);
    });
    // Before recovery the incident shows: Ready, yet the gate is held, and the snapshot says why.
    assert.equal(controller.store.googleAcpSetup().state, 'ready');
    assert.equal(
      controller.store.transaction(() => controller.store.googleOperationBlocker()),
      'google-ownership-unknown',
    );
    assert.deepEqual(googleMetadataHolds(controller), [
      { commandId: key, operation: 'acp-discover', reason: 'recoverable' },
    ]);
    await controller.close();
    const launches = home.launches;
    controller = home.open();
    const row = controller.store.googleMetadataOperations().find((r) => r.command_id === key);
    assert.equal(row?.settlement, 'owner-absent');
    assert.ok(controller.store.receipt(`google-metadata-settled:${key}`));
    const setup = controller.store.googleAcpSetup();
    assert.equal(setup.state, 'ready');
    assert.equal(setup.proofId, ready.proofId);
    assert.deepEqual(setup.auth, ready.auth);
    assert.equal(setup.modelRefresh?.outcome ?? null, refreshing ? 'unknown' : null);
    assert.equal(home.launches, launches, 'recovery replays nothing');
    const discover = await home.send(controller, 'DiscoverGoogleAcp', {
      profileId: 'google-acp-v1',
      proofId: setup.proofId,
      consent: 'explicit',
    });
    assert.equal(discover.outcome, 'applied', discover.reason);
    assert.equal(controller.store.googleAcpSetup().state, 'ready');
  });

test('only a person releases an interrupted Google sign-in, and the sign-in then reads as unknown', async (t) => {
  const home = googleHome(t);
  let controller = home.open();
  t.after(() => controller.close());
  await home.ready(controller);
  const ready = controller.store.googleAcpSetup();
  const group = await home.goneGroup();
  const key = home.id('cmd');
  controller.store.transaction(() => {
    controller.store.putGoogleAcpSetup({
      ...ready,
      revision: ready.revision + 1,
      state: 'authenticating',
      operationId: key,
    });
    controller.store.beginGoogleMetadata(
      key,
      'acp-authenticate',
      ready.revision + 1,
      home.clock.now(),
    );
    controller.store.ownGoogleMetadata(key, group);
  });
  await controller.close();
  controller = home.open({ registerGoogleAcp: true });
  await controller.googleAcpPreparation;
  assert.equal(controller.store.googleMetadataOperations().at(-1)?.state, 'unknown');
  assert.equal(controller.store.receipt(`google-metadata-settled:${key}`), undefined);
  assert.equal(controller.store.googleAcpSetup().state, 'unknown');
  assert.deepEqual(googleMetadataHolds(controller), [
    { commandId: key, operation: 'acp-authenticate', reason: 'authentication-needs-person' },
  ]);

  const recovered = await home.send(controller, 'RecoverGoogleMetadata', { consent: 'explicit' });
  assert.equal(recovered.outcome, 'applied', recovered.reason);
  assert.deepEqual((recovered.data as GoogleMetadataRecovery).settled, [
    { commandId: key, operation: 'acp-authenticate' },
  ]);
  assert.match(recovered.next ?? '', /browser may still complete/);
  assert.equal(controller.store.googleMetadataOperations().at(-1)?.settlement, 'owner-absent');
  const setup = controller.store.googleAcpSetup();
  assert.equal(setup.state, 'authentication-required');
  assert.equal(setup.auth.status, 'unknown');
  assert.equal(setup.operationId, null);
  assert.equal(setup.proofId, ready.proofId);
  // The older proof still records a finished sign-in. Nothing discovers on it until the person
  // signs in again.
  assert.equal(controller.googleAcpPreparationStep(), null);
});
