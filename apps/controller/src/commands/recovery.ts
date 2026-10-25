import {
  AcpApprovalTargetSchema,
  type Attempt,
  AttemptSchema,
  GoogleAcpSetupSchema,
  HashSchema,
  type Route,
  RouteSchema,
  type Run,
  type Task,
  TimestampSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import { inspectCheckRoots } from '../host/check-ownership.ts';
import { checkRootQuiescent, groupAbsent } from '../host/worker.ts';
import {
  BindingSchema as LocalBindingSchema,
  TerminalSchema as LocalTerminalSchema,
} from '../providers/local/profile.ts';
import type { LaunchIntent } from '../store/index.ts';
import type { Controller } from './controller.ts';
import { CombinedRefJournalSchema } from './schemas.ts';

// Startup recovery of writers, combined groups and launch intents.
export class RecoveryCommands {
  recoverLocalWriter(
    this: Controller,
    intent: LaunchIntent,
    attempt: Attempt,
    run: Run,
    task: Task,
  ): boolean {
    const route = this.store.get<Route>('route', intent.route_id);
    if (route?.family !== 'local' || route.fake) return false;
    try {
      // The fixed CPU evaluator catalog has its own checked process proof.
      const cpuRoute = RouteSchema.parse(this.nativeRecord('node-check-route').value);
      if (cpuRoute.id === route.id && hashCanonical(cpuRoute) === hashCanonical(route))
        return false;
    } catch {}
    let known = false;
    let finishedAt = this.now();
    try {
      const plan = this.localPrepared(run.id);
      const expected = LocalBindingSchema.parse({
        ...plan.localModel,
        attemptId: attempt.id,
        generation: attempt.generation,
        profileHash: hashCanonical(plan.profile),
        sourceHash: plan.scopeHash,
        path: plan.target.path,
        baseHash: plan.target.baseHash,
      });
      const receipt = this.store.receipt(`local-terminal:${attempt.id}`);
      if (
        receipt?.result.outcome !== 'applied' ||
        plan.attempt.id !== attempt.id ||
        plan.attempt.generation !== intent.generation ||
        plan.attempt.routeId !== intent.route_id ||
        plan.run.taskId !== task.id ||
        plan.run.id !== run.id
      )
        throw Error('Local terminal lineage is unavailable.');
      const proof = z
        .strictObject({
          attemptId: AttemptSchema.shape.id,
          bindingHash: HashSchema,
          terminal: LocalTerminalSchema.nullable(),
          clientQuiescent: z.boolean(),
          known: z.boolean(),
          unspawned: z.boolean(),
          at: TimestampSchema,
        })
        .parse(this.nativeRecord(`local-terminal:${attempt.id}`).value);
      const phases = this.store.nativeProcesses(attempt.id);
      const submitted = !!this.store.receipt(`native-submission:${attempt.id}`);
      if (
        proof.attemptId !== attempt.id ||
        proof.bindingHash !== hashCanonical(expected) ||
        !proof.known ||
        !proof.clientQuiescent
      )
        throw Error('Local terminal proof changed.');
      if (proof.unspawned) {
        if (
          submitted ||
          phases.length ||
          intent.pid !== null ||
          intent.process_group !== null ||
          proof.terminal !== null
        )
          throw Error('An unspawned Local turn has process or submission history.');
      } else {
        const terminal = proof.terminal;
        if (
          !terminal ||
          terminal.kind === 'unknown' ||
          hashCanonical(terminal.binding) !== hashCanonical(expected) ||
          (terminal.kind === 'failed' && terminal.proof === null && submitted) ||
          (terminal.proof !== null &&
            terminal.proof.maxTokens !== plan.profile.maximumOutputTokens) ||
          !this.store.nativePhasesComplete(attempt.id, 'local') ||
          phases.some((phase) => phase.state !== 'quiescent')
        )
          throw Error('A Local generation has no matching runtime terminal.');
      }
      known = true;
      finishedAt = proof.at;
    } catch {}
    const closed = known ? undefined : this.shutdownProof(intent);
    if (closed) {
      this.settleUnknownWriter(
        intent,
        closed,
        'Controller restarted after every recorded process group exited. Local recorded no matching terminal.',
      );
      return true;
    }
    const updated = {
      ...attempt,
      state: known ? ('stopped' as const) : ('unknown' as const),
      revision: attempt.revision + 1,
    };
    this.store.put('attempt', attempt.id, updated.revision, updated);
    this.store.db
      .prepare('UPDATE launch_intents SET state=?,finished_at=? WHERE attempt_id=?')
      .run(known ? 'stopped' : 'outcome-unknown', known ? finishedAt : null, attempt.id);
    if (known) {
      this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
      this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
    }
    if (!known || task.runId === run.id)
      this.updateTask(task, {
        state: known ? 'interrupted' : 'unknown',
        waitingReason: null,
        next: known
          ? 'The Local terminal is retained. Inspect existing work; nothing will replay.'
          : 'Local generation ownership is unknown. Its lease and reservation remain held.',
      });
    this.event('run.interrupted', task.id, task.revision + 1, {
      runId: run.id,
      reason: known
        ? 'Local runtime terminal and client closure were recorded.'
        : 'Local generation has no recorded matching terminal.',
    });
    return true;
  }

  recover(this: Controller) {
    this.store.transaction(() => {
      const usage = this.openAiUsageState();
      // A reader that never recorded a group may own a process the journal cannot name, so it
      // stays unknown. Once every recorded group is absent, the read holds nothing and its
      // observations were never published.
      if (usage && usage.state !== 'quiescent')
        this.saveOpenAiUsage({
          ...usage,
          state:
            usage.groups.length && usage.groups.every((group) => groupAbsent(group))
              ? 'quiescent'
              : 'unknown',
        });
      if (
        usage?.commandId &&
        this.store.receipt(usage.commandId)?.result.reason === 'openai-usage-read-pending'
      )
        this.finishMetadataReceipt(usage.commandId, {
          outcome: this.openAiUsageState()?.state === 'quiescent' ? 'blocked' : 'outcome-unknown',
          reason:
            this.openAiUsageState()?.state === 'quiescent'
              ? 'usage-read-interrupted'
              : 'openai-metadata-ownership-unknown',
        });
      const local = this.localControl();
      if (local.operation)
        this.saveLocal({
          ...local,
          operation: { ...local.operation, state: 'unknown', revoked: true },
        });
      for (const operation of this.store.googleMetadataOperations()) {
        const quiescent = operation.state === 'quiescent';
        if (!quiescent) this.store.unknownGoogleMetadata(operation.command_id);
        const receipt = this.store.receipt(operation.command_id);
        if (receipt?.result.reason === 'usage-read-pending') {
          this.finishMetadataReceipt(operation.command_id, {
            outcome: quiescent ? 'blocked' : 'outcome-unknown',
            reason: quiescent ? 'usage-read-interrupted' : 'google-ownership-unknown',
          });
        }
      }
      const setup = this.store.googleAcpSetup();
      if (
        setup.operationId &&
        ['initializing', 'authenticating', 'discovering', 'stopping'].includes(setup.state)
      ) {
        const operation = this.store
          .googleMetadataOperations()
          .find((row) => row.command_id === setup.operationId);
        const known = operation?.state === 'quiescent';
        const next = GoogleAcpSetupSchema.parse({
          ...setup,
          revision: setup.revision + 1,
          state: known ? 'blocked' : 'unknown',
          operationId: known ? null : setup.operationId,
          reason: null,
        });
        this.store.putGoogleAcpSetup(next);
        if (this.store.receipt(setup.operationId)?.result.reason === 'acp-setup-pending')
          this.finishMetadataReceipt(setup.operationId, {
            outcome: known ? 'blocked' : 'outcome-unknown',
            reason: known ? 'acp-setup-interrupted' : 'google-ownership-unknown',
            data: { kind: 'google-acp-setup', setup: next },
          });
      }
      for (const group of this.store.combinedGroups()) {
        const manifest = this.combinedManifest(group);
        if (group.integration_maximum_minutes !== (manifest.input.integration?.maximumMinutes ?? 1))
          throw Error('The saved combined integration allowance changed.');
        const journals = this.store.combinedRefIntents(group.run_id);
        const unresolved = journals.some((row) => {
          const journal = CombinedRefJournalSchema.parse(JSON.parse(row.body));
          return (
            row.state === 'unknown' ||
            (row.state === 'prepared' &&
              ((!journal.phases.length && !row.finished_at) ||
                journal.phases.some((phase) => phase.state !== 'quiescent')))
          );
        });
        if (unresolved || (group.integration_active && !journals.length)) {
          this.store.db
            .prepare(
              "UPDATE combined_ref_intents SET state='unknown' WHERE parent_run_id=? AND state='prepared'",
            )
            .run(group.run_id);
          this.updateCombined(group, 'unknown', 'ownership-unknown');
        } else if (group.integration_active) {
          const pending = journals.find((row) => row.state === 'prepared');
          const elapsed = pending
            ? Date.parse(this.now()) - Date.parse(pending.intent_at)
            : group.integration_maximum_minutes * 60000;
          this.store.db
            .prepare(
              'UPDATE combined_groups SET integration_active=0,integration_milliseconds=MIN(integration_maximum_minutes*60000,integration_milliseconds+?) WHERE run_id=?',
            )
            .run(
              Number.isFinite(elapsed) && elapsed >= 0
                ? Math.ceil(elapsed)
                : group.integration_maximum_minutes * 60000,
              group.run_id,
            );
          if (pending?.expected_new && ['assembling', 'blocked'].includes(group.phase))
            this.updateCombined(group, 'assembling');
        }
      }
      for (const intent of this.store.intents().filter((value) => value.state !== 'stopped')) {
        const attempt = this.store.get<Attempt>('attempt', intent.attempt_id);
        const run = this.store.get<Run>('run', intent.run_id);
        const task = this.store.get<Task>('task', intent.task_id);
        if (
          !attempt ||
          !run ||
          !task ||
          attempt.runId !== run.id ||
          run.taskId !== task.id ||
          attempt.routeId !== intent.route_id ||
          attempt.generation !== intent.generation
        )
          throw new Error('Persisted writer lineage is invalid.');
        if (this.recoverLocalWriter(intent, attempt, run, task)) continue;
        const combined = this.store.combinedGroup(run.id);
        if (combined) {
          const phases = this.store.nativeProcesses(attempt.id);
          const key = this.store.receipt(`native-completion:${attempt.id}`)
            ? `native-completion:${attempt.id}`
            : `native-review-completion:${attempt.id}`;
          let quiescent = false;
          try {
            const value = this.nativeRecord(key, 4096).value as {
              attemptId: string;
              quiescent: boolean;
            };
            quiescent =
              value?.attemptId === attempt.id &&
              value.quiescent === true &&
              phases.length > 0 &&
              phases.every((phase) => phase.state === 'quiescent');
          } catch {}
          this.store.put('attempt', attempt.id, attempt.revision + 1, {
            ...attempt,
            state: quiescent ? 'stopped' : 'unknown',
            revision: attempt.revision + 1,
          });
          this.store.db
            .prepare('UPDATE launch_intents SET state=?,finished_at=? WHERE attempt_id=?')
            .run(
              quiescent ? 'stopped' : 'outcome-unknown',
              quiescent ? this.now() : null,
              attempt.id,
            );
          this.store.db
            .prepare(
              "UPDATE combined_dispatches SET state=? WHERE parent_run_id=? AND attempt_id=? AND state='running'",
            )
            .run(quiescent ? 'stopped' : 'unknown', combined.run_id, attempt.id);
          if (quiescent) {
            this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
            this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
          }
          this.updateCombined(
            combined,
            quiescent ? 'blocked' : 'unknown',
            quiescent ? 'stopped' : 'ownership-unknown',
          );
          this.updateTask(task, {
            state: quiescent ? 'interrupted' : 'unknown',
            waitingReason: null,
            next: 'Combined work was interrupted. No owner will relaunch automatically.',
          });
          continue;
        }
        const phases = this.store.nativeProcesses(intent.attempt_id);
        const native = phases.length > 0;
        const known = native
          ? phases.every((phase) => phase.state !== 'intent')
          : ['acknowledged', 'interrupted'].includes(intent.state);
        let verificationKnown: boolean | undefined;
        if (this.store.receipt(`verification-launch:${attempt.id}`)) {
          try {
            const launch = this.verificationLaunch(attempt.id);
            const journal = inspectCheckRoots(launch.owner);
            verificationKnown =
              !journal.unknown &&
              journal.roots.length > 0 &&
              journal.roots.every(checkRootQuiescent);
          } catch {
            verificationKnown = false;
          }
        }
        let acpKnown: boolean | undefined;
        if (this.store.nativeProfileId(attempt.id) === 'google-acp-v1') {
          acpKnown = false;
          try {
            const done = z
              .object({
                attemptId: AttemptSchema.shape.id,
                quiescent: z.literal(true),
                unspawned: z.literal(true).optional(),
              })
              .parse(this.nativeRecord(`native-completion:${attempt.id}`, 4096).value);
            const noPrompt = !this.store.receipt(`native-submission:${attempt.id}`);
            const closed =
              (done.unspawned === true && !phases.length) ||
              this.store.nativePhasesComplete(attempt.id, 'google');
            let terminal = false;
            if (!noPrompt) {
              const plan = this.nativeCurrentPlan(run);
              const appointment = plan.appointment;
              if (!('acp' in appointment) || plan.attempt.id !== attempt.id)
                throw Error('ACP plan changed.');
              const retained = this.nativeRecord(`native-acp-terminal:${attempt.id}`, 4096);
              const proof = z
                .strictObject({
                  attemptId: AttemptSchema.shape.id,
                  planHash: HashSchema,
                  completionHash: HashSchema,
                  metadataHash: HashSchema,
                })
                .parse(retained.value);
              const metadata = this.nativeRecord(`native-proposal:${attempt.id}`);
              const completion = this.nativeRecord(`native-completion:${attempt.id}`, 4096);
              const output = z
                .strictObject({
                  sessionId: AcpApprovalTargetSchema.shape.sessionId,
                  stopReason: z.enum([
                    'end_turn',
                    'max_tokens',
                    'max_turn_requests',
                    'refusal',
                    'cancelled',
                  ]),
                  submitted: z.literal(true),
                  selectionHash: HashSchema,
                  reviewModeHash: HashSchema,
                  targetHash: HashSchema.optional(),
                })
                .parse(metadata.value);
              terminal =
                proof.attemptId === attempt.id &&
                proof.planHash ===
                  this.nativeRecord(this.currentNativePlanKey(run.id)).artifact.hash &&
                proof.completionHash === completion.artifact.hash &&
                proof.metadataHash === hashCanonical(output) &&
                output.selectionHash === hashCanonical(appointment.acp) &&
                output.reviewModeHash === hashCanonical(appointment.proof.reviewMode);
            }
            acpKnown = done.attemptId === attempt.id && closed && (noPrompt || terminal);
          } catch {}
        }
        const stopped =
          acpKnown ??
          verificationKnown ??
          (known &&
            (native
              ? phases.every((phase) => groupAbsent(phase.process_group))
              : groupAbsent(intent.process_group)));
        // An ACP turn with no terminal proof stays unknown, but not once every group is gone.
        const closed = !stopped && acpKnown === false ? this.shutdownProof(intent) : undefined;
        if (closed) {
          this.settleUnknownWriter(
            intent,
            closed,
            'Controller restarted after every recorded process group exited. The turn has no terminal response.',
          );
          continue;
        }
        const updated = {
          ...attempt,
          state: stopped ? ('stopped' as const) : ('unknown' as const),
          revision: attempt.revision + 1,
        };
        this.store.put('attempt', attempt.id, updated.revision, updated);
        this.store.db
          .prepare('UPDATE launch_intents SET state=?,finished_at=? WHERE attempt_id=?')
          .run(
            stopped ? 'stopped' : acpKnown === false || !known ? 'outcome-unknown' : 'acknowledged',
            stopped ? this.shutdownCharge(intent) : null,
            attempt.id,
          );
        if (stopped) {
          this.store.db.prepare('DELETE FROM writer_leases WHERE attempt_id=?').run(attempt.id);
          this.store.db.prepare('DELETE FROM reservations WHERE attempt_id=?').run(attempt.id);
        }
        this.updateTask(task, {
          state: stopped ? 'interrupted' : 'unknown',
          waitingReason: null,
          next: stopped
            ? 'Retained work is interrupted. Resume explicitly.'
            : 'Launch ownership is ambiguous. Nothing will relaunch automatically.',
        });
        this.event('run.interrupted', task.id, task.revision + 1, {
          runId: run.id,
          reason: stopped
            ? native
              ? 'Controller restarted after every recorded native process group exited.'
              : 'Controller restarted after the process group exited.'
            : 'An intent has no proven completed launch.',
        });
      }
      for (const intent of this.store
        .intents()
        .filter(
          (row) =>
            row.state === 'stopped' &&
            this.store.nativeProfileId(row.attempt_id) === 'google-acp-v1',
        )) {
        const task = this.store.get<Task>('task', intent.task_id);
        if (task && ['running', 'stopping', 'waiting'].includes(task.state)) {
          this.closePendingEffects(task);
          this.updateTask(task, {
            state: 'interrupted',
            waitingReason: null,
            next: 'Native work was interrupted after recorded closure. Inspect retained evidence.',
          });
        }
      }
    });
  }
}
