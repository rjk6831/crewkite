import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { groupAbsent, type Schedule } from '../../host/worker.ts';
import {
  type DiscoveryEnvelope,
  type DiscoveryMetadata,
  type DiscoveryRequest,
  OpenAiDiscovery,
  type RefusedEnvelope,
} from './discovery.ts';

export type NativeLaunch = {
  executable: string;
  sha256: string;
  directory: string;
  repositoryRoot: string;
  environment: NodeJS.ProcessEnv;
};
type NativeEnvelope = DiscoveryEnvelope | 'notification' | 'request';
type NativeRequest = DiscoveryRequest | 'thread/start' | 'turn/start' | 'turn/completed';
type Outcome<T = DiscoveryMetadata> = {
  metadata: T | null;
  reason: 'stopped' | 'deadline' | 'launch' | 'protocol' | 'output-limit' | 'ownership' | null;
  quiescent: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  lastRequest: NativeRequest;
  lastEnvelope: NativeEnvelope;
  refusedEnvelope: RefusedEnvelope | null;
  notifications: number;
  stdoutBytes: number;
  stderrBytes: number;
};
export type NativeTranscript<T> = {
  next: () => Uint8Array | null;
  push: (bytes: Uint8Array) => void;
  finish: () => T;
  readonly complete: boolean;
  readonly pendingRequest: NativeRequest;
  readonly submitted?: boolean;
  interrupt?: () => Uint8Array | null;
  readonly lastEnvelope: NativeEnvelope;
  readonly refusedEnvelope: RefusedEnvelope | null;
  readonly notifications: number;
};
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

function childDirectory(root: string, name: string) {
  const path = join(root, name);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Discovery storage must be a contained directory.');
  const contained = relative(root, realpathSync(path));
  if (contained.startsWith('..') || isAbsolute(contained))
    throw new Error('Discovery storage escapes its directory.');
  return path;
}

/** Run-local settings do not change the existing native authentication location. */
export function nativeDiscoveryArguments(directory: string): string[] {
  const settings = {
    model_provider: 'openai',
    openai_base_url: '',
    chatgpt_base_url: 'https://chatgpt.com/backend-api/',
    service_tier: 'default',
    approval_policy: 'on-request',
    approvals_reviewer: 'user',
    sandbox_mode: 'read-only',
    web_search: 'disabled',
    'features.plugins': false,
    'features.remote_plugin': false,
    'features.apps': false,
    'features.hooks': false,
    'features.multi_agent': false,
    log_dir: join(directory, 'logs'),
    sqlite_home: join(directory, 'sqlite'),
  };
  return [
    ...Object.entries(settings).flatMap(([key, value]) => [
      '-c',
      `${key}=${JSON.stringify(value)}`,
    ]),
    'app-server',
    '--stdio',
    '--strict-config',
  ];
}

export function nativeDiscoveryEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: 'C',
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
  };
  for (const key of ['HOME', 'CODEX_HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL'])
    if (source[key] !== undefined) environment[key] = source[key];
  if (!environment.HOME || !isAbsolute(environment.HOME))
    throw new Error('Discovery requires the existing absolute native home.');
  if (environment.CODEX_HOME && !isAbsolute(environment.CODEX_HOME))
    throw new Error('Discovery requires an absolute native configuration location.');
  return environment;
}

