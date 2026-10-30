import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const LIMIT = 256;

/**
 * Whether the first-run welcome has ended, one small file in the desktop profile. A missing,
 * linked, special, oversized or corrupt file reads as not finished, and the welcome still hides
 * itself for a person who already has a project.
 */
export class OnboardingStore {
  private readonly path: string;
  constructor(profile: string) {
    this.path = join(profile, 'onboarding.json');
  }
  finished(): boolean {
    let file: number;
    try {
      file = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return false;
    }
    try {
      const state = fstatSync(file);
      if (!state.isFile() || state.size > LIMIT) return false;
      const bytes = Buffer.alloc(state.size);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(file, bytes, count, bytes.length - count, null);
        if (read === 0) break;
        count += read;
      }
      const value: unknown = JSON.parse(bytes.subarray(0, count).toString('utf8'));
      return (
        value !== null &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).finished === true
      );
    } catch {
      return false;
    } finally {
      closeSync(file);
    }
  }
  setFinished(finished: boolean) {
    const next = `${this.path}.next`;
    // A stale file from an interrupted write has no authority, so it is removed first.
    try {
      unlinkSync(next);
    } catch {}
    const file = openSync(
      next,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(file, JSON.stringify({ finished }));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(next, this.path);
  }
}
