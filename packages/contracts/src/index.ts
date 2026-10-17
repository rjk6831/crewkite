import { z } from 'zod';
import { canonicalJson } from './canonical.ts';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
const text = z.string().min(1).max(4096);
const label = z.string().min(1).max(200);
export const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const MinorAmountSchema = RevisionSchema;
export const CursorSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimestampSchema = z.iso.datetime();
const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
export const ProjectIdSchema = id('prj');
export const TaskIdSchema = id('tsk');
export const RunIdSchema = id('run');
export const AttemptIdSchema = id('att');
export const RouteIdSchema = id('rte');
export const ApprovalIdSchema = id('apr');
export const ArtifactIdSchema = id('art');
export const CandidateIdSchema = id('cnd');
export const HandoffIdSchema = id('hnd');
export const EventIdSchema = id('evt');
export const CommandIdSchema = id('cmd');
export const MessageIdSchema = id('msg');
const RelativeSourcePathSchema = text.refine(
  (path) =>
    !path.startsWith('/') &&
    !/^[a-z]:/i.test(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'),
  'Source detail needs a relative repository path.',
);
export const NativeTargetPathSchema = RelativeSourcePathSchema.refine(
  (value) => value.isWellFormed() && !/\p{Cc}/u.test(value),
  'A replacement needs a relative path without control characters.',
);
export const ProjectNodeTestPathSchema = NativeTargetPathSchema.refine(
  (path) => !path.startsWith('-') && !/[?*[\]{}]/.test(path),
  'Node tests need exact relative file paths without options or globs.',
);
export const ProjectNodeTestFilesSchema = z
  .array(ProjectNodeTestPathSchema)
  .min(1)
  .max(32)
  .refine((paths) => new Set(paths).size === paths.length, 'Node test files must be distinct.');
const OpenAiNativeProfileSchema = z.strictObject({
  id: label,
  family: z.literal('openai'),
  displayName: label,
  clientVersion: label,
  model: label,
  effort: z.literal('low'),
  accountClass: z.literal('pro'),
  serviceTier: z.literal('default'),
  qualifiedAt: z.iso.date(),
  creditPolicies: z
    .array(z.enum(['ordinary', 'existing-credits']))
    .min(1)
    .max(2),
  maximumTaskMs: z.literal(300000),
  maximumFileBytes: z.literal(65536),
  maximumSubmissions: z.literal(1),
  available: z.boolean(),
  reason: z.enum([
    'available',
    'not-configured',
    'unsupported-platform',
    'native-home-unavailable',
    'configuration-location-unsupported',
    'client-unavailable',
    'client-build-mismatch',
  ]),
});
export const NativeRepositoryExecutionSchema = z.strictObject({
  sandbox: z.literal('workspace-write'),
  approvalPolicy: z.literal('never'),
  networkAccess: z.literal(false),
});
export const NativeRepositoryScopeSchema = z.strictObject({
  sourceBase: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  manifestHash: HashSchema,
  files: RevisionSchema.max(10000),
  bytes: RevisionSchema.max(64 * 1024 * 1024),
});
export const NativeRepositoryProfileSchema = OpenAiNativeProfileSchema.omit({
  id: true,
  qualifiedAt: true,
  maximumFileBytes: true,
  reason: true,
}).extend({
  id: z.literal('openai-repository-v1'),
  qualifiedAt: z.iso.date().nullable(),
  maximumSourceFiles: z.literal(10000),
  maximumSourceBytes: z.literal(67108864),
  execution: NativeRepositoryExecutionSchema,
  reason: z.enum([...OpenAiNativeProfileSchema.shape.reason.options, 'qualification-pending']),
});
export const NativeBillingAttestationSchema = z.strictObject({
  source: z.literal('user-attested'),
  subscriptionLoginConfirmed: z.literal(true),
  paidExtraUsageDisabled: z.literal(true),
});
export const AnthropicNativeProfileSchema = z.strictObject({
  id: z.literal('anthropic-file-v1'),
  family: z.literal('anthropic'),
  displayName: label,
  clientVersion: label,
  model: label,
  effort: z.literal('medium'),
  effectiveEffort: z.literal('unknown'),
  accountClass: z.literal('unknown'),
  serviceTier: z.literal('unknown'),
  billingBasis: z.literal('requires-user-attestation'),
  qualifiedAt: z.iso.date().nullable(),
  creditPolicies: z.tuple([z.literal('ordinary')]),
  maximumTaskMs: z.literal(300000),
  maximumFileBytes: z.literal(65536),
  maximumSubmissions: z.literal(1),
  available: z.boolean(),
  reason: z.enum([...OpenAiNativeProfileSchema.shape.reason.options, 'qualification-pending']),
});
export const GoogleNativePermissionModeSchema = z.enum([
  'request-review',
  'strict',
  'always-proceed',
  'proceed-in-sandbox',
]);
export const GoogleNativeProfileSchema = AnthropicNativeProfileSchema.omit({
  id: true,
  family: true,
  effort: true,
}).extend({
  id: z.literal('google-file-v1'),
  family: z.literal('google'),
  effort: z.literal('low'),
  reason: z.enum([
    ...AnthropicNativeProfileSchema.shape.reason.options,
    'provider-policy-restricted',
  ]),
  permissionModes: z.tuple([
    z.literal('request-review'),
    z.literal('strict'),
    z.literal('always-proceed'),
    z.literal('proceed-in-sandbox'),
  ]),
});
const localIdentifier = label.refine(
  (value) => value.isWellFormed() && !/\p{Cc}/u.test(value),
  'A Local model identifier cannot contain control characters.',
);
const localText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value.isWellFormed() &&
        !/\p{Cc}/u.test(value) &&
        new TextEncoder().encode(value).length <= max,
      'Local metadata needs bounded ordinary text.',
    );
export const LocalRuntimeIdentitySchema = z.strictObject({
  connectorId: z.literal('local-sdk-v1'),
  version: localText(128),
  build: RevisionSchema,
});
export const LocalModelIdentitySchema = z.strictObject({
  modelKey: localText(200),
  displayName: localText(200),
  format: localText(64),
  sizeBytes: RevisionSchema.min(1),
  quantization: z
    .strictObject({ name: localText(64), bits: RevisionSchema.min(1).max(64) })
    .nullable(),
  selectedVariant: localText(200).nullable(),
  metadataHash: HashSchema,
});
export const LocalModelChoiceSchema = z
  .strictObject({
    selectionId: HashSchema,
    identity: LocalModelIdentitySchema,
    instanceReference: localText(200).nullable(),
    contextLength: RevisionSchema.min(1).nullable(),
    state: z.enum(['installed-unloaded', 'loaded-eligible', 'incompatible']),
    reasons: z
      .array(
        z.enum([
          'unsupported-format',
          'remote-model',
          'identity-ambiguous',
          'multiple-resident-models',
          'resident-embedding',
          'busy',
          'context',
          'draft',
          'not-downloaded',
        ]),
      )
      .max(8)
      .refine((values) => new Set(values).size === values.length),
    qualification: z.literal('unqualified'),
  })
  .refine(
    (choice) =>
      choice.state === 'installed-unloaded'
        ? choice.instanceReference === null &&
          choice.contextLength === null &&
          choice.reasons.length === 0
        : choice.state === 'loaded-eligible'
          ? choice.instanceReference !== null &&
            choice.contextLength === 8192 &&
            ['gguf', 'safetensors'].includes(choice.identity.format) &&
            choice.reasons.length === 0
          : choice.reasons.length > 0,
    'Local model state needs its observed instance and finite compatibility reasons.',
  );
const localProjectionFits = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= 128 * 1024;
export const LocalModelObservationSchema = z
  .strictObject({
    version: z.literal(1),
    runtime: LocalRuntimeIdentitySchema,
    observationHash: HashSchema,
    models: z.array(LocalModelChoiceSchema).max(64),
    residentLlms: RevisionSchema.max(8),
    embeddingInstances: RevisionSchema.max(8),
  })
  .refine((value) => {
    const handles = value.models.flatMap((model) =>
      model.instanceReference === null ? [] : [model.instanceReference],
    );
    return (
      new Set(value.models.map((model) => model.selectionId)).size === value.models.length &&
      new Set(handles).size === handles.length &&
      handles.length <= value.residentLlms &&
      (!value.models.some((model) => model.state === 'loaded-eligible') ||
        (value.residentLlms === 1 && value.embeddingInstances === 0)) &&
      localProjectionFits(value)
    );
  }, 'Local discovery needs distinct choices within its handle and byte bounds.');
export const LocalModelSelectionSchema = z.strictObject({
  selectionId: HashSchema,
  observationHash: HashSchema,
});
const legacyLocalModelBinding = z.strictObject({
  setupHash: HashSchema,
  modelKey: localIdentifier,
  instanceReference: localIdentifier,
  modelSizeBytes: RevisionSchema.min(1),
  artifactSha256: HashSchema,
  quantization: z.literal('Q4_K_M'),
});
export const LocalObservedModelBindingSchema = z.strictObject({
  version: z.literal(2),
  identityKind: z.literal('runtime-metadata'),
  setupHash: HashSchema,
  connectionHash: HashSchema,
  connectionRevision: RevisionSchema,
  connectorId: z.literal('local-sdk-v1'),
  runtimeVersion: localText(128),
  runtimeBuild: RevisionSchema,
  modelKey: localText(200),
  instanceReference: localText(200),
  modelSizeBytes: RevisionSchema.min(1),
  format: z.enum(['gguf', 'safetensors']),
  metadataHash: HashSchema,
});
export const LocalModelBindingSchema = z.union([
  legacyLocalModelBinding,
  LocalObservedModelBindingSchema,
]);
export const LocalEndpointSchema = z
  .string()
  .regex(/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/)
  .refine(
    (value) => value.trim() === value && Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535,
    'A Local endpoint needs a literal loopback address and valid port.',
  );
export const LocalSetupReceiptSchema = z.strictObject({
  version: z.literal(1),
  runtimeVersion: localIdentifier,
  artifactSha256: HashSchema,
  artifactSizeBytes: RevisionSchema.min(1),
  quantization: localIdentifier,
  model: z.strictObject({
    modelKey: localIdentifier,
    instanceReference: localIdentifier,
    modelSizeBytes: RevisionSchema.min(1),
  }),
  contextLength: RevisionSchema.min(1),
  residentLlms: RevisionSchema,
  embeddingInstances: RevisionSchema,
  draftModel: z.union([z.literal(''), localIdentifier]),
});
const localOperationFields = {
  operationId: CommandIdSchema,
  state: z.enum(['intent', 'owned', 'stopping', 'unknown']),
};
export const LocalOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...localOperationFields, kind: z.literal('input') }),
  z.strictObject({ ...localOperationFields, kind: z.literal('discovery') }),
]);
export const LocalSetupSchema = z
  .strictObject({
    revision: RevisionSchema,
    connectionRevision: RevisionSchema,
    connectorId: z.literal('local-sdk-v1'),
    endpoint: LocalEndpointSchema.nullable(),
    setupHash: HashSchema.nullable(),
    connectionHash: HashSchema.nullable(),
    secretConfigured: z.boolean(),
    operation: LocalOperationSchema.nullable(),
    generation: z.enum(['idle', 'active', 'unknown']),
    observation: LocalModelObservationSchema.nullable(),
    selection: LocalModelSelectionSchema.nullable(),
    reason: z
      .enum([
        'unconfigured',
        'connection-required',
        'input-active',
        'input-unknown',
        'discovery-required',
        'discovery-active',
        'discovery-unknown',
        'model-selection-required',
        'model-unloaded',
        'model-incompatible',
        'selection-stale',
        'generation-active',
        'generation-unknown',
        'capability-unavailable',
        'setup-unavailable',
        'qualification-pending',
      ])
      .nullable(),
  })
  .refine(
    (setup) =>
      setup.endpoint === null
        ? setup.setupHash === null &&
          setup.connectionHash === null &&
          !setup.secretConfigured &&
          !setup.operation &&
          !setup.observation &&
          !setup.selection
        : setup.connectionHash !== null,
    'A Local configuration needs its endpoint and exact setup identity.',
  )
  .refine(
    (setup) =>
      setup.selection === null
        ? setup.setupHash === null
        : setup.setupHash !== null &&
          setup.observation !== null &&
          (setup.reason === 'selection-stale' ||
            (setup.selection.observationHash === setup.observation.observationHash &&
              setup.observation.models.some(
                (model) => model.selectionId === setup.selection?.selectionId,
              ))),
    'A selected Local setup needs its retained observation and choice identity.',
  )
  .refine(localProjectionFits, 'Local setup exceeds its encoded byte bound.');
