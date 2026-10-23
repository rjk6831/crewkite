import { z } from 'zod';
import {
  AgentEventSchema,
  ChatCatalogReadSchema,
  ChatChangesReadSchema,
  ChatFamilySchema,
  ChatRoleSchema,
  ChatThreadReadSchema,
  ChatThreadSchema,
  ChatTurnIdSchema,
  ChatTurnSchema,
  ConfigureChatThreadPayloadSchema,
  HandoffChatThreadPayloadSchema,
  ReadChatCatalogPayloadSchema,
  ReadChatChangesPayloadSchema,
  ReadChatThreadPayloadSchema,
  ResolveChatPermissionPayloadSchema,
  SendChatMessagePayloadSchema,
  StopChatTurnPayloadSchema,
} from './chat.ts';

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
export const NativeTargetContextLinesSchema = z
  .strictObject({ start: RevisionSchema.min(1), end: RevisionSchema.min(1) })
  .refine(({ start, end }) => end >= start, 'Context lines need an inclusive ordered range.');
export const ProjectNodeTestPathSchema = NativeTargetPathSchema.refine(
  (path) => !path.startsWith('-') && !/[?*[\]{}]/.test(path),
  'Node tests need exact relative file paths without options or globs.',
);
export const ProjectNodeTestFilesSchema = z
  .array(ProjectNodeTestPathSchema)
  .min(1)
  .max(32)
  .refine((paths) => new Set(paths).size === paths.length, 'Node test files must be distinct.');
export const ProjectPythonTestPathSchema = NativeTargetPathSchema.refine(
  (path) => path.endsWith('.py') && !path.startsWith('-') && !/[?*[\]{}]/.test(path),
  'Python tests need exact relative .py paths without options or globs.',
);
export const ProjectPythonTestFilesSchema = z
  .array(ProjectPythonTestPathSchema)
  .min(1)
  .max(32)
  .refine((paths) => new Set(paths).size === paths.length, 'Python test files must be distinct.');
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
  maximumTaskMs: z.literal(600000),
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
  id: z.enum(['anthropic-file-v1', 'anthropic-file-compact-v1']),
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
export const LocalAuthModeSchema = z.enum(['token', 'none']);
export const LocalObservedModelBindingSchema = z.strictObject({
  authMode: LocalAuthModeSchema.optional(),
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
    authMode: LocalAuthModeSchema.optional(),
    connected: z.boolean().optional(),
    operation: LocalOperationSchema.nullable(),
    generation: z.enum(['idle', 'active', 'unknown']),
    observation: LocalModelObservationSchema.nullable(),
    selection: LocalModelSelectionSchema.nullable(),
    reason: z
      .enum([
        'unconfigured',
        'connection-required',
        'connection-unavailable',
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
          !setup.connected &&
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
  .refine(
    (setup) =>
      setup.authMode === 'none'
        ? !setup.secretConfigured
        : setup.connected === undefined || setup.connected === setup.secretConfigured,
    'Local connection readiness must match its explicit authentication mode.',
  )
  .refine(localProjectionFits, 'Local setup exceeds its encoded byte bound.');
export type LocalSetup = z.infer<typeof LocalSetupSchema>;
export const LocalHardwareStatusSchema = z
  .strictObject({
    cpuModel: localText(200).nullable(),
    logicalCores: RevisionSchema.min(1).max(4096).nullable(),
    architecture: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,32}$/)
      .nullable(),
    platform: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,32}$/)
      .nullable(),
    totalMemoryBytes: RevisionSchema.min(1).nullable(),
    availableMemoryBytes: RevisionSchema.nullable(),
    sampledAt: TimestampSchema,
  })
  .refine(
    (status) =>
      status.availableMemoryBytes === null ||
      (status.totalMemoryBytes !== null && status.availableMemoryBytes <= status.totalMemoryBytes),
    'Available Local memory needs a valid total memory bound.',
  );
