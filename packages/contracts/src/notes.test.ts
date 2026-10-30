import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AddProjectNotePayloadSchema,
  normalizeNoteText,
  noteFromReply,
  PROJECT_NOTE_CHARACTERS,
  PROJECT_NOTES_BYTES,
  PROJECT_NOTES_HEADER,
  PROJECT_NOTES_MAX,
  projectNotesBytes,
  projectNotesFit,
  projectNotesMarkdown,
  renderProjectNotes,
} from './notes.ts';

const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV';

// The header and its blank line take 16 bytes. Each note then adds "- " and a newline between
// notes, so two notes cost 5 bytes beyond their text. The table pins the edges of the cap with
// exact sizes. The 1,000 character limit per note belongs to the payload schema, not to the fit.
const headerBytes = PROJECT_NOTES_HEADER.length + 2;
const twoNoteMarks = 5;

test('a project holds at most 16 KiB of rendered notes and 200 notes', () => {
  const ascii = (length: number) => 'a'.repeat(length);
  const second = PROJECT_NOTES_BYTES - headerBytes - twoNoteMarks - 1000;
  const table: { name: string; texts: string[]; fits: boolean; reason?: 'count' | 'size' }[] = [
    { name: 'no notes', texts: [], fits: true },
    { name: 'one short note', texts: ['Use pnpm.'], fits: true },
    {
      name: 'sixteen full notes use the room except the marks',
      texts: Array.from({ length: 16 }, () => ascii(PROJECT_NOTE_CHARACTERS)),
      fits: true,
    },
    {
      name: 'one more full note is over the cap',
      texts: Array.from({ length: 17 }, () => ascii(PROJECT_NOTE_CHARACTERS)),
      fits: false,
      reason: 'size',
    },
    {
      name: 'exactly the cap',
      texts: [ascii(1000), ascii(second)],
      fits: true,
    },
    {
      name: 'cap plus one byte',
      texts: [ascii(1000), ascii(second + 1)],
      fits: false,
      reason: 'size',
    },
    {
      name: 'multibyte text counts bytes',
      texts: Array.from({ length: 6 }, () => '€'.repeat(PROJECT_NOTE_CHARACTERS)),
      fits: false,
      reason: 'size',
    },
    {
      name: 'a note with line feeds counts its indent',
      texts: [`${ascii(10)}\n${ascii(10)}`],
      fits: true,
    },
    {
      name: 'the count limit holds with tiny notes',
      texts: Array.from({ length: PROJECT_NOTES_MAX + 1 }, () => 'x'),
      fits: false,
      reason: 'count',
    },
    {
      name: 'the count limit allows 200 tiny notes',
      texts: Array.from({ length: PROJECT_NOTES_MAX }, () => 'x'),
      fits: true,
    },
  ];
  for (const row of table) {
    const fit = projectNotesFit(row.texts);
    assert.equal(fit.fits, row.fits, row.name);
    if (!fit.fits) assert.equal(fit.reason, row.reason, row.name);
    if (fit.fits) assert.equal(fit.bytes, projectNotesBytes(row.texts), row.name);
  }
  assert.equal(projectNotesBytes([ascii(1000), ascii(second)]), PROJECT_NOTES_BYTES);
});

test('notes render as one list under a header, in the order given', () => {
  assert.equal(renderProjectNotes([]), '');
  assert.equal(
    renderProjectNotes(['First.', 'Second\nline two']),
    'Project notes:\n\n- First.\n- Second\n  line two',
  );
});

test('note text is bounded, well formed and free of control characters', () => {
  const table: { name: string; text: string; ok: boolean }[] = [
    { name: 'plain', text: 'Deploys go through CI.', ok: true },
    { name: 'line feed', text: 'a\nb', ok: true },
    { name: 'empty', text: '', ok: false },
    { name: 'blank edges', text: ' a', ok: false },
    { name: 'tab', text: 'a\tb', ok: false },
    { name: 'carriage return', text: 'a\r\nb', ok: false },
    { name: 'escape', text: 'a\u001bb', ok: false },
    { name: 'lone surrogate', text: 'a\ud800', ok: false },
    { name: 'at the limit', text: 'a'.repeat(PROJECT_NOTE_CHARACTERS), ok: true },
    { name: 'over the limit', text: 'a'.repeat(PROJECT_NOTE_CHARACTERS + 1), ok: false },
  ];
  for (const row of table)
    assert.equal(
      AddProjectNotePayloadSchema.safeParse({ projectId, text: row.text }).success,
      row.ok,
      row.name,
    );
  assert.equal(normalizeNoteText('  a\r\nb\tc\u001b \n'), 'a\nb c');
  assert.equal(
    AddProjectNotePayloadSchema.safeParse({ projectId, text: 'x', extra: 1 }).success,
    false,
  );
});

test('Save as note offers the selection, else the first paragraph, within the limit', () => {
  const reply = 'First paragraph\nstill first.\n\nSecond paragraph.';
  assert.equal(noteFromReply(reply), 'First paragraph\nstill first.');
  assert.equal(noteFromReply(reply, 'Second paragraph.'), 'Second paragraph.');
  assert.equal(noteFromReply(reply, '   '), 'First paragraph\nstill first.');
  assert.equal(noteFromReply('\n\n  \n\nlate start'), 'late start');
  assert.equal(noteFromReply(''), '');
  assert.equal(noteFromReply('a'.repeat(1500)).length, PROJECT_NOTE_CHARACTERS);
  assert.equal(
    AddProjectNotePayloadSchema.safeParse({ projectId, text: noteFromReply('a\tb ') }).success,
    true,
  );
});

test('the Markdown export lists each note with its time, oldest first', () => {
  assert.equal(
    projectNotesMarkdown('demo', []),
    '# Notes for demo\n\nThis project has no notes.\n',
  );
  assert.equal(
    projectNotesMarkdown('demo  shop', [
      { text: 'Use pnpm.', createdAt: '2026-10-31T10:00:00.000Z' },
      { text: 'Two\nlines.', createdAt: '2026-11-01T10:00:00.000Z' },
    ]),
    '# Notes for demo shop\n\n## 2026-10-31T10:00:00.000Z\n\nUse pnpm.\n\n## 2026-11-01T10:00:00.000Z\n\nTwo\nlines.\n',
  );
});
