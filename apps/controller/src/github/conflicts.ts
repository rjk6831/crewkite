import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AcceptChatChangesPayloadSchema, type ChatThread } from '@crewkite/contracts';
import { z } from 'zod';
import type { ToolRunner } from '../chat/git.ts';
import { decodeText } from '../chat/hunks.ts';
import {
  blobToFile,
  git,
  type LinkEntry,
  restoreLink,
  safePath,
  scratchPlan,
} from '../host/source.ts';

// Before a pull request merges, the accepted commit is merged onto the PR's freshly fetched base
// outside any checkout. A clean merge changes nothing. When text files conflict, the thread's copy
// moves onto the base with the merge in it, conflict markers included, and one fixer turn resolves
// them. Accept to the same branch then commits the result with the accepted commit as its parent.
// What a model cannot merge by hand goes back to the person with its paths.

const remoteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const branchName = AcceptChatChangesPayloadSchema.shape.branch;
const objectId = z.string().regex(/^[a-f0-9]{40}$/);

// The Changes tab reviews a file hunk by hunk up to 4 MiB. A resolution past that could not be
// reviewed that way, so the file goes to a local checkout.
const MERGED_BYTES = 4 * 1024 * 1024;
// One turn merges a handful of files by hand. A larger conflict is a person's merge.
const MAX_CONFLICTS = 16;
// The sides quoted in the brief, as the plan's resolve turn quotes a slice.
const FILE_CHARACTERS = 16_000;
const TOTAL_CHARACTERS = 48_000;

/** The remote and branch a merge check fetches. Both reach git as arguments, so both are checked. */
export function mergeTarget(remote: string, branch: string): boolean {
  return remoteName.safeParse(remote).success && branchName.safeParse(branch).success;
}

/** Where a fetched base waits while the merge is checked. Nothing else writes it. */
function fetchedRef(taskId: string) {
  if (!/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(taskId))
    throw new Error('Invalid thread identity.');
  return `refs/crewkite/fetched/${taskId}`;
}

/**
 * Fetch one branch of a remote the person configured into the project, with their own git setup.
 * Answers the fetched commit, or why there is none.
 */
export async function fetchBase(
  run: ToolRunner,
  input: { root: string; remote: string; branch: string; taskId: string },
): Promise<{ commit: string } | { reason: string; next: string }> {
  const ref = fetchedRef(input.taskId);
  const fetched = await run(
    'git',
    [
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-write-fetch-head',
      input.remote,
      `+refs/heads/${input.branch}:${ref}`,
    ],
    input.root,
  );
  if (!fetched) return { reason: 'git-missing', next: 'Install Git, then check the merge again.' };
  if (fetched.code !== 0) {
    const said = fetched.stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? '';
    return {
      reason: 'fetch-failed',
      next: `Could not fetch ${input.branch} from ${input.remote}. ${said}`.trim(),
    };
  }
  return {
    commit: git(input.root, ['rev-parse', '--verify', `${ref}^{commit}`])
      .toString()
      .trim(),
  };
}

/** Remove the fetched ref. Once the thread's own ref pins the base, nothing needs it. */
export function dropFetched(root: string, taskId: string) {
  try {
    git(root, ['update-ref', '-d', fetchedRef(taskId)]);
  } catch {
    // A ref left behind keeps one commit alive and changes nothing else.
  }
}

type Entry = { mode: string; oid: string };
/**
 * One conflicting file: each side's text for the brief, or null when it is too long to quote.
 * `added` means both sides added the file, so it has no common ancestor.
 */
export type ConflictSides = {
  path: string;
  added: boolean;
  ancestor: string | null;
  thread: string | null;
  base: string | null;
};
export type MergeOutcome =
  | { state: 'clean' }
  | { state: 'refused'; refused: { path: string; why: string }[] }
  /** `write` moves the copy from the accepted commit onto the merge. */
  | { state: 'conflicts'; conflicts: ConflictSides[]; write: () => void };

/**
 * Merge `accepted` onto `base` in `work`, a new repository that borrows the project's objects, so
 * the project's objects, refs and checkout stay as they are. `label` names the base side in the
 * conflict markers. The thread side is `thread`, and the common ancestor's lines sit between them.
 */
