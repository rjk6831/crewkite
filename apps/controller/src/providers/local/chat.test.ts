import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type AgentEvent, AgentEventSchema } from '@crewkite/contracts';
import type {
  ChatInput,
  ChatMessage,
  FileHandle,
  GuardToolCallController,
  LLM,
  LLMPredictionStats,
  PredictionResult,
  RawFunctionTool,
  Tool,
} from '@lmstudio/sdk';
import type { ChatHistoryEntry, ChatTurnHandle, ChatTurnRequest } from '../../chat/adapter.ts';
import { type LoadedModelLike, localChatAdapter, parseTextToolCalls } from './chat.ts';

// Frames assumed from @lmstudio/sdk 2.1.0, `LLMDynamicHandle.act` and `internalAct` in
// dist/index.mjs. A live run against LM Studio confirms them.
// - onPredictionFragment({ roundIndex, content, tokensCount, containsDrafted, reasoningType,
//   isStructural }), reasoningType one of none, reasoning, reasoningStartTag, reasoningEndTag.
// - Each parsed tool call: guardToolCall(roundIndex, callId, controller) with
//   controller.toolCallRequest = { type: 'function', name, arguments }. The guard calls allow()
//   or deny(reason). An allowed call then runs tool.implementation(arguments, { callId, signal,
//   status, warn }), one call at a time.
// - onPredictionCompleted(result) once per round. result.stats carries stopReason,
//   promptTokensCount, predictedTokensCount, timeToFirstTokenSec and tokensPerSecond.
// - onRoundEnd(roundIndex) after the round's tool calls finish. Tool results start a new round.
// - Aborting options.signal sends `cancel` on the predict channel, and act rejects.

// The SDK's loaded model must keep fitting the adapter's interface across SDK upgrades.
const sdkModelFits: LLM extends LoadedModelLike ? true : false = true;

const SUMMARY = 'Renaming n to count in src/a.ts was agreed.';
type Step =
  | { text: string }
  | { reasoning: string }
  | { call: string; args: Record<string, unknown> }
  | { wait: () => void };
type Round = { steps: Step[]; stats: Partial<LLMPredictionStats> };

// The scripted rounds run across `act` calls, the way one model keeps answering a growing chat.
function fakeModel(rounds: Round[], clock: { now: number }) {
  const calls: { chat: ChatInput; tools: Tool[]; signal?: AbortSignal }[] = [];
  let next = 0;
  let callId = 0;
  const model: LoadedModelLike = {
    countTokens: async (text) => Math.ceil(text.length / 4),
    async act(chat, tools, options) {
      calls.push({ chat, tools, signal: options.signal });
      if (!tools.length) {
        const stats = { stopReason: 'eosFound' };
        options.onPredictionCompleted?.({
          nonReasoningContent: SUMMARY,
          stats,
        } as PredictionResult);
        return;
      }
      for (let roundIndex = 0; next < rounds.length; roundIndex++) {
        const round = rounds[next++];
        let content = '';
        let native = false;
        for (const step of round.steps) {
          options.signal?.throwIfAborted();
          if ('text' in step || 'reasoning' in step) {
            const fragment = 'text' in step ? step.text : step.reasoning;
            content += fragment;
            options.onPredictionFragment?.({
              roundIndex,
              content: fragment,
              reasoningType: 'text' in step ? 'none' : 'reasoning',
              tokensCount: 1,
              containsDrafted: false,
              isStructural: false,
            });
          } else if ('wait' in step)
            await new Promise((_, reject) => {
              options.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
              step.wait();
            });
          else {
            native = true;
            const tool = tools.find((candidate) => candidate.name === step.call) as RawFunctionTool;
            const id = callId++;
            let allowed = false;
            await options.guardToolCall?.(roundIndex, id, {
              toolCallRequest: { type: 'function', name: step.call, arguments: step.args },
              tool,
              allow: () => {
                allowed = true;
              },
              deny: () => {},
            } as unknown as GuardToolCallController);
            if (allowed)
              await tool.implementation(step.args, {
                callId: id,
                signal: new AbortController().signal,
                status: () => {},
                warn: () => {},
              });
          }
        }
        clock.now += 1000;
        const stats = { stopReason: 'eosFound', ...round.stats };
        options.onPredictionCompleted?.({ stats } as PredictionResult);
        options.onMessage?.({
          getRole: () => 'assistant',
          getText: () => content,
          getToolCallRequests: () => [],
          getToolCallResults: () => [],
        } as unknown as ChatMessage);
        options.onRoundEnd?.(roundIndex);
        // The runtime ends `act` after a round without a native call.
        if (!native) return;
      }
    },
  };
  return { model, calls };
}

