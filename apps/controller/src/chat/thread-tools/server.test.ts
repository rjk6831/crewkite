import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { THREAD_TOOLS, type ThreadToolName, ThreadToolsBroker } from './broker.ts';
import { fixtureReader, fixtureSecrets, fixtureThread, fixtureTurn } from './fixture.ts';

test('a client child lists and calls the five thread tools over stdio and gets schema-valid results', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'crewkite-thread-server-'));
  const broker = new ThreadToolsBroker({ home });
  await broker.start();
  t.after(async () => {
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  });
  const server = broker.mint({
    taskId: fixtureThread,
    turnId: fixtureTurn,
    reader: fixtureReader(),
  });
  const child = spawn(server.command, [...server.args], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const replies = new Map<number, (value: { result?: unknown; error?: unknown }) => void>();
  let pending = '';
  child.stdout.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
      const value = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      replies.get(value.id)?.(value);
    }
  });
  let next = 0;
  const request = (method: string, params?: object) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const id = ++next;
      replies.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fixture', version: '1' },
  });
  assert.deepEqual(init.result, {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'crewkite', version: '0.1.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = (await request('tools/list')).result as {
    tools: Array<{ name: string; description: string; inputSchema: { type: string } }>;
  };
  assert.deepEqual(
    list.tools.map((tool) => tool.name),
    ['thread_turns', 'thread_turn', 'thread_diff', 'thread_checks', 'thread_live'],
  );
  for (const tool of list.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    // One plain sentence each.
    assert.match(tool.description, /^[A-Z][^.]*\.$/);
  }

  const calls: Array<[ThreadToolName, object]> = [
    ['thread_turns', { limit: 5 }],
    ['thread_turn', { id: fixtureTurn }],
    ['thread_diff', {}],
    ['thread_checks', {}],
    ['thread_live', {}],
  ];
  for (const [name, args] of calls) {
    const reply = (await request('tools/call', { name, arguments: args })).result as {
      content: Array<{ type: 'text'; text: string }>;
      isError: boolean;
    };
    assert.equal(reply.isError, false, name);
    const text = reply.content[0].text;
    assert(THREAD_TOOLS[name].result.safeParse(JSON.parse(text)).success, name);
    for (const secret of fixtureSecrets) assert(!text.includes(secret), `${name} leaked`);
  }
  const unknown = await request('tools/call', { name: 'write_file', arguments: {} });
  assert.deepEqual(unknown.error, { code: -32602, message: 'Unknown tool.' });

  child.stdin.end();
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 0);
});
