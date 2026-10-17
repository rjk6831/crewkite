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
  type Command,
  type Event,
  MAX_FRAME_BYTES,
  type Snapshot,
  type TransportMessage,
} from '@crewkite/contracts';
import { checkOwner } from '../../../apps/controller/src/host/check-ownership.ts';
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
  const owner = checkOwner();
  const directory = owner?.stateRoot ?? resolve(common, '..', 'internal');
  mkdirSync(directory, { recursive: true });
  const home = mkdtempSync(join(directory, 'client-'));
  writeFileSync(join(home, 'token'), token, { mode: 0o600 });
  const socketPath = join(home, 'control.sock');
  if (owner && Buffer.byteLength(socketPath) > 100)
    throw Error('The verification client socket path exceeds its bound.');
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
  const anthropicProfile: Snapshot['nativeProfiles'][number] = {
    id: 'anthropic-file-v1',
    family: 'anthropic',
    displayName: 'Anthropic single-file proposal',
    clientVersion: '2.1.302',
    model: 'native-model',
    effort: 'medium',
    effectiveEffort: 'unknown',
    accountClass: 'unknown',
    serviceTier: 'unknown',
    billingBasis: 'requires-user-attestation',
    qualifiedAt: null,
    creditPolicies: ['ordinary'],
    maximumTaskMs: 300000,
    maximumFileBytes: 65536,
    maximumSubmissions: 1,
    available: true,
    reason: 'qualification-pending',
  };
  const googleProfile: Snapshot['nativeProfiles'][number] = {
    ...anthropicProfile,
    id: 'google-file-v1',
    family: 'google',
    displayName: 'Google single-file proposal',
    clientVersion: '0.14.0',
    effort: 'low',
    permissionModes: ['request-review', 'strict', 'always-proceed', 'proceed-in-sandbox'],
  };
  const repositoryProfile: Snapshot['nativeProfiles'][number] = {
    id: 'openai-repository-v1',
    family: 'openai',
    displayName: 'OpenAI repository work',
    clientVersion: profile.clientVersion,
    model: profile.model,
    effort: 'low',
    accountClass: 'pro',
    serviceTier: 'default',
    qualifiedAt: null,
    creditPolicies: ['ordinary', 'existing-credits'],
    maximumTaskMs: 300000,
    maximumSourceFiles: 10000,
    maximumSourceBytes: 67108864,
    maximumSubmissions: 1,
    execution: { sandbox: 'workspace-write', approvalPolicy: 'never', networkAccess: false },
    available: true,
    reason: 'qualification-pending',
  };
  const billingAttestation = {
    source: 'user-attested' as const,
    subscriptionLoginConfirmed: true as const,
    paidExtraUsageDisabled: true as const,
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
    testFiles: [],
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
    localAcceptance: { available: false, reason: 'evidence-incomplete' },
  };
  assert(evaluation.target);
  const grants = (['run-check', 'run-review'] as const).map((action) => ({
    action,
    target: action === 'run-check' ? 'node --test' : 'keep-it-simple/cycle-1',
    taskId: task.id,
    expiresAt: evaluation.expiresAt,
    revoked: false,
    usesRemaining: 1 as const,
  }));
  const projectTestFiles = ['test/pricing.test.mjs', 'test/税 額.test.mjs'];
  const timedFixture = await serve((message, socket) => {
    if (message.type === 'hello')
      socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: '0' }));
  });
  context.after(() => timedFixture.close());
  for (const row of [
    { recipe: 'crewkite-verify-v1', expected: 65000 },
    { recipe: 'node-tests-v1', expected: 5000 },
    { recipe: 'project-node-tests-v1', expected: 5000 },
    { recipe: null, expected: 5000 },
    { recipe: 'crewkite-verify-v1', timeoutMs: 10000, expected: 10000 },
    { recipe: 'crewkite-verify-v1', timeoutMs: 70000, expected: 70000 },
  ] as const) {
    const client = await connectController({
      ...timedFixture,
      token,
      actor,
      reconnectDelaysMs: [],
      ...('timeoutMs' in row ? { timeoutMs: row.timeoutMs } : {}),
    });
    try {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const command: Command =
        row.recipe === null
          ? { protocol: 1, key: `cmd_${suffix}`, actor, command: 'GetSnapshot', payload: {} }
          : {
              protocol: 1,
              key: `cmd_${suffix}`,
              actor,
              command: 'PrepareCandidateEvaluation',
              expectedRevision: task.revision,
              payload: {
                taskId: task.id,
                candidateId: candidate.id,
                ...(row.recipe === 'project-node-tests-v1'
                  ? { checkRecipeId: row.recipe, testFiles: projectTestFiles }
                  : { checkRecipeId: row.recipe }),
                reviewer: { profileId: profile.id, methodId: 'keep-it-simple', cycles: 1 },
                creditPolicy: 'ordinary',
                consent: 'explicit',
                grants: grants.map((grant) => ({
                  ...grant,
                  target:
                    grant.action === 'run-check' && row.recipe === 'crewkite-verify-v1'
                      ? 'crewkite verify'
                      : grant.target,
                })),
              },
            };
      let settled = false;
      const response = client.command(command).then((value) => {
        settled = true;
        return value;
      });
      context.mock.timers.tick(row.expected - 1);
      await Promise.resolve();
      assert.equal(settled, false, JSON.stringify(row));
      context.mock.timers.tick(1);
      assert.deepEqual(await response, {
        outcome: 'outcome-unknown',
        reason: 'response-timeout',
        next: 'Read a fresh snapshot and retry the same command key if needed.',
      });
    } finally {
      context.mock.timers.reset();
      client.close();
    }
  }

  for (const scenario of [
    'show',
    'native-show',
    'profiles',
    'handoff-targets',
    'handoff-target-duplicate',
    'handoff-target-repository',
    'handoff-target-wrong-command',
    'handoff-openai',
    'handoff-openai-credits',
    'handoff-anthropic',
    'handoff-google',
    'handoff-missing-consent',
    'handoff-missing-attestation',
    'handoff-unlisted',
    'handoff-blocked',
    'handoff-start',
    'handoff-start-blocked',
    'handoff-show',
    'handoff-uncertain',
    'repository-explicit',
    'repository-saved',
    'repository-credits',
    'repository-missing-tools',
    'repository-revoked-tools',
    'repository-expired-tools',
    'repository-wrong-profile',
    'repository-file-command',
    'repository-billing-option',
    'repository-mode-option',
    'repository-reviewer',
    'repository-show',
    'anthropic-explicit',
    'anthropic-saved',
    'anthropic-missing',
    'anthropic-credits',
    'anthropic-wrong-provider',
    'anthropic-wrong-command',
    'anthropic-reviewer',
    'anthropic-show',
    'google-request-review',
    'google-strict',
    'google-always-proceed',
    'google-proceed-in-sandbox',
    'google-saved',
    'google-missing-confirmations',
    'google-missing-mode',
    'google-invalid-mode',
    'google-credits',
    'google-wrong-provider',
    'google-wrong-command',
    'google-reviewer',
    'google-show',
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
    'evaluation-project',
    'evaluation-project-show',
    'evaluation-verification',
    'evaluation-verification-saved',
    'evaluation-verification-show',
    'evaluation-verification-files',
    'evaluation-project-empty',
    'evaluation-project-limit',
    'evaluation-project-duplicate',
    'evaluation-sample-files',
    'evaluation-unknown-recipe',
    'evaluation-recipe-other-command',
    'start-checks',
    'start-review',
    'accept-native',
    'accept-approval',
    'accept-uncertain',
    'accept-invalid-ref',
    'approval-missing',
    'accept-approval-mismatch',
    'accept-approval-ambiguous',
  ]) {
    const handing = scenario.startsWith('handoff-');
    const verification = scenario.startsWith('evaluation-verification');
    const savedEvaluation =
      scenario === 'evaluation-saved' || scenario === 'evaluation-verification-saved';
    const selectedGrants = verification
      ? grants.map((grant) =>
          grant.action === 'run-check' ? { ...grant, target: 'crewkite verify' } : grant,
        )
      : grants;
    const repositorySaved = scenario === 'repository-saved' || scenario === 'repository-show';
    const repositoryPolicy = {
      ...policy,
      effects:
        scenario === 'repository-missing-tools'
          ? []
          : [
              {
                taskId: task.id,
                action: 'run-native-tools' as const,
                target: 'fixture-project',
                expiresAt:
                  scenario === 'repository-expired-tools'
                    ? '2020-01-01T00:00:00.000Z'
                    : nativeRun.expiresAt,
                revoked: scenario === 'repository-revoked-tools',
                usesRemaining: 1 as const,
              },
            ],
    };
    const anthropicSaved = scenario === 'anthropic-saved' || scenario === 'anthropic-show';
    const googleSaved = scenario === 'google-saved' || scenario === 'google-show';
    const baseNativeRun: Snapshot['nativeRuns'][number] = repositorySaved
      ? {
          runId: run.id,
          profileId: repositoryProfile.id,
          stage: 'prepared',
          expiresAt: nativeRun.expiresAt,
          repository: {
            sourceBase: run.source.base,
            manifestHash: '9'.repeat(64),
            files: 4,
            bytes: 2048,
          },
          execution: repositoryProfile.execution,
        }
      : anthropicSaved
        ? { ...nativeRun, profileId: anthropicProfile.id, billingAttestation }
        : googleSaved
          ? {
              ...nativeRun,
              profileId: googleProfile.id,
              billingAttestation,
              permissionMode: 'strict',
            }
          : nativeRun;
    const handoff: NonNullable<Snapshot['nativeRuns'][number]['handoff']> = {
      targets: [
        {
          profileId: 'openai-file-v1',
          creditPolicy: scenario === 'handoff-openai-credits' ? 'existing-credits' : 'ordinary',
        },
        { profileId: 'anthropic-file-v1', creditPolicy: 'ordinary' },
        { profileId: 'google-file-v1', creditPolicy: 'ordinary' },
      ],
      currentAttemptId: `att_${suffix}`,
      generation: 0,
      prepare:
        scenario === 'handoff-blocked'
          ? { available: false, reason: 'ownership-unknown' }
          : { available: true, reason: 'available' },
      ...(['handoff-start', 'handoff-start-blocked', 'handoff-show', 'handoff-uncertain'].includes(
        scenario,
      )
        ? {
            pending: {
              preparationId: artifact.id,
              packetId: `hnd_${suffix}`,
              fromAttemptId: `att_${suffix}`,
              generation: 1,
              recipient: {
                profileId: 'google-file-v1' as const,
                creditPolicy: 'ordinary' as const,
              },
              baseHash: '7'.repeat(64),
              bytes: 35,
              expiresAt: nativeRun.expiresAt,
              start:
                scenario === 'handoff-start-blocked'
                  ? { available: false as const, reason: 'source-changed' as const }
                  : { available: true as const, reason: 'available' as const },
            },
          }
        : {}),
    };
    const selectedNativeRun: Snapshot['nativeRuns'][number] = handing
      ? { ...baseNativeRun, stage: 'retain-only', handoff }
      : baseNativeRun;
    const evaluating =
      scenario === 'repository-reviewer' ||
      scenario === 'anthropic-reviewer' ||
      scenario === 'google-reviewer' ||
      scenario.startsWith('evaluation-') ||
      scenario.startsWith('accept-') ||
      ['start-checks', 'start-review'].includes(scenario);
    const needsApproval =
      scenario === 'approval' ||
      scenario === 'approval-missing' ||
      scenario.startsWith('accept-approval');
    const pendingTask: Snapshot['tasks'][number] = {
      ...task,
      runId: run.id,
      state: 'waiting',
      waitingReason: 'approval',
      revision: task.revision + 1,
      next: 'Review the exact pending action.',
    };
    let pendingCommand:
      | Extract<
          import('@crewkite/contracts').Command,
          { command: 'AcceptCandidate' | 'ExportPatch' }
        >
      | undefined;
    const received: import('@crewkite/contracts').Command[] = [];
    const preview: Snapshot['candidateEvaluations'][number] = verification
      ? {
          ...evaluation,
          recipe: 'crewkite-verify-v1',
          remainingBudgets: { attempts: 2, minutes: 6, concurrency: 1 },
          verification: {
            toolchainHash: '1'.repeat(64),
            baselineHash: '2'.repeat(64),
            lockHash: '3'.repeat(64),
            platform: 'darwin',
            arch: 'arm64',
            executables: {
              node: { version: '24.22.0', sha256: '4'.repeat(64) },
              electron: { version: '44.7.2', sha256: '5'.repeat(64) },
              git: { version: '2.50.1', sha256: '6'.repeat(64) },
            },
            stages: ['policy', 'lint', 'types', 'node-tests', 'build', 'desktop'],
            maximumMinutes: 5,
          },
        }
      : scenario === 'evaluation-reviewed'
        ? {
            ...evaluation,
            stage: 'reviewed',
            check: { artifactId: artifact.id, passed: true },
            review: { artifactId: artifact.id, outcome: 'passed' },
            checkStart: { available: false, reason: 'already-started' },
            reviewStart: { available: false, reason: 'already-started' },
            localAcceptance: { available: true, reason: 'available' },
          }
        : scenario === 'evaluation-project-show'
          ? {
              ...evaluation,
              recipe: 'project-node-tests-v1',
              testFiles: projectTestFiles.map((path) => ({
                path,
                hash: 'a'.repeat(64),
                bytes: 42,
                mode: '100644',
              })),
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
      const pendingApproval: Snapshot['approvals'][number] =
        pendingCommand?.command === 'AcceptCandidate'
          ? {
              ...approval,
              action: 'accept-candidate',
              target:
                scenario === 'accept-approval-mismatch'
                  ? 'refs/heads/feat/other'
                  : pendingCommand.payload.destinationRef,
            }
          : approval;
      const approvals =
        !pendingCommand || scenario === 'approval-missing'
          ? []
          : scenario === 'accept-approval-ambiguous'
            ? [
                pendingApproval,
                { ...pendingApproval, approvalId: 'apr_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
              ]
            : [pendingApproval];
      if (command.command === 'GetSnapshot')
        result = {
          outcome: 'applied',
          data: {
            kind: 'snapshot',
            snapshot: {
              ...snapshot,
              projects: scenario.startsWith('repository-')
                ? [{ id: task.projectId, name: 'fixture-project', revision: 0 }]
                : snapshot.projects,
              tasks: pendingCommand
                ? [pendingTask]
                : scenario === 'native-show' ||
                    anthropicSaved ||
                    googleSaved ||
                    repositorySaved ||
                    evaluating ||
                    needsApproval ||
                    handing
                  ? [
                      {
                        ...task,
                        runId: nativeRun.runId,
                        ...(evaluating ? { state: 'stopped' as const } : {}),
                      },
                    ]
                  : snapshot.tasks,
              runs:
                scenario === 'native-show' ||
                anthropicSaved ||
                googleSaved ||
                repositorySaved ||
                evaluating ||
                needsApproval ||
                handing
                  ? [run]
                  : [],
              attempts: needsApproval
                ? [
                    {
                      id: approval.attemptId,
                      runId: run.id,
                      routeId: `rte_${suffix}`,
                      generation: approval.generation,
                      state: 'stopped',
                      revision: 0,
                    },
                  ]
                : snapshot.attempts,
              nativeRuns:
                scenario === 'native-show' ||
                anthropicSaved ||
                googleSaved ||
                repositorySaved ||
                evaluating ||
                handing
                  ? [selectedNativeRun]
                  : [],
              candidates: evaluating || needsApproval ? [candidate] : [],
              artifacts: evaluating ? [artifact] : [],
              candidateEvaluations: evaluating ? [preview] : [],
              evidence: reviewEvidence,
              approvals,
              nativeProfiles: [
                repositoryProfile,
                googleProfile,
                anthropicProfile,
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
            : { outcome: 'applied', entity: artifact };
      if (command.command === 'ResolveApproval') result = { outcome: 'applied', entity: artifact };
      if (
        (command.command === 'AcceptCandidate' || command.command === 'ExportPatch') &&
        needsApproval
      ) {
        result = {
          outcome: pendingCommand ? 'already-applied' : 'applied',
          entity: pendingTask,
          revision: pendingTask.revision,
        };
        pendingCommand = command;
      }
      if (command.command === 'StartNativeHandoff' && scenario === 'handoff-uncertain')
        result = { outcome: 'outcome-unknown', reason: 'connection-lost' };
      if (command.command === 'AcceptCandidate' && scenario === 'accept-uncertain')
        result = { outcome: 'outcome-unknown', reason: 'publication-prepared' };
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
    writeFileSync(
      policyFile,
      JSON.stringify(scenario.startsWith('repository-') ? repositoryPolicy : policy),
    );
    const grantsFile = join(fixture.home, 'grants.json');
    writeFileSync(
      grantsFile,
      JSON.stringify(
        scenario === 'evaluation-invalid-grants'
          ? [{ ...grants[0], unexpected: true }, grants[1]]
          : selectedGrants,
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
    if (
      [
        'evaluation-show',
        'evaluation-reviewed',
        'evaluation-project-show',
        'evaluation-verification-show',
      ].includes(scenario)
    )
      args = ['task', 'show', task.id];
    if (['start-checks', 'start-review'].includes(scenario)) args = ['task', scenario, task.id];
    if (
      scenario.startsWith('evaluation-') &&
      ![
        'evaluation-show',
        'evaluation-reviewed',
        'evaluation-project-show',
        'evaluation-verification-show',
        'start-checks',
        'start-review',
      ].includes(scenario)
    )
      args = [
        'task',
        'prepare-evaluation',
        task.id,
        profile.id,
        '--grants',
        grantsFile,
        ...(savedEvaluation
          ? scenario === 'evaluation-saved'
            ? ['--existing-credits']
            : []
          : scenario === 'evaluation-partial-consent'
            ? ['--native-trust']
            : ['--native-trust', '--source-consent']),
      ];
    if (scenario.startsWith('evaluation-project') && scenario !== 'evaluation-project-show') {
      const files =
        scenario === 'evaluation-project-empty'
          ? []
          : scenario === 'evaluation-project-limit'
            ? Array.from({ length: 33 }, (_, index) => `test/${index}.test.mjs`)
            : scenario === 'evaluation-project-duplicate'
              ? [projectTestFiles[0], projectTestFiles[0]]
              : projectTestFiles;
      args.push(
        '--recipe',
        'project-node-tests-v1',
        ...files.flatMap((path) => ['--test-file', path]),
      );
    }
    if (verification && scenario !== 'evaluation-verification-show')
      args.push('--recipe', 'crewkite-verify-v1');
    if (scenario === 'evaluation-verification-files') args.push('--test-file', projectTestFiles[0]);
    if (scenario === 'evaluation-sample-files') args.push('--test-file', projectTestFiles[0]);
    if (scenario === 'evaluation-unknown-recipe') args.push('--recipe', 'unknown');
    if (scenario === 'evaluation-recipe-other-command')
      args = ['health', '--recipe', 'project-node-tests-v1', '--test-file', projectTestFiles[0]];
    if (scenario.startsWith('accept-'))
      args = [
        'task',
        'accept',
        task.id,
        scenario === 'accept-invalid-ref' ? 'main' : 'refs/heads/feat/checked',
      ];
    if (scenario.startsWith('anthropic-')) {
      args =
        scenario === 'anthropic-show'
          ? ['task', 'show', task.id]
          : scenario === 'anthropic-wrong-command'
            ? ['native', 'profiles', '--confirm-subscription-only']
            : scenario === 'anthropic-reviewer'
              ? [
                  'task',
                  'prepare-evaluation',
                  task.id,
                  anthropicProfile.id,
                  '--grants',
                  grantsFile,
                  '--native-trust',
                  '--source-consent',
                ]
              : [
                  'task',
                  'prepare-native',
                  task.id,
                  scenario === 'anthropic-wrong-provider' ? profile.id : anthropicProfile.id,
                  'docs/providers.md',
                  '--policy',
                  policyFile,
                  ...(scenario === 'anthropic-saved' ? [] : ['--native-trust', '--source-consent']),
                  ...([
                    'anthropic-explicit',
                    'anthropic-credits',
                    'anthropic-wrong-provider',
                  ].includes(scenario)
                    ? ['--confirm-subscription-only']
                    : []),
                  ...(scenario === 'anthropic-credits' ? ['--existing-credits'] : []),
                ];
    }
    const googleMode: Snapshot['nativeRuns'][number]['permissionMode'] =
      googleProfile.permissionModes.find((mode) => scenario === `google-${mode}`);
    if (scenario.startsWith('google-')) {
      args =
        scenario === 'google-show'
          ? ['task', 'show', task.id]
          : scenario === 'google-wrong-command'
            ? ['native', 'profiles', '--permission-mode', 'strict']
            : scenario === 'google-reviewer'
              ? ['task', 'prepare-evaluation', task.id, googleProfile.id, '--grants', grantsFile]
              : [
                  'task',
                  'prepare-native',
                  task.id,
                  scenario === 'google-wrong-provider' ? anthropicProfile.id : googleProfile.id,
                  'docs/providers.md',
                  '--policy',
                  policyFile,
                  ...(scenario === 'google-saved' ? [] : ['--native-trust', '--source-consent']),
                  ...(scenario === 'google-missing-confirmations' || scenario === 'google-saved'
                    ? []
                    : ['--confirm-subscription-only']),
                  ...(scenario === 'google-missing-mode' || scenario === 'google-saved'
                    ? []
                    : [
                        '--permission-mode',
                        scenario === 'google-invalid-mode' ? 'automatic' : (googleMode ?? 'strict'),
                      ]),
                  ...(scenario === 'google-credits' ? ['--existing-credits'] : []),
                ];
    }
    if (scenario.startsWith('repository-')) {
      args =
        scenario === 'repository-show'
          ? ['task', 'show', task.id]
          : scenario === 'repository-reviewer'
            ? ['task', 'prepare-evaluation', task.id, repositoryProfile.id, '--grants', grantsFile]
            : scenario === 'repository-file-command'
              ? [
                  'task',
                  'prepare-native',
                  task.id,
                  repositoryProfile.id,
                  'net.mjs',
                  '--policy',
                  policyFile,
                ]
              : [
                  'task',
                  'prepare-repository',
                  task.id,
                  scenario === 'repository-wrong-profile' ? profile.id : repositoryProfile.id,
                  '--policy',
                  policyFile,
                  ...(scenario === 'repository-saved'
                    ? []
                    : ['--native-trust', '--source-consent']),
                  ...(scenario === 'repository-credits' ? ['--existing-credits'] : []),
                  ...(scenario === 'repository-billing-option'
                    ? ['--confirm-subscription-only']
                    : []),
                  ...(scenario === 'repository-mode-option' ? ['--permission-mode', 'strict'] : []),
                ];
    }
    if (handing) {
      if (scenario.startsWith('handoff-target')) {
        args = [
          'task',
          'prepare-native',
          task.id,
          profile.id,
          'docs/providers.md',
          '--policy',
          policyFile,
          '--native-trust',
          '--source-consent',
          '--handoff-target',
          scenario === 'handoff-target-repository' ? repositoryProfile.id : 'anthropic-file-v1',
        ];
        if (scenario === 'handoff-targets')
          args.push('--handoff-target', 'openai-file-v1:existing-credits');
        if (scenario === 'handoff-target-duplicate')
          args.push('--handoff-target', 'anthropic-file-v1');
        if (scenario === 'handoff-target-wrong-command')
          args = ['native', 'profiles', '--handoff-target', 'anthropic-file-v1'];
      } else if (scenario === 'handoff-show') args = ['task', 'show', task.id];
      else if (['handoff-start', 'handoff-start-blocked', 'handoff-uncertain'].includes(scenario))
        args = ['task', 'start-handoff', task.id];
      else {
        const recipient =
          scenario === 'handoff-google'
            ? googleProfile.id
            : ['handoff-anthropic', 'handoff-missing-attestation'].includes(scenario)
              ? anthropicProfile.id
              : scenario === 'handoff-unlisted'
                ? repositoryProfile.id
                : profile.id;
        args = [
          'task',
          'prepare-handoff',
          task.id,
          recipient,
          ...(scenario === 'handoff-missing-consent' ? [] : ['--native-trust', '--source-consent']),
          ...(['handoff-anthropic', 'handoff-google'].includes(scenario)
            ? ['--confirm-subscription-only']
            : []),
          ...(scenario === 'handoff-google' ? ['--permission-mode', 'request-review'] : []),
          ...(scenario === 'handoff-openai-credits' ? ['--existing-credits'] : []),
        ];
      }
    }
    const result = await execute(args, scenario !== 'changes');
    if (handing) {
      const rejected = [
        'handoff-target-duplicate',
        'handoff-target-repository',
        'handoff-target-wrong-command',
        'handoff-missing-consent',
        'handoff-missing-attestation',
        'handoff-unlisted',
        'handoff-blocked',
        'handoff-start-blocked',
      ].includes(scenario);
      if (rejected) {
        assert.equal(result.code, 1, result.errors);
        assert.equal(
          received.some((command) => command.command !== 'GetSnapshot'),
          false,
        );
        if (
          [
            'handoff-target-duplicate',
            'handoff-target-repository',
            'handoff-target-wrong-command',
            'handoff-missing-consent',
          ].includes(scenario)
        )
          assert.deepEqual(received, []);
        if (scenario === 'handoff-blocked') assert.match(result.errors, /ownership-unknown/u);
        if (scenario === 'handoff-start-blocked') assert.match(result.errors, /source-changed/u);
      } else if (scenario === 'handoff-show') {
        assert.equal(result.code, 0, result.errors);
        assert.deepEqual(JSON.parse(result.output).nativeRun.handoff, handoff);
        const plain = await execute(args, false);
        for (const value of [
          handoff.pending?.preparationId,
          handoff.pending?.packetId,
          handoff.pending?.baseHash,
          'Retained unverified base',
          'Original limits 4 attempts, 5 minutes',
          'Start available',
        ])
          assert(plain.output.includes(value as string));
        assert(received.every((command) => command.command === 'GetSnapshot'));
      } else {
        assert.equal(result.code, scenario === 'handoff-uncertain' ? 2 : 0, result.errors);
        const receipt = JSON.parse(result.output);
        assert.equal(receipt.command.expectedRevision, task.revision);
        if (scenario === 'handoff-targets') {
          assert.equal(receipt.command.command, 'PrepareNativeRun');
          assert.deepEqual(receipt.command.payload.handoffTargets, [
            { profileId: 'anthropic-file-v1', creditPolicy: 'ordinary' },
            { profileId: 'openai-file-v1', creditPolicy: 'existing-credits' },
          ]);
          assert.deepEqual(receipt.command.payload.policy, policy);
        } else if (scenario === 'handoff-start' || scenario === 'handoff-uncertain') {
          assert.equal(receipt.command.command, 'StartNativeHandoff');
          assert.deepEqual(receipt.command.payload, {
            taskId: task.id,
            runId: run.id,
            preparationId: artifact.id,
          });
          if (scenario === 'handoff-uncertain') {
            const file = join(fixture.home, 'handoff-receipt.json');
            writeFileSync(file, result.output);
            const retried = await execute(['retry', file]);
            assert.equal(retried.code, 2);
            assert.deepEqual(JSON.parse(retried.output).command, receipt.command);
          }
        } else {
          const profileId: string =
            scenario === 'handoff-google'
              ? googleProfile.id
              : scenario === 'handoff-anthropic'
                ? anthropicProfile.id
                : profile.id;
          assert.equal(receipt.command.command, 'PrepareNativeHandoff');
          assert.deepEqual(receipt.command.payload, {
            taskId: task.id,
            runId: run.id,
            fromAttemptId: handoff.currentAttemptId,
            profileId,
            creditPolicy: scenario === 'handoff-openai-credits' ? 'existing-credits' : 'ordinary',
            consent: 'explicit',
            ...(['handoff-anthropic', 'handoff-google'].includes(scenario)
              ? { billingAttestation }
              : {}),
            ...(scenario === 'handoff-google' ? { permissionMode: 'request-review' } : {}),
          });
        }
        assert.equal(received[0].command, 'GetSnapshot');
        assert.equal(
          received.filter(
            (command) =>
              command.command === 'PrepareNativeHandoff' ||
              command.command === 'StartNativeHandoff' ||
              command.command === 'PrepareNativeRun',
          ).length,
          scenario === 'handoff-uncertain' ? 2 : 1,
        );
      }
      continue;
    }

    if (scenario.startsWith('repository-')) {
      if (scenario === 'repository-show') {
        assert.equal(result.code, 0, result.errors);
        assert.deepEqual(JSON.parse(result.output).nativeRun, selectedNativeRun);
        const plain = await execute(args, false);
        for (const fact of [
          'Repository 4 files, 2048 bytes',
          'Native sandbox workspace-write',
          'Native approval never',
          'Native network off',
          '9'.repeat(64),
        ])
          assert(plain.output.includes(fact), fact);
        assert(!plain.output.includes('Target unknown'));
      } else if (
        ['repository-explicit', 'repository-saved', 'repository-credits'].includes(scenario)
      ) {
        assert.equal(result.code, 0, result.errors);
        const receipt = JSON.parse(result.output);
        assert.equal(receipt.command.command, 'PrepareNativeRun');
        assert.equal(receipt.command.expectedRevision, task.revision);
        assert.deepEqual(receipt.command.payload, {
          taskId: task.id,
          profileId: repositoryProfile.id,
          policy: repositoryPolicy,
          creditPolicy: scenario === 'repository-credits' ? 'existing-credits' : 'ordinary',
          consent: scenario === 'repository-saved' ? 'saved' : 'explicit',
        });
        assert.deepEqual(
          received.map((value) => value.command),
          ['GetSnapshot', 'PrepareNativeRun'],
        );
      } else {
        assert.equal(result.code, 1, scenario);
        assert.equal(
          received.some((value) => value.command !== 'GetSnapshot'),
          false,
        );
        if (scenario === 'repository-reviewer')
          assert.match(result.errors, /Choose a supported OpenAI reviewer profile/u);
        if (scenario.endsWith('-tools')) assert.match(result.errors, /run-native-tools grant/u);
        if (scenario === 'repository-file-command')
          assert.match(result.errors, /Use task prepare-repository/u);
      }
      continue;
    }
    if (scenario.startsWith('google-')) {
      if (scenario === 'google-show') {
        assert.equal(result.code, 0, result.errors);
        assert.deepEqual(JSON.parse(result.output).nativeRun, selectedNativeRun);
        const plain = await execute(args, false);
        assert.match(plain.output, /Expected native permission mode: strict/u);
        assert.match(plain.output, /user-attested subscription login, paid extra usage disabled/u);
      } else if (googleMode || scenario === 'google-saved') {
        assert.equal(result.code, 0, result.errors);
        const receipt = JSON.parse(result.output);
        assert.equal(receipt.command.command, 'PrepareNativeRun');
        assert.equal(receipt.command.expectedRevision, task.revision);
        assert.deepEqual(receipt.command.payload, {
          taskId: task.id,
          profileId: googleProfile.id,
          targetPath: 'docs/providers.md',
          policy,
          creditPolicy: 'ordinary',
          consent: scenario === 'google-saved' ? 'saved' : 'explicit',
          billingAttestation,
          permissionMode: googleMode ?? 'strict',
        });
        assert.deepEqual(
          received.map((value) => value.command),
          ['GetSnapshot', 'PrepareNativeRun'],
        );
      } else {
        assert.equal(result.code, 1, scenario);
        assert.equal(
          received.some((value) => value.command !== 'GetSnapshot'),
          false,
        );
        if (scenario === 'google-wrong-command') assert.deepEqual(received, []);
        if (scenario === 'google-reviewer')
          assert.match(result.errors, /Choose a supported OpenAI reviewer profile/u);
        if (scenario === 'google-missing-mode' || scenario === 'google-invalid-mode')
          assert.match(result.errors, /Choose the current Google client setting/u);
      }
      continue;
    }
    if (scenario.startsWith('anthropic-')) {
      if (scenario === 'anthropic-show') {
        assert.equal(result.code, 0, result.errors);
        assert.deepEqual(JSON.parse(result.output).nativeRun, selectedNativeRun);
        const plain = await execute(args, false);
        assert.match(plain.output, /user-attested subscription login, paid extra usage disabled/u);
      } else if (scenario === 'anthropic-explicit' || scenario === 'anthropic-saved') {
        assert.equal(result.code, 0, result.errors);
        const receipt = JSON.parse(result.output);
        assert.equal(receipt.command.command, 'PrepareNativeRun');
        assert.equal(receipt.command.expectedRevision, task.revision);
        assert.deepEqual(receipt.command.payload, {
          taskId: task.id,
          profileId: anthropicProfile.id,
          targetPath: 'docs/providers.md',
          policy,
          creditPolicy: 'ordinary',
          consent: scenario === 'anthropic-saved' ? 'saved' : 'explicit',
          billingAttestation,
        });
        assert.deepEqual(
          received.map((value) => value.command),
          ['GetSnapshot', 'PrepareNativeRun'],
        );
      } else {
        assert.equal(result.code, 1, scenario);
        assert.equal(
          received.some((value) => value.command !== 'GetSnapshot'),
          false,
        );
        if (scenario === 'anthropic-wrong-command') assert.deepEqual(received, []);
        if (scenario === 'anthropic-reviewer')
          assert.match(result.errors, /Choose a supported OpenAI reviewer profile/u);
      }
      continue;
    }
    if (
      [
        'evaluation-project-empty',
        'evaluation-project-limit',
        'evaluation-project-duplicate',
        'evaluation-sample-files',
        'evaluation-verification-files',
        'evaluation-unknown-recipe',
        'evaluation-recipe-other-command',
      ].includes(scenario)
    ) {
      assert.equal(result.code, 1, scenario);
      assert.deepEqual(received, [], scenario);
      continue;
    }
    if (
      ['approval-missing', 'accept-approval-mismatch', 'accept-approval-ambiguous'].includes(
        scenario,
      )
    ) {
      assert.equal(result.code, 1);
      const receipt = JSON.parse(result.output);
      assert.deepEqual(receipt.result.entity, pendingTask);
      assert.equal(receipt.nextCommand, undefined);
      const original = received.find(
        (value) =>
          value.command === (scenario === 'approval-missing' ? 'ExportPatch' : 'AcceptCandidate'),
      );
      assert.deepEqual(receipt.command, original);
      assert.equal(received.filter((value) => value.command === 'GetSnapshot').length, 2);
      assert.equal(
        received.some((value) => ['ResolveApproval', 'GetArtifact'].includes(value.command)),
        false,
      );
      assert.equal(existsSync(destination), false);
      continue;
    }
    if (scenario.startsWith('accept-')) {
      if (scenario === 'accept-invalid-ref') {
        assert.equal(result.code, 1);
        assert.equal(
          received.some((value) => value.command === 'AcceptCandidate'),
          false,
        );
        continue;
      }
      assert.equal(result.code, scenario === 'accept-uncertain' ? 2 : 0, result.errors);
      const receipt = JSON.parse(result.output);
      assert.equal(receipt.command.command, 'AcceptCandidate');
      assert.equal(receipt.command.expectedRevision, task.revision);
      assert.deepEqual(receipt.command.payload, {
        taskId: task.id,
        candidateId: candidate.id,
        destinationRef: 'refs/heads/feat/checked',
      });
      assert.deepEqual(
        received.map((value) => value.command),
        scenario === 'accept-approval'
          ? ['GetSnapshot', 'AcceptCandidate', 'GetSnapshot']
          : ['GetSnapshot', 'AcceptCandidate'],
      );
      if (scenario === 'accept-approval') {
        assert.deepEqual(receipt.result.entity, pendingTask);
        assert.deepEqual(receipt.command, received[1]);
        assert.deepEqual(receipt.nextCommand, [
          'crewkite',
          'task',
          'approve',
          approval.approvalId,
          '--home',
          fixture.home,
          '--json',
        ]);
        const plain = await execute(args, false);
        assert.equal(plain.code, 0);
        assert(plain.output.includes('Local branch approval required.'));
        assert(plain.output.includes(approval.approvalId));
        const saved = join(fixture.home, 'pending-acceptance.receipt.json');
        writeFileSync(saved, result.output);
        const retry = await execute(['retry', saved]);
        assert.equal(retry.code, 0, retry.errors);
        assert.deepEqual(JSON.parse(retry.output).command, receipt.command);
        assert.deepEqual(JSON.parse(retry.output).nextCommand, receipt.nextCommand);
      }
      if (scenario === 'accept-uncertain') {
        const receiptFile = join(fixture.home, 'accept-receipt.json');
        writeFileSync(receiptFile, result.output);
        const retried = await execute(['retry', receiptFile]);
        assert.equal(retried.code, 2);
        assert.deepEqual(JSON.parse(retried.output).command, receipt.command);
      }
      continue;
    }
    if (['evaluation-partial-consent', 'evaluation-invalid-grants'].includes(scenario)) {
      assert.equal(result.code, 1, result.errors);
      assert.equal(
        received.some((command) => command.command === 'PrepareCandidateEvaluation'),
        false,
      );
      continue;
    }
    if (
      [
        'evaluation-show',
        'evaluation-reviewed',
        'evaluation-project-show',
        'evaluation-verification-show',
      ].includes(scenario)
    ) {
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
        `Remaining total attempts ${preview.remainingBudgets.attempts}, minutes ${preview.remainingBudgets.minutes}`,
        scenario === 'evaluation-reviewed' ? 'already-started' : 'checks-required',
        scenario === 'evaluation-reviewed'
          ? 'Local acceptance available, available'
          : 'Local acceptance unavailable, evidence-incomplete',
      ])
        assert(plain.output.includes(value), value);
      if (scenario === 'evaluation-project-show') {
        assert(plain.output.includes('Recipe project-node-tests-v1'));
        for (const file of preview.testFiles)
          assert(
            plain.output.includes(
              `Test file ${file.path}, ${file.hash}, ${file.bytes} bytes, ${file.mode}`,
            ),
          );
      }
      if (preview.verification) {
        for (const value of [
          'Recipe crewkite-verify-v1',
          'Stages policy, lint, types, node-tests, build, desktop',
          'Maximum 5 minutes including staging and cleanup',
          'Platform darwin, arm64',
          preview.verification.toolchainHash,
          preview.verification.baselineHash,
          preview.verification.lockHash,
          ...Object.values(preview.verification.executables).flatMap((value) => [
            value.version,
            value.sha256,
          ]),
        ])
          assert(plain.output.includes(value), value);
      }
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
              ...(scenario === 'evaluation-project'
                ? { checkRecipeId: 'project-node-tests-v1', testFiles: projectTestFiles }
                : verification
                  ? { checkRecipeId: 'crewkite-verify-v1' }
                  : { checkRecipeId: 'node-tests-v1' }),
              reviewer: { profileId: profile.id, methodId: 'keep-it-simple', cycles: 1 },
              creditPolicy: scenario === 'evaluation-saved' ? 'existing-credits' : 'ordinary',
              consent: savedEvaluation ? 'saved' : 'explicit',
              grants: selectedGrants,
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
        repositoryProfile,
        googleProfile,
        anthropicProfile,
        { ...profile, creditPolicies: [...profile.creditPolicies] },
      ]);
      const plain = await execute(args, false);
      assert.match(
        plain.output,
        /medium requested effort.*effective effort unknown.*service tier unknown.*qualification pending/u,
      );
      assert(
        plain.output.includes(`${profile.id}  ${profile.model}  ${profile.effort}  available`),
      );
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
      assert.deepEqual(receipt.result.entity, pendingTask);
      assert.deepEqual(
        receipt.command,
        received.find((value) => value.command === 'ExportPatch'),
      );
      assert.equal(received.filter((value) => value.command === 'GetSnapshot').length, 2);
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
