import {
  type Artifact,
  ArtifactRangeSchema,
  ArtifactSchema,
  ArtifactVerificationSchema,
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
  type ProjectPage,
  ProjectPageSchema,
  type Snapshot,
  SnapshotSchema,
  TaskActivityOutputPageSchema,
  type TaskActivityRequest,
  TaskActivityRequestSchema,
  type TaskPage,
  type TaskPageRequest,
  TaskPageSchema,
  TaskSchema,
  type WorkspaceState,
  WorkspaceStateSchema,
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
  const [detailStale, setDetailStale] = useState(false);
  const [header, setHeader] = useState<WorkspaceState | null>(null);
  const [projects, setProjects] = useState<ProjectPage['projects']>([]);
  const [projectPage, setProjectPage] = useState<ProjectPage | null>(null);
  const [taskPages, setTaskPages] = useState<Record<string, TaskPage>>({});
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [navigationStale, setNavigationStale] = useState(false);
  const selectedTask = useRef<string | null>(null);
  const detailCache = useRef(new Map<string, Snapshot>());
  const headerRef = useRef<WorkspaceState | null>(null);
  const activityTail = useRef<Promise<unknown>>(Promise.resolve());
  const pageRead = useRef(false);
  const pageTail = useRef<Promise<unknown>>(Promise.resolve());
  const queuePage = useCallback(<T>(read: () => Promise<T>): Promise<T> => {
    const result = pageTail.current.then(read);
    pageTail.current = result.catch(() => {});
    return result;
  }, []);
  const detailEpoch = useRef<string | undefined>(undefined);
  const navigationStamp = useRef<string | null>(null);
  const selectTask = useCallback(
    async (taskId: string | null) => {
      selectedTask.current = taskId;
      setSnapshot(taskId ? (detailCache.current.get(taskId) ?? null) : null);
      if (!source || !taskId) return;
      const epoch = headerRef.current?.stamp.epoch;
      try {
        const next = SnapshotSchema.parse(await source.getSnapshot({ taskId }));
        if (selectedTask.current === taskId && headerRef.current?.stamp.epoch === epoch) {
          setDetailStale(false);
          detailCache.current.delete(taskId);
          detailCache.current.set(taskId, next);
          if (detailCache.current.size > 3) {
            const oldest = detailCache.current.keys().next().value;
            if (oldest) detailCache.current.delete(oldest);
          }
          const newEpoch = detailEpoch.current !== epoch;
          detailEpoch.current = epoch;
          setSnapshot((current) =>
            newEpoch || !current || BigInt(next.cursor) >= BigInt(current.cursor) ? next : current,
          );
        }
      } catch (failure) {
        if (selectedTask.current === taskId)
          setTransportError(
            failure instanceof Error ? failure.message : 'Task detail is unavailable.',
          );
      }
    },
    [source],
  );
  const readTaskPage = useCallback(
    async (input: Omit<TaskPageRequest, 'limit'> & { limit?: number }) => {
      if (!source) throw new Error('The desktop bridge is unavailable.');
      const page = TaskPageSchema.parse(await queuePage(() => source.taskPage(input)));
      if (
        page.stamp.epoch !== input.stamp.epoch ||
        page.stamp.revision !== input.stamp.revision ||
        page.tasks.some(
          (task) =>
            (input.projectId && task.projectId !== input.projectId) ||
            (input.taskId && task.id !== input.taskId),
        )
      )
        throw new Error(
          'The task page does not match this navigation request. Refresh to continue.',
        );
      return page;
    },
    [source, queuePage],
  );
  const loadTasks = useCallback(
    async (projectId: string, more = false) => {
      const current = headerRef.current;
      if (!source || !current || pageRead.current) return;
      pageRead.current = true;
      setNavigationBusy(true);
      try {
        const previous = taskPages[projectId];
        const next = await readTaskPage({
          stamp: current.stamp,
          projectId,
          ...(more && previous?.next ? { after: previous.next } : {}),
        });
        if (
          headerRef.current?.stamp.epoch !== next.stamp.epoch ||
          headerRef.current?.stamp.revision !== next.stamp.revision
        )
          return;
        setTaskPages((pages) => ({
          ...pages,
          [projectId]: {
            ...next,
            tasks: more ? [...(pages[projectId]?.tasks ?? []), ...next.tasks] : next.tasks,
          },
        }));
      } catch (failure) {
        setNavigationStale(true);
        setTransportError(
          failure instanceof Error ? failure.message : 'Task navigation is unavailable.',
        );
      } finally {
        pageRead.current = false;
        setNavigationBusy(false);
      }
    },
    [source, taskPages, readTaskPage],
  );
  const loadProjects = useCallback(async () => {
    const current = headerRef.current;
    if (!source || !current || !projectPage?.next || pageRead.current) return;
    pageRead.current = true;
    setNavigationBusy(true);
    try {
      const next = ProjectPageSchema.parse(
        await queuePage(() =>
          source.projectPage({ stamp: current.stamp, after: projectPage.next ?? undefined }),
        ),
      );
      if (
        headerRef.current?.stamp.epoch !== next.stamp.epoch ||
        headerRef.current?.stamp.revision !== next.stamp.revision
      )
        return;
      setProjects((rows) => [...rows, ...next.projects]);
      setProjectPage(next);
    } catch (failure) {
      setNavigationStale(true);
      setTransportError(
        failure instanceof Error ? failure.message : 'Project navigation is unavailable.',
      );
    } finally {
      pageRead.current = false;
      setNavigationBusy(false);
    }
  }, [source, projectPage, queuePage]);
  const [{ events, droppedThrough }, setActivity] = useState<{
    events: Event[];
    droppedThrough: string | null;
  }>({ events: [], droppedThrough: null });
  const [activityRevision, setActivityRevision] = useState(0);
  const readTaskActivity = useCallback(
    (input: Omit<TaskActivityRequest, 'limit'> & { limit?: number }) => {
      const read = async () => {
        if (!source) throw new Error('The desktop bridge is unavailable.');
        const request = TaskActivityRequestSchema.parse(input);
        const result = CommandResultSchema.parse(
          await source.command({ command: 'GetTaskActivityPage', payload: request }),
        );
        if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
          throw new Error([result.reason ?? result.outcome, result.next].filter(Boolean).join(' '));
        const parsed = TaskActivityOutputPageSchema.safeParse(result.data);
        if (!parsed.success)
          throw new Error('Task activity is unavailable: the retained page is invalid.');
        const page = parsed.data;
        if (
          page.taskId !== request.taskId ||
          (request.beforeCursor !== undefined &&
            page.entries.some(
              (entry) =>
                BigInt(entry.kind === 'event' ? entry.event.cursor : entry.cursor) >=
                BigInt(request.beforeCursor ?? '0'),
            ))
        )
          throw new Error('Task activity is unavailable: the page does not match the request.');
        return page;
      };
      const result = activityTail.current.then(read);
      activityTail.current = result.catch(() => {});
      return result;
    },
    [source],
  );
  const readArtifactRange = useCallback(
    async (artifact: Artifact, offset: number) => {
      if (!source) throw new Error('The desktop bridge is unavailable.');
      const result = CommandResultSchema.parse(
        await source.command({
          command: 'GetArtifactRange',
          payload: { artifactId: artifact.id, offset, limit: 65536 },
        }),
      );
      if (result.outcome !== 'applied') throw new Error(result.reason ?? 'Output is unavailable.');
      const page = ArtifactRangeSchema.parse(result.data);
      if (page.offset !== offset || canonicalJson(page.artifact) !== canonicalJson(artifact))
        throw new Error('The output identity changed.');
      return page;
    },
    [source],
  );
  const verifyArtifact = useCallback(
    async (requestId: string, artifact: Artifact) => {
      if (!source?.verifyArtifact) throw new Error('Output verification is unavailable.');
      const proof = ArtifactVerificationSchema.parse(
        await source.verifyArtifact({ requestId, artifact }),
      );
      if (proof.hash !== artifact.hash || proof.bytes !== artifact.bytes)
        throw new Error('Output verification identity changed.');
      return proof;
    },
    [source],
  );
  const cancelArtifactVerification = useCallback(
    async (requestId: string) => {
      await source?.cancelArtifactVerification?.(requestId);
    },
    [source],
  );
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
  const reading = useRef<Promise<WorkspaceState> | null>(null);
  const dirty = useRef(false);
  const refresh = useCallback((): Promise<WorkspaceState> => {
    if (!source)
      return Promise.reject(
        new Error('The desktop bridge is unavailable. Start the desktop demo to connect.'),
      );
    if (
      typeof source.workspaceState !== 'function' ||
      typeof source.projectPage !== 'function' ||
      typeof source.taskPage !== 'function'
    )
      return Promise.reject(
        new Error(
          'Workspace paging is unavailable with this controller connection. Open the matching desktop package.',
        ),
      );
    if (reading.current) {
      dirty.current = true;
      return reading.current;
    }
    const read = async () => {
      for (;;) {
        dirty.current = false;
        const next = WorkspaceStateSchema.parse(await source.workspaceState());
        const previous = headerRef.current;
        const stampKey = `${next.stamp.epoch}:${next.stamp.revision}`;
        const changed = navigationStamp.current !== stampKey;
        headerRef.current = next;
        setHeader(next);
        if (changed) {
          setNavigationStale(Boolean(previous));
          if (previous?.stamp.epoch !== next.stamp.epoch) {
            detailCache.current.clear();
            setActivity({ events: [], droppedThrough: null });
            setDetailStale(Boolean(previous && selectedTask.current));
          }
          let page: ProjectPage;
          try {
            page = ProjectPageSchema.parse(
              await queuePage(() => source.projectPage({ stamp: next.stamp })),
            );
          } catch (failure) {
            setNavigationStale(true);
            throw failure;
          }
          if (headerRef.current !== next) continue;
          setProjects(page.projects);
          setProjectPage(page);
          navigationStamp.current = stampKey;
          setTaskPages({});
          setNavigationStale(false);
        }
        const taskId = selectedTask.current;
        if (taskId) {
          try {
            const detail = SnapshotSchema.parse(await source.getSnapshot({ taskId }));
            if (selectedTask.current === taskId && headerRef.current === next) {
              setDetailStale(false);
              detailCache.current.set(taskId, detail);
              const newEpoch = detailEpoch.current !== next.stamp.epoch;
              detailEpoch.current = next.stamp.epoch;
              setSnapshot((current) =>
                newEpoch || !current || BigInt(detail.cursor) >= BigInt(current.cursor)
                  ? detail
                  : current,
              );
              const task = detail.tasks.find((row) => row.id === taskId);
              if (task)
                setTaskPages((pages) =>
                  Object.fromEntries(
                    Object.entries(pages).map(([id, page]) => [
                      id,
                      {
                        ...page,
                        tasks: page.tasks.map((row) =>
                          row.id === task.id
                            ? {
                                ...row,
                                state: task.state,
                                waitingReason: task.waitingReason,
                                revision: task.revision,
                                runId: task.runId,
                                next: task.next,
                              }
                            : row,
                        ),
                      },
                    ]),
                  ),
                );
            }
          } catch (failure) {
            if (selectedTask.current === taskId) setSnapshot(null);
            throw failure;
          }
        }
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
  }, [source, queuePage]);
  useEffect(() => {
    let active = true;
    void refresh().catch((failure: unknown) => {
      if (active) {
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
      const updated = TaskSchema.safeParse(parsed.data.payload);
      if (updated.success)
        setTaskPages((pages) =>
          Object.fromEntries(
            Object.entries(pages).map(([id, page]) => [
              id,
              {
                ...page,
                tasks: page.tasks.map((row) =>
                  row.id === updated.data.id
                    ? {
                        ...row,
                        state: updated.data.state,
                        waitingReason: updated.data.waitingReason,
                        revision: updated.data.revision,
                        runId: updated.data.runId,
                        next: updated.data.next,
                      }
                    : row,
                ),
              },
            ]),
          ),
        );
      setActivity((current) => {
        if (current.events.some(({ id }) => id === parsed.data.id)) return current;
        // Bound the shared live tail. Task Activity reads retained pages separately.
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
        setActivityRevision((value) => value + 1);
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
        setActivityRevision((value) => value + 1);
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
  const track = useCallback(async <T>(action: () => Promise<T>, reportError = true): Promise<T> => {
    setPending((value) => value + 1);
    if (reportError) setError(null);
    try {
      return await action();
    } catch (failure) {
      if (reportError) setError(failure instanceof Error ? failure.message : 'The command failed.');
      throw failure;
    } finally {
      setPending((value) => value - 1);
    }
  }, []);
  const perform = useCallback(
    <T extends CommandResult | ConversationContextCapture | null>(
      action: () => Promise<T>,
      reportError = true,
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
        if (reportError && result.outcome !== 'applied' && result.outcome !== 'already-applied') {
          setError([result.reason ?? result.outcome, result.next].filter(Boolean).join(' '));
        }
        try {
          await refresh();
        } catch (failure) {
          if (reportError)
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
      }, reportError),
    [refresh, track],
  );
  const operationCommand = useCallback(
    async (
      input: Extract<
        DesktopCommand,
        {
          command:
            | 'GetTaskOperations'
            | 'GetProjectOperation'
            | 'PrepareProjectCommand'
            | 'StartProjectCommand'
            | 'ReadGitHub'
            | 'StopProjectOperation';
        }
      >,
    ) => {
      if (!source) throw new Error('The desktop bridge is unavailable.');
      return CommandResultSchema.parse(await source.command(input));
    },
    [source],
  );
  const metadataCommand = useCallback(
    async (
      input: Extract<
        DesktopCommand,
        {
          command:
            | 'ObserveUsage'
            | 'RefreshAnthropicUsage'
            | 'StopAnthropicUsage'
            | 'CheckNativeConnection'
            | 'RefreshTaskModelCatalog'
            | 'InstallGoogleAcp'
            | 'StopGoogleAcpInstall'
            | 'InitializeGoogleAcp'
            | 'AuthenticateGoogleAcp'
            | 'DiscoverGoogleAcp'
            | 'StopGoogleAcpSetup';
        }
      >,
    ) => {
      if (!source) throw new Error('The desktop bridge is unavailable.');
      const result = CommandResultSchema.parse(await source.command(input));
      try {
        await refresh();
      } catch (failure) {
        setTransportError(
          `Workspace refresh failed: ${failure instanceof Error ? failure.message : 'reconnect to recover current state.'}`,
        );
      }
      return result;
    },
    [source, refresh],
  );
  const command = useCallback(
    (input: DesktopCommand) => {
      if (
        input.command === 'ObserveUsage' ||
        input.command === 'RefreshAnthropicUsage' ||
        input.command === 'StopAnthropicUsage' ||
        input.command === 'CheckNativeConnection' ||
        input.command === 'RefreshTaskModelCatalog' ||
        input.command === 'InstallGoogleAcp' ||
        input.command === 'StopGoogleAcpInstall' ||
        input.command === 'InitializeGoogleAcp' ||
        input.command === 'AuthenticateGoogleAcp' ||
        input.command === 'DiscoverGoogleAcp' ||
        input.command === 'StopGoogleAcpSetup'
      )
        return metadataCommand(input);
      const reportError =
        input.command !== 'GetTaskConversationState' && input.command !== 'GetTaskConversation';
      return perform(async () => {
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
      }, reportError);
    },
    [source, perform, metadataCommand],
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
    detailStale,
    header,
    projects,
    projectPage,
    taskPages,
    navigationBusy,
    navigationStale,
    selectTask,
    loadTasks,
    loadProjects,
    readTaskPage,
    events,
    readTaskActivity,
    readArtifactRange,
    verifyArtifact,
    cancelArtifactVerification,
    activityRevision,
    connection,
    preview,
    pending: pending > 0 || detailStale,
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
    metadataCommand,
    operationCommand,
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
