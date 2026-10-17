import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashCanonical, sealHandoff } from './hash.ts';
import {
  AcpApprovalTargetSchema,
  ApprovalBindingSchema,
  AttemptOutputSchema,
  CandidateEvaluationPreviewSchema,
  CheckEventSchema,
  CheckResultSchema,
  CommandResultSchema,
  CommandSchema,
  CursorSchema,
  canonicalJson,
  DesktopNoticeSchema,
  FakeWorkerEventSchema,
  FakeWorkerInputSchema,
  formatReviewTarget,
  GoogleAcpSetupSchema,
  GrantSchema,
  MinorAmountSchema,
  NativeBillingAttestationSchema,
  NativeHandoffPreviewSchema,
  NativeHandoffTargetsSchema,
  NativeProfileSchema,
  NativeRunSchema,
  ObservationSchema,
  PolicySchema,
  parseReviewTarget,
  ReadDataSchema,
  RemainingBudgetsSchema,
  ReviewJobSchema,
  RoleSchema,
  RouteSchema,
  RuntimeManifestSchema,
  requiredReviewMethodIds,
  SnapshotSchema,
  SourceDetailsSchema,
  SourceSchema,
  TransportMessageSchema,
  UsageReaderSchema,
} from './index.ts';

const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const command = {
  protocol: 1,
  key: `cmd_${suffix}`,
  actor: { id: 'terminal', kind: 'cli' },
  expectedRevision: 0,
  command: 'StartRun',
  payload: { taskId: `tsk_${suffix}`, runId: `run_${suffix}` },
};

