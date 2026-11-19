import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCommandKey } from '@crewkite/client/node';
import {
  ChatThreadSchema,
  type Command,
  type CommandResult,
  type Connection,
} from '@crewkite/contracts';
import { type ChatTransport, chatClient } from './client.ts';
import { terminalActor } from './connect.ts';
import { runThreadCommand } from './scripting.ts';

const taskId = 'tsk_01KA0000000000000000000001';
const connectionId = 'con_01KA0000000000000000000002';
const connection: Connection = {
  connectionId,
  family: 'anthropic',
  backend: 'native-client',
  billingMode: 'api',
  profileId: 'api-01ka0000000000000000000002',
  label: 'Client work',
  keepConnected: false,
  readiness: 'ready',
  proofGeneration: 1,
  observedMode: 'api',
  observedAt: '2026-11-18T08:00:00.000Z',
};

// A controller that answers the two reads use-api makes and records every command it receives.
function controller() {
  const sent: Command[] = [];
  const answer = (command: Command): CommandResult => {
    if (command.command === 'ReadConnections')
      return {
        outcome: 'applied',
        data: {
          kind: 'connections',
          connections: [connection],
          assignments: [],
          spend: [],
          loginLines: [],
        },
      };
    if (command.command === 'ReadChatThread')
      return {
        outcome: 'applied',
        data: {
          kind: 'chat-thread',
          thread: ChatThreadSchema.parse({
            taskId,
            scratchReady: true,
            base: null,
            selection: { family: 'anthropic', model: 'large-2', effort: 'default' },
            crew: {
              name: 'Tandem',
              members: [
                {
                  role: 'builder',
                  selection: { family: 'anthropic', model: 'large-2', effort: 'default' },
                },
                {
                  role: 'reviewer',
                  selection: { family: 'openai', model: 'large-1', effort: 'default' },
                },
              ],
            },
          }),
          turns: [],
          messages: [],
          liveEvents: [],
          cursor: '0',
        },
      };
    return { outcome: 'applied' };
  };
  const transport = {
    command: async (command: Command) => {
      sent.push(command);
      return answer(command);
    },
    close: () => {},
  } as unknown as ChatTransport;
  const connect = async () =>
    chatClient(transport, { key: createCommandKey, actor: terminalActor });
  return { sent, connect };
}

function capture() {
  const io = { out: '', err: '' };
  return {
    io,
    output: {
      out: (text: string) => {
        io.out += text;
      },
      err: (text: string) => {
        io.err += text;
      },
    },
  };
}

test('use-api names the connection and the charge, and assigns it only with --confirm', async () => {
  const { sent, connect } = controller();
  const args = ['use-api', taskId, connectionId, '--role', 'builder'];

  const dry = capture();
  assert.equal(await runThreadCommand(args, dry.output, connect), 2);
  assert.equal(dry.io.out, '');
  assert.equal(
    dry.io.err,
    "This runs the builder's turns on Client work (Anthropic). Provider charges apply. Run it again with --confirm to use it.\n",
  );
  assert.deepEqual(
    sent.map(({ command }) => command).sort(),
    ['ReadChatThread', 'ReadConnections'],
    'the dry run only reads',
  );

  sent.length = 0;
  const confirmed = capture();
  assert.equal(await runThreadCommand([...args, '--confirm'], confirmed.output, connect), 0);
  assert.equal(
    confirmed.io.out,
    "Client work (Anthropic) now runs the builder's turns. Provider charges apply.\n",
  );
  const assigned = sent.filter(({ command }) => command === 'AssignConnection');
  assert.deepEqual(
    assigned.map(({ payload }) => payload),
    [{ taskId, role: 'builder', connectionId, consent: 'explicit' }],
  );
});
