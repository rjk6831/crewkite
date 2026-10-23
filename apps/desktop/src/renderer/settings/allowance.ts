import { type ChatCatalogRead, type ChatFamily, tightestAllowance } from '@crewkite/contracts';

export type RailRow = {
  family: ChatFamily;
  /** Whole percent left on the window with the least left. Null when no window reports one. */
  percent: number | null;
  /** Milliseconds until that window resets. Null when it has no reset time or the time has passed. */
  resetsIn: number | null;
  /** The reset time of that window is behind us, so the percent is the last one observed. */
  resetPassed: boolean;
  /** The family reports no allowance because it runs on this computer. */
  onDevice: boolean;
};

/**
 * One row per connected family, in catalog order. The figure is the contract's tightest window,
 * the one the model picker and the handoff offer use. A reset time that has passed is flagged
 * here only. The percent stays the last one observed.
 */
export function railRows(catalog: ChatCatalogRead | null, nowMs: number): RailRow[] {
  return (catalog?.families ?? [])
    .filter((entry) => entry.connected)
    .map((entry) => {
      const { percent, resetsAt } = tightestAllowance(entry);
      const until = resetsAt ? Date.parse(resetsAt) - nowMs : null;
      return {
        family: entry.family,
        percent: percent === null ? null : Math.floor(percent),
        resetsIn: until !== null && until > 0 ? until : null,
        resetPassed: until !== null && until <= 0,
        onDevice: entry.family === 'local' && entry.remaining.length === 0,
      };
    });
}
