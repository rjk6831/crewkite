import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { appendControllerLog } from './log.ts';

// Timing lines in controller.log show where the event loop goes: client hashes, version reads,
// command queue waits and loop stalls. Nothing is written until the controller process starts the
// log, so tests and library callers pay only for performance.now().

let sink: ((line: string) => void) | undefined;

// A second with a stall below this is not worth a line. The log keeps 256 KB, and a line for
// every idle second would push the crash lines out within the hour.
const LOOP_DELAY_REPORT_MS = 50;

const milliseconds = (value: number) => Math.round(value * 10) / 10;

/** One timing line. A no-op until the log is started. */
export function logTiming(line: string): void {
  sink?.(`timing ${line}`);
}

/** Runs work and logs how long it took, including the wait for a returned promise. */
export function timed<T>(label: string, work: () => T): T {
  const started = performance.now();
  const done = () => logTiming(`${label} ms=${milliseconds(performance.now() - started)}`);
  let result: T;
  try {
    result = work();
  } catch (error) {
    done();
    throw error;
  }
  if (result instanceof Promise) {
    void result.then(done, done);
    return result;
  }
  done();
  return result;
}

/** Starts timing lines and a once-a-second event loop delay sample. Returns the stop function. */
export function startTimingLog(home: string): () => void {
  sink = (line) => appendControllerLog(home, line);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const timer = setInterval(() => {
    const max = delay.max / 1e6;
    if (max >= LOOP_DELAY_REPORT_MS)
      logTiming(
        `loop delay max=${milliseconds(max)} p99=${milliseconds(delay.percentile(99) / 1e6)} mean=${milliseconds(delay.mean / 1e6)}`,
      );
    delay.reset();
  }, 1000);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
    sink = undefined;
  };
}