/** Metadata completion requires closed streams and absence of the owned process group. */
function startTranscript<T>(
  launch: NativeLaunch,
  options: {
    timeoutMs: number;
    now?: () => number;
    schedule?: Schedule;
    spawn?: Spawn;
    arguments: (directory: string) => string[];
    reader: NativeTranscript<T>;
    closeInput?: boolean;
    task?: boolean;
    deadline?: number;
    onSubmitted?: () => void;
  },
): { group: number; result: Promise<Outcome<T>>; stop: () => void } {
  if (process.platform === 'win32') throw new Error('Discovery requires Unix process ownership.');
  const now = options.now ?? (() => performance.now());
  const started = now();
  const deadline = options.deadline ?? started + options.timeoutMs;
  const schedule: Schedule =
    options.schedule ??
    ((work, milliseconds) => {
      const timer = setTimeout(work, milliseconds);
      return () => clearTimeout(timer);
    });
  if (!isAbsolute(launch.executable) || !/^[a-f0-9]{64}$/.test(launch.sha256))
    throw new Error('Discovery requires an exact executable identity.');
  const executable = realpathSync(launch.executable);
  if (!lstatSync(executable).isFile())
    throw new Error('Discovery executable must be a regular file.');
  if (createHash('sha256').update(readFileSync(executable)).digest('hex') !== launch.sha256)
    throw new Error('Discovery executable identity changed.');
  if (!isAbsolute(launch.directory) || !isAbsolute(launch.repositoryRoot))
    throw new Error('Discovery requires absolute repository and run directories.');
  const repository = realpathSync(launch.repositoryRoot);
  const repositoryStat = lstatSync(launch.repositoryRoot);
  if (
    !repositoryStat.isDirectory() ||
    repositoryStat.isSymbolicLink() ||
    repositoryStat.uid !== process.getuid?.() ||
    (repositoryStat.mode & 0o022) !== 0
  )
    throw new Error('Discovery requires an owned repository without shared write access.');
  const directory = resolve(launch.directory);
  const contained = relative(repository, directory);
  if (!contained || contained.startsWith('..') || isAbsolute(contained))
    throw new Error('Discovery storage must stay within the repository.');
  let current = repository;
  for (const part of contained.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & (current === directory ? 0o077 : 0o022)) !== 0
    )
      throw new Error('Discovery requires owned private storage without symlink parents.');
  }
  const reader = options.reader;
  childDirectory(directory, 'logs');
  childDirectory(directory, 'sqlite');
  if (options.task && now() >= deadline - 2000)
    throw new Error('Native task deadline elapsed before launch.');
  const child = (options.spawn ?? spawn)(executable, options.arguments(directory), {
    cwd: directory,
    env: nativeDiscoveryEnvironment(launch.environment),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const group = child.pid ?? 0;
  let metadata: T | null = null;
  let reason: Outcome['reason'] = null;
  let closed = false;
  let finished = false;
  let received = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stopping = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const cancellations: Array<() => void> = [];
  let finish!: (outcome: Outcome<T>) => void;
  const result = new Promise<Outcome<T>>((resolve) => {
    finish = resolve;
  });
  const settle = (quiescent: boolean) => {
    if (finished) return;
    finished = true;
    for (const cancel of cancellations) cancel();
    finish({
      metadata: quiescent && reason === null ? metadata : null,
      reason: quiescent ? reason : 'ownership',
      quiescent,
      exitCode,
      signal: exitSignal,
      lastRequest: reader.pendingRequest,
      lastEnvelope: reader.lastEnvelope,
      refusedEnvelope: reader.refusedEnvelope,
      notifications: reader.notifications,
      stdoutBytes,
      stderrBytes,
    });
  };
  const absent = () => group === 0 || groupAbsent(group);
  const signal = (value: NodeJS.Signals) => {
    if (!Number.isSafeInteger(group) || group <= 0 || groupAbsent(group)) return;
    try {
      process.kill(-group, value);
    } catch {
      // Only an observed absent group proves that a failed signal needs no further action.
    }
  };
  const stop = (failure: Outcome['reason']) => {
    if (finished) return;
    reason ??= failure;
    if (stopping) return;
    stopping = true;
    if (options.task) {
      try {
        const interrupt = reader.interrupt?.();
        if (interrupt) child.stdin.write(interrupt);
      } catch {
        // Owned termination still runs if the protocol can no longer accept an interrupt.
      }
      cancellations.push(
        schedule(
          () => {
            child.stdin.end();
            signal('SIGTERM');
          },
          Math.max(0, Math.min(250, deadline - now())),
        ),
      );
    } else {
      child.stdin.end();
    }
    if (closed && absent()) return settle(true);
    if (!options.task) signal('SIGTERM');
    cancellations.push(
      schedule(
        () => signal('SIGKILL'),
        options.task ? Math.max(0, Math.min(1000, deadline - now())) : 1000,
      ),
    );
    cancellations.push(
      schedule(
        () => settle(closed && absent()),
        options.task ? Math.max(0, Math.min(2000, deadline - now())) : 2000,
      ),
    );
  };
  let submissionReported = false;
  const advance = () => {
    try {
      const request = reader.next();
      if (request) {
        if (reader.submitted && !submissionReported) {
          submissionReported = true;
          options.onSubmitted?.();
        }
        child.stdin.write(request);
      }
      if (reader.complete) {
        metadata = reader.finish();
        child.stdin.end();
        cancellations.push(schedule(() => stop(null), 250));
      }
    } catch {
      stop('protocol');
    }
  };
  child.stdin.on('error', () => stop('protocol'));
  child.on('error', () => stop('launch'));
  child.stdout.on('data', (bytes: Buffer) => {
    stdoutBytes += bytes.length;
    received += bytes.length;
    if (received > 1_048_576) return stop('output-limit');
    if (finished || (stopping && reason !== null)) return;
    try {
      reader.push(bytes);
      advance();
    } catch {
      stop('protocol');
    }
  });
  child.stderr.on('data', (bytes: Buffer) => {
    stderrBytes += bytes.length;
    received += bytes.length;
    if (received > 1_048_576) stop('output-limit');
  });
  child.stdout.once('end', () => {
    // A completed response can still be followed by an incomplete frame before EOF.
    if (finished || reason !== null) return;
    try {
      metadata = reader.finish();
    } catch {
      stop('protocol');
    }
  });
  child.once('close', (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    closed = true;
    if (code !== 0 && !reason && !stopping) reason = 'protocol';
    if (!metadata && !reason) reason = 'protocol';
    if (absent()) settle(true);
    else stop(reason);
  });
  cancellations.push(
    schedule(
      () => stop('deadline'),
      options.task
        ? Math.max(0, deadline - now() - 2000)
        : Math.max(0, options.timeoutMs - (now() - started)),
    ),
  );
  advance();
  if (options.closeInput) child.stdin.end();
  return { group, result, stop: () => stop('stopped') };
}

const disabledFeatures = ['plugins', 'remote_plugin', 'apps', 'hooks', 'multi_agent'] as const;
type DisabledFeatures = Record<(typeof disabledFeatures)[number], false>;

class FeatureList implements NativeTranscript<DisabledFeatures> {
  private bytes = Buffer.alloc(0);
  readonly complete = false;
  readonly pendingRequest = 'features-list' as const;
  readonly lastEnvelope = null;
  readonly refusedEnvelope = null;
  readonly notifications = 0;
  next() {
    return null;
  }
  push(bytes: Uint8Array) {
    if (this.bytes.length + bytes.length > 65_536)
      throw new Error('Feature output exceeds its bound.');
    this.bytes = Buffer.concat([this.bytes, bytes]);
  }
  finish(): DisabledFeatures {
    const values = new Map<string, boolean>();
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes).split('\n');
    if (lines.pop() !== '' || lines.length > 512) throw new Error('Feature output is incomplete.');
    for (const line of lines) {
      const row =
        /^([a-z][a-z0-9_.]{0,99})\s+(under development|experimental|stable|deprecated|removed)\s+(true|false)$/.exec(
          line,
        );
      if (!row || values.has(row[1])) throw new Error('Feature output is invalid.');
      values.set(row[1], row[3] === 'true');
    }
    for (const key of disabledFeatures)
      if (values.get(key) !== false) throw new Error('Required startup feature is not disabled.');
    return { plugins: false, remote_plugin: false, apps: false, hooks: false, multi_agent: false };
  }
}

