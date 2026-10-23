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
  CombinedNativeReviewJobSchema,
  CombinedOriginSchema,
  CombinedRunPreviewSchema,
  CommandResultSchema,
  CommandSchema,
  ConversationContextRefSchema,
  ConversationContextRefsSchema,
  ConversationEntrySchema,
  ConversationModelCatalogEntriesSchema,
  ConversationModelCatalogSchema,
  ConversationModelChoicesSchema,
  ConversationModelRequestSchema,
  ConversationPageSchema,
  ConversationPlanningSelectionSchema,
  ConversationPlanProposalSchema,
  ConversationTurnBindingSchema,
  ConversationTurnResultSchema,
  CursorSchema,
  canonicalJson,
  DesktopNoticeSchema,
  FakeWorkerEventSchema,
  FakeWorkerInputSchema,
  formatReviewTarget,
  GitHubReadRequestSchema,
  GoogleAcpSetupSchema,
  GrantSchema,
  LocalEndpointSchema,
  LocalModelBindingSchema,
  LocalModelObservationSchema,
  LocalObservedModelBindingSchema,
  LocalSetupReceiptSchema,
  LocalSetupSchema,
  MinorAmountSchema,
  NativeBillingAttestationSchema,
  NativeHandoffPreviewSchema,
  NativeHandoffTargetsSchema,
  NativeProfileSchema,
  NativeRunSchema,
  ObservationSchema,
  PolicySchema,
  PrepareProjectCommandRequestSchema,
  ProjectCommandPreviewSchema,
  ProjectOperationDataSchema,
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
  TaskConversationStateSchema,
  TaskModelCatalogSchema,
  TransportMessageSchema,
  UsageReaderSchema,
  windowAppliesTo,
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
  const operationInput = {
    taskId: `tsk_${suffix}`,
    recipe: 'test',
    executable: '/tools/test',
    argv: [],
    environment: {},
  };
  assert.equal(PrepareProjectCommandRequestSchema.parse(operationInput).deadlineMs, 900000);
  assert.equal(
    PrepareProjectCommandRequestSchema.safeParse({ ...operationInput, environment: { CI: '1' } })
      .success,
    true,
  );
  assert.equal(
    PrepareProjectCommandRequestSchema.safeParse({
      ...operationInput,
      environment: { SECRET: 'x' },
    }).success,
    false,
  );
  assert.equal(
    PrepareProjectCommandRequestSchema.safeParse({ ...operationInput, argv: ['界'.repeat(8192)] })
      .success,
    false,
  );
  assert.equal(
    PrepareProjectCommandRequestSchema.safeParse({
      ...operationInput,
      argv: Array(9).fill('x'.repeat(8192)),
    }).success,
    false,
  );
  for (const cwdRelative of ['/tmp', '../escape', 'a/../b', 'a\\b', '.git', 'a/./b', 'a\0b'])
    assert.equal(
      PrepareProjectCommandRequestSchema.safeParse({ ...operationInput, cwdRelative }).success,
      false,
    );
  assert.equal(
    PrepareProjectCommandRequestSchema.safeParse({
      ...operationInput,
      cwdRelative: 'packages/core',
    }).success,
    true,
  );
  assert.equal(
    PrepareProjectCommandRequestSchema.safeParse({ ...operationInput, executable: '/tools/te\0st' })
      .success,
    false,
  );
  assert.equal(
    PrepareProjectCommandRequestSchema.safeParse({ ...operationInput, cwdRelative: '\ud800' })
      .success,
    false,
  );
  assert.equal(
    PrepareProjectCommandRequestSchema.safeParse({ ...operationInput, executable: '/tools/\ud800' })
      .success,
    false,
  );
  const operationPreview = ProjectCommandPreviewSchema.parse({
    version: 1,
    id: `cmd_${suffix}`,
    taskId: `tsk_${suffix}`,
    taskRevision: 0,
    source: {
      projectId: `prj_${suffix}`,
      base: 'a'.repeat(40),
      branch: 'main',
      dirtyCount: 0,
      untrackedCount: 0,
    },
    sourceMode: 'committed-head',
    repositoryRoot: '/repo',
    scratchRoot: '/scratch',
    cwd: '/scratch',
    recipe: 'test',
    executable: '/tools/test',
    executableSha256: 'b'.repeat(64),
    executableIdentity: 'verified-prelaunch-sha256',
    argv: [],
    environment: { CI: '1' },
    deadlineMs: 900000,
    nativeTrust: 'required',
  });
  const operationDetail = {
    kind: 'project-operation',
    operation: {
      id: operationPreview.id,
      taskId: operationPreview.taskId,
      kind: 'project-command',
      state: 'prepared',
      observedAt: '2026-10-21T00:00:00.000Z',
      reason: null,
      next: null,
      definition: {
        id: `art_${suffix}`,
        hash: 'c'.repeat(64),
        bytes: 1,
        mediaType: 'application/json',
      },
      stdout: null,
      stderr: null,
      result: null,
    },
    definition: operationPreview,
    githubRequest: null,
    githubResult: null,
  };
  assert.equal(ProjectOperationDataSchema.safeParse(operationDetail).success, true);
  assert.equal(
    ProjectOperationDataSchema.safeParse({ ...operationDetail, definition: null }).success,
    false,
  );
  assert.equal(
    ProjectOperationDataSchema.safeParse({
      ...operationDetail,
      definition: { ...operationPreview, taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
    }).success,
    false,
  );
  const githubRead = {
    kind: 'pull-request',
    repository: { host: 'github.com', owner: 'example', name: 'project' },
    headSha: 'a'.repeat(64),
    pullRequest: '1',
  };
  assert.equal(GitHubReadRequestSchema.safeParse(githubRead).success, true);
  assert.equal(
    GitHubReadRequestSchema.safeParse({
      ...githubRead,
      repository: { ...githubRead.repository, host: '-host' },
    }).success,
    false,
  );
  const operationStart = {
    ...command,
    command: 'StartProjectCommand',
    payload: {
      taskId: operationPreview.taskId,
      operationId: operationPreview.id,
      definitionHash: 'c'.repeat(64),
      sourceConsent: 'explicit',
      nativeTrust: 'accepted',
      grant: {
        taskId: operationPreview.taskId,
        action: 'run-native-tools',
        target: 'c'.repeat(64),
        revoked: false,
        usesRemaining: 1,
        expiresAt: '2026-10-21T00:30:00.000Z',
      },
    },
  };
  assert.equal(CommandSchema.safeParse(operationStart).success, true);
  assert.equal(
    CommandSchema.safeParse({
      ...operationStart,
      payload: {
        ...operationStart.payload,
        grant: { ...operationStart.payload.grant, usesRemaining: 0 },
      },
    }).success,
    false,
  );
  const pageStamp = { epoch: 'a'.repeat(32), revision: '0' };
  for (const name of ['GetWorkspaceState', 'GetProjectPage', 'GetTaskPage']) {
    const payload = name === 'GetWorkspaceState' ? {} : { stamp: pageStamp };
    const read = {
      protocol: 1,
      key: `cmd_${suffix}`,
      actor: command.actor,
      command: name,
      payload,
    };
    assert.equal(CommandSchema.safeParse(read).success, true);
    assert.equal(
      CommandSchema.safeParse({ ...read, payload: { ...payload, extra: true } }).success,
      false,
    );
    if (name !== 'GetWorkspaceState')
      for (const limit of [0, 101])
        assert.equal(
          CommandSchema.safeParse({ ...read, payload: { ...payload, limit } }).success,
          false,
        );
  }
  const combinedId = (prefix: string, index = 0) =>
    `${prefix}_${suffix.slice(0, -1)}${['V', 'W', 'X', 'Y', 'Z', '0', '1', '2'][index]}`;
  const combinedPolicy = {
    authority: 'balanced',
    quality: 'quick',
    effects: [],
    limits: { attempts: 7, minutes: 8, concurrency: 2 },
    reserves: [],
    unknownUsage: { rule: 'waiting' },
    methods: [{ id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' }],
  };
  const combined = {
    ...command,
    command: 'PrepareCombinedRun',
    payload: {
      taskId: combinedId('tsk'),
      policy: combinedPolicy,
      children: [1, 2].map((index) => ({
        taskId: combinedId('tsk', index),
        expectedRevision: 0,
        scope: [`slice-${index}.mjs`],
        writer: { profileId: 'openai-file-v1', creditPolicy: 'ordinary' },
        consent: 'explicit',
        maximumMinutes: 1,
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
      reviewer: { profileId: 'openai-file-v1', creditPolicy: 'ordinary', maximumMinutes: 1 },
    },
  };
  assert.deepEqual(CommandSchema.parse(combined), combined);
  for (const maximumMinutes of [1, 3, 6, 1433]) {
    const explicit = {
      ...combined,
      payload: {
        ...combined.payload,
        integration: { maximumMinutes },
        policy: {
          ...combinedPolicy,
          limits: { ...combinedPolicy.limits, minutes: 7 + maximumMinutes },
        },
      },
    };
    assert.deepEqual(CommandSchema.parse(explicit), explicit);
    assert.equal(
      CommandSchema.safeParse({
        ...explicit,
        payload: {
          ...explicit.payload,
          policy: {
            ...explicit.payload.policy,
            limits: { ...explicit.payload.policy.limits, minutes: 6 + maximumMinutes },
          },
        },
      }).success,
      false,
    );
  }
  for (const maximumMinutes of [0, 1.5, 1441])
    assert.equal(
      CommandSchema.safeParse({
        ...combined,
        payload: { ...combined.payload, integration: { maximumMinutes } },
      }).success,
      false,
    );
  const compactWriter = {
    ...combined,
    payload: {
      ...combined.payload,
      children: [
        {
          ...combined.payload.children[0],
          writer: {
            profileId: 'anthropic-file-compact-v1',
            creditPolicy: 'ordinary',
            billingAttestation: {
              source: 'user-attested',
              subscriptionLoginConfirmed: true,
              paidExtraUsageDisabled: true,
            },
          },
        },
        combined.payload.children[1],
      ],
    },
  };
  assert.deepEqual(CommandSchema.parse(compactWriter), compactWriter);
  for (const payload of [
    { ...combined.payload, children: combined.payload.children.slice(0, 1) },
    {
      ...combined.payload,
      children: combined.payload.children.map((child) => ({ ...child, maximumMinutes: 10 })),
    },
    { ...combined.payload, children: [combined.payload.children[0], combined.payload.children[0]] },
    {
      ...combined.payload,
      children: [
        combined.payload.children[0],
        { ...combined.payload.children[1], scope: combined.payload.children[0].scope },
      ],
    },
    {
      ...combined.payload,
      children: [
        { ...combined.payload.children[0], taskId: combined.payload.taskId },
        combined.payload.children[1],
      ],
    },
    {
      ...combined.payload,
      children: [
        { ...combined.payload.children[0], scope: ['one.mjs', 'two.mjs'] },
        combined.payload.children[1],
      ],
    },
    {
      ...combined.payload,
      children: [
        {
          ...combined.payload.children[0],
          writer: { profileId: 'openai-repository-v1', creditPolicy: 'ordinary' },
        },
        combined.payload.children[1],
      ],
    },
    {
      ...combined.payload,
      children: [
        {
          ...combined.payload.children[0],
          writer: { ...combined.payload.children[0].writer, executable: '/caller/tool' },
        },
        combined.payload.children[1],
      ],
    },
    {
      ...combined.payload,
      children: [
        { ...combined.payload.children[0], title: 'Replacement task' },
        combined.payload.children[1],
      ],
    },
    { ...combined.payload, policy: { ...combinedPolicy, authority: 'autopilot' } },
    { ...combined.payload, policy: { ...combinedPolicy, quality: 'standard' } },
    { ...combined.payload, policy: { ...combinedPolicy, methods: [] } },
    ...[{ attempts: 6 }, { minutes: 7 }, { concurrency: 1 }].map((limits) => ({
      ...combined.payload,
      policy: { ...combinedPolicy, limits: { ...combinedPolicy.limits, ...limits } },
    })),
    { ...combined.payload, checks: { ...combined.payload.checks, recipeId: 'crewkite-verify-v1' } },
    {
      ...combined.payload,
      checks: { ...combined.payload.checks, testFiles: ['one.test.mjs', 'two.test.mjs'] },
    },
    {
      ...combined.payload,
      checks: { ...combined.payload.checks, interactionTestFiles: ['one.test.mjs'] },
    },
    {
      ...combined.payload,
      checks: {
        ...combined.payload.checks,
        testFiles: [...combined.payload.checks.testFiles, 'slice-1.mjs'],
      },
    },
    { ...combined.payload, checks: { ...combined.payload.checks, baselineConsent: 'saved' } },
  ])
    assert.equal(CommandSchema.safeParse({ ...combined, payload }).success, false);
  const assemble = {
    ...command,
    command: 'AssembleCombinedCandidate',
    payload: {
      taskId: combinedId('tsk'),
      runId: combinedId('run'),
      preparationId: combinedId('art'),
    },
  };
  assert.deepEqual(CommandSchema.parse(assemble), assemble);
  assert.equal(
    CommandSchema.safeParse({ ...assemble, payload: { ...assemble.payload, candidates: [] } })
      .success,
    false,
  );
  const origin = {
    kind: 'combined',
    taskId: combinedId('tsk'),
    runId: combinedId('run'),
    preparationId: combinedId('art'),
    manifestHash: 'a'.repeat(64),
    generation: 0,
    sourceBase: 'a'.repeat(40),
    sourceManifestHash: 'b'.repeat(64),
    policyHash: 'c'.repeat(64),
    criteriaHash: 'd'.repeat(64),
    contributors: [1, 2].map((index) => ({
      taskId: combinedId('tsk', index),
      runId: combinedId('run', index),
      attemptId: combinedId('att', index),
      generation: 0,
      routeId: combinedId('rte', index),
      candidateId: combinedId('cnd', index),
      candidateHash: 'e'.repeat(64),
      scopeHash: 'f'.repeat(64),
    })),
    steps: [0, 1].map((index) => ({
      candidateId: combinedId('cnd', index + 3),
      candidateHash: (index ? 'c' : 'b').repeat(64),
      definitionHash: 'a'.repeat(64),
      checkArtifactId: combinedId('art', index + 1),
      previousTree: (index ? 'b' : 'a').repeat(40),
      nextTree: (index ? 'c' : 'b').repeat(40),
    })),
    candidateId: combinedId('cnd', 5),
    candidateHash: 'c'.repeat(64),
  };
  assert.deepEqual(CombinedOriginSchema.parse(origin), origin);
  for (const amendment of [
    { contributors: [origin.contributors[0], origin.contributors[0]] },
    { steps: [origin.steps[0], { ...origin.steps[1], previousTree: 'd'.repeat(40) }] },
    { steps: [{ ...origin.steps[0], nextTree: origin.steps[0].previousTree }, origin.steps[1]] },
    { candidateId: origin.steps[1].candidateId },
    { candidateId: origin.contributors[0].candidateId },
    {
      steps: [
        { ...origin.steps[0], candidateId: origin.contributors[0].candidateId },
        origin.steps[1],
      ],
    },
    {
      steps: [
        origin.steps[0],
        { ...origin.steps[1], checkArtifactId: origin.steps[0].checkArtifactId },
      ],
    },
    { candidateHash: 'd'.repeat(64) },
    { writerAttemptId: combinedId('att') },
  ])
    assert.equal(CombinedOriginSchema.safeParse({ ...origin, ...amendment }).success, false);
  const combinedReview = {
    taskId: origin.taskId,
    runId: origin.runId,
    attemptId: combinedId('att', 3),
    generation: 0,
    routeId: combinedId('rte'),
    candidateId: origin.candidateId,
    candidateHash: origin.candidateHash,
    methodId: 'keep-it-simple',
    cycle: 1,
    limitMinutes: 1,
    scripted: false,
    preparationId: combinedId('art', 3),
    profileId: 'openai-file-v1',
    assignedRole: 'reviewer',
    independence: 'process-only',
    origin,
  };
  assert.deepEqual(CombinedNativeReviewJobSchema.parse(combinedReview), combinedReview);
  assert.deepEqual(ReviewJobSchema.parse(combinedReview), combinedReview);
  for (const amendment of [
    { writerAttemptId: combinedId('att') },
    { writerRouteId: combinedId('rte') },
    { attemptId: origin.contributors[0].attemptId },
    { candidateHash: 'd'.repeat(64) },
  ])
    assert.equal(
      CombinedNativeReviewJobSchema.safeParse({ ...combinedReview, ...amendment }).success,
      false,
    );
  const unavailable = { available: false, reason: 'baseline-required' };
  const combinedPreview = {
    taskId: origin.taskId,
    runId: origin.runId,
    preparationId: origin.preparationId,
    manifestHash: origin.manifestHash,
    revision: 0,
    generation: 0,
    evaluationSelection: {
      recipeId: 'project-node-tests-v1',
      testFiles: combined.payload.checks.testFiles,
      reviewer: { profileId: 'openai-file-v1', methodId: 'keep-it-simple', cycles: 1 },
      creditPolicy: 'ordinary',
    },
    members: [1, 2].map((index) => ({
      taskId: combinedId('tsk', index),
      runId: combinedId('run', index),
      scope: [`slice-${index}.mjs`],
      start: unavailable,
    })),
    phase: 'prepared',
    blocker: null,
    dispatches: [
      'baseline',
      'writer-0',
      'writer-1',
      'replay-0',
      'replay-1',
      'final-check',
      'review',
    ].map((phase) => ({
      phase,
      maximumMinutes: 1,
      state: 'reserved',
      attemptId: null,
      checkArtifactId: null,
    })),
    candidate: null,
    remainingBudgets: { attempts: 7, minutes: 8, concurrency: 2 },
    start: { available: true, reason: 'available' },
    assemble: unavailable,
    evaluate: unavailable,
    review: unavailable,
    accept: unavailable,
  };
  assert.deepEqual(CombinedRunPreviewSchema.parse(combinedPreview), combinedPreview);
  for (const evaluationSelection of [
    { ...combinedPreview.evaluationSelection, recipeId: 'caller-command' },
    { ...combinedPreview.evaluationSelection, testFiles: ['../outside.test.mjs'] },
    {
      ...combinedPreview.evaluationSelection,
      reviewer: { ...combinedPreview.evaluationSelection.reviewer, profileId: 'local-file-v1' },
    },
    { ...combinedPreview.evaluationSelection, command: 'node caller.mjs' },
  ])
    assert.equal(
      CombinedRunPreviewSchema.safeParse({ ...combinedPreview, evaluationSelection }).success,
      false,
    );
  assert.equal(
    CombinedRunPreviewSchema.safeParse({ ...combinedPreview, phase: 'ready' }).success,
    false,
  );
  assert.equal(
    CombinedRunPreviewSchema.safeParse({
      ...combinedPreview,
      dispatches: combinedPreview.dispatches.slice(1),
    }).success,
    false,
  );
  assert.equal(
    CombinedRunPreviewSchema.safeParse({
      ...combinedPreview,
      dispatches: combinedPreview.dispatches.map((dispatch, index) =>
        index ? dispatch : { ...dispatch, state: 'running' },
      ),
    }).success,
    false,
  );
  const contextRef = { artifactId: `art_${suffix}`, hash: 'a'.repeat(64) };
  assert.deepEqual(ConversationContextRefSchema.parse(contextRef), contextRef);
  assert.deepEqual(ConversationContextRefsSchema.parse([contextRef]), [contextRef]);
  for (const refs of [
    [contextRef, contextRef],
    Array(5).fill(contextRef),
    [contextRef, { ...contextRef, hash: 'b'.repeat(64) }],
    [contextRef, { ...contextRef, artifactId: combinedId('art', 1) }],
    [{ ...contextRef, artifactId: `msg_${suffix}` }],
    [{ ...contextRef, grants: [] }],
  ])
    assert.equal(ConversationContextRefsSchema.safeParse(refs).success, false);
  const conversationBinding = {
    taskId: `tsk_${suffix}`,
    runId: `run_${suffix}`,
    attemptId: `att_${suffix}`,
    routeId: `rte_${suffix}`,
    generation: 0,
    role: 'lead',
    taskRevision: 1,
    conversationRevision: 1,
    scopeHash: 'a'.repeat(64),
    limitMinutes: 1,
  };
  assert.deepEqual(ConversationTurnBindingSchema.parse(conversationBinding), conversationBinding);
  const proposal = {
    summary: 'Change the bounded module.',
    criteria: ['Preserve the existing export.'],
    slices: [
      {
        id: 'module',
        title: 'Change the module',
        role: 'coder',
        scope: ['src/main.ts'],
        dependsOn: [],
      },
    ],
    checks: ['node-tests-v1'],
  };
  assert.deepEqual(ConversationPlanProposalSchema.parse(proposal), proposal);
  for (const slices of [
    [proposal.slices[0], proposal.slices[0]],
    [{ ...proposal.slices[0], dependsOn: ['missing'] }],
    [{ ...proposal.slices[0], dependsOn: ['module'] }],
    [
      { ...proposal.slices[0], dependsOn: ['review'] },
      { ...proposal.slices[0], id: 'review', dependsOn: ['module'] },
    ],
    [{ ...proposal.slices[0], scope: ['../outside.ts'] }],
    [{ ...proposal.slices[0], scope: ['src/main.ts', 'src/main.ts'] }],
  ])
    assert.equal(ConversationPlanProposalSchema.safeParse({ ...proposal, slices }).success, false);
  const conversationOutput = {
    version: 1,
    bindingHash: hashCanonical(conversationBinding),
    message: 'I need one scope decision.',
    questions: ['Which export must remain?'],
    proposal,
  };
  assert.deepEqual(ConversationTurnResultSchema.parse(conversationOutput), conversationOutput);
  assert(ConversationTurnResultSchema.safeParse({ ...conversationOutput, proposal: null }).success);
  for (const change of [
    { proposal: undefined },
    { commands: ['StartRun'] },
    { grants: [] },
    { message: '\ud800' },
    { message: 'a\0b' },
    { message: '界'.repeat(1366) },
    { questions: Array(9).fill('Question') },
    { proposal: { ...proposal, effects: [] } },
  ])
    assert.equal(
      ConversationTurnResultSchema.safeParse({ ...conversationOutput, ...change }).success,
      false,
    );
  const conversationEntry = {
    id: `msg_${suffix}`,
    taskId: conversationBinding.taskId,
    revision: 1,
    cursor: '1',
    at: '2026-10-17T00:00:00.000Z',
    kind: 'question',
    text: conversationOutput.questions[0],
    author: {
      kind: 'agent',
      role: 'lead',
      attemptId: conversationBinding.attemptId,
      routeId: conversationBinding.routeId,
    },
    binding: conversationBinding,
  };
  assert.deepEqual(ConversationEntrySchema.parse(conversationEntry), conversationEntry);
  for (const kind of ['user-message', 'guidance', 'answer'] as const) {
    const entry = {
      id: `msg_${suffix}`,
      taskId: conversationBinding.taskId,
      revision: 1,
      cursor: '1',
      at: conversationEntry.at,
      kind,
      text: 'Use selected source.',
      author: { kind: 'user' },
      ...(kind === 'answer' ? { replyTo: conversationEntry.id } : {}),
    };
    assert.deepEqual(ConversationEntrySchema.parse(entry), entry);
    assert.equal('context' in ConversationEntrySchema.parse(entry), false);
    assert.equal(hashCanonical(ConversationEntrySchema.parse(entry)), hashCanonical(entry));
    const attached = { ...entry, context: [contextRef] };
    assert.deepEqual(ConversationEntrySchema.parse(attached), attached);
    assert.equal(
      ConversationEntrySchema.safeParse({ ...attached, context: [contextRef, contextRef] }).success,
      false,
    );
  }
  assert.equal(
    ConversationEntrySchema.safeParse({ ...conversationEntry, context: [contextRef] }).success,
    false,
  );
  for (const change of [
    { id: `art_${suffix}` },
    { taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
    { author: { ...conversationEntry.author, role: 'orchestrator' } },
    { effects: [] },
  ])
    assert.equal(
      ConversationEntrySchema.safeParse({ ...conversationEntry, ...change }).success,
      false,
    );
  const conversationPage = {
    kind: 'conversation',
    taskId: conversationBinding.taskId,
    entries: [conversationEntry],
    nextBeforeCursor: null,
  };
  assert.deepEqual(ConversationPageSchema.parse(conversationPage), conversationPage);
  for (const change of [
    { entries: [conversationEntry, conversationEntry] },
    { taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
    { nextBeforeCursor: '2' },
  ])
    assert.equal(
      ConversationPageSchema.safeParse({ ...conversationPage, ...change }).success,
      false,
    );
  assert(ReadDataSchema.safeParse(conversationPage).success);
  const planning = {
    role: 'lead',
    profileId: 'openai-file-v1',
    creditPolicy: 'ordinary',
    limits: { attempts: 8, minutes: 30, concurrency: 4 },
    consent: 'explicit',
  };
  assert.deepEqual(ConversationPlanningSelectionSchema.parse(planning), planning);
  assert.equal(
    hashCanonical(ConversationPlanningSelectionSchema.parse(planning)),
    hashCanonical(planning),
  );
  const modelRequest = {
    version: 1,
    observation: { artifactId: `art_${suffix}`, hash: 'a'.repeat(64) },
    model: 'model-one',
    effort: 'high',
  };
  assert.deepEqual(ConversationModelRequestSchema.parse(modelRequest), modelRequest);
  assert.deepEqual(ConversationPlanningSelectionSchema.parse({ ...planning, modelRequest }), {
    ...planning,
    modelRequest,
  });
  assert(
    ConversationModelRequestSchema.safeParse({
      ...modelRequest,
      model: `${'界'.repeat(66)}ab`,
      effort: `${'界'.repeat(10)}ab`,
    }).success,
  );
  for (const change of [
    { version: 2 },
    { observation: { ...modelRequest.observation, hash: 'a'.repeat(63) } },
    { observation: { ...modelRequest.observation, artifactId: `tsk_${suffix}` } },
    { observation: { ...modelRequest.observation, executable: '/private/client' } },
    { model: '' },
    { model: '   ' },
    { model: 'a'.repeat(201) },
    { model: '界'.repeat(67) },
    { model: 'model\nname' },
    { model: '\ud800' },
    { effort: '' },
    { effort: 'a'.repeat(33) },
    { effort: '界'.repeat(11) },
    { effort: 'high\u0085' },
    { effort: '\ud800' },
    { account: 'private-account' },
  ])
    assert.equal(
      ConversationModelRequestSchema.safeParse({ ...modelRequest, ...change }).success,
      false,
    );
  const catalogModel = {
    model: modelRequest.model,
    efforts: ['low', 'high'],
    defaultEffort: 'low',
  };
  const catalog = {
    version: 1,
    profileId: planning.profileId,
    taskId: conversationBinding.taskId,
    runId: conversationBinding.runId,
    attemptId: conversationBinding.attemptId,
    generation: 0,
    observedAt: '2026-10-17T00:00:00Z',
    profileHash: 'b'.repeat(64),
    client: { executable: '/private/client', sha256: 'c'.repeat(64), version: '1.0.0' },
    locationHash: 'd'.repeat(64),
    models: [catalogModel],
  };
  assert.deepEqual(ConversationModelCatalogSchema.parse(catalog), catalog);
  const taskCatalog = {
    version: 1,
    origin: 'connection-metadata',
    profileId: 'openai-repository-v1',
    taskId: conversationBinding.taskId,
    taskRevision: 4,
    source: {
      projectId: `prj_${suffix}`,
      base: 'e'.repeat(40),
      branch: 'main',
      dirtyCount: 0,
      untrackedCount: 0,
    },
    observedAt: catalog.observedAt,
    profileHash: catalog.profileHash,
    client: catalog.client,
    locationHash: catalog.locationHash,
    models: catalog.models,
  } as const;
  assert.deepEqual(TaskModelCatalogSchema.parse(taskCatalog), taskCatalog);
  for (const change of [
    { origin: 'planning-turn' },
    { profileId: 'openai-file-v1' },
    { taskRevision: -1 },
    { source: { ...taskCatalog.source, projectId: conversationBinding.taskId } },
  ])
    assert.equal(TaskModelCatalogSchema.safeParse({ ...taskCatalog, ...change }).success, false);
  const maximumModels = Array.from({ length: 20 }, (_, index) => ({
    model: 'm'.repeat(198) + String(index).padStart(2, '0'),
    efforts: Array.from(
      { length: 16 },
      (_, effort) => 'e'.repeat(30) + String(effort).padStart(2, '0'),
    ),
    defaultEffort: `${'e'.repeat(30)}00`,
  }));
  assert(ConversationModelCatalogEntriesSchema.safeParse(maximumModels).success);
  for (const models of [
    [],
    [...maximumModels, { ...catalogModel, model: 'model-extra' }],
    [catalogModel, catalogModel],
    [{ ...catalogModel, efforts: [] }],
    [
      {
        ...catalogModel,
        efforts: Array.from({ length: 17 }, (_, index) => `effort-${index}`),
        defaultEffort: 'effort-0',
      },
    ],
    [{ ...catalogModel, efforts: ['low', 'low'] }],
    [{ ...catalogModel, defaultEffort: 'missing' }],
    [{ ...catalogModel, account: 'private-account' }],
    [{ ...catalogModel, efforts: ['low', ' '] }],
  ])
    assert.equal(ConversationModelCatalogEntriesSchema.safeParse(models).success, false);
  const escapedModels = maximumModels.map((entry, index) => ({
    model: '"'.repeat(198) + String(index).padStart(2, '0'),
    efforts: entry.efforts.map((effort) => '"'.repeat(30) + effort.slice(-2)),
    defaultEffort: `${'"'.repeat(30)}00`,
  }));
  const oversizedCatalog = {
    ...catalog,
    models: escapedModels,
    client: { ...catalog.client, executable: '"'.repeat(4096) },
  };
  assert(Buffer.byteLength(canonicalJson(oversizedCatalog)) > 32768);
  for (const change of [
    { profileId: 'custom-profile' },
    { generation: -1 },
    { client: { ...catalog.client, executable: '界'.repeat(1366) } },
    { client: { ...catalog.client, version: '界'.repeat(67) } },
    { client: { ...catalog.client, account: 'private-account' } },
    { locationHash: 'd'.repeat(63) },
    { observedAt: 'yesterday' },
    oversizedCatalog,
  ])
    assert.equal(
      ConversationModelCatalogSchema.safeParse({ ...catalog, ...change }).success,
      false,
    );
  const modelChoices = {
    status: 'last-observed',
    observation: modelRequest.observation,
    observedAt: catalog.observedAt,
    models: catalog.models,
    reason: 'available',
  };
  const unobservedModels = {
    status: 'not-observed',
    observation: null,
    observedAt: null,
    models: [],
    reason: 'not-observed',
  };
  for (const choices of [
    modelChoices,
    unobservedModels,
    { ...modelChoices, reason: 'model-unavailable' },
    { ...modelChoices, reason: 'effort-unavailable' },
    { ...modelChoices, status: 'client-changed', reason: 'client-changed' },
    { ...modelChoices, status: 'unavailable', models: [], reason: 'observation-stale' },
    { ...unobservedModels, status: 'unavailable', reason: 'catalog-unavailable' },
  ])
    assert.deepEqual(ConversationModelChoicesSchema.parse(choices), choices);
  for (const choices of [
    { ...modelChoices, observation: null },
    { ...modelChoices, observedAt: null },
    { ...modelChoices, models: [] },
    { ...modelChoices, reason: 'client-changed' },
    { ...modelChoices, reason: 'invented-reason' },
    { ...modelChoices, status: 'unavailable', reason: 'observation-missing' },
    { ...unobservedModels, models: catalog.models },
    { ...unobservedModels, reason: 'available' },
    { ...unobservedModels, status: 'client-changed', reason: 'client-changed' },
    { ...modelChoices, client: catalog.client },
    { ...modelChoices, executable: catalog.client.executable },
    { ...modelChoices, locationHash: catalog.locationHash },
    { ...modelChoices, account: 'private-account' },
  ])
    assert.equal(ConversationModelChoicesSchema.safeParse(choices).success, false);
  assert(
    ConversationPlanningSelectionSchema.safeParse({ ...planning, role: 'orchestrator' }).success,
  );
  for (const change of [
    { role: 'coder' },
    { profileId: 'custom-provider' },
    { consent: 'implicit' },
    { limits: { ...planning.limits, concurrency: 17 } },
    { effects: [] },
    { model: 'caller-model' },
    { executable: '/caller/process' },
    { endpoint: 'https://invalid.example' },
    { limits: { ...planning.limits, attempts: 0 } },
  ])
    assert.equal(
      ConversationPlanningSelectionSchema.safeParse({ ...planning, ...change }).success,
      false,
    );
  const conversationState = {
    taskId: conversationBinding.taskId,
    revision: 0,
    contractStatus: 'confirmed',
    purpose: null,
    phase: 'idle',
    configuration: null,
    currentRunId: null,
    activeAttempt: null,
    budget: null,
    queuedInputCount: 0,
    pendingQuestions: [],
    proposal: null,
    adoptedProposal: null,
    send: { available: false, reason: 'not-configured', disposition: null },
    adopt: { available: false, reason: 'proposal-missing' },
  };
  assert.deepEqual(TaskConversationStateSchema.parse(conversationState), conversationState);
  assert.equal(
    hashCanonical(TaskConversationStateSchema.parse(conversationState)),
    hashCanonical(conversationState),
  );
  assert.deepEqual(TaskConversationStateSchema.parse({ ...conversationState, modelChoices }), {
    ...conversationState,
    modelChoices,
  });
  const oversizedModelState = {
    ...conversationState,
    modelChoices: { ...modelChoices, models: escapedModels },
    pendingQuestions: Array.from({ length: 100 }, (_, index) => ({
      id: `msg_${suffix.slice(0, -3)}${String(index).padStart(3, '0')}`,
      cursor: String(index),
    })),
  };
  assert(ConversationModelChoicesSchema.safeParse(oversizedModelState.modelChoices).success);
  assert(Buffer.byteLength(canonicalJson(oversizedModelState)) > 32768);
  assert.equal(TaskConversationStateSchema.safeParse(oversizedModelState).success, false);
  for (const reason of [
    'observation-missing',
    'observation-stale',
    'client-changed',
    'catalog-unavailable',
    'model-unavailable',
    'effort-unavailable',
  ])
    assert(
      TaskConversationStateSchema.safeParse({
        ...conversationState,
        send: { available: false, disposition: null, reason },
      }).success,
    );
  assert(
    ReadDataSchema.safeParse({ kind: 'conversation-state', state: conversationState }).success,
  );
  const configuredConversation = {
    ...conversationState,
    contractStatus: 'provisional',
    purpose: 'conversation',
    phase: 'discussion',
    currentRunId: conversationBinding.runId,
    configuration: {
      revision: 1,
      selection: planning,
      routeId: conversationBinding.routeId,
      requestedModel: 'profile-model',
      effectiveModel: null,
      requestedEffort: 'low',
      effectiveEffort: null,
    },
    budget: { limits: planning.limits, remaining: { attempts: 7, minutes: 29, concurrency: 4 } },
    proposal: {
      id: conversationEntry.id,
      hash: hashCanonical(proposal),
      runId: conversationBinding.runId,
      revision: 1,
    },
    send: { available: true, reason: 'available', disposition: 'turn' },
    adopt: { available: true, reason: 'available' },
  };
  assert.deepEqual(
    TaskConversationStateSchema.parse(configuredConversation),
    configuredConversation,
  );
  assert(
    TaskConversationStateSchema.safeParse({
      ...configuredConversation,
      send: { available: false, reason: 'conversation-input-too-large', disposition: null },
    }).success,
  );
  const conversationOwner = {
    id: conversationBinding.attemptId,
    runId: conversationBinding.runId,
    routeId: conversationBinding.routeId,
    generation: 0,
    state: 'running',
    revision: 0,
  };
  const contextUsage = {
    observation: modelRequest.observation,
    runId: conversationBinding.runId,
    attemptId: conversationBinding.attemptId,
    generation: 0,
    model: 'profile-model',
    usedTokens: 17,
    capacityTokens: 128,
    observedAt: '2026-10-17T00:00:00.000Z',
  };
  for (const usage of [contextUsage, { ...contextUsage, usedTokens: 0, capacityTokens: null }]) {
    const measured = { ...configuredConversation, contextUsage: usage };
    assert.deepEqual(TaskConversationStateSchema.parse(measured), measured);
  }
  for (const change of [
    { usedTokens: -1 },
    { usedTokens: Number.MAX_SAFE_INTEGER + 1 },
    { capacityTokens: 0 },
    { capacityTokens: -1 },
    { capacityTokens: Number.MAX_SAFE_INTEGER + 1 },
    { totalTokens: 100 },
    { runId: `run_${'0'.repeat(26)}` },
    { observedAt: 'tomorrow' },
  ])
    assert.equal(
      TaskConversationStateSchema.safeParse({
        ...configuredConversation,
        contextUsage: { ...contextUsage, ...change },
      }).success,
      false,
    );
  const executionQueue = {
    ...conversationState,
    purpose: 'execution',
    phase: 'execution',
    currentRunId: conversationBinding.runId,
    activeAttempt: conversationOwner,
    send: { available: true, reason: 'queued-at-boundary', disposition: 'queue' },
  };
  assert.deepEqual(TaskConversationStateSchema.parse(executionQueue), executionQueue);
  const retainedExecutionInput = { ...executionQueue, activeAttempt: null };
  assert.deepEqual(
    TaskConversationStateSchema.parse(retainedExecutionInput),
    retainedExecutionInput,
  );
  for (const change of [
    { purpose: 'conversation' },
    { currentRunId: null },
    { phase: 'unknown' },
    { phase: 'stopping' },
  ])
    assert.equal(
      TaskConversationStateSchema.safeParse({ ...retainedExecutionInput, ...change }).success,
      false,
    );
  const linkedPlanningTurn = {
    ...configuredConversation,
    purpose: 'execution',
    send: { available: true, reason: 'available', disposition: 'planning-turn' },
    adopt: { available: false, reason: 'proposal-not-current' },
  };
  assert.deepEqual(TaskConversationStateSchema.parse(linkedPlanningTurn), linkedPlanningTurn);
  for (const change of [
    { configuration: null },
    { budget: null },
    { currentRunId: null },
    { purpose: 'conversation' },
    { activeAttempt: conversationOwner },
    { phase: 'unknown' },
    { phase: 'stopping' },
  ])
    assert.equal(
      TaskConversationStateSchema.safeParse({ ...linkedPlanningTurn, ...change }).success,
      false,
    );
  assert(
    TaskConversationStateSchema.safeParse({
      ...configuredConversation,
      activeAttempt: conversationOwner,
      send: executionQueue.send,
      adopt: { available: false, reason: 'owner-active' },
    }).success,
  );
  for (const change of [
    { currentRunId: null },
    { purpose: null },
    { activeAttempt: { ...conversationOwner, state: 'unknown' } },
  ])
    assert.equal(
      TaskConversationStateSchema.safeParse({ ...executionQueue, ...change }).success,
      false,
    );
  for (const change of [
    { send: { available: true, reason: 'ownership-unknown', disposition: 'turn' } },
    { configuration: null },
    { configuration: { ...configuredConversation.configuration, routeId: null } },
    { budget: null },
    { currentRunId: null },
    { purpose: 'execution' },
    { phase: 'unknown' },
    { activeAttempt: conversationOwner },
    { proposal: { ...configuredConversation.proposal, runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAW' } },
    { send: { available: false, reason: 'available', disposition: null } },
    { send: { available: true, reason: 'available', disposition: 'queue' } },
    { send: { available: false, reason: 'invented-reason', disposition: null } },
    { adopt: { available: true, reason: 'proposal-missing' } },
    { proposal: null },
    {
      budget: { limits: planning.limits, remaining: { attempts: 9, minutes: 29, concurrency: 4 } },
    },
    { configuration: { ...configuredConversation.configuration, executable: '/caller/process' } },
    {
      pendingQuestions: [
        { id: conversationEntry.id, cursor: '1' },
        { id: conversationEntry.id, cursor: '1' },
      ],
    },
  ])
    assert.equal(
      TaskConversationStateSchema.safeParse({ ...configuredConversation, ...change }).success,
      false,
    );
  const conversationStateRead = {
    protocol: 1,
    key: command.key,
    actor: command.actor,
    command: 'GetTaskConversationState',
    payload: { taskId: conversationBinding.taskId },
  };
  assert.deepEqual(CommandSchema.parse(conversationStateRead), conversationStateRead);
  const conversationRead = {
    protocol: 1,
    key: command.key,
    actor: command.actor,
    command: 'GetTaskConversation',
    payload: { taskId: conversationBinding.taskId, beforeCursor: '1' },
  };
  assert.deepEqual(CommandSchema.parse(conversationRead), conversationRead);
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
    maximumTaskMs: 600000,
    maximumSourceFiles: 10000,
    maximumSourceBytes: 67108864,
    execution,
  };
  assert.deepEqual(NativeProfileSchema.parse(repositoryProfile), repositoryProfile);
  for (const change of [
    { maximumFileBytes: 65536 },
    { maximumTaskMs: 300000 },
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
  assert.deepEqual(
    NativeProfileSchema.parse({ ...pendingProfile, id: 'anthropic-file-compact-v1' }),
    { ...pendingProfile, id: 'anthropic-file-compact-v1' },
  );
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
  assert.deepEqual(NativeProfileSchema.parse({ ...acpProfile, maximumTaskMs: 600000 }), {
    ...acpProfile,
    maximumTaskMs: 600000,
  });
  for (const maximumTaskMs of [300001, 600001])
    assert.equal(NativeProfileSchema.safeParse({ ...acpProfile, maximumTaskMs }).success, false);
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
  const localModel = {
    setupHash: 'a'.repeat(64),
    modelKey: 'local-fixture',
    instanceReference: 'local-instance-1',
    modelSizeBytes: 5_627_044_256,
    artifactSha256: 'b'.repeat(64),
    quantization: 'Q4_K_M',
  };
  const localProfile = {
    id: 'local-file-v1',
    family: 'local',
    displayName: 'Local file proposal',
    sdkVersion: '2.1.0',
    model: 'local-fixture',
    modelBinding: localModel,
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
  assert.deepEqual(NativeProfileSchema.parse(localProfile), localProfile);
  const currentLocalProfile = { ...localProfile, maximumOutputTokens: 4096 };
  assert.deepEqual(NativeProfileSchema.parse(currentLocalProfile), currentLocalProfile);
  assert(
    NativeProfileSchema.safeParse({
      ...localProfile,
      available: false,
      modelBinding: null,
      reason: 'not-configured',
    }).success,
  );
  for (const change of [
    { family: 'openai' },
    { billing: 'included' },
    { sdkVersion: '2.2.0' },
    { model: 'other-model' },
    { modelBinding: null },
    { modelBinding: { ...localModel, instanceReference: 'instance\nother' } },
    { modelBinding: { ...localModel, modelKey: '\ud800' } },
    { modelBinding: { ...localModel, modelSizeBytes: 0 } },
    { modelBinding: { ...localModel, setupHash: 'invalid' } },
    { modelBinding: { ...localModel, quantization: 'other' } },
    { contextLength: 16384 },
    { maximumOutputTokens: 2049 },
    { maximumOutputTokens: 8192 },
    { maximumSubmissions: 2 },
    { available: false, reason: 'available' },
    { reason: 'unbounded-error' },
    { creditPolicies: ['ordinary'] },
    { accountClass: 'pro' },
    { token: 'synthetic-secret' },
    { endpoint: 'ws://127.0.0.1:1234' },
  ])
    assert.equal(NativeProfileSchema.safeParse({ ...localProfile, ...change }).success, false);
  for (const id of ['openai-repository-v1', 'google-acp-v1', 'local-file-v1'])
    assert.equal(NativeProfileSchema.safeParse({ ...historicalProfile, id }).success, false);
  const profiles = [
    historicalProfile,
    pendingProfile,
    { ...pendingProfile, id: 'anthropic-file-compact-v1' },
    googleProfile,
    repositoryProfile,
    acpProfile,
    localProfile,
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
    reason: 'client-unavailable',
    lastObservedAt: null,
  };
  for (const valid of [
    reader,
    { ...reader, available: true, reason: 'available' },
    {
      ...reader,
      reason: 'client-build-mismatch',
      lastAttemptAt: '2026-10-17T00:00:00.000Z',
    },
    { ...reader, reason: 'unsupported-platform' },
    { ...reader, reason: 'native-home-unavailable' },
  ])
    assert.deepEqual(UsageReaderSchema.parse(valid), valid);
  for (const change of [
    { available: true },
    { reason: 'available' },
    { enabled: true },
    { enabled: false },
    { consent: true },
    { authorityRevision: 1 },
    { reason: 'not-enabled' },
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
    nativeConnections: [],
    googleAcpInstall: null,
    nativeProfiles: [],
    nativeRuns: [],
    candidateEvaluations: [],
    combinedRuns: [],
    usageReaders: [],
    googleAcpSetup: null,
  });
  assert.equal(Object.hasOwn(SnapshotSchema.parse(oldSnapshot), 'localSetup'), false);
  const localReceipt = {
    version: 1,
    runtimeVersion: 'fixture-runtime',
    artifactSha256: 'c'.repeat(64),
    artifactSizeBytes: 17,
    quantization: 'fixture-quantization',
    model: { modelKey: 'fixture-model', instanceReference: 'fixture-instance', modelSizeBytes: 17 },
    contextLength: 8192,
    residentLlms: 1,
    embeddingInstances: 0,
    draftModel: '',
  };
  assert.deepEqual(LocalSetupReceiptSchema.parse(localReceipt), localReceipt);
  const localSetup = {
    revision: 1,
    connectionRevision: 1,
    connectorId: 'local-sdk-v1',
    endpoint: 'ws://127.0.0.1:1234',
    setupHash: null,
    connectionHash: 'b'.repeat(64),
    secretConfigured: false,
    operation: null,
    observation: null,
    selection: null,
    generation: 'idle',
    reason: 'connection-required',
  };
  assert.deepEqual(LocalSetupSchema.parse(localSetup), localSetup);
  assert(LocalSetupSchema.safeParse({ ...localSetup, authMode: 'none', connected: true }).success);
  for (const change of [
    { authMode: 'none', secretConfigured: true },
    { authMode: 'token', connected: true },
    { authMode: 'automatic' },
  ])
    assert.equal(LocalSetupSchema.safeParse({ ...localSetup, ...change }).success, false);
  assert.deepEqual(SnapshotSchema.parse({ ...oldSnapshot, localSetup }).localSetup, localSetup);
  assert.equal(SnapshotSchema.parse({ ...oldSnapshot, localSetup: null }).localSetup, null);
  for (const kind of ['input', 'discovery'])
    for (const state of ['intent', 'owned', 'stopping', 'unknown'])
      assert(
        LocalSetupSchema.safeParse({
          ...localSetup,
          operation: { kind, operationId: command.key, state },
        }).success,
      );
  for (const state of ['idle', 'active', 'unknown'])
    assert(LocalSetupSchema.safeParse({ ...localSetup, generation: state }).success);
  assert(
    LocalSetupSchema.safeParse({
      ...localSetup,
      endpoint: null,
      setupHash: null,
      connectionHash: null,
      reason: 'unconfigured',
    }).success,
  );
  for (const extra of [
    { revision: -1 },
    { connectionRevision: -1 },
    { connectorId: 'arbitrary-runtime' },
    { revision: 1.5 },
    { endpoint: null },
    { connectionHash: null },
    { endpoint: null, setupHash: null, connectionHash: null, secretConfigured: true },
    { operation: { kind: 'input', state: 'owned', operationId: null } },
    { operation: { kind: 'input', state: 'idle', operationId: command.key } },
    { operation: { kind: 'input', state: 'unknown', operationId: command.key, group: 123 } },
    { generation: 'recovered' },
    { reason: 'raw SDK diagnostic' },
    { token: 'synthetic-secret' },
    { tokenHash: 'a'.repeat(64) },
    { credential: 'synthetic-secret' },
    { helperPath: '/arbitrary/helper' },
  ])
    assert.equal(LocalSetupSchema.safeParse({ ...localSetup, ...extra }).success, false);
  for (const endpoint of ['ws://127.0.0.1:1', 'ws://127.0.0.1:65535'])
    assert(LocalEndpointSchema.safeParse(endpoint).success);
  for (const endpoint of [
    'ws://localhost:1234',
    'ws://127.1:1234',
    'ws://[::1]:1234',
    'wss://127.0.0.1:1234',
    'ws://127.0.0.1:0',
    'ws://127.0.0.1:01',
    'ws://127.0.0.1:65536',
    'ws://127.0.0.1:1234/',
    'ws://127.0.0.1:1234?token=x',
    'ws://127.0.0.1:1234\n',
  ])
    assert.equal(LocalEndpointSchema.safeParse(endpoint).success, false, endpoint);
  for (const extra of [
    { artifactSizeBytes: 0 },
    { artifactSizeBytes: Number.MAX_SAFE_INTEGER + 1 },
    { residentLlms: -1 },
    { embeddingInstances: 0.5 },
    { contextLength: 0 },
    { runtimeVersion: 'invalid\nversion' },
    { artifactSha256: 'invalid' },
    { model: { ...localReceipt.model, token: 'synthetic-secret' } },
    { token: 'synthetic-secret' },
    { tokenHash: 'a'.repeat(64) },
    { helperPath: '/arbitrary/helper' },
  ])
    assert.equal(LocalSetupReceiptSchema.safeParse({ ...localReceipt, ...extra }).success, false);
  const observedIdentity = {
    modelKey: 'observed-model',
    displayName: 'Observed model',
    format: 'gguf',
    sizeBytes: 17,
    quantization: { name: 'observed quantization', bits: 4 },
    selectedVariant: null,
    metadataHash: 'c'.repeat(64),
  };
  const observedChoice = {
    selectionId: 'd'.repeat(64),
    identity: observedIdentity,
    instanceReference: 'observed-instance',
    contextLength: 8192,
    state: 'loaded-eligible',
    reasons: [],
    qualification: 'unqualified',
  };
  const observation = {
    version: 1,
    runtime: { connectorId: 'local-sdk-v1', version: 'observed-version', build: 1 },
    observationHash: 'e'.repeat(64),
    models: [observedChoice],
    residentLlms: 1,
    embeddingInstances: 0,
  };
  assert.deepEqual(LocalModelObservationSchema.parse(observation), observation);
  assert(
    LocalSetupSchema.safeParse({
      ...localSetup,
      setupHash: null,
      secretConfigured: true,
      observation,
    }).success,
  );
  for (const identity of [
    {
      ...observedIdentity,
      modelKey: 'another-present-model',
      format: 'safetensors',
      quantization: null,
    },
    { ...observedIdentity, format: 'observed-unsupported-format' },
  ])
    assert(
      LocalModelObservationSchema.safeParse({
        ...observation,
        models: [
          { ...observedChoice, identity, state: 'incompatible', reasons: ['unsupported-format'] },
        ],
      }).success,
    );
  for (const choice of [
    {
      ...observedChoice,
      state: 'installed-unloaded',
      instanceReference: null,
      contextLength: null,
    },
    {
      ...observedChoice,
      state: 'incompatible',
      instanceReference: null,
      contextLength: null,
      reasons: ['identity-ambiguous'],
    },
    { ...observedChoice, state: 'incompatible', reasons: ['not-downloaded'] },
  ])
    assert(LocalModelObservationSchema.safeParse({ ...observation, models: [choice] }).success);
  const unloadedChoices = Array.from({ length: 64 }, (_, index) => ({
    ...observedChoice,
    selectionId: index.toString(16).padStart(64, '0'),
    instanceReference: null,
    contextLength: null,
    state: 'installed-unloaded',
  }));
  assert(
    LocalModelObservationSchema.safeParse({
      ...observation,
      models: unloadedChoices,
      residentLlms: 0,
    }).success,
  );
  const eightHandles = unloadedChoices.slice(0, 8).map((choice, index) => ({
    ...choice,
    state: 'incompatible',
    instanceReference: `observed-${index}`,
    contextLength: 8192,
    reasons: ['multiple-resident-models'],
  }));
  assert(
    LocalModelObservationSchema.safeParse({ ...observation, models: eightHandles, residentLlms: 8 })
      .success,
  );
  for (const change of [
    { models: [observedChoice, observedChoice] },
    {
      residentLlms: 2,
      models: Array.from({ length: 2 }, (_, index) => ({
        ...observedChoice,
        selectionId: index.toString(16).padStart(64, '0'),
        state: 'incompatible',
        reasons: ['identity-ambiguous'],
      })),
    },
    {
      models: Array.from({ length: 65 }, (_, index) => ({
        ...observedChoice,
        selectionId: index.toString(16).padStart(64, '0'),
      })),
    },
    {
      models: Array.from({ length: 9 }, (_, index) => ({
        ...observedChoice,
        selectionId: index.toString(16).padStart(64, '0'),
      })),
    },
    { residentLlms: 9 },
    { residentLlms: 0 },
    { residentLlms: 2 },
    { embeddingInstances: 1 },
    { embeddingInstances: 9 },
    { runtime: { ...observation.runtime, build: -1 } },
    { runtime: { ...observation.runtime, executable: '/arbitrary/runtime' } },
    { models: [{ ...observedChoice, identity: { ...observedIdentity, modelKey: 'x\ny' } }] },
    {
      models: [
        { ...observedChoice, identity: { ...observedIdentity, displayName: '界'.repeat(100) } },
      ],
    },
    {
      models: [
        { ...observedChoice, identity: { ...observedIdentity, path: 'private/model.gguf' } },
      ],
    },
    { models: [{ ...observedChoice, qualification: 'qualified' }] },
    { models: [{ ...observedChoice, reasons: ['raw diagnostic'] }] },
    { models: [{ ...observedChoice, reasons: ['busy', 'busy'] }] },
    { models: [{ ...observedChoice, state: 'loaded-eligible', instanceReference: null }] },
    { models: [{ ...observedChoice, contextLength: 32768 }] },
    { models: [{ ...observedChoice, identity: { ...observedIdentity, format: 'unsupported' } }] },
    { models: [{ ...observedChoice, state: 'incompatible', reasons: [] }] },
    { models: [{ ...observedChoice, state: 'installed-unloaded' }] },
    { tokenHash: 'a'.repeat(64) },
  ])
    assert.equal(
      LocalModelObservationSchema.safeParse({ ...observation, ...change }).success,
      false,
    );
  const selectedSetup = {
    ...localSetup,
    setupHash: 'a'.repeat(64),
    observation,
    selection: {
      selectionId: observedChoice.selectionId,
      observationHash: observation.observationHash,
    },
  };
  assert(LocalSetupSchema.safeParse(selectedSetup).success);
  for (const change of [
    { selection: null },
    { observation: null },
    { setupHash: null },
    { selection: { ...selectedSetup.selection, selectionId: 'f'.repeat(64) } },
    { selection: { ...selectedSetup.selection, observationHash: 'f'.repeat(64) } },
  ])
    assert.equal(LocalSetupSchema.safeParse({ ...selectedSetup, ...change }).success, false);
  assert(
    LocalSetupSchema.safeParse({
      ...selectedSetup,
      reason: 'selection-stale',
      selection: { ...selectedSetup.selection, observationHash: 'f'.repeat(64) },
    }).success,
  );
  const observedBinding = {
    version: 2,
    identityKind: 'runtime-metadata',
    setupHash: 'a'.repeat(64),
    connectionHash: localSetup.connectionHash,
    connectionRevision: localSetup.connectionRevision,
    connectorId: 'local-sdk-v1',
    runtimeVersion: 'observed-version',
    runtimeBuild: 1,
    modelKey: observedIdentity.modelKey,
    instanceReference: 'observed-instance',
    modelSizeBytes: 17,
    format: 'gguf',
    metadataHash: observedIdentity.metadataHash,
  };
  assert.deepEqual(LocalModelBindingSchema.parse(localModel), localModel);
  for (const format of ['gguf', 'safetensors'])
    assert.deepEqual(LocalObservedModelBindingSchema.parse({ ...observedBinding, format }), {
      ...observedBinding,
      format,
    });
  assert(
    NativeProfileSchema.safeParse({
      ...localProfile,
      model: observedBinding.modelKey,
      modelBinding: observedBinding,
    }).success,
  );
  for (const extra of [
    { artifactSha256: 'f'.repeat(64) },
    { quantization: 'invented' },
    { identityKind: 'artifact' },
    { connectionRevision: -1 },
    { connectionHash: undefined },
    { format: 'unknown' },
    { runtimeVersion: 'observed\nversion' },
    { token: 'synthetic-secret' },
    { path: 'private/model' },
  ])
    assert.equal(
      LocalModelBindingSchema.safeParse({ ...observedBinding, ...extra }).success,
      false,
    );
  for (const [name, payload] of [
    ['ConfigureLocal', { endpoint: localSetup.endpoint }],
    ['ConfigureLocal', { endpoint: localSetup.endpoint, authMode: 'token' }],
    ['ConfigureLocal', { endpoint: localSetup.endpoint, authMode: 'none' }],
    ['RefreshLocalModels', { consent: 'explicit' }],
    ['SelectLocalModel', { selectionId: 'c'.repeat(64), observationHash: 'd'.repeat(64) }],
    ['BeginLocalConnectionInput', { consent: 'explicit' }],
    ['CancelLocalConnectionInput', { operationId: command.key }],
    ['DisconnectLocal', {}],
  ] as const) {
    const request = { ...command, command: name, payload };
    assert.deepEqual(CommandSchema.parse(request), request);
    assert.equal(hashCanonical(CommandSchema.parse(request)), hashCanonical(request));
    for (const extra of [
      { token: 'synthetic-secret' },
      { tokenHash: 'a'.repeat(64) },
      { credential: 'synthetic-secret' },
      { helperPath: '/arbitrary/helper' },
      { setupRevision: 1 },
    ])
      assert.equal(
        CommandSchema.safeParse({ ...request, payload: { ...payload, ...extra } }).success,
        false,
      );
    for (const expectedRevision of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      assert.equal(CommandSchema.safeParse({ ...request, expectedRevision }).success, false);
    assert.equal(CommandSchema.safeParse({ ...request, key: 'arbitrary-key' }).success, false);
  }
  for (const [name, payload] of [
    ['ConfigureLocal', { endpoint: localSetup.endpoint, receipt: localReceipt }],
    ['ConfigureLocal', { endpoint: localSetup.endpoint, authMode: 'automatic' }],
    ['ConfigureLocal', { endpoint: 'ws://0.0.0.0:1234', authMode: 'none' }],
    ['RefreshLocalModels', { consent: 'saved' }],
    ['SelectLocalModel', { selectionId: 'not-an-id', observationHash: 'd'.repeat(64) }],
    ['SelectLocalModel', { selectionId: 'c'.repeat(64) }],
    [
      'SelectLocalModel',
      { selectionId: 'c'.repeat(64), observationHash: 'd'.repeat(64), path: 'model.gguf' },
    ],
    ['BeginLocalConnectionInput', { consent: 'saved' }],
    ['BeginLocalConnectionInput', { consent: 'explicit', operationId: command.key }],
    ['BeginLocalConnectionInput', { consent: 'explicit', nonce: 'a'.repeat(64) }],
    ['CancelLocalConnectionInput', {}],
    ['CancelLocalConnectionInput', { operationId: 'arbitrary-key' }],
  ] as const)
    assert.equal(CommandSchema.safeParse({ ...command, command: name, payload }).success, false);
  assert.equal(
    SnapshotSchema.safeParse({ ...oldSnapshot, usageReaders: [reader, reader] }).success,
    false,
  );
  const observe = {
    ...command,
    command: 'ObserveUsage',
    payload: { family: 'google' },
  };
  assert.deepEqual(CommandSchema.parse(observe), observe);
  assert(CommandSchema.safeParse({ ...observe, payload: { family: 'openai' } }).success);
  assert.equal(hashCanonical(CommandSchema.parse(observe)), hashCanonical(observe));
  const refresh = { ...command, command: 'RefreshAnthropicUsage', payload: {} };
  assert.deepEqual(CommandSchema.parse(refresh), refresh);
  assert(
    CommandSchema.safeParse({
      ...refresh,
      payload: { trust: { nativeTrust: 'accepted', scopeHash: 'a'.repeat(64) } },
    }).success,
  );
  for (const payload of [
    { trust: true },
    { trust: { nativeTrust: 'accepted' } },
    { trust: { nativeTrust: 'accepted', scopeHash: 'a'.repeat(64), generation: true } },
    { existingCredits: true },
    { family: 'anthropic' },
  ])
    assert.equal(CommandSchema.safeParse({ ...refresh, payload }).success, false);
  assert(
    CommandSchema.safeParse({
      ...command,
      command: 'StopAnthropicUsage',
      payload: { operationId: command.key },
    }).success,
  );

  for (const payload of [
    { family: 'google', consent: true },
    { family: 'google', consent: false },
    { family: 'google', consent: 'true' },
    { family: 'google', consent: null },
    { family: 'google', enabled: true },
    { family: 'google', authorityRevision: 1 },
    { family: 'anthropic' },
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
  assert.equal(
    NativeRunSchema.safeParse({
      ...historicalRun,
      quotaRetry: {
        available: false,
        mode: 'manual',
        resetsAt: '2026-10-19T01:00:00.000Z',
      },
    }).success,
    false,
  );
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
  const localRun = {
    ...historicalRun,
    profileId: localProfile.id,
    target: { path: 'net.mjs', baseHash: 'a'.repeat(64), bytes: 1 },
    localModel,
  };
  assert.deepEqual(NativeRunSchema.parse(localRun), localRun);
  assert.deepEqual(NativeRunSchema.parse({ ...localRun, localModel: observedBinding }), {
    ...localRun,
    localModel: observedBinding,
  });
  for (const change of [
    { localModel: undefined },
    { target: undefined },
    { billingAttestation: attestation },
    { permissionMode: 'request-review' },
    { repository: repositoryRun.repository, execution },
    { acp: selection },
    { profileId: historicalProfile.id },
    { token: 'synthetic-secret' },
  ])
    assert.equal(NativeRunSchema.safeParse({ ...localRun, ...change }).success, false);
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
  assert.deepEqual(RuntimeManifestSchema.parse(manifest), manifest);
  assert.deepEqual(RuntimeManifestSchema.parse({ ...manifest, mode: 'workspace' }), {
    ...manifest,
    mode: 'workspace',
  });
  const localInput = {
    sha256: 'b'.repeat(64),
    sourceHash: 'c'.repeat(64),
    target: 'darwin-arm64',
    minOS: '13.5.0',
  };
  assert.deepEqual(RuntimeManifestSchema.parse({ ...manifest, localInput }), {
    ...manifest,
    localInput,
  });
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
    { ...manifest, localInput: null },
    { ...manifest, localInput: {} },
    ...[
      { sha256: 'invalid' },
      { sourceHash: 'invalid' },
      { target: 'darwin-x64' },
      { minOS: '13.0.0' },
      { path: '/arbitrary/helper' },
      { executable: '/arbitrary/helper' },
      { model: 'arbitrary' },
      { secret: 'synthetic-secret' },
      { token: 'synthetic-secret' },
    ].map((input) => ({ ...manifest, localInput: { ...localInput, ...input } })),
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
  const pythonChecks = {
    ...evaluation,
    payload: {
      ...evaluation.payload,
      checkRecipeId: 'project-python-unittest-v1',
      testFiles: ['tests/test_core.py', 'tests/test_io.py'],
    },
  };
  assert.ok(CommandSchema.safeParse(pythonChecks).success);
  assert.equal(
    CommandSchema.safeParse({
      ...pythonChecks,
      payload: { ...pythonChecks.payload, testFiles: ['tests/test_core.mjs'] },
    }).success,
    false,
  );
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
  const pythonPreview = {
    ...preview,
    recipe: 'project-python-unittest-v1',
    testFiles: [{ path: 'tests/test_core.py', hash: 'a'.repeat(64), bytes: 1, mode: '100644' }],
  };
  assert.deepEqual(CandidateEvaluationPreviewSchema.parse(pythonPreview), pythonPreview);
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
    maximumMinutes: 10,
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
    { ...verificationPreview, verification: { ...verification, maximumMinutes: 5 } },
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
  const localPreparation = {
    ...filePreparation,
    payload: {
      taskId: job.taskId,
      profileId: localProfile.id,
      targetPath: 'net.mjs',
      policy: filePreparation.payload.policy,
      consent: 'explicit',
    },
  };
  for (const consent of ['explicit', 'saved']) {
    const request = {
      ...localPreparation,
      payload: { ...localPreparation.payload, consent },
    };
    assert.deepEqual(CommandSchema.parse(request), request);
  }
  for (const change of [
    { creditPolicy: 'ordinary' },
    { billingAttestation: attestation },
    { permissionMode: 'request-review' },
    { handoffTargets: [{ profileId: 'openai-file-v1' }] },
    { proofId: selection.proofId, modelId: selection.modelId, thoughtLevelId: null },
    { localModel },
    { targetPath: undefined },
    { targetPath: '../source' },
    { token: 'synthetic-secret' },
    { endpoint: 'ws://127.0.0.1:1234' },
    { executable: '/caller/binary' },
  ])
    assert.equal(
      CommandSchema.safeParse({
        ...localPreparation,
        payload: { ...localPreparation.payload, ...change },
      }).success,
      false,
    );
  assert.equal(
    CommandSchema.safeParse({
      ...filePreparation,
      payload: { ...filePreparation.payload, profileId: localProfile.id },
    }).success,
    false,
  );
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
  assert.equal(Object.hasOwn(CommandSchema.parse(acpPreparation).payload, 'maximumTaskMs'), false);
  assert.equal(Object.hasOwn(CommandSchema.parse(acpPreparation).payload, 'contextLines'), false);
  for (const contextLines of [
    { start: 1, end: 1 },
    { start: 2, end: 20 },
  ]) {
    const request = { ...acpPreparation, payload: { ...acpPreparation.payload, contextLines } };
    assert.deepEqual(CommandSchema.parse(request), request);
  }
  for (const contextLines of [
    { start: 0, end: 1 },
    { start: 2, end: 1 },
    { start: 1.5, end: 2 },
    { start: 1, end: Number.MAX_SAFE_INTEGER + 1 },
    { start: 1, end: 2, extra: true },
  ])
    assert.equal(
      CommandSchema.safeParse({
        ...acpPreparation,
        payload: { ...acpPreparation.payload, contextLines },
      }).success,
      false,
    );
  for (const request of [filePreparation, localPreparation])
    assert.equal(
      CommandSchema.safeParse({
        ...request,
        payload: { ...request.payload, contextLines: { start: 1, end: 1 } },
      }).success,
      false,
    );

  for (const maximumTaskMs of [300000, 600000]) {
    const request = { ...acpPreparation, payload: { ...acpPreparation.payload, maximumTaskMs } };
    assert.deepEqual(CommandSchema.parse(request), request);
  }
  for (const maximumTaskMs of [300001, 600001])
    assert.equal(
      CommandSchema.safeParse({
        ...acpPreparation,
        payload: { ...acpPreparation.payload, maximumTaskMs },
      }).success,
      false,
    );
  assert.equal(
    CommandSchema.safeParse({
      ...filePreparation,
      payload: { ...filePreparation.payload, maximumTaskMs: 600000 },
    }).success,
    false,
  );
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
    [{ profileId: 'local-file-v1', creditPolicy: 'ordinary' }],
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
  assert.equal(NativeRunSchema.safeParse({ ...localRun, handoff: handoffPreview }).success, false);
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
  const usageObservation = {
    routeId: `rte_${suffix}`,
    windowId: 'weekly',
    kind: 'weekly',
    remaining: { value: 80, unit: 'percent' },
    resetsAt: null,
    observedAt: '2026-10-15T17:00:00.000Z',
    source: 'fixture',
    confidence: 'reported',
  };
  assert.deepEqual(ObservationSchema.parse(usageObservation), usageObservation);
  for (const semantics of [
    { scope: 'provider', periodSeconds: 604800 },
    { scope: 'provider', periodSeconds: 18000 },
    { scope: 'model' },
    { scope: 'pool', periodSeconds: 1 },
    { scope: 'pool', periodSeconds: 31536000 },
  ])
    assert.deepEqual(ObservationSchema.parse({ ...usageObservation, semantics }), {
      ...usageObservation,
      semantics,
    });
  for (const semantics of [
    null,
    {},
    { scope: 'account' },
    { scope: 'provider', periodSeconds: 0 },
    { scope: 'provider', periodSeconds: -1 },
    { scope: 'provider', periodSeconds: 0.5 },
    { scope: 'provider', periodSeconds: 31536001 },
    { scope: 'provider', periodSeconds: Infinity },
    { scope: 'provider', periodSeconds: '18000' },
    { scope: 'provider', model: 'unobserved' },
  ])
    assert.equal(ObservationSchema.safeParse({ ...usageObservation, semantics }).success, false);
  assert.equal(
    ObservationSchema.safeParse({ ...usageObservation, remaining: { value: 101, unit: 'percent' } })
      .success,
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

test('a usage window limits only the models its scope and id name', () => {
  // Ids follow the shapes providers report: a vendor prefix, a model name, a length.
  type Scope = 'provider' | 'model' | 'pool';
  const rows: [string, string | null, boolean, string[]?, Scope?][] = [
    ['acme-deep-wtu-weekly', 'acme-3.8-quick', false],
    ['acme-deep-wtu-weekly', 'acme-deep-2', true],
    ['acme-deep-wtu-weekly', null, true],
    ['acme-weekly', 'acme-3.8-quick', true],
    ['3p-5h', 'acme-3.8-quick', true],
    ['weekly-tale', 'mid-4-5', false],
    ['weekly-tale', 'Tale-1', true],
    ['weekly', 'mid-4-5', true],
    ['five-hour', 'mid-4-5', true],
    ['seven_day', 'mid-4-5', true],
    // Every window the family reports carries the client's bucket name, so it names no model.
    ['client:primary', 'large-1', true, ['client:primary', 'client:secondary']],
    // A lone window shares every token with itself, so it names no bucket. Reported alone, a
    // window for one model still limits only that model, with its scope given or not.
    ['weekly-tale', 'mid-4-5', false, ['weekly-tale'], 'model'],
    ['weekly-tale', 'mid-4-5', false, ['weekly-tale']],
    // A provider or pool scope limits every model, whatever the id carries.
    ['client:primary', 'large-1', true, ['client:primary'], 'provider'],
    ['acme-deep-weekly', 'acme-3.8-quick', true, ['acme-deep-weekly'], 'pool'],
  ];
  for (const [windowId, model, applies, reported, scope] of rows)
    assert.equal(
      windowAppliesTo({ windowId, scope }, model, reported),
      applies,
      `${windowId} ${scope ?? 'unscoped'} on ${model}`,
    );
});
