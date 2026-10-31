// Subagent frames these tests assume from the Google agent. A live run with the real client
// should confirm each one.
//
//   session/new and session/load carry _meta {antigravity:{disabledTools:["invoke_subagent"]}}
//     when the crew role turned subagents off, and no _meta otherwise.
//   A subagent call is a tool_call whose title, kind or name says subagent, such as
//     {toolCallId, title:"invoke_subagent", kind:"other", rawInput:{model}}.
//   A subagent's own work may arrive as session/update under another sessionId.
//   A tool_call without a readable toolCallId still names its title and kind.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type AgentEvent, AgentEventSchema } from '@crewkite/contracts';
import type { ChatTurnRequest } from '../../chat/adapter.ts';
import { spawnCheckChild } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import type { AcpSpawn } from './acp/client.ts';
import { googleChatAdapter } from './chat.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const turnId = `trn_${suffix}`;
const harness = '#!/bin/sh\nexit 99\n';

// The scripted agent's first read becomes a subagent call, the subagent's own work under another
// session, and a call with no ID. The read's own result is dropped.
const edit = `(line) => {
  const frame = JSON.parse(line);
  const update = frame.params?.update;
  if (update?.toolCallId !== 'read-1') return [line];
  if (update.sessionUpdate === 'tool_call_update') return [];
  const at = (sessionId, value) =>
    JSON.stringify({ ...frame, params: { sessionId, update: value } });
  const own = frame.params.sessionId;
  return [
    at(own, { sessionUpdate: 'tool_call', toolCallId: 'sub-1', title: 'invoke_subagent', kind: 'other', status: 'in_progress', rawInput: { model: 'model-b', Prompt: 'Look around' } }),
    at('child-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'nested words' } }),
    at('child-1', { sessionUpdate: 'tool_call', toolCallId: 'c-1', title: 'Read app.ts', kind: 'read', status: 'in_progress' }),
    at(own, { sessionUpdate: 'tool_call', title: 'mystery_tool', kind: 'fetch', status: 'in_progress' }),
    at(own, { sessionUpdate: 'tool_call_update', toolCallId: 'sub-1', status: 'completed' }),
  ];
}`;
const prelude = `const out=process.stdout.write.bind(process.stdout);const edit=${edit};let held='';process.stdout.write=(chunk)=>{held+=chunk;const lines=held.split('\\n');held=lines.pop();for(const line of lines)for(const next of edit(line))out(next+'\\n');return true;};`;

type Frame = { method?: string; params?: Record<string, unknown> };

async function run(subagents: boolean | undefined) {
  mkdirSync(resolve('internal'), { recursive: true });
  const home = mkdtempSync(resolve('internal/acp-subagents-'));
  const executable = join(home, 'peer');
  const peer = fileURLToPath(
    new URL('../../../../../packages/testkit/src/providers/acp-peer.ts', import.meta.url),
  );
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport {runAcpChatPeer} from ${JSON.stringify(pathToFileURL(peer).href)};${prelude}runAcpChatPeer('chat-stream');\n`,
    { mode: 0o500 },
  );
  writeFileSync(join(home, 'localharness_external'), harness, { mode: 0o500 });
  const scratch = join(home, 'scratch');
  const work = join(home, 'work');
  mkdirSync(scratch, { mode: 0o700 });
  mkdirSync(work, { mode: 0o700 });
  const events: AgentEvent[] = [];
  const frames: Frame[] = [];
  const spawn: AcpSpawn = (path, args, options) => {
    const child = spawnCheckChild(path, args, options);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      frames.push(JSON.parse(String(chunk)));
      return Reflect.apply(write, child.stdin, [chunk, ...rest]);
    }) as typeof child.stdin.write;
    return child;
  };
  const request: ChatTurnRequest = {
    turnId,
    taskId: `tsk_${suffix}`,
    role: 'assistant',
    selection: { family: 'google', model: 'fixture-model', effort: 'default' },
    prompt: 'What does this project do?',
    systemContext: '',
    history: [],
    session: null,
    scratch: { directory: scratch, base: 'a'.repeat(40), projectName: 'demo' },
    work: { directory: work, home },
    permissionPolicy: 'ask',
    deadlineMs: 60_000,
    environment: { HOME: userInfo().homedir, PATH: process.env.PATH },
    now: () => Date.parse('2026-10-31T12:00:00.000Z'),
    subagents,
  };
  const handle = googleChatAdapter({
    launch: () => ({
      client: {
        executable,
        version: '1.4.0' as const,
        sha256: sha(readFileSync(executable)),
        signerTeamId: 'TESTTEAM01',
        harnessSha256: sha(harness),
      },
      configuration: {
        model: { optionId: 'model-slot', supported: ['fixture-model'] },
        thoughtLevel: null,
      },
      reviewMode: { configId: 'mode-slot', valueId: 'fixture-review' },
      lifecycle: { beforePhase() {}, owned() {}, quiescent: (group) => assert(groupAbsent(group)) },
      spawn,
    }),
  }).startTurn(request, (event) => events.push(AgentEventSchema.parse(event)));
  const result = await handle.result;
  rmSync(home, { recursive: true, force: true });
  return { events, frames, result };
}

test('a subagent call counts its subagent, its other session gives the latest action, and a call with no id still shows', async () => {
  const { events, result } = await run(undefined);
  assert.equal(result.stopReason, 'done');
  assert(!result.assistantText.includes('nested'));
  const started = events.flatMap((event) =>
    event.type === 'tool.started' ? [`${event.callId}|${event.kind}|${event.title}`] : [],
  );
  assert.deepEqual(started, [
    'sub-1|other|invoke_subagent',
    `${turnId}:call:1|other|mystery_tool`,
    'edit-1|edit|Edit net.mjs',
  ]);
  const last = events.findLast(
    (event): event is Extract<AgentEvent, { type: 'tool.subagents' }> =>
      event.type === 'tool.subagents',
  );
  assert.deepEqual(last && { ...last, turnId: undefined }, {
    type: 'tool.subagents',
    turnId: undefined,
    callId: 'sub-1',
    running: 0,
    finished: 1,
    agents: [{ id: 'sub-1', state: 'done', action: 'Read app.ts', model: 'model-b' }],
  });
});

test('a crew role with subagents off opens the session without the delegation tool', async () => {
  for (const [subagents, meta] of [
    [false, { antigravity: { disabledTools: ['invoke_subagent'] } }],
    [true, undefined],
  ] as const) {
    const { frames } = await run(subagents);
    const opened = frames.find((frame) => frame.method === 'session/new');
    assert.deepEqual(opened?.params?._meta, meta, String(subagents));
  }
});
