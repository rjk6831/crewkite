import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  canonicalJson,
  HashSchema,
  NativeTargetPathSchema,
  ProjectIdSchema,
} from '@crewkite/contracts';
import { git, safePath } from '../host/source.ts';

const MAX_FILE_BYTES = 8192;
const MAX_BUNDLE_BYTES = 32768;
const MAX_FILES = 32;
type Selection = { kind: 'source-file' | 'source-folder' | 'log-file'; path: string };
type ContextFile = {
  kind: 'source' | 'log';
  path: string;
  mode: '100644' | '100755';
  hash: string;
  bytes: number;
  text: string;
};
export type ConversationContextBundle = {
  version: 1;
  projectId: string;
  base: string;
  files: readonly ContextFile[];
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const forbidden = (path: string) =>
  path
    .split('/')
    .some(
      (part) =>
        /^(?:\.git|\.hg|\.svn|node_modules|\.pnpm|\.yarn|\.ssh|\.aws|\.azure|\.gnupg|\.config|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa.*|id_ed25519.*)$/i.test(
          part,
        ) || /\.(?:pem|key|p12|pfx|keystore|keychain(?:-db)?)$/i.test(part),
    );

function validatePath(path: string) {
  NativeTargetPathSchema.parse(path);
  safePath(path, new Set(), new Map());
  if (path.split('/').length > 16 || Buffer.byteLength(path) > 1024 || forbidden(path))
    throw Error('The selected context path is excluded or exceeds its bounds.');
}

function file(kind: ContextFile['kind'], path: string, mode: ContextFile['mode'], bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES)
    throw Error('A context file must contain between 1 and 8192 bytes.');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (
    !text.isWellFormed() ||
    [...text].some((character) => {
      const point = character.codePointAt(0) as number;
      return (point < 32 && ![9, 10, 13].includes(point)) || (point >= 127 && point <= 159);
    }) ||
    !Buffer.from(text).equals(bytes)
  )
    throw Error('Context needs UTF-8 text without binary control bytes.');
  return { kind, path, mode, hash: hash(bytes), bytes: bytes.length, text } satisfies ContextFile;
}

function identity(state: BigIntStats) {
  return [
    state.dev,
    state.ino,
    state.mode,
    state.uid,
    state.nlink,
    state.size,
    state.gid,
    state.ctimeNs,
    state.mtimeNs,
  ].join(':');
}

function readLog(root: string, path: string): ContextFile {
  const parts = path.split('/');
  if (parts.some((part) => part.startsWith('.')))
    throw Error('Log context cannot read hidden files or directories.');
  const parents = [
    root,
    ...parts.slice(0, -1).map((_, index) => join(root, ...parts.slice(0, index + 1))),
  ];
  const before = parents.map((parent) => {
    const state = lstatSync(parent, { bigint: true });
    if (!state.isDirectory() || state.isSymbolicLink())
      throw Error('Context parents must be real project directories.');
    return identity(state);
  });
  const selected = join(root, path);
  const state = lstatSync(selected, { bigint: true });
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1n ||
    state.mode & 0o6000n ||
    state.size > BigInt(MAX_FILE_BYTES)
  )
    throw Error('A selected log must be an independent bounded regular file.');
  const fd = openSync(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (identity(opened) !== identity(state))
      throw Error('The selected log changed before reading.');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (
      BigInt(count) !== opened.size ||
      identity(fstatSync(fd, { bigint: true })) !== identity(opened) ||
      identity(lstatSync(selected, { bigint: true })) !== identity(opened) ||
      parents.some(
        (parent, index) => identity(lstatSync(parent, { bigint: true })) !== before[index],
      )
    )
      throw Error('The selected log or its project path changed while reading.');
    return file('log', path, opened.mode & 0o111n ? '100755' : '100644', bytes.subarray(0, count));
  } finally {
    closeSync(fd);
  }
}

