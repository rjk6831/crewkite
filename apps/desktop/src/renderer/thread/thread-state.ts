import {
  type AgentEvent,
  AgentEventSchema,
  type ChatAttachment,
  type ChatFailure,
  type ChatFamily,
  type ChatMessage,
  ChatMessageSchema,
  type ChatModelSelection,
  type ChatThread,
  type ChatThreadRead,
  ChatThreadSchema,
  type ChatTurn,
  ChatTurnSchema,
  ConversationEntrySchema,
} from '@crewkite/contracts';
import {
  applyEvent,
  blankTurn,
  isStop,
  replyLabel,
  type TurnIdentity,
  type TurnStatus,
  type TurnView,
} from './turn-fold.ts';

export type { Block, FileDiff, ToolBlock, TurnView } from './turn-fold.ts';

// Folds one thread read and the live event stream into what the thread view renders. Nothing here
// touches React or the transport.
//
// Events arrive as the envelope the controller forwards: a type name, the log cursor and a payload.
//   agent.event          payload: AgentEvent
//   chat.turn            payload: ChatTurn
//   chat.thread          payload: ChatThread
//   conversation.entry   payload: ChatMessage, or a user message in the older entry shape
export type ThreadEvent = { type: string; cursor: string; taskId: string | null; payload: unknown };

type Stamped = { cursor: bigint | null; event: AgentEvent };
/** `settled` marks a finished turn rebuilt from its stored events. The stream adds nothing more. */
type TurnRecord = {
  events: Stamped[];
  cursors: ReadonlySet<string>;
  view: TurnView;
  settled?: boolean;
};
export type PendingMessage = { localId: string; text: string; files: ChatAttachment[]; at: string };

export type ThreadState = {
  taskId: string;
  loaded: boolean;
  thread: ChatThread | null;
  messages: ChatMessage[];
  turnMeta: Record<string, ChatTurn>;
  turns: Record<string, TurnRecord>;
  pending: PendingMessage[];
  /** The log cursor of the latest read. Stream events at or below it are already in the state. */
  readCursor: bigint | null;
  /** Whether older messages may sit behind the oldest one loaded, and whether any were paged in. */
  older: { more: boolean; paged: boolean };
  /** Why a finished turn's stored events could not be read, by turn. */
  historyNotes: Record<string, string>;
};

export type ThreadAction =
  | { type: 'loaded'; read: ChatThreadRead }
  /** A page of older messages, read with the oldest loaded cursor as `beforeCursor`. */
  | { type: 'earlier'; read: ChatThreadRead }
  /** Every stored event of one finished turn, oldest first. `partial` when the paging stopped early. */
  | { type: 'history'; turnId: string; events: AgentEvent[]; partial?: boolean }
  | { type: 'history-note'; turnId: string; note: string }
  | { type: 'events'; events: ThreadEvent[] }
  | { type: 'sending'; pending: PendingMessage }
  | { type: 'dismiss'; localId: string }
  | { type: 'configured'; patch: ThreadSettings };

/** The thread settings the inspector and the composer change through ConfigureChatThread. */
export type ThreadSettings = Partial<
  Pick<ChatThread, 'permissionPolicy' | 'autoHandoff' | 'handoffMode' | 'crew' | 'flightMode'>
> & { selection?: ChatModelSelection };

export const initialThreadState = (taskId: string): ThreadState => ({
  taskId,
  loaded: false,
  thread: null,
  messages: [],
  turnMeta: {},
  turns: {},
  pending: [],
  readCursor: null,
  older: { more: false, paged: false },
  historyNotes: {},
});

/** Messages one thread read asks for. A full page may have older ones behind it. */
export const THREAD_PAGE_SIZE = 200;

const key = (cursor: bigint | null) => cursor ?? -1n;
const parseCursor = (cursor: string) => (/^\d{1,20}$/.test(cursor) ? BigInt(cursor) : null);

function foldEvents(events: Stamped[]): TurnView {
  return events.reduce((view, { event }) => applyEvent(view, event), blankTurn(''));
}

