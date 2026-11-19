import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLI_JSON_LINE_SHAPE, type CliJsonLine, CliJsonLineSchema } from '@crewkite/contracts';
import { cliJsonLineShape } from '../../../../packages/contracts/src/cli-shape.ts';
import { createSyntheticRepository } from '../../../../packages/testkit/src/repository.ts';
import { OperationStore } from '../../../controller/src/commands/operation-store.ts';
import { installedTools } from '../../../controller/src/store/controller-fixture.ts';
import { printRequested, runCli } from '../main.ts';
import { startScriptedController } from '../scripted-controller.ts';
import type { ChatClient } from './client.ts';
import { connectChat } from './connect.ts';
import { runPrint, waitingQueueLine } from './scripting.ts';

const failure = {
  stage: 'stream' as const,
  kind: 'usage-limit' as const,
  message: 'The provider reached its usage limit.',
  providerMessage: null,
  method: null,
  code: null,
  resetsAt: null,
  nextAction: 'Continue on another provider.',
};

async function listThreadIds(home: string) {
  const client = await connectChat(home);
  try {
    return (await client.listThreads()).threads.map((thread) => thread.id);
  } finally {
    client.transport.close();
  }
}

function capture(onOut: (text: string) => void = () => {}) {
  const io = { out: '', err: '' };
  return {
    io,
    output: {
      out: (text: string) => {
        io.out += text;
        onOut(text);
      },
      err: (text: string) => {
        io.err += text;
      },
    },
  };
}

