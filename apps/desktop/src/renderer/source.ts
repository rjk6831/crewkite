import {
  ArtifactSchema,
  CONVERSATION_CONTEXT_MEDIA_TYPE,
  CommandIdSchema,
  type CommandResult,
  CommandResultSchema,
  type ConversationContextBundle,
  ConversationContextBundleSchema,
  type ConversationContextRef,
  ConversationContextRefSchema,
  canonicalJson,
  type DesktopNotice,
  DesktopNoticeSchema,
  type Event,
  EventSchema,
  ProjectIdSchema,
  type Snapshot,
  SnapshotSchema,
} from '@crewkite/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPreviewSource } from './preview.ts';

export type { DesktopCommand, DesktopSource } from '@crewkite/client';

import type {
  ConversationContextCapture,
  ConversationContextReceipt,
  ConversationContextRequest,
  DesktopCommand,
  DesktopSource,
} from '@crewkite/client';

declare global {
  interface Window {
    crewkite?: DesktopSource;
  }
}

export class ConversationContextCaptureError extends Error {
  readonly receipt: ConversationContextReceipt;
  constructor(receipt: ConversationContextReceipt) {
    super('The context capture outcome is uncertain. Retry this capture before choosing again.');
    this.name = 'ConversationContextCaptureError';
    this.receipt = Object.freeze({ ...receipt });
  }
}
export type ResolvedConversationContext = {
  ref: ConversationContextRef;
  bundle: ConversationContextBundle;
};
function contextReceipt(input: ConversationContextReceipt): ConversationContextReceipt {
  if (Object.keys(input).length !== 3 || !/^[a-f0-9]{40}$/.test(input.base))
    throw new Error('The context receipt is invalid.');
  return {
    receiptId: CommandIdSchema.parse(input.receiptId),
    projectId: ProjectIdSchema.parse(input.projectId),
    base: input.base,
  };
}
const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
export async function resolveConversationContext(
  source: Pick<DesktopSource, 'command'>,
  input: ConversationContextRef,
): Promise<ResolvedConversationContext> {
  const ref = ConversationContextRefSchema.parse(input);
  let artifact: ReturnType<typeof ArtifactSchema.parse> | null = null;
  const bytes = new Uint8Array(32768);
  let offset = 0;
  for (;;) {
    const part = CommandResultSchema.parse(
      await source.command({
        command: 'GetArtifact',
        payload: { artifactId: ref.artifactId, offset, limit: 8192 },
      }),
    );
    if (
      (part.outcome !== 'applied' && part.outcome !== 'already-applied') ||
      part.data?.kind !== 'artifact'
    )
      throw new Error('The context artifact is unavailable.');
    const data = part.data;
    if (!artifact) artifact = ArtifactSchema.parse(data.artifact);
    if (
      artifact.id !== ref.artifactId ||
      artifact.hash !== ref.hash ||
      artifact.mediaType !== CONVERSATION_CONTEXT_MEDIA_TYPE ||
      artifact.bytes < 1 ||
      artifact.bytes > bytes.length ||
      canonicalJson(data.artifact) !== canonicalJson(artifact) ||
      data.offset !== offset ||
      data.encoding !== 'base64' ||
      data.content.length > 10924
    )
      throw new Error('The context artifact identity changed.');
    const decoded = atob(data.content);
    if (
      btoa(decoded) !== data.content ||
      decoded.length < 1 ||
      decoded.length !== Math.min(8192, artifact.bytes - offset) ||
      offset + decoded.length > artifact.bytes
    )
      throw new Error('The context artifact chunk is invalid.');
    for (let index = 0; index < decoded.length; index++)
      bytes[offset + index] = decoded.charCodeAt(index);
    offset += decoded.length;
    if (data.eof !== (offset === artifact.bytes))
      throw new Error('The context artifact length changed.');
    if (data.eof) break;
  }
  const content = bytes.slice(0, offset);
  if ((await digest(content)) !== ref.hash)
    throw new Error('The context artifact checksum changed.');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  const bundle = ConversationContextBundleSchema.parse(JSON.parse(text));
  if (canonicalJson(bundle) !== text) throw new Error('The context artifact is not canonical.');
  for (const file of bundle.files) {
    if ((await digest(new TextEncoder().encode(file.text))) !== file.hash)
      throw new Error('The context file checksum changed.');
  }
  return { ref, bundle };
}

