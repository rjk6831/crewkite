import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { RunIdSchema } from '@crewkite/contracts';
import { z } from 'zod';
import { type FileContent, safePath } from './source.ts';
import { groupAbsent, type Schedule } from './worker.ts';

const childPath = fileURLToPath(import.meta.url);
const childMode = 'integration-git-child-v1';
const maximumInput = 72 * 1024 * 1024;
const maximumFrame = 100 * 1024 * 1024;
const maximumOutput = 1024 * 1024;
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const kinds = [
  'initialize',
  'empty-index',
  'blobs',
  'index',
  'tree',
  'symbolic-ref',
  'head',
  'tree-type',
  'cas',
] as const;
const ReleaseSchema = z
  .object({
    version: z.literal(1),
    directory: z.string().min(1).max(4096),
    runId: RunIdSchema,
    git: z
      .object({
        executable: z.string().min(1).max(4096),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    kind: z.enum(kinds),
    input: z.string().max(maximumFrame),
    old: oid.nullable(),
    next: oid.nullable(),
  })
  .strict();
type Release = z.infer<typeof ReleaseSchema>;
export type IntegrationGitPhase = Readonly<{
  sequence: number;
  kind: Release['kind'];
  digest: string;
}>;
export type IntegrationGitLifecycle = {
  beforePhase: (phase: IntegrationGitPhase) => void;
  owned: (phase: IntegrationGitPhase, group: number) => void;
  quiescent: (phase: IntegrationGitPhase, group: number) => void;
};
type Reason = 'stopped' | 'deadline' | 'launch' | 'output' | 'git' | 'ownership';
export type IntegrationGitOutcome<T> = {
  value: T | null;
  reason: Reason | null;
  quiescent: boolean;
};
export type IntegrationGitOperation<T> = {
  result: Promise<IntegrationGitOutcome<T>>;
  stop: () => void;
};
export type IntegrationGitOptions = {
  deadline: number;
  lifecycle: IntegrationGitLifecycle;
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
type Dependencies = {
  now?: () => number;
  schedule?: Schedule;
  spawn?: Spawn;
  groupAbsent?: (group: number) => boolean;
  signal?: (group: number, signal: NodeJS.Signals) => void;
};
type GitResult = { stdout: Buffer; code: number | null; signal: NodeJS.Signals | null };

function synchronous(callback: () => void) {
  const result: unknown = callback();
  if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw Error('Integration ownership callbacks must finish synchronously.');
  }
}
function privateDirectory(directory: string) {
  if (
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    realpathSync(directory) !== directory
  )
    throw Error('Integration storage must be canonical.');
  const state = lstatSync(directory);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.uid !== process.getuid?.() ||
    (state.mode & 0o077) !== 0
  )
    throw Error('Integration storage must be private and owned.');
}
function regularBytes(path: string, maximum: number, owned = true): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const state = fstatSync(fd, { bigint: true });
    if (
      !state.isFile() ||
      (owned && (state.uid !== BigInt(process.getuid?.() ?? -1) || state.nlink !== 1n)) ||
      state.size > BigInt(maximum) ||
      (state.mode & 0o022n) !== 0n
    )
      throw Error('Integration input must be an owned regular file.');
    const bytes = Buffer.alloc(Number(state.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      BigInt(offset) !== state.size ||
      (['dev', 'ino', 'size', 'uid', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'] as const).some(
        (key) => state[key] !== after[key],
      )
    )
      throw Error('Integration input changed while reading.');
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
function executableIdentity(git: Release['git']) {
  if (
    !isAbsolute(git.executable) ||
    realpathSync(git.executable) !== git.executable ||
    createHash('sha256')
      .update(regularBytes(git.executable, 64 * 1024 * 1024, false))
      .digest('hex') !== git.sha256
  )
    throw Error('Integration Git identity changed.');
}
function locations(release: Pick<Release, 'directory' | 'runId'>) {
  privateDirectory(release.directory);
  RunIdSchema.parse(release.runId);
  return {
    repository: join(release.directory, `integration-${release.runId}.git`),
    ref: `refs/crewkite/integration/${release.runId}`,
  };
}
function repositoryIdentity(repository: string) {
  privateDirectory(repository);
  for (const name of ['objects', 'objects/info', 'objects/pack', 'refs']) {
    const path = join(repository, name);
    const state = lstatSync(path);
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      realpathSync(path) !== path ||
      state.uid !== process.getuid?.() ||
      (state.mode & 0o022) !== 0
    )
      throw Error('Integration repository metadata changed.');
  }
  for (const name of [
    'commondir',
    'objects/info/alternates',
    'objects/info/http-alternates',
    'worktrees',
  ]) {
    try {
      lstatSync(join(repository, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw Error('Integration repositories cannot share metadata or objects.');
  }
  for (const name of ['refs/crewkite', 'refs/crewkite/integration']) {
    const path = join(repository, name);
    try {
      const state = lstatSync(path);
      if (
        !state.isDirectory() ||
        state.isSymbolicLink() ||
        state.uid !== process.getuid?.() ||
        (state.mode & 0o022) !== 0 ||
        realpathSync(path) !== path
      )
        throw Error('Integration ref storage changed.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const name of ['index', 'HEAD', 'packed-refs']) {
    try {
      regularBytes(join(repository, name), maximumInput);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const config = regularBytes(join(repository, 'config'), 4096).toString('utf8');
  if (
    !/^\[core\]\n(?:\t(?:repositoryformatversion = 0|filemode = (?:true|false)|bare = true|ignorecase = true|precomposeunicode = true)\n)+$/.test(
      config,
    ) ||
    !config.includes('\tbare = true\n') ||
    !config.includes('\trepositoryformatversion = 0\n')
  )
    throw Error('Integration repository configuration changed.');
}
function environment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LC_ALL: 'C',
    HOME: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}
function argumentsFor(release: Release): string[] {
  const { repository, ref } = locations(release);
  if (release.kind === 'initialize') {
    try {
      lstatSync(repository);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return ['init', '--bare', '--quiet', '--template=', '--object-format=sha1', repository];
      throw error;
    }
    throw Error('Integration initialization requires unused storage.');
  }
  repositoryIdentity(repository);
  try {
    regularBytes(join(repository, ref), 64);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  switch (release.kind) {
    case 'empty-index':
      return ['read-tree', '--empty'];
    case 'blobs':
      return ['fast-import', '--quiet', '--done'];
    case 'index':
      return ['update-index', '-z', '--index-info'];
    case 'tree':
      return ['write-tree'];
    case 'symbolic-ref':
      return ['symbolic-ref', '--quiet', ref];
    case 'head':
      return ['rev-parse', '--verify', '--quiet', ref];
    case 'tree-type':
      return ['cat-file', '-t', oid.parse(release.next)];
    case 'cas':
      return ['update-ref', '--stdin'];
  }
}
function validateRelease(value: unknown): { release: Release; input: Buffer } {
  const release = ReleaseSchema.parse(value);
  const input = Buffer.from(release.input, 'base64');
  if (input.length > maximumInput || input.toString('base64') !== release.input)
    throw Error('Integration input exceeds its bound.');
  if (!['blobs', 'index'].includes(release.kind) && input.length)
    throw Error('Integration phase has unexpected input.');
  if (
    (release.kind === 'cas' && release.next === null) ||
    (release.kind === 'tree-type' && (release.next === null || release.old !== null)) ||
    (!['cas', 'tree-type'].includes(release.kind) &&
      (release.next !== null || release.old !== null))
  )
    throw Error('Integration phase has unexpected identities.');
  if (release.kind === 'blobs') {
    let cursor = 0,
      count = 0,
      total = 0;
    const line = () => {
      const end = input.indexOf(10, cursor);
      if (end < 0 || end - cursor > 64) throw Error('Integration blob input is invalid.');
      const value = input.subarray(cursor, end).toString('ascii');
      cursor = end + 1;
      return value;
    };
    while (cursor < input.length) {
      const command = line();
      if (command === 'done' && cursor === input.length && count > 0) break;
      count++;
      if (command !== 'blob' || count > 10000 || line() !== `mark :${count}`)
        throw Error('Integration blob input is invalid.');
      const size = /^data (0|[1-9][0-9]{0,7})$/.exec(line());
      if (!size) throw Error('Integration blob size is invalid.');
      const length = Number(size[1]);
      total += length;
      cursor += length;
      if (total > 64 * 1024 * 1024 || input[cursor++] !== 10 || line() !== `get-mark :${count}`)
        throw Error('Integration blob content is incomplete.');
    }
    if (cursor !== input.length || input.subarray(-5).toString() !== 'done\n')
      throw Error('Integration blob input is incomplete.');
  }
  if (release.kind === 'index') {
    const rows = new TextDecoder('utf-8', { fatal: true }).decode(input).split('\0');
    if (rows.pop() !== '' || rows.length > 10000)
      throw Error('Integration index input is invalid.');
    const seen = new Set<string>(),
      prefixes = new Map<string, string>();
    for (const row of rows) {
      const match = /^(100644|100755) [a-f0-9]{40}\t([\s\S]+)$/.exec(row);
      if (!match || Buffer.byteLength(match[2]) > 4096)
        throw Error('Integration index entry is invalid.');
      safePath(match[2], seen, prefixes);
    }
  }
  return { release, input };
}

// The gate receives no Git authority until the controller records its process group.
async function childMain() {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > maximumFrame + 4) throw Error('Integration release exceeds its bound.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, received);
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== bytes.length - 4)
    throw Error('Integration release is incomplete.');
  const { release, input } = validateRelease(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4))),
  );
  executableIdentity(release.git);
  const { repository, ref } = locations(release);
  const args = argumentsFor(release);
  process.umask(0o077);
  const payload =
    release.kind === 'cas'
      ? Buffer.from(
          `option no-deref\nupdate ${ref} ${release.next} ${release.old ?? '0'.repeat(40)}\n`,
        )
      : input;
  const child = spawn(
    release.git.executable,
    [
      '--no-optional-locks',
      '-c',
      `core.hooksPath=${devNull}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      `core.attributesFile=${devNull}`,
      '-c',
      'credential.helper=',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      '-c',
      'init.defaultBranch=private',
      ...args,
    ],
    {
      cwd: release.kind === 'initialize' ? release.directory : repository,
      env: environment(),
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin.on('error', () => {});
  let streamFailed = false;
  child.stdout.on('error', () => {
    streamFailed = true;
  });
  child.stderr.on('error', () => {
    streamFailed = true;
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.end(payload);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.exitCode = signal === null && !streamFailed ? (code ?? 125) : 125;
      resolve();
    });
  });
}

export function createIntegrationGit(
  input: {
    directory: string;
    runId: string;
    git: { executable: string; sha256: string };
  },
  dependencies: Dependencies = {},
) {
  if (process.platform === 'win32') throw Error('Integration requires Unix process ownership.');
  const binding = ReleaseSchema.omit({ kind: true, input: true, old: true, next: true }).parse({
    version: 1,
    ...input,
  });
  locations(binding);
  executableIdentity(binding.git);
  const moduleHash = createHash('sha256')
    .update(regularBytes(childPath, 1024 * 1024))
    .digest('hex');
  const nodePath = realpathSync(process.execPath);
  const nodeHash = createHash('sha256')
    .update(regularBytes(nodePath, 128 * 1024 * 1024, false))
    .digest('hex');
  const now = dependencies.now ?? (() => performance.now());
  const schedule =
    dependencies.schedule ??
    ((work, milliseconds) => {
      const timer = setTimeout(work, milliseconds);
      return () => clearTimeout(timer);
    });
  const absent = dependencies.groupAbsent ?? groupAbsent;
  let busy = false;
  let unresolved = false;

  function operation<T>(
    options: IntegrationGitOptions,
    work: (
      phase: (
        kind: Release['kind'],
        input?: Buffer,
        old?: string | null,
        next?: string | null,
      ) => Promise<GitResult>,
    ) => Promise<T>,
  ): IntegrationGitOperation<T> {
    if (busy || unresolved) throw Error('Integration ownership is unresolved.');
    const started = now();
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(options.deadline) ||
      options.deadline <= started ||
      options.deadline - started > 60_000
    )
      throw Error('Integration requires a remaining deadline of at most sixty seconds.');
    busy = true;
    let stopped = false;
    let stopCurrent: (() => void) | undefined;
    let sequence = 0;
    let uncertain = false;
    const phase = async (
      kind: Release['kind'],
      data: Buffer = Buffer.alloc(0),
      old: string | null = null,
      next: string | null = null,
    ): Promise<GitResult> => {
      if (stopped) throw 'stopped';
      if (now() >= options.deadline - 100) throw 'deadline';
      const release: Release = { ...binding, kind, input: data.toString('base64'), old, next };
      validateRelease(release);
      const encoded = Buffer.from(JSON.stringify(release));
      if (encoded.length > maximumFrame) throw Error('Integration release exceeds its bound.');
      const identity = Object.freeze({
        sequence: sequence++,
        kind,
        digest: createHash('sha256')
          .update(JSON.stringify({ release, nodePath, nodeHash, childPath, moduleHash }))
          .digest('hex'),
      });
      synchronous(() => options.lifecycle.beforePhase(identity));
      if (stopped) throw 'stopped';
      if (now() >= options.deadline - 100) throw 'deadline';
      if (
        createHash('sha256')
          .update(regularBytes(childPath, 1024 * 1024))
          .digest('hex') !== moduleHash ||
        createHash('sha256')
          .update(regularBytes(nodePath, 128 * 1024 * 1024, false))
          .digest('hex') !== nodeHash
      )
        throw Error('Integration gate identity changed.');
      if (stopped) throw 'stopped';
      if (now() >= options.deadline - 100) throw 'deadline';
      let child: ChildProcessWithoutNullStreams;
      try {
        child = (dependencies.spawn ?? spawn)(nodePath, [childPath, childMode], {
          cwd: binding.directory,
          env: environment(),
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        throw 'launch';
      }
      const group = child.pid ?? 0;
      let closed = false;
      let stdoutEnded = false;
      let stderrEnded = false;
      let code: number | null = null;
      let signal: NodeJS.Signals | null = null;
      let failure: Reason | null = null;
      let outputBytes = 0;
      const output: Buffer[] = [];
      const cancellations: Array<() => void> = [];
      return new Promise<GitResult>((resolve, reject) => {
        let settled = false;
        let recorded = false;
        let cancelObservation: (() => void) | undefined;
        const groupGone = () => group > 0 && absent(group);
        const finish = () => {
          cancelObservation?.();
          cancelObservation = undefined;
          const quiescent = closed && stdoutEnded && stderrEnded && groupGone();
          if (settled) {
            if (quiescent && !recorded) {
              try {
                synchronous(() => options.lifecycle.quiescent(identity, group));
                recorded = true;
              } catch {}
            }
            return;
          }
          settled = true;
          for (const cancel of cancellations) cancel();
          stopCurrent = undefined;
          if (!quiescent) {
            uncertain = true;
            return reject('ownership');
          }
          try {
            synchronous(() => options.lifecycle.quiescent(identity, group));
            recorded = true;
          } catch {
            uncertain = true;
            return reject('ownership');
          }
          if (now() >= options.deadline) failure ??= 'deadline';
          if (failure) return reject(failure);
          resolve({ stdout: Buffer.concat(output), code, signal });
        };
        // Stream closure can precede the operating system reaping the last group member.
        // Keep ownership until every closure fact is observed or the original deadline ends.
        const observe = () => {
          cancelObservation?.();
          cancelObservation = undefined;
          if (closed && stdoutEnded && stderrEnded && groupGone()) return finish();
          if (!settled && closed)
            cancelObservation = schedule(
              observe,
              Math.max(0, Math.min(10, options.deadline - now())),
            );
        };
        const sendSignal = (value: NodeJS.Signals) => {
          if (!settled && group > 0 && !groupGone()) {
            try {
              (
                dependencies.signal ??
                ((ownedGroup, ownedSignal) => process.kill(-ownedGroup, ownedSignal))
              )(group, value);
            } catch {}
          }
        };
        let terminating = false;
        const stop = (reason: Reason) => {
          failure ??= reason;
          if (terminating) return;
          terminating = true;
          child.stdin.destroy();
          sendSignal('SIGTERM');
          cancellations.push(
            schedule(
              () => sendSignal('SIGKILL'),
              Math.max(0, Math.min(50, options.deadline - now())),
            ),
          );
        };
        stopCurrent = () => stop('stopped');
        child.stdin.on('error', () => stop('launch'));
        child.stdout.on('error', () => stop('output'));
        child.stderr.on('error', () => stop('output'));
        child.once('error', () => stop('launch'));
        child.stdout.on('data', (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > maximumOutput) stop('output');
          else output.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > maximumOutput) stop('output');
        });
        child.stdout.once('end', () => {
          stdoutEnded = true;
          if (closed) observe();
        });
        child.stderr.once('end', () => {
          stderrEnded = true;
          if (closed) observe();
        });
        child.once('close', (exitCode, exitSignal) => {
          code = exitCode;
          signal = exitSignal;
          closed = true;
          observe();
        });
        cancellations.push(
          schedule(() => stop('deadline'), Math.max(0, options.deadline - now() - 100)),
        );
        cancellations.push(schedule(finish, Math.max(0, options.deadline - now())));
        try {
          if (!Number.isSafeInteger(group) || group <= 0)
            throw Error('Integration group is unavailable.');
          synchronous(() => options.lifecycle.owned(identity, group));
          if (stopped) return stop('stopped');
          if (now() >= options.deadline - 100) return stop('deadline');
          const header = Buffer.alloc(4);
          header.writeUInt32BE(encoded.length);
          child.stdin.end(Buffer.concat([header, encoded]));
        } catch {
          uncertain = true;
          stop('ownership');
        }
      });
    };
    const result: Promise<IntegrationGitOutcome<T>> = (async () => {
      try {
        const value = await work(phase);
        if (stopped) throw 'stopped';
        if (now() >= options.deadline) throw 'deadline';
        return { value, reason: null, quiescent: true };
      } catch (error) {
        const reason: Reason =
          typeof error === 'string' &&
          ['stopped', 'deadline', 'launch', 'output', 'ownership'].includes(error)
            ? (error as Reason)
            : 'git';
        return { value: null, reason, quiescent: !uncertain };
      } finally {
        busy = false;
        unresolved ||= uncertain;
      }
    })();
    return {
      result,
      stop() {
        stopped = true;
        stopCurrent?.();
      },
    };
  }
  function successful(result: GitResult): Buffer {
    if (result.code !== 0 || result.signal !== null) throw Error('Integration Git phase failed.');
    return result.stdout;
  }
  async function direct(phase: Parameters<Parameters<typeof operation>[1]>[0]) {
    const result = await phase('symbolic-ref');
    if (result.code !== 1 || result.signal !== null) throw Error('Integration ref must be direct.');
  }
  return {
    initialize(options: IntegrationGitOptions) {
      return operation(options, async (phase) => {
        successful(await phase('initialize'));
        return true;
      });
    },
    importTree(files: readonly FileContent[], options: IntegrationGitOptions) {
      const seen = new Set<string>(),
        prefixes = new Map<string, string>();
      let bytes = 0;
      if (files.length > 10000) throw Error('Integration tree exceeds its file limit.');
      const frozen = files.map((file) => {
        safePath(file.path, seen, prefixes);
        if (
          Buffer.byteLength(file.path) > 4096 ||
          Buffer.from(file.path).toString() !== file.path ||
          !Buffer.isBuffer(file.content) ||
          !['100644', '100755'].includes(file.mode) ||
          file.bytes !== file.content.length ||
          createHash('sha256').update(file.content).digest('hex') !== file.hash
        )
          throw Error('Integration file identity changed.');
        bytes += file.content.length;
        if (bytes > 64 * 1024 * 1024) throw Error('Integration tree exceeds its byte limit.');
        return { ...file, content: Buffer.from(file.content) };
      });
      return operation(options, async (phase) => {
        successful(await phase('empty-index'));
        const commands = frozen.flatMap((file, index) => [
          Buffer.from(`blob\nmark :${index + 1}\ndata ${file.bytes}\n`),
          file.content,
          Buffer.from(`\nget-mark :${index + 1}\n`),
        ]);
        const marks = frozen.length
          ? successful(await phase('blobs', Buffer.concat([...commands, Buffer.from('done\n')])))
              .toString()
              .trim()
              .split('\n')
          : [];
        if (marks.length !== frozen.length || marks.some((mark) => !oid.safeParse(mark).success))
          throw Error('Integration blob identities changed.');
        successful(
          await phase(
            'index',
            Buffer.from(
              frozen.map((file, index) => `${file.mode} ${marks[index]}\t${file.path}\0`).join(''),
            ),
          ),
        );
        return oid.parse(
          successful(await phase('tree'))
            .toString()
            .trim(),
        );
      });
    },
    readHead(options: IntegrationGitOptions) {
      return operation(options, async (phase) => {
        await direct(phase);
        const result = await phase('head');
        if (result.code === 1 && result.signal === null && result.stdout.length === 0) return null;
        return oid.parse(successful(result).toString().trim());
      });
    },
    compareAndSwap(expected: { old: string | null; new: string }, options: IntegrationGitOptions) {
      const old = oid.nullable().parse(expected.old),
        next = oid.parse(expected.new);
      return operation(options, async (phase) => {
        await direct(phase);
        if (successful(await phase('tree-type', undefined, null, next)).toString() !== 'tree\n')
          throw Error('Integration ref requires a tree object.');
        successful(await phase('cas', undefined, old, next));
        return true;
      });
    },
  };
}

if (process.argv[1] === childPath && process.argv[2] === childMode) {
  if (process.argv.length !== 3) process.exitCode = 125;
  else
    void childMain().catch(() => {
      process.exitCode = 125;
    });
}