const turnIds = ['trn_01J00000000000000000000000', 'trn_01J00000000000000000000001'];
const taskId = 'tsk_01J00000000000000000000000';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-chat-'));
  const scratch = join(root, 'scratch');
  const home = join(root, 'home');
  mkdirSync(join(scratch, 'src'), { recursive: true });
  writeFileSync(join(scratch, 'src/a.ts'), 'export const n = 1;\nexport const twice = n * 2;\n');
  const clock = { now: Date.UTC(2026, 9, 23, 12) };
  const request = (turn: number, overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest => ({
    turnId: turnIds[turn],
    taskId,
    role: 'assistant',
    selection: { family: 'local', model: 'local-fixture', effort: 'default' },
    prompt: 'Rename n to count in src/a.ts.',
    systemContext: 'You are working in a scratch copy of fixture.',
    history: [],
    session: null,
    scratch: { directory: scratch, base: 'a'.repeat(40), projectName: 'fixture' },
    work: { directory: join(home, 'chat', taskId, turnIds[turn]), home },
    permissionPolicy: 'ask',
    deadlineMs: 60_000,
    environment: { PATH: process.env.PATH },
    now: () => clock.now,
    ...overrides,
  });
  return { root, scratch, home, clock, request };
}

function start(
  model: LoadedModelLike,
  contextLength: number,
  request: ChatTurnRequest,
  loaded: { modelKey?: string; fellBack?: boolean; vision?: boolean } = {},
) {
  const events: AgentEvent[] = [];
  let handle: ChatTurnHandle | undefined;
  let disposals = 0;
  // Each prepared image comes back as a handle naming the file and its bytes.
  const prepared: { name: string; base64: string }[] = [];
  const adapter = localChatAdapter({
    connect: async () => ({
      model,
      contextLength,
      modelKey: 'local-fixture',
      fellBack: false,
      vision: false,
      ...loaded,
      files: {
        prepareImageBase64: async (name, base64) => {
          prepared.push({ name, base64 });
          return { name, base64 } as unknown as FileHandle;
        },
      },
      dispose: async () => {
        disposals++;
      },
    }),
  });
  handle = adapter.startTurn(request, (event) => {
    events.push(AgentEventSchema.parse(event));
    if (event.type === 'permission.requested')
      handle?.respondPermission(event.requestId, 'allow-once');
  });
  return { events, handle, disposals: () => disposals, prepared };
}

