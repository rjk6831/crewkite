import { useEffect, useRef, useState } from 'react';
import { renameThread, type ThreadSource } from './commands.ts';

const MAX_TITLE = 200;

// Enter saves and Escape cancels. Leaving the field cancels too, so a half typed title is never
// saved by a stray click. The new title reaches the rail and the header through the workspace
// refresh the controller's task event starts.
export function TitleField({
  source,
  taskId,
  title,
  className,
  onDone,
}: {
  source: ThreadSource;
  taskId: string;
  title: string;
  className?: string;
  onDone: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const finished = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const finish = (message: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(message);
  };
  async function save() {
    const next = draft.trim();
    if (!next || next === title) return finish(null);
    setSaving(true);
    try {
      await renameThread(source, taskId, next);
      finish(null);
    } catch (failure) {
      finish(failure instanceof Error ? failure.message : 'The thread was not renamed.');
    }
  }
  return (
    <input
      ref={field}
      className={className}
      aria-label="Thread title"
      value={draft}
      maxLength={MAX_TITLE}
      readOnly={saving}
      aria-busy={saving}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (!saving) finish(null);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          void save();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

/** The thread header title. Clicking it opens the title for editing in place. */
export function ThreadTitle({
  source,
  task,
}: {
  source: ThreadSource;
  task: { id: string; title: string };
}) {
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      {editing ? (
        <TitleField
          source={source}
          taskId={task.id}
          title={task.title}
          className="th-title-field"
          onDone={(said) => {
            setEditing(false);
            setMessage(said);
          }}
        />
      ) : (
        <h1 className="th-title" title={task.title}>
          <button
            type="button"
            className="th-title-button"
            onClick={() => {
              setMessage(null);
              setEditing(true);
            }}
          >
            {task.title}
          </button>
        </h1>
      )}
      {message && (
        <span className="th-title-note" role="status">
          {message}
        </span>
      )}
    </>
  );
}
