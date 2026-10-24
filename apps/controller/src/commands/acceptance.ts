import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Approval,
  type Artifact,
  type Attempt,
  type Candidate,
  CheckResultSchema,
  type Command,
  type CommandResult,
  CommandResultSchema,
  CommandSchema,
  canonicalJson,
  EventSchema,
  MAX_FRAME_BYTES,
  type Route,
  type Run,
  RunSchema,
  type SealedHandoffPacket,
  type Task,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { buildHandoff } from '../continuity/index.ts';
import {
  applyPublication,
  type GitIdentity,
  preparePublication,
  refValue,
  validateIdentity,
} from '../host/publication.ts';
import { committedFiles, inspectSource, materialize } from '../host/source.ts';
import type { Controller } from './controller.ts';

// Route switches, resume, transfer, acceptance, publication and patch export.
export class AcceptanceCommands {
  contextPacket(
    this: Controller,
    writer: Attempt,
    candidate: Candidate,
    checked: boolean,
    manualNativeRouteIds?: readonly string[],
  ): SealedHandoffPacket {
    const run = this.store.get<Run>('run', writer.runId) as Run;
    const task = this.store.get<Task>('task', run.taskId) as Task;
    if (this.hasUncertainWriter(task.id)) throw new Error('Context sealing requires quiescence.');
    const packet = buildHandoff({
      run,
      outgoing: writer,
      quiescent: true,
      ...(manualNativeRouteIds ? { manualNativeRouteIds } : {}),
      packet: {
        version: 1,
        id: this.id('hnd'),
        taskId: task.id,
        runId: run.id,
        attemptId: writer.id,
        generation: writer.generation,
        outcome: task.outcome,
        criteria: task.criteria,
        decisions: [
          checked
            ? 'Stopped at the configured reserve. Exact candidate checks passed.'
            : 'Retained bytes were captured after positive process-group absence. Current checks and selected reviews remain required.',
        ],
        deniedActions: this.store
          .list<Approval>('approval')
          .filter((approval) => approval.taskId === task.id && approval.status === 'denied')
          .map(({ action, target }) => ({ action, target })),
        source: run.source,
        candidate,
        artifacts: this.taskArtifacts(task.id),
        unfinished: ['Continue the saved task inside its bounded run.'],
        unverified: checked
          ? ['Final selected reviews are pending.']
          : ['Retained partial work needs current checks and selected reviews.'],
        failedChecks: this.checks(candidate)
          .filter((check) => !check.passed)
          .map((check) => check.definitionHash),
        unrunChecks: checked ? [] : ['node --test'],
        scope: [task.title],
        remainingBudgets: this.remaining(run),
        unresolvedExposure: [],
        policy: run.policy,
        allowedRouteIds: manualNativeRouteIds
          ? [...manualNativeRouteIds]
          : [...new Set(run.roles.flatMap((role) => [role.routeId, ...role.approvedFallbacks]))],
        createdAt: this.now(),
      },
    });
    if (Buffer.byteLength(canonicalJson(packet)) > MAX_FRAME_BYTES - 65536)
      throw new Error('The handoff context exceeds its bounded worker frame.');
    return packet;
  }

  pendingSwitch(this: Controller, run: Run): string | undefined {
    const receipt = this.store.receipt(`switch:${run.id}`);
    if (receipt?.result.outcome !== 'outcome-unknown') return;
    const frozen = RunSchema.parse(receipt.result.entity);
    if (
      frozen.id !== run.id ||
      frozen.taskId !== run.taskId ||
      hashCanonical({ source: frozen.source, policy: frozen.policy, roles: frozen.roles }) !==
        hashCanonical({ source: run.source, policy: run.policy, roles: run.roles })
    )
      throw new Error('The saved switch no longer matches this run.');
    return frozen.decision.chosen ?? undefined;
  }

