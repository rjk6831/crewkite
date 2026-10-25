import type { DesktopAttachInput, DesktopFile } from '@crewkite/client';
import type {
  ChatAttachment,
  ChatCatalogRead,
  ChatFamily,
  ChatModelSelection,
  ChatThread,
  LocalSetup,
  WorkspaceState,
} from '@crewkite/contracts';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { familyName } from '../components.tsx';
import { ContextGauge } from '../context-gauge.tsx';
import { lastSeen, observeOpenConnection } from '../local-setup-flow.ts';
import { flightModes, preferredSelection } from '../settings/preferences.ts';
import { type ChipFile, chipOf, FileChips, keepThumbnail } from './attach.tsx';
import { configureThread, importAttachment, readCatalog, type ThreadSource } from './commands.ts';
import { deliveryNote, deliveryOf } from './file-fit.ts';
import { defaultSelection, ModelPicker } from './model-picker.tsx';
import { type RoleAction, roleActions, useRoleRun } from './role-row.tsx';

/**
 * A file in the composer. In a saved thread the controller stores it as soon as it is added, so
 * `file` is set. A new thread has no task yet, and its files wait as paths until the first send.
 */
export type ComposerFile = ChipFile & { path: string | null; file: ChatAttachment | null };

export type SendInput = {
  text: string;
  files: ComposerFile[];
  selection: ChatModelSelection | null;
};

/** What the thread view can ask of the composer. */
export type ComposerHandle = {
  focus: () => void;
  fill: (text: string) => void;
  /** Put text and files back, as after a stop clears the queue, unless the box already holds some. */
  restore: (text: string, files?: readonly ChatAttachment[]) => void;
};

