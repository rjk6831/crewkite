import type {
  ChatCatalogRead,
  ChatFamily,
  ChatModelSelection,
  ChatThread,
} from '@crewkite/contracts';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ContextGauge } from '../context-gauge.tsx';
import { preferredSelection } from '../settings/preferences.ts';
import { configureThread, readCatalog, type ThreadSource } from './commands.ts';
import { defaultSelection, ModelPicker } from './model-picker.tsx';

export type SendInput = {
  text: string;
  attachments: string[];
  selection: ChatModelSelection | null;
};

// Unsent text survives switching threads for as long as the window stays open.
const drafts = new Map<string, string>();

export function Composer({
  source,
  taskId,
  thread,
  running,
  context,
  currentFamily,
  blocked,
  notice,
  onSend,
  onStop,
  onConfigured,
  onHandoff,
}: {
  source: ThreadSource;
  taskId: string | null;
  thread: ChatThread | null;
  running: boolean;
  context: { used: number; capacity: number | null } | null;
  currentFamily: ChatFamily | null;
  blocked: string | null;
  notice: string | null;
  onSend: (input: SendInput) => Promise<void>;
  onStop: () => Promise<void>;
  onConfigured: (selection: ChatModelSelection) => void;
  onHandoff: (selection: ChatModelSelection) => Promise<void>;
}) {
  const draftKey = taskId ?? 'new';
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ChatCatalogRead | null>(null);
  const [selection, setSelection] = useState<ChatModelSelection | null>(thread?.selection ?? null);
  const [note, setNote] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const loadCatalog = useCallback(() => {
    readCatalog(source, taskId ?? undefined)
      .then((next) => {
        setCatalog(next);
        setNote(null);
      })
      .catch((failure: unknown) =>
        setNote(failure instanceof Error ? failure.message : 'The model list could not be loaded.'),
      );
  }, [source, taskId]);
  useEffect(loadCatalog, [loadCatalog]);
  useEffect(() => {
    if (thread?.selection) setSelection(thread.selection);
  }, [thread?.selection]);
  const chosen = selection ?? preferredSelection(catalog) ?? defaultSelection(catalog);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the box resizes when its text changes
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  function select(next: ChatModelSelection) {
    setSelection(next);
    if (!taskId) return;
    configureThread(source, { taskId, selection: next }).then(
      () => onConfigured(next),
      (failure: unknown) =>
        setNote(failure instanceof Error ? failure.message : 'The choice was not saved.'),
    );
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const body = text.trim();
    if (!body || running || blocked) return;
    const sent = { text: body, attachments };
    setText('');
    setAttachments([]);
    drafts.delete(draftKey);
    try {
      await onSend({ ...sent, selection: chosen });
      setNote(null);
    } catch (failure) {
      // Nothing is lost when a send fails. The text and paths come back into the box.
      setText((current) => current || sent.text);
      setAttachments((current) => (current.length > 0 ? current : sent.attachments));
      setNote(failure instanceof Error ? failure.message : 'The message was not sent.');
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }
  function addPath() {
    const path = adding?.trim();
    if (path && !attachments.includes(path) && attachments.length < 32)
      setAttachments([...attachments, path]);
    setAdding(null);
  }

  return (
    <div className="th-composer-wrap">
      <form className="th-composer" onSubmit={(event) => void submit(event)}>
        {attachments.length > 0 && (
          <ul className="th-chips" aria-label="Attachments">
            {attachments.map((path) => (
              <li key={path} title={path}>
                <Paperclip size={12} aria-hidden="true" />
                {path.split(/[\\/]/).filter(Boolean).at(-1) ?? path}
                <button
                  type="button"
                  aria-label={`Remove ${path}`}
                  onClick={() => setAttachments(attachments.filter((value) => value !== path))}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {adding !== null && (
          <div className="th-attach-row">
            <input
              // biome-ignore lint/a11y/noAutofocus: the field opens on the person's own click
              autoFocus
              value={adding}
              placeholder="Path to a file or folder"
              aria-label="Path to attach"
              onChange={(event) => setAdding(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addPath();
                } else if (event.key === 'Escape') setAdding(null);
              }}
            />
            <button type="button" onClick={addPath}>
              Add
            </button>
          </div>
        )}
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder="Ask about this project or describe a change"
          aria-label="Message"
          onChange={(event) => {
            setText(event.target.value);
            drafts.set(draftKey, event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="th-composer-bar">
          <button
            type="button"
            className="th-icon"
            aria-label="Attach a path"
            title="Attach a path"
            onClick={() => setAdding(adding === null ? '' : null)}
          >
            <Paperclip size={16} aria-hidden="true" />
          </button>
          <ModelPicker
            catalog={catalog}
            selection={chosen}
            currentFamily={currentFamily}
            running={running}
            nowMs={Date.now()}
            onOpen={loadCatalog}
            onSelect={select}
            onHandoff={(next) =>
              onHandoff(next).catch((failure: unknown) =>
                setNote(failure instanceof Error ? failure.message : 'The thread was not moved.'),
              )
            }
          />
          <span className="th-spacer" />
          {context?.capacity && (
            <ContextGauge
              usedTokens={context.used}
              capacityTokens={context.capacity}
              measurement="current"
              updating={running}
              size={22}
            />
          )}
          {running ? (
            <button
              type="button"
              className="th-send is-stop"
              aria-label="Stop"
              title="Stop"
              onClick={() =>
                onStop().catch((failure: unknown) =>
                  setNote(
                    failure instanceof Error ? failure.message : 'The turn could not be stopped.',
                  ),
                )
              }
            >
              <Square size={13} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              className="th-send"
              aria-label="Send"
              title={blocked ?? 'Send'}
              disabled={!text.trim() || !!blocked}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
      {(blocked ?? notice ?? note) && (
        <p className="th-note" role="status">
          {blocked ?? notice ?? note}
        </p>
      )}
    </div>
  );
}
