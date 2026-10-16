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
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
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
  canonicalJson,
  type Event,
  EventSchema,
  type FakeWorkerEvent,
  formatReviewTarget,
  type Grant,
  GrantSchema,
  HashSchema,
  MAX_FRAME_BYTES,
  NativeProfileSchema,
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
  type RouterDecision,
  RouteSchema,
  type Run,
  RunSchema,
  requiredReviewMethodIds,
  type SealedHandoffPacket,
  SealedHandoffPacketSchema,
  type Snapshot,
  SnapshotSchema,
  type Task,
  TaskIdSchema,
  TaskSchema,
  TimestampSchema,
} from '@crewkite/contracts';
import { hashCanonical, verifyHandoff } from '@crewkite/contracts/hash';
import { fakeReviewWorkerPath, fakeWorkerPath } from '@crewkite/testkit/worker';
import { z } from 'zod';
import { ArtifactFiles } from '../artifacts/index.ts';
import { buildHandoff } from '../continuity/index.ts';
import { CandidateEvidence, type CheckPlan, NodeCheckDefinitionSchema } from '../evidence/index.ts';
import {
  applyPublication,
  type GitIdentity,
  preparePublication,
  refValue,
  validateIdentity,
} from '../host/publication.ts';
import {
  applyReplacement,
  committedFiles,
  inspectSource,
  inspectSourceDetails,
  materialize,
  projectRoot,
  readFiles,
} from '../host/source.ts';
import {
  closedWithin,
  defaultSchedule,
  groupAbsent,
  OwnedCommand,
  OwnedWorker,
  type Schedule,
} from '../host/worker.ts';
import type { NativeLifecycle } from '../providers/openai/native-discovery.ts';
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
import { type ReviewPlan, reviewPlan, startReview } from '../providers/openai/review.ts';
import { chooseRoute } from '../routing/index.ts';
import { createIds, type IdPrefix } from '../store/ids.ts';
import { type LaunchIntent, Store } from '../store/index.ts';
import { deriveWindow } from '../usage/index.ts';
import { chargedMinutes, remainingBudgets } from './budgets.ts';

const NativeAppointmentSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  taskId: TaskIdSchema,
  route: RouteSchema,
  client: z.strictObject({
    executable: z.string().max(4096).refine(isAbsolute),
    sha256: HashSchema,
    version: z.string().min(1).max(200),
  }),
  creditPolicy: z.enum(['ordinary', 'existing-credits']),
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
export type NativePilotAppointment = z.infer<typeof NativeAppointmentSchema>;
const NativePublicScopeSchema = z.strictObject({
  profileId: z.string().min(1).max(200),
  locationHash: HashSchema,
  scopeHash: HashSchema,
  context: z.strictObject({
    title: z.string().min(1).max(200),
    outcome: z.string().min(1).max(4096),
  }),
});
const NativePreparationSchema = z.strictObject({
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
  originalHash: HashSchema,
  public: NativePublicScopeSchema,
});
type NativeBinding = {
  appointment: NativePilotAppointment;
  run: Run;
  attempt: Attempt;
  original: string;
  baseHash: string;
  manifest: Omit<ReturnType<typeof readFiles>[number], 'content'>[];
  planArtifact: Artifact;
  public?: z.infer<typeof NativePublicScopeSchema>;
  environment?: NodeJS.ProcessEnv;
};
const EvaluationConsentSchema = z.strictObject({
  scopeHash: HashSchema,
  expiresAt: TimestampSchema,
});
const CandidateEvaluationSchema = z.strictObject({
  run: RunSchema,
  writer: AttemptSchema,
  candidate: CandidateSchema,
  context: z.strictObject({
    title: z.string().min(1).max(200),
    outcome: z.string().min(1).max(4096),
    criteria: z.array(z.string().min(1).max(4096)).min(1).max(100),
  }),
  definition: NodeCheckDefinitionSchema,
  reviewer: z.strictObject({
    profileId: z.string().min(1).max(200),
    methodId: ReviewMethodIdSchema,
    cycles: z.literal(1),
    role: ReviewMethodSchema.shape.reviewerRole,
    profile: NativeProfileSchema,
    client: NativeAppointmentSchema.shape.client,
    locationHash: HashSchema,
  }),
  creditPolicy: z.enum(['ordinary', 'existing-credits']),
  grants: z.array(GrantSchema).length(2),
  remaining: RemainingBudgetsSchema,
  maximumCheckMinutes: z.literal(1),
  scopeHash: HashSchema,
  expiresAt: TimestampSchema,
});
type NativeRuntime = {
  kind: 'native';
  binding: NativeBinding;
  stopped: boolean;
  handle?: ReturnType<typeof startReplacement>;
  done?: Promise<void>;
  reason?: 'handoff' | 'stop' | 'switch';
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
  nativeSpawn?: Parameters<typeof startReplacement>[2]['spawn'];
};
const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));

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
  private readonly jobs = new Map<string, OwnedCommand>();
  private readonly nativeReviewWorkers = new Map<string, NativeReviewRuntime>();
  private readonly owner: DatabaseSync;
  private closed = false;
  private readonly options: ControllerOptions;
  private profile: NativeProfileResolution;
  private closing?: Promise<void>;
  private readonly workers = new Map<string, FakeRuntime | NativeRuntime>();

  constructor(options: ControllerOptions) {
    this.options = options;
    this.profile = options.nativeProfile?.() ?? unavailableNativeProfile();
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
        stale ?? preflightFailure ?? this.apply(command, effects),
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
      nativeProfiles: [this.profile.facts],
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

  subscribe(listener: (event: Event) => void): () => void {
    return this.store.subscribe(listener);
  }
  close(): void | Promise<void> {
    if (this.closed) return this.closing;
    this.closed = true;
    const native: Promise<void>[] = [];
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
    for (const runtime of this.nativeReviewWorkers.values()) {
      runtime.stopped = true;
      runtime.handle?.stop();
      native.push(runtime.done);
    }
    for (const cancel of this.jobCancels.values()) cancel();
    for (const job of this.jobs.values()) job.stop();
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
    if (command.command === 'RegisterProject' || command.command === 'CreateTask') {
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

  private apply(command: Command, effects: (() => void)[]): CommandResult {
    if (
      'taskId' in command.payload &&
      ['ResumeRun', 'SwitchRoute', 'AcceptCandidate'].includes(command.command)
    ) {
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
        this.evidence.hash(run.source.base, readFiles(join(this.home, 'scratch', run.id))) !==
        candidate.hash
      )
        return {
          outcome: 'blocked',
          reason: 'candidate-binding-changed',
          next: 'Seal and check the changed work before publication.',
        };
    }
    switch (command.command) {
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
      case 'PrepareCandidateEvaluation':
        return this.prepareEvaluation(command);
      case 'StartCandidateEvaluation':
        return this.startEvaluation(command, effects);
      case 'StartCandidateReview':
        return this.startCandidateReview(command, effects);
      case 'StartRun':
      case 'ResumeRun':
        return this.start(command, effects);
      case 'ResolveApproval':
        return this.resolve(command, effects);
      case 'SwitchRoute':
        return this.switchRoute(command, effects);
      case 'StopRun':
        return this.stop(command, effects);
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
            ? remainingBudgets(run as Run, this.store.intents()).minutes
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
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId);
    const run = this.store.get<Run>('run', command.payload.runId);
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
      } catch {
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
    if (command.command === 'StartRun' && decision.chosen !== run.decision.chosen)
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
    const allocation = this.grant(run, 'write-scratch', project.name);
    const allocated = this.store.receipt(`allocation:${run.id}`);
    if (!allocation && !approved && !allocated) {
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
    const remaining = remainingBudgets(run, this.store.intents());
    if (remaining.minutes === 0 || remaining.concurrency === 0)
      return { outcome: 'blocked', reason: 'run-budget-exhausted' };
    const lease = this.store.db
      .prepare('SELECT attempt_id FROM writer_leases WHERE task_id=?')
      .get(task.id);
    if (lease) return { outcome: 'blocked', reason: 'writer-lease-held' };
    this.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run(`paused:${run.id}`);
    this.store.put('attempt', attempt.id, attempt.revision, attempt);
    if (allocation) this.consumeGrant(run, allocation);
    if (!allocated)
      this.store.saveReceipt(
        `allocation:${run.id}`,
        hashCanonical({ runId: run.id, grant: allocation ?? null, approvalId: approved ?? null }),
        'local-owner',
        { outcome: 'applied', entity: run },
      );
    const scratchPath = join(this.home, 'scratch', run.id);
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
      if (native) this.launchNative(intent, freezeNative({ ...native, run: admitted, attempt }));
      else this.launch(intent, admitted, attempt);
    });
    return { outcome: 'applied', entity: updated, revision: updated.revision };
  }

  private nativeRuns(): z.infer<typeof NativeRunSchema>[] {
    return this.store.list<Run>('run').flatMap((run) => {
      const origin = this.store.receipt(`native-run:${run.id}`);
      if (!origin) return [];
      const prepared = this.store.receipt(`native-prepared:${run.id}`);
      try {
        const artifact = ArtifactSchema.parse(origin.result.entity);
        if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Native plan exceeds its bound.');
        const plan = JSON.parse(this.artifacts.read(artifact.hash).toString('utf8'));
        const appointment = NativeAppointmentSchema.parse(plan.appointment);
        const publicScope = NativePublicScopeSchema.safeParse(plan.public).data;
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
            target: {
              ...appointment.target,
              bytes: plan.manifest.find(
                (file: { path: string }) => file.path === appointment.target.path,
              )?.bytes,
            },
          }),
        ];
      } catch {
        return [
          { runId: run.id, profileId: 'unavailable-native-plan', stage: 'retain-only' as const },
        ];
      }
    });
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
        effective: profile.facts.effort,
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

  private prepareNative(command: Extract<Command, { command: 'PrepareNativeRun' }>): CommandResult {
    let plan: Omit<NativeBinding, 'planArtifact'>;
    let expiresAt: string;
    try {
      this.profile = this.options.nativeProfile?.() ?? unavailableNativeProfile();
      const profile = this.profile;
      const facts = NativeProfileSchema.parse(profile.facts);
      if (
        !facts.available ||
        !profile.client ||
        !profile.environment ||
        !profile.locationHash ||
        facts.id !== command.payload.profileId ||
        !facts.creditPolicies.includes(command.payload.creditPolicy)
      )
        return {
          outcome: 'blocked',
          reason: 'native-profile-unavailable',
          next: 'Use the supported installed client and native account location.',
        };
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (task?.state !== 'draft' || this.draftEditGate(task))
        return { outcome: 'blocked', reason: 'task-not-preparable' };
      const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
      const files = committedFiles(this.projectPath(task.projectId) as string, source.base);
      const original = files.find((file) => file.path === command.payload.targetPath);
      if (!original) throw Error('Target is unavailable.');
      const policy = PolicySchema.parse(command.payload.policy);
      const runId = this.id('run');
      const project = this.store.get<Project>('project', task.projectId) as Project;
      const writeGrant = this.grant(
        { id: runId, taskId: task.id, policy: { policy, hash: hashCanonical(policy) } },
        'write-scratch',
        project.name,
      );
      if (!writeGrant) throw Error('The native proposal needs a live scratch grant.');
      expiresAt = writeGrant.expiresAt;
      const context = { title: task.title, outcome: task.outcome };
      const scopeHash = hashCanonical({
        profile: facts,
        client: profile.client,
        locationHash: profile.locationHash,
        projectId: task.projectId,
        source,
        target: { path: original.path, hash: original.hash },
        context,
        criteria: task.criteria,
        policy,
        creditPolicy: command.payload.creditPolicy,
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
          route: savedRoute ?? {
            id: this.id('rte'),
            family: facts.family,
            displayName: facts.displayName,
            model: facts.model,
            effort: { requested: facts.effort, effective: facts.effort, supported: [facts.effort] },
            billing: command.payload.creditPolicy === 'ordinary' ? 'included' : 'credits',
            qualified: false,
            fake: false,
          },
          client: profile.client,
          creditPolicy: command.payload.creditPolicy,
          target: { path: original.path, baseHash: original.hash },
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
      next: 'Review the native file proposal and start. Checks and acceptance remain unavailable.',
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
    const origin = this.store.receipt(`native-run:${run.id}`);
    const artifact = ArtifactSchema.parse(origin?.result.entity);
    if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Native origin exceeds its bound.');
    const plan = NativePreparationSchema.extend({
      public: NativePublicScopeSchema.optional(),
    }).parse(JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')));
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
      this.store.receipt(`native-application:${writer.id}`)?.result.outcome !== 'applied' ||
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
      this.evidence.hash(run.source.base, readFiles(join(this.home, 'scratch', run.id))) !==
        candidate.hash
    )
      throw Error('Evaluation origin or saved context changed.');
    return { task, run, writer, candidate, native: plan };
  }

  private prepareEvaluation(
    command: Extract<Command, { command: 'PrepareCandidateEvaluation' }>,
  ): CommandResult {
    let plan: z.infer<typeof CandidateEvaluationSchema>;
    let scopeHash: string;
    try {
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
      this.profile = this.options.nativeProfile?.() ?? unavailableNativeProfile();
      const profile = this.profile;
      if (
        !profile.facts.available ||
        profile.facts.id !== selected.profileId ||
        !profile.facts.creditPolicies.includes(command.payload.creditPolicy) ||
        !profile.client ||
        !profile.locationHash ||
        !profile.environment
      )
        throw Error('The reviewer profile is unavailable.');
      const remaining = remainingBudgets(run, this.store.intents());
      if (remaining.attempts < 2 || remaining.minutes < 2 || remaining.concurrency < 1)
        throw Error('The saved budget cannot cover one check and one review.');
      const expected = [
        'node --test',
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
      const definition = this.evidence.describeChecks({
        candidate,
        sourceFiles: committedFiles(this.projectPath(task.projectId) as string, run.source.base),
        criteria: task.criteria,
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
          client: profile.client,
          locationHash: profile.locationHash,
        },
        creditPolicy: command.payload.creditPolicy,
        grants,
        remaining,
        maximumCheckMinutes: 1 as const,
      };
      scopeHash = hashCanonical(fields);
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
      const remaining = remainingBudgets(plan.run, this.store.intents());
      const required = review ? 1 : 2;
      if (
        remaining.attempts < required ||
        remaining.minutes < required ||
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
        const route =
          this.candidateReviewRoute(this.profile, plan.creditPolicy, false) ??
          current.native.appointment.route;
        this.nativeDecision(
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
          this.store.receipt(`native-run:${task.runId}`)?.result.entity,
        );
        if (nativeArtifact.bytes > MAX_FRAME_BYTES) return [];
        const native = NativePreparationSchema.extend({
          public: NativePublicScopeSchema.optional(),
        }).parse(JSON.parse(this.artifacts.read(nativeArtifact.hash).toString('utf8')));
        const target = this.evidence
          .read(plan.candidate)
          .files.find((file) => file.path === native.appointment.target.path);
        if (!target) return [];
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
            definitionHash: plan.definition.definitionHash,
            target: {
              path: target.path,
              baseHash: native.originalHash,
              candidateContentHash: target.hash,
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
            remainingBudgets: remainingBudgets(plan.run, this.store.intents()),
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
    let check: CheckPlan;
    let route: Route;
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
      const remaining = remainingBudgets(plan.run, this.store.intents());
      if (
        remaining.attempts < 2 ||
        remaining.minutes < 2 ||
        remaining.concurrency < 1 ||
        plan.grants.some((grant) => this.store.receipt(this.grantKey(grant)))
      )
        throw Error('Evaluation authority or budget changed.');
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
    } catch {
      return {
        outcome: 'blocked',
        reason: 'candidate-evaluation-unavailable',
        next: 'Prepare the exact candidate evaluation again before running checks.',
      };
    }
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
    this.profile = this.options.nativeProfile?.() ?? unavailableNativeProfile();
    if (
      hashCanonical(this.profile.facts) !== hashCanonical(plan.reviewer.profile) ||
      hashCanonical(this.profile.client) !== hashCanonical(plan.reviewer.client) ||
      this.profile.locationHash !== plan.reviewer.locationHash ||
      !this.profile.environment ||
      !this.profile.facts.creditPolicies.includes(plan.creditPolicy)
    )
      throw Error('profile-unavailable');
    const definition = this.evidence.describeChecks({
      candidate: origin.candidate,
      sourceFiles: committedFiles(
        this.projectPath(origin.task.projectId) as string,
        plan.run.source.base,
      ),
      criteria: plan.context.criteria,
    });
    if (hashCanonical(definition) !== hashCanonical(plan.definition))
      throw Error('preparation-changed');
    return { ...origin, plan, definition, environment: { ...this.profile.environment } };
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
    create = true,
  ) {
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
            client: NativeAppointmentSchema.shape.client,
            route: RouteSchema,
          })
          .parse(JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')))
      : undefined;
    if (!saved && !create) return undefined;
    const route = RouteSchema.parse({
      id: saved?.route.id ?? this.id('rte'),
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
      const remaining = remainingBudgets(plan.run, this.store.intents());
      const timeoutMs = Math.min(
        300000,
        remaining.minutes * 60000,
        Date.parse(plan.expiresAt) - Date.parse(this.now()),
      );
      if (!remaining.attempts || !remaining.concurrency || timeoutMs <= 2000)
        throw Error('The review has no bounded execution slot.');
      const reviewRoute = this.candidateReviewRoute(this.profile, plan.creditPolicy);
      if (!reviewRoute) throw Error('Reviewer route is unavailable.');
      route = reviewRoute;
      // The evaluation grant permits one review within the original run budget.
      this.nativeDecision(
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
      const original = committedFiles(
        this.projectPath(task.projectId) as string,
        plan.run.source.base,
      ).find((file) => file.path === prepared.native.appointment.target.path);
      const candidate = this.evidence
        .read(plan.candidate)
        .files.find((file) => file.path === prepared.native.appointment.target.path);
      if (!original || !candidate || original.hash !== prepared.native.originalHash)
        throw Error('The review target changed.');
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
        path: original.path,
        baseHash: original.hash,
        original: new TextDecoder('utf-8', { fatal: true }).decode(original.content),
        candidate: new TextDecoder('utf-8', { fatal: true }).decode(candidate.content),
        candidateContentHash: candidate.hash,
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
            phases.length === 3 &&
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
            this.updateTask(task, {
              state: runtime.stopped || review?.outcome === 'passed' ? 'stopped' : 'failed',
              waitingReason: null,
              next: runtime.stopped
                ? 'Native review stopped. Inspect retained evidence.'
                : review?.outcome === 'passed'
                  ? 'Native review passed with process independence only. Acceptance remains unavailable.'
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
    this.profile = this.options.nativeProfile?.() ?? unavailableNativeProfile();
    const profile = this.profile;
    if (
      !profile.facts.available ||
      profile.facts.id !== plan.public.profileId ||
      !profile.facts.creditPolicies.includes(plan.appointment.creditPolicy) ||
      this.nativeProfileRoute(profile, plan.appointment.creditPolicy)?.id !==
        plan.appointment.route.id ||
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
    const original = files.find((file) => file.path === plan.appointment.target.path);
    if (
      !original ||
      original.hash !== plan.originalHash ||
      original.hash !== plan.appointment.target.baseHash
    )
      throw Error('Native target changed.');
    const binding = freezeNative({
      appointment: plan.appointment,
      run,
      attempt: plan.attempt,
      original: original.content.toString('utf8'),
      baseHash: original.hash,
      manifest,
      planArtifact: artifact,
      public: plan.public,
      environment: { ...profile.environment },
    });
    if (!this.nativeConsentCurrent(binding)) throw Error('Native consent changed.');
    replacementPlan({
      attemptId: binding.attempt.id,
      model: plan.appointment.route.model as WriterPlan['model'],
      effort: plan.appointment.route.effort.requested as WriterPlan['effort'],
      directory: join(this.home, 'native', binding.attempt.id),
      creditPolicy: plan.appointment.creditPolicy,
      path: plan.appointment.target.path,
      original: binding.original,
      baseHash: binding.baseHash,
      criteria: [plan.public.context.title, plan.public.context.outcome, ...task.criteria],
    });
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
    if (
      route.fake ||
      route.qualified ||
      route.family !== 'openai' ||
      route.billing !== (appointment.creditPolicy === 'ordinary' ? 'included' : 'credits') ||
      route.speed ||
      route.effort.requested !== route.effort.effective ||
      !route.effort.supported.includes(route.effort.requested) ||
      (this.store.get('route', route.id) &&
        (!publicScope ||
          this.nativeProfileRoute(this.profile, appointment.creditPolicy)?.id !== route.id))
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
    const original = files.find((file) => file.path === appointment.target.path);
    if (!original || original.bytes > 65_536 || original.hash !== appointment.target.baseHash)
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
    // Validate the exact model and payload through the provider's existing boundary.
    replacementPlan({
      attemptId,
      model: route.model as WriterPlan['model'],
      effort: route.effort.requested as WriterPlan['effort'],
      creditPolicy: appointment.creditPolicy,
      directory: join(this.home, 'native', attemptId),
      path: appointment.target.path,
      original: original.content.toString('utf8'),
      baseHash: original.hash,
      criteria: publicScope
        ? [publicScope.context.title, publicScope.context.outcome, ...task.criteria]
        : task.criteria,
    });
    this.nativeDecision(appointment, run, !!publicScope);
    const project = this.store.get<Project>('project', task.projectId) as Project;
    if (!this.grant(run, 'write-scratch', project.name))
      throw new Error('The appointment needs a saved scratch grant.');
    const manifest = files.map(({ content: _content, ...file }) => file);
    const plan = freezeNative({
      appointment,
      run,
      attempt,
      manifest,
      original: original.content.toString('utf8'),
      baseHash: original.hash,
      ...(publicScope ? { public: publicScope } : {}),
    });
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
      originalHash: plan.baseHash,
      ...(plan.public ? { public: plan.public } : {}),
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

  private nativeDecision(
    appointment: NativePilotAppointment,
    run: Run,
    publicProfile = false,
  ): RouterDecision {
    const policy = run.policy.policy;
    const allowance = policy.unknownUsage;
    const active = this.store.intents().filter((intent) => intent.state !== 'stopped');
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
    const task = this.store.get<Task>('task', run.taskId);
    const current = this.store.get<Attempt>('attempt', attempt.id);
    const saved = this.store.get<Run>('run', run.id);
    const lease = this.store.db
      .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
      .get(run.taskId);
    if (
      this.closed ||
      (runtime.binding.public && !this.nativeConsentCurrent(runtime.binding)) ||
      runtime.stopped ||
      runtime.reason === 'stop' ||
      task?.runId !== run.id ||
      task.state !== 'running' ||
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

  private nativeLifecycle(attempt: Attempt, current: () => void): NativeLifecycle {
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

  private launchNative(intent: LaunchIntent, binding: NativeBinding) {
    if (this.closed) return;
    const runtime: NativeRuntime = { kind: 'native', binding, stopped: false };
    const completion = Promise.withResolvers<void>();
    runtime.done = completion.promise;
    this.workers.set(binding.attempt.id, runtime);
    const { appointment, run, attempt } = binding;
    const finish = (outcome: Awaited<ReturnType<typeof startReplacement>['result']> | null) => {
      try {
        let applied = false;
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
          if (quiescent && outcome?.metadata && !outcome.reason) {
            this.nativeCurrent(runtime);
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
        } catch {
          // A committed intent can outlive an interrupted write. Recovery never reapplies it.
        }
        try {
          if (this.settleJob(attempt, quiescent, true)) {
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
          committedFiles(this.projectPath(run.source.projectId) as string, run.source.base),
        );
      const directory = join(this.home, 'native', attempt.id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const plan = replacementPlan({
        attemptId: attempt.id,
        model: appointment.route.model as WriterPlan['model'],
        effort: appointment.route.effort.requested as WriterPlan['effort'],
        creditPolicy: appointment.creditPolicy,
        directory,
        path: appointment.target.path,
        original: binding.original,
        baseHash: binding.baseHash,
        criteria: [
          ...(binding.public ? [binding.public.context.title, binding.public.context.outcome] : []),
          ...(this.store.get<Task>('task', run.taskId) as Task).criteria,
        ],
      });
      const timeoutMs = Math.min(
        appointment.maximumTaskMs,
        this.jobDeadline(attempt.id, appointment.maximumTaskMs / 60_000),
        Date.parse(appointment.expiresAt) - Date.parse(this.now()),
      );
      runtime.handle = startReplacement(
        {
          ...appointment.client,
          directory,
          repositoryRoot: this.home,
          environment: binding.environment ?? process.env,
        },
        plan,
        {
          timeoutMs,
          schedule: this.options.schedule,
          spawn: this.options.nativeSpawn,
          onSubmitted: () => {
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
          },
          lifecycle: this.nativeLifecycle(attempt, () => this.nativeCurrent(runtime)),
        },
      );
      if (runtime.stopped || this.closed) runtime.handle.stop();
      void runtime.handle.result.then(finish, () => finish(null));
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
        pending.target === target
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
      revision: 0,
      requester: 'Controller',
      consequence: `Permit one ${action} action for this attempt.`,
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
    const restore = this.closePendingEffects(task);
    const active = this.store
      .intents()
      .find((intent) => intent.task_id === task.id && intent.state !== 'stopped');
    if (!active) {
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
      for (const intent of this.store.intents().filter((value) => value.state !== 'stopped')) {
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
        const stopped =
          known &&
          (native
            ? phases.every((phase) => groupAbsent(phase.process_group))
            : groupAbsent(intent.process_group));
        const updated = {
          ...attempt,
          state: stopped ? ('stopped' as const) : ('unknown' as const),
          revision: attempt.revision + 1,
        };
        this.store.put('attempt', attempt.id, updated.revision, updated);
        this.store.db
          .prepare('UPDATE launch_intents SET state=?,finished_at=? WHERE attempt_id=?')
          .run(
            stopped ? 'stopped' : known ? 'acknowledged' : 'outcome-unknown',
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
    };
    if (
      task.runId &&
      this.store.receipt(`native-run:${task.runId}`) &&
      request.kind !== 'export' &&
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
        this.evidence.hash(run.source.base, readFiles(join(this.home, 'scratch', run.id))) !==
          candidate.hash
      )
        return {
          outcome: 'blocked',
          reason: 'candidate-binding-changed',
          next: 'Refresh the candidate and request a new exact action.',
        };
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

  private sealCandidate(attempt: Attempt): Candidate {
    const run = this.store.get<Run>('run', attempt.runId) as Run;
    if (this.hasUncertainWriter(run.taskId)) throw new Error('Writer ownership is not quiescent.');
    const intent = this.store
      .intents()
      .find((value) => value.attempt_id === attempt.id) as LaunchIntent;
    const files = readFiles(intent.scratch_path);
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
    plan: Pick<CheckPlan, 'definitionHash' | 'evaluator'>,
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
    const remaining = remainingBudgets(run, this.store.intents());
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

  private settleJob(attempt: Attempt, quiescent: boolean, closing = false): boolean {
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
        (intent) =>
          intent.run_id === run.id && intent.scratch_path === join(this.home, 'scratch', run.id),
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
    const remaining = remainingBudgets(run, this.store.intents());
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
  ): SealedHandoffPacket {
    const run = this.store.get<Run>('run', writer.runId) as Run;
    const task = this.store.get<Task>('task', run.taskId) as Task;
    if (this.hasUncertainWriter(task.id)) throw new Error('Context sealing requires quiescence.');
    const packet = buildHandoff({
      run,
      outgoing: writer,
      quiescent: true,
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
        remainingBudgets: remainingBudgets(run, this.store.intents()),
        unresolvedExposure: [],
        policy: run.policy,
        allowedRouteIds: [
          ...new Set(run.roles.flatMap((role) => [role.routeId, ...role.approvedFallbacks])),
        ],
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
    if (this.store.receipt(`native-run:${run.id}`))
      return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
    if (!['ready', 'accepted', 'waiting'].includes(task.state))
      return { outcome: 'blocked', reason: 'candidate-not-ready' };
    if (
      this.hasUncertainWriter(task.id) ||
      this.evidence.hash(run.source.base, readFiles(join(this.home, 'scratch', run.id))) !==
        candidate.hash
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
    const writer = this.store
      .intents()
      .filter(
        (intent) =>
          intent.run_id === run.id && intent.scratch_path === join(this.home, 'scratch', run.id),
      )
      .at(-1);
    if (!writer) return { outcome: 'blocked', reason: 'candidate-origin-missing' };
    if (!grant && !approved)
      return this.requestAction(
        task,
        run,
        this.store.get<Attempt>('attempt', writer.attempt_id) as Attempt,
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
      if (origin && this.store.receipt(`native-run:${origin.id}`))
        throw new Error('The native pilot permits retention and export only.');
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
          this.evidence.hash(
            currentRun.source.base,
            readFiles(join(this.home, 'scratch', currentRun.id)),
          ) !== candidate.hash ||
          hashCanonical(inspectSource(task.projectId, source)) !== hashCanonical(origin.source)
        )
          throw new Error('Prepared publication authority is no longer current.');
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
          (intent) =>
            intent.run_id === run.id && intent.scratch_path === join(this.home, 'scratch', run.id),
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

  private event(type: Event['type'], taskId: string, revision: number, payload: Event['payload']) {
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
