import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { groupAbsent, type Schedule } from '../../host/worker.ts';
import { type AuthMetadata, metadataCommand, projectAuthStatus } from './discovery.ts';

type Reason =
  | 'identity'
  | 'storage'
  | 'environment'
  | 'launch'
  | 'protocol'
  | 'output-limit'
  | 'deadline'
  | 'stopped'
  | 'ownership';
type Outcome = {
  metadata: AuthMetadata | null;
  reason: Reason | null;
  quiescent: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};
export type NativePhase = 'auth-status' | 'task';
export type NativeLifecycle = {
  beforePhase: (kind: NativePhase) => void;
  owned: (kind: NativePhase, group: number) => void;
  quiescent: (kind: NativePhase, group: number) => void;
};

// A journal callback must finish before protocol input can authorize native work.
export function nativeSynchronousHook(work: () => unknown) {
  const result = work();
  if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
    void Promise.resolve(result).catch(() => {});
    throw new NativeDiscoveryError('ownership');
  }
}

type CleanupOwner = {
  schedule: Schedule;
  now: () => number;
  remaining: () => number;
  timers: Array<() => void>;
  signal: (value: NodeJS.Signals) => void;
  absent: () => boolean;
  closed: () => boolean;
  finished: () => boolean;
  settle: () => void;
};

/**
 * Arms the kill at one second and the ownership verdict at the cutoff, after SIGTERM went out.
 * Timers run before the poll phase that reaps children. When synchronous work holds the loop
 * past the cutoff, the kill and the verdict run in one pass, microseconds apart, and the
 * verdict finds the group present. Node also runs one timer list per duration at a time, so an
 * older cutoff timer can reach the verdict before the kill. The verdict therefore waits one
 * poll phase, which lets the kill go out and the child be reaped. A group that is still present
 * gets a full second from its kill, capped by the deadline.
 */
export function armOwnedCleanup(owner: CleanupOwner, cutoff: number) {
  let killedAt: number | undefined;
  const settleAtCutoff = () => {
    // An exited group can precede delivery of its final stream-close event.
    if (!owner.closed() && owner.absent()) owner.timers.push(owner.schedule(owner.settle, 0));
    else owner.settle();
  };
  owner.timers.push(
    owner.schedule(
      () => {
        killedAt = owner.now();
        owner.signal('SIGKILL');
      },
      Math.min(1000, cutoff),
    ),
    owner.schedule(() => {
      if (owner.finished()) return;
      if (owner.absent()) return settleAtCutoff();
      setImmediate(() => {
        if (owner.finished()) return;
        if (owner.absent()) return settleAtCutoff();
        const late = killedAt === undefined ? 0 : killedAt + 1000 - owner.now();
        const wait = Math.min(late, owner.remaining());
        if (wait > 0) owner.timers.push(owner.schedule(settleAtCutoff, wait));
        else owner.settle();
      });
    }, cutoff),
  );
}

type Spawn = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: true;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcessWithoutNullStreams;

export class NativeDiscoveryError extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) {
    super(`Provider metadata process refused: ${reason}.`);
    this.name = 'NativeDiscoveryError';
    this.reason = reason;
  }
}

