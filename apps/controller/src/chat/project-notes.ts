import type { DatabaseSync } from 'node:sqlite';
import {
  PROJECT_NOTES_BYTES,
  PROJECT_NOTES_MAX,
  type ProjectNote,
  ProjectNoteSchema,
  type ProjectNotesRead,
  ProjectNoteTextSchema,
  projectNotesBytes,
  projectNotesFit,
} from '@crewkite/contracts';

// Notes are short facts the person keeps for a project. The controller owns them in SQLite, so the
// desktop and the command line read one list, and each turn takes its copy from here. A note is
// text for the model. It grants nothing and runs nothing.

export class NotesRefused extends Error {
  reason: 'project-not-found' | 'note-not-found' | 'notes-full' | 'notes-count';
  next: string;
  constructor(reason: NotesRefused['reason'], next: string) {
    super(next);
    this.reason = reason;
    this.next = next;
  }
}

export class ProjectNotes {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(db: DatabaseSync, now: () => string, id: () => string) {
    this.db = db;
    this.now = now;
    this.id = id;
  }

  /** The notes of one project, oldest first. Notes made in one millisecond order by id. */
  list(projectId: string): ProjectNote[] {
    return this.db
      .prepare(
        'SELECT id, text, created_at FROM project_notes WHERE project_id=? ORDER BY created_at, id',
      )
      .all(projectId)
      .map((row) =>
        ProjectNoteSchema.parse({
          id: row.id,
          text: row.text,
          createdAt: row.created_at,
        }),
      );
  }

  /** The text a turn carries. A project that was never registered has none. */
  texts(projectId: string): string[] {
    return this.list(projectId).map(({ text }) => text);
  }

  read(projectId: string): ProjectNotesRead {
    const project = this.project(projectId);
    const notes = this.list(projectId);
    return {
      projectId,
      projectName: project,
      notes,
      bytes: projectNotesBytes(notes.map(({ text }) => text)),
      capBytes: PROJECT_NOTES_BYTES,
    };
  }

  add(projectId: string, text: string): ProjectNotesRead {
    this.project(projectId);
    const clean = ProjectNoteTextSchema.parse(text);
    this.check([...this.texts(projectId), clean]);
    this.db
      .prepare('INSERT INTO project_notes(id, project_id, text, created_at) VALUES (?,?,?,?)')
      .run(this.id(), projectId, clean, this.now());
    return this.read(projectId);
  }

  /** An edit keeps the note's place and its time. */
  edit(projectId: string, noteId: string, text: string): ProjectNotesRead {
    this.project(projectId);
    const clean = ProjectNoteTextSchema.parse(text);
    const notes = this.list(projectId);
    if (!notes.some(({ id }) => id === noteId)) throw missing();
    this.check(notes.map((note) => (note.id === noteId ? clean : note.text)));
    this.db
      .prepare('UPDATE project_notes SET text=? WHERE id=? AND project_id=?')
      .run(clean, noteId, projectId);
    return this.read(projectId);
  }

  remove(projectId: string, noteId: string): ProjectNotesRead {
    this.project(projectId);
    const removed = this.db
      .prepare('DELETE FROM project_notes WHERE id=? AND project_id=?')
      .run(noteId, projectId);
    if (Number(removed.changes) === 0) throw missing();
    return this.read(projectId);
  }

  private project(projectId: string): string {
    const row = this.db
      .prepare("SELECT body FROM entities WHERE kind='project' AND id=?")
      .get(projectId);
    if (!row)
      throw new NotesRefused('project-not-found', 'Choose a registered project for these notes.');
    return (JSON.parse(row.body as string) as { name: string }).name;
  }

  private check(texts: readonly string[]) {
    const fit = projectNotesFit(texts);
    if (fit.fits) return;
    throw fit.reason === 'count'
      ? new NotesRefused(
          'notes-count',
          `A project holds up to ${PROJECT_NOTES_MAX} notes. Remove a note before adding another.`,
        )
      : new NotesRefused(
          'notes-full',
          'A project holds up to 16 KiB of notes. Shorten or remove a note first.',
        );
  }
}

const missing = () => new NotesRefused('note-not-found', 'That note no longer exists.');
