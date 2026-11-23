import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import { type ChatCatalogRead, CommandSchema, GOOGLE_TERMS_VERSION } from '@crewkite/contracts';
import { createTestClock, createTestIds } from '../../../../packages/testkit/src/fixtures.ts';
import { spawnCheckChild } from '../host/check-ownership.ts';
import { defaultSchedule } from '../host/worker.ts';
import type { GoogleAgent } from '../providers/google/acp/agents.ts';
import type { AcpSpawn } from '../providers/google/acp/client.ts';
import { importGoogleAcp } from '../providers/google/acp/import.ts';
import {
  type AcpReviewMapping,
  acpClientPin,
  googleAcpDeveloperIdRequirement,
  resolveGoogleAcpProfile,
} from '../providers/google/acp/profile.ts';
import { ACP_DISCOVERY_SETTLE_MS } from '../providers/google/acp/writer.ts';
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

/**
 * A home Ready on the 1.4.0 bundle, imported from a scripted peer as Connect imports the real
 * one, and a search path that a test fills with newer scripted agents. Check again scans it.
 */
async function agentHome(t: TestContext) {
  mkdirSync(resolve('internal'), { recursive: true });
  const directory = realpathSync(mkdtempSync(resolve('internal/google-agent-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundleScenario = join(directory, 'bundle-scenario');
  writeFileSync(bundleScenario, 'complete');
  const home = join(directory, 'home');
  const staged = join(home, 'imports/google-acp-v1');
  mkdirSync(staged, { recursive: true, mode: 0o700 });
  // Node runs no module from a .par file, so the bundle is a shell line that starts the peer.
  const peer = join(directory, 'bundle-peer.mjs');
  writeFileSync(peer, script(bundleScenario));
  const server = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(peer)}\n`;
  writeFileSync(join(staged, 'agy_acp_server.par'), server, { mode: 0o600 });
  writeFileSync(join(staged, 'localharness_external'), harness, { mode: 0o600 });
  const pin = { version: '1.4.0' as const, sha256: sha(server), signerTeamId: 'EQHXZ8M8AV' };
  writeFileSync(
    join(staged, 'identity.json'),
    JSON.stringify({ ...pin, harnessSha256: sha(harness) }),
    { mode: 0o600 },
  );
  const imported = await importGoogleAcp(
    { home, consent: 'explicit' },
    {
      verifySignature: async ({ client }) => ({
        verified: true,
        quiescent: true,
        signerTeamId: client.signerTeamId,
        requirement: googleAcpDeveloperIdRequirement(client.signerTeamId),
      }),
    },
  );
  assert.equal(imported.reason, 'imported');
  const mapping: AcpReviewMapping = {
    client: pin,
    surface: 'config',
    configId: 'mode-slot',
    valueId: 'fixture-review',
    semantics: 'request-review',
    evidenceHash: 'e'.repeat(64),
  };
  const environment = { HOME: userInfo().homedir, PATH: process.env.PATH };
  const clock = createTestClock();
  const id = createTestIds();
  const pool: GoogleAgent[] = [];
  // Digests of copies a scan saw but could not verify this time.
  const unverified: string[] = [];
  const launches: { executable: string; args: string[] }[] = [];
  const records = join(directory, 'state/clients');
  let agents = 0;
  const open = () =>
    new Controller({
      home: join(directory, 'controller'),
      now: clock.now,
      id,
      registerGoogleAcp: true,
      // Discovery waits a few seconds for options that arrive late. A build that lists no models
      // never sends them, so that wait ends at once here. Every other timer keeps its time.
      schedule: (work, milliseconds) =>
        defaultSchedule(work, milliseconds === ACP_DISCOVERY_SETTLE_MS ? 0 : milliseconds),
      googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
      managedClients: {
        root: records,
        fetch: (async () => {
          throw new Error('No network in tests.');
        }) as typeof fetch,
      },
      googleAcp: {
        reviewMappings: [mapping],
        spawn: ((...args: Parameters<AcpSpawn>) => {
          launches.push({ executable: args[0], args: [...args[1]] });
          return spawnCheckChild(...args);
        }) as AcpSpawn,
        scan: async () => ({ agents: [...pool], unverified: [...unverified] }),
        resolve: (proof, found) =>
          resolveGoogleAcpProfile(
            { home, proof, environment, agents: found },
            { reviewMappings: [mapping], platform: 'darwin', arch: 'arm64' },
          ),
      },
    });
  let controller = open();
  t.after(() => controller.close());
  const send = (command: string, payload: object) =>
    controller.execute(
      CommandSchema.parse({
        protocol: 1,
        key: id('cmd'),
        actor: { id: 'terminal', kind: 'cli' },
        command,
        // Reads and Check again carry no revision.
        ...(['CheckProviderClient', 'ReadChatCatalog'].includes(command)
          ? {}
          : {
              expectedRevision:
                command === 'AcknowledgeGoogleTerms'
                  ? 0
                  : controller.store.googleAcpSetup().revision,
            }),
        payload,
      }),
      'local-owner',
    );
  return {
    get controller() {
      return controller;
    },
    launches,
    send,
    /** Closes the controller and opens another on the same home, with what a scan finds then. */
    async restart(found: GoogleAgent[], missed: string[] = []) {
      await controller.close();
      pool.splice(0, pool.length, ...found);
      unverified.splice(0, unverified.length, ...missed);
      controller = open();
      await controller.googleAcpPreparation;
      await controller.googleAgentWork;
    },
    bundle: join(home, 'providers/google-acp-v1', pin.sha256, 'agy_acp_server.par'),
    record: () => JSON.parse(readFileSync(join(records, 'google.json'), 'utf8')),
    google: async () =>
      ((await send('ReadChatCatalog', {})).data as ChatCatalogRead).families.find(
        (entry) => entry.family === 'google',
      ),
    /** A newer scripted agent on the search path, playing one peer scenario. */
    agent(scenario: string): GoogleAgent {
      const folder = join(directory, `agent-${++agents}`);
      mkdirSync(folder, { mode: 0o700 });
      writeFileSync(join(folder, 'scenario'), scenario);
      const executable = join(folder, 'agy');
      writeFileSync(executable, script(join(folder, 'scenario')), { mode: 0o500 });
      return {
        kind: 'cli',
        executable,
        args: ['acp'],
        version: '1.5.5',
        sha256: sha(readFileSync(executable)),
        signerTeamId: 'EQHXZ8M8AV',
        helpers: [],
        place: 'search-path',
      };
    },
    /** Check again: the scan, then the step that qualifies a newer agent, run to the end. */
    async check(found: GoogleAgent[]) {
      pool.splice(0, pool.length, ...found);
      assert.equal((await send('CheckProviderClient', { family: 'google' })).outcome, 'applied');
      await controller.googleAgentWork;
    },
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

test("a newer agent whose replies fail the route's checks is not used, the copy in use keeps running and the card says why", async (t) => {
  const home = await agentHome(t);
  await home.ready();
  const before = home.controller.store.googleAcpSetup();
  const catalog = catalogOf(home.controller);
  const where = 'The copy on your search path';
  // How many Check agains in a row refuse the build: a wrong protocol or version at once, the
  // reads that can fail for a passing reason on the second, a sign-in never.
  const rows: [string, string, number][] = [
    ['earned-protocol-2', `${where} speaks a protocol version CrewKite does not.`, 1],
    [
      'earned-version-mismatch',
      `${where} reported another version than the one it was found under.`,
      1,
    ],
    ['earned-no-default', `${where} did not offer the mode that asks before edits.`, 2],
    ['earned-two-modes', `${where} did not offer the mode that asks before edits.`, 2],
    ['earned-mode-ack', `${where} did not offer the mode that asks before edits.`, 2],
    ['earned-no-models', `${where} did not list its models in a form CrewKite reads.`, 2],
    // A sign-in is the person's to give, so the build waits for it and is not refused.
    [
      'earned-sign-in',
      `${where} needs its own Google sign-in. Press Connect to sign in with it. Until then 1.4.0 runs.`,
      0,
    ],
  ];
  let waiting: GoogleAgent | undefined;
  for (const [scenario, reason, refusedAfter] of rows) {
    const agent = home.agent(scenario);
    waiting = agent;
    for (let check = 1; check <= Math.max(refusedAfter, 1); check++) {
      await home.check([agent]);
      const name = `${scenario} check ${check}`;
      const setup = home.controller.store.googleAcpSetup();
      assert.equal(setup.state, 'ready', name);
      assert.equal(setup.proofId, before.proofId, name);
      assert.equal(catalogOf(home.controller), catalog, name);
      assert.equal(home.controller.acpResolution().client?.executable, home.bundle, name);
      const record = home.record();
      assert.equal(
        record.refused?.some((entry: { sha256: string }) => entry.sha256 === agent.sha256) ?? false,
        check === refusedAfter,
        name,
      );
      const notUsed = (await home.google())?.client?.copy?.notUsed;
      assert.deepEqual(
        notUsed,
        { version: '1.5.5', reason, ...(refusedAfter ? {} : { signIn: true }) },
        name,
      );
    }
  }

  // Connect on the copy that waits for its sign-in sends the sign-in to that copy. A cancelled
  // sign-in keeps the copy in use Ready. A finished one moves the route to the waiting copy.
  assert(waiting);
  const connect = () =>
    home.send('AuthenticateGoogleAcp', {
      profileId: 'google-acp-v1',
      proofId: home.controller.store.googleAcpSetup().proofId,
      method: 'oauth-personal',
      consent: 'explicit',
    });
  for (const [scenario, version] of [
    ['earned-sign-in-cancelled', '1.4.0'],
    ['earned', '1.5.5'],
  ] as const) {
    writeFileSync(join(waiting.executable, '../scenario'), scenario);
    const launched = home.launches.length;
    await connect();
    const setup = home.controller.store.googleAcpSetup();
    assert.deepEqual([setup.state, setup.client?.version], ['ready', version], scenario);
    assert.deepEqual(
      home.launches.slice(launched).map((launch) => launch.executable),
      [waiting.executable],
      scenario,
    );
  }
});

test('the model list shown is the one the agent in use returned, with nothing added', async (t) => {
  const home = await agentHome(t);
  await home.ready();
  const agent = home.agent('earned');
  await home.check([agent]);
  const setup = home.controller.store.googleAcpSetup();
  assert.equal(setup.state, 'ready');
  assert.equal(setup.client?.version, '1.5.5');
  let google = await home.google();
  assert.deepEqual(
    google?.models.map((model) => model.model),
    ['m-one', 'm-two'],
  );
  assert.match(google?.client?.message ?? '', / 1\.5\.5 found\. Tested with 1\.4\.0;/);
  // The bundle starts with no arguments and the agent with exactly one, the acp subcommand.
  assert.deepEqual(
    home.launches.map((launch) => [
      launch.executable === home.bundle ? 'bundle' : launch.executable,
      launch.args,
    ]),
    [
      ...home.launches
        .filter((launch) => launch.executable === home.bundle)
        .map(() => ['bundle', []]),
      [agent.executable, ['acp']],
    ],
  );
  // Refresh models reads the list again from the agent in use, and the catalog follows it.
  writeFileSync(join(agent.executable, '../scenario'), 'earned-models-changed');
  const refreshed = await home.send('RefreshGoogleAcpModels', {
    profileId: 'google-acp-v1',
    proofId: home.controller.store.googleAcpSetup().proofId,
    consent: 'explicit',
  });
  assert.equal(refreshed.outcome, 'applied', refreshed.reason);
  google = await home.google();
  assert.deepEqual(
    google?.models.map((model) => model.model),
    ['m-three'],
  );
  assert.equal(home.launches.at(-1)?.executable, agent.executable);

  // A failed refresh of the copy in use, twice, keeps it in use and refuses nothing, as for the
  // bundle.
  writeFileSync(join(agent.executable, '../scenario'), 'earned-no-models');
  for (const press of [1, 2]) {
    const failed = await home.send('RefreshGoogleAcpModels', {
      profileId: 'google-acp-v1',
      proofId: home.controller.store.googleAcpSetup().proofId,
      consent: 'explicit',
    });
    assert.equal(failed.outcome, 'blocked', `refresh ${press}`);
  }
  assert.equal(home.controller.store.googleAcpSetup().client?.version, '1.5.5');
  assert.equal(home.controller.acpResolution().client?.executable, agent.executable);
  assert.equal(home.controller.googleRefused.has(agent.sha256), false);

  // A restart keeps the copy in use, also when the first scan could not verify it: the proof and
  // the client stay put and no step runs on the bundle.
  const proofId = home.controller.store.googleAcpSetup().proofId;
  const launched = home.launches.length;
  for (const [found, missed] of [
    [[], [agent.sha256]],
    [[agent], []],
  ] as const) {
    await home.restart([...found], [...missed]);
    const kept = home.controller.store.googleAcpSetup();
    assert.deepEqual([kept.state, kept.proofId, kept.client?.version], ['ready', proofId, '1.5.5']);
    assert.deepEqual(home.launches.slice(launched), [], `restart with ${missed.length} missed`);
  }

  // When a turn gate refuses the copy in use, the next copy is set up on the saved sign-in.
  home.controller.googleGate(agent.executable, 'edit');
  await home.controller.googleAgentWork;
  const fallback = home.controller.store.googleAcpSetup();
  assert.deepEqual([fallback.state, fallback.client?.version], ['ready', '1.4.0']);
  assert.equal(home.launches.at(-1)?.executable, home.bundle);
  assert.deepEqual((await home.google())?.client?.copy?.notUsed, {
    version: '1.5.5',
    reason: 'The copy on your search path edited a file without asking.',
  });
});