export type LocalSetup = z.infer<typeof LocalSetupSchema>;
export const LocalNativeProfileSchema = z
  .strictObject({
    id: z.literal('local-file-v1'),
    family: z.literal('local'),
    displayName: label,
    sdkVersion: z.literal('2.1.0'),
    model: label,
    modelBinding: LocalModelBindingSchema.nullable(),
    billing: z.literal('local'),
    contextLength: z.literal(8192),
    maximumOutputTokens: z.literal(2048),
    qualifiedAt: z.iso.date().nullable(),
    maximumTaskMs: z.literal(300000),
    maximumFileBytes: z.literal(65536),
    maximumSubmissions: z.literal(1),
    available: z.boolean(),
    reason: z.enum([
      'available',
      'not-configured',
      'unsupported-platform',
      'connection-unavailable',
      'model-setup-unavailable',
      'qualification-pending',
    ]),
  })
  .refine(
    (profile) =>
      profile.available
        ? !!profile.modelBinding && ['available', 'qualification-pending'].includes(profile.reason)
        : profile.reason !== 'available',
    'An available Local profile needs its model binding and current availability.',
  )
  .refine(
    (profile) => !profile.modelBinding || profile.model === profile.modelBinding.modelKey,
    'A Local profile must name its bound model.',
  );
const acpIdentifier = label.refine(
  (value) => value.isWellFormed() && !/\p{Cc}/u.test(value),
  'Protocol identifiers must contain ordinary text.',
);
export const AcpConfigSelectionSchema = z
  .strictObject({
    optionId: acpIdentifier,
    currentValue: acpIdentifier,
    supported: z.array(acpIdentifier).min(1).max(32),
  })
  .refine(
    (value) =>
      new Set(value.supported).size === value.supported.length &&
      value.supported.includes(value.currentValue),
    'The current selection must be one of the distinct advertised values.',
  );
export const GoogleAcpConfigurationSchema = z.strictObject({
  model: AcpConfigSelectionSchema,
  thoughtLevel: AcpConfigSelectionSchema.nullable(),
});
export const GoogleAcpCapabilitiesSchema = z.strictObject({
  protocolVersion: z.literal(1),
  authMethods: z.array(z.literal('oauth-personal')).max(1),
  sessionClose: z.boolean(),
  // These describe the client posture. Native tools can still access their own resources.
  fs: z.literal(false),
  terminal: z.literal(false),
});
export const GoogleAcpReasonSchema = z.enum([
  ...GoogleNativeProfileSchema.shape.reason.options,
  'acp-capability-missing',
  'auth-method-mismatch',
  'authentication-required',
]);
export const GoogleAcpProfileSchema = GoogleNativeProfileSchema.omit({
  id: true,
  effort: true,
  reason: true,
  permissionModes: true,
})
  .extend({
    id: z.literal('google-acp-v1'),
    effort: acpIdentifier,
    effortSupported: z.array(acpIdentifier).max(32),
    configOptions: GoogleAcpConfigurationSchema.nullable(),
    capabilities: GoogleAcpCapabilitiesSchema.nullable(),
    permissionModes: z
      .array(GoogleNativePermissionModeSchema)
      .length(1)
      .refine((modes) => modes[0] === 'request-review'),
    reason: GoogleAcpReasonSchema,
  })
  .refine((profile) => {
    const configuration = profile.configOptions;
    const thought = configuration?.thoughtLevel;
    return (
      (configuration
        ? profile.model === configuration.model.currentValue
        : profile.model === 'unknown') &&
      (thought
        ? profile.effort === thought.currentValue &&
          JSON.stringify(profile.effortSupported) === JSON.stringify(thought.supported)
        : profile.effort === 'unknown' && profile.effortSupported.length === 0)
    );
  }, 'Model and effort facts must match the observed configuration.')
  .refine(
    (profile) =>
      !profile.available ||
      (!!profile.configOptions &&
        !!profile.capabilities?.authMethods.includes('oauth-personal') &&
        ['available', 'qualification-pending'].includes(profile.reason)),
    'An available client needs compatible observed configuration and capabilities.',
  )
  .refine((profile) => profile.reason !== 'available' || profile.available);
export const NativeProfileSchema = z.union([
  OpenAiNativeProfileSchema.refine(
    (profile) => !['openai-repository-v1', 'google-acp-v1', 'local-file-v1'].includes(profile.id),
  ),
  AnthropicNativeProfileSchema,
  GoogleNativeProfileSchema,
  NativeRepositoryProfileSchema,
  GoogleAcpProfileSchema,
  LocalNativeProfileSchema,
]);
export const GoogleAcpBillingAttestationSchema = NativeBillingAttestationSchema.extend({
  quotaAccountConfirmed: z.literal(true),
});
export const GoogleAcpSelectionSchema = z.strictObject({
  proofId: ArtifactIdSchema,
  modelId: acpIdentifier,
  thoughtLevelId: acpIdentifier.nullable(),
});
export const GoogleAcpSetupSchema = z
  .strictObject({
    profileId: z.literal('google-acp-v1'),
    revision: RevisionSchema,
    state: z.enum([
      'uninitialized',
      'initializing',
      'authentication-required',
      'authenticating',
      'discovering',
      'ready',
      'stopping',
      'blocked',
      'unknown',
    ]),
    operationId: CommandIdSchema.nullable(),
    proofId: ArtifactIdSchema.nullable(),
    client: z
      .strictObject({ version: label, sha256: HashSchema, signerTeamId: acpIdentifier })
      .nullable(),
    auth: z.strictObject({
      method: z.literal('oauth-personal').nullable(),
      status: z.enum(['unknown', 'required', 'authenticated']),
    }),
    reason: GoogleAcpReasonSchema.nullable(),
  })
  .refine(
    (setup) =>
      !['initializing', 'authenticating', 'discovering', 'stopping'].includes(setup.state) ||
      !!setup.operationId,
    'An active setup operation needs its command identity.',
  )
  .refine(
    (setup) => setup.auth.status === 'unknown' || setup.auth.method === 'oauth-personal',
    'An authentication result needs its exact method.',
  )
  .refine(
    (setup) =>
      setup.state !== 'ready' ||
      (!setup.operationId &&
        !!setup.client &&
        !!setup.proofId &&
        setup.auth.status === 'authenticated'),
    'Ready setup needs a retained client proof and completed authentication.',
  );
export const NativeFileProfileIdSchema = z.enum([
  'openai-file-v1',
  'anthropic-file-v1',
  'google-file-v1',
]);
export const NativeHandoffTargetSchema = z
  .strictObject({
    profileId: NativeFileProfileIdSchema,
    creditPolicy: z.enum(['ordinary', 'existing-credits']).default('ordinary'),
  })
  .refine(
    (target) => target.profileId === 'openai-file-v1' || target.creditPolicy === 'ordinary',
    'This recipient supports ordinary subscription usage only.',
  );
export const NativeHandoffTargetsSchema = z
  .array(NativeHandoffTargetSchema)
  .min(1)
  .max(3)
  .refine(
    (targets) => new Set(targets.map((target) => target.profileId)).size === targets.length,
    'Manual handoff recipients must be distinct.',
  );
const nativeHandoffAvailability = z
  .strictObject({
    available: z.boolean(),
    reason: z.enum([
      'available',
      'writer-active',
      'ownership-unknown',
      'source-changed',
      'retained-work-unavailable',
      'recipient-unavailable',
      'authority-unavailable',
      'budget-exhausted',
      'admissions-paused',
      'already-started',
    ]),
  })
  .refine((value) => value.available === (value.reason === 'available'));
export const NativeHandoffPreviewSchema = z
  .strictObject({
    targets: NativeHandoffTargetsSchema,
    currentAttemptId: AttemptIdSchema,
    generation: RevisionSchema,
    prepare: nativeHandoffAvailability,
    pending: z
      .strictObject({
        preparationId: ArtifactIdSchema,
        packetId: HandoffIdSchema,
        fromAttemptId: AttemptIdSchema,
        generation: RevisionSchema,
        recipient: NativeHandoffTargetSchema,
        baseHash: HashSchema,
        bytes: RevisionSchema.max(65536),
        expiresAt: TimestampSchema,
        start: nativeHandoffAvailability,
      })
      .optional(),
  })
  .refine(
    ({ targets, currentAttemptId, generation, pending }) =>
      !pending ||
      (pending.fromAttemptId === currentAttemptId &&
        pending.generation === generation + 1 &&
        targets.some(
          (target) =>
            target.profileId === pending.recipient.profileId &&
            target.creditPolicy === pending.recipient.creditPolicy,
        )),
    'The pending handoff must select a saved recipient and the next writer generation.',
  );
export const NativeRunSchema = z
  .strictObject({
    runId: RunIdSchema,
    profileId: label,
    billingAttestation: z
      .union([NativeBillingAttestationSchema, GoogleAcpBillingAttestationSchema])
      .optional(),
    permissionMode: GoogleNativePermissionModeSchema.optional(),
    stage: z.enum(['prepared', 'retain-only']),
    expiresAt: TimestampSchema.optional(),
    handoff: NativeHandoffPreviewSchema.optional(),
    repository: NativeRepositoryScopeSchema.optional(),
    execution: NativeRepositoryExecutionSchema.optional(),
    target: z
      .strictObject({
        path: NativeTargetPathSchema,
        baseHash: HashSchema,
        bytes: RevisionSchema.max(65536),
      })
      .optional(),
    acp: GoogleAcpSelectionSchema.optional(),
    localModel: LocalModelBindingSchema.optional(),
  })
  .refine(
    (run) =>
      run.profileId === 'google-acp-v1'
        ? !!run.acp &&
          !!run.target &&
          !!run.billingAttestation &&
          'quotaAccountConfirmed' in run.billingAttestation &&
          run.permissionMode === 'request-review' &&
          !run.handoff &&
          !run.repository &&
          !run.execution
        : !run.acp &&
          !(run.billingAttestation && 'quotaAccountConfirmed' in run.billingAttestation),
    'An ACP run needs its selected proof, target and separate account attestation.',
  )
  .refine(
    (run) =>
      run.profileId === 'openai-repository-v1'
        ? !!run.repository &&
          !!run.execution &&
          !run.target &&
          !run.billingAttestation &&
          !run.permissionMode &&
          !run.handoff
        : !run.repository && !run.execution,
    'A repository run needs its complete source scope and native execution profile.',
  )
  .refine((run) => !run.handoff || NativeFileProfileIdSchema.safeParse(run.profileId).success)
  .refine(
    (run) =>
      run.profileId === 'local-file-v1'
        ? !!run.localModel &&
          !!run.target &&
          !run.billingAttestation &&
          !run.permissionMode &&
          !run.handoff
        : !run.localModel,
    'A Local file run needs its model binding and target without cloud account fields.',
  );

export const FamilySchema = z.enum(['openai', 'anthropic', 'google', 'local']);
export const TaskStateSchema = z.enum([
  'draft',
  'running',
  'waiting',
  'handing_off',
  'stopping',
  'stopped',
  'interrupted',
  'unknown',
  'checking',
  'ready',
  'accepted',
  'failed',
]);
export const WaitingReasonSchema = z.enum(['approval', 'capacity', 'dependency']);
export const OutcomeSchema = z.enum([
  'applied',
  'already-applied',
  'stale-revision',
  'denied',
  'unsupported',
  'blocked',
  'outcome-unknown',
]);
export const RoleNameSchema = z.enum([
  'lead',
  'orchestrator',
  'coder',
  'reviewer',
  'advisor',
  'overseer',
]);
export const SpeedSchema = z.enum(['normal', 'fast']);
export const RouteSpeedSchema = z
  .strictObject({
    requested: SpeedSchema,
    effective: SpeedSchema.nullable(),
    supported: z.array(SpeedSchema).max(2),
  })
  .refine(
    (speed) =>
      new Set(speed.supported).size === speed.supported.length &&
      (speed.effective === null || speed.supported.includes(speed.effective)),
    'Effective speed needs exact route support.',
  );
export const RouteSchema = z
  .strictObject({
    id: RouteIdSchema,
    family: FamilySchema,
    displayName: label,
    model: label,
    effort: z.strictObject({
      requested: label,
      effective: label,
      supported: z.array(label).max(32),
    }),
    speed: RouteSpeedSchema.optional(),
    billing: z.enum(['included', 'credits', 'local']),
    qualified: z.boolean(),
    fake: z.boolean(),
  })
  .refine(
    (route) =>
      !route.qualified ||
      !route.speed ||
      (route.speed.effective === route.speed.requested &&
        route.speed.supported.includes(route.speed.requested)),
    'A qualified speed variant must fulfill its exact requested speed.',
  );