test('a local turn streams, reads freely, edits after permission and reports its stats', async () => {
  assert.equal(sdkModelFits, true);
  const { root, scratch, home, clock, request } = fixture();
  try {
    const history: ChatHistoryEntry[] = [
      { role: 'user', text: 'What is n?' },
      { role: 'assistant', text: 'A constant in src/a.ts.' },
    ];
    const first = fakeModel(
      [
        {
          steps: [
            { reasoning: 'Find n first.' },
            { text: 'Reading the file.' },
            { call: 'read_range', args: { path: 'src/a.ts', start: 1, end: 2 } },
          ],
          stats: {
            promptTokensCount: 5000,
            predictedTokensCount: 100,
            timeToFirstTokenSec: 1.9,
            tokensPerSecond: 21,
          },
        },
        {
          steps: [
            {
              call: 'edit',
              args: {
                path: 'src/a.ts',
                old: 'export const n = 1;',
                new: 'export const count = 1;',
              },
            },
          ],
          stats: { promptTokensCount: 5600, predictedTokensCount: 100, tokensPerSecond: 21 },
        },
        {
          steps: [{ text: 'Renamed n to count.' }],
          stats: { promptTokensCount: 5842, predictedTokensCount: 212, tokensPerSecond: 21 },
        },
      ],
      clock,
    );
    const turn = start(first.model, 8192, request(0, { history }));
    const result = await turn.handle.result;
    const { events } = turn;

    assert.deepEqual(
      events.map((event) => event.type),
      [
        'turn.started',
        'thinking.delta',
        'thinking.completed',
        'text.delta',
        'text.completed',
        'tool.started',
        'tool.output',
        'tool.completed',
        'tool.started',
        'permission.requested',
        'permission.resolved',
        'tool.output',
        'tool.completed',
        'text.delta',
        'text.completed',
        'context.compacted',
        'usage.context',
        'turn.stats',
        'turn.completed',
      ],
    );
    const started = events.filter((event) => event.type === 'tool.started');
    assert.deepEqual(
      started.map((event) => [event.kind, event.title]),
      [
        ['read', 'Read src/a.ts:1-2'],
        ['edit', 'Edit src/a.ts'],
      ],
    );
    const asked = events.find((event) => event.type === 'permission.requested');
    assert.equal(asked?.callId, started[1].callId);
    assert.deepEqual(events.at(-2), {
      type: 'turn.stats',
      turnId: turnIds[0],
      stats: {
        tokensIn: 5842,
        tokensOut: 412,
        tokensPerSecond: 21,
        firstTokenMs: 1900,
        turnMs: 3000,
        contextUsed: 6054,
        contextCapacity: 8192,
        summaries: 1,
      },
    });
    assert.deepEqual(events.at(-3), {
      type: 'usage.context',
      turnId: turnIds[0],
      usedTokens: 6054,
      capacityTokens: 8192,
    });
    assert.equal(
      readFileSync(join(scratch, 'src/a.ts'), 'utf8'),
      'export const count = 1;\nexport const twice = n * 2;\n',
    );
    assert.equal(result.stopReason, 'done');
    assert.equal(result.failure, null);
    assert.equal(result.assistantText, 'Reading the file.\n\nRenamed n to count.');
    assert.deepEqual(result.changedPaths, ['src/a.ts']);
    assert.equal(result.session?.sessionId, 'local-fixture');
    const system = first.calls[0].chat[0].content ?? '';
    assert.match(
      system,
      /Project outline, most imported files first:\nsrc\/a\.ts\n {2}const n = 1/,
    );
    assert.equal(first.calls[0].chat[1].content, 'What is n?');

    // The first round carried more than 60% of the context, so earlier turns were summarized
    // into a sidecar file. The summary stays out of the thread.
    assert.equal(first.calls.length, 2);
    assert.equal(first.calls[1].tools.length, 0);
    const sidecar = JSON.parse(
      readFileSync(join(home, 'chat', taskId, 'local-summary.json'), 'utf8'),
    );
    assert.equal(sidecar.summary, SUMMARY);
    assert.equal(sidecar.covered, 2);
    assert.ok(!JSON.stringify(events).includes(SUMMARY));

    // The next turn sends the summary in place of the turns it covers.
    const second = fakeModel([{ steps: [{ text: 'Done.' }], stats: {} }], clock);
    const later = [
      ...history,
      { role: 'user', text: 'Rename n to count in src/a.ts.' },
      { role: 'assistant', text: result.assistantText },
    ] satisfies ChatHistoryEntry[];
    // The requested model is not loaded on this turn, so the first loaded one answers. The turn
    // says so once, and the session records the model that answered.
    const fallback = start(second.model, 8192, request(1, { history: later, prompt: 'Thanks.' }), {
      modelKey: 'loaded-fixture',
      fellBack: true,
    });
    const next = await fallback.handle.result;
    assert.deepEqual(fallback.events[1], {
      type: 'provider.notice',
      turnId: turnIds[1],
      level: 'warning',
      message:
        'Local: local-fixture is not loaded, so loaded-fixture answered. Load local-fixture or pick loaded-fixture in the composer.',
    });
    assert.equal(fallback.events.filter((event) => event.type === 'provider.notice').length, 1);
    assert.equal(next.session?.sessionId, 'loaded-fixture');
    assert.equal(next.session?.model, 'loaded-fixture');
    const chat = second.calls[0].chat;
    assert.ok(chat[0].content?.includes(SUMMARY));
    assert.deepEqual(
      chat.slice(1).map((message) => message.content),
      ['Rename n to count in src/a.ts.', result.assistantText, 'Thanks.'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a turn that compacts emits context.compacted and ends with turn.stats carrying the summary count', async () => {
  const { root, home, clock, request } = fixture();
  try {
    // A summary already covers the first two entries, so this turn carries it and then extends it.
    const history: ChatHistoryEntry[] = [
      { role: 'user', text: 'What is n?' },
      { role: 'assistant', text: 'A constant in src/a.ts.' },
      { role: 'user', text: 'Where is it used?' },
      { role: 'assistant', text: 'In twice, on the next line.' },
    ];
    const sidecar = join(home, 'chat', taskId, 'local-summary.json');
    mkdirSync(join(home, 'chat', taskId), { recursive: true });
    writeFileSync(
      sidecar,
      JSON.stringify({
        version: 1,
        covered: 2,
        coveredHash: createHash('sha256')
          .update(JSON.stringify(history.slice(0, 2).map((entry) => [entry.role, entry.text])))
          .digest('hex'),
        summary: 'n is a constant in src/a.ts.',
      }),
    );
    const { model } = fakeModel(
      [
        {
          steps: [{ text: 'Done.' }],
          stats: { promptTokensCount: 6000, predictedTokensCount: 97 },
        },
      ],
      clock,
    );
    const turn = start(model, 8192, request(0, { history }));
    await turn.handle.result;

    assert.deepEqual(
      turn.events.slice(-4).map((event) => event.type),
      ['context.compacted', 'usage.context', 'turn.stats', 'turn.completed'],
    );
    assert.deepEqual(turn.events.at(-4), {
      type: 'context.compacted',
      turnId: turnIds[0],
      summaries: 2,
      coveredTurns: 2,
      usedTokens: 6097,
      capacityTokens: 8192,
    });
    const stats = turn.events.at(-2);
    assert.equal(stats?.type === 'turn.stats' && stats.stats.summaries, 2);
    assert.equal(JSON.parse(readFileSync(sidecar, 'utf8')).count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tool calls written as text run through the same gate and their results go back', async () => {
  const { root, scratch, clock, request } = fixture();
  try {
    const json =
      '<tool_call>{"name": "read_range", "arguments": {"path": "src/a.ts", "start": 1, "end": 2}}</tool_call>';
    const tagged =
      '<tool_call>\n<function=edit>\n<path>src/a.ts</path>\n<parameter=old>\nexport const n = 1;\n</parameter>\n<parameter=new>\nexport const count = 1;\n</parameter>\n</function>\n</tool_call>';
    const stats = (promptTokensCount: number, predictedTokensCount: number) => ({
      promptTokensCount,
      predictedTokensCount,
      tokensPerSecond: 20,
    });
    const { model, calls } = fakeModel(
      [
        {
          // The opening tag arrives split across fragments.
          steps: [
            { reasoning: 'Let me read the file.' },
            { text: 'Reading src/a.ts.\n<tool' },
            { text: json.slice(5, 40) },
            { text: json.slice(40) },
          ],
          stats: stats(900, 40),
        },
        { steps: [{ text: tagged }], stats: stats(1100, 60) },
        {
          steps: [{ text: '<function=read_range><parameter=path>src/a.ts</function>' }],
          stats: stats(1300, 20),
        },
        { steps: [{ text: 'Renamed n to count.' }], stats: stats(1400, 10) },
      ],
      clock,
    );
    const turn = start(model, 8192, request(0));
    const result = await turn.handle.result;
    const { events } = turn;

    assert.deepEqual(
      events.map((event) => event.type),
      [
        'turn.started',
        'thinking.delta',
        'thinking.completed',
        'text.delta',
        'text.completed',
        'tool.started',
        'tool.output',
        'tool.completed',
        'tool.started',
        'permission.requested',
        'permission.resolved',
        'tool.output',
        'tool.completed',
        'provider.notice',
        'text.delta',
        'text.completed',
        'usage.context',
        'turn.stats',
        'turn.completed',
      ],
    );
    const started = events.filter((event) => event.type === 'tool.started');
    assert.deepEqual(
      started.map((event) => [event.kind, event.title]),
      [
        ['read', 'Read src/a.ts:1-2'],
        ['edit', 'Edit src/a.ts'],
      ],
    );
    const asked = events.find((event) => event.type === 'permission.requested');
    assert.equal(asked?.callId, started[1].callId);
    assert.deepEqual(
      events.flatMap((event) => (event.type === 'text.delta' ? [event.text] : [])),
      ['Reading src/a.ts.\n', 'Renamed n to count.'],
    );
    assert.equal(
      readFileSync(join(scratch, 'src/a.ts'), 'utf8'),
      'export const count = 1;\nexport const twice = n * 2;\n',
    );

    // Each result goes back after the model's own words, and the next round starts from there.
    assert.equal(calls.length, 4);
    assert.match(calls[1].chat.at(-2)?.content ?? '', /Reading src\/a\.ts\.\n<tool_call>\{"name"/);
    assert.deepEqual(calls[1].chat.at(-1), {
      role: 'user',
      content:
        '<tool_response>\nsrc/a.ts lines 1-2 of 2\n1: export const n = 1;\n2: export const twice = n * 2;\n</tool_response>',
    });
    assert.match(calls[2].chat.at(-1)?.content ?? '', /^<tool_response>\nEdited src\/a\.ts\./);
    assert.match(calls[3].chat.at(-1)?.content ?? '', /That tool call could not be read/);
    assert.equal(calls[3].chat.length, 8);

    assert.deepEqual(
      events.filter((event) => event.type === 'provider.notice').map((event) => event.message),
      [
        // The unreadable call is a notice, so it stays out of the stored reply.
        'Local: the model wrote a tool call CrewKite could not read. Try again or pick another model.',
      ],
    );
    assert.equal(result.stopReason, 'done');
    assert.equal(result.assistantText, 'Reading src/a.ts.\n\n\nRenamed n to count.');
    assert.deepEqual(result.changedPaths, ['src/a.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stop cancels the model mid-turn and ends the turn as stopped', async () => {
  const { root, clock, request } = fixture();
  try {
    let turn: ReturnType<typeof start> | undefined;
    const { model, calls } = fakeModel(
      [
        {
          steps: [
            { text: 'Working.' },
            { call: 'read_range', args: { path: 'src/a.ts', start: 1, end: 1 } },
          ],
          stats: { promptTokensCount: 900, predictedTokensCount: 20, tokensPerSecond: 10 },
        },
        { steps: [{ wait: () => turn?.handle.stop() }, { text: 'Never sent.' }], stats: {} },
      ],
      clock,
    );
    turn = start(model, 8192, request(0));
    const result = await turn.handle.result;

    assert.equal(calls[0].signal?.aborted, true);
    assert.equal(result.stopReason, 'stopped');
    assert.equal(result.failure?.kind, 'stopped');
    assert.equal(result.assistantText, 'Working.');
    assert.deepEqual(turn.events.at(-1), {
      type: 'turn.completed',
      turnId: turnIds[0],
      stopReason: 'stopped',
      failure: result.failure,
    });
    assert.ok(!JSON.stringify(turn.events).includes('Never sent.'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the local client is disposed when the turn ends', async () => {
  const { root, clock, request } = fixture();
  try {
    let turn: ReturnType<typeof start> | undefined;
    const failing: LoadedModelLike = {
      countTokens: async (text) => Math.ceil(text.length / 4),
      act: async () => {
        throw new Error('socket hang up');
      },
    };
    const finishing = fakeModel([{ steps: [{ text: 'Done.' }], stats: {} }], clock).model;
    const stopping = fakeModel(
      [{ steps: [{ wait: () => turn?.handle.stop() }], stats: {} }],
      clock,
    ).model;
    for (const [stopReason, model] of [
      ['done', finishing],
      ['stopped', stopping],
      ['error', failing],
    ] as const) {
      turn = start(model, 8192, request(0));
      const result = await turn.handle.result;
      assert.equal(result.stopReason, stopReason);
      assert.equal(turn.disposals(), 1, stopReason);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tool call written as text parses in each form small models use', () => {
  const read = { name: 'read_range', arguments: { path: 'src/a.ts', start: 1, end: 2 } };
  const cases: [form: string, text: string, calls: unknown[], rest: string][] = [
    [
      'json',
      'Reading.\n<tool_call>{"name": "read_range", "arguments": {"path": "src/a.ts", "start": 1, "end": 2}}</tool_call>',
      [read],
      'Reading.\n',
    ],
    [
      'parameter tags',
      '<tool_call><function=read_range><parameter=path>src/a.ts</parameter><parameter=start>1</parameter><parameter=end>2</parameter></function></tool_call>',
      [read],
      '',
    ],
    [
      'a tag per parameter',
      '<tool_call>\n<function=read_range>\n<path>src/a.ts</path>\n<parameter=start>\n1\n</parameter>\n<end>2</end>\n</function>\n</tool_call>',
      [read],
      '',
    ],
    [
      'bare function',
      '<function=search>\n<parameter=pattern>\ndef \n</parameter>\n</function>\nDone.',
      [{ name: 'search', arguments: { pattern: 'def ' } }],
      '\nDone.',
    ],
    [
      'unknown tool',
      '<tool_call>{"name": "list_files", "arguments": {}}</tool_call>',
      ['There is no tool named list_files. Use read_range, search, edit, write, run.'],
      '',
    ],
    [
      'malformed',
      '<tool_call>{"name": "read_range", "arguments": {"path": </tool_call> Then more.',
      [/^That tool call could not be read\./],
      ' Then more.',
    ],
    ['plain text', 'Use a <b> tag when a < b.', [], 'Use a <b> tag when a < b.'],
  ];
  for (const [form, text, calls, rest] of cases) {
    const parsed = parseTextToolCalls(text);
    assert.equal(parsed.calls.length, calls.length, form);
    for (const [index, call] of parsed.calls.entries()) {
      const expected = calls[index];
      if (expected instanceof RegExp) assert.match(call.ok ? '' : call.error, expected, form);
      else
        assert.deepEqual(
          call.ok ? { name: call.name, arguments: call.arguments } : call.error,
          expected,
          form,
        );
    }
    assert.equal(parsed.rest, rest, form);
  }
});

test('a prompt larger than the context gets one line asking for a smaller first step', async () => {
  const { root, clock, request } = fixture();
  try {
    const { model, calls } = fakeModel([], clock);
    const turn = start(model, 1000, request(0, { prompt: 'x'.repeat(4000) }));
    const result = await turn.handle.result;
    const sentence =
      "This request is too large for the Local model's 1,000 token context. Send a smaller first step, such as one file or one function.";

    assert.equal(calls.length, 0);
    assert.deepEqual(
      turn.events.map((event) => event.type),
      ['turn.started', 'text.delta', 'text.completed', 'turn.completed'],
    );
    assert.deepEqual(turn.events[2], {
      type: 'text.completed',
      turnId: turnIds[0],
      itemId: `${turnIds[0]}:item-1`,
      text: sentence,
    });
    assert.equal(result.stopReason, 'done');
    assert.equal(result.failure, null);
    assert.equal(result.assistantText, sentence);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('files reach a Local turn as images on a vision model and as inlined text, and anything else is refused before act', async () => {
  const { root, home, clock, request } = fixture();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);
    const store = (name: string, mimeType: string, body: string | Buffer) => {
      const id = createHash('sha256').update(body).digest('hex');
      const path = join(home, 'chat', taskId, 'files', id, name);
      mkdirSync(join(home, 'chat', taskId, 'files', id), { recursive: true });
      writeFileSync(path, body);
      return { attachment: { id, name, mimeType, bytes: Buffer.byteLength(body) }, path };
    };
    const shot = store('shot.png', 'image/png', png);
    const notes = store('notes.md', 'text/markdown', '# Notes\nn is the count.\n');
    const report = store('report.pdf', 'application/pdf', '%PDF-1.7 fixture');
    const latin = store('latin.txt', 'text/plain', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    for (const row of [
      {
        // The image rides on the person's message and the text file follows its words.
        vision: true,
        files: [shot, notes],
        message:
          'Rename n to count in src/a.ts.\n\nAttached file notes.md:\n# Notes\nn is the count.\n',
        prepared: [{ name: 'shot.png', base64: png.toString('base64') }],
        failure: null,
      },
      {
        vision: false,
        files: [shot],
        prepared: [],
        failure: 'Local cannot take shot.png: the loaded model local-fixture does not take images.',
      },
      {
        vision: true,
        files: [report, latin],
        prepared: [],
        failure:
          'Local cannot take report.pdf: Local takes images and text files, and this file is application/pdf; latin.txt: it is not UTF-8 text.',
      },
    ]) {
      const { model, calls } = fakeModel([{ steps: [{ text: 'Seen.' }], stats: {} }], clock);
      const turn = start(model, 8192, request(0, { files: row.files }), { vision: row.vision });
      const result = await turn.handle.result;
      assert.deepEqual(turn.prepared, row.prepared, row.failure ?? 'accepted');
      if (row.failure === null) {
        const message = calls[0].chat.at(-1);
        assert.equal(message?.content, row.message);
        assert.deepEqual(message?.images, row.prepared);
        assert.equal(result.stopReason, 'done');
        continue;
      }
      // Refused before the model ran, so no round and no stats.
      assert.equal(calls.length, 0, row.failure);
      assert.deepEqual(
        turn.events.map((event) => event.type),
        ['turn.started', 'turn.completed'],
      );
      assert.equal(result.stopReason, 'error');
      assert.equal(result.failure?.kind, 'attachment-rejected');
      assert.equal(result.failure?.message, row.failure);
      assert.equal(result.failure?.nextAction, 'Try another provider for these files.');
      assert.equal(turn.disposals(), 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
