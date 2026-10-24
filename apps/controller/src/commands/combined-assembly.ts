import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type Artifact,
  ArtifactSchema,
  type Attempt,
  type Candidate,
  CandidateSchema,
  type CheckResult,
  type CombinedOrigin,
  CombinedOriginSchema,
  type Command,
  type CommandResult,
  canonicalJson,
  MAX_FRAME_BYTES,
  type Route,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { CheckPlan } from '../evidence/index.ts';
import { assembleSlices } from '../host/integration.ts';
import { committedFiles } from '../host/source.ts';
import { closedBefore, defaultSchedule, OwnedCommand } from '../host/worker.ts';
import type { CombinedDispatch, CombinedGroup } from '../store/index.ts';
import { unspentIntegrationMinutes } from './budgets.ts';
import type { Controller } from './controller.ts';
import { CombinedRefJournalSchema } from './schemas.ts';

// Combined runs: checks, baseline, resume and candidate assembly.
export class CombinedAssemblyCommands {
  combinedCheck(
    this: Controller,
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

  async launchCombinedCheck(
    this: Controller,
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

  resumeCombined(
    this: Controller,
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

  startCombinedBaseline(
    this: Controller,
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

  combinedDefinition(
    this: Controller,
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

  combinedChecked(
    this: Controller,
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

  combinedContributors(this: Controller, group: CombinedGroup) {
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

  combinedRefCurrent(this: Controller, group: CombinedGroup, preparedHead?: string | null) {
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

  combinedOrigin(this: Controller, group: CombinedGroup, candidate: Candidate) {
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

  combinedContributorsForOrigin(this: Controller, group: CombinedGroup) {
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

  assembleCombined(
    this: Controller,
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

  async assembleCombinedStages(
    this: Controller,
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
}