test('process boundaries reject unknown fields and invalid command identity', () => {
  const attestation = {
    source: 'user-attested',
    subscriptionLoginConfirmed: true,
    paidExtraUsageDisabled: true,
  };
  assert(NativeBillingAttestationSchema.safeParse(attestation).success);
  for (const invalid of [
    { ...attestation, source: 'provider-observed' },
    { ...attestation, subscriptionLoginConfirmed: false },
    { ...attestation, paidExtraUsageDisabled: false },
    { ...attestation, plan: 'personal-plan' },
  ])
    assert.equal(NativeBillingAttestationSchema.safeParse(invalid).success, false);

  const historicalProfile = {
    id: 'openai-file-v1',
    family: 'openai',
    displayName: 'OpenAI fixture',
    clientVersion: 'fixture',
    model: 'fixture',
    effort: 'low',
    accountClass: 'pro',
    serviceTier: 'default',
    qualifiedAt: '2026-10-16',
    creditPolicies: ['ordinary', 'existing-credits'],
    maximumTaskMs: 300000,
    maximumFileBytes: 65536,
    maximumSubmissions: 1,
    available: true,
    reason: 'available',
  };
  assert.deepEqual(NativeProfileSchema.parse(historicalProfile), historicalProfile);
  assert.equal(
    hashCanonical(NativeProfileSchema.parse(historicalProfile)),
    hashCanonical(historicalProfile),
  );
  const execution = {
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    networkAccess: false,
  };
  const { maximumFileBytes: _fileLimit, ...repositoryFields } = historicalProfile;
  const repositoryProfile = {
    ...repositoryFields,
    id: 'openai-repository-v1',
    qualifiedAt: null,
    reason: 'qualification-pending',
    maximumSourceFiles: 10000,
    maximumSourceBytes: 67108864,
    execution,
  };
  assert.deepEqual(NativeProfileSchema.parse(repositoryProfile), repositoryProfile);
  for (const change of [
    { maximumFileBytes: 65536 },
    { maximumSourceFiles: 2 },
    { maximumSourceBytes: 67108865 },
    { execution: { ...execution, sandbox: 'danger-full-access' } },
    { execution: { ...execution, approvalPolicy: 'on-request' } },
    { execution: { ...execution, networkAccess: true } },
  ])
    assert.equal(NativeProfileSchema.safeParse({ ...repositoryProfile, ...change }).success, false);
  const pendingProfile = {
    ...historicalProfile,
    id: 'anthropic-file-v1',
    family: 'anthropic',
    effort: 'medium',
    effectiveEffort: 'unknown',
    accountClass: 'unknown',
    serviceTier: 'unknown',
    qualifiedAt: null,
    creditPolicies: ['ordinary'],
    billingBasis: 'requires-user-attestation',
    reason: 'qualification-pending',
  };
  assert.deepEqual(NativeProfileSchema.parse(pendingProfile), pendingProfile);
  for (const change of [
    { effectiveEffort: 'medium' },
    { accountClass: 'pro' },
    { creditPolicies: ['existing-credits'] },
    { billingBasis: 'provider-observed' },
  ])
    assert.equal(NativeProfileSchema.safeParse({ ...pendingProfile, ...change }).success, false);
  const googleProfile = {
    ...pendingProfile,
    id: 'google-file-v1',
    family: 'google',
    effort: 'low',
    permissionModes: ['request-review', 'strict', 'always-proceed', 'proceed-in-sandbox'],
  };
  assert.deepEqual(NativeProfileSchema.parse(googleProfile), googleProfile);
  const selection = {
    proofId: `art_${suffix}`,
    modelId: 'model-selected',
    thoughtLevelId: 'thought-selected',
  };
  const acpProfile = {
    ...googleProfile,
    id: 'google-acp-v1',
    model: selection.modelId,
    effort: selection.thoughtLevelId,
    effortSupported: [selection.thoughtLevelId],
    permissionModes: ['request-review'],
    configOptions: {
      model: {
        optionId: 'model-option',
        currentValue: selection.modelId,
        supported: [selection.modelId],
      },
      thoughtLevel: {
        optionId: 'thought-option',
        currentValue: selection.thoughtLevelId,
        supported: [selection.thoughtLevelId],
      },
    },
    capabilities: {
      protocolVersion: 1,
      authMethods: ['oauth-personal'],
      sessionClose: false,
      fs: false,
      terminal: false,
    },
  };
  assert.deepEqual(NativeProfileSchema.parse(acpProfile), acpProfile);
  const modelOnly = {
    ...acpProfile,
    effort: 'unknown',
    effortSupported: [],
    configOptions: { ...acpProfile.configOptions, thoughtLevel: null },
  };
  assert.deepEqual(NativeProfileSchema.parse(modelOnly), modelOnly);
  assert(
    NativeProfileSchema.safeParse({
      ...modelOnly,
      available: false,
      reason: 'authentication-required',
    }).success,
  );
  for (const change of [
    { model: 'unobserved' },
    { effort: 'standard' },
    { effortSupported: ['unobserved'] },
    { configOptions: null },
    { capabilities: null },
    { capabilities: { ...acpProfile.capabilities, protocolVersion: 2 } },
    { capabilities: { ...acpProfile.capabilities, authMethods: ['api-key'] } },
    { capabilities: { ...acpProfile.capabilities, fs: true } },
    { capabilities: { ...acpProfile.capabilities, terminal: true } },
    { permissionModes: ['always-proceed'] },
    { reason: 'unbounded-native-error' },
    { family: 'openai' },
    { accountClass: 'pro' },
    { credential: 'synthetic-secret' },
    {
      configOptions: {
        ...acpProfile.configOptions,
        model: {
          ...acpProfile.configOptions.model,
          supported: [selection.modelId, selection.modelId],
        },
      },
    },
  ])
    assert.equal(NativeProfileSchema.safeParse({ ...acpProfile, ...change }).success, false);
  assert.equal(NativeProfileSchema.safeParse({ ...modelOnly, effort: 'standard' }).success, false);
  const profiles = [
    historicalProfile,
    pendingProfile,
    googleProfile,
    repositoryProfile,
    acpProfile,
  ];
  assert.deepEqual(SnapshotSchema.shape.nativeProfiles.parse(profiles), profiles);
  assert.equal(
    SnapshotSchema.shape.nativeProfiles.safeParse([
      ...profiles,
      { ...historicalProfile, id: 'extra-profile' },
    ]).success,
    false,
  );
  for (const change of [
    { permissionModes: ['request-review'] },
    { permissionModes: ['unknown', 'strict', 'always-proceed', 'proceed-in-sandbox'] },
    { accountClass: 'pro' },
    { creditPolicies: ['existing-credits'] },
  ])
    assert.equal(NativeProfileSchema.safeParse({ ...googleProfile, ...change }).success, false);
  const reader = {
    id: 'google-usage-v1',
    family: 'google',
    clientVersion: 'fixture',
    available: false,
    enabled: false,
    reason: 'not-enabled',
    lastObservedAt: null,
  };
  for (const valid of [
    reader,
    { ...reader, enabled: true, available: true, reason: 'available' },
    {
      ...reader,
      enabled: true,
      reason: 'client-build-mismatch',
      lastAttemptAt: '2026-10-17T00:00:00.000Z',
    },
    { ...reader, reason: 'unsupported-platform' },
  ])
    assert.deepEqual(UsageReaderSchema.parse(valid), valid);
  for (const change of [
    { available: true },
    { reason: 'available' },
    { enabled: true },
    { family: 'anthropic' },
    { reason: 'unbounded-error' },
    { lastAttemptAt: 'tomorrow' },
    { lastObservedAt: 'tomorrow' },
    { token: 'synthetic-secret' },
  ])
    assert.equal(UsageReaderSchema.safeParse({ ...reader, ...change }).success, false);
  const oldSnapshot = {
    protocol: 1,
    cursor: '0',
    projects: [],
    tasks: [],
    runs: [],
    attempts: [],
    routes: [],
    artifacts: [],
    evidence: [],
    approvals: [],
    usage: [],
    candidates: [],
  };
  assert.deepEqual(SnapshotSchema.parse(oldSnapshot), {
    ...oldSnapshot,
    nativeProfiles: [],
    nativeRuns: [],
    candidateEvaluations: [],
    usageReaders: [],
    googleAcpSetup: null,
  });
  assert.equal(
    SnapshotSchema.safeParse({ ...oldSnapshot, usageReaders: [reader, reader] }).success,
    false,
  );
  for (const consent of [undefined, true, false]) {
    const observe = {
      ...command,
      command: 'ObserveUsage',
      payload: { family: 'google', ...(consent === undefined ? {} : { consent }) },
    };
    assert.deepEqual(CommandSchema.parse(observe), observe);
  }
  for (const payload of [
    { family: 'google', consent: 'true' },
    { family: 'google', consent: null },
    { family: 'openai', consent: true },
    { family: 'google', token: 'synthetic-secret' },
  ])
    assert.equal(
      CommandSchema.safeParse({ ...command, command: 'ObserveUsage', payload }).success,
      false,
    );
  const setup = {
    profileId: 'google-acp-v1',
    revision: 1,
    state: 'ready',
    operationId: null,
    proofId: selection.proofId,
    client: { version: 'fixture', sha256: 'a'.repeat(64), signerTeamId: 'TEAM-FIXTURE' },
    auth: { method: 'oauth-personal', status: 'authenticated' },
    reason: 'qualification-pending',
  };
  assert.deepEqual(GoogleAcpSetupSchema.parse(setup), setup);
  assert(ReadDataSchema.safeParse({ kind: 'google-acp-setup', setup }).success);
  for (const change of [
    { proofId: null },
    { client: null },
    { operationId: command.key },
    { auth: { method: null, status: 'authenticated' } },
    { auth: { method: 'api-key', status: 'authenticated' } },
    { state: 'initializing', operationId: null },
    { oauthUrl: 'https://invalid.example/' },
    { token: 'synthetic-secret' },
  ])
    assert.equal(GoogleAcpSetupSchema.safeParse({ ...setup, ...change }).success, false);
  for (const [name, payload] of [
    ['InitializeGoogleAcp', { profileId: setup.profileId, consent: 'explicit' }],
    [
      'AuthenticateGoogleAcp',
      {
        profileId: setup.profileId,
        proofId: setup.proofId,
        method: 'oauth-personal',
        consent: 'explicit',
      },
    ],
    [
      'DiscoverGoogleAcp',
      { profileId: setup.profileId, proofId: setup.proofId, consent: 'explicit' },
    ],
    ['StopGoogleAcpSetup', { profileId: setup.profileId, operationId: command.key }],
  ] as const) {
    const request = { ...command, command: name, payload };
    assert.deepEqual(CommandSchema.parse(request), request);
    for (const extra of [
      { token: 'synthetic-secret' },
      { url: 'https://invalid.example/' },
      { profileId: 'google-file-v1' },
    ])
      assert.equal(
        CommandSchema.safeParse({ ...request, payload: { ...payload, ...extra } }).success,
        false,
      );
  }
  const permission = {
    sessionId: 'session-fixture',
    toolCallId: 'tool-fixture',
    optionId: 'option-fixture',
    kind: 'allow_once',
  };
  const binding = {
    approvalId: `apr_${suffix}`,
    taskId: `tsk_${suffix}`,
    attemptId: `att_${suffix}`,
    generation: 1,
    action: 'run-native-tools',
    target: 'Edit the selected scratch file.',
    revision: 2,
  };
  assert.deepEqual(ApprovalBindingSchema.parse(binding), binding);
  assert.deepEqual(ApprovalBindingSchema.parse({ ...binding, acpTarget: permission }), {
    ...binding,
    acpTarget: permission,
  });
  for (const change of [
    { kind: 'allow_always' },
    { kind: 'reject_once' },
    { toolCallId: '' },
    { sessionId: 'x'.repeat(201) },
    { optionId: 'line\noption' },
    { rpcRequestId: 1 },
    { token: 'synthetic-secret' },
  ])
    assert.equal(AcpApprovalTargetSchema.safeParse({ ...permission, ...change }).success, false);
  const output = {
    attemptId: binding.attemptId,
    generation: 1,
    channel: 'stdout',
    text: '<script>inert</script>',
  };
  assert.deepEqual(AttemptOutputSchema.parse(output), output);
  const acpOutput = {
    ...output,
    channel: 'acp',
    acp: {
      sessionId: permission.sessionId,
      sessionUpdate: 'tool_call_update',
      toolCallId: permission.toolCallId,
      status: 'completed',
      locations: [{ path: 'src/net.mjs', line: 1 }],
      diffPaths: ['src/net.mjs'],
    },
  };
  assert.deepEqual(AttemptOutputSchema.parse(acpOutput), acpOutput);
  for (const change of [
    { toolCallId: undefined },
    { status: 'approved' },
    { sessionUpdate: 'future-command' },
    { locations: [{ path: '/private/file', line: 1 }] },
    { locations: [{ path: 'src/net.mjs', line: 0 }] },
    { diffPaths: ['../source'] },
    { diffPaths: Array(101).fill('net.mjs') },
    { rawInput: { secret: 'synthetic-secret' } },
  ])
    assert.equal(
      AttemptOutputSchema.safeParse({ ...acpOutput, acp: { ...acpOutput.acp, ...change } }).success,
      false,
    );
  const historicalRun = {
    runId: `run_${suffix}`,
    profileId: historicalProfile.id,
    stage: 'retain-only',
  };
  assert.deepEqual(NativeRunSchema.parse(historicalRun), historicalRun);
  const acpAttestation = { ...attestation, quotaAccountConfirmed: true };
  const acpRun = {
    ...historicalRun,
    profileId: acpProfile.id,
    acp: selection,
    billingAttestation: acpAttestation,
    permissionMode: 'request-review',
    target: { path: 'net.mjs', baseHash: 'a'.repeat(64), bytes: 1 },
  };
  assert.deepEqual(NativeRunSchema.parse(acpRun), acpRun);
  for (const change of [
    { acp: undefined },
    { target: undefined },
    { billingAttestation: attestation },
    { billingAttestation: { ...acpAttestation, quotaAccountConfirmed: false } },
    { permissionMode: 'always-proceed' },
    { profileId: 'google-file-v1' },
    { execution },
  ])
    assert.equal(NativeRunSchema.safeParse({ ...acpRun, ...change }).success, false);
  const repositoryRun = {
    ...historicalRun,
    profileId: repositoryProfile.id,
    repository: { sourceBase: 'a'.repeat(40), manifestHash: 'b'.repeat(64), files: 8, bytes: 4096 },
    execution,
  };
  assert.deepEqual(NativeRunSchema.parse(repositoryRun), repositoryRun);
  for (const change of [
    { repository: undefined },
    { execution: undefined },
    { profileId: historicalProfile.id },
    { target: { path: 'net.mjs', baseHash: 'a'.repeat(64), bytes: 1 } },
    { billingAttestation: attestation },
    { permissionMode: 'request-review' },
  ])
    assert.equal(NativeRunSchema.safeParse({ ...repositoryRun, ...change }).success, false);
  assert.ok(CommandSchema.safeParse(command).success);
  for (const [quality, methods] of [
    ['quick', ['keep-it-simple']],
    ['standard', ['keep-it-simple', 'second-opinion']],
    ['thorough', ['keep-it-simple', 'second-opinion', 'challenge-assumptions']],
  ] as const)
    assert.deepEqual(requiredReviewMethodIds(quality), methods);
  const route = {
    id: `rte_${suffix}`,
    family: 'openai',
    displayName: 'Fixture',
    model: 'fixture',
    effort: { requested: 'standard', effective: 'standard', supported: ['standard'] },
    billing: 'included',
    qualified: true,
    fake: true,
  };
  assert.ok(RouteSchema.safeParse(route).success);
  assert.ok(
    RouteSchema.safeParse({
      ...route,
      speed: { requested: 'fast', effective: 'fast', supported: ['normal', 'fast'] },
    }).success,
  );
  assert.ok(
    RouteSchema.safeParse({
      ...route,
      qualified: false,
      speed: { requested: 'fast', effective: null, supported: [] },
    }).success,
  );
  for (const speed of [
    { requested: 'fast', effective: 'normal', supported: ['normal', 'fast'] },
    { requested: 'fast', effective: null, supported: ['fast'] },
    { requested: 'fast', effective: 'fast', supported: ['normal'] },
    { requested: 'normal', effective: 'normal', supported: ['normal', 'normal'] },
    { requested: 'turbo', effective: 'turbo', supported: ['turbo'] },
    { requested: 'normal', effective: 'normal', supported: ['normal'], extra: true },
  ])
    assert.equal(RouteSchema.safeParse({ ...route, speed }).success, false);

  const role = { role: 'coder', routeId: `rte_${suffix}`, pinned: false, approvedFallbacks: [] };
  assert.equal(RoleSchema.parse(role).selection, undefined);
  for (const selection of ['ordered', 'reset-aware'])
    assert.ok(RoleSchema.safeParse({ ...role, selection }).success);
  assert.equal(RoleSchema.safeParse({ ...role, selection: 'random' }).success, false);
  const notices = [
    { kind: 'connection', state: 'offline', reconnectAvailable: true },
    { kind: 'history-gap', after: '0' },
    { kind: 'retry', available: false },
    { kind: 'export', artifactId: `art_${suffix}`, outcome: 'cancelled' },
  ];
  for (const notice of notices) {
    assert.ok(DesktopNoticeSchema.safeParse(notice).success);
    assert.equal(DesktopNoticeSchema.safeParse({ ...notice, extra: true }).success, false);
  }
  for (const invalid of [
    { ...notices[0], state: 'ready' },
    { ...notices[0], reconnectAvailable: 'true' },
    { ...notices[1], after: '-1' },
    { ...notices[2], available: 1 },
    { ...notices[3], artifactId: 'arbitrary' },
    { ...notices[3], outcome: 'created' },
    { ...notices[3], path: '/private/file' },
  ])
    assert.equal(DesktopNoticeSchema.safeParse(invalid).success, false);
  const manifest = {
    version: 1,
    node: { version: '24.22.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
    mode: 'demo',
  };
  assert.ok(RuntimeManifestSchema.safeParse(manifest).success);
  assert.ok(
    RuntimeManifestSchema.safeParse({
      ...manifest,
      node: { ...manifest.node, platform: 'linux', arch: 'x64' },
    }).success,
  );
  for (const invalid of [
    { ...manifest, version: 2 },
    { ...manifest, mode: 'production' },
    { ...manifest, entry: '/arbitrary/entry' },
    ...[
      { version: '24.21.0' },
      { platform: 'win32' },
      { arch: 'ia32' },
      { sha256: 'invalid' },
      { path: '/arbitrary/node' },
    ].map((node) => ({ ...manifest, node: { ...manifest.node, ...node } })),
  ])
    assert.equal(RuntimeManifestSchema.safeParse(invalid).success, false);
  const checkSummary = {
    type: 'summary',
    file: null,
    success: true,
    counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 },
  };
  const checkLeaf = {
    type: 'test',
    file: 'net.test.mjs',
    name: 'required leaf',
    kind: 'test',
    passed: true,
    skipped: false,
    todo: false,
  };
  for (const valid of [
    { type: 'start', version: 1 },
    checkLeaf,
    { ...checkLeaf, file: '', name: '' },
    checkSummary,
    { type: 'output', channel: 'stdout', text: '' },
    { type: 'end' },
  ])
    assert.ok(CheckEventSchema.safeParse(valid).success);
  for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
    assert.equal(
      CheckEventSchema.safeParse({
        ...checkSummary,
        counts: { ...checkSummary.counts, tests: count },
      }).success,
      false,
    );
  for (const invalid of [
    { type: 'start', version: 2 },
    { type: 'end', extra: true },
    { ...checkLeaf, passed: 'true' },
    { ...checkLeaf, file: 'a'.repeat(4097) },
    { ...checkLeaf, name: 'a'.repeat(4097) },
    { ...checkSummary, file: '' },
    { ...checkSummary, counts: { ...checkSummary.counts, extra: 0 } },
    { type: 'output', channel: 'stdout', text: 'a'.repeat(65537) },
  ])
    assert.equal(CheckEventSchema.safeParse(invalid).success, false);
  const job = {
    taskId: `tsk_${suffix}`,
    runId: `run_${suffix}`,
    attemptId: `att_${suffix}`,
    generation: 1,
    routeId: `rte_${suffix}`,
    candidateId: `cnd_${suffix}`,
    candidateHash: 'a'.repeat(64),
    methodId: 'keep-it-simple',
    cycle: 1,
    limitMinutes: 1,
    scripted: true,
  };
  assert.ok(ReviewJobSchema.safeParse(job).success);
  const boundJob = { ...job, writerAttemptId: `att_${suffix}`, writerRouteId: job.routeId };
  assert.ok(ReviewJobSchema.safeParse(boundJob).success);
  const nativeJob = {
    ...boundJob,
    scripted: false,
    preparationId: `art_${suffix}`,
    profileId: 'openai-file-v1',
    assignedRole: 'reviewer',
    independence: 'process-only',
  };
  assert.ok(ReviewJobSchema.safeParse(nativeJob).success);
  const evaluation = {
    ...command,
    command: 'PrepareCandidateEvaluation',
    payload: {
      taskId: job.taskId,
      candidateId: job.candidateId,
      checkRecipeId: 'node-tests-v1',
      reviewer: { profileId: 'openai-file-v1', methodId: 'keep-it-simple', cycles: 1 },
      consent: 'explicit',
      grants: ['run-check', 'run-review'].map((action) => ({
        taskId: job.taskId,
        action,
        target: action === 'run-check' ? 'node --test' : 'keep-it-simple/cycle-1',
        expiresAt: '2026-10-16T00:00:00.000Z',
        revoked: false,
        usesRemaining: 1,
      })),
    },
  };
  assert.ok(CommandSchema.safeParse(evaluation).success);
  const projectChecks = {
    ...evaluation,
    payload: {
      ...evaluation.payload,
      checkRecipeId: 'project-node-tests-v1',
      testFiles: ['tests/日本語.test.mjs', 'test with spaces.cjs'],
    },
  };
  assert.ok(CommandSchema.safeParse(projectChecks).success);
  const toolchainChecks = {
    ...evaluation,
    payload: { ...evaluation.payload, checkRecipeId: 'crewkite-verify-v1' },
  };
  assert.deepEqual(CommandSchema.parse(toolchainChecks), {
    ...toolchainChecks,
    payload: { ...toolchainChecks.payload, creditPolicy: 'ordinary' },
  });
  for (const change of [
    { argv: ['verify'] },
    { executable: '/usr/bin/node' },
    { donorPath: '/tmp/dependencies' },
    { toolchainId: 'installed' },
    { testFiles: [] },
    { maximumMinutes: 10 },
    { environment: { PATH: '/usr/bin' } },
    { verification: {} },
  ])
    assert.equal(
      CommandSchema.safeParse({
        ...toolchainChecks,
        payload: { ...toolchainChecks.payload, ...change },
      }).success,
      false,
    );
  for (const testFiles of [
    [],
    ['a.test.mjs', 'a.test.mjs'],
    ['../a.test.mjs'],
    ['/a.test.mjs'],
    ['--test-only'],
    ['tests/*.mjs'],
    ['tests/[ab].mjs'],
    Array.from({ length: 33 }, (_, index) => `${index}.test.mjs`),
  ])
    assert.equal(
      CommandSchema.safeParse({
        ...projectChecks,
        payload: { ...projectChecks.payload, testFiles },
      }).success,
      false,
    );
  assert.equal(
    CommandSchema.safeParse({
      ...evaluation,
      payload: { ...evaluation.payload, testFiles: ['a.test.mjs'] },
    }).success,
    false,
  );
  const localAcceptance = CandidateEvaluationPreviewSchema.shape.localAcceptance;
  const preview = {
    taskId: nativeJob.taskId,
    runId: nativeJob.runId,
    candidateId: nativeJob.candidateId,
    candidateHash: nativeJob.candidateHash,
    preparationId: nativeJob.preparationId,
    recipe: 'node-tests-v1',
    testFiles: [],
    definitionHash: 'b'.repeat(64),
    target: { path: 'net.mjs', baseHash: 'a'.repeat(64), candidateContentHash: 'b'.repeat(64) },
    reviewer: {
      profileId: nativeJob.profileId,
      assignedRole: 'reviewer',
      methodId: 'keep-it-simple',
      cycle: 1,
      independence: 'process-only',
    },
    creditPolicy: 'ordinary',
    expiresAt: '2026-10-16T00:00:00.000Z',
    remainingBudgets: { attempts: 2, minutes: 5, concurrency: 1 },
    allowance: { source: 'supplemental-evaluation', localChecks: 1, nativeReviews: 1 },
    stage: 'prepared',
    check: null,
    review: null,
    checkStart: { available: true, reason: 'available' },
    reviewStart: { available: false, reason: 'checks-required' },
    localAcceptance: { available: false, reason: 'evidence-incomplete' },
  };
  assert.deepEqual(CandidateEvaluationPreviewSchema.parse(preview), preview);
  const { testFiles: _legacyFiles, ...legacyPreview } = preview;
  assert.deepEqual(CandidateEvaluationPreviewSchema.parse(legacyPreview), preview);
  const verification = {
    toolchainHash: 'c'.repeat(64),
    baselineHash: 'd'.repeat(64),
    lockHash: 'e'.repeat(64),
    platform: 'darwin',
    arch: 'arm64',
    executables: {
      node: { version: '24.22.0', sha256: '1'.repeat(64) },
      electron: { version: '44.7.2', sha256: '3'.repeat(64) },
      git: { version: '2.50.1', sha256: '4'.repeat(64) },
    },
    stages: ['policy', 'lint', 'types', 'node-tests', 'build', 'desktop'],
    maximumMinutes: 5,
  };
  const verificationPreview = { ...preview, recipe: 'crewkite-verify-v1', verification };
  assert.deepEqual(
    CandidateEvaluationPreviewSchema.parse(verificationPreview),
    verificationPreview,
  );
  for (const invalid of [
    { ...verificationPreview, verification: undefined },
    {
      ...verificationPreview,
      testFiles: [{ path: 'a.test.mjs', hash: 'a'.repeat(64), bytes: 1, mode: '100644' }],
    },
    { ...preview, verification },
    { ...preview, verification: undefined },
    { ...verificationPreview, verification: { ...verification, maximumMinutes: 1 } },
    {
      ...verificationPreview,
      verification: { ...verification, stages: verification.stages.slice(1) },
    },
    {
      ...verificationPreview,
      verification: { ...verification, stages: [...verification.stages].reverse() },
    },
    { ...verificationPreview, verification: { ...verification, platform: 'linux' } },
    { ...verificationPreview, verification: { ...verification, donorPath: '/tmp/dependencies' } },
    { ...verificationPreview, verification: { ...verification, toolchainHash: 'unknown' } },
    {
      ...verificationPreview,
      verification: {
        ...verification,
        executables: {
          ...verification.executables,
          node: { ...verification.executables.node, path: '/usr/bin/node' },
        },
      },
    },
  ])
    assert.equal(CandidateEvaluationPreviewSchema.safeParse(invalid).success, false);
  const { target: _previewTarget, ...previewFields } = preview;
  const repositoryPreview = { ...previewFields, repository: repositoryRun.repository };
  assert.deepEqual(CandidateEvaluationPreviewSchema.parse(repositoryPreview), repositoryPreview);
  for (const invalid of [previewFields, { ...repositoryPreview, target: preview.target }])
    assert.equal(CandidateEvaluationPreviewSchema.safeParse(invalid).success, false);
  assert.deepEqual(localAcceptance.parse(undefined), {
    available: false,
    reason: 'evidence-incomplete',
  });
  for (const value of [
    { available: true, reason: 'evidence-incomplete' },
    { available: false, reason: 'available' },
    { available: true, reason: 'automatic-grant' },
  ])
    assert.equal(localAcceptance.safeParse(value).success, false);
  for (const change of [
    { independence: 'model-diversity' },
    { writerAttemptId: undefined },
    { preparationId: undefined },
    { profileId: undefined },
    { assignedRole: undefined },
    { methodId: 'round-robin' },
    { cycle: 2 },
    { scripted: true },
  ])
    assert.equal(ReviewJobSchema.safeParse({ ...nativeJob, ...change }).success, false);
  assert.equal(
    FakeWorkerInputSchema.safeParse({
      type: 'review',
      job: nativeJob,
      scratchPath: '/fixture/review',
      criteria: ['Preserve source.'],
    }).success,
    false,
  );
  assert.ok(
    CommandSchema.safeParse({
      ...command,
      command: 'StartCandidateReview',
      payload: {
        taskId: nativeJob.taskId,
        candidateId: nativeJob.candidateId,
        preparationId: nativeJob.preparationId,
      },
    }).success,
  );

  assert.equal(
    ReviewJobSchema.safeParse({ ...job, writerAttemptId: `att_${suffix}` }).success,
    false,
  );
  assert.equal(ReviewJobSchema.safeParse({ ...job, writerRouteId: job.routeId }).success, false);
  for (const methodId of [
    'keep-it-simple',
    'second-opinion',
    'challenge-assumptions',
    'round-robin',
  ] as const)
    for (const cycle of [1, 2, 3]) {
      const target = { methodId, cycle };
      assert.equal(formatReviewTarget(target), `${methodId}/cycle-${cycle}`);
      assert.deepEqual(parseReviewTarget(formatReviewTarget(target)), target);
    }
  for (const value of [
    'second-opinion/cycle-0',
    'second-opinion/cycle-4',
    'second-opinion/cycle-01',
    'second-opinion/cycle-1 ',
    ' second-opinion/cycle-1',
    'unknown/cycle-1',
    'second-opinion/cycle-1\n',
    null,
    {},
  ])
    assert.equal(parseReviewTarget(value), null);
  for (const value of [
    { methodId: 'unknown', cycle: 1 },
    { methodId: 'second-opinion', cycle: 0 },
    { methodId: 'second-opinion', cycle: 1.5 },
    { methodId: 'second-opinion', cycle: 4 },
    { methodId: 'second-opinion', cycle: 1, extra: true },
  ])
    assert.throws(() => formatReviewTarget(value as Parameters<typeof formatReviewTarget>[0]));

  for (const invalid of [
    { ...job, cycle: 4 },
    { ...job, scripted: false },
    { ...job, limitMinutes: 0 },
  ])
    assert.equal(ReviewJobSchema.safeParse(invalid).success, false);
  const review = { job, outcome: 'passed', findings: [], summary: 'Scripted scope check passed.' };
  assert.ok(
    FakeWorkerInputSchema.safeParse({
      type: 'review',
      job,
      scratchPath: '/fixture/review',
      criteria: ['Preserve source.'],
    }).success,
  );
  assert.ok(FakeWorkerEventSchema.safeParse({ type: 'review', result: review }).success);
  assert.ok(
    GrantSchema.safeParse({
      taskId: job.taskId,
      action: 'run-review',
      target: 'keep-it-simple/cycle-1',
      expiresAt: '2026-10-16T00:00:00.000Z',
      revoked: false,
      usesRemaining: 1,
    }).success,
  );
  assert.ok(
    CheckResultSchema.safeParse({
      candidateId: job.candidateId,
      candidateHash: job.candidateHash,
      definitionHash: 'b'.repeat(64),
      evaluator: 'scripted-scope',
      passed: true,
      artifactId: `art_${suffix}`,
      review,
    }).success,
  );
  for (const invalid of [
    { ...review, job: { ...job, candidateHash: 'b'.repeat(64) } },
    { ...review, outcome: 'blocked' },
    { ...review, findings: [{ severity: 'blocking', message: 'Scope changed.' }] },
  ])
    assert.equal(
      CheckResultSchema.safeParse({
        candidateId: job.candidateId,
        candidateHash: job.candidateHash,
        definitionHash: 'b'.repeat(64),
        evaluator: 'scripted-scope',
        passed: true,
        artifactId: `art_${suffix}`,
        review: invalid,
      }).success,
      false,
    );
  const policy = {
    authority: 'balanced',
    quality: 'standard',
    effects: [],
    limits: { attempts: 4, minutes: 30, concurrency: 1 },
    reserves: [],
    unknownUsage: { rule: 'waiting' },
    guidance: { goal: 'Finish the bounded task.', principles: ['Preserve source.'] },
    methods: [{ id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' }],
  };
  assert.ok(PolicySchema.safeParse(policy).success);
  const filePreparation = {
    ...command,
    command: 'PrepareNativeRun',
    payload: {
      taskId: job.taskId,
      profileId: 'openai-file-v1',
      targetPath: 'net.mjs',
      policy: PolicySchema.parse(policy),
      creditPolicy: 'ordinary',
      consent: 'explicit',
    },
  };
  assert.deepEqual(CommandSchema.parse(filePreparation), filePreparation);
  const acpPreparation = {
    ...filePreparation,
    payload: {
      ...filePreparation.payload,
      ...selection,
      profileId: 'google-acp-v1',
      policy: { ...filePreparation.payload.policy, authority: 'guided' },
      billingAttestation: acpAttestation,
      permissionMode: 'request-review',
    },
  };
  assert.deepEqual(CommandSchema.parse(acpPreparation), acpPreparation);
  assert(
    CommandSchema.safeParse({
      ...acpPreparation,
      payload: {
        ...acpPreparation.payload,
        thoughtLevelId: null,
        policy: { ...acpPreparation.payload.policy, authority: 'balanced' },
      },
    }).success,
  );
  for (const change of [
    { proofId: undefined },
    { modelId: '' },
    { thoughtLevelId: undefined },
    { billingAttestation: attestation },
    { billingAttestation: { ...acpAttestation, quotaAccountConfirmed: false } },
    { creditPolicy: 'existing-credits' },
    { permissionMode: 'always-proceed' },
    { policy: { ...acpPreparation.payload.policy, authority: 'autopilot' } },
    { handoffTargets: [{ profileId: 'openai-file-v1' }] },
    { targetPath: '../source' },
    { executable: '/caller/binary' },
  ])
    assert.equal(
      CommandSchema.safeParse({
        ...acpPreparation,
        payload: { ...acpPreparation.payload, ...change },
      }).success,
      false,
    );
  assert.equal(
    CommandSchema.safeParse({
      ...filePreparation,
      payload: {
        ...filePreparation.payload,
        profileId: 'google-acp-v1',
      },
    }).success,
    false,
  );
  const handoffTargets = [
    { profileId: 'openai-file-v1', creditPolicy: 'existing-credits' },
    { profileId: 'anthropic-file-v1', creditPolicy: 'ordinary' },
    { profileId: 'google-file-v1', creditPolicy: 'ordinary' },
  ];
  assert.deepEqual(NativeHandoffTargetsSchema.parse(handoffTargets), handoffTargets);
  const transferable = {
    ...filePreparation,
    payload: { ...filePreparation.payload, handoffTargets },
  };
  assert.deepEqual(CommandSchema.parse(transferable), transferable);
  for (const invalid of [
    [],
    [...handoffTargets, handoffTargets[0]],
    [handoffTargets[0], handoffTargets[0]],
    [{ profileId: 'openai-repository-v1', creditPolicy: 'ordinary' }],
    [{ profileId: 'anthropic-file-v1', creditPolicy: 'existing-credits' }],
    [{ ...handoffTargets[0], executable: '/caller/client' }],
  ])
    assert.equal(NativeHandoffTargetsSchema.safeParse(invalid).success, false);
  const handoffPreparation = {
    ...command,
    command: 'PrepareNativeHandoff',
    payload: {
      taskId: job.taskId,
      runId: job.runId,
      fromAttemptId: job.attemptId,
      profileId: 'openai-file-v1',
      creditPolicy: 'existing-credits',
      consent: 'explicit',
    },
  };
  for (const payload of [
    handoffPreparation.payload,
    {
      ...handoffPreparation.payload,
      profileId: 'anthropic-file-v1',
      creditPolicy: 'ordinary',
      billingAttestation: attestation,
    },
    {
      ...handoffPreparation.payload,
      profileId: 'google-file-v1',
      creditPolicy: 'ordinary',
      billingAttestation: attestation,
      permissionMode: 'request-review',
    },
  ])
    assert.deepEqual(CommandSchema.parse({ ...handoffPreparation, payload }).payload, payload);
  for (const change of [
    { consent: 'saved' },
    { fromAttemptId: undefined },
    { profileId: 'openai-repository-v1' },
    { profileId: 'anthropic-file-v1', creditPolicy: 'ordinary' },
    { profileId: 'google-file-v1', creditPolicy: 'ordinary', billingAttestation: attestation },
    { billingAttestation: attestation },
    { permissionMode: 'request-review' },
    { targetPath: 'another.mjs' },
    { packetId: `hnd_${suffix}` },
    { execution },
  ])
    assert.equal(
      CommandSchema.safeParse({
        ...handoffPreparation,
        payload: { ...handoffPreparation.payload, ...change },
      }).success,
      false,
    );
  const startHandoff = {
    ...command,
    command: 'StartNativeHandoff',
    payload: { taskId: job.taskId, runId: job.runId, preparationId: `art_${suffix}` },
  };
  assert.deepEqual(CommandSchema.parse(startHandoff), startHandoff);
  assert.equal(
    CommandSchema.safeParse({
      ...startHandoff,
      payload: { ...startHandoff.payload, profileId: 'google-file-v1' },
    }).success,
    false,
  );
  const handoffPreview = {
    targets: handoffTargets,
    currentAttemptId: job.attemptId,
    generation: 0,
    prepare: { available: true, reason: 'available' },
    pending: {
      preparationId: `art_${suffix}`,
      packetId: `hnd_${suffix}`,
      fromAttemptId: job.attemptId,
      generation: 1,
      recipient: handoffTargets[1],
      baseHash: 'a'.repeat(64),
      bytes: 65536,
      expiresAt: '2026-10-18T00:00:00.000Z',
      start: { available: true, reason: 'available' },
    },
  };
  assert.deepEqual(NativeHandoffPreviewSchema.parse(handoffPreview), handoffPreview);
  for (const change of [
    { generation: 0 },
    { generation: 2 },
    { fromAttemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
    { bytes: 65537 },
    { recipient: { profileId: 'openai-file-v1', creditPolicy: 'ordinary' } },
    { start: { available: true, reason: 'ownership-unknown' } },
  ])
    assert.equal(
      NativeHandoffPreviewSchema.safeParse({
        ...handoffPreview,
        pending: { ...handoffPreview.pending, ...change },
      }).success,
      false,
    );
  assert.deepEqual(NativeRunSchema.parse({ ...historicalRun, handoff: handoffPreview }), {
    ...historicalRun,
    handoff: handoffPreview,
  });
  assert.equal(
    NativeRunSchema.safeParse({ ...repositoryRun, handoff: handoffPreview }).success,
    false,
  );
  const { targetPath: _target, ...preparationFields } = filePreparation.payload;
  const repositoryPreparation = {
    ...filePreparation,
    payload: { ...preparationFields, profileId: 'openai-repository-v1' },
  };
  assert.deepEqual(CommandSchema.parse(repositoryPreparation), repositoryPreparation);
  for (const change of [
    { targetPath: 'net.mjs' },
    { billingAttestation: attestation },
    { permissionMode: 'request-review' },
    { execution },
    { handoffTargets },
    { profileId: 'openai-file-v1' },
  ])
    assert.equal(
      CommandSchema.safeParse({
        ...repositoryPreparation,
        payload: { ...repositoryPreparation.payload, ...change },
      }).success,
      false,
    );
  assert.ok(
    GrantSchema.safeParse({
      taskId: job.taskId,
      action: 'run-native-tools',
      target: 'fixture-project',
      expiresAt: '2026-10-16T00:00:00.000Z',
      revoked: false,
      usesRemaining: 1,
    }).success,
  );
  const handoff = sealHandoff({
    version: 1,
    id: `hnd_${suffix}`,
    taskId: job.taskId,
    runId: job.runId,
    attemptId: job.attemptId,
    generation: 0,
    outcome: 'Finish the bounded task.',
    criteria: ['Preserve source.'],
    decisions: [],
    deniedActions: [],
    source: {
      projectId: `prj_${suffix}`,
      base: 'd'.repeat(40),
      branch: 'main',
      dirtyCount: 0,
      untrackedCount: 0,
    },
    candidate: {
      id: job.candidateId,
      taskId: job.taskId,
      hash: job.candidateHash,
      artifactId: `art_${suffix}`,
      revision: 0,
    },
    artifacts: [
      { id: `art_${suffix}`, hash: job.candidateHash, bytes: 1, mediaType: 'application/json' },
    ],
    unfinished: [],
    unverified: [],
    failedChecks: [],
    unrunChecks: [],
    scope: ['net.mjs'],
    remainingBudgets: { attempts: 2, minutes: 20, concurrency: 1 },
    unresolvedExposure: [],
    policy: { policy: PolicySchema.parse(policy), hash: hashCanonical(policy) },
    allowedRouteIds: [job.routeId],
    createdAt: '2026-10-15T17:00:00.000Z',
  });
  const start = {
    type: 'start',
    attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW',
    generation: 1,
    scratchPath: '/fixture/scratch',
    scenario: 'complete',
    outcome: handoff.packet.outcome,
  };
  assert.ok(FakeWorkerInputSchema.safeParse({ ...start, generation: 0 }).success);
  assert.ok(FakeWorkerInputSchema.safeParse({ ...start, handoff }).success);
  for (const invalid of [
    { ...handoff, checksum: 'invalid' },
    { ...handoff, extra: true },
    { ...handoff, packet: { ...handoff.packet, generation: -1 } },
    {
      ...handoff,
      packet: { ...handoff.packet, source: { ...handoff.packet.source, extra: true } },
    },
  ])
    assert.equal(FakeWorkerInputSchema.safeParse({ ...start, handoff: invalid }).success, false);
  assert.equal(
    PolicySchema.safeParse({ ...policy, methods: [...policy.methods, ...policy.methods] }).success,
    false,
  );

  const grant = {
    taskId: `tsk_${suffix}`,
    action: 'accept-candidate',
    target: 'refs/heads/result',
    expiresAt: '2026-10-16T00:00:00.000Z',
    revoked: false,
    usesRemaining: 1,
  };
  assert.ok(GrantSchema.safeParse(grant).success);
  for (const invalid of [
    { ...grant, taskId: undefined },
    { ...grant, expiresAt: undefined },
    { ...grant, usesRemaining: 2 },
  ])
    assert.equal(GrantSchema.safeParse(invalid).success, false);
  assert.ok(RemainingBudgetsSchema.safeParse({ attempts: 0, minutes: 0, concurrency: 0 }).success);
  const source = {
    projectId: `prj_${suffix}`,
    base: 'a'.repeat(40),
    branch: 'main',
    dirtyCount: 0,
    untrackedCount: 0,
  };
  assert.ok(SourceSchema.safeParse(source).success);
  assert.ok(SourceSchema.safeParse({ ...source, base: 'a'.repeat(64) }).success);
  for (const size of [39, 41, 63, 65])
    assert.equal(SourceSchema.safeParse({ ...source, base: 'a'.repeat(size) }).success, false);
  assert.ok(
    CommandResultSchema.safeParse({ outcome: 'applied', data: { kind: 'source', source } }).success,
  );

  const sourceDetails = {
    files: [
      { path: 'src/main.ts', status: 'modified', staged: false, unstaged: true },
      { path: 'scratch.txt', status: 'untracked', staged: false, unstaged: true },
    ],
    omittedDirty: 0,
    omittedUntracked: 0,
  };
  const inspection = {
    kind: 'source',
    source: { ...source, dirtyCount: 1, untrackedCount: 1 },
    details: sourceDetails,
  };
  assert.ok(ReadDataSchema.safeParse(inspection).success);
  assert.ok(
    ReadDataSchema.safeParse({
      ...inspection,
      details: { files: [], omittedDirty: 1, omittedUntracked: 1 },
    }).success,
  );
  for (const path of [
    '/etc/file',
    'C:/file',
    '../file',
    './file',
    'a//file',
    '.git/config',
    'a\\file',
    'a\0file',
  ])
    assert.equal(
      ReadDataSchema.safeParse({
        ...inspection,
        details: {
          ...sourceDetails,
          files: [{ ...sourceDetails.files[0], path }, sourceDetails.files[1]],
        },
      }).success,
      false,
    );
  for (const invalid of [
    { ...sourceDetails, omittedDirty: 1 },
    { ...sourceDetails, omittedUntracked: -1 },
    {
      ...sourceDetails,
      files: [{ ...sourceDetails.files[0], status: 'executed' }, sourceDetails.files[1]],
    },
    {
      ...sourceDetails,
      files: [
        { ...sourceDetails.files[0], staged: false, unstaged: false },
        sourceDetails.files[1],
      ],
    },
    {
      ...sourceDetails,
      files: [sourceDetails.files[0], { ...sourceDetails.files[1], staged: true }],
    },
    {
      ...sourceDetails,
      files: [sourceDetails.files[0], { ...sourceDetails.files[1], path: 'src/main.ts' }],
    },
    {
      ...sourceDetails,
      files: [{ ...sourceDetails.files[0], content: 'private' }, sourceDetails.files[1]],
    },
  ])
    assert.equal(ReadDataSchema.safeParse({ ...inspection, details: invalid }).success, false);

  assert.ok(
    SourceDetailsSchema.safeParse({
      ...sourceDetails,
      files: Array.from({ length: 200 }, (_, index) => ({
        ...sourceDetails.files[0],
        path: `file-${index}`,
      })),
    }).success,
  );
  for (const files of [
    Array.from({ length: 201 }, (_, index) => ({
      ...sourceDetails.files[0],
      path: `file-${index}`,
    })),
    Array.from({ length: 100 }, (_, index) => ({
      ...sourceDetails.files[0],
      path: `${index}${'a'.repeat(4000)}`,
    })),
    [{ ...sourceDetails.files[0], path: 'a'.repeat(4097) }],
  ])
    assert.equal(SourceDetailsSchema.safeParse({ ...sourceDetails, files }).success, false);

  for (const invalid of [
    { ...command, protocol: 2 },
    { ...command, expectedRevision: undefined },
    { ...command, expectedRevision: -1 },
    { ...command, key: 'arbitrary-key' },
    { ...command, key: `cmd_Z${suffix.slice(1)}` },
    { ...command, command: 'ExecuteShell' },
    { ...command, payload: { ...command.payload, path: '/tmp/file' } },
    { ...command, actor: { ...command.actor, authority: 'autopilot' } },
  ])
    assert.equal(CommandSchema.safeParse(invalid).success, false);
  const hello = { type: 'hello', protocol: 1, token: 'a'.repeat(64), actor: command.actor };
  assert.ok(TransportMessageSchema.safeParse(hello).success);
  assert.equal(TransportMessageSchema.safeParse({ ...hello, protocol: 2 }).success, false);
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity])
    assert.equal(MinorAmountSchema.safeParse(value).success, false);
  for (const value of ['-1', '01', '1.5', '1'.repeat(21)])
    assert.equal(CursorSchema.safeParse(value).success, false);
  assert.equal(
    ObservationSchema.safeParse({
      routeId: `rte_${suffix}`,
      windowId: 'weekly',
      kind: 'weekly',
      remaining: { value: 101, unit: 'percent' },
      resetsAt: null,
      observedAt: '2026-10-15T17:00:00.000Z',
      source: 'fixture',
      confidence: 'reported',
    }).success,
    false,
  );
});

test('canonical identity ignores key order and detects changed content', () => {
  assert.equal(canonicalJson({ b: [2, { c: true }], a: 1 }), '{"a":1,"b":[2,{"c":true}]}');
  assert.equal(hashCanonical({ a: 1, b: 2 }), hashCanonical({ b: 2, a: 1 }));
  assert.notEqual(hashCanonical({ a: 1 }), hashCanonical({ a: 2 }));
  for (const value of [undefined, NaN, Infinity, { a: undefined }, new Date(0), Array(2)])
    assert.throws(() => canonicalJson(value));
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle));
});
