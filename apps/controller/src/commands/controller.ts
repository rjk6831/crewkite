import { spawn } from 'node:child_process';
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
import { arch, cpus, freemem, platform, totalmem } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
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
  CONVERSATION_CONTEXT_MEDIA_TYPE,
  type CombinedCheckContextSchema,
  CombinedDispatchPhaseSchema,
  type CombinedNativeReviewJob,
  CombinedNativeReviewJobSchema,
  type CombinedOrigin,
  CombinedOriginSchema,
  type CombinedRunPreview,
  CombinedRunPreviewSchema,
  type Command,
  CommandIdSchema,
  type CommandResult,
  CommandResultSchema,
  CommandSchema,
  ConversationContextBundleSchema,
  type ConversationContextRefs,
  ConversationContextUsageSchema,
  ConversationEntrySchema,
  type ConversationModelCatalog,
  ConversationModelCatalogSchema,
  type ConversationModelChoices,
  type ConversationModelReason,
  type ConversationModelRequest,
  ConversationModelRequestSchema,
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
  LocalAuthModeSchema,
  LocalEndpointSchema,
  type LocalHardwareStatus,
  LocalHardwareStatusSchema,
  LocalModelObservationSchema,
  LocalModelSelectionSchema,
  LocalNativeProfileSchema,
  LocalObservedModelBindingSchema,
  type LocalSetup,
  LocalSetupSchema,
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
  NativeTargetContextLinesSchema,
  type Observation,
  ObservationSchema,
  type Policy,
  PolicySchema,
  PrepareCombinedRunPayloadSchema,
  type Project,
  ProjectSchema,
  RemainingBudgetsSchema,
  type ReviewJob,
  ReviewJobSchema,
  ReviewMethodIdSchema,
  ReviewMethodSchema,
  type ReviewResult,
  ReviewResultSchema,
  RevisionSchema,
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
  type SnapshotScope,
  SnapshotScopeSchema,
  SourceSchema,
  type Task,
  type TaskConversationState,
  TaskConversationStateSchema,
  TaskIdSchema,
  TaskSchema,
  TimestampSchema,
  UsageReaderSchema,
  WorkspaceStateSchema,
} from '@crewkite/contracts';
import { hashCanonical, verifyHandoff } from '@crewkite/contracts/hash';
import { fakeReviewWorkerPath, fakeWorkerPath } from '@crewkite/testkit/worker';
import { z } from 'zod';
import { ArtifactFiles } from '../artifacts/index.ts';
import { buildHandoff } from '../continuity/index.ts';
import { captureConversationContext } from '../conversation/context.ts';
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
  frozenVerificationPath,
  prepareToolchain,
  type ToolchainPreparation,
  verificationGuidance,
  verificationPreview,
  verificationTarget,
} from '../evidence/toolchain-definition.ts';
import { ToolchainVerification } from '../evidence/toolchain-verify.ts';
import { type CheckOwner, inspectCheckRoots, parseCheckOwner } from '../host/check-ownership.ts';
import { applyFormatting, FormattingSchema, noFormatting, planFormatting } from '../host/format.ts';
import { assembleSlices } from '../host/integration.ts';
import {
  createIntegrationGit,
  type IntegrationGitOptions,
  type IntegrationGitOutcome,
} from '../host/integration-git.ts';
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
  readCandidateFiles,
  readFiles,
} from '../host/source.ts';
import type { DependencyInventory } from '../host/toolchain.ts';
import {
  checkRootQuiescent,
  closedBefore,
  closedWithin,
  defaultSchedule,
  groupAbsent,
  OwnedCommand,
  OwnedWorker,
  type Schedule,
} from '../host/worker.ts';
import {
  ConnectionRecordSchema,
  NativeConnectionChecks,
} from '../providers/anthropic/native-connection.ts';
import {
  type NativeLifecycle as AnthropicLifecycle,
  startNativeAuthStatus,
} from '../providers/anthropic/native-discovery.ts';
import { subscriptionAuth } from '../providers/anthropic/profile.ts';
import {
  replacementPlan as anthropicReplacementPlan,
  startReplacement as startAnthropicReplacement,
} from '../providers/anthropic/replacement.ts';
import { AcpDiagnosticSchema } from '../providers/google/acp/client.ts';
import type { AcpInstallDependencies } from '../providers/google/acp/install.ts';
import {
  GoogleAcpInstallation,
  InstallRecordSchema,
} from '../providers/google/acp/install-operation.ts';
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
  acpPermissionAfterHash,
  googleAcpTargetContext,
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
  googleQuotaWindows,
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
  localConfiguredConnectionHash,
  resolveLocalConnection,
} from '../providers/local/connection.ts';
import {
  BindingSchema as LocalBindingSchema,
  type LocalStart,
  TerminalSchema as LocalTerminalSchema,
  localPlan,
  localTests,
} from '../providers/local/profile.ts';
import { startLocalDiscovery, startLocalReplacement } from '../providers/local/replacement.ts';
import {
  type LocalInputHelper,
  type LocalInputResult,
  startLocalSecretInput,
} from '../providers/local/secure-input.ts';
import {
  type ConversationPlan,
  conversationBindingHash,
  conversationPlan,
  startConversation,
} from '../providers/openai/conversation.ts';
import { OpenAiDiscovery } from '../providers/openai/discovery.ts';
import {
  type RetainedOpenAiModelObservation,
  resolveOpenAiProjectSelection,
} from '../providers/openai/execution-selection.ts';
import { startNativeSession } from '../providers/openai/native-discovery.ts';
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
import {
  type ReviewPlan,
  repositoryReviewBudget,
  reviewPlan,
  startReview,
} from '../providers/openai/review.ts';
import { chooseRoute } from '../routing/index.ts';
import { activityBodyChunks, taskActivityOutputPage, taskActivityPage } from '../store/activity.ts';
import { createIds, type IdPrefix } from '../store/ids.ts';
import {
  type CombinedDispatch,
  type CombinedGroup,
  type CombinedMember,
  type LaunchIntent,
  type NativeProcess,
  Store,
} from '../store/index.ts';
import { projectPage, taskPage } from '../store/workspace.ts';
import { availableAllowance, deriveWindow } from '../usage/index.ts';
import {
  chargedIntegrationMinutes,
  chargedMinutes,
  remainingBudgets,
  remainingCombinedBudgets,
  unspentIntegrationMinutes,
} from './budgets.ts';
import {
  type TaskOperationCommand,
  TaskOperations,
  taskOperationSummary,
} from './task-operations.ts';

// A repository writer leaves this long for the verify check and review that follow it.
const evaluationFloorMinutes = 11;
// Owned cleanup escalates to SIGKILL within a second. A minute covers a slow host and matches the
// whole-minute granularity of the minute ledger.
const cleanupReserveMs = 60_000;
const localHardwareStatus = (sampledAt: string): LocalHardwareStatus => {
  const processors = cpus();
  const model = processors.find((processor) => processor.model.trim())?.model.trim() ?? null;
  const cpuModel =
    model?.isWellFormed() === true &&
    !/\p{Cc}/u.test(model) &&
    new TextEncoder().encode(model).length <= 200
      ? model
      : null;
  const architecture = arch();
  const operatingSystem = platform();
  const totalMemory = totalmem();
  const availableMemory = freemem();
  return LocalHardwareStatusSchema.parse({
    cpuModel,
    logicalCores: processors.length > 0 && processors.length <= 4096 ? processors.length : null,
    architecture: /^[A-Za-z0-9._-]{1,32}$/.test(architecture) ? architecture : null,
    platform: /^[A-Za-z0-9._-]{1,32}$/.test(operatingSystem) ? operatingSystem : null,
    totalMemoryBytes: Number.isSafeInteger(totalMemory) && totalMemory > 0 ? totalMemory : null,
    availableMemoryBytes:
      Number.isSafeInteger(availableMemory) &&
      availableMemory >= 0 &&
      Number.isSafeInteger(totalMemory) &&
      totalMemory > 0 &&
      availableMemory <= totalMemory
        ? availableMemory
        : null,
    sampledAt,
  });
};
const nativeProviderRestriction: CommandResult = {
  outcome: 'blocked',
  reason: 'provider-policy-restricted',
  next: 'Choose another profile or continue manually in the provider native app. Retained evidence remains available.',
};
const combinedFile = z.strictObject({
  path: ReplacementPathSchema,
  mode: z.enum(['100644', '100755']),
  hash: HashSchema,
  bytes: z.number().int().nonnegative().max(67108864),
});
const CombinedManifestSchema = z.strictObject({
  version: z.literal(1),
  input: PrepareCombinedRunPayloadSchema,
  run: RunSchema,
  task: TaskSchema,
  sourceFiles: z.array(combinedFile).max(10000),
  members: z.tuple([
    z.strictObject({ task: TaskSchema, run: RunSchema, preparation: ArtifactSchema }),
    z.strictObject({ task: TaskSchema, run: RunSchema, preparation: ArtifactSchema }),
  ]),
  reviewer: z.strictObject({
    route: RouteSchema,
    profile: NativeProfileSchema,
    client: z.strictObject({
      executable: z.string().max(4096).refine(isAbsolute),
      sha256: HashSchema,
      version: z.string().min(1).max(200),
    }),
    locationHash: HashSchema,
  }),
  git: z.strictObject({ executable: z.string().max(4096).refine(isAbsolute), sha256: HashSchema }),
  expiresAt: TimestampSchema,
});
type CombinedManifest = z.infer<typeof CombinedManifestSchema>;
const CombinedRefJournalSchema = z.strictObject({
  phases: z
    .array(
      z.strictObject({
        sequence: z.number().int().nonnegative(),
        kind: z.string().min(1).max(100),
        digest: HashSchema,
        state: z.enum(['intent', 'owned', 'quiescent']),
        group: z.number().int().positive().nullable(),
      }),
    )
    .max(10),
  value: z.union([z.string().max(40), z.boolean(), z.null()]).optional(),
});

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
    modelRequest: ConversationModelRequestSchema.optional(),
    maximumTaskMs: z.number().int().min(2001).max(600_000),
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
  maximumTaskMs: z.number().int().min(2001).max(600000),
  contextLines: NativeTargetContextLinesSchema.optional(),
  client: AcpClientPinSchema.extend({
    executable: z.string().max(4096).refine(isAbsolute),
    harnessSha256: HashSchema,
  }),
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
    maximumCheckMinutes: z.union([z.literal(1), z.literal(10)]),
    verification: z
      .strictObject({ source: z.string().max(4096).refine(isAbsolute), inventory: ArtifactSchema })
      .optional(),
    scopeHash: HashSchema,
    expiresAt: TimestampSchema,
  })
  .refine((plan) =>
    plan.definition.recipeId === 'crewkite-verify-v1'
      ? plan.maximumCheckMinutes === 10 &&
        !!plan.verification &&
        plan.verification.inventory.hash === plan.definition.inventory.hash &&
        plan.verification.inventory.bytes === plan.definition.inventory.bytes
      : plan.maximumCheckMinutes === 1 && !Object.hasOwn(plan, 'verification'),
  );
const {
  writer: _combinedWriter,
  verification: _combinedVerification,
  ...combinedEvaluationShape
} = CandidateEvaluationSchema.shape;
const CombinedEvaluationSchema = z.strictObject({
  ...combinedEvaluationShape,
  origin: CombinedOriginSchema,
  maximumCheckMinutes: z.literal(1),
});
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
  ignoredNotifications?: Readonly<Record<string, number>>;
};

const nativeFailureNext = (outcome: NativeOutcome | null) => {
  if (outcome?.reason === 'provider') {
    const diagnostic =
      outcome.diagnostic && typeof outcome.diagnostic === 'object'
        ? (outcome.diagnostic as Record<string, unknown>)
        : null;
    const failure = z
      .strictObject({
        kind: z.literal('usage-limit'),
        rateLimitType: z
          .enum([
            'five_hour',
            'seven_day',
            'seven_day_opus',
            'seven_day_sonnet',
            'seven_day_overage_included',
          ])
          .nullable(),
        resetsAt: z.iso.datetime().nullable(),
      })
      .safeParse(diagnostic?.providerFailure);
    if (failure.success) {
      if (!failure.data.resetsAt)
        return 'Provider usage limit reached. Retry later or choose another available provider.';
      return `Provider usage limit reached. The provider reports that it resets at ${failure.data.resetsAt}. Retry after the reset or choose another available provider.`;
    }
    return 'The provider ended this work with an error. Inspect the retained task details before retrying or choose another available provider.';
  }
  if (
    outcome?.reason !== 'protocol' ||
    !outcome.diagnostic ||
    typeof outcome.diagnostic !== 'object'
  )
    return 'Native work is unverified. Inspect retained ownership and artifacts.';
  const diagnostic = outcome.diagnostic as Record<string, unknown>;
  const safe = (value: unknown) =>
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : null;
  const cause = safe(diagnostic.cause);
  const site = safe(diagnostic.site);
  const field = safe(diagnostic.field);
  if (!cause || !site)
    return 'Native work is unverified. Inspect retained ownership and artifacts.';
  return `Native output was refused by protocol checks at ${site}${field ? `.${field}` : ''} (${cause}). Inspect retained ownership and artifacts.`;
};

const NativeQuotaFailureSchema = z.strictObject({
  kind: z.literal('usage-limit'),
  rateLimitType: z.enum([
    'five_hour',
    'seven_day',
    'seven_day_opus',
    'seven_day_sonnet',
    'seven_day_overage_included',
  ]),
  resetsAt: z.iso.datetime(),
});
const NativeQuotaCompletionSchema = z.strictObject({
  attemptId: AttemptSchema.shape.id,
  reason: z.literal('provider'),
  quiescent: z.literal(true),
  diagnostic: z.strictObject({
    stage: z.literal('output'),
    site: z.literal('result'),
    cause: z.literal('provider-error'),
    envelope: z.string(),
    subtype: z.string().nullable(),
    field: z.literal('is_error'),
    providerFailure: NativeQuotaFailureSchema,
  }),
  ignoredNotifications: z.record(z.string(), z.number()).optional(),
});
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
  job: NativeReviewJob | CombinedNativeReviewJob;
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
  modelCatalog: ConversationModelRequestSchema.shape.observation.optional(),
  modelFailure: z.enum(['model-unavailable', 'effort-unavailable']).optional(),
});
type ConversationConfiguration = z.infer<typeof ConversationConfigurationSchema>;
type ConversationModelFailureReason = Exclude<
  ConversationModelReason,
  'available' | 'not-observed'
>;
type ConversationRuntime = {
  input: ConversationPlan;
  attempt: Attempt;
  authorityHash: string;
  stopped: boolean;
  handle?: ReturnType<typeof startConversation>;
  done: Promise<void>;
};

const LocalOperationBindingSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  operationId: CommandIdSchema,
  nonce: HashSchema,
  connectionHash: HashSchema,
  connectionRevision: RevisionSchema,
});
const LocalControlSchema = z.strictObject({
  authMode: LocalAuthModeSchema.default('token'),
  noneConnected: z.boolean().default(false),
  connectionFailed: z.boolean().default(false),
  revision: RevisionSchema,
  connectionRevision: RevisionSchema,
  endpoint: LocalEndpointSchema.nullable(),
  observation: LocalModelObservationSchema.nullable(),
  selection: LocalModelSelectionSchema.nullable(),
  setupHash: HashSchema.nullable(),
  operation: z
    .strictObject({
      kind: z.enum(['input', 'discovery']),
      binding: LocalOperationBindingSchema,
      state: z.enum(['intent', 'owned', 'stopping', 'unknown']),
      group: z.number().int().positive().safe().nullable(),
      revoked: z.boolean(),
      clientQuiescent: z.boolean(),
    })
    .refine((operation) => operation.binding.version === (operation.kind === 'input' ? 2 : 1))
    .nullable(),
});
type LocalControl = z.infer<typeof LocalControlSchema>;
type LocalOperationRuntime = {
  operationId: string;
  stopped: boolean;
  handle?: { stop: () => void };
  done: Promise<void>;
};
type LocalSecretCell = {
  connectionRevision: number;
  connectionHash: string;
  secret: Buffer;
};
const LocalPreparedSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('local-file'),
  run: RunSchema,
  attempt: AttemptSchema,
  profile: LocalNativeProfileSchema,
  endpoint: LocalEndpointSchema,
  localModel: LocalObservedModelBindingSchema,
  target: z.strictObject({ path: z.string().min(1).max(4096), baseHash: HashSchema }),
  manifest: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4096),
        mode: z.enum(['100644', '100755']),
        hash: HashSchema,
        bytes: RevisionSchema,
      }),
    )
    .max(10000),
  context: z.strictObject({
    title: z.string().min(1).max(200),
    outcome: z.string().min(1).max(4096),
    criteria: z.array(z.string().min(1).max(4096)).min(1).max(100),
  }),
  scopeHash: HashSchema,
  expiresAt: TimestampSchema,
});
type LocalPrepared = z.infer<typeof LocalPreparedSchema>;
type EvaluationWriterPreparation =
  | LocalPrepared
  | z.infer<typeof NativeHistoricalPreparationSchema>;
const ProviderUsageBatchSchema = z.strictObject({
  mode: z.enum(['partial', 'complete']),
  observedAt: TimestampSchema,
  observations: z.array(ObservationSchema).min(1).max(32),
});
const ProviderUsageDraftSchema = z.object({
  complete: z.boolean().optional(),
  windows: z
    .array(
      z.union([
        z.strictObject(ObservationSchema.shape).omit({ routeId: true, observedAt: true }),
        z.strictObject({
          windowId: ObservationSchema.shape.windowId,
          kind: ObservationSchema.shape.kind,
          semantics: ObservationSchema.shape.semantics.unwrap(),
          remainingPercent: z.number().finite().min(0).max(100),
          resetsAt: TimestampSchema.nullable(),
        }),
      ]),
    )
    .min(1)
    .max(32),
});
const OpenAiUsageReadSchema = z.strictObject({
  id: CommandIdSchema,
  state: z.enum(['intent', 'owned', 'quiescent', 'unknown']),
  attemptedAt: TimestampSchema,
  profileHash: HashSchema,
  groups: z.array(z.number().int().positive().safe()).max(2),
  reason: z.string().min(1).max(200).nullable().optional(),
  lastRequest: z.string().min(1).max(200).nullable().optional(),
  lastObservedAt: TimestampSchema.nullable().optional(),
  commandId: CommandIdSchema.optional(),
});

