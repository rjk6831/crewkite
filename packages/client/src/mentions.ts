// Fuzzy completion for @file and @folder mentions. The desktop and the command line composer both
// rank with this module, so the same query gives the same order in both. It is pure: the caller
// lists candidates and applies the result.

export type MentionCandidate = Readonly<{ path: string; kind: 'file' | 'folder' }>;

const MOST_CANDIDATES = 50;

/** Where an unfinished mention starts and what the person typed after the at sign. */
export type MentionTrigger = Readonly<{ start: number; end: number; query: string }>;

/**
 * The mention being typed at the caret: an at sign at the start of the text or after white space,
 * followed by characters with no white space. Null when the caret is somewhere else.
 */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  if (text[start] !== '@') return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { start, end, query: text.slice(start + 1, caret) };
}

/**
 * The text a mention becomes. It is the path as the provider's tools open it: relative to the copy
 * root, with a trailing slash on a folder. A path with white space or a backtick is wrapped in
 * backticks so it stays one token.
 */
export function mentionText(mention: MentionCandidate): string {
  const path = mention.kind === 'folder' ? `${mention.path.replace(/\/+$/, '')}/` : mention.path;
  return /[\s`]/.test(path) ? `\`${path.replaceAll('`', '')}\`` : path;
}

/** Replace the unfinished mention with the chosen path and a space, and say where the caret goes. */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  mention: MentionCandidate,
): { text: string; caret: number } {
  const inserted = `${mentionText(mention)} `;
  const rest = text.slice(trigger.end).replace(/^ /, '');
  return {
    text: `${text.slice(0, trigger.start)}${inserted}${rest}`,
    caret: trigger.start + inserted.length,
  };
}

// How many characters of `needle` appear in order in `hay`, with the gap between matches. A
// subsequence match scores higher when its characters are close together.
function subsequenceGap(hay: string, needle: string): number | null {
  let at = -1;
  let gap = 0;
  for (const letter of needle) {
    const next = hay.indexOf(letter, at + 1);
    if (next < 0) return null;
    if (at >= 0) gap += next - at - 1;
    at = next;
  }
  return gap;
}

function score(path: string, query: string): number {
  const full = path.toLowerCase();
  const name = full.slice(full.lastIndexOf('/', full.length - 2) + 1).replace(/\/$/, '');
  if (name === query) return 1000;
  if (name.startsWith(query)) return 800;
  if (name.includes(query)) return 600 - name.indexOf(query);
  if (full.includes(query)) return 400 - Math.min(full.indexOf(query), 200) / 2;
  const inName = subsequenceGap(name, query);
  if (inName !== null) return 300 - Math.min(inName, 100);
  const inPath = subsequenceGap(full, query);
  return inPath === null ? 0 : 200 - Math.min(inPath, 100) / 2;
}

const depth = (path: string) => path.split('/').length;

/**
 * Candidates for the query, best first, at most `limit`. An empty query lists the shallowest
 * entries. Matching ignores case. Ties go to the shallower path, then the shorter, then
 * alphabetical order, so the order never depends on the input order.
 */
export function rankMentions<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string,
  limit: number,
): T[] {
  const bound = Math.max(0, Math.min(Math.floor(limit), MOST_CANDIDATES));
  const needle = query.trim().toLowerCase().replace(/^\.\//, '');
  const scored: { item: T; score: number }[] = [];
  for (const item of candidates) {
    const value = needle === '' ? 1 : score(item.path, needle);
    if (value > 0) scored.push({ item, score: value });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      depth(a.item.path) - depth(b.item.path) ||
      a.item.path.length - b.item.path.length ||
      (a.item.path < b.item.path ? -1 : a.item.path > b.item.path ? 1 : 0),
  );
  return scored.slice(0, bound).map(({ item }) => item);
}

/** Folders that hold at least one listed file, so an ignored folder never appears. */
export function foldersOf(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    let slash = path.indexOf('/');
    while (slash > 0) {
      folders.add(path.slice(0, slash));
      slash = path.indexOf('/', slash + 1);
    }
  }
  return [...folders];
}
