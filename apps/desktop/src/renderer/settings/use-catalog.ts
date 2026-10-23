import type { ChatCatalogRead } from '@crewkite/contracts';
import { useEffect, useState } from 'react';
import { readCatalog, type ThreadSource } from '../thread/commands.ts';

/**
 * The model catalog the composer offers. It reads again whenever `changed` does, so a new usage
 * observation or a sign-in shows up without a reload. The last good read stays on screen while the
 * next one is in flight.
 */
export function useCatalog(source: ThreadSource | undefined, changed: unknown) {
  const [catalog, setCatalog] = useState<ChatCatalogRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `changed` is the refresh trigger
  useEffect(() => {
    if (!source) return;
    let active = true;
    readCatalog(source).then(
      (next) => {
        if (!active) return;
        setCatalog(next);
        setError(null);
      },
      (failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error ? failure.message : 'The model list could not be read.',
          );
      },
    );
    return () => {
      active = false;
    };
  }, [source, changed]);
  return { catalog, error };
}

/** Display time that ticks. A preview shows its fixtures at the time they were observed. */
export function useClock(fixtureTime: number | null, intervalMs: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (fixtureTime !== null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [fixtureTime, intervalMs]);
  return fixtureTime ?? now;
}
