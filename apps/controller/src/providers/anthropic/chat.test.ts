// Frames these tests assume from the native client in `--print` stream-json mode. The constants
// below are the recorded lines; a live run should confirm each one.
//
// argv: --print --output-format stream-json --input-format stream-json --verbose
//   --include-partial-messages --permission-prompt-tool stdio --setting-sources ''
//   --settings {"disableAllHooks":true} --permission-mode default|acceptEdits --model M
//   [--effort E] [--resume S]. With no setting sources neither the scratch copy's own .claude
//   settings nor the user file load, so no allow rule answers an ask before CrewKite sees it.
//
// stdin, one JSON object per line:
//   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
//   {"type":"control_response","response":{"subtype":"success","request_id":"req-1",
//     "response":{"behavior":"allow","updatedInput":{...}}}}
// stdout, one JSON object per line:
//   {"type":"system","subtype":"init","session_id":"...","model":"...","effort":"high"|null}, where
//     effort is the level the client sends after its default and caps, null for none, and left
//     out by builds that do not publish it
//   {"type":"stream_event","parent_tool_use_id":null,"event":{...Messages API stream event...}}
//   {"type":"assistant","parent_tool_use_id":null,"message":{"id":"msg_...","content":[ONE block]}}
//   {"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result",...}]}}
//   {"type":"control_request","request_id":"...","request":{"subtype":"can_use_tool",
//     "tool_name":"Bash","input":{...},"tool_use_id":"toolu_..."}}
//   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour",
//     "utilization":0.29,"resetsAt":<unix seconds>,"unifiedWindows":{"five_hour":{...},
//     "seven_day":{"utilization":0.4,"resetsAt":<unix seconds>}}}}
//   {"type":"result","subtype":"success","is_error":false,"session_id":"...",
//     "modelUsage":{"<model>":{"contextWindow":200000}}}
//
// Assumptions the adapter makes and a live client should settle:
// - A streamed message comes back as one assistant frame per content block, sharing message.id.
// - The ask fields are tool_name and tool_use_id. toolName and toolUseId are accepted as well.
// - Rate limits arrive as rate_limit_event with rate_limit_info. rate_limit and rateLimitInfo
//   are accepted as well.
// - The last assistant frame's usage is the context in use; modelUsage gives the window.
// - Only a result's subtype must keep its shape. errors, usage and modelUsage may change.
// - SIGINT to the group ends a running turn. A failed resume exits non-zero without a result.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type AgentEvent,
  AgentEventSchema,
  AnthropicUsageReadingSchema,
  type ChatEffort,
  type ChatPermissionPolicy,
  type ChatSession,
  type ChatToolKind,
} from '@crewkite/contracts';
import { spawnCheckChild } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import { anthropicChatAdapter } from './chat.ts';

type Spawn = NonNullable<Parameters<typeof anthropicChatAdapter>[0]['spawn']>;
type Step = 'read' | 'hold' | 'drain' | { out: unknown } | { err: string } | { exit: number };

const fixture = fileURLToPath(new URL('./chat-fixture.ts', import.meta.url));
const sha256 = createHash('sha256').update(readFileSync(fixture)).digest('hex');
const turnId = 'trn_00000000000000000000000001';
const model = 'claude-sonnet-5-5';
const fresh = '0f6c2a51-7a3e-4c1b-9d55-1f2e3a4b5c6d';
const systemContext = 'You are working in a scratch copy of demo.';
const prompt = 'What does this project do?';

