import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
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

export type DiscardOutcome =
  | { done: 'restored' | 'removed' | 'recovered' }
  | { refused: 'link-path' | 'skipped-path' | 'outside-copy' | 'path-blocked' | 'not-changed' };

const pathKey = (path: string) => path.normalize('NFC').toLowerCase();

/**
 * Put one path of the scratch copy back the way the base has it. A changed file gets the base bytes
 * and mode, a file the copy added is removed, and a file the copy deleted comes back. Links and
 * entries the copy never held stay as they are, because Accept always takes them from the base.
 */
export function discardScratchPath(
  repository: string,
  scratch: string,
  base: string,
  path: string,
): DiscardOutcome {
  const source = committedFiles(repository, base, { scratch: true });
  // A case-insensitive volume reaches a held entry under any spelling.
  const wanted = pathKey(path);
  const covers = (held: string) =>
    wanted === pathKey(held) || wanted.startsWith(`${pathKey(held)}/`);
  if (source.links.some((link) => covers(link.path))) return { refused: 'link-path' };
  if (source.skipped.some((entry) => covers(entry.path))) return { refused: 'skipped-path' };
  const root = realpathSync.native(scratch);
  const target = resolve(root, path);
  if (!target.startsWith(`${root}${sep}`)) return { refused: 'outside-copy' };
  const parts = path.split('/');
  // Every write below goes through real directories only. A link the copy added on the way could
  // send it anywhere.
  for (let end = 1; end < parts.length; end++) {
    const state = lstatSync(join(root, ...parts.slice(0, end)), { throwIfNoEntry: false });
    if (!state) break;
    if (state.isSymbolicLink()) {
      const resolved = realpathSync.native(join(root, ...parts.slice(0, end)));
      return resolved === root || resolved.startsWith(`${root}${sep}`)
        ? { refused: 'link-path' }
        : { refused: 'outside-copy' };
    }
    if (!state.isDirectory()) return { refused: 'path-blocked' };
  }
  const state = lstatSync(target, { throwIfNoEntry: false });
  if (state?.isSymbolicLink()) return { refused: 'link-path' };
  if (state && (!state.isFile() || !readdirSync(dirname(target)).includes(basename(target))))
    return { refused: 'path-blocked' };
  const original = source.files.find((file) => file.path === path);
  if (!original) {
    if (source.files.some((file) => pathKey(file.path) === wanted))
      return { refused: 'path-blocked' };
    if (!state) return { refused: 'not-changed' };
    unlinkSync(target);
    prune(root, dirname(target));
    return { done: 'removed' };
  }
  if (state && sameFile(target, original)) return { refused: 'not-changed' };
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // A rename replaces the directory entry, so a hard link the copy made to another file keeps its
  // bytes.
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}`);
  const mode = original.mode === '100755' ? 0o755 : 0o644;
  try {
    writeFileSync(temporary, original.content, { flag: 'wx', mode });
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { done: state ? 'restored' : 'recovered' };
}

function sameFile(file: string, original: FileContent) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const state = fstatSync(fd);
    const bytes = readFileSync(fd);
    return (
      (state.mode & 0o111 ? '100755' : '100644') === original.mode &&
      createHash('sha256').update(bytes).digest('hex') === original.hash
    );
  } finally {
    closeSync(fd);
  }
}

// A fresh copy has a directory only where a file or link sits under it, so an emptied one goes too.
function prune(root: string, directory: string) {
  for (let at = directory; at !== root && at.startsWith(`${root}${sep}`); at = dirname(at)) {
    if (readdirSync(at).length) return;
    rmdirSync(at);
  }
}

/** Keeps a thread's base commit reachable after its accepted branch is deleted and git collects. */
export function threadBaseRef(taskId: string) {
  if (!/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(taskId))
    throw new Error('Invalid thread identity.');
  return `refs/crewkite/threads/${taskId}`;
}

function refCommit(repository: string, ref: string): string | null {
  try {
    return git(repository, ['rev-parse', '--verify', '--quiet', ref]).toString('utf8').trim();
  } catch (error) {
    if ((error as { status?: number }).status === 1) return null;
    throw error;
  }
}

/**
 * Point the thread's ref at its current base. The old value goes to update-ref, so a concurrent
 * writer makes this fail. No working tree, index, HEAD or branch changes.
 */
export function writeThreadBaseRef(repository: string, taskId: string, base: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw new Error('Invalid base commit.');
  const ref = threadBaseRef(taskId);
  const current = refCommit(repository, ref);
  if (current === base) return;
  git(repository, ['update-ref', '--no-deref', ref, base, current ?? '0'.repeat(base.length)]);
}

/** Remove the thread's base ref when the thread goes. A missing ref is already gone. */
export function deleteThreadBaseRef(repository: string, taskId: string) {
  const ref = threadBaseRef(taskId);
  const current = refCommit(repository, ref);
  if (current === null) return;
  git(repository, ['update-ref', '--no-deref', '-d', ref, current]);
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
