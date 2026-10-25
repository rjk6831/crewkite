import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Approval,
  type Artifact,
  ArtifactSchema,
  type Attempt,
  AttemptSchema,
  type Candidate,
  CandidateSchema,
  type CheckResult,
  CheckResultSchema,
  type CombinedCheckContextSchema,
  canonicalJson,
  type FakeWorkerEvent,
  formatReviewTarget,
  type Policy,
  type ReviewJob,
  ReviewJobSchema,
  type ReviewResult,
  type Route,
  type Run,
  type Task,
  TimestampSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { fakeReviewWorkerPath } from '@crewkite/testkit/worker';
import type { z } from 'zod';
import type { CheckDefinition, CheckPlan } from '../evidence/index.ts';
import { type CheckOwner, parseCheckOwner } from '../host/check-ownership.ts';
import { applyFormatting, FormattingSchema, noFormatting, planFormatting } from '../host/format.ts';
import {
  committedFiles,
  type FileContent,
  materialize,
  readCandidateFiles,
  readFiles,
} from '../host/source.ts';
import {
  closedBefore,
  closedWithin,
  defaultSchedule,
  OwnedCommand,
  OwnedWorker,
} from '../host/worker.ts';
import type { CombinedDispatch, CombinedGroup, LaunchIntent } from '../store/index.ts';
import type { Controller } from './controller.ts';
import { type CandidateEvaluationSchema, runtimeRoot } from './schemas.ts';

// Candidate sealing, checks and reviews.
export class CandidateCommands {
  candidateCurrent(this: Controller, run: Run, candidate: Candidate): boolean {
    const group = this.store.combinedGroup(run.id);
    if (group?.run_id === run.id) {
      try {
        this.combinedOrigin(group, candidate);
        return true;
      } catch {
        return false;
      }
    }
    return (
      this.evidence.hash(run.source.base, this.candidateFiles(run, this.writerScratch(run))) ===
      candidate.hash
    );
  }

  latestCandidate(this: Controller, runId: string): Candidate | undefined {
    const group = this.store.combinedGroup(runId);
    if (group?.run_id === runId)
      return group.final_candidate_id
        ? this.store.get<Candidate>('candidate', group.final_candidate_id)
        : undefined;
    for (const intent of this.store
      .intents()
      .filter((value) => value.run_id === runId)
      .reverse()) {
      const candidate = this.store.receipt(`candidate:${intent.attempt_id}`)?.result.entity;
      if (candidate && 'artifactId' in candidate) return candidate as Candidate;
    }
  }

  saveArtifacts(this: Controller, artifacts: Artifact[]) {
    for (const artifact of artifacts) this.store.put('artifact', artifact.id, 0, artifact);
  }

  // Local and native file writers edit one bounded target in a full copy of the source.
  singleFileWriter(this: Controller, run: Run): boolean {
    return (
      !!this.store.receipt(`local-prepared:${run.id}`) ||
      (!!this.store.receipt(`native-run:${run.id}`) &&
        !('repository' in this.nativeCurrentPlan(run).appointment))
    );
  }

  candidateFiles(this: Controller, run: Run, directory: string): FileContent[] {
    if (this.singleFileWriter(run)) return readFiles(directory);
    return readCandidateFiles(
      directory,
      this.projectPath(run.source.projectId) as string,
      run.source.base,
    );
  }

  // Formatting runs once per attempt, after the writer is quiescent and before the attempt settles
  // and its candidate seals, so the hash covers the formatted bytes and observers never see a
  // stopped task without its candidate. The receipt records only writes observed in scratch. The
  // child runs without holding the event loop, and concurrent callers for one attempt share one run.
  formatAttempt(this: Controller, attempt: Attempt): Promise<void> {
    const running = this.formatting.get(attempt.id);
    if (running) return running.promise;
    const abort = new AbortController();
    const promise = this.formatScratch(attempt, abort.signal)
      .catch(() => {})
      .finally(() => this.formatting.delete(attempt.id));
    this.formatting.set(attempt.id, { promise, abort });
    return promise;
  }

