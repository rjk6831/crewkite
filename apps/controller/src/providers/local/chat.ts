import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentEvent, ChatFailure, ChatPermissionOption } from '@crewkite/contracts';
import type {
  ChatInput,
  ChatMessage,
  ChatMessageInput,
  LLMActionOpts,
  LLMPredictionStats,
  PredictionResult,
  Tool,
} from '@lmstudio/sdk';
import { z } from 'zod';
import {
  type ChatAdapter,
  type ChatHistoryEntry,
  type ChatTurnHandle,
  type ChatTurnRequest,
  type ChatTurnResult,
  chatFailure,
} from '../../chat/adapter.ts';
import {
  fitBytes,
  LOCAL_TOOLS,
  listFiles,
  type PreparedTool,
  prepareTool,
  READ_LINES,
  RUN_SECONDS,
  RUN_TAIL_LINES,
  SEARCH_HITS,
  scratchPath,
} from '../../chat/local-tools.ts';
import { cachedRepoMap } from '../../chat/repo-map.ts';

// Local chat over the LM Studio SDK. The model has no agent loop of its own, so CrewKite runs
// it: a small prompt (framing, a repo map, a rolling summary, the recent turns), the SDK's
// `act` rounds with CrewKite's bounded tools, and permission prompts for edits and commands.
// Type-only SDK imports keep the SDK runtime out of this module; `connect` supplies the model.

/** The part of the SDK's loaded model this adapter uses. The SDK's `LLM` satisfies it. */
export type LoadedModelLike = {
  act(chat: ChatInput, tools: Tool[], options: LLMActionOpts): Promise<unknown>;
  countTokens(text: string): Promise<number>;
};
/**
 * `fellBack` is true when the requested model is not loaded and `modelKey` names another one.
 * `dispose` closes the runtime client the connection opened. It is safe to call more than once.
 */
export type LocalConnect = (request: ChatTurnRequest) => Promise<{
  model: LoadedModelLike;
  contextLength: number;
  modelKey: string;
  fellBack: boolean;
  dispose: () => Promise<void>;
}>;

const MAX_TOOL_CALLS = 12;
// Each round gets tools until the last one, which must answer in text.
const MAX_ROUNDS = MAX_TOOL_CALLS + 2;
const CHANGING_TOOLS = new Set<string>(['edit', 'write', 'run']);
// Review and advice turns read only.
const offeredTools = (request: ChatTurnRequest) =>
  LOCAL_TOOLS.filter(
    ({ function: definition }) => !request.readOnly || !CHANGING_TOOLS.has(definition.name),
  );
const OUTPUT_SHARE = 0.25;
const MAP_SHARE = 0.18;
const SUMMARY_SHARE = 0.6;
const SUMMARY_TOKENS = 300;
// Chat templates wrap each message in role markers. This is a margin, measured nowhere.
const MESSAGE_TOKENS = 8;
const OUTPUT_BYTES = 64 * 1024;
// Stop asks the runtime to cancel. A runtime that does not answer still frees the turn after this.
const CANCEL_GRACE_MS = 2000;

const PERMISSION_OPTIONS: ChatPermissionOption[] = [
  { id: 'allow-once', label: 'Allow once', kind: 'allow-once' },
  { id: 'allow-thread', label: 'Allow for this thread', kind: 'allow-thread' },
  { id: 'deny', label: 'Deny', kind: 'deny' },
];

const SETTINGS_ACTION = 'Open LM Studio, load a model and connect Local in Settings.';
const SHORTEN_ACTION = 'Shorten the request or split it into smaller steps, then send again.';

function systemPrompt(request: ChatTurnRequest, outputTokens: number) {
  const names = offeredTools(request).map((tool) => tool.function.name);
  return [
    request.systemContext,
    '',
    'You work through tools. Search for names and read the lines you need before you answer. Paths are relative to the project root.',
    // Some chat templates have no native tool calls. The loop reads this form from the reply.
    `Call one tool at a time: ${names.slice(0, -1).join(', ')} or ${names.at(-1)}. If you have no native tool calling, write the call as ${TEXT_CALL_EXAMPLE} and end your reply there.`,
    `Tool results are bounded: read_range returns at most ${READ_LINES} lines, search at most ${SEARCH_HITS} hits, and run the last ${RUN_TAIL_LINES} lines of output within ${RUN_SECONDS} seconds.`,
    'Read narrow ranges. The context window is small and every result stays in it until the turn ends.',
    'Use edit for exact replacements in existing files and write only for new files. The person may decline an edit or a command; continue without it.',
    `You can make at most ${MAX_TOOL_CALLS} tool calls in one turn. Each reply can use at most ${outputTokens} tokens, so keep answers short.`,
  ].join('\n');
}

