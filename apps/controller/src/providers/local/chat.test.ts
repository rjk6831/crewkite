import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type AgentEvent, AgentEventSchema } from '@crewkite/contracts';
import type {
  ChatInput,
  GuardToolCallController,
  LLM,
  LLMPredictionStats,
  PredictionResult,
  RawFunctionTool,
  Tool,
} from '@lmstudio/sdk';
import type { ChatHistoryEntry, ChatTurnHandle, ChatTurnRequest } from '../../chat/adapter.ts';
import { type LoadedModelLike, localChatAdapter } from './chat.ts';

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

function fakeModel(rounds: Round[], clock: { now: number }) {
  const calls: { chat: ChatInput; tools: Tool[]; signal?: AbortSignal }[] = [];
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
      let callId = 0;
      for (const [roundIndex, round] of rounds.entries()) {
        for (const step of round.steps) {
          options.signal?.throwIfAborted();
          if ('text' in step || 'reasoning' in step)
            options.onPredictionFragment?.({
              roundIndex,
              content: 'text' in step ? step.text : step.reasoning,
              reasoningType: 'text' in step ? 'none' : 'reasoning',
              tokensCount: 1,
              containsDrafted: false,
              isStructural: false,
            });
          else if ('wait' in step)
            await new Promise((_, reject) => {
              options.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
              step.wait();
            });
          else {
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
        options.onRoundEnd?.(roundIndex);
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

function start(model: LoadedModelLike, contextLength: number, request: ChatTurnRequest) {
  const events: AgentEvent[] = [];
  let handle: ChatTurnHandle | undefined;
  const adapter = localChatAdapter({
    connect: async () => ({ model, contextLength, modelKey: 'local-fixture' }),
  });
  handle = adapter.startTurn(request, (event) => {
    events.push(AgentEventSchema.parse(event));
    if (event.type === 'permission.requested')
      handle?.respondPermission(event.requestId, 'allow-once');
  });
  return { events, handle };
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
        'provider.notice',
        'usage.context',
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
      events.filter((event) => event.type === 'provider.notice').map((event) => event.message),
      ['Local: 5,842 in, 412 out, 1.9 s to first token, 21 tok/s, 3.0 s total'],
    );
    assert.deepEqual(events.at(-2), {
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
    await start(second.model, 8192, request(1, { history: later, prompt: 'Thanks.' })).handle
      .result;
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
