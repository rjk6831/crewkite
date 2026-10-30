import { closeSync, constants, fsyncSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { type DiagnosticFile, DiagnosticsReadSchema } from '@crewkite/contracts';

/**
 * Writes the bundle as a new folder holding one file per part. The folder must not exist yet and
 * its parent must, so a save never replaces anything. A failure removes the folder it made.
 */
export function writeDiagnosticsFolder(files: readonly DiagnosticFile[], destination: string) {
  const bundle = DiagnosticsReadSchema.parse({ files });
  try {
    mkdirSync(destination, { mode: 0o700 });
  } catch (failure) {
    throw new Error(
      (failure as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'That folder already exists. Choose a name that is not taken.'
        : 'The folder could not be made there. Choose another place.',
    );
  }
  try {
    for (const part of bundle.files) {
      const file = openSync(
        join(destination, part.name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(file, part.text);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
    }
  } catch {
    rmSync(destination, { recursive: true, force: true });
    throw new Error('The files could not be written there. Choose another place.');
  }
}
