import type { Command, CommandResult } from '@crewkite/contracts';
import { NotesRefused, type ProjectNotes } from './project-notes.ts';

export type NotesCommand = Extract<
  Command,
  { command: 'ReadProjectNotes' | 'AddProjectNote' | 'EditProjectNote' | 'RemoveProjectNote' }
>;

/** The commands that change notes. The controller does not race them on a revision. */
export const notesMutations = ['AddProjectNote', 'EditProjectNote', 'RemoveProjectNote'];

/**
 * Runs one notes command. A read answers with the project's whole list. A change answers with the
 * project and the size its notes now take, so its receipt stays small and a client reads the list
 * again to see it. A refusal comes back as a blocked result that carries the sentence for the
 * person.
 */
export function notesCommand(notes: ProjectNotes, command: NotesCommand): CommandResult {
  try {
    const { projectId } = command.payload;
    if (command.command === 'ReadProjectNotes')
      return { outcome: 'applied', data: { kind: 'project-notes', ...notes.read(projectId) } };
    const changed =
      command.command === 'AddProjectNote'
        ? notes.add(projectId, command.payload.text)
        : command.command === 'EditProjectNote'
          ? notes.edit(projectId, command.payload.noteId, command.payload.text)
          : notes.remove(projectId, command.payload.noteId);
    return {
      outcome: 'applied',
      data: { kind: 'project-notes-changed', projectId, bytes: changed.bytes },
    };
  } catch (failure) {
    if (failure instanceof NotesRefused)
      return { outcome: 'blocked', reason: failure.reason, next: failure.next };
    throw failure;
  }
}
