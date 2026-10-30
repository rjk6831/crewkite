import type { ChatSearchGroup, ChatSearchHit, ChatSearchResult } from '@crewkite/contracts';
import { MessagesSquare, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { searchHistory, type ThreadSource } from './thread/commands.ts';
import {
  type HistoryFind,
  MIN_TERM_CHARACTERS,
  queryTerms,
  snippetParts,
} from './thread/history-reveal.ts';
import './rail-search.css';

// A search field in the rail over every thread's messages, tool cards and file paths. Results are
// grouped by thread. Choosing one opens the thread at the matching turn. The field keeps focus and
// the results are reached with the arrow keys, as in the command palette.

const DEBOUNCE_MS = 220;
// Counts the results opened in this window. It lives here and not in the component, so a rail that
// remounts, as it does when the sidebar collapses, never reuses a number the open thread has seen.
let nonce = 0;
const kindLabels: Record<ChatSearchHit['kind'], string> = {
  title: 'Title',
  message: 'Message',
  tool: 'Tool',
  path: 'File',
};

type Row = { id: string; group: ChatSearchGroup; hit: ChatSearchHit };

type Status =
  | { kind: 'idle' }
  | { kind: 'short' }
  | { kind: 'searching' }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; result: ChatSearchResult };

export function RailSearch({
  source,
  onOpen,
}: {
  source: ThreadSource;
  onOpen: (find: HistoryFind) => void;
}) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [active, setActive] = useState(0);
  const generation = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const listId = useId();
  const query = text.trim();

  useEffect(() => {
    const mine = ++generation.current;
    if (query === '') {
      setStatus({ kind: 'idle' });
      return;
    }
    if (queryTerms(query).length === 0) {
      setStatus({ kind: 'short' });
      return;
    }
    setStatus({ kind: 'searching' });
    const timer = setTimeout(() => {
      searchHistory(source, query).then(
        (result) => {
          if (generation.current !== mine) return;
          setStatus({ kind: 'done', result });
          setActive(0);
        },
        (failure: unknown) => {
          if (generation.current !== mine) return;
          setStatus({
            kind: 'failed',
            message: failure instanceof Error ? failure.message : 'Search is unavailable.',
          });
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, source]);

  const result = status.kind === 'done' ? status.result : null;
  const rows = useMemo<Row[]>(
    () =>
      (result?.groups ?? []).flatMap((group, groupIndex) =>
        group.hits.map((hit, hitIndex) => ({
          id: `${listId}-${groupIndex}-${hitIndex}`,
          group,
          hit,
        })),
      ),
    [result, listId],
  );
  const current = rows[Math.min(active, rows.length - 1)];

  useEffect(() => {
    if (current) document.getElementById(current.id)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  function open(row: Row) {
    nonce += 1;
    onOpen({ taskId: row.group.taskId, hit: row.hit, query, nonce });
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      if (text !== '') {
        event.preventDefault();
        setText('');
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((value) => (Math.min(value, rows.length - 1) + step + rows.length) % rows.length);
    } else if (event.key === 'Enter' && current) {
      event.preventDefault();
      open(current);
    }
  }

  const summary = (() => {
    switch (status.kind) {
      case 'short':
        return `Type at least ${MIN_TERM_CHARACTERS} letters of a word.`;
      case 'searching':
        return 'Searching';
      case 'failed':
        return status.message;
      case 'done': {
        if (status.result.groups.length === 0) return 'No matches.';
        const threads = status.result.groups.length;
        const more = status.result.more ? ' More matches exist. Add a word to narrow them.' : '';
        return `${rows.length} ${rows.length === 1 ? 'match' : 'matches'} in ${threads} ${threads === 1 ? 'thread' : 'threads'}.${more}`;
      }
      default:
        return '';
    }
  })();

  return (
    <div className="rs">
      <div className="rs-field">
        <MessagesSquare size={14} aria-hidden="true" />
        <input
          ref={field}
          type="text"
          role="combobox"
          className="rs-input"
          placeholder="Search messages"
          aria-label="Search all messages, tool cards and file paths"
          aria-autocomplete="list"
          aria-expanded={rows.length > 0}
          aria-controls={rows.length > 0 ? listId : undefined}
          aria-activedescendant={current?.id}
          spellCheck={false}
          autoComplete="off"
          value={text}
          maxLength={200}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {text !== '' && (
          <button
            type="button"
            className="icon-button rs-clear"
            aria-label="Clear search"
            onClick={() => {
              setText('');
              field.current?.focus();
            }}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      <p
        className={status.kind === 'failed' ? 'rs-note is-error' : 'rs-note'}
        role="status"
        aria-live="polite"
      >
        {summary}
      </p>
      {rows.length > 0 && (
        <div className="rs-list" id={listId} role="listbox" aria-label="Matches by thread">
          {(result?.groups ?? []).map((group) => {
            const own = rows.filter((row) => row.group === group);
            const heading = `${listId}-${group.taskId}`;
            return (
              // A listbox groups its options with role group. A fieldset is a form control.
              // biome-ignore lint/a11y/useSemanticElements: option groups inside a listbox
              <div key={group.taskId} className="rs-group" role="group" aria-labelledby={heading}>
                <div className="rs-title" id={heading}>
                  {group.title || 'Untitled thread'}
                </div>
                {own.map((row) => (
                  // The field keeps focus. The pointer picks and the arrow keys move.
                  // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the combobox field
                  <div
                    key={row.id}
                    id={row.id}
                    role="option"
                    aria-selected={row === current}
                    tabIndex={-1}
                    className={row === current ? 'rs-hit is-active' : 'rs-hit'}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => open(row)}
                  >
                    <span className="rs-kind">{kindLabels[row.hit.kind]}</span>
                    <span className="rs-snippet">
                      {snippetParts(row.hit).map((part, index) =>
                        part.marked ? (
                          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
                          <mark key={index}>{part.text}</mark>
                        ) : (
                          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
                          <span key={index}>{part.text}</span>
                        ),
                      )}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
