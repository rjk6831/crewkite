import { z } from 'zod';

// Project notes: short durable facts the person keeps for a project. The controller stores them
// and puts them in front of every provider with each turn. A note is text for the model. It grants
// nothing and runs nothing.

const projectId = z.string().regex(/^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

/**
 * The notes share the 64 KiB the instruction files already use in a turn's system context. The
 * notes take at most this much, header and list marks included, and the instruction files keep
 * the rest, which is never less than 48 KiB.
 */
export const PROJECT_NOTES_BYTES = 16 * 1024;
/** The most characters one note holds. A note is a fact, so it stays short. */
export const PROJECT_NOTE_CHARACTERS = 1000;
/** The most notes one project holds, whatever their size. */
export const PROJECT_NOTES_MAX = 200;
/** The line above the list in a turn's context. */
export const PROJECT_NOTES_HEADER = 'Project notes:';

export const ProjectNoteIdSchema = z.string().regex(/^not_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

/**
 * Note text is one to 1,000 characters of well-formed Unicode. Line feeds are the only control
 * characters, so a note renders as one list item whatever it holds.
 */
export const ProjectNoteTextSchema = z
  .string()
  .min(1)
  .max(PROJECT_NOTE_CHARACTERS)
  .refine(
    (value) => value.isWellFormed() && !/[\p{Cc}]/u.test(value.replaceAll('\n', '')),
    'A note needs valid Unicode without control characters other than line feeds.',
  )
  .refine((value) => value.trim() === value, 'A note starts and ends with text, not blank space.');

/**
 * What a client sends: Windows line ends become line feeds, tabs become spaces, other control
 * characters go and the ends are trimmed.
 */
export const normalizeNoteText = (text: string): string =>
  text
    .toWellFormed()
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\t', ' ')
    .replace(/[^\P{Cc}\n]/gu, '')
    .trim();

export const ProjectNoteSchema = z.strictObject({
  id: ProjectNoteIdSchema,
  text: ProjectNoteTextSchema,
  createdAt: z.iso.datetime(),
});
export type ProjectNote = z.infer<typeof ProjectNoteSchema>;

export const ProjectNotesReadSchema = z.strictObject({
  projectId,
  projectName: z.string().min(1).max(200),
  /** Oldest first. Notes made in the same millisecond order by id. */
  notes: z.array(ProjectNoteSchema).max(PROJECT_NOTES_MAX),
  /** The size the notes take in a turn's context, header included. */
  bytes: z.number().int().nonnegative().max(PROJECT_NOTES_BYTES),
  capBytes: z.literal(PROJECT_NOTES_BYTES),
});
export type ProjectNotesRead = z.infer<typeof ProjectNotesReadSchema>;

export const ReadProjectNotesPayloadSchema = z.strictObject({ projectId });
export const AddProjectNotePayloadSchema = z.strictObject({
  projectId,
  text: ProjectNoteTextSchema,
});
export const EditProjectNotePayloadSchema = z.strictObject({
  projectId,
  noteId: ProjectNoteIdSchema,
  text: ProjectNoteTextSchema,
});
export const RemoveProjectNotePayloadSchema = z.strictObject({
  projectId,
  noteId: ProjectNoteIdSchema,
});

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;

/** One note as a list item. Later lines of a note line up under its first. */
export const renderProjectNote = (text: string): string => `- ${text.replaceAll('\n', '\n  ')}`;

/** The section a turn's context carries, or an empty string for a project with no notes. */
export const renderProjectNotes = (texts: readonly string[]): string =>
  texts.length === 0 ? '' : `${PROJECT_NOTES_HEADER}\n\n${texts.map(renderProjectNote).join('\n')}`;

/** Bytes the section takes in a turn's context. Zero for no notes. */
export const projectNotesBytes = (texts: readonly string[]): number =>
  byteLength(renderProjectNotes(texts));

export type NotesFit = { fits: true; bytes: number } | { fits: false; reason: 'count' | 'size' };

/** Whether this list of notes stays inside both limits. The controller checks it before it saves. */
export function projectNotesFit(texts: readonly string[]): NotesFit {
  if (texts.length > PROJECT_NOTES_MAX) return { fits: false, reason: 'count' };
  const bytes = projectNotesBytes(texts);
  return bytes > PROJECT_NOTES_BYTES ? { fits: false, reason: 'size' } : { fits: true, bytes };
}

/** The file Settings exports: one section per note, oldest first, with the day it was saved. */
export function projectNotesMarkdown(
  projectName: string,
  notes: readonly Pick<ProjectNote, 'text' | 'createdAt'>[],
): string {
  const title = `# Notes for ${projectName.replaceAll(/\s+/g, ' ').trim()}`;
  if (notes.length === 0) return `${title}\n\nThis project has no notes.\n`;
  return `${[title, ...notes.map((note) => `## ${note.createdAt}\n\n${note.text}`)].join('\n\n')}\n`;
}

/** The text "Save as note" offers for a reply: its selected text, or else its first paragraph. */
export function noteFromReply(reply: string, selected?: string): string {
  const pick =
    (selected ?? '').trim() || (reply.split(/\n[ \t]*\n/).find((part) => part.trim()) ?? '');
  const text = normalizeNoteText(pick);
  return text.length > PROJECT_NOTE_CHARACTERS
    ? normalizeNoteText(text.slice(0, PROJECT_NOTE_CHARACTERS))
    : text;
}
