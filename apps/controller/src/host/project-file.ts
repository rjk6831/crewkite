import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Files a person keeps in the project and CrewKite writes after they confirm a change, such as a
// design system or a recipe. Each feature words its own refusals, so the caller turns a problem
// into the error it throws.

/** The most bytes read from one project file. */
export const PROJECT_FILE_BYTES = 1024 * 1024;

export type ProjectFileProblem =
  | { kind: 'folder-unavailable' }
  | { kind: 'path-unsafe' }
  | { kind: 'too-large' }
  | { kind: 'write-failed'; code: string };
export type ProjectFileRefusal = (problem: ProjectFileProblem) => Error;

/**
 * The file, or the folder, for a project-relative path. The contracts already refuse `..`,
 * absolute paths and `.git`. A link anywhere on the way could still lead out of the project, so
 * any link refuses. A part that does not exist yet ends the walk.
 */
export function projectFile(
  root: string,
  path: string,
  refuse: ProjectFileRefusal,
  as: 'file' | 'folder' = 'file',
) {
  let base: string;
  try {
    base = realpathSync.native(root);
  } catch {
    throw refuse({ kind: 'folder-unavailable' });
  }
  const parts = path.split('/');
  for (let end = 1; end <= parts.length; end++) {
    const state = lstatSync(join(base, ...parts.slice(0, end)), { throwIfNoEntry: false });
    if (!state) break;
    const file = end === parts.length && as === 'file';
    if (state.isSymbolicLink() || (file ? !state.isFile() : !state.isDirectory()))
      throw refuse({ kind: 'path-unsafe' });
  }
  return join(base, ...parts);
}

/** The file's text, or undefined when it does not exist. */
export function readText(file: string, refuse: ProjectFileRefusal) {
  const state = lstatSync(file, { throwIfNoEntry: false });
  if (!state) return undefined;
  if (state.size > PROJECT_FILE_BYTES) throw refuse({ kind: 'too-large' });
  return readFileSync(file, 'utf8');
}

/**
 * A crash mid-write leaves the old file or the new one, never half of either. Missing parent
 * folders are created, and `projectFile` already held every existing one to the project.
 */
export function writeAtomically(file: string, text: string, refuse: ProjectFileRefusal) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o644 });
    renameSync(temporary, file);
  } catch (failure) {
    rmSync(temporary, { force: true });
    throw refuse({
      kind: 'write-failed',
      code: (failure as NodeJS.ErrnoException).code ?? 'unknown error',
    });
  }
}
