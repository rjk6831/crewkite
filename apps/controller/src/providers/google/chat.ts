import { isAbsolute, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  AgentEvent,
  ChatFailure,
  ChatPermissionOption,
  ChatSession,
  ChatToolKind,
} from '@crewkite/contracts';
import { z } from 'zod';
import {
  type ChatAdapter,
  type ChatHistoryEntry,
  type ChatTurnRequest,
  type ChatTurnResult,
  chatFailure,
} from '../../chat/adapter.ts';
import type { Schedule } from '../../host/worker.ts';
import {
  type AcpConnection,
  AcpError,
  type AcpLifecycle,
  type AcpProcessOutcome,
  type AcpSpawn,
  type AcpStderrSummary,
  chatAcpLimits,
  startAcpProcess,
} from './acp/client.ts';
import type { AcpClientIdentity } from './acp/profile.ts';

// One chat turn on the published ACP agent. The connection, process ownership and stop
// handling come from acp/client.ts. This file translates between the protocol and AgentEvents.
// Everything read from the agent is parsed tolerantly: an unknown field is ignored, and an
// unknown update is reported once and never ends the turn.

type Select = { optionId: string; supported: readonly string[] };

/** Facts the controller resolves for one turn from the pinned client and its setup proof. */
export type GoogleChatLaunch = {
  client: AcpClientIdentity;
  /** Option ids and values the setup proof observed. Null skips model and thought-level choice. */
  configuration: { model: Select; thoughtLevel: Select | null } | null;
  /** The mode the setup proof verified as "ask before editing". */
  reviewMode: { configId: string; valueId: string } | null;
  /** Defaults to the request environment. */
  environment?: NodeJS.ProcessEnv;
  /** The controller's process journal. Defaults to no journal. */
  lifecycle?: AcpLifecycle;
  spawn?: AcpSpawn;
  schedule?: Schedule;
};

type RpcId = Parameters<AcpConnection['respond']>[0];
type Fault = { code: number; message: string; data?: unknown };
type Ending = { stopReason: ChatTurnResult['stopReason']; failure: ChatFailure | null };

const maximumTurnMs = chatAcpLimits.maxTimeoutMs;
const outputLimitBytes = 64 * 1024;
const pieceLimit = 60_000;
const noJournal: AcpLifecycle = { beforePhase() {}, owned() {}, quiescent() {} };

