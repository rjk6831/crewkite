import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type Attempt,
  canonicalJson,
  NativeBillingAttestationSchema,
  type Run,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { verificationGuidance } from '../evidence/toolchain-definition.ts';
import { applyReplacement, committedFiles, materialize } from '../host/source.ts';
import {
  type NativeLifecycle as AnthropicLifecycle,
  startNativeAuthStatus,
} from '../providers/anthropic/native-discovery.ts';
import { subscriptionAuth } from '../providers/anthropic/profile.ts';
import {
  replacementPlan as anthropicReplacementPlan,
  startReplacement as startAnthropicReplacement,
} from '../providers/anthropic/replacement.ts';
import { googleAcpWriterPlan } from '../providers/google/acp/writer.ts';
import {
  type GoogleNativeLifecycle,
  googleWriterPlan,
  startGoogleConfig,
  startGoogleWriter,
} from '../providers/google/native-writer.ts';
import {
  replacementPlan,
  startReplacement,
  type WriterPlan,
} from '../providers/openai/replacement.ts';
import { repositoryPlan, startRepository } from '../providers/openai/repository.ts';
import { repositoryReviewBudget } from '../providers/openai/review.ts';
import type { LaunchIntent } from '../store/index.ts';
import type { Controller } from './controller.ts';
import {
  type NativeBinding,
  type NativeOutcome,
  type NativeRuntime,
  nativeFailureNext,
} from './schemas.ts';

// Native writer plans and the OpenAI, Anthropic and Google writer launches.
export class NativeLaunchCommands {
  nativeLifecycle(
    this: Controller,
    attempt: Attempt,
    current: () => void,
  ): {
    beforePhase: (phase: {
      sequence: number;
      kind: import('../store/index.ts').NativeProcess['phase'];
    }) => void;
    owned: (
      phase: { sequence: number; kind: import('../store/index.ts').NativeProcess['phase'] },
      group: number,
    ) => void;
    quiescent: (
      phase: { sequence: number; kind: import('../store/index.ts').NativeProcess['phase'] },
      group: number,
    ) => void;
  } {
    return {
      beforePhase: (phase) => {
        current();
        this.store.transaction(() =>
          this.store.intendNativePhase(attempt.id, phase.sequence, phase.kind, this.now()),
        );
      },
      owned: (phase, group) => {
        this.store.transaction(() => this.store.ownNativePhase(attempt.id, phase.sequence, group));
        if (phase.sequence === 0) this.acknowledgeJob(attempt, group);
        current();
      },
      quiescent: (phase, group) =>
        this.store.transaction(() =>
          this.store.finishNativePhase(attempt.id, phase.sequence, group, this.now()),
        ),
    };
  }

