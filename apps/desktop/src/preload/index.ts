import type { DesktopSource } from '@crewkite/client';
import {
  ArtifactSchema,
  ArtifactVerificationSchema,
  CommandResultSchema,
  DesktopNoticeSchema,
  EventSchema,
  ProjectPageSchema,
  SnapshotSchema,
  TaskPageSchema,
  WorkspaceStateSchema,
} from '@crewkite/contracts';
import { contextBridge, ipcRenderer } from 'electron';

const events = new Set<Parameters<DesktopSource['subscribe']>[0]>();
const notices = new Set<(notice: ReturnType<typeof DesktopNoticeSchema.parse>) => void>();
const recent = new Map<string, ReturnType<typeof DesktopNoticeSchema.parse>>();
let subscribed = false;
ipcRenderer.on('crewkite:event', (_event, value: unknown) => {
  const parsed = EventSchema.safeParse(value);
  if (parsed.success) for (const listener of events) listener(parsed.data);
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
  pickProject: () => result('crewkite:pick-project'),
  reconnect: async () => {
    await ipcRenderer.invoke('crewkite:reconnect');
  },
  retryCommand: (expected) => result('crewkite:retry', expected),
  onNotice(listener) {
    for (const notice of recent.values()) listener(notice);
    notices.add(listener);
    return () => {
      notices.delete(listener);
    };
  },
};
contextBridge.exposeInMainWorld('crewkite', Object.freeze(bridge));
