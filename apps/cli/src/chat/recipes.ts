import { parseArgs } from 'node:util';
import {
  type ChatFamily,
  CLI_EXIT,
  type CommandResult,
  type PlanRecipe,
  type PlanRecipeEntry,
  type PlanRecipeFile,
  type PlanRecipeRead,
  PlanRecipeReadSchema,
  PlanRecipeRunStartedSchema,
  type PlanRecipesRead,
  PlanRecipesReadSchema,
  type PlanRecipeTrigger,
  planScheduleLine,
} from '@crewkite/contracts';
import { flightModes, handoffModes } from '../../../desktop/src/renderer/settings/preferences.ts';
import { crewkiteHome } from '../settings.ts';
import { applied, type ChatClient } from './client.ts';
import {
  type Connect,
  failure,
  type Io,
  jsonLine,
  projectIdArg,
  resultLine,
  runThreadCommand,
  terminalText,
  UsageError,
} from './scripting.ts';

// `crewkite recipe list|show|run`. A recipe is one file in the project, and the controller runs
// only the version it saved (ADR 0057). Text goes to stdout, a refusal prints the controller's
// sentence to stderr and exits 2, and --json writes one result line per command.

export const recipesHelp = `Usage: crewkite <command>

  recipe list [--project id]            List a project's recipes
  recipe show <recipe>                  Show one recipe
  recipe run <recipe> "<request>"       Run a recipe on a new request

<recipe> is a recipe's name, path or ID. Every command takes --json and --home path, list, show
and run take --project id, and recipe run takes --watch.
`;

const provider: Record<ChatFamily, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  local: 'Local',
};
const shapeWords = { change: 'Changes files', report: 'Report only' };
const policyWords = { ask: 'Ask', 'allow-edits': 'Allow edits', 'allow-all': 'Allow all' };
const stateWords = { active: 'Active', paused: 'Paused', stopped: 'Stopped' };
const fileWords: Record<PlanRecipeFile, string> = {
  current: '',
  changed: 'Changed on disk',
  missing: 'Missing',
  invalid: 'Does not read',
  unrecorded: 'Not saved here',
};

/** A time as a recipe shows it: the UTC date and minute. */
export const timeWords = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;

/** How a trigger reads: the largest unit that divides an interval evenly. */
export function triggerWords(trigger: PlanRecipeTrigger): string {
  switch (trigger.kind) {
    case 'manual':
      return 'Manual';
    case 'once':
      return `Once, ${timeWords(trigger.at)}`;
    case 'interval': {
      const minutes = trigger.everyMinutes;
      if (minutes % 1440 === 0) return `Every ${minutes / 1440} d`;
      if (minutes % 60 === 0) return `Every ${minutes / 60} h`;
      return `Every ${minutes} min`;
    }
    case 'reset':
      return `At each ${provider[trigger.family]} reset`;
  }
}

const scheduleText = (entry: PlanRecipeEntry) =>
  entry.schedule
    ? [
        stateWords[entry.schedule.state],
        entry.schedule.note && planScheduleLine(entry.schedule.note),
      ]
        .filter(Boolean)
        .join('. ')
        .replace(/\.\.$/, '.')
    : '';