  switchRoute(
    this: Controller,
    command: Extract<Command, { command: 'SwitchRoute' }>,
    effects: (() => void)[],
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId);
    const run = this.store.get<Run>('run', command.payload.runId);
    if (!task || !run || task.runId !== run.id || run.taskId !== task.id)
      return { outcome: 'blocked', reason: 'run-not-current' };
    const coder = run.roles.find((role) => role.role === 'coder');
    const target = command.payload.routeId;
    if (!coder || ![coder.routeId, ...coder.approvedFallbacks].includes(target))
      return {
        outcome: 'denied',
        reason: 'route-not-approved',
        next: 'Choose a saved coder route or prepare a new bounded run.',
      };
    if (this.pendingSwitch(run))
      return {
        outcome: 'blocked',
        reason: 'switch-already-pending',
        next: 'Resume to recheck the saved target, or stop to cancel it.',
      };
    const last = this.store
      .intents()
      .filter((intent) => intent.run_id === run.id)
      .at(-1);
    if (last && last.scratch_path !== join(this.home, 'scratch', run.id))
      return {
        outcome: 'blocked',
        reason: 'pending-evaluator-stage',
        next: 'Stop the check or review explicitly. A route switch cannot replace it with a coder.',
      };
    if (task.state === 'unknown')
      return {
        outcome: 'blocked',
        reason: 'writer-ownership-unknown',
        next: 'Prove the prior process group is gone before switching.',
      };
    if (!last || !['running', 'waiting', 'stopped', 'interrupted'].includes(task.state))
      return {
        outcome: 'blocked',
        reason: 'switch-needs-writer',
        next: 'Switch only an active or stopped coding attempt in the current run.',
      };
    if (this.store.receipt(`native-run:${run.id}`))
      return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
    const runtime = this.workers.get(last.attempt_id);
    if (last.state !== 'stopped' && !runtime)
      return {
        outcome: 'blocked',
        reason: 'writer-ownership-unknown',
        next: 'Prove the outgoing process group is gone before switching.',
      };
    if (last.route_id === target)
      return {
        outcome: 'blocked',
        reason: 'route-already-current',
        next: 'Choose another saved coder route.',
      };
    const route = this.store.get<Route>('route', target);
    if (!route?.fake || !route.qualified)
      return {
        outcome: 'blocked',
        reason: 'route-not-admissible',
        next: 'Choose a qualified scripted route.',
      };
    // Preflight excludes only this writer's held capacity. Admission repeats after proven stop.
    if (!this.routing(run, 'coder', target, runtime ? last.attempt_id : undefined).chosen)
      return {
        outcome: 'blocked',
        reason: 'route-not-admissible',
        next: `Selected route ${target} cannot pass the saved pin, allowance or slot gates. The current writer keeps its ownership.`,
      };
    this.closePendingEffects(task);
    this.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run(`switch:${run.id}`);
    this.store.saveReceipt(
      `switch:${run.id}`,
      hashCanonical({ runId: run.id, target }),
      'local-owner',
      {
        outcome: 'outcome-unknown',
        entity: {
          ...run,
          decision: {
            chosen: target,
            rejected: [],
            rule: 'manual',
            inputsHash: hashCanonical({ runId: run.id, target }),
          },
        },
      },
    );
    const updated = this.updateTask(task, {
      state: runtime ? 'stopping' : 'stopped',
      waitingReason: null,
      next: `Selected route ${target} is saved. Stop the outgoing writer, then recheck the original policy and remaining limits.`,
    });
    const writer = this.store.get<Attempt>('attempt', last.attempt_id) as Attempt;
    if (runtime?.kind === 'native')
      return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
    if (runtime) {
      runtime.reason = 'switch';
      effects.push(() => {
        void runtime.worker
          .stop({ schedule: this.options.schedule })
          .then((exit) => this.finishAttempt(writer.id, exit.quiescent));
      });
    } else effects.push(() => this.continueSwitch(writer));
    return { outcome: 'applied', entity: updated, revision: updated.revision };
  }

  continueSwitch(this: Controller, writer: Attempt) {
    if (this.closed || this.store.receipt(`native-run:${writer.runId}`)) return;
    const run = this.store.get<Run>('run', writer.runId) as Run;
    const target = this.pendingSwitch(run);
    if (!target) return;
    try {
      this.prepareResumeContext(run.taskId, run.id);
    } catch {
      this.store.transaction(() =>
        this.updateTask(this.store.get<Task>('task', run.taskId) as Task, {
          state: 'stopped',
          waitingReason: null,
          next: `Selected route ${target} has no readable retained context. Inspect the saved work, then resume to retry or stop to cancel.`,
        }),
      );
      return;
    }
    const effects: (() => void)[] = [];
    this.store.transaction(() => {
      const task = this.store.get<Task>('task', run.taskId) as Task;
      if (this.store.receipt(`paused:${run.id}`)) {
        this.updateTask(task, {
          state: 'stopped',
          waitingReason: null,
          next: `Selected route ${target} is retained. Admissions are paused. Resume explicitly to recheck, or stop to cancel.`,
        });
        return;
      }
      const command = CommandSchema.parse({
        protocol: 1,
        key: this.id('cmd'),
        actor: { id: 'controller', kind: 'controller' },
        command: 'ResumeRun',
        expectedRevision: task.revision,
        payload: { taskId: task.id, runId: run.id },
      });
      const result = this.start(command as Extract<Command, { command: 'ResumeRun' }>, effects);
      if (result.outcome !== 'applied')
        this.updateTask(this.store.get<Task>('task', task.id) as Task, {
          state: 'stopped',
          waitingReason: null,
          next:
            result.next ??
            'The saved target could not be admitted. Resume to recheck, or stop to cancel the switch.',
        });
    });
    for (const effect of effects) effect();
  }

  resumeGate(this: Controller, task: Task, runId: string): CommandResult | undefined {
    const pending = this.store.db
      .prepare(
        "SELECT approval_id FROM pending_effects WHERE task_id=? AND state='pending' LIMIT 1",
      )
      .get(task.id);
    if (pending)
      return {
        outcome: 'blocked',
        reason: 'approval-already-pending',
        next: 'Resolve the exact pending action before continuing.',
      };
    const last = this.store
      .intents()
      .filter((intent) => intent.run_id === runId)
      .at(-1);
    if (
      task.state === 'waiting' ||
      (last && last.scratch_path !== join(this.home, 'scratch', runId))
    )
      return {
        outcome: 'blocked',
        reason: 'pending-evaluator-stage',
        next: 'Inspect or export retained work, then stop and prepare a new bounded run for the pending checks or review.',
      };
  }

  prepareResumeContext(this: Controller, taskId: string, runId: string) {
    if (this.store.receipt(`native-run:${runId}`))
      throw new Error('The native pilot permits retention and export only.');
    const task = this.store.get<Task>('task', taskId);
    const run = this.store.get<Run>('run', runId);
    if (
      !task ||
      !run ||
      task.runId !== run.id ||
      run.taskId !== task.id ||
      this.hasUncertainWriter(taskId)
    )
      return;
    const intent = this.store
      .intents()
      .filter(
        (value) =>
          value.run_id === runId && value.scratch_path === join(this.home, 'scratch', runId),
      )
      .at(-1);
    if (!intent) return;
    const writer = this.store.get<Attempt>('attempt', intent.attempt_id) as Attempt;
    if (writer.state !== 'stopped') throw new Error('The prior writer is not stopped.');
    if (!existsSync(intent.scratch_path)) {
      const candidate = this.store.receipt(`candidate:${writer.id}`)?.result.entity as
        | Candidate
        | undefined;
      if (!candidate) throw new Error('No sealed retained bytes exist for this writer.');
      materialize(intent.scratch_path, this.evidence.read(candidate).files);
    }
    const candidate = this.sealCandidate(writer);
    const packet = this.contextPacket(writer, candidate, false);
    this.store.transaction(() => this.event('handoff.sealed', task.id, task.revision, packet));
  }

  latestContext(this: Controller, runId: string): SealedHandoffPacket | undefined {
    const row = this.store.db
      .prepare(
        "SELECT body FROM events WHERE json_extract(body,'$.type')='handoff.sealed' AND json_extract(body,'$.payload.packet.runId')=? ORDER BY cursor DESC LIMIT 1",
      )
      .get(runId);
    if (!row) return;
    const event = EventSchema.parse(JSON.parse(row.body as string));
    return event.type === 'handoff.sealed' ? event.payload : undefined;
  }

  transfer(this: Controller, writer: Attempt, candidate: Candidate) {
    const run = this.store.get<Run>('run', writer.runId) as Run;
    const task = this.store.get<Task>('task', run.taskId) as Task;
    if (this.store.receipt(`native-run:${run.id}`))
      throw new Error('The native pilot permits retention and export only.');
    if (this.hasUncertainWriter(task.id)) throw new Error('Handoff requires quiescence.');
    const outgoing = this.store.get<Attempt>('attempt', writer.id) as Attempt;
    const packet = this.contextPacket(outgoing, candidate, true);
    const effects: (() => void)[] = [];
    this.store.transaction(() => {
      this.event('handoff.sealed', task.id, task.revision, packet);
      const stopped = this.updateTask(task, {
        state: 'stopped',
        waitingReason: null,
        next: 'The handoff is sealed. Admitting the successor through the saved policy.',
      });
      const command = CommandSchema.parse({
        protocol: 1,
        key: this.id('cmd'),
        actor: { id: 'controller', kind: 'controller' },
        command: 'ResumeRun',
        expectedRevision: stopped.revision,
        payload: { taskId: task.id, runId: run.id },
      });
      const result = this.start(
        command as Extract<Command, { command: 'ResumeRun' }>,
        effects,
        undefined,
        undefined,
        true,
      );
      if (result.outcome !== 'applied')
        this.updateTask(this.store.get<Task>('task', task.id) as Task, {
          state: 'waiting',
          waitingReason: 'capacity',
          next: result.next ?? result.reason ?? 'No successor route is available.',
        });
    });
    for (const effect of effects) effect();
  }

  accept(
    this: Controller,
    command: Extract<Command, { command: 'AcceptCandidate' }>,
    effects: (() => void)[],
    approved?: string,
    frozenIdentity?: GitIdentity,
    frozenAt?: string,
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId) as Task;
    const run = this.store.get<Run>('run', task.runId as string) as Run;
    const candidate = this.store.get<Candidate>(
      'candidate',
      command.payload.candidateId,
    ) as Candidate;
    const group = this.store.combinedGroup(run.id);
    let combined: ReturnType<Controller['combinedPublicationEvidence']> | undefined;
    if (group?.run_id === run.id) {
      try {
        combined = this.combinedPublicationEvidence(group, candidate);
      } catch {
        return { outcome: 'blocked', reason: 'combined-final-evidence-incomplete' };
      }
    }
    let native: ReturnType<Controller['nativePublicationEvidence']> | undefined;
    if (this.store.receipt(`native-run:${run.id}`)) {
      try {
        native = this.nativePublicationEvidence(run, candidate);
      } catch {
        return { outcome: 'blocked', reason: 'native-pilot-retain-only' };
      }
    }
    if (!['ready', 'accepted', 'waiting', ...(native ? ['stopped'] : [])].includes(task.state))
      return { outcome: 'blocked', reason: 'candidate-not-ready' };
    if (this.hasUncertainWriter(task.id) || !this.candidateCurrent(run, candidate))
      return { outcome: 'blocked', reason: 'candidate-binding-changed' };
    const path = this.projectPath(task.projectId) as string;
    if (hashCanonical(inspectSource(task.projectId, path)) !== hashCanonical(run.source))
      return { outcome: 'blocked', reason: 'source-preview-changed' };
    const prior = this.store.db
      .prepare('SELECT * FROM publications WHERE candidate_id=?')
      .get(candidate.id);
    if (prior) {
      if (
        prior.destination_ref !== command.payload.destinationRef ||
        prior.candidate_hash !== candidate.hash
      )
        return { outcome: 'denied', reason: 'publication-binding-changed' };
      effects.push(() => this.reconcilePublication(candidate.id, command.key));
      return {
        outcome: 'outcome-unknown',
        reason: 'publication-prepared',
        next: 'Recover this exact publication before creating another branch.',
      };
    }
    if (refValue(path, command.payload.destinationRef) !== null)
      return {
        outcome: 'blocked',
        reason: 'destination-ref-exists',
        next: 'Choose an unused local branch name.',
      };
    if (native) {
      try {
        this.nativePublicationCurrent(run, candidate, native);
      } catch {
        return { outcome: 'blocked', reason: 'native-evidence-not-current' };
      }
    } else if (!combined) {
      const plan = this.evidence.prepareChecks({
        candidate,
        sourceFiles: committedFiles(path, run.source.base),
        criteria: task.criteria,
      });
      if (!this.checks(candidate).some((check) => this.checkMatches(check, candidate, plan)))
        return { outcome: 'blocked', reason: 'checks-not-current' };
      const reviews = this.store.db
        .prepare(
          "SELECT body FROM evidence WHERE candidate_id=? AND candidate_hash=? AND kind='review'",
        )
        .all(candidate.id, candidate.hash)
        .map((row) => CheckResultSchema.parse(JSON.parse(row.body as string)));
      for (const method of run.policy.policy.methods ?? [])
        for (let cycle = 1; cycle <= method.cycles; cycle++)
          if (!reviews.some((check) => this.reviewMatches(check, run, method, cycle, candidate)))
            return { outcome: 'blocked', reason: 'selected-review-not-complete' };
    }
    const identity =
      frozenIdentity ??
      (typeof this.options.identity === 'function'
        ? this.options.identity()
        : this.options.identity);
    if (!identity)
      return {
        outcome: 'blocked',
        reason: 'git-identity-missing',
        next: 'Configure a Git name and email before acceptance.',
      };
    validateIdentity(identity);
    const at = frozenAt ?? this.now();
    const grant = this.grant(run, 'accept-candidate', command.payload.destinationRef);
    const writerIntent = this.store
      .intents()
      .filter(
        (intent) => intent.run_id === run.id && intent.scratch_path === this.writerScratch(run),
      )
      .at(-1);
    const writer =
      combined?.attempt ??
      native?.writer ??
      (writerIntent ? this.store.get<Attempt>('attempt', writerIntent.attempt_id) : undefined);
    if (!writer) return { outcome: 'blocked', reason: 'candidate-origin-missing' };
    if (!grant && !approved)
      return this.requestAction(
        task,
        run,
        writer,
        'accept-candidate',
        command.payload.destinationRef,
        {
          kind: 'accept',
          command,
          candidateId: candidate.id,
          candidateHash: candidate.hash,
          identity,
          at,
        },
      );
    const repository = mkdtempSync(join(this.home, 'publication-'));
    const prepared = preparePublication({
      source: path,
      repository,
      base: run.source.base,
      files: this.evidence.read(candidate).files,
      identity,
      at,
    });
    const artifact = {
      id: this.id('art'),
      ...this.artifacts.publish(prepared.pack),
      mediaType: 'application/vnd.git.pack',
    };
    this.saveArtifacts([artifact]);
    this.store.saveReceipt(
      `publication-run:${candidate.id}`,
      hashCanonical({
        runId: run.id,
        candidateHash: candidate.hash,
        identity,
        at,
        destinationRef: command.payload.destinationRef,
      }),
      'local-owner',
      { outcome: 'applied', entity: run },
    );
    this.store.saveReceipt(`publication-pack:${candidate.id}`, artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
    this.store.db
      .prepare(
        "INSERT INTO publications(candidate_id,project_id,destination_ref,candidate_hash,tree_oid,commit_oid,state) VALUES (?,?,?,?,?,?,'prepared')",
      )
      .run(
        candidate.id,
        task.projectId,
        command.payload.destinationRef,
        candidate.hash,
        prepared.treeOid,
        prepared.commitOid,
      );
    if (grant) this.consumeGrant(run, grant);
    if (approved)
      this.store.db
        .prepare("UPDATE pending_effects SET state='applied' WHERE approval_id=?")
        .run(approved);
    effects.push(() => this.reconcilePublication(candidate.id, command.key));
    return {
      outcome: 'outcome-unknown',
      reason: 'publication-prepared',
      next: 'Read the exact publication result before retrying.',
    };
  }

  reconcilePublication(this: Controller, candidateId: string, resultKey?: string) {
    const publication = this.store.db
      .prepare('SELECT * FROM publications WHERE candidate_id=?')
      .get(candidateId);
    if (!publication) return;
    const candidate = this.store.get<Candidate>('candidate', candidateId) as Candidate;
    const task = this.store.get<Task>('task', candidate.taskId) as Task;
    try {
      if (this.hasUncertainWriter(task.id)) throw new Error('Writer ownership is unknown.');
      const artifact = this.store.receipt(`publication-pack:${candidateId}`)?.result.entity as
        | Artifact
        | undefined;
      if (!artifact || !this.store.get<Artifact>('artifact', artifact.id))
        throw new Error('Publication bytes are missing.');
      const origin = this.store.receipt(`publication-run:${candidateId}`)?.result.entity as
        | Run
        | undefined;
      const native =
        origin && this.store.receipt(`native-run:${origin.id}`)
          ? this.nativePublicationEvidence(origin, candidate)
          : undefined;
      const source = this.projectPath(task.projectId) as string;
      const observed = refValue(source, publication.destination_ref as string);
      if (observed !== publication.commit_oid) {
        const currentRun = task.runId ? this.store.get<Run>('run', task.runId) : undefined;
        if (
          !origin ||
          !currentRun ||
          origin.id !== currentRun.id ||
          hashCanonical(origin.policy) !== hashCanonical(currentRun.policy) ||
          hashCanonical(origin.source) !== hashCanonical(currentRun.source) ||
          this.latestCandidate(currentRun.id)?.id !== candidate.id ||
          !this.candidateCurrent(currentRun, candidate) ||
          hashCanonical(inspectSource(task.projectId, source)) !== hashCanonical(origin.source)
        )
          throw new Error('Prepared publication authority is no longer current.');
        if (native) this.nativePublicationCurrent(currentRun, candidate, native);
        const group = this.store.combinedGroup(currentRun.id);
        if (group?.run_id === currentRun.id) this.combinedPublicationEvidence(group, candidate);
      }
      applyPublication({
        source: this.projectPath(task.projectId) as string,
        pack: this.artifacts.read(artifact.hash),
        destinationRef: publication.destination_ref as string,
        treeOid: publication.tree_oid as string,
        commitOid: publication.commit_oid as string,
        base: this.evidence.read(candidate).base,
      });
      this.store.transaction(() => {
        this.store.db
          .prepare("UPDATE publications SET state='applied' WHERE candidate_id=?")
          .run(candidateId);
        const current = this.store.get<Task>('task', task.id) as Task;
        const belongs =
          !!origin &&
          current.runId === origin.id &&
          this.latestCandidate(origin.id)?.id === candidate.id;
        const updated =
          belongs && current.state !== 'accepted'
            ? this.updateTask(current, {
                state: 'accepted',
                waitingReason: null,
                next: `Accepted to ${publication.destination_ref as string}.`,
              })
            : current;
        const group = origin ? this.store.combinedGroup(origin.id) : undefined;
        if (belongs && group?.run_id === origin?.id) this.updateCombined(group, 'accepted');
        if (belongs && current.state !== 'accepted')
          this.event('candidate.accepted', task.id, updated.revision, {
            candidateId,
            destinationRef: publication.destination_ref as string,
          });
        if (resultKey)
          this.store.db.prepare('UPDATE receipts SET result=? WHERE command_key=?').run(
            canonicalJson(
              CommandResultSchema.parse(
                belongs
                  ? { outcome: 'applied', entity: updated, revision: updated.revision }
                  : {
                      outcome: 'applied',
                      entity: candidate,
                      next: 'The prior publication was verified. The current run keeps its state.',
                    },
              ),
            ),
            resultKey,
          );
      });
    } catch {
      if (resultKey)
        this.store.transaction(() => {
          this.store.db.prepare('UPDATE receipts SET result=? WHERE command_key=?').run(
            canonicalJson({
              outcome: 'outcome-unknown',
              reason: 'publication-not-reconciled',
              next: 'Inspect the exact destination branch and retry this command key.',
            }),
            resultKey,
          );
        });
    }
  }

  exportPatch(
    this: Controller,
    command: Extract<Command, { command: 'ExportPatch' }>,
    approved?: string,
  ): CommandResult {
    const task = this.store.get<Task>('task', command.payload.taskId) as Task;
    const run = this.store.get<Run>('run', task.runId as string) as Run;
    const candidate = this.store.get<Candidate>(
      'candidate',
      command.payload.candidateId,
    ) as Candidate;
    const grant = this.grant(run, 'export-patch', task.id);
    if (!grant && !approved) {
      const group = this.store.combinedGroup(run.id);
      if (group?.run_id === run.id) {
        this.combinedOrigin(group, candidate);
        const slot = [...this.store.combinedDispatches(group.run_id)]
          .reverse()
          .find(
            (slot) =>
              ['review', 'final-check', 'replay-1'].includes(slot.phase) && slot.state === 'passed',
          );
        const owner = slot?.attempt_id
          ? this.store.get<Attempt>('attempt', slot.attempt_id)
          : undefined;
        if (!owner || owner.runId !== run.id || owner.state !== 'stopped')
          return { outcome: 'blocked', reason: 'candidate-origin-missing' };
        return this.requestAction(task, run, owner, 'export-patch', task.id, {
          kind: 'export',
          command,
          candidateId: candidate.id,
          candidateHash: candidate.hash,
        });
      }
      const writer = this.store
        .intents()
        .filter(
          (intent) => intent.run_id === run.id && intent.scratch_path === this.writerScratch(run),
        )
        .at(-1);
      if (!writer) return { outcome: 'blocked', reason: 'candidate-origin-missing' };
      return this.requestAction(
        task,
        run,
        this.store.get<Attempt>('attempt', writer.attempt_id) as Attempt,
        'export-patch',
        task.id,
        { kind: 'export', command, candidateId: candidate.id, candidateHash: candidate.hash },
      );
    }
    const data = this.store.receipt(`changes:${candidate.id}`)?.result.data;
    if (data?.kind !== 'changes') return { outcome: 'blocked', reason: 'patch-not-ready' };
    const artifact = this.store.get<Artifact>('artifact', data.artifactId);
    if (!artifact) return { outcome: 'blocked', reason: 'patch-artifact-missing' };
    this.artifacts.read(artifact.hash);
    if (grant) this.consumeGrant(run, grant);
    if (approved)
      this.store.db
        .prepare("UPDATE pending_effects SET state='applied' WHERE approval_id=?")
        .run(approved);
    this.event('export.created', task.id, task.revision, artifact);
    return { outcome: 'applied', entity: artifact };
  }
}