export const ObservationSchema = z
  .strictObject({
    routeId: RouteIdSchema,
    windowId: label,
    kind: z.enum(['rolling', 'weekly', 'model', 'pool', 'local']),
    semantics: z
      .strictObject({
        scope: z.enum(['provider', 'model', 'pool']),
        periodSeconds: z.number().int().positive().max(31536000).optional(),
      })
      .optional(),
    remaining: z
      .strictObject({
        value: z.number().finite().nonnegative(),
        unit: z.enum(['percent', 'tokens', 'requests', 'credits', 'minutes']),
      })
      .nullable(),
    resetsAt: TimestampSchema.nullable(),
    observedAt: TimestampSchema,
    source: z.enum(['provider', 'client', 'local-counter', 'manual', 'fixture']),
    confidence: z.enum(['reported', 'estimated', 'inferred']),
  })
  .superRefine((value, context) => {
    if (value.remaining?.unit === 'percent' && value.remaining.value > 100) {
      context.addIssue({
        code: 'custom',
        message: 'A percentage cannot exceed 100.',
        path: ['remaining', 'value'],
      });
    }
  });
export const WindowStateSchema = z.enum(['fresh', 'stale', 'unknown', 'reset-pending']);
export const WindowSchema = z.strictObject({
  observation: ObservationSchema,
  state: WindowStateSchema,
});
export const UsageReaderSchema = z
  .strictObject({
    id: z.literal('google-usage-v1'),
    family: z.literal('google'),
    clientVersion: label,
    available: z.boolean(),
    reason: z.enum([
      'available',
      'unsupported-platform',
      'native-home-unavailable',
      'client-unavailable',
      'client-build-mismatch',
    ]),
    lastObservedAt: TimestampSchema.nullable(),
    lastAttemptAt: TimestampSchema.nullable().optional(),
  })
  .refine(
    (reader) => reader.available === (reader.reason === 'available'),
    'Reader availability must match its client status.',
  );
export const RoleSchema = z.strictObject({
  role: RoleNameSchema,
  routeId: RouteIdSchema,
  pinned: z.boolean(),
  approvedFallbacks: z.array(RouteIdSchema).max(32),
  selection: z.enum(['ordered', 'reset-aware']).optional(),
});
export const EffectSchema = z.strictObject({
  action: z.enum([
    'read-source',
    'write-scratch',
    'run-native-tools',
    'run-check',
    'run-review',
    'accept-candidate',
    'export-patch',
  ]),
  target: text,
});
export const GrantSchema = EffectSchema.extend({
  taskId: TaskIdSchema,
  expiresAt: TimestampSchema,
  revoked: z.boolean(),
  usesRemaining: z.union([z.literal(0), z.literal(1)]),
});
export const RemainingBudgetsSchema = z.strictObject({
  attempts: RevisionSchema,
  minutes: RevisionSchema,
  concurrency: RevisionSchema,
});
export const LimitsSchema = z.strictObject({
  attempts: z.number().int().min(1).max(100),
  minutes: z.number().int().min(1).max(1440),
  concurrency: z.number().int().min(1).max(16),
});
export const ReserveSchema = z.strictObject({
  routeId: RouteIdSchema,
  windowId: label,
  value: z.number().finite().nonnegative(),
  unit: z.enum(['percent', 'tokens', 'requests', 'credits', 'minutes']),
});
export const FixedAllowanceSchema = z.strictObject({
  launches: z.number().int().nonnegative().max(100),
  minutes: z.number().int().nonnegative().max(1440),
});
export const UnknownUsagePolicySchema = z.discriminatedUnion('rule', [
  z.strictObject({ rule: z.literal('fixed-allowance'), allowance: FixedAllowanceSchema }),
  z.strictObject({ rule: z.literal('manual'), approvedRouteIds: z.array(RouteIdSchema).max(32) }),
  z.strictObject({ rule: z.literal('waiting') }),
]);
export const GuidanceSchema = z.strictObject({ goal: text, principles: z.array(text).max(16) });
export const ReviewMethodIdSchema = z.enum([
  'keep-it-simple',
  'challenge-assumptions',
  'second-opinion',
  'round-robin',
]);
export const ReviewTargetSchema = z.strictObject({
  methodId: ReviewMethodIdSchema,
  cycle: z.number().int().min(1).max(3),
});
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;
export function formatReviewTarget(value: ReviewTarget): string {
  const target = ReviewTargetSchema.parse(value);
  return `${target.methodId}/cycle-${target.cycle}`;
}
export function parseReviewTarget(value: unknown): ReviewTarget | null {
  if (typeof value !== 'string') return null;
  const match = /^([^/]+)\/cycle-([1-3])$/.exec(value);
  if (!match) return null;
  const parsed = ReviewTargetSchema.safeParse({ methodId: match[1], cycle: Number(match[2]) });
  return parsed.success && formatReviewTarget(parsed.data) === value ? parsed.data : null;
}
export const QualitySchema = z.enum(['quick', 'standard', 'thorough']);
export function requiredReviewMethodIds(
  quality: z.infer<typeof QualitySchema>,
): z.infer<typeof ReviewMethodIdSchema>[] {
  const methods: z.infer<typeof ReviewMethodIdSchema>[] = ['keep-it-simple'];
  if (QualitySchema.parse(quality) !== 'quick') methods.push('second-opinion');
  if (quality === 'thorough') methods.push('challenge-assumptions');
  return methods;
}
export const ReviewMethodSchema = z.strictObject({
  id: ReviewMethodIdSchema,
  cycles: z.number().int().min(1).max(3),
  reviewerRole: z.enum(['reviewer', 'advisor']),
});
const reviewMethods = z
  .array(ReviewMethodSchema)
  .max(4)
  .refine(
    (methods) => new Set(methods.map((method) => method.id)).size === methods.length,
    'Review methods must be unique.',
  );

export const PolicySchema = z.strictObject({
  authority: z.enum(['guided', 'balanced', 'autopilot']),
  quality: QualitySchema,
  effects: z.array(GrantSchema).max(100),
  limits: LimitsSchema,
  reserves: z.array(ReserveSchema).max(100),
  unknownUsage: UnknownUsagePolicySchema,
  guidance: GuidanceSchema.optional(),
  methods: reviewMethods.optional(),
});
export const ResolvedPolicySchema = z.strictObject({ policy: PolicySchema, hash: HashSchema });
export const RouterDecisionSchema = z.strictObject({
  chosen: RouteIdSchema.nullable(),
  rejected: z.array(z.strictObject({ routeId: RouteIdSchema, reason: text })).max(100),
  rule: z.enum(['percentage', 'fixed-allowance', 'manual', 'waiting']),
  inputsHash: HashSchema,
});
export const SourceSchema = z.strictObject({
  projectId: ProjectIdSchema,
  base: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  branch: label,
  dirtyCount: RevisionSchema,
  untrackedCount: RevisionSchema,
});
export const ProjectSchema = z.strictObject({
  id: ProjectIdSchema,
  name: label,
  revision: RevisionSchema,
});
export const TaskSchema = z
  .strictObject({
    id: TaskIdSchema,
    projectId: ProjectIdSchema,
    title: label,
    outcome: text,
    criteria: z.array(text).min(1).max(100),
    state: TaskStateSchema,
    waitingReason: WaitingReasonSchema.nullable(),
    revision: RevisionSchema,
    runId: RunIdSchema.nullable(),
    next: text.nullable(),
  })
  .superRefine((value, context) => {
    if ((value.state === 'waiting') !== (value.waitingReason !== null))
      context.addIssue({
        code: 'custom',
        message: 'Only waiting tasks carry a waiting reason.',
        path: ['waitingReason'],
      });
  });
export const AcpApprovalTargetSchema = z.strictObject({
  sessionId: acpIdentifier,
  toolCallId: acpIdentifier,
  optionId: acpIdentifier,
  kind: z.literal('allow_once'),
});
export const ApprovalBindingSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  taskId: TaskIdSchema,
  attemptId: AttemptIdSchema,
  generation: RevisionSchema,
  action: GrantSchema.shape.action,
  target: text,
  acpTarget: AcpApprovalTargetSchema.optional(),
  revision: RevisionSchema,
});
export const ApprovalSchema = z.strictObject({
  ...ApprovalBindingSchema.shape,
  requester: label,
  consequence: text,
  status: z.enum(['pending', 'approved', 'denied']),
});
export const ArtifactSchema = z.strictObject({
  id: ArtifactIdSchema,
  hash: HashSchema,
  bytes: RevisionSchema,
  mediaType: label,
});
export const CandidateSchema = z.strictObject({
  id: CandidateIdSchema,
  taskId: TaskIdSchema,
  hash: HashSchema,
  artifactId: ArtifactIdSchema,
  revision: RevisionSchema,
});
const integrationTree = z.string().regex(/^[a-f0-9]{40}$/);
const combinedContributor = z.strictObject({
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  attemptId: AttemptIdSchema,
  generation: RevisionSchema,
  routeId: RouteIdSchema,
  candidateId: CandidateIdSchema,
  candidateHash: HashSchema,
  scopeHash: HashSchema,
});
const combinedStep = z.strictObject({
  candidateId: CandidateIdSchema,
  candidateHash: HashSchema,
  definitionHash: HashSchema,
  checkArtifactId: ArtifactIdSchema,
  previousTree: integrationTree,
  nextTree: integrationTree,
});
export const CombinedOriginSchema = z
  .strictObject({
    kind: z.literal('combined'),
    taskId: TaskIdSchema,
    runId: RunIdSchema,
    preparationId: ArtifactIdSchema,
    manifestHash: HashSchema,
    generation: RevisionSchema,
    sourceBase: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    sourceManifestHash: HashSchema,
    policyHash: HashSchema,
    criteriaHash: HashSchema,
    contributors: z.tuple([combinedContributor, combinedContributor]),
    steps: z.tuple([combinedStep, combinedStep]),
    candidateId: CandidateIdSchema,
    candidateHash: HashSchema,
  })
  .superRefine((origin, context) => {
    const [first, second] = origin.contributors;
    if (
      first.taskId === second.taskId ||
      [first.taskId, second.taskId].includes(origin.taskId) ||
      first.runId === second.runId ||
      [first.runId, second.runId].includes(origin.runId) ||
      first.attemptId === second.attemptId ||
      new Set([
        first.candidateId,
        second.candidateId,
        ...origin.steps.map((step) => step.candidateId),
        origin.candidateId,
      ]).size !== 5 ||
      origin.steps[0].checkArtifactId === origin.steps[1].checkArtifactId ||
      origin.steps[0].nextTree !== origin.steps[1].previousTree ||
      origin.steps[1].candidateHash !== origin.candidateHash ||
      origin.steps.some((step) => step.previousTree === step.nextTree)
    )
      context.addIssue({
        code: 'custom',
        message: 'Combined origin needs distinct contributors and checked sequential advances.',
      });
  });
export type CombinedOrigin = z.infer<typeof CombinedOriginSchema>;
export const CombinedCheckContextSchema = z.strictObject({
  manifestHash: HashSchema,
  generation: RevisionSchema,
  phase: z.enum(['baseline', 'replay-0', 'replay-1', 'final-check']),
  originHash: HashSchema,
});
export const ScriptedReviewJobSchema = z
  .strictObject({
    taskId: TaskIdSchema,
    runId: RunIdSchema,
    attemptId: AttemptIdSchema,
    generation: RevisionSchema,
    routeId: RouteIdSchema,
    writerAttemptId: AttemptIdSchema.optional(),
    writerRouteId: RouteIdSchema.optional(),
    candidateId: CandidateIdSchema,
    candidateHash: HashSchema,
    methodId: ReviewMethodIdSchema,
    cycle: z.number().int().min(1).max(3),
    limitMinutes: z.number().int().min(1).max(1440),
    scripted: z.literal(true),
  })
  .refine(
    (job) => (job.writerAttemptId === undefined) === (job.writerRouteId === undefined),
    'Writer provenance requires both the attempt and route.',
  );
export const NativeReviewJobSchema = z.strictObject({
  ...ScriptedReviewJobSchema.shape,
  scripted: z.literal(false),
  writerAttemptId: AttemptIdSchema,
  writerRouteId: RouteIdSchema,
  preparationId: ArtifactIdSchema,
  profileId: label,
  assignedRole: ReviewMethodSchema.shape.reviewerRole,
  independence: z.literal('process-only'),
  methodId: z.literal('keep-it-simple'),
  cycle: z.literal(1),
  limitMinutes: z.number().int().min(1).max(5),
});
export const CombinedNativeReviewJobSchema = NativeReviewJobSchema.omit({
  writerAttemptId: true,
  writerRouteId: true,
})
  .extend({
    origin: CombinedOriginSchema,
    profileId: z.literal('openai-file-v1'),
    assignedRole: z.literal('reviewer'),
  })
  .refine(
    (job) =>
      job.taskId === job.origin.taskId &&
      job.runId === job.origin.runId &&
      job.candidateId === job.origin.candidateId &&
      job.candidateHash === job.origin.candidateHash &&
      !job.origin.contributors.some((contributor) => contributor.attemptId === job.attemptId),
    'Combined review must bind the final origin and an independent attempt.',
  );
