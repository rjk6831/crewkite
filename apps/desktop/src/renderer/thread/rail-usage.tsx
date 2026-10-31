import type { ChatFamily, WorkspaceState } from '@crewkite/contracts';
import { useEffect, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import { connectInPlace, WITHOUT_TOKEN } from '../local-setup-flow.ts';
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
  refresh,
}: {
  source: ThreadSource | undefined;
  header: WorkspaceState;
  /** Opens the Settings page. The rail marks the card to scroll to first. */
  onOpenSettings?: () => void;
  /** Reads the workspace again and returns it, so Connect can follow the Local setup. */
  refresh?: () => Promise<WorkspaceState>;
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
  const [localNote, setLocalNote] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const attempt = useRef(0);
  const rows = railFamilies(catalog, now, {
    modelFor: (entry) => familyModel(entry),
    hardware: header.localHardware,
    localSetup: header.localSetup,
  });
  if (rows.length === 0) return null;
  const settings = (family: ChatFamily) => {
    focusSettingsCard(family);
    onOpenSettings?.();
  };
  // Local connects here with the saved endpoint and auth mode. Settings opens only when no endpoint
  // is saved, or when the input operation is owned, which is the token window being up. While the
  // loopback probe holds the operation in intent, the rail stays where it is and says Connecting.
  async function connectLocal() {
    const setup = header.localSetup;
    if (connecting) return;
    if (!source || !refresh || !setup) return settings('local');
    attempt.current += 1;
    const mine = attempt.current;
    setConnecting(true);
    setLocalNote('Connecting');
    try {
      const result = await connectInPlace({
        setup,
        command: source.command,
        read: async () => (await refresh()).localSetup,
        wait: () => new Promise((resolve) => window.setTimeout(resolve, 1000)),
        active: () => attempt.current === mine,
      });
      if (result.kind === 'stopped') return;
      if (result.kind === 'settings') {
        setLocalNote(null);
        settings('local');
      } else
        setLocalNote(
          result.kind === 'connected'
            ? result.withoutToken
              ? WITHOUT_TOKEN
              : 'Connected'
            : result.message,
        );
    } catch {
      setLocalNote('Local could not be reached. Open Settings to connect.');
    } finally {
      setConnecting(false);
    }
  }
  const connect = (family: ChatFamily) =>
    family === 'local' ? void connectLocal() : settings(family);
  return (
    <section className="rail-usage" aria-label="Provider allowance">
      {rows.map((row) => (
        <div
          key={row.family}
          className={row.needsConnect ? 'rail-usage-row is-waiting' : 'rail-usage-row'}
          // A native title shows late and never on keyboard focus. The detail card shows on both.
          tabIndex={row.detail ? 0 : undefined}
        >
          {row.detail && (
            <span className="rail-usage-detail" aria-hidden="true">
              {row.detail}
            </span>
          )}
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
          {!row.unlimited && !row.setUp && row.bars.length > 0 && (
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
          {row.family === 'local' && localNote && (
            <span className="rail-usage-reset" role="status">
              {localNote}
            </span>
          )}
          {row.setUp &&
            (onOpenSettings ? (
              <button
                type="button"
                className="rail-usage-connect"
                onClick={() => settings('local')}
              >
                Set up
              </button>
            ) : (
              <span className="rail-usage-reset">Set up in Settings</span>
            ))}
          {row.needsConnect &&
            (onOpenSettings ? (
              <button
                type="button"
                className="rail-usage-connect"
                disabled={row.family === 'local' && connecting}
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
