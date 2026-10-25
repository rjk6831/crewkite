import { join } from 'node:path';
import {
  ArtifactSchema,
  type Attempt,
  AttemptSchema,
  CandidateSchema,
  type Command,
  type CommandResult,
  type ConversationModelRequest,
  canonicalJson,
  HashSchema,
  MAX_FRAME_BYTES,
  NativeHandoffPreviewSchema,
  NativeHandoffTargetsSchema,
  NativeRunSchema,
  type Project,
  type Route,
  RouteSchema,
  type Run,
  type Task,
  TimestampSchema,
} from '@crewkite/contracts';
import { hashCanonical, verifyHandoff } from '@crewkite/contracts/hash';
import { z } from 'zod';
import { committedFiles, inspectSource, readFiles } from '../host/source.ts';
import {
  type RetainedOpenAiModelObservation,
  resolveOpenAiProjectSelection,
} from '../providers/openai/execution-selection.ts';
import type { NativeProfileResolution } from '../providers/openai/profile.ts';
import type { Controller } from './controller.ts';
import {
  NativeAppointmentSchema,
  type NativeBinding,
  NativeFileAppointmentSchema,
  NativeHistoricalPreparationSchema,
  NativeManualLinkSchema,
  NativeManualPreparationSchema,
  NativeManualRosterSchema,
  type NativePilotAppointment,
  NativePreparationSchema,
  NativePublicScopeSchema,
} from './schemas.ts';

// Native run previews, manual file handoff, consent records and profile routes.
export class NativeRunCommands {
  nativeRuns(this: Controller, runIds?: ReadonlySet<string>): z.infer<typeof NativeRunSchema>[] {
    return (runIds ? this.store.byIds<Run>('run', runIds) : this.store.list<Run>('run')).flatMap(
      (run) => {
        const origin = this.store.receipt(this.currentNativePlanKey(run.id));
        if (!origin) return [];
        const prepared = this.store.receipt(`native-prepared:${run.id}`);
        if (this.store.receipt(`local-prepared:${run.id}`)) {
          try {
            const plan = this.localPrepared(run.id);
            return [
              NativeRunSchema.parse({
                runId: run.id,
                profileId: 'local-file-v1',
                stage:
                  prepared &&
                  this.store.get<Task>('task', run.taskId)?.runId === run.id &&
                  this.store.get<Task>('task', run.taskId)?.state === 'draft' &&
                  !this.store.intents().some((intent) => intent.run_id === run.id)
                    ? 'prepared'
                    : 'retain-only',
                expiresAt: plan.expiresAt,
                localModel: plan.localModel,
                target: {
                  ...plan.target,
                  bytes: plan.manifest.find((file) => file.path === plan.target.path)?.bytes,
                },
              }),
            ];
          } catch {
            return [
              {
                runId: run.id,
                profileId: 'unavailable-native-plan',
                stage: 'retain-only' as const,
              },
            ];
          }
        }
        try {
          const artifact = ArtifactSchema.parse(origin.result.entity);
          if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Native plan exceeds its bound.');
          const plan = JSON.parse(this.artifacts.read(artifact.hash).toString('utf8'));
          const appointment = NativeAppointmentSchema.parse(plan.appointment);
          const publicScope = NativePublicScopeSchema.safeParse(plan.public).data;
          const handoff = this.nativeHandoffPreview(run);
          const quotaRetry = this.quotaRetryPreview(run);
          return [
            NativeRunSchema.parse({
              runId: run.id,
              profileId: publicScope?.profileId ?? 'private-native-file',
              stage:
                prepared &&
                this.store.get<Task>('task', run.taskId)?.runId === run.id &&
                this.store.get<Task>('task', run.taskId)?.state === 'draft' &&
                publicScope &&
                !this.store.intents().some((intent) => intent.run_id === run.id)
                  ? 'prepared'
                  : 'retain-only',
              expiresAt: appointment.expiresAt,
              maximumTaskMs: appointment.maximumTaskMs,
              ...(quotaRetry ? { quotaRetry } : {}),
              ...(handoff ? { handoff } : {}),
              ...(appointment.billingAttestation
                ? { billingAttestation: appointment.billingAttestation }
                : {}),
              ...(appointment.permissionMode ? { permissionMode: appointment.permissionMode } : {}),
              ...('acp' in appointment
                ? {
                    acp: appointment.acp,
                    ...(appointment.contextLines === undefined
                      ? {}
                      : { contextLines: appointment.contextLines }),
                  }
                : {}),
              ...('repository' in appointment
                ? {
                    repository: appointment.repository,
                    execution: appointment.execution,
                    ...(appointment.modelRequest ? { modelRequest: appointment.modelRequest } : {}),
                  }
                : {
                    target: {
                      path: appointment.target.path,
                      baseHash: appointment.target.baseHash,
                      bytes: plan.manifest.find(
                        (file: { path: string }) => file.path === appointment.target.path,
                      )?.bytes,
                    },
                  }),
            }),
          ];
        } catch {
          return [
            { runId: run.id, profileId: 'unavailable-native-plan', stage: 'retain-only' as const },
          ];
        }
      },
    );
  }