test('print mode streams the reply, uses only a registered checkout and exits with its status', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository, directory, stop } = await startScriptedController(t, [
    [{ kind: 'text', itemId: 'reply', chunks: ['The total ', 'is 2500.'] }],
    [{ kind: 'fail', stopReason: 'limit', failure }],
    [{ kind: 'wait' }],
    [{ kind: 'text', itemId: 'reply', chunks: ['Registered.'] }],
    [{ kind: 'wait' }],
  ]);
  const added = capture();
  assert.equal(await runCli(['project', 'add', repository, '--home', home], added.output), 0);
  // A permission policy in cli.json is never applied by itself.
  writeFileSync(join(home, 'cli.json'), JSON.stringify({ permissionPolicy: 'allow-all' }));
  const model = ['--model', 'anthropic/fixture-model', '--home', home];
  const plainEnv = { ...process.env, INIT_CWD: '' };
  // pnpm runs from the package root and names the caller's directory in INIT_CWD. A GIT_DIR from
  // the caller must not move the checkout.
  const env = { ...process.env, INIT_CWD: repository, GIT_DIR: tmpdir(), GIT_WORK_TREE: tmpdir() };
  const elsewhere = mkdtempSync(join(tmpdir(), 'crewkite-cwd-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));

  const cases = [
    {
      name: 'done',
      args: [] as string[],
      stdout: 'The total is 2500.\n',
      stderr: /Thread tsk_[\s\S]*Permission policy: ask/,
      code: 0,
      policy: 'ask',
    },
    {
      name: 'failed',
      args: ['--permission-policy', 'allow-edits'],
      stdout: '',
      stderr: /Permission policy: allow-edits[\s\S]*usage limit[\s\S]*another provider/,
      code: 1,
      policy: 'allow-edits',
    },
  ];
  for (const row of cases) {
    const run = capture();
    const code = await runPrint(
      ['-p', `Check the ${row.name} total`, ...row.args, ...model],
      run.output,
      connectChat,
      elsewhere,
      env,
    );
    assert.equal(code, row.code, `${row.name}: ${run.io.err}`);
    assert.equal(run.io.out, row.stdout, row.name);
    assert.match(run.io.err, row.stderr, row.name);
    const taskId = /Thread (tsk_\w+)/.exec(run.io.err)?.[1] ?? '';
    const client = await connectChat(home);
    assert.equal((await client.readThread(taskId)).thread.permissionPolicy, row.policy);
    client.transport.close();
  }

  // Stop from another command while the reply waits. The print run exits with the stopped code.
  const started = Promise.withResolvers<string>();
  const run = capture((text) => {
    for (const line of text.split('\n').filter(Boolean)) {
      const parsed = CliJsonLineSchema.parse(JSON.parse(line));
      if (parsed.kind === 'event' && parsed.event.type === 'agent.event')
        if (parsed.event.payload.type === 'turn.started') started.resolve(parsed.taskId);
    }
  });
  const printing = runPrint(
    ['-p', 'Wait for me', '--json', ...model],
    run.output,
    connectChat,
    repository,
    plainEnv,
  );
  const taskId = await started.promise;
  // A message queued behind the running reply stays, paused, and the stop says it is waiting.
  const queuing = await connectChat(home);
  const queued = await queuing.sendMessage({
    taskId,
    text: 'Then the totals.',
    selection: { family: 'anthropic', model: 'fixture-model', effort: 'default' },
  });
  assert.equal(queued.outcome, 'applied');
  assert.equal((await queuing.readThread(taskId)).thread.queued.length, 1);
  queuing.transport.close();
  const stopped = capture();
  assert.equal(await runCli(['thread', 'stop', taskId, '--home', home], stopped.output), 0);
  assert.equal(stopped.io.out, 'Stopped. 1 queued message is waiting.\n');
  assert.equal(await printing, 3);

  // A checkout the controller does not hold is refused without registering it, and the refusal
  // names the flag that registers it. Arguments that do not parse are a usage error too.
  const other = createSyntheticRepository(join(directory, 'other')).directory;
  const refused = capture();
  assert.equal(
    await runPrint(['-p', 'Hello', ...model], refused.output, connectChat, other, plainEnv),
    2,
  );
  assert.match(refused.io.err, /not a registered project. Pass --register/);
  const client = await connectChat(home);
  assert.deepEqual(
    (await client.listProjects()).map((project) => project.name),
    ['shop'],
  );
  client.transport.close();
  const registered = capture();
  assert.equal(
    await runPrint(
      ['-p', 'Hello', '--register', ...model],
      registered.output,
      connectChat,
      other,
      plainEnv,
    ),
    0,
  );
  assert.match(registered.io.err, /Registered .*other as project/);
  for (const args of [
    ['-p', 'Hello', '--bogus', ...model],
    ['-p', 'Hello', '--permission-policy', 'always', ...model],
    ['thread', 'list', '--bogus'],
    ['task', 'list', '--bogus'],
  ])
    assert.equal(await runCli(args, capture().output), 2, args.join(' '));
  assert.equal(printRequested(['task', 'show', 'tsk_x', '-p']), false);
  assert.equal(printRequested(['--home', 'h', '-p', 'Hello']), true);

  // The controller goes away mid-reply. Print mode settles with a plain line and status 1.
  const lostStarted = Promise.withResolvers<void>();
  const lost = capture((text) => {
    if (text.includes('"turn.started"')) lostStarted.resolve();
  });
  const losing = runPrint(
    ['-p', 'Wait again', '--json', ...model],
    lost.output,
    (path) => connectChat(path, { reconnectDelaysMs: [] }),
    repository,
    plainEnv,
  );
  await lostStarted.promise;
  await stop();
  assert.equal(await losing, 1);
  assert.match(lost.io.out, /connection to the controller ended/);
  assert.equal(
    lost.io.err.match(/^Lost the controller\. Reconnecting for about a minute\.$/gm)?.length,
    1,
  );
});