// The rolling summary is model input only and never reaches the thread, so the person keeps the
// raw turns. It sits beside the task's turn directories, in <home>/chat/<taskId>/local-summary.json,
// and records how many history entries it covers with their hash. When the history under it
// changes, the hash no longer matches and the summary is ignored.
const SummarySchema = z.object({
  version: z.literal(1),
  covered: z.number().int().nonnegative(),
  coveredHash: z.string(),
  summary: z.string().min(1).max(16_384),
});
type Summary = z.output<typeof SummarySchema>;
const summaryFile = (request: ChatTurnRequest) =>
  join(dirname(request.work.directory), 'local-summary.json');
const historyHash = (entries: readonly ChatHistoryEntry[]) =>
  createHash('sha256')
    .update(JSON.stringify(entries.map((entry) => [entry.role, entry.text])))
    .digest('hex');

function loadSummary(request: ChatTurnRequest): Summary | null {
  try {
    const saved = SummarySchema.parse(JSON.parse(readFileSync(summaryFile(request), 'utf8')));
    const covered = request.history.slice(0, saved.covered);
    if (covered.length !== saved.covered || historyHash(covered) !== saved.coveredHash) return null;
    return saved;
  } catch {
    return null;
  }
}

function saveSummary(request: ChatTurnRequest, summary: string) {
  const file = summaryFile(request);
  const value: Summary = {
    version: 1,
    covered: request.history.length,
    coveredHash: historyHash(request.history),
    summary,
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

type Prompt = { kind: 'fits'; chat: ChatInput; summary: Summary | null } | { kind: 'too-large' };

async function buildPrompt(
  request: ChatTurnRequest,
  model: LoadedModelLike,
  contextLength: number,
  warn: (message: string) => void,
): Promise<Prompt> {
  const outputTokens = Math.floor(contextLength * OUTPUT_SHARE);
  const count = async (text: string) => (await model.countTokens(text)) + MESSAGE_TOKENS;
  let left = contextLength - outputTokens;
  let system = systemPrompt(request, outputTokens);
  left -= (await count(system)) + (await count(request.prompt));
  if (left < 0) return { kind: 'too-large' };

  const mapBudget = Math.min(Math.floor(contextLength * MAP_SHARE), left);
  if (mapBudget >= 64) {
    try {
      const root = request.scratch.directory;
      const map = cachedRepoMap(join(request.work.home, 'chat', 'repo-maps'), {
        base: request.scratch.base,
        // Listing the tree is only needed when the cache misses.
        get files() {
          return listFiles(root, request.environment);
        },
        read: (path) => readFileSync(scratchPath(root, path).full, 'utf8'),
        budgetTokens: mapBudget,
      });
      const section = `\n\nProject outline, most imported files first:\n${map.text}`;
      const tokens = await model.countTokens(section);
      if (tokens <= left) {
        system += section;
        left -= tokens;
      }
    } catch {
      warn('Local: the project outline is unavailable for this turn.');
    }
  }

  let history = request.history;
  const summary = loadSummary(request);
  if (summary) {
    const section = `\n\nSummary of earlier turns in this thread:\n${summary.summary}`;
    const tokens = await model.countTokens(section);
    if (tokens <= left) {
      system += section;
      left -= tokens;
      history = history.slice(summary.covered);
    }
  }
  const kept: ChatHistoryEntry[] = [];
  for (let index = history.length - 1; index >= 0; index--) {
    const tokens = await count(history[index].text);
    if (tokens > left) break;
    kept.unshift(history[index]);
    left -= tokens;
  }
  // Chat templates expect the conversation to open with the person.
  while (kept[0]?.role === 'assistant') kept.shift();
  return {
    kind: 'fits',
    summary,
    chat: [
      { role: 'system', content: system },
      ...kept.map((entry) => ({ role: entry.role, content: entry.text })),
      { role: 'user', content: request.prompt },
    ],
  };
}

async function summarize(
  request: ChatTurnRequest,
  model: LoadedModelLike,
  contextLength: number,
  previous: Summary | null,
  signal: AbortSignal,
) {
  const entries = request.history.slice(previous?.covered ?? 0);
  if (!entries.length) return null;
  const instructions = `Summarize the earlier turns of this coding conversation in at most ${SUMMARY_TOKENS} tokens. Keep decisions, files touched, failing checks and open questions. Write plain sentences with no preamble.`;
  const prior = previous ? `Summary so far:\n${previous.summary}\n\n` : '';
  let left =
    contextLength - 2 * SUMMARY_TOKENS - (await model.countTokens(instructions + prior)) - 32;
  const kept: string[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const line = `${entries[index].role === 'user' ? 'Person' : 'Assistant'}: ${entries[index].text}`;
    const tokens = await model.countTokens(line);
    if (tokens > left) break;
    kept.unshift(line);
    left -= tokens;
  }
  if (!kept.length) return null;
  let content = '';
  await model.act(
    [
      { role: 'system', content: instructions },
      { role: 'user', content: `${prior}Turns to fold in:\n${kept.join('\n\n')}` },
    ],
    [],
    {
      maxTokens: 2 * SUMMARY_TOKENS,
      enableThinking: false,
      signal,
      onPredictionCompleted: (result: PredictionResult) => {
        content = result.nonReasoningContent;
      },
    },
  );
  return content.trim() || null;
}

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error.';
const overflow = /context (length|window|size|overflow)|n_ctx|too many tokens|tokens to keep/i;
const unreachable = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket|connect/i;

// `connect` rejects with an Error. Connection errors come first because their text can mention
// the model it was trying to reach.
function connectFailure(error: unknown): ChatFailure {
  const providerMessage = describeError(error).slice(0, 16_384);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (!unreachable.test(`${code} ${providerMessage}`) && /model/i.test(providerMessage))
    return chatFailure({
      stage: 'session',
      kind: 'model-unavailable',
      message: 'LM Studio has no model loaded for Local.',
      providerMessage,
      nextAction: SETTINGS_ACTION,
    });
  return chatFailure({
    stage: 'launch',
    kind: 'client-missing',
    message: 'CrewKite could not connect to LM Studio.',
    providerMessage,
    nextAction: SETTINGS_ACTION,
  });
}

function streamFailure(error: unknown): ChatFailure {
  const providerMessage = describeError(error).slice(0, 16_384);
  if (overflow.test(providerMessage))
    return chatFailure({
      stage: 'stream',
      kind: 'protocol',
      message: 'The request no longer fits in the model context.',
      providerMessage,
      nextAction: SHORTEN_ACTION,
    });
  if (/not loaded|unloaded|no model/i.test(providerMessage))
    return chatFailure({
      stage: 'stream',
      kind: 'model-unavailable',
      message: 'The Local model was unloaded during the turn.',
      providerMessage,
      nextAction: SETTINGS_ACTION,
    });
  if (unreachable.test(providerMessage) || /disconnect/i.test(providerMessage))
    return chatFailure({
      stage: 'stream',
      kind: 'client-exit',
      message: 'LM Studio closed the connection during the turn.',
      providerMessage,
    });
  return chatFailure({
    stage: 'stream',
    kind: 'internal',
    message: 'The Local turn failed.',
    providerMessage,
  });
}

/**
 * One notice line, for example `Local: 1,842 in, 412 out, 1.9 s to first token, 21 tok/s, 14.0 s
 * total`. In is the last round's prompt, the most context the turn used. Out sums every round.
 * Total is the turn's wall clock, tool calls and permission waits included.
 */
function statsNotice(rounds: readonly LLMPredictionStats[], totalSeconds: number) {
  const last = rounds.at(-1);
  const out = rounds.reduce((sum, stats) => sum + (stats.predictedTokensCount ?? 0), 0);
  const seconds = rounds.reduce(
    (sum, stats) =>
      sum +
      (stats.tokensPerSecond && stats.predictedTokensCount
        ? stats.predictedTokensCount / stats.tokensPerSecond
        : 0),
    0,
  );
  const first = rounds[0]?.timeToFirstTokenSec;
  return [
    `Local: ${(last?.promptTokensCount ?? 0).toLocaleString('en-US')} in`,
    `${out.toLocaleString('en-US')} out`,
    ...(first === undefined ? [] : [`${first.toFixed(1)} s to first token`]),
    ...(seconds > 0 ? [`${Math.round(out / seconds)} tok/s`] : []),
    `${totalSeconds.toFixed(1)} s total`,
  ].join(', ');
}

// A chat template without native tool calls leaves the call in the reply text. These are the forms
// small models write: the Hermes JSON form inside <tool_call>, the Qwen form with <function=name>
// and <parameter=key> tags, the same with each parameter as its own <key> tag, and a bare
// <function=name> block with no wrapper.
export const TEXT_CALL_EXAMPLE =
  '<tool_call>{"name": "read_range", "arguments": {"path": "src/main.py", "start": 1, "end": 40}}</tool_call>';
const TEXT_CALL_OPENER = /<tool_call>|<function=/g;
const TEXT_CALL_FUNCTION = /^<function=([^>]+)>([\s\S]*?)(?:<\/function>)?$/;
const TEXT_CALL_PARAMETER =
  /\s*(?:<parameter=([^>]+)>([\s\S]*?)<\/parameter>|<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\3>)/y;
const NUMBER = /^-?\d+(\.\d+)?$/;

type LocalTool = (typeof LOCAL_TOOLS)[number];
export type TextToolCall =
  | { ok: true; name: string; arguments: Record<string, unknown> }
  | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, '');

function readTextCall(body: string, tools: readonly LocalTool[]): TextToolCall {
  const unreadable = {
    ok: false,
    error: `That tool call could not be read. Write it as ${TEXT_CALL_EXAMPLE}`,
  } as const;
  let name: unknown;
  let args: unknown;
  if (body.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(body);
      if (!isRecord(value)) return unreadable;
      name = value.name;
      args = value.arguments ?? value.parameters ?? {};
      if (typeof args === 'string') args = JSON.parse(args);
    } catch {
      return unreadable;
    }
  } else {
    const match = TEXT_CALL_FUNCTION.exec(body);
    if (!match) return unreadable;
    name = unquote(match[1]);
    const values: Record<string, string> = {};
    let read = 0;
    TEXT_CALL_PARAMETER.lastIndex = 0;
    for (
      let found = TEXT_CALL_PARAMETER.exec(match[2]);
      found;
      found = TEXT_CALL_PARAMETER.exec(match[2])
    ) {
      // Qwen writes each value on its own lines. One newline on each side belongs to the markup.
      values[unquote(found[1] ?? found[3])] = (found[2] ?? found[4]).replace(/^\r?\n|\r?\n$/g, '');
      read = TEXT_CALL_PARAMETER.lastIndex;
    }
    if (match[2].slice(read).trim()) return unreadable;
    args = values;
  }
  if (typeof name !== 'string' || !name || !isRecord(args)) return unreadable;
  const tool = tools.find((candidate) => candidate.function.name === name);
  if (!tool)
    return {
      ok: false,
      error: `There is no tool named ${name.slice(0, 100)}. Use ${tools.map((candidate) => candidate.function.name).join(', ')}.`,
    };
  // Tag values are always text. A schema that wants a number gets one.
  const schema: Record<string, { type?: string }> = tool.function.parameters.properties;
  const numeric = (key: string) => /^(integer|number)$/.test(schema[key]?.type ?? '');
  return {
    ok: true,
    name,
    arguments: Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        key,
        typeof value === 'string' && numeric(key) && NUMBER.test(value.trim())
          ? Number(value)
          : value,
      ]),
    ),
  };
}

