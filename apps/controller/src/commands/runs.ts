import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type Attempt,
  AttemptSchema,
  type Candidate,
  type Command,
  type CommandResult,
  CommandSchema,
  canonicalJson,
  NativeRepositoryScopeSchema,
  type NativeRunSchema,
  type Observation,
  PolicySchema,
  type Project,
  type Route,
  type Run,
  RunSchema,
  requiredReviewMethodIds,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { z } from 'zod';
import { committedFiles, inspectSource } from '../host/source.ts';
import { defaultSchedule } from '../host/worker.ts';
import type { CapturedContext } from '../providers/google/native-extension/connector.ts';
import { chooseRoute } from '../routing/index.ts';
import type { LaunchIntent } from '../store/index.ts';
import { chargedMinutes } from './budgets.ts';
import type { Controller } from './controller.ts';
import {
  evaluationFloorMinutes,
  freezeNative,
  type NativeBinding,
  NativePreparationSchema,
  NativeQuotaCompletionSchema,
  nativeProviderRestriction,
} from './schemas.ts';

// Run routing, preparation, admission and quota retries.
export class RunCommands {
  routing(
    this: Controller,
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
            ? this.remaining(run as Run).minutes
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

  draftEditGate(this: Controller, task: Task): CommandResult | undefined {
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
    // A retired planning run never wrote to the project, so its turns do not lock the draft.
    if (
      run &&
      this.store.runPurpose(run.id) !== 'conversation' &&
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

  prepare(this: Controller, command: Extract<Command, { command: 'PrepareRun' }>): CommandResult {
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
    this.store.putRunPurpose(run, 'execution', task.runId);
    const updated = this.updateTask(task, {
      runId: run.id,
      state: 'draft',
      waitingReason: null,
      next: decision.chosen ? 'Review the launch card and start.' : 'No route can admit this work.',
    });
    this.event('run.prepared', task.id, updated.revision, run);
    return { outcome: 'applied', entity: run, revision: updated.revision };
  }

  start(
    this: Controller,
    command: Extract<Command, { command: 'StartRun' | 'ResumeRun' }>,
    effects: (() => void)[],
    approved?: string,
    planned?: Attempt,
    transfer = false,
    native?: NativeBinding,
    acpContext?: CapturedContext,
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId);
    const run = this.store.get<Run>('run', command.payload.runId);
    const combined = run && this.store.combinedGroup(run.id);
    let quotaRetry = false;
    let combinedQuota: ReturnType<Controller['quotaRetryEvidence']> | undefined;
    if (
      combined &&
      run &&
      command.command === 'ResumeRun' &&
      this.store.receipt(`native-run:${run.id}`)
    ) {
      try {
        combinedQuota = this.quotaRetryEvidence(run, true);
      } catch {}
    }
    if (combined?.task_id === command.payload.taskId && command.command === 'ResumeRun')
      return this.resumeCombined(command, combined);
    if (combined && !combinedQuota) this.combinedCurrent(combined);
    if (combined && combined.task_id === command.payload.taskId)
      return this.startCombinedBaseline(command, combined, effects);
    if (
      combined &&
      !combinedQuota &&
      !this.combinedPreview(combined).members.find((member) => member.runId === run?.id)?.start
        .available
    )
      return { outcome: 'blocked', reason: 'combined-child-not-admissible' };
    if (run && this.store.receipt(`local-prepared:${run.id}`))
      return command.command === 'StartRun'
        ? this.startLocal(command, effects)
        : { outcome: 'blocked', reason: 'native-pilot-retain-only' };
    if (run && this.store.runPurpose(run.id) === 'conversation')
      return {
        outcome: 'blocked',
        reason: 'planning-run-retired',
        next: 'Prepare an execution run for this task.',
      };
    if (this.closed) return { outcome: 'blocked', reason: 'controller-closing' };
    if (
      !native &&
      run &&
      command.command === 'ResumeRun' &&
      this.store.receipt(`native-run:${run.id}`)
    ) {
      try {
        native = this.quotaRetryBinding(run);
        planned = native.attempt;
        quotaRetry = true;
      } catch {
        return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
      }
    }
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
      } catch (error) {
        if (error instanceof Error && error.message === 'provider-policy-restricted')
          return nativeProviderRestriction;
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
    if (native && 'acp' in native.appointment && !acpContext)
      return { outcome: 'blocked', reason: 'acp-context-unavailable' };
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
    if (
      command.command === 'StartRun' &&
      !native?.handoff &&
      decision.chosen !== run.decision.chosen
    )
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
    const allocation = native?.handoff ? undefined : this.grant(run, 'write-scratch', project.name);
    const allocated = this.store.receipt(`allocation:${run.id}`);
    if (!allocation && !approved && !allocated && !native?.handoff) {
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
    const spent = this.chargeableIntents().filter((intent) => intent.run_id === run.id).length;
    const reviewReserve = (run.policy.policy.methods ?? []).reduce(
      (sum, method) => sum + method.cycles,
      0,
    );
    const previousCandidate = this.latestCandidate(run.id);
    const checkReserve =
      previousCandidate && this.checks(previousCandidate).some((check) => check.passed) ? 0 : 1;
    if (!combined && spent + reviewReserve + checkReserve >= run.policy.policy.limits.attempts)
      return {
        outcome: 'blocked',
        reason: 'attempt-budget-exhausted',
        next: 'Prepare a new bounded run with enough review headroom.',
      };
    const remaining = this.remaining(run);
    if (remaining.attempts < (combined ? 1 : reviewReserve + checkReserve + 1))
      return {
        outcome: 'blocked',
        reason: 'review-budget-insufficient',
        next: 'The remaining task allowance must cover the writer, checks and selected reviews.',
      };
    if (remaining.attempts === 0 || remaining.minutes === 0 || remaining.concurrency === 0)
      return { outcome: 'blocked', reason: 'run-budget-exhausted' };
    // A spent task allowance can leave less than the limit frozen at preparation. A repository
    // writer longer than five minutes also needs the evaluation floor behind that limit. A
    // five-minute writer starts with its own five.
    if (native) {
      const limit = native.appointment.maximumTaskMs;
      const floored = 'repository' in native.appointment && limit > 5 * 60_000;
      if (remaining.minutes * 60_000 < limit + (floored ? evaluationFloorMinutes * 60_000 : 0))
        return {
          outcome: 'blocked',
          reason: 'run-budget-exhausted',
          ...(floored
            ? {
                next: 'The task has fewer minutes than the writer limit plus its check. Prepare a run that fits.',
              }
            : {}),
        };
    }
    const lease = this.store.db
      .prepare('SELECT attempt_id FROM writer_leases WHERE task_id=?')
      .get(task.id);
    if (lease) return { outcome: 'blocked', reason: 'writer-lease-held' };
    const googleBlocker = this.store.googleStartBlocker(attempt.routeId);
    if (googleBlocker) return { outcome: 'blocked', reason: googleBlocker };
    const openAiBlocker = this.openAiUsageBlocker(attempt.routeId);
    if (openAiBlocker) return { outcome: 'blocked', reason: openAiBlocker };
    const nativeTools =
      native && 'repository' in native.appointment
        ? this.grant(run, 'run-native-tools', project.name)
        : undefined;
    if (native && 'repository' in native.appointment && !nativeTools)
      return { outcome: 'blocked', reason: 'native-tools-grant-unavailable' };
    if (native && 'acp' in native.appointment) {
      const preparing = this.acpStart;
      if (
        !preparing ||
        preparing.key !== command.key ||
        preparing.taskId !== task.id ||
        preparing.runId !== run.id ||
        preparing.aborted
      )
        return { outcome: 'blocked', reason: 'acp-start-revoked' };
      if (
        preparing.expired ||
        performance.now() >= preparing.deadline ||
        Date.parse(this.now()) >= preparing.wallDeadline
      )
        return { outcome: 'blocked', reason: 'acp-start-deadline' };
      const reader = this.store.googleUsageReader();
      if (reader.authority_revision !== preparing.authorityRevision)
        return { outcome: 'blocked', reason: 'usage-read-revoked' };
    }
    this.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run(`paused:${run.id}`);
    this.store.put('attempt', attempt.id, attempt.revision, attempt);
    if (native?.handoff) {
      this.nativeManualAuthority(native, false);
      const authority = this.nativeRecord(
        `native-handoff-prepared:${native.handoff.preparationId}`,
      );
      this.store.saveReceipt(
        `native-handoff-consumed:${attempt.id}`,
        authority.artifact.hash,
        'local-owner',
        { outcome: 'applied', entity: authority.artifact },
      );
    }
    if (allocation && !allocated) this.consumeGrant(run, allocation);
    if (nativeTools) this.consumeGrant(run, nativeTools);
    if (!allocated)
      this.store.saveReceipt(
        `allocation:${run.id}`,
        hashCanonical({ runId: run.id, grant: allocation ?? null, approvalId: approved ?? null }),
        'local-owner',
        { outcome: 'applied', entity: run },
      );
    const scratchPath = native?.handoff
      ? join(this.home, 'scratch-handoffs', run.id, attempt.id)
      : join(this.home, 'scratch', run.id);
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
    if (combined) {
      const member = this.store
        .combinedMembers(combined.run_id)
        .find((member) => member.run_id === run.id);
      if (!member) throw Error('The combined member disappeared.');
      const phase = member.ordinal === 0 ? 'writer-0' : 'writer-1';
      if (combinedQuota)
        this.store.retryCombinedDispatch(
          combined.run_id,
          phase,
          attempt.id,
          combinedQuota.attempt.id,
        );
      else this.store.admitCombinedDispatch(combined.run_id, phase, attempt.id);
      if (combinedQuota) this.updateCombined(combined, 'writers');
    }
    const windows = this.store
      .list<Observation>('window')
      .filter((value) => value.routeId === attempt.routeId && value.kind !== 'local');
    if (native && 'acp' in native.appointment)
      this.store.bindNativeProfile(attempt.id, 'google-acp-v1');
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
          combined
            ? (this.store
                .combinedDispatches(combined.run_id)
                .find((slot) => slot.attempt_id === attempt.id)?.maximum_minutes ?? 0)
            : remaining.minutes,
        );
    const admitted = { ...run, decision, revision: run.revision + 1 };
    this.store.put('run', run.id, admitted.revision, admitted);
    if (native && (native.handoff || quotaRetry)) {
      this.store.saveReceipt(
        `native-attempt-plan:${attempt.id}`,
        hashCanonical(native.appointment),
        'local-owner',
        { outcome: 'applied', entity: native.planArtifact },
      );
      this.store.db
        .prepare('DELETE FROM receipts WHERE command_key=?')
        .run(`native-current:${run.id}`);
      this.store.saveReceipt(
        `native-current:${run.id}`,
        hashCanonical(native.appointment),
        'local-owner',
        { outcome: 'applied', entity: native.planArtifact },
      );
    }
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
      if (native)
        this.launchNative(
          intent,
          freezeNative({
            ...native,
            run: admitted,
            attempt,
            ...(acpContext ? { context: acpContext } : {}),
          }),
        );
      else this.launch(intent, admitted, attempt);
    });
    return { outcome: 'applied', entity: updated, revision: updated.revision };
  }

