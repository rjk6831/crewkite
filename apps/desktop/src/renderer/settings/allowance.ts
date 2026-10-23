import type { ChatCatalogRead, ChatFamily } from '@crewkite/contracts';

export type RailRow = {
  family: ChatFamily;
  /** Whole percent left on the window with the least left. Null when nothing usable is known. */
  percent: number | null;
  /** Milliseconds until that window resets. Null when the provider reported no reset. */
  resetsIn: number | null;
  /** The family reports no allowance because it runs on this computer. */
  onDevice: boolean;
};

/**
 * One row per connected family, in catalog order. A window whose reset time has passed says
 * nothing about now, so it counts as unknown until the next read.
 */
export function railRows(catalog: ChatCatalogRead | null, nowMs: number): RailRow[] {
  return (catalog?.families ?? [])
    .filter((entry) => entry.connected)
    .map((entry) => {
      const current = entry.remaining.flatMap((window) =>
        window.percent !== null && (window.resetsAt === null || Date.parse(window.resetsAt) > nowMs)
          ? [window]
          : [],
      );
      const tight = current.reduce<(typeof current)[number] | null>(
        (least, window) =>
          least && (least.percent ?? 100) <= (window.percent ?? 100) ? least : window,
        null,
      );
      return {
        family: entry.family,
        percent: tight?.percent === null || !tight ? null : Math.floor(tight.percent),
        resetsIn: tight?.resetsAt ? Date.parse(tight.resetsAt) - nowMs : null,
        onDevice: entry.family === 'local' && entry.remaining.length === 0,
      };
    });
}
