import { spawnSync } from 'node:child_process';
import {
  AcceptChatChangesPayloadSchema,
  type ChatAttachment,
  ChatAttachmentSchema,
  type ChatBranchStatus,
  ChatBranchStatusSchema,
  type ChatCatalogRead,
  ChatCatalogReadSchema,
  type ChatChangesRead,
  ChatChangesReadSchema,
  type ChatMessage,
  ChatMessageSchema,
  type ChatModelSelection,
  type ChatSearchResult,
  ChatSearchResultSchema,
  type ChatThreadRead,
  ChatThreadReadSchema,
  type ChatTurnEventsRead,
  ChatTurnEventsReadSchema,
  type Command,
  type CommandResult,
  CommandSchema,
  ConversationEntrySchema,
  type DiagnosticsRead,
  DiagnosticsReadSchema,
  type Event,
  type ProjectPage,
  type ProjectPageRequest,
  type SavedPrompts,
  SavedPromptsSchema,
  type Task,
  type TaskPage,
  type TaskPageRequest,
  TaskSchema,
  type TaskSummary,
  type WorkspaceState,
} from '@crewkite/contracts';
import { completeMentionLocally, type MentionCandidate } from './composer-shared.ts';

// Every chat command the CLI sends, in one place. Each payload goes through the contract schema
// the controller checks again, and the controller decides. The CLI adds no permission, acceptance
// or limit of its own.

/** The part of the controller client the chat commands use. Tests pass the real socket client. */
export type ChatTransport = {
  command(input: Command): Promise<CommandResult>;
  subscribe(
    after: string,
    onEvent: (event: Event) => void,
    onResync?: () => void,
  ): Promise<() => void>;
  /** Called once the client stops trying to reconnect. Returns the call that removes it. */
  onReconnectExhausted?(listener: () => void): () => void;
  workspaceState(): Promise<WorkspaceState>;
  projectPage(input: ProjectPageRequest): Promise<ProjectPage>;
  taskPage(input: TaskPageRequest): Promise<TaskPage>;
  close(): void;
};

// Reads carry no revision. Their names start with Read, apart from these.
const readCommands = new Set(['CompleteChatMention', 'InspectSource', 'SearchChatHistory']);
// Chat mutations carry revision zero, as the desktop's do. The controller does not race chat
// commands on the task revision.
const CHAT_REVISION = 0;
export const applied = (result: CommandResult) =>
  result.outcome === 'applied' || result.outcome === 'already-applied';

export class CommandRefused extends Error {
  readonly result: CommandResult;
  constructor(result: CommandResult) {
    // The next step is the sentence written for the person. The reason is a code for the log.
    super(result.next ?? result.reason ?? 'The controller did not accept this request.');
    this.name = 'CommandRefused';
    this.result = result;
  }
}

export type ChatClient = ReturnType<typeof chatClient>;

