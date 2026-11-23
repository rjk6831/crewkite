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
import { plainFailure } from '../shared/ipc-error.ts';
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
// Every call into main goes through here, so no card prints Electron's wrapper text.
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (failure) {
    throw plainFailure(failure);
  }
};
const result = async (channel: string, input?: unknown) => {
  const value: unknown = await invoke(channel, ...(input === undefined ? [] : [input]));
  return value === null ? null : CommandResultSchema.parse(value);
};
const readPage = async (
  command: 'GetWorkspaceState' | 'GetProjectPage' | 'GetTaskPage',
  payload: unknown,
) => {
  const result = CommandResultSchema.parse(await invoke('crewkite:command', { command, payload }));
  if (result.outcome !== 'applied' || !result.data)
    throw new Error(result.reason ?? 'Workspace read unavailable.');
  return result.data;
};
const findFiles = async (input: unknown) => desktopFiles(await invoke('crewkite:attach', input));
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
  if (input.from === 'paste-text')
    return findFiles({ from: 'clipboard-text', length: input.length });
  const files: unknown[] = [...input.files].slice(0, MAX_ATTACH_FILES);
  const paths = droppedPaths(files, pathOf);
  const found = paths.length > 0 ? await findFiles({ from: 'paths', paths }) : [];
  const unnamed = input.from === 'paste' && paths.length < files.length;
  return unnamed ? [...found, ...(await findFiles({ from: 'clipboard' }))] : found;
};
const tokenStatus = async (channel: string): Promise<LocalTokenStatus> => {
  const value: unknown = await invoke(channel);
  const found = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    available: found.available === true,
    remembered: found.remembered === true,
    ...(typeof found.reason === 'string' ? { reason: found.reason.slice(0, 200) } : {}),
  };
};
const bridge: DesktopSource = {
  verifyArtifact: async (input) =>
    ArtifactVerificationSchema.parse(
      await invoke('crewkite:verify-artifact', {
        requestId: input.requestId,
        artifact: ArtifactSchema.parse(input.artifact),
      }),
    ),
  cancelArtifactVerification: async (requestId) => {
    await invoke('crewkite:cancel-artifact-verification', requestId);
  },
  getSnapshot: async (scope) => SnapshotSchema.parse(await invoke('crewkite:snapshot', scope)),
  workspaceState: async () => WorkspaceStateSchema.parse(await readPage('GetWorkspaceState', {})),
  projectPage: async (input) => ProjectPageSchema.parse(await readPage('GetProjectPage', input)),
  taskPage: async (input) => TaskPageSchema.parse(await readPage('GetTaskPage', input)),
  command: async (input) => CommandResultSchema.parse(await invoke('crewkite:command', input)),
  subscribe(listener) {
    events.add(listener);
    if (!subscribed) {
      subscribed = true;
      void invoke('crewkite:events').catch(() => {
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
    const value: unknown = await invoke('crewkite:open-link', String(url));
    return value === 'opened' || value === 'declined' ? value : 'refused';
  },
  attachFiles,
  openAttachment: async (input) => {
    const target = attachmentTarget(input);
    if (!target) throw new Error('The file request is invalid.');
    const value: unknown = await invoke('crewkite:open-attachment', target);
    return value === 'cancelled' ? 'cancelled' : 'done';
  },
  savePrompts: async () => {
    const value: unknown = await invoke('crewkite:save-prompts');
    return value === 'cancelled' ? 'cancelled' : 'saved';
  },
  exportDiagnostics: async (input) => {
    const value: unknown = await invoke('crewkite:export-diagnostics', input);
    return value === 'saved' ? 'saved' : 'cancelled';
  },
  feedbackDraft: async (input) => {
    const value: unknown = await invoke('crewkite:feedback-draft', input);
    if (typeof value !== 'string') throw new Error('The report could not be made.');
    return value;
  },
  sendFeedback: async (input) => {
    const value: unknown = await invoke('crewkite:feedback-send', input);
    return value === 'done' ? 'done' : 'refused';
  },
  saveNotes: async (projectId) => {
    const value: unknown = await invoke('crewkite:save-notes', projectId);
    return value === 'cancelled' ? 'cancelled' : 'saved';
  },
  saveResults: async (projectId) => {
    const value: unknown = await invoke('crewkite:save-results', projectId);
    if (typeof value === 'object' && value !== null && 'records' in value && 'file' in value) {
      const { records, file } = value;
      if (typeof records === 'number' && typeof file === 'string') return { records, file };
    }
    return 'cancelled';
  },
  saveAnalytics: async (input) => {
    const payload = ReadChatAnalyticsPayloadSchema.safeParse(input);
    if (!payload.success) throw new Error('The usage request is invalid.');
    const value: unknown = await invoke('crewkite:save-analytics', payload.data);
    return value === 'cancelled' ? 'cancelled' : 'saved';
  },
  previewShare: async (taskId) => {
    const shared = ChatExportSchema.parse(await invoke('crewkite:export-preview', String(taskId)));
    return {
      html: shared.content,
      filename: shared.filename,
      turns: shared.turns,
      omitted: shared.omitted,
    };
  },
  dismissCrash: async () => {
    await invoke('crewkite:dismiss-crash');
  },
  saveExport: async (input) => {
    const value: unknown = await invoke('crewkite:export-save', {
      taskId: String(input.taskId),
      format: input.format,
    });
    return value === 'cancelled' ? 'cancelled' : 'saved';
  },
  pickProject: () => result('crewkite:pick-project'),
  reconnect: async () => {
    await invoke('crewkite:reconnect');
  },
  retryCommand: (expected) => result('crewkite:retry', expected),
  threadAttention: async (input) => {
    const attention = threadAttention(input);
    if (!attention) throw new Error('The thread notice is invalid.');
    await invoke('crewkite:thread-attention', attention);
  },
  localTokenStatus: () => tokenStatus('crewkite:local-token-status'),
  rememberLocalToken: () => tokenStatus('crewkite:local-token-remember'),
  forgetLocalToken: () => tokenStatus('crewkite:local-token-forget'),
  mcp: {
    state: async () => McpStateSchema.parse(await invoke('crewkite:mcp-state')),
    save: async (server) => McpStateSchema.parse(await invoke('crewkite:mcp-save', server)),
    remove: async (name) => McpStateSchema.parse(await invoke('crewkite:mcp-remove', { name })),
    setThread: async (taskId, name, policy) =>
      McpStateSchema.parse(await invoke('crewkite:mcp-thread', { taskId, name, policy })),
  },
  onboarding: {
    finished: async () => (await invoke('crewkite:onboarding-read')) === true,
    setFinished: async (finished) => {
      await invoke('crewkite:onboarding-write', finished === true);
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
