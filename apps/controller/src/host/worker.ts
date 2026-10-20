import { type ChildProcessWithoutNullStreams, spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { Readable } from 'node:stream';
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
const maximumCommandChunkBytes = 64 * 1024;
const commandEnvironmentNames = new Set([
  'CI',
  'HOME',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'PATH',
  'TMPDIR',
  'TZ',
]);
const commandShellNames = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'dash',
  'fish',
  'ksh',
  'powershell',
  'pwsh',
  'sh',
  'zsh',
]);
export type OwnedCommandLaunch = Readonly<{
  operationId: string;
  executable: string;
  executableSha256: string;
  argv: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  shell: false;
}>;
export type OwnedCommandLifecycle = Readonly<{
  intent: (launch: OwnedCommandLaunch) => void;
  owned: (group: number) => void;
  quiescent: (group: number) => void;
}>;

function synchronous(callback: () => void) {
  const result: unknown = callback();
  if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw Error('Command ownership callbacks must finish synchronously.');
  }
}

function commandDirectory(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) !== directory)
    throw Error('Command working directory must be absolute.');
  const state = lstatSync(directory);
  if (!state.isDirectory() || state.isSymbolicLink() || realpathSync(directory) !== directory)
    throw Error('Command working directory must be canonical.');
}

export function verifyOwnedCommandExecutable(executable: string, sha256: string) {
  if (
    !isAbsolute(executable) ||
    resolve(executable) !== executable ||
    realpathSync(executable) !== executable ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw Error('Command executable identity is invalid.');
  if (commandShellNames.has(basename(executable).toLowerCase()))
    throw Error('Owned commands do not grant shell authority.');
  const path = lstatSync(executable);
  if (!path.isFile() || path.isSymbolicLink() || (path.mode & 0o111) === 0)
    throw Error('Command executable identity is invalid.');
  const descriptor = openSync(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > 256n * 1024n * 1024n)
      throw Error('Command executable identity is invalid.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(maximumCommandChunkBytes);
    let bytes = 0n;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += BigInt(count);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      bytes !== before.size ||
      (['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtimeNs', 'ctimeNs'] as const).some(
        (key) => before[key] !== after[key],
      ) ||
      hash.digest('hex') !== sha256
    )
      throw Error('Command executable identity changed.');
  } finally {
    closeSync(descriptor);
  }
}

function validateCommandLaunch(launch: OwnedCommandLaunch) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(launch.operationId) ||
    launch.shell !== false ||
    !Array.isArray(launch.argv) ||
    launch.argv.length > 128
  )
    throw Error('Command launch is invalid.');
  let argumentBytes = 0;
  for (const argument of launch.argv) {
    if (
      typeof argument !== 'string' ||
      argument.includes('\0') ||
      Buffer.byteLength(argument) > 8192
    )
      throw Error('Command arguments are invalid.');
    argumentBytes += Buffer.byteLength(argument);
  }
  if (argumentBytes > 64 * 1024) throw Error('Command arguments exceed their bound.');
  if (
    !launch.environment ||
    typeof launch.environment !== 'object' ||
    Array.isArray(launch.environment) ||
    Object.keys(launch.environment).length > commandEnvironmentNames.size
  )
    throw Error('Command environment is invalid.');
  let environmentBytes = 0;
  for (const [name, value] of Object.entries(launch.environment)) {
    if (!commandEnvironmentNames.has(name) || typeof value !== 'string' || value.includes('\0'))
      throw Error('Command environment is invalid.');
    environmentBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (environmentBytes > 16 * 1024) throw Error('Command environment exceeds its bound.');
  commandDirectory(launch.cwd);
  verifyOwnedCommandExecutable(launch.executable, launch.executableSha256);
}

function streamChunks(source: Readable, failed: () => void): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const value of source) {
          if (!Buffer.isBuffer(value)) throw Error('Command output must be bytes.');
          for (let offset = 0; offset < value.length; offset += maximumCommandChunkBytes)
            yield value.subarray(offset, offset + maximumCommandChunkBytes);
        }
      } catch (error) {
        failed();
        throw error;
      }
    },
  };
}

type BufferedCommandOptions = Readonly<{
  argv: string[];
  directory: string;
  environmentHome: string;
  onSpawn: (pid: number) => void;
  streaming?: false;
}>;
export type StreamingCommandOptions = Readonly<{
  streaming: true;
  operationId: string;
  executable: string;
  executableSha256: string;
  argv: readonly string[];
  directory: string;
  environment: Readonly<Record<string, string>>;
  lifecycle: OwnedCommandLifecycle;
  onSpawn?: (pid: number) => void;
}>;
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
  readonly stdoutStream?: AsyncIterable<Uint8Array>;
  readonly stderrStream?: AsyncIterable<Uint8Array>;
  readonly group: number;
  failed = false;
  private bytes = 0;
  private quiescenceError?: unknown;
  private quiescenceRecorded = false;
  private readonly lifecycle?: OwnedCommandLifecycle;
  constructor(options: BufferedCommandOptions | StreamingCommandOptions) {
    if (process.platform === 'win32')
      throw new Error('Process ownership evidence requires a Unix process group.');
    const streaming = options.streaming === true;
    let launch: OwnedCommandLaunch | undefined;
    if (streaming) {
      launch = Object.freeze({
        operationId: options.operationId,
        executable: options.executable,
        executableSha256: options.executableSha256,
        argv: Object.freeze([...options.argv]),
        cwd: options.directory,
        environment: Object.freeze({ ...options.environment }),
        shell: false,
      });
      validateCommandLaunch(launch);
      synchronous(() => options.lifecycle.intent(launch as OwnedCommandLaunch));
      commandDirectory(launch.cwd);
      verifyOwnedCommandExecutable(launch.executable, launch.executableSha256);
      this.lifecycle = options.lifecycle;
    } else {
      mkdirSync(options.environmentHome, { recursive: true, mode: 0o700 });
    }
    if (streaming) {
      if (!launch) throw Error('Command launch is unavailable.');
      this.child = spawn(launch.executable, [...launch.argv], {
        cwd: launch.cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...launch.environment },
      });
    } else {
      this.child = spawn(process.execPath, [...options.argv], {
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
    }
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
    if (streaming) {
      this.stdoutStream = streamChunks(this.child.stdout, () => {
        this.failed = true;
      });
      this.stderrStream = streamChunks(this.child.stderr, () => {
        this.failed = true;
      });
    } else {
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
    }
    if (this.group)
      try {
        if (streaming) synchronous(() => options.lifecycle.owned(this.group));
        if (streaming) synchronous(() => options.onSpawn?.(this.group));
        else options.onSpawn(this.group);
      } catch (error) {
        try {
          process.kill(-this.group, 'SIGKILL');
        } catch {}
        throw error;
      }
    this.child.stdin.end();
  }
  async quiescent(schedule: Schedule = defaultSchedule): Promise<boolean> {
    if (this.quiescenceError) throw this.quiescenceError;
    if (!(await closedWithin(this.closed, schedule))) return false;
    // A descendant can outlive the leader and finish before the streams close.
    const quiescent = this.group === 0 ? this.failed : groupAbsent(this.group);
    if (quiescent && this.group > 0 && this.lifecycle && !this.quiescenceRecorded) {
      this.quiescenceRecorded = true;
      try {
        synchronous(() => this.lifecycle?.quiescent(this.group));
      } catch (error) {
        this.failed = true;
        this.quiescenceError = error;
        throw error;
      }
    }
    return quiescent;
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