export type LocalHardwareStatus = z.infer<typeof LocalHardwareStatusSchema>;
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
    maximumOutputTokens: z.union([z.literal(2048), z.literal(4096)]),
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
  'acp-setup-timeout',
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
    maximumTaskMs: z.union([z.literal(300000), z.literal(600000)]),
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
      'discovery-required',
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
  'anthropic-file-compact-v1',
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
    maximumTaskMs: z.number().int().min(2001).max(600000).optional(),
    quotaRetry: z
      .strictObject({
        available: z.boolean(),
        mode: z.enum(['manual', 'automatic']),
        resetsAt: TimestampSchema,
      })
      .optional(),
    handoff: NativeHandoffPreviewSchema.optional(),
    repository: NativeRepositoryScopeSchema.optional(),
    execution: NativeRepositoryExecutionSchema.optional(),
    modelRequest: ConversationModelRequestSchema.optional(),
    target: z
      .strictObject({
        path: NativeTargetPathSchema,
        baseHash: HashSchema,
        bytes: RevisionSchema.max(65536),
      })
      .optional(),
    acp: GoogleAcpSelectionSchema.optional(),
    contextLines: NativeTargetContextLinesSchema.optional(),
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
          !run.contextLines &&
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
        : !run.repository && !run.execution && !run.modelRequest,
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
  )
  .refine(
    (run) =>
      !run.quotaRetry ||
      (['anthropic-file-v1', 'anthropic-file-compact-v1'].includes(run.profileId) &&
        run.stage === 'retain-only' &&
        !!run.target),
    'Quota retry is available only for retained Anthropic file work.',
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
export const AnthropicUsageReadingSchema = z.strictObject({
  source: z.literal('native-local-command'),
  status: z.enum(['reported', 'unavailable']),
  receivedAt: TimestampSchema,
  observedAt: z.null(),
  freshness: z.literal('unknown'),
  windows: z
    .array(
      z.strictObject({
        kind: label,
        group: label,
        percent: z.number().finite().min(0).max(100),
        resets_at: TimestampSchema.nullable(),
        scope: z
          .strictObject({
            model: z.strictObject({ display_name: label }).nullable().optional(),
            surface: z.strictObject({ display_name: label }).nullable().optional(),
          })
          .nullable()
          .optional(),
        severity: label,
        is_active: z.boolean(),
      }),
    )
    .max(64),
  extraUsage: z
    .strictObject({
      is_enabled: z.boolean(),
      monthly_limit: z.number().finite().nonnegative().nullable(),
      used_credits: z.number().finite().nonnegative().nullable(),
      utilization: z.number().finite().nonnegative().nullable(),
      currency: label.nullable().optional(),
    })
    .nullable(),
  modelTurns: z.literal(0),
  qualified: z.literal(false),
});
export const AnthropicUsageTrustSchema = z.strictObject({
  scopeHash: HashSchema,
  clientSha256: HashSchema,
  command: z.literal('/usage'),
  generationRequest: z.literal(false),
  policyHooks: z.literal('covered-by-native-client-trust'),
  accepted: z.boolean(),
});
export const UsageReaderSchema = z
  .strictObject({
    id: z.enum(['google-usage-v1', 'openai-usage-v1', 'anthropic-usage-v1']),
    family: z.enum(['google', 'openai', 'anthropic']),
    clientVersion: label,
    available: z.boolean(),
    reason: z.enum([
      'available',
      'unsupported-platform',
      'native-home-unavailable',
      'client-unavailable',
      'client-build-mismatch',
      'not-configured',
      'configuration-location-unsupported',
    ]),
    readState: z.enum(['idle', 'intent', 'owned', 'quiescent', 'unknown']).optional(),
    readReason: label.nullable().optional(),
    lastRequest: label.nullable().optional(),
    trust: AnthropicUsageTrustSchema.optional(),
    reading: AnthropicUsageReadingSchema.nullable().optional(),
    readingScopeHash: HashSchema.nullable().optional(),
    operationId: CommandIdSchema.nullable().optional(),
    lastObservedAt: TimestampSchema.nullable(),
    lastAttemptAt: TimestampSchema.nullable().optional(),
  })
  .refine(
    (reader) =>
      reader.available === (reader.reason === 'available') &&
      reader.id === `${reader.family}-usage-v1` &&
      (reader.family === 'anthropic' ||
        (!reader.trust &&
          reader.reading === undefined &&
          reader.readingScopeHash === undefined &&
          reader.operationId === undefined)),
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

export const ProjectCommandRecipeSchema = z.enum(['lint', 'test', 'build']);
export const ProjectCommandDeadlineSchema = z
  .number()
  .int()
  .min(1000)
  .max(86400000)
  .default(900000);
const commandArgument = z
  .string()
  .max(8192)
  .refine(
    (value) =>
      value.isWellFormed() &&
      !value.includes('\0') &&
      new TextEncoder().encode(value).byteLength <= 8192,
  );
const commandArguments = z
  .array(commandArgument)
  .max(128)
  .refine(
    (values) =>
      values.reduce((bytes, value) => bytes + new TextEncoder().encode(value).byteLength, 0) <=
      65536,
  );
const commandEnvironment = z
  .partialRecord(
    z.enum(['CI', 'HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TMPDIR', 'TZ']),
    z
      .string()
      .max(4096)
      .refine((value) => value.isWellFormed() && !value.includes('\0')),
  )
  .refine(
    (values) =>
      Object.entries(values).reduce(
        (bytes, [key, value]) =>
          bytes +
          new TextEncoder().encode(key).byteLength +
          new TextEncoder().encode(value ?? '').byteLength,
        0,
      ) <= 16384,
  );
const commandDirectoryRelative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value.isWellFormed() &&
      new TextEncoder().encode(value).byteLength <= 4096 &&
      (value === '.' ||
        (!/[\\:\p{Cc}]/u.test(value) &&
          !value.startsWith('/') &&
          value
            .split('/')
            .every(
              (part) =>
                part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git',
            ))),
  );
const commandExecutable = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value.isWellFormed() &&
      !value.includes('\0') &&
      new TextEncoder().encode(value).byteLength <= 4096,
  );
