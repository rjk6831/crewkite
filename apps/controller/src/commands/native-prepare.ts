import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type Artifact,
  ArtifactSchema,
  type Attempt,
  AttemptSchema,
  type Command,
  type CommandResult,
  CommandSchema,
  canonicalJson,
  GoogleAcpSelectionSchema,
  LocalObservedModelBindingSchema,
  MAX_FRAME_BYTES,
  NativeProfileSchema,
  NativeRepositoryExecutionSchema,
  PolicySchema,
  type Project,
  RouteSchema,
  type Run,
  RunSchema,
  requiredReviewMethodIds,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { z } from 'zod';
import {
  applyReplacement,
  committedFiles,
  type FileContent,
  inspectSource,
  materialize,
} from '../host/source.ts';
import { defaultSchedule } from '../host/worker.ts';
import { validateAcpSetupProof } from '../providers/google/acp/profile.ts';
import { googleAcpTargetContext } from '../providers/google/acp/writer.ts';
import { captureContext } from '../providers/google/native-extension/connector.ts';
import {
  type LocalStart,
  TerminalSchema as LocalTerminalSchema,
  localPlan,
  localTests,
} from '../providers/local/profile.ts';
import { startLocalReplacement } from '../providers/local/replacement.ts';
import type { Controller } from './controller.ts';
import {
  evaluationFloorMinutes,
  freezeNative,
  type LocalPrepared,
  LocalPreparedSchema,
  type LocalWriterRuntime,
  NativeAcpAppointmentSchema,
  NativeAppointmentSchema,
  type NativeBinding,
  NativeManualRosterSchema,
  NativePublicScopeSchema,
  nativeProviderRestriction,
} from './schemas.ts';

// Preparation and start of ACP, Local and native writers.
export class NativePrepareCommands {
  prepareAcp(
    this: Controller,
    command: Extract<Command, { command: 'PrepareNativeRun' }>,
    maximumMinutes?: number,
  ): CommandResult {
    let writing = false;
    if (command.payload.profileId !== 'google-acp-v1' || !('proofId' in command.payload))
      return { outcome: 'unsupported', reason: 'invalid-command' };
    try {
      const input = command.payload;
      const setup = this.store.googleAcpSetup();
      const profile = this.acpResolution();
      if (
        setup.state !== 'ready' ||
        setup.proofId !== input.proofId ||
        !profile.facts.available ||
        !profile.client ||
        !profile.environment ||
        !profile.locationHash
      )
        throw Error('ACP setup is unavailable.');
      const proof = validateAcpSetupProof(
        this.acpProof(input.proofId),
        profile.client,
        this.options.googleAcp?.reviewMappings,
      );
      if (!proof.reviewMode || !proof.configOptions || proof.auth.status !== 'authenticated')
        throw Error('ACP setup is incomplete.');
      const task = this.store.get<Task>('task', input.taskId);
      if (task?.state !== 'draft') return { outcome: 'blocked', reason: 'task-not-preparable' };
      const gate = this.draftEditGate(task);
      if (gate) return gate;
      const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
      const files = committedFiles(this.projectPath(task.projectId) as string, source.base);
      const target = files.find((file) => file.path === input.targetPath);
      if (
        !target ||
        target.bytes > 65536 ||
        new TextDecoder('utf-8', { fatal: true }).decode(target.content).includes('\0')
      )
        throw Error('ACP target is unavailable.');
      if (input.contextLines)
        googleAcpTargetContext(target.content.toString('utf8'), input.contextLines);
      const policy = PolicySchema.parse(input.policy);
      const requestedTaskMs = input.maximumTaskMs ?? 300000;
      const maximumTaskMs =
        maximumMinutes === undefined
          ? requestedTaskMs
          : Math.min(requestedTaskMs, maximumMinutes * 60000);
      if (
        requestedTaskMs > profile.facts.maximumTaskMs ||
        (input.maximumTaskMs !== undefined &&
          maximumMinutes !== undefined &&
          requestedTaskMs > maximumMinutes * 60000) ||
        policy.limits.minutes * 60000 < maximumTaskMs ||
        policy.authority === 'autopilot' ||
        policy.limits.minutes * 60000 < 300000 ||
        !requiredReviewMethodIds(policy.quality).every((id) =>
          (policy.methods ?? []).some((method) => method.id === id),
        ) ||
        policy.limits.attempts <
          (policy.methods ?? []).reduce((n, method) => n + method.cycles, 0) + 2
      )
        throw Error('ACP policy is unavailable.');
      const runId = this.id('run');
      const grant = this.grant(
        { id: runId, taskId: task.id, policy: { policy, hash: hashCanonical(policy) } },
        'write-scratch',
        (this.store.get<Project>('project', task.projectId) as Project).name,
      );
      if (!grant) throw Error('Scratch authority is unavailable.');
      const acp = GoogleAcpSelectionSchema.parse({
        proofId: input.proofId,
        modelId: input.modelId,
        thoughtLevelId: input.thoughtLevelId,
      });
      const scopeHash = hashCanonical({
        profile: profile.facts,
        client: profile.client,
        proof,
        acp,
        task: { title: task.title, outcome: task.outcome, criteria: task.criteria },
        source,
        target: { path: target.path, hash: target.hash, mode: target.mode },
        policy,
        billingAttestation: input.billingAttestation,
        ...(input.maximumTaskMs === undefined ? {} : { maximumTaskMs }),
        ...(input.contextLines === undefined ? {} : { contextLines: input.contextLines }),
      });
      const expiresAt =
        input.consent === 'saved'
          ? new Date(
              Math.min(
                Date.parse(grant.expiresAt),
                Date.parse(this.consentRecord(scopeHash).expiresAt),
              ),
            ).toISOString()
          : grant.expiresAt;
      const artifact = this.store.get<Artifact>('artifact', input.proofId) as Artifact;
      const route = RouteSchema.parse({
        id: this.id('rte'),
        family: 'google',
        displayName: profile.facts.displayName,
        model: input.modelId,
        effort: {
          requested: input.thoughtLevelId ?? 'unknown',
          effective: 'unknown',
          supported: proof.configOptions.thoughtLevel?.supported ?? [],
        },
        billing: 'included',
        qualified: false,
        fake: false,
      });
      const appointment = NativeAcpAppointmentSchema.parse({
        id: command.key.replaceAll('_', '-'),
        profileId: 'google-acp-v1',
        taskId: task.id,
        route,
        client: profile.client,
        creditPolicy: 'ordinary',
        billingAttestation: input.billingAttestation,
        permissionMode: 'request-review',
        target: { path: target.path, baseHash: target.hash, mode: target.mode },
        acp,
        proof,
        proofHash: artifact.hash,
        consent: {
          nativeTrust: 'accepted',
          source: input.consent === 'explicit' ? 'explicit' : 'policy',
          policyHash: hashCanonical(policy),
          sourceBase: source.base,
          criteriaHash: hashCanonical(task.criteria),
        },
        policy,
        expiresAt,
        maximumTaskMs,
        ...(input.contextLines === undefined ? {} : { contextLines: input.contextLines }),
        maximumSubmissions: 1,
      });
      const run = RunSchema.parse({
        id: runId,
        taskId: task.id,
        source,
        policy: { policy, hash: hashCanonical(policy) },
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
        id: this.id('att'),
        runId,
        routeId: route.id,
        generation: 0,
        state: 'intent',
        revision: 0,
      });
      const publicScope = NativePublicScopeSchema.parse({
        profileId: 'google-acp-v1',
        locationHash: profile.locationHash,
        scopeHash,
        context: { title: task.title, outcome: task.outcome },
      });
      const plan = {
        appointment,
        run,
        attempt,
        original: target.content.toString('utf8'),
        baseHash: target.hash,
        manifest: files.map(({ content: _content, ...file }) => file),
        public: publicScope,
        environment: profile.environment,
      };
      this.nativeWriterPlan(plan);
      writing = true;
      const binding = this.saveNativePlan(plan);
      this.attachGoogleUsage(route.id, profile.environment);
      if (input.consent === 'explicit' && !this.store.receipt(`native-consent:${scopeHash}`)) {
        const consent = this.nativeArtifact({ scopeHash, expiresAt });
        this.store.saveReceipt(`native-consent:${scopeHash}`, scopeHash, 'local-owner', {
          outcome: 'applied',
          entity: consent,
        });
      }
      this.store.saveReceipt(
        `native-prepared:${runId}`,
        hashCanonical(publicScope),
        'local-owner',
        { outcome: 'applied', entity: binding.planArtifact },
      );
      const updated = this.updateTask(this.store.get<Task>('task', task.id) as Task, {
        next: 'Review the native preparation and fresh quota before Start.',
      });
      this.event('run.prepared', task.id, updated.revision, run);
      return { outcome: 'applied', entity: run, revision: updated.revision };
    } catch (error) {
      if (writing) throw error;
      return {
        outcome: 'blocked',
        reason: 'acp-preparation-unavailable',
        next: 'Review the current setup proof, model, thought level, billing confirmations, target and policy.',
      };
    }
  }