const MAX_FILES = 32;
const stored = (file: ChatAttachment): ComposerFile => ({ ...chipOf(file), path: null, file });
const local = (found: DesktopFile, busy: boolean): ComposerFile => ({
  key: `path:${found.path}`,
  name: found.name,
  bytes: found.bytes,
  mimeType: null,
  thumbnail: found.thumbnail,
  busy,
  path: found.path,
  file: null,
});
const failureText = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message : fallback;

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
  onOpenCrew,
  onCatalog,
  localState,
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
  /** Opens the inspector on the Crew tab. A new thread has no crew yet and leaves it out. */
  onOpenCrew?: () => void;
  /** Each catalog the composer reads, so the thread can offer the same families. */
  onCatalog?: (catalog: ChatCatalogRead) => void;
  /** The saved Local setup, and a workspace read to get its current revision. */
  localState?: { setup: LocalSetup | null | undefined; refresh: () => Promise<WorkspaceState> };
}) {
  const draftKey = taskId ?? 'new';
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [files, setFiles] = useState<ComposerFile[]>([]);
  const [dropping, setDropping] = useState(false);
  const [catalog, setCatalog] = useState<ChatCatalogRead | null>(null);
  const [selection, setSelection] = useState<ChatModelSelection | null>(thread?.selection ?? null);
  const [note, setNote] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => {
    const fill = (value: string) => {
      setText(value);
      drafts.set(draftKey, value);
      const element = field.current;
      element?.focus();
      // The caret goes to the end so the person can keep typing.
      requestAnimationFrame(() => element?.setSelectionRange(value.length, value.length));
    };
    return {
      focus: () => field.current?.focus(),
      fill,
      restore: (value, back = []) => {
        if (!text.trim()) fill(value);
        if (files.length === 0 && back.length > 0) setFiles(back.map(stored));
      },
    };
  });

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
    if (catalog) onCatalog?.(catalog);
  }, [catalog, onCatalog]);
  // A model read that ends sends chat.catalog, so the picker shows what it found.
  useEffect(
    () =>
      source.subscribe((event) => {
        if (event.type === 'chat.catalog') loadCatalog();
      }),
    [source, loadCatalog],
  );
  useEffect(() => {
    if (thread?.selection) setSelection(thread.selection);
  }, [thread?.selection]);
  const chosen = selection ?? preferredSelection(catalog) ?? defaultSelection(catalog);
  const flight = flightModes.find(({ id }) => id === thread?.flightMode) ?? flightModes[0];
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
  const refreshLocal = localState?.refresh;
  const observeLocal = useCallback(() => {
    if (!refreshLocal) return;
    observeOpenConnection(async () => (await refreshLocal()).localSetup, source.command).then(
      (read) => read && loadCatalog(),
      () => {},
    );
  }, [refreshLocal, source.command, loadCatalog]);
  const seen =
    localState?.setup && !localState.setup.connected
      ? lastSeen(localState.setup.observedAt, Date.now())
      : null;
  const adding = files.some((file) => file.busy);
  const canAttach = !!source.attachFiles && !blocked;
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    // A message sent while a turn runs waits in the thread and starts when the turn ends.
    const body = text.trim();
    if (!body || blocked || adding) return;
    const sent = { text: body, files };
    setText('');
    setFiles([]);
    drafts.delete(draftKey);
    try {
      await onSend({ ...sent, selection: chosen });
      setNote(null);
    } catch (failure) {
      // Nothing is lost when a send fails. The text and files come back into the box.
      setText((current) => current || sent.text);
      setFiles((current) => (current.length > 0 ? current : sent.files));
      setNote(failureText(failure, 'The message was not sent.'));
    }
  }
  // A saved thread stores each file right away, one at a time, since the desktop sends one
  // command at a time. The controller reads the type from the bytes, and the chip shows it.
  async function add(found: readonly DesktopFile[]) {
    const known = new Set(files.map((file) => file.path));
    const fresh = found
      .filter((item) => !known.has(item.path))
      .slice(0, Math.max(0, MAX_FILES - files.length))
      .map((item) => local(item, taskId !== null));
    if (found.length > 0 && fresh.length === 0 && files.length >= MAX_FILES)
      setNote('A message holds up to 32 files.');
    setFiles((current) => [...current, ...fresh]);
    if (!taskId) return;
    for (const item of fresh) {
      try {
        const file = await importAttachment(source, taskId, item.path ?? '');
        keepThumbnail(file.id, item.thumbnail);
        setFiles((current) =>
          current.some((other) => other.file?.id === file.id)
            ? current.filter((other) => other.key !== item.key)
            : current.map((other) =>
                other.key === item.key
                  ? { ...other, key: file.id, file, mimeType: file.mimeType, busy: false }
                  : other,
              ),
        );
      } catch (failure) {
        setFiles((current) => current.filter((other) => other.key !== item.key));
        setNote(failureText(failure, 'The file was not added.'));
      }
    }
  }
  function attach(input: DesktopAttachInput) {
    const find = source.attachFiles;
    if (!find) return;
    find(input).then(add, (failure: unknown) =>
      setNote(failureText(failure, 'The files could not be read.')),
    );
  }
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  function onDrop(event: DragEvent<HTMLFormElement>) {
    setDropping(false);
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!canAttach) return;
    attach({ from: 'drop', files: [...event.dataTransfer.files] });
  }
  // A pasted file goes in as a chip. Pasted text goes in the box as usual.
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = [...event.clipboardData.files];
    if (pasted.length === 0 || !canAttach) return;
    event.preventDefault();
    attach({ from: 'paste', files: pasted });
  }
  const entry = catalog?.families.find(({ family }) => family === chosen?.family);
  // Only what the selected family's client reported. A client that reported nothing gets no line.
  const delivery = (file: ChipFile) => {
    const how = entry && file.mimeType ? deliveryOf(entry, file.mimeType) : null;
    return how && entry && file.mimeType
      ? deliveryNote(familyName(entry.family), how, file.mimeType)
      : null;
  };
  const typeNote = (file: ChipFile) =>
    (delivery(file)?.warn ? delivery(file)?.title : null) ?? null;
  const typeHover = (file: ChipFile) => delivery(file)?.title ?? null;
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  return (
    <div className="th-composer-wrap">
      <form
        className={dropping ? 'th-composer is-dropping' : 'th-composer'}
        onSubmit={(event) => void submit(event)}
        onDragOver={(event) => {
          if (!hasFiles(event) || !canAttach) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDropping(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={onDrop}
      >
        <FileChips
          files={files}
          taskId={taskId ?? undefined}
          note={typeNote}
          hover={typeHover}
          onRemove={(key) => {
            setFiles(files.filter((file) => file.key !== key));
            field.current?.focus();
          }}
        />
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
          onPaste={onPaste}
        />
        {taskId && (
          <div className="th-roles">
            {(Object.keys(roleActions) as RoleAction[]).map((action) => {
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
          </div>
        )}
        {roles.row}
        <div className="th-composer-bar">
          <button
            type="button"
            className="th-icon"
            aria-label="Attach files"
            title={source.attachFiles ? 'Attach files' : 'Files attach in the desktop app'}
            disabled={!canAttach}
            onClick={() => attach({ from: 'picker' })}
          >
            <Paperclip size={16} aria-hidden="true" />
          </button>
          <ModelPicker
            catalog={catalog}
            selection={chosen}
            currentFamily={currentFamily}
            handoffMode={thread?.handoffMode}
            running={running}
            nowMs={Date.now()}
            onOpen={loadCatalog}
            localSeen={seen}
            onObserve={refreshLocal ? observeLocal : undefined}
            onSelect={select}
            onHandoff={(next) =>
              onHandoff(next).catch((failure: unknown) =>
                setNote(failure instanceof Error ? failure.message : 'The thread was not moved.'),
              )
            }
          />
          {onOpenCrew && thread && (
            <button
              type="button"
              className="th-pill th-flight"
              data-mode={flight.id}
              title={`${flight.title} Open Crew to change it.`}
              onClick={onOpenCrew}
            >
              {thread.crew ? `${flight.label} · ${thread.crew.name}` : flight.label}
            </button>
          )}
          <div className="th-bar-end">
            {context?.capacity && (
              <ContextGauge
                usedTokens={context.used}
                capacityTokens={context.capacity}
                measurement="current"
                updating={running}
                size={22}
              />
            )}
            {running && (
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
            )}
            <button
              type="submit"
              className="th-send"
              aria-label="Send"
              title={
                blocked ??
                (adding ? 'Wait for the files' : running ? 'Send when this turn ends' : 'Send')
              }
              disabled={!text.trim() || !!blocked || adding}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          </div>
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
