import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import { CommandSchema, GOOGLE_TERMS_VERSION } from '@crewkite/contracts';
import { createTestClock, createTestIds } from '../../../../packages/testkit/src/fixtures.ts';
import { spawnCheckChild } from '../host/check-ownership.ts';
import type { AcpSpawn } from '../providers/google/acp/client.ts';
import {
  type AcpReviewMapping,
  acpClientPin,
  resolveGoogleAcpProfile,
} from '../providers/google/acp/profile.ts';
import { Controller } from './controller.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const harness = '#!/bin/sh\nexit 99\n';
const peerUrl = new URL('../../../../packages/testkit/src/providers/acp-peer.ts', import.meta.url);
// The client reads its scenario from a file, so one test can change what the client reports
// between launches. `sign-in-lost` answers session/new the way a client with no session does.
const script = (scenarioFile: string) => `#!${process.execPath}
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const scenario = readFileSync(${JSON.stringify(scenarioFile)}, 'utf8').trim();
if (scenario !== 'sign-in-lost') {
  const { runAcpPeer } = await import(${JSON.stringify(peerUrl.href)});
  runAcpPeer(scenario);
} else {
  const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize')
      send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'fixture', version: '1.4.0' }, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [{ id: 'oauth-personal', name: 'Personal' }] } });
    else if (message.method === 'session/new')
      send({ id: message.id, error: { code: -32000, message: 'Sign in again' } });
  });
}
`;

