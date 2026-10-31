import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { appendControllerLog } from './log.ts';
import { redactDiagnosticText } from './redact.ts';

// A crash record is one small JSON file under <home>/crashes. It holds what the person would
// read in a bug report: when, which part, what kind, a short message and a short stack, all
// redacted. The newest few stay. The next launch reads the newest one that was not dismissed.
// Nothing here touches the network.

export const CRASH_DIRECTORY = 'crashes';
export const CRASH_KEEP = 5;
export const CRASH_RECORD_BYTES = 8 * 1024;
const MESSAGE_CHARACTERS = 500;
const STACK_CHARACTERS = 4000;
const DETAIL_CHARACTERS = 200;
const DISMISSED = 'dismissed';
const RECORD_NAME = /^crash-[0-9A-Za-z-]+\.json$/;

export type CrashRecord = {
  version: 1;
  at: string;
  source: 'controller' | 'renderer';
  kind: 'uncaught-exception' | 'unhandled-rejection' | 'render-process-gone';
  message: string;
  stack: string;
  detail: string;
};
export type CrashInput = Pick<CrashRecord, 'source' | 'kind'> &
  Partial<Pick<CrashRecord, 'message' | 'stack' | 'detail'>>;
export type CrashOptions = {
  now?: () => string;
  id?: () => string;
  keep?: number;
  /** The folder that becomes ~. Defaults to the person's home folder. */
  userHome?: string;
};

const clip = (text: string, limit: number) => text.slice(0, limit).toWellFormed();

function serialize(record: CrashRecord): string {
  let text = `${JSON.stringify(record, null, 2)}\n`;
  // Multi-byte text can pass the character limits and still pass the byte limit, so cut the
  // stack, then the message, until the record fits.
  for (const field of ['stack', 'message', 'detail'] as const) {
    while (Buffer.byteLength(text) > CRASH_RECORD_BYTES && record[field] !== '') {
      record[field] = clip(record[field], Math.floor(record[field].length / 2));
      text = `${JSON.stringify(record, null, 2)}\n`;
    }
  }
  return text;
}

/** The crashes folder, made on demand. A link or a file in its place is refused. */
function crashDirectory(home: string, create: boolean): string | null {
  const directory = join(home, CRASH_DIRECTORY);
  const state = lstatSync(directory, { throwIfNoEntry: false });
  if (state) return state.isDirectory() ? directory : null;
  if (!create) return null;
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

function recordNames(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => RECORD_NAME.test(name))
      .sort();
  } catch {
    return [];
  }
}

function removeQuietly(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove. Pruning goes on with the next file.
  }
}

/** Writes one record and keeps the newest few. Returns the record's file name, or null. */
export function writeCrashRecord(
  home: string,
  input: CrashInput,
  options: CrashOptions = {},
): string | null {
  try {
    const now = options.now?.() ?? new Date().toISOString();
    const redact = (text: string | undefined, limit: number) =>
      clip(
        options.userHome === undefined
          ? redactDiagnosticText(text ?? '')
          : redactDiagnosticText(text ?? '', options.userHome),
        limit,
      );
    const record: CrashRecord = {
      version: 1,
      at: now,
      source: input.source,
      kind: input.kind,
      message: redact(input.message, MESSAGE_CHARACTERS),
      stack: redact(input.stack, STACK_CHARACTERS),
      detail: redact(input.detail, DETAIL_CHARACTERS),
    };
    const directory = crashDirectory(home, true);
    if (!directory) return null;
    const name = `crash-${now.replace(/[^0-9A-Za-z]/g, '-')}-${options.id?.() ?? randomUUID().slice(0, 8)}.json`;
    const file = openSync(
      join(directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(file, serialize(record));
      fsyncSync(file);
    } catch (failure) {
      closeSync(file);
      removeQuietly(join(directory, name));
      throw failure;
    }
    closeSync(file);
    const names = recordNames(directory);
    for (const old of names.slice(0, Math.max(0, names.length - (options.keep ?? CRASH_KEEP))))
      removeQuietly(join(directory, old));
    return name;
  } catch {
    return null;
  }
}

function readSmall(path: string, limit: number): string | null {
  let file: number;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const state = fstatSync(file);
    if (!state.isFile() || state.size > limit) return null;
    const buffer = Buffer.alloc(state.size);
    const count = readSync(file, buffer, 0, state.size, 0);
    return buffer.subarray(0, count).toString('utf8');
  } finally {
    closeSync(file);
  }
}

/** The newest record the person has not dismissed, or null. */
export function unseenCrash(
  home: string,
): { name: string; at: string; source: CrashRecord['source']; kind: CrashRecord['kind'] } | null {
  const directory = crashDirectory(home, false);
  const name = directory ? recordNames(directory).at(-1) : undefined;
  if (!directory || !name || readSmall(join(directory, DISMISSED), 256)?.trim() === name)
    return null;
  try {
    const text = readSmall(join(directory, name), CRASH_RECORD_BYTES);
    const record = text === null ? null : (JSON.parse(text) as Partial<CrashRecord>);
    if (!record || typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at)))
      return null;
    return {
      name,
      at: new Date(record.at).toISOString(),
      source: record.source === 'renderer' ? 'renderer' : 'controller',
      kind: record.kind ?? 'uncaught-exception',
    };
  } catch {
    return null;
  }
}

/** Remembers that the person saw this record. The record itself stays on disk. */
export function dismissCrash(home: string, name: string): boolean {
  if (!RECORD_NAME.test(name)) return false;
  let temporary: string | null = null;
  try {
    const directory = crashDirectory(home, true);
    if (!directory) return false;
    temporary = join(directory, `.${DISMISSED}.${process.pid}`);
    const file = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(file, name);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, join(directory, DISMISSED));
    return true;
  } catch {
    if (temporary) removeQuietly(temporary);
    return false;
  }
}

/**
 * Records every uncaught exception and unhandled rejection of this process. The monitor only
 * watches: Node still prints the error and exits as it did before.
 */
export function installCrashCapture(home: string, source: CrashRecord['source'] = 'controller') {
  process.on('uncaughtExceptionMonitor', (error: unknown, origin: string) => {
    // This runs while the process is already failing. Nothing here may throw, or Node exits with
    // a different status and loses the original error.
    try {
      const kind = origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception';
      const { message, stack } = describe(error);
      writeCrashRecord(home, { source, kind, message, stack });
      appendControllerLog(home, `${source} ${kind}: ${message}`);
    } catch {
      // The record is a courtesy.
    }
  });
}

/** Text for any thrown value, including one with no prototype or with getters that throw. */
function describe(error: unknown): { message: string; stack: string } {
  const attempt = (read: () => unknown) => {
    try {
      const value = read();
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  };
  if (error instanceof Error) {
    const name = attempt(() => error.name);
    const message = attempt(() => error.message);
    return {
      message: `${name}: ${message}`.replace(/^: /, ''),
      stack: attempt(() => error.stack),
    };
  }
  return {
    message: attempt(() => String(error)) || 'A value without a description was thrown.',
    stack: '',
  };
}
