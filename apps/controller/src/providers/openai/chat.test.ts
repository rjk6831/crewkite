// Native frames this adapter assumes, one JSON object per line. A live run on the pinned client
// should confirm each of them.
//
// Launch: `-c approval_policy="untrusted"` for the ask and allow-edits policies, "on-request" for
// allow-all, and the same value as approvalPolicy below. Under untrusted the client asks before
// every file change and every command outside its own read-only list.
//
// Client to server, ids counted from 1 per process:
//   {"id":1,"method":"initialize","params":{"clientInfo":{"name":"crewkite","title":"CrewKite","version":"0.0.0"},"capabilities":{"experimentalApi":false,"explicitGatewayOauth":true}}}
//   {"method":"initialized"}
//   {"id":2,"method":"account/read","params":{"refreshToken":false}}
//   {"id":3,"method":"account/rateLimits/read","params":{"supportsLunaReserve":false,"excludeResetCreditDetails":true}}
//   {"id":4,"method":"thread/start","params":{"model":M,"modelProvider":"openai","cwd":SCRATCH,"approvalPolicy":"untrusted"|"on-request","approvalsReviewer":"user","sandbox":"workspace-write","serviceTier":"default","config":{"model_reasoning_effort":E},"ephemeral":false}}
//   {"id":4,"method":"thread/resume","params":{"threadId":T, same settings without ephemeral}}
//   {"id":5,"method":"turn/start","params":{"threadId":T,"input":[{"type":"text","text":TEXT}]}}
//   {"id":R,"result":{"decision":"accept"|"acceptForSession"|"decline"}}, the answer to approval request R
//   {"id":N,"method":"turn/interrupt","params":{"threadId":T,"turnId":U}}
//
// Server to client:
//   {"id":n,"result":...} or {"id":n,"error":{"code":C,"message":S}}
//   account/read result {"account":{"type":"chatgpt"}|null}
//   account/rateLimits/read result {"ordinaryUsageAllowed":B,"rateLimits":{"limitId","primary":{"usedPercent","windowDurationMins","resetsAt"}}}
//   thread/start and thread/resume result {"thread":{"id":T}}; turn/start result {"turn":{"id":U}}
//   {"id":R,"method":"item/commandExecution/requestApproval","params":{"threadId","turnId","itemId","reason","command","cwd"}},
//     or for a network access prompt {"threadId","turnId","itemId","reason","networkApprovalContext":{"host","protocol"}}
//     with no command and no cwd
//   {"id":R,"method":"item/fileChange/requestApproval","params":{"threadId","turnId","itemId","reason","grantRoot"}},
//     always after item/started for the same fileChange item, which carries the paths
//   turn/started {"threadId","turn":{"id"}}
//   item/started and item/completed {"threadId","turnId","item":{"id","type",...}} where type is
//     agentMessage {"text"}, reasoning {"summary":[...]}, commandExecution {"command","cwd","status",
//     "exitCode","aggregatedOutput"}, fileChange {"changes":[{"path","kind":{"type","move_path"}}],
//     "status"} where move_path is snake case and set only for a rename, mcpToolCall
//     {"server","tool","status"} or webSearch {"query"}
//   item/agentMessage/delta, item/reasoning/summaryTextDelta, item/reasoning/textDelta,
//     item/commandExecution/outputDelta {"threadId","turnId","itemId","delta"}
//   item/reasoning/summaryPartAdded {"itemId","summaryIndex"}
//   thread/tokenUsage/updated {"tokenUsage":{"last":{"totalTokens"},"modelContextWindow"}}
//   account/rateLimits/updated {"rateLimits":{"limitId","primary":{...},"secondary":{...}}}
//   warning {"message"}; deprecationNotice and configWarning {"summary","details"}
//   error {"error":{"message","codexErrorInfo"},"willRetry"}
//   turn/completed {"threadId","turn":{"id","status":"completed"|"interrupted"|"failed","error"}}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import {
  type AgentEvent,
  AgentEventSchema,
  type ChatPermissionPolicy,
  type ChatSession,
  type ChatToolKind,
} from '@crewkite/contracts';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import { openAiChatAdapter } from './chat.ts';
import type { OpenAiUsage } from './discovery.ts';

