import { type PointerEvent as ReactPointerEvent, useEffect, useId, useRef, useState } from 'react';
import { formatSpan } from './usage-gauges.tsx';
import './context-gauge.css';

export type ContextMeasurement = 'current' | 'last-observed' | 'stale' | 'unknown';

export type ContextGaugeProps = {
  usedTokens: number | null;
  capacityTokens: number | null;
  measurement: ContextMeasurement;
  // Activity only. A busy agent may not have changed its context, so this never moves the fill.
  updating?: boolean;
  measuredAt?: string | null;
  nowMs?: number;
  unavailableReason?: string;
  // Kite height in CSS pixels. The button keeps a 32px target at every size.
  size?: number;
  label?: string;
};

type Point = readonly [number, number];

// Kite corners and divider crossing from the wordmark, measured in source pixels and scaled to a
// height of 100. The spine leans left and the right corner sits lower than the left one. That is
// the brand mark, so the asymmetry stays.
const TOP: Point = [55.23, 0];
const RIGHT: Point = [80.73, 55.34];
const BOTTOM: Point = [25.45, 100];
const LEFT: Point = [0, 34.59];
const CROSS: Point = [41.22, 45.21];
const KITE = [TOP, RIGHT, BOTTOM, LEFT];
const WIDTH = RIGHT[0];
// The wordmark separates its tiles with a gap 3.23% of the kite's height.
const BRAND_GAP = 3.23;
// The kite's edges run near 67 and 145 degrees. Hatch lines 16 degrees off vertical cross both at
// about 40 degrees, so they never read as an edge. The near-horizontal angle would read as a level.
const HATCH_ANGLE = 16;
const TILES = [
  ['indigo', [LEFT, TOP, CROSS]],
  ['amber', [TOP, RIGHT, CROSS]],
  ['coral', [RIGHT, BOTTOM, CROSS]],
  ['teal', [BOTTOM, LEFT, CROSS]],
] as const;

const path = (points: readonly Point[]) => `M${points.map((point) => point.join(' ')).join(' ')}`;
const OUTLINE = `${path(KITE)}Z`;
const DIVIDERS = `${path([TOP, CROSS, BOTTOM])}${path([LEFT, CROSS, RIGHT])}`;

function area(polygon: readonly Point[]) {
  let twice = 0;
  polygon.forEach(([x1, y1], index) => {
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    twice += x1 * y2 - x2 * y1;
  });
  return Math.abs(twice) / 2;
}

const KITE_AREA = area(KITE);

function areaBelow(line: number) {
  const clipped: Point[] = [];
  KITE.forEach((from, index) => {
    const to = KITE[(index + 1) % KITE.length];
    const fromBelow = from[1] >= line;
    if (fromBelow) clipped.push(from);
    if (fromBelow !== to[1] >= line) {
      const t = (line - from[1]) / (to[1] - from[1]);
      clipped.push([from[0] + t * (to[0] - from[0]), line]);
    }
  });
  return area(clipped);
}

// The kite is narrow at the bottom. A line a quarter of the way up colors only 12% of it, so the
// line goes where the colored area equals the share used.
function fillLine(share: number) {
  if (share <= 0) return 100;
  if (share >= 1) return 0;
  let low = 0;
  let high = 100;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    if (areaBelow(middle) > share * KITE_AREA) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

// The kite outline pushed outward, for the still activity mark under reduced motion.
function halo(distance: number) {
  const normal = (from: Point, to: Point): Point => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    return [(to[1] - from[1]) / length, (from[0] - to[0]) / length];
  };
  const corners = KITE.map((point, index): Point => {
    const before = normal(KITE[(index + 3) % 4], point);
    const after = normal(point, KITE[(index + 1) % 4]);
    const miter = distance / (1 + before[0] * after[0] + before[1] * after[1]);
    return [point[0] + (before[0] + after[0]) * miter, point[1] + (before[1] + after[1]) * miter];
  });
  return `${path(corners.map(([x, y]): Point => [Number(x.toFixed(2)), Number(y.toFixed(2))]))}Z`;
}

// Rounded up so the text never understates how full the context is.
function percentUsed(used: number, capacity: number) {
  const exact = (used * 100) / capacity;
  return exact > 0 && exact < 1 ? '<1%' : `${Math.ceil(exact)}%`;
}

