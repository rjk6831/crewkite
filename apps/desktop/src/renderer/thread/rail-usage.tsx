import type { WorkspaceState } from '@crewkite/contracts';
import { formatSpan } from '../usage-gauges.tsx';
import { projectUsagePresentation, type UsageGaugeReading } from '../usage-presentation.ts';
import { useUsageClock } from './usage-cards.ts';

type Row = { id: string; label: string; percent: number; resetsIn: number | null };

// The reading with the least left says how much a provider can still do, so it is the one shown.
function tightest(...readings: (UsageGaugeReading | null)[]) {
  const known = readings.filter(
    (reading): reading is UsageGaugeReading =>
      reading?.remaining?.unit === 'percent' && reading.state !== 'unknown',
  );
  return known.sort((a, b) => (a.remaining?.value ?? 0) - (b.remaining?.value ?? 0))[0] ?? null;
}

export function RailUsage({ header, preview }: { header: WorkspaceState; preview: boolean }) {
  const now = useUsageClock(header.usage, preview);
  const rows: Row[] = [];
  for (const card of projectUsagePresentation(header, null, now)) {
    const reading = tightest(
      card.primary.weekly,
      card.primary.fiveHour,
      card.featured,
      ...card.satellites,
    );
    if (reading?.remaining)
      rows.push({
        id: card.id,
        label: card.label,
        percent: Math.floor(reading.remaining.value),
        resetsIn: reading.resetsAt ? Date.parse(reading.resetsAt) - now : null,
      });
  }
  if (rows.length === 0) return null;
  return (
    <section className="rail-usage" aria-label="Provider allowance">
      {rows.map((row) => (
        <div key={row.id} className="rail-usage-row">
          <span className="rail-usage-label">{row.label}</span>
          <span className="rail-usage-value">{row.percent}% left</span>
          <span className="rail-usage-bar" aria-hidden="true">
            <span style={{ width: `${row.percent}%` }} />
          </span>
          {row.resetsIn !== null && row.resetsIn > 0 && (
            <span className="rail-usage-reset">resets in {formatSpan(row.resetsIn)}</span>
          )}
        </div>
      ))}
    </section>
  );
}