/** Captured text is input data. Selecting it grants no filesystem or execution authority. */
export function captureConversationContext(input: {
  projectRoot: string;
  projectId: string;
  base: string;
  selections: readonly Selection[];
}) {
  ProjectIdSchema.parse(input.projectId);
  if (!/^[a-f0-9]{40}$/.test(input.base) || !isAbsolute(input.projectRoot))
    throw Error('Context needs a registered project and exact committed base.');
  const root = resolve(input.projectRoot);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory())
    throw Error('Context needs a real registered project directory.');
  if (
    realpathSync(git(root, ['rev-parse', '--show-toplevel']).toString().trim()) !== root ||
    git(root, ['rev-parse', '--verify', `${input.base}^{commit}`])
      .toString()
      .trim() !== input.base
  )
    throw Error('Context must use the registered repository root and exact commit.');
  if (input.selections.length < 1 || input.selections.length > 4)
    throw Error('Select between one and four context items.');
  const selections = input.selections.map((selection) => {
    if (!['source-file', 'source-folder', 'log-file'].includes(selection.kind))
      throw Error('The context selection kind is unsupported.');
    if (selection.path !== '' || selection.kind !== 'source-folder') validatePath(selection.path);
    if (
      relative(root, resolve(root, selection.path)) === '..' ||
      relative(root, resolve(root, selection.path)).startsWith('../')
    )
      throw Error('Context must remain inside its registered project.');
    return selection;
  });
  if (new Set(selections.map((value) => `${value.kind}:${value.path}`)).size !== selections.length)
    throw Error('Context selections must be distinct.');
  const source = selections.filter((selection) => selection.kind !== 'log-file');
  const files = new Map<string, ContextFile>();
  if (source.length) {
    const paths = source.some((selection) => selection.path === '')
      ? []
      : source.map((selection) => `:(literal)${selection.path}`);
    const metadata = git(root, ['ls-tree', '-rz', '--full-tree', input.base, '--', ...paths]);
    const encoded = metadata.toString('utf8');
    if (!Buffer.from(encoded).equals(metadata)) throw Error('Context paths must be UTF-8.');
    const records = encoded.split('\0').filter(Boolean);
    if (records.length > MAX_FILES) throw Error('Selected context exceeds 32 files.');
    const entries = records.map((record) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(record);
      if (!match) throw Error('Selected source contains a link, submodule or unsupported mode.');
      const [, mode, oid, path] = match;
      validatePath(path);
      return { mode: mode as ContextFile['mode'], oid, path };
    });
    for (const selection of source)
      if (
        !entries.some((entry) =>
          selection.kind === 'source-file'
            ? entry.path === selection.path
            : selection.path === '' || entry.path.startsWith(`${selection.path}/`),
        )
      )
        throw Error('A selected source item is absent from the committed base.');
    const query = `${entries.map((entry) => entry.oid).join('\n')}\n`;
    const sizes = git(root, ['cat-file', '--batch-check'], query)
      .toString('utf8')
      .trim()
      .split('\n');
    if (
      sizes.length !== entries.length ||
      sizes.some((row, index) => {
        const match = /^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/.exec(row);
        return !match || match[1] !== entries[index].oid || Number(match[2]) > MAX_FILE_BYTES;
      })
    )
      throw Error('A selected source blob is unavailable or exceeds 8192 bytes.');
    const bytes = git(root, ['cat-file', '--batch'], query);
    let offset = 0;
    entries.forEach((entry, index) => {
      const header = Buffer.from(`${sizes[index]}\n`);
      if (!bytes.subarray(offset, offset + header.length).equals(header))
        throw Error('The committed context blob response changed.');
      offset += header.length;
      const count = Number(sizes[index].split(' ')[2]);
      const content = bytes.subarray(offset, offset + count);
      offset += count;
      if (content.length !== count || bytes[offset++] !== 10)
        throw Error('The committed context blob response is incomplete.');
      files.set(entry.path, file('source', entry.path, entry.mode, content));
    });
    if (offset !== bytes.length) throw Error('The committed context blob response has extra data.');
  }
  for (const selection of selections.filter((value) => value.kind === 'log-file')) {
    if (files.has(selection.path)) throw Error('Select a path as either source or log context.');
    files.set(selection.path, readLog(root, selection.path));
  }
  if (!files.size || files.size > MAX_FILES) throw Error('Context needs between one and 32 files.');
  const ordered = [...files.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const seen = new Set<string>(),
    prefixes = new Map<string, string>();
  for (const entry of ordered) safePath(entry.path, seen, prefixes);
  const bundle: ConversationContextBundle = Object.freeze({
    version: 1,
    projectId: input.projectId,
    base: input.base,
    files: Object.freeze(ordered.map((entry) => Object.freeze(entry))),
  });
  const content = Buffer.from(canonicalJson(bundle));
  if (content.length > MAX_BUNDLE_BYTES)
    throw Error('The complete encoded context exceeds 32768 bytes.');
  return { bundle, content, hash: HashSchema.parse(hash(content)), bytes: content.length };
}
