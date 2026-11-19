import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  PlanRecipesRead,
  PlanSchedulesRead,
  ProjectNotesRead,
  ResultsRead,
  WritingRulesRead,
} from '@crewkite/contracts';
import {
  type ContextParts,
  contextLine,
  contextTarget,
  graphsLine,
  hooksLine,
  loopsLine,
  newestOfPages,
  resultsLine,
  rowLine,
  type SetupLine,
} from './setup-model.ts';

// Claim: every row of the Project setup card says in words what is set up and what is missing,
// and its set-up flag agrees with the words. A stopped loop, an unsaved file or a design system no
// turn receives does not count as set up, the newest thread is named only once every page of a
// project's threads is in, and a failed read says so with the controller's sentence.

const when = (iso: string) => iso.slice(11, 16);
const day = (iso: string) => iso.slice(0, 10);

const rules = (on: number, exportOnlyOn = 0) =>
  ({
    rules: [
      ...Array.from({ length: 4 }, (_, index) => ({ enabled: index < on, surface: 'settings' })),
      ...Array.from({ length: 2 }, (_, index) => ({
        enabled: index < exportOnlyOn,
        surface: 'export-only',
      })),
    ],
  }) as WritingRulesRead;
const notes = (n: number) => ({ notes: Array.from({ length: n }, () => ({})) }) as ProjectNotesRead;
// A design system is sent to turns unless the version is negative, which here means saved and not
// sent.
const context = (
  on: number,
  design: number | null,
  kept: number,
  exportOnly = 0,
): ContextParts => ({
  rules: rules(on, exportOnly),
  design: design === null ? null : { version: Math.abs(design), sent: design > 0 },
  notes: notes(kept),
});
const schedules = (...rows: [string, string | null][]) =>
  ({
    schedules: rows.map(([state, nextAt]) => ({ schedule: { state, nextAt } })),
    more: 0,
  }) as PlanSchedulesRead;
// The controller lists every saved recipe before any file it never saved.
const recipes = (saved: number, unsaved: number, more = 0) =>
  ({
    recipes: [
      ...Array.from({ length: saved }, () => ({ record: {} })),
      ...Array.from({ length: unsaved }, () => ({ record: null })),
    ],
    more,
  }) as PlanRecipesRead;
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => ({
    id: `tsk_0${String(from + index).padStart(25, '0')}`,
  }));
// Threads 1 to `total`, oldest first, in pages of `size`, as the controller sends them.
const paged = (total: number, size = 50) => {
  const page = (after: number, limit: number) => {
    const last = Math.min(total, after + limit);
    return { tasks: ids(after + 1, last), next: last < total ? last : null };
  };
  const asked: number[] = [];
  return {
    first: page(0, size),
    more: async (after: number, limit: number) => {
      asked.push(limit);
      return page(after, limit);
    },
    asked,
  };
};
const results = (records: number, last: string | null) => ({ records, last }) as ResultsRead;