test('thread commands with --json write only lines the published schema accepts', {
  timeout: 60_000,
}, async (t) => {
  const { home, repository } = await startScriptedController(t, [
    [
      { kind: 'tool', callId: 'read-1', toolKind: 'read', title: 'Read net.mjs' },
      { kind: 'permission', requestId: 'edit-1', question: 'Edit net.mjs?' },
      {
        kind: 'tool',
        callId: 'edit-1',
        toolKind: 'edit',
        title: 'Edit net.mjs',
        write: { path: 'net.mjs', content: 'export const net = 1;\n' },
      },
      { kind: 'text', itemId: 'reply', chunks: ['Edited.'] },
    ],
  ]);
  const projectRun = capture();
  assert.equal(
    await runCli(['project', 'add', repository, '--json', '--home', home], projectRun.output),
    0,
  );
  const projectId = JSON.parse(projectRun.io.out).result?.entity?.id;
  assert.ok(projectId, projectRun.io.out);

  // `v` names one fixed shape: a change to any line or embedded chat shape moves this hash.
  assert.equal(cliJsonLineShape(), CLI_JSON_LINE_SHAPE);
  const lines: CliJsonLine[] = [];
  const asked = Promise.withResolvers<{ taskId: string; requestId: string }>();
  const parse = (text: string) => {
    for (const line of text.split('\n').filter(Boolean)) {
      const parsed = CliJsonLineSchema.parse(JSON.parse(line));
      lines.push(parsed);
      if (
        parsed.kind === 'event' &&
        parsed.event.type === 'agent.event' &&
        parsed.event.payload.type === 'permission.requested'
      )
        asked.resolve({ taskId: parsed.taskId, requestId: parsed.event.payload.requestId });
    }
  };
  const watching = runCli(
    [
      'thread',
      'new',
      projectId,
      'Clamp the discount',
      '--model',
      'anthropic/fixture-model',
      '--watch',
      '--json',
      '--home',
      home,
    ],
    capture(parse).output,
  );
  const { taskId, requestId } = await asked.promise;
  const permit = capture(parse);
  assert.equal(
    await runCli(['thread', 'permit', taskId, requestId, '--json', '--home', home], permit.output),
    0,
  );
  assert.equal(await watching, 0);
  const end = lines.findLast((line) => line.kind === 'turn-end');
  assert.equal(end?.kind === 'turn-end' && end.status, 'done');
  assert.ok(
    lines.some((line) => line.kind === 'result' && line.command === 'ResolveChatPermission'),
  );

  for (const args of [['list'], ['show', taskId]]) {
    const run = capture(parse);
    assert.equal(await runCli(['thread', ...args, '--json', '--home', home], run.output), 0);
  }
  assert.ok(
    lines.some(
      (line) => line.kind === 'threads' && line.threads.some((row) => row.taskId === taskId),
    ),
  );
  assert.ok(lines.some((line) => line.kind === 'thread' && line.read.thread.taskId === taskId));

  // The Changes list reads through the controller, as text and as one schema line.
  const changes = capture();
  assert.equal(
    await runCli(['thread', 'changes', taskId, '--home', home], changes.output),
    0,
    changes.io.err,
  );
  assert.match(changes.io.out, /^\+\d+ -\d+ net\.mjs\n$/);
  assert.equal(
    await runCli(['thread', 'changes', taskId, '--json', '--home', home], capture(parse).output),
    0,
  );
  const listed = lines.findLast((line) => line.kind === 'result');
  assert.equal(listed?.kind === 'result' && listed.command, 'ReadChatChanges');
  const listedFiles = (listed?.kind === 'result' ? listed.data : undefined) as
    | { kind: string; files: { path: string; patch: string | null }[] }
    | undefined;
  assert.equal(listedFiles?.kind, 'chat-changes');
  assert.deepEqual(
    listedFiles?.files.map((file) => [file.path, file.patch]),
    [['net.mjs', null]],
  );
  // A task command that the controller refuses exits 2.
  const refusal = capture();
  assert.equal(await runCli(['task', 'changes', taskId, '--home', home], refusal.output), 2);
  assert.equal(refusal.io.out, 'candidate-not-ready\n');

  // A refused first message leaves no thread behind, however it was refused.
  const threadsBefore = (await listThreadIds(home)).length;
  const missing = join(tmpdir(), 'crewkite-no-such-file.txt');
  for (const args of [
    ['thread', 'new', projectId, 'Read this', '--file', missing],
    ['-p', 'Read this', '--project', projectId, '--file', missing],
  ]) {
    const refused = capture();
    const code = await runCli(
      [...args, '--model', 'anthropic/fixture-model', '--home', home],
      refused.output,
    );
    assert.notEqual(code, 0, refused.io.err);
    assert.equal((await listThreadIds(home)).length, threadsBefore, args.join(' '));
  }

  // A send whose answer is lost may have been accepted, so its thread stays and its id prints.
  const beforeUnknown = (await listThreadIds(home)).length;
  const unknown = capture();
  const unknownCode = await runCli(
    [
      'thread',
      'new',
      projectId,
      'Maybe sent',
      '--model',
      'anthropic/fixture-model',
      '--home',
      home,
    ],
    unknown.output,
    async (path) => {
      const client = await connectChat(path);
      const command = client.transport.command.bind(client.transport);
      client.transport.command = async (input) => {
        const result = await command(input);
        return input.command === 'SendChatMessage'
          ? { outcome: 'outcome-unknown', reason: 'connection-lost' }
          : result;
      };
      return client;
    },
  );
  assert.equal(unknownCode, 2);
  assert.equal((await listThreadIds(home)).length, beforeUnknown + 1);
  assert.match(unknown.io.out, /^tsk_\w+\n$/);

  // A malformed ID is one line and status 2, before the controller is asked anything.
  for (const [args, line] of [
    [['thread', 'show', 'tsk_nope'], /^That is not a thread ID\.[^\n]*\n$/],
    [['thread', 'new', 'prj_nope', 'Hi'], /^That is not a project ID\.[^\n]*\n$/],
    [['-p', 'Hi', '--project', 'prj_nope'], /^That is not a project ID\.[^\n]*\n$/],
    [['-p', 'Hi', '--thread', 'tsk_nope'], /^That is not a thread ID\.[^\n]*\n$/],
  ] as const) {
    const refused = capture();
    assert.equal(await runCli([...args, '--home', home], refused.output), 2, args.join(' '));
    assert.match(refused.io.err, line, args.join(' '));
    assert.equal(refused.io.out, '', args.join(' '));
  }

  // Accept makes a local branch. Push without --confirm sends nothing and names the commit it
  // would push. A push that names another commit is refused before git runs.
  const accept = capture(parse);
  assert.equal(
    await runCli(
      ['thread', 'accept', taskId, 'feat/clamp-discount', '--json', '--home', home],
      accept.output,
    ),
    0,
  );
  const accepted = lines.at(-1);
  const commit =
    accepted?.kind === 'result' ? (accepted.data as { commit?: string } | undefined)?.commit : '';
  const push = (...args: string[]) =>
    runCli(['thread', 'push', taskId, ...args, '--json', '--home', home], capture(parse).output);
  assert.equal(await push(), 2);
  const last = lines.at(-1);
  assert.equal(
    last?.kind === 'error' ? last.message : '',
    `This pushes commit ${commit} to feat/clamp-discount on origin with your own git credentials. Run it again with --confirm --commit ${commit} to push.`,
  );
  assert.equal(await push('--confirm', '--commit', '0'.repeat(40)), 2);
  const stale = lines.at(-1);
  assert.deepEqual(stale?.kind === 'result' && [stale.command, stale.reason], [
    'PushChatBranch',
    'branch-not-accepted',
  ]);

  // A merge check needs a base: the pull request's, or --base. The project has no origin, so the
  // controller's fetch fails on this computer and its refusal comes back as one result line.
  const merge = (...args: string[]) =>
    runCli(
      ['thread', 'merge-check', taskId, ...args, '--json', '--home', home],
      capture(parse).output,
    );
  assert.equal(await merge(), 2);
  const unnamed = lines.at(-1);
  assert.match(unnamed?.kind === 'error' ? unnamed.message : '', /--base/);
  assert.equal(await merge('--base', 'main'), 2);
  const checked = lines.at(-1);
  assert.deepEqual(
    checked?.kind === 'result' && [checked.command, checked.outcome, checked.reason],
    ['CheckChatMerge', 'blocked', 'fetch-failed'],
  );
});

