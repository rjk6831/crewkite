import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeDiagnosticsFolder } from '@crewkite/client/node';
import {
  DIAGNOSTIC_LOG_BYTES,
  DIAGNOSTIC_PART_NAMES,
  DiagnosticsReadSchema,
  type Event,
} from '@crewkite/contracts';
import { CREWKITE_VERSION } from '@crewkite/contracts/version';
import { buildDiagnostics } from './bundle.ts';

test('the diagnostics bundle holds exactly the listed parts, redacted, from a fixture home', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crewkite-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, 'ann');
  const home = join(userHome, '.crewkite');
  mkdirSync(home, { recursive: true });
  // More than the tail holds, so the cut falls inside a line, which must not reach the bundle.
  const lines = Array.from(
    { length: 3000 },
    (_, index) => `2026-01-01T00:00:00Z line-${index} API_KEY=log-secret-${index} ann@example.com`,
  );
  writeFileSync(join(home, 'controller.log'), `${lines.join('\n')}\n`);
  writeFileSync(
    join(home, 'cli.json'),
    JSON.stringify({ permissionPolicy: 'ask', theme: 'dark', accessToken: 'settings-secret' }),
  );
  const events = Array.from(
    { length: 250 },
    (_, index) =>
      ({
        id: `event-${index}`,
        payload: { text: `step ${index} for ann@example.com at ${userHome}/work` },
      }) as unknown as Event,
  );
  const source = {
    home,
    userHome,
    controllerVersion: '1.2.3',
    clients: () => [
      {
        profile: 'profile-a',
        family: 'family-a',
        available: true,
        reason: null,
        client: {
          executable: `${userHome}/bin/client-a`,
          sha256: 'a'.repeat(64),
          version: '9.9.9',
        },
      },
    ],
    events: (_taskId: string, count: number) => events.slice(-count),
    google: () => ({
      setup: {
        state: 'unknown',
        operationId: 'cmd_01M69BW1J2CTWNBH0QKA4P08Y5',
        googleTerms: { version: '2026-10-31', at: '2026-10-31T15:25:35.053Z' },
      },
      operations: {
        newest: [
          {
            commandId: 'cmd_01M69BW1J2CTWNBH0QKA4P08Y5',
            kind: 'acp-initialize',
            state: 'unknown',
            pid: 37479,
            groupPresent: false,
            note: `client at ${userHome}/providers for ann@example.com`,
            accessToken: 'google-secret',
          },
        ],
      },
      profiles: [{ id: 'google-acp-v1', available: false, reason: 'acp-capability-missing' }],
    }),
  };
  const taskId = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';

  const files = buildDiagnostics(source, {
    taskId,
    desktop: { app: '0.0.0', electron: '44.0.0', chrome: '140.0.0' },
  });
  assert.deepEqual(
    files.map((file) => file.name),
    [...DIAGNOSTIC_PART_NAMES],
  );
  assert.equal(DiagnosticsReadSchema.safeParse({ files }).success, true);
  const part = (name: string) => files.find((file) => file.name === name)?.text ?? '';

  const everything = files.map((file) => file.text).join('\n');
  for (const secret of [
    'log-secret-',
    'settings-secret',
    'google-secret',
    'ann@example.com',
    userHome,
  ])
    assert.equal(everything.includes(secret), false, secret);

  const log = part('controller.log');
  assert.ok(Buffer.byteLength(log) <= DIAGNOSTIC_LOG_BYTES);
  assert.match(log.split('\n')[0] ?? '', /^2026-01-01T00:00:00Z line-\d+ /);
  assert.ok(log.includes('line-2999'));

  const thread = JSON.parse(part('thread-events.json')) as {
    taskId: string;
    events: { id: string }[];
  };
  assert.equal(thread.taskId, taskId);
  assert.equal(thread.events.length, 200);
  assert.equal(thread.events[0]?.id, 'event-50');
  assert.equal(thread.events.at(-1)?.id, 'event-249');

  const clients = JSON.parse(part('clients.json')) as {
    clients: { client: { executable: string; sha256: string } }[];
  };
  assert.equal(clients.clients[0]?.client.executable, '~/bin/client-a');
  assert.equal(clients.clients[0]?.client.sha256, 'a'.repeat(64));
  // A field the schema does not know keeps the whole file out. A valid file exports its fields.
  assert.deepEqual(JSON.parse(part('settings.json')), { present: true, readable: false });
  writeFileSync(join(home, 'cli.json'), JSON.stringify({ permissionPolicy: 'ask', theme: 'dark' }));
  const valid = JSON.parse(buildDiagnostics(source, {})[2]?.text ?? '{}') as {
    settings: { theme: string; permissionPolicy: string };
  };
  assert.equal(valid.settings.theme, 'dark');
  assert.equal(valid.settings.permissionPolicy, 'ask');
  const versions = JSON.parse(part('versions.json')) as Record<string, string | null>;
  assert.equal(versions.crewkite, '0.0.0');
  assert.equal(versions.controller, '1.2.3');
  assert.equal(versions.electron, '44.0.0');
  const system = JSON.parse(part('system.json')) as {
    arch: string;
    memory: { totalBytes: number };
  };
  assert.ok(system.arch && system.memory.totalBytes > 0);

  // The Google part holds the setup, its operations and the profile reasons, redacted alike.
  const google = JSON.parse(part('google-setup.json')) as {
    setup: { state: string; operationId: string };
    operations: { newest: { kind: string; state: string; pid: number; note: string }[] };
    profiles: { id: string; reason: string }[];
  };
  assert.equal(google.setup.state, 'unknown');
  assert.equal(google.operations.newest[0]?.kind, 'acp-initialize');
  assert.equal(google.operations.newest[0]?.pid, 37479);
  assert.equal(google.operations.newest[0]?.note, 'client at ~/providers for [redacted]');
  assert.equal(google.profiles[0]?.reason, 'acp-capability-missing');
  // A Google source that fails leaves the part in place and says so.
  const failing = buildDiagnostics({
    ...source,
    google: () => {
      throw Error('store closed');
    },
  });
  assert.deepEqual(JSON.parse(failing.at(-1)?.text ?? '{}'), { available: false });

  // Without a desktop or a thread, the parts are still all there. The bundle names the product
  // version the controller holds and says which thread is missing.
  const bare = buildDiagnostics({ ...source, home: join(root, 'empty') });
  assert.equal(bare.length, DIAGNOSTIC_PART_NAMES.length);
  assert.equal(JSON.parse(bare[0]?.text ?? '{}').crewkite, CREWKITE_VERSION);
  assert.equal(JSON.parse(bare[4]?.text ?? '{}').taskId, null);

  // The folder writer produces one file per part and never replaces an existing folder.
  const out = join(root, 'export');
  writeDiagnosticsFolder(files, out);
  assert.deepEqual(readdirSync(out).sort(), [...DIAGNOSTIC_PART_NAMES].sort());
  assert.equal(readFileSync(join(out, 'controller.log'), 'utf8'), log);
  assert.throws(() => writeDiagnosticsFolder(files, out), /already exists/);
});
