import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AnthropicNativeProfileSchema } from '@crewkite/contracts';
import { createTestClock, createTestIds } from '@crewkite/testkit';
import type { ArtifactFiles } from '../../artifacts/index.ts';
import { Controller } from '../../commands/controller.ts';
import type { StreamingCommandOptions } from '../../host/worker.ts';
import type { NativeProfileResolution } from '../openai/profile.ts';
import {
  type AnthropicUsageReaderTrust,
  anthropicUsageReaderScope,
  startAnthropicUsageReader,
} from './native-usage-reader.ts';
import {
  AnthropicUsageReader,
  anthropicUsageReaderPlan,
  UsageReaderError,
} from './usage-reader.ts';

const sessionId = '46eb17cd-01e8-480d-99f4-a741f189715d';
const uuid = '46eb17cd-01e8-480d-99f4-a741f189715f';
const sha256 = '5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37';
const at = '2026-10-21T01:00:00.000Z';
// Client 2.1.302 output for the exact plan, with display text, paths and long lists replaced.
const [init, assistant, terminal] = readFileSync(
  new URL('./usage-fixture.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const limits = assistant.usage_report.rate_limits.limits;
const withLimits = (value: unknown) => ({
  ...assistant,
  usage_report: {
    ...assistant.usage_report,
    rate_limits: { ...assistant.usage_report.rate_limits, limits: value },
  },
});
const usageWindow = (windowId: string, value: number, resetsAt: string | null) => ({
  windowId,
  remaining: { value, unit: 'percent' },
  resetsAt,
});
const reported = [
  usageWindow('five-hour', 50, '2026-10-23T18:20:00.448Z'),
  usageWindow('weekly', 83, '2026-10-30T07:00:00.448Z'),
  usageWindow('weekly-fable', 81, '2026-10-30T07:00:00.449Z'),
];
const bytes = (frames: unknown[]) =>
  Buffer.from(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`);

test('a usage read maps each reported limit and ignores what it does not show', () => {
  const later = { later_field: { nested: [1] } };
  const rows: {
    name: string;
    input: Buffer;
    bytewise?: boolean;
    status?: string;
    windows?: unknown[];
    model?: string | null;
    error?: UsageReaderError['reason'];
  }[] = [
    { name: 'full report', input: bytes([init, assistant, terminal]), windows: reported },
    {
      name: 'full report one byte at a time',
      input: bytes([init, assistant, terminal]),
      bytewise: true,
      windows: reported,
    },
    {
      name: 'unknown limit kind past its cap',
      input: bytes([
        init,
        withLimits([
          ...limits,
          { ...limits[0], kind: 'monthly_pool', percent: 110, resets_at: null },
        ]),
        terminal,
      ]),
      windows: [...reported, usageWindow('monthly_pool', 0, null)],
    },
    {
      name: 'a limit it cannot read is dropped and the others stay',
      input: bytes([
        init,
        withLimits([
          ...limits,
          { ...limits[0], kind: 'monthly_pool', percent: null },
          { ...limits[1], kind: 'daily_pool', resets_at: '2026-10-30T07:00:00' },
        ]),
        terminal,
      ]),
      windows: reported,
    },
    {
      name: 'a scoped model name with a dot and a space takes the model ID form',
      input: bytes([
        init,
        withLimits([
          ...limits.slice(0, 2),
          { ...limits[2], scope: { model: { display_name: 'Opus 4.1' } } },
        ]),
        terminal,
      ]),
      windows: [
        ...reported.slice(0, 2),
        usageWindow('weekly-opus-4-1', 81, '2026-10-30T07:00:00.449Z'),
      ],
    },
    {
      name: 'unknown fields and frames',
      input: bytes([
        { ...init, ...later },
        { type: 'rate_limit_event', ...later },
        { type: 'system', subtype: 'status', ...later },
        {
          ...withLimits(
            limits.map((row: { scope: object | null }) => ({
              ...row,
              ...later,
              scope: row.scope && { ...row.scope, ...later },
            })),
          ),
          ...later,
        },
        { ...terminal, ...later },
      ]),
      windows: reported,
    },
    {
      name: 'init with a model it cannot read',
      input: bytes([{ ...init, model: 7 }, assistant, terminal]),
      windows: reported,
      model: null,
    },
    {
      name: 'no rate limits',
      input: bytes([init, withLimits(null), terminal]),
      status: 'unavailable',
      windows: [],
    },
    { name: 'no report', input: bytes([init, terminal]), error: 'no-usage-report' },
    { name: 'no result', input: bytes([init, assistant]), error: 'no-result' },
    {
      name: 'error result',
      input: bytes([init, assistant, { ...terminal, is_error: true }]),
      error: 'client-error',
    },
    {
      name: 'unreadable limit list',
      input: bytes([init, withLimits({ session: 50 }), terminal]),
      error: 'unreadable-report',
    },
    { name: 'not JSON', input: Buffer.from('{\n'), error: 'not-json' },
    { name: 'not UTF-8', input: Buffer.from([0xff, 10]), error: 'not-json' },
    { name: 'over the output limit', input: Buffer.alloc(131073, 65), error: 'output-limit' },
  ];
  for (const row of rows) {
    const parser = new AnthropicUsageReader();
    const read = () => {
      if (row.bytewise) for (const byte of row.input) parser.feed(Uint8Array.of(byte));
      else parser.feed(row.input);
      return parser.finish(at);
    };
    if (row.error) {
      assert.throws(
        read,
        (error: unknown) => error instanceof UsageReaderError && error.reason === row.error,
        row.name,
      );
      continue;
    }
    const reading = read();
    assert.equal(reading.status, row.status ?? 'reported', row.name);
    assert.deepEqual(reading.windows, row.windows, row.name);
    assert.deepEqual(reading.extraUsage, { is_enabled: false }, row.name);
    assert.equal(reading.model, row.model === undefined ? 'claude-opus-5-5' : row.model, row.name);
    assert.equal(reading.observedAt, null, row.name);
    assert.equal(reading.freshness, 'unknown', row.name);
  }
  const plan = anthropicUsageReaderPlan({ clientSha256: sha256, sessionId });
  assert.equal(plan.argv.at(-1), '/usage');
  assert.equal(plan.argv.includes('--print'), true);
  assert.equal(plan.argv.includes('--disable-slash-commands'), false);
  assert.equal(plan.argv.includes('--bare'), false);
  assert.equal(plan.argv.includes('--model'), false);
  assert.equal(plan.argv.includes('--safe-mode'), true);
  assert.equal(plan.argv.includes('--restricted'), true);
  assert.equal(plan.argv[plan.argv.indexOf('--settings') + 1], '{"disableAllHooks":true}');
  assert.equal(plan.argv[plan.argv.indexOf('--setting-sources') + 1], '');
  assert.throws(
    () => anthropicUsageReaderPlan({ clientSha256: '0'.repeat(64), sessionId }),
    UsageReaderError,
  );
});

test('the usage owner bounds output and refuses metadata before physical closure', async () => {
  const context = {
    operationId: 'usage_fixture',
    executable: '/not-opened/native',
    executableSha256: sha256,
    sessionId,
    directory: '/not-opened',
    home: '/not-opened/home',
    temporary: '/not-opened/temporary',
  };
  const scope = anthropicUsageReaderScope(context);
  const trust = { nativeTrust: 'accepted' as const, scopeHash: scope.scopeHash };
  assert.equal(scope.version, 1);
  assert.equal(scope.purpose, 'native-local-usage');
  assert.equal(scope.nativeTrust, 'required');
  assert.equal(scope.command, '/usage');
  assert.equal(scope.generationRequest, false);
  assert.equal(scope.policyHooks, 'covered-by-native-client-trust');
  const lifecycle = {
    intent() {
      assert.fail('no intent before explicit native-client trust');
    },
    owned() {},
    quiescent() {},
  };
  for (const invalid of [
    undefined,
    null,
    false,
    {},
    { ...trust, nativeTrust: 'required' },
    { ...trust, scopeHash: '0'.repeat(64) },
    { ...trust, private: 'unrecognized acceptance field' },
  ])
    for (const options of [
      {},
      {
        create() {
          assert.fail('no owner construction before explicit native-client trust');
        },
      },
    ])
      assert.throws(
        () =>
          startAnthropicUsageReader(
            { ...context, lifecycle, trust: invalid as AnthropicUsageReaderTrust },
            options,
          ),
        (error: unknown) =>
          error instanceof UsageReaderError && error.reason === 'native-trust-required',
      );
  for (const changed of [
    { operationId: 'another_operation' },
    { sessionId: uuid },
    { executable: '/another/native' },
    { directory: '/another/directory' },
    { home: '/another/home' },
    { temporary: '/another/temporary' },
  ]) {
    assert.notEqual(
      anthropicUsageReaderScope({ ...context, ...changed }).scopeHash,
      trust.scopeHash,
    );
    assert.throws(
      () => startAnthropicUsageReader({ ...context, ...changed, lifecycle, trust }),
      (error: unknown) =>
        error instanceof UsageReaderError && error.reason === 'native-trust-required',
    );
  }
  for (const changed of [
    { executableSha256: '0'.repeat(64) },
    { sessionId: 'invalid' },
    { operationId: '' },
    { directory: 'relative' },
    { home: '/not-opened/../changed' },
    { temporary: '/not-opened/temporary\0' },
  ])
    assert.throws(
      () => startAnthropicUsageReader({ ...context, ...changed, lifecycle, trust }),
      (error: unknown) => error instanceof UsageReaderError && error.reason === 'client',
    );
  for (const mode of [
    'success',
    'caller-mutation',
    'stdout-limit',
    'stderr-limit',
    'group-present',
    'error-result',
    'deadline',
    'stopped',
    'unclosed',
  ] as const) {
    const stopped: boolean[] = [];
    const close = Promise.withResolvers<void>();
    const held = mode === 'deadline' || mode === 'stopped' || mode === 'unclosed';
    const scheduled: Array<{ work: () => void; milliseconds: number; cancelled: boolean }> = [];
    const schedule = (work: () => void, milliseconds: number) => {
      const item = { work, milliseconds, cancelled: false };
      scheduled.push(item);
      if (mode === 'group-present' && milliseconds === 25) queueMicrotask(work);
      if ((mode === 'group-present' || mode === 'unclosed') && milliseconds === 3000)
        queueMicrotask(work);
      if ((mode === 'deadline' || mode === 'unclosed') && milliseconds === 30000)
        queueMicrotask(work);
      return () => {
        item.cancelled = true;
      };
    };
    async function* output(stdout: boolean) {
      if (held) await close.promise;
      if ((mode === 'stdout-limit' && stdout) || (mode === 'stderr-limit' && !stdout))
        yield Buffer.alloc(131073);
      else if (stdout)
        yield bytes([
          init,
          assistant,
          mode === 'error-result' ? { ...terminal, is_error: true } : terminal,
        ]);
    }
    const request = {
      ...context,
      trust,
      lifecycle: { intent() {}, owned() {}, quiescent() {} },
    };
    const handle = startAnthropicUsageReader(request, {
      schedule,
      now: () => {
        if (mode === 'caller-mutation') {
          request.home = '/changed/home';
          request.executable = '/changed/native';
          request.directory = '/changed/directory';
        }
        return 0;
      },
      receivedAt: () => at,
      create(launch) {
        assert.deepEqual(
          launch.argv,
          anthropicUsageReaderPlan({ clientSha256: sha256, sessionId }).argv,
        );
        assert.equal(launch.environment.ANTHROPIC_API_KEY, undefined);
        assert.equal(launch.input, undefined);
        assert.equal(launch.executableSha256, context.executableSha256);
        assert.equal(launch.executable, context.executable);
        assert.equal(launch.environment.HOME, context.home);
        assert.equal(launch.directory, context.directory);
        return {
          stdoutStream: output(true),
          stderrStream: output(false),
          closed: held ? close.promise : Promise.resolve(),
          exited: Promise.resolve({ code: 0, signal: null, quiescent: mode !== 'group-present' }),
          inputCompleted: Promise.resolve({ bytes: 0 }),
          failed: false,
          ownershipUnknown: false,
          stop() {
            stopped.push(true);
            if (held && mode !== 'unclosed') close.resolve();
          },
          async quiescent() {
            return mode !== 'group-present';
          },
        };
      },
    });
    if (mode === 'stopped') handle.stop();
    const result = await handle.result;
    if (mode === 'success' || mode === 'caller-mutation') {
      assert(result.reading);
      assert.equal(result.reason, null);
      assert.equal(result.quiescent, true);
      assert.equal(stopped.length, 0);
    } else {
      assert.equal(result.reading, null);
      assert.equal(
        result.reason,
        mode.endsWith('limit')
          ? 'output-limit'
          : mode === 'group-present' || mode === 'unclosed'
            ? 'ownership'
            : mode === 'deadline' || mode === 'stopped'
              ? mode
              : 'client-error',
      );
      assert(stopped.length > 0);
    }
    assert(scheduled.some((item) => item.milliseconds === 30000 && item.cancelled));
  }
});

function refreshFixture(
  t: TestContext,
  mode: 'success' | 'held' | 'unknown' | 'error' | 'large' = 'success',
) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'ck-usage-'));
  const clock = createTestClock(at);
  const id = createTestIds(at);
  let calls = 0;
  const released = Promise.withResolvers<void>();
  const owned = Promise.withResolvers<void>();
  let profile: NativeProfileResolution = {
    facts: AnthropicNativeProfileSchema.parse({
      id: 'anthropic-file-v1',
      family: 'anthropic',
      displayName: 'Native fixture',
      clientVersion: '2.1.302',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      effectiveEffort: 'unknown',
      accountClass: 'unknown',
      serviceTier: 'unknown',
      billingBasis: 'requires-user-attestation',
      qualifiedAt: null,
      creditPolicies: ['ordinary'],
      maximumTaskMs: 300000,
      maximumFileBytes: 65536,
      maximumSubmissions: 1,
      available: true,
      reason: 'qualification-pending',
    }),
    client: { executable: '/never-executed/native-fixture', sha256, version: '2.1.302' },
    environment: { HOME: directory },
    locationHash: '1'.repeat(64),
  };
  const options = {
    home: join(directory, 'home'),
    now: clock.now,
    id,
    nativeProfiles: () => [profile],
    googleUsageClient: () => ({ available: false as const, reason: 'client-unavailable' as const }),
    nativeSpawn() {
      assert.fail('No native auth or model process is allowed.');
    },
    schedule(work: () => void, milliseconds: number) {
      if (mode === 'unknown' && (milliseconds === 25 || milliseconds === 3000))
        queueMicrotask(work);
      return () => {};
    },
    anthropicUsageReader: {
      now: () => 0,
      create(launch: StreamingCommandOptions) {
        calls++;
        assert.equal(launch.input, undefined);
        assert.equal(launch.argv.at(-1), '/usage');
        assert.deepEqual(Object.keys(launch.environment).sort(), [
          'HOME',
          'LANG',
          'NO_COLOR',
          'PATH',
          'TMPDIR',
        ]);
        launch.lifecycle.intent({
          operationId: launch.operationId,
          executable: launch.executable,
          executableIdentity: launch.executableIdentity,
          executableSha256: launch.executableSha256,
          argv: launch.argv,
          cwd: launch.directory,
          environment: launch.environment,
          shell: false,
        });
        launch.lifecycle.owned(1_999_999_999);
        owned.resolve();
        const selectedSession = launch.argv[launch.argv.indexOf('--session-id') + 1];
        async function* output(stdout: boolean) {
          if (mode === 'held') await released.promise;
          if (stdout)
            yield bytes(
              [
                init,
                mode === 'large'
                  ? withLimits(
                      Array.from({ length: 64 }, () => ({
                        ...limits[2],
                        scope: { model: { display_name: '漢'.repeat(128) }, surface: null },
                      })),
                    )
                  : assistant,
                mode === 'error' ? { ...terminal, is_error: true } : terminal,
              ].map((frame) => ({ ...frame, session_id: selectedSession })),
            );
        }
        return {
          stdoutStream: output(true),
          stderrStream: output(false),
          closed: mode === 'held' ? released.promise : Promise.resolve(),
          exited: Promise.resolve({ code: 0, signal: null, quiescent: mode !== 'unknown' }),
          inputCompleted: Promise.resolve({ bytes: 0 }),
          failed: false,
          ownershipUnknown: false,
          stop() {
            released.resolve();
          },
          async quiescent() {
            return mode !== 'unknown';
          },
        };
      },
    },
  };
  let controller = new Controller(options);
  t.after(async () => {
    await controller.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const command = (name = 'RefreshAnthropicUsage', payload: unknown = {}) => ({
    protocol: 1,
    key: id('cmd'),
    actor: { id: 'usage-fixture', kind: 'cli' },
    command: name,
    payload,
    expectedRevision: 0,
  });
  const status = () =>
    controller.workspaceState().usageReaders.find((reader) => reader.family === 'anthropic');
  return {
    get controller() {
      return controller;
    },
    command,
    status,
    clock,
    owned: owned.promise,
    calls: () => calls,
    changeScope() {
      profile = { ...profile, locationHash: '2'.repeat(64) };
    },
    async reopen() {
      await controller.close();
      controller = new Controller(options);
    },
  };
}

test('manual usage consent and the age-unknown report survive exact retries and reopen', async (t) => {
  const f = refreshFixture(t);
  const afterTurn = () => f.controller.anthropicUsage().refreshAfterTurn(f.command().key);
  const initial = f.status();
  assert(initial?.available && initial.trust && !initial.trust.accepted);
  assert.equal(afterTurn(), undefined);
  const untouched = f.controller
    .workspaceState()
    .usageReaders.filter((reader) => reader.family !== 'anthropic');
  assert.equal(
    (await f.controller.execute(f.command(), 'local-owner')).reason,
    'native-trust-required',
  );
  assert.equal(f.calls(), 0);
  const request = f.command('RefreshAnthropicUsage', {
    trust: { nativeTrust: 'accepted', scopeHash: initial.trust.scopeHash },
  });
  assert.equal((await f.controller.execute(request, 'local-owner')).outcome, 'applied');
  assert.equal(f.calls(), 1);
  const retained = f.status();
  assert.equal(retained?.trust?.accepted, true);
  assert.equal(retained?.lastObservedAt, null);
  assert.equal(retained?.reading?.observedAt, null);
  assert.equal(retained?.reading?.freshness, 'unknown');
  assert.equal(retained?.reading?.receivedAt, at);
  assert.deepEqual(retained?.reading?.windows, reported);
  assert.equal(f.controller.anthropicUsage().clientModel(), 'claude-opus-5-5');
  assert.equal(retained?.readingScopeHash, retained?.trust?.scopeHash);
  assert.equal((await f.controller.execute(request, 'local-owner')).outcome, 'already-applied');
  assert.equal(
    (await f.controller.execute({ ...request, payload: {} }, 'local-owner')).reason,
    'idempotency-key-reused',
  );
  assert.equal(
    (await f.controller.execute(f.command(), 'local-owner')).reason,
    'usage-reader-cooldown',
  );
  assert.deepEqual(
    f.controller.workspaceState().usageReaders.filter((reader) => reader.family !== 'anthropic'),
    untouched,
  );
  await f.reopen();
  assert.deepEqual(f.status()?.reading, retained?.reading);
  assert.equal(f.status()?.trust?.accepted, true);
  assert.equal(f.calls(), 1);
  // A settled turn reads again only once the last read is more than a minute old.
  f.clock.advance(60000);
  assert.equal(afterTurn(), undefined);
  f.clock.advance(1);
  await afterTurn();
  assert.equal(f.calls(), 2);
  f.clock.advance(60000);
  assert.equal((await f.controller.execute(f.command(), 'local-owner')).outcome, 'applied');
  assert.equal(f.calls(), 3);
  const previousReport = f.status()?.reading;
  f.clock.advance(60000);
  f.changeScope();
  assert.equal(f.status()?.trust?.accepted, false);
  assert.equal(
    (await f.controller.execute(f.command('RefreshAnthropicUsage', request.payload), 'local-owner'))
      .reason,
    'native-trust-scope-changed',
  );
  assert.equal(
    (await f.controller.execute(f.command(), 'local-owner')).reason,
    'native-trust-required',
  );
  assert.equal(afterTurn(), undefined);
  assert.deepEqual(f.status()?.reading, previousReport);
  assert.notEqual(f.status()?.readingScopeHash, f.status()?.trust?.scopeHash);
  assert.equal(f.calls(), 3);
});

test('manual usage Stop, failed cooldown and uncertain ownership never replay a native read', async (t) => {
  const large = refreshFixture(t, 'large');
  const largeTrust = large.status()?.trust;
  assert(largeTrust);
  assert.equal(
    (
      await large.controller.execute(
        large.command('RefreshAnthropicUsage', {
          trust: { nativeTrust: 'accepted', scopeHash: largeTrust.scopeHash },
        }),
        'local-owner',
      )
    ).outcome,
    'applied',
  );
  const largeReading = large.status()?.reading;
  assert.equal(largeReading?.windows.length, 64);
  await large.reopen();
  assert.deepEqual(large.status()?.reading, largeReading);
  const publicationFailure = refreshFixture(t);
  const originalAppend = publicationFailure.controller.store.append.bind(
    publicationFailure.controller.store,
  );
  publicationFailure.controller.store.append = () => {
    publicationFailure.controller.store.append = originalAppend;
    throw Error('Synthetic initial reader event storage failure.');
  };
  const failedTrust = publicationFailure.status()?.trust;
  assert(failedTrust);
  const failedResult = await publicationFailure.controller.execute(
    publicationFailure.command('RefreshAnthropicUsage', {
      trust: { nativeTrust: 'accepted', scopeHash: failedTrust.scopeHash },
    }),
    'local-owner',
  );
  assert.equal(failedResult.reason, 'usage-read-failed');
  assert.equal(publicationFailure.calls(), 0);
  assert.equal(publicationFailure.status()?.readState, 'quiescent');
  for (const mode of ['held', 'unknown', 'error'] as const) {
    const f = refreshFixture(t, mode);
    const trust = f.status()?.trust;
    assert(trust);
    const request = f.command('RefreshAnthropicUsage', {
      trust: { nativeTrust: 'accepted', scopeHash: trust.scopeHash },
    });
    const running = f.controller.execute(request, 'local-owner');
    await f.owned;
    assert.equal(f.status()?.readState, 'owned');
    const blocker = (
      f.controller as unknown as { openAiUsageBlocker(route: unknown): string | undefined }
    ).openAiUsageBlocker({ family: 'anthropic', fake: false });
    assert.equal(blocker, 'anthropic-metadata-ownership-pending');
    assert.equal(
      (
        await f.controller.execute(
          f.command('CheckNativeConnection', { family: 'anthropic', consent: 'explicit' }),
          'local-owner',
        )
      ).reason,
      'anthropic-metadata-ownership-pending',
    );
    if (mode === 'held') {
      assert.equal(f.controller.anthropicUsage().refreshAfterTurn(f.command().key), undefined);
      assert.equal(
        (await f.controller.execute(f.command(), 'local-owner')).reason,
        'anthropic-metadata-ownership-pending',
      );
      const stopped = await f.controller.execute(
        f.command('StopAnthropicUsage', { operationId: request.key }),
        'local-owner',
      );
      assert.equal(stopped.outcome, 'applied');
    }
    const result = await running;
    assert.equal(result.outcome, mode === 'unknown' ? 'outcome-unknown' : 'blocked');
    assert.equal(f.status()?.reading, null);
    assert.equal(f.status()?.readState, mode === 'unknown' ? 'unknown' : 'quiescent');
    if (mode === 'unknown') {
      assert.equal(
        (await f.controller.execute(f.command(), 'local-owner')).reason,
        'anthropic-metadata-ownership-unknown',
      );
      // A retained intent with no recorded group cannot become known on reopen.
      const receipt = f.controller.store.receipt('usage-reader:anthropic');
      assert(receipt?.result.entity && 'hash' in receipt.result.entity);
      const artifact = receipt.result.entity;
      const artifacts = (f.controller as unknown as { artifacts: ArtifactFiles }).artifacts;
      const value = JSON.parse(artifacts.read(artifact.hash).toString('utf8'));
      value.groups = [];
      const saved = artifacts.publish(Buffer.from(JSON.stringify(value)));
      f.controller.store.db
        .prepare('UPDATE receipts SET request_hash=?,result=? WHERE command_key=?')
        .run(
          saved.hash,
          JSON.stringify({ outcome: 'applied', entity: { ...artifact, ...saved } }),
          'usage-reader:anthropic',
        );
      await f.reopen();
      assert.equal(f.status()?.readState, 'unknown');
      assert.equal(
        (await f.controller.execute(f.command(), 'local-owner')).reason,
        'anthropic-metadata-ownership-unknown',
      );
    } else
      assert.equal(
        (await f.controller.execute(f.command(), 'local-owner')).reason,
        'usage-reader-cooldown',
      );
    assert.equal(f.calls(), 1);
  }
});