export function nativeAuthEnvironment(
  source: NodeJS.ProcessEnv,
  temporary: string,
): NodeJS.ProcessEnv {
  if (
    !source.HOME ||
    !isAbsolute(source.HOME) ||
    !isAbsolute(temporary) ||
    source.CLAUDE_CONFIG_DIR
  )
    throw new NativeDiscoveryError('environment');
  return {
    HOME: source.HOME,
    USER: userInfo().username,
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    TMPDIR: temporary,
    DISABLE_UPDATES: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_SAFE_MODE: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
}

/** Only this current child can be stopped. No persisted PID is accepted. */
export function startNativeAuthStatus(
  launch: {
    executable: string;
    sha256: string;
    repositoryRoot: string;
    directory: string;
    environment: NodeJS.ProcessEnv;
  },
  options: {
    now?: () => number;
    deadline?: number;
    schedule?: Schedule;
    spawn?: Spawn;
    lifecycle?: NativeLifecycle;
  } = {},
) {
  if (process.platform === 'win32') throw new NativeDiscoveryError('ownership');
  const plan = metadataCommand('auth-status');
  const now = options.now ?? (() => performance.now());
  const started = now();
  if (
    !Number.isFinite(started) ||
    (options.deadline !== undefined && !Number.isFinite(options.deadline))
  )
    throw new NativeDiscoveryError('deadline');
  const end = Math.min(started + plan.timeoutMs, options.deadline ?? Infinity);
  let previous = started;
  let invalidClock = false;
  const remaining = () => {
    const current = now();
    if (invalidClock || !Number.isFinite(current) || current < previous) {
      invalidClock = true;
      return 0;
    }
    previous = current;
    return Math.max(0, end - current);
  };
  if (remaining() <= 2000) throw new NativeDiscoveryError('deadline');
  const schedule: Schedule =
    options.schedule ??
    ((work, milliseconds) => {
      const timer = setTimeout(work, milliseconds);
      return () => clearTimeout(timer);
    });
  let executable: string;
  try {
    if (!isAbsolute(launch.executable) || !/^[a-f0-9]{64}$/.test(launch.sha256)) throw new Error();
    executable = realpathSync(launch.executable);
    const fd = openSync(
      executable,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || file.size > 512 * 1024 * 1024) throw new Error();
      if (createHash('sha256').update(readFileSync(fd)).digest('hex') !== launch.sha256)
        throw new Error();
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new NativeDiscoveryError('identity');
  }
  const directory = resolve(launch.directory);
  const temporary = join(directory, 'tmp');
  const environment = nativeAuthEnvironment(launch.environment, temporary);
  try {
    if (!isAbsolute(launch.repositoryRoot) || !isAbsolute(launch.directory)) throw new Error();
    const repository = realpathSync(launch.repositoryRoot);
    const root = lstatSync(launch.repositoryRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      root.mode & 0o022
    )
      throw new Error();
    const path = relative(repository, directory);
    if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error();
    let current = repository;
    for (const part of path.split('/')) {
      current = join(current, part);
      const file = lstatSync(current);
      if (
        !file.isDirectory() ||
        file.isSymbolicLink() ||
        file.uid !== process.getuid?.() ||
        file.mode & (current === directory ? 0o077 : 0o022)
      )
        throw new Error();
    }
    if (readdirSync(directory).length) throw new Error();
    mkdirSync(temporary, { mode: 0o700 });
  } catch {
    throw new NativeDiscoveryError('storage');
  }
  if (remaining() <= 2000) throw new NativeDiscoveryError('deadline');
  try {
    nativeSynchronousHook(() => options.lifecycle?.beforePhase('auth-status'));
  } catch {
    throw new NativeDiscoveryError('ownership');
  }
  if (remaining() <= 2000) throw new NativeDiscoveryError('deadline');
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawn ?? spawn)(executable, plan.argv, {
      cwd: directory,
      env: environment,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return {
      group: 0,
      stop: () => {},
      result: Promise.resolve<Outcome>({
        metadata: null,
        reason: 'launch',
        quiescent: true,
        exitCode: null,
        signal: null,
      }),
    };
  }
  const group = child.pid ?? 0;
  let reason: Reason | null = group > 0 ? null : 'launch';
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let closed = false;
  let stopping = false;
  let finished = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdout: Buffer[] = [];
  const cancellations: Array<() => void> = [];
  let cancelDeadline = () => {};
  let resolveResult!: (value: Outcome) => void;
  const result = new Promise<Outcome>((resolve) => {
    resolveResult = resolve;
  });
  const absent = () => group === 0 || groupAbsent(group);
  const settle = () => {
    if (finished) return;
    finished = true;
    for (const cancel of cancellations) cancel();
    const quiescent = closed && absent();
    let metadata: AuthMetadata | null = null;
    if (!quiescent) reason = 'ownership';
    if (quiescent && group > 0) {
      try {
        nativeSynchronousHook(() => options.lifecycle?.quiescent('auth-status', group));
      } catch {
        reason = 'ownership';
      }
    }
    if (remaining() === 0) reason ??= 'deadline';
    if (quiescent && reason === null) {
      try {
        metadata = projectAuthStatus({ stdout: Buffer.concat(stdout), stderrBytes, exitCode });
      } catch {
        reason = 'protocol';
      }
    }
    if (remaining() === 0) {
      reason ??= 'deadline';
      metadata = null;
    }
    stdout.length = 0;
    resolveResult({ metadata, reason, quiescent, exitCode, signal: exitSignal });
  };
  const signal = (value: NodeJS.Signals) => {
    if (!Number.isSafeInteger(group) || group <= 0 || groupAbsent(group)) return;
    try {
      process.kill(-group, value);
    } catch {
      // A failed signal does not prove that the owned group is absent.
    }
  };
  const stop = (failure: Reason | null) => {
    if (finished) return;
    reason ??= failure;
    if (reason) {
      stdout.length = 0;
      cancelDeadline();
    }
    if (stopping) return;
    stopping = true;
    try {
      child.stdin.end();
    } catch {
      reason ??= 'launch';
    }
    if (closed && absent()) return settle();
    signal('SIGTERM');
    armOwnedCleanup(
      {
        schedule,
        now,
        remaining,
        timers: cancellations,
        signal,
        absent,
        closed: () => closed,
        finished: () => finished,
        settle,
      },
      Math.min(2000, remaining()),
    );
  };
  child.stdin.on('error', () => stop('launch'));
  child.on('error', () => stop('launch'));
  child.stdout.on('data', (bytes: Buffer) => {
    if (finished) return;
    stdoutBytes = Math.min(plan.maxStdoutBytes + 1, stdoutBytes + bytes.length);
    if (stdoutBytes > plan.maxStdoutBytes) return stop('output-limit');
    if (!reason) stdout.push(bytes);
  });
  child.stderr.on('data', (bytes: Buffer) => {
    if (finished) return;
    stderrBytes = Math.min(plan.maxStderrBytes + 1, stderrBytes + bytes.length);
    if (stderrBytes > plan.maxStderrBytes) stop('output-limit');
  });
  child.once('exit', (code, value) => {
    exitCode = code;
    exitSignal = value;
    stop(null);
  });
  child.once('close', () => {
    closed = true;
    if (absent()) settle();
    else stop(null);
  });
  cancelDeadline = schedule(() => stop('deadline'), Math.max(0, remaining() - 2000));
  cancellations.push(cancelDeadline);
  try {
    if (group > 0) nativeSynchronousHook(() => options.lifecycle?.owned('auth-status', group));
    if (remaining() <= 2000) stop('deadline');
    else {
      try {
        child.stdin.end();
      } catch {
        stop('launch');
      }
    }
  } catch {
    stop('ownership');
  }
  return { group, result, stop: () => stop('stopped') };
}
