import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleAcpSetupSchema } from '@crewkite/contracts';
import { acknowledgeGoogleTerms, setup } from '../store/controller-fixture.ts';

// The Google quota read starts the Google client. It waits for Connect, so nothing Google runs
// before the person connected it, and the rail shows Connect with no bars until then.
test('the Google quota read waits until Google is connected', async (t) => {
  let resolved = 0;
  const context = await setup(t, {
    googleUsageClient: () => {
      resolved++;
      return { available: false, reason: 'client-unavailable' };
    },
  });
  const { controller, command } = context;
  await acknowledgeGoogleTerms(context);
  const before = resolved;
  const read = await controller.execute(
    command('ObserveUsage', { family: 'google' }, 0) as never,
    'local-owner',
  );
  assert.equal(read.reason, 'google-not-connected');
  assert.equal(controller.refreshGoogleUsage('start'), undefined, 'no start-up read');
  assert.equal(controller.refreshGoogleUsage('connect'), undefined, 'no connect read');
  assert.equal(resolved, before, 'the reads stop before they look for the reader client');
  assert.deepEqual(controller.store.googleMetadataOperations(), [], 'no Google process ran');

  // A ready setup the person connected on this device reads, and the reads go ahead to the client.
  const current = controller.store.googleAcpSetup();
  controller.store.transaction(() => controller.store.markConnectedOnce('google'));
  controller.store.transaction(() =>
    controller.store.putGoogleAcpSetup(
      GoogleAcpSetupSchema.parse({
        ...current,
        revision: current.revision + 1,
        state: 'ready',
        proofId: 'art_01K7M1N2P3Q4R5S6T7V8W9X0YZ',
        client: { version: '1.4.0', sha256: 'a'.repeat(64), signerTeamId: 'EQHXZ8M8AV' },
        auth: { method: 'oauth-personal', status: 'authenticated' },
      }),
    ),
  );
  const connected = resolved;
  await controller.refreshGoogleUsage('start');
  assert.equal(resolved, connected + 1, 'the start-up read looks for the client once connected');
});
