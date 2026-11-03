import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundledMigrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const uncertain = () => new Error('The database schema could not be checked without writes.');

function openExisting(path: string) {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function readAt(file: number, bytes: number, position: number) {
  const buffer = Buffer.alloc(bytes);
  if (readSync(file, buffer, 0, bytes, position) !== bytes) throw uncertain();
  return buffer;
}

function snapshot(path: string) {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

function sameState(before: BigIntStats | undefined, after: BigIntStats | undefined) {
  if (!before || !after) return before === after;
  return (['dev', 'ino', 'size', 'mode', 'nlink', 'uid', 'mtimeNs', 'ctimeNs'] as const).every(
    (key) => before[key] === after[key],
  );
}

function unchanged(file: number, path: string, before: BigIntStats) {
  if (!sameState(before, fstatSync(file, { bigint: true })) || !sameState(before, snapshot(path)))
    throw uncertain();
}

/** SQLite read-only connections can still create WAL sidecars. Inspect file headers directly. */
export function assertSchemaCompatibility(path: string, directory = bundledMigrations) {
  const maximum = readdirSync(directory).filter((name) =>
    /^\d{3}-[a-z0-9-]+\.sql$/.test(name),
  ).length;
  const sidecars = ['-wal', '-shm', '-journal'].map((suffix) => ({
    path: `${path}${suffix}`,
    before: snapshot(`${path}${suffix}`),
  }));
  if (sidecars.some(({ before }) => before && (!before.isFile() || before.nlink !== 1n)))
    throw uncertain();
  const journal = sidecars[2].before;
  // A hot rollback journal can restore an older page one during SQLite open. Leave recovery
  // to a compatible controller, without deciding here whether the journal is still hot.
  if (journal && journal.size !== 0n) throw uncertain();
  const checkSidecars = () => {
    if (sidecars.some((sidecar) => !sameState(sidecar.before, snapshot(sidecar.path))))
      throw uncertain();
  };
  const file = openExisting(path);
  if (file === undefined) {
    if (sidecars.some((sidecar) => sidecar.before) || snapshot(path)) throw uncertain();
    checkSidecars();
    return;
  }
  try {
    const before = fstatSync(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw uncertain();
    let version = 0;
    if (before.size !== 0n) {
      const header = readAt(file, 100, 0);
      if (header.toString('ascii', 0, 16) !== 'SQLite format 3\0') throw uncertain();
      version = header.readUInt32BE(60);
    }
    if (version > maximum) throw new Error('The database needs a newer controller.');
    const wal = openExisting(`${path}-wal`);
    if (wal !== undefined) {
      try {
        const walBefore = fstatSync(wal, { bigint: true });
        if (!walBefore.isFile() || walBefore.nlink !== 1n) throw uncertain();
        if (walBefore.size !== 0n) {
          const header = readAt(wal, 32, 0);
          const magic = header.readUInt32BE(0);
          const pageSize = header.readUInt32BE(8);
          if (
            ![0x377f0682, 0x377f0683].includes(magic) ||
            header.readUInt32BE(4) !== 3007000 ||
            pageSize < 512 ||
            pageSize > 65536 ||
            (pageSize & (pageSize - 1)) !== 0
          )
            throw uncertain();
          if ((Number(walBefore.size) - 32) % (24 + pageSize) !== 0) throw uncertain();
          const frames = Math.floor((Number(walBefore.size) - 32) / (24 + pageSize));
          if (frames > 1_000_000) throw uncertain();
          for (let index = 0; index < frames; index++) {
            const offset = 32 + index * (24 + pageSize);
            const frame = readAt(wal, 24, offset);
            if (
              frame.readUInt32BE(0) !== 1 ||
              !frame.subarray(8, 16).equals(header.subarray(16, 24))
            )
              continue;
            // Include uncommitted page-one frames conservatively. A newer writer must reconcile
            // them; an older controller cannot safely decide that their schema is disposable.
            const page = readAt(wal, 100, offset + 24);
            if (page.toString('ascii', 0, 16) !== 'SQLite format 3\0') throw uncertain();
            version = Math.max(version, page.readUInt32BE(60));
            if (version > maximum) throw new Error('The database needs a newer controller.');
          }
        }
        unchanged(wal, `${path}-wal`, walBefore);
      } finally {
        closeSync(wal);
      }
    }
    unchanged(file, path, before);
    checkSidecars();
  } finally {
    closeSync(file);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('Choose a database path.');
    assertSchemaCompatibility(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The database schema check failed.');
    process.exitCode = 1;
  }
}
