/**
 * A controller timestamp as a person reads it, in their own time zone and without seconds:
 * "Oct 31, 2026, 4:06 PM". Settings prints every such time here so none shows as raw ISO text.
 * A value that cannot be read gives null, so the caller can say the time is unknown.
 */
export function formatLocalTime(
  value: string | null | undefined,
  options: { locale?: string; timeZone?: string } = {},
): string | null {
  const at = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleString(options.locale ?? [], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
}

/** A time from today as "4:06 PM", and an earlier one with its day, as "Nov 17, 4:06 PM". */
export function shortTime(iso: string): string {
  const at = new Date(iso);
  return at.toDateString() === new Date().toDateString()
    ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