  quotaRetryEvidence(this: Controller, run: Run, resetElapsed: boolean) {
    const task = this.store.get<Task>('task', run.taskId);
    const origin = NativePreparationSchema.parse(this.nativeRecord(`native-run:${run.id}`).value);
    const intents = this.store.intents().filter((value) => value.run_id === run.id);
    const generations = new Map<number, LaunchIntent>();
    for (const value of intents) {
      if (generations.has(value.generation)) throw Error('Quota retry generation is ambiguous.');
      generations.set(value.generation, value);
    }
    const intent = intents.reduce<LaunchIntent | undefined>(
      (latest, value) => (!latest || value.generation > latest.generation ? value : latest),
      undefined,
    );
    if (!task || !intent) throw Error('Quota retry is unavailable.');
    const attempt = this.store.get<Attempt>('attempt', intent.attempt_id);
    const completion = NativeQuotaCompletionSchema.parse(
      this.nativeRecord(`native-completion:${intent.attempt_id}`, 4096).value,
    );
    const reset = Date.parse(completion.diagnostic.providerFailure.resetsAt);
    const phases = this.store.nativeProcesses(intent.attempt_id);
    const group = this.store.combinedGroup(run.id);
    const member = group
      ? this.store.combinedMembers(group.run_id).find((value) => value.run_id === run.id)
      : undefined;
    const slot =
      group && member
        ? this.store
            .combinedDispatches(group.run_id)
            .find((value) => value.phase === `writer-${member.ordinal}`)
        : undefined;
    const sibling = group
      ? this.store
          .combinedDispatches(group.run_id)
          .find((value) => value.phase.startsWith('writer-') && value.phase !== slot?.phase)
      : undefined;
    const siblingMember =
      group && sibling
        ? this.store
            .combinedMembers(group.run_id)
            .find((value) => sibling.phase === `writer-${value.ordinal}`)
        : undefined;
    const siblingCandidate = sibling?.candidate_id
      ? this.store.get<Candidate>('candidate', sibling.candidate_id)
      : undefined;
    let siblingProven = !group;
    let siblingRetryRunning = false;
    if (group && sibling && siblingMember && siblingCandidate) {
      try {
        siblingProven =
          sibling.state === 'passed' &&
          this.evaluationOrigin(siblingMember.task_id, siblingCandidate.id).writer.id ===
            sibling.attempt_id;
      } catch {}
    }
    if (group && sibling && siblingMember && !siblingProven) {
      const siblingAttempt = sibling.attempt_id
        ? this.store.get<Attempt>('attempt', sibling.attempt_id)
        : undefined;
      const siblingIntent = sibling.attempt_id
        ? this.store.intents().find((value) => value.attempt_id === sibling.attempt_id)
        : undefined;
      if (
        siblingAttempt &&
        siblingIntent &&
        siblingAttempt.runId === siblingMember.run_id &&
        siblingIntent.run_id === siblingMember.run_id
      ) {
        if (sibling.state === 'stopped') {
          const siblingPhases = this.store.nativeProcesses(siblingAttempt.id);
          siblingProven =
            siblingAttempt.state === 'stopped' &&
            this.confirmedQuotaDenial(siblingIntent) &&
            siblingPhases.length > 0 &&
            siblingPhases.every((phase) => phase.state === 'quiescent');
        } else if (sibling.state === 'running') {
          const priorSibling = this.store
            .intents()
            .filter(
              (value) =>
                value.run_id === siblingMember.run_id &&
                value.generation < siblingAttempt.generation,
            )
            .sort((left, right) => right.generation - left.generation)[0];
          siblingRetryRunning =
            ['intent', 'running'].includes(siblingAttempt.state) &&
            priorSibling?.generation === siblingAttempt.generation - 1 &&
            this.confirmedQuotaDenial(priorSibling);
          siblingProven = siblingRetryRunning;
        }
      }
    }
    if (group) this.combinedCurrent(group, true);
    if (
      task.runId !== run.id ||
      task.state !== 'interrupted' ||
      this.store.receipt(`paused:${run.id}`) ||
      this.hasUncertainWriter(task.id) ||
      !attempt ||
      attempt.state !== 'stopped' ||
      attempt.id !== completion.attemptId ||
      intent.task_id !== task.id ||
      intent.route_id !== attempt.routeId ||
      intent.generation !== attempt.generation ||
      !phases.length ||
      phases.some((phase) => phase.state !== 'quiescent') ||
      (group &&
        (group.run_id === run.id ||
          !member ||
          !slot ||
          !sibling ||
          !siblingProven ||
          slot.attempt_id !== attempt.id ||
          slot.state !== 'stopped' ||
          group.integration_active ||
          !(
            (group.phase === 'blocked' && group.blocker === 'writers-incomplete') ||
            (group.phase === 'writers' && siblingRetryRunning && group.blocker === null)
          ))) ||
      origin.appointment.route.family !== 'anthropic' ||
      'repository' in origin.appointment ||
      !('target' in origin.appointment) ||
      origin.run.id !== run.id ||
      hashCanonical(origin.run.source) !== hashCanonical(run.source) ||
      hashCanonical(origin.run.policy) !== hashCanonical(run.policy) ||
      hashCanonical(origin.run.roles) !== hashCanonical(run.roles) ||
      origin.appointment.consent.criteriaHash !== hashCanonical(task.criteria) ||
      Date.parse(origin.appointment.expiresAt) <= Date.parse(this.now()) ||
      !this.store.receipt(`allocation:${run.id}`) ||
      !run.policy.policy.effects.some(
        (grant) =>
          grant.action === 'write-scratch' &&
          grant.taskId === task.id &&
          !grant.revoked &&
          Date.parse(grant.expiresAt) > Date.parse(this.now()),
      ) ||
      (resetElapsed && reset > Date.parse(this.now()))
    )
      throw Error('Quota retry is unavailable.');
    return { task, origin, attempt, reset, completion, group, member, slot };
  }