/**
 * Tool calls a model wrote as text, in order, and the reply text around them. Only the tools
 * offered this turn count. A block that cannot be read or names another tool comes back as an
 * error the model reads. Nothing here throws.
 */
export function parseTextToolCalls(text: string, tools: readonly LocalTool[] = LOCAL_TOOLS) {
  const calls: TextToolCall[] = [];
  let rest = '';
  let at = 0;
  for (const open of text.matchAll(TEXT_CALL_OPENER)) {
    if (open.index < at) continue;
    rest += text.slice(at, open.index);
    const wrapped = open[0] === '<tool_call>';
    const close = wrapped ? '</tool_call>' : '</function>';
    const end = text.indexOf(close, open.index + open[0].length);
    // A stop string or the token limit can leave the last block open. Read what is there.
    at = end < 0 ? text.length : end + close.length;
    const body = wrapped
      ? text.slice(open.index + open[0].length, end < 0 ? text.length : end)
      : text.slice(open.index, at);
    calls.push(readTextCall(body.trim(), tools));
  }
  return { calls, rest: rest + text.slice(at) };
}

const TEXT_CALL_OPENERS = ['<tool_call>', '<function='];
// A notice, so the words stay out of the reply that later prompts and handoffs carry. The model
// gets its own error for the call.
const UNREADABLE_CALL =
  'Local: the model wrote a tool call CrewKite could not read. Try again or pick another model.';