test('each setup row says what is set up and what is missing', async () => {
  const rows: [string, SetupLine, string, boolean][] = [
    [
      'context, nothing',
      contextLine(context(0, null, 0)),
      'No writing rules, design system or notes yet.',
      false,
    ],
    [
      'context, export-only rules are not sent with a turn',
      contextLine(context(0, null, 0, 2)),
      'No writing rules, design system or notes yet.',
      false,
    ],
    [
      'context, every part',
      contextLine(context(3, 4, 2)),
      '3 writing rules on for every project. Design system version 4. 2 project notes.',
      true,
    ],
    [
      'context, one of each',
      contextLine(context(1, 1, 1)),
      '1 writing rule on for every project. Design system version 1. 1 project note.',
      true,
    ],
    [
      'context, a design system no turn receives does not count',
      contextLine(context(0, -3, 0)),
      'Design system version 3 is saved and not sent.',
      false,
    ],
    [
      'context, rules and a design system no turn receives',
      contextLine(context(2, -3, 0)),
      '2 writing rules on for every project. Design system version 3 is saved and not sent.',
      true,
    ],
    [
      'context, a design system with no rules',
      contextLine(context(0, 2, 0)),
      'Design system version 2.',
      true,
    ],
    [
      'hooks, no thread',
      hooksLine({ thread: null, checks: null, design: true, over: false }),
      "No threads yet. Checks are turned on in a thread's Crew tab.",
      false,
    ],
    [
      'hooks, a thread with no check on',
      hooksLine({ thread: 'a', checks: 0, design: true, over: false }),
      "No checks are on in the newest thread. Turn them on in a thread's Crew tab.",
      false,
    ],
    [
      'hooks, one check',
      hooksLine({ thread: 'a', checks: 1, design: false, over: false }),
      '1 check on in the newest thread.',
      true,
    ],
    [
      'hooks, checks and a design system',
      hooksLine({ thread: 'a', checks: 2, design: true, over: false }),
      '2 checks on in the newest thread. The design check can run.',
      true,
    ],
    [
      'hooks, more threads than the card reads',
      hooksLine({ thread: null, checks: null, design: true, over: true }),
      "This project has more than 1,000 threads. Open a thread's Crew tab to see its checks.",
      false,
    ],
    ['loops, none', loopsLine(schedules(), when), 'No loops.', false],
    [
      'loops, more than the read holds',
      loopsLine({ ...schedules(['paused', null]), more: 3 }, when),
      '1 paused. 3 more loops are not shown.',
      true,
    ],
    [
      'loops, one past the bound',
      loopsLine({ ...schedules(['stopped', null]), more: 1 }, when),
      '1 stopped. 1 more loop is not shown.',
      false,
    ],
    [
      'loops, every state, the soonest run named',
      loopsLine(
        schedules(
          ['active', '2026-11-20T18:30:00.000Z'],
          ['active', '2026-11-20T09:15:00.000Z'],
          ['paused', null],
          ['stopped', null],
        ),
        when,
      ),
      '2 active. 1 paused. 1 stopped. Next run 09:15.',
      true,
    ],
    [
      'loops, active with no next run waits for a reset',
      loopsLine(schedules(['active', null]), when),
      '1 active.',
      true,
    ],
    [
      'loops, a paused loop names no next run',
      loopsLine(schedules(['paused', '2026-11-20T09:15:00.000Z']), when),
      '1 paused.',
      true,
    ],
    [
      'loops, stopped only',
      loopsLine(schedules(['stopped', null], ['stopped', null]), when),
      '2 stopped.',
      false,
    ],
    ['graphs, none', graphsLine(recipes(0, 0)), 'No recipes yet.', false],
    ['graphs, one recipe', graphsLine(recipes(1, 0)), '1 recipe.', true],
    [
      'graphs, recipes and files waiting',
      graphsLine(recipes(3, 2)),
      '3 recipes. 2 files not saved as recipes yet.',
      true,
    ],
    [
      'graphs, one unsaved file only',
      graphsLine(recipes(0, 1)),
      '1 file not saved as a recipe yet.',
      false,
    ],
    [
      'graphs, what is past a list of saved recipes may be either',
      graphsLine(recipes(64, 0, 6)),
      '64 recipes. 6 more recipes or files not saved yet.',
      true,
    ],
    [
      'graphs, one past the bound',
      graphsLine(recipes(64, 0, 1)),
      '64 recipes. 1 more recipe or file not saved yet.',
      true,
    ],
    [
      'graphs, files past the bound once the list reaches them',
      graphsLine(recipes(60, 4, 5)),
      '60 recipes. 9 files not saved as recipes yet.',
      true,
    ],
    ['results, none', resultsLine(results(0, null), day), 'No results yet.', false],
    [
      'results, one step',
      resultsLine(results(1, '2026-11-17T15:30:00.000Z'), day),
      '1 step recorded, 2026-11-17.',
      true,
    ],
    [
      'results, many steps',
      resultsLine(results(43, '2026-11-17T15:30:00.000Z'), day),
      '43 steps recorded, the newest 2026-11-17.',
      true,
    ],
    ['any row, reading', rowLine({ state: 'reading' }, graphsLine), 'Reading.', false],
    [
      'any row, a failed read',
      rowLine({ state: 'failed', reason: 'Controller is offline.' }, graphsLine),
      'Could not be read. Controller is offline.',
      false,
    ],
    [
      'any row, a failed read with no sentence',
      rowLine({ state: 'failed', reason: '' }, graphsLine),
      'Could not be read.',
      false,
    ],
    [
      'any row, read',
      rowLine({ state: 'read', value: recipes(2, 0) }, graphsLine),
      '2 recipes.',
      true,
    ],
  ];
  for (const [name, actual, line, set] of rows) assert.deepEqual(actual, { line, set }, name);

  // The Context button goes to the first part that is missing, and to the design system when none is.
  const targets: [ContextParts, string][] = [
    [context(0, null, 0), 'design'],
    [context(3, 4, 0), 'notes'],
    [context(0, 4, 2), 'rules'],
    // Notes come before rules when both are missing.
    [context(0, 4, 0), 'notes'],
    // A design system no turn receives comes first, before missing notes.
    [context(3, -4, 0), 'design'],
    [context(3, 4, 2), 'design'],
  ];
  for (const [parts, target] of targets)
    assert.equal(contextTarget(parts), target, JSON.stringify(parts.design));

  // The newest thread is the largest ID of the last page, never of the first page alone, and a
  // project past the bound names none and reads no further than the bound.
  const sixty = paged(60);
  assert.deepEqual(await newestOfPages(sixty.first, sixty.more), {
    thread: ids(60, 60)[0]?.id,
    over: false,
  });
  const fifty = paged(50);
  assert.deepEqual(await newestOfPages(fifty.first, fifty.more), {
    thread: ids(50, 50)[0]?.id,
    over: false,
  });
  assert.deepEqual(fifty.asked, []);
  const many = paged(1001);
  assert.deepEqual(await newestOfPages(many.first, many.more), { thread: null, over: true });
  assert.equal(50 + many.asked.reduce((sum, n) => sum + n, 0), 1000);
  const thousand = paged(1000);
  assert.deepEqual(await newestOfPages(thousand.first, thousand.more), {
    thread: ids(1000, 1000)[0]?.id,
    over: false,
  });
});