export function useWorkspace() {
  const preview = new URLSearchParams(window.location.search).get('preview') === '1';
  const source = useMemo(() => (preview ? createPreviewSource() : window.crewkite), [preview]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [{ events, droppedThrough }, setActivity] = useState<{
    events: Event[];
    droppedThrough: string | null;
  }>({ events: [], droppedThrough: null });
  const [connection, setConnection] = useState('connecting');
  const [error, setError] = useState<string | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [pendingRuns, setPendingRuns] = useState<
    { token: symbol; input: Extract<DesktopCommand, { command: 'StartRun' | 'StopRun' }> }[]
  >([]);
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
      setActivity((current) => {
        if (current.events.some(({ id }) => id === parsed.data.id)) return current;
        // shortcut: retain 200 activity rows in this view. Upgrade: page older events by cursor.
        const ordered = [...current.events, parsed.data].sort((a, b) =>
          BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1,
        );
        return {
          events: ordered.slice(-200),
          droppedThrough:
            ordered.length > 200 ? ordered[ordered.length - 201].cursor : current.droppedThrough,
        };
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
  const track = useCallback(async <T>(action: () => Promise<T>): Promise<T> => {
    setPending((value) => value + 1);
    setError(null);
    try {
      return await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The command failed.');
      throw failure;
    } finally {
      setPending((value) => value - 1);
    }
  }, []);
  const perform = useCallback(
    <T extends CommandResult | ConversationContextCapture | null>(
      action: () => Promise<T>,
    ): Promise<T> =>
      track(async () => {
        const value = await action();
        const result =
          value === null
            ? null
            : 'receiptId' in value
              ? value.result === null
                ? null
                : CommandResultSchema.parse(value.result)
              : CommandResultSchema.parse(value);
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
      }),
    [refresh, track],
  );
  const command = useCallback(
    (input: DesktopCommand) =>
      perform(async () => {
        if (!source) throw new Error('The desktop bridge is unavailable.');
        if (input.command !== 'StartRun' && input.command !== 'StopRun')
          return source.command(input);
        const token = Symbol();
        setPendingRuns((current) => [...current, { token, input }]);
        try {
          return await source.command(input);
        } finally {
          setPendingRuns((current) => current.filter((value) => value.token !== token));
        }
      }),
    [source, perform],
  );
  const pickProject = () =>
    perform(async () => {
      if (!source?.pickProject) throw new Error('Project selection is unavailable in this view.');
      return source.pickProject();
    });
  const retryCommand = (expected?: DesktopCommand) =>
    perform(async () => {
      if (!source?.retryCommand)
        throw new Error('Exact command retry is unavailable in this view.');
      return source.retryCommand(expected);
    });
  const resolveContext = (ref: ConversationContextRef) =>
    track(async () => {
      if (!source) throw new Error('The desktop bridge is unavailable.');
      return resolveConversationContext(source, ref);
    });
  const finishCapture = async (
    scope: { projectId: string; base: string },
    capture: ConversationContextCapture,
  ): Promise<ResolvedConversationContext> => {
    const receipt = contextReceipt({
      projectId: scope.projectId,
      base: scope.base,
      receiptId: capture.receiptId,
    });
    const result = capture.result === null ? null : CommandResultSchema.parse(capture.result);
    if (!result || result.outcome === 'outcome-unknown')
      throw new ConversationContextCaptureError(receipt);
    if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
      throw new Error([result.reason ?? result.outcome, result.next].filter(Boolean).join(' '));
    const artifact = ArtifactSchema.parse(result.entity);
    const resolved = await resolveContext({ artifactId: artifact.id, hash: artifact.hash });
    if (resolved.bundle.projectId !== scope.projectId || resolved.bundle.base !== scope.base)
      throw new Error('The context artifact belongs to a different project or base.');
    return resolved;
  };
  const pickConversationContext = (input: ConversationContextRequest) =>
    track(async () => {
      if (!source?.pickConversationContext)
        throw new Error('Context selection is unavailable in this view.');
      const capture = await perform(() =>
        source.pickConversationContext
          ? source.pickConversationContext(input)
          : Promise.reject(new Error('Context selection is unavailable.')),
      );
      return capture === null ? null : finishCapture(input, capture);
    });
  const retryConversationContext = (input: ConversationContextReceipt) =>
    track(async () => {
      const receipt = contextReceipt(input);
      if (!source?.retryConversationContext)
        throw new Error('Context retry is unavailable in this view.');
      const capture = await perform(() =>
        source.retryConversationContext
          ? source.retryConversationContext(receipt)
          : Promise.reject(new Error('Context retry is unavailable.')),
      );
      if (capture.receiptId !== receipt.receiptId) throw new Error('The context receipt changed.');
      return finishCapture(receipt, capture);
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
    pendingStart:
      pendingRuns.flatMap(({ input }) =>
        input.command === 'StartRun' ? [input.payload] : [],
      )[0] ?? null,
    pendingStop: pendingRuns.some(({ input }) => input.command === 'StopRun'),
    error: error ?? transportError,
    setError: (value: string | null) => {
      setError(value);
      if (value === null) setTransportError(null);
    },
    dismissError: (expected: string) =>
      setError((current) => (current === expected ? null : current)),
    refresh,
    command,
    pickProject,
    canPickProject: !!source?.pickProject,
    pickConversationContext,
    retryConversationContext,
    resolveConversationContext: resolveContext,
    canPickConversationContext: !!source?.pickConversationContext,
    reconnect,
    retryCommand,
    retryAvailable,
    historyGap: historyGap ?? droppedThrough,
    exportNotice,
    dismissExportNotice: () => setExportNotice(null),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