  nativeWriterPlan(this: Controller, binding: Omit<NativeBinding, 'planArtifact'>) {
    const { appointment, attempt } = binding;
    const criteria = [
      ...(binding.public ? [binding.public.context.title, binding.public.context.outcome] : []),
      ...(this.store.get<Task>('task', binding.run.taskId) as Task).criteria,
    ];
    if ('acp' in appointment)
      return googleAcpWriterPlan({
        client: appointment.client,
        attemptId: attempt.id,
        generation: attempt.generation,
        target: appointment.target,
        criteria,
        selection: appointment.acp,
        ...(appointment.contextLines === undefined
          ? {}
          : { contextLines: appointment.contextLines }),
        proof: appointment.proof,
        ...this.options.googleAcp,
      });
    if ('repository' in appointment) {
      const committed = (path: string) => binding.manifest.some((file) => file.path === path);
      return repositoryPlan({
        attemptId: attempt.id,
        model: appointment.route.model as WriterPlan['model'],
        effort: appointment.route.effort.requested,
        creditPolicy: appointment.creditPolicy,
        scratchPath: join(this.home, 'scratch', binding.run.id),
        sourceBase: appointment.repository.sourceBase,
        manifestHash: appointment.repository.manifestHash,
        execution: appointment.execution,
        context: {
          title: binding.public?.context.title ?? '',
          outcome: binding.public?.context.outcome ?? '',
          criteria: (this.store.get<Task>('task', binding.run.taskId) as Task).criteria,
        },
        limits: {
          deadlineMs: appointment.maximumTaskMs,
          paths: [],
          // Verification preparation needs this journey and lockfile in the source.
          ...(committed('e2e/desktop.spec.ts') && committed('pnpm-lock.yaml')
            ? verificationGuidance
            : { checks: [], frozen: [] }),
          review: repositoryReviewBudget,
        },
      });
    }
    if (typeof binding.original !== 'string' || !binding.baseHash)
      throw Error('The file input is unavailable.');
    const fields = {
      attemptId: attempt.id,
      path: appointment.target.path,
      original: binding.original,
      baseHash: binding.baseHash,
      criteria,
      ...(binding.handoff ? { handoff: binding.handoff.preparation.packet } : {}),
    };
    if (appointment.route.family === 'google') {
      if (
        !appointment.billingAttestation ||
        !appointment.permissionMode ||
        appointment.creditPolicy !== 'ordinary' ||
        binding.anthropicSessionId
      )
        throw Error('The subscription writer binding is unavailable.');
      return googleWriterPlan({
        attemptId: attempt.id,
        file: { path: fields.path, baseHash: fields.baseHash, content: fields.original },
        task: JSON.stringify(criteria),
        ...(binding.handoff ? { handoff: binding.handoff.preparation.packet } : {}),
        model: appointment.route.model,
        effort: 'low',
      });
    }
    if (appointment.route.family === 'anthropic') {
      if (
        !binding.anthropicSessionId ||
        !appointment.billingAttestation ||
        appointment.creditPolicy !== 'ordinary'
      )
        throw Error('The subscription writer binding is unavailable.');
      return anthropicReplacementPlan({
        ...fields,
        sessionId: binding.anthropicSessionId,
        model: appointment.route.model,
        effort: 'medium',
      });
    }
    if (binding.anthropicSessionId || appointment.billingAttestation)
      throw Error('The writer family binding changed.');
    return replacementPlan({
      ...fields,
      model: appointment.route.model as WriterPlan['model'],
      effort: appointment.route.effort.requested as WriterPlan['effort'],
      creditPolicy: appointment.creditPolicy,
      directory: join(this.home, 'native', attempt.id),
    });
  }

  launchAnthropic(
    this: Controller,
    runtime: NativeRuntime,
    directory: string,
    timeoutMs: number,
    onSubmitted: () => void,
  ): NonNullable<NativeRuntime['handle']> {
    const { binding } = runtime;
    const { appointment, attempt } = binding;
    if (!('target' in appointment)) throw Error('The file writer binding changed.');
    const deadline = performance.now() + timeoutMs;
    let active: { stop: () => void } | undefined;
    let quiescent = false;
    const journal = this.nativeLifecycle(attempt, () => this.nativeCurrent(runtime));
    const phase = (kind: 'auth-status' | 'task') =>
      kind === 'auth-status'
        ? { sequence: 0 as const, kind: 'auth-status' as const }
        : { sequence: 1 as const, kind: 'native-task' as const };
    const lifecycle: AnthropicLifecycle = {
      beforePhase: (kind) => journal.beforePhase(phase(kind)),
      owned: (kind, group) => journal.owned(phase(kind), group),
      quiescent: (kind, group) => journal.quiescent(phase(kind), group),
    };
    const launch = {
      ...appointment.client,
      repositoryRoot: this.home,
      environment: binding.environment ?? process.env,
    };
    const result = (async (): Promise<NativeOutcome> => {
      try {
        const authDirectory = join(directory, 'auth');
        mkdirSync(authDirectory, { mode: 0o700 });
        const auth = startNativeAuthStatus(
          { ...launch, directory: authDirectory },
          {
            deadline,
            schedule: this.options.schedule,
            spawn: this.options.nativeSpawn,
            lifecycle,
          },
        );
        active = auth;
        if (runtime.stopped || this.closed) active.stop();
        const observed = await auth.result;
        active = undefined;
        quiescent = observed.quiescent;
        let authHash = '';
        this.store.transaction(() => {
          const artifact = this.nativeArtifact({
            attemptId: attempt.id,
            clientHash: appointment.client.sha256,
            billingAttestationHash: hashCanonical(appointment.billingAttestation),
            ...observed,
          });
          authHash = artifact.hash;
          this.store.saveReceipt(`native-auth:${attempt.id}`, artifact.hash, 'local-owner', {
            outcome: 'applied',
            entity: artifact,
          });
        });
        if (observed.reason || !observed.quiescent || !subscriptionAuth(observed.metadata))
          return {
            metadata: null,
            reason: observed.reason ?? 'authentication',
            quiescent,
            diagnostic: null,
          };
        this.nativeCurrent(runtime);
        const taskDirectory = join(directory, 'task');
        mkdirSync(taskDirectory, { mode: 0o700 });
        const plan = this.nativeWriterPlan(binding) as ReturnType<typeof anthropicReplacementPlan>;
        const writer = startAnthropicReplacement(
          { ...launch, directory: taskDirectory, plan },
          {
            deadline,
            schedule: this.options.schedule,
            spawn: this.options.nativeSpawn as typeof import('node:child_process').spawn,
            lifecycle,
            onSubmitted,
            ...this.providerUsage(
              attempt,
              () => this.nativeCurrent(runtime),
              () => this.workers.get(attempt.id) === runtime && !runtime.stopped,
              ['native-task'],
            ),
          },
        );
        active = writer;
        quiescent = false;
        if (runtime.stopped || this.closed) active.stop();
        const outcome = await writer.result;
        active = undefined;
        return {
          metadata: outcome.proposal
            ? {
                ...outcome.proposal,
                family: 'anthropic',
                sessionId: plan.sessionId,
                model: plan.model,
                requestedEffort: 'medium',
                effectiveEffort: 'unknown',
                authHash,
                billingAttestation: NativeBillingAttestationSchema.parse(
                  appointment.billingAttestation,
                ),
              }
            : null,
          reason: outcome.reason,
          quiescent: outcome.quiescent,
          diagnostic: outcome.diagnostic,
        };
      } catch {
        return { metadata: null, reason: 'launch', quiescent, diagnostic: null };
      }
    })();
    return { result, stop: () => active?.stop() };
  }