function readyHome(t: TestContext) {
  mkdirSync(resolve('internal'), { recursive: true });
  const directory = mkdtempSync(resolve('internal/google-refresh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scenarioFile = join(directory, 'scenario');
  const setScenario = (name: string) => writeFileSync(scenarioFile, name);
  setScenario('complete');
  const executable = join(directory, 'peer');
  writeFileSync(executable, script(scenarioFile), { mode: 0o500 });
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
  const state = { launches: 0 };
  const controller = new Controller({
    home: join(directory, 'controller'),
    now: clock.now,
    id,
    googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
    googleAcp: {
      reviewMappings: [mapping],
      spawn: ((...args: Parameters<AcpSpawn>) => {
        state.launches++;
        return spawnCheckChild(...args);
      }) as AcpSpawn,
      resolve: (proof) => ({
        ...resolveGoogleAcpProfile({ home: directory, proof, environment }),
        client,
        environment,
      }),
    },
  });
  t.after(() => controller.close());
  const send = (command: string, payload: object) =>
    controller.execute(
      CommandSchema.parse({
        protocol: 1,
        key: id('cmd'),
        actor: { id: 'terminal', kind: 'cli' },
        command,
        expectedRevision:
          command === 'AcknowledgeGoogleTerms' ? 0 : controller.store.googleAcpSetup().revision,
        payload,
      }),
      'local-owner',
    );
  const refresh = () =>
    send('RefreshGoogleAcpModels', {
      profileId: 'google-acp-v1',
      proofId: controller.store.googleAcpSetup().proofId,
      consent: 'explicit',
    });
  return {
    controller,
    clock,
    id,
    state,
    setScenario,
    refresh,
    /** The person's Connect: terms, initialize, sign-in and discovery, ending Ready. */
    async ready() {
      const steps: [string, object][] = [
        ['AcknowledgeGoogleTerms', { textVersion: GOOGLE_TERMS_VERSION }],
        ['InitializeGoogleAcp', { profileId: 'google-acp-v1', consent: 'explicit' }],
        ['AuthenticateGoogleAcp', { method: 'oauth-personal' }],
        ['DiscoverGoogleAcp', {}],
      ];
      for (const [command, payload] of steps) {
        const needsProof = ['AuthenticateGoogleAcp', 'DiscoverGoogleAcp'].includes(command);
        const result = await send(command, {
          ...payload,
          ...(needsProof
            ? {
                profileId: 'google-acp-v1',
                proofId: controller.store.googleAcpSetup().proofId,
                consent: 'explicit',
              }
            : {}),
        });
        assert.equal(result.outcome, 'applied', `${command}: ${result.reason}`);
      }
      assert.equal(controller.store.googleAcpSetup().state, 'ready');
    },
  };
}

const catalogOf = (controller: Controller) =>
  JSON.stringify(controller.acpProof(controller.store.googleAcpSetup().proofId)?.configOptions);

test('a refresh from Ready replaces the catalog and records refreshed', async (t) => {
  const home = readyHome(t);
  await home.ready();
  const before = home.controller.store.googleAcpSetup();
  const catalog = catalogOf(home.controller);
  home.setScenario('missing-thought');
  const result = await home.refresh();
  assert.equal(result.outcome, 'applied', result.reason);
  const setup = home.controller.store.googleAcpSetup();
  assert.equal(setup.state, 'ready');
  assert.notEqual(setup.proofId, before.proofId);
  assert.notEqual(catalogOf(home.controller), catalog);
  assert.deepEqual(
    { ...setup.modelRefresh, commandId: undefined, at: undefined },
    { outcome: 'refreshed', reason: null, evidenceId: null, commandId: undefined, at: undefined },
  );
  const row = home.controller.store.googleMetadataOperations().at(-1);
  assert.equal(row?.kind, 'acp-discover');
  assert.equal(row?.state, 'quiescent');
});

test('a failed refresh keeps Ready, the proof and the catalog, and keeps an evidence artifact', async (t) => {
  const home = readyHome(t);
  await home.ready();
  const before = home.controller.store.googleAcpSetup();
  const catalog = catalogOf(home.controller);

  // The client names no personal sign-in. Setup stays Ready on the earlier proof.
  home.setScenario('no-sign-in');
  const failed = await home.refresh();
  assert.equal(failed.outcome, 'blocked');
  let setup = home.controller.store.googleAcpSetup();
  assert.equal(setup.state, 'ready');
  assert.equal(setup.proofId, before.proofId);
  assert.equal(catalogOf(home.controller), catalog);
  assert.equal(setup.modelRefresh?.outcome, 'failed');
  assert.equal(setup.modelRefresh?.reason, 'acp-capability-missing');
  const evidence = home.controller.store.get<{ hash: string }>(
    'artifact',
    setup.modelRefresh?.evidenceId ?? '',
  );
  assert.ok(evidence, 'the diagnostic is stored as an artifact');

  // A client that no longer honors the sign-in is the one failure that leaves Ready.
  home.setScenario('sign-in-lost');
  await home.refresh();
  setup = home.controller.store.googleAcpSetup();
  assert.equal(setup.state, 'authentication-required');
  assert.equal(setup.auth.status, 'required');
  assert.equal(setup.modelRefresh?.outcome, 'failed');
  assert.equal(setup.modelRefresh?.reason, 'authentication-required');
  assert.ok(home.controller.store.get('artifact', setup.modelRefresh?.evidenceId ?? ''));
});

test('a refresh is refused while another Google metadata operation holds the gate', async (t) => {
  const home = readyHome(t);
  await home.ready();
  const before = home.controller.store.googleAcpSetup();
  const launches = home.state.launches;
  home.controller.store.transaction(() =>
    home.controller.store.beginGoogleMetadata(home.id('cmd'), 'usage', 0, home.clock.now()),
  );
  const blocker = home.controller.store.transaction(() =>
    home.controller.store.googleOperationBlocker(),
  );
  assert.ok(blocker);
  const result = await home.refresh();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, blocker);
  assert.deepEqual(home.controller.store.googleAcpSetup(), before);
  assert.equal(home.state.launches, launches);
});

test('Google reconnects through a model refresh after Sign out, and only when it is applied', async (t) => {
  const home = readyHome(t);
  await home.ready();
  const { controller } = home;
  const signOut = await controller.execute(
    CommandSchema.parse({
      protocol: 1,
      key: home.id('cmd'),
      actor: { id: 'terminal', kind: 'cli' },
      command: 'SignOutProvider',
      expectedRevision: 0,
      payload: { family: 'google' },
    }),
    'local-owner',
  );
  assert.equal(signOut.outcome, 'applied');
  assert.equal(controller.store.hasConnectedOnce('google'), false);
  // Sign out ends the connection and keeps the verified setup.
  assert.equal(controller.store.googleAcpSetup().state, 'ready');

  home.setScenario('no-sign-in');
  assert.equal((await home.refresh()).outcome, 'blocked');
  assert.equal(
    controller.store.hasConnectedOnce('google'),
    false,
    'a refused read connects nothing',
  );

  home.setScenario('complete');
  assert.equal((await home.refresh()).outcome, 'applied');
  assert.equal(controller.store.hasConnectedOnce('google'), true);
  assert.equal(controller.store.signedOut('google'), false);
});
