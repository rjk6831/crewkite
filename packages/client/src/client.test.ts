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
  CommandSchema,
  type ConversationEntry,
  type Event,
  MAX_FRAME_BYTES,
  type Snapshot,
  type TaskConversationState,
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
  usageReaders: [],
  googleAcpSetup: null,
  nativeRuns: [],
  candidateEvaluations: [],
  combinedRuns: [],
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
    { recipe: 'usage', expected: 30000 },
    { recipe: 'StartRun', expected: 40000 },
    { recipe: 'StartRun', timeoutMs: 10000, expected: 10000 },
    { recipe: 'StartRun', timeoutMs: 50000, expected: 50000 },
    { recipe: 'InitializeGoogleAcp', expected: 15000 },
    { recipe: 'AuthenticateGoogleAcp', expected: 130000 },
    { recipe: 'DiscoverGoogleAcp', expected: 30000 },
    { recipe: 'StopGoogleAcpSetup', expected: 30000 },
    { recipe: 'AuthenticateGoogleAcp', timeoutMs: 10000, expected: 10000 },
    { recipe: 'AuthenticateGoogleAcp', timeoutMs: 140000, expected: 140000 },
    { recipe: 'usage', timeoutMs: 10000, expected: 10000 },
    { recipe: 'usage', timeoutMs: 40000, expected: 40000 },
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
          : row.recipe === 'usage'
            ? {
                protocol: 1,
                key: `cmd_${suffix}`,
                actor,
                command: 'ObserveUsage',
                expectedRevision: 0,
                payload: { family: 'google' },
              }
            : row.recipe === 'StartRun'
              ? {
                  protocol: 1,
                  key: `cmd_${suffix}`,
                  actor,
                  command: 'StartRun',
                  expectedRevision: task.revision,
                  payload: { taskId: task.id, runId: run.id },
                }
              : row.recipe === 'InitializeGoogleAcp' ||
                  row.recipe === 'AuthenticateGoogleAcp' ||
                  row.recipe === 'DiscoverGoogleAcp' ||
                  row.recipe === 'StopGoogleAcpSetup'
                ? CommandSchema.parse({
                    protocol: 1,
                    key: `cmd_${suffix}`,
                    actor,
                    command: row.recipe,
                    expectedRevision: 0,
                    payload: {
                      profileId: 'google-acp-v1',
                      ...(row.recipe === 'StopGoogleAcpSetup'
                        ? { operationId: `cmd_${suffix}` }
                        : { consent: 'explicit' }),
                      ...(['AuthenticateGoogleAcp', 'DiscoverGoogleAcp'].includes(row.recipe)
                        ? { proofId: artifact.id }
                        : {}),
                      ...(row.recipe === 'AuthenticateGoogleAcp'
                        ? { method: 'oauth-personal' }
                        : {}),
                    },
                  })
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

  const project = { id: task.projectId, name: 'fixture-project', revision: 0 };
  const createdTask = { ...task, revision: 0 };
  const createArgs = [
    'task',
    'create',
    project.id,
    '--title',
    task.title,
    '--outcome',
    task.outcome,
    '--criterion',
    task.criteria[0],
    '--criterion',
    'The original source stays unchanged',
  ];
  const creationCases = [
    { name: 'project', args: ['project', 'add', '.'], plain: true },
    { name: 'project-existing', args: ['project', 'add', '/fixture/project'] },
    { name: 'task', args: createArgs },
    { name: 'task-plain', args: createArgs, plain: true },
    { name: 'task-blocked', args: createArgs },
    { name: 'task-uncertain', args: createArgs },
    { name: 'missing-path', args: ['project', 'add'], invalid: true },
    { name: 'blank-path', args: ['project', 'add', ' '], invalid: true },
    { name: 'extra-path', args: ['project', 'add', '.', 'other'], invalid: true },
    {
      name: 'missing-title',
      args: [...createArgs.slice(0, 3), ...createArgs.slice(5)],
      invalid: true,
    },
    {
      name: 'missing-outcome',
      args: [...createArgs.slice(0, 5), ...createArgs.slice(7)],
      invalid: true,
    },
    { name: 'missing-criteria', args: createArgs.slice(0, 7), invalid: true },
    { name: 'blank-criterion', args: [...createArgs, '--criterion', '  '], invalid: true },
    {
      name: 'invalid-project',
      args: [...createArgs.slice(0, 2), 'not-an-id', ...createArgs.slice(3)],
      invalid: true,
    },
    {
      name: 'oversized-title',
      args: [...createArgs.slice(0, 4), 'x'.repeat(201), ...createArgs.slice(5)],
      invalid: true,
    },
    {
      name: 'oversized-outcome',
      args: [...createArgs.slice(0, 6), 'x'.repeat(4097), ...createArgs.slice(7)],
      invalid: true,
    },
    {
      name: 'too-many-criteria',
      args: [
        ...createArgs.slice(0, 7),
        ...Array.from({ length: 101 }, () => ['--criterion', 'A criterion']).flat(),
      ],
      invalid: true,
    },
    { name: 'wrong-command', args: ['project', 'add', '.', '--title', task.title], invalid: true },
    { name: 'extra-task', args: [...createArgs, 'other'], invalid: true },
  ];

  const acpProfile: Snapshot['nativeProfiles'][number] = {
    ...googleProfile,
    id: 'google-acp-v1',
    effort: 'thought-low',
    effortSupported: ['thought-low', 'thought-high'],
    configOptions: {
      model: {
        optionId: 'model',
        currentValue: 'observed-model',
        supported: ['observed-model', 'other-model'],
      },
      thoughtLevel: {
        optionId: 'thought_level',
        currentValue: 'thought-low',
        supported: ['thought-low', 'thought-high'],
      },
    },
    capabilities: {
      protocolVersion: 1,
      authMethods: ['oauth-personal'],
      sessionClose: true,
      fs: false,
      terminal: false,
    },
    model: 'observed-model',
    permissionModes: ['request-review'],
    reason: 'qualification-pending',
  };
  const acpSetup: NonNullable<Snapshot['googleAcpSetup']> = {
    profileId: 'google-acp-v1',
    revision: 7,
    state: 'ready',
    operationId: null,
    proofId: artifact.id,
    client: { version: '1.4.0', sha256: 'a'.repeat(64), signerTeamId: 'TESTTEAM' },
    auth: { method: 'oauth-personal', status: 'authenticated' },
    reason: 'qualification-pending',
  };
  const acpCases = [
    'show',
    'initialize',
    'authenticate',
    'discover',
    'stop',
    'missing-consent',
    'missing-proof',
    'missing-operation',
    'wrong-family',
    'prepare',
    'saved',
    'model',
    'thought',
    'account',
    'credits',
    'mode',
    'handoff',
    'autopilot',
    'model-only',
    'import-consent-missing',
    'approval',
  ] as const;
  const usageReader: Snapshot['usageReaders'][number] = {
    id: 'google-usage-v1',
    family: 'google',
    clientVersion: '1.4.0',
    enabled: true,
    available: true,
    reason: 'available',
    lastAttemptAt: '2026-10-17T10:00:00.000Z',
    lastObservedAt: '2026-10-17T10:00:00.000Z',
  };
  const usageWindows: Snapshot['usage'] = [
    {
      observation: {
        routeId: `rte_${suffix}`,
        windowId: 'weekly',
        kind: 'weekly',
        remaining: { value: 42.25, unit: 'percent' },
        resetsAt: '2026-10-18T10:00:00.000Z',
        observedAt: '2026-10-17T10:00:00.000Z',
        source: 'client',
        confidence: 'reported',
      },
      state: 'stale',
    },
  ];
  const usageCases: Array<{
    name: string;
    args: string[];
    consent?: boolean;
    invalid?: boolean;
    reason?: string;
  }> = [
    { name: 'show', args: ['usage', 'show'] },
    {
      name: 'enable',
      args: ['usage', 'refresh', '--family', 'google', '--consent'],
      consent: true,
    },
    { name: 'refresh', args: ['usage', 'refresh', '--family', 'google'] },
    {
      name: 'disable',
      args: ['usage', 'refresh', '--family', 'google', '--no-consent'],
      consent: false,
    },
    {
      name: 'cooldown',
      args: ['usage', 'refresh', '--family', 'google'],
      reason: 'usage-reader-cooldown',
    },
    {
      name: 'off',
      args: ['usage', 'refresh', '--family', 'google'],
      reason: 'usage-reader-not-enabled',
    },
    {
      name: 'active',
      args: ['usage', 'refresh', '--family', 'google'],
      reason: 'google-operation-active',
    },
    {
      name: 'unknown',
      args: ['usage', 'refresh', '--family', 'google'],
      reason: 'google-ownership-unknown',
    },
    {
      name: 'unavailable',
      args: ['usage', 'refresh', '--family', 'google'],
      reason: 'client-unavailable',
    },
    { name: 'missing-family', args: ['usage', 'refresh'], invalid: true },
    { name: 'wrong-family', args: ['usage', 'refresh', '--family', 'openai'], invalid: true },
    { name: 'show-family', args: ['usage', 'show', '--family', 'google'], invalid: true },
    { name: 'wrong-command', args: ['health', '--consent'], invalid: true },
    { name: 'extra', args: ['usage', 'show', 'other'], invalid: true },
    { name: 'unknown-action', args: ['usage', 'enable'], invalid: true },
    {
      name: 'conflicting-consent',
      args: ['usage', 'refresh', '--family', 'google', '--consent', '--no-consent'],
      invalid: true,
    },
  ];

  const planningSelection = {
    role: 'lead' as const,
    profileId: 'openai-file-v1' as const,
    creditPolicy: 'ordinary' as const,
    limits: { attempts: 8, minutes: 20, concurrency: 2 },
    consent: 'explicit' as const,
  };
  const conversationState: TaskConversationState = {
    taskId: task.id,
    revision: task.revision,
    contractStatus: 'provisional',
    purpose: 'conversation',
    phase: 'planned',
    configuration: {
      revision: 1,
      selection: planningSelection,
      routeId: run.roles[0].routeId,
      requestedModel: 'requested-model',
      effectiveModel: null,
      requestedEffort: 'low',
      effectiveEffort: null,
    },
    currentRunId: run.id,
    activeAttempt: null,
    budget: {
      limits: planningSelection.limits,
      remaining: { attempts: 6, minutes: 18, concurrency: 2 },
    },
    queuedInputCount: 1,
    pendingQuestions: [{ id: `msg_${suffix}`, cursor: '7' }],
    proposal: {
      id: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      hash: 'c'.repeat(64),
      runId: run.id,
      revision: 2,
    },
    adoptedProposal: null,
    send: { available: true, reason: 'available', disposition: 'turn' },
    adopt: { available: true, reason: 'available' },
  };
  const conversationEntry: ConversationEntry = {
    id: `msg_${suffix}`,
    taskId: task.id,
    revision: 1,
    cursor: '7',
    at: '2026-10-17T10:00:00.000Z',
    text: 'Inspect \u001b[31mthe total\roverwrite',
    kind: 'user-message',
    author: { kind: 'user' },
  };
  const planningArgs = [
    '--role',
    'lead',
    '--profile',
    'openai-file-v1',
    '--credit-policy',
    'ordinary',
    '--attempts',
    '8',
    '--minutes',
    '20',
    '--concurrency',
    '2',
    '--consent',
  ];
  const conversationRows = [
    {
      args: ['create', task.projectId, '--text', 'Repair the total', ...planningArgs],
      command: 'CreateTaskDiscussion',
      payload: { projectId: task.projectId, text: 'Repair the total', planning: planningSelection },
    },
    {
      args: [
        'configure',
        task.id,
        ...planningArgs.map((value) =>
          value === 'lead' ? 'orchestrator' : value === 'ordinary' ? 'existing-credits' : value,
        ),
      ],
      command: 'ConfigureTaskConversation',
      payload: {
        taskId: task.id,
        planning: { ...planningSelection, role: 'orchestrator', creditPolicy: 'existing-credits' },
      },
    },
    {
      args: ['send', task.id, '--text', 'Keep this exact message'],
      command: 'SendTaskMessage',
      payload: { taskId: task.id, text: 'Keep this exact message' },
    },
    {
      args: ['guide', task.id, '--text', 'Keep the scope bounded'],
      command: 'QueueTaskGuidance',
      payload: { taskId: task.id, text: 'Keep the scope bounded' },
    },
    {
      args: [
        'answer',
        task.id,
        '--question-id',
        conversationEntry.id,
        '--text',
        'The total includes tax',
      ],
      command: 'AnswerTaskQuestion',
      payload: {
        taskId: task.id,
        questionId: conversationEntry.id,
        text: 'The total includes tax',
      },
    },
    {
      args: [
        'adopt',
        task.id,
        '--proposal-id',
        conversationState.proposal?.id as string,
        '--proposal-hash',
        'c'.repeat(64),
      ],
      command: 'AdoptTaskPlan',
      payload: {
        taskId: task.id,
        proposalId: conversationState.proposal?.id,
        proposalHash: 'c'.repeat(64),
      },
    },
    {
      args: ['show', task.id, '--before-cursor', '9'],
      command: 'GetTaskConversation',
      payload: { taskId: task.id, beforeCursor: '9' },
    },
    ...[
      [
        'create',
        task.projectId,
        '--text',
        'Goal',
        ...planningArgs.filter((value) => value !== '--consent'),
      ],
      [
        'create',
        task.projectId,
        '--text',
        'Goal',
        ...planningArgs.map((value) => (value === 'lead' ? 'coder' : value)),
      ],
      [
        'configure',
        task.id,
        ...planningArgs.map((value) => (value === 'openai-file-v1' ? '/tmp/client' : value)),
      ],
      ['configure', task.id, ...planningArgs.map((value) => (value === '8' ? '1e2' : value))],
      ['configure', task.id, ...planningArgs.map((value) => (value === '20' ? '1441' : value))],
      ['configure', task.id, ...planningArgs, '--text', 'No scope amendment'],
      ['send', task.id, '--text', ' '],
      ['send', task.id, '--text', 'é'.repeat(2049)],
      ['send', task.id, '--text', 'No grants', '--grants', 'grant.json'],
      ['send', task.id, '--text', 'No authority', '--consent'],
      ['answer', task.id, '--text', 'Missing question'],
      ['answer', task.id, '--question-id', 'not-an-id', '--text', 'Bad question'],
      ['adopt', task.id, '--proposal-id', conversationEntry.id],
      ['adopt', task.id, '--proposal-id', conversationEntry.id, '--proposal-hash', 'bad-hash'],
      ['show', task.id, '--before-cursor', '-1'],
      ['show', task.id, '--policy', 'policy.json'],
      ['show', task.id, 'extra'],
      ['unknown', task.id],
    ].map((args) => ({ args, command: null, payload: null })),
  ];
  const conversationCommands: Command[] = [];
  let conversationOutcome: 'applied' | 'outcome-unknown' | 'blocked' = 'applied';
  const conversationFixture = await serve((message, socket) => {
    if (message.type === 'hello')
      socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: snapshot.cursor }));
    if (message.type !== 'command') return;
    const command = message.command;
    conversationCommands.push(command);
    const result: import('@crewkite/contracts').CommandResult =
      command.command === 'GetSnapshot'
        ? {
            outcome: 'applied',
            data: { kind: 'snapshot', snapshot: { ...snapshot, tasks: [task] } },
          }
        : command.command === 'GetTaskConversationState'
          ? { outcome: 'applied', data: { kind: 'conversation-state', state: conversationState } }
          : command.command === 'GetTaskConversation'
            ? {
                outcome: 'applied',
                data: {
                  kind: 'conversation',
                  taskId: task.id,
                  entries: [conversationEntry],
                  nextBeforeCursor: '7',
                },
              }
            : {
                outcome: conversationOutcome,
                reason: 'queued\u001b[31m\rinput',
                next: 'Read conversation state.',
                entity: task,
              };
    socket.write(encodeFrame({ type: 'result', key: command.key, result }));
  });
  context.after(() => conversationFixture.close());
  const { runCli } = await import('../../../apps/cli/src/main.ts');
  const executeConversation = async (args: string[], json = true) => {
    let output = '',
      errors = '';
    const code = await runCli(
      [...args, ...(json ? ['--json'] : []), '--home', conversationFixture.home],
      {
        out: (text) => {
          output += text;
        },
        err: (text) => {
          errors += text;
        },
      },
    );
    return { code, output, errors };
  };
  for (const row of conversationRows) {
    conversationCommands.length = 0;
    const result = await executeConversation(['conversation', ...row.args]);
    if (!row.command) {
      assert.equal(result.code, 1, row.args.join(' '));
      assert(
        conversationCommands.every((command) =>
          ['GetSnapshot', 'GetTaskConversationState'].includes(command.command),
        ),
      );
      continue;
    }
    assert.equal(result.code, 0, result.errors);
    const command = conversationCommands.at(-1);
    assert.equal(command?.command, row.command);
    assert.deepEqual(command?.payload, row.payload);
    if (row.command === 'GetTaskConversation') {
      assert.deepEqual(
        conversationCommands.map((command) => command.command),
        ['GetSnapshot', 'GetTaskConversationState', 'GetTaskConversation'],
      );
      assert.deepEqual(JSON.parse(result.output), {
        state: conversationState,
        conversation: {
          kind: 'conversation',
          taskId: task.id,
          entries: [conversationEntry],
          nextBeforeCursor: '7',
        },
      });
      const plain = await executeConversation(['conversation', ...row.args], false);
      assert(plain.output.includes('effective model unknown'));
      assert(plain.output.includes(conversationEntry.id));
      assert(plain.output.includes('Older page before 7'));
      assert(!plain.output.includes('\u001b'));
      assert(plain.output.includes('\\u001b'));
      assert(!plain.output.includes('\r'));
      assert(plain.output.includes('\\u000d'));
    } else {
      assert.equal(
        command && 'expectedRevision' in command ? command.expectedRevision : null,
        row.command === 'CreateTaskDiscussion' ? 0 : task.revision,
      );
      const receipt = JSON.parse(result.output);
      assert.deepEqual(receipt.command, command);
      const plain = await executeConversation(['conversation', ...row.args], false);
      assert(!plain.output.includes('\u001b'));
      assert(plain.output.includes('\\u001b'));
      assert(!plain.output.includes('\r'));
      assert(plain.output.includes('\\u000d'));
    }
  }
  conversationOutcome = 'outcome-unknown';
  const uncertainConversation = await executeConversation([
    'conversation',
    'send',
    task.id,
    '--text',
    'Keep the original key',
  ]);
  assert.equal(uncertainConversation.code, 2);
  const savedConversationReceipt = JSON.parse(uncertainConversation.output);
  const conversationReceiptPath = join(conversationFixture.home, 'conversation-receipt.json');
  writeFileSync(conversationReceiptPath, uncertainConversation.output);
  conversationOutcome = 'applied';
  const retriedConversation = await executeConversation(['retry', conversationReceiptPath]);
  assert.equal(retriedConversation.code, 0, retriedConversation.errors);
  assert.deepEqual(
    JSON.parse(retriedConversation.output).command,
    savedConversationReceipt.command,
  );
  assert.deepEqual(conversationCommands.at(-1), savedConversationReceipt.command);
  conversationOutcome = 'blocked';
  const refusedConversation = await executeConversation([
    'conversation',
    'guide',
    task.id,
    '--text',
    'No new authority',
  ]);
  assert.equal(refusedConversation.code, 2);
  assert.equal(JSON.parse(refusedConversation.output).result.outcome, 'blocked');

  const localBinding: NonNullable<Snapshot['nativeRuns'][number]['localModel']> = {
    version: 2,
    identityKind: 'runtime-metadata',
    connectorId: 'local-sdk-v1',
    connectionRevision: 2,
    connectionHash: '2'.repeat(64),
    setupHash: '1'.repeat(64),
    runtimeVersion: 'fixture',
    runtimeBuild: 1,
    modelKey: 'loaded-model',
    instanceReference: 'loaded-instance',
    modelSizeBytes: 17,
    format: 'gguf',
    metadataHash: '3'.repeat(64),
  };
  const localProfile: Snapshot['nativeProfiles'][number] = {
    id: 'local-file-v1',
    family: 'local',
    displayName: 'Local file proposal',
    sdkVersion: '2.1.0',
    model: localBinding.modelKey,
    modelBinding: localBinding,
    billing: 'local',
    contextLength: 8192,
    maximumOutputTokens: 2048,
    qualifiedAt: null,
    maximumTaskMs: 300000,
    maximumFileBytes: 65536,
    maximumSubmissions: 1,
    available: true,
    reason: 'qualification-pending',
  };
  const combinedId = (prefix: string, index = 0) =>
    `${prefix}_${suffix.slice(0, -1)}${['V', 'W', 'X'][index]}`;
  const combinedPlan = {
    taskId: task.id,
    policy: { ...policy, limits: { attempts: 7, minutes: 20, concurrency: 2 } },
    children: [1, 2].map((index) => ({
      taskId: combinedId('tsk', index),
      expectedRevision: index + 6,
      scope: [`slice-${index}.mjs`],
      writer: { profileId: 'openai-file-v1', creditPolicy: 'ordinary' },
      consent: 'explicit',
      maximumMinutes: 2,
    })),
    checks: {
      recipeId: 'project-node-tests-v1',
      testFiles: ['one.test.mjs', 'two.test.mjs', 'interaction.test.mjs'],
      replayTestFiles: [['one.test.mjs'], ['two.test.mjs']],
      interactionTestFiles: ['interaction.test.mjs'],
      maximumMinutes: 1,
      baselineConsent: 'explicit',
      replayConsents: ['explicit', 'explicit'],
    },
    reviewer: { profileId: 'openai-file-v1', creditPolicy: 'ordinary', maximumMinutes: 2 },
  };
  const available = { available: true, reason: 'available' as const };
  const unavailable = { available: false, reason: 'checks-required' as const };
  const combinedPreview: Snapshot['combinedRuns'][number] = {
    taskId: task.id,
    runId: run.id,
    preparationId: artifact.id,
    manifestHash: 'e'.repeat(64),
    revision: 4,
    generation: 0,
    members: [1, 2].map((index) => ({
      taskId: combinedId('tsk', index),
      runId: combinedId('run', index),
      scope: [`slice-${index}.mjs`],
      start: unavailable,
    })) as Snapshot['combinedRuns'][number]['members'],
    phase: 'writers',
    blocker: null,
    dispatches: [
      'baseline',
      'writer-0',
      'writer-1',
      'replay-0',
      'replay-1',
      'final-check',
      'review',
    ].map((phase, index) => ({
      phase,
      maximumMinutes: 1,
      state: index < 3 ? 'passed' : 'reserved',
      attemptId: index < 3 ? combinedId('att', index) : null,
      checkArtifactId: index === 0 ? artifact.id : null,
    })) as Snapshot['combinedRuns'][number]['dispatches'],
    candidate: null,
    remainingBudgets: { attempts: 4, minutes: 17, concurrency: 2 },
    start: unavailable,
    assemble: available,
    evaluate: unavailable,
    review: unavailable,
    accept: unavailable,
  };
  let combinedGroup: typeof combinedPreview | null = combinedPreview;
  let combinedRevision = task.revision;
  let combinedOutcome: 'applied' | 'blocked' | 'outcome-unknown' = 'applied';
  const combinedCommands: Command[] = [];
  const combinedFixture = await serve((message, socket) => {
    if (message.type === 'hello')
      socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: snapshot.cursor }));
    if (message.type !== 'command') return;
    combinedCommands.push(message.command);
    const refs = [0, 1, 2];
    const result =
      message.command.command === 'GetSnapshot'
        ? {
            outcome: 'applied' as const,
            data: {
              kind: 'snapshot' as const,
              snapshot: {
                ...snapshot,
                tasks: refs.map((index) => ({
                  ...task,
                  id: combinedId('tsk', index),
                  revision:
                    index === 0
                      ? combinedRevision
                      : combinedPlan.children[index - 1].expectedRevision,
                  runId: combinedId('run', index),
                })),
                runs: refs.map((index) => ({
                  ...run,
                  id: combinedId('run', index),
                  taskId: combinedId('tsk', index),
                })),
                attempts: refs.map((index) => ({
                  id: combinedId('att', index),
                  runId: combinedId('run', index),
                  routeId: run.roles[0].routeId,
                  generation: 0,
                  state: 'stopped' as const,
                  revision: 1,
                })),
                artifacts: [artifact],
                combinedRuns: combinedGroup ? [combinedGroup] : [],
              },
            },
          }
        : { outcome: combinedOutcome, reason: 'combined-result' };
    socket.write(encodeFrame({ type: 'result', key: message.command.key, result }));
  });
  context.after(() => combinedFixture.close());
  const combinedPlanFile = join(combinedFixture.home, 'combined-plan.json');
  const executeCombined = async (args: string[], json = true) => {
    combinedCommands.length = 0;
    let output = '',
      errors = '';
    const code = await runCli(
      [...args, ...(json ? ['--json'] : []), '--home', combinedFixture.home],
      {
        out: (text) => {
          output += text;
        },
        err: (text) => {
          errors += text;
        },
      },
    );
    return { code, output, errors };
  };
  for (const row of [
    { action: 'prepare', command: 'PrepareCombinedRun', payload: combinedPlan },
    {
      action: 'assemble',
      command: 'AssembleCombinedCandidate',
      payload: { taskId: task.id, runId: run.id, preparationId: artifact.id },
    },
  ]) {
    writeFileSync(combinedPlanFile, JSON.stringify(combinedPlan));
    combinedOutcome = 'outcome-unknown';
    const result = await executeCombined([
      'combined',
      row.action,
      task.id,
      ...(row.action === 'prepare' ? ['--plan', combinedPlanFile] : []),
    ]);
    assert.equal(result.code, 2, result.errors);
    const saved = JSON.parse(result.output);
    assert.deepEqual(
      combinedCommands.map((command) => command.command),
      ['GetSnapshot', row.command],
    );
    assert.equal(saved.command.expectedRevision, combinedRevision);
    assert.deepEqual(saved.command.payload, row.payload);
    const receiptFile = join(combinedFixture.home, `${row.action}-receipt.json`);
    writeFileSync(receiptFile, result.output);
    combinedRevision++;
    combinedOutcome = 'applied';
    const retry = await executeCombined(['retry', receiptFile]);
    assert.equal(retry.code, 0, retry.errors);
    assert.deepEqual(combinedCommands, [saved.command]);
    assert.deepEqual(JSON.parse(retry.output).command, saved.command);
  }
  const combinedStatus = await executeCombined(['combined', 'status', task.id]);
  assert.equal(combinedStatus.code, 0, combinedStatus.errors);
  assert.deepEqual(JSON.parse(combinedStatus.output), {
    cursor: snapshot.cursor,
    combined: combinedPreview,
  });
  assert.deepEqual(
    combinedCommands.map((command) => command.command),
    ['GetSnapshot'],
  );
  const plainCombined = await executeCombined(['combined', 'status', task.id], false);
  for (const fact of ['writers', 'slice-1.mjs', '4 attempts', 'assemble: available'])
    assert(plainCombined.output.includes(fact), fact);
  for (const invalid of [
    { ...combinedPlan, taskId: combinedId('tsk', 1) },
    { ...combinedPlan, children: combinedPlan.children.slice(0, 1) },
    { ...combinedPlan, children: [combinedPlan.children[0], combinedPlan.children[0]] },
    {
      ...combinedPlan,
      policy: { ...combinedPlan.policy, limits: { attempts: 6, minutes: 20, concurrency: 2 } },
    },
    {
      ...combinedPlan,
      children: combinedPlan.children.map((child) => ({
        ...child,
        writer: { ...child.writer, executable: '/caller/process' },
      })),
    },
    { ...combinedPlan, checks: { ...combinedPlan.checks, baselineConsent: 'saved' } },
    { ...combinedPlan, patches: ['caller patch'] },
  ]) {
    writeFileSync(combinedPlanFile, JSON.stringify(invalid));
    assert.equal(
      (await executeCombined(['combined', 'prepare', task.id, '--plan', combinedPlanFile])).code,
      1,
    );
    assert.deepEqual(combinedCommands, []);
  }
  for (const args of [
    ['combined', 'prepare', task.id],
    ['combined', 'status', task.id, '--plan', combinedPlanFile],
    ['combined', 'assemble', task.id, '--consent'],
    ['combined', 'status', task.id, 'extra'],
    ['combined', 'unknown', task.id],
    ['task', 'show', task.id, '--plan', combinedPlanFile],
  ]) {
    assert.equal((await executeCombined(args)).code, 1, args.join(' '));
    assert.deepEqual(combinedCommands, []);
  }
  combinedGroup = { ...combinedPreview, assemble: unavailable };
  assert.equal((await executeCombined(['combined', 'assemble', task.id])).code, 1);
  assert.deepEqual(
    combinedCommands.map((command) => command.command),
    ['GetSnapshot'],
  );
  combinedGroup = null;
  assert.equal(
    JSON.parse((await executeCombined(['combined', 'status', task.id])).output).combined,
    null,
  );

  const localChoice = {
    selectionId: '4'.repeat(64),
    identity: {
      modelKey: localBinding.modelKey,
      displayName: 'Loaded model',
      format: 'gguf',
      sizeBytes: 17,
      quantization: null,
      selectedVariant: null,
      metadataHash: localBinding.metadataHash,
    },
    instanceReference: localBinding.instanceReference,
    contextLength: 8192,
    state: 'loaded-eligible' as const,
    reasons: [],
    qualification: 'unqualified' as const,
  };
  let localSetup: Snapshot['localSetup'] = {
    revision: 7,
    connectionRevision: 2,
    connectorId: 'local-sdk-v1',
    endpoint: 'ws://127.0.0.1:1234',
    setupHash: localBinding.setupHash,
    connectionHash: localBinding.connectionHash,
    secretConfigured: true,
    operation: { kind: 'input', state: 'owned', operationId: `cmd_${suffix}` },
    generation: 'idle',
    observation: {
      version: 1,
      runtime: { connectorId: 'local-sdk-v1', version: 'fixture', build: 1 },
      observationHash: '5'.repeat(64),
      residentLlms: 1,
      embeddingInstances: 0,
      models: [
        localChoice,
        {
          ...localChoice,
          selectionId: '6'.repeat(64),
          identity: {
            ...localChoice.identity,
            modelKey: 'installed-model',
            displayName: 'Installed model',
            metadataHash: '7'.repeat(64),
          },
          instanceReference: null,
          contextLength: null,
          state: 'installed-unloaded',
        },
        {
          ...localChoice,
          selectionId: '8'.repeat(64),
          identity: {
            ...localChoice.identity,
            modelKey: 'unsupported-model',
            displayName: 'Unsupported model',
            format: 'unknown-format',
            metadataHash: '9'.repeat(64),
          },
          instanceReference: null,
          contextLength: null,
          state: 'incompatible',
          reasons: ['unsupported-format'],
        },
      ],
    },
    selection: { selectionId: localChoice.selectionId, observationHash: '5'.repeat(64) },
    reason: 'qualification-pending',
  };
  let localNativeRun: Snapshot['nativeRuns'][number] = {
    ...nativeRun,
    profileId: localProfile.id,
    localModel: localBinding,
  };
  let localOutcome: 'applied' | 'outcome-unknown' | 'blocked' = 'applied';
  const localCommands: Command[] = [];
  const localFixture = await serve((message, socket) => {
    if (message.type === 'hello') {
      socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: snapshot.cursor }));
      return;
    }
    if (message.type !== 'command') return;
    localCommands.push(message.command);
    const result =
      message.command.command === 'GetSnapshot'
        ? {
            outcome: 'applied' as const,
            data: {
              kind: 'snapshot' as const,
              snapshot: {
                ...snapshot,
                localSetup,
                tasks: [{ ...task, runId: run.id }],
                runs: [run],
                nativeProfiles: [localProfile],
                nativeRuns: [localNativeRun],
              },
            },
          }
        : {
            outcome: localOutcome,
            reason: 'local-result\u001b[31m\rretained',
            next: 'Read Local status.',
          };
    socket.write(encodeFrame({ type: 'result', key: message.command.key, result }));
  });
  context.after(() => localFixture.close());
  const localPolicyFile = join(localFixture.home, 'policy.json');
  writeFileSync(localPolicyFile, JSON.stringify(policy));
  const executeLocal = async (args: string[], json = true) => {
    localCommands.length = 0;
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../../apps/cli/src/main.ts', import.meta.url)),
        ...args,
        ...(json ? ['--json'] : []),
        '--home',
        localFixture.home,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      errors = '';
    child.stdout.on('data', (bytes) => {
      output += bytes;
    });
    child.stderr.on('data', (bytes) => {
      errors += bytes;
    });
    const [code] = await once(child, 'close');
    return { code, output, errors };
  };
  for (const row of [
    {
      args: ['local', 'configure', '--endpoint', 'ws://127.0.0.1:1234'],
      command: 'ConfigureLocal',
      payload: { endpoint: 'ws://127.0.0.1:1234' },
    },
    {
      args: ['local', 'connect', '--consent'],
      command: 'BeginLocalConnectionInput',
      payload: { consent: 'explicit' },
    },
    {
      args: ['local', 'cancel-input', `cmd_${suffix}`],
      command: 'CancelLocalConnectionInput',
      payload: { operationId: `cmd_${suffix}` },
    },
    {
      args: ['local', 'refresh-models', '--consent'],
      command: 'RefreshLocalModels',
      payload: { consent: 'explicit' },
    },
    {
      args: [
        'local',
        'select-model',
        localChoice.selectionId,
        '--observation-hash',
        '5'.repeat(64),
      ],
      command: 'SelectLocalModel',
      payload: { selectionId: localChoice.selectionId, observationHash: '5'.repeat(64) },
    },
    {
      args: ['local', 'select-model', '6'.repeat(64), '--observation-hash', '5'.repeat(64)],
      command: 'SelectLocalModel',
      payload: { selectionId: '6'.repeat(64), observationHash: '5'.repeat(64) },
    },
    { args: ['local', 'disconnect'], command: 'DisconnectLocal', payload: {} },
  ]) {
    const result = await executeLocal(row.args);
    assert.equal(result.code, 0, result.errors);
    const receipt = JSON.parse(result.output);
    assert.deepEqual(
      localCommands.map((command) => command.command),
      ['GetSnapshot', row.command],
    );
    assert.equal(receipt.command.expectedRevision, 7);
    assert.deepEqual(receipt.command.payload, row.payload);
    assert.deepEqual(receipt.command, localCommands.at(-1));
  }
  const localStatus = await executeLocal(['local', 'status']);
  assert.equal(localStatus.code, 0, localStatus.errors);
  assert.deepEqual(JSON.parse(localStatus.output), {
    cursor: snapshot.cursor,
    setup: localSetup,
    profile: localProfile,
  });
  assert.deepEqual(
    localCommands.map((command) => command.command),
    ['GetSnapshot'],
  );
  const plainLocalStatus = await executeLocal(['local', 'status'], false);
  for (const fact of [
    'installed-unloaded',
    'loaded-eligible',
    'incompatible',
    'unqualified',
    '5'.repeat(64),
  ])
    assert(plainLocalStatus.output.includes(fact));
  for (const args of [
    ['local', 'connect'],
    ['local', 'refresh-models'],
    ['local', 'cancel-input'],
    ['local', 'configure', '--endpoint', 'ws://localhost:1234'],
    ['local', 'configure', '--setup-receipt', 'unused.json'],
    ['local', 'connect', '--consent', '--token', 'synthetic-local-secret'],
    ['local', 'connect', '--consent', '--helper-path', '/synthetic/helper'],
    ['local', 'select-model', '/synthetic/model', '--observation-hash', '5'.repeat(64)],
    ['local', 'disconnect', '--consent'],
  ]) {
    const result = await executeLocal(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.deepEqual(localCommands, []);
  }
  for (const args of [
    ['local', 'select-model', localChoice.selectionId, '--observation-hash', 'f'.repeat(64)],
    ['local', 'select-model', 'f'.repeat(64), '--observation-hash', '5'.repeat(64)],
    ['local', 'cancel-input', 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW'],
  ]) {
    assert.equal((await executeLocal(args)).code, 1);
    assert.deepEqual(
      localCommands.map((command) => command.command),
      ['GetSnapshot'],
    );
  }
  const configuredLocal = localSetup;
  localSetup = {
    ...configuredLocal,
    operation: { kind: 'discovery', state: 'owned', operationId: `cmd_${suffix}` },
  };
  assert.equal((await executeLocal(['local', 'cancel-input', `cmd_${suffix}`])).code, 1);
  assert.deepEqual(
    localCommands.map((command) => command.command),
    ['GetSnapshot'],
  );
  localSetup = configuredLocal;
  localOutcome = 'outcome-unknown';
  const uncertainLocal = await executeLocal(['local', 'disconnect']);
  assert.equal(uncertainLocal.code, 2);
  const localReceipt = JSON.parse(uncertainLocal.output);
  const localReceiptFile = join(localFixture.home, 'local-receipt.json');
  writeFileSync(localReceiptFile, uncertainLocal.output);
  localSetup = { ...configuredLocal, revision: 8 };
  localOutcome = 'applied';
  const localRetry = await executeLocal(['retry', localReceiptFile]);
  assert.equal(localRetry.code, 0, localRetry.errors);
  assert.deepEqual(localCommands, [localReceipt.command]);
  assert.deepEqual(JSON.parse(localRetry.output).command, localReceipt.command);
  localOutcome = 'blocked';
  const plainLocalRefusal = await executeLocal(['local', 'disconnect'], false);
  assert.equal(plainLocalRefusal.code, 2);
  assert(plainLocalRefusal.output.includes('Next: Read Local status.'));
  assert(!plainLocalRefusal.output.includes('\u001b') && !plainLocalRefusal.output.includes('\r'));
  assert(
    plainLocalRefusal.output.includes('\\u001b') && plainLocalRefusal.output.includes('\\u000d'),
  );
  localOutcome = 'applied';
  for (const consent of ['explicit', 'saved']) {
    const result = await executeLocal([
      'task',
      'prepare-native',
      task.id,
      localProfile.id,
      'net.mjs',
      '--policy',
      localPolicyFile,
      ...(consent === 'explicit' ? ['--native-trust', '--source-consent'] : []),
    ]);
    assert.equal(result.code, 0, result.errors);
    const command = JSON.parse(result.output).command;
    assert.deepEqual(command.payload, {
      taskId: task.id,
      profileId: localProfile.id,
      targetPath: 'net.mjs',
      policy,
      consent,
    });
    assert.equal(command.expectedRevision, task.revision);
    assert.deepEqual(
      localCommands.map((value) => value.command),
      ['GetSnapshot', 'PrepareNativeRun'],
    );
  }
  for (const flags of [
    ['--existing-credits'],
    ['--confirm-subscription-only'],
    ['--permission-mode', 'strict'],
    ['--model-id', 'override'],
    ['--thought-level-id', 'override'],
    ['--confirm-quota-account'],
    ['--handoff-target', 'anthropic-file-v1'],
  ]) {
    const result = await executeLocal([
      'task',
      'prepare-native',
      task.id,
      localProfile.id,
      'net.mjs',
      '--policy',
      localPolicyFile,
      '--native-trust',
      '--source-consent',
      ...flags,
    ]);
    assert.equal(result.code, 1, flags.join(' '));
    assert.deepEqual(
      localCommands.map((value) => value.command),
      ['GetSnapshot'],
    );
  }
  const genericLocalShow = await executeLocal(['task', 'show', task.id], false);
  assert(genericLocalShow.output.includes('Identity runtime metadata'));
  assert(genericLocalShow.output.includes(localBinding.metadataHash));
  localNativeRun = {
    ...localNativeRun,
    localModel: {
      setupHash: localBinding.setupHash,
      modelKey: 'historical-model',
      instanceReference: 'historical-instance',
      modelSizeBytes: 17,
      artifactSha256: 'd'.repeat(64),
      quantization: 'Q4_K_M',
    },
  };
  const historicalLocalShow = await executeLocal(['task', 'show', task.id], false);
  assert(historicalLocalShow.output.includes('Identity retained artifact'));
  assert(historicalLocalShow.output.includes('d'.repeat(64)));
  localSetup = undefined;
  const historicalLocalStatus = await executeLocal(['local', 'status']);
  assert.equal(historicalLocalStatus.code, 0);
  assert.equal(JSON.parse(historicalLocalStatus.output).setup, null);
  assert.equal((await executeLocal(['local', 'disconnect'])).code, 1);
  assert.deepEqual(
    localCommands.map((value) => value.command),
    ['GetSnapshot'],
  );

  for (const scenario of [
    ...acpCases.map((value) => `acp-${value}`),
    ...usageCases.map((value) => `usage-${value.name}`),
    ...creationCases.map((value) => `setup-${value.name}`),
    'show',
    'pending-show',
    'pending-watch',
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
    const acp = scenario.startsWith('acp-');
    const selectedAcpProfile =
      scenario === 'acp-model-only'
        ? {
            ...acpProfile,
            effort: 'unknown',
            effortSupported: [],
            configOptions: {
              ...acpProfile.configOptions,
              model: {
                optionId: 'model',
                currentValue: 'observed-model',
                supported: ['observed-model', 'other-model'],
              },
              thoughtLevel: null,
            },
          }
        : acpProfile;
    const setupState = {
      ...acpSetup,
      ...(scenario === 'acp-initialize'
        ? {
            revision: 0,
            state: 'uninitialized' as const,
            proofId: null,
            client: null,
            auth: { method: null, status: 'unknown' as const },
          }
        : {}),
      ...(scenario === 'acp-stop'
        ? { state: 'authenticating' as const, operationId: `cmd_${suffix}` }
        : {}),
      ...(scenario === 'acp-missing-proof'
        ? { proofId: null, state: 'uninitialized' as const }
        : {}),
    };
    const acpApproval = {
      ...approval,
      action: 'write-scratch' as const,
      acpTarget: {
        sessionId: 'session',
        toolCallId: 'tool',
        optionId: 'once',
        kind: 'allow_once' as const,
      },
    };
    const creationCase = creationCases.find((value) => scenario === `setup-${value.name}`);
    const usageCase = usageCases.find((value) => scenario === `usage-${value.name}`);
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
              ...(acp ? { googleAcpSetup: setupState } : {}),
              ...(usageCase ? { usageReaders: [usageReader], usage: usageWindows } : {}),
              projects: scenario.startsWith('repository-')
                ? [{ id: task.projectId, name: 'fixture-project', revision: 0 }]
                : snapshot.projects,
              tasks:
                scenario === 'acp-saved'
                  ? [{ ...task, runId: nativeRun.runId }]
                  : pendingCommand
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
                scenario === 'acp-saved' ||
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
                scenario === 'acp-saved'
                  ? [
                      {
                        ...nativeRun,
                        profileId: 'google-acp-v1',
                        permissionMode: 'request-review',
                        billingAttestation: {
                          source: 'user-attested',
                          subscriptionLoginConfirmed: true,
                          paidExtraUsageDisabled: true,
                          quotaAccountConfirmed: true,
                        },
                        acp: {
                          proofId: artifact.id,
                          modelId: 'observed-model',
                          thoughtLevelId: 'thought-low',
                        },
                      },
                    ]
                  : scenario === 'native-show' ||
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
              approvals:
                scenario === 'acp-approval'
                  ? [acpApproval]
                  : scenario.startsWith('pending-')
                    ? [
                        approval,
                        {
                          ...approval,
                          approvalId: 'apr_01ARZ3NDEKTSV4RRFFQ69G5FAW',
                          status: 'denied',
                        },
                      ]
                    : approvals,
              nativeProfiles: [
                ...(acp ? [selectedAcpProfile] : []),
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
      if (command.command === 'ObserveUsage')
        result = usageCase?.reason
          ? {
              outcome: 'blocked',
              reason: usageCase.reason,
              next: 'Inspect reader status and retry after 2026-10-17T10:01:00.000Z.',
            }
          : {
              outcome: 'applied',
              data: { kind: 'usage', windows: usageCase?.consent === false ? [] : usageWindows },
            };
      if (
        [
          'InitializeGoogleAcp',
          'AuthenticateGoogleAcp',
          'DiscoverGoogleAcp',
          'StopGoogleAcpSetup',
        ].includes(command.command)
      )
        result = { outcome: 'applied', data: { kind: 'google-acp-setup', setup: setupState } };
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
      if (command.command === 'RegisterProject')
        result = {
          outcome: scenario === 'setup-project-existing' ? 'already-applied' : 'applied',
          entity: project,
          revision: 0,
        };
      if (command.command === 'CreateTask')
        result =
          scenario === 'setup-task-blocked'
            ? { outcome: 'blocked', reason: 'project-not-found' }
            : scenario === 'setup-task-uncertain' && received.length === 1
              ? { outcome: 'outcome-unknown', reason: 'connection-lost' }
              : { outcome: 'applied', entity: createdTask, revision: 0 };
      socket.write(encodeFrame({ type: 'result', key: command.key, result }));
      if (scenario === 'pending-watch' && command.command === 'Subscribe')
        socket.write(
          encodeFrame({
            type: 'event',
            event: {
              protocol: 1,
              id: `evt_${suffix}`,
              cursor: '5',
              at: '2026-10-17T10:00:00.000Z',
              taskId: task.id,
              revision: task.revision,
              type: 'approval.requested',
              payload: approval,
            },
          }),
        );
    });
    context.after(() => fixture.close());
    const policyFile = join(fixture.home, 'policy.json'),
      destination = join(fixture.home, 'saved.patch');
    writeFileSync(
      policyFile,
      JSON.stringify(
        scenario === 'acp-autopilot'
          ? { ...policy, authority: 'autopilot' }
          : scenario.startsWith('repository-')
            ? repositoryPolicy
            : policy,
      ),
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
        if (
          scenario === 'pending-watch' &&
          (output.includes('"cursor":"5"') || output.includes('5 approval.requested'))
        )
          child.kill('SIGTERM');
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
    if (scenario.startsWith('pending-'))
      args = ['task', scenario === 'pending-watch' ? 'watch' : 'show', task.id];
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
    if (acp) {
      const setupActions = ['show', 'initialize', 'authenticate', 'discover', 'stop'];
      const name = scenario.slice(4);
      if (name === 'import-consent-missing') args = ['native', 'import-google'];
      else if (
        setupActions.includes(name) ||
        ['missing-consent', 'missing-proof', 'missing-operation', 'wrong-family'].includes(name)
      ) {
        const action = setupActions.includes(name)
          ? name
          : name === 'missing-operation'
            ? 'stop'
            : name === 'missing-proof'
              ? 'authenticate'
              : 'initialize';
        args = [
          'native',
          'setup',
          action,
          '--family',
          name === 'wrong-family' ? 'openai' : 'google',
          ...(['show', 'stop'].includes(action) || name === 'missing-consent' ? [] : ['--consent']),
        ];
      } else if (name === 'approval') args = ['task', 'approve', approval.approvalId];
      else
        args = [
          'task',
          'prepare-native',
          task.id,
          acpProfile.id,
          'net.mjs',
          '--policy',
          policyFile,
          ...(name === 'saved'
            ? []
            : [
                '--native-trust',
                '--source-consent',
                '--confirm-subscription-only',
                ...(name === 'account' ? [] : ['--confirm-quota-account']),
                '--model-id',
                name === 'model' ? 'invented' : 'observed-model',
                ...(name === 'model-only'
                  ? []
                  : ['--thought-level-id', name === 'thought' ? 'invented' : 'thought-low']),
              ]),
          ...(name === 'credits' ? ['--existing-credits'] : []),
          ...(name === 'mode' ? ['--permission-mode', 'always-proceed'] : []),
          ...(name === 'handoff' ? ['--handoff-target', profile.id] : []),
        ];
    }
    if (creationCase) args = creationCase.args;
    if (usageCase) args = usageCase.args;
    const result = await execute(args, scenario !== 'changes' && !creationCase?.plain);
    if (acp) {
      const invalid = [
        'missing-consent',
        'missing-proof',
        'missing-operation',
        'wrong-family',
        'model',
        'thought',
        'account',
        'credits',
        'mode',
        'handoff',
        'autopilot',
        'import-consent-missing',
      ].some((name) => scenario === `acp-${name}`);
      assert.equal(result.code, invalid ? 1 : 0, result.errors);
      if (invalid) {
        assert(received.every((value) => value.command === 'GetSnapshot'));
        continue;
      }
      const data = JSON.parse(result.output);
      if (scenario === 'acp-show') {
        assert.equal(data.setup.revision, 7);
        assert.deepEqual(data.profile, acpProfile);
      } else if (scenario === 'acp-approval')
        assert.deepEqual(data.command.payload.binding.acpTarget, acpApproval.acpTarget);
      else if (
        scenario === 'acp-prepare' ||
        scenario === 'acp-saved' ||
        scenario === 'acp-model-only'
      ) {
        assert.equal(data.command.command, 'PrepareNativeRun');
        assert.deepEqual(
          {
            proofId: data.command.payload.proofId,
            modelId: data.command.payload.modelId,
            thoughtLevelId: data.command.payload.thoughtLevelId,
          },
          {
            proofId: artifact.id,
            modelId: 'observed-model',
            thoughtLevelId: scenario === 'acp-model-only' ? null : 'thought-low',
          },
        );
        assert.equal(data.command.payload.billingAttestation.quotaAccountConfirmed, true);
        assert.equal(data.command.payload.permissionMode, 'request-review');
        assert.equal(data.command.payload.creditPolicy, 'ordinary');
        assert.equal(data.command.payload.consent, scenario === 'acp-saved' ? 'saved' : 'explicit');
      } else {
        assert.equal(data.command.expectedRevision, scenario === 'acp-initialize' ? 0 : 7);
        assert.equal(data.command.payload.profileId, 'google-acp-v1');
        if (scenario === 'acp-stop')
          assert.equal(data.command.payload.operationId, `cmd_${suffix}`);
        else assert.equal(data.command.payload.consent, 'explicit');
        if (scenario === 'acp-authenticate')
          assert.equal(data.command.payload.method, 'oauth-personal');
        if (['acp-authenticate', 'acp-discover'].includes(scenario))
          assert.equal(data.command.payload.proofId, artifact.id);
      }
      continue;
    }
    if (usageCase) {
      if (usageCase.invalid) {
        assert.equal(result.code, 1, scenario);
        assert(result.errors.length > 0, scenario);
        assert.deepEqual(received, [], scenario);
      } else if (usageCase.name === 'show') {
        assert.equal(result.code, 0, result.errors);
        assert.deepEqual(JSON.parse(result.output), {
          cursor: snapshot.cursor,
          usageReaders: [usageReader],
          usage: usageWindows,
        });
        assert.deepEqual(
          received.map((value) => value.command),
          ['GetSnapshot'],
        );
        const plain = await execute(usageCase.args, false);
        assert.match(
          plain.output,
          /42.25 percent remaining.*stale.*source client.*observed 2026-10-17T10:00:00.000Z/u,
        );
        assert.match(plain.output, /last attempt 2026-10-17T10:00:00.000Z/u);
      } else {
        assert.equal(result.code, usageCase.reason ? 2 : 0, result.errors);
        assert.deepEqual(
          received.map((value) => value.command),
          ['ObserveUsage'],
        );
        const receipt = JSON.parse(result.output);
        assert.deepEqual(receipt.command, received[0]);
        assert.equal(receipt.command.expectedRevision, 0);
        assert.deepEqual(receipt.command.payload, {
          family: 'google',
          ...(usageCase.consent === undefined ? {} : { consent: usageCase.consent }),
        });
        if (usageCase.reason) {
          assert.equal(receipt.result.reason, usageCase.reason);
          const plain = await execute(usageCase.args, false);
          assert.match(plain.output, new RegExp(usageCase.reason, 'u'));
          assert.match(plain.output, /retry after 2026-10-17T10:01:00.000Z/u);
        } else
          assert.deepEqual(receipt.result.data, {
            kind: 'usage',
            windows: usageCase.consent === false ? [] : usageWindows,
          });
      }
      continue;
    }
    if (creationCase) {
      if (creationCase.invalid) {
        assert.equal(result.code, 1, scenario);
        assert(result.errors.length > 0, scenario);
        assert.deepEqual(received, [], scenario);
        continue;
      }
      const registering = creationCase.name.startsWith('project');
      assert.equal(
        result.code,
        ['task-blocked', 'task-uncertain'].includes(creationCase.name) ? 2 : 0,
        scenario,
      );
      assert.equal(received.length, 1, scenario);
      const command = received[0];
      assert.equal(command.command, registering ? 'RegisterProject' : 'CreateTask');
      assert.equal(command.expectedRevision, 0);
      assert.deepEqual(command.actor, actor);
      assert.deepEqual(
        command.payload,
        registering
          ? { path: resolve(creationCase.args[2]) }
          : {
              projectId: project.id,
              title: task.title,
              outcome: task.outcome,
              criteria: [...task.criteria, 'The original source stays unchanged'],
            },
      );
      if (creationCase.plain) {
        assert(
          result.output.includes(
            `${registering ? 'Project' : 'Task'} ${registering ? project.id : createdTask.id}`,
          ),
        );
        assert(result.output.includes(`Command key ${command.key}`));
      } else {
        const receipt = JSON.parse(result.output);
        assert.deepEqual(receipt.command, command);
        if (creationCase.name === 'task-blocked')
          assert.equal(receipt.result.reason, 'project-not-found');
        else if (creationCase.name === 'task-uncertain') {
          assert.equal(receipt.result.outcome, 'outcome-unknown');
          const file = join(fixture.home, 'creation-receipt.json');
          writeFileSync(file, result.output);
          const retried = await execute(['retry', file]);
          assert.equal(retried.code, 0);
          assert.deepEqual(received, [command, command]);
          assert.deepEqual(JSON.parse(retried.output).result.entity, createdTask);
        } else assert.deepEqual(receipt.result.entity, registering ? project : createdTask);
      }
      continue;
    }
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
    if (scenario.startsWith('pending-')) {
      assert.equal(result.code, 0, result.errors);
      const rows = result.output
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row));
      assert.deepEqual(rows[0].approvals, [approval]);
      assert.equal(rows[0].task.next, task.next);
      if (scenario === 'pending-watch') assert.deepEqual(rows[1].payload, approval);
      const plain = await execute(args, false);
      assert.equal(plain.code, 0, plain.errors);
      for (const value of [
        approval.approvalId,
        approval.action,
        approval.target,
        approval.consequence,
        task.next,
      ])
        assert(plain.output.includes(value), value);
      continue;
    }
    if (scenario === 'show') {
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.output), { cursor: snapshot.cursor, task, approvals: [] });
      continue;
    }
    if (scenario === 'native-show') {
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.output), {
        cursor: snapshot.cursor,
        task: { ...task, runId: nativeRun.runId },
        approvals: [],
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
