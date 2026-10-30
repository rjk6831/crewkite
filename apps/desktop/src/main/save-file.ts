import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { syncDirectory } from './receipts.ts';

/**
 * Save text where the person chose. The bytes go to a new file beside the destination, which is
 * flushed and then renamed over it, so a failed write leaves an existing file as it was. The
 * temporary file is created new, never through a link, with owner-only access.
 */
export function saveTextFile(destination: string, text: string) {
  const temporary = join(dirname(destination), `.crewkite-save-${randomUUID()}`);
  const file = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let open = true;
  try {
    writeFileSync(file, text);
    fsyncSync(file);
    closeSync(file);
    open = false;
    renameSync(temporary, destination);
  } catch (failure) {
    if (open) closeSync(file);
    try {
      unlinkSync(temporary);
    } catch {}
    throw failure;
  }
  syncDirectory(dirname(destination));
}