const init = (session = fresh, effort?: string | null) => ({
  type: 'system',
  subtype: 'init',
  session_id: session,
  model,
  ...(effort === undefined ? {} : { effort }),
});
const stream = (event: unknown) => ({
  type: 'stream_event',
  session_id: fresh,
  parent_tool_use_id: null,
  event,
});
const reply = (id: string, content: unknown[], usage?: unknown) => ({
  type: 'assistant',
  session_id: fresh,
  parent_tool_use_id: null,
  message: { id, role: 'assistant', model, content, ...(usage ? { usage } : {}) },
});
// The error entry and the zero window are shapes CrewKite does not read. They must not fail a turn.
const done = (session = fresh) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: session,
  result: 'ok',
  errors: [{ message: 'reported as an object' }],
  usage: { input_tokens: 2400, output_tokens: 80 },
  modelUsage: { [model]: { contextWindow: 200_000 }, 'claude-haiku-5': { contextWindow: 0 } },
});
const streamed = (session = fresh, effort?: string | null): Step[] => [
  'read',
  { out: init(session, effort) },
  { out: stream({ type: 'message_start', message: { id: 'msg_1' } }) },
  { out: stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }) },
  { out: stream(delta(0, 'thinking_delta', 'thinking', 'Reading ')) },
  { out: stream(delta(0, 'thinking_delta', 'thinking', 'the files.')) },
  { out: stream({ type: 'content_block_stop', index: 0 }) },
  { out: reply('msg_1', [{ type: 'thinking', thinking: 'Reading the files.', signature: 's' }]) },
  { out: stream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }) },
  { out: stream(delta(1, 'text_delta', 'text', 'It routes ')) },
  { out: stream(delta(1, 'text_delta', 'text', 'prompts.')) },
  { out: stream({ type: 'content_block_stop', index: 1 }) },
  {
    out: reply('msg_1', [{ type: 'text', text: 'It routes prompts.' }], {
      input_tokens: 1200,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 0,
      output_tokens: 40,
    }),
  },
  { out: stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) },
  { out: stream({ type: 'message_stop' }) },
  { out: done(session) },
  'drain',
];
function delta(index: number, type: string, field: string, text: string) {
  return { type: 'content_block_delta', index, delta: { type, [field]: text } };
}

function run(
  script: Step[] | ((scratch: string) => Step[]),
  session: ChatSession | null = null,
  permissionGrants: ChatToolKind[] = [],
  permissionPolicy: ChatPermissionPolicy = 'ask',
  effort: ChatEffort = 'default',
) {
  const root = mkdtempSync(join(tmpdir(), 'crewkite-chat-'));
  mkdirSync(join(root, 'scratch'));
  mkdirSync(join(root, 'work'));
  const steps = typeof script === 'function' ? script(join(root, 'scratch')) : script;
  const events: AgentEvent[] = [];
  const waiting = new Map<string, (event: AgentEvent) => void>();
  const launched = { argv: [] as string[], input: [] as string[] };
  const usage: unknown[] = [];
  const spawn: Spawn = (executable, argv, options) => {
    launched.argv = argv;
    const child = spawnCheckChild(
      process.execPath,
      [executable, JSON.stringify(steps), ...argv],
      options,
    ) as ReturnType<Spawn>;
    const write = child.stdin.write;
    child.stdin.write = function (this: unknown, ...args: unknown[]) {
      launched.input.push(String(args[0]));
      return Reflect.apply(write, this, args);
    } as typeof write;
    return child;
  };
  const handle = anthropicChatAdapter({
    launch: () => ({ executable: fixture, sha256 }),
    spawn,
    onUsage: (reading) => usage.push(reading),
  }).startTurn(
    {
      turnId,
      taskId: 'tsk_00000000000000000000000001',
      role: 'assistant',
      selection: { family: 'anthropic', model, effort },
      prompt,
      systemContext,
      history: [],
      session,
      scratch: { directory: join(root, 'scratch'), base: 'a'.repeat(40), projectName: 'demo' },
      work: { directory: join(root, 'work'), home: root },
      permissionPolicy,
      permissionGrants,
      deadlineMs: 60_000,
      environment: { HOME: root, PATH: '/usr/bin:/bin' },
      now: () => Date.parse('2026-10-23T00:00:00.000Z'),
    },
    (event) => {
      events.push(AgentEventSchema.parse(event));
      waiting.get(event.type)?.(event);
      waiting.delete(event.type);
    },
  );
  const next = <T extends AgentEvent['type']>(type: T) =>
    new Promise<Extract<AgentEvent, { type: T }>>((resolve) =>
      waiting.set(type, resolve as (event: AgentEvent) => void),
    );
  return {
    handle,
    events,
    launched,
    usage,
    next,
    work: join(root, 'work'),
    cleanup: () => rmSync(root, { recursive: true }),
  };
}

