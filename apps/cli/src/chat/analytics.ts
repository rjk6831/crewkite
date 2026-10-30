import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { allowanceText, analyticsToCsv, countText, tokensText, wallText } from '@crewkite/client';
import {
  type ChatAnalyticsRead,
  ChatAnalyticsReadSchema,
  CLI_EXIT,
  ReadChatAnalyticsPayloadSchema,
} from '@crewkite/contracts';
import { crewkiteHome } from '../settings.ts';
import type { ChatClient } from './client.ts';
import { type Connect, type Io, notDone, terminalText, UsageError } from './scripting.ts';

// `crewkite usage thread <task-id>` and `crewkite usage project <project-id>`. The controller
// derives the numbers and this file shows them, so the terminal adds nothing of its own. With
// --csv the same read goes to a new file. Nothing leaves the machine except that file.

export const analyticsHelp = `Usage: crewkite usage thread <task-id> [--csv new-file] [--json] [--home path]
       crewkite usage project <project-id> [--csv new-file] [--json] [--home path]

Shows turns, tokens, allowance, wall time, handoffs, checks and accepted branches for one thread
or for every thread of a project. A value the client did not report reads as unknown. --csv writes a
new file and refuses an existing one.
`;

const MAX_TURN_LINES = 20;

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd(),
  );
}

export function analyticsText(read: ChatAnalyticsRead): string {
  const lines = [
    `${read.name} (${read.scope} ${read.id})`,
    `Turns ${read.turns}${read.openTurns ? `, ${read.openTurns} still open` : ''}. Handoffs ${read.handoffs}. Wall time ${wallText(read.wallMs)}.`,
    `Tokens in ${tokensText(read.tokensIn, read.tokenTurns, read.turns)}, out ${tokensText(read.tokensOut, read.tokenTurns, read.turns)}.`,
    `Checks run ${read.checksRun}, passed ${read.checksPassed}, failed ${read.checksFailed}. Branches accepted ${read.branchesAccepted}.`,
  ];
  if (read.slices)
    lines.push(
      `Plan slices ${read.slices.total}: ${read.slices.done} done, ${read.slices.failed} failed, ${read.slices.blocked} blocked.`,
    );
  if (read.families.length > 0) {
    lines.push(
      '',
      ...table([
        ['Family', 'Turns', 'Wall time', 'Tokens in', 'Tokens out'],
        ...read.families.map((family) => [
          family.family,
          String(family.turns),
          wallText(family.wallMs),
          tokensText(family.tokensIn, family.tokenTurns, family.turns),
          tokensText(family.tokensOut, family.tokenTurns, family.turns),
        ]),
      ]),
    );
    for (const family of read.families)
      for (const entry of family.allowance)
        lines.push(`Allowance, ${family.family}  ${allowanceText(entry)}`);
  }
  if (read.scope === 'project' && read.threads.length > 0)
    lines.push(
      '',
      ...table([
        ['Thread', 'Turns', 'Wall time', 'Handoffs', 'Checks passed', 'Branches'],
        ...read.threads.map((thread) => [
          thread.title,
          String(thread.turns),
          wallText(thread.wallMs),
          String(thread.handoffs),
          `${thread.checksPassed} of ${thread.checksRun}`,
          String(thread.branchesAccepted),
        ]),
      ]),
    );
  if (read.scope === 'project' && read.threadCount > read.threads.length)
    lines.push(`${read.threadCount - read.threads.length} more threads are not listed.`);
  if (read.scope === 'thread' && read.turnRows.length > 0) {
    const shown = read.turnRows.slice(-MAX_TURN_LINES);
    lines.push(
      '',
      ...table([
        ['Sequence', 'Role', 'Family', 'State', 'Wall time', 'Tokens in', 'Tokens out'],
        ...shown.map((turn) => [
          String(turn.sequence),
          turn.role,
          turn.family,
          turn.state,
          wallText(turn.wallMs),
          countText(turn.tokensIn),
          countText(turn.tokensOut),
        ]),
      ]),
    );
    if (read.turnRows.length > shown.length)
      lines.push(`${read.turnRows.length - shown.length} earlier turns are in the --csv file.`);
  }
  return lines.join('\n');
}

/** Write a new file next to its destination, then link it into place, so an old file stays. */
export function writeNewFile(path: string, text: string) {
  const destination = resolve(path);
  const temporary = join(dirname(destination), `.crewkite-usage-${randomUUID()}`);
  const file = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let open = true;
  try {
    writeFileSync(file, text);
    fsyncSync(file);
    closeSync(file);
    open = false;
    try {
      linkSync(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new UsageError('That file exists. Name a new file.');
      throw error;
    }
    const directory = openSync(dirname(destination), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (open) closeSync(file);
    unlinkSync(temporary);
  }
}

export async function readAnalytics(
  client: ChatClient,
  scope: 'thread' | 'project',
  id: string,
): Promise<ChatAnalyticsRead> {
  const payload = ReadChatAnalyticsPayloadSchema.safeParse(
    scope === 'thread' ? { scope, taskId: id } : { scope, projectId: id },
  );
  if (!payload.success)
    throw new UsageError(
      `Give ${scope === 'thread' ? 'a thread ID such as tsk_...' : 'a project ID such as prj_...'}.`,
    );
  const { data } = await client.run('ReadChatAnalytics', payload.data);
  if (data === undefined) throw new Error('The controller returned no data for this request.');
  const { kind: _kind, ...rest } = data as Record<string, unknown>;
  return ChatAnalyticsReadSchema.parse(rest);
}

export async function runUsageAnalytics(args: string[], io: Io, connect: Connect): Promise<number> {
  let client: ChatClient | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        home: { type: 'string' },
        csv: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    const [scope, id, ...extra] = positionals;
    if (values.help) {
      await io.out(analyticsHelp);
      return 0;
    }
    if ((scope !== 'thread' && scope !== 'project') || !id || extra.length > 0)
      throw new UsageError('Use usage thread <task-id> or usage project <project-id>.');
    client = await connect(crewkiteHome(values.home));
    const read = await readAnalytics(client, scope, id);
    if (values.csv !== undefined) {
      writeNewFile(values.csv, analyticsToCsv(read));
      io.err(`Saved ${resolve(values.csv)}.\n`);
    }
    await io.out(
      values.json
        ? `${JSON.stringify({ kind: 'chat-analytics', ...read })}\n`
        : `${terminalText(analyticsText(read))}\n`,
    );
    return 0;
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : 'The command could not run.';
    io.err(`${terminalText(message)}\n`);
    return notDone(error) ? CLI_EXIT.notDone : CLI_EXIT.failed;
  } finally {
    client?.transport.close();
  }
}