export const ReviewJobSchema = z.union([
  ScriptedReviewJobSchema,
  NativeReviewJobSchema,
  CombinedNativeReviewJobSchema,
]);
export type NativeReviewJob = z.infer<typeof NativeReviewJobSchema>;
export type CombinedNativeReviewJob = z.infer<typeof CombinedNativeReviewJobSchema>;
export const ReviewResultSchema = z
  .strictObject({
    job: ReviewJobSchema,
    outcome: z.enum(['passed', 'failed', 'blocked']),
    findings: z
      .array(z.strictObject({ severity: z.enum(['info', 'warning', 'blocking']), message: text }))
      .max(50),
    summary: text,
  })
  .superRefine((result, context) => {
    if (
      result.outcome === 'passed' &&
      result.findings.some((finding) => finding.severity === 'blocking')
    )
      context.addIssue({
        code: 'custom',
        message: 'A blocking finding cannot pass review.',
        path: ['outcome'],
      });
  });

export const RunSchema = z.strictObject({
  id: RunIdSchema,
  taskId: TaskIdSchema,
  source: SourceSchema,
  policy: ResolvedPolicySchema,
  roles: z.array(RoleSchema).min(1).max(6),
  decision: RouterDecisionSchema,
  revision: RevisionSchema,
});
export const AttemptSchema = z.strictObject({
  id: AttemptIdSchema,
  runId: RunIdSchema,
  routeId: RouteIdSchema,
  generation: RevisionSchema,
  state: z.enum(['intent', 'running', 'stopping', 'stopped', 'interrupted', 'unknown', 'failed']),
  revision: RevisionSchema,
});
export const HandoffPacketSchema = z.strictObject({
  version: z.literal(1),
  id: HandoffIdSchema,
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  attemptId: AttemptIdSchema,
  generation: RevisionSchema,
  outcome: text,
  criteria: z.array(text).min(1).max(100),
  decisions: z.array(text).max(100),
  deniedActions: z.array(EffectSchema).max(100),
  source: SourceSchema,
  candidate: CandidateSchema.nullable(),
  artifacts: z.array(ArtifactSchema).max(1000),
  unfinished: z.array(text).max(100),
  unverified: z.array(text).max(100),
  failedChecks: z.array(text).max(100),
  unrunChecks: z.array(text).max(100),
  scope: z.array(text).max(100),
  remainingBudgets: RemainingBudgetsSchema,
  unresolvedExposure: z.array(text).max(100),
  policy: ResolvedPolicySchema,
  allowedRouteIds: z.array(RouteIdSchema).max(32),
  createdAt: TimestampSchema,
});
export const SealedHandoffPacketSchema = z.strictObject({
  packet: HandoffPacketSchema,
  checksum: HashSchema,
});

export const DesktopNoticeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('connection'),
    state: z.enum(['connecting', 'connected', 'offline']),
    reconnectAvailable: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('history-gap'), after: CursorSchema }),
  z.strictObject({ kind: z.literal('retry'), available: z.boolean() }),
  z.strictObject({
    kind: z.literal('export'),
    artifactId: ArtifactIdSchema,
    outcome: z.enum(['saved', 'cancelled', 'failed']),
  }),
]);
export type DesktopNotice = z.infer<typeof DesktopNoticeSchema>;
export const RuntimeManifestSchema = z.strictObject({
  version: z.literal(1),
  node: z.strictObject({
    version: z.literal('24.22.0'),
    platform: z.enum(['darwin', 'linux']),
    arch: z.enum(['arm64', 'x64']),
    sha256: HashSchema,
  }),
  mode: z.enum(['workspace', 'demo']),
  localInput: z
    .strictObject({
      sha256: HashSchema,
      sourceHash: HashSchema,
      target: z.literal('darwin-arm64'),
      minOS: z.literal('13.5.0'),
    })
    .optional(),
});
export type RuntimeManifest = z.infer<typeof RuntimeManifestSchema>;

const actor = z.strictObject({ id: label, kind: z.enum(['desktop', 'cli', 'controller']) });
const envelope = { protocol: z.literal(1), key: CommandIdSchema, actor };
const mutation = { ...envelope, expectedRevision: RevisionSchema };
const read = <T extends string, S extends z.ZodType>(command: T, payload: S) =>
  z.strictObject({ ...envelope, command: z.literal(command), payload });
const mutate = <T extends string, S extends z.ZodType>(command: T, payload: S) =>
  z.strictObject({ ...mutation, command: z.literal(command), payload });
const empty = z.strictObject({});
const taskRef = z.strictObject({ taskId: TaskIdSchema });
const runRef = z.strictObject({ taskId: TaskIdSchema, runId: RunIdSchema });
const evaluationFields = {
  taskId: TaskIdSchema,
  candidateId: CandidateIdSchema,
  reviewer: z.strictObject({
    profileId: label,
    methodId: ReviewMethodIdSchema,
    cycles: z.literal(1),
  }),
  creditPolicy: z.enum(['ordinary', 'existing-credits']).default('ordinary'),
  consent: z.enum(['explicit', 'saved']),
  grants: z.array(GrantSchema).length(2),
};
const nativePreparationFields = {
  taskId: TaskIdSchema,
  policy: PolicySchema,
  creditPolicy: z.enum(['ordinary', 'existing-credits']).default('ordinary'),
  consent: z.enum(['explicit', 'saved']),
};
export const NativePreparationPayloadSchema = z.union([
  z.strictObject({
    ...nativePreparationFields,
    profileId: label.refine(
      (id) => !['openai-repository-v1', 'google-acp-v1', 'local-file-v1'].includes(id),
    ),
    billingAttestation: NativeBillingAttestationSchema.optional(),
    permissionMode: GoogleNativePermissionModeSchema.optional(),
    targetPath: NativeTargetPathSchema,
    handoffTargets: NativeHandoffTargetsSchema.optional(),
  }),
  z.strictObject({
    ...nativePreparationFields,
    profileId: z.literal('openai-repository-v1'),
  }),
  z.strictObject({
    ...nativePreparationFields,
    ...GoogleAcpSelectionSchema.shape,
    profileId: z.literal('google-acp-v1'),
    policy: PolicySchema.refine((policy) => policy.authority !== 'autopilot'),
    creditPolicy: z.literal('ordinary').default('ordinary'),
    billingAttestation: GoogleAcpBillingAttestationSchema,
    permissionMode: z.literal('request-review'),
    targetPath: NativeTargetPathSchema,
  }),
  z.strictObject({
    taskId: TaskIdSchema,
    profileId: z.literal('local-file-v1'),
    targetPath: NativeTargetPathSchema,
    policy: PolicySchema,
    consent: z.enum(['explicit', 'saved']),
  }),
]);
export const CombinedWriterSelectionSchema = z.discriminatedUnion('profileId', [
  z.strictObject({
    profileId: z.literal('openai-file-v1'),
    creditPolicy: z.enum(['ordinary', 'existing-credits']),
  }),
  z.strictObject({
    profileId: z.literal('anthropic-file-v1'),
    creditPolicy: z.literal('ordinary'),
    billingAttestation: NativeBillingAttestationSchema,
  }),
  z.strictObject({
    profileId: z.literal('google-acp-v1'),
    creditPolicy: z.literal('ordinary'),
    billingAttestation: GoogleAcpBillingAttestationSchema,
    permissionMode: z.literal('request-review'),
    ...GoogleAcpSelectionSchema.shape,
  }),
]);
const combinedMemberPreparation = z.strictObject({
  taskId: TaskIdSchema,
  expectedRevision: RevisionSchema,
  scope: z.tuple([NativeTargetPathSchema]),
  writer: CombinedWriterSelectionSchema,
  consent: z.literal('explicit'),
  maximumMinutes: z.number().int().min(1).max(5),
});
export const PrepareCombinedRunPayloadSchema = z
  .strictObject({
    taskId: TaskIdSchema,
    policy: PolicySchema,
    children: z.tuple([combinedMemberPreparation, combinedMemberPreparation]),
    checks: z.strictObject({
      recipeId: z.literal('project-node-tests-v1'),
      testFiles: ProjectNodeTestFilesSchema,
      replayTestFiles: z.tuple([ProjectNodeTestFilesSchema, ProjectNodeTestFilesSchema]),
      interactionTestFiles: ProjectNodeTestFilesSchema,
      maximumMinutes: z.literal(1),
      baselineConsent: z.literal('explicit'),
      replayConsents: z.tuple([z.literal('explicit'), z.literal('explicit')]),
    }),
    reviewer: z.strictObject({
      profileId: z.literal('openai-file-v1'),
      creditPolicy: z.enum(['ordinary', 'existing-credits']),
      maximumMinutes: z.number().int().min(1).max(5),
    }),
  })
  .superRefine((plan, context) => {
    const [first, second] = plan.children;
    const paths = plan.children.flatMap((child) => child.scope);
    const replays = plan.checks.replayTestFiles.flat();
    const methods = plan.policy.methods;
    const minimumMinutes =
      5 + first.maximumMinutes + second.maximumMinutes + plan.reviewer.maximumMinutes;
    if (
      first.taskId === second.taskId ||
      [first.taskId, second.taskId].includes(plan.taskId) ||
      paths[0] === paths[1] ||
      paths.some((path) => paths.some((other) => other !== path && other.startsWith(`${path}/`))) ||
      [...replays, ...plan.checks.interactionTestFiles].some(
        (path) => !plan.checks.testFiles.includes(path),
      ) ||
      plan.checks.interactionTestFiles.some((path) => replays.includes(path)) ||
      plan.checks.testFiles.some((path) => paths.includes(path)) ||
      plan.policy.quality !== 'quick' ||
      plan.policy.authority === 'autopilot' ||
      !methods ||
      methods.length !== 1 ||
      methods[0].id !== 'keep-it-simple' ||
      methods[0].cycles !== 1 ||
      methods[0].reviewerRole !== 'reviewer' ||
      plan.policy.limits.attempts < 7 ||
      plan.policy.limits.concurrency < 2 ||
      plan.policy.limits.minutes < minimumMinutes
    )
      context.addIssue({
        code: 'custom',
        message:
          'Combined work needs two disjoint children, protected checks and its complete reserved policy.',
      });
  });
export type PrepareCombinedRunPayload = z.infer<typeof PrepareCombinedRunPayloadSchema>;
const nativeHandoffPreparationFields = {
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  fromAttemptId: AttemptIdSchema,
  consent: z.literal('explicit'),
};
export const NativeHandoffPreparationPayloadSchema = z.union([
  z.strictObject({
    ...nativeHandoffPreparationFields,
    profileId: z.literal('openai-file-v1'),
    creditPolicy: z.enum(['ordinary', 'existing-credits']).default('ordinary'),
  }),
  z.strictObject({
    ...nativeHandoffPreparationFields,
    profileId: z.literal('anthropic-file-v1'),
    creditPolicy: z.literal('ordinary').default('ordinary'),
    billingAttestation: NativeBillingAttestationSchema,
  }),
  z.strictObject({
    ...nativeHandoffPreparationFields,
    profileId: z.literal('google-file-v1'),
    creditPolicy: z.literal('ordinary').default('ordinary'),
    billingAttestation: NativeBillingAttestationSchema,
    permissionMode: GoogleNativePermissionModeSchema,
  }),
]);
const conversationBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export const CONVERSATION_CONTEXT_MEDIA_TYPE = 'application/vnd.crewkite.conversation-context+json';
const contextBase = z.string().regex(/^[a-f0-9]{40}$/);
const contextPath = NativeTargetPathSchema.refine(
  (path) =>
    new TextEncoder().encode(path).length <= 1024 &&
    path.split('/').length <= 16 &&
    !path
      .split('/')
      .some(
        (part) =>
          /^(?:\.git|\.hg|\.svn|node_modules|\.pnpm|\.yarn|\.ssh|\.aws|\.azure|\.gnupg|\.config|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa.*|id_ed25519.*)$/i.test(
            part,
          ) || /\.(?:pem|key|p12|pfx|keystore|keychain(?:-db)?)$/i.test(part),
      ),
  'Context needs a bounded source path outside excluded locations.',
);
const contextText = z
  .string()
  .min(1)
  .max(8192)
  .refine(
    (value) =>
      value.isWellFormed() &&
      new TextEncoder().encode(value).length <= 8192 &&
      ![...value].some((character) => {
        const point = character.codePointAt(0) as number;
        return (point < 32 && ![9, 10, 13].includes(point)) || (point >= 127 && point <= 159);
      }),
    'Context needs bounded UTF-8 text without binary control bytes.',
  );
const contextFile = z
  .strictObject({
    kind: z.enum(['source', 'log']),
    path: contextPath,
    mode: z.enum(['100644', '100755']),
    hash: HashSchema,
    bytes: RevisionSchema.min(1).max(8192),
    text: contextText,
  })
  .refine(
    (file) =>
      file.bytes === new TextEncoder().encode(file.text).length &&
      (file.kind !== 'log' || !file.path.split('/').some((part) => part.startsWith('.'))),
    'Context byte counts must match complete text and logs cannot read hidden locations.',
  );
