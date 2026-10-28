import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChatPermissionPolicy, McpSupply } from '@crewkite/contracts';
import {
  anthropicMcpEntries,
  googleMcpEntries,
  type McpPolicy,
  McpRegistry,
  mcpToolAnswer,
} from './mcp-servers.ts';

const task = 'tsk_00000000000000000000000001';
const other = 'tsk_00000000000000000000000002';
const fixture = fileURLToPath(new URL('./mcp-fixture-server.mjs', import.meta.url));

const registry = (policy: McpPolicy) => {
  const value = new McpRegistry();
  const supply: McpSupply = {
    servers: [
      {
        name: 'notes',
        command: process.execPath,
        args: [fixture, '--root'],
        secretArgs: ['arg-secret-1'],
        env: { SCRIPTED_KEY: 'env-secret-1' },
        readTools: ['read_file', 'read_remote', 'list_*'],
      },
    ],
    threads: { [task]: { notes: policy } },
  };
  value.set(supply);
  return value;
};

/** The tools a scripted server lists, with the annotations it claims. */
async function listTools() {
  const child = spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines: string[] = [];
  child.stdout.on('data', (chunk: Buffer) =>
    lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)),
  );
  const call = async (id: number, method: string) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method })}\n`);
    while (!lines.some((line) => JSON.parse(line).id === id)) await once(child.stdout, 'data');
    return JSON.parse(lines.find((line) => JSON.parse(line).id === id) ?? '{}').result;
  };
  try {
    await call(1, 'initialize');
    return (await call(2, 'tools/list')).tools as {
      name: string;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }[];
  } finally {
    child.kill();
  }
}

test('a server policy never exceeds the thread policy, and only the person listed reads run unasked', async () => {
  const tools = await listTools();
  assert.equal(tools.length, 5);
  const answers = (thread: ChatPermissionPolicy, server: McpPolicy) => {
    const mcp = registry(server).compose({
      family: 'anthropic',
      taskId: task,
      permissionPolicy: thread,
    });
    return Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        mcpToolAnswer(mcp, `mcp__notes__${tool.name}`, tool.annotations),
      ]),
    );
  };
  const asks = Object.fromEntries(tools.map((tool) => [tool.name, 'ask']));
  const reads = { ...asks, read_file: 'allow', list_dir: 'allow' };
  // read_secret claims to only read and the person never listed it. read_remote is listed and the
  // server claims it writes. write_file claims to write. A claim can only turn an allow into an ask.
  assert.deepEqual(answers('allow-all', 'reads'), reads);
  assert.deepEqual(answers('allow-all', 'ask'), asks);
  assert.equal(answers('allow-all', 'all').write_file, 'allow');
  // Allow edits leaves reads at most, and ask leaves nothing.
  assert.deepEqual(answers('allow-edits', 'all'), reads);
  assert.deepEqual(answers('ask', 'all'), asks);
  assert.deepEqual(answers('ask', 'reads'), asks);
  // A server this turn did not start asks, the thread tools and built in tools are not its call.
  const mcp = registry('all').compose({
    family: 'anthropic',
    taskId: task,
    permissionPolicy: 'allow-all',
  });
  assert.equal(mcpToolAnswer(mcp, 'mcp__elsewhere__read_file'), 'ask');
  assert.equal(mcpToolAnswer(mcp, 'mcp__crewkite__thread_turns'), null);
  assert.equal(mcpToolAnswer(mcp, 'Bash'), null);
});

test('each family gets the servers the thread turned on only where the controller gate sees their calls', () => {
  const turn = (family: 'anthropic' | 'google' | 'openai' | 'local', extra = {}) =>
    registry('all').compose({ family, taskId: task, permissionPolicy: 'ask', ...extra });
  const joined = turn('anthropic');
  assert.deepEqual(anthropicMcpEntries(joined).notes, {
    type: 'stdio',
    command: process.execPath,
    args: [fixture, '--root', 'arg-secret-1'],
    env: { SCRIPTED_KEY: 'env-secret-1' },
  });
  assert.deepEqual([...joined.secrets].sort(), ['arg-secret-1', 'env-secret-1']);
  // Google joins only while every call asks, and then the server policy is ask whatever it says.
  assert.deepEqual(googleMcpEntries(turn('google')), [
    {
      name: 'notes',
      command: process.execPath,
      args: [fixture, '--root', 'arg-secret-1'],
      env: [{ name: 'SCRIPTED_KEY', value: 'env-secret-1' }],
    },
  ]);
  assert.equal(turn('google').servers[0]?.policy, 'ask');
  const off = [
    turn('google', { permissionPolicy: 'allow-edits' }),
    turn('google', { permissionGrants: ['read'] }),
    turn('anthropic', { readOnly: true }),
    turn('openai'),
    turn('local'),
  ];
  for (const value of off) {
    assert.deepEqual(value.servers, []);
    assert.deepEqual(value.secrets, []);
    assert.equal(value.notes.length, 1);
    assert.ok(!value.notes[0]?.includes('secret'));
  }
  // A thread that turned nothing on gets nothing and no note, and the next thread is unaffected.
  const unused = registry('all').compose({
    family: 'anthropic',
    taskId: other,
    permissionPolicy: 'ask',
  });
  assert.deepEqual(unused, { servers: [], notes: [], secrets: [] });
});