function addAgentEvent(state: ThreadState, event: AgentEvent, cursor: string | null): ThreadState {
  const existing = state.turns[event.turnId];
  if (existing?.settled || (cursor !== null && existing?.cursors.has(cursor))) return state;
  const stamped: Stamped = { cursor: cursor === null ? null : parseCursor(cursor), event };
  const events = existing?.events ?? [];
  const last = events.at(-1);
  const inOrder = !last || key(stamped.cursor) >= key(last.cursor);
  let next: Stamped[];
  let view: TurnView;
  if (inOrder) {
    next = [...events, stamped];
    view = applyEvent(existing?.view ?? blankTurn(event.turnId), event);
  } else {
    // A late event goes where its cursor says, and the turn is replayed from its events.
    next = [...events, stamped].sort((a, b) =>
      key(a.cursor) < key(b.cursor) ? -1 : key(a.cursor) > key(b.cursor) ? 1 : 0,
    );
    view = { ...foldEvents(next), id: event.turnId };
  }
  const cursors =
    cursor === null
      ? (existing?.cursors ?? new Set<string>())
      : new Set([...(existing?.cursors ?? []), cursor]);
  return { ...state, turns: { ...state.turns, [event.turnId]: { events: next, cursors, view } } };
}

function asMessage(payload: unknown): ChatMessage | null {
  const direct = ChatMessageSchema.safeParse(payload);
  if (direct.success) return direct.data;
  const entry = ConversationEntrySchema.safeParse(payload);
  if (!entry.success || !['user-message', 'guidance', 'answer'].includes(entry.data.kind))
    return null;
  const { id, taskId, at, cursor, text } = entry.data;
  // The stored entry names the files, so the chips stay when it replaces the pending message.
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

// A replacing read keeps the messages older than its own oldest one, which came from Load earlier.
function addMessages(state: ThreadState, incoming: ChatMessage[], replace = false): ThreadState {
  const known = new Set(state.messages.map((message) => message.id));
  const floor = incoming.length > 0 ? BigInt(incoming[0].cursor) : null;
  const kept = replace
    ? state.messages.filter((message) => floor !== null && BigInt(message.cursor) < floor)
    : state.messages;
  const merged = new Map(kept.map((message) => [message.id, message]));
  let pending = state.pending;
  for (const message of incoming) {
    merged.set(message.id, message);
    if (message.author.kind !== 'user' || known.has(message.id)) continue;
    const at = pending.findIndex((item) => item.text === message.text);
    if (at !== -1) pending = pending.filter((_, index) => index !== at);
  }
  const messages = [...merged.values()].sort((a, b) => {
    const [left, right] = [BigInt(a.cursor), BigInt(b.cursor)];
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { ...state, messages, pending };
}

// The controller says whether older messages exist. A read from before it did says nothing, and
// then a full page may have more behind it, and so does a turn whose message is not loaded. A page
// with no messages ends the paging.
function olderBehind(
  page: readonly ChatMessage[],
  state: ThreadState,
  more: boolean | undefined,
): boolean {
  if (more !== undefined) return more;
  if (page.length === 0) return false;
  if (page.length >= THREAD_PAGE_SIZE) return true;
  const ids = new Set(state.messages.map((message) => message.id));
  return Object.values(state.turnMeta).some((turn) => !ids.has(turn.userMessageId));
}

// A message the controller queued shows in the queued list until it starts, so its pending bubble
// goes as soon as the thread record names it.
function unqueued(pending: PendingMessage[], thread: ChatThread): PendingMessage[] {
  const waiting = thread.queued.map((message) => message.text);
  return pending.filter((item) => !waiting.includes(item.text));
}

function applyOne(state: ThreadState, event: ThreadEvent): ThreadState {
  if (event.taskId && event.taskId !== state.taskId) return state;
  // A read reflects the log up to its cursor. Messages merge by id, so only the three stream events
  // need the check. Before the first read every event applies; the read then replaces the turn.
  if (state.readCursor !== null && event.type !== 'conversation.entry') {
    const at = parseCursor(event.cursor);
    if (at !== null && at <= state.readCursor) return state;
  }
  switch (event.type) {
    case 'agent.event': {
      const parsed = AgentEventSchema.safeParse(event.payload);
      return parsed.success ? addAgentEvent(state, parsed.data, event.cursor) : state;
    }
    case 'chat.turn': {
      const parsed = ChatTurnSchema.safeParse(event.payload);
      if (!parsed.success || parsed.data.taskId !== state.taskId) return state;
      return { ...state, turnMeta: { ...state.turnMeta, [parsed.data.id]: parsed.data } };
    }
    case 'chat.thread': {
      const parsed = ChatThreadSchema.safeParse(event.payload);
      return parsed.success && parsed.data.taskId === state.taskId
        ? { ...state, thread: parsed.data, pending: unqueued(state.pending, parsed.data) }
        : state;
    }
    case 'conversation.entry': {
      const message = asMessage(event.payload);
      return message && message.taskId === state.taskId ? addMessages(state, [message]) : state;
    }
    default:
      return state;
  }
}

export function reduceThread(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case 'events':
      return action.events.reduce(applyOne, state);
    case 'loaded': {
      const { read } = action;
      if (read.thread.taskId !== state.taskId) return state;
      const next = addMessages(
        {
          ...state,
          loaded: true,
          thread: read.thread,
          pending: unqueued(state.pending, read.thread),
          turnMeta: Object.fromEntries(read.turns.map((turn) => [turn.id, turn])),
          readCursor: parseCursor(read.cursor),
        },
        read.messages,
        true,
      );
      // After Load earlier, the newest page says nothing about what is older than the paged ones.
      const older = state.older.paged
        ? state.older
        : { more: olderBehind(read.messages, next, read.more), paged: false };
      // The snapshot of an unfinished turn is complete up to the read cursor, so it replaces what
      // the stream built. Events the stream delivered past that cursor before the read returned
      // are kept on top; everything at or below it is already in the snapshot.
      const live = new Map<string, Stamped[]>();
      for (const event of read.liveEvents)
        live.set(event.turnId, [...(live.get(event.turnId) ?? []), { cursor: null, event }]);
      const turns = { ...next.turns };
      for (const [turnId, snapshot] of live) {
        const after = (state.turns[turnId]?.events ?? []).filter(
          ({ cursor }) => cursor !== null && next.readCursor !== null && cursor > next.readCursor,
        );
        const events = [...snapshot, ...after];
        turns[turnId] = {
          events,
          cursors: new Set(after.map(({ cursor }) => String(cursor))),
          view: { ...foldEvents(events), id: turnId },
        };
      }
      return { ...next, turns, older };
    }
    case 'earlier': {
      if (action.read.thread.taskId !== state.taskId) return state;
      const next = addMessages(state, action.read.messages);
      return {
        ...next,
        older: { more: olderBehind(action.read.messages, next, action.read.more), paged: true },
      };
    }
    case 'history': {
      const existing = state.turns[action.turnId];
      const events = action.events
        .filter((event) => event.turnId === action.turnId)
        .map((event): Stamped => ({ cursor: null, event }));
      if (existing?.settled || events.length === 0) return state;
      // The stored log holds every event the stream delivered for this turn, so it replaces them.
      // The cursors stay, and the record takes no more stream events.
      const folded = { ...foldEvents(events), id: action.turnId };
      const meta = state.turnMeta[action.turnId];
      const view = folded.ended
        ? folded
        : { ...folded, ended: true, status: meta ? metaStatus(meta.state) : ('done' as const) };
      const record: TurnRecord = {
        events,
        cursors: existing?.cursors ?? new Set<string>(),
        view,
        settled: true,
      };
      const turns = { ...state.turns, [action.turnId]: record };
      if (!action.partial) return { ...state, turns };
      const note = "Part of this turn's history could not load.";
      return { ...state, turns, historyNotes: { ...state.historyNotes, [action.turnId]: note } };
    }
    case 'history-note':
      return {
        ...state,
        historyNotes: { ...state.historyNotes, [action.turnId]: action.note },
      };
    case 'sending':
      return { ...state, pending: [...state.pending, action.pending] };
    case 'dismiss':
      return { ...state, pending: state.pending.filter((item) => item.localId !== action.localId) };
    case 'configured':
      return state.thread ? { ...state, thread: { ...state.thread, ...action.patch } } : state;
  }
}

export type ThreadItem =
  | {
      kind: 'user';
      key: string;
      at: string;
      text: string;
      /** Paths saved by an older version of the thread. */
      attachments: readonly string[];
      files: readonly ChatAttachment[];
      pending: boolean;
    }
  | { kind: 'turn'; key: string; turn: TurnView }
  | { kind: 'failure'; key: string; turnId: string; failure: ChatFailure }
  | { kind: 'system'; key: string; at: string; text: string };

const metaStatus = (state: ChatTurn['state']): TurnStatus =>
  state === 'queued' || state === 'running'
    ? 'running'
    : state === 'waiting-permission'
      ? 'waiting-permission'
      : state;
const STEP = 1000n;
// A failure line sits after its turn and before the next message.
const FAILURE_OFFSET = 500n;
const LAST = 1n << 80n;

// A turn's slot right after a message. The sequence keeps two turns on one message in order.
const after = (cursor: bigint, meta: ChatTurn) =>
  cursor * STEP + 1n + BigInt(Math.min(meta.sequence, 400));

// The cursor of the last message written by the time the turn started.
function startedAfter(meta: ChatTurn, messages: readonly ChatMessage[]): bigint {
  const started = Date.parse(meta.startedAt);
  return BigInt(messages.findLast((message) => Date.parse(message.at) <= started)?.cursor ?? 0);
}

// A turn sits right after the user message that started it. Messages count on the conversation
// and agent events on the event log, two different clocks, so the message decides. A later turn on
// the same message, the rerun after a limit handoff, also follows the lines written before it
// started, such as the handoff notice.
function askedOrder(meta: ChatTurn, asked: ChatMessage, state: ThreadState): bigint {
  const rerun = Object.values(state.turnMeta).some(
    (turn) => turn.userMessageId === meta.userMessageId && turn.sequence < meta.sequence,
  );
  const cursor = BigInt(asked.cursor);
  const started = rerun ? startedAfter(meta, state.messages) : 0n;
  return after(started > cursor ? started : cursor, meta);
}

// The ordered rows of the thread. A turn seen only on the stream keeps its first event cursor
// until its record arrives and names the message. A turn whose message is not loaded sits by the
// time it started, or at its stored reply.
export function threadItems(state: ThreadState): ThreadItem[] {
  const rows: { order: bigint; item: ThreadItem }[] = [];
  const replies = new Map<string, ChatMessage>();
  const failed = new Set<string>();
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  for (const turn of Object.values(state.turnMeta))
    if (turn.failure && !isStop(turn.failure)) failed.add(turn.id);
  for (const record of Object.values(state.turns))
    if (record.view.failure) failed.add(record.view.id);
  for (const message of state.messages) {
    const order = BigInt(message.cursor) * STEP;
    if (message.author.kind === 'user')
      rows.push({
        order,
        item: {
          kind: 'user',
          key: message.id,
          at: message.at,
          text: message.text,
          attachments: message.attachments,
          files: message.files,
          pending: false,
        },
      });
    else if (message.author.kind === 'assistant') replies.set(message.author.turnId, message);
    else if (!message.author.turnId || !failed.has(message.author.turnId))
      rows.push({
        order,
        item: { kind: 'system', key: message.id, at: message.at, text: message.text },
      });
  }
  const ids = new Set([
    ...Object.keys(state.turns),
    ...Object.keys(state.turnMeta),
    ...replies.keys(),
  ]);
  for (const id of ids) {
    const record = state.turns[id];
    const meta = state.turnMeta[id];
    const reply = replies.get(id);
    const base = record?.view ?? blankTurn(id);
    // The effort the client reported on the stored reply beats the one the thread asked for.
    const reported = reply?.author.kind === 'assistant' ? reply.author.effort : undefined;
    const found: TurnIdentity | null =
      base.identity ??
      (meta
        ? { ...meta.selection, effort: reported ?? meta.selection.effort, role: meta.role }
        : reply?.author.kind === 'assistant'
          ? {
              family: reply.author.family,
              model: reply.author.model,
              effort: reported ?? 'default',
              role: reply.author.role,
            }
          : null);
    // The live event names no slice. The stored turn does, once the thread read brings it.
    const identity = found && meta?.slice !== undefined ? { ...found, slice: meta.slice } : found;
    const stopped = isStop(meta?.failure);
    const status: TurnStatus = stopped
      ? 'stopped'
      : record
        ? base.status
        : meta
          ? metaStatus(meta.state)
          : 'done';
    const hasText = base.blocks.some((block) => block.kind === 'text' && block.text !== '');
    const blocks =
      reply && reply.text !== '' && !hasText
        ? [
            ...base.blocks,
            { kind: 'text' as const, id: 'text:reply', text: reply.text, done: true },
          ]
        : base.blocks;
    const failure = base.failure ?? (stopped ? null : (meta?.failure ?? null));
    const ended = record ? base.ended : status !== 'running' && status !== 'waiting-permission';
    // Live events of a finished turn are gone after a reload. The turn row keeps its stats, and
    // their summary count stands in for the rolling summary cards.
    const stats = base.stats ?? meta?.stats ?? null;
    const outputLimit = base.outputLimit ?? meta?.outputLimit ?? null;
    const turn: TurnView = {
      ...base,
      identity,
      status,
      blocks,
      failure,
      ended,
      stats,
      outputLimit,
    };
    const asked = meta && byId.get(meta.userMessageId);
    const firstCursor = record?.events[0]?.cursor ?? null;
    const order =
      meta && asked
        ? askedOrder(meta, asked, state)
        : firstCursor !== null
          ? firstCursor * STEP
          : meta
            ? after(startedAfter(meta, state.messages), meta)
            : reply
              ? BigInt(reply.cursor) * STEP
              : LAST;
    if (blocks.length > 0 || !ended || status === 'stopped')
      rows.push({ order, item: { kind: 'turn', key: `turn:${id}`, turn } });
    if (failure)
      rows.push({
        order: order + FAILURE_OFFSET,
        item: { kind: 'failure', key: `failure:${id}`, turnId: id, failure },
      });
  }
  rows.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  const items = rows.map((row) => row.item);
  for (const item of state.pending)
    items.push({
      kind: 'user',
      key: item.localId,
      at: item.at,
      text: item.text,
      attachments: [],
      files: item.files,
      pending: true,
    });
  return items;
}

export function activeTurnId(state: ThreadState): string | null {
  const candidates = [state.thread?.activeTurnId ?? null, ...Object.keys(state.turns)];
  for (const id of candidates) {
    if (!id) continue;
    const record = state.turns[id];
    if (record) {
      if (!record.view.ended) return id;
    } else if (
      state.turnMeta[id] &&
      ['queued', 'running', 'waiting-permission'].includes(state.turnMeta[id].state)
    )
      return id;
  }
  return null;
}

export function latestContext(items: readonly ThreadItem[]): TurnView['context'] {
  for (const item of items.toReversed())
    if (item.kind === 'turn' && item.turn.context) return item.turn.context;
  return null;
}

// The family that answered last, counted the way the controller counts it: the assistant turn with
// the highest sequence, whatever its state. A turn that hit its limit before any text has no row,
// and it still moved the thread. A reviewer or advisor borrows a model for one turn and leaves the
// thread where it was, so the handoff target and the second look skip those turns. Before any turn
// record arrives, the rows decide.
export function lastFamily(state: ThreadState, items: readonly ThreadItem[]): ChatFamily | null {
  let last: ChatTurn | null = null;
  for (const turn of Object.values(state.turnMeta))
    if (turn.role === 'assistant' && (!last || turn.sequence > last.sequence)) last = turn;
  if (last) return last.selection.family;
  for (const item of items.toReversed())
    if (item.kind === 'turn' && item.turn.identity?.role === 'assistant')
      return item.turn.identity.family;
  return null;
}

/** The `beforeCursor` for Load earlier, or null when no older message is expected. */
export function earlierCursor(state: ThreadState): string | null {
  return state.loaded && state.older.more ? (state.messages[0]?.cursor ?? null) : null;
}

const settledStates: ReadonlySet<ChatTurn['state']> = new Set(['done', 'stopped', 'failed']);

/**
 * Finished turns whose cards are not in the view: the stream never delivered their start, as after
 * a reopen or a relaunch. Each is read once from the stored events when it scrolls into view.
 */
export function historyWanted(state: ThreadState): ReadonlySet<string> {
  const wanted = new Set<string>();
  for (const turn of Object.values(state.turnMeta)) {
    if (!settledStates.has(turn.state) || state.historyNotes[turn.id]) continue;
    const record = state.turns[turn.id];
    if (record?.settled || record?.events.some(({ event }) => event.type === 'turn.started'))
      continue;
    wanted.add(turn.id);
  }
  return wanted;
}

/** The families that already ran the message that started this turn. */
export function triedFamilies(state: ThreadState, turnId: string): ChatFamily[] {
  const asked = state.turnMeta[turnId]?.userMessageId;
  const tried = new Set<ChatFamily>();
  for (const turn of Object.values(state.turnMeta))
    if (turn.id === turnId || (asked && turn.userMessageId === asked))
      tried.add(turn.selection.family);
  const streamed = state.turns[turnId]?.view.identity?.family;
  if (streamed) tried.add(streamed);
  return [...tried];
}

/** The files on the message that started this turn. */
export function turnFiles(state: ThreadState, turnId: string): readonly ChatAttachment[] {
  const asked = state.turnMeta[turnId]?.userMessageId;
  return state.messages.find((message) => message.id === asked)?.files ?? [];
}

/**
 * The newest turn of any role, the only one the controller runs again. A turn known from a read has
 * a sequence. One seen only on the stream is newer than all of them.
 */
export function newestTurnId(state: ThreadState): string | null {
  const streamed = Object.keys(state.turns).filter((id) => !state.turnMeta[id]);
  if (streamed.length > 0) return streamed[streamed.length - 1];
  const turns = Object.values(state.turnMeta);
  return turns.reduce((a, b) => (b.sequence > a.sequence ? b : a), turns[0])?.id ?? null;
}

/**
 * The turn Regenerate offers to write again: the newest turn, when it finished with a reply. A
 * review or a second opinion after a reply is that newest turn, so the older reply gets no offer.
 */
export function lastReply(state: ThreadState, items: readonly ThreadItem[]): string | null {
  const id = newestTurnId(state);
  const item = items.find((entry) => entry.kind === 'turn' && entry.turn.id === id);
  return item?.kind === 'turn' && item.turn.ended && item.turn.status === 'done'
    ? item.turn.id
    : null;
}

export type ReadClock = { now: () => number; wait: (ms: number) => Promise<void> };

/** The first read of a thread retries on this backoff, then every two seconds. */
export const FIRST_READ_BACKOFF = [250, 500, 1000, 2000] as const;
/** A first read that keeps failing offers Try again once this much time has passed. */
export const TRY_AGAIN_AFTER_MS = 10_000;

/**
 * Runs `read` until it succeeds. Each failure waits the next delay, and the last delay repeats.
 * The failure goes to the caller once every delay has run and `giveUpAfter` has passed since the
 * first try, or as soon as `active` says the caller is gone. The controller answers one command at
 * a time, so a read can wait behind slower ones and time out while nothing is wrong.
 */
export async function retryRead<T>(
  read: () => Promise<T>,
  clock: ReadClock,
  options: { delays: readonly number[]; giveUpAfter: number; active?: () => boolean },
): Promise<T> {
  const started = clock.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (failure) {
      const spent = attempt >= options.delays.length;
      if (spent && clock.now() - started >= options.giveUpAfter) throw failure;
      await clock.wait(options.delays[Math.min(attempt, options.delays.length - 1)]);
      if (options.active?.() === false) throw failure;
    }
  }
}

/** The text and files of the newest message the person sent, for Up in an empty composer. */
export function lastUserMessage(
  state: Pick<ThreadState, 'messages'>,
): { text: string; files: readonly ChatAttachment[] } | null {
  const message = state.messages.findLast((item) => item.author.kind === 'user');
  return message ? { text: message.text, files: message.files } : null;
}

/** What the live region watches: turns still running, and the permission requests waiting. */
export type LiveSignals = {
  /** Every turn row in the thread. */
  known: ReadonlySet<string>;
  live: ReadonlySet<string>;
  newest: string | null;
  finished: ReadonlyMap<string, string | null>;
  requests: ReadonlyMap<string, string>;
};

export function liveSignals(items: readonly ThreadItem[]): LiveSignals {
  const known = new Set<string>();
  const live = new Set<string>();
  const finished = new Map<string, string | null>();
  const requests = new Map<string, string>();
  let newest: string | null = null;
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    const { turn } = item;
    known.add(turn.id);
    newest = turn.id;
    if (!turn.ended) live.add(turn.id);
    else if (turn.status === 'done' && turn.blocks.some((block) => block.kind === 'text'))
      finished.set(turn.id, replyLabel(turn.identity));
    if (!turn.ended)
      for (const block of turn.blocks)
        if (block.kind === 'permission' && block.choice === null)
          requests.set(`${turn.id}:${block.requestId}`, block.question);
  }
  return { known, live, newest, finished, requests };
}

/**
 * The lines the polite live region says when the thread moves from `before` to `after`: a reply
 * that finished, and a permission request that is new. The first view of a thread is the baseline
 * and says nothing. A reply counts when this view watched it run, or when it is the newest turn and
 * appeared already done. Older turns that Load earlier brings in say nothing.
 */
export function announcements(before: LiveSignals | null, after: LiveSignals): string[] {
  if (!before) return [];
  const lines: string[] = [];
  for (const [id, role] of after.finished) {
    const watched = before.live.has(id) || (!before.known.has(id) && id === after.newest);
    if (watched && !before.finished.has(id))
      lines.push(`${role ? `${role} reply` : 'Reply'} finished.`);
  }
  for (const [key, question] of after.requests)
    if (!before.requests.has(key))
      lines.push(`Permission requested: ${Array.from(question).slice(0, 120).join('')}`);
  return lines;
}
