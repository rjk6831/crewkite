import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcpApprovalTargetSchema,
  type Approval,
  ApprovalBindingSchema,
  type Artifact,
  ArtifactSchema,
  type Attempt,
  AttemptSchema,
  type CommandResult,
  canonicalJson,
  HashSchema,
  MAX_FRAME_BYTES,
  type Observation,
  type Project,
  type Route,
  type RouterDecision,
  type Run,
  RunSchema,
  requiredReviewMethodIds,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { z } from 'zod';
import {
  captureSingleFileEdit,
  committedFiles,
  inspectSource,
  materialize,
} from '../host/source.ts';
import { AcpDiagnosticSchema } from '../providers/google/acp/client.ts';
import { validateAcpSetupProof } from '../providers/google/acp/profile.ts';
import {
  AcpPermissionActionSchema,
  type AcpPermissionProposal,
  acpPermissionAfterHash,
  googleAcpWriterPlan,
  startGoogleAcpWriter,
} from '../providers/google/acp/writer.ts';
import { prepareOwnedContext } from '../providers/google/native-extension/connector.ts';
import { googleQuotaWindows } from '../providers/google/native-writer.ts';
import type { LaunchIntent } from '../store/index.ts';
import { availableAllowance, deriveWindow } from '../usage/index.ts';
import { chargedMinutes } from './budgets.ts';
import type { Controller } from './controller.ts';
import {
  freezeNative,
  type NativeAcpAppointmentSchema,
  NativeAppointmentSchema,
  type NativeBinding,
  type NativePilotAppointment,
  NativePreparationSchema,
  type NativePublicScopeSchema,
  type NativeRuntime,
} from './schemas.ts';

// Native appointment plans, admission decisions and the ACP writer launch.
export class NativePlanCommands {
  preparedNativeBinding(this: Controller, run: Run): NativeBinding {
    const receipt = this.store.receipt(`native-prepared:${run.id}`);
    if (receipt?.result.outcome !== 'applied') throw Error('Native preparation is unavailable.');
    const artifact = ArtifactSchema.parse(receipt.result.entity);
    if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Native preparation exceeds its bound.');
    const plan = NativePreparationSchema.parse(
      JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
    );
    const profile = this.profileFor(plan.public.profileId);
    const task = this.store.get<Task>('task', run.taskId);
    if (profile.facts.family === 'local') throw Error('Local native launch is unavailable.');
    if (profile.facts.reason === 'provider-policy-restricted')
      throw Error('provider-policy-restricted');
    const modelRequest =
      'repository' in plan.appointment ? plan.appointment.modelRequest : undefined;
    const modelSelection =
      task && modelRequest
        ? this.openAiProjectSelection(task.id, profile, modelRequest, true)
        : undefined;
    if (
      !profile.facts.available ||
      profile.facts.id !== plan.public.profileId ||
      !profile.facts.creditPolicies.some((policy) => policy === plan.appointment.creditPolicy) ||
      (!('acp' in plan.appointment) &&
        this.nativeProfileRoute(
          profile,
          plan.appointment.creditPolicy,
          modelRequest,
          modelSelection,
        )?.id !== plan.appointment.route.id) ||
      profile.locationHash !== plan.public.locationHash ||
      hashCanonical(profile.client) !== hashCanonical(plan.appointment.client) ||
      !profile.environment
    )
      throw Error('Native profile changed.');
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
    const appointment = plan.appointment;
    if ('acp' in appointment) {
      const setup = this.store.googleAcpSetup(),
        artifact = this.store.get<Artifact>('artifact', appointment.acp.proofId);
      if (
        setup.state !== 'ready' ||
        setup.proofId !== appointment.acp.proofId ||
        artifact?.hash !== appointment.proofHash ||
        hashCanonical(this.acpProof(appointment.acp.proofId)) !== hashCanonical(appointment.proof)
      )
        throw Error('ACP proof changed.');
      validateAcpSetupProof(
        appointment.proof,
        appointment.client,
        this.options.googleAcp?.reviewMappings,
      );
    }
    const original =
      'target' in appointment
        ? files.find((file) => file.path === appointment.target.path)
        : undefined;
    if ('repository' in plan.appointment) {
      if (
        hashCanonical(this.repositoryScope(run.source.base, manifest)) !==
          hashCanonical(plan.appointment.repository) ||
        !('execution' in profile.facts) ||
        hashCanonical(profile.facts.execution) !== hashCanonical(plan.appointment.execution)
      )
        throw Error('Native repository scope changed.');
    } else if (
      !original ||
      original.hash !== plan.originalHash ||
      original.hash !== plan.appointment.target.baseHash
    )
      throw Error('Native target changed.');
    const binding = freezeNative({
      appointment: plan.appointment,
      run,
      attempt: plan.attempt,
      ...(original ? { original: original.content.toString('utf8'), baseHash: original.hash } : {}),
      ...(plan.anthropicSessionId ? { anthropicSessionId: plan.anthropicSessionId } : {}),
      manifest,
      planArtifact: artifact,
      public: plan.public,
      environment: { ...profile.environment },
    });
    if (!this.nativeConsentCurrent(binding)) throw Error('Native consent changed.');
    this.nativeWriterPlan(binding);
    return binding;
  }