  async formatScratch(this: Controller, attempt: Attempt, signal: AbortSignal) {
    const key = `formatting:${attempt.id}`;
    // A sealed attempt keeps its bytes. Re-sealing retained scratch never reformats them.
    const settled = () =>
      this.closed || this.store.receipt(key) || this.store.receipt(`candidate:${attempt.id}`);
    const run = this.store.get<Run>('run', attempt.runId) as Run;
    const intent = this.store.intents().find((value) => value.attempt_id === attempt.id);
    if (!intent || settled()) return;
    let files: FileContent[] = [];
    let plan: Awaited<ReturnType<typeof planFormatting>>;
    try {
      files = this.candidateFiles(run, intent.scratch_path);
      plan = this.store.combinedGroup(run.id)
        ? noFormatting('skipped', 'Combined runs check with a recipe that has no formatter.')
        : await planFormatting({
            runtime: runtimeRoot,
            project: this.projectPath(run.source.projectId) as string,
            base: run.source.base,
            files,
            work: join(this.home, 'format'),
            maximumBytes: this.singleFileWriter(run) ? 65_536 : 1024 * 1024,
            signal,
          });
    } catch {
      plan = noFormatting('failed', 'Formatting could not start.');
    }
    if (settled() || signal.aborted) return;
    if (plan.outputs.length && !this.store.receipt(`formatting-plan:${attempt.id}`)) {
      this.store.transaction(() => {
        const artifact = this.nativeArtifact(plan.receipt);
        this.store.saveReceipt(`formatting-plan:${attempt.id}`, artifact.hash, 'local-owner', {
          outcome: 'applied',
          entity: artifact,
        });
      });
    }
    const applied = plan.outputs.length
      ? applyFormatting(intent.scratch_path, files, plan.outputs)
      : [];
    const appliedByPath = new Map(applied.map((file) => [file.path, file]));
    const expectedByPath = new Map(plan.outputs.map((file) => [file.path, file]));
    const allApplied = applied.every((file) => expectedByPath.get(file.path)?.hash === file.hash);
    const receipt = plan.outputs.length
      ? {
          ...plan.receipt,
          status: allApplied ? plan.receipt.status : ('failed' as const),
          reason: allApplied
            ? plan.receipt.reason
            : 'The scratch file changed before formatting was applied.',
          files: plan.receipt.files.filter(
            (file) => appliedByPath.get(file.path)?.hash === file.after,
          ),
        }
      : plan.receipt;
    this.store.transaction(() => {
      const artifact = this.nativeArtifact(receipt);
      this.store.saveReceipt(key, artifact.hash, 'local-owner', {
        outcome: 'applied',
        entity: artifact,
      });
    });
  }

  // Formatting rewrites the writer's bytes once. Its receipt links the writer's hash to the sealed one.
  writerBytes(
    this: Controller,
    attemptId: string,
    path: string,
    writerHash: string,
    sealedHash: string,
  ) {
    if (sealedHash === writerHash) return true;
    for (const key of [`formatting:${attemptId}`, `formatting-plan:${attemptId}`]) {
      try {
        if (
          FormattingSchema.parse(this.nativeRecord(key, 65536).value).files.some(
            (file) => file.path === path && file.before === writerHash && file.after === sealedHash,
          )
        )
          return true;
      } catch {}
    }
    return false;
  }