export function mergeOnto(input: {
  root: string;
  work: string;
  scratch: string;
  accepted: string;
  base: string;
  label: string;
}): MergeOutcome {
  const { root, work, label } = input;
  const objects = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])
    .toString('utf8')
    .trim();
  git(work, ['init', '--quiet']);
  mkdirSync(join(work, '.git', 'objects', 'info'), { recursive: true });
  writeFileSync(join(work, '.git', 'objects', 'info', 'alternates'), `${objects}\n`);
  git(work, ['update-ref', 'refs/heads/thread', input.accepted]);
  git(work, ['update-ref', `refs/remotes/${label}`, input.base]);
  let out: Buffer;
  try {
    out = git(work, [
      '-c',
      'merge.conflictStyle=diff3',
      'merge-tree',
      '--write-tree',
      '--no-messages',
      '-z',
      'thread',
      label,
    ]);
  } catch (error) {
    // Exit 1 is a merge with conflicts. Anything else, such as unrelated histories, is a failure.
    const { status, stdout } = error as { status?: number; stdout?: Buffer };
    if (status !== 1 || !stdout) throw error;
    out = stdout;
  }
  const [merged, ...rest] = text(out).split('\0');
  const stages = new Map<string, (Entry | null)[]>();
  for (const field of rest) {
    if (!field) break;
    const match = /^([0-7]{6}) ([a-f0-9]{40}) ([123])\t(.+)$/s.exec(field);
    if (!match) throw new Error('The merge result could not be read.');
    const sides = stages.get(match[4]) ?? [null, null, null];
    sides[Number(match[3]) - 1] = { mode: match[1], oid: match[2] };
    stages.set(match[4], sides);
  }
  if (!stages.size) return { state: 'clean' };
  // What the copy gets: every path where the merge differs from the accepted commit. What the
  // thread brings: every path where the merge differs from the base.
  const fromAccepted = treeDiff(work, input.accepted, merged);
  const fromBase = treeDiff(work, input.base, merged);
  // One reason per path, the first found.
  const refused = new Map<string, string>();
  const refuse = (path: string, why: string) => refused.has(path) || refused.set(path, why);
  for (const [path, sides] of stages) {
    // Where the merge matches the accepted commit, the diff leaves the path out.
    const change = fromAccepted.get(path);
    const why =
      stages.size > MAX_CONFLICTS
        ? `one of ${stages.size} conflicting files`
        : unmergeable(work, sides, change ? change.next : sides[1]);
    if (why) refuse(path, why);
  }
  for (const [path, { old, next }] of fromBase)
    if ([old, next].some((entry) => entry && !regular(entry.mode)))
      refuse(path, 'a link or submodule the thread changed');
  for (const path of fromAccepted.keys())
    if (!pathFits(path)) refuse(path, 'a path the copy cannot hold');
  if (refused.size)
    return { state: 'refused', refused: [...refused].map(([path, why]) => ({ path, why })) };

  let room = TOTAL_CHARACTERS;
  const quote = (entry: Entry | null): string | null => {
    if (!entry) return null;
    const bytes = Number(git(work, ['cat-file', '-s', entry.oid]).toString().trim());
    if (bytes > FILE_CHARACTERS * 4) return null;
    const value = decodeText(git(work, ['cat-file', 'blob', entry.oid]));
    if (value === null || value.length > FILE_CHARACTERS || value.length > room) return null;
    room -= value.length;
    return value;
  };
  const conflicts = [...stages].map(([path, [ancestor, thread, base]]) => ({
    path,
    added: ancestor === null,
    ancestor: quote(ancestor),
    thread: quote(thread),
    base: quote(base),
  }));
  return {
    state: 'conflicts',
    conflicts,
    write: () => writeCopy(input, fromAccepted),
  };
}

/** Why a model cannot merge this file by hand in the copy, or null when it can. */
function unmergeable(work: string, sides: (Entry | null)[], merged: Entry | null): string | null {
  const present = sides.filter((entry) => entry !== null);
  if (present.some((entry) => entry.mode === '160000')) return 'a submodule';
  if (present.some((entry) => !regular(entry.mode))) return 'a link';
  if (!sides[1] || !sides[2] || !merged) return 'deleted on one side';
  if (Number(git(work, ['cat-file', '-s', merged.oid]).toString().trim()) > MERGED_BYTES)
    return 'too large for the copy';
  // Git leaves a file it cannot merge as text, such as a binary file, without markers.
  const value = decodeText(git(work, ['cat-file', 'blob', merged.oid]));
  if (value === null || !value.split(/\r?\n/).includes('<<<<<<< thread')) return 'binary';
  return null;
}

/**
 * Move the copy from the accepted commit to the merge. A path goes first where the merge holds
 * nothing the copy keeps, so a folder that became a file is gone before the file is written. A
 * link is remade only when the base holds it inside the copy, the way a new copy would hold it.
 */
function writeCopy(
  input: { root: string; work: string; scratch: string; base: string },
  changes: ReadonlyMap<string, { next: Entry | null }>,
) {
  const links: LinkEntry[] = [...changes.values()].some(({ next }) => next?.mode === '120000')
    ? scratchPlan(input.root, input.base).links
    : [];
  const linked = (entry: Entry | null, path: string) =>
    entry?.mode === '120000' && links.some((link) => link.path === path);
  const paths = [...changes.keys()].sort();
  for (const path of paths) {
    const { next } = changes.get(path) as { next: Entry | null };
    if (!next || (!regular(next.mode) && !linked(next, path)))
      rmSync(join(input.scratch, path), { recursive: true, force: true });
  }
  for (const path of paths) {
    const { next } = changes.get(path) as { next: Entry | null };
    if (next && regular(next.mode)) {
      const target = join(input.scratch, path);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      blobToFile(input.work, next.oid, target);
      chmodSync(target, next.mode === '100755' ? 0o755 : 0o644);
    } else if (linked(next, path)) restoreLink(input.scratch, links, path);
  }
}