  launchGoogle(
    this: Controller,
    runtime: NativeRuntime,
    directory: string,
    timeoutMs: number,
    onSubmitted: () => void,
  ): NonNullable<NativeRuntime['handle']> {
    const { binding } = runtime;
    const { appointment, attempt } = binding;
    if (!('target' in appointment)) throw Error('The file writer binding changed.');
    const deadline = performance.now() + timeoutMs;
    let active: { stop: () => void } | undefined;
    let quiescent = false;
    const journal = this.nativeLifecycle(attempt, () => this.nativeCurrent(runtime));
    const phase = (kind: 'config' | 'task') =>
      kind === 'config'
        ? { sequence: 0, kind: 'google-config' as const }
        : { sequence: 1, kind: 'native-task' as const };
    const lifecycle: GoogleNativeLifecycle = {
      beforePhase: (kind) => journal.beforePhase(phase(kind)),
      owned: (kind, group) => journal.owned(phase(kind), group),
      quiescent: (kind, group) => journal.quiescent(phase(kind), group),
    };
    const result = (async (): Promise<NativeOutcome> => {
      try {
        if (!appointment.permissionMode || !appointment.billingAttestation || !binding.public)
          throw Error();
        const locationHash = binding.public.locationHash;
        const temporaryDirectory = join(directory, 'temporary');
        const configDirectory = join(directory, 'config');
        mkdirSync(temporaryDirectory, { mode: 0o700 });
        mkdirSync(configDirectory, { mode: 0o700 });
        const launch = {
          client: appointment.client,
          repositoryRoot: this.home,
          temporaryDirectory,
          environment: binding.environment ?? process.env,
          timeoutMs,
          deadline,
          schedule: this.options.schedule,
          spawn: this.options.nativeSpawn as typeof import('node:child_process').spawn,
          lifecycle,
        };
        const config = startGoogleConfig({
          ...launch,
          directory: configDirectory,
          timeoutMs: Math.min(timeoutMs, 20000),
        });
        active = config;
        if (runtime.stopped || this.closed) active.stop();
        const observed = await config.result;
        active = undefined;
        quiescent = observed.quiescent;
        let configHash = '';
        this.store.transaction(() => {
          const artifact = this.nativeArtifact({
            attemptId: attempt.id,
            clientHash: appointment.client.sha256,
            locationHash,
            billingAttestationHash: hashCanonical(appointment.billingAttestation),
            ...observed,
          });
          configHash = artifact.hash;
          this.store.saveReceipt(`native-config:${attempt.id}`, artifact.hash, 'local-owner', {
            outcome: 'applied',
            entity: artifact,
          });
        });
        if (
          observed.reason ||
          !observed.quiescent ||
          !observed.metadata ||
          observed.metadata.permissionMode !== appointment.permissionMode
        )
          return {
            metadata: null,
            reason: observed.reason ?? 'configuration',
            quiescent,
            diagnostic: null,
          };
        this.nativeCurrent(runtime);
        const taskDirectory = join(directory, 'task');
        mkdirSync(taskDirectory, { mode: 0o700 });
        const plan = this.nativeWriterPlan(binding) as ReturnType<typeof googleWriterPlan>;
        const writer = startGoogleWriter({
          ...launch,
          directory: taskDirectory,
          attemptId: attempt.id,
          file: plan.file,
          task: plan.task,
          ...(binding.handoff ? { handoff: binding.handoff.preparation.packet } : {}),
          onSubmitted,
          admission: {
            clientExecutable: appointment.client.executable,
            clientVersion: appointment.client.version,
            clientSha256: appointment.client.sha256,
            checkedAt: this.now(),
            nativeTrust: 'accepted',
            permissions: appointment.permissionMode,
            billing: 'subscription-only',
            extraCredits: 'disabled',
            evidence: {
              nativePermissions: configHash,
              subscriptionBilling: hashCanonical(appointment.billingAttestation),
              paidCreditsDisabled: configHash,
            },
            model: appointment.route.model,
            effort: 'low',
          },
        });
        active = writer;
        quiescent = false;
        if (runtime.stopped || this.closed) active.stop();
        const outcome = await writer.result;
        active = undefined;
        return {
          metadata: outcome.metadata
            ? {
                ...outcome.metadata,
                family: 'google',
                model: appointment.route.model,
                requestedEffort: 'low',
                effectiveEffort: 'unknown',
                permissionMode: appointment.permissionMode,
                configHash,
                billingAttestation: appointment.billingAttestation,
                qualified: false,
              }
            : null,
          reason: outcome.reason,
          quiescent: outcome.quiescent,
          diagnostic: outcome.diagnostic,
        };
      } catch {
        return { metadata: null, reason: 'launch', quiescent, diagnostic: null };
      }
    })();
    return { result, stop: () => active?.stop() };
  }

