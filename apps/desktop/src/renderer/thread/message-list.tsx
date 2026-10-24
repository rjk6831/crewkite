import { ArrowDown } from 'lucide-react';
import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import { AttachmentChips } from './attach.tsx';
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
 * `OpenAI · gpt-6.1-sol · Ultra`, after the family mark. A default effort is left out: the client
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

const TurnRow = memo(function TurnRow({
  turn,
  onResolve,
  onOpenChanges,
}: { turn: TurnView } & TurnHandlers) {
  const identity = turn.identity;
  const role = identity ? roleLabels[identity.role] : null;
  return (
    <article className="th-row th-assistant" aria-busy={!turn.ended}>
      {identity && (
        <header className="th-turn-head">
          <FamilyMark family={identity.family} />
          <span>{modelLine(identity)}</span>
          {role && <span className="th-role">{role}</span>}
        </header>
      )}
      {viewBlocks(turn.blocks, turn.ended).map((block): ReactNode => {
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

function UserRow({ item }: { item: Extract<ThreadItem, { kind: 'user' }> }) {
  return (
    <div className={item.pending ? 'th-row th-user is-pending' : 'th-row th-user'}>
      {item.attachments.length > 0 && <AttachmentChips paths={item.attachments} />}
      <div className="th-bubble">{item.text}</div>
    </div>
  );
}

export function MessageList({
  items,
  empty,
  footer,
  onResolve,
  onOpenChanges,
}: {
  items: readonly ThreadItem[];
  empty: ReactNode;
  /** Sits after the last item and scrolls with the thread. */
  footer?: ReactNode;
} & TurnHandlers) {
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const last = items.at(-1);
  const populated = items.length > 0;
  // Follow the newest output unless the person scrolled up. Sending a message always follows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: every change to the items moves the view
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (last?.kind === 'user' && last.pending) stick.current = true;
    if (stick.current) element.scrollTop = element.scrollHeight;
  }, [items, last]);
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
            {items.map((item) => {
              switch (item.kind) {
                case 'user':
                  return <UserRow key={item.key} item={item} />;
                case 'turn':
                  return (
                    <TurnRow
                      key={item.key}
                      turn={item.turn}
                      onResolve={onResolve}
                      onOpenChanges={onOpenChanges}
                    />
                  );
                case 'failure':
                  return (
                    <div key={item.key} className="th-row">
                      <FailureLine failure={item.failure} />
                    </div>
                  );
                case 'system':
                  return (
                    <div key={item.key} className="th-system" role="status">
                      <span>{item.text}</span>
                    </div>
                  );
                default:
                  return null;
              }
            })}
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
