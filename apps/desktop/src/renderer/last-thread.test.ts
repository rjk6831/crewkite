import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Opening, openingThread, parseLastThread } from './last-thread.ts';

const older = `tsk_${'0'.repeat(25)}1`;
const kept = `tsk_${'0'.repeat(25)}2`;
const first = 'prj_first';
const second = 'prj_second';

test('launch opens the thread open at quit when its project page has it, and the first thread otherwise', () => {
  const saved = JSON.stringify({ projectId: second, taskId: kept });
  const firstPage = { tasks: [{ id: older }] };
  const secondPage = { tasks: [{ id: kept }] };
  const rows: [
    string,
    string | null,
    Parameters<typeof openingThread>[0]['pages'],
    string[],
    boolean,
    string[],
    Opening,
  ][] = [
    [
      'saved thread loaded',
      saved,
      { [first]: firstPage, [second]: secondPage },
      [first, second],
      false,
      [],
      { kind: 'select', taskId: kept },
    ],
    [
      'saved project page not read yet',
      saved,
      { [first]: firstPage },
      [first, second],
      false,
      [],
      { kind: 'load', projectId: second },
    ],
    [
      'saved project page failed to read',
      saved,
      { [first]: firstPage },
      [first, second],
      true,
      [],
      { kind: 'select', taskId: older },
    ],
    [
      'saved thread deleted',
      saved,
      { [first]: firstPage, [second]: secondPage },
      [first, second],
      false,
      [kept],
      { kind: 'select', taskId: older },
    ],
    [
      'saved project gone, as in another home',
      saved,
      { [first]: firstPage },
      [first],
      false,
      [],
      { kind: 'select', taskId: older },
    ],
    [
      'saved thread no longer in its project',
      saved,
      { [first]: firstPage, [second]: { tasks: [] } },
      [first, second],
      false,
      [],
      { kind: 'select', taskId: older },
    ],
    [
      'nothing saved',
      null,
      { [first]: firstPage },
      [first, second],
      false,
      [],
      { kind: 'select', taskId: older },
    ],
    [
      'unreadable record',
      '{"taskId":7',
      { [first]: firstPage },
      [first, second],
      false,
      [],
      { kind: 'select', taskId: older },
    ],
    ['no threads yet', null, {}, [first], false, [], { kind: 'none' }],
  ];
  for (const [name, record, pages, projectIds, unreadable, removed, expected] of rows)
    assert.deepEqual(
      openingThread({
        last: parseLastThread(record),
        projectIds,
        pages,
        removed: new Set(removed),
        unreadable,
      }),
      expected,
      name,
    );
});
