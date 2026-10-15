import {
  type CommandResult,
  CommandResultSchema,
  type DesktopNotice,
  DesktopNoticeSchema,
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
  const [transportError, setTransportError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [historyGap, setHistoryGap] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<Extract<
    DesktopNotice,
    { kind: 'export' }
  > | null>(null);
  const connectionState = useRef('connecting');
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
      for (;;) {
        dirty.current = false;
        let next: Snapshot;
        try {
          next = SnapshotSchema.parse(await source.getSnapshot());
        } catch (failure) {
          // A connection notice can arrive while the initial offline read is still settling.
          if (dirty.current && connectionState.current === 'connected') continue;
          throw failure;
        }
        setSnapshot((current) =>
          current === null || BigInt(next.cursor) >= BigInt(current.cursor) ? next : current,
        );
        setTransportError(null);
        if (!source.onNotice && !source.onConnection) {
          connectionState.current = 'connected';
          setConnection('connected');
        }
        if (!dirty.current) return next;
      }
    };
    reading.current = read().finally(() => {
      reading.current = null;
    });
    return reading.current;
  }, [source]);
  useEffect(() => {
    let active = true;
    void refresh().catch((failure: unknown) => {
      if (active && connectionState.current !== 'connected') {
        if (!source?.onNotice && !source?.onConnection) {
          connectionState.current = 'offline';
          setConnection('offline');
        }
        setTransportError(
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
          setTransportError(
            failure instanceof Error ? failure.message : 'Workspace refresh failed.',
          );
      });
    });
    const changedConnection = (state: string) => {
      if (!active) return;
      connectionState.current = state;
      setConnection(state);
      if (state === 'connected') {
        setTransportError(null);
        void refresh().catch((failure: unknown) => {
          if (active)
            setTransportError(
              failure instanceof Error ? failure.message : 'Workspace recovery failed.',
            );
        });
      }
    };
    const disconnect = source?.onNotice ? undefined : source?.onConnection?.(changedConnection);
    const stopNotices = source?.onNotice?.((value) => {
      if (!active) return;
      const parsed = DesktopNoticeSchema.safeParse(value);
      if (!parsed.success) return;
      const notice = parsed.data;
      if (notice.kind === 'connection') changedConnection(notice.state);
      else if (notice.kind === 'retry') setRetryAvailable(notice.available);
      else if (notice.kind === 'export') setExportNotice(notice);
      else {
        setHistoryGap(notice.after);
        void refresh().catch(() => {
          if (active)
            setTransportError('History is incomplete. Reconnect to refresh current task state.');
        });
      }
    });
    return () => {
      active = false;
      unsubscribe?.();
      disconnect?.();
      stopNotices?.();
    };
  }, [source, refresh]);
  const perform = useCallback(
    async <T extends CommandResult | null>(action: () => Promise<T>): Promise<T> => {
      setPending((value) => value + 1);
      setError(null);
      try {
        const value = await action();
        const result = value === null ? null : CommandResultSchema.parse(value);
        if (!result) return value;
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
        return value;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'The command failed.');
        throw failure;
      } finally {
        setPending((value) => value - 1);
      }
    },
    [refresh],
  );
  const command = useCallback(
    (input: DesktopCommand) =>
      perform(async () => {
        if (!source) throw new Error('The desktop bridge is unavailable.');
        return source.command(input);
      }),
    [source, perform],
  );
  const pickProject = () =>
    perform(async () => {
      if (!source?.pickProject) throw new Error('Project selection is unavailable in this view.');
      return source.pickProject();
    });
  const retryCommand = () =>
    perform(async () => {
      if (!source?.retryCommand)
        throw new Error('Exact command retry is unavailable in this view.');
      return source.retryCommand();
    });
  const reconnect = async () => {
    setTransportError(null);
    try {
      if (source?.reconnect) await source.reconnect();
      await refresh();
    } catch (failure) {
      setTransportError(
        failure instanceof Error ? failure.message : 'The controller could not reconnect.',
      );
    }
  };
  return {
    snapshot,
    events,
    connection,
    preview,
    pending: pending > 0,
    error: error ?? transportError,
    setError: (value: string | null) => {
      setError(value);
      if (value === null) setTransportError(null);
    },
    refresh,
    command,
    pickProject,
    canPickProject: !!source?.pickProject,
    reconnect,
    retryCommand,
    retryAvailable,
    historyGap,
    exportNotice,
    dismissExportNotice: () => setExportNotice(null),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
