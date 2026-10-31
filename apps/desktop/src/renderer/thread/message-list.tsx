import { ArrowDown } from 'lucide-react';
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { familyName } from '../components.tsx';
import { AttachmentChips, chipOf, FileChips } from './attach.tsx';
import { FailureLine, PermissionCard, ThinkingCard, ToolCard, ToolRunCard } from './cards.tsx';
import { Markdown } from './markdown.tsx';
import { effortLabel } from './model-picker.tsx';
import { ReplyMenu } from './reply-menu.tsx';
import { markMatches } from './reveal-dom.ts';
import type { ThreadItem, TurnView } from './thread-state.ts';
import { TurnChip } from './turn-chip.tsx';
import { replySource, viewBlocks } from './turn-fold.ts';
import { TurnStats } from './turn-stats.tsx';
import { layoutRows, mountPlan, rowTop, rowWindow } from './virtual-window.ts';

/**
 * `OpenAI · large-1 · Ultra`, after the family mark. A default effort is left out: the client
 * picked it and the label would say nothing.
 */
export function modelLine(
  selection: { family: string; model: string; effort?: string },
  label: (family: string, model: string) => string = (_family, model) => model,
) {
  const effort =
    selection.effort && selection.effort !== 'default' ? ` · ${effortLabel(selection.effort)}` : '';
  return `${familyName(selection.family)} · ${label(selection.family, selection.model)}${effort}`;
}

type TurnHandlers = {
  onResolve: (turn: TurnView, requestId: string, choice: string) => Promise<void>;
  onOpenChanges: (path: string) => void;
};

const quiet = (turn: TurnView) => {
  if (turn.ended || turn.status !== 'running') return false;
  const last = turn.blocks.at(-1);
  return !last || (last.kind === 'tool' ? last.status !== 'running' : 'done' in last && last.done);
};

function TurnTrace({ blocks }: { blocks: TurnView['blocks'] }) {
  const notes = blocks.filter((block) => block.kind === 'notice' && block.trace);
  if (notes.length === 0) return null;
  return (
    <details className="th-trace">
      <summary>Client notes ({notes.length})</summary>
      {notes.map((block) => (
        <p key={block.id}>{block.kind === 'notice' ? block.message : ''}</p>
      ))}
    </details>
  );
}

const TurnRow = memo(function TurnRow({
  turn,
  onResolve,
  onOpenChanges,
}: { turn: TurnView } & TurnHandlers) {
  const identity = turn.identity;
  const source = turn.ended && turn.status === 'done' ? replySource(turn.blocks) : '';
  const copyable = source !== '';
  return (
    <article
      className={`th-row th-assistant${identity?.role === 'ask' ? ' is-side' : ''}`}
      aria-busy={!turn.ended}
      data-turn-id={turn.id}
    >
      <TurnChip turn={turn} />
      {viewBlocks(turn.blocks, turn.ended).map((block): ReactNode => {
        // A client note is not part of the reply. It waits in the trace below.
        if (block.kind === 'notice' && block.trace) return null;
        switch (block.kind) {
          case 'text':
            return (
              <div key={block.id} className={block.done || turn.ended ? '' : 'is-streaming'}>
                <Markdown text={block.text} />
              </div>
            );
          case 'run':
            return <ToolRunCard key={block.id} run={block} onOpenChanges={onOpenChanges} />;
          case 'thinking':
            return <ThinkingCard key={block.id} block={block} ended={turn.ended} />;
          case 'tool':
            return (
              <ToolCard
                key={block.id}
                block={block}
                ended={turn.ended}
                onOpenChanges={onOpenChanges}
              />
            );
          case 'permission':
            return (
              <PermissionCard
                key={block.id}
                block={block}
                ended={turn.ended}
                onResolve={(requestId, choice) => onResolve(turn, requestId, choice)}
              />
            );
          case 'notice':
            return (
              <p key={block.id} className={`th-notice is-${block.level}`}>
                {block.message}
              </p>
            );
          default:
            return null;
        }
      })}
      <TurnTrace blocks={turn.blocks} />
      {turn.status === 'stopped' && <p className="th-stopped">Stopped.</p>}
      <TurnStats turn={turn} />
      {copyable && (
        <div className="th-turn-foot">
          <ReplyMenu source={source} />
        </div>
      )}
      {quiet(turn) && (
        <span className="th-working" role="status" aria-label="Working">
          <i />
          <i />
          <i />
        </span>
      )}
    </article>
  );
});