/** Rows under upper case headers, each column as wide as its longest cell. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, at) =>
    Math.max(header.length, ...rows.map((row) => row[at].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, at) => (at === cells.length - 1 ? cell : cell.padEnd(widths[at])))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export function recipeListText(read: PlanRecipesRead): string {
  if (!read.recipes.length) return 'No recipes in this project.';
  const rows = read.recipes.map((entry) => [
    entry.name ?? '',
    entry.trigger ? triggerWords(entry.trigger) : '',
    scheduleText(entry).split('.')[0],
    fileWords[entry.file],
    entry.path,
  ]);
  const shown = terminalText(table(['NAME', 'STARTS', 'LOOP', 'FILE', 'PATH'], rows));
  return read.more ? `${shown}\n${read.more} more files in this folder are not shown.` : shown;
}

export function recipeShowText(read: PlanRecipeRead): string {
  const { entry } = read;
  const body: PlanRecipe | null = read.saved ?? read.recipe;
  if (!body)
    return terminalText(
      [`${entry.path}  ${fileWords[entry.file]}`, entry.problem].filter(Boolean).join('\n'),
    );
  const version = read.savedVersion === null ? 'Not saved yet' : `version ${read.savedVersion}`;
  const flight = flightModes.find(({ id }) => id === body.run.flightMode)?.label ?? '';
  const handoff = body.run.handoff;
  const mode = handoffModes.find(({ id }) => id === handoff.mode)?.label ?? '';
  const budget = body.budget;
  const limits = Object.entries(budget?.maxUsedPercent ?? {}).map(
    ([family, limit]) => `${provider[family as ChatFamily]} ${limit}% used`,
  );
  const lines = [
    `${body.name}  ${version}  ${entry.path}`,
    ...(body.description ? [body.description] : []),
    '',
    `Run type   ${shapeWords[body.shape]}`,
    `Flight     ${flight}   Permissions ${policyWords[body.run.permissionPolicy]}   Most slices ${body.run.maxSlices}`,
    `On a limit ${handoff.auto ? `Move to another provider, ${mode}` : 'Stop and say so'}`,
    '',
    'Crew',
    ...body.crew.members.map(
      ({ role, selection }) =>
        `  ${role}  ${provider[selection.family]}  ${selection.model}  ${selection.effort}`,
    ),
    '',
    'Checks',
    ...(body.checks.length ? body.checks.map((check) => `  ${check.command}`) : ['  No checks.']),
    '',
    `Starts     ${triggerWords(body.trigger)}`,
    ...(budget
      ? [
          `Budget     ${[`most runs ${budget.maxRuns}`, `most waiting ${budget.maxWaiting}`, ...limits].join(', ')}`,
        ]
      : []),
    ...(body.work
      ? [
          `Work       ${body.work.kind === 'request' ? (body.work.text.split('\n')[0] ?? '') : `checklist ${body.work.path}`}`,
        ]
      : []),
    ...(entry.schedule ? [`Loop       ${scheduleText(entry)}`] : []),
  ];
  return terminalText(lines.join('\n'));
}

type Match = { projectId: string; entry: PlanRecipeEntry };

/**
 * The recipe a person named: an ID first, then an exact path, then an exact name. A project
 * named with --project is the only one searched, and otherwise every registered project is.
 */
export async function resolveRecipe(
  client: ChatClient,
  text: string,
  projectId: string | undefined,
): Promise<Match> {
  const projects = projectId ? [projectId] : (await client.listProjects()).map(({ id }) => id);
  const all: Match[] = [];
  for (const id of projects) {
    const result = await client.send('ReadRecipes', { projectId: id });
    if (!applied(result) || result.data === undefined) continue;
    const { kind: _kind, ...rest } = result.data as Record<string, unknown>;
    for (const entry of PlanRecipesReadSchema.parse(rest).recipes)
      all.push({ projectId: id, entry });
  }
  for (const found of [
    all.filter(({ entry }) => entry.record?.id === text),
    all.filter(({ entry }) => entry.path === text),
    all.filter(({ entry }) => entry.name === text),
  ]) {
    if (found.length === 1) return found[0];
    if (found.length > 1)
      throw new UsageError(
        // A name or a path can repeat across projects, and only --project tells them apart.
        new Set(found.map(({ projectId: id }) => id)).size > 1
          ? `More than one project has a recipe that matches "${text}". Add --project.`
          : `More than one recipe matches "${text}". Use its path.`,
      );
  }
  throw new UsageError(`No recipe matches "${text}".`);
}

