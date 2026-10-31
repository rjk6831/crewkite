import { useEffect, useMemo, useState } from 'react';
import { type HistoryFind, queryTerms, revealKey } from './history-reveal.ts';
import type { Reveal } from './message-list.tsx';
import type { ThreadItem } from './thread-state.ts';

/**
 * The row a chosen search result points at, once the thread has paged back far enough to hold it.
 * Null until then, and null for a title, which has no row. `reach` loads older messages up to a
 * conversation cursor.
 */
export function useReveal(
  find: HistoryFind | null | undefined,
  items: readonly ThreadItem[],
  loaded: boolean,
  reach: (cursor: string) => Promise<void>,
): Reveal | null {
  // The nonce of the result the thread has paged back to.
  const [reached, setReached] = useState(-1);
  useEffect(() => {
    if (!find || !loaded) return;
    let active = true;
    const done = () => {
      if (active) setReached(find.nonce);
    };
    const target = find.hit.messageCursor;
    (target ? reach(target) : Promise.resolve()).then(done, done);
    return () => {
      active = false;
    };
  }, [find, loaded, reach]);
  return useMemo(() => {
    if (!find || reached !== find.nonce) return null;
    const key = revealKey(find.hit, items);
    return key ? { key, terms: queryTerms(find.query), nonce: find.nonce } : null;
  }, [find, reached, items]);
}