export const PrepareProjectCommandRequestSchema = z
  .strictObject({
    taskId: TaskIdSchema,
    recipe: ProjectCommandRecipeSchema,
    executable: commandExecutable,
    argv: commandArguments,
    cwdRelative: commandDirectoryRelative.default('.'),
    environment: commandEnvironment.optional(),
    deadlineMs: ProjectCommandDeadlineSchema,
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144);
export const ProjectCommandPreviewSchema = z
  .strictObject({
    version: z.literal(1),
    id: CommandIdSchema,
    taskId: TaskIdSchema,
    taskRevision: RevisionSchema,
    source: SourceSchema,
    sourceMode: z.literal('committed-head'),
    repositoryRoot: z.string().min(1).max(4096),
    scratchRoot: z.string().min(1).max(4096),
    cwd: z.string().min(1).max(4096),
    recipe: ProjectCommandRecipeSchema,
    executable: commandExecutable,
    executableSha256: HashSchema,
    executableIdentity: z.literal('verified-prelaunch-sha256'),
    argv: commandArguments,
    environment: commandEnvironment,
    deadlineMs: ProjectCommandDeadlineSchema,
    nativeTrust: z.literal('required'),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144,
    'Command definition exceeds its encoded limit.',
  );
export type ProjectCommandPreview = z.infer<typeof ProjectCommandPreviewSchema>;
const githubRepository = z.strictObject({
  host: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/),
  owner: z.string().regex(/^(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/),
  name: z.string().regex(/^(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/),
});
const githubId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const githubBinding = {
  repository: githubRepository,
  headSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
};
export const GitHubReadRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...githubBinding, kind: z.literal('pull-request'), pullRequest: githubId }),
  z.strictObject({
    ...githubBinding,
    kind: z.literal('workflow-run'),
    runId: githubId,
    attempt: z.number().int().min(1).max(10000),
  }),
  z.strictObject({
    ...githubBinding,
    kind: z.literal('job-log'),
    runId: githubId,
    attempt: z.number().int().min(1).max(10000),
    jobId: githubId,
  }),
]);
export type GitHubReadRequest = z.infer<typeof GitHubReadRequestSchema>;
export const TaskOperationSummarySchema = z.strictObject({
  id: CommandIdSchema,
  taskId: TaskIdSchema,
  kind: z.enum(['project-command', 'github-read']),
  state: z.enum(['prepared', 'running', 'stopping', 'succeeded', 'failed', 'cancelled', 'unknown']),
  observedAt: TimestampSchema,
  reason: text.nullable(),
  next: text.nullable(),
  definition: ArtifactSchema,
  stdout: ArtifactSchema.nullable(),
  stderr: ArtifactSchema.nullable(),
  result: ArtifactSchema.nullable(),
});
export type TaskOperationSummary = z.infer<typeof TaskOperationSummarySchema>;
export const TaskOperationsRequestSchema = z.strictObject({
  taskId: TaskIdSchema,
  beforeId: CommandIdSchema.optional(),
  limit: z.number().int().min(1).max(20).default(20),
});
export type TaskOperationsRequest = z.input<typeof TaskOperationsRequestSchema>;

const actor = z.strictObject({ id: label, kind: z.enum(['desktop', 'cli', 'controller']) });
const envelope = { protocol: z.literal(1), key: CommandIdSchema, actor };
const mutation = { ...envelope, expectedRevision: RevisionSchema };
const read = <T extends string, S extends z.ZodType>(command: T, payload: S) =>
  z.strictObject({ ...envelope, command: z.literal(command), payload });
export const TaskActivityRequestSchema = z.strictObject({
  taskId: TaskIdSchema,
  beforeCursor: CursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(100),
});
export type TaskActivityRequest = z.input<typeof TaskActivityRequestSchema>;
const mutate = <T extends string, S extends z.ZodType>(command: T, payload: S) =>
  z.strictObject({ ...mutation, command: z.literal(command), payload });
const empty = z.strictObject({});
const taskRef = z.strictObject({ taskId: TaskIdSchema });
export const SnapshotScopeSchema = z.union([
  empty,
  taskRef,
  z.strictObject({ approvalId: ApprovalIdSchema }),
]);
export type SnapshotScope = z.infer<typeof SnapshotScopeSchema>;

export const WorkspaceStampSchema = z.strictObject({
  epoch: z.string().regex(/^[a-f0-9]{32}$/),
  revision: CursorSchema,
});
export type WorkspaceStamp = z.infer<typeof WorkspaceStampSchema>;
export const WorkspaceContinuationSchema = z
  .strictObject({
    version: z.literal(1),
    stamp: WorkspaceStampSchema,
    section: z.enum(['projects', 'tasks']),
    selectionHash: HashSchema,
    afterId: z.union([ProjectIdSchema, TaskIdSchema]).nullable(),
    searchRank: z.number().int().min(0).max(3).optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.section === 'projects' &&
        (value.afterId === null ||
          !value.afterId.startsWith('prj_') ||
          value.searchRank !== undefined)) ||
      (value.section === 'tasks' && value.afterId !== null && !value.afterId.startsWith('tsk_'))
    )
      context.addIssue({
        code: 'custom',
        message: 'A workspace continuation must match its section.',
      });
  });