  nativeManualTargets(this: Controller, targets: z.infer<typeof NativeHandoffTargetsSchema>) {
    return NativeHandoffTargetsSchema.parse(targets).map((target) => {
      const profile = this.profileFor(target.profileId);
      if (
        profile.facts.family === 'local' ||
        !profile.facts.available ||
        !profile.client ||
        !profile.locationHash ||
        !profile.environment ||
        !profile.facts.creditPolicies.some((policy) => policy === target.creditPolicy)
      )
        throw Error('The manual recipient is unavailable.');
      const route =
        this.nativeProfileRoute(profile, target.creditPolicy) ??
        RouteSchema.parse({
          id: this.id('rte'),
          family: profile.facts.family,
          displayName: profile.facts.displayName,
          model: profile.facts.model,
          effort: {
            requested: profile.facts.effort,
            effective: profile.facts.family === 'openai' ? profile.facts.effort : 'unknown',
            supported: [profile.facts.effort],
          },
          billing: target.creditPolicy === 'ordinary' ? 'included' : 'credits',
          qualified: false,
          fake: false,
        });
      return {
        target,
        profile: profile.facts,
        client: profile.client,
        locationHash: profile.locationHash,
        route,
      };
    });
  }

  nativeManualRoster(this: Controller, run: Run) {
    const origin = NativeHistoricalPreparationSchema.parse(
      this.nativeRecord(`native-run:${run.id}`).value,
    );
    const roster = NativeManualRosterSchema.parse(
      this.nativeRecord(`native-handoff-roster:${run.id}`).value,
    );
    if (
      roster.runId !== run.id ||
      !origin.public?.manualTargetsHash ||
      hashCanonical(roster.targets) !== origin.public.manualTargetsHash ||
      hashCanonical(origin.run.source) !== hashCanonical(run.source) ||
      hashCanonical(origin.run.policy) !== hashCanonical(run.policy) ||
      hashCanonical(origin.run.roles) !== hashCanonical(run.roles)
    )
      throw Error('authority-unavailable');
    return roster;
  }

  currentNativePlanKey(this: Controller, runId: string) {
    return this.store.receipt(`native-current:${runId}`)
      ? `native-current:${runId}`
      : `native-run:${runId}`;
  }

  writerScratch(this: Controller, run: Run) {
    if (this.store.receipt(`native-current:${run.id}`)) {
      const plan = this.nativeCurrentPlan(run);
      const intent = this.store
        .intents()
        .find((value) => value.attempt_id === plan.attempt.id && value.run_id === run.id);
      if (!intent) throw Error('The current native writer intent is unavailable.');
      return intent.scratch_path;
    }
    return join(this.home, 'scratch', run.id);
  }