export function chatClient(
  transport: ChatTransport,
  options: { key: () => string; actor: Command['actor'] },
) {
  const send = (command: string, payload: unknown): Promise<CommandResult> =>
    transport.command(
      CommandSchema.parse({
        protocol: 1,
        key: options.key(),
        actor: options.actor,
        command,
        payload,
        ...(command.startsWith('Read') || readCommands.has(command)
          ? {}
          : { expectedRevision: CHAT_REVISION }),
      }),
    );
  const run = async (command: string, payload: unknown) => {
    const result = await send(command, payload);
    if (!applied(result)) throw new CommandRefused(result);
    return result;
  };
  async function read<T>(
    command: string,
    payload: unknown,
    schema: { parse(data: unknown): T },
  ): Promise<T> {
    const { data } = await run(command, payload);
    if (data === undefined) throw new Error('The controller returned no data for this request.');
    const { kind: _kind, ...rest } = data as Record<string, unknown>;
    return schema.parse(rest);
  }
  return {
    transport,
    send,
    run,
    readThread: (taskId: string, beforeCursor?: string): Promise<ChatThreadRead> =>
      read('ReadChatThread', { taskId, limit: 200, beforeCursor }, ChatThreadReadSchema),
    readTurnEvents: (taskId: string, turnId: string, afterCursor?: string) =>
      read(
        'ReadChatTurnEvents',
        { taskId, turnId, afterCursor },
        ChatTurnEventsReadSchema,
      ) as Promise<ChatTurnEventsRead>,
    readChanges: (taskId: string): Promise<ChatChangesRead> =>
      read('ReadChatChanges', { taskId }, ChatChangesReadSchema),
    readDiagnostics: (taskId?: string): Promise<DiagnosticsRead> =>
      read('ReadDiagnostics', taskId ? { taskId } : {}, DiagnosticsReadSchema),
    searchHistory: (input: {
      query: string;
      limit?: number;
      perThread?: number;
    }): Promise<ChatSearchResult> =>
      read(
        'SearchChatHistory',
        {
          query: input.query,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.perThread === undefined ? {} : { perThread: input.perThread }),
        },
        ChatSearchResultSchema,
      ),
    readPrompts: (): Promise<SavedPrompts> => read('ReadChatPrompts', {}, SavedPromptsSchema),
    readCatalog: (taskId?: string): Promise<ChatCatalogRead> =>
      read('ReadChatCatalog', taskId ? { taskId } : {}, ChatCatalogReadSchema),
    readBranchStatus: (taskId: string, branch: string): Promise<ChatBranchStatus> =>
      read('ReadChatBranchStatus', { taskId, branch }, ChatBranchStatusSchema),
    /** The first message creates the thread's task, the way the desktop's new thread does. */
    async createThread(projectId: string, text: string): Promise<Task> {
      const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? text;
      const result = await run('CreateTask', {
        projectId,
        title: firstLine.trim().slice(0, 80) || 'New thread',
        outcome: text.slice(0, 4096) || 'New thread',
        criteria: ['The request in this thread is addressed.'],
      });
      return TaskSchema.parse(result.entity);
    },
    sendMessage: (input: {
      taskId: string;
      text: string;
      selection?: ChatModelSelection;
      role?: 'assistant' | 'reviewer' | 'advisor' | 'challenger';
      files?: ChatAttachment[];
    }) => run('SendChatMessage', { ...input, files: input.files ?? [] }),
    importAttachment: (taskId: string, path: string): Promise<ChatAttachment> =>
      read('ImportChatAttachment', { taskId, source: { path } }, ChatAttachmentSchema),
    resolvePermission: (taskId: string, turnId: string, requestId: string, choice: string) =>
      run('ResolveChatPermission', { taskId, turnId, requestId, choice }),
    stopTurn: (taskId: string, turnId: string) => run('StopChatTurn', { taskId, turnId }),
    configure: (input: { taskId: string } & Record<string, unknown>) =>
      run('ConfigureChatThread', input),
    steer: (taskId: string, messageId: string) => run('SteerChatMessage', { taskId, messageId }),
    handoff: (taskId: string, selection: ChatModelSelection) =>
      run('HandoffChatThread', { taskId, selection, reason: 'manual' }),
    retry: (input: {
      taskId: string;
      turnId: string;
      mode: 'retry' | 'regenerate' | 'continue';
      selection?: ChatModelSelection;
    }) => run('RetryChatTurn', input),
    ask: (taskId: string, family: string, question: string, model?: string) =>
      run('AskChatFamily', { taskId, family, question, ...(model ? { model } : {}) }),
    runPlan: (input: {
      taskId: string;
      planId: string;
      sliceId?: number;
      overrides?: { sliceId: number; family: string; model: string }[];
    }) => run('RunChatPlan', input),
    cancelPlan: (taskId: string, planId: string) => run('CancelChatPlan', { taskId, planId }),
    discard: (taskId: string, path: string) => send('DiscardChatChange', { taskId, path }),
    /** A refusal comes back as the result, so a view can show each reason on its own line. */
    accept: (taskId: string, branch: string, message?: string) => {
      const payload = AcceptChatChangesPayloadSchema.safeParse({ taskId, branch, message });
      if (!payload.success)
        return Promise.resolve<CommandResult>({
          outcome: 'denied',
          reason: 'branch-name-unsupported',
          next: 'Use lower case letters, digits, / and - for the branch name.',
        });
      return send('AcceptChatChanges', payload.data);
    },
    /**
     * `confirmed` is true only after the person answered the push question, in the view or with
     * --confirm on the command line. The controller refuses a push without it.
     */
    push: (taskId: string, branch: string, remote = 'origin') =>
      send('PushChatBranch', { taskId, branch, remote, confirmed: true }),
    openPullRequest: (taskId: string, branch: string, title: string, body = '') =>
      send('OpenChatPullRequest', { taskId, branch, title, body }),
    async listThreads(): Promise<{ threads: TaskSummary[]; complete: boolean }> {
      const header = await transport.workspaceState();
      const threads: TaskSummary[] = [];
      let after: TaskPage['next'] = null;
      for (let page = 0; page < 1000; page++) {
        const read: TaskPage = await transport.taskPage({
          stamp: header.stamp,
          ...(after ? { after } : {}),
        });
        threads.push(...read.tasks);
        if (read.complete) return { threads, complete: true };
        after = read.next;
      }
      return { threads, complete: false };
    },
    async listProjects(): Promise<ProjectPage['projects']> {
      const header = await transport.workspaceState();
      const projects: ProjectPage['projects'] = [];
      let after: ProjectPage['next'] = null;
      for (let page = 0; page < 100; page++) {
        const read: ProjectPage = await transport.projectPage({
          stamp: header.stamp,
          ...(after ? { after } : {}),
        });
        projects.push(...read.projects);
        if (read.complete) break;
        after = read.next;
      }
      return projects;
    },
    /**
     * Ranked @file and @folder candidates for the thread. CompleteChatMention lists the scratch
     * copy; a controller without it leaves the CLI to list the committed files of the project
     * checkout, ranked the same way.
     */
    async completeMention(
      taskId: string | null,
      projectPath: string | null,
      query: string,
      limit: number,
    ): Promise<MentionCandidate[]> {
      if (taskId) {
        try {
          const result = await send('CompleteChatMention', { taskId, query, limit });
          const data = result.data as { mentions?: MentionCandidate[] } | undefined;
          if (applied(result) && Array.isArray(data?.mentions)) return data.mentions;
        } catch {}
      }
      return projectPath ? completeMentionLocally(trackedFiles(projectPath), query, limit) : [];
    },
  };
}

const trackedCache = new Map<string, readonly string[]>();
/** The committed paths of a checkout. Read once per path; git runs with no hooks or pager. */
function trackedFiles(directory: string): readonly string[] {
  const cached = trackedCache.get(directory);
  if (cached) return cached;
  const listed = spawnSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-z'], {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10_000,
    env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
  });
  const files = listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
  trackedCache.set(directory, files);
  return files;
}

/** A stored message, from the current shape or the older conversation entry shape. */
export function threadMessage(payload: unknown): ChatMessage | null {
  const direct = ChatMessageSchema.safeParse(payload);
  if (direct.success) return direct.data;
  const entry = ConversationEntrySchema.safeParse(payload);
  if (!entry.success || !['user-message', 'guidance', 'answer'].includes(entry.data.kind))
    return null;
  const { id, taskId, at, cursor, text } = entry.data;
  const sent = entry.data.kind === 'user-message' ? entry.data : null;
  return {
    id,
    taskId,
    at,
    cursor,
    text,
    author: { kind: 'user' },
    attachments: sent?.attachments ?? [],
    files: sent?.files ?? [],
  };
}
