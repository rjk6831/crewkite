import type { ChatThreadActivity, WorkspaceState } from '@crewkite/contracts';
import { Ellipsis } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './components.tsx';
import {
  activityLabel,
  foldActivity,
  type LiveActivity,
  type NoticeMemory,
  noticeTitle,
  type RailEvent,
  removedThread,
  shownActivity,
  threadNotices,
} from './rail-activity.ts';
import type { DesktopSource } from './source.ts';
import { deleteThread } from './thread/commands.ts';
import { TitleField } from './thread/thread-title.tsx';
import './rail.css';

// A permission the thread policy or Balanced answers arrives within milliseconds of its request.
// Holding notices this long lets that answer cancel the notice, and a person waiting on a
// notification does not notice the delay.
const NOTICE_BATCH_MS = 750;
const noticeTypes = new Set(['turn.completed', 'permission.requested', 'permission.resolved']);
const noticeEvent = (event: RailEvent) =>
  event.type === 'chat.thread' ||
  (event.type === 'agent.event' &&
    noticeTypes.has((event.payload as { type?: string } | null)?.type ?? ''));

const windowFocused = () => document.hasFocus() && document.visibilityState === 'visible';

/**
 * Live rail state and thread notices. The dot follows chat.turn events between page reads. A
 * notice goes to main when the window is unfocused or another thread is open, and the badge counts
 * the threads with a notice the person has not opened since.
 */
