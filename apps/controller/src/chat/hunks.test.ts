import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeHunks, hunkRanges, lineDiff, textLines } from './hunks.ts';

// Twenty numbered lines, so edits far apart land in separate hunks.
const base = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join('');
const edit = (text: string, changes: Record<number, string | null>) =>
  textLines(text)
    .flatMap((line, index) => {
      const change = changes[index + 1];
      return change === undefined ? [line] : change === null ? [] : [change];
    })
    .join('');

test('composing hunks gives the base with exactly the chosen hunks applied', () => {
  const copy = edit(base, { 2: 'line two\n', 10: null, 18: 'line 18\nadded\n' });
  const ops = lineDiff(textLines(base), textLines(copy));
  const hunks = hunkRanges(ops);
  assert.equal(hunks.length, 3, 'three edits seven lines apart make three hunks');
  const table: [string, number[], string][] = [
    ['no hunk is the base', [], base],
    ['every hunk is the copy', [0, 1, 2], copy],
    ['the first hunk alone', [0], edit(base, { 2: 'line two\n' })],
    ['the middle hunk alone', [1], edit(base, { 10: null })],
    ['the first and last hunks', [0, 2], edit(base, { 2: 'line two\n', 18: 'line 18\nadded\n' })],
  ];
  for (const [claim, chosen, expected] of table)
    assert.equal(composeHunks(ops, hunks, new Set(chosen)), expected, claim);
});

test('a hunk key stays the same when another hunk of the file is reverted', () => {
  const copy = edit(base, { 2: 'line two\n', 18: 'line eighteen\n' });
  const ops = lineDiff(textLines(base), textLines(copy));
  const [first, last] = hunkRanges(ops);
  const reverted = composeHunks(ops, [first, last], new Set([1]));
  const after = hunkRanges(lineDiff(textLines(base), textLines(reverted)));
  assert.deepEqual(
    after.map((hunk) => hunk.key),
    [last.key],
  );
});

test('a file without a final newline keeps its bytes through a partial compose', () => {
  const old = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj';
  const copy = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nJ';
  const ops = lineDiff(textLines(old), textLines(copy));
  const hunks = hunkRanges(ops);
  assert.equal(hunks.length, 2);
  assert.equal(composeHunks(ops, hunks, new Set([1])), 'a\nb\nc\nd\ne\nf\ng\nh\ni\nJ');
  assert.equal(composeHunks(ops, hunks, new Set([0])), 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj');
});
