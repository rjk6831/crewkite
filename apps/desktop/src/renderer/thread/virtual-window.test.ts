import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ESTIMATED_ROW_HEIGHT,
  layoutRows,
  mountPlan,
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

test('a pinned row stays mounted far outside the window, and the padding still adds up', () => {
  const heights = new Map(keys(2000).map((key, index) => [key, 60 + (index % 5) * 30] as const));
  const layout = layoutRows(keys(2000), heights);
  const window = rowWindow(layout, 1000 * 200, 800);
  const rows: [string, number[]][] = [
    ['no pins', []],
    ['one row far above', [3]],
    ['one row far below', [1900]],
    ['rows on both sides and one inside the window', [0, window.start + 2, 1999]],
    ['a pin outside the thread is ignored', [-4, 5000]],
  ];
  for (const [claim, pinned] of rows) {
    const plan = mountPlan(layout, window, pinned);
    const drawn = plan.flatMap((item) => (item.kind === 'row' ? [item.index] : []));
    for (const index of pinned)
      if (index >= 0 && index < 2000) assert.ok(drawn.includes(index), claim);
    for (let index = window.start; index < window.end; index++) assert.ok(drawn.includes(index));
    assert.deepEqual(
      drawn,
      [...drawn].sort((a, b) => a - b),
      `${claim}: rows stay in order`,
    );
    assert.equal(new Set(drawn).size, drawn.length, `${claim}: a row is drawn once`);
    assert.ok(drawn.length < window.end - window.start + 4, `${claim}: only the pins are added`);
    assert.ok(
      plan.every((item, at) => item.kind !== 'pad' || plan[at - 1]?.kind !== 'pad'),
      `${claim}: no two blocks of padding in a row`,
    );
    // With a gap beside every item, the plan stands for the thread's whole height.
    const height = plan.reduce(
      (sum, item) =>
        sum +
        (item.kind === 'pad'
          ? item.height
          : (heights.get(`row-${item.index}`) ?? ESTIMATED_ROW_HEIGHT)),
      ROW_GAP * (plan.length - 1),
    );
    assert.equal(height, layout.total - ROW_GAP, claim);
  }
  // The rows in the window and nothing else is what the window alone gives.
  assert.deepEqual(
    mountPlan(layout, window).filter((item) => item.kind === 'row').length,
    window.end - window.start,
  );
  // A short thread has nothing to pad.
  const short = layoutRows(keys(10), new Map());
  assert.deepEqual(
    mountPlan(short, rowWindow(short, 0, 800), [4]).map((item) => item.kind),
    Array(10).fill('row'),
  );
});

test('rowTop gives the scroll position of a row and clamps an index outside the thread', () => {
  const layout = layoutRows(keys(100), new Map(), 100, 10);
  assert.equal(rowTop(layout, 0), 0);
  assert.equal(rowTop(layout, 3), 330);
  assert.equal(rowTop(layout, -4), 0);
  assert.equal(rowTop(layout, 9999), layout.total);
});
