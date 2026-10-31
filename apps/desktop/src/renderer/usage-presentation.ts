import {
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

export function nativeUsageClients(
  snapshot: Pick<Snapshot, 'usageReaders'> & {
    nativeProfiles: readonly Pick<
      Snapshot['nativeProfiles'][number],
      'id' | 'family' | 'available' | 'reason'
    >[];
  },
) {
  return (['openai', 'anthropic', 'google', 'local'] as const).map((family) => ({
    family,
    label: familyLabels[family],
    profiles: snapshot.nativeProfiles.filter((profile) => profile.family === family),
    reader: snapshot.usageReaders.find((reader) => reader.family === family) ?? null,
  }));
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
        label: observation.windowId,
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
    const notices = scope.fixture
      ? ['Fixture data. No account allowance is established.']
      : ['Account and shared-pool identity are unknown.'];
    if (readings.length === 0) notices.push('No usage observations.');
    if (weekly.length > 1 || fiveHour.length > 1)
      notices.push('Multiple provider windows match a primary period; all remain separate.');
    if (family === 'google' && !scope.fixture) {
      if (reader && !reader.available)
        notices.push('Quota reader is unavailable; retained reports remain visible.');
      if (googleReports.size > 1)
        notices.push('Google route reports differ; scopes are shown separately.');
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
      notice: notices.join(' '),
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
  ['no-usage-report', 'The client answered without a usage report. Its reply is below.'],
  ['client-error', 'Check the Anthropic sign-in, then refresh.'],
  ['usage-unavailable', 'Check that the client is signed in with a subscription plan.'],
  ['unreadable-output', 'Refresh to read it again.'],
]);

/** The status line for the last Anthropic usage read. */
export function anthropicReadReason(reason: string, clientVersion: string): string {
  const failed = failedReads.get(reason);
  if (!failed) return `Last refresh: ${reason}.`;
  const version = clientVersion === 'unknown' ? 'the client version' : `client ${clientVersion}`;
  return `Last refresh failed. ${failed} ${nextSteps.get(reason) ?? `Update CrewKite or report ${version}.`}`;
}

const primaryLabels = new Map([
  ['weekly', 'Weekly'],
  ['five-hour', 'Five-hour'],
]);

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
    label: primaryLabels.get(window.windowId) ?? window.windowId,
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
  const primary = [...primaryLabels.keys()].flatMap((id) =>
    rows.filter((row) => row.windowId === id),
  );
  return {
    id: 'native-quota:anthropic',
    title: 'Anthropic native quota',
    scope: 'Native local usage report',
    tags: [matching ? 'Current scope' : 'Earlier or unknown scope'],
    // Each gauge says how long ago CrewKite read the report. Details say the report has no time of its own.
    notice: reading ? undefined : 'Refresh Anthropic quota to read the native report.',
    primary,
    auxiliary: rows.filter((row) => !primary.includes(row)),
    credits: reading?.extraUsage
      ? [
          {
            id: 'native-extra-usage',
            label: 'Extra usage',
            value: reading.extraUsage.is_enabled ? 'Enabled' : 'Disabled',
            note: 'Separate from included allowance.',
          },
        ]
      : [],
    emptyText: 'No subscription allowance was reported. Coding allowance remains unknown.',
  };
}

// Percent remaining and hue, from full to empty. Green holds near the top, yellow arrives by
// 60 percent, orange by 40 and red near empty, linear between stops.
const hueStops: readonly (readonly [number, number])[] = [
  [100, 120],
  [80, 100],
  [60, 55],
  [40, 35],
  [20, 15],
  [0, 0],
];

/** The ring color's hue for a percent remaining, one rule for every family. Age never changes it. */
export function gaugeHue(percentRemaining: number): number {
  const percent = Math.min(100, Math.max(0, percentRemaining));
  for (let i = 1; i < hueStops.length; i++) {
    const [low, lowHue] = hueStops[i];
    const [high, highHue] = hueStops[i - 1];
    if (percent >= low) return lowHue + ((percent - low) * (highHue - lowHue)) / (high - low);
  }
  return 0;
}
export const gaugeColor = (percentRemaining: number) =>
  `hsl(${Math.round(gaugeHue(percentRemaining))} 72% 46%)`;

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

/** How long ago CrewKite read a report, in minutes and then hours. */
export function readAgo(readAt: string | null | undefined, nowMs: number): string | null {
  const at = readAt ? Date.parse(readAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (minutes < 1) return 'Read just now';
  return minutes < 60 ? `Read ${minutes} min ago` : `Read ${Math.floor(minutes / 60)} h ago`;
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
  read: string | null;
  /** The hardware and model line for Local, with every unknown part left out. */
  detail: string | null;
};

const barNames = { 'five-hour': '5 h', weekly: 'week' } as const;
const percentText = (percent: number | null) =>
  percent === null ? 'unknown' : `${Math.floor(percent)}%`;

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
  const entries = catalog.families.some(({ family }) => family === 'local')
    ? catalog.families
    : [...catalog.families, localPlaceholder];
  return entries.map((entry) => {
    const model = modelFor(entry);
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
    // A provider that is not connected and has read nothing keeps its row with Connect, so the
    // rail shows one gauge per provider. It has no bar to draw yet.
    const unread =
      entry.family !== 'local' &&
      !entry.connected &&
      !entry.remaining.some((window) => window.percent !== null);
    const bars: RailBar[] =
      unlimited || setUp || unread
        ? []
        : both
          ? (['five-hour', 'weekly'] as const).map((label) => {
              const { percent } = period(label);
              return { text: `${barNames[label]} ${percentText(percent)}`, percent };
            })
          : [
              {
                text:
                  tightest.percent === null ? 'unknown' : `${percentText(tightest.percent)} left`,
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
      needsConnect: !entry.connected && !setUp,
      setUp,
      read: readAgo(entry.readAt, nowMs),
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