// Claim: a refused send prints its admission, exits notDone and never waits for a turn. The
// controller's answer is injected, and the thread never opens a turn.
test('print mode writes a refused admission, exits 2 and does not wait for a turn', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'crewkite-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const taskId = 'tsk_01HZZZZZZZZZZZZZZZZZZZZZZZ';
  const read = {
    thread: { taskId, activeTurnId: null, permissionPolicy: 'ask', queued: [] },
    turns: [],
    messages: [],
    liveEvents: [],
    cursor: '0',
  };
  const model = { model: 'm', label: 'm', defaultEffort: 'default' };
  const catalog = {
    families: [{ family: 'openai', connected: true, defaultModel: 'm', models: [model] }],
  };
  let waits = 0;
  const client = {
    readCatalog: async () => catalog,
    readThread: async () => read,
    send: async () => ({
      outcome: 'blocked',
      reason: 'credits-paused',
      next: 'Turn credit spending on in Settings or pick another provider.',
    }),
    transport: {
      subscribe: async () => {
        waits += 1;
        return () => {};
      },
      close: () => {},
    },
  } as unknown as ChatClient;
  const run = capture();
  const code = await runPrint(
    ['-p', 'Fix it', '--thread', taskId, '--model', 'openai', '--json', '--home', home],
    run.output,
    async () => client,
  );
  assert.equal(code, 2);
  const lines = run.io.out
    .split('\n')
    .filter(Boolean)
    .map((value) => CliJsonLineSchema.parse(JSON.parse(value)));
  assert.deepEqual(
    lines.map((value) => value.kind),
    ['result'],
  );
  const [result] = lines;
  assert.deepEqual(result.kind === 'result' && result.admission, {
    outcome: 'refused',
    reason: 'credits-paused',
    message: 'OpenAI is out of included allowance and credit spending is off.',
    next: 'Turn credit spending on in Settings or pick another provider.',
  });
  assert.equal(waits, 1);
});