function UserRow({
  item,
  taskId,
}: {
  item: Extract<ThreadItem, { kind: 'user' }>;
  taskId?: string;
}) {
  return (
    <div className={item.pending ? 'th-row th-user is-pending' : 'th-row th-user'}>
      {item.attachments.length > 0 && <AttachmentChips paths={item.attachments} />}
      <FileChips files={item.files.map(chipOf)} taskId={taskId} />
      {item.text !== '' && <div className="th-bubble">{item.text}</div>}
    </div>
  );
}

function Row({
  item,
  taskId,
  onResolve,
  onOpenChanges,
}: { item: ThreadItem; taskId?: string } & TurnHandlers) {
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} taskId={taskId} />;
    case 'turn':
      return <TurnRow turn={item.turn} onResolve={onResolve} onOpenChanges={onOpenChanges} />;
    case 'failure':
      return (
        <div className="th-row" data-turn-id={item.turnId}>
          <FailureLine failure={item.failure} />
        </div>
      );
    case 'system':
      return (
        <div className="th-system" role="status">
          <span>{item.text}</span>
        </div>
      );
    default:
      return null;
  }
}

/** What marks a card the person opened or one that shows an error. */
const OPEN_CARD = '[aria-expanded="true"], details[open], .th-error[role="alert"]';

/** A permission request nobody has answered yet. Its row stays mounted so the answer is not lost. */
const awaitsAnswer = (item: ThreadItem) =>
  item.kind === 'turn' &&
  !item.turn.ended &&
  item.turn.blocks.some((block) => block.kind === 'permission' && block.choice === null);

/** A search hit to show: the row to scroll to and the words to mark in it. `nonce` makes the same hit show again. */
export type Reveal = { key: string; terms: readonly string[]; nonce: number };

/** The top of the rows block in the scroller's scrolled content. */
function rowsTop(scroller: HTMLElement, rows: HTMLElement) {
  return (
    rows.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );
}