test('streamed thinking and text arrive in order and the session id comes back', async (t) => {
  const turn = run(streamed());
  t.after(turn.cleanup);
  const result = await turn.handle.result;
  assert.deepEqual(
    turn.events.map((event) =>
      [event.type, 'itemId' in event ? event.itemId : '', 'text' in event ? event.text : ''].join(
        '|',
      ),
    ),
    [
      'turn.started||',
      'thinking.delta|m1-0|Reading ',
      'thinking.delta|m1-0|the files.',
      'thinking.completed|m1-0|',
      'text.delta|m1-1|It routes ',
      'text.delta|m1-1|prompts.',
      'text.completed|m1-1|It routes prompts.',
      'usage.context||',
      'turn.completed||',
    ],
  );
  assert.equal(result.stopReason, 'done');
  assert.equal(result.assistantText, 'It routes prompts.');
  assert.deepEqual(result.usage, { usedTokens: 1540, capacityTokens: 200_000 });
  assert.deepEqual(result.session, {
    family: 'anthropic',
    sessionId: fresh,
    model,
    updatedAt: '2026-10-23T00:00:00.000Z',
  });
});

test('a tool permission ask parks the turn until the answer reaches the client', async (t) => {
  const turn = run([
    'read',
    { out: init() },
    { out: stream({ type: 'message_start', message: { id: 'msg_2' } }) },
    {
      out: stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
      }),
    },
    { out: stream(delta(0, 'input_json_delta', 'partial_json', '{"command":"npm')) },
    { out: stream(delta(0, 'input_json_delta', 'partial_json', ' test"}')) },
    { out: stream({ type: 'content_block_stop', index: 0 }) },
    {
      out: reply('msg_2', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
      ]),
    },
    {
      out: {
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'npm test' },
          tool_use_id: 'toolu_1',
        },
      },
    },
    'read',
    {
      out: {
        type: 'user',
        session_id: fresh,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '$LAST' }],
        },
      },
    },
    { out: done() },
    'drain',
  ]);
  t.after(turn.cleanup);
  const asked = await turn.next('permission.requested');
  assert.equal(asked.question, 'Run npm test?');
  assert.equal(asked.callId, 'toolu_1');
  // Nothing answered for the person and nothing moved on while the ask is open.
  assert.equal(turn.events.at(-1)?.type, 'permission.requested');
  turn.handle.respondPermission(asked.requestId, 'allow-once');
  const result = await turn.handle.result;
  assert.equal(result.stopReason, 'done');
  const output = turn.events.find((event) => event.type === 'tool.output');
  assert.deepEqual(JSON.parse(output?.chunk ?? ''), {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'req-1',
      response: { behavior: 'allow', updatedInput: { command: 'npm test' } },
    },
  });
  assert.deepEqual(
    turn.events.map((event) =>
      event.type === 'tool.started'
        ? `${event.type}|${event.kind}|${event.title}`
        : event.type === 'tool.completed'
          ? `${event.type}|${event.status}`
          : event.type,
    ),
    [
      'turn.started',
      'tool.started|command|npm test',
      'permission.requested',
      'permission.resolved',
      'tool.output',
      'tool.completed|ok',
      'usage.context',
      'turn.completed',
    ],
  );
});

