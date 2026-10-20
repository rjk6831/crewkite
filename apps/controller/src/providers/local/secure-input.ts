import { spawn } from 'node:child_process';
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
import { isAbsolute, join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { CommandIdSchema, HashSchema, RevisionSchema } from '@crewkite/contracts';
import { z } from 'zod';
import { groupAbsent, type Schedule } from '../../host/worker.ts';
import {
  LocalEndpointSchema,
  localConfiguredConnectionHash,
  localConnectionHash,
} from './connection.ts';

const MAX_FRAME_BYTES = 32768;
const PROMPT_MS = 60000;
const CLEANUP_MS = 5000;
const KILL_MS = 2500;
const helperSchema = z.strictObject({
  root: z.string().min(1).max(4096).refine(isAbsolute),
  sha256: HashSchema,
  sourceHash: HashSchema,
  target: z.literal('darwin-arm64'),
});
export type LocalInputHelper = z.output<typeof helperSchema>;
const operationBinding = {
  operationId: CommandIdSchema,
  nonce: HashSchema,
  connectionHash: HashSchema,
};
export const LocalInputBindingSchema = z.discriminatedUnion('version', [
  z.strictObject({
    version: z.literal(1),
    ...operationBinding,
    setupHash: HashSchema,
    revision: RevisionSchema,
  }),
  z.strictObject({
    version: z.literal(2),
    ...operationBinding,
    connectionRevision: RevisionSchema,
  }),
]);
export type LocalInputBinding = z.output<typeof LocalInputBindingSchema>;
const promptSchema = z
  .strictObject({ binding: LocalInputBindingSchema, endpoint: LocalEndpointSchema })
  .refine(({ binding, endpoint }) => {
    const expected =
      binding.version === 1
        ? localConnectionHash(endpoint, binding.setupHash)
        : localConfiguredConnectionHash(endpoint, binding.connectionRevision);
    return expected === binding.connectionHash;
  });
const resultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    binding: LocalInputBindingSchema,
    outcome: z.literal('submitted'),
    secret: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          value.isWellFormed() &&
          value.trim().length > 0 &&
          !/[\0\n\r\v\f\u0085\u2028\u2029]/u.test(value) &&
          Buffer.byteLength(value) <= 4096,
      ),
  }),
  z.strictObject({ binding: LocalInputBindingSchema, outcome: z.literal('cancelled') }),
  z.strictObject({ binding: LocalInputBindingSchema, outcome: z.literal('failed') }),
]);
const sameBinding = (left: LocalInputBinding, right: LocalInputBinding) => {
  if (
    left.operationId !== right.operationId ||
    left.nonce !== right.nonce ||
    left.connectionHash !== right.connectionHash
  )
    return false;
  if (left.version === 1 && right.version === 1)
    return left.setupHash === right.setupHash && left.revision === right.revision;
  return (
    left.version === 2 &&
    right.version === 2 &&
    left.connectionRevision === right.connectionRevision
  );
};

class LocalSecretCandidate {
  #secret: Buffer | null;
  #binding: LocalInputBinding;

  constructor(secret: Buffer, binding: LocalInputBinding) {
    this.#secret = secret;
    this.#binding = Object.freeze({ ...binding });
  }

  take(expected: unknown): string | null {
    const parsed = LocalInputBindingSchema.safeParse(expected);
    if (!parsed.success || !sameBinding(parsed.data, this.#binding)) {
      this.discard();
      return null;
    }
    const bytes = this.#secret;
    this.#secret = null;
    if (!bytes) return null;
    const value = bytes.toString('utf8');
    bytes.fill(0);
    return value;
  }

  discard() {
    this.#secret?.fill(0);
    this.#secret = null;
  }
}
export type LocalInputResult =
  | { kind: 'ready'; binding: LocalInputBinding; candidate: LocalSecretCandidate }
  | {
      kind: 'cancelled' | 'failed';
      reason: 'input' | 'helper' | 'protocol' | 'deadline' | 'revoked' | 'ownership';
      clientQuiescent: boolean;
    };
export type LocalInputChild = {
  group: number;
  input: Writable | null;
  output: Readable | Writable | null | undefined;
  onSpawn: (handler: () => void) => void;
  onError: (handler: () => void) => void;
  onClose: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
};
type LaunchOptions = {
  cwd: string;
  detached: true;
  stdio: ['pipe', 'ignore', 'ignore', 'pipe'];
  env: { LANG: 'C.UTF-8' };
};

/** The bootstrap supplies one fixed artifact identity, with no caller path override. */
export function resolveLocalInputHelper(input: unknown): string {
  const parsed = helperSchema.safeParse(input);
  if (!parsed.success) throw Error('Local input helper is unavailable.');
  const { root, sha256 } = parsed.data;
  const path = join(root, 'bin/local-secure-input');
  try {
    const directory = lstatSync(root);
    if (!directory.isDirectory() || realpathSync(root) !== root || realpathSync(path) !== path)
      throw Error('Local input helper is unavailable.');
    const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(file, { bigint: true });
      if (
        !before.isFile() ||
        before.size === 0n ||
        before.size > 1024n * 1024n ||
        !(before.mode & 0o111n) ||
        before.mode & 0o022n
      )
        throw Error();
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(file, bytes, count, bytes.length - count, null);
        if (read === 0) break;
        count += read;
      }
      const after = fstatSync(file, { bigint: true });
      const current = lstatSync(path, { bigint: true });
      const fields = [
        'dev',
        'ino',
        'size',
        'mode',
        'uid',
        'gid',
        'nlink',
        'mtimeNs',
        'ctimeNs',
      ] as const;
      if (
        count !== Number(before.size) ||
        !current.isFile() ||
        fields.some((field) => before[field] !== after[field] || after[field] !== current[field]) ||
        realpathSync(path) !== path ||
        createHash('sha256').update(bytes.subarray(0, count)).digest('hex') !== sha256
      )
        throw Error();
    } finally {
      closeSync(file);
    }
  } catch {
    throw Error('Local input helper is unavailable.');
  }
  return path;
}

