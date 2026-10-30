import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCAL_TOKEN_NEEDS_MACOS } from '../providers/platform.ts';
import { setup } from '../store/controller-fixture.ts';

// Claim (ADR 0013, amendment of 2026-10-31): on Linux the Local family takes the no-auth loopback
// mode, and token mode is refused with one line wherever a token could enter, before any helper
// or window is looked for.
test('on Linux, Local connects in no-authentication mode and refuses token mode with the keychain line', async (t) => {
  const { controller, command } = await setup(t, {
    localInput: { platform: 'linux', arch: 'x64' },
    localProbe: async () => true,
  });
  const revision = () => controller.snapshot().localSetup?.revision ?? 0;
  const local = (name: string, payload: object = {}) =>
    controller.execute(command(name, payload, revision()), 'local-owner');
  const endpoint = 'ws://127.0.0.1:12345';

  // The command schema defaults the mode to token, so a bare configure meets the refusal.
  for (const payload of [{ endpoint }, { endpoint, authMode: 'token' }]) {
    const refused = await local('ConfigureLocal', payload);
    assert.equal(refused.outcome, 'blocked');
    assert.equal(refused.reason, 'local-token-needs-macos');
    assert.equal(refused.next, LOCAL_TOKEN_NEEDS_MACOS);
  }
  assert.equal(controller.snapshot().localSetup?.endpoint ?? null, null, 'nothing was saved');

  assert.equal((await local('ConfigureLocal', { endpoint, authMode: 'none' })).outcome, 'applied');
  assert.equal(controller.snapshot().localSetup?.authMode, 'none');
  assert.equal(
    (await local('BeginLocalConnectionInput', { consent: 'explicit' })).outcome,
    'applied',
  );
  await (controller as unknown as { localOperation?: { done: Promise<void> } }).localOperation
    ?.done;
  const connected = controller.snapshot().localSetup;
  assert.equal(connected?.connected, true);
  assert.equal(connected?.connectedWithoutToken, true);
  assert.equal(connected?.secretConfigured, false);

  // A desktop-supplied remembered token meets the same line.
  const supplied = await controller.execute(
    {
      ...command('SupplyLocalToken', { token: 'synthetic-token-0001' }),
      actor: { id: 'desktop', kind: 'desktop' },
    },
    'local-owner',
  );
  assert.equal(supplied.outcome, 'blocked');
  assert.equal(supplied.reason, 'local-token-needs-macos');
  assert.equal(supplied.next, LOCAL_TOKEN_NEEDS_MACOS);
  assert.equal(controller.snapshot().localSetup?.secretConfigured, false);
});
