import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type {
  AgentEvent,
  ChatFailure,
  ChatPermissionOption,
  ChatToolKind,
} from '@crewkite/contracts';
import { z } from 'zod';
import {
  type ChatAdapter,
  type ChatTurnHandle,
  type ChatTurnRequest,
  type ChatTurnResult,
  chatFailure,
} from '../../chat/adapter.ts';
import { scratchPath } from '../../chat/local-tools.ts';
import { defaultSchedule, groupAbsent, type Schedule } from '../../host/worker.ts';
import { armOwnedCleanup } from './native-discovery.ts';

// One chat turn on the official claude client: `--print` with stream-json in both directions,
// so the user message goes in on stdin, permission asks come back as control requests, and the
// answers go out on the same stdin while the turn runs.

type Spawn = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: true;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcessWithoutNullStreams;
type Outcome = { stopReason: ChatTurnResult['stopReason']; failure: ChatFailure | null };
type Item = {
  id: string;
  kind: string;
  text: string;
  done: boolean;
  streamed: boolean;
  tool?: { id: string; name: string; json: string };
};
type Ask = { toolName: string; input: Record<string, unknown>; callId: string | null };

const CLEANUP_MS = 2_000;
const TERM_MS = 500;
// The client exits on its own once stdin closes after the result. This covers a client that
// lingers, for example while it flushes the session file.
const RESULT_GRACE_MS = 2_000;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_TEXT = 65_536;
const MAX_INPUT_BYTES = 65_536;
const MAX_STDERR = 16_384;

const id = z.string().min(1).max(200);
// Session IDs and models go into argv, so neither may start with a dash or carry whitespace.
const sessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,199}$/;
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usage = z.object({
  input_tokens: tokens.optional(),
  output_tokens: tokens.optional(),
  cache_creation_input_tokens: tokens.nullish(),
  cache_read_input_tokens: tokens.nullish(),
});
const rateInfo = z.object({
  status: z.string().optional(),
  resetsAt: z.number().optional(),
  isUsingOverage: z.boolean().optional(),
  overageInUse: z.boolean().optional(),
});
const block = z.object({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});
const frame = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  parent_tool_use_id: z.string().nullish(),
});
const init = z.object({ session_id: sessionId, model: z.string().min(1).max(200).optional() });
const streamEvent = z.object({
  event: z.object({
    type: z.string(),
    index: z.number().int().nonnegative().max(4096).optional(),
    message: z.object({ id: z.string().optional() }).optional(),
    content_block: block.optional(),
    // message_delta carries a delta with no type, so the type stays optional here.
    delta: z
      .object({
        type: z.string().optional(),
        text: z.string().optional(),
        thinking: z.string().optional(),
        partial_json: z.string().optional(),
      })
      .optional(),
  }),
});
const assistant = z.object({
  message: z.object({
    id: z.string().optional(),
    content: z.array(z.unknown()).max(4096),
    usage: usage.optional(),
  }),
  error: z.string().optional(),
  api_error: z.string().optional(),
  api_error_params: z.object({ rate_limit_info: rateInfo.optional() }).optional(),
});
const user = z.object({
  message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
});
// The documented envelope nests the ask under `request`. Both spellings of the tool fields are
// accepted until a live client confirms which one this build sends.
const control = z.object({
  request_id: id,
  request: z.object({
    subtype: z.string(),
    tool_name: id.optional(),
    toolName: id.optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    tool_use_id: id.optional(),
    toolUseId: id.optional(),
  }),
});
const cancel = z.object({ request_id: id });
const rateLimit = z.object({
  rate_limit_info: rateInfo.optional(),
  rateLimitInfo: rateInfo.optional(),
});
// Only the subtype has to parse. Every other field falls back to undefined on its own, so a
// finished turn does not fail because one detail changed shape in a later build.
const loose = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const result = z.object({
  subtype: z.string().optional(),
  is_error: loose(z.boolean()),
  session_id: loose(z.string()),
  result: loose(z.string()),
  errors: loose(z.array(z.unknown())),
  api_error: loose(z.string()),
  usage: loose(usage),
  modelUsage: loose(
    z.record(z.string(), z.object({ contextWindow: loose(z.number().int().positive()) }).catch({})),
  ),
});

