import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  writeFileSync,
} from 'node:fs';
import { devNull } from 'node:os';
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
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export function git(
  directory: string,
  args: string[],
  input?: Buffer | string,
  identity?: { name: string; email: string; at: string },
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
      maxBuffer: MAX_SOURCE_BYTES,
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
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
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

export function committedFiles(path: string, base: string): FileContent[] {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base))
    throw new Error('Invalid committed source identity.');
  const output = git(path, ['ls-tree', '-rz', '--full-tree', base]);
  const records = output.toString('utf8').split('\0').filter(Boolean);
  if (!Buffer.from(output.toString('utf8')).equals(output))
    throw new Error('Source paths must be UTF-8.');
  if (records.length > 10000) throw new Error('Source exceeds the file limit.');
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  let total = 0;
  return records.map((record) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(record);
    if (!match) throw new Error('Source contains a symlink, submodule or unsupported mode.');
    const [, mode, oid, name] = match;
    safePath(name, seen, prefixes);
    let bytes: Buffer;
    try {
      bytes = git(path, ['cat-file', 'blob', oid]);
    } catch {
      throw new Error(
        'A committed blob is unavailable locally. Fetch it outside this workspace and prepare again.',
      );
    }
    total += bytes.length;
    if (total > MAX_SOURCE_BYTES) throw new Error('Source exceeds the byte limit.');
    return content(name, mode as FileEntry['mode'], bytes);
  });
}

export function readFiles(root: string): FileContent[] {
  const rootState = lstatSync(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink())
    throw new Error('Scratch root is not an independent directory.');
  const files: FileContent[] = [];
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  let total = 0;
  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const path = relative(root, file).split('\\').join('/');
      const state = lstatSync(file);
      if (state.isSymbolicLink()) throw new Error('Scratch contains an unsupported symlink.');
      if (state.isDirectory()) {
        if (name.toLowerCase() === '.git') throw new Error('Scratch Git metadata is unsupported.');
        visit(file);
        continue;
      }
      if (!state.isFile()) throw new Error('Scratch contains an unsupported special file.');
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.mode & 0o6000)
          throw new Error('Scratch contains an unsupported file mode.');
        if (opened.size + total > MAX_SOURCE_BYTES || files.length >= 10000)
          throw new Error('Scratch exceeds the source limit.');
        safePath(path, seen, prefixes);
        const bytes = readFileSync(fd);
        total += bytes.length;
        if (total > MAX_SOURCE_BYTES) throw new Error('Scratch exceeds the source byte limit.');
        files.push(content(path, opened.mode & 0o111 ? '100755' : '100644', bytes));
      } finally {
        closeSync(fd);
      }
    }
  }
  visit(root);
  return files;
}

export function materialize(root: string, files: readonly FileContent[]) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (
    !lstatSync(root).isDirectory() ||
    lstatSync(root).isSymbolicLink() ||
    readdirSync(root).length
  )
    throw new Error('A scratch copy needs a new empty directory.');
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const file of files) {
    safePath(file.path, seen, prefixes);
    if (createHash('sha256').update(file.content).digest('hex') !== file.hash)
      throw new Error('Source content identity changed.');
    mkdirSync(dirname(join(root, file.path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, file.path), file.content, {
      flag: 'wx',
      mode: file.mode === '100755' ? 0o755 : 0o644,
    });
    chmodSync(join(root, file.path), file.mode === '100755' ? 0o755 : 0o644);
  }
}

export function treeFromFiles(repository: string, files: readonly FileContent[]): string {
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  git(repository, ['init', '--quiet']);
  git(repository, ['read-tree', '--empty']);
  const entries = files.map((file) => {
    const oid = git(repository, ['hash-object', '-w', '--stdin'], file.content).toString().trim();
    return `${file.mode} ${oid}\t${file.path}\0`;
  });
  git(repository, ['update-index', '-z', '--index-info'], entries.join(''));
  return git(repository, ['write-tree']).toString().trim();
}
