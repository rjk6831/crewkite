import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeFrame, FrameDecoder } from '@crewkite/client';
import type { CommandResult, TaskPage, WorkspaceState } from '@crewkite/contracts';
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
