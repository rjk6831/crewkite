import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ChatChangesRead,
  CommentChatChangePayloadSchema,
  ReadChatChangesPayloadSchema,
} from '@crewkite/contracts';
import type { z } from 'zod';
import type { CandidateHash } from '../host/source.ts';
import {
  type ChangeListing,
  changesPage,
  fileHunks,
  type HunkDecisions,
  type ListedChange,
  listChanges,
  listingDigest,
  readSides,
} from './changes.ts';
import { composeHunks, type HunkRange, hunkText, type Op } from './hunks.ts';

// The person's review of the Changes tab: pages of the list, a decision per hunk, Discard of one
// hunk and a comment that quotes a hunk. Decisions live in `chat_hunk_decisions` and hold only
// while the thread's base and the file's blob in the copy match the row.

type ReadPayload = z.output<typeof ReadChatChangesPayloadSchema>;
type CommentPayload = z.output<typeof CommentChatChangePayloadSchema>;

/** Lines a comment quotes at most, so the message stays readable and inside the queue limit. */
const QUOTED_LINES = 80;
const QUOTED_LINE_CHARACTERS = 400;

/** Accepted hunk keys by path, for the rows that still match the base and the copy. */
export function currentDecisions(
  db: DatabaseSync,
  taskId: string,
  base: string,
  listing: ChangeListing,
): Map<string, Set<string>> {
  const blobs = new Map(listing.entries.map((entry) => [entry.path, entry.next?.oid ?? null]));
  const decisions = new Map<string, Set<string>>();
  const rows = db
    .prepare('SELECT path,hunk,base,blob FROM chat_hunk_decisions WHERE task_id=?')
    .all(taskId) as { path: string; hunk: string; base: string; blob: string }[];
  for (const row of rows) {
    if (row.base !== base || blobs.get(row.path) !== row.blob) continue;
    const keys = decisions.get(row.path) ?? new Set<string>();
    keys.add(row.hunk);
    decisions.set(row.path, keys);
  }
  return decisions;
}

/** Remove rows that name another base or another blob of their file. */
export function dropStaleDecisions(
  db: DatabaseSync,
  taskId: string,
  base: string,
  listing: ChangeListing,
) {
  const blobs = new Map(listing.entries.map((entry) => [entry.path, entry.next?.oid ?? null]));
  const rows = db
    .prepare('SELECT path,hunk,base,blob FROM chat_hunk_decisions WHERE task_id=?')
    .all(taskId) as { path: string; hunk: string; base: string; blob: string }[];
  const drop = db.prepare('DELETE FROM chat_hunk_decisions WHERE task_id=? AND path=? AND hunk=?');
  for (const row of rows)
    if (row.base !== base || blobs.get(row.path) !== row.blob) drop.run(taskId, row.path, row.hunk);
}

export function clearDecisions(db: DatabaseSync, taskId: string) {
  db.prepare('DELETE FROM chat_hunk_decisions WHERE task_id=?').run(taskId);
}

export type PageOutcome = ChatChangesRead | { refused: 'listing-changed' };

/** One page of the Changes list. A page read under another listing is refused. */
export function readChangesPage(
  db: DatabaseSync,
  input: { repository: string; scratch: string; base: string; payload: ReadPayload },
): PageOutcome {
  const { repository, scratch, base, payload } = input;
  const listing = listChanges(repository, scratch, base);
  const digest = listingDigest(base, listing);
  if (payload.listing && payload.listing !== digest) return { refused: 'listing-changed' };
  const page = changesPage(
    repository,
    scratch,
    listing,
    currentDecisions(db, payload.taskId, base, listing),
    payload.after,
    payload.limit,
  );
  return {
    taskId: payload.taskId,
    base,
    files: page.files,
    total: listing.entries.length,
    next: page.next,
    listing: digest,
  };
}

type Located =
  | { refused: 'not-changed' | 'hunks-unavailable' | 'hunk-not-found' }
  | {
      entry: ListedChange & { old: NonNullable<ListedChange['old']> } & {
        next: CandidateHash;
      };
      ops: Op[];
      hunks: HunkRange[];
      index: number;
      listing: ChangeListing;
    };

