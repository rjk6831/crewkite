import type { ChatSearchHit } from '@crewkite/contracts';
import type { ThreadItem } from './thread-state.ts';

// Where a search hit lands in an open thread, and which stretches of that row to mark. Pure, so the
// rules are tested without a DOM. The DOM half is in reveal-dom.ts.

/** A search result the person chose. `nonce` lets the same result be chosen again. */
export type HistoryFind = { taskId: string; hit: ChatSearchHit; query: string; nonce: number };

/** The words the controller's index can match. The view marks the same ones. */
export const MIN_TERM_CHARACTERS = 3;

export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const word of query.split(/\s+/))
    if ([...word].length >= MIN_TERM_CHARACTERS) seen.add(word);
  return [...seen];
}

/**
 * A result's snippet as plain and marked stretches. The offsets come from the controller, in code
 * units, and the view never renders the snippet as markup. Offsets outside the snippet, or that
 * overlap, are clamped.
 */
export function snippetParts(
  hit: Pick<ChatSearchHit, 'snippet' | 'marks'>,
): { text: string; marked: boolean }[] {
  const parts: { text: string; marked: boolean }[] = [];
  let at = 0;
  for (const mark of hit.marks) {
    const start = Math.max(at, Math.min(mark.start, hit.snippet.length));
    const end = Math.max(start, Math.min(mark.end, hit.snippet.length));
    if (start > at) parts.push({ text: hit.snippet.slice(at, start), marked: false });
    if (end > start) parts.push({ text: hit.snippet.slice(start, end), marked: true });
    at = end;
  }
  if (at < hit.snippet.length) parts.push({ text: hit.snippet.slice(at), marked: false });
  return parts;
}

/**
 * The key of the row that holds the match. A message hit lands on the person's own bubble when
 * the thread has it, and on the turn row otherwise. A tool or path hit lands on its turn row. A
 * turn with no row yet, such as one with no reply whose cards are not read, falls back to the
 * message that started it. A title has no row.
 */
export function revealKey(
  hit: Pick<ChatSearchHit, 'kind' | 'turnId' | 'messageId'>,
  items: readonly ThreadItem[],
): string | null {
  if (hit.kind === 'title') return null;
  const keys = new Set(items.map((item) => item.key));
  if (hit.kind === 'message' && hit.messageId && keys.has(hit.messageId)) return hit.messageId;
  if (hit.turnId && keys.has(`turn:${hit.turnId}`)) return `turn:${hit.turnId}`;
  if (hit.messageId && keys.has(hit.messageId)) return hit.messageId;
  return null;
}

/**
 * Text folded the way the index folds it: case and accents gone. Each folded unit maps to where
 * its character starts in the original, and the last entry is the original's length, so a match in
 * the folded text gives its stretch of the original.
 */
function fold(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let index = 0; index < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const piece = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let unit = 0; unit < piece.length; unit++) map.push(index);
    folded += piece;
    index += char.length;
  }
  map.push(text.length);
  return { folded, map };
}

/** Every stretch of `text` that holds a term, in order, with overlapping stretches joined. */
export function findMarks(
  text: string,
  terms: readonly string[],
): { start: number; end: number }[] {
  const { folded, map } = fold(text);
  const found: { start: number; end: number }[] = [];
  for (const term of terms) {
    const needle = fold(term).folded;
    if (needle === '') continue;
    for (
      let at = folded.indexOf(needle);
      at !== -1;
      at = folded.indexOf(needle, at + needle.length)
    )
      found.push({ start: map[at], end: map[at + needle.length] });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const joined: { start: number; end: number }[] = [];
  for (const mark of found) {
    const last = joined.at(-1);
    if (last && mark.start <= last.end) last.end = Math.max(last.end, mark.end);
    else joined.push({ ...mark });
  }
  return joined;
}
