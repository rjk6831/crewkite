import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function prepareStateDirectory(root: string, path: string) {
  const base = realpathSync(root);
  const destination = resolve(path);
  const suffix = relative(base, destination);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
    throw new Error('Demo state must stay inside its selected repository directory.');
  let current = base;
  for (const part of suffix.split(sep)) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const state = lstatSync(current);
    if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.())
      throw new Error('Demo state directories must be owned directories without symlinks.');
  }
  if (realpathSync(current) !== destination) throw new Error('The demo state path changed.');
  chmodSync(destination, 0o700);
  return destination;
}

export function syncDirectory(path: string) {
  const file = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}