  planNativeAppointment(
    this: Controller,
    appointment: NativePilotAppointment,
    publicScope?: z.infer<typeof NativePublicScopeSchema>,
    runId = this.id('run'),
  ): Omit<NativeBinding, 'planArtifact'> {
    const task = this.store.get<Task>('task', appointment.taskId);
    if (task?.state !== 'draft' || this.draftEditGate(task))
      throw new Error('The appointment needs an unstarted draft.');
    const route = appointment.route;
    const appointmentModelRequest =
      'repository' in appointment ? appointment.modelRequest : undefined;
    const appointmentModelSelection =
      'repository' in appointment
        ? this.openAiProjectSelection(
            appointment.taskId,
            this.profileFor('openai-repository-v1'),
            appointmentModelRequest,
          )
        : undefined;
    const billingAttestation =
      'billingAttestation' in appointment ? appointment.billingAttestation : undefined;
    const permissionMode = 'permissionMode' in appointment ? appointment.permissionMode : undefined;
    if (
      route.fake ||
      route.qualified ||
      !['openai', 'anthropic', 'google'].includes(route.family) ||
      route.billing !== (appointment.creditPolicy === 'ordinary' ? 'included' : 'credits') ||
      route.speed ||
      (route.family === 'openai'
        ? route.effort.requested !== route.effort.effective || !!billingAttestation
        : route.effort.requested !== (route.family === 'anthropic' ? 'medium' : 'low') ||
          route.effort.effective !== 'unknown' ||
          appointment.creditPolicy !== 'ordinary' ||
          !billingAttestation) ||
      (route.family === 'google') !== !!permissionMode ||
      (route.family === 'google' && !publicScope) ||
      (!!appointmentModelSelection &&
        (route.model !== appointmentModelSelection.model ||
          route.effort.requested !== appointmentModelSelection.effort ||
          route.effort.effective !== appointmentModelSelection.effort)) ||
      !route.effort.supported.includes(route.effort.requested) ||
      (this.store.get('route', route.id) &&
        (!publicScope ||
          this.nativeProfileRoute(
            this.profileFor(publicScope.profileId),
            appointment.creditPolicy,
            appointmentModelRequest,
            appointmentModelRequest ? appointmentModelSelection : undefined,
          )?.id !== route.id))
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
    const original =
      'target' in appointment
        ? files.find((file) => file.path === appointment.target.path)
        : undefined;
    if ('repository' in appointment) {
      if (
        publicScope?.profileId !== 'openai-repository-v1' ||
        hashCanonical(this.repositoryScope(source.base, files)) !==
          hashCanonical(appointment.repository)
      )
        throw Error('The appointed repository scope is unavailable.');
    } else if (
      !original ||
      original.bytes > 65_536 ||
      original.hash !== appointment.target.baseHash
    )
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
    const sessionHash = hashCanonical({ attemptId });
    const anthropicSessionId =
      route.family === 'anthropic'
        ? `${sessionHash.slice(0, 8)}-${sessionHash.slice(8, 12)}-8${sessionHash.slice(13, 16)}-a${sessionHash.slice(17, 20)}-${sessionHash.slice(20, 32)}`
        : undefined;
    this.nativeDecision(appointment, run, !!publicScope);
    const project = this.store.get<Project>('project', task.projectId) as Project;
    if ('repository' in appointment && !this.grant(run, 'run-native-tools', project.name))
      throw Error('The appointment needs a saved native-tool grant.');
    if (!this.grant(run, 'write-scratch', project.name))
      throw new Error('The appointment needs a saved scratch grant.');
    const manifest = files.map(({ content: _content, ...file }) => file);
    const plan = freezeNative({
      appointment,
      run,
      attempt,
      manifest,
      ...(original ? { original: original.content.toString('utf8'), baseHash: original.hash } : {}),
      ...(anthropicSessionId ? { anthropicSessionId } : {}),
      ...(publicScope ? { public: publicScope } : {}),
    });
    this.nativeWriterPlan(plan);
    if (Buffer.byteLength(canonicalJson(this.nativePlanPayload(plan))) > MAX_FRAME_BYTES)
      throw Error('Native plan exceeds its bound.');
    return plan;
  }

  nativePlanPayload(this: Controller, plan: Omit<NativeBinding, 'planArtifact'>) {
    const { appointment, run, attempt, manifest } = plan;
    return {
      appointment,
      run,
      attempt,
      manifest,
      ...('repository' in appointment ? {} : { originalHash: plan.baseHash }),
      ...(plan.anthropicSessionId ? { anthropicSessionId: plan.anthropicSessionId } : {}),
      ...(plan.public ? { public: plan.public } : {}),
      ...(plan.handoff ? { handoff: plan.handoff } : {}),
    };
  }

  saveNativePlan(this: Controller, plan: Omit<NativeBinding, 'planArtifact'>): NativeBinding {
    const { appointment, run } = plan;
    const task = this.store.get<Task>('task', appointment.taskId) as Task;
    const planArtifact = this.nativeArtifact(this.nativePlanPayload(plan));
    this.store.put('route', appointment.route.id, 0, appointment.route);
    if (
      plan.public &&
      !this.store.receipt(
        this.nativeProfileRouteKey(
          plan.public.profileId,
          appointment.creditPolicy,
          'repository' in appointment ? appointment.modelRequest : undefined,
        ),
      )
    )
      this.store.saveReceipt(
        this.nativeProfileRouteKey(
          plan.public.profileId,
          appointment.creditPolicy,
          'repository' in appointment ? appointment.modelRequest : undefined,
        ),
        hashCanonical({
          profileId: plan.public.profileId,
          client: appointment.client,
          route: appointment.route,
        }),
        'local-owner',
        { outcome: 'applied', entity: planArtifact },
      );
    this.store.put('run', run.id, 0, run);
    this.store.putRunPurpose(run, 'execution', task.runId);
    this.updateTask(task, { runId: run.id });
    this.store.saveReceipt(`native-run:${run.id}`, hashCanonical(appointment), 'local-owner', {
      outcome: 'applied',
      entity: planArtifact,
    });
    return freezeNative({ ...plan, planArtifact });
  }

  startNativePilot(this: Controller, input: NativePilotAppointment): CommandResult {
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

  nativeManualAllowance(this: Controller, run: Run, routeId: string, requestedMinutes: number) {
    if (!this.store.receipt(`native-handoff-roster:${run.id}`)) return;
    const allowance = run.policy.policy.unknownUsage;
    const ledger = this.store
      .intents()
      .filter((intent) => intent.run_id === run.id && intent.route_id === routeId);
    const completed = ledger.filter((intent) => intent.state === 'stopped');
    const active = ledger.filter((intent) => intent.state !== 'stopped');
    const minutes = completed.reduce(
      (sum, intent) => sum + chargedMinutes(intent, run.policy.policy.limits.minutes),
      0,
    );
    if (
      allowance.rule !== 'fixed-allowance' ||
      ledger.length + 1 > allowance.allowance.launches ||
      minutes + active.length * run.policy.policy.limits.minutes + requestedMinutes >
        allowance.allowance.minutes
    )
      throw Error('The original per-route launch allowance is exhausted.');
  }

  nativeDecision(
    this: Controller,
    appointment:
      | NativePilotAppointment
      | {
          kind: 'candidate-review';
          route: Route;
          maximumTaskMs: number;
          expiresAt: string;
        },
    run: Run,
    publicProfile = false,
  ): RouterDecision {
    if ('acp' in appointment && appointment.route.family === 'google')
      return this.acpDecision(appointment, run);
    const policy = run.policy.policy;
    const allowance = policy.unknownUsage;
    const active = this.store.intents().filter((intent) => intent.state !== 'stopped');
    this.nativeManualAllowance(run, appointment.route.id, this.remaining(run).minutes);
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

  acpQuotaState(this: Controller, routeId: string, modelId: string, run: Run) {
    const reader = this.store.googleUsageReader();
    const { windows, missingRequired } = googleQuotaWindows(
      modelId,
      this.store
        .list<Observation>('window')
        .filter((value) => value.routeId === routeId && value.kind !== 'local'),
    );
    let needsRefresh = !reader.last_observed_at || !windows.length || missingRequired;
    let reserveReason: string | undefined;
    const nowMs = Date.parse(this.now());
    for (const window of windows) {
      if (
        deriveWindow(window, { nowMs, maxAgeMs: 300000 }).state !== 'fresh' ||
        window.remaining === null ||
        window.source !== 'client' ||
        window.confidence !== 'reported'
      ) {
        needsRefresh = true;
        continue;
      }
      const reserves = run.policy.policy.reserves.filter(
        (value) => value.routeId === routeId && value.windowId === window.windowId,
      );
      const reservations = this.store.db
        .prepare('SELECT unit,value FROM reservations WHERE route_id=? AND window_id=?')
        .all(routeId, window.windowId) as {
        unit: NonNullable<Observation['remaining']>['unit'];
        value: number;
      }[];
      try {
        if (
          reserves.length > 1 ||
          availableAllowance({ remaining: window.remaining, reserve: reserves[0], reservations }) <=
            0
        )
          reserveReason = 'A Google quota bucket has reached its reserve.';
      } catch {
        reserveReason = 'A Google reserve has incompatible allowance units.';
      }
    }
    if (
      run.policy.policy.reserves.some(
        (value) =>
          value.routeId === routeId &&
          !windows.some((window) => window.windowId === value.windowId),
      )
    )
      needsRefresh = true;
    return { reader, windows, needsRefresh, reserveReason };
  }

  acpDecision(
    this: Controller,
    appointment: z.infer<typeof NativeAcpAppointmentSchema>,
    run: Run,
  ): RouterDecision {
    const { reader, windows, needsRefresh, reserveReason } = this.acpQuotaState(
      appointment.route.id,
      appointment.acp.modelId,
      run,
    );
    let reason = reserveReason;
    if (needsRefresh) reason ??= 'Every applicable Google quota bucket needs fresh observations.';
    if (
      appointment.maximumTaskMs > 300000 &&
      this.remaining(run).minutes * 60000 < appointment.maximumTaskMs
    )
      reason = 'The remaining task allowance cannot cover the saved Google deadline.';
    if (Date.parse(appointment.expiresAt) <= Date.parse(this.now()))
      reason = 'Native consent expired.';
    return {
      chosen: reason ? null : appointment.route.id,
      rejected: reason ? [{ routeId: appointment.route.id, reason }] : [],
      rule: 'percentage',
      inputsHash: hashCanonical({ reader, windows, policy: run.policy, reason: reason ?? null }),
    };
  }

  acpTargetSnapshot(this: Controller, runtime: NativeRuntime) {
    this.nativeCurrent(runtime);
    const appointment = runtime.binding.appointment;
    if (!('acp' in appointment)) throw Error('ACP permission has no owned attempt.');
    const captured = captureSingleFileEdit({
      directory: this.writerScratch(runtime.binding.run),
      manifest: runtime.binding.manifest,
      target: appointment.target,
    });
    const file = captured.files.find((entry) => entry.path === appointment.target.path);
    if (!file) throw Error('ACP target is unavailable.');
    return {
      path: file.path,
      hash: file.hash,
      mode: file.mode,
      content: file.content.toString('utf8'),
    };
  }

  validateAcpPermission(this: Controller, runtime: NativeRuntime, proposal: AcpPermissionProposal) {
    this.nativeCurrent(runtime);
    const appointment = runtime.binding.appointment;
    if (!('acp' in appointment)) throw Error('ACP permission has no owned attempt.');
    const detail = AcpPermissionActionSchema.parse(proposal.detail);
    AcpApprovalTargetSchema.parse(proposal.acpTarget);
    if (
      proposal.action !== 'write-scratch' ||
      proposal.target !== appointment.target.path ||
      detail.path !== appointment.target.path ||
      proposal.consequence !== canonicalJson(detail) ||
      Buffer.byteLength(proposal.consequence) > 4096 ||
      proposal.actionHash !== hashCanonical(detail) ||
      !HashSchema.safeParse(proposal.proposalHash).success
    )
      throw Error('ACP action changed.');
    acpPermissionAfterHash(detail, this.acpTargetSnapshot(runtime));
  }

  requestAcpPermission(
    this: Controller,
    runtime: NativeRuntime,
    proposal: AcpPermissionProposal,
  ): z.infer<typeof ApprovalBindingSchema> {
    this.validateAcpPermission(runtime, proposal);
    return this.store.transaction(() => {
      this.validateAcpPermission(runtime, proposal);
      const { run, attempt } = runtime.binding,
        task = this.store.get<Task>('task', run.taskId) as Task;
      if (
        this.store.db
          .prepare("SELECT approval_id FROM pending_effects WHERE task_id=? AND state='pending'")
          .get(task.id)
      )
        throw Error('A native permission is already pending.');
      this.requestAction(
        task,
        run,
        attempt,
        'write-scratch',
        proposal.target,
        { kind: 'acp', proposal },
        proposal,
      );
      const row = this.store.db
        .prepare(
          "SELECT approval_id FROM pending_effects WHERE task_id=? AND attempt_id=? AND state='pending'",
        )
        .get(task.id, attempt.id);
      const approval = row
        ? this.store.get<Approval>('approval', row.approval_id as string)
        : undefined;
      if (!approval || hashCanonical(approval.acpTarget) !== hashCanonical(proposal.acpTarget))
        throw Error('ACP permission could not be bound.');
      const {
        requester: _requester,
        consequence: _consequence,
        status: _status,
        ...binding
      } = approval;
      return ApprovalBindingSchema.parse(binding);
    });
  }

  launchAcpNative(this: Controller, intent: LaunchIntent, binding: NativeBinding) {
    const runtime: NativeRuntime = { kind: 'native', binding, stopped: false };
    const completion = Promise.withResolvers<void>();
    runtime.done = completion.promise;
    this.workers.set(binding.attempt.id, runtime);
    const appointment = binding.appointment;
    if (!('acp' in appointment)) throw Error('ACP appointment is unavailable.');
    const { run, attempt } = binding;
    const finish = async (
      outcome: Awaited<ReturnType<typeof startGoogleAcpWriter>['result']> | null,
      unspawned = false,
    ) => {
      try {
        const physical =
          unspawned ||
          (outcome?.quiescent === true && this.store.nativePhasesComplete(attempt.id, 'google'));
        const metadata = outcome?.metadata;
        const terminal =
          !!metadata &&
          metadata.submitted === true &&
          metadata.selectionHash === hashCanonical(appointment.acp) &&
          metadata.reviewModeHash === hashCanonical(appointment.proof.reviewMode) &&
          !!this.store.receipt(`native-submission:${attempt.id}`);
        this.store.transaction(() => {
          const done = this.nativeArtifact({
            attemptId: attempt.id,
            reason: outcome ? outcome.reason : 'launch',
            quiescent: physical,
            diagnostic: AcpDiagnosticSchema.nullable().parse(outcome?.diagnostic ?? null),
            exitCode: outcome?.exitCode ?? null,
            signal: outcome?.signal ?? null,
            stdoutBytes: outcome?.stdoutBytes ?? 0,
            stderrBytes: outcome?.stderrBytes ?? 0,
            ...(outcome ? { stderrSummary: outcome.stderrSummary } : {}),
            trailingUpdates: outcome?.trailingUpdates ?? 0,
            rejectedOutsideWrites: outcome?.rejectedOutsideWrites ?? 0,
            openToolCount: outcome?.openToolCount ?? 0,
            openToolKinds: outcome?.openToolKinds ?? [],
            ...(unspawned ? { unspawned: true } : {}),
          });
          this.store.saveReceipt(`native-completion:${attempt.id}`, done.hash, 'local-owner', {
            outcome: 'applied',
            entity: done,
          });
          if (metadata) {
            const proof = this.nativeArtifact(metadata);
            this.store.saveReceipt(`native-proposal:${attempt.id}`, proof.hash, 'local-owner', {
              outcome: 'applied',
              entity: proof,
            });
          }
          if (physical && terminal) {
            const proof = this.nativeArtifact({
              attemptId: attempt.id,
              planHash: binding.planArtifact.hash,
              completionHash: done.hash,
              metadataHash: hashCanonical(metadata),
            });
            this.store.saveReceipt(`native-acp-terminal:${attempt.id}`, proof.hash, 'local-owner', {
              outcome: 'applied',
              entity: proof,
            });
          }
        });
        const known =
          physical && (terminal || !this.store.receipt(`native-submission:${attempt.id}`));
        if (known) await this.formatAttempt(attempt);
        // A submitted turn with no terminal response stays unknown. Once every recorded group is
        // gone it holds nothing, so it settles here and captures nothing.
        const closed = known ? undefined : this.shutdownProof(intent);
        if (closed) {
          this.store.transaction(() =>
            this.settleUnknownWriter(
              intent,
              closed,
              'Every recorded process group exited and the turn returned no terminal response.',
            ),
          );
          this.workers.delete(attempt.id);
          return;
        }
        let eligible =
          known &&
          !runtime.stopped &&
          !this.closed &&
          !outcome?.reason &&
          metadata?.stopReason === 'end_turn';
        // An agent can end its turn cleanly after a failed or skipped edit.
        const unapproved =
          eligible &&
          (!metadata?.targetHash || metadata.targetHash === appointment.target.baseHash);
        if (unapproved) eligible = false;
        if (eligible) {
          try {
            this.nativeCurrent(runtime);
          } catch {
            eligible = false;
          }
        }
        if (!this.settleJob(attempt, known, true)) return;
        let captured = false;
        let unchanged = false;
        if (known) {
          try {
            const files = captureSingleFileEdit({
              directory: intent.scratch_path,
              manifest: binding.manifest,
              target: appointment.target,
            });
            // With no approved change and scratch still at the admitted source, there is
            // nothing to check or review. Any unapproved write keeps the unverified path.
            unchanged = unapproved && files.target.hash === appointment.target.baseHash;
            const candidate = unchanged ? null : this.sealCandidate(attempt, files.files);
            if (
              metadata?.targetHash !== undefined &&
              !this.writerBytes(
                attempt.id,
                files.target.path,
                metadata.targetHash,
                files.target.hash,
              )
            )
              eligible = false;
            if (eligible && candidate) {
              this.store.transaction(() => {
                const proof = this.nativeArtifact({
                  version: 1,
                  attemptId: attempt.id,
                  planHash: binding.planArtifact.hash,
                  completionHash: this.nativeRecord(`native-completion:${attempt.id}`, 4096)
                    .artifact.hash,
                  metadataHash: this.nativeRecord(`native-proposal:${attempt.id}`).artifact.hash,
                  candidateId: candidate.id,
                  candidateHash: candidate.hash,
                  target: files.target,
                });
                this.store.saveReceipt(
                  `native-acp-capture:${attempt.id}`,
                  proof.hash,
                  'local-owner',
                  { outcome: 'applied', entity: proof },
                );
              });
              captured = true;
            }
          } catch {}
        }
        this.store.transaction(() => {
          const task = this.store.get<Task>('task', run.taskId) as Task;
          this.closePendingEffects(task);
          this.updateTask(task, {
            state: known ? (captured ? 'stopped' : 'interrupted') : 'unknown',
            waitingReason: null,
            next: captured
              ? 'Native work is retained. Checks and review remain pending.'
              : unchanged
                ? 'Native turn ended without an approved change. Nothing was captured.'
                : known
                  ? 'Native work is unverified. Inspect retained changes.'
                  : 'Native turn completion is unknown. Nothing will replay automatically.',
          });
        });
        if (known) this.workers.delete(attempt.id);
      } catch {
        try {
          this.settleJob(attempt, false, true);
        } catch {}
      } finally {
        completion.resolve();
      }
    };
    void (async () => {
      try {
        this.nativeCurrent(runtime);
        if (!binding.context || !binding.environment) throw Error('ACP context is unavailable.');
        if (!existsSync(intent.scratch_path))
          materialize(
            intent.scratch_path,
            committedFiles(this.projectPath(run.source.projectId) as string, run.source.base),
          );
        const directory = join(this.home, 'native', attempt.id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const context = await prepareOwnedContext({
          client: this.contextClient(),
          context: binding.context,
          home: this.home,
          scratch: intent.scratch_path,
          directory: join(directory, 'context'),
          expiresAt: appointment.expiresAt,
          now: () => Date.parse(this.now()),
          owner: {
            taskId: run.taskId,
            runId: run.id,
            attemptId: attempt.id,
            generation: attempt.generation,
            routeId: attempt.routeId,
            policyHash: run.policy.hash,
            profileId: 'google-acp-v1',
            selection: appointment.acp,
          },
        });
        this.nativeCurrent(runtime);
        const journal = this.nativeLifecycle(attempt, () => this.nativeCurrent(runtime));
        const phase = { sequence: 0, kind: 'google-acp-task' as const };
        const handle = startGoogleAcpWriter({
          client: appointment.client,
          directory,
          scratch: intent.scratch_path,
          environment: binding.environment,
          plan: googleAcpWriterPlan({
            attemptId: attempt.id,
            generation: attempt.generation,
            target: appointment.target,
            criteria: [
              binding.public?.context.title ?? '',
              binding.public?.context.outcome ?? '',
              ...(this.store.get<Task>('task', run.taskId) as Task).criteria,
            ],
            selection: appointment.acp,
            ...(appointment.contextLines === undefined
              ? {}
              : { contextLines: appointment.contextLines }),
            proof: appointment.proof,
            client: appointment.client,
            ...this.options.googleAcp,
          }),
          ...(binding.context.binding.patch ? { mcpServer: context.server } : {}),
          ...this.options.googleAcp,
          spawn: this.options.googleAcp?.spawn,
          schedule: this.options.schedule,
          timeoutMs: Math.min(
            appointment.maximumTaskMs,
            this.jobDeadline(attempt.id, appointment.maximumTaskMs / 60000),
            Date.parse(appointment.expiresAt) - Date.parse(this.now()),
          ),
          lifecycle: {
            beforePhase: () => journal.beforePhase(phase),
            owned: (group) => journal.owned(phase, group),
            quiescent: (group) => journal.quiescent(phase, group),
          },
          onSubmitted: () => {
            this.nativeCurrent(runtime);
            this.store.transaction(() => {
              this.nativeCurrent(runtime);
              const proof = this.nativeArtifact({
                attemptId: attempt.id,
                plan: binding.planArtifact.hash,
              });
              this.store.saveReceipt(
                `native-submission:${attempt.id}`,
                binding.planArtifact.hash,
                'local-owner',
                { outcome: 'outcome-unknown', entity: proof },
              );
            });
          },
          onPermission: (proposal) => this.requestAcpPermission(runtime, proposal),
          readTarget: () => this.acpTargetSnapshot(runtime),
          onActivity: (activity, text) => {
            if (
              runtime.stopped ||
              this.closed ||
              this.store.get<Task>('task', run.taskId)?.state === 'stopping'
            )
              return;
            this.nativeCurrent(runtime);
            this.store.transaction(() => {
              const task = this.store.get<Task>('task', run.taskId) as Task;
              this.event('attempt.output', task.id, task.revision, {
                attemptId: attempt.id,
                generation: attempt.generation,
                channel: 'acp',
                acp: activity,
                text,
              });
            });
          },
        });
        runtime.acpHandle = handle;
        runtime.handle = {
          stop: () => handle.stop(),
          result: handle.result.then((outcome) => ({
            ...outcome,
            metadata: outcome.metadata
              ? { ...outcome.metadata, family: 'google-acp' as const }
              : null,
            diagnostic: null,
          })),
        };
        if (runtime.stopped || this.closed) handle.stop();
        await finish(await handle.result);
      } catch {
        await finish(null, this.store.nativeProcesses(attempt.id).length === 0);
      }
    })();
  }

  nativeArtifact(this: Controller, value: unknown): Artifact {
    const artifact = ArtifactSchema.parse({
      id: this.id('art'),
      ...this.artifacts.publish(Buffer.from(canonicalJson(value))),
      mediaType: 'application/vnd.crewkite.native+json',
    });
    this.saveArtifacts([artifact]);
    return artifact;
  }

  nativeCurrent(this: Controller, runtime: NativeRuntime) {
    const { appointment, run, attempt } = runtime.binding;
    const group = this.store.combinedGroup(run.id);
    if (group) this.combinedCurrent(group, group.phase === 'paused');
    if ('acp' in appointment) {
      const setup = this.store.googleAcpSetup(),
        profile = this.acpResolution();
      const proof = this.store.get<Artifact>('artifact', appointment.acp.proofId);
      if (
        this.store.nativeProfileId(attempt.id) !== 'google-acp-v1' ||
        setup.state !== 'ready' ||
        setup.proofId !== appointment.acp.proofId ||
        proof?.hash !== appointment.proofHash ||
        !profile.facts.available ||
        hashCanonical(profile.client) !== hashCanonical(appointment.client) ||
        hashCanonical(this.acpProof(appointment.acp.proofId)) !== hashCanonical(appointment.proof)
      )
        throw Error('ACP runtime proof changed.');
    }
    if (runtime.binding.handoff) this.nativeManualAuthority(runtime.binding, true);
    const task = this.store.get<Task>('task', run.taskId);
    const current = this.store.get<Attempt>('attempt', attempt.id);
    const saved = this.store.get<Run>('run', run.id);
    if ('repository' in appointment) {
      const project = this.store.get<Project>('project', run.source.projectId);
      const tools = saved?.policy.policy.effects.find(
        (grant) =>
          grant.action === 'run-native-tools' &&
          grant.taskId === run.taskId &&
          grant.target === project?.name &&
          !grant.revoked &&
          grant.usesRemaining === 1 &&
          Date.parse(grant.expiresAt) > Date.parse(this.now()),
      );
      const consumed = tools && this.store.receipt(this.grantKey(tools));
      const intent = this.store.intents().find((row) => row.attempt_id === attempt.id);
      if (
        !saved ||
        !project ||
        !tools ||
        consumed?.hash !== hashCanonical(tools) ||
        (consumed.result.entity as Run | undefined)?.id !== run.id ||
        hashCanonical(saved.policy.policy) !== appointment.consent.policyHash ||
        !this.grant(saved, 'write-scratch', project.name) ||
        intent?.run_id !== run.id ||
        intent.task_id !== run.taskId ||
        intent.route_id !== attempt.routeId ||
        intent.generation !== attempt.generation
      )
        throw Error('The native repository grants are unavailable.');
    }
    const lease = this.store.db
      .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
      .get(run.taskId);
    if (
      this.closed ||
      (runtime.binding.public && !this.nativeConsentCurrent(runtime.binding)) ||
      runtime.stopped ||
      runtime.reason === 'stop' ||
      task?.runId !== run.id ||
      (task.state !== 'running' &&
        !('acp' in appointment && task.state === 'waiting' && task.waitingReason === 'approval')) ||
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
}
