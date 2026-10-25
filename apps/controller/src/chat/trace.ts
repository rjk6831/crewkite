import { closeSync, constants, openSync, writeSync } from 'node:fs';

/**
 * A bounded JSON lines file in a turn's private work folder, one line per entry with the
 * milliseconds since the trace was made. Writes before open() and after the limit are dropped.
 * O_NOFOLLOW keeps a link at the path from moving the file. A trace that cannot be written is
 * dropped and the turn goes on.
 */
export function frameTrace(now: () => number, limits: { lines: number; bytes: number }) {
  const started = now();
  let opened = false;
  let file: number | null = null;
  let lines = 0;
  let bytes = 0;
  const close = () => {
    if (file === null) return;
    try {
      closeSync(file);
    } catch {}
    file = null;
  };
  return {
    /** Creates the file once. A second call leaves the trace as it is. */
    open(path: string) {
      if (opened) return;
      opened = true;
      try {
        file = openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
          0o600,
        );
      } catch {}
    },
    write(entry: () => Record<string, unknown>) {
      if (file === null) return;
      try {
        const ms = Math.round(now() - started);
        let line = `${JSON.stringify({ ms, ...entry() })}\n`;
        // The last 256 bytes stay free for the line that says the trace stopped.
        const full = lines >= limits.lines || bytes + Buffer.byteLength(line) > limits.bytes - 256;
        if (full)
          line = `${JSON.stringify({ ms, truncated: true, note: `The trace stops here at ${limits.lines} lines or ${limits.bytes / 1024} KiB.` })}\n`;
        writeSync(file, line);
        lines++;
        bytes += Buffer.byteLength(line);
        if (full) close();
      } catch {
        close();
      }
    },
    close,
  };
}
