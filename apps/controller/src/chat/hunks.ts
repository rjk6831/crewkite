import { createHash } from 'node:crypto';

/** One line of a line diff. `line` keeps its newline, so a file rebuilt from ops keeps its bytes. */
export type Op = { op: ' ' | '-' | '+'; line: string };

/** One `@@` block: ops `start` to `stop` and the line ranges its header names. */
export type HunkRange = {
  key: string;
  start: number;
  stop: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
};

const MAXIMUM_LINES = 50_000;
const MAXIMUM_EDITS = 2_000;
const CONTEXT = 3;

/** Text as UTF-8, with any byte order mark kept. Null for binary or invalid UTF-8. */
export function decodeText(content: Buffer): string | null {
  if (content.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    return null;
  }
}

/** Lines with their newline. The last one has none when the text does not end in a newline. */
export function textLines(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    const end = text.indexOf('\n', at);
    if (end < 0) {
      out.push(text.slice(at));
      break;
    }
    out.push(text.slice(at, end + 1));
    at = end + 1;
  }
  return out;
}

/** Shortest edit script (Myers). Falls back to replace-all when the files barely match. */
export function lineDiff(a: readonly string[], b: readonly string[]): Op[] {
  const replaceAll = (): Op[] => [
    ...a.map((line) => ({ op: '-' as const, line })),
    ...b.map((line) => ({ op: '+' as const, line })),
  ];
  const max = a.length + b.length;
  if (max > MAXIMUM_LINES) return replaceAll();
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAXIMUM_EDITS) && found < 0; d++) {
    // Keep only the diagonals step d reads, so memory grows with d squared.
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
      let x = down ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= a.length && y >= b.length) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return replaceAll();
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = found; d > 0; d--) {
    const previous = trace[d];
    const at = (k: number) => previous[k + d];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const priorK = down ? k + 1 : k - 1;
    const priorX = at(priorK);
    const priorY = priorX - priorK;
    while (x > priorX && y > priorY) {
      x--;
      y--;
      ops.push({ op: ' ', line: a[x] });
    }
    if (down) ops.push({ op: '+', line: b[--y] });
    else ops.push({ op: '-', line: a[--x] });
  }
  while (x > 0) ops.push({ op: ' ', line: a[--x] });
  return ops.reverse();
}

/**
 * The hunks of a diff with three lines of context, as `diff -u` groups them. A hunk's key hashes
 * its base start line and its lines, so it names the same hunk until the base or the hunk changes.
 */
export function hunkRanges(ops: readonly Op[]): HunkRange[] {
  const oldLine: number[] = [];
  const newLine: number[] = [];
  let o = 1;
  let n = 1;
  for (const { op } of ops) {
    oldLine.push(o);
    newLine.push(n);
    if (op !== '+') o++;
    if (op !== '-') n++;
  }
  const out: HunkRange[] = [];
  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index].op === ' ') index++;
    if (index === ops.length) break;
    let last = index;
    let cursor = index;
    while (cursor < ops.length) {
      if (ops[cursor].op !== ' ') {
        last = cursor++;
        continue;
      }
      let run = cursor;
      while (run < ops.length && ops[run].op === ' ') run++;
      if (run === ops.length || run - cursor > 2 * CONTEXT) break;
      cursor = run;
    }
    const start = Math.max(0, index - CONTEXT);
    const stop = Math.min(ops.length, last + CONTEXT + 1);
    const slice = ops.slice(start, stop);
    const oldLines = slice.filter((value) => value.op !== '+').length;
    const newLines = slice.filter((value) => value.op !== '-').length;
    const oldStart = oldLines ? oldLine[start] : oldLine[start] - 1;
    const newStart = newLines ? newLine[start] : newLine[start] - 1;
    const key = createHash('sha256')
      .update(JSON.stringify([oldStart, slice.map((value) => value.op + value.line)]))
      .digest('hex');
    out.push({ key, start, stop, oldStart, oldLines, newStart, newLines });
    index = stop;
  }
  return out;
}

/** The `@@` header and lines of one hunk, each without its newline. */
export function hunkText(ops: readonly Op[], hunk: HunkRange): string[] {
  const out = [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`];
  for (const value of ops.slice(hunk.start, hunk.stop)) {
    const bare = value.line.endsWith('\n') ? value.line.slice(0, -1) : value.line;
    out.push(`${value.op}${bare}`);
    if (!value.line.endsWith('\n')) out.push('\\ No newline at end of file');
  }
  return out;
}

/** A unified patch with one `@@` block per hunk. */
export function renderPatch(
  path: string,
  sides: { old: boolean; next: boolean },
  ops: readonly Op[],
  hunks: readonly HunkRange[],
): string {
  const header = [
    `--- ${sides.old ? `a/${path}` : '/dev/null'}`,
    `+++ ${sides.next ? `b/${path}` : '/dev/null'}`,
  ];
  return `${[...header, ...hunks.flatMap((hunk) => hunkText(ops, hunk))].join('\n')}\n`;
}

/**
 * The file with the hunks in `applied` taken from the copy and every other hunk as the base has
 * it. With every hunk applied it is the copy, with none it is the base.
 */
export function composeHunks(
  ops: readonly Op[],
  hunks: readonly HunkRange[],
  applied: ReadonlySet<number>,
): string {
  const owner = new Int32Array(ops.length).fill(-1);
  hunks.forEach((hunk, index) => {
    owner.fill(index, hunk.start, hunk.stop);
  });
  let out = '';
  ops.forEach((value, index) => {
    if (value.op === ' ') out += value.line;
    else if ((value.op === '+') === applied.has(owner[index])) out += value.line;
  });
  return out;
}
