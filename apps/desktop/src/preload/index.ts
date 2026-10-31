import type { DesktopSource, LocalTokenStatus } from '@crewkite/client';
import {
  ArtifactSchema,
  ArtifactVerificationSchema,
  ChatExportSchema,
  CommandResultSchema,
  DesktopNoticeSchema,
  EventSchema,
  McpStateSchema,
  ProjectPageSchema,
  ReadChatAnalyticsPayloadSchema,
  SnapshotSchema,
  TaskPageSchema,
  WorkspaceStateSchema,
} from '@crewkite/contracts';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { desktopFiles, droppedPaths, MAX_ATTACH_FILES } from '../shared/attach.ts';
import { attachmentTarget } from '../shared/open-file.ts';
import { TASK_ID_PATTERN, threadAttention } from '../shared/thread-notice.ts';

const events = new Set<Parameters<DesktopSource['subscribe']>[0]>();
const notices = new Set<(notice: ReturnType<typeof DesktopNoticeSchema.parse>) => void>();
const recent = new Map<string, ReturnType<typeof DesktopNoticeSchema.parse>>();
let subscribed = false;
ipcRenderer.on('crewkite:event', (_event, value: unknown) => {
  const parsed = EventSchema.safeParse(value);
  if (parsed.success) for (const listener of events) listener(parsed.data);
});
const openThread = new Set<(taskId: string) => void>();
ipcRenderer.on('crewkite:open-thread', (_event, value: unknown) => {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) return;
  for (const listener of openThread) listener(value);
});
ipcRenderer.on('crewkite:notice', (_event, value: unknown) => {
  const parsed = DesktopNoticeSchema.safeParse(value);
  if (!parsed.success) return;
  recent.set(parsed.data.kind, parsed.data);
  for (const listener of notices) listener(parsed.data);
});
const result = async (channel: string, input?: unknown) => {
  const value: unknown = await ipcRenderer.invoke(channel, ...(input === undefined ? [] : [input]));
  return value === null ? null : CommandResultSchema.parse(value);
};
const readPage = async (
  command: 'GetWorkspaceState' | 'GetProjectPage' | 'GetTaskPage',
  payload: unknown,
) => {
  const result = CommandResultSchema.parse(
    await ipcRenderer.invoke('crewkite:command', { command, payload }),
  );
  if (result.outcome !== 'applied' || !result.data)
    throw new Error(result.reason ?? 'Workspace read unavailable.');
  return result.data;
};
// Main's own sentence, without the IPC wrapper text Electron puts in front of it.
const plain = (failure: unknown) =>
  new Error(
    failure instanceof Error
      ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      : 'The files could not be read.',
  );