  nativeManualAuthority(this: Controller, binding: NativeBinding, consumed: boolean) {
    const link = NativeManualLinkSchema.parse(binding.handoff);
    const { preparation } = link;
    const record = this.nativeRecord(`native-handoff-prepared:${link.preparationId}`);
    const stored = NativeManualPreparationSchema.parse(record.value);
    const run = this.store.get<Run>('run', binding.run.id);
    const task = run && this.store.get<Task>('task', run.taskId);
    const project = run && this.store.get<Project>('project', run.source.projectId);
    if (
      !run ||
      !task ||
      !project ||
      task.runId !== run.id ||
      record.artifact.id !== link.preparationId ||
      hashCanonical(stored) !== hashCanonical(preparation) ||
      preparation.runId !== run.id ||
      preparation.candidate.taskId !== task.id ||
      preparation.attemptId !== binding.attempt.id ||
      preparation.generation !== binding.attempt.generation ||
      preparation.route.id !== binding.attempt.routeId ||
      hashCanonical(preparation.route) !== hashCanonical(binding.appointment.route) ||
      preparation.authority.policyHash !== run.policy.hash ||
      preparation.authority.criteriaHash !== hashCanonical(task.criteria) ||
      preparation.authority.target !== project.name ||
      Date.parse(preparation.authority.expiresAt) <= Date.parse(this.now()) ||
      !this.grant(run, 'write-scratch', project.name) ||
      Buffer.byteLength(canonicalJson(preparation.packet)) > 65536 ||
      !verifyHandoff(preparation.packet) ||
      preparation.packet.packet.attemptId !== preparation.fromAttemptId ||
      preparation.packet.packet.generation + 1 !== preparation.generation ||
      hashCanonical(preparation.packet.packet.source) !== hashCanonical(run.source) ||
      hashCanonical(preparation.packet.packet.policy) !== hashCanonical(run.policy) ||
      hashCanonical(preparation.packet.packet.candidate) !== hashCanonical(preparation.candidate) ||
      preparation.packet.packet.allowedRouteIds.length !== 1 ||
      preparation.packet.packet.allowedRouteIds[0] !== preparation.route.id
    )
      throw Error('The exact manual handoff authority is unavailable.');
    const roster = this.nativeManualRoster(run);
    if (
      !roster.targets.some(
        (entry) =>
          hashCanonical(entry.target) === hashCanonical(preparation.recipient) &&
          hashCanonical(entry.route) === hashCanonical(preparation.route) &&
          hashCanonical(entry.profile) === hashCanonical(preparation.profile) &&
          hashCanonical(entry.client) === hashCanonical(preparation.client) &&
          entry.locationHash === preparation.locationHash,
      )
    )
      throw Error('The manual recipient is outside the initial roster.');
    const used = this.store.receipt(`native-handoff-consumed:${binding.attempt.id}`);
    if (
      consumed
        ? used?.hash !== record.artifact.hash
        : !!used ||
          this.store.receipt(`native-handoff-pending:${run.id}`)?.hash !== record.artifact.hash
    )
      throw Error('The manual handoff authority was consumed or replaced.');
    return preparation;
  }

  nativeManualHistory(this: Controller, plan: z.infer<typeof NativeHistoricalPreparationSchema>) {
    if (!plan.handoff) return;
    const { preparationId, preparation } = plan.handoff;
    const record = this.nativeRecord(`native-handoff-prepared:${preparationId}`);
    const consumed = this.store.receipt(`native-handoff-consumed:${plan.attempt.id}`);
    const preceding = this.store.get<Attempt>('attempt', preparation.fromAttemptId);
    const previous = NativeHistoricalPreparationSchema.parse(
      this.nativeRecord(`native-attempt-plan:${preparation.fromAttemptId}`).value,
    );
    const retained = this.evidence.read(preparation.candidate);
    const target = retained.files.find((file) => file.path === preparation.target.path);
    if (
      'repository' in plan.appointment ||
      !preceding ||
      preceding.state !== 'stopped' ||
      previous.attempt.id !== preceding.id ||
      preceding.generation + 1 !== plan.attempt.generation ||
      preparation.generation !== plan.attempt.generation ||
      preparation.attemptId !== plan.attempt.id ||
      preparation.runId !== plan.run.id ||
      preceding.runId !== plan.run.id ||
      hashCanonical(previous.run.source) !== hashCanonical(plan.run.source) ||
      hashCanonical(previous.run.policy) !== hashCanonical(plan.run.policy) ||
      hashCanonical(previous.run.roles) !== hashCanonical(plan.run.roles) ||
      record.artifact.id !== preparationId ||
      consumed?.hash !== record.artifact.hash ||
      hashCanonical(record.value) !== hashCanonical(preparation) ||
      Buffer.byteLength(canonicalJson(preparation.packet)) > 65536 ||
      !verifyHandoff(preparation.packet) ||
      preparation.packet.packet.attemptId !== preceding.id ||
      hashCanonical(preparation.packet.packet.candidate) !== hashCanonical(preparation.candidate) ||
      hashCanonical(preparation.packet.packet.source) !== hashCanonical(plan.run.source) ||
      hashCanonical(preparation.packet.packet.policy) !== hashCanonical(plan.run.policy) ||
      this.store.receipt(`candidate:${preceding.id}`)?.hash !== preparation.candidate.hash ||
      !this.store.nativeProcesses(preceding.id).length ||
      this.store.nativeProcesses(preceding.id).some((phase) => phase.state !== 'quiescent') ||
      !target ||
      target.hash !== preparation.target.baseHash ||
      target.bytes !== preparation.target.bytes ||
      target.path !== plan.appointment.target.path ||
      target.hash !== plan.originalHash ||
      target.hash !== plan.appointment.target.baseHash ||
      hashCanonical(retained.files.map(({ content: _content, ...file }) => file)) !==
        hashCanonical(plan.manifest) ||
      hashCanonical(preparation.route) !== hashCanonical(plan.appointment.route)
    )
      throw Error('Manual handoff evidence changed.');
    const roster = this.nativeManualRoster(plan.run);
    if (
      !roster.targets.some(
        (entry) =>
          hashCanonical(entry.target) === hashCanonical(preparation.recipient) &&
          hashCanonical(entry.route) === hashCanonical(plan.appointment.route),
      )
    )
      throw Error('Manual handoff recipient changed.');
  }

