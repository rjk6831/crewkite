import { parseArgs } from 'node:util';
import { CLI_EXIT, CLI_JSON_LINE_VERSION, MAX_CHAT_SEARCH_THREADS } from '@crewkite/contracts';
import { crewkiteHome } from '../settings.ts';
import { type Connect, type Io, jsonLine, notDone, terminalText, UsageError } from './scripting.ts';

// `crewkite search <text>`: find a message, a tool card or a file path across every thread. The
// controller answers from its index and the CLI prints what it said. With --json each thread is
// one `result` line, and a last `result` line says how many threads there were and whether the
// page left matches out. Nothing here reads a thread's rows itself.

export const searchHelp = `Usage: crewkite search <text> [--limit 1..50] [--per-thread 1..5] [--json] [--home path]

Finds titles, messages, tool card titles and summaries and the file paths they named in every
thread, best match first, grouped by thread. Each word needs three characters or more, and every
word has to appear in the same place. Text output lists a thread and its matches. With --json each
thread is one line with kind result, command SearchChatHistory and its hits in data, and a last
line with taskId null says how many threads matched and whether more were left out.
`;

const count = (value: string | undefined, name: string, max: number): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^[0-9]{1,3}$/.test(value) || Number(value) < 1 || Number(value) > max)
    throw new UsageError(`Use ${name} with a number from 1 to ${max}.`);
  return Number(value);
};

export async function runSearchCommand(args: string[], io: Io, connect: Connect): Promise<number> {
  let json = false;
  let client: Awaited<ReturnType<Connect>> | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        home: { type: 'string' },
        limit: { type: 'string' },
        'per-thread': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    json = values.json === true;
    if (values.help) {
      await io.out(searchHelp);
      return 0;
    }
    const query = positionals.join(' ').trim();
    if (query === '')
      throw new UsageError('Give the text to search for. Quote it if it has spaces.');
    const limit = count(values.limit, '--limit', MAX_CHAT_SEARCH_THREADS);
    const perThread = count(values['per-thread'], '--per-thread', 5);
    client = await connect(crewkiteHome(values.home));
    const result = await client.searchHistory({ query, limit, perThread });
    if (json) {
      for (const group of result.groups)
        await io.out(
          jsonLine({
            v: CLI_JSON_LINE_VERSION,
            kind: 'result',
            command: 'SearchChatHistory',
            outcome: 'applied',
            reason: null,
            next: null,
            taskId: group.taskId,
            data: { query: result.query, title: group.title, hits: group.hits },
          }),
        );
      await io.out(
        jsonLine({
          v: CLI_JSON_LINE_VERSION,
          kind: 'result',
          command: 'SearchChatHistory',
          outcome: 'applied',
          reason: null,
          next: null,
          taskId: null,
          data: {
            query: result.query,
            threads: result.groups.length,
            more: result.more,
            tooShort: result.tooShort,
          },
        }),
      );
      return 0;
    }
    if (result.tooShort) {
      io.err('Each word needs three characters or more.\n');
      return 0;
    }
    for (const group of result.groups) {
      await io.out(`${group.taskId}  ${terminalText(group.title)}\n`);
      for (const hit of group.hits) {
        const where = hit.turnId ? `  ${hit.turnId}` : '';
        await io.out(`  ${hit.kind.padEnd(7)} ${terminalText(hit.snippet)}${where}\n`);
      }
    }
    if (result.groups.length === 0) io.err('No matches.\n');
    else if (result.more) io.err('More matches exist. Narrow the text or raise --limit.\n');
    return 0;
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : 'The command could not run.';
    if (json)
      void io.out(
        jsonLine({ v: CLI_JSON_LINE_VERSION, kind: 'error', message: message.slice(0, 4096) }),
      );
    else io.err(`${terminalText(message)}\n`);
    return notDone(error) ? CLI_EXIT.notDone : CLI_EXIT.failed;
  } finally {
    client?.transport.close();
  }
}
