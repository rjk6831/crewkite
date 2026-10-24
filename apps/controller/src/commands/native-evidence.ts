import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcpApprovalTargetSchema,
  type Artifact,
  ArtifactSchema,
  type Attempt,
  AttemptSchema,
  type Candidate,
  type CandidateEvaluationPreview,
  CandidateEvaluationPreviewSchema,
  CandidateSchema,
  CheckResultSchema,
  type CombinedNativeReviewJob,
  type Command,
  type CommandResult,
  canonicalJson,
  formatReviewTarget,
  GoogleNativePermissionModeSchema,
  HashSchema,
  MAX_FRAME_BYTES,
  NativeBillingAttestationSchema,
  NativeRepositoryExecutionSchema,
  NativeRepositoryScopeSchema,
  type NativeReviewJob,
  NativeReviewJobSchema,
  type Project,
  type ReviewResult,
  ReviewResultSchema,
  type Route,
  RouteIdSchema,
  RouteSchema,
  type Run,
  requiredReviewMethodIds,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import { completedCheckDefinitionMatches } from '../evidence/index.ts';
import { validateIdentity } from '../host/publication.ts';
import { committedFiles } from '../host/source.ts';
import { subscriptionAuth } from '../providers/anthropic/profile.ts';
import type { NativeProfileResolution } from '../providers/openai/profile.ts';
import { ReplacementPathSchema } from '../providers/openai/replacement.ts';
import { type ReviewPlan, reviewPlan, startReview } from '../providers/openai/review.ts';
import type { CombinedGroup } from '../store/index.ts';
import type { Controller } from './controller.ts';
import {
  type CandidateEvaluationSchema,
  type EvaluationWriterPreparation,
  freezeNative,
  NativeFileAppointmentSchema,
  NativeHistoricalPreparationSchema,
  type NativePilotAppointment,
  type NativePreparationSchema,
  type NativePublicScopeSchema,
  type NativeReviewRuntime,
} from './schemas.ts';

// Native writer evidence, publication evidence and candidate review.
export class NativeEvidenceCommands {
  nativeRecord(
    this: Controller,
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

  anthropicWriterEvidence(
    this: Controller,
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

  googleWriterEvidence(
    this: Controller,
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

  repositoryResult(
    this: Controller,
    appointment: NativePilotAppointment,
    attemptId: string,
    value: unknown,
  ) {
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

  nativeAcpEvidence(
    this: Controller,
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

  nativeRepositoryEvidence(
    this: Controller,
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

  repositoryRecoveryProof(
    this: Controller,
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

  retainRepositoryRecovery(this: Controller, task: Task) {
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

  nativeReviewSource(this: Controller, plan: EvaluationWriterPreparation, candidate: Candidate) {
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

  nativePublicationEvidence(this: Controller, run: Run, candidate: Candidate) {
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

  nativeAcceptanceAvailability(
    this: Controller,
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

  nativePublicationCurrent(
    this: Controller,
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

  candidateReviewAuthority(this: Controller, artifact: Artifact, ownedAttemptId?: string) {
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

  nativeReviewIdentity(
    this: Controller,
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

  candidateReviewRoute(
    this: Controller,
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

  startCandidateReview(
    this: Controller,
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

  nativeReviewCurrent(this: Controller, runtime: NativeReviewRuntime) {
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

  launchCandidateReview(
    this: Controller,
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
}
