import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatHunk } from '@crewkite/contracts';
import { patchBlocks, pickedRange } from './hunk-lines.ts';

const hunk = (oldStart: number, newStart: number): ChatHunk => ({
  key: 'a'.repeat(64),
  oldStart,
  oldLines: 0,
  newStart,
  newLines: 0,
  decision: 'undecided',
});

test('hunk lines carry the base and copy numbers a comment names', () => {
  const patch = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -7,4 +7,4 @@',
    ' line 7',
    '-line 8',
    '+line eight',
    ' line 9',
    '@@ -20,2 +20,3 @@',
    ' line 20',
    '+added',
    ' line 21',
    '',
  ].join('\n');
  const [first, second] = patchBlocks(patch, [hunk(7, 7), hunk(20, 20)]);
  assert.deepEqual(
    first.map((line) => [line.old, line.next]),
    [
      [7, 7],
      [8, null],
      [null, 8],
      [9, 9],
    ],
  );
  assert.deepEqual(second[1], { text: '+added', old: null, next: 21 });
  const table: [string, number, number, ReturnType<typeof pickedRange>][] = [
    ['one copy line', 2, 2, { side: 'new', start: 8, end: 8 }],
    ['a removed line alone names the base', 1, 1, { side: 'old', start: 8, end: 8 }],
    ['a pick made upward reads the same', 3, 0, { side: 'new', start: 7, end: 9 }],
    ['a removed and an added line name the copy line', 1, 2, { side: 'new', start: 8, end: 8 }],
  ];
  for (const [claim, from, to, expected] of table)
    assert.deepEqual(pickedRange(first, from, to), expected, claim);
});