  isPreparedAcp(this: Controller, runId: string): boolean {
    try {
      return 'acp' in this.nativeCurrentPlan(this.store.get<Run>('run', runId) as Run).appointment;
    } catch {
      return false;
    }
  }

  contextClient(this: Controller) {
    return {
      snapshot: async () => this.snapshot(),
      command: (input: Command) => {
        if (!['GetChanges', 'GetArtifact'].includes(input.command))
          return Promise.resolve<CommandResult>({ outcome: 'denied', reason: 'context-read-only' });
        return this.execute(input, 'local-owner');
      },
    };
  }

  executeAcpStart(
    this: Controller,
    command: Extract<Command, { command: 'StartRun' }>,
    principal: string,
  ): Promise<CommandResult> {
    const hash = hashCanonical(command),
      prior = this.acpStart;
    if (prior)
      return prior.key === command.key && prior.hash === hash && prior.principal === principal
        ? prior.promise
        : Promise.resolve({
            outcome: prior.key === command.key ? 'denied' : 'blocked',
            reason: prior.key === command.key ? 'idempotency-key-reused' : 'acp-start-preparing',
          });
    if (this.store.receipt(command.key))
      return Promise.resolve(this.commitCommand(command, principal));
    const installBlocker = this.googleInstallationBlocker();
    if (installBlocker) return Promise.resolve(installBlocker);
    const deadline = performance.now() + 30000;
    const wallDeadline = Date.parse(this.now()) + 30000;
    const pending = {
      key: command.key,
      hash,
      principal,
      taskId: command.payload.taskId,
      runId: command.payload.runId,
      aborted: false,
      usageKey: undefined as string | undefined,
      authorityRevision: undefined as number | undefined,
      deadline,
      wallDeadline,
      expired: false,
      promise: Promise.resolve<CommandResult>({ outcome: 'blocked' }),
    };
    const cancelDeadline = (this.options.schedule ?? defaultSchedule)(() => {
      pending.expired = true;
      if (pending.usageKey && this.usageRead?.key === pending.usageKey)
        this.usageRead.abort.abort();
    }, 30000);
    const refuse = (result: CommandResult) => this.commitCommand(command, principal, result);
    const cancelled = (): CommandResult | undefined => {
      if (this.closed || pending.aborted)
        return { outcome: 'blocked', reason: 'acp-start-revoked' };
      if (
        pending.expired ||
        performance.now() >= deadline ||
        Date.parse(this.now()) >= wallDeadline
      )
        return { outcome: 'blocked', reason: 'acp-start-deadline' };
    };
    const promise = Promise.resolve().then(async () => {
      try {
        const stale = this.checkRevision(command);
        if (stale) return refuse(stale);
        const cancelledBefore = cancelled();
        if (cancelledBefore) return refuse(cancelledBefore);
        const task = this.store.get<Task>('task', command.payload.taskId),
          run = this.store.get<Run>('run', command.payload.runId);
        if (!task || !run || task.runId !== run.id)
          return refuse({ outcome: 'blocked', reason: 'run-not-current' });
        let binding: NativeBinding;
        try {
          binding = this.preparedNativeBinding(run);
        } catch {
          return refuse({ outcome: 'blocked', reason: 'native-preparation-unavailable' });
        }
        const appointment = binding.appointment;
        if (!('acp' in appointment))
          return refuse({ outcome: 'blocked', reason: 'native-preparation-unavailable' });
        const setup = this.store.googleAcpSetup();
        const quota = this.store.transaction(() => ({
          ...this.acpQuotaState(appointment.route.id, appointment.acp.modelId, run),
          blocker: this.store.googleOperationBlocker(),
        }));
        pending.authorityRevision = quota.reader.authority_revision;
        if (quota.blocker) return refuse({ outcome: 'blocked', reason: quota.blocker });
        if (quota.reserveReason)
          return refuse({
            outcome: 'blocked',
            reason: 'capacity-unavailable',
            next: quota.reserveReason,
          });
        if (quota.needsRefresh) {
          const cancelledRead = cancelled();
          if (cancelledRead) return refuse(cancelledRead);
          pending.usageKey = this.id('cmd');
          const child = CommandSchema.parse({
            protocol: 1,
            key: pending.usageKey,
            actor: command.actor,
            command: 'ObserveUsage',
            expectedRevision: 0,
            payload: { family: 'google' },
          }) as Extract<Command, { command: 'ObserveUsage' }>;
          const result = await this.observeUsageCommand(child, principal);
          const cancelledReadResult = cancelled();
          if (cancelledReadResult) return refuse(cancelledReadResult);
          if (!['applied', 'already-applied'].includes(result.outcome))
            return refuse({
              outcome: 'blocked',
              reason: result.reason ?? 'usage-read-failed',
              ...(result.next ? { next: result.next } : {}),
            });
        }
        const unchanged = (): CommandResult | undefined => {
          const revoked = cancelled();
          if (revoked) return revoked;
          const reader = this.store.googleUsageReader();
          if (reader.authority_revision !== quota.reader.authority_revision)
            return { outcome: 'blocked', reason: 'usage-read-revoked' };
          if (
            hashCanonical(this.store.googleAcpSetup()) !== hashCanonical(setup) ||
            hashCanonical(this.store.get<Task>('task', task.id)) !== hashCanonical(task) ||
            hashCanonical(this.store.get<Run>('run', run.id)) !== hashCanonical(run) ||
            hashCanonical(
              inspectSource(task.projectId, this.projectPath(task.projectId) as string),
            ) !== hashCanonical(run.source)
          )
            return { outcome: 'blocked', reason: 'acp-start-changed' };
          try {
            if (this.preparedNativeBinding(run).planArtifact.hash !== binding.planArtifact.hash)
              return { outcome: 'blocked', reason: 'acp-start-changed' };
          } catch {
            return { outcome: 'blocked', reason: 'native-preparation-unavailable' };
          }
          return cancelled();
        };
        const changed = unchanged();
        if (changed) return refuse(changed);
        const context = await captureContext(this.contextClient(), task.id);
        const changedContext = unchanged();
        if (changedContext) return refuse(changedContext);
        return this.commitCommand(command, principal, undefined, undefined, context);
      } catch {
        return refuse({ outcome: 'blocked', reason: 'acp-context-unavailable' });
      }
    });
    pending.promise = promise;
    this.acpStart = pending;
    return promise.finally(() => {
      cancelDeadline();
      if (this.acpStart === pending) this.acpStart = undefined;
    });
  }