export const ConversationContextBundleSchema = z
  .strictObject({
    version: z.literal(1),
    projectId: ProjectIdSchema,
    base: contextBase,
    files: z.array(contextFile).min(1).max(32),
  })
  .superRefine((bundle, context) => {
    const seen = new Set<string>(),
      prefixes = new Map<string, string>();
    let valid = true;
    for (const [index, file] of bundle.files.entries()) {
      const key = file.path.normalize('NFC').toLowerCase();
      if (
        seen.has(key) ||
        prefixes.has(key) ||
        (index > 0 && bundle.files[index - 1].path >= file.path)
      )
        valid = false;
      const parts = file.path.split('/');
      for (let end = 1; end <= parts.length; end++) {
        const prefix = parts.slice(0, end).join('/'),
          canonical = prefix.normalize('NFC').toLowerCase();
        if (
          (end < parts.length && seen.has(canonical)) ||
          (prefixes.has(canonical) && prefixes.get(canonical) !== prefix)
        )
          valid = false;
        prefixes.set(canonical, prefix);
      }
      seen.add(key);
    }
    if (!valid || new TextEncoder().encode(canonicalJson(bundle)).length > 32768)
      context.addIssue({
        code: 'custom',
        message: 'Context needs ordered collision-free paths and at most 32768 canonical bytes.',
      });
  });
export const ConversationContextRefSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  hash: HashSchema,
});
export const ConversationContextRefsSchema = z
  .array(ConversationContextRefSchema)
  .max(4)
  .refine(
    (refs) =>
      new Set(refs.map((ref) => ref.artifactId)).size === refs.length &&
      new Set(refs.map((ref) => ref.hash)).size === refs.length,
    'Context references need distinct artifact IDs and hashes.',
  );
export const ConversationContextPickSchema = z.strictObject({
  kind: z.enum(['source-file', 'source-folder', 'log-file']),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (path) =>
        path.startsWith('/') &&
        path.isWellFormed() &&
        !path.includes('\\') &&
        !/\p{Cc}/u.test(path) &&
        new TextEncoder().encode(path).length <= 4096 &&
        !path
          .split('/')
          .slice(1)
          .some((part) => !part || part === '.' || part === '..'),
      'A native context pick needs an absolute bounded path.',
    ),
});
export type ConversationContextBundle = z.infer<typeof ConversationContextBundleSchema>;
export type ConversationContextRef = z.infer<typeof ConversationContextRefSchema>;
export type ConversationContextRefs = z.infer<typeof ConversationContextRefsSchema>;
export type ConversationContextPick = z.infer<typeof ConversationContextPickSchema>;
export const ConversationTextSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value.isWellFormed() &&
      !value.includes('\0') &&
      new TextEncoder().encode(value).length <= 4096,
    'Conversation text needs valid Unicode without null bytes.',
  );
const conversationSlice = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/),
  title: label,
  role: z.enum(['coder', 'reviewer', 'advisor']),
  scope: z.array(NativeTargetPathSchema).min(1).max(100),
  dependsOn: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/)).max(20),
});
export const ConversationPlanProposalSchema = z
  .strictObject({
    summary: ConversationTextSchema,
    criteria: z.array(ConversationTextSchema).min(1).max(100),
    slices: z.array(conversationSlice).min(1).max(20),
    checks: z.array(label).max(20),
  })
  .superRefine((plan, context) => {
    const slices = new Map(plan.slices.map((slice) => [slice.id, slice]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      const slice = slices.get(id);
      if (!slice) return false;
      visiting.add(id);
      if (!slice.dependsOn.every(visit)) return false;
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    if (slices.size !== plan.slices.length || !plan.slices.every((slice) => visit(slice.id)))
      context.addIssue({
        code: 'custom',
        message: 'Plan slices need distinct IDs and acyclic known dependencies.',
      });
    for (const slice of plan.slices)
      if (
        new Set(slice.scope).size !== slice.scope.length ||
        new Set(slice.dependsOn).size !== slice.dependsOn.length
      )
        context.addIssue({
          code: 'custom',
          message: 'Slice paths and dependencies must be distinct.',
        });
    if (new Set(plan.checks).size !== plan.checks.length || conversationBytes(plan) > 65536)
      context.addIssue({
        code: 'custom',
        message: 'A proposal needs distinct checks and at most 65536 encoded bytes.',
      });
  });
export const ConversationTurnBindingSchema = z.strictObject({
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  attemptId: AttemptIdSchema,
  generation: RevisionSchema,
  routeId: RouteIdSchema,
  role: z.enum(['lead', 'orchestrator']),
  taskRevision: RevisionSchema,
  conversationRevision: RevisionSchema,
  scopeHash: HashSchema,
  limitMinutes: z.number().int().min(1).max(5),
});
export const ConversationTurnResultSchema = z
  .strictObject({
    version: z.literal(1),
    bindingHash: HashSchema,
    message: ConversationTextSchema,
    questions: z.array(ConversationTextSchema).max(8),
    proposal: ConversationPlanProposalSchema.nullable(),
  })
  .refine(
    (value) => conversationBytes(value) <= 65536,
    'Conversation output exceeds 65536 encoded bytes.',
  );
const conversationEntryFields = {
  id: MessageIdSchema,
  taskId: TaskIdSchema,
  revision: RevisionSchema,
  cursor: CursorSchema,
  at: TimestampSchema,
  text: ConversationTextSchema,
};
const conversationAgent = z.strictObject({
  kind: z.literal('agent'),
  role: z.enum(['lead', 'orchestrator']),
  attemptId: AttemptIdSchema,
  routeId: RouteIdSchema,
});
const conversationUser = z.strictObject({ kind: z.literal('user') });
export const ConversationEntrySchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...conversationEntryFields,
      kind: z.literal('user-message'),
      author: conversationUser,
      context: ConversationContextRefsSchema.optional(),
    }),
    z.strictObject({
      ...conversationEntryFields,
      kind: z.literal('guidance'),
      author: conversationUser,
      context: ConversationContextRefsSchema.optional(),
    }),
    z.strictObject({
      ...conversationEntryFields,
      kind: z.literal('answer'),
      author: conversationUser,
      context: ConversationContextRefsSchema.optional(),
      replyTo: MessageIdSchema,
    }),
    z.strictObject({
      ...conversationEntryFields,
      kind: z.literal('agent-message'),
      author: conversationAgent,
      binding: ConversationTurnBindingSchema,
    }),
    z.strictObject({
      ...conversationEntryFields,
      kind: z.literal('question'),
      author: conversationAgent,
      binding: ConversationTurnBindingSchema,
    }),
    z.strictObject({
      ...conversationEntryFields,
      kind: z.literal('plan-proposal'),
      author: conversationAgent,
      binding: ConversationTurnBindingSchema,
      proposal: ConversationPlanProposalSchema,
    }),
    z.strictObject({
      ...conversationEntryFields,
      kind: z.literal('input-delivery'),
      author: z.strictObject({ kind: z.literal('controller') }),
      binding: ConversationTurnBindingSchema,
      replyTo: MessageIdSchema,
    }),
  ])
  .superRefine((entry, context) => {
    if (
      'binding' in entry &&
      (entry.binding.taskId !== entry.taskId ||
        (entry.author.kind === 'agent' &&
          (entry.author.attemptId !== entry.binding.attemptId ||
            entry.author.routeId !== entry.binding.routeId ||
            entry.author.role !== entry.binding.role)))
    )
      context.addIssue({
        code: 'custom',
        message: 'Conversation output must match its admitted turn.',
      });
    if (conversationBytes(entry) > 73728)
      context.addIssue({
        code: 'custom',
        message: 'A conversation entry exceeds its encoded byte limit.',
      });
  });
export const ConversationPageSchema = z
  .strictObject({
    kind: z.literal('conversation'),
    taskId: TaskIdSchema,
    entries: z.array(ConversationEntrySchema).max(100),
    nextBeforeCursor: CursorSchema.nullable(),
  })
  .superRefine((page, context) => {
    if (
      page.entries.some(
        (entry, index) =>
          entry.taskId !== page.taskId ||
          (index > 0 && BigInt(entry.cursor) <= BigInt(page.entries[index - 1].cursor)),
      ) ||
      new Set(page.entries.map((entry) => entry.id)).size !== page.entries.length ||
      (page.nextBeforeCursor !== null &&
        (page.entries.length === 0 || page.nextBeforeCursor !== page.entries[0].cursor))
    )
      context.addIssue({
        code: 'custom',
        message: 'Conversation pages need ordered distinct entries for one task.',
      });
    if (conversationBytes(page) > 524288)
      context.addIssue({
        code: 'custom',
        message: 'A conversation page exceeds 524288 encoded bytes.',
      });
  });
export type ConversationEntry = z.infer<typeof ConversationEntrySchema>;
export type ConversationPage = z.infer<typeof ConversationPageSchema>;
export type ConversationPlanProposal = z.infer<typeof ConversationPlanProposalSchema>;
export type ConversationTurnBinding = z.infer<typeof ConversationTurnBindingSchema>;
export type ConversationTurnResult = z.infer<typeof ConversationTurnResultSchema>;
const conversationModelText = (maximumBytes: number) =>
  z
    .string()
    .min(1)
    .max(maximumBytes)
    .refine(
      (value) =>
        value.isWellFormed() &&
        !/\p{Cc}/u.test(value) &&
        value.trim().length > 0 &&
        new TextEncoder().encode(value).byteLength <= maximumBytes,
      'Model metadata needs bounded text without control characters.',
    );
const conversationModelObservation = z.strictObject({
  artifactId: ArtifactIdSchema,
  hash: HashSchema,
});
export const ConversationModelRequestSchema = z.strictObject({
  version: z.literal(1),
  observation: conversationModelObservation,
  model: conversationModelText(200),
  effort: conversationModelText(32),
});
export const ConversationModelCatalogEntrySchema = z
  .strictObject({
    model: ConversationModelRequestSchema.shape.model,
    efforts: z.array(ConversationModelRequestSchema.shape.effort).min(1).max(16),
    defaultEffort: ConversationModelRequestSchema.shape.effort,
  })
  .refine(
    (entry) =>
      new Set(entry.efforts).size === entry.efforts.length &&
      entry.efforts.includes(entry.defaultEffort),
    'Model efforts must be distinct and include their default.',
  );
const conversationModelEntries = z
  .array(ConversationModelCatalogEntrySchema)
  .max(20)
  .refine(
    (models) => new Set(models.map((entry) => entry.model)).size === models.length,
    'Catalog model identifiers must be distinct.',
  );
export const ConversationModelCatalogEntriesSchema = conversationModelEntries.min(1);
export const ConversationModelCatalogSchema = z
  .strictObject({
    version: z.literal(1),
    profileId: z.literal('openai-file-v1'),
    taskId: TaskIdSchema,
    runId: RunIdSchema,
    attemptId: AttemptIdSchema,
    generation: RevisionSchema,
    observedAt: TimestampSchema,
    profileHash: HashSchema,
    client: z.strictObject({
      executable: conversationModelText(4096),
      sha256: HashSchema,
      version: conversationModelText(200),
    }),
    locationHash: HashSchema,
    models: ConversationModelCatalogEntriesSchema,
  })
  .refine(
    (catalog) => conversationBytes(catalog) <= 32768,
    'A model catalog exceeds 32768 encoded bytes.',
  );
const conversationModelFailureReasons = [
  'observation-missing',
  'observation-stale',
  'client-changed',
  'catalog-unavailable',
  'model-unavailable',
  'effort-unavailable',
] as const;
export const ConversationModelReasonSchema = z.enum([
  'available',
  'not-observed',
  ...conversationModelFailureReasons,
]);
export const ConversationModelChoicesSchema = z
  .strictObject({
    status: z.enum(['not-observed', 'last-observed', 'client-changed', 'unavailable']),
    observation: conversationModelObservation.nullable(),
    observedAt: TimestampSchema.nullable(),
    models: conversationModelEntries,
    reason: ConversationModelReasonSchema,
  })
  .superRefine((choices, context) => {
    const fail = (message: string) => context.addIssue({ code: 'custom', message });
    if ((choices.observation === null) !== (choices.observedAt === null))
      fail('Model observation identity and time must be present together.');
    switch (choices.status) {
      case 'not-observed':
        if (
          choices.observation !== null ||
          choices.models.length !== 0 ||
          choices.reason !== 'not-observed'
        )
          fail('Unobserved model choices cannot contain a catalog.');
        break;
      case 'last-observed':
      case 'client-changed':
        if (
          choices.observation === null ||
          choices.models.length === 0 ||
          !(choices.status === 'client-changed'
            ? choices.reason === 'client-changed'
            : ['available', 'model-unavailable', 'effort-unavailable'].includes(choices.reason))
        )
          fail('Observed model choices need a catalog reference and its current status.');
        break;
      case 'unavailable':
        if (
          choices.models.length !== 0 ||
          !['observation-missing', 'observation-stale', 'catalog-unavailable'].includes(
            choices.reason,
          )
        )
          fail('Unavailable model choices need an observation failure without catalog entries.');
        break;
    }
    if (conversationBytes(choices) > 32768) fail('Model choices exceed 32768 encoded bytes.');
  });
