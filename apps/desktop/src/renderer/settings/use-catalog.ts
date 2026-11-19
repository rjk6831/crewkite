import type { ChatCatalogChange, ChatCatalogRead, ConnectionsRead } from '@crewkite/contracts';
import { useEffect, useState } from 'react';
import { readCatalog, readConnections, type ThreadSource } from '../thread/commands.ts';

/**
 * The model catalog the composer offers. It reads again whenever `changed` does, so a new usage
 * observation or a sign-in shows up without a reload, and when a model read ends. The last good
 * read stays on screen while the next one is in flight.
 */
export function useCatalog(source: ThreadSource | undefined, changed: unknown) {
  const [catalog, setCatalog] = useState<ChatCatalogRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelRead, setModelRead] = useState<ChatCatalogChange | null>(null);
  useEffect(
    () =>
      source?.subscribe((event) => {
        if (event.type === 'chat.catalog') setModelRead(event.payload);
      }),
    [source],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `changed` and `modelRead` trigger the read
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
  }, [source, changed, modelRead]);
  return { catalog, error, modelRead };
}

// Every connections read on screen, so a change made in Settings or the Crew tab shows on the rail
// and in the other at once. No controller event says a connection changed.
const connectionReads = new Set<() => void>();

/** Reads the connections again wherever they show. Call it after a command changed one. */
export function connectionsChanged() {
  for (const again of connectionReads) again();
}

/**
 * The billing connections and what each API connection spent, with one thread's assignments when
 * `taskId` is given. It reads again whenever `changed` does, when a turn ends, since an ended turn
 * may have spent, and after `connectionsChanged`. A failed read keeps the last one.
 */
export function useConnections(
  source: ThreadSource | undefined,
  changed: unknown,
  taskId?: string | null,
) {
  const [read, setRead] = useState<ConnectionsRead | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [changes, setChanges] = useState(0);
  useEffect(
    () =>
      source?.subscribe((event) => {
        if (event.type === 'chat.turn' && event.payload.endedAt) setEnded(event.payload.id);
      }),
    [source],
  );
  useEffect(() => {
    const again = () => setChanges((count) => count + 1);
    connectionReads.add(again);
    return () => void connectionReads.delete(again);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `changed`, `ended` and `changes` trigger the read
  useEffect(() => {
    if (!source) return;
    let active = true;
    readConnections(source, taskId ?? undefined).then(
      (next) => {
        if (active) setRead(next);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [source, taskId, changed, ended, changes]);
  return read;
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
