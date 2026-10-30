// Frames these tests assume from the native client in `--print` stream-json mode. The constants
// below are the recorded lines; a live run should confirm each one.
//
// argv: --print --output-format stream-json --input-format stream-json --verbose
//   --include-partial-messages --permission-prompt-tool stdio --setting-sources ''
//   --settings {"disableAllHooks":true,"attribution":{"commit":"","pr":"","sessionUrl":false}}
//   --permission-mode default|acceptEdits
//   [--allowedTools Read,Grep,Glob,mcp__crewkite__*] --mcp-config {"mcpServers":{}} or
//   {"mcpServers":{"crewkite":{"type":"stdio","command":NODE,"args":[...]}}} --strict-mcp-config
//   --model M
//   [--effort E] [--resume S] [--add-dir F]. With no setting sources neither the scratch copy's own .claude
//   settings nor the user file load, so no allow rule answers an ask before CrewKite sees it.
//
// stdin, one JSON object per line:
//   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}, with an
//     image block {"type":"image","source":{"type":"base64","media_type":"image/png","data":...}}
//     or a document block {"type":"document","title":N,"source":{"type":"base64",
//     "media_type":"application/pdf","data":...}} or {"source":{"type":"text",
//     "media_type":"text/plain","data":...}} before the text for each attached file
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
//   An API refusal: {"type":"assistant","message":{...,"content":[{"type":"text","text":"API
//     Error: 400 ..."}]},"error":"invalid_request","api_error_status":400}, then a result with
//     "is_error":true
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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
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
import type { ChatTurnRequest } from '../../chat/adapter.ts';
import type { ThreadMcp } from '../../chat/mcp-servers.ts';
import { THREAD_TOOLS_LINE } from '../../chat/prompt.ts';
import { ThreadToolsBroker } from '../../chat/thread-tools/broker.ts';
import { fixtureReader } from '../../chat/thread-tools/fixture.ts';
import { spawnCheckChild } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import { anthropicChatAdapter } from './chat.ts';
import { readAnthropicModels } from './models.ts';

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