// Copied from replacement.ts: the last Unix second that still prints as a four-digit year.
const epochSeconds = z.number().int().nonnegative().max(253_402_300_799);
const unixTime = (seconds: unknown) => {
  const parsed = epochSeconds.safeParse(seconds);
  return parsed.success ? new Date(parsed.data * 1000).toISOString() : null;
};
const USAGE_LIMIT = /usage limit|limit reached|hit your limit|out of usage/i;
const SIGNED_OUT =
  /\/login\b|\bnot logged in\b|\blog ?in\b|\bsign(?:ed)? ?in\b|authenticat|\boauth\b|invalid api key/i;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const QUIET_SYSTEM = new Set(['status', 'commands_changed', 'thinking_tokens']);
const carriesText = (value: unknown) =>
  ['content', 'message', 'text'].some((key) => {
    const field = record(value)[key];
    return typeof field === 'string' && field.trim() !== '';
  });
const label = (value: string | undefined) => (value && NAME.test(value) ? value : 'unnamed');
const clip = (value: string, limit: number) =>
  value.length > limit ? value.slice(0, limit) : value;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const parseInput = (json: string) => {
  try {
    return record(JSON.parse(json));
  } catch {
    return {};
  }
};
const total = (value: z.output<typeof usage>) =>
  (value.input_tokens ?? 0) +
  (value.cache_creation_input_tokens ?? 0) +
  (value.cache_read_input_tokens ?? 0) +
  (value.output_tokens ?? 0);
const toolKinds = new Map<string, ChatToolKind>([
  ['Read', 'read'],
  ['Glob', 'search'],
  ['Grep', 'search'],
  ['Edit', 'edit'],
  ['MultiEdit', 'edit'],
  ['Write', 'edit'],
  ['NotebookEdit', 'edit'],
  ['Bash', 'command'],
]);
const options: ChatPermissionOption[] = [
  { id: 'allow-once', label: 'Allow once', kind: 'allow-once' },
  { id: 'allow-thread', label: 'Allow for this thread', kind: 'allow-thread' },
  { id: 'deny', label: 'Deny', kind: 'deny' },
];

// Copied from startReplacement in replacement.ts. The profile verified this build when it
// resolved, and hashing again right before spawn keeps a binary replaced since then from
// running under the old identity.
function verifiedExecutable(path: string, sha256: string) {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('identity');
  const executable = realpathSync(path);
  const fd = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    if (
      !file.isFile() ||
      file.size > 512 * 1024 * 1024 ||
      createHash('sha256').update(readFileSync(fd)).digest('hex') !== sha256
    )
      throw new Error('identity');
  } finally {
    closeSync(fd);
  }
  return executable;
}

// Follows nativeAuthEnvironment in native-discovery.ts without its safe-mode switch, which
// would strip the tools a chat turn needs. Updates stay off so the verified build is the one
// that runs, and nothing else from the controller's environment, keys included, reaches the
// client.
function chatEnvironment(source: NodeJS.ProcessEnv, temporary: string): NodeJS.ProcessEnv {
  if (!source.HOME || !isAbsolute(source.HOME)) throw new Error('environment');
  return {
    HOME: source.HOME,
    USER: userInfo().username,
    PATH: source.PATH || '/usr/bin:/bin',
    LANG: source.LANG || 'C',
    TMPDIR: temporary,
    NO_COLOR: '1',
    DISABLE_UPDATES: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
}

// The chat models the client offers on a subscription plan, and the efforts chatArguments can
// pass. Default passes no flag and leaves the level to the client.
export const anthropicChatModels = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
] as const;
export const anthropicDefaultChatModel = 'claude-sonnet-5-5';
export const anthropicChatEfforts = ['default', 'low', 'medium', 'high', 'xhigh'] as const;

function chatArguments(request: ChatTurnRequest, resume: string | null) {
  const { effort, model } = request.selection;
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio',
    // Settings files carry allow rules that answer before CrewKite is asked, in the scratch
    // copy's own file and in the person's user file. No source loads; hooks stay off too. The
    // usage read runs the same way and signs in fine, so sign-in does not depend on settings.
    '--setting-sources',
    '',
    '--settings',
    '{"disableAllHooks":true}',
    '--permission-mode',
    request.permissionPolicy === 'ask' ? 'default' : 'acceptEdits',
    // Review and advice turns read only.
    ...(request.readOnly ? ['--allowedTools', 'Read,Grep,Glob'] : []),
    '--model',
    model,
    // The client documents low, medium, high, xhigh and max. It has no minimal level.
    ...(effort === 'default' || effort === 'minimal' ? [] : ['--effort', effort]),
    ...(resume ? ['--resume', resume] : []),
  ];
}

