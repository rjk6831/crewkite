import type { WorkspaceState } from '@crewkite/contracts';
import { useEffect, useState } from 'react';
import { familyName } from '../components.tsx';
import { railRows } from '../settings/allowance.ts';
import { onFamilyDefaults } from '../settings/preferences.ts';
import { useCatalog } from '../settings/use-catalog.ts';
import { formatSpan } from '../usage-gauges.tsx';
import type { ThreadSource } from './commands.ts';

/**
 * One row per connected family: percent left on its tightest window and when that resets. The
 * rows come from the catalog the composer uses, so the rail and the model picker agree.
 */
export function RailUsage({
  source,
  header,
}: {
  source: ThreadSource | undefined;
  header: WorkspaceState;
}) {
  const { catalog } = useCatalog(source, header);
  const [now, setNow] = useState(Date.now);
  // A default model picked in Settings changes which windows count, so the rows redraw at once.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    const stop = onFamilyDefaults(() => setNow(Date.now()));
    return () => {
      window.clearInterval(timer);
      stop();
    };
  }, []);
  const rows = railRows(catalog, now);
  if (rows.length === 0) return null;
  return (
    <section className="rail-usage" aria-label="Provider allowance">
      {rows.map((row) => (
        <div key={row.family} className="rail-usage-row">
          <span className="rail-usage-label">{familyName(row.family)}</span>
          <span
            className={
              row.percent !== null
                ? 'rail-usage-value'
                : row.onDevice
                  ? 'rail-usage-value is-device'
                  : 'rail-usage-value is-unknown'
            }
          >
            {row.percent !== null
              ? `${row.percent}% left`
              : row.onDevice
                ? 'on this computer'
                : 'unknown'}
          </span>
          {!row.onDevice && (
            <>
              <span className="rail-usage-bar" aria-hidden="true">
                <span style={{ width: `${row.percent ?? 0}%` }} />
              </span>
              <span className="rail-usage-reset">
                {row.resetsIn !== null
                  ? `resets in ${formatSpan(row.resetsIn)}`
                  : row.resetPassed
                    ? 'reset passed'
                    : 'reset unknown'}
              </span>
            </>
          )}
        </div>
      ))}
    </section>
  );
}