  localPrepared(this: Controller, runId: string): LocalPrepared {
    const receipt = this.store.receipt(`local-prepared:${runId}`);
    const artifact = ArtifactSchema.parse(receipt?.result.entity);
    if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Local preparation exceeds its bound.');
    const plan = LocalPreparedSchema.parse(
      JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
    );
    if (plan.run.id !== runId) throw Error('Local preparation lineage changed.');
    return plan;
  }

  prepareLocal(
    this: Controller,
    command: Extract<Command, { command: 'PrepareNativeRun' }>,
  ): CommandResult {
    if (command.payload.profileId !== 'local-file-v1')
      return { outcome: 'unsupported', reason: 'native-profile-unavailable' };
    try {
      const blocker = this.store.localStartBlocker();
      if (blocker) return { outcome: 'blocked', reason: blocker };
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (task?.state !== 'draft') return { outcome: 'blocked', reason: 'task-not-preparable' };
      const gate = this.draftEditGate(task);
      if (gate) return gate;
      const connection = this.localConnection();
      if (
        !connection.connection ||
        !connection.facts.available ||
        !LocalObservedModelBindingSchema.safeParse(connection.facts.modelBinding).success
      )
        return { outcome: 'blocked', reason: 'local-model-unavailable' };
      const policy = PolicySchema.parse(command.payload.policy);
      if (
        policy.quality !== 'quick' ||
        policy.reserves.length ||
        (policy.methods?.length ?? 0) !== 1 ||
        policy.methods?.[0].id !== 'keep-it-simple' ||
        policy.methods[0].cycles !== 1 ||
        policy.limits.attempts < 3 ||
        policy.limits.concurrency !== 1 ||
        policy.unknownUsage.rule !== 'fixed-allowance' ||
        policy.unknownUsage.allowance.launches < 1 ||
        policy.unknownUsage.allowance.minutes < policy.limits.minutes
      )
        return { outcome: 'blocked', reason: 'local-policy-unavailable' };
      const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
      const files = committedFiles(this.projectPath(task.projectId) as string, source.base);
      const targetPath = command.payload.targetPath;
      const original = files.find((file) => file.path === targetPath);
      if (
        !original ||
        original.bytes > 65536 ||
        original.content.toString('utf8').includes('\0') ||
        !Buffer.from(original.content.toString('utf8')).equals(original.content)
      )
        return { outcome: 'blocked', reason: 'native-target-unavailable' };
      const runId = this.id('run');
      const grant = this.grant(
        { id: runId, taskId: task.id, policy: { policy, hash: hashCanonical(policy) } },
        'write-scratch',
        (this.store.get<Project>('project', task.projectId) as Project).name,
      );
      if (!grant) return { outcome: 'blocked', reason: 'scratch-grant-unavailable' };
      const context = { title: task.title, outcome: task.outcome, criteria: task.criteria };
      const manifest = files.map(({ content: _content, ...file }) => file);
      const target = { path: original.path, baseHash: original.hash };
      const localModel = LocalObservedModelBindingSchema.parse(connection.connection.modelBinding);
      const scopeHash = hashCanonical({
        profile: connection.facts,
        endpoint: connection.connection.endpoint,
        localModel,
        source,
        manifest,
        target,
        context,
        policy,
      });
      let expiresAt = grant.expiresAt;
      if (command.payload.consent === 'saved')
        expiresAt = new Date(
          Math.min(Date.parse(expiresAt), Date.parse(this.consentRecord(scopeHash).expiresAt)),
        ).toISOString();
      const route = RouteSchema.parse({
        id: this.id('rte'),
        family: 'local',
        displayName: connection.facts.displayName,
        model: localModel.modelKey,
        effort: { requested: 'unknown', effective: 'unknown', supported: [] },
        billing: 'local',
        qualified: false,
        fake: false,
      });
      const run = RunSchema.parse({
        id: runId,
        taskId: task.id,
        source,
        policy: { policy, hash: hashCanonical(policy) },
        roles: [{ role: 'coder', routeId: route.id, pinned: true, approvedFallbacks: [] }],
        decision: { chosen: route.id, rejected: [], rule: 'manual', inputsHash: scopeHash },
        revision: 0,
      });
      const attempt = this.jobAttempt(run, route.id);
      const plan = LocalPreparedSchema.parse({
        version: 1,
        kind: 'local-file',
        run,
        attempt,
        profile: connection.facts,
        endpoint: connection.connection.endpoint,
        localModel,
        target,
        manifest,
        context,
        scopeHash,
        expiresAt,
      });
      this.localStartInput(
        plan,
        original.content.toString('utf8'),
        files,
        this.localCredentials('unsubmitted'),
        300000,
      );
      const artifact = this.nativeArtifact(plan);
      this.store.put('route', route.id, 0, route);
      this.store.put('run', run.id, 0, run);
      this.store.putRunPurpose(run, 'execution', task.runId);
      for (const key of [
        `local-prepared:${run.id}`,
        `native-run:${run.id}`,
        `native-prepared:${run.id}`,
      ])
        this.store.saveReceipt(key, artifact.hash, 'local-owner', {
          outcome: 'applied',
          entity: artifact,
        });
      if (
        command.payload.consent === 'explicit' &&
        !this.store.receipt(`native-consent:${scopeHash}`)
      ) {
        const consent = this.nativeArtifact({ scopeHash, expiresAt });
        this.store.saveReceipt(`native-consent:${scopeHash}`, scopeHash, 'local-owner', {
          outcome: 'applied',
          entity: consent,
        });
      }
      const updated = this.updateTask(task, {
        runId: run.id,
        next: 'Review the Local file preparation and start. Qualification remains pending.',
      });
      this.event('run.prepared', task.id, updated.revision, run);
      return { outcome: 'applied', entity: run, revision: updated.revision };
    } catch {
      return { outcome: 'blocked', reason: 'local-preparation-unavailable' };
    }
  }

