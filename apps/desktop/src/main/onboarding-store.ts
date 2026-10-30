import { closeSync, constants, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserWindow, ipcMain } from 'electron';
import { assertSender } from './security.ts';

/**
 * Whether the first-run welcome has ended, one small file in the desktop profile. A missing,
 * unreadable or oversized file reads as not finished, and the welcome still hides itself for a
 * person who already has a project and a connected provider.
 */
export class OnboardingStore {
  private readonly path: string;
  constructor(profile: string) {
    this.path = join(profile, 'onboarding.json');
  }
  finished(): boolean {
    try {
      const text = readFileSync(this.path, { encoding: 'utf8' });
      if (text.length > 256) return false;
      const value: unknown = JSON.parse(text);
      return (
        value !== null &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).finished === true
      );
    } catch {
      return false;
    }
  }
  setFinished(finished: boolean) {
    const next = `${this.path}.next`;
    const file = openSync(next, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    try {
      writeSync(file, JSON.stringify({ finished }));
    } finally {
      closeSync(file);
    }
    renameSync(next, this.path);
  }
}

export function installOnboarding(window: BrowserWindow, store: OnboardingStore) {
  for (const channel of ['read', 'write']) ipcMain.removeHandler(`crewkite:onboarding-${channel}`);
  ipcMain.handle('crewkite:onboarding-read', (event) => {
    assertSender(event, window);
    return store.finished();
  });
  ipcMain.handle('crewkite:onboarding-write', (event, finished: unknown) => {
    assertSender(event, window);
    if (typeof finished !== 'boolean') throw new Error('The welcome flag is invalid.');
    store.setFinished(finished);
  });
}
