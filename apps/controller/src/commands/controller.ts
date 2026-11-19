import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Artifact,
  ArtifactSchema,
  type Attempt,
  type BillingMode,
  type Candidate,
  type ChatCatalogRead,
  type ChatFamily,
  type ChatModelSelection,
  type Command,
  type CommandResult,
  CommandResultSchema,
  CommandSchema,
  type Connection,
  type Event,
  googleTermsCurrent,
  isOpenAiLocalEndpoint,
  type ModelCatalogObservation,
  ModelCatalogObservationSchema,
  type Observation,
  ObservationSchema,
  type Project,
  ProjectSchema,
  type Route,
  RouteSchema,
  type Run,
  type Task,
  TaskSchema,
  TimestampSchema,
  webhookUrl,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { CREWKITE_VERSION } from '@crewkite/contracts/version';
import { ArtifactFiles } from '../artifacts/index.ts';
import type { ChatAdapter, ChatTurnRequest } from '../chat/adapter.ts';
import { readAnalytics } from '../chat/analytics.ts';
import { buildChatCatalog } from '../chat/catalog.ts';
import { ChatClientRefused, type ChatClientResolvers, chatClient } from '../chat/clients.ts';
import { Connections, connectionMutations, connectionsCommand } from '../chat/connections.ts';
import { exportThread } from '../chat/export.ts';
import { McpRegistry } from '../chat/mcp-servers.ts';
import { ProjectNotes } from '../chat/project-notes.ts';
import { notesCommand, notesMutations } from '../chat/project-notes-command.ts';
import { readWritingRules } from '../chat/prompt.ts';
import { crewsCommand, crewsMutations, SavedCrews } from '../chat/saved-crews.ts';
import { deletePrompt, PromptsRefused, readPrompts, savePrompt } from '../chat/saved-prompts.ts';
import { chatScratchDirectory } from '../chat/scratch-folder.ts';
import { ChatService } from '../chat/service.ts';
import { ThreadToolsBroker, type ThreadToolsServer } from '../chat/thread-tools/broker.ts';
import { writingRulesExportCommand } from '../chat/writing-rules-export.ts';
import { TaskConversation } from '../conversation/conversation.ts';
import { DesignChecks, findingMutations, findingsCommand } from '../design/check.ts';
import type { PreviewHost } from '../design/screenshots.ts';
import { DesignSystems, designCommand, designMutations } from '../design/service.ts';
import { ConnectLog } from '../diagnostics/connect-log.ts';
import { readDiagnostics } from '../diagnostics/read.ts';
import { CandidateEvidence } from '../evidence/index.ts';
import type { prepareToolchain } from '../evidence/toolchain-definition.ts';
import { ToolchainVerification } from '../evidence/toolchain-verify.ts';
import { ExtensionHost } from '../extensions/host.ts';
import { RemoteEffects } from '../github/effects.ts';
import { policyCommand } from '../github/policy.ts';
import { DependencyPreparer, dependenciesCommand } from '../host/dependencies.ts';
import { readLaunchIdentity } from '../host/launch-identity.ts';
import type { GitIdentitySource } from '../host/publication.ts';
import { inspectSourceDetails, projectRoot } from '../host/source.ts';
import { type GitState, gitProblem, gitState } from '../host/vcs-probe.ts';
import { groupAbsent, type OwnedCommand, type OwnedWorker, type Schedule } from '../host/worker.ts';
import { postThreadNotice, WebhookNotifier } from '../notices/webhook.ts';
import { anthropicChatAdapter } from '../providers/anthropic/chat.ts';
import { authStatusMode } from '../providers/anthropic/discovery.ts';
import { type AnthropicLiveModel, readAnthropicModels } from '../providers/anthropic/models.ts';
import type { NativeConnectionChecks } from '../providers/anthropic/native-connection.ts';
import {
  anthropicApiLoginLine,
  prepareClaudeConfigDir,
  startNativeAuthStatus,
} from '../providers/anthropic/native-discovery.ts';
import type { AnthropicUsageRefresh } from '../providers/anthropic/usage-refresh.ts';
import type { AcpInstallDependencies } from '../providers/google/acp/install.ts';
import type { GoogleAcpInstallation } from '../providers/google/acp/install-operation.ts';
import {
  type AcpClientIdentity,
  type AcpProfileResolution,
  type AcpSetupProof,
  validateAcpSetupProof,
} from '../providers/google/acp/profile.ts';
import type { AcpDependencies, startGoogleAcpSetup } from '../providers/google/acp/writer.ts';
import { type GooglePromptCapabilities, googleChatAdapter } from '../providers/google/chat.ts';
import type { CapturedContext } from '../providers/google/native-extension/connector.ts';
import type {
  googleUsageObservations,
  startGoogleUsage,
} from '../providers/google/native-writer.ts';
import {
  type GoogleUsageClientResolution,
  resolveGoogleUsageClient,
} from '../providers/google/profile.ts';
import { localChatAdapter } from '../providers/local/chat.ts';
import { connectLocalModel } from '../providers/local/chat-connect.ts';
import { connectOpenAiModel } from '../providers/local/openai-compat.ts';
import type { startLocalDiscovery, startLocalReplacement } from '../providers/local/replacement.ts';
import type { LocalInputHelper, startLocalSecretInput } from '../providers/local/secure-input.ts';
import { openAiChatAdapter } from '../providers/openai/chat.ts';
import { openAiCreditReading } from '../providers/openai/discovery.ts';
import { openAiApiLoginLine, startOpenAiAccountStep } from '../providers/openai/login.ts';
import {
  modelReadFailure,
  type OpenAiModelCatalogObservation,
  OpenAiModelCatalogObservationSchema,
  startOpenAiModelCatalogObservation,
} from '../providers/openai/model-catalog.ts';
import {
  nativeDiscoveryEnvironment,
  prepareCodexHome,
  type startNativeSession,
} from '../providers/openai/native-discovery.ts';
import type { NativeProfileResolution } from '../providers/openai/profile.ts';
import type { startReplacement } from '../providers/openai/replacement.ts';
import { draftCommand } from '../recipes/draft.ts';
import { fanOut } from '../recipes/events.ts';
import { ResultRecorder } from '../recipes/results.ts';
import { RecipeRuns, runMutations, runsCommand } from '../recipes/run.ts';
import { Scheduler, schedulesCommand } from '../recipes/scheduler.ts';
import { Recipes, recipeMutations, recipesCommand } from '../recipes/service.ts';
import { RunTracker } from '../recipes/tracker.ts';
import { activityBodyChunks, taskActivityOutputPage, taskActivityPage } from '../store/activity.ts';
import { createIds, type IdPrefix } from '../store/ids.ts';
import { type LaunchIdentity, type LaunchIntent, Store } from '../store/index.ts';
import { assertSchemaCompatibility } from '../store/schema-compatibility.ts';
import { projectPage, taskPage } from '../store/workspace.ts';
import { AcceptanceCommands } from './acceptance.ts';
import { CandidateCommands } from './candidates.ts';
import { CombinedCommands } from './combined.ts';
import { CombinedAssemblyCommands } from './combined-assembly.ts';
import { CombinedEvaluationCommands } from './combined-evaluation.ts';
import { EvaluationCommands } from './evaluation.ts';
import { recoverGoogleMetadata, recoverGoogleMetadataCommand } from './google-recovery.ts';
import { acknowledgeGoogleTerms, googleTermsGate } from './google-terms.ts';
import { NativeEvidenceCommands } from './native-evidence.ts';
import { NativeLaunchCommands } from './native-launch.ts';
import { NativePlanCommands } from './native-plans.ts';
import { NativePrepareCommands } from './native-prepare.ts';
import { NativeRunCommands } from './native-runs.ts';
import { ProjectCommands } from './projects.ts';
import { ProviderCommands } from './providers.ts';
import { RecoveryCommands } from './recovery.ts';
import { RunCommands } from './runs.ts';
import {
  type AcpSetupCommand,
  ChatModelReadSchema,
  type FakeRuntime,
  type LocalOperationRuntime,
  type LocalSecretCell,
  type LocalWriterRuntime,
  migrations,
  type NativeReviewRuntime,
  type NativeRuntime,
  type OpenAiCreditReading,
  type PreparedVerification,
} from './schemas.ts';
import {
  type TaskOperationCommand,
  TaskOperations,
  taskOperationSummary,
} from './task-operations.ts';
import { UsageCommands } from './usage.ts';
import { WriterCommands } from './writers.ts';

export type { NativePilotAppointment } from './schemas.ts';

// The newest OpenAI model list the chat path read, and the record of the read that produced it.
const CHAT_MODEL_CATALOG = 'chat-model-catalog:openai';
const CHAT_MODEL_READ = 'chat-model-read:openai';

// Commands whose contracts are fixed and whose handlers are not built yet. Each answers blocked
// before any receipt is written, so the same key runs for real once its handler lands. A handler
// that lands takes its name off this list.
const PENDING_COMMANDS: ReadonlySet<string> = new Set<Command['command']>([]);
const notAvailable = (): CommandResult => ({
  outcome: 'blocked',
  reason: 'not-available',
  next: 'This version cannot run this command yet. Nothing changed.',
});

export type ControllerOptions = {
  home: string;
  now?: () => string;
  id?: (prefix: IdPrefix) => string;
  routes?: Route[];
  observations?: Observation[];
  workerPath?: string;
  /**
   * The Git identity for commits. A fixed one stands for every project. A function reads the
   * user's global config, for projects whose policy names it; the others read their own config.
   */
  identity?: GitIdentitySource;
  /**
   * HOME, PATH and the like for the git and gh a remote write runs. Without it they get the
   * person's own. Tests pass a temporary HOME and a PATH that holds no installed gh.
   */
  gitEnvironment?: Readonly<Record<string, string>>;
  scenarioForRoute?: (
    route: Route,
    generation: number,
  ) => Extract<import('@crewkite/contracts').FakeWorkerInput, { type: 'start' }>['scenario'];
  afterIntent?: (intent: LaunchIntent) => void;
  schedule?: Schedule;
  /** The timer recipe schedules wait on. Tests pass their own, so no other timer mixes in. */
  scheduleStarts?: Schedule;
  /** Lets a loop take checklist work. Off in the app until the checklist reader is exact. */
  checklistWork?: boolean;
  /** Lets a report recipe run. Off in the app until a report thread refuses Accept. */
  reportRuns?: boolean;
  nativeProfile?: () => NativeProfileResolution;
  nativeProfiles?: () => NativeProfileResolution[];
  nativeSpawn?: Parameters<typeof startReplacement>[2]['spawn'];
  anthropicUsageReader?: Parameters<
    typeof import('../providers/anthropic/native-usage-reader.ts').startAnthropicUsageReader
  >[1];
  openAiUsageClient?: (options?: { cachedOnly?: boolean }) => NativeProfileResolution;
  openAiUsageSpawn?: Parameters<typeof startNativeSession>[1]['spawn'];
  googleUsageClient?: () => GoogleUsageClientResolution;
  googleUsageSpawn?: Parameters<typeof startGoogleUsage>[0]['spawn'];
  googleAcp?: AcpDependencies & {
    resolve?: (proof: AcpSetupProof | null) => AcpProfileResolution;
    spawn?: Parameters<typeof startGoogleAcpSetup>[0]['spawn'];
  };
  googleAcpInstall?: AcpInstallDependencies;
  registerGoogleAcp?: boolean;
  localInputHelper?: LocalInputHelper;
  localInput?: Parameters<typeof startLocalSecretInput>[2];
  /** True when the runtime at the endpoint answers without a token. Tests pass their own. */
  localProbe?: (
    endpoint: string,
  ) => Promise<boolean | 'token-required' | 'timeout' | 'unavailable' | 'open'>;
  /** The fetch for OpenAI-compatible Local endpoints. Tests pass a fake server's. */
  localFetch?: typeof fetch;
  /** The fetch for webhook posts. Tests pass their own. */
  webhookFetch?: typeof fetch;
  /** Where a dropped webhook post is logged. Tests pass their own. */
  webhookLog?: (line: string) => void;
  localDiscovery?: Omit<Parameters<typeof startLocalDiscovery>[2], 'lifecycle'>;
  localWriter?: Omit<Parameters<typeof startLocalReplacement>[2], 'lifecycle' | 'onSubmitted'>;
  prepareVerification?: typeof prepareToolchain;
  /** Whether the tool runs. Tests pass their own. The controller asks the computer once. */
  gitState?: () => GitState;
  /** Chat adapters by family. A family without one refuses new chat turns. */
  chatAdapters?: ReadonlyMap<ChatFamily, ChatAdapter>;
  /** The chat client per family, found by version range. Without one, the profiles stand in. */
  chatClients?: ChatClientResolvers;
  /** Fixed Anthropic picker rows for a scripted setup, in place of reading the client. */
  anthropicModels?: readonly AnthropicLiveModel[];
  /** Digests of this boot and machine for a home. Tests pass their own. */
  launchIdentity?: (home: string) => LaunchIdentity;
  /**
   * The preview process and the browser capture for the screenshot check. Tests pass their own.
   * The declared previews always come from the store.
   */
  previews?: Omit<PreviewHost, 'declared'>;
};

export class Controller {
  readonly store!: Store;
  readonly home: string;
  /** Read once at startup. Each launch intent writes it in the intent's own transaction. */
  readonly launchIdentity!: LaunchIdentity;
  readonly now: () => string;
  readonly id: (prefix: IdPrefix) => string;

