import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type BillingMode,
  type ChatFamily,
  type ChatRole,
  CONNECTION_COPY,
  type Connection,
  MAX_CONNECTIONS,
  type Project,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { Controller } from '../commands/controller.ts';
import { Store } from '../store/index.ts';
import {
  Connections,
  type ConnectionsCommand,
  connectionRefusal,
  connectionsCommand,
} from './connections.ts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const OPENAI_API = 'con_01KA0000000000000000000001';
const ANTHROPIC_API = 'con_01KA0000000000000000000002';
const OPENAI_KEPT = 'con_01KA0000000000000000000003';

function home(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-connections-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = createTestClock();
  const fixtures = createDemoFixtures(clock.now());
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(migrations);
  const project: Project = { id: fixtures.task.projectId, name: 'demo-shop', revision: 0 };
  store.transaction(() => {
    store.put('project', project.id, 0, project);
    store.put('task', fixtures.task.id, 0, fixtures.task);
  });
  // A fake client per connection. `modes` is what its read answers; a missing entry names
  // nothing the controller can place.
  const modes = new Map<string, BillingMode | null>();
  const calls = { prepared: [] as string[], read: [] as string[], signedOut: [] as string[] };
  const stopped: string[] = [];
  const ids = createTestIds(clock.now());
  const connections = new Connections({
    store,
    now: clock.now,
    // The controller lends a message ID's time-ordered suffix the same way.
    id: () => `con_${ids('msg').slice(4)}`,
    client: {
      prepare: (connection) => {
        calls.prepared.push(connection.profileId);
      },
      loginLine: (connection) => `sign in ${connection.profileId}`,
      readMode: async (connection) => {
        calls.read.push(connection.connectionId);
        return modes.get(connection.connectionId);
      },
      signOut: async (connection) => {
        calls.signedOut.push(connection.connectionId);
      },
    },
    stopTurns: (connectionId) => stopped.push(connectionId),
  });
  const put = (connectionId: string, family: ChatFamily, keepConnected = false) =>
    store.transaction(() =>
      store.putConnection(
        {
          connectionId,
          family,
          backend: 'native-client',
          billingMode: 'api',
          profileId: `${family}-api`,
          keepConnected,
          readiness: 'ready',
          proofGeneration: 1,
          observedMode: 'api',
          observedAt: clock.now(),
        },
        clock.now(),
      ),
    );
  // Every change goes through the command, the path the desktop and the CLI take.
  const run = (command: string, payload: object) => {
    const effects: (() => void)[] = [];
    const result = store.transaction(() =>
      connectionsCommand(
        connections,
        { command, payload } as unknown as ConnectionsCommand,
        effects,
      ),
    );
    for (const effect of effects) effect();
    return result;
  };
  return { store, connections, put, run, modes, calls, stopped, taskId: fixtures.task.id };
}

// Claim: an API connection reaches a turn only through the person's assignment, for that thread or
// that one role, on its own family. Every automatic path routes through this one function.
test('an API connection routes only the thread or the role it was assigned to', (t) => {
  const { connections, put, run, taskId } = home(t);
  put(OPENAI_API, 'openai');
  put(ANTHROPIC_API, 'anthropic');
  const roles: ChatRole[] = ['assistant', 'reviewer', 'fixer', 'challenger', 'orchestrator', 'ask'];
  const routes = (family: ChatFamily) =>
    roles.map((role) => connections.route(taskId, role, family)?.connectionId ?? null);

  // Connected and ready, but assigned to nothing: every role runs on the family's own route.
  assert.deepEqual(
    routes('openai'),
    roles.map(() => null),
  );

  assert.equal(
    run('AssignConnection', {
      taskId,
      role: 'builder',
      connectionId: OPENAI_API,
      consent: 'explicit',
    }).outcome,
    'applied',
  );
  // The builder's assignment reaches the builder turn on OpenAI and no sibling role.
  assert.deepEqual(routes('openai'), [OPENAI_API, null, null, null, null, null]);
  assert.deepEqual(
    routes('anthropic'),
    roles.map(() => null),
  );

  run('AssignConnection', {
    taskId,
    role: 'thread',
    connectionId: ANTHROPIC_API,
    consent: 'explicit',
  });
  // The thread's assignment reaches every role on its own family, the builder's own included,
  // and never another family.
  assert.deepEqual(
    routes('anthropic'),
    roles.map(() => ANTHROPIC_API),
  );
  assert.deepEqual(routes('openai'), [OPENAI_API, null, null, null, null, null]);
  assert.deepEqual(
    connections.read(taskId).assignments.map(({ role, connectionId }) => [role, connectionId]),
    [
      ['builder', OPENAI_API],
      ['thread', ANTHROPIC_API],
    ],
  );

  run('UnassignConnection', { taskId, role: 'builder' });
  assert.deepEqual(
    routes('openai'),
    roles.map(() => null),
  );
  // An assignment names a connection that exists. A refusal changes nothing.
  assert.deepEqual(
    run('AssignConnection', {
      taskId,
      role: 'reviewer',
      connectionId: 'con_01KA0000000000000000000009',
      consent: 'explicit',
    }),
    {
      outcome: 'blocked',
      reason: 'connection-not-found',
      next: 'This connection is gone. Read the connections again.',
    },
  );
  assert.equal(connections.route(taskId, 'reviewer', 'openai'), null);
});

