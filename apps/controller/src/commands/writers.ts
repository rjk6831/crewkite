import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Approval,
  ApprovalBindingSchema,
  ApprovalSchema,
  type Artifact,
  type Attempt,
  type Candidate,
  type Command,
  type CommandResult,
  CommandSchema,
  canonicalJson,
  type FakeWorkerEvent,
  type Grant,
  type ReviewJob,
  ReviewJobSchema,
  type Route,
  type Run,
  SealedHandoffPacketSchema,
  type Task,
  TaskSchema,
} from '@crewkite/contracts';
import { hashCanonical, verifyHandoff } from '@crewkite/contracts/hash';
import { fakeWorkerPath } from '@crewkite/testkit/worker';
import { ToolchainVerification } from '../evidence/toolchain-verify.ts';
import type { GitIdentity } from '../host/publication.ts';
import { committedFiles, materialize } from '../host/source.ts';
import { closedWithin, defaultSchedule, groupAbsent, OwnedWorker } from '../host/worker.ts';
import type { AcpPermissionProposal } from '../providers/google/acp/writer.ts';
import type { LaunchIntent, NativeProcess } from '../store/index.ts';
import type { Controller } from './controller.ts';
import { cleanupReserveMs, type FakeRuntime } from './schemas.ts';

// Writer grants, approvals, launch, events, stop and approval resolution.
export class WriterCommands {
  hasUncertainWriter(this: Controller, taskId: string): boolean {
    return this.store
      .intents()
      .some((intent) => intent.task_id === taskId && intent.state !== 'stopped');
  }

