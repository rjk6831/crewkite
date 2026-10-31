import {
  normalizeNoteText,
  PROJECT_NOTE_CHARACTERS,
  type ProjectNotesRead,
} from '@crewkite/contracts';
import { NotebookText } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { addNote, readNotes, type ThreadSource } from './commands.ts';
import './composer-menu.css';

// The project's notes in a thread: the chip above the composer that says they go with every
// message, and the editor "Save as note" opens. The controller keeps the notes and decides what
// each provider receives. This file only shows them and sends the person's own text back.

type Notes = {
  source: ThreadSource;
  projectId: string;
  /** Changes when a note is saved here, so the chip reads again. */
  version: number;
  saved: () => void;
};
const NotesContext = createContext<Notes | null>(null);

export function ProjectNotesProvider({
  source,
  projectId,
  children,
}: {
  source: ThreadSource;
  projectId: string | null;
  children: ReactNode;
}) {
  const [version, setVersion] = useState(0);
  const saved = useCallback(() => setVersion((value) => value + 1), []);
  const value = useMemo(
    () => (projectId ? { source, projectId, version, saved } : null),
    [source, projectId, version, saved],
  );
  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

/** The notes of this thread's project, or null where no project is known, as in a new thread. */
export const useProjectNotes = () => useContext(NotesContext);

/**
 * One chip above the composer when the project has notes. Clicking it lists them. Notes change
 * in Settings, under Projects.
 */
export function NotesChip({ refreshKey }: { refreshKey: unknown }) {
  const notes = useProjectNotes();
  const [read, setRead] = useState<ProjectNotesRead | null>(null);
  const [shown, setShown] = useState(false);
  const source = notes?.source;
  const projectId = notes?.projectId;
  const version = notes?.version;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and version ask for a new read
  useEffect(() => {
    if (!source || !projectId) return;
    let live = true;
    readNotes(source, projectId).then(
      (next) => live && setRead(next),
      () => live && setRead(null),
    );
    return () => {
      live = false;
    };
  }, [source, projectId, version, refreshKey]);
  if (!read || read.notes.length === 0) return null;
  const count = read.notes.length;
  return (
    <div className="th-instructions">
      <button
        type="button"
        className="th-instructions-chip"
        aria-expanded={shown}
        aria-controls="th-notes-view"
        title="Project notes. Every message carries them. Change them in Settings."
        onClick={() => setShown(!shown)}
      >
        <NotebookText size={13} aria-hidden="true" />
        {count === 1 ? '1 note' : `${count} notes`}
      </button>
      {shown && (
        <div className="th-instructions-view" id="th-notes-view">
          <ul className="th-notes-list">
            {read.notes.map((note) => (
              <li key={note.id}>{note.text}</li>
            ))}
          </ul>
          <p className="th-note-lines">
            {read.bytes.toLocaleString('en-US')} of {read.capBytes.toLocaleString('en-US')} bytes
            used. Change the notes in Settings.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The text of a note before it is saved, editable. Save sends it to the controller, which holds
 * the size limits and answers with a sentence when a limit stops it.
 */
export function SaveNoteEditor({
  notes,
  initial,
  onDone,
}: {
  notes: Notes;
  initial: string;
  /** The sentence to show once the editor closes, or null when the person cancelled. */
  onDone: (said: string | null) => void;
}) {
  const [text, setText] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clean = normalizeNoteText(text);
  const valid = clean !== '' && clean.length <= PROJECT_NOTE_CHARACTERS;
  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await addNote(notes.source, notes.projectId, clean);
      notes.saved();
      onDone('Saved as a note');
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'The note was not saved.');
      setBusy(false);
    }
  }
  return (
    <form
      className="th-note-editor"
      aria-label="Save as note"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDone(null);
      }}
    >
      <label htmlFor="th-note-text">Note, sent with every message in this project</label>
      <textarea
        id="th-note-text"
        // biome-ignore lint/a11y/noAutofocus: the editor opens because the person chose Save as note
        autoFocus
        rows={5}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="th-note-editor-foot">
        <span className="th-muted" role="status">
          {problem ?? `${clean.length} of ${PROJECT_NOTE_CHARACTERS} characters`}
        </span>
        <button type="button" className="th-pill" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="th-pill" disabled={!valid || busy}>
          Save note
        </button>
      </div>
    </form>
  );
}
