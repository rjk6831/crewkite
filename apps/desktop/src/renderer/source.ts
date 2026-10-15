import {
  CommandResultSchema,
  type Event,
  EventSchema,
  type Snapshot,
  SnapshotSchema,
} from '@crewkite/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPreviewSource } from './preview.ts';

export type { DesktopCommand, DesktopSource } from '@crewkite/client';

import type { DesktopCommand, DesktopSource } from '@crewkite/client';

declare global {
  interface Window {
    crewkite?: DesktopSource;
  }
}

export function useWorkspace() {
  const preview = new URLSearchParams(window.location.search).get('preview') === '1';
  const source = useMemo(() => (preview ? createPreviewSource() : window.crewkite), [preview]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [connection, setConnection] = useState('connecting');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const reading = useRef<Promise<Snapshot> | null>(null);
  const dirty = useRef(false);
  const refresh = useCallback((): Promise<Snapshot> => {
    if (!source)
      return Promise.reject(
        new Error('The desktop bridge is unavailable. Start the desktop demo to connect.'),
      );
    if (reading.current) {
      dirty.current = true;
      return reading.current;
    }
    const read = async () => {
      let next: Snapshot;
      do {
        dirty.current = false;
        next = SnapshotSchema.parse(await source.getSnapshot());
        setSnapshot((current) =>
          current === null || BigInt(next.cursor) >= BigInt(current.cursor) ? next : current,
        );
        setConnection('connected');
      } while (dirty.current);
      return next;
    };
    reading.current = read().finally(() => {
      reading.current = null;
    });
    return reading.current;
  }, [source]);
  useEffect(() => {
    let active = true;
    void refresh().catch((failure: unknown) => {
      if (active) {
        setConnection('offline');
        setError(
          failure instanceof Error ? failure.message : 'The controller could not be reached.',
        );
      }
    });
    const unsubscribe = source?.subscribe((value) => {
      if (!active) return;
      const parsed = EventSchema.safeParse(value);
      if (!parsed.success) {
        setError('An invalid controller event was rejected. Reconnect to refresh the workspace.');
        return;
      }
      setEvents((current) => {
        if (current.some(({ id }) => id === parsed.data.id)) return current;
        // shortcut: retain 200 activity rows in this view. Upgrade: page older events by cursor.
        return [...current, parsed.data]
          .sort((a, b) => (BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1))
          .slice(-200);
      });
      void refresh().catch((failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : 'Workspace refresh failed.');
      });
    });
    const disconnect = source?.onConnection?.((state) => {
      if (!active) return;
      setConnection(state);
      if (state === 'connected') {
        setError(null);
        void refresh().catch((failure: unknown) => {
          if (active)
            setError(failure instanceof Error ? failure.message : 'Workspace recovery failed.');
        });
      }
    });
    return () => {
      active = false;
      unsubscribe?.();
      disconnect?.();
    };
  }, [source, refresh]);
  const command = useCallback(
    async (input: DesktopCommand) => {
      if (!source) throw new Error('The desktop bridge is unavailable.');
      setPending((value) => value + 1);
      setError(null);
      try {
        const result = CommandResultSchema.parse(await source.command(input));
        if (result.outcome !== 'applied' && result.outcome !== 'already-applied') {
          setError([result.reason ?? result.outcome, result.next].filter(Boolean).join(' '));
        }
        try {
          await refresh();
        } catch (failure) {
          setError(
            [
              `Command outcome: ${result.outcome}.`,
              result.reason,
              result.next,
              `Workspace refresh failed: ${failure instanceof Error ? failure.message : 'reconnect to recover current state.'}`,
            ]
              .filter(Boolean)
              .join(' '),
          );
        }
        return result;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'The command failed.');
        throw failure;
      } finally {
        setPending((value) => value - 1);
      }
    },
    [source, refresh],
  );
  return {
    snapshot,
    events,
    connection,
    preview,
    pending: pending > 0,
    error,
    setError,
    refresh,
    command,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