  grant(
    this: Controller,
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

  grantKey(this: Controller, grant: Grant): string {
    return `grant:${hashCanonical({ taskId: grant.taskId, action: grant.action, target: grant.target, expiresAt: grant.expiresAt })}`;
  }

  consumeGrant(this: Controller, run: Run, grant: Grant) {
    const key = this.grantKey(grant);
    if (!this.store.receipt(key))
      this.store.saveReceipt(key, hashCanonical(grant), 'local-owner', {
        outcome: 'applied',
        entity: run,
      });
  }

  requestAction(
    this: Controller,
    task: Task,
    _run: Run,
    attempt: Attempt,
    action: Grant['action'],
    target: string,
    request: unknown,
    acpProposal?: AcpPermissionProposal,
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
        pending.target === target &&
        hashCanonical(pending.acpTarget ?? null) === hashCanonical(acpProposal?.acpTarget ?? null)
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
      ...(acpProposal ? { acpTarget: acpProposal.acpTarget } : {}),
      revision: 0,
      requester: 'Controller',
      consequence: acpProposal?.consequence ?? `Permit one ${action} action for this attempt.`,
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

  updateTask(this: Controller, task: Task, change: Partial<Task>): Task {
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

  launch(this: Controller, intent: LaunchIntent, run: Run, attempt: Attempt) {
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
        if (
          this.evidence.hash(run.source.base, this.candidateFiles(run, intent.scratch_path)) !==
          candidate.hash
        )
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
          await this.finishAttempt(attempt.id, quiescent);
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

  workerEvent(this: Controller, attemptId: string, event: FakeWorkerEvent) {
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

  workerFailure(this: Controller, attemptId: string, reason: string) {
    const runtime = this.workers.get(attemptId);
    if (runtime?.kind !== 'fake' || this.closed) return;
    runtime.failure = reason;
    runtime.worker.child.stdin.end();
  }

  async finishAttempt(this: Controller, attemptId: string, quiescent: boolean) {
    if (this.closed) return;
    const writer = this.store.get<Attempt>('attempt', attemptId);
    if (
      quiescent &&
      writer &&
      writer.state !== 'stopped' &&
      writer.state !== 'failed' &&
      this.workers.get(attemptId)?.kind === 'fake'
    )
      await this.formatAttempt(writer);
    this.settleFinishedAttempt(attemptId, quiescent);
  }

  settleFinishedAttempt(this: Controller, attemptId: string, quiescent: boolean) {
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

  closePendingEffects(
    this: Controller,
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

  stop(
    this: Controller,
    command: Extract<Command, { command: 'StopRun' }>,
    effects: (() => void)[],
    memberStop = false,
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId);
    if (!task || task.runId !== command.payload.runId)
      return { outcome: 'blocked', reason: 'run-not-current' };
    const group = this.store.combinedGroup(command.payload.runId);
    if (group?.phase === 'accepted')
      return { outcome: 'applied', entity: task, revision: task.revision };
    const runForStop = this.store.get<Run>('run', command.payload.runId);
    const stopRoute =
      runForStop?.decision.chosen && this.store.get<Route>('route', runForStop.decision.chosen);
    const usesOpenAi = stopRoute && stopRoute.family === 'openai' && !stopRoute.fake;
    if (usesOpenAi && this.openAiUsageRead) {
      const reader = this.openAiUsageRead;
      effects.push(() => {
        reader.stopped = true;
        reader.handle?.stop();
      });
    }
    if (group && !memberStop) {
      if (group.task_id === task.id) return this.stopCombined(group, effects);
      if (!['stopping', 'stopped', 'unknown', 'accepted'].includes(group.phase))
        this.updateCombined(group, 'blocked', 'stopped');
    }
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
    this.store.db
      .prepare('DELETE FROM receipts WHERE command_key=?')
      .run(`native-handoff-pending:${command.payload.runId}`);
    const restore = this.closePendingEffects(task);
    const active = this.store
      .intents()
      .find((intent) => intent.task_id === task.id && intent.state !== 'stopped');
    if (!active) {
      try {
        this.retainRepositoryRecovery(task);
      } catch {
        // Stop still closes launch authority when retained evidence cannot support evaluation.
      }
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
    if (
      this.pendingLocalLaunches.has(active.attempt_id) &&
      active.state === 'intent' &&
      !this.store.nativeProcesses(active.attempt_id).length
    ) {
      this.pendingLocalLaunches.delete(active.attempt_id);
      const plan = this.localPrepared(active.run_id);
      const binding = {
        ...plan.localModel,
        attemptId: plan.attempt.id,
        generation: plan.attempt.generation,
        profileHash: hashCanonical(plan.profile),
        sourceHash: plan.scopeHash,
        path: plan.target.path,
        baseHash: plan.target.baseHash,
      };
      const stopped = {
        ...plan.attempt,
        state: 'stopped' as const,
        revision: plan.attempt.revision + 1,
      };
      this.store.put('attempt', stopped.id, stopped.revision, stopped);
      this.store.db
        .prepare("UPDATE launch_intents SET state='stopped',finished_at=? WHERE attempt_id=?")
        .run(this.now(), stopped.id);
      this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(stopped.id);
      this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(stopped.id);
      const proof = this.nativeArtifact({
        attemptId: stopped.id,
        bindingHash: hashCanonical(binding),
        terminal: null,
        clientQuiescent: true,
        known: true,
        unspawned: true,
        at: this.now(),
      });
      this.store.saveReceipt(`local-terminal:${stopped.id}`, proof.hash, 'local-owner', {
        outcome: 'applied',
        entity: proof,
      });
      const updated = this.updateTask(task, {
        state: 'stopped',
        waitingReason: null,
        next: 'Local work stopped before its process launched.',
      });
      this.event('attempt.stopped', task.id, updated.revision, stopped);
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    const localRuntime = this.localWriters.get(active.attempt_id);
    if (localRuntime) {
      if (
        ['outcome-unknown', 'interrupted'].includes(active.state) ||
        this.store.get<Attempt>('attempt', active.attempt_id)?.state === 'unknown'
      )
        return { outcome: 'blocked', reason: 'local-generation-unknown' };
      localRuntime.stopped = true;
      const updated = this.updateTask(task, {
        state: 'stopping',
        waitingReason: null,
        next: 'Waiting for the Local runtime terminal and client closure.',
      });
      effects.push(() => localRuntime.handle?.stop());
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
          this.combinedCheckOwners.get(active.attempt_id)?.stop();
          check.stop();
          if (check instanceof ToolchainVerification) return;
          const cancel = (this.options.schedule ?? defaultSchedule)(
            () => this.settleJob(attempt, false),
            1000,
          );
          void check.exited.then(async () => {
            const quiescent = await check.quiescent(this.options.schedule);
            cancel();
            if (this.settleJob(attempt, quiescent)) this.stoppedJob(attempt);
          });
        }
      });
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    }
    if (
      (this.store.receipt(`evaluation-check:${active.attempt_id}`) ||
        this.store.receipt(`combined-check:${active.attempt_id}`) ||
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
      return (
        (!memberStop && command.actor.kind !== 'controller'
          ? this.stopUnknownWriter(active)
          : undefined) ?? {
          outcome: 'blocked',
          reason: 'writer-ownership-unknown',
          next: 'Prove the prior process group is gone before continuing.',
        }
      );
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

  // A writer without terminal proof keeps an unknown outcome, and an ACP or Local writer in that
  // state holds the lease and closes its provider gate. Process absence is the one fact the
  // controller can prove afterwards, and only ESRCH counts. A phase still at launch intent may
  // hide a spawned process with no recorded group, so it proves nothing. Combined runs keep
  // their own ledger and stay out.
  shutdownProof(this: Controller, intent: LaunchIntent): { groups: number[] } | undefined {
    if (this.store.combinedGroup(intent.run_id)) return undefined;
    const phases = this.store.nativeProcesses(intent.attempt_id);
    const groups = [
      ...new Set([intent.process_group, ...phases.map((phase) => phase.process_group)]),
    ].filter((group) => group !== null);
    if (
      !phases.length ||
      phases.some((phase) => phase.state === 'intent') ||
      !groups.every((group) => groupAbsent(group))
    )
      return undefined;
    return { groups };
  }

  // The longest an attempt can legitimately run: the plan's task limit for native writers, the
  // profile limit for Local and the reserved minutes for everything else.
  attemptMaximumMs(this: Controller, intent: LaunchIntent): number | undefined {
    try {
      const run = this.store.get<Run>('run', intent.run_id) as Run;
      const route = this.store.get<Route>('route', intent.route_id);
      if (route?.family === 'local' && !route.fake)
        return this.localPrepared(run.id).profile.maximumTaskMs;
      if (this.store.receipt(this.currentNativePlanKey(run.id)))
        return this.nativeCurrentPlan(run).appointment.maximumTaskMs;
      const minutes = this.store.db
        .prepare('SELECT MAX(minutes) AS minutes FROM reservations WHERE attempt_id=?')
        .get(intent.attempt_id)?.minutes;
      return typeof minutes === 'number' ? minutes * 60000 : undefined;
    } catch {
      return undefined;
    }
  }

  // Minutes are charged up to the recorded shutdown proof, the quiescent time of the last phase.
  // Without that record the charge runs to now, capped at the attempt's own limit plus a cleanup
  // reserve so a long outage cannot bill time the process could not have used. It never falls
  // below the latest time the journal shows the process alive.
  shutdownCharge(this: Controller, intent: LaunchIntent): string {
    const phases: NativeProcess[] = this.store.nativeProcesses(intent.attempt_id);
    const last = phases.at(-1);
    if (last?.state === 'quiescent' && last.quiescent_at) return last.quiescent_at;
    const now = this.now();
    const limit = this.attemptMaximumMs(intent);
    const admitted = Date.parse(intent.admitted_at ?? '');
    const cap =
      limit !== undefined && Number.isFinite(admitted)
        ? admitted + limit + cleanupReserveMs
        : Number.POSITIVE_INFINITY;
    const alive = Math.max(
      ...phases
        .flatMap((phase) => [phase.intent_at, phase.quiescent_at])
        .map((at) => Date.parse(at ?? ''))
        .filter(Number.isFinite),
    );
    const end = Math.max(alive, Math.min(Date.parse(now), cap));
    return end === Date.parse(now) ? now : new Date(end).toISOString();
  }

  // Settles one unknown writer after its shutdown is proven. The attempt keeps its unknown
  // outcome and every submission, completion, terminal and phase record stays. The intent stops
  // at the charged time and the lease and reservations release. Nothing is captured, no success
  // is inferred, and the stopped intent keeps this run from starting again.
  settleUnknownWriter(
    this: Controller,
    intent: LaunchIntent,
    proof: { groups: number[] },
    reason: string,
    lead = '',
  ): Task | undefined {
    const attempt = this.store.get<Attempt>('attempt', intent.attempt_id);
    const task = this.store.get<Task>('task', intent.task_id);
    if (!attempt || !task || attempt.state === 'stopped') return undefined;
    const at = this.shutdownCharge(intent);
    const retained = (key: string) =>
      (this.store.receipt(key)?.result.entity as Artifact | undefined)?.hash ?? null;
    const record = this.nativeArtifact({
      attemptId: attempt.id,
      outcome: 'unknown',
      submissionHash: retained(`native-submission:${attempt.id}`),
      completionHash: retained(`native-completion:${attempt.id}`),
      terminalHash: retained(`local-terminal:${attempt.id}`),
      groups: proof.groups,
      absentAt: this.now(),
      chargedThrough: at,
    });
    this.store.saveReceipt(`native-unknown-settled:${attempt.id}`, record.hash, 'local-owner', {
      outcome: 'applied',
      entity: record,
    });
    if (attempt.state !== 'unknown')
      this.store.put('attempt', attempt.id, attempt.revision + 1, {
        ...attempt,
        state: 'unknown',
        revision: attempt.revision + 1,
      });
    this.store.db
      .prepare("UPDATE launch_intents SET state='stopped',finished_at=? WHERE attempt_id=?")
      .run(at, attempt.id);
    this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
    this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
    this.closePendingEffects(task);
    const updated = this.updateTask(task, {
      state: 'interrupted',
      waitingReason: null,
      next: `${lead}Every recorded process group exited. The turn outcome stays unknown, retained work is unverified and nothing was captured. Create a new task to continue.`,
    });
    this.event('run.interrupted', task.id, updated.revision, { runId: intent.run_id, reason });
    return updated;
  }

  // An explicit Stop reaches an unknown writer only in a controller that holds no runtime for
  // it, and only the same absence proof can close it.
  stopUnknownWriter(this: Controller, intent: LaunchIntent): CommandResult | undefined {
    const attempt = this.store.get<Attempt>('attempt', intent.attempt_id);
    const route = this.store.get<Route>('route', intent.route_id);
    if (
      attempt?.state !== 'unknown' ||
      (this.store.nativeProfileId(attempt.id) !== 'google-acp-v1' &&
        !(route?.family === 'local' && !route.fake))
    )
      return undefined;
    const proof = this.shutdownProof(intent);
    if (!proof) return undefined;
    const updated = this.settleUnknownWriter(
      intent,
      proof,
      'An explicit Stop closed a turn with an unknown outcome after its process groups exited.',
    );
    return updated && { outcome: 'applied', entity: updated, revision: updated.revision };
  }

  resolve(
    this: Controller,
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
      ...(approval.acpTarget ? { acpTarget: approval.acpTarget } : {}),
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
      proposal?: AcpPermissionProposal;
    };
    if (request.kind === 'acp') {
      if (
        hashCanonical(request) !== pending.effect_hash ||
        !request.proposal ||
        !approval.acpTarget ||
        approval.action !== request.proposal.action ||
        approval.target !== request.proposal.target ||
        approval.consequence !== request.proposal.consequence
      )
        return { outcome: 'denied', reason: 'pending-effect-changed' };
      const runtime = this.workers.get(approval.attemptId);
      if (
        runtime?.kind !== 'native' ||
        !runtime.acpHandle ||
        !('acp' in runtime.binding.appointment) ||
        this.store.nativeProfileId(approval.attemptId) !== 'google-acp-v1' ||
        approval.generation !== runtime.binding.attempt.generation ||
        hashCanonical(approval.acpTarget) !== hashCanonical(request.proposal.acpTarget)
      )
        return { outcome: 'blocked', reason: 'acp-permission-not-current' };
      if (command.payload.decision === 'approved') {
        try {
          this.validateAcpPermission(runtime, request.proposal);
        } catch {
          return { outcome: 'blocked', reason: 'acp-action-changed' };
        }
      }
      const resolved = ApprovalSchema.parse({
        ...approval,
        status: command.payload.decision,
        revision: approval.revision + 1,
      });
      this.store.put('approval', approval.approvalId, resolved.revision, resolved);
      this.store.db
        .prepare('UPDATE pending_effects SET state=? WHERE approval_id=?')
        .run(command.payload.decision === 'approved' ? 'applied' : 'denied', approval.approvalId);
      const next = this.updateTask(task, {
        state: command.payload.decision === 'approved' ? 'running' : 'stopping',
        waitingReason: null,
        next:
          command.payload.decision === 'approved'
            ? 'One exact native edit was approved.'
            : 'Stopping after the denied native edit.',
      });
      this.event('approval.resolved', task.id, next.revision, resolved);
      effects.push(() => {
        try {
          if (command.payload.decision === 'approved')
            this.validateAcpPermission(runtime, request.proposal as AcpPermissionProposal);
          runtime.acpHandle?.replyPermission(command.payload.binding, command.payload.decision);
        } catch {
          runtime.stopped = true;
          runtime.acpHandle?.stop();
        }
      });
      return { outcome: 'applied', entity: next, revision: next.revision };
    }
    if (
      task.runId &&
      this.store.receipt(`native-run:${task.runId}`) &&
      request.kind !== 'export' &&
      request.kind !== 'accept' &&
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
        !this.candidateCurrent(run, candidate)
      )
        return {
          outcome: 'blocked',
          reason: 'candidate-binding-changed',
          next: 'Refresh the candidate and request a new exact action.',
        };
    }
    if (
      request.kind === 'accept' &&
      command.payload.decision === 'approved' &&
      task.runId &&
      this.store.receipt(`native-run:${task.runId}`)
    ) {
      const run = this.store.get<Run>('run', task.runId) as Run;
      let native: ReturnType<Controller['nativePublicationEvidence']>;
      try {
        native = this.nativePublicationEvidence(run, this.latestCandidate(run.id) as Candidate);
      } catch {
        return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
      }
      if (
        request.command?.command !== 'AcceptCandidate' ||
        request.command.payload.taskId !== task.id ||
        request.command.payload.candidateId !== request.candidateId ||
        approval.action !== 'accept-candidate' ||
        approval.target !== request.command.payload.destinationRef
      )
        return { outcome: 'blocked', reason: 'pending-lineage-changed' };
      try {
        this.nativePublicationCurrent(
          run,
          this.store.get<Candidate>('candidate', request.command.payload.candidateId) as Candidate,
          native,
        );
      } catch {
        return { outcome: 'blocked', reason: 'native-evidence-not-current' };
      }
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
}
