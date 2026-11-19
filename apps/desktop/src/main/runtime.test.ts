import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeFrame, FrameDecoder } from '@crewkite/client';
import { controllerSocketPlace, publishControllerSocket } from '@crewkite/client/node';
import {
  DesktopController,
  IncompatibleController,
  offlineNotice,
  resolveRuntime,
} from './runtime.ts';

const app = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const node = realpathSync(process.execPath);

test('installed runtime refuses each changed executable or helper source before creating state', (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-runtime-hashes-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  for (const changed of [
    'node',
    'helper',
    'source',
    ...(process.platform === 'darwin' ? ['omitted helper'] : []),
  ]) {
    const appRoot =
      process.platform === 'darwin'
        ? join(temporary, changed, 'CrewKite.app/Contents/Resources/app')
        : join(temporary, changed, 'application/resources/app');
    const runtime = join(appRoot, 'runtime');
    mkdirSync(join(runtime, 'bin'), { recursive: true });
    mkdirSync(join(runtime, 'apps/controller/src/providers/local'), { recursive: true });
    writeFileSync(join(runtime, 'bin/node'), 'node');
    writeFileSync(join(runtime, 'bin/local-secure-input'), 'helper');
    writeFileSync(join(runtime, 'apps/controller/src/providers/local/secure-input.m'), 'source');
    writeFileSync(
      join(runtime, 'manifest.json'),
      JSON.stringify({
        version: 1,
        layout: 'installed',
        mode: 'workspace',
        node: {
          version: '24.22.0',
          platform: process.platform,
          arch: process.arch,
          sha256: hash(changed === 'node' ? 'changed' : 'node'),
        },
        localInput:
          changed === 'omitted helper'
            ? undefined
            : {
                sha256: hash(changed === 'helper' ? 'changed' : 'helper'),
                sourceHash: hash(changed === 'source' ? 'changed' : 'source'),
                target: 'darwin-arm64',
                minOS: '13.5.0',
              },
      }),
    );
    const state = join(temporary, changed, 'state');
    assert.throws(
      () =>
        resolveRuntime(appRoot, {
          CREWKITE_HOME: join(state, 'home'),
          CREWKITE_PROFILE: join(state, 'profile'),
        }),
      changed === 'node' ? /Node checksum/ : /Local input identity/,
    );
    assert.equal(existsSync(state), false);
  }
});

test('installed startup refuses a newer schema before creating a desktop profile', (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-runtime-schema-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const appRoot =
    process.platform === 'darwin'
      ? join(temporary, 'CrewKite.app/Contents/Resources/app')
      : join(temporary, 'application/resources/app');
  const runtime = join(appRoot, 'runtime');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  mkdirSync(join(runtime, 'apps/controller/src/store'), { recursive: true });
  mkdirSync(join(runtime, 'apps/controller/src/providers/local'), { recursive: true });
  mkdirSync(join(runtime, 'apps/controller/migrations'), { recursive: true });
  copyFileSync(node, join(runtime, 'bin/node'));
  writeFileSync(join(runtime, 'bin/local-secure-input'), 'helper');
  writeFileSync(join(runtime, 'apps/controller/src/providers/local/secure-input.m'), 'source');
  copyFileSync(
    fileURLToPath(
      new URL('../../../controller/src/store/schema-compatibility.ts', import.meta.url),
    ),
    join(runtime, 'apps/controller/src/store/schema-compatibility.ts'),
  );
  writeFileSync(join(runtime, 'apps/controller/migrations/001-initial.sql'), '');
  writeFileSync(
    join(runtime, 'manifest.json'),
    JSON.stringify({
      version: 1,
      layout: 'installed',
      mode: 'workspace',
      node: {
        version: '24.22.0',
        platform: process.platform,
        arch: process.arch,
        sha256: createHash('sha256').update(readFileSync(node)).digest('hex'),
      },
      ...(process.platform === 'darwin'
        ? {
            localInput: {
              sha256: createHash('sha256').update('helper').digest('hex'),
              sourceHash: createHash('sha256').update('source').digest('hex'),
              target: 'darwin-arm64',
              minOS: '13.5.0',
            },
          }
        : {}),
    }),
  );
  const home = join(temporary, 'state/home');
  const profile = join(temporary, 'state/profile');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const database = join(home, 'state.sqlite');
  const store = new DatabaseSync(database);
  store.exec('PRAGMA user_version = 999');
  store.close();
  const before = readFileSync(database);
  assert.throws(
    () => resolveRuntime(appRoot, { CREWKITE_HOME: home, CREWKITE_PROFILE: profile }),
    /needs a newer controller/,
  );
  assert.deepEqual(readFileSync(database), before);
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(`${database}-wal`), false);
  assert.equal(existsSync(`${database}-shm`), false);
  const compatible = new DatabaseSync(database);
  compatible.exec('PRAGMA user_version = 1');
  compatible.close();
  writeFileSync(join(runtime, 'apps/controller/src/main.ts'), '');
  const paths = resolveRuntime(appRoot, { CREWKITE_HOME: home, CREWKITE_PROFILE: profile });
  assert.equal(paths.home, home);
  assert.equal(paths.profile, profile);
  assert.equal(paths.controller, join(runtime, 'apps/controller/src/main.ts'));
  assert.equal(existsSync(profile), true);
});

