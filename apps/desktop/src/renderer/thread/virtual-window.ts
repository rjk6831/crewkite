// Which rows of a long thread are mounted. Row heights are unknown until a row has been drawn, so
// every row has an estimate until it is measured, and the rows above and below the window stand
// in as two blocks of padding. Nothing here touches React or the DOM.

/** The space between two rows, as `.th-column` draws it. */
export const ROW_GAP = 20;
export const ESTIMATED_ROW_HEIGHT = 140;
/** Pixels of rows kept mounted above and below what shows. */
export const WINDOW_OVERSCAN = 900;
/** A thread with this many rows or fewer mounts them all, so a short thread draws as it always did. */
export const WINDOW_AFTER_ROWS = 60;

export type RowLayout = {
  /** `offsets[i]` is the top of row i in the window's own coordinates. `offsets[count]` is the end. */
  offsets: number[];
  total: number;
};

export type RowWindow = {
  /** The first mounted row. */
  start: number;
  /** One past the last mounted row. */
  end: number;
  /** Padding that stands in for the rows before `start`, and for the rows from `end` on. */
  before: number;
  after: number;
};

/** The top of every row, from the heights measured so far and an estimate for the rest. */
export function layoutRows(
  keys: readonly string[],
  measured: ReadonlyMap<string, number>,
  estimate = ESTIMATED_ROW_HEIGHT,
  gap = ROW_GAP,
): RowLayout {
  const offsets = new Array<number>(keys.length + 1);
  let top = 0;
  for (let index = 0; index < keys.length; index++) {
    offsets[index] = top;
    top += (measured.get(keys[index]) ?? estimate) + gap;
  }
  offsets[keys.length] = top;
  return { offsets, total: top };
}

/** The first index in [0, count] whose value passes `past`. The values only grow. */
function firstWhere(count: number, past: (index: number) => boolean): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (past(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The rows that overlap the view, with `overscan` pixels more on each side. `scrollTop` is the
 * view's top in the window's coordinates. A thread of `WINDOW_AFTER_ROWS` rows or fewer is one
 * window.
 */
export function rowWindow(
  layout: RowLayout,
  scrollTop: number,
  viewport: number,
  overscan = WINDOW_OVERSCAN,
  all = WINDOW_AFTER_ROWS,
): RowWindow {
  const count = layout.offsets.length - 1;
  if (count <= all) return { start: 0, end: count, before: 0, after: 0 };
  const top = scrollTop - overscan;
  const bottom = scrollTop + viewport + overscan;
  // The first row that ends below the top edge, and the first row that starts below the bottom.
  const start = Math.min(
    count - 1,
    firstWhere(count, (index) => layout.offsets[index + 1] > top),
  );
  const end = Math.max(
    start + 1,
    firstWhere(count, (index) => layout.offsets[index] >= bottom),
  );
  return {
    start,
    end,
    before: layout.offsets[start],
    after: end >= count ? 0 : layout.total - layout.offsets[end],
  };
}

/** The scroll position, in the window's coordinates, that puts row `index` at the top of the view. */
export function rowTop(layout: RowLayout, index: number): number {
  return layout.offsets[Math.max(0, Math.min(index, layout.offsets.length - 1))];
}
