import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Where a thread's scratch copy lives under the controller home. A client that keeps a list of
// saved sessions groups them by working folder and shows the folder's name, so a new thread's copy
// is named after its project, as in chat/<task>/demo-shop. A thread whose copy already exists keeps
// `scratch`. The first turn records the name beside the copy, so a project renamed later moves
// nothing, and every reader finds the copy by that record. A thread without a record uses
// `scratch`, which covers every thread made before the record existed.

const LEGACY = 'scratch';
const RECORD = 'scratch-name';
// Names other entries under chat/<task> use. A project named like one of them keeps `scratch`.
const RESERVED = new Set([LEGACY, RECORD, 'files', 'turns', 'sessions', 'slices', 'discard.json']);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const usable = (name: string) =>
  name.length <= 60 && SLUG.test(name) && !RESERVED.has(name) && !name.startsWith('accept-');

/** The folder name for a new thread's copy: a short slug of the project name, or `scratch`. */
export function scratchFolderName(projectName: string): string {
  const slug = projectName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return usable(slug) ? slug : LEGACY;
}

/** The thread's scratch copy: the recorded folder, or `scratch` when there is no record. */
export function chatScratchDirectory(home: string, taskId: string): string {
  const folder = join(home, 'chat', taskId);
  let name = LEGACY;
  try {
    const recorded = readFileSync(join(folder, RECORD), 'utf8').trim();
    if (usable(recorded)) name = recorded;
  } catch {
    // No record: a thread from before the record existed, or one whose copy is not made yet.
  }
  return join(folder, name);
}

/**
 * Fix the folder before the first copy is made and return the copy's path. A thread that already
 * has a record or a `scratch` folder keeps it, so a partial copy from an interrupted first turn
 * and every older thread stay where they are.
 */
export function claimScratchDirectory(home: string, taskId: string, projectName: string): string {
  const folder = join(home, 'chat', taskId);
  if (existsSync(join(folder, RECORD)) || existsSync(join(folder, LEGACY)))
    return chatScratchDirectory(home, taskId);
  const name = scratchFolderName(projectName);
  if (name !== LEGACY) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, RECORD), name, { mode: 0o600 });
  }
  return join(folder, name);
}
