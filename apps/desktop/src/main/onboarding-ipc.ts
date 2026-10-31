import { type BrowserWindow, ipcMain } from 'electron';
import type { OnboardingStore } from './onboarding-store.ts';
import { assertSender } from './security.ts';

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
