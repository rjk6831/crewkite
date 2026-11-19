import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type AcceptanceAttempt,
  type AgentEvent,
  AgentEventSchema,
  allowanceExhausted,
  type ChatAdmission,
  type ChatAttachment,
  type ChatCatalogRead,
  ChatCatalogReadSchema,
  type ChatChangesRead,
  type ChatCheck,
  type ChatCheckRun,
  type ChatCrew,
  type ChatCrewChain,
  type ChatFailure,
  ChatFailureSchema,
  type ChatFamily,
  ChatFamilySchema,
  type ChatHandoffMode,
  type ChatInstructionsRead,
  type ChatMentionsRead,
  type ChatMessage,
  type ChatModelSelection,
  type ChatOutputLimit,
  ChatOutputLimitSchema,
  type ChatPermissionAnswer,
  type ChatPermissionOption,
  type ChatPermissionPolicy,
  type ChatQueuedMessage,
  type ChatRole,
  type ChatSearchResult,
  type ChatSession,
  ChatSessionSchema,
  type ChatStopCause,
  type ChatThread,
  type ChatThreadRead,
  ChatThreadReadSchema,
  ChatThreadSchema,
  type ChatToolKind,
  type ChatTurn,
  type ChatTurnEventsRead,
  ChatTurnEventsReadSchema,
  ChatTurnSchema,
  type Command,
  type CommandResult,
  type Connection,
  type ConversationEntry,
  ConversationEntrySchema,
  canonicalJson,
  creditsPaused,
  DEPENDENCIES_NEED_PREPARATION,
  type DependencyPreparation,
  type DesignPreview,
  type Event,
  MAX_CHAT_ENTRY_BYTES,
  MAX_CHAT_TURN_EVENTS_BYTES,
  type Project,
  rankFamilies,
  SpendSchema,
  scrubSecrets,
  suggestedSubject,
  type Task,
  TaskSchema,
  tightestAllowance,
  type WebhookEventKind,
  writesScratch,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import type { ArtifactFiles } from '../artifacts/index.ts';
import { OperationStore } from '../commands/operation-store.ts';
import type { OwnedProjectCommandRunner } from '../commands/project-command.ts';
import { deliveredDesign } from '../design/brief.ts';
import { DESIGN_CHECK_ID, designFixerBrief } from '../design/check.ts';
import {
  captureViews,
  ownedPreview,
  type PreviewHost,
  playwrightCapture,
  screenshotBrief,
} from '../design/screenshots.ts';
import {
  acceptedMessage,
  clearMerge,
  dropFetched,
  fetchBase,
  markedPaths,
  mergeOnto,
  mergeTarget,
  pendingMerge,
  refusedText,
  resolutionBrief,
  writeMerge,
} from '../github/conflicts.ts';
import type { RemoteEffects } from '../github/effects.ts';
import { PolicyRefused, policyBlocked, repositoryPolicy } from '../github/policy.ts';
import {
  type DependencyPreparer,
  detectDependencies,
  type PreparedEnvironment,
  staleReason,
} from '../host/dependencies.ts';
import {
  applyPublication,
  commitIdentity,
  type GitIdentitySource,
  preparePublication,
  refValue,
} from '../host/publication.ts';
import {
  blobToFile,
  type CandidateHash,
  git,
  type PlannedFile,
  readPlannedBlobs,
  ScratchTooLarge,
  scratchPlan,
  treeFromScratch,
} from '../host/source.ts';
import { defaultSchedule, groupAbsent, type Schedule } from '../host/worker.ts';
import { localSliceFits } from '../providers/local/budget.ts';
import { type PlanEvent, type PlanEventBody, stepTurn } from '../recipes/events.ts';
import { judge, memberReading, turnRefusal } from '../recipes/start-rule.ts';
import type { LaunchIdentity, Store } from '../store/index.ts';
import {
  attemptFolders,
  checkStatus,
  choicesDigest,
  clearAttemptFolders,
  commandsDigest,
  dropAttemptFolders,
  type Frozen,
  holdingAttempt,
  holds,
  materializeCandidate,
  mutations,
  readAcceptance,
  recoverAttempts,
  refusalWords,
  verdict,
} from './acceptance.ts';
import {
  type ChatAdapter,
  type ChatHistoryEntry,
  type ChatTurnHandle,
  type ChatTurnRequest,
  type ChatTurnResult,
  chatFailure,
  limitPolicy,
  type PolicyLimit,
} from './adapter.ts';
import type { ChangeCommandHost } from './change-commands.ts';
import * as changeCommands from './change-commands.ts';
import * as review from './change-review.ts';
import {
  type DiscardOutcome,
  deleteThreadBaseRef,
  discardScratchPath,
  listChanges,
  listingDigest,
  readDiscardMark,
  scratchChanges,
  writeDiscardMark,
  writeThreadBaseRef,
} from './changes.ts';
import {
  type ChecksOutcome,
  commandsAllowed,
  commandWords,
  enabledChecks,
  sourceDigest,
  ThreadChecks,
  testsLine,
  watchCopy,
  withRun,
} from './checks.ts';
import { connectionRefusal, routeFor, UNREPORTED } from './connections.ts';
import {
  dropStaged,
  FileRefused,
  filesFolder,
  type ImportProgress,
  placeFile,
  type StagedFile,
  stageFile,
  storedFile,
} from './files.ts';
import {
  type ChatGitHost,
  openChatPullRequest,
  pushChatBranch,
  readChatBranchStatus,
  toolRunner,
} from './git.ts';
import { searchHistory } from './history-search.ts';
import type { McpRegistry } from './mcp-servers.ts';
import { createMentionIndex, readInstructions as readInstructionFiles } from './mentions.ts';
import type { PlanInputs } from './plan.ts';
import { type PlanChecks, PlanRunner, sentMessage } from './plan-runner.ts';
import {
  adviceContext,
  askContext,
  challengeContext,
  type DeltaTurn,
  deltaPacket,
  earlierFileLine,
  earlierReach,
  familyName,
  fitWritingRules,
  fixerBrief,
  type HandoffReason,
  handoffPacket,
  handoffReason,
  notesDigest,
  orchestratorContext,
  PLAN_RETRY,
  planSummary,
  presentInstructions,
  reportChallengeContext,
  reportContext,
  resolveWritingRules,
  reviewContext,
  spokenText,
  systemContext,
  turnNotesBlock,
  turnRulesBlock,
  withAttachments,
  withNotes,
} from './prompt.ts';
import { inScratch, readOnlyCommand } from './read-only-command.ts';
import { failedByRestart, restartFailure, unconfirmedOwner } from './restart-failure.ts';
import { copyScratch } from './scratch-copy.ts';
import { chatScratchDirectory, claimScratchDirectory } from './scratch-folder.ts';
import { turnAllowsSubagents } from './subagents.ts';
import { createThreadReader, type ThreadReads } from './thread-reader.ts';
import { THREAD_TOOLS_ABSENT } from './thread-tools/turn.ts';

export type ChatServiceDeps = {
  store: Store;
  artifacts: ArtifactFiles;
  home: string;
  now: () => string;
  id: (prefix: 'msg' | 'trn') => string;
  emit: (
    type: Event['type'],
    taskId: string | null,
    revision: number,
    payload: Event['payload'],
  ) => void;
  adapters: ReadonlyMap<ChatFamily, ChatAdapter>;
  /** HOME, PATH and whatever the provider profile resolved for its client. */
  resolveEnvironment: (family: ChatFamily) => NodeJS.ProcessEnv;
  /** True when the person acknowledged the current Google terms text (ADR 0002). */
  googleTermsAcknowledged: () => boolean;
  /**
   * Read the family's usage again and wait for the reading to land in the catalog. A start at
   * reset calls it before it runs anything. Without it the catalog's last reading decides.
   */
  refreshUsage?: (family: ChatFamily) => Promise<void>;
  /** The person's default model for a family from Settings, or null. */
  familyModel?: (family: ChatFamily) => { model: string; effort?: string } | null;
  projectPath: (projectId: string) => string | undefined;
  /** The project's notes, oldest first. Every turn carries them. Absent means no notes. */
  projectNotes?: (projectId: string) => readonly string[];
  /** The person's writing rule switches. Without it every rule takes its default. */
  writingRules?: () => readonly { ruleId: string; enabled: boolean }[];
  /**
   * Check an explicit selection against the catalog, or pick the default when none is given.
   * Null means nothing usable: the service blocks the send and asks for a pick.
   */
  resolveSelection: (taskId: string, selection?: ChatModelSelection) => ChatModelSelection | null;
  /**
   * One entry per family. `connected` reports what CrewKite observed about the client or
   * connection. `models` holds observed or profile-fixed models only; empty means unknown.
   * `remaining` holds the latest observed usage windows with null for anything not observed.
   */
  catalog: (taskId?: string) => ChatCatalogRead;
  /**
   * Runs once a turn of any role has settled, so the controller can read usage the turn spent.
   * It runs outside the turn's transaction, and a throw never reaches the turn.
   */
  onTurnSettled?: (family: ChatFamily, taskId: string) => void;
  /**
   * Hears each ending the controller decides, once the state it describes is written: a question
   * for the person, a piece of work that finished, failed or stopped at a limit. `line` is the
   * thread's own line for that ending, or empty when the thread shows none. It runs a microtask
   * later, never inside a commit or a provider's callback, and a throw never reaches either.
   */
  notice?: (event: { kind: WebhookEventKind; taskId: string; line: string }) => void;
  /**
   * Hears each fact a plan thread decides, inside the transaction that writes it: a plan and how
   * it ends, each step and gate, a question for the person and its answer, an Accept, a discard
   * that leaves no change and a delete. A throw is logged once and never reaches the work.
   */
  observe?: (event: PlanEvent) => void;
  /**
   * Runs once for every turn whose adapter result came back, before the row settles and even
   * when settling fails, so what the turn was lent (its thread tools token) ends with it.
   */
  onTurnEnded?: (turnId: string) => void;
  /**
   * True when the thread tools server cannot be minted, because the socket failed to open or is
   * not open yet. A cloud turn then runs without the tools, and its packet does not name them.
   */
  threadToolsDown?: () => boolean;
  /** The person's own MCP servers, supplied by the desktop. Absent means none. */
  mcp?: McpRegistry;
  /** Process table access and timers. Tests replace them; the defaults are the real ones. */
  groupAbsent?: (group: number) => boolean;
  signalGroup?: (group: number, signal: NodeJS.Signals) => void;
  schedule?: Schedule;
  /**
   * How far the copy of an import got, outside any transaction. The controller turns it into
   * the event the attachment chip reads.
   */
  onImportProgress?: (taskId: string, progress: ImportProgress) => void;
  /** The context length of the loaded Local model, or null. A plan sends easy slices by it. */
  localContext?: () => number | null;
  /** Whether a slice's files fit a Local prompt. The default is the Local budget rule. */
  localSliceFits?: PlanInputs['localSliceFits'];
  /** The most one project check may run. The default is ten minutes. */
  checkDeadlineMs?: number;
  /** Starts each project check's process. Tests replace it; the default is the owned runner. */
  checkRunner?: OwnedProjectCommandRunner;
  /** Boot and machine digests. Each turn records them as it starts running. */
  launchIdentity?: LaunchIdentity;
  /** The projects' declared previews. Without it no screenshot check runs. */
  previews?: PreviewHost;
  /** The journal every push and pull request from the Changes tab goes through. */
  remoteEffects: RemoteEffects;
  /**
   * The dependency copy for an Accept's checks. Without it the checks run with none, as they
   * would for a project that declares no dependencies.
   */
  dependencies?: Pick<DependencyPreparer, 'prepare' | 'environment' | 'preparing'>;
  /**
   * Run the project's design check on the thread and keep its run with the thread's checks.
   * Without it, or when the project saved no design system, Accept skips it.
   */
  designCheck?: (taskId: string) => CommandResult;
};

type Payload<C extends Command['command']> = Extract<Command, { command: C }>['payload'];
type Effects = (() => void)[];

/** What a recipe run sets on a new thread, in the order the service applies it. */
export type RecipeThreadSetup = {
  crew: ChatCrew;
  flightMode: 'balanced' | 'glide';
  permissionPolicy: ChatPermissionPolicy;
  handoff: { auto: boolean; mode: ChatHandoffMode };
  /** Check commands as the recipe wrote them, each switched on or added once. */
  checks: readonly string[];
  /** The one line at the top of the thread. */
  line: string;
  /** The first message. */
  request: string;
};
type CheckAnswer = 'allow' | 'allow-thread' | 'deny' | 'stop';
/** How a screenshot pass ended. Only a captured pass gives the reviewer images. */
type ShotsEnd =
  /** The images stay staged until the result is kept, so a dropped pass leaves none behind. */
  | { status: 'captured'; text: string; staged: StagedFile[] }
  | {
      status: 'failed';
      reason: string;
      command: string;
      began: string;
      changed?: Pick<ChatCheckRun, 'changedPaths' | 'changedCount'>;
    }
  | { status: 'denied' | 'stopped' };
/**
 * The gate after a writing turn. The thread holds `held` as its chain while the gate runs, and the
 * chain goes on as `next` once the gate lets it.
 */
type Gate = { held: ChatCrewChain | null; next: ChatCrewChain };
const SHOTS_CHECK = 'design-screenshots';
const SHOTS_LABEL = 'Design screenshots';
const PREVIEW_CHANGED =
  'The preview changed files in the copy. Review the changes before running it again.';
type EntryDraft = ConversationEntry extends infer Entry
  ? Entry extends ConversationEntry
    ? Omit<Entry, 'id' | 'taskId' | 'revision' | 'cursor' | 'at'>
    : never
  : never;
type Ending = {
  state: 'done' | 'stopped' | 'failed';
  failure: ChatFailure | null;
  text: string;
  session: ChatSession | null;
  /** Stored on the turn so a reopened view knows why it ended. */
  stopReason: NonNullable<ChatTurn['stopReason']>;
  /** Process groups still present. Any entry blocks the thread until a later check finds it gone. */
  groups: readonly number[];
  /** The effort the client reported, when it differs from the one requested. */
  effort?: ChatModelSelection['effort'];
  /** The reply used its whole output budget. */
  outputLimit?: ChatOutputLimit;
  /** Why a stopped turn stopped, with the line the thread shows for it. */
  stop?: Stop;
  /**
   * The cost of a turn on an API connection. Null when the adapter never received the turn.
   * Absent keeps what the turn already holds, which is unreported until a report arrives.
   */
  spend?: ChatTurn['spend'];
};
/** Why a turn stopped, and the line the thread writes for it. The first cause asked for wins. */
type Stop = { cause: ChatStopCause; line: string };
const STOPS = {
  person: { cause: 'person', line: 'Stopped: you pressed Stop.' },
  steer: { cause: 'send-now', line: 'Stopped: Send now started the next message.' },
  restart: { cause: 'restart', line: 'Stopped: CrewKite restarted.' },
  connection: {
    cause: 'person',
    line: 'Stopped: you disconnected or forgot the connection this turn ran on.',
  },
} as const satisfies Record<string, Stop>;
/** A plan stopped for its own reason. Its own line names the reason too. */
const planStop = (why: string): Stop => ({
  cause: 'plan',
  line:
    why === 'you cancelled it'
      ? 'Stopped: the plan was cancelled.'
      : `Stopped: the plan stopped because ${why}.`,
});
type FileDiff = ReturnType<typeof scratchChanges>[number];
type Message = Pick<ChatQueuedMessage, 'text' | 'role' | 'selection' | 'attachments' | 'files'>;
type LiveTurn = {
  taskId: string;
  role: ChatTurn['role'];
  handle: ChatTurnHandle | null;
  stopRequested: boolean;
  /** Why CrewKite asked the turn to stop. Null for a turn the client stopped on its own. */
  stop: Stop | null;
  finished: boolean;
  /** Streamed text by item, kept so a stop or crash keeps what the person already saw. */
  items: Map<string, string>;
  /** Open permission requests: the options each one accepts and the tool call it is about. */
  permissions: Map<
    string,
    {
      options: readonly ChatPermissionOption[];
      callId: string | null;
      question: string;
      deletes: boolean;
    }
  >;
  /**
   * Tool kind by call ID. A thread grant covers a kind. The tool event names it, and so does an
   * ask from an adapter that knows it, since a client may ask before the tool starts.
   */
  kinds: Map<string, ChatToolKind>;
  /** Who answered an ask, kept until the adapter reports the answer, so the thread can say so. */
  answered: Map<string, ChatPermissionAnswer>;
  /** Title and input by call ID, so CrewKite can tell where an edit lands and what a command runs. */
  calls: Map<string, { title: string; input: unknown }>;
  /** The policy and grants the adapter launched with. */
  policy: ChatPermissionPolicy;
  grants: readonly ChatToolKind[];
  /**
   * What the adapter answers on its own now: its launch policy, narrowed by any change since. The
   * controller answers what the thread allows beyond it.
   */
  applied: PolicyLimit;
  /** The scratch copy the turn works in: the thread's, or its plan slice's own. */
  scratch: string;
  /** This turn started the person's MCP servers. A policy change mid-turn never answers their calls. */
  mcp: boolean;
  /** The secret values of the person's servers this turn started, scrubbed from its result. */
  secrets: readonly string[];
  /** A Google turn that carries the person's servers: no policy change answers any of its asks. */
  google: boolean;
  /** Send now stopped this turn. Its queued message starts next with the stopped turn's packet. */
  steered: boolean;
  noticed: boolean;
  /** Adapters differ on whether they announce the turn edges. The service owns both. */
  started: boolean;
  /** The effort the client reports it runs at, when it differs from the one requested. */
  effort?: ChatModelSelection['effort'];
  /** How many process groups the handle had reported when the turn row last saved them. */
  reported: number;
  /**
   * Groups seen absent during this turn. Adapters never drop a group from their list and PIDs
   * wrap, so if one of these numbers shows up again it belongs to another process.
   */
  gone: Set<number>;
  done: Promise<void>;
};

const HandoffSchema = z.strictObject({
  from: ChatFamilySchema,
  // steer: Send now stopped the last reply, so the next message carries what it left behind.
  // model: another model of the same family was picked in the composer.
  // schedule: the loop's limit for `from` held a step back before `from` received it.
  reason: z.enum(['manual', 'limit', 'schedule', 'steer', 'model']),
});
type Handoff = z.infer<typeof HandoffSchema>;

const HISTORY_LIMIT = 60;
const TURN_DEADLINE_MS = 30 * 60_000;
const OPEN_STATES = new Set<ChatTurn['state']>(['queued', 'running', 'waiting-permission']);
// One read must fit a 1 MiB frame. Messages get what live events and turns leave.
const READ_BYTES = 900 * 1024;
const LIVE_EVENT_BYTES = 192 * 1024;
const TURN_BYTES = 96 * 1024;
const CHAT_KINDS = "('user-message','chat-assistant','chat-system')";
// A handoff packet stays under 96 KiB. Patches claim up to 48 KiB and the transcript keeps at
// least 24 KiB of what is left.
const PACKET_BYTES = 96 * 1024;
const PACKET_PATCH_BYTES = 48 * 1024;
const PACKET_TRANSCRIPT_BYTES = 24 * 1024;
const PACKET_LISTED_FILES = 200;
// Files of earlier messages that travel with a packet. The packet lists each one on a line.
const EARLIER_FILES = 32;
const EARLIER_FILE_LINE_BYTES = 8 * 1024;
const PACKET_ENTRY_CHARACTERS = 8000;
const CHECK_LINES = 5;
const CHECK_CHARACTERS = 1500;
// Families whose client keeps a native session between turns. Local rebuilds each turn from the
// thread's history, so it never falls behind the thread.
const RESUMING = new Set<ChatFamily>(['openai', 'anthropic', 'google']);
// Tool calls listed per turn in a delta packet.
const DELTA_TOOL_LINES = 50;
// What the scratch copy held when a family's session last saw the thread, per changed path.
const SeenSchema = z.object({
  sequence: z.number().int(),
  files: z.record(z.string(), z.string()),
});
// The message Continue sends after a reply stopped at the output limit.
const CONTINUE_TEXT =
  'Continue the reply from where it stopped. Do not repeat what you already wrote.';
const CUT_MARKER_BYTES = 32;
// The thread record holds at most eight queued messages, in a quarter of a 1 MiB frame.
const QUEUE_LIMIT = 8;
/** How long a start at reset waits before it reads usage again when the reading could not prove a reset. */
const START_RETRY_MS = 15 * 60_000;
/** One write of a crew chain: its builder turn and how many fixes it has had. */
const chainWrite = (chain: ChatCrewChain) => `${chain.builderTurnId}:${chain.fixes}`;
// A start whose family's usage stays unreadable this long ends. Waiting longer would keep a
// stopped message armed on a provider that may be signed out for good.
const START_UNREAD_MS = 24 * 3_600_000;
const utcMinute = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
const QUEUE_BYTES = 256 * 1024;
// The crew chain: each step is an ordinary turn on the text the matching action in the thread
// sends. A review names its findings, a fixer runs on them, and two fix rounds is the most.
const CREW_REVIEW = 'Review the current changes.';
const CREW_CHALLENGE = 'Challenge the assumptions behind the last answer.';
const MAX_FIXES = 2;
const CREW_ROLES = { review: 'reviewer', fix: 'fixer', challenge: 'challenger' } as const;
type CrewStep = keyof typeof CREW_ROLES;
// The media type of the artifacts that hold large event output (commands/controller.ts).
const EVENT_OUTPUT = 'application/vnd.crewkite.event+json';
// One receipt per stored name. The same bytes under another name can carry another type.
const fileKey = (taskId: string, file: Pick<ChatAttachment, 'id' | 'name'>) =>
  `chat-file:${taskId}:${file.id}:${file.name}`;
const NOT_STORED =
  'CrewKite could not copy the file. Check the free disk space, then attach it again.';
const blocked = (reason: string, next?: string): CommandResult => ({
  outcome: 'blocked',
  reason,
  ...(next ? { next } : {}),
});
/** The command result of an admission: applied when a turn opened, the refusal otherwise. */
const admitted = (admission: ChatAdmission): CommandResult =>
  admission.outcome === 'refused'
    ? blocked(admission.reason, admission.next)
    : { outcome: 'applied' };
const discardRefusals: Record<string, string> = {
  'link-path': 'Discard leaves links the base commit does not hold, and paths under a link, alone.',
  'skipped-path': 'The scratch copy does not hold this entry, so there is nothing to discard.',
  'outside-copy': 'This path leads outside the scratch copy.',
  'path-blocked': 'Another entry in the scratch copy sits at this path. Discard that one first.',
  'not-changed': 'This file has no changes to discard.',
};
// The next command checks a held group again. A check journaled at intent never recorded a
// group, so it arrives as group 0, which has no number to name or probe. The copy still says it
// is there when named groups are held beside it.
const acceptanceRunning = () =>
  blocked(
    'acceptance-running',
    'An Accept is checking this thread. Wait for it or cancel it, then try again.',
  );
const ownershipUnknown = (groups: readonly number[]) => {
  const named = groups.filter((group) => group > 0);
  const unrecorded =
    named.length < groups.length
      ? 'A check recorded no process identity, so CrewKite cannot confirm it ended. '
      : '';
  return blocked(
    'ownership-unknown',
    named.length
      ? `${unrecorded}${unconfirmedOwner(named.length, groupNames(named))}`
      : `${unrecorded}Other threads still work. Export diagnostics from Settings, under General, before taking further action.`,
  );
};
const releaseRefusals = {
  'check-release-not-needed': 'Nothing holds this thread.',
  'check-running': 'A check is running in this thread. Stop it, then try again.',
  'check-process-recorded':
    'A check process CrewKite recorded is still running. The thread stays held until it ends.',
  'hold-not-releasable':
    'A provider process holds this thread. CrewKite checks again with each message, and the hold lifts when the process ends.',
} as const;
const RELEASED_RUN = "Released by you. CrewKite never confirmed this check's process ended.";
const processFailure = (groups: readonly number[]) =>
  chatFailure({
    stage: 'finish',
    kind: 'internal',
    message: `The provider ${groups.length === 1 ? 'process' : 'processes'} (${groupNames(groups)}) did not exit.`,
    nextAction: `CrewKite checks again before the next command. If it stays, export diagnostics before taking further action.`,
  });
const stoppedResult: ChatTurnResult = {
  stopReason: 'stopped',
  failure: null,
  assistantText: '',
  session: null,
  usage: null,
  changedPaths: [],
};

/**
 * The controller side of a chat thread. Command methods run inside the controller's
 * command transaction and push provider calls to `effects`, which run after commit.
 * Adapter callbacks and turn results write in their own transactions.
 */
export class ChatService {
  private readonly deps: ChatServiceDeps;
  private readonly live = new Map<string, LiveTurn>();
  /** The hash of the notes each open turn started with, for the session the turn leaves. */
  private readonly notesSent = new Map<string, string>();
  /** The open plan steps by turn, as their start was told, so the end can say the same. */
  private readonly steps = new Map<string, Extract<PlanEvent, { kind: 'step-started' }>>();
  private observeFailed = false;
  /** Plan slice turns stopped before their launch ran. Each starts as stopped, for this reason. */
  private readonly stoppedEarly = new Map<string, Stop>();
  /** Orchestrator plans: proposal, assignment and the slice chain (ADR 0045). */
  private readonly plans: PlanRunner;
  /** Project checks after each writing turn, a plan slice's included, and after each merge. */
  private readonly checks: ThreadChecks;
  /**
   * The chains whose newest gate left checks failing with nothing more to send to a fixer, by
   * the chain's builder turn, with the line that said so. The chain's end reads it. A restart
   * stops every chain, so nothing here needs to outlive the process.
   */
  private readonly gateFails = new Map<string, string>();
  /**
   * Turns a schedule's limit kept back before they were sent, with the line that names their
   * step. Whatever stops because of such a turn carries that line. An entry goes once the turn's
   * end has moved everything that follows it.
   */
  private readonly keptBack = new Map<string, string>();
  /** The question each thread waits on before its checks run, with what to do with the answer. */
  private readonly checkAsk = new Map<
    string,
    { requestId: string; settle: (answer: CheckAnswer, effects: Effects) => void }
  >();
  /** Threads whose preview is running or being shot. They hold the copy like a check run. */
  private readonly shots = new Map<string, { abort: AbortController; done: Promise<void> }>();
  /**
   * A one-time Allow the gate got for one write: the write, as its chain's builder turn and fix
   * count, and what the commands ran then. The preview pass of that same write runs on it, since
   * the one question showed the checks and the preview together.
   */
  private readonly allowedOnce = new Map<string, { write: string; seen: string }>();
  /**
   * What each thread's preview command ran when the person last allowed it, by task.
   * shortcut: kept in memory, so after a restart a copy whose preview script differs from the
   * project's asks once more. Upgrade: a pin for the preview in the thread's checks state.
   */
  private readonly previewPins = new Map<string, string>();
  /** Threads whose merge with a pull request's base is being fetched or checked. */
  private readonly merging = new Set<string>();
  /** Accept attempts whose checks run in this process, by attempt, with their open run. */
  private readonly accepts = new Map<string, { entry?: ReturnType<ThreadChecks['reserve']> }>();
  private closed = false;
  /** The timers of starts that wait for a window to reset, by thread. */
  private readonly startTimers = new Map<string, () => void>();
  /** Turns that belong to no thread, still running. Close stops them like a thread's turn. */
  private readonly oneTurns = new Set<{
    live: Pick<LiveTurn, 'handle' | 'gone'>;
    done: Promise<ChatTurnResult>;
  }>();
  /** The copy `importing` made, for the import command it commits next. */
  private staged:
    | { payload: Payload<'ImportChatAttachment'>; staged: StagedFile | CommandResult }
    | undefined;

  constructor(deps: ChatServiceDeps) {
    this.deps = deps;
    this.plans = new PlanRunner(this.planHost());
    this.checks = new ThreadChecks({
      store: deps.store,
      artifacts: deps.artifacts,
      home: deps.home,
      now: deps.now,
      task: (taskId) => this.task(taskId),
      thread: (taskId) => this.thread(taskId),
      update: (taskId, change) =>
        deps.store.transaction(() => {
          const task = this.task(taskId);
          if (task) this.putThread(task, change(this.thread(taskId)));
        }),
      scratchDirectory: (taskId) => this.scratchDirectory(taskId),
      projectPath: deps.projectPath,
      groupAbsent: deps.groupAbsent ?? groupAbsent,
      holdOwnership: (taskId) =>
        deps.store.transaction(() => {
          const task = this.task(taskId);
          if (task) this.putThread(task, { ...this.thread(taskId), ownershipUnknown: true });
        }),
      deadlineMs: deps.checkDeadlineMs,
      launchIdentity: deps.launchIdentity,
      schedule: deps.schedule,
      runner: deps.checkRunner,
    });
  }

