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
};

export type ThreadAction =
  | { type: 'loaded'; read: ChatThreadRead }
  | { type: 'events'; events: ThreadEvent[] }
  | { type: 'sending'; pending: PendingMessage }
  | { type: 'dismiss'; localId: string }
  | {
      type: 'configured';
      patch: Partial<Pick<ChatThread, 'permissionPolicy' | 'autoHandoff' | 'selection'>>;
    };

export const initialThreadState = (taskId: string): ThreadState => ({
  taskId,
  loaded: false,
  thread: null,
  messages: [],
  turnMeta: {},
  turns: {},
  pending: [],
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

function applyOne(state: ThreadState, event: ThreadEvent): ThreadState {
  if (event.taskId && event.taskId !== state.taskId) return state;
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
        ? { ...state, thread: parsed.data }
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
      let next = addMessages(
        {
          ...state,
          loaded: true,
          thread: read.thread,
          turnMeta: Object.fromEntries(read.turns.map((turn) => [turn.id, turn])),
        },
        read.messages,
        true,
      );
      // The snapshot of an unfinished turn is complete, so it replaces what the stream built.
      const live = new Map<string, Stamped[]>();
      for (const event of read.liveEvents)
        live.set(event.turnId, [...(live.get(event.turnId) ?? []), { cursor: null, event }]);
      const turns = { ...next.turns };
      for (const [turnId, events] of live)
        turns[turnId] = {
          events,
          cursors: new Set(),
          view: { ...foldEvents(events), id: turnId },
        };
      next = { ...next, turns };
      return next;
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

// Where a turn without cursored events belongs: after the last message written before it started.
function startOrder(meta: ChatTurn, messages: readonly ChatMessage[]): bigint {
  const started = Date.parse(meta.startedAt);
  const before = messages.findLast((message) => Date.parse(message.at) <= started);
  return (before ? BigInt(before.cursor) * STEP : 0n) + 1n + BigInt(Math.min(meta.sequence, 400));
}

// The ordered rows of the thread. Persisted messages and turns share one timeline by cursor. A turn
// that was built from the stream sits at its first event. One restored from a read sits by the time
// it started, or at its stored reply.
export function threadItems(state: ThreadState): ThreadItem[] {
  const rows: { order: bigint; item: ThreadItem }[] = [];
  const replies = new Map<string, ChatMessage>();
  const failed = new Set<string>();
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
    const firstCursor = record?.events[0]?.cursor ?? null;
    const order =
      firstCursor !== null
        ? firstCursor * STEP
        : meta
          ? startOrder(meta, state.messages)
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

export function lastFamily(items: readonly ThreadItem[]): ChatFamily | null {
  for (const item of items.toReversed())
    if (item.kind === 'turn' && item.turn.identity) return item.turn.identity.family;
  return null;
}
