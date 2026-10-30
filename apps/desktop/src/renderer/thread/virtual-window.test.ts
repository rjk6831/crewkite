import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ESTIMATED_ROW_HEIGHT,
  layoutRows,
  ROW_GAP,
  rowTop,
  rowWindow,
  WINDOW_AFTER_ROWS,
} from './virtual-window.ts';

const keys = (count: number) => Array.from({ length: count }, (_, index) => `row-${index}`);

test('layout uses the measured height of a row and the estimate for the rest', () => {
  const layout = layoutRows(['a', 'b', 'c'], new Map([['b', 300]]), 100, 10);
  assert.deepEqual(layout.offsets, [0, 110, 420, 530]);
  assert.equal(layout.total, 530);
  assert.deepEqual(layoutRows([], new Map()).offsets, [0]);
});

test('a short thread mounts every row, whatever the scroll position', () => {
  for (const count of [0, 1, 10, WINDOW_AFTER_ROWS]) {
    const layout = layoutRows(keys(count), new Map());
    for (const top of [0, 500, 1e6]) {
      const window = rowWindow(layout, top, 800);
      assert.deepEqual(window, { start: 0, end: count, before: 0, after: 0 }, `${count} rows`);
    }
  }
});

test('a 2000 row window holds the rows in view and the padding keeps the full height', () => {
  const layout = layoutRows(keys(2000), new Map());
  const row = ESTIMATED_ROW_HEIGHT + ROW_GAP;
  const viewport = 800;
  // Top, middle, end, and a position past the end that a stale scroll event can report.
  const rows: [string, number][] = [
    ['top', 0],
    ['middle', 1000 * row + 37],
    ['end', layout.total - viewport],
    ['past the end', layout.total + 5000],
  ];
  for (const [name, top] of rows) {
    const window = rowWindow(layout, top, viewport);
    assert.ok(window.end > window.start, name);
    assert.ok(window.end - window.start < 60, `${name}: ${window.end - window.start} rows`);
    assert.equal(window.before, layout.offsets[window.start], name);
    // The mounted rows and the two blocks of padding add up to the thread's height, which is its
    // rows and the gaps between them.
    const mounted = layout.offsets[window.end] - layout.offsets[window.start] - ROW_GAP;
    assert.equal(window.before + mounted + window.after, layout.total - ROW_GAP, name);
  }
});

test('rows that overlap the view are always mounted, with the overscan on both sides', () => {
  const heights = new Map(keys(500).map((key, index) => [key, 50 + (index % 7) * 40] as const));
  const layout = layoutRows(keys(500), heights);
  const viewport = 700;
  const overscan = 300;
  for (let top = 0; top < layout.total; top += 997) {
    const window = rowWindow(layout, top, viewport, overscan);
    for (let index = 0; index < 500; index++) {
      const start = layout.offsets[index];
      const end = layout.offsets[index + 1] - ROW_GAP;
      const overlaps = end > top - overscan && start < top + viewport + overscan;
      const mounted = index >= window.start && index < window.end;
      if (overlaps) assert.ok(mounted, `row ${index} overlaps the view at ${top}`);
      if (start >= top + viewport + overscan + ROW_GAP + 1000) assert.ok(!mounted, `row ${index}`);
    }
  }
});

test('rowTop gives the scroll position of a row and clamps an index outside the thread', () => {
  const layout = layoutRows(keys(100), new Map(), 100, 10);
  assert.equal(rowTop(layout, 0), 0);
  assert.equal(rowTop(layout, 3), 330);
  assert.equal(rowTop(layout, -4), 0);
  assert.equal(rowTop(layout, 9999), layout.total);
});
