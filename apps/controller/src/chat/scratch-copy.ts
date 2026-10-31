import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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
  /** Writes one file larger than a run straight to its target, so its bytes never sit in memory. */
  stream?: (file: FileEntry, target: string) => void;
  /** The most bytes one `read` call asks for, apart from a single larger file. */
  chunkBytes?: number;
  /** Free bytes on the disk that holds a path. Tests pass their own. */
  free?: (path: string) => number;
};

const CHUNK_BYTES = 32 * 1024 * 1024;
// The free space a copy leaves on the disk, so the computer and the turn's own writes keep room.
const HEADROOM_BYTES = 1024 * 1024 * 1024;
// How many written bytes pass between checks of free space while files are written out.
const ROOM_CHECK_BYTES = 256 * 1024 * 1024;

/** The disk lacks room for a copy. The message names what the copy needs and what is free. */
export class ScratchNoRoom extends Error {}

/** Bytes free to this process on the disk that holds `path` or its nearest existing folder. */
export function freeBytes(path: string): number {
  let at = path;
  for (;;) {
    try {
      const stats = statfsSync(at);
      return stats.bavail * stats.bsize;
    } catch (error) {
      const parent = dirname(at);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === at) throw error;
      at = parent;
    }
  }
}

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

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
  const checked = new Set<string>();
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
  const free = options.free ?? freeBytes;
  // A clone takes no new space, so a copy that may clone checks only the headroom up front. Once
  // it writes, from the start or after the volume refused a clone, it checks what is left to copy.
  const room = (needed: number) => {
    const available = free(directory);
    if (available < needed + HEADROOM_BYTES)
      throw new ScratchNoRoom(
        `The scratch copy of ${name} needs about ${gigabytes(needed + HEADROOM_BYTES)} free, counting 1 GB of room to spare, and the disk has ${gigabytes(available)}.${process.platform === 'darwin' ? ' Finder can show more, because it counts space macOS can purge.' : ''} Free some space and send the message again.`,
      );
  };
  room(cloning ? 0 : total);
  try {
    return fill();
  } catch (error) {
    // A copy that stopped part way is never used, and on a full disk its bytes are what is short.
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  function fill() {
    let restChecked = !cloning;
    let checkedAt = 0;
    let writtenBytes = 0;
    materialize(directory, files, links, (file, target) => {
      if (cloning && options.checkout && cloneOne(options.checkout.root, file, target)) cloned++;
      else {
        // The volume just refused a clone, so every byte left is written.
        if (!cloning && !restChecked) {
          restChecked = true;
          room(total - bytes);
        }
        rmSync(target, { force: true });
        if (!('content' in file) && options.stream && file.bytes > chunkBytes) {
          room(file.bytes);
          options.stream(file, target);
        } else writeFileSync(target, bytesOf(file), { flag: 'wx', mode: 0o600 });
        written++;
        writtenBytes += file.bytes;
        if (writtenBytes - checkedAt >= ROOM_CHECK_BYTES) {
          checkedAt = writtenBytes;
          room(0);
        }
      }
      bytes += file.bytes;
      if (bytes - reported >= PROGRESS_BYTES) {
        reported = bytes;
        options.onProgress?.({ name, bytes, total });
      }
    });
    options.onProgress?.({ name, bytes: total, total });
    return { cloned, written };
  }

  function cloneOne(root: string, file: FileEntry | FileContent, target: string): boolean {
    try {
      // Every folder on the way is a real folder of the checkout, so a swapped link leads nowhere.
      const parts = file.path.split('/');
      for (let end = 1; end < parts.length; end++) {
        const folder = parts.slice(0, end).join('/');
        if (checked.has(folder)) continue;
        const state = lstatSync(join(root, folder));
        if (!state.isDirectory() || state.isSymbolicLink()) return false;
        checked.add(folder);
      }
      const source = join(root, file.path);
      const state = lstatSync(source);
      // A link or a file of another size is not the committed file, so it is written instead.
      if (!state.isFile() || state.size !== file.bytes) return false;
      clone(source, target);
      // git may not have seen an edit (assume-unchanged, skip-worktree), and the checkout may have
      // changed since the check. The clone is fixed now, so it must match the committed bytes.
      if (matchesCommitted(file, target)) return true;
      rmSync(target, { force: true });
      return false;
    } catch (error) {
      if (UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) cloning = false;
      rmSync(target, { force: true });
      return false;
    }
  }
}

/** Whether the file at `path` has the bytes the base holds for `file`, hashed as they stream. */
function matchesCommitted(file: FileEntry | FileContent, path: string): boolean {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    if (size !== file.bytes) return false;
    const oid = 'oid' in file ? (file as FileEntry & { oid: string }).oid : null;
    // A planned file is identified by its blob oid and a loaded one by its sha256.
    const hash = oid
      ? createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${size}\0`)
      : createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (let count = 1; count > 0; ) {
      count = readSync(fd, chunk, 0, chunk.length, null);
      hash.update(chunk.subarray(0, count));
    }
    return hash.digest('hex') === (oid ?? file.hash);
  } finally {
    closeSync(fd);
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