/**
 * Where streamed reply text has to start waiting: at the first opening tag, or at a tail that could
 * still grow into one. `open` is true once a whole opening tag is there.
 */
function heldFrom(text: string) {
  const at = text.search(TEXT_CALL_OPENER);
  if (at >= 0) return { at, open: true };
  for (let size = Math.min(text.length, 10); size > 0; size--)
    if (TEXT_CALL_OPENERS.some((opener) => opener.startsWith(text.slice(-size))))
      return { at: text.length - size, open: false };
  return { at: text.length, open: false };
}

const toolResponse = (output: string) => `<tool_response>\n${output}\n</tool_response>`;

/**
 * A finished message carried into the next `act` call. Native calls and their results are written
 * as <tool_call> and <tool_response> text, so the carried history stays plain messages.
 */
function plainMessage(message: ChatMessage): ChatMessageInput {
  if (message.getRole() === 'tool')
    return {
      role: 'user',
      content: message
        .getToolCallResults()
        .map((result) => toolResponse(result.content))
        .join('\n'),
    };
  const calls = message
    .getToolCallRequests()
    .map(
      (call) =>
        `<tool_call>${JSON.stringify({ name: call.name, arguments: call.arguments ?? {} })}</tool_call>`,
    );
  return { role: 'assistant', content: [message.getText(), ...calls].filter(Boolean).join('\n') };
}

