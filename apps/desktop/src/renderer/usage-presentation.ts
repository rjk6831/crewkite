import {
  canonicalJson,
  type Observation,
  type Policy,
  type Route,
  type Snapshot,
  type Window,
} from '@crewkite/contracts';

type Reserve = Policy['reserves'][number];
type UsageReader = Snapshot['usageReaders'][number];

export type UsageGaugeReading = Pick<
  Observation,
  'windowId' | 'remaining' | 'resetsAt' | 'observedAt' | 'source' | 'confidence'
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
  if (Date.parse(observation.observedAt) > nowMs) return 'unknown';
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
        state: displayState(window, nowMs),
        ...readingReserve(routeIds, observation, reserves),
      };
    });
    const candidates = (periodSeconds: number) =>
      readings.filter((_, index) => {
        const semantics = orderedWindows[index].observation.semantics;
        return semantics?.scope === 'provider' && semantics.periodSeconds === periodSeconds;
      });
    const weekly = candidates(604800);
    const fiveHour = candidates(18000);
    const primary = {
      weekly: weekly.length === 1 ? weekly[0] : null,
      fiveHour: fiveHour.length === 1 ? fiveHour[0] : null,
    };
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
      satellites: readings.filter((reading) => !Object.values(primary).includes(reading)),
      reader: family === 'google' && !scope.fixture ? reader : null,
      notice: notices.join(' '),
    };
  });
}