  /**
   * A message sent while a turn runs, or while a process from an earlier turn may still write to
   * the scratch copy, waits in the thread. Messages that already wait go first, so a free thread
   * starts the oldest one and this one joins the end of the line.
   */
  sendMessage(payload: Payload<'SendChatMessage'>, effects: Effects): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    // A queued message is checked now too, so the person hears about a missing file at send. Each
    // file comes from what its import stored, so the type the controller detected decides how a
    // provider reads the bytes. A message may be files alone; the file section is then its body.
    const files = payload.files.flatMap((file) => {
      const stored = this.storedAttachment(task.id, file);
      return stored ? [stored.attachment] : [];
    });
    if (files.length !== payload.files.length)
      return blocked('file-not-found', 'Attach the file again, then send.');
    const message = { ...payload, files };
    const { thread, left } = this.checkedThread(task);
    const free =
      !thread.activeTurnId &&
      !left.length &&
      !this.checksBusy(task.id) &&
      !this.plans.holds(thread);
    // One running turn per family across threads. The message waits in this thread's queue and
    // starts when the other thread's turn on that family ends.
    const waiting = this.waitsOnFamily(
      task,
      thread,
      this.plans.route(thread, thread.queued[0] ?? message),
    );
    if (free && waiting) {
      const queued = this.enqueue(task, message);
      return queued.outcome === 'applied'
        ? {
            ...queued,
            next: `${familyName[waiting]} is answering in another thread. This message starts when that reply ends.`,
          }
        : queued;
    }
    // A paused queue holds its messages for Send now, so a new message starts on its own.
    if (free && (!thread.queued.length || thread.queuePaused))
      return this.begin(task, thread, this.plans.route(thread, message), effects);
    if (free) {
      // The oldest queued message goes first. One that cannot start any more, say on a family
      // that is gone, blocks the queue until it is removed, so the person hears about that one.
      const started = this.startQueued(task, effects);
      if (started.outcome !== 'applied')
        return blocked('queue-blocked', 'Remove the first queued message, then send again.');
    }
    return this.enqueue(task, message);
  }

  resolvePermission(payload: Payload<'ResolveChatPermission'>, effects: Effects): CommandResult {
    const asked = this.checkAsk.get(payload.taskId);
    if (asked?.requestId === payload.requestId) {
      if (!['allow', 'allow-thread', 'deny'].includes(payload.choice))
        return blocked(
          'permission-not-pending',
          'Choose allow once, allow for this thread or deny.',
        );
      this.dropCheckAsk(payload.taskId);
      asked.settle(payload.choice as CheckAnswer, effects);
      if (!this.asking(payload.taskId)) this.observe(payload.taskId, { kind: 'answered' });
      return { outcome: 'applied' };
    }
    const live = this.activeLive(payload.taskId, payload.turnId);
    if (!live) return blocked('no-active-turn');
    const open = live.permissions.get(payload.requestId);
    const option = open?.options.find((entry) => entry.id === payload.choice);
    if (!open || !option)
      return blocked('permission-not-pending', 'Refresh the thread and answer the open request.');
    live.permissions.delete(payload.requestId);
    live.answered.set(payload.requestId, 'person');
    // Allow for this thread covers the kind of tool the request was about, in later assistant
    // turns. A request with no known kind, or one filed under other, could be anything, so the
    // answer stays with this turn. So does one given to a reviewer or advisor, which never edits.
    const kind = live.kinds.get(open.callId ?? '');
    if (option.kind === 'allow-thread' && kind && kind !== 'other' && writesScratch(live.role))
      this.grant(payload.taskId, kind);
    effects.push(() =>
      this.call(() => live.handle?.respondPermission(payload.requestId, payload.choice)),
    );
    return { outcome: 'applied' };
  }

  stopTurn(payload: Payload<'StopChatTurn'>, effects: Effects): CommandResult {
    const live = this.activeLive(payload.taskId, payload.turnId);
    if (!live) {
      // Between a writing turn and the next step the chain may wait on the person's answer or
      // run the gate's checks. Stop ends that and leaves the queue alone; the queue starts once
      // the chain has stopped.
      const asked = this.checkAsk.get(payload.taskId);
      if (asked) {
        this.dropCheckAsk(payload.taskId);
        asked.settle('stop', effects);
      } else if (!this.checks.stop(payload.taskId) && !this.stopShots(payload.taskId))
        return blocked('no-active-turn');
      return { outcome: 'applied', data: { kind: 'chat-queue', messages: [] } };
    }
    // The turn result marks the row stopped once the provider has let go.
    this.requestStop(live, STOPS.person);
    // The queue stays and pauses: nothing in it starts by itself, and each message waits for
    // Send now or Remove. The result names the messages still waiting. A side question runs
    // beside the queue and never held it, so stopping one leaves the queue as it is.
    const task = this.task(payload.taskId);
    const thread = this.thread(payload.taskId);
    if (task && thread.queued.length && !this.beside(payload.turnId))
      this.putThread(task, { ...thread, queuePaused: true });
    effects.push(() => this.call(() => live.handle?.stop()));
    return { outcome: 'applied', data: { kind: 'chat-queue', messages: thread.queued } };
  }

  /**
   * A new policy also answers the open asks of the running turn that it covers. The answers go
   * out after commit, through `effects` when the caller passes them, otherwise on the microtask
   * after the command's synchronous transaction. Either way they read the committed thread, so a
   * rolled back command answers nothing.
   */
  configure(payload: Payload<'ConfigureChatThread'>, effects?: Effects): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const thread = this.thread(task.id);
    const selection = payload.selection
      ? this.deps.resolveSelection(task.id, payload.selection)
      : thread.selection;
    if (payload.selection && !selection)
      return blocked('selection-unavailable', 'Pick a model the provider lists.');
    if (payload.dequeue && !thread.queued.some((message) => message.id === payload.dequeue))
      return blocked('message-not-queued', 'It is no longer queued. If it started, Stop ends it.');
    let startAt = thread.startAt;
    if (payload.startAtReset === false) startAt = undefined;
    if (payload.startAtReset === true) {
      const scheduled = this.scheduleStart(task, thread);
      if ('outcome' in scheduled) return scheduled;
      startAt = scheduled;
    }
    let checks = thread.checks;
    if (payload.checks) {
      const edited = this.checks.edit(task, thread, payload.checks);
      if ('error' in edited) return blocked('checks-invalid', edited.error);
      checks = edited.state;
    }
    // A thread with no crew is manual.
    const crew = payload.crew === undefined ? thread.crew : payload.crew;
    if (!crew && payload.flightMode && payload.flightMode !== 'manual')
      return blocked('crew-missing', 'Pick a crew, then choose a flight mode.');
    const flightMode = crew ? (payload.flightMode ?? thread.flightMode) : 'manual';
    // Entering glide turns automatic handoff on, so a limit moves the step on. The person can turn
    // it off afterwards, and then glide stops on a limit like the other modes.
    const entersGlide = flightMode === 'glide' && thread.flightMode !== 'glide';
    const next: ChatThread = {
      ...withQueue(
        thread,
        thread.queued.filter((message) => message.id !== payload.dequeue),
      ),
      selection,
      permissionPolicy: payload.permissionPolicy ?? thread.permissionPolicy,
      // Choosing ask again takes back everything the thread allowed.
      ...(payload.permissionPolicy === 'ask' ? { permissionGrants: [] } : {}),
      autoHandoff: entersGlide ? true : (payload.autoHandoff ?? thread.autoHandoff),
      handoffMode: payload.handoffMode ?? thread.handoffMode,
      crew,
      flightMode,
      ...(checks ? { checks } : {}),
    };
    if (payload.startAtReset !== undefined) {
      if (startAt) next.startAt = startAt;
      else delete next.startAt;
    }
    this.putThread(task, next);
    if (payload.startAtReset !== undefined) {
      if (startAt) this.armStart(task.id, startAt.at);
      else this.cancelStart(task.id);
    }
    const running = [...this.live.values()].some((live) => live.taskId === task.id);
    if ((payload.permissionPolicy || payload.flightMode) && running) {
      const answer = () => this.applyPolicy(task.id);
      if (effects) effects.push(answer);
      else queueMicrotask(answer);
    }
    return { outcome: 'applied' };
  }

  /**
   * Set up a new thread from a recipe and send its request, inside the caller's transaction. What
   * would refuse the orchestrator's first turn refuses here, before anything is written. The line
   * that names the run is the thread's first. The copy is made next, so a check is switched on
   * against the files the run will read. The order follows what a person does by hand: the crew
   * and the flight mode, then the handoff settings (entering Glide turns automatic handoff on, so
   * they come second), then the checks the copy declares, then each recipe check by its command
   * as the thread holds it at that moment: one already on stays, one that is off is switched on,
   * and any other is added. Then the request goes in. With `matches`, the checks' approval is set
   * only when it says the copy holds what the recipe approved. The caller has checked that the
   * project has a commit and that the checks fit in one thread. A start refused or thrown after
   * the copy exists removes the copy and its ref, as a delete does, since a rollback leaves the
   * disk alone.
   */
  startRecipeThread(
    task: Task,
    setup: RecipeThreadSetup,
    effects: Effects,
    matches?: (directory: string) => boolean,
  ): CommandResult {
    const root = this.deps.projectPath(task.projectId);
    const base = this.head(task);
    if (!root || !base)
      return blocked('project-head-unavailable', 'Commit once in this project, then send again.');
    // Only the task exists so far, and the run removes it on a refusal. A credits refusal answers
    // with the line the thread would show, which names the provider, and then its next step.
    const orchestrator = setup.crew.members.find((member) => member.role === 'orchestrator');
    if (orchestrator) {
      const selection = this.pick(task, this.thread(task.id), orchestrator.selection);
      if ('outcome' in selection) return selection;
      const refused = this.refusal(task, selection, 'orchestrator', undefined);
      if (refused?.outcome === 'refused')
        return blocked(refused.reason, `${refused.message} ${refused.next}`);
    }
    this.putThread(task, { ...this.thread(task.id), base });
    this.appendEntry(task, {
      kind: 'chat-system',
      author: { kind: 'system', turnId: null },
      text: setup.line,
    });
    const refuse = (result: CommandResult) => {
      this.removeFromDisk(task);
      return result;
    };
    try {
      this.ensureScratch(task, root);
      const configure = (edit: Omit<Payload<'ConfigureChatThread'>, 'taskId'>) =>
        this.configure({ taskId: task.id, ...edit }, effects);
      const edits: Omit<Payload<'ConfigureChatThread'>, 'taskId'>[] = [
        {
          crew: setup.crew,
          flightMode: setup.flightMode,
          permissionPolicy: setup.permissionPolicy,
        },
        { autoHandoff: setup.handoff.auto, handoffMode: setup.handoff.mode },
        { checks: { refresh: true } },
      ];
      for (const edit of edits) {
        const done = configure(edit);
        if (done.outcome !== 'applied') return refuse(done);
      }
      // Two commands that read the same once normalized find the first one on and stay at one.
      for (const command of setup.checks) {
        const normalized = commandWords(command)?.join(' ');
        const found = this.thread(task.id).checks?.items.find(
          (item) => item.command === normalized,
        );
        if (found?.enabled) continue;
        const done = configure({
          checks: found ? { switch: { id: found.id, enabled: true } } : { add: command },
        });
        if (done.outcome !== 'applied') return refuse(done);
      }
      if (matches?.(this.scratchDirectory(task.id))) {
        const thread = this.thread(task.id);
        if (thread.checks)
          this.putThread(task, {
            ...thread,
            checks: { ...thread.checks, approved: this.checks.assess(task, thread).set },
          });
      }
      const sent = this.sendMessage(
        { taskId: task.id, text: setup.request, role: 'assistant', attachments: [], files: [] },
        effects,
      );
      return sent.outcome === 'applied' ? sent : refuse(sent);
    } catch (error) {
      this.removeFromDisk(task);
      throw error;
    }
  }

  /**
   * Bring every running turn of the thread to its policy and flight mode as they are now. Plan
   * slices and side turns run beside the thread's turn, so each one hears the change. The
   * adapter narrows what it answers on its own, and every open ask the thread now covers is
   * answered here. Later asks are read against the thread when they arrive.
   */
  private applyPolicy(taskId: string) {
    const thread = this.thread(taskId);
    for (const live of [...this.live.values()]) {
      if (live.taskId !== taskId || live.finished) continue;
      const applied = limitPolicy(
        { policy: live.policy, grants: live.grants },
        launchPolicy(thread, live.role),
      );
      if (
        applied.policy !== live.applied.policy ||
        applied.grants.join() !== live.applied.grants.join()
      ) {
        live.applied = applied;
        this.call(() => live.handle?.setPermissionPolicy?.(applied.policy, applied.grants));
      }
      for (const requestId of [...live.permissions.keys()]) {
        const covered = this.covered(thread, live, requestId, false);
        if (!covered) continue;
        live.permissions.delete(requestId);
        live.answered.set(requestId, covered.by);
        this.call(() => live.handle?.respondPermission(requestId, covered.choice));
      }
    }
  }

  /**
   * Record that the message a usage limit stopped runs again when the family's window resets.
   * It needs the reset time CrewKite recorded, because a guess could start a turn into the same
   * limit. The start never picks another family, so it cannot reach credits or API billing the
   * person did not allow for the turn.
   */
  private scheduleStart(
    task: Task,
    thread: ChatThread,
  ): NonNullable<ChatThread['startAt']> | CommandResult {
    if (thread.startAt) return blocked('start-scheduled', 'Cancel the start that waits first.');
    const stopped = thread.activeTurnId ? undefined : this.stoppedOnLimit(task.id);
    if (!stopped)
      return blocked('nothing-stopped', 'No message is waiting on a usage limit in this thread.');
    // The reset CrewKite reads belongs to the family's own route. A connection's limit has none.
    if (stopped.connectionId)
      return blocked(
        'assigned-connection',
        'This message ran on an assigned connection, which has no reset time CrewKite reads. Send it again when the connection can run.',
      );
    const { family, model } = stopped.selection;
    const entry = this.deps.catalog(task.id).families.find((value) => value.family === family);
    const resetsAt = entry ? tightestAllowance(entry, model).resetsAt : null;
    if (!resetsAt || Date.parse(resetsAt) <= Date.parse(this.deps.now()))
      return blocked(
        'no-reset-time',
        `CrewKite has no upcoming reset time for ${familyName[family]}. Continue on another provider or try again later.`,
      );
    return { turnId: stopped.id, family, at: resetsAt };
  }

  private cancelStart(taskId: string) {
    this.startTimers.get(taskId)?.();
    this.startTimers.delete(taskId);
  }

  /** Wake at `at`. A timer cannot hold more than 2^31 ms, so a longer wait wakes early and waits again. */
  private armStart(taskId: string, at: string) {
    this.cancelStart(taskId);
    if (this.closed) return;
    const wait = Math.min(Math.max(Date.parse(at) - Date.parse(this.deps.now()), 0), 2 ** 31 - 1);
    this.startTimers.set(
      taskId,
      (this.deps.schedule ?? defaultSchedule)(() => void this.startDue(taskId), wait),
    );
  }

  /**
   * The recorded reset time came. Read usage again and run the stopped message only when the
   * family's window reads open. A window that still reads at its limit moves the start to its new
   * reset time. A reading that cannot be had, or a thread that is busy, tries again in fifteen
   * minutes. Cancel, a new turn, a thread that moved to another family or a connection assigned
   * to the message's role on that family ends the wait.
   */
  private async startDue(taskId: string) {
    this.startTimers.delete(taskId);
    const waiting = this.thread(taskId).startAt;
    if (this.closed || !waiting) return;
    if (Date.parse(waiting.at) > Date.parse(this.deps.now()))
      return this.armStart(taskId, waiting.at);
    try {
      await this.deps.refreshUsage?.(waiting.family);
    } catch {
      // The catalog keeps its last reading, which still shows the limit, so nothing starts.
    }
    if (this.closed) return;
    const effects: Effects = [];
    const again: { at: string | null } = { at: null };
    try {
      this.deps.store.transaction(() => {
        const task = this.task(taskId);
        const { thread, left } = task ? this.checkedThread(task) : { thread: undefined, left: [] };
        const start = thread?.startAt;
        if (!task || !thread || start?.turnId !== waiting.turnId) return;
        const stopped = this.stoppedOnLimit(taskId);
        const model = stopped?.selection.model ?? null;
        if (!stopped || stopped.id !== start.turnId || thread.selection?.family !== start.family) {
          this.endStart(
            task,
            thread,
            `${familyName[start.family]} start cancelled. The thread moved on.`,
          );
          return;
        }
        // A connection assigned while the start waited would run the message on its own billing,
        // and the reset that woke this start is the family's own.
        if (this.route(taskId, stopped.role, start.family)) {
          this.endStart(
            task,
            thread,
            `${familyName[start.family]} start cancelled. This message now runs on an assigned connection, which has no reset time CrewKite reads. Send it again when the connection can run.`,
          );
          return;
        }
        const entry = this.deps
          .catalog(taskId)
          .families.find((value) => value.family === start.family);
        const reading = entry ? tightestAllowance(entry, model) : null;
        if (!entry || reading?.percent == null || allowanceExhausted(entry, model)) {
          const now = Date.parse(this.deps.now());
          const name = familyName[start.family];
          const line = (text: string) =>
            this.appendEntry(task, {
              kind: 'chat-system',
              author: { kind: 'system', turnId: null },
              text,
            });
          const reset = reading?.resetsAt;
          if (reset && Date.parse(reset) > now) {
            // A known later reset moves the wait there. The line says so only when the time moved.
            again.at = reset;
            const { unreadSince: _read, ...known } = start;
            this.putThread(task, { ...thread, startAt: { ...known, at: reset } });
            if (reset !== start.at)
              line(`${name} has not reopened. Starts again at ${utcMinute(reset)} UTC.`);
            return;
          }
          // No reading CrewKite can use. The card shows the next try, so the thread says it once.
          const since = start.unreadSince ?? this.deps.now();
          if (now - Date.parse(since) >= START_UNREAD_MS) {
            this.endStart(
              task,
              thread,
              `${name} start cancelled. CrewKite could not read ${name}'s usage for a day. Send the message again when it can run.`,
            );
            return;
          }
          const at = new Date(now + START_RETRY_MS).toISOString();
          again.at = at;
          this.putThread(task, { ...thread, startAt: { ...start, at, unreadSince: since } });
          if (!start.unreadSince)
            line(
              `${name}'s usage could not be read. CrewKite reads it again every 15 minutes, for a day at most.`,
            );
          return;
        }
        const busy =
          left.length > 0 ||
          this.checksBusy(taskId) ||
          this.plans.holds(thread) ||
          this.accepting(taskId) ||
          this.waitsOnFamily(task, thread, {});
        if (busy) {
          const at = new Date(Date.parse(this.deps.now()) + START_RETRY_MS).toISOString();
          again.at = at;
          this.putThread(task, { ...thread, startAt: { ...start, at } });
          return;
        }
        this.endStart(
          task,
          thread,
          `${familyName[start.family]} reopened. Running the stopped message again.`,
        );
        if (!this.resend(task, stopped, effects)) throw Error('The stopped message is gone.');
      });
    } catch {
      effects.length = 0;
      again.at = null;
      const task = this.task(taskId);
      if (task)
        this.deps.store.transaction(() =>
          this.endStart(
            task,
            this.thread(taskId),
            'The stopped message did not start. Send it again.',
          ),
        );
    }
    if (again.at) this.armStart(taskId, again.at);
    for (const effect of effects) this.call(effect);
  }

  private endStart(task: Task, thread: ChatThread, line: string) {
    const { startAt: _ended, ...rest } = thread;
    this.putThread(task, rest);
    this.appendEntry(task, {
      kind: 'chat-system',
      author: { kind: 'system', turnId: null },
      text: line,
    });
  }

  /**
   * Move the thread to another provider. With `reason: 'limit'` and a stopped message nobody has
   * followed up on, the new turn starts on that same message, so the thread keeps one copy of it.
   * Without `effects` the thread moves and no turn starts. `held` names the family whose schedule
   * limit held the step back. The move is from that family, and the line and the packet give the
   * schedule's limit as the reason, since that provider never received the turn.
   */
  handoff(
    payload: Payload<'HandoffChatThread'>,
    effects?: Effects,
    held?: ChatFamily,
  ): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const { thread, left } = this.checkedThread(task);
    if (thread.activeTurnId)
      return blocked('turn-running', 'Stop the reply, then switch providers.');
    if (left.length) return ownershipUnknown(left);
    if (this.accepting(task.id)) return acceptanceRunning();
    const stopped =
      effects && payload.reason === 'limit' ? this.stoppedOnLimit(task.id) : undefined;
    // The composer changes the selection on every pick, so the packet names the family of the
    // last assistant turn. A thread with no assistant turn yet moves from its selection.
    const from = held ?? this.answeredOn(task.id) ?? thread.selection?.family;
    if (!from || from === payload.selection.family)
      return blocked('handoff-needs-another-provider', 'Pick a different provider to continue on.');
    const selection = this.deps.resolveSelection(task.id, payload.selection);
    if (!selection) return blocked('selection-unavailable', 'Pick a model the provider lists.');
    if (selection.family === 'google' && !this.deps.googleTermsAcknowledged())
      return blocked(
        'google-terms-not-acknowledged',
        'Acknowledge the Google terms in Settings > Google before using Google.',
      );
    if (!this.deps.adapters.has(selection.family))
      return blocked('provider-unavailable', 'Connect this provider in Settings or pick another.');
    this.putThread(task, { ...thread, selection });
    const reason = held ? 'schedule' : payload.reason;
    this.setHandoff(task.id, { from, reason });
    if (thread.selection?.family !== selection.family)
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text: `Continued on ${familyName[selection.family]} from ${familyName[from]}. Reason: ${handoffReason(reason, from)}.`,
      });
    const resent = stopped && effects ? this.resend(task, stopped, effects) : undefined;
    return resent ? admitted(resent) : { outcome: 'applied' };
  }

  /**
   * Commit the scratch copy on the thread's base and point a new local branch at it. The
   * project's checkout, index and HEAD stay as they are (ADR 0008). The branch starts from the
   * base whatever HEAD is now, because that base is what the person reviewed. The base then
   * advances to the new commit, so a later Accept builds on this one. The commit and the branch
   * meet the project's policy, and the identity comes from the config the policy names. While a
   * merge with the pull request's base waits in the copy, Accept to the accepted branch commits
   * it there: a merge commit on the accepted commit, or under the rebase method one commit on the
   * base. Nothing is accepted while a conflict marker the merge wrote is left.
   *
   * Every Accept that builds a candidate is recorded as an attempt. With no check switched on it
   * publishes at once. Otherwise it reserves the thread, runs the checks on a copy of the frozen
   * tree and publishes later (acceptance.ts), so the result names the attempt.
   */
  accept(
    payload: Payload<'AcceptChatChanges'>,
    identity: GitIdentitySource | undefined,
    effects: Effects = [],
  ): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const { thread, left } = this.checkedThread(task);
    if (thread.activeTurnId)
      return blocked('turn-running', 'Wait for the reply or stop it, then accept.');
    // The scratch copy may still change under a process nobody owns.
    if (left.length) return ownershipUnknown(left);
    if (this.accepting(task.id)) return acceptanceRunning();
    if (this.checksInCopy(task.id)) return changeCommands.checksRunning();
    // A running plan merges its slices into the copy, so the copy Accept would freeze can move.
    if (this.plans.holds(thread))
      return blocked('thread-busy', 'Wait for the plan to finish or stop it, then accept.');
    const root = this.deps.projectPath(task.projectId);
    if (!root) return blocked('project-not-found', 'Add the project again, then accept.');
    const base = thread.base;
    if (!base || !thread.scratchReady)
      return blocked('no-changes', 'Ask for a change in this thread first.');
    const folder = join(this.deps.home, 'chat', task.id);
    const merge = pendingMerge(folder, thread);
    const onto = merge?.target === payload.branch ? merge : null;
    const ref = `refs/heads/${payload.branch}`;
    let existing: string | null;
    try {
      existing = refValue(root, ref);
    } catch {
      return blocked(
        'branch-name-unsupported',
        'Use lower case letters, digits, hyphens and slashes in the branch name.',
      );
    }
    if (onto && existing !== onto.accepted)
      return blocked(
        'branch-moved',
        `${payload.branch} moved since this thread accepted it. Accept to a new branch.`,
      );
    if (!onto && existing !== null)
      return blocked('branch-exists', 'Choose an unused branch name.');
    const scratch = this.scratchDirectory(task.id);
    let listing: ReturnType<typeof listChanges>;
    let candidates: CandidateHash[];
    let contents: Map<string, Buffer>;
    let partial: { path: string; accepted: number; hunks: number }[];
    try {
      // Every entry reaches a page of the Changes tab, so Accept publishes only listed files. With
      // the listing the tab read, it publishes exactly the list the person paged through.
      listing = listChanges(root, scratch, base);
      if (payload.listing && payload.listing !== listingDigest(base, listing))
        return blocked(
          'listing-changed',
          'The changes moved since the list was read. Review the list again, then accept.',
        );
      ({ candidates, contents, partial } = review.acceptedTree(
        root,
        scratch,
        listing,
        review.currentDecisions(this.deps.store.db, task.id, base, listing),
      ));
    } catch (error) {
      if (error instanceof ScratchTooLarge) return blocked('scratch-unreadable', error.message);
      if (/unsupported (symlink|special file|file mode)/.test((error as Error).message))
        return blocked(
          'scratch-unreadable',
          'Remove new links and special files from the scratch copy.',
        );
      return blocked(
        'scratch-unreadable',
        `The scratch copy could not be compared. ${plain(error)}`,
      );
    }
    const { plan } = listing;
    // The Changes tab count, so the system line matches what the person reviewed. A base link
    // the copy changed is listed there and comes from the base, so it is not counted.
    const fileCount = listing.files;
    if (!fileCount) return blocked('no-changes', 'Ask for a change in this thread first.');
    const marked = merge ? markedPaths(scratch, merge) : [];
    if (marked.length)
      return blocked(
        'conflicts-unresolved',
        `Resolve the conflict markers in ${marked.join(', ')}, then accept.`,
      );
    const at = this.deps.now();
    const policy = repositoryPolicy(this.deps.store, task.projectId);
    const rebase = policy.mergeMethod === 'rebase';
    // Squash and merge methods take the base in with a merge commit. Rebase puts the thread's work
    // on the base as one commit, which the accepted branch then points at.
    const parents = onto && !rebase ? [onto.accepted, base] : undefined;
    // Earlier attempts have ended, so what they left goes before this one takes its folders.
    clearAttemptFolders(this.deps.home, task.id);
    const id = `acc_${this.deps.id('msg').slice(4)}`;
    const { copy, repository } = attemptFolders(this.deps.home, task.id, id);
    const items = enabledChecks(thread);
    const listed = listingDigest(base, listing);
    let tree: string;
    try {
      tree = treeFromScratch({ repository, source: root, scratch, plan, candidates, contents });
    } catch (error) {
      rmSync(repository, { recursive: true, force: true });
      return blocked(
        'branch-not-created',
        `The branch could not be built from the scratch copy. ${plain(error)}`,
      );
    }
    const attempt: AcceptanceAttempt = {
      id,
      taskId: task.id,
      state: 'reserved',
      baseCommit: base,
      candidateTree: tree,
      commandsDigest: commandsDigest(thread, items, ''),
      choicesDigest: choicesDigest(this.deps.store.db, task.id, listed),
      preparationId: null,
      requiredChecks: items.map((item) => ({
        checkId: item.id,
        label: item.label,
        runId: null,
        status: 'pending',
      })),
      mutatedPaths: [],
      mutatedCount: 0,
      refusal: null,
      branch: payload.branch,
      commit: null,
    };
    let prepared: Frozen['prepared'];
    try {
      // The commit is built and checked against the policy now, so a refused message costs no
      // check run. Publication later writes this same commit.
      prepared = preparePublication({
        source: root,
        repository,
        base,
        tree,
        policy,
        destinationRef: ref,
        identity: commitIdentity(policy, root, identity),
        at,
        // Without a message the thread title becomes a feat subject, which the default policy
        // takes unless the title runs past its length. A rebase keeps the accepted message.
        message: payload.message?.trim()
          ? `${payload.message.trimEnd()}\n`
          : onto
            ? rebase
              ? acceptedMessage(root, onto.accepted)
              : `chore: merge ${onto.remote}/${onto.branch}\n`
            : `${suggestedSubject(task.title, policy.subjectMax)}\n`,
        parents,
      });
    } catch (error) {
      if (error instanceof PolicyRefused)
        return this.refuseAt({ ...attempt, refusal: 'policy-violation' }, repository, () =>
          policyBlocked(error.violation),
        );
      rmSync(repository, { recursive: true, force: true });
      return blocked(
        'branch-not-created',
        `The branch could not be built from the scratch copy. ${plain(error)}`,
      );
    }
    const frozen: Frozen = {
      attempt,
      root,
      ref,
      copy,
      repository,
      items,
      listed,
      seen: '',
      prepared,
      parents,
      expected: onto?.accepted,
      at,
      fileCount,
      line: `${
        !onto
          ? `Accepted ${fileCount} ${fileCount === 1 ? 'file' : 'files'} to branch ${payload.branch}.`
          : rebase
            ? `Rebased ${payload.branch} onto ${onto.remote}/${onto.branch} as one commit.`
            : `Merged ${onto.remote}/${onto.branch} into ${payload.branch}.`
      }${review.partialLine(partial)}`,
      merge: Boolean(merge),
    };
    // The design check reads the changed style files of the copy as it stands and keeps its run
    // with the thread's checks. Values that go around the system refuse before any command runs.
    const design = this.deps.designCheck?.(task.id);
    if (design && design.reason !== 'design-system-not-found') {
      const run = this.thread(task.id).checks?.runs.findLast(
        (value) => value.checkId === DESIGN_CHECK_ID,
      );
      const passed = design.outcome === 'applied' && run?.status === 'passed';
      frozen.attempt.requiredChecks.push({
        checkId: DESIGN_CHECK_ID,
        label: run?.label ?? 'Design system',
        runId: design.outcome === 'applied' ? (run?.id ?? null) : null,
        status: passed ? 'passed' : 'failed',
      });
      if (!passed) {
        const refused = { ...frozen.attempt, refusal: 'design-system-findings' as const };
        const words = refusalWords(
          refused,
          design.outcome === 'applied' ? run?.reason : design.next,
        );
        return this.refuseAt(refused, repository, () => blocked('design-system-findings', words));
      }
    }
    if (!items.length) {
      const result = this.publishAttempt(task, frozen);
      rmSync(repository, { recursive: true, force: true });
      return result;
    }
    // A link or submodule of the base goes into the tree as the base holds it, which a plain copy
    // cannot reproduce, so the checks would run on something other than what publishes.
    if (plan.kept.length) {
      const refused = { ...frozen.attempt, refusal: 'candidate-unsupported' as const };
      return this.refuseAt(refused, repository, () =>
        blocked('candidate-unsupported', refusalWords(refused)),
      );
    }
    try {
      materializeCandidate({ copy, repository, root, base, candidates });
    } catch (error) {
      dropAttemptFolders(frozen, false);
      return blocked('accept-copy-failed', `The copy for the checks was not made. ${plain(error)}`);
    }
    // Accept runs the checks, and the attempt is bound to what they run. An allow for the thread
    // covers the set the gate asks about, the declared preview included, so one allow holds at
    // the gate, the preview pass and here, and none of them overwrites the others.
    const running = this.checks.assess(task, thread, copy, items);
    frozen.seen = running.seen;
    frozen.attempt.commandsDigest = commandsDigest(thread, items, running.seen);
    const assess = () => {
      const current = this.thread(task.id);
      return this.checks.assess(task, current, copy, this.askItems(task, current));
    };
    const assessed = assess();
    // The checks start right after this transaction commits, in the same tick.
    const go = (fx: Effects, repin: boolean, approve?: string) =>
      fx.push(() => {
        if (repin) this.repin(task);
        if (approve) this.checks.approve(task.id, approve);
        this.runAttempt(frozen);
      });
    if (!this.checksNeedAsk(thread, assessed)) {
      this.putAttempt({ ...frozen.attempt, state: 'checking' });
      go(effects, false);
    } else {
      // The attempt holds the thread while the question waits. A no cancels it.
      this.putAttempt(frozen.attempt);
      this.raiseCheckAsk(
        task,
        this.thread(task.id),
        'accept',
        assessed,
        assess,
        (answer, fx, asked) => {
          if (answer === 'allow' || answer === 'allow-thread') {
            const current = this.deps.store.acceptanceAttempt(id);
            if (current?.state !== 'reserved') return;
            this.putAttempt({ ...current, state: 'checking' });
            go(fx, asked.changed.length > 0, answer === 'allow-thread' ? asked.set : undefined);
          } else
            fx.push(() => {
              this.deps.store.transaction(() => {
                const current = this.deps.store.acceptanceAttempt(id);
                if (current?.state === 'reserved')
                  this.endAttempt(
                    task,
                    { ...current, state: 'cancelled' },
                    answer === 'deny' ? 'the checks were not allowed' : 'you stopped it',
                  );
              });
              dropAttemptFolders(frozen, false);
              this.freed();
            });
        },
      );
    }
    return {
      outcome: 'applied',
      data: { kind: 'acceptance', ...readAcceptance(this.deps.store, task.id) },
      next: 'The checks run on a copy of these changes. The branch is written once they pass.',
    };
  }

  /** An attempt the thread holds now, from the store, so a restart sees the same answer. */
  accepting(taskId: string): boolean {
    return holdingAttempt(this.deps.store, taskId) !== undefined;
  }

  readAcceptance(payload: Payload<'ReadAcceptance'>): CommandResult {
    if (!this.task(payload.taskId)) return blocked('task-not-found');
    return {
      outcome: 'applied',
      data: { kind: 'acceptance', ...readAcceptance(this.deps.store, payload.taskId) },
    };
  }

  /**
   * Stop an attempt that has not started to publish. Its checks stop, nothing publishes, and the
   * folders go once the checks have let go of them.
   */
  cancelAcceptance(payload: Payload<'CancelAcceptance'>, effects: Effects = []): CommandResult {
    const attempt = this.deps.store.acceptanceAttempt(payload.attemptId);
    const task = attempt && this.task(attempt.taskId);
    if (!attempt || !task) return blocked('acceptance-not-found', 'Read the thread again.');
    if (attempt.state === 'publishing')
      return blocked(
        'acceptance-publishing',
        'The branch is being written. It cannot be stopped now.',
      );
    if (attempt.state !== 'reserved' && attempt.state !== 'checking')
      return blocked('acceptance-ended', 'This Accept has already ended.');
    // While the attempt is reserved, the only question the thread can wait on is its own.
    if (attempt.state === 'reserved') this.dropCheckAsk(task.id);
    this.endAttempt(task, { ...attempt, state: 'cancelled' }, 'you cancelled it');
    const running = this.accepts.get(attempt.id);
    if (running?.entry) {
      running.entry.stopped = true;
      running.entry.stop();
    }
    if (!running) dropAttemptFolders(attemptFolders(this.deps.home, task.id, attempt.id), false);
    effects.push(() => this.freed());
    return {
      outcome: 'applied',
      data: { kind: 'acceptance', ...readAcceptance(this.deps.store, task.id) },
    };
  }

  private putAttempt(attempt: AcceptanceAttempt) {
    this.deps.store.putAcceptanceAttempt(attempt, this.deps.now());
  }

  /**
   * Settle an attempt and tell the thread's viewers. A refusal or a stop gets a thread line, and
   * publication writes its own.
   */
  private endAttempt(task: Task, attempt: AcceptanceAttempt, why?: string | null) {
    this.putAttempt(attempt);
    const text =
      attempt.state === 'refused'
        ? `Accept to ${attempt.branch} stopped. ${refusalWords(attempt, why)}`
        : attempt.state === 'cancelled'
          ? `Accept to ${attempt.branch} stopped: ${why ?? 'it was cancelled'}. Nothing was published.`
          : null;
    if (text)
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text: fitText(text, 16_384),
      });
    this.putThread(task, this.thread(task.id));
  }

  /** A refusal decided while Accept still runs as a command. The command result says it. */
  private refuseAt(
    attempt: AcceptanceAttempt,
    repository: string,
    result: () => CommandResult,
  ): CommandResult {
    this.putAttempt({ ...attempt, state: 'refused' });
    rmSync(repository, { recursive: true, force: true });
    return result();
  }

  /**
   * Start an attempt's checks outside any transaction. Close stops its run like any other check
   * run and does not wait for it.
   */
  private runAttempt(frozen: Frozen) {
    const running: { entry?: ReturnType<ThreadChecks['reserve']> } = {};
    this.accepts.set(frozen.attempt.id, running);
    void this.checkAttempt(frozen, running)
      .catch(() => {
        // Whatever failed, the attempt must not hold the thread until a restart. It reads unknown
        // and nothing replays it.
        if (this.closed) return;
        try {
          this.deps.store.transaction(() => {
            const attempt = this.deps.store.acceptanceAttempt(frozen.attempt.id);
            const task = attempt && this.task(attempt.taskId);
            if (task && holds(attempt)) this.endAttempt(task, { ...attempt, state: 'unknown' });
          });
        } catch {
          // A restart reads it as unknown.
        }
      })
      .finally(() => {
        this.accepts.delete(frozen.attempt.id);
        this.freed();
      });
  }

  /** The thread an attempt held is free again, so a message queued meanwhile can start. */
  private freed() {
    if (!this.closed) this.wakeQueues();
  }

  /**
   * Prepare the copy's dependencies, run the checks in it, then publish when every check passed
   * on the unchanged copy and nothing the attempt froze has moved. A closed service stops here
   * and leaves the attempt for startup to settle.
   */
  private async checkAttempt(
    frozen: Frozen,
    running: { entry?: ReturnType<ThreadChecks['reserve']> },
  ): Promise<void> {
    const { taskId, id } = frozen.attempt;
    const still = () => {
      const attempt = this.deps.store.acceptanceAttempt(id);
      return !this.closed && attempt?.state === 'checking' ? attempt : undefined;
    };
    const dependencies = this.deps.dependencies;
    let preparedAt: string | null = null;
    if (dependencies) {
      // A project that declares no dependencies needs no copy, so it is prepared only when the
      // environment asks for one. The environment then names why a copy is not usable, with the
      // line the person reads.
      let ready = dependencies.environment(taskId, 'acceptance', id);
      let record: DependencyPreparation | null = null;
      if (!ready.ok) {
        const prepared = await dependencies.prepare(taskId, 'acceptance', id);
        if (this.closed) return;
        record = prepared && prepared !== 'busy' ? prepared : null;
        if (record) ready = dependencies.environment(taskId, 'acceptance', id);
      }
      const ended = this.deps.store.transaction(() => {
        const attempt = still();
        const task = this.task(taskId);
        if (!attempt || !task) return true;
        if (ready.ok) {
          if (record) {
            this.putAttempt({ ...attempt, preparationId: record.id });
            preparedAt = record.preparedAt;
          }
          return false;
        }
        this.endAttempt(
          task,
          {
            ...attempt,
            state: 'refused',
            refusal:
              ready.reason.startsWith('stale-') ||
              ready.reason === 'not-installed' ||
              ready.reason === 'not-prepared'
                ? 'preparation-stale'
                : 'preparation-unsupported',
          },
          ready.message,
        );
        return true;
      });
      if (ended) return dropAttemptFolders(frozen, false);
    }
    if (!still()) return dropAttemptFolders(frozen, false);
    const entry = this.checks.reserve(taskId, true, true);
    entry.saw = (run) => {
      const attempt = still();
      if (attempt)
        this.putAttempt({
          ...attempt,
          requiredChecks: attempt.requiredChecks.map((check) =>
            check.checkId === run.checkId && check.checkId !== DESIGN_CHECK_ID
              ? { ...check, runId: run.id, status: checkStatus(run) }
              : check,
          ),
        });
    };
    running.entry = entry;
    const outcome = await this.checks.run(taskId, 'accept', frozen.copy, entry, frozen.items);
    if (this.closed) return;
    // The environment marks a moved preparation stale in a transaction of its own, so it is read
    // before the verdict opens one.
    const prepared = this.preparationHolds(this.deps.store.acceptanceAttempt(id), preparedAt);
    let publish = false;
    let keepCopy = false;
    this.deps.store.transaction(() => {
      const attempt = still();
      const task = this.task(taskId);
      if (!attempt || !task) return;
      const refusal = verdict(attempt.requiredChecks);
      if (refusal) {
        keepCopy = refusal === 'check-mutated';
        return this.endAttempt(task, {
          ...attempt,
          state: 'refused',
          refusal,
          ...mutations(outcome.runs),
        });
      }
      if (this.thread(taskId).ownershipUnknown)
        return this.endAttempt(task, { ...attempt, state: 'refused', refusal: 'process-unknown' });
      if (this.choiceChanged(task, frozen, attempt, prepared))
        return this.endAttempt(task, { ...attempt, state: 'refused', refusal: 'choice-changed' });
      this.putAttempt({ ...attempt, state: 'publishing' });
      publish = true;
    });
    if (publish)
      this.deps.store.transaction(() => {
        const task = this.task(taskId);
        if (task) this.publishAttempt(task, frozen);
      });
    dropAttemptFolders(frozen, keepCopy);
  }

  /**
   * Whether what the attempt froze has moved: a hunk decision, the required checks, what they run
   * or the permissions they run under, or the dependency copy they ran with (`prepared`).
   */
  private choiceChanged(
    task: Task,
    frozen: Frozen,
    attempt: AcceptanceAttempt,
    prepared: boolean,
  ): boolean {
    const thread = this.thread(task.id);
    if (commandsDigest(thread, enabledChecks(thread), frozen.seen) !== attempt.commandsDigest)
      return true;
    if (choicesDigest(this.deps.store.db, task.id, frozen.listed) !== attempt.choicesDigest)
      return true;
    return !prepared;
  }

  /**
   * Whether the dependency copy an attempt's checks ran with is still the one prepared for it. A
   * copy prepared again keeps its record ID, so the time it was prepared tells the two apart.
   * An attempt with no copy holds. Outside any transaction: the environment may mark it stale.
   */
  private preparationHolds(
    attempt: AcceptanceAttempt | undefined,
    preparedAt: string | null,
  ): boolean {
    if (!attempt?.preparationId || !this.deps.dependencies) return true;
    const ready = this.deps.dependencies.environment(attempt.taskId, 'acceptance', attempt.id);
    const record = this.deps.store
      .dependencyPreparations(attempt.taskId)
      .find((value) => value.scope === 'acceptance' && value.scopeKey === attempt.id);
    return ready.ok && record?.id === attempt.preparationId && record.preparedAt === preparedAt;
  }

  /**
   * Write the frozen commit to the branch with compare-and-create, then move the thread on. Runs
   * in a transaction. A refusal names the branch that moved. Any other failure leaves the attempt
   * unknown, since the branch cannot be read as proof either way.
   */
  private publishAttempt(task: Task, frozen: Frozen): CommandResult {
    const { root, prepared } = frozen;
    // The row carries what the checks wrote. Accept with no check publishes before it has a row.
    const attempt = this.deps.store.acceptanceAttempt(frozen.attempt.id) ?? frozen.attempt;
    try {
      applyPublication({
        source: root,
        pack: prepared.pack,
        destinationRef: frozen.ref,
        treeOid: prepared.treeOid,
        commitOid: prepared.commitOid,
        base: attempt.baseCommit,
        parents: frozen.parents,
        expected: frozen.expected,
      });
    } catch (error) {
      const conflict = /already exists|moved since/.test((error as Error).message);
      this.endAttempt(
        task,
        conflict
          ? { ...attempt, state: 'refused', refusal: 'publish-conflict' }
          : { ...attempt, state: 'unknown' },
      );
      return blocked(
        'branch-not-created',
        conflict
          ? 'Choose another branch name and accept again.'
          : `The branch could not be added to the repository. ${plain(error)}`,
      );
    }
    const commit = prepared.commitOid;
    const base = attempt.baseCommit;
    this.putAttempt({ ...attempt, state: 'published', commit });
    // The new tree is the copy's files plus the base entries it left out, so the copy matches
    // the new base and Changes starts empty, apart from the hunks Accept left in the copy.
    this.pinBase(task, root, commit);
    review.clearDecisions(this.deps.store.db, task.id);
    if (frozen.merge) clearMerge(join(this.deps.home, 'chat', task.id));
    // Any Accept ends a waiting merge: it commits the merge, or it starts a branch without it.
    const { pendingMerge: _merged, ...rest } = this.thread(task.id);
    this.putThread(task, {
      ...rest,
      base: commit,
      lastAcceptance: {
        branch: attempt.branch,
        at: frozen.at,
        fileCount: frozen.fileCount,
        commit,
      },
    });
    const note =
      frozen.expected || this.head(task) === base
        ? null
        : `The branch starts at this thread's base commit ${base.slice(0, 7)}. HEAD stays where it is.`;
    this.appendEntry(task, {
      kind: 'chat-system',
      author: { kind: 'system', turnId: null },
      text: `${frozen.line}${note ? ` ${note}` : ''}`,
    });
    this.observe(task.id, { kind: 'accepted' });
    return {
      outcome: 'applied',
      data: {
        kind: 'chat-acceptance',
        branch: attempt.branch,
        commit,
        fileCount: frozen.fileCount,
      },
      ...(note ? { next: note } : {}),
    };
  }

  /**
   * Stop the running turn and start a queued message as soon as the provider lets go, with the
   * stopped turn's packet, the same path a limit stop takes.
   */
  steer(payload: Payload<'SteerChatMessage'>, effects: Effects): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const thread = this.thread(task.id);
    const live = thread.activeTurnId ? this.activeLive(task.id, thread.activeTurnId) : undefined;
    const message = thread.queued.find((entry) => entry.id === payload.messageId);
    if (!live && thread.queuePaused && message && !thread.activeTurnId)
      return this.sendPausedNow(task, message, effects);
    if (!live) return blocked('nothing-running', 'Nothing is running. Send the message.');
    if (!message)
      return blocked('message-not-queued', 'It is no longer queued. If it started, Stop ends it.');
    // Stop keeps the queue here. Once the provider lets go the queue starts its first message.
    this.requestStop(live, STOPS.steer);
    live.steered = true;
    this.putThread(task, {
      ...thread,
      queued: [message, ...thread.queued.filter((entry) => entry.id !== message.id)],
    });
    effects.push(() => this.call(() => live.handle?.stop()));
    return { outcome: 'applied' };
  }

  /**
   * Send now on a paused queue starts that one message at once. The rest of the queue stays
   * paused behind it.
   */
  private sendPausedNow(task: Task, message: ChatQueuedMessage, effects: Effects): CommandResult {
    const { thread, left } = this.checkedThread(task);
    if (left.length || this.checksBusy(task.id) || this.plans.holds(thread))
      return blocked('thread-busy', 'Wait for the thread to be free, then choose Send now.');
    const route = this.plans.route(thread, message);
    const waiting = this.waitsOnFamily(task, thread, route);
    if (waiting)
      return blocked(
        'family-busy',
        `${familyName[waiting]} is answering in another thread. Choose Send now when that reply ends.`,
      );
    const rest = thread.queued.filter((entry) => entry.id !== message.id);
    return this.begin(task, withQueue(thread, rest), route, effects, message.id);
  }

  pushBranch(payload: Payload<'PushChatBranch'>): Promise<CommandResult> {
    return pushChatBranch(this.gitHost(), payload);
  }

  openPullRequest(payload: Payload<'OpenChatPullRequest'>): Promise<CommandResult> {
    return openChatPullRequest(this.gitHost(), payload);
  }

  async branchStatus(payload: Payload<'ReadChatBranchStatus'>): Promise<CommandResult> {
    const status = await readChatBranchStatus(this.gitHost(), payload);
    return { outcome: 'applied', data: { kind: 'chat-branch-status', ...status } };
  }

  /**
   * Fetch the pull request's base branch into the project with the person's own git setup, then
   * merge the accepted commit onto it outside any checkout. A clean merge changes nothing. When
   * text files conflict, the copy moves onto the base with the merge in it and one fixer turn
   * resolves the marked files. What a model cannot merge refuses with its paths. Nothing is
   * pushed: the person accepts the result, then pushes it.
   *
   * With `head`, it only checks, for a merge proposal: it merges that commit onto the fetched base
   * and refuses with the conflicting paths. The copy, the thread and the turns stay as they are.
   * Without a remote named, the base comes from the remote the thread pushed to.
   */
  async checkMerge(request: {
    taskId: string;
    remote?: string;
    base: string;
    head?: string;
  }): Promise<CommandResult> {
    const task = this.task(request.taskId);
    if (!task) return blocked('task-not-found');
    const input = {
      ...request,
      remote: request.remote ?? this.thread(task.id).lastPush?.remote ?? 'origin',
    };
    if (!mergeTarget(input.remote, input.base))
      return blocked('merge-target-invalid', 'Name a configured remote and a branch on it.');
    // The readiness check may release a hold, which writes the turn and its event together.
    const ready = input.head
      ? this.mergeHead(task, input.head)
      : this.deps.store.transaction(() => this.mergeReady(task));
    if (typeof ready !== 'string') return ready;
    const root = this.deps.projectPath(task.projectId) as string;
    if (this.merging.has(task.id))
      return blocked('merge-check-running', 'A merge check is already running in this thread.');
    this.merging.add(task.id);
    try {
      const fetched = await fetchBase(toolRunner(), {
        root,
        remote: input.remote,
        branch: input.base,
        taskId: task.id,
      });
      if ('reason' in fetched) return blocked(fetched.reason, fetched.next);
      if (input.head) return this.mergeChecked(task, root, input.head, fetched.commit, input);
      return this.mergeFetched(task.id, ready, fetched.commit, input);
    } catch (error) {
      return blocked('merge-check-failed', `The merge could not be checked. ${plain(error)}`);
    } finally {
      this.merging.delete(task.id);
      dropFetched(root, task.id);
    }
  }

  /**
   * The accepted commit a merge check starts from, or why it cannot start: the thread must be
   * free, and its copy must match what it accepted, so the merge mixes in nothing unreviewed.
   */
  private mergeReady(task: Task): string | CommandResult {
    const { thread, left } = this.checkedThread(task);
    if (thread.activeTurnId || left.length || this.checksBusy(task.id) || this.plans.holds(thread))
      return blocked('thread-busy', 'Wait for the thread to be free, then check the merge again.');
    const root = this.deps.projectPath(task.projectId);
    if (!root) return blocked('project-not-found', 'Add the project again, then check the merge.');
    const accepted = thread.lastAcceptance;
    if (!accepted?.commit)
      return blocked('nothing-accepted', 'Accept the changes to a branch first.');
    const merge = pendingMerge(join(this.deps.home, 'chat', task.id), thread);
    if (merge)
      return blocked(
        'merge-in-copy',
        `The merge with ${merge.remote}/${merge.branch} waits in the copy. Accept it to ${merge.target}.`,
      );
    try {
      if (
        thread.base !== accepted.commit ||
        listChanges(root, this.scratchDirectory(task.id), thread.base).entries.length
      )
        return blocked(
          'copy-has-changes',
          'Accept or discard the changes in the copy, then check the merge again.',
        );
    } catch (error) {
      return blocked(
        'scratch-unreadable',
        `The scratch copy could not be compared. ${plain(error)}`,
      );
    }
    return accepted.commit;
  }

  /**
   * The head a merge proposal checks. A merge already waiting in the copy has not reached the
   * pull request yet, so the proposal waits for it to be accepted and pushed.
   */
  private mergeHead(task: Task, head: string): string | CommandResult {
    if (!this.deps.projectPath(task.projectId))
      return blocked('project-not-found', 'Add the project again, then check the merge.');
    const thread = this.thread(task.id);
    const merge = pendingMerge(join(this.deps.home, 'chat', task.id), thread);
    if (merge)
      return blocked(
        'merge-in-copy',
        `The merge with ${merge.remote}/${merge.branch} waits in the copy. Accept it to ${merge.target}, push it, then merge.`,
      );
    return head;
  }

  /** Merge `head` onto the fetched base outside the copy and say what it found. */
  private mergeChecked(
    task: Task,
    root: string,
    head: string,
    onto: string,
    input: { remote: string; base: string },
  ): CommandResult {
    const label = `${input.remote}/${input.base}`;
    const work = mkdtempSync(join(this.deps.home, 'chat', task.id, 'merge-'));
    try {
      const merged = mergeOnto({
        root,
        work,
        scratch: this.scratchDirectory(task.id),
        accepted: head,
        base: onto,
        label,
      });
      if (merged.state === 'refused')
        return blocked('conflicts-need-checkout', refusedText(merged.refused));
      const paths = merged.state === 'clean' ? [] : merged.conflicts.map(({ path }) => path);
      const data = { kind: 'chat-merge-check', state: merged.state, base: onto, paths } as const;
      if (merged.state === 'clean')
        return {
          outcome: 'applied',
          reason: 'merge-clean',
          next: `${head.slice(0, 7)} merges cleanly onto ${label} at ${onto.slice(0, 7)}.`,
          data,
        };
      return {
        outcome: 'blocked',
        reason: 'merge-conflicts',
        next: `${head.slice(0, 7)} conflicts with ${label} at ${onto.slice(0, 7)} in ${paths.join(', ')}. Resolve the conflicts, then merge.`,
        data,
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Merge the fetched base, and on a conflict start the turn that resolves it. */
  private mergeFetched(
    taskId: string,
    accepted: string,
    onto: string,
    input: { remote: string; base: string },
  ): CommandResult {
    const effects: Effects = [];
    const result = this.deps.store.transaction((): CommandResult => {
      const task = this.task(taskId);
      if (!task) return blocked('task-not-found');
      // The thread may have moved on while the base was fetched.
      const ready = this.mergeReady(task);
      if (typeof ready !== 'string') return ready;
      if (ready !== accepted)
        return blocked(
          'thread-moved',
          'The thread accepted again meanwhile. Check the merge again.',
        );
      const root = this.deps.projectPath(task.projectId) as string;
      const thread = this.thread(task.id);
      const target = thread.lastAcceptance?.branch as string;
      const label = `${input.remote}/${input.base}`;
      const scratch = this.scratchDirectory(task.id);
      const folder = join(this.deps.home, 'chat', task.id);
      const work = mkdtempSync(join(folder, 'merge-'));
      try {
        const merged = mergeOnto({ root, work, scratch, accepted, base: onto, label });
        if (merged.state === 'clean')
          return {
            outcome: 'applied',
            reason: 'merge-clean',
            next: `${target} merges cleanly onto ${label} at ${onto.slice(0, 7)}.`,
            data: { kind: 'chat-merge-check', state: 'clean', base: onto, paths: [] },
          };
        if (merged.state === 'refused')
          return blocked('conflicts-need-checkout', refusedText(merged.refused));
        const brief = resolutionBrief({ target, label, conflicts: merged.conflicts });
        const paths = merged.conflicts.map((conflict) => conflict.path);
        try {
          merged.write();
        } catch (error) {
          return blocked(
            'merge-not-written',
            `The merge could not be written to the copy. ${plain(error)} Discard the copy's changes, then check the merge again.`,
          );
        }
        writeMerge(folder, {
          accepted,
          base: onto,
          remote: input.remote,
          branch: input.base,
          target,
          paths,
        });
        this.pinBase(task, root, onto);
        // The thread carries the waiting merge, so the Changes tab can offer its branch and message.
        const saved = this.putThread(task, {
          ...thread,
          base: onto,
          pendingMerge: { remote: input.remote, branch: input.base, target, paths },
        });
        const count = paths.length === 1 ? '1 file' : `${paths.length} files`;
        this.appendEntry(task, {
          kind: 'chat-system',
          author: { kind: 'system', turnId: null },
          text: fitText(
            `${label} at ${onto.slice(0, 7)} conflicts with ${target} in ${count}: ${paths.join(', ')}. The copy now starts from ${label} with the merge in it, and the fixer resolves the conflicts.`,
            16_384,
          ),
        });
        const started = this.resolveTurn(task, saved, brief, effects);
        if (started.outcome === 'blocked')
          return blocked(
            started.reason ?? 'fixer-not-started',
            `The merge is in the copy with its conflict markers, and the fixer could not start. ${started.next ?? ''}`.trim(),
          );
        return {
          outcome: 'applied',
          reason: 'merge-conflicts',
          next: `The fixer resolves ${count} in the copy. Accept the result to ${target}, then push it.`,
          data: { kind: 'chat-merge-check', state: 'conflicts', base: onto, paths },
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
    for (const effect of effects) this.call(effect);
    return result;
  }

  /**
   * One fixer turn on the merged copy. A crew that reviews runs it as a fix step, so its checks
   * and review follow the way they follow any fix. Otherwise it is a single fixer turn.
   */
  private resolveTurn(task: Task, thread: ChatThread, brief: string, effects: Effects) {
    const member = (role: string) =>
      thread.crew?.members.find((entry) => entry.role === role)?.selection;
    const newest = this.newestTurn(task.id);
    if (thread.flightMode !== 'manual' && member('reviewer') && newest) {
      const chain = {
        builderTurnId: newest.id,
        step: 'fix',
        reviewRounds: 0,
        fixes: 0,
        reason: null,
      } as const;
      this.crewStep(task, thread, chain, effects, undefined, brief);
      return { outcome: 'applied' } as const;
    }
    return this.begin(
      task,
      thread,
      {
        text: brief,
        role: 'fixer',
        selection: member('fixer') ?? member('builder'),
        attachments: [],
        files: [],
      },
      effects,
    );
  }

  /**
   * Copy the file of an import before `commit` opens the command's transaction, so a large file
   * or one that downloads on open holds up no other thread. `commit` runs synchronously, and the
   * import inside it only moves the copy into place.
   */
  async importing(
    payload: Payload<'ImportChatAttachment'>,
    commit: () => CommandResult,
  ): Promise<CommandResult> {
    if (!this.task(payload.taskId)) return commit();
    let staged: StagedFile | CommandResult;
    try {
      staged = await stageFile(this.filesFolder(payload.taskId), payload.source, (progress) => {
        try {
          this.deps.onImportProgress?.(payload.taskId, progress);
        } catch {
          // A progress update that fails to send changes nothing about the copy.
        }
      });
    } catch (error) {
      staged =
        error instanceof FileRefused
          ? blocked('file-refused', error.message)
          : blocked('file-not-stored', NOT_STORED);
    }
    this.staged = { payload, staged };
    try {
      return commit();
    } finally {
      this.staged = undefined;
      if (!('outcome' in staged)) dropStaged(staged);
    }
  }

  /**
   * Move the copy `importing` made into place and journal it under its hash. The bytes land on
   * disk before the command commits, so a rolled back import leaves a stored file no message
   * names, and the next import of the same bytes reuses it.
   */
  importAttachment(payload: Payload<'ImportChatAttachment'>): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const staged = this.staged?.payload === payload ? this.staged.staged : undefined;
    this.staged = undefined;
    if (!staged) return blocked('file-not-stored', NOT_STORED);
    if ('outcome' in staged) return staged;
    try {
      placeFile(this.filesFolder(task.id), staged);
    } catch {
      return blocked('file-not-stored', NOT_STORED);
    }
    const file = staged.attachment;
    const data = { kind: 'chat-attachment', ...file } as const;
    const key = fileKey(task.id, file);
    if (!this.deps.store.receipt(key))
      this.deps.store.saveReceipt(key, file.id, 'local-owner', { outcome: 'applied', data });
    return { outcome: 'applied', data };
  }

  /**
   * Run the message behind the newest turn again. Retry takes a failed or stopped turn. Regenerate
   * takes a turn with a reply, writes a "Regenerated" line and keeps that reply. A selection on
   * another family moves the thread through the handoff path, so the packet and the handoff line
   * appear and the request carries the conversation's files.
   */
  retryTurn(payload: Payload<'RetryChatTurn'>, effects: Effects): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const { thread, left } = this.checkedThread(task);
    const action = payload.mode;
    if (thread.activeTurnId)
      return blocked('turn-running', `Wait for the reply or stop it, then ${action}.`);
    if (left.length) return ownershipUnknown(left);
    if (this.accepting(task.id)) return acceptanceRunning();
    const turn = this.turn(payload.turnId);
    if (!turn || turn.taskId !== task.id) return blocked('turn-not-found');
    // A plan slice runs again as that slice, never as a new message to the thread (H9).
    if (turn.slice !== undefined) {
      if (payload.mode !== 'retry')
        return blocked('slice-turn', 'Retry runs a slice again from the plan.');
      return this.plans.retrySlice(task, turn, payload.selection, effects);
    }
    if (turn.id !== this.newestTurn(task.id)?.id)
      return blocked(
        'turn-not-latest',
        `Only the newest turn can be ${{ retry: 'retried', regenerate: 'regenerated', continue: 'continued' }[action]}.`,
      );
    // Continue asks the same model for the rest of the reply. The partial reply stays in the thread,
    // so the model reads it as the last answer before this message.
    if (payload.mode === 'continue') {
      if (!turn.assistantMessageId)
        return blocked('no-reply', 'This turn has no reply to continue. Retry runs it again.');
      const started = this.begin(
        task,
        thread,
        {
          text: CONTINUE_TEXT,
          role: turn.role,
          selection: turn.selection,
          attachments: [],
          files: [],
        },
        effects,
      );
      if (started.outcome === 'applied') this.plans.reportRerun(task, turn, effects);
      return started;
    }
    if (payload.mode === 'retry' && turn.state !== 'failed' && turn.state !== 'stopped')
      return blocked('turn-not-retryable', 'This turn finished. Regenerate runs it again.');
    if (payload.mode === 'regenerate' && !turn.assistantMessageId)
      return blocked('no-reply', 'This turn has no reply to regenerate. Retry runs it again.');
    if (this.findEntry(task.id, turn.userMessageId)?.kind !== 'user-message')
      return blocked('message-missing', 'Send the message again.');
    const selection = this.pick(task, thread, payload.selection ?? turn.selection);
    if ('outcome' in selection) return selection;
    // A refusal still commits, so every check runs before the first write.
    const base = thread.base ?? this.head(task);
    if (!base)
      return blocked('project-head-unavailable', 'Commit once in this project, then try again.');
    const moved = this.moveForRetry(task, thread, turn, selection);
    if (moved) return moved;
    if (payload.mode === 'regenerate')
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text: 'Regenerated',
      });
    const admission = this.openTurn(
      task,
      this.thread(task.id),
      { selection, role: turn.role, messageId: turn.userMessageId, base },
      effects,
    );
    if (admission.outcome !== 'refused') this.plans.reportRerun(task, turn, effects);
    return { ...admitted(admission), revision: task.revision };
  }

  /** A turn's stored events after the cursor, oldest first, in whole events up to the page cap. */
  readTurnEvents(payload: Payload<'ReadChatTurnEvents'>): CommandResult {
    if (!this.task(payload.taskId)) return blocked('task-not-found');
    if (this.turn(payload.turnId)?.taskId !== payload.taskId)
      return blocked('turn-not-found', 'Choose a turn of this thread.');
    const page = turnEventPage(
      this.deps.store,
      payload.taskId,
      payload.turnId,
      payload.afterCursor ?? '0',
    );
    if (!page)
      return blocked(
        'turn-event-too-large',
        'One stored event of this turn exceeds the page size. No events were skipped.',
      );
    return { outcome: 'applied', data: { kind: 'chat-turn-events', ...page } };
  }

  /**
   * Put one path of the scratch copy back the way the thread's base has it. Changes then leaves it
   * out, so Accept carries only what is left. A system line records each discard.
   */
  discardChange(payload: Payload<'DiscardChatChange'>, key?: string): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const { thread, left } = this.checkedThread(task);
    if (thread.activeTurnId)
      return blocked('turn-running', 'Wait for the reply or stop it, then discard.');
    if (left.length) return ownershipUnknown(left);
    if (this.checksInCopy(task.id)) return changeCommands.checksRunning();
    const root = this.deps.projectPath(task.projectId);
    if (!root) return blocked('project-not-found', 'Add the project again, then discard.');
    const base = thread.base;
    if (!base || !thread.scratchReady)
      return blocked('not-changed', 'This file has no changes to discard.');
    // The copy changes before the receipt commits. A crash between the two leaves the mark, and the
    // retry of that command finds the copy already restored. Its line rolled back with the
    // receipt, so the retry answers applied and writes it.
    const file = join(this.deps.home, 'chat', task.id, 'discard.json');
    const mark = key ? readDiscardMark(file) : null;
    const retried =
      mark && mark.key === key && mark.path === payload.path && mark.base === base
        ? mark.done
        : null;
    let outcome: DiscardOutcome;
    try {
      outcome = discardScratchPath(
        root,
        this.scratchDirectory(task.id),
        base,
        payload.path,
        key ? (done) => writeDiscardMark(file, { key, path: payload.path, base, done }) : undefined,
      );
    } catch {
      return blocked('scratch-unreadable', 'The scratch copy could not be read. Discard again.');
    }
    if (retried && 'refused' in outcome && outcome.refused === 'not-changed')
      outcome = { done: retried };
    if ('refused' in outcome) return blocked(outcome.refused, discardRefusals[outcome.refused]);
    const short = base.slice(0, 7);
    this.appendEntry(task, {
      kind: 'chat-system',
      author: { kind: 'system', turnId: null },
      text:
        outcome.done === 'removed'
          ? `Discarded ${payload.path}, a file added in this thread.`
          : outcome.done === 'recovered'
            ? `Restored ${payload.path} from the base commit ${short}.`
            : outcome.done === 'relinked'
              ? `Restored the link ${payload.path} from the base commit ${short}.`
              : `Discarded the changes to ${payload.path}. It matches the base commit ${short}.`,
    });
    this.observe(task.id, { kind: 'changes-discarded' });
    return { outcome: 'applied' };
  }

  /** The thread's title is its task's title. A paste can carry line breaks, so spaces collapse. */
  renameThread(payload: Payload<'RenameChatThread'>): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const title = payload.title.replace(/\s+/g, ' ').trim();
    if (!title) return blocked('title-empty', 'Type a title for the thread.');
    if (title === task.title) return { outcome: 'applied', entity: task, revision: task.revision };
    const renamed = TaskSchema.parse({ ...task, title, revision: task.revision + 1 });
    this.deps.store.put('task', renamed.id, renamed.revision, renamed);
    this.deps.emit('task.updated', renamed.id, renamed.revision, renamed);
    return { outcome: 'applied', entity: renamed, revision: renamed.revision };
  }

  /**
   * Remove the thread, its conversation and its events. Branches it accepted stay in the
   * repository. The delete is journaled under `chat-deleted:<task>` in the same commit, and the
   * thread's folder under the controller home goes after commit. Startup removes any folder a
   * crash left behind, so nothing of the thread comes back.
   */
  deleteThread(payload: Payload<'DeleteChatThread'>, effects: Effects): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const { thread, left } = this.checkedThread(task);
    if (thread.activeTurnId)
      return blocked('turn-running', 'Stop the reply, then delete the thread.');
    // A side question runs beside the active turn and sets none. Deleting under it would drop its
    // row while its provider turn went on spending, where nothing could see it.
    if ([...this.live.values()].some((turn) => turn.taskId === task.id && !turn.finished))
      return blocked(
        'turn-running',
        'A turn of this thread is still running. Stop it or wait for it, then delete the thread.',
      );
    // A process that outlived its turn may still write to the scratch copy.
    if (left.length) return ownershipUnknown(left);
    // A check of this process still reads and may write the copy, and its record is still open.
    if (this.checks.live(task.id)) return changeCommands.checksRunning();
    // A row whose every recorded group is gone is one recovery would settle, so it settles here and
    // keeps nothing. Nothing of this task runs in this process, as checked above. Signals nothing.
    const journal = new OperationStore(this.deps.store, this.deps.now);
    for (const record of journal.unresolved(task.id))
      journal.settleProven(record.id, this.deps.groupAbsent ?? groupAbsent);
    // An operation that has not ended and that nothing here runs keeps its record, and the record
    // keeps the thread, the way a hold does.
    if (this.deps.store.unresolvedOperations(task.id))
      return ownershipUnknown(this.checks.orphans(task.id));
    if (this.deps.store.workInFlight(task.id))
      return blocked(
        'work-in-flight',
        'Wait for the push, pull request or acceptance to settle, or reconcile it, then delete the thread.',
      );
    // A copy being prepared writes into the thread's folder and its record until it ends.
    if (this.deps.dependencies?.preparing(task.id))
      return blocked(
        'work-in-flight',
        'Wait for the dependency preparation to finish, then delete the thread.',
      );
    // A large event keeps its output in an artifact that only its activity row names. The rows go
    // with the task, and the artifacts go after commit.
    const outputs = this.deps.store.db
      .prepare(
        'SELECT artifact_id FROM activity_output WHERE cursor IN (SELECT cursor FROM events WHERE task_id=?)',
      )
      .all(task.id)
      .map((row) => row.artifact_id as string);
    // A settled operation's definition and output records go with the task. Their files go after
    // commit unless another record names the same bytes, and so does each operation's own folder.
    // shortcut: a crash between the commit and the effect leaves those files and folders on disk
    // with no record. Upgrade: a startup sweep of files and operation folders no record names.
    const operationFiles = this.deps.store.operationArtifacts(task.id).map(({ hash }) => hash);
    const operationIds = this.deps.store.db
      .prepare('SELECT operation_id FROM task_operations WHERE task_id=?')
      .all(task.id)
      .map((row) => row.operation_id as string);
    if (task.runId || !this.deps.store.removeTask(task.id))
      return blocked(
        'thread-has-runs',
        'This task has runs outside the chat, so it stays. Only a chat thread can be deleted.',
      );
    const files = `chat-file:${task.id}:`;
    this.deps.store.db
      .prepare('DELETE FROM receipts WHERE substr(command_key,1,length(?))=?')
      .run(files, files);
    // The task's own events went with it. This one has no task, so the rail hears it.
    this.deps.emit('task.removed', null, task.revision, { taskId: task.id });
    this.observe(task.id, { kind: 'thread-deleted' });
    this.deps.store.saveReceipt(
      `chat-deleted:${task.id}`,
      hashCanonical({ taskId: task.id }),
      'local-owner',
      { outcome: 'applied', entity: task },
    );
    effects.push(() => {
      this.removeOutputs(outputs);
      this.removeUnnamed(operationFiles);
      this.removeOperationFolders(operationIds);
      this.removeFromDisk(task);
    });
    return { outcome: 'applied' };
  }

  /**
   * The person's release of a thread held by a check that never recorded its process group. The
   * controller cannot prove that process gone and never will, so without this the thread stays
   * held for good. CrewKite proves nothing and signals nothing here. The check's record keeps the
   * person's note, its run reads failed with a reason that says so, and the thread gets one line.
   * The flag clears through the same check every command makes. A provider process still present
   * keeps the thread held, and the line and the result say so.
   */
  releaseCheck(payload: Payload<'ReleaseChatCheck'>, effects: Effects): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    // What holds the thread decides the answer: nothing, a check this process still runs, a check
    // group the journal recorded, or only a provider process, which no release covers.
    const refuse = (reason: keyof typeof releaseRefusals) =>
      blocked(reason, releaseRefusals[reason]);
    const providers = this.heldTurns(task).flatMap((turn) => this.stillPresent(turn));
    const checks = this.checks.orphans(task.id);
    if (!providers.length && !checks.length) {
      // The flag clears with the answer when every process it stood for has gone.
      this.release(task);
      return refuse('check-release-not-needed');
    }
    if (this.checks.live(task.id)) return refuse('check-running');
    if (checks.some((group) => group > 0)) return refuse('check-process-recorded');
    if (!checks.length) return refuse('hold-not-releasable');
    const released = this.checks.releaseHeld(task.id, payload.note);
    const held = this.release(task).length > 0;
    const thread = this.thread(task.id);
    // shortcut: runs carry no operation ID, so every unknown run of the thread is rewritten.
    // Upgrade: record the operation ID on the run.
    if (thread.checks)
      this.putThread(task, {
        ...thread,
        checks: {
          ...thread.checks,
          runs: thread.checks.runs.map((run) =>
            run.status === 'unknown' ? { ...run, status: 'failed', reason: RELEASED_RUN } : run,
          ),
        },
      });
    this.appendEntry(task, {
      kind: 'chat-system',
      author: { kind: 'system', turnId: null },
      text: held
        ? 'You released the check. A provider process still holds this thread.'
        : "You released this thread. CrewKite never confirmed the check's process ended.",
    });
    effects.push(() => this.continueQueue(task.id));
    return {
      outcome: 'applied',
      data: { kind: 'chat-check-released', taskId: task.id, released, held },
    };
  }

  /**
   * The read-only thread tools for one thread, as the MCP server and the Local functions call
   * them. `asking` is the turn that reads, which the reads leave out.
   */
  threadReads(taskId: string, scratch?: string, asking?: string): ThreadReads {
    return createThreadReader(
      {
        store: this.deps.store,
        home: this.deps.home,
        ...(scratch ? { scratch } : {}),
        projectPath: this.deps.projectPath,
        now: () => Date.parse(this.deps.now()),
      },
      taskId,
      asking,
    );
  }

  /**
   * A read-only question to one family. It starts at once beside whatever the thread runs, in a
   * fresh session of its own, and never waits in the queue (ADR 0050). The thread's active turn
   * stays the builder's, so Stop, Send now, a handoff and the plan never see the question. It
   * reads only and holds no session the thread resumes, so the one turn per family rule that
   * keeps threads from competing does not hold it back. One side question runs per thread at a
   * time. The reply posts as a turn with the ask role, and the thread keeps its own pick.
   */
  ask(payload: Payload<'AskChatFamily'>, effects: Effects): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const entry = this.deps
      .catalog(task.id)
      .families.find((value) => value.family === payload.family);
    const model = payload.model ?? entry?.defaultModel ?? entry?.models[0]?.model;
    if (!model) return blocked('selection-unavailable', 'Pick a model for this provider first.');
    const effort = entry?.models.find((value) => value.model === model)?.defaultEffort ?? 'default';
    const selection = this.deps.resolveSelection(task.id, {
      family: payload.family,
      model,
      effort,
    });
    if (!selection) return blocked('selection-unavailable', 'Pick a model the provider lists.');
    const open = this.deps.store.db
      .prepare(
        "SELECT 1 FROM chat_turns WHERE task_id=? AND json_extract(body,'$.role')='ask' AND json_extract(body,'$.slice') IS NULL AND json_extract(body,'$.state') IN ('queued','running','waiting-permission') LIMIT 1",
      )
      .get(task.id);
    if (open)
      return blocked('ask-running', 'Wait for the side question to finish, or stop it, then ask.');
    return this.begin(
      task,
      this.thread(task.id),
      { text: payload.question, selection, role: 'ask', attachments: [], files: [] },
      effects,
    );
  }

  /** Of these hashes, the ones some artifact record other than `except` still names. One read. */
  private namedHashes(hashes: readonly string[], except: readonly string[] = []): Set<string> {
    return new Set(
      this.deps.store.db
        .prepare(
          `SELECT DISTINCT json_extract(body,'$.hash') AS hash FROM entities WHERE kind='artifact'
          AND json_extract(body,'$.hash') IN (SELECT value FROM json_each(?))
          AND id NOT IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify([...new Set(hashes)]), JSON.stringify(except))
        .map((row) => row.hash as string),
    );
  }

  /** Files of a deleted thread's operations that no artifact record names any more. */
  private removeUnnamed(hashes: readonly string[]) {
    try {
      const named = this.namedHashes(hashes);
      for (const hash of new Set(hashes)) if (!named.has(hash)) this.deps.artifacts.remove(hash);
    } catch {
      // The files stay. Nothing names them, so nothing reads them.
    }
  }

  /**
   * Remove event output artifacts that no activity row names, and each file once no artifact names
   * its hash. The file goes before the record, so a crash between the two leaves a record that
   * startup finds and removes.
   */
  private removeOutputs(ids: readonly string[]) {
    if (!ids.length) return;
    const db = this.deps.store.db;
    try {
      const doomed = db
        .prepare(
          `SELECT id, json_extract(body,'$.hash') AS hash FROM entities WHERE kind='artifact'
          AND id IN (SELECT value FROM json_each(?)) AND json_extract(body,'$.mediaType')=?
          AND id NOT IN (SELECT artifact_id FROM activity_output)`,
        )
        .all(JSON.stringify(ids), EVENT_OUTPUT) as { id: string; hash: string }[];
      const named = this.namedHashes(
        doomed.map((row) => row.hash),
        doomed.map((row) => row.id),
      );
      for (const hash of new Set(doomed.map((row) => row.hash)))
        if (!named.has(hash)) this.deps.artifacts.remove(hash);
      this.deps.store.transaction(() => {
        const remove = db.prepare("DELETE FROM entities WHERE kind='artifact' AND id=?");
        for (const { id } of doomed) remove.run(id);
      });
    } catch {
      // Startup tries again while the records are there.
    }
  }

  /**
   * Each deleted operation's own folder under the home. A link at the operations folder or in an
   * operation's place is left alone, and rmSync never follows the links inside.
   */
  private removeOperationFolders(ids: readonly string[]) {
    const parent = join(this.deps.home, 'operations');
    if (!lstatSync(parent, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const id of ids) {
      const folder = join(parent, id);
      try {
        if (
          /^cmd_[0-9A-Z]+$/.test(id) &&
          lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()
        )
          rmSync(folder, { recursive: true, force: true });
      } catch {
        // The folder stays. Nothing names it any more.
      }
    }
  }

  private gitHost(): ChatGitHost {
    return {
      thread: (taskId) => (this.task(taskId) ? this.thread(taskId) : null),
      // The git step answers outside the command transaction, and the events these writes emit
      // need one of their own.
      journal: (taskId, update, text) =>
        this.deps.store.transaction(() => {
          const task = this.task(taskId);
          if (!task) return;
          this.putThread(task, update(this.thread(taskId)));
          this.appendEntry(task, {
            kind: 'chat-system',
            author: { kind: 'system', turnId: null },
            text,
          });
        }),
      projectRoot: (taskId) => {
        const task = this.task(taskId);
        return task && this.deps.projectPath(task.projectId);
      },
      now: this.deps.now,
      effects: this.deps.remoteEffects,
    };
  }

  /** Run a proposed plan, or one slice of it once its dependencies are done. */
  runPlan(payload: Payload<'RunChatPlan'>, effects: Effects): CommandResult {
    return this.plans.run(payload, effects);
  }

  /** Cancel a proposed plan, or stop a running one. Unfinished slices show not run. */
  cancelPlan(payload: Payload<'CancelChatPlan'>, effects: Effects): CommandResult {
    return this.plans.cancel(payload, effects);
  }

  /** The service's own reads and writes, lent to the plan runner. */
  private planHost(): ConstructorParameters<typeof PlanRunner>[0] {
    const text = (taskId: string, id: string | null) =>
      id ? this.findEntry(taskId, id)?.text : undefined;
    return {
      transaction: (work) => this.deps.store.transaction(work),
      call: (work) => this.call(work),
      catalog: (taskId) => this.deps.catalog(taskId),
      now: () => this.deps.now(),
      task: (taskId) => this.task(taskId),
      thread: (taskId) => this.thread(taskId),
      putThread: (task, thread) => this.putThread(task, thread),
      notice: (kind, task, line) => this.notice(kind, task.id, line),
      observe: (event) => this.observed(event),
      line: (task, value) =>
        this.appendEntry(task, {
          kind: 'chat-system',
          author: { kind: 'system', turnId: null },
          text: fitText(value, 16_384),
        }),
      turn: (turnId) => this.turn(turnId),
      turns: (taskId) => this.turns(taskId),
      reply: (turn) => text(turn.taskId, turn.assistantMessageId),
      message: (turn) => text(turn.taskId, turn.userMessageId),
      begin: (task, thread, input, effects, say) => {
        const before = this.newestSequence(task.id);
        const started = this.begin(task, thread, input, effects);
        // A plan's own turn that cannot start says why, when the refusal wrote no line itself.
        if (
          say &&
          started.outcome !== 'applied' &&
          started.next &&
          this.newestSequence(task.id) === before
        )
          this.appendEntry(task, {
            kind: 'chat-system',
            author: { kind: 'system', turnId: null },
            text: started.next,
          });
        return started;
      },
      beginLane: (task, thread, input, effects, line) => {
        const started = this.begin(task, thread, input, effects, undefined, input.slice, line);
        return started.outcome === 'applied' ? (this.newestTurn(task.id)?.id ?? started) : started;
      },
      crewStep: (task, thread, chain, effects, brief) =>
        this.crewStep(task, thread, chain, effects, undefined, brief),
      findings: (review) => statedFindings(review),
      reviewBrief: CREW_REVIEW,
      creditsPaused: (taskId, selection, role) => this.creditsPausedOn(taskId, selection, role),
      nextFamily: (taskId, from, role) => this.nextFamily(taskId, from, [role]),
      assigned: (taskId, family, role) => {
        const connection = this.route(taskId, role, family);
        return connection
          ? { billingMode: connection.billingMode, ready: !this.unready(connection) }
          : null;
      },
      familyBusy: (family) =>
        !!this.deps.store.db
          .prepare(
            "SELECT 1 FROM chat_turns WHERE json_extract(body,'$.selection.family')=? AND json_extract(body,'$.state') IN ('queued','running','waiting-permission') LIMIT 1",
          )
          .get(family),
      stopTurn: (taskId, turnId, why) => {
        const live = this.activeLive(taskId, turnId);
        // A turn opened in the same transaction has no live turn yet. Its launch reads this.
        if (!live && !this.live.has(turnId)) this.stoppedEarly.set(turnId, planStop(why));
        if (!live) return;
        this.requestStop(live, planStop(why));
        queueMicrotask(() => this.call(() => live.handle?.stop()));
      },
      planThreads: () =>
        (
          this.deps.store.db
            .prepare(
              "SELECT task_id FROM chat_threads WHERE json_extract(body,'$.plan.phase')='running'",
            )
            .all() as { task_id: string }[]
        ).map((row) => row.task_id),
      wakeQueues: () => this.wakeQueues(),
      projectPath: (task) => this.deps.projectPath(task.projectId),
      stopActive: (taskId, effects) => {
        const id = this.thread(taskId).activeTurnId;
        const live = id ? this.activeLive(taskId, id) : undefined;
        if (!live) return;
        this.requestStop(live, planStop('you cancelled it'));
        effects.push(() => this.call(() => live.handle?.stop()));
      },
      free: (task) => !this.checkedThread(task).left.length && !this.accepting(task.id),
      scratchDirectory: (taskId) => this.scratchDirectory(taskId),
      runLaneChecks: (taskId, slice, directory) =>
        this.planChecks(taskId, directory, { slice, lane: true }),
      runCombinedChecks: (taskId, directory, slice) =>
        this.runCombinedChecks(taskId, directory, slice),
      stopCombinedChecks: (taskId) => {
        // A plan stopped while its checks wait on the person's answer ends that wait too.
        const asked = this.checkAsk.get(taskId);
        if (asked) {
          this.dropCheckAsk(taskId);
          asked.settle('stop', []);
        }
        return this.stopCombinedChecks(taskId) || !!asked;
      },
      localContext: () => this.deps.localContext?.() ?? null,
      localSliceFits: this.deps.localSliceFits ?? localSliceFits,
      sliceCap: (taskId) => this.deps.store.recipeSliceCap(taskId),
      reportThread: (taskId) => this.reportThread(taskId),
      keptBack: (turnId) => this.keptBack.get(turnId),
    };
  }

  readThread(payload: Payload<'ReadChatThread'>): ChatThreadRead {
    // Reads run synchronously on the one connection, so nothing lands between this and the rows.
    const cursor = this.deps.store.cursor();
    const thread = this.thread(payload.taskId);
    const liveEvents = thread.activeTurnId
      ? newest(compact(this.agentEvents(payload.taskId, thread.activeTurnId)), LIVE_EVENT_BYTES)
      : [];
    const turns = newest(this.turns(payload.taskId).slice(-500), TURN_BYTES);
    const used = size(thread) + size(liveEvents) + size(turns);
    const messages = newest(
      this.messages(payload.taskId, payload.beforeCursor, payload.limit),
      READ_BYTES - used,
    );
    // Load earlier shows only when something older than the oldest message here exists.
    const oldest = messages[0]?.cursor ?? payload.beforeCursor;
    const more = oldest !== undefined && this.messages(payload.taskId, oldest, 1).length > 0;
    return ChatThreadReadSchema.parse({ thread, turns, messages, liveEvents, cursor, more });
  }

  /** Threads that match a search, from the index the database keeps. A read; it writes nothing. */
  searchHistory(payload: Payload<'SearchChatHistory'>): ChatSearchResult {
    return searchHistory(this.deps.store.db, payload);
  }

  /** One page of the Changes list. A page read under a listing that has moved on is refused. */
  readChanges(payload: Payload<'ReadChatChanges'>): ChatChangesRead | CommandResult {
    const thread = this.thread(payload.taskId);
    const task = this.task(payload.taskId);
    const root = task && this.deps.projectPath(task.projectId);
    const empty = { taskId: payload.taskId, base: thread.base, total: 0, next: null };
    if (!thread.scratchReady || !thread.base || !root)
      return { ...empty, files: [], listing: null };
    try {
      const page = review.readChangesPage(this.deps.store.db, {
        repository: root,
        scratch: this.scratchDirectory(payload.taskId),
        base: thread.base,
        payload,
      });
      return 'refused' in page
        ? blocked('listing-changed', 'The changes moved since the first page. Read them again.')
        : page;
    } catch (error) {
      if (!(error instanceof ScratchTooLarge)) throw error;
      // The read has no field for a cause, so one entry says why the list is empty.
      return {
        ...empty,
        total: 1,
        listing: null,
        files: [
          {
            // A backslash cannot sit in a scratch path, so Discard can never match this note.
            path: '\\Changes could not be listed',
            additions: 0,
            deletions: 0,
            patch: `${error.message}\n`,
            hunks: [],
            hunkControls: false,
            decided: false,
          },
        ],
      };
    }
  }

  decideHunk(payload: Payload<'DecideChatHunk'>): CommandResult {
    // A decision leaves the copy alone. An Accept running its checks reads it before publishing
    // and stops when it changed.
    return changeCommands.decideHunk(
      { ...this.changeHost(), checksBusy: (taskId) => this.copyChecked(taskId) },
      payload,
    );
  }

  discardHunk(payload: Payload<'DiscardChatHunk'>): CommandResult {
    const result = changeCommands.discardHunk(this.changeHost(), payload);
    if (result.outcome === 'applied') this.observe(payload.taskId, { kind: 'changes-discarded' });
    return result;
  }

  commentChange(payload: Payload<'CommentChatChange'>, effects: Effects): CommandResult {
    return changeCommands.commentChange(
      this.changeHost((message) => this.sendMessage(message, effects)),
      payload,
    );
  }

  private changeHost(
    send: ChangeCommandHost['send'] = () => blocked('not-sent'),
  ): ChangeCommandHost {
    return {
      db: this.deps.store.db,
      task: (taskId) => this.task(taskId),
      checkedThread: (task) => this.checkedThread(task),
      ownershipUnknown: (left) => ownershipUnknown(left),
      checksBusy: (taskId) => this.checksInCopy(taskId),
      projectPath: (projectId) => this.deps.projectPath(projectId),
      scratchDirectory: (taskId) => this.scratchDirectory(taskId),
      systemLine: (task, text) => {
        this.appendEntry(task, {
          kind: 'chat-system',
          author: { kind: 'system', turnId: null },
          text,
        });
      },
      send,
    };
  }

  private readonly mentionIndex = createMentionIndex(() => Date.now());

  /** Ranked files and folders of the scratch copy for the text typed after an at sign. */
  completeMention(payload: Payload<'CompleteChatMention'>): ChatMentionsRead {
    const thread = this.thread(payload.taskId);
    const mentions = thread.scratchReady
      ? this.mentionIndex.complete(
          this.scratchDirectory(payload.taskId),
          this.deps.resolveEnvironment('local'),
          payload.query,
          payload.limit,
        )
      : [];
    return { taskId: payload.taskId, mentions };
  }

  /** The instruction files at the copy root, and the text of one the person opens. */
  readInstructions(payload: Payload<'ReadChatInstructions'>): ChatInstructionsRead {
    const thread = this.thread(payload.taskId);
    return thread.scratchReady
      ? readInstructionFiles(payload.taskId, this.scratchDirectory(payload.taskId), payload.name)
      : { taskId: payload.taskId, files: [], name: null, text: null, truncated: false };
  }

  readCatalog(payload: Payload<'ReadChatCatalog'>): ChatCatalogRead {
    return ChatCatalogReadSchema.parse(this.deps.catalog(payload.taskId));
  }

  private thread(taskId: string): ChatThread {
    const row = this.deps.store.db
      .prepare('SELECT body FROM chat_threads WHERE task_id=?')
      .get(taskId);
    return ChatThreadSchema.parse(
      row
        ? JSON.parse(row.body as string)
        : { taskId, scratchReady: false, base: null, selection: null },
    );
  }

  /**
   * A turn left open by a previous controller process has no owner. Fail it visibly. Process
   * groups that no one proved gone are checked again, and a thread stays blocked while any of
   * them is present. Messages queued before the restart start once their thread is free.
   */
  recover() {
    this.sweepDeleted();
    this.sweepOneTurns();
    // A check still marked running belonged to the process that is gone.
    this.checks.recover();
    // So did an Accept that held a thread. It never publishes on its own (acceptance.ts).
    const unknown = this.deps.store.transaction(() =>
      recoverAttempts(this.deps.store, this.deps.now()),
    );
    for (const attempt of unknown)
      dropAttemptFolders(attemptFolders(this.deps.home, attempt.taskId, attempt.id), false);
    const rows = this.deps.store.db
      .prepare(
        "SELECT id,task_id FROM chat_turns WHERE json_extract(body,'$.state') IN ('queued','running','waiting-permission') OR json_array_length(body,'$.groups')>0 ORDER BY task_id,sequence",
      )
      .all() as { id: string; task_id: string }[];
    const flagged = this.deps.store.db
      .prepare("SELECT task_id FROM chat_threads WHERE json_extract(body,'$.ownershipUnknown')=1")
      .all() as { task_id: string }[];
    const waiting = this.deps.store.db
      .prepare("SELECT task_id FROM chat_threads WHERE json_array_length(body,'$.queued')>0")
      .all() as { task_id: string }[];
    const chains = this.deps.store.db
      .prepare(
        "SELECT task_id FROM chat_threads WHERE json_extract(body,'$.crewChain.step') IN ('review','fix','challenge')",
      )
      .all() as { task_id: string }[];
    const plans = this.deps.store.db
      .prepare("SELECT task_id FROM chat_threads WHERE json_extract(body,'$.plan.phase')='running'")
      .all() as { task_id: string }[];
    // A start that waits for a reset survives the restart. One already due runs at once.
    const starts = this.deps.store.db
      .prepare("SELECT task_id FROM chat_threads WHERE json_extract(body,'$.startAt') IS NOT NULL")
      .all() as { task_id: string }[];
    for (const row of starts) {
      const at = this.thread(row.task_id).startAt?.at;
      if (at) this.armStart(row.task_id, at);
    }
    if (!rows.length && !flagged.length && !waiting.length && !chains.length && !plans.length)
      return;
    this.deps.store.transaction(() => {
      for (const row of rows) {
        const turn = this.turn(row.id);
        if (!turn || this.live.has(turn.id) || !OPEN_STATES.has(turn.state)) continue;
        const left = this.stillPresent(turn);
        this.settle(turn.id, {
          state: 'failed',
          failure: restartFailure(left.length, groupNames(left)),
          text: streamedText(this.agentEvents(turn.taskId, turn.id)),
          session: null,
          stopReason: 'error',
          groups: left,
        });
      }
      for (const taskId of new Set([...rows, ...flagged].map((row) => row.task_id))) {
        const task = this.task(taskId);
        if (task) this.release(task);
      }
      // A plan says it stopped before its chain does, so a plan mid-review gets its line too.
      this.plans.recoverThreads(plans.map((row) => row.task_id));
      // The step turn failed above, so the chain stops where it was. Nothing relaunches on its own.
      for (const row of chains) {
        const task = this.task(row.task_id);
        const thread = this.thread(row.task_id);
        const open = thread.activeTurnId ? this.turn(thread.activeTurnId) : undefined;
        if (task && thread.crewChain && !(open && OPEN_STATES.has(open.state)))
          this.stopCrew(task, thread, thread.crewChain, 'CrewKite restarted');
      }
    });
    for (const row of waiting) this.continueQueue(row.task_id);
  }

  /**
   * Every folder under one-turns belongs to a one-off turn of an earlier controller, since no turn
   * of this process exists before recovery. Nothing is signaled: no group number was recorded. A
   * process such a turn left keeps running and finds its folder gone.
   */
  private sweepOneTurns() {
    const chat = join(this.deps.home, 'chat');
    const root = join(chat, 'one-turns');
    try {
      // A link at either folder is left alone. rmSync removes links inside the tree and never
      // follows them.
      if (
        lstatSync(chat, { throwIfNoEntry: false })?.isDirectory() &&
        lstatSync(root, { throwIfNoEntry: false })?.isDirectory()
      )
        rmSync(root, { recursive: true, force: true });
    } catch {
      // Startup tries again while the folder is there.
    }
  }

  /**
   * The thread, with the groups its earlier turns left behind checked again. Once all of them
   * are gone the block lifts here, so the block lifts here, with no restart needed.
   */
  private checkedThread(task: Task): { thread: ChatThread; left: number[] } {
    const thread = this.thread(task.id);
    if (!thread.ownershipUnknown) return { thread, left: [] };
    const left = this.release(task);
    return { thread: left.length ? thread : this.thread(task.id), left };
  }

  /**
   * Check the groups saved on the task's settled turns again and drop the ones that are gone.
   * The thread's flag clears when none is left. Returns the groups still present.
   */
  private release(task: Task): number[] {
    const left: number[] = [];
    for (const turn of this.heldTurns(task)) {
      const present = this.stillPresent(turn);
      if (present.length !== turn.groups?.length) this.putTurn(task, withGroups(turn, present));
      left.push(...present);
    }
    // A project check the journal cannot prove gone holds the thread like a provider process.
    left.push(...this.checks.orphans(task.id));
    const { ownershipUnknown: flagged, ...thread } = this.thread(task.id);
    if (flagged && !left.length) this.putThread(task, thread);
    return left;
  }

  /**
   * The task's settled turns that saved groups. An open turn's groups belong to the live turn,
   * which proves them gone as it finishes.
   */
  private heldTurns(task: Task): ChatTurn[] {
    return this.deps.store.db
      .prepare(
        "SELECT body FROM chat_turns WHERE task_id=? AND json_array_length(body,'$.groups')>0 ORDER BY sequence",
      )
      .all(task.id)
      .map((row) => ChatTurnSchema.parse(JSON.parse(row.body as string)))
      .filter((turn) => !OPEN_STATES.has(turn.state));
  }

  /**
   * Saved groups that a check finds present. A clock comparison with the boot time cannot prove a
   * group gone, so a present number holds the thread even after a reboot. A second writer in the
   * same copy can cost the person's work, so a false hold is the cheaper mistake. A saved group is
   * never signaled: its number may belong to another process by now.
   */
  private stillPresent(turn: ChatTurn): number[] {
    const absent = this.deps.groupAbsent ?? groupAbsent;
    return (turn.groups ?? []).filter((group) => !absent(group));
  }

  close(): Promise<void> | undefined {
    this.closed = true;
    for (const cancel of this.startTimers.values()) cancel();
    this.startTimers.clear();
    for (const asked of [...this.checkAsk.values()]) asked.settle('stop', []);
    this.checkAsk.clear();
    this.checks.close();
    // A preview pass ends once its process is stopped, so the store stays open until then.
    const passes = [...this.shots.values()].map((entry) => {
      entry.abort.abort();
      return entry.done;
    });
    const running = [...this.live.values()];
    for (const live of running) {
      this.requestStop(live, STOPS.restart);
      this.call(() => live.handle?.stop());
    }
    const lone = [...this.oneTurns];
    for (const turn of lone) this.call(() => turn.live.handle?.stop());
    if (!running.length && !lone.length && !passes.length) return;
    return Promise.allSettled([...[...running, ...lone].map((turn) => turn.done), ...passes]).then(
      () => {},
    );
  }

  /**
   * One read-only turn that belongs to no thread, for a command that needs a model's answer, such
   * as a design system drafted from a description. It runs in an empty folder of its own with no
   * thread tools, no MCP servers, no subagents and no credit spending. No person watches it, so
   * every ask it raises is denied. The result comes back once its processes are proven gone.
   * Nothing is journaled: the folder holds nothing to protect, and the command that asked keeps
   * the answer in its receipt.
   */
  async oneTurn(input: {
    projectId: string;
    role: ChatTurn['role'];
    selection: ChatModelSelection;
    systemContext: string;
    prompt: string;
    deadlineMs: number;
  }): Promise<ChatTurnResult> {
    const { selection } = input;
    const failed = (message: string): ChatTurnResult => ({
      ...stoppedResult,
      stopReason: 'error',
      failure: chatFailure({ stage: 'launch', kind: 'internal', message }),
    });
    const project = this.deps.store.get<Project>('project', input.projectId);
    const adapter = this.deps.adapters.get(selection.family);
    if (!project) return failed('The project is no longer registered.');
    if (!adapter) return failed('No adapter is registered for this provider.');
    if (selection.family === 'google' && !this.deps.googleTermsAcknowledged())
      return failed('Acknowledge the Google terms in Settings > Google before using Google.');
    if (this.closed) return stoppedResult;
    const turnId = this.deps.id('trn');
    const folder = join(this.deps.home, 'chat', 'one-turns', turnId);
    const live: Pick<LiveTurn, 'handle' | 'gone'> = { handle: null, gone: new Set() };
    const run = async (): Promise<ChatTurnResult> => {
      let result: ChatTurnResult;
      try {
        for (const part of ['scratch', 'work'])
          mkdirSync(join(folder, part), { recursive: true, mode: 0o700 });
        live.handle = adapter.startTurn(
          {
            turnId,
            // No thread owns the turn, so the field names the project. No adapter reads it.
            taskId: input.projectId,
            role: input.role,
            selection,
            prompt: input.prompt,
            systemContext: input.systemContext,
            history: [],
            session: null,
            resumable: false,
            threadTools: false,
            scratch: { directory: join(folder, 'scratch'), base: '', projectName: project.name },
            work: { directory: join(folder, 'work'), home: this.deps.home },
            permissionPolicy: 'ask',
            permissionGrants: [],
            readOnly: true,
            subagents: false,
            deadlineMs: input.deadlineMs,
            environment: this.deps.resolveEnvironment(selection.family),
            now: () => Date.parse(this.deps.now()),
          },
          (event) => {
            if (event.type !== 'permission.requested') return;
            const deny = event.options.find((option) => option.kind === 'deny');
            // An ask emitted before startTurn returned has no handle yet. It has one a tick later.
            queueMicrotask(() =>
              this.call(() =>
                deny
                  ? live.handle?.respondPermission(event.requestId, deny.id)
                  : live.handle?.stop(),
              ),
            );
          },
        );
        result = await live.handle.result;
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 2000) : 'Unknown error.';
        result = failed(`The turn could not start. ${reason}`);
      }
      const left = await this.quiesce(live);
      try {
        rmSync(folder, { recursive: true, force: true });
      } catch {
        // A folder left behind holds only the client's trace for this turn.
      }
      return left.length
        ? { ...result, stopReason: 'error', failure: processFailure(left) }
        : result;
    };
    const turn = { live, done: run() };
    this.oneTurns.add(turn);
    try {
      return await turn.done;
    } finally {
      this.oneTurns.delete(turn);
    }
  }

  private launch(turn: ChatTurn) {
    const live: LiveTurn = {
      taskId: turn.taskId,
      role: turn.role,
      handle: null,
      stopRequested: false,
      stop: null,
      finished: false,
      items: new Map(),
      permissions: new Map(),
      kinds: new Map(),
      answered: new Map(),
      calls: new Map(),
      policy: 'ask',
      grants: [],
      applied: { policy: 'ask', grants: [] },
      scratch: this.scratchDirectory(turn.taskId),
      mcp: false,
      secrets: [],
      google: false,
      steered: false,
      noticed: false,
      started: false,
      reported: 0,
      gone: new Set(),
      done: Promise.resolve(),
    };
    const early = this.stoppedEarly.get(turn.id);
    this.stoppedEarly.delete(turn.id);
    if (early) this.requestStop(live, early);
    this.live.set(turn.id, live);
    live.done = this.run(turn, live);
  }

  private async run(turn: ChatTurn, live: LiveTurn) {
    let result = await this.outcome(turn, live);
    // The thread stays busy until the provider's processes are gone. Whatever the adapter
    // reported, a process that will not exit makes the turn a failure.
    const left = await this.quiesce(live);
    if (left.length) result = { ...result, stopReason: 'error', failure: processFailure(left) };
    this.finish(turn.id, live, result, left);
  }

  private async outcome(turn: ChatTurn, live: LiveTurn): Promise<ChatTurnResult> {
    try {
      return await this.start(turn, live);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 2000) : 'Unknown error.';
      return {
        ...stoppedResult,
        stopReason: 'error',
        failure: chatFailure(
          live.handle
            ? {
                stage: 'stream',
                kind: 'client-exit',
                message: 'The provider connection failed during the turn.',
                providerMessage: reason,
              }
            : { stage: 'launch', kind: 'internal', message: `The turn could not start. ${reason}` },
        ),
      };
    }
  }

  /**
   * Prove every reported process group gone, and only ESRCH proves it. A group still present
   * gets SIGTERM, SIGKILL a second later, and one more second to exit. Returns what is left.
   */
  private async quiesce(live: Pick<LiveTurn, 'handle' | 'gone'>): Promise<number[]> {
    const signal = this.deps.signalGroup ?? signalGroup;
    const schedule = this.deps.schedule ?? defaultSchedule;
    for (const name of ['SIGTERM', 'SIGKILL'] as const) {
      const present = this.present(live);
      if (!present.length) return [];
      for (const group of present) signal(group, name);
      await new Promise<void>((resolve) => schedule(resolve, 1000));
    }
    return this.present(live);
  }

  /** Reported groups not yet seen absent. Once a group is seen absent, it stays gone for the turn. */
  private present(live: Pick<LiveTurn, 'handle' | 'gone'>): number[] {
    const absent = this.deps.groupAbsent ?? groupAbsent;
    return owned(live.handle?.groups ?? []).filter((group) => {
      if (live.gone.has(group)) return false;
      if (!absent(group)) return true;
      live.gone.add(group);
      return false;
    });
  }

  private async start(turn: ChatTurn, live: LiveTurn): Promise<ChatTurnResult> {
    // Yield after durable admission so Stop and reads can see the turn before work starts.
    await new Promise((resolve) => setImmediate(resolve));
    const adapter = this.deps.adapters.get(turn.selection.family);
    if (!adapter) throw Error('No adapter is registered for this provider.');
    if (turn.selection.family === 'google' && !this.deps.googleTermsAcknowledged())
      throw Error('Acknowledge the Google terms in Settings > Google before using Google.');
    if (this.closed || live.stopRequested) return stoppedResult;
    // The connection proves its mode again right before the adapter sends anything. A Disconnect,
    // a Forget or another mode since admission fails the turn unsent.
    const unready = this.unsent(turn);
    if (unready)
      return {
        ...stoppedResult,
        stopReason: 'error',
        failure: chatFailure({
          stage: 'launch',
          kind: 'signed-out',
          message: unready.message,
          nextAction: unready.next,
        }),
      };
    // A step of a scheduled run starts only under the loop's limit for its family (ADR
    // 0058). One that would not ends unsent on a usage limit, so its step stops, moves on or
    // posts the way a limit makes it, and every stop it causes carries the line that names it.
    const over = await this.overSchedule(turn);
    if (this.closed || live.stopRequested) return stoppedResult;
    if (over) this.keptBack.set(turn.id, `${over.message} ${over.next}`);
    if (over)
      return {
        ...stoppedResult,
        stopReason: 'limit',
        failure: chatFailure({
          stage: 'launch',
          kind: 'usage-limit',
          message: over.message,
          nextAction: over.next,
        }),
      };
    const request = this.request(turn);
    live.policy = request.permissionPolicy;
    live.grants = request.permissionGrants ?? [];
    live.applied = { policy: live.policy, grants: live.grants };
    live.scratch = request.scratch.directory;
    live.mcp = (request.mcp?.servers.length ?? 0) > 0;
    live.secrets = request.mcp?.secrets ?? [];
    live.google = live.mcp && turn.selection.family === 'google';
    // The first turn copies the project, which takes time. Stop may have arrived meanwhile.
    if (this.closed || live.stopRequested) return stoppedResult;
    this.record(turn, live, {
      type: 'turn.started',
      turnId: turn.id,
      family: turn.selection.family,
      model: turn.selection.model,
      effort: turn.selection.effort,
      role: turn.role,
    });
    if (request.threadTools === false) this.toolsDown(turn, live);
    for (const message of request.mcp?.notes ?? [])
      this.record(turn, live, {
        type: 'provider.notice',
        turnId: turn.id,
        level: 'info',
        message,
        trace: true,
      });
    // A secret of a server this turn started never reaches the thread, the trace or a prompt card.
    const secrets = request.mcp?.secrets ?? [];
    live.handle = adapter.startTurn(request, (event) =>
      this.record(turn, live, scrubSecrets(event, secrets)),
    );
    try {
      this.deps.store.transaction(() => this.saveGroups(turn.id, live));
    } catch {
      // The finish still proves the groups gone. Only a crash before then loses them.
    }
    if (this.closed || live.stopRequested) live.handle.stop();
    return live.handle.result;
  }

  /** Why a turn's connection can no longer run it, or null for one that can or has none. */
  private unsent(turn: ChatTurn): { message: string; next: string } | null {
    if (!turn.connectionId) return null;
    const connection = this.deps.store.connection(turn.connectionId);
    if (!connection)
      return {
        message: 'The connection this turn was assigned to is gone.',
        next: 'Pick a provider in the composer and send again.',
      };
    return this.unready(connection);
  }

  /**
   * The thread tools socket did not open, so this cloud turn runs without the tools. The thread
   * says so on every such turn, and the turn trace names the tools it lacks.
   */
  private toolsDown(turn: ChatTurn, live: LiveTurn) {
    try {
      this.deps.store.transaction(() =>
        this.appendEntry(this.task(turn.taskId) as Task, {
          kind: 'chat-system',
          author: { kind: 'system', turnId: turn.id },
          text: 'Thread tools are unavailable: the controller has no socket open for them. This turn runs without them.',
        }),
      );
    } catch {
      // The trace below still records it.
    }
    this.record(turn, live, {
      type: 'provider.notice',
      turnId: turn.id,
      level: 'info',
      message: THREAD_TOOLS_ABSENT,
      trace: true,
    });
  }

  /**
   * Save the groups a live turn has reported, so startup recovery can check them after a crash.
   * Adapters add a group when they spawn, so the list is saved again when it grows. Groups
   * already gone are left out.
   */
  private saveGroups(turnId: string, live: LiveTurn) {
    const reported = owned(live.handle?.groups ?? []);
    if (reported.length === live.reported) return;
    live.reported = reported.length;
    const turn = this.turn(turnId);
    if (!turn || !OPEN_STATES.has(turn.state)) return;
    this.putTurn(this.task(turn.taskId) as Task, withGroups(turn, this.present(live)));
  }

  private request(turn: ChatTurn): ChatTurnRequest {
    const task = this.task(turn.taskId);
    const project = task && this.deps.store.get<Project>('project', task.projectId);
    const root = task && this.deps.projectPath(task.projectId);
    if (!task || !project || !root) throw Error('The project is no longer registered.');
    const thread = this.ensureScratch(task, root);
    const message = this.findEntry(task.id, turn.userMessageId);
    if (message?.kind !== 'user-message' || !thread.base)
      throw Error('The message for this turn is missing.');
    // A plan slice works in its own copy and starts cold: no session, no packet.
    const lane = turn.slice !== undefined;
    const directory = this.plans.laneScratch(task, turn) ?? this.scratchDirectory(task.id);
    const prompt = withAttachments(message.text, message.attachments ?? [], directory, root);
    const history = this.history(task.id, message.cursor);
    const writer = writesScratch(turn.role);
    // A review or an opinion starts a fresh native session, so its brief always reaches the model.
    // So does a rerun of a message that already has a reply: the old session holds that reply.
    const fresh = writer && this.answeredBefore(turn);
    // Anthropic and Google read no history in a new session, so a rerun on the family that
    // answered carries the conversation before the message in a packet, as a handoff does.
    const rerun = fresh && !turn.handoffFrom;
    // An ask starts cold on any family, so the thread reaches it in the packet. So does an
    // orchestrator turn: it plans from the earlier plans and their slice results (H10).
    const asked = turn.role === 'ask';
    const planning = turn.role === 'orchestrator' && !lane;
    let carries = !!turn.handoffFrom || rerun || asked || planning;
    const family = turn.selection.family;
    // One answer per turn. The packet, the client's MCP config and the notice all follow it.
    // Local reads the thread through functions, and its adapter drops the line when it has no reader.
    const threadTools = family === 'local' || !this.deps.threadToolsDown?.();
    const pending = turn.handoffFrom ? this.pendingHandoff(task.id) : null;
    let reason: HandoffReason =
      pending?.reason ?? (asked ? 'ask' : planning ? 'plan' : rerun ? 'rerun' : 'manual');
    // A native session holds one model, so another model of the family starts a new session.
    const kept =
      writer && !fresh && !lane ? thread.sessions.find((value) => value.family === family) : null;
    let session =
      kept && this.sessionModel(task.id, kept, turn.sequence) === turn.selection.model
        ? kept
        : null;
    // A session dropped at the cap and never replaced, say because that turn failed, still needs
    // the full packet. The line about it was already written once.
    if (
      writer &&
      !fresh &&
      !carries &&
      !lane &&
      RESUMING.has(family) &&
      !thread.sessions.some((value) => value.family === family) &&
      this.droppedSession(task.id, family)
    ) {
      carries = true;
      reason = 'session';
    }
    // A new session reads the notes in its system context. A resumed session skips that context,
    // so its message carries them, only when they differ from what the session last received. The
    // block counts against the packet cap below, for the delta and for the full packet alike.
    const notes = this.deps.projectNotes?.(task.projectId) ?? [];
    this.notesSent.set(turn.id, notesDigest(notes));
    // A writing turn takes the rule set and the project's saved design system as they stand now.
    // The design brief joins the rules in a new session's system context and shares their budget.
    // A session that holds another set or another version keeps the old text in its system
    // instruction, so it gives way to a new one.
    const rules = writer ? resolveWritingRules(this.deps.writingRules?.()) : null;
    const design = writer ? deliveredDesign(this.deps.store, task.projectId) : null;
    const section = rules && (design ? `${rules.section}\n\n${design.brief}` : rules.section);
    if (section) fitWritingRules(section, notes);
    const stale =
      rules &&
      session &&
      this.staleSession(task.id, session, turn.sequence, rules.set.digest, design?.designSystem);
    if (stale) {
      session = null;
      carries = true;
      if (!turn.handoffFrom) reason = 'session';
      this.deps.store.transaction(() => {
        const current = this.thread(task.id);
        this.putThread(task, {
          ...current,
          sessions: current.sessions.filter((value) => value.family !== family),
        });
        this.appendEntry(task, {
          kind: 'chat-system',
          author: { kind: 'system', turnId: turn.id },
          text: stale,
        });
      });
    }
    // Saved quietly: the turn's own events carry the record to a reader once it runs. Every writing
    // turn with a delivered brief carries it, in the system context or in front of the message.
    if (rules) {
      const value = ChatTurnSchema.parse({
        ...(this.turn(turn.id) ?? turn),
        rules: rules.set,
        designSystem: design
          ? { ...design.designSystem, briefBytes: Buffer.byteLength(design.brief) }
          : null,
      });
      this.deps.store.db
        .prepare('UPDATE chat_turns SET body=? WHERE id=?')
        .run(canonicalJson(value), value.id);
    }
    let turnNotes = session ? turnNotesBlock(notes, session.notesDigest) : '';
    // Anthropic and Google resume without the system context, so the rules and the design brief go
    // in front of the message. An Anthropic or Google client can compact a long session and drop
    // its first message, and the controller does not track when that happens.
    if (section && session && (family === 'anthropic' || family === 'google'))
      turnNotes = [turnRulesBlock(section), turnNotes].filter(Boolean).join('\n\n');
    // The thread is the source of truth. A resumed session hears what happened since it last ran,
    // and a session that fell too far behind gives way to a new one with the full packet. Send now
    // keeps its full packet, which tells the model what the stopped reply left behind.
    const delta =
      session && RESUMING.has(family) && reason !== 'steer'
        ? this.delta(
            turn,
            message,
            session,
            root,
            thread.base,
            prompt,
            turn.handoffFrom ? reason : null,
            threadTools,
            turnNotes ? Buffer.byteLength(turnNotes) + 2 : 0,
          )
        : null;
    if (delta === 'over') {
      session = null;
      turnNotes = '';
      carries = true;
      if (!turn.handoffFrom) reason = 'session';
      // The saved session goes now, so a turn that fails here cannot bring the decision and its
      // line back on the next message.
      this.deps.store.transaction(() => {
        const current = this.thread(task.id);
        this.putThread(task, {
          ...current,
          sessions: current.sessions.filter((value) => value.family !== family),
        });
        this.appendEntry(task, {
          kind: 'chat-system',
          author: { kind: 'system', turnId: turn.id },
          text: droppedLine(family),
        });
      });
    }
    const caught = delta && delta !== 'over' ? delta : null;
    if (caught) carries = false;
    const files =
      caught?.files ?? this.turnFiles(task.id, message, carries, session ? family : null);
    const work = join(this.deps.home, 'chat', task.id, 'turns', turn.id);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    if (turn.handoffFrom) this.takeHandoff(task);
    const { policy: permissionPolicy, grants: permissionGrants } = launchPolicy(thread, turn.role);
    const body = carries
      ? this.packet(turn, {
          from: turn.handoffFrom ?? (asked ? (this.answeredOn(task.id) ?? family) : family),
          reason,
          root,
          base: thread.base,
          history,
          prompt,
          files,
          threadTools,
          directory,
          plan: planning && thread.plan ? planSummary(thread.plan) : null,
          reserve: turnNotes ? Buffer.byteLength(turnNotes) + 2 : 0,
        })
      : (caught?.prompt ?? prompt);
    const entry = this.deps
      .catalog(task.id)
      .families.find((value) => value.family === turn.selection.family);
    const connection = turn.connectionId ? this.deps.store.connection(turn.connectionId) : null;
    return {
      turnId: turn.id,
      taskId: task.id,
      role: turn.role,
      selection: turn.selection,
      // The credit switch and the allowance reading belong to the family's own route.
      ...(entry?.creditSpending === true && !connection ? { creditSpending: true } : {}),
      ...(connection
        ? {
            connection: {
              connectionId: connection.connectionId,
              billingMode: connection.billingMode,
              profileId: connection.profileId,
              proofGeneration: connection.proofGeneration,
            },
          }
        : {}),
      prompt: turnNotes ? `${turnNotes}\n\n${body}` : body,
      files,
      threadTools,
      systemContext: this.context(
        turn,
        project.name,
        directory,
        root,
        thread,
        history,
        notes,
        section ?? '',
      ),
      // The packet carries the transcript, so a turn with a packet sends no separate history. With a
      // delta, the history stops where the delta starts, for an adapter that has to start over.
      history: carries ? [] : (caught?.history ?? history),
      session,
      // The finish keeps a session only for a writer outside a plan slice. Every other turn's
      // session is never resumed.
      resumable: writer && !lane,
      title: task.title.slice(0, 80),
      scratch: { directory, base: thread.base, projectName: project.name },
      work: { directory: work, home: this.deps.home },
      permissionPolicy,
      // A reviewer or advisor reads only, so what the thread allowed does not reach it.
      permissionGrants,
      readOnly: !writer,
      ...(turn.slice === undefined ? {} : { slice: turn.slice }),
      subagents: turnAllowsSubagents(thread.crew, turn.role, turn.selection.family),
      allowanceLeft: connection ? null : this.allowanceLeft(task.id, turn.selection),
      // Decided with the thread tools above: the person's servers a turn starts follow this turn's
      // family and this policy, and never exceed it.
      mcp: this.deps.mcp?.compose({
        family,
        taskId: task.id,
        permissionPolicy,
        permissionGrants,
        readOnly: !writer,
      }),
      deadlineMs: TURN_DEADLINE_MS,
      environment: this.deps.resolveEnvironment(turn.selection.family),
      now: () => Date.parse(this.deps.now()),
    };
  }

  /** CrewKite's reading of the tightest window the turn's family and model run on, or null. */
  private allowanceLeft(taskId: string, selection: ChatModelSelection): number | null {
    try {
      const entry = this.deps
        .catalog(taskId)
        .families.find((value) => value.family === selection.family);
      return entry ? tightestAllowance(entry, selection.model).percent : null;
    } catch {
      return null;
    }
  }

  private ensureScratch(task: Task, root: string): ChatThread {
    const thread = this.thread(task.id);
    if (!thread.base) throw Error('The thread has no base commit.');
    // A thread from before the ref existed gets one on its next turn.
    if (thread.scratchReady) {
      this.pinBase(task, root, thread.base);
      return thread;
    }
    // A new thread's copy is named after the project, so a client that lists saved sessions by
    // folder shows the project name.
    const project = this.deps.store.get<Project>('project', task.projectId);
    const directory = claimScratchDirectory(this.deps.home, task.id, project?.name ?? '');
    // An interrupted copy leaves a partial directory that no turn has used yet.
    rmSync(directory, { recursive: true, force: true });
    const source = scratchPlan(root, thread.base);
    copyScratch(directory, source.files, source.links, {
      read: (files) => readPlannedBlobs(root, files as PlannedFile[]),
      stream: (file, target) => blobToFile(root, (file as PlannedFile).oid, target),
      checkout: { root, base: thread.base },
      name: basename(root),
      onProgress: (progress) => {
        try {
          this.deps.onImportProgress?.(task.id, progress);
        } catch {
          // A progress update that fails to send changes nothing about the copy.
        }
      },
    });
    this.pinBase(task, root, thread.base);
    // The thread record travels in every chat.thread event, so it keeps the first 64 entries and
    // the total. The first turn says once what the copy left out.
    const skipped = source.skipped.slice(0, 64);
    const total = source.skipped.length;
    const record = () => {
      if (total)
        this.appendEntry(task, {
          kind: 'chat-system',
          author: { kind: 'system', turnId: null },
          text: `The scratch copy skipped ${total.toLocaleString('en-US')} ${total === 1 ? 'entry' : 'entries'} it cannot hold, such as submodules and links that lead outside. Changes lists them.`,
        });
      return this.putThread(task, {
        ...this.thread(task.id),
        scratchReady: true,
        ...(total ? { skipped, skippedTotal: Math.min(total, 100_000) } : {}),
      });
    };
    // A recipe run makes the copy inside its own command, so it records in that transaction.
    return this.deps.store.inTransaction ? record() : this.deps.store.transaction(record);
  }

  /**
   * Keep the thread's base reachable from a ref of its own. A failed write leaves the thread
   * working, and the next turn or Accept writes it again.
   */
  private pinBase(task: Task, root: string, base: string) {
    try {
      writeThreadBaseRef(root, task.id, base);
    } catch {
      // The accepted branch or HEAD still holds the base until the person deletes it.
    }
  }

  private record(turn: ChatTurn, live: LiveTurn, value: AgentEvent, settling = false) {
    if (live.finished) return;
    const parsed = AgentEventSchema.safeParse(value);
    let event: AgentEvent;
    if (parsed.success && parsed.data.turnId === turn.id) event = parsed.data;
    else if (live.noticed) return;
    else {
      live.noticed = true;
      event = {
        type: 'provider.notice',
        turnId: turn.id,
        level: 'warning',
        message: 'The provider sent an update that could not be read. The reply may be incomplete.',
      };
    }
    if (event.type === 'turn.started') {
      // The service announces the turn with the requested effort. An adapter that learns the
      // effort the client actually runs at sends its own start, which corrects the badge only.
      if (live.started) {
        if (
          event.family !== turn.selection.family ||
          event.model !== turn.selection.model ||
          event.role !== turn.role ||
          event.effort === (live.effort ?? turn.selection.effort)
        )
          return;
        live.effort = event.effort;
      }
      live.started = true;
    }
    // The turn is complete when the service settles it, after its processes are proven gone.
    if (event.type === 'turn.completed' && !settling) return;
    addText(live.items, event);
    if (event.type === 'tool.started') {
      live.kinds.set(event.callId, event.kind);
      live.calls.set(event.callId, { title: event.title, input: event.input });
    }
    // The tool event names the kind when it comes first. When the ask comes first, the kind the
    // adapter put on the ask keeps a grant from depending on the order the client sends them.
    if (event.type === 'permission.requested' && event.kind && event.callId)
      if (!live.kinds.has(event.callId)) live.kinds.set(event.callId, event.kind);
    // An adapter knows when it answered on its own. An answer CrewKite sent for the person or for
    // the thread comes back without the field, and the thread still shows who gave it.
    if (event.type === 'permission.resolved') {
      const by = event.answeredBy ?? live.answered.get(event.requestId);
      live.answered.delete(event.requestId);
      if (by) event = { ...event, answeredBy: by };
    }
    if (event.type === 'permission.requested')
      live.permissions.set(event.requestId, {
        options: event.options,
        callId: event.callId,
        question: event.question,
        deletes: event.deletes === true,
      });
    if (event.type === 'permission.resolved') live.permissions.delete(event.requestId);
    try {
      this.deps.store.transaction(() => {
        const task = this.task(turn.taskId) as Task;
        this.deps.emit('agent.event', task.id, task.revision, event);
        if (event.type === 'permission.requested') this.setState(turn.id, 'waiting-permission');
        if (event.type === 'permission.resolved' && !live.permissions.size)
          this.setState(turn.id, 'running');
        if (event.type === 'permission.resolved' && !this.asking(task.id))
          this.observe(task.id, { kind: 'answered' });
        if (event.type === 'turn.stats') {
          const row = this.turn(turn.id);
          if (row && OPEN_STATES.has(row.state)) this.putTurn(task, { ...row, stats: event.stats });
        }
        this.saveGroups(turn.id, live);
      });
    } catch {
      // An adapter never sees controller failures. The turn result still settles the row.
    }
    // The thread is read at ask time, so a mode or policy changed during the turn applies to this
    // ask. Adapters register an ask before they emit it, so this answer finds it.
    if (event.type === 'permission.requested') {
      const covered = this.covered(this.thread(turn.taskId), live, event.requestId, true);
      if (covered) {
        live.permissions.delete(event.requestId);
        live.answered.set(event.requestId, covered.by);
        const respond = () =>
          this.call(() => live.handle?.respondPermission(event.requestId, covered.choice));
        // An ask emitted before startTurn returned has no handle yet. It has one a tick later.
        if (live.handle) respond();
        else queueMicrotask(respond);
      }
      // The person decides this one. An adapter that answers it on its own in the same tick
      // takes it off the open asks first, and then nothing is said.
      else {
        queueMicrotask(() => {
          if (!this.closed && !live.finished && live.permissions.has(event.requestId))
            this.observe(turn.taskId, { kind: 'asked', question: 'permission' });
        });
        this.notice(
          'approval-needed',
          turn.taskId,
          '',
          () => !live.finished && live.permissions.has(event.requestId),
        );
      }
    }
  }

  /**
   * The allow option CrewKite picks for an open ask, or null when the person decides. Balanced
   * answers edits inside the scratch copy and read-only commands, whatever the thread allows.
   * Otherwise a fresh ask the adapter's own policy covers is the adapter's to answer, so only a
   * thread policy that differs from it answers here. An ask still open after a change is
   * answered by the thread's policy alone: the adapter left it to the person. allow-edits covers
   * edits inside the scratch copy, allow-all every ask with an allow option except an edit
   * outside the copy. Network access and asks during read-only turns always go to the person.
   */
  private covered(
    thread: ChatThread,
    live: LiveTurn,
    requestId: string,
    fresh: boolean,
  ): { choice: string; by: 'flight-mode' | 'policy' } | null {
    const open = live.permissions.get(requestId);
    const allow =
      open?.options.find((option) => option.kind === 'allow-once') ??
      open?.options.find((option) => option.kind === 'allow-thread');
    if (!open || !allow || !writesScratch(live.role)) return null;
    const balanced = thread.flightMode === 'balanced';
    const policy = thread.permissionPolicy;
    const call = live.calls.get(open.callId ?? '');
    const kind = live.kinds.get(open.callId ?? '');
    // A call the kinds do not name may be a server's. Its policy was cut at launch and a looser
    // thread policy set since does not raise it.
    if (live.google || (live.mcp && (kind === undefined || kind === 'other'))) return null;
    const words = `${open.question}\n${call?.title ?? ''}`;
    if (/\bnetwork\b/i.test(words)) return null;
    const scratch = live.scratch;
    // Balanced and Glide run a read-only command inside the scratch copy without asking, on every
    // family and under every policy. Other commands follow the policy.
    const mode = { choice: allow.id, by: 'flight-mode' } as const;
    const policed = { choice: allow.id, by: 'policy' } as const;
    if (thread.flightMode !== 'manual' && kind === 'command')
      if (readOnlyCommand(call?.input, scratch)) return mode;
    if (balanced) {
      // A delete or move is marked by the adapter from the client's own change type.
      if (kind === 'edit') return !open.deletes && editsInside(call?.input, scratch) ? mode : null;
      return null;
    }
    if (fresh && policy === live.applied.policy) return null;
    if (kind === 'edit')
      return policy !== 'ask' && editsInside(call?.input, scratch) ? policed : null;
    return policy === 'allow-all' ? policed : null;
  }

  private finish(turnId: string, live: LiveTurn, raw: ChatTurnResult, left: number[]) {
    // The failure text can echo a server's argument or variable.
    const result = scrubSecrets(raw, live.secrets);
    const turn = this.turn(turnId);
    if (turn)
      this.record(
        turn,
        live,
        { type: 'turn.completed', turnId, stopReason: result.stopReason, failure: result.failure },
        true,
      );
    live.finished = true;
    this.live.delete(turnId);
    try {
      this.deps.onTurnEnded?.(turnId);
    } catch {
      // A token left open fails its next call once the client is gone. The turn settles anyway.
    }
    let seen = false;
    // An ask still open when the turn ends goes with it, stopped, failed or moved on a limit.
    const unanswered = live.permissions.size > 0;
    // The turn's own lines from its end come after this entry. Lines it wrote as it started do not.
    const before = turn ? this.newestSequence(turn.taskId) : 0;
    try {
      this.deps.store.transaction(() => {
        const end: Ending = {
          ...ending(result, live.items, left),
          effort: live.effort,
          // A turn the adapter never received cost nothing. One it did keeps its report, or else
          // stays unreported.
          spend: live.handle ? reportedSpend(result) : null,
        };
        if (end.state === 'stopped')
          end.stop = live.stop ?? (this.closed ? STOPS.restart : clientStop(result.failure));
        seen =
          !!turn &&
          turn.slice === undefined &&
          writesScratch(turn.role) &&
          RESUMING.has(turn.selection.family) &&
          end.session?.family === turn.selection.family &&
          OPEN_STATES.has(this.turn(turnId)?.state ?? 'done');
        this.settle(turnId, end);
        this.stepEnded(turnId);
        if (turn && unanswered && !this.asking(turn.taskId))
          this.observe(turn.taskId, { kind: 'answered' });
        // Send now: the queued message picks up where this reply stopped, with its packet. A
        // review or an opinion left nothing behind in the scratch copy to carry over.
        const next = turn && this.thread(turn.taskId).queued[0];
        const carries = live.steered && end.state !== 'done' && writesScratch(live.role);
        if (turn && next && carries && writesScratch(next.role))
          this.setHandoff(turn.taskId, { from: turn.selection.family, reason: 'steer' });
      });
    } catch {
      // The row stays open. Startup recovery fails it with a visible reason.
      this.keptBack.delete(turnId);
      return;
    }
    if (turn && seen) this.markSeen(turn);
    if (turn && !this.closed)
      try {
        this.deps.onTurnSettled?.(turn.selection.family, turn.taskId);
      } catch {
        // A usage read that fails to start changes nothing about the turn.
      }
    const moved =
      result.stopReason === 'limit' && !live.stopRequested && !this.closed
        ? this.continueOnLimit(turnId)
        : false;
    const stepped = turn && !this.closed ? this.advanceCrew(turnId) : false;
    if (turn && !this.closed) this.plans.settled(turnId);
    if (turn && !this.closed) this.endNotice(turnId, moved, stepped, before);
    if (turn && !this.closed) this.orchestratorEnded(turnId, moved, before);
    // A family freed here may let a waiting plan slice start in any thread.
    if (turn && !this.closed) this.plans.wake();
    // A handoff above opens the rerun first. The queue waits for that turn to settle. The family
    // is free now, so a thread that waited on it may start too. Send now starts its message even
    // when the queue is paused.
    if (turn && !this.closed && live.steered) this.continueQueue(turn.taskId, true);
    if (turn && !this.closed) this.wakeQueues();
    this.keptBack.delete(turnId);
  }

  /**
   * Start the first queued message of every free thread whose family is free, the thread that
   * has waited longest first, so one busy thread cannot keep a family to itself.
   */
  private wakeQueues() {
    const rows = this.deps.store.db
      .prepare(
        "SELECT task_id FROM chat_threads WHERE json_array_length(body,'$.queued')>0 ORDER BY json_extract(body,'$.queued[0].at'), task_id",
      )
      .all() as { task_id: string }[];
    for (const row of rows) this.continueQueue(row.task_id);
  }

  /**
   * The family a message would run on, when another thread has an open turn there. Null when it
   * can start now, or when its pick fails, so the refusal comes from the usual path.
   */
  private waitsOnFamily(
    task: Task,
    thread: ChatThread,
    message: Pick<Message, 'selection'>,
  ): ChatFamily | null {
    const selection = this.pick(task, thread, message.selection);
    if ('outcome' in selection) return null;
    const busy = this.deps.store.db
      .prepare(
        "SELECT 1 FROM chat_turns WHERE task_id<>? AND json_extract(body,'$.selection.family')=? AND json_extract(body,'$.state') IN ('queued','running','waiting-permission') LIMIT 1",
      )
      .get(task.id, selection.family);
    return busy ? selection.family : null;
  }

  private settle(turnId: string, end: Ending) {
    const notesSent = this.notesSent.get(turnId);
    this.notesSent.delete(turnId);
    const turn = this.turn(turnId);
    if (!turn || !OPEN_STATES.has(turn.state)) return;
    const task = this.task(turn.taskId) as Task;
    const reply = end.text.trim()
      ? this.appendEntry(task, {
          kind: 'chat-assistant',
          author: {
            kind: 'assistant',
            turnId: turn.id,
            family: turn.selection.family,
            model: turn.selection.model,
            role: turn.role,
            effort: end.effort ?? turn.selection.effort,
          },
          text: fitText(end.text, 262_144),
        })
      : null;
    this.putTurn(
      task,
      withGroups(
        {
          ...turn,
          state: end.state,
          endedAt: this.deps.now(),
          failure: end.failure,
          assistantMessageId: reply?.id ?? null,
          stopReason: end.stopReason,
          ...(end.stop ? { stopCause: end.stop.cause } : {}),
          ...(end.outputLimit ? { outputLimit: end.outputLimit } : {}),
          ...(turn.spend && end.spend !== undefined ? { spend: end.spend } : {}),
        },
        end.groups,
      ),
    );
    const thread = this.thread(task.id);
    // The session has now seen the thread up to this turn. Later turns on other families reach it
    // in a delta packet.
    // A plan slice's session ran in the slice's own copy, so the thread never resumes it.
    const session =
      writesScratch(turn.role) &&
      turn.slice === undefined &&
      end.session?.family === turn.selection.family
        ? {
            ...end.session,
            seenSequence: turn.sequence,
            // The notes this turn started with. A restart between the start and the end leaves none,
            // and the next turn then sends them again.
            ...(notesSent ? { notesDigest: notesSent } : {}),
          }
        : null;
    // Plan slices run side by side. The thread stays busy while any of its turns is open, except
    // a side question, which never holds the thread.
    const other = this.deps.store.db
      .prepare(
        "SELECT id FROM chat_turns WHERE task_id=? AND id<>? AND json_extract(body,'$.state') IN ('queued','running','waiting-permission') AND NOT (json_extract(body,'$.role')='ask' AND json_extract(body,'$.slice') IS NULL) ORDER BY sequence LIMIT 1",
      )
      .get(task.id, turn.id) as { id: string } | undefined;
    this.putThread(task, {
      ...thread,
      activeTurnId: thread.activeTurnId === turn.id ? (other?.id ?? null) : thread.activeTurnId,
      sessions: session
        ? [...thread.sessions.filter((value) => value.family !== session.family), session]
        : thread.sessions,
      // The next command or restart that finds every group gone clears this.
      ...(end.groups.length ? { ownershipUnknown: true } : {}),
    });
    // The provider's limit line is for a turn it received. A turn the schedule's limit kept back
    // was never sent, and its own line says why.
    if (end.stopReason === 'limit' && end.spend !== null)
      this.appendLimitLine(task, turn, end.failure);
    if (end.state === 'done' && this.allowanceSpent(turn))
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: turn.id },
        text: `${familyName[turn.selection.family]} reached its included allowance during this turn. Credit spending is off, so the next turn moves to another provider.`,
      });
    // Stop, Send now, the plan, a restart and the client all end a turn as stopped. The line says
    // which one, so a stop the person did not ask for never reads like one they did.
    if (end.stop)
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: turn.id },
        text: fitText(end.stop.line, 16_384),
      });
    if (end.outputLimit) {
      const count = (value: number) => value.toLocaleString('en-US');
      const { reasoningTokens, replyTokens, allowedTokens } = end.outputLimit;
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: turn.id },
        text: `Reply stopped at the output limit: ${count(reasoningTokens)} reasoning and ${count(replyTokens)} reply of ${count(allowedTokens)} allowed.`,
      });
    }
    if (end.failure)
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: turn.id },
        text: fitText(`${end.failure.message} ${end.failure.nextAction}`, 16_384),
      });
  }

  /**
   * The family's included allowance now reads used up and credit spending is off. No adapter
   * reports a charge, so this says only what the readings show. The gate runs before a turn, so
   * the turn ends and the next one moves.
   */
  private allowanceSpent(turn: ChatTurn): boolean {
    try {
      const entry = this.deps
        .catalog(turn.taskId)
        .families.find((value) => value.family === turn.selection.family);
      return !!entry && creditsPaused(entry, turn.selection.model);
    } catch {
      return false;
    }
  }

  private appendLimitLine(task: Task, turn: ChatTurn, failure: ChatFailure | null) {
    const resets = failure?.resetsAt
      ? `at ${new Date(failure.resetsAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : 'at an unknown time';
    this.appendEntry(task, {
      kind: 'chat-system',
      author: { kind: 'system', turnId: turn.id },
      text: `${familyName[turn.selection.family]} reached its usage limit. Resets ${resets}.`,
    });
  }

  /**
   * With auto handoff on, a limit stop moves the thread to the family with the most allowance
   * left and runs the same message there. The handoff opens the new turn, so both commit
   * together and a refusal leaves the thread where it was. Without a taker the person chooses
   * from the card.
   */
  private continueOnLimit(turnId: string): boolean {
    try {
      const turn = this.turn(turnId);
      const task = turn && this.task(turn.taskId);
      // A plan slice that reaches a limit fails, and the card runs it again.
      if (!turn || !task || turn.state !== 'failed' || turn.slice !== undefined) return false;
      // The person gave this role its connection, so nothing moves it to another one on its own.
      // The limit card still offers the switch.
      if (turn.connectionId) return false;
      const thread = this.thread(task.id);
      // A crew step reruns on its own and leaves the thread's pick alone. A fixer on the thread's
      // family moves the thread like the builder would.
      const own = writesScratch(turn.role) && thread.selection?.family === turn.selection.family;
      // The report turn is the plan's closing step, so it reruns like the challenge does.
      const step = (crewRole(thread) === turn.role && !own) || this.plans.isReportTurn(turn);
      // A person who already moved the thread has made the choice. A side question moves nothing.
      if (
        turn.role === 'ask' ||
        !thread.autoHandoff ||
        (!step && thread.selection?.family !== turn.selection.family)
      )
        return false;
      // One automatic move per message. The catalog can be stale, and a family it still shows
      // with allowance may stop on its limit too. A second move would bounce between them.
      if (this.movedOnLimit(turn, step)) {
        this.deps.store.transaction(() =>
          this.appendEntry(task, {
            kind: 'chat-system',
            author: { kind: 'system', turnId: turn.id },
            text: 'Automatic handoff already moved this message once. Pick a provider to continue.',
          }),
        );
        return false;
      }
      // A move of the thread's own pick sets where the builder runs next, so the builder's slot
      // counts too. A crew step rerun leaves the pick alone.
      const selection = this.nextFamily(
        task.id,
        turn.selection.family,
        step ? [turn.role] : [turn.role, 'assistant'],
      );
      if (!selection) return false;
      // A step the schedule's limit held back never reached its provider, so it moves with that
      // reason.
      const held = this.keptBack.has(turn.id) ? turn.selection.family : undefined;
      const effects: Effects = [];
      this.deps.store.transaction(() => {
        if (step) return this.rerunStep(task, turn, selection, effects, !!held);
        const moved = this.handoff({ taskId: task.id, selection, reason: 'limit' }, effects, held);
        if (moved.outcome !== 'applied' || effects.length === 0)
          throw Error('The thread could not move on.');
      });
      for (const effect of effects) this.call(effect);
      return true;
    } catch {
      // The limit line stands and the card in the thread still offers the switch.
      return false;
    }
  }

  /**
   * The notice for a turn the person started that is not a step of a chain or a plan. A builder's
   * or an orchestrator's done turn is decided where the chain, the gate or the plan decides what
   * follows it. A turn sent straight to the fixer, the reviewer, the advisor or the challenger
   * ends the work it was asked for. A stop the person, Send now, a plan or a restart caused says
   * nothing, and neither does a limit that moved the work to another family. `stepped` is true
   * when the chain took the turn as its own step. `before` is the thread's newest entry from
   * before the turn settled, so only a line it wrote as it ended is used.
   */
  private endNotice(turnId: string, moved: boolean, stepped: boolean, before: number) {
    const turn = this.turn(turnId);
    if (!turn || turn.slice !== undefined || stepped || moved) return;
    // The plan ends with the report turn and tells the listener itself.
    if (this.plans.isReportTurn(turn)) return;
    const builder = turn.role === 'assistant' || turn.role === 'orchestrator';
    if (!builder && !['fixer', 'reviewer', 'advisor', 'challenger'].includes(turn.role)) return;
    if (turn.state === 'done') {
      if (!builder) this.notice('finished', turn.taskId, '');
      return;
    }
    if (turn.state === 'stopped' && turn.stopCause !== 'client') return;
    this.notice(endedOnLimit(turn) ? 'limit' : 'failed', turn.taskId, this.endLine(turn, before));
  }

  /**
   * The first line the turn wrote as it ended: a system line by the turn after `before`, the
   * thread's newest entry from before it settled. Empty when it wrote none.
   */
  private endLine(turn: ChatTurn, before: number): string {
    const row = this.deps.store.db
      .prepare(
        "SELECT json_extract(body,'$.text') AS text FROM conversation_entries WHERE task_id=? AND sequence>? AND json_extract(body,'$.kind')='chat-system' AND json_extract(body,'$.author.turnId')=? ORDER BY sequence LIMIT 1",
      )
      .get(turn.taskId, before, turn.id);
    return (row?.text as string | undefined) ?? '';
  }

  /** The sequence of the thread's newest entry, or 0 when it has none. */
  private newestSequence(taskId: string): number {
    const row = this.deps.store.db
      .prepare('SELECT max(sequence) AS sequence FROM conversation_entries WHERE task_id=?')
      .get(taskId);
    return Number(row?.sequence ?? 0);
  }

  /**
   * Run a crew step that stopped on a limit again on another family, on the same message. `held`
   * says the schedule's limit held it back, which is then the reason given.
   */
  private rerunStep(
    task: Task,
    turn: ChatTurn,
    selection: ChatModelSelection,
    effects: Effects,
    held: boolean,
  ) {
    const thread = this.thread(task.id);
    if (thread.activeTurnId || !thread.base) throw Error('The step could not move on.');
    const from = turn.selection.family;
    const reason = held ? 'schedule' : 'limit';
    // A fixer on another family starts cold, so it gets the packet with the limit as the reason.
    if (writesScratch(turn.role)) this.setHandoff(task.id, { from, reason });
    this.appendEntry(task, {
      kind: 'chat-system',
      author: { kind: 'system', turnId: null },
      text: `Continued on ${familyName[selection.family]} from ${familyName[from]}. Reason: ${handoffReason(reason, from)}.`,
    });
    // Throwing rolls back the move, so a refused step leaves the limit line standing.
    const admission = this.openTurn(
      task,
      thread,
      { selection, role: turn.role, messageId: turn.userMessageId, base: thread.base },
      effects,
    );
    if (admission.outcome === 'refused') throw Error(admission.message);
    if (turn.role === 'challenger') this.challengeStarted(task.id);
    if (this.plans.isReportTurn(turn)) this.reportStarted(task.id);
  }

  /**
   * Move the crew chain on after a turn settles. A done builder turn in balanced or glide goes
   * through the after-write gate, then starts the chain when the crew has a reviewer. A done fix
   * goes through the gate too. A done step starts the next one. A queued Ask waits for the
   * chain to end. A message from the person,
   * a stop, a failure or a limit nobody moved on ends it with one line that says why. A rerun on
   * another family is already open when a limit moved the step, and the chain waits for it.
   */
  private advanceCrew(turnId: string): boolean {
    const effects: Effects = [];
    // The chain took this turn as its own step, so the chain says how the work ended.
    let stepped = false;
    try {
      this.deps.store.transaction(() => {
        const turn = this.turn(turnId);
        const task = turn && this.task(turn.taskId);
        // A plan slice runs its own review chain in its lane.
        if (!turn || !task || turn.slice !== undefined) return;
        const thread = this.thread(task.id);
        // A builder turn always starts a fresh chain, so a chain left mid-step by a failed write
        // never blocks the next one.
        const chain = thread.crewChain;
        if (!chain || turn.role !== crewRole(thread)) {
          if (turn.role !== 'assistant' || turn.state !== 'done') return;
          if (thread.activeTurnId) return;
          // Manual runs nothing after the builder, so its reply ends the work.
          if (thread.flightMode === 'manual') return this.notice('finished', task.id, '');
          const fresh = {
            builderTurnId: turn.id,
            step: 'review',
            reviewRounds: 0,
            fixes: 0,
            reason: null,
          } as const;
          // The person's message comes first. A crew with no reviewer has no chain to stop, and
          // the gate runs after the turn that message starts.
          if (sentMessage(thread))
            return hasReviewer(thread)
              ? this.stopCrew(task, thread, fresh, 'you sent a new message')
              : this.notice('finished', task.id, '');
          // A crew with a reviewer holds its fresh chain while the gate runs, so a restart in
          // between stops it with a line, the way it stops a chain waiting on any step. A Solo
          // builder gets a chain only once its gate sends work to the fixer or stops.
          if (this.hasGate(task, thread)) {
            const held = hasReviewer(thread)
              ? this.putThread(task, { ...thread, crewChain: fresh }).crewChain
              : chain;
            effects.push(() => this.openGate(task.id, { held, next: fresh }));
            return;
          }
          return this.goOn(task, thread, fresh, effects);
        }
        stepped = true;
        // A limit already opened the rerun on another family. Its own settle moves the chain on.
        if (thread.activeTurnId) return;
        if (sentMessage(thread))
          return this.stopCrew(task, thread, chain, 'you sent a new message');
        // A step the client ended on its own is a failure and says so. Any other stop was the
        // person's.
        if (turn.state === 'stopped')
          return turn.stopCause === 'client'
            ? this.stopCrew(task, thread, chain, 'the provider ended the turn', undefined, 'failed')
            : this.stopCrew(task, thread, chain, 'you stopped the reply');
        if (endedOnLimit(turn))
          return this.stopCrew(
            task,
            thread,
            chain,
            // A step the schedule's limit kept back was never sent, so its own line says why.
            this.keptBack.get(turn.id)?.replace(/\.$/, '') ??
              `${familyName[turn.selection.family]} reached its usage limit`,
            undefined,
            'limit',
          );
        if (turn.state !== 'done')
          return this.stopCrew(
            task,
            thread,
            chain,
            `the ${chain.step} failed`,
            undefined,
            'failed',
          );
        if (thread.flightMode === 'manual')
          return this.stopCrew(task, thread, chain, 'the thread is in manual mode');
        if (chain.step === 'fix') {
          const next = { ...chain, step: 'review', fixes: chain.fixes + 1 } as const;
          if (this.hasGate(task, thread)) {
            effects.push(() => this.openGate(task.id, { held: chain, next }));
            return;
          }
          return this.goOn(task, thread, next, effects);
        }
        if (chain.step === 'challenge') return this.finishCrew(task, thread, chain, effects);
        const review = turn.assistantMessageId
          ? this.findEntry(task.id, turn.assistantMessageId)?.text
          : undefined;
        const findings = review === undefined ? null : statedFindings(review);
        const reviewed = { ...chain, reviewRounds: chain.reviewRounds + 1 };
        if (findings === null)
          return this.stopCrew(
            task,
            thread,
            reviewed,
            'the review did not state its findings',
            'Ask for a fix or review again.',
            'failed',
          );
        if (findings > 0 && chain.fixes < MAX_FIXES && review)
          return this.crewStep(task, thread, { ...reviewed, step: 'fix' }, effects, review);
        return this.crewStep(task, thread, { ...reviewed, step: 'challenge' }, effects);
      });
    } catch (error) {
      // A chain left as it was reads as one that never opened, and anything that follows the
      // thread would wait for it. Stop it with a line, if the store still takes a write. The
      // person can still run each step from the thread.
      this.stopUnopened(turnId, error);
      return stepped;
    }
    for (const effect of effects) this.call(effect);
    return stepped;
  }

  /**
   * Stop the chain a turn would have moved on, after that move failed: the chain the turn was a
   * step of, or the one a done builder turn in a crew with a reviewer would have opened.
   */
  private stopUnopened(turnId: string, error: unknown) {
    try {
      this.deps.store.transaction(() => {
        const turn = this.turn(turnId);
        const task = turn && this.task(turn.taskId);
        if (!turn || !task || turn.slice !== undefined) return;
        const thread = this.thread(task.id);
        // stopCrew ends the line with its own period.
        const cause = `the next step could not start. ${plain(error).replace(/\.+$/, '')}`;
        // A builder turn always opens a fresh chain, so it stops its own, never an older one.
        if (turn.role === 'assistant') {
          if (turn.state === 'done' && thread.flightMode !== 'manual' && hasReviewer(thread))
            this.stopCrew(
              task,
              thread,
              { builderTurnId: turn.id, step: 'review', reviewRounds: 0, fixes: 0, reason: null },
              cause,
              undefined,
              'failed',
            );
          return;
        }
        const chain = thread.crewChain;
        if (chain && chain.step !== 'finished' && chain.step !== 'stopped')
          this.stopCrew(task, thread, chain, cause, undefined, 'failed');
      });
    } catch {
      // The store takes no write either. The thread shows what it last saved.
    }
  }

  /** Save the chain at this step and open its turn. A challenge with no challenger finishes. */
  private crewStep(
    task: Task,
    thread: ChatThread,
    chain: ChatCrewChain,
    effects: Effects,
    review?: string,
    brief?: string,
    shots?: { text: string; files: ChatAttachment[] },
  ) {
    const step = chain.step as CrewStep;
    const members = thread.crew?.members ?? [];
    const member = (role: string) => members.find((entry) => entry.role === role)?.selection;
    const selection =
      step === 'fix' ? (member('fixer') ?? member('builder')) : member(CREW_ROLES[step]);
    if (!selection && step === 'challenge') return this.finishCrew(task, thread, chain, effects);
    if (!selection)
      return this.stopCrew(
        task,
        thread,
        chain,
        `the crew has no ${CREW_ROLES[step]}`,
        undefined,
        'failed',
      );
    if (step === 'review' && !shots && this.startShots(task, thread, chain, effects)) return;
    const saved = this.putThread(task, { ...thread, crewChain: chain });
    // Design findings the person sent ride on the fixer's next turn, whatever brought it on.
    const design = step === 'fix' ? designFixerBrief(this.deps.store.designFindings(task.id)) : '';
    const text =
      step === 'review'
        ? [CREW_REVIEW, shots?.text].filter(Boolean).join('\n\n')
        : step === 'fix'
          ? [brief ?? fixerBrief(review ?? ''), design].filter(Boolean).join('\n\n')
          : (brief ?? CREW_CHALLENGE);
    const started = this.begin(
      task,
      saved,
      { text, role: CREW_ROLES[step], selection, attachments: [], files: shots?.files ?? [] },
      effects,
    );
    if (started.outcome !== 'applied')
      this.stopCrew(
        task,
        this.thread(task.id),
        chain,
        `the ${step} could not start`,
        started.next,
        'failed',
      );
    else if (step === 'challenge') this.challengeStarted(task.id);
  }

  /**
   * The project's declared preview and the brief its images are judged by, when a review would
   * shoot it. Its item is pinned to what the command ran when the person last allowed it in this
   * thread, or else to what it runs in the project's own folder, so a changed script asks.
   */
  private preview(
    task: Task,
  ): { declaration: DesignPreview; brief: string; item: ChatCheck } | null {
    try {
      const declaration = this.deps.previews?.declared(task.projectId);
      const brief = declaration && deliveredDesign(this.deps.store, task.projectId)?.brief;
      if (!declaration || !brief) return null;
      const { command } = declaration;
      const item: ChatCheck = {
        id: SHOTS_CHECK,
        label: SHOTS_LABEL,
        kind: 'custom',
        source: 'custom',
        command,
        resolved: command,
        enabled: true,
        pin: null,
      };
      const project = this.deps.projectPath(task.projectId);
      const pin = this.previewPins.get(task.id) ?? (project ? sourceDigest(item, project) : null);
      return { declaration, brief, item: { ...item, pin } };
    } catch {
      return null;
    }
  }

  /** The person allowed changed commands: pin what the checks and the preview run now. */
  private repin(task: Task) {
    this.checks.repin(task);
    const preview = this.preview(task);
    if (preview)
      this.previewPins.set(task.id, sourceDigest(preview.item, this.scratchDirectory(task.id)));
  }

  /**
   * What the checks' question shows and an allow for the thread covers: the enabled checks, with
   * the design preview when a review would run it. One set for both, so a crew does not ask for
   * each in turn, and a change to any of their scripts asks once.
   */
  private askItems(
    task: Task,
    thread: ChatThread,
    preview = this.preview(task),
  ): readonly ChatCheck[] {
    return preview ? [...enabledChecks(thread), preview.item] : enabledChecks(thread);
  }

  /**
   * Before a review step, shoot the project's declared preview when it has one and a design system
   * to judge it by. The preview command runs only once the person allowed it, on the checks' own
   * question and approval, in every flight mode: it is a server the copy's own scripts start, so
   * Glide's command policy alone does not cover it. The chain waits at the review with no open
   * turn, the way it waits on checks, and the thread holds the copy until the preview has
   * stopped. True when the pass or its question was queued.
   */
  private startShots(task: Task, thread: ChatThread, chain: ChatCrewChain, effects: Effects) {
    const preview = this.preview(task);
    if (!preview) return false;
    // The question shows with the thread's checks, so a thread that never read them reads them now.
    const held = this.putThread(task, {
      ...thread,
      crewChain: chain,
      checks: thread.checks ?? this.checks.refresh(task, thread),
    });
    const assess = () => {
      const current = this.thread(task.id);
      return this.checks.assess(task, current, undefined, this.askItems(task, current, preview));
    };
    const assessed = assess();
    // The pass starts right after this transaction commits, in the same tick, so a rollback
    // leaves no entry holding the thread. An allow of changed checks pins them, as a run would.
    const go = (fx: Effects, repin: boolean, approve?: string) =>
      fx.push(() => {
        if (repin) this.repin(task);
        if (approve) this.checks.approve(task.id, approve);
        const abort = new AbortController();
        const entry = { abort, done: Promise.resolve() };
        this.shots.set(task.id, entry);
        entry.done = this.shoot(task, chain, preview.declaration, preview.brief, abort.signal);
      });
    const once = this.allowedOnce.get(task.id);
    this.allowedOnce.delete(task.id);
    if (
      !assessed.changed.length &&
      (held.checks?.approved === assessed.set ||
        (once?.write === chainWrite(chain) && once.seen === assessed.seen))
    ) {
      go(effects, false);
      return true;
    }
    // A deny skips this pass only. The checks keep their own question.
    this.raiseCheckAsk(task, held, 'after-write', assessed, assess, (answer, fx, asked) => {
      if (answer === 'allow' || answer === 'allow-thread')
        go(fx, asked.changed.length > 0, answer === 'allow-thread' ? asked.set : undefined);
      else
        fx.push(() =>
          this.shotsDone(task.id, chain, { status: answer === 'stop' ? 'stopped' : 'denied' }),
        );
    });
    return true;
  }

  private stopShots(taskId: string): boolean {
    const entry = this.shots.get(taskId);
    if (!entry) return false;
    entry.abort.abort();
    return true;
  }

  /**
   * The pass itself, outside any transaction, then back in with the images stored. It runs the
   * declaration the question showed, so an edit after the answer runs nothing it did not cover.
   * What Accept would publish is read before the preview starts and again after it stops. A
   * preview that changed it fails the pass, and its images reach no review.
   */
  private async shoot(
    task: Task,
    chain: ChatCrewChain,
    declaration: DesignPreview,
    brief: string,
    signal: AbortSignal,
  ) {
    const host: Partial<PreviewHost> = this.deps.previews ?? {};
    const began = this.deps.now();
    const failed = (
      reason: string,
      changed?: Pick<ChatCheckRun, 'changedPaths' | 'changedCount'>,
    ): ShotsEnd => ({ status: 'failed', reason, command: declaration.command, began, changed });
    let end: ShotsEnd;
    const staged: StagedFile[] = [];
    try {
      const root = this.deps.projectPath(task.projectId);
      const base = this.thread(task.id).base;
      if (!root || !base) throw Error('The project or its base commit is missing.');
      const directory = this.scratchDirectory(task.id);
      let changes: ReturnType<typeof watchCopy>;
      try {
        changes = watchCopy(root, base, directory);
      } catch {
        throw Error('CrewKite could not read the copy, so the preview did not run.');
      }
      const result = await captureViews(
        {
          start:
            host.start ??
            ownedPreview({
              store: this.deps.store,
              artifacts: this.deps.artifacts,
              home: this.deps.home,
              now: this.deps.now,
              launchIdentity: this.deps.launchIdentity,
              deadlineMs: this.deps.checkDeadlineMs,
              base: (taskId) => this.thread(taskId).base ?? null,
              taskRevision: (taskId) => this.task(taskId)?.revision ?? task.revision,
              projectPath: this.deps.projectPath,
              holdOwnership: (taskId) =>
                this.deps.store.transaction(() => {
                  const current = this.task(taskId);
                  if (current)
                    this.putThread(current, { ...this.thread(taskId), ownershipUnknown: true });
                }),
            }),
          capture: host.capture ?? playwrightCapture,
        },
        {
          taskId: task.id,
          projectId: task.projectId,
          directory,
          declaration,
          signal,
        },
      );
      // The preview has stopped, so the copy holds whatever it left.
      const changed = changes();
      if (signal.aborted) end = { status: 'stopped' };
      else if (changed) end = failed(PREVIEW_CHANGED, changed);
      else if (result.status === 'failed') end = failed(result.reason);
      else {
        for (const image of result.images)
          staged.push(
            await stageFile(this.filesFolder(task.id), {
              name: `${image.name}.png`,
              mimeType: 'image/png',
              base64: Buffer.from(image.bytes).toString('base64'),
            }),
          );
        end = {
          status: 'captured',
          text: screenshotBrief(
            result.images.map((image) => image.name),
            brief,
          ),
          staged,
        };
      }
    } catch (error) {
      for (const item of staged) dropStaged(item);
      end = failed(
        error instanceof Error ? error.message.slice(0, 300) : 'The preview check failed.',
      );
    }
    this.shotsDone(task.id, chain, end);
  }

  /**
   * The pass ended. A failure is one failed step with the thread's checks, and a denied command
   * is one line. Either way the review runs as it would have without images: the screenshots
   * start no fix of their own. Findings the reviewer states go to the fixer through the chain's
   * own bounded path.
   */
  private shotsDone(taskId: string, chain: ChatCrewChain, end: ShotsEnd) {
    this.shots.delete(taskId);
    const effects: Effects = [];
    try {
      this.deps.store.transaction(() => {
        const task = this.task(taskId);
        if (!task || this.closed) return;
        const thread = this.thread(taskId);
        // A new builder turn or another step took the chain over while the preview ran.
        if (thread.activeTurnId || canonicalJson(thread.crewChain) !== canonicalJson(chain)) return;
        if (end.status === 'stopped')
          return this.stopCrew(task, thread, chain, 'you stopped the preview');
        if (sentMessage(thread))
          return this.stopCrew(task, thread, chain, 'you sent a new message');
        // The images go into place only now that the review takes them. The same page shot twice
        // gives the same bytes and the same key, and the first receipt stands.
        const files = end.status === 'captured' ? end.staged.map((item) => item.attachment) : [];
        if (end.status === 'captured')
          for (const item of end.staged) {
            placeFile(this.filesFolder(taskId), item);
            const file = item.attachment;
            if (!this.deps.store.receipt(fileKey(taskId, file)))
              this.deps.store.saveReceipt(fileKey(taskId, file), file.id, 'local-owner', {
                outcome: 'applied',
                data: { kind: 'chat-attachment', ...file },
              });
          }
        if (end.status === 'denied')
          this.appendEntry(task, {
            kind: 'chat-system',
            author: { kind: 'system', turnId: null },
            text: 'The design screenshots did not run. The preview command was not allowed.',
          });
        if (end.status === 'failed')
          this.recordCheckRun(taskId, {
            id: `chk_${randomBytes(16).toString('hex')}`,
            checkId: SHOTS_CHECK,
            label: SHOTS_LABEL,
            command: end.command.slice(0, 500),
            trigger: 'after-write',
            status: 'failed',
            reason: end.reason,
            ...end.changed,
            startedAt: end.began,
            durationMs: null,
            exitCode: null,
            tail: '',
            stdout: null,
            stderr: null,
          });
        // A pass that gave no images still counts as taken, so the review does not queue another.
        return this.crewStep(task, this.thread(taskId), chain, effects, undefined, undefined, {
          text: end.status === 'captured' ? end.text : '',
          files,
        });
      });
    } catch {
      // The chain stays where it was. The person can still run each step from the thread.
      return;
    } finally {
      // A pass the thread no longer wanted leaves no staged image behind. A placed one is gone
      // from its staging name already.
      if (end.status === 'captured') for (const item of end.staged) dropStaged(item);
    }
    for (const effect of effects) this.call(effect);
    if (!this.closed) this.wakeQueues();
  }

  /**
   * Run the thread's test command now, outside any crew step: the person's Run tests. It asks the
   * same question a crew run asks unless the thread already allows the command, runs in the
   * scratch copy, keeps the run with the thread's checks, writes one line with the result and
   * starts no turn. A turn, a plan step, a crew chain or another check run makes it wait.
   */
  runTests(payload: Payload<'RunChatTests'>, effects: Effects): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    // A process the hold cannot prove gone may still write the copy the tests would read.
    const { thread, left } = this.checkedThread(task);
    if (left.length) return ownershipUnknown(left);
    // Only a chain still on a step holds the thread. A finished or stopped chain stays on the
    // record for its history.
    if (thread.activeTurnId || this.plans.holds(thread) || crewRole(thread))
      return blocked('thread-busy', 'Run tests when the current turn or crew step has finished.');
    if (this.checksBusy(task.id))
      return blocked('checks-running', 'The project checks are already running.');
    const tests = (thread.checks?.items ?? []).filter((item) => item.kind === 'test');
    if (!tests.length)
      return blocked(
        'no-test-command',
        'No test command was found. Add one under Project checks, or read the project files again.',
      );
    const assess = () => this.checks.assess(task, thread, undefined, tests);
    const assessed = assess();
    const go = (fx: Effects, approve?: string) =>
      fx.push(() => {
        if (approve) this.checks.approve(task.id, approve);
        const entry = this.checks.reserve(task.id);
        this.checks.run(task.id, 'manual', undefined, entry, tests).then(
          (result) => this.testsDone(task.id, result),
          () => this.testsDone(task.id, null),
        );
      });
    if (!this.checksNeedAsk(thread, assessed)) {
      go(effects);
      return { outcome: 'applied' };
    }
    this.raiseCheckAsk(task, thread, 'manual', assessed, assess, (answer, fx, asked) => {
      if (answer === 'allow' || answer === 'allow-thread')
        go(fx, answer === 'allow-thread' ? asked.set : undefined);
      else
        fx.push(() =>
          this.testsDone(task.id, {
            outcome: answer === 'stop' ? 'stopped' : 'denied',
            runs: [],
            brief: null,
          }),
        );
    });
    return { outcome: 'applied' };
  }

  /**
   * Keep a run of a check the controller ran in process, such as the design check, with the
   * thread's checks. It runs inside the caller's transaction. A thread that never read its project
   * checks reads them now, so the list beside the run is not left empty.
   */
  recordCheckRun(taskId: string, run: ChatCheckRun) {
    const task = this.task(taskId);
    if (!task) return;
    const thread = this.thread(taskId);
    this.putThread(
      task,
      withRun({ ...thread, checks: thread.checks ?? this.checks.refresh(task, thread) }, run),
    );
  }

  /** One line with the result of Run tests. The run itself is already with the thread's checks. */
  private testsDone(taskId: string, result: ChecksOutcome | null) {
    try {
      this.deps.store.transaction(() => {
        const task = this.task(taskId);
        if (!task || this.closed) return;
        const text = !result
          ? 'The tests could not run.'
          : result.outcome === 'passed' || result.outcome === 'failed'
            ? testsLine(result.outcome, result.runs)
            : result.outcome === 'denied'
              ? 'The tests did not run. The command was not allowed.'
              : result.outcome === 'stopped'
                ? 'The tests were stopped.'
                : 'No test command ran.';
        this.appendEntry(task, {
          kind: 'chat-system',
          author: { kind: 'system', turnId: null },
          text,
        });
      });
    } catch {
      // A thread deleted mid-run has nowhere to show the line.
    }
    if (!this.closed) this.wakeQueues();
  }

  /** The thread waits on a check question, runs checks or holds an Accept, so no turn may start. */
  private checksBusy(taskId: string): boolean {
    return (
      this.checkAsk.has(taskId) ||
      this.checks.running(taskId) ||
      this.shots.has(taskId) ||
      this.accepting(taskId)
    );
  }

  /**
   * A check runs in the scratch copy or waits on its question, or an Accept holds the thread, so
   * nothing may publish or change the copy.
   */
  checksInCopy(taskId: string): boolean {
    return this.copyChecked(taskId) || this.accepting(taskId);
  }

  /**
   * Why the person may not prepare one of the thread's copies now, or null when they may.
   * Preparing removes the copy's node_modules and copies them again, so it waits while anything
   * may run in a copy of this thread: a turn, a crew step, a plan, a process an earlier turn left
   * behind, a check or its question, or an Accept. Runs in a transaction: the check for a left
   * process lifts the thread's hold once every one is gone.
   */
  preparationRefusal(taskId: string): CommandResult | null {
    const task = this.task(taskId);
    if (!task) return blocked('task-not-found');
    const { thread, left } = this.checkedThread(task);
    if (thread.activeTurnId || crewRole(thread) || this.plans.holds(thread))
      return blocked(
        'thread-busy',
        'Wait for the turn, crew step or plan to finish, then prepare the dependencies.',
      );
    if (left.length) return ownershipUnknown(left);
    return this.checksInCopy(taskId) ? changeCommands.checksRunning() : null;
  }

  /** A check runs in the copy or waits on its question. The plan's checks of the merged copy count. */
  private copyChecked(taskId: string): boolean {
    return this.checkAsk.has(taskId) || this.checks.open(taskId) || this.shots.has(taskId);
  }

  private dropCheckAsk(taskId: string) {
    this.checkAsk.delete(taskId);
    const task = this.task(taskId);
    const thread = this.thread(taskId);
    if (task && thread.checks?.ask)
      this.putThread(task, { ...thread, checks: { ...thread.checks, ask: null } });
  }

  /**
   * Whether the person must answer before these checks run. A check whose command or script
   * changed since it was turned on asks in every mode. Otherwise a command set the person
   * allowed for the thread runs. Failing that, Balanced asks as it does for a command outside the
   * read-only set, and Glide runs them when the thread's policy covers commands.
   */
  private checksNeedAsk(
    thread: ChatThread,
    assessed: Pick<ReturnType<ThreadChecks['assess']>, 'changed' | 'set'>,
  ): boolean {
    if (assessed.changed.length > 0) return true;
    if (thread.checks?.approved === assessed.set) return false;
    return thread.flightMode !== 'glide' || !commandsAllowed(thread);
  }

  /**
   * Put the question on the thread. The answer arrives as ResolveChatPermission. An allow covers
   * only what the question showed, so the copy is read again first. A command or script that
   * changed in between runs nothing, and a fresh question shows what would run now.
   */
  private raiseCheckAsk(
    task: Task,
    thread: ChatThread,
    trigger: ChatCheckRun['trigger'],
    assessed: ReturnType<ThreadChecks['assess']>,
    reassess: () => ReturnType<ThreadChecks['assess']>,
    settle: (
      answer: CheckAnswer,
      effects: Effects,
      asked: ReturnType<ThreadChecks['assess']>,
    ) => void,
    again = false,
  ) {
    const requestId = `chkask_${randomBytes(16).toString('hex')}`;
    this.checkAsk.set(task.id, {
      requestId,
      settle: (answer, effects) => {
        if (answer === 'allow' || answer === 'allow-thread') {
          const now = reassess();
          if (now.seen !== assessed.seen)
            return this.raiseCheckAsk(
              task,
              this.thread(task.id),
              trigger,
              now,
              reassess,
              settle,
              true,
            );
        }
        settle(answer, effects, assessed);
      },
    });
    this.observe(task.id, { kind: 'asked', question: 'checks' });
    // A question the work waits on: after a writing turn, a plan's lane or merge, or before the
    // screenshots. Run tests and Accept ask the person who just pressed them. The same question
    // shown again after a change was already said once.
    if (!again && trigger !== 'manual' && trigger !== 'accept')
      this.notice(
        'approval-needed',
        task.id,
        '',
        () => this.checkAsk.get(task.id)?.requestId === requestId,
      );
    const current = thread.checks;
    if (!current) return;
    this.putThread(task, {
      ...thread,
      checks: {
        ...current,
        ask: {
          requestId,
          trigger,
          commands: assessed.commands,
          changed: assessed.changed,
        },
      },
    });
  }

  /** A writing turn has a gate: an enabled check, or a saved design system to read the copy by. */
  private hasGate(task: Task, thread: ChatThread): boolean {
    return (
      enabledChecks(thread).length > 0 ||
      (!!this.deps.designCheck && !!this.deps.store.designSystem(task.projectId))
    );
  }

  /**
   * The gate after a writing turn: the thread's enabled checks one after another in its copy, then
   * the design check when the project saved a design system. It opens right after the turn's
   * transaction commits, in the same tick, so nothing starts in between. The dependency copy is
   * read first and outside any transaction, since a read that finds it stale marks it so. A copy
   * that needs preparing is prepared first, the way a plan's and an Accept's are, under a
   * reservation that holds the thread and that Stop marks. A preparation that fails, is
   * unsupported or finds the copy stale stops the chain with its line and runs nothing. The
   * checks ask first when the thread needs an answer, on one question with the preview, and the
   * copy is read again once the answer is in. The chain waits with no open turn meanwhile. A
   * restart stops a chain left there like any other chain left mid-step. A Solo builder's gate
   * holds no chain, so a restart leaves only its check runs, which recovery settles.
   */
  private openGate(taskId: string, gate: Gate) {
    const ready = this.dependencyCopy(taskId, 'thread', taskId);
    const task = this.task(taskId);
    const directory = this.scratchDirectory(taskId);
    const prepare =
      !!task &&
      !this.closed &&
      enabledChecks(this.thread(taskId)).length > 0 &&
      this.needsPreparing(taskId, 'thread', taskId, directory, ready) &&
      !this.deps.store.transaction(() => this.checkedThread(task).left.length);
    if (!prepare) return this.startGate(taskId, gate, ready);
    const entry = this.checks.reserve(taskId);
    void this.prepareCopy(taskId, 'thread', taskId, ready).then((now) => {
      this.checks.release(entry);
      if (this.closed) return;
      if (entry.stopped)
        return this.gateDone(taskId, gate, { outcome: 'stopped', runs: [], brief: null }, null);
      this.startGate(taskId, gate, now);
    });
  }

  /** The gate once its dependency copy is read, and prepared when it needed it. */
  private startGate(taskId: string, gate: Gate, ready: PreparedEnvironment | undefined) {
    const effects: Effects = [];
    try {
      this.deps.store.transaction(() => {
        const task = this.task(taskId);
        if (!task || this.closed) return;
        const { thread, left } = this.checkedThread(task);
        // Each stop here is a failure the person did not cause.
        const stop = (cause: string, then?: string) =>
          this.stopCrew(task, thread, gate.next, cause, then, 'failed');
        // A process the turn left may still write the copy, so nothing reads or runs in it yet.
        if (left.length) return stop('a process from the last turn may still be running');
        if (!enabledChecks(thread).length)
          return this.gateEnded(
            task,
            gate.next,
            { outcome: 'none', runs: [], brief: null },
            effects,
          );
        if (ready && !ready.ok) return stop('the checks could not run', ready.message);
        const assess = () => {
          const current = this.thread(taskId);
          return this.checks.assess(task, current, undefined, this.askItems(task, current));
        };
        const assessed = assess();
        // The stamp is taken once the answer is in, so an allow that pins or approves the set is
        // not a change. The copy may have gone stale while the question waited.
        const go = (fx: Effects, repin: boolean, approve?: string) =>
          fx.push(() => {
            if (repin) this.repin(task);
            if (approve) this.checks.approve(taskId, approve);
            const now = this.dependencyCopy(taskId, 'thread', taskId);
            if (now && !now.ok) return this.gateDone(taskId, gate, null, null, now.message);
            const stamp = this.gateStamp(task, now);
            const entry = this.checks.reserve(taskId);
            this.checks.run(taskId, 'after-write', undefined, entry).then(
              (result) => this.gateDone(taskId, gate, result, stamp),
              () => this.gateDone(taskId, gate, null, stamp),
            );
          });
        if (!this.checksNeedAsk(thread, assessed)) {
          go(effects, false);
          return;
        }
        this.raiseCheckAsk(task, thread, 'after-write', assessed, assess, (answer, fx, asked) => {
          if (answer === 'allow')
            this.allowedOnce.set(taskId, { write: chainWrite(gate.next), seen: asked.seen });
          if (answer === 'allow' || answer === 'allow-thread')
            go(fx, asked.changed.length > 0, answer === 'allow-thread' ? asked.set : undefined);
          else
            fx.push(() =>
              this.gateDone(
                taskId,
                gate,
                { outcome: answer === 'stop' ? 'stopped' : 'denied', runs: [], brief: null },
                null,
              ),
            );
        });
      });
    } catch {
      // The chain stays where it was. The person can still run each step from the thread.
      return;
    }
    for (const effect of effects) this.call(effect);
  }

  /**
   * Run the enabled checks on the thread copy after a plan merged a slice into it. The same
   * question comes first when the thread needs one. `denied` means the person said no. Each run
   * names the slice that merged.
   */
  runCombinedChecks(taskId: string, directory: string, slice?: number): Promise<PlanChecks> {
    return this.planChecks(
      taskId,
      directory,
      slice === undefined ? undefined : { slice, lane: false },
    );
  }

  /**
   * The checks a plan runs: a slice's gate in its own copy after its builder or fixer turn, when
   * `at` is a lane, or the checks of the thread copy after a merge. Each run names its slice. They
   * run the way the gate after a writing turn does: never while a process an earlier turn left
   * may still write, outside Manual, in a current dependency copy, after the same question, one
   * after another and fifteen minutes in all. A copy whose dependencies are not ready, or whose
   * own manifest or lockfile moved since they were prepared, is prepared here first, the slice's
   * or the thread's. A preparation that fails, is unsupported or finds the copy stale stops it
   * with its line. The mode and the copy are read again once the question is answered. The entry
   * is reserved first, so the plan's stop reaches a preparation or a question too. A result that
   * the checks, the policy, a grant taken away or the dependency copy moved under comes back
   * held, since it no longer says anything about the copy.
   */
  private async planChecks(
    taskId: string,
    directory: string,
    at?: { slice: number; lane: boolean },
  ): Promise<PlanChecks> {
    if (this.closed) throw new Error('The chat service is closed.');
    const task = this.task(taskId);
    if (!task) throw new Error('No thread has that task.');
    const end = (outcome: 'none' | 'denied' | 'stopped') =>
      ({ outcome, runs: [], brief: null }) as const;
    const held = (cause: string, runs: ChecksOutcome['runs'] = []) =>
      ({ outcome: 'held', cause, runs, brief: null }) as const;
    if (!enabledChecks(this.thread(taskId)).length) return end('none');
    if (this.deps.store.transaction(() => this.checkedThread(task).left.length))
      return held('a process from the last turn may still be running');
    const scope: DependencyPreparation['scope'] = at?.lane ? 'lane' : 'thread';
    const key = at?.lane ? String(at.slice) : taskId;
    const trigger = at?.lane ? 'after-write' : 'combined';
    const entry = this.checks.reserve(taskId, true, false, at?.slice);
    // Manual runs nothing on its own, and a copy that is not ready runs nothing either.
    const heldBy = (copy: PreparedEnvironment | undefined) =>
      this.thread(taskId).flightMode === 'manual'
        ? held('the thread is in manual mode')
        : copy && !copy.ok
          ? held(`the checks could not run. ${copy.message}`)
          : null;
    try {
      let ready = this.dependencyCopy(taskId, scope, key);
      if (this.needsPreparing(taskId, scope, key, directory, ready))
        ready = await this.prepareCopy(taskId, scope, key, ready);
      if (entry.stopped) return end('stopped');
      const before = heldBy(ready);
      if (before) return before;
      const assess = () => {
        const current = this.thread(taskId);
        return this.checks.assess(task, current, directory, this.askItems(task, current));
      };
      const assessed = assess();
      if (this.checksNeedAsk(this.thread(taskId), assessed)) {
        if (this.checkAsk.has(taskId)) return end('denied');
        const [answer, asked] = await new Promise<
          [CheckAnswer, ReturnType<ThreadChecks['assess']>]
        >((resolve) =>
          this.deps.store.transaction(() =>
            this.raiseCheckAsk(
              task,
              this.thread(taskId),
              trigger,
              assessed,
              assess,
              (answer, _effects, asked) => resolve([answer, asked]),
            ),
          ),
        );
        if (answer === 'allow-thread') this.checks.approve(taskId, asked.set);
        if (answer !== 'allow' && answer !== 'allow-thread')
          return end(answer === 'stop' ? 'stopped' : 'denied');
        // The mode or the copy may have moved while the question waited.
        ready = this.dependencyCopy(taskId, scope, key);
        const answered = heldBy(ready);
        if (answered) return answered;
      }
      const where = { directory, scope, key };
      const stamp = this.gateStamp(task, ready, where);
      // Another slice's turn may add a grant while these run. Only one taken away moves them.
      const grants = this.thread(taskId).permissionGrants ?? [];
      const result = await this.checks.run(taskId, trigger, directory, entry);
      if (result.outcome === 'stopped' || result.runs.some((run) => run.status === 'unknown'))
        return result;
      const after = this.dependencyCopy(taskId, scope, key);
      const kept = this.thread(taskId).permissionGrants ?? [];
      if (
        stamp === this.gateStamp(task, after, where) &&
        grants.every((kind) => kept.includes(kind))
      )
        return result;
      return held(
        after && !after.ok
          ? `the dependencies changed while the checks ran. ${after.message}`
          : 'the checks or their permissions changed while they ran',
        result.runs,
      );
    } finally {
      this.checks.release(entry);
    }
  }

  /** Stop a plan's runs, in a slice's copy or on the merged copy. Only the plan calls it. */
  stopCombinedChecks(taskId: string): boolean {
    return this.checks.stopCombined(taskId);
  }

  /**
   * The gate's checks ended, so every process they started is proven gone or holds the thread.
   * A check whose process may still run, a stop, a message from the person, a switch to Manual,
   * and checks, permissions or a dependency copy that moved while they ran each stop the chain
   * with no repair. In the last case the result no longer says anything about the copy as it is.
   * `refused` is the line of a dependency copy that was not ready once the question was answered,
   * so nothing ran.
   */
  private gateDone(
    taskId: string,
    gate: Gate,
    result: ChecksOutcome | null,
    stamp: string | null,
    refused?: string,
  ) {
    // A read that finds the copy stale marks it so, so it runs before the transaction opens.
    const ready = stamp === null ? undefined : this.dependencyCopy(taskId, 'thread', taskId);
    const effects: Effects = [];
    try {
      this.deps.store.transaction(() => {
        const task = this.task(taskId);
        if (!task || this.closed) return;
        const thread = this.thread(taskId);
        // A new builder turn or another step took the chain over while the checks ran.
        if (thread.activeTurnId || canonicalJson(thread.crewChain) !== canonicalJson(gate.held))
          return;
        // A stop the person caused says nothing to the notice listener. The rest are failures.
        // Each leaves the gate with no result that stands.
        const stop = (cause: string, then?: string, asked = false) => {
          this.gated(taskId, gate.next, 'unknown');
          this.stopCrew(task, thread, gate.next, cause, then, asked ? undefined : 'failed');
        };
        if (refused) return stop('the checks could not run', refused);
        if (!result) return stop('the checks could not run');
        if (result.outcome === 'stopped') return stop('you stopped the checks', undefined, true);
        // The thread already holds until a later check finds the process gone.
        if (result.runs.some((run) => run.status === 'unknown'))
          return stop('a check process may still be running');
        if (sentMessage(thread)) return stop('you sent a new message', undefined, true);
        if (thread.flightMode === 'manual')
          return stop('the thread is in manual mode', undefined, true);
        if (stamp !== null && stamp !== this.gateStamp(task, ready))
          return ready && !ready.ok
            ? stop('the dependencies changed while the checks ran', ready.message)
            : stop('the checks or their permissions changed while they ran');
        this.gateEnded(task, gate.next, result, effects);
      });
    } catch {
      // The chain stays where it was. The person can still run each step from the thread.
      return;
    }
    for (const effect of effects) this.call(effect);
    if (!this.closed) this.wakeQueues();
  }

  /**
   * What the gate found. The design check reads the copy now, after the commands, and its run
   * joins theirs. A failure goes to the fixer while fixes remain and the fixer has something to
   * work from: the failed commands' output, or design findings, which ride on the fix the way the
   * person's own sends do. An open finding with a reason is a draft the person is saving into the
   * system, so it stays theirs.
   */
  private gateEnded(task: Task, next: ChatCrewChain, result: ChecksOutcome, effects: Effects) {
    const line = (text: string) =>
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text,
      });
    const design = this.gateDesign(task);
    if (result.outcome === 'denied')
      line('The project checks did not run. The commands were not allowed.');
    const named = (status: 'passed' | 'failed') =>
      result.runs.filter((run) => run.status === status).map((run) => run.label);
    const failed = [...named('failed'), ...(design?.failed ? [design.label] : [])];
    const passed = [...named('passed'), ...(design && !design.failed ? [design.label] : [])];
    const verdict = failed.length
      ? 'failed'
      : passed.length
        ? 'passed'
        : result.outcome === 'denied'
          ? 'unknown'
          : null;
    if (verdict) this.gated(task.id, next, verdict);
    if (failed.length) {
      const room = next.fixes < MAX_FIXES;
      const findings = this.deps.store.designFindings(task.id);
      const sendable = findings.filter((value) => value.state === 'open' && value.reason === null);
      const work =
        !!result.brief || !!sendable.length || findings.some((value) => value.state === 'sent');
      const said = `Checks failed: ${failed.join(', ')}.${
        !room
          ? ` They still fail after ${next.fixes} ${next.fixes === 1 ? 'fix' : 'fixes'}, so the chain goes on.`
          : work
            ? ' The fixer runs on their output.'
            : ' Nothing in them goes to the fixer, so the chain goes on.'
      }`;
      line(said);
      // The gate's verdict: the chain goes on with its checks failing, and its end says so.
      if (room && work) this.gateFails.delete(next.builderTurnId);
      else this.gateFails.set(next.builderTurnId, said);
      if (room && work) {
        const at = this.deps.now();
        for (const finding of sendable)
          this.deps.store.putDesignFinding({ ...finding, state: 'sent' }, task.projectId, at);
        return this.crewStep(
          task,
          this.thread(task.id),
          { ...next, step: 'fix' },
          effects,
          undefined,
          result.brief ?? '',
        );
      }
    } else {
      this.gateFails.delete(next.builderTurnId);
      if (passed.length) line(`Checks passed: ${passed.join(', ')}.`);
    }
    return this.goOn(task, this.thread(task.id), next, effects);
  }

  /**
   * The design check of a gate, when the project saved a design system. It runs in process and
   * keeps its run with the thread's checks as a run after the write. A check that could not read
   * the copy fails the gate.
   */
  private gateDesign(task: Task): { label: string; failed: boolean } | null {
    const result = this.deps.designCheck?.(task.id);
    if (!result || result.reason === 'design-system-not-found') return null;
    const run = this.thread(task.id).checks?.runs.findLast(
      (value) => value.checkId === DESIGN_CHECK_ID,
    );
    if (result.outcome !== 'applied' || !run) return { label: 'Design system', failed: true };
    this.recordCheckRun(task.id, { ...run, trigger: 'after-write' });
    return { label: run.label, failed: run.status !== 'passed' };
  }

  /**
   * A scope's dependency copy, read outside any transaction, since a read that finds it stale
   * marks it so in a transaction of its own. A read that throws counts as a copy that needs
   * preparing, so the caller stops with the preparation line and runs nothing in it.
   */
  private dependencyCopy(
    taskId: string,
    scope: DependencyPreparation['scope'],
    key: string,
  ): PreparedEnvironment | undefined {
    try {
      return this.deps.dependencies?.environment(taskId, scope, key);
    } catch {
      return { ok: false, reason: 'not-prepared', message: DEPENDENCIES_NEED_PREPARATION };
    }
  }

  /**
   * Whether a copy's own manifests or lockfile moved since its dependencies were prepared, as when
   * a fixer adds a package to a slice. The record keeps what the project held then, and a copy
   * that still matches it reads the same. A copy that cannot be read counts as moved.
   */
  private copyMoved(
    taskId: string,
    scope: DependencyPreparation['scope'],
    key: string,
    directory: string,
  ): boolean {
    const record = this.deps.store
      .dependencyPreparations(taskId)
      .find((value) => value.scope === scope && value.scopeKey === key);
    if (record?.state !== 'prepared') return false;
    try {
      const now = detectDependencies(directory, record.inputs.runtime, false).inputs;
      return staleReason(record.inputs, now) !== null;
    } catch {
      return true;
    }
  }

  /** A copy needs its dependencies prepared: they are not ready, or its own files moved since. */
  private needsPreparing(
    taskId: string,
    scope: DependencyPreparation['scope'],
    key: string,
    directory: string,
    ready: PreparedEnvironment | undefined,
  ): boolean {
    return !!ready && (!ready.ok || this.copyMoved(taskId, scope, key, directory));
  }

  /**
   * Prepare a copy's dependencies and read them again. It runs only when the copy needs it, so a
   * preparation that throws, finds no copy or is already under way leaves the copy not ready.
   * The old dependencies would make the checks fail for a reason that is not in the code. The
   * caller reserves its check entry first, so a stop meanwhile marks it, and reads that once
   * this ends.
   */
  private async prepareCopy(
    taskId: string,
    scope: DependencyPreparation['scope'],
    key: string,
    ready: PreparedEnvironment | undefined,
  ): Promise<PreparedEnvironment | undefined> {
    const prepared = await this.deps.dependencies?.prepare(taskId, scope, key).catch(() => null);
    if (prepared && prepared !== 'busy') return this.dependencyCopy(taskId, scope, key);
    if (!ready?.ok) return ready;
    return { ok: false, reason: 'not-prepared', message: DEPENDENCIES_NEED_PREPARATION };
  }

  /**
   * What a gate's result stands on: the enabled checks, what they run in the copy, the flight mode
   * and permissions they run under, and the copy's dependencies. The copy is the thread's unless a
   * plan names a slice's copy or the merged one. A plan's stamp leaves the thread's grants out:
   * another slice's turn may add one while its checks run, and planChecks holds them only when one
   * they started with is gone.
   */
  private gateStamp(
    task: Task,
    ready: PreparedEnvironment | undefined,
    plan?: { directory: string; scope: DependencyPreparation['scope']; key: string },
  ): string {
    const thread = this.thread(task.id);
    const items = enabledChecks(thread);
    const { seen } = this.checks.assess(task, thread, plan?.directory, items);
    const scope = plan?.scope ?? 'thread';
    const key = plan?.key ?? task.id;
    const copy = this.deps.store
      .dependencyPreparations(task.id)
      .find((record) => record.scope === scope && record.scopeKey === key);
    const permissions = plan ? { ...thread, permissionGrants: [] } : thread;
    return hashCanonical({
      commands: commandsDigest(permissions, items, seen),
      dependencies: !ready ? null : ready.ok ? (copy ?? null) : ready.reason,
    });
  }

  /**
   * After a writing turn and its gate the chain goes on to the review. A crew with no reviewer
   * ends here, and says so once its gate sent work to the fixer.
   */
  private goOn(task: Task, thread: ChatThread, next: ChatCrewChain, effects: Effects) {
    if (hasReviewer(thread)) return this.crewStep(task, thread, next, effects);
    if (next.fixes) return this.finishCrew(task, thread, next, effects);
    // With no fix the builder's own reply was the work. Its gate decides how it ended.
    const failing = this.gateFails.get(next.builderTurnId);
    this.gateFails.delete(next.builderTurnId);
    this.notice(failing === undefined ? 'finished' : 'failed', task.id, failing ?? '');
  }

  private finishCrew(task: Task, thread: ChatThread, chain: ChatCrewChain, effects: Effects) {
    this.putThread(task, { ...thread, crewChain: { ...chain, step: 'finished', reason: null } });
    // After the last slice of a plan the plan's own line closes the crew. A report run's plan
    // opens the turn that writes the report instead.
    if (this.plans.finished(task, effects)) return;
    const rounds = `${chain.reviewRounds} review ${chain.reviewRounds === 1 ? 'round' : 'rounds'}`;
    const fixes = `${chain.fixes} ${chain.fixes === 1 ? 'fix' : 'fixes'}`;
    const text = `Crew finished: ${rounds}, ${fixes}.`;
    this.appendEntry(task, { kind: 'chat-system', author: { kind: 'system', turnId: null }, text });
    // The chain went on past checks its last gate still found failing, so the work did not pass.
    const failing = this.gateFails.delete(chain.builderTurnId);
    this.notice(failing ? 'failed' : 'finished', task.id, text);
  }

  /**
   * `outcome` is what the stop means for the work: a failure the person did not cause, or a usage
   * limit nothing moved on. A stop the person, a restart or a mode switch caused has none and
   * says nothing to the notice listener.
   */
  private stopCrew(
    task: Task,
    thread: ChatThread,
    chain: ChatCrewChain,
    cause: string,
    next?: string,
    outcome?: 'failed' | 'limit',
  ) {
    const reason = `${cause[0].toUpperCase()}${cause.slice(1)}.`;
    const planned = thread.plan?.phase === 'running';
    this.gateFails.delete(chain.builderTurnId);
    this.putThread(task, { ...thread, crewChain: { ...chain, step: 'stopped', reason } });
    // A slice's chain that stops stops its plan. The slices left show not run.
    this.plans.halt(task, cause);
    const text = `Crew stopped: ${cause}.${next ? ` ${next}` : ''}`;
    this.appendEntry(task, { kind: 'chat-system', author: { kind: 'system', turnId: null }, text });
    // The plan's line is this one, so the plan ends with it.
    if (planned)
      this.observe(task.id, {
        kind: 'plan-ended',
        outcome: outcome ? 'failed' : 'stopped',
        line: text,
        findings: null,
      });
    if (outcome) this.notice(outcome, task.id, text);
  }

  /**
   * True when this turn reran a message that an earlier turn left on a usage limit. A crew step
   * rerun carries no handoff mark, so for a step any earlier limit on the message counts.
   */
  private movedOnLimit(turn: ChatTurn, step = false): boolean {
    if (!turn.handoffFrom && !step) return false;
    return this.deps.store.db
      .prepare(
        "SELECT body FROM chat_turns WHERE task_id=? AND sequence<? AND json_extract(body,'$.userMessageId')=?",
      )
      .all(turn.taskId, turn.sequence, turn.userMessageId)
      .some((row) => endedOnLimit(ChatTurnSchema.parse(JSON.parse(row.body as string))));
  }

  private newestTurn(taskId: string): ChatTurn | undefined {
    const row = this.deps.store.db
      .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence DESC LIMIT 1')
      .get(taskId);
    return row ? ChatTurnSchema.parse(JSON.parse(row.body as string)) : undefined;
  }

  /**
   * The newest turn, when it ended on a usage limit and the person has written nothing since. A
   * side question runs beside the thread and is never its work, so neither its turn nor its
   * question counts here.
   */
  private stoppedOnLimit(taskId: string): ChatTurn | undefined {
    const side = "json_extract(body,'$.role')='ask' AND json_extract(body,'$.slice') IS NULL";
    const row = this.deps.store.db
      .prepare(
        `SELECT body FROM chat_turns WHERE task_id=? AND NOT (${side}) ORDER BY sequence DESC LIMIT 1`,
      )
      .get(taskId);
    const turn = row ? ChatTurnSchema.parse(JSON.parse(row.body as string)) : undefined;
    if (!turn || !endedOnLimit(turn)) return;
    const newest = this.deps.store.db
      .prepare(
        `SELECT id FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='user-message'
        AND id NOT IN (SELECT json_extract(body,'$.userMessageId') FROM chat_turns WHERE task_id=? AND ${side})
        ORDER BY sequence DESC LIMIT 1`,
      )
      .get(taskId, taskId);
    return newest?.id === turn.userMessageId ? turn : undefined;
  }

  /** Run the stopped message again on the provider the thread just moved to. No new entry is written. */
  private resend(task: Task, stopped: ChatTurn, effects: Effects): ChatAdmission | undefined {
    const thread = this.thread(task.id);
    const message = this.findEntry(task.id, stopped.userMessageId);
    if (message?.kind !== 'user-message' || !thread.selection || !thread.base) return;
    const admission = this.openTurn(
      task,
      thread,
      { selection: thread.selection, role: stopped.role, messageId: message.id, base: thread.base },
      effects,
    );
    if (admission.outcome !== 'refused') this.plans.reportRerun(task, stopped, effects);
    return admission;
  }

  /** Write the user message and open its turn. A new message and a queued one start the same way. */
  private begin(
    task: Task,
    thread: ChatThread,
    input: Message,
    effects: Effects,
    id?: string,
    slice?: number,
    line?: string,
  ): CommandResult {
    const selection = this.pick(task, thread, input.selection);
    if ('outcome' in selection) return selection;
    const base = thread.base ?? this.head(task);
    if (!base)
      return blocked('project-head-unavailable', 'Commit once in this project, then send again.');
    const message = this.draftEntry(task, userEntry(input), id);
    if (!message) return blocked('message-too-large', 'Shorten the message or attach fewer paths.');
    // A send that no provider can take is refused before its message is saved, so sending it
    // again later stores it once.
    const refused = this.refusal(task, selection, input.role, slice);
    if (refused?.outcome === 'refused') {
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text: `${refused.message} ${refused.next}`,
      });
      return admitted(refused);
    }
    // A line about this turn, such as a slice start, goes ahead of its message so the thread
    // shows it before the turn's output.
    if (line)
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text: fitText(line, 16_384),
      });
    this.saveEntry(task, message);
    const admission = this.openTurn(
      task,
      thread,
      { selection, role: input.role, messageId: message.id, base, slice },
      effects,
    );
    return { ...admitted(admission), revision: task.revision };
  }

  private pick(
    task: Task,
    thread: ChatThread,
    wanted: ChatModelSelection | undefined,
  ): ChatModelSelection | CommandResult {
    const selection = wanted
      ? this.deps.resolveSelection(task.id, wanted)
      : ((thread.selection && this.deps.resolveSelection(task.id, thread.selection)) ??
        this.deps.resolveSelection(task.id));
    if (!selection)
      return wanted
        ? blocked('selection-unavailable', 'Pick a provider and model in the composer.')
        : blocked('no-eligible-provider', 'Connect a provider in Settings, then send again.');
    if (selection.family === 'google' && !this.deps.googleTermsAcknowledged())
      return blocked(
        'google-terms-not-acknowledged',
        'Acknowledge the Google terms in Settings > Google before using Google.',
      );
    if (!this.deps.adapters.has(selection.family))
      return blocked('provider-unavailable', 'Connect this provider in Settings or pick another.');
    return selection;
  }

  /**
   * Keep a message until the thread is free. It joins the conversation when its turn starts, under
   * the ID it gets here. An assistant message keeps its own pick only when it differs from the
   * thread's, so a handoff while it waits carries it to the new provider.
   */
  private enqueue(task: Task, input: Message): CommandResult {
    const thread = this.thread(task.id);
    const selection = this.pick(task, thread, input.selection);
    if ('outcome' in selection) return selection;
    const draft = this.draftEntry(task, userEntry(input));
    if (!draft) return blocked('message-too-large', 'Shorten the message or attach fewer paths.');
    const own = input.role !== 'assistant' || !sameSelection(selection, thread.selection);
    const queued = [
      ...thread.queued,
      {
        id: draft.id,
        at: draft.at,
        text: input.text,
        role: input.role,
        attachments: input.attachments,
        files: input.files,
        ...(own ? { selection } : {}),
      },
    ];
    // The thread record travels in every chat.thread event, and an event must fit one frame.
    if (queued.length > QUEUE_LIMIT || size(queued) > QUEUE_BYTES)
      return blocked('queue-full', 'Wait for a queued message to start, or remove one.');
    this.putThread(task, { ...thread, queued });
    return { outcome: 'applied', revision: task.revision };
  }

  /** Start the oldest queued message. A refusal writes nothing, so the message keeps its place. */
  private startQueued(task: Task, effects: Effects): CommandResult {
    const thread = this.thread(task.id);
    const [first, ...rest] = thread.queued;
    if (!first) return { outcome: 'applied' };
    return this.begin(
      task,
      withQueue(thread, rest),
      this.plans.route(thread, first),
      effects,
      first.id,
    );
  }

  /**
   * Start the next queued message once the thread is free. A failed newest turn holds the queue:
   * on a usage limit the next message would stop on the same limit, and after a sign-out or a
   * launch failure eight queued messages would be eight failures. Continuing from the card reruns
   * the stopped message and the queue moves once that turn settles, and a new send starts the
   * oldest queued message right away. A send that waited on a family busy in another thread
   * came after the failure too, so the queue moves when that family frees. A leftover process
   * holds the queue until a later check finds it gone. A turn that startup recovery failed
   * does not hold it: the reply died with the controller, not on a limit or a sign-in, so the
   * messages queued before the restart start once the thread is free. A queue Stop paused starts
   * nothing until the person picks Send now on a message.
   */
  private continueQueue(taskId: string, sendNow = false) {
    const effects: Effects = [];
    try {
      this.deps.store.transaction(() => {
        const task = this.task(taskId);
        const thread = this.thread(taskId);
        if (!task || this.queueHeld(task, thread, sendNow)) return;
        if (this.waitsOnFamily(task, thread, this.plans.route(thread, thread.queued[0]))) return;
        const started = this.startQueued(task, effects);
        if (started.outcome !== 'applied')
          this.appendEntry(task, {
            kind: 'chat-system',
            author: { kind: 'system', turnId: null },
            text: [
              'The first queued message did not start.',
              started.next,
              'Remove it to let the next one go.',
            ]
              .filter(Boolean)
              .join(' '),
          });
      });
    } catch {
      // The queue stays as it was. The next send or a restart tries again.
      return;
    }
    for (const effect of effects) this.call(effect);
  }

  /** Whether the queue keeps its first message waiting by the rules above. */
  private queueHeld(task: Task, thread: ChatThread, sendNow = false): boolean {
    if (
      !thread.queued.length ||
      (thread.queuePaused && !sendNow) ||
      thread.activeTurnId ||
      thread.ownershipUnknown ||
      this.checksBusy(task.id) ||
      this.plans.holds(thread)
    )
      return true;
    const newest = this.newestTurn(task.id);
    const sentAfter = newest?.endedAt && (thread.queued.at(-1)?.at ?? '') > newest.endedAt;
    return (
      !!newest &&
      (newest.state === 'failed' || endedOnLimit(newest)) &&
      !failedByRestart(newest.failure) &&
      !sentAfter
    );
  }

  /**
   * The refusal openTurn would give: an assigned connection that cannot run the turn now, or a
   * credit-paused family with no provider to move to.
   */
  private refusal(
    task: Task,
    selection: ChatModelSelection,
    role: ChatTurn['role'],
    slice: number | undefined,
  ): ChatAdmission | null {
    const reports = this.reportRefusal(task.id, role);
    if (reports) return reports;
    const connection = this.route(task.id, role, selection.family);
    if (connection) return this.unready(connection);
    if (slice !== undefined || !this.creditsPausedOn(task.id, selection, role)) return null;
    if (role !== 'ask' && this.nextFamily(task.id, selection.family, [role])) return null;
    return {
      outcome: 'refused',
      reason: 'credits-paused',
      message: `${familyName[selection.family]} is out of included allowance and credit spending is off.`,
      next: 'Turn credit spending on in Settings or pick another provider.',
    };
  }

  /** Open a running turn on a saved user message. The launch waits for the command to commit. */
  private openTurn(
    task: Task,
    thread: ChatThread,
    input: {
      selection: ChatModelSelection;
      role: ChatTurn['role'];
      messageId: string;
      base: string;
      /** A plan slice's lane: the turn leaves the thread's pick, handoff and sessions alone. */
      slice?: number;
    },
    effects: Effects,
  ): ChatAdmission {
    const { selection, role, messageId, base, slice } = input;
    const reports = this.reportRefusal(task.id, role);
    if (reports) {
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text: `${reports.message} ${reports.next}`,
      });
      return reports;
    }
    // A connection the person assigned to this role or thread runs the turn, on the mode its
    // client last proved, or the turn does not start. It never moves to another connection.
    const connection = this.route(task.id, role, selection.family);
    const unready = connection && this.unready(connection);
    if (unready) {
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text: `${unready.message} ${unready.next}`,
      });
      return unready;
    }
    // The person turned credit spending off and the included allowance is used up. The turn
    // starts on the next family, the way a limit stop moves on, and a side question gets
    // the line. A plan slice keeps its lane, and its own limit failure hands it on.
    if (slice === undefined && this.creditsPausedOn(task.id, selection, role)) {
      const next = role === 'ask' ? null : this.nextFamily(task.id, selection.family, [role]);
      if (!next) {
        const message = `${familyName[selection.family]} is out of included allowance and credit spending is off.`;
        const hint = 'Turn credit spending on in Settings or pick another provider.';
        this.appendEntry(task, {
          kind: 'chat-system',
          author: { kind: 'system', turnId: null },
          text: `${message} ${hint}`,
        });
        return { outcome: 'refused', reason: 'credits-paused', message, next: hint };
      }
      if (writesScratch(role))
        this.setHandoff(task.id, { from: selection.family, reason: 'limit' });
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text: `Continued on ${familyName[next.family]} from ${familyName[selection.family]}. Reason: ${handoffReason('limit', selection.family)}.`,
      });
      const moved = this.openTurn(
        task,
        this.thread(task.id),
        { ...input, selection: next },
        effects,
      );
      return moved.outcome === 'started'
        ? { outcome: 'handed-on', turnId: moved.turnId, from: selection.family, to: next.family }
        : moved;
    }
    // A reviewer or advisor borrows another model. The thread keeps its own choice and any switch
    // still waiting for the next answer.
    const own = writesScratch(role) && slice === undefined;
    const pending = own ? this.pendingHandoff(task.id) : null;
    let handoffFrom: ChatFamily | null = null;
    // Sending on the provider the thread came from cancels the switch. After Send now the same
    // provider still needs to hear what the stopped reply left behind.
    if (pending && pending.from === selection.family && pending.reason !== 'steer')
      this.setHandoff(task.id, null);
    else if (pending) handoffFrom = pending.from;
    // A family picked in the composer starts cold too, so the switch is a manual handoff. A
    // cancelled switch says nothing about which family answered last, so the check still runs.
    if (own && !handoffFrom) handoffFrom = this.switchedFrom(task.id, selection.family);
    const sequence = this.nextSequence(task.id);
    // Another model of the same family starts a new native session with the full packet, through
    // the path a family switch takes, and the thread says why. An effort change alone resumes.
    const session = thread.sessions.find((value) => value.family === selection.family);
    const before =
      own && !handoffFrom && session && RESUMING.has(selection.family)
        ? this.sessionModel(task.id, session, sequence)
        : null;
    if (before && before !== selection.model) {
      handoffFrom = selection.family;
      this.setHandoff(task.id, { from: selection.family, reason: 'model' });
      const name = familyName[selection.family];
      // The picker's labels, the names with their versions, name the models. An ID the catalog
      // does not list, such as one typed in, shows as itself.
      const models = this.deps
        .catalog(task.id)
        .families.find((entry) => entry.family === selection.family)?.models;
      const label = (model: string) =>
        models?.find((entry) => entry.model === model)?.label ?? model;
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text: `Continued on ${name} (${label(selection.model)}) from ${name} (${label(before)}). Reason: ${handoffReason('model', selection.family)}.`,
      });
    }
    const turn = ChatTurnSchema.parse({
      id: this.deps.id('trn'),
      taskId: task.id,
      sequence,
      role,
      selection,
      userMessageId: messageId,
      assistantMessageId: null,
      state: 'running',
      startedAt: this.deps.now(),
      endedAt: null,
      failure: null,
      handoffFrom,
      ...(slice === undefined ? {} : { slice }),
      // An API turn counts as unreported from the start, so a crash or a silent client never
      // leaves it reading as free.
      ...(connection
        ? {
            connectionId: connection.connectionId,
            spend: connection.billingMode === 'api' ? UNREPORTED : null,
          }
        : {}),
    });
    this.putTurn(task, turn);
    if (this.deps.launchIdentity)
      this.deps.store.recordLaunchIdentity(
        'chat-turn',
        turn.id,
        this.deps.launchIdentity,
        turn.startedAt,
      );
    // A fixer runs on the crew's pick, so the thread keeps the person's own. Plan slices run side
    // by side, and the thread names one of them as its running turn. A side question runs beside
    // and never becomes the running turn. An orchestrator answers in place of the builder, so a
    // thread with no pick yet takes the crew builder: the composer then offers the builder for
    // the next message, not a catalog default.
    const builder = thread.crew?.members.find((member) => member.role === 'builder')?.selection;
    // A turn that runs for the thread ends the wait: the stopped message is no longer the last.
    const { startAt: _waiting, ...running } = thread;
    const waited = role === 'ask' && slice === undefined ? thread : running;
    this.putThread(task, {
      ...waited,
      base,
      selection:
        role === 'assistant' && slice === undefined
          ? selection
          : role === 'orchestrator' && slice === undefined
            ? (thread.selection ?? builder ?? null)
            : thread.selection,
      activeTurnId:
        role === 'ask' && slice === undefined
          ? thread.activeTurnId
          : slice !== undefined && thread.activeTurnId
            ? thread.activeTurnId
            : turn.id,
    });
    effects.push(() => this.launch(turn));
    return { outcome: 'started', turnId: turn.id };
  }

  /** The family of the last assistant turn, when it differs from the one about to answer. */
  private switchedFrom(taskId: string, family: ChatFamily): ChatFamily | null {
    const last = this.answeredOn(taskId);
    return last !== family ? last : null;
  }

  /** The family of the last turn that wrote. A reviewer or advisor borrows a model and does not count. */
  private answeredOn(taskId: string): ChatFamily | null {
    const row = this.deps.store.db
      .prepare(
        "SELECT body FROM chat_turns WHERE task_id=? AND json_extract(body,'$.role') IN ('assistant','fixer') ORDER BY sequence DESC LIMIT 1",
      )
      .get(taskId);
    return row ? ChatTurnSchema.parse(JSON.parse(row.body as string)).selection.family : null;
  }

  /**
   * Whether a turn on this selection would spend credits the person turned off. Local never
   * pauses. Nor does an assigned connection: the catalog reads only the family's own route.
   */
  private creditsPausedOn(taskId: string, selection: ChatModelSelection, role: ChatRole): boolean {
    if (this.route(taskId, role, selection.family)) return false;
    try {
      const entry = this.deps
        .catalog(taskId)
        .families.find((value) => value.family === selection.family);
      return !!entry && creditsPaused(entry, selection.model);
    } catch {
      return false;
    }
  }

  /**
   * The first family in the shared ranking with an adapter and a usable model. The model is the
   * one this thread last ran on that family, else the person's default for it in Settings, else
   * the client's own default. The family that stopped, any family at zero, any family whose
   * credits are paused and any family where one of `roles` would run on an API connection never
   * qualify: a limit never moves work onto API billing (ADR 0056). A move that changes the
   * thread's pick names the builder's role too, since the builder runs there next.
   */
  private nextFamily(
    taskId: string,
    stopped: ChatFamily,
    roles: readonly ChatRole[],
  ): ChatModelSelection | null {
    const turns = [...this.turns(taskId)].reverse();
    const pick = (entry: ChatCatalogRead['families'][number]) => {
      const listed = (model: string | undefined) =>
        model && entry.models.some((value) => value.model === model) ? model : undefined;
      const used = turns.find(
        (turn) => turn.selection.family === entry.family && listed(turn.selection.model),
      );
      const chosen = this.deps.familyModel?.(entry.family) ?? null;
      const model =
        listed(used?.selection.model) ??
        listed(chosen?.model) ??
        entry.defaultModel ??
        entry.models[0]?.model;
      return { model, used, chosen };
    };
    // Rank on the model that will run. Another model's window must not drop or reorder a family.
    const ranked = rankFamilies(
      this.deps.catalog(taskId).families,
      [stopped],
      (entry) => pick(entry).model ?? null,
      this.thread(taskId).handoffMode,
      Date.parse(this.deps.now()),
    );
    for (const entry of ranked) {
      if (!this.deps.adapters.has(entry.family)) continue;
      if (entry.family === 'google' && !this.deps.googleTermsAcknowledged()) continue;
      if (roles.some((role) => this.route(taskId, role, entry.family)?.billingMode === 'api'))
        continue;
      const { model, used, chosen } = pick(entry);
      if (
        !model ||
        creditsPaused(entry, model) ||
        this.scheduleVerdict(taskId, entry.family, model)
      )
        continue;
      const effort =
        model === used?.selection.model
          ? used.selection.effort
          : model === chosen?.model && chosen.effort
            ? chosen.effort
            : entry.models.find((value) => value.model === model)?.defaultEffort;
      const selection = this.deps.resolveSelection(taskId, {
        family: entry.family,
        model,
        effort: effort ?? 'default',
      });
      if (selection) return selection;
    }
    return null;
  }

  /**
   * How a schedule's limit reads for one family on this thread, or null when it lets a turn start
   * there. Only the thread of a run a schedule started is checked, whatever that run's state, and
   * never on Local. A family with no current reading, one above its limit and one the budget sets
   * no limit for all refuse. Each member reads the window that limits its own model.
   */
  private scheduleVerdict(taskId: string, family: ChatFamily, model: string) {
    if (family === 'local') return null;
    const run = this.deps.store.recipeRunOf(taskId);
    if (run?.origin !== 'schedule') return null;
    const budget = this.deps.store.recipeVersion(run.recipeId, run.version)?.recipe.budget;
    let families: ChatCatalogRead['families'] = [];
    try {
      families = this.deps.catalog(taskId).families;
    } catch {
      // No catalog means no reading, which refuses.
    }
    const verdict = judge(
      memberReading(family, model, families),
      budget?.maxUsedPercent[family],
      this.deps.now(),
    );
    return verdict.kind === 'ok' ? null : verdict;
  }

  /**
   * Why this turn may not start under a schedule's limit, named by the step it runs, or null. The
   * rule covers every plan step and crew step on the thread of a run a schedule started, whatever
   * the run's state and whichever plan the step belongs to: the plan, each slice's build, review,
   * fix and merge fix, the challenge and the report. A turn the person sends themselves, such as a
   * message, a side question or a turn sent straight to a crew role, is never checked. A reading
   * the rule cannot use is read once more, through the refresh a start at reset makes, and judged
   * again.
   */
  private async overSchedule(turn: ChatTurn): Promise<{ message: string; next: string } | null> {
    const step = this.scheduleStep(turn);
    if (!step) return null;
    const { taskId, selection } = turn;
    let verdict = this.scheduleVerdict(taskId, selection.family, selection.model);
    if (verdict?.kind === 'unknown' && this.deps.refreshUsage) {
      await this.deps.refreshUsage(selection.family).catch(() => {});
      verdict = this.scheduleVerdict(taskId, selection.family, selection.model);
    }
    return verdict ? turnRefusal(step, verdict) : null;
  }

  /**
   * The step a turn runs for a plan or a crew chain, as a scheduled run's line names it, or null
   * for a turn the person sent. A slice step carries its slice. The report turn answers the
   * message the plan card names, on whichever provider it runs, so a report moved to another
   * provider is still the report. The challenge is the challenger's turn at the crew's challenge
   * step. The plan's own turn answers the run's request or a message that opens with the plan's
   * retry line. The stored records cannot tell that retry from the same words queued by the
   * person, so such a message is checked as the plan: the rule errs toward checking. A later
   * message the person sends to the orchestrator is theirs, and the slices of the plan it proposes
   * are steps again. A review or a fix outside a slice has no step name, and a scheduled thread
   * only reaches one through a turn the person sent.
   */
  private scheduleStep(turn: ChatTurn): string | null {
    const slice = turn.slice;
    const thread = this.thread(turn.taskId);
    if (slice !== undefined) {
      if (turn.role === 'reviewer') return `The review of slice ${slice}`;
      if (turn.role !== 'fixer') return `Slice ${slice}`;
      const lane = thread.plan?.slices.find((value) => value.id === slice)?.lane?.step;
      return lane === 'resolve' ? `The merge fix for slice ${slice}` : `The fix for slice ${slice}`;
    }
    if (this.plans.isReportTurn(turn)) return 'The report';
    if (turn.role === 'challenger' && crewRole(thread) === 'challenger') return 'The challenge';
    if (turn.role !== 'orchestrator') return null;
    const first = this.deps.store.db
      .prepare(
        "SELECT id FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='user-message' ORDER BY sequence LIMIT 1",
      )
      .get(turn.taskId)?.id;
    const text = this.findEntry(turn.taskId, turn.userMessageId)?.text ?? '';
    return first === turn.userMessageId || text.startsWith(PLAN_RETRY) ? 'The plan' : null;
  }

  /** The connection a turn of this role on this family runs on, or null for the family's own route. */
  private route(taskId: string, role: ChatRole, family: ChatFamily): Connection | null {
    return routeFor(
      this.deps.store.connectionAssignments(taskId),
      (connectionId) => this.deps.store.connection(connectionId),
      role,
      family,
    );
  }

  /** Why an assigned connection cannot run a turn now, or null when it can. */
  private unready(connection: Connection) {
    const adapter = this.deps.adapters.get(connection.family);
    return connectionRefusal(connection, adapter?.connectionModes ?? []);
  }

  private activeLive(taskId: string, turnId: string): LiveTurn | undefined {
    const live = this.live.get(turnId);
    if (!live || live.finished || live.taskId !== taskId) return;
    // A plan slice's open turn and a side question answer their own asks and Stop, beside the
    // thread's running turn.
    if (this.turn(turnId)?.slice !== undefined || this.beside(turnId)) return live;
    return this.thread(taskId).activeTurnId === turnId ? live : undefined;
  }

  /** A side question: an ask outside a plan slice. It runs beside the thread's active turn. */
  private beside(turnId: string): boolean {
    const turn = this.turn(turnId);
    return turn?.role === 'ask' && turn.slice === undefined;
  }

  /**
   * Stop every open turn that runs on this connection. Disconnect and Forget end its availability
   * at once, so no turn keeps spending on it. A stopped turn's cost stays unreported.
   */
  stopConnectionTurns(connectionId: string) {
    for (const [turnId, live] of this.live) {
      if (live.finished || this.turn(turnId)?.connectionId !== connectionId) continue;
      this.requestStop(live, STOPS.connection);
      this.call(() => live.handle?.stop());
    }
  }

  /** Ask a live turn to stop. The first cause asked for is the one the thread shows. */
  private requestStop(live: LiveTurn, stop: Stop) {
    live.stopRequested = true;
    live.stop ??= stop;
  }

  /** Provider calls run after commit. A throwing adapter must not undo a committed command. */
  private call(work: () => void) {
    try {
      work();
    } catch {
      // The turn result reports what happened to the provider process.
    }
  }

  /**
   * Tell the notice listener about an ending decided here. The thread's newest entry when this
   * runs is the line the ending wrote, so a commit that rolled back leaves it missing and nothing
   * is said. `held` narrows that further, such as a question still open. A restart or a closing
   * service says nothing.
   */
  private notice(kind: WebhookEventKind, taskId: string, line: string, held?: () => boolean) {
    const listener = this.deps.notice;
    if (!listener || this.closed) return;
    // A provider's callback can land here, so a failed read says nothing and reaches nothing.
    let newest: string | undefined;
    try {
      newest = this.deps.store.db
        .prepare(
          'SELECT id FROM conversation_entries WHERE task_id=? ORDER BY sequence DESC LIMIT 1',
        )
        .get(taskId)?.id as string | undefined;
    } catch {
      return;
    }
    queueMicrotask(() => {
      try {
        if (this.closed || !this.task(taskId)) return;
        if (newest && !this.findEntry(taskId, newest)) return;
        if (held && !held()) return;
        listener({ kind, taskId, line });
      } catch {
        // A listener that fails never reaches the work that ended.
      }
    });
  }

  /** Tell the listener a fact decided here, stamped with its thread and the time. */
  private observe(taskId: string, body: PlanEventBody) {
    if (this.deps.observe) this.observed({ ...body, taskId, at: this.deps.now() });
  }

  /**
   * Hand one event to the listener, inside the open transaction, or in one of its own when the
   * fact was decided after its write committed. A listener that throws never reaches the work.
   * Its first failure is logged and later ones are not, so a broken listener cannot fill the log.
   */
  private observed(event: PlanEvent) {
    const listener = this.deps.observe;
    if (!listener) return;
    if (event.kind === 'step-started' && event.turnId) this.steps.set(event.turnId, event);
    // A savepoint, so a listener that throws halfway leaves no row and no event behind.
    const heard = () => this.deps.store.savepoint('observe', () => listener(event));
    try {
      if (this.deps.store.inTransaction) heard();
      else this.deps.store.transaction(heard);
    } catch (error) {
      if (this.observeFailed) return;
      this.observeFailed = true;
      process.stderr.write(`${String(error)}\n`);
    }
  }

  /** Whether the thread waits on the person: a permission request, its checks or a plan to run. */
  private asking(taskId: string): boolean {
    if (this.checkAsk.has(taskId) || this.thread(taskId).plan?.phase === 'proposed') return true;
    for (const live of this.live.values())
      if (live.taskId === taskId && live.permissions.size > 0) return true;
    return false;
  }

  /** The end of a plan step whose turn just settled, told with what its start said. */
  private stepEnded(turnId: string) {
    const started = this.steps.get(turnId);
    const turn = started && this.turn(turnId);
    if (!started || !turn || OPEN_STATES.has(turn.state)) return;
    this.steps.delete(turnId);
    const { kind: _kind, taskId: _taskId, at: _at, ...step } = started;
    const reply =
      step.step === 'review' && turn.state === 'done' && turn.assistantMessageId
        ? this.findEntry(turn.taskId, turn.assistantMessageId)?.text
        : undefined;
    this.observe(turn.taskId, {
      ...step,
      kind: 'step-ended',
      rulesDigest: turn.rules?.digest ?? null,
      designVersionHash: turn.designSystem?.versionHash ?? null,
      // A turn the client ended on its own failed. Any other stop was asked for.
      outcome:
        turn.state === 'done'
          ? 'done'
          : endedOnLimit(turn)
            ? 'limit'
            : turn.state === 'stopped' && turn.stopCause !== 'client'
              ? 'stopped'
              : 'failed',
      durationMs: turn.endedAt
        ? Math.max(0, Date.parse(turn.endedAt) - Date.parse(turn.startedAt))
        : null,
      findings: reply === undefined ? null : statedFindings(reply),
    });
  }

  /**
   * Whether a report recipe's run started this thread, by the run row and the shape of the saved
   * version it names, whatever the run's state. Such a thread reports and only reads for its whole
   * life: every plan on it is a report plan and no turn that writes starts there. Null for any
   * other thread. `going` says the run has not ended, which only picks the refusal's words.
   *
   * Forgetting a recipe drops its saved versions, so the run keeps its own copy of the shape. A
   * run stored before it did falls back to the thread's last plan, and to reporting when the
   * thread never planned, so a lost shape never lets it write.
   */
  private reportThread(taskId: string): { going: boolean } | null {
    const run = this.deps.store.recipeRunOf(taskId);
    if (!run) return null;
    const shape =
      run.shape ?? this.deps.store.recipeVersion(run.recipeId, run.version)?.recipe.shape;
    const plan = this.thread(taskId).plan;
    const report = shape ? shape === 'report' : plan ? !!plan.report : true;
    return report ? { going: run.state === 'running' || run.state === 'asked' } : null;
  }

  /**
   * A thread that reports starts no turn that writes: a message to the builder, a turn sent
   * straight to the fixer, or a rerun of either.
   */
  private reportRefusal(
    taskId: string,
    role: ChatTurn['role'],
  ): Extract<ChatAdmission, { outcome: 'refused' }> | null {
    if (!writesScratch(role) || !this.reportThread(taskId)) return null;
    return {
      outcome: 'refused',
      reason: 'blocked',
      message: 'This thread reports and only reads.',
      next: 'Start a new thread to change files.',
    };
  }

  /** The report turn of a running plan opened again on another provider after a limit. */
  private reportStarted(taskId: string) {
    const plan = this.thread(taskId).plan;
    const turn = this.newestTurn(taskId);
    if (plan?.phase !== 'running' || !turn || !this.plans.isReportTurn(turn)) return;
    this.observe(taskId, {
      kind: 'step-started',
      slice: null,
      step: 'report',
      anchorTurnId: plan.orchestratorTurnId,
      role: 'orchestrator',
      ...stepTurn(turn),
    });
  }

  /** The challenger's turn of a running plan opened, as the newest turn of the thread. */
  private challengeStarted(taskId: string) {
    const plan = this.thread(taskId).plan;
    const turn = this.newestTurn(taskId);
    if (plan?.phase !== 'running' || turn?.role !== 'challenger') return;
    this.observe(taskId, {
      kind: 'step-started',
      slice: null,
      step: 'challenge',
      anchorTurnId: plan.orchestratorTurnId,
      role: 'challenger',
      ...stepTurn(turn),
    });
  }

  /** A gate after a writing turn on the thread copy ended with this result. */
  private gated(taskId: string, chain: ChatCrewChain, result: 'passed' | 'failed' | 'unknown') {
    this.observe(taskId, {
      kind: 'gate',
      slice: null,
      anchorTurnId: chain.builderTurnId,
      trigger: 'after-write',
      result,
    });
  }

  /**
   * An orchestrator turn of the thread that did not end done, with nothing moving the work on,
   * ends the plan it was to write. A limit that moved the turn, Send now and a queued message the
   * queue will start on its own leave the work going. A queue held after a failure, or a first
   * message a turn start would refuse, does not. A restart leaves it to startup.
   */
  private orchestratorEnded(turnId: string, moved: boolean, before: number) {
    const turn = this.turn(turnId);
    if (turn?.role !== 'orchestrator' || turn.slice !== undefined || moved) return;
    if (turn.state === 'done' || OPEN_STATES.has(turn.state) || this.plans.isReportTurn(turn))
      return;
    const person = turn.state === 'stopped' && turn.stopCause === 'person';
    if (turn.state === 'stopped' && !person && turn.stopCause !== 'client') return;
    const task = this.task(turn.taskId);
    const thread = this.thread(turn.taskId);
    if (!task || thread.activeTurnId || this.queueStarts(task, thread)) return;
    // The first line the turn wrote as it ended says why. A line from its start does not.
    this.observe(turn.taskId, {
      kind: 'plan-ended',
      outcome: person ? 'stopped' : 'failed',
      line: this.endLine(turn, before),
      findings: null,
    });
  }

  /**
   * Whether the queue starts its first message on its own once the thread is free: the queue's
   * own rule, and a first message a turn start would not refuse. A message that waits on a family
   * busy in another thread still starts when that family frees.
   */
  private queueStarts(task: Task, thread: ChatThread): boolean {
    const first = thread.queued[0];
    if (!first || this.queueHeld(task, thread)) return false;
    const message = this.plans.route(thread, first);
    const selection = this.pick(task, thread, message.selection);
    if ('outcome' in selection) return false;
    return this.refusal(task, selection, message.role, undefined)?.outcome !== 'refused';
  }

  private head(task: Task): string | null {
    const root = this.deps.projectPath(task.projectId);
    if (!root) return null;
    try {
      const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
        .toString('utf8')
        .trim();
      return /^[a-f0-9]{40}$/.test(head) ? head : null;
    } catch {
      return null;
    }
  }

  /**
   * Each read-only role gets its own brief. An assistant or fixer turn gets the project framing.
   * Inside a crew chain the review states its count and the challenger reads the last answer
   * that wrote, past the reviews in between.
   */
  private context(
    turn: ChatTurn,
    name: string,
    directory: string,
    root: string,
    thread: ChatThread,
    history: readonly ChatHistoryEntry[],
    notes: readonly string[],
    rules: string,
  ): string {
    const { role } = turn;
    const crew = crewRole(thread) === role || turn.slice !== undefined;
    const answer =
      (crew && role === 'challenger'
        ? this.lastWrite(turn.taskId)
        : history.findLast((entry) => entry.role === 'assistant')?.text) ?? null;
    const { family } = turn.selection;
    if (role === 'advisor') return withNotes(adviceContext(name, directory, family, answer), notes);
    if (role === 'ask') return withNotes(askContext(name, directory, family), notes);
    if (role === 'challenger')
      return withNotes(
        crewRole(thread) === 'challenger' && this.reportThread(turn.taskId)
          ? reportChallengeContext(name, directory, family)
          : challengeContext(name, directory, family, answer),
        notes,
      );
    if (role === 'orchestrator')
      return withNotes(
        this.plans.isReportTurn(turn)
          ? reportContext(name, directory, family)
          : orchestratorContext(
              name,
              directory,
              family,
              this.deps.store.recipeSliceCap(turn.taskId),
              !!this.reportThread(turn.taskId),
            ),
        notes,
      );
    if (role !== 'reviewer') return systemContext(name, directory, family, notes, rules);
    const base = thread.base ?? '';
    // The brief says why the changes could not be read, and the model works from the files.
    const files = this.scratchDiff(turn.taskId, root, base, directory);
    return withNotes(
      reviewContext(name, directory, base, files, family, crew, this.unreadable.get(turn.taskId)),
      notes,
    );
  }

  /** The newest reply from a turn that wrote to the scratch copy. */
  private lastWrite(taskId: string): string | undefined {
    const row = this.deps.store.db
      .prepare(
        "SELECT body FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='chat-assistant' AND json_extract(body,'$.author.role') IN ('assistant','fixer') ORDER BY sequence DESC LIMIT 1",
      )
      .get(taskId);
    return row ? ConversationEntrySchema.parse(JSON.parse(row.body as string)).text : undefined;
  }

  private scratchDiff(
    taskId: string,
    root: string,
    base: string,
    directory = this.scratchDirectory(taskId),
  ): FileDiff[] | null {
    try {
      const files = scratchChanges(root, directory, base);
      this.unreadable.delete(taskId);
      return files;
    } catch (error) {
      if (error instanceof ScratchTooLarge) this.unreadable.set(taskId, error.message);
      else this.unreadable.delete(taskId);
      return null;
    }
  }

  // Why the last Changes read of a thread failed when the cause was size, for the prompts.
  private unreadable = new Map<string, string>();

  /**
   * The next provider starts cold, so the packet states what the scratch copy holds and where
   * the stopped turn left off. Patches take up to 48 KiB and the transcript fills the rest of
   * 96 KiB, less the block a resumed session gets in front of it. The shared packet prints the file list under its own heading, so each section added
   * after the list carries a title of its own.
   * shortcut: the new message itself is never cut. Upgrade: refuse a message that cannot fit.
   */
  private packet(
    turn: ChatTurn,
    input: {
      from: ChatFamily;
      reason: HandoffReason;
      root: string;
      base: string;
      history: readonly ChatHistoryEntry[];
      prompt: string;
      files: NonNullable<ChatTurnRequest['files']>;
      threadTools: boolean;
      /** The copy the turn works in. A read-only plan slice reads its own copy's diff. */
      directory: string;
      /** The thread's last plan in words, for an orchestrator turn. */
      plan?: string | null;
      /** Bytes the block in front of the packet takes, which come off the cap. */
      reserve?: number;
    },
  ): string {
    const cap = PACKET_BYTES - (input.reserve ?? 0);
    const changes = this.scratchDiff(turn.taskId, input.root, input.base, input.directory);
    const stopped = this.stoppedLines(turn);
    const checks = this.checkLines(turn.taskId);
    const build = (history: readonly ChatHistoryEntry[], patches: readonly string[]) =>
      handoffPacket({
        from: input.from,
        to: turn.selection.family,
        reason: input.reason,
        history,
        files: [
          ...changeList(changes, this.unreadable.get(turn.taskId)),
          ...stopped,
          ...patches,
          ...checks,
        ],
        prompt: input.prompt,
        threadTools: input.threadTools,
        plan: input.plan ?? null,
        instructions: presentInstructions(input.directory),
        earlier: input.files.flatMap((file) =>
          file.earlier
            ? [
                {
                  attachment: file.attachment,
                  came: file.came ?? '',
                  reach: earlierReach(turn.selection.family, file.path),
                },
              ]
            : [],
        ),
      });
    const room = cap - Buffer.byteLength(build([], []));
    const patches = changes
      ? patchSections(changes, Math.min(PACKET_PATCH_BYTES, room - PACKET_TRANSCRIPT_BYTES))
      : [];
    const history = fitHistory(
      input.history,
      (kept) => Buffer.byteLength(build(kept, patches)) <= cap,
    );
    return build(history, patches);
  }

  /** Which provider stopped, why, and the tool call that never completed. */
  private stoppedLines(turn: ChatTurn): string[] {
    const previous = this.turns(turn.taskId).findLast(
      (value) => value.sequence < turn.sequence && writesScratch(value.role),
    );
    if (!previous || previous.state === 'done') return [];
    const why = endedOnLimit(previous)
      ? 'usage limit reached'
      : previous.state === 'stopped'
        ? 'stopped by the person'
        : 'error';
    const events = this.agentEvents(turn.taskId, previous.id, ['tool.started', 'tool.completed']);
    const finished = new Set(
      events.flatMap((event) => (event.type === 'tool.completed' ? [event.callId] : [])),
    );
    const open = events.findLast(
      (event) => event.type === 'tool.started' && !finished.has(event.callId),
    );
    // A turn that failed at launch never reached its provider, so the provider ended nothing. A
    // step a loop's limit held back is one of those, and its own line says why.
    const said =
      previous.failure?.stage === 'launch'
        ? `${familyName[previous.selection.family]}'s last turn was never sent. ${previous.failure.message} ${previous.failure.nextAction}`
        : `${familyName[previous.selection.family]} ended its last turn early. Reason: ${why}.${previous.failure ? ` ${previous.failure.message}` : ''}`;
    return [
      '',
      'Stopped turn:',
      said,
      ...(open?.type === 'tool.started'
        ? [`In progress when it stopped: ${clip(open.title, 200)} (${open.kind}).`]
        : []),
    ];
  }

  /** The newest system lines that mention checks, such as an acceptance result, oldest first. */
  private checkLines(taskId: string): string[] {
    const lines = this.deps.store.db
      .prepare(
        "SELECT body FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='chat-system' AND json_extract(body,'$.text') LIKE '%check%' ORDER BY sequence DESC LIMIT ?",
      )
      .all(taskId, CHECK_LINES)
      .reverse()
      .map((row) =>
        clip(ConversationEntrySchema.parse(JSON.parse(row.body as string)).text, CHECK_CHARACTERS),
      );
    return lines.length ? ['', 'System lines in this thread that mention checks:', ...lines] : [];
  }

  private scratchDirectory(taskId: string) {
    return chatScratchDirectory(this.deps.home, taskId);
  }

  private filesFolder(taskId: string) {
    return filesFolder(this.deps.home, taskId);
  }

  /**
   * The files a turn sends. A turn with a packet also sends the files of the earlier messages the
   * packet can quote, marked earlier, so the adapter names each one and never refuses the turn
   * over it. A resumed session already holds the files of the messages it ran, so those stay out.
   * The newest 32 earlier files go, and their lines in the packet stay under 8 KiB, so the
   * transcript keeps its room. A file of the message itself that is gone fails the turn. An
   * earlier one that is gone is left out.
   */
  private turnFiles(
    taskId: string,
    message: ConversationEntry,
    carries: boolean,
    resumed: ChatFamily | null,
    since?: bigint,
  ): NonNullable<ChatTurnRequest['files']> {
    const own = message.kind === 'user-message' ? (message.files ?? []) : [];
    const key = (attachment: ChatAttachment) => `${attachment.id}/${attachment.name}`;
    const seen = new Set<string>();
    const files: NonNullable<ChatTurnRequest['files']>[number][] = [];
    for (const attachment of own) {
      if (seen.has(key(attachment))) continue;
      seen.add(key(attachment));
      const stored = this.storedAttachment(taskId, attachment);
      if (!stored) throw Error(`${attachment.name} is no longer stored. Attach it again and send.`);
      files.push(stored);
    }
    if (!carries) return files;
    const earlier: typeof files = [];
    let listed = 0;
    for (const { attachment, came } of this.earlierFiles(taskId, message.cursor, resumed, since)) {
      if (earlier.length === EARLIER_FILES) break;
      if (seen.has(key(attachment))) continue;
      seen.add(key(attachment));
      const stored = this.storedAttachment(taskId, attachment);
      if (!stored) continue;
      listed += Buffer.byteLength(
        `${earlierFileLine({ attachment: stored.attachment, came, reach: `Path: ${stored.path}` })}\n`,
      );
      if (listed > EARLIER_FILE_LINE_BYTES) break;
      earlier.push({ ...stored, earlier: true, came });
    }
    return [...earlier.reverse(), ...files];
  }

  /**
   * A file as its import stored it, with the type the controller detected, and where it is. Null
   * when this thread never imported that id under that name, or the copy is gone.
   */
  private storedAttachment(
    taskId: string,
    file: Pick<ChatAttachment, 'id' | 'name'>,
  ): { attachment: ChatAttachment; path: string } | null {
    const data = this.deps.store.receipt(fileKey(taskId, file))?.result.data;
    if (data?.kind !== 'chat-attachment') return null;
    const { kind: _kind, ...attachment } = data;
    const path = storedFile(this.filesFolder(taskId), attachment);
    return path ? { attachment, path } : null;
  }

  /**
   * Files on the user messages inside the packet's transcript window, newest first, each with a
   * short quote of its message. With a resumed session, the messages a writing turn on its family
   * ran are left out, and `since` leaves out messages at or before that sequence.
   */
  private earlierFiles(
    taskId: string,
    beforeCursor: string,
    resumed: ChatFamily | null,
    since = 0n,
  ): { attachment: ChatAttachment; came: string }[] {
    const ran = this.deps.store.db.prepare(
      "SELECT 1 FROM chat_turns WHERE task_id=? AND json_extract(body,'$.userMessageId')=? AND json_extract(body,'$.selection.family')=? AND json_extract(body,'$.role') IN ('assistant','fixer')",
    );
    return this.deps.store.db
      .prepare(
        "SELECT body FROM conversation_entries WHERE task_id=? AND sequence<? AND sequence>? AND json_extract(body,'$.kind') IN ('user-message','chat-assistant') ORDER BY sequence DESC LIMIT ?",
      )
      .all(taskId, BigInt(beforeCursor), since, HISTORY_LIMIT)
      .flatMap((row) => {
        const entry = ConversationEntrySchema.parse(JSON.parse(row.body as string));
        if (entry.kind !== 'user-message') return [];
        if (resumed && ran.get(taskId, entry.id, resumed)) return [];
        const came = clip(entry.text.replace(/\s+/g, ' ').trim(), 60);
        return [...(entry.files ?? [])].reverse().map((attachment) => ({ attachment, came }));
      });
  }

  /** True when an earlier turn on the same message finished with a reply. */
  private answeredBefore(turn: ChatTurn): boolean {
    return !!this.deps.store.db
      .prepare(
        "SELECT 1 FROM chat_turns WHERE task_id=? AND sequence<? AND json_extract(body,'$.userMessageId')=? AND json_extract(body,'$.state')='done' AND json_extract(body,'$.assistantMessageId') IS NOT NULL",
      )
      .get(turn.taskId, turn.sequence, turn.userMessageId);
  }

  /**
   * The delta packet for a resumed session: the turns after its cursor, what changed in the scratch
   * copy since then, check lines and files attached since, then the new message. Null when the
   * session has seen every turn. 'over' when the delta does not fit the packet cap even with each
   * message and reply cut, so the session has to give way to a new one.
   */
  private delta(
    turn: ChatTurn,
    message: ConversationEntry,
    session: ChatSession,
    root: string,
    base: string,
    prompt: string,
    reason: HandoffReason | null,
    threadTools: boolean,
    /** Bytes the turn's notes block takes in front of the packet. */
    reserve: number,
  ):
    | { prompt: string; files: NonNullable<ChatTurnRequest['files']>; history: ChatHistoryEntry[] }
    | 'over'
    | null {
    const { taskId } = turn;
    const family = turn.selection.family;
    const turns = this.turns(taskId);
    // A session saved before the cursor existed has seen its family's last writing turn.
    const seen =
      session.seenSequence ?? this.writtenOn(taskId, family, turn.sequence)?.sequence ?? -1;
    // A fixer's brief quotes the review it answers, so the review turn stays out.
    const unseen = turns.filter(
      (value) =>
        value.sequence > seen &&
        value.sequence < turn.sequence &&
        !(turn.role === 'fixer' && value.role === 'reviewer'),
    );
    if (!unseen.length) return null;
    const last = turns.find((value) => value.sequence === seen);
    const cursors = [last?.userMessageId, last?.assistantMessageId].flatMap((id) => {
      const entry = id ? this.findEntry(taskId, id) : undefined;
      return entry ? [BigInt(entry.cursor)] : [];
    });
    const after = cursors.reduce((a, b) => (a > b ? a : b), 0n);
    // Each message appears once. The new message goes last under its own heading.
    const shown = new Set([turn.userMessageId]);
    let first = BigInt(message.cursor);
    const told: DeltaTurn[] = unseen.map((value) => {
      const asked = shown.has(value.userMessageId)
        ? undefined
        : this.findEntry(taskId, value.userMessageId);
      shown.add(value.userMessageId);
      if (asked && BigInt(asked.cursor) < first) first = BigInt(asked.cursor);
      return {
        family: value.selection.family,
        model: value.selection.model,
        role: value.role,
        message: asked
          ? spokenText(asked.text, asked.kind === 'user-message' ? (asked.files ?? []) : [])
          : null,
        reply: value.assistantMessageId
          ? (this.findEntry(taskId, value.assistantMessageId)?.text ?? null)
          : null,
        early:
          value.state === 'done'
            ? null
            : value.failure?.stage === 'launch'
              ? 'the turn was never sent'
              : endedOnLimit(value)
                ? 'usage limit reached'
                : value.state === 'stopped'
                  ? 'stopped by the person'
                  : 'error',
        tools: this.toolLines(taskId, value.id),
      };
    });
    const files = this.turnFiles(taskId, message, true, family, after);
    const earlier = files.flatMap((file) =>
      file.earlier
        ? [
            {
              attachment: file.attachment,
              came: file.came ?? '',
              reach: earlierReach(family, file.path),
            },
          ]
        : [],
    );
    const changes = this.deltaChanges(taskId, family, seen, root, base);
    const checks = this.deltaChecks(taskId, after, BigInt(message.cursor));
    const build = (clip: number | undefined, patches: readonly string[]) =>
      deltaPacket({
        from: reason ? turn.handoffFrom : null,
        to: family,
        reason,
        turns: told,
        changes: [...changes.lines, ...patches],
        checks,
        earlier,
        prompt,
        clip,
        threadTools,
      });
    const cap = PACKET_BYTES - reserve;
    for (const clip of [undefined, PACKET_ENTRY_CHARACTERS]) {
      const room = cap - Buffer.byteLength(build(clip, []));
      // Patches take what is left up to their share. With too little room the list stands alone.
      const patches =
        changes.changed.length && room > 4096
          ? patchSections(changes.changed, Math.min(PACKET_PATCH_BYTES, room))
          : [];
      const text = build(clip, patches);
      if (Buffer.byteLength(text) <= cap)
        return { prompt: text, files, history: this.history(taskId, first.toString()) };
    }
    return 'over';
  }

  /**
   * What changed in the scratch copy since the family's session last saw the thread, from the
   * record `markSeen` wrote then. Without a record for that turn, the list covers every change
   * against the base commit.
   */
  private deltaChanges(
    taskId: string,
    family: ChatFamily,
    seen: number,
    root: string,
    base: string,
  ): { lines: string[]; changed: FileDiff[] } {
    const now = this.scratchDiff(taskId, root, base);
    if (now === null)
      return {
        lines: [this.unreadable.get(taskId) ?? 'The scratch changes could not be read.'],
        changed: [],
      };
    const record = this.readSeen(taskId, family);
    if (record?.sequence !== seen)
      return {
        lines: ['Files changed in the scratch copy against the base commit:', ...changeList(now)],
        changed: now,
      };
    const changed = now.filter((file) => record.files[file.path] !== fileDigest(file));
    const back = Object.keys(record.files).filter(
      (path) => !now.some((file) => file.path === path),
    );
    if (!changed.length && !back.length)
      return { lines: ['No files changed in the scratch copy since then.'], changed };
    return {
      lines: [
        'Files changed in the scratch copy since then, with counts against the base commit:',
        ...(changed.length ? changeList(changed) : []),
        ...back
          .slice(0, PACKET_LISTED_FILES)
          .map((path) => `${path} matches the base commit again`),
      ],
      changed,
    };
  }

  /** System lines that mention checks, written after `after` and before the new message. */
  private deltaChecks(taskId: string, after: bigint, before: bigint): string[] {
    return this.deps.store.db
      .prepare(
        "SELECT body FROM conversation_entries WHERE task_id=? AND sequence>? AND sequence<? AND json_extract(body,'$.kind')='chat-system' AND json_extract(body,'$.text') LIKE '%check%' ORDER BY sequence DESC LIMIT ?",
      )
      .all(taskId, after, before, CHECK_LINES)
      .reverse()
      .map((row) =>
        clip(ConversationEntrySchema.parse(JSON.parse(row.body as string)).text, CHECK_CHARACTERS),
      );
  }

  /** One line per tool call of a turn: title, kind and how it ended. */
  private toolLines(taskId: string, turnId: string): string[] {
    const events = this.agentEvents(taskId, turnId, ['tool.started', 'tool.completed']);
    const ended = new Map(
      events.flatMap((event) =>
        event.type === 'tool.completed' ? [[event.callId, event.status] as const] : [],
      ),
    );
    const calls = events.flatMap((event) => (event.type === 'tool.started' ? [event] : []));
    return [
      ...calls
        .slice(0, DELTA_TOOL_LINES)
        .map(
          (call) =>
            `${clip(call.title, 200)} (${call.kind}): ${ended.get(call.callId) ?? 'did not finish'}`,
        ),
      ...(calls.length > DELTA_TOOL_LINES
        ? [`And ${calls.length - DELTA_TOOL_LINES} more tool calls.`]
        : []),
    ];
  }

  /**
   * Record what the scratch copy holds after a turn that saved its family's session, so the next
   * delta for that family can tell what changed since. A failed write leaves the next delta
   * listing every change against the base.
   */
  private markSeen(turn: ChatTurn) {
    try {
      const task = this.task(turn.taskId);
      const root = task && this.deps.projectPath(task.projectId);
      const base = this.thread(turn.taskId).base;
      if (!root || !base) return;
      const files = this.scratchDiff(turn.taskId, root, base);
      if (!files) return;
      const file = this.seenFile(turn.taskId, turn.selection.family);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(
        file,
        JSON.stringify({
          sequence: turn.sequence,
          files: Object.fromEntries(files.map((entry) => [entry.path, fileDigest(entry)])),
        }),
      );
    } catch {
      // Without the record, the next delta lists every change against the base.
    }
  }

  private readSeen(taskId: string, family: ChatFamily): z.infer<typeof SeenSchema> | null {
    try {
      return SeenSchema.parse(JSON.parse(readFileSync(this.seenFile(taskId, family), 'utf8')));
    } catch {
      return null;
    }
  }

  private seenFile(taskId: string, family: ChatFamily) {
    return join(this.deps.home, 'chat', taskId, 'sessions', `${family}.json`);
  }

  /**
   * The model a saved session runs: the model of the turn its cursor names. The client can report
   * another spelling of the same model, so the session's own field is the fallback.
   */
  private sessionModel(taskId: string, session: ChatSession, before: number): string {
    const turn =
      session.seenSequence === undefined
        ? this.writtenOn(taskId, session.family, before)
        : this.turns(taskId).find((value) => value.sequence === session.seenSequence);
    return turn?.selection.family === session.family ? turn.selection.model : session.model;
  }

  /**
   * True when the thread dropped this family's session at the packet cap, for new rules or for
   * another design system.
   */
  private droppedSession(taskId: string, family: ChatFamily): boolean {
    return !!this.deps.store.db
      .prepare(
        "SELECT 1 FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='chat-system' AND json_extract(body,'$.text') IN (?,?,?) LIMIT 1",
      )
      .get(taskId, droppedLine(family), rulesLine(family), designLine(family));
  }

  /**
   * The thread line for replacing a saved session that holds another rule set or another design
   * system version than this turn takes, or null when it holds the same. A session received what
   * the turn its cursor names recorded. One from before they were recorded, or whose turn is
   * gone, holds neither.
   */
  private staleSession(
    taskId: string,
    session: ChatSession,
    before: number,
    rules: string,
    design: ChatTurn['designSystem'] = null,
  ): string | null {
    const turn =
      session.seenSequence === undefined
        ? this.writtenOn(taskId, session.family, before)
        : this.turns(taskId).find((value) => value.sequence === session.seenSequence);
    if ((turn?.rules?.digest ?? null) !== rules) return rulesLine(session.family);
    const held = turn?.designSystem ?? null;
    return held?.version === design?.version && held?.versionHash === design?.versionHash
      ? null
      : designLine(session.family);
  }

  /** The newest assistant or fixer turn on a family before a sequence. */
  private writtenOn(taskId: string, family: ChatFamily, before: number): ChatTurn | undefined {
    const row = this.deps.store.db
      .prepare(
        "SELECT body FROM chat_turns WHERE task_id=? AND sequence<? AND json_extract(body,'$.selection.family')=? AND json_extract(body,'$.role') IN ('assistant','fixer') ORDER BY sequence DESC LIMIT 1",
      )
      .get(taskId, before, family);
    return row ? ChatTurnSchema.parse(JSON.parse(row.body as string)) : undefined;
  }

  /**
   * Move the thread for a rerun on another family. The builder takes the handoff path, which
   * writes the line and leaves the packet for the turn. A fixer gets the packet and the line and
   * leaves the thread's own pick alone, as a limit rerun does. A read-only role starts fresh with
   * its own brief. Returns a refusal, or nothing when the turn can open.
   */
  private moveForRetry(
    task: Task,
    thread: ChatThread,
    turn: ChatTurn,
    selection: ChatModelSelection,
  ): CommandResult | undefined {
    if (!writesScratch(turn.role)) return;
    const from = this.answeredOn(task.id) ?? thread.selection?.family;
    if (!from || from === selection.family) return;
    if (turn.role === 'assistant') {
      const moved = this.handoff({ taskId: task.id, selection, reason: 'manual' });
      return moved.outcome === 'applied' ? undefined : moved;
    }
    this.setHandoff(task.id, { from, reason: 'manual' });
    this.appendEntry(task, {
      kind: 'chat-system',
      author: { kind: 'system', turnId: null },
      text: `Continued on ${familyName[selection.family]} from ${familyName[from]}. Reason: ${handoffReason('manual', from)}.`,
    });
  }

  /**
   * The base ref in the project, then the thread's whole folder: scratch copy, files and per-turn
   * work folders. The folder goes last, so a folder still present means the ref may be too.
   */
  private removeFromDisk(task: Task) {
    const root = this.deps.projectPath(task.projectId);
    try {
      if (root) deleteThreadBaseRef(root, task.id);
    } catch {
      // A ref left behind keeps one commit alive and changes nothing else.
    }
    try {
      rmSync(join(this.deps.home, 'chat', task.id), { recursive: true, force: true });
    } catch {
      // Startup tries again while the folder is there.
    }
  }

  /** Finish a delete whose effect never ran because the controller stopped first. */
  private sweepDeleted() {
    const rows = this.deps.store.db
      .prepare("SELECT command_key FROM receipts WHERE substr(command_key,1,13)='chat-deleted:'")
      .all() as { command_key: string }[];
    for (const { command_key: key } of rows) {
      const task = this.deps.store.receipt(key)?.result.entity as Task | undefined;
      if (task?.id === key.slice('chat-deleted:'.length) && /^tsk_[A-Za-z0-9]+$/.test(task.id))
        if (existsSync(join(this.deps.home, 'chat', task.id))) this.removeFromDisk(task);
    }
    // An event output artifact and its activity row are written together, so one with no row is
    // left from a delete.
    if (rows.length)
      this.removeOutputs(
        this.deps.store.db
          .prepare(
            "SELECT id FROM entities WHERE kind='artifact' AND json_extract(body,'$.mediaType')=? AND id NOT IN (SELECT artifact_id FROM activity_output)",
          )
          .all(EVENT_OUTPUT)
          .map((row) => row.id as string),
      );
  }

  private task(taskId: string): Task | undefined {
    return this.deps.store.get<Task>('task', taskId);
  }

  private putThread(task: Task, thread: ChatThread): ChatThread {
    const value = ChatThreadSchema.parse(thread);
    this.deps.store.db
      .prepare(
        'INSERT INTO chat_threads(task_id,body) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body',
      )
      .run(task.id, canonicalJson(value));
    this.deps.emit('chat.thread', task.id, task.revision, value);
    return value;
  }

  /** Remember a tool kind the person allowed for the whole thread. Each kind is kept once. */
  private grant(taskId: string, kind: ChatToolKind) {
    const task = this.task(taskId);
    const thread = this.thread(taskId);
    const grants = thread.permissionGrants ?? [];
    if (!task || grants.includes(kind)) return;
    this.putThread(task, { ...thread, permissionGrants: [...grants, kind] });
  }

  private pendingHandoff(taskId: string): Handoff | null {
    const row = this.deps.store.db
      .prepare('SELECT handoff FROM chat_threads WHERE task_id=?')
      .get(taskId);
    return typeof row?.handoff === 'string' ? HandoffSchema.parse(JSON.parse(row.handoff)) : null;
  }

  private setHandoff(taskId: string, value: Handoff | null) {
    this.deps.store.db
      .prepare('UPDATE chat_threads SET handoff=? WHERE task_id=?')
      .run(value ? canonicalJson(HandoffSchema.parse(value)) : null, taskId);
  }

  private takeHandoff(task: Task): Handoff | null {
    return this.deps.store.transaction(() => {
      const handoff = this.pendingHandoff(task.id);
      this.setHandoff(task.id, null);
      return handoff;
    });
  }

  private turn(id: string): ChatTurn | undefined {
    const row = this.deps.store.db.prepare('SELECT body FROM chat_turns WHERE id=?').get(id);
    return row ? ChatTurnSchema.parse(JSON.parse(row.body as string)) : undefined;
  }

  private turns(taskId: string): ChatTurn[] {
    return this.deps.store.db
      .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence')
      .all(taskId)
      .map((row) => ChatTurnSchema.parse(JSON.parse(row.body as string)));
  }

  private nextSequence(taskId: string): number {
    const row = this.deps.store.db
      .prepare('SELECT COALESCE(MAX(sequence)+1,0) AS next FROM chat_turns WHERE task_id=?')
      .get(taskId);
    return Number(row?.next ?? 0);
  }

  private putTurn(task: Task, turn: ChatTurn) {
    const value = ChatTurnSchema.parse(turn);
    this.deps.store.db
      .prepare(
        'INSERT INTO chat_turns(id,task_id,sequence,body) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(value.id, task.id, value.sequence, canonicalJson(value));
    this.deps.emit('chat.turn', task.id, task.revision, value);
  }

  private setState(turnId: string, state: 'running' | 'waiting-permission') {
    const turn = this.turn(turnId);
    if (!turn || !OPEN_STATES.has(turn.state) || turn.state === state) return;
    this.putTurn(this.task(turn.taskId) as Task, { ...turn, state });
  }

  /** Validate before writing so an oversized message blocks the command without a rollback. */
  private draftEntry(
    task: Task,
    draft: EntryDraft,
    id = this.deps.id('msg'),
  ): ConversationEntry | undefined {
    const parsed = ConversationEntrySchema.safeParse({
      ...draft,
      id,
      taskId: task.id,
      revision: task.revision,
      cursor: '0',
      at: this.deps.now(),
    });
    return parsed.success ? parsed.data : undefined;
  }

  private saveEntry(task: Task, entry: ConversationEntry): ConversationEntry {
    const insert = this.deps.store.db.prepare(
      'INSERT INTO conversation_entries(id,task_id,body) VALUES (?,?,?)',
    );
    insert.setReadBigInts(true);
    const cursor = insert.run(entry.id, task.id, '{}').lastInsertRowid.toString();
    const saved = ConversationEntrySchema.parse({ ...entry, cursor });
    this.deps.store.db
      .prepare('UPDATE conversation_entries SET body=? WHERE id=?')
      .run(canonicalJson(saved), saved.id);
    this.deps.emit('conversation.entry', task.id, task.revision, saved);
    return saved;
  }

  private appendEntry(task: Task, draft: EntryDraft): ConversationEntry {
    const entry = this.draftEntry(task, draft);
    if (!entry) throw Error('A chat entry exceeds its limits.');
    return this.saveEntry(task, entry);
  }

  private findEntry(taskId: string, id: string): ConversationEntry | undefined {
    const row = this.deps.store.db
      .prepare('SELECT body FROM conversation_entries WHERE task_id=? AND id=?')
      .get(taskId, id);
    return row ? ConversationEntrySchema.parse(JSON.parse(row.body as string)) : undefined;
  }

  /** Prior user and assistant text, oldest first. The oldest entries drop first. */
  private history(taskId: string, beforeCursor: string): ChatHistoryEntry[] {
    return this.deps.store.db
      .prepare(
        "SELECT body FROM conversation_entries WHERE task_id=? AND sequence<? AND json_extract(body,'$.kind') IN ('user-message','chat-assistant') ORDER BY sequence DESC LIMIT ?",
      )
      .all(taskId, BigInt(beforeCursor), HISTORY_LIMIT)
      .reverse()
      .map((row) => {
        const entry = ConversationEntrySchema.parse(JSON.parse(row.body as string));
        return entry.kind === 'user-message'
          ? { role: 'user', text: spokenText(entry.text, entry.files ?? []) }
          : { role: 'assistant', text: entry.text };
      });
  }

  /** Messages before the cursor, oldest first. */
  private messages(taskId: string, beforeCursor: string | undefined, limit: number) {
    const ceiling = beforeCursor === undefined ? MAX_CURSOR : BigInt(beforeCursor);
    return this.deps.store.db
      .prepare(
        `SELECT body FROM conversation_entries WHERE task_id=? AND sequence<? AND json_extract(body,'$.kind') IN ${CHAT_KINDS} ORDER BY sequence DESC LIMIT ?`,
      )
      .all(taskId, ceiling > MAX_CURSOR ? MAX_CURSOR : ceiling, limit)
      .reverse()
      .flatMap((row) => {
        const message = chatMessage(ConversationEntrySchema.parse(JSON.parse(row.body as string)));
        return message ? [message] : [];
      });
  }

  private agentEvents(
    taskId: string,
    turnId: string,
    types: readonly AgentEvent['type'][] = [],
  ): AgentEvent[] {
    const only = types.length
      ? ` AND json_extract(body,'$.payload.type') IN (${types.map(() => '?').join(',')})`
      : '';
    return this.deps.store.db
      .prepare(
        `SELECT body FROM events WHERE task_id=? AND json_extract(body,'$.type')='agent.event' AND json_extract(body,'$.payload.turnId')=?${only} ORDER BY cursor`,
      )
      .all(taskId, turnId, ...types)
      .map((row) => AgentEventSchema.parse(JSON.parse(row.body as string).payload));
  }
}

