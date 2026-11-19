import type { ResultsRead } from '@crewkite/contracts';
import { familyName } from '../family-name.ts';
import { crewRoleNames } from '../settings/preferences.ts';
import { effortLabel } from '../thread/model-groups.ts';
import { windowLabel } from '../usage-presentation.ts';

// What the Results view shows in each cell, worked out before anything is drawn. A cell says what
// was counted. A count of nothing reads `None`, and a value the controller never observed reads
// `Unknown`, which is the usual case for an allowance and says nothing is wrong.

export type RecipeResult = ResultsRead['recipes'][number];
export type CrewResult = ResultsRead['crew'][number];

/** A percent with one decimal below 10 and none from 10 up, judged after rounding. */
export function percent(value: number): string {
  const tenth = Math.round(value * 10) / 10;
  return `${tenth < 10 ? tenth.toFixed(1) : Math.round(value)}%`;
}

const count = (value: number, none: string) => (value === 0 ? none : String(value));

/** Slices run. A row with none, such as a role that only ran plan steps, reads `None`. */
export const slicesCell = (slices: number) => count(slices, 'None');

/** `{passed} of {reviewed}`, or `None` when no slice was reviewed. */
export const passedCell = (passed: number, reviewed: number) =>
  reviewed === 0 ? 'None' : `${passed} of ${reviewed}`;

/** The mean to one decimal. `None` with no slice, `Unknown` when the controller holds no mean. */
export const fixRoundsCell = (mean: number | null, slices: number) =>
  slices === 0 ? 'None' : mean === null ? 'Unknown' : mean.toFixed(1);

/** `{accepted} of {settled}`, or `None` when no slice was settled. */
export const acceptedCell = (accepted: number, settled: number) =>
  settled === 0 ? 'None' : `${accepted} of ${settled}`;

/**
 * A role's allowance: the sum over one window, named from its ID, with the steps that had no
 * reading counted after it. With no figure it reads `Unknown`, whatever the count of steps.
 */
export function crewAllowanceCell(
  row: Pick<CrewResult, 'allowanceUsed' | 'allowanceWindow' | 'allowanceUnknown'>,
): string {
  if (row.allowanceUsed === null) return 'Unknown';
  const figure = percent(row.allowanceUsed);
  const named =
    row.allowanceWindow === null ? figure : `${windowLabel(row.allowanceWindow)}: ${figure}`;
  return row.allowanceUnknown > 0 ? `${named} (${row.allowanceUnknown} unknown)` : named;
}

/**
 * A recipe's allowance, one line for each provider and window. A percent of one window never adds
 * to a percent of another, and two windows whose names read alike stay two lines. A provider's
 * steps with no reading read as a count. With no rows the cell reads `Unknown`.
 */
export function recipeAllowanceLines(rows: RecipeResult['allowance']): string[] {
  if (rows.length === 0) return ['Unknown'];
  // Two windows of one provider that read alike would print as the same line twice, so each
  // of them adds its ID.
  const named = new Map<string, number>();
  for (const row of rows)
    if (row.window !== null) {
      const key = `${row.family}\u0000${windowLabel(row.window)}`;
      named.set(key, (named.get(key) ?? 0) + 1);
    }
  return rows.map((row) => {
    if (row.window === null)
      return `${familyName(row.family)}: ${row.steps} ${row.steps === 1 ? 'step' : 'steps'} unknown`;
    const label = windowLabel(row.window);
    const alike = (named.get(`${row.family}\u0000${label}`) ?? 0) > 1;
    return `${familyName(row.family)}, ${label}${alike ? ` (${row.window})` : ''}: ${percent(row.used)}`;
  });
}

/** The line under the heading: how many records and over which days. Empty with none. */
export function scopeLine(
  read: Pick<ResultsRead, 'records' | 'first' | 'last'>,
  date: (iso: string) => string,
): string | null {
  if (read.records === 0 || read.first === null || read.last === null) return null;
  return read.records === 1
    ? `1 record, ${date(read.last)}.`
    : `${read.records} records, ${date(read.first)} to ${date(read.last)}.`;
}

export const moreRecipesLine = (more: number) =>
  more === 1 ? '1 more recipe is not shown.' : `${more} more recipes are not shown.`;
export const moreRowsLine = (more: number) =>
  more === 1 ? '1 more row is not shown.' : `${more} more rows are not shown.`;

/** The line after an export: how many records the file holds and its name. */
export const exportedLine = (records: number, file: string) =>
  `Wrote ${records} ${records === 1 ? 'record' : 'records'} to ${file}.`;

/** True when nothing was recorded and no row would draw. */
export const isEmpty = (read: ResultsRead) =>
  read.records === 0 &&
  read.recipes.length === 0 &&
  read.crew.length === 0 &&
  read.moreRecipes === 0 &&
  read.moreCrew === 0;

export type RecipeRow = {
  key: string;
  /** A recipe that was forgotten has no name, and the table has a word for it. */
  name: string;
  runs: string;
  slices: string;
  passed: string;
  fixRounds: string;
  accepted: string;
  allowance: string[];
};

export const recipeRows = (rows: ResultsRead['recipes']): RecipeRow[] =>
  rows.map((row) => ({
    key: row.recipeId,
    name: row.name ?? 'Forgotten recipe',
    runs: String(row.runs),
    slices: slicesCell(row.slices),
    passed: passedCell(row.passedFirstReview, row.reviewed),
    fixRounds: fixRoundsCell(row.fixRounds, row.slices),
    accepted: acceptedCell(row.accepted, row.settled),
    allowance: recipeAllowanceLines(row.allowance),
  }));

export type CrewRow = {
  key: string;
  role: string;
  model: string;
  provider: string;
  effort: string;
  steps: string;
  slices: string;
  passed: string;
  fixRounds: string;
  accepted: string;
  allowance: string;
};

export const crewRows = (rows: ResultsRead['crew']): CrewRow[] =>
  rows.map((row) => ({
    key: [row.role, row.family, row.model, row.effort ?? ''].join('\u0000'),
    role: crewRoleNames[row.role],
    model: row.model,
    provider: familyName(row.family),
    // A record with no effort ran on the provider's own default.
    effort: row.effort === null ? 'Provider default' : effortLabel(row.effort),
    steps: String(row.steps),
    slices: slicesCell(row.slices),
    passed: passedCell(row.passedFirstReview, row.reviewed),
    fixRounds: fixRoundsCell(row.fixRounds, row.slices),
    accepted: acceptedCell(row.accepted, row.settled),
    allowance: crewAllowanceCell(row),
  }));
