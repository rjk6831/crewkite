import { arch, cpus, freemem, platform, totalmem } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Artifact,
  ArtifactSchema,
  type Attempt,
  AttemptSchema,
  CandidateSchema,
  type CombinedNativeReviewJob,
  CombinedOriginSchema,
  type Command,
  CommandIdSchema,
  type CommandResult,
  type ConversationModelReason,
  ConversationModelRequestSchema,
  type FakeWorkerEvent,
  GoogleAcpBillingAttestationSchema,
  GoogleAcpSelectionSchema,
  GoogleNativePermissionModeSchema,
  GrantSchema,
  HashSchema,
  LocalAuthModeSchema,
  LocalEndpointSchema,
  type LocalHardwareStatus,
  LocalHardwareStatusSchema,
  LocalModelObservationSchema,
  LocalModelSelectionSchema,
  LocalNativeProfileSchema,
  LocalObservedModelBindingSchema,
  NativeBillingAttestationSchema,
  NativeHandoffTargetSchema,
  NativeProfileSchema,
  NativeRepositoryExecutionSchema,
  NativeRepositoryScopeSchema,
  type NativeReviewJob,
  NativeTargetContextLinesSchema,
  ObservationSchema,
  PolicySchema,
  PrepareCombinedRunPayloadSchema,
  RemainingBudgetsSchema,
  ReviewMethodIdSchema,
  ReviewMethodSchema,
  RevisionSchema,
  RouteSchema,
  type Run,
  RunSchema,
  SealedHandoffPacketSchema,
  TaskIdSchema,
  TaskSchema,
  TimestampSchema,
} from '@crewkite/contracts';
import { z } from 'zod';
import { CheckDefinitionSchema } from '../evidence/index.ts';
import type { ToolchainPreparation } from '../evidence/toolchain-definition.ts';
import type { readFiles } from '../host/source.ts';
import type { OwnedWorker } from '../host/worker.ts';
import type { startReplacement as startAnthropicReplacement } from '../providers/anthropic/replacement.ts';
import { AcpClientPinSchema, AcpSetupProofSchema } from '../providers/google/acp/profile.ts';
import type { AcpWriterCompletion, startGoogleAcpWriter } from '../providers/google/acp/writer.ts';
import type { CapturedContext } from '../providers/google/native-extension/connector.ts';
import type { startGoogleWriter } from '../providers/google/native-writer.ts';
import type { LocalStart } from '../providers/local/profile.ts';
import type { startLocalReplacement } from '../providers/local/replacement.ts';
import { ReplacementPathSchema, type startReplacement } from '../providers/openai/replacement.ts';
import type { startRepository } from '../providers/openai/repository.ts';
import type { ReviewPlan, startReview } from '../providers/openai/review.ts';

// Record schemas, runtime shapes and helpers the controller files share.

