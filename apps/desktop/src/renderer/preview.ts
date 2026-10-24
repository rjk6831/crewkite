import {
  type CommandResult,
  canonicalJson,
  type Event,
  type ProjectPageRequest,
  type Task,
  type TaskPageRequest,
  type WorkspaceStamp,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestIds, DEMO_TIME } from '@crewkite/testkit';
import { settingsPreview } from './settings/preview-data.ts';
import type { DesktopCommand, DesktopSource } from './source.ts';
import { createThreadScript } from './thread/preview-script.ts';

export function createPreviewSource(): DesktopSource {
  const fixtures = createDemoFixtures();
  const state = structuredClone(fixtures.snapshot);
  state.tasks = [structuredClone(fixtures.task)];
  const { localHardware, ...providers } = settingsPreview(state.routes, DEMO_TIME);
  Object.assign(state, providers);
  const id = createTestIds(DEMO_TIME, 1000n);
  const listeners = new Set<(event: Event) => void>();
  let cursor = 0n;
  function emit(type: Event['type'] | string, payload: unknown, task: Task) {
    cursor += 1n;
    state.cursor = cursor.toString();
    const event = {
      protocol: 1,
      id: id('evt'),
      cursor: state.cursor,
      at: DEMO_TIME,
      taskId: task.id,
      revision: task.revision,
      type,
      // A thread event may build its payload from the cursor it is given.
      payload: typeof payload === 'function' ? payload(state.cursor) : payload,
    } as Event;
    for (const listener of listeners) listener(structuredClone(event));
    return state.cursor;
  }
  const chatCommands = new Set([
    'ReadChatThread',
    'ReadChatChanges',
    'ReadChatCatalog',
    'SendChatMessage',
    'ResolveChatPermission',
    'StopChatTurn',
    'ConfigureChatThread',
    'HandoffChatThread',
    'AcceptChatChanges',
    'PushChatBranch',
    'OpenChatPullRequest',
    'ReadChatBranchStatus',
  ]);
  const scripts = new Map<string, ReturnType<typeof createThreadScript>>();
  function chatCommand(name: string, payload: Record<string, unknown>): CommandResult | null {
    if (!chatCommands.has(name)) return null;
    // The catalog read has no task, and the scripted thread answers it for the demo task.
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : fixtures.task.id;
    const task = state.tasks.find(({ id }) => id === taskId);
    if (!task) return { outcome: 'blocked', reason: 'The preview task could not be found.' };
    let script = scripts.get(taskId);
    if (!script) {
      script = createThreadScript(
        {
          publish: (type, value) => emit(type, value, task),
          advance(to) {
            if (cursor < to) {
              cursor = to;
              state.cursor = to.toString();
            }
          },
          cursor: () => state.cursor,
        },
        taskId,
        taskId === fixtures.task.id,
      );
      scripts.set(taskId, script);
    }
    return script.command(name, payload);
  }
  async function command(input: DesktopCommand): Promise<CommandResult> {
    const chat = chatCommand(
      (input as { command: string }).command,
      input.payload as Record<string, unknown>,
    );
    if (chat) return chat;
    switch (input.command) {
      case 'CreateTask': {
        const created: Task = {
          ...input.payload,
          id: id('tsk'),
          state: 'draft',
          waitingReason: null,
          revision: 0,
          runId: null,
          next: 'Prepare the run.',
        };
        state.tasks.push(created);
        emit('task.created', created, created);
        return { outcome: 'applied', entity: created, revision: created.revision };
      }
      case 'GetSnapshot':
        return { outcome: 'applied', data: { kind: 'snapshot', snapshot: structuredClone(state) } };
      default:
        return {
          outcome: 'unsupported',
          reason: 'This action needs the connected controller.',
          next: 'Open the desktop demo.',
        };
    }
  }
  let projection = '';
  let generation = 0n;
  const currentStamp = (): WorkspaceStamp => {
    const next = canonicalJson({
      projects: state.projects.map(({ id, name }) => ({ id, name })),
      tasks: state.tasks.map(({ id, projectId, title, outcome, criteria }) => ({
        id,
        projectId,
        title,
        outcome,
        criteria,
      })),
    });
    if (next !== projection) {
      projection = next;
      generation += 1n;
    }
    return { epoch: '0'.repeat(32), revision: generation.toString() };
  };
  const workspaceState = async () => ({
    kind: 'workspace-state' as const,
    version: 1 as const,
    protocol: 1 as const,
    stamp: currentStamp(),
    cursor: state.cursor,
    routes: state.routes,
    usage: state.usage,
    usageReaders: state.usageReaders,
    nativeProfiles: state.nativeProfiles,
    googleAcpSetup: state.googleAcpSetup,
    googleAcpInstall: state.googleAcpInstall,
    nativeConnections: state.nativeConnections,
    localSetup: state.localSetup,
    localHardware,
  });
  const projectPage = async (input: Omit<ProjectPageRequest, 'limit'> & { limit?: number }) => ({
    kind: 'project-page' as const,
    version: 1 as const,
    stamp: currentStamp(),
    cursor: state.cursor,
    projects: state.projects
      .filter((project) => !input.projectId || project.id === input.projectId)
      .map((project) => ({
        ...project,
        taskCount: state.tasks.filter((task) => task.projectId === project.id).length,
      })),
    next: null,
    complete: true,
  });
  const taskPage = async (input: Omit<TaskPageRequest, 'limit'> & { limit?: number }) => {
    const query = input.query?.trim();
    const pattern = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'iu') : null;
    const tasks = state.tasks
      .filter(
        (task) =>
          (!input.projectId || task.projectId === input.projectId) &&
          (!input.taskId || task.id === input.taskId),
      )
      .flatMap((task) => {
        const fields = [
          task.title,
          state.projects.find((project) => project.id === task.projectId)?.name ?? '',
          task.outcome,
          ...task.criteria,
          task.id,
          task.projectId,
        ];
        if (pattern && !fields.some((text) => pattern.test(text))) return [];
        const { id, projectId, title, state: status, waitingReason, revision, runId, next } = task;
        return [{ id, projectId, title, state: status, waitingReason, revision, runId, next }];
      });
    return {
      kind: 'task-page' as const,
      version: 1 as const,
      stamp: currentStamp(),
      cursor: state.cursor,
      tasks,
      next: null,
      complete: true,
      scanned: state.tasks.length,
    };
  };
  return {
    workspaceState,
    projectPage,
    taskPage,
    getSnapshot: async (scope) => {
      if (!scope || !('taskId' in scope) || !scope.taskId)
        throw new Error('Choose a task to read its detail.');
      const detail = structuredClone(state);
      detail.tasks = detail.tasks.filter((task) => task.id === scope.taskId);
      return detail;
    },
    command,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onConnection(listener) {
      listener('connected');
      return () => {};
    },
  };
}
