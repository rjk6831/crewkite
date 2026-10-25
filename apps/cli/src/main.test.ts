import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeFrame, FrameDecoder } from '@crewkite/client';
import {
  type Command,
  type CommandResult,
  CommandResultSchema,
  type TaskPage,
  type WorkspaceState,
} from '@crewkite/contracts';
import { runCli } from './main.ts';

test('CLI lists traverse empty pages and preserve incomplete output', async (context) => {
  const home = mkdtempSync('/tmp/crewkite-cli-');
  writeFileSync(join(home, 'token'), 'a'.repeat(64), { mode: 0o600 });
  const stamp = { epoch: 'a'.repeat(32), revision: '1' };
  const header: WorkspaceState = {
    kind: 'workspace-state',
    version: 1,
    protocol: 1,
    cursor: '4',
    stamp,
    routes: [],
    usage: [],
    usageReaders: [],
    nativeProfiles: [],
    googleAcpSetup: null,
    googleAcpInstall: null,
    nativeConnections: [],
  };
  const task = {
    id: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    title: 'Inspect café',
    state: 'draft' as const,
    waitingReason: null,
    revision: 0,
    runId: null,
    next: null,
    chatActivity: 'idle' as const,
  };
  const next = {
    version: 1 as const,
    stamp,
    section: 'tasks' as const,
    selectionHash: 'b'.repeat(64),
    afterId: task.id,
  };
  let fail = false;
  let pageIndex = 0;
  const commands: string[] = [];
  const usageRequests: Command[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const decoder = new FrameDecoder();
    socket.on('data', (bytes) => {
      for (const message of decoder.push(bytes)) {
        if (message.type === 'hello') {
          socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: '4' }));
          continue;
        }
        if (message.type !== 'command') continue;
        const command = message.command;
        commands.push(command.command);
        let result: CommandResult;
        if (command.command === 'GetWorkspaceState') {
          pageIndex = 0;
          result = { outcome: 'applied', data: header };
        } else if (command.command === 'GetTaskPage') {
          assert.deepEqual(command.payload.stamp, stamp);
          if (pageIndex > 0) assert.deepEqual(command.payload.after, next);
          if (fail && pageIndex === 1)
            result = {
              outcome: 'blocked',
              reason: 'workspace-page-stale',
              next: 'Refresh the list.',
            };
          else {
            const page: TaskPage = {
              kind: 'task-page',
              version: 1,
              cursor: '4',
              stamp,
              tasks: pageIndex === 0 && !fail ? [] : [task],
              scanned: 1,
              next: pageIndex === 0 ? next : null,
              complete: pageIndex !== 0,
            };
            result = { outcome: 'applied', data: page };
          }
          pageIndex++;
        } else if (
          command.command === 'RefreshAnthropicUsage' ||
          command.command === 'StopAnthropicUsage'
        ) {
          usageRequests.push(command);
          result = { outcome: 'applied' };
        } else throw new Error(`Unexpected read ${command.command}`);
        socket.write(encodeFrame({ type: 'result', key: command.key, result }));
      }
    });
  });
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(home, { recursive: true, force: true });
  });
  server.listen(join(home, 'control.sock'));
  await once(server, 'listening');
  const execute = async (args: string[]) => {
    let out = '',
      err = '';
    commands.length = 0;
    const code = await runCli([...args, '--home', home], {
      out: (value) => {
        out += value;
      },
      err: (value) => {
        err += value;
      },
    });
    return { code, out, err };
  };
  for (const args of [
    ['usage', 'show'],
    ['local', 'status'],
    ['native', 'profiles'],
    ['native', 'setup', 'show', '--family', 'google'],
  ]) {
    assert.equal((await execute(args)).code, 0);
    assert.deepEqual(commands, ['GetWorkspaceState']);
  }
  for (const [args, name, payload] of [
    [
      [
        'usage',
        'refresh',
        '--family',
        'anthropic',
        '--native-trust',
        '--usage-scope',
        'a'.repeat(64),
      ],
      'RefreshAnthropicUsage',
      { trust: { nativeTrust: 'accepted', scopeHash: 'a'.repeat(64) } },
    ],
    [['usage', 'refresh', '--family', 'anthropic'], 'RefreshAnthropicUsage', {}],
    [
      ['usage', 'stop', 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV', '--family', 'anthropic'],
      'StopAnthropicUsage',
      { operationId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    ],
  ] as const) {
    const result = await execute([...args]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(commands, [name]);
    assert.deepEqual(usageRequests.at(-1)?.payload, payload);
  }
  for (const args of [
    ['usage', 'refresh', '--family', 'anthropic', '--native-trust'],
    ['usage', 'refresh', '--family', 'anthropic', '--usage-scope', 'a'.repeat(64)],
    ['usage', 'refresh', '--family', 'openai', '--usage-scope', 'a'.repeat(64)],
    ['usage', 'stop', 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV', '--family', 'google'],
  ]) {
    assert.equal((await execute(args)).code, 1);
    assert.deepEqual(commands, []);
  }
  for (const json of [false, true]) {
    const result = await execute(['task', 'list', ...(json ? ['--pages', '--json'] : [])]);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(commands, ['GetWorkspaceState', 'GetTaskPage', 'GetTaskPage']);
    if (json) {
      const pages = result.out
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        pages.map((page) => [page.tasks.length, page.complete]),
        [
          [0, false],
          [1, true],
        ],
      );
    } else {
      assert.match(result.out, /Inspect café/);
      assert.doesNotMatch(result.out, /No tasks/);
    }
    fail = true;
    const partial = await execute(['task', 'list', ...(json ? ['--pages', '--json'] : [])]);
    assert.equal(partial.code, 1);
    assert.match(partial.out, /Inspect café/);
    assert.match(partial.err, /incomplete after 1 rows.*workspace-page-stale/);
    fail = false;
  }
  assert.equal((await execute(['task', 'show', task.id, '--pages', '--json'])).code, 1);
  assert.deepEqual(commands, []);
});

test('CLI operation actions keep exact review bindings and bounded continuation', async (context) => {
  const home = mkdtempSync('/tmp/crewkite-operations-cli-');
  writeFileSync(join(home, 'token'), 'a'.repeat(64), { mode: 0o600 });
  const taskId = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const operationId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const hash = 'b'.repeat(64);
  const definition = {
    version: 1,
    id: operationId,
    taskId,
    taskRevision: 1,
    source: {
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      base: 'a'.repeat(40),
      branch: 'main',
      dirtyCount: 0,
      untrackedCount: 0,
    },
    sourceMode: 'committed-head',
    repositoryRoot: '/fixture/project',
    scratchRoot: '/fixture/scratch',
    cwd: '/fixture/scratch',
    recipe: 'test',
    executable: '/fixture/node',
    executableSha256: hash,
    executableIdentity: 'verified-prelaunch-sha256',
    argv: ['test.mjs'],
    environment: {},
    deadlineMs: 1000,
    nativeTrust: 'required',
  };
  const operation = {
    id: operationId,
    taskId,
    kind: 'project-command',
    state: 'prepared',
    observedAt: '2026-10-21T00:00:00.000Z',
    reason: null,
    next: null,
    definition: {
      id: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      hash,
      bytes: 17,
      mediaType: 'application/json',
    },
    stdout: null,
    stderr: null,
    result: null,
  };
  const data = {
    kind: 'project-operation',
    operation,
    definition,
    githubRequest: null,
    githubResult: null,
  };
  const commands: import('@crewkite/contracts').Command[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const decoder = new FrameDecoder();
    socket.on('data', (bytes) => {
      for (const message of decoder.push(bytes)) {
        if (message.type === 'hello') {
          socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: '0' }));
          continue;
        }
        if (message.type !== 'command') continue;
        commands.push(message.command);
        const result = CommandResultSchema.parse(
          message.command.command === 'GetTaskOperations'
            ? {
                outcome: 'applied',
                data: {
                  kind: 'task-operations',
                  taskId,
                  operations: [operation],
                  nextBeforeId: operationId,
                },
              }
            : { outcome: 'applied', data },
        );
        socket.write(encodeFrame({ type: 'result', key: message.command.key, result }));
      }
    });
  });
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(home, { recursive: true, force: true });
  });
  server.listen(join(home, 'control.sock'));
  await once(server, 'listening');
  const execute = async (args: string[]) => {
    let out = '',
      err = '';
    commands.length = 0;
    const code = await runCli([...args, '--home', home], {
      out: (value) => {
        out += value;
      },
      err: (value) => {
        err += value;
      },
    });
    return { code, out, err };
  };
  const page = await execute(['task', 'operations', taskId, '--limit', '1']);
  assert.equal(page.code, 0, page.err);
  assert.match(page.out, /More operations: --before-id/);
  assert.deepEqual(
    commands.map((command) => command.command),
    ['GetTaskOperations'],
  );
  assert.equal(Object.hasOwn(commands[0], 'expectedRevision'), false);
  const json = await execute(['task', 'operations', taskId, '--before-id', operationId, '--json']);
  assert.equal(JSON.parse(json.out).nextBeforeId, operationId);
  assert.deepEqual(commands[0].payload, { taskId, beforeId: operationId, limit: 20 });
  const preparePath = join(home, 'definition.json');
  writeFileSync(
    preparePath,
    JSON.stringify({
      taskId,
      recipe: 'test',
      executable: '/fixture/node',
      argv: ['test.mjs'],
      cwdRelative: '.',
      deadlineMs: 1000,
    }),
  );
  assert.equal(
    (await execute(['task', 'command-prepare', taskId, '--definition', preparePath, '--json']))
      .code,
    0,
  );
  assert.equal(commands[0].command, 'PrepareProjectCommand');
  assert.equal('expectedRevision' in commands[0] && commands[0].expectedRevision, 0);
  const before = Date.now();
  const start = await execute([
    'task',
    'command-start',
    taskId,
    operationId,
    '--definition-hash',
    hash,
    '--copy-committed-source',
    '--native-trust',
    '--json',
  ]);
  assert.equal(start.code, 0, start.err);
  assert.deepEqual(
    commands.map((command) => command.command),
    ['GetProjectOperation', 'StartProjectCommand'],
  );
  const sent = commands[1];
  assert(sent.command === 'StartProjectCommand');
  assert.equal(sent.payload.definitionHash, hash);
  assert.equal(sent.payload.grant.target, hash);
  assert.equal(sent.payload.grant.usesRemaining, 1);
  assert.equal(sent.payload.grant.revoked, false);
  assert(Date.parse(sent.payload.grant.expiresAt) >= before + 6000);
  assert(Date.parse(sent.payload.grant.expiresAt) <= Date.now() + 6000);
  const refused = await execute([
    'task',
    'command-start',
    taskId,
    operationId,
    '--definition-hash',
    'c'.repeat(64),
    '--copy-committed-source',
    '--native-trust',
  ]);
  assert.equal(refused.code, 1);
  assert.deepEqual(
    commands.map((command) => command.command),
    ['GetProjectOperation'],
  );
  assert.equal((await execute(['task', 'operation-stop', taskId, operationId, '--json'])).code, 0);
  assert.deepEqual(
    commands.map((command) => command.command),
    ['StopProjectOperation'],
  );
  const requestPath = join(home, 'github.json');
  const request = {
    kind: 'job-log',
    repository: { host: 'github.com', owner: 'fixture', name: 'project' },
    headSha: 'a'.repeat(40),
    runId: '12',
    attempt: 1,
    jobId: '34',
  };
  writeFileSync(requestPath, JSON.stringify(request));
  assert.equal(
    (await execute(['task', 'github', taskId, '--request', requestPath, '--json'])).code,
    0,
  );
  assert.deepEqual(commands[0].payload, { taskId, request });
  writeFileSync(requestPath, ' '.repeat(262145));
  assert.equal((await execute(['task', 'github', taskId, '--request', requestPath])).code, 1);
  assert.equal(commands.length, 0);
});
