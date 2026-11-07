import {
  allowanceExhausted,
  type ChatCatalogEntry,
  type ChatCatalogRead,
  type ChatFamily,
  canonicalJson,
  type LocalHardwareStatus,
  type LocalSetup,
  type Observation,
  type Policy,
  type Route,
  type Snapshot,
  tightestAllowance,
  type Window,
  windowAppliesTo,
} from '@crewkite/contracts';

import { formatSize } from './format-size.ts';
import type { UsageCard, UsageReading } from './usage-gauges.tsx';

type Reserve = Policy['reserves'][number];
type UsageReader = Snapshot['usageReaders'][number];

export type UsageGaugeReading = Pick<
  Observation,
  'windowId' | 'semantics' | 'remaining' | 'resetsAt' | 'observedAt' | 'source' | 'confidence'
> & {
  id: string;
  label: string;
  state: Window['state'];
  reserve: Pick<Reserve, 'value' | 'unit'> | null;
  reserveNote: string | null;
};

export type UsageGaugeCard = {
  id: string;
  family: Route['family'];
  label: string;
  scopeLabel: string;
  routeIds: readonly string[];
  fixture: boolean;
  primary: { weekly: UsageGaugeReading | null; fiveHour: UsageGaugeReading | null };
  featured: UsageGaugeReading | null;
  satellites: readonly UsageGaugeReading[];
  reader: UsageReader | null;
  notice: string | null;
};

type Scope = { routes: Route[]; windows: Window[]; fixture: boolean; shared: boolean };
const familyLabels = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', local: 'Local' };
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const windowFacts = (window: Window) => {
  const { routeId: _routeId, ...observation } = window.observation;
  return canonicalJson({ observation, state: window.state });
};
const scopeFacts = (windows: readonly Window[]) =>
  canonicalJson(windows.map(windowFacts).sort(compare));

function displayState(window: Window, nowMs: number): Window['state'] {
  const observation = window.observation;
  // A snapshot may arrive after the last display tick. Larger clock differences
  // still leave the reading unknown.
  if (Date.parse(observation.observedAt) > nowMs + 60_000) return 'unknown';
  if (observation.resetsAt !== null && Date.parse(observation.resetsAt) <= nowMs)
    return 'reset-pending';
  if (observation.remaining === null) return 'unknown';
  if (window.state === 'fresh' && nowMs - Date.parse(observation.observedAt) > 300000)
    return 'stale';
  return window.state;
}

function readingReserve(
  routeIds: readonly string[],
  observation: Observation,
  reserves: readonly Reserve[] | null,
): Pick<UsageGaugeReading, 'reserve' | 'reserveNote'> {
  if (!reserves) return { reserve: null, reserveNote: null };
  const perRoute = routeIds.map((routeId) =>
    reserves.filter(
      (reserve) => reserve.routeId === routeId && reserve.windowId === observation.windowId,
    ),
  );
  const supplied = perRoute.flat();
  if (supplied.length === 0) return { reserve: null, reserveNote: null };
  const first = supplied[0];
  const same = perRoute.every(
    (values) =>
      values.length === 1 && values[0].unit === first.unit && values[0].value === first.value,
  );
  if (same && observation.remaining?.unit === first.unit)
    return { reserve: { value: first.value, unit: first.unit }, reserveNote: null };
  const reason = !same
    ? 'Route reserves differ or repeat.'
    : observation.remaining === null
      ? 'The reserve unit cannot be matched to an unknown amount.'
      : 'The reserve unit differs from the reported amount.';
  return {
    reserve: null,
    reserveNote: `${reason} ${supplied.map((value) => `${value.routeId}: ${value.value} ${value.unit}`).join('; ')}`,
  };
}

/**
 * The order a person sees the providers in, everywhere: Google, OpenAI, Anthropic, Local (ADR 0053).
 * It follows the kite's panels from the top left, counter clockwise. Stored data keeps its own
 * order; only what is drawn follows this one.
 */
export const FAMILY_DISPLAY_ORDER = ['google', 'openai', 'anthropic', 'local'] as const;

/** Sorts anything with a family into the display order. */
export function inDisplayOrder<T extends { family: ChatFamily }>(values: readonly T[]): T[] {
  return [...values].sort(
    (a, b) => FAMILY_DISPLAY_ORDER.indexOf(a.family) - FAMILY_DISPLAY_ORDER.indexOf(b.family),
  );
}