  localStartInput(
    this: Controller,
    plan: LocalPrepared,
    original: string,
    files: readonly FileContent[],
    credentials: ReturnType<Controller['localCredentials']>,
    timeoutMs: number,
  ): LocalStart {
    return localPlan({
      binding: {
        ...plan.localModel,
        attemptId: plan.attempt.id,
        generation: plan.attempt.generation,
        profileHash: hashCanonical(plan.profile),
        sourceHash: plan.scopeHash,
        path: plan.target.path,
        baseHash: plan.target.baseHash,
      },
      endpoint: plan.endpoint,
      ...credentials,
      original,
      task: plan.context,
      tests: localTests(plan.target.path, files),
      maximumOutputTokens: plan.profile.maximumOutputTokens,
      ...(plan.profile.reasoningBudgetTokens === undefined
        ? {}
        : { reasoningBudgetTokens: plan.profile.reasoningBudgetTokens }),
      timeoutMs,
    });
  }

  localWriterAuthority(this: Controller, plan: LocalPrepared, active = false) {
    const task = this.store.get<Task>('task', plan.run.taskId);
    const run = this.store.get<Run>('run', plan.run.id);
    const connection = this.localConnection();
    if (
      this.closed ||
      !task ||
      task.runId !== plan.run.id ||
      !run ||
      hashCanonical(run.policy) !== hashCanonical(plan.run.policy) ||
      hashCanonical(run.source) !== hashCanonical(plan.run.source) ||
      hashCanonical(run.roles) !== hashCanonical(plan.run.roles) ||
      hashCanonical({ title: task.title, outcome: task.outcome, criteria: task.criteria }) !==
        hashCanonical(plan.context) ||
      !connection.connection ||
      !connection.facts.available ||
      hashCanonical(connection.facts) !== hashCanonical(plan.profile) ||
      hashCanonical(connection.connection.modelBinding) !== hashCanonical(plan.localModel) ||
      connection.connection.endpoint !== plan.endpoint ||
      hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(plan.run.source)
    )
      throw Error('Local writer authority changed.');
    this.consentRecord(plan.scopeHash);
    if (Date.parse(plan.expiresAt) <= Date.parse(this.now())) throw Error('Local consent expired.');
    if (active) {
      const attempt = this.store.get<Attempt>('attempt', plan.attempt.id);
      const intent = this.store.intents().find((value) => value.attempt_id === plan.attempt.id);
      const lease = this.store.db
        .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
        .get(task.id);
      if (
        task.state !== 'running' ||
        !attempt ||
        attempt.runId !== run.id ||
        attempt.routeId !== plan.attempt.routeId ||
        attempt.generation !== plan.attempt.generation ||
        !['intent', 'running'].includes(attempt.state) ||
        !intent ||
        intent.run_id !== run.id ||
        intent.task_id !== task.id ||
        intent.route_id !== plan.attempt.routeId ||
        intent.generation !== plan.attempt.generation ||
        intent.state === 'stopped' ||
        lease?.attempt_id !== attempt.id ||
        lease.generation !== attempt.generation ||
        this.jobDeadline(attempt.id, Math.min(5, plan.run.policy.policy.limits.minutes)) <= 5000
      )
        throw Error('Local writer ownership changed.');
    }
    return { task, run };
  }

