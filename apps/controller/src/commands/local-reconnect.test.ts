import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from '../store/controller-fixture.ts';
import { opensTokenWindow } from './providers.ts';

// Claim: a no-token answer from the runtime outlives a connect that fails while the runtime is
// down, so Local can reconnect on its own when it returns. A runtime that now wants a token, a
// Disconnect and a new endpoint each end that answer, and an unattended connect never opens the
// token window.
test('a runtime that answered with no token stays eligible to reconnect while it is down', async (t) => {
  let answer: 'token-required' | 'open' | 'unavailable' = 'open';
  const { controller, command } = await setup(t, {
    localInput: { platform: 'darwin', arch: 'arm64' },
    // Token mode needs a helper on record. No test here reaches the token window.
    localInputHelper: {
      root: process.cwd(),
      sha256: 'a'.repeat(64),
      sourceHash: 'b'.repeat(64),
      target: 'darwin-arm64',
    },
    localProbe: async () => answer,
  });
  const state = () => controller.snapshot().localSetup;
  const local = (name: string, payload: object = {}) =>
    controller.execute(command(name, payload, state()?.revision ?? 0), 'local-owner');
  const settle = () =>
    (controller as unknown as { localOperation?: { done: Promise<void> } }).localOperation?.done;
  const connect = async (unattended = false) => {
    const started = await local('BeginLocalConnectionInput', {
      consent: 'explicit',
      ...(unattended ? { unattended: true } : {}),
    });
    assert.equal(started.outcome, 'applied', JSON.stringify(started));
    await settle();
  };
  await local('ConfigureLocal', { endpoint: 'ws://127.0.0.1:12345' });
  assert.equal(state()?.authMode, 'token');
  assert.equal(state()?.reconnectsWithoutToken, undefined, 'never connected, nothing to reuse');

  await connect();
  assert.equal(state()?.connected, true);
  assert.equal(state()?.reconnectsWithoutToken, true);

  // The runtime quits. Each reconnect try fails and clears the connection mark, not the answer.
  answer = 'unavailable';
  await connect(true);
  await connect(true);
  assert.equal(state()?.connected, false);
  assert.equal(state()?.reason, 'connection-unavailable');
  assert.equal(state()?.connectedWithoutToken, undefined);
  assert.equal(state()?.reconnectsWithoutToken, true);

  // It returns, and an unattended connect gets it back with no token.
  answer = 'open';
  await connect(true);
  assert.equal(state()?.connected, true);

  // It returns wanting a token: no window opens for an unattended connect, and the answer ends.
  answer = 'unavailable';
  await connect(true);
  answer = 'token-required';
  await connect(true);
  assert.equal(state()?.operation, null, 'no token window');
  assert.equal(state()?.connected, false);
  assert.equal(state()?.reconnectsWithoutToken, undefined);

  // Disconnect and a new endpoint leave an earlier answer behind.
  answer = 'open';
  await connect();
  assert.equal(state()?.reconnectsWithoutToken, true);
  await local('DisconnectLocal');
  assert.equal(state()?.reconnectsWithoutToken, undefined);
  await connect();
  assert.equal(state()?.reconnectsWithoutToken, true);
  await local('ConfigureLocal', { endpoint: 'ws://127.0.0.1:12346' });
  assert.equal(state()?.reconnectsWithoutToken, undefined);
});

// Claim: only a person at the window gets the token window, and only when the runtime asked for a
// token this computer can take and none was supplied.
test('an unattended connect never opens the token window', () => {
  const base = { supplied: false, unattended: false, refused: false };
  assert.equal(opensTokenWindow('token-required', base), true);
  assert.equal(opensTokenWindow('token-required', { ...base, unattended: true }), false);
  assert.equal(opensTokenWindow('token-required', { ...base, supplied: true }), false);
  assert.equal(opensTokenWindow('token-required', { ...base, refused: true }), false);
  for (const found of ['open', 'unavailable', 'timeout'])
    assert.equal(opensTokenWindow(found, base), false, found);
});

