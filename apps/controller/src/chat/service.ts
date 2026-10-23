import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentEvent,
  AgentEventSchema,
  type ChatCatalogRead,
  ChatCatalogReadSchema,
  type ChatChangesRead,
  type ChatFailure,
  ChatFailureSchema,
  type ChatFamily,
  ChatFamilySchema,
  type ChatMessage,
  type ChatModelSelection,
  type ChatSession,
  ChatSessionSchema,
  type ChatThread,
  type ChatThreadRead,
  ChatThreadReadSchema,
  ChatThreadSchema,
  type ChatTurn,
  ChatTurnSchema,
  type Command,
  type CommandResult,
  type ConversationEntry,
  ConversationEntrySchema,
  canonicalJson,
  type Event,
  HandoffChatThreadPayloadSchema,
  MAX_CHAT_ENTRY_BYTES,
  type Project,
  type Task,
} from '@crewkite/contracts';
import { z } from 'zod';
import type { ArtifactFiles } from '../artifacts/index.ts';
import { committedFiles, git, materialize } from '../host/source.ts';
import type { Store } from '../store/index.ts';
import {
  type ChatAdapter,
  type ChatHistoryEntry,
  type ChatTurnHandle,
  type ChatTurnRequest,
  type ChatTurnResult,
  chatFailure,
} from './adapter.ts';
import { scratchChanges } from './changes.ts';
import {
  adviceContext,
  familyName,
  handoffPacket,
  handoffReason,
  reviewContext,
  systemContext,
  withAttachments,
} from './prompt.ts';

export type ChatServiceDeps = {
  store: Store;
  artifacts: ArtifactFiles;
  home: string;
  now: () => string;
  id: (prefix: 'msg' | 'trn') => string;
  emit: (type: Event['type'], taskId: string, revision: number, payload: Event['payload']) => void;
  adapters: ReadonlyMap<ChatFamily, ChatAdapter>;
  /** HOME, PATH and whatever the provider profile resolved for its client. */
  resolveEnvironment: (family: ChatFamily) => NodeJS.ProcessEnv;
  projectPath: (projectId: string) => string | undefined;
  /**
   * Check an explicit selection against the catalog, or pick the default when none is given.
   * Null means nothing usable: the service blocks the send and asks for a pick.
   */
  resolveSelection: (taskId: string, selection?: ChatModelSelection) => ChatModelSelection | null;
  /**
   * One entry per family. `connected` reports what CrewKite observed about the client or
   * connection. `models` holds observed or profile-fixed models only; empty means unknown.
   * `remaining` holds the latest observed usage windows with null for anything not observed.
   */
  catalog: (taskId?: string) => ChatCatalogRead;
};

type Payload<C extends Command['command']> = Extract<Command, { command: C }>['payload'];
type Effects = (() => void)[];
type EntryDraft = ConversationEntry extends infer Entry
  ? Entry extends ConversationEntry
    ? Omit<Entry, 'id' | 'taskId' | 'revision' | 'cursor' | 'at'>
    : never
  : never;
type Ending = {
  state: 'done' | 'stopped' | 'failed';
  failure: ChatFailure | null;
  text: string;
  session: ChatSession | null;
  /** Stored on the turn so a reopened view knows why it ended. */
  stopReason: NonNullable<ChatTurn['stopReason']>;
};
type LiveTurn = {
  taskId: string;
  handle: ChatTurnHandle | null;
  stopRequested: boolean;
  finished: boolean;
  /** Streamed text by item, kept so a stop or crash keeps what the person already saw. */
  items: Map<string, string>;
  /** Open permission requests and the option IDs each one accepts. */
  permissions: Map<string, string[]>;
  noticed: boolean;
  /** Adapters differ on whether they announce the turn edges. The service owns both. */
  started: boolean;
  completed: boolean;
  done: Promise<void>;
};

const HandoffSchema = z.strictObject({
  from: ChatFamilySchema,
  reason: HandoffChatThreadPayloadSchema.shape.reason,
});
type Handoff = z.infer<typeof HandoffSchema>;

const HISTORY_LIMIT = 60;
const TURN_DEADLINE_MS = 30 * 60_000;
const OPEN_STATES = new Set<ChatTurn['state']>(['queued', 'running', 'waiting-permission']);
// One read must fit a 1 MiB frame. Messages get what live events and turns leave.
const READ_BYTES = 900 * 1024;
const LIVE_EVENT_BYTES = 192 * 1024;
const TURN_BYTES = 96 * 1024;
const CHAT_KINDS = "('user-message','chat-assistant','chat-system')";

const blocked = (reason: string, next?: string): CommandResult => ({
  outcome: 'blocked',
  reason,
  ...(next ? { next } : {}),
});
const stoppedResult: ChatTurnResult = {
  stopReason: 'stopped',
  failure: null,
  assistantText: '',
  session: null,
  usage: null,
  changedPaths: [],
};