  startLocal(
    this: Controller,
    command: Extract<Command, { command: 'StartRun' }>,
    effects: (() => void)[],
  ): CommandResult {
    try {
      const plan = this.localPrepared(command.payload.runId);
      const { task, run } = this.localWriterAuthority(plan);
      if (
        task.id !== command.payload.taskId ||
        task.state !== 'draft' ||
        this.store.intents().some((intent) => intent.run_id === run.id)
      )
        return { outcome: 'blocked', reason: 'run-not-current' };
      const blocker = this.store.localStartBlocker();
      if (blocker) return { outcome: 'blocked', reason: blocker };
      const remaining = this.remaining(run);
      const timeoutMs = Math.floor(
        Math.min(
          300000,
          remaining.minutes * 60000,
          Date.parse(plan.expiresAt) - Date.parse(this.now()),
        ),
      );
      if (!remaining.attempts || !remaining.concurrency || timeoutMs <= 5000)
        return { outcome: 'blocked', reason: 'budget-exhausted' };
      const project = this.store.get<Project>('project', task.projectId) as Project;
      const grant = this.grant(run, 'write-scratch', project.name);
      if (!grant) return { outcome: 'blocked', reason: 'scratch-grant-unavailable' };
      const directory = join(this.home, 'scratch', run.id);
      this.admitJob(run, plan.attempt, directory, Math.ceil(timeoutMs / 60000));
      this.consumeGrant(run, grant);
      this.store.saveReceipt(`allocation:${run.id}`, plan.scopeHash, 'local-owner', {
        outcome: 'applied',
        entity: run,
      });
      const updated = this.updateTask(task, {
        state: 'running',
        waitingReason: null,
        next: 'The owned Local file turn is running.',
      });
      this.event('run.admitted', task.id, updated.revision, run);
      this.pendingLocalLaunches.add(plan.attempt.id);
      effects.push(() => {
        this.pendingLocalLaunches.delete(plan.attempt.id);
        if (this.closed) return;
        const intent = this.store.intents().find((value) => value.attempt_id === plan.attempt.id);
        if (!intent) throw Error('Local launch intent is unavailable.');
        if (intent.state === 'stopped') return;
        this.options.afterIntent?.(intent);
        this.launchLocalWriter(plan, timeoutMs);
      });
      return { outcome: 'applied', entity: updated, revision: updated.revision };
    } catch {
      return { outcome: 'blocked', reason: 'local-start-unavailable' };
    }
  }