  artifacts!: ArtifactFiles;
  private readonly outputAbort = new AbortController();
  private readonly outputPreparations = new Map<string, Promise<Artifact>>();
  private readonly outputReads = new Set<Promise<CommandResult>>();
  evidence!: CandidateEvidence;
  readonly formatting = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  readonly cancelledJobs = new Set<string>();
  readonly jobCancels = new Map<string, () => void>();
  readonly reviewWorkers = new Map<string, OwnedWorker>();
  readonly jobs = new Map<string, OwnedCommand | ToolchainVerification>();
  verificationPreparation?: {
    key: string;
    hash: string;
    principal: string;
    taskId: string;
    abort: AbortController;
    promise: Promise<CommandResult>;
  };
  /** Design drafts still waiting on their model, by command key. */
  private readonly drafts = new Map<
    string,
    { hash: string; principal: string; promise: Promise<CommandResult> }
  >();
  readonly nativeReviewWorkers = new Map<string, NativeReviewRuntime>();
  localSecret: LocalSecretCell | null = null;
  localOperation?: LocalOperationRuntime;
  readonly pendingLocalLaunches = new Set<string>();
  readonly localWriters = new Map<string, LocalWriterRuntime>();
  readonly combinedCheckOwners = new Map<string, { stop: () => void; done: Promise<void> }>();
  readonly combinedPipelines = new Map<string, Promise<void>>();
  readonly combinedOperations = new Map<string, { stop: () => void; done: Promise<unknown> }>();
  conversation!: TaskConversation;
  private readonly owner: DatabaseSync;
  closed = false;
  projectionCache?: Map<string, unknown>;
  readonly options: ControllerOptions;
  profiles: NativeProfileResolution[];
  private closing?: Promise<void>;
  private readonly webhook: WebhookNotifier;
  /** Clients attached to this controller, as the server counts them. Schedules start only then. */
  private clients = 0;
  readonly workers = new Map<string, FakeRuntime | NativeRuntime>();
  readonly quotaRetries = new Map<string, () => void>();
  private chatModelRead?: {
    stopped: boolean;
    stop?: () => void;
    promise: Promise<CommandResult>;
  };
  openAiUsageRead?: {
    id: string;
    stopped: boolean;
    handle?: { stop: () => void };
    done: Promise<void>;
  };
  /** The sign-in of CrewKite's own OpenAI client home while it waits for the browser, or how it ended. */
  openAiSignIn?: {
    key: string;
    state: 'waiting' | 'failed';
    url: string | null;
    stopped: boolean;
    handle?: { stop: () => void };
    done: Promise<void>;
  };
  usageResolution: GoogleUsageClientResolution;
  googleUsageReport?: {
    commandId: string;
    authorityRevision: number;
    attemptedAt: string | null;
    observedAt: string;
    bindingHash: string;
    home: string | undefined;
    buckets: Parameters<typeof googleUsageObservations>[0];
  };
  usageRead?: {
    key: string;
    hash: string;
    principal: string;
    abort: AbortController;
    promise: Promise<CommandResult>;
    resolve: (result: CommandResult) => void;
  };
  acpSetupRuntime?: {
    key: string;
    hash: string;
    principal: string;
    promise: Promise<CommandResult>;
    resolve: (result: CommandResult) => void;
    handle?: ReturnType<typeof startGoogleAcpSetup>;
    stopped: boolean;
  };
  /** The Google setup steps the controller starts on its own at launch. */
  googleAcpPreparation?: Promise<void>;
  /** One controller.log line per provider connect, at launch and on the card's Connect. */
  readonly connectLog = new ConnectLog();
  acpStart?: {
    key: string;
    hash: string;
    principal: string;
    taskId: string;
    runId: string;
    aborted: boolean;
    usageKey?: string;
    authorityRevision?: number;
    deadline: number;
    wallDeadline: number;
    expired: boolean;
    promise: Promise<CommandResult>;
  };

