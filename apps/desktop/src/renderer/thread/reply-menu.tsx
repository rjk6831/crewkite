import { noteFromReply } from '@crewkite/contracts';
import { Ellipsis } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { SaveNoteEditor, useProjectNotes } from './project-notes.tsx';

/**
 * The menu under a finished reply. Copy reply puts the Markdown the model wrote on the clipboard,
 * so a table or a code fence pastes as source. Save as note keeps the text selected in the reply,
 * or its first paragraph, as a project note, and the person edits it before it is saved.
 */
export function ReplyMenu({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const notes = useProjectNotes();
  // The text selected in this reply when the menu opened. Clicking the button keeps it.
  const [selected, setSelected] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    items.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const away = (event: MouseEvent) => {
      if (!items.current?.contains(event.target as Node) && event.target !== trigger.current)
        setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), 2500);
    return () => window.clearTimeout(timer);
  }, [said]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  // The selection is read before the click can move it, and only when it lies in this reply.
  function remember() {
    const found = window.getSelection();
    const turn = trigger.current?.closest('article');
    setSelected(
      found && turn && found.anchorNode && turn.contains(found.anchorNode) ? found.toString() : '',
    );
  }
  function startNote() {
    close();
    setEditing(noteFromReply(source, selected));
  }
  async function copy() {
    close();
    try {
      await navigator.clipboard.writeText(source);
      setSaid('Reply copied');
    } catch {
      // The clipboard can be blocked. The reply stays selectable.
      setSaid('The reply was not copied. Select its text instead.');
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      close();
    }
  }
  return (
    <div className="th-reply-menu">
      <button
        ref={trigger}
        type="button"
        className="th-icon"
        aria-label="Reply actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onMouseDown={remember}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={items}
          id={menuId}
          className="th-menu th-reply-items"
          role="menu"
          aria-label="Reply actions"
          onKeyDown={onKeyDown}
        >
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => void copy()}>
            Copy reply
          </button>
          {notes && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={startNote}>
              Save as note
            </button>
          )}
        </div>
      )}
      {notes && editing !== null && (
        <SaveNoteEditor
          notes={notes}
          initial={editing}
          onDone={(line) => {
            setEditing(null);
            if (line) setSaid(line);
          }}
        />
      )}
      {said && <span className="th-muted th-reply-said">{said}</span>}
    </div>
  );
}