export type WorkspaceContinuation = z.infer<typeof WorkspaceContinuationSchema>;
const workspacePageRequest = {
  stamp: WorkspaceStampSchema,
  after: WorkspaceContinuationSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
};
export const ProjectPageRequestSchema = z.strictObject({
  ...workspacePageRequest,
  projectId: ProjectIdSchema.optional(),
});
export const TaskPageRequestSchema = z.strictObject({
  ...workspacePageRequest,
  projectId: ProjectIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  query: text.optional(),
});
export type ProjectPageRequest = z.input<typeof ProjectPageRequestSchema>;
export type TaskPageRequest = z.input<typeof TaskPageRequestSchema>;
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
    modelRequest: ConversationModelRequestSchema.optional(),
  }),
  z.strictObject({
    ...nativePreparationFields,
    ...GoogleAcpSelectionSchema.shape,
    profileId: z.literal('google-acp-v1'),
    policy: PolicySchema.refine((policy) => policy.authority !== 'autopilot'),
    creditPolicy: z.literal('ordinary').default('ordinary'),
    billingAttestation: GoogleAcpBillingAttestationSchema,
    permissionMode: z.literal('request-review'),
    maximumTaskMs: z.union([z.literal(300000), z.literal(600000)]).optional(),
    contextLines: NativeTargetContextLinesSchema.optional(),
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
    profileId: z.literal('anthropic-file-compact-v1'),
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
    integration: z.strictObject({ maximumMinutes: LimitsSchema.shape.minutes }).optional(),
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
      4 +
      (plan.integration?.maximumMinutes ?? 1) +
      first.maximumMinutes +
      second.maximumMinutes +
      plan.reviewer.maximumMinutes;
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
    profileId: z.enum(['anthropic-file-v1', 'anthropic-file-compact-v1']),
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
export type ConversationContextRef = z.infer<typeof ConversationContextRefSchema>;
export type ConversationContextRefs = z.infer<typeof ConversationContextRefsSchema>;
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
// Chat messages share the conversation log so one cursor orders every message of a thread.
const chatEntryText = (bytes: number) =>
  z
    .string()
    .min(1)
    .max(bytes)
    .refine(
      (value) =>
        value.isWellFormed() &&
        !value.includes('\0') &&
        new TextEncoder().encode(value).length <= bytes,
      'Chat text needs valid Unicode without null bytes.',
    );
const chatEntryKinds = new Set(['user-message', 'chat-assistant', 'chat-system']);
/** One chat entry must fit a 524288-byte conversation page with its envelope. */
export const MAX_CHAT_ENTRY_BYTES = 520_192;
export const ConversationEntrySchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...conversationEntryFields,
      kind: z.literal('user-message'),
      // Planning input stays bounded by its command payload. Chat input can be longer.
      text: chatEntryText(65_536),
      author: conversationUser,
      context: ConversationContextRefsSchema.optional(),
      attachments: z.array(z.string().min(1).max(4096)).max(32).optional(),
    }),
    z.strictObject({
      ...conversationEntryFields,
      kind: z.literal('chat-assistant'),
      text: chatEntryText(262_144),
      author: z.strictObject({
        kind: z.literal('assistant'),
        turnId: ChatTurnIdSchema,
        family: ChatFamilySchema,
        model: label,
        role: ChatRoleSchema,
      }),
    }),
    z.strictObject({
      ...conversationEntryFields,
      kind: z.literal('chat-system'),
      text: chatEntryText(8192),
      author: z.strictObject({ kind: z.literal('system'), turnId: ChatTurnIdSchema.nullable() }),
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
    if (conversationBytes(entry) > (chatEntryKinds.has(entry.kind) ? MAX_CHAT_ENTRY_BYTES : 73728))
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
export const ConversationContextMeasurementSchema = z.strictObject({
  threadId: conversationModelText(200),
  turnId: conversationModelText(200),
  model: conversationModelText(200),
  usedTokens: z.number().int().nonnegative().safe(),
  capacityTokens: z.number().int().positive().safe().nullable(),
});
export const ConversationContextUsageSchema = ConversationContextMeasurementSchema.omit({
  threadId: true,
  turnId: true,
}).extend({
  observation: conversationModelObservation,
  runId: RunIdSchema,
  attemptId: AttemptIdSchema,
  generation: RevisionSchema,
  observedAt: TimestampSchema,
});
export type ConversationContextUsage = z.infer<typeof ConversationContextUsageSchema>;
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
    contextUsage: ConversationContextMeasurementSchema.optional(),
  })
  .refine(
    (catalog) => conversationBytes(catalog) <= 32768,
    'A model catalog exceeds 32768 encoded bytes.',
  );
export const TaskModelCatalogSchema = z
  .strictObject({
    version: z.literal(1),
    origin: z.literal('connection-metadata'),
    profileId: z.literal('openai-repository-v1'),
    taskId: TaskIdSchema,
    taskRevision: RevisionSchema,
    source: SourceSchema,
    observedAt: TimestampSchema,
    profileHash: HashSchema,
    client: ConversationModelCatalogSchema.shape.client,
    locationHash: HashSchema,
    models: ConversationModelCatalogEntriesSchema,
  })
  .refine(
    (catalog) => conversationBytes(catalog) <= 32768,
    'A task model catalog exceeds 32768 encoded bytes.',
  );
