import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { basename } from 'node:path';
import { Worker } from 'node:worker_threads';
import { timed } from '../diagnostics/timing.ts';

// Client binaries run from 100 MB to 400 MB. The profiles, the version reads and every launch need
// their digest, and hashing the whole file each time held the controller's event loop for seconds
// on every workspace read. One digest is kept per file identity. A write, chmod, link, rename over
// or replacement changes the inode, size, mtime or ctime, so a matching identity names the bytes
// that were hashed.
// shortcut: a filesystem with coarse timestamps could hide a same-size rewrite inside one tick.
// Upgrade: skip reuse while ctime is within two seconds of the hash.

const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Reads go in pieces of this size, which take a few milliseconds each. */
export const DIGEST_PIECE_BYTES = 8 * 1024 * 1024;

/** Files above this size are hashed in a worker thread when the caller can wait. */
export const WORKER_DIGEST_BYTES = 16 * 1024 * 1024;

export function fileIdentity(state: BigIntStats): string {
  return [state.dev, state.ino, state.size, state.mtimeNs, state.ctimeNs].join(':');
}

const pathIdentity = (path: string) => fileIdentity(lstatSync(path, { bigint: true }));

const digests = new Map<string, { identity: string; sha256: string }>();
const running = new Map<string, Promise<string>>();

/**
 * The sha256 of a regular file that must keep `identity` from open to close. The descriptor and
 * the path are both checked after the last read, so a file replaced or rewritten while it was read
 * never yields a digest.
 */
export function digestHeldFile(path: string, identity: string): string {
  const descriptor = openSync(path, flags);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || fileIdentity(before) !== identity)
      throw new Error('File changed before reading.');
    const size = Number(before.size);
    const hash = createHash('sha256');
    const piece = Buffer.allocUnsafe(Math.max(1, Math.min(size, DIGEST_PIECE_BYTES)));
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, piece, 0, Math.min(piece.length, size - offset), null);
      if (count === 0) throw new Error('File changed while reading.');
      hash.update(piece.subarray(0, count));
      offset += count;
    }
    const trailing = readSync(descriptor, Buffer.alloc(1), 0, 1, null);
    if (
      trailing !== 0 ||
      fileIdentity(fstatSync(descriptor, { bigint: true })) !== identity ||
      pathIdentity(path) !== identity
    )
      throw new Error('File changed while reading.');
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

export type DigestOptions = {
  /** False hashes again even when the identity matches. The new digest is still kept. */
  reuse?: boolean;
  /** Reads the file for its digest. Tests pass one that counts. */
  read?: (path: string, identity: string) => string;
};

/**
 * The digest of the file at `path`, a real path. A known identity answers from the cache. A new
 * one is hashed here, on the calling thread, for callers that cannot wait.
 */
export function fileDigestSync(path: string, options: DigestOptions = {}): string {
  const identity = pathIdentity(path);
  const known = digests.get(path);
  if (options.reuse !== false && known?.identity === identity) return known.sha256;
  const sha256 = timed(`hash ${basename(path)} sync`, () =>
    (options.read ?? digestHeldFile)(path, identity),
  );
  digests.set(path, { identity, sha256 });
  return sha256;
}

/**
 * The same digest for callers that can wait. A large file is hashed in a worker thread, so the
 * controller keeps answering its socket on a cold cache. Callers asking for the same identity at
 * once share one read.
 */
export async function fileDigest(path: string, options: DigestOptions = {}): Promise<string> {
  const state = lstatSync(path, { bigint: true });
  const identity = fileIdentity(state);
  const known = digests.get(path);
  if (options.reuse !== false && known?.identity === identity) return known.sha256;
  const slot = `${path}\0${identity}`;
  let pending = running.get(slot);
  if (!pending) {
    const read = options.read;
    pending = timed(`hash ${basename(path)} async`, () =>
      read
        ? Promise.resolve().then(() => read(path, identity))
        : state.size > BigInt(WORKER_DIGEST_BYTES)
          ? digestInWorker(path, identity)
          : Promise.resolve().then(() => digestHeldFile(path, identity)),
    ).finally(() => running.delete(slot));
    running.set(slot, pending);
  }
  const sha256 = await pending;
  digests.set(path, { identity, sha256 });
  return sha256;
}

// The worker is a plain source file beside this one. The package copies every controller source
// file, and its Node runs TypeScript sources the same way it runs the controller entry.
function digestInWorker(path: string, identity: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./file-digest-worker.ts', import.meta.url), {
      workerData: { path, identity },
    });
    worker.once('message', (value: unknown) =>
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
        ? resolve(value)
        : reject(new Error('The digest worker answered without a digest.')),
    );
    worker.once('error', reject);
    worker.once('exit', () => reject(new Error('The digest worker stopped without a digest.')));
  });
}