/** The current hunk `key` of `path`, and the diff it belongs to. */
export function locateHunk(
  repository: string,
  scratch: string,
  base: string,
  path: string,
  key: string,
): Located {
  const listing = listChanges(repository, scratch, base);
  const entry = listing.entries.find((item) => item.path === path);
  if (!entry || entry.link) return { refused: 'not-changed' };
  if (!entry.old || !entry.next) return { refused: 'hunks-unavailable' };
  const sides = readSides(repository, scratch, entry);
  const diff = fileHunks(path, sides.old, sides.next);
  if (!diff?.controls) return { refused: 'hunks-unavailable' };
  const index = diff.hunks.findIndex((hunk) => hunk.key === key);
  if (index < 0) return { refused: 'hunk-not-found' };
  return {
    entry: entry as Extract<Located, { entry: unknown }>['entry'],
    ops: diff.ops,
    hunks: diff.hunks,
    index,
    listing,
  };
}

/** Record or remove one accepted hunk. The row names the base and the copy's blob of the file. */
export function decideHunk(
  db: DatabaseSync,
  taskId: string,
  base: string,
  located: Extract<Located, { entry: unknown }>,
  decision: 'accepted' | 'undecided',
) {
  const { entry, hunks, index, listing } = located;
  dropStaleDecisions(db, taskId, base, listing);
  if (decision === 'undecided')
    db.prepare('DELETE FROM chat_hunk_decisions WHERE task_id=? AND path=? AND hunk=?').run(
      taskId,
      entry.path,
      hunks[index].key,
    );
  else
    db.prepare(
      'INSERT INTO chat_hunk_decisions(task_id,path,hunk,base,blob) VALUES (?,?,?,?,?) ON CONFLICT(task_id,path,hunk) DO UPDATE SET base=excluded.base, blob=excluded.blob',
    ).run(taskId, entry.path, hunks[index].key, base, entry.next.oid);
}

/**
 * The file with one hunk reverted to the base. The other hunks keep the copy's lines. A hunk
 * accepted before keeps its decision when its own lines and its base start line do not move, so
 * the caller carries those rows to the new blob.
 */
export function revertedHunk(located: Extract<Located, { entry: unknown }>): Buffer {
  const { ops, hunks, index } = located;
  const keep = new Set(hunks.map((_, at) => at).filter((at) => at !== index));
  return Buffer.from(composeHunks(ops, hunks, keep), 'utf8');
}

/**
 * Replace a scratch file with `content`, keeping its mode. A rename replaces the directory entry,
 * so a hard link to the old file keeps its bytes. The copy must still hold the blob `expected`.
 */
export function writeScratchFile(
  scratch: string,
  path: string,
  content: Buffer,
  expected: CandidateHash,
) {
  const target = join(scratch, path);
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let mode: number;
  try {
    const state = fstatSync(fd);
    if (!state.isFile() || state.size !== expected.bytes) throw new Error('scratch file moved');
    mode = state.mode & 0o777;
  } finally {
    closeSync(fd);
  }
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Revert one hunk in the copy. The file's other accepted hunks keep their lines and their base
 * start lines, so their keys stay the same and their rows move to the file's new blob.
 */
export function discardHunk(
  db: DatabaseSync,
  at: { taskId: string; root: string; scratch: string; base: string },
  located: Extract<Located, { entry: unknown }>,
) {
  const path = located.entry.path;
  const kept = currentDecisions(db, at.taskId, at.base, located.listing).get(path) ?? new Set();
  writeScratchFile(at.scratch, path, revertedHunk(located), located.entry.next);
  const listing = listChanges(at.root, at.scratch, at.base);
  dropStaleDecisions(db, at.taskId, at.base, listing);
  const entry = listing.entries.find((item) => item.path === path);
  if (!entry?.old || !entry.next) return;
  const sides = readSides(at.root, at.scratch, entry);
  const diff = fileHunks(path, sides.old, sides.next);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO chat_hunk_decisions(task_id,path,hunk,base,blob) VALUES (?,?,?,?,?)',
  );
  for (const hunk of diff?.controls ? diff.hunks : [])
    if (kept.has(hunk.key) && hunk.key !== located.hunks[located.index].key)
      insert.run(at.taskId, path, hunk.key, at.base, entry.next.oid);
}

