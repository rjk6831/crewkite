const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count as people read it: "812 B", "4.5 MB", "22.5 GB". Units are 1,024 apart. One decimal
 * below 100, none above, and a trailing ".0" is dropped. The renderer prints every size here so the
 * same count never reads two ways.
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  // A value that rounds up to 1,024 belongs in the next unit.
  while (Math.round(value * 10) / 10 >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${UNITS[unit]}`;
}
