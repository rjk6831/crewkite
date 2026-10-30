import { parseArgs } from 'node:util';
import {
  AddProjectNotePayloadSchema,
  CLI_EXIT,
  normalizeNoteText,
  type ProjectNotesRead,
  ReadProjectNotesPayloadSchema,
  RemoveProjectNotePayloadSchema,
} from '@crewkite/contracts';
import { crewkiteHome } from '../settings.ts';
import type { ChatClient } from './client.ts';
import { type Connect, type Io, notDone, terminalText, UsageError } from './scripting.ts';

// `crewkite notes list|add|remove`. The controller keeps the notes and puts them in front of every
// provider with each turn. Text goes to stdout, and --json writes one JSON object per command.

export const notesHelp = `Usage: crewkite notes list <project-id> [--json] [--home path]
       crewkite notes add <project-id> <text> [--json] [--home path]
       crewkite notes remove <project-id> <note-id> [--json] [--home path]

A project holds up to 200 notes and 16 KiB of them. Each note is up to 1,000 characters. Quote a
note that has spaces. Exit status: 0 done, 1 failed, 2 nothing was done.
`;

export function notesText(read: ProjectNotesRead): string {
  const lines = read.notes.flatMap((note) => [
    `${note.id}  ${note.createdAt}`,
    ...note.text.split('\n').map((line) => `  ${line}`),
  ]);
  const size = `${read.notes.length} ${read.notes.length === 1 ? 'note' : 'notes'}, ${read.bytes} of ${read.capBytes} bytes`;
  return terminalText([...lines, `${read.projectName}: ${size}.`].join('\n'));
}

export async function runNotesCommand(args: string[], io: Io, connect: Connect): Promise<number> {
  let client: ChatClient | undefined;
  let json = false;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        home: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    json = values.json === true;
    const [action, projectId, argument, ...extra] = positionals;
    if (values.help || !action) {
      await io.out(notesHelp);
      return 0;
    }
    if (!['list', 'add', 'remove'].includes(action))
      throw new UsageError(`Unknown notes command: ${action}.`);
    if (!projectId) throw new UsageError('Give the project ID.');
    if (extra.length > 0 || (action === 'list' && argument !== undefined))
      throw new UsageError('Quote a note that has spaces.');
    // The same schemas the controller checks, so a bad ID or note stops here with a sentence.
    const project = ReadProjectNotesPayloadSchema.safeParse({ projectId });
    if (!project.success) throw new UsageError('That is not a project ID. List projects first.');
    let text = '';
    if (action === 'add') {
      text = normalizeNoteText(argument ?? '');
      if (!AddProjectNotePayloadSchema.safeParse({ projectId, text }).success)
        throw new UsageError('Give a note of 1 to 1,000 characters.');
    }
    if (action === 'remove') {
      if (!RemoveProjectNotePayloadSchema.safeParse({ projectId, noteId: argument }).success)
        throw new UsageError('Give the note ID that notes list shows.');
    }
    client = await connect(crewkiteHome(values.home));
    const read =
      action === 'add'
        ? await client.addNote(projectId, text)
        : action === 'remove'
          ? await client.removeNote(projectId, argument as string)
          : await client.readNotes(projectId);
    await io.out(
      json
        ? `${JSON.stringify({ kind: 'project-notes', action, read })}\n`
        : `${action === 'add' ? 'Added.\n' : action === 'remove' ? 'Removed.\n' : ''}${notesText(read)}\n`,
    );
    return 0;
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : 'The command could not run.';
    if (json)
      await io.out(`${JSON.stringify({ kind: 'error', message: message.slice(0, 4096) })}\n`);
    else io.err(`${terminalText(message)}\n`);
    return notDone(error) ? CLI_EXIT.notDone : CLI_EXIT.failed;
  } finally {
    client?.transport.close();
  }
}
