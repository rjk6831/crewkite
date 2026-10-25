import type { ChatThreadActivity, ChatTurnState } from '@crewkite/contracts';
import type { ThreadNoticeKind } from '../shared/thread-notice.ts';

// The rail dot and the thread notices, folded from the controller events every window receives.
// Both are pure so the rules can be read and tested without a window.

export type RailEvent = { type: string; cursor: string; taskId: string | null; payload: unknown };

/**
 * The same rule the controller applies to the newest turn when it builds a summary. The other copy
 * is chatActivity in apps/controller/src/store/workspace.ts; change both together.
 */
export function turnActivity(state: ChatTurnState): ChatThreadActivity {
  if (state === 'queued' || state === 'running') return 'running';
  if (state === 'waiting-permission') return 'waiting';
  return state === 'failed' ? 'failed' : 'idle';
}

export const activityLabel: Record<ChatThreadActivity, string> = {
  idle: 'Idle',
  running: 'Running',
  waiting: 'Waiting for permission',
  failed: 'Last reply failed',
};

type Live = { sequence: number; cursor: bigint; activity: ChatThreadActivity };
export type LiveActivity = ReadonlyMap<string, Live>;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * A chat.turn event moves the dot without another page read. An update to an older turn, such as
 * a process check settling, never overrides a newer one.
 */
export function foldActivity(live: LiveActivity, event: RailEvent): LiveActivity {
  if (event.type !== 'chat.turn') return live;
  const turn = record(event.payload);
  if (!turn || typeof turn.taskId !== 'string' || typeof turn.sequence !== 'number') return live;
  const state = turn.state as ChatTurnState;
  const known = live.get(turn.taskId);
  if (known && known.sequence > turn.sequence) return live;
  const next = new Map(live);
  next.set(turn.taskId, {
    sequence: turn.sequence,
    cursor: BigInt(event.cursor),
    activity: turnActivity(state),
  });
  return next;
}

/** The page read wins when it is newer than the last turn event for the thread. */
export function shownActivity(
  live: LiveActivity,
  taskId: string,
  summary: ChatThreadActivity,
  pageCursor: string,
): ChatThreadActivity {
  const known = live.get(taskId);
  return known && known.cursor > BigInt(pageCursor) ? known.activity : summary;
}

export type NoticeView = { focused: boolean; openThreadId: string | null };
export type NoticeMemory = {
  /** Events at or before this cursor were already folded, or predate the window. */
  since: bigint;
  /** The last crew chain step seen per thread. */
  chains: ReadonlyMap<string, string | null>;
};
export type PendingNotice = { taskId: string; kind: ThreadNoticeKind };

const RUNNING_STEPS = new Set(['review', 'fix', 'challenge']);

/**
 * The notices one batch of events produces. A turn that is a step of a running crew chain gives
 * no reply or failed notice; the chain gives one when it ends. A permission request answered within the
 * same batch, as Balanced and the thread policy do, gives none. Nothing is posted for the thread
 * the person is looking at.
 */
export function threadNotices(
  events: readonly RailEvent[],
  view: NoticeView,
  memory: NoticeMemory,
): { notices: PendingNotice[]; memory: NoticeMemory } {
  let since = memory.since;
  const chains = new Map(memory.chains);
  const found: PendingNotice[] = [];
  const answered = new Set<string>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === 'agent.event' && payload?.type === 'permission.resolved')
      answered.add(`${payload.turnId}:${payload.requestId}`);
  }
  for (const event of events) {
    const cursor = BigInt(event.cursor);
    if (cursor <= since || !event.taskId) continue;
    since = cursor;
    const taskId = event.taskId;
    const payload = record(event.payload);
    if (!payload) continue;
    if (event.type === 'chat.thread') {
      const step = (record(payload.crewChain)?.step as string | undefined) ?? null;
      const before = chains.get(taskId) ?? null;
      chains.set(taskId, step);
      if (before && RUNNING_STEPS.has(before)) {
        if (step === 'finished') found.push({ taskId, kind: 'crew' });
        if (step === 'stopped') found.push({ taskId, kind: 'crew-stopped' });
      }
    } else if (event.type === 'agent.event') {
      // A stop is the person's own doing. An error or a usage limit turns the dot to Failed, and
      // the notice says so.
      const ended = payload.type === 'turn.completed' ? payload.stopReason : null;
      if (ended === 'done' || ended === 'error' || ended === 'limit') {
        const step = chains.get(taskId) ?? null;
        if (!step || !RUNNING_STEPS.has(step))
          found.push({ taskId, kind: ended === 'done' ? 'reply' : 'failed' });
      }
      if (
        payload.type === 'permission.requested' &&
        !answered.has(`${payload.turnId}:${payload.requestId}`)
      )
        found.push({ taskId, kind: 'permission' });
    }
  }
  const looking = (taskId: string) => view.focused && view.openThreadId === taskId;
  const notices = found.filter(
    (notice, index) =>
      !looking(notice.taskId) &&
      found.findIndex((other) => other.taskId === notice.taskId && other.kind === notice.kind) ===
        index,
  );
  return { notices, memory: { since, chains } };
}

/** A notification shows one line, so the title loses control characters and stays short. */
export function noticeTitle(title: string | undefined): string {
  const line = (title ?? '').replace(/\p{Cc}+/gu, ' ').trim();
  return Array.from(line || 'Thread')
    .slice(0, 100)
    .join('');
}
