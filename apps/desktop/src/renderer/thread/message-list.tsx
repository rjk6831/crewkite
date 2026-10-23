import { ArrowDown } from 'lucide-react';
import { memo, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import { AttachmentChips } from './attach.tsx';
import { FailureLine, PermissionCard, ThinkingCard, ToolCard } from './cards.tsx';
import { Markdown } from './markdown.tsx';
import type { ThreadItem, TurnView } from './thread-state.ts';

const roleLabels = { assistant: null, reviewer: 'Reviewer', advisor: 'Advisor' } as const;

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
          <span className={`th-dot family-${identity.family}`} aria-hidden="true" />
          <span>
            {familyName(identity.family)} · {identity.model}
          </span>
          {role && <span className="th-role">{role}</span>}
        </header>
      )}
      {turn.blocks.map((block): ReactNode => {
        switch (block.kind) {
          case 'text':
            return block.text === '' ? null : (
              <div key={block.id} className={block.done || turn.ended ? '' : 'is-streaming'}>
                <Markdown text={block.text} />
              </div>
            );
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
  onResolve,
  onOpenChanges,
}: {
  items: readonly ThreadItem[];
  empty: ReactNode;
} & TurnHandlers) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const last = items.at(-1);
  // Follow the newest output unless the person scrolled up. Sending a message always follows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: every change to the items moves the view
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (last?.kind === 'user' && last.pending) stick.current = true;
    if (stick.current) element.scrollTop = element.scrollHeight;
  }, [items, last]);
  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    stick.current = near;
    setAway(!near);
  }
  return (
    <div className="th-scroll-frame">
      <div className="th-scroll" ref={scroller} onScroll={onScroll}>
        <div className="th-column">
          {items.length === 0
            ? empty
            : items.map((item) => {
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
        </div>
      </div>
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