const MAX_CURSOR = 9223372036854775807n;
// A stored row carries the event envelope around the agent event, and the envelope is far
// smaller than this margin. A longer row can never fit a page.
const TURN_EVENT_ROW_MARGIN = 64 * 1024;
const TURN_EVENT_PAGE_EVENTS = 5000;

/**
 * Null when the first event after the cursor alone exceeds the page. The size counts the kind tag
 * and the longest continuation cursor, so the page fits whatever cursor it ends on.
 */
function turnEventPage(
  store: Store,
  taskId: string,
  turnId: string,
  afterCursor: string,
): ChatTurnEventsRead | null {
  const after = BigInt(afterCursor);
  const rows = store.db
    .prepare(
      `SELECT CAST(cursor AS TEXT) AS cursor,
      CASE WHEN length(CAST(body AS BLOB))<=? THEN body END AS body FROM events
      WHERE task_id=? AND cursor>? AND json_extract(body,'$.type')='agent.event'
      AND json_extract(body,'$.payload.turnId')=? ORDER BY cursor`,
    )
    .iterate(
      MAX_CHAT_TURN_EVENTS_BYTES + TURN_EVENT_ROW_MARGIN,
      taskId,
      after > MAX_CURSOR ? MAX_CURSOR : after,
      turnId,
    );
  const events: AgentEvent[] = [];
  let bytes = size({
    kind: 'chat-turn-events',
    taskId,
    turnId,
    events: [],
    nextAfterCursor: String(MAX_CURSOR),
  });
  let last: string | null = null;
  let more = false;
  for (const row of rows) {
    const event =
      row.body === null
        ? null
        : AgentEventSchema.parse((JSON.parse(row.body as string) as Event).payload);
    // Every event after the first is preceded by a comma in the array.
    const added = event ? size(event) + (events.length ? 1 : 0) : Number.POSITIVE_INFINITY;
    if (events.length === TURN_EVENT_PAGE_EVENTS || bytes + added > MAX_CHAT_TURN_EVENTS_BYTES) {
      if (!events.length) return null;
      more = true;
      break;
    }
    events.push(event as AgentEvent);
    bytes += added;
    last = row.cursor as string;
  }
  return ChatTurnEventsReadSchema.parse({
    taskId,
    turnId,
    events,
    nextAfterCursor: more ? last : null,
  });
}

