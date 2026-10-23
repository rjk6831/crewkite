import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isThreadEvent, readThread, type ThreadSource } from './commands.ts';
import {
  activeTurnId,
  initialThreadState,
  reduceThread,
  type ThreadEvent,
  threadItems,
} from './thread-state.ts';

const isTurnEnd = (event: ThreadEvent) =>
  event.type === 'agent.event' &&
  (event.payload as { type?: string } | null)?.type === 'turn.completed';
// Loads the thread once, then applies the live stream on top. Events are held until the read
// returns and then applied on top of it, and the reducer drops the ones the read already covers. A
// finished turn triggers one more read so the stored messages and the streamed view cannot drift
// apart.
export function useThread(source: ThreadSource, taskId: string, connection: string) {
  const [state, dispatch] = useReducer(reduceThread, taskId, initialThreadState);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reading = useRef(false);

  const reload = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      dispatch({ type: 'loaded', read: await readThread(source, taskId) });
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The thread could not be loaded.');
    } finally {
      reading.current = false;
    }
  }, [source, taskId]);

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
    readThread(source, taskId)
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
        if (active)
          setError(failure instanceof Error ? failure.message : 'The thread could not be loaded.');
      })
      .finally(() => {
        reading.current = false;
      });
    return () => {
      active = false;
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [source, taskId, connection, attempt, reload]);

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
