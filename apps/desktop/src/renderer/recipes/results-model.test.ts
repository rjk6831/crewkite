import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResultsRead } from '@crewkite/contracts';
import {
  acceptedCell,
  crewAllowanceCell,
  crewRows,
  exportedLine,
  fixRoundsCell,
  isEmpty,
  moreRecipesLine,
  moreRowsLine,
  passedCell,
  percent,
  recipeAllowanceLines,
  recipeRows,
  scopeLine,
  slicesCell,
} from './results-model.ts';

// Claim: each cell says what was counted. Nothing reviewed or settled reads None, a value nobody
// observed reads Unknown, a percent never adds across windows, and nothing is judged.

const day = (iso: string) => iso.slice(0, 10);
const mint = (n: number) => `rcp_0${String(n).padStart(25, '0')}`;

test('each results cell says what was counted and says Unknown where nothing was', () => {
  // The cells, one row for each case.
  const cells: [string, string, string][] = [
    ['slices, none', slicesCell(0), 'None'],
    ['slices, some', slicesCell(4), '4'],
    ['passed, none reviewed', passedCell(0, 0), 'None'],
    ['passed, none clean', passedCell(0, 3), '0 of 3'],
    ['passed, some', passedCell(5, 8), '5 of 8'],
    ['fix rounds, no slice', fixRoundsCell(null, 0), 'None'],
    ['fix rounds, no mean', fixRoundsCell(null, 2), 'Unknown'],
    ['fix rounds, mean to one decimal', fixRoundsCell(1.3333, 3), '1.3'],
    ['fix rounds, zero mean', fixRoundsCell(0, 3), '0.0'],
    ['accepted, none settled', acceptedCell(0, 0), 'None'],
    ['accepted, none of some', acceptedCell(0, 2), '0 of 2'],
    ['accepted, some', acceptedCell(6, 7), '6 of 7'],
    ['percent below 10', percent(2.54), '2.5%'],
    ['percent zero', percent(0), '0.0%'],
    ['percent from 10', percent(22.6), '23%'],
    ['percent that rounds up to 10', percent(9.96), '10%'],
    [
      'allowance, no figure',
      crewAllowanceCell({ allowanceUsed: null, allowanceWindow: null, allowanceUnknown: 4 }),
      'Unknown',
    ],
    [
      'allowance, whole',
      crewAllowanceCell({ allowanceUsed: 11.8, allowanceWindow: 'five-hour', allowanceUnknown: 0 }),
      'Five-hour: 12%',
    ],
    [
      'allowance, some steps unknown',
      crewAllowanceCell({ allowanceUsed: 2.5, allowanceWindow: 'weekly', allowanceUnknown: 3 }),
      'Weekly: 2.5% (3 unknown)',
    ],
    [
      'scope, none',
      scopeLine({ records: 0, first: null, last: null }, day) ?? 'no line',
      'no line',
    ],
    [
      'scope, one',
      scopeLine({ records: 1, first: '2026-10-02T09:00:00Z', last: '2026-10-02T09:00:00Z' }, day) ??
        '',
      '1 record, 2026-10-02.',
    ],
    [
      'scope, many',
      scopeLine(
        { records: 43, first: '2026-10-02T09:00:00Z', last: '2026-11-17T15:30:00Z' },
        day,
      ) ?? '',
      '43 records, 2026-10-02 to 2026-11-17.',
    ],
    ['more recipes, one', moreRecipesLine(1), '1 more recipe is not shown.'],
    ['more recipes, many', moreRecipesLine(3), '3 more recipes are not shown.'],
    ['more rows, one', moreRowsLine(1), '1 more row is not shown.'],
    ['more rows, many', moreRowsLine(40), '40 more rows are not shown.'],
    ['export line, one record', exportedLine(1, 'a.json'), 'Wrote 1 record to a.json.'],
    [
      'export line',
      exportedLine(12, 'crewkite-results.json'),
      'Wrote 12 records to crewkite-results.json.',
    ],
  ];
  for (const [name, got, want] of cells) assert.equal(got, want, name);

  // A recipe's allowance keeps one line for each provider and window. Two windows with the same
  // name stay two lines, steps with no reading read as a count, and no row reads Unknown.
  assert.deepEqual(recipeAllowanceLines([]), ['Unknown']);
  assert.deepEqual(
    recipeAllowanceLines([
      { family: 'openai', window: 'weekly', used: 22.6, steps: 9 },
      { family: 'openai', window: null, used: 0, steps: 3 },
      { family: 'anthropic', window: null, used: 0, steps: 1 },
      { family: 'google', window: 'weekly', used: 4, steps: 2 },
      { family: 'google', window: 'gemini-weekly', used: 5, steps: 2 },
    ]),
    [
      'OpenAI, Weekly: 23%',
      'OpenAI: 3 steps unknown',
      'Anthropic: 1 step unknown',
      'Google, Weekly (weekly): 4.0%',
      'Google, Weekly (gemini-weekly): 5.0%',
    ],
  );

  // Whole rows. A forgotten recipe has no name. A role that only ran plan steps has no slice, so
  // its slice cells read None and never a zero.
  const tally = {
    slices: 0,
    reviewed: 0,
    passedFirstReview: 0,
    fixRounds: null,
    settled: 0,
    accepted: 0,
  };
  const read = {
    recipes: [
      { recipeId: mint(1), name: null, runs: 1, ...tally, slices: 2, fixRounds: 0, allowance: [] },
    ],
    crew: [
      {
        role: 'challenger',
        family: 'google',
        model: 'large-3',
        effort: null,
        steps: 3,
        ...tally,
        allowanceUsed: null,
        allowanceWindow: null,
        allowanceUnknown: 3,
      },
      {
        role: 'builder',
        family: 'openai',
        model: 'large-1',
        effort: 'high',
        steps: 2,
        ...tally,
        slices: 2,
        reviewed: 2,
        passedFirstReview: 1,
        fixRounds: 0.5,
        settled: 2,
        accepted: 2,
        allowanceUsed: 7,
        allowanceWindow: 'weekly',
        allowanceUnknown: 0,
      },
    ],
  } as unknown as ResultsRead;
  assert.deepEqual(recipeRows(read.recipes), [
    {
      key: mint(1),
      name: 'Forgotten recipe',
      runs: '1',
      slices: '2',
      passed: 'None',
      fixRounds: '0.0',
      accepted: 'None',
      allowance: ['Unknown'],
    },
  ]);
  assert.deepEqual(
    crewRows(read.crew).map(({ key: _key, ...row }) => row),
    [
      {
        role: 'Challenger',
        model: 'large-3',
        provider: 'Google',
        effort: 'Provider default',
        steps: '3',
        slices: 'None',
        passed: 'None',
        fixRounds: 'None',
        accepted: 'None',
        allowance: 'Unknown',
      },
      {
        role: 'Builder',
        model: 'large-1',
        provider: 'OpenAI',
        effort: 'High',
        steps: '2',
        slices: '2',
        passed: '1 of 2',
        fixRounds: '0.5',
        accepted: '2 of 2',
        allowance: 'Weekly: 7.0%',
      },
    ],
  );
  const keys = crewRows(read.crew).map(({ key }) => key);
  assert.equal(new Set(keys).size, keys.length);

  // Nothing recorded and no row to draw is the empty state. A recipe with a run and no record is not.
  const none = {
    projectId: 'prj_x',
    records: 0,
    first: null,
    last: null,
    recipes: [],
    crew: [],
    moreRecipes: 0,
    moreCrew: 0,
  } as unknown as ResultsRead;
  assert.equal(isEmpty(none), true);
  assert.equal(isEmpty({ ...none, recipes: read.recipes }), false);
  // Role rows alone are not empty either, and a row that ran slices with no review reads None for
  // the review cell and still shows its mean and its accepted count.
  assert.equal(isEmpty({ ...none, crew: read.crew }), false);
  const unreviewed = crewRows([
    {
      role: 'builder',
      family: 'openai',
      model: 'large-1',
      effort: 'medium',
      steps: 3,
      slices: 3,
      reviewed: 0,
      passedFirstReview: 0,
      fixRounds: 1.5,
      settled: 2,
      accepted: 1,
      allowanceUsed: null,
      allowanceWindow: null,
      allowanceUnknown: 3,
    },
  ] as unknown as ResultsRead['crew'])[0];
  assert.deepEqual(
    [unreviewed.slices, unreviewed.passed, unreviewed.fixRounds, unreviewed.accepted],
    ['3', 'None', '1.5', '1 of 2'],
  );
});
