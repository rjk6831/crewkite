import type { DesktopSource } from '@crewkite/client';
import {
  normalizeNoteText,
  PROJECT_NOTE_CHARACTERS,
  type ProjectNotesRead,
} from '@crewkite/contracts';
import { useEffect, useRef, useState } from 'react';
import { addNote, editNote, readNotes, removeNote, type ThreadSource } from '../thread/commands.ts';

/**
 * Notes for one project. The controller sends them with every message to every provider, and it
 * holds the size limits, so this card shows what it answers and the sentence it gives when a limit
 * stops a change.
 */
export function NotesCard({
  source,
  projects,
}: {
  source: ThreadSource & Pick<DesktopSource, 'saveNotes'>;
  projects: { id: string; name: string }[];
}) {
  const [chosen, setChosen] = useState('');
  const projectId = projects.some(({ id }) => id === chosen) ? chosen : (projects[0]?.id ?? '');
  const [read, setRead] = useState<ProjectNotesRead | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    setRead(null);
    if (!projectId) return;
    let live = true;
    readNotes(source, projectId).then(
      (next) => live && setRead(next),
      (failure: unknown) =>
        live && setNote(failure instanceof Error ? failure.message : 'Notes could not be read.'),
    );
    return () => {
      live = false;
    };
  }, [source, projectId]);

  // The project on screen now. An answer that arrives for another project is dropped, so the list
  // and the sentence below it always belong to the project the person is looking at.
  const shown = useRef(projectId);
  shown.current = projectId;
  async function change(run: () => Promise<ProjectNotesRead>, done: string) {
    const target = projectId;
    try {
      const next = await run();
      if (shown.current !== target) return false;
      setRead(next);
      setNote(done);
      return true;
    } catch (failure) {
      if (shown.current === target)
        setNote(failure instanceof Error ? failure.message : 'The change was not saved.');
      return false;
    }
  }
  // Main reads the notes from the controller and writes the Markdown through its save dialog.
  async function exportFile() {
    if (!source.saveNotes) {
      setNote('Export needs the desktop app.');
      return;
    }
    const target = projectId;
    try {
      const saved = (await source.saveNotes(target)) === 'saved' ? 'Saved.' : null;
      if (shown.current === target) setNote(saved);
    } catch (failure) {
      if (shown.current === target)
        setNote(failure instanceof Error ? failure.message : 'The file was not saved.');
    }
  }
  const clean = normalizeNoteText(text);
  const valid = clean !== '' && clean.length <= PROJECT_NOTE_CHARACTERS;
  return (
    <section className="st-card" aria-labelledby="settings-notes">
      <header className="st-card-head">
        <h2 id="settings-notes">Project notes</h2>
        <span className="st-detail">
          {read
            ? `${read.bytes.toLocaleString('en-US')} of ${read.capBytes.toLocaleString('en-US')} bytes used`
            : 'Sent with every message'}
        </span>
      </header>
      {projects.length === 0 ? (
        <p className="st-note">Add a project to keep notes for it.</p>
      ) : (
        <div className="st-rows">
          <div className="st-row">
            <div className="st-field">
              <label className="st-name" htmlFor="notes-project">
                Project
              </label>
              <small className="st-hint">Every thread in the project sends these notes.</small>
            </div>
            <div className="st-controls">
              <select
                id="notes-project"
                value={projectId}
                onChange={(event) => {
                  setChosen(event.target.value);
                  setEditing(null);
                  setText('');
                  setNote(null);
                }}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {read?.notes.map((entry) => (
            <div className="st-row" key={entry.id}>
              <div className="st-field">
                <span className="st-name">{new Date(entry.createdAt).toLocaleDateString()}</span>
                <small className="st-hint st-note-text">{entry.text}</small>
              </div>
              <div className="st-controls">
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    setEditing(entry.id);
                    setText(entry.text);
                  }}
                >
                  Edit
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() =>
                    void change(() => removeNote(source, projectId, entry.id), 'Deleted.').then(
                      (done) => {
                        if (done && editing === entry.id) {
                          setEditing(null);
                          setText('');
                        }
                      },
                    )
                  }
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          <form
            className="st-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid || !projectId) return;
              void change(
                () =>
                  editing
                    ? editNote(source, projectId, editing, clean)
                    : addNote(source, projectId, clean),
                'Saved.',
              ).then((done) => {
                if (done) {
                  setEditing(null);
                  setText('');
                }
              });
            }}
          >
            <div className="st-field">
              <label className="st-name" htmlFor="notes-text">
                {editing ? 'Edit note' : 'New note'}
              </label>
              <textarea
                id="notes-text"
                value={text}
                rows={3}
                maxLength={PROJECT_NOTE_CHARACTERS * 2}
                onChange={(event) => setText(event.target.value)}
              />
              <small className="st-hint">
                {clean.length} of {PROJECT_NOTE_CHARACTERS} characters.
              </small>
            </div>
            <div className="st-controls">
              <button className="button primary" type="submit" disabled={!valid}>
                {editing ? 'Save changes' : 'Add note'}
              </button>
              {editing && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setText('');
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                className="button secondary"
                type="button"
                disabled={!read || read.notes.length === 0}
                onClick={() => void exportFile()}
              >
                Export Markdown
              </button>
            </div>
          </form>
        </div>
      )}
      {note && (
        <p className="st-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