  startNativeHandoff(
    this: Controller,
    command: Extract<Command, { command: 'StartNativeHandoff' }>,
    effects: (() => void)[],
  ): CommandResult {
    let binding: Omit<NativeBinding, 'planArtifact'>;
    try {
      const run = this.store.get<Run>('run', command.payload.runId);
      const task = this.store.get<Task>('task', command.payload.taskId);
      if (!run || !task || run.taskId !== task.id || task.runId !== run.id)
        throw Error('Run changed.');
      const gate = this.nativeHandoffGate(run);
      if (!gate.available) throw Error('Handoff is unavailable.');
      const record = this.nativeRecord(`native-handoff-prepared:${command.payload.preparationId}`);
      if (
        record.artifact.id !== command.payload.preparationId ||
        this.store.receipt(`native-handoff-pending:${run.id}`)?.hash !== record.artifact.hash
      )
        throw Error('Preparation changed.');
      const preparation = NativeManualPreparationSchema.parse(record.value);
      const current = this.nativeCurrentPlan(run);
      if (
        preparation.runId !== run.id ||
        preparation.fromAttemptId !== current.attempt.id ||
        preparation.generation !== current.attempt.generation + 1 ||
        current.public?.profileId === preparation.recipient.profileId
      )
        throw Error('Predecessor changed.');
      const profile = this.profileFor(preparation.recipient.profileId);
      if (
        !profile.facts.available ||
        !profile.environment ||
        hashCanonical(profile.facts) !== hashCanonical(preparation.profile) ||
        hashCanonical(profile.client) !== hashCanonical(preparation.client) ||
        profile.locationHash !== preparation.locationHash
      )
        throw Error('Recipient changed.');
      if (
        hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(run.source)
      )
        throw Error('Source changed.');
      const prior = this.store
        .intents()
        .find((value) => value.attempt_id === preparation.fromAttemptId);
      if (
        !prior ||
        this.evidence.hash(run.source.base, readFiles(prior.scratch_path)) !==
          preparation.candidate.hash
      )
        throw Error('Retained work changed.');
      const files = this.evidence.read(preparation.candidate).files;
      const original = files.find((file) => file.path === preparation.target.path);
      if (
        !original ||
        original.hash !== preparation.target.baseHash ||
        original.bytes !== preparation.target.bytes
      )
        throw Error('Retained target changed.');
      const appointment = NativeFileAppointmentSchema.parse({
        id: command.key.replaceAll('_', '-'),
        taskId: task.id,
        route: preparation.route,
        client: preparation.client,
        creditPolicy: preparation.recipient.creditPolicy,
        ...(preparation.billingAttestation
          ? { billingAttestation: preparation.billingAttestation }
          : {}),
        ...(preparation.permissionMode ? { permissionMode: preparation.permissionMode } : {}),
        target: { path: preparation.target.path, baseHash: preparation.target.baseHash },
        consent: {
          nativeTrust: 'accepted',
          source: 'explicit',
          policyHash: run.policy.hash,
          sourceBase: run.source.base,
          criteriaHash: hashCanonical(task.criteria),
        },
        policy: run.policy.policy,
        expiresAt: preparation.authority.expiresAt,
        maximumTaskMs: Math.min(
          preparation.profile.maximumTaskMs,
          (this.remaining(run).minutes - 2) * 60000,
        ),
        maximumSubmissions: 1,
      });
      const attempt = AttemptSchema.parse({
        id: preparation.attemptId,
        runId: run.id,
        routeId: preparation.route.id,
        generation: preparation.generation,
        state: 'intent',
        revision: 0,
      });
      const sessionHash = hashCanonical({ attemptId: attempt.id });
      const anthropicSessionId =
        preparation.route.family === 'anthropic'
          ? `${sessionHash.slice(0, 8)}-${sessionHash.slice(8, 12)}-8${sessionHash.slice(13, 16)}-a${sessionHash.slice(17, 20)}-${sessionHash.slice(20, 32)}`
          : undefined;
      binding = {
        appointment,
        run,
        attempt,
        original: new TextDecoder('utf-8', { fatal: true }).decode(original.content),
        baseHash: original.hash,
        manifest: files.map(({ content: _content, ...file }) => file),
        ...(anthropicSessionId ? { anthropicSessionId } : {}),
        public: {
          profileId: preparation.recipient.profileId,
          locationHash: preparation.locationHash,
          scopeHash: record.artifact.hash,
          context: { title: task.title, outcome: task.outcome },
        },
        handoff: { preparationId: record.artifact.id, preparation },
        environment: { ...profile.environment },
      };
      this.nativeManualAuthority({ ...binding, planArtifact: record.artifact }, false);
      this.nativeWriterPlan(binding);
      if (Buffer.byteLength(canonicalJson(this.nativePlanPayload(binding))) > MAX_FRAME_BYTES)
        throw Error('Native handoff plan exceeds its bound.');
    } catch {
      return {
        outcome: 'blocked',
        reason: 'native-handoff-start-unavailable',
        next: 'Prepare an exact handoff after inspecting the retained work, recipient and original limits.',
      };
    }
    const planArtifact = this.nativeArtifact(this.nativePlanPayload(binding));
    this.store.put('route', binding.appointment.route.id, 0, binding.appointment.route);
    const start = {
      ...command,
      command: 'StartRun' as const,
      payload: { taskId: command.payload.taskId, runId: command.payload.runId },
    };
    return this.start(start, effects, undefined, binding.attempt, false, {
      ...binding,
      planArtifact,
    });
  }

