import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type AgentEvent,
  type ChatFailure,
  type ChatPermissionOption,
  ChatSetEffortSchema,
  type ChatToolKind,
} from '@crewkite/contracts';
import { z } from 'zod';
import {
  type ChatAdapter,
  type ChatTurnHandle,
  type ChatTurnRequest,
  type ChatTurnResult,
  chatFailure,
  usageWarningShows,
} from '../../chat/adapter.ts';
import { ChatClientRefused } from '../../chat/clients.ts';
import { scratchPath } from '../../chat/local-tools.ts';
import {
  attachedLine,
  attachedSection,
  stripTurnNotes,
  withoutThreadToolsLine,
} from '../../chat/prompt.ts';
import { outsidePaths, scratchCommand } from '../../chat/read-only-command.ts';
import { readableType, SubagentTracker } from '../../chat/subagents.ts';
import type { ThreadToolsServer } from '../../chat/thread-tools/broker.ts';
import { turnTools } from '../../chat/thread-tools/turn.ts';
import { frameTrace } from '../../chat/trace.ts';
import { GitCeilingError, withGitCeiling } from '../../host/git-ceiling.ts';
import { defaultSchedule, groupAbsent, type Schedule } from '../../host/worker.ts';
import { fileDigestSync } from '../file-digest.ts';
import {
  type OpenAiUsageHook,
  type OpenAiUsageWindow,
  openAiUsageReporter,
  projectOpenAiUsage,
  type UsageReporter,
} from './discovery.ts';
import { type NativeLaunch, nativeDiscoveryEnvironment, StderrTail } from './native-discovery.ts';
import {
  type ApprovalRequest,
  accountReadParams,
  approvalReply,
  approvalRequest,
  type CodexFeatures,
  configReadParams,
  confirmSettings,
  type Decision,
  features,
  initializeParams,
  type LaunchSettings,
  launchArguments,
  launchSettings,
  modelListParams,
  permissionsReply,
  READ_ONLY_SANDBOX,
  READ_PROFILE,
  rateLimitsParams,
  readProfileConfig,
  refusedField,
  type ThreadSettings,
  threadResumeParams,
  threadStartParams,
  turnInterruptParams,
  turnStartParams,
} from './protocol.ts';

// One chat turn on the app-server: one owned client process, one thread opened or resumed, one
// turn. The process lives for the turn because a turn is the unit of Stop and cleanup. The thread
// persists in the client's own history, so the next turn resumes it by ID.

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

export type OpenAiChatDeps = Readonly<{
  /** The client to run. Its version, when known, names the build in a failure. */
  launch: (request: ChatTurnRequest) => NativeLaunch & { version?: string };
  onUsage?: OpenAiUsageHook;
  /** Tests replace the client with a scripted peer. */
  spawn?: Spawn;
  /** Tests run the wait after Stop by hand. */
  schedule?: Schedule;
  /** The thread tools server for this turn, with its own token. Null runs the turn without. */
  threadTools?: (request: ChatTurnRequest) => ThreadToolsServer | null;
}>;

export function openAiChatAdapter(deps: OpenAiChatDeps): ChatAdapter {
  return {
    family: 'openai',
    startTurn: (request, emit) => {
      const turn = turnTools(deps.threadTools, request, emit);
      return new OpenAiChatTurn({ ...deps, threadTools: () => turn.server }, turn.request, emit)
        .handle;
    },
  };
}

// `untrusted` brings every file change, and every command outside the client's own short list of
// read-only ones, back to CrewKite as a question. allow-edits starts there too, and serverRequest
// answers the edits that stay inside scratch. allow-all lets the client work inside its sandbox and
// asks only to leave it. The policy goes on thread/start and thread/resume, which still take
// `untrusted`. The client's config loader refuses `approval_policy = "untrusted"` at startup, and
// the app-server then exits before it answers initialize, so the launch override stays on-request
// for a turn that edits.
//
// Every read-only role (review, advice, challenge, ask, the orchestrator and a read-only slice)
// runs under `never`. The client reads and searches through shell commands, and under `untrusted`
// it asked about most of them (pwd, ls -la, rg --files), which a read-only turn could only deny,
// so the model was left with no way to read. Under `never` each command runs inside the sandbox
// without a question, and the sandbox refuses every write and every network call; a refused
// command fails in place and is never escalated. The brief keeps the model to read-only commands
// (readOnlyRules in chat/prompt.ts). serverRequest still denies a question that arrives on a
// read-only turn.
const approvalPolicy = (request: ChatTurnRequest) =>
  request.readOnly
    ? 'never'
    : request.permissionPolicy === 'allow-all'
      ? 'on-request'
      : 'untrusted';
// A read-only thread runs under the crewkite-read permission profile (ADR 0048): the platform's
// own files, the scratch copy and the turn's attached files, all read only, so a command cannot
// read a file outside them, such as the client's memory files under the home folder (H11). The
// thread/start reply names the profile and sandbox the thread got. When it does not prove the
// profile, the turn falls back to the plain read-only sandbox, which reads the whole disk. That
// turn runs under `untrusted`, so the client asks before each command an explicit rule of its own
// does not allow, and CrewKite allows only a command that provably reads inside the copy
// (scratchCommand). Either way the turn stops when a command names a path outside the copy.
const WIDE_APPROVAL_POLICY = 'untrusted';
// `other` spans every tool CrewKite cannot name, so no thread grant covers it. Only commands and
// file changes ask here today; the guard holds if another request kind starts asking.
const threadGrant = (request: ChatTurnRequest, kind: ChatToolKind, allowed: Set<ChatToolKind>) =>
  kind !== 'other' && (request.permissionGrants?.includes(kind) === true || allowed.has(kind));

/** Chat edits the scratch copy, and every question the client asks comes back to CrewKite. */
function chatLaunchSettings(directory: string, request: ChatTurnRequest): LaunchSettings {
  return launchSettings(directory, {
    approvalPolicy: request.readOnly ? 'never' : 'on-request',
    // A read-only thread gets its access from the profile in thread/start, and a sandbox mode at
    // launch would put the client back on the older sandbox settings.
    ...(request.readOnly ? {} : { sandboxMode: 'workspace-write' as const }),
    // The client's own switch for subagents. The process lives for one turn, so the crew role's
    // choice holds for exactly this turn. It stays off unless the role turned it on, since child
    // approvals rely on the client passing this turn's approval policy to each child.
    subagents: request.subagents === true,
  });
}

// Identity and storage checks copied from startTranscript and childDirectory in
// native-discovery.ts. The chat path spawns its own process, so it repeats them here.
function verifiedClient(launch: NativeLaunch) {
  if (process.platform === 'win32') throw new Error('Chat requires Unix process ownership.');
  if (!isAbsolute(launch.executable) || !/^[a-f0-9]{64}$/.test(launch.sha256))
    throw new Error('Chat requires an exact executable identity.');
  const executable = realpathSync(launch.executable);
  if (!lstatSync(executable).isFile()) throw new Error('The client must be a regular file.');
  if (fileDigestSync(executable) !== launch.sha256)
    throw new Error('The client executable identity changed.');
  return executable;
}

function privateStorage(launch: NativeLaunch) {
  if (!isAbsolute(launch.directory) || !isAbsolute(launch.repositoryRoot))
    throw new Error('Chat requires absolute storage directories.');
  const root = realpathSync(launch.repositoryRoot);
  const rootStat = lstatSync(launch.repositoryRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== process.getuid?.() ||
    (rootStat.mode & 0o022) !== 0
  )
    throw new Error('Chat storage requires an owned root without shared write access.');
  const directory = resolve(launch.directory);
  const contained = relative(root, directory);
  if (!contained || contained.startsWith('..') || isAbsolute(contained))
    throw new Error('Chat storage must stay within its root.');
  let current = root;
  for (const part of contained.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & (current === directory ? 0o077 : 0o022)) !== 0
    )
      throw new Error('Chat storage must be owned and private without symlink parents.');
  }
  const logs = join(directory, 'logs');
  try {
    mkdirSync(logs, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(logs);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Chat logs must be a contained directory.');
  return directory;
}

// AgentEvent text fields hold 64 KiB. Longer deltas go out in pieces.
const TEXT_LIMIT = 65_536;
const OUTPUT_LIMIT = 65_536;
// A completed command item repeats up to 1 MiB of retained output, and JSON escaping can write each
// byte as six. A 16 MiB line covers that. Anything longer is not a frame this client sends.
const LINE_LIMIT = 16 * 1024 * 1024;
const TRACE_LIMITS = { lines: 5000, bytes: 256 * 1024 };
const OPTIONS: ChatPermissionOption[] = [
  { id: 'allow-once', label: 'Allow once', kind: 'allow-once' },
  { id: 'allow-thread', label: 'Allow for this thread', kind: 'allow-thread' },
  { id: 'deny', label: 'Deny', kind: 'deny' },
];
// acceptForSession lasts as long as the client process, and that is one turn here, and the client
// applies it to the one command it asked about. The controller keeps the thread's grants for
// later turns, and the adapter applies an Allow for this thread to the rest of its own turn.
const DECISIONS = new Map<string, Decision>([
  ['allow-once', 'accept'],
  ['allow-thread', 'acceptForSession'],
  ['deny', 'decline'],
]);
// Thread, account and client housekeeping notices with nothing to show in a chat turn. Any other
// method goes to the turn's trace, so a client update can be diagnosed without a line in the
// thread.
const QUIET = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/settings/updated',
  'thread/name/updated',
  'thread/readState/changed',
  'thread/queue/changed',
  'turn/diff/updated',
  'turn/plan/updated',
  'serverRequest/resolved',
  'thread/compacted',
  'item/commandExecution/terminalInteraction',
  'account/updated',
  'remoteControl/status/changed',
  'skills/changed',
]);
const LIMIT_TEXT = /\busage limit/i;
// A failure here or an early exit carries what the client wrote last. The setup requests fail on
// configuration, sign-in or protocol drift, and the reason is usually on stderr.
const EVIDENCE = new Set([
  'initialize',
  'account/read',
  'thread/start',
  'thread/resume',
  'turn/start',
]);
const FRAMES = 8;
const DETAIL_LIMIT = 4096;
// The extensions the client maps to an audio type. It turns any other audio file into text.
const AUDIO = /^\.(wav|mp3|m4a|webm|ogg)$/i;
const MODEL_PAGES = 5;

