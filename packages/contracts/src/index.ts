import { z } from 'zod';

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
export const RouteSchema = z.strictObject({
  id: RouteIdSchema,
  family: FamilySchema,
  displayName: label,
  model: label,
  effort: z.strictObject({ requested: label, effective: label, supported: z.array(label).max(32) }),
  billing: z.enum(['included', 'credits', 'local']),
  qualified: z.boolean(),
  fake: z.boolean(),
});
export const ObservationSchema = z
  .strictObject({
    routeId: RouteIdSchema,
    windowId: label,
    kind: z.enum(['rolling', 'weekly', 'model', 'pool', 'local']),
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
export const RoleSchema = z.strictObject({
  role: RoleNameSchema,
  routeId: RouteIdSchema,
  pinned: z.boolean(),
  approvedFallbacks: z.array(RouteIdSchema).max(32),
});
export const EffectSchema = z.strictObject({
  action: z.enum([
    'read-source',
    'write-scratch',
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
  quality: z.enum(['quick', 'standard', 'thorough']),
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
export const ApprovalBindingSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  taskId: TaskIdSchema,
  attemptId: AttemptIdSchema,
  generation: RevisionSchema,
  action: GrantSchema.shape.action,
  target: text,
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
export const ReviewJobSchema = z.strictObject({
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  attemptId: AttemptIdSchema,
  generation: RevisionSchema,
  routeId: RouteIdSchema,
  candidateId: CandidateIdSchema,
  candidateHash: HashSchema,
  methodId: ReviewMethodIdSchema,
  cycle: z.number().int().min(1).max(3),
  limitMinutes: z.number().int().min(1).max(1440),
  scripted: z.literal(true),
});
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
  mode: z.literal('demo'),
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
export const CommandSchema = z.discriminatedUnion('command', [
  mutate('RegisterProject', z.strictObject({ path: text })),
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

export const SnapshotSchema = z.strictObject({
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
});

export const ChangeFileSchema = z.strictObject({
  path: text,
  status: z.enum(['added', 'modified', 'deleted']),
  binary: z.boolean(),
  oversized: z.boolean(),
  additions: RevisionSchema,
  deletions: RevisionSchema,
});
export const ReadDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source'), source: SourceSchema }),
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
export const EventSchema = z.discriminatedUnion('type', [
  event('task.created', TaskSchema),
  event('task.updated', TaskSchema),
  event('run.prepared', RunSchema),
  event('run.admitted', RunSchema),
  event('attempt.launched', AttemptSchema),
  event(
    'attempt.output',
    z.strictObject({
      attemptId: AttemptIdSchema,
      generation: RevisionSchema,
      channel: z.enum(['stdout', 'stderr']),
      text: z.string().max(65536),
    }),
  ),
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
    job: ReviewJobSchema,
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