// Claim: keeping a connection, assigning it and permission to run are separate. A restart keeps
// the first two, and a kept connection admits again only after its client proves the mode anew. A
// proof from a turn or a restart never brings back what the person disconnected. Disconnect and
// Forget stop a turn running on the connection, and Forget removes the record and its assignments
// and signs out only the owned profile.
test('a restart, Disconnect and Forget each keep only what they promise', async (t) => {
  const { store, connections, put, run, modes, calls, stopped, taskId } = home(t);
  put(OPENAI_API, 'openai');
  put(OPENAI_KEPT, 'openai', true);
  run('AssignConnection', {
    taskId,
    role: 'thread',
    connectionId: OPENAI_KEPT,
    consent: 'explicit',
  });
  const state = (connectionId: string) => {
    const { readiness, observedMode, keepConnected, proofGeneration } = store.connection(
      connectionId,
    ) as Connection;
    return { readiness, observedMode, keepConnected, proofGeneration };
  };

  modes.set(OPENAI_KEPT, 'api');
  modes.set(OPENAI_API, 'api');
  const restoring = connections.restore();
  // No earlier proof counts. The kept one waits for its client; the other stays disconnected.
  assert.deepEqual(state(OPENAI_KEPT), {
    readiness: 'needs-attention',
    observedMode: null,
    keepConnected: true,
    proofGeneration: 1,
  });
  assert.equal(state(OPENAI_API).readiness, 'disconnected');
  await restoring;
  // The kept one asked its own client and came back. The one not kept was never read.
  assert.deepEqual(calls.read, [OPENAI_KEPT]);
  assert.deepEqual(state(OPENAI_KEPT), {
    readiness: 'ready',
    observedMode: 'api',
    keepConnected: true,
    proofGeneration: 2,
  });
  assert.equal(connections.route(taskId, 'reviewer', 'openai')?.connectionId, OPENAI_KEPT);

  // A turn's proof of another mode leaves it needing attention.
  store.transaction(() => connections.observe(OPENAI_KEPT, 'subscription'));
  assert.deepEqual(state(OPENAI_KEPT), {
    readiness: 'needs-attention',
    observedMode: 'subscription',
    keepConnected: true,
    proofGeneration: 3,
  });
  store.transaction(() => connections.observe(OPENAI_KEPT, 'api'));
  assert.equal(state(OPENAI_KEPT).readiness, 'ready');

  run('DisconnectConnection', { connectionId: OPENAI_KEPT });
  assert.deepEqual(stopped, [OPENAI_KEPT]);
  // A turn still running on it reads its client again. That proof leaves it disconnected.
  store.transaction(() => connections.observe(OPENAI_KEPT, 'api'));
  assert.deepEqual(state(OPENAI_KEPT), {
    readiness: 'disconnected',
    observedMode: null,
    keepConnected: true,
    proofGeneration: 4,
  });
  // A disconnected connection stays assigned, so its turns are refused and never move elsewhere.
  assert.equal(connections.route(taskId, 'reviewer', 'openai')?.connectionId, OPENAI_KEPT);
  // A restart does not bring back what the person disconnected, and does not read its client.
  await connections.restore();
  assert.equal(state(OPENAI_KEPT).readiness, 'disconnected');
  assert.deepEqual(calls.read, [OPENAI_KEPT]);

  run('SetKeepConnected', { connectionId: OPENAI_API, keepConnected: true });
  assert.equal(state(OPENAI_API).keepConnected, true);
  assert.deepEqual(calls.signedOut, []);
  run('ForgetConnection', { connectionId: OPENAI_KEPT });
  assert.equal(store.connection(OPENAI_KEPT), undefined);
  assert.deepEqual(connections.read(taskId).assignments, []);
  assert.equal(connections.route(taskId, 'reviewer', 'openai'), null);
  assert.deepEqual(stopped, [OPENAI_KEPT, OPENAI_KEPT]);
  assert.deepEqual(calls.signedOut, [OPENAI_KEPT]);
  assert.deepEqual(
    connections.read().connections.map((connection) => connection.connectionId),
    [OPENAI_API],
  );
});