export function nativeUsageClients(
  snapshot: Pick<Snapshot, 'usageReaders'> & {
    nativeProfiles: readonly Pick<
      Snapshot['nativeProfiles'][number],
      'id' | 'family' | 'available' | 'reason'
    >[];
  },
) {
  return FAMILY_DISPLAY_ORDER.map((family) => ({
    family,
    label: familyLabels[family],
    profiles: snapshot.nativeProfiles.filter((profile) => profile.family === family),
    reader: snapshot.usageReaders.find((reader) => reader.family === family) ?? null,
  }));
}

// Plain names for the usage windows the readers report. A window not listed here reads as its ID
// turned into words, so a new one never shows as a raw ID.
const windowNames = new Map([
  ['weekly', 'Weekly'],
  ['five-hour', 'Five-hour'],
  ['gemini-weekly', 'Weekly'],
  ['gemini-5h', 'Five-hour'],
  ['gemini-argon-wtu-weekly', 'Gemini 4 Argon, weekly'],
  // Google keeps a separate allowance, reported as 3p, for the other vendors' models it serves.
  // The gemini windows above are the Gemini models' own.
  ['3p-5h', 'Non-Gemini models, 5 h'],
  ['3p-weekly', 'Non-Gemini models, weekly'],
]);
const windowWords = new Map([
  ['3p', 'Non-Gemini models'],
  ['wtu', ''],
]);

// A per-model window, such as weekly-fable, names the model first: "Fable, weekly".
const modelWindow = /^(weekly|five-hour)-([a-z][a-z0-9.-]*)$/;

// A window whose ID is a limit bucket and a slot, such as main:primary, is named by its length.
const bucketWindow = /^([a-z0-9_.-]+):(primary|secondary)$/i;

