import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve as absolute, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  TaskIdSchema,
  ThreadChecksResultSchema,
  ThreadDiffArgsSchema,
  ThreadDiffResultSchema,
  ThreadLiveResultSchema,
  ThreadTurnArgsSchema,
  ThreadTurnResultSchema,
  ThreadTurnsArgsSchema,
  ThreadTurnsResultSchema,
} from '@crewkite/contracts';
import { z } from 'zod';
import type { ThreadReads } from '../thread-reader.ts';

// The controller side of the thread tools. A cloud client starts server.ts as its MCP server for
// one turn, and that process connects here with the token minted for the turn. The token opens
// one connection to one thread's reader and ends with the turn. Every result passes the contract
// schema and the secret patterns before it leaves this process.

/** The MCP server a client launches for one turn. Clients name its tools `<name>__<tool>`. */
export type ThreadToolsServer = Readonly<{
  name: typeof THREAD_TOOLS_SERVER;
  command: string;
  args: readonly string[];
}>;

export const THREAD_TOOLS_SERVER = 'crewkite';
const none = z.strictObject({});
export const THREAD_TOOLS = {
  thread_turns: {
    description: 'List the turns of this thread with the start of each reply.',
    args: ThreadTurnsArgsSchema,
    result: ThreadTurnsResultSchema,
  },
  thread_turn: {
    description: 'Read one turn of this thread with its reply, actions and changed files.',
    args: ThreadTurnArgsSchema,
    result: ThreadTurnResultSchema,
  },
  thread_diff: {
    description: 'Read the changes of this thread as a unified diff, one page per call.',
    args: ThreadDiffArgsSchema,
    result: ThreadDiffResultSchema,
  },
  thread_checks: {
    description: 'Read the latest check results of this thread.',
    args: none,
    result: ThreadChecksResultSchema,
  },
  thread_live: {
    description: 'Read the turn running in this thread now, or none.',
    args: none,
    result: ThreadLiveResultSchema,
  },
} as const;
export type ThreadToolName = keyof typeof THREAD_TOOLS;
const toolNames = Object.keys(THREAD_TOOLS) as [ThreadToolName, ...ThreadToolName[]];

// A 200 entry trace at its field limits, JSON escaped, stays under this.
export const BROKER_LINE_BYTES = 1024 * 1024;
export const HelloSchema = z.strictObject({
  thread: TaskIdSchema,
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export const CallSchema = z.strictObject({
  id: z.number().int().nonnegative().max(1_000_000),
  tool: z.enum(toolNames),
  args: z.unknown(),
});
export type BrokerReply = { result: unknown } | { error: string };

const SECRETS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\bBearer\s+[^\s"'`]+/g, '[redacted]'],
  // Upper case only, so `const key = ...` in a diff survives while `API_KEY=...` does not.
  [
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/g,
    '$1$2[redacted]',
  ],
];

/**
 * Replaces secret shapes in every string of a result. A replacement can be longer than what it
 * replaced, so each changed string is cut back to the length and bytes of the original, which
 * already passed its schema bound.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    let next = value;
    for (const [pattern, replacement] of SECRETS) next = next.replace(pattern, replacement);
    if (next === value) return value;
    const limit = Buffer.byteLength(value);
    let units = 0;
    let bytes = 0;
    for (const character of next) {
      const size = Buffer.byteLength(character);
      if (units + character.length > value.length || bytes + size > limit) break;
      units += character.length;
      bytes += size;
    }
    return next.slice(0, units);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}

/** Splits a stream into newline-terminated lines and gives up on one longer than the bound. */
export function lines(socket: Readable, onLine: (line: string) => void) {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (let end = pending.indexOf(10); end !== -1; end = pending.indexOf(10)) {
      const line = pending.subarray(0, end).toString('utf8');
      pending = pending.subarray(end + 1);
      onLine(line);
    }
    if (pending.length > BROKER_LINE_BYTES) socket.destroy();
  });
}

async function read(reader: ThreadReads, tool: ThreadToolName, args: unknown) {
  switch (tool) {
    case 'thread_turns':
      return reader.turns(args as z.output<typeof ThreadTurnsArgsSchema>);
    case 'thread_turn':
      return reader.turn(args as z.output<typeof ThreadTurnArgsSchema>);
    case 'thread_diff':
      return reader.diff(args as z.output<typeof ThreadDiffArgsSchema>);
    case 'thread_checks':
      return reader.checks();
    case 'thread_live':
      return reader.live();
  }
}

