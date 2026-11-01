/**
 * One workspace read at a time, shared by every caller. A call made while a read runs is answered
 * by the next read that starts after it, and never by a later one. A read that kept going while
 * new calls arrived answered nobody until the calls stopped, so while a Google setup polled every
 * second a Local model read waited on it for minutes.
 *
 * `pass` returns undefined when what it read changed under it, and then runs again for the same
 * callers.
 */
export function coalescedRead<T>(pass: () => Promise<T | undefined>): () => Promise<T> {
  let running = false;
  let waiting: { resolve: (value: T) => void; reject: (failure: unknown) => void }[] = [];
  const run = async () => {
    running = true;
    try {
      while (waiting.length) {
        const served = waiting;
        waiting = [];
        try {
          let value = await pass();
          while (value === undefined) value = await pass();
          for (const caller of served) caller.resolve(value);
        } catch (failure) {
          for (const caller of served) caller.reject(failure);
        }
      }
    } finally {
      running = false;
    }
  };
  return () =>
    new Promise<T>((resolve, reject) => {
      waiting.push({ resolve, reject });
      if (!running) void run();
    });
}
