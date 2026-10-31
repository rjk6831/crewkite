// Subagent frames these tests assume from the app-server. A live run on the pinned client should
// confirm each one.
//
//   Launch: `-c features.multi_agent=true`, or false when the crew role turned subagents off.
//   item/started and item/completed carry {"type":"collabAgentToolCall","tool":"spawnAgent",
//     "status":"inProgress"|"completed"|"failed","senderThreadId","receiverThreadIds":[...],
//     "model","agentsStates":{THREAD:{"status":...}}}, a wait call naming the same threads, and
//     {"type":"subAgentActivity","kind","agentThreadId","agentPath"}.
//   A subagent's own items and its turn/completed arrive with its own threadId.
//   An item type CrewKite has no reader for arrives like any other item.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { type AgentEvent, AgentEventSchema } from '@crewkite/contracts';
import type { ChatTurnRequest } from '../../chat/adapter.ts';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
import { openAiChatAdapter } from './chat.ts';

// A scripted app-server. It answers the metadata requests, then plays the frames it was given
// after turn/start. A "wait" entry holds until CrewKite answers a request.
const peer = String.raw`
const { createInterface } = require('node:readline');
const frames = JSON.parse(process.argv[2]);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const running = { id: 'turn-1', status: 'inProgress', items: [], error: null };
const replies = {
  initialize: { userAgent: 'fixture' },
  'account/read': { account: { type: 'chatgpt', planType: 'plus' } },
  'account/rateLimits/read': { ordinaryUsageAllowed: true, rateLimits: null },
  'thread/start': { thread: { id: 'thread-1' } },
  'turn/start': { turn: running },
  'turn/interrupt': {},
};
let at = 0;
const play = () => {
  while (at < frames.length) {
    const frame = frames[at++];
    if (frame === 'wait') return;
    send(Array.isArray(frame) ? { method: frame[0], params: frame[1] } : frame);
  }
};
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const value = JSON.parse(line);
  if (value.method === undefined) return play();
  if (value.id === undefined) return;
  send({ id: value.id, result: replies[value.method] ?? {} });
  if (value.method === 'turn/start') play();
});
input.on('close', () => process.exit(0));
`;

mkdirSync(resolve('internal'), { recursive: true });
const root = mkdtempSync(resolve('internal/openai-subagents-'));
after(() => rmSync(root, { recursive: true, force: true }));
const executable = join(root, 'app-server.cjs');
writeFileSync(executable, peer);
const sha256 = createHash('sha256').update(peer).digest('hex');
const turnId = 'trn_01M51M322B2AEBXD9MA74CBCFM';

type Frame = [string, Record<string, unknown>] | Record<string, unknown> | 'wait';
const item = (method: 'item/started' | 'item/completed', value: object, threadId = 'thread-1') =>
  [method, { threadId, turnId: 'turn-1', item: value }] as Frame;