  launchLocalWriter(this: Controller, plan: LocalPrepared, maximumMs: number) {
    const completion = Promise.withResolvers<void>();
    const binding = {
      ...plan.localModel,
      attemptId: plan.attempt.id,
      generation: plan.attempt.generation,
      profileHash: hashCanonical(plan.profile),
      sourceHash: plan.scopeHash,
      path: plan.target.path,
      baseHash: plan.target.baseHash,
    };
    const runtime: LocalWriterRuntime = { plan, binding, stopped: false, done: completion.promise };
    this.localWriters.set(plan.attempt.id, runtime);
    const current = () => {
      if (runtime.stopped) throw Error('Local writer stopped.');
      this.localWriterAuthority(plan, true);
    };
    const finish = async (
      outcome: Awaited<ReturnType<typeof startLocalReplacement>['result']> | null,
    ) => {
      try {
        const phases = this.store.nativeProcesses(plan.attempt.id);
        const terminal = outcome ? LocalTerminalSchema.parse(outcome.terminal) : null;
        const bound =
          terminal &&
          hashCanonical(terminal.binding) === hashCanonical(binding) &&
          (!('proof' in terminal) ||
            terminal.proof === null ||
            terminal.proof.maxTokens === plan.profile.maximumOutputTokens);
        const configurationFailed =
          bound && terminal && 'reason' in terminal && terminal.reason === 'configuration';
        const clientQuiescent =
          outcome?.clientQuiescent === true &&
          phases.length > 0 &&
          phases.every((phase) => phase.state === 'quiescent');
        const submitted = !!this.store.receipt(`native-submission:${plan.attempt.id}`);
        const unspawned = !runtime.handle && phases.length === 0;
        const terminalKnown =
          !!bound &&
          terminal.kind !== 'unknown' &&
          (terminal.kind === 'completed' ||
            terminal.kind === 'stopped' ||
            terminal.proof !== null ||
            !submitted);
        const known =
          unspawned ||
          (clientQuiescent &&
            terminalKnown &&
            this.store.nativePhasesComplete(plan.attempt.id, 'local'));
        const missingFinalAnswer =
          known &&
          clientQuiescent &&
          bound &&
          terminal.kind === 'failed' &&
          terminal.reason === 'protocol' &&
          (terminal.proof?.structured?.reasoningBytes ?? 0) > 0 &&
          terminal.proof?.structured?.nonReasoningBytes === 0;
        this.store.transaction(() => {
          const proof = this.nativeArtifact({
            attemptId: plan.attempt.id,
            bindingHash: hashCanonical(binding),
            terminal,
            clientQuiescent: clientQuiescent || unspawned,
            known,
            unspawned,
            at: this.now(),
          });
          this.store.saveReceipt(`local-terminal:${plan.attempt.id}`, proof.hash, 'local-owner', {
            outcome: known ? 'applied' : 'outcome-unknown',
            entity: proof,
          });
        });
        let applied = false;
        if (
          known &&
          bound &&
          terminal.kind === 'completed' &&
          submitted &&
          !runtime.stopped &&
          !this.closed
        ) {
          try {
            current();
            if (
              terminal.proposal.attemptId !== plan.attempt.id ||
              terminal.proposal.path !== plan.target.path ||
              terminal.proposal.baseHash !== plan.target.baseHash
            )
              throw Error('Local replacement changed.');
            this.store.transaction(() => {
              current();
              const proof = this.nativeArtifact({
                attemptId: plan.attempt.id,
                terminalHash: this.nativeRecord(`local-terminal:${plan.attempt.id}`).artifact.hash,
                manifest: plan.manifest,
              });
              this.store.saveReceipt(
                `native-application:${plan.attempt.id}`,
                proof.hash,
                'local-owner',
                { outcome: 'outcome-unknown', entity: proof },
              );
            });
            current();
            applyReplacement(
              join(this.home, 'scratch', plan.run.id),
              plan.manifest,
              terminal.proposal,
            );
            this.store.transaction(() => {
              const prior = this.store.receipt(`native-application:${plan.attempt.id}`);
              this.store.db
                .prepare('UPDATE receipts SET result=? WHERE command_key=?')
                .run(
                  canonicalJson({ outcome: 'applied', entity: prior?.result.entity }),
                  `native-application:${plan.attempt.id}`,
                );
            });
            applied = true;
          } catch {}
        }
        if (applied) await this.formatAttempt(plan.attempt);
        // Without terminal proof the outcome stays unknown. When every recorded group is gone
        // the writer holds nothing, so it settles as unknown and releases the lease.
        const intent = this.store.intents().find((value) => value.attempt_id === plan.attempt.id);
        const closed = known || !intent ? undefined : this.shutdownProof(intent);
        if (intent && closed) {
          this.store.transaction(() =>
            this.settleUnknownWriter(
              intent,
              closed,
              'Every recorded process group exited and Local recorded no matching terminal.',
              configurationFailed ? 'Local settings could not be verified. ' : '',
            ),
          );
          this.localWriters.delete(plan.attempt.id);
        } else if (
          this.settleJob(
            plan.attempt,
            known,
            true,
            () => {
              const task = this.store.get<Task>('task', plan.run.taskId) as Task;
              if (task.runId === plan.run.id)
                this.updateTask(task, {
                  state: 'stopped',
                  waitingReason: null,
                  next: applied
                    ? 'Local replacement retained. Prepare separate checks and review before acceptance.'
                    : configurationFailed
                      ? 'Local settings could not be verified. No replacement was applied.'
                      : missingFinalAnswer
                        ? 'Local returned no final answer. No replacement was applied. Check the model settings.'
                        : 'Local work stopped without an applied replacement.',
                });
            },
            configurationFailed
              ? 'Local settings could not be verified. Execution ownership is unknown. Checks and publication are blocked.'
              : undefined,
          )
        ) {
          if (applied) this.sealCandidate(plan.attempt);
          this.localWriters.delete(plan.attempt.id);
        }
      } catch {
        try {
          this.settleJob(plan.attempt, false, true);
        } catch {}
      } finally {
        completion.resolve();
      }
    };
    try {
      current();
      const sourceFiles = committedFiles(
        this.projectPath(plan.run.source.projectId) as string,
        plan.run.source.base,
      );
      if (
        hashCanonical(sourceFiles.map(({ content: _content, ...file }) => file)) !==
        hashCanonical(plan.manifest)
      )
        throw Error('Local source manifest changed.');
      const original = sourceFiles.find((file) => file.path === plan.target.path);
      if (!original || original.hash !== plan.target.baseHash) throw Error('Local target changed.');
      const directory = join(this.home, 'scratch', plan.run.id);
      materialize(directory, sourceFiles);
      {
        const input = this.localStartInput(
          plan,
          original.content.toString('utf8'),
          sourceFiles,
          this.localCredentials(),
          Math.floor(
            Math.min(
              maximumMs,
              this.jobDeadline(plan.attempt.id, Math.ceil(maximumMs / 60000)),
              Date.parse(plan.expiresAt) - Date.parse(this.now()),
            ),
          ),
        );
        const journal = this.nativeLifecycle(plan.attempt, current);
        const phase = { sequence: 0, kind: 'native-task' as const };
        runtime.handle = startLocalReplacement(input, directory, {
          ...this.options.localWriter,
          schedule: this.options.schedule,
          onSubmitted: () => {
            current();
            this.store.transaction(() => {
              current();
              const proof = this.nativeArtifact({
                attemptId: plan.attempt.id,
                bindingHash: hashCanonical(binding),
                scopeHash: plan.scopeHash,
              });
              this.store.saveReceipt(
                `native-submission:${plan.attempt.id}`,
                proof.hash,
                'local-owner',
                { outcome: 'outcome-unknown', entity: proof },
              );
            });
            return undefined;
          },
          lifecycle: {
            beforePhase: () => {
              journal.beforePhase(phase);
            },
            owned: (_kind, group) => {
              journal.owned(phase, group);
            },
            quiescent: (_kind, group) => {
              journal.quiescent(phase, group);
            },
          },
        });
      }
      if (runtime.stopped || this.closed) runtime.handle?.stop();
      void runtime.handle?.result.then(finish, () => finish(null));
    } catch {
      void finish(null);
    }
  }