  nativeCurrentPlan(this: Controller, run: Run) {
    const key = this.currentNativePlanKey(run.id);
    return NativeHistoricalPreparationSchema.parse(this.nativeRecord(key).value);
  }

  nativeHandoffGate(
    this: Controller,
    run: Run,
  ): z.infer<typeof NativeHandoffPreviewSchema>['prepare'] {
    const unavailable = (
      reason: z.infer<typeof NativeHandoffPreviewSchema>['prepare']['reason'],
    ) => ({ available: false, reason });
    const task = this.store.get<Task>('task', run.taskId);
    if (this.closed || this.store.receipt(`paused:${run.id}`))
      return unavailable('admissions-paused');
    if (!task || task.runId !== run.id) return unavailable('authority-unavailable');
    if (this.hasUncertainWriter(task.id))
      return unavailable(task.state === 'unknown' ? 'ownership-unknown' : 'writer-active');
    if (!['stopped', 'interrupted'].includes(task.state))
      return unavailable('retained-work-unavailable');
    const plan = this.nativeCurrentPlan(run);
    const writer = this.store.get<Attempt>('attempt', plan.attempt.id);
    const intents = this.store.intents().filter((value) => value.run_id === run.id);
    const phases = this.store.nativeProcesses(plan.attempt.id);
    if (
      writer?.state !== 'stopped' ||
      intents.at(-1)?.attempt_id !== writer.id ||
      !phases.length ||
      phases.some((phase) => phase.state !== 'quiescent')
    )
      return unavailable('ownership-unknown');
    if (!this.store.receipt(`candidate:${writer.id}`))
      return unavailable('retained-work-unavailable');
    const remaining = this.remaining(run);
    const reviews = (run.policy.policy.methods ?? []).reduce(
      (sum, method) => sum + method.cycles,
      0,
    );
    const allowance = run.policy.policy.unknownUsage;
    if (
      remaining.attempts < reviews + 2 ||
      remaining.minutes <= 2 ||
      remaining.concurrency < 1 ||
      allowance.rule !== 'fixed-allowance'
    )
      return unavailable('budget-exhausted');
    const project = this.store.get<Project>('project', run.source.projectId);
    if (!project || !this.grant(run, 'write-scratch', project.name))
      return unavailable('authority-unavailable');
    return { available: true, reason: 'available' };
  }