  constructor(options: ControllerOptions) {
    assertSchemaCompatibility(join(options.home, 'state.sqlite'), migrations);
    this.options = options;
    this.anthropicModelRows = options.anthropicModels ?? null;
    this.usageResolution = options.googleUsageClient?.() ?? resolveGoogleUsageClient();
    this.profiles = [];
    this.home = options.home;
    this.now = () => TimestampSchema.parse((options.now ?? (() => new Date().toISOString()))());
    this.id = options.id ?? createIds(this.now);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const home = lstatSync(this.home);
    if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid?.())
      throw new Error('Controller home must be a private directory.');
    chmodSync(this.home, 0o700);
    const ownerPath = join(this.home, 'owner.sqlite');
    const ownerFile = openSync(
      ownerPath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const state = fstatSync(ownerFile);
      if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid?.())
        throw new Error('Invalid controller ownership file.');
    } finally {
      closeSync(ownerFile);
    }
    chmodSync(ownerPath, 0o600);
    this.owner = new DatabaseSync(ownerPath);
    try {
      this.owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
      // The key file joins the home only once this controller owns it.
      this.launchIdentity = (options.launchIdentity ?? readLaunchIdentity)(this.home);
      this.store = new Store(join(this.home, 'state.sqlite'));
      this.store.applyMigrations(migrations);
      this.store.transaction(() => {
        for (const value of options.routes ?? []) {
          const route = RouteSchema.parse(value);
          if (!route.fake) throw new Error('Live routes are unsupported in D0.');
          if (!this.store.get('route', route.id)) this.store.put('route', route.id, 0, route);
        }
        for (const value of options.observations ?? []) {
          const observation = ObservationSchema.parse(value);
          if (!this.store.get('route', observation.routeId))
            throw new Error('Usage route is not registered.');
          const key = `${observation.routeId}/${observation.windowId}`;
          if (!this.store.get('window', key)) this.store.put('window', key, 0, observation);
        }
      });
      this.artifacts = new ArtifactFiles(join(this.home, 'artifacts'));
      this.artifacts.recoverIncoming();
      this.evidence = new CandidateEvidence({
        home: this.home,
        artifacts: this.artifacts,
        id: this.id,
        getArtifact: (id) => {
          const artifact = this.store.get<Artifact>('artifact', id);
          if (!artifact) throw new Error('Artifact metadata is missing.');
          return artifact;
        },
      });
      this.profiles = this.resolveProfiles();
      this.conversation = new TaskConversation(this.store);
      this.recover();
      this.nativeConnections().recover();
      // The records change now. Each kept connection's proof starts once startup has finished.
      this.connections()
        .restore()
        .catch(() => {});
      this.anthropicUsage().recover();
      this.googleInstallation().recover();
      this.taskOperations().recover();
      this.chat().recover();
      this.remoteEffects().recover();
      this.armQuotaRetries();
      for (const row of this.store.db
        .prepare("SELECT candidate_id FROM publications WHERE state='prepared'")
        .all())
        this.reconcilePublication(row.candidate_id as string);
    } catch (error) {
      this.store?.close();
      this.owner.close();
      throw error;
    }
    // A Google metadata row whose recorded group is proven gone stops holding the gate before the
    // launch steps below look at it. A failure here leaves every hold in place.
    try {
      this.store.transaction(() => recoverGoogleMetadata(this, 'automatic'));
    } catch {}
    // Google setup is three client runs and can take a minute. Recovery above has settled any
    // interrupted step, so the runs that need no click start here.
    if (this.store.hasConnectedOnce('google')) this.connectLog.begin('google', 'auto');
    this.googleAcpPreparation = this.prepareGoogleAcp()
      .catch(() => {})
      .then(() => this.settleGoogleConnect())
      .catch(() => {});
    // Local reconnects its saved endpoint from the desktop at launch.
    if (this.store.hasConnectedOnce('local') && this.localControl().endpoint)
      this.connectLog.begin('local', 'auto');
    // Recovery and the launch steps above have committed what they will. The webhook posts from
    // here, so a restart never posts for work that ended before it started.
    this.webhook = new WebhookNotifier({
      address: () => this.store.webhookUrl(),
      fetch: options.webhookFetch ?? fetch,
      now: () => new Date(this.now()),
      log: options.webhookLog ?? ((line) => process.stderr.write(`${line}\n`)),
    });
    // Recovery told the tracker what it stopped. A run whose thread it left waiting or finished
    // is read again from the thread once. A failure here leaves the rows as they are, and the
    // controller still starts.
    try {
      this.runTracker().reconcile();
    } catch (error) {
      process.stderr.write(`Recipe runs were not read again at startup: ${String(error)}\n`);
    }
    // A step whose turn recovery failed ends from the turn's row.
    try {
      this.results().reconcile();
    } catch (error) {
      process.stderr.write(`Step records were not closed at startup: ${String(error)}\n`);
    }
    // Schedules read the runs as the tracker left them. A start that came due while CrewKite was
    // closed waits for the first client to attach.
    try {
      this.scheduler().wake();
    } catch {}
  }

  /**
   * The server tells the controller how many clients are attached. The first one after a time
   * with none lets the schedules make the starts they missed. Nothing here can refuse a client:
   * a schedule that fails to wake is logged and the client attaches all the same.
   */
  clientsChanged(count: number) {
    const first = this.clients === 0 && count > 0;
    this.clients = count;
    if (!first || this.closed) return;
    try {
      this.scheduler().wake();
    } catch (error) {
      process.stderr.write(`Schedules did not wake: ${String(error)}\n`);
    }
  }

  private schedulerRuntime?: Scheduler;
  private scheduler(): Scheduler {
    this.schedulerRuntime ??= new Scheduler({
      store: this.store,
      now: this.now,
      recipes: this.recipes(),
      runs: this.recipeRuns(),
      projectPath: (projectId) => this.projectPath(projectId),
      families: () => this.withProfiles(() => this.chatCatalog().families),
      // The same read a start at reset makes before it runs anything.
      refreshUsage: async (family) => {
        if (family === 'openai') await this.refreshOpenAiUsage('interval');
        else if (family === 'anthropic') await this.anthropicUsage().refreshWhenDue(this.id('cmd'));
        else await this.refreshGoogleUsage('interval');
      },
      attached: () => this.clients > 0,
      schedule: this.options.scheduleStarts,
      notify: (notice) => this.webhook?.notify(notice),
      changed: (projectId, recipeId) =>
        this.event('recipes.changed', null, 0, { projectId, recipeId }),
    });
    return this.schedulerRuntime;
  }

  // Built on the first event, so the runs hear what startup recovery stops.
  private runTrackerRuntime?: RunTracker;
  private runTracker(): RunTracker {
    this.runTrackerRuntime ??= new RunTracker({
      store: this.store,
      now: this.now,
      home: this.home,
      projectPath: (projectId) => this.projectPath(projectId),
      families: () => this.withProfiles(() => this.chatCatalog().families),
      changed: (projectId, recipeId) =>
        this.event('recipes.changed', null, 0, { projectId, recipeId }),
      onRun: (next, before) => this.scheduler().settled(next, before),
    });
    return this.runTrackerRuntime;
  }

  // Built on the first event too, so the records hear what startup recovery stops.
  private resultsRuntime?: ResultRecorder;
  private results(): ResultRecorder {
    this.resultsRuntime ??= new ResultRecorder({
      store: this.store,
      // shortcut: record IDs borrow a message ID's time-ordered suffix, like run IDs do. Upgrade:
      // add 'srs' to IdPrefix and to the testkit ID helper.
      id: () => `srs_${this.id('msg').slice(4)}`,
      home: this.home,
      projectPath: (projectId) => this.projectPath(projectId),
      now: this.now,
    });
    return this.resultsRuntime;
  }

  private remoteEffectsRuntime?: RemoteEffects;
  private remoteEffects(): RemoteEffects {
    this.remoteEffectsRuntime ??= new RemoteEffects({
      store: this.store,
      home: this.home,
      now: this.now,
      id: () => this.id('rfx'),
      projectPath: (projectId) => this.projectPath(projectId),
      environment: this.options.gitEnvironment,
      // The thread hears each change and reads the record again.
      changed: (taskId, change) =>
        this.event(
          'remote-effect.updated',
          taskId,
          this.store.get<Task>('task', taskId)?.revision ?? 0,
          change,
        ),
    });
    return this.remoteEffectsRuntime;
  }

  private taskOperationRuntime?: TaskOperations;
  private taskOperations(): TaskOperations {
    if (this.taskOperationRuntime) return this.taskOperationRuntime;
    this.taskOperationRuntime = new TaskOperations({
      store: this.store,
      artifacts: this.artifacts,
      home: this.home,
      now: this.now,
      id: (prefix) => this.id(prefix),
      event: (record) =>
        this.event(
          'operation.updated',
          record.taskId,
          record.revision,
          taskOperationSummary(record),
        ),
      launchIdentity: this.launchIdentity,
    });
    return this.taskOperationRuntime;
  }

  /** The person's MCP servers as the desktop last supplied them. Memory only. */
  private readonly mcpServers = new McpRegistry();
  private extensionRuntime?: ExtensionHost;
  private extensions(): ExtensionHost {
    this.extensionRuntime ??= new ExtensionHost({
      home: this.home,
      task: (taskId) => this.store.get<Task>('task', taskId),
      readThread: (taskId) => this.chat().readThread({ taskId, limit: 50 }),
      emit: (task, payload) => this.event('extension.event', task.id, task.revision, payload),
    });
    return this.extensionRuntime;
  }

  private savedPrompts(
    command: Extract<
      Command,
      { command: 'ReadChatPrompts' | 'SaveChatPrompt' | 'DeleteChatPrompt' }
    >,
  ): CommandResult {
    try {
      const prompts =
        command.command === 'SaveChatPrompt'
          ? savePrompt(this.home, command.payload)
          : command.command === 'DeleteChatPrompt'
            ? deletePrompt(this.home, command.payload.name)
            : readPrompts(this.home);
      return { outcome: 'applied', data: { kind: 'chat-prompts', ...prompts } };
    } catch (failure) {
      if (failure instanceof PromptsRefused)
        return { outcome: 'blocked', reason: failure.reason, next: failure.next };
      throw failure;
    }
  }

  private notesRuntime?: ProjectNotes;
  private projectNotes(): ProjectNotes {
    // shortcut: notes borrow a message ID's time-ordered suffix, like turns do. Upgrade: add
    // 'not' to IdPrefix and to the testkit ID helper.
    this.notesRuntime ??= new ProjectNotes(
      this.store.db,
      this.now,
      () => `not_${this.id('msg').slice(4)}`,
    );
    return this.notesRuntime;
  }

  private designRuntime?: DesignSystems;
  private designSystems(): DesignSystems {
    this.designRuntime ??= new DesignSystems({
      store: this.store,
      now: this.now,
      projectPath: (projectId) => this.projectPath(projectId),
      saved: (projectId, system, versionHash) =>
        this.designChecks().saved(projectId, system, versionHash),
      draftTurn: async (input) => {
        const selection = this.orchestratorSelection();
        return selection && this.chat().oneTurn({ ...input, role: 'orchestrator', selection });
      },
    });
    return this.designRuntime;
  }

  private recipesRuntime?: Recipes;
  private recipes(): Recipes {
    this.recipesRuntime ??= new Recipes({
      store: this.store,
      now: this.now,
      checklistWork: this.options.checklistWork,
      reportRuns: this.options.reportRuns,
      // shortcut: recipe IDs borrow a message ID's time-ordered suffix, like notes do. Upgrade:
      // add 'rcp' to IdPrefix and to the testkit ID helper.
      id: () => `rcp_${this.id('msg').slice(4)}`,
      home: this.home,
      projectPath: (projectId) => this.projectPath(projectId),
      // The same facts a turn start reads: a connected family, a model it accepts, and for
      // Google the current terms. One catalog serves the whole crew, built with the profiles
      // resolved once, as a workspace read does.
      readiness: (selections) =>
        this.withProfiles(() => {
          const families = this.chatCatalog().families;
          const terms = googleTermsCurrent(this.store.googleAcpSetup().googleTerms);
          return selections.map((selection) => {
            const family = families.find((entry) => entry.family === selection.family);
            if (!family?.connected) return 'not-connected';
            if (!this.chatSelection(selection, families)) return 'model-unknown';
            if (selection.family === 'google' && !terms) return 'terms-pending';
            return null;
          });
        }),
      armed: (record, body, approved) => this.scheduler().armed(record, body, approved),
      forgotten: (recipeId) => this.scheduler().forgotten(recipeId),
      changed: (projectId, recipeId) =>
        this.event('recipes.changed', null, 0, { projectId, recipeId }),
    });
    return this.recipesRuntime;
  }

  private recipeRunsRuntime?: RecipeRuns;
  private recipeRuns(): RecipeRuns {
    this.recipeRunsRuntime ??= new RecipeRuns({
      store: this.store,
      now: this.now,
      // shortcut: run IDs borrow a message ID's time-ordered suffix, like recipe IDs do. Upgrade:
      // add 'rrn' to IdPrefix and to the testkit ID helper.
      id: () => `rrn_${this.id('msg').slice(4)}`,
      home: this.home,
      projectPath: (projectId) => this.projectPath(projectId),
      recipes: this.recipes(),
      createTask: (input) => this.createTask(input),
      startThread: (task, setup, effects, matches) =>
        this.chat().startRecipeThread(task, setup, effects, matches),
      families: () => this.withProfiles(() => this.chatCatalog().families),
      changed: (projectId, recipeId) =>
        this.event('recipes.changed', null, 0, { projectId, recipeId }),
      reportRuns: this.options.reportRuns,
      checklistWork: this.options.checklistWork,
    });
    return this.recipeRunsRuntime;
  }

  /**
   * The model a project's own question runs on: the orchestrator of the default crew when that
   * crew is saved with one, else the model a new thread starts on. Null when nothing can run it.
   */
  private orchestratorSelection(): ChatModelSelection | null {
    const { crews, defaultCrew } = this.savedCrews().read();
    const pinned = crews
      .find((crew) => `saved:${crew.id}` === defaultCrew)
      ?.members.find((member) => member.role === 'orchestrator')?.selection;
    return (pinned && this.chatSelection(pinned)) || this.chatSelection();
  }

  /**
   * A draft asks its model before the command's transaction opens. A retry that arrives while the
   * model is still answering waits for that answer, so one key never asks a model twice.
   */
  private draftDesignSystem(
    command: Extract<Command, { command: 'DraftDesignSystem' }>,
    principal: string,
  ): Promise<CommandResult> {
    const hash = hashCanonical(command);
    const running = this.drafts.get(command.key);
    if (running)
      return running.hash === hash && running.principal === principal
        ? running.promise
        : Promise.resolve({
            outcome: 'denied',
            reason: 'idempotency-key-reused',
            next: 'Use a new key for changed command content.',
          });
    const promise = this.designSystems()
      .drafting(command.payload, () => this.commitCommand(command, principal))
      .finally(() => this.drafts.delete(command.key));
    this.drafts.set(command.key, { hash, principal, promise });
    return promise;
  }

  /**
   * A merge is proposed only when its head merges cleanly onto the pull request's base, fetched
   * now, and GitHub's required checks and rules let it through. A conflict refuses with its paths,
   * and Resolve conflicts in the Changes tab starts the resolution. The proposal names what GitHub
   * showed, and the send reads it again.
   */
  private async proposeMerge(
    command: Extract<Command, { command: 'ProposeRemoteEffect' }>,
    principal: string,
  ): Promise<CommandResult> {
    const { taskId, target, request } = command.payload;
    if (request.kind !== 'merge' || !this.store.get<Task>('task', taskId))
      return { outcome: 'blocked', reason: 'task-not-found', next: 'Choose a registered task.' };
    if (!target.baseRef)
      return {
        outcome: 'blocked',
        reason: 'merge-base-unknown',
        next: 'Name the branch the pull request merges into, then propose the merge.',
      };
    // The base is fetched from the remote that points at the pull request's repository, so a
    // repository no remote of the project names refuses before any fetch or GitHub read.
    const remote = this.remoteEffects().remoteFor(taskId, target.repo);
    if (!remote)
      return {
        outcome: 'blocked',
        reason: 'repository-not-a-remote',
        next: `${target.repo.host}/${target.repo.owner}/${target.repo.name} is not a remote of this project. Choose the project's own repository.`,
      };
    const checked = await this.chat().checkMerge({
      taskId,
      remote,
      base: target.baseRef,
      head: request.expectedHead,
    });
    if (checked.outcome !== 'applied') return checked;
    const ready = await this.remoteEffects().mergeReadiness(target);
    if (ready.reason !== null)
      return { outcome: 'blocked', reason: 'merge-not-ready', next: ready.reason };
    const proposed = this.commitCommand(command, principal);
    return proposed.outcome === 'applied' ? { ...proposed, next: ready.line } : proposed;
  }

  private designChecksRuntime?: DesignChecks;
  private designChecks(): DesignChecks {
    this.designChecksRuntime ??= new DesignChecks({
      store: this.store,
      now: this.now,
      // shortcut: findings borrow a message ID's time-ordered suffix, like notes do. Upgrade: add
      // 'dsf' to IdPrefix and to the testkit ID helper.
      id: () => `dsf_${this.id('msg').slice(4)}`,
      projectPath: (projectId) => this.projectPath(projectId),
      scratchDirectory: (taskId) => chatScratchDirectory(this.home, taskId),
      recordRun: (taskId, run) => this.chat().recordCheckRun(taskId, run),
      checksInCopy: (taskId) => this.chat().checksInCopy(taskId),
    });
    return this.designChecksRuntime;
  }

  private dependenciesRuntime?: DependencyPreparer;
  /** The dependency copy for each writable directory. Each copy's checks ask it for their environment. */
  dependencies(): DependencyPreparer {
    this.dependenciesRuntime ??= new DependencyPreparer({
      store: this.store,
      home: this.home,
      now: this.now,
      // shortcut: borrows a message ID's time-ordered suffix, like findings do. Upgrade: add 'prp'
      // to IdPrefix and to the testkit ID helper.
      id: () => `prp_${this.id('msg').slice(4)}`,
      projectPath: (projectId) => this.projectPath(projectId),
    });
    return this.dependenciesRuntime;
  }

  private connectionsRuntime?: Connections;
  private connections(): Connections {
    // A connection's profile folder sits under the state root its turns' environment names, so
    // the folder the person signs in to is the one its turns run in.
    const environment = (connection: Connection) =>
      connection.family === 'anthropic'
        ? {
            ...this.chatEnvironment('anthropic'),
            CREWKITE_CLAUDE_PROFILE: connection.profileId,
          }
        : { ...this.chatEnvironment('openai'), CREWKITE_CODEX_PROFILE: connection.profileId };
    this.connectionsRuntime ??= new Connections({
      store: this.store,
      now: this.now,
      // shortcut: borrows a message ID's time-ordered suffix, like findings do. Upgrade: add 'con'
      // to IdPrefix and to the testkit ID helper.
      id: () => `con_${this.id('msg').slice(4)}`,
      client: {
        prepare: (connection) =>
          connection.family === 'anthropic'
            ? prepareClaudeConfigDir(environment(connection))
            : prepareCodexHome(nativeDiscoveryEnvironment(environment(connection))),
        loginLine: (connection) =>
          connection.family === 'anthropic'
            ? anthropicApiLoginLine(environment(connection), connection.profileId)
            : openAiApiLoginLine(environment(connection), connection.profileId),
        readMode: (connection) => this.readConnectionMode(connection),
        signOut: (connection) =>
          connection.family === 'anthropic'
            ? this.signOutAnthropicConnection(connection)
            : this.signOutOpenAiConnection(connection),
      },
      stopTurns: (connectionId) => this.chat().stopConnectionTurns(connectionId),
    });
    return this.connectionsRuntime;
  }

  /**
   * The mode an API connection's own profile is signed in with, read by its client outside any
   * turn: OpenAI's account read, Anthropic's auth status. Each runs once through the owned process
   * path with its own timeout and sends no prompt. Null when signed out, undefined when the client
   * could not be run or named nothing CrewKite can place.
   */
  private async readConnectionMode(
    connection: Connection,
  ): Promise<BillingMode | null | undefined> {
    if (connection.billingMode !== 'api' || connection.backend !== 'native-client') return;
    const profile =
      connection.family === 'openai'
        ? this.options.openAiUsageClient?.()
        : connection.family === 'anthropic'
          ? this.chatClientFor('anthropic').profile
          : undefined;
    if (!profile?.facts.available || !profile.client || !profile.environment) return;
    const directory = mkdtempSync(join(this.home, `${connection.family}-proof-`));
    const launch = {
      ...profile.client,
      directory,
      repositoryRoot: this.home,
      environment:
        connection.family === 'openai'
          ? { ...profile.environment, CREWKITE_CODEX_PROFILE: connection.profileId }
          : { ...profile.environment, CREWKITE_CLAUDE_PROFILE: connection.profileId },
    };
    try {
      if (connection.family === 'openai') {
        const { metadata } = await startOpenAiAccountStep(launch, 'read', {
          schedule: this.options.schedule,
          spawn: this.options.openAiUsageSpawn,
        }).result;
        return metadata?.success ? metadata.mode : undefined;
      }
      const { metadata } = await startNativeAuthStatus(launch, {
        schedule: this.options.schedule,
        spawn: this.options.nativeSpawn,
      }).result;
      return metadata ? authStatusMode(metadata) : undefined;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  /**
   * Forget on an OpenAI API connection signs out its own Codex home. The subscription sign-in has
   * its own command, and no other family's client is touched here.
   */
  private async signOutOpenAiConnection(connection: Connection) {
    if (
      connection.family !== 'openai' ||
      connection.billingMode !== 'api' ||
      connection.backend !== 'native-client'
    )
      return;
    const profile = this.options.openAiUsageClient?.();
    if (!profile?.facts.available || !profile.client || !profile.environment) return;
    const directory = mkdtempSync(join(this.home, 'openai-sign-out-'));
    try {
      const handle = startOpenAiAccountStep(
        {
          ...profile.client,
          directory,
          repositoryRoot: this.home,
          environment: { ...profile.environment, CREWKITE_CODEX_PROFILE: connection.profileId },
        },
        'sign-out',
        { schedule: this.options.schedule, spawn: this.options.openAiUsageSpawn },
      );
      await handle.result;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  /**
   * Forget on an Anthropic API connection signs out its own configuration folder. The person's
   * subscription sign-in lives in the default folder and is not touched.
   */
  private async signOutAnthropicConnection(connection: Connection) {
    if (connection.billingMode !== 'api' || connection.backend !== 'native-client') return;
    const profile = this.chatClientFor('anthropic').profile;
    if (!profile?.facts.available || !profile.client || !profile.environment) return;
    const directory = mkdtempSync(join(this.home, 'anthropic-sign-out-'));
    try {
      const handle = startNativeAuthStatus(
        {
          ...profile.client,
          directory,
          repositoryRoot: this.home,
          environment: { ...profile.environment, CREWKITE_CLAUDE_PROFILE: connection.profileId },
        },
        { schedule: this.options.schedule, spawn: this.options.nativeSpawn, signOut: true },
      );
      await handle.result;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private crewsRuntime?: SavedCrews;
  private savedCrews(): SavedCrews {
    this.crewsRuntime ??= new SavedCrews(this.store.db, this.now);
    return this.crewsRuntime;
  }

  private chatRuntime?: ChatService;
  private chat(): ChatService {
    this.chatRuntime ??= new ChatService({
      store: this.store,
      artifacts: this.artifacts,
      home: this.home,
      now: this.now,
      // shortcut: the shared ID helpers have no turn prefix. A fresh message ID lends its
      // time-ordered suffix. Upgrade: add 'trn' to IdPrefix and to the testkit ID helper.
      id: (prefix) => (prefix === 'trn' ? `trn_${this.id('msg').slice(4)}` : this.id(prefix)),
      emit: (type, taskId, revision, payload) => this.event(type, taskId, revision, payload),
      // The notifier exists once startup is done, so nothing that ended before it is posted.
      notice: (event) => postThreadNotice(this.store, this.webhook, event),
      // A recipe run's row and the plan's step records follow the thread in the same transaction.
      // Both are built on the first event, so they hear what startup recovery stops.
      observe: fanOut(
        this.store,
        {
          run_tracker: (event) => this.runTracker().observe(event),
          step_records: (event) => this.results().observe(event),
        },
        (line) => process.stderr.write(`${line}\n`),
      ),
      adapters: this.options.chatAdapters ?? this.defaultChatAdapters(),
      resolveEnvironment: (family) => this.chatEnvironment(family),
      launchIdentity: this.launchIdentity,
      googleTermsAcknowledged: () => googleTermsCurrent(this.store.googleAcpSetup().googleTerms),
      familyModel: (family) => this.store.familyModel(family),
      projectPath: (projectId) => this.projectPath(projectId),
      projectNotes: (projectId) => this.projectNotes().texts(projectId),
      writingRules: () => this.store.writingRules(),
      resolveSelection: (_taskId, selection) => this.chatSelection(selection),
      catalog: () => this.chatCatalog(),
      localContext: () => this.localContext(),
      // A start at reset reads the window again before it runs anything. Local has no window.
      refreshUsage: async (family) => {
        if (family === 'openai') await this.refreshOpenAiUsage('interval');
        else if (family === 'anthropic') await this.anthropicUsage().refreshWhenDue(this.id('cmd'));
        else if (family === 'google') await this.refreshGoogleUsage('interval');
      },
      // A settled turn spent allowance, so the gauge reads again.
      onTurnSettled: (family) => {
        if (family === 'anthropic') void this.anthropicUsage().refreshWhenDue(this.id('cmd'));
      },
      // The turn's thread tools token dies with the turn.
      onTurnEnded: (turnId) => this.threadToolsRuntime?.broker.end(turnId),
      threadToolsDown: () =>
        this.threadToolsRuntime !== undefined && (!this.threadToolsRuntime.ready || this.closed),
      mcp: this.mcpServers,
      previews: {
        ...this.options.previews,
        declared: (projectId) => this.store.designPreview(projectId),
      },
      remoteEffects: this.remoteEffects(),
      dependencies: this.dependencies(),
      // The design check needs no permission and starts no process, so Accept runs it in its own
      // command. A project with no saved design system answers design-system-not-found.
      designCheck: (taskId) => this.designChecks().run(taskId),
    });
    return this.chatRuntime;
  }

  // One broker for the controller's life. Its socket listens once the default adapters exist, and
  // a turn that starts before it listens, or after listening failed, runs without the tools. The
  // chat service asks once per turn, so the packet, the client's config and the thread notice agree.
  private threadToolsRuntime?: {
    broker: ThreadToolsBroker;
    ready: boolean;
    started: Promise<void>;
  };
  private threadToolsBroker() {
    if (this.threadToolsRuntime) return this.threadToolsRuntime;
    const broker = new ThreadToolsBroker({ home: this.home });
    const runtime = { broker, ready: false, started: Promise.resolve() };
    runtime.started = broker.start().then(
      () => {
        runtime.ready = !this.closed;
      },
      () => {
        // The socket stays closed, and every cloud turn runs without the tools.
      },
    );
    this.threadToolsRuntime = runtime;
    return runtime;
  }

  /** The thread tools server for one cloud turn, with a token scoped to its thread and turn. */
  private threadTools(request: ChatTurnRequest): ThreadToolsServer | null {
    const runtime = this.threadToolsRuntime;
    if (!runtime?.ready || this.closed) return null;
    return runtime.broker.mint({
      taskId: request.taskId,
      turnId: request.turnId,
      reader: this.chat().threadReads(request.taskId, request.scratch.directory, request.turnId),
    });
  }

  /** The context of the Local model a turn would run on, when Local is connected. */
  private localContext(): number | null {
    const setup = this.localSetup();
    if (setup.connected !== true || setup.observationStale) return null;
    const loaded = (setup.observation?.models ?? []).filter(
      (choice) => choice.state === 'loaded-eligible',
    );
    const chosen =
      loaded.find((choice) => choice.selectionId === setup.selection?.selectionId) ?? loaded[0];
    return chosen?.contextLength ?? null;
  }

  // What the Google and Local clients last reported about the files they take. Memory only: the
  // next turn on each family reports again.
  private googlePrompt: GooglePromptCapabilities | null = null;
  /** The read of an OpenAI-compatible Local endpoint that last started. Tests wait on it. */
  openAiRead?: Promise<void>;
  private localVision: { modelKey: string; vision: boolean } | null = null;
  // What the OpenAI client said about credits during the last chat turn. The quota read keeps its
  // own copy on disk, and the newer of the two counts.
  private openAiTurnCredits: OpenAiCreditReading | null = null;

  // The Anthropic client's picker rows, read in the background. A read that fails leaves the last
  // rows in place, or none, and the catalog then lists the model IDs this home ran turns on.
  private anthropicModelRows: readonly AnthropicLiveModel[] | null = null;
  private anthropicModelRead = { at: Number.NEGATIVE_INFINITY, busy: false };

  /** Starts a picker read when the last one is old. A catalog read never waits for it. */
  private refreshAnthropicModels(profiles: NativeProfileResolution[]) {
    if (this.options.anthropicModels || !this.store.hasConnectedOnce('anthropic')) return;
    const read = this.anthropicModelRead;
    const client = this.chatClientFor('anthropic', profiles).profile?.client;
    const now = Date.parse(this.now());
    // Ten minutes after a read, one minute after a miss.
    if (
      !client ||
      this.closed ||
      read.busy ||
      now - read.at < (this.anthropicModelRows ? 600_000 : 60_000)
    )
      return;
    read.busy = true;
    read.at = now;
    const directory = join(this.home, 'native', 'chat-models-anthropic');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    readAnthropicModels({
      executable: client.executable,
      sha256: client.sha256,
      environment: this.chatEnvironment('anthropic'),
      directory,
      spawn: this.options.nativeSpawn as Parameters<typeof readAnthropicModels>[0]['spawn'],
      schedule: this.options.schedule,
    })
      .then((rows) => {
        if (!rows || this.closed) return;
        this.anthropicModelRows = rows;
        // CrewKite ships no Anthropic model names, so an open picker reads again when the list
        // arrives.
        this.store.transaction(() =>
          this.event('chat.catalog', null, 0, {
            family: 'anthropic',
            models: Math.min(rows.length, 64),
            reason: null,
          }),
        );
      })
      .catch(() => {})
      .finally(() => {
        read.busy = false;
      });
  }

  private chatCatalog(): ChatCatalogRead {
    const profiles = this.resolveProfiles();
    this.refreshAnthropicModels(profiles);
    return buildChatCatalog({
      profiles: profiles.map((profile) => profile.facts),
      openAiModels: this.latestOpenAiModels(profiles)?.models ?? null,
      // A controller built with fixed profiles and no chat resolver lets those profiles decide.
      clients: Object.fromEntries(
        (['openai', 'anthropic'] as const)
          .filter((family) => this.options.chatClients?.[family])
          .map((family) => [family, this.chatClientFor(family, profiles)]),
      ),
      anthropicModel: this.anthropicUsage().clientModel(),
      anthropicModels: this.anthropicModelRows,
      googlePrompt: this.googlePrompt,
      local: this.localSetup(),
      connectedOnce: (['openai', 'anthropic', 'google', 'local'] as const).filter((family) =>
        this.store.hasConnectedOnce(family),
      ),
      localVision: this.localVision,
      credits: { openai: this.openAiCredits(), anthropic: this.anthropicCredits() },
      creditSpending: {
        openai: this.store.creditSpending('openai'),
        anthropic: this.store.creditSpending('anthropic'),
      },
      windows: [
        ...this.store.list<Observation>('window').map((observation) => ({
          family: this.store.get<Route>('route', observation.routeId)?.family,
          observation,
        })),
        ...this.anthropicUsage().catalogWindows(),
      ],
      turns: this.store.db,
      nowMs: Date.parse(this.now()),
    });
  }

  private openAiCredits(): OpenAiCreditReading | null {
    let read: OpenAiCreditReading | null = null;
    try {
      read = this.openAiUsageState()?.credits ?? null;
    } catch {
      // A damaged read record reads as no credit reading.
    }
    const turn = this.openAiTurnCredits;
    if (!read || !turn) return read ?? turn;
    return Date.parse(turn.observedAt) > Date.parse(read.observedAt) ? turn : read;
  }

  private anthropicCredits(): { extraUsage: boolean; observedAt: string } | null {
    try {
      const reading = this.anthropicUsage().status().reading;
      return reading?.extraUsage
        ? { extraUsage: reading.extraUsage.is_enabled, observedAt: reading.receivedAt }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * The newest OpenAI model list observed with the same client and profile as now. The chat read
   * keeps its own record, read first. Lists the removed task and planning flows kept still count.
   */
  private latestOpenAiModels(profiles: NativeProfileResolution[]) {
    let latest: ModelCatalogObservation | OpenAiModelCatalogObservation | undefined;
    const keys = this.store.db
      .prepare(
        "SELECT command_key FROM receipts WHERE command_key=? OR command_key LIKE 'task-model-catalog:%' OR command_key LIKE 'conversation-model-catalog:%' ORDER BY command_key=? DESC",
      )
      .all(CHAT_MODEL_CATALOG, CHAT_MODEL_CATALOG);
    for (const { command_key: key } of keys) {
      try {
        const value = this.nativeRecord(key as string, 32768).value;
        const catalog =
          key === CHAT_MODEL_CATALOG
            ? OpenAiModelCatalogObservationSchema.parse(value)
            : ModelCatalogObservationSchema.parse(value);
        // The chat client first, so a list read with the build found by range still counts.
        const profile = [this.chatOpenAiProfile(profiles), ...profiles].find(
          (value) => value?.facts.id === catalog.profileId,
        );
        if (
          !profile?.facts.available ||
          hashCanonical(profile.client) !== hashCanonical(catalog.client) ||
          profile.locationHash !== catalog.locationHash ||
          hashCanonical(profile.facts) !== catalog.profileHash
        )
          continue;
        if (!latest || Date.parse(catalog.observedAt) > Date.parse(latest.observedAt))
          latest = catalog;
      } catch {
        // A damaged or partial observation is not a model list.
      }
    }
    return latest;
  }

  /**
   * Starts a model read when the picker has nothing current: no list from the client a turn
   * would use, or one older than a day. After a failed read the next one waits a minute.
   */
  private refreshStaleChatModels() {
    try {
      // The model read starts the OpenAI client, so it waits for the first OpenAI connect on this device.
      if (this.closed || this.chatModelRead || !this.store.hasConnectedOnce('openai')) return;
      const profiles = this.resolveProfiles();
      if (!this.chatOpenAiProfile(profiles)) return;
      const now = Date.parse(this.now());
      const observed = this.latestOpenAiModels(profiles);
      if (observed && now - Date.parse(observed.observedAt) < 86_400_000) return;
      const last = this.chatModelReadRecord();
      if (last?.reason && now - Date.parse(last.attemptedAt) < 60_000) return;
      // Both reads start the same client. At launch they ran side by side and the quota read ran
      // out of time, so the model read waits until the quota read settles and checks again.
      const usage = this.openAiUsageRead?.done;
      if (usage) {
        void usage.then(() => this.refreshStaleChatModels());
        return;
      }
      void this.readChatModels();
    } catch {
      // A damaged read record leaves the catalog as it is. Refresh models reports the failure.
    }
  }

  /** The client a chat turn, model read or quota read launches, found by version range. */
  chatClientFor(family: 'openai' | 'anthropic', profiles?: NativeProfileResolution[]) {
    return chatClient(family, this.options.chatClients, () => profiles ?? this.resolveProfiles());
  }

  /** The OpenAI profile a chat turn launches with. */
  private chatOpenAiProfile(profiles?: NativeProfileResolution[]) {
    const profile = this.chatClientFor('openai', profiles).profile;
    if (profile?.facts.available && profile.client && profile.environment && profile.locationHash)
      return profile;
  }

  private chatModelReadRecord() {
    if (!this.store.receipt(CHAT_MODEL_READ)) return null;
    return ChatModelReadSchema.parse(this.nativeRecord(CHAT_MODEL_READ, 4096).value);
  }

  private retainNativeRecord(key: string, value: unknown) {
    const artifact = this.nativeArtifact(value);
    this.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run(key);
    this.store.saveReceipt(key, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
  }

  /**
   * The person connected a provider on this device. The record makes every later launch
   * reconnect it with no click, and the reads a launch would run start now.
   */
  connectedNow(family: 'openai' | 'anthropic' | 'google' | 'local') {
    if (this.closed) return;
    this.store.transaction(() => this.store.markConnectedOnce(family));
    if (family === 'openai') {
      void this.refreshOpenAiUsage('manual');
      this.refreshStaleChatModels();
    }
    if (family === 'anthropic') {
      void this.anthropicUsage().refreshWhenDue(this.id('cmd'));
      this.refreshAnthropicModels(this.resolveProfiles());
    }
  }

  /** Settles when no model read is running. A quota retry waits for it before it starts. */
  openAiModelReadSettled(): Promise<unknown> {
    return this.chatModelRead?.promise ?? Promise.resolve();
  }

  /** At most one model read runs. A second caller gets the result of the one in flight. */
  private readChatModels(): Promise<CommandResult> {
    if (this.chatModelRead) return this.chatModelRead.promise;
    const runtime = { stopped: false } as NonNullable<Controller['chatModelRead']>;
    runtime.promise = Promise.resolve()
      .then(() => this.runChatModelRead(runtime))
      .catch(
        (): CommandResult => ({
          outcome: 'blocked',
          reason: 'model-read-unavailable',
          next: 'CrewKite could not record the model read. Refresh models to try again.',
        }),
      )
      .finally(() => {
        if (this.chatModelRead === runtime) this.chatModelRead = undefined;
      });
    this.chatModelRead = runtime;
    return runtime.promise;
  }

  /**
   * Reads the client's model list through its app-server, with no thread and no model turn. Each
   * process group is saved as it starts and dropped once it exits, so a crash mid-read leaves the
   * groups for the next read to check. While one is still present no new read starts.
   */
  private async runChatModelRead(
    runtime: NonNullable<Controller['chatModelRead']>,
  ): Promise<CommandResult> {
    if (this.closed || runtime.stopped) return { outcome: 'blocked', reason: 'controller-closing' };
    const profile = this.chatOpenAiProfile();
    if (!profile)
      return {
        outcome: 'blocked',
        reason: 'provider-unavailable',
        next: 'Install the OpenAI client and sign in, then refresh models.',
      };
    const leftover = (this.chatModelReadRecord()?.groups ?? []).filter(
      (group) => !groupAbsent(group),
    );
    if (leftover.length)
      return {
        outcome: 'blocked',
        reason: 'ownership-unknown',
        next: `CrewKite cannot confirm that process ${leftover.join(', ')} from the last model read ended. Refresh models checks again. If it stays, export diagnostics before taking further action.`,
      };
    const record = ChatModelReadSchema.parse({
      version: 1,
      attemptedAt: this.now(),
      groups: [],
      reason: null,
    });
    const save = () =>
      this.store.transaction(() => this.retainNativeRecord(CHAT_MODEL_READ, record));
    // One directory serves every read. Reads never overlap, and a fresh one each time would pile up
    // a log folder per day.
    const directory = join(this.home, 'native', 'chat-models-openai');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    save();
    let handle: ReturnType<typeof startOpenAiModelCatalogObservation> | undefined;
    let observation: OpenAiModelCatalogObservation | null = null;
    let failure: Parameters<typeof modelReadFailure>[0] = {
      reason: 'launch',
      lastRequest: 'initialize',
    };
    try {
      handle = startOpenAiModelCatalogObservation(
        profile,
        { directory, repositoryRoot: this.home },
        {
          timeoutMs: 20_000,
          observedAt: this.now,
          schedule: this.options.schedule,
          spawn: this.options.nativeSpawn ?? spawn,
          lifecycle: {
            beforePhase: () => {
              if (this.closed || runtime.stopped) throw Error('The model read was stopped.');
            },
            owned: (_phase, group) => {
              record.groups = [...record.groups, group];
              save();
            },
            quiescent: (_phase, group) => {
              record.groups = record.groups.filter((value) => value !== group);
              save();
            },
          },
        },
      );
      runtime.stop = handle.stop;
      if (this.closed || runtime.stopped) handle.stop();
      const outcome = await handle.result;
      failure = outcome;
      if (outcome.quiescent && !outcome.reason) observation = outcome.metadata;
    } catch {
      // A launch that throws has no process of its own. Groups it started are checked below.
    }
    record.groups = [...new Set([...record.groups, ...(handle?.groups ?? [])])].filter(
      (group) => !groupAbsent(group),
    );
    if (record.groups.length) observation = null;
    record.reason = record.groups.length
      ? `CrewKite cannot confirm that process ${record.groups.join(', ')} from the model read ended. Refresh models checks again. If it stays, export diagnostics before taking further action.`
      : observation
        ? null
        : modelReadFailure(failure);
    if (this.chatModelRead === runtime) this.chatModelRead = undefined;
    this.store.transaction(() => {
      this.retainNativeRecord(CHAT_MODEL_READ, ChatModelReadSchema.parse(record));
      if (observation) this.retainNativeRecord(CHAT_MODEL_CATALOG, observation);
      this.event('chat.catalog', null, 0, {
        family: 'openai',
        models: observation?.models.length ?? 0,
        reason: record.reason,
      });
    });
    if (record.reason)
      return { outcome: 'blocked', reason: 'model-read-failed', next: record.reason };
    return { outcome: 'applied', data: { kind: 'chat-catalog', ...this.chatCatalog() } };
  }

  private chatSelection(
    selection?: ChatModelSelection,
    families = this.chatCatalog().families,
  ): ChatModelSelection | null {
    if (selection) {
      const models = families.find((entry) => entry.family === selection.family)?.models ?? [];
      const model = models.find((entry) => entry.model === selection.model);
      // An empty list means no catalog was observed. The adapter then reports a bad model. A
      // cloud family also takes an ID the list does not hold, since the person can type one and
      // the client rejects it on the first turn. A Local model has to be on this computer.
      if (models.length && !model && selection.family === 'local') return null;
      if (model && selection.effort !== 'default' && !model.efforts.includes(selection.effort))
        return null;
      // A thread saved with Default on a model that lists levels runs at the preselected level,
      // so the chip shows the level the turn asks for.
      if (model && selection.effort === 'default' && !model.efforts.includes('default'))
        return { ...selection, effort: model.defaultEffort };
      return selection;
    }
    for (const entry of families) {
      const name = entry.defaultModel ?? entry.models[0]?.model;
      if (!entry.connected || !name) continue;
      const model = entry.models.find((value) => value.model === name);
      return { family: entry.family, model: name, effort: model?.defaultEffort ?? 'default' };
    }
    return null;
  }

  private chatEnvironment(family: ChatFamily): NodeJS.ProcessEnv {
    const preferred: Record<ChatFamily, string[]> = {
      openai: ['openai-repository-v1', 'openai-file-v1'],
      anthropic: ['anthropic-file-v1', 'anthropic-file-compact-v1'],
      google: ['google-acp-v1'],
      local: [],
    };
    const profiles = [
      ...(family === 'openai' || family === 'anthropic'
        ? [this.chatClientFor(family).profile ?? []].flat()
        : []),
      ...this.resolveProfiles(),
    ];
    // Writer profiles trim PATH to the system directories. A chat turn runs the person's own
    // commands through the client, so it keeps the PATH the controller was started with.
    const path = process.env.PATH ? { PATH: process.env.PATH } : {};
    for (const id of preferred[family]) {
      const profile = profiles.find((value) => value.facts.id === id);
      if (profile?.facts.available && profile.environment)
        return { ...profile.environment, ...path };
    }
    return Object.fromEntries(
      Object.entries({ HOME: process.env.HOME, ...path }).filter((entry) => entry[1] !== undefined),
    );
  }

  /** One adapter per family, each resolving its client by version range at launch time. */
  private defaultChatAdapters(): Map<ChatFamily, ChatAdapter> {
    this.threadToolsBroker();
    const threadTools = (request: ChatTurnRequest) => this.threadTools(request);
    const client = (family: 'openai' | 'anthropic') => {
      const found = this.chatClientFor(family);
      if (!found.profile?.client) throw new ChatClientRefused(found.status.message);
      return found.profile.client;
    };
    const openai = openAiChatAdapter({
      launch: (request: ChatTurnRequest) => ({
        ...client('openai'),
        directory: request.work.directory,
        repositoryRoot: this.home,
        environment: request.environment,
      }),
      spawn: this.options.nativeSpawn as Parameters<typeof openAiChatAdapter>[0]['spawn'],
      // The client proved the mode of a connection's sign-in before sending. A missing sign-in
      // ends the connection's availability and stops its other turns, the way the person's own
      // check does. A connection forgotten meanwhile has nothing to record.
      onAccountMode: ({ connectionId, mode, proofGeneration }) => {
        try {
          this.connections().record(connectionId, mode, false, proofGeneration);
        } catch {}
      },
      onUsage: (usage) => {
        const reading = openAiCreditReading(usage);
        if (reading) this.openAiTurnCredits = { ...reading, observedAt: this.now() };
      },
      threadTools,
    });
    const anthropic = anthropicChatAdapter({
      launch: () => client('anthropic'),
      // The client's system/init proved the mode of a connection's sign-in before sending. A
      // source the client names that CrewKite does not know proves nothing. A connection forgotten
      // meanwhile has nothing to record.
      onAccountMode: ({ connectionId, mode, proofGeneration }) => {
        try {
          if (mode) this.connections().record(connectionId, mode, false, proofGeneration);
        } catch {}
      },
      spawn: this.options.nativeSpawn as Parameters<typeof anthropicChatAdapter>[0]['spawn'],
      schedule: this.options.schedule,
      onUsage: (reading) => this.anthropicUsage().recordTurnReading(reading),
      threadTools,
    });
    const google = googleChatAdapter({
      onPromptCapabilities: (capabilities) => {
        this.googlePrompt = capabilities;
      },
      threadTools,
      launch: (request: ChatTurnRequest) => {
        const setup = this.store.googleAcpSetup();
        const resolution = this.acpResolution();
        if (setup.state !== 'ready' || !setup.proofId || !resolution.client)
          throw Error('The Google client is not connected.');
        const proof = validateAcpSetupProof(
          this.acpProof(setup.proofId),
          resolution.client,
          this.options.googleAcp?.reviewMappings,
        );
        const select = (value: { optionId: string; supported: readonly string[] }) => ({
          optionId: value.optionId,
          supported: value.supported,
        });
        return {
          client: resolution.client as AcpClientIdentity,
          configuration: proof.configOptions
            ? {
                model: select(proof.configOptions.model),
                thoughtLevel: proof.configOptions.thoughtLevel
                  ? select(proof.configOptions.thoughtLevel)
                  : null,
              }
            : null,
          reviewMode: proof.reviewMode
            ? { configId: proof.reviewMode.configId, valueId: proof.reviewMode.valueId }
            : null,
          environment: resolution.environment ?? request.environment,
          spawn: this.options.googleAcp?.spawn,
          schedule: this.options.schedule,
        };
      },
    });
    const local = localChatAdapter({
      connect: async (request: ChatTurnRequest) => {
        const control = this.localControl();
        if (!control.endpoint || !this.localConnected(control))
          throw Error('Local is not connected. Open Settings, load a model and connect Local.');
        // The probe at connect decided whether a token exists. The saved mode does not.
        if (isOpenAiLocalEndpoint(control.endpoint)) {
          const connection = await connectOpenAiModel({
            endpoint: control.endpoint,
            model: request.selection.model,
            fetch: this.options.localFetch,
          });
          this.localVision = { modelKey: connection.modelKey, vision: false };
          return { ...connection, connectedWithoutToken: true };
        }
        const secret = this.localSecretMatches(control)
          ? (this.localSecret?.secret.toString('utf8') ?? null)
          : null;
        const connection = await connectLocalModel({
          endpoint: control.endpoint,
          token: secret,
          model: request.selection.model,
        });
        this.localVision = { modelKey: connection.modelKey, vision: connection.vision };
        return { ...connection, connectedWithoutToken: secret === null };
      },
      // Local runs the same five reads as functions in this process. No socket or token.
      threadReader: (request) =>
        this.chat().threadReads(request.taskId, request.scratch.directory, request.turnId),
    });
    return new Map<ChatFamily, ChatAdapter>([
      ['openai', openai],
      ['anthropic', anthropic],
      ['google', google],
      ['local', local],
    ]);
  }

  async execute(input: unknown, principal: string): Promise<CommandResult> {
    if (this.closed) return { outcome: 'blocked', reason: 'controller-closing' };
    if (principal !== 'local-owner')
      return {
        outcome: 'denied',
        reason: 'unauthenticated-actor',
        next: 'Connect through the private authenticated socket.',
      };
    const parsed = CommandSchema.safeParse(input);
    if (!parsed.success)
      return {
        outcome: 'unsupported',
        reason: 'invalid-command',
        next: 'Send a valid protocol 1 command.',
      };
    const command = parsed.data;
    if (PENDING_COMMANDS.has(command.command)) return notAvailable();
    // A copy takes real time, so it answers when the copy is done. It writes no receipt: running it
    // again prepares the same copy again.
    if (
      command.command === 'PrepareDependencies' ||
      command.command === 'ReadDependencyPreparation'
    )
      return dependenciesCommand(
        this.dependencies(),
        (taskId) => !!this.store.get<Task>('task', taskId),
        (taskId) => this.store.transaction(() => this.chat().preparationRefusal(taskId)),
        command,
      );
    if (
      [
        'PrepareProjectCommand',
        'StartProjectCommand',
        'ReadGitHub',
        'StopProjectOperation',
        'GetTaskOperations',
        'GetProjectOperation',
      ].includes(command.command)
    )
      return this.taskOperations().execute(command as TaskOperationCommand);
    // Before any receipt path: a server's secrets must not reach a journal row either.
    if (command.command === 'SupplyMcpServers') {
      if (command.actor.kind !== 'desktop')
        return { outcome: 'denied', reason: 'desktop-actor-only' };
      this.mcpServers.set(command.payload);
      return { outcome: 'applied' };
    }
    // Before any receipt path: the token must not reach a journal row.
    if (command.command === 'SupplyLocalToken' || command.command === 'ReadLocalToken')
      return this.localTokenCommand(command);
    if (command.command === 'GetArtifactRange' || command.command === 'GetTaskActivityPage') {
      const reading = this.readOutput(command);
      this.outputReads.add(reading);
      try {
        return await reading;
      } finally {
        this.outputReads.delete(reading);
      }
    }
    if (command.command === 'AcknowledgeGoogleTerms') {
      const acknowledged = this.store.transaction(() =>
        acknowledgeGoogleTerms(this.store, command.payload.textVersion, this.now()),
      );
      // The launch-time steps waited for this, so they run now and need no restart.
      if (acknowledged.outcome === 'applied')
        this.googleAcpPreparation = this.prepareGoogleAcp().catch(() => {});
      return acknowledged;
    }
    // Reading a client's version changes nothing, so it comes before the Google terms gate.
    if (command.command === 'CheckProviderClient')
      return this.checkProviderClient(command.payload.family);
    const termsRefusal = googleTermsGate(this.store, command, (runId) => this.isPreparedAcp(runId));
    if (termsRefusal) return termsRefusal;
    if (command.command === 'RefreshGoogleAcpModels') {
      // A refresh from Ready changes no connect state, so it stays out of the connect log.
      return this.executeAcpSetup(command, principal);
    }
    if (
      [
        'InitializeGoogleAcp',
        'AuthenticateGoogleAcp',
        'DiscoverGoogleAcp',
        'StopGoogleAcpSetup',
      ].includes(command.command)
    ) {
      // A setup step the person pressed connects Google on this device. The launch-time steps
      // run from then on.
      if ('consent' in command.payload && command.payload.consent === 'explicit') {
        this.connectedNow('google');
        this.connectLog.begin('google', 'manual');
      }
      const setup = this.executeAcpSetup(command as AcpSetupCommand, principal);
      void setup.then((result) => this.settleGoogleConnect(result)).catch(() => {});
      return setup;
    }
    if (command.command === 'StartRun' && this.isPreparedAcp(command.payload.runId))
      return this.executeAcpStart(command, principal);
    if (command.command === 'InstallGoogleAcp' || command.command === 'StopGoogleAcpInstall') {
      if (command.command === 'InstallGoogleAcp') {
        this.connectedNow('google');
        this.connectLog.begin('google', 'manual');
      }
      const install = this.executeGoogleInstall(command, principal);
      void install.then((result) => this.settleGoogleConnect(result)).catch(() => {});
      return install;
    }
    if (command.command === 'CheckNativeConnection') {
      this.connectLog.begin('anthropic', 'manual');
      const check = this.checkNativeConnection(command, principal);
      void check.then((result) => this.settleAnthropicConnect(result)).catch(() => {});
      return check;
    }
    if (command.command === 'SignInOpenAi') return this.signInOpenAi(command);
    // A proof waits on the client and records only what it says, so it keeps no receipt. Running
    // it again reads the mode again.
    if (command.command === 'ProveConnection')
      return this.connections().prove(command.payload.connectionId, true);
    if (command.command === 'SignOutOpenAi') return this.signOutOpenAi(command);
    if (command.command === 'RefreshAnthropicUsage' || command.command === 'StopAnthropicUsage')
      return this.anthropicUsage().execute(command);
    if (command.command === 'ObserveUsage') return this.observeUsageCommand(command, principal);
    // A model read changes no task and no authority. A retry with the same key reads again.
    if (command.command === 'RefreshChatModels') return this.readChatModels();
    // Git steps after Accept run git and gh, which wait on the network, so they answer later.
    if (
      command.command === 'PushChatBranch' ||
      command.command === 'OpenChatPullRequest' ||
      command.command === 'ReadChatBranchStatus' ||
      command.command === 'CheckChatMerge'
    ) {
      if (!this.store.get<Task>('task', command.payload.taskId))
        return { outcome: 'blocked', reason: 'task-not-found', next: 'Choose a registered task.' };
      if (command.command === 'PushChatBranch') return this.chat().pushBranch(command.payload);
      if (command.command === 'OpenChatPullRequest')
        return this.chat().openPullRequest(command.payload);
      if (command.command === 'CheckChatMerge') return this.chat().checkMerge(command.payload);
      return this.chat().branchStatus(command.payload);
    }
    // A merge proposal first merges its head onto the base it would land on, then reads what
    // GitHub asks of that head. Both wait on the network and write nothing, so they run before the
    // command's transaction. A replay answers from its receipt.
    if (
      command.command === 'ProposeRemoteEffect' &&
      command.payload.request.kind === 'merge' &&
      !this.store.receipt(command.key)
    )
      return this.proposeMerge(command, principal);
    // A confirmed write and a reconcile wait on git, gh and the network, so they answer later.
    // The write's own state answers a repeat, so neither keeps a receipt.
    if (command.command === 'ConfirmRemoteEffect')
      return this.remoteEffects().confirm(command.payload);
    if (command.command === 'ReconcileRemoteEffect')
      return this.remoteEffects().reconcile(command.payload);
    if (command.command === 'ReadReviewComments')
      return this.remoteEffects().readReviewComments(command.payload);
    if (command.command === 'ReadMergeReadiness')
      return this.remoteEffects().readMergeReadiness(command.payload);
    // The file copies before the command's transaction opens. A replay answers from its receipt.
    if (command.command === 'ImportChatAttachment' && !this.store.receipt(command.key))
      return this.chat().importing(command.payload, () => this.commitCommand(command, principal));
    // A replay answers from its receipt and asks no model.
    if (command.command === 'DraftDesignSystem' && !this.store.receipt(command.key))
      return this.draftDesignSystem(command, principal);
    const preparing = this.verificationPreparation;
    if (preparing?.key === command.key)
      return preparing.hash === hashCanonical(command) && preparing.principal === principal
        ? preparing.promise
        : {
            outcome: 'denied',
            reason: 'idempotency-key-reused',
            next: 'Use a new key for changed command content.',
          };
    if (
      command.command === 'ResumeRun' &&
      !this.store.receipt(command.key) &&
      this.store.receipt(`native-run:${command.payload.runId}`)
    ) {
      try {
        const run = this.store.get<Run>('run', command.payload.runId);
        if (!run) throw Error('Native run is unavailable.');
        this.quotaRetryEvidence(run, true);
      } catch {
        return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
      }
    }
    if (!('expectedRevision' in command)) {
      try {
        return CommandResultSchema.parse(this.apply(command, []));
      } catch {
        return {
          outcome: 'blocked',
          reason: 'read-unavailable',
          next: 'Inspect the current source or retained artifact before retrying.',
        };
      }
    }
    let preflightFailure: CommandResult | undefined;
    if (
      command.command === 'ResumeRun' &&
      !this.store.receipt(`native-run:${command.payload.runId}`) &&
      !this.store.receipt(command.key) &&
      !this.checkRevision(command)
    ) {
      try {
        this.prepareResumeContext(command.payload.taskId, command.payload.runId);
      } catch {
        preflightFailure = {
          outcome: 'blocked',
          reason: 'retained-context-unavailable',
          next: 'Inspect retained work and ownership before requesting resume.',
        };
      }
    }
    if (
      command.command === 'PrepareCandidateEvaluation' &&
      command.payload.checkRecipeId === 'crewkite-verify-v1' &&
      !this.store.receipt(command.key) &&
      !this.checkRevision(command)
    )
      return this.prepareVerificationCommand(command, principal);
    return this.commitCommand(command, principal, preflightFailure);
  }

  private async readOutput(
    command: Extract<Command, { command: 'GetArtifactRange' | 'GetTaskActivityPage' }>,
  ): Promise<CommandResult> {
    try {
      if (command.command === 'GetArtifactRange') {
        const artifact = this.store.get<Artifact>('artifact', command.payload.artifactId);
        if (!artifact) return { outcome: 'blocked', reason: 'artifact-not-found' };
        const range = await this.artifacts.readRange(artifact.hash, command.payload);
        if (range.totalBytes !== artifact.bytes) throw Error('artifact-length-mismatch');
        return CommandResultSchema.parse({
          outcome: 'applied',
          data: {
            kind: 'artifact-range',
            artifact,
            offset: command.payload.offset,
            encoding: 'base64',
            content: range.bytes.toString('base64'),
            eof: range.eof,
            integrity: 'unverified-range',
          },
        });
      }
      if (!this.store.get<Task>('task', command.payload.taskId))
        return { outcome: 'blocked', reason: 'task-not-found' };
      const data = await taskActivityOutputPage(
        this.store.db,
        command.payload,
        (cursor, eventId, bytes) => this.prepareActivityOutput(cursor, eventId, bytes),
      );
      return { outcome: 'applied', data };
    } catch {
      return {
        outcome: 'blocked',
        reason: 'output-read-unavailable',
        next: 'Retained output could not be read. No history was skipped. Retry the same page.',
      };
    }
  }

  private prepareActivityOutput(cursor: string, eventId: string, bytes: number): Promise<Artifact> {
    const pending = this.outputPreparations.get(cursor);
    if (pending) return pending;
    const preparing = (async () => {
      const mapping = this.store.db
        .prepare('SELECT event_id,artifact_id FROM activity_output WHERE cursor=?')
        .get(BigInt(cursor));
      if (mapping) {
        const artifact = this.store.get<Artifact>('artifact', mapping.artifact_id as string);
        if (mapping.event_id !== eventId || !artifact || artifact.bytes !== bytes)
          throw Error('activity-output-invalid');
        return artifact;
      }
      const published = await this.artifacts.publishStream(
        activityBodyChunks(this.store.db, cursor, eventId, bytes, this.outputAbort.signal),
        { signal: this.outputAbort.signal },
      );
      this.outputAbort.signal.throwIfAborted();
      const artifact = ArtifactSchema.parse({
        id: this.id('art'),
        ...published,
        mediaType: 'application/vnd.crewkite.event+json',
      });
      this.store.transaction(() => {
        this.store.put('artifact', artifact.id, 0, artifact);
        this.store.db
          .prepare('INSERT INTO activity_output(cursor,event_id,artifact_id) VALUES (?,?,?)')
          .run(BigInt(cursor), eventId, artifact.id);
      });
      return artifact;
    })();
    this.outputPreparations.set(cursor, preparing);
    void preparing.finally(() => this.outputPreparations.delete(cursor)).catch(() => {});
    return preparing;
  }

  commitCommand(
    command: Command,
    principal: string,
    preflightFailure?: CommandResult,
    verification?: PreparedVerification,
    acpContext?: CapturedContext,
  ): CommandResult {
    if (this.closed && !preflightFailure)
      return { outcome: 'blocked', reason: 'controller-closing' };
    const hash = hashCanonical(command);
    const effects: (() => void)[] = [];
    let result: CommandResult;
    const combinedCommand =
      command.command === 'PrepareCombinedRun' ||
      ('taskId' in command.payload &&
        !!command.payload.taskId &&
        !!this.store.combinedGroup(command.payload.taskId));
    try {
      result = this.store.transaction<CommandResult>(() => {
        const receipt = this.store.receipt(command.key);
        if (receipt) {
          if (receipt.hash !== hash || receipt.principal !== principal)
            return {
              outcome: 'denied',
              reason: 'idempotency-key-reused',
              next: 'Use a new key for changed command content.',
            };
          if (receipt.result.outcome === 'outcome-unknown' && command.command === 'AcceptCandidate')
            effects.push(() => this.reconcilePublication(command.payload.candidateId, command.key));
          return receipt.result.outcome === 'applied'
            ? { ...receipt.result, outcome: 'already-applied' }
            : receipt.result;
        }
        const stale = this.checkRevision(command);
        const result = CommandResultSchema.parse(
          stale ?? preflightFailure ?? this.apply(command, effects, verification, acpContext),
        );
        this.store.saveReceipt(command.key, hash, principal, result);
        return result;
      });
    } catch (error) {
      if (!combinedCommand) throw error;
      effects.length = 0;
      result = {
        outcome: 'blocked',
        reason: 'combined-authority-unavailable',
        next: 'Review the exact group, source, phase permissions and remaining limits.',
      };
      this.store.transaction(() => this.store.saveReceipt(command.key, hash, principal, result));
    }
    for (const effect of effects) effect();
    return effects.length > 0 && result.outcome === 'outcome-unknown'
      ? (this.store.receipt(command.key)?.result ?? result)
      : result;
  }

  anthropicUsageRuntime?: AnthropicUsageRefresh;
  googleInstallOperation?: GoogleAcpInstallation;

  connectionChecks?: NativeConnectionChecks;

  subscribe(listener: (event: Event) => void): () => void {
    return this.store.subscribe(listener);
  }
  close(): void | Promise<void> {
    if (this.closed) return this.closing;
    this.closed = true;
    this.webhook.close();
    this.schedulerRuntime?.close();
    for (const cancel of this.quotaRetries.values()) cancel();
    this.quotaRetries.clear();
    const native: Promise<unknown>[] = [];
    const operationClosing = this.taskOperationRuntime?.close();
    if (operationClosing) native.push(operationClosing);
    const chatClosing = this.chatRuntime?.close();
    if (chatClosing) native.push(chatClosing);
    const effectsClosing = this.remoteEffectsRuntime?.close();
    if (effectsClosing) native.push(effectsClosing);
    // The thread tools socket closes now, so a controller started next on this home binds its
    // own. Nothing the store holds waits on it.
    const tools = this.threadToolsRuntime;
    if (tools) {
      const closeTools = () => void tools.broker.close().catch(() => {});
      if (tools.ready) closeTools();
      else void tools.started.then(closeTools);
      tools.ready = false;
    }
    this.outputAbort.abort();
    native.push(...this.outputReads);
    const usageClosing = this.anthropicUsageRuntime?.close();
    if (usageClosing) native.push(usageClosing);
    const connectionClosing = this.connectionChecks?.close();
    if (connectionClosing) native.push(connectionClosing);
    const installClosing = this.googleInstallOperation?.close();
    if (installClosing) native.push(installClosing);
    if (this.acpStart) {
      this.acpStart.aborted = true;
      native.push(this.acpStart.promise);
    }
    if (this.acpSetupRuntime) {
      this.acpSetupRuntime.stopped = true;
      this.acpSetupRuntime.handle?.stop();
      native.push(this.acpSetupRuntime.promise);
    }
    if (this.chatModelRead) {
      this.chatModelRead.stopped = true;
      this.chatModelRead.stop?.();
      native.push(this.chatModelRead.promise);
    }
    if (this.openAiUsageRead) {
      this.openAiUsageRead.stopped = true;
      this.openAiUsageRead.handle?.stop();
      native.push(this.openAiUsageRead.done);
    }
    if (this.openAiSignIn?.state === 'waiting') {
      this.openAiSignIn.stopped = true;
      this.openAiSignIn.handle?.stop();
      native.push(this.openAiSignIn.done);
    }
    if (this.usageRead) {
      this.usageRead.abort.abort();
      native.push(this.usageRead.promise);
    }
    if (this.verificationPreparation) {
      this.verificationPreparation.abort.abort();
      native.push(this.verificationPreparation.promise);
    }
    for (const run of this.formatting.values()) {
      run.abort.abort();
      native.push(run.promise);
    }
    for (const runtime of this.workers.values()) {
      if (runtime.kind === 'native') {
        runtime.stopped = true;
        runtime.handle?.stop();
        if (runtime.done) native.push(runtime.done);
      } else {
        runtime.cancel?.();
        runtime.worker.child.stdin.end();
      }
    }
    this.revokeLocalSecret();
    if (this.localOperation) {
      this.localOperation.stopped = true;
      this.localOperation.handle?.stop();
      native.push(this.localOperation.done);
    }
    for (const runtime of this.localWriters.values()) {
      runtime.stopped = true;
      runtime.handle?.stop();
      native.push(runtime.done);
    }
    for (const runtime of this.nativeReviewWorkers.values()) {
      runtime.stopped = true;
      runtime.handle?.stop();
      native.push(runtime.done);
    }
    for (const intent of this.store.intents()) {
      if (
        intent.state === 'intent' &&
        this.store.receipt(`combined-check:${intent.attempt_id}`) &&
        !this.jobs.has(intent.attempt_id)
      ) {
        const attempt = this.store.get<Attempt>('attempt', intent.attempt_id) as Attempt;
        this.settleJob(attempt, true, true, () =>
          this.store.db
            .prepare("UPDATE combined_dispatches SET state='stopped' WHERE attempt_id=?")
            .run(attempt.id),
        );
      }
    }
    native.push(...this.combinedPipelines.values());
    for (const owner of this.combinedCheckOwners.values()) {
      owner.stop();
      native.push(owner.done);
    }
    for (const operation of this.combinedOperations.values()) {
      operation.stop();
      native.push(operation.done);
    }
    for (const cancel of this.jobCancels.values()) cancel();
    for (const job of this.jobs.values()) {
      job.stop();
      if (job instanceof ToolchainVerification) native.push(job.closed);
    }
    for (const worker of this.reviewWorkers.values()) worker.child.stdin.end();
    const finish = () => {
      try {
        this.store.close();
      } finally {
        this.owner.close();
      }
    };
    if (!native.length) finish();
    else this.closing = Promise.allSettled(native).then(finish);
    return this.closing;
  }

  checkRevision(command: Command): CommandResult | undefined {
    if (!('expectedRevision' in command)) return;
    if (command.command === 'ConfigureExtension' || command.command === 'RunExtensionCommand')
      return this.extensions().checkRevision(command);
    if (
      command.command === 'ConfigureLocal' ||
      command.command === 'BeginLocalConnectionInput' ||
      command.command === 'CancelLocalConnectionInput' ||
      command.command === 'DisconnectLocal' ||
      command.command === 'RefreshLocalModels' ||
      command.command === 'SelectLocalModel'
    ) {
      const setup = this.localSetup();
      if (command.expectedRevision !== setup.revision)
        return { outcome: 'stale-revision', revision: setup.revision };
      return;
    }
    if (
      [
        'InitializeGoogleAcp',
        'AuthenticateGoogleAcp',
        'DiscoverGoogleAcp',
        'RefreshGoogleAcpModels',
        'StopGoogleAcpSetup',
        'RecoverGoogleMetadata',
      ].includes(command.command)
    ) {
      const setup = this.store.googleAcpSetup();
      if (command.expectedRevision !== setup.revision)
        return {
          outcome: 'stale-revision',
          revision: setup.revision,
          data: { kind: 'google-acp-setup', setup },
        };
      return;
    }
    // Saved prompts have no task. Their receipts come from the normal journal, so a replayed key
    // answers from its receipt and an old save cannot overwrite a newer body.
    if (command.command === 'SaveChatPrompt' || command.command === 'DeleteChatPrompt') return;
    // Notes belong to a project, not a task. The controller checks the project and the size cap
    // when it applies the command, and a replayed key answers from its receipt.
    if (notesMutations.includes(command.command)) return;
    // Saved crews belong to no task. The controller checks names, the limit and the default when
    // it applies the command, and a replayed key answers from its receipt.
    if (crewsMutations.includes(command.command)) return;
    // A design system belongs to a project. A save checks its own expected version.
    if (designMutations.includes(command.command)) return;
    // A recipe belongs to a project. A save checks its own expected version.
    if (recipeMutations.includes(command.command) || runMutations.includes(command.command)) return;
    // So does a schedule, which belongs to its recipe.
    if (command.command === 'SetRecipeSchedule') return;
    // A design check reads its thread as it stands, and a finding names its own thread.
    if (findingMutations.includes(command.command)) return;
    // A policy belongs to a project. A save replaces it whole, and a replayed key answers from its
    // receipt.
    if (command.command === 'SetRepositoryPolicy') return;
    // A remote write checks its own thread and state, and a replayed key answers from its receipt.
    if (
      command.command === 'ProposeRemoteEffect' ||
      command.command === 'CancelRemoteEffect' ||
      command.command === 'SettleRemoteEffect'
    )
      return;
    // So does an Accept attempt, which names its own thread.
    if (command.command === 'CancelAcceptance') return;
    // The credit switch belongs to no task. A replayed key answers from its receipt.
    if (command.command === 'SetCreditSpending') return;
    // So does the webhook address, which belongs to the controller and no task.
    if (command.command === 'SetWebhook') return;
    // A connection or an assignment checks its own record, and a replayed key answers from its
    // receipt.
    if (connectionMutations.includes(command.command)) return;
    // So do the writing rules: one preference per rule, shared by desktop and CLI.
    if (command.command === 'SetWritingRule') return;
    // An export belongs to a project. It checks its own preview hash and the file's digest.
    if (command.command === 'ExportWritingRules') return;
    // So does the default model per family.
    if (command.command === 'SetFamilyModel') return;
    if (
      [
        'SendChatMessage',
        'ResolveChatPermission',
        'StopChatTurn',
        'ConfigureChatThread',
        'RunChatTests',
        'ReleaseChatCheck',
        'HandoffChatThread',
        'AcceptChatChanges',
        'SteerChatMessage',
        'ImportChatAttachment',
        'RetryChatTurn',
        'DiscardChatChange',
        'DecideChatHunk',
        'DiscardChatHunk',
        'CommentChatChange',
        'RenameChatThread',
        'DeleteChatThread',
        'AskChatFamily',
        'RunChatPlan',
        'CancelChatPlan',
      ].includes(command.command)
    ) {
      // A thread streams events many times a second. Its commands serialize on the active turn,
      // so a revision race would only block Stop at the moment it matters most.
      if (!('taskId' in command.payload) || !this.store.get<Task>('task', command.payload.taskId))
        return { outcome: 'blocked', reason: 'task-not-found', next: 'Choose a registered task.' };
      return;
    }
    if (
      command.command === 'RegisterProject' ||
      command.command === 'CreateTask' ||
      command.command === 'ObserveUsage' ||
      command.command === 'InitializeGoogleAcp' ||
      command.command === 'AuthenticateGoogleAcp' ||
      command.command === 'DiscoverGoogleAcp' ||
      command.command === 'StopGoogleAcpSetup'
    ) {
      if (command.expectedRevision !== 0)
        return { outcome: 'stale-revision', revision: 0, next: 'Create from revision zero.' };
      return;
    }
    const taskId =
      command.command === 'ResolveApproval'
        ? command.payload.binding.taskId
        : 'taskId' in command.payload
          ? command.payload.taskId
          : undefined;
    const task = taskId ? this.store.get<Task>('task', taskId) : undefined;
    if (!task)
      return { outcome: 'blocked', reason: 'task-not-found', next: 'Choose a registered task.' };
    if (task.revision !== command.expectedRevision)
      return {
        outcome: 'stale-revision',
        entity: task,
        revision: task.revision,
        next: 'Refresh the task and review the action.',
      };
  }

  /** A new task in a project, the way a new thread starts. Runs inside a command's transaction. */
  private createTask(payload: {
    projectId: string;
    title: string;
    outcome: string;
    criteria: string[];
  }): Task {
    const task = TaskSchema.parse({
      ...payload,
      id: this.id('tsk'),
      state: 'draft',
      waitingReason: null,
      revision: 0,
      runId: null,
      next: 'Prepare the run.',
    });
    this.store.put('task', task.id, task.revision, task);
    this.event('task.created', task.id, task.revision, task);
    return task;
  }

  private apply(
    command: Command,
    effects: (() => void)[],
    verification?: PreparedVerification,
    acpContext?: CapturedContext,
  ): CommandResult {
    if (
      'taskId' in command.payload &&
      typeof command.payload.taskId === 'string' &&
      ['PrepareRun', 'PrepareNativeRun', 'PrepareCombinedRun', 'StartRun', 'ResumeRun'].includes(
        command.command,
      ) &&
      this.taskOperationRuntime?.busyTask(command.payload.taskId)
    )
      return {
        outcome: 'blocked',
        reason: 'task-operation-active',
        next: 'Stop or reconcile the exact project command before starting a task writer.',
      };

    if ('taskId' in command.payload && typeof command.payload.taskId === 'string') {
      const group = this.store.combinedGroup(command.payload.taskId);
      if (
        group &&
        [
          'AmendTask',
          'PrepareRun',
          'PrepareNativeRun',
          'PrepareNativeHandoff',
          'StartNativeHandoff',
          'PrepareCandidateEvaluation',
          'StartCandidateEvaluation',
          'StartCandidateReview',
          'AcceptCandidate',
          'ResumeRun',
          'SwitchRoute',
          'PrepareCombinedRun',
        ].includes(command.command) &&
        (group.task_id !== command.payload.taskId ||
          ![
            'PrepareCandidateEvaluation',
            'StartCandidateEvaluation',
            'StartCandidateReview',
            'AcceptCandidate',
            'ResumeRun',
          ].includes(command.command))
      )
        return {
          outcome: 'blocked',
          reason: 'combined-member-owned',
          next: 'Inspect the parent combined run. Child work cannot be accepted independently.',
        };
    }
    if (
      'taskId' in command.payload &&
      command.payload.taskId &&
      ['ResumeRun', 'SwitchRoute'].includes(command.command)
    ) {
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (task?.runId && this.store.receipt(`native-run:${task.runId}`)) {
        try {
          if (command.command !== 'ResumeRun') throw Error('Native switch is unavailable.');
          const run = this.store.get<Run>('run', task.runId);
          if (!run) throw Error('Native run is unavailable.');
          this.quotaRetryEvidence(run, true);
        } catch {
          return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
        }
      }
    }
    if (
      'taskId' in command.payload &&
      ['AcceptCandidate', 'ExportPatch', 'GetChanges'].includes(command.command) &&
      command.payload.taskId &&
      this.hasUncertainWriter(command.payload.taskId)
    )
      return {
        outcome: 'blocked',
        reason: 'writer-ownership-unknown',
        next: 'Prove the process group is gone before reading or publishing retained work.',
      };
    if (command.command === 'AcceptCandidate' || command.command === 'ExportPatch') {
      const task = this.store.get<Task>('task', command.payload.taskId);
      const run = task?.runId ? this.store.get<Run>('run', task.runId) : undefined;
      const candidate = this.store.get<Candidate>('candidate', command.payload.candidateId);
      if (
        !task ||
        !run ||
        !candidate ||
        candidate.taskId !== task.id ||
        this.latestCandidate(run.id)?.id !== candidate.id
      )
        return { outcome: 'blocked', reason: 'candidate-not-current' };
      if (!this.candidateCurrent(run, candidate))
        return {
          outcome: 'blocked',
          reason: 'candidate-binding-changed',
          next: 'Seal and check the changed work before publication.',
        };
    }
    switch (command.command) {
      case 'SendChatMessage':
        return this.chat().sendMessage(command.payload, effects);
      case 'ResolveChatPermission':
        return this.chat().resolvePermission(command.payload, effects);
      case 'StopChatTurn':
        return this.chat().stopTurn(command.payload, effects);
      case 'ConfigureChatThread':
        return this.chat().configure(command.payload, effects);
      case 'RunChatTests':
        return this.chat().runTests(command.payload, effects);
      case 'ReleaseChatCheck':
        return this.chat().releaseCheck(command.payload, effects);
      case 'HandoffChatThread':
        return this.chat().handoff(command.payload, effects);
      case 'SteerChatMessage':
        return this.chat().steer(command.payload, effects);
      case 'ImportChatAttachment':
        return this.chat().importAttachment(command.payload);
      case 'RetryChatTurn':
        return this.chat().retryTurn(command.payload, effects);
      case 'DiscardChatChange':
        return this.chat().discardChange(command.payload, command.key);
      case 'DecideChatHunk':
        return this.chat().decideHunk(command.payload);
      case 'DiscardChatHunk':
        return this.chat().discardHunk(command.payload);
      case 'CommentChatChange':
        return this.chat().commentChange(command.payload, effects);
      case 'RenameChatThread':
        return this.chat().renameThread(command.payload);
      case 'DeleteChatThread':
        return this.chat().deleteThread(command.payload, effects);
      case 'AskChatFamily':
        return this.chat().ask(command.payload, effects);
      case 'RunChatPlan':
        return this.chat().runPlan(command.payload, effects);
      case 'CancelChatPlan':
        return this.chat().cancelPlan(command.payload, effects);
      case 'ReadChatTurnEvents':
        return this.chat().readTurnEvents(command.payload);
      case 'ReadExtensions':
        return { outcome: 'applied', data: { kind: 'extensions', ...this.extensions().read() } };
      case 'ConfigureExtension':
        return this.extensions().configure(command.payload, effects);
      case 'RunExtensionCommand':
        return this.extensions().run(command.payload);
      case 'AcceptChatChanges':
        return this.chat().accept(command.payload, this.options.identity, effects);
      case 'ReadAcceptance':
        return this.chat().readAcceptance(command.payload);
      case 'CancelAcceptance':
        return this.chat().cancelAcceptance(command.payload, effects);
      case 'ReadChatThread':
      case 'ReadChatChanges': {
        if (!this.store.get<Task>('task', command.payload.taskId))
          return { outcome: 'blocked', reason: 'task-not-found' };
        if (command.command === 'ReadChatChanges') {
          const page = this.chat().readChanges(command.payload);
          return 'outcome' in page
            ? page
            : { outcome: 'applied', data: { kind: 'chat-changes', ...page } };
        }
        return {
          outcome: 'applied',
          data: { kind: 'chat-thread', ...this.chat().readThread(command.payload) },
        };
      }
      case 'SearchChatHistory':
        return {
          outcome: 'applied',
          data: { kind: 'chat-search', ...this.chat().searchHistory(command.payload) },
        };
      case 'CompleteChatMention':
      case 'ReadChatInstructions':
        if (!this.store.get<Task>('task', command.payload.taskId))
          return { outcome: 'blocked', reason: 'task-not-found' };
        return {
          outcome: 'applied',
          data:
            command.command === 'CompleteChatMention'
              ? { kind: 'chat-mentions', ...this.chat().completeMention(command.payload) }
              : { kind: 'chat-instructions', ...this.chat().readInstructions(command.payload) },
        };
      case 'ExportChatThread': {
        const exported = exportThread(
          {
            store: this.store,
            projectPath: (projectId) => this.projectPath(projectId),
            scratchDirectory: (taskId) => chatScratchDirectory(this.home, taskId),
            homes: [homedir()],
          },
          command.payload,
        );
        return exported
          ? { outcome: 'applied', data: { kind: 'chat-export', ...exported } }
          : { outcome: 'blocked', reason: 'task-not-found' };
      }
      case 'ReadChatPrompts':
      case 'SaveChatPrompt':
      case 'DeleteChatPrompt':
        return this.savedPrompts(command);
      case 'ReadDiagnostics':
        return readDiagnostics(
          {
            home: this.home,
            store: this.store,
            profiles: () => this.resolveProfiles(),
            google: () => this.googleDiagnostics(),
          },
          command.payload,
        );
      case 'ReadConnections':
      case 'AddConnection':
      case 'AssignConnection':
      case 'UnassignConnection':
      case 'SetKeepConnected':
      case 'DisconnectConnection':
      case 'ForgetConnection':
        return connectionsCommand(this.connections(), command, effects);
      case 'ReadWritingRules':
        return {
          outcome: 'applied',
          data: { kind: 'writing-rules', ...readWritingRules(this.store.writingRules()) },
        };
      case 'SetWritingRule':
        this.store.putWritingRule({
          ruleId: command.payload.ruleId,
          enabled: command.payload.enabled,
          updatedAt: this.now(),
        });
        return { outcome: 'applied' };
      case 'PreviewWritingRulesExport':
      case 'ExportWritingRules':
        return writingRulesExportCommand(
          { store: this.store, projectPath: (projectId) => this.projectPath(projectId) },
          command,
        );
      case 'ReadProjectNotes':
      case 'AddProjectNote':
      case 'EditProjectNote':
      case 'RemoveProjectNote':
        return notesCommand(this.projectNotes(), command);
      case 'ReadDesignSystem':
      case 'ImportDesignSystem':
      case 'DraftDesignSystem':
      case 'SaveDesignSystem':
      case 'SetDesignSystemDelivery':
      case 'SetDesignPreview':
        return designCommand(this.designSystems(), command);
      case 'ReadRecipes':
      case 'ReadRecipe':
      case 'ResolveRecipeChecks':
      case 'SetRecipeFolder':
      case 'SaveRecipe':
      case 'ForgetRecipe':
        return recipesCommand(this.recipes(), command);
      case 'DraftRecipe':
        return draftCommand(this.store, command.payload);
      case 'RunRecipe':
      case 'ReadRecipeRuns':
        return runsCommand(this.recipeRuns(), command, effects);
      case 'SetRecipeSchedule':
      case 'ReadSchedules':
        return schedulesCommand(this.scheduler(), command, effects);
      case 'ReadResults': {
        const { projectId, recipeId } = command.payload;
        return {
          outcome: 'applied',
          data: { kind: 'results', ...this.results().read(projectId, recipeId) },
        };
      }
      case 'ExportResults':
        return {
          outcome: 'applied',
          data: { kind: 'results-export', ...this.results().page(command.payload) },
        };
      case 'RunDesignCheck':
      case 'ReadDesignFindings':
      case 'ResolveDesignFinding':
        return findingsCommand(this.designChecks(), command);
      case 'ReadRepositoryPolicy':
      case 'SetRepositoryPolicy':
        return policyCommand(
          { store: this.store, now: this.now, projectPath: (id) => this.projectPath(id) },
          command,
        );
      case 'ReadRemoteEffects':
        return this.remoteEffects().read(command.payload);
      case 'ProposeRemoteEffect':
        return this.remoteEffects().propose(command.payload);
      case 'CancelRemoteEffect':
        return this.remoteEffects().cancel(command.payload);
      case 'SettleRemoteEffect':
        return this.remoteEffects().settle(command.payload);
      case 'ReadRemoteEffectPreview':
        return this.remoteEffects().preview(command.payload);
      case 'SetFamilyModel': {
        const { family, selection } = command.payload;
        this.store.setFamilyModel(family, selection);
        return { outcome: 'applied' };
      }
      case 'ReadWebhook':
        return { outcome: 'applied', data: { kind: 'webhook', url: this.store.webhookUrl() } };
      case 'SetWebhook': {
        const url = command.payload.url.trim() === '' ? '' : webhookUrl(command.payload.url);
        if (url === null)
          return {
            outcome: 'blocked',
            reason: 'webhook-address-invalid',
            next: 'That address is not allowed. Use https, or http to this computer.',
          };
        // The address can be a bearer secret, so the receipt keeps no copy of it.
        this.store.setWebhookUrl(url);
        return { outcome: 'applied' };
      }
      case 'SetCreditSpending': {
        const { family, allowed } = command.payload;
        this.store.setCreditSpending(family, allowed);
        // The picker, the rail and Settings read the catalog again on this event.
        const models = this.chatCatalog().families.find((entry) => entry.family === family);
        this.event('chat.catalog', null, 0, {
          family,
          models: Math.min(models?.models.length ?? 0, 64),
          reason: null,
        });
        return { outcome: 'applied' };
      }
      case 'ReadSavedCrews':
      case 'SaveCrew':
      case 'DeleteCrew':
      case 'SetDefaultCrew':
      case 'ImportSavedCrews':
        return crewsCommand(this.savedCrews(), command);
      case 'ReadChatAnalytics': {
        const analytics = readAnalytics(this.store, command.payload, this.now());
        return analytics
          ? { outcome: 'applied', data: { kind: 'chat-analytics', ...analytics } }
          : {
              outcome: 'blocked',
              reason: command.payload.scope === 'thread' ? 'task-not-found' : 'project-not-found',
            };
      }
      case 'ReadChatCatalog':
        this.refreshStaleChatModels();
        return {
          outcome: 'applied',
          data: { kind: 'chat-catalog', ...this.chat().readCatalog(command.payload) },
        };
      case 'ConfigureLocal':
      case 'BeginLocalConnectionInput':
      case 'CancelLocalConnectionInput':
      case 'DisconnectLocal':
      case 'RefreshLocalModels':
      case 'SelectLocalModel':
        return this.localCommand(command, effects);
      case 'PrepareCombinedRun':
        return this.prepareCombined(command);
      case 'AssembleCombinedCandidate':
        return this.assembleCombined(command, effects);
      case 'GetTaskConversation':
        return {
          outcome: 'applied',
          data: this.conversation.page(command.payload.taskId, command.payload.beforeCursor),
        };
      case 'GetTaskConversationState':
        return {
          outcome: 'applied',
          data: {
            kind: 'conversation-state',
            state: this.conversationState(command.payload.taskId),
          },
        };
      case 'InitializeGoogleAcp':
      case 'AuthenticateGoogleAcp':
      case 'DiscoverGoogleAcp':
      case 'RefreshGoogleAcpModels':
      case 'StopGoogleAcpSetup':
        return this.applyAcpSetup(command, effects);
      case 'RecoverGoogleMetadata':
        return recoverGoogleMetadataCommand(this);
      case 'ObserveUsage':
        return this.observeUsage(command, effects);
      case 'RegisterProject': {
        let path: string;
        try {
          path = projectRoot(command.payload.path);
        } catch {
          const problem = gitProblem((this.options.gitState ?? gitState)());
          if (problem)
            return {
              outcome: 'blocked',
              reason: 'git-unavailable',
              next: `${problem}. Install it and put it on your PATH. No new project was registered.`,
            };
          return {
            outcome: 'blocked',
            reason: 'project-folder-unavailable',
            next: 'Choose a readable Git repository root. No new project was registered.',
          };
        }
        if (!ProjectSchema.shape.name.safeParse(basename(path)).success)
          return {
            outcome: 'blocked',
            reason: 'project-folder-name-invalid',
            next: 'Choose a repository root with a folder name of 1 to 200 characters.',
          };
        const existing = this.store.db
          .prepare('SELECT project_id FROM project_paths WHERE path=?')
          .get(path);
        if (existing)
          return {
            outcome: 'already-applied',
            entity: this.store.get<Project>('project', existing.project_id as string),
          };
        const project = ProjectSchema.parse({
          id: this.id('prj'),
          name: basename(path),
          revision: 0,
        });
        this.store.put('project', project.id, project.revision, project);
        this.store.db
          .prepare('INSERT INTO project_paths(project_id,path) VALUES (?,?)')
          .run(project.id, path);
        return { outcome: 'applied', entity: project, revision: 0 };
      }
      case 'InspectSource': {
        const path = this.projectPath(command.payload.projectId);
        if (!path) return { outcome: 'blocked', reason: 'project-not-found' };
        return {
          outcome: 'applied',
          data: { kind: 'source', ...inspectSourceDetails(command.payload.projectId, path) },
        };
      }
      case 'CreateTask': {
        if (!this.store.get('project', command.payload.projectId))
          return { outcome: 'blocked', reason: 'project-not-found' };
        const task = this.createTask(command.payload);
        return { outcome: 'applied', entity: task, revision: task.revision };
      }
      case 'AmendTask': {
        const task = this.store.get<Task>('task', command.payload.taskId);
        if (!task || !['draft', 'stopped', 'interrupted', 'failed'].includes(task.state))
          return {
            outcome: 'blocked',
            reason: 'task-not-amendable',
            next: 'Stop the current work before changing its criteria.',
          };
        const gate = this.draftEditGate(task);
        if (gate) return gate;
        const updated = TaskSchema.parse({
          ...task,
          title: command.payload.title,
          outcome: command.payload.outcome,
          criteria: command.payload.criteria,
          id: task.id,
          revision: task.revision + 1,
          runId: null,
          next: 'Prepare the run.',
        });
        this.store.put('task', updated.id, updated.revision, updated);
        this.event('task.updated', updated.id, updated.revision, updated);
        return { outcome: 'applied', entity: updated, revision: updated.revision };
      }
      case 'AcceptCandidate':
        return this.accept(command, effects);
      case 'ExportPatch':
        return this.exportPatch(command);
      case 'PrepareRun':
        return this.prepare(command);
      case 'PrepareNativeRun':
        return this.prepareNative(command);
      case 'PrepareNativeHandoff':
        return this.prepareNativeHandoff(command);
      case 'StartNativeHandoff':
        return this.startNativeHandoff(command, effects);
      case 'PrepareCandidateEvaluation':
        return this.prepareEvaluation(command, verification);
      case 'StartCandidateEvaluation':
        return this.startEvaluation(command, effects);
      case 'StartCandidateReview':
        return this.startCandidateReview(command, effects);
      case 'StartRun':
      case 'ResumeRun':
        return this.start(command, effects, undefined, undefined, false, undefined, acpContext);
      case 'ResolveApproval':
        return this.resolve(command, effects);
      case 'SwitchRoute':
        return this.switchRoute(command, effects);
      case 'StopRun': {
        const result = this.stop(command, effects);
        if (result.outcome === 'applied')
          effects.push(() => this.taskOperationRuntime?.stopTask(command.payload.taskId));
        const start = this.acpStart;
        if (
          result.outcome === 'applied' &&
          start?.taskId === command.payload.taskId &&
          start.runId === command.payload.runId
        )
          effects.push(() => {
            start.aborted = true;
            if (start.usageKey && this.usageRead?.key === start.usageKey)
              this.usageRead.abort.abort();
          });
        const pending = this.verificationPreparation;
        if (result.outcome === 'applied' && pending?.taskId === command.payload.taskId)
          effects.push(() => pending.abort.abort());
        return result;
      }
      case 'PauseAdmissions': {
        const task = this.store.get<Task>('task', command.payload.taskId);
        const run = this.store.get<Run>('run', command.payload.runId);
        if (!task || !run || task.runId !== run.id)
          return { outcome: 'blocked', reason: 'run-not-current' };
        if (
          this.store.db
            .prepare(
              "SELECT approval_id FROM pending_effects WHERE task_id=? AND state='pending' LIMIT 1",
            )
            .get(task.id)
        )
          return {
            outcome: 'blocked',
            reason: 'approval-already-pending',
            next: 'Resolve the exact pending action, or stop this run.',
          };
        const group = this.store.combinedGroup(run.id);
        if (group) {
          if (group.task_id !== task.id)
            return { outcome: 'blocked', reason: 'combined-member-owned' };
          if (group.phase === 'paused')
            return { outcome: 'applied', entity: task, revision: task.revision };
          if (['stopping', 'stopped', 'unknown', 'blocked', 'accepted'].includes(group.phase))
            return { outcome: 'blocked', reason: 'combined-pause-unavailable' };
          this.store.db
            .prepare('UPDATE combined_groups SET paused_phase=? WHERE run_id=? AND generation=?')
            .run(group.phase, group.run_id, group.generation);
          this.updateCombined(group, 'paused', 'paused');
        }
        if (!this.store.receipt(`paused:${run.id}`))
          this.store.saveReceipt(
            `paused:${run.id}`,
            hashCanonical({ runId: run.id }),
            'local-owner',
            { outcome: 'applied', entity: run },
          );
        const updated = this.updateTask(task, {
          next: 'Admissions paused. The current owned process may finish.',
        });
        this.event('admissions.paused', task.id, updated.revision, {
          runId: run.id,
          reason: 'Admissions were paused explicitly.',
        });
        return { outcome: 'applied', entity: updated, revision: updated.revision };
      }
      case 'GetChanges': {
        const task = this.store.get<Task>('task', command.payload.taskId);
        const candidate = task?.runId ? this.latestCandidate(task.runId) : undefined;
        if (
          candidate &&
          task?.runId &&
          !this.candidateCurrent(this.store.get<Run>('run', task.runId) as Run, candidate)
        )
          return { outcome: 'blocked', reason: 'candidate-binding-changed' };
        return candidate
          ? (this.store.receipt(`changes:${candidate.id}`)?.result ?? {
              outcome: 'blocked',
              reason: 'changes-not-ready',
            })
          : {
              outcome: 'blocked',
              reason: 'candidate-not-ready',
              next: 'Stop the writer and wait for candidate capture.',
            };
      }
      case 'GetArtifact': {
        const artifact = this.store.get<Artifact>('artifact', command.payload.artifactId);
        if (!artifact) return { outcome: 'blocked', reason: 'artifact-not-found' };
        const bytes = this.artifacts.read(artifact.hash);
        const chunk = bytes.subarray(
          command.payload.offset,
          command.payload.offset + command.payload.limit,
        );
        return {
          outcome: 'applied',
          data: {
            kind: 'artifact',
            artifact,
            offset: command.payload.offset,
            encoding: 'base64',
            content: chunk.toString('base64'),
            eof: command.payload.offset + chunk.length >= bytes.length,
          },
        };
      }
      case 'GetTaskActivity': {
        if (!this.store.get<Task>('task', command.payload.taskId))
          return { outcome: 'blocked', reason: 'task-not-found' };
        try {
          return { outcome: 'applied', data: taskActivityPage(this.store.db, command.payload) };
        } catch (error) {
          const oversized = error instanceof Error && error.message === 'activity-event-too-large';
          return {
            outcome: 'blocked',
            reason: oversized ? 'activity-event-too-large' : 'activity-history-unavailable',
            next: oversized
              ? 'One retained event exceeds the page size. No history was skipped.'
              : 'Retained activity could not be read. No history was skipped.',
          };
        }
      }
      case 'GetWorkspaceState':
        return { outcome: 'applied', data: this.workspaceState() };
      case 'GetProjectPage':
      case 'GetTaskPage': {
        try {
          return {
            outcome: 'applied',
            data:
              command.command === 'GetProjectPage'
                ? projectPage(this.store, command.payload)
                : taskPage(this.store, command.payload),
          };
        } catch (error) {
          return {
            outcome: 'blocked',
            reason:
              error instanceof Error &&
              [
                'workspace-page-stale',
                'workspace-page-invalid',
                'workspace-row-too-large',
              ].includes(error.message)
                ? error.message
                : 'workspace-page-unavailable',
            next: 'Refresh workspace state and start a new page sequence.',
          };
        }
      }
      case 'GetSnapshot':
        return {
          outcome: 'applied',
          data: { kind: 'snapshot', snapshot: this.snapshot(command.payload) },
        };
      case 'GetUsage':
        return {
          outcome: 'applied',
          data: { kind: 'usage', windows: this.workspaceState().usage },
        };
      case 'GetHealth': {
        const problem = gitProblem((this.options.gitState ?? gitState)());
        return {
          outcome: 'applied',
          data: {
            kind: 'health',
            status: problem ? 'degraded' : 'ready',
            version: CREWKITE_VERSION,
            blockers: problem ? [problem] : [],
          },
        };
      }
      default:
        return {
          outcome: 'unsupported',
          reason: 'command-not-implemented',
          next: 'This command has no qualified D0 implementation.',
        };
    }
  }

  event(type: Event['type'], taskId: string | null, revision: number, payload: Event['payload']) {
    this.store.append({
      protocol: 1,
      id: this.id('evt'),
      at: this.now(),
      taskId,
      revision,
      type,
      payload,
    });
  }
}

// Controller methods live in the domain files next to this one. Each file is a class whose
// methods take `this: Controller`. The interface merges their types and the loop copies them
// onto the prototype, so a method in any file calls any other through `this`.
export interface Controller
  extends ProjectCommands,
    UsageCommands,
    ProviderCommands,
    RunCommands,
    CombinedCommands,
    CombinedAssemblyCommands,
    CombinedEvaluationCommands,
    NativeRunCommands,
    NativePrepareCommands,
    EvaluationCommands,
    NativeEvidenceCommands,
    NativePlanCommands,
    NativeLaunchCommands,
    WriterCommands,
    RecoveryCommands,
    CandidateCommands,
    AcceptanceCommands {}
for (const part of [
  ProjectCommands,
  UsageCommands,
  ProviderCommands,
  RunCommands,
  CombinedCommands,
  CombinedAssemblyCommands,
  CombinedEvaluationCommands,
  NativeRunCommands,
  NativePrepareCommands,
  EvaluationCommands,
  NativeEvidenceCommands,
  NativePlanCommands,
  NativeLaunchCommands,
  WriterCommands,
  RecoveryCommands,
  CandidateCommands,
  AcceptanceCommands,
])
  for (const name of Object.getOwnPropertyNames(part.prototype))
    if (name !== 'constructor')
      Object.defineProperty(
        Controller.prototype,
        name,
        Object.getOwnPropertyDescriptor(part.prototype, name) as PropertyDescriptor,
      );
