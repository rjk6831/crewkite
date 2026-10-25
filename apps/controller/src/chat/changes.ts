import type { ChatChangesRead } from '@crewkite/contracts';
import { committedFiles, type FileContent, git, readCandidateFiles } from '../host/source.ts';

type FileDiff = ChatChangesRead['files'][number];
type Op = { op: ' ' | '-' | '+'; line: string };

const PATCH_CHARACTERS = 262_144;
// Counts always return. Patches stop here so one read stays well under the frame limit.
const TOTAL_PATCH_BYTES = 655_360;
const MAXIMUM_LINES = 50_000;
const MAXIMUM_EDITS = 2_000;
const CONTEXT = 3;

/** Compare the scratch copy with the committed base. One entry per changed path, sorted. */
export function scratchChanges(
  repository: string,
  scratch: string,
  base: string,
  patches = true,
): FileDiff[] {
  const source = committedFiles(repository, base, { scratch: true });
  const before = byPath(source.files);
  // Committed ignore rules keep generated files such as installed packages out of the diff. Links
  // and skipped entries always come from the base, so they never show as changes.
  const after = byPath(readCandidateFiles(scratch, repository, base, source));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files: FileDiff[] = [];
  let budget = patches ? TOTAL_PATCH_BYTES : 0;
  for (const path of paths) {
    const old = before.get(path);
    const next = after.get(path);
    if (old && next && old.hash === next.hash && old.mode === next.mode) continue;
    // shortcut: the read shape holds 2000 files. Upgrade: page changes when a thread needs more.
    if (files.length === 2000) break;
    const diff = fileDiff(path, old, next);
    const bytes = diff.patch === null ? 0 : Buffer.byteLength(diff.patch);
    const keep = diff.patch !== null && diff.patch.length <= PATCH_CHARACTERS && bytes <= budget;
    if (keep) budget -= bytes;
    files.push({ ...diff, patch: keep ? diff.patch : null });
  }
  return files;
}

function byPath(files: FileContent[]) {
  return new Map(files.map((file) => [file.path, file]));
}

function fileDiff(path: string, old?: FileContent, next?: FileContent): FileDiff {
  const before = old ? decode(old.content) : '';
  const after = next ? decode(next.content) : '';
  if (before === null || after === null) return { path, additions: 0, deletions: 0, patch: null };
  const ops = lineDiff(lines(before), lines(after));
  const header = [
    `--- ${old ? `a/${path}` : '/dev/null'}`,
    `+++ ${next ? `b/${path}` : '/dev/null'}`,
  ];
  return {
    path,
    additions: ops.filter((op) => op.op === '+').length,
    deletions: ops.filter((op) => op.op === '-').length,
    patch: `${[...header, ...hunks(ops)].join('\n')}\n`,
  };
}

function decode(content: Buffer): string | null {
  if (content.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function lines(text: string): string[] {
  const split = text.split('\n');
  if (split.at(-1) === '') split.pop();
  return split;
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

function hunks(ops: readonly Op[]): string[] {
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
  const out: string[] = [];
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
    const oldCount = slice.filter((value) => value.op !== '+').length;
    const newCount = slice.filter((value) => value.op !== '-').length;
    const oldStart = oldCount ? oldLine[start] : oldLine[start] - 1;
    const newStart = newCount ? newLine[start] : newLine[start] - 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const value of slice) out.push(`${value.op}${value.line}`);
    index = stop;
  }
  return out;
}

/**
 * Remove the ref that keeps the thread's base commit. A missing ref is already gone.
 * shortcut: a stand-in with the signature the per-file discard work exports. Upgrade: keep that
 * version when the two meet.
 */
export function deleteThreadBaseRef(repository: string, taskId: string) {
  const ref = `refs/crewkite/threads/${taskId}`;
  let current: string;
  try {
    current = git(repository, ['rev-parse', '--verify', '--quiet', ref]).toString('utf8').trim();
  } catch {
    return;
  }
  git(repository, ['update-ref', '--no-deref', '-d', ref, current]);
}