test('an edit outside the scratch copy asks under a thread grant or allow-all, and no grant covers the other kind', async (t) => {
  // Every row holds edit and other grants and runs under the ask policy unless it names one. The
  // scratch copy holds `link`, a link to its parent, and paths keep their '..' unnormalized.
  // WebFetch is of the other kind.
  const rows = [
    { tool: 'Write', file: 'src/notes.md', answered: ['allow-thread'] },
    { tool: 'Write', file: '../notes.md', answered: [] },
    { tool: 'Write', file: 'link/notes.md', answered: [] },
    { tool: 'WebFetch', file: null, answered: [] },
    { tool: 'Write', file: '../notes.md', policy: 'allow-all' as const, answered: [] },
  ];
  for (const row of rows) {
    const turn = run(
      (scratch) => {
        symlinkSync(dirname(scratch), join(scratch, 'link'));
        const input = row.file
          ? { file_path: `${scratch}/${row.file}`, content: 'Notes.' }
          : { url: 'https://example.com/' };
        const ask = { subtype: 'can_use_tool', tool_name: row.tool, input, tool_use_id: 'toolu_1' };
        return [
          'read',
          { out: init() },
          { out: { type: 'control_request', request_id: 'req-1', request: ask } },
          'read',
          { out: done() },
          'drain',
        ];
      },
      null,
      ['edit', 'other'],
      row.policy,
    );
    t.after(turn.cleanup);
    const asked = await turn.next('permission.requested');
    const answered = turn.events.flatMap((event) =>
      event.type === 'permission.resolved' ? [event.choice] : [],
    );
    assert.deepEqual(answered, row.answered, JSON.stringify(row));
    if (!answered.length) turn.handle.respondPermission(asked.requestId, 'deny');
    assert.equal((await turn.handle.result).stopReason, 'done');
  }
});

test('stop ends a running turn as stopped and leaves no process behind', async (t) => {
  const turn = run(['read', { out: init() }, 'hold']);
  t.after(turn.cleanup);
  await turn.next('turn.started');
  turn.handle.stop();
  const result = await turn.handle.result;
  assert.equal(result.stopReason, 'stopped');
  assert.equal(result.failure?.kind, 'stopped');
  assert.deepEqual(turn.events.at(-1), {
    type: 'turn.completed',
    turnId,
    stopReason: 'stopped',
    failure: result.failure,
  });
  assert.equal(turn.handle.groups.length, 1);
  assert.equal(groupAbsent(turn.handle.groups[0] ?? 0), true);
});

test('a client that exits without a result is reported with its last stderr line', async (t) => {
  const turn = run([
    'read',
    { err: 'Loading configuration\nError: the API returned 529 overloaded\n' },
    { exit: 1 },
  ]);
  t.after(turn.cleanup);
  const result = await turn.handle.result;
  assert.equal(result.stopReason, 'error');
  assert.equal(result.failure?.kind, 'client-exit');
  assert.equal(result.failure?.providerMessage, 'Error: the API returned 529 overloaded');
  assert.equal(result.failure?.code, 1);
  assert.deepEqual(
    turn.events.map((event) => event.type),
    ['turn.completed'],
  );
});

test('a rate limit frame reports each window it can read, per-response readings first', async (t) => {
  const window = (windowId: string, value: number, resetsAt: string) => ({
    windowId,
    remaining: { value, unit: 'percent' },
    resetsAt,
  });
  const fiveHour = { utilization: 0.29, resetsAt: 1_792_771_200 };
  const weekly = { utilization: 0.4, resetsAt: 1_793_318_400, status: 'allowed' };
  const rows = [
    {
      info: {
        rateLimitType: 'five_hour',
        utilization: 0.9,
        unifiedWindows: { five_hour: fiveHour, seven_day: weekly },
      },
      windows: [
        window('five-hour', 71, '2026-10-23T16:00:00.000Z'),
        window('weekly', 60, '2026-10-30T00:00:00.000Z'),
      ],
    },
    {
      info: { rateLimitType: 'seven_day_opus', utilization: 0.25, resetsAt: 1_793_232_000 },
      windows: [window('weekly-opus', 75, '2026-10-29T00:00:00.000Z')],
    },
    {
      info: { unifiedWindows: { five_hour: { ...fiveHour, utilization: 1.4 }, seven_day: weekly } },
      windows: [window('weekly', 60, '2026-10-30T00:00:00.000Z')],
    },
    { info: { rateLimitType: 'overage', utilization: 0.1 }, windows: [] },
    { info: { unifiedWindows: { five_hour: 'changed shape' } }, windows: [] },
  ];
  const turn = run([
    'read',
    { out: init() },
    ...rows.map(({ info }) => ({
      out: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', ...info } },
    })),
    { out: done() },
    'drain',
  ]);
  t.after(turn.cleanup);
  assert.equal((await turn.handle.result).stopReason, 'done');
  // One reading per frame with a window, so the last frame of a turn is the newest reading.
  const readings = turn.usage.map((value) => AnthropicUsageReadingSchema.parse(value));
  assert.deepEqual(
    readings.map((reading) => reading.windows),
    rows.flatMap((row) => (row.windows.length ? [row.windows] : [])),
  );
  for (const reading of readings) {
    assert.equal(reading.source, 'turn-rate-limit');
    assert.equal(reading.receivedAt, '2026-10-23T00:00:00.000Z');
  }
});