// Claim: with --json, an option that does not parse still ends in a JSON error line.
test('an unknown option with --json prints a JSON error line', async () => {
  for (const args of [
    ['-p', 'Hello', '--bogus', '--json'],
    ['thread', 'list', '--bogus', '--json'],
  ]) {
    const run = capture();
    const code = await (args[0] === '-p'
      ? runPrint(args, run.output, connectChat)
      : runCli(args, run.output));
    assert.equal(code, 2, args.join(' '));
    const line = CliJsonLineSchema.parse(JSON.parse(run.io.out));
    assert.equal(line.kind, 'error', args.join(' '));
  }
});

test('a computer without git reports degraded health and names git when it refuses a project', {
  timeout: 60_000,
}, async (t) => {
  const rows = [
    { state: 'missing', line: 'git was not found' },
    { state: 'broken', line: 'git failed to run' },
  ] as const;
  for (const row of rows) {
    const { home, directory } = await startScriptedController(t, [], { gitState: () => row.state });
    const health = capture();
    assert.equal(await runCli(['health', '--home', home], health.output), 0);
    assert.equal(health.io.out, `degraded\n${row.line}\n`, row.state);
    // A folder that is no repository gets the same answer, since git cannot be asked.
    const folder = mkdtempSync(join(directory, 'plain-'));
    const refused = capture();
    assert.equal(await runCli(['project', 'add', folder, '--home', home], refused.output), 2);
    assert.match(refused.io.out, new RegExp(`^git-unavailable\\n${row.line}\\.`), row.state);
    assert.doesNotMatch(refused.io.out, /Choose a readable/, row.state);
  }
});