export type ConversationModelRequest = z.infer<typeof ConversationModelRequestSchema>;
export type ConversationModelCatalogEntry = z.infer<typeof ConversationModelCatalogEntrySchema>;
export type ConversationModelCatalogEntries = z.infer<typeof ConversationModelCatalogEntriesSchema>;
export type ConversationModelCatalog = z.infer<typeof ConversationModelCatalogSchema>;
export type ConversationModelChoices = z.infer<typeof ConversationModelChoicesSchema>;
export type ConversationModelReason = z.infer<typeof ConversationModelReasonSchema>;
export const ConversationPlanningSelectionSchema = z.strictObject({
  role: z.enum(['lead', 'orchestrator']),
  profileId: z.literal('openai-file-v1'),
  creditPolicy: z.enum(['ordinary', 'existing-credits']),
  limits: LimitsSchema,
  consent: z.literal('explicit'),
  modelRequest: ConversationModelRequestSchema.optional(),
});
export type ConversationPlanningSelection = z.infer<typeof ConversationPlanningSelectionSchema>;
export const ConversationActionReasonSchema = z.enum([
  'available',
  'queued-at-boundary',
  'not-configured',
  'profile-unavailable',
  'planning-role-unavailable',
  'planning-consent-required',
  'source-changed',
  'task-contract-changed',
  'conversation-input-too-large',
  'owner-active',
  'ownership-unknown',
  'admissions-paused',
  'attempt-budget-exhausted',
  'minute-budget-exhausted',
  'concurrency-exhausted',
  'provider-capacity-unavailable',
  'proposal-missing',
  'proposal-not-current',
  'proposal-hash-changed',
  'pending-question',
  'pending-input',
  'effects-unresolved',
  'execution-active',
  'task-not-discussing',
  'controller-closing',
  ...conversationModelFailureReasons,
]);
const conversationProposalReference = z.strictObject({
  id: MessageIdSchema,
  hash: HashSchema,
  runId: RunIdSchema,
  revision: RevisionSchema,
});
export const TaskConversationStateSchema = z
  .strictObject({
    taskId: TaskIdSchema,
    revision: RevisionSchema,
    contractStatus: z.enum(['provisional', 'confirmed']),
    purpose: z.enum(['conversation', 'execution']).nullable(),
    phase: z.enum([
      'idle',
      'discussion',
      'planning',
      'planned',
      'execution',
      'stopping',
      'stopped',
      'interrupted',
      'unknown',
    ]),
    configuration: z
      .strictObject({
        revision: RevisionSchema,
        selection: ConversationPlanningSelectionSchema,
        routeId: RouteIdSchema.nullable(),
        requestedModel: label.nullable(),
        effectiveModel: label.nullable(),
        requestedEffort: label.nullable(),
        effectiveEffort: label.nullable(),
      })
      .nullable(),
    modelChoices: ConversationModelChoicesSchema.optional(),
    currentRunId: RunIdSchema.nullable(),
    activeAttempt: AttemptSchema.nullable(),
    budget: z.strictObject({ limits: LimitsSchema, remaining: RemainingBudgetsSchema }).nullable(),
    queuedInputCount: RevisionSchema,
    pendingQuestions: z
      .array(z.strictObject({ id: MessageIdSchema, cursor: CursorSchema }))
      .max(100),
    proposal: conversationProposalReference.nullable(),
    adoptedProposal: conversationProposalReference.nullable(),
    send: z.strictObject({
      available: z.boolean(),
      reason: ConversationActionReasonSchema,
      disposition: z.enum(['turn', 'planning-turn', 'queue']).nullable(),
    }),
    adopt: z.strictObject({ available: z.boolean(), reason: ConversationActionReasonSchema }),
  })
  .superRefine((state, context) => {
    const fail = (message: string) => context.addIssue({ code: 'custom', message });
    if (state.activeAttempt && state.activeAttempt.runId !== state.currentRunId)
      fail('The active conversation attempt must belong to the current run.');
    if (
      new Set(state.pendingQuestions.map((question) => question.id)).size !==
      state.pendingQuestions.length
    )
      fail('Pending questions must be distinct.');
    if (
      state.budget &&
      (['attempts', 'minutes', 'concurrency'] as const).some(
        (axis) => state.budget !== null && state.budget.remaining[axis] > state.budget.limits[axis],
      )
    )
      fail('Remaining task allowance cannot exceed its configured limits.');
    if (
      state.send.available
        ? !(
            (state.send.reason === 'available' &&
              ['turn', 'planning-turn'].includes(state.send.disposition ?? '')) ||
            (state.send.reason === 'queued-at-boundary' && state.send.disposition === 'queue')
          )
        : state.send.disposition !== null ||
          ['available', 'queued-at-boundary'].includes(state.send.reason)
    )
      fail('Send availability must state whether a turn can start or input will queue.');
    if (
      state.adopt.available
        ? state.adopt.reason !== 'available' || state.proposal === null
        : ['available', 'queued-at-boundary'].includes(state.adopt.reason)
    )
      fail('Plan adoption availability requires a current proposal.');
    if (
      state.send.available &&
      state.send.disposition === 'turn' &&
      (!state.configuration?.routeId ||
        !state.currentRunId ||
        !state.budget ||
        state.purpose !== 'conversation' ||
        state.activeAttempt !== null ||
        ['unknown', 'stopping'].includes(state.phase))
    )
      fail('A fresh planning turn requires configured authority and no active owner.');
    if (
      state.send.available &&
      state.send.disposition === 'queue' &&
      (!state.currentRunId ||
        state.purpose === null ||
        !state.activeAttempt ||
        !['intent', 'running', 'stopping'].includes(state.activeAttempt.state))
    )
      fail('Queued input requires a known active owner for the current run.');
    if (
      state.send.available &&
      state.send.disposition === 'planning-turn' &&
      (!state.configuration?.routeId ||
        !state.currentRunId ||
        !state.budget ||
        state.purpose !== 'execution' ||
        state.activeAttempt !== null ||
        ['unknown', 'stopping'].includes(state.phase))
    )
      fail('A linked planning turn requires saved authority and a quiescent execution run.');
    if (
      state.adopt.available &&
      (!state.configuration ||
        !state.budget ||
        state.purpose !== 'conversation' ||
        !state.currentRunId ||
        state.proposal?.runId !== state.currentRunId ||
        state.activeAttempt !== null)
    )
      fail('Plan adoption requires the current planning lineage without an active owner.');
    if (conversationBytes(state) > 32768) fail('Conversation state exceeds 32768 encoded bytes.');
  });
export type TaskConversationState = z.infer<typeof TaskConversationStateSchema>;
export const CommandSchema = z.discriminatedUnion('command', [
  mutate(
    'CaptureConversationContext',
    z.strictObject({
      projectId: ProjectIdSchema,
      base: contextBase,
      selections: z
        .array(ConversationContextPickSchema)
        .min(1)
        .max(4)
        .refine(
          (picks) =>
            new Set(picks.map((pick) => `${pick.kind}:${pick.path}`)).size === picks.length,
          'Native context picks must be distinct.',
        ),
    }),
  ),
  mutate('ConfigureLocal', z.strictObject({ endpoint: LocalEndpointSchema })),
  mutate('RefreshLocalModels', z.strictObject({ consent: z.literal('explicit') })),
  mutate('SelectLocalModel', LocalModelSelectionSchema),
  mutate('BeginLocalConnectionInput', z.strictObject({ consent: z.literal('explicit') })),
  mutate('CancelLocalConnectionInput', z.strictObject({ operationId: CommandIdSchema })),
  mutate('DisconnectLocal', empty),
  read('GetTaskConversationState', z.strictObject({ taskId: TaskIdSchema })),
  mutate(
    'CreateTaskDiscussion',
    z.strictObject({
      projectId: ProjectIdSchema,
      text: ConversationTextSchema,
      planning: ConversationPlanningSelectionSchema,
      context: ConversationContextRefsSchema.optional(),
    }),
  ),
  mutate(
    'ConfigureTaskConversation',
    z.strictObject({ taskId: TaskIdSchema, planning: ConversationPlanningSelectionSchema }),
  ),
  mutate(
    'AdoptTaskPlan',
    z.strictObject({ taskId: TaskIdSchema, proposalId: MessageIdSchema, proposalHash: HashSchema }),
  ),
  read(
    'GetTaskConversation',
    z.strictObject({ taskId: TaskIdSchema, beforeCursor: CursorSchema.optional() }),
  ),
  mutate(
    'SendTaskMessage',
    z.strictObject({
      taskId: TaskIdSchema,
      text: ConversationTextSchema,
      context: ConversationContextRefsSchema.optional(),
    }),
  ),
  mutate(
    'QueueTaskGuidance',
    z.strictObject({
      taskId: TaskIdSchema,
      text: ConversationTextSchema,
      context: ConversationContextRefsSchema.optional(),
    }),
  ),
  mutate(
    'AnswerTaskQuestion',
    z.strictObject({
      taskId: TaskIdSchema,
      questionId: MessageIdSchema,
      text: ConversationTextSchema,
      context: ConversationContextRefsSchema.optional(),
    }),
  ),
  mutate('RegisterProject', z.strictObject({ path: text })),
  mutate('ObserveUsage', z.strictObject({ family: z.literal('google') })),
  mutate(
    'InitializeGoogleAcp',
    z.strictObject({ profileId: z.literal('google-acp-v1'), consent: z.literal('explicit') }),
  ),
  mutate(
    'AuthenticateGoogleAcp',
    z.strictObject({
      profileId: z.literal('google-acp-v1'),
      proofId: ArtifactIdSchema,
      method: z.literal('oauth-personal'),
      consent: z.literal('explicit'),
    }),
  ),
  mutate(
    'DiscoverGoogleAcp',
    z.strictObject({
      profileId: z.literal('google-acp-v1'),
      proofId: ArtifactIdSchema,
      consent: z.literal('explicit'),
    }),
  ),
  mutate(
    'StopGoogleAcpSetup',
    z.strictObject({ profileId: z.literal('google-acp-v1'), operationId: CommandIdSchema }),
  ),
  read('InspectSource', z.strictObject({ projectId: ProjectIdSchema })),
  mutate(
    'CreateTask',
    z.strictObject({
      projectId: ProjectIdSchema,
      title: label,
      outcome: text,
      criteria: z.array(text).min(1).max(100),
    }),
  ),
  mutate(
    'AmendTask',
    z.strictObject({
      taskId: TaskIdSchema,
      title: label,
      outcome: text,
      criteria: z.array(text).min(1).max(100),
    }),
  ),
  mutate(
    'PrepareRun',
    z.strictObject({
      taskId: TaskIdSchema,
      policy: PolicySchema,
      roles: z.array(RoleSchema).min(1).max(6),
    }),
  ),
  mutate('PrepareNativeRun', NativePreparationPayloadSchema),
  mutate('PrepareCombinedRun', PrepareCombinedRunPayloadSchema),
  mutate(
    'AssembleCombinedCandidate',
    z.strictObject({
      taskId: TaskIdSchema,
      runId: RunIdSchema,
      preparationId: ArtifactIdSchema,
    }),
  ),
  mutate('PrepareNativeHandoff', NativeHandoffPreparationPayloadSchema),
  mutate(
    'StartNativeHandoff',
    z.strictObject({ taskId: TaskIdSchema, runId: RunIdSchema, preparationId: ArtifactIdSchema }),
  ),
  mutate(
    'PrepareCandidateEvaluation',
    z.discriminatedUnion('checkRecipeId', [
      z.strictObject({ ...evaluationFields, checkRecipeId: z.literal('node-tests-v1') }),
      z.strictObject({
        ...evaluationFields,
        checkRecipeId: z.literal('project-node-tests-v1'),
        testFiles: ProjectNodeTestFilesSchema,
      }),
      z.strictObject({ ...evaluationFields, checkRecipeId: z.literal('crewkite-verify-v1') }),
    ]),
  ),
  mutate(
    'StartCandidateEvaluation',
    z.strictObject({
      taskId: TaskIdSchema,
      candidateId: CandidateIdSchema,
      preparationId: ArtifactIdSchema,
    }),
  ),
  mutate(
    'StartCandidateReview',
    z.strictObject({
      taskId: TaskIdSchema,
      candidateId: CandidateIdSchema,
      preparationId: ArtifactIdSchema,
    }),
  ),
  mutate('StartRun', runRef),
  mutate('ResumeRun', runRef),
  mutate('PauseAdmissions', runRef),
  mutate('StopRun', runRef),
  mutate('SwitchRoute', z.strictObject({ ...runRef.shape, routeId: RouteIdSchema })),
  mutate(
    'ResolveApproval',
    z.strictObject({ binding: ApprovalBindingSchema, decision: z.enum(['approved', 'denied']) }),
  ),
  mutate(
    'AcceptCandidate',
    z.strictObject({
      taskId: TaskIdSchema,
      candidateId: CandidateIdSchema,
      destinationRef: z.string().regex(/^refs\/heads\/[a-z0-9][a-z0-9/-]{0,199}$/),
    }),
  ),
  mutate('ExportPatch', z.strictObject({ taskId: TaskIdSchema, candidateId: CandidateIdSchema })),
  read('GetSnapshot', empty),
  read('Subscribe', z.strictObject({ after: CursorSchema })),
  read('GetChanges', taskRef),
  read(
    'GetArtifact',
    z.strictObject({
      artifactId: ArtifactIdSchema,
      offset: RevisionSchema,
      limit: z.number().int().min(1).max(65536),
    }),
  ),
  read('GetUsage', empty),
  read('GetHealth', empty),
  read('ExportDiagnostics', z.strictObject({ previewHash: HashSchema })),
]);
export const CheckResultSchema = z
  .strictObject({
    candidateId: CandidateIdSchema,
    candidateHash: HashSchema,
    definitionHash: HashSchema,
    evaluator: label,
    review: ReviewResultSchema.optional(),
    passed: z.boolean(),
    artifactId: ArtifactIdSchema,
  })
  .superRefine((result, context) => {
    if (
      result.review &&
      (result.review.job.candidateId !== result.candidateId ||
        result.review.job.candidateHash !== result.candidateHash ||
        result.passed !== (result.review.outcome === 'passed'))
    )
      context.addIssue({
        code: 'custom',
        message: 'Review evidence must bind the same candidate and outcome.',
        path: ['review'],
      });
  });
