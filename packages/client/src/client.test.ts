import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type Event,
  MAX_FRAME_BYTES,
  type Snapshot,
  type TransportMessage,
} from '@crewkite/contracts';
import { encodeFrame, FrameDecoder, ProtocolError } from './index.ts';
import { connectController } from './node.ts';

const token = 'a'.repeat(64);
const actor = { id: 'terminal', kind: 'cli' as const };
const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const task = {
  id: `tsk_${suffix}`,
  projectId: `prj_${suffix}`,
  title: 'Inspect the retained edit',
  outcome: 'Retain the edit',
  criteria: ['The edit can be inspected'],
  state: 'draft' as const,
  waitingReason: null,
  revision: 3,
  runId: null,
  next: 'Prepare the run.',
};
const snapshot: Snapshot = {
  protocol: 1,
  cursor: '4',
  projects: [],
  tasks: [task],
  runs: [],
  attempts: [],
  routes: [],
  artifacts: [],
  evidence: [],
  approvals: [],
  usage: [],
  candidates: [],
  nativeProfiles: [],
  nativeRuns: [],
  candidateEvaluations: [],
};

function rawFrame(value: unknown): Uint8Array {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(data.length + 4);
  new DataView(frame.buffer).setUint32(0, data.length, false);
  frame.set(data, 4);
  return frame;
}

