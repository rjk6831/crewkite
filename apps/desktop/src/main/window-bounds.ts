import { closeSync, constants, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export type Rectangle = { x: number; y: number; width: number; height: number };
export type PlacedBounds = { x?: number; y?: number; width: number; height: number };

export const DEFAULT_SIZE = { width: 1440, height: 900 };
export const MINIMUM_SIZE = { width: 1080, height: 700 };
// A window with less than this much of itself on a display cannot be grabbed, so it is moved.
const GRAB = { width: 160, height: 80 };

const overlap = (a: Rectangle, b: Rectangle) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Turns saved bounds into bounds that show on a display that exists now. The size is kept within
 * the minimum and the best display. A position that no longer reaches a display is dropped, so
 * the system centers the window. A position that partly reaches one is pulled inside it.
 */
export function clampBounds(saved: unknown, displays: Rectangle[]): PlacedBounds {
  const area = displays[0];
  if (!area || !saved || typeof saved !== 'object') return { ...DEFAULT_SIZE };
  const value = saved as Record<string, unknown>;
  const number = (key: string) => {
    const item = value[key];
    return typeof item === 'number' && Number.isFinite(item) ? Math.round(item) : null;
  };
  const x = number('x');
  const y = number('y');
  const width = number('width');
  const height = number('height');
  if (width === null || height === null) return { ...DEFAULT_SIZE };
  const target =
    x === null || y === null
      ? area
      : displays.reduce((best, item) =>
          overlap({ x, y, width, height }, item) > overlap({ x, y, width, height }, best)
            ? item
            : best,
        );
  const size = {
    width: Math.min(
      Math.max(width, MINIMUM_SIZE.width),
      Math.max(target.width, MINIMUM_SIZE.width),
    ),
    height: Math.min(
      Math.max(height, MINIMUM_SIZE.height),
      Math.max(target.height, MINIMUM_SIZE.height),
    ),
  };
  if (x === null || y === null) return size;
  const reach = { x, y, ...size };
  const shown = Math.min(GRAB.width, size.width);
  const high = Math.min(GRAB.height, size.height);
  const visibleWide =
    Math.min(reach.x + size.width, target.x + target.width) - Math.max(reach.x, target.x);
  const visibleHigh =
    Math.min(reach.y + size.height, target.y + target.height) - Math.max(reach.y, target.y);
  if (visibleWide < shown || visibleHigh < high) return size;
  return {
    ...size,
    x: Math.min(Math.max(x, target.x), target.x + target.width - size.width),
    y: Math.min(Math.max(y, target.y), target.y + target.height - size.height),
  };
}

/** Window size and position, one small file in the desktop profile. */
export class BoundsStore {
  private readonly path: string;
  constructor(profile: string) {
    this.path = join(profile, 'window-bounds.json');
  }
  load(): unknown {
    try {
      const text = readFileSync(this.path, { encoding: 'utf8' });
      return text.length <= 1024 ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
  save(bounds: Rectangle) {
    const next = `${this.path}.next`;
    try {
      const file = openSync(
        next,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
        0o600,
      );
      try {
        writeSync(
          file,
          JSON.stringify({
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          }),
        );
      } finally {
        closeSync(file);
      }
      renameSync(next, this.path);
    } catch {}
  }
}