export const CheckEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('start'), version: z.literal(1) }),
  z.strictObject({
    type: z.literal('test'),
    file: z.string().max(4096),
    name: z.string().max(4096),
    kind: z.enum(['test', 'suite']).optional(),
    passed: z.boolean(),
    skipped: z.boolean(),
    todo: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('summary'),
    file: text.nullable(),
    success: z.boolean(),
    counts: z.strictObject({
      tests: RevisionSchema,
      passed: RevisionSchema,
      failed: RevisionSchema,
      cancelled: RevisionSchema,
      skipped: RevisionSchema,
      todo: RevisionSchema,
      suites: RevisionSchema,
    }),
  }),
  z.strictObject({
    type: z.literal('output'),
    channel: z.enum(['stdout', 'stderr']),
    text: z.string().max(65536),
  }),
  z.strictObject({ type: z.literal('end') }),
]);
export type CheckEvent = z.infer<typeof CheckEventSchema>;

export const CandidateEvaluationStartReasonSchema = z.enum([
  'available',
  'already-started',
  'checks-required',
  'checks-failed',
  'expired',
  'paused',
  'ownership-unknown',
  'not-stopped',
  'preparation-changed',
  'consent-unavailable',
  'profile-unavailable',
  'grant-unavailable',
  'budget-exhausted',
]);
const candidateEvaluationStart = z
  .strictObject({
    available: z.boolean(),
    reason: CandidateEvaluationStartReasonSchema,
  })
  .refine((value) => value.available === (value.reason === 'available'));
const localAcceptance = z
  .strictObject({
    available: z.boolean(),
    reason: z.enum([
      'available',
      'evidence-incomplete',
      'ownership-unknown',
      'candidate-changed',
      'source-changed',
      'git-identity-missing',
      'approval-pending',
      'publication-prepared',
      'accepted',
    ]),
  })
  .refine((value) => value.available === (value.reason === 'available'))
  .default({ available: false, reason: 'evidence-incomplete' });
const verificationExecutable = z.strictObject({ version: label, sha256: HashSchema });
export const CrewKiteVerifyPreviewSchema = z.strictObject({
  toolchainHash: HashSchema,
  baselineHash: HashSchema,
  lockHash: HashSchema,
  platform: z.literal('darwin'),
  arch: z.literal('arm64'),
  executables: z.strictObject({
    node: verificationExecutable,
    electron: verificationExecutable,
    git: verificationExecutable,
  }),
  stages: z.tuple([
    z.literal('policy'),
    z.literal('lint'),
    z.literal('types'),
    z.literal('node-tests'),
    z.literal('build'),
    z.literal('desktop'),
  ]),
  maximumMinutes: z.literal(5),
});
export type CrewKiteVerifyPreview = z.infer<typeof CrewKiteVerifyPreviewSchema>;
export const CandidateEvaluationPreviewSchema = z
  .strictObject({
    taskId: TaskIdSchema,
    runId: RunIdSchema,
    candidateId: CandidateIdSchema,
    candidateHash: HashSchema,
    preparationId: ArtifactIdSchema,
    recipe: z.enum(['node-tests-v1', 'project-node-tests-v1', 'crewkite-verify-v1']),
    verification: CrewKiteVerifyPreviewSchema.optional(),
    testFiles: z
      .array(
        z.strictObject({
          path: ProjectNodeTestPathSchema,
          hash: HashSchema,
          bytes: RevisionSchema,
          mode: z.enum(['100644', '100755']),
        }),
      )
      .max(32)
      .default([]),
    definitionHash: HashSchema,
    target: z
      .strictObject({
        path: NativeTargetPathSchema,
        baseHash: HashSchema,
        candidateContentHash: HashSchema,
      })
      .optional(),
    repository: NativeRepositoryScopeSchema.optional(),
    reviewer: z.strictObject({
      profileId: label,
      assignedRole: ReviewMethodSchema.shape.reviewerRole,
      methodId: ReviewMethodIdSchema,
      cycle: z.literal(1),
      independence: z.literal('process-only'),
    }),
    creditPolicy: z.enum(['ordinary', 'existing-credits']),
    expiresAt: TimestampSchema,
    remainingBudgets: RemainingBudgetsSchema,
    allowance: z.strictObject({
      source: z.literal('supplemental-evaluation'),
      localChecks: z.literal(1),
      nativeReviews: z.literal(1),
    }),
    stage: z.enum([
      'prepared',
      'checking',
      'check-failed',
      'awaiting-review',
      'reviewing',
      'reviewed',
      'blocked',
    ]),
    check: z.strictObject({ artifactId: ArtifactIdSchema, passed: z.boolean() }).nullable(),
    review: z
      .strictObject({
        artifactId: ArtifactIdSchema,
        outcome: z.enum(['passed', 'failed', 'blocked']),
      })
      .nullable(),
    checkStart: candidateEvaluationStart,
    reviewStart: candidateEvaluationStart,
    localAcceptance,
  })
  .superRefine((value, context) => {
    if (!!value.target === !!value.repository)
      context.addIssue({ code: 'custom', message: 'Evaluation needs one exact source scope.' });
    const paths = value.testFiles.map((file) => file.path);
    if (
      (value.recipe === 'project-node-tests-v1' && paths.length === 0) ||
      (value.recipe !== 'project-node-tests-v1' && paths.length !== 0) ||
      new Set(paths).size !== paths.length
    )
      context.addIssue({ code: 'custom', message: 'Check files must match the selected recipe.' });
    if (
      (value.recipe === 'crewkite-verify-v1' && !value.verification) ||
      (value.recipe !== 'crewkite-verify-v1' && Object.hasOwn(value, 'verification'))
    )
      context.addIssue({ code: 'custom', message: 'Verification must match the selected recipe.' });
  });
export type CandidateEvaluationPreview = z.infer<typeof CandidateEvaluationPreviewSchema>;

export const CombinedActionReasonSchema = z.enum([
  'available',
  'already-started',
  'baseline-required',
  'writers-incomplete',
  'checks-required',
  'checks-failed',
  'review-required',
  'review-failed',
  'budget-exhausted',
  'paused',
  'owner-active',
  'ownership-unknown',
  'source-changed',
  'task-changed',
  'preparation-changed',
  'scope-changed',
  'profile-unavailable',
  'authority-unavailable',
  'ref-changed',
  'stopped',
  'accepted',
]);
const combinedAvailability = z
  .strictObject({
    available: z.boolean(),
    reason: CombinedActionReasonSchema,
  })
  .refine((value) => value.available === (value.reason === 'available'));
export const CombinedDispatchPhaseSchema = z.enum([
  'baseline',
  'writer-0',
  'writer-1',
  'replay-0',
  'replay-1',
  'final-check',
  'review',
]);
const combinedDispatchPreview = z
  .strictObject({
    phase: CombinedDispatchPhaseSchema,
    maximumMinutes: z.number().int().min(1).max(5),
    state: z.enum(['reserved', 'running', 'passed', 'failed', 'stopped', 'unknown']),
    attemptId: AttemptIdSchema.nullable(),
    checkArtifactId: ArtifactIdSchema.nullable(),
  })
  .refine(
    (dispatch) => (dispatch.state === 'reserved') === (dispatch.attemptId === null),
    'A dispatched slot needs its actual attempt.',
  );
const combinedMemberPreview = z.strictObject({
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  scope: z.tuple([NativeTargetPathSchema]),
  start: combinedAvailability,
});
export const CombinedRunPreviewSchema = z
  .strictObject({
    taskId: TaskIdSchema,
    runId: RunIdSchema,
    preparationId: ArtifactIdSchema,
    manifestHash: HashSchema,
    revision: RevisionSchema,
    generation: RevisionSchema,
    evaluationSelection: z.strictObject({
      recipeId: z.literal('project-node-tests-v1'),
      testFiles: ProjectNodeTestFilesSchema,
      reviewer: z.strictObject({
        profileId: z.literal('openai-file-v1'),
        methodId: z.literal('keep-it-simple'),
        cycles: z.literal(1),
      }),
      creditPolicy: z.enum(['ordinary', 'existing-credits']),
    }),
    members: z.tuple([combinedMemberPreview, combinedMemberPreview]),
    phase: z.enum([
      'prepared',
      'baseline',
      'writers',
      'assembling',
      'awaiting-evaluation',
      'checking',
      'awaiting-review',
      'reviewing',
      'ready',
      'paused',
      'stopping',
      'stopped',
      'blocked',
      'unknown',
      'accepted',
    ]),
    blocker: CombinedActionReasonSchema.nullable(),
    dispatches: z.array(combinedDispatchPreview).length(7),
    candidate: z.strictObject({ id: CandidateIdSchema, hash: HashSchema }).nullable(),
    remainingBudgets: RemainingBudgetsSchema,
    start: combinedAvailability,
    assemble: combinedAvailability,
    evaluate: combinedAvailability,
    review: combinedAvailability,
    accept: combinedAvailability,
  })
  .superRefine((preview, context) => {
    if (
      preview.dispatches.some(
        (dispatch, index) => dispatch.phase !== CombinedDispatchPhaseSchema.options[index],
      ) ||
      new Set([preview.taskId, ...preview.members.map((member) => member.taskId)]).size !== 3 ||
      new Set([preview.runId, ...preview.members.map((member) => member.runId)]).size !== 3 ||
      preview.members[0].scope[0] === preview.members[1].scope[0] ||
      ([
        'awaiting-evaluation',
        'checking',
        'awaiting-review',
        'reviewing',
        'ready',
        'accepted',
      ].includes(preview.phase) &&
        !preview.candidate)
    )
      context.addIssue({
        code: 'custom',
        message: 'Combined preview must preserve distinct members and its ordered dispatch ledger.',
      });
  });
export type CombinedRunPreview = z.infer<typeof CombinedRunPreviewSchema>;

