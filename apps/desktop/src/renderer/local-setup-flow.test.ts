import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalEndpointSchema, type LocalSetup } from '@crewkite/contracts';
import {
  connectInPlace,
  connectLocalFlow,
  DEFAULT_LOCAL_ENDPOINT,
  DISCOVERY_FOLLOW_MS,
  followDiscovery,
  lastSeen,
  localNotices,
  lowMemory,
  READING_LINE,
  selectionConfirmed,
  selectionLost,
  statusLine,
  WAITING_LINE,
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

test('one Connect sends the connection again when it ends saved and unconnected with no failure', async () => {
  const follow = async (states: LocalSetup[]) => {
    const calls: string[] = [];
    const result = await waitForLocalReadiness({
      endpoint: 'ws://127.0.0.1:1234',
      wait: async () => {},
      read: async () => states.shift() ?? setup({ operation: null }),
      discover: async () => {
        calls.push('discover');
        return true;
      },
      reconnect: async () => {
        calls.push('reconnect');
        return true;
      },
      active: () => true,
    });
    return { result, calls };
  };
  const idle = setup({ operation: null, reason: 'connection-required' });
  const connected = setup({ operation: null, connected: true, reason: 'discovery-required' });
  const read = setup({
    operation: null,
    connected: true,
    observation: {} as LocalSetup['observation'],
    reason: 'model-selection-required',
  });
  // The field starts on the usual runtime port, a value Connect accepts as it is.
  assert(LocalEndpointSchema.safeParse(DEFAULT_LOCAL_ENDPOINT).success);
  // The first press ends unconnected with nothing failed: Connect goes out once more, then reads.
  assert.deepEqual(await follow([setup(), idle, connected, read]), {
    result: 'ready',
    calls: ['reconnect', 'discover'],
  });
  // A second unconnected end stops, and a failed connection is never sent again.
  assert.deepEqual(await follow([idle, idle]), { result: 'stopped', calls: ['reconnect'] });
  assert.deepEqual(await follow([setup({ operation: null, reason: 'connection-unavailable' })]), {
    result: 'stopped',
    calls: [],
  });
});

test('Local connect saves token mode wherever it can and no-token mode where token mode is refused', async () => {
  const run = async (saved: LocalSetup, endpoint: string, refuses: boolean) => {
    const sent: string[] = [];
    const result = await connectLocalFlow({
      setup: saved,
      endpoint,
      active: () => true,
      command: async (input) => {
        sent.push(
          input.command === 'ConfigureLocal'
            ? `ConfigureLocal ${(input.payload as { authMode: string }).authMode}`
            : input.command,
        );
        return input.command === 'ConfigureLocal' &&
          refuses &&
          (input.payload as { authMode: string }).authMode === 'token'
          ? { outcome: 'blocked', reason: 'local-token-needs-macos' }
          : { outcome: 'applied', revision: 2 };
      },
    });
    return { kind: result.kind, sent };
  };
  const saved = setup({ operation: null });
  const none = setup({ operation: null, authMode: 'none' });
  // On a Mac: the saved token mode connects as it is, and a saved no-token mode moves to token.
  assert.deepEqual(await run(saved, saved.endpoint as string, false), {
    kind: 'started',
    sent: ['BeginLocalConnectionInput'],
  });
  assert.deepEqual(await run(none, none.endpoint as string, false), {
    kind: 'started',
    sent: ['ConfigureLocal token', 'BeginLocalConnectionInput'],
  });
  // Where token mode is refused, a saved no-token endpoint connects, and a new one saves none.
  assert.deepEqual(await run(none, none.endpoint as string, true), {
    kind: 'started',
    sent: ['ConfigureLocal token', 'BeginLocalConnectionInput'],
  });
  assert.deepEqual(await run(none, none.endpoint as string, true), {
    kind: 'started',
    sent: ['BeginLocalConnectionInput'],
  });
  assert.deepEqual(await run(none, 'ws://127.0.0.1:5678', true), {
    kind: 'started',
    sent: ['ConfigureLocal none', 'BeginLocalConnectionInput'],
  });
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
  // A controller notice replaces the generic line for the reason and yields to an action message.
  const noticed = { reason: 'capability-unavailable' as const, notice: 'Use no authentication.' };
  assert.equal(line({ setup: noticed }), 'Use no authentication.');
  assert.equal(line({ setup: noticed, message: 'Retrying.' }), 'Retrying.');
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

// Claim: the card follows its own model read for as long as the controller runs it, so a slow
// runtime never leaves the read on screen as an owned operation, and the follow still ends.
test('a background model read is followed past ten seconds and stops at its deadline', async () => {
  let clock = 0;
  let reads = 0;
  const running = { operation: { kind: 'discovery', state: 'owned' } } as Pick<
    LocalSetup,
    'operation'
  >;
  // A read that ends after 18 seconds, read every half second.
  const ended = await followDiscovery({
    read: async () => {
      reads++;
      return clock >= 18_000 ? { operation: null } : running;
    },
    wait: async () => {
      clock += 500;
    },
    active: () => true,
    now: () => clock,
  });
  assert.equal(ended, true);
  assert.equal(clock, 18_000);
  assert.equal(reads, 37);
  // A read that never ends stops at the follow time, and a closed card stops at once.
  clock = 0;
  assert.equal(
    await followDiscovery({
      read: async () => running,
      wait: async () => {
        clock += 500;
      },
      active: () => true,
      now: () => clock,
    }),
    false,
  );
  assert.equal(clock, DISCOVERY_FOLLOW_MS);
  assert.equal(
    await followDiscovery({ read: async () => running, wait: async () => {}, active: () => false }),
    false,
  );
});

test('the Local card shows only the notices that describe the current state', () => {
  const observation = {} as LocalSetup['observation'];
  const connected = setup({
    operation: null,
    connected: true,
    connectedWithoutToken: true,
    observation,
    observationStale: true,
  });
  const read = setup({
    operation: null,
    connected: true,
    connectedWithoutToken: true,
    observation,
  });
  const notices = (change: Partial<Parameters<typeof localNotices>[0]>) =>
    localNotices({
      setup: connected,
      message: null,
      following: false,
      reading: false,
      connected: true,
      stamp: 'Last seen just now.',
      ...change,
    });
  // While a Connect follows a new connection, only the waiting line shows.
  assert.deepEqual(notices({ message: WAITING_LINE, following: true }), {
    message: WAITING_LINE,
    stamp: null,
    withoutToken: false,
  });
  // Once the models are read, the waiting line goes and the no-token line is the one left.
  assert.deepEqual(notices({ setup: read, message: WAITING_LINE, following: true, stamp: null }), {
    message: null,
    stamp: null,
    withoutToken: true,
  });
  // A follow that stopped leaves no waiting line either.
  assert.equal(notices({ message: WAITING_LINE }).message, null);
  // The reading line lasts as long as the read it is about.
  assert.equal(notices({ message: READING_LINE, reading: true }).message, READING_LINE);
  assert.equal(notices({ message: READING_LINE }).message, null);
  // A line from an action stays.
  assert.equal(notices({ message: 'Disconnect confirmed.' }).message, 'Disconnect confirmed.');
  // Offline, the cached list keeps its age.
  assert.deepEqual(
    notices({
      setup: { ...connected, connected: false },
      connected: false,
      stamp: 'Last seen 2 h ago. Not connected.',
    }),
    { message: null, stamp: 'Last seen 2 h ago. Not connected.', withoutToken: false },
  );
});