export function anthropicChatAdapter(deps: {
  launch: (request: ChatTurnRequest) => { executable: string; sha256: string };
  spawn?: Spawn;
  schedule?: Schedule;
}): ChatAdapter {
  return { family: 'anthropic', startTurn: (request, emit) => startTurn(deps, request, emit) };
}

function startTurn(
  deps: Parameters<typeof anthropicChatAdapter>[0],
  request: ChatTurnRequest,
  emit: (event: AgentEvent) => void,
): ChatTurnHandle {
  const { turnId } = request;
  const now = request.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const send = (event: AgentEvent) => {
    try {
      emit(event);
    } catch {
      // A failing sink must not take the native process handlers down with it.
    }
  };
  const refuse = (failure: ChatFailure): ChatTurnHandle => ({
    respondPermission() {},
    stop() {},
    groups: [],
    result: new Promise((resolve) =>
      queueMicrotask(() => {
        send({ type: 'turn.completed', turnId, stopReason: 'error', failure });
        resolve({
          stopReason: 'error',
          failure,
          assistantText: '',
          session: request.session?.family === 'anthropic' ? request.session : null,
          usage: null,
          changedPaths: [],
        });
      }),
    ),
  });

  const prior = request.session?.family === 'anthropic' ? request.session.sessionId : null;
  if (prior !== null && !sessionId.safeParse(prior).success)
    return refuse(
      chatFailure({
        stage: 'session',
        kind: 'internal',
        message: 'The saved Anthropic session ID cannot be resumed.',
      }),
    );
  if (!MODEL.test(request.selection.model))
    return refuse(
      chatFailure({
        stage: 'launch',
        kind: 'model-unavailable',
        message: 'The selected model name cannot be passed to the Anthropic client.',
      }),
    );
  let executable: string;
  try {
    const client = deps.launch(request);
    executable = verifiedExecutable(client.executable, client.sha256);
  } catch {
    return refuse(
      chatFailure({
        stage: 'launch',
        kind: 'client-missing',
        message: 'The Anthropic client is missing or does not match the verified build.',
      }),
    );
  }
  const scratch = request.scratch.directory;
  let environment: NodeJS.ProcessEnv;
  try {
    if (!isAbsolute(scratch) || !isAbsolute(request.work.directory)) throw new Error();
    const temporary = join(request.work.directory, 'tmp');
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    environment = chatEnvironment(request.environment, temporary);
  } catch {
    return refuse(
      chatFailure({
        stage: 'launch',
        kind: 'internal',
        message: 'CrewKite could not prepare the working directory for this turn.',
      }),
    );
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (deps.spawn ?? (spawn as Spawn))(executable, chatArguments(request, prior), {
      cwd: scratch,
      env: environment,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return refuse(
      chatFailure({
        stage: 'launch',
        kind: 'client-missing',
        message: 'The Anthropic client could not be started.',
      }),
    );
  }

  const group = child.pid ?? 0;
  let model = request.selection.model;
  let session: string | null = null;
  let started = false;
  let resultSeen = false;
  let outcome: Outcome | null = null;
  let usageSeen: ChatTurnResult['usage'] = null;
  let lastCall: number | null = null;
  let apiError: { kind: ChatFailure['kind']; resetsAt: string | null } | null = null;
  let closed = false;
  let settled = false;
  let terminating = false;
  let inputOpen = true;
  let exitCode: number | null = null;
  let stderr = '';
  let pending: Buffer = Buffer.alloc(0);
  let ordinals = 0;
  let streaming: { ordinal: number; items: Item[] } | null = null;
  const messages = new Map<string, { ordinal: number; items: Item[] }>();
  const tools = new Map<string, { path: string | null; done: boolean }>();
  const asks = new Map<string, Ask>();
  const allowed = new Set<string>();
  const denied = new Set<string>();
  const changed = new Set<string>();
  const noticed = new Set<string>();
  const texts: string[] = [];
  const timers: Array<() => void> = [];
  let resolveResult!: (value: ChatTurnResult) => void;
  const outcomePromise = new Promise<ChatTurnResult>((resolve) => {
    resolveResult = resolve;
  });

  const decide = (stopReason: Outcome['stopReason'], failure: ChatFailure | null = null) => {
    outcome ??= { stopReason, failure };
  };
  const notice = (key: string, message: string, level: 'info' | 'warning' = 'info') => {
    if (noticed.has(key)) return;
    noticed.add(key);
    send({ type: 'provider.notice', turnId, level, message });
  };
  const unknown = (name: string) =>
    notice(`unknown:${name}`, `The client sent a ${name} event, which CrewKite does not show.`);
  const unreadable = (name: string) =>
    notice(`unreadable:${name}`, `The client sent a ${name} event that CrewKite could not read.`);
  const write = (value: unknown) => {
    if (!inputOpen) return;
    try {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    } catch {
      // A closed pipe means the client is going away. Its close event decides the outcome.
    }
  };
  const endInput = () => {
    if (!inputOpen) return;
    inputOpen = false;
    try {
      child.stdin.end();
    } catch {}
  };
  const absent = () => group <= 0 || groupAbsent(group);
  const signal = (value: NodeJS.Signals) => {
    if (group <= 0 || groupAbsent(group)) return;
    try {
      process.kill(-group, value);
    } catch {
      // Only an absent group proves a failed signal needs nothing more.
    }
  };
  // The client may report a path through the scratch directory as given or through its real path.
  let real = scratch;
  try {
    real = realpathSync(scratch);
  } catch {}
  const roots = [...new Set([resolve(scratch), real])];
  /** A path relative to scratch, or null when it leaves through `..` or a link, or lands in .git. */
  const local = (file: string) => {
    const full = resolve(scratch, file);
    for (const root of roots) {
      const inside = relative(root, full);
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
      try {
        return scratchPath(scratch, inside).relative;
      } catch {
        return null;
      }
    }
    return null;
  };
  // Paths inside the scratch copy show relative to it. The target is what a person needs to
  // recognize the call: the file, the pattern or the command.
  const describe = (name: string, input: Record<string, unknown>) => {
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const file = text(input.file_path) ?? text(input.notebook_path);
    const inside = file === undefined ? null : local(file);
    const path = inside ?? file;
    const target =
      path ?? text(input.pattern) ?? text(input.command) ?? text(input.path) ?? text(input.url);
    return {
      kind: toolKinds.get(name) ?? 'other',
      path: path ?? null,
      inside: inside !== null,
      target: target ?? null,
    };
  };

  const complete = (item: Item, text: string) => {
    item.done = true;
    if (item.kind === 'text') {
      item.text = text || item.text;
      if (!item.text) return;
      texts.push(item.text);
      send({ type: 'text.completed', turnId, itemId: item.id, text: clip(item.text, MAX_TEXT) });
      return;
    }
    if (!item.streamed && text)
      send({ type: 'thinking.delta', turnId, itemId: item.id, text: clip(text, MAX_TEXT) });
    item.text = text || item.text;
    send({ type: 'thinking.completed', turnId, itemId: item.id });
  };
  const messageFor = (key: string | undefined) => {
    const name = key ?? `unnamed-${ordinals + 1}`;
    let found = messages.get(name);
    if (!found) {
      found = { ordinal: ++ordinals, items: [] };
      messages.set(name, found);
    }
    return found;
  };
  const startTool = (callId: string, name: string, input: Record<string, unknown>) => {
    if (tools.has(callId) || !id.safeParse(callId).success) return;
    const { kind, path, target } = describe(name, input);
    tools.set(callId, { path: kind === 'edit' ? path : null, done: false });
    const title = target
      ? (kind === 'other' ? `${name} ${target}` : target).replace(/\s+/g, ' ')
      : name;
    // shortcut: an input over 64 KiB, such as a whole file for Write, is left off the event.
    // Upgrade: store large inputs as artifacts and reference them.
    const small = Buffer.byteLength(JSON.stringify(input), 'utf8') <= MAX_INPUT_BYTES;
    send({
      type: 'tool.started',
      turnId,
      callId,
      kind,
      title: clip(title, 1024),
      ...(small ? { input } : {}),
    });
  };
  const answer = (requestId: string, ask: Ask, choice: string) => {
    const allow = choice === 'allow-once' || choice === 'allow-thread';
    if (choice === 'allow-thread') allowed.add(ask.toolName);
    if (!allow && ask.callId) denied.add(ask.callId);
    write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow
          ? { behavior: 'allow', updatedInput: ask.input }
          : { behavior: 'deny', message: 'The user declined this action.' },
      },
    });
    send({ type: 'permission.resolved', turnId, requestId, choice: allow ? choice : 'deny' });
  };

  const onInit = (value: unknown) => {
    const parsed = init.safeParse(value);
    if (!parsed.success) return unreadable('system/init');
    session = parsed.data.session_id;
    if (parsed.data.model) model = parsed.data.model;
    if (started) return;
    started = true;
    send({
      type: 'turn.started',
      turnId,
      family: 'anthropic',
      model,
      effort: request.selection.effort,
      role: request.role,
    });
    if (request.selection.effort === 'minimal')
      notice('effort', 'The client has no minimal effort level, so this turn runs at its default.');
  };
  const onStream = (value: unknown) => {
    const parsed = streamEvent.safeParse(value);
    if (!parsed.success) return unreadable('stream_event');
    const event = parsed.data.event;
    const item = event.index === undefined ? undefined : streaming?.items[event.index];
    switch (event.type) {
      case 'message_start':
        streaming = messageFor(event.message?.id);
        return;
      case 'content_block_start': {
        const content = event.content_block;
        if (!streaming || event.index === undefined || !content) return;
        streaming.items[event.index] = {
          id: `m${streaming.ordinal}-${event.index}`,
          kind: content.type,
          text: '',
          done: false,
          streamed: true,
          ...(content.type === 'tool_use' && content.id && content.name
            ? { tool: { id: content.id, name: content.name, json: '' } }
            : {}),
        };
        return;
      }
      case 'content_block_delta': {
        const delta = event.delta;
        if (!item || item.done || !delta) return;
        if (delta.type === 'text_delta' && item.kind === 'text' && delta.text) {
          item.text += delta.text;
          send({ type: 'text.delta', turnId, itemId: item.id, text: clip(delta.text, MAX_TEXT) });
        } else if (delta.type === 'thinking_delta' && item.kind === 'thinking' && delta.thinking) {
          item.text += delta.thinking;
          send({
            type: 'thinking.delta',
            turnId,
            itemId: item.id,
            text: clip(delta.thinking, MAX_TEXT),
          });
        } else if (delta.type === 'input_json_delta' && item.tool && delta.partial_json)
          item.tool.json += delta.partial_json;
        return;
      }
      case 'content_block_stop':
        if (item?.tool) startTool(item.tool.id, item.tool.name, parseInput(item.tool.json));
        return;
      case 'message_delta':
      case 'message_stop':
      case 'ping':
        return;
      default:
        return unknown(`stream_event/${label(event.type)}`);
    }
  };
  const onAssistant = (value: unknown) => {
    const parsed = assistant.safeParse(value);
    if (!parsed.success) return unreadable('assistant');
    const data = parsed.data;
    if (data.message.usage) lastCall = total(data.message.usage);
    if (data.error === 'rate_limit' || data.api_error === 'usage_limit_reached')
      apiError = {
        kind: 'usage-limit',
        resetsAt: unixTime(data.api_error_params?.rate_limit_info?.resetsAt) ?? null,
      };
    else if (data.error === 'authentication_failed' || data.error === 'oauth_org_not_allowed')
      apiError = { kind: 'signed-out', resetsAt: null };
    else if (data.error === 'model_not_found')
      apiError = { kind: 'model-unavailable', resetsAt: null };
    // A streamed message arrives again as one assistant frame per content block. Match each
    // block to the first open streamed item of its kind, and treat a block whose text an item
    // already completed with as a repeat.
    const target = messageFor(data.message.id);
    for (const raw of data.message.content) {
      const parsedBlock = block.safeParse(raw);
      if (!parsedBlock.success) continue;
      const content = parsedBlock.data;
      if (content.type === 'tool_use') {
        if (content.id && content.name) startTool(content.id, content.name, record(content.input));
        continue;
      }
      if (content.type !== 'text' && content.type !== 'thinking') continue;
      const text = (content.type === 'text' ? content.text : content.thinking) ?? '';
      let item = target.items.find((entry) => entry?.kind === content.type && !entry.done);
      if (!item) {
        if (target.items.some((entry) => entry?.kind === content.type && entry.text === text))
          continue;
        item = {
          id: `m${target.ordinal}-${target.items.length}`,
          kind: content.type,
          text: '',
          done: false,
          streamed: false,
        };
        target.items.push(item);
      }
      complete(item, text);
    }
  };
  const onUser = (value: unknown) => {
    const parsed = user.safeParse(value);
    if (!parsed.success) return unreadable('user');
    const content = parsed.data.message.content;
    if (typeof content === 'string') return;
    for (const raw of content) {
      const parsedBlock = block.safeParse(raw);
      if (!parsedBlock.success || parsedBlock.data.type !== 'tool_result') continue;
      const { tool_use_id: callId, content: output, is_error: failed } = parsedBlock.data;
      const tool = callId ? tools.get(callId) : undefined;
      if (!callId || !tool || tool.done) continue;
      tool.done = true;
      const text =
        typeof output === 'string'
          ? output
          : Array.isArray(output)
            ? output
                .map((part) => record(part))
                .filter((part) => part.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('\n')
            : '';
      if (text) {
        const bytes = Buffer.from(text, 'utf8');
        const truncated = bytes.length > MAX_TEXT;
        send({
          type: 'tool.output',
          turnId,
          callId,
          chunk: truncated ? bytes.subarray(0, MAX_TEXT).toString('utf8') : text,
          ...(truncated ? { truncated } : {}),
        });
      }
      const status = denied.has(callId) ? 'denied' : failed ? 'error' : 'ok';
      if (status === 'ok' && tool.path) changed.add(tool.path);
      send({ type: 'tool.completed', turnId, callId, status });
    }
  };
  const onControl = (value: unknown) => {
    const parsed = control.safeParse(value);
    if (!parsed.success) return unreadable('control_request');
    const { request_id: requestId, request: ask } = parsed.data;
    if (ask.subtype !== 'can_use_tool') {
      // The client waits for an answer to every control request, so refuse the ones CrewKite
      // does not serve.
      write({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: 'Unsupported request.' },
      });
      return unknown(`control_request/${label(ask.subtype)}`);
    }
    const toolName = ask.tool_name ?? ask.toolName ?? 'tool';
    const input = ask.input ?? {};
    const callId = ask.tool_use_id ?? ask.toolUseId ?? null;
    const { kind, target, inside } = describe(toolName, input);
    const question =
      kind === 'command' && target
        ? `Run ${target}?`
        : kind === 'edit' && target
          ? `Change ${target}?`
          : target
            ? `Allow ${toolName} on ${target}?`
            : `Allow ${toolName}?`;
    const entry = { toolName, input, callId };
    // Thread grant: a kind the person allowed for the whole thread is answered without asking.
    // For an edit the grant covers the scratch copy only, so a file outside it is asked about.
    // `other` spans every tool CrewKite cannot name, from web fetches to MCP tools, so no grant
    // covers it. An allow for this thread given in this turn names the one tool.
    const granted =
      (kind !== 'edit' || inside) &&
      (allowed.has(toolName) ||
        (kind !== 'other' && request.permissionGrants?.includes(kind) === true));
    // Review and advice turns read only. Those three tools never ask, so any ask is declined.
    // Edits land only in the scratch copy, so allow-all sends an edit outside it to the person.
    const automatic = request.readOnly
      ? 'deny'
      : request.permissionPolicy === 'allow-all' && (kind !== 'edit' || inside)
        ? 'allow-once'
        : granted
          ? 'allow-thread'
          : null;
    // The ask is open before the event goes out, so an answer given from inside the
    // controller's event handler still finds it.
    if (!automatic) asks.set(requestId, entry);
    send({
      type: 'permission.requested',
      turnId,
      requestId,
      callId,
      question: clip(question, 4096),
      // The input came from JSON.parse, so it serializes again without throwing.
      detail: clip(JSON.stringify(input, null, 2), 16_384),
      options,
    });
    if (automatic) answer(requestId, entry, automatic);
  };
  const onCancel = (value: unknown) => {
    const parsed = cancel.safeParse(value);
    if (!parsed.success || !asks.delete(parsed.data.request_id)) return;
    send({
      type: 'permission.resolved',
      turnId,
      requestId: parsed.data.request_id,
      choice: 'cancelled',
    });
  };
  const onRateLimit = (name: string, value: unknown) => {
    const parsed = rateLimit.safeParse(value);
    const info = parsed.success
      ? (parsed.data.rate_limit_info ?? parsed.data.rateLimitInfo)
      : undefined;
    if (!info) return unreadable(name);
    if (info.isUsingOverage === true || info.overageInUse === true)
      notice('overage', 'This turn is using paid extra usage on the Anthropic account.', 'warning');
    if (info.status === 'allowed_warning')
      notice('limit-warning', 'The Anthropic account is close to its usage limit.', 'warning');
    if (info.status !== 'rejected') return;
    notice('limit-reached', 'The Anthropic account reached its usage limit.', 'warning');
    decide(
      'limit',
      chatFailure({
        stage: 'stream',
        kind: 'usage-limit',
        message: 'The Anthropic account reached its usage limit.',
        method: name,
        resetsAt: unixTime(info.resetsAt),
      }),
    );
    terminate();
  };
  const onResult = (value: unknown) => {
    resultSeen = true;
    const parsed = result.safeParse(value);
    if (!parsed.success) {
      decide(
        'error',
        chatFailure({
          stage: 'finish',
          kind: 'protocol',
          message: 'The client finished the turn with a result CrewKite could not read.',
          method: 'result',
        }),
      );
    } else {
      const data = parsed.data;
      const reported = sessionId.safeParse(data.session_id);
      if (reported.success) session ??= reported.data;
      const windows = Object.values(data.modelUsage ?? {});
      const capacity =
        data.modelUsage?.[model]?.contextWindow ??
        windows.find((entry) => entry.contextWindow)?.contextWindow ??
        null;
      // The last API call's usage is what the context holds. The result's usage sums every
      // call in the turn and stands in only when no call reported its own.
      const used = lastCall ?? (data.usage ? total(data.usage) : null);
      if (used !== null) {
        usageSeen = { usedTokens: used, capacityTokens: capacity };
        if (capacity !== null)
          send({ type: 'usage.context', turnId, usedTokens: used, capacityTokens: capacity });
      }
      if (data.subtype === 'success' && data.is_error !== true) decide('done');
      else {
        const errors = (data.errors ?? []).filter((entry) => typeof entry === 'string');
        const text = [data.result, ...errors].filter(Boolean).join('\n');
        const base = {
          stage: 'stream' as const,
          providerMessage: clip(text, 16_384) || null,
          method: `result/${label(data.subtype)}`,
        };
        if (
          apiError?.kind === 'usage-limit' ||
          data.api_error === 'usage_limit_reached' ||
          USAGE_LIMIT.test(text)
        )
          decide(
            'limit',
            chatFailure({
              ...base,
              kind: 'usage-limit',
              message: 'The Anthropic account reached its usage limit.',
              // An older client message ends with `|<unix seconds>` for the reset.
              resetsAt: apiError?.resetsAt ?? unixTime(Number(/\|(\d{9,12})\b/.exec(text)?.[1])),
            }),
          );
        else if (apiError?.kind === 'signed-out' || SIGNED_OUT.test(text))
          decide(
            'error',
            chatFailure({
              ...base,
              kind: 'signed-out',
              message: 'The Anthropic client is not signed in.',
            }),
          );
        else if (apiError?.kind === 'model-unavailable')
          decide(
            'error',
            chatFailure({
              ...base,
              kind: 'model-unavailable',
              message: 'The Anthropic client cannot use the selected model.',
            }),
          );
        else
          decide(
            'error',
            chatFailure({
              ...base,
              kind: 'protocol',
              message:
                data.subtype === 'error_max_turns'
                  ? 'The client reached its turn limit before it finished.'
                  : 'The client reported an error and ended the turn.',
            }),
          );
      }
    }
    endInput();
    timers.push(schedule(terminate, RESULT_GRACE_MS));
  };

  const handleLine = (line: string) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return notice(
        'invalid-json',
        'The client wrote a line that is not JSON. CrewKite skipped it.',
      );
    }
    const head = frame.safeParse(value);
    if (!head.success) return unknown('unnamed');
    const { type, subtype } = head.data;
    // Subagent frames carry the parent's tool call ID. The parent's own tool card covers them.
    const nested = typeof head.data.parent_tool_use_id === 'string';
    switch (type) {
      case 'system':
        if (subtype === 'init') return onInit(value);
        // Status, command list and thinking token updates arrive in every turn and carry nothing
        // to read. A system event with its own text still gets a notice, since the thread
        // does not show that text.
        if (QUIET_SYSTEM.has(subtype ?? '') || !carriesText(value)) return;
        return unknown(`system/${label(subtype)}`);
      case 'stream_event':
        return nested ? undefined : onStream(value);
      case 'assistant':
        return nested ? undefined : onAssistant(value);
      case 'user':
        return nested ? undefined : onUser(value);
      case 'control_request':
        return onControl(value);
      case 'control_cancel_request':
        return onCancel(value);
      case 'rate_limit_event':
      case 'rate_limit':
        return onRateLimit(type, value);
      case 'result':
        return onResult(value);
      case 'keep_alive':
        return;
      default:
        return unknown(label(type));
    }
  };

  const settle = () => {
    if (settled) return;
    settled = true;
    for (const cancelTimer of timers) cancelTimer();
    // Items cut off by a stop or an exit still close, so the thread shows what arrived.
    for (const message of messages.values())
      for (const item of message.items)
        if (item && !item.done && item.text && (item.kind === 'text' || item.kind === 'thinking'))
          complete(item, item.text);
    const signedOut = SIGNED_OUT.test(stderr);
    const { stopReason, failure }: Outcome = outcome ?? {
      stopReason: 'error',
      failure: chatFailure({
        stage: started ? 'stream' : 'session',
        kind: signedOut ? 'signed-out' : 'client-exit',
        message: signedOut
          ? 'The Anthropic client is not signed in.'
          : 'The Anthropic client exited before it finished the turn.',
        providerMessage:
          stderr
            .split('\n')
            .filter((line) => line.trim())
            .at(-1)
            ?.trim() ?? null,
        code: exitCode,
      }),
    };
    send({ type: 'turn.completed', turnId, stopReason, failure });
    const at = now();
    resolveResult({
      stopReason,
      failure,
      assistantText: texts.join('\n\n'),
      session: session
        ? {
            family: 'anthropic',
            sessionId: session,
            model,
            updatedAt: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(),
          }
        : request.session?.family === 'anthropic'
          ? request.session
          : null,
      usage: usageSeen,
      changedPaths: [...changed],
    });
  };
  // Close input, interrupt, then escalate. armOwnedCleanup sends SIGKILL at one second and
  // settles once the group is gone, as every other owned native process does.
  function terminate() {
    if (settled || terminating) return;
    terminating = true;
    endInput();
    if (closed && absent()) return settle();
    signal('SIGINT');
    timers.push(schedule(() => signal('SIGTERM'), TERM_MS));
    armOwnedCleanup(
      {
        schedule,
        now: () => performance.now(),
        remaining: () => CLEANUP_MS,
        timers,
        signal,
        absent,
        closed: () => closed,
        finished: () => settled,
        settle,
      },
      CLEANUP_MS,
    );
  }

  child.on('error', () => {
    decide(
      'error',
      chatFailure({
        stage: 'launch',
        kind: 'client-missing',
        message: 'The Anthropic client could not be started.',
      }),
    );
    if (group > 0) return terminate();
    closed = true;
    settle();
  });
  child.stdin.on('error', () => {
    inputOpen = false;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (settled) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10, start)) {
      const line = pending.subarray(start, end).toString('utf8');
      start = end + 1;
      // After the result, a stop or a limit, the turn is decided and later frames change nothing.
      if (line.trim() && !resultSeen && !terminating) handleLine(line);
    }
    pending = pending.subarray(start);
    if (pending.length > MAX_LINE_BYTES) {
      pending = Buffer.alloc(0);
      decide(
        'error',
        chatFailure({
          stage: 'stream',
          kind: 'protocol',
          message: 'The client sent a frame larger than CrewKite accepts.',
        }),
      );
      terminate();
    }
  });
  child.once('close', (code: number | null) => {
    closed = true;
    exitCode = code;
    inputOpen = false;
    if (absent()) settle();
    else terminate();
  });
  if (Number.isFinite(request.deadlineMs))
    timers.push(
      schedule(
        () => {
          decide(
            'error',
            chatFailure({
              stage: 'stream',
              kind: 'timeout',
              message: 'The turn ran past its time limit.',
            }),
          );
          terminate();
        },
        Math.max(0, Math.min(request.deadlineMs, 2_147_483_647)),
      ),
    );

  // A resumed session already holds CrewKite's framing from its first message.
  const text = prior
    ? request.prompt
    : [request.systemContext, request.prompt].filter(Boolean).join('\n\n');
  write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

  return {
    respondPermission(requestId, choice) {
      const ask = asks.get(requestId);
      if (!ask || settled || terminating) return;
      asks.delete(requestId);
      answer(requestId, ask, choice);
    },
    stop() {
      if (settled) return;
      decide(
        'stopped',
        chatFailure({ stage: 'stream', kind: 'stopped', message: 'The turn was stopped.' }),
      );
      terminate();
    },
    groups: group > 0 ? [group] : [],
    result: outcomePromise,
  };
}
