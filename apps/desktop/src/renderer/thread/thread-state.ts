import {
  type AgentEvent,
  AgentEventSchema,
  type ChatFailure,
  type ChatFamily,
  type ChatMessage,
  ChatMessageSchema,
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
type TurnRecord = { events: Stamped[]; cursors: ReadonlySet<string>; view: TurnView };
export type PendingMessage = { localId: string; text: string; attachments: string[]; at: string };

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
};

export type ThreadAction =
  | { type: 'loaded'; read: ChatThreadRead }
  | { type: 'events'; events: ThreadEvent[] }
  | { type: 'sending'; pending: PendingMessage }
  | { type: 'dismiss'; localId: string }
  | {
      type: 'configured';
      patch: Partial<
        Pick<ChatThread, 'permissionPolicy' | 'autoHandoff' | 'handoffMode' | 'selection'>
      >;
    };

export const initialThreadState = (taskId: string): ThreadState => ({
  taskId,
  loaded: false,
  thread: null,
  messages: [],
  turnMeta: {},
  turns: {},
  pending: [],
  readCursor: null,
});

const key = (cursor: bigint | null) => cursor ?? -1n;
const parseCursor = (cursor: string) => (/^\d{1,20}$/.test(cursor) ? BigInt(cursor) : null);

function foldEvents(events: Stamped[]): TurnView {
  return events.reduce((view, { event }) => applyEvent(view, event), blankTurn(''));
}

function addAgentEvent(state: ThreadState, event: AgentEvent, cursor: string | null): ThreadState {
  const existing = state.turns[event.turnId];
  if (cursor !== null && existing?.cursors.has(cursor)) return state;
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
  return { id, taskId, at, cursor, text, author: { kind: 'user' }, attachments: [] };
}

function addMessages(state: ThreadState, incoming: ChatMessage[], replace = false): ThreadState {
  const known = new Set(state.messages.map((message) => message.id));
  const merged = new Map((replace ? [] : state.messages).map((message) => [message.id, message]));
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
      return { ...next, turns };
    }
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
      attachments: readonly string[];
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
    const identity: TurnIdentity | null =
      base.identity ??
      (meta
        ? { ...meta.selection, role: meta.role }
        : reply?.author.kind === 'assistant'
          ? {
              family: reply.author.family,
              model: reply.author.model,
              effort: 'default',
              role: reply.author.role,
            }
          : null);
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
    const turn: TurnView = { ...base, identity, status, blocks, failure, ended };
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
      attachments: item.attachments,
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
