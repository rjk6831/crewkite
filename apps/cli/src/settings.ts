import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type CliSettings, CliSettingsSchema } from '@crewkite/contracts';

// The CLI's own settings live in cli.json in the CrewKite home. A file that is missing, too large
// or fails the schema leaves the defaults in force, and the CLI says which. A save never writes a
// value the schema refuses.

export const SETTINGS_FILE = 'cli.json';
const MAX_SETTINGS_BYTES = 65_536;

export const defaultSettings = (): CliSettings => CliSettingsSchema.parse({});

export function crewkiteHome(flag?: string): string {
  return resolve(flag ?? process.env.CREWKITE_HOME ?? join(homedir(), '.crewkite'));
}

export type LoadedSettings = { settings: CliSettings; problem: string | null };

export function loadSettings(home: string): LoadedSettings {
  let file: number;
  try {
    file = openSync(
      join(home, SETTINGS_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { settings: defaultSettings(), problem: null };
    return { settings: defaultSettings(), problem: `${SETTINGS_FILE} could not be opened.` };
  }
  try {
    const state = fstatSync(file);
    if (!state.isFile() || state.size > MAX_SETTINGS_BYTES)
      return { settings: defaultSettings(), problem: `${SETTINGS_FILE} is not a small file.` };
    const parsed = CliSettingsSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (parsed.success) return { settings: parsed.data, problem: null };
    const where = parsed.error.issues[0]?.path.join('.') || 'the file';
    return {
      settings: defaultSettings(),
      problem: `${SETTINGS_FILE} has a value CrewKite does not take at ${where}. Defaults apply.`,
    };
  } catch {
    return { settings: defaultSettings(), problem: `${SETTINGS_FILE} is not valid JSON.` };
  } finally {
    closeSync(file);
  }
}

/** Writes the whole file through a temporary file and a rename, private to its owner. */
export function saveSettings(home: string, next: CliSettings): CliSettings {
  const settings = CliSettingsSchema.parse(next);
  const temporary = join(home, `.${SETTINGS_FILE}.${randomUUID()}`);
  const file = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  try {
    renameSync(temporary, join(home, SETTINGS_FILE));
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  return settings;
}

const preferenceKeys = {
  thread: 'crewkite-thread-defaults-v1',
  family: 'crewkite-family-models-v1',
  crew: 'crewkite-crew-presets-v1',
} as const;

/**
 * The desktop keeps thread defaults, family models and crew presets in browser storage under three
 * keys. This store answers those keys from cli.json, so the renderer's preference functions run
 * unchanged in the terminal. A write goes through the schema and then to `save`.
 */
export function settingsStore(
  read: () => CliSettings,
  save: (next: CliSettings) => void,
): { getItem(key: string): string | null; setItem(key: string, value: string): void } {
  return {
    getItem(key) {
      const settings = read();
      if (key === preferenceKeys.thread)
        return JSON.stringify({
          selection: settings.selection,
          permissionPolicy: settings.permissionPolicy,
          handoffMode: settings.handoffMode,
        });
      if (key === preferenceKeys.family) return JSON.stringify(settings.familyModels);
      if (key === preferenceKeys.crew) return JSON.stringify(settings.crewPresets);
      return null;
    },
    setItem(key, value) {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const current = read();
      const next =
        key === preferenceKeys.thread
          ? { ...current, ...parsed }
          : key === preferenceKeys.family
            ? { ...current, familyModels: parsed }
            : key === preferenceKeys.crew
              ? { ...current, crewPresets: parsed }
              : null;
      if (next) save(CliSettingsSchema.parse(next));
    },
  };
}
