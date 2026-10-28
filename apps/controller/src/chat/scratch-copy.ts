import { constants, copyFileSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FileContent,
  type FileEntry,
  git,
  type LinkEntry,
  materialize,
} from '../host/source.ts';
import type { ImportProgress } from './files.ts';

/** Put one checkout file at a new path as a copy-on-write clone. It throws when it cannot. */
export type CloneFile = (from: string, to: string) => void;

// FORCE makes an unsupported volume fail instead of quietly copying every byte.
export const reflink: CloneFile = (from, to) =>
  copyFileSync(from, to, constants.COPYFILE_FICLONE_FORCE);

// Codes that say the volume or the pair of volumes cannot clone. Later files skip the attempt.
const UNSUPPORTED = new Set(['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'EPERM']);
// The same step as a file import, so a large copy sends one update per 4 MiB.
const PROGRESS_BYTES = 4 * 1024 * 1024;

export type ScratchCopyOptions = {
  /** The person's checkout. Without it, or when it differs from the base, every file is written. */
  checkout?: { root: string; base: string };
  clone?: CloneFile;
  onProgress?: (progress: ImportProgress) => void;
  /** Names the copy in progress updates. */
  name?: string;
  /** Reads the bytes of files that came without any, such as a few planned blobs. */
  read?: (files: readonly FileEntry[]) => Buffer[];
  /** The most bytes one `read` call asks for, apart from a single larger file. */
  chunkBytes?: number;
};

const CHUNK_BYTES = 32 * 1024 * 1024;

/**
 * Fill a new empty scratch directory with the base's files and links. The rules for paths, links
 * and collisions are the ones `materialize` applies. When the checkout sits on the base with no
 * tracked change, a file whose size matches the base's is cloned from the checkout and any other
 * file is written from the committed bytes. The first sign that the volume cannot clone ends the
 * attempts, and the rest of the copy is written. Returns how many files each way produced.
 */
export function copyScratch(
  directory: string,
  files: readonly (FileEntry | FileContent)[],
  links: readonly LinkEntry[],
  options: ScratchCopyOptions = {},
): { cloned: number; written: number } {
  const clone = options.clone ?? reflink;
  let cloning = options.checkout ? onBase(options.checkout) : false;
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const name = options.name ?? 'repository';
  let cloned = 0;
  let written = 0;
  let bytes = 0;
  let reported = 0;
  // Files without bytes are read in runs, so memory holds one run and never the whole base.
  let run = new Map<string, Buffer>();
  const bytesOf = (file: FileEntry | FileContent): Buffer => {
    if ('content' in file) return file.content;
    if (!run.has(file.path)) {
      if (!options.read) throw new Error('A scratch file needs its bytes.');
      const from = files.indexOf(file);
      const chunk: FileEntry[] = [];
      for (let at = from, size = 0; at < files.length; at++) {
        const next = files[at];
        if ('content' in next || (chunk.length && size + next.bytes > chunkBytes)) break;
        chunk.push(next);
        size += next.bytes;
      }
      const blobs = options.read(chunk);
      run = new Map(chunk.map((entry, index) => [entry.path, blobs[index]]));
    }
    const bytes = run.get(file.path) as Buffer;
    run.delete(file.path);
    return bytes;
  };
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  materialize(directory, files, links, (file, target) => {
    if (cloning && options.checkout && cloneOne(options.checkout.root, file, target)) cloned++;
    else {
      rmSync(target, { force: true });
      writeFileSync(target, bytesOf(file), { flag: 'wx', mode: 0o600 });
      written++;
    }
    bytes += file.bytes;
    if (bytes - reported >= PROGRESS_BYTES) {
      reported = bytes;
      options.onProgress?.({ name, bytes, total });
    }
  });
  options.onProgress?.({ name, bytes: total, total });
  return { cloned, written };

  function cloneOne(root: string, file: FileEntry, target: string): boolean {
    try {
      const source = join(root, file.path);
      const state = lstatSync(source);
      // A link or a file of another size is not the committed file, so it is written instead.
      if (!state.isFile() || state.size !== file.bytes) return false;
      clone(source, target);
      return true;
    } catch (error) {
      if (UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) cloning = false;
      return false;
    }
  }
}

/** Whether HEAD is the base and git sees no change to a tracked file. */
function onBase({ root, base }: { root: string; base: string }): boolean {
  try {
    if (git(root, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim() !== base) return false;
    return git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).length === 0;
  } catch {
    return false;
  }
}