  quotaRetryBinding(this: Controller, run: Run): NativeBinding {
    const { task, origin, attempt } = this.quotaRetryEvidence(run, true);
    const appointment = origin.appointment;
    if (!('target' in appointment)) throw Error('Quota retry target changed.');
    const profile = this.profileFor(origin.public.profileId);
    if (
      !profile.facts.available ||
      profile.facts.family !== 'anthropic' ||
      profile.facts.id !== origin.public.profileId ||
      profile.locationHash !== origin.public.locationHash ||
      hashCanonical(profile.client) !== hashCanonical(origin.appointment.client) ||
      this.nativeProfileRoute(profile, appointment.creditPolicy)?.id !== appointment.route.id ||
      !profile.environment
    )
      throw Error('Quota retry profile changed.');
    const files = committedFiles(this.projectPath(task.projectId) as string, run.source.base);
    const manifest = files.map(({ content: _content, ...file }) => file);
    const original = files.find((file) => file.path === appointment.target.path);
    if (
      hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(run.source) ||
      hashCanonical(manifest) !== hashCanonical(origin.manifest) ||
      !original ||
      original.hash !== origin.originalHash ||
      original.hash !== appointment.target.baseHash
    )
      throw Error('Quota retry source changed.');
    const retried = AttemptSchema.parse({
      id: this.id('att'),
      runId: run.id,
      routeId: attempt.routeId,
      generation: attempt.generation + 1,
      state: 'intent',
      revision: 0,
    });
    const sessionHash = hashCanonical({ attemptId: retried.id });
    const retryPlan = {
      appointment,
      run,
      attempt: retried,
      original: original.content.toString('utf8'),
      baseHash: original.hash,
      anthropicSessionId: `${sessionHash.slice(0, 8)}-${sessionHash.slice(8, 12)}-8${sessionHash.slice(13, 16)}-a${sessionHash.slice(17, 20)}-${sessionHash.slice(20, 32)}`,
      manifest,
      public: origin.public,
      environment: { ...profile.environment },
    };
    const binding = freezeNative({
      ...retryPlan,
      planArtifact: this.nativeArtifact(this.nativePlanPayload(retryPlan)),
    });
    if (!this.nativeConsentCurrent(binding)) throw Error('Quota retry consent changed.');
    this.nativeWriterPlan(binding);
    return binding;
  }

