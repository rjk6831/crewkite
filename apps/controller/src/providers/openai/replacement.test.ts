import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { groupAbsent } from '../../host/worker.ts';
import { startNativeTask } from './native-discovery.ts';
import { ReplacementTranscript, replacementPlan, startReplacement } from './replacement.ts';

const original = 'export function netMinor() { throw new Error(); }\n';
const plan = (directory: string) =>
  replacementPlan({
    attemptId: 'att_01M51M322B2AEBXD9MA74CBCFM',
    model: 'gpt-6.1-sol',
    effort: 'low',
    directory,
    original,
    baseHash: createHash('sha256').update(original).digest('hex'),
    criteria: ['Return the bounded replacement.'],
  });
const configuration = {
  model_provider: 'openai',
  service_tier: 'default',
  approval_policy: 'on-request',
  approvals_reviewer: 'user',
  sandbox_mode: 'read-only',
  web_search: 'disabled',
  chatgpt_base_url: 'https://chatgpt.com/backend-api/',
  openai_base_url: '',
  features: { plugins: false, remote_plugin: false, apps: false, hooks: false, multi_agent: false },
  mcp_servers: { fixture_server: { enabled: false } },
};
const replies: Record<string, unknown> = {
  initialize: { userAgent: 'private-data', platformFamily: 'unix', platformOs: 'fixture' },
  'account/read': { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true },
  'config/read': { config: configuration },
  'configRequirements/read': { requirements: null },
  'account/rateLimits/read': { ordinaryUsageAllowed: true, rateLimits: {} },
  'model/list': {
    data: [
      {
        id: 'gpt-6.1-sol',
        model: 'gpt-6.1-sol',
        displayName: 'model',
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        defaultReasoningEffort: 'low',
      },
    ],
    nextCursor: null,
  },
};
const threadResult = (directory: string) => ({
  thread: { id: 'thread-1', ephemeral: true },
  model: 'gpt-6.1-sol',
  modelProvider: 'openai',
  cwd: directory,
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: { type: 'readOnly' },
  reasoningEffort: 'low',
  serviceTier: 'default',
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
const running = { id: 'turn-1', status: 'inProgress', items: [], error: null };
const edit = (directory: string) => ({
  version: 1,
  attemptId: plan(directory).attemptId,
  path: 'net.mjs',
  baseHash: plan(directory).baseHash,
  content: 'export function netMinor(a, b) { return Math.max(0, a - b); }\n',
});
const output = (directory: string, mode = 'success') => {
  const value = edit(directory);
  if (mode === 'wrong-attempt') value.attemptId = 'att_01M51M322B2AEBXD9MA74CBCFN';
  if (mode === 'wrong-path') value.path = '../net.mjs';
  if (mode === 'wrong-hash') value.baseHash = '0'.repeat(64);
  if (mode === 'oversized') value.content = 'é'.repeat(32769);
  if (mode === 'surrogate') value.content = '\ud800';
  const item = {
    type: 'agentMessage',
    id: 'message-1',
    text: JSON.stringify(value),
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
  if (mode === 'duplicate') messages.splice(4, 0, messages[3]);
  if (mode === 'summary') item.text = 'The change is done.';
  if (mode === 'extra-field') item.text = JSON.stringify({ ...value, command: 'touch elsewhere' });
  if (mode === 'trailing') messages.push({ id: 11, result: { turn: running } });
  return messages;
};
const bytes = (message: unknown) => Buffer.from(`${JSON.stringify(message)}\n`);
function metadata(reader: ReplacementTranscript, overrides: Record<string, unknown> = {}) {
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

test('a replacement requires one matching completed turn and bounded original-file output', () => {
  for (const mode of [
    'success',
    'fragmented',
    'reasoning-retry',
    'thread-notices',
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
    const reader = new ReplacementTranscript(plan(directory), { now: () => 1, timeoutMs: 300_000 });
    const thread = metadata(reader);
    assert.equal(thread.params.sandbox, 'read-only');
    assert.equal(reader.submitted, false);
    reader.push(bytes({ id: 10, result: threadResult(directory) }));
    const request = JSON.parse(Buffer.from(reader.next() as Uint8Array).toString());
    assert.equal(request.method, 'turn/start');
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
      for (const message of output(directory, mode)) {
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
      mode === 'thread-notices'
    ) {
      const result = perform();
      assert.deepEqual(result.replacement, edit(directory));
      assert.equal(result.qualified, false);
      assert.equal(result.observedRetries, mode === 'reasoning-retry' ? 1 : 0);
      assert(!JSON.stringify(result).includes('private-data'));
      assert.equal(reader.next(), null);
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
      notice.method.startsWith('thread/environment/') || notice.method.startsWith('mcpServer/')
        ? 'other'
        : notice.method,
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
        method: canary,
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
  for (const ordinaryUsageAllowed of [false, undefined]) {
    const blocked = new ReplacementTranscript(plan(directory), {
      now: () => 1,
      timeoutMs: 300_000,
    });
    assert.throws(() =>
      metadata(blocked, {
        'account/rateLimits/read': {
          ordinaryUsageAllowed,
          rateLimits: { credits: { hasCredits: true, unlimited: false } },
        },
      }),
    );
    assert.equal(blocked.submitted, false);
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

const fixture = `
const { createInterface } = require('node:readline');
const mode = process.argv[1], phase = process.argv[2];
if (phase === 'features') {
  process.stdout.write(['plugins','remote_plugin','apps','hooks','multi_agent'].map(k => k+' stable false').join('\\n')+'\\n');
  process.exit(0);
}
const replies = ${JSON.stringify(replies)};
const thread = ${threadResult.toString()};
const running = ${JSON.stringify(running)};
const input = createInterface({input:process.stdin});
input.on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  if (message.method === 'turn/interrupt') {
    process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');
    return;
  }
  let result = replies[message.method];
  if (message.method === 'config/read') result = {config:{...replies['config/read'].config,mcp_servers:{fixture_server:{enabled:phase === 'prepare',command:'private-diagnostic-canary',env:{secret:'private-diagnostic-canary'}},...(mode === 'mcp-drift' && phase === 'task' ? {new_server:{enabled:true}} : {})}}};
  if (message.method === 'thread/start') result = thread(process.cwd());
  if (message.method === 'turn/start' && mode === 'rpc-error') {
    process.stdout.write(JSON.stringify({id:message.id,error:{code:-32602,message:'private-diagnostic-canary',data:{account:'private-diagnostic-canary'}}})+'\\n');
    return;
  }
  if (message.method === 'turn/start') result = {turn:running};
  process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
  if (message.method === 'turn/start' && mode === 'success') {
    const edit = {version:1,attemptId:message.params.outputSchema.properties.attemptId.const,path:'net.mjs',baseHash:message.params.outputSchema.properties.baseHash.const,content:'export function netMinor() { return 0; }\\n'};
    const item = {id:'message-1',type:'agentMessage',text:JSON.stringify(edit),phase:'final_answer'};
    for (const [method,params] of [
      ['turn/started',{threadId:'thread-1',turn:running}],
      ['item/started',{threadId:'thread-1',turnId:'turn-1',item:{...item,text:''},startedAtMs:1}],
      ['item/completed',{threadId:'thread-1',turnId:'turn-1',item,completedAtMs:2}],
      ['turn/completed',{threadId:'thread-1',turn:{...running,status:'completed'}}],
    ]) process.stdout.write(JSON.stringify({method,params})+'\\n');
  }
});
input.on('close',()=>process.exit(0));
`;

test('native task submission and interruption share one deadline through owned cleanup', async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const root = mkdtempSync(resolve('internal/replacement-owner-'));
  const digest = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const owned: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
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
            const child = spawn(executable, ['-e', fixture, mode, phase], options);
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
