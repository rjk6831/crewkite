import { connect } from 'node:net';
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { TaskIdSchema } from '@crewkite/contracts';
import { z } from 'zod';
import {
  type BrokerReply,
  lines,
  THREAD_TOOLS,
  THREAD_TOOLS_SERVER,
  type ThreadToolName,
} from './broker.ts';

// The MCP server a cloud client starts for one turn: newline-delimited JSON-RPC 2.0 on stdio,
// with the five thread reads. It holds no thread data. Each call goes to the controller's broker
// over the socket named on the command line, under the turn's token.
//
//   node server.ts --thread <task id> --token <64 hex> --socket <absolute path>

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const RequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(128), z.number().int().safe()]).optional(),
  method: z.string().min(1).max(128),
  params: z.record(z.string(), z.unknown()).optional(),
});
const CallParamsSchema = z.object({
  name: z.string().max(128),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

/** The tools/list entries. Argument schemas come from the contracts. */
export function toolList() {
  return Object.entries(THREAD_TOOLS).map(([name, tool]) => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.args, { io: 'input' });
    return {
      name,
      description: tool.description,
      inputSchema,
      // Clients that ask before an unmarked tool read these and let the call through.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    };
  });
}

type Broker = { call(tool: ThreadToolName, args: unknown): Promise<BrokerReply> };

/** Connects to the broker and presents the token. Rejects when the broker refuses it. */
export function connectBroker(options: { socket: string; thread: string; token: string }) {
  return new Promise<Broker & { close(): void }>((resolve, reject) => {
    const socket = connect(options.socket);
    const waiting = new Map<number, (reply: BrokerReply) => void>();
    let ready = false;
    let next = 0;
    const fail = () => {
      for (const settle of waiting.values()) settle({ error: 'The thread tools have ended.' });
      waiting.clear();
      if (!ready) reject(new Error('The broker refused this turn.'));
    };
    socket.on('error', () => socket.destroy());
    socket.on('close', fail);
    lines(socket, (line) => {
      const value = JSON.parse(line) as { ok?: boolean; id?: number } & BrokerReply;
      if (!ready) {
        if (value.ok !== true) return socket.destroy();
        ready = true;
        return resolve({
          call: (tool, args) =>
            new Promise((settle) => {
              if (socket.destroyed) return settle({ error: 'The thread tools have ended.' });
              const id = ++next;
              waiting.set(id, settle);
              socket.write(`${JSON.stringify({ id, tool, args })}\n`);
            }),
          close: () => socket.destroy(),
        });
      }
      const settle = waiting.get(value.id ?? -1);
      waiting.delete(value.id ?? -1);
      settle?.('result' in value ? { result: value.result } : { error: String(value.error) });
    });
    socket.write(`${JSON.stringify({ thread: options.thread, token: options.token })}\n`);
  });
}

/** Answers one JSON-RPC message, or returns undefined for a notification. */
export async function handle(broker: Broker, line: string): Promise<unknown> {
  let message: z.output<typeof RequestSchema>;
  try {
    message = RequestSchema.parse(JSON.parse(line));
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC.' } };
  }
  const { id, method, params } = message;
  if (id === undefined) return undefined;
  const result = (value: unknown) => ({ jsonrpc: '2.0', id, result: value });
  const error = (code: number, text: string) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message: text },
  });
  if (method === 'initialize') {
    const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
    return result({
      protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: THREAD_TOOLS_SERVER, version: '0.1.0' },
    });
  }
  if (method === 'ping') return result({});
  if (method === 'tools/list') return result({ tools: toolList() });
  if (method !== 'tools/call') return error(-32601, 'Method not found.');
  const call = CallParamsSchema.safeParse(params);
  if (!call.success || !Object.hasOwn(THREAD_TOOLS, call.data.name))
    return error(-32602, 'Unknown tool.');
  const reply = await broker.call(call.data.name as ThreadToolName, call.data.arguments ?? {});
  const text = 'result' in reply ? JSON.stringify(reply.result) : reply.error;
  return result({ content: [{ type: 'text', text }], isError: 'error' in reply });
}

/** Serves stdio until the input ends. Requests answer in the order they arrived. */
export async function serve(input: Readable, output: Writable, broker: Broker) {
  let chain = Promise.resolve();
  lines(input, (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      const response = await handle(broker, line);
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve) => {
    input.once('end', resolve);
    input.once('close', resolve);
  });
  await chain;
}

function parseArguments(argv: readonly string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return z
    .strictObject({
      thread: TaskIdSchema,
      token: z.string().regex(/^[a-f0-9]{64}$/),
      socket: z.string().max(4096).refine(isAbsolute),
    })
    .parse({ thread: value('--thread'), token: value('--token'), socket: value('--socket') });
}

async function main() {
  const broker = await connectBroker(parseArguments(process.argv.slice(2)));
  try {
    await serve(process.stdin, process.stdout, broker);
  } finally {
    broker.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch(() => {
    // The token is on the command line, so the message names no argument.
    process.stderr.write('The CrewKite thread tools are unavailable for this turn.\n');
    process.exitCode = 1;
  });
