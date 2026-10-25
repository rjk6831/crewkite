// Frames this test assumes. A live run with the real client confirms them.
//
// CrewKite writes, one JSON-RPC line each:
//   initialize                 {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,
//                              writeTextFile:false}, terminal:false}, clientInfo:{name, version}}
//   session/new                {cwd:<scratch>, mcpServers:[]}
//   session/load               {sessionId, cwd:<scratch>, mcpServers:[]}
//   session/set_config_option  {sessionId, configId, value}, once for the model, once for the mode
//   session/prompt             {sessionId, prompt:[{type:'text', text}, ...one block per file]},
//                              each file as {type:'image'|'audio', data, mimeType},
//                              {type:'resource', resource:{uri, mimeType, text|blob}} or
//                              {type:'resource_link', uri, name, mimeType, size}
//   session/cancel             notification {sessionId}
//   reply to a permission      {outcome:{outcome:'selected', optionId}} or {outcome:{outcome:'cancelled'}}
//
// The agent writes:
//   initialize result          {protocolVersion:1, agentCapabilities:{loadSession:true,
//                              promptCapabilities?:{image, audio, embeddedContext}}}
//   session/new result         {sessionId, configOptions:[...]}, then maybe an update on the same write
//   session/load result        null, after the old conversation came back as updates
//   session/update             {sessionId, update:{sessionUpdate, ...}} with sessionUpdate one of
//                              agent_message_chunk, agent_thought_chunk (content:{type:'text', text}),
//                              tool_call {toolCallId, title, kind, status, rawInput, locations},
//                              tool_call_update {toolCallId, status, content:[
//                                {type:'content', content:{type:'text', text}} |
//                                {type:'diff', path, oldText, newText}]},
//                              usage_update {used, size}
//   session/request_permission {sessionId, toolCall:{toolCallId}, options:[{optionId, name,
//                              kind:'allow_once'|'allow_always'|'reject_once'}]}
//   session/prompt result      {stopReason:'end_turn'|'cancelled'|'refusal'|'max_tokens'}
//   session/prompt error       {code:-32603, message}
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type AgentEvent, AgentEventSchema } from '@crewkite/contracts';
import type { AcpChatPeerCase } from '../../../../../packages/testkit/src/providers/acp-peer.ts';
import type { ChatTurnHandle, ChatTurnRequest } from '../../chat/adapter.ts';
import { spawnCheckChild } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import type { AcpLifecycle, AcpSpawn } from './acp/client.ts';
import { type GooglePromptCapabilities, googleChatAdapter } from './chat.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const harness = '#!/bin/sh\nexit 99\n';
const clock = Date.parse('2026-10-23T12:00:00.000Z');
const environment = {
  HOME: userInfo().homedir,
  PATH: process.env.PATH,
  USER: 'fixture',
  SECRET_TOKEN: 'must-not-escape',
};

// Passes each line the peer writes through `edit`, the source of a function from one line to
// the lines sent in its place, so a scenario can play framing the scripted agent does not. The
// peer splits each line across writes, so this joins them first.
const rewrite = (edit: string) =>
  `const out=process.stdout.write.bind(process.stdout);const edit=${edit};let held='';process.stdout.write=(chunk)=>{held+=chunk;const lines=held.split('\\n');held=lines.pop();for(const line of lines)for(const next of edit(line))out(next+'\\n');return true;};`;
// Renames the edit kind, so a scenario can announce a tool kind the adapter does not know.
const announce = (kind: string) =>
  rewrite(
    `(line)=>[line.replace('"kind":"edit"',${JSON.stringify(`"kind":${JSON.stringify(kind)}`)})]`,
  );

