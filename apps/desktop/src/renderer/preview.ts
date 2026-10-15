import {
  type Approval,
  type Attempt,
  type CommandResult,
  canonicalJson,
  type Event,
  type HandoffPacket,
  type Run,
  type Task,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestIds, DEMO_TIME } from '@crewkite/testkit';
import type { DesktopCommand, DesktopSource } from './source.ts';

async function hash(value: unknown) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function createPreviewSource(): DesktopSource {
  const fixtures = createDemoFixtures();
  const state = structuredClone(fixtures.snapshot);
  state.tasks = [structuredClone(fixtures.task)];
  const id = createTestIds(DEMO_TIME, 1000n);
  const listeners = new Set<(event: Event) => void>();
  let cursor = 0n;
  let diff = '';
  function emit(type: Event['type'], payload: unknown, task: Task) {
    cursor += 1n;
    state.cursor = cursor.toString();
    const event = {
      protocol: 1,
      id: id('evt'),
      cursor: state.cursor,
      at: DEMO_TIME,
      taskId: task.id,
      revision: task.revision,
      type,
      payload,
    } as Event;
    for (const listener of listeners) listener(structuredClone(event));
  }
  function update(task: Task, change: Partial<Task>) {
    Object.assign(task, change, { revision: task.revision + 1 });
    emit('task.updated', task, task);
  }
  const applied = (entity?: Task | Run | Approval): CommandResult => ({
    outcome: 'applied',
    ...(entity ? { entity, revision: entity.revision } : {}),
  });
  async function command(input: DesktopCommand): Promise<CommandResult> {
    const taskId =
      'taskId' in input.payload
        ? input.payload.taskId
        : input.command === 'ResolveApproval'
          ? input.payload.binding.taskId
          : null;
    const task = state.tasks.find(({ id }) => id === taskId);
    if ('expectedRevision' in input && task && input.expectedRevision !== task.revision) {
      return {
        outcome: 'stale-revision',
        reason: 'The task changed. Refresh before trying again.',
        revision: task.revision,
      };
    }
    switch (input.command) {
      case 'CreateTask': {
        const created: Task = {
          ...input.payload,
          id: id('tsk'),
          state: 'draft',
          waitingReason: null,
          revision: 0,
          runId: null,
          next: 'Prepare the run.',
        };
        state.tasks.push(created);
        emit('task.created', created, created);
        return applied(created);
      }
      case 'InspectSource':
        return {
          outcome: 'applied',
          data: {
            kind: 'source',
            source: {
              projectId: input.payload.projectId,
              base: 'a'.repeat(40),
              branch: 'main',
              dirtyCount: 2,
              untrackedCount: 1,
            },
          },
        };
      case 'PrepareRun': {
        if (!task) break;
        const source = {
          projectId: task.projectId,
          base: 'a'.repeat(40),
          branch: 'main',
          dirtyCount: 2,
          untrackedCount: 1,
        };
        const run: Run = {
          id: id('run'),
          taskId: task.id,
          source,
          policy: { policy: input.payload.policy, hash: await hash(input.payload.policy) },
          roles: input.payload.roles,
          decision: {
            chosen: input.payload.roles[0].routeId,
            rejected: [],
            rule: 'percentage',
            inputsHash: await hash(input.payload),
          },
          revision: 0,
        };
        state.runs.push(run);
        update(task, { runId: run.id, next: 'Review the prepared run, then start.' });
        emit('run.prepared', run, task);
        return applied(run);
      }
      case 'StartRun':
      case 'ResumeRun': {
        if (!task) break;
        const run = state.runs.find(({ id }) => id === input.payload.runId);
        if (!run?.decision.chosen) break;
        const attempt: Attempt = {
          id: id('att'),
          runId: run.id,
          routeId: run.decision.chosen,
          generation: 1,
          state: 'running',
          revision: 0,
        };
        state.attempts.push(attempt);
        emit('run.admitted', run, task);
        emit('attempt.launched', attempt, task);
        emit(
          'attempt.output',
          {
            attemptId: attempt.id,
            generation: 1,
            channel: 'stdout',
            text: 'Preview: an isolated worker would retain net.mjs here. No process was launched.',
          },
          task,
        );
        const approval: Approval = {
          approvalId: id('apr'),
          taskId: task.id,
          attemptId: attempt.id,
          generation: 1,
          action: 'run-check',
          target: 'node --test',
          revision: 0,
          requester: 'Scripted worker',
          consequence: 'Run checks against a fresh copy of the retained candidate.',
          status: 'pending',
        };
        state.approvals.push(approval);
        update(task, {
          state: 'waiting',
          waitingReason: 'approval',
          next: 'Approve or deny the pending check.',
        });
        emit('approval.requested', approval, task);
        return applied(task);
      }
      case 'ResolveApproval': {
        if (!task) break;
        const approval = state.approvals.find(
          ({ approvalId }) => approvalId === input.payload.binding.approvalId,
        );
        if (approval?.status !== 'pending') break;
        approval.status = input.payload.decision;
        approval.revision += 1;
        emit('approval.resolved', approval, task);
        const attempt = state.attempts.find(({ id }) => id === approval.attemptId);
        const run = state.runs.find(({ id }) => id === task.runId);
        if (!attempt || !run) break;
        attempt.state = 'stopped';
        emit('attempt.stopped', attempt, task);
        if (approval.status === 'denied') {
          update(task, {
            state: 'stopped',
            waitingReason: null,
            next: 'The preview action was denied.',
          });
          return applied(approval);
        }
        const observation = state.usage.find(
          ({ observation }) => observation.routeId === attempt.routeId,
        );
        if (observation?.observation.remaining) {
          observation.observation.remaining.value = 5;
          emit('usage.observed', observation.observation, task);
        }
        emit(
          'route.reserve_reached',
          {
            routeId: attempt.routeId,
            windowId: 'weekly',
            reason: 'The preview route reached its 5% reserve.',
          },
          task,
        );
        const packet: HandoffPacket = {
          version: 1,
          id: id('hnd'),
          taskId: task.id,
          runId: run.id,
          attemptId: attempt.id,
          generation: 1,
          outcome: task.outcome,
          criteria: task.criteria,
          decisions: ['Preview only; no provider process or checks ran.'],
          deniedActions: [],
          source: run.source,
          candidate: null,
          artifacts: [],
          unfinished: ['Run actual checks'],
          unverified: ['The preview edit'],
          failedChecks: [],
          unrunChecks: ['node --test'],
          scope: ['net.mjs'],
          remainingBudgets: { attempts: 3, minutes: 30, concurrency: 1 },
          unresolvedExposure: [],
          policy: run.policy,
          allowedRouteIds: run.roles[0].approvedFallbacks,
          createdAt: DEMO_TIME,
        };
        emit('handoff.sealed', { packet, checksum: await hash(packet) }, task);
        diff =
          "diff --git a/net.mjs b/net.mjs\n--- a/net.mjs\n+++ b/net.mjs\n@@ -1,3 +1,6 @@\n-export function netMinor() {\n-  throw new Error('netMinor is not implemented.');\n+export function netMinor(subtotalMinor, discountMinor) {\n+  if (![subtotalMinor, discountMinor].every((value) => Number.isSafeInteger(value) && value >= 0)) {\n+    throw new RangeError('Amounts must be non-negative safe integers.');\n+  }\n+  return Math.max(0, subtotalMinor - discountMinor);\n }\n";
        update(task, {
          state: 'stopped',
          waitingReason: null,
          next: 'Inspect the preview edit. Connect the controller for real execution and checks.',
        });
        return applied(approval);
      }
      case 'StopRun': {
        if (!task) break;
        update(task, {
          state: 'stopped',
          waitingReason: null,
          next: 'Preview stopped. Retained data remains visible.',
        });
        return applied(task);
      }
      case 'GetChanges':
        return {
          outcome: 'applied',
          data: {
            kind: 'changes',
            taskId: input.payload.taskId,
            candidateId: null,
            artifactId: id('art'),
            files: diff
              ? [
                  {
                    path: 'net.mjs',
                    status: 'modified',
                    binary: false,
                    oversized: false,
                    additions: 5,
                    deletions: 2,
                  },
                ]
              : [],
            diff,
            truncated: false,
          },
        };
      case 'GetSnapshot':
        return { outcome: 'applied', data: { kind: 'snapshot', snapshot: structuredClone(state) } };
      default:
        return {
          outcome: 'unsupported',
          reason: 'This action needs the connected controller.',
          next: 'Open the desktop demo.',
        };
    }
    return { outcome: 'blocked', reason: 'The preview task or run could not be found.' };
  }
  return {
    getSnapshot: async () => structuredClone(state),
    command,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onConnection(listener) {
      listener('connected');
      return () => {};
    },
  };
}
