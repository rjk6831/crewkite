import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandResult } from '@crewkite/contracts';
import { exportResults, type ResultsPageRequest } from './results.ts';

// Claim: the exported file holds every record and every run the controller has, each in the order
// it was read, with records and runs never mixed.

const PROJECT = 'prj_0000000000000000000000000A';

test('an export follows every page and keeps records and runs apart', async () => {
  const pages: Record<string, { items: string[]; next: string | null }> = {
    'records:': { items: ['r1', 'r2'], next: 'c1' },
    'records:c1': { items: ['r3'], next: 'c2' },
    'records:c2': { items: ['r4', 'r5'], next: null },
    'runs:': { items: ['u1'], next: 'd1' },
    'runs:d1': { items: ['u2'], next: null },
  };
  const asked: ResultsPageRequest[] = [];
  const send = async (request: ResultsPageRequest): Promise<CommandResult> => {
    asked.push(request);
    const page = pages[`${request.part}:${request.before ?? ''}`];
    assert.ok(page, `unexpected page ${request.part} ${request.before}`);
    const items = page.items.map((id) => ({ id }));
    return {
      outcome: 'applied',
      data: {
        kind: 'results-export',
        schema: 1,
        projectId: PROJECT,
        part: request.part,
        records: request.part === 'records' ? items : [],
        runs: request.part === 'runs' ? items : [],
        next: page.next,
      },
    } as unknown as CommandResult;
  };
  let ticks = 0;
  const now = () => new Date(Date.UTC(2026, 10, 19, 12, 0, ticks++));

  const file = await exportResults(send, { projectId: PROJECT, recipeId: 'rcp_x' }, now);

  assert.deepEqual(
    asked.map((request) => `${request.part}:${request.before ?? ''}`),
    ['records:', 'records:c1', 'records:c2', 'runs:', 'runs:d1'],
  );
  assert.ok(asked.every((request) => request.recipeId === 'rcp_x'));
  assert.deepEqual(file, {
    schema: 1,
    projectId: PROJECT,
    exportedAt: '2026-11-19T12:00:00.000Z',
    records: ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({ id })),
    runs: ['u1', 'u2'].map((id) => ({ id })),
  });
  assert.equal(ticks, 1, 'the time is read once');

  // Each failure reads as a sentence. A cursor given twice ends the export after the second
  // page, and the counter keeps a broken guard from looping for good.
  const answer = (request: ResultsPageRequest, change: Record<string, unknown> = {}) =>
    ({
      outcome: 'applied',
      data: {
        kind: 'results-export',
        schema: 1,
        projectId: PROJECT,
        part: request.part,
        records: [],
        runs: [],
        next: 'same',
        ...change,
      },
    }) as unknown as CommandResult;
  const failing = (make: (request: ResultsPageRequest) => CommandResult) => {
    const calls = { count: 0 };
    return {
      calls,
      send: async (request: ResultsPageRequest) => {
        calls.count += 1;
        if (calls.count > 6) throw new Error('read for good');
        return make(request);
      },
    };
  };
  const unreadable = /^Error: CrewKite could not read the results\.$/;
  const loop = failing((request) => answer(request));
  await assert.rejects(exportResults(loop.send, { projectId: PROJECT }, now), unreadable);
  assert.equal(loop.calls.count, 2);
  // A page for another project, or for the other part, is not taken.
  const other = failing((request) =>
    answer(request, { projectId: 'prj_0000000000000000000000000B', next: null }),
  );
  await assert.rejects(exportResults(other.send, { projectId: PROJECT }, now), unreadable);
  const swapped = failing((request) =>
    answer(request, { part: request.part === 'runs' ? 'records' : 'runs', next: null }),
  );
  await assert.rejects(exportResults(swapped.send, { projectId: PROJECT }, now), unreadable);
  assert.equal(other.calls.count + swapped.calls.count, 2);
  // A refused page throws the controller's sentence, else the table's. No reason code reaches a person.
  const refused = async (): Promise<CommandResult> =>
    ({ outcome: 'blocked', reason: 'read-unavailable', next: 'Inspect it.' }) as CommandResult;
  await assert.rejects(
    exportResults(refused, { projectId: PROJECT }, now),
    /^Error: Inspect it\.$/,
  );
  const silent = async (): Promise<CommandResult> =>
    ({ outcome: 'blocked', reason: 'read-unavailable' }) as CommandResult;
  await assert.rejects(exportResults(silent, { projectId: PROJECT }, now), unreadable);
});