async function serve(
  handler: (message: TransportMessage, socket: Socket, connection: number) => void,
) {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  const directory = resolve(common, '..', 'internal');
  mkdirSync(directory, { recursive: true });
  const home = mkdtempSync(join(directory, 'client-'));
  writeFileSync(join(home, 'token'), token, { mode: 0o600 });
  const socketPath = join(home, 'control.sock');
  const sockets = new Set<Socket>();
  let connection = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    const number = ++connection;
    const decoder = new FrameDecoder();
    socket.on('error', () => {});
    socket.on('data', (bytes) => {
      for (const message of decoder.push(bytes)) handler(message, socket, number);
    });
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    server.listen(socketPath);
    await once(server, 'listening');
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return {
    home,
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('framing preserves fragmented messages and rejects oversized or incomplete input', () => {
  const message: TransportMessage = { type: 'welcome', protocol: 1, cursor: '7' };
  const frame = encodeFrame(message);
  for (let split = 0; split <= frame.length; split++) {
    const decoder = new FrameDecoder();
    const messages = [
      ...decoder.push(frame.subarray(0, split)),
      ...decoder.push(frame.subarray(split)),
    ];
    decoder.finish();
    assert.deepEqual(messages, [message]);
  }
  const together = new Uint8Array(frame.length * 2);
  together.set(frame);
  together.set(frame, frame.length);
  assert.deepEqual(new FrameDecoder().push(together), [message, message]);
  for (const length of [0, MAX_FRAME_BYTES + 1, 0xffffffff]) {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, length, false);
    assert.throws(() => new FrameDecoder().push(header), ProtocolError);
  }
  for (const bytes of [frame.subarray(0, 3), frame.subarray(0, frame.length - 1)]) {
    const decoder = new FrameDecoder();
    decoder.push(bytes);
    assert.throws(() => decoder.finish(), ProtocolError);
  }
  assert.throws(
    () => new FrameDecoder().push(rawFrame({ type: 'welcome', protocol: 1, cursor: '01' })),
    ProtocolError,
  );
});

test('protocol mismatches reject the handshake without exposing authentication data', async (context) => {
  const wrong = { type: 'hello', protocol: 2, token, actor };
  assert.throws(
    () => new FrameDecoder().push(rawFrame(wrong)),
    (error) =>
      error instanceof ProtocolError &&
      error.reason === 'protocol-mismatch' &&
      !error.message.includes(token),
  );
  const fixture = await serve((_message, socket) =>
    socket.end(encodeFrame({ type: 'error', reason: 'protocol-mismatch', next: token })),
  );
  context.after(() => fixture.close());
  await assert.rejects(
    connectController({ ...fixture, token, actor, reconnectDelaysMs: [] }),
    (error) =>
      error instanceof Error &&
      error.message.includes('protocol-mismatch') &&
      !error.message.includes(token),
  );
});

test('CLI actions preserve controller bindings and validate exported bytes', async (context) => {
  const profile = {
    id: 'openai-file-v1',
    family: 'openai' as const,
    displayName: 'OpenAI single-file proposal',
    clientVersion: '0.163.0',
    model: 'native-model',
    effort: 'low' as const,
    accountClass: 'pro' as const,
    serviceTier: 'default' as const,
    qualifiedAt: '2026-10-16',
    creditPolicies: ['ordinary', 'existing-credits'] as const,
    maximumTaskMs: 300000 as const,
    maximumFileBytes: 65536 as const,
    maximumSubmissions: 1 as const,
    available: true,
    reason: 'available' as const,
  };
  const policy: import('@crewkite/contracts').Policy = {
    authority: 'balanced',
    quality: 'quick',
    effects: [],
    limits: { attempts: 4, minutes: 5, concurrency: 1 },
    reserves: [],
    unknownUsage: { rule: 'fixed-allowance', allowance: { launches: 1, minutes: 5 } },
    methods: [{ id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' }],
  };
  const bytes = Buffer.from(`diff --git a/file.txt b/file.txt\n${'x'.repeat(70000)}`);
  const artifact = {
    id: `art_${suffix}`,
    hash: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    mediaType: 'text/x-diff',
  };
  const changes = {
    kind: 'changes' as const,
    taskId: task.id,
    candidateId: `cnd_${suffix}`,
    artifactId: artifact.id,
    files: [],
    diff: 'retained\u001b[31m\roverwrite',
    truncated: false,
  };
  const nativeRun = {
    runId: `run_${suffix}`,
    profileId: profile.id,
    stage: 'prepared' as const,
    expiresAt: '2026-10-18T00:00:00.000Z',
    target: { path: 'docs/providers.md', baseHash: 'b'.repeat(64), bytes: 42 },
  };
  const run: Snapshot['runs'][number] = {
    id: nativeRun.runId,
    taskId: task.id,
    source: {
      projectId: task.projectId,
      base: 'a'.repeat(40),
      branch: 'main',
      dirtyCount: 0,
      untrackedCount: 0,
    },
    policy: { policy, hash: 'c'.repeat(64) },
    roles: [{ role: 'coder', routeId: `rte_${suffix}`, pinned: true, approvedFallbacks: [] }],
    decision: { chosen: `rte_${suffix}`, rejected: [], rule: 'manual', inputsHash: 'd'.repeat(64) },
    revision: 0,
  };
  const approval = {
    approvalId: `apr_${suffix}`,
    taskId: task.id,
    attemptId: `att_${suffix}`,
    generation: 0,
    action: 'export-patch' as const,
    target: task.id,
    revision: 2,
    requester: 'controller',
    consequence: 'Export the retained candidate.',
    status: 'pending' as const,
  };
  const candidate = {
    id: changes.candidateId,
    taskId: task.id,
    hash: 'e'.repeat(64),
    artifactId: artifact.id,
    revision: 0,
  };
  const evaluation: Snapshot['candidateEvaluations'][number] = {
    taskId: task.id,
    runId: run.id,
    candidateId: candidate.id,
    candidateHash: candidate.hash,
    preparationId: artifact.id,
    recipe: 'node-tests-v1',
    definitionHash: 'f'.repeat(64),
    target: { path: 'net.mjs', baseHash: 'b'.repeat(64), candidateContentHash: 'c'.repeat(64) },
    reviewer: {
      profileId: profile.id,
      assignedRole: 'reviewer',
      methodId: 'keep-it-simple',
      cycle: 1,
      independence: 'process-only',
    },
    creditPolicy: 'ordinary',
    expiresAt: '2026-10-18T00:00:00.000Z',
    remainingBudgets: { attempts: 2, minutes: 3, concurrency: 1 },
    allowance: { source: 'supplemental-evaluation', localChecks: 1, nativeReviews: 1 },
    stage: 'prepared',
    check: null,
    review: null,
    checkStart: { available: true, reason: 'available' },
    reviewStart: { available: false, reason: 'checks-required' },
  };
  const grants = ['run-check', 'run-review'].map((action) => ({
    action,
    target: action === 'run-check' ? 'node --test' : 'keep-it-simple/cycle-1',
    taskId: task.id,
    expiresAt: evaluation.expiresAt,
    revoked: false,
    usesRemaining: 1,
  }));
  for (const scenario of [
    'show',
    'native-show',
    'profiles',
    'explicit',
    'saved',
    'unavailable',
    'partial-consent',
    'changes',
    'export',
    'hash',
    'offset',
    'existing',
    'uncertain',
    'approval',
    'evaluation-show',
    'evaluation-reviewed',
    'evaluation-explicit',
    'evaluation-saved',
    'evaluation-partial-consent',
    'evaluation-invalid-grants',
    'start-checks',
    'start-review',
  ]) {
    const evaluating =
      scenario.startsWith('evaluation-') || ['start-checks', 'start-review'].includes(scenario);
    const received: import('@crewkite/contracts').Command[] = [];
    const preview: Snapshot['candidateEvaluations'][number] =
      scenario === 'evaluation-reviewed'
        ? {
            ...evaluation,
            stage: 'reviewed',
            check: { artifactId: artifact.id, passed: true },
            review: { artifactId: artifact.id, outcome: 'passed' },
            checkStart: { available: false, reason: 'already-started' },
            reviewStart: { available: false, reason: 'already-started' },
          }
        : evaluation;
    const reviewEvidence: Snapshot['evidence'] =
      scenario === 'evaluation-reviewed'
        ? [
            {
              candidateId: candidate.id,
              candidateHash: candidate.hash,
              definitionHash: evaluation.definitionHash,
              evaluator: 'native:openai:fixture',
              artifactId: artifact.id,
              passed: true,
              review: {
                job: {
                  taskId: task.id,
                  runId: run.id,
                  attemptId: `att_${suffix}`,
                  generation: 2,
                  routeId: `rte_${suffix}`,
                  writerAttemptId: `att_${suffix}`,
                  writerRouteId: `rte_${suffix}`,
                  candidateId: candidate.id,
                  candidateHash: candidate.hash,
                  methodId: 'keep-it-simple',
                  cycle: 1,
                  limitMinutes: 1,
                  scripted: false,
                  preparationId: artifact.id,
                  profileId: profile.id,
                  assignedRole: 'reviewer',
                  independence: 'process-only',
                },
                outcome: 'passed',
                findings: [{ severity: 'info', message: 'review finding\u001b[31m\rkept inert' }],
                summary: 'Review completed.',
              },
            },
          ]
        : [];
    const fixture = await serve((message, socket) => {
      if (message.type === 'hello')
        socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: snapshot.cursor }));
      if (message.type !== 'command') return;
      const command = message.command;
      received.push(command);
      let result: import('@crewkite/contracts').CommandResult = { outcome: 'applied' };
      if (command.command === 'GetSnapshot')
        result = {
          outcome: 'applied',
          data: {
            kind: 'snapshot',
            snapshot: {
              ...snapshot,
              tasks:
                scenario === 'native-show' || evaluating
                  ? [
                      {
                        ...task,
                        runId: nativeRun.runId,
                        ...(evaluating ? { state: 'stopped' as const } : {}),
                      },
                    ]
                  : snapshot.tasks,
              runs: scenario === 'native-show' || evaluating ? [run] : [],
              nativeRuns: scenario === 'native-show' || evaluating ? [nativeRun] : [],
              candidates: evaluating ? [candidate] : [],
              artifacts: evaluating ? [artifact] : [],
              candidateEvaluations: evaluating ? [preview] : [],
              evidence: reviewEvidence,
              approvals: scenario === 'approval' ? [approval] : [],
              nativeProfiles: [
                {
                  ...profile,
                  creditPolicies: [...profile.creditPolicies],
                  available: scenario !== 'unavailable',
                  reason: scenario === 'unavailable' ? 'client-unavailable' : 'available',
                },
              ],
            },
          },
        };
      if (command.command === 'GetChanges')
        result = { outcome: 'applied', data: { ...changes, truncated: scenario === 'changes' } };
      if (command.command === 'ExportPatch')
        result =
          scenario === 'uncertain'
            ? { outcome: 'outcome-unknown', reason: 'connection-lost' }
            : { outcome: 'applied', entity: scenario === 'approval' ? approval : artifact };
      if (command.command === 'ResolveApproval') result = { outcome: 'applied', entity: artifact };
      if (command.command === 'GetArtifact') {
        const offset = command.payload.offset;
        const chunk = bytes.subarray(offset, offset + command.payload.limit);
        result = {
          outcome: 'applied',
          data: {
            kind: 'artifact',
            artifact,
            offset: scenario === 'offset' ? offset + 1 : offset,
            content: (scenario === 'hash' ? Buffer.alloc(chunk.length) : chunk).toString('base64'),
            encoding: 'base64',
            eof: offset + chunk.length === bytes.length,
          },
        };
      }
      socket.write(encodeFrame({ type: 'result', key: command.key, result }));
    });
    context.after(() => fixture.close());
    const policyFile = join(fixture.home, 'policy.json'),
      destination = join(fixture.home, 'saved.patch');
    writeFileSync(policyFile, JSON.stringify(policy));
    const grantsFile = join(fixture.home, 'grants.json');
    writeFileSync(
      grantsFile,
      JSON.stringify(
        scenario === 'evaluation-invalid-grants'
          ? [{ ...grants[0], unexpected: true }, grants[1]]
          : grants,
      ),
    );
    if (scenario === 'existing') writeFileSync(destination, 'original');
    const execute = async (args: string[], json = true) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../../../apps/cli/src/main.ts', import.meta.url)),
          ...args,
          ...(json ? ['--json'] : []),
          '--home',
          fixture.home,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '',
        errors = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        errors += data;
      });
      const [code] = await once(child, 'close');
      return { code, output, errors };
    };
    let args = ['task', 'export', task.id, '--output', destination];
    if (scenario === 'show' || scenario === 'native-show') args = ['task', 'show', task.id];
    if (scenario === 'profiles') args = ['native', 'profiles'];
    if (['explicit', 'saved', 'unavailable', 'partial-consent'].includes(scenario))
      args = [
        'task',
        'prepare-native',
        task.id,
        profile.id,
        'docs/providers.md',
        '--policy',
        policyFile,
        ...(scenario === 'explicit'
          ? ['--native-trust', '--source-consent']
          : scenario === 'partial-consent'
            ? ['--native-trust']
            : []),
        ...(scenario === 'saved' ? ['--existing-credits'] : []),
      ];
    if (scenario === 'changes') args = ['task', 'changes', task.id];
    if (['evaluation-show', 'evaluation-reviewed'].includes(scenario))
      args = ['task', 'show', task.id];
    if (['start-checks', 'start-review'].includes(scenario)) args = ['task', scenario, task.id];
    if (
      evaluating &&
      !['evaluation-show', 'evaluation-reviewed', 'start-checks', 'start-review'].includes(scenario)
    )
      args = [
        'task',
        'prepare-evaluation',
        task.id,
        profile.id,
        '--grants',
        grantsFile,
        ...(scenario === 'evaluation-saved'
          ? ['--existing-credits']
          : scenario === 'evaluation-partial-consent'
            ? ['--native-trust']
            : ['--native-trust', '--source-consent']),
      ];
    const result = await execute(args, scenario !== 'changes');
    if (['evaluation-partial-consent', 'evaluation-invalid-grants'].includes(scenario)) {
      assert.equal(result.code, 1, result.errors);
      assert.equal(
        received.some((command) => command.command === 'PrepareCandidateEvaluation'),
        false,
      );
      continue;
    }
    if (['evaluation-show', 'evaluation-reviewed'].includes(scenario)) {
      assert.equal(result.code, 0, result.errors);
      assert.deepEqual(JSON.parse(result.output).evaluation, preview);
      assert.deepEqual(JSON.parse(result.output).evidence, reviewEvidence);
      const plain = await execute(args, false);
      assert.equal(plain.code, 0, plain.errors);
      for (const value of [
        evaluation.preparationId,
        evaluation.candidateHash,
        evaluation.target.path,
        evaluation.target.candidateContentHash,
        'process-only',
        'Remaining total attempts 2, minutes 3',
        scenario === 'evaluation-reviewed' ? 'already-started' : 'checks-required',
        'Acceptance is unavailable',
      ])
        assert(plain.output.includes(value), value);
      if (scenario === 'evaluation-reviewed') {
        assert(plain.output.includes('Review completed.'));
        assert(plain.output.includes('review finding\\u001b[31m\\u000dkept inert'));
        assert(!plain.output.includes('\u001b'));
        assert(!plain.output.includes('\r'));
      }
      continue;
    }
    if (evaluating) {
      assert.equal(result.code, 0, result.errors);
      const receipt = JSON.parse(result.output);
      const preparing = scenario.startsWith('evaluation-');
      const command = preparing
        ? 'PrepareCandidateEvaluation'
        : scenario === 'start-checks'
          ? 'StartCandidateEvaluation'
          : 'StartCandidateReview';
      assert.equal(receipt.command.command, command);
      assert.equal(receipt.command.expectedRevision, task.revision);
      assert.deepEqual(
        receipt.command.payload,
        preparing
          ? {
              taskId: task.id,
              candidateId: candidate.id,
              checkRecipeId: 'node-tests-v1',
              reviewer: { profileId: profile.id, methodId: 'keep-it-simple', cycles: 1 },
              creditPolicy: scenario === 'evaluation-saved' ? 'existing-credits' : 'ordinary',
              consent: scenario === 'evaluation-saved' ? 'saved' : 'explicit',
              grants,
            }
          : { taskId: task.id, candidateId: candidate.id, preparationId: artifact.id },
      );
      assert.deepEqual(
        received.map((value) => value.command),
        ['GetSnapshot', command],
      );
      continue;
    }
    if (['unavailable', 'partial-consent'].includes(scenario)) {
      assert.equal(result.code, 1, scenario);
      assert.equal(
        received.some((command) => command.command === 'PrepareNativeRun'),
        false,
      );
      continue;
    }
    if (scenario === 'show') {
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.output), { cursor: snapshot.cursor, task });
      continue;
    }
    if (scenario === 'native-show') {
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.output), {
        cursor: snapshot.cursor,
        task: { ...task, runId: nativeRun.runId },
        nativeRun,
        run,
      });
      const plain = await execute(['task', 'show', task.id], false);
      assert.equal(plain.code, 0);
      for (const value of [
        nativeRun.target.path,
        nativeRun.target.baseHash,
        '42',
        nativeRun.expiresAt,
        nativeRun.stage,
        run.source.base,
      ])
        assert(plain.output.includes(value));
      continue;
    }
    if (scenario === 'profiles') {
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.output).profiles, [
        { ...profile, creditPolicies: [...profile.creditPolicies] },
      ]);
      continue;
    }
    if (scenario === 'changes') {
      assert.equal(result.code, 0);
      assert(!result.output.includes('\u001b'));
      assert(result.output.includes('\\u001b'));
      assert(!result.output.includes('\r'));
      assert(result.output.includes('\\u000d'));
      assert(result.output.includes('Diff preview is truncated.'));
      continue;
    }
    const receipt = JSON.parse(result.output);
    if (scenario === 'explicit' || scenario === 'saved') {
      assert.equal(result.code, 0, result.errors);
      assert.equal(receipt.command.command, 'PrepareNativeRun');
      assert.equal(receipt.command.expectedRevision, task.revision);
      assert.deepEqual(receipt.command.payload, {
        taskId: task.id,
        profileId: profile.id,
        targetPath: 'docs/providers.md',
        policy,
        creditPolicy: scenario === 'saved' ? 'existing-credits' : 'ordinary',
        consent: scenario === 'saved' ? 'saved' : 'explicit',
      });
      assert.deepEqual(
        received.map((command) => command.command),
        ['GetSnapshot', 'PrepareNativeRun'],
      );
      continue;
    }
    assert.equal(receipt.command.command, 'ExportPatch');
    assert.equal(receipt.command.expectedRevision, task.revision);
    assert.deepEqual(receipt.command.payload, {
      taskId: task.id,
      candidateId: changes.candidateId,
    });
    if (scenario === 'approval') {
      assert.equal(result.code, 0, result.errors);
      assert.equal(existsSync(destination), false);
      assert.deepEqual(receipt.nextCommand, [
        'crewkite',
        'task',
        'approve',
        approval.approvalId,
        '--output',
        destination,
        '--home',
        fixture.home,
        '--json',
      ]);
      assert.equal(
        received.some((command) => command.command === 'GetArtifact'),
        false,
      );
      const approved = await execute([
        'task',
        'approve',
        approval.approvalId,
        '--output',
        destination,
      ]);
      assert.equal(approved.code, 0, approved.errors);
      assert(readFileSync(destination).equals(bytes));
      const approvalReceipt = JSON.parse(approved.output);
      assert.equal(approvalReceipt.command.command, 'ResolveApproval');
      assert.deepEqual(approvalReceipt.command.payload, {
        binding: {
          approvalId: approval.approvalId,
          taskId: task.id,
          attemptId: approval.attemptId,
          generation: 0,
          action: approval.action,
          target: task.id,
          revision: 2,
        },
        decision: 'approved',
      });
    } else if (scenario === 'export') {
      assert.equal(result.code, 0, result.errors);
      assert(readFileSync(destination).equals(bytes));
      assert.equal(received.filter((command) => command.command === 'GetArtifact').length, 2);
      const receiptFile = join(fixture.home, 'receipt.json'),
        retryFile = join(fixture.home, 'retried.patch');
      writeFileSync(receiptFile, result.output);
      const retried = await execute(['retry', receiptFile, '--output', retryFile]);
      assert.equal(retried.code, 0, retried.errors);
      assert.deepEqual(JSON.parse(retried.output).command, receipt.command);
      assert(readFileSync(retryFile).equals(bytes));
    } else {
      assert.equal(result.code, scenario === 'uncertain' ? 2 : 1, scenario);
      assert.equal(existsSync(destination), scenario === 'existing');
      if (scenario === 'existing') assert.equal(readFileSync(destination, 'utf8'), 'original');
    }
  }
});

