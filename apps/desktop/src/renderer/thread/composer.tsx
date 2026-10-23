import type {
  ChatCatalogRead,
  ChatFamily,
  ChatModelSelection,
  ChatThread,
} from '@crewkite/contracts';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { ContextGauge } from '../context-gauge.tsx';
import { preferredSelection } from '../settings/preferences.ts';
import { AttachmentChips, AttachRow } from './attach.tsx';
import { configureThread, readCatalog, type ThreadSource } from './commands.ts';
import { defaultSelection, ModelPicker } from './model-picker.tsx';
import { type RoleAction, roleActions, useRoleRun } from './role-row.tsx';

export type SendInput = {
  text: string;
  attachments: string[];
  selection: ChatModelSelection | null;
};

/** What the empty thread view can ask of the composer. */
export type ComposerHandle = { fill: (text: string) => void };

// Unsent text survives switching threads for as long as the window stays open.
const drafts = new Map<string, string>();

export function Composer({
  ref,
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
  ref?: Ref<ComposerHandle>;
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
  useImperativeHandle(ref, () => ({
    fill(value) {
      setText(value);
      drafts.set(draftKey, value);
      const element = field.current;
      element?.focus();
      // The caret goes to the end so the person can keep typing.
      requestAnimationFrame(() => element?.setSelectionRange(value.length, value.length));
    },
  }));

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
  const roles = useRoleRun({
    source,
    taskId,
    thread,
    catalog,
    currentFamily,
    running,
    blocked,
    onOpenCatalog: loadCatalog,
    onNote: setNote,
  });

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
          <AttachmentChips
            paths={attachments}
            onRemove={(path) => setAttachments(attachments.filter((value) => value !== path))}
          />
        )}
        {adding !== null && (
          <AttachRow
            value={adding}
            onChange={setAdding}
            onAdd={addPath}
            onClose={() => setAdding(null)}
          />
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
        {roles.row}
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
          {taskId &&
            (Object.keys(roleActions) as RoleAction[]).map((action) => {
              const why = roles.why(action);
              return (
                <button
                  key={action}
                  type="button"
                  className="th-pill"
                  aria-expanded={roles.role === action}
                  aria-controls={roles.role === action ? 'th-role-row' : undefined}
                  disabled={why !== null}
                  title={why ?? undefined}
                  onClick={() => roles.toggle(action)}
                >
                  {roleActions[action].label}
                </button>
              );
            })}
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