function chatMessage(entry: ConversationEntry): ChatMessage | undefined {
  const common = {
    id: entry.id,
    taskId: entry.taskId,
    at: entry.at,
    cursor: entry.cursor,
    text: entry.text,
  };
  if (entry.kind === 'user-message')
    return {
      ...common,
      author: { kind: 'user' },
      attachments: entry.attachments ?? [],
      files: entry.files ?? [],
    };
  return entry.kind === 'chat-assistant' || entry.kind === 'chat-system'
    ? { ...common, author: entry.author, attachments: [], files: [] }
    : undefined;
}

function userEntry(input: Message): EntryDraft {
  return {
    kind: 'user-message',
    author: { kind: 'user' },
    text: input.text,
    ...(input.attachments.length ? { attachments: input.attachments } : {}),
    ...(input.files.length ? { files: input.files } : {}),
  };
}

function sameSelection(a: ChatModelSelection, b: ChatModelSelection | null): boolean {
  return a.family === b?.family && a.model === b.model && a.effort === b.effort;
}

/** The role of the running crew step, or null when no chain runs. */
function crewRole(thread: ChatThread): ChatTurn['role'] | null {
  const step = thread.crewChain?.step;
  return step && step in CREW_ROLES ? CREW_ROLES[step as CrewStep] : null;
}

