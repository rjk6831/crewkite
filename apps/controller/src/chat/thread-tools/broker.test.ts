import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { THREAD_TOOLS, type ThreadToolName, ThreadToolsBroker } from './broker.ts';
import { fixtureReader, fixtureSecrets, fixtureThread, fixtureTurn } from './fixture.ts';

type Exchange = { hello: unknown; replies: unknown[]; closed: boolean };

// Opens one connection, sends the hello and each call, and collects every line until the broker
// has answered them all or closed the socket.
function exchange(path: string, hello: object, calls: object[] = []): Promise<Exchange> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const seen: unknown[] = [];
    let pending = '';
    const done = (closed: boolean) => {
      socket.destroy();
      resolve({ hello: seen[0], replies: seen.slice(1), closed });
    };
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
        seen.push(JSON.parse(pending.slice(0, end)));
        pending = pending.slice(end + 1);
      }
      if (seen.length === calls.length + 1) done(false);
    });
    socket.on('close', () => done(true));
    socket.on('error', () => done(true));
    socket.write(`${JSON.stringify(hello)}\n`);
    for (const call of calls) socket.write(`${JSON.stringify(call)}\n`);
  });
}

test('a turn token opens one connection to one thread, and every read comes back bounded and redacted', async (t) => {
  // A controller home 120 characters deep, where a socket inside the home passes the 104 and
  // 108 byte Unix socket path limits, still gets thread tools.
  const root = mkdtempSync(join(tmpdir(), 'crewkite-thread-tools-'));
  const home = join(root, 'h'.repeat(119 - root.length));
  mkdirSync(home);
  assert.equal(home.length, 120);
  let counter = 0;
  const broker = new ThreadToolsBroker({
    home,
    random: (size) => Buffer.alloc(size, ++counter),
  });
  // A controller that crashed left its socket file behind. The next start removes it and binds.
  mkdirSync(dirname(broker.socketPath), { recursive: true, mode: 0o700 });
  const crashed = spawnSync(process.execPath, [
    '-e',
    "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
    broker.socketPath,
  ]);
  assert.equal(crashed.signal, 'SIGKILL');
  assert(lstatSync(broker.socketPath).isSocket());
  await broker.start();
  assert.equal(lstatSync(broker.socketPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(dirname(broker.socketPath)).mode & 0o777, 0o700);
  t.after(async () => {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert(Buffer.byteLength(broker.socketPath) <= 100, broker.socketPath);
  const token = (server: { args: readonly string[] }) =>
    server.args[server.args.indexOf('--token') + 1];
  const reader = fixtureReader();
  const minted = broker.mint({ taskId: fixtureThread, turnId: fixtureTurn, reader });
  const other = broker.mint({
    taskId: fixtureThread,
    turnId: 'trn_01M51M322B2AEBXD9MA74CBCFN',
    reader,
  });
  assert.notEqual(token(minted), token(other));
  assert.deepEqual(minted.args.slice(1), [
    '--thread',
    fixtureThread,
    '--token',
    token(minted),
    '--socket',
    broker.socketPath,
  ]);

  const calls = [
    { id: 1, tool: 'thread_turns', args: {} },
    { id: 2, tool: 'thread_turn', args: { id: fixtureTurn } },
    { id: 3, tool: 'thread_diff', args: {} },
    { id: 4, tool: 'thread_checks', args: {} },
    { id: 5, tool: 'thread_live', args: {} },
  ];
  const open = await exchange(
    broker.socketPath,
    { thread: fixtureThread, token: token(minted) },
    calls,
  );
  assert.deepEqual(open.hello, { ok: true });
  for (const [index, reply] of open.replies.entries()) {
    const { id, tool } = calls[index];
    const value = reply as { id: number; result: unknown };
    assert.equal(value.id, id);
    assert(THREAD_TOOLS[tool as ThreadToolName].result.safeParse(value.result).success, tool);
    const text = JSON.stringify(value.result);
    for (const secret of fixtureSecrets) assert(!text.includes(secret), `${tool} leaked ${secret}`);
    assert(text.includes('[redacted]'), tool);
  }

  const huge = fixtureReader({
    turns: () => ({ turns: [], extra: 'x'.repeat(10) }) as never,
    checks: () => ({ lines: Array.from({ length: 65 }, () => 'line') }),
  });
  const bounded = broker.mint({
    taskId: fixtureThread,
    turnId: 'trn_01M51M322B2AEBXD9MA74CBCFP',
    reader: huge,
  });
  const rows: Array<{
    claim: string;
    hello: object;
    calls?: object[];
    expect: unknown[];
    ok: boolean;
  }> = [
    {
      claim: 'a second connection on a used token is refused',
      hello: { thread: fixtureThread, token: token(minted) },
      expect: [],
      ok: false,
    },
    {
      claim: 'an unknown token is refused',
      hello: { thread: fixtureThread, token: 'f'.repeat(64) },
      expect: [],
      ok: false,
    },
    {
      claim: 'a token presented for another thread is refused',
      hello: { thread: 'tsk_01M51M322B2AEBXD9MA74CBCFQ', token: token(other) },
      expect: [],
      ok: false,
    },
    {
      claim: 'a limit past fifty and a malformed turn id are refused before the reader runs',
      hello: { thread: fixtureThread, token: token(bounded) },
      calls: [
        { id: 1, tool: 'thread_turns', args: { limit: 51 } },
        { id: 2, tool: 'thread_turn', args: { id: '../trn' } },
        { id: 3, tool: 'thread_checks', args: {} },
        { id: 4, tool: 'thread_turns', args: {} },
      ],
      expect: [
        { id: 1, error: 'The arguments do not match thread_turns.' },
        { id: 2, error: 'The arguments do not match thread_turn.' },
        { id: 3, error: 'The thread read went past its bounds.' },
        { id: 4, error: 'The thread read went past its bounds.' },
      ],
      ok: true,
    },
  ];
  for (const row of rows) {
    const seen = await exchange(broker.socketPath, row.hello, row.calls);
    assert.deepEqual(seen.hello, { ok: row.ok }, row.claim);
    assert.deepEqual(seen.replies, row.expect, row.claim);
  }

  // The turn ends: its token stops working even though it never connected.
  broker.end('trn_01M51M322B2AEBXD9MA74CBCFN');
  const ended = await exchange(broker.socketPath, { thread: fixtureThread, token: token(other) });
  assert.deepEqual(ended.hello, { ok: false });

  // The controller exits: its socket file goes with it.
  await broker.close();
  assert(!existsSync(broker.socketPath));
});
