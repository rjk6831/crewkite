import assert from 'node:assert/strict';
import test from 'node:test';
import { startAnthropicUsageReader } from './native-usage-reader.ts';
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
  assert.throws(
    () => anthropicUsageReaderPlan({ clientSha256: '0'.repeat(64), sessionId }),
    UsageReaderError,
  );
});

test('the usage owner bounds output and refuses metadata before physical closure', async () => {
  assert.throws(
    () =>
      startAnthropicUsageReader({
        operationId: 'usage_refused',
        executable: '/not-opened/native',
        executableSha256: sha256,
        sessionId,
        directory: '/not-opened',
        home: '/not-opened',
        temporary: '/not-opened',
        lifecycle: {
          intent() {
            assert.fail('no intent before policy proof');
          },
          owned() {},
          quiescent() {},
        },
      }),
    (error: unknown) =>
      error instanceof UsageReaderError && error.reason === 'managed-hooks-unverified',
  );
  for (const mode of [
    'success',
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
    const handle = startAnthropicUsageReader(
      {
        operationId: 'usage_fixture',
        executable: '/public/fixture',
        executableSha256: sha256,
        sessionId,
        directory: '/private/tmp',
        home: '/private/tmp',
        temporary: '/private/tmp',
        lifecycle: { intent() {}, owned() {}, quiescent() {} },
      },
      {
        schedule,
        now: () => 0,
        receivedAt: () => at,
        create(launch) {
          assert.deepEqual(
            launch.argv,
            anthropicUsageReaderPlan({ clientSha256: sha256, sessionId }).argv,
          );
          assert.equal(launch.environment.ANTHROPIC_API_KEY, undefined);
          assert.equal(launch.input, undefined);
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
      },
    );
    if (mode === 'stopped') handle.stop();
    const result = await handle.result;
    if (mode === 'success') {
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
