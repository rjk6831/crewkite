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
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { ChatChangesRead } from '@crewkite/contracts';
import {
  type CandidateHash,
  type FileContent,
  git,
  hashCandidateFiles,
  type LinkEntry,
  type PlannedFile,
  readPlannedBlobs,
  restoreLink,
  type ScratchPlan,
  scratchPlan,
} from '../host/source.ts';

type FileDiff = ChatChangesRead['files'][number];
type Op = { op: ' ' | '-' | '+'; line: string };

const PATCH_CHARACTERS = 262_144;
// Counts always return. Patches stop here so one read stays well under the frame limit.
const TOTAL_PATCH_BYTES = 655_360;
const MAXIMUM_LINES = 50_000;
const MAXIMUM_EDITS = 2_000;
const CONTEXT = 3;

// The most file bytes one comparison reads for patches. A larger change set still lists every
// path, and the files past this limit say so in place of a patch.
const DIFF_READ_BYTES = 64 * 1024 * 1024;

/** The paths whose bytes or mode differ from the base, sorted. Links the copy changed are apart. */
export function changedPaths(
  plan: ScratchPlan,
  candidates: readonly CandidateHash[],
): { path: string; old?: PlannedFile; next?: CandidateHash }[] {
  const before = new Map(plan.files.map((file) => [file.path, file]));
  const after = new Map(candidates.map((file) => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .map((path) => ({ path, old: before.get(path), next: after.get(path) }))
    .filter(({ old, next }) => !(old && next && old.oid === next.oid && old.mode === next.mode));
}

/** Compare the scratch copy with the committed base. One entry per changed path, sorted. */
export function scratchChanges(
  repository: string,
  scratch: string,
  base: string,
  patches = true,
): FileDiff[] {
  const plan = scratchPlan(repository, base);
  // Committed ignore rules keep generated files such as installed packages out of the diff.
  // Skipped entries always come from the base, so they never show as changes.
  const changed = new Map(
    changedPaths(plan, hashCandidateFiles(scratch, repository, plan)).map((entry) => [
      entry.path,
      entry,
    ]),
  );
  // Accept takes held links from the base too. One the copy changed shows, so the person sees
  // that the copy's version stays out.
  const links = new Map<string, { link: LinkEntry; change: LinkChange }>();
  for (const link of plan.links) {
    const change = linkChange(scratch, link);
    if (change) links.set(link.path, { link, change });
  }
  const paths = [...new Set([...changed.keys(), ...links.keys()])].sort();
  const files: FileDiff[] = [];
  let budget = patches ? TOTAL_PATCH_BYTES : 0;
  let read = 0;
  for (const path of paths) {
    const held = links.get(path);
    const entry = changed.get(path);
    // shortcut: the read shape holds 2000 files. Upgrade: page changes when a thread needs more.
    if (files.length === 2000) break;
    let diff: FileDiff;
    let notice = false;
    if (held) diff = linkDiff(held.link, held.change);
    else if (!patches) diff = { path, additions: 0, deletions: 0, patch: null };
    else {
      const size = (entry?.old?.bytes ?? 0) + (entry?.next?.bytes ?? 0);
      if (read + size > DIFF_READ_BYTES) {
        diff = { path, additions: 0, deletions: 0, patch: notCompared(size, read) };
        notice = true;
      } else {
        read += size;
        const old = entry?.old
          ? { ...entry.old, content: readPlannedBlobs(repository, [entry.old])[0] }
          : undefined;
        const next = entry?.next ? readScratchFile(scratch, entry.next.path) : undefined;
        diff = fileDiff(path, old, next);
      }
    }
    const bytes = diff.patch === null ? 0 : Buffer.byteLength(diff.patch);
    const keep = diff.patch !== null && diff.patch.length <= PATCH_CHARACTERS && bytes <= budget;
    if (keep) budget -= bytes;
    // A not-compared note is a short explanation of a cause, so it stays whatever the budget.
    files.push({ ...diff, patch: keep || notice ? diff.patch : null });
  }
  return files;
}

const mebibytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

function notCompared(size: number, read: number): string {
  return `Not compared\nThis change reads ${mebibytes(size)} MiB of files, and this comparison already read ${mebibytes(read)} MiB of the ${mebibytes(DIFF_READ_BYTES)} MiB it reads at most. Accept still takes the change. Open the file in your editor to review it.\n`;
}

function readScratchFile(scratch: string, path: string): FileContent {
  const fd = openSync(
    join(scratch, path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const state = fstatSync(fd);
    const content = readFileSync(fd);
    return {
      path,
      mode: state.mode & 0o111 ? '100755' : '100644',
      hash: '',
      bytes: content.length,
      content,
    };
  } finally {
    closeSync(fd);
  }
}

type DiscardDone = 'restored' | 'removed' | 'recovered' | 'relinked';
export type DiscardOutcome =
  | { done: DiscardDone }
  | { refused: 'link-path' | 'skipped-path' | 'outside-copy' | 'path-blocked' | 'not-changed' };

const pathKey = (path: string) => path.normalize('NFC').toLowerCase();

type LinkChange = 'replaced' | 'removed' | 'changed';

/** How the copy differs from the base at one of the base's links. Null when the link is intact. */
function linkChange(scratch: string, link: LinkEntry): LinkChange | null {
  const parts = link.path.split('/');
  for (let end = 1; end < parts.length; end++) {
    const state = lstatSync(join(scratch, ...parts.slice(0, end)), { throwIfNoEntry: false });
    if (!state) return 'removed';
    if (!state.isDirectory()) return 'replaced';
  }
  const folder = parts.slice(0, -1).join('/');
  const key = pathKey(link.path);
  // A case-insensitive volume reaches the link under any spelling, so every match counts.
  const names = readdirSync(join(scratch, folder)).filter(
    (name) => pathKey(folder ? `${folder}/${name}` : name) === key,
  );
  if (!names.length) return 'removed';
  if (names.length > 1 || names[0] !== parts.at(-1)) return 'replaced';
  const at = join(scratch, link.path);
  if (!lstatSync(at).isSymbolicLink()) return 'replaced';
  return readlinkSync(at) === link.target ? null : 'changed';
}

function linkDiff(link: LinkEntry, change: LinkChange): FileDiff {
  const kept = `Accept takes ${link.path} -> ${link.target} from the base commit.`;
  const body =
    change === 'removed'
      ? `${kept} Discard puts the link back.`
      : `${kept} The copy's version here is not accepted. Discard puts the link back.`;
  return { path: link.path, additions: 0, deletions: 0, patch: `Link ${change}\n${body}\n` };
}

/**
 * Put one path of the scratch copy back the way the base has it. A changed file gets the base bytes
 * and mode, a file the copy added is removed, and a file the copy deleted comes back. A base link
 * the copy replaced, removed or changed is made again with its base target. Paths under a link and
 * entries the copy never held stay as they are, because Accept always takes them from the base.
 * `writing` hears the outcome just before the first change on disk.
 */
export function discardScratchPath(
  repository: string,
  scratch: string,
  base: string,
  path: string,
  writing?: (done: DiscardDone) => void,
): DiscardOutcome {
  const source = scratchPlan(repository, base);
  // A case-insensitive volume reaches a held entry under any spelling.
  const wanted = pathKey(path);
  const covers = (held: string) =>
    wanted === pathKey(held) || wanted.startsWith(`${pathKey(held)}/`);
  const link = source.links.find((entry) => pathKey(entry.path) === wanted);
  if (!link && source.links.some((entry) => covers(entry.path))) return { refused: 'link-path' };
  if (source.skipped.some((entry) => covers(entry.path))) return { refused: 'skipped-path' };
  const root = realpathSync.native(scratch);
  const target = resolve(root, link?.path ?? path);
  if (!target.startsWith(`${root}${sep}`)) return { refused: 'outside-copy' };
  const parts = (link?.path ?? path).split('/');
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
  if (link) {
    if (!linkChange(root, link)) return { refused: 'not-changed' };
    writing?.('relinked');
    restoreLink(root, source.links, link.path);
    return { done: 'relinked' };
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
    writing?.('removed');
    unlinkSync(target);
    prune(root, dirname(target));
    return { done: 'removed' };
  }
  if (state && sameFile(target, original)) return { refused: 'not-changed' };
  writing?.(state ? 'restored' : 'recovered');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // A rename replaces the directory entry, so a hard link the copy made to another file keeps its
  // bytes.
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}`);
  const mode = original.mode === '100755' ? 0o755 : 0o644;
  try {
    writeFileSync(temporary, readPlannedBlobs(repository, [original])[0], { flag: 'wx', mode });
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { done: state ? 'restored' : 'recovered' };
}

/** The discard about to change the copy, kept on disk so a retry after a crash finds it. */
export type DiscardMark = { key: string; path: string; base: string; done: DiscardDone };

export function writeDiscardMark(file: string, mark: DiscardMark) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temporary, JSON.stringify(mark), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readDiscardMark(file: string): DiscardMark | null {
  try {
    const mark = JSON.parse(readFileSync(file, 'utf8')) as Partial<DiscardMark>;
    return typeof mark.key === 'string' &&
      typeof mark.path === 'string' &&
      typeof mark.base === 'string' &&
      ['restored', 'removed', 'recovered', 'relinked'].includes(mark.done as string)
      ? (mark as DiscardMark)
      : null;
  } catch {
    return null;
  }
}

function sameFile(file: string, original: PlannedFile) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const state = fstatSync(fd);
    if ((state.mode & 0o111 ? '100755' : '100644') !== original.mode) return false;
    if (state.size !== original.bytes) return false;
    const hash = createHash(original.oid.length === 64 ? 'sha256' : 'sha1').update(
      `blob ${state.size}\0`,
    );
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (let count = 1; count > 0; ) {
      count = readSync(fd, chunk, 0, chunk.length, null);
      hash.update(chunk.subarray(0, count));
    }
    return hash.digest('hex') === original.oid;
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
