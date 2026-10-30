import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type SourceDetails,
  SourceDetailsSchema,
  type SourceFileDetail,
  SourceFileDetailSchema,
} from '@crewkite/contracts';

export type SourceFacts = {
  projectId: string;
  base: string;
  branch: string;
  dirtyCount: number;
  untrackedCount: number;
};
export type FileEntry = { path: string; mode: '100644' | '100755'; hash: string; bytes: number };
export type FileContent = FileEntry & { content: Buffer };
export type SkippedEntry = {
  path: string;
  reason: 'link-outside' | 'submodule' | 'path-encoding';
};
/** A link the scratch copy holds. Its target stays inside the copy through every other link. */
export type LinkEntry = { path: string; target: string };
/**
 * A base entry the scratch copy holds as a link or does not hold at all. Acceptance copies it into
 * the new tree from the base byte for byte, whatever the copy has at that path.
 */
export type KeptEntry = { path: Buffer; mode: string; oid: string; content: Buffer | null };
export type CommittedSource = {
  files: FileContent[];
  links: LinkEntry[];
  skipped: SkippedEntry[];
  kept: KeptEntry[];
};
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_FILES = 10_000;
// A chat thread copies the whole repository, so its cap is higher. The byte limit still holds.
const MAX_SCRATCH_FILES = 100_000;
const MAX_LINK_EXPANSIONS = 40;
// BOM handling off, so a name that starts with U+FEFF keeps it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A scratch copy holds more files than CrewKite compares. The message names that cause. */
export class ScratchTooLarge extends Error {}

export function git(
  directory: string,
  args: string[],
  input?: Buffer | string,
  identity?: { name: string; email: string; at: string },
): Buffer {
  return runGit(directory, args, input, identity, MAX_SOURCE_BYTES);
}