// A scripted app-server. It logs every line it reads, answers the metadata requests, and plays
// one scenario after turn/start.
const peer = String.raw`
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const [scenario, frames, detail] = process.argv.slice(2);
const given = JSON.parse(detail ?? 'null') ?? {};
// Paths in a scenario are relative to the scratch copy, which is this process's cwd. They stay
// unnormalized so the adapter has to resolve the '..' itself.
const here = (path) => process.cwd() + '/' + path;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const running = { id: 'turn-1', status: 'inProgress', items: [], error: null };
let threadId = 'thread-1';
const ids = () => ({ threadId, turnId: 'turn-1' });
const replies = {
  initialize: { userAgent: 'fixture', platformFamily: 'unix', platformOs: 'fixture' },
  'account/read': { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true },
  'account/rateLimits/read': {
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1793000000 }, secondary: null },
  },
};
const message = (id, text) => ({ id, type: 'agentMessage', text });
const done = (status = 'completed', error = null) => ['turn/completed', { threadId, turn: { ...running, status, error } }];
const command = { id: 'command-1', type: 'commandExecution', command: 'pnpm test', cwd: '/scratch', status: 'inProgress', aggregatedOutput: null, exitCode: null };
const limit = { message: "You've hit your usage limit. Try again later.", codexErrorInfo: 'usageLimitExceeded' };
const scripts = {
  stream: () => [
    ['turn/started', { threadId, turn: running }],
    ['item/started', { ...ids(), item: { id: 'reasoning-1', type: 'reasoning', summary: [], content: [] } }],
    ['item/reasoning/summaryTextDelta', { ...ids(), itemId: 'reasoning-1', summaryIndex: 0, delta: 'Reading ' }],
    ['item/reasoning/summaryTextDelta', { ...ids(), itemId: 'reasoning-1', summaryIndex: 0, delta: 'the tests.' }],
    ['item/completed', { ...ids(), item: { id: 'reasoning-1', type: 'reasoning', summary: ['Reading the tests.'], content: [] } }],
    ['item/started', { ...ids(), item: message('message-1', '') }],
    ['item/agentMessage/delta', { ...ids(), itemId: 'message-1', delta: 'Two ' }],
    ['item/agentMessage/delta', { ...ids(), itemId: 'message-1', delta: 'files.' }],
    ['item/completed', { ...ids(), item: message('message-1', 'Two files.') }],
    ['thread/tokenUsage/updated', { ...ids(), tokenUsage: { total: { totalTokens: 900 }, last: { totalTokens: 300 }, modelContextWindow: 400000 } }],
    done(),
  ],
  approval: () => [
    ['item/started', { ...ids(), item: command }],
    // A network access prompt names the host and leaves out the command and its cwd.
    { id: 0, method: 'item/commandExecution/requestApproval', params: { ...ids(), itemId: 'command-1', reason: 'Runs the test suite.', ...(given.network ? { networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' } } : { command: 'pnpm test', ...(given.cwd ? { cwd: here(given.cwd) } : {}) }) } },
  ],
  edit: () => [
    ['item/started', { ...ids(), item: { id: 'change-1', type: 'fileChange', changes: [{ path: here(given.path), kind: given.movePath ? { type: 'update', move_path: here(given.movePath) } : { type: 'add' }, diff: 'x\n' }], status: 'inProgress' } }],
    { id: 0, method: 'item/fileChange/requestApproval', params: { ...ids(), itemId: 'change-1', reason: null, grantRoot: given.grantRoot ? here(given.grantRoot) : null } },
  ],
  approved: () => [
    ['item/commandExecution/outputDelta', { ...ids(), itemId: 'command-1', delta: 'ok\n' }],
    ['item/completed', { ...ids(), item: { ...command, status: 'completed', exitCode: 0, aggregatedOutput: 'ok\n' } }],
    done(),
  ],
  stop: () => [
    ['item/started', { ...ids(), item: message('message-1', '') }],
    ['item/agentMessage/delta', { ...ids(), itemId: 'message-1', delta: 'Partial' }],
  ],
  unknown: () => [
    ['fixture/newNotice', { ...ids(), value: 1 }],
    ['fixture/newNotice', { ...ids(), value: 2 }],
    ['item/completed', { ...ids(), item: message('message-1', 'Done.') }],
    done(),
  ],
  limit: () => [
    ['account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1793000000 }, secondary: null } }],
    ['error', { ...ids(), willRetry: false, error: limit }],
    done('failed', limit),
  ],
  reply: () => [['item/completed', { ...ids(), item: message('message-1', 'Hello.') }], done()],
};
const play = (name) => {
  for (const frame of scripts[name]()) send(Array.isArray(frame) ? { method: frame[0], params: frame[1] } : frame);
};
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  appendFileSync(frames, line + '\n');
  const value = JSON.parse(line);
  if (value.method === undefined) return play(scenario === 'edit' ? 'reply' : 'approved');
  if (value.id === undefined) return;
  let result = replies[value.method];
  // Fields CrewKite does not read change shape between client builds.
  if (value.method === 'thread/start') result = { thread: { id: threadId, preview: '' }, model: value.params.model, sandbox: { type: 'futureSandbox' } };
  if (value.method === 'thread/resume') {
    threadId = value.params.threadId;
    result = { thread: { id: threadId } };
  }
  if (value.method === 'turn/start') result = { turn: running };
  if (value.method === 'turn/interrupt') result = {};
  send({ id: value.id, result });
  if (value.method === 'turn/start') play(scenario);
  if (value.method === 'turn/interrupt') send({ method: 'turn/completed', params: { threadId, turn: { ...running, status: 'interrupted' } } });
});
input.on('close', () => process.exit(0));
`;

