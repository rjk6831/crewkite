import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashCanonical } from './hash.ts';
import {
  CheckResultSchema,
  CommandResultSchema,
  CommandSchema,
  CursorSchema,
  canonicalJson,
  FakeWorkerEventSchema,
  FakeWorkerInputSchema,
  GrantSchema,
  MinorAmountSchema,
  ObservationSchema,
  PolicySchema,
  RemainingBudgetsSchema,
  ReviewJobSchema,
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