/** A blob oid for `content` in the repository's object format. */
export function blobOid(content: Buffer, sha256: boolean): string {
  return createHash(sha256 ? 'sha256' : 'sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}

/**
 * What Accept publishes. A file with accepted hunks goes in as the base with only those hunks
 * applied; its undecided hunks stay in the copy. Every other file goes in as the copy holds it.
 * `partial` names the files Accept published in part, for the system line.
 */
export function acceptedTree(
  repository: string,
  scratch: string,
  listing: ChangeListing,
  decisions: HunkDecisions,
): {
  candidates: CandidateHash[];
  contents: Map<string, Buffer>;
  partial: { path: string; accepted: number; hunks: number }[];
} {
  const replaced = new Map<string, CandidateHash>();
  const contents = new Map<string, Buffer>();
  const partial: { path: string; accepted: number; hunks: number }[] = [];
  for (const entry of listing.entries) {
    const accepted = decisions.get(entry.path);
    if (!accepted?.size || !entry.old || !entry.next || entry.link) continue;
    const sides = readSides(repository, scratch, entry);
    const diff = fileHunks(entry.path, sides.old, sides.next);
    if (!diff?.controls) continue;
    const chosen = new Set(
      diff.hunks.flatMap((hunk, index) => (accepted.has(hunk.key) ? [index] : [])),
    );
    if (!chosen.size) continue;
    const content = Buffer.from(composeHunks(diff.ops, diff.hunks, chosen), 'utf8');
    contents.set(entry.path, content);
    replaced.set(entry.path, {
      path: entry.path,
      mode: entry.next.mode,
      oid: blobOid(content, entry.next.oid.length === 64),
      bytes: content.length,
    });
    partial.push({ path: entry.path, accepted: chosen.size, hunks: diff.hunks.length });
  }
  return {
    candidates: listing.candidates.map((file) => replaced.get(file.path) ?? file),
    contents,
    partial,
  };
}

/** The sentence the Accept line adds for files published in part. Empty when there are none. */
export function partialLine(partial: readonly { path: string; accepted: number; hunks: number }[]) {
  if (!partial.length) return '';
  const named = partial
    .slice(0, 20)
    .map((file) => `${file.path} (${file.accepted} of ${file.hunks} hunks)`);
  const more = partial.length > 20 ? `, and ${partial.length - 20} more` : '';
  return ` Accepted hunks only: ${named.join(', ')}${more}. The other hunks stay in the scratch copy.`;
}

/**
 * The message a comment queues: what it is about, the quoted hunk lines and the comment. The
 * quote holds the lines of the range the person picked, or the whole hunk.
 */
export function commentMessage(
  located: Extract<Located, { entry: unknown }>,
  payload: Pick<CommentPayload, 'lines' | 'text'>,
): string | { refused: 'lines-outside-hunk' } {
  const { ops, hunks, index, entry } = located;
  const hunk = hunks[index];
  const lines = hunkText(ops, hunk);
  let quoted = lines.slice(1);
  let where = `the hunk at old line ${hunk.oldStart}, new line ${hunk.newStart}`;
  if (payload.lines) {
    const { side, start, end } = payload.lines;
    const first = side === 'old' ? hunk.oldStart : hunk.newStart;
    const count = side === 'old' ? hunk.oldLines : hunk.newLines;
    if (start < first || end > first + count - 1) return { refused: 'lines-outside-hunk' };
    // Walk the hunk once and keep the lines whose number on that side falls in the range, with
    // the removed or added lines between them.
    quoted = [];
    let at = side === 'old' ? hunk.oldStart : hunk.newStart;
    for (const value of ops.slice(hunk.start, hunk.stop)) {
      const counts = side === 'old' ? value.op !== '+' : value.op !== '-';
      const inside = counts ? at >= start && at <= end : at > start && at <= end;
      if (inside) {
        const bare = value.line.endsWith('\n') ? value.line.slice(0, -1) : value.line;
        quoted.push(`${value.op}${bare}`);
      }
      if (counts) at++;
    }
    where =
      start === end
        ? `${side === 'old' ? 'base' : 'copy'} line ${start}`
        : `${side === 'old' ? 'base' : 'copy'} lines ${start} to ${end}`;
  }
  const shown = quoted
    .slice(0, QUOTED_LINES)
    .map((line) =>
      line.length > QUOTED_LINE_CHARACTERS ? `${line.slice(0, QUOTED_LINE_CHARACTERS)}...` : line,
    );
  if (quoted.length > QUOTED_LINES) shown.push(`... ${quoted.length - QUOTED_LINES} more lines`);
  const fence = shown.some((line) => line.includes('```')) ? '~~~~' : '```';
  return [
    `Review comment on ${entry.path}, ${where}:`,
    '',
    `${fence}diff`,
    lines[0],
    ...shown,
    fence,
    '',
    payload.text.trim(),
  ].join('\n');
}