export const SnapshotSchema = z
  .strictObject({
    usageReaders: z.array(UsageReaderSchema).max(1).default([]),
    googleAcpSetup: GoogleAcpSetupSchema.nullable().default(null),
    localSetup: LocalSetupSchema.nullable().optional(),
    nativeProfiles: z
      .array(NativeProfileSchema)
      .max(6)
      .refine((profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length)
      .default([]),
    nativeRuns: z.array(NativeRunSchema).max(10000).default([]),
    candidateEvaluations: z.array(CandidateEvaluationPreviewSchema).max(10000).default([]),
    combinedRuns: z.array(CombinedRunPreviewSchema).max(1000).default([]),
    protocol: z.literal(1),
    cursor: CursorSchema,
    projects: z.array(ProjectSchema).max(1000),
    tasks: z.array(TaskSchema).max(10000),
    runs: z.array(RunSchema).max(10000),
    attempts: z.array(AttemptSchema).max(10000),
    routes: z.array(RouteSchema).max(100),
    artifacts: z.array(ArtifactSchema).max(10000),
    evidence: z.array(CheckResultSchema).max(10000),
    approvals: z.array(ApprovalSchema).max(1000),
    usage: z.array(WindowSchema).max(1000),
    candidates: z.array(CandidateSchema).max(1000),
    reviewJobs: z.array(ReviewJobSchema).max(1000).optional(),
  })
  .superRefine((snapshot, ctx) => {
    const combinedMembers = new Set<string>();
    for (const combined of snapshot.combinedRuns) {
      const references = [{ taskId: combined.taskId, runId: combined.runId }, ...combined.members];
      const tasks = references.map((reference) =>
        snapshot.tasks.find((task) => task.id === reference.taskId),
      );
      if (
        references.some((reference, index) => {
          const duplicate = combinedMembers.has(reference.taskId);
          combinedMembers.add(reference.taskId);
          return (
            duplicate ||
            tasks[index]?.runId !== reference.runId ||
            !snapshot.runs.some(
              (run) => run.id === reference.runId && run.taskId === reference.taskId,
            )
          );
        }) ||
        tasks.some((task) => !task || task.projectId !== tasks[0]?.projectId) ||
        !snapshot.artifacts.some((artifact) => artifact.id === combined.preparationId) ||
        (combined.candidate &&
          !snapshot.candidates.some(
            (candidate) =>
              candidate.id === combined.candidate?.id &&
              candidate.hash === combined.candidate.hash &&
              candidate.taskId === combined.taskId,
          )) ||
        combined.dispatches.some(
          (dispatch, index) =>
            dispatch.attemptId &&
            !snapshot.attempts.some(
              (attempt) =>
                attempt.id === dispatch.attemptId &&
                attempt.runId ===
                  (index === 1 || index === 2 ? combined.members[index - 1].runId : combined.runId),
            ),
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Combined preview must bind its saved group and actual dispatches.',
        });
    }
    const seen = new Set<string>();
    for (const native of snapshot.nativeRuns) {
      if (seen.has(native.runId) || !snapshot.runs.some((run) => run.id === native.runId))
        ctx.addIssue({ code: 'custom', message: 'Native run capability must name one saved run.' });
      seen.add(native.runId);
    }
    const evaluated = new Set<string>();
    for (const evaluation of snapshot.candidateEvaluations) {
      const task = snapshot.tasks.find((value) => value.id === evaluation.taskId);
      const candidate = snapshot.candidates.find((value) => value.id === evaluation.candidateId);
      if (
        evaluated.has(evaluation.taskId) ||
        !task ||
        !candidate ||
        task.runId !== evaluation.runId ||
        !snapshot.runs.some((run) => run.id === evaluation.runId && run.taskId === task.id) ||
        candidate?.taskId !== task.id ||
        candidate.hash !== evaluation.candidateHash ||
        ![evaluation.preparationId, evaluation.check?.artifactId, evaluation.review?.artifactId]
          .filter(Boolean)
          .every((id) => snapshot.artifacts.some((artifact) => artifact.id === id))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Evaluation preview must bind one current saved candidate.',
        });
      evaluated.add(evaluation.taskId);
    }
  });

export const ChangeFileSchema = z.strictObject({
  path: text,
  status: z.enum(['added', 'modified', 'deleted']),
  binary: z.boolean(),
  oversized: z.boolean(),
  additions: RevisionSchema,
  deletions: RevisionSchema,
});
export const SourceFileDetailSchema = z
  .strictObject({
    path: RelativeSourcePathSchema,
    status: z.enum(['added', 'modified', 'deleted', 'type-changed', 'unmerged', 'untracked']),
    staged: z.boolean(),
    unstaged: z.boolean(),
  })
  .refine(
    (file) =>
      file.status === 'untracked' ? !file.staged && file.unstaged : file.staged || file.unstaged,
    'Source status must describe a changed file.',
  );
export const SourceDetailsSchema = z
  .strictObject({
    files: z.array(SourceFileDetailSchema).max(200),
    omittedDirty: RevisionSchema,
    omittedUntracked: RevisionSchema,
  })
  .refine(
    (details) => new TextEncoder().encode(JSON.stringify(details)).byteLength <= 65_536,
    'Source details exceed the encoded byte limit.',
  );
const sourceInspection = z
  .strictObject({
    kind: z.literal('source'),
    source: SourceSchema,
    details: SourceDetailsSchema.optional(),
  })
  .refine(
    ({ source, details }) =>
      !details ||
      (details.files.filter((file) => file.status !== 'untracked').length + details.omittedDirty ===
        source.dirtyCount &&
        details.files.filter((file) => file.status === 'untracked').length +
          details.omittedUntracked ===
          source.untrackedCount &&
        new Set(details.files.map((file) => file.path)).size === details.files.length),
    'Source details must match the full counts without repeated paths.',
  );
export const ReadDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conversation-state'), state: TaskConversationStateSchema }),
  ConversationPageSchema,
  z.strictObject({ kind: z.literal('google-acp-setup'), setup: GoogleAcpSetupSchema }),
  sourceInspection,
  z.strictObject({ kind: z.literal('snapshot'), snapshot: SnapshotSchema }),
  z.strictObject({
    kind: z.literal('changes'),
    taskId: TaskIdSchema,
    candidateId: CandidateIdSchema.nullable(),
    artifactId: ArtifactIdSchema,
    files: z.array(ChangeFileSchema).max(1000),
    diff: z.string().max(262144),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('artifact'),
    artifact: ArtifactSchema,
    offset: RevisionSchema,
    content: z.string().max(131072),
    encoding: z.enum(['utf8', 'base64']),
    eof: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('usage'), windows: z.array(WindowSchema).max(1000) }),
  z.strictObject({
    kind: z.literal('health'),
    status: z.enum(['ready', 'degraded', 'unsupported']),
    version: label,
    blockers: z.array(text).max(100),
  }),
  z.strictObject({
    kind: z.literal('diagnostics'),
    artifact: ArtifactSchema,
    previewHash: HashSchema,
  }),
]);
export const CommandResultSchema = z.strictObject({
  outcome: OutcomeSchema,
  reason: text.optional(),
  entity: z
    .union([TaskSchema, ProjectSchema, RunSchema, ApprovalSchema, CandidateSchema, ArtifactSchema])
    .optional(),
  data: ReadDataSchema.optional(),
  revision: RevisionSchema.optional(),
  next: text.optional(),
});
const event = <T extends string, S extends z.ZodType>(type: T, payload: S) =>
  z.strictObject({
    protocol: z.literal(1),
    id: EventIdSchema,
    cursor: CursorSchema,
    at: TimestampSchema,
    taskId: TaskIdSchema.nullable(),
    revision: RevisionSchema,
    type: z.literal(type),
    payload,
  });
export const AcpActivitySchema = z
  .strictObject({
    sessionId: acpIdentifier,
    sessionUpdate: z.enum([
      'user_message_chunk',
      'agent_message_chunk',
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
      'plan',
      'available_commands_update',
      'current_mode_update',
      'config_option_update',
      'usage_update',
      'session_info_update',
    ]),
    toolCallId: acpIdentifier.optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional(),
    locations: z
      .array(
        z.strictObject({ path: NativeTargetPathSchema, line: RevisionSchema.min(1).optional() }),
      )
      .max(100)
      .optional(),
    diffPaths: z.array(NativeTargetPathSchema).max(100).optional(),
  })
  .refine(
    (activity) =>
      ['tool_call', 'tool_call_update'].includes(activity.sessionUpdate)
        ? !!activity.toolCallId
        : !activity.toolCallId && !activity.status && !activity.locations && !activity.diffPaths,
    'Tool activity needs its exact call identity.',
  );
const outputFields = {
  attemptId: AttemptIdSchema,
  generation: RevisionSchema,
  text: z.string().max(65536),
};
export const AttemptOutputSchema = z.union([
  z.strictObject({ ...outputFields, channel: z.enum(['stdout', 'stderr']) }),
  z.strictObject({ ...outputFields, channel: z.literal('acp'), acp: AcpActivitySchema }),
]);
export const EventSchema = z.discriminatedUnion('type', [
  event('combined.updated', CombinedRunPreviewSchema),
  event('conversation.entry', ConversationEntrySchema),
  event('task.created', TaskSchema),
  event('task.updated', TaskSchema),
  event('run.prepared', RunSchema),
  event('run.admitted', RunSchema),
  event('attempt.launched', AttemptSchema),
  event('attempt.output', AttemptOutputSchema),
  event('approval.requested', ApprovalSchema),
  event('approval.resolved', ApprovalSchema),
  event('usage.observed', ObservationSchema),
  event(
    'route.reserve_reached',
    z.strictObject({ routeId: RouteIdSchema, windowId: label, reason: text }),
  ),
  event('admissions.paused', z.strictObject({ runId: RunIdSchema, reason: text })),
  event('handoff.sealed', SealedHandoffPacketSchema),
  event('attempt.stopping', AttemptSchema),
  event('attempt.stopped', AttemptSchema),
  event('ownership.unknown', AttemptSchema),
  event('run.interrupted', z.strictObject({ runId: RunIdSchema, reason: text })),
  event('candidate.sealed', CandidateSchema),
  event('check.completed', CheckResultSchema),
  event('review.completed', CheckResultSchema),
  event(
    'candidate.accepted',
    z.strictObject({ candidateId: CandidateIdSchema, destinationRef: text }),
  ),
  event('export.created', ArtifactSchema),
  event('run.failed', z.strictObject({ runId: RunIdSchema, reason: text })),
]);
export const FakeWorkerInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('review'),
    job: ScriptedReviewJobSchema,
    scratchPath: text,
    criteria: z.array(text).min(1).max(100),
    guidance: GuidanceSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('start'),
    attemptId: AttemptIdSchema,
    generation: RevisionSchema,
    scratchPath: text,
    scenario: z.enum(['complete', 'approval', 'approval-reserve', 'reserve', 'crash', 'stubborn']),
    outcome: text,
    handoff: SealedHandoffPacketSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('approval'),
    binding: ApprovalBindingSchema,
    decision: z.enum(['approved', 'denied']),
  }),
  z.strictObject({ type: z.literal('checkpoint') }),
  z.strictObject({ type: z.literal('stop') }),
]);
export const FakeWorkerEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('review'), result: ReviewResultSchema }),
  z.strictObject({
    type: z.literal('ready'),
    attemptId: AttemptIdSchema,
    generation: RevisionSchema,
  }),
  z.strictObject({
    type: z.literal('output'),
    channel: z.enum(['stdout', 'stderr']),
    text: z.string().max(65536),
  }),
  z.strictObject({
    type: z.literal('approval'),
    action: GrantSchema.shape.action,
    target: text,
    consequence: text,
  }),
  z.strictObject({ type: z.literal('usage'), observation: ObservationSchema }),
  z.strictObject({ type: z.literal('checkpoint'), summary: text }),
  z.strictObject({
    type: z.literal('terminal'),
    outcome: z.enum(['completed', 'stopped', 'failed']),
    reason: text,
  }),
]);
export const HandshakeSchema = z.strictObject({
  type: z.literal('hello'),
  protocol: z.literal(1),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  actor,
});
export const TransportMessageSchema = z.discriminatedUnion('type', [
  HandshakeSchema,
  z.strictObject({ type: z.literal('welcome'), protocol: z.literal(1), cursor: CursorSchema }),
  z.strictObject({ type: z.literal('command'), command: CommandSchema }),
  z.strictObject({ type: z.literal('result'), key: CommandIdSchema, result: CommandResultSchema }),
  z.strictObject({ type: z.literal('snapshot'), key: CommandIdSchema, snapshot: SnapshotSchema }),
  z.strictObject({ type: z.literal('event'), event: EventSchema }),
  z.strictObject({
    type: z.literal('resync'),
    reason: z.literal('history-gap'),
    cursor: CursorSchema,
  }),
  z.strictObject({
    type: z.literal('error'),
    reason: z.enum(['protocol-mismatch', 'unauthorized', 'invalid-frame', 'unsupported']),
    next: text,
  }),
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type TransportMessage = z.infer<typeof TransportMessageSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type Window = z.infer<typeof WindowSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type ResolvedPolicy = z.infer<typeof ResolvedPolicySchema>;
export type RouterDecision = z.infer<typeof RouterDecisionSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;
export type SealedHandoffPacket = z.infer<typeof SealedHandoffPacketSchema>;
export type Event = z.infer<typeof EventSchema>;
export type FakeWorkerInput = z.infer<typeof FakeWorkerInputSchema>;
export type FakeWorkerEvent = z.infer<typeof FakeWorkerEventSchema>;
export { canonicalJson } from './canonical.ts';

export type Grant = z.infer<typeof GrantSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type ReadData = z.infer<typeof ReadDataSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type RemainingBudgets = z.infer<typeof RemainingBudgetsSchema>;

export type Guidance = z.infer<typeof GuidanceSchema>;
export type ReviewMethod = z.infer<typeof ReviewMethodSchema>;
export type ReviewJob = z.infer<typeof ReviewJobSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export type SourceDetails = z.infer<typeof SourceDetailsSchema>;
export type SourceFileDetail = z.infer<typeof SourceFileDetailSchema>;
export type NativeHandoffTarget = z.infer<typeof NativeHandoffTargetSchema>;
export type NativeHandoffPreview = z.infer<typeof NativeHandoffPreviewSchema>;
