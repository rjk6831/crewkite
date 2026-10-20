import type { Observation, Window } from '@crewkite/contracts';
import { CircleAlert, CircleHelp, CircleSlash, Clock, Target } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import './usage-gauges.css';

export type UsageAmount = NonNullable<Observation['remaining']>;

// The parent decides freshness. This component never promotes a reading to fresh.
export type UsageReadingState = Window['state'] | 'unavailable';

export type UsageReading = {
  // Unique within its card. It is the React key, separate from the raw provider window ID.
  id: string;
  label: string;
  windowId?: string;
  remaining: UsageAmount | null;
  state: UsageReadingState;
  observedAt: string | null;
  resetsAt: string | null;
  source?: Observation['source'];
  confidence?: Observation['confidence'];
  reserve?: UsageAmount | null;
  reserveNote?: string;
  constraining?: boolean;
  note?: string;
};

export type UsageCredit = { id: string; label: string; value: string; note?: string };

export type UsageResource = {
  id: string;
  label: string;
  value: string;
  used?: number;
  total?: number;
  note?: string;
};

export type UsageCard = {
  // Unique across the dashboard.
  id: string;
  title: string;
  scope?: string;
  tags?: readonly string[];
  notice?: string;
  // One or two side dials. Prominence comes from the host; nothing here ranks allowances.
  primary: readonly UsageReading[];
  // A smaller dial raised between the side dials, for one allowance the host pins by exact window.
  featured?: UsageReading | null;
  // One-line meters under the dials. Each keeps its own value, reset and warning.
  auxiliary?: readonly UsageReading[];
  credits?: readonly UsageCredit[];
  resources?: readonly UsageResource[];
  emptyText?: string;
};

export type UsageGaugesProps = {
  cards: readonly UsageCard[];
  nowMs: number;
  label?: string;
};

export function formatSpan(ms: number) {
  const minutes = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60_000)) : 0;
  if (minutes < 1) return 'under 1 min';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  return `${rest} min`;
}

const sourceText: Record<Observation['source'], string> = {
  provider: 'Provider report',
  client: 'Client read',
  'local-counter': 'Local counter',
  manual: 'Manual entry',
  fixture: 'Fixture',
};

const confidenceText: Record<Observation['confidence'], string> = {
  reported: 'Reported',
  estimated: 'Estimated',
  inferred: 'Inferred',
};

// Remaining amounts round down everywhere so no display overstates what is left.
const compact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
  roundingMode: 'floor',
});
const exact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3, roundingMode: 'floor' });

const SWEEP = 240;
const round = (value: number) => Math.round(value * 100) / 100;

function point(radius: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return [round(100 + radius * Math.sin(radians)), round(100 - radius * Math.cos(radians))];
}

function angle(percent: number) {
  return -SWEEP / 2 + (SWEEP * percent) / 100;
}

function arc(radius: number, from: number, to: number) {
  const [x1, y1] = point(radius, angle(from));
  const [x2, y2] = point(radius, angle(to));
  const large = ((to - from) * SWEEP) / 100 > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
}

// Positive amounts never print as zero. Large ones floor to compact notation; Details keep the
// exact value.
function amountDigits(value: number) {
  if (value >= 10_000) return compact.format(value);
  return value > 0 && value < 0.001 ? '<0.001' : exact.format(value);
}

function percentText(value: number) {
  return value > 0 && value < 1 ? '<1' : String(Math.floor(value));
}