/**
 * The controller side of a chat thread. Command methods run inside the controller's
 * command transaction and push provider calls to `effects`, which run after commit.
 * Adapter callbacks and turn results write in their own transactions.
 */
export class ChatService {
  private readonly deps: ChatServiceDeps;
  private readonly live = new Map<string, LiveTurn>();
  private closed = false;

  constructor(deps: ChatServiceDeps) {
    this.deps = deps;
  }

  sendMessage(payload: Payload<'SendChatMessage'>, effects: Effects): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const thread = this.thread(task.id);
    if (thread.activeTurnId)
      return blocked('turn-running', 'Wait for the reply or stop it, then send again.');
    const selection = payload.selection
      ? this.deps.resolveSelection(task.id, payload.selection)
      : ((thread.selection && this.deps.resolveSelection(task.id, thread.selection)) ??
        this.deps.resolveSelection(task.id));
    if (!selection)
      return blocked('selection-unavailable', 'Pick a provider and model in the composer.');
    if (!this.deps.adapters.has(selection.family))
      return blocked('provider-unavailable', 'Connect this provider in Settings or pick another.');
    const base = thread.base ?? this.head(task);
    if (!base)
      return blocked('project-head-unavailable', 'Commit once in this project, then send again.');
    const message = this.draftEntry(task, {
      kind: 'user-message',
      author: { kind: 'user' },
      text: payload.text,
      ...(payload.attachments.length ? { attachments: payload.attachments } : {}),
    });
    if (!message) return blocked('message-too-large', 'Shorten the message or attach fewer paths.');
    this.saveEntry(task, message);
    this.openTurn(
      task,
      thread,
      { selection, role: payload.role, messageId: message.id, base },
      effects,
    );
    return { outcome: 'applied', revision: task.revision };
  }

  resolvePermission(payload: Payload<'ResolveChatPermission'>, effects: Effects): CommandResult {
    const live = this.activeLive(payload.taskId, payload.turnId);
    if (!live) return blocked('no-active-turn');
    if (!live.permissions.get(payload.requestId)?.includes(payload.choice))
      return blocked('permission-not-pending', 'Refresh the thread and answer the open request.');
    live.permissions.delete(payload.requestId);
    effects.push(() =>
      this.call(() => live.handle?.respondPermission(payload.requestId, payload.choice)),
    );
    return { outcome: 'applied' };
  }

  stopTurn(payload: Payload<'StopChatTurn'>, effects: Effects): CommandResult {
    const live = this.activeLive(payload.taskId, payload.turnId);
    if (!live) return blocked('no-active-turn');
    // The turn result marks the row stopped once the provider has let go.
    live.stopRequested = true;
    effects.push(() => this.call(() => live.handle?.stop()));
    return { outcome: 'applied' };
  }

  configure(payload: Payload<'ConfigureChatThread'>): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const thread = this.thread(task.id);
    const selection = payload.selection
      ? this.deps.resolveSelection(task.id, payload.selection)
      : thread.selection;
    if (payload.selection && !selection)
      return blocked('selection-unavailable', 'Pick a model the provider lists.');
    this.putThread(task, {
      ...thread,
      selection,
      permissionPolicy: payload.permissionPolicy ?? thread.permissionPolicy,
      autoHandoff: payload.autoHandoff ?? thread.autoHandoff,
    });
    return { outcome: 'applied' };
  }

  /**
   * Move the thread to another provider. With `reason: 'limit'` and a stopped message nobody has
   * followed up on, the new turn starts on that same message, so the thread keeps one copy of it.
   * Without `effects` the thread moves and no turn starts.
   */
  handoff(payload: Payload<'HandoffChatThread'>, effects?: Effects): CommandResult {
    const task = this.task(payload.taskId);
    if (!task) return blocked('task-not-found');
    const thread = this.thread(task.id);
    if (thread.activeTurnId)
      return blocked('turn-running', 'Stop the reply, then switch providers.');
    const stopped =
      effects && payload.reason === 'limit' ? this.stoppedOnLimit(task.id) : undefined;
    // The person may have moved the thread already. The packet still names the family that stopped.
    const from = stopped?.selection.family ?? thread.selection?.family;
    if (!from || from === payload.selection.family)
      return blocked('handoff-needs-another-provider', 'Pick a different provider to continue on.');
    const selection = this.deps.resolveSelection(task.id, payload.selection);
    if (!selection) return blocked('selection-unavailable', 'Pick a model the provider lists.');
    if (!this.deps.adapters.has(selection.family))
      return blocked('provider-unavailable', 'Connect this provider in Settings or pick another.');
    this.putThread(task, { ...thread, selection });
    this.setHandoff(task.id, { from, reason: payload.reason });
    if (thread.selection?.family !== selection.family)
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: null },
        text: `Continued on ${familyName[selection.family]} from ${familyName[from]}. Reason: ${handoffReason(payload.reason)}.`,
      });
    if (stopped && effects) this.resend(task, stopped, effects);
    return { outcome: 'applied' };
  }

  readThread(payload: Payload<'ReadChatThread'>): ChatThreadRead {
    const thread = this.thread(payload.taskId);
    const liveEvents = thread.activeTurnId
      ? newest(compact(this.agentEvents(payload.taskId, thread.activeTurnId)), LIVE_EVENT_BYTES)
      : [];
    const turns = newest(this.turns(payload.taskId).slice(-500), TURN_BYTES);
    const used = size(thread) + size(liveEvents) + size(turns);
    const messages = newest(
      this.messages(payload.taskId, payload.beforeCursor, payload.limit),
      READ_BYTES - used,
    );
    return ChatThreadReadSchema.parse({ thread, turns, messages, liveEvents });
  }

  readChanges(payload: Payload<'ReadChatChanges'>): ChatChangesRead {
    const thread = this.thread(payload.taskId);
    const task = this.task(payload.taskId);
    const root = task && this.deps.projectPath(task.projectId);
    if (!thread.scratchReady || !thread.base || !root)
      return { taskId: payload.taskId, base: thread.base, files: [] };
    return {
      taskId: payload.taskId,
      base: thread.base,
      files: scratchChanges(root, this.scratchDirectory(payload.taskId), thread.base),
    };
  }

  readCatalog(payload: Payload<'ReadChatCatalog'>): ChatCatalogRead {
    return ChatCatalogReadSchema.parse(this.deps.catalog(payload.taskId));
  }

  private thread(taskId: string): ChatThread {
    const row = this.deps.store.db
      .prepare('SELECT body FROM chat_threads WHERE task_id=?')
      .get(taskId);
    return ChatThreadSchema.parse(
      row
        ? JSON.parse(row.body as string)
        : { taskId, scratchReady: false, base: null, selection: null },
    );
  }

  /** A turn left open by a previous controller process has no owner. Fail it visibly. */
  recover() {
    const open = this.deps.store.db
      .prepare(
        "SELECT id,task_id FROM chat_turns WHERE json_extract(body,'$.state') IN ('queued','running','waiting-permission') ORDER BY task_id,sequence",
      )
      .all() as { id: string; task_id: string }[];
    if (!open.length) return;
    this.deps.store.transaction(() => {
      for (const row of open) {
        if (this.live.has(row.id)) continue;
        this.settle(row.id, {
          state: 'failed',
          failure: chatFailure({
            stage: 'stream',
            kind: 'internal',
            message: 'The turn did not finish before the controller restarted.',
          }),
          text: streamedText(this.agentEvents(row.task_id, row.id)),
          session: null,
          stopReason: 'error',
        });
      }
    });
  }

  close(): Promise<void> | undefined {
    this.closed = true;
    const running = [...this.live.values()];
    for (const live of running) {
      live.stopRequested = true;
      this.call(() => live.handle?.stop());
    }
    if (!running.length) return;
    return Promise.allSettled(running.map((live) => live.done)).then(() => {});
  }

  private launch(turn: ChatTurn) {
    const live: LiveTurn = {
      taskId: turn.taskId,
      handle: null,
      stopRequested: false,
      finished: false,
      items: new Map(),
      permissions: new Map(),
      noticed: false,
      started: false,
      completed: false,
      done: Promise.resolve(),
    };
    this.live.set(turn.id, live);
    live.done = this.run(turn, live);
  }

  private async run(turn: ChatTurn, live: LiveTurn) {
    let result: ChatTurnResult;
    try {
      result = await this.start(turn, live);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 2000) : 'Unknown error.';
      result = {
        ...stoppedResult,
        stopReason: 'error',
        failure: chatFailure(
          live.handle
            ? {
                stage: 'stream',
                kind: 'client-exit',
                message: 'The provider connection failed during the turn.',
                providerMessage: reason,
              }
            : { stage: 'launch', kind: 'internal', message: `The turn could not start. ${reason}` },
        ),
      };
    }
    this.finish(turn.id, live, result);
  }

  private async start(turn: ChatTurn, live: LiveTurn): Promise<ChatTurnResult> {
    // Yield after durable admission so Stop and reads can see the turn before work starts.
    await new Promise((resolve) => setImmediate(resolve));
    const adapter = this.deps.adapters.get(turn.selection.family);
    if (!adapter) throw Error('No adapter is registered for this provider.');
    if (this.closed || live.stopRequested) return stoppedResult;
    const request = this.request(turn);
    // The first turn copies the project, which takes time. Stop may have arrived meanwhile.
    if (this.closed || live.stopRequested) return stoppedResult;
    this.record(turn, live, {
      type: 'turn.started',
      turnId: turn.id,
      family: turn.selection.family,
      model: turn.selection.model,
      effort: turn.selection.effort,
      role: turn.role,
    });
    live.handle = adapter.startTurn(request, (event) => this.record(turn, live, event));
    if (this.closed || live.stopRequested) live.handle.stop();
    return live.handle.result;
  }

  private request(turn: ChatTurn): ChatTurnRequest {
    const task = this.task(turn.taskId);
    const project = task && this.deps.store.get<Project>('project', task.projectId);
    const root = task && this.deps.projectPath(task.projectId);
    if (!task || !project || !root) throw Error('The project is no longer registered.');
    const thread = this.ensureScratch(task, root);
    const message = this.findEntry(task.id, turn.userMessageId);
    if (message?.kind !== 'user-message' || !thread.base)
      throw Error('The message for this turn is missing.');
    const prompt = withAttachments(message.text, message.attachments ?? []);
    const history = this.history(task.id, message.cursor);
    const work = join(this.deps.home, 'chat', task.id, 'turns', turn.id);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const directory = this.scratchDirectory(task.id);
    const handoff = turn.handoffFrom ? this.takeHandoff(task) : null;
    return {
      turnId: turn.id,
      taskId: task.id,
      role: turn.role,
      selection: turn.selection,
      prompt: turn.handoffFrom
        ? handoffPacket({
            from: turn.handoffFrom,
            to: turn.selection.family,
            reason: handoff?.reason ?? 'manual',
            history,
            files: this.changedFiles(task.id, root, thread.base),
            prompt,
          })
        : prompt,
      systemContext: this.context(turn.role, project.name, directory, root, thread.base, history),
      // The packet carries the transcript, so a handoff turn sends no separate history.
      history: turn.handoffFrom ? [] : history,
      // A review or an opinion starts a fresh native session, so its brief always reaches the model.
      session:
        turn.role === 'assistant'
          ? (thread.sessions.find((session) => session.family === turn.selection.family) ?? null)
          : null,
      scratch: { directory, base: thread.base, projectName: project.name },
      work: { directory: work, home: this.deps.home },
      permissionPolicy: turn.role === 'assistant' ? thread.permissionPolicy : 'ask',
      readOnly: turn.role !== 'assistant',
      deadlineMs: TURN_DEADLINE_MS,
      environment: this.deps.resolveEnvironment(turn.selection.family),
      now: () => Date.parse(this.deps.now()),
    };
  }

  private ensureScratch(task: Task, root: string): ChatThread {
    const thread = this.thread(task.id);
    if (thread.scratchReady) return thread;
    if (!thread.base) throw Error('The thread has no base commit.');
    const directory = this.scratchDirectory(task.id);
    // An interrupted copy leaves a partial directory that no turn has used yet.
    rmSync(directory, { recursive: true, force: true });
    materialize(directory, committedFiles(root, thread.base));
    return this.deps.store.transaction(() =>
      this.putThread(task, { ...this.thread(task.id), scratchReady: true }),
    );
  }

  private record(turn: ChatTurn, live: LiveTurn, value: AgentEvent) {
    if (live.finished) return;
    const parsed = AgentEventSchema.safeParse(value);
    let event: AgentEvent;
    if (parsed.success && parsed.data.turnId === turn.id) event = parsed.data;
    else if (live.noticed) return;
    else {
      live.noticed = true;
      event = {
        type: 'provider.notice',
        turnId: turn.id,
        level: 'warning',
        message: 'The provider sent an update that could not be read. The reply may be incomplete.',
      };
    }
    if (event.type === 'turn.started') {
      if (live.started) return;
      live.started = true;
    }
    if (event.type === 'turn.completed') {
      if (live.completed) return;
      live.completed = true;
    }
    addText(live.items, event);
    if (event.type === 'permission.requested')
      live.permissions.set(
        event.requestId,
        event.options.map((option) => option.id),
      );
    if (event.type === 'permission.resolved') live.permissions.delete(event.requestId);
    try {
      this.deps.store.transaction(() => {
        const task = this.task(turn.taskId) as Task;
        this.deps.emit('agent.event', task.id, task.revision, event);
        if (event.type === 'permission.requested') this.setState(turn.id, 'waiting-permission');
        if (event.type === 'permission.resolved' && !live.permissions.size)
          this.setState(turn.id, 'running');
      });
    } catch {
      // An adapter never sees controller failures. The turn result still settles the row.
    }
  }

  private finish(turnId: string, live: LiveTurn, result: ChatTurnResult) {
    const turn = this.turn(turnId);
    if (turn && !live.completed)
      this.record(turn, live, {
        type: 'turn.completed',
        turnId,
        stopReason: result.stopReason,
        failure: result.failure,
      });
    live.finished = true;
    this.live.delete(turnId);
    try {
      this.deps.store.transaction(() => this.settle(turnId, ending(result, live.items)));
    } catch {
      // The row stays open. Startup recovery fails it with a visible reason.
    }
    if (result.stopReason === 'limit' && !live.stopRequested && !this.closed)
      this.continueOnLimit(turnId);
  }

  private settle(turnId: string, end: Ending) {
    const turn = this.turn(turnId);
    if (!turn || !OPEN_STATES.has(turn.state)) return;
    const task = this.task(turn.taskId) as Task;
    const reply = end.text.trim()
      ? this.appendEntry(task, {
          kind: 'chat-assistant',
          author: {
            kind: 'assistant',
            turnId: turn.id,
            family: turn.selection.family,
            model: turn.selection.model,
            role: turn.role,
          },
          text: fitText(end.text, 262_144),
        })
      : null;
    this.putTurn(task, {
      ...turn,
      state: end.state,
      endedAt: this.deps.now(),
      failure: end.failure,
      assistantMessageId: reply?.id ?? null,
      stopReason: end.stopReason,
    });
    const thread = this.thread(task.id);
    const session =
      turn.role === 'assistant' && end.session?.family === turn.selection.family
        ? end.session
        : null;
    this.putThread(task, {
      ...thread,
      activeTurnId: thread.activeTurnId === turn.id ? null : thread.activeTurnId,
      sessions: session
        ? [...thread.sessions.filter((value) => value.family !== session.family), session]
        : thread.sessions,
    });
    if (end.stopReason === 'limit') this.appendLimitLine(task, turn, end.failure);
    if (end.failure)
      this.appendEntry(task, {
        kind: 'chat-system',
        author: { kind: 'system', turnId: turn.id },
        text: fitText(`${end.failure.message} ${end.failure.nextAction}`, 16_384),
      });
  }

  private appendLimitLine(task: Task, turn: ChatTurn, failure: ChatFailure | null) {
    const resets = failure?.resetsAt
      ? `at ${new Date(failure.resetsAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : 'at an unknown time';
    this.appendEntry(task, {
      kind: 'chat-system',
      author: { kind: 'system', turnId: turn.id },
      text: `${familyName[turn.selection.family]} reached its usage limit. Resets ${resets}.`,
    });
  }

  /**
   * With auto handoff on, a limit stop moves the thread to the family with the most allowance
   * left and runs the same message there. The handoff opens the new turn, so both commit
   * together and a refusal leaves the thread where it was. Without a taker the person chooses
   * from the card.
   */
  private continueOnLimit(turnId: string) {
    try {
      const turn = this.turn(turnId);
      const task = turn && this.task(turn.taskId);
      if (!turn || !task || turn.state !== 'failed') return;
      const thread = this.thread(task.id);
      // A person who already moved the thread has made the choice.
      if (!thread.autoHandoff || thread.selection?.family !== turn.selection.family) return;
      const selection = this.nextFamily(task.id, turn.selection.family);
      if (!selection) return;
      const effects: Effects = [];
      this.deps.store.transaction(() => {
        const moved = this.handoff({ taskId: task.id, selection, reason: 'limit' }, effects);
        if (moved.outcome !== 'applied' || effects.length === 0)
          throw Error('The thread could not move on.');
      });
      for (const effect of effects) this.call(effect);
    } catch {
      // The limit line stands and the card in the thread still offers the switch.
    }
  }

  /** The newest turn, when it ended on a usage limit and the person has written nothing since. */
  private stoppedOnLimit(taskId: string): ChatTurn | undefined {
    const row = this.deps.store.db
      .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence DESC LIMIT 1')
      .get(taskId);
    const turn = row ? ChatTurnSchema.parse(JSON.parse(row.body as string)) : undefined;
    if (!turn || !endedOnLimit(turn)) return;
    const newest = this.deps.store.db
      .prepare(
        "SELECT id FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='user-message' ORDER BY sequence DESC LIMIT 1",
      )
      .get(taskId);
    return newest?.id === turn.userMessageId ? turn : undefined;
  }

  /** Run the stopped message again on the provider the thread just moved to. No new entry is written. */
  private resend(task: Task, stopped: ChatTurn, effects: Effects) {
    const thread = this.thread(task.id);
    const message = this.findEntry(task.id, stopped.userMessageId);
    if (message?.kind !== 'user-message' || !thread.selection || !thread.base) return;
    this.openTurn(
      task,
      thread,
      { selection: thread.selection, role: stopped.role, messageId: message.id, base: thread.base },
      effects,
    );
  }

  /** Open a running turn on a saved user message. The launch waits for the command to commit. */
  private openTurn(
    task: Task,
    thread: ChatThread,
    input: {
      selection: ChatModelSelection;
      role: ChatTurn['role'];
      messageId: string;
      base: string;
    },
    effects: Effects,
  ) {
    const { selection, role, messageId, base } = input;
    // A reviewer or advisor borrows another model. The thread keeps its own choice and any switch
    // still waiting for the next answer.
    const own = role === 'assistant';
    const pending = own ? this.pendingHandoff(task.id) : null;
    // Sending on the provider the thread came from cancels the switch.
    const handoffFrom = pending && pending.from !== selection.family ? pending.from : null;
    if (pending && !handoffFrom) this.setHandoff(task.id, null);
    const turn = ChatTurnSchema.parse({
      id: this.deps.id('trn'),
      taskId: task.id,
      sequence: this.nextSequence(task.id),
      role,
      selection,
      userMessageId: messageId,
      assistantMessageId: null,
      state: 'running',
      startedAt: this.deps.now(),
      endedAt: null,
      failure: null,
      handoffFrom,
    });
    this.putTurn(task, turn);
    this.putThread(task, {
      ...thread,
      base,
      selection: own ? selection : thread.selection,
      activeTurnId: turn.id,
    });
    effects.push(() => this.launch(turn));
  }

  /** Highest remaining percent, then soonest reset. The family that stopped never qualifies. */
  private nextFamily(taskId: string, stopped: ChatFamily): ChatModelSelection | null {
    const ranked = this.deps
      .catalog(taskId)
      .families.filter(
        (entry) =>
          entry.connected && entry.family !== stopped && this.deps.adapters.has(entry.family),
      )
      .map((entry) => ({ entry, ...allowance(entry.remaining) }))
      .sort((a, b) => b.percent - a.percent || a.resetsAt - b.resetsAt);
    for (const { entry } of ranked) {
      const model = entry.defaultModel ?? entry.models[0]?.model;
      if (!model) continue;
      const effort = entry.models.find((value) => value.model === model)?.defaultEffort;
      const selection = this.deps.resolveSelection(taskId, {
        family: entry.family,
        model,
        effort: effort ?? 'default',
      });
      if (selection) return selection;
    }
    return null;
  }

  private activeLive(taskId: string, turnId: string): LiveTurn | undefined {
    const live = this.live.get(turnId);
    if (!live || live.finished || live.taskId !== taskId) return;
    return this.thread(taskId).activeTurnId === turnId ? live : undefined;
  }

  /** Provider calls run after commit. A throwing adapter must not undo a committed command. */
  private call(work: () => void) {
    try {
      work();
    } catch {
      // The turn result reports what happened to the provider process.
    }
  }

  private head(task: Task): string | null {
    const root = this.deps.projectPath(task.projectId);
    if (!root) return null;
    try {
      const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
        .toString('utf8')
        .trim();
      return /^[a-f0-9]{40}$/.test(head) ? head : null;
    } catch {
      return null;
    }
  }

  /** Reviewer and advisor turns get their own brief. Every other turn gets the project framing. */
  private context(
    role: ChatTurn['role'],
    name: string,
    directory: string,
    root: string,
    base: string,
    history: readonly ChatHistoryEntry[],
  ): string {
    if (role === 'advisor')
      return adviceContext(
        name,
        directory,
        history.findLast((entry) => entry.role === 'assistant')?.text ?? null,
      );
    if (role !== 'reviewer') return systemContext(name, directory);
    let files: ChatChangesRead['files'] | null = null;
    try {
      files = scratchChanges(root, directory, base);
    } catch {
      // The brief says the changes could not be read, and the model works from the files.
    }
    return reviewContext(name, directory, base, files);
  }

  private changedFiles(taskId: string, root: string, base: string): string[] | null {
    try {
      return scratchChanges(root, this.scratchDirectory(taskId), base, false).map(
        (file) => `${file.path} +${file.additions} -${file.deletions}`,
      );
    } catch {
      return null;
    }
  }

  private scratchDirectory(taskId: string) {
    return join(this.deps.home, 'chat', taskId, 'scratch');
  }

  private task(taskId: string): Task | undefined {
    return this.deps.store.get<Task>('task', taskId);
  }

  private putThread(task: Task, thread: ChatThread): ChatThread {
    const value = ChatThreadSchema.parse(thread);
    this.deps.store.db
      .prepare(
        'INSERT INTO chat_threads(task_id,body) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body',
      )
      .run(task.id, canonicalJson(value));
    this.deps.emit('chat.thread', task.id, task.revision, value);
    return value;
  }

  private pendingHandoff(taskId: string): Handoff | null {
    const row = this.deps.store.db
      .prepare('SELECT handoff FROM chat_threads WHERE task_id=?')
      .get(taskId);
    return typeof row?.handoff === 'string' ? HandoffSchema.parse(JSON.parse(row.handoff)) : null;
  }

  private setHandoff(taskId: string, value: Handoff | null) {
    this.deps.store.db
      .prepare('UPDATE chat_threads SET handoff=? WHERE task_id=?')
      .run(value ? canonicalJson(HandoffSchema.parse(value)) : null, taskId);
  }

  private takeHandoff(task: Task): Handoff | null {
    return this.deps.store.transaction(() => {
      const handoff = this.pendingHandoff(task.id);
      this.setHandoff(task.id, null);
      return handoff;
    });
  }

  private turn(id: string): ChatTurn | undefined {
    const row = this.deps.store.db.prepare('SELECT body FROM chat_turns WHERE id=?').get(id);
    return row ? ChatTurnSchema.parse(JSON.parse(row.body as string)) : undefined;
  }

  private turns(taskId: string): ChatTurn[] {
    return this.deps.store.db
      .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence')
      .all(taskId)
      .map((row) => ChatTurnSchema.parse(JSON.parse(row.body as string)));
  }

  private nextSequence(taskId: string): number {
    const row = this.deps.store.db
      .prepare('SELECT COALESCE(MAX(sequence)+1,0) AS next FROM chat_turns WHERE task_id=?')
      .get(taskId);
    return Number(row?.next ?? 0);
  }

  private putTurn(task: Task, turn: ChatTurn) {
    const value = ChatTurnSchema.parse(turn);
    this.deps.store.db
      .prepare(
        'INSERT INTO chat_turns(id,task_id,sequence,body) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(value.id, task.id, value.sequence, canonicalJson(value));
    this.deps.emit('chat.turn', task.id, task.revision, value);
  }

  private setState(turnId: string, state: 'running' | 'waiting-permission') {
    const turn = this.turn(turnId);
    if (!turn || !OPEN_STATES.has(turn.state) || turn.state === state) return;
    this.putTurn(this.task(turn.taskId) as Task, { ...turn, state });
  }

  /** Validate before writing so an oversized message blocks the command without a rollback. */
  private draftEntry(task: Task, draft: EntryDraft): ConversationEntry | undefined {
    const parsed = ConversationEntrySchema.safeParse({
      ...draft,
      id: this.deps.id('msg'),
      taskId: task.id,
      revision: task.revision,
      cursor: '0',
      at: this.deps.now(),
    });
    return parsed.success ? parsed.data : undefined;
  }

  private saveEntry(task: Task, entry: ConversationEntry): ConversationEntry {
    const insert = this.deps.store.db.prepare(
      'INSERT INTO conversation_entries(id,task_id,body) VALUES (?,?,?)',
    );
    insert.setReadBigInts(true);
    const cursor = insert.run(entry.id, task.id, '{}').lastInsertRowid.toString();
    const saved = ConversationEntrySchema.parse({ ...entry, cursor });
    this.deps.store.db
      .prepare('UPDATE conversation_entries SET body=? WHERE id=?')
      .run(canonicalJson(saved), saved.id);
    this.deps.emit('conversation.entry', task.id, task.revision, saved);
    return saved;
  }

  private appendEntry(task: Task, draft: EntryDraft): ConversationEntry {
    const entry = this.draftEntry(task, draft);
    if (!entry) throw Error('A chat entry exceeds its limits.');
    return this.saveEntry(task, entry);
  }

  private findEntry(taskId: string, id: string): ConversationEntry | undefined {
    const row = this.deps.store.db
      .prepare('SELECT body FROM conversation_entries WHERE task_id=? AND id=?')
      .get(taskId, id);
    return row ? ConversationEntrySchema.parse(JSON.parse(row.body as string)) : undefined;
  }

  /** Prior user and assistant text, oldest first. The oldest entries drop first. */
  private history(taskId: string, beforeCursor: string): ChatHistoryEntry[] {
    return this.deps.store.db
      .prepare(
        "SELECT body FROM conversation_entries WHERE task_id=? AND sequence<? AND json_extract(body,'$.kind') IN ('user-message','chat-assistant') ORDER BY sequence DESC LIMIT ?",
      )
      .all(taskId, BigInt(beforeCursor), HISTORY_LIMIT)
      .reverse()
      .map((row) => {
        const entry = ConversationEntrySchema.parse(JSON.parse(row.body as string));
        return { role: entry.kind === 'user-message' ? 'user' : 'assistant', text: entry.text };
      });
  }

  /** Messages before the cursor, oldest first. */
  private messages(taskId: string, beforeCursor: string | undefined, limit: number) {
    const ceiling = beforeCursor === undefined ? MAX_CURSOR : BigInt(beforeCursor);
    return this.deps.store.db
      .prepare(
        `SELECT body FROM conversation_entries WHERE task_id=? AND sequence<? AND json_extract(body,'$.kind') IN ${CHAT_KINDS} ORDER BY sequence DESC LIMIT ?`,
      )
      .all(taskId, ceiling > MAX_CURSOR ? MAX_CURSOR : ceiling, limit)
      .reverse()
      .flatMap((row) => {
        const message = chatMessage(ConversationEntrySchema.parse(JSON.parse(row.body as string)));
        return message ? [message] : [];
      });
  }

  private agentEvents(taskId: string, turnId: string): AgentEvent[] {
    return this.deps.store.db
      .prepare(
        "SELECT body FROM events WHERE task_id=? AND json_extract(body,'$.type')='agent.event' AND json_extract(body,'$.payload.turnId')=? ORDER BY cursor",
      )
      .all(taskId, turnId)
      .map((row) => AgentEventSchema.parse(JSON.parse(row.body as string).payload));
  }
}

const MAX_CURSOR = 9223372036854775807n;

function chatMessage(entry: ConversationEntry): ChatMessage | undefined {
  const common = {
    id: entry.id,
    taskId: entry.taskId,
    at: entry.at,
    cursor: entry.cursor,
    text: entry.text,
  };
  if (entry.kind === 'user-message')
    return { ...common, author: { kind: 'user' }, attachments: entry.attachments ?? [] };
  return entry.kind === 'chat-assistant' || entry.kind === 'chat-system'
    ? { ...common, author: entry.author, attachments: [] }
    : undefined;
}

/** Turns written before stop reasons were stored fall back to the failure kind. */
function endedOnLimit(turn: ChatTurn): boolean {
  return turn.stopReason
    ? turn.stopReason === 'limit'
    : turn.state === 'failed' && turn.failure?.kind === 'usage-limit';
}

function ending(result: ChatTurnResult, items: ReadonlyMap<string, string>): Ending {
  const stopReason =
    result.stopReason === 'done' || result.stopReason === 'stopped' || result.stopReason === 'limit'
      ? result.stopReason
      : 'error';
  const state = stopReason === 'done' ? 'done' : stopReason === 'stopped' ? 'stopped' : 'failed';
  const reported = ChatFailureSchema.safeParse(result.failure);
  const limit = stopReason === 'limit';
  const failure =
    state !== 'failed'
      ? null
      : reported.success
        ? reported.data
        : chatFailure({
            stage: 'finish',
            kind: limit ? 'usage-limit' : 'internal',
            message: limit
              ? 'The provider reported a usage limit.'
              : 'The provider ended the turn without a reason.',
          });
  const session = ChatSessionSchema.safeParse(result.session);
  const reportedText = typeof result.assistantText === 'string' ? result.assistantText : '';
  return {
    state,
    failure,
    stopReason,
    // Adapters may report only finished items on stop. The streamed text is what was shown.
    text: reportedText.trim() ? reportedText : joinText(items),
    session: session.success ? session.data : null,
  };
}

/**
 * The window with the least left says how much a family can still do. A family with no
 * observed percent ranks below every family with one, and an unknown reset ranks last.
 */
function allowance(remaining: ChatCatalogRead['families'][number]['remaining']) {
  const [tightest] = remaining
    .filter((window) => window.percent !== null)
    .sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0) || reset(a.resetsAt) - reset(b.resetsAt));
  return { percent: tightest?.percent ?? -1, resetsAt: reset(tightest?.resetsAt ?? null) };
}

const reset = (at: string | null) => (at ? Date.parse(at) : Number.MAX_SAFE_INTEGER);

function addText(items: Map<string, string>, event: AgentEvent) {
  if (event.type === 'text.delta')
    items.set(event.itemId, (items.get(event.itemId) ?? '') + event.text);
  if (event.type === 'text.completed') items.set(event.itemId, event.text);
}

function joinText(items: ReadonlyMap<string, string>): string {
  return [...items.values()].filter((text) => text.trim()).join('\n\n');
}

function streamedText(events: readonly AgentEvent[]): string {
  const items = new Map<string, string>();
  for (const event of events) addText(items, event);
  return joinText(items);
}

/** Keep provider text inside the entry limits: valid Unicode, no NUL, bounded bytes. */
function fitText(value: string, bytes: number): string {
  const encoder = new TextEncoder();
  const budget = MAX_CHAT_ENTRY_BYTES - 4096;
  let text = value.replaceAll('\0', '�').toWellFormed();
  while (
    encoder.encode(text).length > bytes ||
    encoder.encode(JSON.stringify(text)).length > budget
  )
    text = text.slice(0, Math.floor(text.length * 0.9)).toWellFormed();
  return text;
}

/** Merge neighboring chunks of one item so a reopened view can rebuild a long turn. */
function compact(events: readonly AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const event of events) {
    const last = out.at(-1);
    if (
      last &&
      (event.type === 'text.delta' || event.type === 'thinking.delta') &&
      last.type === event.type &&
      last.itemId === event.itemId &&
      last.text.length + event.text.length <= 65_536
    ) {
      out[out.length - 1] = { ...last, text: last.text + event.text };
      continue;
    }
    if (
      last?.type === 'tool.output' &&
      event.type === 'tool.output' &&
      last.callId === event.callId &&
      !last.truncated &&
      !event.truncated &&
      last.chunk.length + event.chunk.length <= 65_536
    ) {
      out[out.length - 1] = { ...last, chunk: last.chunk + event.chunk };
      continue;
    }
    out.push(event);
  }
  return out;
}

/**
 * The newest items that fit the byte budget, oldest first.
 * shortcut: a turn with more live output than the budget loses its oldest events on reload.
 * Upgrade: page live events by cursor.
 */
function newest<T>(items: readonly T[], budget: number): T[] {
  let bytes = 0;
  let start = items.length;
  while (start > 0) {
    const next = size(items[start - 1]);
    if (bytes + next > budget) break;
    bytes += next;
    start--;
  }
  return items.slice(start);
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