/** Each process has independent ownership evidence. Policy can change between observations. */
function nativeSession<T>(
  launch: NativeLaunch,
  options: {
    timeoutMs: number;
    now?: () => number;
    schedule?: Schedule;
    spawn?: Spawn;
    task?: boolean;
    onSubmitted?: () => void;
  },
  createReader: (remainingMs: number) => NativeTranscript<T>,
) {
  const now = options.now ?? (() => performance.now());
  const started = now();
  if (
    !Number.isFinite(started) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < (options.task ? 2001 : 1) ||
    options.timeoutMs > (options.task ? 300_000 : 60_000)
  )
    throw new Error('Discovery deadline is invalid.');
  const deadline = started + options.timeoutMs;
  let stopped = false;
  const preflight = startTranscript(launch, {
    ...options,
    now,
    reader: new FeatureList(),
    ...(options.task ? { deadline } : {}),
    closeInput: true,
    arguments: (directory) => [
      ...nativeDiscoveryArguments(directory).slice(0, -3),
      'features',
      'list',
    ],
  });
  let current: { group: number; stop: () => void } = preflight;
  const groups = [preflight.group];
  const result: Promise<Outcome<T>> = preflight.result.then(async (outcome) => {
    if (!outcome.quiescent || outcome.reason || stopped)
      return { ...outcome, metadata: null, reason: outcome.reason ?? 'stopped' };
    const remaining = Math.floor(options.timeoutMs - (now() - started));
    if (remaining < (options.task ? 2001 : 1))
      return { ...outcome, metadata: null, reason: 'deadline' };
    try {
      const reader = createReader(remaining);
      const discovery = startTranscript(launch, {
        ...options,
        now,
        timeoutMs: remaining,
        ...(options.task ? { deadline } : {}),
        reader,
        arguments: nativeDiscoveryArguments,
      });
      current = discovery;
      groups.push(discovery.group);
      return discovery.result;
    } catch {
      return {
        ...outcome,
        metadata: null,
        reason: options.task && now() >= deadline - 2000 ? 'deadline' : 'launch',
      };
    }
  });
  return {
    get group() {
      return current.group;
    },
    get groups() {
      return [...groups];
    },
    result,
    stop: () => {
      stopped = true;
      current.stop();
    },
  };
}

/** Metadata callers retain their original deadline and cleanup behavior. */
export function startNativeSession<T>(
  launch: NativeLaunch,
  options: { timeoutMs: number; now?: () => number; schedule?: Schedule; spawn?: Spawn },
  createReader: (remainingMs: number) => NativeTranscript<T>,
) {
  return nativeSession(launch, options, createReader);
}

/** A task reserves two seconds for native interruption and owned termination. */
export function startNativeTask<T>(
  launch: NativeLaunch,
  options: {
    timeoutMs: number;
    now?: () => number;
    schedule?: Schedule;
    spawn?: Spawn;
    onSubmitted: () => void;
  },
  createReader: (remainingMs: number) => NativeTranscript<T>,
) {
  return nativeSession(launch, { ...options, task: true }, createReader);
}

/** Discovery keeps the fixed metadata transcript and caller bound. */
export function startNativeDiscovery(
  launch: NativeLaunch,
  options: { timeoutMs: number; now?: () => number; schedule?: Schedule; spawn?: Spawn },
) {
  const now = options.now ?? (() => performance.now());
  return startNativeSession(
    launch,
    options,
    (remaining) =>
      new OpenAiDiscovery({
        now,
        timeoutMs: remaining,
        readConfiguration: true,
        configurationDirectory: resolve(launch.directory),
      }),
  );
}
