import type { AgentEvent } from '@crewkite/contracts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isThreadEvent, readThread, readTurnEvents, type ThreadSource } from './commands.ts';
import {
  activeTurnId,
  earlierCursor,
  FIRST_READ_BACKOFF,
  historyWanted,
  initialThreadState,
  type ReadClock,
  reduceThread,
  retryRead,
  THREAD_PAGE_SIZE,
  type ThreadEvent,
  TRY_AGAIN_AFTER_MS,
  threadItems,
} from './thread-state.ts';

const browserClock: ReadClock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const isTurnEnd = (event: ThreadEvent) =>
  event.type === 'agent.event' &&
  (event.payload as { type?: string } | null)?.type === 'turn.completed';
const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : 'The thread could not be loaded.';
// 64 pages of 512 KiB. A turn past that shows what was read, and its stored reply.
const MAX_EVENT_PAGES = 64;
// 20 pages of 200 messages is 4,000 messages, past the 2,000 turn threads the view is sized for.
const MAX_REACH_PAGES = 20;

// Loads the thread once, then applies the live stream on top. Events are held until the read
// returns and then applied on top of it, and the reducer drops the ones the read already covers. A
// finished turn triggers one more read so the stored messages and the streamed view cannot drift
// apart.
//
// The controller answers one command at a time, so a read can wait behind slower ones and time
// out. The first read retries on a backoff and reports a failure only after ten seconds; the
// skeleton holds the space until then. A later read that fails leaves the state as it was and
// tries once more.
export function useThread(
  source: ThreadSource,
  taskId: string,
  connection: string,
  clock: ReadClock = browserClock,
) {
  const [state, dispatch] = useReducer(reduceThread, taskId, initialThreadState);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reading = useRef(false);
  const histories = useRef(new Set<string>());
  const [earlierNote, setEarlierNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const read = await retryRead(() => readThread(source, taskId), clock, {
        delays: [FIRST_READ_BACKOFF[2]],
        giveUpAfter: 0,
      });
      dispatch({ type: 'loaded', read });
      setError(null);
    } catch (failure) {
      setError(message(failure));
    } finally {
      reading.current = false;
    }
  }, [source, taskId, clock]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt and connection restart the load
  useEffect(() => {
    let active = true;
    let ready = false;
    let frame = 0;
    const held: ThreadEvent[] = [];
    const buffer: ThreadEvent[] = [];
    const flush = () => {
      frame = 0;
      const events = buffer.splice(0);
      if (!active || events.length === 0) return;
      dispatch({ type: 'events', events });
      if (events.some(isTurnEnd)) void reload();
    };
    const unsubscribe = source.subscribe((event) => {
      if (!active || !isThreadEvent(event.type)) return;
      const entry: ThreadEvent = {
        type: event.type,
        cursor: event.cursor,
        taskId: event.taskId,
        payload: event.payload,
      };
      if (!ready) {
        held.push(entry);
        return;
      }
      buffer.push(entry);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    reading.current = true;
    setError(null);
    retryRead(() => readThread(source, taskId), clock, {
      delays: FIRST_READ_BACKOFF,
      giveUpAfter: TRY_AGAIN_AFTER_MS,
      active: () => active,
    })
      .then((read) => {
        if (!active) return;
        dispatch({ type: 'loaded', read });
        setError(null);
        // The reducer drops what the read covers by cursor, so every held event goes in and the
        // ones emitted while the read was in flight are kept.
        if (held.length > 0) dispatch({ type: 'events', events: held.splice(0) });
        ready = true;
      })
      .catch((failure: unknown) => {
        if (active) setError(message(failure));
      })
      .finally(() => {
        reading.current = false;
      });
    return () => {
      active = false;
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [source, taskId, connection, attempt, reload, clock]);

  // A finished turn's cards come back from its stored events, read once per view. The pages are
  // put together first, so the turn never shows half its events as if it were still running.
  const loadHistory = useCallback(
    async (turnId: string) => {
      if (histories.current.has(turnId)) return;
      histories.current.add(turnId);
      const events: AgentEvent[] = [];
      let afterCursor: string | undefined;
      // Stays true when a page after the first fails or the page cap ends the loop.
      let partial = true;
      try {
        for (let page = 0; page < MAX_EVENT_PAGES; page++) {
          const read = await readTurnEvents(source, { taskId, turnId, afterCursor });
          events.push(...read.events);
          if (read.nextAfterCursor === null || read.nextAfterCursor === afterCursor) {
            partial = false;
            break;
          }
          afterCursor = read.nextAfterCursor;
        }
      } catch (failure) {
        if (events.length === 0) {
          dispatch({ type: 'history-note', turnId, note: message(failure) });
          return;
        }
      }
      dispatch({ type: 'history', turnId, events, partial });
    },
    [source, taskId],
  );
  const loadEarlier = useCallback(async () => {
    const cursor = earlierCursor(state);
    if (!cursor) return;
    try {
      const read = await readThread(source, taskId, cursor);
      dispatch({ type: 'earlier', read });
      setEarlierNote(null);
    } catch (failure) {
      setEarlierNote(message(failure));
    }
  }, [source, taskId, state]);

  // Pages older messages in until the one at `target` is loaded, for a search result that points
  // into history. It stops at the first page when the thread has no more, and at a page cap.
  const latest = useRef(state);
  latest.current = state;
  const reach = useCallback(
    async (target: string) => {
      const goal = BigInt(target);
      let oldest = latest.current.messages[0]?.cursor ?? null;
      let more = latest.current.older.more;
      for (let page = 0; page < MAX_REACH_PAGES && more && oldest !== null; page++) {
        if (BigInt(oldest) <= goal) return;
        const read = await readThread(source, taskId, oldest);
        dispatch({ type: 'earlier', read });
        const next = read.messages[0]?.cursor;
        if (next === undefined || next === oldest) return;
        oldest = next;
        more = read.more ?? read.messages.length >= THREAD_PAGE_SIZE;
      }
    },
    [source, taskId],
  );

  const items = useMemo(() => threadItems(state), [state]);
  return {
    reach,
    state,
    items,
    dispatch,
    error,
    activeTurn: useMemo(() => activeTurnId(state), [state]),
    wantsHistory: useMemo(() => historyWanted(state), [state]),
    loadHistory,
    hasEarlier: earlierCursor(state) !== null,
    loadEarlier,
    earlierNote,
    reload,
    retry: () => setAttempt((value) => value + 1),
  };
}
