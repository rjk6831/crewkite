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
