import { join } from 'node:path';
import {
  type Artifact,
  ArtifactSchema,
  type Attempt,
  AttemptSchema,
  type Candidate,
  type CandidateEvaluationPreview,
  CandidateEvaluationPreviewSchema,
  CandidateSchema,
  type CheckResult,
  CheckResultSchema,
  CombinedNativeReviewJobSchema,
  type CombinedOrigin,
  type Command,
  type CommandResult,
  canonicalJson,
  formatReviewTarget,
  type Grant,
  HashSchema,
  MAX_FRAME_BYTES,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import { validateIdentity } from '../host/publication.ts';
import { committedFiles, type FileContent } from '../host/source.ts';
import { type ReviewPlan, reviewPlan } from '../providers/openai/review.ts';
import type { CombinedDispatch, CombinedGroup } from '../store/index.ts';
import type { Controller } from './controller.ts';
import {
  CombinedEvaluationSchema,
  EvaluationConsentSchema,
  freezeNative,
  NativeHistoricalPreparationSchema,
} from './schemas.ts';

// Combined runs: evaluation, review and publication evidence.
export class CombinedEvaluationCommands {
  combinedEvaluationPlan(this: Controller, artifact: Artifact) {
    const stored = this.store.get<Artifact>('artifact', artifact.id);
    if (
      !stored ||
      hashCanonical(stored) !== hashCanonical(artifact) ||
      artifact.bytes > MAX_FRAME_BYTES ||
      this.store.receipt(`evaluation-plan:${artifact.id}`)?.hash !== artifact.hash
    )
      throw Error('Combined evaluation preparation changed.');
    return CombinedEvaluationSchema.parse(
      JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
    );
  }

  combinedEvaluationAuthority(this: Controller, artifact: Artifact, ownedAttemptId?: string) {
    const plan = this.combinedEvaluationPlan(artifact);
    const group = this.store.combinedGroup(plan.run.id);
    if (!group || group.run_id !== plan.run.id) throw Error('Combined parent missing.');
    const { manifest, task } = this.combinedCurrent(
      group,
      !!ownedAttemptId &&
        group.phase === 'paused' &&
        this.store
          .combinedDispatches(group.run_id)
          .some((slot) => slot.attempt_id === ownedAttemptId && slot.state === 'running'),
    );
    const candidate = CandidateSchema.parse(
      this.store.get<Candidate>('candidate', plan.candidate.id),
    );
    const origin = this.combinedOrigin(group, candidate);
    const profile = this.profileFor(manifest.input.reviewer.profileId);
    const { scopeHash: _scopeHash, expiresAt: _expiresAt, ...fields } = plan;
    const consent = EvaluationConsentSchema.parse(
      this.nativeRecord(`evaluation-consent:${plan.scopeHash}`, 4096).value,
    );
    if (
      consent.scopeHash !== plan.scopeHash ||
      Date.parse(consent.expiresAt) <= Date.parse(this.now())
    )
      throw Error('Combined evaluation consent changed.');
    if (
      hashCanonical(fields) !== plan.scopeHash ||
      hashCanonical(plan.run.policy) !== hashCanonical(manifest.run.policy) ||
      hashCanonical(plan.origin) !== hashCanonical(origin) ||
      hashCanonical(plan.context) !==
        hashCanonical({ title: task.title, outcome: task.outcome, criteria: task.criteria }) ||
      hashCanonical(plan.definition) !==
        hashCanonical(
          this.combinedDefinition(group, 'final-check', candidate, hashCanonical(origin)),
        ) ||
      hashCanonical(plan.reviewer.profile) !== hashCanonical(profile.facts) ||
      hashCanonical(plan.reviewer.client) !== hashCanonical(profile.client) ||
      plan.reviewer.locationHash !== profile.locationHash ||
      !profile.facts.available ||
      !profile.environment ||
      Date.parse(plan.expiresAt) <= Date.parse(this.now()) ||
      this.store
        .intents()
        .some(
          (intent) =>
            [
              group.run_id,
              ...this.store.combinedMembers(group.run_id).map((member) => member.run_id),
            ].includes(intent.run_id) &&
            intent.state !== 'stopped' &&
            intent.attempt_id !== ownedAttemptId,
        )
    )
      throw Error('Combined evaluation authority changed.');
    for (const grant of plan.grants)
      if (
        grant.taskId !== task.id ||
        grant.revoked ||
        grant.usesRemaining !== 1 ||
        Date.parse(grant.expiresAt) <= Date.parse(this.now())
      )
        throw Error('Combined grants changed.');
    return { plan, group, manifest, task, candidate, origin, environment: profile.environment };
  }

  prepareCombinedEvaluation(
    this: Controller,
    command: Extract<Command, { command: 'PrepareCandidateEvaluation' }>,
    group: CombinedGroup,
  ): CommandResult {
    const { manifest, task } = this.combinedCurrent(group);
    if (
      group.phase !== 'awaiting-evaluation' ||
      this.store.receipt(`evaluation-started:${group.run_id}`)
    )
      return { outcome: 'blocked', reason: 'combined-evaluation-unavailable' };
    const candidate = CandidateSchema.parse(
      this.store.get<Candidate>('candidate', command.payload.candidateId),
    );
    const origin = this.combinedOrigin(group, candidate);
    const selected = command.payload.reviewer;
    const frozen = manifest.input.reviewer;
    if (
      command.payload.checkRecipeId !== 'project-node-tests-v1' ||
      hashCanonical(command.payload.testFiles) !== hashCanonical(manifest.input.checks.testFiles) ||
      selected.profileId !== frozen.profileId ||
      selected.methodId !== 'keep-it-simple' ||
      selected.cycles !== 1 ||
      command.payload.creditPolicy !== frozen.creditPolicy
    )
      return { outcome: 'blocked', reason: 'combined-frozen-evaluation-required' };
    const grants = command.payload.grants;
    const expected = [
      { action: 'run-check', target: 'node --test' },
      {
        action: 'run-review',
        target: formatReviewTarget({ methodId: 'keep-it-simple', cycle: 1 }),
      },
    ];
    if (
      grants.some(
        (grant) =>
          grant.taskId !== task.id ||
          grant.revoked ||
          grant.usesRemaining !== 1 ||
          Date.parse(grant.expiresAt) <= Date.parse(this.now()) ||
          this.store.receipt(this.grantKey(grant)),
      ) ||
      expected.some(
        (value) =>
          grants.filter((grant) => grant.action === value.action && grant.target === value.target)
            .length !== 1,
      )
    )
      return { outcome: 'blocked', reason: 'combined-exact-evaluation-grants-required' };
    const profile = this.profileFor(frozen.profileId);
    if (
      !profile.facts.available ||
      !profile.client ||
      !profile.locationHash ||
      !profile.environment ||
      hashCanonical(profile.facts) !== hashCanonical(manifest.reviewer.profile) ||
      hashCanonical(profile.client) !== hashCanonical(manifest.reviewer.client) ||
      profile.locationHash !== manifest.reviewer.locationHash
    )
      return { outcome: 'blocked', reason: 'combined-reviewer-changed' };
    const fields = {
      run: manifest.run,
      candidate,
      origin,
      context: { title: task.title, outcome: task.outcome, criteria: task.criteria },
      definition: this.combinedDefinition(group, 'final-check', candidate, hashCanonical(origin)),
      reviewer: {
        ...selected,
        role: 'reviewer' as const,
        profile: profile.facts,
        client: profile.client,
        locationHash: profile.locationHash,
      },
      creditPolicy: frozen.creditPolicy,
      grants,
      remaining: this.remaining(manifest.run),
      maximumCheckMinutes: 1 as const,
    };
    const scopeHash = hashCanonical(fields);
    let expiresAt = Math.min(...grants.map((grant) => Date.parse(grant.expiresAt)));
    const saved = this.store.receipt(`evaluation-consent:${scopeHash}`);
    if (saved)
      expiresAt = Math.min(
        expiresAt,
        Date.parse(
          EvaluationConsentSchema.parse(
            this.nativeRecord(`evaluation-consent:${scopeHash}`, 4096).value,
          ).expiresAt,
        ),
      );
    else if (command.payload.consent !== 'explicit')
      return { outcome: 'blocked', reason: 'combined-consent-required' };
    if (expiresAt <= Date.parse(this.now()))
      return { outcome: 'blocked', reason: 'combined-consent-expired' };
    const plan = CombinedEvaluationSchema.parse({
      ...fields,
      scopeHash,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    if (Buffer.byteLength(canonicalJson(plan)) > MAX_FRAME_BYTES)
      throw Error('Combined evaluation exceeds its bound.');
    const artifact = this.nativeArtifact(plan);
    for (const key of [`evaluation-plan:${artifact.id}`, `evaluation-ready:${group.run_id}`])
      this.store.saveReceipt(key, artifact.hash, 'local-owner', {
        outcome: 'applied',
        entity: artifact,
      });
    if (!saved) {
      const consent = this.nativeArtifact({ scopeHash, expiresAt: plan.expiresAt });
      this.store.saveReceipt(`evaluation-consent:${scopeHash}`, scopeHash, 'local-owner', {
        outcome: 'applied',
        entity: consent,
      });
    }
    const updated = this.updateTask(task, {
      next: 'Start the frozen full combined checks. Review remains a separate action.',
    });
    return { outcome: 'applied', entity: artifact, revision: updated.revision };
  }

  startCombinedEvaluation(
    this: Controller,
    command: Extract<Command, { command: 'StartCandidateEvaluation' }>,
    effects: (() => void)[],
    group: CombinedGroup,
  ): CommandResult {
    const artifact = ArtifactSchema.parse(
      this.store.get<Artifact>('artifact', command.payload.preparationId),
    );
    const { plan, task, candidate } = this.combinedEvaluationAuthority(artifact);
    if (
      group.phase !== 'awaiting-evaluation' ||
      plan.run.taskId !== command.payload.taskId ||
      candidate.id !== command.payload.candidateId ||
      this.store.receipt(`evaluation-started:${group.run_id}`) ||
      plan.grants.some((grant) => this.store.receipt(this.grantKey(grant)))
    )
      return { outcome: 'blocked', reason: 'combined-evaluation-unavailable' };
    const passed = this.combinedCheck(
      group,
      'final-check',
      candidate,
      effects,
      hashCanonical(plan.origin),
    );
    const slot = this.store
      .combinedDispatches(group.run_id)
      .find((slot) => slot.phase === 'final-check') as CombinedDispatch;
    this.store.saveReceipt(`evaluation-started:${group.run_id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    this.store.saveReceipt(`evaluation-check:${slot.attempt_id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    this.consumeGrant(plan.run, plan.grants.find((grant) => grant.action === 'run-check') as Grant);
    this.updateCombined(group, 'checking');
    const updated = this.updateTask(task, {
      state: 'checking',
      waitingReason: null,
      next: 'Running the full combined collection and interaction checks.',
    });
    effects.push(() => {
      void passed
        .then((pass) => {
          if (!pass || this.closed) return;
          this.store.transaction(() => {
            const current = this.combinedCurrent(group).group;
            if (current.phase !== 'checking') return;
            const verified = this.combinedChecked(
              group,
              'final-check',
              candidate,
              hashCanonical(plan.origin),
            );
            const check = ArtifactSchema.parse(
              this.store.get<Artifact>('artifact', verified.check.artifactId),
            );
            this.store.saveReceipt(
              `evaluation-result:${artifact.id}`,
              artifact.hash,
              'local-owner',
              { outcome: 'applied', entity: check },
            );
            this.updateCombined(group, 'awaiting-review');
            this.updateTask(this.store.get<Task>('task', group.task_id) as Task, {
              state: 'stopped',
              waitingReason: null,
              next: 'Full checks passed. Start the independent combined review.',
            });
          });
        })
        .catch(() => {});
    });
    return { outcome: 'applied', entity: artifact, revision: updated.revision };
  }

  combinedReviewAuthority(this: Controller, artifact: Artifact, ownedAttemptId?: string) {
    const prepared = this.combinedEvaluationAuthority(artifact, ownedAttemptId);
    const { plan, group } = prepared;
    if (
      !['awaiting-review', 'reviewing'].includes(group.phase) &&
      !(ownedAttemptId && group.phase === 'paused' && group.paused_phase === 'reviewing')
    )
      throw Error('Full combined checks are required.');
    const proof = this.combinedChecked(
      group,
      'final-check',
      plan.candidate,
      hashCanonical(plan.origin),
    );
    const checkArtifact = ArtifactSchema.parse(
      this.store.get<Artifact>('artifact', proof.check.artifactId),
    );
    const grant = plan.grants.find((grant) => grant.action === 'run-review') as Grant;
    const consumed = this.store.receipt(this.grantKey(grant));
    if (
      (!ownedAttemptId && consumed) ||
      (ownedAttemptId && consumed?.hash !== hashCanonical(grant))
    )
      throw Error('The combined review grant changed.');
    return { ...prepared, checkArtifact, grant };
  }

  startCombinedReview(
    this: Controller,
    command: Extract<Command, { command: 'StartCandidateReview' }>,
    effects: (() => void)[],
    group: CombinedGroup,
  ): CommandResult {
    const artifact = ArtifactSchema.parse(
      this.store.get<Artifact>('artifact', command.payload.preparationId),
    );
    const prepared = this.combinedReviewAuthority(artifact);
    const { plan, manifest, candidate, task } = prepared;
    if (
      group.phase !== 'awaiting-review' ||
      plan.run.taskId !== command.payload.taskId ||
      candidate.id !== command.payload.candidateId ||
      this.store.receipt(`native-review-started:${group.run_id}`)
    )
      return { outcome: 'blocked', reason: 'combined-review-unavailable' };
    const slot = this.store
      .combinedDispatches(group.run_id)
      .find((slot) => slot.phase === 'review') as CombinedDispatch;
    const route = manifest.reviewer.route;
    const prototype = NativeHistoricalPreparationSchema.parse(
      this.nativeRecord(`native-run:${manifest.members[0].run.id}`).value,
    ).appointment;
    const decision = this.nativeDecision(
      {
        ...prototype,
        route,
        creditPolicy: plan.creditPolicy,
        maximumTaskMs: slot.maximum_minutes * 60000,
        expiresAt: plan.expiresAt,
      },
      plan.run,
      true,
    );
    if (!decision.chosen || decision.chosen !== route.id)
      return { outcome: 'blocked', reason: 'combined-review-allowance-unavailable' };
    const attempt = this.jobAttempt(plan.run, route.id);
    const job = CombinedNativeReviewJobSchema.parse({
      taskId: group.task_id,
      runId: group.run_id,
      attemptId: attempt.id,
      generation: attempt.generation,
      routeId: route.id,
      candidateId: candidate.id,
      candidateHash: candidate.hash,
      methodId: 'keep-it-simple',
      cycle: 1,
      limitMinutes: slot.maximum_minutes,
      scripted: false,
      preparationId: artifact.id,
      profileId: 'openai-file-v1',
      assignedRole: 'reviewer',
      independence: 'process-only',
      origin: plan.origin,
    });
    const source = committedFiles(this.projectPath(task.projectId) as string, plan.run.source.base);
    const files = this.evidence.read(candidate).files;
    const paths = [
      ...new Set([...source.map((file) => file.path), ...files.map((file) => file.path)]),
    ].sort();
    const encode = (file: FileContent | undefined) =>
      file
        ? {
            mode: file.mode,
            hash: file.hash,
            content: new TextDecoder('utf-8', { fatal: true }).decode(file.content),
          }
        : null;
    const input = reviewPlan({
      binding: { ...job, scopeHash: plan.scopeHash },
      directory: join(this.home, 'native-review', attempt.id),
      model: route.model as ReviewPlan['model'],
      effort: route.effort.requested as ReviewPlan['effort'],
      creditPolicy: plan.creditPolicy,
      repository: {
        version: 1,
        sourceBase: plan.run.source.base,
        sourceManifestHash: plan.origin.sourceManifestHash,
        candidateManifestHash: candidate.hash,
        changes: paths.flatMap((path) => {
          const original = source.find((file) => file.path === path),
            current = files.find((file) => file.path === path);
          return original?.hash === current?.hash && original?.mode === current?.mode
            ? []
            : [{ path, original: encode(original), candidate: encode(current) }];
        }),
      },
      context: plan.context,
    });
    const minutes = this.admitJob(
      plan.run,
      attempt,
      input.directory,
      slot.maximum_minutes,
      'review',
    );
    const identity = this.nativeReviewIdentity(plan, job, prepared.checkArtifact);
    const record = this.nativeArtifact({
      preparation: artifact,
      job,
      input,
      check: prepared.checkArtifact,
      identity,
    });
    this.store.saveReceipt(`native-review-started:${group.run_id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: record,
    });
    this.store.saveReceipt(`native-review-input:${attempt.id}`, record.hash, 'local-owner', {
      outcome: 'applied',
      entity: record,
    });
    this.store.db
      .prepare('INSERT INTO review_jobs(attempt_id,candidate_id,body) VALUES (?,?,?)')
      .run(attempt.id, candidate.id, canonicalJson(job));
    this.consumeGrant(plan.run, prepared.grant);
    this.updateCombined(group, 'reviewing');
    const updated = this.updateTask(task, {
      state: 'checking',
      waitingReason: null,
      next: 'Reviewing the complete combined diff in a fresh process.',
    });
    effects.push(() =>
      this.launchCandidateReview(
        artifact,
        freezeNative(job),
        freezeNative(input),
        attempt,
        minutes,
        prepared.environment,
        identity,
      ),
    );
    return { outcome: 'applied', entity: record, revision: updated.revision };
  }

  combinedPublicationEvidence(
    this: Controller,
    group: CombinedGroup,
    candidate: Candidate,
    paused = false,
  ) {
    const key = `combined-publication:${group.run_id}:${candidate.id}:${candidate.hash}`;
    const cached = this.projectionCache?.get(key) as
      | {
          origin: CombinedOrigin;
          plan: z.infer<typeof CombinedEvaluationSchema>;
          attempt: Attempt;
          review: CheckResult;
        }
      | undefined;
    if (cached) return cached;
    const origin = this.combinedOrigin(group, candidate);
    const manifest = this.combinedManifest(group);
    const artifact = ArtifactSchema.parse(
      this.store.receipt(`evaluation-started:${group.run_id}`)?.result.entity,
    );
    const plan = this.combinedEvaluationPlan(artifact);
    const proof = this.combinedChecked(group, 'final-check', candidate, hashCanonical(origin));
    const slot = this.store
      .combinedDispatches(group.run_id)
      .find((slot) => slot.phase === 'review') as CombinedDispatch;
    const attempt = AttemptSchema.parse(
      this.store.get<Attempt>('attempt', slot.attempt_id as string),
    );
    const saved = z
      .strictObject({
        preparation: ArtifactSchema,
        job: CombinedNativeReviewJobSchema,
        input: z.unknown(),
        check: ArtifactSchema,
        identity: z.strictObject({ evaluator: z.string(), definitionHash: HashSchema }),
      })
      .parse(this.nativeRecord(`native-review-started:${group.run_id}`).value);
    const job = saved.job;
    const input = reviewPlan(saved.input as Parameters<typeof reviewPlan>[0]);
    const identity = this.nativeReviewIdentity(plan, job, saved.check);
    const submission = z
      .strictObject({
        attemptId: AttemptSchema.shape.id,
        preparationHash: HashSchema,
        bindingHash: HashSchema,
      })
      .parse(
        this.nativeRecord(`native-review-submission:${attempt.id}`, 4096, 'outcome-unknown').value,
      );
    const completed = z
      .object({ attemptId: AttemptSchema.shape.id, reason: z.null(), quiescent: z.literal(true) })
      .parse(this.nativeRecord(`native-review-completion:${attempt.id}`, 4096).value);
    const result = z
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
    const stored = this.store.db
      .prepare('SELECT body FROM review_jobs WHERE attempt_id=?')
      .get(attempt.id);
    const grant = plan.grants.find((grant) => grant.action === 'run-review') as Grant;
    const checkGrant = plan.grants.find((grant) => grant.action === 'run-check') as Grant;
    const reviews = this.store.db
      .prepare("SELECT body FROM evidence WHERE candidate_id=? AND kind='review'")
      .all(candidate.id)
      .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)));
    const review = reviews.find(
      (review) =>
        review.passed &&
        review.review?.outcome === 'passed' &&
        hashCanonical(review.review.job) === hashCanonical(job) &&
        review.definitionHash === identity.definitionHash &&
        review.evaluator === identity.evaluator,
    );
    const { scopeHash: _scopeHash, expiresAt: _expiresAt, ...fields } = plan;
    if (
      hashCanonical(fields) !== plan.scopeHash ||
      hashCanonical(plan.run) !== hashCanonical(manifest.run) ||
      hashCanonical(plan.context) !==
        hashCanonical({
          title: manifest.task.title,
          outcome: manifest.task.outcome,
          criteria: manifest.task.criteria,
        }) ||
      hashCanonical(plan.definition) !== hashCanonical(proof.definition) ||
      hashCanonical(plan.reviewer.profile) !== hashCanonical(manifest.reviewer.profile) ||
      hashCanonical(plan.reviewer.client) !== hashCanonical(manifest.reviewer.client) ||
      plan.reviewer.locationHash !== manifest.reviewer.locationHash ||
      plan.creditPolicy !== manifest.input.reviewer.creditPolicy ||
      job.preparationId !== artifact.id ||
      job.attemptId !== attempt.id ||
      job.routeId !== manifest.reviewer.route.id ||
      job.limitMinutes !== slot.maximum_minutes ||
      hashCanonical(saved.preparation) !== hashCanonical(artifact) ||
      this.store.receipt(`native-review-started:${group.run_id}`)?.hash !== artifact.hash ||
      this.store.receipt(`native-review-submission:${attempt.id}`)?.hash !== artifact.hash ||
      this.store.receipt(`evaluation-result:${artifact.id}`)?.hash !== artifact.hash ||
      hashCanonical(this.store.receipt(`evaluation-result:${artifact.id}`)?.result.entity) !==
        hashCanonical(saved.check) ||
      grant.action !== 'run-review' ||
      grant.taskId !== group.task_id ||
      grant.target !== formatReviewTarget({ methodId: 'keep-it-simple', cycle: 1 }) ||
      checkGrant.taskId !== group.task_id ||
      checkGrant.target !== 'node --test'
    )
      throw Error('Combined final preparation changed.');
    if (
      !review ||
      (!['reviewing', 'ready', 'accepted'].includes(group.phase) &&
        !(
          paused &&
          group.phase === 'paused' &&
          ['reviewing', 'ready'].includes(group.paused_phase ?? '')
        )) ||
      this.store.receipt(this.grantKey(checkGrant))?.hash !== hashCanonical(checkGrant) ||
      !stored ||
      slot.state !== 'passed' ||
      attempt.state !== 'stopped' ||
      attempt.runId !== group.run_id ||
      attempt.routeId !== job.routeId ||
      attempt.generation !== job.generation ||
      !this.store.nativePhasesComplete(attempt.id, 'openai') ||
      this.store.intents().find((intent) => intent.attempt_id === attempt.id)?.state !==
        'stopped' ||
      completed.attemptId !== attempt.id ||
      submission.attemptId !== attempt.id ||
      submission.preparationHash !== artifact.hash ||
      submission.bindingHash !== hashCanonical(input.binding) ||
      saved.preparation.hash !== artifact.hash ||
      saved.check.id !== proof.check.artifactId ||
      hashCanonical(saved.identity) !== hashCanonical(identity) ||
      hashCanonical(plan.origin) !== hashCanonical(origin) ||
      hashCanonical(job.origin) !== hashCanonical(origin) ||
      hashCanonical(JSON.parse(stored.body as string)) !== hashCanonical(job) ||
      hashCanonical(input.binding) !== hashCanonical({ ...job, scopeHash: plan.scopeHash }) ||
      hashCanonical(input.context) !== hashCanonical(plan.context) ||
      input.model !== plan.reviewer.profile.model ||
      plan.reviewer.profile.family !== 'openai' ||
      input.effort !== plan.reviewer.profile.effort ||
      result.model !== input.model ||
      result.requestedEffort !== input.effort ||
      hashCanonical(result.review) !==
        hashCanonical({
          version: 1,
          bindingHash: hashCanonical(input.binding),
          methodId: job.methodId,
          cycle: job.cycle,
          outcome: review.review?.outcome,
          findings: review.review?.findings,
          summary: review.review?.summary,
        }) ||
      this.store.receipt(this.grantKey(grant))?.hash !== hashCanonical(grant)
    )
      throw Error('Combined final evidence is incomplete.');
    const resultArtifact = ArtifactSchema.parse(
      this.store.get<Artifact>('artifact', review.artifactId),
    );
    const startedArtifact = ArtifactSchema.parse(
      this.store.receipt(`native-review-started:${group.run_id}`)?.result.entity,
    );
    if (
      review.candidateId !== candidate.id ||
      review.candidateHash !== candidate.hash ||
      resultArtifact.bytes > MAX_FRAME_BYTES ||
      hashCanonical(JSON.parse(this.artifacts.read(resultArtifact.hash).toString('utf8'))) !==
        hashCanonical(review.review) ||
      this.store.receipt(`native-review-input:${attempt.id}`)?.hash !== startedArtifact.hash ||
      this.store.receipt(`native-review-input:${attempt.id}`)?.result.outcome !== 'applied'
    )
      throw Error('Combined retained review changed.');
    const barrier = { origin, plan, attempt, review };
    this.projectionCache?.set(key, barrier);
    return barrier;
  }

  combinedEvaluationPreview(
    this: Controller,
    group: CombinedGroup,
    artifact: Artifact,
  ): CandidateEvaluationPreview {
    const plan = this.combinedEvaluationPlan(artifact);
    const manifest = this.combinedManifest(group);
    const slots = this.store.combinedDispatches(group.run_id);
    const check = this.checks(plan.candidate).find(
      (check) => check.artifactId === slots[5].check_artifact_id,
    );
    const review = this.store.db
      .prepare("SELECT body FROM evidence WHERE candidate_id=? AND kind='review'")
      .all(plan.candidate.id)
      .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)))
      .find((review) => review.review?.job.attemptId === slots[6].attempt_id);
    const availability = (reviewing: boolean): CandidateEvaluationPreview['checkStart'] => {
      try {
        if (
          this.store.receipt(
            `${reviewing ? 'native-review-started' : 'evaluation-started'}:${group.run_id}`,
          )
        )
          return { available: false, reason: 'already-started' };
        if (reviewing) this.combinedReviewAuthority(artifact);
        else this.combinedEvaluationAuthority(artifact);
        const slot = slots[reviewing ? 6 : 5];
        if (
          slot.state !== 'reserved' ||
          !this.remaining(plan.run).concurrency ||
          this.remaining(plan.run).minutes < slot.maximum_minutes
        )
          return { available: false, reason: 'budget-exhausted' };
        if (!reviewing && plan.grants.some((grant) => this.store.receipt(this.grantKey(grant))))
          return { available: false, reason: 'grant-unavailable' };
        return { available: true, reason: 'available' };
      } catch {
        return {
          available: false,
          reason:
            group.phase === 'unknown'
              ? 'ownership-unknown'
              : group.phase === 'paused'
                ? 'paused'
                : reviewing
                  ? 'checks-required'
                  : 'preparation-changed',
        };
      }
    };
    let localAcceptance: CandidateEvaluationPreview['localAcceptance'] = {
      available: false,
      reason: 'evidence-incomplete',
    };
    try {
      this.combinedPublicationEvidence(group, plan.candidate);
      const identity =
        typeof this.options.identity === 'function'
          ? this.options.identity()
          : this.options.identity;
      if (!identity) localAcceptance = { available: false, reason: 'git-identity-missing' };
      else {
        validateIdentity(identity);
        localAcceptance = { available: true, reason: 'available' };
      }
      const publication = this.store.db
        .prepare('SELECT state FROM publications WHERE candidate_id=?')
        .get(plan.candidate.id);
      if (publication)
        localAcceptance = {
          available: false,
          reason: publication.state === 'applied' ? 'accepted' : 'publication-prepared',
        };
      else if (
        this.store.db
          .prepare("SELECT 1 FROM pending_effects WHERE task_id=? AND state='pending'")
          .get(group.task_id)
      )
        localAcceptance = { available: false, reason: 'approval-pending' };
    } catch {}
    return CandidateEvaluationPreviewSchema.parse({
      taskId: group.task_id,
      runId: group.run_id,
      candidateId: plan.candidate.id,
      candidateHash: plan.candidate.hash,
      preparationId: artifact.id,
      recipe: plan.definition.recipeId,
      testFiles:
        plan.definition.recipeId === 'project-node-tests-v1' ? plan.definition.collection : [],
      definitionHash: plan.definition.definitionHash,
      repository: {
        sourceBase: manifest.run.source.base,
        manifestHash: plan.origin.sourceManifestHash,
        files: manifest.sourceFiles.length,
        bytes: manifest.sourceFiles.reduce((sum, file) => sum + file.bytes, 0),
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
      remainingBudgets: this.remaining(plan.run),
      allowance: { source: 'supplemental-evaluation', localChecks: 1, nativeReviews: 1 },
      stage: review
        ? 'reviewed'
        : group.phase === 'checking'
          ? 'checking'
          : group.phase === 'reviewing'
            ? 'reviewing'
            : check
              ? check.passed
                ? 'awaiting-review'
                : 'check-failed'
              : group.phase === 'awaiting-evaluation'
                ? 'prepared'
                : 'blocked',
      check: check ? { artifactId: check.artifactId, passed: check.passed } : null,
      review: review ? { artifactId: review.artifactId, outcome: review.review?.outcome } : null,
      checkStart: availability(false),
      reviewStart: availability(true),
      localAcceptance,
    });
  }
}
