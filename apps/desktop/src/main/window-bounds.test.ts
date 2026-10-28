import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BoundsStore, clampBounds, DEFAULT_SIZE, type Rectangle } from './window-bounds.ts';

const main: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
const side: Rectangle = { x: 1920, y: 0, width: 1280, height: 800 };

test('saved window bounds come back on a display that exists now', () => {
  const rows: [string, unknown, Rectangle[], object][] = [
    ['nothing saved', null, [main], DEFAULT_SIZE],
    ['not numbers', { x: 'a', y: 0, width: Number.NaN, height: 900 }, [main], DEFAULT_SIZE],
    ['no displays', { x: 0, y: 0, width: 1440, height: 900 }, [], DEFAULT_SIZE],
    [
      'fully on a display',
      { x: 100, y: 80, width: 1440, height: 900 },
      [main],
      { x: 100, y: 80, width: 1440, height: 900 },
    ],
    [
      'display unplugged',
      { x: 5000, y: 100, width: 1440, height: 900 },
      [main],
      { width: 1440, height: 900 },
    ],
    [
      'a sliver left on a display',
      { x: 1900, y: 100, width: 1440, height: 900 },
      [main],
      { width: 1440, height: 900 },
    ],
    [
      'partly off the right edge',
      { x: 1000, y: 50, width: 1440, height: 900 },
      [main],
      { x: 480, y: 50, width: 1440, height: 900 },
    ],
    [
      'a sliver above the bottom edge',
      { x: 0, y: 1040, width: 1440, height: 900 },
      [main],
      { width: 1440, height: 900 },
    ],
    [
      'larger than its display',
      { x: 0, y: 0, width: 5000, height: 3000 },
      [main],
      { x: 0, y: 0, width: 1920, height: 1080 },
    ],
    [
      'smaller than the minimum',
      { x: 10, y: 10, width: 300, height: 200 },
      [main],
      { x: 10, y: 10, width: 1080, height: 700 },
    ],
    [
      'moved to the smaller display',
      { x: 2000, y: 0, width: 1440, height: 900 },
      [main, side],
      { x: 1920, y: 0, width: 1280, height: 800 },
    ],
  ];
  for (const [name, saved, displays, expected] of rows)
    assert.deepEqual(clampBounds(saved, displays), expected, name);

  const profile = mkdtempSync(join(tmpdir(), 'crewkite-bounds-'));
  try {
    const store = new BoundsStore(profile);
    assert.equal(store.load(), null);
    store.save({ x: 12, y: 34, width: 1200, height: 800 });
    assert.deepEqual(store.load(), { x: 12, y: 34, width: 1200, height: 800 });
    writeFileSync(join(profile, 'window-bounds.json'), '{not json');
    assert.equal(store.load(), null);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
