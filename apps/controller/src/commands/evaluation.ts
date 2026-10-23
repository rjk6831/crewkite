import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type Artifact,
  ArtifactSchema,
  type Attempt,
  AttemptSchema,
  type Candidate,
  type CandidateEvaluationPreview,
  CandidateEvaluationPreviewSchema,
  CandidateEvaluationStartReasonSchema,
  CandidateSchema,
  CheckResultSchema,
  type Command,
  type CommandResult,
  canonicalJson,
  formatReviewTarget,
  type Grant,
  HashSchema,
  MAX_FRAME_BYTES,
  type Project,
  type Route,
  RouteSchema,
  type Run,
  RunSchema,
  requiredReviewMethodIds,
  type Task,
  TimestampSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import type { CheckDefinition, CheckPlan } from '../evidence/index.ts';
import {
  assertVerificationSource,
  prepareToolchain,
  verificationPreview,
  verificationTarget,
} from '../evidence/toolchain-definition.ts';
import { ToolchainVerification } from '../evidence/toolchain-verify.ts';
import { type CheckOwner, parseCheckOwner } from '../host/check-ownership.ts';
import { committedFiles, inspectSource } from '../host/source.ts';
import type { DependencyInventory } from '../host/toolchain.ts';
import { localConfiguredConnectionHash } from '../providers/local/connection.ts';
import {
  BindingSchema as LocalBindingSchema,
  TerminalSchema as LocalTerminalSchema,
} from '../providers/local/profile.ts';
import type { Controller } from './controller.ts';
import {
  CandidateEvaluationSchema,
  EvaluationConsentSchema,
  type EvaluationWriterPreparation,
  type LocalPrepared,
  LocalPreparedSchema,
  NativeHistoricalPreparationSchema,
  type PreparedVerification,
  runtimeRoot,
} from './schemas.ts';

// Candidate evaluation and repository verification.
export class EvaluationCommands {
  evaluationPreparation(
    this: Controller,
    run: Run,
    candidate: Candidate,
  ): EvaluationWriterPreparation {
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

  localWriterEvidence(this: Controller, plan: LocalPrepared, candidate: Candidate) {
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

  evaluationOrigin(this: Controller, taskId: string, candidateId: string, ownedAttemptId?: string) {
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

  evaluationInputs(
    this: Controller,
    command: Extract<Command, { command: 'PrepareCandidateEvaluation' }>,
  ) {
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

  verificationLineage(this: Controller, input: ReturnType<Controller['evaluationInputs']>) {
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

  prepareVerificationCommand(
    this: Controller,
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

  prepareEvaluation(
    this: Controller,
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

  evaluationPlan(this: Controller, artifact: Artifact) {
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

  evaluationStartAvailability(
    this: Controller,
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

  candidateEvaluations(
    this: Controller,
    taskIds?: ReadonlySet<string>,
  ): CandidateEvaluationPreview[] {
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

  localCheckRoute(this: Controller, create = true) {
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

  startEvaluation(
    this: Controller,
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

  startVerification(
    this: Controller,
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

  verificationLaunch(this: Controller, attemptId: string) {
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

  verificationCurrent(this: Controller, attempt: Attempt, artifact: Artifact): boolean {
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

  launchVerification(this: Controller, attempt: Attempt, artifact: Artifact, minutes: number) {
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

  currentEvaluationDefinition(
    this: Controller,
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

  evaluationAuthority(this: Controller, artifact: Artifact, ownedAttemptId?: string) {
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
}