export function startLocalSecretInput(
  value: unknown,
  helper: unknown,
  options: {
    platform?: string;
    arch?: string;
    now?: () => number;
    schedule?: Schedule;
    verifyHelper?: (value: LocalInputHelper) => string;
    launch?: (executable: string, options: LaunchOptions) => LocalInputChild;
    groupAbsent?: (group: number) => boolean;
    signal?: (group: number, signal: NodeJS.Signals) => void;
  } = {},
) {
  const parsed = promptSchema.safeParse(value);
  const descriptor = helperSchema.safeParse(helper);
  if (!parsed.success || !descriptor.success)
    throw Error('Local input configuration is unavailable.');
  if (
    (options.platform ?? process.platform) !== 'darwin' ||
    (options.arch ?? process.arch) !== 'arm64'
  )
    throw Error('Local input requires macOS on Apple Silicon.');
  const prompt = { ...parsed.data, binding: Object.freeze(parsed.data.binding) };
  const now = options.now ?? (() => performance.now());
  let previous = now();
  if (!Number.isFinite(previous)) throw Error('Local input clock is unavailable.');
  const deadline = previous + PROMPT_MS + CLEANUP_MS;
  const remaining = () => {
    const current = now();
    if (!Number.isFinite(current) || current < previous) return 0;
    previous = current;
    return Math.max(0, deadline - current);
  };
  const schedule =
    options.schedule ??
    ((work, delay) => {
      const timer = setTimeout(work, delay);
      return () => clearTimeout(timer);
    });
  const executable = (options.verifyHelper ?? resolveLocalInputHelper)(descriptor.data);
  const launch =
    options.launch ??
    ((path, settings) => {
      const child = spawn(path, [], settings);
      return {
        group: child.pid ?? 0,
        input: child.stdin,
        output: child.stdio[3],
        onSpawn: (handler) => void child.once('spawn', handler),
        onError: (handler) => void child.once('error', handler),
        onClose: (handler) => void child.once('close', handler),
      };
    });
  const completion = Promise.withResolvers<LocalInputResult>();
  let child: LocalInputChild | undefined;
  let pending = Buffer.alloc(0),
    total = 0,
    expectedBytes: number | undefined;
  let secret: Buffer | null = null;
  let candidate: LocalSecretCandidate | undefined;
  let outcome: 'submitted' | 'cancelled' | 'failed' | undefined;
  let failure: Extract<LocalInputResult, { kind: 'failed' | 'cancelled' }>['reason'] | undefined;
  let closed = false,
    spawned = false,
    spawnFailed = false,
    settled = false,
    cleaning = false;
  const timers: Array<() => void> = [];
  const absent = () =>
    spawnFailed ||
    (!!child && child.group > 0 && (options.groupAbsent ?? groupAbsent)(child.group));
  const discard = () => {
    secret?.fill(0);
    secret = null;
    candidate?.discard();
    pending.fill(0);
    pending = Buffer.alloc(0);
  };
  const settle = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    for (const cancel of timers) cancel();
    const clientQuiescent = closed && absent();
    if (
      !failure &&
      outcome === 'submitted' &&
      secret &&
      code === 0 &&
      signal === null &&
      clientQuiescent &&
      child?.output instanceof Readable &&
      child.output.readableEnded &&
      remaining() > 0
    ) {
      candidate = new LocalSecretCandidate(secret, prompt.binding);
      secret = null;
      completion.resolve({ kind: 'ready', binding: prompt.binding, candidate });
    } else {
      discard();
      completion.resolve({
        kind: outcome === 'cancelled' && !failure ? 'cancelled' : 'failed',
        reason: failure ?? (clientQuiescent ? 'input' : 'ownership'),
        clientQuiescent,
      });
    }
  };
  const signal = (name: NodeJS.Signals) => {
    if (!child || child.group <= 0 || absent()) return;
    try {
      (options.signal ?? ((group, name) => process.kill(-group, name)))(child.group, name);
    } catch {}
  };
  let killedAt: number | undefined;
  const settleAtCutoff = () => {
    if (child && !closed && absent()) timers.push(schedule(() => settle(null, null), 0));
    else settle(null, null);
  };
  const cutoff = () => {
    if (settled) return;
    if (absent()) return settleAtCutoff();
    setImmediate(() => {
      if (settled) return;
      if (absent()) return settleAtCutoff();
      const late = killedAt === undefined ? 0 : killedAt + CLEANUP_MS - KILL_MS - now();
      const wait = Math.min(late, remaining());
      if (wait > 0) timers.push(schedule(settleAtCutoff, wait));
      else settle(null, null);
    });
  };
  const cleanup = () => {
    if (cleaning || settled) return;
    cleaning = true;
    try {
      child?.input?.end();
    } catch {}
    timers.push(schedule(() => signal('SIGTERM'), Math.min(1000, remaining())));
    timers.push(
      schedule(
        () => {
          killedAt = now();
          signal('SIGKILL');
        },
        Math.min(KILL_MS, remaining()),
      ),
    );
    timers.push(schedule(cutoff, Math.min(CLEANUP_MS, remaining())));
  };
  const refuse = (reason: NonNullable<typeof failure>) => {
    failure ??= reason;
    discard();
    cleanup();
  };
  const stop = () => {
    candidate?.discard();
    if (!settled) refuse('revoked');
  };
  if (remaining() <= CLEANUP_MS)
    return {
      result: Promise.resolve<LocalInputResult>({
        kind: 'failed',
        reason: 'deadline',
        clientQuiescent: true,
      }),
      stop: () => {},
    };
  try {
    child = launch(executable, {
      cwd: descriptor.data.root,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
      env: { LANG: 'C.UTF-8' },
    });
    child.onSpawn(() => {
      spawned = true;
    });
    child.onError(() => {
      spawnFailed = !spawned && child?.group === 0;
      refuse('helper');
    });
    child.onClose((code, signal) => {
      closed = true;
      if (!outcome || pending.length) failure ??= 'protocol';
      if (absent()) settle(code, signal);
      else refuse('ownership');
    });
    child.input?.on('error', () => refuse('helper'));
    if (!(child.output instanceof Readable) || !child.input || child.group <= 0) refuse('helper');
    else {
      child.output.on('error', () => refuse('protocol'));
      child.output.on('data', (chunk: Buffer) => {
        if (settled || failure) return;
        total += chunk.length;
        if (remaining() <= CLEANUP_MS) return refuse('deadline');
        if (outcome || total > MAX_FRAME_BYTES + 4) return refuse('protocol');
        pending = Buffer.concat([pending, chunk]);
        if (expectedBytes === undefined && pending.length >= 4) {
          expectedBytes = pending.readUInt32BE(0);
          pending = pending.subarray(4);
          if (expectedBytes === 0 || expectedBytes > MAX_FRAME_BYTES) return refuse('protocol');
        }
        if (expectedBytes === undefined || pending.length < expectedBytes) return;
        if (pending.length !== expectedBytes) return refuse('protocol');
        try {
          const message = resultSchema.safeParse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending)),
          );
          pending.fill(0);
          pending = Buffer.alloc(0);
          if (!message.success || !sameBinding(message.data.binding, prompt.binding))
            return refuse('protocol');
          if (remaining() <= CLEANUP_MS) return refuse('deadline');
          outcome = message.data.outcome;
          if (message.data.outcome === 'submitted') secret = Buffer.from(message.data.secret);
          cleanup();
        } catch {
          refuse('protocol');
        }
      });
      const timeoutMs = Math.floor(Math.min(PROMPT_MS, remaining() - CLEANUP_MS));
      if (timeoutMs <= 0) refuse('deadline');
      else {
        const bytes = Buffer.from(JSON.stringify({ ...prompt, timeoutMs }));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(bytes.length);
        child.input.write(Buffer.concat([header, bytes]));
      }
    }
  } catch {
    refuse('helper');
  }
  timers.push(
    schedule(
      () => {
        if (!outcome) refuse('deadline');
      },
      Math.max(0, remaining() - CLEANUP_MS),
    ),
  );
  timers.push(
    schedule(() => {
      refuse('deadline');
      signal('SIGKILL');
      settle(null, null);
    }, remaining()),
  );
  return { result: completion.promise, stop };
}
