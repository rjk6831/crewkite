import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  type NativeProfileResolution,
  unavailableNativeProfile,
} from '../providers/openai/profile.ts';
import { fixture, fixtureModel } from '../providers/openai/replacement-fixture.ts';
import { fixtureClientHash, setup } from '../store/controller-fixture.ts';

const profile = {
  ...unavailableNativeProfile(),
  facts: {
    ...unavailableNativeProfile().facts,
    available: true,
    reason: 'available',
    model: fixtureModel,
    clientVersion: process.version,
  },
  client: { executable: process.execPath, version: process.version, sha256: fixtureClientHash },
  environment: {},
  locationHash: '1'.repeat(64),
} satisfies NativeProfileResolution;

// A client that answers the quota read, so the read lands and no retry waits.
const answering = fixture.replace(
  '  let result = replies[message.method];',
  `  let result = message.method === 'account/rateLimits/read'
    ? { rateLimits: {}, rateLimitsByLimitId: { ordinary: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1792231983 } } } }
    : replies[message.method];`,
);

// Every client start the controller makes on its own, counted by the reader that made it.
async function launchFixture(t: Parameters<typeof setup>[0]) {
  mkdirSync(resolve('internal'), { recursive: true });
  const person = mkdtempSync(join(resolve('internal'), 'connect-account-'));
  const home = join(person, 'home');
  const ownProfile = { ...profile, environment: { HOME: person, CREWKITE_HOME: home } };
  const started: string[] = [];
  const context = await setup(t, {
    home,
    // The chat path's profile, so a catalog read would start a model read.
    nativeProfiles: () => [ownProfile],
    nativeSpawn: (executable, args, options) => {
      const phase = args.at(-1) === 'list' ? 'features' : 'app-server';
      started.push(`models ${phase}`);
      return spawn(executable, ['-e', fixture, 'success', phase], options);
    },
    googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
    openAiUsageClient: () => ownProfile,
    registerGoogleAcp: true,
    schedule: () => () => {},
    openAiUsageSpawn: (executable, args, options) => {
      started.push(`usage ${args.at(-1) === 'list' ? 'features' : 'app-server'}`);
      return spawn(
        executable,
        ['-e', answering, 'success', args.at(-1) === 'list' ? 'features' : 'prepare'],
        options,
      );
    },
  });
  t.after(() => rmSync(person, { recursive: true, force: true }));
  const launch = async () => {
    await context.controller.refreshUsage('start');
    await context.controller.refreshUsage('connect');
    await context.controller.refreshUsage('interval');
    await context.controller.execute(
      context.command('ReadChatCatalog', {}) as never,
      'local-owner',
    );
    await context.controller.prepareGoogleAcp();
    await context.controller.openAiUsageRead?.done;
    // The model read waits for the quota read, then starts on its own.
    await new Promise((resolve) => setImmediate(resolve));
    await context.controller.openAiModelReadSettled();
  };
  return { ...context, started, launch };
}

test('no provider starts at launch before the person connected it on this device', async (t) => {
  const context = await launchFixture(t);
  const { controller } = context;
  await context.launch();
  assert.deepEqual(context.started, []);
  assert.equal(controller.openAiUsageState(), null, 'no quota read was even recorded');
  assert.equal(controller.googleAcpPreparationStep(), null);
  const connections = controller.workspaceState().providerConnections;
  assert.deepEqual(connections?.connectedOnce, []);
  assert.equal(connections?.openAiSignIn.state, 'idle');
});

test('a provider connected once reconnects at every later launch with no command', async (t) => {
  const context = await launchFixture(t);
  const { controller } = context;
  controller.store.transaction(() => controller.store.markConnectedOnce('openai'));
  await context.launch();
  assert.ok(context.started.includes('usage app-server'), 'the quota read ran at launch');
  assert.ok(context.started.includes('models app-server'), 'the model read ran at launch');
  assert.equal(controller.openAiUsageState()?.state, 'quiescent');
  assert.deepEqual(controller.workspaceState().providerConnections?.connectedOnce, ['openai']);
  // Sign-out ends it, so the launch after it asks again.
  const signedOut = await controller.execute(
    context.command('SignOutOpenAi', {}, 0) as never,
    'local-owner',
  );
  assert.equal(signedOut.outcome, 'applied');
  assert.equal(controller.store.hasConnectedOnce('openai'), false);
});
