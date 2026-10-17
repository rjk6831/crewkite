import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const variable = 'CREWKITE_CHECK_OWNER';
const witnessVariable = 'CREWKITE_CHECK_WORKER_EXIT';
const coderEntrypoint = fileURLToPath(
  new URL('../../../../packages/testkit/src/providers/worker.ts', import.meta.url),
);
const stages = ['policy', 'lint', 'types', 'node-tests', 'build', 'desktop'] as const;
export type CheckStage = (typeof stages)[number];
export type CheckOwner = {
  version: 1;
  directory: string;
  stateRoot: string;
  electronExecutable: string;
  attemptId: string;
  generation: number;
  stage: CheckStage;
  parentGroup: number;
};
type Role = 'stage' | 'fixture' | 'worker' | 'check' | 'controller' | 'electron' | 'watcher';
type Intent = {
  type: 'intent';
  owner: CheckOwner;
  role: Role;
  detached: boolean;
  witness?: 'scripted-coder-v1';
};
type Acknowledgment = { type: 'ack'; pid: number; group: number };
type Terminal = { type: 'close'; code: number | null; signal: string | null };
export type CheckRoot = {
  id: string;
  intent: Intent;
  acknowledgment?: Acknowledgment;
  terminal?: Terminal;
  exitEvent?: { type: 'fixture-exit'; pid: number; code: number };
  spawnFailed: boolean;
};

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function parseCheckOwner(value: unknown): CheckOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Check ownership context is invalid.');
  const v = value as CheckOwner;
  if (
    Object.keys(v).sort().join(',') !==
      'attemptId,directory,electronExecutable,generation,parentGroup,stage,stateRoot,version' ||
    v.version !== 1 ||
    typeof v.directory !== 'string' ||
    !isAbsolute(v.directory) ||
    resolve(v.directory) !== v.directory ||
    typeof v.stateRoot !== 'string' ||
    !isAbsolute(v.stateRoot) ||
    resolve(v.stateRoot) !== v.stateRoot ||
    typeof v.electronExecutable !== 'string' ||
    !isAbsolute(v.electronExecutable) ||
    resolve(v.electronExecutable) !== v.electronExecutable ||
    typeof v.attemptId !== 'string' ||
    !/^att_[a-zA-Z0-9-]{1,100}$/.test(v.attemptId) ||
    !integer(v.generation) ||
    !integer(v.parentGroup) ||
    !stages.includes(v.stage)
  )
    throw Error('Check ownership context is invalid.');
  return v;
}

export function checkOwner(): CheckOwner | undefined {
  const text = process.env[variable];
  if (text === undefined) return;
  if (Buffer.byteLength(text) > 4096) throw Error('Check ownership context exceeds its bound.');
  const context = parseCheckOwner(JSON.parse(text));
  const directory = lstatSync(context.directory);
  const stateRoot = lstatSync(context.stateRoot);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    !stateRoot.isDirectory() ||
    stateRoot.isSymbolicLink()
  )
    throw Error('Check ownership directories changed.');
  return context.parentGroup === 0 ? { ...context, parentGroup: process.pid } : context;
}

// The stage preloader resolves its group once before Node forks test processes.
if (process.env[variable]) process.env[variable] = JSON.stringify(checkOwner());
installWorkerExitWitness();

export function qualifiedWorkerExit(root: CheckRoot): boolean {
  return (
    root.intent.witness === 'scripted-coder-v1' &&
    root.intent.role === 'worker' &&
    root.intent.detached &&
    ['node-tests', 'desktop'].includes(root.intent.owner.stage) &&
    !root.spawnFailed &&
    !!root.acknowledgment &&
    root.acknowledgment.pid === root.acknowledgment.group &&
    root.exitEvent?.pid === root.acknowledgment.pid
  );
}

