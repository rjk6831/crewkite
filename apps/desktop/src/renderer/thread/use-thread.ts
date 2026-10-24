import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isThreadEvent, readThread, type ThreadSource } from './commands.ts';
import {
  activeTurnId,
  FIRST_READ_BACKOFF,
  initialThreadState,
  type ReadClock,
  reduceThread,
  retryRead,
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

  const items = useMemo(() => threadItems(state), [state]);
  return {
    state,
    items,
    dispatch,
    error,
    activeTurn: useMemo(() => activeTurnId(state), [state]),
    reload,
    retry: () => setAttempt((value) => value + 1),
  };
}
