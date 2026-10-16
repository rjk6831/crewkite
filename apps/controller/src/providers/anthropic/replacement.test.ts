import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
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
const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const secret = 'private-account@example.test';
const rateLimit = {
  type: 'rate_limit_event',
  session_id: input.sessionId,
  uuid: '46eb17cd-01e8-480d-99f4-a741f189715f',
  rate_limit_info: { status: 'allowed', resetsAt: 123, utilization: 0.5 },
};

test('native text replacement stays bound to one proposal and owned task deadline', async () => {
  assert.equal(plan.timeoutMs, 300000);
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
  const cases: Array<{
    name: string;
    frames: unknown[];
    pass?: boolean;
    toolsEmpty?: boolean;
    pluginsEmpty?: boolean;
    diagnostic?: Record<string, unknown>;
  }> = [
    { name: 'valid', frames: [init, result], pass: true },
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
    ...['isUsingOverage', 'overageInUse', 'overageEnabled'].map((field) => ({
      name: `reported ${field} stops included-only task`,
      frames: [
        init,
        { ...rateLimit, rate_limit_info: { status: 'allowed', [field]: true } },
        result,
      ],
      diagnostic: { site: 'rate-limit', cause: 'unsupported', field: 'rate_limit_info' },
    })),
    {
      name: 'usage credit window stops included-only task',
      frames: [
        init,
        { ...rateLimit, rate_limit_info: { status: 'allowed', rateLimitType: 'overage' } },
        result,
      ],
      diagnostic: { site: 'rate-limit', cause: 'unsupported', field: 'rate_limit_info' },
    },
    { name: 'rate limit metadata needs terminal result', frames: [init, rateLimit] },
    { name: 'rate limit metadata needs init', frames: [rateLimit, result] },
    {
      name: 'rate limit session remains bound',
      frames: [init, { ...rateLimit, session_id: '46eb17cd-01e8-480d-99f4-a741f189715e' }, result],
    },
    {
      name: 'unknown rate limit status',
      frames: [init, { ...rateLimit, rate_limit_info: { status: secret } }, result],
    },
    ...['resetsAt', 'utilization', 'overageResetsAt', 'surpassedThreshold'].map((field) => ({
      name: `rate limit ${field} remains bounded`,
      frames: [init, { ...rateLimit, rate_limit_info: { status: 'allowed', [field]: -1 } }, result],
    })),
    ...[
      'user',
      'stream_event',
      'tool_progress',
      'auth_status',
      'tool_use_summary',
      'rate_limit_event',
      'prompt_suggestion',
      'conversation_reset',
    ].map((type) => ({
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
      name: 'startup hook remains refused with finite diagnostics',
      frames: [
        { type: 'system', subtype: 'hook_started', session_id: input.sessionId, hook_name: secret },
      ],
      diagnostic: {
        stage: 'before-init',
        site: 'init',
        cause: 'validation',
        envelope: 'system',
        subtype: 'hook_started',
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
    { name: 'missing result', frames: [init] },
  ];
  for (const row of cases) {
    const reader = new ReplacementStream(plan);
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
if(mode==='refusal')return process.stdout.write(JSON.stringify({type:'system',subtype:'hook_started',session_id:frames[0].session_id,hook_name:${JSON.stringify(secret)},stdout:${JSON.stringify(secret)}})+'\\n');
if(mode==='limit')return process.stdout.write(Buffer.alloc(1048577,32));
if(mode==='stderr')return process.stderr.write(Buffer.alloc(16385,32));
if(mode==='descendant'){const child=spawn(process.execPath,['-e',"const{MessageChannel}=require('node:worker_threads');process.on('SIGTERM',()=>{});const c=new MessageChannel();c.port1.on('message',()=>{});process.send('ready');"],{stdio:['inherit','inherit','inherit','ipc']});child.once('message',()=>process.stdout.write(frames.map(x=>JSON.stringify(x)).join('\\n')+'\\n',()=>process.exit(0)));return;}
process.stdout.write(frames.map(x=>JSON.stringify(x)).join('\\n')+'\\n',()=>{if(mode==='deadline'||mode==='stop')hold();else if(mode==='trailing')process.stdout.write('{',()=>process.exit(0));else process.exit(mode==='exit' ? 1 : 0);});});`;
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
    ]) {
      const directory = join(root, mode);
      mkdirSync(directory, { mode: 0o700 });
      let deadline: (() => void) | undefined;
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
          now: () => 0,
          schedule: (work, delay) => {
            if (delay === 298000) {
              deadline = work;
              return () => {
                deadline = undefined;
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
            return child;
          }) as typeof spawn,
        },
      );
      if (mode === 'deadline' || mode === 'stop') {
        await output;
        if (mode === 'deadline') {
          assert(deadline);
          deadline();
        } else handle.stop();
      }
      const outcome = await handle.result;
      assert(outcome.quiescent, mode);
      assert(groupAbsent(handle.group), mode);
      assert(!JSON.stringify(outcome).includes(secret), mode);
      if (mode === 'refusal')
        assert.deepEqual(outcome.diagnostic, {
          stage: 'before-init',
          site: 'init',
          cause: 'validation',
          envelope: 'system',
          subtype: 'hook_started',
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
              limit: 'limit',
              stderr: 'limit',
              trailing: 'protocol',
              refusal: 'protocol',
              exit: 'protocol',
            } as Record<string, string>
          )[mode],
          mode,
        );
      }
    }
  } finally {
    for (const { child } of owned)
      if (child.pid && !groupAbsent(child.pid)) process.kill(-child.pid, 'SIGKILL');
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
