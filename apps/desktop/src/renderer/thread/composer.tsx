import {
  completeSlash,
  type DesktopAttachInput,
  type DesktopFile,
  expandPrompt,
  findMentionTrigger,
  insertMention,
  parsePromptArgument,
  parseSlash,
  type SlashCommand,
} from '@crewkite/client';
import type {
  ChatAttachment,
  ChatCatalogRead,
  ChatFamily,
  ChatMention,
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
import { provide } from '../palette/actions.ts';
import { flightModes, preferredSelection } from '../settings/preferences.ts';
import { type ChipFile, chipOf, FileChips, keepThumbnail } from './attach.tsx';
import {
  completeMention,
  configureThread,
  importAttachment,
  readCatalog,
  readPrompts,
  type ThreadSource,
} from './commands.ts';
import { CompleteMenu, type MenuItem } from './composer-menu.tsx';
import { canSend, isMacPlatform, shortcutFor } from './composer-rules.ts';
import { deliveryNote, deliveryOf } from './file-fit.ts';
import { InstructionChip } from './instruction-chip.tsx';
import { defaultSelection, ModelPicker } from './model-picker.tsx';
import { NotesChip } from './project-notes.tsx';
import { type RoleAction, roleActions, useRoleRun } from './role-row.tsx';
import { slashEffect } from './slash-actions.ts';

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
  lastMessage = null,
  onNewThread,
  onOpenSettings,
  onOpenChanges,
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
  /** The newest message the person sent. Up in an empty box loads it back for editing. */
  lastMessage?: { text: string; files: readonly ChatAttachment[] } | null;
  /** The slash commands that move around the app. A view that cannot do one leaves it out. */
  onNewThread?: () => void;
  onOpenSettings?: () => void;
  /** Opens the inspector on the Changes tab. A new thread has no changes and leaves it out. */
  onOpenChanges?: () => void;
}) {
  const draftKey = taskId ?? 'new';
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [files, setFiles] = useState<ComposerFile[]>([]);
  const [dropping, setDropping] = useState(false);
  const [catalog, setCatalog] = useState<ChatCatalogRead | null>(null);
  const [selection, setSelection] = useState<ChatModelSelection | null>(thread?.selection ?? null);
  const [note, setNote] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [found, setFound] = useState<{ query: string; items: ChatMention[] }>({
    query: '',
    items: [],
  });
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
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
  // The command palette reaches the slash commands through this one function.
  const paletteSlash = useRef(runSlash);
  paletteSlash.current = runSlash;
  useEffect(
    () => provide('slash', (name, argument) => void paletteSlash.current(name, argument, true)),
    [],
  );
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
  // An unfinished @ mention at the caret, or a slash command name at the start of the box.
  const trigger = taskId ? findMentionTrigger(text, caret) : null;
  const triggerQuery = trigger?.query;
  useEffect(() => {
    if (!taskId || triggerQuery === undefined) {
      setFound({ query: '', items: [] });
      return;
    }
    let live = true;
    completeMention(source, taskId, triggerQuery).then(
      (read) => {
        if (!live) return;
        setFound({ query: triggerQuery, items: read.mentions });
        setActive(0);
      },
      () => live && setFound({ query: triggerQuery, items: [] }),
    );
    return () => {
      live = false;
    };
  }, [source, taskId, triggerQuery]);
  // Results for an earlier query stay out of the list, so Enter never inserts a stale match.
  const mentions = trigger && found.query === trigger.query ? found.items : [];
  const slashMatches: SlashCommand[] = trigger ? [] : completeSlash(text);
  const menuItems: MenuItem[] =
    dismissed === text
      ? []
      : trigger
        ? mentions.map((item) => ({
            key: `${item.kind}:${item.path}`,
            label: item.kind === 'folder' ? `${item.path}/` : item.path,
            detail: item.kind === 'folder' ? 'folder' : null,
          }))
        : slashMatches.map((item) => ({
            key: item.name,
            label: `/${item.name}`,
            detail: item.summary,
          }));
  const menuOpen = menuItems.length > 0;
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
    question: text.trim(),
    onAsked: () => {
      setText('');
      drafts.delete(draftKey);
    },
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
  const saved = localState?.setup;
  const seen =
    saved && (!saved.connected || saved.observationStale)
      ? lastSeen(saved.observedAt, Date.now(), !!saved.connected)
      : null;
  const adding = files.some((file) => file.busy);
  const canAttach = !!source.attachFiles && !blocked;
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    // A message sent while a turn runs waits in the thread and starts when the turn ends.
    const body = text.trim();
    const slash = files.length === 0 ? parseSlash(body) : null;
    if (slash) {
      void runSlash(slash.name, slash.argument);
      return;
    }
    if (!canSend({ text: body, files: files.length, blocked, adding })) return;
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
  function clearBox() {
    setText('');
    setCaret(0);
    drafts.delete(draftKey);
  }
  function fillBox(value: string) {
    setText(value);
    setCaret(value.length);
    drafts.set(draftKey, value);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(value.length, value.length);
    });
  }
  // A slash command moves around the app or fills the box. It never sends a message, and accept,
  // push and pull request stay behind their own confirmation in Changes.
  // The command palette runs the same function. It leaves the draft in the box, since the person
  // did not type the command into it.
  async function runSlash(
    name: Parameters<typeof slashEffect>[0],
    argument: string,
    keepDraft = false,
  ) {
    const { action, note: said } = slashEffect(name, {
      thread: taskId !== null,
      newThread: !!onNewThread,
      settings: !!onOpenSettings,
      crew: !!onOpenCrew,
      changes: !!onOpenChanges,
    });
    setNote(said);
    if (action === 'prompt') {
      try {
        const { prompts } = await readPrompts(source);
        const { name: wanted, values } = parsePromptArgument(argument);
        const found = prompts.find((prompt) => prompt.name === wanted);
        if (!found) {
          const names = prompts.map((prompt) => prompt.name).join(', ');
          setNote(
            prompts.length === 0
              ? 'No prompts are saved yet. Add one in Settings, Prompts.'
              : `${wanted ? `No saved prompt is named ${wanted}. ` : ''}Saved prompts: ${names}.`,
          );
          return;
        }
        const filled = expandPrompt(found.body, values);
        fillBox(filled.text);
        setNote(filled.missing.length > 0 ? `Fill in ${filled.missing.join(', ')}.` : null);
      } catch (failure) {
        setNote(failureText(failure, 'The saved prompts could not be read.'));
      }
      return;
    }
    if (action === 'ask') {
      if (!keepDraft) clearBox();
      if (argument) fillBox(argument);
      const why = roles.why('ask');
      if (why) setNote(why);
      else if (roles.role !== 'ask') roles.toggle('ask');
      return;
    }
    // A command the view cannot run, and /help, leave the box as it is.
    if (action === 'none') return;
    if (!keepDraft) clearBox();
    if (action === 'new-thread') onNewThread?.();
    else if (action === 'open-settings') onOpenSettings?.();
    else if (action === 'open-crew') onOpenCrew?.();
    else if (action === 'open-changes') onOpenChanges?.();
    else if (action === 'pick-model')
      bar.current?.querySelector<HTMLButtonElement>('.th-picker > button')?.click();
  }
  function pick(index: number) {
    if (trigger) {
      const chosenMention = mentions[index];
      if (!chosenMention) return;
      const next = insertMention(text, trigger, chosenMention);
      setText(next.text);
      drafts.set(draftKey, next.text);
      setCaret(next.caret);
      requestAnimationFrame(() => {
        field.current?.focus();
        field.current?.setSelectionRange(next.caret, next.caret);
      });
      return;
    }
    const command = slashMatches[index];
    if (!command) return;
    if (command.argument) fillBox(`/${command.name} `);
    else void runSlash(command.name, '');
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
  function stopRunning() {
    onStop().catch((failure: unknown) =>
      setNote(failure instanceof Error ? failure.message : 'The turn could not be stopped.'),
    );
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const field = event.currentTarget;
    if (menuOpen && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((active + step + menuItems.length) % menuItems.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        pick(Math.min(active, menuItems.length - 1));
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(text);
        return;
      }
    }
    const action = shortcutFor(event.nativeEvent, {
      mac: isMacPlatform(),
      composerFocused: true,
      composerEmpty: text === '' && files.length === 0,
      running,
      selecting:
        field.selectionStart !== field.selectionEnd ||
        (window.getSelection()?.toString().length ?? 0) > 0,
      dialogOpen: false,
    });
    if (action === 'stop-turn') {
      event.preventDefault();
      stopRunning();
      return;
    }
    if (action === 'edit-last' && lastMessage) {
      event.preventDefault();
      setText(lastMessage.text);
      drafts.set(draftKey, lastMessage.text);
      setFiles(lastMessage.files.map(stored));
      requestAnimationFrame(() =>
        field.setSelectionRange(lastMessage.text.length, lastMessage.text.length),
      );
      return;
    }
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
        {taskId && (
          <div className="th-chip-row">
            <InstructionChip source={source} taskId={taskId} refreshKey={running} />
            <NotesChip refreshKey={running} />
          </div>
        )}
        {menuOpen && (
          <CompleteMenu
            id="th-complete"
            label={trigger ? 'Files and folders' : 'Slash commands'}
            items={menuItems}
            active={Math.min(active, menuItems.length - 1)}
            onPick={pick}
          />
        )}
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the box is a combobox only while its list is open */}
        <textarea
          ref={field}
          role={menuOpen ? 'combobox' : undefined}
          aria-expanded={menuOpen ? true : undefined}
          aria-controls={menuOpen ? 'th-complete' : undefined}
          aria-activedescendant={
            menuOpen ? `th-complete-${Math.min(active, menuItems.length - 1)}` : undefined
          }
          rows={1}
          value={text}
          placeholder="Ask about this project or describe a change"
          aria-label="Message"
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setActive(0);
            drafts.set(draftKey, event.target.value);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
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
            <button
              type="button"
              className="th-pill"
              aria-expanded={roles.role === 'ask'}
              aria-controls={roles.role === 'ask' ? 'th-role-row' : undefined}
              disabled={roles.why('ask') !== null}
              title={
                roles.why('ask') ??
                'Ask one family a read-only question. The answer posts beside the thread.'
              }
              onClick={() => roles.toggle('ask')}
            >
              {roles.askLabel}
            </button>
          </div>
        )}
        {roles.row}
        <div className="th-composer-bar" ref={bar}>
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
                onClick={stopRunning}
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
              disabled={!canSend({ text, files: files.length, blocked, adding })}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </form>
      {(blocked ?? notice ?? note) && (
        <p className="th-note th-note-lines" role="status">
          {blocked ?? notice ?? note}
        </p>
      )}
    </div>
  );
}
