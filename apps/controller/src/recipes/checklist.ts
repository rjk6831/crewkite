import { realpathSync } from 'node:fs';
import { git } from '../host/source.ts';

// The next item of a markdown checklist a recipe works through. The file is read from the
// project's committed HEAD, the base a run's copy starts from, so the item a run is given is in
// its copy to tick. Item text comes from a repository file. These functions return it and never
// act on it.

export type ChecklistItem =
  | { kind: 'item'; text: string }
  | { kind: 'held' }
  | { kind: 'done' }
  | { kind: 'unreadable' };

const MAX_BYTES = 256 * 1024;
const MAX_ITEM = 500;
// The s flag lets the text hold a line separator character, which `.` would refuse.
const BOX = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[( |x|X)\](?:[ \t]+(.*))?$/s;
// What may stand before a comment that hides the lines after it: quote and list markers only.
// A list marker needs a space after it, or the line is a paragraph and the opener is text.
const MARKERS = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*$/;
// A fence may open on a list item's own line, after its marker.
const FENCE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})/;

/**
 * The first unchecked item of the checklist at `path` whose text no run holds, in file order.
 * Lines inside a fenced block or an HTML comment are no items. A comment that closes on its own
 * line is dropped from it, and an item's text ends where a comment that stays open begins. A
 * comment marker inside a code span is text.
 * Unreadable covers a path that is not a file at HEAD, a link, a file over 256 KiB, text that is
 * not UTF-8 or holds a NUL, a project with no commit, a project folder that is not its
 * repository's top level, and a fence or a comment that never closes: such a file may hide items,
 * so it never reads as done. The size is read from the tree before any content is, and nothing on
 * disk is followed.
 */
export function nextChecklistItem(
  directory: string,
  path: string,
  taken: ReadonlySet<string>,
): ChecklistItem {
  const bytes = readAtHead(directory, path);
  if (!bytes) return { kind: 'unreadable' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'unreadable' };
  }
  if (text.includes('\0')) return { kind: 'unreadable' };
  let open: string | null = null;
  let comment = false;
  let unchecked = 0;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if (comment) {
      if (raw.includes('-->')) comment = false;
      continue;
    }
    const fence = FENCE.exec(raw)?.[1];
    if (open) {
      if (fence?.[0] === open[0] && fence.length >= open.length && raw.trim() === fence)
        open = null;
      continue;
    }
    if (fence) {
      open = fence;
      continue;
    }
    // A comment that closes on its line goes, wherever it stands, and the line is read up to one
    // that stays open. Such a comment hides the lines to its close only when nothing but markers
    // stands before it. After text the next list item ends the paragraph, so the opener is text.
    const { text: line, open: left } = visible(raw);
    if (left && MARKERS.test(line)) comment = true;
    const match = BOX.exec(line);
    if (match?.[1] !== ' ') continue;
    const item = itemText(match[2] ?? '');
    if (!item) continue;
    unchecked += 1;
    if (!taken.has(item)) return { kind: 'item', text: item };
  }
  // A block still open at the end hides what follows it, so the file cannot say it is done.
  if (open || comment) return { kind: 'unreadable' };
  return { kind: unchecked ? 'held' : 'done' };
}

/**
 * A line with its closed comments dropped, cut where a comment that stays open begins. A comment
 * marker inside a code span is text, and a code span inside a comment is part of the comment:
 * whichever opens first wins.
 */
function visible(raw: string): { text: string; open: boolean } {
  let text = '';
  let at = 0;
  for (;;) {
    const comment = raw.indexOf('<!--', at);
    const tick = raw.indexOf('`', at);
    if (comment < 0 && tick < 0) return { text: text + raw.slice(at), open: false };
    if (tick >= 0 && (comment < 0 || tick < comment)) {
      let run = tick;
      while (raw[run] === '`') run += 1;
      const close = closingRun(raw, run, run - tick);
      // A run with no match is plain backticks. A span is kept whole, markers and all.
      const next = close < 0 ? run : close + (run - tick);
      text += raw.slice(at, next);
      at = next;
      continue;
    }
    text += raw.slice(at, comment);
    const end = raw.indexOf('-->', comment + 4);
    if (end < 0) return { text, open: true };
    at = end + 3;
  }
}

/** Where a run of exactly `length` backticks starts, at or after `from`. */
function closingRun(raw: string, from: number, length: number): number {
  let at = raw.indexOf('`', from);
  while (at >= 0) {
    let end = at;
    while (raw[end] === '`') end += 1;
    if (end - at === length) return at;
    at = raw.indexOf('`', end);
  }
  return -1;
}

/** The first message of a checklist run. The item sits in a fixed frame as plain text. */
export function checklistRequest(path: string, text: string): string {
  return `Do this item from ${path}:\n\n${text}\n\nTick it in ${path} as part of the change.`;
}

/**
 * Format characters such as zero-width spaces and bidi controls go, control characters become
 * spaces, runs of spaces one, and the text is cut at 500 characters.
 */
function itemText(rest: string): string {
  const spaced = rest
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  let cut = spaced.slice(0, MAX_ITEM);
  // A cut between the halves of a surrogate pair would leave text the contract refuses.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trim();
}

/** The committed bytes of a regular file at HEAD, or null for anything else. */
function readAtHead(directory: string, path: string): Buffer | null {
  try {
    // A folder inside another repository would read that repository's files.
    const top = git(directory, ['rev-parse', '--show-toplevel'])
      .toString('utf8')
      .replace(/\n$/, '');
    if (realpathSync(top) !== realpathSync(directory)) return null;
    const listed = git(directory, [
      '--literal-pathspecs',
      'ls-tree',
      '-z',
      '-l',
      'HEAD',
      '--',
      path,
    ]).toString('utf8');
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64}) +(\d+)\t(.+)$/s.exec(
      listed.split('\0')[0] ?? '',
    );
    if (!match || match[4] !== path || Number(match[3]) > MAX_BYTES) return null;
    return git(directory, ['cat-file', 'blob', match[2]]);
  } catch {
    return null;
  }
}