test('a source desktop on the real controller starts apps/controller and never the demo controller', {
  skip: process.versions.node !== '24.22.0',
}, (t) => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-runtime-')));
  // The guard takes the person's home folder from the system, which follows HOME.
  const savedHome = process.env.HOME;
  process.env.HOME = state;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(state, { recursive: true, force: true });
  });
  const environment = {
    CREWKITE_HOME: join(state, '.crewkite'),
    CREWKITE_PROFILE: join(state, '.crewkite-desktop'),
    CREWKITE_SOURCE_NODE: node,
    CREWKITE_SOURCE_NODE_HASH: createHash('sha256').update(readFileSync(node)).digest('hex'),
    CREWKITE_SOURCE_STATE_ROOT: state,
  };
  const paths = resolveRuntime(app, environment);
  assert.equal(paths.mode, 'workspace');
  assert.equal(paths.controller, join(paths.root, 'apps/controller/src/main.ts'));
  assert.equal(paths.home, environment.CREWKITE_HOME);
  // A home in the checkout's internal folder is refused before anything is created there.
  assert.throws(
    () =>
      resolveRuntime(app, {
        ...environment,
        CREWKITE_HOME: join(paths.root, 'internal', 'demo-home'),
      }),
    /in or around this checkout/,
  );
  // A state root that is not the person's home folder is refused.
  assert.throws(
    () => resolveRuntime(app, { ...environment, CREWKITE_SOURCE_STATE_ROOT: tmpdir() }),
    /must be your home folder/,
  );
});

test('the desktop attaches only to a live controller on its own schema and starts none beside another', async (t) => {
  const root = realpathSync(join(app, '../..'));
  const bundled = readdirSync(join(root, 'apps/controller/migrations')).filter((name) =>
    name.endsWith('.sql'),
  ).length;
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-handshake-')));
  const sockets: string[] = [];
  t.after(() => {
    for (const socket of sockets) rmSync(socket, { force: true });
    rmSync(state, { recursive: true, force: true });
  });
  // A start runs this empty file, which exits at once, so any start shows as a refused startup.
  const controller = join(state, 'exits.mjs');
  writeFileSync(controller, '');
  const older =
    'An older CrewKite is still running with this home. Quit it from its menu, then open CrewKite again.';
  for (const [index, row] of [
    // 0.1.0 records no schema.
    { schema: undefined, live: true, outcome: older },
    { schema: bundled - 1, live: true, outcome: older },
    {
      schema: bundled + 1,
      live: true,
      outcome: 'A newer CrewKite is running with this home. Use that version.',
    },
    { schema: bundled, live: true, outcome: 'attached' },
    // An older controller that crashed left its record and socket file, and holds nothing.
    {
      schema: undefined,
      live: false,
      outcome: 'The controller refused startup. Another process may own this home.',
    },
  ].entries()) {
    const home = join(state, `home-${index}`);
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'token'), 'a'.repeat(64), { mode: 0o600 });
    const socketPath = controllerSocketPlace(home);
    sockets.push(socketPath);
    const tokens: string[] = [];
    const server = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on('error', () => {});
      socket.on('data', (bytes) => {
        for (const message of decoder.push(bytes))
          if (message.type === 'hello') {
            tokens.push(message.token);
            socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: '0' }));
          }
      });
    });
    if (row.live) {
      server.listen(socketPath);
      await once(server, 'listening');
    } else
      spawnSync(process.execPath, [
        '-e',
        'require("node:net").createServer().listen(process.argv[1],()=>process.exit(0))',
        socketPath,
      ]);
    // A 0.1.0 controller wrote the bare path, which publishControllerSocket no longer does.
    if (row.schema === undefined)
      writeFileSync(join(home, 'control-socket'), socketPath, { mode: 0o600 });
    else publishControllerSocket(home, socketPath, row.schema);
    const desktop = new DesktopController({
      mode: 'workspace',
      root,
      node: process.execPath,
      controller,
      home,
      profile: join(state, 'profile'),
    });
    const outcome = await desktop.connect().then(
      () => 'attached',
      (error: Error) => error.message,
    );
    await desktop.close();
    if (row.live) await new Promise((closed) => server.close(closed));
    assert.equal(outcome, row.outcome, `schema ${row.schema}, live ${row.live}`);
    // The token goes only to a controller the desktop attaches to.
    assert.equal(tokens.length, outcome === 'attached' ? 1 : 0);
  }
});

test('the offline notice carries a reason only for the older controller refusal', () => {
  const refusal = new IncompatibleController('An older CrewKite is still running with this home.');
  assert.deepEqual(offlineNotice(refusal), {
    kind: 'connection',
    state: 'offline',
    reconnectAvailable: true,
    reason: 'An older CrewKite is still running with this home.',
  });
  assert.deepEqual(offlineNotice(new Error('The controller refused startup.')), {
    kind: 'connection',
    state: 'offline',
    reconnectAvailable: true,
  });
});
