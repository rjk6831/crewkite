import { type ChildProcessWithoutNullStreams, spawn as spawnProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import {
  type FakeWorkerEvent,
  FakeWorkerEventSchema,
  type FakeWorkerInput,
  FakeWorkerInputSchema,
  MAX_FRAME_BYTES,
} from '@crewkite/contracts';
import {
  type CheckRoot,
  checkEnvironment,
  enrollCheckRoot,
  spawnCheckChild as spawn,
} from './check-ownership.ts';

export function groupAbsent(group: number | null): boolean {
  if (group === null || !Number.isSafeInteger(group) || group <= 0) return false;
  try {
    process.kill(-group, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export function checkRootQuiescent(root: CheckRoot): boolean {
  return root.spawnFailed || (!!root.acknowledgment && groupAbsent(root.acknowledgment.group));
}

export type Schedule = (work: () => void, milliseconds: number) => () => void;
export const defaultSchedule: Schedule = (work, milliseconds) => {
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
  private received = 0;
  private invalid = false;

  constructor(options: {
    workerPath: string;
    start: Extract<FakeWorkerInput, { type: 'start' | 'review' }>;
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
    const ticket = enrollCheckRoot('worker', true, undefined, options.workerPath);
    try {
      this.child = spawnProcess(
        process.execPath,
        [...(ticket.preload ? [`--import=${ticket.preload}`] : []), options.workerPath],
        {
          cwd: options.start.scratchPath,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...ticket.environment,
            PATH: process.env.PATH,
            LANG: 'C',
            HOME: options.environmentHome,
            CREWKITE_FAKE_ROUTE_ID: options.routeId,
            CREWKITE_FAKE_OBSERVED_AT: options.observedAt,
          },
        },
      );
    } catch (error) {
      ticket.failed();
      throw error;
    }
    ticket.acknowledge(this.child);
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
      if (this.invalid) return;
      this.received += chunk.length;
      if (chunk.length > 65536 || this.received > MAX_FRAME_BYTES) {
        this.invalid = true;
        return options.onFailure('Fake worker total output exceeds the limit.');
      }
      options.onEvent({ type: 'output', channel: 'stderr', text: chunk.toString('utf8') });
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.invalid) return;
      try {
        this.received += chunk.length;
        if (this.received > MAX_FRAME_BYTES)
          throw new Error('Fake worker total output exceeded its bound.');
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
        this.invalid = true;
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
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.send({ type: 'stop' });
      } catch {}
    }
    const exit = await new Promise<Exit>((resolve) => {
      const cancel = (options.schedule ?? defaultSchedule)(
        () => resolve({ code: null, signal: null, quiescent: false }),
        options.graceMs ?? 1000,
      );
      void this.exited.then((exit) => {
        cancel();
        resolve(exit);
      });
    });
    return {
      ...exit,
      quiescent: exit.quiescent && (await closedWithin(this.closed, options.schedule)),
    };
  }
}

export class OwnedCommand {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<Exit>;
  readonly closed: Promise<void>;
  readonly stdout: Buffer[] = [];
  readonly stderr: Buffer[] = [];
  readonly group: number;
  failed = false;
  private bytes = 0;
  constructor(options: {
    argv: string[];
    directory: string;
    environmentHome: string;
    onSpawn: (pid: number) => void;
  }) {
    if (process.platform === 'win32')
      throw new Error('Process ownership evidence requires a Unix process group.');
    mkdirSync(options.environmentHome, { recursive: true, mode: 0o700 });
    this.child = spawn(process.execPath, options.argv, {
      cwd: options.directory,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...checkEnvironment(),
        PATH: process.env.PATH,
        LANG: 'C',
        HOME: options.environmentHome,
      },
    });
    this.group = this.child.pid ?? 0;
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) =>
        resolve({ code, signal, quiescent: this.group > 0 && groupAbsent(this.group) }),
      );
      this.child.once('error', () => {
        this.failed = true;
        resolve({ code: null, signal: null, quiescent: this.group === 0 });
      });
    });
    this.closed = new Promise((resolve) => this.child.once('close', () => resolve()));
    for (const channel of ['stdout', 'stderr'] as const)
      this.child[channel].on('data', (chunk: Buffer) => {
        this.bytes += chunk.length;
        if (this.bytes > MAX_FRAME_BYTES) {
          this.failed = true;
          this.stop();
          return;
        }
        this[channel].push(chunk);
      });
    if (this.group) options.onSpawn(this.group);
    this.child.stdin.end();
  }
  async quiescent(schedule: Schedule = defaultSchedule): Promise<boolean> {
    if (!(await closedWithin(this.closed, schedule))) return false;
    // A descendant can outlive the leader and finish before the streams close.
    return this.group === 0 ? this.failed : groupAbsent(this.group);
  }
  stop() {
    if (
      !Number.isSafeInteger(this.group) ||
      this.group <= 0 ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    try {
      process.kill(-this.group, 'SIGTERM');
    } catch {
      this.failed = true;
    }
  }
}

export function closedBefore(closed: Promise<void>, boundary: Promise<unknown>): Promise<boolean> {
  // The owner keeps its admitted deadline armed while exited children drain their pipes.
  return Promise.race([
    closed.then(
      () => true,
      () => false,
    ),
    boundary.then(
      () => false,
      () => false,
    ),
  ]);
}

export function closedWithin(
  closed: Promise<void>,
  schedule: Schedule = defaultSchedule,
): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = schedule(() => resolve(false), 1000);
    void closed.then(() => {
      cancel();
      resolve(true);
    });
  });
}
