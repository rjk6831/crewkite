import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalSetup } from '@crewkite/contracts';
import {
  connectInPlace,
  connectLocalFlow,
  lastSeen,
  lowMemory,
  selectionConfirmed,
  selectionLost,
  statusLine,
  WITHOUT_TOKEN,
  waitForLocalReadiness,
} from './local-setup-flow.ts';

const setup = (change: Partial<LocalSetup> = {}): LocalSetup => ({
  revision: 1,
  connectionRevision: 1,
  connectorId: 'local-sdk-v1',
  endpoint: 'ws://127.0.0.1:1234',
  setupHash: null,
  connectionHash: 'a'.repeat(64),
  secretConfigured: false,
  authMode: 'token',
  connected: false,
  operation: {
    kind: 'input',
    operationId: 'cmd_01K7M1N2P3Q4R5S6T7V8W9X0YZ',
    state: 'owned',
  },
  generation: 'idle',
  observation: null,
  selection: null,
  reason: 'input-active',
  ...change,
});

test('local readiness polling keeps one read in flight and discovers once', async () => {
  const waits: (() => void)[] = [];
  const reads: PromiseWithResolvers<LocalSetup>[] = [];
  let activeReads = 0;
  let maximumReads = 0;
  let discoveries = 0;
  const polling = waitForLocalReadiness({
    endpoint: 'ws://127.0.0.1:1234',
    wait: () => new Promise<void>((resolve) => waits.push(resolve)),
    read: () => {
      activeReads++;
      maximumReads = Math.max(maximumReads, activeReads);
      const next = Promise.withResolvers<LocalSetup>();
      reads.push(next);
      return next.promise.finally(() => activeReads--);
    },
    discover: async () => {
      discoveries++;
      return true;
    },
    active: () => true,
  });
  const settle = async () => {
    for (let index = 0; index < 4; index++) await Promise.resolve();
  };
  const tick = async (value: LocalSetup) => {
    waits.shift()?.();
    await settle();
    assert.equal(reads.length, 1);
    reads.shift()?.resolve(value);
    await settle();
  };
  await tick(setup());
  await tick(setup({ connected: true, secretConfigured: true, operation: null }));
  await tick(
    setup({
      connected: true,
      secretConfigured: true,
      operation: {
        kind: 'discovery',
        operationId: 'cmd_01K7M1N2P3Q4R5S6T7V8W9X0YY',
        state: 'owned',
      },
    }),
  );
  const observation = {
    version: 1 as const,
    runtime: { connectorId: 'local-sdk-v1' as const, version: '1.0.0', build: 1 },
    observationHash: 'b'.repeat(64),
    models: [],
    residentLlms: 0,
    embeddingInstances: 0,
  };
  await tick(
    setup({
      connected: true,
      secretConfigured: true,
      operation: null,
      observation,
      reason: 'model-selection-required',
    }),
  );
  assert.equal(await polling, 'ready');
  assert.equal(discoveries, 1);
  assert.equal(maximumReads, 1);
});

test('local readiness polling stops after twenty fake clock ticks', async () => {
  let ticks = 0;
  let reads = 0;
  const result = await waitForLocalReadiness({
    endpoint: 'ws://127.0.0.1:1234',
    wait: async () => {
      ticks++;
    },
    read: async () => {
      reads++;
      return setup();
    },
    discover: async () => {
      assert.fail('discovery must wait for the connection');
    },
    active: () => true,
  });
  assert.equal(result, 'timeout');
  assert.equal(ticks, 20);
  assert.equal(reads, 20);
});