// A repository writer leaves this long for the verify check and review that follow it.
export const evaluationFloorMinutes = 11;
// Owned cleanup escalates to SIGKILL within a second. A minute covers a slow host and matches the
// whole-minute granularity of the minute ledger.
export const cleanupReserveMs = 60_000;
export const localHardwareStatus = (sampledAt: string): LocalHardwareStatus => {
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
export const nativeProviderRestriction: CommandResult = {
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
export const CombinedManifestSchema = z.strictObject({
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
export type CombinedManifest = z.infer<typeof CombinedManifestSchema>;
export const CombinedRefJournalSchema = z.strictObject({
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

export const NativeFileAppointmentSchema = z.strictObject({
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
export const NativeAcpAppointmentSchema = NativeFileAppointmentSchema.extend({
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
export const NativeAppointmentSchema = z.union([
  NativeFileAppointmentSchema,
  NativeRepositoryAppointmentSchema,
  NativeAcpAppointmentSchema,
]);
export type NativePilotAppointment = z.infer<typeof NativeAppointmentSchema>;
export const NativePublicScopeSchema = z.strictObject({
  profileId: z.string().min(1).max(200),
  locationHash: HashSchema,
  scopeHash: HashSchema,
  manualTargetsHash: HashSchema.optional(),
  context: z.strictObject({
    title: z.string().min(1).max(200),
    outcome: z.string().min(1).max(4096),
  }),
});
export const NativeHistoricalPreparationSchema = z
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
export const NativePreparationSchema = NativeHistoricalPreparationSchema.safeExtend({
  public: NativePublicScopeSchema,
});
export type NativeBinding = {
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
export const NativeManualRosterSchema = z.strictObject({
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
export const NativeManualPreparationSchema = z.strictObject({
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
export const NativeManualLinkSchema = z.strictObject({
  preparationId: ArtifactSchema.shape.id,
  preparation: NativeManualPreparationSchema,
});
export const EvaluationConsentSchema = z.strictObject({
  scopeHash: HashSchema,
  expiresAt: TimestampSchema,
});
export const CandidateEvaluationSchema = z
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
export const CombinedEvaluationSchema = z.strictObject({
  ...combinedEvaluationShape,
  origin: CombinedOriginSchema,
  maximumCheckMinutes: z.literal(1),
});
export type PreparedVerification = ToolchainPreparation & {
  lineageHash: string;
  sourcePath: string;
};
export type NativeOutcome = {
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

export const nativeFailureNext = (outcome: NativeOutcome | null) => {
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
export const NativeQuotaCompletionSchema = z.strictObject({
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
export type AcpSetupCommand = Extract<
  Command,
  {
    command:
      | 'InitializeGoogleAcp'
      | 'AuthenticateGoogleAcp'
      | 'DiscoverGoogleAcp'
      | 'StopGoogleAcpSetup';
  }
>;
export type NativeRuntime = {
  kind: 'native';
  binding: NativeBinding;
  stopped: boolean;
  handle?: { result: Promise<NativeOutcome>; stop: () => void };
  done?: Promise<void>;
  reason?: 'handoff' | 'stop' | 'switch';
  acpHandle?: ReturnType<typeof startGoogleAcpWriter>;
};
export type NativeReviewRuntime = {
  preparation: Artifact;
  job: NativeReviewJob | CombinedNativeReviewJob;
  input: ReviewPlan;
  attempt: Attempt;
  stopped: boolean;
  handle?: ReturnType<typeof startReview>;
  done: Promise<void>;
};
export type FakeRuntime = {
  kind: 'fake';
  worker: OwnedWorker;
  terminal?: Extract<FakeWorkerEvent, { type: 'terminal' }>;
  reason?: 'handoff' | 'stop' | 'switch';
  failure?: string;
  cancel?: () => void;
};
export function freezeNative<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeNative(child);
    Object.freeze(value);
  }
  return value;
}

export type ConversationModelFailureReason = Exclude<
  ConversationModelReason,
  'available' | 'not-observed'
>;
const LocalOperationBindingSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  operationId: CommandIdSchema,
  nonce: HashSchema,
  connectionHash: HashSchema,
  connectionRevision: RevisionSchema,
});
export const LocalControlSchema = z.strictObject({
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
export type LocalControl = z.infer<typeof LocalControlSchema>;
export type LocalOperationRuntime = {
  operationId: string;
  stopped: boolean;
  handle?: { stop: () => void };
  done: Promise<void>;
};
export type LocalSecretCell = {
  connectionRevision: number;
  connectionHash: string;
  secret: Buffer;
};
export const LocalPreparedSchema = z.strictObject({
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
export type LocalPrepared = z.infer<typeof LocalPreparedSchema>;
export type EvaluationWriterPreparation =
  | LocalPrepared
  | z.infer<typeof NativeHistoricalPreparationSchema>;
export const ProviderUsageBatchSchema = z.strictObject({
  mode: z.enum(['partial', 'complete']),
  observedAt: TimestampSchema,
  observations: z.array(ObservationSchema).min(1).max(32),
});
export const ProviderUsageDraftSchema = z.object({
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
export const OpenAiUsageReadSchema = z.strictObject({
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
/**
 * The last chat model read. A group stays listed until it exits or a later check finds it gone,
 * so a crash mid-read leaves the evidence for the next one.
 */
export const ChatModelReadSchema = z.strictObject({
  version: z.literal(1),
  attemptedAt: TimestampSchema,
  groups: z.array(z.number().int().positive().safe()).max(2),
  reason: z.string().min(1).max(400).nullable(),
});
export type LocalWriterRuntime = {
  plan: LocalPrepared;
  binding: LocalStart['binding'];
  stopped: boolean;
  handle?: ReturnType<typeof startLocalReplacement>;
  done: Promise<void>;
};

export const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
export const runtimeRoot = fileURLToPath(new URL('../../../../', import.meta.url));
