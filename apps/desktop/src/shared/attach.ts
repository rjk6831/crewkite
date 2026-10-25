import type { DesktopFile } from '@crewkite/client';

// The one request shape main takes for composer files. Main runs this on every request because the
// renderer is not trusted, and the preload runs `desktopFiles` on every answer.

export type AttachRequest =
  | { from: 'picker' }
  | { from: 'clipboard' }
  | { from: 'paths'; paths: string[] };

/** A message holds at most 32 files, so one request never needs more. */
export const MAX_ATTACH_FILES = 32;
const MAX_PATH_LENGTH = 4096;
/** A 96 pixel PNG fits well under this. A larger answer is dropped and the chip shows the name. */
export const MAX_THUMBNAIL_LENGTH = 128 * 1024;

const absolute = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_PATH_LENGTH &&
  !value.includes('\0') &&
  (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value));

export function attachRequest(value: unknown): AttachRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if ((input.from === 'picker' || input.from === 'clipboard') && keys.length === 1)
    return { from: input.from };
  if (
    input.from === 'paths' &&
    keys.length === 2 &&
    Array.isArray(input.paths) &&
    input.paths.length >= 1 &&
    input.paths.length <= MAX_ATTACH_FILES &&
    input.paths.every(absolute)
  )
    return { from: 'paths', paths: [...input.paths] };
  return null;
}

const desktopFile = (value: unknown): value is DesktopFile => {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return (
    absolute(file.path) &&
    typeof file.name === 'string' &&
    file.name.length > 0 &&
    file.name.length <= 255 &&
    typeof file.bytes === 'number' &&
    Number.isSafeInteger(file.bytes) &&
    file.bytes >= 0 &&
    (file.thumbnail === null ||
      (typeof file.thumbnail === 'string' &&
        file.thumbnail.length <= MAX_THUMBNAIL_LENGTH &&
        file.thumbnail.startsWith('data:image/png;base64,')))
  );
};

export function desktopFiles(value: unknown): DesktopFile[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACH_FILES || !value.every(desktopFile))
    throw new Error('The file answer from the desktop is invalid.');
  return value.map(({ path, name, bytes, thumbnail }) => ({ path, name, bytes, thumbnail }));
}