test('Local connect stops its command chain when component ownership changes', async () => {
  let current = true;
  const configured = Promise.withResolvers<{
    outcome: 'applied';
    revision: number;
  }>();
  const commands: string[] = [];
  const connecting = connectLocalFlow({
    setup: setup({ operation: null }),
    endpoint: 'ws://127.0.0.1:5678',
    authMode: 'token',
    command: async (input) => {
      commands.push(input.command);
      if (input.command !== 'ConfigureLocal') assert.fail('connection input must not start');
      return configured.promise;
    },
    active: () => current,
  });
  assert.deepEqual(commands, ['ConfigureLocal']);
  current = false;
  configured.resolve({ outcome: 'applied', revision: 2 });
  assert.deepEqual(await connecting, { kind: 'stopped' });
  assert.deepEqual(commands, ['ConfigureLocal']);

  // The cached observation is labelled with its age, and the low memory line follows the two
  // thresholds. A selection that no longer matches a loaded model says so by name, and a selection
  // counts as confirmed only from a read made after the request that still holds the instance.
  const gib = 1024 ** 3;
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const seen: [string | null | undefined, string | null][] = [
    [at(120), 'Last seen 2 h ago. Not connected.'],
    [at(5), 'Last seen 5 min ago. Not connected.'],
    [at(0), 'Last seen just now. Not connected.'],
    [at(3000), 'Last seen 2 d ago. Not connected.'],
    [null, null],
  ];
  for (const [observed, want] of seen)
    assert.equal(lastSeen(observed, now), want, String(observed));
  // A new connection before its first read shows the age alone.
  assert.equal(lastSeen(at(5), now, true), 'Last seen 5 min ago.');
  const observed = (loaded: number) => ({ residentLlms: loaded }) as LocalSetup['observation'];
  const memory: [number, number, number, string | null][] = [
    [
      1.2 * gib,
      48 * gib,
      2,
      'Low memory: 1.2 GB available with 2 models loaded. Replies may slow.',
    ],
    [3 * gib, 128 * gib, 1, 'Low memory: 3 GB available with 1 model loaded. Replies may slow.'],
    [6 * gib, 48 * gib, 2, null],
    [
      4.5 * gib,
      64 * gib,
      2,
      'Low memory: 4.5 GB available with 2 models loaded. Replies may slow.',
    ],
    [60 * gib, 512 * gib, 2, null],
    [1 * gib, 8 * gib, 0, null],
  ];
  for (const [free, total, loaded, want] of memory)
    assert.equal(
      lowMemory(
        { availableMemoryBytes: free, observation: observed(loaded) },
        { totalMemoryBytes: total, availableMemoryBytes: null },
      ),
      want,
      `${free / gib} of ${total / gib}`,
    );
  const live = setup({
    connected: true,
    operation: null,
    observation: observed(1),
    selection: null,
  });
  const picked = { selectionId: 'c'.repeat(64), observationHash: 'b'.repeat(64) };
  assert.equal(selectionLost('Model A', live), 'Model A is no longer loaded. Pick a model.');
  assert.equal(selectionLost('Model A', { ...live, selection: picked }), null);
  assert.equal(selectionLost('Model A', { ...live, connected: false }), null);
  assert.equal(selectionLost('Model A', { ...live, observationStale: true }), null);
  assert.equal(selectionLost(null, live), null);
  const choice = { selectionId: picked.selectionId, state: 'loaded-eligible' };
  const holding = (change: Partial<LocalSetup>) =>
    setup({
      connected: true,
      operation: null,
      selection: picked,
      observation: { models: [choice] } as unknown as LocalSetup['observation'],
      observedAt: at(0),
      ...change,
    });
  assert.equal(selectionConfirmed(holding({}), now - 1000), true);
  assert.equal(selectionConfirmed(holding({ observedAt: at(1) }), now - 1000), false);
  assert.equal(selectionConfirmed(holding({ observedAt: null }), now - 1000), false);
  assert.equal(selectionConfirmed(holding({ connected: false }), now - 1000), false);
  assert.equal(
    selectionConfirmed(
      holding({ observation: { models: [{ ...choice, state: 'installed-unloaded' }] } as never }),
      now - 1000,
    ),
    false,
  );

  // The rail connects in place. A runtime that wants a token shows the input operation, which is
  // the token window, and only then does Settings open. Auth off connects with no prompt.
  const rail = async (reads: LocalSetup[], start: LocalSetup) => {
    const sent: string[] = [];
    const result = await connectInPlace({
      setup: start,
      command: async (input) => {
        sent.push(input.command);
        return { outcome: 'applied', revision: 2 };
      },
      read: async () => reads.shift(),
      wait: async () => {},
      active: () => true,
    });
    return { result, sent };
  };
  const idle = setup({ operation: null, reason: 'connection-required' });
  const up = setup({ connected: true, operation: null, secretConfigured: false });
  const withModels = { ...up, observation: observed(1) };
  assert.deepEqual(await rail([setup()], idle), {
    result: { kind: 'settings', why: 'token' },
    sent: ['BeginLocalConnectionInput'],
  });
  assert.deepEqual(await rail([up, withModels], idle), {
    result: { kind: 'connected', withoutToken: true },
    sent: ['BeginLocalConnectionInput', 'RefreshLocalModels'],
  });
  // While the loopback probe runs, the input operation is not yet the window. The probe can end it
  // and connect with no token, and the last read on view waits for the fresh one.
  const probing = setup({
    operation: { kind: 'input', operationId: 'cmd_01K7M1N2P3Q4R5S6T7V8W9X0YZ', state: 'intent' },
  });
  const cached = { ...up, observation: observed(1), observationStale: true as const };
  assert.deepEqual(await rail([probing, cached, withModels], idle), {
    result: { kind: 'connected', withoutToken: true },
    sent: ['BeginLocalConnectionInput', 'RefreshLocalModels'],
  });
  assert.deepEqual(await rail([probing, setup()], idle), {
    result: { kind: 'settings', why: 'token' },
    sent: ['BeginLocalConnectionInput'],
  });
  assert.deepEqual(await rail([], setup({ endpoint: null, operation: null })), {
    result: { kind: 'settings', why: 'unconfigured' },
    sent: [],
  });
  assert.equal(
    (await rail([setup({ operation: null, reason: 'connection-unavailable' })], idle)).result.kind,
    'blocked',
  );
  assert.match(WITHOUT_TOKEN, /^Connected without a token./);

  // One status line. A background read keeps the line it interrupted, a lost selection or an
  // action message wins over the saved reason, and a confirmed selection sits between them.
  const line = (change: Partial<Parameters<typeof statusLine>[0]>) =>
    statusLine({
      setup: { reason: 'qualification-pending' },
      message: null,
      lost: null,
      confirmed: false,
      quiet: false,
      held: null,
      ...change,
    });
  const reading = { reason: 'discovery-active' as const };
  assert.equal(line({}), 'Connected. The loaded model is eligible for chat.');
  assert.equal(
    line({
      setup: reading,
      quiet: true,
      held: 'Connected. The loaded model is eligible for chat.',
    }),
    'Connected. The loaded model is eligible for chat.',
  );
  assert.equal(line({ setup: reading }), 'The controller is reading model metadata.');
  assert.equal(line({ confirmed: true }), 'Model selection confirmed');
  assert.equal(
    line({ confirmed: true, message: 'Taking longer than expected.' }),
    'Taking longer than expected.',
  );
  assert.equal(
    line({ message: 'x', lost: 'Model A is no longer loaded. Pick a model.' }),
    'Model A is no longer loaded. Pick a model.',
  );
  assert.equal(
    line({ setup: { reason: 'connection-required' } }),
    'Press Connect. CrewKite checks whether the runtime wants a token.',
  );
  // The rail reads the probe's answer, not the saved mode, for "no token".
  assert.deepEqual(
    await rail(
      [
        { ...up, secretConfigured: true, connectedWithoutToken: false },
        { ...withModels, secretConfigured: true, connectedWithoutToken: false },
      ],
      idle,
    ),
    {
      result: { kind: 'connected', withoutToken: false },
      sent: ['BeginLocalConnectionInput', 'RefreshLocalModels'],
    },
  );
});
