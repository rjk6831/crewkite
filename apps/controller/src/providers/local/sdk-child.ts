import { BindingSchema, StartSchema, TerminalSchema } from './profile.ts';
import { createLocalClient, startLocalPrediction } from './sdk.ts';

let pending = Buffer.alloc(0),
  started = false,
  permitted = false;
let release!: () => void;
const permission = new Promise<void>((resolve) => {
  release = resolve;
});
let run: ReturnType<typeof startLocalPrediction> | null = null;
let client: ReturnType<typeof createLocalClient> | null = null;
const write = (value: unknown) =>
  new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
const stop = () => {
  run?.stop();
  release();
};
process.stdin.on('error', stop);
process.stdin.on('end', stop);
process.stdin.on('data', (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  if (pending.length > 262_144) {
    stop();
    process.exitCode = 1;
    return process.stdin.destroy();
  }
  let end = pending.indexOf(10);
  while (end >= 0) {
    const line = pending.subarray(0, end);
    pending = pending.subarray(end + 1);
    end = pending.indexOf(10);
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      if (!started) {
        const plan = StartSchema.parse(value);
        started = true;
        run = startLocalPrediction(plan, {
          createClient: (input) => {
            client = createLocalClient(input);
            return client;
          },
          onSubmitted: async () => {
            await write({ type: 'ready', binding: BindingSchema.parse(plan.binding) });
            await permission;
            if (!permitted) throw new Error();
          },
        });
        void run.result
          .then(async (terminal) => {
            await write({ type: 'terminal', terminal: TerminalSchema.parse(terminal) });
            process.stdin.destroy();
            await client?.[Symbol.asyncDispose]();
          })
          .catch(() => {
            process.exitCode = 1;
            process.stdin.destroy();
          });
      } else if (value === 'submit' && !permitted) {
        permitted = true;
        release();
      } else if (value === 'stop') stop();
      else throw new Error();
    } catch {
      stop();
      process.exitCode = 1;
      process.stdin.destroy();
    }
  }
});