export function useThreadAttention({
  source,
  header,
  titles,
  openThreadId,
  onOpenThread,
  onRemoved,
}: {
  source: DesktopSource | undefined;
  header: WorkspaceState | null;
  titles: ReadonlyMap<string, string>;
  openThreadId: string | null;
  onOpenThread: (taskId: string) => void;
  /** A thread was deleted, here or elsewhere. The rail drops it. */
  onRemoved: (taskId: string) => void;
}) {
  const [live, setLive] = useState<LiveActivity>(() => new Map());
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(() => new Set());
  const [focused, setFocused] = useState(windowFocused);
  const view = useRef({ focused, openThreadId });
  view.current = { focused, openThreadId };
  const titleRef = useRef(titles);
  titleRef.current = titles;
  const unseenRef = useRef(unseen);
  unseenRef.current = unseen;
  const openRef = useRef(onOpenThread);
  openRef.current = onOpenThread;
  const removedRef = useRef(onRemoved);
  removedRef.current = onRemoved;
  const sentBadge = useRef(0);
  // Events up to the first workspace read happened before this window could show them.
  const memory = useRef<NoticeMemory | null>(null);
  if (!memory.current && header)
    memory.current = { since: BigInt(header.cursor), chains: new Map() };
  const ready = header !== null;

  useEffect(() => {
    const update = () => setFocused(windowFocused());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  useEffect(() => {
    if (!source || !ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const batch: RailEvent[] = [];
    const flush = () => {
      timer = null;
      const events = batch.splice(0);
      if (!memory.current) return;
      const result = threadNotices(events, view.current, memory.current);
      memory.current = result.memory;
      if (!result.notices.length) return;
      const next = new Set(unseenRef.current);
      for (const notice of result.notices) next.add(notice.taskId);
      unseenRef.current = next;
      setUnseen(next);
      sentBadge.current = next.size;
      for (const notice of result.notices)
        void source
          .threadAttention?.({
            badge: next.size,
            notice: {
              taskId: notice.taskId,
              title: noticeTitle(titleRef.current.get(notice.taskId)),
              kind: notice.kind,
            },
          })
          .catch(() => {});
    };
    const stop = source.subscribe((event) => {
      if (event.type === 'chat.turn') setLive((current) => foldActivity(current, event));
      const gone = removedThread(event);
      if (gone) removedRef.current(gone);
      if (!noticeEvent(event)) return;
      batch.push(event);
      timer ??= setTimeout(flush, NOTICE_BATCH_MS);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [source, ready]);

  // Looking at a thread is seeing it.
  useEffect(() => {
    if (!focused || !openThreadId) return;
    setUnseen((current) => {
      if (!current.has(openThreadId)) return current;
      const next = new Set(current);
      next.delete(openThreadId);
      return next;
    });
  }, [focused, openThreadId]);

  useEffect(() => {
    if (unseen.size === sentBadge.current) return;
    sentBadge.current = unseen.size;
    void source?.threadAttention?.({ badge: unseen.size, notice: null }).catch(() => {});
  }, [source, unseen]);

  useEffect(() => source?.onOpenThread?.((taskId) => openRef.current(taskId)), [source]);

  return {
    activity: (taskId: string, summary: ChatThreadActivity, pageCursor: string) =>
      shownActivity(live, taskId, summary, pageCursor),
    unseen,
    forget: (taskId: string) =>
      setUnseen((current) => {
        if (!current.has(taskId)) return current;
        const next = new Set(current);
        next.delete(taskId);
        return next;
      }),
  };
}

/** One thread in the rail: its state dot, its title and a menu with Rename and Delete. */
export function RailThread({
  source,
  taskId,
  title,
  activity,
  unseen,
  current,
  onOpen,
  onDelete,
}: {
  source: DesktopSource;
  taskId: string;
  title: string;
  activity: ChatThreadActivity;
  unseen: boolean;
  current: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    items.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const away = (event: MouseEvent) => {
      if (!items.current?.contains(event.target as Node) && event.target !== trigger.current)
        setMenu(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menu]);
  const close = () => {
    setMenu(false);
    trigger.current?.focus();
  };
  const label = unseen ? `${activityLabel[activity]}, new` : activityLabel[activity];
  return (
    <div className={`rail-thread${current ? ' active' : ''}`}>
      {renaming ? (
        <div className="rail-thread-edit">
          <span className={`status-dot state-${activity}`} aria-hidden="true" />
          <TitleField
            source={source}
            taskId={taskId}
            title={title}
            className="rail-title-field"
            onDone={(said) => {
              setRenaming(false);
              setMessage(said);
              trigger.current?.focus();
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className={`task-link ${current ? 'active' : ''}`}
          aria-current={current ? 'page' : undefined}
          onClick={onOpen}
        >
          <span className={`status-dot state-${activity}`} aria-hidden="true" />
          <span>{title}</span>
          <span className="rail-sr">, {label}</span>
          {unseen && <span className="notification-dot" aria-hidden="true" />}
        </button>
      )}
      <button
        ref={trigger}
        type="button"
        className="icon-button rail-thread-more"
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-controls={menu ? menuId : undefined}
        onClick={() => setMenu(!menu)}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      {menu && (
        <div
          ref={items}
          id={menuId}
          className="rail-menu"
          role="menu"
          aria-label={`Actions for ${title}`}
          onKeyDown={(event) => {
            const options = [
              ...(items.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
            ];
            const index = options.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === 'Escape' || event.key === 'Tab') {
              if (event.key === 'Escape') event.preventDefault();
              close();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              options[(index + step + options.length) % options.length]?.focus();
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setMenu(false);
              setMessage(null);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="rail-menu-danger"
            onClick={() => {
              setMenu(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      )}
      {message && (
        <p className="rail-thread-note" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

/** Asks before a delete and names what goes and what stays. */
export function DeleteThreadDialog({
  source,
  taskId,
  title,
  onDeleted,
  onClose,
}: {
  source: DesktopSource;
  taskId: string;
  title: string;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setMessage(null);
    try {
      await deleteThread(source, taskId);
      onDeleted();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : 'The thread was not deleted.');
      setBusy(false);
    }
  }
  return (
    <Dialog title="Delete thread" onClose={onClose}>
      <div className="rail-delete">
        <p>
          Delete <strong>{title}</strong>?
        </p>
        <p className="muted">
          Its scratch copy and attached files are removed. Branches you accepted from it stay in the
          repository.
        </p>
        {message && (
          <p className="rail-delete-error" role="alert">
            {message}
          </p>
        )}
      </div>
      <div className="dialog-footer">
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button stop"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? 'Deleting' : 'Delete thread'}
        </button>
      </div>
    </Dialog>
  );
}
