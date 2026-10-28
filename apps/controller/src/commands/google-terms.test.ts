import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GOOGLE_TERMS_VERSION } from '@crewkite/contracts';
import { setup } from '../store/controller-fixture.ts';
import { googleTermsGate } from './google-terms.ts';

// Claim (ADR 0002): the controller, not the Connect button, keeps a Google connection step from
// running until the person acknowledged the current text. The acknowledgement carries its time
// and text version, and a changed text asks again.
test('a Google connection step is refused until the current terms are acknowledged', async (t) => {
  const { controller, command, clock } = await setup(t);
  const connect = async () =>
    controller.execute(
      command('InitializeGoogleAcp', { profileId: 'google-acp-v1', consent: 'explicit' }, 0),
      'local-owner',
    );
  const acknowledge = async (textVersion: string) =>
    controller.execute(command('AcknowledgeGoogleTerms', { textVersion }, 0), 'local-owner');
  const refused = (result: { reason?: string }) =>
    result.reason === 'google-terms-not-acknowledged';

  assert.ok(refused(await connect()), 'a first connection without an acknowledgement is refused');
  const usage = () =>
    controller.execute(command('ObserveUsage', { family: 'google' }, 0), 'local-owner');
  assert.ok(refused(await usage()), 'a Google usage read is refused too');
  assert.equal(controller.refreshGoogleUsage('start'), undefined, 'so is a start-up read');
  const prepare = { command: 'PrepareNativeRun', payload: { profileId: 'google-acp-v1' } } as never;
  const start = { command: 'StartRun', payload: { runId: 'run_x' } } as never;
  assert.ok(refused(googleTermsGate(controller.store, prepare, () => false) ?? {}), 'prepare');
  assert.ok(refused(googleTermsGate(controller.store, start, () => true) ?? {}), 'start');
  assert.equal(
    googleTermsGate(controller.store, start, () => false),
    undefined,
    'not Google',
  );
  assert.equal((await acknowledge('0000-00-00')).outcome, 'blocked', 'an old text is not stored');
  assert.equal(controller.store.googleAcpSetup().googleTerms, null);

  assert.equal((await acknowledge(GOOGLE_TERMS_VERSION)).outcome, 'applied');
  assert.deepEqual(controller.store.googleAcpSetup().googleTerms, {
    version: GOOGLE_TERMS_VERSION,
    at: clock.now(),
  });
  assert.equal(
    googleTermsGate(controller.store, start, () => true),
    undefined,
    'start passes',
  );
  assert.ok(!refused(await connect()), 'the current acknowledgement lets the step reach setup');

  const setupRecord = controller.store.googleAcpSetup();
  controller.store.transaction(() =>
    controller.store.putGoogleAcpSetup({
      ...setupRecord,
      googleTerms: { version: '0000-00-00', at: clock.now() },
    }),
  );
  assert.ok(refused(await connect()), 'a text change asks again');
});
