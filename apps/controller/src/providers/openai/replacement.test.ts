import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { hashCanonical, sealHandoff } from '@crewkite/contracts/hash';
import { verificationGuidance } from '../../evidence/toolchain-definition.ts';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import type { OpenAiUsage } from './discovery.ts';
import { startNativeTask } from './native-discovery.ts';
import { resolveRepositoryProfile } from './profile.ts';
import { ReplacementTranscript, replacementPlan, startReplacement } from './replacement.ts';
import {
  configuration,
  fixture,
  replies,
  repositoryFixture,
  running,
  threadResult,
} from './replacement-fixture.ts';
import {
  type RepositoryActivity,
  RepositoryTranscript,
  repositoryPlan,
  startRepository,
} from './repository.ts';
import { ReviewTranscript, repositoryReviewBudget, reviewPlan, startReview } from './review.ts';

const repositoryLimits = {
  deadlineMs: 600_000,
  paths: [] as string[],
  checks: [] as string[],
  frozen: [] as string[],
  review: repositoryReviewBudget,
};

const original = 'export function netMinor() { throw new Error(); }\n';
const plan = (directory: string, path = 'net.mjs') =>
  replacementPlan({
    attemptId: 'att_01M51M322B2AEBXD9MA74CBCFM',
    model: 'gpt-6.1-sol',
    effort: 'low',
    directory,
    path,
    original,
    baseHash: createHash('sha256').update(original).digest('hex'),
    criteria: ['Return the bounded replacement.'],
  });
const threadSettings = (directory: string) => ({
  model: 'gpt-6.1-sol',
  modelProvider: 'openai',
  effort: 'low',
  serviceTier: 'default',
  cwd: directory,
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandboxPolicy: { type: 'readOnly', networkAccess: false },
});
const threadNotices = (directory: string) => [
  {
    method: 'thread/settings/updated',
    params: { threadId: 'thread-1', threadSettings: threadSettings(directory) },
  },
  {
    method: 'thread/name/updated',
    params: { threadId: 'thread-1', threadName: 'private thread name' },
  },
  {
    method: 'thread/readState/changed',
    params: {
      threadId: 'thread-1',
      readState: { revision: 'private revision', firstUnread: null },
    },
  },
  { method: 'thread/queue/changed', params: { threadId: 'thread-1' } },
  { method: 'deprecationNotice', params: { summary: 'private guidance' } },
  {
    method: 'configWarning',
    params: {
      summary: 'private guidance',
      details: 'private details',
      path: '/private/config.toml',
      range: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
    },
  },
];
const methodHash = (value: string) => createHash('sha256').update(value).digest('hex');
// Progress and display notices nothing consumes. The census keeps only their method hashes.
const ignoredNotices = (identity: { threadId: string; turnId: string }) => [
  {
    method: 'item/commandExecution/outputDelta',
    params: { ...identity, itemId: 'command-1', delta: 'private-notice-canary' },
  },
  { method: 'modelProvider/authRecoveryStarted', params: identity },
  {
    method: 'turn/moderationMetadata',
    params: { ...identity, metadata: { note: 'private-notice-canary' } },
  },
  { method: 'model/safetyBuffering/updated', params: identity },
  { method: 'private-notice-canary', params: { text: 'private-notice-canary' } },
];
const edit = (directory: string, path = 'net.mjs') => ({
  version: 1,
  attemptId: plan(directory).attemptId,
  path,
  baseHash: plan(directory, path).baseHash,
  content: 'export function netMinor(a, b) { return Math.max(0, a - b); }\n',
});
const output = (directory: string, mode = 'success', path = 'net.mjs', structured?: unknown) => {
  const value = edit(directory, path);
  if (mode === 'wrong-attempt') value.attemptId = 'att_01M51M322B2AEBXD9MA74CBCFN';
  if (mode === 'wrong-path') value.path = '../net.mjs';
  if (mode === 'different-path') value.path = 'docs/other.md';
  if (mode === 'nul-content') value.content = 'text\0tail';
  if (mode === 'byte-limit') value.content = 'é'.repeat(32768);
  if (mode === 'wrong-hash') value.baseHash = '0'.repeat(64);
  if (mode === 'oversized') value.content = 'é'.repeat(32769);
  if (mode === 'surrogate') value.content = '\ud800';
  const item = {
    type: 'agentMessage',
    id: 'message-1',
    text: JSON.stringify(structured ?? value),
    phase: 'final_answer',
  };
  const identity = {
    threadId: mode === 'wrong-thread' ? 'other' : 'thread-1',
    turnId: mode === 'wrong-turn' ? 'other' : 'turn-1',
  };
  const messages: unknown[] = [
    { method: 'turn/started', params: { threadId: 'thread-1', turn: running } },
    {
      method: 'item/started',
      params: { ...identity, item: { ...item, text: '' }, startedAtMs: 1 },
    },
    {
      method: 'item/agentMessage/delta',
      params: { ...identity, itemId: 'message-1', delta: item.text },
    },
    { method: 'item/completed', params: { ...identity, item, completedAtMs: 2 } },
    {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { ...running, status: mode === 'failed' ? 'failed' : 'completed' },
      },
    },
  ];
  if (mode === 'approval')
    messages.splice(2, 0, {
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: identity,
    });
  if (mode === 'rerouted')
    messages.splice(2, 0, {
      method: 'model/rerouted',
      params: { ...identity, fromModel: 'gpt-6.1-sol', toModel: 'other', reason: 'unavailable' },
    });
  if (mode === 'reasoning-retry') {
    const reasoning = { id: 'reasoning-1', type: 'reasoning', summary: [], content: [] };
    messages.splice(
      1,
      0,
      {
        method: 'error',
        params: { ...identity, willRetry: true, error: { message: 'private retry detail' } },
      },
      { method: 'item/started', params: { ...identity, item: reasoning, startedAtMs: 1 } },
      {
        method: 'item/reasoning/summaryPartAdded',
        params: { ...identity, itemId: reasoning.id, summaryIndex: 0 },
      },
      {
        method: 'item/reasoning/summaryTextDelta',
        params: { ...identity, itemId: reasoning.id, summaryIndex: 0, delta: 'private reasoning' },
      },
      { method: 'item/completed', params: { ...identity, item: reasoning, completedAtMs: 2 } },
    );
  }
  if (mode === 'ignored-notices') messages.splice(2, 0, ...ignoredNotices(identity));
  if (mode === 'late-progress')
    messages.push(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          ...identity,
          tokenUsage: { total: { totalTokens: 9 }, last: { totalTokens: 9 } },
        },
      },
      ignoredNotices(identity)[0],
    );
  if (mode === 'late-completion') messages.push(messages.at(-1));
  if (mode === 'late-error')
    messages.push({
      method: 'error',
      params: { ...identity, willRetry: true, error: { message: 'private retry detail' } },
    });
  if (mode === 'duplicate') messages.splice(4, 0, messages[3]);
  if (mode === 'summary') item.text = 'The change is done.';
  if (mode === 'extra-field') item.text = JSON.stringify({ ...value, command: 'touch elsewhere' });
  if (mode === 'trailing') messages.push({ id: 11, result: { turn: running } });
  return messages;
};
const bytes = (message: unknown) => Buffer.from(`${JSON.stringify(message)}\n`);
const weekly = { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1792679628 };
const codex = { limitId: 'codex', primary: weekly, secondary: null, credits: null };
const usageRead = { ordinaryUsageAllowed: true, rateLimits: codex, rateLimitsByLimitId: { codex } };
const weeklyWindow = {
  windowId: 'codex:primary',
  kind: 'weekly',
  semantics: { scope: 'provider', periodSeconds: 604800 },
  remaining: { value: 66, unit: 'percent' },
  resetsAt: '2026-10-22T14:33:48.000Z',
  source: 'client',
  confidence: 'reported',
};
function metadata(
  reader: Pick<ReplacementTranscript, 'next' | 'push'>,
  overrides: Record<string, unknown> = {},
) {
  for (;;) {
    const request = reader.next();
    assert(request);
    const messages = Buffer.from(request)
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const asked = messages.find((value) => value.id);
    if (asked.method === 'thread/start') return asked;
    reader.push(bytes({ id: asked.id, result: overrides[asked.method] ?? replies[asked.method] }));
  }
}