export function MessageList({
  items,
  empty,
  footer,
  actions,
  wantsHistory,
  onTurnVisible,
  earlier,
  taskId,
  reveal,
  onResolve,
  onOpenChanges,
}: {
  items: readonly ThreadItem[];
  empty: ReactNode;
  /** Sits after the last item and scrolls with the thread. */
  footer?: ReactNode;
  /** Controls that follow a row, such as Retry under a failure line. */
  actions?: (item: ThreadItem) => ReactNode;
  /** Finished turns whose cards come from their stored events once they scroll into view. */
  wantsHistory?: ReadonlySet<string>;
  onTurnVisible?: (turnId: string) => void;
  /** Shown at the top while older messages may exist. */
  earlier?: { onLoad: () => Promise<void>; note: string | null } | null;
  /** The thread the rows belong to, so a stored file can open. */
  taskId?: string;
  /** A search hit to scroll to and mark. It waits until the row is among the items. */
  reveal?: Reveal | null;
} & TurnHandlers) {
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  // Where the view was when Load earlier ran, so the older messages go in above it unseen. `from`
  // is where the first row stood in the view.
  const anchor = useRef<{ from: number; first: string | undefined } | null>(null);
  const [away, setAway] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const last = items.at(-1);
  const populated = items.length > 0;

  // A long thread mounts only the rows near the view. A row's height is known once it has been
  // drawn, and the rest use an estimate. See virtual-window.ts.
  const measured = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  const [, setTick] = useState(0);
  const keys = useMemo(() => items.map((item) => item.key), [items]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new measurement changes the layout
  const layout = useMemo(() => layoutRows(keys, measured.current), [keys, version]);
  const layoutNow = useRef(layout);
  layoutNow.current = layout;
  const view = useRef({ top: 0, height: 800 });
  const span = rowWindow(layout, view.current.top, view.current.height);
  // Rows that stay mounted wherever the view is, because unmounting them would lose something the
  // person is using: the row that holds focus, a card they opened or that shows an error, and a
  // permission still waiting for an answer. The first two are read from the page as the view
  // moves, since a card keeps its open state to itself.
  const focused = useRef<string | null>(null);
  const opened = useRef<ReadonlySet<string>>(new Set());
  const keyIndex = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);
  const waiting = useMemo(
    () => items.flatMap((item, index) => (awaitsAnswer(item) ? [index] : [])),
    [items],
  );
  const pinsNow = () => {
    const pins = new Set(waiting);
    for (const key of [focused.current, ...opened.current]) {
      const index = key === null ? undefined : keyIndex.get(key);
      if (index !== undefined) pins.add(index);
    }
    return [...pins].sort((a, b) => a - b);
  };
  const pins = pinsNow();
  const plan = mountPlan(layout, span, pins);
  const pinsRef = useRef(pinsNow);
  pinsRef.current = pinsNow;
  const shown = useRef('');
  shown.current = `${span.start}:${span.end}:${pins.join(',')}`;
  // Reads the scroll position. A render follows only when the mounted rows would change.
  const syncView = useCallback(() => {
    const element = scroller.current;
    const block = rows.current;
    if (!element || !block) return;
    view.current = {
      top: element.scrollTop - rowsTop(element, block),
      height: element.clientHeight,
    };
    const found = new Set<string>();
    for (const slot of block.querySelectorAll<HTMLElement>('[data-slot]'))
      if (slot.dataset.slot && slot.querySelector(OPEN_CARD)) found.add(slot.dataset.slot);
    opened.current = found;
    const next = rowWindow(layoutNow.current, view.current.top, view.current.height);
    if (`${next.start}:${next.end}:${pinsRef.current().join(',')}` !== shown.current)
      setTick((tick) => tick + 1);
  }, []);
  // The row that holds focus stays mounted. Focus that moves to another row is set by that row's
  // own focusin, which follows the focusout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the rows block exists once the thread has rows
  useEffect(() => {
    const block = rows.current;
    if (!block) return;
    const into = (event: FocusEvent) => {
      focused.current =
        (event.target as HTMLElement).closest<HTMLElement>('[data-slot]')?.dataset.slot ?? null;
    };
    const out = (event: FocusEvent) => {
      if (!block.contains(event.relatedTarget as Node | null)) focused.current = null;
    };
    block.addEventListener('focusin', into);
    block.addEventListener('focusout', out);
    return () => {
      block.removeEventListener('focusin', into);
      block.removeEventListener('focusout', out);
    };
  }, [populated]);
  const observer = useRef<ResizeObserver | null>(null);
  const watched = useRef(new Set<Element>());
  useLayoutEffect(() => {
    const watch = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const key = element.dataset.slot;
        const height = element.offsetHeight;
        // A hidden pane reports no height, which says nothing about the row.
        if (!key || height === 0 || measured.current.get(key) === height) continue;
        measured.current.set(key, height);
        changed = true;
      }
      if (changed) setVersion((current) => current + 1);
    });
    observer.current = watch;
    const known = watched.current;
    return () => {
      watch.disconnect();
      known.clear();
    };
  }, []);
  // Watch the rows now mounted, and let go of the ones that left.
  useLayoutEffect(() => {
    const watch = observer.current;
    const block = rows.current;
    if (!watch || !block) return;
    for (const element of watched.current)
      if (!element.isConnected) {
        watch.unobserve(element);
        watched.current.delete(element);
      }
    for (const element of block.querySelectorAll('[data-slot]'))
      if (!watched.current.has(element)) {
        watch.observe(element);
        watched.current.add(element);
      }
  });

  // Follow the newest output unless the person scrolled up. Sending a message always follows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout is read when the items change
  useLayoutEffect(() => {
    const element = scroller.current;
    const block = rows.current;
    if (!element || !block) return;
    const held = anchor.current;
    if (held && items[0]?.key !== held.first) {
      anchor.current = null;
      const index = keys.indexOf(held.first ?? '');
      if (index >= 0) {
        element.scrollTop = rowsTop(element, block) + rowTop(layout, index) - held.from;
        syncView();
        return;
      }
    }
    if (last?.kind === 'user' && last.pending) stick.current = true;
    if (stick.current) element.scrollTop = element.scrollHeight;
    syncView();
  }, [items, last]);
  // A search hit: put its row at the top, once the thread has it, and mark it.
  const [hit, setHit] = useState<string | null>(null);
  const revealed = useRef(-1);
  const aligned = useRef(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout is read when the reveal runs
  useLayoutEffect(() => {
    if (!reveal) {
      setHit(null);
      return;
    }
    if (revealed.current === reveal.nonce) return;
    const index = keys.indexOf(reveal.key);
    const element = scroller.current;
    const block = rows.current;
    if (index < 0 || !element || !block) return;
    revealed.current = reveal.nonce;
    stick.current = false;
    element.scrollTop = Math.max(0, rowsTop(element, block) + rowTop(layout, index) - 16);
    setHit(reveal.key);
    syncView();
  }, [reveal, keys]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: marks are drawn again when the mounted rows change
  useEffect(() => {
    if (!reveal || !hit || hit !== reveal.key) return;
    const row = [...(rows.current?.children ?? [])].find(
      (child) => (child as HTMLElement).dataset.slot === hit,
    ) as HTMLElement | undefined;
    if (!row) return;
    // The rows above settle as they are drawn, so the row is brought to the top once it exists.
    if (aligned.current !== reveal.nonce) {
      aligned.current = reveal.nonce;
      row.scrollIntoView({ block: 'start' });
    }
    return markMatches(row, reveal.terms);
  }, [hit, reveal, span.start, span.end, version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new rows need watching when the mounted rows change
  useEffect(() => {
    const root = scroller.current;
    if (!root || !onTurnVisible || !wantsHistory?.size) return;
    const watch = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.isIntersecting ? (entry.target as HTMLElement).dataset.turnId : null;
          if (id) onTurnVisible(id);
        }
      },
      { root, rootMargin: '200px 0px' },
    );
    for (const element of root.querySelectorAll<HTMLElement>('[data-turn-id]'))
      if (wantsHistory.has(element.dataset.turnId ?? '')) watch.observe(element);
    return () => watch.disconnect();
  }, [items, wantsHistory, onTurnVisible, span.start, span.end]);
  async function loadEarlier() {
    const element = scroller.current;
    const first = items[0]?.key;
    const slot = [...(rows.current?.children ?? [])].find(
      (child) => (child as HTMLElement).dataset.slot === first,
    );
    if (!earlier || !element || !slot) return;
    anchor.current = {
      from: slot.getBoundingClientRect().top - element.getBoundingClientRect().top,
      first,
    };
    setLoadingEarlier(true);
    try {
      await earlier.onLoad();
    } finally {
      setLoadingEarlier(false);
      // A page that brought nothing leaves the anchor unused.
      requestAnimationFrame(() => {
        anchor.current = null;
      });
    }
  }
  // The footer fills in after its own read, and a card opens or closes without a new item. Both
  // change the height with no render here, so the column is watched for the follow.
  useEffect(() => {
    const element = column.current;
    if (!element || !populated) return;
    const watch = new ResizeObserver(() => {
      const scrolled = scroller.current;
      if (scrolled && stick.current) {
        scrolled.scrollTop = scrolled.scrollHeight;
        syncView();
      }
    });
    watch.observe(element);
    return () => watch.disconnect();
  }, [populated, syncView]);
  // Content can grow between a pinned scroll and its queued scroll event, so the view looks far
  // from the end without the person moving. Only a move up releases the follow. A return to the
  // end restores it.
  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (near) stick.current = true;
    else if (element.scrollTop < lastTop.current) stick.current = false;
    lastTop.current = element.scrollTop;
    setAway(!stick.current);
    syncView();
  }
  return (
    <div className="th-scroll-frame">
      {populated ? (
        <div className="th-scroll" ref={scroller} onScroll={onScroll}>
          <div className="th-column" ref={column}>
            {earlier && (
              <div className="th-earlier">
                <button
                  type="button"
                  className="th-pill th-outline"
                  disabled={loadingEarlier}
                  onClick={() => void loadEarlier()}
                >
                  Load earlier
                </button>
                {earlier.note && <p className="th-muted">{earlier.note}</p>}
              </div>
            )}
            <div className="th-rows" ref={rows}>
              {plan.map((entry, at) => {
                if (entry.kind === 'pad')
                  return (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: padding blocks have no identity
                      key={`pad-${at}`}
                      className="th-pad"
                      style={{ height: entry.height }}
                      aria-hidden="true"
                    />
                  );
                const item = items[entry.index];
                return (
                  // One wrapper for every row, so a control that appears below it keeps the row
                  // mounted, and the row and its controls are measured as one.
                  <div
                    key={item.key}
                    className={item.key === hit ? 'th-slot is-hit' : 'th-slot'}
                    data-slot={item.key}
                  >
                    <Row
                      item={item}
                      taskId={taskId}
                      onResolve={onResolve}
                      onOpenChanges={onOpenChanges}
                    />
                    {actions?.(item)}
                  </div>
                );
              })}
            </div>
            {footer}
          </div>
        </div>
      ) : (
        <div className="th-blank">{empty}</div>
      )}
      {away && (
        <button
          type="button"
          className="th-jump"
          onClick={() => {
            stick.current = true;
            const element = scroller.current;
            if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
          }}
        >
          <ArrowDown size={13} aria-hidden="true" />
          Jump to latest
        </button>
      )}
    </div>
  );
}