function runGit(
  directory: string,
  args: string[],
  input: Buffer | string | undefined,
  identity: { name: string; email: string; at: string } | undefined,
  maximumBytes: number,
  stdio: ('pipe' | number)[] = ['pipe', 'pipe', 'pipe'],
): Buffer {
  return execFileSync(
    'git',
    [
      '--no-optional-locks',
      '-c',
      `core.hooksPath=${devNull}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'diff.external=',
      '-c',
      `core.attributesFile=${devNull}`,
      '-c',
      'credential.helper=',
      ...args,
    ],
    {
      cwd: directory,
      input,
      maxBuffer: maximumBytes,
      env: {
        PATH: process.env.PATH,
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_CONFIG_GLOBAL: devNull,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        ...(identity
          ? {
              GIT_AUTHOR_NAME: identity.name,
              GIT_AUTHOR_EMAIL: identity.email,
              GIT_AUTHOR_DATE: identity.at,
              GIT_COMMITTER_NAME: identity.name,
              GIT_COMMITTER_EMAIL: identity.email,
              GIT_COMMITTER_DATE: identity.at,
            }
          : {}),
      },
      stdio,
    },
  );
}

/** Run git with its standard output written to a new file, so no result sits in memory. */
export function gitToFile(
  directory: string,
  args: string[],
  input: Buffer | string | undefined,
  file: string,
) {
  const out = openSync(file, 'wx', 0o600);
  try {
    runGit(directory, args, input, undefined, MAX_SOURCE_BYTES, ['pipe', out, 'pipe']);
  } finally {
    closeSync(out);
  }
}

/** Run git with its standard input read from a file, so no input sits in memory. */
export function gitFromFile(directory: string, args: string[], file: string): Buffer {
  const input = openSync(file, 'r');
  try {
    return runGit(directory, args, undefined, undefined, MAX_SOURCE_BYTES, [input, 'pipe', 'pipe']);
  } finally {
    closeSync(input);
  }
}

/** Write one committed blob to a new file with no filters, streamed from git. */
export function blobToFile(repository: string, oid: string, file: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('Invalid blob identity.');
  gitToFile(repository, ['cat-file', 'blob', oid], undefined, file);
}

export function projectRoot(path: string): string {
  const selected = realpathSync(resolve(path));
  const root = realpathSync(git(selected, ['rev-parse', '--show-toplevel']).toString().trim());
  if (selected !== root) throw new Error('Select the repository root.');
  return root;
}

export function inspectSource(projectId: string, path: string): SourceFacts {
  return scanSource(projectId, path).source;
}

export function inspectSourceDetails(projectId: string, path: string) {
  const scanned = scanSource(projectId, path);
  const details: SourceDetails = {
    files: [],
    omittedDirty: scanned.source.dirtyCount,
    omittedUntracked: scanned.source.untrackedCount,
  };
  const seen = new Set<string>();
  const append = (file: SourceFileDetail) => {
    if (
      details.files.length === 200 ||
      seen.has(file.path) ||
      !SourceFileDetailSchema.safeParse(file).success
    )
      return;
    const next = {
      files: [...details.files, file],
      omittedDirty: details.omittedDirty - (file.status === 'untracked' ? 0 : 1),
      omittedUntracked: details.omittedUntracked - (file.status === 'untracked' ? 1 : 0),
    };
    if (!SourceDetailsSchema.safeParse(next).success) return;
    Object.assign(details, next);
    seen.add(file.path);
  };
  for (const file of scanned.files) append(file);
  for (const path of scanned.untracked)
    append({ path, status: 'untracked', staged: false, unstaged: true });
  return { source: scanned.source, details: SourceDetailsSchema.parse(details) };
}

function scanSource(projectId: string, path: string) {
  const base = git(path, ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  let branch = 'detached';
  try {
    branch = git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).toString().trim();
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
  // Raw bytes avoid repository filters. Transformed checkouts can show as changed.
  const baseEntries = new Map(
    git(path, ['ls-tree', '-rz', '--full-tree', base])
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const match = /^(\d{6}) \w+ ([a-f0-9]+)\t(.+)$/s.exec(record);
        if (!match) throw new Error('Source tree metadata is invalid.');
        return [match[3], `${match[1]} ${match[2]}`];
      }),
  );
  const dirty = new Set<string>();
  const files = new Map<string, SourceFileDetail>();
  const changed = (
    path: string,
    status: SourceFileDetail['status'],
    staged: boolean,
    unstaged: boolean,
  ) => {
    dirty.add(path);
    const previous = files.get(path);
    files.set(path, {
      path,
      status:
        previous?.status === 'unmerged' || (previous?.status === 'added' && status === 'modified')
          ? previous.status
          : status,
      staged: staged || previous?.staged || false,
      unstaged: unstaged || previous?.unstaged || false,
    });
  };
  const indexed = new Set<string>();
  const records = git(path, ['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean);
  for (const record of records) {
    const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t(.+)$/s.exec(record);
    if (!match) throw new Error('Source index metadata is invalid.');
    const [, mode, oid, stage, name] = match;
    indexed.add(name);
    if (stage !== '0' || baseEntries.get(name) !== `${mode} ${oid}`)
      changed(
        name,
        stage !== '0'
          ? 'unmerged'
          : !baseEntries.has(name)
            ? 'added'
            : baseEntries.get(name)?.split(' ')[0] !== mode
              ? 'type-changed'
              : 'modified',
        true,
        stage !== '0',
      );
    if (stage !== '0' || !['100644', '100755'].includes(mode)) {
      dirty.add(name);
      continue;
    }
    const parts = name.split('/');
    if (
      parts.some(
        (part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git',
      ) ||
      name.includes('\\')
    )
      throw new Error('Source index contains an unsupported path.');
    let readable = true;
    for (let index = 1; index < parts.length; index++) {
      try {
        const directory = lstatSync(join(path, ...parts.slice(0, index)));
        if (!directory.isDirectory() || directory.isSymbolicLink()) readable = false;
      } catch {
        readable = false;
      }
    }
    if (!readable) {
      changed(name, 'type-changed', false, true);
      continue;
    }
    let fd: number;
    try {
      const selected = lstatSync(join(path, name));
      if (!selected.isFile() || selected.isSymbolicLink()) {
        changed(name, 'type-changed', false, true);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        changed(name, 'deleted', false, true);
        continue;
      }
      throw error;
    }
    try {
      fd = openSync(
        join(path, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        changed(name, 'type-changed', false, true);
        continue;
      }
      throw error;
    }
    try {
      const state = fstatSync(fd);
      if (!state.isFile() || state.size > MAX_SOURCE_BYTES) {
        dirty.add(name);
        continue;
      }
      const bytes = readFileSync(fd);
      const digest = createHash(oid.length === 64 ? 'sha256' : 'sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      if (digest !== oid || (state.mode & 0o111 ? '100755' : '100644') !== mode)
        changed(name, 'modified', false, true);
    } finally {
      closeSync(fd);
    }
  }
  for (const name of baseEntries.keys())
    if (!indexed.has(name)) changed(name, 'deleted', true, false);
  const untracked = git(path, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString()
    .split('\0')
    .filter(Boolean);
  return {
    source: { projectId, base, branch, dirtyCount: dirty.size, untrackedCount: untracked.length },
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    untracked: untracked.sort(),
  };
}

export function safePath(path: string, seen: Set<string>, prefixes: Map<string, string>) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw new Error('Source contains an unsupported path.');
  const canonical = path.normalize('NFC').toLowerCase();
  if (seen.has(canonical) || prefixes.has(canonical))
    throw new Error('Source contains a path collision.');
  const parts = path.split('/');
  for (let end = 1; end <= parts.length; end++) {
    const prefix = parts.slice(0, end).join('/');
    const key = prefix.normalize('NFC').toLowerCase();
    if (
      (end < parts.length && seen.has(key)) ||
      (prefixes.has(key) && prefixes.get(key) !== prefix)
    )
      throw new Error('Source contains a directory collision.');
    prefixes.set(key, prefix);
  }
  seen.add(canonical);
}

function content(path: string, mode: FileEntry['mode'], bytes: Buffer): FileContent {
  return {
    path,
    mode,
    hash: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    content: bytes,
  };
}

/**
 * The regular files of a commit. The older task path refuses anything else. A chat scratch copy
 * (`scratch: true`) also holds links that stay inside it and lists the entries it cannot hold.
 */
export function committedFiles(path: string, base: string): FileContent[];
export function committedFiles(
  path: string,
  base: string,
  options: { scratch: true },
): CommittedSource;
export function committedFiles(
  path: string,
  base: string,
  options?: { scratch: true },
): FileContent[] | CommittedSource {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base))
    throw new Error('Invalid committed source identity.');
  const output = git(path, ['ls-tree', '-rz', '--full-tree', base]);
  if (options?.scratch) return scratchSource(path, output);
  const records = output.toString('utf8').split('\0').filter(Boolean);
  if (!Buffer.from(output.toString('utf8')).equals(output))
    throw new Error('Source paths must be UTF-8.');
  if (records.length > MAX_SOURCE_FILES) throw new Error('Source exceeds the file limit.');
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  const selected = records.map((record) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(record);
    if (!match) throw new Error('Source contains a symlink, submodule or unsupported mode.');
    const [, mode, oid, name] = match;
    safePath(name, seen, prefixes);
    return { mode: mode as FileEntry['mode'], oid, name };
  });
  const blobs = readBlobs(
    path,
    selected.map((file) => file.oid),
  );
  return selected.map(({ mode, name }, index) => content(name, mode, blobs[index]));
}

type ScratchClasses = {
  regular: { mode: FileEntry['mode']; oid: string; name: string }[];
  linked: { oid: string; name: string; raw: Buffer }[];
  // Blobs under paths the copy cannot name. The accepted tree still needs their bytes.
  encoded: KeptEntry[];
  skipped: SkippedEntry[];
  kept: KeptEntry[];
};

/** Sort a base tree into what the copy holds, what it holds as a link and what it leaves out. */
function classifyScratch(output: Buffer): ScratchClasses {
  const records: Buffer[] = [];
  for (let start = 0; start < output.length; ) {
    const end = output.indexOf(0, start);
    const stop = end < 0 ? output.length : end;
    if (stop > start) records.push(output.subarray(start, stop));
    start = stop + 1;
  }
  if (records.length > MAX_SCRATCH_FILES)
    throw new Error(
      `The base commit has ${records.length.toLocaleString('en-US')} files. A scratch copy holds at most ${MAX_SCRATCH_FILES.toLocaleString('en-US')}.`,
    );
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  const classes: ScratchClasses = { regular: [], linked: [], encoded: [], skipped: [], kept: [] };
  const { regular, linked, encoded, skipped, kept } = classes;
  for (const record of records) {
    const tab = record.indexOf(9);
    const match =
      tab < 0
        ? null
        : /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(
            record.subarray(0, tab).toString('latin1'),
          );
    if (!match || (match[1] === '160000') !== (match[2] === 'commit'))
      throw new Error('Source contains an unsupported mode.');
    const [, mode, , oid] = match;
    const raw = Buffer.from(record.subarray(tab + 1));
    let name: string;
    try {
      name = utf8.decode(raw);
    } catch {
      skipped.push({ path: raw.toString('utf8'), reason: 'path-encoding' });
      const entry = { path: raw, mode, oid, content: null };
      kept.push(entry);
      if (mode !== '160000') encoded.push(entry);
      continue;
    }
    safePath(name, seen, prefixes);
    if (mode === '160000') {
      skipped.push({ path: name, reason: 'submodule' });
      kept.push({ path: raw, mode, oid, content: null });
    } else if (mode === '120000') linked.push({ oid, name, raw });
    else regular.push({ mode: mode as FileEntry['mode'], oid, name });
  }
  return classes;
}

/** Settle the links once their targets are read. Returns the links the copy holds. */
function settleLinks(classes: ScratchClasses, blobs: readonly Buffer[]): LinkEntry[] {
  const { linked, skipped, kept } = classes;
  const candidates = new Map<string, LinkEntry>();
  linked.forEach(({ oid, name, raw }, index) => {
    const bytes = blobs[index];
    kept.push({ path: raw, mode: '120000', oid, content: bytes });
    let target: string;
    try {
      target = utf8.decode(bytes);
    } catch {
      skipped.push({ path: name, reason: 'path-encoding' });
      return;
    }
    candidates.set(name, { path: name, target });
  });
  const inside = insideLinks([...candidates.values()]);
  for (const name of candidates.keys())
    if (!inside.has(name)) skipped.push({ path: name, reason: 'link-outside' });
  skipped.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return [...inside.values()];
}

function scratchSource(path: string, output: Buffer): CommittedSource {
  const classes = classifyScratch(output);
  const { regular, linked, encoded } = classes;
  const blobs = readBlobs(
    path,
    [...regular, ...linked, ...encoded].map((entry) => entry.oid),
  );
  const files = regular.map(({ mode, name }, index) => content(name, mode, blobs[index]));
  encoded.forEach((entry, index) => {
    entry.content = blobs[regular.length + linked.length + index];
  });
  const links = settleLinks(classes, blobs.slice(regular.length, regular.length + linked.length));
  return { files, links, skipped: classes.skipped, kept: classes.kept };
}

/** A regular file of the base that the copy holds, with its size and no bytes. */
export type PlannedFile = FileEntry & { oid: string };
export type ScratchPlan = {
  files: PlannedFile[];
  links: LinkEntry[];
  skipped: SkippedEntry[];
  kept: KeptEntry[];
};

/**
 * The scratch copy's entries without the regular files' bytes. Links and entries the copy leaves
 * out follow the rules `committedFiles` applies with `scratch: true`. A regular file carries its
 * size, and an empty `hash`, because its identity is its `oid`. No byte limit applies to the
 * regular files; `readPlannedBlobs` reads them a few at a time.
 */
export function scratchPlan(path: string, base: string): ScratchPlan {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base))
    throw new Error('Invalid committed source identity.');
  const classes = classifyScratch(git(path, ['ls-tree', '-rz', '--full-tree', base]));
  const { regular, linked, encoded } = classes;
  const blobs = readBlobs(
    path,
    [...linked, ...encoded].map((entry) => entry.oid),
  );
  encoded.forEach((entry, index) => {
    entry.content = blobs[linked.length + index];
  });
  const links = settleLinks(classes, blobs.slice(0, linked.length));
  const sizes = blobSizes(
    path,
    regular.map((entry) => entry.oid),
  );
  const files = regular.map(({ mode, oid, name }, index) => ({
    path: name,
    mode,
    hash: '',
    bytes: sizes[index],
    oid,
  }));
  return { files, links, skipped: classes.skipped, kept: classes.kept };
}

function blobSizes(path: string, oids: readonly string[]): number[] {
  if (!oids.length) return [];
  let out: string;
  try {
    out = runGit(
      path,
      ['cat-file', '--batch-check'],
      `${oids.join('\n')}\n`,
      undefined,
      oids.length * 160 + 1024,
    ).toString('utf8');
  } catch {
    throw new Error(
      'A committed blob is unavailable locally. Fetch it outside this workspace and prepare again.',
    );
  }
  const lines = out.split('\n');
  return oids.map((oid, index) => {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (0|[1-9][0-9]*)$/.exec(lines[index] ?? '');
    if (!match || match[1] !== oid) throw Error('A committed blob is unavailable locally.');
    return Number(match[2]);
  });
}

/** The bytes of some planned files. The caller keeps the total of one call bounded. */
export function readPlannedBlobs(path: string, files: readonly PlannedFile[]): Buffer[] {
  return readBlobs(
    path,
    files.map((file) => file.oid),
    files.reduce((sum, file) => sum + file.bytes, 0),
  );
}

function readBlobs(path: string, oids: readonly string[], limit = MAX_SOURCE_BYTES): Buffer[] {
  if (!oids.length) return [];
  let batch: Buffer;
  try {
    batch = runGit(
      path,
      ['cat-file', '--batch'],
      `${oids.join('\n')}\n`,
      undefined,
      limit + oids.length * 96,
    );
  } catch {
    throw new Error(
      'A committed blob is unavailable locally. Fetch it outside this workspace and prepare again.',
    );
  }
  let offset = 0,
    total = 0;
  const blobs = oids.map((oid) => {
    const end = batch.indexOf(10, offset);
    if (end < offset || end - offset > 96) throw Error('Invalid committed blob response.');
    const header = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (0|[1-9][0-9]*)$/.exec(
      batch.subarray(offset, end).toString('utf8'),
    );
    if (!header || header[1] !== oid)
      throw Error('A committed blob is unavailable locally or changed identity.');
    const size = Number(header[2]);
    total += size;
    if (!Number.isSafeInteger(size) || total > limit) throw Error('Source exceeds the byte limit.');
    offset = end + 1;
    if (offset + size >= batch.length || batch[offset + size] !== 10)
      throw Error('Incomplete committed blob response.');
    const bytes = batch.subarray(offset, offset + size);
    offset += size + 1;
    return bytes;
  });
  if (offset !== batch.length) throw Error('Unexpected committed blob response.');
  return blobs;
}

const linkKey = (path: string) => path.normalize('NFC').toLowerCase();

/**
 * The links whose targets stay inside the copy. Each target is followed the way the kernel follows
 * it, through the other links that stay, so a `..` after a link starts where that link points. A
 * link that fails drops out and the rest are checked again until none drops. Lookups fold case and
 * normalization, because a case-insensitive volume reaches a link under either spelling.
 */
function insideLinks(links: readonly LinkEntry[]): Map<string, LinkEntry> {
  const live = new Map(links.map((link) => [linkKey(link.path), link]));
  for (let dropped = true; dropped; ) {
    dropped = false;
    for (const [key, link] of live)
      if (!resolvesInside(link, live)) {
        live.delete(key);
        dropped = true;
      }
  }
  return new Map([...live.values()].map((link) => [link.path, link]));
}

function plainTarget(target: string) {
  return (
    target.length > 0 &&
    Buffer.byteLength(target) < 4096 &&
    !target.includes('\0') &&
    !isAbsolute(target)
  );
}

function resolvesInside(link: LinkEntry, live: ReadonlyMap<string, LinkEntry>): boolean {
  let expansions = 0;
  const follow = (directory: readonly string[], target: string): string[] | null => {
    if (!plainTarget(target)) return null;
    const at = [...directory];
    for (const part of target.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!at.length) return null;
        at.pop();
        continue;
      }
      at.push(part);
      const nested = live.get(linkKey(at.join('/')));
      if (!nested) continue;
      if (++expansions > MAX_LINK_EXPANSIONS) return null;
      const resolved = follow(at.slice(0, -1), nested.target);
      if (!resolved) return null;
      at.splice(0, at.length, ...resolved);
    }
    return at;
  };
  return follow(link.path.split('/').slice(0, -1), link.target) !== null;
}

/** Base paths the copy reads from the base, by folded name. */
type ScratchScope = Map<string, { path: string }>;

function scratchScope(source: Pick<CommittedSource, 'kept'>): ScratchScope {
  const scope: ScratchScope = new Map();
  for (const entry of source.kept) {
    let path: string;
    try {
      path = utf8.decode(entry.path);
    } catch {
      continue;
    }
    scope.set(linkKey(path), { path });
  }
  return scope;
}

/**
 * The candidate files in a scratch copy. With the base's scratch source, paths the base holds as
 * links or skips are left out, so they always come from the base.
 */
export function readCandidateFiles(
  root: string,
  repository: string,
  base: string,
  source?: CommittedSource,
): FileContent[] {
  const original = source?.files ?? committedFiles(repository, base);
  return walkCandidates(
    root,
    original.map((file) => file.path),
    original.filter((file) => file.path.split('/').at(-1) === '.gitignore'),
    source && scratchScope(source),
    ({ path, mode, fd, total }) => {
      const bytes = readFileSync(fd);
      total(bytes.length);
      return content(path, mode, bytes);
    },
    MAX_SOURCE_BYTES,
  );
}

/** A candidate file of a scratch copy: its path, mode, size and the oid git would give it. */
export type CandidateHash = { path: string; mode: FileEntry['mode']; oid: string; bytes: number };

/**
 * The candidate files of a scratch copy by blob oid, with the rules `readCandidateFiles` applies
 * to links, special files, ignored paths and collisions. Each file streams through the hash, so no
 * byte limit applies and memory holds one chunk.
 */
export function hashCandidateFiles(
  root: string,
  repository: string,
  plan: ScratchPlan,
): CandidateHash[] {
  const rules = plan.files.filter((file) => file.path.split('/').at(-1) === '.gitignore');
  const blobs = readPlannedBlobs(repository, rules);
  const algorithm =
    git(repository, ['rev-parse', '--show-object-format']).toString('utf8').trim() === 'sha256'
      ? 'sha256'
      : 'sha1';
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  return walkCandidates(
    root,
    plan.files.map((file) => file.path),
    rules.map((file, index) => ({ path: file.path, content: blobs[index] })),
    scratchScope(plan),
    ({ path, mode, fd, size }) => {
      const hash = createHash(algorithm).update(`blob ${size}\0`);
      let read = 0;
      for (let count = 1; count > 0; ) {
        count = readSync(fd, chunk, 0, chunk.length, null);
        hash.update(chunk.subarray(0, count));
        read += count;
      }
      if (read !== size) throw new Error('A scratch file changed while it was read.');
      return { path, mode, oid: hash.digest('hex'), bytes: size };
    },
    null,
  );
}

type Taken = {
  path: string;
  mode: FileEntry['mode'];
  fd: number;
  size: number;
  /** Counts bytes a taker read against the walk's byte limit. */
  total: (bytes: number) => void;
};

function walkCandidates<T>(
  root: string,
  originalPaths: readonly string[],
  rules: readonly { path: string; content: Buffer }[],
  scope: ScratchScope | undefined,
  take: (file: Taken) => T,
  byteLimit: number | null,
): T[] {
  if (!rules.length) return walkScratch(root, undefined, scope, take, byteLimit);
  const tracked = new Set<string>();
  for (const path of [
    ...originalPaths,
    ...[...(scope?.values() ?? [])].map((entry) => entry.path),
  ]) {
    const parts = path.split('/');
    for (let end = 1; end <= parts.length; end++) tracked.add(parts.slice(0, end).join('/'));
  }
  const context = mkdtempSync(join(tmpdir(), 'crewkite-ignore-'));
  try {
    git(context, ['init', '--quiet', '--template=']);
    for (const rule of rules) {
      mkdirSync(dirname(join(context, rule.path)), { recursive: true });
      writeFileSync(join(context, rule.path), rule.content);
    }
    // Frozen rules exclude generated files without letting new ignore rules conceal edits.
    return walkScratch(
      root,
      (paths) => {
        const requested = new Map<string, string>();
        for (const path of paths) {
          const name = path.replace(/\/$/, '');
          safePath(name, new Set(), new Map());
          if (path.endsWith('/')) mkdirSync(join(context, name), { recursive: true });
          if (!tracked.has(name)) requested.set(name, path);
        }
        if (!requested.size) return new Set();
        let output: Buffer;
        try {
          output = git(
            context,
            ['check-ignore', '--no-index', '-z', '--stdin'],
            `${[...requested.keys()].join('\0')}\0`,
          );
        } catch (error) {
          if ((error as { status?: number }).status === 1) return new Set();
          throw error;
        }
        const ignored = output.toString('utf8').split('\0').filter(Boolean);
        if (
          !Buffer.from(output.toString('utf8')).equals(output) ||
          ignored.some((path) => !requested.has(path))
        )
          throw new Error('Invalid ignored source paths.');
        return new Set(ignored.map((path) => requested.get(path) as string));
      },
      scope,
      take,
      byteLimit,
    );
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

export function readFiles(root: string): FileContent[] {
  return walkScratch(
    root,
    undefined,
    undefined,
    ({ path, mode, fd, total }) => {
      const bytes = readFileSync(fd);
      total(bytes.length);
      return content(path, mode, bytes);
    },
    MAX_SOURCE_BYTES,
  );
}

function walkScratch<T>(
  root: string,
  ignored: ((paths: string[]) => Set<string>) | undefined,
  scope: ScratchScope | undefined,
  take: (file: Taken) => T,
  byteLimit: number | null,
): T[] {
  const rootState = lstatSync(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink())
    throw new Error('Scratch root is not an independent directory.');
  const files: T[] = [];
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  const limit = scope ? MAX_SCRATCH_FILES : MAX_SOURCE_FILES;
  // A copy file that would sit over or under a base path is a collision.
  for (const { path } of scope?.values() ?? []) safePath(path, seen, prefixes);
  let total = 0;
  function visit(directory: string) {
    const entries = readdirSync(directory)
      .sort()
      .map((name) => {
        if (name.toLowerCase() === '.git') throw new Error('Scratch Git metadata is unsupported.');
        const file = join(directory, name);
        const path = relative(root, file).split('\\').join('/');
        return { file, path, state: lstatSync(file) };
      })
      // Accept takes these paths from the base whatever the copy holds, so a held link the copy
      // replaced or deleted is left out here and Changes reports it.
      .filter(({ path }) => !scope?.has(linkKey(path)));
    const excluded = ignored?.(
      entries.map(({ path, state }) => path + (state.isDirectory() ? '/' : '')),
    );
    for (const { file, path, state } of entries) {
      if (excluded?.has(path + (state.isDirectory() ? '/' : ''))) continue;
      if (state.isSymbolicLink()) throw new Error('Scratch contains an unsupported symlink.');
      if (state.isDirectory()) {
        visit(file);
        continue;
      }
      if (!state.isFile()) throw new Error('Scratch contains an unsupported special file.');
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.mode & 0o6000)
          throw new Error('Scratch contains an unsupported file mode.');
        if (files.length >= limit)
          throw new ScratchTooLarge(
            `The scratch copy holds more than ${limit.toLocaleString('en-US')} files, the most CrewKite compares.`,
          );
        if (byteLimit !== null && opened.size + total > byteLimit)
          throw new Error('Scratch exceeds the source limit.');
        safePath(path, seen, prefixes);
        files.push(
          take({
            path,
            mode: opened.mode & 0o111 ? '100755' : '100644',
            fd,
            size: opened.size,
            total: (bytes) => {
              total += bytes;
              if (byteLimit !== null && total > byteLimit)
                throw new Error('Scratch exceeds the source byte limit.');
            },
          }),
        );
      } finally {
        closeSync(fd);
      }
    }
  }
  visit(root);
  return files;
}

function sourceManifest(expected: readonly FileEntry[]): string {
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  let total = 0;
  if (expected.length > 10000) throw new Error('Replacement source exceeds the file limit.');
  for (const file of expected) {
    if (
      !['100644', '100755'].includes(file.mode) ||
      !/^[a-f0-9]{64}$/.test(file.hash) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    )
      throw new Error('Replacement source metadata is invalid.');
    safePath(file.path, seen, prefixes);
    total += file.bytes;
    if (total > MAX_SOURCE_BYTES) throw new Error('Replacement source exceeds the byte limit.');
  }
  return JSON.stringify(
    expected
      .map(({ path, mode, hash, bytes }) => ({ path, mode, hash, bytes }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  );
}

export function captureSingleFileEdit(input: {
  directory: string;
  manifest: readonly FileEntry[];
  target: { path: string; baseHash: string };
}): { files: FileContent[]; target: FileEntry & { baseHash: string } } {
  sourceManifest(input.manifest);
  safePath(input.target.path, new Set(), new Map());
  const original = input.manifest.find((file) => file.path === input.target.path);
  if (!original || original.hash !== input.target.baseHash || original.bytes > 65_536)
    throw Error('Capture target identity changed.');
  const files = readFiles(input.directory);
  const target = files.find((file) => file.path === original.path);
  if (!target || target.mode !== original.mode || target.bytes > 65_536)
    throw Error('Capture target metadata changed.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(target.content);
  if (text.includes('\0')) throw Error('Capture needs NUL-free UTF-8 text.');
  if (
    sourceManifest(files.filter((file) => file.path !== original.path)) !==
    sourceManifest(input.manifest.filter((file) => file.path !== original.path))
  )
    throw Error('Capture source manifest changed.');
  const { path, mode, hash, bytes } = target;
  return { files, target: { path, mode, hash, bytes, baseHash: original.hash } };
}

export function applyReplacement(
  root: string,
  expected: readonly FileEntry[],
  replacement: { path: string; baseHash: string; content: string },
) {
  safePath(replacement.path, new Set(), new Map());
  if (typeof replacement.content !== 'string' || replacement.content.length > 65_536)
    throw new Error('Replacement must be bounded UTF-8 text.');
  const bytes = Buffer.from(replacement.content, 'utf8');
  if (
    bytes.length > 65_536 ||
    bytes.toString('utf8') !== replacement.content ||
    replacement.content.includes('\0')
  )
    throw new Error('Replacement must be bounded UTF-8 text.');
  const expectedManifest = sourceManifest(expected);
  if (sourceManifest(readFiles(root)) !== expectedManifest)
    throw new Error('Replacement source manifest changed.');
  const target = expected.find((file) => file.path === replacement.path);
  if (!target || target.hash !== replacement.baseHash)
    throw new Error('Replacement target identity changed.');
  // Open without truncation so every precondition can fail without changing the file.
  const fd = openSync(
    join(root, target.path),
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const state = fstatSync(fd);
    if (
      !state.isFile() ||
      state.nlink !== 1 ||
      state.mode & 0o6000 ||
      state.size !== target.bytes ||
      (state.mode & 0o111 ? '100755' : '100644') !== target.mode
    )
      throw new Error('Replacement target metadata changed.');
    const original = readFileSync(fd);
    if (
      original.length !== target.bytes ||
      createHash('sha256').update(original).digest('hex') !== target.hash
    )
      throw new Error('Replacement target bytes changed.');
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written, written);
      if (count === 0) throw new Error('Replacement write made no progress.');
      written += count;
    }
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function materialize(
  root: string,
  files: readonly (FileEntry | FileContent)[],
  links: readonly LinkEntry[] = [],
  /** Puts one file's bytes at its path. The default writes them. A caller may clone them instead. */
  write: (file: FileEntry | FileContent, target: string) => void = writeScratchFile,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (
    !lstatSync(root).isDirectory() ||
    lstatSync(root).isSymbolicLink() ||
    readdirSync(root).length
  )
    throw new Error('A scratch copy needs a new empty directory.');
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  // Links are checked before anything is written and created last. No file sits under a link, so
  // every write below goes through real directories only.
  for (const link of links) safePath(link.path, seen, prefixes);
  if (insideLinks(links).size !== links.length)
    throw new Error('A scratch link leads outside the copy.');
  for (const file of files) {
    safePath(file.path, seen, prefixes);
    if ('content' in file && createHash('sha256').update(file.content).digest('hex') !== file.hash)
      throw new Error('Source content identity changed.');
    mkdirSync(dirname(join(root, file.path)), { recursive: true, mode: 0o700 });
    write(file, join(root, file.path));
    chmodSync(join(root, file.path), file.mode === '100755' ? 0o755 : 0o644);
  }
  for (const link of links) {
    mkdirSync(dirname(join(root, link.path)), { recursive: true, mode: 0o700 });
    symlinkSync(link.target, join(root, link.path));
  }
}

function writeScratchFile(file: FileEntry | FileContent, target: string) {
  if (!('content' in file)) throw new Error('A scratch file needs its bytes.');
  writeFileSync(target, file.content, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
}

/**
 * Put one of the base's links back in a scratch copy. The base's links pass the checks materialize
 * runs, and the caller has walked the real directories down to the link's folder. Every entry at
 * that name goes first, under any spelling a case-insensitive volume would match.
 */
export function restoreLink(root: string, links: readonly LinkEntry[], path: string) {
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const link of links) safePath(link.path, seen, prefixes);
  const inside = insideLinks(links);
  const link = inside.get(path);
  if (!link || inside.size !== links.length)
    throw new Error('A scratch link leads outside the copy.');
  const directory = dirname(join(root, link.path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = linkKey(link.path);
  const folder = dirname(link.path);
  for (const name of readdirSync(directory))
    if (linkKey(folder === '.' ? name : `${folder}/${name}`) === key)
      rmSync(join(directory, name), { recursive: true, force: true });
  symlinkSync(link.target, join(root, link.path));
}

/**
 * Write a tree of `files` in a new repository. `kept` entries from a scratch source go in from the
 * base unchanged, with their blobs imported and checked against the base identities.
 */
export function treeFromFiles(
  repository: string,
  files: readonly FileContent[],
  kept?: readonly KeptEntry[],
): string {
  if (files.length + (kept?.length ?? 0) > (kept ? MAX_SCRATCH_FILES : MAX_SOURCE_FILES))
    throw Error('Source exceeds the file limit.');
  const seen = new Set<string>(),
    prefixes = new Map<string, string>();
  let total = 0;
  for (const entry of kept ?? []) {
    if (
      !['100644', '100755', '120000', '160000'].includes(entry.mode) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.oid) ||
      (entry.mode === '160000') !== (entry.content === null) ||
      entry.path.includes(0) ||
      !entry.path.length
    )
      throw Error('Source contains an unsupported kept entry.');
    let name: string | null;
    try {
      name = utf8.decode(entry.path);
    } catch {
      name = null;
    }
    if (name !== null) safePath(name, seen, prefixes);
    total += entry.content?.length ?? 0;
    if (total > MAX_SOURCE_BYTES) throw Error('Source exceeds the byte limit.');
  }
  for (const file of files) {
    safePath(file.path, seen, prefixes);
    if (!['100644', '100755'].includes(file.mode) || !Buffer.isBuffer(file.content))
      throw Error('Source contains an unsupported file.');
    total += file.content.length;
    if (total > MAX_SOURCE_BYTES) throw Error('Source exceeds the byte limit.');
  }
  const blobs = [
    ...files.map((file) => file.content),
    ...(kept ?? []).flatMap((entry) => (entry.content ? [entry.content] : [])),
  ];
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  git(repository, ['init', '--quiet']);
  git(repository, ['read-tree', '--empty']);
  const commands = blobs.flatMap((blob, index) => [
    Buffer.from(`blob\nmark :${index + 1}\ndata ${blob.length}\n`),
    blob,
    Buffer.from(`\nget-mark :${index + 1}\n`),
  ]);
  const imported = blobs.length
    ? git(
        repository,
        ['fast-import', '--quiet', '--done'],
        Buffer.concat([...commands, Buffer.from('done\n')]),
      )
        .toString('utf8')
        .trim()
        .split('\n')
    : [];
  if (
    imported.length !== blobs.length ||
    imported.some(
      (oid) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || oid.length !== imported[0].length,
    )
  )
    throw Error('Invalid imported blob identities.');
  let next = files.length;
  const entries = [
    ...files.map((file, index) => Buffer.from(`${file.mode} ${imported[index]}\t${file.path}\0`)),
    ...(kept ?? []).map((entry) => {
      if (entry.content && imported[next++] !== entry.oid)
        throw Error('A kept source entry changed identity.');
      return Buffer.concat([
        Buffer.from(`${entry.mode} ${entry.oid}\t`),
        entry.path,
        Buffer.from([0]),
      ]);
    }),
  ];
  git(repository, ['update-index', '-z', '--index-info'], Buffer.concat(entries));
  return git(repository, ['write-tree']).toString().trim();
}

/**
 * The tree a chat acceptance commits, built without reading unchanged files. The new repository
 * borrows the project's objects, so a candidate that matches the base by oid and mode points at the
 * base's blob and only a changed file is written. Kept entries go in as the base has them. The
 * same path, mode and count rules as `treeFromFiles` apply.
 */
export function treeFromScratch(input: {
  repository: string;
  source: string;
  scratch: string;
  plan: ScratchPlan;
  candidates: readonly CandidateHash[];
  /** Bytes that replace a scratch file in the tree, by path. Each candidate oid names them. */
  contents?: ReadonlyMap<string, Buffer>;
}): string {
  const { plan, candidates } = input;
  if (candidates.length + plan.kept.length > MAX_SCRATCH_FILES)
    throw new ScratchTooLarge(
      `The scratch copy holds more than ${MAX_SCRATCH_FILES.toLocaleString('en-US')} files, the most CrewKite compares.`,
    );
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const entry of plan.kept) {
    if (
      !['100644', '100755', '120000', '160000'].includes(entry.mode) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.oid) ||
      (entry.mode === '160000') !== (entry.content === null) ||
      entry.path.includes(0) ||
      !entry.path.length
    )
      throw Error('Source contains an unsupported kept entry.');
    let name: string | null;
    try {
      name = utf8.decode(entry.path);
    } catch {
      name = null;
    }
    if (name !== null) safePath(name, seen, prefixes);
  }
  for (const file of candidates) {
    safePath(file.path, seen, prefixes);
    if (!['100644', '100755'].includes(file.mode))
      throw Error('Source contains an unsupported file.');
  }
  const objects = git(input.source, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'objects',
  ])
    .toString('utf8')
    .trim();
  mkdirSync(input.repository, { recursive: true, mode: 0o700 });
  git(input.repository, ['init', '--quiet']);
  mkdirSync(join(input.repository, '.git', 'objects', 'info'), { recursive: true });
  writeFileSync(join(input.repository, '.git', 'objects', 'info', 'alternates'), `${objects}\n`);
  git(input.repository, ['read-tree', '--empty']);
  const held = new Map(plan.files.map((file) => [file.path, file]));
  const entries: Buffer[] = [];
  for (const file of candidates) {
    const base = held.get(file.path);
    const replaced = input.contents?.get(file.path);
    if (
      !(base && base.oid === file.oid && base.mode === file.mode) &&
      !hasObject(input.repository, file.oid)
    ) {
      const written = (
        replaced
          ? git(input.repository, ['hash-object', '-w', '--no-filters', '--stdin'], replaced)
          : git(input.repository, [
              'hash-object',
              '-w',
              '--no-filters',
              '--',
              join(input.scratch, file.path),
            ])
      )
        .toString('utf8')
        .trim();
      if (written !== file.oid) throw Error('A scratch file changed while it was read.');
    }
    entries.push(Buffer.from(`${file.mode} ${file.oid}\t${file.path}\0`));
  }
  for (const entry of plan.kept)
    entries.push(
      Buffer.concat([Buffer.from(`${entry.mode} ${entry.oid}\t`), entry.path, Buffer.from([0])]),
    );
  git(input.repository, ['update-index', '-z', '--index-info'], Buffer.concat(entries));
  return git(input.repository, ['write-tree']).toString().trim();
}

function hasObject(repository: string, oid: string): boolean {
  try {
    git(repository, ['cat-file', '-e', oid]);
    return true;
  } catch {
    return false;
  }
}