const optionalText = z.string().nullish().catch(undefined);
const toolUpdate = z.object({
  toolCallId: z.string().min(1).max(200),
  title: optionalText,
  kind: optionalText,
  status: optionalText,
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  content: z.array(z.unknown()).nullish().catch(undefined),
  locations: z.array(z.unknown()).nullish().catch(undefined),
});
type ToolUpdate = z.infer<typeof toolUpdate>;
const updateKind = z.object({ sessionUpdate: z.string() });
const blockUpdate = z.object({
  content: z
    .object({ type: z.string(), text: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});
const wordsContent = z.object({
  type: z.literal('content'),
  content: z.object({ type: z.string(), text: z.string().optional().catch(undefined) }),
});
const diffContent = z.object({
  type: z.literal('diff'),
  path: z.string(),
  oldText: z.string().nullish().catch(undefined),
  newText: z.string().catch(''),
});
const location = z.object({ path: z.string() });
const usageUpdate = z.object({ used: z.number().nonnegative(), size: z.number().nonnegative() });
const planUpdate = z.object({
  entries: z.array(
    z.object({ content: z.string(), status: z.string().optional().catch(undefined) }),
  ),
});
const permissionOption = z.object({
  optionId: z.string().min(1).max(200),
  name: z.string().optional().catch(undefined),
  kind: z.string(),
});
const permissionRequest = z.object({
  sessionId: z.string(),
  toolCall: toolUpdate,
  options: z.array(z.unknown()),
});
const initialized = z.object({
  protocolVersion: z.number().optional().catch(undefined),
  agentCapabilities: z
    .object({ loadSession: z.boolean().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});
const newSession = z.object({ sessionId: z.string().min(1).max(512) });
const promptResult = z.object({ stopReason: z.string() });
const faultFrame = z.object({
  error: z.object({
    code: z.number(),
    message: z.string().catch(''),
    data: z.unknown().optional(),
  }),
});
const optionAck = z.object({
  configOptions: z.array(z.object({ id: z.string(), currentValue: z.unknown() })),
});

const toolKinds = new Map<string, ChatToolKind>([
  ['read', 'read'],
  ['search', 'search'],
  ['edit', 'edit'],
  ['delete', 'edit'],
  ['move', 'edit'],
  ['execute', 'command'],
]);
const toolKind = (kind: string | null | undefined): ChatToolKind =>
  toolKinds.get(kind ?? '') ?? 'other';

// Listed in the order the person sees them.
const optionKinds = new Map<string, { kind: ChatPermissionOption['kind']; label: string }>([
  ['allow_once', { kind: 'allow-once', label: 'Allow once' }],
  ['allow_always', { kind: 'allow-thread', label: 'Allow for this thread' }],
  ['reject_once', { kind: 'deny', label: 'Deny' }],
  ['reject_always', { kind: 'deny', label: 'Deny always' }],
]);
const optionOrder = [...optionKinds.keys()];

// Housekeeping updates that carry nothing to show.
const quietUpdates = new Set([
  'user_message_chunk',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
]);
const limitWords = /quota|rate.?limit|exhaust|too many requests|\b429\b/i;
const limitSignals = new Set(['quota', 'rate-limit', 'resource-exhausted']);
const exitSites = new Set([
  'exit',
  'eof-pending',
  'stdout-stream',
  'stderr-stream',
  'stdin-stream',
]);
const declined = { outcome: { outcome: 'cancelled' } };

const clip = (value: string, maximum: number) =>
  value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
const pieces = (value: string) =>
  Array.from({ length: Math.ceil(value.length / pieceLimit) }, (_, i) =>
    value.slice(i * pieceLimit, (i + 1) * pieceLimit),
  );
const lines = (value: string) => (value === '' ? [] : value.replace(/\n$/, '').split('\n'));

class TurnFailure extends Error {
  readonly failure: ChatFailure;
  constructor(failure: ChatFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

/** Added and removed line counts. Common head and tail lines are skipped, the rest is an LCS. */
function lineDelta(before: string, after: string) {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA--;
    tailB--;
  }
  const x = a.slice(head, tailA);
  const y = b.slice(head, tailB);
  // shortcut: a very large rewrite counts as all removed and all added. Upgrade: Myers diff.
  if (x.length * y.length > 4_000_000) return { additions: y.length, deletions: x.length };
  let previous = new Uint32Array(y.length + 1);
  let current = new Uint32Array(y.length + 1);
  for (const line of x) {
    for (let j = 1; j <= y.length; j++)
      current[j] = line === y[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    [previous, current] = [current, previous];
  }
  return { additions: y.length - previous[y.length], deletions: x.length - previous[y.length] };
}

/** A reset time named in the error text, as a timestamp, or null. */
function resetTime(message: string, now: number): string | null {
  const stamp =
    /reset\D{0,40}(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))/i.exec(
      message,
    );
  const at = stamp ? Date.parse(stamp[1]) : Number.NaN;
  if (Number.isFinite(at)) return new Date(at).toISOString();
  const span =
    /reset\w*\s+(?:in|after)\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i.exec(
      message,
    ) ?? /retry\w*\W{1,6}(?:in\s+|after\s+)?()()(\d+(?:\.\d+)?)\s*s\b/i.exec(message);
  if (!span || !(span[1] || span[2] || span[3])) return null;
  const seconds = Number(span[1] || 0) * 3600 + Number(span[2] || 0) * 60 + Number(span[3] || 0);
  return new Date(now + seconds * 1000).toISOString();
}

/** The agent reports some failures as a JSON-RPC error whose text AcpConnection drops. */
function tapFaults(connection: AcpConnection) {
  let last: Fault | undefined;
  const decoder = new StringDecoder('utf8');
  let tail = '';
  const push = connection.push.bind(connection);
  // shortcut: error frames are read a second time here because AcpConnection keeps only the
  // code. Upgrade: expose the error message on the AcpError diagnostic.
  connection.push = (chunk) => {
    tail += decoder.write(chunk);
    for (let end = tail.indexOf('\n'); end >= 0; end = tail.indexOf('\n')) {
      const line = tail.slice(0, end);
      tail = tail.slice(end + 1);
      if (!line.includes('"error"')) continue;
      try {
        const frame = faultFrame.safeParse(JSON.parse(line));
        if (frame.success) last = frame.data.error;
      } catch {}
    }
    if (tail.length > 1_048_576) tail = '';
    push(chunk);
  };
  return () => last;
}

/** The most recent exchanges, newest first into a fixed budget, for a session that is gone. */
function historyBlock(history: readonly ChatHistoryEntry[]) {
  const picked: string[] = [];
  let size = 0;
  for (const entry of [...history].reverse()) {
    const line = `${entry.role === 'user' ? 'User' : 'Assistant'}: ${clip(entry.text, 6000)}`;
    if (size + line.length > 24_000) break;
    size += line.length;
    picked.unshift(line);
  }
  return picked.length ? `Earlier in this conversation:\n\n${picked.join('\n\n')}` : '';
}

function failureFor(
  error: unknown,
  stage: ChatFailure['stage'],
  fault: Fault | undefined,
  stderr: AcpStderrSummary | null,
  now: number,
): ChatFailure {
  if (error instanceof TurnFailure) return error.failure;
  if (!(error instanceof AcpError))
    return chatFailure({
      stage,
      kind: 'internal',
      message: 'The chat adapter hit an unexpected error.',
      providerMessage: error instanceof Error ? clip(error.message, 2000) : null,
    });
  const diagnostic = error.diagnostic;
  const base = {
    stage,
    method: diagnostic?.method ?? null,
    code: diagnostic?.rpcCode ?? null,
    // The tapped error belongs to this failure only when the agent answered with it.
    providerMessage: diagnostic?.site === 'rpc-error' && fault ? clip(fault.message, 16_000) : null,
  };
  if (diagnostic?.site === 'rpc-error') {
    const detail = `${fault?.message ?? ''} ${JSON.stringify(fault?.data ?? '')}`;
    if (
      limitWords.test(detail) ||
      stderr?.signals.some((signal) => limitSignals.has(signal.kind)) ||
      stderr?.httpStatuses.some((status) => status.code === 429)
    )
      return chatFailure({
        ...base,
        kind: 'usage-limit',
        message: 'Google reports that the usage allowance for this plan is used up.',
        resetsAt: resetTime(detail, now),
      });
    if (error.reason === 'authentication')
      return chatFailure({
        ...base,
        kind: 'signed-out',
        message: 'The Google client is not signed in.',
      });
    return chatFailure({
      ...base,
      kind: 'protocol',
      message: 'The Google client rejected the request.',
    });
  }
  switch (error.reason) {
    case 'authentication':
      return chatFailure({
        ...base,
        kind: 'signed-out',
        message: 'The Google client is not signed in.',
      });
    case 'launch':
    case 'identity':
      return chatFailure({
        ...base,
        kind: 'client-missing',
        message: 'The Google client is missing or does not match the build CrewKite installed.',
      });
    case 'deadline':
      return chatFailure({
        ...base,
        kind: 'timeout',
        message: 'The turn ran past its time limit.',
      });
    case 'output-limit':
      return chatFailure({
        ...base,
        kind: 'protocol',
        message: 'The Google client sent more output than one turn can carry.',
      });
    case 'ownership':
      return chatFailure({
        ...base,
        kind: 'client-exit',
        message: 'The Google client did not stop cleanly.',
      });
    default:
      return chatFailure({
        ...base,
        ...(exitSites.has(diagnostic?.site ?? '')
          ? {
              kind: 'client-exit' as const,
              message: 'The Google client exited before the turn finished.',
            }
          : {
              kind: 'protocol' as const,
              message: 'The Google client sent something this app could not read.',
            }),
      });
  }
}

type Call = {
  id: string;
  kind: ChatToolKind;
  /** The agent's own wording, kept so a later permission request can name the tool. */
  title: string | null;
  rawInput: unknown;
  denied: boolean;
  done: boolean;
  /** Paths inside the scratch copy, relative to it. */
  paths: Set<string>;
  outside: boolean;
  diffs: Map<string, { additions: number; deletions: number }>;
  seen: string;
  written: number;
  truncated: boolean;
};

export function googleChatAdapter(deps: {
  launch: (request: ChatTurnRequest) => GoogleChatLaunch;
}): ChatAdapter {
  return {
    family: 'google',
    startTurn(request, emit) {
      const now = request.now ?? Date.now;
      const { turnId } = request;
      const prior = request.session?.family === 'google' ? request.session : null;
      const scratch = resolve(request.scratch.directory);
      const groups: number[] = [];
      let closed = false;
      const send = (event: AgentEvent) => {
        if (!closed) emit(event);
      };

      // The launch can fail before any process exists. The person still gets events and a result.
      let launch: GoogleChatLaunch | null = null;
      let early: ChatFailure | null = null;
      try {
        launch = deps.launch(request);
        if (
          launch.configuration &&
          !launch.configuration.model.supported.includes(request.selection.model)
        )
          early = chatFailure({
            stage: 'launch',
            kind: 'model-unavailable',
            message: `The Google client does not offer the model ${clip(request.selection.model, 100)}.`,
          });
        else if (!launch.reviewMode && request.permissionPolicy !== 'allow-all')
          early = chatFailure({
            stage: 'launch',
            kind: 'client-missing',
            message: 'The Google client has no verified mode for asking before it edits.',
          });
      } catch (error) {
        early = chatFailure({
          stage: 'launch',
          kind: 'client-missing',
          message: 'The Google client is not ready.',
          providerMessage: error instanceof Error ? clip(error.message, 2000) : null,
        });
      }

      let connection: AcpConnection | null = null;
      let sessionId: string | null = null;
      let phase: 'setup' | 'replay' | 'turn' | 'done' = 'setup';
      let stage: ChatFailure['stage'] = 'launch';
      let promptStarted = false;
      let promptDone = false;
      let cancelled = false;
      let defect: unknown = null;
      let workError: unknown = null;
      let terminal: Ending | null = null;
      let lastFault: () => Fault | undefined = () => undefined;
      const buffered: Record<string, unknown>[] = [];
      const noticed = new Set<string>();
      const calls = new Map<string, Call>();
      const changed = new Set<string>();
      const texts: string[] = [];
      let item: { kind: 'text' | 'thinking'; id: string; text: string } | null = null;
      let itemCount = 0;
      let lastPlan = '';
      let usage: ChatTurnResult['usage'] = null;
      let permissionCount = 0;
      const pending = new Map<
        string,
        { rpc: RpcId; callId: string; options: Map<string, ChatPermissionOption['kind']> }
      >();

      const notice = (message: string, level: 'info' | 'warning' = 'info') =>
        send({ type: 'provider.notice', turnId, level, message: clip(message, 4000) });
      const noticeOnce = (key: string, message: string) => {
        if (noticed.has(key)) return;
        noticed.add(key);
        notice(message);
      };

      function closeItem() {
        if (!item) return;
        if (item.kind === 'text') {
          texts.push(item.text);
          send({ type: 'text.completed', turnId, itemId: item.id, text: item.text });
        } else send({ type: 'thinking.completed', turnId, itemId: item.id });
        item = null;
      }
      function chunk(kind: 'text' | 'thinking', value: string) {
        for (const piece of pieces(value)) {
          if (item && (item.kind !== kind || item.text.length + piece.length > pieceLimit))
            closeItem();
          item ??= { kind, id: `${turnId}:${kind}:${++itemCount}`, text: '' };
          item.text += piece;
          send({
            type: kind === 'text' ? 'text.delta' : 'thinking.delta',
            turnId,
            itemId: item.id,
            text: piece,
          });
        }
      }

      function inside(path: string) {
        const found = relative(scratch, isAbsolute(path) ? path : resolve(scratch, path));
        return found !== '' && !found.startsWith('..') && !isAbsolute(found) ? found : null;
      }
      function output(call: Call, value: string) {
        // An update may repeat everything so far. Only the new tail goes out.
        const fresh = value.startsWith(call.seen) ? value.slice(call.seen.length) : value;
        call.seen = value;
        if (fresh === '' || call.truncated) return;
        let piece = fresh;
        if (call.written + Buffer.byteLength(piece) > outputLimitBytes) {
          piece = Buffer.from(piece)
            .subarray(0, outputLimitBytes - call.written)
            .toString('utf8');
          call.truncated = true;
        }
        call.written += Buffer.byteLength(piece);
        send({
          type: 'tool.output',
          turnId,
          callId: call.id,
          chunk: piece,
          ...(call.truncated ? { truncated: true } : {}),
        });
      }
      function upsert(update: ToolUpdate): Call {
        let call = calls.get(update.toolCallId);
        if (!call) {
          closeItem();
          call = {
            id: update.toolCallId,
            kind: toolKind(update.kind),
            title: update.title?.trim() || null,
            rawInput: update.rawInput,
            denied: false,
            done: false,
            paths: new Set(),
            outside: false,
            diffs: new Map(),
            seen: '',
            written: 0,
            truncated: false,
          };
          calls.set(call.id, call);
          const raw = update.rawInput === undefined ? undefined : JSON.stringify(update.rawInput);
          send({
            type: 'tool.started',
            turnId,
            callId: call.id,
            kind: call.kind,
            title: clip(call.title || update.kind || 'Tool call', 1024),
            ...(raw === undefined
              ? {}
              : {
                  input:
                    raw.length <= 8192
                      ? update.rawInput
                      : { truncated: true, preview: raw.slice(0, 2048) },
                }),
          });
        } else {
          if (update.kind) call.kind = toolKind(update.kind);
          if (update.title?.trim()) call.title = update.title.trim();
          if (update.rawInput !== undefined) call.rawInput = update.rawInput;
        }
        for (const entry of update.locations ?? []) {
          const place = location.safeParse(entry);
          if (!place.success) continue;
          const found = inside(place.data.path);
          if (found) call.paths.add(found);
          else call.outside = true;
        }
        for (const entry of update.content ?? []) {
          const words = wordsContent.safeParse(entry);
          if (words.success) {
            if (words.data.content.type === 'text' && words.data.content.text)
              output(call, words.data.content.text);
            continue;
          }
          const diff = diffContent.safeParse(entry);
          if (!diff.success) continue;
          const found = inside(diff.data.path);
          if (found) call.paths.add(found);
          else call.outside = true;
          call.diffs.set(
            found ?? diff.data.path,
            lineDelta(diff.data.oldText ?? '', diff.data.newText),
          );
        }
        return call;
      }
      function finish(call: Call, status: 'ok' | 'error', summary?: string) {
        if (call.done) return;
        call.done = true;
        const outcome = call.denied ? 'denied' : status;
        const files = [...call.diffs];
        if (outcome === 'ok' && call.kind === 'edit')
          for (const path of call.paths) changed.add(path);
        const first = outcome === 'ok' ? files[0] : undefined;
        const note =
          outcome === 'denied'
            ? undefined
            : (summary ??
              (outcome === 'ok' && files.length > 1
                ? `Changed ${files.length} files: ${files.map(([path]) => path).join(', ')}`
                : undefined));
        send({
          type: 'tool.completed',
          turnId,
          callId: call.id,
          status: outcome,
          ...(first ? { diff: { path: first[0], ...first[1], patch: null } } : {}),
          ...(note ? { summary: clip(note, 4000) } : {}),
        });
      }
      function closeTools() {
        for (const call of calls.values())
          finish(call, 'error', 'The turn ended before this tool reported a result.');
      }

      function tool(raw: Record<string, unknown>) {
        const update = toolUpdate.safeParse(raw);
        if (!update.success)
          return noticeOnce(
            'tool',
            'The Google client sent a tool update this app could not read.',
          );
        const call = upsert(update.data);
        if (typeof update.data.rawOutput === 'string' && call.seen === '')
          output(call, update.data.rawOutput);
        if (update.data.status === 'completed') finish(call, 'ok');
        else if (update.data.status === 'failed') finish(call, 'error');
      }
      function plan(raw: Record<string, unknown>) {
        const parsed = planUpdate.safeParse(raw);
        if (!parsed.success)
          return noticeOnce('plan', 'The Google client sent a plan this app could not read.');
        const marks: Record<string, string> = { completed: '[x]', in_progress: '[~]' };
        const body = parsed.data.entries
          .map((entry) => `- ${marks[entry.status ?? ''] ?? '[ ]'} ${entry.content}`)
          .join('\n');
        if (body === lastPlan) return;
        lastPlan = body;
        notice(`Plan:\n${body}`);
      }
      function context(raw: Record<string, unknown>) {
        const parsed = usageUpdate.safeParse(raw);
        if (!parsed.success) return;
        const next = {
          usedTokens: Math.round(parsed.data.used),
          capacityTokens: parsed.data.size > 0 ? Math.round(parsed.data.size) : null,
        };
        if (usage?.usedTokens === next.usedTokens && usage.capacityTokens === next.capacityTokens)
          return;
        usage = next;
        send({ type: 'usage.context', turnId, ...next });
      }
      function update(params: Record<string, unknown>) {
        if (params.sessionId !== sessionId) return;
        const kind = updateKind.safeParse(params.update);
        if (!kind.success)
          return noticeOnce('session/update', 'The Google client sent an update without a kind.');
        const raw = params.update as Record<string, unknown>;
        switch (kind.data.sessionUpdate) {
          case 'agent_message_chunk':
          case 'agent_thought_chunk': {
            const block = blockUpdate.parse(raw).content;
            if (block?.type === 'text')
              chunk(
                kind.data.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking',
                block.text ?? '',
              );
            else if (block)
              noticeOnce(
                `content:${block.type}`,
                `The Google client sent ${clip(block.type, 40)} content this app does not show.`,
              );
            return;
          }
          case 'tool_call':
          case 'tool_call_update':
            return tool(raw);
          case 'plan':
            return plan(raw);
          case 'usage_update':
            return context(raw);
          default:
            if (!quietUpdates.has(kind.data.sessionUpdate))
              noticeOnce(
                `update:${kind.data.sessionUpdate}`,
                `The Google client sent an update this app does not show: ${clip(kind.data.sessionUpdate, 60)}.`,
              );
        }
      }

      // The request is parked before its event goes out, so an answer given from inside the
      // emit callback still finds it.
      function answer(id: RpcId, method: string, params: Record<string, unknown>) {
        const live = connection;
        if (!live) return;
        if (method !== 'session/request_permission') {
          noticeOnce(
            `request:${method}`,
            `The Google client asked for something this app does not provide: ${clip(method, 80)}.`,
          );
          return live.respond(id, {});
        }
        const parsed = permissionRequest.safeParse(params);
        if (
          !parsed.success ||
          phase !== 'turn' ||
          cancelled ||
          parsed.data.sessionId !== sessionId
        ) {
          if (phase === 'turn' && !cancelled)
            noticeOnce(
              'permission',
              'The Google client sent a permission request this app could not read.',
            );
          return live.respond(id, declined);
        }
        const ranked: { option: ChatPermissionOption; rank: number }[] = [];
        for (const raw of parsed.data.options) {
          const option = permissionOption.safeParse(raw);
          const known = option.success ? optionKinds.get(option.data.kind) : undefined;
          if (!option.success || !known || ranked.some((r) => r.option.id === option.data.optionId))
            continue;
          ranked.push({
            rank: optionOrder.indexOf(option.data.kind),
            option: {
              id: option.data.optionId,
              label: clip(option.data.name?.trim() || known.label, 200),
              kind: known.kind,
            },
          });
        }
        const options = ranked
          .sort((a, b) => a.rank - b.rank)
          .slice(0, 6)
          .map((r) => r.option);
        if (!options.length) {
          noticeOnce(
            'permission',
            'The Google client sent a permission request with no usable choices.',
          );
          return live.respond(id, declined);
        }
        const call = upsert(parsed.data.toolCall);
        const allow =
          options.find((option) => option.kind === 'allow-once') ??
          options.find((option) => option.kind === 'allow-thread');
        // An edit outside the scratch copy is always the person's call.
        const automatic =
          allow &&
          (request.permissionPolicy === 'allow-all' ||
            (request.permissionPolicy === 'allow-edits' &&
              call.kind === 'edit' &&
              call.paths.size > 0 &&
              !call.outside));
        const requestId = `${turnId}:permission:${++permissionCount}`;
        const detail = [
          call.paths.size ? `Paths: ${[...call.paths].join(', ')}` : '',
          call.rawInput === undefined ? '' : clip(JSON.stringify(call.rawInput), 4000),
        ]
          .filter(Boolean)
          .join('\n');
        if (!automatic)
          pending.set(requestId, {
            rpc: id,
            callId: call.id,
            options: new Map(options.map((option) => [option.id, option.kind])),
          });
        send({
          type: 'permission.requested',
          turnId,
          requestId,
          callId: call.id,
          question: clip(
            call.title
              ? call.title.endsWith('?')
                ? call.title
                : `Allow ${call.title}?`
              : 'Allow this action?',
            4000,
          ),
          detail: detail || null,
          options,
        });
        if (automatic) {
          live.respond(id, { outcome: { outcome: 'selected', optionId: allow.id } });
          send({ type: 'permission.resolved', turnId, requestId, choice: allow.id });
        }
      }

      function cancel() {
        if (cancelled || promptDone) return;
        cancelled = true;
        for (const [requestId, entry] of pending) {
          connection?.respond(entry.rpc, declined);
          send({ type: 'permission.resolved', turnId, requestId, choice: 'cancelled' });
        }
        pending.clear();
        if (promptStarted && sessionId) connection?.notify('session/cancel', { sessionId });
      }
      // An exception inside a protocol callback is a defect in this file, not bad data from the
      // agent. It stops the turn and is reported. It never reaches the connection.
      const guard = (work: () => void) => {
        try {
          work();
        } catch (error) {
          defect ??= error;
          try {
            cancel();
          } catch {}
        }
      };

      async function work(live: AcpConnection, onStop: (stop: () => void) => void) {
        connection = live;
        lastFault = tapFaults(live);
        live.onNotification = (method, params) =>
          guard(() => {
            if (method !== 'session/update')
              return noticeOnce(
                `method:${method}`,
                `The Google client sent a message this app does not use: ${clip(method, 80)}.`,
              );
            if (phase === 'setup') {
              if (buffered.length < 64) buffered.push(params);
            } else if (phase === 'turn') update(params);
          });
        live.onRequest = (id, method, params) => guard(() => answer(id, method, params));
        onStop(cancel);
        try {
          const handshake = initialized.parse(
            await live.request('initialize', {
              protocolVersion: 1,
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
              },
              clientInfo: { name: 'crewkite', version: '0.1.0' },
            }),
          );
          if (handshake.protocolVersion !== undefined && handshake.protocolVersion !== 1)
            throw new TurnFailure(
              chatFailure({
                stage,
                kind: 'protocol',
                method: 'initialize',
                message: 'The Google client speaks a protocol version this app does not.',
              }),
            );
          stage = 'session';
          let resumed = false;
          if (prior && handshake.agentCapabilities?.loadSession && !cancelled) {
            phase = 'replay';
            sessionId = prior.sessionId;
            try {
              // The agent replays the old conversation as updates before it answers. They are dropped.
              await live.request('session/load', {
                sessionId: prior.sessionId,
                cwd: scratch,
                mcpServers: [],
              });
              resumed = true;
            } catch (error) {
              if (live.failed) throw error;
              sessionId = null;
            }
          }
          if (prior && !resumed)
            notice('Previous session could not be resumed; started a new one.', 'warning');
          if (!resumed && !cancelled) {
            phase = 'setup';
            sessionId = newSession.parse(
              await live.request('session/new', { cwd: scratch, mcpServers: [] }),
            ).sessionId;
          }
          const id = sessionId;
          if (!id || cancelled) return;
          const set = async (configId: string, value: string) => {
            const ack = optionAck.safeParse(
              await live.request('session/set_config_option', { sessionId: id, configId, value }),
            );
            const option = ack.success
              ? ack.data.configOptions.find((o) => o.id === configId)
              : undefined;
            if (option && option.currentValue !== value)
              throw new TurnFailure(
                chatFailure({
                  stage,
                  kind: 'model-unavailable',
                  method: 'session/set_config_option',
                  message: 'The Google client did not accept the model or mode choice.',
                }),
              );
          };
          const setup = launch?.configuration;
          if (setup) {
            await set(setup.model.optionId, request.selection.model);
            const effort = request.selection.effort;
            if (setup.thoughtLevel && effort !== 'default') {
              if (setup.thoughtLevel.supported.includes(effort))
                await set(setup.thoughtLevel.optionId, effort);
              else notice(`The Google client has no ${effort} thought level; using its default.`);
            }
          }
          if (launch?.reviewMode) await set(launch.reviewMode.configId, launch.reviewMode.valueId);
          if (cancelled) return;

          const parts: string[] = [];
          if (!resumed) {
            if (request.systemContext) parts.push(request.systemContext);
            if (prior) parts.push(historyBlock(request.history));
          }
          parts.push(request.prompt);
          stage = 'prompt';
          phase = 'turn';
          promptStarted = true;
          for (const params of buffered.splice(0)) guard(() => update(params));
          const reply = promptResult.safeParse(
            await live.request('session/prompt', {
              sessionId: id,
              prompt: [{ type: 'text', text: parts.filter(Boolean).join('\n\n') }],
            }),
          );
          promptDone = true;
          phase = 'done';
          stage = 'finish';
          closeItem();
          closeTools();
          const reason = reply.success ? reply.data.stopReason : 'unreadable';
          if (reason === 'cancelled') terminal = { stopReason: 'stopped', failure: null };
          else if (reason === 'refusal')
            terminal = {
              stopReason: 'error',
              failure: chatFailure({
                stage,
                kind: 'model-unavailable',
                method: 'session/prompt',
                message: 'The model declined to do this request.',
                nextAction:
                  'Rephrase the request or pick another model in the composer, then send again.',
              }),
            };
          else {
            if (reason !== 'end_turn')
              notice(
                reason === 'max_tokens'
                  ? 'The reply stopped at the model output limit.'
                  : reason === 'max_turn_requests'
                    ? 'The agent stopped at its limit of steps for one turn.'
                    : `The Google client ended the turn with an unrecognized reason: ${clip(reason, 60)}.`,
                'warning',
              );
            terminal = { stopReason: 'done', failure: null };
          }
        } catch (error) {
          workError = error;
        }
      }

      let running: ReturnType<typeof startAcpProcess<void>> | null = null;
      let startFailure: ChatFailure | null = null;
      if (launch && !early) {
        try {
          const timeout = Number.isFinite(request.deadlineMs)
            ? Math.floor(request.deadlineMs)
            : maximumTurnMs;
          running = startAcpProcess<void>(
            {
              client: launch.client,
              // The client keeps its own tmp folder here, so this is the private work folder
              // and the session working directory below is the scratch copy.
              directory: request.work.directory,
              environment: launch.environment ?? request.environment,
              lifecycle: launch.lifecycle ?? noJournal,
              timeoutMs: Math.min(maximumTurnMs, Math.max(2000, timeout)),
              limits: chatAcpLimits,
              spawn: launch.spawn,
              schedule: launch.schedule,
            },
            work,
          );
          if (running.group > 0) groups.push(running.group);
        } catch (error) {
          // The client refuses a changed executable or an unsafe folder with a plain Error.
          startFailure =
            error instanceof AcpError
              ? failureFor(error, 'launch', undefined, null, now())
              : chatFailure({
                  stage: 'launch',
                  kind: 'client-missing',
                  message: 'The Google client could not be started from its installed location.',
                  providerMessage: error instanceof Error ? clip(error.message, 2000) : null,
                });
        }
      }

      function conclude(outcome: AcpProcessOutcome<void>): Ending {
        const fail = (error: unknown): Ending => {
          const failure = failureFor(error, stage, lastFault(), outcome.stderrSummary, now());
          return { stopReason: failure.kind === 'usage-limit' ? 'limit' : 'error', failure };
        };
        if (defect) return fail(defect);
        if (outcome.reason === 'deadline' && terminal?.stopReason !== 'done')
          return fail(new AcpError('deadline'));
        if (terminal) {
          // The reply is complete. A rough exit is reported, and the controller still proves the
          // process group absent from `groups`.
          if (outcome.reason && outcome.reason !== 'stopped' && outcome.reason !== 'deadline')
            notice('The Google client did not exit cleanly.', 'warning');
          return terminal;
        }
        if (outcome.reason === 'stopped' || cancelled)
          return { stopReason: 'stopped', failure: null };
        return fail(workError ?? new AcpError(outcome.reason ?? 'protocol', outcome.diagnostic));
      }

      const result = (async (): Promise<ChatTurnResult> => {
        let ending: Ending;
        try {
          await Promise.resolve();
          send({
            type: 'turn.started',
            turnId,
            family: 'google',
            model: request.selection.model,
            effort: request.selection.effort,
            role: request.role,
          });
          const failure = early ?? startFailure;
          ending = failure
            ? { stopReason: 'error', failure }
            : running
              ? conclude(await running.result)
              : { stopReason: 'error', failure: null };
        } catch (error) {
          ending = {
            stopReason: 'error',
            failure: failureFor(error, stage, undefined, null, now()),
          };
        }
        phase = 'done';
        closeItem();
        closeTools();
        send({ type: 'turn.completed', turnId, ...ending });
        closed = true;
        const session: ChatSession | null = sessionId
          ? {
              family: 'google',
              sessionId,
              model: request.selection.model,
              updatedAt: new Date(now()).toISOString(),
            }
          : prior;
        return {
          ...ending,
          assistantText: texts.join('\n\n'),
          session,
          usage,
          changedPaths: [...changed],
        };
      })();

      return {
        groups,
        result,
        respondPermission(requestId, choice) {
          const entry = pending.get(requestId);
          const kind = entry?.options.get(choice);
          if (!entry || !kind || !connection || closed) return;
          pending.delete(requestId);
          const call = calls.get(entry.callId);
          if (call && kind === 'deny') call.denied = true;
          try {
            connection.respond(entry.rpc, { outcome: { outcome: 'selected', optionId: choice } });
          } catch {
            return;
          }
          send({ type: 'permission.resolved', turnId, requestId, choice });
        },
        stop() {
          if (!promptDone) running?.stop();
        },
      };
    },
  };
}