type TurnFile = NonNullable<ChatTurnRequest['files']>[number];
const turnFiles = (request: ChatTurnRequest): readonly TurnFile[] => request.files ?? [];
type Media = {
  input: { type: 'localImage' | 'localAudio'; path: string };
  kind: 'image' | 'audio';
  name: string;
};

/** A regular file this process can open now. O_NONBLOCK keeps a FIFO from holding the turn. */
function readable(path: string) {
  if (!isAbsolute(path)) return false;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      return fstatSync(fd).isFile();
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

// Each schema names only the fields this file reads. Optional fields fall back on their own, so
// one renamed field never drops the rest of a frame.
const id = z.string().min(1).max(200);
const rpcId = z.union([z.number().int().safe(), id]);
const maybe = <T extends z.ZodType>(schema: T) => schema.nullish().catch(null);
const envelope = z.object({
  id: rpcId.optional(),
  method: z.string().min(1).max(200).optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const rpcError = z.object({ code: maybe(z.number().int().safe()), message: maybe(z.string()) });
const accountReply = z.object({ account: z.object({ type: z.string() }).nullable() });
const limitsReply = z.object({ ordinaryUsageAllowed: maybe(z.boolean()) });
// The reply names the policy the thread runs under. A build that leaves it out is taken at its
// word; one that names another policy than the one sent is not, since edits would then run
// without asking. The reply also names the thread's reasoning effort, which a default turn
// keeps.
// A read-only thread also names the permission profile and sandbox it got, the proof that the
// narrow read applied. A build that leaves them out gets the wide fallback.
const threadReply = z.object({
  thread: z.object({ id: z.string().min(1).max(512) }),
  approvalPolicy: z.unknown().optional(),
  reasoningEffort: ChatSetEffortSchema.optional().catch(undefined),
  activePermissionProfile: maybe(z.object({ id: z.string() })),
  sandbox: maybe(z.object({ type: z.string() })),
});
// initialize names the server's own build, which can differ from what --version printed when a
// wrapper script sits on PATH.
const serverVersion = z.object({
  userAgent: z
    .string()
    .transform((agent) => /\/(\d+\.\d+\.\d+[^\s(]*)/.exec(agent)?.[1])
    .catch(undefined),
});
const turnReply = z.object({ turn: z.object({ id }) });
const scope = z.object({ threadId: z.string() });
const itemFrame = z.object({ item: z.unknown().optional() });
const itemHead = z.object({ id, type: z.string() });
const agentItem = z.object({ text: maybe(z.string()) });
const reasoningItem = z.object({ summary: maybe(z.array(z.string())) });
const commandItem = z.object({ command: maybe(z.string()), cwd: maybe(z.string()) });
// A rename is an update with a destination. The client spells `move_path` in snake case and tags
// each change add, update or delete. A malformed entry drops the whole list, and a change with no
// paths goes to the person.
const changeItem = z.object({
  changes: maybe(
    z.array(
      z.object({
        path: z.string().min(1),
        kind: z
          .object({ type: z.string().optional(), move_path: z.string().min(1).nullish() })
          .nullish(),
      }),
    ),
  ),
});
const mcpItem = z.object({ server: maybe(z.string()), tool: maybe(z.string()) });
// config/read flattens unknown keys into the config object, mcp_servers among them. The override
// parser splits keys on dots, so a name it cannot hold safely is not read.
const mcpNames = z.object({
  config: z.object({
    mcp_servers: z
      .record(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), z.unknown())
      .optional()
      .refine((servers) => Object.keys(servers ?? {}).length <= 128),
  }),
});
const mcpStatus = z.object({ name: z.string(), status: z.string() });
const searchItem = z.object({ query: maybe(z.string()) });
// Items that carry the reply, its reasoning, the person's message or the client's bookkeeping.
// Every other item is work the model did, and one CrewKite has no reader for still gets a card.
const CONTENT_ITEMS = new Set([
  'agentMessage',
  'userMessage',
  'reasoning',
  'plan',
  'contextCompaction',
]);
// An item whose type names an agent reports subagents. Every field is read on its own, so a
// shape this file does not know still shows its card.
const AGENT_ITEM = /agent/i;
const agentStatus = z
  .object({ status: maybe(z.string()) })
  .nullish()
  .catch(null);
const agentWork = z.object({
  tool: maybe(z.string()),
  kind: maybe(z.string()),
  status: maybe(z.string()),
  model: maybe(z.string()),
  receiverThreadIds: maybe(z.array(z.string()).max(64)),
  agentThreadId: maybe(z.string()),
  newThreadId: maybe(z.string()),
  agentsStates: maybe(z.record(z.string(), agentStatus)),
});
/** A status word as a subagent state, or undefined when the word says nothing CrewKite reads. */
const agentState = (status: string | null | undefined) =>
  !status
    ? undefined
    : /error|fail/i.test(status)
      ? ('failed' as const)
      : /interrupt|cancel|abort/i.test(status)
        ? ('stopped' as const)
        : /complet|done|finish|shut|clos/i.test(status)
          ? ('done' as const)
          : /run|progress|pend|init|start|wait/i.test(status)
            ? ('running' as const)
            : undefined;
const toolEnd = z.object({
  status: maybe(z.string()),
  exitCode: maybe(z.number().int()),
  aggregatedOutput: maybe(z.string()),
});
const delta = z.object({ itemId: id, delta: z.string() });
const summaryPart = z.object({ itemId: id, summaryIndex: z.number().int() });
const tokenUsage = z.object({
  tokenUsage: z.object({
    last: z.object({ totalTokens: z.number().int().nonnegative() }),
    modelContextWindow: maybe(z.number().int().positive()),
  }),
});
// What one model request spent. Every field is read on its own.
const spent = z.object({
  tokenUsage: z.object({
    last: z.object({
      inputTokens: maybe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
      outputTokens: maybe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
    }),
  }),
});
// A subagent's items CrewKite keeps for its approvals, the same facts it keeps for the parent's.
const MAX_CHILD_ITEMS = 4096;
const notice = z.object({
  message: maybe(z.string()),
  summary: maybe(z.string()),
  details: maybe(z.string()),
});
const turnError = z.object({ message: maybe(z.string()), codexErrorInfo: z.unknown().optional() });
const modelPage = z.object({
  data: z.array(z.object({ model: z.string(), inputModalities: maybe(z.array(z.string())) })),
  nextCursor: maybe(z.string().min(1).max(512)),
});
const errorNotice = z.object({ error: maybe(turnError), willRetry: maybe(z.boolean()) });
const turnDone = z.object({
  turn: z.object({ id: maybe(id), status: maybe(z.string()), error: maybe(turnError) }),
});
const approval = z.object({
  itemId: maybe(id),
  reason: maybe(z.string()),
  command: maybe(z.string()),
  cwd: maybe(z.string()),
  grantRoot: maybe(z.string()),
  // A network access prompt names the host and protocol here and leaves out the command and cwd.
  networkApprovalContext: maybe(
    z.object({ host: z.string().min(1), protocol: maybe(z.string().min(1)) }),
  ),
});
const permissionsAsk = z.object({
  itemId: maybe(id),
  reason: maybe(z.string()),
  permissions: z.unknown().optional(),
});
const PROTOCOLS = new Map([
  ['http', 'HTTP'],
  ['https', 'HTTPS'],
  ['socks5Tcp', 'SOCKS5 TCP'],
  ['socks5Udp', 'SOCKS5 UDP'],
]);

type RpcId = z.output<typeof rpcId>;
type Reply = { result: unknown } | { error: z.output<typeof rpcError> };
type ProviderError = {
  message?: string | null;
  codexErrorInfo?: unknown;
  code?: number | null;
} | null;
type Outcome = Pick<ChatTurnResult, 'stopReason' | 'failure'>;

const clip = (value: string, limit: number) =>
  value.length > limit ? value.slice(0, limit) : value;
// A used-up plan hands the work to another provider. rateLimitExceeded is a transient 429 the
// client retries, and treating it as a used-up plan would hand off work that a retry finishes. The
// message text decides only when the client sends no code, as an RPC error reply does.
const isLimit = (error: ProviderError) => {
  const info = error?.codexErrorInfo;
  return info === 'usageLimitExceeded' || (info == null && LIMIT_TEXT.test(error?.message ?? ''));
};

class OpenAiChatTurn {
  readonly handle: ChatTurnHandle;
  // Replaced when the thread's policy narrows during the turn, so later asks follow it.
  private request: ChatTurnRequest;
  private readonly emit: (event: AgentEvent) => void;
  private readonly reportUsage: UsageReporter;
  private readonly roots: string[];
  private child: ChildProcessWithoutNullStreams | null = null;
  private group = 0;
  /** The version of the client this turn runs, when the launch or initialize named one. */
  private version: string | undefined;
  /** What this build accepts. Each request sends only fields the build knows. */
  private codex: CodexFeatures = features(null);
  /** The launch settings, which config/read confirms. */
  private settings: LaunchSettings = {};
  private get codexName() {
    return this.version ? `Codex ${this.version}` : 'Codex';
  }
  /** Requests already sent again without a field the build refused. */
  private readonly degraded = new Set<string>();
  /** True once the client answered initialize, so it accepted the settings it was started with. */
  private initialized = false;
  private nextId = 1;
  private readonly waiting = new Map<RpcId, (reply: Reply) => void>();
  private threadId: string | null = null;
  /** The controller resumes this thread on a later turn. Every other thread is ephemeral. */
  private get resumable() {
    return this.request.resumable !== false;
  }
  private readonly threadTools: ThreadToolsServer | null;
  // Thread config for the tools: our one server, and every other configured server off.
  private mcpConfig: Record<string, unknown> | null = null;
  private threadEffort: z.output<typeof threadReply>['reasoningEffort'];
  private turnId: string | null = null;
  /** The read-only turn runs on the plain read-only sandbox, which reads the whole disk. */
  private wideSandbox = false;
  // A terminal error notice. The failure is built when the turn ends, so a rate-limit update
  // that lands in between still supplies the reset time.
  private terminal: ProviderError | undefined;
  private outcome: Outcome | null = null;
  // turn/interrupt went out. The stream stays open for the client's turn/completed after that.
  private interrupting = false;
  private closing = false;
  private closed = false;
  private settled = false;
  private readonly timers: Array<() => void> = [];
  private parts: Buffer[] = [];
  private size = 0;
  private readonly texts: string[] = [];
  private readonly thinking = new Set<string>();
  // Started tool calls and the text an approval question shows for them.
  private readonly tools = new Map<string, string>();
  // The paths each started file change reported, which its approval request does not repeat.
  private readonly edits = new Map<string, Array<{ path: string; inside: boolean }>>();
  /** File change items whose patch deletes a file. Their approval carries the mark. */
  private readonly deleting = new Set<string>();
  private readonly output = new Map<string, number>();
  private readonly changed = new Set<string>();
  private readonly approvals = new Map<string, RpcId>();
  /** The tool kind each open approval asks about. */
  private readonly approvalKinds = new Map<string, ChatToolKind>();
  /** The request each open approval answers, and the access a permissions request named. */
  private readonly approvalRequests = new Map<
    string,
    { request: ApprovalRequest; requested: unknown }
  >();
  /** Kinds the person allowed for the thread during this turn. */
  private readonly allowed = new Set<ChatToolKind>();
  private readonly subagents: SubagentTracker;
  private approvalCount = 0;
  private reported = false;
  private readonly windows = new Map<string, OpenAiUsageWindow>();
  private readonly stderr = new StderrTail();
  // One line per frame in either direction: method or id and any error. Never params or results,
  // which hold the prompt and file contents.
  private readonly frames: string[] = [];
  // Files that go as localImage or localAudio, and the path lines for every other file.
  private readonly media: Media[] = [];
  private readonly lines: string[] = [];
  private readonly trace: ReturnType<typeof frameTrace>;
  private usage: ChatTurnResult['usage'] = null;
  // Tokens every model request of the turn spent, the subagents' included. Null until one reports.
  private tokensIn: number | null = null;
  private tokensOut: number | null = null;
  private childSpent = false;
  private childItems = 0;
  private readonly startedAt: number;
  private readonly finish: (result: ChatTurnResult) => void;
  private readonly schedule: Schedule;

  constructor(deps: OpenAiChatDeps, request: ChatTurnRequest, emit: (event: AgentEvent) => void) {
    this.request = request;
    this.emit = emit;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.reportUsage = openAiUsageReporter(deps.onUsage);
    this.threadTools = request.threadTools === false ? null : (deps.threadTools?.(request) ?? null);
    this.trace = frameTrace(request.now ?? Date.now, TRACE_LIMITS);
    this.subagents = new SubagentTracker(request.turnId, (event) => this.send(event));
    this.startedAt = (request.now ?? Date.now)();
    let finish: (result: ChatTurnResult) => void = () => {};
    const result = new Promise<ChatTurnResult>((resolve) => {
      finish = resolve;
    });
    this.finish = finish;
    const scratch = resolve(request.scratch.directory);
    let real = scratch;
    try {
      real = realpathSync(scratch);
    } catch {}
    this.roots = [...new Set([scratch, real])];
    const refused = this.sortFiles() ?? this.launch(deps);
    this.handle = {
      respondPermission: (requestId, choice) => this.answer(requestId, choice),
      stop: () => this.stop(),
      // The approval policy went to the client at thread start and holds for the turn. What the
      // client still asks follows the narrower policy from here.
      setPermissionPolicy: (permissionPolicy, permissionGrants) => {
        this.request = { ...this.request, permissionPolicy, permissionGrants };
        // A narrower policy, such as Ask each time again, takes back what was allowed here too.
        for (const kind of this.allowed)
          if (!permissionGrants.includes(kind)) this.allowed.delete(kind);
      },
      groups: this.group > 0 ? [this.group] : [],
      result,
    };
    if (refused) {
      // The controller gets its handle before any event, even when the client never starts.
      queueMicrotask(() => {
        this.fail(refused);
        this.settle();
      });
      return;
    }
    // Timers hold at most 2^31 - 1 ms. A longer budget would fire at once.
    this.later(Math.min(Math.max(1, request.deadlineMs), 2_147_483_647), () => {
      this.interrupt();
      this.fail(
        chatFailure({
          stage: 'stream',
          kind: 'timeout',
          message: 'The turn reached its time limit.',
        }),
      );
    });
    this.initialize();
  }

  private launch(deps: OpenAiChatDeps): ChatFailure | null {
    let step: 'client' | 'storage' | 'spawn' = 'client';
    try {
      const launch = deps.launch(this.request);
      this.version = launch.version;
      this.codex = features(launch.version);
      const executable = verifiedClient(launch);
      step = 'storage';
      const directory = privateStorage(launch);
      const env = withGitCeiling(
        nativeDiscoveryEnvironment(launch.environment),
        this.request.scratch.directory,
      );
      step = 'spawn';
      this.settings = chatLaunchSettings(directory, this.request);
      const args = launchArguments(this.settings);
      const child = (deps.spawn ?? spawn)(executable, args, {
        cwd: this.request.scratch.directory,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.group = child.pid ?? 0;
      child.stdout.on('data', (chunk: Buffer) => this.data(chunk));
      // Unread stderr would fill its pipe and stall the client. Only its tail is kept, for a
      // failure's detail.
      child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk));
      // A broken pipe also closes the child, and the close handler reports it.
      child.stdin.on('error', () => {});
      child.on('error', () => {
        this.fail(
          chatFailure({
            stage: 'launch',
            kind: 'client-missing',
            message: 'Codex could not start.',
          }),
        );
        if (this.group === 0) this.settle();
      });
      child.on('close', (code, signal) => this.exited(code, signal));
      return null;
    } catch (error) {
      if (error instanceof GitCeilingError)
        return chatFailure({ stage: 'launch', kind: 'internal', message: error.message });
      if (step === 'storage')
        return chatFailure({
          stage: 'launch',
          kind: 'internal',
          message: 'CrewKite could not prepare private storage for Codex.',
        });
      return chatFailure({
        stage: 'launch',
        kind: 'client-missing',
        message:
          error instanceof ChatClientRefused
            ? error.message
            : step === 'client'
              ? 'Codex is missing or changed since Settings checked it.'
              : 'Codex could not start.',
      });
    }
  }

  // The same metadata requests as the discovery transcript. Admission here acts only on the
  // sign-in and on whether included usage remains.
  private initialize() {
    this.call('initialize', initializeParams(), (reply) => {
      if ('error' in reply)
        return this.fail(this.providerFailure('session', 'initialize', reply.error));
      this.initialized = true;
      const served = serverVersion.safeParse(reply.result).data?.userAgent;
      if (served) {
        this.version = served;
        this.codex = features(served);
      }
      this.write({ method: 'initialized' });
      this.call('account/read', accountReadParams(), (reply) => {
        if ('error' in reply)
          return this.fail(this.providerFailure('session', 'account/read', reply.error));
        const account = accountReply.safeParse(reply.result);
        if (!account.success)
          return this.fail(
            chatFailure({
              stage: 'session',
              kind: 'protocol',
              method: 'account/read',
              message: 'Codex sent account details CrewKite could not read.',
            }),
          );
        // A subscription sign-in is the billing premise. An API key or other account would bill
        // per token, so chat does not run on one.
        if (account.data.account?.type !== 'chatgpt')
          return this.fail(
            chatFailure({
              stage: 'session',
              kind: 'signed-out',
              method: 'account/read',
              message:
                account.data.account === null
                  ? 'Codex is not signed in.'
                  : 'Codex is not signed in with a ChatGPT plan.',
            }),
          );
        this.call('account/rateLimits/read', rateLimitsParams(this.codex) ?? undefined, (reply) => {
          // Usage is advisory, so a failed read does not stop the turn.
          if ('result' in reply) {
            this.rateLimits('account/rateLimits/read', reply.result);
            if (limitsReply.safeParse(reply.result).data?.ordinaryUsageAllowed === false)
              return this.fail(
                chatFailure({
                  stage: 'session',
                  kind: 'usage-limit',
                  method: 'account/rateLimits/read',
                  message: 'The ChatGPT plan has no included Codex usage left.',
                  resetsAt: this.resetsAt(),
                }),
              );
          }
          this.readConfig();
        });
      });
    });
  }

  /**
   * One config/read after launch. It proves the settings that decide what the turn may reach,
   * since the launch no longer refuses a key the build does not know. It also names every
   * configured MCP server for the scratch copy: the thread tools go on the thread's config, which
   * merges into the person's own, so each other server goes off for this thread. A client that
   * does not answer runs the turn without the tools and with its servers as they were.
   */
  private readConfig() {
    const next = () => (this.media.length ? this.listModels(null, 1) : this.openThread());
    const tools = this.threadTools;
    this.call('config/read', configReadParams(this.request.scratch.directory), (reply) => {
      if ('error' in reply) {
        this.notice(
          'warning',
          tools
            ? 'Codex did not answer config/read, so CrewKite could not confirm its settings and this turn runs without the thread tools.'
            : 'Codex did not answer config/read, so CrewKite could not confirm its settings.',
        );
        return next();
      }
      const { missing, different } = confirmSettings(this.settings, reply.result);
      if (different.length)
        return this.fail(
          chatFailure({
            stage: 'session',
            kind: 'protocol',
            method: 'config/read',
            message: `Codex runs with ${different.map(({ key, value }) => `${key} = ${value}`).join(', ')}, and CrewKite set ${different.map(({ key }) => `${key} = ${JSON.stringify(this.settings[key])}`).join(', ')}.`,
            nextAction: 'Check the Codex configuration for a setting that overrides these.',
          }),
        );
      if (missing.length)
        this.notice(
          'warning',
          `${this.codexName} does not report ${missing.join(', ')}, so CrewKite could not confirm ${missing.length === 1 ? 'that setting' : 'those settings'}.`,
        );
      if (!tools) return next();
      const read = mcpNames.safeParse(reply.result);
      if (!read.success) {
        this.notice(
          'warning',
          'Codex did not list its MCP servers, so this turn runs without the thread tools.',
          true,
        );
        return next();
      }
      const others = Object.keys(read.data.config.mcp_servers ?? {}).filter(
        (name) => name !== tools.name,
      );
      this.mcpConfig = {
        ...Object.fromEntries(others.map((name) => [`mcp_servers.${name}.enabled`, false])),
        [`mcp_servers.${tools.name}`]: {
          command: tools.command,
          args: tools.args,
          enabled: true,
          // The tools only read, so a call never needs the person.
          default_tools_approval_mode: 'approve',
        },
      };
      next();
    });
  }

  /**
   * Sorts the files before the client starts. The client turns a local image or audio file it
   * cannot use into placeholder text and runs the turn anyway, so a file it would drop refuses
   * the turn here. The client reads localImage and localAudio paths itself, outside the sandbox.
   * A writer's sandbox reads the whole disk, and a read-only profile reads each file's folder,
   * so the model's tools can open the file a path line names in the controller home. A file from an earlier
   * message always goes as a path line in the packet and never refuses the turn.
   */
  private sortFiles(): ChatFailure | null {
    for (const { attachment, path, earlier } of turnFiles(this.request)) {
      // The packet lists an earlier file with its path.
      if (earlier) continue;
      const name = clip(attachment.name, 255);
      const rejected = (message: string) =>
        chatFailure({ stage: 'prompt', kind: 'attachment-rejected', message });
      if (!readable(path)) return rejected(`CrewKite could not read the attached file ${name}.`);
      const type = attachment.mimeType.split(';')[0].trim().toLowerCase();
      // SVG is markup the client cannot decode as an image.
      if (type.startsWith('image/') && type !== 'image/svg+xml') {
        this.media.push({ input: { type: 'localImage', path }, kind: 'image', name });
        this.lines.push(attachedLine(attachment, 'sent as an image input above'));
      } else if (type.startsWith('audio/')) {
        if (!AUDIO.test(extname(attachment.name)))
          return rejected(`Codex takes audio as wav, mp3, m4a, webm or ogg, and ${name} is none.`);
        this.media.push({ input: { type: 'localAudio', path }, kind: 'audio', name });
        this.lines.push(attachedLine(attachment, 'sent as an audio input above'));
      } else this.lines.push(attachedLine(attachment, `Path: ${path}`));
    }
    return null;
  }

  /**
   * Finds the selected model in model/list and refuses the turn before any thread opens when it
   * does not take an image or audio file the turn carries. Hidden models count, since a thread
   * may run on one.
   */
  private listModels(cursor: string | null, page: number) {
    const { model } = this.request.selection;
    this.call('model/list', modelListParams(100, true, cursor), (reply) => {
      if ('error' in reply)
        return this.fail(this.providerFailure('session', 'model/list', reply.error));
      const list = modelPage.safeParse(reply.result).data;
      const found = list?.data.find((entry) => entry.model === model);
      if (!found && list?.nextCursor && page < MODEL_PAGES)
        return this.listModels(list.nextCursor, page + 1);
      const modalities = found?.inputModalities ?? [];
      const missing = this.media.find((file) => !modalities.includes(file.kind));
      if (missing)
        return this.fail(
          chatFailure({
            stage: 'prompt',
            kind: 'attachment-rejected',
            method: 'model/list',
            message: `Codex does not report that ${clip(model, 200)} takes ${missing.kind === 'image' ? 'images' : 'audio'}, so ${missing.name} was not sent.`,
          }),
        );
      this.openThread();
    });
  }

  private openThread() {
    const { selection, scratch, session } = this.request;
    const readOnly = this.request.readOnly === true;
    // A build without permission profiles reads through the plain read-only sandbox from the
    // start. It gets the older sandbox setting on the thread and the guards on every command.
    const profile = readOnly && this.codex.readProfile;
    if (readOnly && !profile) this.widen('has no permission profiles');
    const settings: ThreadSettings = {
      model: selection.model,
      cwd: scratch.directory,
      approvalPolicy: approvalPolicy(this.request),
      ...(readOnly
        ? profile
          ? {}
          : { sandbox: 'read-only' as const }
        : { sandbox: 'workspace-write' as const }),
      // CrewKite's framing goes in as developer instructions, so the person's own message is the
      // first user input and the client titles the thread with it. The client puts these in the
      // context it rebuilds after a compaction, so a resumed thread names them again.
      ...(this.request.systemContext ? { developerInstructions: this.request.systemContext } : {}),
      ...(this.mcpConfig || profile
        ? { config: { ...this.mcpConfig, ...(profile ? readProfileConfig(this.readRoots()) : {}) } }
        : {}),
    };
    // The client saves a thread that is not ephemeral and lists it in the person's own app,
    // grouped by its folder. Only a thread CrewKite resumes later is saved.
    const start = (history: boolean) =>
      this.tolerant('thread/start', threadStartParams(settings, !this.resumable), (reply) => {
        if ('error' in reply)
          return this.fail(this.providerFailure('session', 'thread/start', reply.error));
        const thread = threadReply.safeParse(reply.result);
        if (!thread.success)
          return this.fail(
            chatFailure({
              stage: 'session',
              kind: 'protocol',
              method: 'thread/start',
              message: 'Codex started a thread without an ID.',
            }),
          );
        if (!this.policyApplied(thread.data, 'thread/start')) return;
        this.observe(thread.data, profile);
        this.threadId = thread.data.thread.id;
        this.threadEffort = thread.data.reasoningEffort;
        this.startTurn(true, history);
      });
    if (session?.family !== 'openai') return start(false);
    // The client keeps the history and CrewKite reads only the thread ID. With every turn in the
    // reply, a long thread outgrows the line limit and the resume fails, so a build that takes
    // excludeTurns gets it.
    const resume = threadResumeParams(session.sessionId, settings, this.codex);
    this.tolerant('thread/resume', resume, (reply) => {
      const thread = 'result' in reply ? threadReply.safeParse(reply.result) : null;
      if (thread?.success) {
        if (!this.policyApplied(thread.data, 'thread/resume')) return;
        this.observe(thread.data, profile);
        this.threadId = thread.data.thread.id;
        this.threadEffort = thread.data.reasoningEffort;
        return this.startTurn(false, false);
      }
      // A thread can vanish from the client's history. Starting fresh with the transcript keeps
      // the conversation going, where a failure here would repeat on every later message.
      this.notice(
        'warning',
        'Codex could not resume the earlier thread. A new thread starts with the transcript so far.',
        true,
      );
      start(true);
    });
  }

  /** What a read-only profile reads: the scratch copy as given and resolved, and each file's folder. */
  private readRoots() {
    const folders = turnFiles(this.request).map((file) => dirname(file.path));
    return [...new Set([...this.roots, ...folders])];
  }

  /**
   * A read-only thread proves the narrow read by naming the crewkite-read profile and a read-only
   * sandbox in its reply. Anything else means the build ignored or changed the profile, and the
   * turn runs on the plain read-only sandbox with every command checked. More questions, never
   * wider access.
   */
  private observe(reply: z.infer<typeof threadReply>, profile: boolean) {
    if (!profile || this.wideSandbox) return;
    if (reply.activePermissionProfile?.id === READ_PROFILE && reply.sandbox?.type === 'readOnly')
      return;
    this.widen(
      `opened the thread under ${reply.activePermissionProfile?.id ? `the ${clip(reply.activePermissionProfile.id, 60)} profile` : 'no named profile'}`,
    );
  }

  private widen(why: string) {
    this.wideSandbox = true;
    this.notice(
      'warning',
      `${this.codexName} ${why}, so this read-only turn reads through the plain read-only sandbox and CrewKite checks each command first.`,
    );
  }

  private policyApplied(reply: z.infer<typeof threadReply>, method: string): boolean {
    const wanted = approvalPolicy(this.request);
    if (reply.approvalPolicy === undefined || reply.approvalPolicy === wanted) return true;
    this.fail(
      chatFailure({
        stage: 'session',
        kind: 'protocol',
        method,
        message: `Codex opened the thread under the ${String(reply.approvalPolicy).slice(0, 40)} policy, and CrewKite asked for ${wanted}.`,
      }),
    );
    return false;
  }

  private startTurn(fresh: boolean, history: boolean) {
    const { selection } = this.request;
    // A client that did not list its servers runs this turn without the tools, so the packet
    // must not name them.
    // A new thread reads the notes in its developer instructions. When a resume failed, the prompt
    // still carries the block meant for the resumed thread, which would repeat them.
    const asked = fresh ? stripTurnNotes(this.request.prompt) : this.request.prompt;
    const prompt = this.mcpConfig ? asked : withoutThreadToolsLine(asked);
    const transcript = history
      ? this.request.history
          .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.text}`)
          .join('\n\n')
      : '';
    const lines = attachedSection(this.lines);
    const text = (fresh ? [transcript, prompt, lines] : [prompt, lines])
      .filter(Boolean)
      .join('\n\n');
    // turn/start sets the effort for this turn and the ones after it. thread/start and
    // thread/resume have no effort field, so every turn names its own and a resumed thread follows
    // the composer. Default sends none and leaves the thread's level as it is. A read-only turn
    // under the profile sends no sandbox: the thread already carries it.
    const params = turnStartParams({
      threadId: this.threadId ?? '',
      input: [...this.media.map((file) => file.input), { type: 'text', text }],
      ...(selection.effort === 'default' ? {} : { effort: selection.effort }),
      ...(this.wideSandbox
        ? { sandboxPolicy: READ_ONLY_SANDBOX, approvalPolicy: WIDE_APPROVAL_POLICY }
        : {}),
    });
    this.tolerant('turn/start', params, (reply) => {
      if ('error' in reply)
        return this.fail(this.providerFailure('prompt', 'turn/start', reply.error));
      this.turnId ??= turnReply.safeParse(reply.result).data?.turn.id ?? null;
      // The client accepted the effort. A default turn runs at the thread's own level.
      this.send({
        type: 'turn.started',
        turnId: this.request.turnId,
        family: 'openai',
        model: selection.model,
        effort:
          selection.effort === 'default' || this.degraded.has('turn/start.effort')
            ? (this.threadEffort ?? 'default')
            : selection.effort,
        role: this.request.role,
      });
    });
  }

  /** Frames matter until the turn ends, and after an interrupt until the client confirms it. */
  private get reading() {
    return !this.closing && (!this.outcome || this.interrupting);
  }

  private data(chunk: Buffer) {
    let start = 0;
    let end = chunk.indexOf(10);
    while (end >= 0 && this.reading) {
      const piece = chunk.subarray(start, end);
      start = end + 1;
      if (this.size + piece.length > LINE_LIMIT) return this.oversized();
      const line = this.parts.length ? Buffer.concat([...this.parts, piece]) : piece;
      this.parts = [];
      this.size = 0;
      this.frame(line.toString('utf8'));
      end = chunk.indexOf(10, start);
    }
    if (!this.reading || start === chunk.length) return;
    this.size += chunk.length - start;
    if (this.size > LINE_LIMIT) return this.oversized();
    this.parts.push(chunk.subarray(start));
  }

  private oversized() {
    this.fail(
      chatFailure({
        stage: 'stream',
        kind: 'protocol',
        message: 'Codex sent a message larger than 16 MiB.',
      }),
    );
  }

  private frame(text: string) {
    if (!text.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.track('received', null);
      return this.unreadable();
    }
    const message = envelope.safeParse(value);
    this.track('received', message.data ?? null);
    if (!message.success) return this.unreadable();
    const { id, method, params } = message.data;
    // After an interrupt only the client's completion matters. It closes the turn in the thread's
    // history, so the next message resumes a finished turn.
    if (this.outcome) {
      if (id === undefined && method === 'turn/completed') this.shutdown();
      return;
    }
    if (method !== undefined)
      return id === undefined
        ? this.notification(method, params)
        : this.serverRequest(id, method, params);
    if (id === undefined) return;
    const waiter = this.waiting.get(id);
    this.waiting.delete(id);
    if (message.data.error != null) {
      const error = rpcError.safeParse(message.data.error);
      waiter?.({ error: error.success ? error.data : { code: null, message: null } });
    } else waiter?.({ result: message.data.result });
  }

  private serverRequest(requestId: RpcId, method: string, params: unknown) {
    const request = approvalRequest(method);
    if (!request) {
      this.unknown(method, requestId);
      // The client may stop the turn over a refused request, so the thread says why.
      this.notice(
        'warning',
        `Codex asked a question CrewKite cannot answer (${clip(method, 200)}). The turn may stop.`,
      );
      // An unanswered request would hold the turn until its deadline.
      return this.write({
        id: requestId,
        error: { code: -32601, message: `CrewKite does not handle ${method}.` },
      });
    }
    if (request === 'permissions') return this.permissionsRequest(requestId, params);
    const kind = request === 'command' ? 'command' : 'edit';
    const value = approval.safeParse(params).data;
    const callId = value?.itemId ?? null;
    const network = kind === 'command' ? value?.networkApprovalContext : null;
    const host = network ? clip(network.host, 1024) : '';
    const protocol = network?.protocol
      ? (PROTOCOLS.get(network.protocol) ?? clip(network.protocol, 40))
      : '';
    const detail = [
      network ? `Host: ${host}${protocol ? `\nProtocol: ${protocol}` : ''}` : '',
      value?.command ?? (callId ? this.tools.get(callId) : undefined) ?? '',
      value?.reason ?? '',
      value?.grantRoot ? `Grants write access to ${value.grantRoot}.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const answerId = `approval-${++this.approvalCount}`;
    this.approvals.set(answerId, requestId);
    this.approvalKinds.set(answerId, kind);
    this.approvalRequests.set(answerId, { request, requested: null });
    // From here every automatic answer covers the scratch copy only. A change with no reported
    // paths, a path or grant root outside scratch, or a command with no cwd or a cwd outside it
    // goes to the person.
    const paths = callId ? (this.edits.get(callId) ?? []) : [];
    const grantRoot = value?.grantRoot ? this.local(value.grantRoot) : '';
    const contained =
      kind === 'edit'
        ? paths.length > 0 && paths.every((entry) => entry.inside) && grantRoot !== null
        : !!value?.cwd && this.local(value.cwd) !== null;
    // A kind the thread allowed that still reaches the person says why on the card.
    const reason =
      this.request.readOnly || !threadGrant(this.request, kind, this.allowed)
        ? null
        : network
          ? 'Asked because it needs network access.'
          : contained
            ? null
            : kind === 'command'
              ? value?.cwd
                ? 'Asked because the command runs outside the scratch copy.'
                : 'Asked because no working folder was reported.'
              : paths.length
                ? 'Asked because the change reaches outside the scratch copy.'
                : 'Asked because the change named no files.';
    this.send({
      type: 'permission.requested',
      turnId: this.request.turnId,
      requestId: answerId,
      kind,
      ...(reason ? { reason } : {}),
      callId,
      question: network
        ? `Allow network access to ${host}${protocol ? ` over ${protocol}` : ''}?`
        : kind === 'command'
          ? 'Run this command?'
          : 'Apply these file changes?',
      detail: detail ? clip(detail, 16_384) : null,
      options: OPTIONS,
      ...(kind === 'edit' && callId && this.deleting.has(callId) ? { deletes: true as const } : {}),
    });
    const policy = this.request.permissionPolicy;
    // Review and advice turns read only. On the wide sandbox a command runs only when it provably
    // reads inside the scratch copy.
    if (this.request.readOnly) {
      const call = { command: value?.command ?? '', cwd: value?.cwd ?? null };
      const inside =
        this.wideSandbox &&
        kind === 'command' &&
        !network &&
        scratchCommand(call, this.request.scratch.directory);
      return this.answer(answerId, inside ? 'allow-once' : 'deny', 'read-only');
    }
    // Network access reaches past the scratch copy, and no policy or grant covers a host, so the
    // person decides each one.
    if (network) return;
    // allow-all answers every command. Edits land only in the scratch copy, so under allow-all an
    // edit passes the same check as under allow-edits.
    if (policy === 'allow-all' && kind === 'command')
      return this.answer(answerId, 'allow-once', 'policy');
    if (!contained) return;
    if ((policy === 'allow-edits' || policy === 'allow-all') && kind === 'edit')
      return this.answer(answerId, 'allow-once', 'policy');
    // Thread grant: the person allowed this kind for the whole thread. Both events still go out,
    // and the answer names the grant, so the thread shows a line in place of a question.
    if (threadGrant(this.request, kind, this.allowed))
      this.answer(answerId, 'allow-thread', 'thread-grant');
  }

  /**
   * A command asking for access past its sandbox: more folders or the network. No policy or
   * thread grant covers that, so the person decides each one, for this turn only. A read-only turn
   * never widens.
   */
  private permissionsRequest(requestId: RpcId, params: unknown) {
    const value = permissionsAsk.safeParse(params).data;
    const answerId = `approval-${++this.approvalCount}`;
    this.approvals.set(answerId, requestId);
    this.approvalKinds.set(answerId, 'other');
    this.approvalRequests.set(answerId, {
      request: 'permissions',
      requested: value?.permissions ?? null,
    });
    const detail = [value?.reason ?? '', clip(JSON.stringify(value?.permissions ?? {}), 8192)]
      .filter(Boolean)
      .join('\n\n');
    this.send({
      type: 'permission.requested',
      turnId: this.request.turnId,
      requestId: answerId,
      callId: value?.itemId ?? null,
      question: 'Allow access outside the sandbox for this turn?',
      detail: clip(detail, 16_384),
      options: OPTIONS.filter((option) => option.kind !== 'allow-thread'),
    });
    if (this.request.readOnly) this.answer(answerId, 'deny', 'read-only');
  }

  /** `by` names an answer the adapter gave on its own. CrewKite's own answers leave it out. */
  private answer(
    requestId: string,
    choice: string,
    by?: Extract<AgentEvent, { type: 'permission.resolved' }>['answeredBy'],
  ) {
    const target = this.approvals.get(requestId);
    const decision = DECISIONS.get(choice);
    if (target === undefined || !decision || this.outcome) return;
    this.approvals.delete(requestId);
    const kind = this.approvalKinds.get(requestId);
    this.approvalKinds.delete(requestId);
    const asked = this.approvalRequests.get(requestId);
    this.approvalRequests.delete(requestId);
    // Allow for this thread covers the same kind for the rest of the turn, under the same checks
    // a thread grant gets. The client's own acceptForSession covers only the one command.
    if (choice === 'allow-thread' && kind && kind !== 'other' && !this.request.readOnly)
      this.allowed.add(kind);
    this.write({
      id: target,
      result:
        asked?.request === 'permissions'
          ? permissionsReply(decision === 'decline' ? null : asked.requested)
          : approvalReply(decision),
    });
    this.send({
      type: 'permission.resolved',
      turnId: this.request.turnId,
      requestId,
      choice,
      ...(by ? { answeredBy: by } : {}),
    });
  }

  private notification(method: string, params: unknown) {
    const thread = scope.safeParse(params);
    if (thread.success && this.threadId && thread.data.threadId !== this.threadId)
      return this.childNotification(thread.data.threadId, method, params);
    const turnId = this.request.turnId;
    switch (method) {
      case 'turn/started':
        this.turnId ??= turnReply.safeParse(params).data?.turn.id ?? null;
        return;
      case 'item/started':
        return this.started(itemFrame.safeParse(params).data?.item);
      case 'item/completed':
        return this.completed(itemFrame.safeParse(params).data?.item);
      case 'item/agentMessage/delta': {
        const value = delta.safeParse(params).data;
        if (value)
          this.pieces(value.delta, (text) =>
            this.send({ type: 'text.delta', turnId, itemId: value.itemId, text }),
          );
        return;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const value = delta.safeParse(params).data;
        if (value) this.think(value.itemId, value.delta);
        return;
      }
      case 'item/reasoning/summaryPartAdded': {
        const value = summaryPart.safeParse(params).data;
        if (value && value.summaryIndex > 0 && this.thinking.has(value.itemId))
          this.think(value.itemId, '\n\n');
        return;
      }
      case 'item/commandExecution/outputDelta': {
        const value = delta.safeParse(params).data;
        if (value) this.toolOutput(value.itemId, value.delta);
        return;
      }
      case 'thread/tokenUsage/updated': {
        this.spend(params);
        const value = tokenUsage.safeParse(params).data?.tokenUsage;
        if (!value) return;
        this.usage = {
          usedTokens: value.last.totalTokens,
          capacityTokens: value.modelContextWindow ?? null,
        };
        return this.send({ type: 'usage.context', turnId, ...this.usage });
      }
      case 'account/rateLimits/updated':
        return this.rateLimits(method, params);
      case 'warning':
      case 'deprecationNotice':
      case 'configWarning': {
        const value = notice.safeParse(params).data;
        const text = [value?.message ?? value?.summary, value?.details].filter(Boolean).join(' ');
        // A usage warning shows in the thread only when CrewKite's own reading is low or missing.
        // Every other client warning, and a usage one while the allowance is not low, goes to the
        // turn trace.
        const shown = LIMIT_TEXT.test(text) && usageWarningShows(this.request);
        if (text) this.notice('warning', text, !shown);
        return;
      }
      case 'error': {
        const value = errorNotice.safeParse(params).data;
        if (value?.willRetry) {
          this.notice('warning', value.error?.message || 'Codex is retrying the request.', true);
          return;
        }
        this.terminal ??= value?.error ?? null;
        return;
      }
      case 'turn/completed': {
        const turn = turnDone.safeParse(params).data?.turn;
        if (turn?.id && this.turnId && turn.id !== this.turnId) return;
        // Codex interrupts a turn on its own after too many denied asks, among other reasons.
        // The error it sends is the only place the reason lives.
        if (turn?.status === 'interrupted')
          return this.fail(
            chatFailure({
              stage: 'stream',
              kind: 'stopped',
              message:
                turn.error?.codexErrorInfo === 'tooManyDenials'
                  ? 'Codex interrupted the turn (too many denials).'
                  : 'Codex interrupted the turn.',
              providerMessage: turn.error?.message ? clip(turn.error.message, 16_384) : null,
            }),
          );
        if (this.terminal !== undefined || turn?.status === 'failed')
          return this.fail(
            this.providerFailure('stream', null, this.terminal ?? turn?.error ?? null),
          );
        return this.end({ stopReason: 'done', failure: null });
      }
      case 'mcpServer/startupStatus/updated': {
        const value = mcpStatus.safeParse(params).data;
        if (value?.name === this.threadTools?.name && value?.status === 'failed')
          this.notice('warning', 'The thread tools did not start for this turn.', true);
        return;
      }
      default:
        if (!QUIET.has(method)) this.unknown(method);
    }
  }

  private started(raw: unknown) {
    const head = itemHead.safeParse(raw).data;
    if (!head || this.tools.has(head.id)) return;
    let kind: ChatToolKind = 'other';
    let title: string;
    let input: Record<string, unknown>;
    let detail: string;
    if (head.type === 'commandExecution') {
      const value = commandItem.safeParse(raw).data;
      detail = value?.command?.trim() ?? '';
      kind = 'command';
      title = detail || 'Run a command';
      input = { command: detail, cwd: value?.cwd ?? null };
      // A read-only turn runs commands without a question, so one that reaches past the copy
      // ends the turn here. On the wide sandbox a command the client ran under a rule of its own
      // ends the turn too unless it provably reads inside the copy.
      const directory = this.request.scratch.directory;
      const outside = this.request.readOnly ? outsidePaths(input, directory) : [];
      const unproven = this.wideSandbox && !outside.length && !scratchCommand(input, directory);
      if (outside.length || unproven) {
        this.interrupt();
        this.fail(
          chatFailure({
            stage: 'tool',
            kind: 'internal',
            message: outside.length
              ? `The turn stopped: a read-only command named a path outside the scratch copy (${clip(outside.join(', '), 400)}).`
              : `The turn stopped: a read-only command ran that CrewKite could not confirm stays in the scratch copy (${clip(detail, 400)}).`,
            nextAction: 'Ask again. Read-only turns read only inside the scratch copy.',
          }),
        );
        return;
      }
    } else if (head.type === 'fileChange') {
      const entries = this.paths(raw);
      this.edits.set(head.id, entries);
      const paths = entries.map((entry) => entry.path);
      detail = paths.join('\n');
      kind = 'edit';
      const deletes = (changeItem.safeParse(raw).data?.changes ?? []).some(
        (change) => change.kind?.type === 'delete',
      );
      if (deletes) this.deleting.add(head.id);
      title = paths.length
        ? `${deletes ? 'Delete or edit' : 'Edit'} ${paths.join(', ')}`
        : 'Edit files';
      input = { paths };
    } else if (head.type === 'mcpToolCall') {
      const value = mcpItem.safeParse(raw).data;
      detail = [value?.server, value?.tool].filter(Boolean).join(': ');
      title = detail || 'Call a tool';
      input = { server: value?.server ?? null, tool: value?.tool ?? null };
    } else if (head.type === 'webSearch') {
      detail = searchItem.safeParse(raw).data?.query?.trim() ?? '';
      title = detail ? `Search the web for ${detail}` : 'Search the web';
      input = { query: detail || null };
    } else if (CONTENT_ITEMS.has(head.type)) return;
    else {
      const work = AGENT_ITEM.test(head.type) ? agentWork.safeParse(raw).data : undefined;
      const what = work?.tool ?? work?.kind;
      title = what
        ? `${readableType(head.type)}: ${readableType(what).toLowerCase()}`
        : readableType(head.type);
      detail = title;
      input = { type: clip(head.type, 200), ...(what ? { tool: clip(what, 200) } : {}) };
    }
    this.tools.set(head.id, detail);
    this.send({
      type: 'tool.started',
      turnId: this.request.turnId,
      callId: head.id,
      kind,
      title: clip(title, 1024),
      input,
    });
    if (AGENT_ITEM.test(head.type)) this.agentWork(head.id, raw, false);
  }

  /**
   * The subagents an agent item names: the threads it sent to, the one it reports on and every
   * thread in its state map. A subagent keeps the card that first named it, so a later wait
   * updates the call that started it. An item that names no thread counts as one subagent of its
   * own, finished when the item completes.
   */
  private agentWork(callId: string, raw: unknown, completed: boolean) {
    const work = agentWork.safeParse(raw).data;
    const states = work?.agentsStates ?? {};
    const ids = new Set(
      [
        ...(work?.receiverThreadIds ?? []),
        work?.agentThreadId,
        work?.newThreadId,
        ...Object.keys(states),
      ].filter((value): value is string => typeof value === 'string' && value !== ''),
    );
    // An item that names no thread counts as one subagent of its own while it runs, and once it
    // completes still naming none. Once real threads arrive, that stand-in goes.
    const own = ids.size === 0;
    if (own) ids.add(callId);
    else if (this.subagents.parentOf(callId) === callId) this.subagents.remove(callId);
    const item = agentState(work?.status);
    for (const id of ids) {
      const state =
        agentState(states[id]?.status) ??
        (work?.agentThreadId === id ? agentState(work?.kind) : undefined) ??
        (own && completed ? (item === 'failed' ? 'failed' : 'done') : undefined);
      this.subagents.update(callId, id, {
        ...(state ? { state } : {}),
        ...(work?.model ? { model: work.model } : {}),
      });
    }
  }

  /**
   * A notification from a subagent's own thread. Its items become the subagent's latest action
   * and its turn ending finishes it. Nothing it says reaches the reply or opens a card.
   */
  private childNotification(threadId: string, method: string, params: unknown) {
    if (!this.subagents.parentOf(threadId)) return;
    // The subagent spends the same allowance, so its requests count in the turn's tokens.
    if (method === 'thread/tokenUsage/updated') {
      if (this.spend(params)) this.childSpent = true;
      return;
    }
    if (method === 'turn/completed') {
      const status = turnDone.safeParse(params).data?.turn.status;
      return this.subagents.update(threadId, threadId, {
        state: status === 'failed' ? 'failed' : status === 'interrupted' ? 'stopped' : 'done',
      });
    }
    if (method !== 'item/started') return;
    const raw = itemFrame.safeParse(params).data?.item;
    const head = itemHead.safeParse(raw).data;
    if (!head || CONTENT_ITEMS.has(head.type)) return;
    // Its approvals name the item, so they need its command, paths and delete mark as a parent
    // item's do. The record is bounded, and an item past the bound asks with what its request says.
    if (!this.tools.has(head.id) && this.childItems < MAX_CHILD_ITEMS) {
      this.childItems += 1;
      if (head.type === 'commandExecution')
        this.tools.set(head.id, commandItem.safeParse(raw).data?.command?.trim() ?? '');
      else if (head.type === 'fileChange') {
        const entries = this.paths(raw);
        this.edits.set(head.id, entries);
        this.tools.set(head.id, entries.map((entry) => entry.path).join('\n'));
        if (
          (changeItem.safeParse(raw).data?.changes ?? []).some(
            (change) => change.kind?.type === 'delete',
          )
        )
          this.deleting.add(head.id);
      }
    }
    const action =
      head.type === 'commandExecution'
        ? commandItem.safeParse(raw).data?.command?.trim() || 'Run a command'
        : head.type === 'fileChange'
          ? `Edit ${this.paths(raw)
              .map((entry) => entry.path)
              .join(', ')}`.trim()
          : head.type === 'webSearch'
            ? 'Search the web'
            : head.type === 'mcpToolCall'
              ? [mcpItem.safeParse(raw).data?.server, mcpItem.safeParse(raw).data?.tool]
                  .filter(Boolean)
                  .join(': ') || 'Call a tool'
              : readableType(head.type);
    this.subagents.update(threadId, threadId, { state: 'running', action });
  }

  private completed(raw: unknown) {
    const head = itemHead.safeParse(raw).data;
    if (!head) return;
    const turnId = this.request.turnId;
    if (head.type === 'agentMessage') {
      const text = agentItem.safeParse(raw).data?.text ?? '';
      if (!text) return;
      this.texts.push(text);
      // shortcut: text.completed holds 64 KiB, so a longer message is cut in the event. The
      // result carries the whole text. Upgrade: a larger bound in the contract.
      return this.send({
        type: 'text.completed',
        turnId,
        itemId: head.id,
        text: clip(text, TEXT_LIMIT),
      });
    }
    if (head.type === 'reasoning') {
      if (!this.thinking.has(head.id)) {
        // Some builds send the summary only on completion. It still belongs in the thinking card.
        const summary = reasoningItem.safeParse(raw).data?.summary?.join('\n\n') ?? '';
        if (!summary) return;
        this.think(head.id, summary);
      }
      return this.send({ type: 'thinking.completed', turnId, itemId: head.id });
    }
    if (CONTENT_ITEMS.has(head.type)) return;
    this.started(raw);
    if (AGENT_ITEM.test(head.type)) this.agentWork(head.id, raw, true);
    const value = toolEnd.safeParse(raw).data;
    const status =
      value?.status === 'declined'
        ? 'denied'
        : value?.status === 'failed' || (value?.exitCode != null && value.exitCode !== 0)
          ? 'error'
          : 'ok';
    if (head.type === 'commandExecution' && !this.output.has(head.id) && value?.aggregatedOutput)
      this.toolOutput(head.id, value.aggregatedOutput);
    let summary: string | undefined;
    if (head.type === 'fileChange' && status === 'ok') {
      const paths = this.paths(raw);
      for (const entry of paths) if (entry.inside) this.changed.add(entry.path);
      summary = `Changed ${paths.length} ${paths.length === 1 ? 'file' : 'files'}.`;
    } else if (head.type === 'commandExecution' && value?.exitCode != null)
      summary = `Exit code ${value.exitCode}.`;
    this.send({
      type: 'tool.completed',
      turnId,
      callId: head.id,
      status,
      ...(summary ? { summary } : {}),
    });
  }

  /**
   * Scratch-relative paths when the change is inside scratch, as reported otherwise. A move
   * reports its destination too, so a rename out of scratch fails containment.
   */
  private paths(raw: unknown) {
    const seen = new Map<string, boolean>();
    for (const change of changeItem.safeParse(raw).data?.changes ?? [])
      for (const path of [change.path, change.kind?.move_path]) {
        if (!path) continue;
        const local = this.local(path);
        seen.set(local || path, Boolean(local));
      }
    return [...seen].map(([path, inside]) => ({ path, inside }));
  }

  /**
   * A reported path relative to scratch, '' for scratch itself, or null when it leaves the copy
   * through `..` or a link, or lands in .git, which the controller runs git in.
   */
  private local(path: string): string | null {
    const scratch = this.request.scratch.directory;
    const full = resolve(scratch, path);
    for (const root of this.roots) {
      const local = relative(root, full);
      if (local === '') return '';
      if (local.startsWith('..') || isAbsolute(local)) continue;
      try {
        return scratchPath(scratch, local).relative;
      } catch {
        return null;
      }
    }
    return null;
  }

  private think(itemId: string, text: string) {
    this.thinking.add(itemId);
    this.pieces(text, (piece) =>
      this.send({ type: 'thinking.delta', turnId: this.request.turnId, itemId, text: piece }),
    );
  }

  private pieces(text: string, send: (piece: string) => void) {
    for (let start = 0; start < text.length; start += TEXT_LIMIT)
      send(text.slice(start, start + TEXT_LIMIT));
  }

  /** Output is bounded per call. The chunk that crosses the bound is cut and marked. */
  private toolOutput(callId: string, chunk: string) {
    const used = this.output.get(callId) ?? 0;
    if (used > OUTPUT_LIMIT || !chunk) return;
    const room = OUTPUT_LIMIT - used;
    const truncated = chunk.length > room;
    this.output.set(callId, truncated ? OUTPUT_LIMIT + 1 : used + chunk.length);
    this.send({
      type: 'tool.output',
      turnId: this.request.turnId,
      callId,
      chunk: truncated ? chunk.slice(0, room) : chunk,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  private rateLimits(
    method: 'account/rateLimits/read' | 'account/rateLimits/updated',
    payload: unknown,
  ) {
    this.reportUsage(method, payload);
    try {
      for (const window of projectOpenAiUsage(method, payload).windows)
        this.windows.set(window.windowId, {
          ...window,
          resetsAt: window.resetsAt ?? this.windows.get(window.windowId)?.resetsAt ?? null,
        });
    } catch {
      // A usage shape this reader cannot project leaves the reset time unknown.
    }
  }

  /** The latest reset among exhausted windows, since all of them must reset before work resumes. */
  private resetsAt() {
    let latest: string | null = null;
    for (const window of this.windows.values())
      if (window.remaining?.value === 0 && window.resetsAt && (!latest || window.resetsAt > latest))
        latest = window.resetsAt;
    return latest;
  }

  private providerFailure(
    stage: ChatFailure['stage'],
    method: string | null,
    error: ProviderError,
  ): ChatFailure {
    const common = {
      stage,
      method,
      providerMessage: error?.message ? clip(error.message, 16_384) : null,
      code: error?.code ?? null,
    };
    if (isLimit(error))
      return chatFailure({
        ...common,
        kind: 'usage-limit',
        message: 'Codex reached a usage limit.',
        resetsAt: this.resetsAt(),
      });
    if (error?.codexErrorInfo === 'unauthorized')
      return chatFailure({ ...common, kind: 'signed-out', message: 'Codex is not signed in.' });
    // A text-only turn gets badRequest for other reasons, so only a turn that sent images or
    // audio names the files.
    if (error?.codexErrorInfo === 'badRequest' && this.media.length)
      return chatFailure({
        ...common,
        kind: 'attachment-rejected',
        message: 'Codex refused the attached files.',
      });
    return chatFailure({
      ...common,
      kind: 'protocol',
      message: method ? `Codex refused ${method}.` : 'Codex ended the turn with an error.',
    });
  }

  /** One trace line per frame CrewKite does not handle. The file appears on the first one. */
  private unknown(method: string, requestId?: RpcId) {
    this.trace.open(join(this.request.work.directory, 'trace.jsonl'));
    this.trace.write(() => ({
      method: clip(method, 200),
      ...(requestId === undefined ? {} : { id: requestId }),
    }));
  }

  /** One notice per turn for a line CrewKite could not read. The frame log keeps each one. */
  private unreadable() {
    if (this.reported) return;
    this.reported = true;
    this.notice('warning', 'Codex sent a line CrewKite could not read.');
  }

  /** `trace` marks what the client says about its own state. The view keeps it in the turn trace. */
  private notice(level: 'info' | 'warning', message: string, trace = false) {
    this.send({
      type: 'provider.notice',
      turnId: this.request.turnId,
      level,
      message: clip(message, 4096),
      ...(trace ? { trace: true as const } : {}),
    });
  }

  /**
   * A request a build may refuse over one optional field. The refusal that names a field it
   * carried sends the request again without that field, once, and the thread says so. A second
   * refusal reaches the caller with the client's own words.
   */
  private tolerant(method: string, params: Record<string, unknown>, then: (reply: Reply) => void) {
    this.call(method, params, (reply) => {
      const field = 'error' in reply ? refusedField(reply.error, method, params) : null;
      if (!field || this.degraded.has(method)) return then(reply);
      this.degraded.add(method);
      this.degraded.add(`${method}.${field}`);
      this.notice(
        'warning',
        `${this.codexName} refused a setting CrewKite sends (${method}.${field}). The turn runs without it.`,
      );
      const { [field]: _dropped, ...rest } = params;
      this.call(method, rest, then);
    });
  }

  private call(method: string, params: unknown, then: (reply: Reply) => void) {
    const requestId = this.nextId++;
    this.waiting.set(requestId, then);
    this.write({ id: requestId, method, params });
  }

  private write(value: unknown) {
    if (!this.child || this.closing || this.closed) return;
    this.track('sent', envelope.safeParse(value).data ?? null);
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  /** Keeps the last frames as single lines: direction, id, method, and any error's code and text. */
  private track(direction: 'sent' | 'received', value: z.output<typeof envelope> | null) {
    let line = `${direction} a line CrewKite could not read`;
    if (value) {
      const error =
        value.error != null
          ? rpcError.safeParse(value.error).data
          : value.method === 'error'
            ? errorNotice.safeParse(value.params).data?.error
            : null;
      const head = [
        direction,
        value.id === undefined ? '' : `#${clip(String(value.id), 40)}`,
        value.method ?? (value.error != null ? 'error' : 'result'),
      ];
      const code = error && 'code' in error && error.code != null ? ` ${error.code}` : '';
      const text = error?.message
        ? `: ${clip(error.message.replace(/\s+/g, ' ').trim(), 200)}`
        : '';
      line = `${head.filter(Boolean).join(' ')}${code}${text}`;
    }
    this.frames.push(line);
    if (this.frames.length > FRAMES) this.frames.shift();
  }

  /**
   * What the client wrote before it failed: its last stderr lines, a blank line, then the last
   * frames. The frames take what they need and stderr keeps its newest text in the rest.
   */
  private evidence(failure: ChatFailure): ChatFailure {
    const lines = this.stderr.lines();
    const frames = this.frames.join('\n');
    const said = lines.join('\n');
    const room = Math.max(0, DETAIL_LIMIT - frames.length - 2);
    const detail = [said.slice(Math.max(0, said.length - room)), frames]
      .filter(Boolean)
      .join('\n\n');
    const last = lines.at(-1);
    return {
      ...failure,
      providerMessage: failure.providerMessage ?? (last ? clip(last, 16_384) : null),
      ...(detail ? { detail: clip(detail, DETAIL_LIMIT) } : {}),
    };
  }

  private send(event: AgentEvent) {
    if (this.outcome) return;
    try {
      this.emit(event);
    } catch {
      // A failing receiver cannot reach back into the client stream.
    }
  }

  private interrupt() {
    if (this.interrupting || !this.threadId || !this.turnId) return;
    this.interrupting = true;
    this.write({
      id: this.nextId++,
      method: 'turn/interrupt',
      params: turnInterruptParams(this.threadId, this.turnId),
    });
  }

  private stop() {
    if (this.outcome) return;
    this.interrupt();
    this.fail(chatFailure({ stage: 'stream', kind: 'stopped', message: 'The turn was stopped.' }));
  }

  private fail(failure: ChatFailure) {
    if (this.outcome) return;
    const evidence = failure.kind === 'client-exit' || EVIDENCE.has(failure.method ?? '');
    this.end({
      stopReason:
        failure.kind === 'usage-limit' ? 'limit' : failure.kind === 'stopped' ? 'stopped' : 'error',
      failure: evidence ? this.evidence(failure) : failure,
    });
  }

  /** Adds one model request's tokens to the turn. True when the frame carried any. */
  private spend(params: unknown) {
    const last = spent.safeParse(params).data?.tokenUsage.last;
    if (last?.inputTokens != null) this.tokensIn = (this.tokensIn ?? 0) + last.inputTokens;
    if (last?.outputTokens != null) this.tokensOut = (this.tokensOut ?? 0) + last.outputTokens;
    return last?.inputTokens != null || last?.outputTokens != null;
  }

  private end(outcome: Outcome) {
    if (this.outcome) return;
    // A subagent the client never reported finished did not finish, whatever the turn did.
    this.subagents.close('stopped');
    // shortcut: a turn reports its tokens only when a subagent spent some, so the parent-only
    // turns keep the stats they had. The sum takes one usage frame per model request. Upgrade:
    // report the stats on every turn once a live run confirms that frame count.
    if (this.childSpent) {
      const now = (this.request.now ?? Date.now)();
      this.send({
        type: 'turn.stats',
        turnId: this.request.turnId,
        stats: {
          tokensIn: this.tokensIn,
          tokensOut: this.tokensOut,
          tokensPerSecond: null,
          firstTokenMs: null,
          turnMs: Math.max(0, Math.round(now - this.startedAt)),
          contextUsed: this.usage?.usedTokens ?? null,
          contextCapacity: this.usage?.capacityTokens ?? null,
          summaries: 0,
        },
      });
    }
    this.outcome = outcome;
    try {
      this.emit({ type: 'turn.completed', turnId: this.request.turnId, ...outcome });
    } catch {
      // The result below still carries the outcome.
    }
    // The client records an interrupted turn when it sends turn/completed. Closing its input
    // before that leaves the turn open in the thread's history. A client that never answers is
    // shut down after two seconds.
    if (this.interrupting) this.later(2000, () => this.shutdown());
    else this.shutdown();
  }

  private shutdown() {
    if (this.closing || !this.child) return;
    this.closing = true;
    // The client exits when its input closes. The signals reach anything left in the group.
    this.child.stdin.end();
    this.later(250, () => this.signal('SIGTERM'));
    this.later(1250, () => this.signal('SIGKILL'));
    // A group that outlives SIGKILL is still listed in `groups` for the controller to prove absent.
    this.later(2250, () => this.settle());
  }

  private exited(code: number | null, signal: NodeJS.Signals | null) {
    this.closed = true;
    if (this.terminal !== undefined) this.fail(this.providerFailure('stream', null, this.terminal));
    // A client that closes before it answers initialize refused its command line or its config
    // file. Its own words stay in the detail.
    this.fail(
      chatFailure({
        stage: this.threadId ? 'stream' : 'session',
        kind: 'client-exit',
        message:
          !this.initialized && !signal
            ? `${this.codexName} closed before it answered initialize, with code ${code}.`
            : signal
              ? `Codex stopped on ${signal} before the turn finished.`
              : `Codex exited with code ${code} before the turn finished.`,
      }),
    );
    if (this.group === 0 || groupAbsent(this.group)) this.settle();
    else this.signal('SIGTERM');
  }

  private signal(value: NodeJS.Signals) {
    if (this.group <= 0 || groupAbsent(this.group)) return;
    try {
      process.kill(-this.group, value);
    } catch {
      // Only an observed absent group proves that a failed signal needs no further action.
    }
  }

  private later(milliseconds: number, work: () => void) {
    this.timers.push(this.schedule(work, milliseconds));
  }

  private settle() {
    if (this.settled) return;
    this.settled = true;
    for (const cancel of this.timers.splice(0)) cancel();
    this.trace.close();
    const { selection, session } = this.request;
    const now = this.request.now ?? Date.now;
    this.finish({
      ...(this.outcome ?? {
        stopReason: 'error',
        failure: chatFailure({
          stage: 'finish',
          kind: 'internal',
          message: 'The turn ended without an outcome.',
        }),
      }),
      assistantText: this.texts.join('\n\n'),
      // An ephemeral thread is gone with the process, so there is nothing to resume.
      session:
        this.threadId && this.resumable
          ? {
              family: 'openai',
              sessionId: this.threadId,
              model: selection.model,
              updatedAt: new Date(now()).toISOString(),
            }
          : session,
      usage: this.usage,
      changedPaths: [...this.changed],
    });
  }
}
