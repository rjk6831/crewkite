import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { type FakeWorkerEvent, type FakeWorkerInput, MAX_FRAME_BYTES } from '@crewkite/contracts';
import { hashCanonical, verifyHandoff } from '@crewkite/contracts/hash';
import { writeChallengeSolution } from '../repository.ts';
import { FakeWorkerEventSchema, FakeWorkerInputSchema } from './protocol.ts';

function emit(event: FakeWorkerEvent) {
  process.stdout.write(`${JSON.stringify(FakeWorkerEventSchema.parse(event))}\n`);
}

function runStubbornChild() {
  // A referenced port keeps the writer alive without a timer or network listener.
  const { port1, port2 } = new MessageChannel();
  port1.on('message', () => {});
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  process.on('SIGUSR2', () => {
    port1.close();
    port2.close();
    process.exit(0);
  });
  process.send?.(process.pid);
}

function runWorker() {
  let start: Extract<FakeWorkerInput, { type: 'start' }> | undefined;
  let pending = Buffer.alloc(0);
  let processing = Promise.resolve();
  let finished = false;
  let approvalPending = false;
  let descendantPid: number | undefined;

  function fail(error: unknown) {
    finished = true;
    if (descendantPid) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {}
    }
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid worker input.'}\n`);
    process.exitCode = 2;
    process.stdin.destroy();
  }
  function terminal(outcome: 'completed' | 'stopped' | 'failed', reason: string) {
    finished = true;
    emit({ type: 'terminal', outcome, reason });
    process.stdin.destroy();
    process.exitCode = outcome === 'failed' ? 1 : 0;
  }
  function checkpoint() {
    emit({ type: 'checkpoint', summary: 'net.mjs contains retained edits. Checks have not run.' });
  }
  function reserveReached() {
    const routeId = process.env.CREWKITE_FAKE_ROUTE_ID;
    const observedAt = process.env.CREWKITE_FAKE_OBSERVED_AT;
    if (!routeId || !observedAt) {
      throw new Error('Reserve scenario requires route and observation time.');
    }
    emit({
      type: 'usage',
      observation: {
        routeId,
        windowId: 'weekly',
        kind: 'weekly',
        remaining: { value: 5, unit: 'percent' },
        resetsAt: null,
        observedAt,
        source: 'fixture',
        confidence: 'reported',
      },
    });
  }
  async function receive(input: FakeWorkerInput) {
    if (finished) throw new Error('Worker already reached a terminal state.');
    if (input.type === 'start') {
      if (start) throw new Error('Worker accepts one start binding.');
      if (input.generation > 0 && !input.handoff)
        throw new Error('A successor requires sealed handoff context.');
      if (input.handoff) {
        const { packet } = input.handoff;
        const candidate = packet.candidate;
        const artifact = packet.artifacts.find(({ id }) => id === candidate?.artifactId);
        // The controller owns admission and current bytes. This verifies the received context.
        if (
          !verifyHandoff(input.handoff) ||
          packet.generation + 1 !== input.generation ||
          packet.attemptId === input.attemptId ||
          packet.outcome !== input.outcome ||
          !candidate ||
          candidate.taskId !== packet.taskId ||
          artifact?.hash !== candidate.hash ||
          hashCanonical(packet.policy.policy) !== packet.policy.hash ||
          packet.policy.policy.effects.some((grant) => grant.taskId !== packet.taskId) ||
          !packet.allowedRouteIds.includes(process.env.CREWKITE_FAKE_ROUTE_ID ?? '')
        )
          throw new Error('Successor handoff context is invalid.');
      }
      start = input;
      emit({ type: 'ready', attemptId: start.attemptId, generation: start.generation });
      if (start.handoff)
        emit({
          type: 'output',
          channel: 'stdout',
          text: JSON.stringify({
            fixture: 'handoff-context',
            checksum: start.handoff.checksum,
            runId: start.handoff.packet.runId,
            candidateId: start.handoff.packet.candidate?.id,
          }),
        });
      writeChallengeSolution(start.scratchPath);
      emit({
        type: 'output',
        channel: 'stdout',
        text: 'Retained net.mjs edits. <script>provider content stays inert</script>\n',
      });
      if (start.scenario === 'stubborn') {
        const child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), '--stubborn-child'],
          {
            cwd: start.scratchPath,
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          },
        );
        descendantPid = child.pid;
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => reject(new Error('Stubborn child exited before readiness.')));
          child.once('message', (message) => {
            if (message !== child.pid) return reject(new Error('Invalid descendant readiness.'));
            resolve();
          });
        });
        child.disconnect();
        child.unref();
        emit({
          type: 'output',
          channel: 'stdout',
          text: JSON.stringify({ fixture: 'stubborn-child-ready', pid: child.pid }),
        });
      }
      checkpoint();
      if (start.scenario === 'complete')
        terminal('completed', 'Edits retained. Checks have not run.');
      if (start.scenario === 'approval' || start.scenario === 'approval-reserve') {
        approvalPending = true;
        emit({
          type: 'approval',
          action: 'run-check',
          target: 'node --test',
          consequence: 'Run the candidate checks in an isolated copy.',
        });
      }
      if (start.scenario === 'reserve') {
        reserveReached();
      }
      return;
    }
    if (!start) throw new Error('Worker needs a start binding.');
    if (input.type === 'approval') {
      if (
        !approvalPending ||
        input.binding.attemptId !== start.attemptId ||
        input.binding.generation !== start.generation ||
        input.binding.action !== 'run-check' ||
        input.binding.target !== 'node --test'
      ) {
        throw new Error('Approval does not match the pending action.');
      }
      approvalPending = false;
      if (input.decision === 'approved' && start.scenario === 'approval-reserve') {
        reserveReached();
        checkpoint();
        return;
      }
      terminal(
        input.decision === 'approved' ? 'completed' : 'failed',
        input.decision === 'approved'
          ? 'Approval received. Checks have not run.'
          : 'Check approval denied.',
      );
      return;
    }
    if (input.type === 'checkpoint') {
      if (start.scenario === 'crash') process.exit(17);
      checkpoint();
      if (
        start.scenario === 'reserve' ||
        (start.scenario === 'approval-reserve' && !approvalPending)
      )
        terminal('stopped', 'Reserve reached; retained work is ready for handoff.');
      return;
    }
    if (input.type === 'stop')
      terminal('stopped', 'Stop requested; retained edits remain available.');
  }

  process.stdin.on('data', (chunk: Buffer) => {
    if (pending.length + chunk.length > MAX_FRAME_BYTES)
      return fail(new Error('Worker input exceeds the frame limit.'));
    pending = Buffer.concat([pending, chunk]);
    let end = pending.indexOf(10);
    while (end !== -1) {
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      processing = processing
        .then(async () => {
          const json = new TextDecoder('utf-8', { fatal: true }).decode(line);
          await receive(FakeWorkerInputSchema.parse(JSON.parse(json)));
        })
        .catch(fail);
      end = pending.indexOf(10);
    }
  });
  process.stdin.on('end', () => {
    processing = processing
      .then(() => {
        if (pending.length) throw new Error('Worker input ended inside a frame.');
        if (!finished) {
          if (descendantPid) process.kill(descendantPid, 'SIGKILL');
          process.exitCode = 2;
        }
      })
      .catch(fail);
  });
  process.stdin.on('error', fail);
}

if (process.argv[2] === '--stubborn-child') runStubbornChild();
else runWorker();