const tokens = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'token' : 'tokens'}`;

function age(measuredAt: string | null, nowMs: number | undefined) {
  if (!measuredAt || nowMs === undefined) return null;
  const elapsed = nowMs - Date.parse(measuredAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return elapsed < 60_000 ? 'just now' : `${formatSpan(elapsed)} ago`;
}

const spokenMeasurement: Record<ContextMeasurement, string> = {
  current: 'current',
  'last-observed': 'last observed',
  stale: 'stale',
  unknown: 'unknown',
};

export function ContextGauge({
  usedTokens,
  capacityTokens,
  measurement,
  updating = false,
  measuredAt = null,
  nowMs,
  unavailableReason,
  size = 28,
  label = 'Context window',
}: ContextGaugeProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const popover = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && (hovered || focused || pinned);

  useEffect(() => {
    const element = popover.current;
    if (!element) return;
    const shown = element.matches(':popover-open');
    if (open && !shown) element.showPopover();
    if (!open && shown) element.hidePopover();
  }, [open]);

  // Escape works wherever focus is, so a hover popover can be dismissed without moving the pointer.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setDismissed(true);
      setPinned(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  const reported = measurement !== 'unknown';
  const used =
    reported && usedTokens !== null && Number.isFinite(usedTokens) && usedTokens >= 0
      ? usedTokens
      : null;
  const capacity =
    reported && capacityTokens !== null && Number.isFinite(capacityTokens) && capacityTokens > 0
      ? capacityTokens
      : null;
  const figures =
    used !== null && capacity !== null
      ? {
          share: Math.min(1, used / capacity),
          percent: percentUsed(used, capacity),
          over: used > capacity,
        }
      : null;
  // One reported figure still has an age and a freshness worth showing, even with no share.
  const shown = used !== null || capacity !== null;
  const stale = shown && measurement === 'stale';
  const when = age(measuredAt, nowMs);
  const phrase =
    measurement === 'last-observed'
      ? when
        ? `Last observed ${when}`
        : 'Last observed'
      : `${stale ? 'Stale' : 'Current'}${when ? `, measured ${when}` : ''}`;
  const status = figures ? phrase : shown ? `Share unknown. ${phrase}` : 'Unknown';
  const spokenPercent =
    figures?.percent === '<1%' ? 'less than 1 percent' : figures?.percent.replace('%', ' percent');
  const name = [
    label,
    figures ? `${spokenPercent} used` : used !== null ? 'share unknown' : 'usage unknown',
    figures?.over ? 'above capacity' : null,
    shown ? spokenMeasurement[measurement] : null,
    updating ? 'updating' : null,
  ]
    .filter(Boolean)
    .join(', ');
  const reason =
    unavailableReason ??
    (used !== null
      ? 'The provider did not report a context capacity for this model.'
      : 'The provider did not report context usage for this model.');

  const height = Number.isFinite(size) && size > 0 ? size : 28;
  // Strokes and gaps are set in screen pixels so the outline stays crisp at 24px and at 96px.
  const unit = (pixels: number) => Number(((pixels * 100) / height).toFixed(3));
  // Any share above zero keeps at least a 5px sliver, so a small reading never looks empty. The
  // outline and the level line cover about 2px at the tip, so a thinner sliver shows no color.
  // The sliver can overstate a tiny share. It never understates one.
  const line =
    figures !== null && figures.share > 0 ? Math.min(fillLine(figures.share), 100 - unit(5)) : 100;
  const ids = {
    body: `context-gauge-${uid}`,
    filled: `context-gauge-${uid}-filled`,
    empty: `context-gauge-${uid}-empty`,
    gaps: `context-gauge-${uid}-gaps`,
    hatch: `context-gauge-${uid}-hatch`,
  };
  const anchor = `--context-gauge-${uid}`;

  // Hover is tracked on the button and the popover only, so a stretched parent cannot widen it.
  const enter = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') return;
    window.clearTimeout(leaveTimer.current);
    setHovered(true);
    // Escape after keyboard focus holds until focus leaves. A passing pointer does not undo it.
    if (!focused) setDismissed(false);
  };
  const leave = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') return;
    window.clearTimeout(leaveTimer.current);
    // A short grace period lets the pointer cross the gap between the control and the popover.
    leaveTimer.current = window.setTimeout(() => setHovered(false), 200);
  };

  return (
    <div className={stale ? 'context-gauge is-stale' : 'context-gauge'}>
      <button
        type="button"
        className="context-gauge-button"
        aria-label={name}
        aria-describedby={ids.body}
        style={{ anchorName: anchor }}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onFocus={(event) => {
          if (!event.currentTarget.matches(':focus-visible')) return;
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => {
          setFocused(false);
          setPinned(false);
        }}
        onClick={(event) => {
          const { nativeEvent } = event;
          const hovers =
            nativeEvent instanceof PointerEvent &&
            (nativeEvent.pointerType === 'mouse' || nativeEvent.pointerType === 'pen');
          // A mouse or pen already opens it on hover, so a click pins it and the next click closes
          // it. Touch and keyboard have no hover, so each press shows or hides it.
          const close = hovers ? pinned : open;
          setPinned(!close);
          setDismissed(close);
        }}
      >
        <svg
          className="context-gauge-kite"
          width={Number(((height * WIDTH) / 100).toFixed(2))}
          height={height}
          viewBox={`0 0 ${WIDTH} 100`}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <clipPath id={ids.filled}>
              <rect x={-10} y={line} width={WIDTH + 20} height={110 - line} />
            </clipPath>
            <clipPath id={ids.empty}>
              <rect x={-10} y={-10} width={WIDTH + 20} height={line + 10} />
            </clipPath>
            <mask
              id={ids.gaps}
              maskUnits="userSpaceOnUse"
              x={-10}
              y={-10}
              width={WIDTH + 20}
              height={120}
            >
              <path d={OUTLINE} fill="white" />
              <path
                d={DIVIDERS}
                fill="none"
                stroke="black"
                strokeWidth={Math.max(BRAND_GAP, unit(1))}
              />
            </mask>
            {figures === null && (
              <pattern
                id={ids.hatch}
                width={unit(3)}
                height={unit(3)}
                patternUnits="userSpaceOnUse"
                patternTransform={`rotate(${HATCH_ANGLE})`}
              >
                <line
                  className="context-gauge-hatch"
                  x1={unit(1.5)}
                  y1={0}
                  x2={unit(1.5)}
                  y2={unit(3)}
                  strokeWidth={unit(1)}
                />
              </pattern>
            )}
          </defs>
          {figures === null ? (
            <path d={OUTLINE} fill={`url(#${ids.hatch})`} />
          ) : (
            <>
              <path className="context-gauge-well" d={OUTLINE} clipPath={`url(#${ids.empty})`} />
              <path
                className="context-gauge-divider"
                d={DIVIDERS}
                clipPath={`url(#${ids.empty})`}
                strokeWidth={unit(1)}
              />
            </>
          )}
          {figures !== null && figures.share > 0 && (
            <g
              className="context-gauge-tiles"
              clipPath={`url(#${ids.filled})`}
              mask={`url(#${ids.gaps})`}
            >
              {TILES.map(([tone, points]) => (
                <polygon
                  key={tone}
                  className={`context-gauge-tile is-${tone}`}
                  points={points.map((point) => point.join(',')).join(' ')}
                />
              ))}
            </g>
          )}
          {figures !== null && figures.share > 0 && figures.share < 1 && (
            <path
              className="context-gauge-level"
              d={`M-10 ${line}H${WIDTH + 10}`}
              mask={`url(#${ids.gaps})`}
              strokeWidth={unit(1)}
            />
          )}
          {updating && (
            <path className="context-gauge-halo" d={halo(unit(3))} strokeWidth={unit(1)} />
          )}
          <path
            className="context-gauge-outline"
            d={OUTLINE}
            strokeWidth={unit(1.5)}
            strokeDasharray={figures === null ? `${unit(2.5)} ${unit(2)}` : undefined}
          />
          {updating && (
            <path
              className="context-gauge-activity"
              d={OUTLINE}
              pathLength={100}
              strokeWidth={unit(2.5)}
            />
          )}
          {stale && (
            <g className="context-gauge-stale-mark" strokeWidth={unit(1)}>
              <circle cx={74} cy={90} r={11} />
              <path d="M74 84V90H79" />
            </g>
          )}
        </svg>
      </button>
      <div
        ref={popover}
        popover="manual"
        role="tooltip"
        className="context-gauge-popover"
        style={{ positionAnchor: anchor }}
        onPointerEnter={enter}
        onPointerLeave={leave}
      >
        <p className="context-gauge-heading">{label}</p>
        <div id={ids.body}>
          <p className="context-gauge-status">{status}</p>
          {shown && (
            <dl className="context-gauge-figures">
              <div>
                <dt>Used</dt>
                <dd>{used === null ? 'Not reported' : tokens(used)}</dd>
              </div>
              <div>
                <dt>Capacity</dt>
                <dd>{capacity === null ? 'Not reported' : tokens(capacity)}</dd>
              </div>
              {figures && (
                <div>
                  <dt>Percent used</dt>
                  <dd>{figures.percent}</dd>
                </div>
              )}
            </dl>
          )}
          {figures?.over && <p>Usage is above the reported capacity. The meter shows full.</p>}
          {figures === null && <p>{reason}</p>}
          {updating && shown && (
            <p>Updating. The meter moves only when a new measurement arrives.</p>
          )}
          <p className="context-gauge-note">
            This is the model's context window, separate from subscription allowance.
          </p>
        </div>
      </div>
    </div>
  );
}