function installWorkerExitWitness() {
  const text = process.env[witnessVariable];
  delete process.env[witnessVariable];
  if (text === undefined) return;
  if (Buffer.byteLength(text) > 4096) throw Error('Worker exit witness exceeds its bound.');
  const marker = JSON.parse(text);
  const context = checkOwner();
  if (
    !marker ||
    Object.keys(marker).sort().join(',') !== 'entrypoint,id' ||
    !/^[a-f0-9-]{36}\.jsonl$/.test(marker.id) ||
    marker.entrypoint !== coderEntrypoint ||
    process.argv[1] !== coderEntrypoint ||
    !context
  )
    throw Error('Worker exit witness is invalid.');
  process.once('exit', (code) => {
    try {
      const root = readRoot(context, marker.id);
      if (
        root.intent.witness !== 'scripted-coder-v1' ||
        root.intent.role !== 'worker' ||
        !root.intent.detached ||
        !['node-tests', 'desktop'].includes(root.intent.owner.stage) ||
        root.acknowledgment?.pid !== process.pid ||
        root.acknowledgment.group !== process.pid ||
        root.terminal ||
        root.exitEvent ||
        root.spawnFailed
      )
        return;
      const fd = openSync(
        join(context.directory, marker.id),
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      try {
        writeSync(fd, `${JSON.stringify({ type: 'fixture-exit', pid: process.pid, code })}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // An absent witness keeps crash-time ownership unknown.
    }
  });
}

export function checkEnvironment(): NodeJS.ProcessEnv {
  const context = checkOwner();
  return context ? { [variable]: JSON.stringify(context) } : {};
}

export function enrollCheckRoot(
  role: Role,
  detached: boolean,
  explicit?: CheckOwner,
  scriptedEntrypoint?: string,
): {
  environment: NodeJS.ProcessEnv;
  preload?: string;
  acknowledge: (child: ChildProcess) => void;
  failed: () => void;
} {
  const context = explicit ? parseCheckOwner(explicit) : checkOwner();
  if (!context) return { environment: {}, acknowledge: () => {}, failed: () => {} };
  const id = randomUUID();
  const path = join(context.directory, `${id}.jsonl`);
  const append = (value: unknown, first = false) => {
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        (first ? constants.O_CREAT | constants.O_EXCL : constants.O_APPEND),
      0o600,
    );
    try {
      writeSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const witness =
    role === 'worker' &&
    detached &&
    ['node-tests', 'desktop'].includes(context.stage) &&
    scriptedEntrypoint === coderEntrypoint
      ? ('scripted-coder-v1' as const)
      : undefined;
  append(
    {
      type: 'intent',
      owner: context,
      role,
      detached,
      ...(witness ? { witness } : {}),
    } satisfies Intent,
    true,
  );
  let acknowledged = false;
  let failed = false;
  return {
    environment: {
      [variable]: JSON.stringify({ ...context, parentGroup: detached ? 0 : context.parentGroup }),
      ...(witness
        ? { [witnessVariable]: JSON.stringify({ id: `${id}.jsonl`, entrypoint: coderEntrypoint }) }
        : {}),
    },
    ...(witness ? { preload: import.meta.url } : {}),
    acknowledge(child) {
      if (acknowledged || failed) throw Error('Check launch was acknowledged twice.');
      let persistenceFailed = false;
      const cleanup = () => {
        if (!child.pid) return;
        try {
          process.kill(detached ? -child.pid : child.pid, 'SIGKILL');
        } catch {}
      };
      const record = (value: unknown) => {
        if (persistenceFailed) return;
        try {
          append(value);
        } catch {
          persistenceFailed = true;
          cleanup();
        }
      };
      // Persistence failure cannot discard the only handle to a freshly owned child.
      child.once('close', (code, signal) => record({ type: 'close', code, signal }));
      child.once('error', () => {
        if (!child.pid) {
          failed = true;
          record({ type: 'spawn-error', noChild: false });
        } else {
          persistenceFailed = true;
          cleanup();
        }
      });
      if (!child.pid || !integer(child.pid)) return;
      acknowledged = true;
      try {
        append({ type: 'ack', pid: child.pid, group: detached ? child.pid : context.parentGroup });
      } catch (error) {
        persistenceFailed = true;
        cleanup();
        throw error;
      }
    },
    failed() {
      if (acknowledged || failed) throw Error('Check launch has an ambiguous outcome.');
      failed = true;
      append({ type: 'spawn-error', noChild: true });
    },
  };
}

// Only frozen launch sites use this wrapper. Ordinary execution has no journal context.
export const spawnCheckChild = ((...args: Parameters<typeof spawn>) => {
  const [executable, argv, options] = args;
  const ticket = enrollCheckRoot('fixture', options?.detached === true);
  let child: ChildProcess;
  try {
    child = spawn(executable, argv, {
      ...options,
      env: { ...(options?.env ?? process.env), ...ticket.environment },
    });
  } catch (error) {
    ticket.failed();
    throw error;
  }
  ticket.acknowledge(child);
  return child;
}) as typeof spawn;

export function inspectCheckRoots(context: CheckOwner): {
  roots: CheckRoot[];
  unknown: boolean;
  unresolved: string[];
} {
  parseCheckOwner(context);
  const names = readdirSync(context.directory).sort();
  if (names.length > 4096) throw Error('Check ownership journal exceeds its bound.');
  const roots: CheckRoot[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    try {
      roots.push(readRoot(context, name));
    } catch {
      unresolved.push(name);
    }
  }
  return { roots, unknown: unresolved.length > 0, unresolved };
}

export function readCheckRoots(context: CheckOwner): CheckRoot[] {
  const result = inspectCheckRoots(context);
  if (result.unknown) throw Error('Invalid check ownership record.');
  return result.roots;
}

function readRoot(context: CheckOwner, name: string): CheckRoot {
  if (!/^[a-f0-9-]{36}\.jsonl$/.test(name)) throw Error('Unexpected check ownership entry.');
  const path = join(context.directory, name);
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > 16384)
    throw Error('Invalid check ownership record.');
  const text = readFileSync(path, 'utf8');
  if (!text.endsWith('\n')) throw Error('Truncated check ownership record.');
  const rows = text
    .trimEnd()
    .split('\n')
    .map((row) => JSON.parse(row));
  const first = rows[0] as Intent;
  if (
    first.type !== 'intent' ||
    Object.keys(first).sort().join(',') !==
      (first.witness === undefined
        ? 'detached,owner,role,type'
        : 'detached,owner,role,type,witness') ||
    (first.witness !== undefined &&
      (first.witness !== 'scripted-coder-v1' ||
        first.role !== 'worker' ||
        !first.detached ||
        !['node-tests', 'desktop'].includes(first.owner?.stage))) ||
    typeof first.detached !== 'boolean' ||
    !['stage', 'fixture', 'worker', 'check', 'controller', 'electron', 'watcher'].includes(
      first.role,
    )
  )
    throw Error('Invalid check ownership intent.');
  const binding = parseCheckOwner(first.owner);
  if (
    binding.attemptId !== context.attemptId ||
    binding.generation !== context.generation ||
    binding.directory !== context.directory ||
    binding.stateRoot !== context.stateRoot ||
    binding.electronExecutable !== context.electronExecutable
  )
    throw Error('Check ownership binding changed.');
  const result: CheckRoot = { id: name, intent: first, spawnFailed: false };
  if (rows[1]?.type === 'spawn-error') {
    if (
      Object.keys(rows[1]).sort().join(',') !== 'noChild,type' ||
      typeof rows[1].noChild !== 'boolean' ||
      rows.length !== (rows[1].noChild ? 2 : 3)
    )
      throw Error('Incomplete failed check launch.');
    result.spawnFailed = true;
  }
  if (rows.length > 4) throw Error('Duplicate check ownership record.');
  if (rows.length >= 2 && !result.spawnFailed) {
    const ack = rows[1] as Acknowledgment;
    if (
      ack.type !== 'ack' ||
      Object.keys(ack).sort().join(',') !== 'group,pid,type' ||
      !integer(ack.pid) ||
      ack.pid === 0 ||
      !integer(ack.group) ||
      ack.group === 0 ||
      ack.group !== (first.detached ? ack.pid : binding.parentGroup)
    )
      throw Error('Invalid check process acknowledgment.');
    result.acknowledgment = ack;
  }
  let terminalIndex = 2;
  if (rows[2]?.type === 'fixture-exit') {
    const event = rows[2] as NonNullable<CheckRoot['exitEvent']>;
    if (
      Object.keys(event).sort().join(',') !== 'code,pid,type' ||
      !integer(event.code) ||
      !integer(event.pid)
    )
      throw Error('Invalid worker exit event.');
    result.exitEvent = event;
    if (!qualifiedWorkerExit(result)) throw Error('Unbound worker exit event.');
    terminalIndex = 3;
  }
  if (rows.length > terminalIndex + 1) throw Error('Duplicate check ownership record.');
  if (rows.length > terminalIndex) {
    const terminal = rows[terminalIndex] as Terminal;
    if (
      terminal.type !== 'close' ||
      Object.keys(terminal).sort().join(',') !== 'code,signal,type' ||
      !(
        terminal.code === null ||
        (Number.isSafeInteger(terminal.code) && (terminal.code >= 0 || result.spawnFailed))
      ) ||
      !(terminal.signal === null || /^SIG[A-Z0-9]+$/.test(terminal.signal))
    )
      throw Error('Invalid check process terminal record.');
    result.terminal = terminal;
  }
  return result;
}