  nativeHandoffPreview(this: Controller, run: Run) {
    if (!this.store.receipt(`native-handoff-roster:${run.id}`)) return;
    const roster = this.nativeManualRoster(run);
    const plan = this.nativeCurrentPlan(run);
    const prepare = this.nativeHandoffGate(run);
    const saved = this.store.receipt(`native-handoff-pending:${run.id}`);
    const pending =
      saved &&
      NativeManualPreparationSchema.parse(
        this.nativeRecord(`native-handoff-pending:${run.id}`).value,
      );
    const relevant = pending?.fromAttemptId === plan.attempt.id;
    const consumed = relevant && this.store.receipt(`native-handoff-consumed:${pending.attemptId}`);
    const start = consumed
      ? { available: false, reason: 'already-started' as const }
      : pending && Date.parse(pending.authority.expiresAt) <= Date.parse(this.now())
        ? { available: false, reason: 'authority-unavailable' as const }
        : prepare;
    return NativeHandoffPreviewSchema.parse({
      targets: roster.targets.map(({ target }) => target),
      currentAttemptId: plan.attempt.id,
      generation: plan.attempt.generation,
      prepare,
      ...(pending && relevant
        ? {
            pending: {
              preparationId: ArtifactSchema.parse(saved?.result.entity).id,
              packetId: pending.packet.packet.id,
              fromAttemptId: pending.fromAttemptId,
              generation: pending.generation,
              recipient: pending.recipient,
              baseHash: pending.target.baseHash,
              bytes: pending.target.bytes,
              expiresAt: pending.authority.expiresAt,
              start,
            },
          }
        : {}),
    });
  }

