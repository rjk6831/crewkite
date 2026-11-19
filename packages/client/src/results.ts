import type { CommandResult, PlanRecipeRun, SliceResult } from '@crewkite/contracts';

// The file the desktop and the command line write for recorded results. Records and runs come
// from the controller a page at a time, newest first, and land in one file. The caller supplies
// the send function and the clock, so each client keeps its own transport and a test keeps time.

/** What a person reads when a page fails and the controller gave no sentence of its own. */
const UNREADABLE = 'CrewKite could not read the results.';

/** The payload of one `ExportResults` command. */
export type ResultsPageRequest = {
  projectId: string;
  recipeId?: string;
  part: 'records' | 'runs';
  before?: string;
};

export type ResultsFile = {
  schema: 1;
  projectId: string;
  exportedAt: string;
  records: SliceResult[];
  runs: PlanRecipeRun[];
};

/**
 * Reads every page of one project's records, then every page of its runs. The time is taken
 * before the first page, since a record that lands while the pages are read is newer than every
 * cursor and belongs to the next export. A refused page throws the controller's own sentence, or
 * one fixed sentence when it gives none. A send that fails throws what the send threw. A cursor
 * the controller gives twice, or a page for another project or part, throws too, so a fault on
 * its side cannot loop this one.
 */
export async function exportResults(
  send: (request: ResultsPageRequest) => Promise<CommandResult>,
  input: { projectId: string; recipeId?: string },
  now: () => Date,
): Promise<ResultsFile> {
  const exportedAt = now().toISOString();
  const file: ResultsFile = {
    schema: 1,
    projectId: input.projectId,
    exportedAt,
    records: [],
    runs: [],
  };
  for (const part of ['records', 'runs'] as const) {
    const seen = new Set<string>();
    let before: string | undefined;
    do {
      const result = await send({
        projectId: input.projectId,
        ...(input.recipeId ? { recipeId: input.recipeId } : {}),
        part,
        ...(before ? { before } : {}),
      });
      if (
        (result.outcome !== 'applied' && result.outcome !== 'already-applied') ||
        result.data?.kind !== 'results-export'
      )
        throw new Error(result.next ?? UNREADABLE);
      const page = result.data;
      if (page.projectId !== input.projectId || page.part !== part) throw new Error(UNREADABLE);
      file.records.push(...page.records);
      file.runs.push(...page.runs);
      if (page.next !== null && seen.has(page.next)) throw new Error(UNREADABLE);
      if (page.next !== null) seen.add(page.next);
      before = page.next ?? undefined;
    } while (before !== undefined);
  }
  return file;
}