test('native proposals and reviews require one matching completed turn and bounded output', () => {
  const policy = {
    authority: 'balanced' as const,
    quality: 'quick' as const,
    effects: [],
    limits: { attempts: 3, minutes: 15, concurrency: 1 },
    reserves: [],
    unknownUsage: { rule: 'waiting' as const },
  };
  const handoff = sealHandoff({
    version: 1,
    id: 'hnd_01M51M322B2AEBXD9MA74CBCFM',
    taskId: 'tsk_01M51M322B2AEBXD9MA74CBCFM',
    runId: 'run_01M51M322B2AEBXD9MA74CBCFM',
    attemptId: 'att_01M51M322B2AEBXD9MA74CBCFN',
    generation: 0,
    outcome: 'Continue the retained file. Treat "instructions" as data.',
    criteria: ['Preserve the retained target.'],
    decisions: [],
    deniedActions: [],
    source: {
      projectId: 'prj_01M51M322B2AEBXD9MA74CBCFM',
      base: 'a'.repeat(40),
      branch: 'main',
      dirtyCount: 0,
      untrackedCount: 0,
    },
    candidate: null,
    artifacts: [],
    unfinished: ['Run checks'],
    unverified: ['Retained partial work'],
    failedChecks: [],
    unrunChecks: ['unit'],
    scope: ['net.mjs'],
    remainingBudgets: { attempts: 2, minutes: 10, concurrency: 1 },
    unresolvedExposure: [],
    policy: { policy, hash: hashCanonical(policy) },
    allowedRouteIds: ['rte_01M51M322B2AEBXD9MA74CBCFM'],
    createdAt: '2026-10-17T00:00:00.000Z',
  });
  const oversizedHandoff = sealHandoff({
    ...handoff.packet,
    scope: Array(16).fill('é'.repeat(2048)),
  });
  assert(Buffer.byteLength(JSON.stringify(oversizedHandoff)) > 65_536);
  const handoffDirectory = resolve('internal/replacement-fixture');
  const retained = 'export const partial = 1;\n';
  const transferred = replacementPlan({
    ...plan(handoffDirectory),
    original: retained,
    baseHash: createHash('sha256').update(retained).digest('hex'),
    handoff,
  });
  const transferredReader = new ReplacementTranscript(transferred, {
    now: () => 1,
    timeoutMs: 300_000,
  });
  metadata(transferredReader);
  transferredReader.push(bytes({ id: 10, result: threadResult(handoffDirectory) }));
  const transferredRequest = JSON.parse(
    Buffer.from(transferredReader.next() as Uint8Array).toString(),
  );
  const transferredInput = JSON.parse(
    transferredRequest.params.input[0].text.split('\n').slice(1).join('\n'),
  );
  assert.deepEqual(transferredInput.handoff, handoff);
  assert.equal(transferredInput.original, retained);
  assert.equal(transferredInput.baseHash, transferred.baseHash);
  assert.equal(
    transferredRequest.params.outputSchema.properties.baseHash.const,
    transferred.baseHash,
  );
  transferredReader.push(bytes({ id: 11, result: { turn: running } }));
  for (const message of output(handoffDirectory, 'success', 'net.mjs', {
    ...edit(handoffDirectory),
    baseHash: transferred.baseHash,
  }))
    transferredReader.push(bytes(message));
  assert.equal(transferredReader.finish().replacement.baseHash, transferred.baseHash);
  for (const invalid of [
    { ...handoff, checksum: '0'.repeat(64) },
    { ...handoff, packet: { ...handoff.packet, private: 'unknown' } },
    oversizedHandoff,
  ])
    assert.throws(() => replacementPlan({ ...plan(handoffDirectory), handoff: invalid }));
  for (const mode of [
    'success',
    'fragmented',
    'reasoning-retry',
    'thread-notices',
    'ignored-notices',
    'late-progress',
    'nested-path',
    'unicode-path',
    'byte-limit',
    'late-completion',
    'late-error',
    'different-path',
    'nul-content',
    'wrong-attempt',
    'wrong-path',
    'wrong-hash',
    'oversized',
    'surrogate',
    'wrong-thread',
    'wrong-turn',
    'failed',
    'approval',
    'rerouted',
    'duplicate',
    'summary',
    'extra-field',
    'trailing',
    'partial',
  ]) {
    const directory = resolve('internal/replacement-fixture');
    const path =
      mode === 'nested-path'
        ? 'docs/providers.md'
        : mode === 'unicode-path'
          ? 'docs/案内.md'
          : 'net.mjs';
    const reader = new ReplacementTranscript(plan(directory, path), {
      now: () => 1,
      timeoutMs: 300_000,
    });
    const thread = metadata(reader);
    assert.equal(thread.params.sandbox, 'read-only');
    assert.equal(reader.submitted, false);
    reader.push(bytes({ id: 10, result: threadResult(directory) }));
    const request = JSON.parse(Buffer.from(reader.next() as Uint8Array).toString());
    assert.equal(request.method, 'turn/start');
    assert.equal(request.params.outputSchema.properties.path.const, path);
    assert.equal(
      JSON.parse(request.params.input[0].text.split('\n').slice(1).join('\n')).path,
      path,
    );
    assert.equal(request.params.effort, 'low');
    assert.equal(request.params.serviceTier, 'default');
    assert.equal(request.params.outputSchema.properties.attemptId.const, plan(directory).attemptId);
    assert.equal(reader.submitted, true);
    if (mode === 'thread-notices') {
      for (const notice of threadNotices(directory)) reader.push(bytes(notice));
      assert.equal(reader.complete, false, 'thread metadata cannot complete a turn');
    }
    reader.push(bytes({ id: 11, result: { turn: running } }));
    const perform = () => {
      for (const message of output(directory, mode, path)) {
        const chunk = bytes(message);
        if (mode === 'fragmented') for (const byte of chunk) reader.push(new Uint8Array([byte]));
        else reader.push(chunk);
      }
      if (mode === 'partial') reader.push(Buffer.from('{'));
      return reader.finish();
    };
    if (
      mode === 'success' ||
      mode === 'fragmented' ||
      mode === 'reasoning-retry' ||
      mode === 'thread-notices' ||
      mode === 'ignored-notices' ||
      mode === 'late-progress' ||
      mode === 'nested-path' ||
      mode === 'unicode-path' ||
      mode === 'byte-limit'
    ) {
      const result = perform();
      assert.deepEqual(result.replacement, {
        ...edit(directory, path),
        ...(mode === 'byte-limit' ? { content: 'é'.repeat(32768) } : {}),
      });
      assert.equal(result.qualified, false);
      assert.equal(Object.hasOwn(result, 'modelChoices'), false);
      assert.equal(result.observedRetries, mode === 'reasoning-retry' ? 1 : 0);
      assert(!JSON.stringify(result).includes('private-data'));
      assert.equal(reader.next(), null);
      if (mode === 'late-progress') assert.equal(result.contextUsage?.usedTokens, 9);
      if (mode === 'ignored-notices' || mode === 'late-progress')
        assert.deepEqual(
          reader.ignoredNotifications,
          Object.fromEntries(
            ignoredNotices({ threadId: 'thread-1', turnId: 'turn-1' })
              .slice(0, mode === 'late-progress' ? 1 : undefined)
              .map(({ method }) => [methodHash(method), 1]),
          ),
        );
    } else assert.throws(perform, mode);
  }
  const directory = resolve('internal/replacement-fixture');
  for (const notice of [
    { method: 'thread/name/updated', params: { threadId: 'foreign', threadName: null } },
    { method: 'thread/queue/changed', params: { threadId: 'foreign' } },
    { method: 'thread/readState/changed', params: { threadId: 'thread-1' } },
    { method: 'deprecationNotice', params: { details: 'missing summary' } },
    { method: 'configWarning', params: { summary: 'guidance', range: { start: null } } },
    {
      method: 'thread/environment/connected',
      params: { threadId: 'thread-1', environmentId: 'remote' },
    },
    {
      method: 'thread/environment/disconnected',
      params: { threadId: 'thread-1', environmentId: 'local' },
    },
    {
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'thread-1', name: 'private server', status: 'starting' },
    },
    { method: 'account/updated', params: { authMode: 'apikey', planType: null } },
    {
      method: 'thread/settings/updated',
      params: { threadId: 'foreign', threadSettings: threadSettings(directory) },
    },
    {
      method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: { ...threadSettings(directory), model: 'other' },
      },
    },
    {
      method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: { ...threadSettings(directory), effort: undefined },
      },
    },
    {
      method: 'thread/settings/updated',
      params: {
        threadId: 'thread-1',
        threadSettings: {
          ...threadSettings(directory),
          sandboxPolicy: { type: 'readOnly', networkAccess: true },
        },
      },
    },
  ]) {
    const rejected = new ReplacementTranscript(plan(directory), {
      now: () => 1,
      timeoutMs: 300_000,
    });
    metadata(rejected);
    rejected.push(bytes({ id: 10, result: threadResult(directory) }));
    rejected.next();
    assert.throws(() => rejected.push(bytes(notice)));
    assert.equal(rejected.complete, false);
    assert.equal(
      rejected.diagnostic?.method,
      /^(thread\/environment|mcpServer|account)\//.test(notice.method) ? 'other' : notice.method,
    );
  }
  const canary = 'private-diagnostic-canary';
  for (const row of [
    {
      frame: {
        id: 11,
        error: {
          code: -32602,
          message: `Unsupported outputSchema ${canary}`,
          data: { [canary]: canary },
        },
      },
      rpcField: 'outputSchema',
      envelope: 'error',
      cause: 'rpc-error',
      code: -32602,
    },
    {
      frame: { id: 11, error: { code: canary, message: canary } },
      envelope: 'error',
      cause: 'rpc-error',
      code: null,
    },
    {
      frame: { id: 11, result: { turn: { ...running, id: canary, status: canary } } },
      envelope: 'response',
      cause: 'validation',
      code: null,
      field: 'status',
    },
    {
      frame: {
        method: 'thread/closed',
        params: {
          threadId: 'thread-1',
          turnId: canary,
          account: canary,
          text: canary,
          reasoning: canary,
        },
      },
      envelope: 'notification',
      cause: 'unsupported',
      code: null,
    },
    {
      frame: { id: 11, result: { turn: running }, [canary]: canary },
      envelope: 'response',
      cause: 'validation',
      code: null,
    },
    {
      frame: { method: canary.repeat(20), params: { text: canary } },
      envelope: 'notification',
      cause: 'validation',
      code: null,
    },
    {
      frame: { id: 12, result: { text: canary } },
      envelope: 'response',
      cause: 'correlation',
      code: null,
    },
  ]) {
    const diagnostic = new ReplacementTranscript(plan(directory), {
      now: () => 1,
      timeoutMs: 300_000,
    });
    metadata(diagnostic);
    diagnostic.push(bytes({ id: 10, result: threadResult(directory) }));
    diagnostic.next();
    const frame = bytes(row.frame);
    diagnostic.push(frame.subarray(0, 3));
    assert.throws(() => diagnostic.push(frame.subarray(3)));
    const first = diagnostic.diagnostic;
    assert(first && Object.isFrozen(first));
    assert.equal(first.stage, 'turn');
    assert.equal(first.cause, row.cause);
    assert.equal(first.rpcCode, row.code);
    assert.equal(first.rpcField, 'rpcField' in row ? row.rpcField : null);
    assert.equal(
      first.methodHash,
      typeof row.frame.method === 'string' && row.frame.method.length <= 200
        ? createHash('sha256').update(row.frame.method).digest('hex')
        : null,
    );
    if ('field' in row) assert.equal(first.field, row.field);
    assert.equal(diagnostic.lastEnvelope, row.envelope);
    assert.throws(() => diagnostic.push(bytes({ id: 11, result: { turn: running } })));
    assert.equal(diagnostic.diagnostic, first, 'the first writer refusal remains authoritative');
    assert(
      !JSON.stringify({
        diagnostic: first,
        lastEnvelope: diagnostic.lastEnvelope,
        refusedEnvelope: diagnostic.refusedEnvelope,
        pendingRequest: diagnostic.pendingRequest,
        notifications: diagnostic.notifications,
      }).includes(canary),
    );
  }
  const malformed = new ReplacementTranscript(plan(directory), {
    now: () => 1,
    timeoutMs: 300_000,
  });
  metadata(malformed);
  malformed.push(bytes({ id: 10, result: threadResult(directory) }));
  malformed.next();
  assert.throws(() => malformed.push(Buffer.from(`{"${canary}":\n`)));
  assert.equal(malformed.diagnostic?.cause, 'invalid-json');
  assert.equal(malformed.diagnostic?.methodHash, null);
  assert.equal(malformed.lastEnvelope, 'invalid');
  assert(
    !JSON.stringify({
      diagnostic: malformed.diagnostic,
      refusedEnvelope: malformed.refusedEnvelope,
    }).includes(canary),
  );
  const available = { limitId: 'codex', credits: { hasCredits: true, unlimited: false } };
  for (const row of [
    { ordinaryUsageAllowed: true, allowed: true },
    { ordinaryUsageAllowed: false, allowed: false },
    { ordinaryUsageAllowed: undefined, allowed: false },
    { policy: 'existing-credits', ordinaryUsageAllowed: true, rateLimits: {}, allowed: true },
    { policy: 'existing-credits', ordinaryUsageAllowed: false, allowed: true },
    { policy: 'existing-credits', ordinaryUsageAllowed: null, allowed: false },
    { policy: 'existing-credits', ordinaryUsageAllowed: undefined, allowed: false },
    ...[
      { credits: null },
      { credits: { hasCredits: false, unlimited: false } },
      { limitId: null },
      { limitId: 'other' },
      { spendControlReached: true },
      ...[
        'workspace_owner_credits_depleted',
        'workspace_member_credits_depleted',
        'workspace_owner_usage_limit_reached',
        'workspace_member_usage_limit_reached',
      ].map((rateLimitReachedType) => ({ rateLimitReachedType })),
    ].map((override) => ({
      policy: 'existing-credits',
      ordinaryUsageAllowed: false,
      rateLimits: { ...available, ...override },
      allowed: false,
    })),
    ...[
      { balance: null },
      { balance: '1234.5678900000' },
      { unlimited: true, hasCredits: false },
    ].map((override) => ({
      policy: 'existing-credits',
      ordinaryUsageAllowed: false,
      rateLimits: { ...available, credits: { ...available.credits, ...override } },
      allowed: true,
    })),
    ...[
      { codex: { ...available, limitId: null } },
      { codex: { ...available, rateLimitReachedType: 'rate_limit_reached' } },
    ].map((rateLimitsByLimitId) => ({
      policy: 'existing-credits',
      ordinaryUsageAllowed: false,
      rateLimits: {},
      rateLimitsByLimitId,
      allowed: true,
    })),
    ...[
      {},
      { other: available },
      { codex: { ...available, limitId: 'other' } },
      { codex: { ...available, spendControlReached: true } },
      { codex: { ...available, credits: null } },
    ].map((rateLimitsByLimitId) => ({
      policy: 'existing-credits',
      ordinaryUsageAllowed: false,
      rateLimitsByLimitId,
      allowed: false,
    })),
  ]) {
    const selected = replacementPlan({
      ...plan(directory),
      ...('policy' in row ? { creditPolicy: row.policy as 'existing-credits' } : {}),
    });
    assert(Object.isFrozen(selected));
    assert.equal(selected.creditPolicy, 'policy' in row ? row.policy : 'ordinary');
    const reader = new ReplacementTranscript(selected, {
      now: () => 1,
      timeoutMs: 300_000,
    });
    const admit = () =>
      metadata(reader, {
        'account/rateLimits/read': {
          ordinaryUsageAllowed: row.ordinaryUsageAllowed,
          rateLimits: 'rateLimits' in row ? row.rateLimits : available,
          ...('rateLimitsByLimitId' in row ? { rateLimitsByLimitId: row.rateLimitsByLimitId } : {}),
        },
      });
    if (row.allowed) {
      assert.equal(admit().method, 'thread/start');
      reader.push(bytes({ id: 10, result: threadResult(directory) }));
      assert.equal(
        JSON.parse(Buffer.from(reader.next() as Uint8Array).toString()).method,
        'turn/start',
      );
      reader.push(bytes({ id: 11, result: { turn: running } }));
      for (const frame of output(directory)) reader.push(bytes(frame));
      assert.deepEqual(reader.finish().replacement, edit(directory));
    } else {
      assert.throws(admit);
      assert.equal(reader.submitted, false);
    }
  }
  for (const mcp_servers of [
    undefined,
    { fixture_server: { enabled: true } },
    { fixture_server: { enabled: 'false' } },
    { 'unsafe.name': { enabled: false } },
    Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`server_${index}`, { enabled: false }]),
    ),
  ]) {
    const blocked = new ReplacementTranscript(plan(directory), {
      now: () => 1,
      timeoutMs: 300_000,
    });
    assert.throws(() =>
      metadata(blocked, { 'config/read': { config: { ...configuration, mcp_servers } } }),
    );
    assert(!['thread/start', 'turn/start'].includes(blocked.pendingRequest));
    assert.equal(blocked.submitted, false);
  }
  const candidate = 'export function netMinor(a, b) { return Math.max(0, a - b); }\n';
  const reviewInput = {
    ...plan(directory),
    binding: {
      preparationId: 'art_01M51M322B2AEBXD9MA74CBCFM',
      scopeHash: '1'.repeat(64),
      taskId: 'tsk_01M51M322B2AEBXD9MA74CBCFM',
      runId: 'run_01M51M322B2AEBXD9MA74CBCFM',
      attemptId: 'att_01M51M322B2AEBXD9MA74CBCFN',
      generation: 1,
      routeId: 'rte_01M51M322B2AEBXD9MA74CBCFN',
      writerAttemptId: 'att_01M51M322B2AEBXD9MA74CBCFM',
      writerRouteId: 'rte_01M51M322B2AEBXD9MA74CBCFM',
      candidateId: 'cnd_01M51M322B2AEBXD9MA74CBCFM',
      candidateHash: '2'.repeat(64),
      profileId: 'openai-file-v1' as const,
      assignedRole: 'reviewer' as const,
      methodId: 'keep-it-simple' as const,
      cycle: 1 as const,
      limitMinutes: 3,
      scripted: false as const,
      independence: 'process-only' as const,
    },
    candidate,
    candidateContentHash: createHash('sha256').update(candidate).digest('hex'),
    context: {
      title: 'Review one edit',
      outcome: 'Report concrete findings',
      criteria: ['Check the arithmetic.'],
    },
  };
  const { attemptId: _writerAttempt, criteria: _writerCriteria, ...reviewData } = reviewInput;
  // The client echoes the review text twice, so the runner must allow two full lines and 1 MiB.
  assert.equal(
    new ReviewTranscript(reviewPlan(reviewData), { now: () => 1, timeoutMs: 180_000 }).outputLimit,
    3 * 1024 * 1024,
  );
  for (const row of [
    { mode: 'passed', allowed: true },
    { mode: 'failed', allowed: true },
    { mode: 'blocked', allowed: true },
    { mode: 'fragmented', allowed: true },
    { mode: 'external-mutation', allowed: true },
    { mode: 'binding' },
    { mode: 'method' },
    { mode: 'cycle' },
    { mode: 'blocking-pass' },
    { mode: 'too-many' },
    { mode: 'message-bytes' },
    { mode: 'result-bytes' },
    { mode: 'extra' },
    { mode: 'wrong-thread' },
    { mode: 'wrong-turn' },
    { mode: 'approval' },
    { mode: 'rerouted' },
    { mode: 'partial' },
  ]) {
    const selected = reviewPlan(reviewData);
    const expectedBinding = structuredClone(selected.binding);
    const expectedHash = hashCanonical(expectedBinding);
    const review = new ReviewTranscript(selected, { now: () => 1, timeoutMs: 180_000 });
    if (row.mode === 'external-mutation') {
      if ('writerRouteId' in selected.binding)
        selected.binding.writerRouteId = selected.binding.routeId;
      selected.context.criteria[0] = 'changed after construction';
    }
    const thread = metadata(review);
    assert.equal(thread.params.ephemeral, true);
    assert.equal(thread.params.threadId, undefined);
    review.push(bytes({ id: 10, result: threadResult(directory) }));
    const request = JSON.parse(Buffer.from(review.next() as Uint8Array).toString());
    const task = JSON.parse(request.params.input[0].text.split('\n').slice(1).join('\n'));
    assert.deepEqual(task.binding, expectedBinding);
    assert.equal(task.original, original);
    assert.equal(task.candidate, candidate);
    assert.deepEqual(task.context.criteria, ['Check the arithmetic.']);
    assert.equal(task.bindingHash, expectedHash);
    assert.equal(request.params.outputSchema.properties.bindingHash.const, expectedHash);
    assert.equal(request.params.outputSchema.properties.content, undefined);
    review.push(bytes({ id: 11, result: { turn: running } }));
    const response = {
      version: 1,
      bindingHash: row.mode === 'binding' ? '0'.repeat(64) : expectedHash,
      methodId: row.mode === 'method' ? 'second-opinion' : 'keep-it-simple',
      cycle: row.mode === 'cycle' ? 2 : 1,
      outcome: ['failed', 'blocked'].includes(row.mode) ? row.mode : 'passed',
      findings:
        row.mode === 'blocking-pass'
          ? [{ severity: 'blocking', message: 'A concrete defect.' }]
          : Array.from(
              { length: row.mode === 'too-many' ? 51 : row.mode === 'result-bytes' ? 20 : 1 },
              () => ({
                severity: 'info',
                message:
                  row.mode === 'message-bytes'
                    ? 'é'.repeat(2049)
                    : row.mode === 'result-bytes'
                      ? 'x'.repeat(4096)
                      : 'No extra layer is needed.',
              }),
            ),
      summary: 'One bounded review.',
      ...(row.mode === 'extra' ? { command: 'private-review-canary' } : {}),
    };
    const perform = () => {
      for (const frame of output(
        directory,
        ['wrong-thread', 'wrong-turn', 'approval', 'rerouted'].includes(row.mode)
          ? row.mode
          : 'success',
        'net.mjs',
        response,
      )) {
        const chunk = bytes(frame);
        if (row.mode === 'fragmented')
          for (const byte of chunk) review.push(new Uint8Array([byte]));
        else review.push(chunk);
      }
      if (row.mode === 'partial') review.push(Buffer.from('{'));
      return review.finish();
    };
    if (row.allowed) {
      const result = perform();
      assert.deepEqual(result.review, response);
      assert.equal(result.qualified, false);
      assert.equal(Object.hasOwn(result, 'modelChoices'), false);
      assert.equal(review.next(), null);
      assert.equal('replacement' in result, false);
    } else {
      assert.throws(perform, row.mode);
      assert.equal(review.complete, false);
      assert(!JSON.stringify(review.diagnostic).includes('private-review-canary'));
    }
  }
  const hundredCriteria = {
    ...reviewData,
    context: { ...reviewData.context, criteria: Array.from({ length: 100 }, () => 'Check this.') },
  };
  for (const value of [
    hundredCriteria,
    {
      ...reviewData,
      context: {
        ...reviewData.context,
        criteria: Array.from({ length: 101 }, () => 'Check this.'),
      },
    },
    { ...reviewData, baseHash: '0'.repeat(64) },
    { ...reviewData, candidateContentHash: '0'.repeat(64) },
    { ...reviewData, candidate: 'text\0tail' },
    { ...reviewData, binding: { ...reviewData.binding, methodId: 'round-robin' } },
    { ...reviewData, binding: { ...reviewData.binding, cycle: 2 } },
    {
      ...reviewData,
      context: {
        ...reviewData.context,
        criteria: Array.from({ length: 32 }, () => 'x'.repeat(4096)),
      },
      original: 'x'.repeat(65536),
      candidate: 'x'.repeat(65536),
      baseHash: createHash('sha256').update('x'.repeat(65536)).digest('hex'),
      candidateContentHash: createHash('sha256').update('x'.repeat(65536)).digest('hex'),
    },
  ]) {
    if (value === hundredCriteria)
      assert.deepEqual(
        reviewPlan(hundredCriteria).context.criteria,
        hundredCriteria.context.criteria,
      );
    else assert.throws(() => reviewPlan(value as Parameters<typeof reviewPlan>[0]));
  }
  const digestText = (value: string) => createHash('sha256').update(value).digest('hex');
  const repositoryData = {
    binding: reviewData.binding,
    model: reviewData.model,
    effort: reviewData.effort,
    directory,
    context: reviewData.context,
    repository: {
      version: 1 as const,
      sourceBase: 'a'.repeat(40),
      sourceManifestHash: 'b'.repeat(64),
      candidateManifestHash: reviewData.binding.candidateHash,
      changes: [
        {
          path: 'added.mjs',
          original: null,
          candidate: { mode: '100644' as const, hash: digestText(candidate), content: candidate },
        },
        {
          path: 'deleted.mjs',
          original: { mode: '100644' as const, hash: digestText(original), content: original },
          candidate: null,
        },
        {
          path: 'mode.mjs',
          original: { mode: '100644' as const, hash: digestText(original), content: original },
          candidate: { mode: '100755' as const, hash: digestText(original), content: original },
        },
      ],
    },
  };
  const repositoryReview = reviewPlan(repositoryData);
  const collection = new ReviewTranscript(repositoryReview, { now: () => 1, timeoutMs: 180_000 });
  metadata(collection);
  collection.push(bytes({ id: 10, result: threadResult(directory) }));
  const collectionRequest = JSON.parse(Buffer.from(collection.next() as Uint8Array).toString());
  const collectionTask = JSON.parse(
    collectionRequest.params.input[0].text.split('\n').slice(1).join('\n'),
  );
  assert.deepEqual(collectionTask.repository, repositoryData.repository);
  assert.equal(collectionTask.path, undefined);
  assert.equal(collectionTask.bindingHash, hashCanonical(repositoryData.binding));
  const combinedId = (prefix: string, index: number) =>
    `${prefix}_01M51M322B2AEBXD9MA74CBCF${index}`;
  const { writerAttemptId: _attempt, writerRouteId: _route, ...reviewBinding } = reviewData.binding;
  const combinedData = {
    ...repositoryData,
    binding: {
      ...reviewBinding,
      assignedRole: 'reviewer' as const,
      origin: {
        kind: 'combined' as const,
        taskId: reviewBinding.taskId,
        runId: reviewBinding.runId,
        preparationId: combinedId('art', 0),
        manifestHash: 'a'.repeat(64),
        generation: 0,
        sourceBase: repositoryData.repository.sourceBase,
        sourceManifestHash: repositoryData.repository.sourceManifestHash,
        policyHash: 'c'.repeat(64),
        criteriaHash: hashCanonical(repositoryData.context.criteria),
        contributors: [1, 2].map((index) => ({
          taskId: combinedId('tsk', index),
          runId: combinedId('run', index),
          attemptId: combinedId('att', index),
          generation: 0,
          routeId: combinedId('rte', index),
          candidateId: combinedId('cnd', index),
          candidateHash: `${index}`.repeat(64),
          scopeHash: 'd'.repeat(64),
        })) as [
          import('@crewkite/contracts').CombinedOrigin['contributors'][0],
          import('@crewkite/contracts').CombinedOrigin['contributors'][1],
        ],
        steps: [0, 1].map((index) => ({
          candidateId: combinedId('cnd', index + 3),
          candidateHash: index === 0 ? 'e'.repeat(64) : reviewBinding.candidateHash,
          definitionHash: 'f'.repeat(64),
          checkArtifactId: combinedId('art', index + 1),
          previousTree: (index === 0 ? 'a' : 'b').repeat(40),
          nextTree: (index === 0 ? 'b' : 'c').repeat(40),
        })) as [
          import('@crewkite/contracts').CombinedOrigin['steps'][0],
          import('@crewkite/contracts').CombinedOrigin['steps'][1],
        ],
        candidateId: reviewBinding.candidateId,
        candidateHash: reviewBinding.candidateHash,
      },
    },
  };
  for (const mode of ['passed', 'stale-origin', 'external-mutation', 'approval'] as const) {
    const selected = reviewPlan(combinedData);
    const expected = structuredClone(selected.binding);
    const reader = new ReviewTranscript(selected, { now: () => 1, timeoutMs: 180_000 });
    if (mode === 'external-mutation' && 'origin' in selected.binding)
      selected.binding.origin.contributors[0].scopeHash = '0'.repeat(64);
    metadata(reader);
    reader.push(bytes({ id: 10, result: threadResult(directory) }));
    const request = JSON.parse(Buffer.from(reader.next() as Uint8Array).toString());
    const task = JSON.parse(request.params.input[0].text.split('\n').slice(1).join('\n'));
    assert.deepEqual(task.binding, expected);
    assert.deepEqual(task.repository, repositoryData.repository);
    assert.equal(task.binding.writerAttemptId, undefined);
    assert.equal(task.binding.writerRouteId, undefined);
    assert.equal(task.bindingHash, hashCanonical(expected));
    reader.push(bytes({ id: 11, result: { turn: running } }));
    const stale = structuredClone(expected);
    if ('origin' in stale) stale.origin.generation++;
    const response = {
      version: 1,
      bindingHash: mode === 'stale-origin' ? hashCanonical(stale) : hashCanonical(expected),
      methodId: 'keep-it-simple',
      cycle: 1,
      outcome: 'passed',
      findings: [],
      summary: 'Both contributions meet the parent criteria.',
    };
    const perform = () => {
      for (const frame of output(
        directory,
        mode === 'approval' ? 'approval' : 'success',
        'net.mjs',
        response,
      ))
        reader.push(bytes(frame));
      return reader.finish();
    };
    if (mode === 'stale-origin' || mode === 'approval') assert.throws(perform, mode);
    else {
      assert.deepEqual(perform().review, response);
      assert.equal(reader.finish().qualified, false);
    }
  }
  for (const value of [
    { ...combinedData, binding: { ...combinedData.binding, writerAttemptId: _attempt } },
    { ...combinedData, binding: { ...combinedData.binding, writerRouteId: _route } },
    { ...combinedData, binding: { ...combinedData.binding, candidateHash: '0'.repeat(64) } },
    { ...combinedData, context: { ...combinedData.context, criteria: ['Other criteria.'] } },
    { ...combinedData, repository: { ...combinedData.repository, sourceBase: '0'.repeat(40) } },
    {
      ...combinedData,
      repository: { ...combinedData.repository, sourceManifestHash: '0'.repeat(64) },
    },
    { ...reviewData, binding: combinedData.binding },
  ])
    assert.throws(() => reviewPlan(value as Parameters<typeof reviewPlan>[0]));
  const reviewRequest = (value: Parameters<typeof reviewPlan>[0], escaped = false) => {
    const selected = reviewPlan(value);
    const reader = new ReviewTranscript(selected, { now: () => 1, timeoutMs: 180_000 });
    metadata(reader);
    const response = threadResult(selected.directory);
    reader.push(
      bytes({
        id: 10,
        result: {
          ...response,
          thread: { ...response.thread, id: escaped ? '\x01'.repeat(200) : 'thread-1' },
        },
      }),
    );
    const frame = Buffer.from(reader.next() as Uint8Array);
    const request = JSON.parse(frame.toString());
    const packet = request.params.input[0].text.split('\n').slice(1).join('\n');
    assert(frame.length < 1024 * 1024);
    // The client reports the submitted text back twice before the review answer.
    const threadId = escaped ? '\x01'.repeat(200) : 'thread-1';
    const review = {
      version: 1,
      bindingHash: request.params.outputSchema.properties.bindingHash.const,
      methodId: 'keep-it-simple',
      cycle: 1,
      outcome: 'passed',
      findings: [],
      summary: 'One bounded review.',
    };
    const echo = { type: 'userMessage', id: 'user-1', content: request.params.input };
    const frames: unknown[] = output(selected.directory, 'success', 'net.mjs', review).map(
      (value) =>
        JSON.parse(JSON.stringify(value).replaceAll('"thread-1"', JSON.stringify(threadId))),
    );
    frames.splice(
      1,
      0,
      { method: 'item/started', params: { threadId, turnId: 'turn-1', item: echo } },
      { method: 'item/completed', params: { threadId, turnId: 'turn-1', item: echo } },
    );
    reader.push(bytes({ id: 11, result: { turn: running } }));
    for (const value of frames) reader.push(bytes(value));
    assert.deepEqual(reader.finish().review, review);
    return { frame, packet };
  };
  const repositorySides = (original: string, candidate: string) => ({
    ...repositoryData,
    repository: {
      ...repositoryData.repository,
      changes: [
        {
          path: 'large.mjs',
          original: { mode: '100644' as const, hash: digestText(original), content: original },
          candidate: { mode: '100644' as const, hash: digestText(candidate), content: candidate },
        },
      ],
    },
  });
  const repositoryLimit = 448 * 1024;
  const nearRepositoryLimit = repositorySides('x'.repeat(200_000), 'y'.repeat(250_000));
  const repositoryPadding =
    repositoryLimit - Buffer.byteLength(reviewRequest(nearRepositoryLimit).packet);
  assert(repositoryPadding > 0);
  const atRepositoryLimit = repositorySides(
    'x'.repeat(200_000),
    'y'.repeat(250_000 + repositoryPadding),
  );
  const escapedOriginal = '"\\'.repeat(45_000);
  const escapedCandidate = '\\"'.repeat(45_000);
  const escapedPadding =
    repositoryLimit -
    Buffer.byteLength(reviewRequest(repositorySides(escapedOriginal, escapedCandidate)).packet);
  assert(escapedPadding > 0);
  const escapedRepository = {
    ...repositorySides(
      escapedOriginal,
      escapedCandidate +
        '"'.repeat(Math.floor(escapedPadding / 2)) +
        'y'.repeat(escapedPadding % 2),
    ),
    directory: `/${'\x01'.repeat(4095)}`,
  };
  for (const [name, value, escaped] of [
    ['full text', repositorySides('x'.repeat(140_000), 'y'.repeat(140_000)), false],
    ['repository side limit', repositorySides('', 'x'.repeat(256 * 1024)), false],
    ['multibyte', repositorySides('é'.repeat(70_000), '界'.repeat(45_000)), false],
    ['escaping', escapedRepository, true],
    ['exact repository aggregate', atRepositoryLimit, false],
  ] as const) {
    const { packet } = reviewRequest(value, escaped);
    const size = Buffer.byteLength(packet);
    assert(size > 256 * 1024 && size <= repositoryLimit, name);
    if (name === 'exact repository aggregate' || name === 'escaping')
      assert.equal(size, repositoryLimit);
    assert.deepEqual(JSON.parse(packet).repository, value.repository, name);
  }
  assert.throws(() =>
    reviewPlan(repositorySides('x'.repeat(200_000), 'y'.repeat(250_001 + repositoryPadding))),
  );
  const legacySides = {
    ...reviewData,
    original: 'x'.repeat(65_536),
    candidate: 'y'.repeat(65_536),
    baseHash: digestText('x'.repeat(65_536)),
    candidateContentHash: digestText('y'.repeat(65_536)),
    context: {
      ...reviewData.context,
      criteria: Array.from({ length: 32 }, () => 'c'.repeat(4000)),
    },
  };
  let legacyPadding = 256 * 1024 - Buffer.byteLength(reviewRequest(legacySides).packet);
  assert(legacyPadding > 0);
  for (let index = 0; legacyPadding > 0 && index < legacySides.context.criteria.length; index++) {
    const amount = Math.min(96, legacyPadding);
    legacySides.context.criteria[index] += 'c'.repeat(amount);
    legacyPadding -= amount;
  }
  assert.equal(legacyPadding, 0);
  assert.equal(Buffer.byteLength(reviewRequest(legacySides).packet), 256 * 1024);
  const largerCriteria = [...legacySides.context.criteria];
  const criterion = largerCriteria.findIndex((value) => value.length < 4096);
  assert(criterion >= 0);
  largerCriteria[criterion] += 'c';
  assert.throws(() =>
    reviewPlan({ ...legacySides, context: { ...legacySides.context, criteria: largerCriteria } }),
  );
  assert.throws(() =>
    reviewPlan({
      ...reviewData,
      original: 'x'.repeat(65_537),
      baseHash: digestText('x'.repeat(65_537)),
    }),
  );
  const changes = repositoryData.repository.changes;
  for (const repository of [
    { ...repositoryData.repository, version: 2 },
    { ...repositoryData.repository, candidateManifestHash: '0'.repeat(64) },
    { ...repositoryData.repository, changes: [] },
    { ...repositoryData.repository, changes: [changes[1], changes[0]] },
    { ...repositoryData.repository, changes: [changes[0], changes[0]] },
    { ...repositoryData.repository, changes: [{ ...changes[0], original: null, candidate: null }] },
    { ...repositoryData.repository, changes: [{ ...changes[2], candidate: changes[2].original }] },
    ...['text\0tail', '\ud800', 'x'.repeat(262_145)].map((content) => ({
      ...repositoryData.repository,
      changes: [
        { ...changes[0], candidate: { mode: '100644', content, hash: digestText(content) } },
      ],
    })),
    {
      ...repositoryData.repository,
      changes: [{ ...changes[0], candidate: { ...changes[0].candidate, hash: '0'.repeat(64) } }],
    },
    { ...repositoryData.repository, changes: [{ ...changes[0], path: '../outside' }] },
  ])
    assert.throws(() =>
      reviewPlan({ ...repositoryData, repository } as Parameters<typeof reviewPlan>[0]),
    );
  assert.throws(() =>
    reviewPlan({ ...repositoryData, path: 'net.mjs' } as Parameters<typeof reviewPlan>[0]),
  );

  const repositoryInput = repositoryPlan({
    attemptId: plan(directory).attemptId,
    model: 'gpt-6.1-sol',
    effort: 'low',
    scratchPath: resolve(directory, 'scratch'),
    sourceBase: 'a'.repeat(40),
    manifestHash: 'b'.repeat(64),
    execution: { sandbox: 'workspace-write', approvalPolicy: 'never', networkAccess: false },
    context: {
      title: 'Fix arithmetic',
      outcome: 'Preserve the bounds.',
      criteria: ['Return the bounded net.'],
    },
    limits: {
      ...repositoryLimits,
      paths: ['docs/calculation.md', 'net.mjs'],
      ...verificationGuidance,
    },
  });
  for (const change of [{ model: 'planning-fixture' }, { effort: 'medium' }]) {
    assert.throws(() =>
      replacementPlan({ ...plan(directory), ...change } as Parameters<typeof replacementPlan>[0]),
    );
    assert.throws(() =>
      reviewPlan({ ...reviewData, ...change } as Parameters<typeof reviewPlan>[0]),
    );
    assert.throws(() =>
      repositoryPlan({ ...repositoryInput, ...change } as Parameters<typeof repositoryPlan>[0]),
    );
  }
  assert.equal(repositoryInput.creditPolicy, 'ordinary');
  assert.equal(resolveRepositoryProfile({}).facts.id, 'openai-repository-v1');
  assert.throws(
    () =>
      new RepositoryTranscript(repositoryInput, { now: () => 1, timeoutMs: 600_001, directory }),
    /Repository task deadline is invalid/,
  );
  for (const invalid of [
    { ...repositoryInput, scratchPath: 'relative' },
    { ...repositoryInput, execution: { ...repositoryInput.execution, networkAccess: true } },
    { ...repositoryInput, context: { ...repositoryInput.context, outcome: 'text\0tail' } },
    {
      ...repositoryInput,
      context: {
        ...repositoryInput.context,
        criteria: Array.from({ length: 100 }, () => 'x'.repeat(4096)),
      },
    },
  ])
    assert.throws(() => repositoryPlan(invalid as Parameters<typeof repositoryPlan>[0]));
  for (const mode of [
    'success',
    'fragmented',
    'failed-command',
    'activity-throw',
    'activity-promise',
    'approval',
    'wrong-approval',
    'malformed-approval',
    'unknown-request',
    'notice-request',
    'busy-command',
    'large-output',
    'long-turn',
    'overrun',
    'item-overrun',
    'retry-overrun',
    'line-overrun',
    'late-progress',
    'late-completion',
    'late-error',
    'network',
    'cwd',
    'incomplete-item',
    'failed-turn',
    'duplicate-item',
    'wrong-turn',
    'reroute',
    'deadline',
  ]) {
    let clock = 1;
    const activities: RepositoryActivity[] = [];
    const native = new RepositoryTranscript(repositoryInput, {
      now: () => clock,
      timeoutMs: 600_000,
      directory,
      onActivity: (activity) => {
        activities.push(activity);
        if (mode === 'activity-throw') throw new Error('private-repository-canary');
        if (mode === 'activity-promise')
          return Promise.reject(new Error('private-repository-canary'));
      },
    });
    const threadRequest = metadata(native);
    assert.equal(threadRequest.params.cwd, repositoryInput.scratchPath);
    assert.equal(threadRequest.params.sandbox, 'workspace-write');
    assert.equal(threadRequest.params.approvalPolicy, 'never');
    assert.deepEqual(threadRequest.params.config.shell_environment_policy, {
      set: {
        PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'error',
        PNPM_CONFIG_OFFLINE: 'true',
        COREPACK_ENABLE_NETWORK: '0',
      },
    });
    const thread = {
      ...threadResult(repositoryInput.scratchPath),
      approvalPolicy: 'never',
      sandbox: {
        type: 'workspaceWrite',
        writableRoots: [repositoryInput.scratchPath],
        networkAccess: mode === 'network',
      },
    };
    if (mode === 'cwd') thread.cwd = directory;
    if (mode === 'network' || mode === 'cwd') {
      assert.throws(() => native.push(bytes({ id: 10, result: thread })));
      continue;
    }
    native.push(bytes({ id: 10, result: thread }));
    if (mode === 'deadline') {
      clock = 600_001;
      assert.throws(() => native.next());
      assert.equal(native.submitted, false);
      continue;
    }
    const request = JSON.parse(Buffer.from(native.next() as Uint8Array).toString());
    assert.equal(request.params.outputSchema, undefined);
    const [instructions, data] = request.params.input[0].text.split('\n');
    assert.match(instructions, /do not run pnpm, npm or npx/);
    const limits = JSON.parse(data).limits;
    assert.deepEqual(limits.paths, ['docs/calculation.md', 'net.mjs']);
    assert.equal(limits.checks[1], 'lint: biome check . (formatting differences fail)');
    assert.deepEqual(limits.review, { fileBytes: 256 * 1024, totalBytes: 448 * 1024 });
    assert.equal(request.params.cwd, repositoryInput.scratchPath);
    assert.deepEqual(request.params.sandboxPolicy.writableRoots, [repositoryInput.scratchPath]);
    native.push(bytes({ id: 11, result: { turn: running } }));
    const identity = { threadId: 'thread-1', turnId: 'turn-1' };
    const command = {
      id: 'command-1',
      type: 'commandExecution',
      status: 'inProgress',
      command: 'private-repository-canary',
      cwd: repositoryInput.scratchPath,
    };
    const frames: unknown[] = [
      { method: 'turn/started', params: { threadId: identity.threadId, turn: running } },
      { method: 'item/started', params: { ...identity, item: command, startedAtMs: 1 } },
    ];
    if (mode.includes('approval') || mode.endsWith('-request')) {
      for (const frame of frames) native.push(bytes(frame));
      const approval = {
        id: 'approval-1',
        method:
          mode === 'unknown-request'
            ? 'item/tool/request'
            : mode === 'notice-request'
              ? 'item/commandExecution/outputDelta'
              : 'item/commandExecution/requestApproval',
        params: {
          ...identity,
          turnId: mode === 'wrong-approval' ? 'other' : identity.turnId,
          itemId: command.id,
          ...(mode === 'malformed-approval' ? {} : { startedAtMs: 1 }),
        },
      };
      if (mode === 'approval') {
        native.push(bytes(approval));
        const cancellation = Buffer.from(native.next() as Uint8Array)
          .toString()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.deepEqual(cancellation, [
          { id: approval.id, result: { decision: 'cancel' } },
          { id: 12, method: 'turn/interrupt', params: identity },
        ]);
        assert.equal(native.interrupt(), null);
      } else {
        assert.throws(() => native.push(bytes(approval)), mode);
        assert.equal(
          JSON.parse(Buffer.from(native.interrupt() as Uint8Array).toString()).method,
          'turn/interrupt',
        );
      }
      assert.throws(() => native.finish());
      assert.equal(native.complete, false);
      continue;
    }
    const reasoning = (index: number) => ({ id: `reasoning-${index}`, type: 'reasoning' });
    const retry = { method: 'error', params: { ...identity, willRetry: true, error: {} } };
    const sized = (length: number) => {
      const frame = {
        method: 'item/commandExecution/outputDelta',
        params: { ...identity, delta: '' },
      };
      frame.params.delta = 'x'.repeat(length - JSON.stringify(frame).length);
      return frame;
    };
    // Each bound admits its last frame and refuses the next. turn/started is one checked notice.
    const overruns: Record<string, [number, (index: number) => unknown]> = {
      overrun: [16_383, () => ({ method: 'thread/queue/changed', params: identity })],
      'item-overrun': [
        4096,
        (index) => ({ method: 'item/started', params: { ...identity, item: reasoning(index) } }),
      ],
      'retry-overrun': [32, () => retry],
      'line-overrun': [1, (index) => sized(1024 * 1024 + index)],
    };
    if (mode in overruns) {
      const [allowed, frame] = overruns[mode];
      native.push(bytes(frames[0]));
      for (let index = 0; index < allowed; index++) native.push(bytes(frame(index)));
      assert.throws(() => native.push(bytes(frame(allowed))), mode);
      assert.equal(native.diagnostic?.cause, 'limit', mode);
      continue;
    }
    if (mode === 'duplicate-item') frames.push(frames[1]);
    if (mode === 'reroute') frames.push({ method: 'model/rerouted', params: identity });
    // A busy command streams more than 1024 output frames and more than 1 MiB.
    const delta = {
      method: 'item/commandExecution/outputDelta',
      params: {
        ...identity,
        itemId: command.id,
        delta: 'private-repository-canary'.repeat(mode === 'busy-command' ? 8 : 1),
      },
    };
    frames.push(...Array(mode === 'busy-command' ? 5000 : 1).fill(delta));
    if (mode === 'busy-command') frames.push(...ignoredNotices(identity).slice(1));
    if (mode !== 'incomplete-item')
      frames.push({
        method: 'item/completed',
        params: {
          ...identity,
          turnId: mode === 'wrong-turn' ? 'other' : identity.turnId,
          item: {
            ...command,
            status: mode === 'failed-command' ? 'failed' : 'completed',
            // A completed command item repeats all of its output.
            ...(mode === 'large-output'
              ? { aggregatedOutput: 'private-repository-canary'.repeat(24_576) }
              : {}),
          },
          completedAtMs: 2,
        },
      });
    const fileItem = {
      id: 'files-1',
      type: 'fileChange',
      status: 'inProgress',
      changes: [
        {
          path: resolve(repositoryInput.scratchPath, 'net.mjs'),
          kind: { type: 'update' },
          diff: 'private-repository-canary',
        },
        {
          path: resolve(directory, 'outside.mjs'),
          kind: { type: 'update' },
          diff: 'private-repository-canary',
        },
      ],
    };
    frames.push(
      { method: 'item/started', params: { ...identity, item: fileItem, startedAtMs: 3 } },
      {
        method: 'item/completed',
        params: { ...identity, item: { ...fileItem, status: 'completed' }, completedAtMs: 4 },
      },
    );
    // A long turn passes the earlier 128-item and three-retry bounds.
    if (mode === 'long-turn')
      for (let index = 0; index < 200; index++)
        frames.push(
          { method: 'item/started', params: { ...identity, item: reasoning(index) } },
          { method: 'item/completed', params: { ...identity, item: reasoning(index) } },
          ...(index % 50 === 0 ? [retry] : []),
        );
    frames.push({
      method: 'turn/completed',
      params: {
        threadId: identity.threadId,
        turn: { ...running, status: mode === 'failed-turn' ? 'failed' : 'completed' },
      },
    });
    if (mode === 'late-progress')
      frames.push(delta, { method: 'turn/diff/updated', params: { ...identity, diff: '' } });
    if (mode === 'late-completion') frames.push(frames.at(-1));
    if (mode === 'late-error')
      frames.push({ method: 'error', params: { ...identity, willRetry: true, error: {} } });
    const perform = () => {
      for (const frame of frames) {
        const buffer = bytes(frame);
        if (mode === 'fragmented') for (const byte of buffer) native.push(new Uint8Array([byte]));
        else native.push(buffer);
      }
      return native.finish();
    };
    if (
      [
        'success',
        'fragmented',
        'failed-command',
        'busy-command',
        'large-output',
        'long-turn',
        'late-progress',
      ].includes(mode)
    ) {
      const result = perform();
      assert.deepEqual(activities, [
        { kind: 'command', state: 'started' },
        { kind: 'command', state: mode === 'failed-command' ? 'failed' : 'completed' },
        { kind: 'file-change', state: 'started', fileCount: 2, paths: ['net.mjs'] },
        { kind: 'file-change', state: 'completed', fileCount: 2, paths: ['net.mjs'] },
      ]);
      assert(!JSON.stringify(activities).includes('private-repository-canary'));
      assert.equal(result.manifestHash, repositoryInput.manifestHash);
      assert.equal(result.qualified, false);
      assert.equal(Object.hasOwn(result, 'modelChoices'), false);
      assert.equal('replacement' in result, false);
      assert(!JSON.stringify(result).includes('private-repository-canary'));
      assert.equal(result.observedRetries, mode === 'long-turn' ? 4 : 0);
      if (mode === 'busy-command')
        assert.deepEqual(native.ignoredNotifications, {
          [methodHash(delta.method)]: 5000,
          ...Object.fromEntries(
            ignoredNotices(identity)
              .slice(1)
              .map(({ method }) => [methodHash(method), 1]),
          ),
        });
    } else assert.throws(perform, mode);
    assert(
      !JSON.stringify({
        diagnostic: native.diagnostic,
        refused: native.refusedEnvelope,
        last: native.lastEnvelope,
      }).includes('private-repository-canary'),
    );
  }
  const selectedReview = reviewPlan(reviewData);
  assert.equal(selectedReview.creditPolicy, 'ordinary');
  assert.throws(
    () =>
      startReview(
        {
          executable: process.execPath,
          sha256: '0'.repeat(64),
          directory,
          repositoryRoot: directory,
          environment: {},
        },
        selectedReview,
        { timeoutMs: 181_000, onSubmitted: () => assert.fail('over-budget review cannot submit') },
      ),
    /differs from its directory or remaining budget/,
  );
  assert.throws(
    () =>
      startReplacement(
        {
          executable: process.execPath,
          sha256: '0'.repeat(64),
          directory,
          repositoryRoot: directory,
          environment: {},
        },
        plan(directory),
        { timeoutMs: 300_001, onSubmitted: () => assert.fail('a file writer keeps five minutes') },
      ),
    /Discovery deadline is invalid/,
  );
  const reader = new ReplacementTranscript(plan(directory), { now: () => 1, timeoutMs: 300_000 });
  metadata(reader);
  reader.push(bytes({ id: 10, result: threadResult(directory) }));
  reader.next();
  reader.push(bytes({ id: 11, result: { turn: running } }));
  assert.deepEqual(JSON.parse(Buffer.from(reader.interrupt() as Uint8Array).toString()), {
    id: 12,
    method: 'turn/interrupt',
    params: { threadId: 'thread-1', turnId: 'turn-1' },
  });
  assert.equal(reader.interrupt(), null);
  assert.throws(() => replacementPlan({ ...plan(directory), baseHash: '0'.repeat(64) }));
  for (const path of [
    '/absolute.md',
    'C:/absolute.md',
    '../outside.md',
    'docs/../outside.md',
    'docs//file.md',
    '.git/config',
    'docs/\\file.md',
    'docs/\0file.md',
    'docs/\nfile.md',
    'docs/\u0085file.md',
    'docs/\ud800.md',
  ])
    assert.throws(() => replacementPlan({ ...plan(directory), path }), JSON.stringify(path));
  const boundedOriginal = 'é'.repeat(32768);
  assert.equal(
    replacementPlan({
      ...plan(directory),
      original: boundedOriginal,
      baseHash: createHash('sha256').update(boundedOriginal).digest('hex'),
    }).original,
    boundedOriginal,
  );
  for (const original of ['text\0tail', '\ud800', 'é'.repeat(32769)])
    assert.throws(() =>
      replacementPlan({
        ...plan(directory),
        original,
        baseHash: createHash('sha256').update(original).digest('hex'),
      }),
    );
  let now = 1;
  const expired = new ReplacementTranscript(plan(directory), {
    now: () => now,
    timeoutMs: 300_000,
  });
  metadata(expired);
  expired.push(bytes({ id: 10, result: threadResult(directory) }));
  now = 300_001;
  assert.throws(() => expired.next());
  assert.equal(expired.submitted, false);
  const unsolicited = new ReplacementTranscript(plan(directory), {
    now: () => 1,
    timeoutMs: 300_000,
  });
  metadata(unsolicited);
  unsolicited.push(bytes({ id: 10, result: threadResult(directory) }));
  unsolicited.push(Buffer.from('{"id":11,'));
  assert.equal(unsolicited.next(), null);
  assert.throws(() => unsolicited.push(Buffer.from('"result":{}}\n')));
  assert.equal(unsolicited.submitted, false);
});