function rig(scenario: AcpChatPeerCase, prelude = '') {
  mkdirSync(resolve('internal'), { recursive: true });
  const home = mkdtempSync(resolve('internal/acp-chat-'));
  const executable = join(home, 'peer');
  const peer = fileURLToPath(
    new URL('../../../../../packages/testkit/src/providers/acp-peer.ts', import.meta.url),
  );
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport {runAcpChatPeer} from ${JSON.stringify(pathToFileURL(peer).href)};${prelude}runAcpChatPeer(${JSON.stringify(scenario)});\n`,
    { mode: 0o500 },
  );
  writeFileSync(join(home, 'localharness_external'), harness, { mode: 0o500 });
  const scratch = join(home, 'scratch');
  mkdirSync(scratch, { mode: 0o700 });
  const groups: number[] = [];
  const lifecycle: AcpLifecycle = {
    beforePhase() {},
    owned: (group) => groups.push(group),
    quiescent: (group) => assert(groupAbsent(group)),
  };
  let turns = 0;
  return {
    home,
    scratch,
    lifecycle,
    client: {
      executable,
      version: '1.4.0' as const,
      sha256: sha(readFileSync(executable)),
      signerTeamId: 'TESTTEAM01',
      harnessSha256: sha(harness),
    },
    work() {
      const directory = join(home, `work-${++turns}`);
      mkdirSync(directory, { mode: 0o700 });
      return directory;
    },
    dispose() {
      for (const group of groups) assert(groupAbsent(group));
      rmSync(home, { recursive: true, force: true });
    },
  };
}
type Rig = ReturnType<typeof rig>;

function request(f: Rig, patch: Partial<ChatTurnRequest> = {}): ChatTurnRequest {
  return {
    turnId: `trn_${suffix}`,
    taskId: `tsk_${suffix}`,
    role: 'assistant',
    selection: { family: 'google', model: 'fixture-model', effort: 'default' },
    prompt: 'What does this project do?',
    systemContext: 'You are working in a scratch copy of demo.',
    history: [],
    session: null,
    scratch: { directory: f.scratch, base: 'a'.repeat(40), projectName: 'demo' },
    work: { directory: f.work(), home: f.home },
    permissionPolicy: 'ask',
    deadlineMs: 60_000,
    environment,
    now: () => clock,
    ...patch,
  };
}

type Frame = { method?: string; id?: unknown; params?: Record<string, unknown>; result?: unknown };

/** Runs one turn against the scripted peer and records both directions. */
async function run(
  f: Rig,
  req: ChatTurnRequest,
  react: (event: AgentEvent, handle: ChatTurnHandle) => void = () => {},
) {
  const events: AgentEvent[] = [];
  const frames: Frame[] = [];
  const spawn: AcpSpawn = (executable, args, options) => {
    assert.equal(options.env.SECRET_TOKEN, undefined);
    const child = spawnCheckChild(executable, args, options);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      frames.push(JSON.parse(String(chunk)));
      return Reflect.apply(write, child.stdin, [chunk, ...rest]);
    }) as typeof child.stdin.write;
    return child;
  };
  const capabilities: GooglePromptCapabilities[] = [];
  const adapter = googleChatAdapter({
    onPromptCapabilities: (value) => capabilities.push(value),
    launch: () => ({
      client: f.client,
      configuration: {
        model: { optionId: 'model-slot', supported: ['fixture-model', 'fixture-other'] },
        thoughtLevel: null,
      },
      reviewMode: { configId: 'mode-slot', valueId: 'fixture-review' },
      lifecycle: f.lifecycle,
      spawn,
    }),
  });
  const handle: ChatTurnHandle = adapter.startTurn(req, (event) => {
    AgentEventSchema.parse(event);
    events.push(event);
    react(event, handle);
  });
  const result = await handle.result;
  assert(handle.groups.length > 0 && handle.groups.every(groupAbsent));
  const last = events.at(-1);
  assert.equal(last?.type, 'turn.completed');
  assert.equal(events[0]?.type, 'turn.started');
  return { events, frames, result, handle, capabilities };
}

/** A file stored the way the controller stores one, under the rig's home. */
function stored(f: Rig, name: string, mimeType: string, body: string | Buffer) {
  const id = sha(body);
  const path = join(f.home, 'files', id, name);
  mkdirSync(join(f.home, 'files', id), { recursive: true });
  writeFileSync(path, body);
  return { attachment: { id, name, mimeType, bytes: Buffer.byteLength(body) }, path };
}
const types = (events: AgentEvent[]) => events.map((event) => event.type);
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
const methods = (frames: Frame[]) => frames.map((frame) => frame.method).filter(Boolean);
const withMethod = (frames: Frame[], method: string) =>
  frames.filter((frame) => frame.method === method);
const promptText = (frames: Frame[]) => {
  const [frame] = withMethod(frames, 'session/prompt');
  assert(frame?.params);
  return (frame.params.prompt as { text: string }[])[0].text;
};

test('a turn streams thinking, tools and text in order, and the next turn resumes its session', async () => {
  const f = rig('chat-stream');
  const g = rig('chat-lost');
  try {
    const firstRequest = request(f);
    const first = await run(f, firstRequest);
    assert.deepEqual(types(first.events), [
      'turn.started',
      'usage.context',
      'thinking.delta',
      'thinking.delta',
      'thinking.completed',
      'text.delta',
      'text.delta',
      'text.completed',
      'tool.started',
      'tool.output',
      'tool.completed',
      'tool.started',
      'tool.completed',
      'text.delta',
      'text.completed',
      'turn.completed',
    ]);
    const thinking = of(first.events, 'thinking.delta');
    assert.deepEqual(
      thinking.map((event) => event.text),
      ['Looking at ', 'the files.'],
    );
    assert.equal(of(first.events, 'thinking.completed')[0].itemId, thinking[0].itemId);
    const deltas = of(first.events, 'text.delta');
    const completed = of(first.events, 'text.completed');
    assert.deepEqual(
      deltas.map((event) => event.text),
      ['I will read ', 'the file first.', 'Changed it.'],
    );
    assert.deepEqual(
      completed.map((event) => event.text),
      ['I will read the file first.', 'Changed it.'],
    );
    assert.equal(deltas[0].itemId, completed[0].itemId);
    assert.notEqual(completed[0].itemId, completed[1].itemId);
    assert.deepEqual(
      of(first.events, 'tool.started').map((event) => [event.callId, event.kind, event.title]),
      [
        ['read-1', 'read', 'Read net.mjs'],
        ['edit-1', 'edit', 'Edit net.mjs'],
      ],
    );
    assert.deepEqual(
      of(first.events, 'tool.output').map((event) => event.chunk),
      ['export const total = 0;'],
    );
    assert.deepEqual(
      of(first.events, 'tool.completed').map((event) => [event.callId, event.status, event.diff]),
      [
        ['read-1', 'ok', undefined],
        ['edit-1', 'ok', { path: 'net.mjs', additions: 2, deletions: 1, patch: null }],
      ],
    );
    assert.deepEqual(first.result, {
      stopReason: 'done',
      failure: null,
      assistantText: 'I will read the file first.\n\nChanged it.',
      session: {
        family: 'google',
        sessionId: 'chat-session-1',
        model: 'fixture-model',
        updatedAt: '2026-10-23T12:00:00.000Z',
      },
      usage: { usedTokens: 12, capacityTokens: 1024 },
      changedPaths: ['net.mjs'],
    });
    assert.deepEqual(methods(first.frames), [
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/set_config_option',
      'session/prompt',
    ]);
    assert.deepEqual(withMethod(first.frames, 'session/new')[0].params, {
      cwd: f.scratch,
      mcpServers: [],
    });
    assert.deepEqual(
      withMethod(first.frames, 'session/set_config_option').map((frame) => frame.params),
      [
        { sessionId: 'chat-session-1', configId: 'model-slot', value: 'fixture-model' },
        { sessionId: 'chat-session-1', configId: 'mode-slot', value: 'fixture-review' },
      ],
    );
    assert.equal(
      promptText(first.frames),
      'You are working in a scratch copy of demo.\n\nWhat does this project do?',
    );
    // The frame trace names each frame and never carries file content, tool output or a title,
    // which for a command is the command line.
    const trace = readFileSync(join(firstRequest.work.directory, 'acp-trace.jsonl'), 'utf8');
    assert(!trace.includes('export const') && !trace.includes('Read net.mjs'));
    const { bytes, ...announced } = trace
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((line) => line.toolCallId === 'read-1');
    assert(bytes > 100);
    assert.deepEqual(announced, {
      ms: 0,
      update: 'tool_call',
      toolCallId: 'read-1',
      status: 'in_progress',
      kind: 'read',
      titleLength: 12,
      keys: ['sessionUpdate', 'toolCallId', 'title', 'kind', 'status', 'rawInput', 'locations'],
    });

    // The agent replays the old conversation while it loads. None of it reaches the thread, and
    // the prompt carries no framing because the session already has it.
    const second = await run(
      f,
      request(f, { session: first.result.session, prompt: 'Now explain it.' }),
    );
    assert.deepEqual(methods(second.frames), [
      'initialize',
      'session/load',
      'session/set_config_option',
      'session/set_config_option',
      'session/prompt',
    ]);
    assert.deepEqual(withMethod(second.frames, 'session/load')[0].params, {
      sessionId: 'chat-session-1',
      cwd: f.scratch,
      mcpServers: [],
    });
    assert.equal(promptText(second.frames), 'Now explain it.');
    assert.equal(second.result.assistantText, 'I will read the file first.\n\nChanged it.');
    assert.equal(of(second.events, 'provider.notice').length, 0);

    // A session the agent no longer has is replaced, said once, and the earlier exchange is
    // handed over in the prompt so the model keeps the thread.
    const lost = await run(
      g,
      request(g, {
        session: first.result.session,
        history: [
          { role: 'user', text: 'earlier question' },
          { role: 'assistant', text: 'earlier answer' },
        ],
      }),
    );
    assert.deepEqual(
      of(lost.events, 'provider.notice').map((event) => [event.level, event.message]),
      [['warning', 'Previous session could not be resumed; started a new one.']],
    );
    assert.deepEqual(methods(lost.frames).slice(0, 3), [
      'initialize',
      'session/load',
      'session/new',
    ]);
    assert.equal(
      promptText(lost.frames),
      'You are working in a scratch copy of demo.\n\nEarlier in this conversation:\n\nUser: earlier question\n\nAssistant: earlier answer\n\nWhat does this project do?',
    );
    assert.equal(lost.result.stopReason, 'done');
  } finally {
    f.dispose();
    g.dispose();
  }
});

test('a card names its target, closes on a completion under an unknown id or when the agent moves on, and an edit waits for its status', async () => {
  const trail = (events: AgentEvent[]) =>
    events.flatMap((event) =>
      event.type === 'tool.started' || event.type === 'tool.output'
        ? [`${event.type.slice(5)} ${event.callId}`]
        : event.type === 'tool.completed'
          ? [
              `${event.status} ${event.callId}${event.diff ? ' with diff' : ''}${event.summary ? `: ${event.summary}` : ''}`,
            ]
          : [],
    );
  const rows: { edit: (line: string) => string[]; trail: string[]; titles?: string[] }[] = [
    {
      // The agent titles each call with its tool name. A card names the file, the pattern or
      // the command when the frame gives one, and keeps the agent's title when it does not.
      edit: (line) => {
        const frame = JSON.parse(line);
        const update = frame.params?.update;
        if (update?.toolCallId === 'read-1' && update.sessionUpdate === 'tool_call_update')
          return [];
        if (update?.toolCallId !== 'read-1') return [line];
        const file = update.locations[0].path;
        const cwd = file.slice(0, file.lastIndexOf('/'));
        const call = (toolCallId: string, kind: string, rawInput: object, path?: string) =>
          JSON.stringify({
            ...frame,
            params: {
              ...frame.params,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId,
                title: `${kind}_tool`,
                kind,
                status: 'in_progress',
                rawInput,
                ...(path ? { locations: [{ path }] } : {}),
              },
            },
          });
        return [
          call('read-1', 'read', { AbsolutePath: file, StartLine: 3, EndLine: 9 }, file),
          call('read-2', 'read', {}, '/outside/notes.md'),
          call('read-3', 'read', {}),
          call('search-1', 'search', { Query: 'total' }, `${cwd}/src`),
          call('search-2', 'search', { Query: 'total' }, cwd),
          call('edit-2', 'edit', {}, file),
          call('run-1', 'execute', { CommandLine: `${'x'.repeat(130)}\nsecond line` }),
        ];
      },
      titles: [
        'Read net.mjs lines 3-9',
        'Read /outside/notes.md',
        'read_tool',
        'Search total in src',
        'Search total',
        'Edit net.mjs',
        `Run ${'x'.repeat(119)}…`,
        'Edit net.mjs',
      ],
      trail: [
        'started read-1',
        'started read-2',
        'started read-3',
        'started search-1',
        'started search-2',
        'started edit-2',
        'started run-1',
        'started edit-1',
        'ok edit-1 with diff',
        'ok read-1',
        'ok read-2',
        'ok read-3',
        'ok search-1',
        'ok search-2',
        'error edit-2: The turn ended before this tool reported a result.',
        'error run-1: The turn ended before this tool reported a result.',
      ],
    },
    {
      // A fetch arrives as other. The agent's reply closes it with no output and no words, so
      // the card stays one line.
      edit: (line) => {
        const frame = JSON.parse(line);
        const update = frame.params?.update;
        if (update?.toolCallId !== 'read-1') return [line];
        if (update.sessionUpdate === 'tool_call_update') return [];
        return [
          JSON.stringify({
            ...frame,
            params: {
              ...frame.params,
              update: { ...update, toolCallId: 'fetch-1', kind: 'fetch', locations: undefined },
            },
          }),
        ];
      },
      trail: ['started fetch-1', 'started edit-1', 'ok edit-1 with diff', 'ok fetch-1'],
    },
    {
      // The read's completion arrives under a frame id the agent never announced.
      edit: (line) => {
        const frame = JSON.parse(line);
        const update = frame.params?.update;
        if (update?.toolCallId === 'read-1' && update.status === 'completed')
          update.toolCallId = 'frame-9';
        return [JSON.stringify(frame)];
      },
      trail: [
        'started read-1',
        'output read-1',
        'ok read-1',
        'started edit-1',
        'ok edit-1 with diff',
      ],
    },
    {
      // An edit opens first, a read runs beside it, and a search starts while the read is still
      // running. The read then fails. A new call does not close the read, so its status stands.
      edit: (line) => {
        const frame = JSON.parse(line);
        const update = frame.params?.update;
        const swap = (next: object) =>
          JSON.stringify({ ...frame, params: { ...frame.params, update: next } });
        if (update?.sessionUpdate === 'tool_call' && update.toolCallId === 'read-1')
          return [
            swap({
              sessionUpdate: 'tool_call',
              toolCallId: 'edit-1',
              title: 'Edit net.mjs',
              kind: 'edit',
              status: 'pending',
            }),
            line,
          ];
        if (update?.sessionUpdate === 'tool_call' && update.toolCallId === 'edit-1')
          return [
            swap({
              sessionUpdate: 'tool_call',
              toolCallId: 'search-1',
              title: 'Search total',
              kind: 'search',
              status: 'in_progress',
            }),
            swap({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'failed' }),
          ];
        return update?.toolCallId === 'read-1' && update.status === 'completed' ? [] : [line];
      },
      trail: [
        'started edit-1',
        'started read-1',
        'started search-1',
        'error read-1',
        'ok edit-1 with diff',
        'ok search-1',
      ],
    },
    {
      // A usage update closes the read, the edit parks on a permission card, and the read's
      // completion arrives late under a frame id with no title. It must not close the edit.
      edit: (line) => {
        const frame = JSON.parse(line);
        const update = frame.params?.update;
        const swap = (next: object) =>
          JSON.stringify({ ...frame, params: { ...frame.params, update: next } });
        if (update?.sessionUpdate === 'tool_call' && update.toolCallId === 'read-1')
          return [line, swap({ sessionUpdate: 'usage_update', used: 20, size: 1024 })];
        if (update?.sessionUpdate === 'tool_call' && update.toolCallId === 'edit-1')
          return [
            swap({
              ...update,
              content: [{ type: 'diff', path: 'net.mjs', oldText: 'a\n', newText: 'b\n' }],
            }),
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'perm-9',
              method: 'session/request_permission',
              params: {
                sessionId: frame.params.sessionId,
                toolCall: { toolCallId: 'edit-1' },
                options: [{ optionId: 'once', name: 'Once', kind: 'allow_once' }],
              },
            }),
            swap({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'frame-9',
              status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: 'export const' } }],
            }),
          ];
        return update?.sessionUpdate === 'tool_call_update' ? [] : [line];
      },
      trail: [
        'started read-1',
        'ok read-1',
        'started edit-1',
        'error edit-1: The turn ended before this tool reported a result.',
      ],
    },
  ];
  for (const row of rows) {
    const f = rig('chat-stream', rewrite(String(row.edit)));
    try {
      const turn = await run(f, request(f));
      assert.deepEqual(trail(turn.events), row.trail);
      if (row.titles)
        assert.deepEqual(
          of(turn.events, 'tool.started').map((event) => event.title),
          row.titles,
        );
      assert.equal(turn.result.stopReason, 'done');
    } finally {
      f.dispose();
    }
  }
});

test('a permission request parks the turn until answered, and the policy answers only what it allows', async () => {
  const options = [
    { id: 'once', label: 'Once', kind: 'allow-once' },
    { id: 'always', label: 'Always', kind: 'allow-thread' },
    { id: 'deny', label: 'Deny', kind: 'deny' },
  ];
  for (const row of [
    {
      policy: 'ask',
      scenario: 'chat-permission',
      answer: 'always',
      selected: 'always',
      status: 'ok',
      changed: ['net.mjs'],
    },
    {
      policy: 'allow-edits',
      scenario: 'chat-permission',
      answer: null,
      selected: 'once',
      status: 'ok',
      changed: ['net.mjs'],
    },
    {
      policy: 'allow-edits',
      scenario: 'chat-permission-execute',
      answer: 'deny',
      selected: 'deny',
      status: 'denied',
      changed: [],
    },
    {
      policy: 'allow-edits',
      scenario: 'chat-permission-outside',
      answer: 'deny',
      selected: 'deny',
      status: 'denied',
      changed: [],
    },
    {
      policy: 'allow-all',
      scenario: 'chat-permission-execute',
      answer: null,
      selected: 'once',
      status: 'ok',
      changed: [],
    },
    {
      policy: 'allow-all',
      scenario: 'chat-permission-outside',
      answer: 'deny',
      selected: 'deny',
      status: 'denied',
      changed: [],
    },
    {
      // The client announces a kind this app does not know, so the call counts as other. A
      // thread grant for other does not answer it.
      policy: 'ask',
      scenario: 'chat-permission',
      announced: 'think',
      grants: ['other'],
      answer: 'once',
      selected: 'once',
      status: 'ok',
      changed: [],
    },
    {
      // The protocol's own delete kind marks the request, whatever the title says.
      policy: 'ask',
      scenario: 'chat-permission',
      announced: 'delete',
      answer: 'once',
      selected: 'once',
      status: 'ok',
      changed: ['net.mjs'],
    },
  ] as const) {
    const f = rig(row.scenario, 'announced' in row && row.announced ? announce(row.announced) : '');
    try {
      let answered = false;
      const patch = {
        permissionPolicy: row.policy,
        ...('grants' in row ? { permissionGrants: row.grants } : {}),
      };
      const turn = await run(f, request(f, patch), (event, handle) => {
        if (event.type === 'permission.requested' && row.answer !== null)
          setImmediate(() => {
            answered = true;
            handle.respondPermission(event.requestId, row.answer);
          });
        // A parked request resolves only after the person answers. An automatic one never waits.
        if (event.type === 'permission.resolved') assert.equal(answered, row.answer !== null);
      });
      const label = `${row.policy} ${row.scenario}`;
      const requested = of(turn.events, 'permission.requested');
      assert.equal(requested.length, 1, label);
      assert.equal(requested[0].callId, 'tool-1', label);
      // The request names only the tool call id. The question comes from the earlier tool_call.
      assert.equal(
        requested[0].question,
        row.scenario === 'chat-permission-execute' ? 'Run ls?' : 'Run replace_file_content?',
        label,
      );
      assert.deepEqual(requested[0].options, options, label);
      assert.equal(
        requested[0].deletes,
        'announced' in row && row.announced === 'delete' ? true : undefined,
        label,
      );
      assert.deepEqual(
        of(turn.events, 'permission.resolved').map((event) => event.choice),
        [row.selected],
        label,
      );
      assert.deepEqual(
        turn.frames.find((frame) => frame.id === 'perm-1')?.result,
        { outcome: { outcome: 'selected', optionId: row.selected } },
        label,
      );
      assert.deepEqual(
        of(turn.events, 'tool.completed').map((event) => event.status),
        [row.status],
        label,
      );
      assert.equal(turn.result.stopReason, 'done', label);
      assert.deepEqual(turn.result.changedPaths, row.changed, label);
    } finally {
      f.dispose();
    }
  }
});

test('stop sends a cancel, keeps the partial text, declines a parked permission and reports stopped', async () => {
  // The agent answers a cancel with a line of its own, here in two pieces. After the person's
  // stop it stays out of the thread. When the agent cancels on its own, it is the reply.
  const said = (text: string) =>
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'chat-session-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    });
  const f = rig(
    'chat-cancel',
    rewrite(
      `(line)=>line.includes('"stopReason":"cancelled"')?[${JSON.stringify(said('\n\nThe request was '))},${JSON.stringify(said('cancelled by the client.'))},line]:[line]`,
    ),
  );
  const g = rig('chat-permission');
  const h = rig(
    'chat-max-tokens',
    rewrite(
      `(line)=>[line.replace('"max_tokens"','"cancelled"').replace('"cut off"','"The request was cancelled by the client."')]`,
    ),
  );
  try {
    const turn = await run(f, request(f), (event, handle) => {
      if (event.type === 'text.delta') setImmediate(() => handle.stop());
    });
    assert.deepEqual(
      withMethod(turn.frames, 'session/cancel').map((frame) => frame.params),
      [{ sessionId: 'chat-session-1' }],
    );
    assert.deepEqual(types(turn.events), [
      'turn.started',
      'text.delta',
      'text.completed',
      'turn.completed',
    ]);
    assert.equal(turn.result.stopReason, 'stopped');
    assert.equal(turn.result.failure, null);
    assert.equal(turn.result.assistantText, 'working');
    assert.equal(turn.result.session?.sessionId, 'chat-session-1');

    // The person presses Stop while the permission card is up. The agent is told no, and the
    // card closes.
    const parked = await run(g, request(g), (event, handle) => {
      if (event.type === 'permission.requested') setImmediate(() => handle.stop());
    });
    assert.deepEqual(
      of(parked.events, 'permission.resolved').map((event) => event.choice),
      ['cancelled'],
    );
    assert.deepEqual(parked.frames.find((frame) => frame.id === 'perm-1')?.result, {
      outcome: { outcome: 'cancelled' },
    });
    assert.deepEqual(
      of(parked.events, 'tool.completed').map((event) => event.status),
      ['error'],
    );
    assert.equal(parked.result.stopReason, 'stopped');
    assert.equal(parked.result.failure, null);

    const own = await run(h, request(h));
    assert.equal(own.result.stopReason, 'stopped');
    assert.equal(own.result.assistantText, 'The request was cancelled by the client.');
  } finally {
    f.dispose();
    g.dispose();
    h.dispose();
  }
});

test('the end of a prompt becomes a stop reason, a quota error carries its reset time, and files go as the blocks the agent declared', async () => {
  type Stored = ReturnType<typeof stored>;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);
  const link = ({ attachment, path }: Stored) => ({
    type: 'resource_link',
    uri: pathToFileURL(path).href,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.bytes,
  });
  const declared = { image: true, audio: true, embeddedContext: true };
  const none = { image: false, audio: false, embeddedContext: false };
  for (const row of [
    {
      scenario: 'chat-max-tokens',
      stopReason: 'done',
      failure: null,
      notice: 'The reply stopped at the model output limit.',
    },
    {
      // Each file goes in the richest block the agent declared. Text files embed as text.
      scenario: 'chat-attach',
      stopReason: 'done',
      failure: null,
      files: (f: Rig) => [
        stored(f, 'shot.png', 'image/png', png),
        stored(f, 'memo.wav', 'audio/wav', 'RIFF fixture'),
        stored(f, 'notes.md', 'text/markdown', '# Notes\n'),
        stored(f, 'report.pdf', 'application/pdf', '%PDF-1.7 fixture'),
      ],
      blocks: (files: Stored[]) => [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        {
          type: 'audio',
          data: Buffer.from('RIFF fixture').toString('base64'),
          mimeType: 'audio/wav',
        },
        {
          type: 'resource',
          resource: {
            uri: pathToFileURL(files[2].path).href,
            mimeType: 'text/markdown',
            text: '# Notes\n',
          },
        },
        {
          type: 'resource',
          resource: {
            uri: pathToFileURL(files[3].path).href,
            mimeType: 'application/pdf',
            blob: Buffer.from('%PDF-1.7 fixture').toString('base64'),
          },
        },
      ],
      capabilities: declared,
    },
    {
      // An inline form past the frame limit goes as a link, and the turn says so.
      scenario: 'chat-attach',
      stopReason: 'done',
      failure: null,
      files: (f: Rig) => [stored(f, 'large.png', 'image/png', Buffer.alloc(16 * 1024 * 1024, 1))],
      blocks: (files: Stored[]) => files.map(link),
      capabilities: declared,
      notice: 'Sent as a file link, too large to send inline: large.png.',
    },
    {
      // An earlier file goes as a link even where the agent declared its block, with no notice.
      scenario: 'chat-attach',
      stopReason: 'done',
      failure: null,
      files: (f: Rig) => [{ ...stored(f, 'shot.png', 'image/png', png), earlier: true }],
      blocks: (files: Stored[]) => files.map(link),
      capabilities: declared,
    },
    {
      // A prompt error over earlier files alone is not a refusal of them.
      scenario: 'chat-error',
      stopReason: 'error',
      failure: { kind: 'protocol', method: 'session/prompt', code: -32603, resetsAt: null },
      files: (f: Rig) => [{ ...stored(f, 'shot.png', 'image/png', png), earlier: true }],
      blocks: (files: Stored[]) => files.map(link),
      capabilities: none,
    },
    {
      // An agent that declares nothing gets a link, which every agent must accept.
      scenario: 'chat-stream',
      stopReason: 'done',
      failure: null,
      files: (f: Rig) => [stored(f, 'shot.png', 'image/png', png)],
      blocks: (files: Stored[]) => files.map(link),
      capabilities: none,
    },
    {
      scenario: 'chat-error',
      stopReason: 'error',
      failure: {
        kind: 'attachment-rejected',
        method: 'session/prompt',
        code: -32603,
        resetsAt: null,
        providerMessage: 'Internal error: boom',
      },
      files: (f: Rig) => [stored(f, 'shot.png', 'image/png', png)],
      blocks: (files: Stored[]) => files.map(link),
      capabilities: none,
    },
    {
      // A quota error stays a quota error when the prompt carried files.
      scenario: 'chat-quota',
      stopReason: 'limit',
      failure: {
        kind: 'usage-limit',
        method: 'session/prompt',
        code: -32603,
        resetsAt: '2026-10-23T14:30:00.000Z',
      },
      files: (f: Rig) => [stored(f, 'shot.png', 'image/png', png)],
      blocks: (files: Stored[]) => files.map(link),
      capabilities: none,
    },
    {
      scenario: 'chat-refusal',
      stopReason: 'error',
      failure: { kind: 'model-unavailable', method: 'session/prompt', code: null, resetsAt: null },
    },
    {
      scenario: 'chat-quota',
      stopReason: 'limit',
      failure: {
        kind: 'usage-limit',
        method: 'session/prompt',
        code: -32603,
        resetsAt: '2026-10-23T14:30:00.000Z',
      },
    },
    {
      scenario: 'chat-error',
      stopReason: 'error',
      failure: { kind: 'protocol', method: 'session/prompt', code: -32603, resetsAt: null },
    },
  ] as const) {
    const f = rig(row.scenario);
    try {
      const files = row.files?.(f) ?? [];
      const turn = await run(f, request(f, { files }));
      if (row.blocks) {
        const [prompt] = withMethod(turn.frames, 'session/prompt');
        assert(prompt?.params, row.scenario);
        const [text, ...rest] = prompt.params.prompt as unknown[];
        assert.deepEqual(
          text,
          {
            type: 'text',
            text: 'You are working in a scratch copy of demo.\n\nWhat does this project do?',
          },
          row.scenario,
        );
        assert.deepEqual(rest, row.blocks(files), row.scenario);
        assert.deepEqual(turn.capabilities, [row.capabilities], row.scenario);
      }
      assert.equal(turn.result.stopReason, row.stopReason, row.scenario);
      const last = of(turn.events, 'turn.completed')[0];
      assert.equal(last.stopReason, row.stopReason, row.scenario);
      assert.deepEqual(last.failure, turn.result.failure, row.scenario);
      if (row.failure === null) assert.equal(turn.result.failure, null, row.scenario);
      else {
        const { failure } = turn.result;
        assert.deepEqual(
          {
            kind: failure?.kind,
            method: failure?.method,
            code: failure?.code,
            resetsAt: failure?.resetsAt,
            ...('providerMessage' in row.failure
              ? { providerMessage: failure?.providerMessage }
              : {}),
          },
          row.failure,
          row.scenario,
        );
        assert(failure?.message && failure.nextAction, row.scenario);
      }
      const notices = of(turn.events, 'provider.notice').map((event) => event.message);
      assert.deepEqual(notices, 'notice' in row ? [row.notice] : [], row.scenario);
    } finally {
      f.dispose();
    }
  }
});

test('an unknown update or method goes to the frame trace and never the thread, and the turn goes on', async () => {
  const f = rig('chat-unknown');
  try {
    // The launch offers no thought-level choice, so a high selection runs at the client default
    // and the badge says so.
    const req = request(f, {
      selection: { family: 'google', model: 'fixture-model', effort: 'high' },
    });
    const turn = await run(f, req);
    assert.equal(of(turn.events, 'turn.started')[0]?.effort, 'default');
    assert.deepEqual(types(turn.events), [
      'turn.started',
      'text.delta',
      'text.completed',
      'turn.completed',
    ]);
    const trace = readFileSync(join(req.work.directory, 'acp-trace.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(trace.flatMap((line) => line.update ?? line.method ?? []).slice(-4), [
      'fancy_new_update',
      '$/progress',
      'fancy_new_update',
      'agent_message_chunk',
    ]);
    assert.equal(turn.result.stopReason, 'done');
    assert.equal(turn.result.assistantText, 'still here');
  } finally {
    f.dispose();
  }
});