// Claim: a new API connection admits nothing until the person's check reads its own profile and
// finds the chosen mode. Another mode, a signed-out client or an answer CrewKite cannot place each
// leave it refusing, and the person's check is the one proof that brings back a disconnect.
test('an added connection admits a turn only after a check proves its mode', async (t) => {
  const { store, connections, put, run, modes, calls, stopped } = home(t);
  const added = run('AddConnection', { family: 'anthropic', label: 'Team key' });
  assert.equal(added.outcome, 'applied');
  assert(added.data?.kind === 'connection-added');
  const { connection, loginLine } = added.data;
  const { connectionId, profileId } = connection;
  assert.deepEqual(connection, {
    connectionId,
    family: 'anthropic',
    backend: 'native-client',
    billingMode: 'api',
    profileId,
    label: 'Team key',
    keepConnected: false,
    readiness: 'needs-attention',
    proofGeneration: 0,
    observedMode: null,
    observedAt: null,
  });
  assert.equal(profileId, `api-${connectionId.slice(4).toLowerCase()}`);
  assert.equal(loginLine, `sign in ${profileId}`);
  assert.deepEqual(calls.prepared, [profileId]);
  assert.deepEqual(connections.read().loginLines, [{ connectionId, line: loginLine }]);
  const admits = () => connectionRefusal(store.connection(connectionId) as Connection, ['api']);
  assert.equal(admits()?.message, 'Team key has not confirmed its billing mode.');

  const rows: [string, BillingMode | null | undefined, object, string | null][] = [
    [
      'the profile is signed in to a subscription',
      'subscription',
      { outcome: 'blocked', reason: 'mode-mismatch', next: CONNECTION_COPY.signInChanged },
      CONNECTION_COPY.signInChanged,
    ],
    ['the profile is signed in with an API key', 'api', { outcome: 'applied' }, null],
    [
      'the client names nothing CrewKite can place, which changes nothing',
      undefined,
      {
        outcome: 'blocked',
        reason: 'proof-unavailable',
        next: 'The client did not say which mode it is signed in with. Check that it is installed, then check again.',
      },
      null,
    ],
    [
      'the profile is signed out',
      null,
      {
        outcome: 'blocked',
        reason: 'signed-out',
        next: 'Run the sign-in line in your terminal, then check again.',
      },
      'Team key is disconnected.',
    ],
    ["the person's check after a disconnect", 'api', { outcome: 'applied' }, null],
  ];
  for (const [claim, mode, answer, refusal] of rows) {
    if (mode === undefined) modes.delete(connectionId);
    else modes.set(connectionId, mode);
    const { data: _data, ...result } = await connections.prove(connectionId, true);
    assert.deepEqual(result, answer, claim);
    assert.equal(admits()?.message ?? null, refusal, claim);
  }
  // A signed-out profile also stops a turn still running on it. A turn's own read that finds it
  // signed out records the same way, so the connection's other turns stop too.
  assert.deepEqual(stopped, [connectionId]);
  assert.equal(connections.record(connectionId, null)?.readiness, 'disconnected');
  assert.deepEqual(stopped, [connectionId, connectionId]);

  // One home keeps at most 64 connections.
  for (let index = 1; index < MAX_CONNECTIONS; index += 1)
    put(`con_01KB${String(index).padStart(22, '0')}`, 'openai');
  assert.deepEqual(run('AddConnection', { family: 'openai' }), {
    outcome: 'blocked',
    reason: 'connections-full',
    next: 'CrewKite keeps at most 64 connections. Forget one first.',
  });
  assert.equal(store.connections().length, MAX_CONNECTIONS);
});

