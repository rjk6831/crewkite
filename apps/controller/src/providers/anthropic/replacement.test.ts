import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { hashCanonical, sealHandoff } from '@crewkite/contracts/hash';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import {
  ReplacementError,
  ReplacementStream,
  replacementPlan,
  startReplacement,
} from './replacement.ts';

const original = 'export const netMinor = () => 0;\n';
const input = {
  attemptId: 'att_00000000000000000000000001',
  sessionId: '46eb17cd-01e8-480d-99f4-a741f189715d',
  model: 'qualified-exact-model-id',
  baseHash: createHash('sha256').update(original).digest('hex'),
  original,
  criteria: ['Preserve integer minor amounts.'],
};
const plan = replacementPlan(input);
const edit = {
  version: 1,
  attemptId: input.attemptId,
  path: 'net.mjs',
  baseHash: input.baseHash,
  content: 'export const netMinor = () => 1;\n',
};
const init = {
  type: 'system',
  subtype: 'init',
  session_id: input.sessionId,
  model: input.model,
  tools: [],
  mcp_servers: [],
  plugins: [],
};
const result = {
  type: 'result',
  subtype: 'success',
  session_id: input.sessionId,
  is_error: false,
  structured_output: edit,
  permission_denials: [],
};
const status = {
  type: 'system',
  subtype: 'status',
  session_id: input.sessionId,
  uuid: '46eb17cd-01e8-480d-99f4-a741f189715f',
  status: 'requesting',
};
const invalidation = {
  type: 'system',
  subtype: 'ui_invalidate',
  session_id: input.sessionId,
  uuid: '46eb17cd-01e8-480d-99f4-a741f189715f',
  event: 'ui.render',
};
const thinking = {
  type: 'system',
  subtype: 'thinking_tokens',
  session_id: input.sessionId,
  uuid: '46eb17cd-01e8-480d-99f4-a741f189715f',
  estimated_tokens: 12,
  estimated_tokens_delta: 3,
};
const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const secret = 'private-account@example.test';
const user = {
  type: 'user',
  session_id: input.sessionId,
  parent_tool_use_id: null,
  message: { role: 'user', content: secret },
};
const rateLimit = {
  type: 'rate_limit_event',
  session_id: input.sessionId,
  uuid: '46eb17cd-01e8-480d-99f4-a741f189715f',
  rate_limit_info: { status: 'allowed', resetsAt: 123, utilization: 0.5 },
};
const usageEvent = (info: Record<string, unknown>) => ({
  ...rateLimit,
  rate_limit_info: { status: 'allowed', ...info },
});
const reading = (utilization: number, resetsAt: number) => ({ utilization, resetsAt });
const fiveHourReset = 1_792_000_000;
const weeklyReset = 1_792_500_000;
const fiveHour = (remainingPercent: number) => ({
  windowId: 'five_hour',
  kind: 'rolling',
  semantics: { scope: 'provider', periodSeconds: 18_000 },
  remainingPercent,
  resetsAt: '2026-10-14T17:46:40.000Z',
});
const sevenDay = (remainingPercent: number) => ({
  windowId: 'seven_day',
  kind: 'weekly',
  semantics: { scope: 'provider', periodSeconds: 604_800 },
  remainingPercent,
  resetsAt: '2026-10-20T12:40:00.000Z',
});

