import {
  type Approval,
  type Artifact,
  ArtifactSchema,
  type Attempt,
  type Candidate,
  type CheckResult,
  CheckResultSchema,
  type ConversationModelChoices,
  type ConversationModelRequest,
  EventSchema,
  type ModelCatalogObservation,
  ModelCatalogObservationSchema,
  type Observation,
  type Project,
  type ReviewJob,
  type Run,
  type Snapshot,
  SnapshotSchema,
  type SnapshotScope,
  SnapshotScopeSchema,
  type Task,
  type TaskConversationState,
  TaskConversationStateSchema,
  type TaskModelCatalog,
  TaskModelCatalogSchema,
  WorkspaceStateSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { inspectSource } from '../host/source.ts';
import type { LaunchIntent } from '../store/index.ts';
import { deriveWindow } from '../usage/index.ts';
import { remainingBudgets, remainingCombinedBudgets } from './budgets.ts';
import type { Controller } from './controller.ts';
import {
  type ConversationModelFailureReason,
  localHardwareStatus,
  NativeQuotaCompletionSchema,
} from './schemas.ts';

// Workspace and task reads: snapshots, retained conversation state, model catalogs and paths.
export class ProjectCommands {
  workspaceState(this: Controller) {
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
      usageReaders: [
        this.googleUsageReader(),
        this.openAiUsageReader(),
        {
          ...this.anthropicUsage().status(),
          ...(this.options.chatClients?.anthropic
            ? { client: this.chatClientFor('anthropic').status }
            : {}),
        },
      ],
      routes: this.store.list('route'),
      usage: this.store
        .list<Observation>('window')
        .map((observation) =>
          deriveWindow(observation, { nowMs: Date.parse(this.now()), maxAgeMs: 300000 }),
        ),
    });
  }

  snapshot(this: Controller, scope?: SnapshotScope): Snapshot {
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

  taskModelCatalogReference(this: Controller, taskId: string) {
    const receipt = this.store.receipt(`task-model-catalog:${taskId}`);
    if (!receipt?.result.entity) return;
    const artifact = ArtifactSchema.safeParse(receipt.result.entity);
    if (!artifact.success || artifact.data.hash !== receipt.hash) return;
    return { artifactId: artifact.data.id, hash: artifact.data.hash };
  }

  taskModelCatalog(
    this: Controller,
    taskId: string,
    reference: ConversationModelRequest['observation'],
    prepared = false,
  ): TaskModelCatalog {
    const artifact = this.store.get<Artifact>('artifact', reference.artifactId);
    if (!artifact || artifact.hash !== reference.hash) throw Error('observation-missing');
    if (artifact.bytes > 32768) throw Error('catalog-unavailable');
    const content = this.artifacts.read(artifact.hash);
    if (content.length !== artifact.bytes) throw Error('catalog-unavailable');
    const catalog = TaskModelCatalogSchema.parse(JSON.parse(content.toString('utf8')));
    const retained = this.store.receipt(`task-model-catalog:${taskId}`);
    const task = this.store.get<Task>('task', taskId);
    const projectPath = task && this.projectPath(task.projectId);
    if (
      catalog.taskId !== taskId ||
      !task ||
      (!prepared && catalog.taskRevision !== task.revision) ||
      catalog.source.projectId !== task.projectId ||
      !projectPath ||
      hashCanonical(catalog.source) !== hashCanonical(inspectSource(task.projectId, projectPath)) ||
      (!prepared &&
        (retained?.hash !== artifact.hash ||
          hashCanonical(retained.result.entity ?? null) !== hashCanonical(artifact)))
    )
      throw Error('observation-stale');
    return catalog;
  }

  modelCatalog(
    this: Controller,
    taskId: string,
    reference: ConversationModelRequest['observation'],
    prepared = false,
  ): TaskModelCatalog {
    const artifact = this.store.get<Artifact>('artifact', reference.artifactId);
    if (!artifact || artifact.hash !== reference.hash) throw Error('observation-missing');
    if (artifact.bytes > 32768) throw Error('catalog-unavailable');
    const parsed = ModelCatalogObservationSchema.parse(
      JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
    );
    // Only a task catalog can back a model request. A catalog a planning turn retained is refused.
    if (!('origin' in parsed)) throw Error('observation-stale');
    return this.taskModelCatalog(taskId, reference, prepared);
  }

  catalogReason(
    this: Controller,
    catalog: ModelCatalogObservation,
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

  projectModelChoices(this: Controller, taskId: string): ConversationModelChoices {
    const observation = this.taskModelCatalogReference(taskId);
    if (!observation)
      return {
        status: 'not-observed',
        observation: null,
        observedAt: null,
        models: [],
        reason: 'not-observed',
      };
    try {
      const catalog = this.taskModelCatalog(taskId, observation);
      const reason = this.catalogReason(catalog);
      if (reason && reason !== 'client-changed')
        return {
          status: 'unavailable',
          observation,
          observedAt: catalog.observedAt,
          models: [],
          reason,
        };
      return {
        status: reason === 'client-changed' ? 'client-changed' : 'last-observed',
        observation,
        observedAt: catalog.observedAt,
        models: catalog.models,
        reason: reason ?? 'available',
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

  remaining(this: Controller, run: Run) {
    const intents = this.chargeableIntents();
    const group = this.store.combinedGroup(run.id);
    const ignored = new Set(
      this.store
        .intents()
        .filter((intent) => this.confirmedQuotaDenial(intent))
        .map((intent) => intent.attempt_id),
    );
    return group
      ? remainingCombinedBudgets(
          this.store.get<Run>('run', group.run_id) as Run,
          intents,
          this.store.combinedDispatches(group.run_id),
          group,
          ignored,
        )
      : remainingBudgets(run, intents);
  }

  confirmedQuotaDenial(this: Controller, intent: LaunchIntent) {
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

  chargeableIntents(this: Controller) {
    return this.store.intents().filter((intent) => !this.confirmedQuotaDenial(intent));
  }

  conversationState(this: Controller, taskId: string): TaskConversationState {
    const task = this.store.get<Task>('task', taskId);
    if (!task) throw Error('task-not-found');
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
    return TaskConversationStateSchema.parse({
      taskId: task.id,
      revision: task.revision,
      contractStatus: 'confirmed',
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
                  : 'idle',
      configuration: null,
      projectModelChoices: this.projectModelChoices(task.id),
      currentRunId: task.runId,
      activeAttempt: active,
      budget: null,
      queuedInputCount,
      pendingQuestions,
      proposal,
      adoptedProposal: null,
      // Messages go through the chat thread. This read reports retained entries, and nothing here
      // can be sent or adopted.
      send: {
        available: false,
        reason: this.closed ? 'controller-closing' : 'not-configured',
        disposition: null,
      },
      adopt: { available: false, reason: 'not-configured' },
    });
  }

  taskArtifacts(this: Controller, taskId: string): Artifact[] {
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

  projectSource(this: Controller, projectId: string) {
    const key = `project-source:${projectId}`;
    const cached = this.projectionCache?.get(key) as ReturnType<typeof inspectSource> | undefined;
    if (cached) return cached;
    const path = this.projectPath(projectId);
    if (!path) throw Error('Project path is unavailable.');
    const source = inspectSource(projectId, path);
    this.projectionCache?.set(key, source);
    return source;
  }

  projectPath(this: Controller, projectId: string): string | undefined {
    return this.store.db.prepare('SELECT path FROM project_paths WHERE project_id=?').get(projectId)
      ?.path as string | undefined;
  }
}