// Claim: a repeated AddConnection key answers from its receipt with the first connection and adds
// none. The desktop's exact retry relies on it.
test('a repeated AddConnection key answers the first connection and adds none', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-add-retry-')));
  // The profile folder lands under HOME, and no client on PATH can be found or run.
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const empty = join(directory, 'empty-bin');
  mkdirSync(empty);
  process.env.HOME = join(directory, 'home');
  mkdirSync(process.env.HOME);
  process.env.PATH = empty;
  const clock = createTestClock();
  const controller = new Controller({
    home: join(directory, 'controller'),
    now: clock.now,
    id: createTestIds(clock.now()),
    googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
  });
  t.after(async () => {
    await controller.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const add = {
    protocol: 1,
    key: 'cmd_01KA0000000000000000000009',
    actor: { id: 'desktop', kind: 'desktop' },
    expectedRevision: 0,
    command: 'AddConnection',
    payload: { family: 'openai', label: 'Team key' },
  };
  const first = await controller.execute(add, 'local-owner');
  assert.equal(first.outcome, 'applied');
  assert(first.data?.kind === 'connection-added');
  const again = await controller.execute(add, 'local-owner');
  assert.equal(again.outcome, 'already-applied');
  assert.deepEqual(again.data, first.data);
  assert.deepEqual(
    controller.store.connections().map((connection) => connection.connectionId),
    [first.data.connection.connectionId],
  );
});

// Claim: an API connection whose profile folder cannot be made refuses with a sentence and writes
// no row, and the same key answers the same refusal from its receipt.
test('an api connection whose folder cannot be made refuses and writes nothing', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-add-link-')));
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const empty = join(directory, 'empty-bin');
  mkdirSync(empty);
  mkdirSync(join(directory, 'real-home'));
  // HOME is reached through a link, so the folder under it is refused.
  symlinkSync(join(directory, 'real-home'), join(directory, 'home'));
  process.env.HOME = join(directory, 'home');
  process.env.PATH = empty;
  const clock = createTestClock();
  const controller = new Controller({
    home: join(directory, 'controller'),
    now: clock.now,
    id: createTestIds(clock.now()),
    googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
  });
  t.after(async () => {
    await controller.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const add = {
    protocol: 1,
    key: 'cmd_01KA0000000000000000000010',
    actor: { id: 'desktop', kind: 'desktop' },
    expectedRevision: 0,
    command: 'AddConnection',
    payload: { family: 'openai', label: 'Team key' },
  };
  const refusal = {
    outcome: 'blocked',
    reason: 'profile-unavailable',
    next: "CrewKite could not make this connection's folder. Its path must be real folders that only you can read. Fix the folder, then add the connection again.",
  };
  assert.deepEqual(await controller.execute(add, 'local-owner'), refusal);
  assert.deepEqual(controller.store.connections(), []);
  // The link becomes a real folder, so a fresh attempt would now work. The same key can only
  // answer the refusal from its receipt.
  rmSync(join(directory, 'home'));
  mkdirSync(join(directory, 'home'), { mode: 0o700 });
  assert.deepEqual(await controller.execute(add, 'local-owner'), refusal);
  assert.deepEqual(controller.store.connections(), []);
});

// Claim: a turn that started before the last proof cannot make the connection ready again. A
// check the person ran since may have found a mismatch. The same turn's sign-out still counts,
// since it only stops work.
test('a turn proof older than the last check never makes the connection ready again', async (t) => {
  const { store, connections, put, modes } = home(t);
  put(OPENAI_API, 'openai');
  const started = store.connection(OPENAI_API)?.proofGeneration as number;
  // The person's check finds the profile signed in to a subscription.
  modes.set(OPENAI_API, 'subscription');
  await connections.prove(OPENAI_API, true);
  const checked = store.connection(OPENAI_API) as Connection;
  assert.equal(checked.readiness, 'needs-attention');
  // A turn that started before the check reports the mode it saw then, which changes nothing.
  connections.record(OPENAI_API, 'api', false, started);
  assert.deepEqual(store.connection(OPENAI_API), checked);
  // A turn that started after the check counts.
  assert.equal(
    connections.record(OPENAI_API, 'api', false, checked.proofGeneration)?.readiness,
    'ready',
  );
  // An old turn that finds the profile signed out still disconnects it.
  assert.equal(connections.record(OPENAI_API, null, false, started)?.readiness, 'disconnected');
});
