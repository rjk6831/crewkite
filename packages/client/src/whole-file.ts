import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Puts `text` at `path` so the file there is either the old one or the new one, whole. The text
 * goes to a new file beside the target and is renamed over it, and a rename never writes through
 * a link. A target that exists must open for writing as a regular file with one name: a link of
 * either kind, a folder, a pipe or a file the person cannot write is refused before anything is
 * written. A new file is created at 0600 and an existing one keeps its mode. Throws on a refusal
 * or a failed write, and then the target is as it was.
 */
export function replaceFile(path: string, text: string): void {
  let mode = 0o600;
  try {
    // No O_CREAT: a missing target is fine, and a dangling link must not be created through.
    const target = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const status = fstatSync(target);
      if (!status.isFile() || status.nlink !== 1)
        throw new Error('The target is not a plain file.');
      mode = status.mode & 0o777;
    } finally {
      closeSync(target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const beside = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const file = openSync(
    beside,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    try {
      // The open's mode passes through the umask. An existing file keeps the mode it had.
      fchmodSync(file, mode);
      writeFileSync(file, text);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(beside, path);
  } catch (error) {
    try {
      unlinkSync(beside);
    } catch {}
    throw error;
  }
  // The rename is durable once its folder is. A folder that cannot be opened loses nothing.
  try {
    const folder = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(folder);
    } finally {
      closeSync(folder);
    }
  } catch {}
}