function time(iso: string | null) {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function absolute(ms: number) {
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function amountText(amount: UsageAmount) {
  return amount.unit === 'percent'
    ? `${amount.value}%`
    : `${amount.value.toLocaleString()} ${amount.unit}`;
}

function describe(reading: UsageReading, nowMs: number) {
  const { reserve, state } = reading;
  // Values outside the schema still render honestly: non-finite is unknown, negative is zero.
  const remaining =
    reading.remaining && Number.isFinite(reading.remaining.value)
      ? { ...reading.remaining, value: Math.max(0, reading.remaining.value) }
      : null;
  const known = remaining !== null && state !== 'unknown' && state !== 'unavailable';
  const percent = known && remaining.unit === 'percent' ? Math.min(100, remaining.value) : null;
  const usableReserve = reserve && Number.isFinite(reserve.value) ? reserve : null;
  const reservePercent =
    percent !== null &&
    usableReserve?.unit === 'percent' &&
    usableReserve.value >= 0 &&
    usableReserve.value <= 100
      ? usableReserve.value
      : null;
  const exhausted = known && remaining.value <= 0;
  const atReserve =
    known &&
    !exhausted &&
    usableReserve !== null &&
    usableReserve.unit === remaining.unit &&
    remaining.value <= usableReserve.value;
  const dated = state === 'stale' || state === 'reset-pending';
  const observedAt = time(reading.observedAt);
  const resetsAt = time(reading.resetsAt);
  const observed = observedAt === null ? null : nowMs - observedAt;
  const resets = resetsAt === null ? null : resetsAt - nowMs;
  const note = reading.reserveNote?.trim();
  const reserveValue = usableReserve ? `Reserve ${amountText(usableReserve)}` : null;
  return {
    remaining,
    known,
    unknownValue: !known && state !== 'unavailable',
    percent,
    reservePercent,
    exhausted,
    atReserve,
    dated,
    observedAt,
    resetsAt,
    tone: !known ? 'none' : exhausted ? 'exhausted' : atReserve ? 'low' : dated ? 'dated' : 'ok',
    observedText:
      observed === null
        ? 'Never observed'
        : Number.isNaN(observed)
          ? 'Observation time unreadable'
          : // A reading can land just after the parent's clock tick. Treat a small lead as now.
            observed < -60_000
            ? 'Observation time is ahead of this clock'
            : `${state === 'fresh' ? 'Observed' : 'Last observed'} ${observed < 60_000 ? 'just now' : `${formatSpan(observed)} ago`}`,
    resetText:
      resets === null
        ? 'Reset time not reported'
        : Number.isNaN(resets)
          ? 'Reset time unreadable'
          : resets <= 0
            ? 'Reset time passed. Waiting for a new reading'
            : `Resets in ${formatSpan(resets)}`,
    reserveText: reserveValue && note ? `${reserveValue}. ${note}` : (reserveValue ?? note ?? null),
  };
}

function details(reading: UsageReading, view: ReturnType<typeof describe>) {
  const rows: [string, ReactNode][] = [];
  if (view.known && view.remaining && view.remaining.value >= 10_000)
    rows.push(['Remaining', `${exact.format(view.remaining.value)} ${view.remaining.unit}`]);
  if (reading.note) rows.push(['Note', reading.note]);
  if (reading.windowId) rows.push(['Window', <code key="window">{reading.windowId}</code>]);
  if (reading.source) rows.push(['Source', sourceText[reading.source]]);
  if (reading.confidence) rows.push(['Confidence', confidenceText[reading.confidence]]);
  if (view.observedAt !== null && !Number.isNaN(view.observedAt))
    rows.push(['Observed', absolute(view.observedAt)]);
  if (view.resetsAt !== null && !Number.isNaN(view.resetsAt))
    rows.push(['Resets', absolute(view.resetsAt)]);
  if (view.reserveText) rows.push(['Reserve', view.reserveText]);
  return rows;
}

// A missing value names itself and explains why on hover, keyboard focus and tap. It never
// renders as zero, empty or full.
function Missing({ reading }: { reading: UsageReading }) {
  const tipId = `usage-missing-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const unavailable = reading.state === 'unavailable';
  // Escape hides the explanation without moving focus or the pointer. A new hover or focus
  // brings it back.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (dismissed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDismissed(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dismissed]);
  return (
    <span className="usage-missing" data-dismissed={dismissed ? '' : undefined}>
      <button
        type="button"
        className="usage-missing-word"
        aria-describedby={tipId}
        onPointerEnter={() => setDismissed(false)}
        onFocus={() => setDismissed(false)}
      >
        {unavailable ? 'Unavailable' : 'Unknown'}
      </button>
      <span role="tooltip" id={tipId} className="usage-missing-tip">
        {unavailable
          ? 'This source has not reported this allowance.'
          : 'No usable report for this allowance. A missing value is never shown as zero.'}
      </span>
    </span>
  );
}

function Chip({ tone, icon, children }: { tone: string; icon: ReactNode; children: ReactNode }) {
  return (
    <li className={`usage-gauges-chip chip-${tone}`}>
      {icon}
      {children}
    </li>
  );
}

export function UsageGauge({
  reading,
  nowMs,
  size = 'primary',
  cluster = false,
  observed = true,
}: {
  reading: UsageReading;
  nowMs: number;
  size?: 'primary' | 'featured';
  // In a cluster the card footer carries the details, and the observed time when all agree.
  cluster?: boolean;
  observed?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const view = describe(reading, nowMs);
  const { remaining } = view;
  const primary = size === 'primary';
  const labelId = `usage-gauge-${uid}`;
  // Ticks are a percent scale. Readings without a known percent get no scale at all.
  const ticks =
    view.percent === null
      ? []
      : primary
        ? Array.from({ length: 11 }, (_, index) => index * 10)
        : [0, 25, 50, 75, 100];
  const unscaled = view.known && view.percent === null;
  const chips: ReactNode[] = [];
  if (reading.constraining)
    chips.push(
      <Chip key="constraining" tone="constraining" icon={<Target size={11} aria-hidden="true" />}>
        Constraining
      </Chip>,
    );
  if (view.exhausted)
    chips.push(
      <Chip key="exhausted" tone="exhausted" icon={<CircleSlash size={11} aria-hidden="true" />}>
        Exhausted
      </Chip>,
    );
  if (view.atReserve)
    chips.push(
      <Chip key="reserve" tone="low" icon={<CircleAlert size={11} aria-hidden="true" />}>
        At reserve
      </Chip>,
    );
  if (reading.state === 'stale')
    chips.push(
      <Chip key="stale" tone="dated" icon={<Clock size={11} aria-hidden="true" />}>
        Stale
      </Chip>,
    );
  if (reading.state === 'reset-pending')
    chips.push(
      <Chip key="pending" tone="low" icon={<Clock size={11} aria-hidden="true" />}>
        Reset pending
      </Chip>,
    );
  if (view.unknownValue)
    chips.push(
      <Chip key="unknown" tone="unknown" icon={<CircleHelp size={11} aria-hidden="true" />}>
        Unknown
      </Chip>,
    );
  if (reading.state === 'unavailable')
    chips.push(
      <Chip key="unavailable" tone="unknown" icon={<CircleSlash size={11} aria-hidden="true" />}>
        Unavailable
      </Chip>,
    );
  const rows = cluster ? [] : details(reading, view).filter(([term]) => term !== 'Reserve');
  return (
    <figure
      className={`usage-gauge is-${size} tone-${view.tone} state-${reading.state}${unscaled ? ' is-unscaled' : ''}${view.unknownValue ? ' is-unknown-value' : ''}${reading.constraining ? ' is-constraining' : ''}${cluster ? ' is-clustered' : ''}`}
      aria-labelledby={labelId}
    >
      <figcaption id={labelId} className="usage-gauge-label">
        {reading.label}
      </figcaption>
      {chips.length > 0 && <ul className="usage-gauges-chips">{chips}</ul>}
      <div className="usage-gauge-face">
        <svg viewBox="0 0 200 200" aria-hidden="true" focusable="false">
          <defs>
            <pattern
              id={`usage-hatch-${uid}`}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line className="usage-gauge-hatch" x1="0" y1="0" x2="0" y2="6" />
            </pattern>
          </defs>
          <circle className="usage-gauge-bezel" cx="100" cy="100" r="97" />
          {ticks.map((tick) => {
            const major = tick % 25 === 0;
            const [x1, y1] = point(major ? 61 : 65, angle(tick));
            const [x2, y2] = point(70, angle(tick));
            return (
              <line
                key={tick}
                className={major ? 'usage-gauge-tick is-major' : 'usage-gauge-tick'}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
              />
            );
          })}
          <path
            className="usage-gauge-track"
            d={arc(82, 0, 100)}
            style={view.unknownValue ? { stroke: `url(#usage-hatch-${uid})` } : undefined}
          />
          {view.reservePercent !== null && view.reservePercent > 0 && (
            <path className="usage-gauge-reserve-zone" d={arc(73, 0, view.reservePercent)} />
          )}
          {view.percent !== null && view.percent > 0 && (
            <path
              className="usage-gauge-fill"
              d={arc(82, 0, 100)}
              pathLength={100}
              strokeDasharray={`${view.percent} 100`}
            />
          )}
          {view.reservePercent !== null &&
            (() => {
              const [x1, y1] = point(72, angle(view.reservePercent));
              const [x2, y2] = point(93, angle(view.reservePercent));
              return <line className="usage-gauge-reserve" x1={x1} y1={y1} x2={x2} y2={y2} />;
            })()}
          {view.percent !== null &&
            (() => {
              const [x1, y1] = point(74, angle(view.percent));
              const [x2, y2] = point(92, angle(view.percent));
              return <line className="usage-gauge-pointer" x1={x1} y1={y1} x2={x2} y2={y2} />;
            })()}
        </svg>
        <p className="usage-gauge-value">
          {!view.known || remaining === null ? (
            <strong className="is-word">
              <Missing reading={reading} />
            </strong>
          ) : view.percent !== null ? (
            <strong>
              {percentText(view.percent)}
              <span className="usage-gauge-unit">%</span>
            </strong>
          ) : (
            <strong className="is-amount">{amountDigits(remaining.value)}</strong>
          )}
          <span className="usage-gauge-caption">
            {!view.known || remaining === null
              ? reading.state === 'unavailable'
                ? 'No reading'
                : 'No usable report'
              : `${remaining.unit === 'percent' ? '' : `${remaining.unit} `}${view.dated ? 'left when observed' : 'remaining'}`}
          </span>
        </p>
      </div>
      <ul className="usage-gauge-lines">
        <li>
          {view.resetsAt !== null && !Number.isNaN(view.resetsAt) && reading.resetsAt ? (
            <time dateTime={reading.resetsAt}>{view.resetText}</time>
          ) : (
            view.resetText
          )}
        </li>
        {observed && (
          <li>
            {view.observedAt !== null && !Number.isNaN(view.observedAt) && reading.observedAt ? (
              <time dateTime={reading.observedAt}>{view.observedText}</time>
            ) : (
              view.observedText
            )}
          </li>
        )}
        {view.reserveText && <li className="usage-gauge-reserve-line">{view.reserveText}</li>}
        {unscaled && remaining && (
          <li>
            {remaining.value >= 10_000
              ? `${exact.format(remaining.value)} ${remaining.unit}, no total reported`
              : 'No total reported'}
          </li>
        )}
      </ul>
      {rows.length > 0 && (
        <details className="usage-gauge-details">
          <summary aria-describedby={labelId}>Details</summary>
          <dl>
            {rows.map(([term, value]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </figure>
  );
}

const flagText: Record<string, string> = {
  constraining: 'Constraining',
  exhausted: 'Exhausted',
  low: 'At reserve',
  stale: 'Stale',
  'reset-pending': 'Reset pending',
};

// An auxiliary allowance on one line. It keeps its own value, reset and warning, so a low or
// exhausted pool stands out even though it is drawn smaller than the dials.
function UsageMeter({
  reading,
  nowMs,
  observed,
}: {
  reading: UsageReading;
  nowMs: number;
  observed: boolean;
}) {
  const view = describe(reading, nowMs);
  const { remaining } = view;
  const resetsIn =
    view.resetsAt !== null && !Number.isNaN(view.resetsAt) && view.resetsAt > nowMs
      ? formatSpan(view.resetsAt - nowMs)
      : null;
  // The same facts as the dial chips, in the same order. One state never hides another.
  const flags = [
    reading.constraining ? 'constraining' : null,
    view.exhausted ? 'exhausted' : null,
    view.atReserve ? 'low' : null,
    view.dated ? reading.state : null,
  ].filter((flag) => flag !== null);
  return (
    <li
      className={`usage-meter tone-${view.tone} state-${reading.state}${view.unknownValue ? ' is-unknown-value' : ''}${reading.constraining ? ' is-constraining' : ''}${view.known && view.percent === null ? ' is-unscaled' : ''}`}
    >
      <span className="usage-meter-label">{reading.label}</span>
      <span className="usage-meter-bar" aria-hidden="true">
        {view.percent !== null && view.percent > 0 && (
          <span className="usage-meter-fill" style={{ width: `${view.percent}%` }} />
        )}
        {view.reservePercent !== null && (
          <span className="usage-meter-reserve" style={{ left: `${view.reservePercent}%` }} />
        )}
      </span>
      <span className="usage-meter-value">
        {!view.known || remaining === null ? (
          <Missing reading={reading} />
        ) : view.percent !== null ? (
          `${percentText(view.percent)}%`
        ) : (
          `${amountDigits(remaining.value)} ${remaining.unit}`
        )}
        {view.known && (
          <span className="usage-sr-only">{view.dated ? ' left when observed' : ' remaining'}</span>
        )}
      </span>
      <span className="usage-meter-reset">
        {resetsIn ? (
          <>
            <span className="usage-sr-only">Resets in </span>
            {reading.resetsAt ? <time dateTime={reading.resetsAt}>{resetsIn}</time> : resetsIn}
          </>
        ) : view.resetsAt === null ? (
          <>
            <span className="usage-sr-only">Reset time </span>Not reported
          </>
        ) : Number.isNaN(view.resetsAt) ? (
          <>
            <span className="usage-sr-only">Reset time </span>Unreadable
          </>
        ) : (
          <>
            Reset passed<span className="usage-sr-only">. Waiting for a new reading</span>
          </>
        )}
      </span>
      {flags.length > 0 && (
        <span className="usage-meter-flags">
          {flags.map((flag) => (
            <span key={flag} className={`usage-meter-flag flag-${flag}`}>
              {flagText[flag]}
            </span>
          ))}
        </span>
      )}
      {observed && <span className="usage-meter-observed">{view.observedText}</span>}
    </li>
  );
}

function Card({ card, nowMs }: { card: UsageCard; nowMs: number }) {
  const titleId = `usage-card-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const auxiliary = card.auxiliary ?? [];
  const featured = card.featured ?? null;
  const empty = card.primary.length === 0 && auxiliary.length === 0 && !featured;
  // Two side dials and an optional center dial form the cluster. More primaries keep the grid.
  const cluster = card.primary.length <= 2 && (card.primary.length > 0 || featured !== null);
  const all = [...card.primary, ...(featured ? [featured] : []), ...auxiliary];
  const views = all.map((reading) => ({ reading, view: describe(reading, nowMs) }));
  // A card of meters alone still needs one place for the observed time and the details.
  const withFooter = views.length > 0 && (cluster || card.primary.length === 0);
  // One report usually stamps every window with the same time. Say it once in the footer and
  // repeat it only on a reading that differs. Grouping by the timestamp and state keeps the
  // choice steady as the display clock ticks.
  const group = (reading: UsageReading) => `${reading.observedAt ?? 'never'}:${reading.state}`;
  const counts = new Map<string, number>();
  for (const { reading } of views)
    counts.set(group(reading), (counts.get(group(reading)) ?? 0) + 1);
  const common = withFooter ? ([...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) : null;
  const shared = views.find(({ reading }) => group(reading) === common) ?? null;
  const ownTime = (reading: UsageReading) => group(reading) !== common;
  const [left, right] = card.primary;
  return (
    <article className="usage-gauges-card" aria-labelledby={titleId}>
      <header className="usage-gauges-card-header">
        <div>
          <h3 id={titleId}>{card.title}</h3>
          {card.scope && <p className="usage-gauges-scope">{card.scope}</p>}
        </div>
        {Boolean(card.tags?.length) && (
          <ul className="usage-gauges-tags">
            {[...new Set(card.tags)].map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        )}
      </header>
      {card.notice && (
        <p className="usage-gauges-notice">
          <CircleAlert size={13} aria-hidden="true" />
          {card.notice}
        </p>
      )}
      {empty && <p className="usage-gauges-empty">{card.emptyText ?? 'No allowance reported.'}</p>}
      {cluster ? (
        <div
          className="usage-gauges-cluster"
          data-count={card.primary.length}
          data-featured={featured ? 'true' : undefined}
        >
          {left && <UsageGauge reading={left} nowMs={nowMs} cluster observed={ownTime(left)} />}
          {featured && (
            <UsageGauge
              reading={featured}
              nowMs={nowMs}
              size="featured"
              cluster
              observed={ownTime(featured)}
            />
          )}
          {right && <UsageGauge reading={right} nowMs={nowMs} cluster observed={ownTime(right)} />}
        </div>
      ) : (
        card.primary.length > 0 && (
          <div className="usage-gauges-primary">
            {[...card.primary, ...(featured ? [featured] : [])].map((reading) => (
              <UsageGauge key={reading.id} reading={reading} nowMs={nowMs} />
            ))}
          </div>
        )
      )}
      {auxiliary.length > 0 && (
        <section className="usage-gauges-auxiliary">
          <h4>More allowances</h4>
          <ul>
            {auxiliary.map((reading) => (
              <UsageMeter
                key={reading.id}
                reading={reading}
                nowMs={nowMs}
                observed={ownTime(reading)}
              />
            ))}
          </ul>
        </section>
      )}
      {withFooter && (
        <footer className="usage-gauges-card-footer">
          {shared && (
            <span>
              {shared.view.observedAt !== null &&
              !Number.isNaN(shared.view.observedAt) &&
              shared.reading.observedAt ? (
                <time dateTime={shared.reading.observedAt}>{shared.view.observedText}</time>
              ) : (
                shared.view.observedText
              )}
            </span>
          )}
          <details className="usage-gauge-details usage-gauges-card-details">
            <summary aria-describedby={titleId}>Details</summary>
            {views.map(({ reading, view }) => {
              const rows = details(reading, view);
              return (
                <section key={reading.id}>
                  <h4>{reading.label}</h4>
                  {rows.length > 0 ? (
                    <dl>
                      {rows.map(([term, value]) => (
                        <div key={term}>
                          <dt>{term}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p>No further facts reported.</p>
                  )}
                </section>
              );
            })}
          </details>
        </footer>
      )}
      {Boolean(card.credits?.length) && (
        <section className="usage-gauges-ledger">
          <h4>Paid credits</h4>
          <p>Separate from subscription allowances.</p>
          <dl>
            {card.credits?.map((credit) => (
              <div key={credit.id}>
                <dt>{credit.label}</dt>
                <dd>
                  {credit.value}
                  {credit.note && <small>{credit.note}</small>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {Boolean(card.resources?.length) && (
        <section className="usage-gauges-ledger">
          <h4>Local resources</h4>
          <dl>
            {card.resources?.map((resource) => {
              const { used, total } = resource;
              const fraction =
                used !== undefined &&
                total !== undefined &&
                Number.isFinite(used / total) &&
                total > 0
                  ? Math.min(1, Math.max(0, used / total))
                  : null;
              return (
                <div key={resource.id}>
                  <dt>{resource.label}</dt>
                  <dd>
                    {resource.value}
                    {fraction !== null && (
                      <span className="usage-gauges-meter" aria-hidden="true">
                        <span
                          className="usage-gauges-meter-fill"
                          style={{ width: `${fraction * 100}%` }}
                        />
                      </span>
                    )}
                    {resource.note && <small>{resource.note}</small>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}
    </article>
  );
}

export function UsageGauges({ cards, nowMs, label = 'Provider usage' }: UsageGaugesProps) {
  return (
    <section className="usage-gauges" aria-label={label}>
      {cards.map((card) => (
        <Card key={card.id} card={card} nowMs={nowMs} />
      ))}
    </section>
  );
}