test('thread stop names how many queued messages wait behind it and says nothing when none do', () => {
  const message = {
    id: 'msg_00000000000000000000000001',
    at: '2026-10-23T12:00:00.000Z',
    text: 'Then the totals.',
    role: 'assistant' as const,
    attachments: [],
    files: [],
  };
  const rows = [
    { name: 'no data', result: { outcome: 'applied' as const }, line: null },
    {
      name: 'empty queue',
      result: { outcome: 'applied' as const, data: { kind: 'chat-queue' as const, messages: [] } },
      line: null,
    },
    {
      name: 'one message',
      result: {
        outcome: 'applied' as const,
        data: { kind: 'chat-queue' as const, messages: [message] },
      },
      line: 'Stopped. 1 queued message is waiting.',
    },
    {
      name: 'three messages',
      result: {
        outcome: 'applied' as const,
        data: { kind: 'chat-queue' as const, messages: [message, message, message] },
      },
      line: 'Stopped. 3 queued messages are waiting.',
    },
  ];
  for (const row of rows) assert.equal(waitingQueueLine(row.result), row.line, row.name);
});

// Claim: release-check sends nothing until the person adds --confirm and one quoted note within
// its bound, and then the controller releases the thread. The check here journaled its start and never recorded a group.
test('release-check refuses without confirm and note, and releases with both', {
  timeout: 60_000,
}, async (t) => {
  // Only git on PATH, so nothing the controller runs can find gh or a provider client.
  const tools = mkdtempSync(join(tmpdir(), 'crewkite-path-'));
  const saved = process.env.PATH;
  process.env.PATH = installedTools(tools, 'git');
  t.after(() => {
    process.env.PATH = saved;
    rmSync(tools, { recursive: true, force: true });
  });
  const { home, repository, controller } = await startScriptedController(t, []);
  const added = capture();
  assert.equal(
    await runCli(['project', 'add', repository, '--json', '--home', home], added.output),
    0,
  );
  const client = await connectChat(home);
  const taskId = (await client.createThread(JSON.parse(added.io.out).result.entity.id, 'Hold')).id;
  client.transport.close();
  const id = (prefix: string) => `${prefix}_${'0'.repeat(25)}1`;
  const definition = { id: id('art'), hash: 'a'.repeat(64), bytes: 0, mediaType: 'text/plain' };
  const now = () => new Date(0).toISOString();
  const journal = new OperationStore(controller.store, now);
  journal.createAndBegin(
    { id: id('cmd'), taskId, kind: 'project-command', definition },
    `cmd_${'0'.repeat(25)}2`,
    'b'.repeat(64),
    () => {},
    () => controller.store.put('artifact', definition.id, 0, definition),
  );
  journal.phase(id('cmd'), 'command', 'intent', null);
  journal.finish(
    id('cmd'),
    { state: 'unknown', reason: 'operation-ownership-unknown', next: null },
    { outcome: 'blocked', reason: 'operation-ownership-unknown' },
  );
  const refusal = `This releases a thread held by a check CrewKite cannot confirm ended. If its process still runs, it can change files in the thread's copy. Add --confirm and --note "<what you checked>" to release it.\n`;
  // An unquoted note and one over the bound refuse before anything is sent too.
  for (const [args, line] of [
    [['--confirm'], refusal],
    [['--note', 'Nothing was running.'], refusal],
    [['--confirm', '--note', 'Nothing', 'running.'], 'Quote a message that has spaces.\n'],
    [['--confirm', '--note', 'x'.repeat(301)], 'A note is at most 300 bytes.\n'],
  ] as const) {
    const run = capture();
    const code = await runCli(
      ['thread', 'release-check', taskId, ...args, '--home', home],
      run.output,
    );
    assert.equal(code, 2, args.join(' '));
    assert.equal(run.io.err, line, args.join(' '));
  }
  assert.equal(journal.get(id('cmd'))?.state, 'unknown');
  const released = capture();
  assert.equal(
    await runCli(
      [
        'thread',
        'release-check',
        taskId,
        '--confirm',
        '--note',
        'Nothing was running.',
        '--home',
        home,
      ],
      released.output,
    ),
    0,
    released.io.err,
  );
  assert.equal(released.io.out, "Released. CrewKite never confirmed the check's process ended.\n");
  assert.equal(journal.get(id('cmd'))?.state, 'failed');
});