function hasReviewer(thread: ChatThread): boolean {
  return !!thread.crew?.members.some((member) => member.role === 'reviewer');
}

/** The count on the last `Findings: N` line of a review, or null when it states none. */
function statedFindings(text: string): number | null {
  let found: number | null = null;
  for (const line of text.split('\n')) {
    const match = /^Findings:\s*(\d{1,4})$/i.exec(line.trim().replace(/^[`*_]+|[`*_.]+$/g, ''));
    if (match) found = Number(match[1]);
  }
  return found;
}

/**
 * The policy a turn's adapter launches with. Balanced answers the safe asks in the controller, so
 * its adapter sends every ask here, and a reader never sees what the thread allowed.
 */
function launchPolicy(thread: ChatThread, role: ChatTurn['role']): PolicyLimit {
  return writesScratch(role) && thread.flightMode !== 'balanced'
    ? { policy: thread.permissionPolicy, grants: thread.permissionGrants ?? [] }
    : { policy: 'ask', grants: [] };
}

/**
 * True when the tool input names at least one file and every one is inside the scratch copy. An
 * input that names none could write anywhere, so it goes to the person.
 */
function editsInside(input: unknown, scratch: string): boolean {
  if (!input || typeof input !== 'object') return false;
  const fields = input as Record<string, unknown>;
  const paths = ['file_path', 'notebook_path', 'path', 'filePath', 'paths'].flatMap((key) => {
    const value = fields[key];
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value : [];
  });
  return (
    paths.length > 0 &&
    paths.every((path) => typeof path === 'string' && path !== '' && inScratch(scratch, path))
  );
}

