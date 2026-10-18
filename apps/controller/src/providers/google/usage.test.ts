import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ObservationSchema } from '@crewkite/contracts';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import {
  GoogleWriterError,
  googleUsageObservations,
  projectGoogleUsage,
  startGoogleUsage,
} from './native-writer.ts';
import { googleUsageDescriptor, resolveGoogleUsageClient } from './profile.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// Synthetic values retain the five window IDs observed from the pinned client on
// 18 October 2026. Shared buckets must deduplicate without model-group inference.
const bucket = (id: string, remaining: number, reset: string) => ({
  id,
  name: 'private-name',
  window: 'private-window',
  remaining_fraction: remaining,
  reset_time: reset,
});
const weekly = bucket('gemini-weekly', 0.8, '2026-10-23T14:13:03Z');
const rolling = bucket('gemini-5h', 0.3, '2026-10-16T19:13:03Z');
const thirdPartyWeekly = bucket('3p-weekly', 0.7, '2026-10-23T14:13:03Z');
const thirdPartyRolling = bucket('3p-5h', 0.6, '2026-10-16T19:13:03Z');
const argon = bucket('gemini-argon-wtu-weekly', 1, '2026-10-23T14:13:03Z');
const report = {
  status: 'SUCCESS',
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description: 'private-description',
      groups: [
        { name: 'private-group', buckets: [weekly, rolling] },
        { name: 'private-group', buckets: [weekly, rolling] },
        { name: 'private-group', buckets: [thirdPartyWeekly, thirdPartyRolling] },
        { name: 'private-group', buckets: [argon] },
      ],
    },
  },
};
const projected: ReturnType<typeof projectGoogleUsage> = [
  {
    windowId: 'gemini-weekly',
    kind: 'weekly',
    semantics: { scope: 'provider', periodSeconds: 604800 },
    remainingPercent: 80,
    resetsAt: '2026-10-23T14:13:03.000Z',
  },
  {
    windowId: 'gemini-5h',
    kind: 'rolling',
    semantics: { scope: 'provider', periodSeconds: 18000 },
    remainingPercent: 30,
    resetsAt: '2026-10-16T19:13:03.000Z',
  },
  {
    windowId: '3p-weekly',
    kind: 'weekly',
    remainingPercent: 70,
    resetsAt: '2026-10-23T14:13:03.000Z',
  },
  {
    windowId: '3p-5h',
    kind: 'rolling',
    remainingPercent: 60,
    resetsAt: '2026-10-16T19:13:03.000Z',
  },
  {
    windowId: 'gemini-argon-wtu-weekly',
    kind: 'weekly',
    semantics: { scope: 'model', periodSeconds: 604800 },
    remainingPercent: 100,
    resetsAt: '2026-10-23T14:13:03.000Z',
  },
];

