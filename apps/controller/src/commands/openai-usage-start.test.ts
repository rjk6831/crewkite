import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { test } from 'node:test';
import type { Observation } from '@crewkite/contracts';
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
  environment: { ...process.env },
  locationHash: '1'.repeat(64),
} satisfies NativeProfileResolution;

const answering = fixture.replace(
  '  let result = replies[message.method];',
  `  let result = message.method === 'account/rateLimits/read'
    ? { rateLimits: {}, rateLimitsByLimitId: { ordinary: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1792231983 } } } }
    : replies[message.method];`,
);

// The quota read's timers run when the test says, so a 20 s deadline and the retries cost nothing.
async function startReadFixture(t: Parameters<typeof setup>[0], silentReads: number) {
  const timers = new Set<{ run: () => void; ms: number }>();
  const reads: ChildProcess[] = [];
  let launched = Promise.withResolvers<void>();
  const context = await setup(t, {
    googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
    openAiUsageClient: () => profile,
    schedule: (run, ms) => {
      const timer = { run, ms };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    openAiUsageSpawn: (executable, args, options) => {
      const phase = args.at(-1) === 'list' ? 'features' : 'prepare';
      // A client that never answers its app-server stands in for one starved at launch.
      const silent = phase === 'prepare' && reads.length < silentReads;
      const child = spawn(
        executable,
        silent ? ['-e', 'setInterval(() => {}, 1 << 30)'] : ['-e', answering, 'success', phase],
        options,
      );
      if (phase === 'prepare') {
        reads.push(child);
        launched.resolve();
      }
      return child;
    },
  });
  const fire = (match: (ms: number) => boolean) => {
    for (const timer of [...timers])
      if (match(timer.ms)) {
        timers.delete(timer);
        timer.run();
      }
  };
  const nextLaunch = async () => {
    await launched.promise;
    launched = Promise.withResolvers<void>();
  };
  return { ...context, reads, fire, nextLaunch, pending: () => [...timers].map((v) => v.ms) };
}

test('the quota read waits for the first OpenAI connect on this device', async (t) => {
  const context = await startReadFixture(t, 0);
  const { controller } = context;
  assert.equal(controller.store.hasConnectedOnce('openai'), false);
  for (const trigger of ['start', 'connect', 'interval'] as const)
    await controller.refreshOpenAiUsageWithRetry(trigger);
  assert.equal(context.reads.length, 0, 'no client starts before Connect');
  assert.equal(controller.openAiUsageState(), null);

  // The person's own read is the connect. It runs, and the launch read runs from then on.
  const read = await controller.execute(
    context.command('ObserveUsage', { family: 'openai' }, 0) as never,
    'local-owner',
  );
  assert.equal(read.outcome, 'applied');
  assert.equal(controller.store.hasConnectedOnce('openai'), true);
  assert.equal(context.reads.length, 1);
  context.clock.advance(300000);
  await controller.refreshOpenAiUsageWithRetry('start');
  assert.equal(context.reads.length, 2);
});

test('a start read that runs out of time reads again and fills the gauge', async (t) => {
  const context = await startReadFixture(t, 1);
  const { controller } = context;
  controller.store.transaction(() => controller.store.markConnectedOnce('openai'));
  const started = controller.refreshOpenAiUsageWithRetry('start');
  await context.nextLaunch();
  const first = controller.openAiUsageRead?.done;
  // The read's own 20 s deadline passes with no answer.
  context.fire((ms) => ms > 10000 && ms <= 20000);
  context.clock.advance(20000);
  await first;
  await new Promise((done) => setImmediate(done));
  assert.equal(controller.openAiUsageState()?.reason, 'deadline');
  assert.ok(context.pending().includes(5000), 'a read that ran out of time is retried');
  // The retry runs inside the 60 s cooldown that held it back before.
  context.fire((ms) => ms === 5000);
  await context.nextLaunch();
  await started;
  assert.equal(controller.openAiUsageState()?.reason, 'observed');
  const reader = controller
    .snapshot()
    .routes.find((route) => route.displayName === 'OpenAI usage reader');
  assert.ok(reader);
  const windows = controller.store
    .list<Observation>('window')
    .filter((value) => value.routeId === reader.id);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].remaining?.value, 75);
  assert.equal(context.reads.length, 2);
  assert.equal(context.pending().includes(30000), false, 'a read that worked stops the retries');
});
