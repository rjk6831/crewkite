import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { exportResults } from '@crewkite/client';
import { replaceFile } from '@crewkite/client/node';
import {
  CLI_EXIT,
  type CommandResult,
  type ResultsRead,
  ResultsReadSchema,
} from '@crewkite/contracts';
import {
  crewRows,
  exportedLine,
  isEmpty,
  moreRecipesLine,
  moreRowsLine,
  recipeRows,
} from '../../../desktop/src/renderer/recipes/results-model.ts';
import { crewkiteHome } from '../settings.ts';
import { applied, type ChatClient } from './client.ts';
import { resolveRecipe, table } from './recipes.ts';
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

// `crewkite results`. The controller counts what each step of a plan produced and keeps it on this
// device, and the Results view's cell functions turn the counts into words, so the two say the
// same thing. Nothing is ranked and nothing leaves the device unless the person writes the file.

export const resultsHelp = `Usage: crewkite results [options]

  results [--project id] [--recipe r]   Show counts per recipe and per role and model
  results --export <file>               Write the recorded results as JSON

<recipe> is a recipe's name, path or ID. Every command takes --home path, --project id and
--recipe r. Showing results takes --json.
`;

const closing = 'Counts from this device. Nothing here is uploaded.';
const unwritable = 'The file could not be written there. Choose another place.';

export function resultsText(read: ResultsRead): string {
  if (isEmpty(read)) return `No results yet.\n${closing}`;
  const sections: string[] = [];
  if (read.recipes.length || read.moreRecipes) {
    // Each allowance line has its own row under the recipe, so windows never read as one sum.
    const rows: string[][] = [];
    recipeRows(read.recipes).forEach((row) => {
      rows.push([
        row.name,
        row.runs,
        row.slices,
        row.passed,
        row.fixRounds,
        row.accepted,
        row.allowance[0],
      ]);
      for (const line of row.allowance.slice(1)) rows.push(['', '', '', '', '', '', line]);
    });
    sections.push(
      [
        'By recipe',
        ...(rows.length
          ? [
              table(
                [
                  'RECIPE',
                  'RUNS',
                  'SLICES',
                  'PASSED FIRST REVIEW',
                  'FIX ROUNDS',
                  'ACCEPTED',
                  'ALLOWANCE USED',
                ],
                rows,
              ),
            ]
          : []),
        ...(read.moreRecipes ? [moreRecipesLine(read.moreRecipes)] : []),
      ].join('\n'),
    );
  }
  if (read.crew.length || read.moreCrew) {
    const rows: string[][] = [];
    crewRows(read.crew).forEach((row) => {
      rows.push([
        row.role,
        row.model,
        row.effort,
        row.steps,
        row.slices,
        row.passed,
        row.fixRounds,
        row.accepted,
        row.allowance,
      ]);
      // The provider's name sits under the model, as in the view.
      rows.push(['', row.provider, '', '', '', '', '', '', '']);
    });
    sections.push(
      [
        'By role and model',
        ...(rows.length
          ? [
              table(
                [
                  'ROLE',
                  'MODEL',
                  'EFFORT',
                  'STEPS',
                  'SLICES',
                  'PASSED FIRST REVIEW',
                  'FIX ROUNDS',
                  'ACCEPTED',
                  'ALLOWANCE USED',
                ],
                rows,
              ),
            ]
          : []),
        ...(read.moreCrew ? [moreRowsLine(read.moreCrew)] : []),
      ].join('\n'),
    );
  }
  return terminalText([...sections, closing].join('\n\n'));
}

/** Writes the file the way the desktop does: whole, or not at all, and never through a link. */
function writeExport(path: string, text: string) {
  try {
    replaceFile(path, text);
  } catch {
    throw new Error(unwritable);
  }
}

export async function runResultsCommand(args: string[], io: Io, connect: Connect): Promise<number> {
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
        recipe: { type: 'string' },
        export: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    json = values.json === true;
    if (values.help) {
      await io.out(resultsHelp);
      return 0;
    }
    if (positionals.length > 0)
      throw new UsageError(`Unknown results argument: ${positionals[0]}.`);
    if (values.export !== undefined && !values.export) throw new UsageError('Give the file.');
    if (values.export !== undefined && json)
      throw new UsageError('--export writes a file and takes no --json.');
    if (values.project !== undefined) projectIdArg(values.project);
    client = await connect(crewkiteHome(values.home));
    const projects = await client.listProjects();
    // An ID in the right shape that no project holds would read as no results, or export an empty
    // file, so it is refused before anything is read or written.
    if (values.project !== undefined && !projects.some(({ id }) => id === values.project))
      throw new UsageError('Choose a registered project.');
    let projectId = values.project;
    let recipeId: string | undefined;
    if (values.recipe !== undefined) {
      const found = await resolveRecipe(client, values.recipe, values.project);
      // A file CrewKite never saved has no record, so it has no results.
      if (!found.entry.record) throw new UsageError('That recipe is not saved here.');
      projectId = found.projectId;
      recipeId = found.entry.record.id;
    } else if (!projectId) {
      projectId = projectIdArg(projects.length === 1 ? projects[0].id : undefined);
    }
    const scope = { projectId: projectId as string, ...(recipeId ? { recipeId } : {}) };
    if (values.export !== undefined) {
      const open = client;
      let file: Awaited<ReturnType<typeof exportResults>>;
      try {
        file = await exportResults(
          (request) => open.send('ExportResults', request),
          scope,
          () => new Date(),
        );
      } catch (error) {
        io.err(`${terminalText(error instanceof Error ? error.message : unwritable)}\n`);
        return CLI_EXIT.notDone;
      }
      try {
        writeExport(values.export, `${JSON.stringify(file, null, 2)}\n`);
      } catch (error) {
        io.err(`${(error as Error).message}\n`);
        return CLI_EXIT.notDone;
      }
      await io.out(`${exportedLine(file.records.length, terminalText(basename(values.export)))}\n`);
      return 0;
    }
    const result: CommandResult = await client.send('ReadResults', scope);
    if (json) await io.out(jsonLine(resultLine('ReadResults', result, null)));
    if (!applied(result)) {
      if (!json) io.err(`${result.next ?? result.reason ?? 'The controller refused.'}\n`);
      return CLI_EXIT.notDone;
    }
    if (!json) {
      const { kind: _kind, ...rest } = (result.data ?? {}) as Record<string, unknown>;
      await io.out(`${resultsText(ResultsReadSchema.parse(rest))}\n`);
    }
    return 0;
  } catch (error) {
    return failure(error, io, json);
  } finally {
    client?.transport.close();
  }
}
