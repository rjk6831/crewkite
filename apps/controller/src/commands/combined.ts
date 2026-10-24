import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type Artifact,
  ArtifactSchema,
  type Attempt,
  type Candidate,
  type CheckResult,
  CombinedDispatchPhaseSchema,
  type CombinedRunPreview,
  CombinedRunPreviewSchema,
  type Command,
  type CommandResult,
  CommandSchema,
  canonicalJson,
  MAX_FRAME_BYTES,
  RouteSchema,
  type Run,
  RunSchema,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { z } from 'zod';
import { frozenVerificationPath } from '../evidence/toolchain-definition.ts';
import {
  createIntegrationGit,
  type IntegrationGitOptions,
  type IntegrationGitOutcome,
} from '../host/integration-git.ts';
import { committedFiles, type FileContent, inspectSource } from '../host/source.ts';
import type { CombinedGroup, CombinedMember } from '../store/index.ts';
import type { Controller } from './controller.ts';
import {
  type CombinedManifest,
  CombinedManifestSchema,
  CombinedRefJournalSchema,
  NativePreparationSchema,
} from './schemas.ts';

// Combined runs: preparation, current state, integration git and stop.
export class CombinedCommands {
  combinedManifest(this: Controller, group: CombinedGroup): CombinedManifest {
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

  combinedCurrent(this: Controller, group: CombinedGroup, permitStopped = false) {
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

  updateCombined(
    this: Controller,
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

  combinedPreview(this: Controller, group: CombinedGroup): CombinedRunPreview {
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

  prepareCombined(
    this: Controller,
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

  captureCombined(this: Controller, group: CombinedGroup, files: FileContent[]) {
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

  async combinedGit<T extends string | boolean | null>(
    this: Controller,
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

  stopCombined(this: Controller, group: CombinedGroup, effects: (() => void)[]) {
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

  refreshCombinedStop(this: Controller, group: CombinedGroup) {
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
}