export const ModelCatalogObservationSchema = z.union([
  ConversationModelCatalogSchema,
  TaskModelCatalogSchema,
]);
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
export type TaskModelCatalog = z.infer<typeof TaskModelCatalogSchema>;
export type ModelCatalogObservation = z.infer<typeof ModelCatalogObservationSchema>;
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
    projectModelChoices: ConversationModelChoicesSchema.optional(),
    contextUsage: ConversationContextUsageSchema.nullable().optional(),
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
    if (state.contextUsage && state.contextUsage.runId !== state.currentRunId)
      fail('Context usage must belong to the current run.');
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
        (state.activeAttempt
          ? !['intent', 'running', 'stopping'].includes(state.activeAttempt.state)
          : state.purpose !== 'execution' || ['unknown', 'stopping'].includes(state.phase)))
    )
      fail('Queued input requires a known current owner or a quiescent execution run.');
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
  mutate('SendChatMessage', SendChatMessagePayloadSchema),
  mutate('ResolveChatPermission', ResolveChatPermissionPayloadSchema),
  mutate('StopChatTurn', StopChatTurnPayloadSchema),
  mutate('ConfigureChatThread', ConfigureChatThreadPayloadSchema),
  mutate('HandoffChatThread', HandoffChatThreadPayloadSchema),
  read('ReadChatThread', ReadChatThreadPayloadSchema),
  read('ReadChatChanges', ReadChatChangesPayloadSchema),
  read('ReadChatCatalog', ReadChatCatalogPayloadSchema),
  mutate(
    'ConfigureLocal',
    z.strictObject({ endpoint: LocalEndpointSchema, authMode: LocalAuthModeSchema.optional() }),
  ),
  mutate('RefreshLocalModels', z.strictObject({ consent: z.literal('explicit') })),
  mutate('SelectLocalModel', LocalModelSelectionSchema),
  mutate('BeginLocalConnectionInput', z.strictObject({ consent: z.literal('explicit') })),
  mutate('CancelLocalConnectionInput', z.strictObject({ operationId: CommandIdSchema })),
  mutate('DisconnectLocal', empty),
  read('GetTaskConversationState', z.strictObject({ taskId: TaskIdSchema })),
  read(
    'GetTaskConversation',
    z.strictObject({ taskId: TaskIdSchema, beforeCursor: CursorSchema.optional() }),
  ),
  mutate('RegisterProject', z.strictObject({ path: text })),
  mutate(
    'CheckNativeConnection',
    z.strictObject({ family: z.literal('anthropic'), consent: z.literal('explicit') }),
  ),
  mutate(
    'InstallGoogleAcp',
    z.strictObject({ profileId: z.literal('google-acp-v1'), consent: z.literal('explicit') }),
  ),
  mutate(
    'StopGoogleAcpInstall',
    z.strictObject({ profileId: z.literal('google-acp-v1'), operationId: CommandIdSchema }),
  ),
  mutate('ObserveUsage', z.strictObject({ family: z.enum(['google', 'openai']) })),
  mutate(
    'RefreshAnthropicUsage',
    z.strictObject({
      trust: z
        .strictObject({ scopeHash: HashSchema, nativeTrust: z.literal('accepted') })
        .optional(),
    }),
  ),
  mutate('StopAnthropicUsage', z.strictObject({ operationId: CommandIdSchema })),
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
      z.strictObject({
        ...evaluationFields,
        checkRecipeId: z.literal('project-python-unittest-v1'),
        testFiles: ProjectPythonTestFilesSchema,
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
  read('GetSnapshot', SnapshotScopeSchema),
  read('GetWorkspaceState', empty),
  read('GetProjectPage', ProjectPageRequestSchema),
  read('GetTaskPage', TaskPageRequestSchema),
  read('GetTaskActivity', TaskActivityRequestSchema),
  read('GetTaskActivityPage', TaskActivityRequestSchema),
  read('GetTaskOperations', TaskOperationsRequestSchema),
  read(
    'GetProjectOperation',
    z.strictObject({ taskId: TaskIdSchema, operationId: CommandIdSchema }),
  ),
  mutate('PrepareProjectCommand', PrepareProjectCommandRequestSchema),
  mutate(
    'StartProjectCommand',
    z.strictObject({
      taskId: TaskIdSchema,
      operationId: CommandIdSchema,
      definitionHash: HashSchema,
      grant: GrantSchema.extend({
        action: z.literal('run-native-tools'),
        target: HashSchema,
        revoked: z.literal(false),
        usesRemaining: z.literal(1),
      }),
      sourceConsent: z.literal('explicit'),
      nativeTrust: z.literal('accepted'),
    }),
  ),
  mutate('ReadGitHub', z.strictObject({ taskId: TaskIdSchema, request: GitHubReadRequestSchema })),
  mutate(
    'StopProjectOperation',
    z.strictObject({ taskId: TaskIdSchema, operationId: CommandIdSchema }),
  ),
  read(
    'GetArtifactRange',
    z.strictObject({
      artifactId: ArtifactIdSchema,
      offset: RevisionSchema,
      limit: z.number().int().min(1).max(65536),
    }),
  ),
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
  maximumMinutes: z.literal(10),
});
export type CrewKiteVerifyPreview = z.infer<typeof CrewKiteVerifyPreviewSchema>;
export const CandidateEvaluationPreviewSchema = z
  .strictObject({
    taskId: TaskIdSchema,
    runId: RunIdSchema,
    candidateId: CandidateIdSchema,
    candidateHash: HashSchema,
    preparationId: ArtifactIdSchema,
    recipe: z.enum([
      'node-tests-v1',
      'project-node-tests-v1',
      'project-python-unittest-v1',
      'crewkite-verify-v1',
    ]),
    verification: CrewKiteVerifyPreviewSchema.optional(),
    testFiles: z
      .array(
        z.strictObject({
          path: z.union([ProjectNodeTestPathSchema, ProjectPythonTestPathSchema]),
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
      (['project-node-tests-v1', 'project-python-unittest-v1'].includes(value.recipe) &&
        paths.length === 0) ||
      (!['project-node-tests-v1', 'project-python-unittest-v1'].includes(value.recipe) &&
        paths.length !== 0) ||
      (value.recipe === 'project-python-unittest-v1' &&
        !paths.every((path) => ProjectPythonTestPathSchema.safeParse(path).success)) ||
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

export const NativeConnectionStatusSchema = z
  .strictObject({
    family: z.literal('anthropic'),
    profileId: z.literal('anthropic-file-v1'),
    state: z.enum([
      'unchecked',
      'checking',
      'signed-in',
      'signed-out',
      'unsupported',
      'blocked',
      'unknown',
    ]),
    authMethod: z
      .enum(['none', 'subscription', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'])
      .nullable(),
    observedAt: TimestampSchema.nullable(),
    reason: z.string().min(1).max(200).nullable(),
    next: z.string().min(1).max(500),
    billing: z.literal('unknown'),
    qualified: z.literal(false),
    quota: z.literal('unknown'),
  })
  .refine(
    (status) =>
      status.state !== 'signed-in' ||
      (status.authMethod === 'subscription' && status.observedAt !== null),
    'Signed-in status requires observed native subscription authentication.',
  )
  .refine(
    (status) =>
      status.state !== 'signed-out' || (status.authMethod === 'none' && status.observedAt !== null),
    'Signed-out status requires an observed signed-out method.',
  );
export type NativeConnectionStatus = z.infer<typeof NativeConnectionStatusSchema>;

export const GoogleAcpInstallStatusSchema = z.strictObject({
  profileId: z.literal('google-acp-v1'),
  state: z.enum(['idle', 'installing', 'stopping', 'installed', 'blocked', 'unknown']),
  operationId: CommandIdSchema.nullable(),
  observedAt: TimestampSchema.nullable(),
  reason: z.string().min(1).max(200).nullable(),
  next: z.string().min(1).max(500),
});
export type GoogleAcpInstallStatus = z.infer<typeof GoogleAcpInstallStatusSchema>;

export const SnapshotSchema = z
  .strictObject({
    googleAcpInstall: GoogleAcpInstallStatusSchema.nullable().default(null),
    nativeConnections: z.array(NativeConnectionStatusSchema).max(1).default([]),
    usageReaders: z
      .array(UsageReaderSchema)
      .max(3)
      .refine(
        (readers) => new Set(readers.map((reader) => reader.id)).size === readers.length,
        'Usage reader identities must be unique.',
      )
      .default([]),
    googleAcpSetup: GoogleAcpSetupSchema.nullable().default(null),
    localSetup: LocalSetupSchema.nullable().optional(),
    nativeProfiles: z
      .array(NativeProfileSchema)
      .max(7)
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
export const MAX_TASK_ACTIVITY_PAGE_BYTES = 524288;
export const TaskActivityPageSchema = z
  .strictObject({
    kind: z.literal('task-activity'),
    taskId: TaskIdSchema,
    events: z.array(z.lazy(() => EventSchema)).max(100),
    nextBeforeCursor: CursorSchema.nullable(),
  })
  .superRefine((page, context) => {
    if (
      page.events.some(
        (event, index) =>
          event.taskId !== page.taskId ||
          (index > 0 && BigInt(event.cursor) <= BigInt(page.events[index - 1].cursor)),
      ) ||
      new Set(page.events.map((event) => event.id)).size !== page.events.length ||
      (page.nextBeforeCursor !== null &&
        (page.events.length === 0 || page.nextBeforeCursor !== page.events[0].cursor))
    )
      context.addIssue({
        code: 'custom',
        message: 'Activity pages need ordered distinct whole events for one task.',
      });
    if (new TextEncoder().encode(JSON.stringify(page)).byteLength > MAX_TASK_ACTIVITY_PAGE_BYTES)
      context.addIssue({ code: 'custom', message: 'An activity page exceeds its byte limit.' });
  });
export type TaskActivityPage = z.infer<typeof TaskActivityPageSchema>;
export const ArtifactRangeSchema = z
  .strictObject({
    kind: z.literal('artifact-range'),
    artifact: ArtifactSchema,
    offset: RevisionSchema,
    encoding: z.literal('base64'),
    content: z.string().max(87384),
    eof: z.boolean(),
    integrity: z.literal('unverified-range'),
  })
  .refine((value) => {
    const content = value.content;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))
      return false;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    if (
      (content.endsWith('==') && (alphabet.indexOf(content.at(-3) ?? '') & 15) !== 0) ||
      (content.endsWith('=') &&
        !content.endsWith('==') &&
        (alphabet.indexOf(content.at(-2) ?? '') & 3) !== 0)
    )
      return false;
    const bytes =
      (content.length / 4) * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);
    return (
      bytes <= 65536 &&
      value.offset + bytes <= value.artifact.bytes &&
      value.eof === (value.offset + bytes === value.artifact.bytes) &&
      (bytes > 0 || value.eof)
    );
  }, 'Artifact ranges need canonical bounded bytes and exact length.');
export const ArtifactVerificationSchema = z.strictObject({
  integrity: z.literal('whole-verified'),
  hash: HashSchema,
  bytes: RevisionSchema,
});
export type ArtifactRange = z.infer<typeof ArtifactRangeSchema>;
export const ActivityBodyReferenceSchema = z.strictObject({
  kind: z.literal('event-body'),
  id: EventIdSchema,
  cursor: CursorSchema,
  taskId: TaskIdSchema,
  at: TimestampSchema,
  revision: RevisionSchema,
  type: z
    .string()
    .min(1)
    .max(100)
    .refine((type) => EventSchema.options.some((event) => event.shape.type.value === type)),
  artifact: ArtifactSchema,
});
export const TaskActivityOutputPageSchema = z
  .strictObject({
    kind: z.literal('task-activity-page'),
    taskId: TaskIdSchema,
    entries: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('event'), event: z.lazy(() => EventSchema) }),
          ActivityBodyReferenceSchema,
        ]),
      )
      .max(100),
    nextBeforeCursor: CursorSchema.nullable(),
  })
  .refine((page) => {
    const identities = page.entries.map((entry) => (entry.kind === 'event' ? entry.event : entry));
    return (
      identities.every(
        (entry, index) =>
          entry.taskId === page.taskId &&
          (index === 0 || BigInt(entry.cursor) > BigInt(identities[index - 1].cursor)),
      ) &&
      new Set(identities.map((entry) => entry.id)).size === identities.length &&
      (page.nextBeforeCursor === null || page.nextBeforeCursor === identities[0]?.cursor) &&
      new TextEncoder().encode(JSON.stringify(page)).byteLength <= MAX_TASK_ACTIVITY_PAGE_BYTES
    );
  }, 'Activity output needs ordered distinct identities and bounded pages.');
export type TaskActivityOutputPage = z.infer<typeof TaskActivityOutputPageSchema>;
export const MAX_WORKSPACE_PAGE_BYTES = 524288;
export const WorkspaceStateSchema = z
  .strictObject({
    kind: z.literal('workspace-state'),
    version: z.literal(1),
    protocol: z.literal(1),
    stamp: WorkspaceStampSchema,
    cursor: CursorSchema,
    usageReaders: SnapshotSchema.shape.usageReaders,
    googleAcpSetup: SnapshotSchema.shape.googleAcpSetup,
    localSetup: SnapshotSchema.shape.localSetup,
    localHardware: LocalHardwareStatusSchema.optional(),
    googleAcpInstall: SnapshotSchema.shape.googleAcpInstall,
    nativeConnections: SnapshotSchema.shape.nativeConnections,
    nativeProfiles: SnapshotSchema.shape.nativeProfiles,
    routes: SnapshotSchema.shape.routes,
    usage: SnapshotSchema.shape.usage,
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_FRAME_BYTES - 4096,
    'The workspace header exceeds its encoded byte limit.',
  );
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export const TaskSummarySchema = z
  .strictObject({
    id: TaskSchema.shape.id,
    projectId: TaskSchema.shape.projectId,
    title: TaskSchema.shape.title,
    state: TaskSchema.shape.state,
    waitingReason: TaskSchema.shape.waitingReason,
    revision: TaskSchema.shape.revision,
    runId: TaskSchema.shape.runId,
    next: TaskSchema.shape.next,
    match: z
      .strictObject({
        field: z.enum(['title', 'project', 'outcome', 'criterion', 'task-id', 'project-id']),
        text,
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if ((value.state === 'waiting') !== (value.waitingReason !== null))
      context.addIssue({
        code: 'custom',
        message: 'A task summary must preserve its waiting state.',
      });
  });
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
const workspacePage = {
  version: z.literal(1),
  stamp: WorkspaceStampSchema,
  cursor: CursorSchema,
  next: WorkspaceContinuationSchema.nullable(),
  complete: z.boolean(),
};
const validWorkspacePage = (page: {
  stamp: WorkspaceStamp;
  next: WorkspaceContinuation | null;
  complete: boolean;
}) =>
  page.complete === (page.next === null) &&
  (page.next === null ||
    (page.next.stamp.epoch === page.stamp.epoch &&
      page.next.stamp.revision === page.stamp.revision)) &&
  new TextEncoder().encode(JSON.stringify(page)).byteLength <= MAX_WORKSPACE_PAGE_BYTES;
export const ProjectPageSchema = z
  .strictObject({
    ...workspacePage,
    kind: z.literal('project-page'),
    projects: z
      .array(z.strictObject({ ...ProjectSchema.shape, taskCount: RevisionSchema }))
      .max(100),
  })
  .refine(
    (page) =>
      validWorkspacePage(page) &&
      (page.next === null || page.next.section === 'projects') &&
      page.projects.every(
        (project, index) => index === 0 || page.projects[index - 1].id < project.id,
      ),
    'A project page needs a matching continuation, completeness and byte bound.',
  );
export const TaskPageSchema = z
  .strictObject({
    ...workspacePage,
    kind: z.literal('task-page'),
    tasks: z.array(TaskSummarySchema).max(100),
    scanned: RevisionSchema,
  })
  .refine(
    (page) =>
      validWorkspacePage(page) &&
      (page.next === null || page.next.section === 'tasks') &&
      new Set(page.tasks.map((task) => task.id)).size === page.tasks.length &&
      page.tasks.every((task, index) => {
        if (index === 0) return true;
        const rank = (value: TaskSummary) =>
          value.match
            ? ['title', 'project', 'outcome', 'criterion', 'task-id', 'project-id'].indexOf(
                value.match.field,
              )
            : 0;
        const order = (value: TaskSummary) => {
          const valueRank = rank(value);
          return valueRank < 2 ? valueRank : valueRank < 4 ? 2 : 3;
        };
        const previous = page.tasks[index - 1];
        return (
          order(previous) < order(task) ||
          (order(previous) === order(task) && previous.id < task.id)
        );
      }),
    'A task page needs a matching continuation, completeness and byte bound.',
  );
export type ProjectPage = z.infer<typeof ProjectPageSchema>;
export type TaskPage = z.infer<typeof TaskPageSchema>;

export const TaskOperationsPageSchema = z
  .strictObject({
    kind: z.literal('task-operations'),
    taskId: TaskIdSchema,
    operations: z.array(TaskOperationSummarySchema).max(20),
    nextBeforeId: CommandIdSchema.nullable(),
  })
  .refine(
    (page) =>
      page.operations.every(
        (operation, index) =>
          operation.taskId === page.taskId &&
          (index === 0 || operation.id < page.operations[index - 1].id),
      ) &&
      (page.nextBeforeId === null || page.nextBeforeId === page.operations.at(-1)?.id) &&
      new TextEncoder().encode(JSON.stringify(page)).byteLength <= 524288,
    'Operation pages need matching ordered identities and bounded bytes.',
  );
export const GitHubObservationSchema = z
  .strictObject({
    state: z.enum(['complete', 'unavailable', 'cancelled', 'unknown']),
    status: z
      .enum([
        'open',
        'draft',
        'closed',
        'merged',
        'pending',
        'passed',
        'failed',
        'cancelled',
        'neutral',
        'skipped',
      ])
      .nullable(),
    fetchedAt: TimestampSchema,
    url: z.string().url().max(4096).nullable(),
    reason: text.nullable(),
  })
  .refine((value) =>
    value.state === 'complete'
      ? value.status !== null && value.url !== null && value.reason === null
      : value.status === null && value.url === null && value.reason !== null,
  );
export const ProjectOperationDataSchema = z
  .strictObject({
    kind: z.literal('project-operation'),
    operation: TaskOperationSummarySchema,
    definition: ProjectCommandPreviewSchema.nullable(),
    githubRequest: GitHubReadRequestSchema.nullable(),
    githubResult: GitHubObservationSchema.nullable(),
  })
  .refine(
    (value) =>
      value.operation.kind === 'project-command'
        ? value.definition !== null &&
          value.githubRequest === null &&
          value.githubResult === null &&
          value.definition.id === value.operation.id &&
          value.definition.taskId === value.operation.taskId
        : value.definition === null && value.githubRequest !== null,
    'Operation detail must match its kind and task identity.',
  );
export const ReadDataSchema = z.discriminatedUnion('kind', [
  ChatThreadReadSchema.extend({ kind: z.literal('chat-thread') }),
  ChatChangesReadSchema.extend({ kind: z.literal('chat-changes') }),
  ChatCatalogReadSchema.extend({ kind: z.literal('chat-catalog') }),
  WorkspaceStateSchema,
  TaskOperationsPageSchema,
  ProjectOperationDataSchema,
  ProjectPageSchema,
  TaskPageSchema,
  TaskActivityPageSchema,
  ArtifactRangeSchema,
  TaskActivityOutputPageSchema,
  z.strictObject({ kind: z.literal('conversation-state'), state: TaskConversationStateSchema }),
  ConversationPageSchema,
  z.strictObject({ kind: z.literal('google-acp-setup'), setup: GoogleAcpSetupSchema }),
  z.strictObject({ kind: z.literal('google-acp-install'), install: GoogleAcpInstallStatusSchema }),
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
  event('operation.updated', TaskOperationSummarySchema),
  event('combined.updated', CombinedRunPreviewSchema),
  event('conversation.entry', ConversationEntrySchema),
  event('agent.event', AgentEventSchema),
  event('chat.turn', ChatTurnSchema),
  event('chat.thread', ChatThreadSchema),
  event('task.created', TaskSchema),
  event('task.updated', TaskSchema),
  event('run.prepared', RunSchema),
  event('run.admitted', RunSchema),
  event('attempt.launched', AttemptSchema),
  event('attempt.output', AttemptOutputSchema),
  event('approval.requested', ApprovalSchema),
  event('approval.resolved', ApprovalSchema),
  event('usage.observed', ObservationSchema),
  event('usage.reader-updated', UsageReaderSchema),
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
export * from './chat.ts';

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