test('a new session gets the framing, a saved one is resumed with the prompt alone, and the badge shows the effort the turn runs at', async (t) => {
  const saved = 'a3d9c0e2-5b47-4f18-8c6a-2e9d7b1f4a30';
  const base = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio',
    '--setting-sources',
    '',
    '--settings',
    '{"disableAllHooks":true}',
    '--permission-mode',
    'default',
    '--model',
    model,
  ];
  // The client's own report of its effort wins. Without one, the level passed is the level, and
  // minimal, which the client lacks, runs at default.
  const saving = { family: 'anthropic' as const, sessionId: saved, model, updatedAt: 'x' };
  const rows = [
    { session: null, argv: base, text: `${systemContext}\n\n${prompt}`, id: fresh },
    {
      session: saving,
      argv: [...base, '--resume', saved],
      text: prompt,
      id: saved,
      reported: 'xhigh',
      badge: 'xhigh',
    },
    {
      session: null,
      argv: [...base, '--effort', 'high'],
      text: `${systemContext}\n\n${prompt}`,
      id: fresh,
      effort: 'high' as const,
      badge: 'high',
    },
    {
      session: null,
      argv: base,
      text: `${systemContext}\n\n${prompt}`,
      id: fresh,
      effort: 'minimal' as const,
      reported: null,
    },
  ];
  for (const row of rows) {
    const turn = run(streamed(row.id, row.reported), row.session, [], 'ask', row.effort);
    t.after(turn.cleanup);
    const result = await turn.handle.result;
    assert.deepEqual(turn.launched.argv, row.argv);
    const started = turn.events.find((event) => event.type === 'turn.started');
    assert.equal(started?.effort, row.badge ?? 'default', JSON.stringify(row));
    assert.deepEqual(JSON.parse(turn.launched.input[0] ?? ''), {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: row.text }] },
    });
    assert.equal(result.session?.sessionId, row.id);
  }
});

test('an unknown event goes to the turn trace and never the thread, routine system events go nowhere, and neither ends the turn', async (t) => {
  const mystery = { type: 'mystery_event', session_id: fresh, detail: 'new in a later build' };
  const system = (subtype: string, fields: object) => ({
    out: { type: 'system', subtype, session_id: fresh, ...fields },
  });
  const turn = run([
    'read',
    { out: init() },
    { out: mystery },
    { out: mystery },
    system('status', { status: 'requesting' }),
    system('commands_changed', { commands: ['review'] }),
    system('thinking_tokens', { tokens: 120 }),
    system('compact_boundary', { compact_metadata: { trigger: 'auto' } }),
    system('announcement', { content: 'A message for the person.' }),
    { out: reply('msg_3', [{ type: 'text', text: 'Still here.' }]) },
    { out: done() },
    'drain',
  ]);
  t.after(turn.cleanup);
  const result = await turn.handle.result;
  assert.deepEqual(
    turn.events.filter((event) => event.type === 'provider.notice'),
    [],
  );
  assert.deepEqual(
    readFileSync(join(turn.work, 'trace.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line)),
    ['mystery_event', 'mystery_event', 'system/compact_boundary', 'system/announcement'].map(
      (method) => ({ ms: 0, method }),
    ),
  );
  assert.equal(result.stopReason, 'done');
  assert.equal(result.assistantText, 'Still here.');
});