/** Turns written before stop reasons were stored fall back to the failure kind. */
/** The thread with this queue. A paused queue that empties has nothing left to hold. */
function withQueue(thread: ChatThread, queued: ChatQueuedMessage[]): ChatThread {
  const { queuePaused, ...rest } = thread;
  return queued.length && queuePaused ? { ...rest, queued, queuePaused } : { ...rest, queued };
}

function endedOnLimit(turn: ChatTurn): boolean {
  return turn.stopReason
    ? turn.stopReason === 'limit'
    : turn.state === 'failed' && turn.failure?.kind === 'usage-limit';
}

const rulesLine = (family: ChatFamily) =>
  `Started a new ${familyName[family]} session. The writing rules changed.`;

// A new saved version and the delivery switch both change what a writing turn receives.
const designLine = (family: ChatFamily) =>
  `Started a new ${familyName[family]} session. The design system sent with writing turns changed.`;

const droppedLine = (family: ChatFamily) =>
  `Started a new ${familyName[family]} session. The thread moved past what the old session could carry.`;

const clip = (text: string, characters: number) =>
  text.length > characters ? `${text.slice(0, characters).toWellFormed()} [trimmed]` : text;

/** Two records of a changed file match when their counts and patch match. */
const fileDigest = (file: FileDiff) => hashCanonical([file.additions, file.deletions, file.patch]);