const findFiles = async (input: unknown) => {
  try {
    return desktopFiles(await ipcRenderer.invoke('crewkite:attach', input));
  } catch (failure) {
    throw plain(failure);
  }
};
// Anything that is not a file from the page has no path.
const pathOf = (file: File) => {
  try {
    return webUtils.getPathForFile(file);
  } catch {
    return '';
  }
};
// A dropped or pasted file carries its path only here. A pasted screenshot has none, so main
// reads the clipboard image for it.
const attachFiles: NonNullable<DesktopSource['attachFiles']> = async (input) => {
  if (input.from === 'picker') return findFiles({ from: 'picker' });
  if (input.from === 'paste-text') return findFiles({ from: 'clipboard-text' });
  const files: unknown[] = [...input.files].slice(0, MAX_ATTACH_FILES);
  const paths = droppedPaths(files, pathOf);
  const found = paths.length > 0 ? await findFiles({ from: 'paths', paths }) : [];
  const unnamed = input.from === 'paste' && paths.length < files.length;
  return unnamed ? [...found, ...(await findFiles({ from: 'clipboard' }))] : found;
};
const tokenStatus = async (channel: string): Promise<LocalTokenStatus> => {
  try {
    const value: unknown = await ipcRenderer.invoke(channel);
    const found = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return {
      available: found.available === true,
      remembered: found.remembered === true,
      ...(typeof found.reason === 'string' ? { reason: found.reason.slice(0, 200) } : {}),
    };
  } catch (failure) {
    throw plain(failure);
  }
};
const bridge: DesktopSource = {
  verifyArtifact: async (input) =>
    ArtifactVerificationSchema.parse(
      await ipcRenderer.invoke('crewkite:verify-artifact', {
        requestId: input.requestId,
        artifact: ArtifactSchema.parse(input.artifact),
      }),
    ),
  cancelArtifactVerification: async (requestId) => {
    await ipcRenderer.invoke('crewkite:cancel-artifact-verification', requestId);
  },
  getSnapshot: async (scope) =>
    SnapshotSchema.parse(await ipcRenderer.invoke('crewkite:snapshot', scope)),
  workspaceState: async () => WorkspaceStateSchema.parse(await readPage('GetWorkspaceState', {})),
  projectPage: async (input) => ProjectPageSchema.parse(await readPage('GetProjectPage', input)),
  taskPage: async (input) => TaskPageSchema.parse(await readPage('GetTaskPage', input)),
  command: async (input) =>
    CommandResultSchema.parse(await ipcRenderer.invoke('crewkite:command', input)),
  subscribe(listener) {
    events.add(listener);
    if (!subscribed) {
      subscribed = true;
      void ipcRenderer.invoke('crewkite:events').catch(() => {
        subscribed = false;
      });
    }
    return () => {
      events.delete(listener);
    };
  },
  onConnection(listener) {
    const current = recent.get('connection');
    if (current?.kind === 'connection') listener(current.state);
    const receive = (notice: ReturnType<typeof DesktopNoticeSchema.parse>) => {
      if (notice.kind === 'connection') listener(notice.state);
    };
    notices.add(receive);
    return () => {
      notices.delete(receive);
    };
  },
  openLink: async (url) => {
    const value: unknown = await ipcRenderer.invoke('crewkite:open-link', String(url));
    return value === 'opened' || value === 'declined' ? value : 'refused';
  },
  attachFiles,
  openAttachment: async (input) => {
    const target = attachmentTarget(input);
    if (!target) throw new Error('The file request is invalid.');
    try {
      const value: unknown = await ipcRenderer.invoke('crewkite:open-attachment', target);
      return value === 'cancelled' ? 'cancelled' : 'done';
    } catch (failure) {
      throw plain(failure);
    }
  },
  savePrompts: async () => {
    try {
      const value: unknown = await ipcRenderer.invoke('crewkite:save-prompts');
      return value === 'cancelled' ? 'cancelled' : 'saved';
    } catch (failure) {
      throw plain(failure);
    }
  },
  exportDiagnostics: async (input) => {
    try {
      const value: unknown = await ipcRenderer.invoke('crewkite:export-diagnostics', input);
      return value === 'saved' ? 'saved' : 'cancelled';
    } catch (failure) {
      throw plain(failure);
    }
  },
  saveNotes: async (projectId) => {
    try {
      const value: unknown = await ipcRenderer.invoke('crewkite:save-notes', projectId);
      return value === 'cancelled' ? 'cancelled' : 'saved';
    } catch (failure) {
      throw plain(failure);
    }
  },
  saveAnalytics: async (input) => {
    const payload = ReadChatAnalyticsPayloadSchema.safeParse(input);
    if (!payload.success) throw new Error('The usage request is invalid.');
    try {
      const value: unknown = await ipcRenderer.invoke('crewkite:save-analytics', payload.data);
      return value === 'cancelled' ? 'cancelled' : 'saved';
    } catch (failure) {
      throw plain(failure);
    }
  },
  previewShare: async (taskId) => {
    try {
      const shared = ChatExportSchema.parse(
        await ipcRenderer.invoke('crewkite:export-preview', String(taskId)),
      );
      return {
        html: shared.content,
        filename: shared.filename,
        turns: shared.turns,
        omitted: shared.omitted,
      };
    } catch (failure) {
      throw plain(failure);
    }
  },
  dismissCrash: async () => {
    await ipcRenderer.invoke('crewkite:dismiss-crash');
  },
  saveExport: async (input) => {
    try {
      const value: unknown = await ipcRenderer.invoke('crewkite:export-save', {
        taskId: String(input.taskId),
        format: input.format,
      });
      return value === 'cancelled' ? 'cancelled' : 'saved';
    } catch (failure) {
      throw plain(failure);
    }
  },
  pickProject: () => result('crewkite:pick-project'),
  reconnect: async () => {
    await ipcRenderer.invoke('crewkite:reconnect');
  },
  retryCommand: (expected) => result('crewkite:retry', expected),
  threadAttention: async (input) => {
    const attention = threadAttention(input);
    if (!attention) throw new Error('The thread notice is invalid.');
    await ipcRenderer.invoke('crewkite:thread-attention', attention);
  },
  localTokenStatus: () => tokenStatus('crewkite:local-token-status'),
  rememberLocalToken: () => tokenStatus('crewkite:local-token-remember'),
  forgetLocalToken: () => tokenStatus('crewkite:local-token-forget'),
  mcp: {
    state: async () => McpStateSchema.parse(await ipcRenderer.invoke('crewkite:mcp-state')),
    save: async (server) =>
      McpStateSchema.parse(await ipcRenderer.invoke('crewkite:mcp-save', server)),
    remove: async (name) =>
      McpStateSchema.parse(await ipcRenderer.invoke('crewkite:mcp-remove', { name })),
    setThread: async (taskId, name, policy) =>
      McpStateSchema.parse(
        await ipcRenderer.invoke('crewkite:mcp-thread', { taskId, name, policy }),
      ),
  },
  onboarding: {
    finished: async () => (await ipcRenderer.invoke('crewkite:onboarding-read')) === true,
    setFinished: async (finished) => {
      await ipcRenderer.invoke('crewkite:onboarding-write', finished === true);
    },
  },
  onOpenThread(listener) {
    openThread.add(listener);
    return () => {
      openThread.delete(listener);
    };
  },
  onNotice(listener) {
    for (const notice of recent.values()) listener(notice);
    notices.add(listener);
    return () => {
      notices.delete(listener);
    };
  },
};
contextBridge.exposeInMainWorld('crewkite', Object.freeze(bridge));
