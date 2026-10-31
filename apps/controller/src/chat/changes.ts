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
import { type ChatChangeEntry, MAX_FILE_HUNKS } from '@crewkite/contracts';
import {
  blobToFile,
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
import {
  decodeText,
  type HunkRange,
  hunkRanges,
  lineDiff,
  type Op,
  renderPatch,
  textLines,
} from './hunks.ts';

type FileDiff = Pick<ChatChangeEntry, 'path' | 'additions' | 'deletions' | 'patch'>;

const PATCH_CHARACTERS = 262_144;
// Counts always return. Patches and hunks stop here so one read stays well under the frame limit.
const TOTAL_PATCH_BYTES = 655_360;
// What one hunk entry adds to a read: a 64 character key, four numbers and the field names.
const HUNK_BYTES = 180;
// A file larger than this on either side shows its patch with whole-file controls only.
const HUNK_FILE_BYTES = 4 * 1024 * 1024;

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

/** The base's links the copy changed, by path. */
function changedLinks(scratch: string, plan: ScratchPlan) {
  const links = new Map<string, { link: LinkEntry; change: LinkChange }>();
  for (const link of plan.links) {
    const change = linkChange(scratch, link);
    if (change) links.set(link.path, { link, change });
  }
  return links;
}

/** One entry of the Changes list: a changed file, or a base link the copy changed. */
export type ListedChange = {
  path: string;
  old?: PlannedFile;
  next?: CandidateHash;
  link?: { link: LinkEntry; change: LinkChange };
};

/** Every entry of the Changes list in path order, by blob id. No file bytes are read. */
export type ChangeListing = {
  plan: ScratchPlan;
  candidates: CandidateHash[];
  entries: ListedChange[];
  /** How many files differ from the base. Changed links are listed and never published. */
  files: number;
};

export function listChanges(repository: string, scratch: string, base: string): ChangeListing {
  const plan = scratchPlan(repository, base);
  // Committed ignore rules keep generated files such as installed packages out of the diff.
  // Skipped entries always come from the base, so they never show as changes.
  const candidates = hashCandidateFiles(scratch, repository, plan);
  const changed = changedPaths(plan, candidates);
  const byPath = new Map<string, ListedChange>(changed.map((entry) => [entry.path, entry]));
  // Accept takes held links from the base too. One the copy changed shows, so the person sees
  // that the copy's version stays out.
  for (const [path, link] of changedLinks(scratch, plan))
    byPath.set(path, { ...(byPath.get(path) ?? { path }), link });
  const entries = [...byPath.keys()].sort().map((path) => byPath.get(path) as ListedChange);
  return { plan, candidates, entries, files: changed.length };
}

/** Hunk keys the person accepted, by path, already checked against the current copy. */
export type HunkDecisions = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * A digest of the list by blob id and mode. Pages read under one listing and an Accept that names
 * it cover exactly the same entries. Hunk decisions stay out: they are the person's own commands,
 * and any change to a file's bytes drops them.
 */
export function listingDigest(base: string, listing: ChangeListing): string {
  const hash = createHash('sha256').update(`${base}\n`);
  for (const entry of listing.entries)
    hash.update(
      `${JSON.stringify([
        entry.path,
        entry.old?.oid ?? null,
        entry.old?.mode ?? null,
        entry.next?.oid ?? null,
        entry.next?.mode ?? null,
        entry.link?.change ?? null,
      ])}\n`,
    );
  return hash.digest('hex');
}

/** The diff of one text file, and whether its hunks take per hunk controls. */
export type FileHunks = {
  ops: Op[];
  hunks: HunkRange[];
  patch: string;
  additions: number;
  deletions: number;
  controls: boolean;
};

type Side = { content: Buffer; mode: string };

/**
 * The hunks of one changed file from its two contents. Null for binary text on either side. Only
 * a text file the base and the copy both hold, with an unchanged mode, sides of at most 4 MiB, a
 * patch that fits one read and at most `MAX_FILE_HUNKS` hunks, takes per hunk controls.
 */
export function fileHunks(path: string, old?: Side, next?: Side): FileHunks | null {
  const before = old ? decodeText(old.content) : '';
  const after = next ? decodeText(next.content) : '';
  if (before === null || after === null) return null;
  const ops = lineDiff(textLines(before), textLines(after));
  const hunks = hunkRanges(ops);
  const patch = renderPatch(path, { old: Boolean(old), next: Boolean(next) }, ops, hunks);
  const controls =
    old !== undefined &&
    next !== undefined &&
    old.mode === next.mode &&
    old.content.length <= HUNK_FILE_BYTES &&
    next.content.length <= HUNK_FILE_BYTES &&
    hunks.length > 0 &&
    hunks.length <= MAX_FILE_HUNKS &&
    patch.length <= PATCH_CHARACTERS &&
    Buffer.byteLength(patch) + hunks.length * HUNK_BYTES <= TOTAL_PATCH_BYTES;
  return {
    ops,
    hunks,
    patch,
    additions: ops.filter((op) => op.op === '+').length,
    deletions: ops.filter((op) => op.op === '-').length,
    controls,
  };
}

/** The base bytes and the copy bytes of one listed file. */
export function readSides(
  repository: string,
  scratch: string,
  entry: ListedChange,
): { old?: Side; next?: Side } {
  return {
    old: entry.old
      ? { content: readPlannedBlobs(repository, [entry.old])[0], mode: entry.old.mode }
      : undefined,
    next: entry.next ? readScratchFile(scratch, entry.next.path) : undefined,
  };
}

const wholeFile = { hunks: [], hunkControls: false, decided: false };

/**
 * One page of the Changes list: up to `limit` entries after `after`, in path order. A page ends
 * early when the next patch would pass the read limits, so that patch starts the next page and
 * every file whose patch fits one read reaches a page with it. `next` names the page's last entry.
 */
export function changesPage(
  repository: string,
  scratch: string,
  listing: ChangeListing,
  decisions: HunkDecisions,
  after: string | undefined,
  limit: number,
): { files: ChatChangeEntry[]; next: string | null } {
  const entries = listing.entries.filter((entry) => after === undefined || entry.path > after);
  const files: ChatChangeEntry[] = [];
  let budget = TOTAL_PATCH_BYTES;
  let read = 0;
  for (const entry of entries) {
    if (files.length === limit) break;
    if (entry.link) {
      files.push({ ...linkDiff(entry.link.link, entry.link.change), ...wholeFile });
      continue;
    }
    const size = (entry.old?.bytes ?? 0) + (entry.next?.bytes ?? 0);
    if (read + size > DIFF_READ_BYTES) {
      if (files.length) break;
      const patch = notCompared(size, read);
      files.push({ path: entry.path, additions: 0, deletions: 0, patch, ...wholeFile });
      continue;
    }
    const sides = readSides(repository, scratch, entry);
    const diff = fileHunks(entry.path, sides.old, sides.next);
    read += size;
    if (!diff) {
      files.push({ path: entry.path, additions: 0, deletions: 0, patch: null, ...wholeFile });
      continue;
    }
    const cost =
      Buffer.byteLength(diff.patch) + (diff.controls ? diff.hunks.length * HUNK_BYTES : 0);
    const fits = diff.patch.length <= PATCH_CHARACTERS && cost <= budget;
    if (!fits && files.length && cost <= TOTAL_PATCH_BYTES) break;
    if (fits) budget -= cost;
    const accepted = decisions.get(entry.path);
    const controls = fits && diff.controls;
    files.push({
      path: entry.path,
      additions: diff.additions,
      deletions: diff.deletions,
      patch: fits ? diff.patch : null,
      hunks: controls
        ? diff.hunks.map((hunk) => ({
            key: hunk.key,
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            decision: accepted?.has(hunk.key) ? 'accepted' : 'undecided',
          }))
        : [],
      hunkControls: controls,
      decided: controls && diff.hunks.some((hunk) => accepted?.has(hunk.key)),
    });
  }
  const last = files.at(-1)?.path;
  return {
    files,
    next: last !== undefined && entries.at(-1)?.path !== last ? last : null,
  };
}

/**
 * The whole list in one read, for the prompts and the thread tools, which keep their own limits.
 * Patches stop at the read limits; later files keep their counts with no patch.
 */
export function scratchChanges(
  repository: string,
  scratch: string,
  base: string,
  patches = true,
): FileDiff[] {
  const listing = listChanges(repository, scratch, base);
  const files: FileDiff[] = [];
  let budget = patches ? TOTAL_PATCH_BYTES : 0;
  let read = 0;
  for (const entry of listing.entries) {
    const { path } = entry;
    let diff: FileDiff;
    let notice = false;
    if (entry.link) diff = linkDiff(entry.link.link, entry.link.change);
    else if (!patches) diff = { path, additions: 0, deletions: 0, patch: null };
    else {
      const size = (entry.old?.bytes ?? 0) + (entry.next?.bytes ?? 0);
      if (read + size > DIFF_READ_BYTES) {
        diff = { path, additions: 0, deletions: 0, patch: notCompared(size, read) };
        notice = true;
      } else {
        read += size;
        const sides = readSides(repository, scratch, entry);
        const hunks = fileHunks(path, sides.old, sides.next);
        diff = hunks
          ? { path, additions: hunks.additions, deletions: hunks.deletions, patch: hunks.patch }
          : { path, additions: 0, deletions: 0, patch: null };
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
    blobToFile(repository, original.oid, temporary);
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