test('transcripts pass rate-limit reads and updates to the usage hook without changing their outcome', () => {
  const directory = resolve('internal/replacement-fixture');
  const scratchPath = resolve(directory, 'scratch');
  // The update merges with the session's read. The receiver drops its repeat. The malformed one
  // reaches no hook and leaves the turn running.
  const sparse = { usedPercent: 35, windowDurationMins: null, resetsAt: null };
  const updates = [sparse, sparse, { ...weekly, usedPercent: -1 }].map((primary) => ({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { ...codex, primary } },
  }));
  const repositoryInput = repositoryPlan({
    attemptId: plan(directory).attemptId,
    model: 'gpt-6.1-sol',
    effort: 'low',
    scratchPath,
    sourceBase: 'a'.repeat(40),
    manifestHash: 'b'.repeat(64),
    execution: { sandbox: 'workspace-write', approvalPolicy: 'never', networkAccess: false },
    context: { title: 'Bound net', outcome: 'Return the net.', criteria: ['Keep the bound.'] },
    limits: repositoryLimits,
  });
  // Each transcript delivers its complete read, then the merged update and its repeat.
  const delivered = [
    [true, [[66, 604800]]],
    [false, [[65, 604800]]],
    [false, [[65, 604800]]],
  ];
  const outcomes = new Map<string, unknown>();
  for (const hook of ['absent', 'records', 'throws'] as const) {
    const reports: OpenAiUsage[] = [];
    const onUsage =
      hook === 'absent'
        ? undefined
        : (usage: OpenAiUsage) => {
            reports.push(usage);
            if (hook === 'throws') throw new Error('private-usage-canary');
          };
    const writer = new ReplacementTranscript(plan(directory), {
      now: () => 1,
      timeoutMs: 300_000,
      onUsage,
    });
    metadata(writer, { 'account/rateLimits/read': usageRead });
    writer.push(bytes({ id: 10, result: threadResult(directory) }));
    writer.next();
    writer.push(bytes({ id: 11, result: { turn: running } }));
    const messages = output(directory);
    messages.splice(1, 0, ...updates);
    for (const message of messages) writer.push(bytes(message));
    const native = new RepositoryTranscript(repositoryInput, {
      now: () => 1,
      timeoutMs: 300_000,
      directory,
      onUsage,
    });
    metadata(native, { 'account/rateLimits/read': usageRead });
    native.push(
      bytes({
        id: 10,
        result: {
          ...threadResult(scratchPath),
          approvalPolicy: 'never',
          sandbox: { type: 'workspaceWrite', writableRoots: [scratchPath], networkAccess: false },
        },
      }),
    );
    native.next();
    native.push(bytes({ id: 11, result: { turn: running } }));
    for (const message of [
      { method: 'turn/started', params: { threadId: 'thread-1', turn: running } },
      ...updates,
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { ...running, status: 'completed' } },
      },
    ])
      native.push(bytes(message));
    outcomes.set(hook, { writer: writer.finish(), repository: native.finish() });
    assert.deepEqual(outcomes.get(hook), outcomes.get('absent'), hook);
    assert.deepEqual(
      reports.map((usage) => [
        usage.complete,
        usage.windows.map((value) => [value.remaining?.value, value.semantics?.periodSeconds]),
      ]),
      hook === 'absent' ? [] : [...delivered, ...delivered],
      hook,
    );
  }
  // Admission still refuses an over-limit read. Usage reads it first and shows it exhausted.
  const exhausted: OpenAiUsage[] = [];
  const refused = new ReplacementTranscript(plan(directory), {
    now: () => 1,
    timeoutMs: 300_000,
    onUsage: (usage) => exhausted.push(usage),
  });
  const over = { ...codex, primary: { ...weekly, usedPercent: 101 } };
  assert.throws(() =>
    metadata(refused, {
      'account/rateLimits/read': { ...usageRead, rateLimitsByLimitId: { codex: over } },
    }),
  );
  assert.deepEqual(
    exhausted.map((usage) => usage.windows.map((value) => value.remaining)),
    [[{ value: 0, unit: 'percent' }]],
  );
});

