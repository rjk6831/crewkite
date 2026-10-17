import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  AcpApprovalTargetSchema,
  type Approval,
  ApprovalBindingSchema,
  ApprovalSchema,
  type Artifact,
  ArtifactSchema,
  type Attempt,
  AttemptSchema,
  type Candidate,
  type CandidateEvaluationPreview,
  CandidateEvaluationPreviewSchema,
  CandidateEvaluationStartReasonSchema,
  CandidateSchema,
  type CheckResult,
  CheckResultSchema,
  type Command,
  type CommandResult,
  CommandResultSchema,
  CommandSchema,
  type ConversationPlanningSelection,
  ConversationPlanningSelectionSchema,
  type ConversationTurnBinding,
  ConversationTurnBindingSchema,
  canonicalJson,
  type Event,
  EventSchema,
  type FakeWorkerEvent,
  formatReviewTarget,
  GoogleAcpBillingAttestationSchema,
  GoogleAcpSelectionSchema,
  GoogleAcpSetupSchema,
  GoogleNativePermissionModeSchema,
  type Grant,
  GrantSchema,
  HashSchema,
  LimitsSchema,
  MAX_FRAME_BYTES,
  NativeBillingAttestationSchema,
  NativeHandoffPreviewSchema,
  NativeHandoffTargetSchema,
  NativeHandoffTargetsSchema,
  NativeProfileSchema,
  NativeRepositoryExecutionSchema,
  NativeRepositoryScopeSchema,
  type NativeReviewJob,
  NativeReviewJobSchema,
  NativeRunSchema,
  type Observation,
  ObservationSchema,
  type Policy,
  PolicySchema,
  type Project,
  ProjectSchema,
  RemainingBudgetsSchema,
  type ReviewJob,
  ReviewJobSchema,
  ReviewMethodIdSchema,
  ReviewMethodSchema,
  type ReviewResult,
  ReviewResultSchema,
  type Route,
  RouteIdSchema,
  type RouterDecision,
  RouteSchema,
  type Run,
  RunSchema,
  requiredReviewMethodIds,
  type SealedHandoffPacket,
  SealedHandoffPacketSchema,
  type Snapshot,
  SnapshotSchema,
  SourceSchema,
  type Task,
  type TaskConversationState,
  TaskConversationStateSchema,
  TaskIdSchema,
  TaskSchema,
  TimestampSchema,
  UsageReaderSchema,
} from '@crewkite/contracts';
import { hashCanonical, verifyHandoff } from '@crewkite/contracts/hash';
import { fakeReviewWorkerPath, fakeWorkerPath } from '@crewkite/testkit/worker';
import { z } from 'zod';
import { ArtifactFiles } from '../artifacts/index.ts';
import { buildHandoff } from '../continuity/index.ts';
import { type FrozenConversationTurn, TaskConversation } from '../conversation/conversation.ts';
import {
  CandidateEvidence,
  type CheckDefinition,
  CheckDefinitionSchema,
  type CheckPlan,
  completedCheckDefinitionMatches,
} from '../evidence/index.ts';
import {
  assertVerificationSource,
  prepareToolchain,
  type ToolchainPreparation,
  verificationPreview,
  verificationTarget,
} from '../evidence/toolchain-definition.ts';
import { ToolchainVerification } from '../evidence/toolchain-verify.ts';
import { type CheckOwner, inspectCheckRoots, parseCheckOwner } from '../host/check-ownership.ts';
import {
  applyPublication,
  type GitIdentity,
  preparePublication,
  refValue,
  validateIdentity,
} from '../host/publication.ts';
import {
  applyReplacement,
  captureSingleFileEdit,
  committedFiles,
  type FileContent,
  inspectSource,
  inspectSourceDetails,
  materialize,
  projectRoot,
  readFiles,
} from '../host/source.ts';
import type { DependencyInventory } from '../host/toolchain.ts';
import {
  closedWithin,
  defaultSchedule,
  groupAbsent,
  OwnedCommand,
  OwnedWorker,
  type Schedule,
} from '../host/worker.ts';
import {
  type NativeLifecycle as AnthropicLifecycle,
  startNativeAuthStatus,
} from '../providers/anthropic/native-discovery.ts';
import { subscriptionAuth } from '../providers/anthropic/profile.ts';
import {
  replacementPlan as anthropicReplacementPlan,
  startReplacement as startAnthropicReplacement,
} from '../providers/anthropic/replacement.ts';
import {
  type AcpClientIdentity,
  AcpClientPinSchema,
  type AcpProfileResolution,
  type AcpSetupProof,
  AcpSetupProofSchema,
  resolveGoogleAcpProfile,
  validateAcpSetupProof,
} from '../providers/google/acp/profile.ts';
import {
  type AcpDependencies,
  AcpPermissionActionSchema,
  type AcpPermissionProposal,
  type AcpWriterCompletion,
  googleAcpWriterPlan,
  startGoogleAcpSetup,
  startGoogleAcpWriter,
} from '../providers/google/acp/writer.ts';
import {
  type CapturedContext,
  captureContext,
  prepareOwnedContext,
} from '../providers/google/native-extension/connector.ts';
import {
  type GoogleNativeLifecycle,
  GoogleWriterError,
  googleUsageObservations,
  googleWriterPlan,
  startGoogleConfig,
  startGoogleUsage,
  startGoogleWriter,
} from '../providers/google/native-writer.ts';
import {
  type GoogleUsageClientResolution,
  googleUsageDescriptor,
  resolveGoogleUsageClient,
} from '../providers/google/profile.ts';
import {
  type ConversationPlan,
  conversationBindingHash,
  conversationPlan,
  startConversation,
} from '../providers/openai/conversation.ts';
import {
  type NativeProfileResolution,
  unavailableNativeProfile,
} from '../providers/openai/profile.ts';
import {
  ReplacementPathSchema,
  replacementPlan,
  startReplacement,
  type WriterPlan,
} from '../providers/openai/replacement.ts';
import { repositoryPlan, startRepository } from '../providers/openai/repository.ts';
import { type ReviewPlan, reviewPlan, startReview } from '../providers/openai/review.ts';
import { chooseRoute } from '../routing/index.ts';
import { createIds, type IdPrefix } from '../store/ids.ts';
import { type LaunchIntent, Store } from '../store/index.ts';
import { availableAllowance, deriveWindow } from '../usage/index.ts';
import { chargedMinutes, remainingBudgets } from './budgets.ts';

const nativeProviderRestriction: CommandResult = {
  outcome: 'blocked',
  reason: 'provider-policy-restricted',
  next: 'Choose another profile or continue manually in the provider native app. Retained evidence remains available.',
};

const NativeFileAppointmentSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  taskId: TaskIdSchema,
  route: RouteSchema,
  client: z.strictObject({
    executable: z.string().max(4096).refine(isAbsolute),
    sha256: HashSchema,
    version: z.string().min(1).max(200),
  }),
  creditPolicy: z.enum(['ordinary', 'existing-credits']),
  billingAttestation: NativeBillingAttestationSchema.optional(),
  permissionMode: GoogleNativePermissionModeSchema.optional(),
  target: z.strictObject({ path: ReplacementPathSchema, baseHash: HashSchema }),
  consent: z.strictObject({
    nativeTrust: z.literal('accepted'),
    source: z.enum(['explicit', 'policy']),
    policyHash: HashSchema,
    sourceBase: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    criteriaHash: HashSchema,
  }),
  policy: PolicySchema,
  expiresAt: TimestampSchema,
  maximumTaskMs: z.number().int().min(2001).max(300_000),
  maximumSubmissions: z.literal(1),
});
const NativeRepositoryAppointmentSchema = NativeFileAppointmentSchema.omit({
  target: true,
  billingAttestation: true,
  permissionMode: true,
})
  .extend({
    repository: NativeRepositoryScopeSchema,
    execution: NativeRepositoryExecutionSchema,
    billingAttestation: z.never().optional(),
    permissionMode: z.never().optional(),
  })
  .refine(
    (appointment) =>
      appointment.route.family === 'openai' &&
      !Object.hasOwn(appointment, 'billingAttestation') &&
      !Object.hasOwn(appointment, 'permissionMode'),
  );
const NativeAcpAppointmentSchema = NativeFileAppointmentSchema.extend({
  profileId: z.literal('google-acp-v1'),
  client: AcpClientPinSchema.extend({ executable: z.string().max(4096).refine(isAbsolute) }),
  billingAttestation: GoogleAcpBillingAttestationSchema,
  permissionMode: z.literal('request-review'),
  target: NativeFileAppointmentSchema.shape.target.extend({ mode: z.enum(['100644', '100755']) }),
  acp: GoogleAcpSelectionSchema,
  proof: AcpSetupProofSchema,
  proofHash: HashSchema,
});
const NativeAppointmentSchema = z.union([
  NativeFileAppointmentSchema,
  NativeRepositoryAppointmentSchema,
  NativeAcpAppointmentSchema,
]);
export type NativePilotAppointment = z.infer<typeof NativeAppointmentSchema>;
const NativePublicScopeSchema = z.strictObject({
  profileId: z.string().min(1).max(200),
  locationHash: HashSchema,
  scopeHash: HashSchema,
  manualTargetsHash: HashSchema.optional(),
  context: z.strictObject({
    title: z.string().min(1).max(200),
    outcome: z.string().min(1).max(4096),
  }),
});
const NativeHistoricalPreparationSchema = z
  .strictObject({
    appointment: NativeAppointmentSchema,
    run: RunSchema,
    attempt: AttemptSchema,
    manifest: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(4096),
          mode: z.enum(['100644', '100755']),
          hash: HashSchema,
          bytes: z.number().int().nonnegative(),
        }),
      )
      .max(10000),
    originalHash: HashSchema.optional(),
    anthropicSessionId: z.uuid().optional(),
    public: NativePublicScopeSchema.optional(),
    handoff: z.lazy(() => NativeManualLinkSchema).optional(),
  })
  .refine((plan) =>
    'repository' in plan.appointment
      ? !plan.originalHash && !plan.anthropicSessionId && !plan.handoff
      : !!plan.originalHash,
  );
const NativePreparationSchema = NativeHistoricalPreparationSchema.safeExtend({
  public: NativePublicScopeSchema,
});
type NativeBinding = {
  appointment: NativePilotAppointment;
  run: Run;
  attempt: Attempt;
  original?: string;
  anthropicSessionId?: string;
  baseHash?: string;
  manifest: Omit<ReturnType<typeof readFiles>[number], 'content'>[];
  planArtifact: Artifact;
  public?: z.infer<typeof NativePublicScopeSchema>;
  environment?: NodeJS.ProcessEnv;
  handoff?: z.infer<typeof NativeManualLinkSchema>;
  context?: CapturedContext;
};
const NativeManualRosterSchema = z.strictObject({
  runId: RunSchema.shape.id,
  targets: z
    .array(
      z.strictObject({
        target: NativeHandoffTargetSchema,
        profile: NativeProfileSchema,
        client: NativeFileAppointmentSchema.shape.client,
        locationHash: HashSchema,
        route: RouteSchema,
      }),
    )
    .min(1)
    .max(3),
});
const NativeManualPreparationSchema = z.strictObject({
  version: z.literal(1),
  runId: RunSchema.shape.id,
  fromAttemptId: AttemptSchema.shape.id,
  attemptId: AttemptSchema.shape.id,
  generation: AttemptSchema.shape.generation,
  recipient: NativeHandoffTargetSchema,
  profile: NativeProfileSchema,
  client: NativeFileAppointmentSchema.shape.client,
  locationHash: HashSchema,
  route: RouteSchema,
  billingAttestation: NativeBillingAttestationSchema.optional(),
  permissionMode: GoogleNativePermissionModeSchema.optional(),
  candidate: CandidateSchema,
  packet: SealedHandoffPacketSchema,
  target: z.strictObject({
    path: ReplacementPathSchema,
    baseHash: HashSchema,
    bytes: z.number().int().nonnegative().max(65536),
  }),
  authority: z.strictObject({
    action: z.literal('write-scratch'),
    target: z.string().min(1).max(200),
    consent: z.literal('explicit'),
    policyHash: HashSchema,
    criteriaHash: HashSchema,
    expiresAt: TimestampSchema,
  }),
});
const NativeManualLinkSchema = z.strictObject({
  preparationId: ArtifactSchema.shape.id,
  preparation: NativeManualPreparationSchema,
});
const EvaluationConsentSchema = z.strictObject({
  scopeHash: HashSchema,
  expiresAt: TimestampSchema,
});
const CandidateEvaluationSchema = z
  .strictObject({
    run: RunSchema,
    writer: AttemptSchema,
    candidate: CandidateSchema,
    context: z.strictObject({
      title: z.string().min(1).max(200),
      outcome: z.string().min(1).max(4096),
      criteria: z.array(z.string().min(1).max(4096)).min(1).max(100),
    }),
    definition: CheckDefinitionSchema,
    reviewer: z.strictObject({
      profileId: z.string().min(1).max(200),
      methodId: ReviewMethodIdSchema,
      cycles: z.literal(1),
      role: ReviewMethodSchema.shape.reviewerRole,
      profile: NativeProfileSchema,
      client: NativeFileAppointmentSchema.shape.client,
      locationHash: HashSchema,
    }),
    creditPolicy: z.enum(['ordinary', 'existing-credits']),
    grants: z.array(GrantSchema).length(2),
    remaining: RemainingBudgetsSchema,
    maximumCheckMinutes: z.union([z.literal(1), z.literal(5)]),
    verification: z
      .strictObject({ source: z.string().max(4096).refine(isAbsolute), inventory: ArtifactSchema })
      .optional(),
    scopeHash: HashSchema,
    expiresAt: TimestampSchema,
  })
  .refine((plan) =>
    plan.definition.recipeId === 'crewkite-verify-v1'
      ? plan.maximumCheckMinutes === 5 &&
        !!plan.verification &&
        plan.verification.inventory.hash === plan.definition.inventory.hash &&
        plan.verification.inventory.bytes === plan.definition.inventory.bytes
      : plan.maximumCheckMinutes === 1 && !Object.hasOwn(plan, 'verification'),
  );
type PreparedVerification = ToolchainPreparation & { lineageHash: string; sourcePath: string };
type NativeOutcome = {
  metadata:
    | Awaited<ReturnType<typeof startReplacement>['result']>['metadata']
    | Awaited<ReturnType<typeof startRepository>['result']>['metadata']
    | (NonNullable<Awaited<ReturnType<typeof startAnthropicReplacement>['result']>['proposal']> & {
        family: 'anthropic';
        sessionId: string;
        model: string;
        requestedEffort: 'medium';
        effectiveEffort: 'unknown';
        authHash: string;
        billingAttestation: z.infer<typeof NativeBillingAttestationSchema>;
      })
    | (AcpWriterCompletion & { family: 'google-acp' })
    | (NonNullable<Awaited<ReturnType<typeof startGoogleWriter>['result']>['metadata']> & {
        family: 'google';
        model: string;
        requestedEffort: 'low';
        effectiveEffort: 'unknown';
        permissionMode: z.infer<typeof GoogleNativePermissionModeSchema>;
        configHash: string;
        billingAttestation: z.infer<typeof NativeBillingAttestationSchema>;
        qualified: false;
      })
    | null;
  reason: string | null;
  quiescent: boolean;
  diagnostic: unknown;
};
type AcpSetupCommand = Extract<
  Command,
  {
    command:
      | 'InitializeGoogleAcp'
      | 'AuthenticateGoogleAcp'
      | 'DiscoverGoogleAcp'
      | 'StopGoogleAcpSetup';
  }
>;
type NativeRuntime = {
  kind: 'native';
  binding: NativeBinding;
  stopped: boolean;
  handle?: { result: Promise<NativeOutcome>; stop: () => void };
  done?: Promise<void>;
  reason?: 'handoff' | 'stop' | 'switch';
  acpHandle?: ReturnType<typeof startGoogleAcpWriter>;
};
type NativeReviewRuntime = {
  preparation: Artifact;
  job: NativeReviewJob;
  input: ReviewPlan;
  attempt: Attempt;
  stopped: boolean;
  handle?: ReturnType<typeof startReview>;
  done: Promise<void>;
};
type FakeRuntime = {
  kind: 'fake';
  worker: OwnedWorker;
  terminal?: Extract<FakeWorkerEvent, { type: 'terminal' }>;
  reason?: 'handoff' | 'stop' | 'switch';
  failure?: string;
  cancel?: () => void;
};
function freezeNative<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeNative(child);
    Object.freeze(value);
  }
  return value;
}

const ConversationConfigurationSchema = z.strictObject({
  revision: z.number().int().nonnegative().safe(),
  contractStatus: z.enum(['provisional', 'confirmed']),
  contextCriteria: z.array(z.string().min(1).max(4096)).max(100),
  selection: ConversationPlanningSelectionSchema,
  routeId: RouteSchema.shape.id,
  source: SourceSchema,
  profileHash: HashSchema,
  client: z
    .strictObject({
      executable: z.string().max(4096).refine(isAbsolute),
      sha256: HashSchema,
      version: z.string().min(1).max(200),
    })
    .nullable(),
  locationHash: HashSchema.nullable(),
  limits: LimitsSchema,
  paused: z.boolean(),
  adoptedProposal: z
    .strictObject({
      id: z.string(),
      hash: HashSchema,
      runId: RunSchema.shape.id,
      revision: z.number().int().nonnegative().safe(),
    })
    .nullable(),
  effectiveModel: z.string().min(1).max(200).nullable(),
  effectiveEffort: z.string().min(1).max(200).nullable(),
});
type ConversationConfiguration = z.infer<typeof ConversationConfigurationSchema>;
type ConversationRuntime = {
  input: ConversationPlan;
  attempt: Attempt;
  authorityHash: string;
  stopped: boolean;
  handle?: ReturnType<typeof startConversation>;
  done: Promise<void>;
};

export type ControllerOptions = {
  home: string;
  now?: () => string;
  id?: (prefix: IdPrefix) => string;
  routes?: Route[];
  observations?: Observation[];
  workerPath?: string;
  identity?: GitIdentity | (() => GitIdentity | undefined);
  scenarioForRoute?: (
    route: Route,
    generation: number,
  ) => Extract<import('@crewkite/contracts').FakeWorkerInput, { type: 'start' }>['scenario'];
  afterIntent?: (intent: LaunchIntent) => void;
  schedule?: Schedule;
  nativeProfile?: () => NativeProfileResolution;
  nativeProfiles?: () => NativeProfileResolution[];
  nativeSpawn?: Parameters<typeof startReplacement>[2]['spawn'];
  googleUsageClient?: () => GoogleUsageClientResolution;
  googleUsageSpawn?: Parameters<typeof startGoogleUsage>[0]['spawn'];
  googleAcp?: AcpDependencies & {
    resolve?: (proof: AcpSetupProof | null) => AcpProfileResolution;
    spawn?: Parameters<typeof startGoogleAcpSetup>[0]['spawn'];
  };
  registerGoogleAcp?: boolean;
  prepareVerification?: typeof prepareToolchain;
};
const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const runtimeRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export class Controller {
  readonly store!: Store;
  readonly home: string;
  readonly now: () => string;
  readonly id: (prefix: IdPrefix) => string;

  private artifacts!: ArtifactFiles;
  private evidence!: CandidateEvidence;
  private readonly cancelledJobs = new Set<string>();
  private readonly jobCancels = new Map<string, () => void>();
  private readonly reviewWorkers = new Map<string, OwnedWorker>();
  private readonly jobs = new Map<string, OwnedCommand | ToolchainVerification>();
  private verificationPreparation?: {
    key: string;
    hash: string;
    principal: string;
    taskId: string;
    abort: AbortController;
    promise: Promise<CommandResult>;
  };
  private readonly nativeReviewWorkers = new Map<string, NativeReviewRuntime>();
  private readonly conversationWorkers = new Map<string, ConversationRuntime>();
  private readonly pendingConversationLaunches = new Set<string>();
  private conversation!: TaskConversation;
  private readonly owner: DatabaseSync;
  private closed = false;
  private readonly options: ControllerOptions;
  private profiles: NativeProfileResolution[];
  private closing?: Promise<void>;
  private readonly workers = new Map<string, FakeRuntime | NativeRuntime>();
  private usageResolution: GoogleUsageClientResolution;
  private usageRead?: {
    key: string;
    hash: string;
    principal: string;
    abort: AbortController;
    promise: Promise<CommandResult>;
    resolve: (result: CommandResult) => void;
  };
  private acpSetupRuntime?: {
    key: string;
    hash: string;
    principal: string;
    promise: Promise<CommandResult>;
    resolve: (result: CommandResult) => void;
    handle?: ReturnType<typeof startGoogleAcpSetup>;
    stopped: boolean;
  };
  private acpStart?: {
    key: string;
    hash: string;
    principal: string;
    taskId: string;
    runId: string;
    aborted: boolean;
    promise: Promise<CommandResult>;
  };

  constructor(options: ControllerOptions) {
    this.options = options;
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
      this.conversation = new TaskConversation(this.store, {
        now: this.now,
        messageId: () => this.id('msg'),
        publish: (entries, task) => {
          this.event('task.updated', task.id, task.revision, task);
          for (const entry of entries)
            this.event('conversation.entry', task.id, task.revision, entry);
        },
        ownsTurn: (binding, phase) => this.ownsConversationTurn(binding, phase),
      });
      this.recover();
      for (const row of this.store.db
        .prepare("SELECT candidate_id FROM publications WHERE state='prepared'")
        .all())
        this.reconcilePublication(row.candidate_id as string);
    } catch (error) {
      this.store?.close();
      this.owner.close();
      throw error;
    }
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
    if (
      [
        'InitializeGoogleAcp',
        'AuthenticateGoogleAcp',
        'DiscoverGoogleAcp',
        'StopGoogleAcpSetup',
      ].includes(command.command)
    )
      return this.executeAcpSetup(command as AcpSetupCommand, principal);
    if (command.command === 'StartRun' && this.isPreparedAcp(command.payload.runId))
      return this.executeAcpStart(command, principal);
    if (command.command === 'ObserveUsage') return this.observeUsageCommand(command, principal);
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
      this.store.receipt(`native-run:${command.payload.runId}`)
    )
      return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
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

  private commitCommand(
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
    const result = this.store.transaction<CommandResult>(() => {
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
    for (const effect of effects) effect();
    return effects.length > 0 && result.outcome === 'outcome-unknown'
      ? (this.store.receipt(command.key)?.result ?? result)
      : result;
  }

  snapshot(): Snapshot {
    const candidateEvaluations = this.candidateEvaluations();
    return SnapshotSchema.parse({
      protocol: 1,
      nativeProfiles: this.profiles.map((profile) => profile.facts),
      googleAcpSetup: this.store.googleAcpSetup(),
      usageReaders: [this.googleUsageReader()],
      nativeRuns: this.nativeRuns(),
      candidateEvaluations,
      cursor: this.store.cursor(),
      projects: this.store.list('project'),
      tasks: this.store.list('task'),
      runs: this.store.list('run'),
      attempts: this.store.list('attempt'),
      routes: this.store.list('route'),
      approvals: this.store.list('approval'),
      candidates: this.store.list('candidate'),
      artifacts: this.store.list('artifact'),
      reviewJobs: this.store.db
        .prepare('SELECT body FROM review_jobs')
        .all()
        .map((row) => JSON.parse(row.body as string)),
      evidence: this.store.db
        .prepare('SELECT body FROM evidence')
        .all()
        .map((row) => JSON.parse(row.body as string)),
      usage: this.store
        .list<Observation>('window')
        .map((observation) =>
          deriveWindow(observation, { nowMs: Date.parse(this.now()), maxAgeMs: 300000 }),
        ),
    });
  }

  private googleUsageReader() {
    const reader = this.store.googleUsageReader();
    const enabled = reader.enabled === 1;
    const reason = this.usageResolution.available
      ? enabled
        ? 'available'
        : 'not-enabled'
      : this.usageResolution.reason;
    return UsageReaderSchema.parse({
      id: googleUsageDescriptor.id,
      family: 'google',
      clientVersion: googleUsageDescriptor.clientVersion,
      available: enabled && this.usageResolution.available,
      reason,
      enabled,
      lastObservedAt: reader.last_observed_at,
      lastAttemptAt: reader.last_attempt_at,
    });
  }

  private executeAcpSetup(command: AcpSetupCommand, principal: string): Promise<CommandResult> {
    const prior = this.acpSetupRuntime;
    const hash = hashCanonical(command);
    if (prior?.key === command.key)
      return prior.hash === hash && prior.principal === principal
        ? prior.promise
        : Promise.resolve({ outcome: 'denied', reason: 'idempotency-key-reused' });
    if (command.command === 'StopGoogleAcpSetup' || prior || this.store.receipt(command.key)) {
      let result = this.commitCommand(command, principal);
      if (result.reason === 'acp-setup-pending') {
        this.store.transaction(() => {
          const journal = this.store
            .googleMetadataOperations()
            .find((row) => row.command_id === command.key);
          const known = journal?.state === 'quiescent';
          if (!known) this.store.unknownGoogleMetadata(command.key);
          let setup = this.store.googleAcpSetup();
          if (setup.operationId === command.key) {
            setup = GoogleAcpSetupSchema.parse({
              ...setup,
              revision: setup.revision + 1,
              state: known ? 'blocked' : 'unknown',
              operationId: known ? null : command.key,
            });
            this.store.putGoogleAcpSetup(setup);
          }
          result = {
            outcome: known ? 'blocked' : 'outcome-unknown',
            reason: known ? 'acp-setup-interrupted' : 'google-ownership-unknown',
            data: { kind: 'google-acp-setup', setup },
          };
          this.finishMetadataReceipt(command.key, result);
        });
      }
      return Promise.resolve(result);
    }
    const completion = Promise.withResolvers<CommandResult>();
    const runtime = {
      key: command.key,
      hash,
      principal,
      promise: completion.promise,
      resolve: completion.resolve,
      stopped: false,
    };
    this.acpSetupRuntime = runtime;
    try {
      const result = this.commitCommand(command, principal);
      if (result.reason !== 'acp-setup-pending') completion.resolve(result);
    } catch (error) {
      if (this.acpSetupRuntime === runtime) this.acpSetupRuntime = undefined;
      throw error;
    }
    return runtime.promise.finally(() => {
      if (this.acpSetupRuntime === runtime) this.acpSetupRuntime = undefined;
    });
  }

  private applyAcpSetup(command: AcpSetupCommand, effects: (() => void)[]): CommandResult {
    const setup = this.store.googleAcpSetup();
    if (command.command === 'StopGoogleAcpSetup') {
      if (
        setup.operationId !== command.payload.operationId ||
        !['initializing', 'authenticating', 'discovering', 'stopping'].includes(setup.state)
      )
        return {
          outcome: 'blocked',
          reason: 'acp-setup-not-current',
          data: { kind: 'google-acp-setup', setup },
        };
      const runtime = this.acpSetupRuntime;
      const live = runtime?.key === setup.operationId;
      const next = GoogleAcpSetupSchema.parse({
        ...setup,
        revision: setup.revision + 1,
        state: live ? 'stopping' : 'unknown',
      });
      this.store.putGoogleAcpSetup(next);
      if (live)
        effects.push(() => {
          runtime.stopped = true;
          runtime.handle?.stop();
        });
      return {
        outcome: live ? 'applied' : 'outcome-unknown',
        ...(!live ? { reason: 'google-ownership-unknown' } : {}),
        data: { kind: 'google-acp-setup', setup: next },
      };
    }
    const blocker = this.store.googleOperationBlocker();
    if (blocker)
      return { outcome: 'blocked', reason: blocker, data: { kind: 'google-acp-setup', setup } };
    const resolution = this.acpResolution();
    if (!resolution.client || !resolution.environment)
      return {
        outcome: 'blocked',
        reason: resolution.facts.reason,
        data: { kind: 'google-acp-setup', setup },
      };
    const operation =
      command.command === 'InitializeGoogleAcp'
        ? 'initialize'
        : command.command === 'AuthenticateGoogleAcp'
          ? 'authenticate'
          : 'discover';
    let proof: AcpSetupProof | null = null;
    try {
      if (operation !== 'initialize') {
        if (!('proofId' in command.payload) || command.payload.proofId !== setup.proofId)
          throw Error('ACP proof changed.');
        proof = this.acpProof(command.payload.proofId);
        validateAcpSetupProof(proof, resolution.client, this.options.googleAcp?.reviewMappings);
      }
    } catch {
      return {
        outcome: 'blocked',
        reason: 'acp-proof-unavailable',
        data: { kind: 'google-acp-setup', setup },
      };
    }
    const state = {
      initialize: 'initializing',
      authenticate: 'authenticating',
      discover: 'discovering',
    }[operation];
    const next = GoogleAcpSetupSchema.parse({
      ...setup,
      revision: setup.revision + 1,
      state,
      operationId: command.key,
      reason: null,
    });
    this.store.putGoogleAcpSetup(next);
    this.store.beginGoogleMetadata(command.key, `acp-${operation}`, next.revision, this.now());
    effects.push(
      () => void this.launchAcpSetup(command.key, next.revision, operation, proof, resolution),
    );
    return {
      outcome: 'outcome-unknown',
      reason: 'acp-setup-pending',
      data: { kind: 'google-acp-setup', setup: next },
    };
  }

  private async launchAcpSetup(
    commandId: string,
    revision: number,
    operation: 'initialize' | 'authenticate' | 'discover',
    priorProof: AcpSetupProof | null,
    resolution: AcpProfileResolution,
  ) {
    const runtime = this.acpSetupRuntime;
    if (!runtime || runtime.key !== commandId || !resolution.client || !resolution.environment)
      return;
    let result: CommandResult = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
    let beforeSpawn = true;
    const current = () => {
      const setup = this.store.googleAcpSetup();
      if (
        this.closed ||
        runtime.stopped ||
        setup.operationId !== commandId ||
        setup.revision !== revision ||
        !['initializing', 'authenticating', 'discovering'].includes(setup.state)
      )
        throw Error('ACP setup authority changed.');
    };
    try {
      current();
      const directory = mkdtempSync(join(this.home, 'google-acp-setup-'));
      runtime.handle = startGoogleAcpSetup({
        client: resolution.client,
        directory,
        environment: resolution.environment,
        operation,
        priorProof,
        ...this.options.googleAcp,
        spawn: this.options.googleAcp?.spawn,
        schedule: this.options.schedule,
        lifecycle: {
          beforePhase: () => {
            current();
            beforeSpawn = false;
          },
          owned: (group) => {
            this.store.transaction(() => this.store.ownGoogleMetadata(commandId, group));
            current();
          },
          quiescent: (group) =>
            this.store.transaction(() =>
              this.store.finishGoogleMetadata(commandId, group, this.now()),
            ),
        },
      });
      if (runtime.stopped || this.closed) runtime.handle.stop();
      const outcome = await runtime.handle.result;
      this.store.transaction(() => {
        let setup = this.store.googleAcpSetup();
        const journal = this.store
          .googleMetadataOperations()
          .find((row) => row.command_id === commandId);
        const known = outcome.quiescent && journal?.state === 'quiescent';
        if (!known) this.store.unknownGoogleMetadata(commandId);
        const revoked =
          this.closed ||
          runtime.stopped ||
          setup.operationId !== commandId ||
          setup.revision !== revision;
        let proofId = setup.proofId,
          client = setup.client,
          auth = setup.auth;
        let ready = false;
        if (known && !revoked && !outcome.reason && outcome.metadata) {
          const proof = validateAcpSetupProof(
            outcome.metadata,
            resolution.client as AcpClientIdentity,
            this.options.googleAcp?.reviewMappings,
          );
          proofId = this.nativeArtifact(proof).id;
          client = proof.client;
          auth = proof.auth;
          ready =
            !!proof.reviewMode && !!proof.configOptions && proof.auth.status === 'authenticated';
        }
        setup = GoogleAcpSetupSchema.parse({
          ...setup,
          revision: setup.revision + 1,
          state: !known
            ? 'unknown'
            : ready
              ? 'ready'
              : !revoked && !outcome.reason && operation === 'initialize'
                ? 'authentication-required'
                : 'blocked',
          operationId: known ? null : commandId,
          proofId,
          client,
          auth,
          reason: ready
            ? null
            : outcome.reason === 'authentication'
              ? 'authentication-required'
              : !revoked && operation === 'discover'
                ? 'acp-capability-missing'
                : null,
        });
        this.store.putGoogleAcpSetup(setup);
        result = {
          outcome: !known ? 'outcome-unknown' : revoked || outcome.reason ? 'blocked' : 'applied',
          ...(!known || revoked || outcome.reason
            ? {
                reason: !known
                  ? 'google-ownership-unknown'
                  : revoked
                    ? 'acp-setup-stopped'
                    : 'acp-setup-failed',
              }
            : {}),
          data: { kind: 'google-acp-setup', setup },
        };
        this.finishMetadataReceipt(commandId, result);
        this.profiles = this.resolveProfiles();
      });
    } catch {
      try {
        this.store.transaction(() => {
          const journal = this.store
            .googleMetadataOperations()
            .find((row) => row.command_id === commandId);
          if (beforeSpawn && journal?.state === 'intent')
            this.store.finishGoogleMetadata(commandId, null, this.now());
          else if (journal?.state !== 'quiescent') this.store.unknownGoogleMetadata(commandId);
          const known =
            this.store.googleMetadataOperations().find((row) => row.command_id === commandId)
              ?.state === 'quiescent';
          const setup = this.store.googleAcpSetup();
          const next = GoogleAcpSetupSchema.parse({
            ...setup,
            revision: setup.revision + 1,
            state: known ? 'blocked' : 'unknown',
            operationId: known ? null : commandId,
            reason: null,
          });
          this.store.putGoogleAcpSetup(next);
          result = {
            outcome: known ? 'blocked' : 'outcome-unknown',
            reason: known ? 'acp-setup-failed' : 'google-ownership-unknown',
            data: { kind: 'google-acp-setup', setup: next },
          };
          this.finishMetadataReceipt(commandId, result);
        });
      } catch {
        result = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
      }
    } finally {
      runtime.resolve(CommandResultSchema.parse(result));
    }
  }

  private observeUsageCommand(
    command: Extract<Command, { command: 'ObserveUsage' }>,
    principal: string,
  ): Promise<CommandResult> {
    const prior = this.usageRead;
    const hash = hashCanonical(command);
    if (prior?.key === command.key)
      return prior.hash === hash && prior.principal === principal
        ? prior.promise
        : Promise.resolve({ outcome: 'denied', reason: 'idempotency-key-reused' });
    if (command.payload.consent === false || prior || this.store.receipt(command.key)) {
      let result = this.commitCommand(command, principal);
      if (result.outcome === 'outcome-unknown' && result.reason === 'usage-read-pending') {
        result = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
        this.store.transaction(() => this.finishMetadataReceipt(command.key, result));
      }
      return Promise.resolve(result);
    }
    const completion = Promise.withResolvers<CommandResult>();
    const pending = {
      key: command.key,
      hash,
      principal,
      abort: new AbortController(),
      promise: completion.promise,
      resolve: completion.resolve,
    };
    this.usageRead = pending;
    try {
      const result = this.commitCommand(command, principal);
      if (result.outcome !== 'outcome-unknown' || result.reason !== 'usage-read-pending')
        completion.resolve(result);
    } catch (error) {
      if (this.usageRead === pending) this.usageRead = undefined;
      throw error;
    }
    return pending.promise.finally(() => {
      if (this.usageRead === pending) this.usageRead = undefined;
    });
  }

  private observeUsage(
    command: Extract<Command, { command: 'ObserveUsage' }>,
    effects: (() => void)[],
  ): CommandResult {
    if (command.payload.consent !== undefined)
      this.store.setGoogleUsageConsent(command.payload.consent);
    if (command.payload.consent === false) {
      effects.push(() => this.usageRead?.abort.abort());
      return { outcome: 'applied', data: { kind: 'usage', windows: this.snapshot().usage } };
    }
    const reader = this.store.googleUsageReader();
    if (!reader.enabled) return { outcome: 'blocked', reason: 'usage-reader-not-enabled' };
    const now = this.now();
    if (reader.last_attempt_at && Date.parse(now) - Date.parse(reader.last_attempt_at) < 60000)
      return {
        outcome: 'blocked',
        reason: 'usage-reader-cooldown',
        next: `Refresh after ${new Date(Date.parse(reader.last_attempt_at) + 60000).toISOString()}.`,
      };
    const blocker = this.store.googleOperationBlocker();
    if (blocker) return { outcome: 'blocked', reason: blocker };
    this.store.recordGoogleUsageAttempt(now);
    try {
      this.usageResolution = this.options.googleUsageClient?.() ?? resolveGoogleUsageClient();
    } catch {
      this.usageResolution = { available: false, reason: 'client-unavailable' };
    }
    if (!this.usageResolution.available)
      return { outcome: 'blocked', reason: this.usageResolution.reason };
    this.store.beginGoogleMetadata(command.key, 'usage', reader.authority_revision, now);
    const resolution = this.usageResolution;
    effects.push(
      () => void this.launchGoogleUsage(command.key, reader.authority_revision, resolution),
    );
    return { outcome: 'outcome-unknown', reason: 'usage-read-pending' };
  }

  private async launchGoogleUsage(
    commandId: string,
    authorityRevision: number,
    resolution: Extract<GoogleUsageClientResolution, { available: true }>,
  ) {
    const runtime = this.usageRead;
    if (!runtime || runtime.key !== commandId) return;
    let result: CommandResult = { outcome: 'blocked', reason: 'usage-read-failed' };
    let beforeSpawn = true;
    const current = () => {
      const reader = this.store.googleUsageReader();
      if (
        this.closed ||
        runtime.abort.signal.aborted ||
        !reader.enabled ||
        reader.authority_revision !== authorityRevision
      )
        throw new Error('usage-read-revoked');
      const operation = this.store
        .googleMetadataOperations()
        .find((row) => row.command_id === commandId);
      if (!operation || !['intent', 'owned'].includes(operation.state))
        throw new Error('google-ownership-unknown');
    };
    try {
      current();
      const directory = mkdtempSync(join(this.home, 'google-usage-'));
      const temporaryDirectory = mkdtempSync(join(this.home, 'google-usage-tmp-'));
      const handle = startGoogleUsage({
        client: resolution.client,
        repositoryRoot: this.home,
        directory,
        temporaryDirectory,
        environment: resolution.environment,
        timeoutMs: googleUsageDescriptor.maximumReadMs,
        signal: runtime.abort.signal,
        spawn: this.options.googleUsageSpawn,
        schedule: this.options.schedule,
        lifecycle: {
          beforePhase: () => {
            current();
            beforeSpawn = false;
          },
          owned: (_, group) => {
            this.store.transaction(() => this.store.ownGoogleMetadata(commandId, group));
            current();
          },
          quiescent: (_, group) =>
            this.store.transaction(() =>
              this.store.finishGoogleMetadata(commandId, group, this.now()),
            ),
        },
      });
      const outcome = await handle.result;
      this.store.transaction(() => {
        if (!outcome.quiescent) this.store.unknownGoogleMetadata(commandId);
        const reader = this.store.googleUsageReader();
        const operation = this.store
          .googleMetadataOperations()
          .find((row) => row.command_id === commandId);
        if (operation?.state !== 'quiescent') this.store.unknownGoogleMetadata(commandId);
        if (
          this.closed ||
          runtime.abort.signal.aborted ||
          !reader.enabled ||
          reader.authority_revision !== authorityRevision
        )
          result = { outcome: 'blocked', reason: 'usage-read-revoked' };
        else if (!outcome.quiescent || operation?.state !== 'quiescent')
          result = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
        else if (!outcome.reason && outcome.metadata) {
          const observedAt = this.now();
          let routes = this.store
            .list<Route>('route')
            .filter((route) => route.family === 'google' && !route.fake);
          if (!routes.length) {
            const route = RouteSchema.parse({
              id: this.id('rte'),
              family: 'google',
              displayName: 'Google',
              model: 'unknown',
              effort: { requested: 'unknown', effective: 'unknown', supported: [] },
              billing: 'included',
              qualified: false,
              fake: false,
            });
            this.store.put('route', route.id, 0, route);
            this.store.saveReceipt('usage-route:google', hashCanonical(route), 'local-owner', {
              outcome: 'applied',
            });
            routes = [route];
          }
          for (const observation of googleUsageObservations(
            outcome.metadata,
            routes.map((route) => route.id),
            observedAt,
          )) {
            this.store.put(
              'window',
              `${observation.routeId}/${observation.windowId}`,
              0,
              ObservationSchema.parse(observation),
            );
            this.event('usage.observed', null, 0, observation);
          }
          this.store.recordGoogleUsageObservation(observedAt);
          result = { outcome: 'applied', data: { kind: 'usage', windows: this.snapshot().usage } };
        }
        this.finishMetadataReceipt(commandId, result);
      });
    } catch (error) {
      result = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
      try {
        this.store.transaction(() => {
          const operation = this.store
            .googleMetadataOperations()
            .find((row) => row.command_id === commandId);
          if (
            operation?.state === 'intent' &&
            (beforeSpawn || (error instanceof GoogleWriterError && error.reason === 'start'))
          )
            this.store.finishGoogleMetadata(commandId, null, this.now());
          else if (operation?.state !== 'quiescent') this.store.unknownGoogleMetadata(commandId);
          const reader = this.store.googleUsageReader();
          const finished = this.store
            .googleMetadataOperations()
            .find((row) => row.command_id === commandId);
          if (!reader.enabled || reader.authority_revision !== authorityRevision || this.closed)
            result = { outcome: 'blocked', reason: 'usage-read-revoked' };
          else if (finished?.state === 'quiescent')
            result = { outcome: 'blocked', reason: 'usage-read-failed' };
          this.finishMetadataReceipt(commandId, result);
        });
      } catch {
        // A failed persistence boundary leaves the committed ownership intent in place.
        result = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
      }
    } finally {
      runtime.resolve(CommandResultSchema.parse(result));
    }
  }

  private finishMetadataReceipt(commandId: string, result: CommandResult) {
    this.store.db
      .prepare('UPDATE receipts SET result=? WHERE command_key=?')
      .run(canonicalJson(CommandResultSchema.parse(result)), commandId);
  }

  subscribe(listener: (event: Event) => void): () => void {
    return this.store.subscribe(listener);
  }
  close(): void | Promise<void> {
    if (this.closed) return this.closing;
    this.closed = true;
    const native: Promise<unknown>[] = [];
    if (this.acpStart) {
      this.acpStart.aborted = true;
      native.push(this.acpStart.promise);
    }
    if (this.acpSetupRuntime) {
      this.acpSetupRuntime.stopped = true;
      this.acpSetupRuntime.handle?.stop();
      native.push(this.acpSetupRuntime.promise);
    }
    if (this.usageRead) {
      this.usageRead.abort.abort();
      native.push(this.usageRead.promise);
    }
    if (this.verificationPreparation) {
      this.verificationPreparation.abort.abort();
      native.push(this.verificationPreparation.promise);
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
    for (const runtime of this.conversationWorkers.values()) {
      runtime.stopped = true;
      runtime.handle?.stop();
      native.push(runtime.done);
    }
    for (const runtime of this.nativeReviewWorkers.values()) {
      runtime.stopped = true;
      runtime.handle?.stop();
      native.push(runtime.done);
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

  private checkRevision(command: Command): CommandResult | undefined {
    if (!('expectedRevision' in command)) return;
    if (
      [
        'InitializeGoogleAcp',
        'AuthenticateGoogleAcp',
        'DiscoverGoogleAcp',
        'StopGoogleAcpSetup',
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
    if (
      command.command === 'RegisterProject' ||
      command.command === 'CreateTask' ||
      command.command === 'CreateTaskDiscussion' ||
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
        : command.payload.taskId;
    const task = this.store.get<Task>('task', taskId);
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

  private apply(
    command: Command,
    effects: (() => void)[],
    verification?: PreparedVerification,
    acpContext?: CapturedContext,
  ): CommandResult {
    if (command.command === 'PrepareRun' || command.command === 'PrepareNativeRun') {
      const config = this.conversationConfiguration(command.payload.taskId);
      if (
        config &&
        (['attempts', 'minutes', 'concurrency'] as const).some(
          (axis) => command.payload.policy.limits[axis] > config.limits[axis],
        )
      )
        return {
          outcome: 'blocked',
          reason: 'task-limit-exceeded',
          next: 'Amend the total task limits explicitly before requesting a larger execution envelope.',
        };
    }
    if ('taskId' in command.payload && ['ResumeRun', 'SwitchRoute'].includes(command.command)) {
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (task?.runId && this.store.receipt(`native-run:${task.runId}`))
        return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
    }
    if (
      'taskId' in command.payload &&
      ['AcceptCandidate', 'ExportPatch', 'GetChanges'].includes(command.command) &&
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
      if (
        this.evidence.hash(run.source.base, readFiles(this.writerScratch(run))) !== candidate.hash
      )
        return {
          outcome: 'blocked',
          reason: 'candidate-binding-changed',
          next: 'Seal and check the changed work before publication.',
        };
    }
    switch (command.command) {
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
      case 'CreateTaskDiscussion':
      case 'ConfigureTaskConversation':
      case 'SendTaskMessage':
      case 'QueueTaskGuidance':
      case 'AnswerTaskQuestion':
      case 'AdoptTaskPlan':
        return this.conversationCommand(command, effects);
      case 'InitializeGoogleAcp':
      case 'AuthenticateGoogleAcp':
      case 'DiscoverGoogleAcp':
      case 'StopGoogleAcpSetup':
        return this.applyAcpSetup(command, effects);
      case 'ObserveUsage':
        return this.observeUsage(command, effects);
      case 'RegisterProject': {
        const path = projectRoot(command.payload.path);
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
        const task = TaskSchema.parse({
          ...command.payload,
          id: this.id('tsk'),
          state: 'draft',
          waitingReason: null,
          revision: 0,
          runId: null,
          next: 'Prepare the run.',
        });
        this.store.put('task', task.id, task.revision, task);
        this.event('task.created', task.id, task.revision, task);
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
        const start = this.acpStart;
        if (
          result.outcome === 'applied' &&
          start?.taskId === command.payload.taskId &&
          start.runId === command.payload.runId
        )
          effects.push(() => {
            start.aborted = true;
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
      case 'GetSnapshot':
        return { outcome: 'applied', data: { kind: 'snapshot', snapshot: this.snapshot() } };
      case 'GetUsage':
        return { outcome: 'applied', data: { kind: 'usage', windows: this.snapshot().usage } };
      case 'GetHealth':
        return {
          outcome: 'applied',
          data: {
            kind: 'health',
            status: 'degraded',
            version: '0.0.0',
            blockers: ['Only scripted routes are qualified in D0.'],
          },
        };
      default:
        return {
          outcome: 'unsupported',
          reason: 'command-not-implemented',
          next: 'This command has no qualified D0 implementation.',
        };
    }
  }

  private conversationConfiguration(taskId: string): ConversationConfiguration | undefined {
    const value = this.store.conversationTask(taskId);
    return value === undefined ? undefined : ConversationConfigurationSchema.parse(value);
  }

  private saveConversationConfiguration(taskId: string, value: ConversationConfiguration) {
    this.store.putConversationTask(taskId, ConversationConfigurationSchema.parse(value));
  }

  private taskAllowance(taskId: string) {
    const config = this.conversationConfiguration(taskId);
    if (!config) return null;
    const intents = this.store.intents();
    const ledger = intents.filter((intent) => intent.task_id === taskId);
    const minutes = ledger.reduce((sum, intent) => {
      const run = this.store.get<Run>('run', intent.run_id);
      let reserved = run?.policy.policy.limits.minutes ?? config.limits.minutes;
      if (this.store.runPurpose(intent.run_id) === 'conversation') {
        try {
          const plan = this.nativeRecord(`conversation-turn:${intent.attempt_id}`).value as {
            binding: ConversationTurnBinding;
          };
          reserved = ConversationTurnBindingSchema.parse(plan.binding).limitMinutes;
        } catch {}
      }
      return sum + chargedMinutes(intent, reserved);
    }, 0);
    return {
      attempts: Math.max(0, config.limits.attempts - ledger.length),
      minutes: Math.max(0, config.limits.minutes - minutes),
      concurrency: Math.max(
        0,
        config.limits.concurrency - intents.filter((intent) => intent.state !== 'stopped').length,
      ),
    };
  }

  private remaining(run: Run) {
    const own = remainingBudgets(run, this.store.intents());
    const task = this.taskAllowance(run.taskId);
    return task
      ? {
          attempts: Math.min(own.attempts, task.attempts),
          minutes: Math.min(own.minutes, task.minutes),
          concurrency: Math.min(own.concurrency, task.concurrency),
        }
      : own;
  }

  private conversationBoundary(
    taskId: string,
  ): TaskConversationState['adopt']['reason'] | undefined {
    const active = this.store
      .intents()
      .filter((intent) => intent.task_id === taskId && intent.state !== 'stopped');
    if (
      active.some((intent) => ['outcome-unknown', 'interrupted'].includes(intent.state)) ||
      this.hasUncertainWriter(taskId)
    )
      return 'ownership-unknown';
    if (
      active.length ||
      this.store.db.prepare('SELECT 1 FROM writer_leases WHERE task_id=?').get(taskId)
    )
      return 'owner-active';
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM pending_effects WHERE task_id=? AND state IN ('pending','approved','unknown') LIMIT 1",
        )
        .get(taskId)
    )
      return 'effects-unresolved';
    for (const intent of this.store
      .intents()
      .filter(
        (value) =>
          value.task_id === taskId && this.store.runPurpose(value.run_id) === 'conversation',
      )) {
      const phases = this.store.nativeProcesses(intent.attempt_id);
      if (phases.some((phase) => phase.state !== 'quiescent')) return 'ownership-unknown';
      if (!phases.length && !this.store.receipt(`conversation-completion:${intent.attempt_id}`))
        return 'ownership-unknown';
    }
  }

  private conversationAuthority(config: ConversationConfiguration) {
    return hashCanonical({
      role: config.selection.role,
      profileId: config.selection.profileId,
      creditPolicy: config.selection.creditPolicy,
      source: config.source,
      profileHash: config.profileHash,
      client: config.client,
      locationHash: config.locationHash,
      routeId: config.routeId,
    });
  }

  private conversationProfile(config: ConversationConfiguration) {
    const profile = this.profileFor(config.selection.profileId);
    if (
      !profile.facts.available ||
      profile.facts.family !== 'openai' ||
      profile.facts.id !== config.selection.profileId ||
      !profile.client ||
      !profile.environment ||
      !profile.locationHash ||
      !profile.facts.creditPolicies.includes(config.selection.creditPolicy) ||
      hashCanonical(profile.facts) !== config.profileHash ||
      hashCanonical(profile.client) !== hashCanonical(config.client) ||
      profile.locationHash !== config.locationHash
    )
      throw Error('profile-unavailable');
    return profile as NativeProfileResolution & {
      client: NonNullable<NativeProfileResolution['client']>;
      environment: NodeJS.ProcessEnv;
      locationHash: string;
    };
  }

  private conversationInputFits(
    task: Pick<Task, 'id' | 'runId' | 'title' | 'outcome'>,
    selection: ConversationPlanningSelection,
    criteria: string[],
  ) {
    const profile = this.profileFor(selection.profileId);
    if (!profile.facts.available) return true;
    const identity = '00000000000000000000000000';
    const scope = {
      paths: [] as string[],
      roles: ['coder', 'reviewer', 'advisor'] as ('coder' | 'reviewer' | 'advisor')[],
      checks: ['node-tests-v1', 'project-node-tests-v1', 'crewkite-verify-v1'],
    };
    try {
      // Reserve framing space so every permitted message fits with the full task contract.
      conversationPlan({
        binding: {
          taskId: task.id,
          runId: task.runId ?? `run_${identity}`,
          attemptId: `att_${identity}`,
          generation: Number.MAX_SAFE_INTEGER,
          routeId: `rte_${identity}`,
          role: selection.role,
          taskRevision: Number.MAX_SAFE_INTEGER,
          conversationRevision: Number.MAX_SAFE_INTEGER,
          scopeHash: hashCanonical(scope),
          limitMinutes: 5,
        },
        model: profile.facts.model as ConversationPlan['model'],
        effort: 'low',
        creditPolicy: selection.creditPolicy,
        directory: join(this.home, 'conversation', `run_${identity}`, `att_${identity}`),
        context: { title: task.title, outcome: task.outcome, criteria },
        scope,
        history: [
          { role: 'user', text: '\u0001'.repeat(4096) },
          { role: 'controller', text: 'x'.repeat(512) },
        ],
        omittedHistoryCount: Number.MAX_SAFE_INTEGER,
      });
      return true;
    } catch {
      return false;
    }
  }

  private conversationState(taskId: string): TaskConversationState {
    const task = this.store.get<Task>('task', taskId);
    if (!task) throw Error('task-not-found');
    const config = this.conversationConfiguration(task.id);
    const run = task.runId ? this.store.get<Run>('run', task.runId) : undefined;
    const purpose = task.runId ? (this.store.runPurpose(task.runId) ?? null) : null;
    const intents = this.store
      .intents()
      .filter((intent) => intent.task_id === task.id && intent.state !== 'stopped');
    const active = intents[0]
      ? (this.store.get<Attempt>('attempt', intents[0].attempt_id) ?? null)
      : null;
    const unknown =
      intents.some((intent) => ['outcome-unknown', 'interrupted'].includes(intent.state)) ||
      task.state === 'unknown';
    const pageRows = this.store.db
      .prepare(
        "SELECT body FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='plan-proposal' ORDER BY sequence DESC LIMIT 1",
      )
      .get(task.id);
    const proposalEntry = pageRows
      ? (JSON.parse(pageRows.body as string) as Extract<
          import('@crewkite/contracts').ConversationEntry,
          { kind: 'plan-proposal' }
        >)
      : null;
    const proposal =
      proposalEntry && proposalEntry.binding.runId === task.runId
        ? {
            id: proposalEntry.id,
            hash: hashCanonical(proposalEntry.proposal),
            runId: proposalEntry.binding.runId,
            revision: proposalEntry.revision,
          }
        : null;
    const pendingQuestions = this.conversation
      .pendingQuestions(task.id)
      .map(({ id, cursor }) => ({ id, cursor }));
    const queuedInputCount = this.store.db
      .prepare(`SELECT COUNT(*) AS count FROM conversation_entries input
      WHERE input.task_id=? AND json_extract(input.body,'$.kind') IN ('user-message','guidance','answer')
      AND NOT EXISTS (SELECT 1 FROM conversation_entries delivery WHERE delivery.task_id=input.task_id
        AND json_extract(delivery.body,'$.kind')='input-delivery' AND json_extract(delivery.body,'$.replyTo')=input.id)`)
      .get(task.id)?.count as number;
    const allowance = this.taskAllowance(task.id);
    let send: TaskConversationState['send'] = {
      available: false,
      reason: 'not-configured',
      disposition: null,
    };
    if (this.closed) send.reason = 'controller-closing';
    else if (
      this.store.db
        .prepare(
          "SELECT 1 FROM pending_effects WHERE task_id=? AND state IN ('pending','approved','unknown') LIMIT 1",
        )
        .get(task.id)
    )
      send.reason = 'effects-unresolved';
    else if (unknown) send.reason = 'ownership-unknown';
    else if (config?.paused || task.state === 'stopping') send.reason = 'admissions-paused';
    else if (active && purpose)
      send = { available: true, reason: 'queued-at-boundary', disposition: 'queue' };
    else if (
      config &&
      run &&
      (purpose === 'conversation' || purpose === 'execution') &&
      allowance
    ) {
      send.reason = 'available';
      try {
        this.conversationProfile(config);
      } catch {
        send.reason = 'profile-unavailable';
      }
      if (
        send.reason === 'available' &&
        hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
          hashCanonical(config.source)
      )
        send.reason = 'source-changed';
      const boundary = this.conversationBoundary(task.id);
      if (send.reason === 'available' && boundary) send.reason = boundary;
      if (
        send.reason === 'available' &&
        !this.conversationInputFits(
          task,
          config.selection,
          config.contractStatus === 'provisional' ? config.contextCriteria : task.criteria,
        )
      )
        send.reason = 'conversation-input-too-large';
      if (send.reason === 'available' && allowance.attempts === 0)
        send.reason = 'attempt-budget-exhausted';
      if (send.reason === 'available' && allowance.minutes === 0)
        send.reason = 'minute-budget-exhausted';
      if (send.reason === 'available' && allowance.concurrency === 0)
        send.reason = 'concurrency-exhausted';
      if (send.reason === 'available')
        send = {
          available: true,
          reason: 'available',
          disposition: purpose === 'conversation' ? 'turn' : 'planning-turn',
        };
    } else if (run && purpose === 'execution') send.reason = 'task-not-discussing';
    let adopt: TaskConversationState['adopt'] = { available: false, reason: 'proposal-missing' };
    if (proposal && config && allowance && purpose === 'conversation') {
      const boundary = this.conversationBoundary(task.id);
      const newerInput = this.store.db
        .prepare(
          "SELECT 1 FROM conversation_entries WHERE task_id=? AND sequence>? AND json_extract(body,'$.kind') IN ('user-message','guidance','answer') LIMIT 1",
        )
        .get(task.id, BigInt(proposalEntry?.cursor ?? '0'));
      adopt.reason =
        boundary ??
        (config.paused
          ? 'admissions-paused'
          : pendingQuestions.length
            ? 'pending-question'
            : queuedInputCount || newerInput
              ? 'pending-input'
              : 'available');
      adopt.available = adopt.reason === 'available';
      if (
        adopt.available &&
        hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
          hashCanonical(config.source)
      ) {
        adopt = { available: false, reason: 'source-changed' };
      }
    }
    const route = config ? this.store.get<Route>('route', config.routeId) : undefined;
    return TaskConversationStateSchema.parse({
      taskId: task.id,
      revision: task.revision,
      contractStatus: config?.contractStatus ?? 'confirmed',
      purpose,
      phase: unknown
        ? 'unknown'
        : task.state === 'stopping'
          ? 'stopping'
          : active
            ? purpose === 'conversation'
              ? 'planning'
              : 'execution'
            : task.state === 'interrupted'
              ? 'interrupted'
              : task.state === 'stopped'
                ? 'stopped'
                : purpose === 'execution'
                  ? 'execution'
                  : config
                    ? config.contractStatus === 'confirmed'
                      ? 'planned'
                      : 'discussion'
                    : 'idle',
      configuration: config
        ? {
            revision: config.revision,
            selection: config.selection,
            routeId: config.routeId,
            requestedModel: route?.model ?? null,
            requestedEffort: route?.effort.requested ?? null,
            effectiveModel: config.effectiveModel,
            effectiveEffort: config.effectiveEffort,
          }
        : null,
      currentRunId: task.runId,
      activeAttempt: active,
      budget: config && allowance ? { limits: config.limits, remaining: allowance } : null,
      queuedInputCount,
      pendingQuestions,
      proposal,
      adoptedProposal: config?.adoptedProposal ?? null,
      send,
      adopt,
    });
  }

  private configureConversation(
    task: Task,
    selection: ConversationPlanningSelection,
    provisional: boolean,
    initial = false,
  ) {
    const profile = this.profileFor(selection.profileId);
    const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
    committedFiles(this.projectPath(task.projectId) as string, source.base);
    const prior = this.conversationConfiguration(task.id);
    const route = RouteSchema.parse({
      id: this.id('rte'),
      family: 'openai',
      displayName: 'Supervised planning',
      model: profile.facts.model,
      effort: { requested: 'low', effective: 'unknown', supported: ['low'] },
      billing: selection.creditPolicy === 'existing-credits' ? 'credits' : 'included',
      qualified: false,
      fake: false,
    });
    this.store.put('route', route.id, 0, route);
    const config = ConversationConfigurationSchema.parse({
      revision: (prior?.revision ?? 0) + 1,
      contractStatus: provisional ? 'provisional' : (prior?.contractStatus ?? 'confirmed'),
      contextCriteria: initial ? [] : task.criteria,
      selection,
      routeId: route.id,
      source,
      profileHash: hashCanonical(profile.facts),
      client: profile.client ?? null,
      locationHash: profile.locationHash ?? null,
      limits: selection.limits,
      paused: false,
      adoptedProposal: prior?.adoptedProposal ?? null,
      effectiveModel: null,
      effectiveEffort: null,
    });
    this.saveConversationConfiguration(task.id, config);
    const policy = PolicySchema.parse({
      authority: 'guided',
      quality: 'quick',
      effects: [],
      limits: selection.limits,
      reserves: [],
      unknownUsage: {
        rule: 'fixed-allowance',
        allowance: { launches: selection.limits.attempts, minutes: selection.limits.minutes },
      },
    });
    const run = RunSchema.parse({
      id: this.id('run'),
      taskId: task.id,
      source,
      policy: { policy, hash: hashCanonical(policy) },
      roles: [{ role: selection.role, routeId: route.id, pinned: true, approvedFallbacks: [] }],
      decision: {
        chosen: route.id,
        rejected: [],
        rule: 'manual',
        inputsHash: this.conversationAuthority(config),
      },
      revision: 0,
    });
    this.store.put('run', run.id, 0, run);
    this.store.putRunPurpose(run, 'conversation', task.runId);
    const updated = this.updateTask(task, {
      runId: run.id,
      state: 'draft',
      waitingReason: null,
      next: 'Describe the task or answer the pending question.',
    });
    this.event('run.prepared', task.id, updated.revision, run);
    return updated;
  }

  private conversationCommand(
    command: Extract<
      Command,
      {
        command:
          | 'CreateTaskDiscussion'
          | 'ConfigureTaskConversation'
          | 'SendTaskMessage'
          | 'QueueTaskGuidance'
          | 'AnswerTaskQuestion'
          | 'AdoptTaskPlan';
      }
    >,
    effects: (() => void)[],
  ): CommandResult {
    if (command.command === 'CreateTaskDiscussion') {
      if (!this.projectPath(command.payload.projectId))
        return { outcome: 'blocked', reason: 'project-not-found' };
      const text = command.payload.text;
      if (!text.trim()) return { outcome: 'denied', reason: 'empty-message' };
      let task = TaskSchema.parse({
        id: this.id('tsk'),
        projectId: command.payload.projectId,
        title: text.trim().split('\n')[0].slice(0, 200).toWellFormed(),
        outcome: text,
        criteria: ['Confirm acceptance criteria before execution.'],
        state: 'draft',
        waitingReason: null,
        revision: 0,
        runId: null,
        next: 'Clarify the task before execution.',
      });
      if (!this.conversationInputFits(task, command.payload.planning, []))
        return { outcome: 'blocked', reason: 'conversation-input-too-large' };
      this.store.put('task', task.id, 0, task);
      this.event('task.created', task.id, 0, task);
      task = this.configureConversation(task, command.payload.planning, true, true);
      const message = this.conversation.recordMessage(task.id, text);
      if (!message.applied) return { outcome: 'blocked', reason: message.reason };
      this.admitConversation(task.id, effects);
      const current = this.store.get<Task>('task', task.id) as Task;
      return { outcome: 'applied', entity: current, revision: current.revision };
    }
    const task = this.store.get<Task>('task', command.payload.taskId);
    if (!task) return { outcome: 'blocked', reason: 'task-not-found' };
    if (command.command === 'ConfigureTaskConversation') {
      const prior = this.conversationConfiguration(task.id);
      const selection = command.payload.planning;
      const same =
        prior &&
        hashCanonical({ ...selection, limits: prior.selection.limits }) ===
          hashCanonical(prior.selection);
      const lower =
        prior &&
        (['attempts', 'minutes', 'concurrency'] as const).every(
          (axis) => selection.limits[axis] <= prior.limits[axis],
        );
      if (same && lower) {
        this.saveConversationConfiguration(task.id, {
          ...prior,
          revision: prior.revision + 1,
          selection,
          limits: selection.limits,
        });
        const updated = this.updateTask(task, {});
        return { outcome: 'applied', entity: updated, revision: updated.revision };
      }
      const boundary = this.conversationBoundary(task.id);
      if (boundary) return { outcome: 'blocked', reason: boundary };
      if (!this.conversationInputFits(task, selection, task.criteria))
        return { outcome: 'blocked', reason: 'conversation-input-too-large' };
      const updated = this.configureConversation(task, selection, true);
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    if (command.command === 'AdoptTaskPlan') {
      const state = this.conversationState(task.id);
      if (!state.adopt.available) return { outcome: 'blocked', reason: state.adopt.reason };
      if (
        state.proposal?.id !== command.payload.proposalId ||
        state.proposal.hash !== command.payload.proposalHash
      )
        return { outcome: 'blocked', reason: 'proposal-hash-changed' };
      const row = this.store.db
        .prepare('SELECT body FROM conversation_entries WHERE id=? AND task_id=?')
        .get(state.proposal.id, task.id);
      const entry =
        row &&
        (JSON.parse(row.body as string) as Extract<
          import('@crewkite/contracts').ConversationEntry,
          { kind: 'plan-proposal' }
        >);
      if (entry?.kind !== 'plan-proposal' || hashCanonical(entry.proposal) !== state.proposal.hash)
        return { outcome: 'blocked', reason: 'proposal-not-current' };
      const config = this.conversationConfiguration(task.id) as ConversationConfiguration;
      this.saveConversationConfiguration(task.id, {
        ...config,
        contractStatus: 'confirmed',
        adoptedProposal: state.proposal,
      });
      const updated = this.updateTask(task, {
        criteria: entry.proposal.criteria,
        state: 'draft',
        waitingReason: null,
        next: 'Plan adopted. Prepare the execution contract.',
      });
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    if (!command.payload.text.trim()) return { outcome: 'denied', reason: 'empty-message' };
    const state = this.conversationState(task.id);
    if (!state.send.available) return { outcome: 'blocked', reason: state.send.reason };
    const saved =
      command.command === 'AnswerTaskQuestion'
        ? this.conversation.answerQuestion(
            task.id,
            command.payload.questionId,
            command.payload.text,
          )
        : this.conversation.recordMessage(
            task.id,
            command.payload.text,
            command.command === 'QueueTaskGuidance' ? 'guidance' : 'user-message',
          );
    if (!saved.applied) return { outcome: 'blocked', reason: saved.reason };
    if (state.send.disposition === 'planning-turn') {
      const config = this.conversationConfiguration(task.id) as ConversationConfiguration;
      this.configureConversation(saved.task, config.selection, true);
    }
    if (state.send.disposition === 'turn' || state.send.disposition === 'planning-turn')
      this.admitConversation(task.id, effects);
    const current = this.store.get<Task>('task', task.id) as Task;
    return { outcome: 'applied', entity: current, revision: current.revision };
  }

  private admitConversation(taskId: string, effects: (() => void)[]): CommandResult {
    const state = this.conversationState(taskId);
    if (!state.send.available || state.send.disposition !== 'turn')
      return { outcome: 'blocked', reason: state.send.reason };
    const task = this.store.get<Task>('task', taskId) as Task;
    const config = this.conversationConfiguration(taskId) as ConversationConfiguration;
    const run = this.store.get<Run>('run', task.runId as string) as Run;
    const pending = this.conversation.pendingInputs(taskId);
    if (!pending.length) return { outcome: 'blocked', reason: 'pending-input' };
    const profile = this.conversationProfile(config);
    const allowance = this.remaining(run);
    const attempt = this.jobAttempt(run, config.routeId);
    const directory = join(this.home, 'conversation', run.id, attempt.id);
    const ceiling = BigInt(pending[pending.length - 1].cursor);
    const rows = this.store.db
      .prepare(
        "SELECT body FROM conversation_entries WHERE task_id=? AND sequence<=? AND json_extract(body,'$.kind')<>'input-delivery' ORDER BY sequence DESC LIMIT 100",
      )
      .all(taskId, ceiling);
    const total = this.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM conversation_entries WHERE task_id=? AND sequence<=? AND json_extract(body,'$.kind')<>'input-delivery'",
      )
      .get(taskId, ceiling)?.count as number;
    const historyEntries = rows
      .reverse()
      .map(
        (row) => JSON.parse(row.body as string) as import('@crewkite/contracts').ConversationEntry,
      );
    const history = historyEntries.map((entry) => {
      return { role: entry.author.kind, text: entry.text };
    });
    const files = committedFiles(this.projectPath(task.projectId) as string, config.source.base);
    const scope = {
      paths: files.slice(0, 1000).map((file) => file.path),
      roles: ['coder', 'reviewer', 'advisor'] as ('coder' | 'reviewer' | 'advisor')[],
      checks: ['node-tests-v1', 'project-node-tests-v1', 'crewkite-verify-v1'],
    };
    const binding = ConversationTurnBindingSchema.parse({
      taskId,
      runId: run.id,
      attemptId: attempt.id,
      generation: attempt.generation,
      routeId: config.routeId,
      role: config.selection.role,
      taskRevision: task.revision,
      conversationRevision: this.conversation.revision(taskId),
      scopeHash: hashCanonical(scope),
      limitMinutes: Math.min(5, allowance.minutes),
    });
    let input: ConversationPlan | undefined;
    let omitted = Math.max(0, total - history.length);
    while (!input) {
      try {
        input = conversationPlan({
          binding,
          model: profile.facts.model as ConversationPlan['model'],
          effort: 'low',
          creditPolicy: config.selection.creditPolicy,
          directory,
          context: {
            title: task.title,
            outcome: task.outcome,
            criteria:
              config.contractStatus === 'provisional' ? config.contextCriteria : task.criteria,
          },
          scope,
          history,
          omittedHistoryCount: omitted,
        });
      } catch {
        if (history.length > 1) {
          const retained = new Set(pending.map((entry) => entry.id));
          const old = historyEntries.findIndex((entry) => !retained.has(entry.id));
          const index = old >= 0 ? old : history.length - 1;
          history.splice(index, 1);
          historyEntries.splice(index, 1);
          omitted++;
        } else if (scope.paths.length) {
          scope.paths.pop();
          binding.scopeHash = hashCanonical(scope);
        } else return { outcome: 'blocked', reason: 'conversation-input-too-large' };
      }
    }
    input = freezeNative(input);
    const selectedIds = new Set(historyEntries.map((entry) => entry.id));
    const included = pending.filter((entry) => selectedIds.has(entry.id));
    if (!included.length) return { outcome: 'blocked', reason: 'conversation-input-too-large' };
    const artifact = this.nativeArtifact({
      ...input,
      authorityHash: this.conversationAuthority(config),
    });
    this.store.saveReceipt(`conversation-turn:${attempt.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    if (!this.store.receipt(`allocation:${run.id}`))
      this.store.saveReceipt(
        `allocation:${run.id}`,
        this.conversationAuthority(config),
        'local-owner',
        { outcome: 'applied', entity: run },
      );
    this.admitJob(run, attempt, directory, binding.limitMinutes);
    const started = this.updateTask(this.store.get<Task>('task', task.id) as Task, {
      state: 'running',
      waitingReason: null,
      next: 'The planning turn is running.',
    });
    const frozen: FrozenConversationTurn = {
      binding: input.binding,
      scope: input.scope,
      bindingHash: conversationBindingHash(input),
    };
    const delivery = this.conversation.includeInputs(
      frozen,
      included.map((entry) => entry.id),
    );
    if (!delivery.applied) throw Error(delivery.reason);
    this.event('run.admitted', task.id, started.revision, run);
    this.pendingConversationLaunches.add(attempt.id);
    effects.push(() => {
      this.pendingConversationLaunches.delete(attempt.id);
      const intent = this.store.intents().find((value) => value.attempt_id === attempt.id);
      if (!intent) throw Error('The planning launch intent is unavailable.');
      if (intent.state === 'stopped') return;
      this.options.afterIntent?.(intent);
      this.launchConversation(
        input as ConversationPlan,
        attempt,
        this.conversationAuthority(config),
        profile.environment,
      );
    });
    return {
      outcome: 'applied',
      entity: this.store.get<Task>('task', task.id),
      revision: (this.store.get<Task>('task', task.id) as Task).revision,
    };
  }

  private ownsConversationTurn(
    binding: ConversationTurnBinding,
    phase: 'input' | 'result',
  ): boolean {
    try {
      if (this.store.runPurpose(binding.runId) !== 'conversation') return false;
      const saved = this.nativeRecord(`conversation-turn:${binding.attemptId}`)
        .value as ConversationPlan & { authorityHash: string };
      const config = this.conversationConfiguration(binding.taskId);
      if (
        !config ||
        saved.authorityHash !== this.conversationAuthority(config) ||
        hashCanonical(saved.binding) !== hashCanonical(binding)
      )
        return false;
      const task = this.store.get<Task>('task', binding.taskId);
      if (
        !task ||
        task.runId !== binding.runId ||
        hashCanonical({
          title: task.title,
          outcome: task.outcome,
          criteria:
            config.contractStatus === 'provisional' ? config.contextCriteria : task.criteria,
        }) !== hashCanonical(saved.context)
      )
        return false;
      const intent = this.store.intents().find((value) => value.attempt_id === binding.attemptId);
      return phase === 'input'
        ? !!intent && intent.state === 'intent'
        : intent?.state === 'stopped' &&
            this.store.nativePhasesComplete(binding.attemptId, 'openai');
    } catch {
      return false;
    }
  }

  private launchConversation(
    input: ConversationPlan,
    attempt: Attempt,
    authorityHash: string,
    environment: NodeJS.ProcessEnv,
  ) {
    const completed = Promise.withResolvers<void>();
    const runtime: ConversationRuntime = {
      input,
      attempt,
      authorityHash,
      stopped: false,
      done: completed.promise,
    };
    this.conversationWorkers.set(attempt.id, runtime);
    const current = () => {
      const config = this.conversationConfiguration(input.binding.taskId);
      const task = this.store.get<Task>('task', input.binding.taskId);
      if (
        this.closed ||
        runtime.stopped ||
        !config ||
        config.paused ||
        authorityHash !== this.conversationAuthority(config) ||
        task?.runId !== input.binding.runId ||
        task.state !== 'running' ||
        this.jobDeadline(attempt.id, input.binding.limitMinutes) <= 0 ||
        hashCanonical({
          title: task.title,
          outcome: task.outcome,
          criteria:
            config.contractStatus === 'provisional' ? config.contextCriteria : task.criteria,
        }) !== hashCanonical(input.context) ||
        hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
          hashCanonical(config.source)
      )
        throw Error('Planning authority changed.');
      this.conversationProfile(config);
    };
    const finish = (outcome: Awaited<ReturnType<typeof startConversation>['result']> | null) => {
      try {
        const phases = this.store.nativeProcesses(attempt.id);
        const quiescent =
          (outcome?.quiescent === true && phases.every((phase) => phase.state === 'quiescent')) ||
          (!runtime.handle && phases.length === 0);
        let valid = false;
        try {
          current();
          valid =
            quiescent &&
            outcome?.reason === null &&
            !!outcome.metadata &&
            this.store.nativePhasesComplete(attempt.id, 'openai');
        } catch {}
        if (
          !this.settleJob(attempt, quiescent, true, () => {
            const proof = this.nativeArtifact({
              attemptId: attempt.id,
              quiescent,
              submitted: !!outcome?.metadata,
              reason: outcome?.reason ?? 'launch',
            });
            this.store.saveReceipt(
              `conversation-completion:${attempt.id}`,
              proof.hash,
              'local-owner',
              { outcome: 'applied', entity: proof },
            );
            if (valid && outcome?.metadata) {
              const config = this.conversationConfiguration(
                input.binding.taskId,
              ) as ConversationConfiguration;
              this.saveConversationConfiguration(input.binding.taskId, {
                ...config,
                effectiveModel: input.model,
                effectiveEffort: input.effort,
              });
              const result = this.conversation.recordReply(
                {
                  binding: input.binding,
                  scope: input.scope,
                  bindingHash: conversationBindingHash(input),
                },
                outcome.metadata.conversation,
              );
              if (!result.applied) valid = false;
            }
            const task = this.store.get<Task>('task', input.binding.taskId) as Task;
            this.updateTask(task, {
              state: runtime.stopped || this.closed ? 'stopped' : valid ? 'draft' : 'interrupted',
              waitingReason: null,
              next:
                runtime.stopped || this.closed
                  ? 'Planning stopped. Continue explicitly when ready.'
                  : valid
                    ? 'Review the reply and plan before execution.'
                    : 'The planning turn has no verified reply. Inspect retained history before continuing.',
            });
          })
        )
          return;
        this.conversationWorkers.delete(attempt.id);
        if (
          !this.closed &&
          !runtime.stopped &&
          valid &&
          this.conversation.pendingInputs(input.binding.taskId).length
        ) {
          const effects: (() => void)[] = [];
          this.store.transaction(() => this.admitConversation(input.binding.taskId, effects));
          for (const effect of effects) effect();
        }
      } catch {
        try {
          this.settleJob(attempt, false, true);
        } catch {}
      } finally {
        completed.resolve();
      }
    };
    try {
      current();
      const config = this.conversationConfiguration(
        input.binding.taskId,
      ) as ConversationConfiguration;
      const profile = this.conversationProfile(config);
      mkdirSync(input.directory, { recursive: true, mode: 0o700 });
      runtime.handle = startConversation(
        { ...profile.client, directory: input.directory, repositoryRoot: this.home, environment },
        input,
        {
          timeoutMs: this.jobDeadline(attempt.id, input.binding.limitMinutes),
          schedule: this.options.schedule,
          spawn: this.options.nativeSpawn,
          onSubmitted: () => {
            current();
            this.store.transaction(() => {
              const artifact = this.nativeArtifact({
                attemptId: attempt.id,
                bindingHash: conversationBindingHash(input),
              });
              this.store.saveReceipt(
                `conversation-submission:${attempt.id}`,
                artifact.hash,
                'local-owner',
                { outcome: 'outcome-unknown', entity: artifact },
              );
            });
          },
          lifecycle: this.nativeLifecycle(attempt, current),
        },
      );
      if (runtime.stopped || this.closed) runtime.handle.stop();
      void runtime.handle.result.then(finish, () => finish(null));
    } catch {
      finish(null);
    }
  }

  private routing(
    run: Pick<Run, 'roles' | 'policy'> & Partial<Pick<Run, 'id'>>,
    roleName: Run['roles'][number]['role'] = 'coder',
    target?: string,
    releasing?: string,
  ) {
    const coder = run.roles.find((role) => role.role === roleName);
    if (!coder) throw new Error('Choose one coder route before starting.');
    const observations = this.store.list<Observation>('window');
    const routes = this.store.list<Route>('route');
    const active = this.store
      .intents()
      .filter((intent) => intent.state !== 'stopped' && intent.attempt_id !== releasing);
    const input = {
      nowMs: Date.parse(this.now()),
      maxAgeMs: 300000,
      candidates: routes
        .filter((route) => [coder.routeId, ...coder.approvedFallbacks].includes(route.id))
        .map((route) => ({
          route,
          windowIds:
            route.family === 'local'
              ? []
              : [
                  ...new Set([
                    ...observations
                      .filter((value) => value.routeId === route.id)
                      .map((value) => value.windowId),
                    ...run.policy.policy.reserves
                      .filter((value) => value.routeId === route.id)
                      .map((value) => value.windowId),
                  ]),
                ],
          availableSlots: Math.max(
            0,
            1 - active.filter((intent) => intent.route_id === route.id).length,
          ),
        })),
      observations,
      reserves: run.policy.policy.reserves,
      reservations: this.store.db
        .prepare('SELECT attempt_id,route_id,window_id,value,unit FROM reservations')
        .all()
        .filter((row) => row.attempt_id !== releasing)
        .map((row) => ({
          routeId: row.route_id as string,
          windowId: row.window_id as string,
          value: row.value as number,
          unit: row.unit as NonNullable<Observation['remaining']>['unit'],
        })),
      role: coder,
      baseOrder: [
        coder.routeId,
        ...coder.approvedFallbacks,
        ...routes.map((route) => route.id),
      ].filter((value, index, all) => all.indexOf(value) === index),
      unknownUsage: run.policy.policy.unknownUsage,
      fixedUsage: routes.map((route) => {
        const ledger = this.store
          .intents()
          .filter((intent) => intent.run_id === run.id && intent.route_id === route.id);
        const completed = ledger.filter((intent) => intent.state === 'stopped');
        const reserved = ledger.filter((intent) => intent.state !== 'stopped');
        return {
          routeId: route.id,
          launches: completed.length,
          minutes: completed.reduce(
            (sum, intent) => sum + chargedMinutes(intent, run.policy.policy.limits.minutes),
            0,
          ),
          reservedLaunches: reserved.length,
          reservedMinutes: reserved.length * run.policy.policy.limits.minutes,
          requestedMinutes: run.id
            ? this.remaining(run as Run).minutes
            : run.policy.policy.limits.minutes,
        };
      }),
    };
    const automatic = chooseRoute(input);
    if (!target) return automatic;
    if (coder.pinned && automatic.chosen === coder.routeId && target !== coder.routeId)
      return { ...automatic, chosen: null, rule: 'waiting' as const };
    const manual = chooseRoute({
      ...input,
      candidates: input.candidates.filter(({ route }) => route.id === target),
    });
    return {
      ...manual,
      rule: manual.chosen ? ('manual' as const) : manual.rule,
      inputsHash: hashCanonical({
        automatic: automatic.inputsHash,
        target,
        admission: manual.inputsHash,
      }),
    };
  }

  private draftEditGate(task: Task): CommandResult | undefined {
    const discussion = this.conversationConfiguration(task.id);
    if (discussion?.contractStatus === 'provisional')
      return {
        outcome: 'blocked',
        reason: 'task-contract-unconfirmed',
        next: 'Review and adopt a plan before preparing execution.',
      };
    if (this.store.runPurpose(task.runId ?? '') === 'conversation') {
      const blocked = this.conversationBoundary(task.id);
      if (blocked) return { outcome: 'blocked', reason: blocked };
      const state = this.conversationState(task.id);
      if (
        !discussion?.adoptedProposal ||
        discussion.adoptedProposal.runId !== task.runId ||
        state.proposal?.id !== discussion.adoptedProposal.id ||
        state.proposal.hash !== discussion.adoptedProposal.hash ||
        !state.adopt.available
      )
        return {
          outcome: 'blocked',
          reason: 'proposal-not-current',
          next: 'Adopt the current planning proposal before preparing execution.',
        };
      const row = this.store.db
        .prepare('SELECT body FROM conversation_entries WHERE id=? AND task_id=?')
        .get(discussion.adoptedProposal.id, task.id);
      const proposal =
        row && (JSON.parse(row.body as string) as { kind?: string; proposal?: unknown });
      if (
        proposal?.kind !== 'plan-proposal' ||
        hashCanonical(proposal.proposal) !== discussion.adoptedProposal.hash
      )
        return { outcome: 'blocked', reason: 'proposal-hash-changed' };
      return;
    }
    if (task.state !== 'draft') return;
    const run = task.runId ? this.store.get<Run>('run', task.runId) : undefined;
    const lease = this.store.db
      .prepare('SELECT attempt_id FROM writer_leases WHERE task_id=?')
      .get(task.id);
    const effect = this.store.db
      .prepare(
        "SELECT approval_id FROM pending_effects WHERE task_id=? AND state IN ('pending','approved','unknown') LIMIT 1",
      )
      .get(task.id);
    if (this.hasUncertainWriter(task.id) || lease || effect)
      return {
        outcome: 'blocked',
        reason: 'draft-has-pending-work',
        next: 'Resolve or stop the exact pending work before editing this task.',
      };
    if (task.runId && (!run || run.taskId !== task.id))
      return { outcome: 'blocked', reason: 'run-not-current' };
    if (
      run &&
      (run.revision !== 0 ||
        this.store.list<Attempt>('attempt').some((attempt) => attempt.runId === run.id) ||
        this.store.intents().some((intent) => intent.run_id === run.id) ||
        this.store.receipt(`allocation:${run.id}`))
    )
      return {
        outcome: 'blocked',
        reason: 'prepared-run-started',
        next: 'Inspect the retained run. Only a never-started draft can be edited here.',
      };
  }

  private prepare(command: Extract<Command, { command: 'PrepareRun' }>): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId);
    if (!task || !['draft', 'stopped', 'interrupted', 'failed', 'ready'].includes(task.state))
      return { outcome: 'blocked', reason: 'task-not-preparable' };
    const editGate = this.draftEditGate(task);
    if (editGate) return editGate;
    if (this.hasUncertainWriter(task.id))
      return {
        outcome: 'blocked',
        reason: 'writer-ownership-unknown',
        next: 'Prove the old process group has stopped before preparing another run.',
      };
    const roles = command.payload.roles;
    if (
      new Set(roles.map((role) => role.role)).size !== roles.length ||
      !roles.some((role) => role.role === 'coder')
    )
      return {
        outcome: 'blocked',
        reason: 'choose-one-coder',
        next: 'Choose one coder route. Other roles are optional.',
      };
    for (const role of roles) {
      for (const routeId of [role.routeId, ...role.approvedFallbacks])
        if (!this.store.get<Route>('route', routeId)?.fake)
          return { outcome: 'denied', reason: 'route-not-available' };
    }
    const resolved = PolicySchema.parse(command.payload.policy);
    if (resolved.methods?.some((method) => method.id === 'round-robin'))
      return {
        outcome: 'blocked',
        reason: 'review-panel-unavailable',
        next: 'Round-robin needs an explicit review panel. Choose another supported method for this run.',
      };
    if (
      resolved.methods?.some(
        (method) => method.id === 'second-opinion' && method.reviewerRole !== 'reviewer',
      )
    )
      return {
        outcome: 'blocked',
        reason: 'review-role-ineligible',
        next: 'Assign Second opinion to the Reviewer role. Advisor findings do not fulfill independent review.',
      };
    const required = requiredReviewMethodIds(resolved.quality);
    const defaultRole = roles.some((role) => role.role === 'reviewer') ? 'reviewer' : 'advisor';
    const methods = [...(resolved.methods ?? [])];
    for (const id of required)
      if (!methods.some((method) => method.id === id))
        methods.push({
          id,
          cycles: 1,
          reviewerRole: id === 'second-opinion' ? 'reviewer' : defaultRole,
        });
    const methodOrder = requiredReviewMethodIds('thorough');
    resolved.methods = methods.sort(
      (a, b) => methodOrder.indexOf(a.id) - methodOrder.indexOf(b.id),
    );
    for (const method of resolved.methods ?? [])
      if (!roles.some((role) => role.role === method.reviewerRole))
        return {
          outcome: 'blocked',
          reason: 'review-role-missing',
          next: `Choose a ${method.reviewerRole} route for ${method.id}.`,
        };
    const reviewAttempts = (resolved.methods ?? []).reduce((sum, method) => sum + method.cycles, 0);
    if (command.payload.policy.limits.attempts < reviewAttempts + 2)
      return {
        outcome: 'blocked',
        reason: 'review-budget-insufficient',
        next: 'Reserve one writer attempt, one check attempt and every selected review cycle.',
      };
    const path = this.projectPath(task.projectId);
    if (!path) return { outcome: 'blocked', reason: 'project-not-found' };
    const source = inspectSource(task.projectId, path);
    committedFiles(path, source.base);
    const policy = { policy: resolved, hash: hashCanonical(resolved) };
    const decision = this.routing({ roles, policy });
    const run = RunSchema.parse({
      id: this.id('run'),
      taskId: task.id,
      source,
      policy,
      roles,
      decision,
      revision: 0,
    });
    this.store.put('run', run.id, run.revision, run);
    this.store.putRunPurpose(run, 'execution', task.runId);
    const updated = this.updateTask(task, {
      runId: run.id,
      state: 'draft',
      waitingReason: null,
      next: decision.chosen ? 'Review the launch card and start.' : 'No route can admit this work.',
    });
    this.event('run.prepared', task.id, updated.revision, run);
    return { outcome: 'applied', entity: run, revision: updated.revision };
  }

  private start(
    command: Extract<Command, { command: 'StartRun' | 'ResumeRun' }>,
    effects: (() => void)[],
    approved?: string,
    planned?: Attempt,
    transfer = false,
    native?: NativeBinding,
    acpContext?: CapturedContext,
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId);
    const run = this.store.get<Run>('run', command.payload.runId);
    if (run && this.store.runPurpose(run.id) === 'conversation') {
      if (!task || run.taskId !== task.id || task.runId !== run.id)
        return { outcome: 'blocked', reason: 'run-not-current' };
      if (command.command !== 'ResumeRun')
        return { outcome: 'blocked', reason: 'planning-run-requires-message' };
      const boundary = this.conversationBoundary(run.taskId);
      if (boundary) return { outcome: 'blocked', reason: boundary };
      const config = this.conversationConfiguration(run.taskId);
      if (!config) return { outcome: 'blocked', reason: 'not-configured' };
      this.saveConversationConfiguration(run.taskId, { ...config, paused: false });
      if (!this.conversation.pendingInputs(run.taskId).length) {
        const updated = this.updateTask(task as Task, {
          state: 'draft',
          waitingReason: null,
          next: 'Send a message to continue planning.',
        });
        return { outcome: 'applied', entity: updated, revision: updated.revision };
      }
      return this.admitConversation(run.taskId, effects);
    }
    if (this.closed) return { outcome: 'blocked', reason: 'controller-closing' };
    if (!native && run && this.store.receipt(`native-run:${run.id}`)) {
      if (
        command.command !== 'StartRun' ||
        !this.store.receipt(`native-prepared:${run.id}`) ||
        this.store.intents().some((intent) => intent.run_id === run.id)
      )
        return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
      try {
        native = this.preparedNativeBinding(run);
        planned = native.attempt;
      } catch (error) {
        if (error instanceof Error && error.message === 'provider-policy-restricted')
          return nativeProviderRestriction;
        return {
          outcome: 'blocked',
          reason: 'native-preparation-unavailable',
          next: 'Prepare the native proposal again after reviewing its source, consent and client.',
        };
      }
    }
    if (task && !approved && !transfer && !native) {
      const gate = this.resumeGate(task, command.payload.runId);
      if (gate) return gate;
    }
    if (!task || !run || run.taskId !== task.id || task.runId !== run.id)
      return { outcome: 'blocked', reason: 'run-not-current' };
    if (native && 'acp' in native.appointment && !acpContext)
      return { outcome: 'blocked', reason: 'acp-context-unavailable' };
    if (this.hasUncertainWriter(task.id))
      return {
        outcome: 'blocked',
        reason: 'writer-ownership-unknown',
        next: 'Wait for proof that the prior process group is gone.',
      };
    if (!['draft', 'stopped', 'interrupted', 'waiting'].includes(task.state))
      return { outcome: 'blocked', reason: 'task-not-startable' };
    if (transfer && this.store.receipt(`paused:${run.id}`))
      return {
        outcome: 'blocked',
        reason: 'admissions-paused',
        next: 'Resume explicitly after inspecting the retained candidate.',
      };
    const project = this.store.get<Project>('project', task.projectId);
    if (!project) return { outcome: 'blocked', reason: 'project-not-found' };
    const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
    if (hashCanonical(source) !== hashCanonical(run.source))
      return {
        outcome: 'blocked',
        reason: 'source-preview-changed',
        next: 'Prepare the launch card again.',
      };
    const target = this.pendingSwitch(run);
    const decision = native
      ? this.nativeDecision(native.appointment, run, !!native.public)
      : this.routing(run, 'coder', target);
    if (!decision.chosen)
      return {
        outcome: 'blocked',
        reason: target ? 'route-not-admissible' : 'capacity-unavailable',
        next: target
          ? `Selected route ${target} cannot pass the saved pin, allowance or slot gates. Resume to recheck, or stop to cancel the switch.`
          : 'Wait for usable allowance or choose an approved route.',
      };
    if (
      command.command === 'StartRun' &&
      !native?.handoff &&
      decision.chosen !== run.decision.chosen
    )
      return {
        outcome: 'blocked',
        reason: 'route-preview-changed',
        next: 'Prepare the launch card again.',
      };
    const attempt =
      planned ??
      AttemptSchema.parse({
        id: this.id('att'),
        runId: run.id,
        routeId: decision.chosen,
        generation: this.store
          .intents()
          .filter(
            (value) =>
              value.run_id === run.id && value.scratch_path === join(this.home, 'scratch', run.id),
          ).length,
        state: 'intent',
        revision: 0,
      });
    if (attempt.routeId !== decision.chosen)
      return {
        outcome: 'blocked',
        reason: 'approved-route-changed',
        next: 'Request approval for the current route.',
      };
    const allocation = native?.handoff ? undefined : this.grant(run, 'write-scratch', project.name);
    const allocated = this.store.receipt(`allocation:${run.id}`);
    if (!allocation && !approved && !allocated && !native?.handoff) {
      this.store.put('attempt', attempt.id, attempt.revision, attempt);
      return this.requestAction(task, run, attempt, 'write-scratch', project.name, {
        kind: 'command',
        command,
        plannedAttempt: attempt,
        ...(this.latestContext(run.id)?.packet.candidate
          ? {
              candidateId: this.latestContext(run.id)?.packet.candidate?.id,
              candidateHash: this.latestContext(run.id)?.packet.candidate?.hash,
            }
          : {}),
      });
    }
    const spent = this.store.intents().filter((intent) => intent.run_id === run.id).length;
    const reviewReserve = (run.policy.policy.methods ?? []).reduce(
      (sum, method) => sum + method.cycles,
      0,
    );
    const previousCandidate = this.latestCandidate(run.id);
    const checkReserve =
      previousCandidate && this.checks(previousCandidate).some((check) => check.passed) ? 0 : 1;
    if (spent + reviewReserve + checkReserve >= run.policy.policy.limits.attempts)
      return {
        outcome: 'blocked',
        reason: 'attempt-budget-exhausted',
        next: 'Prepare a new bounded run with enough review headroom.',
      };
    const remaining = this.remaining(run);
    if (remaining.attempts < reviewReserve + checkReserve + 1)
      return {
        outcome: 'blocked',
        reason: 'review-budget-insufficient',
        next: 'The remaining task allowance must cover the writer, checks and selected reviews.',
      };
    if (remaining.attempts === 0 || remaining.minutes === 0 || remaining.concurrency === 0)
      return { outcome: 'blocked', reason: 'run-budget-exhausted' };
    const lease = this.store.db
      .prepare('SELECT attempt_id FROM writer_leases WHERE task_id=?')
      .get(task.id);
    if (lease) return { outcome: 'blocked', reason: 'writer-lease-held' };
    const googleBlocker = this.store.googleStartBlocker(attempt.routeId);
    if (googleBlocker) return { outcome: 'blocked', reason: googleBlocker };
    const nativeTools =
      native && 'repository' in native.appointment
        ? this.grant(run, 'run-native-tools', project.name)
        : undefined;
    if (native && 'repository' in native.appointment && !nativeTools)
      return { outcome: 'blocked', reason: 'native-tools-grant-unavailable' };
    this.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run(`paused:${run.id}`);
    this.store.put('attempt', attempt.id, attempt.revision, attempt);
    if (native?.handoff) {
      this.nativeManualAuthority(native, false);
      const authority = this.nativeRecord(
        `native-handoff-prepared:${native.handoff.preparationId}`,
      );
      this.store.saveReceipt(
        `native-handoff-consumed:${attempt.id}`,
        authority.artifact.hash,
        'local-owner',
        { outcome: 'applied', entity: authority.artifact },
      );
    }
    if (allocation) this.consumeGrant(run, allocation);
    if (nativeTools) this.consumeGrant(run, nativeTools);
    if (!allocated)
      this.store.saveReceipt(
        `allocation:${run.id}`,
        hashCanonical({ runId: run.id, grant: allocation ?? null, approvalId: approved ?? null }),
        'local-owner',
        { outcome: 'applied', entity: run },
      );
    const scratchPath = native?.handoff
      ? join(this.home, 'scratch-handoffs', run.id, attempt.id)
      : join(this.home, 'scratch', run.id);
    this.store.db
      .prepare('INSERT INTO writer_leases(task_id,attempt_id,generation) VALUES (?,?,?)')
      .run(task.id, attempt.id, attempt.generation);
    this.store.db
      .prepare(
        "INSERT INTO launch_intents(attempt_id,task_id,run_id,route_id,generation,scratch_path,state,admitted_at) VALUES (?,?,?,?,?,?,'intent',?)",
      )
      .run(
        attempt.id,
        task.id,
        run.id,
        attempt.routeId,
        attempt.generation,
        scratchPath,
        this.now(),
      );
    const windows = this.store
      .list<Observation>('window')
      .filter((value) => value.routeId === attempt.routeId && value.kind !== 'local');
    if (native && 'acp' in native.appointment)
      this.store.bindNativeProfile(attempt.id, 'google-acp-v1');
    for (const window of windows.length
      ? windows
      : [{ windowId: 'local', remaining: { unit: 'minutes' } }])
      this.store.db
        .prepare(
          'INSERT INTO reservations(attempt_id,route_id,window_id,unit,value,launches,minutes) VALUES (?,?,?,?,0,1,?)',
        )
        .run(
          attempt.id,
          attempt.routeId,
          window.windowId,
          window.remaining?.unit ?? 'minutes',
          remaining.minutes,
        );
    const admitted = { ...run, decision, revision: run.revision + 1 };
    this.store.put('run', run.id, admitted.revision, admitted);
    if (native?.handoff) {
      this.store.saveReceipt(
        `native-attempt-plan:${attempt.id}`,
        hashCanonical(native.appointment),
        'local-owner',
        { outcome: 'applied', entity: native.planArtifact },
      );
      this.store.db
        .prepare('DELETE FROM receipts WHERE command_key=?')
        .run(`native-current:${run.id}`);
      this.store.saveReceipt(
        `native-current:${run.id}`,
        hashCanonical(native.appointment),
        'local-owner',
        { outcome: 'applied', entity: native.planArtifact },
      );
    }
    if (target)
      this.store.db
        .prepare('UPDATE receipts SET result=? WHERE command_key=?')
        .run(canonicalJson({ outcome: 'applied', entity: admitted }), `switch:${run.id}`);
    const updated = this.updateTask(task, {
      state: 'running',
      waitingReason: null,
      next: 'Waiting for provider output.',
    });
    this.event('run.admitted', task.id, updated.revision, admitted);
    const intent = this.store
      .intents()
      .find((value) => value.attempt_id === attempt.id) as LaunchIntent;
    effects.push(() => {
      if (!native) this.options.afterIntent?.(intent);
      if (native)
        this.launchNative(
          intent,
          freezeNative({
            ...native,
            run: admitted,
            attempt,
            ...(acpContext ? { context: acpContext } : {}),
          }),
        );
      else this.launch(intent, admitted, attempt);
    });
    return { outcome: 'applied', entity: updated, revision: updated.revision };
  }

  private repositoryScope(sourceBase: string, files: NativeBinding['manifest']) {
    const manifest = files.map(({ path, mode, hash, bytes }) => ({ path, mode, hash, bytes }));
    return NativeRepositoryScopeSchema.parse({
      sourceBase,
      manifestHash: hashCanonical(manifest),
      files: manifest.length,
      bytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
    });
  }

  private resolveProfiles(): NativeProfileResolution[] {
    const profiles = [
      ...(this.options.nativeProfiles?.() ?? [
        this.options.nativeProfile?.() ?? unavailableNativeProfile(),
      ]),
    ];
    if (this.options.registerGoogleAcp || this.options.googleAcp)
      profiles.push(this.acpResolution());
    if (
      profiles.length > 6 ||
      new Set(profiles.map((profile) => profile.facts.id)).size !== profiles.length
    )
      throw Error('Native profile identities are invalid.');
    for (const profile of profiles) NativeProfileSchema.parse(profile.facts);
    return profiles;
  }

  private profileFor(id: string): NativeProfileResolution {
    this.profiles = this.resolveProfiles();
    return this.profiles.find((profile) => profile.facts.id === id) ?? unavailableNativeProfile();
  }

  private acpProof(proofId = this.store.googleAcpSetup().proofId): AcpSetupProof | null {
    if (!proofId) return null;
    const artifact = this.store.get<Artifact>('artifact', proofId);
    if (!artifact || artifact.bytes > MAX_FRAME_BYTES)
      throw Error('ACP setup proof is unavailable.');
    const bytes = this.artifacts.read(artifact.hash);
    if (bytes.length !== artifact.bytes) throw Error('ACP setup proof changed.');
    return AcpSetupProofSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  }

  private acpResolution(): NativeProfileResolution & AcpProfileResolution {
    let proof: AcpSetupProof | null = null;
    try {
      proof = this.acpProof();
    } catch {}
    const resolved =
      this.options.googleAcp?.resolve?.(proof) ??
      resolveGoogleAcpProfile({ home: this.home, proof, environment: process.env });
    return {
      ...resolved,
      ...(resolved.client && resolved.environment
        ? {
            locationHash: hashCanonical({
              executable: resolved.client.executable,
              client: resolved.client.sha256,
              home: resolved.environment.HOME,
            }),
          }
        : {}),
    };
  }

  private nativeRuns(): z.infer<typeof NativeRunSchema>[] {
    return this.store.list<Run>('run').flatMap((run) => {
      const origin = this.store.receipt(this.currentNativePlanKey(run.id));
      if (!origin) return [];
      const prepared = this.store.receipt(`native-prepared:${run.id}`);
      try {
        const artifact = ArtifactSchema.parse(origin.result.entity);
        if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Native plan exceeds its bound.');
        const plan = JSON.parse(this.artifacts.read(artifact.hash).toString('utf8'));
        const appointment = NativeAppointmentSchema.parse(plan.appointment);
        const publicScope = NativePublicScopeSchema.safeParse(plan.public).data;
        const handoff = this.nativeHandoffPreview(run);
        return [
          NativeRunSchema.parse({
            runId: run.id,
            profileId: publicScope?.profileId ?? 'private-native-file',
            stage:
              prepared &&
              this.store.get<Task>('task', run.taskId)?.runId === run.id &&
              this.store.get<Task>('task', run.taskId)?.state === 'draft' &&
              publicScope &&
              !this.store.intents().some((intent) => intent.run_id === run.id)
                ? 'prepared'
                : 'retain-only',
            expiresAt: appointment.expiresAt,
            ...(handoff ? { handoff } : {}),
            ...(appointment.billingAttestation
              ? { billingAttestation: appointment.billingAttestation }
              : {}),
            ...(appointment.permissionMode ? { permissionMode: appointment.permissionMode } : {}),
            ...('acp' in appointment ? { acp: appointment.acp } : {}),
            ...('repository' in appointment
              ? { repository: appointment.repository, execution: appointment.execution }
              : {
                  target: {
                    path: appointment.target.path,
                    baseHash: appointment.target.baseHash,
                    bytes: plan.manifest.find(
                      (file: { path: string }) => file.path === appointment.target.path,
                    )?.bytes,
                  },
                }),
          }),
        ];
      } catch {
        return [
          { runId: run.id, profileId: 'unavailable-native-plan', stage: 'retain-only' as const },
        ];
      }
    });
  }

  private nativeManualTargets(targets: z.infer<typeof NativeHandoffTargetsSchema>) {
    return NativeHandoffTargetsSchema.parse(targets).map((target) => {
      const profile = this.profileFor(target.profileId);
      if (
        profile.facts.family === 'local' ||
        !profile.facts.available ||
        !profile.client ||
        !profile.locationHash ||
        !profile.environment ||
        !profile.facts.creditPolicies.some((policy) => policy === target.creditPolicy)
      )
        throw Error('The manual recipient is unavailable.');
      const route =
        this.nativeProfileRoute(profile, target.creditPolicy) ??
        RouteSchema.parse({
          id: this.id('rte'),
          family: profile.facts.family,
          displayName: profile.facts.displayName,
          model: profile.facts.model,
          effort: {
            requested: profile.facts.effort,
            effective: profile.facts.family === 'openai' ? profile.facts.effort : 'unknown',
            supported: [profile.facts.effort],
          },
          billing: target.creditPolicy === 'ordinary' ? 'included' : 'credits',
          qualified: false,
          fake: false,
        });
      return {
        target,
        profile: profile.facts,
        client: profile.client,
        locationHash: profile.locationHash,
        route,
      };
    });
  }

  private nativeManualRoster(run: Run) {
    const origin = NativeHistoricalPreparationSchema.parse(
      this.nativeRecord(`native-run:${run.id}`).value,
    );
    const roster = NativeManualRosterSchema.parse(
      this.nativeRecord(`native-handoff-roster:${run.id}`).value,
    );
    if (
      roster.runId !== run.id ||
      !origin.public?.manualTargetsHash ||
      hashCanonical(roster.targets) !== origin.public.manualTargetsHash ||
      hashCanonical(origin.run.source) !== hashCanonical(run.source) ||
      hashCanonical(origin.run.policy) !== hashCanonical(run.policy) ||
      hashCanonical(origin.run.roles) !== hashCanonical(run.roles)
    )
      throw Error('authority-unavailable');
    return roster;
  }

  private currentNativePlanKey(runId: string) {
    return this.store.receipt(`native-current:${runId}`)
      ? `native-current:${runId}`
      : `native-run:${runId}`;
  }

  private writerScratch(run: Run) {
    if (this.store.receipt(`native-current:${run.id}`)) {
      const plan = this.nativeCurrentPlan(run);
      const intent = this.store
        .intents()
        .find((value) => value.attempt_id === plan.attempt.id && value.run_id === run.id);
      if (!intent) throw Error('The current native writer intent is unavailable.');
      return intent.scratch_path;
    }
    return join(this.home, 'scratch', run.id);
  }

  private nativeManualAuthority(binding: NativeBinding, consumed: boolean) {
    const link = NativeManualLinkSchema.parse(binding.handoff);
    const { preparation } = link;
    const record = this.nativeRecord(`native-handoff-prepared:${link.preparationId}`);
    const stored = NativeManualPreparationSchema.parse(record.value);
    const run = this.store.get<Run>('run', binding.run.id);
    const task = run && this.store.get<Task>('task', run.taskId);
    const project = run && this.store.get<Project>('project', run.source.projectId);
    if (
      !run ||
      !task ||
      !project ||
      task.runId !== run.id ||
      record.artifact.id !== link.preparationId ||
      hashCanonical(stored) !== hashCanonical(preparation) ||
      preparation.runId !== run.id ||
      preparation.candidate.taskId !== task.id ||
      preparation.attemptId !== binding.attempt.id ||
      preparation.generation !== binding.attempt.generation ||
      preparation.route.id !== binding.attempt.routeId ||
      hashCanonical(preparation.route) !== hashCanonical(binding.appointment.route) ||
      preparation.authority.policyHash !== run.policy.hash ||
      preparation.authority.criteriaHash !== hashCanonical(task.criteria) ||
      preparation.authority.target !== project.name ||
      Date.parse(preparation.authority.expiresAt) <= Date.parse(this.now()) ||
      !this.grant(run, 'write-scratch', project.name) ||
      Buffer.byteLength(canonicalJson(preparation.packet)) > 65536 ||
      !verifyHandoff(preparation.packet) ||
      preparation.packet.packet.attemptId !== preparation.fromAttemptId ||
      preparation.packet.packet.generation + 1 !== preparation.generation ||
      hashCanonical(preparation.packet.packet.source) !== hashCanonical(run.source) ||
      hashCanonical(preparation.packet.packet.policy) !== hashCanonical(run.policy) ||
      hashCanonical(preparation.packet.packet.candidate) !== hashCanonical(preparation.candidate) ||
      preparation.packet.packet.allowedRouteIds.length !== 1 ||
      preparation.packet.packet.allowedRouteIds[0] !== preparation.route.id
    )
      throw Error('The exact manual handoff authority is unavailable.');
    const roster = this.nativeManualRoster(run);
    if (
      !roster.targets.some(
        (entry) =>
          hashCanonical(entry.target) === hashCanonical(preparation.recipient) &&
          hashCanonical(entry.route) === hashCanonical(preparation.route) &&
          hashCanonical(entry.profile) === hashCanonical(preparation.profile) &&
          hashCanonical(entry.client) === hashCanonical(preparation.client) &&
          entry.locationHash === preparation.locationHash,
      )
    )
      throw Error('The manual recipient is outside the initial roster.');
    const used = this.store.receipt(`native-handoff-consumed:${binding.attempt.id}`);
    if (
      consumed
        ? used?.hash !== record.artifact.hash
        : !!used ||
          this.store.receipt(`native-handoff-pending:${run.id}`)?.hash !== record.artifact.hash
    )
      throw Error('The manual handoff authority was consumed or replaced.');
    return preparation;
  }

  private nativeManualHistory(plan: z.infer<typeof NativeHistoricalPreparationSchema>) {
    if (!plan.handoff) return;
    const { preparationId, preparation } = plan.handoff;
    const record = this.nativeRecord(`native-handoff-prepared:${preparationId}`);
    const consumed = this.store.receipt(`native-handoff-consumed:${plan.attempt.id}`);
    const preceding = this.store.get<Attempt>('attempt', preparation.fromAttemptId);
    const previous = NativeHistoricalPreparationSchema.parse(
      this.nativeRecord(`native-attempt-plan:${preparation.fromAttemptId}`).value,
    );
    const retained = this.evidence.read(preparation.candidate);
    const target = retained.files.find((file) => file.path === preparation.target.path);
    if (
      'repository' in plan.appointment ||
      !preceding ||
      preceding.state !== 'stopped' ||
      previous.attempt.id !== preceding.id ||
      preceding.generation + 1 !== plan.attempt.generation ||
      preparation.generation !== plan.attempt.generation ||
      preparation.attemptId !== plan.attempt.id ||
      preparation.runId !== plan.run.id ||
      preceding.runId !== plan.run.id ||
      hashCanonical(previous.run.source) !== hashCanonical(plan.run.source) ||
      hashCanonical(previous.run.policy) !== hashCanonical(plan.run.policy) ||
      hashCanonical(previous.run.roles) !== hashCanonical(plan.run.roles) ||
      record.artifact.id !== preparationId ||
      consumed?.hash !== record.artifact.hash ||
      hashCanonical(record.value) !== hashCanonical(preparation) ||
      Buffer.byteLength(canonicalJson(preparation.packet)) > 65536 ||
      !verifyHandoff(preparation.packet) ||
      preparation.packet.packet.attemptId !== preceding.id ||
      hashCanonical(preparation.packet.packet.candidate) !== hashCanonical(preparation.candidate) ||
      hashCanonical(preparation.packet.packet.source) !== hashCanonical(plan.run.source) ||
      hashCanonical(preparation.packet.packet.policy) !== hashCanonical(plan.run.policy) ||
      this.store.receipt(`candidate:${preceding.id}`)?.hash !== preparation.candidate.hash ||
      !this.store.nativeProcesses(preceding.id).length ||
      this.store.nativeProcesses(preceding.id).some((phase) => phase.state !== 'quiescent') ||
      !target ||
      target.hash !== preparation.target.baseHash ||
      target.bytes !== preparation.target.bytes ||
      target.path !== plan.appointment.target.path ||
      target.hash !== plan.originalHash ||
      target.hash !== plan.appointment.target.baseHash ||
      hashCanonical(retained.files.map(({ content: _content, ...file }) => file)) !==
        hashCanonical(plan.manifest) ||
      hashCanonical(preparation.route) !== hashCanonical(plan.appointment.route)
    )
      throw Error('Manual handoff evidence changed.');
    const roster = this.nativeManualRoster(plan.run);
    if (
      !roster.targets.some(
        (entry) =>
          hashCanonical(entry.target) === hashCanonical(preparation.recipient) &&
          hashCanonical(entry.route) === hashCanonical(plan.appointment.route),
      )
    )
      throw Error('Manual handoff recipient changed.');
  }

  private startNativeHandoff(
    command: Extract<Command, { command: 'StartNativeHandoff' }>,
    effects: (() => void)[],
  ): CommandResult {
    let binding: Omit<NativeBinding, 'planArtifact'>;
    try {
      const run = this.store.get<Run>('run', command.payload.runId);
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (!run || !task || run.taskId !== task.id || task.runId !== run.id)
        throw Error('Run changed.');
      const gate = this.nativeHandoffGate(run);
      if (!gate.available) throw Error('Handoff is unavailable.');
      const record = this.nativeRecord(`native-handoff-prepared:${command.payload.preparationId}`);
      if (
        record.artifact.id !== command.payload.preparationId ||
        this.store.receipt(`native-handoff-pending:${run.id}`)?.hash !== record.artifact.hash
      )
        throw Error('Preparation changed.');
      const preparation = NativeManualPreparationSchema.parse(record.value);
      const current = this.nativeCurrentPlan(run);
      if (
        preparation.runId !== run.id ||
        preparation.fromAttemptId !== current.attempt.id ||
        preparation.generation !== current.attempt.generation + 1 ||
        current.public?.profileId === preparation.recipient.profileId
      )
        throw Error('Predecessor changed.');
      const profile = this.profileFor(preparation.recipient.profileId);
      if (
        !profile.facts.available ||
        !profile.environment ||
        hashCanonical(profile.facts) !== hashCanonical(preparation.profile) ||
        hashCanonical(profile.client) !== hashCanonical(preparation.client) ||
        profile.locationHash !== preparation.locationHash
      )
        throw Error('Recipient changed.');
      if (
        hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(run.source)
      )
        throw Error('Source changed.');
      const prior = this.store
        .intents()
        .find((value) => value.attempt_id === preparation.fromAttemptId);
      if (
        !prior ||
        this.evidence.hash(run.source.base, readFiles(prior.scratch_path)) !==
          preparation.candidate.hash
      )
        throw Error('Retained work changed.');
      const files = this.evidence.read(preparation.candidate).files;
      const original = files.find((file) => file.path === preparation.target.path);
      if (
        !original ||
        original.hash !== preparation.target.baseHash ||
        original.bytes !== preparation.target.bytes
      )
        throw Error('Retained target changed.');
      const appointment = NativeFileAppointmentSchema.parse({
        id: command.key.replaceAll('_', '-'),
        taskId: task.id,
        route: preparation.route,
        client: preparation.client,
        creditPolicy: preparation.recipient.creditPolicy,
        ...(preparation.billingAttestation
          ? { billingAttestation: preparation.billingAttestation }
          : {}),
        ...(preparation.permissionMode ? { permissionMode: preparation.permissionMode } : {}),
        target: { path: preparation.target.path, baseHash: preparation.target.baseHash },
        consent: {
          nativeTrust: 'accepted',
          source: 'explicit',
          policyHash: run.policy.hash,
          sourceBase: run.source.base,
          criteriaHash: hashCanonical(task.criteria),
        },
        policy: run.policy.policy,
        expiresAt: preparation.authority.expiresAt,
        maximumTaskMs: Math.min(
          preparation.profile.maximumTaskMs,
          (this.remaining(run).minutes - 2) * 60000,
        ),
        maximumSubmissions: 1,
      });
      const attempt = AttemptSchema.parse({
        id: preparation.attemptId,
        runId: run.id,
        routeId: preparation.route.id,
        generation: preparation.generation,
        state: 'intent',
        revision: 0,
      });
      const sessionHash = hashCanonical({ attemptId: attempt.id });
      const anthropicSessionId =
        preparation.route.family === 'anthropic'
          ? `${sessionHash.slice(0, 8)}-${sessionHash.slice(8, 12)}-8${sessionHash.slice(13, 16)}-a${sessionHash.slice(17, 20)}-${sessionHash.slice(20, 32)}`
          : undefined;
      binding = {
        appointment,
        run,
        attempt,
        original: new TextDecoder('utf-8', { fatal: true }).decode(original.content),
        baseHash: original.hash,
        manifest: files.map(({ content: _content, ...file }) => file),
        ...(anthropicSessionId ? { anthropicSessionId } : {}),
        public: {
          profileId: preparation.recipient.profileId,
          locationHash: preparation.locationHash,
          scopeHash: record.artifact.hash,
          context: { title: task.title, outcome: task.outcome },
        },
        handoff: { preparationId: record.artifact.id, preparation },
        environment: { ...profile.environment },
      };
      this.nativeManualAuthority({ ...binding, planArtifact: record.artifact }, false);
      this.nativeWriterPlan(binding);
      if (Buffer.byteLength(canonicalJson(this.nativePlanPayload(binding))) > MAX_FRAME_BYTES)
        throw Error('Native handoff plan exceeds its bound.');
    } catch {
      return {
        outcome: 'blocked',
        reason: 'native-handoff-start-unavailable',
        next: 'Prepare an exact handoff after inspecting the retained work, recipient and original limits.',
      };
    }
    const planArtifact = this.nativeArtifact(this.nativePlanPayload(binding));
    this.store.put('route', binding.appointment.route.id, 0, binding.appointment.route);
    const start = {
      ...command,
      command: 'StartRun' as const,
      payload: { taskId: command.payload.taskId, runId: command.payload.runId },
    };
    return this.start(start, effects, undefined, binding.attempt, false, {
      ...binding,
      planArtifact,
    });
  }

  private nativeCurrentPlan(run: Run) {
    const key = this.currentNativePlanKey(run.id);
    return NativeHistoricalPreparationSchema.parse(this.nativeRecord(key).value);
  }

  private nativeHandoffGate(run: Run): z.infer<typeof NativeHandoffPreviewSchema>['prepare'] {
    const unavailable = (
      reason: z.infer<typeof NativeHandoffPreviewSchema>['prepare']['reason'],
    ) => ({ available: false, reason });
    const task = this.store.get<Task>('task', run.taskId);
    if (this.closed || this.store.receipt(`paused:${run.id}`))
      return unavailable('admissions-paused');
    if (!task || task.runId !== run.id) return unavailable('authority-unavailable');
    if (this.hasUncertainWriter(task.id))
      return unavailable(task.state === 'unknown' ? 'ownership-unknown' : 'writer-active');
    if (!['stopped', 'interrupted'].includes(task.state))
      return unavailable('retained-work-unavailable');
    const plan = this.nativeCurrentPlan(run);
    const writer = this.store.get<Attempt>('attempt', plan.attempt.id);
    const intents = this.store.intents().filter((value) => value.run_id === run.id);
    const phases = this.store.nativeProcesses(plan.attempt.id);
    if (
      writer?.state !== 'stopped' ||
      intents.at(-1)?.attempt_id !== writer.id ||
      !phases.length ||
      phases.some((phase) => phase.state !== 'quiescent')
    )
      return unavailable('ownership-unknown');
    if (!this.store.receipt(`candidate:${writer.id}`))
      return unavailable('retained-work-unavailable');
    const remaining = this.remaining(run);
    const reviews = (run.policy.policy.methods ?? []).reduce(
      (sum, method) => sum + method.cycles,
      0,
    );
    const allowance = run.policy.policy.unknownUsage;
    if (
      remaining.attempts < reviews + 2 ||
      remaining.minutes <= 2 ||
      remaining.concurrency < 1 ||
      allowance.rule !== 'fixed-allowance'
    )
      return unavailable('budget-exhausted');
    const project = this.store.get<Project>('project', run.source.projectId);
    if (!project || !this.grant(run, 'write-scratch', project.name))
      return unavailable('authority-unavailable');
    return { available: true, reason: 'available' };
  }

  private nativeHandoffPreview(run: Run) {
    if (!this.store.receipt(`native-handoff-roster:${run.id}`)) return;
    const roster = this.nativeManualRoster(run);
    const plan = this.nativeCurrentPlan(run);
    const prepare = this.nativeHandoffGate(run);
    const saved = this.store.receipt(`native-handoff-pending:${run.id}`);
    const pending =
      saved &&
      NativeManualPreparationSchema.parse(
        this.nativeRecord(`native-handoff-pending:${run.id}`).value,
      );
    const relevant = pending?.fromAttemptId === plan.attempt.id;
    const consumed = relevant && this.store.receipt(`native-handoff-consumed:${pending.attemptId}`);
    const start = consumed
      ? { available: false, reason: 'already-started' as const }
      : pending && Date.parse(pending.authority.expiresAt) <= Date.parse(this.now())
        ? { available: false, reason: 'authority-unavailable' as const }
        : prepare;
    return NativeHandoffPreviewSchema.parse({
      targets: roster.targets.map(({ target }) => target),
      currentAttemptId: plan.attempt.id,
      generation: plan.attempt.generation,
      prepare,
      ...(pending && relevant
        ? {
            pending: {
              preparationId: ArtifactSchema.parse(saved?.result.entity).id,
              packetId: pending.packet.packet.id,
              fromAttemptId: pending.fromAttemptId,
              generation: pending.generation,
              recipient: pending.recipient,
              baseHash: pending.target.baseHash,
              bytes: pending.target.bytes,
              expiresAt: pending.authority.expiresAt,
              start,
            },
          }
        : {}),
    });
  }

  private prepareNativeHandoff(
    command: Extract<Command, { command: 'PrepareNativeHandoff' }>,
  ): CommandResult {
    let prepared: z.infer<typeof NativeManualPreparationSchema>;
    let task: Task;
    try {
      const run = this.store.get<Run>('run', command.payload.runId);
      const currentTask = this.store.get<Task>('task', command.payload.taskId);
      if (!run || !currentTask || run.taskId !== currentTask.id || currentTask.runId !== run.id)
        throw Error('authority-unavailable');
      task = currentTask;
      const gate = this.nativeHandoffGate(run);
      if (!gate.available) throw Error(gate.reason);
      const plan = this.nativeCurrentPlan(run);
      if (!('target' in plan.appointment) || plan.attempt.id !== command.payload.fromAttemptId)
        throw Error('authority-unavailable');
      const roster = this.nativeManualRoster(run);
      const selected = roster.targets.find(
        ({ target }) =>
          target.profileId === command.payload.profileId &&
          target.creditPolicy === command.payload.creditPolicy,
      );
      if (!selected || plan.public?.profileId === selected.target.profileId)
        throw Error('recipient-unavailable');
      const profile = this.profileFor(selected.target.profileId);
      this.nativeManualAllowance(
        run,
        selected.route.id,
        Math.max(0, this.remaining(run).minutes - 2),
      );
      if (
        !profile.facts.available ||
        !profile.environment ||
        hashCanonical(profile.facts) !== hashCanonical(selected.profile) ||
        hashCanonical(profile.client) !== hashCanonical(selected.client) ||
        profile.locationHash !== selected.locationHash
      )
        throw Error('recipient-unavailable');
      if (
        hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(run.source)
      )
        throw Error('source-changed');
      const writer = this.store.get<Attempt>('attempt', plan.attempt.id) as Attempt;
      const candidate = CandidateSchema.parse(
        this.store.receipt(`candidate:${writer.id}`)?.result.entity,
      );
      const retained = this.evidence.read(candidate);
      const intent = this.store.intents().find((value) => value.attempt_id === writer.id);
      if (
        !intent ||
        this.evidence.hash(run.source.base, readFiles(intent.scratch_path)) !== candidate.hash
      )
        throw Error('retained-work-unavailable');
      const original = committedFiles(this.projectPath(task.projectId) as string, run.source.base);
      const targetPath = plan.appointment.target.path;
      const target = retained.files.find((file) => file.path === targetPath);
      const siblings = (files: typeof retained.files) =>
        files
          .filter((file) => file.path !== targetPath)
          .map(({ content: _content, ...file }) => file);
      if (
        !target ||
        target.bytes > 65536 ||
        hashCanonical(siblings(original)) !== hashCanonical(siblings(retained.files))
      )
        throw Error('retained-work-unavailable');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(target.content);
      if (text.includes('\0')) throw Error('retained-work-unavailable');
      const writerPacket = this.contextPacket(writer, candidate, false, [selected.route.id]);
      if (Buffer.byteLength(canonicalJson(writerPacket)) > 65536)
        throw Error('retained-work-unavailable');
      const project = this.store.get<Project>('project', task.projectId) as Project;
      const grant = this.grant(run, 'write-scratch', project.name);
      if (!grant) throw Error('authority-unavailable');
      const expiry = new Date(
        Math.min(Date.parse(grant.expiresAt), Date.parse(plan.appointment.expiresAt)),
      ).toISOString();
      const billingAttestation =
        'billingAttestation' in command.payload ? command.payload.billingAttestation : undefined;
      const permissionMode =
        'permissionMode' in command.payload ? command.payload.permissionMode : undefined;
      if (
        (profile.facts.family !== 'openai') !== !!billingAttestation ||
        (profile.facts.family === 'google') !== !!permissionMode ||
        (profile.facts.family === 'google' &&
          (!permissionMode || !profile.facts.permissionModes.includes(permissionMode)))
      )
        throw Error('recipient-unavailable');
      prepared = NativeManualPreparationSchema.parse({
        version: 1,
        runId: run.id,
        fromAttemptId: writer.id,
        attemptId: this.id('att'),
        generation: writer.generation + 1,
        recipient: selected.target,
        profile: selected.profile,
        client: selected.client,
        locationHash: selected.locationHash,
        route: selected.route,
        ...(billingAttestation ? { billingAttestation } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        candidate,
        packet: writerPacket,
        target: { path: target.path, baseHash: target.hash, bytes: target.bytes },
        authority: {
          action: 'write-scratch',
          target: project.name,
          consent: 'explicit',
          policyHash: run.policy.hash,
          criteriaHash: hashCanonical(task.criteria),
          expiresAt: expiry,
        },
      });
    } catch {
      return {
        outcome: 'blocked',
        reason: 'native-handoff-preparation-unavailable',
        next: 'Inspect retained work, recipient consent and original run bounds.',
      };
    }
    const artifact = this.nativeArtifact(prepared);
    const consent = this.nativeArtifact({
      scopeHash: artifact.hash,
      expiresAt: prepared.authority.expiresAt,
    });
    this.store.saveReceipt(`native-consent:${artifact.hash}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: consent,
    });
    this.store.saveReceipt(`native-handoff-prepared:${artifact.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    this.store.db
      .prepare('DELETE FROM receipts WHERE command_key=?')
      .run(`native-handoff-pending:${prepared.runId}`);
    this.store.saveReceipt(
      `native-handoff-pending:${prepared.runId}`,
      artifact.hash,
      'local-owner',
      { outcome: 'applied', entity: artifact },
    );
    this.event('handoff.sealed', task.id, task.revision, prepared.packet);
    const updated = this.updateTask(task, {
      next: 'Review the manual recipient and start the prepared handoff.',
    });
    return { outcome: 'applied', revision: updated.revision, entity: updated };
  }

  private consentRecord(scopeHash: string) {
    const receipt = this.store.receipt(`native-consent:${scopeHash}`);
    if (receipt?.result.outcome !== 'applied') throw Error('Native consent is unavailable.');
    const artifact = ArtifactSchema.parse(receipt.result.entity);
    if (artifact.bytes > 4096) throw Error('Native consent exceeds its bound.');
    const consent = z
      .strictObject({ scopeHash: HashSchema, expiresAt: TimestampSchema })
      .parse(JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')));
    if (consent.scopeHash !== scopeHash || Date.parse(consent.expiresAt) <= Date.parse(this.now()))
      throw Error('Native consent expired.');
    return consent;
  }

  private nativeConsentCurrent(binding: NativeBinding): boolean {
    if (!binding.public) return true;
    try {
      this.consentRecord(binding.public.scopeHash);
      const task = this.store.get<Task>('task', binding.run.taskId);
      return (
        !!task &&
        task.title === binding.public.context.title &&
        task.outcome === binding.public.context.outcome &&
        hashCanonical(task.criteria) === binding.appointment.consent.criteriaHash
      );
    } catch {
      return false;
    }
  }

  private nativeProfileRoute(
    profile: NativeProfileResolution,
    creditPolicy: NativePilotAppointment['creditPolicy'],
  ): Route | undefined {
    if (profile.facts.family === 'local') throw Error('Local native launch is unavailable.');
    const receipt = this.store.receipt(`native-profile-route:${profile.facts.id}:${creditPolicy}`);
    if (!receipt) return;
    const artifact = ArtifactSchema.parse(receipt.result.entity);
    if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Native route binding exceeds its bound.');
    const plan = NativePreparationSchema.parse(
      JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
    );
    const route = this.store.get<Route>('route', plan.appointment.route.id);
    const expected = RouteSchema.parse({
      id: plan.appointment.route.id,
      family: profile.facts.family,
      displayName: profile.facts.displayName,
      model: profile.facts.model,
      effort: {
        requested: profile.facts.effort,
        effective: profile.facts.family === 'openai' ? profile.facts.effort : 'unknown',
        supported: [profile.facts.effort],
      },
      billing: creditPolicy === 'ordinary' ? 'included' : 'credits',
      qualified: false,
      fake: false,
    });
    if (
      receipt.result.outcome !== 'applied' ||
      plan.public.profileId !== profile.facts.id ||
      plan.appointment.creditPolicy !== creditPolicy ||
      hashCanonical(plan.appointment.client) !== hashCanonical(profile.client) ||
      hashCanonical(route) !== hashCanonical(expected)
    )
      throw Error('Native route binding changed.');
    return expected;
  }

  private prepareAcp(command: Extract<Command, { command: 'PrepareNativeRun' }>): CommandResult {
    let writing = false;
    if (command.payload.profileId !== 'google-acp-v1' || !('proofId' in command.payload))
      return { outcome: 'unsupported', reason: 'invalid-command' };
    try {
      const input = command.payload;
      const setup = this.store.googleAcpSetup();
      const profile = this.acpResolution();
      if (
        setup.state !== 'ready' ||
        setup.proofId !== input.proofId ||
        !profile.facts.available ||
        !profile.client ||
        !profile.environment ||
        !profile.locationHash
      )
        throw Error('ACP setup is unavailable.');
      const proof = validateAcpSetupProof(
        this.acpProof(input.proofId),
        profile.client,
        this.options.googleAcp?.reviewMappings,
      );
      if (!proof.reviewMode || !proof.configOptions || proof.auth.status !== 'authenticated')
        throw Error('ACP setup is incomplete.');
      const task = this.store.get<Task>('task', input.taskId);
      if (task?.state !== 'draft' || this.draftEditGate(task))
        throw Error('Task is not preparable.');
      const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
      const files = committedFiles(this.projectPath(task.projectId) as string, source.base);
      const target = files.find((file) => file.path === input.targetPath);
      if (
        !target ||
        target.bytes > 65536 ||
        new TextDecoder('utf-8', { fatal: true }).decode(target.content).includes('\0')
      )
        throw Error('ACP target is unavailable.');
      const policy = PolicySchema.parse(input.policy);
      if (
        policy.authority === 'autopilot' ||
        policy.limits.minutes * 60000 < 300000 ||
        !requiredReviewMethodIds(policy.quality).every((id) =>
          (policy.methods ?? []).some((method) => method.id === id),
        ) ||
        policy.limits.attempts <
          (policy.methods ?? []).reduce((n, method) => n + method.cycles, 0) + 2
      )
        throw Error('ACP policy is unavailable.');
      const runId = this.id('run');
      const grant = this.grant(
        { id: runId, taskId: task.id, policy: { policy, hash: hashCanonical(policy) } },
        'write-scratch',
        (this.store.get<Project>('project', task.projectId) as Project).name,
      );
      if (!grant) throw Error('Scratch authority is unavailable.');
      const acp = GoogleAcpSelectionSchema.parse({
        proofId: input.proofId,
        modelId: input.modelId,
        thoughtLevelId: input.thoughtLevelId,
      });
      const scopeHash = hashCanonical({
        profile: profile.facts,
        client: profile.client,
        proof,
        acp,
        task: { title: task.title, outcome: task.outcome, criteria: task.criteria },
        source,
        target: { path: target.path, hash: target.hash, mode: target.mode },
        policy,
        billingAttestation: input.billingAttestation,
      });
      const expiresAt =
        input.consent === 'saved'
          ? new Date(
              Math.min(
                Date.parse(grant.expiresAt),
                Date.parse(this.consentRecord(scopeHash).expiresAt),
              ),
            ).toISOString()
          : grant.expiresAt;
      const artifact = this.store.get<Artifact>('artifact', input.proofId) as Artifact;
      const route = RouteSchema.parse({
        id: this.id('rte'),
        family: 'google',
        displayName: profile.facts.displayName,
        model: input.modelId,
        effort: {
          requested: input.thoughtLevelId ?? 'unknown',
          effective: 'unknown',
          supported: proof.configOptions.thoughtLevel?.supported ?? [],
        },
        billing: 'included',
        qualified: false,
        fake: false,
      });
      const appointment = NativeAcpAppointmentSchema.parse({
        id: command.key.replaceAll('_', '-'),
        profileId: 'google-acp-v1',
        taskId: task.id,
        route,
        client: profile.client,
        creditPolicy: 'ordinary',
        billingAttestation: input.billingAttestation,
        permissionMode: 'request-review',
        target: { path: target.path, baseHash: target.hash, mode: target.mode },
        acp,
        proof,
        proofHash: artifact.hash,
        consent: {
          nativeTrust: 'accepted',
          source: input.consent === 'explicit' ? 'explicit' : 'policy',
          policyHash: hashCanonical(policy),
          sourceBase: source.base,
          criteriaHash: hashCanonical(task.criteria),
        },
        policy,
        expiresAt,
        maximumTaskMs: 300000,
        maximumSubmissions: 1,
      });
      const run = RunSchema.parse({
        id: runId,
        taskId: task.id,
        source,
        policy: { policy, hash: hashCanonical(policy) },
        roles: [{ role: 'coder', routeId: route.id, pinned: true, approvedFallbacks: [] }],
        decision: {
          chosen: route.id,
          rejected: [],
          rule: 'manual',
          inputsHash: hashCanonical(appointment),
        },
        revision: 0,
      });
      const attempt = AttemptSchema.parse({
        id: this.id('att'),
        runId,
        routeId: route.id,
        generation: 0,
        state: 'intent',
        revision: 0,
      });
      const publicScope = NativePublicScopeSchema.parse({
        profileId: 'google-acp-v1',
        locationHash: profile.locationHash,
        scopeHash,
        context: { title: task.title, outcome: task.outcome },
      });
      const plan = {
        appointment,
        run,
        attempt,
        original: target.content.toString('utf8'),
        baseHash: target.hash,
        manifest: files.map(({ content: _content, ...file }) => file),
        public: publicScope,
        environment: profile.environment,
      };
      this.nativeWriterPlan(plan);
      writing = true;
      const binding = this.saveNativePlan(plan);
      if (input.consent === 'explicit' && !this.store.receipt(`native-consent:${scopeHash}`)) {
        const consent = this.nativeArtifact({ scopeHash, expiresAt });
        this.store.saveReceipt(`native-consent:${scopeHash}`, scopeHash, 'local-owner', {
          outcome: 'applied',
          entity: consent,
        });
      }
      this.store.saveReceipt(
        `native-prepared:${runId}`,
        hashCanonical(publicScope),
        'local-owner',
        { outcome: 'applied', entity: binding.planArtifact },
      );
      const updated = this.updateTask(this.store.get<Task>('task', task.id) as Task, {
        next: 'Review the native preparation and fresh quota before Start.',
      });
      this.event('run.prepared', task.id, updated.revision, run);
      return { outcome: 'applied', entity: run, revision: updated.revision };
    } catch (error) {
      if (writing) throw error;
      return {
        outcome: 'blocked',
        reason: 'acp-preparation-unavailable',
        next: 'Review the current setup proof, model, thought level, billing confirmations, target and policy.',
      };
    }
  }

  private isPreparedAcp(runId: string): boolean {
    try {
      return 'acp' in this.nativeCurrentPlan(this.store.get<Run>('run', runId) as Run).appointment;
    } catch {
      return false;
    }
  }

  private contextClient() {
    return {
      snapshot: async () => this.snapshot(),
      command: (input: Command) => {
        if (!['GetChanges', 'GetArtifact'].includes(input.command))
          return Promise.resolve<CommandResult>({ outcome: 'denied', reason: 'context-read-only' });
        return this.execute(input, 'local-owner');
      },
    };
  }

  private executeAcpStart(
    command: Extract<Command, { command: 'StartRun' }>,
    principal: string,
  ): Promise<CommandResult> {
    const hash = hashCanonical(command),
      prior = this.acpStart;
    if (prior)
      return prior.key === command.key && prior.hash === hash && prior.principal === principal
        ? prior.promise
        : Promise.resolve({
            outcome: prior.key === command.key ? 'denied' : 'blocked',
            reason: prior.key === command.key ? 'idempotency-key-reused' : 'acp-start-preparing',
          });
    if (this.store.receipt(command.key))
      return Promise.resolve(this.commitCommand(command, principal));
    const pending = {
      key: command.key,
      hash,
      principal,
      taskId: command.payload.taskId,
      runId: command.payload.runId,
      aborted: false,
      promise: Promise.resolve<CommandResult>({ outcome: 'blocked' }),
    };
    const refuse = (result: CommandResult) => this.commitCommand(command, principal, result);
    const promise = Promise.resolve().then(async () => {
      try {
        const stale = this.checkRevision(command);
        if (stale) return refuse(stale);
        const task = this.store.get<Task>('task', command.payload.taskId),
          run = this.store.get<Run>('run', command.payload.runId);
        if (!task || !run || task.runId !== run.id)
          return refuse({ outcome: 'blocked', reason: 'run-not-current' });
        const context = await captureContext(this.contextClient(), task.id);
        if (this.closed || pending.aborted)
          return refuse({ outcome: 'blocked', reason: 'acp-start-revoked' });
        if (
          hashCanonical(this.store.get<Task>('task', task.id)) !== hashCanonical(task) ||
          hashCanonical(this.store.get<Run>('run', run.id)) !== hashCanonical(run) ||
          hashCanonical(
            inspectSource(task.projectId, this.projectPath(task.projectId) as string),
          ) !== hashCanonical(run.source)
        )
          return refuse({ outcome: 'blocked', reason: 'acp-start-changed' });
        return this.commitCommand(command, principal, undefined, undefined, context);
      } catch {
        return refuse({ outcome: 'blocked', reason: 'acp-context-unavailable' });
      }
    });
    pending.promise = promise;
    this.acpStart = pending;
    return promise.finally(() => {
      if (this.acpStart === pending) this.acpStart = undefined;
    });
  }

  private prepareNative(command: Extract<Command, { command: 'PrepareNativeRun' }>): CommandResult {
    if (command.payload.profileId === 'google-acp-v1') return this.prepareAcp(command);
    let plan: Omit<NativeBinding, 'planArtifact'>;
    let expiresAt: string;
    let manualTargets: z.infer<typeof NativeManualRosterSchema>['targets'] | undefined;
    try {
      const profile = this.profileFor(command.payload.profileId);
      const facts = NativeProfileSchema.parse(profile.facts);
      if (facts.family === 'local' || !('creditPolicy' in command.payload))
        return {
          outcome: 'unsupported',
          reason: 'native-profile-unavailable',
          next: 'Local native launch is unavailable.',
        };
      const creditPolicy = command.payload.creditPolicy;
      if (facts.reason === 'provider-policy-restricted') return nativeProviderRestriction;
      if (
        !facts.available ||
        !profile.client ||
        !profile.environment ||
        !profile.locationHash ||
        facts.id !== command.payload.profileId ||
        !facts.creditPolicies.some((policy) => policy === creditPolicy)
      )
        return {
          outcome: 'blocked',
          reason: 'native-profile-unavailable',
          next: 'Use the supported installed client and native account location.',
        };
      const filePayload = 'targetPath' in command.payload ? command.payload : undefined;
      const billingAttestation = filePayload?.billingAttestation;
      const permissionMode = filePayload?.permissionMode;
      if ((facts.family !== 'openai') !== !!billingAttestation)
        throw Error('The subscription billing attestation is unavailable.');
      if (
        (facts.family === 'google') !== !!permissionMode ||
        (facts.family === 'google' &&
          (!permissionMode || !facts.permissionModes.includes(permissionMode)))
      )
        throw Error('The native permission mode is unavailable.');
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (task?.state !== 'draft' || this.draftEditGate(task))
        return { outcome: 'blocked', reason: 'task-not-preparable' };
      const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
      const files = committedFiles(this.projectPath(task.projectId) as string, source.base);
      const original = filePayload
        ? files.find((file) => file.path === filePayload.targetPath)
        : undefined;
      if (filePayload && !original) throw Error('Target is unavailable.');
      const scope = original
        ? { target: { path: original.path, baseHash: original.hash } }
        : {
            repository: this.repositoryScope(source.base, files),
            execution: NativeRepositoryExecutionSchema.parse(
              'execution' in facts ? facts.execution : null,
            ),
          };
      const policy = PolicySchema.parse(command.payload.policy);
      if (filePayload && 'handoffTargets' in filePayload && filePayload.handoffTargets) {
        if (command.payload.consent !== 'explicit')
          throw Error('A new manual recipient roster needs explicit consent.');
        manualTargets = this.nativeManualTargets(filePayload.handoffTargets);
        if (!manualTargets.some(({ target }) => target.profileId !== facts.id))
          throw Error('Choose a different manual recipient.');
        const reviewCycles = (policy.methods ?? []).reduce((sum, method) => sum + method.cycles, 0);
        if (
          (policy.methods ?? []).length !== 1 ||
          policy.methods?.[0].cycles !== 1 ||
          policy.limits.attempts < reviewCycles + 3 ||
          policy.unknownUsage.rule !== 'fixed-allowance' ||
          policy.unknownUsage.allowance.launches < 2 ||
          policy.unknownUsage.allowance.minutes < policy.limits.minutes
        )
          throw Error('The manual handoff policy lacks original allowance and review headroom.');
      }
      const runId = this.id('run');
      const project = this.store.get<Project>('project', task.projectId) as Project;
      const writeGrant = this.grant(
        { id: runId, taskId: task.id, policy: { policy, hash: hashCanonical(policy) } },
        'write-scratch',
        project.name,
      );
      if (!writeGrant) throw Error('The native proposal needs a live scratch grant.');
      const toolsGrant = !filePayload
        ? this.grant(
            { id: runId, taskId: task.id, policy: { policy, hash: hashCanonical(policy) } },
            'run-native-tools',
            project.name,
          )
        : undefined;
      if (!filePayload && !toolsGrant)
        throw Error('Repository work needs a live native-tool grant.');
      expiresAt = toolsGrant
        ? new Date(
            Math.min(Date.parse(writeGrant.expiresAt), Date.parse(toolsGrant.expiresAt)),
          ).toISOString()
        : writeGrant.expiresAt;
      const context = { title: task.title, outcome: task.outcome };
      const scopeHash = hashCanonical({
        profile: facts,
        client: profile.client,
        locationHash: profile.locationHash,
        projectId: task.projectId,
        source,
        ...(original ? { target: { path: original.path, hash: original.hash } } : scope),
        context,
        criteria: task.criteria,
        policy,
        creditPolicy: command.payload.creditPolicy,
        ...(billingAttestation ? { billingAttestation: billingAttestation } : {}),
        ...(permissionMode ? { permissionMode: permissionMode } : {}),
        ...(manualTargets ? { manualTargets } : {}),
      });
      if (command.payload.consent === 'saved')
        expiresAt = new Date(
          Math.min(Date.parse(expiresAt), Date.parse(this.consentRecord(scopeHash).expiresAt)),
        ).toISOString();
      const savedRoute = this.nativeProfileRoute(profile, command.payload.creditPolicy);
      const appointment = freezeNative(
        NativeAppointmentSchema.parse({
          id: command.key.replaceAll('_', '-'),
          taskId: task.id,
          route: manualTargets?.find(
            ({ target }) => target.profileId === facts.id && target.creditPolicy === creditPolicy,
          )?.route ??
            savedRoute ?? {
              id: this.id('rte'),
              family: facts.family,
              displayName: facts.displayName,
              model: facts.model,
              effort: {
                requested: facts.effort,
                effective: facts.family === 'openai' ? facts.effort : 'unknown',
                supported: [facts.effort],
              },
              billing: command.payload.creditPolicy === 'ordinary' ? 'included' : 'credits',
              qualified: false,
              fake: false,
            },
          client: profile.client,
          creditPolicy: command.payload.creditPolicy,
          ...(billingAttestation ? { billingAttestation: billingAttestation } : {}),
          ...(permissionMode ? { permissionMode: permissionMode } : {}),
          ...scope,
          consent: {
            nativeTrust: 'accepted',
            source: command.payload.consent === 'explicit' ? 'explicit' : 'policy',
            policyHash: hashCanonical(policy),
            sourceBase: source.base,
            criteriaHash: hashCanonical(task.criteria),
          },
          policy,
          expiresAt,
          maximumTaskMs: facts.maximumTaskMs,
          maximumSubmissions: facts.maximumSubmissions,
        }),
      );
      const publicScope = {
        profileId: facts.id,
        locationHash: profile.locationHash,
        scopeHash,
        ...(manualTargets ? { manualTargetsHash: hashCanonical(manualTargets) } : {}),
        context,
      };
      plan = this.planNativeAppointment(appointment, publicScope, runId);
      if (this.store.receipt(`native-consent:${scopeHash}`)) this.consentRecord(scopeHash);
    } catch {
      return {
        outcome: 'blocked',
        reason: 'native-preparation-unavailable',
        next: 'Review the target, native trust, source consent and policy bounds.',
      };
    }
    const binding = this.saveNativePlan(plan);
    if (manualTargets) {
      this.store.saveReceipt(
        `native-attempt-plan:${binding.attempt.id}`,
        hashCanonical(binding.appointment),
        'local-owner',
        { outcome: 'applied', entity: binding.planArtifact },
      );
      const roster = this.nativeArtifact(
        NativeManualRosterSchema.parse({
          runId: binding.run.id,
          targets: manualTargets,
        }),
      );
      this.store.saveReceipt(
        `native-handoff-roster:${binding.run.id}`,
        roster.hash,
        'local-owner',
        {
          outcome: 'applied',
          entity: roster,
        },
      );
    }
    const { scopeHash } = plan.public as z.infer<typeof NativePublicScopeSchema>;
    const task = this.store.get<Task>('task', command.payload.taskId) as Task;
    const publicScope = plan.public;
    if (
      command.payload.consent === 'explicit' &&
      !this.store.receipt(`native-consent:${scopeHash}`)
    ) {
      const artifact = this.nativeArtifact({ scopeHash, expiresAt });
      this.store.saveReceipt(`native-consent:${scopeHash}`, scopeHash, 'local-owner', {
        outcome: 'applied',
        entity: artifact,
      });
    }
    this.store.saveReceipt(
      `native-prepared:${binding.run.id}`,
      hashCanonical(publicScope),
      'local-owner',
      { outcome: 'applied', entity: binding.planArtifact },
    );
    const updated = this.updateTask(this.store.get<Task>('task', task.id) as Task, {
      next: 'Review the native preparation and start. Checks and acceptance remain pending.',
    });
    this.event('run.prepared', task.id, updated.revision, binding.run);
    return { outcome: 'applied', entity: binding.run, revision: updated.revision };
  }

  private evaluationOrigin(taskId: string, candidateId: string, ownedAttemptId?: string) {
    const task = this.store.get<Task>('task', taskId);
    const run = task?.runId ? this.store.get<Run>('run', task.runId) : undefined;
    const candidate = this.store.get<Candidate>('candidate', candidateId);
    if (
      !task ||
      !run ||
      !candidate ||
      candidate.taskId !== task.id ||
      this.latestCandidate(run.id)?.id !== candidate.id ||
      this.store
        .intents()
        .some(
          (intent) =>
            intent.task_id === task.id &&
            intent.state !== 'stopped' &&
            intent.attempt_id !== ownedAttemptId,
        )
    )
      throw Error('Evaluation needs the current stopped candidate.');
    const origin = this.store.receipt(this.currentNativePlanKey(run.id));
    const artifact = ArtifactSchema.parse(origin?.result.entity);
    if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Native origin exceeds its bound.');
    const plan = NativeHistoricalPreparationSchema.parse(
      JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
    );
    this.nativeManualHistory(plan);
    this.anthropicWriterEvidence(plan);
    this.googleWriterEvidence(plan);
    this.nativeRepositoryEvidence(plan, candidate);
    this.nativeAcpEvidence(plan, candidate);
    const writer = this.store.get<Attempt>('attempt', plan.attempt.id);
    const completionArtifact = ArtifactSchema.parse(
      this.store.receipt(`native-completion:${plan.attempt.id}`)?.result.entity,
    );
    if (completionArtifact.bytes > 4096) throw Error('Native completion exceeds its bound.');
    const completion = JSON.parse(this.artifacts.read(completionArtifact.hash).toString('utf8'));
    if (
      !writer ||
      !this.attestedReviewWriter(run, candidate, writer) ||
      completion.attemptId !== writer.id ||
      completion.reason !== null ||
      completion.quiescent !== true ||
      !this.store.nativePhasesComplete(writer.id, plan.appointment.route.family) ||
      this.store.receipt(
        `${'acp' in plan.appointment ? 'native-acp-capture' : 'repository' in plan.appointment ? 'native-capture' : 'native-application'}:${writer.id}`,
      )?.result.outcome !== 'applied' ||
      plan.run.id !== run.id ||
      plan.run.taskId !== run.taskId ||
      hashCanonical(plan.run.policy) !== hashCanonical(run.policy) ||
      hashCanonical(plan.run.source) !== hashCanonical(run.source) ||
      hashCanonical(plan.run.roles) !== hashCanonical(run.roles) ||
      plan.appointment.consent.criteriaHash !== hashCanonical(task.criteria) ||
      (plan.public &&
        (plan.public.context.title !== task.title ||
          plan.public.context.outcome !== task.outcome)) ||
      hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(run.source) ||
      this.evidence.hash(run.source.base, readFiles(this.writerScratch(run))) !== candidate.hash
    )
      throw Error('Evaluation origin or saved context changed.');
    return { task, run, writer, candidate, native: plan };
  }

  private evaluationInputs(command: Extract<Command, { command: 'PrepareCandidateEvaluation' }>) {
    const { task, run, writer, candidate } = this.evaluationOrigin(
      command.payload.taskId,
      command.payload.candidateId,
    );
    if (
      task.state !== 'stopped' ||
      this.store.receipt(`evaluation-started:${run.id}`) ||
      this.store.receipt(`paused:${run.id}`)
    )
      throw Error('Evaluation is unavailable.');
    const methods = run.policy.policy.methods ?? [];
    const selected = command.payload.reviewer;
    if (
      methods.length !== 1 ||
      methods[0].id !== selected.methodId ||
      methods[0].cycles !== selected.cycles ||
      !requiredReviewMethodIds(run.policy.policy.quality).every(
        (method) => method === selected.methodId,
      )
    )
      throw Error('The selected evaluation cannot cover the saved quality floor.');
    const profile = this.profileFor(selected.profileId);
    if (
      !profile.facts.available ||
      profile.facts.family !== 'openai' ||
      profile.facts.id !== 'openai-file-v1' ||
      profile.facts.id !== selected.profileId ||
      !profile.facts.creditPolicies.some((policy) => policy === command.payload.creditPolicy) ||
      !profile.client ||
      !profile.locationHash ||
      !profile.environment
    )
      throw Error('The reviewer profile is unavailable.');
    const remaining = this.remaining(run);
    if (
      remaining.attempts < 2 ||
      remaining.minutes < (command.payload.checkRecipeId === 'crewkite-verify-v1' ? 6 : 2) ||
      remaining.concurrency < 1
    )
      throw Error('The saved budget cannot cover one check and one review.');
    const expected = [
      command.payload.checkRecipeId === 'crewkite-verify-v1' ? verificationTarget : 'node --test',
      formatReviewTarget({ methodId: selected.methodId, cycle: 1 }),
    ];
    const grants = command.payload.grants;
    if (
      grants.some(
        (grant) =>
          grant.taskId !== task.id ||
          grant.revoked ||
          grant.usesRemaining !== 1 ||
          Date.parse(grant.expiresAt) <= Date.parse(this.now()) ||
          this.store.receipt(this.grantKey(grant)),
      ) ||
      grants.filter((grant) => grant.action === 'run-check' && grant.target === expected[0])
        .length !== 1 ||
      grants.filter((grant) => grant.action === 'run-review' && grant.target === expected[1])
        .length !== 1
    )
      throw Error('Exact check and review grants are required.');
    return {
      task,
      run,
      writer,
      candidate,
      methods,
      selected,
      profile,
      client: profile.client,
      locationHash: profile.locationHash,
      remaining,
      grants,
    };
  }
  private verificationLineage(input: ReturnType<Controller['evaluationInputs']>) {
    return hashCanonical({
      task: input.task,
      run: input.run,
      writer: input.writer,
      candidate: input.candidate,
      reviewer: {
        profile: input.profile.facts,
        client: input.client,
        locationHash: input.locationHash,
      },
    });
  }

  private prepareVerificationCommand(
    command: Extract<Command, { command: 'PrepareCandidateEvaluation' }>,
    principal: string,
  ): Promise<CommandResult> {
    const hash = hashCanonical(command);
    const prior = this.verificationPreparation;
    if (prior) {
      if (prior.key === command.key)
        return prior.hash === hash && prior.principal === principal
          ? prior.promise
          : Promise.resolve({ outcome: 'denied', reason: 'idempotency-key-reused' });
      return Promise.resolve({
        outcome: 'blocked',
        reason: 'verification-preparation-busy',
        next: 'Wait for the current verification preparation to finish.',
      });
    }
    const abort = new AbortController();
    const promise = Promise.resolve().then(async () => {
      let verification: PreparedVerification | undefined;
      let failure: CommandResult | undefined;
      const timer = setTimeout(() => abort.abort(), 60000);
      try {
        const inputs = this.evaluationInputs(command);
        const sourcePath = this.projectPath(inputs.task.projectId) as string;
        let provenancePattern = process.env.PROVENANCE_PATTERN?.trim();
        if (!provenancePattern)
          try {
            provenancePattern = readFileSync(
              join(runtimeRoot, 'internal/provenance-pattern.txt'),
              'utf8',
            ).trim();
          } catch {}
        if (!provenancePattern) {
          failure = {
            outcome: 'blocked',
            reason: 'verification-policy-unavailable',
            next: 'This source-configured recipe needs the installed trusted verification policy.',
          };
        } else {
          new RegExp(provenancePattern, 'i');
          const prepared = await (this.options.prepareVerification ?? prepareToolchain)({
            root: sourcePath,
            runtimeRoot,
            candidateId: inputs.candidate.id,
            candidateHash: inputs.candidate.hash,
            source: committedFiles(sourcePath, inputs.run.source.base),
            candidate: this.evidence.read(inputs.candidate).files,
            criteria: inputs.task.criteria,
            provenancePattern,
            git: '/usr/bin/git',
            budget: {
              deadline: performance.now() + 60000,
              now: () => performance.now(),
              maximumEntries: 500000,
              maximumBytes: 8 * 1024 * 1024 * 1024,
              signal: abort.signal,
            },
          });
          verification = { ...prepared, lineageHash: this.verificationLineage(inputs), sourcePath };
        }
      } catch {
        failure = {
          outcome: 'blocked',
          reason: 'verification-preparation-unavailable',
          next: 'Inspect the source-configured recipe, installed dependencies, local execution grants and remaining limits.',
        };
      } finally {
        clearTimeout(timer);
      }
      return this.commitCommand(command, principal, failure, verification);
    });
    const pending = {
      key: command.key,
      hash,
      principal,
      taskId: command.payload.taskId,
      abort,
      promise,
    };
    this.verificationPreparation = pending;
    void promise
      .finally(() => {
        if (this.verificationPreparation === pending) this.verificationPreparation = undefined;
      })
      .catch(() => {});
    return promise;
  }

  private prepareEvaluation(
    command: Extract<Command, { command: 'PrepareCandidateEvaluation' }>,
    verification?: PreparedVerification,
  ): CommandResult {
    let plan: z.infer<typeof CandidateEvaluationSchema>;
    let scopeHash: string;
    try {
      const inputs = this.evaluationInputs(command);
      const { task, run, writer, candidate, methods, selected, profile, remaining, grants } =
        inputs;
      if (command.payload.checkRecipeId === 'crewkite-verify-v1') {
        if (
          !verification ||
          verification.lineageHash !== this.verificationLineage(inputs) ||
          verification.sourcePath !== this.projectPath(task.projectId)
        )
          throw Error('Verification preflight lineage changed.');
        assertVerificationSource(
          verification.definition,
          committedFiles(verification.sourcePath, run.source.base),
          this.evidence.read(candidate).files,
          runtimeRoot,
        );
      }
      const definition =
        command.payload.checkRecipeId === 'crewkite-verify-v1'
          ? (verification as PreparedVerification).definition
          : this.evidence.describeChecks({
              candidate,
              sourceFiles: committedFiles(
                this.projectPath(task.projectId) as string,
                run.source.base,
              ),
              criteria: task.criteria,
              selection:
                command.payload.checkRecipeId === 'project-node-tests-v1'
                  ? {
                      recipeId: command.payload.checkRecipeId,
                      testFiles: command.payload.testFiles,
                    }
                  : undefined,
            });
      const fields = {
        run,
        writer,
        candidate,
        context: { title: task.title, outcome: task.outcome, criteria: task.criteria },
        definition,
        reviewer: {
          ...selected,
          role: methods[0].reviewerRole,
          profile: profile.facts,
          client: inputs.client,
          locationHash: inputs.locationHash,
        },
        creditPolicy: command.payload.creditPolicy,
        grants,
        remaining,
        maximumCheckMinutes:
          command.payload.checkRecipeId === 'crewkite-verify-v1' ? (5 as const) : (1 as const),
        ...(verification
          ? {
              verification: {
                source: verification.sourcePath,
                inventory: ArtifactSchema.parse({
                  id: this.id('art'),
                  hash: verification.definition.inventory.hash,
                  bytes: verification.definition.inventory.bytes,
                  mediaType: 'application/vnd.crewkite.toolchain+json',
                }),
              },
            }
          : {}),
      };
      scopeHash = hashCanonical(
        verification
          ? {
              ...fields,
              verification: {
                source: verification.sourcePath,
                inventory: {
                  hash: verification.definition.inventory.hash,
                  bytes: verification.definition.inventory.bytes,
                },
              },
            }
          : fields,
      );
      let expiresAt = grants
        .map((grant) => Date.parse(grant.expiresAt))
        .reduce((a, b) => Math.min(a, b));
      const saved = this.store.receipt(`evaluation-consent:${scopeHash}`);
      if (saved) {
        const artifact = ArtifactSchema.parse(saved.result.entity);
        if (artifact.bytes > 4096) throw Error('Evaluation consent exceeds its bound.');
        const consent = EvaluationConsentSchema.parse(
          JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
        );
        if (
          consent.scopeHash !== scopeHash ||
          Date.parse(consent.expiresAt) <= Date.parse(this.now())
        )
          throw Error('Evaluation consent expired.');
        expiresAt = Math.min(expiresAt, Date.parse(consent.expiresAt));
      } else if (command.payload.consent === 'saved')
        throw Error('Matching evaluation consent is unavailable.');
      plan = CandidateEvaluationSchema.parse({
        ...fields,
        scopeHash,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      if (Buffer.byteLength(canonicalJson(plan)) > MAX_FRAME_BYTES)
        throw Error('Evaluation preparation exceeds its bound.');
    } catch {
      return {
        outcome: 'blocked',
        reason: 'candidate-evaluation-unavailable',
        next: 'Review the stopped candidate, trusted check recipe, reviewer consent and remaining limits.',
      };
    }
    if (plan.verification && verification) {
      const content = this.artifacts.publish(verification.inventoryBytes);
      if (
        content.hash !== plan.verification.inventory.hash ||
        content.bytes !== plan.verification.inventory.bytes
      )
        throw Error('Verification inventory changed.');
      this.saveArtifacts([plan.verification.inventory]);
    }
    const artifact = this.nativeArtifact(plan);
    this.store.saveReceipt(`evaluation-plan:${artifact.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    if (!this.store.receipt(`evaluation-consent:${scopeHash}`)) {
      const consent = this.nativeArtifact({ scopeHash, expiresAt: plan.expiresAt });
      this.store.saveReceipt(`evaluation-consent:${scopeHash}`, scopeHash, 'local-owner', {
        outcome: 'applied',
        entity: consent,
      });
    }
    this.store.db
      .prepare('DELETE FROM receipts WHERE command_key=?')
      .run(`evaluation-ready:${plan.run.id}`);
    this.store.saveReceipt(`evaluation-ready:${plan.run.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    const task = this.updateTask(this.store.get<Task>('task', command.payload.taskId) as Task, {
      next: 'Review the frozen candidate evaluation and start its local checks. Native review requires a separate start.',
    });
    return { outcome: 'applied', entity: artifact, revision: task.revision };
  }

  private evaluationPlan(artifact: Artifact) {
    const stored = this.store.get<Artifact>('artifact', artifact.id);
    if (
      !stored ||
      hashCanonical(stored) !== hashCanonical(artifact) ||
      artifact.bytes > MAX_FRAME_BYTES ||
      this.store.receipt(`evaluation-plan:${artifact.id}`)?.hash !== artifact.hash
    )
      throw Error('Evaluation preparation is unavailable.');
    const bytes = this.artifacts.read(artifact.hash);
    if (bytes.length !== artifact.bytes) throw Error('Evaluation preparation size changed.');
    return CandidateEvaluationSchema.parse(JSON.parse(bytes.toString('utf8')));
  }

  private evaluationStartAvailability(
    artifact: Artifact,
    plan: z.infer<typeof CandidateEvaluationSchema>,
    review: boolean,
    check: CandidateEvaluationPreview['check'],
  ): CandidateEvaluationPreview['checkStart'] {
    const refused = (reason: CandidateEvaluationPreview['checkStart']['reason']) => ({
      available: false,
      reason,
    });
    const task = this.store.get<Task>('task', plan.run.taskId);
    const active = this.store
      .intents()
      .filter((intent) => intent.task_id === plan.run.taskId && intent.state !== 'stopped');
    if (
      task?.state === 'unknown' ||
      active.some((intent) => ['outcome-unknown', 'interrupted'].includes(intent.state))
    )
      return refused('ownership-unknown');
    const started = this.store.receipt(
      `${review ? 'native-review-started' : 'evaluation-started'}:${plan.run.id}`,
    );
    if (started) return refused('already-started');
    if (review && !check) return refused('checks-required');
    if (review && !check?.passed) return refused('checks-failed');
    if (this.store.receipt(`paused:${plan.run.id}`)) return refused('paused');
    if (task?.state !== 'stopped' || active.length) return refused('not-stopped');
    if (Date.parse(plan.expiresAt) <= Date.parse(this.now())) return refused('expired');
    try {
      const current = review
        ? this.candidateReviewAuthority(artifact)
        : this.evaluationAuthority(artifact);
      const remaining = this.remaining(plan.run);
      const required = review ? 1 : 2;
      if (
        remaining.attempts < required ||
        remaining.minutes < (review ? 1 : plan.maximumCheckMinutes + 1) ||
        remaining.concurrency < 1 ||
        (review && Date.parse(plan.expiresAt) - Date.parse(this.now()) <= 2000)
      )
        return refused('budget-exhausted');
      if (
        !review &&
        plan.grants.some(
          (grant) =>
            grant.revoked ||
            grant.usesRemaining !== 1 ||
            Date.parse(grant.expiresAt) <= Date.parse(this.now()) ||
            this.store.receipt(this.grantKey(grant)),
        )
      )
        return refused('grant-unavailable');
      if (review) {
        const route = this.candidateReviewRoute(
          this.profileFor(plan.reviewer.profileId),
          plan.creditPolicy,
          artifact.id,
        );
        const decision = this.nativeDecision(
          {
            ...current.native.appointment,
            route,
            maximumTaskMs: Math.min(300000, remaining.minutes * 60000),
            expiresAt: plan.expiresAt,
            creditPolicy: plan.creditPolicy,
          },
          plan.run,
          true,
        );
        if (!decision.chosen) return refused('preparation-changed');
      } else this.localCheckRoute(false);
      return { available: true, reason: 'available' };
    } catch (error) {
      const reason = CandidateEvaluationStartReasonSchema.safeParse(
        error instanceof Error ? error.message : undefined,
      );
      return refused(
        reason.success && reason.data !== 'available' ? reason.data : 'preparation-changed',
      );
    }
  }

  private candidateEvaluations(): CandidateEvaluationPreview[] {
    return this.store.list<Task>('task').flatMap((task) => {
      if (!task.runId) return [];
      const receipt =
        this.store.receipt(`evaluation-started:${task.runId}`) ??
        this.store.receipt(`evaluation-ready:${task.runId}`);
      if (!receipt) return [];
      try {
        const artifact = ArtifactSchema.parse(receipt.result.entity);
        const plan = this.evaluationPlan(artifact);
        if (
          plan.run.taskId !== task.id ||
          plan.run.id !== task.runId ||
          this.latestCandidate(plan.run.id)?.id !== plan.candidate.id
        )
          return [];
        const nativeArtifact = ArtifactSchema.parse(
          this.store.receipt(this.currentNativePlanKey(task.runId))?.result.entity,
        );
        if (nativeArtifact.bytes > MAX_FRAME_BYTES) return [];
        const native = NativeHistoricalPreparationSchema.parse(
          JSON.parse(this.artifacts.read(nativeArtifact.hash).toString('utf8')),
        );
        const appointment = native.appointment;
        const target =
          'target' in appointment
            ? this.evidence
                .read(plan.candidate)
                .files.find((file) => file.path === appointment.target.path)
            : undefined;
        if ('target' in appointment && !target) return [];
        const checkResult = this.store.receipt(`evaluation-result:${artifact.id}`);
        const checkArtifact =
          checkResult?.hash === artifact.hash
            ? ArtifactSchema.safeParse(checkResult.result.entity)
            : undefined;
        const check = checkArtifact?.success
          ? this.checks(plan.candidate).find(
              (value) =>
                value.artifactId === checkArtifact.data.id &&
                value.definitionHash === plan.definition.definitionHash &&
                value.evaluator === plan.definition.evaluator,
            )
          : undefined;
        const review = this.store.db
          .prepare(
            "SELECT body FROM evidence WHERE candidate_id=? AND candidate_hash=? AND kind='review'",
          )
          .all(plan.candidate.id, plan.candidate.hash)
          .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)))
          .find(
            (value) =>
              value.review &&
              !value.review.job.scripted &&
              value.review.job.preparationId === artifact.id &&
              value.review.job.runId === plan.run.id &&
              value.review.job.writerAttemptId === plan.writer.id &&
              value.review.job.writerRouteId === plan.writer.routeId,
          );
        const checking = this.store
          .intents()
          .some(
            (intent) =>
              intent.run_id === plan.run.id &&
              ['intent', 'acknowledged'].includes(intent.state) &&
              this.store.receipt(`evaluation-check:${intent.attempt_id}`)?.hash === artifact.hash,
          );
        const reviewing = this.store
          .intents()
          .some(
            (intent) =>
              intent.run_id === plan.run.id &&
              ['intent', 'acknowledged'].includes(intent.state) &&
              !!this.store.receipt(`native-review-input:${intent.attempt_id}`),
          );
        const uncertain =
          task.state === 'unknown' ||
          this.store
            .intents()
            .some(
              (intent) =>
                intent.run_id === plan.run.id &&
                ['outcome-unknown', 'interrupted'].includes(intent.state),
            );
        const checked = check ? { artifactId: check.artifactId, passed: check.passed } : null;
        return [
          CandidateEvaluationPreviewSchema.parse({
            taskId: task.id,
            runId: plan.run.id,
            candidateId: plan.candidate.id,
            candidateHash: plan.candidate.hash,
            preparationId: artifact.id,
            recipe: plan.definition.recipeId,
            ...(plan.definition.recipeId === 'crewkite-verify-v1'
              ? { verification: verificationPreview(plan.definition) }
              : {}),
            testFiles:
              plan.definition.recipeId === 'project-node-tests-v1'
                ? plan.definition.collection
                : [],
            definitionHash: plan.definition.definitionHash,
            ...('repository' in appointment
              ? { repository: appointment.repository }
              : {
                  target: {
                    path: target?.path,
                    baseHash: native.originalHash,
                    candidateContentHash: target?.hash,
                  },
                }),
            reviewer: {
              profileId: plan.reviewer.profileId,
              assignedRole: plan.reviewer.role,
              methodId: plan.reviewer.methodId,
              cycle: 1,
              independence: 'process-only',
            },
            creditPolicy: plan.creditPolicy,
            expiresAt: plan.expiresAt,
            remainingBudgets: this.remaining(plan.run),
            allowance: { source: 'supplemental-evaluation', localChecks: 1, nativeReviews: 1 },
            stage: review
              ? 'reviewed'
              : uncertain
                ? 'blocked'
                : reviewing
                  ? 'reviewing'
                  : checking
                    ? 'checking'
                    : check
                      ? check.passed
                        ? 'awaiting-review'
                        : 'check-failed'
                      : this.store.receipt(`evaluation-started:${plan.run.id}`)
                        ? 'blocked'
                        : 'prepared',
            check: checked,
            review: review
              ? { artifactId: review.artifactId, outcome: review.review?.outcome }
              : null,
            checkStart: this.evaluationStartAvailability(artifact, plan, false, checked),
            reviewStart: this.evaluationStartAvailability(artifact, plan, true, checked),
            localAcceptance: this.nativeAcceptanceAvailability(plan.run, plan.candidate),
          }),
        ];
      } catch {
        return [];
      }
    });
  }

  private localCheckRoute(create = true) {
    const priorRoute = this.store.receipt('node-check-route')?.result.entity;
    if (!priorRoute && !create) return undefined;
    const route = RouteSchema.parse(
      priorRoute
        ? JSON.parse(this.artifacts.read(ArtifactSchema.parse(priorRoute).hash).toString('utf8'))
        : {
            id: this.id('rte'),
            family: 'local',
            displayName: 'Local Node checks',
            model: process.version,
            effort: { requested: 'none', effective: 'none', supported: ['none'] },
            billing: 'local',
            qualified: false,
            fake: false,
          },
    );
    if (
      route.fake ||
      route.qualified ||
      route.family !== 'local' ||
      route.billing !== 'local' ||
      route.model !== process.version
    )
      throw Error('Local evaluator route changed.');
    if (
      priorRoute &&
      hashCanonical(this.store.get<Route>('route', route.id)) !== hashCanonical(route)
    )
      throw Error('Local evaluator catalog changed.');
    return route;
  }

  private startEvaluation(
    command: Extract<Command, { command: 'StartCandidateEvaluation' }>,
    effects: (() => void)[],
  ): CommandResult {
    let plan: z.infer<typeof CandidateEvaluationSchema>;
    let artifact: Artifact;
    let check: CheckPlan | undefined;
    let route: Route | undefined;
    let verification = false;
    try {
      artifact = ArtifactSchema.parse(
        this.store.get<Artifact>('artifact', command.payload.preparationId),
      );
      plan = this.evaluationPlan(artifact);
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (
        task?.runId !== plan.run.id ||
        plan.run.taskId !== task.id ||
        plan.candidate.id !== command.payload.candidateId
      )
        throw Error('Evaluation lineage changed.');
      const prior = this.store.receipt(`evaluation-started:${plan.run.id}`);
      if (prior)
        return prior.hash === artifact.hash
          ? { outcome: 'already-applied', entity: artifact, revision: task.revision }
          : { outcome: 'blocked', reason: 'candidate-evaluation-already-started' };
      const origin = this.evaluationAuthority(artifact);
      if (origin.task.state !== 'stopped') throw Error('not-stopped');
      const remaining = this.remaining(plan.run);
      if (
        remaining.attempts < 2 ||
        remaining.minutes < plan.maximumCheckMinutes + 1 ||
        remaining.concurrency < 1 ||
        plan.grants.some((grant) => this.store.receipt(this.grantKey(grant)))
      )
        throw Error('Evaluation authority or budget changed.');
      if (plan.definition.recipeId === 'crewkite-verify-v1') verification = true;
      else {
        check = this.evidence.prepareChecks({
          candidate: origin.candidate,
          sourceFiles: committedFiles(
            this.projectPath(origin.task.projectId) as string,
            plan.run.source.base,
          ),
          criteria: plan.context.criteria,
          expected: plan.definition,
        });
        const localRoute = this.localCheckRoute();
        if (!localRoute) throw Error('Local evaluator route is unavailable.');
        route = localRoute;
      }
    } catch {
      return {
        outcome: 'blocked',
        reason: 'candidate-evaluation-unavailable',
        next: 'Prepare the exact candidate evaluation again before running checks.',
      };
    }
    if (verification) return this.startVerification(artifact, plan, effects);
    if (!check || !route) throw Error('Local checks are unavailable.');
    if (!this.store.receipt('node-check-route')) {
      const routeArtifact = this.nativeArtifact(route);
      this.store.put('route', route.id, 0, route);
      this.store.saveReceipt('node-check-route', routeArtifact.hash, 'local-owner', {
        outcome: 'applied',
        entity: routeArtifact,
      });
    } else if (hashCanonical(this.store.get<Route>('route', route.id)) !== hashCanonical(route))
      throw Error('Local evaluator catalog changed.');
    const attempt = this.jobAttempt(plan.run, route.id);
    const minutes = this.admitJob(plan.run, attempt, check.directory, plan.maximumCheckMinutes);
    this.store.saveReceipt(`evaluation-started:${plan.run.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    this.store.saveReceipt(`evaluation-check:${attempt.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    this.consumeGrant(plan.run, plan.grants.find((grant) => grant.action === 'run-check') as Grant);
    this.updateTask(this.store.get<Task>('task', plan.run.taskId) as Task, {
      state: 'checking',
      waitingReason: null,
      next: 'Running the frozen Node checks. Native review waits for passing checks and a separate start.',
    });
    effects.push(() =>
      this.launchCheck(
        plan.run,
        attempt,
        plan.writer,
        plan.candidate,
        check,
        false,
        minutes,
        artifact,
      ),
    );
    return {
      outcome: 'applied',
      entity: artifact,
      revision: (this.store.get<Task>('task', plan.run.taskId) as Task).revision,
    };
  }

  private startVerification(
    artifact: Artifact,
    plan: z.infer<typeof CandidateEvaluationSchema>,
    effects: (() => void)[],
  ): CommandResult {
    if (plan.definition.recipeId !== 'crewkite-verify-v1' || !plan.verification)
      throw Error('Verification preparation changed.');
    const route = this.localCheckRoute();
    if (!route) throw Error('Local evaluator route is unavailable.');
    if (!this.store.receipt('node-check-route')) {
      const reference = this.nativeArtifact(route);
      this.store.put('route', route.id, 0, route);
      this.store.saveReceipt('node-check-route', reference.hash, 'local-owner', {
        outcome: 'applied',
        entity: reference,
      });
    }
    const attempt = this.jobAttempt(plan.run, route.id);
    const directory = join(this.home, 'verification', attempt.id);
    const stateRoot = join(realpathSync('/tmp'), `ck-${attempt.id}`);
    if (Buffer.byteLength(join(stateRoot, 'e2e-XXXXXX', 'control.sock')) > 100)
      throw Error('Verification state path is too long.');
    const owner: CheckOwner = {
      version: 1,
      attemptId: attempt.id,
      generation: attempt.generation,
      directory: join(stateRoot, 'ownership'),
      stateRoot,
      electronExecutable: join(directory, plan.definition.entrypoints.electron),
      stage: 'policy',
      parentGroup: 0,
    };
    const minutes = this.admitJob(plan.run, attempt, directory, 5);
    const launch = this.nativeArtifact({
      version: 1,
      runId: plan.run.id,
      candidateId: plan.candidate.id,
      candidateHash: plan.candidate.hash,
      definitionHash: plan.definition.definitionHash,
      preparation: artifact,
      directory,
      owner,
    });
    this.store.saveReceipt(`verification-launch:${attempt.id}`, launch.hash, 'local-owner', {
      outcome: 'applied',
      entity: launch,
    });
    for (const key of [`evaluation-started:${plan.run.id}`, `evaluation-check:${attempt.id}`])
      this.store.saveReceipt(key, artifact.hash, 'local-owner', {
        outcome: 'applied',
        entity: artifact,
      });
    this.consumeGrant(plan.run, plan.grants.find((grant) => grant.action === 'run-check') as Grant);
    const task = this.updateTask(this.store.get<Task>('task', plan.run.taskId) as Task, {
      state: 'checking',
      waitingReason: null,
      next: 'Running the frozen CrewKite verification stages. Review requires a separate start.',
    });
    effects.push(() => this.launchVerification(attempt, artifact, minutes));
    return { outcome: 'applied', entity: artifact, revision: task.revision };
  }

  private verificationLaunch(attemptId: string) {
    const record = this.nativeRecord(`verification-launch:${attemptId}`);
    const launch = z
      .strictObject({
        version: z.literal(1),
        runId: RunSchema.shape.id,
        candidateId: CandidateSchema.shape.id,
        candidateHash: HashSchema,
        definitionHash: HashSchema,
        preparation: ArtifactSchema,
        directory: z.string().min(1).max(4096),
        owner: z.custom<CheckOwner>((value) => {
          try {
            parseCheckOwner(value);
            return true;
          } catch {
            return false;
          }
        }),
      })
      .parse(record.value);
    const attempt = this.store.get<Attempt>('attempt', attemptId);
    const run = this.store.get<Run>('run', launch.runId);
    const intent = this.store.intents().find((value) => value.attempt_id === attemptId);
    const plan = this.evaluationPlan(launch.preparation);
    if (
      !attempt ||
      !run ||
      !intent ||
      attempt.runId !== run.id ||
      intent.run_id !== run.id ||
      intent.task_id !== run.taskId ||
      intent.route_id !== attempt.routeId ||
      intent.generation !== attempt.generation ||
      intent.scratch_path !== launch.directory ||
      launch.directory !== join(this.home, 'verification', attemptId) ||
      launch.owner.attemptId !== attemptId ||
      launch.owner.generation !== attempt.generation ||
      launch.owner.stage !== 'policy' ||
      launch.owner.parentGroup !== 0 ||
      launch.owner.directory !== join(launch.owner.stateRoot, 'ownership') ||
      plan.definition.recipeId !== 'crewkite-verify-v1' ||
      launch.owner.electronExecutable !==
        join(launch.directory, plan.definition.entrypoints.electron) ||
      plan.run.id !== run.id ||
      plan.candidate.id !== launch.candidateId ||
      plan.candidate.hash !== launch.candidateHash ||
      plan.definition.definitionHash !== launch.definitionHash ||
      this.store.receipt(`evaluation-check:${attemptId}`)?.hash !== launch.preparation.hash
    )
      throw Error('Verification launch binding changed.');
    return launch;
  }

  private verificationCurrent(attempt: Attempt, artifact: Artifact): boolean {
    try {
      if (this.closed || this.cancelledJobs.has(attempt.id)) return false;
      const origin = this.evaluationAuthority(artifact, attempt.id);
      const launch = this.verificationLaunch(attempt.id);
      const lease = this.store.db
        .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
        .get(origin.task.id);
      const current = this.store.get<Attempt>('attempt', attempt.id);
      const grant = origin.plan.grants.find(
        (value) => value.action === 'run-check' && value.target === verificationTarget,
      );
      const used = grant && this.store.receipt(this.grantKey(grant));
      return (
        origin.task.state === 'checking' &&
        launch.preparation.hash === artifact.hash &&
        !!current &&
        ['intent', 'running'].includes(current.state) &&
        current.runId === attempt.runId &&
        current.generation === attempt.generation &&
        lease?.attempt_id === attempt.id &&
        lease.generation === attempt.generation &&
        !!grant &&
        !grant.revoked &&
        Date.parse(grant.expiresAt) > Date.parse(this.now()) &&
        used?.hash === hashCanonical(grant) &&
        (used.result.entity as Run | undefined)?.id === origin.run.id &&
        this.jobDeadline(attempt.id, 5) > 0
      );
    } catch {
      return false;
    }
  }

  private launchVerification(attempt: Attempt, artifact: Artifact, minutes: number) {
    if (this.closed || this.store.get<Attempt>('attempt', attempt.id)?.state !== 'intent') return;
    let job: ToolchainVerification;
    try {
      const plan = this.evaluationPlan(artifact);
      const launch = this.verificationLaunch(attempt.id);
      if (
        plan.definition.recipeId !== 'crewkite-verify-v1' ||
        !plan.verification ||
        !this.verificationCurrent(attempt, artifact)
      )
        throw Error('Verification authority changed.');
      const definition = plan.definition;
      const bytes = this.artifacts.read(plan.verification.inventory.hash);
      if (bytes.length !== plan.definition.inventory.bytes)
        throw Error('Verification inventory changed.');
      const inventory = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as DependencyInventory;
      if (inventory.hash !== plan.definition.toolchainHash)
        throw Error('Verification inventory changed.');
      const remaining = Math.min(
        this.jobDeadline(attempt.id, minutes),
        Date.parse(plan.expiresAt) - Date.parse(this.now()),
      );
      job = new ToolchainVerification({
        definition: plan.definition,
        inventory,
        donor: plan.verification.source,
        directory: launch.directory,
        stateRoot: launch.owner.stateRoot,
        owner: launch.owner,
        files: this.evidence.read(plan.candidate).files,
        deadline: performance.now() + remaining,
        now: () => performance.now(),
        current: () => this.verificationCurrent(attempt, artifact),
        onSpawn: (pid) => this.acknowledgeJob(attempt, pid),
      });
      this.jobs.set(attempt.id, job);
      void job.result
        .then((execution) => {
          const authorized = this.verificationCurrent(attempt, artifact);
          if (!this.settleJob(attempt, execution.quiescent, true)) return;
          if (this.closed) return;
          if (this.cancelledJobs.has(attempt.id)) {
            this.stoppedJob(attempt);
            return;
          }
          if (!authorized) execution = { ...execution, failure: 'cancelled' };
          const result = this.evidence.recordVerification({
            candidate: plan.candidate,
            definition,
            execution,
            owner: launch.owner,
          });
          this.store.transaction(() => {
            this.saveArtifacts(result.artifacts);
            const check = result.evidence;
            this.store.db
              .prepare(
                "INSERT OR REPLACE INTO evidence(candidate_id,kind,candidate_hash,definition_hash,evaluator,body) VALUES (?,'check',?,?,?,?)",
              )
              .run(
                plan.candidate.id,
                plan.candidate.hash,
                check.definitionHash,
                check.evaluator,
                canonicalJson(check),
              );
            this.store.saveReceipt(
              `evaluation-result:${artifact.id}`,
              artifact.hash,
              'local-owner',
              {
                outcome: 'applied',
                entity: result.artifacts.find((value) => value.id === check.artifactId),
              },
            );
            const task = this.store.get<Task>('task', plan.run.taskId) as Task;
            this.event('check.completed', task.id, task.revision, check);
            this.updateTask(task, {
              state: check.passed ? 'stopped' : 'failed',
              waitingReason: null,
              next: check.passed
                ? 'Local verification passed. Inspect the evidence before starting the prepared review.'
                : 'Verification failed or was incomplete. Inspect the retained evidence.',
            });
          });
        })
        .catch(() => {
          if (!this.closed)
            this.store.transaction(() => {
              const task = this.store.get<Task>('task', plan.run.taskId) as Task;
              if (task.state !== 'unknown')
                this.updateTask(task, {
                  state: 'failed',
                  waitingReason: null,
                  next: 'Verification evidence could not be verified.',
                });
            });
        });
    } catch {
      this.settleJob(attempt, true);
      this.stoppedJob(attempt);
    }
  }

  private currentEvaluationDefinition(
    plan: z.infer<typeof CandidateEvaluationSchema>,
  ): CheckDefinition {
    const sourceFiles = committedFiles(
      this.projectPath(plan.run.source.projectId) as string,
      plan.run.source.base,
    );
    if (plan.definition.recipeId === 'crewkite-verify-v1') {
      if (
        !plan.verification ||
        plan.verification.source !== this.projectPath(plan.run.source.projectId)
      )
        throw Error('preparation-changed');
      const stored = this.store.get<Artifact>('artifact', plan.verification.inventory.id);
      if (!stored || hashCanonical(stored) !== hashCanonical(plan.verification.inventory))
        throw Error('preparation-changed');
      assertVerificationSource(
        plan.definition,
        sourceFiles,
        this.evidence.read(plan.candidate).files,
        runtimeRoot,
      );
      return plan.definition;
    }
    return this.evidence.describeChecks({
      candidate: plan.candidate,
      sourceFiles,
      criteria: plan.context.criteria,
      selection:
        plan.definition.recipeId === 'project-node-tests-v1'
          ? { recipeId: plan.definition.recipeId, testFiles: plan.definition.required.files }
          : undefined,
    });
  }

  private evaluationAuthority(artifact: Artifact, ownedAttemptId?: string) {
    const plan = this.evaluationPlan(artifact);
    const origin = this.evaluationOrigin(plan.run.taskId, plan.candidate.id, ownedAttemptId);
    if (
      hashCanonical(origin.run) !== hashCanonical(plan.run) ||
      hashCanonical(origin.writer) !== hashCanonical(plan.writer) ||
      hashCanonical(origin.candidate) !== hashCanonical(plan.candidate) ||
      hashCanonical({
        title: origin.task.title,
        outcome: origin.task.outcome,
        criteria: origin.task.criteria,
      }) !== hashCanonical(plan.context) ||
      this.store.receipt(`evaluation-ready:${plan.run.id}`)?.hash !== artifact.hash ||
      this.store.receipt(`paused:${plan.run.id}`)
    )
      throw Error('preparation-changed');
    if (Date.parse(plan.expiresAt) <= Date.parse(this.now())) throw Error('expired');
    const savedConsent = this.store.receipt(`evaluation-consent:${plan.scopeHash}`);
    if (!savedConsent) throw Error('consent-unavailable');
    const consentArtifact = ArtifactSchema.parse(savedConsent.result.entity);
    if (consentArtifact.bytes > 4096) throw Error('consent-unavailable');
    const consent = EvaluationConsentSchema.parse(
      JSON.parse(this.artifacts.read(consentArtifact.hash).toString('utf8')),
    );
    if (
      consent.scopeHash !== plan.scopeHash ||
      Date.parse(consent.expiresAt) <= Date.parse(this.now())
    )
      throw Error('consent-unavailable');
    const profile = this.profileFor(plan.reviewer.profileId);
    if (
      profile.facts.family !== 'openai' ||
      profile.facts.id !== 'openai-file-v1' ||
      hashCanonical(profile.facts) !== hashCanonical(plan.reviewer.profile) ||
      hashCanonical(profile.client) !== hashCanonical(plan.reviewer.client) ||
      profile.locationHash !== plan.reviewer.locationHash ||
      !profile.environment ||
      !profile.facts.creditPolicies.some((policy) => policy === plan.creditPolicy)
    )
      throw Error('profile-unavailable');
    if (
      plan.definition.recipeId === 'crewkite-verify-v1' &&
      !this.store.receipt(`evaluation-started:${plan.run.id}`)
    ) {
      const remaining = this.remaining(plan.run);
      if (remaining.attempts < 2 || remaining.minutes < 6 || remaining.concurrency < 1)
        throw Error('budget-exhausted');
    }
    const definition = this.currentEvaluationDefinition(plan);
    if (hashCanonical(definition) !== hashCanonical(plan.definition))
      throw Error('preparation-changed');
    return { ...origin, plan, definition, environment: { ...profile.environment } };
  }

  private nativeRecord(
    key: string,
    maximum = MAX_FRAME_BYTES,
    outcome: CommandResult['outcome'] = 'applied',
  ) {
    const receipt = this.store.receipt(key);
    if (receipt?.result.outcome !== outcome) throw Error('evidence-incomplete');
    const artifact = ArtifactSchema.parse(receipt.result.entity);
    if (
      artifact.bytes > maximum ||
      hashCanonical(this.store.get<Artifact>('artifact', artifact.id)) !== hashCanonical(artifact)
    )
      throw Error('evidence-incomplete');
    const content = this.artifacts.read(artifact.hash);
    if (content.length !== artifact.bytes) throw Error('evidence-incomplete');
    return { artifact, value: JSON.parse(content.toString('utf8')) as unknown };
  }

  private anthropicWriterEvidence(
    plan: Omit<z.infer<typeof NativePreparationSchema>, 'public'> & {
      public?: z.infer<typeof NativePublicScopeSchema>;
    },
  ) {
    if ('repository' in plan.appointment) return;
    if (plan.appointment.route.family !== 'anthropic') return;
    const auth = this.nativeRecord(`native-auth:${plan.attempt.id}`, 4096);
    const observed = z
      .object({
        attemptId: z.string(),
        clientHash: HashSchema,
        billingAttestationHash: HashSchema,
        metadata: z.unknown().refine(subscriptionAuth),
        reason: z.null(),
        quiescent: z.literal(true),
        exitCode: z.literal(0),
        signal: z.null(),
      })
      .parse(auth.value);
    const proposal = this.nativeRecord(`native-proposal:${plan.attempt.id}`);
    const output = z
      .object({
        family: z.literal('anthropic'),
        sessionId: z.uuid(),
        model: z.string(),
        requestedEffort: z.literal('medium'),
        effectiveEffort: z.literal('unknown'),
        authHash: HashSchema,
        billingAttestation: NativeBillingAttestationSchema,
        qualified: z.literal(false),
        replacement: z.object({
          attemptId: z.string(),
          path: ReplacementPathSchema,
          baseHash: HashSchema,
        }),
      })
      .parse(proposal.value);
    const applied = this.nativeRecord(`native-application:${plan.attempt.id}`);
    const application = z
      .object({ attemptId: z.string(), proposalHash: HashSchema })
      .parse(applied.value);
    if (
      !plan.anthropicSessionId ||
      !plan.appointment.billingAttestation ||
      plan.appointment.creditPolicy !== 'ordinary' ||
      observed.attemptId !== plan.attempt.id ||
      observed.clientHash !== plan.appointment.client.sha256 ||
      observed.billingAttestationHash !== hashCanonical(plan.appointment.billingAttestation) ||
      output.sessionId !== plan.anthropicSessionId ||
      output.model !== plan.appointment.route.model ||
      output.authHash !== auth.artifact.hash ||
      hashCanonical(output.billingAttestation) !==
        hashCanonical(plan.appointment.billingAttestation) ||
      output.replacement.attemptId !== plan.attempt.id ||
      output.replacement.path !== plan.appointment.target.path ||
      output.replacement.baseHash !== plan.appointment.target.baseHash ||
      application.attemptId !== plan.attempt.id ||
      application.proposalHash !== hashCanonical(proposal.value)
    )
      throw Error('evidence-incomplete');
  }

  private googleWriterEvidence(
    plan: Omit<z.infer<typeof NativePreparationSchema>, 'public'> & {
      public?: z.infer<typeof NativePublicScopeSchema>;
    },
  ) {
    if ('repository' in plan.appointment) return;
    if ('acp' in plan.appointment || plan.appointment.route.family !== 'google') return;
    const config = this.nativeRecord(`native-config:${plan.attempt.id}`, 4096);
    const observed = z
      .object({
        attemptId: z.string(),
        clientHash: HashSchema,
        locationHash: HashSchema,
        billingAttestationHash: HashSchema,
        metadata: z.object({
          permissionMode: GoogleNativePermissionModeSchema,
          creditFallback: z.literal('disabled'),
          account: z.literal('unknown'),
          billing: z.literal('unknown'),
          observedTurns: z.literal(0),
        }),
        reason: z.null(),
        quiescent: z.literal(true),
        exitCode: z.literal(0),
        signal: z.null(),
      })
      .parse(config.value);
    const proposal = this.nativeRecord(`native-proposal:${plan.attempt.id}`);
    const output = z
      .object({
        family: z.literal('google'),
        conversationId: z.string().min(1).max(200),
        model: z.string(),
        requestedEffort: z.literal('low'),
        effectiveEffort: z.literal('unknown'),
        permissionMode: GoogleNativePermissionModeSchema,
        configHash: HashSchema,
        billingAttestation: NativeBillingAttestationSchema,
        qualified: z.literal(false),
        replacement: z.object({
          attemptId: z.string(),
          path: ReplacementPathSchema,
          baseHash: HashSchema,
        }),
      })
      .parse(proposal.value);
    const applied = this.nativeRecord(`native-application:${plan.attempt.id}`);
    const application = z
      .object({ attemptId: z.string(), proposalHash: HashSchema })
      .parse(applied.value);
    if (
      !plan.public ||
      !plan.appointment.billingAttestation ||
      !plan.appointment.permissionMode ||
      plan.appointment.creditPolicy !== 'ordinary' ||
      observed.attemptId !== plan.attempt.id ||
      observed.clientHash !== plan.appointment.client.sha256 ||
      observed.locationHash !== plan.public.locationHash ||
      observed.billingAttestationHash !== hashCanonical(plan.appointment.billingAttestation) ||
      observed.metadata.permissionMode !== plan.appointment.permissionMode ||
      output.permissionMode !== plan.appointment.permissionMode ||
      output.model !== plan.appointment.route.model ||
      output.configHash !== config.artifact.hash ||
      hashCanonical(output.billingAttestation) !==
        hashCanonical(plan.appointment.billingAttestation) ||
      output.replacement.attemptId !== plan.attempt.id ||
      output.replacement.path !== plan.appointment.target.path ||
      output.replacement.baseHash !== plan.appointment.target.baseHash ||
      application.attemptId !== plan.attempt.id ||
      application.proposalHash !== hashCanonical(proposal.value)
    )
      throw Error('evidence-incomplete');
  }

  private repositoryResult(appointment: NativePilotAppointment, attemptId: string, value: unknown) {
    if (!('repository' in appointment)) throw Error('The repository appointment is unavailable.');
    const result = z
      .object({
        attemptId: z.string(),
        sourceBase: z.string(),
        manifestHash: HashSchema,
        execution: NativeRepositoryExecutionSchema,
        model: z.string(),
        requestedEffort: z.literal('low'),
        qualified: z.literal(false),
        threadId: z.string().min(1).max(200),
        turnId: z.string().min(1).max(200),
      })
      .parse(value);
    if (
      result.attemptId !== attemptId ||
      result.sourceBase !== appointment.repository.sourceBase ||
      result.manifestHash !== appointment.repository.manifestHash ||
      hashCanonical(result.execution) !== hashCanonical(appointment.execution) ||
      result.model !== appointment.route.model ||
      result.requestedEffort !== appointment.route.effort.requested
    )
      throw Error('The repository result binding changed.');
    return result;
  }

  private nativeAcpEvidence(
    plan: z.infer<typeof NativeHistoricalPreparationSchema>,
    candidate: Candidate,
  ) {
    const appointment = plan.appointment;
    if (!('acp' in appointment)) return;
    const capture = z
      .strictObject({
        version: z.literal(1),
        attemptId: AttemptSchema.shape.id,
        planHash: HashSchema,
        completionHash: HashSchema,
        metadataHash: HashSchema,
        candidateId: CandidateSchema.shape.id,
        candidateHash: HashSchema,
        target: z.strictObject({
          path: ReplacementPathSchema,
          baseHash: HashSchema,
          hash: HashSchema,
          bytes: z.number().int().nonnegative().max(65536),
          mode: z.enum(['100644', '100755']),
        }),
      })
      .parse(this.nativeRecord(`native-acp-capture:${plan.attempt.id}`).value);
    const metadata = this.nativeRecord(`native-proposal:${plan.attempt.id}`);
    const output = z
      .strictObject({
        sessionId: AcpApprovalTargetSchema.shape.sessionId,
        stopReason: z.literal('end_turn'),
        submitted: z.literal(true),
        selectionHash: HashSchema,
        reviewModeHash: HashSchema,
      })
      .parse(metadata.value);
    const proof = this.store.get<Artifact>('artifact', appointment.acp.proofId);
    const target = this.evidence
      .read(candidate)
      .files.find((file) => file.path === appointment.target.path);
    if (
      proof?.hash !== appointment.proofHash ||
      hashCanonical(this.acpProof(appointment.acp.proofId)) !== hashCanonical(appointment.proof) ||
      !appointment.proof.reviewMode ||
      this.store.nativeProfileId(plan.attempt.id) !== 'google-acp-v1' ||
      !this.store.nativePhasesComplete(plan.attempt.id, 'google') ||
      capture.attemptId !== plan.attempt.id ||
      capture.planHash !==
        this.nativeRecord(this.currentNativePlanKey(plan.run.id)).artifact.hash ||
      capture.completionHash !==
        this.nativeRecord(`native-completion:${plan.attempt.id}`, 4096).artifact.hash ||
      capture.metadataHash !== metadata.artifact.hash ||
      capture.candidateId !== candidate.id ||
      capture.candidateHash !== candidate.hash ||
      capture.target.path !== appointment.target.path ||
      capture.target.baseHash !== appointment.target.baseHash ||
      capture.target.mode !== appointment.target.mode ||
      !target ||
      target.hash !== capture.target.hash ||
      target.bytes !== capture.target.bytes ||
      output.selectionHash !== hashCanonical(appointment.acp) ||
      output.reviewModeHash !== hashCanonical(appointment.proof.reviewMode)
    )
      throw Error('ACP capture evidence is incomplete.');
  }

  private nativeRepositoryEvidence(
    plan: z.infer<typeof NativeHistoricalPreparationSchema>,
    candidate: Candidate,
  ) {
    const appointment = plan.appointment;
    if (!('repository' in appointment)) return;
    const capture = z
      .strictObject({
        version: z.literal(1),
        attemptId: z.string(),
        planHash: HashSchema,
        completionHash: HashSchema,
        metadataHash: HashSchema,
        candidateId: CandidateSchema.shape.id,
        candidateHash: HashSchema,
        repository: NativeRepositoryScopeSchema,
        execution: NativeRepositoryExecutionSchema,
      })
      .parse(this.nativeRecord(`native-capture:${plan.attempt.id}`).value);
    const metadata = this.nativeRecord(`native-proposal:${plan.attempt.id}`);
    this.repositoryResult(appointment, plan.attempt.id, metadata.value);
    if (
      capture.attemptId !== plan.attempt.id ||
      capture.planHash !== this.nativeRecord(`native-run:${plan.run.id}`).artifact.hash ||
      capture.completionHash !==
        this.nativeRecord(`native-completion:${plan.attempt.id}`, 4096).artifact.hash ||
      capture.metadataHash !== metadata.artifact.hash ||
      capture.candidateId !== candidate.id ||
      capture.candidateHash !== candidate.hash ||
      hashCanonical(capture.repository) !== hashCanonical(appointment.repository) ||
      hashCanonical(capture.execution) !== hashCanonical(appointment.execution) ||
      hashCanonical(this.repositoryScope(plan.run.source.base, plan.manifest)) !==
        hashCanonical(appointment.repository)
    )
      throw Error('Repository capture evidence changed.');
    const project = this.store.get<Project>('project', plan.run.source.projectId);
    for (const action of ['write-scratch', 'run-native-tools'] as const) {
      const grant = plan.run.policy.policy.effects.find(
        (value) =>
          value.taskId === plan.run.taskId &&
          value.action === action &&
          value.target === project?.name &&
          !value.revoked &&
          value.usesRemaining === 1,
      );
      const consumed = grant && this.store.receipt(this.grantKey(grant));
      if (
        !grant ||
        consumed?.hash !== hashCanonical(grant) ||
        (consumed.result.entity as Run | undefined)?.id !== plan.run.id
      )
        throw Error('The repository grant was not consumed for this run.');
    }
  }

  private nativeReviewSource(
    plan: z.infer<typeof NativeHistoricalPreparationSchema>,
    candidate: Candidate,
  ) {
    const source = committedFiles(
      this.projectPath(plan.run.source.projectId) as string,
      plan.run.source.base,
    );
    const files = this.evidence.read(candidate).files;
    const appointment = plan.appointment;
    if ('repository' in appointment) {
      if (
        hashCanonical(this.repositoryScope(plan.run.source.base, source)) !==
        hashCanonical(appointment.repository)
      )
        throw Error('The review source changed.');
      const original = new Map(source.map((file) => [file.path, file]));
      const current = new Map(files.map((file) => [file.path, file]));
      const side = (file: (typeof files)[number] | undefined) =>
        file
          ? {
              mode: file.mode,
              hash: file.hash,
              content: new TextDecoder('utf-8', { fatal: true }).decode(file.content),
            }
          : null;
      const changes = [...new Set([...original.keys(), ...current.keys()])]
        .sort()
        .filter((path) => {
          const left = original.get(path),
            right = current.get(path);
          return !left || !right || left.hash !== right.hash || left.mode !== right.mode;
        })
        .map((path) => ({
          path,
          original: side(original.get(path)),
          candidate: side(current.get(path)),
        }));
      if (!changes.length) throw Error('The repository candidate has no changes.');
      return {
        repository: {
          version: 1 as const,
          sourceBase: plan.run.source.base,
          sourceManifestHash: appointment.repository.manifestHash,
          candidateManifestHash: candidate.hash,
          changes,
        },
      };
    }
    const first = plan.handoff
      ? NativeHistoricalPreparationSchema.parse(
          this.nativeRecord(`native-run:${plan.run.id}`).value,
        )
      : plan;
    const original = source.find((file) => file.path === appointment.target.path);
    const current = files.find((file) => file.path === appointment.target.path);
    if (
      !original ||
      !current ||
      original.hash !== first.originalHash ||
      !('target' in first.appointment) ||
      original.hash !== first.appointment.target.baseHash ||
      current.mode !== original.mode ||
      hashCanonical(
        files
          .filter((file) => file.path !== current.path)
          .map(({ content: _content, ...entry }) => entry),
      ) !== hashCanonical(plan.manifest.filter((file) => file.path !== current.path))
    )
      throw Error('The review target changed.');
    return {
      path: original.path,
      baseHash: original.hash,
      original: new TextDecoder('utf-8', { fatal: true }).decode(original.content),
      candidate: new TextDecoder('utf-8', { fatal: true }).decode(current.content),
      candidateContentHash: current.hash,
    };
  }

  private nativePublicationEvidence(run: Run, candidate: Candidate) {
    const same = (left: unknown, right: unknown) => hashCanonical(left) === hashCanonical(right);
    const origin = this.nativeRecord(this.currentNativePlanKey(run.id));
    const native = NativeHistoricalPreparationSchema.parse(origin.value);
    this.nativeManualHistory(native);
    this.anthropicWriterEvidence(native);
    this.googleWriterEvidence(native);
    this.nativeRepositoryEvidence(native, candidate);
    this.nativeAcpEvidence(native, candidate);
    const prepared = ArtifactSchema.parse(
      this.store.receipt(`evaluation-started:${run.id}`)?.result.entity,
    );
    const evaluation = this.evaluationPlan(prepared);
    const record = this.nativeRecord(`native-review-started:${run.id}`);
    const saved = z
      .strictObject({
        preparation: ArtifactSchema,
        job: NativeReviewJobSchema,
        input: z.unknown(),
        check: ArtifactSchema,
        identity: z.strictObject({
          evaluator: z.string().min(1).max(200),
          definitionHash: HashSchema,
        }),
        allowance: z.strictObject({
          source: z.literal('supplemental-evaluation'),
          maximumSubmissions: z.literal(1),
          grantHash: HashSchema,
          maximumTaskMs: z.number().int().min(60000).max(300000),
          originalPolicyHash: HashSchema,
        }),
      })
      .parse(record.value);
    const { job } = saved;
    const input = reviewPlan(saved.input as Parameters<typeof reviewPlan>[0]);
    const writer = this.store.get<Attempt>('attempt', native.attempt.id);
    const attempt = this.store.get<Attempt>('attempt', job.attemptId);
    const storedJob = this.store.db
      .prepare('SELECT body FROM review_jobs WHERE attempt_id=?')
      .get(job.attemptId);
    const grant = evaluation.grants.find((value) => value.action === 'run-review');
    const methods = run.policy.policy.methods ?? [];
    const reviewSource = this.nativeReviewSource(native, candidate);
    const submission = z
      .strictObject({ attemptId: z.string(), preparationHash: HashSchema, bindingHash: HashSchema })
      .parse(
        this.nativeRecord(`native-review-submission:${job.attemptId}`, 4096, 'outcome-unknown')
          .value,
      );
    const submittedWriter = z
      .strictObject({ attemptId: z.string(), plan: HashSchema })
      .parse(
        this.nativeRecord(`native-submission:${native.attempt.id}`, 4096, 'outcome-unknown').value,
      );
    if (
      !writer ||
      !attempt ||
      !storedJob ||
      !grant ||
      !this.attestedReviewWriter(run, candidate, writer) ||
      !same(evaluation.run, run) ||
      !same(evaluation.writer, writer) ||
      !same(evaluation.candidate, candidate) ||
      native.run.id !== run.id ||
      !same(native.run.policy, run.policy) ||
      !same(native.run.source, run.source) ||
      !same(native.run.roles, run.roles) ||
      this.store.receipt(this.currentNativePlanKey(run.id))?.hash !==
        hashCanonical(native.appointment) ||
      this.store.receipt(
        `${'acp' in native.appointment ? 'native-acp-capture' : 'repository' in native.appointment ? 'native-capture' : 'native-application'}:${writer.id}`,
      )?.result.outcome !== 'applied' ||
      native.appointment.consent.criteriaHash !== hashCanonical(evaluation.context.criteria) ||
      (native.public &&
        !same(native.public.context, {
          title: evaluation.context.title,
          outcome: evaluation.context.outcome,
        })) ||
      !same(saved.preparation, prepared) ||
      this.store.receipt(`native-review-started:${run.id}`)?.hash !== prepared.hash ||
      this.store.receipt(`native-review-input:${job.attemptId}`)?.hash !== record.artifact.hash ||
      this.store.receipt(`native-review-input:${job.attemptId}`)?.result.outcome !== 'applied' ||
      submittedWriter.attemptId !== writer.id ||
      submittedWriter.plan !== origin.artifact.hash ||
      submission.attemptId !== job.attemptId ||
      submission.preparationHash !== prepared.hash ||
      submission.bindingHash !== hashCanonical(input.binding) ||
      this.store.receipt(`native-review-submission:${job.attemptId}`)?.hash !== prepared.hash ||
      this.store.receipt(`evaluation-result:${prepared.id}`)?.hash !== prepared.hash ||
      !same(this.store.receipt(`evaluation-result:${prepared.id}`)?.result.entity, saved.check) ||
      !same(JSON.parse(storedJob.body as string), job) ||
      job.taskId !== run.taskId ||
      job.runId !== run.id ||
      job.writerAttemptId !== writer.id ||
      job.writerRouteId !== writer.routeId ||
      job.candidateId !== candidate.id ||
      job.candidateHash !== candidate.hash ||
      job.preparationId !== prepared.id ||
      job.profileId !== evaluation.reviewer.profileId ||
      job.assignedRole !== evaluation.reviewer.role ||
      attempt.runId !== run.id ||
      attempt.routeId !== job.routeId ||
      attempt.generation !== job.generation ||
      attempt.state !== 'stopped' ||
      methods.length !== 1 ||
      methods[0].id !== job.methodId ||
      methods[0].cycles !== job.cycle ||
      methods[0].reviewerRole !== job.assignedRole ||
      !requiredReviewMethodIds(run.policy.policy.quality).every((id) => id === job.methodId) ||
      evaluation.reviewer.methodId !== job.methodId ||
      evaluation.reviewer.cycles !== job.cycle ||
      !same(input.binding, { ...job, scopeHash: evaluation.scopeHash }) ||
      !same(input.context, evaluation.context) ||
      input.creditPolicy !== evaluation.creditPolicy ||
      !same(
        reviewSource,
        'repository' in input
          ? { repository: input.repository }
          : {
              path: input.path,
              baseHash: input.baseHash,
              original: input.original,
              candidate: input.candidate,
              candidateContentHash: input.candidateContentHash,
            },
      ) ||
      input.model !== evaluation.reviewer.profile.model ||
      evaluation.reviewer.profile.family !== 'openai' ||
      input.effort !== evaluation.reviewer.profile.effort ||
      saved.allowance.originalPolicyHash !== run.policy.hash ||
      saved.allowance.maximumTaskMs !== job.limitMinutes * 60000 ||
      saved.allowance.grantHash !== hashCanonical(grant) ||
      this.store.receipt(this.grantKey(grant))?.hash !== saved.allowance.grantHash ||
      !this.checks(candidate).some(
        (check) =>
          check.artifactId === saved.check.id &&
          this.checkMatches(check, candidate, evaluation.definition),
      )
    )
      throw Error('evidence-incomplete');
    for (const [owned, key, expectedFamily] of [
      [writer, `native-completion:${writer.id}`, native.appointment.route.family],
      [attempt, `native-review-completion:${attempt.id}`, 'openai'],
    ] as const) {
      const completed = z
        .object({ attemptId: z.string(), reason: z.null(), quiescent: z.literal(true) })
        .parse(this.nativeRecord(key, 4096).value);
      const intent = this.store.intents().find((value) => value.attempt_id === owned.id);
      const phases = this.store.nativeProcesses(owned.id);
      if (
        completed.attemptId !== owned.id ||
        intent?.state !== 'stopped' ||
        !this.store.nativePhasesComplete(owned.id, expectedFamily) ||
        phases.some((phase) => phase.state !== 'quiescent')
      )
        throw Error('evidence-incomplete');
    }
    const identity = this.nativeReviewIdentity(evaluation, job, saved.check);
    if (!same(saved.identity, identity)) throw Error('evidence-incomplete');
    const review = this.store.db
      .prepare(
        "SELECT body FROM evidence WHERE candidate_id=? AND candidate_hash=? AND kind='review'",
      )
      .all(candidate.id, candidate.hash)
      .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)))
      .find(
        (check) =>
          check.passed &&
          check.review &&
          same(check.review.job, job) &&
          check.evaluator === identity.evaluator &&
          check.definitionHash === identity.definitionHash,
      );
    if (review?.review?.outcome !== 'passed') throw Error('evidence-incomplete');
    const result = this.store.get<Artifact>('artifact', review.artifactId);
    const metadata = z
      .object({
        review: z.unknown(),
        model: z.string(),
        requestedEffort: z.string(),
        qualified: z.literal(false),
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        observedRetries: z.number().int().nonnegative(),
      })
      .parse(this.nativeRecord(`native-review-result:${attempt.id}`).value);
    if (
      !result ||
      result.bytes > MAX_FRAME_BYTES ||
      !same(JSON.parse(this.artifacts.read(result.hash).toString('utf8')), review.review) ||
      metadata.model !== input.model ||
      metadata.requestedEffort !== input.effort ||
      !same(metadata.review, {
        version: 1,
        bindingHash: hashCanonical(input.binding),
        methodId: job.methodId,
        cycle: job.cycle,
        outcome: review.review.outcome,
        findings: review.review.findings,
        summary: review.review.summary,
      })
    )
      throw Error('evidence-incomplete');
    return { evaluation, writer, review, prepared };
  }

  private nativeAcceptanceAvailability(
    run: Run,
    candidate: Candidate,
  ): CandidateEvaluationPreview['localAcceptance'] {
    const refused = (reason: CandidateEvaluationPreview['localAcceptance']['reason']) => ({
      available: false,
      reason,
    });
    const task = this.store.get<Task>('task', run.taskId);
    if (this.hasUncertainWriter(run.taskId) || task?.state === 'unknown')
      return refused('ownership-unknown');
    const publication = this.store.db
      .prepare('SELECT state FROM publications WHERE candidate_id=?')
      .get(candidate.id);
    if (task?.state === 'accepted' || publication?.state === 'applied') return refused('accepted');
    if (publication) return refused('publication-prepared');
    if (
      this.store.db
        .prepare("SELECT approval_id FROM pending_effects WHERE task_id=? AND state='pending'")
        .get(run.taskId)
    )
      return refused('approval-pending');
    if (!task || task.runId !== run.id || this.latestCandidate(run.id)?.id !== candidate.id)
      return refused('candidate-changed');
    try {
      if (
        hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(run.source)
      )
        return refused('source-changed');
      if (
        this.evidence.hash(run.source.base, readFiles(this.writerScratch(run))) !== candidate.hash
      )
        return refused('candidate-changed');
      this.nativePublicationCurrent(run, candidate);
      const identity =
        typeof this.options.identity === 'function'
          ? this.options.identity()
          : this.options.identity;
      if (!identity) return refused('git-identity-missing');
      try {
        validateIdentity(identity);
      } catch {
        return refused('git-identity-missing');
      }
      return { available: true, reason: 'available' };
    } catch (error) {
      const result = CandidateEvaluationPreviewSchema.shape.localAcceptance.safeParse({
        available: false,
        reason: error instanceof Error ? error.message : undefined,
      });
      return result.success ? result.data : refused('evidence-incomplete');
    }
  }

  private nativePublicationCurrent(
    run: Run,
    candidate: Candidate,
    proof = this.nativePublicationEvidence(run, candidate),
  ) {
    const origin = this.evaluationOrigin(run.taskId, candidate.id);
    if (
      !['checking', 'stopped', 'ready', 'waiting', 'accepted'].includes(origin.task.state) ||
      hashCanonical({
        title: origin.task.title,
        outcome: origin.task.outcome,
        criteria: origin.task.criteria,
      }) !== hashCanonical(proof.evaluation.context)
    )
      throw Error('candidate-changed');
    const definition = this.currentEvaluationDefinition(proof.evaluation);
    if (!completedCheckDefinitionMatches(proof.evaluation.definition, definition))
      throw Error('evidence-incomplete');
    return proof;
  }

  private candidateReviewAuthority(artifact: Artifact, ownedAttemptId?: string) {
    const origin = this.evaluationAuthority(artifact, ownedAttemptId);
    const { plan, definition } = origin;
    if (
      this.store.receipt(`evaluation-started:${plan.run.id}`)?.hash !== artifact.hash ||
      plan.reviewer.methodId !== 'keep-it-simple' ||
      plan.reviewer.cycles !== 1
    )
      throw Error('preparation-changed');
    const checkArtifact = ArtifactSchema.parse(
      this.store.receipt(`evaluation-result:${artifact.id}`)?.result.entity,
    );
    if (
      this.store.receipt(`evaluation-result:${artifact.id}`)?.hash !== artifact.hash ||
      !this.checks(origin.candidate).some(
        (check) =>
          check.artifactId === checkArtifact.id &&
          this.checkMatches(check, origin.candidate, definition),
      )
    )
      throw Error('checks-required');
    const grant = plan.grants.find(
      (grant) =>
        grant.action === 'run-review' &&
        grant.target === formatReviewTarget({ methodId: plan.reviewer.methodId, cycle: 1 }),
    );
    if (
      !grant ||
      grant.taskId !== origin.task.id ||
      grant.revoked ||
      grant.usesRemaining !== 1 ||
      Date.parse(grant.expiresAt) <= Date.parse(this.now())
    )
      throw Error('grant-unavailable');
    const used = this.store.receipt(this.grantKey(grant));
    if (ownedAttemptId ? used?.hash !== hashCanonical(grant) : !!used)
      throw Error('grant-unavailable');
    return { ...origin, checkArtifact, grant };
  }

  private nativeReviewIdentity(
    plan: z.infer<typeof CandidateEvaluationSchema>,
    job: NativeReviewJob,
    check: Artifact,
  ) {
    return {
      evaluator: `native:openai:${hashCanonical({ profile: plan.reviewer.profile, client: plan.reviewer.client })}`,
      definitionHash: hashCanonical({
        job,
        scopeHash: plan.scopeHash,
        check,
        profile: plan.reviewer.profile,
        client: plan.reviewer.client,
      }),
    };
  }

  private candidateReviewRoute(
    profile: NativeProfileResolution,
    creditPolicy: NativePilotAppointment['creditPolicy'],
    preparationId: string,
  ) {
    if (profile.facts.family !== 'openai' || profile.facts.id !== 'openai-file-v1')
      throw Error('The reviewer profile is unavailable.');
    const existing = this.nativeProfileRoute(profile, creditPolicy);
    if (existing) return existing;
    const receipt = this.store.receipt(
      `native-review-profile-route:${profile.facts.id}:${creditPolicy}`,
    );
    const artifact = receipt ? ArtifactSchema.parse(receipt.result.entity) : undefined;
    if (artifact && artifact.bytes > 8192) throw Error('Reviewer route exceeds its bound.');
    const saved = artifact
      ? z
          .strictObject({
            profileId: z.string(),
            client: NativeFileAppointmentSchema.shape.client,
            route: RouteSchema,
          })
          .parse(JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')))
      : undefined;
    const route = RouteSchema.parse({
      id:
        saved?.route.id ??
        RouteIdSchema.parse(ArtifactSchema.shape.id.parse(preparationId).replace(/^art_/, 'rte_')),
      family: profile.facts.family,
      displayName: profile.facts.displayName,
      model: profile.facts.model,
      effort: {
        requested: profile.facts.effort,
        effective: profile.facts.effort,
        supported: [profile.facts.effort],
      },
      billing: creditPolicy === 'ordinary' ? 'included' : 'credits',
      qualified: false,
      fake: false,
    });
    const current = this.store.get<Route>('route', route.id);
    if (current && hashCanonical(current) !== hashCanonical(route))
      throw Error('Reviewer route collision.');
    if (
      saved &&
      (saved.profileId !== profile.facts.id ||
        hashCanonical(saved.client) !== hashCanonical(profile.client) ||
        hashCanonical(saved.route) !== hashCanonical(route) ||
        hashCanonical(this.store.get<Route>('route', route.id)) !== hashCanonical(route))
    )
      throw Error('Reviewer route changed.');
    return route;
  }

  private startCandidateReview(
    command: Extract<Command, { command: 'StartCandidateReview' }>,
    effects: (() => void)[],
  ): CommandResult {
    let prepared: ReturnType<Controller['candidateReviewAuthority']>;
    let artifact: Artifact;
    let job: NativeReviewJob;
    let input: ReturnType<typeof reviewPlan>;
    let route: Route;
    try {
      artifact = ArtifactSchema.parse(
        this.store.get<Artifact>('artifact', command.payload.preparationId),
      );
      const plan = this.evaluationPlan(artifact);
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (
        !task ||
        task.runId !== plan.run.id ||
        plan.run.taskId !== task.id ||
        plan.candidate.id !== command.payload.candidateId
      )
        throw Error('Review lineage changed.');
      const prior = this.store.receipt(`native-review-started:${plan.run.id}`);
      if (prior)
        return prior.hash === artifact.hash
          ? { outcome: 'already-applied', entity: prior.result.entity, revision: task.revision }
          : { outcome: 'blocked', reason: 'candidate-review-already-started' };
      prepared = this.candidateReviewAuthority(artifact);
      if (prepared.task.state !== 'stopped') throw Error('The writer and checks must be stopped.');
      const remaining = this.remaining(plan.run);
      const timeoutMs = Math.min(
        300000,
        remaining.minutes * 60000,
        Date.parse(plan.expiresAt) - Date.parse(this.now()),
      );
      if (!remaining.attempts || !remaining.concurrency || timeoutMs <= 2000)
        throw Error('The review has no bounded execution slot.');
      const reviewRoute = this.candidateReviewRoute(
        this.profileFor(plan.reviewer.profileId),
        plan.creditPolicy,
        artifact.id,
      );
      if (!reviewRoute) throw Error('Reviewer route is unavailable.');
      route = reviewRoute;
      // The evaluation grant permits one review within the original run budget.
      const decision = this.nativeDecision(
        {
          ...prepared.native.appointment,
          route,
          creditPolicy: plan.creditPolicy,
          maximumTaskMs: Math.min(300000, remaining.minutes * 60000),
          expiresAt: plan.expiresAt,
        },
        plan.run,
        true,
      );
      if (!decision.chosen) throw Error('The reviewer allowance is unavailable.');
      const attempt = this.jobAttempt(plan.run, route.id);
      job = NativeReviewJobSchema.parse({
        taskId: plan.run.taskId,
        runId: plan.run.id,
        attemptId: attempt.id,
        generation: attempt.generation,
        routeId: route.id,
        writerAttemptId: plan.writer.id,
        writerRouteId: plan.writer.routeId,
        candidateId: plan.candidate.id,
        candidateHash: plan.candidate.hash,
        methodId: plan.reviewer.methodId,
        cycle: 1,
        limitMinutes: Math.min(5, remaining.minutes),
        scripted: false,
        preparationId: artifact.id,
        profileId: plan.reviewer.profileId,
        assignedRole: plan.reviewer.role,
        independence: 'process-only',
      });
      const reviewSource = this.nativeReviewSource(prepared.native, plan.candidate);
      input = reviewPlan({
        binding: {
          ...job,
          profileId: plan.reviewer.profileId as ReviewPlan['binding']['profileId'],
          scopeHash: plan.scopeHash,
        },
        directory: join(this.home, 'native-review', job.attemptId),
        model: route.model as ReviewPlan['model'],
        effort: route.effort.requested as ReviewPlan['effort'],
        creditPolicy: plan.creditPolicy,
        ...reviewSource,
        context: plan.context,
      });
    } catch {
      return {
        outcome: 'blocked',
        reason: 'candidate-review-unavailable',
        next: 'Review the exact successful checks, candidate, reviewer consent and remaining limits.',
      };
    }
    const { plan } = prepared;
    if (!this.store.get<Route>('route', route.id)) {
      const routeArtifact = this.nativeArtifact({
        profileId: plan.reviewer.profileId,
        client: plan.reviewer.client,
        route,
      });
      this.store.put('route', route.id, 0, route);
      this.store.saveReceipt(
        `native-review-profile-route:${plan.reviewer.profileId}:${plan.creditPolicy}`,
        routeArtifact.hash,
        'local-owner',
        { outcome: 'applied', entity: routeArtifact },
      );
    }
    const attempt = AttemptSchema.parse({
      id: job.attemptId,
      runId: job.runId,
      routeId: job.routeId,
      generation: job.generation,
      state: 'intent',
      revision: 0,
    });
    const minutes = this.admitJob(plan.run, attempt, input.directory, job.limitMinutes);
    job = freezeNative(job);
    input = freezeNative(input);
    const identity = this.nativeReviewIdentity(plan, job, prepared.checkArtifact);
    const inputArtifact = this.nativeArtifact({
      preparation: artifact,
      job,
      input,
      check: prepared.checkArtifact,
      identity,
      allowance: {
        source: 'supplemental-evaluation',
        maximumSubmissions: 1,
        grantHash: hashCanonical(prepared.grant),
        maximumTaskMs: job.limitMinutes * 60000,
        originalPolicyHash: plan.run.policy.hash,
      },
    });
    this.store.saveReceipt(`native-review-started:${plan.run.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: inputArtifact,
    });
    this.store.saveReceipt(`native-review-input:${attempt.id}`, inputArtifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: inputArtifact,
    });
    this.store.db
      .prepare('INSERT INTO review_jobs(attempt_id,candidate_id,body) VALUES (?,?,?)')
      .run(attempt.id, plan.candidate.id, canonicalJson(job));
    this.consumeGrant(plan.run, prepared.grant);
    this.updateTask(this.store.get<Task>('task', plan.run.taskId) as Task, {
      state: 'checking',
      waitingReason: null,
      next: 'Running one native review in a fresh process. Acceptance remains unavailable.',
    });
    effects.push(() =>
      this.launchCandidateReview(
        artifact,
        job,
        input,
        attempt,
        minutes,
        prepared.environment,
        identity,
      ),
    );
    return {
      outcome: 'applied',
      entity: inputArtifact,
      revision: (this.store.get<Task>('task', plan.run.taskId) as Task).revision,
    };
  }

  private nativeReviewCurrent(runtime: NativeReviewRuntime) {
    const { job, attempt, preparation } = runtime;
    const prepared = this.candidateReviewAuthority(preparation, attempt.id);
    const current = this.store.get<Attempt>('attempt', attempt.id);
    const lease = this.store.db
      .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
      .get(job.taskId);
    const storedJob = this.store.db
      .prepare('SELECT body FROM review_jobs WHERE attempt_id=?')
      .get(attempt.id);
    if (
      this.closed ||
      runtime.stopped ||
      prepared.task.state !== 'checking' ||
      !current ||
      !['intent', 'running'].includes(current.state) ||
      current.generation !== attempt.generation ||
      lease?.attempt_id !== attempt.id ||
      lease.generation !== attempt.generation ||
      this.jobDeadline(attempt.id, job.limitMinutes) === 0 ||
      !storedJob ||
      hashCanonical(JSON.parse(storedJob.body as string)) !== hashCanonical(job)
    )
      throw Error('Native review authority is no longer current.');
    return prepared;
  }

  private launchCandidateReview(
    preparation: Artifact,
    job: NativeReviewJob,
    input: ReviewPlan,
    attempt: Attempt,
    minutes: number,
    environment: NodeJS.ProcessEnv,
    identity: { evaluator: string; definitionHash: string },
  ) {
    if (this.closed || this.store.get<Attempt>('attempt', attempt.id)?.state !== 'intent') return;
    const completed = Promise.withResolvers<void>();
    const runtime: NativeReviewRuntime = {
      preparation,
      job,
      input,
      attempt,
      stopped: false,
      done: completed.promise,
    };
    this.nativeReviewWorkers.set(attempt.id, runtime);
    const finish = (outcome: Awaited<ReturnType<typeof startReview>['result']> | null) => {
      try {
        const phases = this.store.nativeProcesses(attempt.id);
        const quiescent =
          (outcome?.quiescent === true && phases.every((phase) => phase.state === 'quiescent')) ||
          (!runtime.handle && phases.length === 0);
        let review: ReviewResult | undefined;
        try {
          this.nativeReviewCurrent(runtime);
          if (
            quiescent &&
            this.store.nativePhasesComplete(attempt.id, 'openai') &&
            outcome?.reason === null &&
            outcome.metadata &&
            outcome.metadata.review.bindingHash === hashCanonical(input.binding)
          )
            review = ReviewResultSchema.parse({
              job,
              outcome: outcome.metadata.review.outcome,
              findings: outcome.metadata.review.findings,
              summary: outcome.metadata.review.summary,
            });
        } catch {
          // A completed answer cannot authorize stale candidate evidence.
        }
        this.store.transaction(() => {
          const artifact = this.nativeArtifact({
            attemptId: attempt.id,
            reason: outcome ? outcome.reason : 'launch',
            quiescent,
            diagnostic: outcome?.diagnostic ?? null,
          });
          this.store.saveReceipt(
            `native-review-completion:${attempt.id}`,
            artifact.hash,
            'local-owner',
            { outcome: 'applied', entity: artifact },
          );
          if (outcome?.metadata) {
            const result = this.nativeArtifact(outcome.metadata);
            this.store.saveReceipt(
              `native-review-result:${attempt.id}`,
              result.hash,
              'local-owner',
              { outcome: 'applied', entity: result },
            );
          }
          if (quiescent) {
            const result: ReviewResult = review ?? {
              job,
              outcome: 'blocked',
              findings: [
                {
                  severity: 'blocking',
                  message:
                    'The native review did not complete with current authority and proven ownership.',
                },
              ],
              summary: 'Native review evidence is incomplete.',
            };
            const artifact = this.nativeArtifact(result);
            const check = CheckResultSchema.parse({
              candidateId: job.candidateId,
              candidateHash: job.candidateHash,
              ...identity,
              review: result,
              passed: !!review && review.outcome === 'passed',
              artifactId: artifact.id,
            });
            this.store.db
              .prepare(
                "INSERT OR REPLACE INTO evidence(candidate_id,kind,candidate_hash,definition_hash,evaluator,body) VALUES (?,'review',?,?,?,?)",
              )
              .run(
                job.candidateId,
                job.candidateHash,
                check.definitionHash,
                check.evaluator,
                canonicalJson(check),
              );
            const task = this.store.get<Task>('task', job.taskId) as Task;
            this.event('review.completed', task.id, task.revision, check);
          }
        });
        if (this.settleJob(attempt, quiescent, true))
          this.store.transaction(() => {
            const task = this.store.get<Task>('task', job.taskId) as Task;
            let ready = false;
            if (!runtime.stopped && !this.closed && review?.outcome === 'passed') {
              try {
                this.nativePublicationCurrent(
                  this.store.get<Run>('run', job.runId) as Run,
                  this.store.get<Candidate>('candidate', job.candidateId) as Candidate,
                );
                ready = true;
              } catch {}
            }
            this.updateTask(task, {
              state: ready
                ? 'ready'
                : runtime.stopped || review?.outcome === 'passed'
                  ? 'stopped'
                  : 'failed',
              waitingReason: null,
              next: runtime.stopped
                ? 'Native review stopped. Inspect retained evidence.'
                : review?.outcome === 'passed'
                  ? ready
                    ? 'Checks and native review passed. Request local branch acceptance or export the patch.'
                    : 'Native review passed. Current publication evidence is unavailable.'
                  : 'Native review failed or is unverified. Inspect retained evidence.',
            });
          });
        if (quiescent) this.nativeReviewWorkers.delete(attempt.id);
      } catch {
        try {
          this.settleJob(attempt, false, true);
        } catch {}
      } finally {
        completed.resolve();
      }
    };
    try {
      const prepared = this.nativeReviewCurrent(runtime);
      mkdirSync(input.directory, { recursive: true, mode: 0o700 });
      runtime.handle = startReview(
        {
          ...prepared.plan.reviewer.client,
          directory: input.directory,
          repositoryRoot: this.home,
          environment,
        },
        input,
        {
          timeoutMs: Math.min(
            300000,
            this.jobDeadline(attempt.id, minutes),
            Date.parse(prepared.plan.expiresAt) - Date.parse(this.now()),
          ),
          schedule: this.options.schedule,
          spawn: this.options.nativeSpawn,
          onSubmitted: () => {
            this.nativeReviewCurrent(runtime);
            this.store.transaction(() => {
              this.nativeReviewCurrent(runtime);
              const artifact = this.nativeArtifact({
                attemptId: attempt.id,
                preparationHash: preparation.hash,
                bindingHash: hashCanonical(input.binding),
              });
              this.store.saveReceipt(
                `native-review-submission:${attempt.id}`,
                preparation.hash,
                'local-owner',
                { outcome: 'outcome-unknown', entity: artifact },
              );
            });
          },
          lifecycle: this.nativeLifecycle(attempt, () => {
            this.nativeReviewCurrent(runtime);
          }),
        },
      );
      if (runtime.stopped || this.closed) runtime.handle.stop();
      void runtime.handle.result.then(finish, () => finish(null));
    } catch {
      finish(null);
    }
  }

  private preparedNativeBinding(run: Run): NativeBinding {
    const receipt = this.store.receipt(`native-prepared:${run.id}`);
    if (receipt?.result.outcome !== 'applied') throw Error('Native preparation is unavailable.');
    const artifact = ArtifactSchema.parse(receipt.result.entity);
    if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Native preparation exceeds its bound.');
    const plan = NativePreparationSchema.parse(
      JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
    );
    const profile = this.profileFor(plan.public.profileId);
    if (profile.facts.family === 'local') throw Error('Local native launch is unavailable.');
    if (profile.facts.reason === 'provider-policy-restricted')
      throw Error('provider-policy-restricted');
    if (
      !profile.facts.available ||
      profile.facts.id !== plan.public.profileId ||
      !profile.facts.creditPolicies.some((policy) => policy === plan.appointment.creditPolicy) ||
      (!('acp' in plan.appointment) &&
        this.nativeProfileRoute(profile, plan.appointment.creditPolicy)?.id !==
          plan.appointment.route.id) ||
      profile.locationHash !== plan.public.locationHash ||
      hashCanonical(profile.client) !== hashCanonical(plan.appointment.client) ||
      !profile.environment
    )
      throw Error('Native profile changed.');
    const task = this.store.get<Task>('task', run.taskId);
    if (
      !task ||
      task.runId !== run.id ||
      hashCanonical(run) !== hashCanonical(plan.run) ||
      plan.attempt.runId !== run.id ||
      plan.attempt.generation !== 0 ||
      plan.appointment.taskId !== task.id ||
      plan.appointment.consent.sourceBase !== run.source.base ||
      plan.appointment.consent.policyHash !== run.policy.hash ||
      Date.parse(plan.appointment.expiresAt) <= Date.parse(this.now())
    )
      throw Error('Native preparation changed.');
    const files = committedFiles(this.projectPath(task.projectId) as string, run.source.base);
    const manifest = files.map(({ content: _content, ...file }) => file);
    if (hashCanonical(manifest) !== hashCanonical(plan.manifest))
      throw Error('Native manifest changed.');
    const appointment = plan.appointment;
    if ('acp' in appointment) {
      const setup = this.store.googleAcpSetup(),
        artifact = this.store.get<Artifact>('artifact', appointment.acp.proofId);
      if (
        setup.state !== 'ready' ||
        setup.proofId !== appointment.acp.proofId ||
        artifact?.hash !== appointment.proofHash ||
        hashCanonical(this.acpProof(appointment.acp.proofId)) !== hashCanonical(appointment.proof)
      )
        throw Error('ACP proof changed.');
      validateAcpSetupProof(
        appointment.proof,
        appointment.client,
        this.options.googleAcp?.reviewMappings,
      );
    }
    const original =
      'target' in appointment
        ? files.find((file) => file.path === appointment.target.path)
        : undefined;
    if ('repository' in plan.appointment) {
      if (
        hashCanonical(this.repositoryScope(run.source.base, manifest)) !==
          hashCanonical(plan.appointment.repository) ||
        !('execution' in profile.facts) ||
        hashCanonical(profile.facts.execution) !== hashCanonical(plan.appointment.execution)
      )
        throw Error('Native repository scope changed.');
    } else if (
      !original ||
      original.hash !== plan.originalHash ||
      original.hash !== plan.appointment.target.baseHash
    )
      throw Error('Native target changed.');
    const binding = freezeNative({
      appointment: plan.appointment,
      run,
      attempt: plan.attempt,
      ...(original ? { original: original.content.toString('utf8'), baseHash: original.hash } : {}),
      ...(plan.anthropicSessionId ? { anthropicSessionId: plan.anthropicSessionId } : {}),
      manifest,
      planArtifact: artifact,
      public: plan.public,
      environment: { ...profile.environment },
    });
    if (!this.nativeConsentCurrent(binding)) throw Error('Native consent changed.');
    this.nativeWriterPlan(binding);
    return binding;
  }

  private planNativeAppointment(
    appointment: NativePilotAppointment,
    publicScope?: z.infer<typeof NativePublicScopeSchema>,
    runId = this.id('run'),
  ): Omit<NativeBinding, 'planArtifact'> {
    const task = this.store.get<Task>('task', appointment.taskId);
    if (task?.state !== 'draft' || this.draftEditGate(task))
      throw new Error('The appointment needs an unstarted draft.');
    const route = appointment.route;
    const billingAttestation =
      'billingAttestation' in appointment ? appointment.billingAttestation : undefined;
    const permissionMode = 'permissionMode' in appointment ? appointment.permissionMode : undefined;
    if (
      route.fake ||
      route.qualified ||
      !['openai', 'anthropic', 'google'].includes(route.family) ||
      route.billing !== (appointment.creditPolicy === 'ordinary' ? 'included' : 'credits') ||
      route.speed ||
      (route.family === 'openai'
        ? route.effort.requested !== route.effort.effective || !!billingAttestation
        : route.effort.requested !== (route.family === 'anthropic' ? 'medium' : 'low') ||
          route.effort.effective !== 'unknown' ||
          appointment.creditPolicy !== 'ordinary' ||
          !billingAttestation) ||
      (route.family === 'google') !== !!permissionMode ||
      (route.family === 'google' && !publicScope) ||
      !route.effort.supported.includes(route.effort.requested) ||
      (this.store.get('route', route.id) &&
        (!publicScope ||
          this.nativeProfileRoute(this.profileFor(publicScope.profileId), appointment.creditPolicy)
            ?.id !== route.id))
    )
      throw new Error('The appointment route identity is invalid.');
    if (
      appointment.consent.policyHash !== hashCanonical(appointment.policy) ||
      appointment.consent.criteriaHash !== hashCanonical(task.criteria) ||
      Date.parse(appointment.expiresAt) <= Date.parse(this.now())
    )
      throw new Error('The appointment consent is stale.');
    const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
    if (source.base !== appointment.consent.sourceBase)
      throw new Error('The appointed source base changed.');
    const files = committedFiles(this.projectPath(task.projectId) as string, source.base);
    const original =
      'target' in appointment
        ? files.find((file) => file.path === appointment.target.path)
        : undefined;
    if ('repository' in appointment) {
      if (
        publicScope?.profileId !== 'openai-repository-v1' ||
        hashCanonical(this.repositoryScope(source.base, files)) !==
          hashCanonical(appointment.repository)
      )
        throw Error('The appointed repository scope is unavailable.');
    } else if (
      !original ||
      original.bytes > 65_536 ||
      original.hash !== appointment.target.baseHash
    )
      throw new Error('The appointed target is unavailable.');
    const methods = appointment.policy.methods ?? [];
    if (
      !requiredReviewMethodIds(appointment.policy.quality).every((id) =>
        methods.some((method) => method.id === id),
      ) ||
      appointment.policy.limits.attempts <
        methods.reduce((sum, method) => sum + method.cycles, 0) + 2
    )
      throw new Error('The appointed policy lacks check and review headroom.');
    const attemptId = this.id('att');
    const run = RunSchema.parse({
      id: runId,
      taskId: task.id,
      source,
      policy: { policy: appointment.policy, hash: hashCanonical(appointment.policy) },
      roles: [{ role: 'coder', routeId: route.id, pinned: true, approvedFallbacks: [] }],
      decision: {
        chosen: route.id,
        rejected: [],
        rule: 'manual',
        inputsHash: hashCanonical(appointment),
      },
      revision: 0,
    });
    const attempt = AttemptSchema.parse({
      id: attemptId,
      runId: run.id,
      routeId: route.id,
      generation: 0,
      state: 'intent',
      revision: 0,
    });
    const sessionHash = hashCanonical({ attemptId });
    const anthropicSessionId =
      route.family === 'anthropic'
        ? `${sessionHash.slice(0, 8)}-${sessionHash.slice(8, 12)}-8${sessionHash.slice(13, 16)}-a${sessionHash.slice(17, 20)}-${sessionHash.slice(20, 32)}`
        : undefined;
    this.nativeDecision(appointment, run, !!publicScope);
    const project = this.store.get<Project>('project', task.projectId) as Project;
    if ('repository' in appointment && !this.grant(run, 'run-native-tools', project.name))
      throw Error('The appointment needs a saved native-tool grant.');
    if (!this.grant(run, 'write-scratch', project.name))
      throw new Error('The appointment needs a saved scratch grant.');
    const manifest = files.map(({ content: _content, ...file }) => file);
    const plan = freezeNative({
      appointment,
      run,
      attempt,
      manifest,
      ...(original ? { original: original.content.toString('utf8'), baseHash: original.hash } : {}),
      ...(anthropicSessionId ? { anthropicSessionId } : {}),
      ...(publicScope ? { public: publicScope } : {}),
    });
    this.nativeWriterPlan(plan);
    if (Buffer.byteLength(canonicalJson(this.nativePlanPayload(plan))) > MAX_FRAME_BYTES)
      throw Error('Native plan exceeds its bound.');
    return plan;
  }

  private nativePlanPayload(plan: Omit<NativeBinding, 'planArtifact'>) {
    const { appointment, run, attempt, manifest } = plan;
    return {
      appointment,
      run,
      attempt,
      manifest,
      ...('repository' in appointment ? {} : { originalHash: plan.baseHash }),
      ...(plan.anthropicSessionId ? { anthropicSessionId: plan.anthropicSessionId } : {}),
      ...(plan.public ? { public: plan.public } : {}),
      ...(plan.handoff ? { handoff: plan.handoff } : {}),
    };
  }

  private saveNativePlan(plan: Omit<NativeBinding, 'planArtifact'>): NativeBinding {
    const { appointment, run } = plan;
    const task = this.store.get<Task>('task', appointment.taskId) as Task;
    const planArtifact = this.nativeArtifact(this.nativePlanPayload(plan));
    this.store.put('route', appointment.route.id, 0, appointment.route);
    if (
      plan.public &&
      !this.store.receipt(
        `native-profile-route:${plan.public.profileId}:${appointment.creditPolicy}`,
      )
    )
      this.store.saveReceipt(
        `native-profile-route:${plan.public.profileId}:${appointment.creditPolicy}`,
        hashCanonical({
          profileId: plan.public.profileId,
          client: appointment.client,
          route: appointment.route,
        }),
        'local-owner',
        { outcome: 'applied', entity: planArtifact },
      );
    this.store.put('run', run.id, 0, run);
    this.store.putRunPurpose(run, 'execution', task.runId);
    this.updateTask(task, { runId: run.id });
    this.store.saveReceipt(`native-run:${run.id}`, hashCanonical(appointment), 'local-owner', {
      outcome: 'applied',
      entity: planArtifact,
    });
    return freezeNative({ ...plan, planArtifact });
  }

  startNativePilot(input: NativePilotAppointment): CommandResult {
    const effects: (() => void)[] = [];
    try {
      const appointment = freezeNative(NativeAppointmentSchema.parse(input));
      const result = this.store.transaction<CommandResult>(() => {
        if (this.closed) throw new Error('Controller is closing.');
        const key = `native-appointment:${appointment.id}`;
        const hash = hashCanonical(appointment);
        const prior = this.store.receipt(key);
        if (prior)
          return prior.hash === hash
            ? { ...prior.result, outcome: 'already-applied' }
            : { outcome: 'denied', reason: 'native-appointment-changed' };
        const binding = this.saveNativePlan(this.planNativeAppointment(appointment));
        const { run, attempt } = binding;
        const task = this.store.get<Task>('task', appointment.taskId) as Task;
        const result = this.start(
          {
            protocol: 1,
            key: this.id('cmd'),
            actor: { id: 'local-owner', kind: 'cli' },
            command: 'StartRun',
            expectedRevision: task.revision,
            payload: { taskId: task.id, runId: run.id },
          },
          effects,
          undefined,
          attempt,
          false,
          binding,
        );
        if (result.outcome !== 'applied') throw new Error('The appointed run failed admission.');
        this.store.saveReceipt(key, hash, 'local-owner', result);
        return result;
      });
      for (const effect of effects) effect();
      return result;
    } catch {
      return {
        outcome: 'blocked',
        reason: 'native-appointment-unavailable',
        next: 'Inspect the exact appointment, consent and retained ownership.',
      };
    }
  }

  private nativeManualAllowance(run: Run, routeId: string, requestedMinutes: number) {
    if (!this.store.receipt(`native-handoff-roster:${run.id}`)) return;
    const allowance = run.policy.policy.unknownUsage;
    const ledger = this.store
      .intents()
      .filter((intent) => intent.run_id === run.id && intent.route_id === routeId);
    const completed = ledger.filter((intent) => intent.state === 'stopped');
    const active = ledger.filter((intent) => intent.state !== 'stopped');
    const minutes = completed.reduce(
      (sum, intent) => sum + chargedMinutes(intent, run.policy.policy.limits.minutes),
      0,
    );
    if (
      allowance.rule !== 'fixed-allowance' ||
      ledger.length + 1 > allowance.allowance.launches ||
      minutes + active.length * run.policy.policy.limits.minutes + requestedMinutes >
        allowance.allowance.minutes
    )
      throw Error('The original per-route launch allowance is exhausted.');
  }

  private nativeDecision(
    appointment: NativePilotAppointment,
    run: Run,
    publicProfile = false,
  ): RouterDecision {
    if ('acp' in appointment && appointment.route.family === 'google')
      return this.acpDecision(appointment, run);
    const policy = run.policy.policy;
    const allowance = policy.unknownUsage;
    const active = this.store.intents().filter((intent) => intent.state !== 'stopped');
    this.nativeManualAllowance(run, appointment.route.id, this.remaining(run).minutes);
    // Native observations cannot yet establish a reserve in the controller's usage units.
    if (
      policy.reserves.length ||
      allowance.rule !== 'fixed-allowance' ||
      allowance.allowance.launches < 1 ||
      allowance.allowance.minutes < policy.limits.minutes ||
      policy.limits.minutes * 60_000 < appointment.maximumTaskMs ||
      (!publicProfile && active.some((intent) => intent.route_id === appointment.route.id)) ||
      Date.parse(appointment.expiresAt) <= Date.parse(this.now())
    )
      throw new Error('The appointed allowance or reserve premise is unavailable.');
    return {
      chosen: appointment.route.id,
      rejected: [],
      rule: 'manual',
      inputsHash: hashCanonical({ appointment, runId: run.id, active }),
    };
  }

  private acpDecision(
    appointment: z.infer<typeof NativeAcpAppointmentSchema>,
    run: Run,
  ): RouterDecision {
    const reader = this.store.googleUsageReader();
    const windows = this.store
      .list<Observation>('window')
      .filter((value) => value.routeId === appointment.route.id && value.kind !== 'local');
    let reason: string | undefined;
    if (!reader.enabled || !reader.last_observed_at || !windows.length)
      reason = 'Google quota needs an enabled reader and fresh observations.';
    for (const window of windows) {
      if (
        deriveWindow(window, { nowMs: Date.parse(this.now()), maxAgeMs: 300000 }).state !==
          'fresh' ||
        window.remaining === null ||
        window.source !== 'client' ||
        window.confidence !== 'reported'
      ) {
        reason = 'Every Google quota bucket must be fresh.';
        continue;
      }
      const reserves = run.policy.policy.reserves.filter(
        (value) => value.routeId === window.routeId && value.windowId === window.windowId,
      );
      const reservations = this.store.db
        .prepare('SELECT unit,value FROM reservations WHERE route_id=? AND window_id=?')
        .all(window.routeId, window.windowId) as {
        unit: NonNullable<Observation['remaining']>['unit'];
        value: number;
      }[];
      if (
        reserves.length > 1 ||
        availableAllowance({ remaining: window.remaining, reserve: reserves[0], reservations }) <= 0
      )
        reason = 'A Google quota bucket has reached its reserve.';
    }
    if (
      run.policy.policy.reserves.some(
        (value) =>
          value.routeId === appointment.route.id &&
          !windows.some((window) => window.windowId === value.windowId),
      )
    )
      reason = 'A Google reserve has no observed bucket.';
    if (Date.parse(appointment.expiresAt) <= Date.parse(this.now()))
      reason = 'Native consent expired.';
    return {
      chosen: reason ? null : appointment.route.id,
      rejected: reason ? [{ routeId: appointment.route.id, reason }] : [],
      rule: 'percentage',
      inputsHash: hashCanonical({ reader, windows, policy: run.policy, reason: reason ?? null }),
    };
  }

  private validateAcpPermission(runtime: NativeRuntime, proposal: AcpPermissionProposal) {
    this.nativeCurrent(runtime);
    const appointment = runtime.binding.appointment;
    if (!('acp' in appointment)) throw Error('ACP permission has no owned attempt.');
    const detail = AcpPermissionActionSchema.parse(proposal.detail);
    AcpApprovalTargetSchema.parse(proposal.acpTarget);
    if (
      proposal.action !== 'write-scratch' ||
      proposal.target !== appointment.target.path ||
      detail.path !== appointment.target.path ||
      proposal.consequence !== canonicalJson(detail) ||
      Buffer.byteLength(proposal.consequence) > 4096 ||
      proposal.actionHash !== hashCanonical(detail) ||
      !HashSchema.safeParse(proposal.proposalHash).success
    )
      throw Error('ACP action changed.');
    const captured = captureSingleFileEdit({
      directory: this.writerScratch(runtime.binding.run),
      manifest: runtime.binding.manifest,
      target: appointment.target,
    });
    if (
      captured.target.hash !== detail.baseHash ||
      captured.target.mode !== detail.mode ||
      captured.files.find((file) => file.path === detail.path)?.content.toString('utf8') !==
        detail.oldText
    )
      throw Error('ACP action no longer matches scratch.');
  }

  private requestAcpPermission(
    runtime: NativeRuntime,
    proposal: AcpPermissionProposal,
  ): z.infer<typeof ApprovalBindingSchema> {
    this.validateAcpPermission(runtime, proposal);
    return this.store.transaction(() => {
      this.validateAcpPermission(runtime, proposal);
      const { run, attempt } = runtime.binding,
        task = this.store.get<Task>('task', run.taskId) as Task;
      if (
        this.store.db
          .prepare("SELECT approval_id FROM pending_effects WHERE task_id=? AND state='pending'")
          .get(task.id)
      )
        throw Error('A native permission is already pending.');
      this.requestAction(
        task,
        run,
        attempt,
        'write-scratch',
        proposal.target,
        { kind: 'acp', proposal },
        proposal,
      );
      const row = this.store.db
        .prepare(
          "SELECT approval_id FROM pending_effects WHERE task_id=? AND attempt_id=? AND state='pending'",
        )
        .get(task.id, attempt.id);
      const approval = row
        ? this.store.get<Approval>('approval', row.approval_id as string)
        : undefined;
      if (!approval || hashCanonical(approval.acpTarget) !== hashCanonical(proposal.acpTarget))
        throw Error('ACP permission could not be bound.');
      const {
        requester: _requester,
        consequence: _consequence,
        status: _status,
        ...binding
      } = approval;
      return ApprovalBindingSchema.parse(binding);
    });
  }

  private launchAcpNative(intent: LaunchIntent, binding: NativeBinding) {
    const runtime: NativeRuntime = { kind: 'native', binding, stopped: false };
    const completion = Promise.withResolvers<void>();
    runtime.done = completion.promise;
    this.workers.set(binding.attempt.id, runtime);
    const appointment = binding.appointment;
    if (!('acp' in appointment)) throw Error('ACP appointment is unavailable.');
    const { run, attempt } = binding;
    const finish = (
      outcome: Awaited<ReturnType<typeof startGoogleAcpWriter>['result']> | null,
      unspawned = false,
    ) => {
      try {
        const physical =
          unspawned ||
          (outcome?.quiescent === true && this.store.nativePhasesComplete(attempt.id, 'google'));
        const metadata = outcome?.metadata;
        const terminal =
          !!metadata &&
          metadata.submitted === true &&
          metadata.selectionHash === hashCanonical(appointment.acp) &&
          metadata.reviewModeHash === hashCanonical(appointment.proof.reviewMode) &&
          !!this.store.receipt(`native-submission:${attempt.id}`);
        this.store.transaction(() => {
          const done = this.nativeArtifact({
            attemptId: attempt.id,
            reason: outcome ? outcome.reason : 'launch',
            quiescent: physical,
            diagnostic: null,
            ...(unspawned ? { unspawned: true } : {}),
          });
          this.store.saveReceipt(`native-completion:${attempt.id}`, done.hash, 'local-owner', {
            outcome: 'applied',
            entity: done,
          });
          if (metadata) {
            const proof = this.nativeArtifact(metadata);
            this.store.saveReceipt(`native-proposal:${attempt.id}`, proof.hash, 'local-owner', {
              outcome: 'applied',
              entity: proof,
            });
          }
          if (physical && terminal) {
            const proof = this.nativeArtifact({
              attemptId: attempt.id,
              planHash: binding.planArtifact.hash,
              completionHash: done.hash,
              metadataHash: hashCanonical(metadata),
            });
            this.store.saveReceipt(`native-acp-terminal:${attempt.id}`, proof.hash, 'local-owner', {
              outcome: 'applied',
              entity: proof,
            });
          }
        });
        const known =
          physical && (terminal || !this.store.receipt(`native-submission:${attempt.id}`));
        let eligible =
          known &&
          !runtime.stopped &&
          !this.closed &&
          !outcome?.reason &&
          metadata?.stopReason === 'end_turn';
        if (eligible) {
          try {
            this.nativeCurrent(runtime);
          } catch {
            eligible = false;
          }
        }
        if (!this.settleJob(attempt, known, true)) return;
        let captured = false;
        if (known) {
          try {
            const files = captureSingleFileEdit({
              directory: intent.scratch_path,
              manifest: binding.manifest,
              target: appointment.target,
            });
            const candidate = this.sealCandidate(attempt, files.files);
            if (eligible) {
              this.store.transaction(() => {
                const proof = this.nativeArtifact({
                  version: 1,
                  attemptId: attempt.id,
                  planHash: binding.planArtifact.hash,
                  completionHash: this.nativeRecord(`native-completion:${attempt.id}`, 4096)
                    .artifact.hash,
                  metadataHash: this.nativeRecord(`native-proposal:${attempt.id}`).artifact.hash,
                  candidateId: candidate.id,
                  candidateHash: candidate.hash,
                  target: files.target,
                });
                this.store.saveReceipt(
                  `native-acp-capture:${attempt.id}`,
                  proof.hash,
                  'local-owner',
                  { outcome: 'applied', entity: proof },
                );
              });
              captured = true;
            }
          } catch {}
        }
        this.store.transaction(() => {
          const task = this.store.get<Task>('task', run.taskId) as Task;
          this.closePendingEffects(task);
          this.updateTask(task, {
            state: known ? (captured ? 'stopped' : 'interrupted') : 'unknown',
            waitingReason: null,
            next: captured
              ? 'Native work is retained. Checks and review remain pending.'
              : known
                ? 'Native work is unverified. Inspect retained changes.'
                : 'Native turn completion is unknown. Nothing will replay automatically.',
          });
        });
        if (known) this.workers.delete(attempt.id);
      } catch {
        try {
          this.settleJob(attempt, false, true);
        } catch {}
      } finally {
        completion.resolve();
      }
    };
    void (async () => {
      try {
        this.nativeCurrent(runtime);
        if (!binding.context || !binding.environment) throw Error('ACP context is unavailable.');
        if (!existsSync(intent.scratch_path))
          materialize(
            intent.scratch_path,
            committedFiles(this.projectPath(run.source.projectId) as string, run.source.base),
          );
        const directory = join(this.home, 'native', attempt.id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const context = await prepareOwnedContext({
          client: this.contextClient(),
          context: binding.context,
          home: this.home,
          scratch: intent.scratch_path,
          directory: join(directory, 'context'),
          expiresAt: appointment.expiresAt,
          now: () => Date.parse(this.now()),
          owner: {
            taskId: run.taskId,
            runId: run.id,
            attemptId: attempt.id,
            generation: attempt.generation,
            routeId: attempt.routeId,
            policyHash: run.policy.hash,
            profileId: 'google-acp-v1',
            selection: appointment.acp,
          },
        });
        this.nativeCurrent(runtime);
        const journal = this.nativeLifecycle(attempt, () => this.nativeCurrent(runtime));
        const phase = { sequence: 0, kind: 'google-acp-task' as const };
        const handle = startGoogleAcpWriter({
          client: appointment.client,
          directory,
          scratch: intent.scratch_path,
          environment: binding.environment,
          plan: googleAcpWriterPlan({
            attemptId: attempt.id,
            generation: attempt.generation,
            target: appointment.target,
            criteria: [
              binding.public?.context.title ?? '',
              binding.public?.context.outcome ?? '',
              ...(this.store.get<Task>('task', run.taskId) as Task).criteria,
            ],
            selection: appointment.acp,
            proof: appointment.proof,
            ...this.options.googleAcp,
          }),
          mcpServer: context.server,
          ...this.options.googleAcp,
          spawn: this.options.googleAcp?.spawn,
          schedule: this.options.schedule,
          timeoutMs: Math.min(
            appointment.maximumTaskMs,
            this.jobDeadline(attempt.id, appointment.maximumTaskMs / 60000),
            Date.parse(appointment.expiresAt) - Date.parse(this.now()),
          ),
          lifecycle: {
            beforePhase: () => journal.beforePhase(phase),
            owned: (group) => journal.owned(phase, group),
            quiescent: (group) => journal.quiescent(phase, group),
          },
          onSubmitted: () => {
            this.nativeCurrent(runtime);
            this.store.transaction(() => {
              this.nativeCurrent(runtime);
              const proof = this.nativeArtifact({
                attemptId: attempt.id,
                plan: binding.planArtifact.hash,
              });
              this.store.saveReceipt(
                `native-submission:${attempt.id}`,
                binding.planArtifact.hash,
                'local-owner',
                { outcome: 'outcome-unknown', entity: proof },
              );
            });
          },
          onPermission: (proposal) => this.requestAcpPermission(runtime, proposal),
          onActivity: (activity, text) => {
            if (
              runtime.stopped ||
              this.closed ||
              this.store.get<Task>('task', run.taskId)?.state === 'stopping'
            )
              return;
            this.nativeCurrent(runtime);
            this.store.transaction(() => {
              const task = this.store.get<Task>('task', run.taskId) as Task;
              this.event('attempt.output', task.id, task.revision, {
                attemptId: attempt.id,
                generation: attempt.generation,
                channel: 'acp',
                acp: activity,
                text,
              });
            });
          },
        });
        runtime.acpHandle = handle;
        runtime.handle = {
          stop: () => handle.stop(),
          result: handle.result.then((outcome) => ({
            ...outcome,
            metadata: outcome.metadata
              ? { ...outcome.metadata, family: 'google-acp' as const }
              : null,
            diagnostic: null,
          })),
        };
        if (runtime.stopped || this.closed) handle.stop();
        finish(await handle.result);
      } catch {
        finish(null, this.store.nativeProcesses(attempt.id).length === 0);
      }
    })();
  }

  private nativeArtifact(value: unknown): Artifact {
    const artifact = ArtifactSchema.parse({
      id: this.id('art'),
      ...this.artifacts.publish(Buffer.from(canonicalJson(value))),
      mediaType: 'application/vnd.crewkite.native+json',
    });
    this.saveArtifacts([artifact]);
    return artifact;
  }

  private nativeCurrent(runtime: NativeRuntime) {
    const { appointment, run, attempt } = runtime.binding;
    if ('acp' in appointment) {
      const setup = this.store.googleAcpSetup(),
        profile = this.acpResolution();
      const proof = this.store.get<Artifact>('artifact', appointment.acp.proofId);
      if (
        this.store.nativeProfileId(attempt.id) !== 'google-acp-v1' ||
        setup.state !== 'ready' ||
        setup.proofId !== appointment.acp.proofId ||
        proof?.hash !== appointment.proofHash ||
        !profile.facts.available ||
        hashCanonical(profile.client) !== hashCanonical(appointment.client) ||
        hashCanonical(this.acpProof(appointment.acp.proofId)) !== hashCanonical(appointment.proof)
      )
        throw Error('ACP runtime proof changed.');
    }
    if (runtime.binding.handoff) this.nativeManualAuthority(runtime.binding, true);
    const task = this.store.get<Task>('task', run.taskId);
    const current = this.store.get<Attempt>('attempt', attempt.id);
    const saved = this.store.get<Run>('run', run.id);
    if ('repository' in appointment) {
      const project = this.store.get<Project>('project', run.source.projectId);
      const tools = saved?.policy.policy.effects.find(
        (grant) =>
          grant.action === 'run-native-tools' &&
          grant.taskId === run.taskId &&
          grant.target === project?.name &&
          !grant.revoked &&
          grant.usesRemaining === 1 &&
          Date.parse(grant.expiresAt) > Date.parse(this.now()),
      );
      const consumed = tools && this.store.receipt(this.grantKey(tools));
      const intent = this.store.intents().find((row) => row.attempt_id === attempt.id);
      if (
        !saved ||
        !project ||
        !tools ||
        consumed?.hash !== hashCanonical(tools) ||
        (consumed.result.entity as Run | undefined)?.id !== run.id ||
        hashCanonical(saved.policy.policy) !== appointment.consent.policyHash ||
        !this.grant(saved, 'write-scratch', project.name) ||
        intent?.run_id !== run.id ||
        intent.task_id !== run.taskId ||
        intent.route_id !== attempt.routeId ||
        intent.generation !== attempt.generation
      )
        throw Error('The native repository grants are unavailable.');
    }
    const lease = this.store.db
      .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
      .get(run.taskId);
    if (
      this.closed ||
      (runtime.binding.public && !this.nativeConsentCurrent(runtime.binding)) ||
      runtime.stopped ||
      runtime.reason === 'stop' ||
      task?.runId !== run.id ||
      (task.state !== 'running' &&
        !('acp' in appointment && task.state === 'waiting' && task.waitingReason === 'approval')) ||
      !current ||
      !['intent', 'running'].includes(current.state) ||
      current.generation !== attempt.generation ||
      lease?.attempt_id !== attempt.id ||
      lease.generation !== attempt.generation ||
      saved?.policy.hash !== appointment.consent.policyHash ||
      hashCanonical(task.criteria) !== appointment.consent.criteriaHash ||
      Date.parse(appointment.expiresAt) <= Date.parse(this.now()) ||
      this.jobDeadline(attempt.id, appointment.maximumTaskMs / 60_000) === 0 ||
      hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(run.source)
    )
      throw new Error('The native appointment is no longer current.');
  }

  private nativeLifecycle(
    attempt: Attempt,
    current: () => void,
  ): {
    beforePhase: (phase: {
      sequence: number;
      kind: import('../store/index.ts').NativeProcess['phase'];
    }) => void;
    owned: (
      phase: { sequence: number; kind: import('../store/index.ts').NativeProcess['phase'] },
      group: number,
    ) => void;
    quiescent: (
      phase: { sequence: number; kind: import('../store/index.ts').NativeProcess['phase'] },
      group: number,
    ) => void;
  } {
    return {
      beforePhase: (phase) => {
        current();
        this.store.transaction(() =>
          this.store.intendNativePhase(attempt.id, phase.sequence, phase.kind, this.now()),
        );
      },
      owned: (phase, group) => {
        this.store.transaction(() => this.store.ownNativePhase(attempt.id, phase.sequence, group));
        if (phase.sequence === 0) this.acknowledgeJob(attempt, group);
        current();
      },
      quiescent: (phase, group) =>
        this.store.transaction(() =>
          this.store.finishNativePhase(attempt.id, phase.sequence, group, this.now()),
        ),
    };
  }

  private nativeWriterPlan(binding: Omit<NativeBinding, 'planArtifact'>) {
    const { appointment, attempt } = binding;
    const criteria = [
      ...(binding.public ? [binding.public.context.title, binding.public.context.outcome] : []),
      ...(this.store.get<Task>('task', binding.run.taskId) as Task).criteria,
    ];
    if ('acp' in appointment)
      return googleAcpWriterPlan({
        attemptId: attempt.id,
        generation: attempt.generation,
        target: appointment.target,
        criteria,
        selection: appointment.acp,
        proof: appointment.proof,
        ...this.options.googleAcp,
      });
    if ('repository' in appointment)
      return repositoryPlan({
        attemptId: attempt.id,
        model: appointment.route.model as WriterPlan['model'],
        effort: 'low',
        creditPolicy: appointment.creditPolicy,
        scratchPath: join(this.home, 'scratch', binding.run.id),
        sourceBase: appointment.repository.sourceBase,
        manifestHash: appointment.repository.manifestHash,
        execution: appointment.execution,
        context: {
          title: binding.public?.context.title ?? '',
          outcome: binding.public?.context.outcome ?? '',
          criteria: (this.store.get<Task>('task', binding.run.taskId) as Task).criteria,
        },
      });
    if (typeof binding.original !== 'string' || !binding.baseHash)
      throw Error('The file input is unavailable.');
    const fields = {
      attemptId: attempt.id,
      path: appointment.target.path,
      original: binding.original,
      baseHash: binding.baseHash,
      criteria,
      ...(binding.handoff ? { handoff: binding.handoff.preparation.packet } : {}),
    };
    if (appointment.route.family === 'google') {
      if (
        !appointment.billingAttestation ||
        !appointment.permissionMode ||
        appointment.creditPolicy !== 'ordinary' ||
        binding.anthropicSessionId
      )
        throw Error('The subscription writer binding is unavailable.');
      return googleWriterPlan({
        attemptId: attempt.id,
        file: { path: fields.path, baseHash: fields.baseHash, content: fields.original },
        task: JSON.stringify(criteria),
        ...(binding.handoff ? { handoff: binding.handoff.preparation.packet } : {}),
        model: appointment.route.model,
        effort: 'low',
      });
    }
    if (appointment.route.family === 'anthropic') {
      if (
        !binding.anthropicSessionId ||
        !appointment.billingAttestation ||
        appointment.creditPolicy !== 'ordinary'
      )
        throw Error('The subscription writer binding is unavailable.');
      return anthropicReplacementPlan({
        ...fields,
        sessionId: binding.anthropicSessionId,
        model: appointment.route.model,
        effort: 'medium',
      });
    }
    if (binding.anthropicSessionId || appointment.billingAttestation)
      throw Error('The writer family binding changed.');
    return replacementPlan({
      ...fields,
      model: appointment.route.model as WriterPlan['model'],
      effort: appointment.route.effort.requested as WriterPlan['effort'],
      creditPolicy: appointment.creditPolicy,
      directory: join(this.home, 'native', attempt.id),
    });
  }

  private launchAnthropic(
    runtime: NativeRuntime,
    directory: string,
    timeoutMs: number,
    onSubmitted: () => void,
  ): NonNullable<NativeRuntime['handle']> {
    const { binding } = runtime;
    const { appointment, attempt } = binding;
    if (!('target' in appointment)) throw Error('The file writer binding changed.');
    const deadline = performance.now() + timeoutMs;
    let active: { stop: () => void } | undefined;
    let quiescent = false;
    const journal = this.nativeLifecycle(attempt, () => this.nativeCurrent(runtime));
    const phase = (kind: 'auth-status' | 'task') =>
      kind === 'auth-status'
        ? { sequence: 0 as const, kind: 'auth-status' as const }
        : { sequence: 1 as const, kind: 'native-task' as const };
    const lifecycle: AnthropicLifecycle = {
      beforePhase: (kind) => journal.beforePhase(phase(kind)),
      owned: (kind, group) => journal.owned(phase(kind), group),
      quiescent: (kind, group) => journal.quiescent(phase(kind), group),
    };
    const launch = {
      ...appointment.client,
      repositoryRoot: this.home,
      environment: binding.environment ?? process.env,
    };
    const result = (async (): Promise<NativeOutcome> => {
      try {
        const authDirectory = join(directory, 'auth');
        mkdirSync(authDirectory, { mode: 0o700 });
        const auth = startNativeAuthStatus(
          { ...launch, directory: authDirectory },
          {
            deadline,
            schedule: this.options.schedule,
            spawn: this.options.nativeSpawn,
            lifecycle,
          },
        );
        active = auth;
        if (runtime.stopped || this.closed) active.stop();
        const observed = await auth.result;
        active = undefined;
        quiescent = observed.quiescent;
        let authHash = '';
        this.store.transaction(() => {
          const artifact = this.nativeArtifact({
            attemptId: attempt.id,
            clientHash: appointment.client.sha256,
            billingAttestationHash: hashCanonical(appointment.billingAttestation),
            ...observed,
          });
          authHash = artifact.hash;
          this.store.saveReceipt(`native-auth:${attempt.id}`, artifact.hash, 'local-owner', {
            outcome: 'applied',
            entity: artifact,
          });
        });
        if (observed.reason || !observed.quiescent || !subscriptionAuth(observed.metadata))
          return {
            metadata: null,
            reason: observed.reason ?? 'authentication',
            quiescent,
            diagnostic: null,
          };
        this.nativeCurrent(runtime);
        const taskDirectory = join(directory, 'task');
        mkdirSync(taskDirectory, { mode: 0o700 });
        const plan = this.nativeWriterPlan(binding) as ReturnType<typeof anthropicReplacementPlan>;
        const writer = startAnthropicReplacement(
          { ...launch, directory: taskDirectory, plan },
          {
            deadline,
            schedule: this.options.schedule,
            spawn: this.options.nativeSpawn as typeof import('node:child_process').spawn,
            lifecycle,
            onSubmitted,
          },
        );
        active = writer;
        quiescent = false;
        if (runtime.stopped || this.closed) active.stop();
        const outcome = await writer.result;
        active = undefined;
        return {
          metadata: outcome.proposal
            ? {
                ...outcome.proposal,
                family: 'anthropic',
                sessionId: plan.sessionId,
                model: plan.model,
                requestedEffort: 'medium',
                effectiveEffort: 'unknown',
                authHash,
                billingAttestation: NativeBillingAttestationSchema.parse(
                  appointment.billingAttestation,
                ),
              }
            : null,
          reason: outcome.reason,
          quiescent: outcome.quiescent,
          diagnostic: outcome.diagnostic,
        };
      } catch {
        return { metadata: null, reason: 'launch', quiescent, diagnostic: null };
      }
    })();
    return { result, stop: () => active?.stop() };
  }

  private launchGoogle(
    runtime: NativeRuntime,
    directory: string,
    timeoutMs: number,
    onSubmitted: () => void,
  ): NonNullable<NativeRuntime['handle']> {
    const { binding } = runtime;
    const { appointment, attempt } = binding;
    if (!('target' in appointment)) throw Error('The file writer binding changed.');
    const deadline = performance.now() + timeoutMs;
    let active: { stop: () => void } | undefined;
    let quiescent = false;
    const journal = this.nativeLifecycle(attempt, () => this.nativeCurrent(runtime));
    const phase = (kind: 'config' | 'task') =>
      kind === 'config'
        ? { sequence: 0, kind: 'google-config' as const }
        : { sequence: 1, kind: 'native-task' as const };
    const lifecycle: GoogleNativeLifecycle = {
      beforePhase: (kind) => journal.beforePhase(phase(kind)),
      owned: (kind, group) => journal.owned(phase(kind), group),
      quiescent: (kind, group) => journal.quiescent(phase(kind), group),
    };
    const result = (async (): Promise<NativeOutcome> => {
      try {
        if (!appointment.permissionMode || !appointment.billingAttestation || !binding.public)
          throw Error();
        const locationHash = binding.public.locationHash;
        const temporaryDirectory = join(directory, 'temporary');
        const configDirectory = join(directory, 'config');
        mkdirSync(temporaryDirectory, { mode: 0o700 });
        mkdirSync(configDirectory, { mode: 0o700 });
        const launch = {
          client: appointment.client,
          repositoryRoot: this.home,
          temporaryDirectory,
          environment: binding.environment ?? process.env,
          timeoutMs,
          deadline,
          schedule: this.options.schedule,
          spawn: this.options.nativeSpawn as typeof import('node:child_process').spawn,
          lifecycle,
        };
        const config = startGoogleConfig({
          ...launch,
          directory: configDirectory,
          timeoutMs: Math.min(timeoutMs, 20000),
        });
        active = config;
        if (runtime.stopped || this.closed) active.stop();
        const observed = await config.result;
        active = undefined;
        quiescent = observed.quiescent;
        let configHash = '';
        this.store.transaction(() => {
          const artifact = this.nativeArtifact({
            attemptId: attempt.id,
            clientHash: appointment.client.sha256,
            locationHash,
            billingAttestationHash: hashCanonical(appointment.billingAttestation),
            ...observed,
          });
          configHash = artifact.hash;
          this.store.saveReceipt(`native-config:${attempt.id}`, artifact.hash, 'local-owner', {
            outcome: 'applied',
            entity: artifact,
          });
        });
        if (
          observed.reason ||
          !observed.quiescent ||
          !observed.metadata ||
          observed.metadata.permissionMode !== appointment.permissionMode
        )
          return {
            metadata: null,
            reason: observed.reason ?? 'configuration',
            quiescent,
            diagnostic: null,
          };
        this.nativeCurrent(runtime);
        const taskDirectory = join(directory, 'task');
        mkdirSync(taskDirectory, { mode: 0o700 });
        const plan = this.nativeWriterPlan(binding) as ReturnType<typeof googleWriterPlan>;
        const writer = startGoogleWriter({
          ...launch,
          directory: taskDirectory,
          attemptId: attempt.id,
          file: plan.file,
          task: plan.task,
          ...(binding.handoff ? { handoff: binding.handoff.preparation.packet } : {}),
          onSubmitted,
          admission: {
            clientExecutable: appointment.client.executable,
            clientVersion: appointment.client.version,
            clientSha256: appointment.client.sha256,
            checkedAt: this.now(),
            nativeTrust: 'accepted',
            permissions: appointment.permissionMode,
            billing: 'subscription-only',
            extraCredits: 'disabled',
            evidence: {
              nativePermissions: configHash,
              subscriptionBilling: hashCanonical(appointment.billingAttestation),
              paidCreditsDisabled: configHash,
            },
            model: appointment.route.model,
            effort: 'low',
          },
        });
        active = writer;
        quiescent = false;
        if (runtime.stopped || this.closed) active.stop();
        const outcome = await writer.result;
        active = undefined;
        return {
          metadata: outcome.metadata
            ? {
                ...outcome.metadata,
                family: 'google',
                model: appointment.route.model,
                requestedEffort: 'low',
                effectiveEffort: 'unknown',
                permissionMode: appointment.permissionMode,
                configHash,
                billingAttestation: appointment.billingAttestation,
                qualified: false,
              }
            : null,
          reason: outcome.reason,
          quiescent: outcome.quiescent,
          diagnostic: outcome.diagnostic,
        };
      } catch {
        return { metadata: null, reason: 'launch', quiescent, diagnostic: null };
      }
    })();
    return { result, stop: () => active?.stop() };
  }

  private launchNative(intent: LaunchIntent, binding: NativeBinding) {
    if ('acp' in binding.appointment) {
      this.launchAcpNative(intent, binding);
      return;
    }
    if (this.closed) return;
    const runtime: NativeRuntime = { kind: 'native', binding, stopped: false };
    const completion = Promise.withResolvers<void>();
    runtime.done = completion.promise;
    this.workers.set(binding.attempt.id, runtime);
    const { appointment, run, attempt } = binding;
    const finish = (outcome: NativeOutcome | null) => {
      try {
        let applied = false;
        let repositoryCompleted = false;
        const phases = this.store.nativeProcesses(attempt.id);
        const quiescent =
          outcome?.quiescent === true &&
          phases.length > 0 &&
          phases.every((phase) => phase.state === 'quiescent');
        try {
          this.store.transaction(() => {
            const artifact = this.nativeArtifact({
              attemptId: attempt.id,
              reason: outcome ? outcome.reason : 'launch',
              quiescent,
              diagnostic: outcome?.diagnostic ?? null,
            });
            this.store.saveReceipt(
              `native-completion:${attempt.id}`,
              artifact.hash,
              'local-owner',
              {
                outcome: 'applied',
                entity: artifact,
              },
            );
            if (outcome?.metadata) {
              const proposal = this.nativeArtifact(outcome.metadata);
              this.store.saveReceipt(
                `native-proposal:${attempt.id}`,
                proposal.hash,
                'local-owner',
                {
                  outcome: 'applied',
                  entity: proposal,
                },
              );
            }
          });
          if (
            quiescent &&
            this.store.nativePhasesComplete(attempt.id, appointment.route.family) &&
            outcome?.metadata &&
            !outcome.reason
          ) {
            this.nativeCurrent(runtime);
            if ('repository' in appointment) {
              this.repositoryResult(appointment, attempt.id, outcome.metadata);
              repositoryCompleted = true;
            } else {
              this.store.transaction(() => {
                this.nativeCurrent(runtime);
                const artifact = this.nativeArtifact({
                  attemptId: attempt.id,
                  proposalHash: hashCanonical(outcome.metadata),
                  manifest: binding.manifest,
                });
                this.store.saveReceipt(
                  `native-application:${attempt.id}`,
                  artifact.hash,
                  'local-owner',
                  { outcome: 'outcome-unknown', entity: artifact },
                );
              });
              this.nativeCurrent(runtime);
              if (!('replacement' in outcome.metadata))
                throw Error('The file replacement is unavailable.');
              applyReplacement(intent.scratch_path, binding.manifest, outcome.metadata.replacement);
              this.store.transaction(() =>
                this.store.db.prepare('UPDATE receipts SET result=? WHERE command_key=?').run(
                  canonicalJson({
                    outcome: 'applied',
                    entity: this.store.receipt(`native-application:${attempt.id}`)?.result.entity,
                  }),
                  `native-application:${attempt.id}`,
                ),
              );
              applied = true;
            }
          }
        } catch {
          // A committed intent can outlive an interrupted write. Recovery never reapplies it.
        }
        try {
          if (this.settleJob(attempt, quiescent, true)) {
            if ('repository' in appointment) {
              let captured = false,
                captureFailed = false;
              try {
                const candidate = this.sealCandidate(attempt);
                if (repositoryCompleted) {
                  this.store.transaction(() => {
                    const artifact = this.nativeArtifact({
                      version: 1,
                      attemptId: attempt.id,
                      planHash: binding.planArtifact.hash,
                      completionHash: this.nativeRecord(`native-completion:${attempt.id}`, 4096)
                        .artifact.hash,
                      metadataHash: this.nativeRecord(`native-proposal:${attempt.id}`).artifact
                        .hash,
                      candidateId: candidate.id,
                      candidateHash: candidate.hash,
                      repository: appointment.repository,
                      execution: appointment.execution,
                    });
                    this.store.saveReceipt(
                      `native-capture:${attempt.id}`,
                      artifact.hash,
                      'local-owner',
                      { outcome: 'applied', entity: artifact },
                    );
                  });
                  captured = true;
                }
              } catch {
                captureFailed = true;
                try {
                  this.store.transaction(() => {
                    const artifact = this.nativeArtifact({
                      attemptId: attempt.id,
                      reason: 'capture-unavailable',
                    });
                    this.store.saveReceipt(
                      `native-capture-failure:${attempt.id}`,
                      artifact.hash,
                      'local-owner',
                      { outcome: 'applied', entity: artifact },
                    );
                  });
                } catch {}
              }
              this.store.transaction(() => {
                const task = this.store.get<Task>('task', run.taskId) as Task;
                this.closePendingEffects(task);
                this.updateTask(task, {
                  state: captured ? 'stopped' : 'interrupted',
                  waitingReason: null,
                  next: captured
                    ? 'Native work is retained. Checks and review remain pending.'
                    : captureFailed
                      ? 'Native capture failed. Inspect retained scratch; checks and acceptance are unavailable.'
                      : 'Native work is unverified. Inspect retained changes and export.',
                });
              });
            } else {
              this.store.transaction(() => {
                const task = this.store.get<Task>('task', run.taskId) as Task;
                this.closePendingEffects(task);
                this.updateTask(task, {
                  state: applied ? 'stopped' : 'interrupted',
                  waitingReason: null,
                  next: applied
                    ? 'Native work is retained. Checks and review remain pending.'
                    : 'Native work is unverified. Inspect retained ownership and artifacts.',
                });
              });
              this.sealCandidate(attempt);
            }
          }
        } catch {
          // Preserve the journal and bytes when capture cannot finish.
        } finally {
          if (quiescent) this.workers.delete(attempt.id);
        }
      } catch {
        // Unreadable ownership cannot release a lease or justify application.
        try {
          this.settleJob(attempt, false, true);
        } catch {}
      } finally {
        completion.resolve();
      }
    };
    try {
      this.options.afterIntent?.(intent);
      this.nativeCurrent(runtime);
      if (!existsSync(intent.scratch_path))
        materialize(
          intent.scratch_path,
          binding.handoff
            ? this.evidence.read(binding.handoff.preparation.candidate).files
            : committedFiles(this.projectPath(run.source.projectId) as string, run.source.base),
        );
      const directory = join(this.home, 'native', attempt.id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const plan = this.nativeWriterPlan(binding);
      const timeoutMs = Math.min(
        appointment.maximumTaskMs,
        this.jobDeadline(attempt.id, appointment.maximumTaskMs / 60_000),
        Date.parse(appointment.expiresAt) - Date.parse(this.now()),
      );
      const onSubmitted = () => {
        this.nativeCurrent(runtime);
        this.store.transaction(() => {
          this.nativeCurrent(runtime);
          const artifact = this.nativeArtifact({
            attemptId: attempt.id,
            plan: binding.planArtifact.hash,
          });
          this.store.saveReceipt(
            `native-submission:${attempt.id}`,
            binding.planArtifact.hash,
            'local-owner',
            { outcome: 'outcome-unknown', entity: artifact },
          );
        });
      };
      if (appointment.route.family === 'google') {
        runtime.handle = this.launchGoogle(runtime, directory, timeoutMs, onSubmitted);
      } else if (appointment.route.family === 'anthropic') {
        runtime.handle = this.launchAnthropic(runtime, directory, timeoutMs, onSubmitted);
      } else {
        const launch = {
          ...appointment.client,
          directory,
          repositoryRoot: this.home,
          environment: binding.environment ?? process.env,
        };
        const options = {
          timeoutMs,
          schedule: this.options.schedule,
          spawn: this.options.nativeSpawn,
          onSubmitted,
          lifecycle: this.nativeLifecycle(attempt, () => this.nativeCurrent(runtime)),
        };
        runtime.handle =
          'repository' in appointment
            ? startRepository(launch, plan as ReturnType<typeof repositoryPlan>, {
                ...options,
                onActivity: (activity) => {
                  const task = this.store.get<Task>('task', run.taskId),
                    current = this.store.get<Attempt>('attempt', attempt.id),
                    saved = this.store.get<Run>('run', run.id);
                  const lease = this.store.db
                    .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
                    .get(run.taskId);
                  const phase = this.store.db
                    .prepare(
                      'SELECT phase,state FROM native_processes WHERE attempt_id=? ORDER BY sequence DESC LIMIT 1',
                    )
                    .get(attempt.id);
                  if (
                    phase?.phase !== 'app-server-task' ||
                    phase.state !== 'owned' ||
                    this.closed ||
                    runtime.stopped ||
                    this.workers.get(attempt.id) !== runtime ||
                    task?.runId !== run.id ||
                    task.state !== 'running' ||
                    current?.generation !== attempt.generation ||
                    current.routeId !== attempt.routeId ||
                    !['intent', 'running'].includes(current.state) ||
                    saved?.policy.hash !== run.policy.hash ||
                    lease?.attempt_id !== attempt.id ||
                    lease.generation !== attempt.generation
                  )
                    return;
                  const paths = ('paths' in activity ? activity.paths : [])
                    .slice(0, 8)
                    .map((path) => JSON.stringify(path))
                    .join(', ');
                  const text = `Native ${activity.kind === 'command' ? 'command' : 'file changes'} ${activity.state}${paths ? `: ${paths}` : ''}.`;
                  this.store.transaction(() =>
                    this.event('attempt.output', task.id, task.revision, {
                      attemptId: attempt.id,
                      generation: attempt.generation,
                      channel: 'stdout',
                      text,
                    }),
                  );
                },
              })
            : startReplacement(launch, plan as WriterPlan, options);
      }
      const handle = runtime.handle;
      if (!handle) throw Error('The native writer owner is unavailable.');
      if (runtime.stopped || this.closed) handle.stop();
      void handle.result.then(finish, () => finish(null));
    } catch {
      finish(null);
    }
  }

  private hasUncertainWriter(taskId: string): boolean {
    return this.store
      .intents()
      .some((intent) => intent.task_id === taskId && intent.state !== 'stopped');
  }

  private grant(
    run: Pick<Run, 'id' | 'taskId' | 'policy'>,
    action: Grant['action'],
    target: string,
  ): Grant | undefined {
    return run.policy.policy.effects.find(
      (grant) =>
        grant.taskId === run.taskId &&
        grant.action === action &&
        grant.target === target &&
        !grant.revoked &&
        grant.usesRemaining === 1 &&
        Date.parse(grant.expiresAt) > Date.parse(this.now()) &&
        (!this.store.receipt(this.grantKey(grant)) ||
          (action === 'write-scratch' &&
            (this.store.receipt(this.grantKey(grant))?.result.entity as Run | undefined)?.id ===
              run.id)),
    );
  }
  private grantKey(grant: Grant): string {
    return `grant:${hashCanonical({ taskId: grant.taskId, action: grant.action, target: grant.target, expiresAt: grant.expiresAt })}`;
  }
  private consumeGrant(run: Run, grant: Grant) {
    const key = this.grantKey(grant);
    if (!this.store.receipt(key))
      this.store.saveReceipt(key, hashCanonical(grant), 'local-owner', {
        outcome: 'applied',
        entity: run,
      });
  }

  private requestAction(
    task: Task,
    _run: Run,
    attempt: Attempt,
    action: Grant['action'],
    target: string,
    request: unknown,
    acpProposal?: AcpPermissionProposal,
  ): CommandResult {
    const existing = this.store.db
      .prepare(
        "SELECT approval_id FROM pending_effects WHERE task_id=? AND state='pending' LIMIT 1",
      )
      .get(task.id);
    if (existing) {
      const pending = this.store.get<Approval>('approval', existing.approval_id as string);
      if (
        pending?.attemptId === attempt.id &&
        pending.action === action &&
        pending.target === target &&
        hashCanonical(pending.acpTarget ?? null) === hashCanonical(acpProposal?.acpTarget ?? null)
      )
        return { outcome: 'already-applied', entity: this.store.get<Task>('task', task.id) };
      return {
        outcome: 'blocked',
        reason: 'approval-already-pending',
        next: 'Resolve the current exact action first.',
      };
    }
    const boundRequest = {
      ...(request as Record<string, unknown>),
      previousStatus: { state: task.state, waitingReason: task.waitingReason, next: task.next },
    };
    const approval = ApprovalSchema.parse({
      approvalId: this.id('apr'),
      taskId: task.id,
      attemptId: attempt.id,
      generation: attempt.generation,
      action,
      target,
      ...(acpProposal ? { acpTarget: acpProposal.acpTarget } : {}),
      revision: 0,
      requester: 'Controller',
      consequence: acpProposal?.consequence ?? `Permit one ${action} action for this attempt.`,
      status: 'pending',
    });
    const updated = this.updateTask(task, {
      state: 'waiting',
      waitingReason: 'approval',
      next: 'Review the exact pending action.',
    });
    this.store.put('approval', approval.approvalId, approval.revision, approval);
    this.store.db
      .prepare(
        "INSERT INTO pending_effects(approval_id,task_id,attempt_id,task_revision,effect_hash,request,state) VALUES (?,?,?,?,?,?,'pending')",
      )
      .run(
        approval.approvalId,
        task.id,
        attempt.id,
        updated.revision,
        hashCanonical(boundRequest),
        canonicalJson(boundRequest),
      );
    this.event('approval.requested', task.id, updated.revision, approval);
    return { outcome: 'applied', entity: updated, revision: updated.revision };
  }

  private updateTask(task: Task, change: Partial<Task>): Task {
    const updated = TaskSchema.parse({
      ...task,
      ...change,
      id: task.id,
      revision: task.revision + 1,
    });
    this.store.put('task', task.id, updated.revision, updated);
    this.event('task.updated', task.id, updated.revision, updated);
    return updated;
  }
  private launch(intent: LaunchIntent, run: Run, attempt: Attempt) {
    let worker: OwnedWorker;
    try {
      const reserved = this.store.db
        .prepare('SELECT MAX(minutes) AS minutes FROM reservations WHERE attempt_id=?')
        .get(attempt.id)?.minutes as number;
      if (this.jobDeadline(attempt.id, reserved) === 0) {
        this.settleJob(attempt, true);
        this.stoppedJob(attempt);
        return;
      }
      const context = attempt.generation > 0 ? this.latestContext(run.id) : undefined;
      if (attempt.generation > 0) {
        if (
          !context ||
          !verifyHandoff(context) ||
          context.packet.runId !== run.id ||
          context.packet.taskId !== run.taskId ||
          context.packet.generation + 1 !== attempt.generation ||
          hashCanonical(context.packet.source) !== hashCanonical(run.source) ||
          hashCanonical(context.packet.policy) !== hashCanonical(run.policy) ||
          !context.packet.allowedRouteIds.includes(attempt.routeId) ||
          !context.packet.candidate
        )
          throw new Error('The successor context does not match this admitted run.');
        const candidate = context.packet.candidate;
        const files = this.evidence.read(candidate).files;
        if (!existsSync(intent.scratch_path)) materialize(intent.scratch_path, files);
        if (this.evidence.hash(run.source.base, readFiles(intent.scratch_path)) !== candidate.hash)
          throw new Error('Retained bytes changed after context sealing.');
      } else if (!existsSync(intent.scratch_path))
        materialize(
          intent.scratch_path,
          committedFiles(this.projectPath(run.source.projectId) as string, run.source.base),
        );
      if (this.jobDeadline(attempt.id, reserved) === 0) {
        this.settleJob(attempt, true);
        this.stoppedJob(attempt);
        return;
      }
      const route = this.store.get<Route>('route', attempt.routeId) as Route;
      worker = new OwnedWorker({
        workerPath: this.options.workerPath ?? fakeWorkerPath,
        start: {
          type: 'start',
          attemptId: attempt.id,
          generation: attempt.generation,
          scratchPath: intent.scratch_path,
          scenario: this.options.scenarioForRoute?.(route, attempt.generation) ?? 'complete',
          outcome: this.store.get<Task>('task', run.taskId)?.outcome ?? 'Complete the saved task.',
          ...(context ? { handoff: SealedHandoffPacketSchema.parse(context) } : {}),
        },
        environmentHome: join(this.home, 'environment', run.id),
        routeId: route.id,
        observedAt: this.now(),
        onSpawn: (pid) =>
          this.store.transaction(() => {
            this.store.db
              .prepare('UPDATE launch_intents SET pid=?,process_group=? WHERE attempt_id=?')
              .run(pid, pid, attempt.id);
          }),
        onEvent: (event) => this.workerEvent(attempt.id, event),
        onFailure: (reason) => this.workerFailure(attempt.id, reason),
      });
      this.workers.set(attempt.id, { kind: 'fake', worker });
      const deadline = this.jobDeadline(attempt.id, reserved);
      const runtime = this.workers.get(attempt.id) as NonNullable<
        ReturnType<typeof this.workers.get>
      > &
        FakeRuntime;
      runtime.cancel = (this.options.schedule ?? defaultSchedule)(() => {
        if (this.closed) return;
        runtime.failure = 'The run minute limit was reached.';
        void worker
          .stop({ schedule: this.options.schedule })
          .then((exit) => this.finishAttempt(attempt.id, exit.quiescent));
      }, deadline);

      void worker.exited
        .then(async (exit) => {
          const quiescent =
            exit.quiescent && (await closedWithin(worker.closed, this.options.schedule));
          this.finishAttempt(attempt.id, quiescent);
        })
        .catch(() => this.workerFailure(attempt.id, 'Worker completion could not be recorded.'));
    } catch (error) {
      this.store.transaction(() => {
        const current = this.store.get<Attempt>('attempt', attempt.id) as Attempt;
        const task = this.store.get<Task>('task', run.taskId) as Task;
        const known = this.store.intents().find((value) => value.attempt_id === attempt.id);
        if (known?.pid) {
          this.store.put('attempt', attempt.id, current.revision + 1, {
            ...current,
            state: 'unknown',
            revision: current.revision + 1,
          });
          this.updateTask(task, {
            state: 'unknown',
            waitingReason: null,
            next: 'A launched process lacks complete ownership evidence.',
          });
        } else {
          this.store.db
            .prepare("UPDATE launch_intents SET state='stopped' WHERE attempt_id=?")
            .run(attempt.id);
          this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
          this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
          this.store.put('attempt', attempt.id, current.revision + 1, {
            ...current,
            state: 'failed',
            revision: current.revision + 1,
          });
          this.updateTask(task, {
            state: 'failed',
            waitingReason: null,
            next: error instanceof Error ? error.message : 'The scratch copy could not launch.',
          });
        }
      });
    }
  }

  private workerEvent(attemptId: string, event: FakeWorkerEvent) {
    const runtime = this.workers.get(attemptId);
    if (runtime?.kind !== 'fake' || this.closed) return;
    const attempt = this.store.get<Attempt>('attempt', attemptId);
    if (!attempt || attempt.state === 'unknown' || attempt.state === 'stopped') return;
    const run = this.store.get<Run>('run', attempt.runId) as Run;
    if (
      event.type === 'approval' &&
      (event.action !== 'run-check' || event.target !== 'node --test')
    ) {
      this.workerFailure(attemptId, 'The worker requested an unsupported effect.');
      return;
    }
    if (event.type !== 'ready' && attempt.state === 'intent') {
      this.workerFailure(attemptId, 'Worker output arrived before its identity acknowledgment.');
      return;
    }
    if (event.type === 'terminal') {
      runtime.terminal = event;
      return;
    }
    if (event.type === 'review') {
      this.workerFailure(attemptId, 'A coding worker returned an unrelated review job.');
      return;
    }
    this.store.transaction(() => {
      const task = this.store.get<Task>('task', run.taskId) as Task;
      if (event.type === 'ready') {
        if (event.attemptId !== attempt.id || event.generation !== attempt.generation)
          throw new Error('Worker identity does not match its stream.');
        const updated = { ...attempt, state: 'running' as const, revision: attempt.revision + 1 };
        this.store.put('attempt', attempt.id, updated.revision, updated);
        this.store.db
          .prepare("UPDATE launch_intents SET state='acknowledged' WHERE attempt_id=?")
          .run(attempt.id);
        this.event('attempt.launched', task.id, task.revision, updated);
      } else if (event.type === 'output')
        this.event('attempt.output', task.id, task.revision, {
          attemptId,
          generation: attempt.generation,
          channel: event.channel,
          text: event.text,
        });
      else if (event.type === 'approval')
        this.requestAction(task, run, attempt, event.action, event.target, {
          kind: 'worker',
          attemptId,
          action: event.action,
          target: event.target,
        });
      else if (event.type === 'usage') {
        if (event.observation.routeId !== attempt.routeId || event.observation.source !== 'fixture')
          throw new Error('Worker usage does not match its route.');
        this.store.put(
          'window',
          `${event.observation.routeId}/${event.observation.windowId}`,
          0,
          event.observation,
        );
        this.event('usage.observed', task.id, task.revision, event.observation);
        const reserve = run.policy.policy.reserves.find(
          (value) =>
            value.routeId === attempt.routeId &&
            value.windowId === event.observation.windowId &&
            value.unit === event.observation.remaining?.unit,
        );
        if (
          reserve &&
          event.observation.remaining &&
          event.observation.remaining.value <= reserve.value
        ) {
          runtime.reason = 'handoff';
          const updated = this.updateTask(task, {
            state: 'handing_off',
            waitingReason: null,
            next: 'Stopping at the reserve before safe transfer.',
          });
          this.event('route.reserve_reached', task.id, updated.revision, {
            routeId: attempt.routeId,
            windowId: reserve.windowId,
            reason: 'The configured reserve was reached.',
          });
          this.event('admissions.paused', task.id, updated.revision, {
            runId: run.id,
            reason: 'Route reserve reached.',
          });
        }
      }
    });
    if (event.type === 'approval' && this.grant(run, 'run-check', 'node --test')) {
      const approval = this.store
        .list<Approval>('approval')
        .find(
          (value) =>
            value.attemptId === attempt.id &&
            value.status === 'pending' &&
            value.action === event.action &&
            value.target === event.target,
        );
      if (approval) {
        const effects: (() => void)[] = [];
        this.store.transaction(() => {
          const task = this.store.get<Task>('task', run.taskId) as Task;
          const binding = ApprovalBindingSchema.parse({
            approvalId: approval.approvalId,
            taskId: approval.taskId,
            attemptId: approval.attemptId,
            generation: approval.generation,
            action: approval.action,
            target: approval.target,
            revision: approval.revision,
          });
          const command = CommandSchema.parse({
            protocol: 1,
            key: this.id('cmd'),
            actor: { id: 'controller', kind: 'controller' },
            command: 'ResolveApproval',
            expectedRevision: task.revision,
            payload: { binding, decision: 'approved' },
          });
          this.resolve(command as Extract<Command, { command: 'ResolveApproval' }>, effects);
        });
        for (const effect of effects) effect();
      }
    }
    if (event.type === 'usage' && runtime.reason === 'handoff')
      runtime.worker.send({ type: 'checkpoint' });
  }

  private workerFailure(attemptId: string, reason: string) {
    const runtime = this.workers.get(attemptId);
    if (runtime?.kind !== 'fake' || this.closed) return;
    runtime.failure = reason;
    runtime.worker.child.stdin.end();
  }

  private finishAttempt(attemptId: string, quiescent: boolean) {
    if (this.closed) return;
    const runtime = this.workers.get(attemptId);
    const attempt = this.store.get<Attempt>('attempt', attemptId);
    if (
      this.closed ||
      !runtime ||
      runtime.kind !== 'fake' ||
      !attempt ||
      attempt.state === 'stopped' ||
      (attempt.state === 'unknown' && !quiescent) ||
      attempt.state === 'failed'
    )
      return;
    this.store.transaction(() => {
      const run = this.store.get<Run>('run', attempt.runId) as Run;
      const task = this.store.get<Task>('task', run.taskId) as Task;
      const updated = {
        ...attempt,
        state: quiescent ? ('stopped' as const) : ('unknown' as const),
        revision: attempt.revision + 1,
      };
      this.store.put('attempt', attempt.id, updated.revision, updated);
      if (!quiescent) {
        this.event('ownership.unknown', task.id, task.revision, updated);
        this.updateTask(task, {
          state: 'unknown',
          waitingReason: null,
          next: 'The process group remains. Sealing and transfer are blocked.',
        });
        return;
      }
      this.store.db
        .prepare("UPDATE launch_intents SET state='stopped',finished_at=? WHERE attempt_id=?")
        .run(this.now(), attempt.id);
      this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
      this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
      this.closePendingEffects(
        task,
        !!runtime.failure ||
          !runtime.terminal ||
          runtime.terminal.outcome === 'failed' ||
          runtime.reason === 'stop' ||
          runtime.reason === 'switch',
      );
      this.event('attempt.stopped', task.id, task.revision, updated);
      const failed = runtime.failure || !runtime.terminal || runtime.terminal.outcome === 'failed';
      this.updateTask(task, {
        state: failed ? 'interrupted' : 'stopped',
        waitingReason: null,
        next: failed
          ? 'Retained work is unverified. Resume explicitly.'
          : 'Retained work is stopped. Candidate checks are pending.',
      });
    });
    runtime.cancel?.();
    if (quiescent) this.workers.delete(attemptId);
    if (quiescent) {
      try {
        const candidate = this.sealCandidate(attempt);
        if (runtime.reason === 'switch') {
          this.continueSwitch(attempt);
          return;
        }
        if (
          runtime.terminal &&
          runtime.terminal.outcome !== 'failed' &&
          !runtime.failure &&
          runtime.reason !== 'stop' &&
          !this.store.receipt(`paused:${attempt.runId}`)
        )
          this.checkCandidate(attempt, candidate, runtime.reason === 'handoff');
      } catch {
        this.store.transaction(() => {
          const run = this.store.get<Run>('run', attempt.runId) as Run;
          const task = this.store.get<Task>('task', run.taskId) as Task;
          this.updateTask(task, {
            state: 'failed',
            waitingReason: null,
            next: 'Candidate capture or checks could not complete. Retained work is unverified.',
          });
        });
      }
    }
  }

  private closePendingEffects(
    task: Task,
    includeApproved = true,
  ): Pick<Task, 'state' | 'waitingReason' | 'next'> | undefined {
    let restore: Pick<Task, 'state' | 'waitingReason' | 'next'> | undefined;
    for (const row of this.store.db
      .prepare(
        "SELECT approval_id,attempt_id,request FROM pending_effects WHERE task_id=? AND (state='pending' OR (?=1 AND state='approved'))",
      )
      .all(task.id, includeApproved ? 1 : 0)) {
      const request = JSON.parse(row.request as string) as {
        kind: string;
        previousStatus?: Pick<Task, 'state' | 'waitingReason' | 'next'>;
      };
      if ((request.kind === 'accept' || request.kind === 'export') && request.previousStatus)
        restore = request.previousStatus;
      this.store.db
        .prepare("UPDATE pending_effects SET state='denied' WHERE approval_id=?")
        .run(row.approval_id as string);
      const approval = this.store.get<Approval>('approval', row.approval_id as string);
      if (approval) {
        const closed = {
          ...approval,
          status: 'denied' as const,
          revision: approval.revision + 1,
          consequence: 'This unused action was closed when the run stopped.',
        };
        this.store.put('approval', closed.approvalId, closed.revision, closed);
        this.event('approval.resolved', task.id, task.revision, closed);
      }
      const attempt = this.store.get<Attempt>('attempt', row.attempt_id as string);
      if (attempt && !this.store.intents().some((intent) => intent.attempt_id === attempt.id))
        this.store.put('attempt', attempt.id, attempt.revision + 1, {
          ...attempt,
          state: 'stopped',
          revision: attempt.revision + 1,
        });
    }
    return restore;
  }

  private stop(
    command: Extract<Command, { command: 'StopRun' }>,
    effects: (() => void)[],
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId);
    if (!task || task.runId !== command.payload.runId)
      return { outcome: 'blocked', reason: 'run-not-current' };
    this.store.db
      .prepare('DELETE FROM receipts WHERE command_key=?')
      .run(`switch:${command.payload.runId}`);
    if (this.store.receipt(`native-prepared:${command.payload.runId}`))
      this.store.db
        .prepare('DELETE FROM receipts WHERE command_key=?')
        .run(`native-prepared:${command.payload.runId}`);
    this.store.db
      .prepare('DELETE FROM receipts WHERE command_key=?')
      .run(`evaluation-ready:${command.payload.runId}`);
    this.store.db
      .prepare('DELETE FROM receipts WHERE command_key=?')
      .run(`native-handoff-pending:${command.payload.runId}`);
    const restore = this.closePendingEffects(task);
    const active = this.store
      .intents()
      .find((intent) => intent.task_id === task.id && intent.state !== 'stopped');
    if (!active) {
      const config = this.conversationConfiguration(task.id);
      if (config) this.saveConversationConfiguration(task.id, { ...config, paused: true });
      const updated = this.updateTask(
        task,
        restore ?? {
          state: task.state === 'accepted' ? 'accepted' : 'stopped',
          waitingReason: null,
          next: task.state === 'accepted' ? task.next : 'Work is stopped.',
        },
      );
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    if (
      this.pendingConversationLaunches.has(active.attempt_id) &&
      active.state === 'intent' &&
      this.store.runPurpose(active.run_id) === 'conversation' &&
      !this.store.nativeProcesses(active.attempt_id).length
    ) {
      this.pendingConversationLaunches.delete(active.attempt_id);
      const config = this.conversationConfiguration(task.id) as ConversationConfiguration;
      this.saveConversationConfiguration(task.id, { ...config, paused: true });
      const attempt = this.store.get<Attempt>('attempt', active.attempt_id) as Attempt;
      const stopped = { ...attempt, state: 'stopped' as const, revision: attempt.revision + 1 };
      this.store.put('attempt', attempt.id, stopped.revision, stopped);
      this.store.db
        .prepare("UPDATE launch_intents SET state='stopped',finished_at=? WHERE attempt_id=?")
        .run(this.now(), attempt.id);
      this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
      this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
      const proof = this.nativeArtifact({
        attemptId: attempt.id,
        quiescent: true,
        unspawned: true,
      });
      this.store.saveReceipt(`conversation-completion:${attempt.id}`, proof.hash, 'local-owner', {
        outcome: 'applied',
        entity: proof,
      });
      const updated = this.updateTask(task, {
        state: 'stopped',
        waitingReason: null,
        next: 'Planning stopped before its process launched.',
      });
      this.event('attempt.stopped', task.id, updated.revision, stopped);
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    const conversationRuntime = this.conversationWorkers.get(active.attempt_id);
    if (conversationRuntime) {
      const config = this.conversationConfiguration(task.id);
      if (config) this.saveConversationConfiguration(task.id, { ...config, paused: true });
      conversationRuntime.stopped = true;
      const updated = this.updateTask(task, {
        state: 'stopping',
        waitingReason: null,
        next: 'Waiting for the owned planning turn to stop.',
      });
      effects.push(() => conversationRuntime.handle?.stop());
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    const nativeReview = this.nativeReviewWorkers.get(active.attempt_id);
    if (nativeReview) {
      if (task.state === 'unknown')
        return { outcome: 'blocked', reason: 'writer-ownership-unknown' };
      nativeReview.stopped = true;
      const updated = this.updateTask(task, {
        state: 'stopping',
        waitingReason: null,
        next: 'Waiting for the owned native review to stop.',
      });
      effects.push(() => nativeReview.handle?.stop());
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    const check = this.jobs.get(active.attempt_id);
    const review = this.reviewWorkers.get(active.attempt_id);
    if (check || review) {
      this.cancelledJobs.add(active.attempt_id);
      const updated = this.updateTask(task, {
        state: 'stopping',
        waitingReason: null,
        next: 'Waiting for the owned check or review to stop.',
      });
      const attempt = this.store.get<Attempt>('attempt', active.attempt_id) as Attempt;
      effects.push(() => {
        if (review) {
          void review.stop({ schedule: this.options.schedule }).then((exit) => {
            if (this.settleJob(attempt, exit.quiescent)) this.stoppedJob(attempt);
          });
        } else if (check) {
          check.stop();
          if (check instanceof ToolchainVerification) return;
          const cancel = (this.options.schedule ?? defaultSchedule)(
            () => this.settleJob(attempt, false),
            1000,
          );
          void check.exited.then(async (exit) => {
            const quiescent =
              exit.quiescent && (await closedWithin(check.closed, this.options.schedule));
            cancel();
            if (this.settleJob(attempt, quiescent)) this.stoppedJob(attempt);
          });
        }
      });
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    if (
      (this.store.receipt(`evaluation-check:${active.attempt_id}`) ||
        this.store.receipt(`native-review-input:${active.attempt_id}`)) &&
      active.state === 'intent'
    ) {
      this.cancelledJobs.add(active.attempt_id);
      effects.push(() =>
        this.settleJob(this.store.get<Attempt>('attempt', active.attempt_id) as Attempt, true),
      );
      const updated = this.updateTask(task, {
        state: 'stopped',
        waitingReason: null,
        next: 'Evaluation stopped before launch.',
      });
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    const runtime = this.workers.get(active.attempt_id);
    if (!runtime)
      return {
        outcome: 'blocked',
        reason: 'writer-ownership-unknown',
        next: 'Prove the prior process group is gone before continuing.',
      };
    if (task.state === 'unknown') return { outcome: 'blocked', reason: 'writer-ownership-unknown' };
    runtime.reason = 'stop';
    const updated = this.updateTask(task, {
      state: 'stopping',
      waitingReason: null,
      next: 'Waiting for process-group quiescence.',
    });
    effects.push(() => {
      if (runtime.kind === 'native') {
        runtime.stopped = true;
        runtime.handle?.stop();
      } else
        void runtime.worker
          .stop({ schedule: this.options.schedule })
          .then((exit) => this.finishAttempt(active.attempt_id, exit.quiescent));
    });
    return { outcome: 'applied', entity: updated, revision: updated.revision };
  }

  private recover() {
    this.store.transaction(() => {
      for (const operation of this.store.googleMetadataOperations()) {
        const quiescent = operation.state === 'quiescent';
        if (!quiescent) this.store.unknownGoogleMetadata(operation.command_id);
        const receipt = this.store.receipt(operation.command_id);
        if (receipt?.result.reason === 'usage-read-pending') {
          this.finishMetadataReceipt(operation.command_id, {
            outcome: quiescent ? 'blocked' : 'outcome-unknown',
            reason: quiescent ? 'usage-read-interrupted' : 'google-ownership-unknown',
          });
        }
      }
      const setup = this.store.googleAcpSetup();
      if (
        setup.operationId &&
        ['initializing', 'authenticating', 'discovering', 'stopping'].includes(setup.state)
      ) {
        const operation = this.store
          .googleMetadataOperations()
          .find((row) => row.command_id === setup.operationId);
        const known = operation?.state === 'quiescent';
        const next = GoogleAcpSetupSchema.parse({
          ...setup,
          revision: setup.revision + 1,
          state: known ? 'blocked' : 'unknown',
          operationId: known ? null : setup.operationId,
          reason: null,
        });
        this.store.putGoogleAcpSetup(next);
        if (this.store.receipt(setup.operationId)?.result.reason === 'acp-setup-pending')
          this.finishMetadataReceipt(setup.operationId, {
            outcome: known ? 'blocked' : 'outcome-unknown',
            reason: known ? 'acp-setup-interrupted' : 'google-ownership-unknown',
            data: { kind: 'google-acp-setup', setup: next },
          });
      }
      for (const intent of this.store.intents().filter((value) => value.state !== 'stopped')) {
        if (this.store.runPurpose(intent.run_id) === 'conversation') {
          const config = this.conversationConfiguration(intent.task_id);
          if (config)
            this.saveConversationConfiguration(intent.task_id, { ...config, paused: true });
        }
        const attempt = this.store.get<Attempt>('attempt', intent.attempt_id);
        const run = this.store.get<Run>('run', intent.run_id);
        const task = this.store.get<Task>('task', intent.task_id);
        if (
          !attempt ||
          !run ||
          !task ||
          attempt.runId !== run.id ||
          run.taskId !== task.id ||
          attempt.routeId !== intent.route_id ||
          attempt.generation !== intent.generation
        )
          throw new Error('Persisted writer lineage is invalid.');
        const phases = this.store.nativeProcesses(intent.attempt_id);
        const native = phases.length > 0;
        const known = native
          ? phases.every((phase) => phase.state !== 'intent')
          : ['acknowledged', 'interrupted'].includes(intent.state);
        let verificationKnown: boolean | undefined;
        if (this.store.receipt(`verification-launch:${attempt.id}`)) {
          try {
            const launch = this.verificationLaunch(attempt.id);
            const journal = inspectCheckRoots(launch.owner);
            verificationKnown =
              !journal.unknown &&
              journal.roots.length > 0 &&
              journal.roots.every(
                (root) =>
                  root.spawnFailed ||
                  (!!root.terminal &&
                    !!root.acknowledgment &&
                    groupAbsent(root.acknowledgment.group)),
              );
          } catch {
            verificationKnown = false;
          }
        }
        let acpKnown: boolean | undefined;
        if (this.store.nativeProfileId(attempt.id) === 'google-acp-v1') {
          acpKnown = false;
          try {
            const done = z
              .object({
                attemptId: AttemptSchema.shape.id,
                quiescent: z.literal(true),
                unspawned: z.literal(true).optional(),
              })
              .parse(this.nativeRecord(`native-completion:${attempt.id}`, 4096).value);
            const noPrompt = !this.store.receipt(`native-submission:${attempt.id}`);
            const closed =
              (done.unspawned === true && !phases.length) ||
              this.store.nativePhasesComplete(attempt.id, 'google');
            let terminal = false;
            if (!noPrompt) {
              const plan = this.nativeCurrentPlan(run);
              const appointment = plan.appointment;
              if (!('acp' in appointment) || plan.attempt.id !== attempt.id)
                throw Error('ACP plan changed.');
              const retained = this.nativeRecord(`native-acp-terminal:${attempt.id}`, 4096);
              const proof = z
                .strictObject({
                  attemptId: AttemptSchema.shape.id,
                  planHash: HashSchema,
                  completionHash: HashSchema,
                  metadataHash: HashSchema,
                })
                .parse(retained.value);
              const metadata = this.nativeRecord(`native-proposal:${attempt.id}`);
              const completion = this.nativeRecord(`native-completion:${attempt.id}`, 4096);
              const output = z
                .strictObject({
                  sessionId: AcpApprovalTargetSchema.shape.sessionId,
                  stopReason: z.enum([
                    'end_turn',
                    'max_tokens',
                    'max_turn_requests',
                    'refusal',
                    'cancelled',
                  ]),
                  submitted: z.literal(true),
                  selectionHash: HashSchema,
                  reviewModeHash: HashSchema,
                })
                .parse(metadata.value);
              terminal =
                proof.attemptId === attempt.id &&
                proof.planHash ===
                  this.nativeRecord(this.currentNativePlanKey(run.id)).artifact.hash &&
                proof.completionHash === completion.artifact.hash &&
                proof.metadataHash === hashCanonical(output) &&
                output.selectionHash === hashCanonical(appointment.acp) &&
                output.reviewModeHash === hashCanonical(appointment.proof.reviewMode);
            }
            acpKnown = done.attemptId === attempt.id && closed && (noPrompt || terminal);
          } catch {}
        }
        const stopped =
          acpKnown ??
          verificationKnown ??
          (known &&
            (native
              ? phases.every((phase) => groupAbsent(phase.process_group))
              : groupAbsent(intent.process_group)));
        const updated = {
          ...attempt,
          state: stopped ? ('stopped' as const) : ('unknown' as const),
          revision: attempt.revision + 1,
        };
        this.store.put('attempt', attempt.id, updated.revision, updated);
        this.store.db
          .prepare('UPDATE launch_intents SET state=?,finished_at=? WHERE attempt_id=?')
          .run(
            stopped ? 'stopped' : acpKnown === false || !known ? 'outcome-unknown' : 'acknowledged',
            stopped ? this.now() : null,
            attempt.id,
          );
        if (stopped) {
          this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
          this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
        }
        this.updateTask(task, {
          state: stopped ? 'interrupted' : 'unknown',
          waitingReason: null,
          next: stopped
            ? 'Retained work is interrupted. Resume explicitly.'
            : 'Launch ownership is ambiguous. Nothing will relaunch automatically.',
        });
        this.event('run.interrupted', task.id, task.revision + 1, {
          runId: run.id,
          reason: stopped
            ? native
              ? 'Controller restarted after every recorded native process group exited.'
              : 'Controller restarted after the process group exited.'
            : 'An intent has no proven completed launch.',
        });
      }
      for (const intent of this.store
        .intents()
        .filter(
          (row) =>
            row.state === 'stopped' &&
            this.store.nativeProfileId(row.attempt_id) === 'google-acp-v1',
        )) {
        const task = this.store.get<Task>('task', intent.task_id);
        if (task && ['running', 'stopping', 'waiting'].includes(task.state)) {
          this.closePendingEffects(task);
          this.updateTask(task, {
            state: 'interrupted',
            waitingReason: null,
            next: 'Native work was interrupted after recorded closure. Inspect retained evidence.',
          });
        }
      }
    });
  }

  private resolve(
    command: Extract<Command, { command: 'ResolveApproval' }>,
    effects: (() => void)[],
  ): CommandResult {
    const approval = this.store.get<Approval>('approval', command.payload.binding.approvalId);
    const task = this.store.get<Task>('task', command.payload.binding.taskId);
    if (!approval || !task || approval.status !== 'pending')
      return { outcome: 'blocked', reason: 'approval-not-pending' };
    const binding = {
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      attemptId: approval.attemptId,
      generation: approval.generation,
      action: approval.action,
      target: approval.target,
      ...(approval.acpTarget ? { acpTarget: approval.acpTarget } : {}),
      revision: approval.revision,
    };
    if (hashCanonical(binding) !== hashCanonical(command.payload.binding))
      return { outcome: 'denied', reason: 'approval-binding-changed' };
    const pending = this.store.db
      .prepare('SELECT * FROM pending_effects WHERE approval_id=?')
      .get(approval.approvalId);
    if (!pending || pending.task_revision !== task.revision)
      return { outcome: 'stale-revision', entity: task, revision: task.revision };
    const request = JSON.parse(pending.request as string) as {
      kind: string;
      command?: Command;
      plannedAttempt?: Attempt;
      attemptId?: string;
      writerAttemptId?: string;
      candidateId?: string;
      candidateHash?: string;
      handoff?: boolean;
      job?: ReviewJob;
      identity?: GitIdentity;
      at?: string;
      previousStatus?: Pick<Task, 'state' | 'waitingReason' | 'next'>;
      proposal?: AcpPermissionProposal;
    };
    if (request.kind === 'acp') {
      if (
        hashCanonical(request) !== pending.effect_hash ||
        !request.proposal ||
        !approval.acpTarget ||
        approval.action !== request.proposal.action ||
        approval.target !== request.proposal.target ||
        approval.consequence !== request.proposal.consequence
      )
        return { outcome: 'denied', reason: 'pending-effect-changed' };
      const runtime = this.workers.get(approval.attemptId);
      if (
        runtime?.kind !== 'native' ||
        !runtime.acpHandle ||
        !('acp' in runtime.binding.appointment) ||
        this.store.nativeProfileId(approval.attemptId) !== 'google-acp-v1' ||
        approval.generation !== runtime.binding.attempt.generation ||
        hashCanonical(approval.acpTarget) !== hashCanonical(request.proposal.acpTarget)
      )
        return { outcome: 'blocked', reason: 'acp-permission-not-current' };
      if (command.payload.decision === 'approved') {
        try {
          this.validateAcpPermission(runtime, request.proposal);
        } catch {
          return { outcome: 'blocked', reason: 'acp-action-changed' };
        }
      }
      const resolved = ApprovalSchema.parse({
        ...approval,
        status: command.payload.decision,
        revision: approval.revision + 1,
      });
      this.store.put('approval', approval.approvalId, resolved.revision, resolved);
      this.store.db
        .prepare('UPDATE pending_effects SET state=? WHERE approval_id=?')
        .run(command.payload.decision === 'approved' ? 'applied' : 'denied', approval.approvalId);
      const next = this.updateTask(task, {
        state: command.payload.decision === 'approved' ? 'running' : 'stopping',
        waitingReason: null,
        next:
          command.payload.decision === 'approved'
            ? 'One exact native edit was approved.'
            : 'Stopping after the denied native edit.',
      });
      this.event('approval.resolved', task.id, next.revision, resolved);
      effects.push(() => {
        try {
          if (command.payload.decision === 'approved')
            this.validateAcpPermission(runtime, request.proposal as AcpPermissionProposal);
          runtime.acpHandle?.replyPermission(command.payload.binding, command.payload.decision);
        } catch {
          runtime.stopped = true;
          runtime.acpHandle?.stop();
        }
      });
      return { outcome: 'applied', entity: next, revision: next.revision };
    }
    if (
      task.runId &&
      this.store.receipt(`native-run:${task.runId}`) &&
      request.kind !== 'export' &&
      request.kind !== 'accept' &&
      command.payload.decision !== 'denied'
    )
      return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
    if (hashCanonical(request) !== pending.effect_hash)
      return { outcome: 'denied', reason: 'pending-effect-changed' };
    if (request.kind !== 'worker' && this.hasUncertainWriter(task.id))
      return { outcome: 'blocked', reason: 'writer-ownership-unknown' };
    if (request.candidateId) {
      const candidate = this.store.get<Candidate>('candidate', request.candidateId);
      const run = task.runId ? this.store.get<Run>('run', task.runId) : undefined;
      if (
        !candidate ||
        !run ||
        candidate.taskId !== task.id ||
        candidate.hash !== request.candidateHash ||
        this.latestCandidate(run.id)?.id !== candidate.id ||
        this.evidence.hash(run.source.base, readFiles(this.writerScratch(run))) !== candidate.hash
      )
        return {
          outcome: 'blocked',
          reason: 'candidate-binding-changed',
          next: 'Refresh the candidate and request a new exact action.',
        };
    }
    if (
      request.kind === 'accept' &&
      command.payload.decision === 'approved' &&
      task.runId &&
      this.store.receipt(`native-run:${task.runId}`)
    ) {
      const run = this.store.get<Run>('run', task.runId) as Run;
      let native: ReturnType<Controller['nativePublicationEvidence']>;
      try {
        native = this.nativePublicationEvidence(run, this.latestCandidate(run.id) as Candidate);
      } catch {
        return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
      }
      if (
        request.command?.command !== 'AcceptCandidate' ||
        request.command.payload.taskId !== task.id ||
        request.command.payload.candidateId !== request.candidateId ||
        approval.action !== 'accept-candidate' ||
        approval.target !== request.command.payload.destinationRef
      )
        return { outcome: 'blocked', reason: 'pending-lineage-changed' };
      try {
        this.nativePublicationCurrent(
          run,
          this.store.get<Candidate>('candidate', request.command.payload.candidateId) as Candidate,
          native,
        );
      } catch {
        return { outcome: 'blocked', reason: 'native-evidence-not-current' };
      }
    }
    const updated = {
      ...approval,
      status: command.payload.decision,
      revision: approval.revision + 1,
    };
    this.store.put('approval', approval.approvalId, updated.revision, updated);
    this.store.db
      .prepare('UPDATE pending_effects SET state=? WHERE approval_id=?')
      .run(command.payload.decision === 'approved' ? 'approved' : 'denied', approval.approvalId);
    this.event('approval.resolved', task.id, task.revision, updated);
    if (
      task.runId &&
      this.store.receipt(`native-run:${task.runId}`) &&
      command.payload.decision === 'denied'
    )
      return { outcome: 'applied', entity: task, revision: task.revision };
    if (request.kind === 'worker') {
      const runtime = this.workers.get(approval.attemptId);
      if (runtime?.kind !== 'fake')
        return { outcome: 'blocked', reason: 'approval-worker-not-active' };
      const next = this.updateTask(task, {
        state: command.payload.decision === 'approved' ? 'running' : 'stopping',
        waitingReason: null,
        next:
          command.payload.decision === 'approved'
            ? 'One pending action was approved.'
            : 'Stopping after the denied action.',
      });
      effects.push(() =>
        runtime.worker.send({
          type: 'approval',
          binding: command.payload.binding,
          decision: command.payload.decision,
        }),
      );
      return { outcome: 'applied', entity: next, revision: next.revision };
    }
    if (command.payload.decision === 'denied')
      return {
        outcome: 'applied',
        entity: this.updateTask(task, {
          ...((request.kind === 'accept' || request.kind === 'export') && request.previousStatus
            ? request.previousStatus
            : { state: 'stopped', waitingReason: null, next: 'The action was denied.' }),
        }),
      };
    if (
      request.kind === 'command' &&
      request.command &&
      (request.command.command === 'StartRun' || request.command.command === 'ResumeRun')
    ) {
      const result = this.start(
        { ...request.command, expectedRevision: task.revision },
        effects,
        approval.approvalId,
        request.plannedAttempt,
      );
      this.store.db
        .prepare('UPDATE pending_effects SET state=? WHERE approval_id=?')
        .run(result.outcome === 'applied' ? 'applied' : 'stale', approval.approvalId);
      if (result.outcome !== 'applied') {
        const current = this.store.get<Task>('task', task.id) as Task;
        const stopped = this.updateTask(current, {
          state: 'stopped',
          waitingReason: null,
          next:
            result.next ??
            'The approved action could not be admitted. Prepare or request a new bounded action.',
        });
        return { ...result, entity: stopped, revision: stopped.revision };
      }
      return result;
    }
    if (
      request.kind === 'accept' &&
      request.command?.command === 'AcceptCandidate' &&
      request.identity &&
      request.at
    )
      return this.accept(
        { ...request.command, key: command.key, expectedRevision: task.revision },
        effects,
        approval.approvalId,
        request.identity,
        request.at,
      );
    if (request.kind === 'export' && request.command?.command === 'ExportPatch') {
      const result = this.exportPatch(
        { ...request.command, key: command.key, expectedRevision: task.revision },
        approval.approvalId,
      );
      if (result.outcome === 'applied')
        this.updateTask(
          this.store.get<Task>('task', task.id) as Task,
          request.previousStatus ?? {
            state: 'stopped',
            waitingReason: null,
            next: 'The patch is available as an immutable artifact.',
          },
        );
      else
        this.updateTask(this.store.get<Task>('task', task.id) as Task, {
          state: 'stopped',
          waitingReason: null,
          next:
            result.next ?? 'The approved export could not complete. Inspect the retained artifact.',
        });
      return result;
    }
    if (
      (request.kind === 'check' || request.kind === 'review') &&
      request.writerAttemptId &&
      request.candidateId
    ) {
      const writer = this.store.get<Attempt>('attempt', request.writerAttemptId);
      const candidate = this.store.get<Candidate>('candidate', request.candidateId);
      if (!writer || !candidate || writer.runId !== task.runId)
        return { outcome: 'denied', reason: 'pending-lineage-changed' };
      if (request.kind === 'check')
        this.checkCandidate(
          writer,
          candidate,
          request.handoff ?? false,
          approval.approvalId,
          this.store.get<Attempt>('attempt', approval.attemptId),
          effects,
        );
      else
        this.dispatchReviews(
          writer,
          candidate,
          approval.approvalId,
          ReviewJobSchema.parse(request.job),
          effects,
        );
      const current = this.store.get<Task>('task', task.id) as Task;
      return { outcome: 'applied', entity: current, revision: current.revision };
    }
    return { outcome: 'unsupported', reason: 'pending-effect-not-implemented' };
  }

  private latestCandidate(runId: string): Candidate | undefined {
    for (const intent of this.store
      .intents()
      .filter((value) => value.run_id === runId)
      .reverse()) {
      const candidate = this.store.receipt(`candidate:${intent.attempt_id}`)?.result.entity;
      if (candidate && 'artifactId' in candidate) return candidate as Candidate;
    }
  }

  private saveArtifacts(artifacts: Artifact[]) {
    for (const artifact of artifacts) this.store.put('artifact', artifact.id, 0, artifact);
  }

  private sealCandidate(attempt: Attempt, capturedFiles?: FileContent[]): Candidate {
    const run = this.store.get<Run>('run', attempt.runId) as Run;
    if (this.hasUncertainWriter(run.taskId)) throw new Error('Writer ownership is not quiescent.');
    const intent = this.store
      .intents()
      .find((value) => value.attempt_id === attempt.id) as LaunchIntent;
    const files = capturedFiles ?? readFiles(intent.scratch_path);
    const native = !!this.store.receipt(`native-run:${run.id}`);
    const nativeCandidates = new Set(
      this.store
        .intents()
        .filter((value) => this.store.receipt(`native-run:${value.run_id}`))
        .map(
          (value) =>
            CandidateSchema.safeParse(
              this.store.receipt(`candidate:${value.attempt_id}`)?.result.entity,
            ).data?.id,
        ),
    );
    const captured = this.evidence.capture({
      taskId: run.taskId,
      base: run.source.base,
      files,
      existing: this.store
        .list<Candidate>('candidate')
        .filter((candidate) => nativeCandidates.has(candidate.id) === native),
    });
    const changes = this.store.receipt(`changes:${captured.candidate.id}`)
      ? undefined
      : this.evidence.changes({
          taskId: run.taskId,
          candidateId: captured.candidate.id,
          base: run.source.base,
          sourceFiles: committedFiles(
            this.projectPath(run.source.projectId) as string,
            run.source.base,
          ),
          files,
        });
    this.store.transaction(() => {
      const task = this.store.get<Task>('task', run.taskId) as Task;
      this.saveArtifacts(captured.artifacts);
      this.store.put(
        'candidate',
        captured.candidate.id,
        captured.candidate.revision,
        captured.candidate,
      );
      if (changes) {
        this.saveArtifacts(changes.artifacts);
        this.store.saveReceipt(
          `changes:${captured.candidate.id}`,
          captured.candidate.hash,
          'local-owner',
          { outcome: 'applied', data: changes.data },
        );
      }
      if (!this.store.receipt(`candidate:${attempt.id}`))
        this.store.saveReceipt(`candidate:${attempt.id}`, captured.candidate.hash, 'local-owner', {
          outcome: 'applied',
          entity: captured.candidate,
        });
      this.event('candidate.sealed', task.id, task.revision, captured.candidate);
    });
    return captured.candidate;
  }

  private checkMatches(
    check: CheckResult,
    candidate: Candidate,
    plan: Pick<CheckDefinition, 'definitionHash' | 'evaluator'> & {
      recipeId?: CheckDefinition['recipeId'];
    },
  ): boolean {
    if (
      !check.passed ||
      check.review ||
      check.candidateId !== candidate.id ||
      check.candidateHash !== candidate.hash ||
      check.definitionHash !== plan.definitionHash ||
      check.evaluator !== plan.evaluator
    )
      return false;
    try {
      const artifact = this.store.get<Artifact>('artifact', check.artifactId);
      if (artifact?.mediaType !== 'application/vnd.crewkite.check+json' || artifact.bytes > 1048576)
        return false;
      const content = this.artifacts.read(artifact.hash);
      if (content.length !== artifact.bytes) return false;
      const metadata = JSON.parse(content.toString('utf8')) as {
        candidateId: string;
        candidateHash: string;
        definitionHash: string;
        evaluator: string;
        passed: boolean;
        complete: boolean;
        unchanged: boolean;
        tests: number;
        log: Artifact;
        verification?: { artifact: Artifact; owner: CheckOwner };
      };
      if (
        metadata.candidateId !== candidate.id ||
        metadata.candidateHash !== candidate.hash ||
        metadata.definitionHash !== plan.definitionHash ||
        metadata.evaluator !== plan.evaluator ||
        !metadata.passed ||
        !metadata.complete ||
        !metadata.unchanged ||
        !Number.isSafeInteger(metadata.tests) ||
        metadata.tests <= 0
      )
        return false;
      if (plan.recipeId === 'crewkite-verify-v1') {
        const owner = parseCheckOwner(metadata.verification?.owner);
        const launch = this.verificationLaunch(owner.attemptId);
        if (
          launch.candidateId !== candidate.id ||
          launch.definitionHash !== plan.definitionHash ||
          hashCanonical(launch.owner) !== hashCanonical(owner) ||
          !this.evidence.verificationMatches({
            candidate,
            definition: plan as CheckDefinition & { recipeId: 'crewkite-verify-v1' },
            metadata,
            owner,
          })
        )
          return false;
      }
      const log = ArtifactSchema.parse(metadata.log);
      const stored = this.store.get<Artifact>('artifact', log.id);
      return (
        !!stored &&
        hashCanonical(stored) === hashCanonical(log) &&
        this.artifacts.read(log.hash).length === log.bytes
      );
    } catch {
      return false;
    }
  }

  private checks(candidate: Candidate): CheckResult[] {
    return this.store.db
      .prepare(
        "SELECT body FROM evidence WHERE candidate_id=? AND candidate_hash=? AND kind='check'",
      )
      .all(candidate.id, candidate.hash)
      .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)));
  }

  private jobAttempt(run: Run, routeId: string): Attempt {
    return AttemptSchema.parse({
      id: this.id('att'),
      runId: run.id,
      routeId,
      generation: this.store.list<Attempt>('attempt').filter((value) => value.runId === run.id)
        .length,
      state: 'intent',
      revision: 0,
    });
  }

  private admitJob(run: Run, attempt: Attempt, directory: string, maximumMinutes?: number) {
    const googleBlocker = this.store.googleStartBlocker(attempt.routeId);
    if (googleBlocker) throw new Error(googleBlocker);
    const remaining = this.remaining(run);
    if (
      remaining.attempts === 0 ||
      remaining.minutes === 0 ||
      remaining.concurrency === 0 ||
      this.hasUncertainWriter(run.taskId)
    )
      throw new Error('The run has no bounded execution slot.');
    this.store.put('attempt', attempt.id, attempt.revision, attempt);
    this.store.db
      .prepare('INSERT INTO writer_leases(task_id,attempt_id,generation) VALUES (?,?,?)')
      .run(run.taskId, attempt.id, attempt.generation);
    this.store.db
      .prepare(
        "INSERT INTO launch_intents(attempt_id,task_id,run_id,route_id,generation,scratch_path,state,admitted_at) VALUES (?,?,?,?,?,?,'intent',?)",
      )
      .run(
        attempt.id,
        run.taskId,
        run.id,
        attempt.routeId,
        attempt.generation,
        directory,
        this.now(),
      );
    this.store.db
      .prepare(
        "INSERT INTO reservations(attempt_id,route_id,window_id,unit,value,launches,minutes) VALUES (?,?,?,'minutes',0,1,?)",
      )
      .run(
        attempt.id,
        attempt.routeId,
        'local-execution',
        Math.min(remaining.minutes, maximumMinutes ?? remaining.minutes),
      );
    return Math.min(remaining.minutes, maximumMinutes ?? remaining.minutes);
  }

  private acknowledgeJob(attempt: Attempt, pid: number) {
    if (this.closed) return;
    this.store.transaction(() => {
      const current = this.store.get<Attempt>('attempt', attempt.id) as Attempt;
      const running = { ...current, state: 'running' as const, revision: current.revision + 1 };
      this.store.put('attempt', attempt.id, running.revision, running);
      this.store.db
        .prepare(
          "UPDATE launch_intents SET pid=?,process_group=?,state='acknowledged' WHERE attempt_id=?",
        )
        .run(pid, pid, attempt.id);
      const run = this.store.get<Run>('run', attempt.runId) as Run;
      const task = this.store.get<Task>('task', run.taskId) as Task;
      this.event('attempt.launched', task.id, task.revision, running);
    });
  }

  private stoppedJob(attempt: Attempt) {
    if (this.closed) return;
    const run = this.store.get<Run>('run', attempt.runId) as Run;
    this.store.transaction(() =>
      this.updateTask(this.store.get<Task>('task', run.taskId) as Task, {
        state: 'stopped',
        waitingReason: null,
        next: 'Work is stopped. Incomplete checks or reviews do not count as passing.',
      }),
    );
  }

  private settleJob(
    attempt: Attempt,
    quiescent: boolean,
    closing = false,
    afterSettled?: () => void,
  ): boolean {
    if (this.closed && !closing) return false;
    const current = this.store.get<Attempt>('attempt', attempt.id) as Attempt;
    if (current.state === 'stopped' || (current.state === 'unknown' && !quiescent)) return false;
    this.store.transaction(() => {
      const run = this.store.get<Run>('run', attempt.runId) as Run;
      const task = this.store.get<Task>('task', run.taskId) as Task;
      const updated = {
        ...current,
        state: quiescent ? ('stopped' as const) : ('unknown' as const),
        revision: current.revision + 1,
      };
      this.store.put('attempt', attempt.id, updated.revision, updated);
      if (quiescent) {
        this.jobCancels.get(attempt.id)?.();
        this.jobCancels.delete(attempt.id);
        this.jobs.delete(attempt.id);
        this.reviewWorkers.delete(attempt.id);
        this.store.db
          .prepare("UPDATE launch_intents SET state='stopped',finished_at=? WHERE attempt_id=?")
          .run(this.now(), attempt.id);
        this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
        this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
        this.event('attempt.stopped', task.id, task.revision, updated);
        afterSettled?.();
      } else {
        this.event('ownership.unknown', task.id, task.revision, updated);
        this.updateTask(task, {
          state: 'unknown',
          waitingReason: null,
          next: 'Execution ownership is unknown. Checks and publication are blocked.',
        });
      }
    });
    return quiescent;
  }

  private checkCandidate(
    writer: Attempt,
    candidate: Candidate,
    handoff: boolean,
    approved?: string,
    planned?: Attempt,
    effects?: (() => void)[],
  ) {
    const run = this.store.get<Run>('run', writer.runId) as Run;
    const task = this.store.get<Task>('task', run.taskId) as Task;
    if (this.store.receipt(`native-run:${run.id}`))
      throw new Error('The native pilot permits retention and export only.');
    if (this.hasUncertainWriter(task.id) || this.latestCandidate(run.id)?.hash !== candidate.hash)
      throw new Error('Candidate binding changed.');
    const plan = this.evidence.prepareChecks({
      candidate,
      sourceFiles: committedFiles(this.projectPath(task.projectId) as string, run.source.base),
      criteria: task.criteria,
    });
    if (this.checks(candidate).some((check) => this.checkMatches(check, candidate, plan))) {
      const follow = () => this.afterChecks(writer, candidate, handoff);
      if (effects) effects.push(follow);
      else follow();
      return;
    }
    const local = this.store
      .list<Route>('route')
      .find(
        (route) =>
          route.fake && route.qualified && route.family === 'local' && route.billing === 'local',
      );
    if (!local) throw new Error('A qualified local check route is required.');
    const attempt = planned ?? this.jobAttempt(run, local.id);
    const grant = this.grant(run, 'run-check', 'node --test');
    const workerApproval = this.store
      .list<Approval>('approval')
      .find(
        (approval) =>
          approval.attemptId === writer.id &&
          approval.generation === writer.generation &&
          approval.action === 'run-check' &&
          approval.target === 'node --test' &&
          approval.status === 'approved' &&
          this.store.db
            .prepare(
              "SELECT approval_id FROM pending_effects WHERE approval_id=? AND state='approved'",
            )
            .get(approval.approvalId),
      );
    const mutate = () => {
      if (!grant && !workerApproval && !approved) {
        this.store.put('attempt', attempt.id, 0, attempt);
        this.requestAction(task, run, attempt, 'run-check', 'node --test', {
          kind: 'check',
          writerAttemptId: writer.id,
          candidateId: candidate.id,
          candidateHash: candidate.hash,
          handoff,
        });
        return;
      }
      const minutes = this.admitJob(run, attempt, plan.directory);
      if (grant) this.consumeGrant(run, grant);
      const approvalId = approved ?? workerApproval?.approvalId;
      if (approvalId)
        this.store.db
          .prepare("UPDATE pending_effects SET state='applied' WHERE approval_id=?")
          .run(approvalId);
      this.store.saveReceipt(
        `check-authority:${attempt.id}`,
        hashCanonical({
          runId: run.id,
          writerAttemptId: writer.id,
          generation: writer.generation,
          candidateHash: candidate.hash,
          definitionHash: plan.definitionHash,
          grant: grant ?? null,
          approvalId: approvalId ?? null,
        }),
        'local-owner',
        { outcome: 'applied', entity: candidate },
      );
      const current = this.store.get<Task>('task', task.id) as Task;
      this.updateTask(current, {
        state: 'checking',
        waitingReason: null,
        next: 'Running the exact declared checks in an independent copy.',
      });
      const launch = () =>
        this.launchCheck(run, attempt, writer, candidate, plan, handoff, minutes);
      if (effects) effects.push(launch);
      else queueMicrotask(launch);
    };
    if (effects) mutate();
    else this.store.transaction(mutate);
  }

  private jobDeadline(attemptId: string, minutes: number): number {
    const intent = this.store.intents().find((value) => value.attempt_id === attemptId);
    const admitted = TimestampSchema.safeParse(intent?.admitted_at);
    if (!admitted.success) return 0;
    const elapsed = Date.parse(this.now()) - Date.parse(admitted.data);
    if (elapsed < 0 || !Number.isFinite(elapsed)) return 0;
    return Math.max(0, minutes * 60000 - elapsed);
  }

  private launchCheck(
    run: Run,
    attempt: Attempt,
    writer: Attempt,
    candidate: Candidate,
    plan: CheckPlan,
    handoff: boolean,
    minutes: number,
    evaluation?: Artifact,
  ) {
    if (this.closed || this.store.get<Attempt>('attempt', attempt.id)?.state !== 'intent') return;
    let prepared: z.infer<typeof CandidateEvaluationSchema> | undefined;
    try {
      prepared = evaluation ? this.evaluationPlan(evaluation) : undefined;
      if (prepared && !this.store.receipt(`evaluation-consent:${prepared.scopeHash}`))
        throw Error('Evaluation consent was revoked before launch.');
    } catch {
      this.settleJob(attempt, true);
      this.stoppedJob(attempt);
      return;
    }
    const deadline = () =>
      Math.max(
        0,
        Math.min(
          this.jobDeadline(attempt.id, minutes),
          prepared
            ? Date.parse(prepared.expiresAt) - Date.parse(this.now())
            : Number.POSITIVE_INFINITY,
        ),
      );
    if (deadline() === 0) {
      this.settleJob(attempt, true);
      this.stoppedJob(attempt);
      return;
    }
    const schedule = this.options.schedule ?? defaultSchedule;
    let timedOut = false;
    let job: OwnedCommand;
    try {
      job = new OwnedCommand({
        argv: plan.argv,
        directory: plan.directory,
        environmentHome: join(this.home, 'environment', attempt.id),
        onSpawn: (pid) => this.acknowledgeJob(attempt, pid),
      });
      this.jobs.set(attempt.id, job);
    } catch {
      this.settleJob(attempt, false);
      return;
    }
    const cancel = schedule(() => {
      timedOut = true;
      job.stop();
      schedule(() => {
        this.settleJob(attempt, false);
      }, 1000);
    }, deadline());
    this.jobCancels.set(attempt.id, cancel);
    void job.exited
      .then(async (exit) => {
        const quiescent = exit.quiescent && (await closedWithin(job.closed, this.options.schedule));
        cancel();
        if (!this.settleJob(attempt, quiescent)) return;
        if (this.cancelledJobs.has(attempt.id)) {
          this.stoppedJob(attempt);
          return;
        }
        const result = this.evidence.recordCheck({
          candidate,
          plan,
          passed:
            exit.code === 0 &&
            !job.failed &&
            !timedOut &&
            (!prepared ||
              (Date.parse(prepared.expiresAt) > Date.parse(this.now()) &&
                !!this.store.receipt(`evaluation-consent:${prepared.scopeHash}`))),
          output: Buffer.concat(job.stdout),
        });
        this.store.transaction(() => {
          this.saveArtifacts(result.artifacts);
          const check = result.evidence;
          this.store.db
            .prepare(
              "INSERT OR REPLACE INTO evidence(candidate_id,kind,candidate_hash,definition_hash,evaluator,body) VALUES (?,'check',?,?,?,?)",
            )
            .run(
              candidate.id,
              candidate.hash,
              check.definitionHash,
              check.evaluator,
              canonicalJson(check),
            );
          if (evaluation)
            this.store.saveReceipt(
              `evaluation-result:${evaluation.id}`,
              evaluation.hash,
              'local-owner',
              {
                outcome: 'applied',
                entity: result.artifacts.find((artifact) => artifact.id === check.artifactId),
              },
            );
          const task = this.store.get<Task>('task', run.taskId) as Task;
          this.event('check.completed', task.id, task.revision, check);
          if (!check.passed)
            this.updateTask(task, {
              state: 'failed',
              waitingReason: null,
              next: 'Checks failed or were incomplete. Inspect the retained evidence.',
            });
        });
        if (result.evidence.passed && evaluation) {
          this.store.transaction(() =>
            this.updateTask(this.store.get<Task>('task', run.taskId) as Task, {
              state: 'stopped',
              waitingReason: null,
              next: 'Local checks passed. Review the evidence, then explicitly start the prepared native review or export the patch.',
            }),
          );
        } else if (result.evidence.passed) this.afterChecks(writer, candidate, handoff);
      })
      .catch(() => {
        if (!this.closed)
          this.store.transaction(() => {
            const task = this.store.get<Task>('task', run.taskId) as Task;
            this.updateTask(task, {
              state: 'failed',
              waitingReason: null,
              next: 'Check evidence could not be verified.',
            });
          });
      });
  }

  private attestedReviewWriter(run: Run, candidate: Candidate, writer: Attempt): boolean {
    const current = this.store
      .intents()
      .filter(
        (intent) => intent.run_id === run.id && intent.scratch_path === this.writerScratch(run),
      )
      .at(-1);
    const stored = this.store.get<Attempt>('attempt', writer.id);
    const receipt = this.store.receipt(`candidate:${writer.id}`);
    const sealed = CandidateSchema.safeParse(receipt?.result.entity);
    return (
      !!current &&
      current.attempt_id === writer.id &&
      current.task_id === run.taskId &&
      current.route_id === writer.routeId &&
      current.generation === writer.generation &&
      current.state === 'stopped' &&
      stored?.state === 'stopped' &&
      stored.runId === run.id &&
      stored.routeId === writer.routeId &&
      stored.generation === writer.generation &&
      writer.runId === run.id &&
      candidate.taskId === run.taskId &&
      receipt?.hash === candidate.hash &&
      receipt.result.outcome === 'applied' &&
      sealed.success &&
      sealed.data.taskId === run.taskId &&
      sealed.data.id === candidate.id &&
      sealed.data.hash === candidate.hash
    );
  }

  private reviewIdentity(run: Run, job: ReviewJob) {
    const digest = createHash('sha256')
      .update(readFileSync(fakeReviewWorkerPath))
      .update(readFileSync(process.execPath))
      .digest('hex');
    return {
      evaluator: `scripted:${digest}`,
      definitionHash: hashCanonical({
        methodId: job.methodId,
        cycle: job.cycle,
        routeId: job.routeId,
        policyHash: run.policy.hash,
        ...(job.writerAttemptId
          ? { writerAttemptId: job.writerAttemptId, writerRouteId: job.writerRouteId }
          : {}),
      }),
    };
  }

  private reviewMatches(
    check: CheckResult,
    run: Run,
    method: NonNullable<Policy['methods']>[number],
    cycle: number,
    candidate: Candidate,
    expectedWriter?: Attempt,
  ): boolean {
    const job = check.review?.job;
    const role = run.roles.find((value) => value.role === method.reviewerRole);
    if (
      !check.passed ||
      !job ||
      !role ||
      job.runId !== run.id ||
      job.taskId !== run.taskId ||
      job.candidateId !== candidate.id ||
      job.candidateHash !== candidate.hash ||
      job.methodId !== method.id ||
      job.cycle !== cycle ||
      !job.scripted ||
      ![role.routeId, ...role.approvedFallbacks].includes(job.routeId)
    )
      return false;
    if (job.writerAttemptId) {
      const writer = this.store.get<Attempt>('attempt', job.writerAttemptId);
      if (
        !writer ||
        writer.routeId !== job.writerRouteId ||
        (expectedWriter && expectedWriter.id !== writer.id) ||
        !this.attestedReviewWriter(run, candidate, writer)
      )
        return false;
    }
    const identity = this.reviewIdentity(run, job);
    if (check.evaluator !== identity.evaluator || check.definitionHash !== identity.definitionHash)
      return false;
    const stored = this.store.db
      .prepare('SELECT body FROM review_jobs WHERE attempt_id=? AND candidate_id=?')
      .get(job.attemptId, candidate.id);
    const attempt = this.store.get<Attempt>('attempt', job.attemptId);
    if (
      !stored ||
      hashCanonical(JSON.parse(stored.body as string)) !== hashCanonical(job) ||
      attempt?.state !== 'stopped' ||
      attempt.runId !== run.id ||
      attempt.routeId !== job.routeId ||
      attempt.generation !== job.generation
    )
      return false;
    const artifact = this.store.get<Artifact>('artifact', check.artifactId);
    return (
      !!artifact &&
      hashCanonical(JSON.parse(this.artifacts.read(artifact.hash).toString('utf8'))) ===
        hashCanonical(check.review)
    );
  }

  private dispatchReviews(
    writer: Attempt,
    candidate: Candidate,
    approved?: string,
    planned?: ReviewJob,
    effects?: (() => void)[],
  ) {
    const run = this.store.get<Run>('run', writer.runId) as Run;
    const task = this.store.get<Task>('task', run.taskId) as Task;
    if (this.store.receipt(`paused:${run.id}`)) {
      if (effects)
        this.updateTask(task, {
          state: 'stopped',
          waitingReason: null,
          next: 'Admissions paused.',
        });
      else this.stoppedJob(writer);
      return;
    }
    if (this.hasUncertainWriter(task.id) || this.latestCandidate(run.id)?.hash !== candidate.hash)
      throw new Error('Review candidate binding changed.');
    if (this.store.receipt(`native-run:${run.id}`))
      throw new Error('The native pilot permits retention and export only.');
    if (!this.attestedReviewWriter(run, candidate, writer))
      throw new Error('Review writer provenance is not attested.');
    const completed = this.store.db
      .prepare(
        "SELECT body FROM evidence WHERE candidate_id=? AND candidate_hash=? AND kind='review'",
      )
      .all(candidate.id, candidate.hash)
      .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)));
    let pending: { method: NonNullable<Policy['methods']>[number]; cycle: number } | undefined;
    methods: for (const method of run.policy.policy.methods ?? [])
      for (let cycle = 1; cycle <= method.cycles; cycle++)
        if (
          !completed.some((check) =>
            this.reviewMatches(check, run, method, cycle, candidate, writer),
          )
        ) {
          pending = { method, cycle };
          break methods;
        }
    if (!pending) {
      const ready = () =>
        this.updateTask(this.store.get<Task>('task', task.id) as Task, {
          state: 'ready',
          waitingReason: null,
          next: run.policy.policy.methods?.some((method) =>
            ['second-opinion', 'round-robin'].includes(method.id),
          )
            ? 'Declared checks and selected scripted reviews passed. Review the exact changes before acceptance.'
            : (run.policy.policy.methods?.length ?? 0) > 0
              ? 'Declared checks and selected scripted methods passed. No independent review was selected.'
              : 'Declared checks passed. No independent review was selected.',
        });
      if (effects) ready();
      else this.store.transaction(ready);
      return;
    }
    const decision = this.routing(run, pending.method.reviewerRole);
    if (!decision.chosen) {
      const waiting = () =>
        this.updateTask(task, {
          state: 'waiting',
          waitingReason: 'capacity',
          next: 'A selected review route has no bounded slot or allowance.',
        });
      if (effects) waiting();
      else this.store.transaction(waiting);
      return;
    }
    const remaining = this.remaining(run);
    if (remaining.attempts === 0 || remaining.minutes === 0)
      throw new Error('Review budget is exhausted.');
    const attempt = planned
      ? (this.store.get<Attempt>('attempt', planned.attemptId) as Attempt)
      : this.jobAttempt(run, decision.chosen);
    const job =
      planned ??
      ReviewJobSchema.parse({
        taskId: task.id,
        runId: run.id,
        attemptId: attempt.id,
        generation: attempt.generation,
        routeId: decision.chosen,
        writerAttemptId: writer.id,
        writerRouteId: writer.routeId,
        candidateId: candidate.id,
        candidateHash: candidate.hash,
        methodId: pending.method.id,
        cycle: pending.cycle,
        limitMinutes: remaining.minutes,
        scripted: true,
      });
    if (
      job.routeId !== decision.chosen ||
      job.methodId !== pending.method.id ||
      job.cycle !== pending.cycle ||
      job.candidateHash !== candidate.hash ||
      (job.writerAttemptId !== undefined &&
        (job.writerAttemptId !== writer.id || job.writerRouteId !== writer.routeId))
    )
      throw new Error('Approved review binding changed.');
    if (!job.scripted) throw Error('Native review cannot enter the scripted worker.');
    const target = formatReviewTarget({ methodId: job.methodId, cycle: job.cycle });
    const grant = this.grant(run, 'run-review', target);
    if (!grant && !approved) {
      const ask = () => {
        this.store.put('attempt', attempt.id, 0, attempt);
        this.requestAction(task, run, attempt, 'run-review', target, {
          kind: 'review',
          writerAttemptId: writer.id,
          candidateId: candidate.id,
          candidateHash: candidate.hash,
          job,
        });
      };
      if (effects) ask();
      else this.store.transaction(ask);
      return;
    }
    const directory = mkdtempSync(join(this.home, 'review-'));
    materialize(directory, this.evidence.read(candidate).files);
    const admit = () => {
      const minutes = this.admitJob(run, attempt, directory);
      this.store.db
        .prepare('INSERT INTO review_jobs(attempt_id,candidate_id,body) VALUES (?,?,?)')
        .run(attempt.id, candidate.id, canonicalJson(job));
      if (grant) this.consumeGrant(run, grant);
      if (approved)
        this.store.db
          .prepare("UPDATE pending_effects SET state='applied' WHERE approval_id=?")
          .run(approved);
      this.store.saveReceipt(
        `review-authority:${attempt.id}`,
        hashCanonical({ job, grant: grant ?? null, approvalId: approved ?? null }),
        'local-owner',
        { outcome: 'applied', entity: candidate },
      );
      this.updateTask(this.store.get<Task>('task', task.id) as Task, {
        state: 'checking',
        waitingReason: null,
        next: `Running scripted ${job.methodId}, cycle ${job.cycle}.`,
      });
      const launch = () =>
        this.launchReview(run, attempt, writer, candidate, job, directory, minutes);
      if (effects) effects.push(launch);
      else queueMicrotask(launch);
    };
    if (effects) admit();
    else this.store.transaction(admit);
  }

  private launchReview(
    run: Run,
    attempt: Attempt,
    writer: Attempt,
    candidate: Candidate,
    job: Extract<ReviewJob, { scripted: true }>,
    directory: string,
    minutes: number,
  ) {
    if (this.jobDeadline(attempt.id, minutes) === 0) {
      this.settleJob(attempt, true);
      this.stoppedJob(attempt);
      return;
    }
    const identity = this.reviewIdentity(run, job);
    let result: ReviewResult | undefined;
    let terminal: Extract<FakeWorkerEvent, { type: 'terminal' }> | undefined;
    let failed = false;
    let worker: OwnedWorker;
    try {
      worker = new OwnedWorker({
        workerPath: fakeReviewWorkerPath,
        start: {
          type: 'review',
          job,
          scratchPath: directory,
          criteria: (this.store.get<Task>('task', run.taskId) as Task).criteria,
          ...(run.policy.policy.guidance ? { guidance: run.policy.policy.guidance } : {}),
        },
        environmentHome: join(this.home, 'environment', attempt.id),
        routeId: job.routeId,
        observedAt: this.now(),
        onSpawn: (pid) =>
          this.store.transaction(() => {
            this.store.db
              .prepare('UPDATE launch_intents SET pid=?,process_group=? WHERE attempt_id=?')
              .run(pid, pid, attempt.id);
          }),
        onEvent: (event) => {
          if (this.closed) return;
          if (event.type === 'ready') {
            if (event.attemptId !== attempt.id || event.generation !== attempt.generation)
              throw new Error('Review identity changed.');
            this.acknowledgeJob(attempt, worker.group);
          } else if (event.type === 'review') {
            if (result || hashCanonical(event.result.job) !== hashCanonical(job))
              throw new Error('Review result binding changed.');
            result = event.result;
          } else if (event.type === 'terminal') {
            if (terminal) failed = true;
            terminal = event;
          } else if (event.type !== 'output')
            throw new Error('Review worker sent an unrelated effect.');
        },
        onFailure: () => {
          failed = true;
          worker?.child.stdin.end();
        },
      });
      this.reviewWorkers.set(attempt.id, worker);
    } catch {
      this.settleJob(attempt, false);
      return;
    }
    const schedule = this.options.schedule ?? defaultSchedule;
    const cancel = schedule(
      () => {
        failed = true;
        void worker.stop({ schedule }).then((exit) => this.settleJob(attempt, exit.quiescent));
      },
      this.jobDeadline(attempt.id, minutes),
    );
    this.jobCancels.set(attempt.id, cancel);
    void worker.exited
      .then(async (exit) => {
        const quiescent =
          exit.quiescent && (await closedWithin(worker.closed, this.options.schedule));
        cancel();
        if (!this.settleJob(attempt, quiescent)) return;
        if (this.cancelledJobs.has(attempt.id)) {
          this.stoppedJob(attempt);
          return;
        }
        const unchanged =
          this.evidence.hash(run.source.base, readFiles(directory)) === candidate.hash;
        const valid =
          exit.code === 0 &&
          !failed &&
          terminal?.outcome === 'completed' &&
          result &&
          unchanged &&
          hashCanonical(this.reviewIdentity(run, job)) === hashCanonical(identity);
        const review: ReviewResult = valid
          ? (result as ReviewResult)
          : {
              job,
              outcome: 'blocked',
              findings: [
                {
                  severity: 'blocking',
                  message:
                    'The scripted review did not complete with unchanged candidate bytes and proven ownership.',
                },
              ],
              summary: 'Scripted review evidence is incomplete.',
            };
        const artifact = {
          id: this.id('art'),
          ...this.artifacts.publish(Buffer.from(canonicalJson(review))),
          mediaType: 'application/json',
        };
        const check = CheckResultSchema.parse({
          candidateId: candidate.id,
          candidateHash: candidate.hash,
          ...identity,
          review,
          passed: review.outcome === 'passed',
          artifactId: artifact.id,
        });
        this.store.transaction(() => {
          this.saveArtifacts([artifact]);
          this.store.db
            .prepare(
              "INSERT OR REPLACE INTO evidence(candidate_id,kind,candidate_hash,definition_hash,evaluator,body) VALUES (?,'review',?,?,?,?)",
            )
            .run(
              candidate.id,
              candidate.hash,
              check.definitionHash,
              check.evaluator,
              canonicalJson(check),
            );
          const task = this.store.get<Task>('task', run.taskId) as Task;
          this.event('review.completed', task.id, task.revision, check);
          if (!check.passed)
            this.updateTask(task, {
              state: 'failed',
              waitingReason: null,
              next: 'A selected scripted review failed or did not complete.',
            });
        });
        if (check.passed) this.dispatchReviews(writer, candidate);
      })
      .catch(() => {
        if (!this.closed)
          this.store.transaction(() => {
            const task = this.store.get<Task>('task', run.taskId) as Task;
            this.updateTask(task, {
              state: 'failed',
              waitingReason: null,
              next: 'Scripted review evidence could not be verified.',
            });
          });
      });
  }

  private afterChecks(writer: Attempt, candidate: Candidate, handoff: boolean) {
    if (this.closed || this.store.receipt(`native-run:${writer.runId}`)) return;
    if (this.store.receipt(`paused:${writer.runId}`)) {
      this.stoppedJob(writer);
      return;
    }
    if (handoff) {
      this.transfer(writer, candidate);
      return;
    }
    this.dispatchReviews(writer, candidate);
  }

  private taskArtifacts(taskId: string): Artifact[] {
    const all = this.store.list<Artifact>('artifact');
    const selected = new Map<string, Artifact>();
    let bytes = 0;
    const include = (value: Artifact) => {
      const artifact = ArtifactSchema.parse(value);
      const registered = this.store.get<Artifact>('artifact', artifact.id);
      if (!registered || hashCanonical(registered) !== hashCanonical(artifact))
        throw new Error('Handoff artifact metadata is not registered.');
      if (selected.has(artifact.id)) return;
      const content = this.artifacts.read(artifact.hash);
      if (content.length !== artifact.bytes) throw new Error('Handoff artifact size changed.');
      bytes += artifact.bytes;
      if (selected.size >= 1000 || bytes > 64 * 1024 * 1024)
        throw new Error('Handoff artifact closure exceeds its finite bound.');
      selected.set(artifact.id, artifact);
    };
    const byId = (id: string) => {
      const artifact = this.store.get<Artifact>('artifact', id);
      if (!artifact) throw new Error('A referenced handoff artifact is missing.');
      include(artifact);
      return artifact;
    };
    const candidates = this.store
      .list<Candidate>('candidate')
      .filter((value) => value.taskId === taskId);
    const evidenceRoot = (check: CheckResult) => {
      const candidate = candidates.find(
        (value) => value.id === check.candidateId && value.hash === check.candidateHash,
      );
      if (!candidate) throw new Error('Evidence lineage changed.');
      const metadata = byId(check.artifactId);
      if (metadata.mediaType === 'application/vnd.crewkite.check+json') {
        const content = JSON.parse(this.artifacts.read(metadata.hash).toString('utf8')) as {
          candidateId: string;
          candidateHash: string;
          definitionHash: string;
          evaluator: string;
          log: Artifact;
        };
        if (
          content.candidateId !== candidate.id ||
          content.candidateHash !== candidate.hash ||
          content.definitionHash !== check.definitionHash ||
          content.evaluator !== check.evaluator
        )
          throw new Error('Check metadata changed.');
        include(ArtifactSchema.parse(content.log));
      } else if (check.review) {
        const result = JSON.parse(this.artifacts.read(metadata.hash).toString('utf8'));
        if (hashCanonical(result) !== hashCanonical(check.review))
          throw new Error('Review metadata changed.');
      } else throw new Error('Check metadata type is unsupported.');
    };
    for (const candidate of candidates) {
      byId(candidate.artifactId);
      for (const file of this.evidence.read(candidate).files) {
        const artifact = all.find(
          (value) => value.hash === file.hash && value.bytes === file.bytes,
        );
        if (!artifact) throw new Error('Candidate file metadata is missing.');
        include(artifact);
      }
      const changes = this.store.receipt(`changes:${candidate.id}`)?.result.data;
      if (changes?.kind === 'changes') byId(changes.artifactId);
      for (const row of this.store.db
        .prepare('SELECT body FROM evidence WHERE candidate_id=? AND candidate_hash=?')
        .all(candidate.id, candidate.hash))
        evidenceRoot(CheckResultSchema.parse(JSON.parse(row.body as string)));
    }
    for (const intent of this.store.intents().filter((intent) => intent.task_id === taskId)) {
      for (const key of [
        `native-run:${intent.run_id}`,
        ...['submission', 'proposal', 'application', 'completion'].map(
          (kind) => `native-${kind}:${intent.attempt_id}`,
        ),
      ]) {
        const artifact = this.store.receipt(key)?.result.entity;
        if (artifact && 'mediaType' in artifact) include(ArtifactSchema.parse(artifact));
      }
    }
    const received = this.store.db
      .prepare(
        "SELECT body FROM events WHERE task_id=? AND json_extract(body,'$.type') IN ('handoff.sealed','check.completed','review.completed','export.created') ORDER BY cursor LIMIT 1001",
      )
      .all(taskId);
    if (received.length > 1000)
      throw new Error('Handoff artifact history exceeds its finite bound.');
    for (const row of received) {
      const event = EventSchema.parse(JSON.parse(row.body as string));
      if (event.type === 'handoff.sealed') {
        if (event.payload.packet.taskId !== taskId)
          throw new Error('Handoff history belongs to another task.');
        for (const artifact of event.payload.packet.artifacts) include(artifact);
      } else if (event.type === 'check.completed' || event.type === 'review.completed')
        evidenceRoot(event.payload);
      else if (event.type === 'export.created') include(event.payload);
    }
    return [...selected.values()];
  }

  private contextPacket(
    writer: Attempt,
    candidate: Candidate,
    checked: boolean,
    manualNativeRouteIds?: readonly string[],
  ): SealedHandoffPacket {
    const run = this.store.get<Run>('run', writer.runId) as Run;
    const task = this.store.get<Task>('task', run.taskId) as Task;
    if (this.hasUncertainWriter(task.id)) throw new Error('Context sealing requires quiescence.');
    const packet = buildHandoff({
      run,
      outgoing: writer,
      quiescent: true,
      ...(manualNativeRouteIds ? { manualNativeRouteIds } : {}),
      packet: {
        version: 1,
        id: this.id('hnd'),
        taskId: task.id,
        runId: run.id,
        attemptId: writer.id,
        generation: writer.generation,
        outcome: task.outcome,
        criteria: task.criteria,
        decisions: [
          checked
            ? 'Stopped at the configured reserve. Exact candidate checks passed.'
            : 'Retained bytes were captured after positive process-group absence. Current checks and selected reviews remain required.',
        ],
        deniedActions: this.store
          .list<Approval>('approval')
          .filter((approval) => approval.taskId === task.id && approval.status === 'denied')
          .map(({ action, target }) => ({ action, target })),
        source: run.source,
        candidate,
        artifacts: this.taskArtifacts(task.id),
        unfinished: ['Continue the saved task inside its bounded run.'],
        unverified: checked
          ? ['Final selected reviews are pending.']
          : ['Retained partial work needs current checks and selected reviews.'],
        failedChecks: this.checks(candidate)
          .filter((check) => !check.passed)
          .map((check) => check.definitionHash),
        unrunChecks: checked ? [] : ['node --test'],
        scope: [task.title],
        remainingBudgets: this.remaining(run),
        unresolvedExposure: [],
        policy: run.policy,
        allowedRouteIds: manualNativeRouteIds
          ? [...manualNativeRouteIds]
          : [...new Set(run.roles.flatMap((role) => [role.routeId, ...role.approvedFallbacks]))],
        createdAt: this.now(),
      },
    });
    if (Buffer.byteLength(canonicalJson(packet)) > MAX_FRAME_BYTES - 65536)
      throw new Error('The handoff context exceeds its bounded worker frame.');
    return packet;
  }

  private pendingSwitch(run: Run): string | undefined {
    const receipt = this.store.receipt(`switch:${run.id}`);
    if (receipt?.result.outcome !== 'outcome-unknown') return;
    const frozen = RunSchema.parse(receipt.result.entity);
    if (
      frozen.id !== run.id ||
      frozen.taskId !== run.taskId ||
      hashCanonical({ source: frozen.source, policy: frozen.policy, roles: frozen.roles }) !==
        hashCanonical({ source: run.source, policy: run.policy, roles: run.roles })
    )
      throw new Error('The saved switch no longer matches this run.');
    return frozen.decision.chosen ?? undefined;
  }

  private switchRoute(
    command: Extract<Command, { command: 'SwitchRoute' }>,
    effects: (() => void)[],
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId);
    const run = this.store.get<Run>('run', command.payload.runId);
    if (!task || !run || task.runId !== run.id || run.taskId !== task.id)
      return { outcome: 'blocked', reason: 'run-not-current' };
    const coder = run.roles.find((role) => role.role === 'coder');
    const target = command.payload.routeId;
    if (!coder || ![coder.routeId, ...coder.approvedFallbacks].includes(target))
      return {
        outcome: 'denied',
        reason: 'route-not-approved',
        next: 'Choose a saved coder route or prepare a new bounded run.',
      };
    if (this.pendingSwitch(run))
      return {
        outcome: 'blocked',
        reason: 'switch-already-pending',
        next: 'Resume to recheck the saved target, or stop to cancel it.',
      };
    const last = this.store
      .intents()
      .filter((intent) => intent.run_id === run.id)
      .at(-1);
    if (last && last.scratch_path !== join(this.home, 'scratch', run.id))
      return {
        outcome: 'blocked',
        reason: 'pending-evaluator-stage',
        next: 'Stop the check or review explicitly. A route switch cannot replace it with a coder.',
      };
    if (task.state === 'unknown')
      return {
        outcome: 'blocked',
        reason: 'writer-ownership-unknown',
        next: 'Prove the prior process group is gone before switching.',
      };
    if (!last || !['running', 'waiting', 'stopped', 'interrupted'].includes(task.state))
      return {
        outcome: 'blocked',
        reason: 'switch-needs-writer',
        next: 'Switch only an active or stopped coding attempt in the current run.',
      };
    if (this.store.receipt(`native-run:${run.id}`))
      return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
    const runtime = this.workers.get(last.attempt_id);
    if (last.state !== 'stopped' && !runtime)
      return {
        outcome: 'blocked',
        reason: 'writer-ownership-unknown',
        next: 'Prove the outgoing process group is gone before switching.',
      };
    if (last.route_id === target)
      return {
        outcome: 'blocked',
        reason: 'route-already-current',
        next: 'Choose another saved coder route.',
      };
    const route = this.store.get<Route>('route', target);
    if (!route?.fake || !route.qualified)
      return {
        outcome: 'blocked',
        reason: 'route-not-admissible',
        next: 'Choose a qualified scripted route.',
      };
    // Preflight excludes only this writer's held capacity. Admission repeats after proven stop.
    if (!this.routing(run, 'coder', target, runtime ? last.attempt_id : undefined).chosen)
      return {
        outcome: 'blocked',
        reason: 'route-not-admissible',
        next: `Selected route ${target} cannot pass the saved pin, allowance or slot gates. The current writer keeps its ownership.`,
      };
    this.closePendingEffects(task);
    this.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run(`switch:${run.id}`);
    this.store.saveReceipt(
      `switch:${run.id}`,
      hashCanonical({ runId: run.id, target }),
      'local-owner',
      {
        outcome: 'outcome-unknown',
        entity: {
          ...run,
          decision: {
            chosen: target,
            rejected: [],
            rule: 'manual',
            inputsHash: hashCanonical({ runId: run.id, target }),
          },
        },
      },
    );
    const updated = this.updateTask(task, {
      state: runtime ? 'stopping' : 'stopped',
      waitingReason: null,
      next: `Selected route ${target} is saved. Stop the outgoing writer, then recheck the original policy and remaining limits.`,
    });
    const writer = this.store.get<Attempt>('attempt', last.attempt_id) as Attempt;
    if (runtime?.kind === 'native')
      return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
    if (runtime) {
      runtime.reason = 'switch';
      effects.push(() => {
        void runtime.worker
          .stop({ schedule: this.options.schedule })
          .then((exit) => this.finishAttempt(writer.id, exit.quiescent));
      });
    } else effects.push(() => this.continueSwitch(writer));
    return { outcome: 'applied', entity: updated, revision: updated.revision };
  }

  private continueSwitch(writer: Attempt) {
    if (this.closed || this.store.receipt(`native-run:${writer.runId}`)) return;
    const run = this.store.get<Run>('run', writer.runId) as Run;
    const target = this.pendingSwitch(run);
    if (!target) return;
    try {
      this.prepareResumeContext(run.taskId, run.id);
    } catch {
      this.store.transaction(() =>
        this.updateTask(this.store.get<Task>('task', run.taskId) as Task, {
          state: 'stopped',
          waitingReason: null,
          next: `Selected route ${target} has no readable retained context. Inspect the saved work, then resume to retry or stop to cancel.`,
        }),
      );
      return;
    }
    const effects: (() => void)[] = [];
    this.store.transaction(() => {
      const task = this.store.get<Task>('task', run.taskId) as Task;
      if (this.store.receipt(`paused:${run.id}`)) {
        this.updateTask(task, {
          state: 'stopped',
          waitingReason: null,
          next: `Selected route ${target} is retained. Admissions are paused. Resume explicitly to recheck, or stop to cancel.`,
        });
        return;
      }
      const command = CommandSchema.parse({
        protocol: 1,
        key: this.id('cmd'),
        actor: { id: 'controller', kind: 'controller' },
        command: 'ResumeRun',
        expectedRevision: task.revision,
        payload: { taskId: task.id, runId: run.id },
      });
      const result = this.start(command as Extract<Command, { command: 'ResumeRun' }>, effects);
      if (result.outcome !== 'applied')
        this.updateTask(this.store.get<Task>('task', task.id) as Task, {
          state: 'stopped',
          waitingReason: null,
          next:
            result.next ??
            'The saved target could not be admitted. Resume to recheck, or stop to cancel the switch.',
        });
    });
    for (const effect of effects) effect();
  }

  private resumeGate(task: Task, runId: string): CommandResult | undefined {
    const pending = this.store.db
      .prepare(
        "SELECT approval_id FROM pending_effects WHERE task_id=? AND state='pending' LIMIT 1",
      )
      .get(task.id);
    if (pending)
      return {
        outcome: 'blocked',
        reason: 'approval-already-pending',
        next: 'Resolve the exact pending action before continuing.',
      };
    const last = this.store
      .intents()
      .filter((intent) => intent.run_id === runId)
      .at(-1);
    if (
      task.state === 'waiting' ||
      (last && last.scratch_path !== join(this.home, 'scratch', runId))
    )
      return {
        outcome: 'blocked',
        reason: 'pending-evaluator-stage',
        next: 'Inspect or export retained work, then stop and prepare a new bounded run for the pending checks or review.',
      };
  }

  private prepareResumeContext(taskId: string, runId: string) {
    if (this.store.receipt(`native-run:${runId}`))
      throw new Error('The native pilot permits retention and export only.');
    const task = this.store.get<Task>('task', taskId);
    const run = this.store.get<Run>('run', runId);
    if (
      !task ||
      !run ||
      task.runId !== run.id ||
      run.taskId !== task.id ||
      this.hasUncertainWriter(taskId)
    )
      return;
    const intent = this.store
      .intents()
      .filter(
        (value) =>
          value.run_id === runId && value.scratch_path === join(this.home, 'scratch', runId),
      )
      .at(-1);
    if (!intent) return;
    const writer = this.store.get<Attempt>('attempt', intent.attempt_id) as Attempt;
    if (writer.state !== 'stopped') throw new Error('The prior writer is not stopped.');
    if (!existsSync(intent.scratch_path)) {
      const candidate = this.store.receipt(`candidate:${writer.id}`)?.result.entity as
        | Candidate
        | undefined;
      if (!candidate) throw new Error('No sealed retained bytes exist for this writer.');
      materialize(intent.scratch_path, this.evidence.read(candidate).files);
    }
    const candidate = this.sealCandidate(writer);
    const packet = this.contextPacket(writer, candidate, false);
    this.store.transaction(() => this.event('handoff.sealed', task.id, task.revision, packet));
  }

  private latestContext(runId: string): SealedHandoffPacket | undefined {
    const row = this.store.db
      .prepare(
        "SELECT body FROM events WHERE json_extract(body,'$.type')='handoff.sealed' AND json_extract(body,'$.payload.packet.runId')=? ORDER BY cursor DESC LIMIT 1",
      )
      .get(runId);
    if (!row) return;
    const event = EventSchema.parse(JSON.parse(row.body as string));
    return event.type === 'handoff.sealed' ? event.payload : undefined;
  }

  private transfer(writer: Attempt, candidate: Candidate) {
    const run = this.store.get<Run>('run', writer.runId) as Run;
    const task = this.store.get<Task>('task', run.taskId) as Task;
    if (this.store.receipt(`native-run:${run.id}`))
      throw new Error('The native pilot permits retention and export only.');
    if (this.hasUncertainWriter(task.id)) throw new Error('Handoff requires quiescence.');
    const outgoing = this.store.get<Attempt>('attempt', writer.id) as Attempt;
    const packet = this.contextPacket(outgoing, candidate, true);
    const effects: (() => void)[] = [];
    this.store.transaction(() => {
      this.event('handoff.sealed', task.id, task.revision, packet);
      const stopped = this.updateTask(task, {
        state: 'stopped',
        waitingReason: null,
        next: 'The handoff is sealed. Admitting the successor through the saved policy.',
      });
      const command = CommandSchema.parse({
        protocol: 1,
        key: this.id('cmd'),
        actor: { id: 'controller', kind: 'controller' },
        command: 'ResumeRun',
        expectedRevision: stopped.revision,
        payload: { taskId: task.id, runId: run.id },
      });
      const result = this.start(
        command as Extract<Command, { command: 'ResumeRun' }>,
        effects,
        undefined,
        undefined,
        true,
      );
      if (result.outcome !== 'applied')
        this.updateTask(this.store.get<Task>('task', task.id) as Task, {
          state: 'waiting',
          waitingReason: 'capacity',
          next: result.next ?? result.reason ?? 'No successor route is available.',
        });
    });
    for (const effect of effects) effect();
  }

  private accept(
    command: Extract<Command, { command: 'AcceptCandidate' }>,
    effects: (() => void)[],
    approved?: string,
    frozenIdentity?: GitIdentity,
    frozenAt?: string,
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId) as Task;
    const run = this.store.get<Run>('run', task.runId as string) as Run;
    const candidate = this.store.get<Candidate>(
      'candidate',
      command.payload.candidateId,
    ) as Candidate;
    let native: ReturnType<Controller['nativePublicationEvidence']> | undefined;
    if (this.store.receipt(`native-run:${run.id}`)) {
      try {
        native = this.nativePublicationEvidence(run, candidate);
      } catch {
        return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
      }
    }
    if (!['ready', 'accepted', 'waiting', ...(native ? ['stopped'] : [])].includes(task.state))
      return { outcome: 'blocked', reason: 'candidate-not-ready' };
    if (
      this.hasUncertainWriter(task.id) ||
      this.evidence.hash(run.source.base, readFiles(this.writerScratch(run))) !== candidate.hash
    )
      return { outcome: 'blocked', reason: 'candidate-binding-changed' };
    const path = this.projectPath(task.projectId) as string;
    if (hashCanonical(inspectSource(task.projectId, path)) !== hashCanonical(run.source))
      return { outcome: 'blocked', reason: 'source-preview-changed' };
    const prior = this.store.db
      .prepare('SELECT * FROM publications WHERE candidate_id=?')
      .get(candidate.id);
    if (prior) {
      if (
        prior.destination_ref !== command.payload.destinationRef ||
        prior.candidate_hash !== candidate.hash
      )
        return { outcome: 'denied', reason: 'publication-binding-changed' };
      effects.push(() => this.reconcilePublication(candidate.id, command.key));
      return {
        outcome: 'outcome-unknown',
        reason: 'publication-prepared',
        next: 'Recover this exact publication before creating another branch.',
      };
    }
    if (refValue(path, command.payload.destinationRef) !== null)
      return {
        outcome: 'blocked',
        reason: 'destination-ref-exists',
        next: 'Choose an unused local branch name.',
      };
    if (native) {
      try {
        this.nativePublicationCurrent(run, candidate, native);
      } catch {
        return { outcome: 'blocked', reason: 'native-evidence-not-current' };
      }
    } else {
      const plan = this.evidence.prepareChecks({
        candidate,
        sourceFiles: committedFiles(path, run.source.base),
        criteria: task.criteria,
      });
      if (!this.checks(candidate).some((check) => this.checkMatches(check, candidate, plan)))
        return { outcome: 'blocked', reason: 'checks-not-current' };
      const reviews = this.store.db
        .prepare(
          "SELECT body FROM evidence WHERE candidate_id=? AND candidate_hash=? AND kind='review'",
        )
        .all(candidate.id, candidate.hash)
        .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)));
      for (const method of run.policy.policy.methods ?? [])
        for (let cycle = 1; cycle <= method.cycles; cycle++)
          if (!reviews.some((check) => this.reviewMatches(check, run, method, cycle, candidate)))
            return { outcome: 'blocked', reason: 'selected-review-not-complete' };
    }
    const identity =
      frozenIdentity ??
      (typeof this.options.identity === 'function'
        ? this.options.identity()
        : this.options.identity);
    if (!identity)
      return {
        outcome: 'blocked',
        reason: 'git-identity-missing',
        next: 'Configure a Git name and email before acceptance.',
      };
    validateIdentity(identity);
    const at = frozenAt ?? this.now();
    const grant = this.grant(run, 'accept-candidate', command.payload.destinationRef);
    const writerIntent = this.store
      .intents()
      .filter(
        (intent) => intent.run_id === run.id && intent.scratch_path === this.writerScratch(run),
      )
      .at(-1);
    const writer =
      native?.writer ??
      (writerIntent ? this.store.get<Attempt>('attempt', writerIntent.attempt_id) : undefined);
    if (!writer) return { outcome: 'blocked', reason: 'candidate-origin-missing' };
    if (!grant && !approved)
      return this.requestAction(
        task,
        run,
        writer,
        'accept-candidate',
        command.payload.destinationRef,
        {
          kind: 'accept',
          command,
          candidateId: candidate.id,
          candidateHash: candidate.hash,
          identity,
          at,
        },
      );
    const repository = mkdtempSync(join(this.home, 'publication-'));
    const prepared = preparePublication({
      source: path,
      repository,
      base: run.source.base,
      files: this.evidence.read(candidate).files,
      identity,
      at,
    });
    const artifact = {
      id: this.id('art'),
      ...this.artifacts.publish(prepared.pack),
      mediaType: 'application/vnd.git.pack',
    };
    this.saveArtifacts([artifact]);
    this.store.saveReceipt(
      `publication-run:${candidate.id}`,
      hashCanonical({
        runId: run.id,
        candidateHash: candidate.hash,
        identity,
        at,
        destinationRef: command.payload.destinationRef,
      }),
      'local-owner',
      { outcome: 'applied', entity: run },
    );
    this.store.saveReceipt(`publication-pack:${candidate.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    this.store.db
      .prepare(
        "INSERT INTO publications(candidate_id,project_id,destination_ref,candidate_hash,tree_oid,commit_oid,state) VALUES (?,?,?,?,?,?,'prepared')",
      )
      .run(
        candidate.id,
        task.projectId,
        command.payload.destinationRef,
        candidate.hash,
        prepared.treeOid,
        prepared.commitOid,
      );
    if (grant) this.consumeGrant(run, grant);
    if (approved)
      this.store.db
        .prepare("UPDATE pending_effects SET state='applied' WHERE approval_id=?")
        .run(approved);
    effects.push(() => this.reconcilePublication(candidate.id, command.key));
    return {
      outcome: 'outcome-unknown',
      reason: 'publication-prepared',
      next: 'Read the exact publication result before retrying.',
    };
  }

  private reconcilePublication(candidateId: string, resultKey?: string) {
    const publication = this.store.db
      .prepare('SELECT * FROM publications WHERE candidate_id=?')
      .get(candidateId);
    if (!publication) return;
    const candidate = this.store.get<Candidate>('candidate', candidateId) as Candidate;
    const task = this.store.get<Task>('task', candidate.taskId) as Task;
    try {
      if (this.hasUncertainWriter(task.id)) throw new Error('Writer ownership is unknown.');
      const artifact = this.store.receipt(`publication-pack:${candidateId}`)?.result.entity as
        | Artifact
        | undefined;
      if (!artifact || !this.store.get<Artifact>('artifact', artifact.id))
        throw new Error('Publication bytes are missing.');
      const origin = this.store.receipt(`publication-run:${candidateId}`)?.result.entity as
        | Run
        | undefined;
      const native =
        origin && this.store.receipt(`native-run:${origin.id}`)
          ? this.nativePublicationEvidence(origin, candidate)
          : undefined;
      const source = this.projectPath(task.projectId) as string;
      const observed = refValue(source, publication.destination_ref as string);
      if (observed !== publication.commit_oid) {
        const currentRun = task.runId ? this.store.get<Run>('run', task.runId) : undefined;
        if (
          !origin ||
          !currentRun ||
          origin.id !== currentRun.id ||
          hashCanonical(origin.policy) !== hashCanonical(currentRun.policy) ||
          hashCanonical(origin.source) !== hashCanonical(currentRun.source) ||
          this.latestCandidate(currentRun.id)?.id !== candidate.id ||
          this.evidence.hash(currentRun.source.base, readFiles(this.writerScratch(currentRun))) !==
            candidate.hash ||
          hashCanonical(inspectSource(task.projectId, source)) !== hashCanonical(origin.source)
        )
          throw new Error('Prepared publication authority is no longer current.');
        if (native) this.nativePublicationCurrent(currentRun, candidate, native);
      }
      applyPublication({
        source: this.projectPath(task.projectId) as string,
        pack: this.artifacts.read(artifact.hash),
        destinationRef: publication.destination_ref as string,
        treeOid: publication.tree_oid as string,
        commitOid: publication.commit_oid as string,
        base: this.evidence.read(candidate).base,
      });
      this.store.transaction(() => {
        this.store.db
          .prepare("UPDATE publications SET state='applied' WHERE candidate_id=?")
          .run(candidateId);
        const current = this.store.get<Task>('task', task.id) as Task;
        const belongs =
          !!origin &&
          current.runId === origin.id &&
          this.latestCandidate(origin.id)?.id === candidate.id;
        const updated =
          belongs && current.state !== 'accepted'
            ? this.updateTask(current, {
                state: 'accepted',
                waitingReason: null,
                next: `Accepted to ${publication.destination_ref as string}.`,
              })
            : current;
        if (belongs && current.state !== 'accepted')
          this.event('candidate.accepted', task.id, updated.revision, {
            candidateId,
            destinationRef: publication.destination_ref as string,
          });
        if (resultKey)
          this.store.db.prepare('UPDATE receipts SET result=? WHERE command_key=?').run(
            canonicalJson(
              CommandResultSchema.parse(
                belongs
                  ? { outcome: 'applied', entity: updated, revision: updated.revision }
                  : {
                      outcome: 'applied',
                      entity: candidate,
                      next: 'The prior publication was verified. The current run keeps its state.',
                    },
              ),
            ),
            resultKey,
          );
      });
    } catch {
      if (resultKey)
        this.store.transaction(() => {
          this.store.db.prepare('UPDATE receipts SET result=? WHERE command_key=?').run(
            canonicalJson({
              outcome: 'outcome-unknown',
              reason: 'publication-not-reconciled',
              next: 'Inspect the exact destination branch and retry this command key.',
            }),
            resultKey,
          );
        });
    }
  }

  private exportPatch(
    command: Extract<Command, { command: 'ExportPatch' }>,
    approved?: string,
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId) as Task;
    const run = this.store.get<Run>('run', task.runId as string) as Run;
    const candidate = this.store.get<Candidate>(
      'candidate',
      command.payload.candidateId,
    ) as Candidate;
    const grant = this.grant(run, 'export-patch', task.id);
    if (!grant && !approved) {
      const writer = this.store
        .intents()
        .filter(
          (intent) => intent.run_id === run.id && intent.scratch_path === this.writerScratch(run),
        )
        .at(-1);
      if (!writer) return { outcome: 'blocked', reason: 'candidate-origin-missing' };
      return this.requestAction(
        task,
        run,
        this.store.get<Attempt>('attempt', writer.attempt_id) as Attempt,
        'export-patch',
        task.id,
        { kind: 'export', command, candidateId: candidate.id, candidateHash: candidate.hash },
      );
    }
    const data = this.store.receipt(`changes:${candidate.id}`)?.result.data;
    if (data?.kind !== 'changes') return { outcome: 'blocked', reason: 'patch-not-ready' };
    const artifact = this.store.get<Artifact>('artifact', data.artifactId);
    if (!artifact) return { outcome: 'blocked', reason: 'patch-artifact-missing' };
    this.artifacts.read(artifact.hash);
    if (grant) this.consumeGrant(run, grant);
    if (approved)
      this.store.db
        .prepare("UPDATE pending_effects SET state='applied' WHERE approval_id=?")
        .run(approved);
    this.event('export.created', task.id, task.revision, artifact);
    return { outcome: 'applied', entity: artifact };
  }

  private projectPath(projectId: string): string | undefined {
    return this.store.db.prepare('SELECT path FROM project_paths WHERE project_id=?').get(projectId)
      ?.path as string | undefined;
  }

  private event(
    type: Event['type'],
    taskId: string | null,
    revision: number,
    payload: Event['payload'],
  ) {
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
