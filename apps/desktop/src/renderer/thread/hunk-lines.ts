import type { ChatHunk } from '@crewkite/contracts';

/** One patch line with its base and copy line numbers. A removed line has no copy number. */
export type HunkLine = { text: string; old: number | null; next: number | null };

/** The `@@` blocks of a patch, in order, each line with its base and copy line numbers. */
export function patchBlocks(patch: string, hunks: readonly ChatHunk[]): HunkLine[][] {
  const blocks: HunkLine[][] = [];
  let old = 0;
  let next = 0;
  for (const text of patch.split('\n')) {
    if (text.startsWith('@@')) {
      const hunk = hunks[blocks.length];
      old = hunk?.oldStart ?? 0;
      next = hunk?.newStart ?? 0;
      blocks.push([]);
      continue;
    }
    const block = blocks.at(-1);
    if (!block || text === '') continue;
    const mark = text[0];
    if (mark === '\\') {
      block.push({ text, old: null, next: null });
      continue;
    }
    block.push({
      text,
      old: mark === '+' ? null : old++,
      next: mark === '-' ? null : next++,
    });
  }
  return blocks;
}

/**
 * The lines a comment names: the copy side when the pick holds a context or added line, else the
 * base side. Null for a pick with no numbered line.
 */
export function pickedRange(lines: readonly HunkLine[], from: number, to: number) {
  const picked = lines.slice(Math.min(from, to), Math.max(from, to) + 1);
  const copy = picked.flatMap((line) => (line.next === null ? [] : [line.next]));
  const base = picked.flatMap((line) => (line.old === null ? [] : [line.old]));
  const numbers = copy.length ? copy : base;
  if (!numbers.length) return null;
  return {
    side: copy.length ? ('new' as const) : ('old' as const),
    start: Math.min(...numbers),
    end: Math.max(...numbers),
  };
}
