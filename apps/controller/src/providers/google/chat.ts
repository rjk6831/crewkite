import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
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
import { googleMcpEntries } from '../../chat/mcp-servers.ts';
import { attachedLine, attachedSection } from '../../chat/prompt.ts';
import type { ThreadToolsServer } from '../../chat/thread-tools/broker.ts';
import { turnTools } from '../../chat/thread-tools/turn.ts';
import { frameTrace } from '../../chat/trace.ts';
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
import { ACP_SESSION_MODELS, type AcpClientIdentity } from './acp/profile.ts';

// One chat turn on the published ACP agent. The connection, process ownership and stop
// handling come from acp/client.ts. This file translates between the protocol and AgentEvents.
// Everything read from the agent is parsed tolerantly: an unknown field is ignored, an unknown
// update or method goes only to the frame trace, and neither ends the turn.

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

/** The block types the agent said it takes in a prompt. The protocol defaults each to false. */
export type GooglePromptCapabilities = { image: boolean; audio: boolean; embeddedContext: boolean };

type RpcId = Parameters<AcpConnection['respond']>[0];
type Fault = { code: number; message: string; data?: unknown };
type Ending = { stopReason: ChatTurnResult['stopReason']; failure: ChatFailure | null };

const maximumTurnMs = chatAcpLimits.maxTimeoutMs;
const outputLimitBytes = 64 * 1024;
const pieceLimit = 60_000;
const traceLimits = { lines: 5000, bytes: 2 * 1024 * 1024 };
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
const flag = z.boolean().optional().catch(undefined);
const initialized = z.object({
  protocolVersion: z.number().optional().catch(undefined),
  agentCapabilities: z
    .object({
      loadSession: flag,
      promptCapabilities: z
        .object({ image: flag, audio: flag, embeddedContext: flag })
        .optional()
        .catch(undefined),
    })
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
// The protocol names these kinds. Both remove a file at its old path, so they stay marked after
// they fold into edit.
const deletingKinds = new Set(['delete', 'move']);
const toolKind = (kind: string | null | undefined): ChatToolKind =>
  toolKinds.get(kind ?? '') ?? 'other';
// Kinds whose result goes only to the model. A fetch arrives as other.
const passiveKinds = new Set<ChatToolKind>(['read', 'search', 'other']);
// The agent answers a stop with this line. The thread already ends with its own Stopped line.
const stopLine = /\s*the request was cancell?ed by the client\.?\s*$/i;

// Listed in the order the person sees them.
const optionKinds = new Map<string, { kind: ChatPermissionOption['kind']; label: string }>([
  ['allow_once', { kind: 'allow-once', label: 'Allow once' }],
  ['allow_always', { kind: 'allow-thread', label: 'Allow for this thread' }],
  ['reject_once', { kind: 'deny', label: 'Deny' }],
  ['reject_always', { kind: 'deny', label: 'Deny always' }],
]);
const optionOrder = [...optionKinds.keys()];

// What the client says when the backend answers 404 for a model: its ModelNotFoundError carries
// the server text, or "Model not found" when that is empty.
const modelWords =
  /model[\s\S]{0,40}not[ _-]?found|ModelNotFound|unrecognized[ _]model|unknown model/i;
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
const fields = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** A frame field as the trace keeps it. Text is clipped and a nested value keeps only its type. */
const traceField = (value: unknown) =>
  typeof value === 'string'
    ? clip(value, 200)
    : value === undefined || value === null || typeof value !== 'object'
      ? value
      : Array.isArray(value)
        ? '(array)'
        : '(object)';
/**
 * Names and states of one update or tool call. Content and output text never go in. A command
 * call's title is its command line, so only the title's length does.
 */
const frameFacts = (value: unknown) => {
  const frame = fields(value);
  return {
    toolCallId: traceField(frame.toolCallId),
    status: traceField(frame.status),
    kind: traceField(frame.kind),
    titleLength: typeof frame.title === 'string' ? frame.title.length : undefined,
    keys: Object.keys(frame)
      .slice(0, 32)
      .map((key) => clip(key, 60)),
  };
};

/** The first raw input field under one of `names`, compared without case or underscores. */
function inputField(input: unknown, names: readonly string[]) {
  for (const [key, value] of Object.entries(fields(input)))
    if (names.includes(key.toLowerCase().replaceAll('_', ''))) return value;
}

/**
 * A card title the way the other families write one: the file, the pattern or the command. The
 * agent titles every read with its tool name, so fifteen reads would say the same thing. Null
 * when the frame does not name the target, and the agent's own title stays.
 */
function cardTitle(kind: ChatToolKind, place: string | null, input: unknown): string | null {
  const words = (names: readonly string[]) => {
    const value = inputField(input, names);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  const line = (names: readonly string[]) => {
    const value = inputField(input, names);
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  if (kind === 'read' && place) {
    const start = line(['start', 'startline']);
    const end = line(['end', 'endline']);
    return `Read ${place}${start && end ? ` lines ${start}-${end}` : ''}`;
  }
  if (kind === 'edit' && place) return `Edit ${place}`;
  const pattern = kind === 'search' ? words(['pattern', 'query', 'regex']) : null;
  if (pattern) return `Search ${pattern}${place ? ` in ${place}` : ''}`;
  const command = kind === 'command' ? words(['command', 'commandline', 'cmd']) : null;
  return command ? `Run ${clip(command.split(/\r?\n/)[0], 120)}` : null;
}

/** One line for a model ID the client does not serve to this account, typed IDs included. */
const modelRefusal = (model: string) =>
  `Google does not serve the model ${clip(model, 120)} to this account.`;

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

type TurnFile = NonNullable<ChatTurnRequest['files']>[number];
type PromptBlock = Record<string, unknown>;

// The chat connection refuses a line over its line limit. The margin covers the request envelope.
const promptLineBytes = chatAcpLimits.lineBytes - 16 * 1024;
const textTypes = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|sql|x-sh)$)/;

/**
 * The prompt as content blocks, text first, then one block per file in the richest form the
 * agent declared. Every agent must accept a resource_link, so a file gets one when no flag
 * covers it, or when its inline form would not fit in the frame. A file from an earlier message
 * always goes as a link and is never read. `linked` names the files that had an inline form and
 * went as a link for size. `attached` is true when the prompt carried a file of this message.
 */
function promptBlocks(
  text: string,
  files: readonly TurnFile[],
  capabilities: GooglePromptCapabilities,
  stage: ChatFailure['stage'],
) {
  const blocks: PromptBlock[] = [{ type: 'text', text }];
  const linked: string[] = [];
  const lines: string[] = [];
  // The lines for this message's files join the text block last, so their size is held back now.
  let bytes =
    Buffer.byteLength(JSON.stringify(blocks)) + files.filter((file) => !file.earlier).length * 1024;
  const fits = (block: PromptBlock) => bytes + Buffer.byteLength(JSON.stringify(block)) + 1;
  for (const { attachment, path, earlier } of files) {
    const { mimeType, name } = attachment;
    const uri = pathToFileURL(path).href;
    const link: PromptBlock = {
      type: 'resource_link',
      uri,
      name,
      mimeType,
      size: attachment.bytes,
    };
    const kind = earlier
      ? null
      : capabilities.image && mimeType.startsWith('image/')
        ? 'image'
        : capabilities.audio && mimeType.startsWith('audio/')
          ? 'audio'
          : capabilities.embeddedContext
            ? 'resource'
            : null;
    let block = link;
    // The size on disk decides, so a file that cannot fit is never read. Base64 is four bytes
    // for every three.
    let raw: Buffer | null = null;
    if (kind) {
      let fd: number | null = null;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error(`${name} is not a regular file`);
        if (bytes + Math.ceil(stat.size / 3) * 4 + 512 <= promptLineBytes) raw = readFileSync(fd);
      } catch (error) {
        throw new TurnFailure(
          chatFailure({
            stage,
            kind: 'internal',
            message: `CrewKite could not read the stored file ${clip(name, 200)}.`,
            providerMessage: error instanceof Error ? clip(error.message, 2000) : null,
          }),
        );
      } finally {
        if (fd !== null) closeSync(fd);
      }
    }
    if (kind && raw) {
      const decoded = raw.toString('utf8');
      const plain = textTypes.test(mimeType) && Buffer.from(decoded).equals(raw);
      block =
        kind === 'resource'
          ? {
              type: 'resource',
              resource: plain
                ? { uri, mimeType, text: decoded }
                : { uri, mimeType, blob: raw.toString('base64') },
            }
          : { type: kind, data: raw.toString('base64'), mimeType };
    }
    // Escaped text can grow past the estimate, so the built block is measured too.
    if (block !== link && fits(block) > promptLineBytes) block = link;
    if (block === link && kind) linked.push(name);
    bytes = fits(block);
    blocks.push(block);
    // The packet lists an earlier file already.
    if (!earlier)
      lines.push(
        attachedLine(
          attachment,
          block === link
            ? 'sent as a file link below'
            : `sent as ${block.type === 'resource' ? 'an embedded resource' : `an ${block.type} block`} below`,
        ),
      );
  }
  const section = attachedSection(lines);
  if (section) blocks[0] = { type: 'text', text: [text, section].filter(Boolean).join('\n\n') };
  return { blocks, linked, attached: files.some((file) => !file.earlier) };
}

function failureFor(
  error: unknown,
  stage: ChatFailure['stage'],
  fault: Fault | undefined,
  stderr: AcpStderrSummary | null,
  now: number,
  attached = false,
  model: string | null = null,
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
    if (model !== null && modelWords.test(detail))
      return chatFailure({ ...base, kind: 'model-unavailable', message: modelRefusal(model) });
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
    // The protocol names no error for a block the agent refuses. A prompt error on a prompt
    // that carried files is read as a refusal of the files, with the agent's own words.
    if (attached && diagnostic.method === 'session/prompt')
      return chatFailure({
        ...base,
        kind: 'attachment-rejected',
        message: 'The Google client did not accept the attached files.',
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
  /** The agent named the call a delete or a move in any update. */
  deletes: boolean;
  diffs: Map<string, { additions: number; deletions: number }>;
  seen: string;
  written: number;
  truncated: boolean;
};

export function googleChatAdapter(deps: {
  launch: (request: ChatTurnRequest) => GoogleChatLaunch;
  /** Called with what each initialize declared, so the catalog can say which files go native. */
  onPromptCapabilities?: (capabilities: GooglePromptCapabilities) => void;
  /** The thread tools server for this turn, with its own token. Null runs the turn without. */
  threadTools?: (request: ChatTurnRequest) => ThreadToolsServer | null;
}): ChatAdapter {
  return {
    family: 'google',
    startTurn(original, emit) {
      const minted = turnTools(deps.threadTools, original, emit);
      const request = minted.request;
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
        // A model outside the client's list may be one the person typed, so the client decides
        // when the turn sets it, and the refusal reads the same as for a listed model.
        // Every policy keeps edits inside the scratch copy, and only the asking mode lets
        // CrewKite see an edit before it lands. Without it the client would edit on its own
        // under allow-all too, so no policy starts a turn.
        if (!launch.reviewMode)
          early = chatFailure({
            stage: 'launch',
            kind: 'client-missing',
            message: 'The Google client has no verified mode for asking before it edits.',
            nextAction: 'Run Connect Google again so discovery can verify the mode.',
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
      // The prompt carries a block other than its text.
      let attached = false;
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
      let afterStop = '';
      let lastPlan = '';
      let usage: ChatTurnResult['usage'] = null;
      let permissionCount = 0;
      const pending = new Map<
        string,
        { rpc: RpcId; callId: string; options: Map<string, ChatPermissionOption['kind']> }
      >();

      // One line of metadata per frame goes to the private work folder, so a client whose framing
      // does not match this file can be diagnosed from a real run.
      const frames = frameTrace(now, traceLimits);
      const trace = frames.write;
      function traceFrame(method: string, params: Record<string, unknown>, id?: RpcId) {
        trace(() => {
          const update = method === 'session/update';
          const subject = update ? params.update : (params.toolCall ?? params);
          return {
            ...(update
              ? { update: traceField(fields(subject).sessionUpdate) }
              : { method: clip(method, 80) }),
            ...(id === undefined ? {} : { id: traceField(id) }),
            ...frameFacts(subject),
            // update() drops a frame for another session without a word.
            ...(update && phase === 'turn' && params.sessionId !== sessionId
              ? { otherSession: true }
              : {}),
            bytes: Buffer.byteLength(JSON.stringify(params)),
          };
        });
      }
      function reply(live: AcpConnection, id: RpcId, result: { outcome: Record<string, unknown> }) {
        live.respond(id, result);
        trace(() => ({
          reply: 'session/request_permission',
          id: traceField(id),
          outcome: traceField(result.outcome.outcome),
          optionId: traceField(result.outcome.optionId),
          bytes: Buffer.byteLength(JSON.stringify(result)),
        }));
      }

      // `trace` marks what the client says about its session or settings. The view keeps it in the
      // turn trace.
      const notice = (message: string, level: 'info' | 'warning' = 'info', trace = false) =>
        send({
          type: 'provider.notice',
          turnId,
          level,
          message: clip(message, 4000),
          ...(trace ? { trace: true as const } : {}),
        });
      // One notice per turn for a frame CrewKite acts on and could not read. Every frame is in
      // the trace already, so later ones add nothing the trace lacks.
      const unreadable = (message: string) => {
        if (noticed.has('unreadable')) return;
        noticed.add('unreadable');
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
        const fresh = !call;
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
            deletes: deletingKinds.has(update.kind ?? ''),
            diffs: new Map(),
            seen: '',
            written: 0,
            truncated: false,
          };
          calls.set(call.id, call);
        } else {
          if (update.kind) call.kind = toolKind(update.kind);
          if (deletingKinds.has(update.kind ?? '')) call.deletes = true;
          if (update.title?.trim()) call.title = update.title.trim();
          if (update.rawInput !== undefined) call.rawInput = update.rawInput;
        }
        // The first place the frame names, relative to the scratch copy when it is inside. The
        // copy itself names no place.
        let place: string | null = null;
        for (const entry of update.locations ?? []) {
          const parsed = location.safeParse(entry);
          if (!parsed.success) continue;
          const found = inside(parsed.data.path);
          if (found) call.paths.add(found);
          else call.outside = true;
          place ??=
            found ?? (resolve(scratch, parsed.data.path) === scratch ? null : parsed.data.path);
        }
        if (fresh) {
          const raw = update.rawInput === undefined ? undefined : JSON.stringify(update.rawInput);
          send({
            type: 'tool.started',
            turnId,
            callId: call.id,
            kind: call.kind,
            title: clip(
              cardTitle(call.kind, place, update.rawInput) ||
                call.title ||
                update.kind ||
                'Tool call',
              1024,
            ),
            ...(raw === undefined
              ? {}
              : {
                  input:
                    raw.length <= 8192
                      ? update.rawInput
                      : { truncated: true, preview: raw.slice(0, 2048) },
                }),
          });
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

      // This agent keys a call's terminal update by a frame id, which is the permission prompt's
      // id when the call went through one and the call id otherwise. When that id differs from
      // the announced one, the card spins until the turn ends. Two fallbacks close it. A terminal
      // update with an unknown id and no title completes the newest open read, search or other
      // call, or the newest open call of the kind it names, and never opens a card of its own.
      // And once the agent moves on to its reply or to a usage update, a read, search or other
      // call is done, since its result went back to the model. A live run sent a usage update
      // after every read. A new call is no such sign, because calls can run side by side and a
      // read still running can fail. Edits and commands wait for a real status, because the
      // person needs to know how they went. So does a call behind an open permission card,
      // which no fallback closes. A card closed this way has nothing to add, so it gets no
      // summary and stays one line.
      const asking = (call: Call) =>
        [...pending.values()].some((entry) => entry.callId === call.id);
      function settle() {
        for (const call of calls.values())
          if (!call.done && passiveKinds.has(call.kind) && !asking(call)) finish(call, 'ok');
      }
      function tool(raw: Record<string, unknown>, announced: boolean) {
        const parsed = toolUpdate.safeParse(raw);
        if (!parsed.success)
          return unreadable('The Google client sent a tool update this app could not read.');
        let update = parsed.data;
        const ends = update.status === 'completed' || update.status === 'failed';
        if (!announced && ends && !calls.has(update.toolCallId) && !update.title?.trim()) {
          const kind = update.kind ? toolKind(update.kind) : null;
          const open = [...calls.values()]
            .filter(
              (call) =>
                !call.done &&
                !asking(call) &&
                (kind ? call.kind === kind : passiveKinds.has(call.kind)),
            )
            .at(-1);
          if (!open) return;
          update = { ...update, toolCallId: open.id };
        }
        // A late update for a closed card would put output under a finished result.
        if (calls.get(update.toolCallId)?.done) return;
        const call = upsert(update);
        if (typeof update.rawOutput === 'string' && call.seen === '')
          output(call, update.rawOutput);
        if (update.status === 'completed') finish(call, 'ok');
        else if (update.status === 'failed') finish(call, 'error');
      }
      function plan(raw: Record<string, unknown>) {
        const parsed = planUpdate.safeParse(raw);
        if (!parsed.success)
          return unreadable('The Google client sent a plan this app could not read.');
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
        if (!kind.success) return unreadable('The Google client sent an update without a kind.');
        const raw = params.update as Record<string, unknown>;
        switch (kind.data.sessionUpdate) {
          case 'agent_message_chunk':
          case 'agent_thought_chunk': {
            const message = kind.data.sessionUpdate === 'agent_message_chunk';
            if (message) settle();
            const block = blockUpdate.parse(raw).content;
            // Words after the person's stop wait for the turn to end, so the agent's stop line
            // can be told apart from the rest even when it arrives in pieces.
            if (block?.type === 'text' && message && cancelled) afterStop += block.text ?? '';
            else if (block?.type === 'text') chunk(message ? 'text' : 'thinking', block.text ?? '');
            else if (block)
              unreadable(
                `The Google client sent ${clip(block.type, 40)} content this app does not show.`,
              );
            return;
          }
          case 'tool_call':
            return tool(raw, true);
          case 'tool_call_update':
            return tool(raw, false);
          case 'plan':
            return plan(raw);
          case 'usage_update':
            settle();
            return context(raw);
        }
      }

      // The request is parked before its event goes out, so an answer given from inside the
      // emit callback still finds it.
      function answer(id: RpcId, method: string, params: Record<string, unknown>) {
        const live = connection;
        if (!live) return;
        if (method !== 'session/request_permission') return live.respond(id, {});
        const parsed = permissionRequest.safeParse(params);
        if (
          !parsed.success ||
          phase !== 'turn' ||
          cancelled ||
          parsed.data.sessionId !== sessionId
        ) {
          if (phase === 'turn' && !cancelled)
            unreadable('The Google client sent a permission request this app could not read.');
          return reply(live, id, declined);
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
          unreadable('The Google client sent a permission request with no usable choices.');
          return reply(live, id, declined);
        }
        const call = upsert(parsed.data.toolCall);
        const allow =
          options.find((option) => option.kind === 'allow-once') ??
          options.find((option) => option.kind === 'allow-thread');
        // Review and advice turns read only.
        const refuses =
          request.readOnly === true && (call.kind === 'edit' || call.kind === 'command');
        const reject = options.find((option) => option.kind === 'deny');
        if (refuses && !reject) return reply(live, id, declined);
        // Edits land only in the scratch copy, so allow-edits and allow-all answer an edit only when
        // it names paths and all of them are inside. allow-all answers every other kind.
        const policy = request.permissionPolicy;
        const permitted =
          allow &&
          (call.kind === 'edit'
            ? (policy === 'allow-edits' || policy === 'allow-all') &&
              call.paths.size > 0 &&
              !call.outside
            : policy === 'allow-all')
            ? allow
            : undefined;
        // Thread grant: a kind the person allowed for the whole thread is answered without
        // asking, on the allow-thread option when the client offers one. A call that touches
        // paths outside the scratch copy is still the person's call. A grant never covers
        // `other`, because that kind says nothing about what the call does.
        const granted =
          call.kind !== 'other' && request.permissionGrants?.includes(call.kind) && !call.outside
            ? (options.find((option) => option.kind === 'allow-thread') ?? allow)
            : undefined;
        const automatic = refuses ? reject : (granted ?? permitted);
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
          ...(call.deletes ? { deletes: true as const } : {}),
        });
        if (automatic) {
          if (refuses) call.denied = true;
          reply(live, id, { outcome: { outcome: 'selected', optionId: automatic.id } });
          send({ type: 'permission.resolved', turnId, requestId, choice: automatic.id });
        }
      }

      function cancel() {
        if (cancelled || promptDone) return;
        cancelled = true;
        for (const [requestId, entry] of pending) {
          if (connection) reply(connection, entry.rpc, declined);
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
            // A replayed conversation can run to thousands of frames and would fill the trace
            // before the turn starts.
            if (phase !== 'replay') traceFrame(method, params);
            if (method !== 'session/update') return;
            if (phase === 'setup') {
              if (buffered.length < 64) buffered.push(params);
            } else if (phase === 'turn') update(params);
          });
        live.onRequest = (id, method, params) =>
          guard(() => {
            traceFrame(method, params, id);
            answer(id, method, params);
          });
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
          const declared = handshake.agentCapabilities?.promptCapabilities;
          const capabilities: GooglePromptCapabilities = {
            image: declared?.image === true,
            audio: declared?.audio === true,
            embeddedContext: declared?.embeddedContext === true,
          };
          try {
            deps.onPromptCapabilities?.(capabilities);
          } catch {}
          stage = 'session';
          // ACP takes the session's servers on session/new and session/load. The thread tools are
          // the only one, and the agent starts it in the session's own process.
          const tools = minted.server;
          const mcpServers = [
            ...(tools
              ? [{ name: tools.name, command: tools.command, args: [...tools.args], env: [] }]
              : []),
            ...googleMcpEntries(request.mcp),
          ];
          let resumed = false;
          if (prior && handshake.agentCapabilities?.loadSession && !cancelled) {
            phase = 'replay';
            sessionId = prior.sessionId;
            try {
              // The agent replays the old conversation as updates before it answers. They are dropped.
              await live.request('session/load', {
                sessionId: prior.sessionId,
                cwd: scratch,
                mcpServers,
              });
              resumed = true;
            } catch (error) {
              if (live.failed) throw error;
              sessionId = null;
            }
          }
          if (prior && !resumed)
            notice('Previous session could not be resumed; started a new one.', 'warning', true);
          if (!resumed && !cancelled) {
            phase = 'setup';
            sessionId = newSession.parse(
              await live.request('session/new', { cwd: scratch, mcpServers }),
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
          // The client answers an ID it does not serve with a JSON-RPC error here, or with a
          // value other than the one sent. Both read as the same refusal.
          const setModel = async (name: string, optionId: string) => {
            const refuse = () =>
              new TurnFailure(
                chatFailure({
                  stage,
                  kind: 'model-unavailable',
                  method:
                    optionId === ACP_SESSION_MODELS
                      ? 'session/set_model'
                      : 'session/set_config_option',
                  message: modelRefusal(name),
                }),
              );
            try {
              if (optionId === ACP_SESSION_MODELS)
                await live.request('session/set_model', { sessionId: id, modelId: name });
              else await set(optionId, name);
            } catch (error) {
              if (
                error instanceof TurnFailure ||
                (error instanceof AcpError &&
                  error.diagnostic?.site === 'rpc-error' &&
                  error.reason !== 'authentication')
              )
                throw refuse();
              throw error;
            }
          };
          const setup = launch?.configuration;
          if (setup) {
            await setModel(request.selection.model, setup.model.optionId);
            const effort = request.selection.effort;
            if (setup.thoughtLevel && effort !== 'default') {
              if (setup.thoughtLevel.supported.includes(effort))
                await set(setup.thoughtLevel.optionId, effort);
              else
                notice(
                  `The Google client has no ${effort} thought level; using its default.`,
                  'info',
                  true,
                );
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
          const prompt = promptBlocks(
            parts.filter(Boolean).join('\n\n'),
            request.files ?? [],
            capabilities,
            stage,
          );
          const { blocks, linked } = prompt;
          // An error over files from earlier messages alone is not read as a refusal of them.
          attached = prompt.attached;
          if (linked.length)
            notice(
              `Sent as a file link, too large to send inline: ${linked.map((name) => clip(name, 200)).join(', ')}.`,
            );
          phase = 'turn';
          promptStarted = true;
          for (const params of buffered.splice(0)) guard(() => update(params));
          const reply = promptResult.safeParse(
            await live.request('session/prompt', { sessionId: id, prompt: blocks }),
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
          // startAcpProcess has checked that the folder is private and owned, and no frame is
          // read before this line runs. O_NOFOLLOW keeps a link there from moving the trace.
          frames.open(join(request.work.directory, 'acp-trace.jsonl'));
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
          const failure = failureFor(
            error,
            stage,
            lastFault(),
            outcome.stderrSummary,
            now(),
            attached,
            request.selection.model,
          );
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
          // The badge names the level the turn runs at. A level the client does not offer, or a
          // launch with no thought-level choice, leaves the client at its default.
          const { effort } = request.selection;
          const offered = launch?.configuration?.thoughtLevel?.supported.includes(effort);
          send({
            type: 'turn.started',
            turnId,
            family: 'google',
            model: request.selection.model,
            effort: offered ? effort : 'default',
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
        const rest = afterStop.replace(stopLine, '');
        if (rest.trim()) chunk('text', rest);
        closeItem();
        closeTools();
        send({ type: 'turn.completed', turnId, ...ending });
        closed = true;
        frames.close();
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
            reply(connection, entry.rpc, { outcome: { outcome: 'selected', optionId: choice } });
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
