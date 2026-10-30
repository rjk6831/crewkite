import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCAL_SERVER_WANTS_TOKEN, LOCAL_TOKEN_SETUP_NOTICE } from '../providers/platform.ts';
import { setup } from '../store/controller-fixture.ts';

// Claim: the setup carries the controller's own line, so the card shows what to do in place of
// the generic reason, and the line follows what the runtime answered, never the platform alone.
test('on Linux, the setup names a runtime that asks for a token and clears when it answers open', async (t) => {
  let answer: 'token-required' | 'open' | 'unavailable' = 'token-required';
  const { controller, command } = await setup(t, {
    localInput: { platform: 'linux', arch: 'x64' },
    localProbe: async () => answer,
  });
  const state = () => controller.snapshot().localSetup;
  const local = (name: string, payload: object = {}) =>
    controller.execute(command(name, payload, state()?.revision ?? 0), 'local-owner');
  const settle = () =>
    (controller as unknown as { localOperation?: { done: Promise<void> } }).localOperation?.done;
  const connect = async () => {
    assert.equal(
      (await local('BeginLocalConnectionInput', { consent: 'explicit' })).outcome,
      'applied',
    );
    await settle();
  };
  const endpoint = 'ws://127.0.0.1:12345';
  await local('ConfigureLocal', { endpoint, authMode: 'none' });
  assert.equal(state()?.notice, undefined, 'nothing is said before a connect asks');

  await connect();
  assert.equal(state()?.operation, null, 'no token window opens and the operation ends');
  assert.equal(state()?.connected, false);
  assert.equal(state()?.notice, LOCAL_SERVER_WANTS_TOKEN);

  // A runtime that is merely down gets no token line.
  answer = 'unavailable';
  await connect();
  assert.equal(state()?.notice, undefined);

  answer = 'token-required';
  await connect();
  assert.equal(state()?.notice, LOCAL_SERVER_WANTS_TOKEN);
  answer = 'open';
  await connect();
  assert.equal(state()?.connected, true);
  assert.equal(state()?.notice, undefined);

  // A new connection revision drops the line with the connection it described.
  answer = 'token-required';
  await local('DisconnectLocal');
  await connect();
  assert.equal(state()?.notice, LOCAL_SERVER_WANTS_TOKEN);
  await local('ConfigureLocal', { endpoint: 'ws://127.0.0.1:12346', authMode: 'none' });
  assert.equal(state()?.notice, undefined);
});

test('a saved token mode on Linux shows the loopback and keychain line in place of the generic reason', async (t) => {
  const { controller, command } = await setup(t, {
    localInput: { platform: 'darwin', arch: 'arm64' },
  });
  const state = () => controller.snapshot().localSetup;
  await controller.execute(
    command('ConfigureLocal', { endpoint: 'ws://127.0.0.1:12345' }, state()?.revision ?? 0),
    'local-owner',
  );
  assert.equal(state()?.authMode, 'token');
  assert.equal(state()?.notice, undefined, 'a Mac has no such line');
  // The same saved setup read on a Linux host.
  (controller as unknown as { options: { localInput: object } }).options.localInput = {
    platform: 'linux',
    arch: 'x64',
  };
  assert.equal(state()?.reason, 'capability-unavailable');
  assert.equal(state()?.notice, LOCAL_TOKEN_SETUP_NOTICE);
});