mkdirSync(resolve('internal'), { recursive: true });
const root = mkdtempSync(resolve('internal/openai-chat-'));
after(() => rmSync(root, { recursive: true, force: true }));
const executable = join(root, 'app-server.cjs');
writeFileSync(executable, peer);
const sha256 = createHash('sha256').update(peer).digest('hex');
const turnId = 'trn_01M51M322B2AEBXD9MA74CBCFM';
const prompt = 'What does this project do?';
const systemContext = 'You are working in a scratch copy of demo.';
const strip = (events: AgentEvent[]) => events.map(({ turnId: _turnId, ...rest }) => rest);

function turn(
  scenario: string,
  options: {
    session?: ChatSession;
    permissionPolicy?: ChatPermissionPolicy;
    permissionGrants?: ChatToolKind[];
    /**
     * Scenario input for the peer: a command cwd or a network prompt, or a file change path, its
     * move destination and grant root.
     */
    detail?: {
      cwd?: string;
      network?: boolean;
      path?: string;
      movePath?: string;
      grantRoot?: string;
    };
    /** Runs on the empty scratch copy before the turn starts. */
    prepare?: (scratch: string) => void;
  } = {},
) {
  const home = mkdtempSync(join(root, `${scenario}-`));
  const scratch = join(home, 'scratch');
  const work = join(home, 'work');
  mkdirSync(scratch);
  mkdirSync(work, { mode: 0o700 });
  options.prepare?.(scratch);
  const frames = join(home, 'frames.jsonl');
  const events: AgentEvent[] = [];
  const listeners: Array<(event: AgentEvent) => void> = [];
  const usage: OpenAiUsage[] = [];
  const environment = { HOME: home, PATH: process.env.PATH };
  let args: string[] = [];
  const adapter = openAiChatAdapter({
    launch: () => ({ executable, sha256, directory: work, repositoryRoot: home, environment }),
    onUsage: (value) => usage.push(value),
    spawn: (path, clientArgs, spawnOptions) => {
      args = clientArgs;
      const input = JSON.stringify(options.detail ?? null);
      return spawn(process.execPath, [path, scenario, frames, input], spawnOptions);
    },
  });
  const handle = adapter.startTurn(
    {
      turnId,
      taskId: 'tsk_01M51M322B2AEBXD9MA74CBCFM',
      role: 'assistant',
      selection: { family: 'openai', model: 'gpt-6.1-sol', effort: 'low' },
      prompt,
      systemContext,
      history: [],
      session: options.session ?? null,
      scratch: { directory: scratch, base: 'a'.repeat(40), projectName: 'demo' },
      work: { directory: work, home },
      permissionPolicy: options.permissionPolicy ?? 'ask',
      permissionGrants: options.permissionGrants ?? [],
      deadlineMs: 10_000,
      environment,
      now: () => Date.parse('2026-10-23T12:00:00.000Z'),
    },
    (event) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
  );
  return {
    handle,
    events,
    usage,
    scratch,
    args: () => args,
    frames: () =>
      readFileSync(frames, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line)),
    when: <T extends AgentEvent['type']>(type: T) =>
      new Promise<Extract<AgentEvent, { type: T }>>((resolve) => {
        const match = (event: AgentEvent): event is Extract<AgentEvent, { type: T }> =>
          event.type === type;
        const found = events.find(match);
        if (found) return resolve(found);
        listeners.push((event) => match(event) && resolve(event));
      }),
    // Every event must satisfy the shared contract the renderer reads.
    settled: async () => {
      const result = await handle.result;
      for (const event of events) AgentEventSchema.parse(event);
      return result;
    },
  };
}

