import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type Event,
  MAX_FRAME_BYTES,
  type Snapshot,
  type TransportMessage,
} from '@crewkite/contracts';
import { encodeFrame, FrameDecoder, ProtocolError } from './index.ts';
import { connectController } from './node.ts';

const token = 'a'.repeat(64);
const actor = { id: 'terminal', kind: 'cli' as const };
const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const task = {
  id: `tsk_${suffix}`,
  projectId: `prj_${suffix}`,
  title: 'Inspect the retained edit',
  outcome: 'Retain the edit',
  criteria: ['The edit can be inspected'],
  state: 'draft' as const,
  waitingReason: null,
  revision: 3,
  runId: null,
  next: 'Prepare the run.',
};
const snapshot: Snapshot = {
  protocol: 1,
  cursor: '4',
  projects: [],
  tasks: [task],
  runs: [],
  attempts: [],
  routes: [],
  artifacts: [],
  evidence: [],
  approvals: [],
  usage: [],
  candidates: [],
};

function rawFrame(value: unknown): Uint8Array {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(data.length + 4);
  new DataView(frame.buffer).setUint32(0, data.length, false);
  frame.set(data, 4);
  return frame;
}

async function serve(
  handler: (message: TransportMessage, socket: Socket, connection: number) => void,
) {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  const directory = resolve(common, '..', 'internal');
  mkdirSync(directory, { recursive: true });
  const home = mkdtempSync(join(directory, 'client-'));
  writeFileSync(join(home, 'token'), token, { mode: 0o600 });
  const socketPath = join(home, 'control.sock');
  const sockets = new Set<Socket>();
  let connection = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    const number = ++connection;
    const decoder = new FrameDecoder();
    socket.on('error', () => {});
    socket.on('data', (bytes) => {
      for (const message of decoder.push(bytes)) handler(message, socket, number);
    });
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    server.listen(socketPath);
    await once(server, 'listening');
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return {
    home,
    socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('framing preserves fragmented messages and rejects oversized or incomplete input', () => {
  const message: TransportMessage = { type: 'welcome', protocol: 1, cursor: '7' };
  const frame = encodeFrame(message);
  for (let split = 0; split <= frame.length; split++) {
    const decoder = new FrameDecoder();
    const messages = [
      ...decoder.push(frame.subarray(0, split)),
      ...decoder.push(frame.subarray(split)),
    ];
    decoder.finish();
    assert.deepEqual(messages, [message]);
  }
  const together = new Uint8Array(frame.length * 2);
  together.set(frame);
  together.set(frame, frame.length);
  assert.deepEqual(new FrameDecoder().push(together), [message, message]);
  for (const length of [0, MAX_FRAME_BYTES + 1, 0xffffffff]) {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, length, false);
    assert.throws(() => new FrameDecoder().push(header), ProtocolError);
  }
  for (const bytes of [frame.subarray(0, 3), frame.subarray(0, frame.length - 1)]) {
    const decoder = new FrameDecoder();
    decoder.push(bytes);
    assert.throws(() => decoder.finish(), ProtocolError);
  }
  assert.throws(
    () => new FrameDecoder().push(rawFrame({ type: 'welcome', protocol: 1, cursor: '01' })),
    ProtocolError,
  );
});

test('protocol mismatches reject the handshake without exposing authentication data', async (context) => {
  const wrong = { type: 'hello', protocol: 2, token, actor };
  assert.throws(
    () => new FrameDecoder().push(rawFrame(wrong)),
    (error) =>
      error instanceof ProtocolError &&
      error.reason === 'protocol-mismatch' &&
      !error.message.includes(token),
  );
  const fixture = await serve((_message, socket) =>
    socket.end(encodeFrame({ type: 'error', reason: 'protocol-mismatch', next: token })),
  );
  context.after(() => fixture.close());
  await assert.rejects(
    connectController({ ...fixture, token, actor, reconnectDelaysMs: [] }),
    (error) =>
      error instanceof Error &&
      error.message.includes('protocol-mismatch') &&
      !error.message.includes(token),
  );
});

test('task show JSON preserves the snapshot task and cursor', async (context) => {
  const fixture = await serve((message, socket) => {
    if (message.type === 'hello')
      socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: snapshot.cursor }));
    if (message.type === 'command' && message.command.command === 'GetSnapshot')
      socket.write(
        encodeFrame({
          type: 'result',
          key: message.command.key,
          result: { outcome: 'applied', data: { kind: 'snapshot', snapshot } },
        }),
      );
  });
  context.after(() => fixture.close());
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../../apps/cli/src/main.ts', import.meta.url)),
      'task',
      'show',
      task.id,
      '--json',
      '--home',
      fixture.home,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    errors += data;
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, errors);
  assert.deepEqual(JSON.parse(output), { cursor: snapshot.cursor, task });
  assert.equal(errors, '');
});

