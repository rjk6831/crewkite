import {
  type CommandResult,
  CommandResultSchema,
  DesktopNoticeSchema,
  EventSchema,
  type ProjectPage,
  ProjectPageSchema,
  type Snapshot,
  SnapshotSchema,
  type TaskPage,
  type TaskPageRequest,
  TaskPageSchema,
  TaskSchema,
  type WorkspaceState,
  WorkspaceStateSchema,
} from '@crewkite/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPreviewSource } from './preview.ts';
import { isStreamEvent, isThreadEvent } from './thread/commands.ts';

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
  const [connection, setConnection] = useState('connecting');
  const [error, setError] = useState<string | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [retryAvailable, setRetryAvailable] = useState(false);
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
      // The open thread reads streamed output itself. Re-reading the workspace per delta would flood
      // the controller.
      if (isStreamEvent((value as { type: string }).type)) return;
      const parsed = EventSchema.safeParse(value);
      if (!parsed.success) {
        // A chat message arrives as conversation.entry with a payload the workspace schema does not
        // describe. The open thread folds it. Anything else that fails the schema is a real fault.
        if (isThreadEvent((value as { type: string }).type)) return;
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
      else if (notice.kind === 'history-gap')
        void refresh().catch(() => {
          if (active)
            setTransportError('History is incomplete. Reconnect to refresh current task state.');
        });
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
    <T extends CommandResult | null>(action: () => Promise<T>, reportError = true): Promise<T> =>
      track(async () => {
        const value = await action();
        const result = value === null ? null : CommandResultSchema.parse(value);
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
            | 'CheckProviderClient'
            | 'AcknowledgeGoogleTerms'
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
        input.command === 'CheckProviderClient' ||
        input.command === 'AcknowledgeGoogleTerms' ||
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
        return source.command(input);
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
    source,
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
    connection,
    preview,
    pending: pending > 0 || detailStale,
    error: error ?? transportError,
    setError: (value: string | null) => {
      setError(value);
      if (value === null) setTransportError(null);
    },
    refresh,
    command,
    metadataCommand,
    pickProject,
    canPickProject: !!source?.pickProject,
    reconnect,
    retryCommand,
    retryAvailable,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