  sealCandidate(this: Controller, attempt: Attempt, capturedFiles?: FileContent[]): Candidate {
    const run = this.store.get<Run>('run', attempt.runId) as Run;
    if (this.hasUncertainWriter(run.taskId)) throw new Error('Writer ownership is not quiescent.');
    const intent = this.store
      .intents()
      .find((value) => value.attempt_id === attempt.id) as LaunchIntent;
    const files = capturedFiles ?? this.candidateFiles(run, intent.scratch_path);
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
      const group = this.store.combinedGroup(run.id);
      if (group && group.run_id !== run.id) {
        let passed = false;
        try {
          passed =
            this.evaluationOrigin(task.id, captured.candidate.id).writer.id === attempt.id &&
            (group.phase === 'paused'
              ? this.combinedCurrent(group, true).group.paused_phase
              : this.combinedCurrent(group).group.phase) === 'writers';
        } catch {}
        this.store.db
          .prepare(
            "UPDATE combined_dispatches SET state=?,candidate_id=? WHERE parent_run_id=? AND attempt_id=? AND state='running'",
          )
          .run(passed ? 'passed' : 'failed', captured.candidate.id, group.run_id, attempt.id);
        const current = this.store.combinedGroup(group.run_id) as CombinedGroup;
        const stoppedSibling = this.store
          .combinedDispatches(group.run_id)
          .some(
            (slot) =>
              slot.phase.startsWith('writer-') &&
              slot.attempt_id !== attempt.id &&
              slot.state === 'stopped',
          );
        if (
          (!passed || stoppedSibling) &&
          !['stopping', 'stopped', 'unknown', 'paused'].includes(current.phase)
        )
          this.updateCombined(group, 'blocked', 'writers-incomplete');
        else this.updateCombined(group, current.phase, current.blocker);
      }
    });
    this.armQuotaRetries();
    return captured.candidate;
  }

  checkMatches(
    this: Controller,
    check: CheckResult,
    candidate: Candidate,
    plan: Pick<CheckDefinition, 'definitionHash' | 'evaluator'> & {
      recipeId?: CheckDefinition['recipeId'];
      combined?: z.infer<typeof CombinedCheckContextSchema>;
    },
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
        verification?: { artifact: Artifact; owner: CheckOwner };
        combined?: unknown;
      };
      if (
        metadata.candidateId !== candidate.id ||
        metadata.candidateHash !== candidate.hash ||
        metadata.definitionHash !== plan.definitionHash ||
        metadata.evaluator !== plan.evaluator ||
        hashCanonical(metadata.combined ?? null) !== hashCanonical(plan.combined ?? null) ||
        !metadata.passed ||
        !metadata.complete ||
        !metadata.unchanged ||
        !Number.isSafeInteger(metadata.tests) ||
        metadata.tests <= 0
      )
        return false;
      if (plan.recipeId === 'crewkite-verify-v1') {
        const owner = parseCheckOwner(metadata.verification?.owner);
        const launch = this.verificationLaunch(owner.attemptId);
        if (
          launch.candidateId !== candidate.id ||
          launch.definitionHash !== plan.definitionHash ||
          hashCanonical(launch.owner) !== hashCanonical(owner) ||
          !this.evidence.verificationMatches({
            candidate,
            definition: plan as CheckDefinition & { recipeId: 'crewkite-verify-v1' },
            metadata,
            owner,
          })
        )
          return false;
      }
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

  checks(this: Controller, candidate: Candidate): CheckResult[] {
    return this.store.db
      .prepare(
        "SELECT body FROM evidence WHERE candidate_id=? AND candidate_hash=? AND kind='check'",
      )
      .all(candidate.id, candidate.hash)
      .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)));
  }

  jobAttempt(this: Controller, run: Run, routeId: string): Attempt {
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

  admitJob(
    this: Controller,
    run: Run,
    attempt: Attempt,
    directory: string,
    maximumMinutes?: number,
    combinedPhase?: CombinedDispatch['phase'],
  ) {
    const localRoute = this.store.get<Route>('route', attempt.routeId);
    if (localRoute?.family === 'local' && !localRoute.fake) {
      const blocker = this.store.localStartBlocker();
      if (blocker) throw Error(blocker);
    }
    const googleBlocker = this.store.googleStartBlocker(attempt.routeId);
    if (googleBlocker) throw new Error(googleBlocker);
    const openAiBlocker = this.openAiUsageBlocker(attempt.routeId);
    if (openAiBlocker) throw Error(openAiBlocker);
    const remaining = this.remaining(run);
    const group = this.store.combinedGroup(run.id);
    if (group) {
      this.combinedCurrent(group);
      const slot = this.store
        .combinedDispatches(group.run_id)
        .find((slot) => slot.phase === combinedPhase);
      if (
        slot?.state !== 'reserved' ||
        maximumMinutes !== slot.maximum_minutes ||
        remaining.minutes < slot.maximum_minutes
      )
        throw Error('The combined job lacks its reserved allowance.');
    }
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
    if (group && combinedPhase)
      this.store.admitCombinedDispatch(group.run_id, combinedPhase, attempt.id);
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

  acknowledgeJob(this: Controller, attempt: Attempt, pid: number) {
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

  stoppedJob(this: Controller, attempt: Attempt) {
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

  settleJob(
    this: Controller,
    attempt: Attempt,
    quiescent: boolean,
    closing = false,
    afterSettled?: () => void,
    unknownNext = 'Execution ownership is unknown. Checks and publication are blocked.',
  ): boolean {
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
      const group = this.store.combinedGroup(run.id);
      if (group) {
        const stopping = ['stopping', 'stopped'].includes(group.phase);
        if (!quiescent || stopping)
          this.store.db
            .prepare(
              "UPDATE combined_dispatches SET state=? WHERE parent_run_id=? AND attempt_id=? AND state IN ('running','unknown')",
            )
            .run(quiescent ? 'stopped' : 'unknown', group.run_id, attempt.id);
        if (!quiescent) this.updateCombined(group, 'unknown', 'ownership-unknown');
      }
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
        afterSettled?.();
        if (group) this.refreshCombinedStop(group);
      } else {
        this.event('ownership.unknown', task.id, task.revision, updated);
        this.updateTask(task, {
          state: 'unknown',
          waitingReason: null,
          next: unknownNext,
        });
      }
    });
    return quiescent;
  }

  checkCandidate(
    this: Controller,
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

  jobDeadline(this: Controller, attemptId: string, minutes: number): number {
    const intent = this.store.intents().find((value) => value.attempt_id === attemptId);
    const admitted = TimestampSchema.safeParse(intent?.admitted_at);
    if (!admitted.success) return 0;
    const elapsed = Date.parse(this.now()) - Date.parse(admitted.data);
    if (elapsed < 0 || !Number.isFinite(elapsed)) return 0;
    return Math.max(0, minutes * 60000 - elapsed);
  }

  launchCheck(
    this: Controller,
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
    const boundary = Promise.withResolvers<void>();
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
    const drained = closedBefore(job.closed, boundary.promise);
    const cancelDeadline = schedule(() => {
      timedOut = true;
      job.stop();
      schedule(() => {
        boundary.resolve();
        this.settleJob(attempt, false);
      }, 1000);
    }, deadline());
    const cancel = () => {
      cancelDeadline();
      boundary.resolve();
    };
    this.jobCancels.set(attempt.id, cancel);
    void job.exited
      .then(async (exit) => {
        const quiescent = (await drained) && (await job.quiescent(this.options.schedule));
        cancel();
        if (!this.settleJob(attempt, quiescent)) return;
        if (this.cancelledJobs.has(attempt.id)) {
          this.stoppedJob(attempt);
          return;
        }
        const result = this.evidence.recordCheck({
          candidate,
          plan,
          sourceFiles:
            plan.recipeId === 'project-python-unittest-v1'
              ? committedFiles(this.projectPath(run.source.projectId) as string, run.source.base)
              : undefined,
          passed:
            exit.code === 0 &&
            !job.failed &&
            !timedOut &&
            deadline() > 0 &&
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

  attestedReviewWriter(this: Controller, run: Run, candidate: Candidate, writer: Attempt): boolean {
    const current = this.store
      .intents()
      .filter(
        (intent) => intent.run_id === run.id && intent.scratch_path === this.writerScratch(run),
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

  reviewIdentity(this: Controller, run: Run, job: ReviewJob) {
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
        ...('writerAttemptId' in job && job.writerAttemptId
          ? { writerAttemptId: job.writerAttemptId, writerRouteId: job.writerRouteId }
          : {}),
      }),
    };
  }

  reviewMatches(
    this: Controller,
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
    if ('writerAttemptId' in job && job.writerAttemptId) {
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

  dispatchReviews(
    this: Controller,
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
    const remaining = this.remaining(run);
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
      ('writerAttemptId' in job &&
        job.writerAttemptId !== undefined &&
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

  launchReview(
    this: Controller,
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

  afterChecks(this: Controller, writer: Attempt, candidate: Candidate, handoff: boolean) {
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
}