function changeList(files: readonly FileDiff[] | null, why?: string): string[] {
  if (files === null) return [why ?? 'The scratch changes could not be read.'];
  if (files.length === 0) return ['No files changed yet.'];
  return [
    ...files
      .slice(0, PACKET_LISTED_FILES)
      .map((file) => `${file.path} +${file.additions} -${file.deletions}`),
    ...(files.length > PACKET_LISTED_FILES
      ? [`And ${files.length - PACKET_LISTED_FILES} more files.`]
      : []),
  ];
}

/**
 * Unified patches, largest first, until the byte budget is spent. A patch that does not fit is
 * cut at a line and ends with a marker that says how many lines went. Files with no patch, or
 * none that fits, are named.
 */
function patchSections(files: readonly FileDiff[], budget: number): string[] {
  // The titles and the list of skipped files take the last 2 KiB.
  let left = budget - 2048;
  const skipped = files.flatMap((file) => (file.patch === null ? [file.path] : []));
  const patches = files
    .flatMap((file) =>
      file.patch === null ? [] : [{ path: file.path, patch: file.patch.trimEnd() }],
    )
    .sort((a, b) => Buffer.byteLength(b.patch) - Buffer.byteLength(a.patch));
  const shown: string[] = [];
  for (const { path, patch } of patches) {
    const lines = patch.split('\n');
    const whole = Buffer.byteLength(patch) + 2;
    if (whole <= left) {
      shown.push(patch);
      left -= whole;
      continue;
    }
    const kept: string[] = [];
    let used = CUT_MARKER_BYTES;
    for (const line of lines) {
      const next = used + Buffer.byteLength(line) + 1;
      if (next > left) break;
      used = next;
      kept.push(line);
    }
    // Two header lines say nothing about the change.
    if (kept.length <= 2) {
      skipped.push(path);
      continue;
    }
    shown.push([...kept, `[${lines.length - kept.length} lines cut]`].join('\n'));
    left -= used;
  }
  return [
    ...(shown.length ? ['', 'Patches, largest first:', shown.join('\n\n')] : []),
    ...(skipped.length
      ? [
          '',
          `No patch shown for these files (binary, too large or out of room): ${skipped.join(', ').slice(0, 1024)}`,
        ]
      : []),
  ];
}