/** A window length in words: Weekly, Five-hour, or its hours or days. */
function periodName(seconds: number): string {
  if (seconds === 604_800) return 'Weekly';
  if (seconds === 18_000) return 'Five-hour';
  if (seconds % 86_400 === 0) return `${seconds / 86_400} d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} h`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * The name a usage window shows, from its reader's window ID and, when the reader reported it,
 * the window's length in seconds. A bucket and slot ID never shows raw.
 */
export function windowLabel(windowId: string, periodSeconds?: number): string {
  const known = windowNames.get(windowId);
  if (known) return known;
  const bucket = bucketWindow.exec(windowId);
  if (bucket) {
    const length =
      periodSeconds !== undefined
        ? periodName(periodSeconds)
        : bucket[2].toLowerCase() === 'primary'
          ? 'Main window'
          : 'Second window';
    // The plan's own bucket has no suffix. A model's bucket adds its name after an underscore.
    const model = bucket[1].split('_').slice(1).join(' ');
    return model === ''
      ? length
      : `${model[0].toUpperCase()}${model.slice(1)}, ${length.toLowerCase()}`;
  }
  const model = modelWindow.exec(windowId.toLowerCase());
  if (model) {
    const name = model[2].replace(/-/g, ' ');
    return `${name[0].toUpperCase()}${name.slice(1)}, ${model[1] === 'weekly' ? 'weekly' : 'five-hour'}`;
  }
  const words = windowId
    .split(/[-_\s]+/)
    .map((part) => {
      const lower = part.toLowerCase();
      const span = /^(\d+)([hdm])$/.exec(lower);
      if (span) return `${span[1]} ${span[2]}`;
      return windowWords.get(lower) ?? lower;
    })
    .filter((word) => word !== '');
  const text = words.join(' ');
  return text === '' ? windowId : text[0].toUpperCase() + text.slice(1);
}

/** Projection keeps report identity separate from account identity and execution admission. */
export function projectUsagePresentation(
  snapshot: Pick<Snapshot, 'routes' | 'usage' | 'usageReaders'>,
  reserves: readonly Reserve[] | null,
  nowMs: number,
): UsageGaugeCard[] {
  if (!Number.isFinite(nowMs)) throw new RangeError('Usage display time must be finite.');
  const reader = snapshot.usageReaders.find((value) => value.id === 'google-usage-v1') ?? null;
  const scopes: Scope[] = [];
  for (const route of [...snapshot.routes].sort((a, b) => compare(a.id, b.id))) {
    if (route.family === 'local') continue;
    const windows = snapshot.usage.filter((value) => value.observation.routeId === route.id);
    const groups =
      route.fake || windows.length === 0
        ? [{ windows, fixture: route.fake }]
        : [
            {
              windows: windows.filter((value) => value.observation.source !== 'fixture'),
              fixture: false,
            },
            {
              windows: windows.filter((value) => value.observation.source === 'fixture'),
              fixture: true,
            },
          ].filter((group) => group.windows.length > 0);
    for (const group of groups) scopes.push({ routes: [route], ...group, shared: false });
  }

  const fanouts = new Map<string, Scope>();
  const cards: Scope[] = [];
  for (const scope of scopes) {
    const knownFanout =
      scope.routes[0].family === 'google' &&
      !scope.fixture &&
      !!reader?.lastObservedAt &&
      scope.windows.length > 0 &&
      scope.windows.every(
        ({ observation }) =>
          observation.source === 'client' &&
          observation.confidence === 'reported' &&
          observation.observedAt === reader.lastObservedAt,
      );
    if (!knownFanout) {
      cards.push(scope);
      continue;
    }
    const signature = scopeFacts(scope.windows);
    const previous = fanouts.get(signature);
    if (previous) {
      previous.routes.push(...scope.routes);
      previous.shared = true;
    } else {
      fanouts.set(signature, scope);
      cards.push(scope);
    }
  }
  const googleReports = new Set(
    scopes
      .filter(
        (scope) =>
          scope.routes[0].family === 'google' && !scope.fixture && scope.windows.length > 0,
      )
      .map((scope) => scopeFacts(scope.windows)),
  );

  return cards.map((scope) => {
    const routeIds = scope.routes.map((route) => route.id).sort(compare);
    const family = scope.routes[0].family;
    const id = `${family}:${scope.fixture ? 'fixture' : 'live'}:${routeIds.join(',')}`;
    const occurrences = new Map<string, number>();
    const orderedWindows = [...scope.windows].sort(
      (a, b) =>
        compare(a.observation.windowId, b.observation.windowId) ||
        compare(windowFacts(a), windowFacts(b)),
    );
    const readings = orderedWindows.map((window) => {
      const observation = window.observation;
      const occurrence = occurrences.get(observation.windowId) ?? 0;
      occurrences.set(observation.windowId, occurrence + 1);
      return {
        id: `${id}:${observation.windowId}:${occurrence}`,
        windowId: observation.windowId,
        label: windowLabel(observation.windowId, observation.semantics?.periodSeconds),
        remaining: observation.remaining,
        resetsAt: observation.resetsAt,
        observedAt: observation.observedAt,
        source: observation.source,
        confidence: observation.confidence,
        ...(observation.semantics ? { semantics: observation.semantics } : {}),
        state: displayState(window, nowMs),
        ...readingReserve(routeIds, observation, reserves),
      };
    });
    const candidates = (periodSeconds: number) =>
      readings.filter(
        ({ semantics }) =>
          semantics?.scope === 'provider' && semantics.periodSeconds === periodSeconds,
      );
    const weekly = candidates(604800);
    const fiveHour = candidates(18000);
    const primary = {
      weekly: weekly.length === 1 ? weekly[0] : null,
      fiveHour: fiveHour.length === 1 ? fiveHour[0] : null,
    };
    // One model pool can take the center dial. Several stay in the auxiliary list; none is
    // promoted. The featured reading stays a satellite too, so a host that does not draw the
    // center dial still shows it.
    const models = readings.filter(({ semantics }) => semantics?.scope === 'model');
    const featured = models.length === 1 ? models[0] : null;
    const notices = scope.fixture ? ['Fixture data. No account allowance is established.'] : [];
    if (readings.length === 0) notices.push('No usage observations.');
    if (weekly.length > 1 || fiveHour.length > 1)
      notices.push('Several windows share a period, so each shows on its own.');
    if (family === 'google' && !scope.fixture) {
      if (reader && !reader.available)
        notices.push('The quota reader is not available. The last readings stay in view.');
      if (googleReports.size > 1)
        notices.push('Google routes report different readings, so each shows on its own.');
    }
    return {
      id,
      family,
      label: familyLabels[family],
      scopeLabel: scope.shared
        ? 'Shared Google reader report'
        : `${scope.fixture ? 'Fixture route' : 'Route'}: ${scope.routes[0].displayName}`,
      routeIds,
      fixture: scope.fixture,
      primary,
      featured,
      satellites: readings.filter((reading) => !Object.values(primary).includes(reading)),
      reader: family === 'google' && !scope.fixture ? reader : null,
      notice: notices.length > 0 ? notices.join(' ') : null,
    };
  });
}

// What each failed usage read was missing. Codes not listed here are shown as they are.
const failedReads = new Map([
  ['no-usage-report', 'The client printed no usage report before it exited.'],
  ['no-result', 'The client exited without a result frame.'],
  [
    'unreadable-report',
    'The usage report in the assistant frame has a rate limit CrewKite cannot read.',
  ],
  ['not-json', 'The client printed a line that is not JSON.'],
  ['client-error', 'The result frame reported an error.'],
  ['usage-unavailable', 'The usage report had no rate limits.'],
  ['unreadable-output', 'An earlier CrewKite version could not read the client output.'],
]);
const nextSteps = new Map([
  [
    'no-usage-report',
    'The client answers this way when its sign-in has expired or it bills an API key. Run claude auth login in Terminal with your Claude subscription account, then check the Anthropic sign-in. Its reply is below.',
  ],
  ['client-error', 'Check the Anthropic sign-in, then refresh.'],
  ['usage-unavailable', 'Check that the client is signed in with a subscription plan.'],
  ['unreadable-output', 'Refresh to read it again.'],
]);

/** The status line for a failed Anthropic usage read. Null when the read did not fail. */
export function anthropicReadReason(reason: string, clientVersion: string): string | null {
  const failed = failedReads.get(reason);
  if (!failed) return null;
  const version = clientVersion === 'unknown' ? 'the client version' : `client ${clientVersion}`;
  return `Last refresh failed. ${failed} ${nextSteps.get(reason) ?? `Update CrewKite or report ${version}.`}`;
}

const primaryWindows = ['weekly', 'five-hour'];

/** The Anthropic card is built from its reader, not from a route, so it carries its own ID. */
export const ANTHROPIC_USAGE_CARD_ID = 'native-quota:anthropic';

/**
 * The provider a usage card belongs to, so its header can carry that provider's refresh. Route
 * cards map through their scopes; the Anthropic card is its reader's own.
 */
export function usageCardFamily(
  cardId: string,
  scopeFamilies: ReadonlyMap<string, ChatFamily>,
): ChatFamily | undefined {
  return cardId === ANTHROPIC_USAGE_CARD_ID ? 'anthropic' : scopeFamilies.get(cardId);
}

/** The controller turned the report's used percent into what remains. */
export function anthropicUsageCard(snapshot: Pick<Snapshot, 'usageReaders'>): UsageCard | null {
  const reader = snapshot.usageReaders.find((value) => value.id === 'anthropic-usage-v1');
  if (!reader) return null;
  const reading = reader.reading;
  const scope = reader.readingScopeHash ?? 'unknown';
  const matching = !!reader.trust && scope === reader.trust.scopeHash;
  const rows: UsageReading[] = (reading?.windows ?? []).map((window, index) => ({
    id: `${index}:${window.windowId}`,
    windowId: window.windowId,
    label: windowLabel(window.windowId),
    remaining: window.remaining,
    state: 'reported',
    // The report carries no observation time of its own. The time CrewKite received it is the
    // newest the reading can be, so the gauge ages from there.
    observedAt: reading?.receivedAt ?? null,
    resetsAt: window.resetsAt,
    source: 'client',
    confidence: 'reported',
    readAt: reading?.receivedAt ?? null,
    note: `Read when CrewKite received the report. The report gives no observation time or cache age. Report scope ${scope}.`,
  }));
  const primary = primaryWindows.flatMap((id) => rows.filter((row) => row.windowId === id));
  // A single per-model window, such as weekly-fable, sits between the two main gauges as a smaller
  // one, the way the Google card shows its model window.
  const models = rows.filter(
    (row) => !primary.includes(row) && modelWindow.test(row.windowId ?? ''),
  );
  const featured = models.length === 1 ? models[0] : null;
  return {
    id: ANTHROPIC_USAGE_CARD_ID,
    title: 'Anthropic subscription',
    // A report read under another sign-in says so. A current one needs no tag.
    tags: matching ? [] : ['May be from an earlier sign-in'],
    // Each gauge says how long ago CrewKite read the report. Details say the report has no time of its own.
    notice: reading ? undefined : 'Refresh Anthropic quota to read the native report.',
    primary,
    featured,
    auxiliary: rows.filter((row) => !primary.includes(row) && row !== featured),
    // The client reports extra usage as on only while the account holds a credit balance; with the
    // switch on and no balance it reports off. So the card shows the row when the report says on
    // and leaves it out otherwise, since off can mean either.
    credits: reading?.extraUsage?.is_enabled
      ? [
          {
            id: 'native-extra-usage',
            label: 'Extra usage',
            value: 'On',
            note: 'Paid credits used after the included allowance.',
          },
        ]
      : [],
    emptyText: 'No subscription allowance was reported. Coding allowance remains unknown.',
  };
}

// Percent remaining and the colour at that point, from full to empty: bright green, greenish
// yellow, yellow, orange yellow, orange, orange red, red and deep red. Hue, saturation and
// lightness all move between stops, so readings 10 to 15 points apart look different.
const toneStops: readonly (readonly [number, GaugeTone])[] = [
  [100, { hue: 130, saturation: 68, lightness: 40 }],
  [85, { hue: 88, saturation: 70, lightness: 42 }],
  [70, { hue: 58, saturation: 80, lightness: 44 }],
  [55, { hue: 44, saturation: 88, lightness: 47 }],
  [40, { hue: 32, saturation: 90, lightness: 48 }],
  [25, { hue: 18, saturation: 85, lightness: 47 }],
  [10, { hue: 4, saturation: 78, lightness: 44 }],
  [0, { hue: 0, saturation: 75, lightness: 32 }],
];

export type GaugeTone = { hue: number; saturation: number; lightness: number };

/**
 * The fill colour for a percent remaining as hue, saturation and lightness, linear between stops.
 * One rule for every family, in the desktop and the terminal. Age never changes it.
 */
export function gaugeTone(percentRemaining: number): GaugeTone {
  const percent = Math.min(100, Math.max(0, percentRemaining));
  for (let i = 1; i < toneStops.length; i++) {
    const [low, lowTone] = toneStops[i];
    const [high, highTone] = toneStops[i - 1];
    if (percent >= low) {
      const share = (percent - low) / (high - low);
      const mix = (key: keyof GaugeTone) => lowTone[key] + share * (highTone[key] - lowTone[key]);
      return { hue: mix('hue'), saturation: mix('saturation'), lightness: mix('lightness') };
    }
  }
  return toneStops[toneStops.length - 1][1];
}

/** The hue of `gaugeTone`. */
export const gaugeHue = (percentRemaining: number) => gaugeTone(percentRemaining).hue;
export function gaugeColor(percentRemaining: number) {
  const { hue, saturation, lightness } = gaugeTone(percentRemaining);
  return `hsl(${Math.round(hue)} ${Math.round(saturation)}% ${Math.round(lightness)}%)`;
}

/** A ring past this many minutes without a read is drawn dotted. */
export const GAUGE_DOTTED_AFTER_MIN = 60;

/**
 * How old a gauge reading is, as the label under the gauge: "read 4 min ago", "read 2 h ago" or
 * "age unknown". A time that cannot be read, or that lies more than a minute ahead of the clock,
 * is unknown. `dotted` is true once the read is more than 60 minutes old.
 */
export function gaugeAge(
  readAt: string | null | undefined,
  nowMs: number,
): { label: string; dotted: boolean } {
  const at = readAt ? Date.parse(readAt) : Number.NaN;
  if (!Number.isFinite(at) || at - nowMs > 60_000) return { label: 'age unknown', dotted: false };
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  const label =
    minutes < 1
      ? 'read just now'
      : minutes < 60
        ? `read ${minutes} min ago`
        : minutes < 1440
          ? `read ${Math.floor(minutes / 60)} h ago`
          : `read ${Math.floor(minutes / 1440)} d ago`;
  return { label, dotted: minutes > GAUGE_DOTTED_AFTER_MIN };
}

/**
 * How long ago CrewKite read a report, in minutes and then hours. `short` writes "read 3 m ago"
 * for the rail, where the line has to fit beside the reset time.
 */
export function readAgo(
  readAt: string | null | undefined,
  nowMs: number,
  short = false,
): string | null {
  const at = readAt ? Date.parse(readAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  const read = short ? 'read' : 'Read';
  if (minutes < 1) return `${read} just now`;
  return minutes < 60
    ? `${read} ${minutes} ${short ? 'm' : 'min'} ago`
    : `${read} ${Math.floor(minutes / 60)} h ago`;
}

export type RailBar = { text: string; percent: number | null };
export type RailFamily = {
  family: ChatFamily;
  /** Two bars when the family reports a five-hour and a weekly window, else one. Empty for Local and for a family not connected that has read nothing. */
  bars: RailBar[];
  /** The family runs on this computer and reports no allowance. */
  unlimited: boolean;
  /** Milliseconds until the tightest window resets. Null when unknown or already passed. */
  resetsIn: number | null;
  resetPassed: boolean;
  /** Usage reads, but chat waits for Connect in Settings. */
  needsConnect: boolean;
  /** Local with no endpoint saved. The row reads "Set up" and opens the Local card. */
  setUp: boolean;
  /** This computer cannot run the family. The row stays, greyed, and says so. */
  unavailable: boolean;
  read: string | null;
  /** The hardware and model line for Local, with every unknown part left out. */
  detail: string | null;
};

const barNames = { 'five-hour': '5 h', weekly: 'week' } as const;
const percentText = (percent: number | null) =>
  percent === null ? 'unknown' : `${Math.floor(percent)}%`;

/**
 * What a family's bar says once its included allowance is used up, or null to leave the bar as
 * it is. No credits keeps the empty bar with its own words. A switch the person turned off pauses
 * the rest. The balance shows as the provider wrote it, with no currency.
 */
export function creditText(
  entry: Pick<ChatCatalogEntry, 'remaining' | 'credits' | 'creditSpending'>,
  model: string | null,
): string | null {
  if (entry.creditSpending === undefined || !allowanceExhausted(entry, model)) return null;
  const state = entry.credits?.state;
  if (state === 'none') return 'No credits';
  if (!entry.creditSpending) return 'Credits paused';
  if (state === 'available')
    return entry.credits?.balance ? `Credits ${entry.credits.balance} left` : 'Credits available';
  if (state === 'unlimited') return 'Credits unlimited';
  if (state === 'extra-usage-on') return 'Extra usage on';
  return null;
}

/**
 * One row per family, connected or not. A family that is not connected reads its usage when it
 * can, and shows Connect with no bar when it has read nothing.
 * The catalog labels each window five-hour or weekly when it knows the period. Within a period the
 * window with the least left for the family's model wins, so a weekly pool for another model does
 * not count. The reset line follows the tightest window overall, the same one the picker shows.
 */
export function railFamilies(
  catalog: ChatCatalogRead | null,
  nowMs: number,
  options: {
    modelFor?: (entry: ChatCatalogEntry) => string | null;
    hardware?: LocalHardwareStatus | null;
    localSetup?: LocalSetup | null;
  } = {},
): RailFamily[] {
  if (!catalog) return [];
  const modelFor = options.modelFor ?? ((entry) => entry.defaultModel);
  // Local is on the rail whatever its state, so a machine that never set it up can start there.
  const entries = inDisplayOrder(
    catalog.families.some(({ family }) => family === 'local')
      ? catalog.families
      : [...catalog.families, localPlaceholder],
  );
  return entries.map((entry) => {
    const model = modelFor(entry);
    // A family this computer cannot run keeps its row, greyed, so every computer shows the same
    // four rows in the same order. Today that is Google on Linux.
    const unavailable = entry.reason === 'unsupported-platform';
    const setUp =
      entry.family === 'local' &&
      !entry.connected &&
      (options.localSetup ? options.localSetup.endpoint === null : entry.needsConnect !== true);
    const unlimited = entry.family === 'local' && entry.remaining.length === 0 && !setUp;
    const reported = entry.remaining.map((window) => window.windowId);
    const applies = entry.remaining.filter((window) => windowAppliesTo(window, model, reported));
    const period = (label: keyof typeof barNames) =>
      tightestAllowance(
        { remaining: applies.filter((window) => window.label.toLowerCase() === label) },
        null,
      );
    const both = (['five-hour', 'weekly'] as const).every((label) =>
      applies.some((window) => window.label.toLowerCase() === label),
    );
    const tightest = tightestAllowance(entry, model);
    const credit = creditText(entry, model);
    // A plan with no five-hour window but a weekly window for one model, such as Anthropic Ultra
    // since 6 November 2026, keeps two lines: the provider's weekly window and that model's. The
    // model window that limits the family's model comes first, else the one with the least left.
    const fiveHour = entry.remaining.some((window) => window.label.toLowerCase() === 'five-hour');
    const weekly = entry.remaining.find(
      (window) => window.windowId === 'weekly' && window.percent !== null,
    );
    const scoped = entry.remaining.filter(
      (window) =>
        window.windowId.startsWith('weekly-') &&
        window.label.toLowerCase() === 'weekly' &&
        window.percent !== null,
    );
    const modelWindow =
      scoped.find((window) => applies.includes(window)) ??
      [...scoped].sort((left, right) => (left.percent ?? 0) - (right.percent ?? 0))[0];
    const pair = !fiveHour && !both && weekly && modelWindow ? [weekly, modelWindow] : null;
    // A provider that is not connected and has read nothing keeps its row with Connect, so the
    // rail shows one gauge per provider. It has no bar to draw yet. Google reads its quota only
    // once it is connected, so until then its row is Connect alone, whatever an older read left.
    const unread =
      entry.family !== 'local' &&
      !entry.connected &&
      (entry.family === 'google' || !entry.remaining.some((window) => window.percent !== null));
    const bars: RailBar[] =
      unlimited || setUp || unread || unavailable
        ? []
        : credit
          ? [{ text: credit, percent: tightest.percent }]
          : both
            ? (['five-hour', 'weekly'] as const).map((label) => {
                const { percent } = period(label);
                return { text: `${barNames[label]} ${percentText(percent)}`, percent };
              })
            : pair
              ? pair.map((window, index) => ({
                  text: `${index === 0 ? barNames.weekly : (windowLabel(window.windowId).split(',')[0] ?? window.windowId)} ${percentText(window.percent)}`,
                  percent: window.percent,
                }))
              : [
                  {
                    text:
                      tightest.percent === null
                        ? 'unknown'
                        : `${percentText(tightest.percent)} left`,
                    percent: tightest.percent,
                  },
                ];
    const until = tightest.resetsAt ? Date.parse(tightest.resetsAt) - nowMs : null;
    return {
      family: entry.family,
      bars,
      unlimited,
      resetsIn: until !== null && until > 0 ? until : null,
      resetPassed: until !== null && until <= 0,
      needsConnect: !entry.connected && !setUp && !unavailable,
      unavailable,
      setUp,
      read: readAgo(entry.readAt, nowMs, true),
      detail:
        entry.family === 'local'
          ? localFacts(options.hardware, options.localSetup, entry.lastTurnStats).line
          : null,
    };
  });
}

// A catalog that predates Local, or one read before it, still gets a Local row.
const localPlaceholder: ChatCatalogEntry = {
  family: 'local',
  connected: false,
  reason: 'not-configured',
  models: [],
  defaultModel: null,
  remaining: [],
  readAt: null,
  accepts: null,
};

/**
 * What the machine and the loaded model report, for the Local card rows and the rail hover. A
 * part the controller has not observed stays null and drops out of the line.
 */
export function localFacts(
  hardware: LocalHardwareStatus | null | undefined,
  setup: LocalSetup | null | undefined,
  stats: ChatCatalogEntry['lastTurnStats'],
) {
  const loaded = setup?.observation?.models.filter((choice) => choice.state === 'loaded-eligible');
  const choice =
    loaded?.find((value) => value.selectionId === setup?.selection?.selectionId) ?? null;
  const total = hardware?.totalMemoryBytes ?? null;
  const free = hardware?.availableMemoryBytes ?? null;
  const name = choice
    ? [choice.identity.displayName, choice.identity.quantization?.name].filter(Boolean).join(' ')
    : null;
  const facts = {
    processor: hardware?.cpuModel ?? hardware?.gpuModel ?? null,
    gpu: hardware?.gpuCores ? `${hardware.gpuCores} GPU cores` : null,
    memory:
      total === null
        ? null
        : `${formatSize(total)} memory${free === null ? '' : `, ${formatSize(free)} available`}`,
    model: choice
      ? [
          name,
          formatSize(choice.identity.sizeBytes),
          choice.contextLength === null
            ? null
            : `${choice.contextLength.toLocaleString('en-US')} context`,
        ]
          .filter(Boolean)
          .join(', ')
      : null,
    speed:
      stats?.tokensPerSecond == null ? null : `${stats.tokensPerSecond.toFixed(1)} tok/s last turn`,
  };
  const parts = Object.values(facts).filter((value): value is string => value !== null);
  return { ...facts, line: parts.length ? parts.join(' · ') : null };
}