/** Runs one call. Errors name the failed step and never quote what the reader returned. */
export async function answer(
  reader: ThreadReads,
  tool: ThreadToolName,
  raw: unknown,
): Promise<BrokerReply> {
  const spec = THREAD_TOOLS[tool];
  const args = spec.args.safeParse(raw ?? {});
  if (!args.success) return { error: `The arguments do not match ${tool}.` };
  let value: unknown;
  try {
    value = await read(reader, tool, args.data);
  } catch {
    return { error: 'The thread could not be read.' };
  }
  if (!spec.result.safeParse(value).success)
    return { error: 'The thread read went past its bounds.' };
  const clean = spec.result.safeParse(redact(value));
  if (!clean.success) return { error: 'The thread read went past its bounds.' };
  return { result: clean.data };
}

// A Unix socket path holds 104 bytes on macOS and 108 on Linux. Staying within 100 leaves room.
const SOCKET_PATH_BYTES = 100;

/**
 * One short socket per controller home: a name from a hash of the home, in this user's own
 * directory under the temporary directory, so a deep home still binds. macOS gives a long
 * temporary directory, so a path that would still not fit goes under /tmp.
 */
export function threadToolsSocket(home: string, temporary = tmpdir()): string {
  const name = `${createHash('sha256').update(absolute(home)).digest('hex').slice(0, 12)}.sock`;
  const directory = `crewkite-${process.getuid?.() ?? 'user'}`;
  const path = join(temporary, directory, name);
  return Buffer.byteLength(path) <= SOCKET_PATH_BYTES ? path : join('/tmp', directory, name);
}

/** Create the socket's directory as this user's alone, or refuse one somebody else holds. */
function ownDirectory(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const state = lstatSync(path);
  if (!state.isDirectory() || state.uid !== process.getuid?.())
    throw new Error('The thread tools socket directory is occupied.');
  chmodSync(path, 0o700);
}

type Grant = { taskId: string; turnId: string; reader: ThreadReads; socket: Socket | null };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export class ThreadToolsBroker {
  readonly socketPath: string;
  private readonly random: (size: number) => Buffer;
  private readonly entry = fileURLToPath(new URL('./server.ts', import.meta.url));
  // Keyed by the token's digest, so a lookup's timing says nothing about the token itself.
  private readonly grants = new Map<string, Grant>();
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((socket) => this.accept(socket));
  private listening = false;

  constructor(options: { home: string; random?: (size: number) => Buffer }) {
    this.socketPath = threadToolsSocket(options.home);
    this.random = options.random ?? randomBytes;
  }

  async start(): Promise<void> {
    ownDirectory(dirname(this.socketPath));
    try {
      const state = lstatSync(this.socketPath);
      if (!state.isSocket() || state.uid !== process.getuid?.())
        throw new Error('The thread tools socket path is occupied.');
      unlinkSync(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.listening = true;
    chmodSync(this.socketPath, 0o600);
  }

  /** A fresh token for one turn of one thread, and the server line a client launches with it. */
  mint(turn: { taskId: string; turnId: string; reader: ThreadReads }): ThreadToolsServer {
    const thread = TaskIdSchema.parse(turn.taskId);
    const token = this.random(32).toString('hex');
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('The token source gave too few bytes.');
    this.grants.set(digest(token), { ...turn, taskId: thread, socket: null });
    return {
      name: THREAD_TOOLS_SERVER,
      command: process.execPath,
      args: [this.entry, '--thread', thread, '--token', token, '--socket', this.socketPath],
    };
  }

  /** The turn is over. Its token stops working and an open connection closes. */
  end(turnId: string): void {
    for (const [key, grant] of this.grants)
      if (grant.turnId === turnId) {
        this.grants.delete(key);
        grant.socket?.destroy();
      }
  }

  async close(): Promise<void> {
    this.grants.clear();
    for (const socket of this.sockets) socket.destroy();
    if (!this.listening) return;
    this.listening = false;
    // Closing the server removes the socket file at once. A second unlink after the callback
    // could remove the socket of a broker started since on the same home.
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private accept(socket: Socket) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const send = (value: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
    };
    let grant: Grant | null = null;
    let chain = Promise.resolve();
    lines(socket, (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (!grant) {
        const hello = HelloSchema.safeParse(value);
        const found = hello.success ? this.grants.get(digest(hello.data.token)) : undefined;
        // One connection per token: a grant that already holds a socket refuses the next.
        if (!found || found.socket || found.taskId !== hello.data?.thread) {
          send({ ok: false });
          socket.end();
          socket.destroy();
          return;
        }
        found.socket = socket;
        grant = found;
        send({ ok: true });
        return;
      }
      const call = CallSchema.safeParse(value);
      if (!call.success) {
        socket.destroy();
        return;
      }
      const reader = grant.reader;
      chain = chain.then(async () => {
        send({ id: call.data.id, ...(await answer(reader, call.data.tool, call.data.args)) });
      });
    });
  }
}