test('the google quota read maps zero-turn account buckets to window observations and refuses anything else', async () => {
  assert.deepEqual(projectGoogleUsage(Buffer.from(JSON.stringify(report))), projected);
  assert.deepEqual(
    projectGoogleUsage(
      Buffer.from(
        JSON.stringify({
          ...report,
          command: { data: { groups: [{ buckets: [bucket('flash-model', 0.123456, reset())] }] } },
        }),
      ),
    ),
    [{ windowId: 'flash-model', kind: 'model', remainingPercent: 12.3456, resetsAt: reset() }],
  );
  const groups = (buckets: unknown[]) => ({
    ...report,
    command: { data: { groups: [{ buckets }] } },
  });
  for (const id of ['future-weekly', 'future-5h', 'gemini-weekly-pool', 'Gemini-5h']) {
    const [projected] = projectGoogleUsage(
      Buffer.from(JSON.stringify(groups([bucket(id, 0.5, reset())]))),
    );
    assert(projected);
    assert.equal(Object.hasOwn(projected, 'semantics'), false, id);
    const [observation] = googleUsageObservations(
      [projected],
      ['rte_01M51M322B2AEBXD9MA74CBCFM'],
      reset(),
    );
    assert(observation);
    assert.equal(Object.hasOwn(observation, 'semantics'), false, id);
  }
  for (const invalid of [
    { ...report, num_turns: 1 },
    { ...report, status: 'ERROR' },
    ...[
      'input_tokens',
      'output_tokens',
      'thinking_tokens',
      'cache_read_tokens',
      'total_tokens',
    ].map((field) => ({ ...report, usage: { ...report.usage, [field]: 1 } })),
    { ...report, usage: { ...report.usage, future_tokens: 1 } },
    groups([]),
    groups([{ ...weekly, remaining_fraction: 1.2 }]),
    groups([{ ...weekly, remaining_fraction: -0.1 }]),
    groups([{ ...weekly, reset_time: 'tomorrow' }]),
    groups([weekly, { ...weekly, remaining_fraction: 0.5 }]),
    groups([
      { ...weekly, remaining_fraction: 0.800001 },
      { ...weekly, remaining_fraction: 0.800002 },
    ]),
    groups([
      { ...weekly, remaining_fraction: 0.0013 },
      { ...weekly, remaining_fraction: 0.0013000000000000002 },
    ]),
    groups([{ ...weekly, id: '' }]),
    groups(Array(33).fill(weekly)),
  ])
    assert.throws(
      () => projectGoogleUsage(Buffer.from(JSON.stringify(invalid))),
      GoogleWriterError,
    );
  for (const bytes of [Buffer.from('private-canary'), Buffer.alloc(262145, 0x7b)])
    assert.throws(
      () => projectGoogleUsage(bytes),
      (error) => error instanceof GoogleWriterError && !error.message.includes('private'),
    );

  const routes = ['rte_01M51M322B2AEBXD9MA74CBCFM', 'rte_01M51M322B2AEBXD9MA74CBCFN'];
  const observations = googleUsageObservations(projected, routes, reset());
  assert.equal(observations.length, 10);
  for (const observation of observations) ObservationSchema.parse(observation);
  assert.deepEqual(observations[1], {
    routeId: routes[0],
    windowId: 'gemini-5h',
    kind: 'rolling',
    semantics: { scope: 'provider', periodSeconds: 18000 },
    remaining: { value: 30, unit: 'percent' },
    resetsAt: '2026-10-16T19:13:03.000Z',
    observedAt: reset(),
    source: 'client',
    confidence: 'reported',
  });
  assert.deepEqual(googleUsageObservations(projected, [], reset()), []);

  mkdirSync(resolve('internal'), { recursive: true });
  const home = mkdtempSync(resolve('internal/google-usage-'));
  const directory = join(home, 'scratch');
  const runtime = join(home, 'runtime');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  const executable = join(runtime, 'fixture');
  writeFileSync(executable, `#!${process.execPath}\n`, { mode: 0o700 });
  const client = { executable, version: '1.4.1', sha256: hash(readFileSync(executable)) };
  const environment = { ...process.env, HOME: userInfo().homedir };
  const groupsSeen: number[] = [];
  try {
    for (const row of ['success', 'unexpected-turn', 'nonzero'] as const) {
      const events: string[] = [];
      const output = row === 'unexpected-turn' ? { ...report, num_turns: 1 } : report;
      const script = `process.stdout.write(${JSON.stringify(JSON.stringify(output))});${row === 'nonzero' ? 'process.exitCode=1;' : ''}`;
      const handle = startGoogleUsage({
        client,
        repositoryRoot: resolve('.'),
        directory,
        temporaryDirectory: runtime,
        timeoutMs: 3000,
        environment: {
          ...environment,
          GOOGLE_API_KEY: 'private-canary',
          AGY_CLI_DISABLE_AUTO_UPDATE: 'false',
        },
        spawn: (_, args, options) => {
          assert.deepEqual(args.slice(0, 4), ['-p', '/usage', '--output-format', 'json']);
          assert(!('GOOGLE_API_KEY' in (options?.env ?? {})));
          assert.equal(options?.env?.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
          events.push('spawn');
          const child = spawn(process.execPath, ['-e', script], options);
          if (child.pid) groupsSeen.push(child.pid);
          return child;
        },
        lifecycle: {
          beforePhase: (phase) => {
            assert.equal(phase, 'config');
            events.push('intent');
          },
          owned: (_, group) => {
            assert(group > 0);
            events.push('owned');
          },
          quiescent: (_, group) => {
            assert(groupAbsent(group));
            events.push('quiescent');
          },
        },
      });
      const outcome = await handle.result;
      assert.equal(outcome.quiescent, true, row);
      assert(groupAbsent(handle.group));
      assert.deepEqual(events, ['intent', 'spawn', 'owned', 'quiescent']);
      if (row === 'success') {
        assert.equal(outcome.reason, null);
        assert.deepEqual(outcome.metadata, projected);
      } else {
        assert.equal(outcome.metadata, null);
        assert(outcome.reason, row);
        assert(!JSON.stringify(outcome).includes('private'));
      }
    }

    // Client discovery never executes the client or reads account files.
    assert.equal(googleUsageDescriptor.clientVersion, '1.4.1');
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      assert.deepEqual(resolveGoogleUsageClient(environment), {
        available: false,
        reason: 'unsupported-platform',
      });
    } else {
      assert.equal(
        resolveGoogleUsageClient({ ...environment, HOME: home }).reason,
        'native-home-unavailable',
      );
      const bin = join(home, 'bin');
      mkdirSync(bin, { mode: 0o700 });
      assert.equal(
        resolveGoogleUsageClient({ HOME: environment.HOME }, [bin]).reason,
        'client-unavailable',
      );
      writeFileSync(join(bin, 'agy'), 'private-canary', { mode: 0o700 });
      const mismatch = resolveGoogleUsageClient({ HOME: environment.HOME }, [bin]);
      assert.equal(mismatch.reason, 'client-build-mismatch');
      assert(!JSON.stringify(mismatch).includes('private'));
    }
  } finally {
    assert(groupsSeen.every(groupAbsent), 'every fixture group must be absent before cleanup');
    rmSync(home, { recursive: true, force: true });
  }
});

function reset() {
  return '2026-10-16T19:13:03.000Z';
}
