import type { Snapshot } from '@crewkite/contracts';
import { useEffect, useState } from 'react';
import type { UsageCard, UsageReading } from '../usage-gauges.tsx';
import {
  anthropicUsageCard,
  type UsageGaugeCard,
  type UsageGaugeReading,
} from '../usage-presentation.ts';

function usageReading(value: UsageGaugeReading, label = value.label): UsageReading {
  const { reserveNote, ...facts } = value;
  return {
    ...facts,
    label,
    ...(reserveNote === null ? {} : { reserveNote: 'See reserve details', note: reserveNote }),
  };
}

/** A card with three readings or fewer shows them all as dials of one size, side by side. */
const DIAL_LIMIT = 3;

/** The gauge cards the Usage page and the thread inspector both show. */
export function usageCards(
  scopes: readonly UsageGaugeCard[],
  snapshot: Pick<Snapshot, 'usageReaders'>,
): UsageCard[] {
  const cards: UsageCard[] = scopes.map((scope) => {
    const primary = [
      ...(scope.primary.weekly ? [usageReading(scope.primary.weekly, 'Weekly')] : []),
      ...(scope.primary.fiveHour ? [usageReading(scope.primary.fiveHour, 'Five-hour')] : []),
    ];
    const featured = scope.featured ? usageReading(scope.featured) : null;
    const auxiliary = scope.satellites
      .filter((reading) => reading !== scope.featured)
      .map((reading) => usageReading(reading));
    const all = [...primary, ...(featured ? [featured] : []), ...auxiliary];
    const even = all.length <= DIAL_LIMIT;
    return {
      id: scope.id,
      title: scope.label,
      tags: scope.fixture ? ['Fixture'] : undefined,
      notice: scope.notice ?? undefined,
      primary: even ? all : primary,
      featured: even ? null : featured,
      auxiliary: even ? [] : auxiliary,
      emptyText: 'No usage observations.',
    };
  });
  const nativeQuota = anthropicUsageCard(snapshot);
  if (nativeQuota) cards.push(nativeQuota);
  return cards;
}

/** Display time for gauges. A preview shows its fixtures at the time they were observed. */
export function useUsageClock(usage: Snapshot['usage'], preview: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (preview) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [preview]);
  return preview
    ? Math.max(0, ...usage.map(({ observation }) => Date.parse(observation.observedAt)))
    : now;
}
