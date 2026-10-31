// Subagent frames these tests assume from the native client in stream-json mode. A live run on
// the installed build should confirm each one.
//
//   A spawn is a top-level tool_use named Task (Agent on some builds) whose input carries a
//     description and, when the person or model picked one, a model.
//   Every frame the subagent produces repeats the spawn's call ID in parent_tool_use_id:
//     {"type":"assistant","parent_tool_use_id":"toolu_task","message":{"model":"...",
//     "content":[ONE block]}}, and stream_event and user frames the same way.
//   A subagent's permission ask is an ordinary control_request with no parent field, naming the
//     nested call in tool_use_id.
//   The subagent is finished when the top-level tool_result for the spawn arrives.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type AgentEvent, AgentEventSchema } from '@crewkite/contracts';
import type { ChatTurnRequest } from '../../chat/adapter.ts';
import { spawnCheckChild } from '../../host/check-ownership.ts';
import { anthropicChatAdapter } from './chat.ts';

type Spawn = NonNullable<Parameters<typeof anthropicChatAdapter>[0]['spawn']>;
type Step = 'read' | 'drain' | { out: unknown };

const fixture = new URL('./chat-fixture.ts', import.meta.url).pathname;
const sha256 = createHash('sha256').update(readFileSync(fixture)).digest('hex');
const turnId = 'trn_00000000000000000000000001';
const session = '0f6c2a51-7a3e-4c1b-9d55-1f2e3a4b5c6d';

const init = { type: 'system', subtype: 'init', session_id: session, model: 'model-a' };
const said = (content: unknown[], parent: string | null = null, model = 'model-a') => ({
  type: 'assistant',
  session_id: session,
  parent_tool_use_id: parent,
  message: { id: `msg_${parent ?? 'top'}_${JSON.stringify(content).length}`, model, content },
});
const result = (callId: string, text: string, parent: string | null = null, failed = false) => ({
  type: 'user',
  session_id: session,
  parent_tool_use_id: parent,
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: callId,
        content: text,
        ...(failed ? { is_error: true } : {}),
      },
    ],
  },
});
const spawnCall = (id: string, name: string, description: string, model?: string) =>
  said([
    {
      type: 'tool_use',
      id,
      name,
      input: { description, prompt: 'Look around.', ...(model ? { model } : {}) },
    },
  ]);
const nestedCall = (parent: string, id: string, name: string, input: object) =>
  said([{ type: 'tool_use', id, name, input }], parent, 'model-b');
const done = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: session,
  usage: { input_tokens: 10, output_tokens: 5 },
};

function run(steps: Step[], patch: Partial<ChatTurnRequest> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crewkite-subagents-'));
  mkdirSync(join(root, 'scratch'));
  mkdirSync(join(root, 'work'));
  const events: AgentEvent[] = [];
  const launched = { argv: [] as string[], input: [] as string[] };
  const spawn: Spawn = (executable, argv, options) => {
    launched.argv = argv;
    const child = spawnCheckChild(
      process.execPath,
      [executable, JSON.stringify(steps), ...argv],
      options,
    ) as ReturnType<Spawn>;
    const write = child.stdin.write;
    child.stdin.write = function (this: unknown, ...args: unknown[]) {
      launched.input.push(String(args[0]));
      return Reflect.apply(write, this, args);
    } as typeof write;
    return child;
  };
  const request: ChatTurnRequest = {
    turnId,
    taskId: 'tsk_00000000000000000000000001',
    role: 'assistant',
    selection: { family: 'anthropic', model: 'model-a', effort: 'default' },
    prompt: 'Survey the tests.',
    systemContext: '',
    history: [],
    session: null,
    scratch: { directory: join(root, 'scratch'), base: 'a'.repeat(40), projectName: 'demo' },
    work: { directory: join(root, 'work'), home: root },
    permissionPolicy: 'ask',
    deadlineMs: 60_000,
    environment: { HOME: root, PATH: '/usr/bin:/bin' },
    now: () => Date.parse('2026-10-31T00:00:00.000Z'),
    ...patch,
  };
  let handle: ReturnType<ReturnType<typeof anthropicChatAdapter>['startTurn']>;
  handle = anthropicChatAdapter({
    launch: () => ({ executable: fixture, sha256 }),
    spawn,
  }).startTurn(request, (event) => {
    events.push(AgentEventSchema.parse(event));
    // The person answers a subagent's ask the way they answer any other.
    if (event.type === 'permission.requested')
      handle.respondPermission(event.requestId, 'allow-once');
  });
  return { handle, events, launched, cleanup: () => rmSync(root, { recursive: true }) };
}

const lastActivity = (events: AgentEvent[], callId: string) =>
  events.findLast(
    (event): event is Extract<AgentEvent, { type: 'tool.subagents' }> =>
      event.type === 'tool.subagents' && event.callId === callId,
  );