/**
 * Cap long entries first, then drop the oldest until the packet fits.
 * shortcut: dropped entries are gone. Upgrade: summarize them from durable facts.
 */
function fitHistory(
  history: readonly ChatHistoryEntry[],
  fits: (kept: readonly ChatHistoryEntry[]) => boolean,
): ChatHistoryEntry[] {
  let kept = [...history];
  if (!fits(kept))
    kept = kept.map((entry) => ({ ...entry, text: clip(entry.text, PACKET_ENTRY_CHARACTERS) }));
  while (kept.length > 0 && !fits(kept)) kept = kept.slice(1);
  return kept;
}

/** A stop CrewKite did not ask for. The adapter's message says why, when it sent one. */
function clientStop(failure: unknown): Stop {
  const reported = ChatFailureSchema.safeParse(failure);
  const message = reported.success ? reported.data.message.trim() : '';
  return { cause: 'client', line: `Stopped: ${message || 'the provider ended the turn.'}` };
}

/** The cost an adapter reported for a turn, when it reported one that reads. */
function reportedSpend(result: ChatTurnResult): ChatTurn['spend'] | undefined {
  const parsed = SpendSchema.safeParse(result.spend);
  return parsed.success ? parsed.data : undefined;
}

function ending(
  result: ChatTurnResult,
  items: ReadonlyMap<string, string>,
  groups: readonly number[],
): Ending {
  const stopReason =
    result.stopReason === 'done' || result.stopReason === 'stopped' || result.stopReason === 'limit'
      ? result.stopReason
      : 'error';
  const state = stopReason === 'done' ? 'done' : stopReason === 'stopped' ? 'stopped' : 'failed';
  const reported = ChatFailureSchema.safeParse(result.failure);
  const limit = stopReason === 'limit';
  const failure =
    state !== 'failed'
      ? null
      : reported.success
        ? reported.data
        : chatFailure({
            stage: 'finish',
            kind: limit ? 'usage-limit' : 'internal',
            message: limit
              ? 'The provider reported a usage limit.'
              : 'The provider ended the turn without a reason.',
          });
  const session = ChatSessionSchema.safeParse(result.session);
  const outputLimit = ChatOutputLimitSchema.safeParse(result.outputLimit);
  const reportedText = typeof result.assistantText === 'string' ? result.assistantText : '';
  return {
    state,
    failure,
    stopReason,
    // Adapters may report only finished items on stop. The streamed text is what was shown.
    text: reportedText.trim() ? reportedText : joinText(items),
    session: session.success ? session.data : null,
    groups,
    ...(state === 'done' && outputLimit.success ? { outputLimit: outputLimit.data } : {}),
  };
}

/**
 * Distinct groups a signal can safely reach. Zero or one would reach this process's own group
 * or every process.
 */
function owned(groups: readonly number[]): number[] {
  return [...new Set(groups)].filter((group) => Number.isSafeInteger(group) && group > 1);
}

/** "group 41200" or "groups 41200, 41201". */
function groupNames(groups: readonly number[]): string {
  const more = groups.length > 8 ? ` and ${groups.length - 8} more` : '';
  return `${groups.length === 1 ? 'group' : 'groups'} ${groups.slice(0, 8).join(', ')}${more}`;
}

function signalGroup(group: number, signal: NodeJS.Signals) {
  if (!owned([group]).length) return;
  try {
    process.kill(-group, signal);
  } catch {
    // ESRCH means the group is already gone. The next check proves it.
  }
}

/**
 * The turn with these groups recorded, or with none when the list is empty.
 * shortcut: the row keeps the newest 64. Upgrade: a table of turn groups.
 */
function withGroups(turn: ChatTurn, groups: readonly number[]): ChatTurn {
  const { groups: _, ...rest } = turn;
  return groups.length ? { ...rest, groups: groups.slice(-64) } : rest;
}

function addText(items: Map<string, string>, event: AgentEvent) {
  if (event.type === 'text.delta')
    items.set(event.itemId, (items.get(event.itemId) ?? '') + event.text);
  if (event.type === 'text.completed') items.set(event.itemId, event.text);
}

function joinText(items: ReadonlyMap<string, string>): string {
  return [...items.values()].filter((text) => text.trim()).join('\n\n');
}

function streamedText(events: readonly AgentEvent[]): string {
  const items = new Map<string, string>();
  for (const event of events) addText(items, event);
  return joinText(items);
}

/** Keep provider text inside the entry limits: valid Unicode, no NUL, bounded bytes. */
function fitText(value: string, bytes: number): string {
  const encoder = new TextEncoder();
  const budget = MAX_CHAT_ENTRY_BYTES - 4096;
  let text = value.replaceAll('\0', '�').toWellFormed();
  while (
    encoder.encode(text).length > bytes ||
    encoder.encode(JSON.stringify(text)).length > budget
  )
    text = text.slice(0, Math.floor(text.length * 0.9)).toWellFormed();
  return text;
}

/** Merge neighboring chunks of one item so a reopened view can rebuild a long turn. */
function compact(events: readonly AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const event of events) {
    const last = out.at(-1);
    if (
      last &&
      (event.type === 'text.delta' || event.type === 'thinking.delta') &&
      last.type === event.type &&
      last.itemId === event.itemId &&
      last.text.length + event.text.length <= 65_536
    ) {
      out[out.length - 1] = { ...last, text: last.text + event.text };
      continue;
    }
    if (
      last?.type === 'tool.output' &&
      event.type === 'tool.output' &&
      last.callId === event.callId &&
      !last.truncated &&
      !event.truncated &&
      last.chunk.length + event.chunk.length <= 65_536
    ) {
      out[out.length - 1] = { ...last, chunk: last.chunk + event.chunk };
      continue;
    }
    out.push(event);
  }
  return out;
}

/**
 * The newest items that fit the byte budget, oldest first.
 * shortcut: a turn with more live output than the budget loses its oldest events on reload.
 * Upgrade: page live events by cursor.
 */
function newest<T>(items: readonly T[], budget: number): T[] {
  let bytes = 0;
  let start = items.length;
  while (start > 0) {
    const next = size(items[start - 1]);
    if (bytes + next > budget) break;
    bytes += next;
    start--;
  }
  return items.slice(start);
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** What a failed git call or check says, without the command line. */
function plain(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString().trim();
  const text = stderr || (error instanceof Error ? error.message : String(error));
  return `${text.split('\n')[0].slice(0, 300)}`;
}
