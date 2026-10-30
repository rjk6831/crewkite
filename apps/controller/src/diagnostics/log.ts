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
import { redactDiagnosticText } from './redact.ts';

// The controller's own log: a few plain lines for start, stop and a crash. It lives in the
// controller home, private to the person, and a file that grows past the limit keeps its newest
// half. The desktop and the controller both append to it.

export const LOG_FILE = 'controller.log';
const LOG_LIMIT = 256 * 1024;
const LOG_KEEP = 128 * 1024;
const LINE_CHARACTERS = 2000;

function readTail(path: string, bytes: number): string | null {
  let file: number;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const state = fstatSync(file);
    if (!state.isFile()) return null;
    const length = Math.min(state.size, bytes);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(file, buffer, offset, length - offset, state.size - length + offset);
      if (count === 0) break;
      offset += count;
    }
    const text = buffer.subarray(0, offset).toString('utf8');
    // A cut tail starts inside a line. That line goes, so no half of a value is left behind.
    if (state.size <= length) return text;
    const newline = text.indexOf('\n');
    return newline < 0 ? '' : text.slice(newline + 1);
  } finally {
    closeSync(file);
  }
}

/** The newest `bytes` of the log, from a whole line, or null when there is no log. */
export function readControllerLogTail(home: string, bytes: number): string | null {
  return readTail(join(home, LOG_FILE), bytes);
}

/** One timestamped line, redacted and kept to one line. Never throws. */
export function appendControllerLog(
  home: string,
  message: string,
  now: () => string = () => new Date().toISOString(),
): void {
  try {
    const path = join(home, LOG_FILE);
    const line = redactDiagnosticText(message)
      .replace(/\s*[\r\n]+\s*/g, ' | ')
      .slice(0, LINE_CHARACTERS);
    const file = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    let size = 0;
    try {
      writeSync(file, `${now()} ${line}\n`);
      size = fstatSync(file).size;
    } finally {
      closeSync(file);
    }
    if (size > LOG_LIMIT) {
      const kept = readTail(path, LOG_KEEP) ?? '';
      const temporary = join(home, `.${LOG_FILE}.${process.pid}`);
      try {
        const out = openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeSync(out, kept);
          fsyncSync(out);
        } finally {
          closeSync(out);
        }
        renameSync(temporary, path);
      } catch (failure) {
        try {
          unlinkSync(temporary);
        } catch {
          // Never created, or already gone.
        }
        throw failure;
      }
    }
  } catch {
    // The log is a courtesy. A full disk or a read only home never stops the controller.
  }
}