test('nested frames count under their parent call, keep their text out of the reply and finish with the parent result', async (t) => {
  const rows: {
    name: string;
    steps: Step[];
    reply: string;
    cards: string[];
    activity: Record<string, { running: number; finished: number; agents: unknown[] }>;
  }[] = [
    {
      name: 'one subagent that reads, searches and finishes',
      steps: [
        'read',
        { out: init },
        { out: spawnCall('toolu_task', 'Task', 'Survey the tests') },
        { out: said([{ type: 'text', text: 'nested words stay out' }], 'toolu_task', 'model-b') },
        { out: nestedCall('toolu_task', 'toolu_n1', 'Read', { file_path: 'src/app.ts' }) },
        { out: result('toolu_n1', 'file body', 'toolu_task') },
        {
          out: {
            type: 'stream_event',
            parent_tool_use_id: 'toolu_task',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'nested delta' },
            },
          },
        },
        { out: nestedCall('toolu_task', 'toolu_n2', 'Grep', { pattern: 'describe(' }) },
        { out: result('toolu_task', 'Two suites.') },
        { out: said([{ type: 'text', text: 'There are two suites.' }]) },
        { out: done },
        'drain',
      ],
      reply: 'There are two suites.',
      cards: ['toolu_task|other|Task Survey the tests'],
      activity: {
        toolu_task: {
          running: 0,
          finished: 1,
          agents: [{ id: 'toolu_task', state: 'done', action: 'describe(', model: 'model-b' }],
        },
      },
    },
    {
      name: 'two subagents side by side, one failing and one with no result when the turn ends',
      steps: [
        'read',
        { out: init },
        { out: spawnCall('toolu_a', 'Agent', 'Check the docs', 'model-c') },
        { out: spawnCall('toolu_b', 'Task', 'Check the code') },
        { out: nestedCall('toolu_a', 'toolu_a1', 'Read', { file_path: 'docs/index.md' }) },
        { out: nestedCall('toolu_b', 'toolu_b1', 'Bash', { command: 'ls src' }) },
        { out: result('toolu_a', 'Could not finish.', null, true) },
        { out: said([{ type: 'text', text: 'One check failed.' }]) },
        { out: done },
        'drain',
      ],
      reply: 'One check failed.',
      cards: ['toolu_a|other|Agent Check the docs', 'toolu_b|other|Task Check the code'],
      activity: {
        toolu_a: {
          running: 0,
          finished: 1,
          agents: [{ id: 'toolu_a', state: 'failed', action: 'docs/index.md', model: 'model-b' }],
        },
        toolu_b: {
          running: 0,
          finished: 1,
          agents: [{ id: 'toolu_b', state: 'stopped', action: 'ls src', model: 'model-b' }],
        },
      },
    },
  ];
  for (const row of rows) {
    const turn = run(row.steps);
    t.after(turn.cleanup);
    const settled = await turn.handle.result;
    assert.equal(settled.stopReason, 'done', row.name);
    assert.equal(settled.assistantText, row.reply, row.name);
    const words = turn.events.flatMap((event) => ('text' in event ? [event.text] : []));
    assert(!words.some((text) => /nested/.test(text)), row.name);
    assert.deepEqual(
      turn.events.flatMap((event) =>
        event.type === 'tool.started' ? [`${event.callId}|${event.kind}|${event.title}`] : [],
      ),
      row.cards,
      row.name,
    );
    for (const [callId, expected] of Object.entries(row.activity)) {
      const {
        type: _type,
        turnId: _turn,
        callId: _call,
        ...activity
      } = lastActivity(turn.events, callId) ?? {};
      assert.deepEqual(activity, expected, `${row.name}: ${callId}`);
    }
    // The last picture goes out before the turn ends.
    const ended = turn.events.findIndex((event) => event.type === 'turn.completed');
    assert(turn.events.findLastIndex((event) => event.type === 'tool.subagents') < ended);
  }
});

test('a permission ask from a subagent takes the usual path and its answer reaches the client', async (t) => {
  const turn = run([
    'read',
    { out: init },
    { out: spawnCall('toolu_task', 'Task', 'Run the suite') },
    { out: nestedCall('toolu_task', 'toolu_bash', 'Bash', { command: 'npm test' }) },
    {
      out: {
        type: 'control_request',
        request_id: 'req-sub',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'npm test' },
          tool_use_id: 'toolu_bash',
        },
      },
    },
    'read',
    { out: result('toolu_bash', 'ok', 'toolu_task') },
    { out: result('toolu_task', 'Suite passed.') },
    { out: said([{ type: 'text', text: 'It passed.' }]) },
    { out: done },
    'drain',
  ]);
  t.after(turn.cleanup);
  const settled = await turn.handle.result;
  assert.equal(settled.stopReason, 'done');
  const asked = turn.events.find((event) => event.type === 'permission.requested');
  assert.equal(asked?.question, 'Run npm test?');
  assert.equal(asked?.callId, 'toolu_bash');
  assert.deepEqual(
    turn.launched.input
      .map((line) => JSON.parse(line))
      .filter((frame) => frame.type === 'control_response'),
    [
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-sub',
          response: { behavior: 'allow', updatedInput: { command: 'npm test' } },
        },
      },
    ],
  );
  assert.equal(lastActivity(turn.events, 'toolu_task')?.agents[0]?.state, 'done');
});

test('a crew role with subagents off disallows both spawn tools, and one left on passes nothing', async (t) => {
  const rows: { subagents: boolean | undefined; flag: string[] }[] = [
    { subagents: false, flag: ['--disallowedTools', 'Task,Agent'] },
    { subagents: true, flag: [] },
    { subagents: undefined, flag: [] },
  ];
  for (const row of rows) {
    const turn = run(['read', { out: init }, { out: done }, 'drain'], { subagents: row.subagents });
    t.after(turn.cleanup);
    await turn.handle.result;
    const at = turn.launched.argv.indexOf('--disallowedTools');
    assert.deepEqual(
      at === -1 ? [] : turn.launched.argv.slice(at, at + 2),
      row.flag,
      String(row.subagents),
    );
    // The flag closes before the MCP config, which takes several values.
    if (at !== -1) assert.equal(turn.launched.argv[at + 2], '--mcp-config');
  }
});