// Stored files as the controller lays them out: <files folder>/<sha256>/<name>.
const stored = mkdtempSync(join(tmpdir(), 'crewkite-chat-files-'));
after(() => rmSync(stored, { recursive: true }));
const folder = join(stored, 'chat', 'tsk_00000000000000000000000001', 'files');
function file(name: string, mimeType: string, bytes: Buffer) {
  const id = createHash('sha256').update(bytes).digest('hex');
  const path = join(folder, id, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { attachment: { id, name, mimeType, bytes: bytes.length }, path };
}
type File = ReturnType<typeof file> & { earlier?: boolean };
const png = file('screen.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
const pdf = file('spec.pdf', 'application/pdf', Buffer.from('%PDF-1.7 spec'));
const notes = file('notes.md', 'text/markdown; charset=utf-8', Buffer.from('# Notes\nShip it.'));
const sheet = file('plan.xlsx', 'application/vnd.ms-excel', Buffer.from('PK sheet'));

const notesServer = (policy: 'ask' | 'reads' | 'all'): ThreadMcp => ({
  servers: [
    {
      name: 'notes',
      command: 'notes-server',
      args: ['--root', 'docs'],
      env: { NOTES_KEY: 'value-one' },
      policy,
      readTools: ['read_*'],
    },
  ],
  notes: [],
  secrets: [],
});

function run(
  script: Step[] | ((scratch: string) => Step[]),
  session: ChatSession | null = null,
  permissionGrants: ChatToolKind[] = [],
  permissionPolicy: ChatPermissionPolicy = 'ask',
  effort: ChatEffort = 'default',
  files: File[] = [],
  message = prompt,
  extra: Pick<Parameters<typeof anthropicChatAdapter>[0], 'threadTools'> & {
    readOnly?: boolean;
    /** The controller's answer for this turn. False wins over a thread tools source. */
    turnTools?: boolean;
    /** The person's servers the controller composed for this turn. */
    mcp?: ThreadMcp;
    /** Runs before the turn starts with the path the per-turn MCP config will be written to. */
    plant?: (path: string) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'crewkite-chat-'));
  mkdirSync(join(root, 'scratch'));
  mkdirSync(join(root, 'work'));
  const steps = typeof script === 'function' ? script(join(root, 'scratch')) : script;
  const events: AgentEvent[] = [];
  const waiting = new Map<string, (event: AgentEvent) => void>();
  const launched = {
    argv: [] as string[],
    input: [] as string[],
    config: null as { path: string; mode: number; text: string } | null,
  };
  const usage: unknown[] = [];
  const spawn: Spawn = (executable, argv, options) => {
    launched.argv = argv;
    // The config file when the client was given a path: what it held and its mode at launch.
    const path = argv[argv.indexOf('--mcp-config') + 1] ?? '';
    if (path.endsWith('mcp.json'))
      launched.config = {
        path,
        mode: statSync(path).mode & 0o777,
        text: readFileSync(path, 'utf8'),
      };
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
  const request: ChatTurnRequest & { files: File[] } = {
    turnId,
    taskId: 'tsk_00000000000000000000000001',
    role: 'assistant',
    selection: { family: 'anthropic', model, effort },
    prompt: message,
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
    files,
    readOnly: extra.readOnly,
    threadTools: extra.turnTools,
    mcp: extra.mcp,
  };
  if (extra.plant) {
    mkdirSync(join(root, 'work', 'tmp'), { recursive: true, mode: 0o700 });
    extra.plant(join(root, 'work', 'tmp', 'mcp.json'));
  }
  const handle = anthropicChatAdapter({
    launch: () => ({ executable: fixture, sha256 }),
    threadTools: extra.threadTools,
    spawn,
    onUsage: (reading) => usage.push(reading),
  }).startTurn(request, (event) => {
    events.push(AgentEventSchema.parse(event));
    waiting.get(event.type)?.(event);
    waiting.delete(event.type);
  });
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
    // A person's server follows the policy the controller cut for it. Allow-all and the grants
    // say nothing about its tools, and a server the turn did not start always asks.
    {
      tool: 'mcp__notes__read_file',
      file: null,
      mcp: notesServer('reads'),
      policy: 'allow-all' as const,
      answered: ['allow-once'],
    },
    {
      tool: 'mcp__notes__write_file',
      file: null,
      mcp: notesServer('reads'),
      policy: 'allow-all' as const,
      answered: [],
    },
    {
      tool: 'mcp__notes__read_file',
      file: null,
      mcp: notesServer('ask'),
      policy: 'allow-all' as const,
      answered: [],
    },
    {
      tool: 'mcp__other__read_file',
      file: null,
      mcp: notesServer('all'),
      policy: 'allow-all' as const,
      answered: [],
    },
    {
      tool: 'mcp__notes__write_file',
      file: null,
      mcp: notesServer('all'),
      answered: ['allow-once'],
    },
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
      undefined,
      undefined,
      undefined,
      { mcp: row.mcp },
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

test('a file the API refuses or CrewKite cannot read fails the turn as attachment-rejected, a refusal with no file block keeps its mapping, and a model the account is not served is one line with no session kept', async (t) => {
  const refusal =
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"}}';
  const refused: Step[] = [
    'read',
    { out: init() },
    {
      out: {
        ...reply('msg_4', [{ type: 'text', text: refusal }]),
        error: 'invalid_request',
        api_error_status: 400,
      },
    },
    { out: { ...done(), is_error: true, result: refusal, terminal_reason: 'api_error' } },
    'drain',
  ];
  const missing = { ...png, path: join(folder, 'gone', 'screen.png') };
  // Stored under the hash of other bytes, as after a write through a link to the store.
  const changed = file('changed.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));
  writeFileSync(changed.path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 8]));
  // The API answers 404 for a model it does not know, and the result frame keeps subtype success.
  const unknown = "There's an issue with the selected model (claude-sonnet-5-5). It may not exist.";
  const notServed = `Anthropic does not serve the model ${model} to this account.`;
  const rows: Array<{
    files: File[];
    kind: string;
    provider: string | null;
    spawned: boolean;
    message?: string;
    script?: Step[];
  }> = [
    {
      files: [],
      kind: 'model-unavailable',
      provider: unknown,
      spawned: true,
      message: notServed,
      script: [
        'read',
        { out: init() },
        {
          out: {
            ...reply('msg_5', [{ type: 'text', text: unknown }]),
            error: 'model_not_found',
            api_error_status: 404,
          },
        },
        { out: { ...done(), is_error: true, api_error_status: 404, result: unknown } },
        'drain',
      ],
    },
    // A client that exits on the unknown ID before any result frame leaves only the stderr marker.
    {
      files: [],
      kind: 'model-unavailable',
      provider: null,
      spawned: true,
      message: notServed,
      script: [
        'read',
        { err: '[claude-code:unrecognized_model] {"model":"claude-sonnet-5-5"}\n' },
        { exit: 1 },
      ],
    },
    { files: [png], kind: 'attachment-rejected', provider: refusal, spawned: true },
    // A path line sends nothing the API reads as a file, so the refusal is about something else.
    { files: [sheet], kind: 'protocol', provider: refusal, spawned: true },
    { files: [], kind: 'protocol', provider: refusal, spawned: true },
    // Earlier files go as path lines, so neither an image nor a missing file refuses the turn.
    {
      files: [
        { ...png, earlier: true },
        { ...missing, earlier: true },
      ],
      kind: 'protocol',
      provider: refusal,
      spawned: true,
    },
    {
      files: [missing],
      kind: 'attachment-rejected',
      provider: null,
      spawned: false,
      message: 'CrewKite could not read the attached file screen.png.',
    },
    {
      files: [changed],
      kind: 'attachment-rejected',
      provider: null,
      spawned: false,
      message: 'The stored file changed.png changed after it was attached, so it was not sent.',
    },
  ];
  for (const row of rows) {
    const turn = run(row.script ?? refused, null, [], 'ask', 'default', row.files);
    t.after(turn.cleanup);
    const { stopReason, failure, session } = await turn.handle.result;
    assert.equal(stopReason, 'error');
    if (row.kind === 'model-unavailable') assert.equal(session, null);
    assert.equal(failure?.kind, row.kind, JSON.stringify(row.files));
    assert.equal(failure?.providerMessage, row.provider);
    assert.equal(turn.launched.argv.length > 0, row.spawned);
    if (row.message) assert.equal(failure?.message, row.message);
    assert.equal(existsSync(join(turn.work, 'files')), false);
  }
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

test('a new session gets the framing, a saved one is resumed with the prompt alone, files go as blocks or path lines, and the badge shows the effort the turn runs at', async (t) => {
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
    '{"disableAllHooks":true,"attribution":{"commit":"","pr":"","sessionUrl":false}}',
    '--permission-mode',
    'default',
    // A turn with no thread tools still runs strict, so none of the person's servers load.
    '--mcp-config',
    '{"mcpServers":{}}',
    '--strict-mcp-config',
    '--model',
    model,
  ];
  // The client's own report of its effort wins. Without one, the level passed is the level, and
  // minimal, which the client lacks, runs at default.
  const saving = { family: 'anthropic' as const, sessionId: saved, model, updatedAt: 'x' };
  // Path lines name copies in the turn's own folder, so the client never reaches the store.
  const copy = (work: string, { attachment }: File) =>
    join(work, 'files', attachment.id, attachment.name);
  const framed = `${systemContext}\n\n${prompt}`;
  // A real broker mints each turn's server line. It never needs to listen for the launch.
  const broker = new ThreadToolsBroker({ home: stored });
  const launches: Array<readonly string[]> = [];
  const threadTools = (request: ChatTurnRequest) => {
    const server = broker.mint({
      taskId: request.taskId,
      turnId: request.turnId,
      reader: fixtureReader(),
    });
    launches.push(server.args);
    return server;
  };
  const withTools = (argv: string[], allowed: string[]) => (_work: string) => {
    const args = launches.at(-1) ?? [];
    const config = { mcpServers: { crewkite: { type: 'stdio', command: process.execPath, args } } };
    const at = argv.indexOf('--mcp-config');
    return [
      ...argv.slice(0, at),
      '--allowedTools',
      allowed.join(','),
      '--mcp-config',
      JSON.stringify(config),
      ...argv.slice(at + 2),
    ];
  };
  const large = file('large.pdf', 'application/pdf', Buffer.alloc(25 * 1024 * 1024, 0x20));
  const rows: Array<{
    session: ChatSession | null;
    argv: string[] | ((work: string) => string[]);
    text: string;
    id: string;
    reported?: string | null;
    badge?: string;
    effort?: ChatEffort;
    files?: File[];
    message?: string;
    content?: unknown[] | ((work: string) => unknown[]);
    tools?: boolean;
    readOnly?: boolean;
  }> = [
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
    {
      // The thread tools are the only MCP server, allowed without an ask, on writing and
      // read-only turns alike.
      session: null,
      argv: withTools(base, ['mcp__crewkite__*']),
      text: framed,
      id: fresh,
      tools: true,
    },
    {
      session: null,
      argv: withTools(base, ['Read', 'Grep', 'Glob', 'mcp__crewkite__*']),
      text: framed,
      id: fresh,
      tools: true,
      readOnly: true,
    },
    {
      // Images, PDFs and UTF-8 text go as blocks in file order before the text. A spreadsheet
      // has no block, so a copy's path goes in the text and the copies' folder joins the launch.
      session: null,
      argv: (work) => [...base, '--add-dir', join(work, 'files')],
      text: framed,
      id: fresh,
      files: [png, sheet, pdf, notes],
      content: (work) => [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORwECAw==' },
        },
        {
          type: 'document',
          title: 'spec.pdf',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: Buffer.from('%PDF-1.7 spec').toString('base64'),
          },
        },
        {
          type: 'document',
          title: 'notes.md',
          source: { type: 'text', media_type: 'text/plain', data: '# Notes\nShip it.' },
        },
        {
          type: 'text',
          text: `${framed}\n\nFiles attached to this message:\nscreen.png, image/png, 7 bytes, sent as an image block above\nplan.xlsx, application/vnd.ms-excel, 8 bytes, Path: ${copy(work, sheet)}\nspec.pdf, application/pdf, 13 bytes, sent as a PDF document block above\nnotes.md, text/markdown; charset=utf-8, 16 bytes, sent as a text document block above`,
        },
      ],
    },
    {
      // An earlier file is listed in the packet by its stored path, and the client gets the staged
      // copy's path in its place. A PDF past the block budget goes as a path line and is never read.
      session: null,
      argv: (work) => [...base, '--add-dir', join(work, 'files')],
      text: framed,
      id: fresh,
      files: [{ ...pdf, earlier: true }, large],
      message: `${prompt}\n\nspec.pdf, application/pdf, 13 bytes, came with "the spec", Path: ${pdf.path}`,
      content: (work) => [
        {
          type: 'text',
          text: `${framed}\n\nspec.pdf, application/pdf, 13 bytes, came with "the spec", Path: ${copy(work, pdf)}\n\nFiles attached to this message:\nlarge.pdf, application/pdf, 25.0 MiB, Path: ${copy(work, large)}`,
        },
      ],
    },
  ];
  for (const row of rows) {
    const turn = run(
      streamed(row.id, row.reported),
      row.session,
      [],
      'ask',
      row.effort,
      row.files,
      row.message,
      { readOnly: row.readOnly, ...(row.tools ? { threadTools } : {}) },
    );
    t.after(turn.cleanup);
    const result = await turn.handle.result;
    const resolved = (value: unknown) => (typeof value === 'function' ? value(turn.work) : value);
    assert.deepEqual(turn.launched.argv, resolved(row.argv));
    // Exactly one config per launch. It holds the thread tools or nothing, and strict mode keeps
    // every other server out.
    const configs = turn.launched.argv.filter((arg) => arg.startsWith('{"mcpServers"'));
    assert.equal(configs.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(configs[0]).mcpServers), row.tools ? ['crewkite'] : []);
    assert.ok(turn.launched.argv.includes('--strict-mcp-config'));
    const started = turn.events.find((event) => event.type === 'turn.started');
    assert.equal(started?.effort, row.badge ?? 'default', JSON.stringify(row));
    assert.deepEqual(JSON.parse(turn.launched.input[0] ?? ''), {
      type: 'user',
      message: {
        role: 'user',
        content: resolved(row.content) ?? [{ type: 'text', text: row.text }],
      },
    });
    assert.equal(result.session?.sessionId, row.id);
    // The copies go when the turn ends.
    assert.equal(existsSync(join(turn.work, 'files')), false);
  }
  // The controller decided this turn has no tools: nothing is minted, the config is empty and
  // strict, and the tools are not allowed, even though a source is wired.
  const minted = launches.length;
  const declined = run(streamed(), null, [], 'ask', undefined, [], undefined, {
    threadTools,
    turnTools: false,
  });
  t.after(declined.cleanup);
  await declined.handle.result;
  assert.equal(launches.length, minted);
  assert.ok(declined.launched.argv.includes('--strict-mcp-config'));
  assert.ok(declined.launched.argv.includes('{"mcpServers":{}}'));
  // The person's servers join the thread tools in the one strict config. Their tools are not on
  // the allow list, so each call reaches the controller's gate.
  const joined = run(streamed(), null, [], 'ask', undefined, [], undefined, {
    threadTools,
    mcp: notesServer('reads'),
  });
  t.after(joined.cleanup);
  await joined.handle.result;
  // The person's servers carry secrets, so the config is a file only this user reads, argv holds
  // its path and no secret value, and the file is gone when the turn settles.
  const written = joined.launched.config;
  assert.ok(written);
  assert.equal(written.mode, 0o600);
  assert.ok(!joined.launched.argv.some((arg) => arg.includes('value-one')));
  assert.equal(existsSync(written.path), false);
  const config = written.text;
  assert.deepEqual(Object.keys(JSON.parse(config).mcpServers), ['crewkite', 'notes']);
  assert.deepEqual(JSON.parse(config).mcpServers.notes, {
    type: 'stdio',
    command: 'notes-server',
    args: ['--root', 'docs'],
    env: { NOTES_KEY: 'value-one' },
  });
  assert.ok(joined.launched.argv.includes('--strict-mcp-config'));
  assert.ok(!joined.launched.argv.some((arg) => arg.includes('mcp__notes')));
  // A link or a file already at the config path refuses the turn with one plain line. The client
  // never starts, nothing is written through the link or over the file, and what was placed stays.
  for (const kind of ['link', 'file'] as const) {
    let target = '';
    const planted = run(streamed(), null, [], 'ask', undefined, [], undefined, {
      mcp: notesServer('reads'),
      plant: (path) => {
        target = join(dirname(path), 'victim.txt');
        writeFileSync(target, 'untouched');
        if (kind === 'link') symlinkSync(target, path);
        else writeFileSync(path, 'untouched');
      },
    });
    t.after(planted.cleanup);
    const refused = await planted.handle.result;
    const path = join(planted.work, 'tmp', 'mcp.json');
    assert.equal(refused.stopReason, 'error', kind);
    assert.equal(refused.failure?.stage, 'launch', kind);
    assert.match(
      refused.failure?.message ?? '',
      /did not start this turn because a file or link already sits where it writes/,
      kind,
    );
    assert.deepEqual(planted.launched.argv, [], kind);
    assert.equal(readFileSync(target, 'utf8'), 'untouched', kind);
    assert.equal(readFileSync(path, 'utf8'), 'untouched', kind);
    assert.equal(lstatSync(path).isSymbolicLink(), kind === 'link', kind);
    assert.ok(!planted.events.some((event) => event.type === 'turn.started'), kind);
  }
  assert.ok(!declined.launched.argv.some((arg) => arg.includes('mcp__crewkite__')));
  // The source gives none although the controller expected tools: the packet loses its line, the
  // config is empty and the trace says so.
  const lost = run(
    streamed(),
    null,
    [],
    'ask',
    undefined,
    [],
    `${prompt}\n\n${THREAD_TOOLS_LINE}`,
    {
      threadTools: () => null,
    },
  );
  t.after(lost.cleanup);
  await lost.handle.result;
  assert.doesNotMatch(lost.launched.input.join(''), /Thread tools are available/);
  assert.ok(lost.launched.argv.includes('{"mcpServers":{}}'));
  assert.ok(
    lost.events.some(
      (event) =>
        event.type === 'provider.notice' &&
        event.trace === true &&
        /thread_live/.test(event.message),
    ),
  );
  // Each turn launched with its own token.
  const tokens = launches.map((args) => args[args.indexOf('--token') + 1]);
  assert.equal(tokens.length, 3);
  assert.equal(new Set(tokens).size, tokens.length);
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

test('the model read sends one initialize request and no prompt, keeps the picker rows it can read, and gives null when the client answers none', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crewkite-models-'));
  t.after(() => rmSync(root, { recursive: true }));
  const read = async (steps: Step[]) => {
    const sent: string[] = [];
    let argv: string[] = [];
    const models = await readAnthropicModels({
      executable: fixture,
      sha256,
      environment: { HOME: root, PATH: '/usr/bin:/bin' },
      directory: join(root, 'models'),
      timeoutMs: 20_000,
      spawn: (executable, args, options) => {
        argv = args;
        const child = spawnCheckChild(
          process.execPath,
          [executable, JSON.stringify(steps), ...args],
          options,
        ) as ReturnType<Spawn>;
        const write = child.stdin.write;
        child.stdin.write = function (this: unknown, ...args: unknown[]) {
          sent.push(String(args[0]));
          return Reflect.apply(write, this, args);
        } as typeof write;
        return child;
      },
    });
    return { models, sent, argv };
  };
  const answer = (models: unknown[]): Step[] => [
    'read',
    {
      out: {
        type: 'control_response',
        response: { subtype: 'success', request_id: 'models', response: { models } },
      },
    },
    'drain',
  ];
  const live = await read(
    answer([
      { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default' },
      {
        value: 'opus',
        resolvedModel: 'claude-opus-5-5',
        displayName: 'Opus 5.5',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'max'],
      },
      // A row without a value cannot be passed to --model, so it drops out.
      { displayName: 'Broken' },
      { value: 'haiku', supportsEffort: false, supportedEffortLevels: ['low'] },
    ]),
  );
  assert.deepEqual(live.models, [
    { value: 'default', model: 'claude-sonnet-5-5', label: 'Default', efforts: [] },
    { value: 'opus', model: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'high', 'max'] },
    { value: 'haiku', model: 'haiku', label: 'haiku', efforts: [] },
  ]);
  assert.deepEqual(
    live.sent.map((line) => JSON.parse(line)),
    [{ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }],
  );
  assert(!live.argv.includes('--model') && !live.argv.includes('--resume'));
  // A client that exits without answering, and one that answers with no rows, both read as none.
  assert.equal((await read(['read', { exit: 1 }])).models, null);
  assert.equal((await read(answer([]))).models, null);
});