test('native task submission and interruption share one deadline through owned cleanup', async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const root = mkdtempSync(resolve('internal/replacement-owner-'));
  const digest = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const owned: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
  // Both phases read one weekly window. Only the task phase reports it.
  const withUsage = (script: string) =>
    script.replace(
      JSON.stringify(replies),
      JSON.stringify({ ...replies, 'account/rateLimits/read': usageRead }),
    );
  const delivered = [{ complete: true, windows: [weeklyWindow], credits: [] }];
  try {
    for (const mode of [
      'success',
      'cancel',
      'deadline',
      'unknown',
      'rpc-error',
      'prepare-cancel',
      'prepare-deadline',
      'mcp-drift',
    ]) {
      const directory = resolve(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      const calls: Array<{ milliseconds: number; work: () => void; active: boolean }> = [];
      const writes: string[] = [];
      let submission = 0;
      let now = 100;
      let appServers = 0;
      const usages: OpenAiUsage[] = [];
      const runGroups: number[] = [];
      let requestStop: (() => void) | undefined;
      let stopReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        stopReady = resolve;
      });
      const handle = startReplacement(
        {
          executable: process.execPath,
          sha256: digest,
          directory,
          repositoryRoot: root,
          environment: { HOME: root, PATH: process.env.PATH },
        },
        plan(directory),
        {
          timeoutMs: 300_000,
          now: () => now,
          onSubmitted: () => {
            submission++;
          },
          onUsage: (usage) => {
            usages.push(usage);
          },
          schedule: (work, milliseconds) => {
            const call = { work, milliseconds, active: true };
            calls.push(call);
            return () => {
              call.active = false;
            };
          },
          spawn: (executable, args, options) => {
            const phase =
              args.at(-1) === 'list' ? 'features' : ++appServers === 1 ? 'prepare' : 'task';
            assert(
              runGroups.every(groupAbsent),
              'each preceding phase must be quiescent before spawn',
            );
            if (phase === 'task') assert(args.includes('mcp_servers.fixture_server.enabled=false'));
            else assert(!args.some((arg) => arg.startsWith('mcp_servers.')));
            const child = spawn(executable, ['-e', withUsage(fixture), mode, phase], options);
            if (child.pid) runGroups.push(child.pid);
            if (phase === 'prepare' && mode === 'prepare-deadline')
              child.once('close', () => {
                now = 299_000;
              });
            owned.push({
              child,
              closed: new Promise((resolve) => child.once('close', () => resolve())),
            });
            const write = child.stdin.write.bind(child.stdin);
            child.stdin.write = ((data: string | Uint8Array) => {
              assert(handle.groups.includes(child.pid as number), 'journal ownership before input');
              writes.push(Buffer.from(data).toString());
              const result = write(data);
              if (
                Buffer.from(data).toString().includes('"method":"turn/start"') ||
                (Buffer.from(data).toString().includes('"method":"config/read"') &&
                  mode === 'prepare-cancel' &&
                  phase === 'prepare') ||
                (Buffer.from(data).toString().includes('"method":"model/list"') &&
                  mode === 'mcp-drift' &&
                  phase === 'task')
              ) {
                child.stdout.once('data', () => {
                  requestStop?.();
                  stopReady();
                });
              }
              return result;
            }) as typeof child.stdin.write;
            return child;
          },
        },
      );
      requestStop = () => {
        if (mode === 'cancel' || mode === 'unknown' || mode === 'prepare-cancel') handle.stop();
        if (mode === 'deadline')
          calls.findLast((value) => value.active && value.milliseconds === 298_000)?.work();
      };
      if (mode !== 'success' && mode !== 'prepare-deadline') {
        await ready;
        // Advance the injected termination grace after the exact native interrupt is written.
        calls
          .findLast(
            (value) => value.active && value.milliseconds === (mode === 'unknown' ? 2000 : 250),
          )
          ?.work();
      }
      const result = await handle.result;
      const submitted = mode.startsWith('prepare-') || mode === 'mcp-drift' ? 0 : 1;
      assert.equal(submission, submitted, mode);
      assert.equal(
        writes.filter((value) => value.includes('"method":"turn/start"')).length,
        submitted,
        mode,
      );
      assert.equal(result.quiescent, mode !== 'unknown', mode);
      assert.equal(handle.groups.length, mode.startsWith('prepare-') ? 2 : 3, mode);
      assert(!JSON.stringify(result).includes('private-diagnostic-canary'));
      if (mode !== 'unknown')
        assert(
          handle.groups.every((group) => groupAbsent(group)),
          mode,
        );
      assert(
        calls.some((value) => value.milliseconds === 298_000),
        mode,
      );
      if (mode === 'success') {
        assert.equal(result.reason, null);
        assert.equal(result.metadata?.replacement.path, 'net.mjs');
        assert.deepEqual(usages, delivered);
      } else {
        assert.equal(result.metadata, null, mode);
        assert.equal(
          result.reason,
          mode === 'unknown'
            ? 'ownership'
            : mode === 'rpc-error' || mode === 'mcp-drift'
              ? 'protocol'
              : mode === 'cancel' || mode === 'prepare-cancel'
                ? 'stopped'
                : 'deadline',
          mode,
        );
        assert.equal(
          writes.filter((value) => value.includes('"method":"turn/interrupt"')).length,
          ['cancel', 'deadline', 'unknown'].includes(mode) ? 1 : 0,
          mode,
        );
        if (mode === 'rpc-error') {
          assert.equal(result.diagnostic?.cause, 'rpc-error');
          assert.equal(result.diagnostic?.rpcCode, -32602);
          assert(!JSON.stringify(result).includes('private-diagnostic-canary'));
        }
      }
    }
    const repositoryDirectory = resolve(root, 'repository-transport');
    const scratchPath = resolve(root, 'repository-scratch');
    mkdirSync(repositoryDirectory, { mode: 0o700 });
    mkdirSync(scratchPath, { mode: 0o700 });
    let repositoryPhases = 0;
    let repositorySubmissions = 0;
    const ownedActivities: RepositoryActivity[] = [];
    const repositoryUsages: OpenAiUsage[] = [];
    const repository = startRepository(
      {
        executable: process.execPath,
        sha256: digest,
        directory: repositoryDirectory,
        repositoryRoot: root,
        environment: { HOME: root },
      },
      repositoryPlan({
        attemptId: plan(root).attemptId,
        model: 'gpt-6.1-sol',
        effort: 'low',
        scratchPath,
        sourceBase: 'a'.repeat(40),
        manifestHash: 'b'.repeat(64),
        execution: { sandbox: 'workspace-write', approvalPolicy: 'never', networkAccess: false },
        context: { title: 'Bound net', outcome: 'Return the net.', criteria: ['Keep the bound.'] },
        limits: repositoryLimits,
      }),
      {
        timeoutMs: 600_000,
        onSubmitted: () => {
          repositorySubmissions++;
        },
        onActivity: (activity) => {
          ownedActivities.push(activity);
        },
        onUsage: (usage) => {
          repositoryUsages.push(usage);
        },
        spawn: (executable, args, options) => {
          const phase =
            args.at(-1) === 'list' ? 'features' : ++repositoryPhases === 1 ? 'prepare' : 'task';
          const child = spawn(
            executable,
            [
              '-e',
              withUsage(
                repositoryFixture([
                  { path: 'net.mjs', content: 'export const net = 0;\n' },
                  { path: 'docs/note.md', content: '# Bounds\n' },
                ]),
              ),
              'success',
              phase,
            ],
            options,
          );
          owned.push({
            child,
            closed: new Promise((resolve) => child.once('close', () => resolve())),
          });
          return child;
        },
      },
    );
    const captured = await repository.result;
    assert.equal(captured.reason, null, JSON.stringify(captured));
    assert.equal(captured.quiescent, true);
    assert.deepEqual(captured.ignoredNotifications, {
      [methodHash('item/commandExecution/outputDelta')]: 3,
    });
    assert.equal(repositorySubmissions, 1);
    assert.deepEqual(repositoryUsages, delivered);
    assert.deepEqual(
      ownedActivities.map(({ kind, state }) => [kind, state]),
      [
        ['command', 'started'],
        ['command', 'completed'],
        ['file-change', 'started'],
        ['file-change', 'completed'],
      ],
    );
    assert.equal(repository.groups.length, 3);
    assert(repository.groups.every(groupAbsent));
    assert.equal(readFileSync(resolve(scratchPath, 'net.mjs'), 'utf8'), 'export const net = 0;\n');
    assert.equal(readFileSync(resolve(scratchPath, 'docs/note.md'), 'utf8'), '# Bounds\n');
    assert.throws(() => readFileSync(resolve(repositoryDirectory, 'net.mjs')));
    const directory = resolve(root, 'factory-deadline');
    mkdirSync(directory, { mode: 0o700 });
    let now = 0;
    let spawned = 0;
    const expired = startNativeTask(
      {
        executable: process.execPath,
        sha256: digest,
        directory,
        repositoryRoot: root,
        environment: { HOME: root },
      },
      {
        timeoutMs: 3000,
        now: () => now,
        onSubmitted: () => assert.fail('expired task must not submit'),
        schedule: () => () => {},
        spawn: (executable, args, options) => {
          spawned++;
          const child = spawn(
            executable,
            ['-e', fixture, 'success', args.at(-1) === 'list' ? 'features' : 'task'],
            options,
          );
          owned.push({
            child,
            closed: new Promise((resolve) => child.once('close', () => resolve())),
          });
          return child;
        },
      },
      () => {
        now = 2500;
        return {
          next: () => null,
          push: () => {},
          finish: () => null,
          complete: false,
          pendingRequest: 'turn/start',
          lastEnvelope: null,
          refusedEnvelope: null,
          notifications: 0,
        };
      },
    );
    const expiredResult = await expired.result;
    assert.equal(expiredResult.reason, 'deadline');
    assert.equal(expiredResult.quiescent, true);
    assert.equal(spawned, 1, 'reader construction cannot restart the original deadline');
  } finally {
    for (const { child } of owned)
      if (child.pid && !groupAbsent(child.pid)) process.kill(-child.pid, 'SIGKILL');
    await Promise.all(owned.map(({ closed }) => closed));
    assert(owned.every(({ child }) => !child.pid || groupAbsent(child.pid)));
    rmSync(root, { recursive: true, force: true });
  }
});