export async function runRecipeCommand(args: string[], io: Io, connect: Connect): Promise<number> {
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
        watch: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    json = values.json === true;
    const [action, recipe, request, ...extra] = positionals;
    if (values.help || !action) {
      await io.out(recipesHelp);
      return 0;
    }
    if (!['list', 'show', 'run'].includes(action))
      throw new UsageError(`Unknown recipe command: ${action}.`);
    // Words past the recipe are the rest of an unquoted name, except on a run whose first word
    // already names a recipe, where they are the rest of an unquoted request.
    if (action !== 'run' && request !== undefined)
      throw new UsageError('Quote a name that has spaces.');
    if (action !== 'list' && !recipe) throw new UsageError('Give the recipe.');
    if (action === 'run' && !request) throw new UsageError('Give the request.');
    if (values.project !== undefined) projectIdArg(values.project);
    client = await connect(crewkiteHome(values.home));
    // A refusal prints the controller's sentence and means nothing was done.
    const report = async (command: string, result: CommandResult, taskId: string | null) => {
      if (json) await io.out(jsonLine(resultLine(command, result, taskId)));
      if (!applied(result)) {
        if (!json) io.err(`${result.next ?? result.reason ?? 'The controller refused.'}\n`);
        return CLI_EXIT.notDone;
      }
      return null;
    };
    if (action === 'list') {
      let projectId = values.project;
      if (!projectId) {
        const projects = await client.listProjects();
        projectId = projectIdArg(projects.length === 1 ? projects[0].id : undefined);
      }
      const result = await client.send('ReadRecipes', { projectId });
      const refused = await report('ReadRecipes', result, null);
      if (refused !== null) return refused;
      if (!json) {
        const { kind: _kind, ...rest } = (result.data ?? {}) as Record<string, unknown>;
        await io.out(`${recipeListText(PlanRecipesReadSchema.parse(rest))}\n`);
      }
      return 0;
    }
    if (extra.length > 0) {
      const named = await resolveRecipe(client, recipe as string, values.project).then(
        () => true,
        () => false,
      );
      throw new UsageError(
        named ? 'Quote a request that has spaces.' : 'Quote a name that has spaces.',
      );
    }
    const { projectId, entry } = await resolveRecipe(client, recipe as string, values.project);
    if (action === 'show') {
      const result = await client.send('ReadRecipe', {
        projectId,
        ...(entry.record ? { recipeId: entry.record.id } : { path: entry.path }),
      });
      const refused = await report('ReadRecipe', result, null);
      if (refused !== null) return refused;
      if (!json) {
        const { kind: _kind, ...rest } = (result.data ?? {}) as Record<string, unknown>;
        await io.out(`${recipeShowText(PlanRecipeReadSchema.parse(rest))}\n`);
      }
      return 0;
    }
    // A file CrewKite never saved has no record to run.
    const result = entry.record
      ? await client.send('RunRecipe', { recipeId: entry.record.id, request })
      : ({
          outcome: 'blocked',
          reason: 'recipe-not-found',
          next: 'That recipe is not saved here.',
        } satisfies CommandResult);
    const { kind: _kind, ...rest } = (result.data ?? {}) as Record<string, unknown>;
    const run = applied(result) ? PlanRecipeRunStartedSchema.parse(rest).run : null;
    const refused = await report('RunRecipe', result, run?.taskId ?? null);
    if (refused !== null || !run) return refused ?? 0;
    if (!json)
      await io.out(`Started ${terminalText(entry.name ?? entry.path)} as thread ${run.taskId}.\n`);
    if (values.watch === true) {
      client.transport.close();
      client = undefined;
      return await runThreadCommand(
        ['watch', run.taskId, '--home', crewkiteHome(values.home), ...(json ? ['--json'] : [])],
        io,
        connect,
      );
    }
    if (!json) await io.out(`Follow it with: crewkite thread watch ${run.taskId}\n`);
    return 0;
  } catch (error) {
    return failure(error, io, json);
  } finally {
    client?.transport.close();
  }
}