  quotaRetryPreview(this: Controller, run: Run): z.infer<typeof NativeRunSchema>['quotaRetry'] {
    try {
      const { reset } = this.quotaRetryEvidence(run, false);
      return {
        available: reset <= Date.parse(this.now()),
        mode: run.policy.policy.authority === 'guided' ? 'manual' : 'automatic',
        resetsAt: new Date(reset).toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  armQuotaRetries(this: Controller) {
    const runIds = new Set(this.store.intents().map((intent) => intent.run_id));
    for (const runId of runIds) {
      const run = this.store.get<Run>('run', runId);
      if (!run || run.policy.policy.authority === 'guided') continue;
      let reset = 0;
      let key = '';
      try {
        const evidence = this.quotaRetryEvidence(run, false);
        reset = evidence.reset;
        key = `quota-retry:${run.id}:${hashCanonical(evidence.completion.diagnostic.providerFailure)}`;
      } catch {
        continue;
      }
      if (this.store.receipt(key) || this.quotaRetries.has(key)) continue;
      const cancel = (this.options.schedule ?? defaultSchedule)(
        () => this.runQuotaRetry(runId, key),
        Math.max(0, reset - Date.parse(this.now())),
      );
      this.quotaRetries.set(key, cancel);
    }
  }

  runQuotaRetry(this: Controller, runId: string, key: string) {
    this.quotaRetries.delete(key);
    if (this.closed) return;
    const effects: (() => void)[] = [];
    try {
      this.store.transaction(() => {
        if (this.store.receipt(key)) return;
        const run = this.store.get<Run>('run', runId);
        const task = run && this.store.get<Task>('task', run.taskId);
        let result: CommandResult = { outcome: 'blocked', reason: 'quota-retry-unavailable' };
        if (run && task && run.policy.policy.authority !== 'guided') {
          const command = CommandSchema.parse({
            protocol: 1,
            key: this.id('cmd'),
            actor: { id: 'controller', kind: 'controller' },
            command: 'ResumeRun',
            expectedRevision: task.revision,
            payload: { taskId: task.id, runId: run.id },
          });
          result = this.start(command as Extract<Command, { command: 'ResumeRun' }>, effects);
        }
        this.store.saveReceipt(key, hashCanonical({ runId, key }), 'local-owner', result);
      });
    } catch {
      effects.length = 0;
      try {
        this.store.transaction(() => {
          if (!this.store.receipt(key))
            this.store.saveReceipt(key, hashCanonical({ runId, key }), 'local-owner', {
              outcome: 'blocked',
              reason: 'quota-retry-unavailable',
            });
        });
      } catch {}
    }
    for (const effect of effects)
      try {
        effect();
      } catch {}
  }

  repositoryScope(this: Controller, sourceBase: string, files: NativeBinding['manifest']) {
    const manifest = files.map(({ path, mode, hash, bytes }) => ({ path, mode, hash, bytes }));
    return NativeRepositoryScopeSchema.parse({
      sourceBase,
      manifestHash: hashCanonical(manifest),
      files: manifest.length,
      bytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
    });
  }
}
