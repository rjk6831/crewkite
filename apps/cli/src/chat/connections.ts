import { parseArgs } from 'node:util';
import {
  AddConnectionPayloadSchema,
  CLI_EXIT,
  type CommandResult,
  ConnectionAddedSchema,
  type ConnectionsRead,
  ConnectionsReadSchema,
} from '@crewkite/contracts';
import {
  connectionAttention,
  connectionName,
  isApiConnection,
  observedModeText,
} from '../../../desktop/src/renderer/settings/connection-view.ts';
import { spendText } from '../../../desktop/src/renderer/usage-presentation.ts';
import { crewkiteHome } from '../settings.ts';
import { applied, type ChatClient } from './client.ts';
import {
  type Connect,
  connectionIdArg,
  failure,
  findConnection,
  type Io,
  jsonLine,
  resultLine,
  terminalText,
  UsageError,
} from './scripting.ts';

// `crewkite connections ...`. The controller keeps the connection records and the key stays with
// the provider's client, so nothing here reads or prints a credential. A connection runs a turn
// only where `crewkite thread use-api` or the desktop's Crew tab assigned it.

export const connectionsHelp = `Usage: crewkite connections [--json] [--home path]
       crewkite connections add <openai|anthropic> [--label text] [--json] [--home path]
       crewkite connections check <connection-id> [--json] [--home path]
       crewkite connections keep <connection-id> on|off [--json] [--home path]
       crewkite connections disconnect <connection-id> [--json] [--home path]
       crewkite connections forget <connection-id> --confirm [--json] [--home path]

An API connection bills the provider's API rates to your own key. Each provider runs on your
subscription unless you assign a connection to a thread or a role with crewkite thread use-api.
add prints the sign-in line for the connection's own client profile. Run it in your terminal,
where the client takes the key, then run check. check asks the client which mode it is signed in
with, which takes up to 30 seconds, and makes the connection ready when it reports API billing.
disconnect keeps the connection and its assignments, and turns on it are refused until check
connects it again. forget removes it and its assignments and signs out its own profile. Exit
status: 0 done, 1 failed, 2 nothing was done.
`;

/** Joins sentences that may or may not end with a period. */
export const sentences = (parts: (string | null | false)[]) =>
  `${parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/\.$/, ''))
    .join('. ')}.`;

/** Each API connection in two lines, and its sign-in line while it needs one. */
export function connectionsText(read: ConnectionsRead): string {
  return read.connections
    .filter(isApiConnection)
    .map((connection) => {
      const line = read.loginLines.find((row) => row.connectionId === connection.connectionId);
      const spend = read.spend.find((row) => row.connectionId === connection.connectionId);
      const status = connectionAttention(connection) ?? `Ready, ${observedModeText('api')}`;
      return [
        `${connection.connectionId}  ${connectionName(connection)}`,
        `  ${sentences([
          status,
          `Keep connected ${connection.keepConnected ? 'on' : 'off'}`,
          spendText(spend?.spend ?? null),
        ])}`,
        ...(connection.readiness === 'needs-attention' && line ? [`  Sign in: ${line.line}`] : []),
      ].join('\n');
    })
    .map((text) => `${terminalText(text)}\n`)
    .join('');
}

export async function runConnectionsCommand(
  args: string[],
  io: Io,
  connect: Connect,
): Promise<number> {
  let client: ChatClient | undefined;
  let json = args.includes('--json');
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        home: { type: 'string' },
        label: { type: 'string' },
        confirm: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    json = values.json === true;
    const [action = 'list', first, second, ...extra] = positionals;
    if (values.help) {
      await io.out(connectionsHelp);
      return 0;
    }
    if (
      extra.length > 0 ||
      (action !== 'keep' && second !== undefined) ||
      (action === 'list' && first !== undefined)
    )
      throw new UsageError(
        action === 'add' ? 'Quote a label that has spaces.' : 'Too many arguments.',
      );
    // Arguments are checked here, so a mistake never reaches the controller.
    let added: { family: 'openai' | 'anthropic'; label?: string } | null = null;
    if (action === 'add') {
      const parsed = AddConnectionPayloadSchema.safeParse({
        family: first,
        ...(values.label === undefined ? {} : { label: values.label.trim() }),
      });
      if (!parsed.success)
        throw new UsageError(
          'Give openai or anthropic, and a --label of up to 60 characters on one line.',
        );
      added = parsed.data;
    } else if (['check', 'keep', 'disconnect', 'forget'].includes(action)) connectionIdArg(first);
    else if (action !== 'list') throw new UsageError(`Unknown connections command: ${action}.`);
    if (action === 'keep' && second !== 'on' && second !== 'off')
      throw new UsageError('Give on or off after the connection ID.');
    client = await connect(crewkiteHome(values.home));
    const report = async (command: string, result: CommandResult, done: string) => {
      if (json) await io.out(jsonLine(resultLine(command, result, null)));
      if (!applied(result)) {
        if (!json) io.err(`${result.next ?? result.reason ?? 'The controller refused.'}\n`);
        return CLI_EXIT.notDone;
      }
      if (!json && done) await io.out(`${done}\n`);
      return 0;
    };
    const id = first as string;
    switch (action) {
      case 'list': {
        const result = await client.send('ReadConnections', {});
        if (json || !applied(result)) return await report('ReadConnections', result, '');
        const { kind: _kind, ...rest } = (result.data ?? {}) as Record<string, unknown>;
        const text = connectionsText(ConnectionsReadSchema.parse(rest));
        if (text) await io.out(text);
        else io.err('No API connections. Add one with crewkite connections add openai.\n');
        return 0;
      }
      case 'add': {
        const result = await client.send('AddConnection', added);
        if (json || !applied(result)) return await report('AddConnection', result, '');
        const { kind: _kind, ...rest } = (result.data ?? {}) as Record<string, unknown>;
        const { connection, loginLine } = ConnectionAddedSchema.parse(rest);
        io.err(
          `Added ${connection.connectionId}, ${terminalText(connectionName(connection))}. Run this line in your terminal, then run crewkite connections check ${connection.connectionId}.\n`,
        );
        await io.out(`${terminalText(loginLine)}\n`);
        return 0;
      }
      case 'check': {
        if (!json)
          io.err('Asking the client which mode it is signed in with. This takes up to 30 s.\n');
        const result = await client.send('ProveConnection', { connectionId: id });
        return await report(
          'ProveConnection',
          result,
          `Ready. The client reports ${observedModeText('api')}.`,
        );
      }
      case 'keep': {
        const result = await client.send('SetKeepConnected', {
          connectionId: id,
          keepConnected: second === 'on',
        });
        return await report('SetKeepConnected', result, `Keep connected ${second}.`);
      }
      case 'disconnect': {
        const result = await client.send('DisconnectConnection', { connectionId: id });
        return await report(
          'DisconnectConnection',
          result,
          `Disconnected. crewkite connections check ${id} connects it again.`,
        );
      }
      default: {
        const { connection } = await findConnection(client, id);
        const name = terminalText(connectionName(connection));
        if (!values.confirm)
          throw new UsageError(
            `This removes ${name}, and threads and roles set to use it go back to the subscription. Its own profile is signed out. Run it again with --confirm to forget it.`,
          );
        const result = await client.send('ForgetConnection', { connectionId: id });
        return await report('ForgetConnection', result, `Forgot ${name}.`);
      }
    }
  } catch (error) {
    return failure(error, io, json);
  } finally {
    client?.transport.close();
  }
}