test('reconnection replays retained events and snapshots only after a history gap', async (context) => {
  const delivered: string[] = [];
  const subscriptions: string[] = [];
  let snapshots = 0;
  let firstSocket: Socket | undefined;
  let secondSocket: Socket | undefined;
  let reachedFirst!: () => void;
  let reachedSecond!: () => void;
  let reachedFinal!: () => void;
  const first = new Promise<void>((done) => {
    reachedFirst = done;
  });
  const second = new Promise<void>((done) => {
    reachedSecond = done;
  });
  const final = new Promise<void>((done) => {
    reachedFinal = done;
  });
  const event = (cursor: string): Event => ({
    protocol: 1,
    id: `evt_${suffix}`,
    cursor,
    at: '2026-10-15T17:00:00.000Z',
    taskId: task.id,
    revision: Number(cursor),
    type: 'task.updated',
    payload: { ...task, revision: Number(cursor) },
  });
  const fixture = await serve((message, socket, connection) => {
    if (message.type === 'hello') {
      if (connection === 1) firstSocket = socket;
      else secondSocket = socket;
      socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: '9' }));
    }
    if (message.type !== 'command') return;
    const command = message.command;
    if (command.command === 'Subscribe') {
      subscriptions.push(command.payload.after);
      if (command.payload.after === '2') {
        socket.write(encodeFrame({ type: 'resync', reason: 'history-gap', cursor: '9' }));
      }
      socket.write(
        encodeFrame({ type: 'result', key: command.key, result: { outcome: 'applied' } }),
      );
      for (const cursor of connection === 1
        ? ['1']
        : command.payload.after === '1'
          ? ['1', '2']
          : command.payload.after === '9'
            ? ['10']
            : [])
        socket.write(encodeFrame({ type: 'event', event: event(cursor) }));
    }
    if (command.command === 'GetSnapshot') {
      snapshots++;
      socket.write(
        encodeFrame({
          type: 'result',
          key: command.key,
          result: {
            outcome: 'applied',
            data: { kind: 'snapshot', snapshot: { ...snapshot, cursor: '9' } },
          },
        }),
      );
    }
  });
  context.after(() => fixture.close());
  let key = 0;
  const client = await connectController({
    ...fixture,
    token,
    actor,
    reconnectDelaysMs: [0],
    nextKey: () => `cmd_${String(++key).padStart(26, '0')}`,
  });
  context.after(() => client.close());
  const resynced: string[] = [];
  await client.subscribe(
    '0',
    (value) => {
      delivered.push(value.cursor);
      if (value.cursor === '1') reachedFirst();
      if (value.cursor === '2') reachedSecond();
      if (value.cursor === '10') reachedFinal();
    },
    (value) => resynced.push(value.cursor),
  );
  await first;
  assert.ok(firstSocket);
  firstSocket.destroy();
  await second;
  assert.equal(snapshots, 0);
  assert.ok(secondSocket);
  secondSocket.destroy();
  await final;
  assert.deepEqual(delivered, ['1', '2', '10']);
  assert.deepEqual(subscriptions, ['0', '1', '2', '9']);
  assert.deepEqual(resynced, ['9']);
  assert.equal(snapshots, 1);
});