  prepareNative(
    this: Controller,
    command: Extract<Command, { command: 'PrepareNativeRun' }>,
    maximumMinutes?: number,
  ): CommandResult {
    if (command.payload.profileId === 'local-file-v1') return this.prepareLocal(command);
    if (command.payload.profileId === 'google-acp-v1')
      return this.prepareAcp(command, maximumMinutes);
    let plan: Omit<NativeBinding, 'planArtifact'>;
    let expiresAt: string;
    let manualTargets: z.infer<typeof NativeManualRosterSchema>['targets'] | undefined;
    try {
      const profile = this.profileFor(command.payload.profileId);
      const facts = NativeProfileSchema.parse(profile.facts);
      if (facts.family === 'local' || !('creditPolicy' in command.payload))
        return {
          outcome: 'unsupported',
          reason: 'native-profile-unavailable',
          next: 'Local native launch is unavailable.',
        };
      const creditPolicy = command.payload.creditPolicy;
      if (facts.reason === 'provider-policy-restricted') return nativeProviderRestriction;
      if (
        !facts.available ||
        !profile.client ||
        !profile.environment ||
        !profile.locationHash ||
        facts.id !== command.payload.profileId ||
        !facts.creditPolicies.some((policy) => policy === creditPolicy)
      )
        return {
          outcome: 'blocked',
          reason: 'native-profile-unavailable',
          next: 'Use the supported installed client and native account location.',
        };
      const filePayload = 'targetPath' in command.payload ? command.payload : undefined;
      const billingAttestation = filePayload?.billingAttestation;
      const permissionMode = filePayload?.permissionMode;
      if ((facts.family !== 'openai') !== !!billingAttestation)
        throw Error('The subscription billing attestation is unavailable.');
      if (
        (facts.family === 'google') !== !!permissionMode ||
        (facts.family === 'google' &&
          (!permissionMode || !facts.permissionModes.includes(permissionMode)))
      )
        throw Error('The native permission mode is unavailable.');
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (task?.state !== 'draft') return { outcome: 'blocked', reason: 'task-not-preparable' };
      const gate = this.draftEditGate(task);
      if (gate) return gate;
      const modelRequest =
        'modelRequest' in command.payload ? command.payload.modelRequest : undefined;
      const modelSelection =
        command.payload.profileId === 'openai-repository-v1'
          ? this.openAiProjectSelection(task.id, profile, modelRequest)
          : undefined;
      const source = inspectSource(task.projectId, this.projectPath(task.projectId) as string);
      const files = committedFiles(this.projectPath(task.projectId) as string, source.base);
      const original = filePayload
        ? files.find((file) => file.path === filePayload.targetPath)
        : undefined;
      if (filePayload && !original) throw Error('Target is unavailable.');
      const scope = original
        ? { target: { path: original.path, baseHash: original.hash } }
        : {
            repository: this.repositoryScope(source.base, files),
            execution: NativeRepositoryExecutionSchema.parse(
              'execution' in facts ? facts.execution : null,
            ),
          };
      const policy = PolicySchema.parse(command.payload.policy);
      if (filePayload && 'handoffTargets' in filePayload && filePayload.handoffTargets) {
        if (command.payload.consent !== 'explicit')
          throw Error('A new manual recipient roster needs explicit consent.');
        manualTargets = this.nativeManualTargets(filePayload.handoffTargets);
        if (!manualTargets.some(({ target }) => target.profileId !== facts.id))
          throw Error('Choose a different manual recipient.');
        const reviewCycles = (policy.methods ?? []).reduce((sum, method) => sum + method.cycles, 0);
        if (
          (policy.methods ?? []).length !== 1 ||
          policy.methods?.[0].cycles !== 1 ||
          policy.limits.attempts < reviewCycles + 3 ||
          policy.unknownUsage.rule !== 'fixed-allowance' ||
          policy.unknownUsage.allowance.launches < 2 ||
          policy.unknownUsage.allowance.minutes < policy.limits.minutes
        )
          throw Error('The manual handoff policy lacks original allowance and review headroom.');
      }
      const runId = this.id('run');
      const project = this.store.get<Project>('project', task.projectId) as Project;
      const writeGrant = this.grant(
        { id: runId, taskId: task.id, policy: { policy, hash: hashCanonical(policy) } },
        'write-scratch',
        project.name,
      );
      if (!writeGrant) throw Error('The native proposal needs a live scratch grant.');
      const toolsGrant = !filePayload
        ? this.grant(
            { id: runId, taskId: task.id, policy: { policy, hash: hashCanonical(policy) } },
            'run-native-tools',
            project.name,
          )
        : undefined;
      if (!filePayload && !toolsGrant)
        throw Error('Repository work needs a live native-tool grant.');
      expiresAt = toolsGrant
        ? new Date(
            Math.min(Date.parse(writeGrant.expiresAt), Date.parse(toolsGrant.expiresAt)),
          ).toISOString()
        : writeGrant.expiresAt;
      const context = { title: task.title, outcome: task.outcome };
      const scopeHash = hashCanonical({
        profile: facts,
        client: profile.client,
        locationHash: profile.locationHash,
        projectId: task.projectId,
        source,
        ...(original ? { target: { path: original.path, hash: original.hash } } : scope),
        context,
        criteria: task.criteria,
        policy,
        creditPolicy: command.payload.creditPolicy,
        ...(modelRequest ? { modelRequest } : {}),
        ...(billingAttestation ? { billingAttestation: billingAttestation } : {}),
        ...(permissionMode ? { permissionMode: permissionMode } : {}),
        ...(manualTargets ? { manualTargets } : {}),
      });
      if (command.payload.consent === 'saved')
        expiresAt = new Date(
          Math.min(Date.parse(expiresAt), Date.parse(this.consentRecord(scopeHash).expiresAt)),
        ).toISOString();
      const savedRoute = this.nativeProfileRoute(
        profile,
        command.payload.creditPolicy,
        modelRequest,
        modelRequest ? modelSelection : undefined,
      );
      const appointment = freezeNative(
        NativeAppointmentSchema.parse({
          id: command.key.replaceAll('_', '-'),
          taskId: task.id,
          route: manualTargets?.find(
            ({ target }) => target.profileId === facts.id && target.creditPolicy === creditPolicy,
          )?.route ??
            savedRoute ?? {
              id: this.id('rte'),
              family: facts.family,
              displayName: facts.displayName,
              model: modelSelection?.model ?? facts.model,
              effort: {
                requested: modelSelection?.effort ?? facts.effort,
                effective:
                  facts.family === 'openai' ? (modelSelection?.effort ?? facts.effort) : 'unknown',
                supported: [modelSelection?.effort ?? facts.effort],
              },
              billing: command.payload.creditPolicy === 'ordinary' ? 'included' : 'credits',
              qualified: false,
              fake: false,
            },
          client: profile.client,
          creditPolicy: command.payload.creditPolicy,
          ...(billingAttestation ? { billingAttestation: billingAttestation } : {}),
          ...(permissionMode ? { permissionMode: permissionMode } : {}),
          ...scope,
          ...(modelRequest ? { modelRequest } : {}),
          consent: {
            nativeTrust: 'accepted',
            source: command.payload.consent === 'explicit' ? 'explicit' : 'policy',
            policyHash: hashCanonical(policy),
            sourceBase: source.base,
            criteriaHash: hashCanonical(task.criteria),
          },
          policy,
          expiresAt,
          // A repository writer leaves the eleven minutes a verify check and review need, and
          // never drops below five. Start requires those eleven minutes behind a writer longer than
          // five minutes and lets a five-minute writer start with its own five. File profiles
          // stop at five minutes.
          maximumTaskMs: Math.min(
            facts.maximumTaskMs,
            (maximumMinutes ?? Math.max(5, policy.limits.minutes - evaluationFloorMinutes)) * 60000,
          ),
          maximumSubmissions: facts.maximumSubmissions,
        }),
      );
      const publicScope = {
        profileId: facts.id,
        locationHash: profile.locationHash,
        scopeHash,
        ...(manualTargets ? { manualTargetsHash: hashCanonical(manualTargets) } : {}),
        context,
      };
      plan = this.planNativeAppointment(appointment, publicScope, runId);
      if (this.store.receipt(`native-consent:${scopeHash}`)) this.consentRecord(scopeHash);
    } catch {
      return {
        outcome: 'blocked',
        reason: 'native-preparation-unavailable',
        next: 'Review the target, native trust, source consent and policy bounds.',
      };
    }
    const binding = this.saveNativePlan(plan);
    if (manualTargets) {
      this.store.saveReceipt(
        `native-attempt-plan:${binding.attempt.id}`,
        hashCanonical(binding.appointment),
        'local-owner',
        { outcome: 'applied', entity: binding.planArtifact },
      );
      const roster = this.nativeArtifact(
        NativeManualRosterSchema.parse({
          runId: binding.run.id,
          targets: manualTargets,
        }),
      );
      this.store.saveReceipt(
        `native-handoff-roster:${binding.run.id}`,
        roster.hash,
        'local-owner',
        {
          outcome: 'applied',
          entity: roster,
        },
      );
    }
    const { scopeHash } = plan.public as z.infer<typeof NativePublicScopeSchema>;
    const task = this.store.get<Task>('task', command.payload.taskId) as Task;
    const publicScope = plan.public;
    if (
      command.payload.consent === 'explicit' &&
      !this.store.receipt(`native-consent:${scopeHash}`)
    ) {
      const artifact = this.nativeArtifact({ scopeHash, expiresAt });
      this.store.saveReceipt(`native-consent:${scopeHash}`, scopeHash, 'local-owner', {
        outcome: 'applied',
        entity: artifact,
      });
    }
    this.store.saveReceipt(
      `native-prepared:${binding.run.id}`,
      hashCanonical(publicScope),
      'local-owner',
      { outcome: 'applied', entity: binding.planArtifact },
    );
    const updated = this.updateTask(this.store.get<Task>('task', task.id) as Task, {
      next: 'Review the native preparation and start. Checks and acceptance remain pending.',
    });
    this.event('run.prepared', task.id, updated.revision, binding.run);
    return { outcome: 'applied', entity: binding.run, revision: updated.revision };
  }
}
