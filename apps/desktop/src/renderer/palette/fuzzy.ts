// Fuzzy matching for the command palette. Every word of the query must appear in the text in
// order, not necessarily next to each other. A match that starts a word, or continues the one
// before it, scores higher, so "set" finds "Settings" before "Pick a model, set".

export type FuzzyMatch = {
  score: number;
  /** UTF-16 offsets of the matched characters in the text, for highlighting. */
  indexes: number[];
};

const SEPARATOR = /[\s\-_/:.,()]/u;
const LONGEST_TEXT = 120;

function matchWord(word: string, text: string): FuzzyMatch | null {
  const wanted = Array.from(word, (character) => character.toLowerCase());
  const letters = Array.from(text).slice(0, LONGEST_TEXT);
  if (wanted.length > letters.length) return null;
  const folded = letters.map((character) => character.toLowerCase());
  // Offsets of each code point in the original text.
  const offsets: number[] = [];
  let offset = 0;
  for (const character of letters) {
    offsets.push(offset);
    offset += character.length;
  }
  const bonus = (at: number) => {
    if (at === 0) return 12;
    const before = letters[at - 1];
    if (SEPARATOR.test(before)) return 10;
    // A capital after a lower case letter starts a word in CamelCase text.
    return before !== before.toUpperCase() && letters[at] !== letters[at].toLowerCase() ? 8 : 1;
  };
  // best[i][j]: the top score with word letter i matched at text position j.
  const best: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < wanted.length; i++) {
    best.push(new Array(letters.length).fill(Number.NEGATIVE_INFINITY));
    from.push(new Array(letters.length).fill(-1));
    for (let j = i; j < letters.length; j++) {
      if (folded[j] !== wanted[i]) continue;
      if (i === 0) {
        best[i][j] = bonus(j) - j * 0.1;
        continue;
      }
      for (let k = i - 1; k < j; k++) {
        if (best[i - 1][k] === Number.NEGATIVE_INFINITY) continue;
        const joined = k === j - 1 ? 8 : -Math.min(j - k - 1, 4) * 0.5;
        const score = best[i - 1][k] + bonus(j) + joined;
        if (score > best[i][j]) {
          best[i][j] = score;
          from[i][j] = k;
        }
      }
    }
  }
  const last = wanted.length - 1;
  let end = -1;
  for (let j = 0; j < letters.length; j++)
    if (best[last][j] > (end < 0 ? Number.NEGATIVE_INFINITY : best[last][end])) end = j;
  if (end < 0) return null;
  const indexes: number[] = [];
  for (let i = last, j = end; i >= 0; j = from[i][j], i--) indexes.unshift(offsets[j]);
  // A matched astral character covers two UTF-16 units.
  const spans = indexes.flatMap((start) => {
    const unit = text.codePointAt(start) ?? 0;
    return unit > 0xffff ? [start, start + 1] : [start];
  });
  return { score: best[last][end], indexes: spans };
}

/** The match of a whole query, or null when any word of it is missing from the text. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const words = query.split(/\s+/u).filter(Boolean);
  let score = 0;
  const indexes = new Set<number>();
  for (const word of words) {
    const found = matchWord(word, text);
    if (!found) return null;
    score += found.score;
    for (const index of found.indexes) indexes.add(index);
  }
  return { score, indexes: [...indexes].sort((a, b) => a - b) };
}

/**
 * Commands that match the query, best first, and in their own order among equal scores. The label
 * counts in full. The keywords, such as a slash name and its summary, find a command by what it
 * does, when each typed word appears in them as written. They count for less and mark nothing in
 * the label. An empty query keeps every command.
 */
export function rankCommands<T extends { label: string; keywords?: string }>(
  commands: readonly T[],
  query: string,
): { command: T; match: FuzzyMatch | null }[] {
  const trimmed = query.trim();
  if (!trimmed) return commands.map((command) => ({ command, match: null }));
  type Hit = { command: T; match: FuzzyMatch | null; score: number; order: number };
  const ranked = commands.flatMap((command, order): Hit[] => {
    const label = fuzzyMatch(trimmed, command.label);
    if (label) return [{ command, match: label, score: label.score + 100, order }];
    const text = command.keywords?.toLowerCase();
    const words = trimmed.toLowerCase().split(/\s+/u);
    return text && words.every((word) => text.includes(word))
      ? [{ command, match: null, score: 0, order }]
      : [];
  });
  return ranked
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ command, match }) => ({ command, match }));
}