export function localChatAdapter(deps: { connect: LocalConnect }): ChatAdapter {
  return {
    family: 'local',
    startTurn: (request, emit) => startLocalTurn(deps.connect, request, emit),
  };
}

function startLocalTurn(
  connect: LocalConnect,
  request: ChatTurnRequest,
  emit: (event: AgentEvent) => void,
): ChatTurnHandle {
  const now = request.now ?? Date.now;
  const began = now();
  const { turnId } = request;
  const abort = new AbortController();
  const groups: number[] = [];
  const pending = new Map<string, (choice: string | null) => void>();
  const grants = new Set<'edit' | 'command'>();
  const changed = new Set<string>();
  const rounds: LLMPredictionStats[] = [];
  const texts: string[] = [];
  const noticed = new Set<string>();
  let ending: 'stopped' | 'timeout' | null = null;
  let connecting: ReturnType<LocalConnect> | null = null;
  let items = 0;
  let permissions = 0;
  let toolCalls = 0;

  const notice = (level: 'info' | 'warning', message: string) => {
    if (noticed.has(message)) return;
    noticed.add(message);
    emit({ type: 'provider.notice', turnId, level, message });
  };
  let text: { id: string; value: string } | null = null;
  let thinking: string | null = null;
  const closeThinking = () => {
    if (thinking) emit({ type: 'thinking.completed', turnId, itemId: thinking });
    thinking = null;
  };
  const closeText = () => {
    if (text) {
      emit({ type: 'text.completed', turnId, itemId: text.id, text: text.value });
      texts.push(text.value);
    }
    text = null;
  };
  const say = (chunk: string) => {
    if (!chunk) return;
    closeThinking();
    if (text && text.value.length + chunk.length > 65_536) closeText();
    text ??= { id: `${turnId}:item-${++items}`, value: '' };
    text.value += chunk;
    emit({ type: 'text.delta', turnId, itemId: text.id, text: chunk });
  };
  const think = (chunk: string) => {
    if (!chunk) return;
    closeText();
    thinking ??= `${turnId}:item-${++items}`;
    emit({ type: 'thinking.delta', turnId, itemId: thinking, text: chunk });
  };

  // A model without native tool calls writes them into its reply. From the first opening tag on,
  // the round's text waits for the round to end, so markup never reaches the thread as text.
  const offered = offeredTools(request);
  let held = '';
  let holding = false;
  let nativeRound = false;
  let written: TextToolCall[] = [];
  const speak = (chunk: string) => {
    if (holding) {
      held += chunk;
      return;
    }
    const value = held + chunk;
    const from = heldFrom(value);
    say(value.slice(0, from.at));
    held = value.slice(from.at);
    holding = from.open;
  };
  const settleRound = () => {
    const parsed = holding ? parseTextToolCalls(held, offered) : null;
    const value = held;
    const native = nativeRound;
    held = '';
    holding = false;
    nativeRound = false;
    if (!parsed?.calls.length) {
      say(value);
      return;
    }
    if (parsed.rest.trim()) say(parsed.rest);
    // The runtime runs the calls it reported. Running the written ones too would run them twice.
    if (native) return;
    if (parsed.calls.some((call) => !call.ok)) notice('warning', UNREADABLE_CALL);
    written.push(...parsed.calls);
  };

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = (reason: 'stopped' | 'timeout') => {
    if (ending) return;
    ending = reason;
    abort.abort();
    for (const resolve of pending.values()) resolve(null);
    setTimeout(release, CANCEL_GRACE_MS).unref();
  };
  /** Wait for work, but give up once a stop has had its grace period. */
  const bounded = <T>(work: Promise<T>): Promise<T> => {
    work.catch(() => {});
    return Promise.race([
      work,
      released.then((): never => {
        throw new Error('The turn was stopped.');
      }),
    ]);
  };
  const deadline = setTimeout(() => stop('timeout'), Math.min(request.deadlineMs, 2 ** 31 - 1));
  deadline.unref();

  const ask = (callId: string, tool: PreparedTool, granted: boolean) => {
    const requestId = `${turnId}:permission-${++permissions}`;
    const question =
      tool.name === 'run'
        ? 'Run this command in the scratch copy?'
        : `${tool.title} in the scratch copy?`;
    // Register before emitting, so an answer given from inside `emit` still lands.
    const answer = new Promise<string>((resolve) => {
      pending.set(requestId, (choice) => {
        pending.delete(requestId);
        const known = PERMISSION_OPTIONS.find((option) => option.id === choice);
        emit({ type: 'permission.resolved', turnId, requestId, choice: known?.id ?? 'deny' });
        resolve(known?.kind ?? 'deny');
      });
    });
    emit({
      type: 'permission.requested',
      turnId,
      requestId,
      callId,
      question: question.slice(0, 4096),
      detail: tool.detail === null ? null : fitBytes(tool.detail, 16_384),
      options: PERMISSION_OPTIONS,
    });
    // Thread grant: answer at once, so the thread still shows the request and the choice.
    if (granted) pending.get(requestId)?.('allow-thread');
    return answer;
  };

  /**
   * Check, gate and plan one call. Native calls and calls written as text both come through here,
   * so they share the call limit, the permission prompt and the tool card.
   */
  const admit = async (
    callId: string,
    name: string,
    input: unknown,
  ): Promise<{ tool: PreparedTool } | { refused: string }> => {
    closeText();
    closeThinking();
    let streamed = 0;
    // A per-call context: `permitted` turns true only after the person allows a command.
    const context = {
      scratch: request.scratch.directory,
      environment: request.environment,
      signal: abort.signal,
      permitted: false,
      onGroup: (group: number) => groups.push(group),
      onOutput: (chunk: string) => {
        if (streamed > OUTPUT_BYTES) return;
        const bytes = Buffer.byteLength(chunk);
        const truncated = streamed + bytes > OUTPUT_BYTES;
        emit({
          type: 'tool.output',
          turnId,
          callId,
          chunk: truncated ? fitBytes(chunk, OUTPUT_BYTES - streamed) : chunk,
          ...(truncated ? { truncated } : {}),
        });
        streamed = truncated ? OUTPUT_BYTES + 1 : streamed + bytes;
      },
    };
    const tool = prepareTool(name, input, context);
    emit({ type: 'tool.started', turnId, callId, kind: tool.kind, title: tool.title, input });
    const refuse = (status: 'error' | 'denied', summary: string, refused: string) => {
      emit({ type: 'tool.completed', turnId, callId, status, summary });
      return { refused };
    };
    if (++toolCalls > MAX_TOOL_CALLS)
      return refuse(
        'denied',
        `Tool limit of ${MAX_TOOL_CALLS} calls reached.`,
        `The limit of ${MAX_TOOL_CALLS} tool calls for this turn is reached. Do not call tools again. Answer now with what you found.`,
      );
    if (tool.error !== null) {
      emit({ type: 'tool.output', turnId, callId, chunk: fitBytes(tool.error, OUTPUT_BYTES) });
      return refuse('error', tool.error.slice(0, 200), tool.error);
    }
    // allow-all also runs commands without asking. Allow-edits still asks before a command.
    const gate =
      tool.name === 'run'
        ? request.permissionPolicy === 'allow-all'
          ? null
          : 'command'
        : tool.kind === 'edit' && request.permissionPolicy === 'ask'
          ? 'edit'
          : null;
    const granted = gate !== null && request.permissionGrants?.includes(gate) === true;
    if (gate && !grants.has(gate)) {
      const choice = await ask(callId, tool, granted);
      if (ending) {
        emit({ type: 'tool.completed', turnId, callId, status: 'denied', summary: 'Stopped.' });
        throw new Error('The turn was stopped.');
      }
      if (choice === 'deny')
        return refuse(
          'denied',
          'Declined by the person.',
          'The person declined this call. Do not retry it. Continue without it or ask them.',
        );
      // A thread grant is answered call by call. Only a choice made now covers the rest of the turn.
      if (choice === 'allow-thread' && !granted) grants.add(gate);
    }
    context.permitted = true;
    return { tool };
  };

  /** Run an admitted call and return what the model reads. */
  const execute = async (callId: string, tool: PreparedTool) => {
    const outcome = await tool.execute();
    if (tool.name !== 'run')
      emit({ type: 'tool.output', turnId, callId, chunk: fitBytes(outcome.output, OUTPUT_BYTES) });
    if (outcome.changedPath) changed.add(outcome.changedPath);
    emit({
      type: 'tool.completed',
      turnId,
      callId,
      status: outcome.status,
      ...(outcome.diff ? { diff: outcome.diff } : {}),
      summary: outcome.output.split('\n', 1)[0].slice(0, 200),
    });
    return outcome.output;
  };

  const prepared = new Map<number, PreparedTool>();
  const tools = offered.map(
    ({ function: definition }): Tool => ({
      type: 'rawFunction',
      name: definition.name,
      description: definition.description,
      parametersJsonSchema: definition.parameters,
      // prepareTool checks arguments, so a bad call gets a tool card and an answer the model reads.
      checkParameters: () => {},
      implementation: async (_parameters, context) => {
        const tool = prepared.get(context.callId);
        prepared.delete(context.callId);
        if (!tool) return 'The call was not checked and did not run.';
        return execute(`${turnId}:call-${context.callId}`, tool);
      },
    }),
  );

  const guardToolCall: LLMActionOpts['guardToolCall'] = async (_round, sdkCallId, guard) => {
    nativeRound = true;
    const call = guard.toolCallRequest;
    const verdict = await admit(`${turnId}:call-${sdkCallId}`, call.name, call.arguments ?? {});
    if ('refused' in verdict) return guard.deny(verdict.refused);
    prepared.set(sdkCallId, verdict.tool);
    guard.allow();
  };

  // Written calls run in order through the same gate as native ones. Their results go back in one
  // user message, wrapped the way Hermes and Qwen chat templates wrap tool results.
  let textCalls = 0;
  const runWritten = async (calls: readonly TextToolCall[]) => {
    const results: string[] = [];
    for (const call of calls) {
      if (!call.ok) {
        results.push(toolResponse(call.error));
        continue;
      }
      const callId = `${turnId}:text-call-${++textCalls}`;
      const verdict = await admit(callId, call.name, call.arguments);
      results.push(
        toolResponse('refused' in verdict ? verdict.refused : await execute(callId, verdict.tool)),
      );
    }
    return results.join('\n');
  };

  const run = async (): Promise<ChatTurnResult> => {
    let usage: ChatTurnResult['usage'] = null;
    let session: ChatTurnResult['session'] = null;
    const finish = (stopReason: ChatTurnResult['stopReason'], failure: ChatFailure | null) => {
      closeText();
      closeThinking();
      if (rounds.length) {
        notice('info', statsNotice(rounds, Math.max(0, now() - began) / 1000));
        const last = rounds[rounds.length - 1];
        usage = {
          usedTokens: (last.promptTokensCount ?? 0) + (last.predictedTokensCount ?? 0),
          capacityTokens: usage?.capacityTokens ?? null,
        };
        emit({ type: 'usage.context', turnId, ...usage });
      }
      emit({ type: 'turn.completed', turnId, stopReason, failure });
      return {
        stopReason,
        failure,
        assistantText: texts.filter(Boolean).join('\n\n'),
        session,
        usage,
        changedPaths: [...changed],
      } satisfies ChatTurnResult;
    };
    const ended = () =>
      ending === 'timeout'
        ? finish(
            'error',
            chatFailure({
              stage: 'stream',
              kind: 'timeout',
              message: 'The Local turn ran past its time limit.',
            }),
          )
        : finish(
            'stopped',
            chatFailure({ stage: 'stream', kind: 'stopped', message: 'The turn was stopped.' }),
          );

    emit({
      type: 'turn.started',
      turnId,
      family: 'local',
      model: request.selection.model,
      effort: request.selection.effort,
      role: request.role,
    });
    let connection: Awaited<ReturnType<LocalConnect>>;
    try {
      connecting = connect(request);
      connection = await bounded(connecting);
    } catch (error) {
      return ending ? ended() : finish('error', connectFailure(error));
    }
    if (ending) return ended();
    const { model, contextLength, modelKey, fellBack } = connection;
    if (fellBack)
      notice(
        'warning',
        `Local: ${request.selection.model} is not loaded, so ${modelKey} answered. Load ${request.selection.model} or pick ${modelKey} in the composer.`,
      );
    usage = { usedTokens: 0, capacityTokens: contextLength };
    session = {
      family: 'local',
      sessionId: modelKey.slice(0, 512),
      // The thread shows the model that answered.
      model: (fellBack ? modelKey : request.selection.model).slice(0, 200),
      updatedAt: new Date(now()).toISOString(),
    };

    let prompt: Prompt;
    try {
      prompt = await bounded(
        buildPrompt(request, model, contextLength, (message) => notice('warning', message)),
      );
    } catch (error) {
      return ending ? ended() : finish('error', connectFailure(error));
    }
    if (prompt.kind === 'too-large') {
      say(
        `This request is too large for the Local model's ${contextLength.toLocaleString('en-US')} token context. Send a smaller first step, such as one file or one function.`,
      );
      return finish('done', null);
    }

    // `act` runs rounds until one ends without a native call. When that round wrote its calls as
    // text, they run here and `act` starts again with the results, inside the same round budget.
    let chat = prompt.chat;
    try {
      for (;;) {
        const appended: ChatInput = [];
        written = [];
        await bounded(
          model.act(chat, tools, {
            maxTokens: Math.floor(contextLength * OUTPUT_SHARE),
            contextOverflowPolicy: 'stopAtLimit',
            maxPredictionRounds: MAX_ROUNDS - rounds.length,
            signal: abort.signal,
            onPredictionFragment: (fragment) => {
              if (ending || fragment.isStructural) return;
              if (fragment.reasoningType === 'reasoning') think(fragment.content);
              else if (fragment.reasoningType === 'none') speak(fragment.content);
            },
            onMessage: (message) => {
              appended.push(plainMessage(message));
            },
            onRoundEnd: () => {
              settleRound();
              closeText();
              closeThinking();
            },
            onPredictionCompleted: (result) => {
              rounds.push(result.stats);
            },
            guardToolCall,
            handleInvalidToolRequest: (error, call) => {
              notice('warning', 'Local: the model sent a tool call CrewKite could not read.');
              if (!call) return undefined;
              // The SDK answers this call and starts another round on its own.
              nativeRound = true;
              return `That tool call was invalid: ${error.message}`;
            },
          }),
        );
        const cut = rounds.some((stats) =>
          ['contextLengthReached', 'modelUnloaded'].includes(stats.stopReason),
        );
        if (ending || cut || !written.length) break;
        if (rounds.length >= MAX_ROUNDS) {
          notice(
            'warning',
            'Local: the model was still calling tools when the turn ran out of rounds. Send a follow-up to continue, or split the request into smaller steps.',
          );
          break;
        }
        const results = await bounded(runWritten(written));
        chat = [...chat, ...appended, { role: 'user', content: results }];
      }
    } catch (error) {
      return ending ? ended() : finish('error', streamFailure(error));
    }
    if (ending) return ended();
    const stops = new Set(rounds.map((stats) => stats.stopReason));
    if (stops.has('contextLengthReached'))
      return finish(
        'error',
        chatFailure({
          stage: 'stream',
          kind: 'protocol',
          message: `The turn filled the Local model's ${contextLength.toLocaleString('en-US')} token context.`,
          nextAction: SHORTEN_ACTION,
        }),
      );
    if (stops.has('modelUnloaded'))
      return finish('error', streamFailure(new Error('The model was unloaded.')));
    if (rounds.at(-1)?.stopReason === 'maxPredictedTokensReached')
      notice('warning', 'Local: the reply reached its output limit and was cut off.');

    // Measured on the first round, which carries the whole conversation without tool results.
    const carried =
      (rounds[0]?.promptTokensCount ?? 0) + Math.ceil(texts.join('').length / 4) + MESSAGE_TOKENS;
    if (carried > contextLength * SUMMARY_SHARE) {
      try {
        const summary = await bounded(
          summarize(request, model, contextLength, prompt.summary, abort.signal),
        );
        if (summary) saveSummary(request, summary);
      } catch {
        if (ending) return ended();
        notice('warning', 'Local: the summary of earlier turns could not be updated.');
      }
    }
    return finish('done', null);
  };

  const result = run()
    .catch((error: unknown) => {
      const failure = chatFailure({
        stage: 'finish',
        kind: 'internal',
        message: 'The Local turn failed.',
        providerMessage: describeError(error).slice(0, 16_384),
      });
      emit({ type: 'turn.completed', turnId, stopReason: 'error', failure });
      return {
        stopReason: 'error',
        failure,
        assistantText: texts.join('\n\n'),
        session: null,
        usage: null,
        changedPaths: [...changed],
      } satisfies ChatTurnResult;
    })
    .finally(() => {
      clearTimeout(deadline);
      // Every turn opens its own client. A connect that gave up on a stop and lands later is
      // closed here too. Nothing waits on the disposal: a runtime that never answers cancel
      // keeps it pending, and that must not hold the turn open.
      connecting?.then((connection) => connection.dispose()).catch(() => {});
    });

  return {
    respondPermission: (requestId, choice) => pending.get(requestId)?.(choice),
    stop: () => stop('stopped'),
    get groups() {
      return groups;
    },
    result,
  };
}
