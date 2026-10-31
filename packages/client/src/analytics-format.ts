import type { AnalyticsAllowance } from '@crewkite/contracts';

// Plain words for the numbers of a usage read, shared by the desktop and the command line. A value
// the client did not report reads as unknown, and a sum over some of the turns says which.

export function wallText(ms: number | null): string {
  if (ms === null) return 'unknown';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const countText = (value: number | null): string =>
  value === null ? 'unknown' : value.toLocaleString('en-US');

/** A token sum with the number of turns that reported it, as in `1,500 (2 of 5 turns)`. */
export function tokensText(sum: number | null, reportedTurns: number, turns: number): string {
  if (sum === null) return 'unknown';
  return reportedTurns === turns
    ? countText(sum)
    : `${countText(sum)} (${reportedTurns} of ${turns} turns)`;
}

/** What a window lost, as in `five-hour: 4 percent used, 1 of 3 turns measured`. */
export function allowanceText(entry: AnalyticsAllowance): string {
  const turns = entry.measuredTurns + entry.unmeasuredTurns;
  return entry.consumed === null
    ? `${entry.windowId}: unknown, 0 of ${turns} turns measured`
    : `${entry.windowId}: ${entry.consumed} ${entry.unit} used, ${entry.measuredTurns} of ${turns} turns measured`;
}
