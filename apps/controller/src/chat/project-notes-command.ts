import type { Command, CommandResult } from '@crewkite/contracts';
import { NotesRefused, type ProjectNotes } from './project-notes.ts';

export type NotesCommand = Extract<
  Command,
  { command: 'ReadProjectNotes' | 'AddProjectNote' | 'EditProjectNote' | 'RemoveProjectNote' }
>;

/** The commands that change notes. The controller does not race them on a revision. */
export const notesMutations = ['AddProjectNote', 'EditProjectNote', 'RemoveProjectNote'];

/**
 * Runs one notes command. Each answers with the project's whole list, and a refusal comes back as
 * a blocked result that carries the sentence for the person.
 */
export function notesCommand(notes: ProjectNotes, command: NotesCommand): CommandResult {
  try {
    const { projectId } = command.payload;
    const read =
      command.command === 'AddProjectNote'
        ? notes.add(projectId, command.payload.text)
        : command.command === 'EditProjectNote'
          ? notes.edit(projectId, command.payload.noteId, command.payload.text)
          : command.command === 'RemoveProjectNote'
            ? notes.remove(projectId, command.payload.noteId)
            : notes.read(projectId);
    return { outcome: 'applied', data: { kind: 'project-notes', ...read } };
  } catch (failure) {
    if (failure instanceof NotesRefused)
      return { outcome: 'blocked', reason: failure.reason, next: failure.next };
    throw failure;
  }
}