test('streamed thinking and text reach the thread in the order the client sends them', async () => {
  const run = turn('stream');
  const result = await run.settled();
  assert.deepEqual(strip(run.events), [
    { type: 'thinking.delta', itemId: 'reasoning-1', text: 'Reading ' },
    { type: 'thinking.delta', itemId: 'reasoning-1', text: 'the tests.' },
    { type: 'thinking.completed', itemId: 'reasoning-1' },
    { type: 'text.delta', itemId: 'message-1', text: 'Two ' },
    { type: 'text.delta', itemId: 'message-1', text: 'files.' },
    { type: 'text.completed', itemId: 'message-1', text: 'Two files.' },
    { type: 'usage.context', usedTokens: 300, capacityTokens: 400_000 },
    { type: 'turn.completed', stopReason: 'done', failure: null },
  ]);
  assert.deepEqual(result, {
    stopReason: 'done',
    failure: null,
    assistantText: 'Two files.',
    session: {
      family: 'openai',
      sessionId: 'thread-1',
      model: 'gpt-6.1-sol',
      updatedAt: '2026-10-23T12:00:00.000Z',
    },
    usage: { usedTokens: 300, capacityTokens: 400_000 },
    changedPaths: [],
  });
});

test('a command approval holds the turn until respondPermission answers it', async () => {
  const run = turn('approval');
  const request = await run.when('permission.requested');
  // The peer sends nothing more until it reads an answer, so these are all the events so far.
  assert.deepEqual(strip(run.events), [
    {
      type: 'tool.started',
      callId: 'command-1',
      kind: 'command',
      title: 'pnpm test',
      input: { command: 'pnpm test', cwd: '/scratch' },
    },
    {
      type: 'permission.requested',
      requestId: 'approval-1',
      callId: 'command-1',
      question: 'Run this command?',
      detail: 'pnpm test\n\nRuns the test suite.',
      options: [
        { id: 'allow-once', label: 'Allow once', kind: 'allow-once' },
        { id: 'allow-thread', label: 'Allow for this thread', kind: 'allow-thread' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
    },
  ]);
  run.handle.respondPermission(request.requestId, 'allow-once');
  const result = await run.settled();
  assert.deepEqual(strip(run.events.slice(2)), [
    { type: 'permission.resolved', requestId: 'approval-1', choice: 'allow-once' },
    { type: 'tool.output', callId: 'command-1', chunk: 'ok\n' },
    { type: 'tool.completed', callId: 'command-1', status: 'ok', summary: 'Exit code 0.' },
    { type: 'turn.completed', stopReason: 'done', failure: null },
  ]);
  assert.deepEqual(
    run.frames().find((frame) => frame.id === 0),
    { id: 0, result: { decision: 'accept' } },
  );
  assert.equal(result.stopReason, 'done');
});

test('a command kind the thread allows is answered without asking only inside the scratch copy', async () => {
  // Every row holds a command grant. Only a command run from inside the copy is answered from it,
  // with no respondPermission call. A network prompt has no cwd, so it goes to the person.
  const rows: Array<{
    detail: { cwd?: string; network?: boolean };
    answered: string[];
    decision: string;
  }> = [
    { detail: { cwd: '.' }, answered: ['allow-thread'], decision: 'acceptForSession' },
    { detail: { cwd: '..' }, answered: [], decision: 'decline' },
    { detail: { network: true }, answered: [], decision: 'decline' },
  ];
  for (const row of rows) {
    const run = turn('approval', { permissionGrants: ['command'], detail: row.detail });
    const asked = await run.when('permission.requested');
    const answered = run.events.flatMap((event) =>
      event.type === 'permission.resolved' ? [event.choice] : [],
    );
    assert.deepEqual(answered, row.answered, JSON.stringify(row));
    if (!answered.length) run.handle.respondPermission(asked.requestId, 'deny');
    assert.equal((await run.settled()).stopReason, 'done');
    assert.deepEqual(
      run.frames().find((frame) => frame.id === 0),
      { id: 0, result: { decision: row.decision } },
    );
  }
});

test('a write outside the scratch copy still asks under allow-edits and allow-all', async () => {
  // Every row also holds an edit grant, so no rule may answer a change that leaves the copy by
  // '..', through a link, by a rename, or with a grant root outside it. Rows run under
  // allow-edits unless they name a policy.
  const rows: Array<{
    policy?: ChatPermissionPolicy;
    detail: { path: string; movePath?: string; grantRoot?: string };
    answered: string[];
  }> = [
    { detail: { path: 'src/app.ts' }, answered: ['allow-once'] },
    { detail: { path: '../outside.txt' }, answered: [] },
    { detail: { path: 'link/outside.txt' }, answered: [] },
    { detail: { path: 'src/app.ts', movePath: '../outside.ts' }, answered: [] },
    { detail: { path: 'src/app.ts', grantRoot: '..' }, answered: [] },
    { policy: 'allow-all', detail: { path: '../outside.txt' }, answered: [] },
  ];
  for (const row of rows) {
    const run = turn('edit', {
      permissionPolicy: row.policy ?? 'allow-edits',
      permissionGrants: ['edit'],
      detail: row.detail,
      prepare: (scratch) => symlinkSync(dirname(scratch), join(scratch, 'link')),
    });
    const asked = await run.when('permission.requested');
    const answered = run.events.flatMap((event) =>
      event.type === 'permission.resolved' ? [event.choice] : [],
    );
    assert.deepEqual(answered, row.answered, JSON.stringify(row));
    if (!answered.length) run.handle.respondPermission(asked.requestId, 'deny');
    assert.equal((await run.settled()).stopReason, 'done');
  }
});

test('stop interrupts the native turn, ends the process group and reports stopped', async () => {
  const run = turn('stop');
  await run.when('text.delta');
  run.handle.stop();
  const result = await run.settled();
  assert.deepEqual(run.frames().at(-1), {
    id: 6,
    method: 'turn/interrupt',
    params: { threadId: 'thread-1', turnId: 'turn-1' },
  });
  assert.equal(result.stopReason, 'stopped');
  assert.equal(result.failure?.kind, 'stopped');
  assert.equal(result.session?.sessionId, 'thread-1');
  assert.deepEqual(strip(run.events).at(-1), {
    type: 'turn.completed',
    stopReason: 'stopped',
    failure: result.failure,
  });
  assert.equal(run.handle.groups.length, 1);
  for (const group of run.handle.groups) assert(groupAbsent(group));
});

test('an unknown notification is reported once and the turn still completes', async () => {
  const run = turn('unknown');
  const result = await run.settled();
  assert.deepEqual(
    run.events.filter((event) => event.type === 'provider.notice'),
    [
      {
        type: 'provider.notice',
        turnId,
        level: 'info',
        message: 'Codex sent fixture/newNotice. CrewKite does not read it yet.',
      },
    ],
  );
  assert.equal(result.stopReason, 'done');
  assert.equal(result.assistantText, 'Done.');
});

test('a usage limit error ends the turn as a limit with the reset time', async () => {
  const run = turn('limit');
  const result = await run.settled();
  assert.equal(result.stopReason, 'limit');
  assert.deepEqual(result.failure, {
    stage: 'stream',
    kind: 'usage-limit',
    message: 'Codex reached a usage limit.',
    providerMessage: "You've hit your usage limit. Try again later.",
    method: null,
    code: null,
    resetsAt: new Date(1_793_000_000 * 1000).toISOString(),
    nextAction: 'Continue on another provider, or wait for the reset.',
  });
  assert.equal(run.usage.at(-1)?.windows[0].remaining?.value, 0);
});

test('the next turn resumes the thread with its own approval policy and sends only the prompt', async () => {
  const first = turn('reply');
  const { session } = await first.settled();
  assert(session);
  const second = turn('reply', { session, permissionPolicy: 'allow-all' });
  const result = await second.settled();
  const settings = {
    model: 'gpt-6.1-sol',
    modelProvider: 'openai',
    cwd: first.scratch,
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    serviceTier: 'default',
    config: { model_reasoning_effort: 'low' },
  };
  assert(first.args().includes('approval_policy="untrusted"'));
  assert(second.args().includes('approval_policy="on-request"'));
  assert.deepEqual(first.frames().slice(4), [
    { id: 4, method: 'thread/start', params: { ...settings, ephemeral: false } },
    {
      id: 5,
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: `${systemContext}\n\n${prompt}` }],
      },
    },
  ]);
  assert.deepEqual(
    second.frames().map((frame) => frame.method),
    [
      'initialize',
      'initialized',
      'account/read',
      'account/rateLimits/read',
      'thread/resume',
      'turn/start',
    ],
  );
  assert.deepEqual(second.frames().slice(4), [
    {
      id: 4,
      method: 'thread/resume',
      params: {
        threadId: 'thread-1',
        ...settings,
        cwd: second.scratch,
        approvalPolicy: 'on-request',
      },
    },
    {
      id: 5,
      method: 'turn/start',
      params: { threadId: 'thread-1', input: [{ type: 'text', text: prompt }] },
    },
  ]);
  assert.equal(result.session?.sessionId, 'thread-1');
});
