// The one shape the renderer sends to main for thread notices and the dock badge. The renderer
// sees the thread events and knows which thread is open, so it decides when a notice is due. Main
// checks the shape again on every call, because the renderer is not trusted, and writes the text
// itself from the kind.

export type ThreadNoticeKind = 'reply' | 'failed' | 'permission' | 'crew' | 'crew-stopped';
export type ThreadNotice = { taskId: string; title: string; kind: ThreadNoticeKind };
export type ThreadAttention = { badge: number; notice: ThreadNotice | null };

const KINDS: readonly ThreadNoticeKind[] = [
  'reply',
  'failed',
  'permission',
  'crew',
  'crew-stopped',
];
export const TASK_ID_PATTERN = /^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MAX_BADGE = 9999;
// Same bound as a thread title.
const MAX_TITLE = 200;

export function noticeText(notice: ThreadNotice): string {
  const said = {
    reply: 'reply finished',
    failed: 'reply failed',
    permission: 'waiting for permission',
    crew: 'crew finished',
    'crew-stopped': 'crew stopped',
  }[notice.kind];
  return `${notice.title}: ${said}`;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

export function threadAttention(value: unknown): ThreadAttention | null {
  if (!plain(value) || !exactKeys(value, ['badge', 'notice'])) return null;
  const { badge, notice } = value;
  if (typeof badge !== 'number' || !Number.isInteger(badge) || badge < 0 || badge > MAX_BADGE)
    return null;
  if (notice === null) return { badge, notice: null };
  if (!plain(notice) || !exactKeys(notice, ['taskId', 'title', 'kind'])) return null;
  const { taskId, title, kind } = notice;
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) return null;
  if (
    typeof title !== 'string' ||
    title.length === 0 ||
    title.length > MAX_TITLE ||
    // A notification shows one line. Control characters would break it or hide text.
    [...title].some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  )
    return null;
  if (typeof kind !== 'string' || !KINDS.includes(kind as ThreadNoticeKind)) return null;
  return { badge, notice: { taskId, title, kind: kind as ThreadNoticeKind } };
}