test('native text replacement stays bound to one proposal and owned task deadline', async () => {
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
  const retained = 'export const partial = 1;\n';
  const transferred = replacementPlan({
    ...input,
    original: retained,
    baseHash: createHash('sha256').update(retained).digest('hex'),
    handoff,
  });
  const transferredInput = JSON.parse(
    transferred.prompt.slice(transferred.prompt.indexOf('\n') + 1),
  );
  assert.deepEqual(transferredInput.handoff, handoff);
  assert.equal(transferredInput.original, retained);
  const transferredSchema = JSON.parse(
    transferred.argv[transferred.argv.indexOf('--json-schema') + 1],
  );
  assert.equal(transferredSchema.properties.baseHash.const, transferred.baseHash);
  const transferredReader = new ReplacementStream(transferred);
  transferredReader.push(line(init));
  transferredReader.push(
    line({ ...result, structured_output: { ...edit, baseHash: transferred.baseHash } }),
  );
  assert.equal(transferredReader.finish().replacement.baseHash, transferred.baseHash);
  for (const invalid of [
    { ...handoff, checksum: '0'.repeat(64) },
    { ...handoff, packet: { ...handoff.packet, private: 'unknown' } },
    oversizedHandoff,
  ])
    assert.throws(() => replacementPlan({ ...input, handoff: invalid }), ReplacementError);
  assert.equal(plan.timeoutMs, 300000);
  assert.deepEqual(JSON.parse(plan.argv[plan.argv.indexOf('--settings') + 1]), {
    disableAllHooks: true,
  });
  for (const [flag, value] of [
    ['--tools', ''],
    ['--setting-sources', ''],
    ['--permission-mode', 'default'],
    ['--permission-prompts', 'none'],
    ['--mcp-config', '{"mcpServers":{}}'],
    ['--model', input.model],
    ['--output-format', 'stream-json'],
  ])
    assert.equal(plan.argv[plan.argv.indexOf(flag) + 1], value);
  for (const flag of [
    '--safe-mode',
    '--restricted',
    '--strict-mcp-config',
    '--no-session-persistence',
  ])
    assert(plan.argv.includes(flag));
  for (const flag of [
    '--bare',
    '--max-turns',
    '--resume',
    '--continue',
    '--dangerously-skip-permissions',
  ])
    assert(!plan.argv.includes(flag));
  assert(!plan.argv.includes(original));
  assert.throws(() => replacementPlan({ ...input, original: 'changed' }), ReplacementError);
  assert.throws(() => replacementPlan({ ...input, model: '--bad' }), ReplacementError);
  assert.deepEqual(plan.input, input);
  for (const path of ['docs/日本 語.md', 'docs/"schema} instruction.md']) {
    const selected = replacementPlan({ ...input, path });
    const schema = JSON.parse(selected.argv[selected.argv.indexOf('--json-schema') + 1]);
    assert.equal(schema.properties.path.const, path);
    assert.equal(JSON.parse(selected.prompt.slice(selected.prompt.indexOf('\n') + 1)).path, path);
    const reader = new ReplacementStream(selected);
    reader.push(line(init));
    reader.push(line({ ...result, structured_output: { ...edit, path } }));
    assert.equal(reader.finish().replacement.path, path);
  }
  for (const path of ['../net.mjs', '/net.mjs', 'a\\b', 'a\0b', 'a\nb'])
    assert.throws(() => replacementPlan({ ...input, path }), ReplacementError);
  const nul = `${original}\0`;
  assert.throws(
    () =>
      replacementPlan({
        ...input,
        original: nul,
        baseHash: createHash('sha256').update(nul).digest('hex'),
      }),
    ReplacementError,
  );
  // Progress and display frames carry content and a proposal-shaped field that must not surface.
  const progress = (type: string, subtype?: string) => ({
    type,
    ...(subtype ? { subtype } : {}),
    session_id: input.sessionId,
    uuid: status.uuid,
    content: secret,
    structured_output: { ...edit, content: secret },
  });
  const named = (names: Array<[string, string?]>) => ({
    frames: names.map(([type, subtype]) => progress(type, subtype)),
    names: names.map(([type, subtype]) => (subtype ? `${type}/${subtype}` : type)),
  });
  const tally = (names: string[]) => {
    const counts: Record<string, number> = {};
    for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  };
  const { frames: earlyFrames, names: earlyNames } = named([
    ['system', 'ui_invalidate'],
    ['system', 'hook_started'],
    ['tool_progress'],
  ]);
  const { frames: laterFrames, names: laterNames } = named([
    ...[
      'status',
      'thinking_tokens',
      'notification',
      'compact_boundary',
      'api_error',
      'task_started',
      'task_notification',
      'hook_response',
      'session_state_changed',
      'permission_retry',
      'ui_invalidate',
      'unrecognized_subtype',
    ].map((subtype): [string, string] => ['system', subtype]),
    ...[
      'stream_event',
      'tool_progress',
      'auth_status',
      'tool_use_summary',
      'prompt_suggestion',
      'conversation_reset',
      'future_frame',
    ].map((type): [string] => [type]),
  ]);
  const cases: Array<{
    name: string;
    frames: unknown[];
    pass?: boolean;
    toolsEmpty?: boolean;
    pluginsEmpty?: boolean;
    retries?: number;
    diagnostic?: Record<string, unknown>;
    ignored?: Record<string, number>;
    usage?: unknown[];
    usageAccepted?: boolean[];
    failingHook?: boolean;
  }> = [
    { name: 'valid', frames: [init, result], pass: true },
    {
      name: 'progress frames the pinned client defines leave a correlated proposal intact',
      frames: [...earlyFrames, init, ...laterFrames, result],
      pass: true,
      ignored: tally([...earlyNames, ...laterNames]),
    },
    {
      name: 'ignored frame names are counted within a fixed ceiling',
      frames: [
        init,
        ...Array.from({ length: 40 }, (_, index) => progress(`future_frame_${index}`)),
        progress('future_frame_0'),
        result,
      ],
      pass: true,
      ignored: {
        ...tally(Array.from({ length: 32 }, (_, index) => `future_frame_${index}`)),
        future_frame_0: 2,
        other: 8,
      },
    },
    {
      name: 'progress frames after the result leave the proposal intact',
      frames: [init, result, ...laterFrames],
      pass: true,
      ignored: tally(laterNames),
    },
    {
      name: 'progress after the result stays session bound',
      frames: [init, result, { ...status, session_id: '46eb17cd-01e8-480d-99f4-a741f189715e' }],
      diagnostic: {
        stage: 'complete',
        site: 'identity',
        cause: 'correlation',
        field: 'session_id',
      },
    },
    {
      name: 'a second result after progress stays refused',
      frames: [init, result, status, result],
      diagnostic: { stage: 'complete' },
    },
    ...[
      {
        type: 'assistant',
        session_id: input.sessionId,
        message: { role: 'assistant', content: [] },
      },
      {
        type: 'system',
        subtype: 'api_retry',
        session_id: input.sessionId,
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 1000,
      },
      { type: 'system', subtype: 'model_fallback', session_id: input.sessionId },
    ].map((frame) => ({
      name: `${frame.subtype ?? frame.type} after the result stays refused`,
      frames: [init, result, frame],
      diagnostic: { stage: 'complete', cause: 'unsupported' },
    })),
    { name: 'display invalidation cannot initialize a session', frames: [invalidation, result] },
    { name: 'display invalidation cannot complete a proposal', frames: [init, invalidation] },
    ...[[], [init]].flatMap((prefix) =>
      [undefined, '46eb17cd-01e8-480d-99f4-a741f189715e'].map((session_id) => ({
        name: `display invalidation session ${prefix.length}/${session_id ?? 'missing'} stays bound`,
        frames: [...prefix, { ...invalidation, session_id }, result],
        diagnostic: { site: 'identity', field: 'session_id' },
      })),
    ),
    {
      name: 'a host request after init stays refused',
      frames: [
        init,
        {
          type: 'control_request',
          request_id: 'request-1',
          session_id: input.sessionId,
          request: { subtype: 'can_use_tool', tool_name: secret },
        },
        result,
      ],
      diagnostic: { stage: 'output', envelope: 'control_request', field: 'type' },
    },
    ...[
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ].map((subtype) => ({
      name: `failed result ${subtype} stays refused after progress`,
      frames: [
        init,
        status,
        { type: 'result', subtype, is_error: true, session_id: input.sessionId, errors: [secret] },
      ],
      diagnostic: { site: 'result', envelope: 'result', subtype },
    })),
    {
      name: 'request status is progress only',
      frames: [init, status, result],
      pass: true,
      ignored: { 'system/status': 1 },
    },
    {
      name: 'compaction metadata is discarded without validation',
      frames: [
        init,
        {
          ...status,
          status: 'compacting',
          compact_output_chars: 123,
          compact_result: 'failed',
          compact_error: secret,
        },
        { ...status, status: null, permissionMode: 'default' },
        { ...status, status: secret, uuid: secret, compact_output_chars: -1, command: secret },
        result,
      ],
      pass: true,
      ignored: { 'system/status': 3 },
    },
    ...['bypassPermissions', 'acceptEdits'].map((permissionMode) => ({
      name: `status reporting ${permissionMode} cannot change the permission mode`,
      frames: [init, { ...status, permissionMode }, result],
      diagnostic: { stage: 'output', site: 'status', subtype: 'status', field: 'permissionMode' },
    })),
    {
      name: 'status cannot initialize a session',
      frames: [status, result],
      diagnostic: { stage: 'before-init', site: 'init', envelope: 'result' },
    },
    { name: 'status cannot complete a proposal', frames: [init, status] },
    {
      name: 'thinking estimates are discarded without usage or proposal authority',
      frames: [
        init,
        thinking,
        { ...thinking, user_message_uuid: secret },
        { ...thinking, estimated_tokens: 0, estimated_tokens_delta: 0 },
        {
          ...thinking,
          estimated_tokens: Number.MAX_SAFE_INTEGER,
          estimated_tokens_delta: Number.MIN_SAFE_INTEGER,
        },
        { ...thinking, estimated_tokens: secret, uuid: secret, estimated_tokens_delta: 0.5 },
        result,
      ],
      pass: true,
      ignored: { 'system/thinking_tokens': 5 },
    },
    { name: 'thinking estimates cannot complete a proposal', frames: [init, thinking] },
    ...[undefined, '46eb17cd-01e8-480d-99f4-a741f189715e'].map((session_id) => ({
      name: `thinking estimate session ${session_id ?? 'missing'} remains bound`,
      frames: [init, { ...thinking, session_id }, result],
      diagnostic: { site: 'identity', field: 'session_id' },
    })),
    {
      name: 'status remains session bound',
      frames: [init, { ...status, session_id: '46eb17cd-01e8-480d-99f4-a741f189715e' }, result],
      diagnostic: { site: 'identity', cause: 'correlation', field: 'session_id' },
    },
    ...[
      'model_fallback',
      'model_consent_fallback',
      'model_refusal_fallback',
      'model_refusal_no_fallback',
    ].map((subtype) => ({
      name: `model change ${subtype} stays refused and identifiable`,
      frames: [
        init,
        { type: 'system', subtype, session_id: input.sessionId, content: secret },
        result,
      ],
      diagnostic: {
        stage: 'output',
        site: 'system',
        cause: 'unsupported',
        subtype,
        field: 'subtype',
      },
    })),

    {
      name: 'different regular path',
      frames: [init, { ...result, structured_output: { ...edit, path: 'other.mjs' } }],
    },
    {
      name: 'NUL output',
      frames: [init, { ...result, structured_output: { ...edit, content: 'a\0b' } }],
    },
    { name: 'user text is discarded output', frames: [init, user, result], pass: true },
    {
      name: 'native formatter result is discarded output',
      frames: [
        init,
        {
          type: 'assistant',
          session_id: input.sessionId,
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'formatter-1', name: 'StructuredOutput', input: edit },
            ],
          },
        },
        {
          ...user,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'formatter-1', content: secret }],
          },
          tool_use_result: { private: secret },
        },
        result,
      ],
      pass: true,
    },
    { name: 'user output needs init', frames: [user, result] },
    { name: 'user output cannot follow terminal result', frames: [init, result, user] },
    {
      name: 'user output cannot seal a proposal',
      frames: [init, { ...user, message: { role: 'user', content: JSON.stringify(edit) } }],
    },
    {
      name: 'user output session remains bound',
      frames: [init, { ...user, session_id: '46eb17cd-01e8-480d-99f4-a741f189715e' }, result],
    },
    {
      name: 'user output role remains bound',
      frames: [init, { ...user, message: { role: 'assistant', content: secret } }, result],
    },
    {
      name: 'subagent user output remains refused',
      frames: [init, { ...user, parent_tool_use_id: 'foreign-tool' }, result],
    },
    {
      name: 'replayed user output remains refused',
      frames: [init, { ...user, isReplay: true }, result],
    },
    {
      name: 'user output blocks remain bounded',
      frames: [
        init,
        { ...user, message: { role: 'user', content: Array(129).fill(secret) } },
        result,
      ],
    },
    {
      name: 'rate limit metadata grants no proposal authority',
      frames: [
        init,
        { ...rateLimit, rate_limit_info: { ...rateLimit.rate_limit_info, private: secret } },
        result,
      ],
      pass: true,
    },
    {
      name: 'included subscription window remains metadata',
      frames: [
        init,
        {
          ...rateLimit,
          rate_limit_info: {
            status: 'allowed',
            rateLimitType: 'seven_day_overage_included',
            isUsingOverage: false,
            overageInUse: false,
            overageEnabled: false,
          },
        },
        result,
      ],
      pass: true,
    },
    {
      name: 'extra usage configuration does not report served paid usage',
      frames: [
        init,
        usageEvent({
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          overageEnabled: true,
          isUsingOverage: false,
          overageInUse: false,
          unifiedWindows: { five_hour: reading(0.75, fiveHourReset) },
        }),
        result,
      ],
      pass: true,
      usage: [{ windows: [fiveHour(25)], paid: null }],
    },
    {
      name: 'extra usage configuration supplies no usage reading',
      frames: [init, usageEvent({ overageEnabled: true }), result],
      pass: true,
    },
    ...['allowed', 'allowed_warning'].map((overageStatus) => ({
      name: `served grace overflow with ${overageStatus} paid usage stops included-only task`,
      frames: [init, usageEvent({ rateLimitGraceActive: true, overageStatus }), result],
      diagnostic: { site: 'rate-limit', cause: 'unsupported', field: 'rateLimitGraceActive' },
    })),
    ...[undefined, 'rejected', 'future_status'].map((overageStatus) => ({
      name: `grace metadata with ${overageStatus ?? 'unreported'} paid status supplies no paid-use proof`,
      frames: [init, usageEvent({ rateLimitGraceActive: true, overageStatus }), result],
      pass: true,
    })),
    ...['isUsingOverage', 'overageInUse', 'overageEnabled', 'rateLimitGraceActive'].map(
      (field) => ({
        name: `rate limit ${field} rejects malformed flags`,
        frames: [init, usageEvent({ [field]: secret }), result],
        diagnostic: { site: 'rate-limit', cause: 'validation', field },
      }),
    ),
    {
      name: 'extra usage configuration cannot initialize or complete a task',
      frames: [usageEvent({ overageEnabled: true }), result],
    },
    {
      name: 'extra usage configuration still needs terminal result',
      frames: [init, usageEvent({ overageEnabled: true })],
    },
    {
      name: 'extra usage configuration after the result leaves the proposal intact',
      frames: [init, result, usageEvent({ overageEnabled: true })],
      pass: true,
    },
    {
      name: 'a window reading after the result still reaches the usage hook',
      frames: [
        init,
        result,
        usageEvent({ unifiedWindows: { five_hour: reading(0.25, fiveHourReset) } }),
      ],
      pass: true,
      usage: [{ windows: [fiveHour(75)], paid: null }],
    },
    ...[
      { isUsingOverage: true },
      { overageInUse: true },
      { rateLimitType: 'overage' },
      { rateLimitGraceActive: true, overageStatus: 'allowed' },
    ].map((info) => ({
      name: `reported paid use ${Object.keys(info)[0]} after the result refuses the proposal`,
      frames: [init, result, usageEvent(info)],
      diagnostic: { stage: 'complete', site: 'rate-limit', cause: 'unsupported' },
    })),
    ...['isUsingOverage', 'overageInUse'].map((field) => ({
      name: `reported ${field} stops included-only task`,
      frames: [
        init,
        {
          ...rateLimit,
          rate_limit_info: { status: 'allowed', overageEnabled: true, [field]: true },
        },
        result,
      ],
      diagnostic: { site: 'rate-limit', cause: 'unsupported', field },
    })),
    {
      name: 'usage credit window stops included-only task',
      frames: [
        init,
        {
          ...rateLimit,
          rate_limit_info: { status: 'allowed', rateLimitType: 'overage', overageEnabled: true },
        },
        result,
      ],
      diagnostic: { site: 'rate-limit', cause: 'unsupported', field: 'rateLimitType' },
    },
    {
      name: 'a window reading reaches the usage hook once per process',
      frames: [
        init,
        usageEvent({
          unifiedWindows: {
            five_hour: reading(0.25, fiveHourReset),
            seven_day: reading(0.5, weeklyReset),
          },
        }),
        // A status change sends both readings again, unchanged.
        usageEvent({
          status: 'allowed_warning',
          rateLimitType: 'seven_day',
          utilization: 0.5,
          resetsAt: weeklyReset,
          unifiedWindows: {
            five_hour: reading(0.25, fiveHourReset),
            seven_day: reading(0.5, weeklyReset),
          },
        }),
        // The weekly reading rides along within the same whole percent.
        usageEvent({
          unifiedWindows: {
            five_hour: reading(0.5, fiveHourReset),
            seven_day: reading(0.5004, weeklyReset),
          },
        }),
        // A top-level reading held since an earlier response.
        usageEvent({
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          utilization: 0.5004,
          resetsAt: fiveHourReset,
        }),
        result,
      ],
      pass: true,
      usage: [
        { windows: [fiveHour(75), sevenDay(50)], paid: null },
        { windows: [fiveHour(50)], paid: null },
      ],
    },
    {
      name: 'a refused usage reading returns until its replay is accepted',
      frames: [
        init,
        usageEvent({ unifiedWindows: { five_hour: reading(0.25, fiveHourReset) } }),
        usageEvent({ unifiedWindows: { five_hour: reading(0.25, fiveHourReset) } }),
        usageEvent({ unifiedWindows: { five_hour: reading(0.25, fiveHourReset) } }),
        result,
      ],
      pass: true,
      usageAccepted: [false, true],
      usage: [
        { windows: [fiveHour(75)], paid: null },
        { windows: [fiveHour(75)], paid: null },
      ],
    },
    {
      name: 'a malformed usage reading adds nothing and the task continues',
      frames: [init, usageEvent({ unifiedWindows: { five_hour: reading(0.25, 1.5) } }), result],
      pass: true,
    },
    {
      name: 'a failing usage hook leaves the task unchanged',
      frames: [
        init,
        usageEvent({ unifiedWindows: { five_hour: reading(0.25, fiveHourReset) } }),
        result,
      ],
      pass: true,
      failingHook: true,
      usage: [{ windows: [fiveHour(75)], paid: null }],
    },
    {
      name: 'included readings beside paid credits reach the hook and the refusal stands',
      frames: [
        init,
        usageEvent({
          isUsingOverage: true,
          unifiedWindows: { five_hour: reading(1, fiveHourReset) },
        }),
        result,
      ],
      diagnostic: { site: 'rate-limit', cause: 'unsupported', field: 'isUsingOverage' },
      usage: [{ windows: [fiveHour(0)], paid: { inUse: true, usedPercent: null, resetsAt: null } }],
    },
    { name: 'rate limit metadata needs terminal result', frames: [init, rateLimit] },
    { name: 'rate limit metadata needs init', frames: [rateLimit, result] },
    {
      name: 'rate limit session remains bound',
      frames: [init, { ...rateLimit, session_id: '46eb17cd-01e8-480d-99f4-a741f189715e' }, result],
    },
    {
      name: 'rate limit labels from a newer client stay advisory',
      frames: [
        init,
        usageEvent({
          status: secret,
          rateLimitType: secret,
          overageStatus: secret,
          overageDisabledReason: secret,
          limitScope: secret,
          errorCode: secret,
          utilization: 0.5,
          resetsAt: fiveHourReset,
        }),
        usageEvent({
          rateLimitType: 'future_window',
          utilization: 0.9,
          unifiedWindows: { five_hour: reading(0.25, fiveHourReset) },
        }),
        result,
      ],
      pass: true,
      usage: [{ windows: [fiveHour(75)], paid: null }],
    },
    ...[
      'status',
      'rateLimitType',
      'overageStatus',
      'overageDisabledReason',
      'limitScope',
      'errorCode',
    ].map((label) => ({
      name: `rate limit ${label} label remains bounded`,
      frames: [init, usageEvent({ [label]: 'x'.repeat(129) }), result],
      diagnostic: { site: 'rate-limit', cause: 'validation' },
    })),
    ...['resetsAt', 'utilization', 'overageResetsAt', 'surpassedThreshold'].map((field) => ({
      name: `rate limit ${field} remains bounded`,
      frames: [init, { ...rateLimit, rate_limit_info: { status: 'allowed', [field]: -1 } }, result],
    })),
    ...['user', 'rate_limit_event'].map((type) => ({
      name: `known ${type} refusal stays finite`,
      frames: [init, { type, session_id: input.sessionId, content: secret }],
      diagnostic: { envelope: type },
    })),
    {
      name: 'formatter output is data only',
      frames: [
        init,
        {
          type: 'assistant',
          session_id: input.sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: secret, input: { secret } }],
          },
        },
        result,
      ],
      pass: true,
    },
    {
      name: 'reported tool is not absence proof',
      frames: [{ ...init, tools: ['StructuredOutput'] }, result],
      pass: true,
      toolsEmpty: false,
    },
    {
      name: 'ordinary retry remains one task',
      retries: 1,
      frames: [
        init,
        {
          type: 'system',
          subtype: 'api_retry',
          session_id: input.sessionId,
          attempt: 1,
          max_retries: 10,
          retry_delay_ms: 1000,
        },
        result,
      ],
      pass: true,
    },
    {
      name: 'model refusal before init stays refused with finite diagnostics',
      frames: [
        {
          type: 'system',
          subtype: 'model_refusal_no_fallback',
          session_id: input.sessionId,
          reason: secret,
        },
      ],
      diagnostic: {
        stage: 'before-init',
        site: 'init',
        cause: 'validation',
        envelope: 'system',
        subtype: 'model_refusal_no_fallback',
        field: 'subtype',
      },
    },
    {
      name: 'unknown subtype and arbitrary field remain private',
      frames: [{ ...init, subtype: secret, [secret]: secret }],
      diagnostic: {
        stage: 'before-init',
        site: 'init',
        cause: 'validation',
        envelope: 'system',
        subtype: 'other',
        field: 'subtype',
      },
    },
    { name: 'missing init', frames: [result] },
    { name: 'wrong model', frames: [{ ...init, model: 'other' }, result] },
    { name: 'MCP forbidden', frames: [{ ...init, mcp_servers: [{ name: secret }] }, result] },
    {
      name: 'reported plugins are metadata under native trust',
      frames: [{ ...init, plugins: [{ name: secret, path: secret }] }, result],
      pass: true,
      pluginsEmpty: false,
    },
    {
      name: 'wrong session',
      diagnostic: { site: 'identity', cause: 'correlation', field: 'session_id' },
      frames: [init, { ...result, session_id: '46eb17cd-01e8-480d-99f4-a741f189715e' }],
    },
    {
      name: 'wrong attempt',
      frames: [
        init,
        { ...result, structured_output: { ...edit, attemptId: 'att_00000000000000000000000002' } },
      ],
    },
    {
      name: 'wrong base',
      frames: [init, { ...result, structured_output: { ...edit, baseHash: '0'.repeat(64) } }],
    },
    {
      name: 'wrong path',
      frames: [init, { ...result, structured_output: { ...edit, path: '../net.mjs' } }],
    },
    {
      name: 'extra replacement authority',
      frames: [init, { ...result, structured_output: { ...edit, command: secret } }],
    },
    {
      name: 'content UTF8 byte bound',
      frames: [init, { ...result, structured_output: { ...edit, content: '界'.repeat(22000) } }],
    },
    {
      name: 'invalid scalar content',
      frames: [init, { ...result, structured_output: { ...edit, content: '\ud800' } }],
    },
    {
      name: 'missing structured output',
      frames: [init, { ...result, structured_output: undefined }],
    },
    { name: 'error result', frames: [init, { ...result, is_error: true }] },
    {
      name: 'denial result',
      frames: [init, { ...result, permission_denials: [{ tool_name: secret }] }],
    },
    { name: 'duplicate result', frames: [init, result, result] },
    {
      name: 'external request',
      frames: [
        init,
        { type: 'control_request', request: { subtype: 'can_use_tool', tool_name: secret } },
      ],
    },
    {
      name: 'unknown frame',
      frames: [init, { type: secret }],
      diagnostic: {
        stage: 'output',
        site: 'identity',
        envelope: 'other',
        subtype: null,
        field: 'session_id',
      },
    },
    ...[
      { type: secret },
      { type: 'FutureFrame' },
      { type: 'system' },
      { type: 'system', subtype: secret },
    ].map((frame, index) => ({
      name: `frame without a protocol name ${index} stays refused and private`,
      frames: [init, { ...frame, session_id: input.sessionId }, result],
      diagnostic: { stage: 'output', envelope: frame.type === 'system' ? 'system' : 'other' },
    })),
    {
      name: 'an unlisted result subtype is reported by its protocol name',
      frames: [
        init,
        {
          type: 'result',
          subtype: 'error_future_limit',
          is_error: true,
          session_id: input.sessionId,
        },
      ],
      diagnostic: { site: 'result', envelope: 'result', subtype: 'error_future_limit' },
    },
    ...[
      { label: 'plain identifier', name: 'future_frame', reported: 'future_frame' },
      { label: 'identifier of 64 characters', name: 'a'.repeat(64), reported: 'a'.repeat(64) },
      { label: 'identifier of 65 characters', name: 'a'.repeat(65), reported: 'other' },
      { label: 'upper case letter', name: 'Future_frame', reported: 'other' },
      { label: 'hyphen', name: 'future-frame', reported: 'other' },
      { label: 'leading digit', name: '1_future_frame', reported: 'other' },
      { label: 'empty string', name: '', reported: 'other' },
      { label: 'account text', name: secret, reported: 'other' },
    ].map(({ label, name, reported }) => ({
      name: `frame name with ${label} reports ${reported === 'other' ? 'other' : 'itself'}`,
      frames: [
        init,
        { type: name, subtype: name, session_id: '46eb17cd-01e8-480d-99f4-a741f189715e' },
        result,
      ],
      diagnostic: { site: 'identity', cause: 'correlation', envelope: reported, subtype: reported },
    })),
    { name: 'missing result', frames: [init] },
  ];
  for (const row of cases) {
    const reported: unknown[] = [];
    const reader = new ReplacementStream(plan, (usage) => {
      reported.push(usage);
      if (row.failingHook) throw new Error(secret);
      return row.usageAccepted?.[reported.length - 1];
    });
    try {
      for (const frame of row.frames) {
        const bytes = line(frame);
        reader.push(bytes.subarray(0, 7));
        reader.push(bytes.subarray(7));
      }
      const output = reader.finish();
      assert.equal(row.pass, true, row.name);
      assert.deepEqual(output.replacement, edit, row.name);
      assert.equal(output.nativeToolsReportedEmpty, row.toolsEmpty ?? true, row.name);
      assert.equal(output.nativePluginsReportedEmpty, row.pluginsEmpty ?? true, row.name);
      assert.equal(output.qualified, false, row.name);
      assert.equal(output.observedRetries, row.retries ?? 0, row.name);
      assert.deepEqual(output.ignoredFrames, row.ignored ?? {}, row.name);
      assert(!JSON.stringify(output).includes(secret), row.name);
    } catch (error) {
      if (!(error instanceof ReplacementError)) throw error;
      assert(!row.pass, row.name);
      assert(!error.message.includes(secret), row.name);
      const diagnostic = reader.diagnostic;
      assert(diagnostic, row.name);
      assert(Object.isFrozen(diagnostic), row.name);
      assert.equal(error.diagnostic, diagnostic, row.name);
      assert(!JSON.stringify(diagnostic).includes(secret), row.name);
      for (const [key, value] of Object.entries(row.diagnostic ?? {}))
        assert.equal(diagnostic[key as keyof typeof diagnostic], value, row.name);
      assert.throws(
        () => reader.finish(),
        (later: unknown) => later instanceof ReplacementError && later.diagnostic === diagnostic,
        row.name,
      );
      assert.throws(
        () => reader.push(line(result)),
        (later: unknown) => later instanceof ReplacementError && later.diagnostic === diagnostic,
        row.name,
      );
    }
    assert.deepEqual(reported, row.usage ?? [], row.name);
  }
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff, 10]), Buffer.alloc(1048577, 32)]) {
    const reader = new ReplacementStream(plan);
    assert.throws(() => {
      reader.push(bytes);
      reader.finish();
    }, ReplacementError);
  }
  mkdirSync(resolve('internal'), { recursive: true });
  const root = mkdtempSync(resolve('internal/replacement-'));
  const sha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const owned: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
  const frames = JSON.stringify([init, result]);
  const fixture = `
const {spawn}=require('node:child_process');const {MessageChannel}=require('node:worker_threads');
const mode=process.argv[1],frames=${frames};const hold=()=>{const channel=new MessageChannel();channel.port1.on('message',()=>{});};
process.stdin.resume();process.stdin.once('end',()=>{
if(mode.startsWith('late-kill'))process.on('SIGTERM',()=>{});
if(mode==='refusal')return process.stdout.write(JSON.stringify({type:'system',subtype:'model_refusal_no_fallback',session_id:frames[0].session_id,reason:${JSON.stringify(secret)}})+'\\n');
if(mode==='limit')return process.stdout.write(Buffer.alloc(1048577,32));
if(mode==='stderr')return process.stderr.write(Buffer.alloc(16385,32));
if(mode==='descendant'){const child=spawn(process.execPath,['-e',"const{MessageChannel}=require('node:worker_threads');process.on('SIGTERM',()=>{});const c=new MessageChannel();c.port1.on('message',()=>{});process.send('ready');"],{stdio:['inherit','inherit','inherit','ipc']});child.once('message',()=>process.stdout.write(frames.map(x=>JSON.stringify(x)).join('\\n')+'\\n',()=>process.exit(0)));return;}
process.stdout.write(frames.map(x=>JSON.stringify(x)).join('\\n')+'\\n',()=>{if(mode==='deadline'||mode==='stop'||mode==='queued-close'||mode.startsWith('late-kill'))hold();else if(mode==='trailing')process.stdout.write('{',()=>process.exit(0));else process.exit(mode==='exit' ? 1 : 0);});});`;
  try {
    for (const mode of [
      'success',
      'refusal',
      'descendant',
      'deadline',
      'stop',
      'limit',
      'stderr',
      'trailing',
      'exit',
      'owned-throw',
      'owned-promise',
      'owned-deadline',
      'submitted-throw',
      'submitted-promise',
      'submitted-thenable',
      'submitted-deadline',
      'quiescent-throw',
      'quiescent-promise',
      'quiescent-deadline',
      'write-failure',
      'queued-close',
      'late-kill',
      'late-kill-reversed',
      'late-kill-near-deadline',
    ]) {
      const directory = join(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      let deadline: (() => void) | undefined;
      let time = 0;
      const trace: string[] = [];
      // These rows drive the stop timers by hand, so no real timer can run ahead of them.
      const manual = mode === 'queued-close' || mode.startsWith('late-kill');
      const shortened =
        mode.includes('deadline') && mode !== 'deadline' && !mode.startsWith('late');
      const timers: Array<{ delay: number; work: () => void; live: boolean }> = [];
      let callbackError: unknown;
      // Every due callback is found before the first one runs, so the order stays the test's.
      const fire = (order: number[]) => {
        const due = order.map((delay) => {
          const row = timers.find((timer) => timer.live && timer.delay === delay);
          assert(row, `${mode}: pending ${delay}ms callback`);
          return row;
        });
        for (const row of due) row.work();
      };
      let received!: () => void;
      const output = new Promise<void>((resolve) => {
        received = resolve;
      });
      const handle = startReplacement(
        {
          executable: process.execPath,
          sha256,
          repositoryRoot: root,
          directory,
          environment: { HOME: root, USER: secret, ANTHROPIC_API_KEY: secret },
          plan: { ...plan, argv: ['--dangerously-skip-permissions'] },
        },
        {
          now: () => time,
          ...(shortened ? { deadline: 6000 } : {}),
          lifecycle: {
            beforePhase: (kind) => {
              assert.equal(kind, 'task');
              trace.push('before');
            },
            owned: (kind, group) => {
              assert.equal(kind, 'task');
              trace.push('owned');
              const child = owned.at(-1)?.child;
              assert.equal(child?.pid, group);
              assert(
                child && child.listenerCount('error') > 0 && child.stdin.listenerCount('error') > 0,
              );
              if (mode === 'owned-throw') throw Error(secret);
              if (mode === 'owned-promise') return Promise.reject(Error(secret));
              if (mode === 'owned-deadline') time = 5000;
            },
            quiescent: (kind, group) => {
              assert.equal(kind, 'task');
              assert(groupAbsent(group));
              trace.push('quiescent');
              if (mode === 'quiescent-throw') throw Error(secret);
              if (mode === 'quiescent-promise') return Promise.reject(Error(secret));
              if (mode === 'quiescent-deadline') time = 6000;
            },
          },
          onSubmitted: () => {
            trace.push('submitted');
            if (mode === 'submitted-throw') throw Error(secret);
            if (mode === 'submitted-promise') return Promise.reject(Error(secret));
            if (mode === 'submitted-thenable')
              return {
                // biome-ignore lint/suspicious/noThenProperty: This fixture proves thenable hooks are refused.
                then: (_resolve: unknown, reject: (error: Error) => void) => reject(Error(secret)),
              };
            if (mode === 'submitted-deadline') time = 5000;
          },
          schedule: (work, delay) => {
            if (delay === (shortened ? 4000 : 298000)) {
              deadline = work;
              return () => {
                deadline = undefined;
              };
            }
            if (manual) {
              const row = { delay, work, live: true };
              timers.push(row);
              return () => {
                row.live = false;
              };
            }
            const timer = setTimeout(work, delay);
            return () => clearTimeout(timer);
          },
          spawn: ((executable: string, argv: string[], options: Parameters<typeof spawn>[2]) => {
            assert.equal(executable, process.execPath);
            assert.deepEqual(argv, plan.argv);
            const env = (options as { env: NodeJS.ProcessEnv }).env;
            assert.equal(env.USER, userInfo().username);
            assert.equal(env.HOME, root);
            assert.equal(env.ANTHROPIC_API_KEY, undefined);
            assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
            const child = spawn(
              process.execPath,
              ['-e', fixture, mode],
              options as { detached: true; stdio: ['pipe', 'pipe', 'pipe'] },
            );
            child.stdout.once('data', () => received());
            owned.push({ child, closed: new Promise((resolve) => child.once('close', resolve)) });
            // This listener runs before the process handler's own. The cutoff then meets an
            // exited group whose stream-close event is still queued.
            if (mode === 'queued-close')
              child.once('exit', () => {
                try {
                  time = 2000;
                  fire([1000, 2000]);
                } catch (error) {
                  callbackError = error;
                }
              });
            const end = child.stdin.end;
            child.stdin.end = function (...args: unknown[]) {
              if (typeof args[0] === 'string') {
                trace.push('write');
                if (mode === 'write-failure') throw Error(secret);
              }
              return Reflect.apply(end, this, args);
            };
            return child;
          }) as typeof spawn,
        },
      );
      if (mode === 'deadline' || mode === 'stop' || manual) {
        await output;
        if (mode === 'deadline') {
          assert(deadline);
          deadline();
        } else handle.stop();
      }
      if (mode.startsWith('late-kill')) {
        // A blocked loop runs the stop timers in one pass. Node runs one duration list at a
        // time, so an older 2000 ms list can reach the verdict before the kill.
        time = mode === 'late-kill-near-deadline' ? 299_500 : 2000;
        fire(mode === 'late-kill-reversed' ? [2000, 1000] : [1000, 2000]);
      }
      const outcome = await handle.result;
      assert.ifError(callbackError);
      if (manual) {
        if (mode === 'late-kill-near-deadline')
          assert(
            timers.some((timer) => timer.delay === 500),
            `${mode}: the late kill waits only until the deadline`,
          );
        assert.equal(
          timers.some((timer) => timer.live),
          false,
          `${mode}: settlement cancels every timer`,
        );
      }
      assert(outcome.quiescent, mode);
      assert(groupAbsent(handle.group), mode);
      assert(!JSON.stringify(outcome).includes(secret), mode);
      assert.deepEqual(trace.slice(0, 2), ['before', 'owned'], mode);
      assert.equal(trace.filter((step) => step === 'quiescent').length, 1, mode);
      assert.equal(
        trace.filter((step) => step === 'submitted').length,
        mode.startsWith('owned-') ? 0 : 1,
        mode,
      );
      const writes = trace.filter((step) => step === 'write').length;
      assert.equal(
        writes,
        mode.startsWith('owned-') || mode.startsWith('submitted-') ? 0 : 1,
        mode,
      );
      if (writes) assert.equal(trace.indexOf('submitted') + 1, trace.indexOf('write'), mode);
      if (mode === 'refusal')
        assert.deepEqual(outcome.diagnostic, {
          stage: 'before-init',
          site: 'init',
          cause: 'validation',
          envelope: 'system',
          subtype: 'model_refusal_no_fallback',
          field: 'subtype',
        });
      if (mode === 'success' || mode === 'descendant') {
        assert.equal(outcome.reason, null, mode);
        assert.deepEqual(outcome.proposal?.replacement, edit, mode);
      } else {
        assert.equal(outcome.proposal, null, mode);
        assert.equal(
          outcome.reason,
          (
            {
              deadline: 'deadline',
              stop: 'stopped',
              'queued-close': 'stopped',
              'late-kill': 'stopped',
              'late-kill-reversed': 'stopped',
              'late-kill-near-deadline': 'stopped',
              limit: 'limit',
              stderr: 'limit',
              trailing: 'protocol',
              refusal: 'protocol',
              exit: 'protocol',
              'owned-throw': 'ownership',
              'owned-promise': 'ownership',
              'owned-deadline': 'deadline',
              'submitted-throw': 'ownership',
              'submitted-promise': 'ownership',
              'submitted-thenable': 'ownership',
              'submitted-deadline': 'deadline',
              'quiescent-throw': 'ownership',
              'quiescent-promise': 'ownership',
              'quiescent-deadline': 'deadline',
              'write-failure': 'launch',
            } as Record<string, string>
          )[mode],
          mode,
        );
      }
    }
    for (const mode of [
      'expired',
      'validation-time',
      'before-time',
      'before-throw',
      'before-promise',
      'before-thenable',
    ]) {
      const directory = join(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      let time = 0;
      let ticks = 0;
      let launched = false;
      assert.throws(
        () =>
          startReplacement(
            {
              executable: process.execPath,
              sha256,
              repositoryRoot: root,
              directory,
              environment: { HOME: root },
              plan,
            },
            {
              deadline: mode === 'expired' ? 2000 : 6000,
              now: () => (mode === 'validation-time' && ++ticks > 2 ? 5000 : time),
              lifecycle: {
                beforePhase: () => {
                  if (mode === 'before-time') time = 5000;
                  if (mode === 'before-throw') throw Error(secret);
                  if (mode === 'before-promise') return Promise.reject(Error(secret));
                  if (mode === 'before-thenable')
                    return {
                      // biome-ignore lint/suspicious/noThenProperty: This fixture proves thenable hooks are refused.
                      then: (_resolve: unknown, reject: (error: Error) => void) =>
                        reject(Error(secret)),
                    };
                },
                owned: () => assert.fail('No child should be owned.'),
                quiescent: () => assert.fail('No child should close.'),
              },
              spawn: (() => {
                launched = true;
                throw Error(secret);
              }) as typeof spawn,
            },
          ),
        (error: unknown) =>
          error instanceof ReplacementError &&
          error.reason ===
            (mode.startsWith('before-') && mode !== 'before-time' ? 'ownership' : 'deadline'),
      );
      assert.equal(launched, false, mode);
    }
  } finally {
    for (const { child } of owned) {
      if (child.pid && !groupAbsent(child.pid)) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // An unreaped leader can refuse the signal. The closure check below still decides.
        }
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      Promise.all(owned.map((value) => value.closed)).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    clearTimeout(timer);
    assert(closed, 'owned fixture streams close within cleanup bound');
    assert(owned.every(({ child }) => !child.pid || groupAbsent(child.pid)));
    rmSync(root, { recursive: true, force: true });
  }
});
