import type { ChatFamily, WorkspaceState } from '@crewkite/contracts';
import { useEffect, useState } from 'react';
import { familyName } from '../components.tsx';
import { familyModel, onFamilyDefaults } from '../settings/preferences.ts';
import { focusSettingsCard } from '../settings/provider-card.tsx';
import { useCatalog } from '../settings/use-catalog.ts';
import { formatSpan } from '../usage-gauges.tsx';
import { railFamilies } from '../usage-presentation.ts';
import type { ThreadSource } from './commands.ts';
import { FamilyMark } from './family-mark.tsx';

/**
 * One row per family the composer can use, plus a family whose usage reads before Connect. A
 * family with a five-hour and a weekly window gets a bar for each, and the reset line follows the
 * tightest. The rows come from the catalog the composer uses, so the rail and the picker agree.
 */
export function RailUsage({
  source,
  header,
  onOpenSettings,
}: {
  source: ThreadSource | undefined;
  header: WorkspaceState;
  /** Opens the Settings page. The rail marks the card to scroll to first. */
  onOpenSettings?: () => void;
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
  const rows = railFamilies(catalog, now, {
    modelFor: (entry) => familyModel(entry),
    hardware: header.localHardware,
    localSetup: header.localSetup,
  });
  if (rows.length === 0) return null;
  const connect = (family: ChatFamily) => {
    focusSettingsCard(family);
    onOpenSettings?.();
  };
  return (
    <section className="rail-usage" aria-label="Provider allowance">
      {rows.map((row) => (
        <div
          key={row.family}
          className={row.needsConnect ? 'rail-usage-row is-waiting' : 'rail-usage-row'}
          title={row.detail ?? undefined}
        >
          <span className="rail-usage-label">
            <FamilyMark family={row.family} />
            {familyName(row.family)}
            {row.detail && <span className="th-sr">. {row.detail}</span>}
          </span>
          {row.unlimited ? (
            <span className="rail-usage-meter">
              <span className="rail-usage-unlimited" aria-hidden="true">
                <span>∞</span>
              </span>
              <span className="rail-usage-value">No limits</span>
            </span>
          ) : (
            row.bars.map((bar) => (
              <span key={bar.text} className="rail-usage-meter">
                <span className="rail-usage-bar" aria-hidden="true">
                  <span
                    className={`family-${row.family}`}
                    style={{ width: `${bar.percent ?? 0}%` }}
                  />
                </span>
                <span
                  className={
                    bar.percent === null ? 'rail-usage-value is-unknown' : 'rail-usage-value'
                  }
                >
                  {bar.text}
                </span>
              </span>
            ))
          )}
          {!row.unlimited && (
            <span className="rail-usage-reset">
              <span>
                {row.resetsIn !== null
                  ? `resets in ${formatSpan(row.resetsIn)}`
                  : row.resetPassed
                    ? 'reset passed'
                    : 'reset unknown'}
              </span>
              {row.read && <span>{row.read}</span>}
            </span>
          )}
          {row.needsConnect &&
            (onOpenSettings ? (
              <button
                type="button"
                className="rail-usage-connect"
                onClick={() => connect(row.family)}
              >
                Connect
              </button>
            ) : (
              <span className="rail-usage-reset">Connect in Settings</span>
            ))}
        </div>
      ))}
    </section>
  );
}
