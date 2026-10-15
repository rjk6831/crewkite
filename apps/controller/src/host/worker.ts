import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import {
  type FakeWorkerEvent,
  FakeWorkerEventSchema,
  type FakeWorkerInput,
  FakeWorkerInputSchema,
  MAX_FRAME_BYTES,
} from '@crewkite/contracts';

export function groupAbsent(group: number | null): boolean {
  if (group === null) return false;
  try {
    process.kill(-group, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export type Schedule = (work: () => void, milliseconds: number) => () => void;
const schedule: Schedule = (work, milliseconds) => {
  const timer = setTimeout(work, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};
type Exit = { code: number | null; signal: NodeJS.Signals | null; quiescent: boolean };
export class OwnedWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<Exit>;
  readonly closed: Promise<void>;
  readonly group: number;
  private pending = Buffer.alloc(0);

  constructor(options: {
    workerPath: string;
    start: Extract<FakeWorkerInput, { type: 'start' }>;
    environmentHome: string;
    routeId: string;
    observedAt: string;
    onSpawn: (pid: number) => void;
    onEvent: (event: FakeWorkerEvent) => void;
    onFailure: (reason: string) => void;
  }) {
    if (process.platform === 'win32')
      throw new Error('Writer ownership evidence requires a Unix process group.');
    mkdirSync(options.environmentHome, { recursive: true, mode: 0o700 });
    this.child = spawn(process.execPath, [options.workerPath], {
      cwd: options.start.scratchPath,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        HOME: options.environmentHome,
        CREWKITE_FAKE_ROUTE_ID: options.routeId,
        CREWKITE_FAKE_OBSERVED_AT: options.observedAt,
      },
    });
    this.group = this.child.pid ?? 0;
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) =>
        resolve({ code, signal, quiescent: this.group > 0 && groupAbsent(this.group) }),
      );
      this.child.once('error', () =>
        resolve({ code: null, signal: null, quiescent: this.group === 0 }),
      );
    });
    this.closed = new Promise((resolve) => this.child.once('close', () => resolve()));
    this.child.on('error', () => options.onFailure('Fake worker could not launch.'));
    this.child.stdin.on('error', () => options.onFailure('Fake worker input closed.'));
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (chunk.length > 65536)
        return options.onFailure('Fake worker stderr exceeds the output limit.');
      options.onEvent({ type: 'output', channel: 'stderr', text: chunk.toString('utf8') });
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        if (this.pending.length + chunk.length > MAX_FRAME_BYTES)
          throw new Error('Fake worker output exceeds the frame limit.');
        this.pending = Buffer.concat([this.pending, chunk]);
        let end = this.pending.indexOf(10);
        while (end !== -1) {
          const line = this.pending.subarray(0, end);
          this.pending = this.pending.subarray(end + 1);
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(line);
          options.onEvent(FakeWorkerEventSchema.parse(JSON.parse(decoded)));
          end = this.pending.indexOf(10);
        }
      } catch {
        options.onFailure('Fake worker sent an invalid event.');
      }
    });
    this.child.stdout.once('end', () => {
      if (this.pending.length) options.onFailure('Fake worker output ended inside a frame.');
    });
    try {
      if (this.group) options.onSpawn(this.group);
      this.send(options.start);
    } catch (error) {
      this.child.stdin.end();
      throw error;
    }
  }

  send(input: FakeWorkerInput) {
    if (!this.child.stdin.writable) throw new Error('Fake worker input is closed.');
    this.child.stdin.write(`${JSON.stringify(FakeWorkerInputSchema.parse(input))}\n`);
  }

  async stop(options: { schedule?: Schedule; graceMs?: number } = {}): Promise<Exit> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.send({ type: 'stop' });
    return new Promise<Exit>((resolve) => {
      const cancel = (options.schedule ?? schedule)(
        () => resolve({ code: null, signal: null, quiescent: false }),
        options.graceMs ?? 1000,
      );
      void this.exited.then((exit) => {
        cancel();
        resolve(exit);
      });
    });
  }
}
