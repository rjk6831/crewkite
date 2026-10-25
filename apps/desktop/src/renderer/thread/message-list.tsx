import { ArrowDown } from 'lucide-react';
import {
  Fragment,
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { familyName } from '../components.tsx';
import { AttachmentChips, chipOf, FileChips } from './attach.tsx';
import { FailureLine, PermissionCard, ThinkingCard, ToolCard, ToolRunCard } from './cards.tsx';
import { FamilyMark } from './family-mark.tsx';
import { Markdown } from './markdown.tsx';
import { effortLabels } from './model-picker.tsx';
import type { ThreadItem, TurnView } from './thread-state.ts';
import { viewBlocks } from './turn-fold.ts';
import { TurnStats } from './turn-stats.tsx';

const roleLabels = {
  assistant: null,
  reviewer: 'Reviewer',
  advisor: 'Advisor',
  challenger: 'Challenger',
  fixer: 'Fixer',
} as const;

/**
 * `OpenAI · large-1 · Ultra`, after the family mark. A default effort is left out: the client
 * picked it and the label would say nothing.
 */
export function modelLine(selection: {
  family: string;
  model: string;
  effort?: keyof typeof effortLabels;
}) {
  const effort =
    selection.effort && selection.effort !== 'default'
      ? ` · ${effortLabels[selection.effort]}`
      : '';
  return `${familyName(selection.family)} · ${selection.model}${effort}`;
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
  const role = identity ? roleLabels[identity.role] : null;
  return (
    <article className="th-row th-assistant" aria-busy={!turn.ended} data-turn-id={turn.id}>
      {identity && (
        <header className="th-turn-head">
          <FamilyMark family={identity.family} />
          <span>{modelLine(identity)}</span>
          {role && <span className="th-role">{role}</span>}
        </header>
      )}
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
            return <ToolCard key={block.id} block={block} onOpenChanges={onOpenChanges} />;
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
      <div className="th-bubble">{item.text}</div>
    </div>
  );
}

// The line a model change writes, with both models named from the turns around it. The reason is
// the one the controller wrote.
function handoffLine(item: Extract<ThreadItem, { kind: 'system' }>): string {
  if (!item.handoff) return item.text;
  const { from, to } = item.handoff;
  const reason = item.text.slice(item.text.lastIndexOf('Reason:'));
  return `Continued on ${modelName(to)} from ${modelName(from)}. ${reason}`;
}
const modelName = (turn: { family: string; model: string }) =>
  `${familyName(turn.family)} (${turn.model})`;

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
          <span>{handoffLine(item)}</span>
        </div>
      );
    default:
      return null;
  }
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
} & TurnHandlers) {
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  // Where the view was when Load earlier ran, so the older messages go in above it unseen.
  const anchor = useRef<{ height: number; top: number; first: string | undefined } | null>(null);
  const [away, setAway] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const last = items.at(-1);
  const populated = items.length > 0;
  // Follow the newest output unless the person scrolled up. Sending a message always follows.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const held = anchor.current;
    if (held && items[0]?.key !== held.first) {
      anchor.current = null;
      element.scrollTop = held.top + element.scrollHeight - held.height;
      return;
    }
    if (last?.kind === 'user' && last.pending) stick.current = true;
    if (stick.current) element.scrollTop = element.scrollHeight;
  }, [items, last]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new rows need watching when the items change
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
  }, [items, wantsHistory, onTurnVisible]);
  async function loadEarlier() {
    const element = scroller.current;
    if (!earlier || !element) return;
    anchor.current = { height: element.scrollHeight, top: element.scrollTop, first: items[0]?.key };
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
      const view = scroller.current;
      if (view && stick.current) view.scrollTop = view.scrollHeight;
    });
    watch.observe(element);
    return () => watch.disconnect();
  }, [populated]);
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
            {items.map((item) => (
              // One wrapper for every row, so a control that appears below it keeps the row mounted.
              <Fragment key={item.key}>
                <Row
                  item={item}
                  taskId={taskId}
                  onResolve={onResolve}
                  onOpenChanges={onOpenChanges}
                />
                {actions?.(item)}
              </Fragment>
            ))}
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