type LocalWriterRuntime = {
  plan: LocalPrepared;
  binding: LocalStart['binding'];
  stopped: boolean;
  handle?: ReturnType<typeof startLocalReplacement>;
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
  openAiUsageClient?: () => NativeProfileResolution;
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
  localDiscovery?: Omit<Parameters<typeof startLocalDiscovery>[2], 'lifecycle'>;
  localWriter?: Omit<Parameters<typeof startLocalReplacement>[2], 'lifecycle' | 'onSubmitted'>;
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
  private readonly outputAbort = new AbortController();
  private readonly outputPreparations = new Map<string, Promise<Artifact>>();
  private readonly outputReads = new Set<Promise<CommandResult>>();
  private evidence!: CandidateEvidence;
  private readonly formatting = new Map<
    string,
    { promise: Promise<void>; abort: AbortController }
  >();
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
  private localSecret: LocalSecretCell | null = null;
  private localOperation?: LocalOperationRuntime;
  private readonly pendingLocalLaunches = new Set<string>();
  private readonly localWriters = new Map<string, LocalWriterRuntime>();
  private readonly combinedCheckOwners = new Map<
    string,
    { stop: () => void; done: Promise<void> }
  >();
  private readonly combinedPipelines = new Map<string, Promise<void>>();
  private readonly combinedOperations = new Map<
    string,
    { stop: () => void; done: Promise<unknown> }
  >();
  private readonly conversationWorkers = new Map<string, ConversationRuntime>();
  private readonly pendingConversationLaunches = new Set<string>();
  private conversation!: TaskConversation;
  private readonly owner: DatabaseSync;
  private closed = false;
  private projectionCache?: Map<string, unknown>;
  private readonly options: ControllerOptions;
  private profiles: NativeProfileResolution[];
  private closing?: Promise<void>;
  private readonly workers = new Map<string, FakeRuntime | NativeRuntime>();
  private readonly quotaRetries = new Map<string, () => void>();
  private openAiUsageRead?: {
    id: string;
    stopped: boolean;
    handle?: { stop: () => void };
    done: Promise<void>;
  };
  private usageResolution: GoogleUsageClientResolution;
  private googleUsageReport?: {
    commandId: string;
    authorityRevision: number;
    attemptedAt: string | null;
    observedAt: string;
    bindingHash: string;
    home: string | undefined;
    buckets: Parameters<typeof googleUsageObservations>[0];
  };
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
    usageKey?: string;
    authorityRevision?: number;
    deadline: number;
    wallDeadline: number;
    expired: boolean;
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
      this.nativeConnections().recover();
      this.googleInstallation().recover();
      this.taskOperations().recover();
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
    });
    return this.taskOperationRuntime;
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
        'PrepareProjectCommand',
        'StartProjectCommand',
        'ReadGitHub',
        'StopProjectOperation',
        'GetTaskOperations',
        'GetProjectOperation',
      ].includes(command.command)
    )
      return this.taskOperations().execute(command as TaskOperationCommand);
    if (command.command === 'GetArtifactRange' || command.command === 'GetTaskActivityPage') {
      const reading = this.readOutput(command);
      this.outputReads.add(reading);
      try {
        return await reading;
      } finally {
        this.outputReads.delete(reading);
      }
    }
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
    if (command.command === 'InstallGoogleAcp' || command.command === 'StopGoogleAcpInstall')
      return this.executeGoogleInstall(command, principal);
    if (command.command === 'CheckNativeConnection')
      return this.checkNativeConnection(command, principal);
    if (command.command === 'ObserveUsage') return this.observeUsageCommand(command, principal);
    if (command.command === 'CaptureConversationContext')
      return this.captureConversationContextCommand(command, principal);
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

  private commitCommand(
    command: Command,
    principal: string,
    preflightFailure?: CommandResult,
    verification?: PreparedVerification,
    acpContext?: CapturedContext,
    contextCapture?: ReturnType<typeof captureConversationContext>,
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
          stale ??
            preflightFailure ??
            this.apply(command, effects, verification, acpContext, contextCapture),
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

  private captureConversationContextCommand(
    command: Extract<Command, { command: 'CaptureConversationContext' }>,
    principal: string,
  ): CommandResult {
    if (this.store.receipt(command.key) || this.checkRevision(command))
      return this.commitCommand(command, principal);
    let capture: ReturnType<typeof captureConversationContext>;
    try {
      const root = this.projectPath(command.payload.projectId);
      if (!root) throw Error('project-not-found');
      const source = inspectSource(command.payload.projectId, root);
      if (source.base !== command.payload.base) throw Error('conversation-context-source-changed');
      capture = captureConversationContext({
        projectRoot: root,
        projectId: command.payload.projectId,
        base: command.payload.base,
        selections: command.payload.selections.map((selection) => {
          const path = relative(root, selection.path);
          if (isAbsolute(path) || path === '..' || path.startsWith('../'))
            throw Error('conversation-context-outside-project');
          return { ...selection, path };
        }),
      });
      if (
        this.closed ||
        this.projectPath(command.payload.projectId) !== root ||
        hashCanonical(inspectSource(command.payload.projectId, root)) !== hashCanonical(source)
      )
        throw Error('conversation-context-source-changed');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = [
        'conversation-context-source-changed',
        'conversation-context-outside-project',
      ].includes(message)
        ? message
        : /8192|32768|32 files|four context/.test(message)
          ? 'conversation-context-too-large'
          : 'conversation-context-unavailable';
      return this.commitCommand(command, principal, {
        outcome: 'blocked',
        reason,
        next: 'Select bounded text in the registered project at its current commit.',
      });
    }
    return this.commitCommand(command, principal, undefined, undefined, undefined, capture);
  }

  private conversationContext(
    refs: ConversationContextRefs | undefined,
    projectId: string,
    base: string,
  ) {
    return (refs ?? []).map((ref) => {
      const key = `conversation-context:${ref.artifactId}`;
      const retained = this.nativeRecord(key, 4096);
      const proof = z
        .strictObject({
          artifactId: ArtifactSchema.shape.id,
          hash: HashSchema,
          projectId: ProjectSchema.shape.id,
          base: z.string().regex(/^[a-f0-9]{40}$/),
          projectRevision: z.number().int().nonnegative().safe(),
          commandKey: z.string(),
          commandHash: HashSchema,
        })
        .parse(retained.value);
      const capture = this.store.receipt(proof.commandKey);
      const artifact = ArtifactSchema.parse(this.store.get('artifact', ref.artifactId));
      if (
        this.store.receipt(key)?.principal !== 'local-owner' ||
        this.store.receipt(key)?.hash !== retained.artifact.hash ||
        capture?.principal !== 'local-owner' ||
        capture.hash !== proof.commandHash ||
        capture.result.outcome !== 'applied' ||
        hashCanonical(capture.result.entity) !== hashCanonical(artifact)
      )
        throw Error('conversation-context-invalid');
      if (
        proof.artifactId !== artifact.id ||
        proof.hash !== ref.hash ||
        proof.projectId !== projectId ||
        proof.base !== base ||
        artifact.hash !== ref.hash ||
        artifact.bytes > 32768 ||
        artifact.mediaType !== CONVERSATION_CONTEXT_MEDIA_TYPE
      )
        throw Error('conversation-context-invalid');
      const bytes = this.artifacts.read(ref.hash);
      const bundle = ConversationContextBundleSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (
        bundle.projectId !== projectId ||
        bundle.base !== base ||
        bytes.length !== artifact.bytes ||
        hashCanonical(bundle) !== ref.hash ||
        bundle.files.some((file) => {
          const text = Buffer.from(file.text);
          return (
            text.length !== file.bytes ||
            createHash('sha256').update(text).digest('hex') !== file.hash
          );
        })
      )
        throw Error('conversation-context-invalid');
      return { artifactId: artifact.id, hash: artifact.hash, bundle };
    });
  }

  workspaceState() {
    return WorkspaceStateSchema.parse({
      kind: 'workspace-state',
      version: 1,
      protocol: 1,
      stamp: this.store.workspaceStamp(),
      cursor: this.store.cursor(),
      googleAcpInstall: this.googleInstallation().status(),
      nativeConnections: [this.nativeConnections().status()],
      nativeProfiles: this.resolveProfiles().map((profile) => profile.facts),
      localSetup: this.localSetup(),
      localHardware: localHardwareStatus(this.now()),
      googleAcpSetup: this.store.googleAcpSetup(),
      usageReaders: [this.googleUsageReader(), this.openAiUsageReader()],
      routes: this.store.list('route'),
      usage: this.store
        .list<Observation>('window')
        .map((observation) =>
          deriveWindow(observation, { nowMs: Date.parse(this.now()), maxAgeMs: 300000 }),
        ),
    });
  }

  snapshot(scope?: SnapshotScope): Snapshot {
    const selection = SnapshotScopeSchema.parse(scope ?? {});
    const scoped = 'taskId' in selection || 'approvalId' in selection;
    const requestedTask =
      'taskId' in selection
        ? selection.taskId
        : 'approvalId' in selection
          ? this.store.get<Approval>('approval', selection.approvalId)?.taskId
          : undefined;
    const selected = requestedTask ? this.store.get<Task>('task', requestedTask) : undefined;
    const taskIds = scoped ? new Set(selected ? [selected.id] : []) : null;
    let groups = taskIds ? this.store.combinedGroupsForTasks(taskIds) : this.store.combinedGroups();
    if (taskIds) {
      let previousSize: number;
      do {
        previousSize = taskIds.size;
        const memberships = groups.map((group) => [
          group.task_id,
          ...this.store.combinedMembers(group.run_id).map((member) => member.task_id),
        ]);

        for (const members of memberships)
          if (members.some((id) => taskIds.has(id))) for (const id of members) taskIds.add(id);
        if (taskIds.size !== previousSize) groups = this.store.combinedGroupsForTasks(taskIds);
      } while (taskIds.size !== previousSize);
    }
    const tasks = taskIds ? this.store.byIds<Task>('task', taskIds) : this.store.list<Task>('task');
    const projectIds = new Set(tasks.map((task) => task.projectId));
    const runs = taskIds
      ? this.store.related<Run>('run', 'taskId', taskIds)
      : this.store.list<Run>('run');
    const runIds = new Set(runs.map((run) => run.id));
    const candidates = taskIds
      ? this.store.related<Candidate>('candidate', 'taskId', taskIds)
      : this.store.list<Candidate>('candidate');
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const header = this.workspaceState();
    const priorCache = this.projectionCache;
    this.projectionCache ??= new Map();
    try {
      const snapshot = {
        protocol: 1,
        googleAcpInstall: header.googleAcpInstall,
        nativeConnections: header.nativeConnections,
        nativeProfiles: header.nativeProfiles,
        localSetup: header.localSetup,
        googleAcpSetup: header.googleAcpSetup,
        usageReaders: header.usageReaders,
        nativeRuns: this.nativeRuns(taskIds ? runIds : undefined),
        candidateEvaluations: this.candidateEvaluations(taskIds ?? undefined),
        combinedRuns: groups
          .filter((group) => !taskIds || taskIds.has(group.task_id))
          .map((group) => this.combinedPreview(group)),
        cursor: this.store.cursor(),
        projects: taskIds
          ? this.store.byIds<Project>('project', projectIds)
          : this.store.list<Project>('project'),
        tasks,
        runs,
        attempts: taskIds
          ? this.store.related<Attempt>('attempt', 'runId', runIds)
          : this.store.list<Attempt>('attempt'),
        routes: header.routes,
        approvals: taskIds
          ? this.store.related<Approval>('approval', 'taskId', taskIds)
          : this.store.list<Approval>('approval'),
        candidates,
        artifacts: taskIds ? ([] as Artifact[]) : this.store.list<Artifact>('artifact'),
        reviewJobs: taskIds
          ? this.store.related<Attempt>('attempt', 'runId', runIds).flatMap((attempt) => {
              const row = this.store.db
                .prepare('SELECT body FROM review_jobs WHERE attempt_id=?')
                .get(attempt.id);
              return row ? [JSON.parse(row.body as string) as ReviewJob] : [];
            })
          : this.store.db
              .prepare('SELECT body FROM review_jobs')
              .all()
              .map((row) => JSON.parse(row.body as string) as ReviewJob),
        evidence: taskIds
          ? [...candidateIds].flatMap((id) =>
              this.store.db
                .prepare('SELECT body FROM evidence WHERE candidate_id=?')
                .all(id)
                .map((row) => JSON.parse(row.body as string) as CheckResult),
            )
          : this.store.db
              .prepare('SELECT body FROM evidence')
              .all()
              .map((row) => JSON.parse(row.body as string) as CheckResult),
        usage: header.usage,
      };
      if (taskIds) {
        const referenced = new Set<string>();
        const collect = (value: unknown, key = '') => {
          if (typeof value === 'string') {
            if (['artifactId', 'preparationId', 'proofId', 'checkArtifactId'].includes(key))
              referenced.add(value);
          } else if (Array.isArray(value)) {
            for (const item of value) collect(item);
          } else if (value && typeof value === 'object') {
            for (const [name, item] of Object.entries(value)) collect(item, name);
          }
        };
        collect({ ...snapshot, artifacts: [] });
        snapshot.artifacts = this.store.byIds<Artifact>('artifact', referenced);
      }
      return SnapshotSchema.parse(snapshot);
    } finally {
      this.projectionCache = priorCache;
    }
  }

  private googleUsageReader() {
    const reader = this.store.googleUsageReader();
    return UsageReaderSchema.parse({
      id: googleUsageDescriptor.id,
      family: 'google',
      clientVersion: googleUsageDescriptor.clientVersion,
      available: this.usageResolution.available,
      reason: this.usageResolution.reason,
      lastObservedAt: reader.last_observed_at,
      lastAttemptAt: reader.last_attempt_at,
    });
  }

  private openAiUsageReader() {
    const resolved = this.options.openAiUsageClient?.();
    const profile = resolved?.facts.family === 'openai' ? resolved : unavailableNativeProfile();
    const facts = profile.facts;
    if (facts.family !== 'openai') throw Error('The usage reader requires an OpenAI profile.');
    const state = this.openAiUsageState();
    return UsageReaderSchema.parse({
      id: 'openai-usage-v1',
      family: 'openai',
      clientVersion: facts.clientVersion,
      available: profile.facts.available,
      reason: profile.facts.available ? 'available' : profile.facts.reason,
      readState: state?.state ?? 'idle',
      readReason: state?.reason ?? null,
      lastRequest: state?.lastRequest ?? null,
      lastAttemptAt: state?.attemptedAt ?? null,
      lastObservedAt: state?.lastObservedAt ?? null,
    });
  }

  refreshUsage(trigger: 'start' | 'connect' | 'interval'): Promise<void> {
    return Promise.allSettled([
      this.refreshGoogleUsage(trigger),
      this.refreshOpenAiUsage(trigger),
    ]).then(() => {});
  }

  private openAiUsageState() {
    if (!this.store.receipt('usage-reader:openai')) return null;
    return OpenAiUsageReadSchema.parse(this.nativeRecord('usage-reader:openai', 4096).value);
  }

  private saveOpenAiUsage(value: z.infer<typeof OpenAiUsageReadSchema>) {
    const artifact = this.nativeArtifact(OpenAiUsageReadSchema.parse(value));
    this.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run('usage-reader:openai');
    this.store.saveReceipt('usage-reader:openai', artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
  }

  private openAiUsageBlocker(routeId: string | Route) {
    const route = typeof routeId === 'string' ? this.store.get<Route>('route', routeId) : routeId;
    if (route?.family !== 'openai' || route.fake) return;
    try {
      const state = this.openAiUsageState();
      if (state?.state === 'unknown') return 'openai-metadata-ownership-unknown';
      if (state && state.state !== 'quiescent') return 'openai-metadata-ownership-pending';
    } catch {
      return 'openai-metadata-ownership-unknown';
    }
  }

  private refreshOpenAiUsage(
    trigger: 'start' | 'connect' | 'interval' | 'manual',
    commandId?: string,
  ): Promise<void> | undefined {
    try {
      if (this.closed || !this.options.openAiUsageClient) return;
      if (this.openAiUsageRead) return this.openAiUsageRead.done;
      const profile = this.options.openAiUsageClient();
      if (
        !profile.facts.available ||
        profile.facts.family !== 'openai' ||
        !profile.client ||
        !profile.environment ||
        !profile.locationHash
      )
        return;
      const client = profile.client;
      const environment = profile.environment;
      const profileHash = hashCanonical({
        facts: profile.facts,
        client: profile.client,
        locationHash: profile.locationHash,
      });
      const attemptedAt = this.now();
      const previous = this.openAiUsageState();
      if (
        previous &&
        (previous.state !== 'quiescent' ||
          Date.parse(attemptedAt) - Date.parse(previous.attemptedAt) <
            (trigger === 'interval' ? 270000 : 60000))
      )
        return;
      if (
        this.store.intents().some((intent) => {
          if (intent.state === 'stopped') return false;
          const route = this.store.get<Route>('route', intent.route_id);
          return !route || (route.family === 'openai' && !route.fake);
        })
      )
        return;
      const readerRoute = this.store.transaction(() => {
        const receipt = this.store.receipt('usage-route:openai');
        if (receipt) {
          const route = RouteSchema.parse(this.nativeRecord('usage-route:openai', 4096).value);
          if (
            hashCanonical(this.store.get<Route>('route', route.id)) !== hashCanonical(route) ||
            route.family !== 'openai' ||
            route.fake ||
            route.qualified
          )
            throw Error('usage-route-changed');
          return route;
        } else {
          const route = RouteSchema.parse({
            id: this.id('rte'),
            family: 'openai',
            displayName: 'OpenAI usage reader',
            model: 'unknown',
            effort: { requested: 'unknown', effective: 'unknown', supported: [] },
            billing: 'included',
            qualified: false,
            fake: false,
          });
          this.store.put('route', route.id, 0, route);
          const artifact = this.nativeArtifact(route);
          this.store.saveReceipt('usage-route:openai', artifact.hash, 'local-owner', {
            outcome: 'applied',
            entity: artifact,
          });
          return route;
        }
      });
      if (trigger === 'connect') {
        const windows = this.store
          .list<Observation>('window')
          .filter((value) => value.routeId === readerRoute.id && value.source === 'client');
        if (
          windows.length &&
          windows.every(
            (value) =>
              value.confidence === 'reported' &&
              value.remaining !== null &&
              deriveWindow(value, { nowMs: Date.parse(attemptedAt), maxAgeMs: 300000 }).state ===
                'fresh',
          )
        )
          return;
      }
      const state = OpenAiUsageReadSchema.parse({
        id: this.id('cmd'),
        state: 'intent',
        attemptedAt,
        profileHash,
        groups: [],
        reason: null,
        lastRequest: null,
        lastObservedAt: previous?.lastObservedAt ?? null,
        ...(commandId ? { commandId } : {}),
      });
      this.store.transaction(() => this.saveOpenAiUsage(state));
      const completion = Promise.withResolvers<void>();
      const runtime = {
        id: state.id,
        stopped: false,
        done: completion.promise,
        handle: undefined as { stop: () => void } | undefined,
      };
      this.openAiUsageRead = runtime;
      void (async () => {
        let invoked = false;
        const reports: { value: unknown; prior: ReadonlyMap<string, Observation> }[] = [];
        let reportBytes = 0;
        const current = () => {
          const saved = this.openAiUsageState();
          const currentProfile = this.options.openAiUsageClient?.();
          if (
            this.closed ||
            runtime.stopped ||
            this.openAiUsageRead !== runtime ||
            saved?.id !== state.id ||
            saved.profileHash !== state.profileHash ||
            saved.attemptedAt !== state.attemptedAt ||
            hashCanonical(saved.groups) !== hashCanonical(state.groups) ||
            !['intent', 'owned'].includes(saved.state) ||
            !currentProfile ||
            hashCanonical({
              facts: currentProfile.facts,
              client: currentProfile.client,
              locationHash: currentProfile.locationHash,
            }) !== profileHash ||
            hashCanonical(this.store.get<Route>('route', readerRoute.id)) !==
              hashCanonical(readerRoute)
          )
            throw Error('usage-read-revoked');
        };
        try {
          current();
          const directory = mkdtempSync(join(this.home, 'openai-usage-'));
          const onUsage = this.providerUsageAdapter(readerRoute.id, (value, prior) => {
            current();
            const bytes = Buffer.byteLength(canonicalJson({ value, prior: [...prior.values()] }));
            if (reports.length >= 32 || reportBytes + bytes > 32768) return false;
            reports.push({ value, prior: new Map(prior) });
            reportBytes += bytes;
            return true;
          });
          const options = {
            timeoutMs: 20000,
            schedule: this.options.schedule,
            spawn: this.options.openAiUsageSpawn,
            lifecycle: {
              beforePhase: () => current(),
              owned: (_phase: unknown, group: number) => {
                this.store.transaction(() => {
                  current();
                  state.groups.push(group);
                  state.state = 'owned';
                  this.saveOpenAiUsage(state);
                });
              },
              quiescent: () => {},
            },
          };
          const deadline = performance.now() + options.timeoutMs;
          const wallDeadline = Date.parse(this.now()) + options.timeoutMs;
          invoked = true;
          const handle = startNativeSession(
            {
              ...client,
              directory,
              repositoryRoot: this.home,
              environment,
            },
            options,
            (remaining) =>
              new OpenAiDiscovery({
                now: () => performance.now(),
                timeoutMs: remaining,
                readConfiguration: true,
                configurationDirectory: directory,
                onUsage,
              }),
          );
          runtime.handle = handle;
          if (runtime.stopped || this.closed) handle.stop();
          const outcome = await handle.result;
          const known = outcome.quiescent && state.groups.length > 0;
          // Usage follows the supported account check. A later protocol refusal
          // cannot grant authority or erase that validated read. Cancellation revokes it.
          let published = false;
          if (
            known &&
            performance.now() < deadline &&
            Date.parse(this.now()) < wallDeadline &&
            (outcome.reason === null || outcome.reason === 'protocol')
          ) {
            const publicationCurrent = () => {
              current();
              if (performance.now() >= deadline || Date.parse(this.now()) >= wallDeadline)
                throw Error('usage-read-deadline');
            };
            for (const report of reports)
              published =
                this.storeProviderUsage(
                  readerRoute.id,
                  report.value,
                  publicationCurrent,
                  report.prior,
                ) || published;
          }
          this.store.transaction(() =>
            this.saveOpenAiUsage({
              ...state,
              state: known ? 'quiescent' : 'unknown',
              reason: !known
                ? 'ownership-unknown'
                : published
                  ? 'observed'
                  : (outcome.reason ?? 'no-observations'),
              lastRequest: outcome.lastRequest,
              lastObservedAt: published ? this.now() : state.lastObservedAt,
            }),
          );
        } catch {
          try {
            this.store.transaction(() =>
              this.saveOpenAiUsage({
                ...state,
                state: invoked ? 'unknown' : 'quiescent',
                reason: 'read-failed',
              }),
            );
          } catch {}
        } finally {
          if (this.openAiUsageRead === runtime) this.openAiUsageRead = undefined;
          completion.resolve();
        }
      })();
      return runtime.done;
    } catch {
      return;
    }
  }

  refreshGoogleUsage(
    trigger: 'start' | 'connect' | 'interval',
  ): Promise<CommandResult> | undefined {
    try {
      if (this.closed || this.acpStart) return;
      if (this.usageRead) return this.usageRead.promise;
      const reader = this.store.googleUsageReader();
      const nowMs = Date.parse(this.now());
      if (
        reader.last_attempt_at &&
        nowMs - Date.parse(reader.last_attempt_at) < (trigger === 'interval' ? 270000 : 60000)
      )
        return;
      if (trigger === 'connect') {
        const routes = this.store
          .list<Route>('route')
          .filter((route) => route.family === 'google' && !route.fake);
        const windows = this.store.list<Observation>('window');
        if (
          reader.last_observed_at &&
          routes.length &&
          routes.every((route) => {
            const observations = windows.filter((window) => window.routeId === route.id);
            return (
              observations.length &&
              observations.every(
                (window) =>
                  deriveWindow(window, { nowMs, maxAgeMs: 300000 }).state === 'fresh' &&
                  window.remaining !== null &&
                  window.source === 'client' &&
                  window.confidence === 'reported',
              )
            );
          })
        )
          return;
      }
      if (this.store.transaction(() => this.store.googleOperationBlocker())) return;
      try {
        this.usageResolution = this.options.googleUsageClient?.() ?? resolveGoogleUsageClient();
      } catch {
        this.usageResolution = { available: false, reason: 'client-unavailable' };
      }
      if (!this.usageResolution.available) return;
      const command = CommandSchema.parse({
        protocol: 1,
        key: this.id('cmd'),
        actor: { id: 'controller', kind: 'controller' },
        command: 'ObserveUsage',
        expectedRevision: 0,
        payload: { family: 'google' },
      }) as Extract<Command, { command: 'ObserveUsage' }>;
      return this.observeUsageCommand(command, 'local-owner');
    } catch {
      return;
    }
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
    const installBlocker = this.googleInstallationBlocker();
    if (installBlocker) return installBlocker;
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
                : !revoked &&
                    !outcome.reason &&
                    operation === 'authenticate' &&
                    auth.status === 'authenticated'
                  ? 'discovery-required'
                  : 'blocked',
          operationId: known ? null : commandId,
          proofId,
          client,
          auth,
          reason: ready
            ? null
            : !revoked && outcome.reason === 'deadline'
              ? 'acp-setup-timeout'
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
                    : outcome.reason === 'deadline'
                      ? 'acp-setup-timeout'
                      : 'acp-setup-failed',
              }
            : {}),
          ...(known && !revoked && outcome.reason === 'deadline'
            ? {
                next:
                  operation === 'initialize'
                    ? 'Initialization timed out after 30 seconds. Retry Initialize; no task was submitted.'
                    : 'Native setup timed out. Retry this setup step; no task was submitted.',
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

  private googleInstallOperation?: GoogleAcpInstallation;

  private googleInstallation(): GoogleAcpInstallation {
    if (this.googleInstallOperation) return this.googleInstallOperation;
    const read = (key?: string) => {
      const row = this.store.db
        .prepare(
          'SELECT command_key FROM receipts WHERE command_key LIKE ? ORDER BY rowid DESC LIMIT 1',
        )
        .get(key ? `google-acp-install:${key}:%` : 'google-acp-install:%') as
        | { command_key: string }
        | undefined;
      return row ? InstallRecordSchema.parse(this.nativeRecord(row.command_key, 4096).value) : null;
    };
    this.googleInstallOperation = new GoogleAcpInstallation({
      now: this.now,
      latest: () => read(),
      forKey: (key) => read(key),
      append: (record) =>
        this.store.transaction(() => {
          const value = InstallRecordSchema.parse(record);
          const artifact = this.nativeArtifact(value);
          if (value.phase === 'intent')
            this.store.saveReceipt(value.key, value.requestHash, 'local-owner', {
              outcome: 'blocked',
              reason: 'google-install-pending',
              data: { kind: 'google-acp-install', install: value.status },
            });
          this.store.saveReceipt(
            `google-acp-install:${value.key}:${value.step}`,
            artifact.hash,
            'local-owner',
            { outcome: 'applied', entity: artifact },
          );
        }),
    });
    return this.googleInstallOperation;
  }

  private googleInstallationBlocker(): CommandResult | undefined {
    const status = this.googleInstallation().status();
    if (['installing', 'stopping', 'unknown'].includes(status.state))
      return {
        outcome: 'blocked',
        reason:
          status.state === 'unknown' ? 'google-install-ownership-unknown' : 'google-install-active',
        next: status.next,
        data: { kind: 'google-acp-install', install: status },
      };
  }

  private async executeGoogleInstall(
    command: Extract<Command, { command: 'InstallGoogleAcp' | 'StopGoogleAcpInstall' }>,
    principal: string,
  ): Promise<CommandResult> {
    const hash = hashCanonical(command),
      receipt = this.store.receipt(command.key);
    if (receipt && (receipt.hash !== hash || receipt.principal !== principal))
      return { outcome: 'denied', reason: 'idempotency-key-reused' };
    if (
      receipt &&
      !['google-install-pending', 'google-install-stop-pending'].includes(
        receipt.result.reason ?? '',
      )
    )
      return {
        ...receipt.result,
        ...(receipt.result.outcome === 'applied' ? { outcome: 'already-applied' as const } : {}),
      };
    if (command.expectedRevision !== 0) return { outcome: 'stale-revision', revision: 0 };
    const operation = this.googleInstallation();
    let result: CommandResult;
    if (command.command === 'StopGoogleAcpInstall') {
      if (!receipt)
        this.store.transaction(() =>
          this.store.saveReceipt(command.key, hash, principal, {
            outcome: 'blocked',
            reason: 'google-install-stop-pending',
            data: { kind: 'google-acp-install', install: operation.status() },
          }),
        );
      result = await operation.stop(command.payload.operationId);
    } else {
      const blocker = receipt
        ? undefined
        : this.store.transaction(() => this.store.googleOperationBlocker());
      result = blocker
        ? {
            outcome: 'blocked',
            reason: blocker,
            data: { kind: 'google-acp-install', install: operation.status() },
          }
        : !receipt && (this.acpSetupRuntime || this.acpStart)
          ? {
              outcome: 'blocked',
              reason: 'google-operation-active',
              data: { kind: 'google-acp-install', install: operation.status() },
            }
          : await operation.install(
              { key: command.key, requestHash: hash, home: this.home },
              this.options.googleAcpInstall,
            );
    }
    if (result.outcome === 'denied') return result;
    try {
      this.store.transaction(() => {
        const current = this.store.receipt(command.key);
        if (current && current.hash !== hash) throw Error('Command binding changed.');
        if (
          current &&
          ['google-install-pending', 'google-install-stop-pending'].includes(
            current.result.reason ?? '',
          )
        )
          this.finishMetadataReceipt(command.key, result);
        else if (!current) this.store.saveReceipt(command.key, hash, principal, result);
      });
    } catch {
      return { outcome: 'blocked', reason: 'google-install-storage-failed' };
    }
    return result;
  }

  private connectionChecks?: NativeConnectionChecks;

  private nativeConnections(): NativeConnectionChecks {
    if (this.connectionChecks) return this.connectionChecks;
    this.connectionChecks = new NativeConnectionChecks({
      now: this.now,
      latest: () => {
        const row = this.store.db
          .prepare(
            "SELECT command_key FROM receipts WHERE command_key LIKE 'native-connection:%' ORDER BY rowid DESC LIMIT 1",
          )
          .get() as { command_key: string } | undefined;
        return row
          ? ConnectionRecordSchema.parse(this.nativeRecord(row.command_key, 4096).value)
          : null;
      },
      completed: (key) =>
        this.store.receipt(`native-connection:${key}:complete`)
          ? ConnectionRecordSchema.parse(
              this.nativeRecord(`native-connection:${key}:complete`, 4096).value,
            )
          : null,
      append: (record) =>
        this.store.transaction(() => {
          const value = ConnectionRecordSchema.parse(record);
          const artifact = this.nativeArtifact(value);
          if (value.phase === 'intent')
            this.store.saveReceipt(value.key, value.requestHash, 'local-owner', {
              outcome: 'blocked',
              reason: 'anthropic-connection-check-pending',
              next: 'Wait for the native sign-in check.',
            });
          this.store.saveReceipt(
            `native-connection:${value.key}:${value.phase}`,
            artifact.hash,
            'local-owner',
            { outcome: 'applied', entity: artifact },
          );
        }),
    });
    return this.connectionChecks;
  }

  private async checkNativeConnection(
    command: Extract<Command, { command: 'CheckNativeConnection' }>,
    principal: string,
  ): Promise<CommandResult> {
    const hash = hashCanonical(command);
    const receipt = this.store.receipt(command.key);
    if (receipt && (receipt.hash !== hash || receipt.principal !== principal))
      return { outcome: 'denied', reason: 'idempotency-key-reused' };
    if (receipt && receipt.result.reason !== 'anthropic-connection-check-pending')
      return {
        ...receipt.result,
        ...(receipt.result.outcome === 'applied' ? { outcome: 'already-applied' as const } : {}),
      };
    if (command.expectedRevision !== 0) return { outcome: 'stale-revision', revision: 0 };
    const directory = join(this.home, 'native', `connection-${command.key}`);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      return { outcome: 'blocked', reason: 'anthropic-connection-storage-failed' };
    }
    const result = await this.nativeConnections().check(
      {
        key: command.key,
        requestHash: hash,
        profile: this.profileFor('anthropic-file-v1'),
        directory,
        repositoryRoot: this.home,
      },
      { spawn: this.options.nativeSpawn, schedule: this.options.schedule },
    );
    if (result.outcome === 'denied') return result;
    // Metadata failures are terminal receipts. Task authority keeps its own fresh checks.
    try {
      this.store.transaction(() => {
        const current = this.store.receipt(command.key);
        if (current?.result.reason === 'anthropic-connection-check-pending')
          this.finishMetadataReceipt(command.key, result);
        else if (!current) this.store.saveReceipt(command.key, hash, principal, result);
      });
    } catch {
      return { outcome: 'blocked', reason: 'anthropic-connection-storage-failed' };
    }
    return result;
  }

  private observeUsageCommand(
    command: Extract<Command, { command: 'ObserveUsage' }>,
    principal: string,
  ): Promise<CommandResult> {
    const pendingReason =
      command.payload.family === 'openai' ? 'openai-usage-read-pending' : 'usage-read-pending';
    const prior = this.usageRead;
    const hash = hashCanonical(command);
    if (prior?.key === command.key)
      return prior.hash === hash && prior.principal === principal
        ? prior.promise
        : Promise.resolve({ outcome: 'denied', reason: 'idempotency-key-reused' });
    if (prior || this.store.receipt(command.key)) {
      let result = this.commitCommand(command, principal);
      if (result.outcome === 'outcome-unknown' && result.reason === pendingReason) {
        result = {
          outcome: 'outcome-unknown',
          reason:
            command.payload.family === 'openai'
              ? 'openai-metadata-ownership-unknown'
              : 'google-ownership-unknown',
        };
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
      if (result.outcome !== 'outcome-unknown' || result.reason !== pendingReason)
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
    if (this.usageRead && this.usageRead.key !== command.key)
      return { outcome: 'blocked', reason: 'usage-reader-busy' };
    if (command.payload.family === 'openai') {
      const reader = this.openAiUsageReader();
      if (!reader.available) return { outcome: 'blocked', reason: reader.reason };
      if (this.openAiUsageRead)
        return { outcome: 'blocked', reason: 'openai-metadata-ownership-pending' };
      if (reader.readState === 'unknown')
        return { outcome: 'outcome-unknown', reason: 'openai-metadata-ownership-unknown' };
      if (reader.readState === 'intent' || reader.readState === 'owned')
        return { outcome: 'blocked', reason: 'openai-metadata-ownership-pending' };
      if (reader.lastAttemptAt && Date.parse(this.now()) - Date.parse(reader.lastAttemptAt) < 60000)
        return {
          outcome: 'blocked',
          reason: 'usage-reader-cooldown',
          next: `Refresh after ${new Date(Date.parse(reader.lastAttemptAt) + 60000).toISOString()}.`,
        };
      if (
        this.store.intents().some((intent) => {
          if (intent.state === 'stopped') return false;
          const route = this.store.get<Route>('route', intent.route_id);
          return !route || (route.family === 'openai' && !route.fake);
        })
      )
        return { outcome: 'blocked', reason: 'openai-task-active' };
      effects.push(() => void this.launchOpenAiUsage(command.key));
      return { outcome: 'outcome-unknown', reason: 'openai-usage-read-pending' };
    }
    const reader = this.store.googleUsageReader();
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

  private async launchOpenAiUsage(commandId: string) {
    const runtime = this.usageRead;
    if (!runtime || runtime.key !== commandId) return;
    let result: CommandResult;
    try {
      const read = this.refreshOpenAiUsage('manual', commandId);
      await read;
      const state = this.openAiUsageState();
      result =
        !read || state?.commandId !== commandId
          ? { outcome: 'blocked', reason: 'usage-read-unavailable' }
          : state.state === 'unknown'
            ? { outcome: 'outcome-unknown', reason: 'openai-metadata-ownership-unknown' }
            : state.reason === 'observed'
              ? {
                  outcome: 'applied',
                  data: {
                    kind: 'usage',
                    windows: this.store.list<Observation>('window').map((observation) =>
                      deriveWindow(observation, {
                        nowMs: Date.parse(this.now()),
                        maxAgeMs: 300000,
                      }),
                    ),
                  },
                }
              : { outcome: 'blocked', reason: state.reason ?? 'no-observations' };
    } catch {
      result = { outcome: 'outcome-unknown', reason: 'openai-metadata-ownership-unknown' };
    }
    try {
      this.store.transaction(() => this.finishMetadataReceipt(commandId, result));
    } catch {
      result = { outcome: 'outcome-unknown', reason: 'openai-metadata-ownership-unknown' };
    } finally {
      runtime.resolve(result);
    }
  }

  private async launchGoogleUsage(
    commandId: string,
    authorityRevision: number,
    resolution: Extract<GoogleUsageClientResolution, { available: true }>,
  ) {
    const runtime = this.usageRead;
    if (!runtime || runtime.key !== commandId) return;
    this.googleUsageReport = undefined;
    let result: CommandResult = { outcome: 'blocked', reason: 'usage-read-failed' };
    let beforeSpawn = true;
    const current = () => {
      const reader = this.store.googleUsageReader();
      if (
        this.closed ||
        runtime.abort.signal.aborted ||
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
      let published: Controller['googleUsageReport'];
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
          // A complete account report replaces its client windows. Retaining a removed
          // bucket would leave an expired allowance blocking every Google route.
          const reported = new Set(outcome.metadata.map((bucket) => bucket.windowId));
          const live = new Set(routes.map((route) => route.id));
          for (const window of this.store.list<Observation>('window'))
            if (
              window.source === 'client' &&
              live.has(window.routeId) &&
              !reported.has(window.windowId)
            )
              this.store.db
                .prepare("DELETE FROM entities WHERE kind='window' AND id=?")
                .run(`${window.routeId}/${window.windowId}`);
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
          const bindingHash = this.googleUsageBinding(resolution);
          if (bindingHash)
            published = {
              commandId,
              authorityRevision,
              attemptedAt: reader.last_attempt_at,
              observedAt,
              bindingHash,
              home: resolution.environment.HOME,
              buckets: structuredClone(outcome.metadata),
            };
          result = {
            outcome: 'applied',
            data: { kind: 'usage', windows: this.workspaceState().usage },
          };
        }
        this.finishMetadataReceipt(commandId, result);
      });
      this.googleUsageReport = published;
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
          if (reader.authority_revision !== authorityRevision || this.closed)
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

  private googleUsageBinding(
    resolution: Extract<GoogleUsageClientResolution, { available: true }>,
  ) {
    try {
      const setup = this.store.googleAcpSetup();
      if (setup.state !== 'ready' || !setup.proofId) return;
      const proof = this.store.get<Artifact>('artifact', setup.proofId);
      if (!proof) return;
      return hashCanonical({
        client: resolution.client,
        environment: resolution.environment,
        setup,
        proofHash: proof.hash,
      });
    } catch {
      return;
    }
  }

  private attachGoogleUsage(routeId: string, environment: NodeJS.ProcessEnv) {
    const report = this.googleUsageReport;
    if (!report || this.store.googleOperationBlocker()) return;
    let observations: Observation[];
    try {
      const resolution = this.options.googleUsageClient?.() ?? resolveGoogleUsageClient();
      const reader = this.store.googleUsageReader();
      const operation = this.store
        .googleMetadataOperations()
        .find((row) => row.command_id === report.commandId);
      if (
        !resolution.available ||
        !report.home ||
        environment.HOME !== report.home ||
        this.googleUsageBinding(resolution) !== report.bindingHash ||
        reader.authority_revision !== report.authorityRevision ||
        reader.last_attempt_at !== report.attemptedAt ||
        reader.last_observed_at !== report.observedAt ||
        operation?.kind !== 'usage' ||
        operation.state !== 'quiescent' ||
        operation.authority_revision !== report.authorityRevision
      )
        return;
      observations = googleUsageObservations(report.buckets, [routeId], report.observedAt);
      if (
        !observations.every(
          (window) =>
            deriveWindow(window, { nowMs: Date.parse(this.now()), maxAgeMs: 300000 }).state ===
            'fresh',
        )
      )
        return;
    } catch {
      return;
    }
    // A new preparation can follow the startup read inside its cooldown.
    // Keep that complete report's original time and account assertion binding.
    for (const observation of observations) {
      this.store.put('window', `${routeId}/${observation.windowId}`, 0, observation);
      this.event('usage.observed', null, 0, observation);
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
    for (const cancel of this.quotaRetries.values()) cancel();
    this.quotaRetries.clear();
    const native: Promise<unknown>[] = [];
    const operationClosing = this.taskOperationRuntime?.close();
    if (operationClosing) native.push(operationClosing);
    this.outputAbort.abort();
    native.push(...this.outputReads);
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
    if (this.openAiUsageRead) {
      this.openAiUsageRead.stopped = true;
      this.openAiUsageRead.handle?.stop();
      native.push(this.openAiUsageRead.done);
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

  private checkRevision(command: Command): CommandResult | undefined {
    if (!('expectedRevision' in command)) return;
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
    if (command.command === 'CaptureConversationContext') {
      const project = this.store.get<Project>('project', command.payload.projectId);
      if (!project) return { outcome: 'blocked', reason: 'project-not-found' };
      if (project.revision !== command.expectedRevision)
        return { outcome: 'stale-revision', entity: project, revision: project.revision };
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

  private apply(
    command: Command,
    effects: (() => void)[],
    verification?: PreparedVerification,
    acpContext?: CapturedContext,
    contextCapture?: ReturnType<typeof captureConversationContext>,
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
          'ConfigureTaskConversation',
          'AdoptTaskPlan',
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
      command.command === 'PrepareRun' ||
      command.command === 'PrepareNativeRun' ||
      command.command === 'PrepareCombinedRun'
    ) {
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
      case 'CaptureConversationContext': {
        if (
          !contextCapture ||
          contextCapture.bundle.projectId !== command.payload.projectId ||
          contextCapture.bundle.base !== command.payload.base
        )
          return { outcome: 'blocked', reason: 'conversation-context-unavailable' };
        const artifact = ArtifactSchema.parse({
          id: this.id('art'),
          ...this.artifacts.publish(contextCapture.content),
          mediaType: CONVERSATION_CONTEXT_MEDIA_TYPE,
        });
        this.saveArtifacts([artifact]);
        const proof = this.nativeArtifact({
          artifactId: artifact.id,
          hash: artifact.hash,
          projectId: command.payload.projectId,
          base: command.payload.base,
          projectRevision: command.expectedRevision,
          commandKey: command.key,
          commandHash: hashCanonical(command),
        });
        this.store.saveReceipt(`conversation-context:${artifact.id}`, proof.hash, 'local-owner', {
          outcome: 'applied',
          entity: proof,
        });
        return { outcome: 'applied', entity: artifact };
      }
      case 'RegisterProject': {
        let path: string;
        try {
          path = projectRoot(command.payload.path);
        } catch {
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
      case 'GetHealth':
        return {
          outcome: 'applied',
          data: {
            kind: 'health',
            status: 'ready',
            version: '0.0.0',
            blockers: [],
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

  private localControl(): LocalControl {
    return LocalControlSchema.parse(
      this.store.localControl() ?? {
        revision: 0,
        connectionRevision: 0,
        endpoint: null,
        observation: null,
        selection: null,
        setupHash: null,
        operation: null,
      },
    );
  }

  private saveLocal(control: LocalControl) {
    const next = LocalControlSchema.parse({ ...control, revision: control.revision + 1 });
    this.store.putLocalControl(next);
    return next;
  }

  private revokeLocalSecret() {
    this.localSecret?.secret.fill(0);
    this.localSecret = null;
  }

  private localSecretMatches(control = this.localControl()) {
    return (
      !!control.endpoint &&
      !!this.localSecret &&
      this.localSecret.connectionRevision === control.connectionRevision &&
      this.localSecret.connectionHash ===
        localConfiguredConnectionHash(
          control.endpoint,
          control.connectionRevision,
          control.authMode,
        )
    );
  }

  private localConnected(control = this.localControl()) {
    return control.authMode === 'none'
      ? !!control.endpoint && control.noneConnected
      : this.localSecretMatches(control);
  }

  private localConnection() {
    const control = this.localControl();
    const current =
      control.endpoint &&
      control.observation &&
      control.selection &&
      control.selection.observationHash === control.observation.observationHash;
    return resolveLocalConnection(
      current
        ? {
            endpoint: control.endpoint,
            authMode: control.authMode,
            connectionRevision: control.connectionRevision,
            observation: control.observation,
            selectionId: control.selection?.selectionId,
          }
        : undefined,
      {
        platform: this.options.localInput?.platform ?? process.platform,
        arch: this.options.localInput?.arch ?? process.arch,
        secretConfigured: this.localSecretMatches(control),
        connected: this.localConnected(control),
      },
    );
  }

  private localSetup(): LocalSetup {
    const control = this.localControl();
    const generation = this.store.localGenerationBlocker();
    const secretConfigured = this.localSecretMatches(control);
    const connected = this.localConnected(control);
    const choice = control.observation?.models.find(
      (value) => value.selectionId === control.selection?.selectionId,
    );
    const reason: LocalSetup['reason'] =
      generation ??
      (control.operation
        ? control.operation.kind === 'input'
          ? control.operation.state === 'unknown'
            ? 'input-unknown'
            : 'input-active'
          : control.operation.state === 'unknown'
            ? 'discovery-unknown'
            : 'discovery-active'
        : !control.endpoint
          ? 'unconfigured'
          : control.authMode === 'token' && !this.options.localInputHelper
            ? 'capability-unavailable'
            : control.connectionFailed
              ? 'connection-unavailable'
              : !connected
                ? 'connection-required'
                : !control.observation
                  ? 'discovery-required'
                  : !control.selection
                    ? 'model-selection-required'
                    : control.selection.observationHash !== control.observation.observationHash
                      ? 'selection-stale'
                      : !choice
                        ? 'setup-unavailable'
                        : choice.state === 'installed-unloaded'
                          ? 'model-unloaded'
                          : choice.state !== 'loaded-eligible'
                            ? 'model-incompatible'
                            : 'qualification-pending');
    return LocalSetupSchema.parse({
      revision: control.revision,
      connectionRevision: control.connectionRevision,
      connectorId: 'local-sdk-v1',
      endpoint: control.endpoint,
      setupHash: control.setupHash,
      connectionHash: control.endpoint
        ? localConfiguredConnectionHash(
            control.endpoint,
            control.connectionRevision,
            control.authMode,
          )
        : null,
      secretConfigured,
      authMode: control.authMode,
      connected,
      operation: control.operation
        ? {
            kind: control.operation.kind,
            operationId: control.operation.binding.operationId,
            state: control.operation.state,
          }
        : null,
      generation: generation === 'generation-unknown' ? 'unknown' : generation ? 'active' : 'idle',
      observation: control.observation,
      selection: control.selection,
      reason,
    });
  }

  private localCommand(
    command: Extract<
      Command,
      {
        command:
          | 'ConfigureLocal'
          | 'BeginLocalConnectionInput'
          | 'CancelLocalConnectionInput'
          | 'DisconnectLocal'
          | 'RefreshLocalModels'
          | 'SelectLocalModel';
      }
    >,
    effects: (() => void)[],
  ): CommandResult {
    let control = this.localControl();
    const applied = (): CommandResult => {
      const setup = this.localSetup();
      return { outcome: 'applied', revision: setup.revision };
    };
    if (command.command === 'DisconnectLocal') {
      this.revokeLocalSecret();
      control = this.saveLocal({
        ...control,
        connectionRevision: control.connectionRevision + 1,
        noneConnected: false,
        connectionFailed: false,
        observation: null,
        selection: null,
        setupHash: null,
        operation: control.operation
          ? {
              ...control.operation,
              revoked: true,
              state: control.operation.state === 'unknown' ? 'unknown' : 'stopping',
            }
          : null,
      });
      effects.push(() => {
        if (this.localOperation) {
          this.localOperation.stopped = true;
          this.localOperation.handle?.stop();
        }
        for (const runtime of this.localWriters.values()) {
          runtime.stopped = true;
          runtime.handle?.stop();
        }
      });
      return applied();
    }
    if (command.command === 'CancelLocalConnectionInput') {
      if (
        control.operation?.kind !== 'input' ||
        control.operation.binding.operationId !== command.payload.operationId
      )
        return { outcome: 'blocked', reason: 'local-input-not-current' };
      this.revokeLocalSecret();
      this.saveLocal({
        ...control,
        operation: {
          ...control.operation,
          revoked: true,
          state: control.operation.state === 'unknown' ? 'unknown' : 'stopping',
        },
      });
      effects.push(() => {
        if (this.localOperation?.operationId === command.payload.operationId) {
          this.localOperation.stopped = true;
          this.localOperation.handle?.stop();
        }
      });
      return applied();
    }
    const blocker = this.store.localStartBlocker();
    if (blocker) return { outcome: 'blocked', reason: blocker };
    if (command.command === 'ConfigureLocal') {
      const authMode = command.payload.authMode ?? 'token';
      if (control.endpoint === command.payload.endpoint && control.authMode === authMode)
        return applied();
      this.revokeLocalSecret();
      this.saveLocal({
        ...control,
        endpoint: command.payload.endpoint,
        authMode,
        noneConnected: false,
        connectionFailed: false,
        connectionRevision: control.connectionRevision + 1,
        observation: null,
        selection: null,
        setupHash: null,
        operation: null,
      });
      return applied();
    }
    if (!control.endpoint) return { outcome: 'blocked', reason: 'local-not-configured' };
    if (command.command === 'SelectLocalModel') {
      if (
        !control.observation ||
        command.payload.observationHash !== control.observation.observationHash ||
        !control.observation.models.some(
          (value) => value.selectionId === command.payload.selectionId,
        )
      )
        return { outcome: 'blocked', reason: 'local-selection-stale' };
      this.saveLocal({
        ...control,
        selection: command.payload,
        setupHash: hashCanonical({
          version: 2,
          connectionHash: localConfiguredConnectionHash(
            control.endpoint,
            control.connectionRevision,
            control.authMode,
          ),
          ...command.payload,
        }),
      });
      return applied();
    }
    if (command.command === 'BeginLocalConnectionInput' && control.authMode === 'none') {
      this.revokeLocalSecret();
      this.saveLocal({
        ...control,
        noneConnected: true,
        connectionFailed: false,
        observation: null,
        selection: null,
        setupHash: null,
      });
      return applied();
    }
    if (control.authMode === 'token' && !this.options.localInputHelper)
      return { outcome: 'blocked', reason: 'local-input-unavailable' };
    if (command.command === 'RefreshLocalModels' && !this.localConnected(control))
      return { outcome: 'blocked', reason: 'local-connection-required' };
    const kind = command.command === 'BeginLocalConnectionInput' ? 'input' : 'discovery';
    if (kind === 'input') this.revokeLocalSecret();
    const binding = {
      version: kind === 'input' ? (2 as const) : (1 as const),
      operationId: command.key,
      nonce: hashCanonical({
        operationId: command.key,
        connectionRevision: control.connectionRevision,
        at: this.now(),
      }),
      connectionHash: localConfiguredConnectionHash(
        control.endpoint,
        control.connectionRevision,
        control.authMode,
      ),
      connectionRevision: control.connectionRevision,
    };
    this.saveLocal({
      ...control,
      connectionFailed: false,
      observation: kind === 'discovery' ? control.observation : null,
      selection: kind === 'discovery' ? control.selection : null,
      setupHash: kind === 'discovery' ? control.setupHash : null,
      operation: {
        kind,
        binding,
        state: 'intent',
        group: null,
        revoked: false,
        clientQuiescent: false,
      },
    });
    effects.push(() => this.launchLocalOperation(binding.operationId));
    return applied();
  }

  private localOperationCurrent(operationId: string) {
    const control = this.localControl();
    const operation = control.operation;
    if (
      this.closed ||
      !control.endpoint ||
      !operation ||
      operation.binding.operationId !== operationId ||
      operation.revoked ||
      operation.state === 'unknown' ||
      operation.binding.connectionRevision !== control.connectionRevision ||
      operation.binding.connectionHash !==
        localConfiguredConnectionHash(
          control.endpoint,
          control.connectionRevision,
          control.authMode,
        ) ||
      this.store.localGenerationBlocker()
    )
      throw Error('Local operation authority changed.');
    return { control, operation };
  }

  private launchLocalOperation(operationId: string) {
    if (this.closed) return;
    const initial = this.localControl();
    const operation = initial.operation;
    if (!operation || operation.binding.operationId !== operationId) return;
    const completion = Promise.withResolvers<void>();
    const runtime: LocalOperationRuntime = {
      operationId,
      stopped: false,
      done: completion.promise,
    };
    this.localOperation = runtime;
    let requested = false;
    const finish = (
      value: LocalInputResult | Awaited<ReturnType<typeof startLocalDiscovery>['result']> | null,
    ) => {
      try {
        this.store.transaction(() => {
          const control = this.localControl();
          const current = control.operation;
          if (!current || current.binding.operationId !== operationId) {
            if (value && 'candidate' in value) value.candidate.discard();
            return;
          }
          const clientQuiescent =
            !requested ||
            (value !== null &&
              ('kind' in value
                ? value.kind === 'ready' || value.clientQuiescent
                : value.clientQuiescent));
          const ownershipUnknown =
            value &&
            ('terminal' in value
              ? value.terminal.kind === 'unavailable' && value.terminal.reason === 'ownership'
              : value.kind !== 'ready' && value.reason === 'ownership');
          const known =
            !ownershipUnknown &&
            clientQuiescent &&
            (!requested ||
              (current.group !== null &&
                current.state !== 'unknown' &&
                (current.kind === 'input' || current.clientQuiescent)));
          const live =
            !this.closed &&
            !runtime.stopped &&
            !current.revoked &&
            current.binding.connectionRevision === control.connectionRevision &&
            !!control.endpoint &&
            current.binding.connectionHash ===
              localConfiguredConnectionHash(
                control.endpoint,
                control.connectionRevision,
                control.authMode,
              ) &&
            !this.store.localGenerationBlocker();
          let observation = control.observation;
          let selection = control.selection;
          let setupHash = control.setupHash;
          if (known && live && value && 'kind' in value && value.kind === 'ready') {
            const secret = value.candidate.take(current.binding);
            if (secret)
              this.localSecret = {
                connectionRevision: control.connectionRevision,
                connectionHash: current.binding.connectionHash,
                secret: Buffer.from(secret),
              };
          } else if (value && 'candidate' in value) value.candidate.discard();
          if (
            known &&
            live &&
            value &&
            'terminal' in value &&
            value.terminal.kind === 'observed' &&
            hashCanonical(value.terminal.binding) === hashCanonical(current.binding)
          ) {
            const nextObservation = LocalModelObservationSchema.parse(value.terminal.observation);
            const previousChoice = observation?.models.find(
              (choice) => choice.selectionId === selection?.selectionId,
            );
            const selectionId = selection?.selectionId;
            const nextChoice = nextObservation.models.find(
              (choice) => choice.selectionId === selectionId,
            );
            const retainSelection =
              selectionId &&
              previousChoice &&
              nextChoice &&
              hashCanonical(previousChoice) === hashCanonical(nextChoice);
            observation = nextObservation;
            if (retainSelection && control.endpoint) {
              selection = {
                selectionId,
                observationHash: nextObservation.observationHash,
              };
              setupHash = hashCanonical({
                version: 2,
                connectionHash: localConfiguredConnectionHash(
                  control.endpoint,
                  control.connectionRevision,
                  control.authMode,
                ),
                ...selection,
              });
            } else {
              selection = null;
              setupHash = null;
            }
          } else if (known && live && current.kind === 'discovery') {
            observation = null;
            selection = null;
            setupHash = null;
          }
          const proof = this.nativeArtifact({
            operationId,
            kind: current.kind,
            binding: current.binding,
            clientQuiescent,
            known,
            revoked: !live,
            observation,
          });
          this.store.saveReceipt(`local-operation:${operationId}`, proof.hash, 'local-owner', {
            outcome: known ? 'applied' : 'outcome-unknown',
            entity: proof,
          });
          const failedConnection =
            control.authMode === 'none' &&
            known &&
            live &&
            current.kind === 'discovery' &&
            (!value || !('terminal' in value) || value.terminal.kind !== 'observed');
          this.saveLocal({
            ...control,
            noneConnected: failedConnection ? false : control.noneConnected,
            connectionFailed: failedConnection,
            observation,
            selection,
            setupHash,
            operation: known ? null : { ...current, state: 'unknown' },
          });
        });
      } catch {
        this.revokeLocalSecret();
        if (value && 'candidate' in value) value.candidate.discard();
        try {
          this.store.transaction(() => {
            const control = this.localControl();
            if (control.operation?.binding.operationId === operationId)
              this.saveLocal({ ...control, operation: { ...control.operation, state: 'unknown' } });
          });
        } catch {}
      } finally {
        if (this.localOperation === runtime) this.localOperation = undefined;
        completion.resolve();
      }
    };
    try {
      if (this.closed || operation.revoked) return finish(null);
      const { control } = this.localOperationCurrent(operationId);
      const directory = join(this.home, 'local-operations', operationId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const own = (group: number) => {
        this.store.transaction(() => {
          const { control, operation } = this.localOperationCurrent(operationId);
          if (!Number.isSafeInteger(group) || group <= 0 || operation.state !== 'intent')
            throw Error('Local operation group is invalid.');
          this.saveLocal({ ...control, operation: { ...operation, group, state: 'owned' } });
        });
      };
      if (operation.kind === 'input') {
        runtime.handle = startLocalSecretInput(
          { binding: operation.binding, endpoint: control.endpoint },
          this.options.localInputHelper,
          {
            ...this.options.localInput,
            schedule: this.options.schedule,
            launch: (executable, settings) => {
              requested = true;
              const child =
                this.options.localInput?.launch?.(executable, settings) ??
                (() => {
                  const child = spawn(executable, [], settings);
                  return {
                    group: child.pid ?? 0,
                    input: child.stdin,
                    output: child.stdio[3],
                    onSpawn: (handler: () => void) => {
                      child.once('spawn', handler);
                    },
                    onError: (handler: () => void) => {
                      child.once('error', handler);
                    },
                    onClose: (
                      handler: (code: number | null, signal: NodeJS.Signals | null) => void,
                    ) => {
                      child.once('close', handler);
                    },
                  };
                })();
              try {
                own(child.group);
                return child;
              } catch {
                return { ...child, input: null };
              }
            },
          },
        );
        const handle = runtime.handle as ReturnType<typeof startLocalSecretInput>;
        void handle.result.then(finish, () => finish(null));
      } else {
        if (!this.localConnected(control)) throw Error('Local connection is unavailable.');
        const credentials =
          control.authMode === 'none'
            ? { authMode: 'none' as const }
            : { token: this.localSecret?.secret.toString('utf8') as string };
        const handle = startLocalDiscovery(
          {
            kind: 'discovery',
            binding: { ...operation.binding, version: 1 },
            endpoint: control.endpoint as string,
            ...credentials,
            timeoutMs: 20000,
          },
          directory,
          {
            ...this.options.localDiscovery,
            schedule: this.options.schedule,
            lifecycle: {
              beforePhase: () => {
                this.localOperationCurrent(operationId);
                requested = true;
              },
              owned: (_phase, group) => {
                own(group);
              },
              quiescent: (_phase, group) => {
                this.store.transaction(() => {
                  const current = this.localControl();
                  if (
                    current.operation?.binding.operationId !== operationId ||
                    current.operation.group !== group
                  )
                    throw Error('Local discovery closure changed.');
                  this.saveLocal({
                    ...current,
                    operation: { ...current.operation, clientQuiescent: true },
                  });
                });
              },
            },
          },
        );
        runtime.handle = handle;
        void handle.result.then(finish, () => finish(null));
      }
      if (runtime.stopped || this.closed) runtime.handle?.stop();
    } catch {
      finish(null);
    }
  }

  private conversationConfiguration(taskId: string): ConversationConfiguration | undefined {
    const value = this.store.conversationTask(taskId);
    return value === undefined ? undefined : ConversationConfigurationSchema.parse(value);
  }

  private saveConversationConfiguration(taskId: string, value: ConversationConfiguration) {
    this.store.putConversationTask(taskId, ConversationConfigurationSchema.parse(value));
  }

  private conversationCatalog(
    taskId: string,
    reference: ConversationModelRequest['observation'],
  ): ConversationModelCatalog {
    const artifact = this.store.get<Artifact>('artifact', reference.artifactId);
    if (!artifact || artifact.hash !== reference.hash) throw Error('observation-missing');
    if (artifact.bytes > 32768) throw Error('catalog-unavailable');
    const content = this.artifacts.read(artifact.hash);
    if (content.length !== artifact.bytes) throw Error('catalog-unavailable');
    const catalog = ConversationModelCatalogSchema.parse(JSON.parse(content.toString('utf8')));
    const retained = this.nativeRecord(`conversation-model-catalog:${catalog.attemptId}`, 32768);
    const attempt = this.store.get<Attempt>('attempt', catalog.attemptId);
    const run = this.store.get<Run>('run', catalog.runId);
    const route = attempt && this.store.get<Route>('route', attempt.routeId);
    const intent = this.store.intents().find((value) => value.attempt_id === catalog.attemptId);
    const completion = this.nativeRecord(`conversation-completion:${catalog.attemptId}`, 4096)
      .value as {
      attemptId: string;
      quiescent: boolean;
      submitted: boolean;
      reason: string | null;
    };
    const saved = this.nativeRecord(`conversation-turn:${catalog.attemptId}`)
      .value as ConversationPlan & {
      authorityHash: string;
    };
    const { authorityHash, ...payload } = saved;
    const input = conversationPlan(payload);
    const submission = this.nativeRecord(
      `conversation-submission:${catalog.attemptId}`,
      4096,
      'outcome-unknown',
    ).value as { attemptId: string; bindingHash: string };
    if (
      catalog.taskId !== taskId ||
      (catalog.contextUsage && catalog.contextUsage.model !== input.model) ||
      hashCanonical(retained.artifact) !== hashCanonical(artifact) ||
      this.store.receipt(`conversation-model-catalog:${catalog.attemptId}`)?.hash !==
        artifact.hash ||
      !attempt ||
      attempt.state !== 'stopped' ||
      attempt.runId !== catalog.runId ||
      attempt.generation !== catalog.generation ||
      attempt.routeId !== input.binding.routeId ||
      route?.model !== input.model ||
      route.effort.requested !== input.effort ||
      run?.taskId !== taskId ||
      run.decision.inputsHash !== authorityHash ||
      !run.roles.some(
        (role) => role.role === input.binding.role && role.routeId === attempt.routeId,
      ) ||
      intent?.task_id !== taskId ||
      intent.run_id !== catalog.runId ||
      intent.route_id !== attempt.routeId ||
      intent.generation !== catalog.generation ||
      intent.state !== 'stopped' ||
      intent.finished_at === null ||
      this.store.runPurpose(catalog.runId) !== 'conversation' ||
      !this.store.nativePhasesComplete(catalog.attemptId, 'openai') ||
      completion.attemptId !== catalog.attemptId ||
      completion.quiescent !== true ||
      completion.submitted !== true ||
      completion.reason !== null ||
      submission.attemptId !== catalog.attemptId ||
      submission.bindingHash !== conversationBindingHash(input) ||
      input.binding.taskId !== taskId ||
      input.binding.runId !== catalog.runId ||
      input.binding.attemptId !== catalog.attemptId ||
      input.binding.generation !== catalog.generation ||
      !catalog.models.some(
        (model) => model.model === input.model && model.efforts.includes(input.effort),
      )
    )
      throw Error('observation-stale');
    return catalog;
  }

  private conversationCatalogReason(
    catalog: ConversationModelCatalog,
  ): ConversationModelFailureReason | undefined {
    const profile = this.profileFor(catalog.profileId);
    if (
      hashCanonical(profile.client) !== hashCanonical(catalog.client) ||
      profile.locationHash !== catalog.locationHash
    )
      return 'client-changed';
    if (hashCanonical(profile.facts) !== catalog.profileHash) return 'observation-stale';
    if (!profile.facts.available) return 'catalog-unavailable';
  }

  private conversationModelReason(
    taskId: string,
    selection: ConversationPlanningSelection,
  ): ConversationModelFailureReason | undefined {
    const request = selection.modelRequest;
    if (!request) return;
    try {
      const catalog = this.conversationCatalog(taskId, request.observation);
      const changed = this.conversationCatalogReason(catalog);
      if (changed) return changed;
      const model = catalog.models.find((value) => value.model === request.model);
      if (!model) return 'model-unavailable';
      if (!model.efforts.includes(request.effort)) return 'effort-unavailable';
    } catch (error) {
      return error instanceof Error && error.message === 'observation-missing'
        ? 'observation-missing'
        : error instanceof Error && error.message === 'observation-stale'
          ? 'observation-stale'
          : 'catalog-unavailable';
    }
  }

  private conversationModelChoices(
    taskId: string,
    config: ConversationConfiguration | undefined,
  ): ConversationModelChoices {
    if (!config?.modelCatalog)
      return {
        status: 'not-observed',
        observation: null,
        observedAt: null,
        models: [],
        reason: 'not-observed',
      };
    try {
      const catalog = this.conversationCatalog(taskId, config.modelCatalog);
      const reason = this.conversationCatalogReason(catalog);
      if (reason && reason !== 'client-changed')
        return {
          status: 'unavailable',
          observation: config.modelCatalog,
          observedAt: catalog.observedAt,
          models: [],
          reason,
        };
      return {
        status: reason === 'client-changed' ? 'client-changed' : 'last-observed',
        observation: config.modelCatalog,
        observedAt: catalog.observedAt,
        models: catalog.models,
        reason: reason ?? config.modelFailure ?? 'available',
      };
    } catch {
      return {
        status: 'unavailable',
        observation: null,
        observedAt: null,
        models: [],
        reason: 'catalog-unavailable',
      };
    }
  }

  private conversationContextUsage(
    task: Task,
    config: ConversationConfiguration | undefined,
  ): TaskConversationState['contextUsage'] {
    if (!config?.modelCatalog || !task.runId) return null;
    try {
      const catalog = this.conversationCatalog(task.id, config.modelCatalog);
      const route = this.store.get<Route>('route', config.routeId);
      if (
        !catalog.contextUsage ||
        catalog.runId !== task.runId ||
        catalog.contextUsage.model !== route?.model ||
        this.conversationCatalogReason(catalog)
      )
        return null;
      const { threadId: _thread, turnId: _turn, ...measurement } = catalog.contextUsage;
      return ConversationContextUsageSchema.parse({
        ...measurement,
        observation: config.modelCatalog,
        runId: catalog.runId,
        attemptId: catalog.attemptId,
        generation: catalog.generation,
        observedAt: catalog.observedAt,
      });
    } catch {
      return null;
    }
  }

  private conversationModel(
    selection: ConversationPlanningSelection,
    configurationRevision: number,
  ) {
    const request = selection.modelRequest;
    return {
      model: request?.model ?? this.profileFor(selection.profileId).facts.model,
      effort: request?.effort ?? 'low',
      ...(request
        ? { selection: { version: 1 as const, configurationRevision, modelRequest: request } }
        : {}),
    };
  }

  private taskAllowance(taskId: string) {
    const config = this.conversationConfiguration(taskId);
    if (!config) return null;
    const intents = this.chargeableIntents();
    const combined = this.store.combinedGroup(taskId);
    const memberRun = combined
      ? this.store.combinedMembers(combined.run_id).find((member) => member.task_id === taskId)
          ?.run_id
      : undefined;
    const slots = combined
      ? this.store
          .combinedDispatches(combined.run_id)
          .filter(
            (slot) =>
              combined.task_id === taskId ||
              this.store.get<Attempt>('attempt', slot.attempt_id ?? '')?.runId === memberRun,
          )
      : [];
    const ledger = intents.filter(
      (intent) =>
        intent.task_id === taskId || slots.some((slot) => slot.attempt_id === intent.attempt_id),
    );
    const minutes = ledger.reduce(
      (sum, intent) => {
        const run = this.store.get<Run>('run', intent.run_id);
        let reserved =
          slots.find((slot) => slot.attempt_id === intent.attempt_id)?.maximum_minutes ??
          run?.policy.policy.limits.minutes ??
          config.limits.minutes;
        if (this.store.runPurpose(intent.run_id) === 'conversation') {
          try {
            const plan = this.nativeRecord(`conversation-turn:${intent.attempt_id}`).value as {
              binding: ConversationTurnBinding;
            };
            reserved = ConversationTurnBindingSchema.parse(plan.binding).limitMinutes;
          } catch {}
        }
        return sum + chargedMinutes(intent, reserved);
      },
      combined?.task_id === taskId ? chargedIntegrationMinutes(combined) : 0,
    );
    return {
      attempts: Math.max(0, config.limits.attempts - ledger.length),
      minutes: Math.max(0, config.limits.minutes - minutes),
      concurrency: Math.max(
        0,
        config.limits.concurrency -
          (combined ? ledger : intents).filter((intent) => intent.state !== 'stopped').length,
      ),
    };
  }

  private remaining(run: Run) {
    const intents = this.chargeableIntents();
    const group = this.store.combinedGroup(run.id);
    const ignored = new Set(
      this.store
        .intents()
        .filter((intent) => this.confirmedQuotaDenial(intent))
        .map((intent) => intent.attempt_id),
    );
    const own = group
      ? remainingCombinedBudgets(
          this.store.get<Run>('run', group.run_id) as Run,
          intents,
          this.store.combinedDispatches(group.run_id),
          group,
          ignored,
        )
      : remainingBudgets(run, intents);
    let task = this.taskAllowance(group?.task_id ?? run.taskId);
    if (group && group.task_id !== run.taskId) {
      const child = this.taskAllowance(run.taskId);
      if (child)
        task = task
          ? {
              attempts: Math.min(task.attempts, child.attempts),
              minutes: Math.min(task.minutes, child.minutes),
              concurrency: Math.min(task.concurrency, child.concurrency),
            }
          : child;
    }
    return task
      ? {
          attempts: Math.min(own.attempts, task.attempts),
          minutes: Math.min(own.minutes, task.minutes),
          concurrency: Math.min(own.concurrency, task.concurrency),
        }
      : own;
  }

  private confirmedQuotaDenial(intent: LaunchIntent) {
    try {
      const completion = NativeQuotaCompletionSchema.parse(
        this.nativeRecord(`native-completion:${intent.attempt_id}`, 4096).value,
      );
      return (
        completion.attemptId === intent.attempt_id &&
        this.store.nativeProcesses(intent.attempt_id).length > 0 &&
        this.store.nativeProcesses(intent.attempt_id).every((phase) => phase.state === 'quiescent')
      );
    } catch {
      return false;
    }
  }

  private chargeableIntents() {
    return this.store.intents().filter((intent) => !this.confirmedQuotaDenial(intent));
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
      ...(config.selection.modelRequest ? { modelRequest: config.selection.modelRequest } : {}),
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
        ...this.conversationModel(selection, Number.MAX_SAFE_INTEGER),
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

  private conversationContextFits(
    task: Pick<Task, 'id' | 'projectId' | 'runId' | 'title' | 'outcome'>,
    selection: ConversationPlanningSelection,
    criteria: string[],
    text: string,
    refs: ConversationContextRefs | undefined,
  ): boolean {
    const pending = this.conversation.pendingInputs(task.id);
    if (!refs?.length && !pending.some((entry) => 'context' in entry && entry.context?.length))
      return true;
    const config = this.conversationConfiguration(task.id);
    const base =
      config?.source.base ??
      inspectSource(task.projectId, this.projectPath(task.projectId) as string).base;
    const entries = [
      ...pending.map((entry) => ({
        id: entry.id,
        text: entry.text,
        context: 'context' in entry ? entry.context : undefined,
      })),
      { id: `msg_${'0'.repeat(26)}`, text, context: refs },
    ];
    const profile = this.profileFor(selection.profileId);
    if (!profile.facts.available) return true;
    const identity = '0'.repeat(26);
    const scope = {
      paths: [] as string[],
      roles: ['coder', 'reviewer', 'advisor'] as ('coder' | 'reviewer' | 'advisor')[],
      checks: ['node-tests-v1', 'project-node-tests-v1', 'crewkite-verify-v1'],
    };
    try {
      const attachments = entries.flatMap((entry) =>
        this.conversationContext(entry.context, task.projectId, base).map((attachment) => ({
          messageId: entry.id,
          ...attachment,
        })),
      );
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
        ...this.conversationModel(selection, Number.MAX_SAFE_INTEGER),
        creditPolicy: selection.creditPolicy,
        directory: join(this.home, 'conversation', `run_${identity}`, `att_${identity}`),
        context: { title: task.title, outcome: task.outcome, criteria },
        scope,
        contextSource: { projectId: task.projectId, base },
        contextAttachments: attachments,
        history: entries.map((entry) => ({ role: 'user', text: entry.text, messageId: entry.id })),
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
    else if (this.store.combinedGroup(task.id)) {
      const group = this.store.combinedGroup(task.id) as CombinedGroup;
      send =
        config && !['stopped', 'accepted', 'blocked', 'paused', 'unknown'].includes(group.phase)
          ? { available: true, reason: 'queued-at-boundary', disposition: 'queue' }
          : { available: false, reason: 'execution-active', disposition: null };
    } else if (active && purpose)
      send = { available: true, reason: 'queued-at-boundary', disposition: 'queue' };
    else if (run && purpose === 'execution') {
      const boundary = this.conversationBoundary(task.id);
      send = boundary
        ? { available: false, reason: boundary, disposition: null }
        : { available: true, reason: 'queued-at-boundary', disposition: 'queue' };
    } else if (config && run && purpose === 'conversation' && allowance) {
      send.reason = 'available';
      try {
        this.conversationProfile(config);
      } catch {
        send.reason = 'profile-unavailable';
      }
      if (send.reason === 'available')
        send.reason = this.conversationModelReason(task.id, config.selection) ?? 'available';
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
          disposition: 'turn',
        };
    }
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
      modelChoices: this.conversationModelChoices(task.id, config),
      contextUsage: this.conversationContextUsage(task, config),
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
    const selected = this.conversationModel(selection, (prior?.revision ?? 0) + 1);
    const route = RouteSchema.parse({
      id: this.id('rte'),
      family: 'openai',
      displayName: 'Supervised planning',
      model: selected.model,
      effort: {
        requested: selected.effort,
        effective: 'unknown',
        supported: [selected.effort],
      },
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
      ...(prior?.modelCatalog ? { modelCatalog: prior.modelCatalog } : {}),
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
      const modelReason = this.conversationModelReason(task.id, command.payload.planning);
      if (modelReason) return { outcome: 'blocked', reason: modelReason };
      if (!this.conversationInputFits(task, command.payload.planning, []))
        return { outcome: 'blocked', reason: 'conversation-input-too-large' };
      try {
        this.conversationContext(
          command.payload.context,
          task.projectId,
          inspectSource(task.projectId, this.projectPath(task.projectId) as string).base,
        );
      } catch {
        return { outcome: 'blocked', reason: 'conversation-context-invalid' };
      }
      if (
        !this.conversationContextFits(
          task,
          command.payload.planning,
          [],
          text,
          command.payload.context,
        )
      )
        return { outcome: 'blocked', reason: 'conversation-context-too-large' };
      this.store.put('task', task.id, 0, task);
      this.event('task.created', task.id, 0, task);
      task = this.configureConversation(task, command.payload.planning, true, true);
      const message = this.conversation.recordMessage(
        task.id,
        text,
        'user-message',
        command.payload.context,
      );
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
      if (this.store.runPurpose(task.runId ?? '') === 'execution')
        return {
          outcome: 'blocked',
          reason: 'task-not-discussing',
          next: 'The current execution run is retained. Start a separate task to plan new work.',
        };
      const boundary = this.conversationBoundary(task.id);
      if (boundary) return { outcome: 'blocked', reason: boundary };
      const modelReason = this.conversationModelReason(task.id, selection);
      if (modelReason) return { outcome: 'blocked', reason: modelReason };
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
      const entry = this.planProposal(task.id, state.proposal);
      if (!entry) return { outcome: 'blocked', reason: 'proposal-not-current' };
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
    try {
      this.conversationContext(
        command.payload.context,
        task.projectId,
        this.conversationConfiguration(task.id)?.source.base ??
          inspectSource(task.projectId, this.projectPath(task.projectId) as string).base,
      );
    } catch {
      return { outcome: 'blocked', reason: 'conversation-context-invalid' };
    }
    const config = this.conversationConfiguration(task.id);
    if (
      config &&
      !this.conversationContextFits(
        task,
        config.selection,
        config.contractStatus === 'provisional' ? config.contextCriteria : task.criteria,
        command.payload.text,
        command.payload.context,
      )
    )
      return { outcome: 'blocked', reason: 'conversation-context-too-large' };
    const saved =
      command.command === 'AnswerTaskQuestion'
        ? this.conversation.answerQuestion(
            task.id,
            command.payload.questionId,
            command.payload.text,
            command.payload.context,
          )
        : this.conversation.recordMessage(
            task.id,
            command.payload.text,
            command.command === 'QueueTaskGuidance' || state.purpose === 'execution'
              ? 'guidance'
              : 'user-message',
            command.payload.context,
          );
    if (!saved.applied) return { outcome: 'blocked', reason: saved.reason };
    if (state.send.disposition === 'turn') this.admitConversation(task.id, effects);
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
      .map((row) => ConversationEntrySchema.parse(JSON.parse(row.body as string)));
    if (pending.some((entry) => 'context' in entry && entry.context?.length)) {
      const retained = new Set(historyEntries.map((entry) => entry.id));
      historyEntries.push(...pending.filter((entry) => !retained.has(entry.id)));
      historyEntries.sort((left, right) => (BigInt(left.cursor) < BigInt(right.cursor) ? -1 : 1));
    }
    const history = historyEntries.map((entry) => ({ role: entry.author.kind, text: entry.text }));
    const contextInput = () => {
      const contextAttachments = historyEntries.flatMap((entry) =>
        'context' in entry
          ? this.conversationContext(entry.context, task.projectId, config.source.base).map(
              (attachment) => ({ messageId: entry.id, ...attachment }),
            )
          : [],
      );
      return contextAttachments.length
        ? {
            contextSource: { projectId: task.projectId, base: config.source.base },
            contextAttachments,
            history: historyEntries.map((entry) => ({
              role: entry.author.kind,
              text: entry.text,
              ...(entry.author.kind === 'user' ? { messageId: entry.id } : {}),
            })),
          }
        : { history };
    };
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
    try {
      contextInput();
    } catch {
      return { outcome: 'blocked', reason: 'conversation-context-invalid' };
    }
    let input: ConversationPlan | undefined;
    let omitted = Math.max(0, total - history.length);
    while (!input) {
      try {
        input = conversationPlan({
          binding,
          ...this.conversationModel(config.selection, config.revision),
          creditPolicy: config.selection.creditPolicy,
          directory,
          context: {
            title: task.title,
            outcome: task.outcome,
            criteria:
              config.contractStatus === 'provisional' ? config.contextCriteria : task.criteria,
          },
          scope,
          ...contextInput(),
          omittedHistoryCount: omitted,
        });
      } catch {
        if (history.length > 1) {
          const retained = new Set(pending.map((entry) => entry.id));
          const old = historyEntries.findIndex((entry) => !retained.has(entry.id));
          const protectedContext = pending.some(
            (entry) => 'context' in entry && entry.context?.length,
          );
          const index = old >= 0 ? old : protectedContext ? -1 : history.length - 1;
          if (index >= 0) {
            history.splice(index, 1);
            historyEntries.splice(index, 1);
            omitted++;
          } else if (scope.paths.length) {
            scope.paths.pop();
            binding.scopeHash = hashCanonical(scope);
          } else return { outcome: 'blocked', reason: 'conversation-context-too-large' };
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
    this.saveConversationConfiguration(task.id, {
      ...config,
      effectiveModel: null,
      effectiveEffort: null,
    });
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
      const modelReason = this.conversationModelReason(input.binding.taskId, config.selection);
      if (modelReason) throw Error(modelReason);
      if (input.contextAttachments?.length)
        for (const attachment of input.contextAttachments)
          this.conversationContext([attachment], task.projectId, config.source.base);
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
              reason: outcome ? outcome.reason : 'launch',
              ignoredNotifications: outcome?.ignoredNotifications ?? {},
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
              const result = this.conversation.recordReply(
                {
                  binding: input.binding,
                  scope: input.scope,
                  bindingHash: conversationBindingHash(input),
                },
                outcome.metadata.conversation,
              );
              if (!result.applied) valid = false;
              else {
                const profile = this.conversationProfile(config);
                const catalog = ConversationModelCatalogSchema.parse({
                  version: 1,
                  profileId: config.selection.profileId,
                  taskId: input.binding.taskId,
                  runId: input.binding.runId,
                  attemptId: input.binding.attemptId,
                  generation: input.binding.generation,
                  observedAt: this.now(),
                  profileHash: config.profileHash,
                  client: profile.client,
                  locationHash: config.locationHash,
                  models: outcome.metadata.modelChoices,
                  ...(outcome.metadata.contextUsage
                    ? { contextUsage: outcome.metadata.contextUsage }
                    : {}),
                });
                const observation = this.nativeArtifact(catalog);
                this.store.saveReceipt(
                  `conversation-model-catalog:${attempt.id}`,
                  observation.hash,
                  'local-owner',
                  { outcome: 'applied', entity: observation },
                );
                const updated = {
                  ...config,
                  effectiveModel: input.model,
                  effectiveEffort: input.effort,
                  modelCatalog: { artifactId: observation.id, hash: observation.hash },
                };
                delete updated.modelFailure;
                this.saveConversationConfiguration(input.binding.taskId, updated);
              }
            } else if (
              quiescent &&
              !runtime.stopped &&
              !this.closed &&
              (outcome?.diagnostic?.cause === 'model-unavailable' ||
                outcome?.diagnostic?.cause === 'effort-unavailable')
            ) {
              const config = this.conversationConfiguration(input.binding.taskId);
              if (config && authorityHash === this.conversationAuthority(config))
                this.saveConversationConfiguration(input.binding.taskId, {
                  ...config,
                  modelFailure: outcome.diagnostic.cause,
                });
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
                    : outcome?.diagnostic?.cause === 'model-unavailable'
                      ? 'The requested model is unavailable. Save another choice or explicitly try again.'
                      : outcome?.diagnostic?.cause === 'effort-unavailable'
                        ? 'The requested effort is unavailable. Save another choice or explicitly try again.'
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
          ...this.providerUsage(
            attempt,
            current,
            () => this.conversationWorkers.get(attempt.id) === runtime && !runtime.stopped,
            ['metadata-preparation', 'app-server-task'],
          ),
          lifecycle: this.nativeLifecycle(attempt, current),
        },
      );
      if (runtime.stopped || this.closed) runtime.handle.stop();
      void runtime.handle.result.then(finish, () => finish(null));
    } catch {
      finish(null);
    }
  }

  private combinedManifest(group: CombinedGroup): CombinedManifest {
    const artifact = ArtifactSchema.parse(
      this.store.get<Artifact>('artifact', group.preparation_id),
    );
    if (artifact.hash !== group.manifest_hash || artifact.bytes > MAX_FRAME_BYTES)
      throw Error('The combined manifest changed.');
    const bytes = this.artifacts.read(artifact.hash);
    if (bytes.length !== artifact.bytes) throw Error('The combined manifest is incomplete.');
    const manifest = CombinedManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (manifest.run.id !== group.run_id || manifest.run.taskId !== group.task_id)
      throw Error('The combined parent changed.');
    return manifest;
  }

  private combinedCurrent(group: CombinedGroup, permitStopped = false) {
    const key = `combined-current:${group.run_id}:${permitStopped}`;
    const cached = this.projectionCache?.get(key) as
      | { group: CombinedGroup; manifest: CombinedManifest; task: Task; members: CombinedMember[] }
      | undefined;
    if (cached) return cached;
    const current = this.store.combinedGroup(group.run_id);
    if (
      !current ||
      (this.closed && !permitStopped) ||
      current.generation !== group.generation ||
      (!permitStopped &&
        ['paused', 'stopping', 'stopped', 'blocked', 'unknown', 'accepted'].includes(current.phase))
    )
      throw Error('Combined admission is closed.');
    const manifest = this.combinedManifest(current);
    if (current.integration_maximum_minutes !== (manifest.input.integration?.maximumMinutes ?? 1))
      throw Error('The combined integration allowance changed.');
    const task = this.store.get<Task>('task', current.task_id);
    if (
      !task ||
      task.runId !== current.run_id ||
      hashCanonical(task.criteria) !== hashCanonical(manifest.task.criteria) ||
      hashCanonical(this.store.get<Run>('run', current.run_id)?.policy) !==
        hashCanonical(manifest.run.policy) ||
      hashCanonical(this.store.get<Run>('run', current.run_id)?.source) !==
        hashCanonical(manifest.run.source) ||
      hashCanonical(this.store.get<Run>('run', current.run_id)?.roles) !==
        hashCanonical(manifest.run.roles) ||
      task.title !== manifest.task.title ||
      task.outcome !== manifest.task.outcome ||
      hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(manifest.run.source)
    )
      throw Error('The combined source or task changed.');
    const members = this.store.combinedMembers(group.run_id);
    if (members.length !== 2) throw Error('The combined membership is incomplete.');
    for (const [index, member] of members.entries()) {
      const child = this.store.get<Task>('task', member.task_id);
      const frozen = manifest.members[index];
      if (
        !child ||
        child.runId !== member.run_id ||
        child.projectId !== task.projectId ||
        member.ordinal !== index ||
        frozen.run.id !== member.run_id ||
        hashCanonical(this.store.get<Run>('run', member.run_id)?.policy) !==
          hashCanonical(frozen.run.policy) ||
        member.task_id !== frozen.task.id ||
        member.task_id !== manifest.input.children[index].taskId ||
        member.scope_path !== manifest.input.children[index].scope[0] ||
        hashCanonical(this.store.get<Run>('run', member.run_id)?.source) !==
          hashCanonical(frozen.run.source) ||
        hashCanonical(this.store.get<Run>('run', member.run_id)?.roles) !==
          hashCanonical(frozen.run.roles) ||
        hashCanonical(this.store.get<Artifact>('artifact', member.preparation_id)) !==
          hashCanonical(frozen.preparation) ||
        member.preparation_id !== frozen.preparation.id ||
        hashCanonical({ title: child.title, outcome: child.outcome, criteria: child.criteria }) !==
          member.task_hash ||
        hashCanonical(frozen.run.source) !== hashCanonical(manifest.run.source) ||
        member.scope_hash !== hashCanonical([manifest.input.children[index].scope[0]])
      )
        throw Error('The combined child changed.');
    }
    const result = { group: current, manifest, task, members };
    this.projectionCache?.set(key, result);
    return result;
  }

  private updateCombined(
    group: CombinedGroup,
    phase: CombinedGroup['phase'],
    blocker: CombinedGroup['blocker'] = null,
  ) {
    const changed = this.store.db
      .prepare(
        "UPDATE combined_groups SET phase=?,blocker=?,revision=revision+1,paused_phase=CASE WHEN ? IN ('stopping','stopped','blocked','unknown','accepted') THEN NULL ELSE paused_phase END WHERE run_id=? AND generation=?",
      )
      .run(phase, blocker, phase, group.run_id, group.generation);
    if (changed.changes !== 1) throw Error('The combined generation changed.');
    const current = this.store.combinedGroup(group.run_id) as CombinedGroup;
    const preview = this.combinedPreview(current);
    this.event(
      'combined.updated',
      current.task_id,
      this.store.get<Task>('task', current.task_id)?.revision ?? 0,
      preview,
    );
    return current;
  }

  private combinedPreview(group: CombinedGroup): CombinedRunPreview {
    const manifest = this.combinedManifest(group);
    const available = { available: true, reason: 'available' as const };
    const blocked = (reason: CombinedRunPreview['assemble']['reason']) => ({
      available: false,
      reason,
    });
    const slots = this.store.combinedDispatches(group.run_id);
    const run = this.store.get<Run>('run', group.run_id) as Run;
    let currentReason: CombinedRunPreview['start']['reason'] | null = null;
    try {
      this.combinedCurrent(group, true);
    } catch {
      currentReason = 'source-changed';
    }
    const closed =
      !!currentReason ||
      ['paused', 'stopping', 'stopped', 'blocked', 'unknown', 'accepted'].includes(group.phase);
    const reason =
      currentReason ??
      (group.phase === 'unknown'
        ? 'ownership-unknown'
        : group.phase === 'paused'
          ? 'paused'
          : group.phase === 'accepted'
            ? 'accepted'
            : (group.blocker ?? 'stopped'));
    const candidate = group.final_candidate_id
      ? this.store.get<Candidate>('candidate', group.final_candidate_id)
      : undefined;
    if (candidate && !closed) {
      try {
        this.combinedOrigin(group, candidate);
        if (group.phase === 'ready') this.combinedPublicationEvidence(group, candidate);
      } catch {
        currentReason = 'preparation-changed';
      }
    }
    const ready = (
      expected: CombinedGroup['phase'],
      otherwise: CombinedRunPreview['assemble']['reason'],
    ) =>
      !closed && !currentReason && group.phase === expected
        ? available
        : blocked(currentReason ?? (closed ? reason : otherwise));
    return CombinedRunPreviewSchema.parse({
      taskId: group.task_id,
      runId: group.run_id,
      preparationId: group.preparation_id,
      manifestHash: group.manifest_hash,
      revision: group.revision,
      generation: group.generation,
      evaluationSelection: {
        recipeId: 'project-node-tests-v1',
        testFiles: manifest.input.checks.testFiles,
        reviewer: { profileId: 'openai-file-v1', methodId: 'keep-it-simple', cycles: 1 },
        creditPolicy: manifest.input.reviewer.creditPolicy,
      },
      members: this.store.combinedMembers(group.run_id).map((member) => ({
        taskId: member.task_id,
        runId: member.run_id,
        scope: [member.scope_path],
        start:
          !closed && group.phase === 'writers' && slots[member.ordinal + 1].state === 'reserved'
            ? available
            : blocked(
                closed
                  ? reason
                  : slots[member.ordinal + 1].state === 'reserved'
                    ? 'baseline-required'
                    : 'already-started',
              ),
      })),
      phase: group.phase,
      blocker: group.blocker,
      dispatches: slots.map((slot) => ({
        phase: slot.phase,
        maximumMinutes: slot.maximum_minutes,
        state: slot.state,
        attemptId: slot.attempt_id,
        checkArtifactId: slot.check_artifact_id,
      })),
      candidate: candidate ? { id: candidate.id, hash: candidate.hash } : null,
      remainingBudgets: this.remaining(run),
      start:
        !closed && !currentReason && group.phase === 'baseline' && slots[0].state === 'passed'
          ? available
          : ready('prepared', 'already-started'),
      assemble:
        !closed &&
        ['writers', 'assembling'].includes(group.phase) &&
        !this.combinedPipelines.has(group.run_id) &&
        slots[1].state === 'passed' &&
        slots[2].state === 'passed'
          ? available
          : blocked(closed ? reason : 'writers-incomplete'),
      evaluate: ready('awaiting-evaluation', 'checks-required'),
      review: ready('awaiting-review', 'checks-required'),
      accept: ready('ready', 'review-required'),
    });
  }

  private prepareCombined(
    command: Extract<Command, { command: 'PrepareCombinedRun' }>,
  ): CommandResult {
    const input = command.payload;
    const parent = this.store.get<Task>('task', input.taskId);
    const children = input.children.map((child) => this.store.get<Task>('task', child.taskId));
    if (
      parent?.state !== 'draft' ||
      children.some(
        (child, index) =>
          child?.state !== 'draft' ||
          child.projectId !== parent.projectId ||
          child.revision !== input.children[index].expectedRevision,
      )
    )
      return { outcome: 'blocked', reason: 'combined-drafts-changed' };
    for (const task of [parent, ...children] as Task[]) {
      if (
        this.store.combinedGroup(task.id) ||
        this.draftEditGate(task) ||
        this.store
          .list<Attempt>('attempt')
          .some(
            (attempt) =>
              this.store.get<Run>('run', attempt.runId)?.taskId === task.id &&
              this.store.runPurpose(attempt.runId) !== 'conversation',
          ) ||
        this.store.db.prepare('SELECT 1 FROM pending_effects WHERE task_id=? LIMIT 1').get(task.id)
      )
        return { outcome: 'blocked', reason: 'combined-draft-has-work' };
    }
    const allowance = this.taskAllowance(parent.id);
    if (
      allowance &&
      (allowance.attempts < 7 ||
        allowance.minutes <
          4 +
            (input.integration?.maximumMinutes ?? 1) +
            input.children[0].maximumMinutes +
            input.children[1].maximumMinutes +
            input.reviewer.maximumMinutes ||
        allowance.concurrency < 2)
    )
      return { outcome: 'blocked', reason: 'combined-task-budget-insufficient' };
    for (const [index, child] of children.entries()) {
      const allowance = this.taskAllowance((child as Task).id);
      if (
        allowance &&
        (allowance.attempts < 1 ||
          allowance.minutes < input.children[index].maximumMinutes ||
          allowance.concurrency < 1)
      )
        return { outcome: 'blocked', reason: 'combined-child-budget-insufficient' };
    }
    const source = inspectSource(parent.projectId, this.projectPath(parent.projectId) as string);
    const files = committedFiles(this.projectPath(parent.projectId) as string, source.base);
    for (const child of input.children) {
      if (frozenVerificationPath(child.scope[0]))
        throw Error('Trusted evaluator files cannot be writer scope.');
      const file = files.find((file) => file.path === child.scope[0]);
      if (
        !file ||
        file.bytes > 65536 ||
        new TextDecoder('utf-8', { fatal: true }).decode(file.content).includes('\0')
      )
        throw Error('A combined target is unavailable.');
    }
    const reviewer = this.profileFor(input.reviewer.profileId);
    if (
      !reviewer.facts.available ||
      reviewer.facts.family !== 'openai' ||
      !reviewer.client ||
      !reviewer.locationHash ||
      !reviewer.environment ||
      !reviewer.facts.creditPolicies.includes(input.reviewer.creditPolicy)
    )
      return { outcome: 'blocked', reason: 'combined-reviewer-unavailable' };
    const baseline = this.evidence.capture({
      taskId: parent.id,
      base: source.base,
      files,
      existing: [],
    });
    this.saveArtifacts(baseline.artifacts);
    this.store.put('candidate', baseline.candidate.id, 0, baseline.candidate);
    for (const testFiles of [
      input.checks.testFiles,
      input.checks.replayTestFiles[0],
      [...new Set(input.checks.replayTestFiles.flat())],
    ])
      this.evidence.describeChecks({
        candidate: baseline.candidate,
        sourceFiles: files,
        criteria: parent.criteria,
        selection: { recipeId: 'project-node-tests-v1', testFiles },
      });
    const members = input.children.map((child) => {
      const result = this.prepareNative(
        CommandSchema.parse({
          ...command,
          key: this.id('cmd'),
          command: 'PrepareNativeRun',
          expectedRevision: child.expectedRevision,
          payload: {
            taskId: child.taskId,
            ...child.writer,
            targetPath: child.scope[0],
            policy: input.policy,
            consent: child.consent,
          },
        }) as Extract<Command, { command: 'PrepareNativeRun' }>,
        child.maximumMinutes,
      );
      if (result.outcome !== 'applied')
        throw Error(result.reason ?? 'The combined child could not be prepared.');
      const task = this.store.get<Task>('task', child.taskId) as Task;
      const run = this.store.get<Run>('run', task.runId as string) as Run;
      const preparation = ArtifactSchema.parse(
        this.store.receipt(`native-run:${run.id}`)?.result.entity,
      );
      if (hashCanonical(run.source) !== hashCanonical(source))
        throw Error('Combined child source changed.');
      return { task, run, preparation };
    });
    const route = RouteSchema.parse({
      id: this.id('rte'),
      family: 'openai',
      displayName: reviewer.facts.displayName,
      model: reviewer.facts.model,
      effort: {
        requested: reviewer.facts.effort,
        effective: reviewer.facts.effort,
        supported: [reviewer.facts.effort],
      },
      billing: input.reviewer.creditPolicy === 'ordinary' ? 'included' : 'credits',
      qualified: false,
      fake: false,
    });
    this.store.put('route', route.id, 0, route);
    const run = RunSchema.parse({
      id: this.id('run'),
      taskId: parent.id,
      source,
      policy: { policy: input.policy, hash: hashCanonical(input.policy) },
      roles: [{ role: 'reviewer', routeId: route.id, pinned: true, approvedFallbacks: [] }],
      decision: {
        chosen: null,
        rejected: [],
        rule: 'waiting',
        inputsHash: hashCanonical({ source, policy: input.policy }),
      },
      revision: 0,
    });
    this.store.put('run', run.id, 0, run);
    this.store.putRunPurpose(run, 'execution', parent.runId);
    const task = this.updateTask(parent, {
      runId: run.id,
      next: 'Start the combined baseline before starting either child.',
    });
    const manifests = members.map((member) =>
      NativePreparationSchema.parse(this.nativeRecord(`native-run:${member.run.id}`).value),
    );
    const gitPath = realpathSync('/usr/bin/git');
    const manifest = CombinedManifestSchema.parse({
      version: 1,
      input,
      run,
      task,
      sourceFiles: files.map(({ content: _content, ...entry }) => entry),
      members,
      reviewer: {
        route,
        profile: reviewer.facts,
        client: reviewer.client,
        locationHash: reviewer.locationHash,
      },
      git: {
        executable: gitPath,
        sha256: createHash('sha256').update(readFileSync(gitPath)).digest('hex'),
      },
      expiresAt: new Date(
        Math.min(...manifests.map((plan) => Date.parse(plan.appointment.expiresAt))),
      ).toISOString(),
    });
    if (Buffer.byteLength(canonicalJson(manifest)) > MAX_FRAME_BYTES)
      throw Error('The combined manifest exceeds its bound.');
    const artifact = this.nativeArtifact(manifest);
    this.store.db
      .prepare(
        "INSERT INTO combined_groups(run_id,task_id,preparation_id,manifest_hash,phase,integration_ref,integration_maximum_minutes) VALUES (?,?,?,?,'prepared',?,?)",
      )
      .run(
        run.id,
        task.id,
        artifact.id,
        artifact.hash,
        `refs/crewkite/integration/${run.id}`,
        input.integration?.maximumMinutes ?? 1,
      );
    for (const [ordinal, member] of members.entries())
      this.store.db
        .prepare(
          'INSERT INTO combined_members(parent_run_id,ordinal,task_id,run_id,preparation_id,scope_path,scope_hash,task_hash) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          run.id,
          ordinal,
          member.task.id,
          member.run.id,
          member.preparation.id,
          input.children[ordinal].scope[0],
          hashCanonical(input.children[ordinal].scope),
          hashCanonical({
            title: member.task.title,
            outcome: member.task.outcome,
            criteria: member.task.criteria,
          }),
        );
    const maxima = [
      1,
      input.children[0].maximumMinutes,
      input.children[1].maximumMinutes,
      1,
      1,
      1,
      input.reviewer.maximumMinutes,
    ];
    for (const [index, phase] of CombinedDispatchPhaseSchema.options.entries())
      this.store.db
        .prepare(
          'INSERT INTO combined_dispatches(parent_run_id,phase,maximum_minutes) VALUES (?,?,?)',
        )
        .run(run.id, phase, maxima[index]);
    this.store.db
      .prepare(
        "UPDATE combined_dispatches SET candidate_id=? WHERE parent_run_id=? AND phase='baseline'",
      )
      .run(baseline.candidate.id, run.id);
    this.event('run.prepared', task.id, task.revision, run);
    this.updateCombined(this.store.combinedGroup(run.id) as CombinedGroup, 'prepared');
    return { outcome: 'applied', entity: artifact, revision: task.revision };
  }

  private captureCombined(group: CombinedGroup, files: FileContent[]) {
    const manifest = this.combinedManifest(group);
    const captured = this.evidence.capture({
      taskId: group.task_id,
      base: manifest.run.source.base,
      files,
      existing: [],
    });
    this.saveArtifacts(captured.artifacts);
    this.store.put('candidate', captured.candidate.id, 0, captured.candidate);
    const changes = this.evidence.changes({
      taskId: group.task_id,
      candidateId: captured.candidate.id,
      base: manifest.run.source.base,
      sourceFiles: committedFiles(
        this.projectPath(manifest.task.projectId) as string,
        manifest.run.source.base,
      ),
      files,
    });
    this.saveArtifacts(changes.artifacts);
    this.store.saveReceipt(
      `changes:${captured.candidate.id}`,
      captured.candidate.hash,
      'local-owner',
      { outcome: 'applied', data: changes.data },
    );
    return captured.candidate;
  }

  private async combinedGit<T extends string | boolean | null>(
    group: CombinedGroup,
    operation: string,
    binding: { candidate?: Candidate; check?: CheckResult; old?: string | null; next?: string },
    work: (
      git: ReturnType<typeof createIntegrationGit>,
      options: IntegrationGitOptions,
    ) => { stop: () => void; result: Promise<IntegrationGitOutcome<T>> },
  ): Promise<T> {
    const current = this.combinedCurrent(group).group;
    const manifest = this.combinedManifest(current);
    if (this.closed) throw Error('Controller is closing.');
    const prior = this.store
      .combinedRefIntents(group.run_id)
      .find((row) => row.generation === group.generation && row.operation === operation);
    const journal = prior
      ? CombinedRefJournalSchema.parse(JSON.parse(prior.body))
      : ({ phases: [] } as z.infer<typeof CombinedRefJournalSchema>);
    if (
      prior &&
      (prior.expected_old !== (binding.old ?? null) ||
        prior.expected_new !== (binding.next ?? null) ||
        prior.candidate_id !== (binding.candidate?.id ?? null) ||
        prior.check_artifact_id !== (binding.check?.artifactId ?? null))
    )
      throw Error('Integration intent changed.');
    if (prior?.state === 'applied' && Object.hasOwn(journal, 'value')) return journal.value as T;
    if (
      prior &&
      (prior.state === 'unknown' || journal.phases.some((phase) => phase.state !== 'quiescent'))
    )
      throw Error('The prior integration owner is unknown.');
    if (
      current.integration_active ||
      this.store.combinedRefIntents(group.run_id).some((row) => row.state === 'unknown')
    )
      throw Error('Integration ownership is unresolved.');
    if (prior && operation === 'baseline-initialize' && journal.phases.length) {
      await this.combinedGit(
        group,
        `${operation}-reconcile-${this.store.combinedRefIntents(group.run_id).filter((row) => row.operation.startsWith(`${operation}-reconcile-`)).length}`,
        {},
        (git, options) => git.readHead(options),
      );
      journal.value = true;
      this.store.transaction(() =>
        this.store.db
          .prepare(
            "UPDATE combined_ref_intents SET state='applied',body=?,finished_at=? WHERE parent_run_id=? AND generation=? AND operation=? AND state='prepared'",
          )
          .run(canonicalJson(journal), this.now(), group.run_id, group.generation, operation),
      );
      return true as T;
    }
    if (prior && binding.next && journal.phases.length) {
      const head = await this.combinedGit(
        group,
        `${operation}-reconcile-${this.store.combinedRefIntents(group.run_id).filter((row) => row.operation.startsWith(`${operation}-reconcile-`)).length}`,
        {},
        (git, options) => git.readHead(options),
      );
      if (head === binding.next) {
        journal.value = true;
        this.store.transaction(() =>
          this.store.db
            .prepare(
              "UPDATE combined_ref_intents SET state='applied',body=?,finished_at=? WHERE parent_run_id=? AND generation=? AND operation=? AND state='prepared'",
            )
            .run(canonicalJson(journal), this.now(), group.run_id, group.generation, operation),
        );
        return true as T;
      }
      if (head !== (binding.old ?? null)) throw Error('The prepared integration ref changed.');
    }
    if (binding.check && binding.candidate) {
      const row = this.store
        .combinedDispatches(group.run_id)
        .find((slot) => slot.check_artifact_id === binding.check?.artifactId);
      if (
        row?.state !== 'passed' ||
        row.candidate_id !== binding.candidate.id ||
        !this.checks(binding.candidate).some(
          (check) => hashCanonical(check) === hashCanonical(binding.check),
        )
      )
        throw Error('The integration check changed.');
    }
    const available = Math.min(
      60000,
      current.integration_maximum_minutes * 60000 - current.integration_milliseconds,
    );
    if (available <= 100) throw Error('The integration allowance is exhausted.');
    const directory = join(this.home, 'integration', group.run_id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const git = createIntegrationGit({ directory, runId: group.run_id, git: manifest.git });
    const phaseOffset = journal.phases.length;
    const started = performance.now();
    this.store.transaction(() => {
      this.combinedCurrent(group);
      if (!prior)
        this.store.db
          .prepare(
            "INSERT INTO combined_ref_intents(parent_run_id,generation,operation,expected_old,expected_new,candidate_id,check_artifact_id,state,body,intent_at) VALUES (?,?,?,?,?,?,?,'prepared',?,?)",
          )
          .run(
            group.run_id,
            group.generation,
            operation,
            binding.old ?? null,
            binding.next ?? null,
            binding.candidate?.id ?? null,
            binding.check?.artifactId ?? null,
            canonicalJson(journal),
            this.now(),
          );
      this.store.db
        .prepare(
          'UPDATE combined_groups SET integration_active=1,integration_started_at=COALESCE(integration_started_at,?) WHERE run_id=?',
        )
        .run(this.now(), group.run_id);
    });
    const save = () =>
      this.store.db
        .prepare(
          "UPDATE combined_ref_intents SET body=? WHERE parent_run_id=? AND generation=? AND operation=? AND state='prepared'",
        )
        .run(canonicalJson(journal), group.run_id, group.generation, operation);
    const options: IntegrationGitOptions = {
      deadline: started + available,
      lifecycle: {
        beforePhase: (phase) =>
          this.store.transaction(() => {
            this.combinedCurrent(group);
            if (
              phase.sequence + phaseOffset !== journal.phases.length ||
              journal.phases.some((phase) => phase.state !== 'quiescent')
            )
              throw Error('Integration phases overlap.');
            journal.phases.push({
              ...phase,
              sequence: phase.sequence + phaseOffset,
              state: 'intent',
              group: null,
            });
            save();
          }),
        owned: (phase, pid) =>
          this.store.transaction(() => {
            this.combinedCurrent(group);
            const row = journal.phases[phase.sequence + phaseOffset];
            if (!row || row.digest !== phase.digest || row.state !== 'intent')
              throw Error('Integration phase changed.');
            row.group = pid;
            row.state = 'owned';
            save();
          }),
        quiescent: (phase, pid) =>
          this.store.transaction(() => {
            const row = journal.phases[phase.sequence + phaseOffset];
            if (!row || row.digest !== phase.digest || row.state !== 'owned' || row.group !== pid)
              throw Error('Integration closure changed.');
            row.state = 'quiescent';
            save();
          }),
      },
    };
    let handle: ReturnType<typeof work>;
    try {
      handle = work(git, options);
    } catch (error) {
      this.store.transaction(() => {
        this.store.db
          .prepare(
            "UPDATE combined_ref_intents SET state='unknown' WHERE parent_run_id=? AND generation=? AND operation=?",
          )
          .run(group.run_id, group.generation, operation);
        this.updateCombined(group, 'unknown', 'ownership-unknown');
      });
      throw error;
    }
    this.combinedOperations.set(group.run_id, { stop: handle.stop, done: handle.result });
    const result = await handle.result;
    this.combinedOperations.delete(group.run_id);
    this.store.transaction(() => {
      const elapsed = Math.max(0, Math.ceil(performance.now() - started));
      const state =
        result.quiescent && journal.phases.every((phase) => phase.state === 'quiescent')
          ? result.reason === null
            ? 'applied'
            : 'prepared'
          : 'unknown';
      if (state === 'applied') journal.value = result.value;
      this.store.db
        .prepare(
          'UPDATE combined_ref_intents SET state=?,body=?,finished_at=? WHERE parent_run_id=? AND generation=? AND operation=?',
        )
        .run(
          state,
          canonicalJson(journal),
          result.quiescent ? this.now() : null,
          group.run_id,
          group.generation,
          operation,
        );
      this.store.db
        .prepare(
          'UPDATE combined_groups SET integration_milliseconds=MIN(integration_maximum_minutes*60000,integration_milliseconds+?),integration_active=?,integration_finished_at=? WHERE run_id=?',
        )
        .run(elapsed, result.quiescent ? 0 : 1, result.quiescent ? this.now() : null, group.run_id);
      if (state === 'unknown') this.updateCombined(group, 'unknown', 'ownership-unknown');
      this.refreshCombinedStop(group);
    });
    if (result.reason !== null || !result.quiescent)
      throw Error(result.reason ?? 'Integration ownership is unknown.');
    return result.value as T;
  }

  private combinedCheck(
    group: CombinedGroup,
    phase: 'baseline' | 'replay-0' | 'replay-1' | 'final-check',
    candidate: Candidate,
    effects: (() => void)[],
    originHash: string,
  ): Promise<boolean> {
    const { manifest } = this.combinedCurrent(group);
    const slot = this.store
      .combinedDispatches(group.run_id)
      .find((slot) => slot.phase === phase) as CombinedDispatch;
    if (slot.state === 'passed' && slot.candidate_id === candidate.id) {
      this.combinedChecked(group, phase, candidate, originHash);
      return Promise.resolve(true);
    }
    if (slot.state !== 'reserved') throw Error('The combined check slot was consumed.');
    if (phase !== 'final-check' && Date.parse(manifest.expiresAt) <= Date.parse(this.now()))
      throw Error('The combined phase consent expired.');
    const definition = this.combinedDefinition(group, phase, candidate, originHash);
    const plan = this.evidence.prepareChecks({
      candidate,
      sourceFiles: committedFiles(
        this.projectPath(manifest.task.projectId) as string,
        manifest.run.source.base,
      ),
      criteria: manifest.task.criteria,
      expected: definition,
    });
    const route = this.localCheckRoute();
    if (!route) throw Error('The trusted check route is unavailable.');
    if (!this.store.get<Route>('route', route.id)) this.store.put('route', route.id, 0, route);
    const attempt = this.jobAttempt(manifest.run, route.id);
    this.admitJob(manifest.run, attempt, plan.directory, slot.maximum_minutes, phase);
    this.store.db
      .prepare(
        'UPDATE combined_dispatches SET candidate_id=?,definition_hash=? WHERE parent_run_id=? AND phase=?',
      )
      .run(candidate.id, definition.definitionHash, group.run_id, phase);
    const phaseArtifact = this.nativeArtifact({
      runId: group.run_id,
      generation: group.generation,
      phase,
      candidateId: candidate.id,
      definitionHash: definition.definitionHash,
    });
    this.store.saveReceipt(`combined-check:${attempt.id}`, phaseArtifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: phaseArtifact,
    });
    const ready = Promise.withResolvers<boolean>();
    effects.push(() => {
      if (this.closed || this.store.get<Attempt>('attempt', attempt.id)?.state !== 'intent') {
        ready.resolve(false);
        return;
      }
      void this.launchCombinedCheck(group, attempt, candidate, plan).then(ready.resolve, () =>
        ready.resolve(false),
      );
    });
    return ready.promise;
  }

  private async launchCombinedCheck(
    group: CombinedGroup,
    attempt: Attempt,
    candidate: Candidate,
    plan: CheckPlan,
  ): Promise<boolean> {
    let job: OwnedCommand;
    const slot = this.store
      .combinedDispatches(group.run_id)
      .find((slot) => slot.attempt_id === attempt.id) as CombinedDispatch;
    let timedOut = false;
    try {
      if (this.closed) throw Error('Controller is closing.');
      this.combinedCurrent(group, this.store.combinedGroup(group.run_id)?.phase === 'paused');
      if (this.closed) throw Error('Controller is closing.');
      job = new OwnedCommand({
        argv: plan.argv,
        directory: plan.directory,
        environmentHome: join(this.home, 'environment', attempt.id),
        onSpawn: (pid) => this.acknowledgeJob(attempt, pid),
      });
      this.jobs.set(attempt.id, job);
    } catch {
      this.settleJob(attempt, false);
      return false;
    }
    const completed = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<null>();
    const drained = closedBefore(job.closed, interrupted.promise);
    let cleanupCancel: (() => void) | undefined;
    const stop = () => {
      job.stop();
      cleanupCancel ??= (this.options.schedule ?? defaultSchedule)(
        () => interrupted.resolve(null),
        1000,
      );
    };
    this.combinedCheckOwners.set(attempt.id, { stop, done: completed.promise });
    try {
      const cancelDeadline = (this.options.schedule ?? defaultSchedule)(
        () => {
          timedOut = true;
          stop();
        },
        this.jobDeadline(attempt.id, slot.maximum_minutes),
      );
      const cancel = () => {
        cancelDeadline();
        interrupted.resolve(null);
      };
      this.jobCancels.set(attempt.id, cancel);
      const exit = await Promise.race([job.exited, interrupted.promise]);
      if (!exit) {
        this.settleJob(attempt, false, true);
        return false;
      }
      const quiescent = (await drained) && (await job.quiescent(this.options.schedule));
      cancel();
      let authority = false;
      try {
        this.combinedCurrent(group, this.store.combinedGroup(group.run_id)?.phase === 'paused');
        authority = !this.cancelledJobs.has(attempt.id) && !this.closed;
      } catch {}
      const result = this.evidence.recordCheck({
        candidate,
        plan,
        passed:
          authority &&
          quiescent &&
          exit.code === 0 &&
          exit.signal === null &&
          !job.failed &&
          !timedOut &&
          this.jobDeadline(attempt.id, slot.maximum_minutes) > 0,
        output: Buffer.concat(job.stdout),
      });
      const passed = this.store.transaction(() => {
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
        this.store.db
          .prepare(
            'UPDATE combined_dispatches SET state=?,check_artifact_id=? WHERE parent_run_id=? AND phase=?',
          )
          .run(
            quiescent ? (check.passed ? 'passed' : 'failed') : 'unknown',
            check.artifactId,
            group.run_id,
            slot.phase,
          );
        this.event(
          'check.completed',
          group.task_id,
          this.store.get<Task>('task', group.task_id)?.revision ?? 0,
          check,
        );
        if (!quiescent) this.updateCombined(group, 'unknown', 'ownership-unknown');
        else if (
          !check.passed &&
          !['stopping', 'stopped', 'paused'].includes(
            (this.store.combinedGroup(group.run_id) as CombinedGroup).phase,
          )
        )
          this.updateCombined(group, 'blocked', 'checks-failed');
        return check.passed && quiescent;
      });
      const settled = this.settleJob(attempt, quiescent, true);
      return passed && settled;
    } finally {
      cleanupCancel?.();
      this.combinedCheckOwners.delete(attempt.id);
      completed.resolve();
    }
  }

  private resumeCombined(
    command: Extract<Command, { command: 'ResumeRun' }>,
    group: CombinedGroup,
  ): CommandResult {
    if (group.task_id !== command.payload.taskId || group.phase !== 'paused' || !group.paused_phase)
      return { outcome: 'blocked', reason: 'combined-resume-unavailable' };
    const { manifest, task } = this.combinedCurrent(group, true);
    const slots = this.store.combinedDispatches(group.run_id);
    const owned = this.store
      .intents()
      .filter((intent) => slots.some((slot) => slot.attempt_id === intent.attempt_id));
    const journals = this.store.combinedRefIntents(group.run_id);
    if (
      slots.some((slot) => slot.state === 'unknown') ||
      journals.some(
        (row) =>
          row.state === 'unknown' ||
          CombinedRefJournalSchema.parse(JSON.parse(row.body)).phases.some(
            (phase) => phase.state !== 'quiescent',
          ),
      )
    )
      return { outcome: 'blocked', reason: 'combined-ownership-unknown' };
    if (
      owned.some((intent) => intent.state !== 'stopped') ||
      group.integration_active ||
      this.combinedOperations.has(group.run_id) ||
      this.combinedPipelines.has(group.run_id)
    )
      return { outcome: 'blocked', reason: 'combined-owner-active' };
    if (slots.some((slot) => ['failed', 'stopped'].includes(slot.state)))
      return { outcome: 'blocked', reason: 'combined-stage-incomplete' };
    const remaining = this.remaining(manifest.run);
    const pending = slots.filter((slot) => slot.state === 'reserved');
    if (
      remaining.attempts < pending.length ||
      remaining.minutes <
        pending.reduce(
          (sum, slot) => sum + slot.maximum_minutes,
          unspentIntegrationMinutes(group),
        ) ||
      remaining.concurrency < 1
    )
      return { outcome: 'blocked', reason: 'combined-budget-exhausted' };
    let current = group;
    for (const operation of ['baseline-ref', 'replay-0-ref', 'replay-1-ref']) {
      const ref = journals.find(
        (row) =>
          row.operation === operation &&
          row.state === 'applied' &&
          row.expected_old === current.current_head,
      );
      if (!ref?.expected_new) continue;
      const candidate = CandidateSchema.parse(
        this.store.get<Candidate>('candidate', ref.candidate_id as string),
      );
      const slot = slots.find((slot) => slot.check_artifact_id === ref.check_artifact_id);
      if (slot?.state !== 'passed' || slot.candidate_id !== candidate.id)
        throw Error('Paused integration proof changed.');
      this.combinedRefCurrent(current, ref.expected_new);
      this.store.db
        .prepare('UPDATE combined_groups SET current_head=? WHERE run_id=? AND generation=?')
        .run(ref.expected_new, group.run_id, group.generation);
      current = this.store.combinedGroup(group.run_id) as CombinedGroup;
    }
    let phase = group.paused_phase;
    if (phase === 'baseline' && slots[0].state === 'passed' && current.current_head)
      phase = 'writers';
    if (phase === 'assembling' && current.final_candidate_id) phase = 'awaiting-evaluation';
    if (phase === 'checking' && slots[5].state === 'passed') {
      const artifact = ArtifactSchema.parse(
        this.store.receipt(`evaluation-started:${group.run_id}`)?.result.entity,
      );
      const plan = this.combinedEvaluationPlan(artifact);
      const proof = this.combinedChecked(
        group,
        'final-check',
        plan.candidate,
        hashCanonical(plan.origin),
      );
      const check = ArtifactSchema.parse(
        this.store.get<Artifact>('artifact', proof.check.artifactId),
      );
      this.store.saveReceipt(`evaluation-result:${artifact.id}`, artifact.hash, 'local-owner', {
        outcome: 'applied',
        entity: check,
      });
      phase = 'awaiting-review';
    }
    if ((phase === 'reviewing' || phase === 'ready') && slots[6].state === 'passed') {
      this.combinedPublicationEvidence(
        group,
        CandidateSchema.parse(
          this.store.get<Candidate>('candidate', current.final_candidate_id as string),
        ),
        true,
      );
      phase = 'ready';
    }
    this.store.db
      .prepare('UPDATE combined_groups SET paused_phase=NULL WHERE run_id=? AND generation=?')
      .run(group.run_id, group.generation);
    this.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run(`paused:${group.run_id}`);
    this.updateCombined(group, phase);
    const updated = this.updateTask(task, {
      state:
        phase === 'prepared'
          ? 'draft'
          : phase === 'ready'
            ? 'ready'
            : phase === 'writers'
              ? 'running'
              : 'stopped',
      waitingReason: null,
      next: 'Admissions resumed under the saved combined limits. Continue the available action.',
    });
    return { outcome: 'applied', entity: manifest.run, revision: updated.revision };
  }

  private startCombinedBaseline(
    command: Extract<Command, { command: 'StartRun' | 'ResumeRun' }>,
    group: CombinedGroup,
    effects: (() => void)[],
  ): CommandResult {
    const { manifest, task } = this.combinedCurrent(group);
    if (
      !['prepared', 'baseline'].includes(group.phase) ||
      this.combinedPipelines.has(group.run_id) ||
      command.command !== 'StartRun'
    )
      return { outcome: 'blocked', reason: 'combined-baseline-unavailable' };
    const candidate = CandidateSchema.parse(
      this.store.get<Candidate>(
        'candidate',
        this.store.combinedDispatches(group.run_id)[0].candidate_id as string,
      ),
    );
    const passed = this.combinedCheck(group, 'baseline', candidate, effects, group.manifest_hash);
    this.updateCombined(group, 'baseline');
    const updated = this.updateTask(task, {
      state: 'checking',
      waitingReason: null,
      next: 'Checking the common baseline.',
    });
    effects.push(() => {
      const pipeline = passed
        .then(async (pass) => {
          if (!pass) return;
          try {
            await this.combinedGit(group, 'baseline-initialize', {}, (git, options) =>
              git.initialize(options),
            );
            const tree = await this.combinedGit(
              group,
              'baseline-tree',
              { candidate },
              (git, options) => git.importTree(this.evidence.read(candidate).files, options),
            );
            const check = this.checks(candidate).find((check) => check.passed) as CheckResult;
            await this.combinedGit(
              group,
              'baseline-ref',
              { candidate, check, old: null, next: tree },
              (git, options) => git.compareAndSwap({ old: null, new: tree }, options),
            );
            this.store.transaction(() => {
              this.combinedCurrent(group);
              this.store.db
                .prepare(
                  'UPDATE combined_groups SET current_head=? WHERE run_id=? AND generation=?',
                )
                .run(tree, group.run_id, group.generation);
              this.updateCombined(group, 'writers');
              this.updateTask(this.store.get<Task>('task', group.task_id) as Task, {
                state: 'running',
                waitingReason: null,
                next: 'Baseline passed. Start both prepared child slices.',
              });
            });
          } catch {
            if (
              !this.closed &&
              !['stopping', 'stopped', 'paused'].includes(
                this.store.combinedGroup(group.run_id)?.phase ?? '',
              )
            )
              this.store.transaction(() =>
                this.updateCombined(
                  group,
                  this.store.combinedGroup(group.run_id)?.phase === 'unknown'
                    ? 'unknown'
                    : 'blocked',
                  'ownership-unknown',
                ),
              );
          }
        })
        .finally(() => this.combinedPipelines.delete(group.run_id));
      this.combinedPipelines.set(group.run_id, pipeline);
    });
    return { outcome: 'applied', entity: manifest.run, revision: updated.revision };
  }

  private combinedDefinition(
    group: CombinedGroup,
    phase: 'baseline' | 'replay-0' | 'replay-1' | 'final-check',
    candidate: Candidate,
    originHash: string,
  ) {
    const manifest = this.combinedManifest(group);
    const testFiles =
      phase === 'replay-0'
        ? manifest.input.checks.replayTestFiles[0]
        : phase === 'replay-1'
          ? [...new Set(manifest.input.checks.replayTestFiles.flat())]
          : manifest.input.checks.testFiles;
    return this.evidence.describeChecks({
      candidate,
      sourceFiles: committedFiles(
        this.projectPath(manifest.task.projectId) as string,
        manifest.run.source.base,
      ),
      criteria: manifest.task.criteria,
      selection: { recipeId: 'project-node-tests-v1', testFiles },
      combined: {
        manifestHash: group.manifest_hash,
        generation: group.generation,
        phase,
        originHash,
      },
    });
  }

  private combinedChecked(
    group: CombinedGroup,
    phase: 'baseline' | 'replay-0' | 'replay-1' | 'final-check',
    candidate: Candidate,
    originHash: string,
  ) {
    const slot = this.store.combinedDispatches(group.run_id).find((slot) => slot.phase === phase);
    const definition = this.combinedDefinition(group, phase, candidate, originHash);
    const check = this.checks(candidate).find(
      (check) => check.artifactId === slot?.check_artifact_id,
    );
    const intent = this.store.intents().find((intent) => intent.attempt_id === slot?.attempt_id);
    if (
      slot?.state !== 'passed' ||
      slot.candidate_id !== candidate.id ||
      slot.definition_hash !== definition.definitionHash ||
      intent?.state !== 'stopped' ||
      this.store.get<Attempt>('attempt', intent.attempt_id)?.state !== 'stopped' ||
      !check ||
      !this.checkMatches(check, candidate, definition)
    )
      throw Error('The exact combined check is incomplete.');
    return { check, definition, slot };
  }

  private combinedContributors(group: CombinedGroup) {
    const { manifest, members } = this.combinedCurrent(group);
    const slots = this.store.combinedDispatches(group.run_id);
    return members.map((member, index) => {
      const slot = slots[index + 1];
      const candidate = slot.candidate_id
        ? this.store.get<Candidate>('candidate', slot.candidate_id)
        : undefined;
      if (!candidate || slot.state !== 'passed') throw Error('Both child writers must finish.');
      const verified = this.evaluationOrigin(member.task_id, candidate.id);
      if (
        verified.writer.id !== slot.attempt_id ||
        verified.run.id !== member.run_id ||
        hashCanonical(verified.run.policy) !== hashCanonical(manifest.run.policy)
      )
        throw Error('The child ownership changed.');
      return { member, ...verified };
    });
  }

  private combinedRefCurrent(group: CombinedGroup, preparedHead?: string | null) {
    const directory = join(
      this.home,
      'integration',
      group.run_id,
      `integration-${group.run_id}.git`,
    );
    for (const suffix of ['', 'refs', 'refs/crewkite', 'refs/crewkite/integration']) {
      const path = suffix ? join(directory, suffix) : directory;
      const state = lstatSync(path);
      if (
        !state.isDirectory() ||
        state.isSymbolicLink() ||
        realpathSync(path) !== path ||
        state.uid !== process.getuid?.() ||
        (state.mode & 0o022) !== 0
      )
        throw Error('Private integration storage changed.');
    }
    const path = join(directory, group.integration_ref);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const state = fstatSync(fd);
      if (
        !state.isFile() ||
        state.nlink !== 1 ||
        state.uid !== process.getuid?.() ||
        state.size !== 41 ||
        (state.mode & 0o022) !== 0
      )
        throw Error('Private integration ref changed.');
      const bytes = readFileSync(fd);
      if (
        bytes.toString() !== `${group.current_head}\n` &&
        (!preparedHead || bytes.toString() !== `${preparedHead}\n`)
      )
        throw Error('Private integration head changed.');
    } finally {
      closeSync(fd);
    }
  }

  private combinedOrigin(group: CombinedGroup, candidate: Candidate) {
    const key = `combined-origin:${group.run_id}:${candidate.id}:${candidate.hash}`;
    const cached = this.projectionCache?.get(key) as CombinedOrigin | undefined;
    if (cached) return cached;
    const { manifest } = this.combinedCurrent(group, true);
    if (
      candidate.id !== group.final_candidate_id ||
      candidate.taskId !== group.task_id ||
      !group.origin_artifact_id ||
      group.integration_active ||
      this.store.combinedDispatches(group.run_id).some((slot) => slot.state === 'unknown')
    )
      throw Error('The combined candidate is unavailable.');
    const record = ArtifactSchema.parse(
      this.store.get<Artifact>('artifact', group.origin_artifact_id),
    );
    if (record.bytes > MAX_FRAME_BYTES) throw Error('Combined origin exceeds its bound.');
    const origin = CombinedOriginSchema.parse(
      JSON.parse(this.artifacts.read(record.hash).toString('utf8')),
    );
    const contributors = this.combinedContributorsForOrigin(group);
    if (
      origin.taskId !== group.task_id ||
      origin.runId !== group.run_id ||
      origin.preparationId !== group.preparation_id ||
      origin.manifestHash !== group.manifest_hash ||
      origin.generation !== group.generation ||
      origin.sourceBase !== manifest.run.source.base ||
      origin.sourceManifestHash !== hashCanonical(manifest.sourceFiles) ||
      origin.policyHash !== manifest.run.policy.hash ||
      origin.criteriaHash !== hashCanonical(manifest.task.criteria) ||
      origin.candidateId !== candidate.id ||
      origin.candidateHash !== candidate.hash ||
      hashCanonical(origin.contributors) !== hashCanonical(contributors)
    )
      throw Error('Combined origin changed.');
    const baselineSlot = this.store.combinedDispatches(group.run_id)[0];
    const baseline = CandidateSchema.parse(
      this.store.get<Candidate>('candidate', baselineSlot.candidate_id as string),
    );
    const baselineProof = this.combinedChecked(group, 'baseline', baseline, group.manifest_hash);
    const baselineRef = this.store
      .combinedRefIntents(group.run_id)
      .find((row) => row.operation === 'baseline-ref');
    if (
      baselineRef?.state !== 'applied' ||
      baselineRef.expected_old !== null ||
      baselineRef.expected_new !== origin.steps[0].previousTree ||
      baselineRef.candidate_id !== baseline.id ||
      baselineRef.check_artifact_id !== baselineProof.check.artifactId
    )
      throw Error('The checked baseline changed.');
    const replay = assembleSlices({
      base: manifest.run.source.base,
      files: this.evidence.read(baseline).files,
      members: [0, 1].map((index) => ({
        base: manifest.run.source.base,
        scope: [manifest.input.children[index].scope[0]],
        dependencies: [],
        files: this.evidence.read(
          CandidateSchema.parse(
            this.store.get<Candidate>('candidate', origin.contributors[index].candidateId),
          ),
        ).files,
      })) as unknown as Parameters<typeof assembleSlices>[0]['members'],
    });
    if (
      replay.some((step) => step.changes.length !== 1) ||
      this.evidence.hash(manifest.run.source.base, replay[1].files) !== candidate.hash
    )
      throw Error('Combined replay inventory changed.');
    for (const [index, step] of origin.steps.entries()) {
      const stage = CandidateSchema.parse(this.store.get<Candidate>('candidate', step.candidateId));
      const verified = this.combinedChecked(
        group,
        index === 0 ? 'replay-0' : 'replay-1',
        stage,
        hashCanonical({ manifestHash: group.manifest_hash, contributors, index }),
      );
      const cas = this.store
        .combinedRefIntents(group.run_id)
        .find((row) => row.operation === `replay-${index}-ref`);
      const tree = this.store
        .combinedRefIntents(group.run_id)
        .find((row) => row.operation === `replay-${index}-tree`);
      if (
        tree?.state !== 'applied' ||
        tree.candidate_id !== stage.id ||
        CombinedRefJournalSchema.parse(JSON.parse(tree.body)).value !== step.nextTree ||
        this.evidence.hash(manifest.run.source.base, replay[index].files) !== stage.hash
      )
        throw Error('The immutable replay tree changed.');
      if (
        stage.hash !== step.candidateHash ||
        verified.definition.definitionHash !== step.definitionHash ||
        verified.check.artifactId !== step.checkArtifactId ||
        !cas ||
        cas.state !== 'applied' ||
        cas.generation !== group.generation ||
        cas.expected_old !== step.previousTree ||
        cas.expected_new !== step.nextTree ||
        cas.candidate_id !== stage.id ||
        cas.check_artifact_id !== verified.check.artifactId
      )
        throw Error('The checked integration chain changed.');
    }
    if (
      origin.steps[1].nextTree !== group.current_head ||
      this.evidence.read(candidate).base !== manifest.run.source.base
    )
      throw Error('Combined final head changed.');
    this.combinedRefCurrent(group);
    this.projectionCache?.set(key, origin);
    return origin;
  }

  private combinedContributorsForOrigin(group: CombinedGroup) {
    const current = this.store.combinedGroup(group.run_id) as CombinedGroup;
    const savedPhase = current.phase;
    // Completed evidence remains readable after admission closes.
    const contributors = this.store.combinedMembers(group.run_id).map((member, index) => {
      const slot = this.store.combinedDispatches(group.run_id)[index + 1];
      const candidate = CandidateSchema.parse(
        this.store.get<Candidate>('candidate', slot.candidate_id as string),
      );
      const verified = this.evaluationOrigin(member.task_id, candidate.id);
      if (slot.state !== 'passed' || verified.writer.id !== slot.attempt_id)
        throw Error('Contributor evidence changed.');
      return {
        taskId: member.task_id,
        runId: member.run_id,
        attemptId: verified.writer.id,
        generation: verified.writer.generation,
        routeId: verified.writer.routeId,
        candidateId: candidate.id,
        candidateHash: candidate.hash,
        scopeHash: member.scope_hash,
      };
    });
    if (this.store.combinedGroup(group.run_id)?.phase !== savedPhase)
      throw Error('Combined phase changed.');
    return contributors as CombinedOrigin['contributors'];
  }

  private assembleCombined(
    command: Extract<Command, { command: 'AssembleCombinedCandidate' }>,
    effects: (() => void)[],
  ): CommandResult {
    const group = this.store.combinedGroup(command.payload.runId);
    if (
      !group ||
      group.task_id !== command.payload.taskId ||
      group.preparation_id !== command.payload.preparationId ||
      !['writers', 'assembling'].includes(group.phase) ||
      this.combinedPipelines.has(group.run_id)
    )
      return { outcome: 'blocked', reason: 'combined-assembly-unavailable' };
    const { manifest, task } = this.combinedCurrent(group);
    const contributors = this.combinedContributors(group);
    const files = committedFiles(
      this.projectPath(task.projectId) as string,
      manifest.run.source.base,
    );
    const stages = assembleSlices({
      base: manifest.run.source.base,
      files,
      members: [contributors[0], contributors[1]].map((entry) => ({
        base: entry.run.source.base,
        scope: [entry.member.scope_path],
        dependencies: [],
        files: this.evidence.read(entry.candidate).files,
      })) as unknown as Parameters<typeof assembleSlices>[0]['members'],
    });
    if (stages.some((stage) => stage.changes.length !== 1))
      return { outcome: 'blocked', reason: 'combined-substantive-slices-required' };
    const preparedCas = this.store
      .combinedRefIntents(group.run_id)
      .find(
        (row) =>
          row.state === 'prepared' &&
          row.expected_old === group.current_head &&
          row.expected_new &&
          CombinedRefJournalSchema.parse(JSON.parse(row.body)).phases.every(
            (phase) => phase.state === 'quiescent',
          ),
      );
    this.combinedRefCurrent(group, preparedCas?.expected_new);
    this.updateCombined(group, 'assembling');
    const updated = this.updateTask(task, {
      state: 'checking',
      waitingReason: null,
      next: 'Replaying the two checked slices in order.',
    });
    effects.push(() => {
      const pipeline = this.assembleCombinedStages(group, stages)
        .catch(() => {
          if (!this.closed)
            this.store.transaction(() => {
              const current = this.store.combinedGroup(group.run_id) as CombinedGroup;
              if (!['stopping', 'stopped', 'paused', 'unknown'].includes(current.phase))
                this.updateCombined(current, 'blocked', 'checks-failed');
            });
        })
        .finally(() => this.combinedPipelines.delete(group.run_id));
      this.combinedPipelines.set(group.run_id, pipeline);
    });
    return { outcome: 'applied', entity: manifest.run, revision: updated.revision };
  }

  private async assembleCombinedStages(
    group: CombinedGroup,
    stages: ReturnType<typeof assembleSlices>,
  ) {
    const contributors = this.combinedContributorsForOrigin(group);
    const steps: CombinedOrigin['steps'][number][] = [];
    for (const [index, stage] of stages.entries()) {
      const phase = index === 0 ? 'replay-0' : 'replay-1';
      const current = this.combinedCurrent(group).group;
      const slot = this.store
        .combinedDispatches(group.run_id)
        .find((slot) => slot.phase === phase) as CombinedDispatch;
      const stageCandidate = slot.candidate_id
        ? CandidateSchema.parse(this.store.get<Candidate>('candidate', slot.candidate_id))
        : this.store.transaction(() => this.captureCombined(group, stage.files));
      if (
        this.evidence.hash(this.combinedManifest(group).run.source.base, stage.files) !==
        stageCandidate.hash
      )
        throw Error('The assembly stage changed.');
      const pending: (() => void)[] = [];
      const originHash = hashCanonical({ manifestHash: group.manifest_hash, contributors, index });
      let checked: Promise<boolean> = Promise.resolve(false);
      this.store.transaction(() => {
        checked = this.combinedCheck(group, phase, stageCandidate, pending, originHash);
      });
      for (const effect of pending) effect();
      if (!(await checked)) throw Error('A replay check failed.');
      const proof = this.combinedChecked(group, phase, stageCandidate, originHash);
      const tree = await this.combinedGit(
        group,
        `replay-${index}-tree`,
        { candidate: stageCandidate },
        (git, options) => git.importTree(stage.files, options),
      );
      const prior = this.store
        .combinedRefIntents(group.run_id)
        .find((row) => row.operation === `replay-${index}-ref`);
      const previous = prior?.expected_old ?? current.current_head;
      if (!previous || previous === tree) throw Error('The replay has no substantive tree delta.');
      await this.combinedGit(
        group,
        `replay-${index}-ref`,
        { candidate: stageCandidate, check: proof.check, old: previous, next: tree },
        (git, options) => git.compareAndSwap({ old: previous, new: tree }, options),
      );
      this.store.transaction(() => {
        this.combinedCurrent(group);
        this.store.db
          .prepare('UPDATE combined_groups SET current_head=? WHERE run_id=? AND generation=?')
          .run(tree, group.run_id, group.generation);
      });
      steps.push({
        candidateId: stageCandidate.id,
        candidateHash: stageCandidate.hash,
        definitionHash: proof.definition.definitionHash,
        checkArtifactId: proof.check.artifactId,
        previousTree: previous,
        nextTree: tree,
      });
    }
    this.store.transaction(() => {
      const { manifest } = this.combinedCurrent(group);
      const candidate = this.captureCombined(group, stages[1].files);
      const origin = CombinedOriginSchema.parse({
        kind: 'combined',
        taskId: group.task_id,
        runId: group.run_id,
        preparationId: group.preparation_id,
        manifestHash: group.manifest_hash,
        generation: group.generation,
        sourceBase: manifest.run.source.base,
        sourceManifestHash: hashCanonical(manifest.sourceFiles),
        policyHash: manifest.run.policy.hash,
        criteriaHash: hashCanonical(manifest.task.criteria),
        contributors,
        steps,
        candidateId: candidate.id,
        candidateHash: candidate.hash,
      });
      const artifact = this.nativeArtifact(origin);
      this.store.db
        .prepare(
          'UPDATE combined_groups SET final_candidate_id=?,origin_artifact_id=? WHERE run_id=? AND generation=?',
        )
        .run(candidate.id, artifact.id, group.run_id, group.generation);
      this.updateCombined(group, 'awaiting-evaluation');
      this.updateTask(this.store.get<Task>('task', group.task_id) as Task, {
        state: 'stopped',
        waitingReason: null,
        next: 'The combined candidate is sealed. Prepare its full evaluation.',
      });
    });
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
      if (!this.planProposal(task.id, discussion.adoptedProposal))
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
    const combined = run && this.store.combinedGroup(run.id);
    let quotaRetry = false;
    let combinedQuota: ReturnType<Controller['quotaRetryEvidence']> | undefined;
    if (
      combined &&
      run &&
      command.command === 'ResumeRun' &&
      this.store.receipt(`native-run:${run.id}`)
    ) {
      try {
        combinedQuota = this.quotaRetryEvidence(run, true);
      } catch {}
    }
    if (combined?.task_id === command.payload.taskId && command.command === 'ResumeRun')
      return this.resumeCombined(command, combined);
    if (combined && !combinedQuota) this.combinedCurrent(combined);
    if (combined && combined.task_id === command.payload.taskId)
      return this.startCombinedBaseline(command, combined, effects);
    if (
      combined &&
      !combinedQuota &&
      !this.combinedPreview(combined).members.find((member) => member.runId === run?.id)?.start
        .available
    )
      return { outcome: 'blocked', reason: 'combined-child-not-admissible' };
    if (run && this.store.receipt(`local-prepared:${run.id}`))
      return command.command === 'StartRun'
        ? this.startLocal(command, effects)
        : { outcome: 'blocked', reason: 'native-pilot-retain-only' };
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
    if (
      !native &&
      run &&
      command.command === 'ResumeRun' &&
      this.store.receipt(`native-run:${run.id}`)
    ) {
      try {
        native = this.quotaRetryBinding(run);
        planned = native.attempt;
        quotaRetry = true;
      } catch {
        return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
      }
    }
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
    const spent = this.chargeableIntents().filter((intent) => intent.run_id === run.id).length;
    const reviewReserve = (run.policy.policy.methods ?? []).reduce(
      (sum, method) => sum + method.cycles,
      0,
    );
    const previousCandidate = this.latestCandidate(run.id);
    const checkReserve =
      previousCandidate && this.checks(previousCandidate).some((check) => check.passed) ? 0 : 1;
    if (!combined && spent + reviewReserve + checkReserve >= run.policy.policy.limits.attempts)
      return {
        outcome: 'blocked',
        reason: 'attempt-budget-exhausted',
        next: 'Prepare a new bounded run with enough review headroom.',
      };
    const remaining = this.remaining(run);
    if (remaining.attempts < (combined ? 1 : reviewReserve + checkReserve + 1))
      return {
        outcome: 'blocked',
        reason: 'review-budget-insufficient',
        next: 'The remaining task allowance must cover the writer, checks and selected reviews.',
      };
    if (remaining.attempts === 0 || remaining.minutes === 0 || remaining.concurrency === 0)
      return { outcome: 'blocked', reason: 'run-budget-exhausted' };
    // A spent task allowance can leave less than the limit frozen at preparation. A repository
    // writer longer than five minutes also needs the evaluation floor behind that limit. A
    // five-minute writer starts with its own five.
    if (native) {
      const limit = native.appointment.maximumTaskMs;
      const floored = 'repository' in native.appointment && limit > 5 * 60_000;
      if (remaining.minutes * 60_000 < limit + (floored ? evaluationFloorMinutes * 60_000 : 0))
        return {
          outcome: 'blocked',
          reason: 'run-budget-exhausted',
          ...(floored
            ? {
                next: 'The task has fewer minutes than the writer limit plus its check. Prepare a run that fits.',
              }
            : {}),
        };
    }
    const lease = this.store.db
      .prepare('SELECT attempt_id FROM writer_leases WHERE task_id=?')
      .get(task.id);
    if (lease) return { outcome: 'blocked', reason: 'writer-lease-held' };
    const googleBlocker = this.store.googleStartBlocker(attempt.routeId);
    if (googleBlocker) return { outcome: 'blocked', reason: googleBlocker };
    const openAiBlocker = this.openAiUsageBlocker(attempt.routeId);
    if (openAiBlocker) return { outcome: 'blocked', reason: openAiBlocker };
    const nativeTools =
      native && 'repository' in native.appointment
        ? this.grant(run, 'run-native-tools', project.name)
        : undefined;
    if (native && 'repository' in native.appointment && !nativeTools)
      return { outcome: 'blocked', reason: 'native-tools-grant-unavailable' };
    if (native && 'acp' in native.appointment) {
      const preparing = this.acpStart;
      if (
        !preparing ||
        preparing.key !== command.key ||
        preparing.taskId !== task.id ||
        preparing.runId !== run.id ||
        preparing.aborted
      )
        return { outcome: 'blocked', reason: 'acp-start-revoked' };
      if (
        preparing.expired ||
        performance.now() >= preparing.deadline ||
        Date.parse(this.now()) >= preparing.wallDeadline
      )
        return { outcome: 'blocked', reason: 'acp-start-deadline' };
      const reader = this.store.googleUsageReader();
      if (reader.authority_revision !== preparing.authorityRevision)
        return { outcome: 'blocked', reason: 'usage-read-revoked' };
    }
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
    if (allocation && !allocated) this.consumeGrant(run, allocation);
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
    if (combined) {
      const member = this.store
        .combinedMembers(combined.run_id)
        .find((member) => member.run_id === run.id);
      if (!member) throw Error('The combined member disappeared.');
      const phase = member.ordinal === 0 ? 'writer-0' : 'writer-1';
      if (combinedQuota)
        this.store.retryCombinedDispatch(
          combined.run_id,
          phase,
          attempt.id,
          combinedQuota.attempt.id,
        );
      else this.store.admitCombinedDispatch(combined.run_id, phase, attempt.id);
      if (combinedQuota) this.updateCombined(combined, 'writers');
    }
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
          combined
            ? (this.store
                .combinedDispatches(combined.run_id)
                .find((slot) => slot.attempt_id === attempt.id)?.maximum_minutes ?? 0)
            : remaining.minutes,
        );
    const admitted = { ...run, decision, revision: run.revision + 1 };
    this.store.put('run', run.id, admitted.revision, admitted);
    if (native && (native.handoff || quotaRetry)) {
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

  private quotaRetryEvidence(run: Run, resetElapsed: boolean) {
    const task = this.store.get<Task>('task', run.taskId);
    const origin = NativePreparationSchema.parse(this.nativeRecord(`native-run:${run.id}`).value);
    const intents = this.store.intents().filter((value) => value.run_id === run.id);
    const generations = new Map<number, LaunchIntent>();
    for (const value of intents) {
      if (generations.has(value.generation)) throw Error('Quota retry generation is ambiguous.');
      generations.set(value.generation, value);
    }
    const intent = intents.reduce<LaunchIntent | undefined>(
      (latest, value) => (!latest || value.generation > latest.generation ? value : latest),
      undefined,
    );
    if (!task || !intent) throw Error('Quota retry is unavailable.');
    const attempt = this.store.get<Attempt>('attempt', intent.attempt_id);
    const completion = NativeQuotaCompletionSchema.parse(
      this.nativeRecord(`native-completion:${intent.attempt_id}`, 4096).value,
    );
    const reset = Date.parse(completion.diagnostic.providerFailure.resetsAt);
    const phases = this.store.nativeProcesses(intent.attempt_id);
    const group = this.store.combinedGroup(run.id);
    const member = group
      ? this.store.combinedMembers(group.run_id).find((value) => value.run_id === run.id)
      : undefined;
    const slot =
      group && member
        ? this.store
            .combinedDispatches(group.run_id)
            .find((value) => value.phase === `writer-${member.ordinal}`)
        : undefined;
    const sibling = group
      ? this.store
          .combinedDispatches(group.run_id)
          .find((value) => value.phase.startsWith('writer-') && value.phase !== slot?.phase)
      : undefined;
    const siblingMember =
      group && sibling
        ? this.store
            .combinedMembers(group.run_id)
            .find((value) => sibling.phase === `writer-${value.ordinal}`)
        : undefined;
    const siblingCandidate = sibling?.candidate_id
      ? this.store.get<Candidate>('candidate', sibling.candidate_id)
      : undefined;
    let siblingProven = !group;
    let siblingRetryRunning = false;
    if (group && sibling && siblingMember && siblingCandidate) {
      try {
        siblingProven =
          sibling.state === 'passed' &&
          this.evaluationOrigin(siblingMember.task_id, siblingCandidate.id).writer.id ===
            sibling.attempt_id;
      } catch {}
    }
    if (group && sibling && siblingMember && !siblingProven) {
      const siblingAttempt = sibling.attempt_id
        ? this.store.get<Attempt>('attempt', sibling.attempt_id)
        : undefined;
      const siblingIntent = sibling.attempt_id
        ? this.store.intents().find((value) => value.attempt_id === sibling.attempt_id)
        : undefined;
      if (
        siblingAttempt &&
        siblingIntent &&
        siblingAttempt.runId === siblingMember.run_id &&
        siblingIntent.run_id === siblingMember.run_id
      ) {
        if (sibling.state === 'stopped') {
          const siblingPhases = this.store.nativeProcesses(siblingAttempt.id);
          siblingProven =
            siblingAttempt.state === 'stopped' &&
            this.confirmedQuotaDenial(siblingIntent) &&
            siblingPhases.length > 0 &&
            siblingPhases.every((phase) => phase.state === 'quiescent');
        } else if (sibling.state === 'running') {
          const priorSibling = this.store
            .intents()
            .filter(
              (value) =>
                value.run_id === siblingMember.run_id &&
                value.generation < siblingAttempt.generation,
            )
            .sort((left, right) => right.generation - left.generation)[0];
          siblingRetryRunning =
            ['intent', 'running'].includes(siblingAttempt.state) &&
            priorSibling?.generation === siblingAttempt.generation - 1 &&
            this.confirmedQuotaDenial(priorSibling);
          siblingProven = siblingRetryRunning;
        }
      }
    }
    if (group) this.combinedCurrent(group, true);
    if (
      task.runId !== run.id ||
      task.state !== 'interrupted' ||
      this.store.receipt(`paused:${run.id}`) ||
      this.hasUncertainWriter(task.id) ||
      !attempt ||
      attempt.state !== 'stopped' ||
      attempt.id !== completion.attemptId ||
      intent.task_id !== task.id ||
      intent.route_id !== attempt.routeId ||
      intent.generation !== attempt.generation ||
      !phases.length ||
      phases.some((phase) => phase.state !== 'quiescent') ||
      (group &&
        (group.run_id === run.id ||
          !member ||
          !slot ||
          !sibling ||
          !siblingProven ||
          slot.attempt_id !== attempt.id ||
          slot.state !== 'stopped' ||
          group.integration_active ||
          !(
            (group.phase === 'blocked' && group.blocker === 'writers-incomplete') ||
            (group.phase === 'writers' && siblingRetryRunning && group.blocker === null)
          ))) ||
      origin.appointment.route.family !== 'anthropic' ||
      'repository' in origin.appointment ||
      !('target' in origin.appointment) ||
      origin.run.id !== run.id ||
      hashCanonical(origin.run.source) !== hashCanonical(run.source) ||
      hashCanonical(origin.run.policy) !== hashCanonical(run.policy) ||
      hashCanonical(origin.run.roles) !== hashCanonical(run.roles) ||
      origin.appointment.consent.criteriaHash !== hashCanonical(task.criteria) ||
      Date.parse(origin.appointment.expiresAt) <= Date.parse(this.now()) ||
      !this.store.receipt(`allocation:${run.id}`) ||
      !run.policy.policy.effects.some(
        (grant) =>
          grant.action === 'write-scratch' &&
          grant.taskId === task.id &&
          !grant.revoked &&
          Date.parse(grant.expiresAt) > Date.parse(this.now()),
      ) ||
      (resetElapsed && reset > Date.parse(this.now()))
    )
      throw Error('Quota retry is unavailable.');
    return { task, origin, attempt, reset, completion, group, member, slot };
  }

  private quotaRetryBinding(run: Run): NativeBinding {
    const { task, origin, attempt } = this.quotaRetryEvidence(run, true);
    const appointment = origin.appointment;
    if (!('target' in appointment)) throw Error('Quota retry target changed.');
    const profile = this.profileFor(origin.public.profileId);
    if (
      !profile.facts.available ||
      profile.facts.family !== 'anthropic' ||
      profile.facts.id !== origin.public.profileId ||
      profile.locationHash !== origin.public.locationHash ||
      hashCanonical(profile.client) !== hashCanonical(origin.appointment.client) ||
      this.nativeProfileRoute(profile, appointment.creditPolicy)?.id !== appointment.route.id ||
      !profile.environment
    )
      throw Error('Quota retry profile changed.');
    const files = committedFiles(this.projectPath(task.projectId) as string, run.source.base);
    const manifest = files.map(({ content: _content, ...file }) => file);
    const original = files.find((file) => file.path === appointment.target.path);
    if (
      hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(run.source) ||
      hashCanonical(manifest) !== hashCanonical(origin.manifest) ||
      !original ||
      original.hash !== origin.originalHash ||
      original.hash !== appointment.target.baseHash
    )
      throw Error('Quota retry source changed.');
    const retried = AttemptSchema.parse({
      id: this.id('att'),
      runId: run.id,
      routeId: attempt.routeId,
      generation: attempt.generation + 1,
      state: 'intent',
      revision: 0,
    });
    const sessionHash = hashCanonical({ attemptId: retried.id });
    const retryPlan = {
      appointment,
      run,
      attempt: retried,
      original: original.content.toString('utf8'),
      baseHash: original.hash,
      anthropicSessionId: `${sessionHash.slice(0, 8)}-${sessionHash.slice(8, 12)}-8${sessionHash.slice(13, 16)}-a${sessionHash.slice(17, 20)}-${sessionHash.slice(20, 32)}`,
      manifest,
      public: origin.public,
      environment: { ...profile.environment },
    };
    const binding = freezeNative({
      ...retryPlan,
      planArtifact: this.nativeArtifact(this.nativePlanPayload(retryPlan)),
    });
    if (!this.nativeConsentCurrent(binding)) throw Error('Quota retry consent changed.');
    this.nativeWriterPlan(binding);
    return binding;
  }

  private quotaRetryPreview(run: Run): z.infer<typeof NativeRunSchema>['quotaRetry'] {
    try {
      const { reset } = this.quotaRetryEvidence(run, false);
      return {
        available: reset <= Date.parse(this.now()),
        mode: run.policy.policy.authority === 'guided' ? 'manual' : 'automatic',
        resetsAt: new Date(reset).toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  private armQuotaRetries() {
    const runIds = new Set(this.store.intents().map((intent) => intent.run_id));
    for (const runId of runIds) {
      const run = this.store.get<Run>('run', runId);
      if (!run || run.policy.policy.authority === 'guided') continue;
      let reset = 0;
      let key = '';
      try {
        const evidence = this.quotaRetryEvidence(run, false);
        reset = evidence.reset;
        key = `quota-retry:${run.id}:${hashCanonical(evidence.completion.diagnostic.providerFailure)}`;
      } catch {
        continue;
      }
      if (this.store.receipt(key) || this.quotaRetries.has(key)) continue;
      const cancel = (this.options.schedule ?? defaultSchedule)(
        () => this.runQuotaRetry(runId, key),
        Math.max(0, reset - Date.parse(this.now())),
      );
      this.quotaRetries.set(key, cancel);
    }
  }

  private runQuotaRetry(runId: string, key: string) {
    this.quotaRetries.delete(key);
    if (this.closed) return;
    const effects: (() => void)[] = [];
    try {
      this.store.transaction(() => {
        if (this.store.receipt(key)) return;
        const run = this.store.get<Run>('run', runId);
        const task = run && this.store.get<Task>('task', run.taskId);
        let result: CommandResult = { outcome: 'blocked', reason: 'quota-retry-unavailable' };
        if (run && task && run.policy.policy.authority !== 'guided') {
          const command = CommandSchema.parse({
            protocol: 1,
            key: this.id('cmd'),
            actor: { id: 'controller', kind: 'controller' },
            command: 'ResumeRun',
            expectedRevision: task.revision,
            payload: { taskId: task.id, runId: run.id },
          });
          result = this.start(command as Extract<Command, { command: 'ResumeRun' }>, effects);
        }
        this.store.saveReceipt(key, hashCanonical({ runId, key }), 'local-owner', result);
      });
    } catch {
      effects.length = 0;
      try {
        this.store.transaction(() => {
          if (!this.store.receipt(key))
            this.store.saveReceipt(key, hashCanonical({ runId, key }), 'local-owner', {
              outcome: 'blocked',
              reason: 'quota-retry-unavailable',
            });
        });
      } catch {}
    }
    for (const effect of effects)
      try {
        effect();
      } catch {}
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
    const localIndex = profiles.findIndex((profile) => profile.facts.family === 'local');
    if (localIndex >= 0) profiles.splice(localIndex, 1);
    profiles.push({ facts: this.localConnection().facts });
    if (
      profiles.length > 7 ||
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

  private nativeRuns(runIds?: ReadonlySet<string>): z.infer<typeof NativeRunSchema>[] {
    return (runIds ? this.store.byIds<Run>('run', runIds) : this.store.list<Run>('run')).flatMap(
      (run) => {
        const origin = this.store.receipt(this.currentNativePlanKey(run.id));
        if (!origin) return [];
        const prepared = this.store.receipt(`native-prepared:${run.id}`);
        if (this.store.receipt(`local-prepared:${run.id}`)) {
          try {
            const plan = this.localPrepared(run.id);
            return [
              NativeRunSchema.parse({
                runId: run.id,
                profileId: 'local-file-v1',
                stage:
                  prepared &&
                  this.store.get<Task>('task', run.taskId)?.runId === run.id &&
                  this.store.get<Task>('task', run.taskId)?.state === 'draft' &&
                  !this.store.intents().some((intent) => intent.run_id === run.id)
                    ? 'prepared'
                    : 'retain-only',
                expiresAt: plan.expiresAt,
                localModel: plan.localModel,
                target: {
                  ...plan.target,
                  bytes: plan.manifest.find((file) => file.path === plan.target.path)?.bytes,
                },
              }),
            ];
          } catch {
            return [
              {
                runId: run.id,
                profileId: 'unavailable-native-plan',
                stage: 'retain-only' as const,
              },
            ];
          }
        }
        try {
          const artifact = ArtifactSchema.parse(origin.result.entity);
          if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Native plan exceeds its bound.');
          const plan = JSON.parse(this.artifacts.read(artifact.hash).toString('utf8'));
          const appointment = NativeAppointmentSchema.parse(plan.appointment);
          const publicScope = NativePublicScopeSchema.safeParse(plan.public).data;
          const handoff = this.nativeHandoffPreview(run);
          const quotaRetry = this.quotaRetryPreview(run);
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
              maximumTaskMs: appointment.maximumTaskMs,
              ...(quotaRetry ? { quotaRetry } : {}),
              ...(handoff ? { handoff } : {}),
              ...(appointment.billingAttestation
                ? { billingAttestation: appointment.billingAttestation }
                : {}),
              ...(appointment.permissionMode ? { permissionMode: appointment.permissionMode } : {}),
              ...('acp' in appointment
                ? {
                    acp: appointment.acp,
                    ...(appointment.contextLines === undefined
                      ? {}
                      : { contextLines: appointment.contextLines }),
                  }
                : {}),
              ...('repository' in appointment
                ? {
                    repository: appointment.repository,
                    execution: appointment.execution,
                    ...(appointment.modelRequest ? { modelRequest: appointment.modelRequest } : {}),
                  }
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
      },
    );
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
    modelRequest?: ConversationModelRequest,
    selection?: ReturnType<typeof resolveOpenAiProjectSelection>,
  ): Route | undefined {
    if (profile.facts.family === 'local') throw Error('Local native launch is unavailable.');
    if ((modelRequest === undefined) !== (selection === undefined))
      throw Error('Native model selection is incomplete.');
    const key = this.nativeProfileRouteKey(profile.facts.id, creditPolicy, modelRequest);
    const receipt = this.store.receipt(key);
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
      model: selection?.model ?? profile.facts.model,
      effort: {
        requested: selection?.effort ?? profile.facts.effort,
        effective:
          profile.facts.family === 'openai'
            ? (selection?.effort ?? profile.facts.effort)
            : 'unknown',
        supported: [selection?.effort ?? profile.facts.effort],
      },
      billing: creditPolicy === 'ordinary' ? 'included' : 'credits',
      qualified: false,
      fake: false,
    });
    if (
      receipt.result.outcome !== 'applied' ||
      plan.public.profileId !== profile.facts.id ||
      plan.appointment.creditPolicy !== creditPolicy ||
      hashCanonical(
        ('modelRequest' in plan.appointment ? plan.appointment.modelRequest : undefined) ?? null,
      ) !== hashCanonical(modelRequest ?? null) ||
      hashCanonical(plan.appointment.client) !== hashCanonical(profile.client) ||
      hashCanonical(route) !== hashCanonical(expected)
    )
      throw Error('Native route binding changed.');
    return expected;
  }

  private nativeProfileRouteKey(
    profileId: string,
    creditPolicy: NativePilotAppointment['creditPolicy'],
    modelRequest?: ConversationModelRequest,
  ) {
    const prefix = `native-profile-route:${profileId}:${creditPolicy}`;
    return modelRequest
      ? `${prefix}:${hashCanonical({
          observation: modelRequest.observation,
          model: modelRequest.model,
          effort: modelRequest.effort,
        })}`
      : prefix;
  }

  private openAiProjectSelection(
    taskId: string,
    profile: NativeProfileResolution,
    request?: ConversationModelRequest,
  ) {
    if (!request) return resolveOpenAiProjectSelection(undefined, undefined);
    if (profile.facts.id !== 'openai-repository-v1' || !profile.client || !profile.locationHash)
      throw Error('The OpenAI project profile is unavailable.');
    const configuration = this.conversationConfiguration(taskId);
    const catalog = this.conversationCatalog(taskId, request.observation);
    const task = this.store.get<Task>('task', taskId);
    const catalogRun = this.store.get<Run>('run', catalog.runId);
    const reason = this.conversationCatalogReason(catalog);
    if (
      reason ||
      hashCanonical(configuration?.modelCatalog ?? null) !== hashCanonical(request.observation) ||
      !task ||
      !catalogRun ||
      hashCanonical(catalogRun.source) !==
        hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) ||
      hashCanonical(profile.client) !== hashCanonical(catalog.client) ||
      profile.locationHash !== catalog.locationHash
    )
      throw Error(reason ?? 'client-changed');
    return resolveOpenAiProjectSelection(
      {
        observation: request.observation,
        models: catalog.models,
      } satisfies RetainedOpenAiModelObservation,
      request,
    );
  }

  private prepareAcp(
    command: Extract<Command, { command: 'PrepareNativeRun' }>,
    maximumMinutes?: number,
  ): CommandResult {
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
      if (task?.state !== 'draft') return { outcome: 'blocked', reason: 'task-not-preparable' };
      const gate = this.draftEditGate(task);
      if (gate) return gate;
      const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
      const files = committedFiles(this.projectPath(task.projectId) as string, source.base);
      const target = files.find((file) => file.path === input.targetPath);
      if (
        !target ||
        target.bytes > 65536 ||
        new TextDecoder('utf-8', { fatal: true }).decode(target.content).includes('\0')
      )
        throw Error('ACP target is unavailable.');
      if (input.contextLines)
        googleAcpTargetContext(target.content.toString('utf8'), input.contextLines);
      const policy = PolicySchema.parse(input.policy);
      const requestedTaskMs = input.maximumTaskMs ?? 300000;
      const maximumTaskMs =
        maximumMinutes === undefined
          ? requestedTaskMs
          : Math.min(requestedTaskMs, maximumMinutes * 60000);
      if (
        requestedTaskMs > profile.facts.maximumTaskMs ||
        (input.maximumTaskMs !== undefined &&
          maximumMinutes !== undefined &&
          requestedTaskMs > maximumMinutes * 60000) ||
        policy.limits.minutes * 60000 < maximumTaskMs ||
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
        ...(input.maximumTaskMs === undefined ? {} : { maximumTaskMs }),
        ...(input.contextLines === undefined ? {} : { contextLines: input.contextLines }),
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
        maximumTaskMs,
        ...(input.contextLines === undefined ? {} : { contextLines: input.contextLines }),
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
      this.attachGoogleUsage(route.id, profile.environment);
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
    const installBlocker = this.googleInstallationBlocker();
    if (installBlocker) return Promise.resolve(installBlocker);
    const deadline = performance.now() + 30000;
    const wallDeadline = Date.parse(this.now()) + 30000;
    const pending = {
      key: command.key,
      hash,
      principal,
      taskId: command.payload.taskId,
      runId: command.payload.runId,
      aborted: false,
      usageKey: undefined as string | undefined,
      authorityRevision: undefined as number | undefined,
      deadline,
      wallDeadline,
      expired: false,
      promise: Promise.resolve<CommandResult>({ outcome: 'blocked' }),
    };
    const cancelDeadline = (this.options.schedule ?? defaultSchedule)(() => {
      pending.expired = true;
      if (pending.usageKey && this.usageRead?.key === pending.usageKey)
        this.usageRead.abort.abort();
    }, 30000);
    const refuse = (result: CommandResult) => this.commitCommand(command, principal, result);
    const cancelled = (): CommandResult | undefined => {
      if (this.closed || pending.aborted)
        return { outcome: 'blocked', reason: 'acp-start-revoked' };
      if (
        pending.expired ||
        performance.now() >= deadline ||
        Date.parse(this.now()) >= wallDeadline
      )
        return { outcome: 'blocked', reason: 'acp-start-deadline' };
    };
    const promise = Promise.resolve().then(async () => {
      try {
        const stale = this.checkRevision(command);
        if (stale) return refuse(stale);
        const cancelledBefore = cancelled();
        if (cancelledBefore) return refuse(cancelledBefore);
        const task = this.store.get<Task>('task', command.payload.taskId),
          run = this.store.get<Run>('run', command.payload.runId);
        if (!task || !run || task.runId !== run.id)
          return refuse({ outcome: 'blocked', reason: 'run-not-current' });
        let binding: NativeBinding;
        try {
          binding = this.preparedNativeBinding(run);
        } catch {
          return refuse({ outcome: 'blocked', reason: 'native-preparation-unavailable' });
        }
        const appointment = binding.appointment;
        if (!('acp' in appointment))
          return refuse({ outcome: 'blocked', reason: 'native-preparation-unavailable' });
        const setup = this.store.googleAcpSetup();
        const quota = this.store.transaction(() => ({
          ...this.acpQuotaState(appointment.route.id, appointment.acp.modelId, run),
          blocker: this.store.googleOperationBlocker(),
        }));
        pending.authorityRevision = quota.reader.authority_revision;
        if (quota.blocker) return refuse({ outcome: 'blocked', reason: quota.blocker });
        if (quota.reserveReason)
          return refuse({
            outcome: 'blocked',
            reason: 'capacity-unavailable',
            next: quota.reserveReason,
          });
        if (quota.needsRefresh) {
          const cancelledRead = cancelled();
          if (cancelledRead) return refuse(cancelledRead);
          pending.usageKey = this.id('cmd');
          const child = CommandSchema.parse({
            protocol: 1,
            key: pending.usageKey,
            actor: command.actor,
            command: 'ObserveUsage',
            expectedRevision: 0,
            payload: { family: 'google' },
          }) as Extract<Command, { command: 'ObserveUsage' }>;
          const result = await this.observeUsageCommand(child, principal);
          const cancelledReadResult = cancelled();
          if (cancelledReadResult) return refuse(cancelledReadResult);
          if (!['applied', 'already-applied'].includes(result.outcome))
            return refuse({
              outcome: 'blocked',
              reason: result.reason ?? 'usage-read-failed',
              ...(result.next ? { next: result.next } : {}),
            });
        }
        const unchanged = (): CommandResult | undefined => {
          const revoked = cancelled();
          if (revoked) return revoked;
          const reader = this.store.googleUsageReader();
          if (reader.authority_revision !== quota.reader.authority_revision)
            return { outcome: 'blocked', reason: 'usage-read-revoked' };
          if (
            hashCanonical(this.store.googleAcpSetup()) !== hashCanonical(setup) ||
            hashCanonical(this.store.get<Task>('task', task.id)) !== hashCanonical(task) ||
            hashCanonical(this.store.get<Run>('run', run.id)) !== hashCanonical(run) ||
            hashCanonical(
              inspectSource(task.projectId, this.projectPath(task.projectId) as string),
            ) !== hashCanonical(run.source)
          )
            return { outcome: 'blocked', reason: 'acp-start-changed' };
          try {
            if (this.preparedNativeBinding(run).planArtifact.hash !== binding.planArtifact.hash)
              return { outcome: 'blocked', reason: 'acp-start-changed' };
          } catch {
            return { outcome: 'blocked', reason: 'native-preparation-unavailable' };
          }
          return cancelled();
        };
        const changed = unchanged();
        if (changed) return refuse(changed);
        const context = await captureContext(this.contextClient(), task.id);
        const changedContext = unchanged();
        if (changedContext) return refuse(changedContext);
        return this.commitCommand(command, principal, undefined, undefined, context);
      } catch {
        return refuse({ outcome: 'blocked', reason: 'acp-context-unavailable' });
      }
    });
    pending.promise = promise;
    this.acpStart = pending;
    return promise.finally(() => {
      cancelDeadline();
      if (this.acpStart === pending) this.acpStart = undefined;
    });
  }

  private localPrepared(runId: string): LocalPrepared {
    const receipt = this.store.receipt(`local-prepared:${runId}`);
    const artifact = ArtifactSchema.parse(receipt?.result.entity);
    if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Local preparation exceeds its bound.');
    const plan = LocalPreparedSchema.parse(
      JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
    );
    if (plan.run.id !== runId) throw Error('Local preparation lineage changed.');
    return plan;
  }

  private prepareLocal(command: Extract<Command, { command: 'PrepareNativeRun' }>): CommandResult {
    if (command.payload.profileId !== 'local-file-v1')
      return { outcome: 'unsupported', reason: 'native-profile-unavailable' };
    try {
      const blocker = this.store.localStartBlocker();
      if (blocker) return { outcome: 'blocked', reason: blocker };
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (task?.state !== 'draft') return { outcome: 'blocked', reason: 'task-not-preparable' };
      const gate = this.draftEditGate(task);
      if (gate) return gate;
      const connection = this.localConnection();
      if (
        !connection.connection ||
        !connection.facts.available ||
        !LocalObservedModelBindingSchema.safeParse(connection.facts.modelBinding).success
      )
        return { outcome: 'blocked', reason: 'local-model-unavailable' };
      const policy = PolicySchema.parse(command.payload.policy);
      if (
        policy.quality !== 'quick' ||
        policy.reserves.length ||
        (policy.methods?.length ?? 0) !== 1 ||
        policy.methods?.[0].id !== 'keep-it-simple' ||
        policy.methods[0].cycles !== 1 ||
        policy.limits.attempts < 3 ||
        policy.limits.concurrency !== 1 ||
        policy.unknownUsage.rule !== 'fixed-allowance' ||
        policy.unknownUsage.allowance.launches < 1 ||
        policy.unknownUsage.allowance.minutes < policy.limits.minutes
      )
        return { outcome: 'blocked', reason: 'local-policy-unavailable' };
      const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
      const files = committedFiles(this.projectPath(task.projectId) as string, source.base);
      const targetPath = command.payload.targetPath;
      const original = files.find((file) => file.path === targetPath);
      if (
        !original ||
        original.bytes > 65536 ||
        original.content.toString('utf8').includes('\0') ||
        !Buffer.from(original.content.toString('utf8')).equals(original.content)
      )
        return { outcome: 'blocked', reason: 'native-target-unavailable' };
      const runId = this.id('run');
      const grant = this.grant(
        { id: runId, taskId: task.id, policy: { policy, hash: hashCanonical(policy) } },
        'write-scratch',
        (this.store.get<Project>('project', task.projectId) as Project).name,
      );
      if (!grant) return { outcome: 'blocked', reason: 'scratch-grant-unavailable' };
      const context = { title: task.title, outcome: task.outcome, criteria: task.criteria };
      const manifest = files.map(({ content: _content, ...file }) => file);
      const target = { path: original.path, baseHash: original.hash };
      const localModel = LocalObservedModelBindingSchema.parse(connection.connection.modelBinding);
      const scopeHash = hashCanonical({
        profile: connection.facts,
        endpoint: connection.connection.endpoint,
        localModel,
        source,
        manifest,
        target,
        context,
        policy,
      });
      let expiresAt = grant.expiresAt;
      if (command.payload.consent === 'saved')
        expiresAt = new Date(
          Math.min(Date.parse(expiresAt), Date.parse(this.consentRecord(scopeHash).expiresAt)),
        ).toISOString();
      const route = RouteSchema.parse({
        id: this.id('rte'),
        family: 'local',
        displayName: connection.facts.displayName,
        model: localModel.modelKey,
        effort: { requested: 'unknown', effective: 'unknown', supported: [] },
        billing: 'local',
        qualified: false,
        fake: false,
      });
      const run = RunSchema.parse({
        id: runId,
        taskId: task.id,
        source,
        policy: { policy, hash: hashCanonical(policy) },
        roles: [{ role: 'coder', routeId: route.id, pinned: true, approvedFallbacks: [] }],
        decision: { chosen: route.id, rejected: [], rule: 'manual', inputsHash: scopeHash },
        revision: 0,
      });
      const attempt = this.jobAttempt(run, route.id);
      const plan = LocalPreparedSchema.parse({
        version: 1,
        kind: 'local-file',
        run,
        attempt,
        profile: connection.facts,
        endpoint: connection.connection.endpoint,
        localModel,
        target,
        manifest,
        context,
        scopeHash,
        expiresAt,
      });
      this.localStartInput(
        plan,
        original.content.toString('utf8'),
        files,
        plan.localModel.authMode === 'none' ? { authMode: 'none' } : { token: 'unsubmitted' },
        300000,
      );
      const artifact = this.nativeArtifact(plan);
      this.store.put('route', route.id, 0, route);
      this.store.put('run', run.id, 0, run);
      this.store.putRunPurpose(run, 'execution', task.runId);
      for (const key of [
        `local-prepared:${run.id}`,
        `native-run:${run.id}`,
        `native-prepared:${run.id}`,
      ])
        this.store.saveReceipt(key, artifact.hash, 'local-owner', {
          outcome: 'applied',
          entity: artifact,
        });
      if (
        command.payload.consent === 'explicit' &&
        !this.store.receipt(`native-consent:${scopeHash}`)
      ) {
        const consent = this.nativeArtifact({ scopeHash, expiresAt });
        this.store.saveReceipt(`native-consent:${scopeHash}`, scopeHash, 'local-owner', {
          outcome: 'applied',
          entity: consent,
        });
      }
      const updated = this.updateTask(task, {
        runId: run.id,
        next: 'Review the Local file preparation and start. Qualification remains pending.',
      });
      this.event('run.prepared', task.id, updated.revision, run);
      return { outcome: 'applied', entity: run, revision: updated.revision };
    } catch {
      return { outcome: 'blocked', reason: 'local-preparation-unavailable' };
    }
  }

  private localStartInput(
    plan: LocalPrepared,
    original: string,
    files: readonly FileContent[],
    credentials: { token: string } | { authMode: 'none' },
    timeoutMs: number,
  ): LocalStart {
    return localPlan({
      binding: {
        ...plan.localModel,
        attemptId: plan.attempt.id,
        generation: plan.attempt.generation,
        profileHash: hashCanonical(plan.profile),
        sourceHash: plan.scopeHash,
        path: plan.target.path,
        baseHash: plan.target.baseHash,
      },
      endpoint: plan.endpoint,
      ...credentials,
      original,
      task: plan.context,
      tests: localTests(plan.target.path, files),
      maximumOutputTokens: plan.profile.maximumOutputTokens,
      timeoutMs,
    });
  }

  private localWriterAuthority(plan: LocalPrepared, active = false) {
    const task = this.store.get<Task>('task', plan.run.taskId);
    const run = this.store.get<Run>('run', plan.run.id);
    const connection = this.localConnection();
    if (
      this.closed ||
      !task ||
      task.runId !== plan.run.id ||
      !run ||
      hashCanonical(run.policy) !== hashCanonical(plan.run.policy) ||
      hashCanonical(run.source) !== hashCanonical(plan.run.source) ||
      hashCanonical(run.roles) !== hashCanonical(plan.run.roles) ||
      hashCanonical({ title: task.title, outcome: task.outcome, criteria: task.criteria }) !==
        hashCanonical(plan.context) ||
      !connection.connection ||
      !connection.facts.available ||
      hashCanonical(connection.facts) !== hashCanonical(plan.profile) ||
      hashCanonical(connection.connection.modelBinding) !== hashCanonical(plan.localModel) ||
      connection.connection.endpoint !== plan.endpoint ||
      hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(plan.run.source)
    )
      throw Error('Local writer authority changed.');
    this.consentRecord(plan.scopeHash);
    if (Date.parse(plan.expiresAt) <= Date.parse(this.now())) throw Error('Local consent expired.');
    if (active) {
      const attempt = this.store.get<Attempt>('attempt', plan.attempt.id);
      const intent = this.store.intents().find((value) => value.attempt_id === plan.attempt.id);
      const lease = this.store.db
        .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
        .get(task.id);
      if (
        task.state !== 'running' ||
        !attempt ||
        attempt.runId !== run.id ||
        attempt.routeId !== plan.attempt.routeId ||
        attempt.generation !== plan.attempt.generation ||
        !['intent', 'running'].includes(attempt.state) ||
        !intent ||
        intent.run_id !== run.id ||
        intent.task_id !== task.id ||
        intent.route_id !== plan.attempt.routeId ||
        intent.generation !== plan.attempt.generation ||
        intent.state === 'stopped' ||
        lease?.attempt_id !== attempt.id ||
        lease.generation !== attempt.generation ||
        this.jobDeadline(attempt.id, Math.min(5, plan.run.policy.policy.limits.minutes)) <= 5000
      )
        throw Error('Local writer ownership changed.');
    }
    return { task, run };
  }

  private startLocal(
    command: Extract<Command, { command: 'StartRun' }>,
    effects: (() => void)[],
  ): CommandResult {
    try {
      const plan = this.localPrepared(command.payload.runId);
      const { task, run } = this.localWriterAuthority(plan);
      if (
        task.id !== command.payload.taskId ||
        task.state !== 'draft' ||
        this.store.intents().some((intent) => intent.run_id === run.id)
      )
        return { outcome: 'blocked', reason: 'run-not-current' };
      const blocker = this.store.localStartBlocker();
      if (blocker) return { outcome: 'blocked', reason: blocker };
      const remaining = this.remaining(run);
      const timeoutMs = Math.floor(
        Math.min(
          300000,
          remaining.minutes * 60000,
          Date.parse(plan.expiresAt) - Date.parse(this.now()),
        ),
      );
      if (!remaining.attempts || !remaining.concurrency || timeoutMs <= 5000)
        return { outcome: 'blocked', reason: 'budget-exhausted' };
      const project = this.store.get<Project>('project', task.projectId) as Project;
      const grant = this.grant(run, 'write-scratch', project.name);
      if (!grant) return { outcome: 'blocked', reason: 'scratch-grant-unavailable' };
      const directory = join(this.home, 'scratch', run.id);
      this.admitJob(run, plan.attempt, directory, Math.ceil(timeoutMs / 60000));
      this.consumeGrant(run, grant);
      this.store.saveReceipt(`allocation:${run.id}`, plan.scopeHash, 'local-owner', {
        outcome: 'applied',
        entity: run,
      });
      const updated = this.updateTask(task, {
        state: 'running',
        waitingReason: null,
        next: 'The owned Local file turn is running.',
      });
      this.event('run.admitted', task.id, updated.revision, run);
      this.pendingLocalLaunches.add(plan.attempt.id);
      effects.push(() => {
        this.pendingLocalLaunches.delete(plan.attempt.id);
        if (this.closed) return;
        const intent = this.store.intents().find((value) => value.attempt_id === plan.attempt.id);
        if (!intent) throw Error('Local launch intent is unavailable.');
        if (intent.state === 'stopped') return;
        this.options.afterIntent?.(intent);
        this.launchLocalWriter(plan, timeoutMs);
      });
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    } catch {
      return { outcome: 'blocked', reason: 'local-start-unavailable' };
    }
  }

  private launchLocalWriter(plan: LocalPrepared, maximumMs: number) {
    const completion = Promise.withResolvers<void>();
    const binding = {
      ...plan.localModel,
      attemptId: plan.attempt.id,
      generation: plan.attempt.generation,
      profileHash: hashCanonical(plan.profile),
      sourceHash: plan.scopeHash,
      path: plan.target.path,
      baseHash: plan.target.baseHash,
    };
    const runtime: LocalWriterRuntime = { plan, binding, stopped: false, done: completion.promise };
    this.localWriters.set(plan.attempt.id, runtime);
    const current = () => {
      if (runtime.stopped) throw Error('Local writer stopped.');
      this.localWriterAuthority(plan, true);
    };
    const finish = async (
      outcome: Awaited<ReturnType<typeof startLocalReplacement>['result']> | null,
    ) => {
      try {
        const phases = this.store.nativeProcesses(plan.attempt.id);
        const terminal = outcome ? LocalTerminalSchema.parse(outcome.terminal) : null;
        const bound =
          terminal &&
          hashCanonical(terminal.binding) === hashCanonical(binding) &&
          (!('proof' in terminal) ||
            terminal.proof === null ||
            terminal.proof.maxTokens === plan.profile.maximumOutputTokens);
        const configurationFailed =
          bound && terminal && 'reason' in terminal && terminal.reason === 'configuration';
        const clientQuiescent =
          outcome?.clientQuiescent === true &&
          phases.length > 0 &&
          phases.every((phase) => phase.state === 'quiescent');
        const submitted = !!this.store.receipt(`native-submission:${plan.attempt.id}`);
        const unspawned = !runtime.handle && phases.length === 0;
        const terminalKnown =
          !!bound &&
          terminal.kind !== 'unknown' &&
          (terminal.kind === 'completed' ||
            terminal.kind === 'stopped' ||
            terminal.proof !== null ||
            !submitted);
        const known =
          unspawned ||
          (clientQuiescent &&
            terminalKnown &&
            this.store.nativePhasesComplete(plan.attempt.id, 'local'));
        const missingFinalAnswer =
          known &&
          clientQuiescent &&
          bound &&
          terminal.kind === 'failed' &&
          terminal.reason === 'protocol' &&
          (terminal.proof?.structured?.reasoningBytes ?? 0) > 0 &&
          terminal.proof?.structured?.nonReasoningBytes === 0;
        this.store.transaction(() => {
          const proof = this.nativeArtifact({
            attemptId: plan.attempt.id,
            bindingHash: hashCanonical(binding),
            terminal,
            clientQuiescent: clientQuiescent || unspawned,
            known,
            unspawned,
            at: this.now(),
          });
          this.store.saveReceipt(`local-terminal:${plan.attempt.id}`, proof.hash, 'local-owner', {
            outcome: known ? 'applied' : 'outcome-unknown',
            entity: proof,
          });
        });
        let applied = false;
        if (
          known &&
          bound &&
          terminal.kind === 'completed' &&
          submitted &&
          !runtime.stopped &&
          !this.closed
        ) {
          try {
            current();
            if (
              terminal.proposal.attemptId !== plan.attempt.id ||
              terminal.proposal.path !== plan.target.path ||
              terminal.proposal.baseHash !== plan.target.baseHash
            )
              throw Error('Local replacement changed.');
            this.store.transaction(() => {
              current();
              const proof = this.nativeArtifact({
                attemptId: plan.attempt.id,
                terminalHash: this.nativeRecord(`local-terminal:${plan.attempt.id}`).artifact.hash,
                manifest: plan.manifest,
              });
              this.store.saveReceipt(
                `native-application:${plan.attempt.id}`,
                proof.hash,
                'local-owner',
                { outcome: 'outcome-unknown', entity: proof },
              );
            });
            current();
            applyReplacement(
              join(this.home, 'scratch', plan.run.id),
              plan.manifest,
              terminal.proposal,
            );
            this.store.transaction(() => {
              const prior = this.store.receipt(`native-application:${plan.attempt.id}`);
              this.store.db
                .prepare('UPDATE receipts SET result=? WHERE command_key=?')
                .run(
                  canonicalJson({ outcome: 'applied', entity: prior?.result.entity }),
                  `native-application:${plan.attempt.id}`,
                );
            });
            applied = true;
          } catch {}
        }
        if (applied) await this.formatAttempt(plan.attempt);
        // Without terminal proof the outcome stays unknown. When every recorded group is gone
        // the writer holds nothing, so it settles as unknown and releases the lease.
        const intent = this.store.intents().find((value) => value.attempt_id === plan.attempt.id);
        const closed = known || !intent ? undefined : this.shutdownProof(intent);
        if (intent && closed) {
          this.store.transaction(() =>
            this.settleUnknownWriter(
              intent,
              closed,
              'Every recorded process group exited and Local recorded no matching terminal.',
              configurationFailed ? 'Local settings could not be verified. ' : '',
            ),
          );
          this.localWriters.delete(plan.attempt.id);
        } else if (
          this.settleJob(
            plan.attempt,
            known,
            true,
            () => {
              const task = this.store.get<Task>('task', plan.run.taskId) as Task;
              if (task.runId === plan.run.id)
                this.updateTask(task, {
                  state: 'stopped',
                  waitingReason: null,
                  next: applied
                    ? 'Local replacement retained. Prepare separate checks and review before acceptance.'
                    : configurationFailed
                      ? 'Local settings could not be verified. No replacement was applied.'
                      : missingFinalAnswer
                        ? 'Local returned no final answer. No replacement was applied. Check the model settings.'
                        : 'Local work stopped without an applied replacement.',
                });
            },
            configurationFailed
              ? 'Local settings could not be verified. Execution ownership is unknown. Checks and publication are blocked.'
              : undefined,
          )
        ) {
          if (applied) this.sealCandidate(plan.attempt);
          this.localWriters.delete(plan.attempt.id);
        }
      } catch {
        try {
          this.settleJob(plan.attempt, false, true);
        } catch {}
      } finally {
        completion.resolve();
      }
    };
    try {
      current();
      const sourceFiles = committedFiles(
        this.projectPath(plan.run.source.projectId) as string,
        plan.run.source.base,
      );
      if (
        hashCanonical(sourceFiles.map(({ content: _content, ...file }) => file)) !==
        hashCanonical(plan.manifest)
      )
        throw Error('Local source manifest changed.');
      const original = sourceFiles.find((file) => file.path === plan.target.path);
      if (!original || original.hash !== plan.target.baseHash) throw Error('Local target changed.');
      const directory = join(this.home, 'scratch', plan.run.id);
      materialize(directory, sourceFiles);
      const token =
        plan.localModel.authMode === 'none'
          ? null
          : Buffer.from(this.localSecret?.secret ?? Buffer.alloc(0));
      try {
        const input = this.localStartInput(
          plan,
          original.content.toString('utf8'),
          sourceFiles,
          token === null ? { authMode: 'none' } : { token: token.toString('utf8') },
          Math.floor(
            Math.min(
              maximumMs,
              this.jobDeadline(plan.attempt.id, Math.ceil(maximumMs / 60000)),
              Date.parse(plan.expiresAt) - Date.parse(this.now()),
            ),
          ),
        );
        const journal = this.nativeLifecycle(plan.attempt, current);
        const phase = { sequence: 0, kind: 'native-task' as const };
        runtime.handle = startLocalReplacement(input, directory, {
          ...this.options.localWriter,
          schedule: this.options.schedule,
          onSubmitted: () => {
            current();
            this.store.transaction(() => {
              current();
              const proof = this.nativeArtifact({
                attemptId: plan.attempt.id,
                bindingHash: hashCanonical(binding),
                scopeHash: plan.scopeHash,
              });
              this.store.saveReceipt(
                `native-submission:${plan.attempt.id}`,
                proof.hash,
                'local-owner',
                { outcome: 'outcome-unknown', entity: proof },
              );
            });
            return undefined;
          },
          lifecycle: {
            beforePhase: () => {
              journal.beforePhase(phase);
            },
            owned: (_kind, group) => {
              journal.owned(phase, group);
            },
            quiescent: (_kind, group) => {
              journal.quiescent(phase, group);
            },
          },
        });
      } finally {
        token?.fill(0);
      }
      if (runtime.stopped || this.closed) runtime.handle?.stop();
      void runtime.handle?.result.then(finish, () => finish(null));
    } catch {
      void finish(null);
    }
  }

  private prepareNative(
    command: Extract<Command, { command: 'PrepareNativeRun' }>,
    maximumMinutes?: number,
  ): CommandResult {
    if (command.payload.profileId === 'local-file-v1') return this.prepareLocal(command);
    if (command.payload.profileId === 'google-acp-v1')
      return this.prepareAcp(command, maximumMinutes);
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
      if (task?.state !== 'draft') return { outcome: 'blocked', reason: 'task-not-preparable' };
      const gate = this.draftEditGate(task);
      if (gate) return gate;
      const modelRequest =
        'modelRequest' in command.payload ? command.payload.modelRequest : undefined;
      const modelSelection =
        command.payload.profileId === 'openai-repository-v1'
          ? this.openAiProjectSelection(task.id, profile, modelRequest)
          : undefined;
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
        ...(modelRequest ? { modelRequest } : {}),
        ...(billingAttestation ? { billingAttestation: billingAttestation } : {}),
        ...(permissionMode ? { permissionMode: permissionMode } : {}),
        ...(manualTargets ? { manualTargets } : {}),
      });
      if (command.payload.consent === 'saved')
        expiresAt = new Date(
          Math.min(Date.parse(expiresAt), Date.parse(this.consentRecord(scopeHash).expiresAt)),
        ).toISOString();
      const savedRoute = this.nativeProfileRoute(
        profile,
        command.payload.creditPolicy,
        modelRequest,
        modelRequest ? modelSelection : undefined,
      );
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
              model: modelSelection?.model ?? facts.model,
              effort: {
                requested: modelSelection?.effort ?? facts.effort,
                effective:
                  facts.family === 'openai' ? (modelSelection?.effort ?? facts.effort) : 'unknown',
                supported: [modelSelection?.effort ?? facts.effort],
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
          ...(modelRequest ? { modelRequest } : {}),
          consent: {
            nativeTrust: 'accepted',
            source: command.payload.consent === 'explicit' ? 'explicit' : 'policy',
            policyHash: hashCanonical(policy),
            sourceBase: source.base,
            criteriaHash: hashCanonical(task.criteria),
          },
          policy,
          expiresAt,
          // A repository writer leaves the eleven minutes a verify check and review need, and
          // never drops below five. Start requires those eleven minutes behind a writer longer than
          // five minutes and lets a five-minute writer start with its own five. File profiles
          // stop at five minutes.
          maximumTaskMs: Math.min(
            facts.maximumTaskMs,
            (maximumMinutes ?? Math.max(5, policy.limits.minutes - evaluationFloorMinutes)) * 60000,
          ),
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

  private combinedEvaluationPlan(artifact: Artifact) {
    const stored = this.store.get<Artifact>('artifact', artifact.id);
    if (
      !stored ||
      hashCanonical(stored) !== hashCanonical(artifact) ||
      artifact.bytes > MAX_FRAME_BYTES ||
      this.store.receipt(`evaluation-plan:${artifact.id}`)?.hash !== artifact.hash
    )
      throw Error('Combined evaluation preparation changed.');
    return CombinedEvaluationSchema.parse(
      JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
    );
  }

  private combinedEvaluationAuthority(artifact: Artifact, ownedAttemptId?: string) {
    const plan = this.combinedEvaluationPlan(artifact);
    const group = this.store.combinedGroup(plan.run.id);
    if (!group || group.run_id !== plan.run.id) throw Error('Combined parent missing.');
    const { manifest, task } = this.combinedCurrent(
      group,
      !!ownedAttemptId &&
        group.phase === 'paused' &&
        this.store
          .combinedDispatches(group.run_id)
          .some((slot) => slot.attempt_id === ownedAttemptId && slot.state === 'running'),
    );
    const candidate = CandidateSchema.parse(
      this.store.get<Candidate>('candidate', plan.candidate.id),
    );
    const origin = this.combinedOrigin(group, candidate);
    const profile = this.profileFor(manifest.input.reviewer.profileId);
    const { scopeHash: _scopeHash, expiresAt: _expiresAt, ...fields } = plan;
    const consent = EvaluationConsentSchema.parse(
      this.nativeRecord(`evaluation-consent:${plan.scopeHash}`, 4096).value,
    );
    if (
      consent.scopeHash !== plan.scopeHash ||
      Date.parse(consent.expiresAt) <= Date.parse(this.now())
    )
      throw Error('Combined evaluation consent changed.');
    if (
      hashCanonical(fields) !== plan.scopeHash ||
      hashCanonical(plan.run.policy) !== hashCanonical(manifest.run.policy) ||
      hashCanonical(plan.origin) !== hashCanonical(origin) ||
      hashCanonical(plan.context) !==
        hashCanonical({ title: task.title, outcome: task.outcome, criteria: task.criteria }) ||
      hashCanonical(plan.definition) !==
        hashCanonical(
          this.combinedDefinition(group, 'final-check', candidate, hashCanonical(origin)),
        ) ||
      hashCanonical(plan.reviewer.profile) !== hashCanonical(profile.facts) ||
      hashCanonical(plan.reviewer.client) !== hashCanonical(profile.client) ||
      plan.reviewer.locationHash !== profile.locationHash ||
      !profile.facts.available ||
      !profile.environment ||
      Date.parse(plan.expiresAt) <= Date.parse(this.now()) ||
      this.store
        .intents()
        .some(
          (intent) =>
            [
              group.run_id,
              ...this.store.combinedMembers(group.run_id).map((member) => member.run_id),
            ].includes(intent.run_id) &&
            intent.state !== 'stopped' &&
            intent.attempt_id !== ownedAttemptId,
        )
    )
      throw Error('Combined evaluation authority changed.');
    for (const grant of plan.grants)
      if (
        grant.taskId !== task.id ||
        grant.revoked ||
        grant.usesRemaining !== 1 ||
        Date.parse(grant.expiresAt) <= Date.parse(this.now())
      )
        throw Error('Combined grants changed.');
    return { plan, group, manifest, task, candidate, origin, environment: profile.environment };
  }

  private prepareCombinedEvaluation(
    command: Extract<Command, { command: 'PrepareCandidateEvaluation' }>,
    group: CombinedGroup,
  ): CommandResult {
    const { manifest, task } = this.combinedCurrent(group);
    if (
      group.phase !== 'awaiting-evaluation' ||
      this.store.receipt(`evaluation-started:${group.run_id}`)
    )
      return { outcome: 'blocked', reason: 'combined-evaluation-unavailable' };
    const candidate = CandidateSchema.parse(
      this.store.get<Candidate>('candidate', command.payload.candidateId),
    );
    const origin = this.combinedOrigin(group, candidate);
    const selected = command.payload.reviewer;
    const frozen = manifest.input.reviewer;
    if (
      command.payload.checkRecipeId !== 'project-node-tests-v1' ||
      hashCanonical(command.payload.testFiles) !== hashCanonical(manifest.input.checks.testFiles) ||
      selected.profileId !== frozen.profileId ||
      selected.methodId !== 'keep-it-simple' ||
      selected.cycles !== 1 ||
      command.payload.creditPolicy !== frozen.creditPolicy
    )
      return { outcome: 'blocked', reason: 'combined-frozen-evaluation-required' };
    const grants = command.payload.grants;
    const expected = [
      { action: 'run-check', target: 'node --test' },
      {
        action: 'run-review',
        target: formatReviewTarget({ methodId: 'keep-it-simple', cycle: 1 }),
      },
    ];
    if (
      grants.some(
        (grant) =>
          grant.taskId !== task.id ||
          grant.revoked ||
          grant.usesRemaining !== 1 ||
          Date.parse(grant.expiresAt) <= Date.parse(this.now()) ||
          this.store.receipt(this.grantKey(grant)),
      ) ||
      expected.some(
        (value) =>
          grants.filter((grant) => grant.action === value.action && grant.target === value.target)
            .length !== 1,
      )
    )
      return { outcome: 'blocked', reason: 'combined-exact-evaluation-grants-required' };
    const profile = this.profileFor(frozen.profileId);
    if (
      !profile.facts.available ||
      !profile.client ||
      !profile.locationHash ||
      !profile.environment ||
      hashCanonical(profile.facts) !== hashCanonical(manifest.reviewer.profile) ||
      hashCanonical(profile.client) !== hashCanonical(manifest.reviewer.client) ||
      profile.locationHash !== manifest.reviewer.locationHash
    )
      return { outcome: 'blocked', reason: 'combined-reviewer-changed' };
    const fields = {
      run: manifest.run,
      candidate,
      origin,
      context: { title: task.title, outcome: task.outcome, criteria: task.criteria },
      definition: this.combinedDefinition(group, 'final-check', candidate, hashCanonical(origin)),
      reviewer: {
        ...selected,
        role: 'reviewer' as const,
        profile: profile.facts,
        client: profile.client,
        locationHash: profile.locationHash,
      },
      creditPolicy: frozen.creditPolicy,
      grants,
      remaining: this.remaining(manifest.run),
      maximumCheckMinutes: 1 as const,
    };
    const scopeHash = hashCanonical(fields);
    let expiresAt = Math.min(...grants.map((grant) => Date.parse(grant.expiresAt)));
    const saved = this.store.receipt(`evaluation-consent:${scopeHash}`);
    if (saved)
      expiresAt = Math.min(
        expiresAt,
        Date.parse(
          EvaluationConsentSchema.parse(
            this.nativeRecord(`evaluation-consent:${scopeHash}`, 4096).value,
          ).expiresAt,
        ),
      );
    else if (command.payload.consent !== 'explicit')
      return { outcome: 'blocked', reason: 'combined-consent-required' };
    if (expiresAt <= Date.parse(this.now()))
      return { outcome: 'blocked', reason: 'combined-consent-expired' };
    const plan = CombinedEvaluationSchema.parse({
      ...fields,
      scopeHash,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    if (Buffer.byteLength(canonicalJson(plan)) > MAX_FRAME_BYTES)
      throw Error('Combined evaluation exceeds its bound.');
    const artifact = this.nativeArtifact(plan);
    for (const key of [`evaluation-plan:${artifact.id}`, `evaluation-ready:${group.run_id}`])
      this.store.saveReceipt(key, artifact.hash, 'local-owner', {
        outcome: 'applied',
        entity: artifact,
      });
    if (!saved) {
      const consent = this.nativeArtifact({ scopeHash, expiresAt: plan.expiresAt });
      this.store.saveReceipt(`evaluation-consent:${scopeHash}`, scopeHash, 'local-owner', {
        outcome: 'applied',
        entity: consent,
      });
    }
    const updated = this.updateTask(task, {
      next: 'Start the frozen full combined checks. Review remains a separate action.',
    });
    return { outcome: 'applied', entity: artifact, revision: updated.revision };
  }

  private startCombinedEvaluation(
    command: Extract<Command, { command: 'StartCandidateEvaluation' }>,
    effects: (() => void)[],
    group: CombinedGroup,
  ): CommandResult {
    const artifact = ArtifactSchema.parse(
      this.store.get<Artifact>('artifact', command.payload.preparationId),
    );
    const { plan, task, candidate } = this.combinedEvaluationAuthority(artifact);
    if (
      group.phase !== 'awaiting-evaluation' ||
      plan.run.taskId !== command.payload.taskId ||
      candidate.id !== command.payload.candidateId ||
      this.store.receipt(`evaluation-started:${group.run_id}`) ||
      plan.grants.some((grant) => this.store.receipt(this.grantKey(grant)))
    )
      return { outcome: 'blocked', reason: 'combined-evaluation-unavailable' };
    const passed = this.combinedCheck(
      group,
      'final-check',
      candidate,
      effects,
      hashCanonical(plan.origin),
    );
    const slot = this.store
      .combinedDispatches(group.run_id)
      .find((slot) => slot.phase === 'final-check') as CombinedDispatch;
    this.store.saveReceipt(`evaluation-started:${group.run_id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    this.store.saveReceipt(`evaluation-check:${slot.attempt_id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    this.consumeGrant(plan.run, plan.grants.find((grant) => grant.action === 'run-check') as Grant);
    this.updateCombined(group, 'checking');
    const updated = this.updateTask(task, {
      state: 'checking',
      waitingReason: null,
      next: 'Running the full combined collection and interaction checks.',
    });
    effects.push(() => {
      void passed
        .then((pass) => {
          if (!pass || this.closed) return;
          this.store.transaction(() => {
            const current = this.combinedCurrent(group).group;
            if (current.phase !== 'checking') return;
            const verified = this.combinedChecked(
              group,
              'final-check',
              candidate,
              hashCanonical(plan.origin),
            );
            const check = ArtifactSchema.parse(
              this.store.get<Artifact>('artifact', verified.check.artifactId),
            );
            this.store.saveReceipt(
              `evaluation-result:${artifact.id}`,
              artifact.hash,
              'local-owner',
              { outcome: 'applied', entity: check },
            );
            this.updateCombined(group, 'awaiting-review');
            this.updateTask(this.store.get<Task>('task', group.task_id) as Task, {
              state: 'stopped',
              waitingReason: null,
              next: 'Full checks passed. Start the independent combined review.',
            });
          });
        })
        .catch(() => {});
    });
    return { outcome: 'applied', entity: artifact, revision: updated.revision };
  }

  private combinedReviewAuthority(artifact: Artifact, ownedAttemptId?: string) {
    const prepared = this.combinedEvaluationAuthority(artifact, ownedAttemptId);
    const { plan, group } = prepared;
    if (
      !['awaiting-review', 'reviewing'].includes(group.phase) &&
      !(ownedAttemptId && group.phase === 'paused' && group.paused_phase === 'reviewing')
    )
      throw Error('Full combined checks are required.');
    const proof = this.combinedChecked(
      group,
      'final-check',
      plan.candidate,
      hashCanonical(plan.origin),
    );
    const checkArtifact = ArtifactSchema.parse(
      this.store.get<Artifact>('artifact', proof.check.artifactId),
    );
    const grant = plan.grants.find((grant) => grant.action === 'run-review') as Grant;
    const consumed = this.store.receipt(this.grantKey(grant));
    if (
      (!ownedAttemptId && consumed) ||
      (ownedAttemptId && consumed?.hash !== hashCanonical(grant))
    )
      throw Error('The combined review grant changed.');
    return { ...prepared, checkArtifact, grant };
  }

  private startCombinedReview(
    command: Extract<Command, { command: 'StartCandidateReview' }>,
    effects: (() => void)[],
    group: CombinedGroup,
  ): CommandResult {
    const artifact = ArtifactSchema.parse(
      this.store.get<Artifact>('artifact', command.payload.preparationId),
    );
    const prepared = this.combinedReviewAuthority(artifact);
    const { plan, manifest, candidate, task } = prepared;
    if (
      group.phase !== 'awaiting-review' ||
      plan.run.taskId !== command.payload.taskId ||
      candidate.id !== command.payload.candidateId ||
      this.store.receipt(`native-review-started:${group.run_id}`)
    )
      return { outcome: 'blocked', reason: 'combined-review-unavailable' };
    const slot = this.store
      .combinedDispatches(group.run_id)
      .find((slot) => slot.phase === 'review') as CombinedDispatch;
    const route = manifest.reviewer.route;
    const prototype = NativeHistoricalPreparationSchema.parse(
      this.nativeRecord(`native-run:${manifest.members[0].run.id}`).value,
    ).appointment;
    const decision = this.nativeDecision(
      {
        ...prototype,
        route,
        creditPolicy: plan.creditPolicy,
        maximumTaskMs: slot.maximum_minutes * 60000,
        expiresAt: plan.expiresAt,
      },
      plan.run,
      true,
    );
    if (!decision.chosen || decision.chosen !== route.id)
      return { outcome: 'blocked', reason: 'combined-review-allowance-unavailable' };
    const attempt = this.jobAttempt(plan.run, route.id);
    const job = CombinedNativeReviewJobSchema.parse({
      taskId: group.task_id,
      runId: group.run_id,
      attemptId: attempt.id,
      generation: attempt.generation,
      routeId: route.id,
      candidateId: candidate.id,
      candidateHash: candidate.hash,
      methodId: 'keep-it-simple',
      cycle: 1,
      limitMinutes: slot.maximum_minutes,
      scripted: false,
      preparationId: artifact.id,
      profileId: 'openai-file-v1',
      assignedRole: 'reviewer',
      independence: 'process-only',
      origin: plan.origin,
    });
    const source = committedFiles(this.projectPath(task.projectId) as string, plan.run.source.base);
    const files = this.evidence.read(candidate).files;
    const paths = [
      ...new Set([...source.map((file) => file.path), ...files.map((file) => file.path)]),
    ].sort();
    const encode = (file: FileContent | undefined) =>
      file
        ? {
            mode: file.mode,
            hash: file.hash,
            content: new TextDecoder('utf-8', { fatal: true }).decode(file.content),
          }
        : null;
    const input = reviewPlan({
      binding: { ...job, scopeHash: plan.scopeHash },
      directory: join(this.home, 'native-review', attempt.id),
      model: route.model as ReviewPlan['model'],
      effort: route.effort.requested as ReviewPlan['effort'],
      creditPolicy: plan.creditPolicy,
      repository: {
        version: 1,
        sourceBase: plan.run.source.base,
        sourceManifestHash: plan.origin.sourceManifestHash,
        candidateManifestHash: candidate.hash,
        changes: paths.flatMap((path) => {
          const original = source.find((file) => file.path === path),
            current = files.find((file) => file.path === path);
          return original?.hash === current?.hash && original?.mode === current?.mode
            ? []
            : [{ path, original: encode(original), candidate: encode(current) }];
        }),
      },
      context: plan.context,
    });
    const minutes = this.admitJob(
      plan.run,
      attempt,
      input.directory,
      slot.maximum_minutes,
      'review',
    );
    const identity = this.nativeReviewIdentity(plan, job, prepared.checkArtifact);
    const record = this.nativeArtifact({
      preparation: artifact,
      job,
      input,
      check: prepared.checkArtifact,
      identity,
    });
    this.store.saveReceipt(`native-review-started:${group.run_id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: record,
    });
    this.store.saveReceipt(`native-review-input:${attempt.id}`, record.hash, 'local-owner', {
      outcome: 'applied',
      entity: record,
    });
    this.store.db
      .prepare('INSERT INTO review_jobs(attempt_id,candidate_id,body) VALUES (?,?,?)')
      .run(attempt.id, candidate.id, canonicalJson(job));
    this.consumeGrant(plan.run, prepared.grant);
    this.updateCombined(group, 'reviewing');
    const updated = this.updateTask(task, {
      state: 'checking',
      waitingReason: null,
      next: 'Reviewing the complete combined diff in a fresh process.',
    });
    effects.push(() =>
      this.launchCandidateReview(
        artifact,
        freezeNative(job),
        freezeNative(input),
        attempt,
        minutes,
        prepared.environment,
        identity,
      ),
    );
    return { outcome: 'applied', entity: record, revision: updated.revision };
  }

  private combinedPublicationEvidence(group: CombinedGroup, candidate: Candidate, paused = false) {
    const key = `combined-publication:${group.run_id}:${candidate.id}:${candidate.hash}`;
    const cached = this.projectionCache?.get(key) as
      | {
          origin: CombinedOrigin;
          plan: z.infer<typeof CombinedEvaluationSchema>;
          attempt: Attempt;
          review: CheckResult;
        }
      | undefined;
    if (cached) return cached;
    const origin = this.combinedOrigin(group, candidate);
    const manifest = this.combinedManifest(group);
    const artifact = ArtifactSchema.parse(
      this.store.receipt(`evaluation-started:${group.run_id}`)?.result.entity,
    );
    const plan = this.combinedEvaluationPlan(artifact);
    const proof = this.combinedChecked(group, 'final-check', candidate, hashCanonical(origin));
    const slot = this.store
      .combinedDispatches(group.run_id)
      .find((slot) => slot.phase === 'review') as CombinedDispatch;
    const attempt = AttemptSchema.parse(
      this.store.get<Attempt>('attempt', slot.attempt_id as string),
    );
    const saved = z
      .strictObject({
        preparation: ArtifactSchema,
        job: CombinedNativeReviewJobSchema,
        input: z.unknown(),
        check: ArtifactSchema,
        identity: z.strictObject({ evaluator: z.string(), definitionHash: HashSchema }),
      })
      .parse(this.nativeRecord(`native-review-started:${group.run_id}`).value);
    const job = saved.job;
    const input = reviewPlan(saved.input as Parameters<typeof reviewPlan>[0]);
    const identity = this.nativeReviewIdentity(plan, job, saved.check);
    const submission = z
      .strictObject({
        attemptId: AttemptSchema.shape.id,
        preparationHash: HashSchema,
        bindingHash: HashSchema,
      })
      .parse(
        this.nativeRecord(`native-review-submission:${attempt.id}`, 4096, 'outcome-unknown').value,
      );
    const completed = z
      .object({ attemptId: AttemptSchema.shape.id, reason: z.null(), quiescent: z.literal(true) })
      .parse(this.nativeRecord(`native-review-completion:${attempt.id}`, 4096).value);
    const result = z
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
    const stored = this.store.db
      .prepare('SELECT body FROM review_jobs WHERE attempt_id=?')
      .get(attempt.id);
    const grant = plan.grants.find((grant) => grant.action === 'run-review') as Grant;
    const checkGrant = plan.grants.find((grant) => grant.action === 'run-check') as Grant;
    const reviews = this.store.db
      .prepare("SELECT body FROM evidence WHERE candidate_id=? AND kind='review'")
      .all(candidate.id)
      .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)));
    const review = reviews.find(
      (review) =>
        review.passed &&
        review.review?.outcome === 'passed' &&
        hashCanonical(review.review.job) === hashCanonical(job) &&
        review.definitionHash === identity.definitionHash &&
        review.evaluator === identity.evaluator,
    );
    const { scopeHash: _scopeHash, expiresAt: _expiresAt, ...fields } = plan;
    if (
      hashCanonical(fields) !== plan.scopeHash ||
      hashCanonical(plan.run) !== hashCanonical(manifest.run) ||
      hashCanonical(plan.context) !==
        hashCanonical({
          title: manifest.task.title,
          outcome: manifest.task.outcome,
          criteria: manifest.task.criteria,
        }) ||
      hashCanonical(plan.definition) !== hashCanonical(proof.definition) ||
      hashCanonical(plan.reviewer.profile) !== hashCanonical(manifest.reviewer.profile) ||
      hashCanonical(plan.reviewer.client) !== hashCanonical(manifest.reviewer.client) ||
      plan.reviewer.locationHash !== manifest.reviewer.locationHash ||
      plan.creditPolicy !== manifest.input.reviewer.creditPolicy ||
      job.preparationId !== artifact.id ||
      job.attemptId !== attempt.id ||
      job.routeId !== manifest.reviewer.route.id ||
      job.limitMinutes !== slot.maximum_minutes ||
      hashCanonical(saved.preparation) !== hashCanonical(artifact) ||
      this.store.receipt(`native-review-started:${group.run_id}`)?.hash !== artifact.hash ||
      this.store.receipt(`native-review-submission:${attempt.id}`)?.hash !== artifact.hash ||
      this.store.receipt(`evaluation-result:${artifact.id}`)?.hash !== artifact.hash ||
      hashCanonical(this.store.receipt(`evaluation-result:${artifact.id}`)?.result.entity) !==
        hashCanonical(saved.check) ||
      grant.action !== 'run-review' ||
      grant.taskId !== group.task_id ||
      grant.target !== formatReviewTarget({ methodId: 'keep-it-simple', cycle: 1 }) ||
      checkGrant.taskId !== group.task_id ||
      checkGrant.target !== 'node --test'
    )
      throw Error('Combined final preparation changed.');
    if (
      !review ||
      (!['reviewing', 'ready', 'accepted'].includes(group.phase) &&
        !(
          paused &&
          group.phase === 'paused' &&
          ['reviewing', 'ready'].includes(group.paused_phase ?? '')
        )) ||
      this.store.receipt(this.grantKey(checkGrant))?.hash !== hashCanonical(checkGrant) ||
      !stored ||
      slot.state !== 'passed' ||
      attempt.state !== 'stopped' ||
      attempt.runId !== group.run_id ||
      attempt.routeId !== job.routeId ||
      attempt.generation !== job.generation ||
      !this.store.nativePhasesComplete(attempt.id, 'openai') ||
      this.store.intents().find((intent) => intent.attempt_id === attempt.id)?.state !==
        'stopped' ||
      completed.attemptId !== attempt.id ||
      submission.attemptId !== attempt.id ||
      submission.preparationHash !== artifact.hash ||
      submission.bindingHash !== hashCanonical(input.binding) ||
      saved.preparation.hash !== artifact.hash ||
      saved.check.id !== proof.check.artifactId ||
      hashCanonical(saved.identity) !== hashCanonical(identity) ||
      hashCanonical(plan.origin) !== hashCanonical(origin) ||
      hashCanonical(job.origin) !== hashCanonical(origin) ||
      hashCanonical(JSON.parse(stored.body as string)) !== hashCanonical(job) ||
      hashCanonical(input.binding) !== hashCanonical({ ...job, scopeHash: plan.scopeHash }) ||
      hashCanonical(input.context) !== hashCanonical(plan.context) ||
      input.model !== plan.reviewer.profile.model ||
      plan.reviewer.profile.family !== 'openai' ||
      input.effort !== plan.reviewer.profile.effort ||
      result.model !== input.model ||
      result.requestedEffort !== input.effort ||
      hashCanonical(result.review) !==
        hashCanonical({
          version: 1,
          bindingHash: hashCanonical(input.binding),
          methodId: job.methodId,
          cycle: job.cycle,
          outcome: review.review?.outcome,
          findings: review.review?.findings,
          summary: review.review?.summary,
        }) ||
      this.store.receipt(this.grantKey(grant))?.hash !== hashCanonical(grant)
    )
      throw Error('Combined final evidence is incomplete.');
    const resultArtifact = ArtifactSchema.parse(
      this.store.get<Artifact>('artifact', review.artifactId),
    );
    const startedArtifact = ArtifactSchema.parse(
      this.store.receipt(`native-review-started:${group.run_id}`)?.result.entity,
    );
    if (
      review.candidateId !== candidate.id ||
      review.candidateHash !== candidate.hash ||
      resultArtifact.bytes > MAX_FRAME_BYTES ||
      hashCanonical(JSON.parse(this.artifacts.read(resultArtifact.hash).toString('utf8'))) !==
        hashCanonical(review.review) ||
      this.store.receipt(`native-review-input:${attempt.id}`)?.hash !== startedArtifact.hash ||
      this.store.receipt(`native-review-input:${attempt.id}`)?.result.outcome !== 'applied'
    )
      throw Error('Combined retained review changed.');
    const barrier = { origin, plan, attempt, review };
    this.projectionCache?.set(key, barrier);
    return barrier;
  }

  private evaluationPreparation(run: Run, candidate: Candidate): EvaluationWriterPreparation {
    const origin = this.nativeRecord(this.currentNativePlanKey(run.id));
    const local = LocalPreparedSchema.safeParse(origin.value);
    if (local.success) {
      this.localWriterEvidence(local.data, candidate);
      return local.data;
    }
    const plan = NativeHistoricalPreparationSchema.parse(origin.value);
    this.nativeManualHistory(plan);
    this.anthropicWriterEvidence(plan);
    this.googleWriterEvidence(plan);
    this.nativeRepositoryEvidence(plan, candidate);
    this.nativeAcpEvidence(plan, candidate);
    return plan;
  }

  private localWriterEvidence(plan: LocalPrepared, candidate: Candidate) {
    const same = (left: unknown, right: unknown) => hashCanonical(left) === hashCanonical(right);
    const origin = this.nativeRecord(`local-prepared:${plan.run.id}`);
    const retained = this.nativeRecord(`native-run:${plan.run.id}`);
    const binding = LocalBindingSchema.parse({
      ...plan.localModel,
      attemptId: plan.attempt.id,
      generation: plan.attempt.generation,
      profileHash: hashCanonical(plan.profile),
      sourceHash: plan.scopeHash,
      path: plan.target.path,
      baseHash: plan.target.baseHash,
    });
    const terminal = this.nativeRecord(`local-terminal:${plan.attempt.id}`);
    const proof = z
      .strictObject({
        attemptId: AttemptSchema.shape.id,
        bindingHash: HashSchema,
        terminal: LocalTerminalSchema,
        clientQuiescent: z.literal(true),
        known: z.literal(true),
        unspawned: z.literal(false),
        at: TimestampSchema,
      })
      .parse(terminal.value);
    const submission = z
      .strictObject({
        attemptId: AttemptSchema.shape.id,
        bindingHash: HashSchema,
        scopeHash: HashSchema,
      })
      .parse(
        this.nativeRecord(`native-submission:${plan.attempt.id}`, 4096, 'outcome-unknown').value,
      );
    const application = z
      .strictObject({
        attemptId: AttemptSchema.shape.id,
        terminalHash: HashSchema,
        manifest: LocalPreparedSchema.shape.manifest,
      })
      .parse(this.nativeRecord(`native-application:${plan.attempt.id}`).value);
    const route = this.store.get<Route>('route', plan.attempt.routeId);
    const expectedScope = hashCanonical({
      profile: plan.profile,
      endpoint: plan.endpoint,
      localModel: plan.localModel,
      source: plan.run.source,
      manifest: plan.manifest,
      target: plan.target,
      context: plan.context,
      policy: plan.run.policy.policy,
    });
    if (
      !same(origin.value, plan) ||
      retained.artifact.hash !== origin.artifact.hash ||
      this.store.receipt(`native-run:${plan.run.id}`)?.hash !== retained.artifact.hash ||
      this.store.receipt(`local-prepared:${plan.run.id}`)?.hash !== origin.artifact.hash ||
      plan.scopeHash !== expectedScope ||
      plan.run.decision.inputsHash !== expectedScope ||
      plan.run.decision.chosen !== plan.attempt.routeId ||
      plan.attempt.runId !== plan.run.id ||
      candidate.taskId !== plan.run.taskId ||
      plan.profile.id !== 'local-file-v1' ||
      plan.profile.family !== 'local' ||
      !('modelBinding' in plan.profile) ||
      !same(plan.profile.modelBinding, plan.localModel) ||
      plan.localModel.connectionHash !==
        localConfiguredConnectionHash(
          plan.endpoint,
          plan.localModel.connectionRevision,
          plan.localModel.authMode,
        ) ||
      !route ||
      route.fake ||
      route.family !== 'local' ||
      route.billing !== 'local' ||
      route.model !== plan.localModel.modelKey ||
      proof.attemptId !== plan.attempt.id ||
      proof.bindingHash !== hashCanonical(binding) ||
      proof.terminal.kind !== 'completed' ||
      !same(proof.terminal.binding, binding) ||
      proof.terminal.proof.stopReason !== 'eosFound' ||
      proof.terminal.proof.maxTokens !== plan.profile.maximumOutputTokens ||
      proof.terminal.proposal.attemptId !== plan.attempt.id ||
      proof.terminal.proposal.path !== plan.target.path ||
      proof.terminal.proposal.baseHash !== plan.target.baseHash ||
      submission.attemptId !== plan.attempt.id ||
      submission.bindingHash !== proof.bindingHash ||
      submission.scopeHash !== plan.scopeHash ||
      application.attemptId !== plan.attempt.id ||
      application.terminalHash !== terminal.artifact.hash ||
      !same(application.manifest, plan.manifest) ||
      !this.store.nativePhasesComplete(plan.attempt.id, 'local') ||
      this.store.nativeProcesses(plan.attempt.id).some((phase) => phase.state !== 'quiescent') ||
      this.store.db
        .prepare('SELECT attempt_id FROM writer_leases WHERE attempt_id=?')
        .get(plan.attempt.id) ||
      this.store.db
        .prepare('SELECT attempt_id FROM reservations WHERE attempt_id=?')
        .get(plan.attempt.id)
    )
      throw Error('Local writer evidence is incomplete.');
    const source = committedFiles(
      this.projectPath(plan.run.source.projectId) as string,
      plan.run.source.base,
    );
    if (
      !same(
        source.map(({ content: _content, ...file }) => file),
        plan.manifest,
      )
    )
      throw Error('Local source manifest changed.');
    const target = this.evidence
      .read(candidate)
      .files.find((file) => file.path === plan.target.path);
    if (
      !target ||
      !this.writerBytes(
        plan.attempt.id,
        target.path,
        createHash('sha256').update(proof.terminal.proposal.content).digest('hex'),
        target.hash,
      )
    )
      throw Error('Local candidate does not match its completed replacement.');
    this.nativeReviewSource(plan, candidate);
    const grant = plan.run.policy.policy.effects.find(
      (value) =>
        value.action === 'write-scratch' &&
        value.taskId === plan.run.taskId &&
        value.target === this.store.get<Project>('project', plan.run.source.projectId)?.name &&
        !value.revoked &&
        value.usesRemaining === 1,
    );
    const consumed = grant && this.store.receipt(this.grantKey(grant));
    if (
      !grant ||
      consumed?.hash !== hashCanonical(grant) ||
      (consumed.result.entity as Run | undefined)?.id !== plan.run.id ||
      this.store.receipt(`allocation:${plan.run.id}`)?.hash !== plan.scopeHash
    )
      throw Error('Local writer admission evidence changed.');
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
    const plan = this.evaluationPreparation(run, candidate);
    const writer = this.store.get<Attempt>('attempt', plan.attempt.id);
    const local = 'kind' in plan;
    const repositoryRecovery =
      !local &&
      'repository' in plan.appointment &&
      !!this.store.receipt(`native-recovery:${plan.attempt.id}`);
    const completion = local
      ? null
      : this.nativeRecord(`native-completion:${plan.attempt.id}`, 4096).value;
    const completed =
      local ||
      z
        .object({
          attemptId: z.string(),
          reason: repositoryRecovery ? z.string().min(1) : z.null(),
          quiescent: z.literal(true),
        })
        .parse(completion).attemptId === plan.attempt.id;
    if (
      !writer ||
      !this.attestedReviewWriter(run, candidate, writer) ||
      !completed ||
      !this.store.nativePhasesComplete(
        writer.id,
        local ? 'local' : plan.appointment.route.family,
      ) ||
      this.store.receipt(
        `${!local && 'acp' in plan.appointment ? 'native-acp-capture' : !local && 'repository' in plan.appointment && repositoryRecovery ? 'native-recovery' : !local && 'repository' in plan.appointment ? 'native-capture' : 'native-application'}:${writer.id}`,
      )?.result.outcome !== 'applied' ||
      plan.run.id !== run.id ||
      plan.run.taskId !== run.taskId ||
      hashCanonical(plan.run.policy) !== hashCanonical(run.policy) ||
      hashCanonical(plan.run.source) !== hashCanonical(run.source) ||
      hashCanonical(plan.run.roles) !== hashCanonical(run.roles) ||
      (local
        ? hashCanonical(plan.context) !==
          hashCanonical({ title: task.title, outcome: task.outcome, criteria: task.criteria })
        : plan.appointment.consent.criteriaHash !== hashCanonical(task.criteria)) ||
      (!local &&
        plan.public &&
        (plan.public.context.title !== task.title ||
          plan.public.context.outcome !== task.outcome)) ||
      hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(run.source) ||
      !this.candidateCurrent(run, candidate)
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
      remaining.minutes < (command.payload.checkRecipeId === 'crewkite-verify-v1' ? 11 : 2) ||
      remaining.concurrency < 1
    )
      throw Error('The saved budget cannot cover one check and one review.');
    const expected = [
      command.payload.checkRecipeId === 'crewkite-verify-v1'
        ? verificationTarget
        : command.payload.checkRecipeId === 'project-python-unittest-v1'
          ? 'python -m unittest'
          : 'node --test',
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
    const group = this.store.combinedGroup(command.payload.taskId);
    if (group?.task_id === command.payload.taskId)
      return this.prepareCombinedEvaluation(command, group);
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
                command.payload.checkRecipeId === 'project-node-tests-v1' ||
                command.payload.checkRecipeId === 'project-python-unittest-v1'
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
          command.payload.checkRecipeId === 'crewkite-verify-v1' ? (10 as const) : (1 as const),
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
      if (review) this.candidateReviewAuthority(artifact);
      else this.evaluationAuthority(artifact);
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
            kind: 'candidate-review',
            route,
            maximumTaskMs: Math.min(300000, remaining.minutes * 60000),
            expiresAt: plan.expiresAt,
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

  private combinedEvaluationPreview(
    group: CombinedGroup,
    artifact: Artifact,
  ): CandidateEvaluationPreview {
    const plan = this.combinedEvaluationPlan(artifact);
    const manifest = this.combinedManifest(group);
    const slots = this.store.combinedDispatches(group.run_id);
    const check = this.checks(plan.candidate).find(
      (check) => check.artifactId === slots[5].check_artifact_id,
    );
    const review = this.store.db
      .prepare("SELECT body FROM evidence WHERE candidate_id=? AND kind='review'")
      .all(plan.candidate.id)
      .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)))
      .find((review) => review.review?.job.attemptId === slots[6].attempt_id);
    const availability = (reviewing: boolean): CandidateEvaluationPreview['checkStart'] => {
      try {
        if (
          this.store.receipt(
            `${reviewing ? 'native-review-started' : 'evaluation-started'}:${group.run_id}`,
          )
        )
          return { available: false, reason: 'already-started' };
        if (reviewing) this.combinedReviewAuthority(artifact);
        else this.combinedEvaluationAuthority(artifact);
        const slot = slots[reviewing ? 6 : 5];
        if (
          slot.state !== 'reserved' ||
          !this.remaining(plan.run).concurrency ||
          this.remaining(plan.run).minutes < slot.maximum_minutes
        )
          return { available: false, reason: 'budget-exhausted' };
        if (!reviewing && plan.grants.some((grant) => this.store.receipt(this.grantKey(grant))))
          return { available: false, reason: 'grant-unavailable' };
        return { available: true, reason: 'available' };
      } catch {
        return {
          available: false,
          reason:
            group.phase === 'unknown'
              ? 'ownership-unknown'
              : group.phase === 'paused'
                ? 'paused'
                : reviewing
                  ? 'checks-required'
                  : 'preparation-changed',
        };
      }
    };
    let localAcceptance: CandidateEvaluationPreview['localAcceptance'] = {
      available: false,
      reason: 'evidence-incomplete',
    };
    try {
      this.combinedPublicationEvidence(group, plan.candidate);
      const identity =
        typeof this.options.identity === 'function'
          ? this.options.identity()
          : this.options.identity;
      if (!identity) localAcceptance = { available: false, reason: 'git-identity-missing' };
      else {
        validateIdentity(identity);
        localAcceptance = { available: true, reason: 'available' };
      }
      const publication = this.store.db
        .prepare('SELECT state FROM publications WHERE candidate_id=?')
        .get(plan.candidate.id);
      if (publication)
        localAcceptance = {
          available: false,
          reason: publication.state === 'applied' ? 'accepted' : 'publication-prepared',
        };
      else if (
        this.store.db
          .prepare("SELECT 1 FROM pending_effects WHERE task_id=? AND state='pending'")
          .get(group.task_id)
      )
        localAcceptance = { available: false, reason: 'approval-pending' };
    } catch {}
    return CandidateEvaluationPreviewSchema.parse({
      taskId: group.task_id,
      runId: group.run_id,
      candidateId: plan.candidate.id,
      candidateHash: plan.candidate.hash,
      preparationId: artifact.id,
      recipe: plan.definition.recipeId,
      testFiles:
        plan.definition.recipeId === 'project-node-tests-v1' ? plan.definition.collection : [],
      definitionHash: plan.definition.definitionHash,
      repository: {
        sourceBase: manifest.run.source.base,
        manifestHash: plan.origin.sourceManifestHash,
        files: manifest.sourceFiles.length,
        bytes: manifest.sourceFiles.reduce((sum, file) => sum + file.bytes, 0),
      },
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
        : group.phase === 'checking'
          ? 'checking'
          : group.phase === 'reviewing'
            ? 'reviewing'
            : check
              ? check.passed
                ? 'awaiting-review'
                : 'check-failed'
              : group.phase === 'awaiting-evaluation'
                ? 'prepared'
                : 'blocked',
      check: check ? { artifactId: check.artifactId, passed: check.passed } : null,
      review: review ? { artifactId: review.artifactId, outcome: review.review?.outcome } : null,
      checkStart: availability(false),
      reviewStart: availability(true),
      localAcceptance,
    });
  }

  private candidateEvaluations(taskIds?: ReadonlySet<string>): CandidateEvaluationPreview[] {
    return (
      taskIds ? this.store.byIds<Task>('task', taskIds) : this.store.list<Task>('task')
    ).flatMap((task) => {
      if (!task.runId) return [];
      const receipt =
        this.store.receipt(`evaluation-started:${task.runId}`) ??
        this.store.receipt(`evaluation-ready:${task.runId}`);
      if (!receipt) return [];
      try {
        const artifact = ArtifactSchema.parse(receipt.result.entity);
        const group = this.store.combinedGroup(task.runId);
        if (group?.task_id === task.id) return [this.combinedEvaluationPreview(group, artifact)];
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
        const native = this.evaluationPreparation(plan.run, plan.candidate);
        const appointment = 'kind' in native ? { target: native.target } : native.appointment;
        const target =
          'target' in appointment
            ? this.evidence
                .describe(plan.candidate)
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
              'writerAttemptId' in value.review.job &&
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
              plan.definition.recipeId === 'project-node-tests-v1' ||
              plan.definition.recipeId === 'project-python-unittest-v1'
                ? plan.definition.collection
                : [],
            definitionHash: plan.definition.definitionHash,
            ...('repository' in appointment
              ? { repository: appointment.repository }
              : {
                  target: {
                    path: target?.path,
                    baseHash: 'kind' in native ? native.target.baseHash : native.originalHash,
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
    const group = this.store.combinedGroup(command.payload.taskId);
    if (group?.task_id === command.payload.taskId)
      return this.startCombinedEvaluation(command, effects, group);
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
      next: 'Running the frozen local checks. Native review waits for passing checks and a separate start.',
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
    const minutes = this.admitJob(plan.run, attempt, directory, plan.maximumCheckMinutes);
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
        this.jobDeadline(attempt.id, origin.plan.maximumCheckMinutes) > 0
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
          : plan.definition.recipeId === 'project-python-unittest-v1'
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
      if (
        remaining.attempts < 2 ||
        remaining.minutes < plan.maximumCheckMinutes + 1 ||
        remaining.concurrency < 1
      )
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
        requestedEffort: z.string(),
        effectiveEffort: z.string().optional(),
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
      result.requestedEffort !== appointment.route.effort.requested ||
      (result.effectiveEffort !== appointment.route.effort.effective &&
        (!!appointment.modelRequest || result.effectiveEffort !== undefined))
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
        targetHash: HashSchema.optional(),
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
      (output.targetHash !== undefined &&
        !this.writerBytes(plan.attempt.id, target.path, output.targetHash, target.hash)) ||
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
    if (!this.store.receipt(`native-capture:${plan.attempt.id}`)) {
      const proof = this.repositoryRecoveryProof(plan, candidate);
      const retained = this.nativeRecord(`native-recovery:${plan.attempt.id}`);
      if (hashCanonical(retained.value) !== hashCanonical(proof))
        throw Error('Repository recovery evidence changed.');
      return;
    }
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

  private repositoryRecoveryProof(
    plan: z.infer<typeof NativeHistoricalPreparationSchema>,
    candidate: Candidate,
  ) {
    if (!('repository' in plan.appointment))
      throw Error('Repository recovery needs a repository run.');
    const attempt = this.store.get<Attempt>('attempt', plan.attempt.id);
    const intent = this.store
      .intents()
      .find((value) => value.run_id === plan.run.id && value.attempt_id === plan.attempt.id);
    const submission = this.nativeRecord(
      `native-submission:${plan.attempt.id}`,
      4096,
      'outcome-unknown',
    );
    const submitted = z
      .strictObject({ attemptId: AttemptSchema.shape.id, plan: HashSchema })
      .parse(submission.value);
    const completion = this.nativeRecord(`native-completion:${plan.attempt.id}`, 4096);
    const completed = z
      .object({
        attemptId: AttemptSchema.shape.id,
        reason: z.string().min(1),
        quiescent: z.literal(true),
      })
      .parse(completion.value);
    const receipt = this.store.receipt(`candidate:${plan.attempt.id}`);
    const sealed = CandidateSchema.parse(receipt?.result.entity);
    const phases = this.store.nativeProcesses(plan.attempt.id);
    if (
      attempt?.state !== 'stopped' ||
      attempt.runId !== plan.run.id ||
      attempt.routeId !== plan.attempt.routeId ||
      attempt.generation !== plan.attempt.generation ||
      intent?.attempt_id !== plan.attempt.id ||
      intent.state !== 'stopped' ||
      submitted.attemptId !== plan.attempt.id ||
      submitted.plan !== this.nativeRecord(`native-run:${plan.run.id}`).artifact.hash ||
      completed.attemptId !== plan.attempt.id ||
      !phases.length ||
      phases.some((phase) => phase.state !== 'quiescent') ||
      !this.store.nativePhasesComplete(plan.attempt.id, plan.appointment.route.family) ||
      this.store.db
        .prepare('SELECT attempt_id FROM writer_leases WHERE attempt_id=?')
        .get(plan.attempt.id) ||
      this.store.db
        .prepare('SELECT attempt_id FROM reservations WHERE attempt_id=?')
        .get(plan.attempt.id) ||
      receipt?.hash !== candidate.hash ||
      receipt.result.outcome !== 'applied' ||
      hashCanonical(sealed) !== hashCanonical(candidate) ||
      candidate.taskId !== plan.run.taskId ||
      !this.candidateCurrent(plan.run, candidate) ||
      hashCanonical(this.repositoryScope(plan.run.source.base, plan.manifest)) !==
        hashCanonical(plan.appointment.repository)
    )
      throw Error('Repository recovery evidence is incomplete.');
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
        throw Error('Repository recovery grant evidence changed.');
    }
    return {
      version: 1,
      attemptId: plan.attempt.id,
      planHash: this.nativeRecord(`native-run:${plan.run.id}`).artifact.hash,
      submissionHash: submission.artifact.hash,
      completionHash: completion.artifact.hash,
      completionReason: completed.reason,
      candidateId: candidate.id,
      candidateHash: candidate.hash,
      sourceBase: plan.run.source.base,
      repository: plan.appointment.repository,
      execution: plan.appointment.execution,
      consent: plan.appointment.consent,
    };
  }

  private retainRepositoryRecovery(task: Task) {
    if (!task.runId) return;
    const run = this.store.get<Run>('run', task.runId);
    const candidate = run && this.latestCandidate(run.id);
    if (!run || !candidate) return;
    const plan = NativeHistoricalPreparationSchema.parse(
      this.nativeRecord(`native-run:${run.id}`).value,
    );
    if (
      !('repository' in plan.appointment) ||
      this.store.receipt(`native-capture:${plan.attempt.id}`) ||
      this.store.receipt(`native-recovery:${plan.attempt.id}`)
    )
      return;
    const artifact = this.nativeArtifact(this.repositoryRecoveryProof(plan, candidate));
    this.store.saveReceipt(`native-recovery:${plan.attempt.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
  }

  private nativeReviewSource(plan: EvaluationWriterPreparation, candidate: Candidate) {
    const source = committedFiles(
      this.projectPath(plan.run.source.projectId) as string,
      plan.run.source.base,
    );
    const files = this.evidence.read(candidate).files;
    const local = 'kind' in plan;
    const appointment = local ? { target: plan.target } : plan.appointment;
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
    const first =
      !local && plan.handoff
        ? NativeHistoricalPreparationSchema.parse(
            this.nativeRecord(`native-run:${plan.run.id}`).value,
          )
        : plan;
    const original = source.find((file) => file.path === appointment.target.path);
    const current = files.find((file) => file.path === appointment.target.path);
    if (
      !original ||
      !current ||
      original.hash !== ('kind' in first ? first.target.baseHash : first.originalHash) ||
      (!('kind' in first) &&
        (!('target' in first.appointment) ||
          original.hash !== first.appointment.target.baseHash)) ||
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
    const native = this.evaluationPreparation(run, candidate);
    const local = 'kind' in native;
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
    const submittedWriter = local
      ? null
      : z
          .strictObject({ attemptId: z.string(), plan: HashSchema })
          .parse(
            this.nativeRecord(`native-submission:${native.attempt.id}`, 4096, 'outcome-unknown')
              .value,
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
      (!local &&
        this.store.receipt(this.currentNativePlanKey(run.id))?.hash !==
          hashCanonical(native.appointment)) ||
      this.store.receipt(
        `${!local && 'acp' in native.appointment ? 'native-acp-capture' : !local && 'repository' in native.appointment && this.store.receipt(`native-recovery:${writer.id}`) ? 'native-recovery' : !local && 'repository' in native.appointment ? 'native-capture' : 'native-application'}:${writer.id}`,
      )?.result.outcome !== 'applied' ||
      (local
        ? !same(native.context, evaluation.context)
        : native.appointment.consent.criteriaHash !== hashCanonical(evaluation.context.criteria)) ||
      (!local &&
        native.public &&
        !same(native.public.context, {
          title: evaluation.context.title,
          outcome: evaluation.context.outcome,
        })) ||
      !same(saved.preparation, prepared) ||
      this.store.receipt(`native-review-started:${run.id}`)?.hash !== prepared.hash ||
      this.store.receipt(`native-review-input:${job.attemptId}`)?.hash !== record.artifact.hash ||
      this.store.receipt(`native-review-input:${job.attemptId}`)?.result.outcome !== 'applied' ||
      (!local &&
        (submittedWriter?.attemptId !== writer.id ||
          submittedWriter.plan !== origin.artifact.hash)) ||
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
      ...(!local
        ? [[writer, `native-completion:${writer.id}`, native.appointment.route.family] as const]
        : []),
      [attempt, `native-review-completion:${attempt.id}`, 'openai'],
    ] as const) {
      const recoveredWriter =
        owned.id === writer.id && !!this.store.receipt(`native-recovery:${writer.id}`);
      const completed = z
        .object({
          attemptId: z.string(),
          reason: recoveredWriter ? z.string().min(1) : z.null(),
          quiescent: z.literal(true),
        })
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
      if (hashCanonical(this.projectSource(task.projectId)) !== hashCanonical(run.source))
        return refused('source-changed');
      if (!this.candidateCurrent(run, candidate)) return refused('candidate-changed');
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
    plan: Pick<z.infer<typeof CandidateEvaluationSchema>, 'reviewer' | 'scopeHash'>,
    job: NativeReviewJob | CombinedNativeReviewJob,
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
    const group = this.store.combinedGroup(command.payload.taskId);
    if (group?.task_id === command.payload.taskId)
      return this.startCombinedReview(command, effects, group);
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
          kind: 'candidate-review',
          route,
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
    const openAiBlocker = this.openAiUsageBlocker(route);
    if (openAiBlocker) return { outcome: 'blocked', reason: openAiBlocker };
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
    const prepared =
      'origin' in job
        ? this.combinedReviewAuthority(preparation, attempt.id)
        : this.candidateReviewAuthority(preparation, attempt.id);
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
    job: NativeReviewJob | CombinedNativeReviewJob,
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
            ignoredNotifications: outcome?.ignoredNotifications ?? {},
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
            if ('origin' in job) {
              const group = this.store.combinedGroup(job.runId) as CombinedGroup;
              this.store.db
                .prepare('UPDATE combined_dispatches SET state=? WHERE parent_run_id=? AND phase=?')
                .run(
                  review?.outcome === 'passed' && !runtime.stopped ? 'passed' : 'failed',
                  group.run_id,
                  'review',
                );
            }
            if (!runtime.stopped && !this.closed && review?.outcome === 'passed') {
              try {
                if ('origin' in job)
                  this.combinedPublicationEvidence(
                    this.store.combinedGroup(job.runId) as CombinedGroup,
                    this.store.get<Candidate>('candidate', job.candidateId) as Candidate,
                  );
                else
                  this.nativePublicationCurrent(
                    this.store.get<Run>('run', job.runId) as Run,
                    this.store.get<Candidate>('candidate', job.candidateId) as Candidate,
                  );
                ready = true;
              } catch {}
            }
            if ('origin' in job) {
              const group = this.store.combinedGroup(job.runId) as CombinedGroup;
              if (!['stopping', 'stopped', 'unknown', 'paused'].includes(group.phase))
                this.updateCombined(
                  group,
                  ready ? 'ready' : 'blocked',
                  ready ? null : 'review-required',
                );
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
          ...this.providerUsage(
            attempt,
            () => {
              this.nativeReviewCurrent(runtime);
            },
            () => this.nativeReviewWorkers.get(attempt.id) === runtime && !runtime.stopped,
            ['metadata-preparation', 'app-server-task'],
          ),
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
    const task = this.store.get<Task>('task', run.taskId);
    if (profile.facts.family === 'local') throw Error('Local native launch is unavailable.');
    if (profile.facts.reason === 'provider-policy-restricted')
      throw Error('provider-policy-restricted');
    const modelRequest =
      'repository' in plan.appointment ? plan.appointment.modelRequest : undefined;
    const modelSelection =
      task && modelRequest
        ? this.openAiProjectSelection(task.id, profile, modelRequest)
        : undefined;
    if (
      !profile.facts.available ||
      profile.facts.id !== plan.public.profileId ||
      !profile.facts.creditPolicies.some((policy) => policy === plan.appointment.creditPolicy) ||
      (!('acp' in plan.appointment) &&
        this.nativeProfileRoute(
          profile,
          plan.appointment.creditPolicy,
          modelRequest,
          modelSelection,
        )?.id !== plan.appointment.route.id) ||
      profile.locationHash !== plan.public.locationHash ||
      hashCanonical(profile.client) !== hashCanonical(plan.appointment.client) ||
      !profile.environment
    )
      throw Error('Native profile changed.');
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
    const appointmentModelRequest =
      'repository' in appointment ? appointment.modelRequest : undefined;
    const appointmentModelSelection =
      'repository' in appointment
        ? this.openAiProjectSelection(
            appointment.taskId,
            this.profileFor('openai-repository-v1'),
            appointmentModelRequest,
          )
        : undefined;
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
      (!!appointmentModelSelection &&
        (route.model !== appointmentModelSelection.model ||
          route.effort.requested !== appointmentModelSelection.effort ||
          route.effort.effective !== appointmentModelSelection.effort)) ||
      !route.effort.supported.includes(route.effort.requested) ||
      (this.store.get('route', route.id) &&
        (!publicScope ||
          this.nativeProfileRoute(
            this.profileFor(publicScope.profileId),
            appointment.creditPolicy,
            appointmentModelRequest,
            appointmentModelRequest ? appointmentModelSelection : undefined,
          )?.id !== route.id))
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
        this.nativeProfileRouteKey(
          plan.public.profileId,
          appointment.creditPolicy,
          'repository' in appointment ? appointment.modelRequest : undefined,
        ),
      )
    )
      this.store.saveReceipt(
        this.nativeProfileRouteKey(
          plan.public.profileId,
          appointment.creditPolicy,
          'repository' in appointment ? appointment.modelRequest : undefined,
        ),
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
    appointment:
      | NativePilotAppointment
      | {
          kind: 'candidate-review';
          route: Route;
          maximumTaskMs: number;
          expiresAt: string;
        },
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

  private acpQuotaState(routeId: string, modelId: string, run: Run) {
    const reader = this.store.googleUsageReader();
    const { windows, missingRequired } = googleQuotaWindows(
      modelId,
      this.store
        .list<Observation>('window')
        .filter((value) => value.routeId === routeId && value.kind !== 'local'),
    );
    let needsRefresh = !reader.last_observed_at || !windows.length || missingRequired;
    let reserveReason: string | undefined;
    const nowMs = Date.parse(this.now());
    for (const window of windows) {
      if (
        deriveWindow(window, { nowMs, maxAgeMs: 300000 }).state !== 'fresh' ||
        window.remaining === null ||
        window.source !== 'client' ||
        window.confidence !== 'reported'
      ) {
        needsRefresh = true;
        continue;
      }
      const reserves = run.policy.policy.reserves.filter(
        (value) => value.routeId === routeId && value.windowId === window.windowId,
      );
      const reservations = this.store.db
        .prepare('SELECT unit,value FROM reservations WHERE route_id=? AND window_id=?')
        .all(routeId, window.windowId) as {
        unit: NonNullable<Observation['remaining']>['unit'];
        value: number;
      }[];
      try {
        if (
          reserves.length > 1 ||
          availableAllowance({ remaining: window.remaining, reserve: reserves[0], reservations }) <=
            0
        )
          reserveReason = 'A Google quota bucket has reached its reserve.';
      } catch {
        reserveReason = 'A Google reserve has incompatible allowance units.';
      }
    }
    if (
      run.policy.policy.reserves.some(
        (value) =>
          value.routeId === routeId &&
          !windows.some((window) => window.windowId === value.windowId),
      )
    )
      needsRefresh = true;
    return { reader, windows, needsRefresh, reserveReason };
  }

  private acpDecision(
    appointment: z.infer<typeof NativeAcpAppointmentSchema>,
    run: Run,
  ): RouterDecision {
    const { reader, windows, needsRefresh, reserveReason } = this.acpQuotaState(
      appointment.route.id,
      appointment.acp.modelId,
      run,
    );
    let reason = reserveReason;
    if (needsRefresh) reason ??= 'Every applicable Google quota bucket needs fresh observations.';
    if (
      appointment.maximumTaskMs > 300000 &&
      this.remaining(run).minutes * 60000 < appointment.maximumTaskMs
    )
      reason = 'The remaining task allowance cannot cover the saved Google deadline.';
    if (Date.parse(appointment.expiresAt) <= Date.parse(this.now()))
      reason = 'Native consent expired.';
    return {
      chosen: reason ? null : appointment.route.id,
      rejected: reason ? [{ routeId: appointment.route.id, reason }] : [],
      rule: 'percentage',
      inputsHash: hashCanonical({ reader, windows, policy: run.policy, reason: reason ?? null }),
    };
  }

  private acpTargetSnapshot(runtime: NativeRuntime) {
    this.nativeCurrent(runtime);
    const appointment = runtime.binding.appointment;
    if (!('acp' in appointment)) throw Error('ACP permission has no owned attempt.');
    const captured = captureSingleFileEdit({
      directory: this.writerScratch(runtime.binding.run),
      manifest: runtime.binding.manifest,
      target: appointment.target,
    });
    const file = captured.files.find((entry) => entry.path === appointment.target.path);
    if (!file) throw Error('ACP target is unavailable.');
    return {
      path: file.path,
      hash: file.hash,
      mode: file.mode,
      content: file.content.toString('utf8'),
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
    acpPermissionAfterHash(detail, this.acpTargetSnapshot(runtime));
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
    const finish = async (
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
            diagnostic: AcpDiagnosticSchema.nullable().parse(outcome?.diagnostic ?? null),
            exitCode: outcome?.exitCode ?? null,
            signal: outcome?.signal ?? null,
            stdoutBytes: outcome?.stdoutBytes ?? 0,
            stderrBytes: outcome?.stderrBytes ?? 0,
            ...(outcome ? { stderrSummary: outcome.stderrSummary } : {}),
            trailingUpdates: outcome?.trailingUpdates ?? 0,
            rejectedOutsideWrites: outcome?.rejectedOutsideWrites ?? 0,
            openToolCount: outcome?.openToolCount ?? 0,
            openToolKinds: outcome?.openToolKinds ?? [],
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
        if (known) await this.formatAttempt(attempt);
        // A submitted turn with no terminal response stays unknown. Once every recorded group is
        // gone it holds nothing, so it settles here and captures nothing.
        const closed = known ? undefined : this.shutdownProof(intent);
        if (closed) {
          this.store.transaction(() =>
            this.settleUnknownWriter(
              intent,
              closed,
              'Every recorded process group exited and the turn returned no terminal response.',
            ),
          );
          this.workers.delete(attempt.id);
          return;
        }
        let eligible =
          known &&
          !runtime.stopped &&
          !this.closed &&
          !outcome?.reason &&
          metadata?.stopReason === 'end_turn';
        // An agent can end its turn cleanly after a failed or skipped edit.
        const unapproved =
          eligible &&
          (!metadata?.targetHash || metadata.targetHash === appointment.target.baseHash);
        if (unapproved) eligible = false;
        if (eligible) {
          try {
            this.nativeCurrent(runtime);
          } catch {
            eligible = false;
          }
        }
        if (!this.settleJob(attempt, known, true)) return;
        let captured = false;
        let unchanged = false;
        if (known) {
          try {
            const files = captureSingleFileEdit({
              directory: intent.scratch_path,
              manifest: binding.manifest,
              target: appointment.target,
            });
            // With no approved change and scratch still at the admitted source, there is
            // nothing to check or review. Any unapproved write keeps the unverified path.
            unchanged = unapproved && files.target.hash === appointment.target.baseHash;
            const candidate = unchanged ? null : this.sealCandidate(attempt, files.files);
            if (
              metadata?.targetHash !== undefined &&
              !this.writerBytes(
                attempt.id,
                files.target.path,
                metadata.targetHash,
                files.target.hash,
              )
            )
              eligible = false;
            if (eligible && candidate) {
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
              : unchanged
                ? 'Native turn ended without an approved change. Nothing was captured.'
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
            ...(appointment.contextLines === undefined
              ? {}
              : { contextLines: appointment.contextLines }),
            proof: appointment.proof,
            client: appointment.client,
            ...this.options.googleAcp,
          }),
          ...(binding.context.binding.patch ? { mcpServer: context.server } : {}),
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
          readTarget: () => this.acpTargetSnapshot(runtime),
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
        await finish(await handle.result);
      } catch {
        await finish(null, this.store.nativeProcesses(attempt.id).length === 0);
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
    const group = this.store.combinedGroup(run.id);
    if (group) this.combinedCurrent(group, group.phase === 'paused');
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

  private storeProviderUsage(
    routeId: string,
    value: unknown,
    current: () => void,
    prior?: ReadonlyMap<string, Observation>,
  ): boolean {
    try {
      const parsed = ProviderUsageBatchSchema.safeParse(value);
      if (!parsed.success || Buffer.byteLength(canonicalJson(parsed.data)) > 32768) return false;
      const report = parsed.data;
      const ids = new Set(report.observations.map((observation) => observation.windowId));
      if (
        ids.size !== report.observations.length ||
        Date.parse(report.observedAt) > Date.parse(this.now()) ||
        report.observations.some(
          (observation) =>
            observation.routeId !== routeId ||
            observation.observedAt !== report.observedAt ||
            observation.source !== 'client' ||
            observation.confidence !== 'reported',
        )
      )
        return false;
      return this.store.transaction(() => {
        if (this.closed) return false;
        current();
        const windows = this.store
          .list<Observation>('window')
          .filter((window) => window.routeId === routeId);
        const existing = new Map(windows.map((window) => [window.windowId, window]));
        const ownedPrior = (window: Observation) =>
          window.source === 'client' &&
          prior?.has(window.windowId) &&
          hashCanonical(prior.get(window.windowId)) === hashCanonical(window);
        if (
          (report.mode === 'complete' &&
            windows.some(
              (window) =>
                window.source === 'client' &&
                Date.parse(window.observedAt) > Date.parse(report.observedAt),
            )) ||
          report.observations.some((observation) => {
            const previous = existing.get(observation.windowId);
            return (
              previous &&
              Date.parse(previous.observedAt) === Date.parse(observation.observedAt) &&
              hashCanonical(previous) !== hashCanonical(observation) &&
              !ownedPrior(previous)
            );
          })
        )
          return false;
        let removed = false;
        let written = false;
        if (report.mode === 'complete')
          for (const window of windows)
            if (
              window.source === 'client' &&
              !ids.has(window.windowId) &&
              (Date.parse(window.observedAt) < Date.parse(report.observedAt) ||
                (Date.parse(window.observedAt) === Date.parse(report.observedAt) &&
                  ownedPrior(window)))
            ) {
              this.store.db
                .prepare("DELETE FROM entities WHERE kind='window' AND id=?")
                .run(`${window.routeId}/${window.windowId}`);
              removed = true;
            }
        for (const observation of report.observations) {
          const previous = existing.get(observation.windowId);
          if (
            previous &&
            (Date.parse(previous.observedAt) > Date.parse(observation.observedAt) ||
              (Date.parse(previous.observedAt) === Date.parse(observation.observedAt) &&
                (!ownedPrior(previous) || hashCanonical(previous) === hashCanonical(observation))))
          )
            continue;
          this.store.put(
            'window',
            `${observation.routeId}/${observation.windowId}`,
            0,
            observation,
          );
          this.event('usage.observed', null, 0, observation);
          written = true;
        }
        if (removed && !written) this.event('usage.observed', null, 0, report.observations[0]);
        return true;
      });
    } catch {
      return false;
    }
  }

  private providerUsageAdapter(
    routeId: string,
    onReport: (report: unknown, prior: ReadonlyMap<string, Observation>) => boolean,
  ) {
    const seen = new Map<string, Observation>();
    return (value: unknown) => {
      try {
        const parsed = ProviderUsageDraftSchema.safeParse(value);
        if (!parsed.success) return false;
        const complete =
          parsed.data.complete === true &&
          this.store.get<Route>('route', routeId)?.family === 'openai';
        const windows = parsed.data.windows.map((window) => {
          if ('remainingPercent' in window)
            return {
              windowId: window.windowId,
              kind: window.kind,
              semantics: window.semantics,
              remaining: { value: window.remainingPercent, unit: 'percent' as const },
              resetsAt: window.resetsAt,
              source: 'client' as const,
              confidence: 'reported' as const,
            };
          return window;
        });
        if (
          !complete &&
          new Set([...seen.keys(), ...windows.map((window) => window.windowId)]).size > 32
        )
          return false;
        const changed = complete
          ? windows
          : windows.filter((window) => {
              const previous = seen.get(window.windowId);
              if (!previous) return true;
              const { routeId: _route, observedAt: _time, ...reading } = previous;
              return hashCanonical(reading) !== hashCanonical(window);
            });
        if (!changed.length) return true;
        const observedAt = this.now();
        const observations = changed.map((window) => ({ ...window, routeId, observedAt }));
        if (onReport({ mode: complete ? 'complete' : 'partial', observedAt, observations }, seen)) {
          if (complete) seen.clear();
          for (const observation of observations) seen.set(observation.windowId, observation);
          return true;
        }
      } catch {}
      return false;
    };
  }

  private providerUsage(
    attempt: Attempt,
    current: () => void,
    ownsRuntime: () => boolean,
    phases: readonly string[],
  ) {
    const route = this.store.get<Route>('route', attempt.routeId);
    const routeHash = hashCanonical(route ?? null);
    const onReport = (value: unknown, prior?: ReadonlyMap<string, Observation>) =>
      this.storeProviderUsage(
        attempt.routeId,
        value,
        () => {
          if (
            this.closed ||
            !ownsRuntime() ||
            !route ||
            route.fake ||
            !['openai', 'anthropic'].includes(route.family)
          )
            throw Error('Provider usage ownership changed.');
          current();
          const saved = this.store.get<Attempt>('attempt', attempt.id);
          const intent = this.store.intents().find((row) => row.attempt_id === attempt.id);
          const task = intent && this.store.get<Task>('task', intent.task_id);
          const lease =
            intent &&
            this.store.db
              .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
              .get(intent.task_id);
          const phase = this.store.nativeProcesses(attempt.id).at(-1);
          if (
            !saved ||
            !['intent', 'running'].includes(saved.state) ||
            saved.generation !== attempt.generation ||
            saved.routeId !== attempt.routeId ||
            saved.runId !== attempt.runId ||
            !intent ||
            intent.state !== 'acknowledged' ||
            intent.run_id !== attempt.runId ||
            intent.route_id !== attempt.routeId ||
            intent.generation !== attempt.generation ||
            task?.runId !== intent.run_id ||
            lease?.attempt_id !== attempt.id ||
            lease.generation !== attempt.generation ||
            !phase ||
            phase.state !== 'owned' ||
            !phases.includes(phase.phase) ||
            hashCanonical(this.store.get<Route>('route', attempt.routeId) ?? null) !== routeHash
          )
            throw Error('Provider usage ownership changed.');
        },
        prior,
      );
    return {
      usage: {
        routeId: attempt.routeId,
        observedAt: this.now,
        onReport: (value: unknown) => onReport(value),
      },
      onUsage: this.providerUsageAdapter(attempt.routeId, onReport),
    };
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

  // A stored plan proposal counts only while its body still matches the referenced hash.
  private planProposal(taskId: string, reference: { id: string; hash: string }) {
    const row = this.store.db
      .prepare('SELECT body FROM conversation_entries WHERE id=? AND task_id=?')
      .get(reference.id, taskId);
    const entry =
      row &&
      (JSON.parse(row.body as string) as Extract<
        import('@crewkite/contracts').ConversationEntry,
        { kind: 'plan-proposal' }
      >);
    return entry?.kind === 'plan-proposal' && hashCanonical(entry.proposal) === reference.hash
      ? entry
      : undefined;
  }

  // An adopted plan names the paths its coder slices may change while the task keeps the
  // plan's criteria. Other tasks name none. A stored proposal that no longer matches its
  // adopted hash throws.
  private adoptedCoderScope(taskId: string): string[] {
    const adopted = this.conversationConfiguration(taskId)?.adoptedProposal;
    if (!adopted) return [];
    const entry = this.planProposal(taskId, adopted);
    if (!entry) throw Error('The adopted plan changed.');
    const task = this.store.get<Task>('task', taskId) as Task;
    if (hashCanonical(entry.proposal.criteria) !== hashCanonical(task.criteria)) return [];
    const coder = entry.proposal.slices.filter((slice) => slice.role === 'coder');
    return [...new Set(coder.flatMap((slice) => slice.scope))].sort();
  }

  private nativeWriterPlan(binding: Omit<NativeBinding, 'planArtifact'>) {
    const { appointment, attempt } = binding;
    const criteria = [
      ...(binding.public ? [binding.public.context.title, binding.public.context.outcome] : []),
      ...(this.store.get<Task>('task', binding.run.taskId) as Task).criteria,
    ];
    if ('acp' in appointment)
      return googleAcpWriterPlan({
        client: appointment.client,
        attemptId: attempt.id,
        generation: attempt.generation,
        target: appointment.target,
        criteria,
        selection: appointment.acp,
        ...(appointment.contextLines === undefined
          ? {}
          : { contextLines: appointment.contextLines }),
        proof: appointment.proof,
        ...this.options.googleAcp,
      });
    if ('repository' in appointment) {
      const committed = (path: string) => binding.manifest.some((file) => file.path === path);
      return repositoryPlan({
        attemptId: attempt.id,
        model: appointment.route.model as WriterPlan['model'],
        effort: appointment.route.effort.requested,
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
        limits: {
          deadlineMs: appointment.maximumTaskMs,
          paths: this.adoptedCoderScope(binding.run.taskId),
          // Verification preparation needs this journey and lockfile in the source.
          ...(committed('e2e/desktop.spec.ts') && committed('pnpm-lock.yaml')
            ? verificationGuidance
            : { checks: [], frozen: [] }),
          review: repositoryReviewBudget,
        },
      });
    }
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
            ...this.providerUsage(
              attempt,
              () => this.nativeCurrent(runtime),
              () => this.workers.get(attempt.id) === runtime && !runtime.stopped,
              ['native-task'],
            ),
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
    const finish = async (outcome: NativeOutcome | null) => {
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
              ...(outcome?.ignoredNotifications
                ? { ignoredNotifications: outcome.ignoredNotifications }
                : {}),
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
        if (quiescent) await this.formatAttempt(attempt);
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
              const combined = this.store.combinedGroup(run.id);
              const quotaDenied = !!combined && this.confirmedQuotaDenial(intent);
              this.store.transaction(() => {
                const task = this.store.get<Task>('task', run.taskId) as Task;
                this.closePendingEffects(task);
                this.updateTask(task, {
                  state: applied ? 'stopped' : 'interrupted',
                  waitingReason: null,
                  next: applied
                    ? 'Native work is retained. Checks and review remain pending.'
                    : nativeFailureNext(outcome),
                });
                if (quotaDenied) {
                  const changed = this.store.db
                    .prepare(
                      "UPDATE combined_dispatches SET state='stopped' WHERE parent_run_id=? AND attempt_id=? AND state='running'",
                    )
                    .run(combined.run_id, attempt.id);
                  if (changed.changes !== 1) throw Error('The combined quota slot changed.');
                  const writers = this.store
                    .combinedDispatches(combined.run_id)
                    .filter((slot) => slot.phase.startsWith('writer-'));
                  if (writers.every((slot) => ['passed', 'stopped'].includes(slot.state)))
                    this.updateCombined(combined, 'blocked', 'writers-incomplete');
                  else this.updateCombined(combined, 'writers');
                }
              });
              if (!quotaDenied) this.sealCandidate(attempt);
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
        this.armQuotaRetries();
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
          ...this.providerUsage(
            attempt,
            () => this.nativeCurrent(runtime),
            () => this.workers.get(attempt.id) === runtime && !runtime.stopped,
            ['metadata-preparation', 'app-server-task'],
          ),
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
      void finish(null);
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
        if (
          this.evidence.hash(run.source.base, this.candidateFiles(run, intent.scratch_path)) !==
          candidate.hash
        )
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
          await this.finishAttempt(attempt.id, quiescent);
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

  private async finishAttempt(attemptId: string, quiescent: boolean) {
    if (this.closed) return;
    const writer = this.store.get<Attempt>('attempt', attemptId);
    if (
      quiescent &&
      writer &&
      writer.state !== 'stopped' &&
      writer.state !== 'failed' &&
      this.workers.get(attemptId)?.kind === 'fake'
    )
      await this.formatAttempt(writer);
    this.settleFinishedAttempt(attemptId, quiescent);
  }

  private settleFinishedAttempt(attemptId: string, quiescent: boolean) {
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

  private stopCombined(group: CombinedGroup, effects: (() => void)[]) {
    this.updateCombined(group, 'stopping');
    const runs = [
      group.run_id,
      ...this.store.combinedMembers(group.run_id).map((member) => member.run_id),
    ];
    for (const runId of runs) {
      const run = this.store.get<Run>('run', runId) as Run;
      const task = this.store.get<Task>('task', run.taskId) as Task;
      this.closePendingEffects(task);
      this.stop(
        CommandSchema.parse({
          protocol: 1,
          key: this.id('cmd'),
          actor: { id: 'controller', kind: 'controller' },
          command: 'StopRun',
          expectedRevision: task.revision,
          payload: { taskId: task.id, runId },
        }) as Extract<Command, { command: 'StopRun' }>,
        effects,
        true,
      );
    }
    const git = this.combinedOperations.get(group.run_id);
    if (git) effects.push(git.stop);
    this.refreshCombinedStop(group);
    const task = this.store.get<Task>('task', group.task_id) as Task;
    return { outcome: 'applied' as const, entity: task, revision: task.revision };
  }

  private refreshCombinedStop(group: CombinedGroup) {
    const current = this.store.combinedGroup(group.run_id) as CombinedGroup;
    if (!['stopping', 'unknown'].includes(current.phase)) return;
    const slots = this.store.combinedDispatches(group.run_id);
    const intents = this.store
      .intents()
      .filter((intent) => slots.some((slot) => slot.attempt_id === intent.attempt_id));
    const unknown =
      slots.some((slot) => slot.state === 'unknown') ||
      this.store.combinedRefIntents(group.run_id).some((intent) => intent.state === 'unknown');
    const active =
      intents.some((intent) => intent.state !== 'stopped') || current.integration_active;
    const phase = unknown ? 'unknown' : active ? 'stopping' : 'stopped';
    this.updateCombined(current, phase, unknown ? 'ownership-unknown' : null);
    this.updateTask(this.store.get<Task>('task', group.task_id) as Task, {
      state: phase,
      waitingReason: null,
      next:
        phase === 'stopped'
          ? 'All combined owners are stopped. Retained work remains available.'
          : phase === 'unknown'
            ? 'Combined ownership is unknown. All admissions remain closed.'
            : 'Waiting for every combined owner to stop.',
    });
  }

  private stop(
    command: Extract<Command, { command: 'StopRun' }>,
    effects: (() => void)[],
    memberStop = false,
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId);
    if (!task || task.runId !== command.payload.runId)
      return { outcome: 'blocked', reason: 'run-not-current' };
    const group = this.store.combinedGroup(command.payload.runId);
    if (group?.phase === 'accepted')
      return { outcome: 'applied', entity: task, revision: task.revision };
    const runForStop = this.store.get<Run>('run', command.payload.runId);
    const stopRoute =
      runForStop?.decision.chosen && this.store.get<Route>('route', runForStop.decision.chosen);
    const usesOpenAi = stopRoute && stopRoute.family === 'openai' && !stopRoute.fake;
    if (usesOpenAi && this.openAiUsageRead) {
      const reader = this.openAiUsageRead;
      effects.push(() => {
        reader.stopped = true;
        reader.handle?.stop();
      });
    }
    if (group && !memberStop) {
      if (group.task_id === task.id) return this.stopCombined(group, effects);
      if (!['stopping', 'stopped', 'unknown', 'accepted'].includes(group.phase))
        this.updateCombined(group, 'blocked', 'stopped');
    }
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
      try {
        this.retainRepositoryRecovery(task);
      } catch {
        // Stop still closes launch authority when retained evidence cannot support evaluation.
      }
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
      this.pendingLocalLaunches.has(active.attempt_id) &&
      active.state === 'intent' &&
      !this.store.nativeProcesses(active.attempt_id).length
    ) {
      this.pendingLocalLaunches.delete(active.attempt_id);
      const plan = this.localPrepared(active.run_id);
      const binding = {
        ...plan.localModel,
        attemptId: plan.attempt.id,
        generation: plan.attempt.generation,
        profileHash: hashCanonical(plan.profile),
        sourceHash: plan.scopeHash,
        path: plan.target.path,
        baseHash: plan.target.baseHash,
      };
      const stopped = {
        ...plan.attempt,
        state: 'stopped' as const,
        revision: plan.attempt.revision + 1,
      };
      this.store.put('attempt', stopped.id, stopped.revision, stopped);
      this.store.db
        .prepare("UPDATE launch_intents SET state='stopped',finished_at=? WHERE attempt_id=?")
        .run(this.now(), stopped.id);
      this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(stopped.id);
      this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(stopped.id);
      const proof = this.nativeArtifact({
        attemptId: stopped.id,
        bindingHash: hashCanonical(binding),
        terminal: null,
        clientQuiescent: true,
        known: true,
        unspawned: true,
        at: this.now(),
      });
      this.store.saveReceipt(`local-terminal:${stopped.id}`, proof.hash, 'local-owner', {
        outcome: 'applied',
        entity: proof,
      });
      const updated = this.updateTask(task, {
        state: 'stopped',
        waitingReason: null,
        next: 'Local work stopped before its process launched.',
      });
      this.event('attempt.stopped', task.id, updated.revision, stopped);
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    const localRuntime = this.localWriters.get(active.attempt_id);
    if (localRuntime) {
      if (
        ['outcome-unknown', 'interrupted'].includes(active.state) ||
        this.store.get<Attempt>('attempt', active.attempt_id)?.state === 'unknown'
      )
        return { outcome: 'blocked', reason: 'local-generation-unknown' };
      localRuntime.stopped = true;
      const updated = this.updateTask(task, {
        state: 'stopping',
        waitingReason: null,
        next: 'Waiting for the Local runtime terminal and client closure.',
      });
      effects.push(() => localRuntime.handle?.stop());
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
          this.combinedCheckOwners.get(active.attempt_id)?.stop();
          check.stop();
          if (check instanceof ToolchainVerification) return;
          const cancel = (this.options.schedule ?? defaultSchedule)(
            () => this.settleJob(attempt, false),
            1000,
          );
          void check.exited.then(async () => {
            const quiescent = await check.quiescent(this.options.schedule);
            cancel();
            if (this.settleJob(attempt, quiescent)) this.stoppedJob(attempt);
          });
        }
      });
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    if (
      (this.store.receipt(`evaluation-check:${active.attempt_id}`) ||
        this.store.receipt(`combined-check:${active.attempt_id}`) ||
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
      return (
        (!memberStop && command.actor.kind !== 'controller'
          ? this.stopUnknownWriter(active)
          : undefined) ?? {
          outcome: 'blocked',
          reason: 'writer-ownership-unknown',
          next: 'Prove the prior process group is gone before continuing.',
        }
      );
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

  // A writer without terminal proof keeps an unknown outcome, and an ACP or Local writer in that
  // state holds the lease and closes its provider gate. Process absence is the one fact the
  // controller can prove afterwards, and only ESRCH counts. A phase still at launch intent may
  // hide a spawned process with no recorded group, so it proves nothing. Combined runs keep
  // their own ledger and stay out.
  private shutdownProof(intent: LaunchIntent): { groups: number[] } | undefined {
    if (this.store.combinedGroup(intent.run_id)) return undefined;
    const phases = this.store.nativeProcesses(intent.attempt_id);
    const groups = [
      ...new Set([intent.process_group, ...phases.map((phase) => phase.process_group)]),
    ].filter((group) => group !== null);
    if (
      !phases.length ||
      phases.some((phase) => phase.state === 'intent') ||
      !groups.every((group) => groupAbsent(group))
    )
      return undefined;
    return { groups };
  }

  // The longest an attempt can legitimately run: the plan's task limit for native writers, the
  // profile limit for Local and the reserved minutes for everything else.
  private attemptMaximumMs(intent: LaunchIntent): number | undefined {
    try {
      const run = this.store.get<Run>('run', intent.run_id) as Run;
      const route = this.store.get<Route>('route', intent.route_id);
      if (route?.family === 'local' && !route.fake)
        return this.localPrepared(run.id).profile.maximumTaskMs;
      if (this.store.receipt(this.currentNativePlanKey(run.id)))
        return this.nativeCurrentPlan(run).appointment.maximumTaskMs;
      const minutes = this.store.db
        .prepare('SELECT MAX(minutes) AS minutes FROM reservations WHERE attempt_id=?')
        .get(intent.attempt_id)?.minutes;
      return typeof minutes === 'number' ? minutes * 60000 : undefined;
    } catch {
      return undefined;
    }
  }

  // Minutes are charged up to the recorded shutdown proof, the quiescent time of the last phase.
  // Without that record the charge runs to now, capped at the attempt's own limit plus a cleanup
  // reserve so a long outage cannot bill time the process could not have used. It never falls
  // below the latest time the journal shows the process alive.
  private shutdownCharge(intent: LaunchIntent): string {
    const phases: NativeProcess[] = this.store.nativeProcesses(intent.attempt_id);
    const last = phases.at(-1);
    if (last?.state === 'quiescent' && last.quiescent_at) return last.quiescent_at;
    const now = this.now();
    const limit = this.attemptMaximumMs(intent);
    const admitted = Date.parse(intent.admitted_at ?? '');
    const cap =
      limit !== undefined && Number.isFinite(admitted)
        ? admitted + limit + cleanupReserveMs
        : Number.POSITIVE_INFINITY;
    const alive = Math.max(
      ...phases
        .flatMap((phase) => [phase.intent_at, phase.quiescent_at])
        .map((at) => Date.parse(at ?? ''))
        .filter(Number.isFinite),
    );
    const end = Math.max(alive, Math.min(Date.parse(now), cap));
    return end === Date.parse(now) ? now : new Date(end).toISOString();
  }

  // Settles one unknown writer after its shutdown is proven. The attempt keeps its unknown
  // outcome and every submission, completion, terminal and phase record stays. The intent stops
  // at the charged time and the lease and reservations release. Nothing is captured, no success
  // is inferred, and the stopped intent keeps this run from starting again.
  private settleUnknownWriter(
    intent: LaunchIntent,
    proof: { groups: number[] },
    reason: string,
    lead = '',
  ): Task | undefined {
    const attempt = this.store.get<Attempt>('attempt', intent.attempt_id);
    const task = this.store.get<Task>('task', intent.task_id);
    if (!attempt || !task || attempt.state === 'stopped') return undefined;
    const at = this.shutdownCharge(intent);
    const retained = (key: string) =>
      (this.store.receipt(key)?.result.entity as Artifact | undefined)?.hash ?? null;
    const record = this.nativeArtifact({
      attemptId: attempt.id,
      outcome: 'unknown',
      submissionHash: retained(`native-submission:${attempt.id}`),
      completionHash: retained(`native-completion:${attempt.id}`),
      terminalHash: retained(`local-terminal:${attempt.id}`),
      groups: proof.groups,
      absentAt: this.now(),
      chargedThrough: at,
    });
    this.store.saveReceipt(`native-unknown-settled:${attempt.id}`, record.hash, 'local-owner', {
      outcome: 'applied',
      entity: record,
    });
    if (attempt.state !== 'unknown')
      this.store.put('attempt', attempt.id, attempt.revision + 1, {
        ...attempt,
        state: 'unknown',
        revision: attempt.revision + 1,
      });
    this.store.db
      .prepare("UPDATE launch_intents SET state='stopped',finished_at=? WHERE attempt_id=?")
      .run(at, attempt.id);
    this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
    this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
    this.closePendingEffects(task);
    const updated = this.updateTask(task, {
      state: 'interrupted',
      waitingReason: null,
      next: `${lead}Every recorded process group exited. The turn outcome stays unknown, retained work is unverified and nothing was captured. Create a new task to continue.`,
    });
    this.event('run.interrupted', task.id, updated.revision, { runId: intent.run_id, reason });
    return updated;
  }

  // An explicit Stop reaches an unknown writer only in a controller that holds no runtime for
  // it, and only the same absence proof can close it.
  private stopUnknownWriter(intent: LaunchIntent): CommandResult | undefined {
    const attempt = this.store.get<Attempt>('attempt', intent.attempt_id);
    const route = this.store.get<Route>('route', intent.route_id);
    if (
      attempt?.state !== 'unknown' ||
      (this.store.nativeProfileId(attempt.id) !== 'google-acp-v1' &&
        !(route?.family === 'local' && !route.fake))
    )
      return undefined;
    const proof = this.shutdownProof(intent);
    if (!proof) return undefined;
    const updated = this.settleUnknownWriter(
      intent,
      proof,
      'An explicit Stop closed a turn with an unknown outcome after its process groups exited.',
    );
    return updated && { outcome: 'applied', entity: updated, revision: updated.revision };
  }

  private recoverLocalWriter(
    intent: LaunchIntent,
    attempt: Attempt,
    run: Run,
    task: Task,
  ): boolean {
    const route = this.store.get<Route>('route', intent.route_id);
    if (route?.family !== 'local' || route.fake) return false;
    try {
      // The fixed CPU evaluator catalog has its own checked process proof.
      const cpuRoute = RouteSchema.parse(this.nativeRecord('node-check-route').value);
      if (cpuRoute.id === route.id && hashCanonical(cpuRoute) === hashCanonical(route))
        return false;
    } catch {}
    let known = false;
    let finishedAt = this.now();
    try {
      const plan = this.localPrepared(run.id);
      const expected = LocalBindingSchema.parse({
        ...plan.localModel,
        attemptId: attempt.id,
        generation: attempt.generation,
        profileHash: hashCanonical(plan.profile),
        sourceHash: plan.scopeHash,
        path: plan.target.path,
        baseHash: plan.target.baseHash,
      });
      const receipt = this.store.receipt(`local-terminal:${attempt.id}`);
      if (
        receipt?.result.outcome !== 'applied' ||
        plan.attempt.id !== attempt.id ||
        plan.attempt.generation !== intent.generation ||
        plan.attempt.routeId !== intent.route_id ||
        plan.run.taskId !== task.id ||
        plan.run.id !== run.id
      )
        throw Error('Local terminal lineage is unavailable.');
      const proof = z
        .strictObject({
          attemptId: AttemptSchema.shape.id,
          bindingHash: HashSchema,
          terminal: LocalTerminalSchema.nullable(),
          clientQuiescent: z.boolean(),
          known: z.boolean(),
          unspawned: z.boolean(),
          at: TimestampSchema,
        })
        .parse(this.nativeRecord(`local-terminal:${attempt.id}`).value);
      const phases = this.store.nativeProcesses(attempt.id);
      const submitted = !!this.store.receipt(`native-submission:${attempt.id}`);
      if (
        proof.attemptId !== attempt.id ||
        proof.bindingHash !== hashCanonical(expected) ||
        !proof.known ||
        !proof.clientQuiescent
      )
        throw Error('Local terminal proof changed.');
      if (proof.unspawned) {
        if (
          submitted ||
          phases.length ||
          intent.pid !== null ||
          intent.process_group !== null ||
          proof.terminal !== null
        )
          throw Error('An unspawned Local turn has process or submission history.');
      } else {
        const terminal = proof.terminal;
        if (
          !terminal ||
          terminal.kind === 'unknown' ||
          hashCanonical(terminal.binding) !== hashCanonical(expected) ||
          (terminal.kind === 'failed' && terminal.proof === null && submitted) ||
          (terminal.proof !== null &&
            terminal.proof.maxTokens !== plan.profile.maximumOutputTokens) ||
          !this.store.nativePhasesComplete(attempt.id, 'local') ||
          phases.some((phase) => phase.state !== 'quiescent')
        )
          throw Error('A Local generation has no matching runtime terminal.');
      }
      known = true;
      finishedAt = proof.at;
    } catch {}
    const closed = known ? undefined : this.shutdownProof(intent);
    if (closed) {
      this.settleUnknownWriter(
        intent,
        closed,
        'Controller restarted after every recorded process group exited. Local recorded no matching terminal.',
      );
      return true;
    }
    const updated = {
      ...attempt,
      state: known ? ('stopped' as const) : ('unknown' as const),
      revision: attempt.revision + 1,
    };
    this.store.put('attempt', attempt.id, updated.revision, updated);
    this.store.db
      .prepare('UPDATE launch_intents SET state=?,finished_at=? WHERE attempt_id=?')
      .run(known ? 'stopped' : 'outcome-unknown', known ? finishedAt : null, attempt.id);
    if (known) {
      this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
      this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
    }
    if (!known || task.runId === run.id)
      this.updateTask(task, {
        state: known ? 'interrupted' : 'unknown',
        waitingReason: null,
        next: known
          ? 'The Local terminal is retained. Inspect existing work; nothing will replay.'
          : 'Local generation ownership is unknown. Its lease and reservation remain held.',
      });
    this.event('run.interrupted', task.id, task.revision + 1, {
      runId: run.id,
      reason: known
        ? 'Local runtime terminal and client closure were recorded.'
        : 'Local generation has no recorded matching terminal.',
    });
    return true;
  }

  private recover() {
    this.store.transaction(() => {
      const usage = this.openAiUsageState();
      // A reader that never recorded a group may own a process the journal cannot name, so it
      // stays unknown. Once every recorded group is absent, the read holds nothing and its
      // observations were never published.
      if (usage && usage.state !== 'quiescent')
        this.saveOpenAiUsage({
          ...usage,
          state:
            usage.groups.length && usage.groups.every((group) => groupAbsent(group))
              ? 'quiescent'
              : 'unknown',
        });
      if (
        usage?.commandId &&
        this.store.receipt(usage.commandId)?.result.reason === 'openai-usage-read-pending'
      )
        this.finishMetadataReceipt(usage.commandId, {
          outcome: this.openAiUsageState()?.state === 'quiescent' ? 'blocked' : 'outcome-unknown',
          reason:
            this.openAiUsageState()?.state === 'quiescent'
              ? 'usage-read-interrupted'
              : 'openai-metadata-ownership-unknown',
        });
      const local = this.localControl();
      if (local.operation)
        this.saveLocal({
          ...local,
          operation: { ...local.operation, state: 'unknown', revoked: true },
        });
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
      for (const group of this.store.combinedGroups()) {
        const manifest = this.combinedManifest(group);
        if (group.integration_maximum_minutes !== (manifest.input.integration?.maximumMinutes ?? 1))
          throw Error('The saved combined integration allowance changed.');
        const journals = this.store.combinedRefIntents(group.run_id);
        const unresolved = journals.some((row) => {
          const journal = CombinedRefJournalSchema.parse(JSON.parse(row.body));
          return (
            row.state === 'unknown' ||
            (row.state === 'prepared' &&
              ((!journal.phases.length && !row.finished_at) ||
                journal.phases.some((phase) => phase.state !== 'quiescent')))
          );
        });
        if (unresolved || (group.integration_active && !journals.length)) {
          this.store.db
            .prepare(
              "UPDATE combined_ref_intents SET state='unknown' WHERE parent_run_id=? AND state='prepared'",
            )
            .run(group.run_id);
          this.updateCombined(group, 'unknown', 'ownership-unknown');
        } else if (group.integration_active) {
          const pending = journals.find((row) => row.state === 'prepared');
          const elapsed = pending
            ? Date.parse(this.now()) - Date.parse(pending.intent_at)
            : group.integration_maximum_minutes * 60000;
          this.store.db
            .prepare(
              'UPDATE combined_groups SET integration_active=0,integration_milliseconds=MIN(integration_maximum_minutes*60000,integration_milliseconds+?) WHERE run_id=?',
            )
            .run(
              Number.isFinite(elapsed) && elapsed >= 0
                ? Math.ceil(elapsed)
                : group.integration_maximum_minutes * 60000,
              group.run_id,
            );
          if (pending?.expected_new && ['assembling', 'blocked'].includes(group.phase))
            this.updateCombined(group, 'assembling');
        }
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
        if (this.recoverLocalWriter(intent, attempt, run, task)) continue;
        const combined = this.store.combinedGroup(run.id);
        if (combined) {
          const phases = this.store.nativeProcesses(attempt.id);
          const key = this.store.receipt(`native-completion:${attempt.id}`)
            ? `native-completion:${attempt.id}`
            : `native-review-completion:${attempt.id}`;
          let quiescent = false;
          try {
            const value = this.nativeRecord(key, 4096).value as {
              attemptId: string;
              quiescent: boolean;
            };
            quiescent =
              value?.attemptId === attempt.id &&
              value.quiescent === true &&
              phases.length > 0 &&
              phases.every((phase) => phase.state === 'quiescent');
          } catch {}
          this.store.put('attempt', attempt.id, attempt.revision + 1, {
            ...attempt,
            state: quiescent ? 'stopped' : 'unknown',
            revision: attempt.revision + 1,
          });
          this.store.db
            .prepare('UPDATE launch_intents SET state=?,finished_at=? WHERE attempt_id=?')
            .run(
              quiescent ? 'stopped' : 'outcome-unknown',
              quiescent ? this.now() : null,
              attempt.id,
            );
          this.store.db
            .prepare(
              "UPDATE combined_dispatches SET state=? WHERE parent_run_id=? AND attempt_id=? AND state='running'",
            )
            .run(quiescent ? 'stopped' : 'unknown', combined.run_id, attempt.id);
          if (quiescent) {
            this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
            this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
          }
          this.updateCombined(
            combined,
            quiescent ? 'blocked' : 'unknown',
            quiescent ? 'stopped' : 'ownership-unknown',
          );
          this.updateTask(task, {
            state: quiescent ? 'interrupted' : 'unknown',
            waitingReason: null,
            next: 'Combined work was interrupted. No owner will relaunch automatically.',
          });
          continue;
        }
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
              journal.roots.every(checkRootQuiescent);
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
                  targetHash: HashSchema.optional(),
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
        // An ACP turn with no terminal proof stays unknown, but not once every group is gone.
        const closed = !stopped && acpKnown === false ? this.shutdownProof(intent) : undefined;
        if (closed) {
          this.settleUnknownWriter(
            intent,
            closed,
            'Controller restarted after every recorded process group exited. The turn has no terminal response.',
          );
          continue;
        }
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
            stopped ? this.shutdownCharge(intent) : null,
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
        !this.candidateCurrent(run, candidate)
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

  private candidateCurrent(run: Run, candidate: Candidate): boolean {
    const group = this.store.combinedGroup(run.id);
    if (group?.run_id === run.id) {
      try {
        this.combinedOrigin(group, candidate);
        return true;
      } catch {
        return false;
      }
    }
    return (
      this.evidence.hash(run.source.base, this.candidateFiles(run, this.writerScratch(run))) ===
      candidate.hash
    );
  }

  private latestCandidate(runId: string): Candidate | undefined {
    const group = this.store.combinedGroup(runId);
    if (group?.run_id === runId)
      return group.final_candidate_id
        ? this.store.get<Candidate>('candidate', group.final_candidate_id)
        : undefined;
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

  // Local and native file writers edit one bounded target in a full copy of the source.
  private singleFileWriter(run: Run): boolean {
    return (
      !!this.store.receipt(`local-prepared:${run.id}`) ||
      (!!this.store.receipt(`native-run:${run.id}`) &&
        !('repository' in this.nativeCurrentPlan(run).appointment))
    );
  }

  private candidateFiles(run: Run, directory: string): FileContent[] {
    if (this.singleFileWriter(run)) return readFiles(directory);
    return readCandidateFiles(
      directory,
      this.projectPath(run.source.projectId) as string,
      run.source.base,
    );
  }

  // Formatting runs once per attempt, after the writer is quiescent and before the attempt settles
  // and its candidate seals, so the hash covers the formatted bytes and observers never see a
  // stopped task without its candidate. The receipt records only writes observed in scratch. The
  // child runs without holding the event loop, and concurrent callers for one attempt share one run.
  private formatAttempt(attempt: Attempt): Promise<void> {
    const running = this.formatting.get(attempt.id);
    if (running) return running.promise;
    const abort = new AbortController();
    const promise = this.formatScratch(attempt, abort.signal)
      .catch(() => {})
      .finally(() => this.formatting.delete(attempt.id));
    this.formatting.set(attempt.id, { promise, abort });
    return promise;
  }

  private async formatScratch(attempt: Attempt, signal: AbortSignal) {
    const key = `formatting:${attempt.id}`;
    // A sealed attempt keeps its bytes. Re-sealing retained scratch never reformats them.
    const settled = () =>
      this.closed || this.store.receipt(key) || this.store.receipt(`candidate:${attempt.id}`);
    const run = this.store.get<Run>('run', attempt.runId) as Run;
    const intent = this.store.intents().find((value) => value.attempt_id === attempt.id);
    if (!intent || settled()) return;
    let files: FileContent[] = [];
    let plan: Awaited<ReturnType<typeof planFormatting>>;
    try {
      files = this.candidateFiles(run, intent.scratch_path);
      plan = this.store.combinedGroup(run.id)
        ? noFormatting('skipped', 'Combined runs check with a recipe that has no formatter.')
        : await planFormatting({
            runtime: runtimeRoot,
            project: this.projectPath(run.source.projectId) as string,
            base: run.source.base,
            files,
            work: join(this.home, 'format'),
            maximumBytes: this.singleFileWriter(run) ? 65_536 : 1024 * 1024,
            signal,
          });
    } catch {
      plan = noFormatting('failed', 'Formatting could not start.');
    }
    if (settled() || signal.aborted) return;
    if (plan.outputs.length && !this.store.receipt(`formatting-plan:${attempt.id}`)) {
      this.store.transaction(() => {
        const artifact = this.nativeArtifact(plan.receipt);
        this.store.saveReceipt(`formatting-plan:${attempt.id}`, artifact.hash, 'local-owner', {
          outcome: 'applied',
          entity: artifact,
        });
      });
    }
    const applied = plan.outputs.length
      ? applyFormatting(intent.scratch_path, files, plan.outputs)
      : [];
    const appliedByPath = new Map(applied.map((file) => [file.path, file]));
    const expectedByPath = new Map(plan.outputs.map((file) => [file.path, file]));
    const allApplied = applied.every((file) => expectedByPath.get(file.path)?.hash === file.hash);
    const receipt = plan.outputs.length
      ? {
          ...plan.receipt,
          status: allApplied ? plan.receipt.status : ('failed' as const),
          reason: allApplied
            ? plan.receipt.reason
            : 'The scratch file changed before formatting was applied.',
          files: plan.receipt.files.filter(
            (file) => appliedByPath.get(file.path)?.hash === file.after,
          ),
        }
      : plan.receipt;
    this.store.transaction(() => {
      const artifact = this.nativeArtifact(receipt);
      this.store.saveReceipt(key, artifact.hash, 'local-owner', {
        outcome: 'applied',
        entity: artifact,
      });
    });
  }

  // Formatting rewrites the writer's bytes once. Its receipt links the writer's hash to the sealed one.
  private writerBytes(attemptId: string, path: string, writerHash: string, sealedHash: string) {
    if (sealedHash === writerHash) return true;
    for (const key of [`formatting:${attemptId}`, `formatting-plan:${attemptId}`]) {
      try {
        if (
          FormattingSchema.parse(this.nativeRecord(key, 65536).value).files.some(
            (file) => file.path === path && file.before === writerHash && file.after === sealedHash,
          )
        )
          return true;
      } catch {}
    }
    return false;
  }

  private sealCandidate(attempt: Attempt, capturedFiles?: FileContent[]): Candidate {
    const run = this.store.get<Run>('run', attempt.runId) as Run;
    if (this.hasUncertainWriter(run.taskId)) throw new Error('Writer ownership is not quiescent.');
    const intent = this.store
      .intents()
      .find((value) => value.attempt_id === attempt.id) as LaunchIntent;
    const files = capturedFiles ?? this.candidateFiles(run, intent.scratch_path);
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
      const group = this.store.combinedGroup(run.id);
      if (group && group.run_id !== run.id) {
        let passed = false;
        try {
          passed =
            this.evaluationOrigin(task.id, captured.candidate.id).writer.id === attempt.id &&
            (group.phase === 'paused'
              ? this.combinedCurrent(group, true).group.paused_phase
              : this.combinedCurrent(group).group.phase) === 'writers';
        } catch {}
        this.store.db
          .prepare(
            "UPDATE combined_dispatches SET state=?,candidate_id=? WHERE parent_run_id=? AND attempt_id=? AND state='running'",
          )
          .run(passed ? 'passed' : 'failed', captured.candidate.id, group.run_id, attempt.id);
        const current = this.store.combinedGroup(group.run_id) as CombinedGroup;
        const stoppedSibling = this.store
          .combinedDispatches(group.run_id)
          .some(
            (slot) =>
              slot.phase.startsWith('writer-') &&
              slot.attempt_id !== attempt.id &&
              slot.state === 'stopped',
          );
        if (
          (!passed || stoppedSibling) &&
          !['stopping', 'stopped', 'unknown', 'paused'].includes(current.phase)
        )
          this.updateCombined(group, 'blocked', 'writers-incomplete');
        else this.updateCombined(group, current.phase, current.blocker);
      }
    });
    this.armQuotaRetries();
    return captured.candidate;
  }

  private checkMatches(
    check: CheckResult,
    candidate: Candidate,
    plan: Pick<CheckDefinition, 'definitionHash' | 'evaluator'> & {
      recipeId?: CheckDefinition['recipeId'];
      combined?: z.infer<typeof CombinedCheckContextSchema>;
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
        combined?: unknown;
      };
      if (
        metadata.candidateId !== candidate.id ||
        metadata.candidateHash !== candidate.hash ||
        metadata.definitionHash !== plan.definitionHash ||
        metadata.evaluator !== plan.evaluator ||
        hashCanonical(metadata.combined ?? null) !== hashCanonical(plan.combined ?? null) ||
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

  private admitJob(
    run: Run,
    attempt: Attempt,
    directory: string,
    maximumMinutes?: number,
    combinedPhase?: CombinedDispatch['phase'],
  ) {
    const localRoute = this.store.get<Route>('route', attempt.routeId);
    if (localRoute?.family === 'local' && !localRoute.fake) {
      const blocker = this.store.localStartBlocker();
      if (blocker) throw Error(blocker);
    }
    const googleBlocker = this.store.googleStartBlocker(attempt.routeId);
    if (googleBlocker) throw new Error(googleBlocker);
    const openAiBlocker = this.openAiUsageBlocker(attempt.routeId);
    if (openAiBlocker) throw Error(openAiBlocker);
    const remaining = this.remaining(run);
    const group = this.store.combinedGroup(run.id);
    if (group) {
      this.combinedCurrent(group);
      const slot = this.store
        .combinedDispatches(group.run_id)
        .find((slot) => slot.phase === combinedPhase);
      if (
        slot?.state !== 'reserved' ||
        maximumMinutes !== slot.maximum_minutes ||
        remaining.minutes < slot.maximum_minutes
      )
        throw Error('The combined job lacks its reserved allowance.');
    }
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
    if (group && combinedPhase)
      this.store.admitCombinedDispatch(group.run_id, combinedPhase, attempt.id);
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
    unknownNext = 'Execution ownership is unknown. Checks and publication are blocked.',
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
      const group = this.store.combinedGroup(run.id);
      if (group) {
        const stopping = ['stopping', 'stopped'].includes(group.phase);
        if (!quiescent || stopping)
          this.store.db
            .prepare(
              "UPDATE combined_dispatches SET state=? WHERE parent_run_id=? AND attempt_id=? AND state IN ('running','unknown')",
            )
            .run(quiescent ? 'stopped' : 'unknown', group.run_id, attempt.id);
        if (!quiescent) this.updateCombined(group, 'unknown', 'ownership-unknown');
      }
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
        if (group) this.refreshCombinedStop(group);
      } else {
        this.event('ownership.unknown', task.id, task.revision, updated);
        this.updateTask(task, {
          state: 'unknown',
          waitingReason: null,
          next: unknownNext,
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
    const boundary = Promise.withResolvers<void>();
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
    const drained = closedBefore(job.closed, boundary.promise);
    const cancelDeadline = schedule(() => {
      timedOut = true;
      job.stop();
      schedule(() => {
        boundary.resolve();
        this.settleJob(attempt, false);
      }, 1000);
    }, deadline());
    const cancel = () => {
      cancelDeadline();
      boundary.resolve();
    };
    this.jobCancels.set(attempt.id, cancel);
    void job.exited
      .then(async (exit) => {
        const quiescent = (await drained) && (await job.quiescent(this.options.schedule));
        cancel();
        if (!this.settleJob(attempt, quiescent)) return;
        if (this.cancelledJobs.has(attempt.id)) {
          this.stoppedJob(attempt);
          return;
        }
        const result = this.evidence.recordCheck({
          candidate,
          plan,
          sourceFiles:
            plan.recipeId === 'project-python-unittest-v1'
              ? committedFiles(this.projectPath(run.source.projectId) as string, run.source.base)
              : undefined,
          passed:
            exit.code === 0 &&
            !job.failed &&
            !timedOut &&
            deadline() > 0 &&
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
        ...('writerAttemptId' in job && job.writerAttemptId
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
    if ('writerAttemptId' in job && job.writerAttemptId) {
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
      ('writerAttemptId' in job &&
        job.writerAttemptId !== undefined &&
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
    const group = this.store.combinedGroup(run.id);
    let combined: ReturnType<Controller['combinedPublicationEvidence']> | undefined;
    if (group?.run_id === run.id) {
      try {
        combined = this.combinedPublicationEvidence(group, candidate);
      } catch {
        return { outcome: 'blocked', reason: 'combined-final-evidence-incomplete' };
      }
    }
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
    if (this.hasUncertainWriter(task.id) || !this.candidateCurrent(run, candidate))
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
    } else if (!combined) {
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
      combined?.attempt ??
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
          !this.candidateCurrent(currentRun, candidate) ||
          hashCanonical(inspectSource(task.projectId, source)) !== hashCanonical(origin.source)
        )
          throw new Error('Prepared publication authority is no longer current.');
        if (native) this.nativePublicationCurrent(currentRun, candidate, native);
        const group = this.store.combinedGroup(currentRun.id);
        if (group?.run_id === currentRun.id) this.combinedPublicationEvidence(group, candidate);
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
        const group = origin ? this.store.combinedGroup(origin.id) : undefined;
        if (belongs && group?.run_id === origin?.id) this.updateCombined(group, 'accepted');
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
      const group = this.store.combinedGroup(run.id);
      if (group?.run_id === run.id) {
        this.combinedOrigin(group, candidate);
        const slot = [...this.store.combinedDispatches(group.run_id)]
          .reverse()
          .find(
            (slot) =>
              ['review', 'final-check', 'replay-1'].includes(slot.phase) && slot.state === 'passed',
          );
        const owner = slot?.attempt_id
          ? this.store.get<Attempt>('attempt', slot.attempt_id)
          : undefined;
        if (!owner || owner.runId !== run.id || owner.state !== 'stopped')
          return { outcome: 'blocked', reason: 'candidate-origin-missing' };
        return this.requestAction(task, run, owner, 'export-patch', task.id, {
          kind: 'export',
          command,
          candidateId: candidate.id,
          candidateHash: candidate.hash,
        });
      }
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

  private projectSource(projectId: string) {
    const key = `project-source:${projectId}`;
    const cached = this.projectionCache?.get(key) as ReturnType<typeof inspectSource> | undefined;
    if (cached) return cached;
    const path = this.projectPath(projectId);
    if (!path) throw Error('Project path is unavailable.');
    const source = inspectSource(projectId, path);
    this.projectionCache?.set(key, source);
    return source;
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