  prepareNativeHandoff(
    this: Controller,
    command: Extract<Command, { command: 'PrepareNativeHandoff' }>,
  ): CommandResult {
    let prepared: z.infer<typeof NativeManualPreparationSchema>;
    let task: Task;
    try {
      const run = this.store.get<Run>('run', command.payload.runId);
      const currentTask = this.store.get<Task>('task', command.payload.taskId);
      if (!run || !currentTask || run.taskId !== currentTask.id || currentTask.runId !== run.id)
        throw Error('authority-unavailable');
      task = currentTask;
      const gate = this.nativeHandoffGate(run);
      if (!gate.available) throw Error(gate.reason);
      const plan = this.nativeCurrentPlan(run);
      if (!('target' in plan.appointment) || plan.attempt.id !== command.payload.fromAttemptId)
        throw Error('authority-unavailable');
      const roster = this.nativeManualRoster(run);
      const selected = roster.targets.find(
        ({ target }) =>
          target.profileId === command.payload.profileId &&
          target.creditPolicy === command.payload.creditPolicy,
      );
      if (!selected || plan.public?.profileId === selected.target.profileId)
        throw Error('recipient-unavailable');
      const profile = this.profileFor(selected.target.profileId);
      this.nativeManualAllowance(
        run,
        selected.route.id,
        Math.max(0, this.remaining(run).minutes - 2),
      );
      if (
        !profile.facts.available ||
        !profile.environment ||
        hashCanonical(profile.facts) !== hashCanonical(selected.profile) ||
        hashCanonical(profile.client) !== hashCanonical(selected.client) ||
        profile.locationHash !== selected.locationHash
      )
        throw Error('recipient-unavailable');
      if (
        hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) !==
        hashCanonical(run.source)
      )
        throw Error('source-changed');
      const writer = this.store.get<Attempt>('attempt', plan.attempt.id) as Attempt;
      const candidate = CandidateSchema.parse(
        this.store.receipt(`candidate:${writer.id}`)?.result.entity,
      );
      const retained = this.evidence.read(candidate);
      const intent = this.store.intents().find((value) => value.attempt_id === writer.id);
      if (
        !intent ||
        this.evidence.hash(run.source.base, readFiles(intent.scratch_path)) !== candidate.hash
      )
        throw Error('retained-work-unavailable');
      const original = committedFiles(this.projectPath(task.projectId) as string, run.source.base);
      const targetPath = plan.appointment.target.path;
      const target = retained.files.find((file) => file.path === targetPath);
      const siblings = (files: typeof retained.files) =>
        files
          .filter((file) => file.path !== targetPath)
          .map(({ content: _content, ...file }) => file);
      if (
        !target ||
        target.bytes > 65536 ||
        hashCanonical(siblings(original)) !== hashCanonical(siblings(retained.files))
      )
        throw Error('retained-work-unavailable');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(target.content);
      if (text.includes('\0')) throw Error('retained-work-unavailable');
      const writerPacket = this.contextPacket(writer, candidate, false, [selected.route.id]);
      if (Buffer.byteLength(canonicalJson(writerPacket)) > 65536)
        throw Error('retained-work-unavailable');
      const project = this.store.get<Project>('project', task.projectId) as Project;
      const grant = this.grant(run, 'write-scratch', project.name);
      if (!grant) throw Error('authority-unavailable');
      const expiry = new Date(
        Math.min(Date.parse(grant.expiresAt), Date.parse(plan.appointment.expiresAt)),
      ).toISOString();
      const billingAttestation =
        'billingAttestation' in command.payload ? command.payload.billingAttestation : undefined;
      const permissionMode =
        'permissionMode' in command.payload ? command.payload.permissionMode : undefined;
      if (
        (profile.facts.family !== 'openai') !== !!billingAttestation ||
        (profile.facts.family === 'google') !== !!permissionMode ||
        (profile.facts.family === 'google' &&
          (!permissionMode || !profile.facts.permissionModes.includes(permissionMode)))
      )
        throw Error('recipient-unavailable');
      prepared = NativeManualPreparationSchema.parse({
        version: 1,
        runId: run.id,
        fromAttemptId: writer.id,
        attemptId: this.id('att'),
        generation: writer.generation + 1,
        recipient: selected.target,
        profile: selected.profile,
        client: selected.client,
        locationHash: selected.locationHash,
        route: selected.route,
        ...(billingAttestation ? { billingAttestation } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        candidate,
        packet: writerPacket,
        target: { path: target.path, baseHash: target.hash, bytes: target.bytes },
        authority: {
          action: 'write-scratch',
          target: project.name,
          consent: 'explicit',
          policyHash: run.policy.hash,
          criteriaHash: hashCanonical(task.criteria),
          expiresAt: expiry,
        },
      });
    } catch {
      return {
        outcome: 'blocked',
        reason: 'native-handoff-preparation-unavailable',
        next: 'Inspect retained work, recipient consent and original run bounds.',
      };
    }
    const artifact = this.nativeArtifact(prepared);
    const consent = this.nativeArtifact({
      scopeHash: artifact.hash,
      expiresAt: prepared.authority.expiresAt,
    });
    this.store.saveReceipt(`native-consent:${artifact.hash}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: consent,
    });
    this.store.saveReceipt(`native-handoff-prepared:${artifact.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    this.store.db
      .prepare('DELETE FROM receipts WHERE command_key=?')
      .run(`native-handoff-pending:${prepared.runId}`);
    this.store.saveReceipt(
      `native-handoff-pending:${prepared.runId}`,
      artifact.hash,
      'local-owner',
      { outcome: 'applied', entity: artifact },
    );
    this.event('handoff.sealed', task.id, task.revision, prepared.packet);
    const updated = this.updateTask(task, {
      next: 'Review the manual recipient and start the prepared handoff.',
    });
    return { outcome: 'applied', revision: updated.revision, entity: updated };
  }

  consentRecord(this: Controller, scopeHash: string) {
    const receipt = this.store.receipt(`native-consent:${scopeHash}`);
    if (receipt?.result.outcome !== 'applied') throw Error('Native consent is unavailable.');
    const artifact = ArtifactSchema.parse(receipt.result.entity);
    if (artifact.bytes > 4096) throw Error('Native consent exceeds its bound.');
    const consent = z
      .strictObject({ scopeHash: HashSchema, expiresAt: TimestampSchema })
      .parse(JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')));
    if (consent.scopeHash !== scopeHash || Date.parse(consent.expiresAt) <= Date.parse(this.now()))
      throw Error('Native consent expired.');
    return consent;
  }

  nativeConsentCurrent(this: Controller, binding: NativeBinding): boolean {
    if (!binding.public) return true;
    try {
      this.consentRecord(binding.public.scopeHash);
      const task = this.store.get<Task>('task', binding.run.taskId);
      return (
        !!task &&
        task.title === binding.public.context.title &&
        task.outcome === binding.public.context.outcome &&
        hashCanonical(task.criteria) === binding.appointment.consent.criteriaHash
      );
    } catch {
      return false;
    }
  }

  nativeProfileRoute(
    this: Controller,
    profile: NativeProfileResolution,
    creditPolicy: NativePilotAppointment['creditPolicy'],
    modelRequest?: ConversationModelRequest,
    selection?: ReturnType<typeof resolveOpenAiProjectSelection>,
  ): Route | undefined {
    if (profile.facts.family === 'local') throw Error('Local native launch is unavailable.');
    if ((modelRequest === undefined) !== (selection === undefined))
      throw Error('Native model selection is incomplete.');
    const key = this.nativeProfileRouteKey(profile.facts.id, creditPolicy, modelRequest);
    const receipt = this.store.receipt(key);
    if (!receipt) return;
    const artifact = ArtifactSchema.parse(receipt.result.entity);
    if (artifact.bytes > MAX_FRAME_BYTES) throw Error('Native route binding exceeds its bound.');
    const plan = NativePreparationSchema.parse(
      JSON.parse(this.artifacts.read(artifact.hash).toString('utf8')),
    );
    const route = this.store.get<Route>('route', plan.appointment.route.id);
    const expected = RouteSchema.parse({
      id: plan.appointment.route.id,
      family: profile.facts.family,
      displayName: profile.facts.displayName,
      model: selection?.model ?? profile.facts.model,
      effort: {
        requested: selection?.effort ?? profile.facts.effort,
        effective:
          profile.facts.family === 'openai'
            ? (selection?.effort ?? profile.facts.effort)
            : 'unknown',
        supported: [selection?.effort ?? profile.facts.effort],
      },
      billing: creditPolicy === 'ordinary' ? 'included' : 'credits',
      qualified: false,
      fake: false,
    });
    if (
      receipt.result.outcome !== 'applied' ||
      plan.public.profileId !== profile.facts.id ||
      plan.appointment.creditPolicy !== creditPolicy ||
      hashCanonical(
        ('modelRequest' in plan.appointment ? plan.appointment.modelRequest : undefined) ?? null,
      ) !== hashCanonical(modelRequest ?? null) ||
      hashCanonical(plan.appointment.client) !== hashCanonical(profile.client) ||
      hashCanonical(route) !== hashCanonical(expected)
    )
      throw Error('Native route binding changed.');
    return expected;
  }

  nativeProfileRouteKey(
    this: Controller,
    profileId: string,
    creditPolicy: NativePilotAppointment['creditPolicy'],
    modelRequest?: ConversationModelRequest,
  ) {
    const prefix = `native-profile-route:${profileId}:${creditPolicy}`;
    return modelRequest
      ? `${prefix}:${hashCanonical({
          observation: modelRequest.observation,
          model: modelRequest.model,
          effort: modelRequest.effort,
        })}`
      : prefix;
  }

  openAiProjectSelection(
    this: Controller,
    taskId: string,
    profile: NativeProfileResolution,
    request?: ConversationModelRequest,
    prepared = false,
  ) {
    if (!request) return resolveOpenAiProjectSelection(undefined, undefined);
    if (profile.facts.id !== 'openai-repository-v1' || !profile.client || !profile.locationHash)
      throw Error('The OpenAI project profile is unavailable.');
    const catalog = this.modelCatalog(taskId, request.observation, prepared);
    const task = this.store.get<Task>('task', taskId);
    const reason = this.catalogReason(catalog);
    const retained =
      prepared ||
      hashCanonical(this.taskModelCatalogReference(taskId) ?? null) ===
        hashCanonical(request.observation);
    const source = catalog.source;
    if (
      reason ||
      !retained ||
      !task ||
      hashCanonical(source) !==
        hashCanonical(inspectSource(task.projectId, this.projectPath(task.projectId) as string)) ||
      hashCanonical(profile.client) !== hashCanonical(catalog.client) ||
      profile.locationHash !== catalog.locationHash
    )
      throw Error(reason ?? 'client-changed');
    return resolveOpenAiProjectSelection(
      {
        observation: request.observation,
        models: catalog.models,
      } satisfies RetainedOpenAiModelObservation,
      request,
    );
  }
}