  launchNative(this: Controller, intent: LaunchIntent, binding: NativeBinding) {
    if ('acp' in binding.appointment) {
      this.launchAcpNative(intent, binding);
      return;
    }
    if (this.closed) return;
    const runtime: NativeRuntime = { kind: 'native', binding, stopped: false };
    const completion = Promise.withResolvers<void>();
    runtime.done = completion.promise;
    this.workers.set(binding.attempt.id, runtime);
    const { appointment, run, attempt } = binding;
    const finish = async (outcome: NativeOutcome | null) => {
      try {
        let applied = false;
        let repositoryCompleted = false;
        const phases = this.store.nativeProcesses(attempt.id);
        const quiescent =
          outcome?.quiescent === true &&
          phases.length > 0 &&
          phases.every((phase) => phase.state === 'quiescent');
        try {
          this.store.transaction(() => {
            const artifact = this.nativeArtifact({
              attemptId: attempt.id,
              reason: outcome ? outcome.reason : 'launch',
              quiescent,
              diagnostic: outcome?.diagnostic ?? null,
              ...(outcome?.ignoredNotifications
                ? { ignoredNotifications: outcome.ignoredNotifications }
                : {}),
            });
            this.store.saveReceipt(
              `native-completion:${attempt.id}`,
              artifact.hash,
              'local-owner',
              {
                outcome: 'applied',
                entity: artifact,
              },
            );
            if (outcome?.metadata) {
              const proposal = this.nativeArtifact(outcome.metadata);
              this.store.saveReceipt(
                `native-proposal:${attempt.id}`,
                proposal.hash,
                'local-owner',
                {
                  outcome: 'applied',
                  entity: proposal,
                },
              );
            }
          });
          if (
            quiescent &&
            this.store.nativePhasesComplete(attempt.id, appointment.route.family) &&
            outcome?.metadata &&
            !outcome.reason
          ) {
            this.nativeCurrent(runtime);
            if ('repository' in appointment) {
              this.repositoryResult(appointment, attempt.id, outcome.metadata);
              repositoryCompleted = true;
            } else {
              this.store.transaction(() => {
                this.nativeCurrent(runtime);
                const artifact = this.nativeArtifact({
                  attemptId: attempt.id,
                  proposalHash: hashCanonical(outcome.metadata),
                  manifest: binding.manifest,
                });
                this.store.saveReceipt(
                  `native-application:${attempt.id}`,
                  artifact.hash,
                  'local-owner',
                  { outcome: 'outcome-unknown', entity: artifact },
                );
              });
              this.nativeCurrent(runtime);
              if (!('replacement' in outcome.metadata))
                throw Error('The file replacement is unavailable.');
              applyReplacement(intent.scratch_path, binding.manifest, outcome.metadata.replacement);
              this.store.transaction(() =>
                this.store.db.prepare('UPDATE receipts SET result=? WHERE command_key=?').run(
                  canonicalJson({
                    outcome: 'applied',
                    entity: this.store.receipt(`native-application:${attempt.id}`)?.result.entity,
                  }),
                  `native-application:${attempt.id}`,
                ),
              );
              applied = true;
            }
          }
        } catch {
          // A committed intent can outlive an interrupted write. Recovery never reapplies it.
        }
        if (quiescent) await this.formatAttempt(attempt);
        try {
          if (this.settleJob(attempt, quiescent, true)) {
            if ('repository' in appointment) {
              let captured = false,
                captureFailed = false;
              try {
                const candidate = this.sealCandidate(attempt);
                if (repositoryCompleted) {
                  this.store.transaction(() => {
                    const artifact = this.nativeArtifact({
                      version: 1,
                      attemptId: attempt.id,
                      planHash: binding.planArtifact.hash,
                      completionHash: this.nativeRecord(`native-completion:${attempt.id}`, 4096)
                        .artifact.hash,
                      metadataHash: this.nativeRecord(`native-proposal:${attempt.id}`).artifact
                        .hash,
                      candidateId: candidate.id,
                      candidateHash: candidate.hash,
                      repository: appointment.repository,
                      execution: appointment.execution,
                    });
                    this.store.saveReceipt(
                      `native-capture:${attempt.id}`,
                      artifact.hash,
                      'local-owner',
                      { outcome: 'applied', entity: artifact },
                    );
                  });
                  captured = true;
                }
              } catch {
                captureFailed = true;
                try {
                  this.store.transaction(() => {
                    const artifact = this.nativeArtifact({
                      attemptId: attempt.id,
                      reason: 'capture-unavailable',
                    });
                    this.store.saveReceipt(
                      `native-capture-failure:${attempt.id}`,
                      artifact.hash,
                      'local-owner',
                      { outcome: 'applied', entity: artifact },
                    );
                  });
                } catch {}
              }
              this.store.transaction(() => {
                const task = this.store.get<Task>('task', run.taskId) as Task;
                this.closePendingEffects(task);
                this.updateTask(task, {
                  state: captured ? 'stopped' : 'interrupted',
                  waitingReason: null,
                  next: captured
                    ? 'Native work is retained. Checks and review remain pending.'
                    : captureFailed
                      ? 'Native capture failed. Inspect retained scratch; checks and acceptance are unavailable.'
                      : 'Native work is unverified. Inspect retained changes and export.',
                });
              });
            } else {
              const combined = this.store.combinedGroup(run.id);
              const quotaDenied = !!combined && this.confirmedQuotaDenial(intent);
              this.store.transaction(() => {
                const task = this.store.get<Task>('task', run.taskId) as Task;
                this.closePendingEffects(task);
                this.updateTask(task, {
                  state: applied ? 'stopped' : 'interrupted',
                  waitingReason: null,
                  next: applied
                    ? 'Native work is retained. Checks and review remain pending.'
                    : nativeFailureNext(outcome),
                });
                if (quotaDenied) {
                  const changed = this.store.db
                    .prepare(
                      "UPDATE combined_dispatches SET state='stopped' WHERE parent_run_id=? AND attempt_id=? AND state='running'",
                    )
                    .run(combined.run_id, attempt.id);
                  if (changed.changes !== 1) throw Error('The combined quota slot changed.');
                  const writers = this.store
                    .combinedDispatches(combined.run_id)
                    .filter((slot) => slot.phase.startsWith('writer-'));
                  if (writers.every((slot) => ['passed', 'stopped'].includes(slot.state)))
                    this.updateCombined(combined, 'blocked', 'writers-incomplete');
                  else this.updateCombined(combined, 'writers');
                }
              });
              if (!quotaDenied) this.sealCandidate(attempt);
            }
          }
        } catch {
          // Preserve the journal and bytes when capture cannot finish.
        } finally {
          if (quiescent) this.workers.delete(attempt.id);
        }
      } catch {
        // Unreadable ownership cannot release a lease or justify application.
        try {
          this.settleJob(attempt, false, true);
        } catch {}
      } finally {
        this.armQuotaRetries();
        completion.resolve();
      }
    };
    try {
      this.options.afterIntent?.(intent);
      this.nativeCurrent(runtime);
      if (!existsSync(intent.scratch_path))
        materialize(
          intent.scratch_path,
          binding.handoff
            ? this.evidence.read(binding.handoff.preparation.candidate).files
            : committedFiles(this.projectPath(run.source.projectId) as string, run.source.base),
        );
      const directory = join(this.home, 'native', attempt.id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const plan = this.nativeWriterPlan(binding);
      const timeoutMs = Math.min(
        appointment.maximumTaskMs,
        this.jobDeadline(attempt.id, appointment.maximumTaskMs / 60_000),
        Date.parse(appointment.expiresAt) - Date.parse(this.now()),
      );
      const onSubmitted = () => {
        this.nativeCurrent(runtime);
        this.store.transaction(() => {
          this.nativeCurrent(runtime);
          const artifact = this.nativeArtifact({
            attemptId: attempt.id,
            plan: binding.planArtifact.hash,
          });
          this.store.saveReceipt(
            `native-submission:${attempt.id}`,
            binding.planArtifact.hash,
            'local-owner',
            { outcome: 'outcome-unknown', entity: artifact },
          );
        });
      };
      if (appointment.route.family === 'google') {
        runtime.handle = this.launchGoogle(runtime, directory, timeoutMs, onSubmitted);
      } else if (appointment.route.family === 'anthropic') {
        runtime.handle = this.launchAnthropic(runtime, directory, timeoutMs, onSubmitted);
      } else {
        const launch = {
          ...appointment.client,
          directory,
          repositoryRoot: this.home,
          environment: binding.environment ?? process.env,
        };
        const options = {
          timeoutMs,
          schedule: this.options.schedule,
          spawn: this.options.nativeSpawn,
          onSubmitted,
          ...this.providerUsage(
            attempt,
            () => this.nativeCurrent(runtime),
            () => this.workers.get(attempt.id) === runtime && !runtime.stopped,
            ['metadata-preparation', 'app-server-task'],
          ),
          lifecycle: this.nativeLifecycle(attempt, () => this.nativeCurrent(runtime)),
        };
        runtime.handle =
          'repository' in appointment
            ? startRepository(launch, plan as ReturnType<typeof repositoryPlan>, {
                ...options,
                onActivity: (activity) => {
                  const task = this.store.get<Task>('task', run.taskId),
                    current = this.store.get<Attempt>('attempt', attempt.id),
                    saved = this.store.get<Run>('run', run.id);
                  const lease = this.store.db
                    .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
                    .get(run.taskId);
                  const phase = this.store.db
                    .prepare(
                      'SELECT phase,state FROM native_processes WHERE attempt_id=? ORDER BY sequence DESC LIMIT 1',
                    )
                    .get(attempt.id);
                  if (
                    phase?.phase !== 'app-server-task' ||
                    phase.state !== 'owned' ||
                    this.closed ||
                    runtime.stopped ||
                    this.workers.get(attempt.id) !== runtime ||
                    task?.runId !== run.id ||
                    task.state !== 'running' ||
                    current?.generation !== attempt.generation ||
                    current.routeId !== attempt.routeId ||
                    !['intent', 'running'].includes(current.state) ||
                    saved?.policy.hash !== run.policy.hash ||
                    lease?.attempt_id !== attempt.id ||
                    lease.generation !== attempt.generation
                  )
                    return;
                  const paths = ('paths' in activity ? activity.paths : [])
                    .slice(0, 8)
                    .map((path) => JSON.stringify(path))
                    .join(', ');
                  const text = `Native ${activity.kind === 'command' ? 'command' : 'file changes'} ${activity.state}${paths ? `: ${paths}` : ''}.`;
                  this.store.transaction(() =>
                    this.event('attempt.output', task.id, task.revision, {
                      attemptId: attempt.id,
                      generation: attempt.generation,
                      channel: 'stdout',
                      text,
                    }),
                  );
                },
              })
            : startReplacement(launch, plan as WriterPlan, options);
      }
      const handle = runtime.handle;
      if (!handle) throw Error('The native writer owner is unavailable.');
      if (runtime.stopped || this.closed) handle.stop();
      void handle.result.then(finish, () => finish(null));
    } catch {
      void finish(null);
    }
  }
}