const finished: Frame = [
  'turn/completed',
  { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
];

function turn(frames: Frame[], patch: Partial<ChatTurnRequest> = {}) {
  const home = mkdtempSync(join(root, 'turn-'));
  const scratch = join(home, 'scratch');
  const work = join(home, 'work');
  mkdirSync(scratch);
  mkdirSync(work, { mode: 0o700 });
  const events: AgentEvent[] = [];
  let args: string[] = [];
  const environment = { HOME: home, PATH: process.env.PATH };
  let handle: ReturnType<ReturnType<typeof openAiChatAdapter>['startTurn']>;
  handle = openAiChatAdapter({
    launch: () => ({ executable, sha256, directory: work, repositoryRoot: home, environment }),
    spawn: (path, clientArgs, options) => {
      args = clientArgs;
      return spawn(process.execPath, [path, JSON.stringify(frames)], options);
    },
  }).startTurn(
    {
      turnId,
      taskId: 'tsk_01M51M322B2AEBXD9MA74CBCFM',
      role: 'assistant',
      selection: { family: 'openai', model: 'model-a', effort: 'low' },
      prompt: 'Survey the tests.',
      systemContext: '',
      history: [],
      session: null,
      scratch: { directory: scratch, base: 'a'.repeat(40), projectName: 'demo' },
      work: { directory: work, home },
      permissionPolicy: 'ask',
      deadlineMs: 10_000,
      environment,
      now: () => Date.parse('2026-10-31T12:00:00.000Z'),
      ...patch,
    },
    (event) => {
      events.push(AgentEventSchema.parse(event));
      if (event.type === 'permission.requested')
        handle.respondPermission(event.requestId, 'allow-once');
    },
  );
  return { handle, events, args: () => args };
}

const activity = (events: AgentEvent[], callId: string) => {
  const last = events.findLast(
    (event): event is Extract<AgentEvent, { type: 'tool.subagents' }> =>
      event.type === 'tool.subagents' && event.callId === callId,
  );
  if (!last) return null;
  const { type: _type, turnId: _turn, callId: _call, ...rest } = last;
  return rest;
};
const cards = (events: AgentEvent[]) =>
  events.flatMap((event) =>
    event.type === 'tool.started'
      ? [`${event.callId}|${event.kind}|${event.title}`]
      : event.type === 'tool.completed'
        ? [`${event.callId}|${event.status}`]
        : [],
  );

test('an item type CrewKite has no reader for shows as a card, and agent items count their subagents', async () => {
  const spawnAgent = {
    id: 'collab-1',
    type: 'collabAgentToolCall',
    tool: 'spawnAgent',
    status: 'inProgress',
    senderThreadId: 'thread-1',
    receiverThreadIds: ['thread-2', 'thread-3'],
    model: 'model-b',
    agentsStates: { 'thread-2': { status: 'pendingInit' }, 'thread-3': 'not an object' },
  };
  const rows: {
    name: string;
    frames: Frame[];
    cards: string[];
    activity: Record<string, unknown>;
    reply: string;
  }[] = [
    {
      name: 'an unknown item type',
      frames: [
        item('item/started', { id: 'image-1', type: 'imageView', path: '/tmp/a.png' }),
        item('item/completed', { id: 'image-1', type: 'imageView', path: '/tmp/a.png' }),
        item('item/completed', { id: 'message-1', type: 'agentMessage', text: 'Looked.' }),
        finished,
      ],
      cards: ['image-1|other|Image view', 'image-1|ok'],
      activity: {},
      reply: 'Looked.',
    },
    {
      name: 'a spawn, the subagents working in their own threads, and a wait that reports them',
      frames: [
        item('item/started', spawnAgent),
        item('item/completed', { ...spawnAgent, status: 'completed' }),
        // The subagents' own threads. Their words never reach the reply.
        item(
          'item/started',
          { id: 'c-1', type: 'commandExecution', command: 'ls src' },
          'thread-2',
        ),
        item(
          'item/completed',
          { id: 'm-2', type: 'agentMessage', text: 'nested words' },
          'thread-2',
        ),
        [
          'item/agentMessage/delta',
          { threadId: 'thread-3', turnId: 't', itemId: 'm-3', delta: 'nested delta' },
        ],
        item('item/started', { id: 'w-3', type: 'webSearch', query: 'x' }, 'thread-3'),
        ['turn/completed', { threadId: 'thread-3', turn: { id: 't', status: 'failed' } }],
        item('item/started', {
          id: 'collab-2',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'inProgress',
          receiverThreadIds: ['thread-2'],
        }),
        item('item/completed', {
          id: 'collab-2',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'completed',
          receiverThreadIds: ['thread-2'],
          agentsStates: { 'thread-2': { status: 'completed', message: 'done' } },
        }),
        item('item/completed', { id: 'message-1', type: 'agentMessage', text: 'Both reported.' }),
        finished,
      ],
      cards: [
        'collab-1|other|Collab agent tool call: spawn agent',
        'collab-1|ok',
        'collab-2|other|Collab agent tool call: wait',
        'collab-2|ok',
      ],
      activity: {
        'collab-1': {
          running: 0,
          finished: 2,
          agents: [
            { id: 'thread-2', state: 'done', action: 'ls src', model: 'model-b' },
            { id: 'thread-3', state: 'failed', action: 'Search the web', model: 'model-b' },
          ],
        },
      },
      reply: 'Both reported.',
    },
    {
      name: 'an agent item of a shape CrewKite does not know',
      frames: [
        item('item/started', { id: 'agent-9', type: 'futureAgentThing', status: 42 }),
        item('item/completed', { id: 'agent-9', type: 'futureAgentThing', status: 'completed' }),
        item('item/started', {
          id: 'activity-1',
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'thread-7',
          agentPath: '/root/worker',
        }),
        finished,
      ],
      cards: [
        'agent-9|other|Future agent thing',
        'agent-9|ok',
        'activity-1|other|Sub agent activity: started',
      ],
      activity: {
        'agent-9': {
          running: 0,
          finished: 1,
          agents: [{ id: 'agent-9', state: 'done', action: null, model: null }],
        },
        // The turn finished, so a subagent the client never closed finished with it.
        'activity-1': {
          running: 0,
          finished: 1,
          agents: [{ id: 'thread-7', state: 'done', action: null, model: null }],
        },
      },
      reply: '',
    },
  ];
  for (const row of rows) {
    const run = turn(row.frames);
    const result = await run.handle.result;
    assert.equal(result.stopReason, 'done', row.name);
    assert.equal(result.assistantText, row.reply, row.name);
    assert.deepEqual(cards(run.events), row.cards, row.name);
    for (const [callId, expected] of Object.entries(row.activity))
      assert.deepEqual(activity(run.events, callId), expected, `${row.name}: ${callId}`);
    const words = run.events.flatMap((event) => ('text' in event ? [event.text] : []));
    assert(!words.some((text) => /nested/.test(text)), row.name);
  }
});

test('a command approval from a subagent thread still comes to the person', async () => {
  const run = turn([
    item('item/started', {
      id: 'collab-1',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      receiverThreadIds: ['thread-2'],
    }),
    {
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-2', turnId: 't', itemId: 'c-9', command: 'npm test', cwd: '/x' },
    },
    'wait',
    finished,
  ]);
  const result = await run.handle.result;
  assert.equal(result.stopReason, 'done');
  const asked = run.events.find((event) => event.type === 'permission.requested');
  assert.equal(asked?.question, 'Run this command?');
  assert.equal(
    run.events.find((event) => event.type === 'permission.resolved')?.choice,
    'allow-once',
  );
});

test('the launch turns the client multi agent feature on or off with the crew role', async () => {
  for (const [subagents, value] of [
    [undefined, 'true'],
    [true, 'true'],
    [false, 'false'],
  ] as const) {
    const run = turn([finished], { subagents });
    await run.handle.result;
    assert(run.args().includes(`features.multi_agent=${value}`), String(subagents));
  }
});
