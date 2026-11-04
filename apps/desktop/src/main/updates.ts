import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREWKITE_VERSION } from '@crewkite/contracts/version';
import { type BrowserWindow, dialog, session, shell } from 'electron';
import {
  isNewer,
  LATEST,
  LAUNCH_CHECK_DELAY_MS,
  launchCheckDue,
  type Memory,
  offerOnLaunch,
  parseRelease,
  type Release,
} from './update-check.ts';

class UpdateMemory {
  private readonly file: string;
  constructor(profile: string) {
    this.file = join(profile, 'updates.json');
  }
  read(): Memory {
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Memory>;
      return {
        checkedAt: Number.isFinite(value.checkedAt) ? Number(value.checkedAt) : 0,
        skipped: typeof value.skipped === 'string' ? value.skipped : null,
      };
    } catch {
      return { checkedAt: 0, skipped: null };
    }
  }
  write(memory: Memory) {
    try {
      writeFileSync(this.file, `${JSON.stringify(memory)}\n`, { mode: 0o600 });
    } catch {}
  }
}

async function latestRelease(): Promise<Release | null> {
  // The window's session refuses every request outside the app, so the check uses its own
  // in-memory session that keeps nothing.
  const response = await session.fromPartition('crewkite-updates').fetch(LATEST, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CrewKite' },
  });
  // No published release yet means this build is the latest one.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`status ${response.status}`);
  return parseRelease(await response.json());
}

async function offer(window: BrowserWindow, release: Release): Promise<boolean> {
  if (window.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: 'info',
    message: `CrewKite ${release.version} is available`,
    detail: `You have ${CREWKITE_VERSION}. The download page lists what changed.`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return false;
  await shell.openExternal(release.url).catch(() => {});
  return true;
}

/**
 * Check for Updates in the app menu, and one quiet check a day after launch. A newer release
 * opens its download page in the browser; installing stays with the person for now.
 */
export function installUpdateChecks(window: BrowserWindow, profile: string) {
  const memory = new UpdateMemory(profile);
  let busy = false;
  const manual = async () => {
    if (busy || window.isDestroyed()) return;
    busy = true;
    try {
      const release = await latestRelease().catch(() => undefined);
      memory.write({ ...memory.read(), checkedAt: Date.now() });
      if (window.isDestroyed()) return;
      if (release === undefined)
        await dialog.showMessageBox(window, {
          type: 'warning',
          message: 'CrewKite could not check for updates',
          detail: 'Check your internet connection and try again.',
          buttons: ['OK'],
          noLink: true,
        });
      else if (release && isNewer(release.version, CREWKITE_VERSION)) await offer(window, release);
      else
        await dialog.showMessageBox(window, {
          type: 'info',
          message: 'CrewKite is up to date',
          detail: `You have ${CREWKITE_VERSION}, the latest release.`,
          buttons: ['OK'],
          noLink: true,
        });
    } finally {
      busy = false;
    }
  };
  const timer = setTimeout(async () => {
    const saved = memory.read();
    if (busy || window.isDestroyed() || !launchCheckDue(saved, Date.now())) return;
    busy = true;
    try {
      const release = await latestRelease().catch(() => null);
      memory.write({ ...saved, checkedAt: Date.now() });
      if (
        release &&
        offerOnLaunch(saved, release, CREWKITE_VERSION) &&
        !(await offer(window, release))
      )
        memory.write({ checkedAt: Date.now(), skipped: release.version });
    } finally {
      busy = false;
    }
  }, LAUNCH_CHECK_DELAY_MS);
  timer.unref();
  window.on('closed', () => clearTimeout(timer));
  return { check: () => void manual() };
}