// Claim: a setup saved by a build that kept the no-token answer only in `connectedWithoutToken`
// reconnects on its own after the runtime restarts. A launch reads it as connected with no probe,
// so the first failed read, and every failed try while the runtime is down, must keep the answer.
// A saved setup that never found the runtime open stays ineligible.
test('a no-token setup saved by an earlier build reconnects after the runtime restarts', async (t) => {
  let answer: 'token-required' | 'open' | 'unavailable' = 'open';
  const { controller, command } = await setup(t, {
    localInput: { platform: 'darwin', arch: 'arm64' },
    localInputHelper: {
      root: process.cwd(),
      sha256: 'a'.repeat(64),
      sourceHash: 'b'.repeat(64),
      target: 'darwin-arm64',
    },
    localProbe: async () => answer,
  });
  const state = () => controller.snapshot().localSetup;
  const local = (name: string, payload: object = {}) =>
    controller.execute(command(name, payload, state()?.revision ?? 0), 'local-owner');
  const settle = () =>
    (controller as unknown as { localOperation?: { done: Promise<void> } }).localOperation?.done;
  const connect = async () => {
    const started = await local('BeginLocalConnectionInput', {
      consent: 'explicit',
      unattended: true,
    });
    assert.equal(started.outcome, 'applied', JSON.stringify(started));
    await settle();
  };
  const internals = controller as unknown as {
    localControl: () => Record<string, unknown>;
    saveLocal: (control: Record<string, unknown>) => unknown;
  };
  await local('ConfigureLocal', { endpoint: 'ws://127.0.0.1:12345' });
  const configured = controller.store.localControl() as Record<string, unknown>;
  const { openProbeRevision: _dropped, ...earlier } = configured;
  // Two saved shapes: one written before the field existed, and the one a launch of the next build
  // wrote back with the field at its default.
  for (const saved of [
    { ...earlier, connectedWithoutToken: true },
    { ...earlier, connectedWithoutToken: true, openProbeRevision: null },
  ]) {
    answer = 'open';
    controller.store.transaction(() => controller.store.putLocalControl(saved));
    assert.equal(state()?.connected, true, 'the launch reads it as connected');
    assert.equal(state()?.reconnectsWithoutToken, true);

    // The runtime quits. The next model read fails and clears the connection mark.
    answer = 'unavailable';
    controller.store.transaction(() =>
      internals.saveLocal({
        ...internals.localControl(),
        connectedWithoutToken: undefined,
        connectionFailed: true,
      }),
    );
    assert.equal(state()?.connected, false);
    assert.equal(state()?.reconnectsWithoutToken, true, 'a failed read keeps the answer');

    // Unattended tries fail while it is down and keep the answer.
    await connect();
    await connect();
    assert.equal(state()?.connected, false);
    assert.equal(state()?.reconnectsWithoutToken, true);

    // It returns, and an unattended connect gets it back with no token and no window.
    answer = 'open';
    await connect();
    assert.equal(state()?.operation, null);
    assert.equal(state()?.connected, true);
    assert.equal(state()?.reconnectsWithoutToken, true);
  }

  // A saved setup whose last probe wanted a token, or that never probed, has nothing to reuse.
  for (const saved of [{ ...earlier, connectedWithoutToken: false }, { ...earlier }]) {
    controller.store.transaction(() => controller.store.putLocalControl(saved));
    assert.equal(state()?.reconnectsWithoutToken, undefined);
  }

  // A runtime that now wants a token ends a migrated answer, and no window opens unattended.
  controller.store.transaction(() =>
    controller.store.putLocalControl({ ...earlier, connectedWithoutToken: true }),
  );
  answer = 'token-required';
  await connect();
  assert.equal(state()?.operation, null, 'no token window');
  assert.equal(state()?.connected, false);
  assert.equal(state()?.reconnectsWithoutToken, undefined);

  // Disconnect leaves a migrated answer behind.
  controller.store.transaction(() =>
    controller.store.putLocalControl({ ...earlier, connectedWithoutToken: true }),
  );
  await local('DisconnectLocal');
  assert.equal(state()?.reconnectsWithoutToken, undefined);
});