/** The message of the one fixer turn that resolves the conflicts. */
export function resolutionBrief(input: {
  target: string;
  label: string;
  conflicts: readonly ConflictSides[];
}): string {
  const { label } = input;
  const files = input.conflicts.map(({ path, added, ancestor, thread, base }) => {
    const side = (name: string, value: string | null) =>
      value === null
        ? `${path}, ${name}: too long to quote here. Read its lines between the markers in the file.`
        : `${path}, ${name}:\n\n\`\`\`\n${value.replace(/\n$/, '')}\n\`\`\``;
    return [
      added
        ? `${path}: both sides added this file, so it has no common ancestor.`
        : side('the common ancestor', ancestor),
      side('the thread', thread),
      side(label, base),
    ].join('\n\n');
  });
  return [
    "Resolve these conflicts so both changes hold. Keep the thread's intent. Do not change files that do not conflict.",
    `The scratch copy now holds ${input.target} merged with ${label}. In each conflict the thread's lines follow <<<<<<< thread, the common ancestor's follow |||||||, ${label}'s follow =======, and >>>>>>> ${label} closes it. Leave no marker behind.`,
    `Conflicting files: ${input.conflicts.map((conflict) => conflict.path).join(', ')}.`,
    files.join('\n\n'),
    'When you are done, say what you kept from each side in each file.',
  ].join('\n\n');
}

/** The refusal for conflicts a model cannot merge, with their paths. */
export function refusedText(refused: readonly { path: string; why: string }[]): string {
  const named = refused.slice(0, 8).map(({ path, why }) => `${path} (${why})`);
  const more = refused.length > named.length ? ` and ${refused.length - named.length} more` : '';
  return `CrewKite cannot merge ${named.join(', ')}${more} in the copy. Resolve the merge in a local checkout.`;
}

const PendingMergeSchema = z.strictObject({
  /** The commit the thread accepted. The merge commit's first parent. */
  accepted: objectId,
  /** The fetched base commit. The copy starts from it while the merge waits. */
  base: objectId,
  remote: remoteName,
  branch: branchName,
  /** The accepted branch the merge goes on. */
  target: branchName,
  paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_CONFLICTS),
});
/** A merge with the pull request's base that waits in the thread's copy for Accept. */
export type PendingMerge = z.infer<typeof PendingMergeSchema>;

const recordFile = (folder: string) => join(folder, 'merge.json');

export function writeMerge(folder: string, merge: PendingMerge) {
  writeFileSync(recordFile(folder), JSON.stringify(PendingMergeSchema.parse(merge)), {
    mode: 0o600,
  });
}

export function clearMerge(folder: string) {
  rmSync(recordFile(folder), { force: true });
}

/**
 * The merge waiting in the copy of the thread whose folder this is. A record that no longer
 * matches the thread's base and accepted commit is from a merge the thread has moved past.
 */
export function pendingMerge(
  folder: string,
  thread: Pick<ChatThread, 'base' | 'lastAcceptance'>,
): PendingMerge | null {
  let merge: PendingMerge;
  try {
    merge = PendingMergeSchema.parse(JSON.parse(readFileSync(recordFile(folder), 'utf8')));
  } catch {
    return null;
  }
  const accepted = thread.lastAcceptance;
  return merge.base === thread.base &&
    merge.accepted === accepted?.commit &&
    merge.target === accepted.branch
    ? merge
    : null;
}

/** The merged files that still hold a marker line this merge wrote. */
export function markedPaths(scratch: string, merge: PendingMerge): string[] {
  const markers = new Set(['<<<<<<< thread', `>>>>>>> ${merge.remote}/${merge.branch}`]);
  return merge.paths.filter((path) => {
    let value: string;
    try {
      value = readFileSync(join(scratch, path), 'utf8');
    } catch {
      return false;
    }
    return value.split(/\r?\n/).some((line) => markers.has(line));
  });
}

/** The message of the commit the thread accepted, for a rebase that keeps it. */
export function acceptedMessage(root: string, commit: string): string {
  return `${git(root, ['show', '-s', '--format=%B', commit]).toString('utf8').trimEnd()}\n`;
}

function treeDiff(work: string, from: string, to: string) {
  const fields = text(git(work, ['diff-tree', '-r', '-z', '--no-renames', from, to])).split('\0');
  const changes = new Map<string, { old: Entry | null; next: Entry | null }>();
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) [ADMT]$/.exec(fields[at]);
    if (!match) throw new Error('The merge result could not be read.');
    const entry = (mode: string, oid: string) => (mode === '000000' ? null : { mode, oid });
    changes.set(fields[at + 1], {
      old: entry(match[1], match[3]),
      next: entry(match[2], match[4]),
    });
  }
  return changes;
}

const regular = (mode: string) => mode === '100644' || mode === '100755';

function pathFits(path: string) {
  try {
    safePath(path, new Set(), new Map());
    return true;
  } catch {
    return false;
  }
}

/** Git output with paths in it. A path that is not UTF-8 cannot be in the copy. */
function text(out: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(out);
  } catch {
    throw new Error('A changed path is not UTF-8 text, and the copy cannot hold it.');
  }
}
