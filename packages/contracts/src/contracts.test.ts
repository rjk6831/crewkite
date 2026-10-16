import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashCanonical, sealHandoff } from './hash.ts';
import {
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
  GrantSchema,
  MinorAmountSchema,
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
  SourceDetailsSchema,
  SourceSchema,
  TransportMessageSchema,
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
