import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
const usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
const report = {
  session: {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 13,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {},
  },
  rate_limits: {
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 0,
        resets_at: at,
        severity: 'normal',
        is_active: true,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 70,
        resets_at: null,
        scope: { model: { display_name: 'Advertised model' } },
        severity: 'warning',
        is_active: false,
      },
    ],
    extra_usage: {
      is_enabled: false,
      monthly_limit: 100,
      used_credits: 0,
      utilization: 0,
      currency: 'USD',
    },
  },
};
const init = {
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  uuid,
  tools: [],
  mcp_servers: [],
  plugins: [],
};
const local = {
  type: 'system',
  subtype: 'local_command_output',
  session_id: sessionId,
  uuid,
  content: 'private display text is discarded',
};
const assistant = {
  type: 'assistant',
  session_id: sessionId,
  uuid,
  parent_tool_use_id: null,
  local_command_run: { command: 'usage', args: '' },
  usage_report: report,
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'private account display is discarded' }],
    stop_reason: 'end_turn',
    usage,
  },
};
const subagents = {
  spawned: 0,
  requested: { background: 0, foreground: 0, unset: 0 },
  started_in_background: 0,
  by_type: {},
  max_depth: 0,
  spawned_by_subagents: 0,
  completed: 0,
  failed: 0,
  killed: { parent: 0, user: 0, system: 0 },
  refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
};
const terminal = {
  type: 'result',
  subtype: 'success',
  session_id: sessionId,
  uuid,
  is_error: false,
  num_turns: 0,
  duration_api_ms: 0,
  total_cost_usd: 0,
  modelUsage: {},
  usage,
  permission_denials: [],
  subagent_stats: subagents,
  safety_stops: 0,
};
const bytes = (frames: unknown[]) =>
  Buffer.from(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`);
const read = (frames: unknown[]) => {
  const parser = new AnthropicUsageReader(sessionId);
  parser.feed(bytes(frames));
  return parser.finish(at);
};

test('local usage reports preserve server rows and unknown age without model work', () => {
  const expected = read([init, local, assistant, terminal]);
  assert.equal(expected.status, 'reported');
  assert.equal(expected.observedAt, null);
  assert.equal(expected.freshness, 'unknown');
  assert.equal(expected.receivedAt, at);
  assert.deepEqual(expected.windows, report.rate_limits.limits);
  assert.deepEqual(expected.extraUsage, report.rate_limits.extra_usage);
  assert.equal(expected.modelTurns, 0);
  assert.equal(JSON.stringify(expected).includes('private'), false);
  assert.equal(
    read([init, { ...assistant, usage_report: { ...report, rate_limits: null } }, terminal]).status,
    'unavailable',
  );
  assert.equal(
    read([
      init,
      { ...assistant, usage_report: { ...report, rate_limits: { limits: null } } },
      terminal,
    ]).status,
    'unavailable',
  );
  assert.equal(
    read([
      init,
      { ...assistant, usage_report: { ...report, rate_limits: { limits: [] } } },
      terminal,
    ]).status,
    'reported',
  );
  const raw = bytes([init, local, assistant, terminal]);
  const chunked = new AnthropicUsageReader(sessionId);
  for (const byte of raw) chunked.feed(Uint8Array.of(byte));
  assert.deepEqual(chunked.finish(at), expected);
  for (const invalid of [
    [assistant, terminal],
    [init, assistant],
    [init, local, terminal],
    [init, assistant, assistant, terminal],
    [init, assistant, terminal, local],
    [init, { ...assistant, session_id: uuid }, terminal],
    [init, { ...assistant, local_command_run: { command: 'other', args: '' } }, terminal],
    [
      init,
      { ...assistant, local_command_run: { command: 'usage', args: '', plugin: 'foreign' } },
      terminal,
    ],
    [init, { ...assistant, local_command_outcome: { kind: 'failed' } }, terminal],
    [
      init,
      {
        ...assistant,
        message: { ...assistant.message, content: [{ type: 'tool_use', text: 'private' }] },
      },
      terminal,
    ],
    [
      init,
      { ...assistant, message: { ...assistant.message, usage: { ...usage, output_tokens: 1 } } },
      terminal,
    ],
    [init, { ...assistant, batch_tool_uses: [{}] }, terminal],
    [init, assistant, { ...terminal, deferred_tool_use: {} }],
    [init, assistant, { ...terminal, subagent_stats: [] }],
    [init, assistant, { ...terminal, subagent_stats: { ...subagents, spawned: 1 } }],
    [init, assistant, { ...terminal, queued_turn_count: 1 }],
    [init, assistant, { ...terminal, safety_stops: 1 }],
    [
      init,
      assistant,
      {
        ...terminal,
        usage: { ...usage, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
      },
    ],
    [init, assistant, { ...terminal, usage: { ...usage, iterations: [{}] } }],
    [init, assistant, { ...terminal, num_turns: 1 }],
    [init, assistant, { ...terminal, duration_api_ms: 1 }],
    [init, assistant, { ...terminal, total_cost_usd: 0.01 }],
    [init, assistant, { ...terminal, modelUsage: { model: {} } }],
    [init, { type: 'rate_limit_event', session_id: sessionId }, assistant, terminal],
    [init, { type: 'control_request', session_id: sessionId }, assistant, terminal],
    [init, { ...assistant, usage_report: { ...report, secret: 'private' } }, terminal],
    [
      init,
      {
        ...assistant,
        usage_report: {
          ...report,
          rate_limits: { limits: [{ ...report.rate_limits.limits[0], percent: 101 }] },
        },
      },
      terminal,
    ],
  ])
    assert.throws(() => read(invalid), UsageReaderError);
  for (const raw of [Buffer.from('{\n'), Buffer.from([0xff, 10]), Buffer.alloc(131073, 65)]) {
    const parser = new AnthropicUsageReader(sessionId);
    assert.throws(() => parser.feed(raw), UsageReaderError);
    assert.throws(() => parser.finish(at), UsageReaderError);
  }
  const truncated = new AnthropicUsageReader(sessionId);
  truncated.feed(Buffer.from('{'));
  assert.throws(() => truncated.finish(at), UsageReaderError);
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
    'model-turn',
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
          local,
          assistant,
          mode === 'model-turn' ? { ...terminal, num_turns: 1 } : terminal,
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
              : 'protocol',
      );
      assert(stopped.length > 0);
    }
    assert(scheduled.some((item) => item.milliseconds === 30000 && item.cancelled));
  }
});

function refreshFixture(
  t: TestContext,
  mode: 'success' | 'held' | 'unknown' | 'protocol' | 'large' = 'success',
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
                  ? {
                      ...assistant,
                      usage_report: {
                        ...report,
                        rate_limits: {
                          limits: Array.from({ length: 48 }, (_, index) => ({
                            kind: '漢'.repeat(128),
                            group: `${index}${'漢'.repeat(126)}`,
                            severity: '漢'.repeat(128),
                            percent: 50,
                            resets_at: null,
                            is_active: true,
                            scope: {
                              model: { display_name: '漢'.repeat(128) },
                              surface: { display_name: '漢'.repeat(128) },
                            },
                          })),
                        },
                      },
                    }
                  : assistant,
                mode === 'protocol' ? { ...terminal, num_turns: 1 } : terminal,
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
  const initial = f.status();
  assert(initial?.available && initial.trust && !initial.trust.accepted);
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
  assert.deepEqual(retained?.reading?.windows, report.rate_limits.limits);
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
  f.clock.advance(60000);
  assert.equal((await f.controller.execute(f.command(), 'local-owner')).outcome, 'applied');
  assert.equal(f.calls(), 2);
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
  assert.deepEqual(f.status()?.reading, previousReport);
  assert.notEqual(f.status()?.readingScopeHash, f.status()?.trust?.scopeHash);
  assert.equal(f.calls(), 2);
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
  assert(largeReading && Buffer.byteLength(JSON.stringify(largeReading)) > 65536);
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
  for (const mode of ['held', 'unknown', 'protocol'] as const) {
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
