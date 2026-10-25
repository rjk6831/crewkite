// Stands in for the native client in chat.test.ts. It plays the steps passed as JSON in its
// first argument and ignores the client flags after it. A frame value of "$LAST" becomes the
// last stdin line read, so a test can see exactly what reached the client.
import { createInterface } from 'node:readline';

type Step = 'read' | 'hold' | 'drain' | { out: unknown } | { err: string } | { exit: number };

const steps: Step[] = JSON.parse(process.argv[2] ?? '[]');
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
let last = '';
for (const step of steps) {
  if (step === 'read') last = (await lines.next()).value ?? '';
  else if (step === 'hold') await new Promise(() => setInterval(() => {}, 60_000));
  else if (step === 'drain') {
    let done = false;
    while (!done) done = (await lines.next()).done === true;
  } else if ('out' in step)
    process.stdout.write(
      `${JSON.stringify(step.out).replaceAll('"$LAST"', JSON.stringify(last))}\n`,
    );
  else if ('err' in step) process.stderr.write(step.err);
  else {
    // Natural exit lets pending pipe writes flush, which process.exit() does not promise.
    process.exitCode = step.exit;
    process.stdin.destroy();
    break;
  }
}
