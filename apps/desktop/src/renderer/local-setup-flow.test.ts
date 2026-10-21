import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalSetup } from '@crewkite/contracts';
import { connectLocalFlow, waitForLocalReadiness } from './local-setup-flow.ts';

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
});
