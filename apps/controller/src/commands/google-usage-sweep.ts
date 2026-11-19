import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Google usage reads create two folders directly under the controller home and never remove them
// (see launchGoogleUsage). Once no Google operation can own one, recovery clears what is left.
// Only the exact shapes mkdtemp makes qualify. Setup folders, native client homes and credentials
// never match. Age is not evidence of anything here, so it is never read.

const SHAPE = /^google-usage-(?:tmp-)?[A-Za-z0-9]{6}$/;
export const SWEEP_BATCH = 32;

export type UsageSweep = { removed: number; failed: number };

/** True for a folder this process created: a real directory, ours, with no group or other access. */
function removable(home: string, name: string): boolean {
  const path = join(home, name);
  const info = lstatSync(path);
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o077) === 0 &&
    realpathSync(path) === path
  );
}

/**
 * Removes leftover usage folders in batches. `quiet` is asked before every batch and the sweep
 * stops the moment it answers false, so a read that starts mid-sweep keeps its folders. A folder
 * that matches the name but fails a check or cannot be removed counts as failed and stays. Only
 * counts come back. Names and contents are never kept. A later run picks up what is left.
 */
export function sweepGoogleUsageDirectories(
  home: string,
  quiet: () => boolean,
  batch = SWEEP_BATCH,
): UsageSweep {
  const result: UsageSweep = { removed: 0, failed: 0 };
  if (!quiet()) return result;
  // Resolving once makes the containment check below compare against the real home.
  const root = realpathSync(home);
  const names = readdirSync(root)
    .filter((name) => SHAPE.test(name))
    .sort();
  for (let start = 0; start < names.length; start += batch) {
    if (!quiet()) break;
    for (const name of names.slice(start, start + batch)) {
      try {
        if (!removable(root, name)) throw new Error();
        rmSync(join(root, name), { recursive: true });
        result.removed++;
      } catch {
        result.failed++;
      }
    }
  }
  return result;
}
