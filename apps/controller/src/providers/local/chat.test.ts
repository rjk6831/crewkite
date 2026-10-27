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
import { byteSize } from '../../chat/prompt.ts';
import { localSliceFits } from './budget.ts';
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
// `tokens` is the fragment's token count as the runtime reports it, one when left out.
type Step =
  | { text: string; tokens?: number }
  | { reasoning: string; tokens?: number }
  | { call: string; args: Record<string, unknown> }
  | { wait: () => void };
type Round = { steps: Step[]; stats: Partial<LLMPredictionStats> };

// The scripted rounds run across `act` calls, the way one model keeps answering a growing chat.
function fakeModel(
  rounds: Round[],
  clock: { now: number },
  countTokens: (text: string) => number = (text) => Math.ceil(text.length / 4),
) {
  const calls: {
    chat: ChatInput;
    tools: Tool[];
    signal?: AbortSignal;
    maxTokens?: number | false;
    reasoningBudget?: number | false;
  }[] = [];
  let next = 0;
  let callId = 0;
  const model: LoadedModelLike = {
    countTokens: async (text) => countTokens(text),
    async act(chat, tools, options) {
      calls.push({
        chat,
        tools,
        signal: options.signal,
        maxTokens: options.maxTokens,
        reasoningBudget: options.reasoningBudget,
      });
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
              tokensCount: step.tokens ?? 1,
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
  loaded: {
    modelKey?: string;
    fellBack?: boolean;
    vision?: boolean;
    reasoningBudget?: boolean;
  } = {},
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
            { reasoning: 'Find n first.', tokens: 90 },
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
        // Reasoning from the streamed fragments, and the rest of the output is reply.
        reasoningTokens: 90,
        replyTokens: 322,
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

test('the reply budget follows the reported context: compact when short, refuse when still short, report a cut reply', async () => {
  const roots: string[] = [];
  try {
    // Every count below is an input. Under this tokenizer the framing and the project outline
    // count one token each, a summary section one, and each message eight more for its role
    // markers. R is the context less the prompt less a 256 token margin, and a turn needs R of at
    // least the larger of 2,048 and 30% of the context.
    // The orchestrator's fit rule: room is 8,192 less the 256 margin, the 2,458 token reply floor,
    // the 1,474 token outline share and 300 for the summary, which leaves 3,704 tokens of files.
    for (const [files, context, image, fits] of [
      [[{ path: 'a.ts', bytes: 11_112 }], 8192, false, true],
      [[{ path: 'a.ts', bytes: 11_113 }], 8192, false, false],
      [
        [
          { path: 'a.ts', bytes: 5_000 },
          { path: 'b.ts', bytes: 6_113 },
        ],
        8192,
        false,
        false,
      ],
      [[{ path: 'a.ts', bytes: 10 }], 8192, true, false],
      [[{ path: 'a.ts', bytes: 10 }], 2048, false, false],
      [[{ path: 'a.ts', bytes: 300_000 }], 1_048_576, false, true],
    ] as const)
      assert.equal(localSliceFits(files, context, image), fits, JSON.stringify([files, context]));
    const prompt = 'Rename n to count in src/a.ts.';
    const floor = (context: number) => Math.max(2048, Math.ceil(context * 0.3));
    const framing = 1 + 8 + 1;
    const figure = (value: number) => value.toLocaleString('en-US');
    type Row = {
      label: string;
      context: number;
      message: number;
      /** What the whole conversation would leave for the reply. Absent: no earlier turns. */
      leaves?: number;
      reasoningBudget?: boolean;
      rounds?: Round[];
      expect: 'compacts' | 'refuses' | 'cut';
    };
    const rows: Row[] = [
      {
        label: '8,192 leaving 1,500',
        context: 8192,
        message: 100,
        leaves: 1500,
        expect: 'compacts',
      },
      {
        label: '8,192 with a message too large',
        context: 8192,
        message: 7000,
        leaves: 1500,
        expect: 'refuses',
      },
      {
        label: '1,048,576 leaving 300,000',
        context: 1_048_576,
        message: 100,
        leaves: 300_000,
        reasoningBudget: true,
        expect: 'compacts',
      },
      {
        label: '1,048,576 with a message too large',
        context: 1_048_576,
        message: 900_000,
        expect: 'refuses',
      },
      {
        label: '8,192 cut at the output limit',
        context: 8192,
        message: 8192 - 256 - 4600 - framing - 8,
        rounds: [
          {
            steps: [
              { reasoning: 'Thinking.', tokens: 3900 },
              { text: 'Partial reply.', tokens: 700 },
            ],
            stats: { stopReason: 'maxPredictedTokensReached', predictedTokensCount: 4600 },
          },
        ],
        expect: 'cut',
      },
    ];
    for (const row of rows) {
      // A fresh thread per row, so no row starts from the summary another one wrote.
      const { root, clock, request } = fixture();
      roots.push(root);
      const { context, message } = row;
      // Two earlier turns of equal size that make the whole prompt leave `leaves` for the reply.
      const turn =
        row.leaves === undefined
          ? 0
          : (context - 256 - row.leaves - framing - (message + 8)) / 2 - 8;
      const history: ChatHistoryEntry[] =
        row.leaves === undefined
          ? []
          : [
              { role: 'user', text: 'Earlier question.' },
              { role: 'assistant', text: 'Earlier answer.' },
            ];
      const sizes = new Map([
        [prompt, message],
        ['Earlier question.', turn],
        ['Earlier answer.', turn],
      ]);
      const { model, calls } = fakeModel(
        row.rounds ?? [{ steps: [{ text: 'Done.' }], stats: {} }],
        clock,
        (text) => sizes.get(text) ?? 1,
      );
      const turnStart = start(model, context, request(0, { prompt, history }), {
        reasoningBudget: row.reasoningBudget === true,
      });
      const result = await turnStart.handle.result;
      const { events } = turnStart;
      assert.equal(result.stopReason, 'done', row.label);
      if (row.expect === 'refuses') {
        // The framing and the message alone leave too little, so folding earlier turns cannot help
        // and the model is never called.
        const tokens = framing - 1 + message + 8;
        const sentence = `This request takes ${figure(tokens)} tokens of the Local model's ${figure(context)} token context and leaves ${figure(Math.max(0, context - tokens - 256))} for the reply, short of the ${figure(floor(context))} it needs. Send a smaller first step, such as one file or one function.`;
        assert.equal(calls.length, 0, row.label);
        assert.equal(result.assistantText, sentence, row.label);
        continue;
      }
      if (row.expect === 'compacts') {
        // The summary call comes first, then the turn runs with the summary in place of the turns.
        assert.equal(calls[0].tools.length, 0, row.label);
        const compacted = events.findIndex((event) => event.type === 'context.compacted');
        const answered = events.findIndex((event) => event.type === 'text.delta');
        assert(compacted >= 0 && compacted < answered, row.label);
        const turnCall = calls[1];
        assert.ok(turnCall.chat[0].content?.includes(SUMMARY), row.label);
        assert.deepEqual(
          turnCall.chat.slice(1).map((entry) => entry.content),
          [prompt],
          row.label,
        );
        const replyTokens = context - 256 - (framing + 1 + message + 8);
        assert.equal(turnCall.maxTokens, replyTokens, row.label);
        assert(replyTokens >= floor(context), row.label);
        assert.equal(
          turnCall.reasoningBudget,
          row.reasoningBudget ? Math.floor(replyTokens / 2) : undefined,
          row.label,
        );
        assert.equal(result.outputLimit, undefined, row.label);
        continue;
      }
      // The reply hit R. The counts go back so the service can say where the output went.
      assert.equal(calls[0].maxTokens, 4600, row.label);
      assert.equal(calls[0].reasoningBudget, undefined, row.label);
      const limit = { reasoningTokens: 3900, replyTokens: 700, allowedTokens: 4600 };
      assert.deepEqual(result.outputLimit, limit, row.label);
      const completed = events.at(-1);
      assert.deepEqual(
        completed?.type === 'turn.completed' && completed.outputLimit,
        limit,
        row.label,
      );
      assert.equal(result.assistantText, 'Partial reply.', row.label);
      assert(!events.some((event) => event.type === 'provider.notice'), row.label);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
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
    // Text shares what the prompt may hold: the context less the margin and the reply floor, at
    // eight bytes a token. One byte more goes by name alone.
    const room = (8192 - 256 - Math.max(2048, Math.ceil(8192 * 0.3))) * 8;
    const big = store('big.log', 'text/plain', 'x'.repeat(room + 1));
    const inlined =
      'Attached to this message: notes.md (text/markdown, 24 bytes). Its full content follows. It is not in the scratch copy, so do not read or search for it on disk.\n```\n# Notes\nn is the count.\n```';
    const notice = (event: AgentEvent) => (event.type === 'provider.notice' ? event.message : []);
    const rows: Array<{
      vision: boolean;
      files: NonNullable<ChatTurnRequest['files']>;
      message?: string;
      prepared: { name: string; base64: string }[];
      failure: string | null;
      notices?: string[];
    }> = [
      {
        // The packet lists earlier files, so an earlier PDF and an earlier image on a model
        // without vision are left out here and do not refuse the turn.
        vision: false,
        files: [{ ...shot, earlier: true }, { ...report, earlier: true }, notes],
        message: `Rename n to count in src/a.ts.\n\nFiles attached to this message:\n${inlined}`,
        prepared: [],
        failure: null,
      },
      {
        // A text file larger than the context can hold is never read and goes by name alone.
        vision: false,
        files: [big],
        message: `Rename n to count in src/a.ts.\n\nFiles attached to this message:\nbig.log, text/plain, ${byteSize(room + 1)}, too large for this model's context, so its content is not in this message`,
        prepared: [],
        failure: null,
        notices: ["Local: too large for the model's context, sent by name only: big.log."],
      },
    ];
    for (const row of [
      ...rows,
      {
        // The image rides on the person's message and the text file follows its words.
        vision: true,
        files: [shot, notes],
        message: `Rename n to count in src/a.ts.\n\nFiles attached to this message:\nshot.png, image/png, 10 bytes, sent as an image with this message\n${inlined}`,
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
        assert.deepEqual(message?.images ?? [], row.prepared);
        assert.equal(result.stopReason, 'done');
        if ('notices' in row && row.notices)
          for (const expected of row.notices)
            assert(turn.events.flatMap(notice).includes(expected), expected);
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
