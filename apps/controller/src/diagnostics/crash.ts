import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
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

function recordNames(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => RECORD_NAME.test(name))
      .sort();
  } catch {
    return [];
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
    const directory = join(home, CRASH_DIRECTORY);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `crash-${now.replace(/[^0-9A-Za-z]/g, '-')}-${options.id?.() ?? randomUUID().slice(0, 8)}.json`;
    const file = openSync(
      join(directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(file, serialize(record));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    const names = recordNames(directory);
    for (const old of names.slice(0, Math.max(0, names.length - (options.keep ?? CRASH_KEEP))))
      unlinkSync(join(directory, old));
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
  const directory = join(home, CRASH_DIRECTORY);
  const name = recordNames(directory).at(-1);
  if (!name || readSmall(join(directory, DISMISSED), 256)?.trim() === name) return null;
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
  try {
    const directory = join(home, CRASH_DIRECTORY);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${DISMISSED}.${process.pid}`);
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
    return false;
  }
}

/**
 * Records every uncaught exception and unhandled rejection of this process. The monitor only
 * watches: Node still prints the error and exits as it did before.
 */
export function installCrashCapture(home: string, source: CrashRecord['source'] = 'controller') {
  process.on('uncaughtExceptionMonitor', (error: unknown, origin: string) => {
    const kind = origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception';
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    writeCrashRecord(home, {
      source,
      kind,
      message,
      stack: error instanceof Error ? (error.stack ?? '') : '',
    });
    appendControllerLog(home, `${source} ${kind}: ${message}`);
  });
}
