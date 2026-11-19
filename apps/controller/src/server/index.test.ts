import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectController, readControllerEndpoint } from '@crewkite/client/node';
import {
  type CommandResult,
  CommandSchema,
  GoogleAcpProfileSchema,
  RunSchema,
  type Task,
  TaskSchema,
} from '@crewkite/contracts';
import { createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { chatScratchDirectory } from '../chat/scratch-folder.ts';
import type { ControllerOptions } from '../commands/controller.ts';
import { checkOwner, spawnCheckChild } from '../host/check-ownership.ts';
import { git } from '../host/source.ts';
import { digestHeldFile, fileDigestSync } from '../providers/file-digest.ts';
import { type AcpSetupProof, acpClientPin } from '../providers/google/acp/profile.ts';
import {
  unavailableNativeProfile,
  unavailableRepositoryProfile,
} from '../providers/openai/profile.ts';
import {
  acknowledgeGoogleTerms,
  fixtureClientHash,
  installedTools,
  setup,
} from '../store/controller-fixture.ts';
import { serve } from './index.ts';

test('workspace reads hash each client once per file identity and never leave a Local command outcome unknown during a Google install', async (t) => {
  const root = mkdtempSync(join(realpathSync(checkOwner()?.stateRoot ?? tmpdir()), 'ck-line-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The second variant makes each fresh hash cost what a cold 250 MB client costs on the Mac. The
  // delay is real because the loop stall is the thing under test.
  for (const [variant, holdMs] of [
    ['warm', 0],
    ['cold', 300],
  ] as const) {
    const folder = join(root, variant);
    const clients = [join(root, `${variant}-openai`), join(root, `${variant}-anthropic`)];
    for (const client of clients) writeFileSync(client, randomBytes(1024 * 1024));
    const reads = new Map<string, number>();
    const read = (path: string, identity: string) => {
      reads.set(`${path} ${identity}`, (reads.get(`${path} ${identity}`) ?? 0) + 1);
      if (holdMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
      return digestHeldFile(path, identity);
    };
    const fetching = Promise.withResolvers<void>();
    const options: Partial<ControllerOptions> = {
      home: join(folder, 'home'),
      googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
      nativeProfiles: () => {
        for (const client of clients) fileDigestSync(client, { read });
        return [unavailableNativeProfile(), unavailableRepositoryProfile()];
      },
      // The install holds at its download, so it is running for every command below.
      googleAcpInstall: {
        fetch: (async (_url: unknown, init?: RequestInit) => {
          fetching.resolve();
          await new Promise<void>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(Error('cancelled')), {
              once: true,
            }),
          );
          throw Error('No download result was expected.');
        }) as typeof fetch,
      },
    };
    const context = await setup(t, options);
    await acknowledgeGoogleTerms(context);
    const { controller } = context;
    const server = await serve(controller);
    t.after(() => server.close());
    const client = await connectController({
      ...readControllerEndpoint(controller.home),
      actor: { id: 'terminal', kind: 'cli' },
    });
    t.after(() => client.close());
    const send = (name: string, payload: unknown, revision?: number) =>
      client.command(CommandSchema.parse(context.command(name, payload, revision)));
    const install = send(
      'InstallGoogleAcp',
      { profileId: 'google-acp-v1', consent: 'explicit' },
      0,
    );
    void install.catch(() => {});
    await fetching.promise;
    const answers: [string, CommandResult][] = [];
    const revision = () => controller.snapshot().localSetup?.revision ?? 0;
    for (const [name, payload] of [
      ['ConfigureLocal', { endpoint: 'ws://127.0.0.1:9', authMode: 'none' }],
      ['BeginLocalConnectionInput', { consent: 'explicit' }],
      ['RefreshLocalModels', { consent: 'explicit' }],
    ] as const) {
      const before = [0, 1].map(() => send('GetWorkspaceState', {}));
      const local = send(name, payload, revision());
      const after = [0].map(() => send('GetWorkspaceState', {}));
      for (const [index, result] of (await Promise.all([...before, local, ...after])).entries())
        answers.push([index === before.length ? name : 'GetWorkspaceState', result]);
    }
    answers.push(['GetWorkspaceState', await send('GetWorkspaceState', {})]);
    assert.equal(answers.filter(([name]) => name === 'GetWorkspaceState').length, 10);
    assert.deepEqual(
      answers.filter(([, result]) => result.outcome === 'outcome-unknown'),
      [],
      variant,
    );
    assert.equal(answers.find(([name]) => name === 'ConfigureLocal')?.[1].outcome, 'applied');
    assert.deepEqual([...reads.values()], [1, 1], variant);
  }
});

// Claim: a dependency copy and a design draft can each take minutes, so the controller answers them
// on their own. A read the window sends after either one is answered while it still runs.
test('a dependency copy or a design draft holds no command sent after it', async (t) => {
  const root = mkdtempSync(join(realpathSync(checkOwner()?.stateRoot ?? tmpdir()), 'ck-line-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  // The draft's model answers only once the controller closes.
  const adapter = createScriptedChatAdapter({ family: 'openai', turns: [[{ kind: 'wait' }]] });
  const context = await setup(t, {
    home,
    googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
    nativeProfiles: () => [unavailableNativeProfile(), unavailableRepositoryProfile()],
    chatAdapters: new Map([['openai', adapter]]),
  });
  const { controller, source } = context;
  const task = (await controller.execute(context.draft, 'local-owner')).entity as Task;
  const server = await serve(controller);
  t.after(() => server.close());
  const client = await connectController({
    ...readControllerEndpoint(controller.home),
    actor: { id: 'terminal', kind: 'cli' },
  });
  t.after(() => client.close());
  const answered: string[] = [];
  const send = (name: string, payload: unknown, revision?: number) => {
    const result = client.command(CommandSchema.parse(context.command(name, payload, revision)));
    void result.then(
      () => answered.push(name),
      () => {},
    );
    return result;
  };

  // An npm project with one installed package, and a thread copy with its manifest and lockfile.
  const files = {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { tiny: '^1.0.0' } }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/tiny': { version: '1.2.3' } },
    }),
  };
  const installed = join(source.directory, 'node_modules', 'tiny');
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    join(installed, 'package.json'),
    JSON.stringify({ name: 'tiny', version: '1.2.3' }),
  );
  writeFileSync(join(installed, 'index.js'), 'module.exports = 1;\n');
  const copy = chatScratchDirectory(home, task.id);
  mkdirSync(copy, { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    writeFileSync(join(source.directory, path), body);
    writeFileSync(join(copy, path), body);
  }
  const preparing = send(
    'PrepareDependencies',
    { taskId: task.id, scope: 'thread', scopeKey: task.id, consent: 'explicit' },
    0,
  );
  assert.equal((await send('GetWorkspaceState', {})).outcome, 'applied');
  assert.equal((await preparing).outcome, 'applied');
  assert.deepEqual(answered, ['GetWorkspaceState', 'PrepareDependencies']);

  const crew = {
    id: 'design',
    name: 'Design',
    members: [
      { role: 'builder', selection: null },
      {
        role: 'orchestrator',
        selection: { family: 'openai', model: 'fixture', effort: 'default' },
      },
    ],
    flightMode: 'manual',
  };
  assert.equal((await send('SaveCrew', { crew }, 0)).outcome, 'applied');
  assert.equal((await send('SetDefaultCrew', { id: 'saved:design' }, 0)).outcome, 'applied');
  void send(
    'DraftDesignSystem',
    { projectId: task.projectId, description: 'Calm, one accent.' },
    0,
  );
  assert.equal((await send('GetWorkspaceState', {})).outcome, 'applied');
  assert.equal(adapter.requests.length, 1);
  assert(!answered.includes('DraftDesignSystem'));
});

// Claim: a Google start waits on a usage read before it commits, and a stop for that run is
// answered on the same socket while it waits. The stop aborts the start, which then refuses.
test('a stop for a run is answered while its Google start still waits', {
  skip:
    process.getuid?.() !== statSync(process.execPath).uid &&
    'the native client check requires a runtime owned by the user running the tests',
}, async (t) => {
  const root = mkdtempSync(join(realpathSync(checkOwner()?.stateRoot ?? tmpdir()), 'ck-line-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // PATH holds no tool at all, so no provider client or gh can be found.
  const bare = installedTools(root);
  const executable = join(root, 'peer');
  const peer = new URL('../../../../packages/testkit/src/providers/acp-peer.ts', import.meta.url)
    .href;
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport {runAcpPeer} from ${JSON.stringify(peer)};runAcpPeer('permission',true);\n`,
    { mode: 0o500 },
  );
  const harness = '#!/bin/sh\nexit 99\n';
  writeFileSync(join(root, 'localharness_external'), harness, { mode: 0o500 });
  const clientPin = {
    executable,
    harnessSha256: createHash('sha256').update(harness).digest('hex'),
    version: '1.4.0' as const,
    signerTeamId: 'TESTTEAM01',
    sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  };
  // The usage read is a child that ends only when the test or the controller ends it.
  const reading = Promise.withResolvers<void>();
  let usageReader: ReturnType<typeof spawnCheckChild> | undefined;
  let launches = 0;
  let usageClient = false;
  const options: Partial<ControllerOptions> = {
    home: join(root, 'home'),
    nativeProfiles: () => [],
    // The read that serve starts at launch finds no client. The start's own read is the one held.
    googleUsageClient: () =>
      usageClient
        ? {
            available: true,
            reason: 'available',
            client: { executable: process.execPath, version: '1.4.0', sha256: fixtureClientHash },
            environment: { HOME: userInfo().homedir },
          }
        : { available: false, reason: 'client-unavailable' },
    googleUsageSpawn: (_executable, _args, spawnOptions) => {
      usageReader = spawnCheckChild(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        spawnOptions,
      );
      reading.resolve();
      return usageReader;
    },
    googleAcp: {
      reviewMappings: [
        {
          client: acpClientPin(clientPin),
          harnessSha256: clientPin.harnessSha256,
          surface: 'config' as const,
          configId: 'mode-slot',
          valueId: 'fixture-review',
          semantics: 'request-review' as const,
          evidenceHash: 'e'.repeat(64),
        },
      ],
      toolMappings: [
        {
          client: acpClientPin(clientPin),
          toolName: 'fixture-replace',
          schema: 'replace-target-v1' as const,
          evidenceHash: 'f'.repeat(64),
        },
      ],
      spawn: (...args) => {
        launches++;
        return spawnCheckChild(...args);
      },
      resolve: (proof: AcpSetupProof | null) => {
        const config = proof?.configOptions ?? null;
        const available = !!proof?.reviewMode && proof.auth.status === 'authenticated';
        return {
          client: clientPin,
          environment: { HOME: userInfo().homedir, PATH: bare },
          facts: GoogleAcpProfileSchema.parse({
            id: 'google-acp-v1',
            family: 'google',
            displayName: 'Google ACP single-file proposal',
            clientVersion: '1.4.0',
            model: config?.model.currentValue ?? 'unknown',
            effort: config?.thoughtLevel?.currentValue ?? 'unknown',
            effortSupported: config?.thoughtLevel?.supported ?? [],
            effectiveEffort: 'unknown',
            accountClass: 'unknown',
            serviceTier: 'unknown',
            billingBasis: 'requires-user-attestation',
            qualifiedAt: null,
            creditPolicies: ['ordinary'],
            permissionModes: ['request-review'],
            maximumTaskMs: 600000,
            maximumFileBytes: 65536,
            maximumSubmissions: 1,
            available,
            reason: available ? 'qualification-pending' : 'acp-capability-missing',
            configOptions: config,
            capabilities: proof?.capabilities ?? null,
          }),
        };
      },
    },
  };
  const context = await setup(t, options);
  await acknowledgeGoogleTerms(context);
  const { controller, command, source, fixtures, clock } = context;
  t.after(() => usageReader?.kill());
  writeFileSync(join(source.directory, 'net.mjs'), 'export const total = 0;\n');
  git(source.directory, ['add', 'net.mjs']);
  git(source.directory, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'fixture target',
  ]);
  for (const name of ['InitializeGoogleAcp', 'AuthenticateGoogleAcp', 'DiscoverGoogleAcp']) {
    const current = controller.store.googleAcpSetup();
    const input = command(
      name,
      {
        profileId: 'google-acp-v1',
        consent: 'explicit',
        ...(name === 'InitializeGoogleAcp' ? {} : { proofId: current.proofId }),
        ...(name === 'AuthenticateGoogleAcp' ? { method: 'oauth-personal' } : {}),
      },
      current.revision,
    );
    assert.equal((await controller.execute(input, 'local-owner')).outcome, 'applied', name);
  }
  const setupLaunches = launches;
  const task = TaskSchema.parse((await controller.execute(context.draft, 'local-owner')).entity);
  const prepared = await controller.execute(
    command(
      'PrepareNativeRun',
      {
        taskId: task.id,
        profileId: 'google-acp-v1',
        proofId: controller.store.googleAcpSetup().proofId,
        modelId: 'fixture-model',
        thoughtLevelId: 'fixture-low',
        targetPath: 'net.mjs',
        consent: 'explicit',
        permissionMode: 'request-review',
        billingAttestation: {
          source: 'user-attested',
          subscriptionLoginConfirmed: true,
          paidExtraUsageDisabled: true,
          quotaAccountConfirmed: true,
        },
        policy: {
          ...fixtures.policy,
          quality: 'quick',
          methods: [{ id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' }],
          reserves: [],
          limits: { attempts: 4, minutes: 5, concurrency: 1 },
          effects: fixtures.policy.effects.map((grant) => ({ ...grant, taskId: task.id })),
        },
      },
      task.revision,
    ),
    'local-owner',
  );
  assert.equal(prepared.outcome, 'applied');
  const run = RunSchema.parse(prepared.entity);
  // The last usage reading is old enough that the start has to read again before it commits.
  controller.store.transaction(() => {
    controller.store.recordGoogleUsageObservation(clock.now());
    controller.store.put('window', `${run.roles[0].routeId}/quota`, 0, {
      routeId: run.roles[0].routeId,
      windowId: 'quota',
      kind: 'weekly',
      remaining: { value: 80, unit: 'percent' },
      resetsAt: new Date(Date.parse(clock.now()) + 3600000).toISOString(),
      observedAt: new Date(Date.parse(clock.now()) - 300001).toISOString(),
      source: 'client',
      confidence: 'reported',
    });
  });

  const server = await serve(controller);
  t.after(() => server.close());
  const endpoint = readControllerEndpoint(controller.home);
  const open = async () => {
    const connection = await connectController({
      ...endpoint,
      actor: { id: 'terminal', kind: 'cli' },
    });
    t.after(() => connection.close());
    return connection;
  };
  const line = await open();
  const other = await open();
  usageClient = true;
  clock.advance(60001);
  const revision = TaskSchema.parse(controller.store.get('task', task.id)).revision;
  const starting = line.command(
    CommandSchema.parse(command('StartRun', { taskId: task.id, runId: run.id }, revision)),
  );
  void starting.catch(() => {});
  // A start that answers before its usage read would leave the read unresolved and hang the file.
  const first = await Promise.race([reading.promise.then(() => null), starting]);
  assert.equal(first, null, `the start answered before its usage read: ${first?.reason}`);
  let stopAnswered = false;
  const stopping = line.command(
    CommandSchema.parse(command('StopRun', { taskId: task.id, runId: run.id }, revision)),
  );
  void stopping.then(
    () => {
      stopAnswered = true;
    },
    () => {},
  );
  // The other socket has its own line. Its answer comes after the server read the stop above.
  assert.equal(
    (await other.command(CommandSchema.parse(command('GetWorkspaceState', {})))).outcome,
    'applied',
  );
  const answeredWhileHeld = stopAnswered;
  assert(answeredWhileHeld, 'the stop was answered while the start still waited');
  assert.equal((await stopping).outcome, 'applied');
  const refused = await starting;
  // The stop moved the task, so the start refuses when it reaches its commit.
  assert.notEqual(refused.outcome, 'applied');
  assert.equal(controller.store.intents().length, 0);
  assert.equal(launches, setupLaunches);
});
