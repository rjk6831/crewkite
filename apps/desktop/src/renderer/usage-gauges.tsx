import type { Observation, Window } from '@crewkite/contracts';
import { CircleAlert, CircleHelp, CircleSlash, Clock, Target } from 'lucide-react';
import { type ReactNode, useId } from 'react';
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
  primary: readonly UsageReading[];
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
}: {
  reading: UsageReading;
  nowMs: number;
  size?: 'primary' | 'auxiliary';
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
        ? Array.from({ length: 21 }, (_, index) => index * 5)
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
  const details: [string, ReactNode][] = [];
  if (reading.note) details.push(['Note', reading.note]);
  if (reading.windowId) details.push(['Window', <code key="window">{reading.windowId}</code>]);
  if (reading.source) details.push(['Source', sourceText[reading.source]]);
  if (reading.confidence) details.push(['Confidence', confidenceText[reading.confidence]]);
  if (view.observedAt !== null && !Number.isNaN(view.observedAt))
    details.push(['Observed', absolute(view.observedAt)]);
  if (view.resetsAt !== null && !Number.isNaN(view.resetsAt))
    details.push(['Resets', absolute(view.resetsAt)]);
  return (
    <figure
      className={`usage-gauge is-${size} tone-${view.tone} state-${reading.state}${unscaled ? ' is-unscaled' : ''}${view.unknownValue ? ' is-unknown-value' : ''}${reading.constraining ? ' is-constraining' : ''}`}
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
          {primary &&
            view.percent !== null &&
            [0, 50, 100].map((tick) => {
              const [x, y] = tick === 50 ? point(50, angle(tick)) : point(82, angle(tick));
              return (
                <text
                  key={tick}
                  className="usage-gauge-scale"
                  x={x}
                  y={tick === 50 ? y + 4 : y + 20}
                >
                  {tick}
                </text>
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
              {reading.state === 'unavailable' ? 'Unavailable' : 'Unknown'}
            </strong>
          ) : view.percent !== null ? (
            <strong>
              {percentText(view.percent)}
              <span>%</span>
            </strong>
          ) : (
            <strong className="is-amount">
              {remaining.value >= 10_000
                ? compact.format(remaining.value)
                : remaining.value > 0 && remaining.value < 0.001
                  ? '<0.001'
                  : exact.format(remaining.value)}
            </strong>
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
        <li>
          {view.observedAt !== null && !Number.isNaN(view.observedAt) && reading.observedAt ? (
            <time dateTime={reading.observedAt}>{view.observedText}</time>
          ) : (
            view.observedText
          )}
        </li>
        {view.reserveText && <li className="usage-gauge-reserve-line">{view.reserveText}</li>}
        {unscaled && remaining && (
          <li>
            {remaining.value >= 10_000
              ? `${exact.format(remaining.value)} ${remaining.unit}, no total reported`
              : 'No total reported'}
          </li>
        )}
      </ul>
      {details.length > 0 && (
        <details className="usage-gauge-details">
          <summary aria-describedby={labelId}>Details</summary>
          <dl>
            {details.map(([term, value]) => (
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

function Card({ card, nowMs }: { card: UsageCard; nowMs: number }) {
  const titleId = `usage-card-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const auxiliary = card.auxiliary ?? [];
  const empty = card.primary.length === 0 && auxiliary.length === 0;
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
      {card.primary.length > 0 && (
        <div className="usage-gauges-primary" data-count={Math.min(card.primary.length, 3)}>
          {card.primary.map((reading) => (
            <UsageGauge key={reading.id} reading={reading} nowMs={nowMs} />
          ))}
        </div>
      )}
      {auxiliary.length > 0 && (
        <section className="usage-gauges-auxiliary">
          <h4>Additional allowances</h4>
          <div>
            {auxiliary.map((reading) => (
              <UsageGauge key={reading.id} reading={reading} nowMs={nowMs} size="auxiliary" />
            ))}
          </div>
        </section>
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
