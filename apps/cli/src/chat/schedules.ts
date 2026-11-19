import { parseArgs } from 'node:util';
import {
  CLI_EXIT,
  type CommandResult,
  type PlanSchedulesRead,
  PlanSchedulesReadSchema,
} from '@crewkite/contracts';
import { scheduleWords } from '../../../desktop/src/renderer/recipes/model.ts';
import {
  changedLine,
  lastResultCell,
  nextRunCell,
  type ScheduleChange,
  scheduleLine,
} from '../../../desktop/src/renderer/recipes/schedules-model.ts';
import { crewkiteHome } from '../settings.ts';
import { applied, type ChatClient } from './client.ts';
import { resolveRecipe, table, timeWords } from './recipes.ts';
import {
  type Connect,
  failure,
  type Io,
  jsonLine,
  projectIdArg,
  resultLine,
  terminalText,
  UsageError,
} from './scripting.ts';

// `crewkite loop list|pause|resume|restart`. A recipe's trigger, budget and work source is a loop
// to a person, and the controller calls it a schedule. The controller holds the words for why one
// paused or stopped, so this file only lays them out. A refusal prints the controller's sentence
// to stderr and exits 2, and --json writes one result line per command.

export const schedulesHelp = `Usage: crewkite loop <command>

  loop list [--project id]              List loops, next runs and why one paused or stopped
  loop pause|resume|restart <recipe>

<recipe> is a recipe's name, path or ID. Every command takes --json, --home path and --project id.
`;

const closing = 'Loops run while CrewKite is open.';
const moreLoopsLine = (count: number) =>
  count === 1 ? '1 more loop is not shown.' : `${count} more loops are not shown.`;

/**
 * `projects` names each project. With loops in more than one project a PROJECT column follows the
 * recipe, so two rows with the same recipe name can be told apart.
 */
export function scheduleListText(
  read: PlanSchedulesRead,
  projects: readonly { id: string; name: string }[] = [],
): string {
  if (!read.schedules.length) return `No loops.\n${closing}`;
  const named = new Map(projects.map(({ id, name }) => [id, name]));
  const across = new Set(read.schedules.map(({ schedule }) => schedule.projectId)).size > 1;
  const rows: string[][] = [];
  const lines: (string | null)[] = [];
  for (const { schedule, name } of read.schedules) {
    const last = lastResultCell(schedule, timeWords);
    rows.push([
      name,
      ...(across ? [named.get(schedule.projectId) ?? 'Unknown'] : []),
      scheduleWords[schedule.state],
      nextRunCell(schedule, timeWords),
      [last.text, last.time].filter(Boolean).join(' '),
      String(schedule.runsStarted),
    ]);
    lines.push(scheduleLine(schedule));
  }
  const grid = table(
    ['RECIPE', ...(across ? ['PROJECT'] : []), 'STATE', 'NEXT', 'LAST', 'RUNS'],
    rows,
  ).split('\n');
  // A row's line sits under it, so the header takes the first grid line.
  const out = [grid[0]];
  rows.forEach((_, at) => {
    out.push(grid[at + 1]);
    if (lines[at]) out.push(`  ${lines[at]}`);
  });
  if (read.more) out.push(moreLoopsLine(read.more));
  out.push(closing);
  return terminalText(out.join('\n'));
}

export async function runScheduleCommand(
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
        project: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    json = values.json === true;
    const [action, recipe, ...extra] = positionals;
    if (values.help || !action) {
      await io.out(schedulesHelp);
      return 0;
    }
    if (!['list', 'pause', 'resume', 'restart'].includes(action))
      throw new UsageError(`Unknown loop command: ${action}.`);
    if (action === 'list' && recipe !== undefined)
      throw new UsageError('Loop list takes no recipe.');
    if (action !== 'list' && !recipe) throw new UsageError('Give the recipe.');
    if (extra.length > 0) throw new UsageError('Quote a name that has spaces.');
    if (values.project !== undefined) projectIdArg(values.project);
    client = await connect(crewkiteHome(values.home));
    // A refusal prints the controller's sentence and means nothing was done.
    const report = async (command: string, result: CommandResult) => {
      if (json) await io.out(jsonLine(resultLine(command, result, null)));
      if (!applied(result)) {
        if (!json) io.err(`${result.next ?? result.reason ?? 'The controller refused.'}\n`);
        return CLI_EXIT.notDone;
      }
      return null;
    };
    const read = async (projectId: string | undefined) => {
      const result = await client?.send('ReadSchedules', projectId ? { projectId } : {});
      return result as CommandResult;
    };
    const parse = (result: CommandResult) => {
      const { kind: _kind, ...rest } = (result.data ?? {}) as Record<string, unknown>;
      return PlanSchedulesReadSchema.parse(rest);
    };
    if (action === 'list') {
      const result = await read(values.project);
      const refused = await report('ReadSchedules', result);
      if (refused !== null) return refused;
      if (!json) await io.out(`${scheduleListText(parse(result), await client.listProjects())}\n`);
      return 0;
    }
    const { projectId, entry } = await resolveRecipe(client, recipe as string, values.project);
    // A file CrewKite never saved has no record, so it has no schedule either.
    const result = entry.record
      ? await client.send('SetRecipeSchedule', {
          recipeId: entry.record.id,
          action: action as ScheduleChange,
        })
      : ({
          outcome: 'blocked',
          reason: 'recipe-not-found',
          next: 'That recipe is not saved here.',
        } satisfies CommandResult);
    const refused = await report('SetRecipeSchedule', result);
    if (refused !== null) return refused;
    if (!json) {
      // The answer carries no schedule, so the next run comes from a read after the change. The
      // change went through, so a read that fails leaves the line without its second sentence.
      const after = await read(projectId)
        .then((result) =>
          parse(result).schedules.find(({ schedule }) => schedule.recipeId === entry.record?.id),
        )
        .catch(() => undefined);
      await io.out(
        `${changedLine(action as ScheduleChange, after?.schedule.nextAt ?? null, timeWords)}\n`,
      );
    }
    return 0;
  } catch (error) {
    return failure(error, io, json);
  } finally {
    client?.transport.close();
  }
}