test('reconnection replays retained events and snapshots only after a history gap', async (context) => {
  const delivered: string[] = [];
  const subscriptions: string[] = [];
  let snapshots = 0;
  let firstSocket: Socket | undefined;
  let secondSocket: Socket | undefined;
  let reachedFirst!: () => void;
  let reachedSecond!: () => void;
  let reachedFinal!: () => void;
  const first = new Promise<void>((done) => {
    reachedFirst = done;
  });
  const second = new Promise<void>((done) => {
    reachedSecond = done;
  });
  const final = new Promise<void>((done) => {
    reachedFinal = done;
  });
  const event = (cursor: string): Event => ({
    protocol: 1,
    id: `evt_${suffix}`,
    cursor,
    at: '2026-10-15T17:00:00.000Z',
    taskId: task.id,
    revision: Number(cursor),
    type: 'task.updated',
    payload: { ...task, revision: Number(cursor) },
  });
  const fixture = await serve((message, socket, connection) => {
    if (message.type === 'hello') {
      if (connection === 1) firstSocket = socket;
      else secondSocket = socket;
      socket.write(encodeFrame({ type: 'welcome', protocol: 1, cursor: '9' }));
    }
    if (message.type !== 'command') return;
    const command = message.command;
    if (command.command === 'Subscribe') {
      subscriptions.push(command.payload.after);
      if (command.payload.after === '2') {
        socket.write(encodeFrame({ type: 'resync', reason: 'history-gap', cursor: '9' }));
      }
      socket.write(
        encodeFrame({ type: 'result', key: command.key, result: { outcome: 'applied' } }),
      );
      for (const cursor of connection === 1
        ? ['1']
        : command.payload.after === '1'
          ? ['1', '2']
          : command.payload.after === '9'
            ? ['10']
            : [])
        socket.write(encodeFrame({ type: 'event', event: event(cursor) }));
    }
    if (command.command === 'GetSnapshot') {
      snapshots++;
      socket.write(
        encodeFrame({
          type: 'result',
          key: command.key,
          result: {
            outcome: 'applied',
            data: { kind: 'snapshot', snapshot: { ...snapshot, cursor: '9' } },
          },
        }),
      );
    }
  });
  context.after(() => fixture.close());
  let key = 0;
  const client = await connectController({
    ...fixture,
    token,
    actor,
    reconnectDelaysMs: [0],
    nextKey: () => `cmd_${String(++key).padStart(26, '0')}`,
  });
  context.after(() => client.close());
  const resynced: string[] = [];
  await client.subscribe(
    '0',
    (value) => {
      delivered.push(value.cursor);
      if (value.cursor === '1') reachedFirst();
      if (value.cursor === '2') reachedSecond();
      if (value.cursor === '10') reachedFinal();
    },
    (value) => resynced.push(value.cursor),
  );
  await first;
  assert.ok(firstSocket);
  firstSocket.destroy();
  await second;
  assert.equal(snapshots, 0);
  assert.ok(secondSocket);
  secondSocket.destroy();
  await final;
  assert.deepEqual(delivered, ['1', '2', '10']);
  assert.deepEqual(subscriptions, ['0', '1', '2', '9']);
  assert.deepEqual(resynced, ['9']);
  assert.equal(snapshots, 1);
});
