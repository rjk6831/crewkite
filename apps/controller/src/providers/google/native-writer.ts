import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  AttemptIdSchema,
  NativeTargetPathSchema,
  type Observation,
  SealedHandoffPacketSchema,
} from '@crewkite/contracts';
import { verifyHandoff } from '@crewkite/contracts/hash';
import { z } from 'zod';
import { groupAbsent, type Schedule } from '../../host/worker.ts';

const MAX_BYTES = 1_048_576;
const MAX_LINE_BYTES = 131_072;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
      }),
    );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const permissionMode = z.enum(['request-review', 'strict', 'always-proceed', 'proceed-in-sandbox']);
const path = NativeTargetPathSchema;
const fileSchema = z.strictObject({
  path,
  baseHash: hash,
  content: z
    .string()
    .max(65_536)
    .refine((value) => value.isWellFormed() && !value.includes('\0')),
});
const replacement = fileSchema.extend({ attemptId: AttemptIdSchema });
const usage = z.strictObject({
  input_tokens: count,
  output_tokens: count,
  thinking_tokens: count,
  cache_read_tokens: count,
  total_tokens: count,
});
const init = z.strictObject({
  event: z.literal('init'),
  conversation_id: text(200),
  init: z.strictObject({
    cwd: text(4096),
    tools: z.array(text(200)).max(256),
    permission_mode: permissionMode,
    model: text(200),
    agent: text(200).optional(),
    json_schema: z.unknown().optional(),
  }),
});
const step = z.strictObject({
  event: z.literal('step_update'),
  step_update: z.strictObject({
    conversation_id: text(200),
    step_index: count,
    state: z.enum(['ACTIVE', 'DONE', 'ERROR']),
    step_type: z
      .enum([
        'user_input',
        'agent_response',
        'tool',
        'checkpoint',
        'finish',
        'unknown',
        'subagent',
        'system_message',
        'error_message',
      ])
      .optional(),
    text_delta: z.string().max(65_536).optional(),
    duration_seconds: z.number().finite().nonnegative().optional(),
    usage: usage.optional(),
    tool_name: text(200).optional(),
    tool_info: z.unknown().optional(),
    subagent_info: z.unknown().optional(),
  }),
});
const result = z.strictObject({
  event: z.literal('result'),
  result: z.strictObject({
    conversation_id: text(200),
    status: z.enum([
      'SUCCESS',
      'ERROR',
      'CANCELED',
      'INTERRUPTED',
      'INVALID',
      'WAITING',
      'RUNNING',
    ]),
    response: z.string().max(65_536),
    error: z.string().max(16_384).optional(),
    duration_seconds: z.number().finite().nonnegative(),
    num_turns: count,
    usage,
    structured_output: replacement.optional(),
    json_schema: z.unknown().optional(),
  }),
});
const event = z.union([init, step, result]);
type Reason =
  | 'admission'
  | 'identity'
  | 'start'
  | 'deadline'
  | 'cancelled'
  | 'invalid-output'
  | 'not-complete'
  | 'not-quiescent'
  | 'ownership'
  | 'authentication';
export class GoogleWriterError extends Error {
  readonly reason: Reason;
  readonly diagnostic: GoogleWriterDiagnostic | null;
  constructor(reason: Reason, diagnostic: GoogleWriterDiagnostic | null = null) {
    super(`Google writer refused: ${reason}.`);
    this.reason = reason;
    this.diagnostic = diagnostic;
  }
}

export type GoogleReplacement = z.infer<typeof replacement>;
type Expectation = {
  attemptId: string;
  directory: string;
  model: string;
  permissionMode: z.infer<typeof permissionMode>;
  path: string;
  baseHash: string;
};

const diagnosticFields = [
  'event',
  'conversation_id',
  'init',
  'cwd',
  'tools',
  'permission_mode',
  'model',
  'step_update',
  'step_index',
  'state',
  'step_type',
  'text_delta',
  'duration_seconds',
  'tool_name',
  'tool_info',
  'subagent_info',
  'input_tokens',
  'output_tokens',
  'thinking_tokens',
  'cache_read_tokens',
  'total_tokens',
  'result',
  'status',
  'num_turns',
  'usage',
  'structured_output',
  'attemptId',
  'path',
  'baseHash',
  'content',
] as const;
export type GoogleWriterDiagnostic = Readonly<{
  stage: 'before-init' | 'output' | 'complete';
  site: 'frame' | 'init' | 'step' | 'result' | 'replacement' | 'finish';
  cause: 'validation' | 'correlation' | 'invalid-json' | 'limit' | 'incomplete';
  event: 'none' | 'init' | 'step_update' | 'result' | 'other' | 'invalid-json';
  field: (typeof diagnosticFields)[number] | 'other' | null;
}>;

export class GoogleWriterOutput {
  private pending: number[] = [];
  private bytes = 0;
  private session: string | null = null;
  private terminal: z.infer<typeof result>['result'] | null = null;
  private invalid = false;
  private site: GoogleWriterDiagnostic['site'] = 'frame';
  private eventName: GoogleWriterDiagnostic['event'] = 'none';
  private failure: GoogleWriterDiagnostic | null = null;
  private readonly expected: Expectation;
  constructor(expected: Expectation) {
    this.expected = expected;
  }
  private fail(
    reason: Reason,
    cause: GoogleWriterDiagnostic['cause'],
    field: GoogleWriterDiagnostic['field'] = null,
  ): never {
    this.failure ??= Object.freeze({
      stage: this.terminal ? 'complete' : this.session ? 'output' : 'before-init',
      site: this.site,
      cause,
      event: this.eventName,
      field,
    });
    throw new GoogleWriterError(reason, this.failure);
  }
  push(chunk: Uint8Array) {
    if (this.invalid) this.fail('invalid-output', 'validation');
    let decoded: unknown;
    try {
      this.bytes += chunk.length;
      if (this.bytes > MAX_BYTES) this.fail('invalid-output', 'limit');
      for (const byte of chunk) {
        if (this.terminal) this.fail('invalid-output', 'correlation');
        if (byte !== 10) {
          if (this.pending.length >= MAX_LINE_BYTES) this.fail('invalid-output', 'limit');
          this.pending.push(byte);
          continue;
        }
        this.site = 'frame';
        this.eventName = 'invalid-json';
        try {
          decoded = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(this.pending)),
          );
        } catch {
          this.fail('invalid-output', 'invalid-json');
        }
        const label =
          decoded !== null && typeof decoded === 'object'
            ? (decoded as { event?: unknown }).event
            : undefined;
        this.eventName =
          label === 'init' || label === 'step_update' || label === 'result' ? label : 'other';
        this.site =
          label === 'init'
            ? 'init'
            : label === 'step_update'
              ? 'step'
              : label === 'result'
                ? 'result'
                : 'frame';
        const value = event.parse(decoded);
        this.pending = [];
        if (value.event === 'init') {
          if (
            this.session ||
            value.init.cwd !== this.expected.directory ||
            value.init.model !== this.expected.model ||
            value.init.permission_mode !== this.expected.permissionMode
          )
            this.fail('invalid-output', 'correlation');
          this.session = value.conversation_id;
        } else if (value.event === 'step_update') {
          if (!this.session || value.step_update.conversation_id !== this.session)
            this.fail('invalid-output', 'correlation', 'conversation_id');
        } else {
          if (!this.session || value.result.conversation_id !== this.session)
            this.fail('invalid-output', 'correlation', 'conversation_id');
          this.terminal = value.result;
        }
      }
    } catch (error) {
      this.invalid = true;
      if (error instanceof GoogleWriterError) throw error;
      const matched =
        this.eventName === 'init'
          ? init.safeParse(decoded)
          : this.eventName === 'step_update'
            ? step.safeParse(decoded)
            : this.eventName === 'result'
              ? result.safeParse(decoded)
              : null;
      const detail = matched?.success === false ? matched.error : error;
      const label = detail instanceof z.ZodError ? detail.issues[0]?.path.at(-1) : undefined;
      this.fail(
        'invalid-output',
        'validation',
        label === undefined ? null : (diagnosticFields.find((field) => field === label) ?? 'other'),
      );
    }
  }
  finish(): { replacement: GoogleReplacement; usage: z.infer<typeof usage> } {
    this.site = 'finish';
    if (this.invalid || this.pending.length) this.fail('invalid-output', 'incomplete');
    const value = this.terminal;
    if (
      value?.status !== 'SUCCESS' ||
      value.error ||
      value.num_turns !== 1 ||
      !value.structured_output
    )
      this.fail('not-complete', 'incomplete');
    this.site = 'replacement';
    const file = value.structured_output;
    if (
      file.attemptId !== this.expected.attemptId ||
      file.path !== this.expected.path ||
      file.baseHash !== this.expected.baseHash ||
      Buffer.byteLength(file.content) > 65_536
    )
      this.fail('invalid-output', 'correlation');
    return { replacement: file, usage: value.usage };
  }
  get diagnostic() {
    return this.failure;
  }
  get conversationId() {
    return this.session;
  }
}

const client = z.strictObject({
  executable: text(4096),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sha256: hash,
});
// Only the controller constructs this plan from dated qualification evidence.
// Parsing establishes its shape and bindings, not the authenticity of its evidence.
const admission = z.strictObject({
  clientExecutable: text(4096),
  clientVersion: text(32),
  clientSha256: hash,
  checkedAt: z.iso.datetime(),
  nativeTrust: z.literal('accepted'),
  permissions: permissionMode,
  billing: z.literal('subscription-only'),
  extraCredits: z.literal('disabled'),
  evidence: z.strictObject({
    nativePermissions: text(256),
    subscriptionBilling: text(256),
    paidCreditsDisabled: text(256),
  }),
  model: text(200),
  effort,
});
export type GoogleClientIdentity = z.infer<typeof client>;
export type GoogleWriterAdmission = z.infer<typeof admission>;

// This floor refuses known permission bugs. It does not qualify a later build.
export function googleVersionEligible(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    major === 1 &&
    Number.isSafeInteger(minor) &&
    Number.isSafeInteger(patch) &&
    (minor > 1 || (minor === 1 && patch >= 12))
  );
}

// A projected setting is one fact. Account type and billing still need separate evidence.
export function projectGoogleCreditSetting(value: unknown): 'disabled' | 'enabled' | 'unknown' {
  const parsed = z.object({ useG1Credits: z.boolean() }).safeParse(value);
  return parsed.success ? (parsed.data.useG1Credits ? 'enabled' : 'disabled') : 'unknown';
}

function ownedDirectory(value: string, root?: string, privateLeaf = false): string {
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error();
  const base = root ?? value;
  const tail = relative(base, value);
  if (tail.startsWith('..') || isAbsolute(tail) || (root && !tail)) throw new Error();
  let current = base;
  for (const part of ['', ...tail.split('/').filter(Boolean)]) {
    if (part) current = join(current, part);
    const info = lstatSync(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & (current === value && privateLeaf ? 0o077 : 0o022)) !== 0
    )
      throw new Error();
  }
  if (realpathSync(value) !== value) throw new Error();
  return value;
}

function executableHash(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(descriptor);
    const limit = 512 * 1024 * 1024;
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > limit ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0
    )
      throw new Error();
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(65_536);
    let bytes = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > info.size) throw new Error();
      digest.update(buffer.subarray(0, read));
    }
    if (bytes !== info.size) throw new Error();
    return digest.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

export type GoogleNativePhase = 'config' | 'task';
export type GoogleNativeLifecycle = {
  beforePhase: (phase: GoogleNativePhase) => void;
  owned: (phase: GoogleNativePhase, group: number) => void;
  quiescent: (phase: GoogleNativePhase, group: number) => void;
};
type NativeControls = {
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  deadline?: number;
  schedule?: Schedule;
  spawn?: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      detached: true;
      stdio: ['ignore', 'pipe', 'pipe'];
    },
  ) => ChildProcess;
  lifecycle?: GoogleNativeLifecycle;
};
type NativeLaunch = NativeControls & {
  client: GoogleClientIdentity;
  repositoryRoot: string;
  directory: string;
  temporaryDirectory: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onSpawn?: (group: number) => void;
};
type WriterOptions = NativeLaunch & {
  admission: GoogleWriterAdmission;
  attemptId: string;
  logFile: string;
  file: { path: string; baseHash: string; content: string };
  handoff?: z.input<typeof SealedHandoffPacketSchema>;
  task: string;
  onSpawn: (group: number) => void;
  onSubmitted?: () => void;
};
type NativeExit = {
  reason: Reason | null;
  quiescent: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};
const CLEANUP_MS = 1500;

function synchronousHook(work: () => unknown) {
  const result = work();
  if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
    void Promise.resolve(result).catch(() => {});
    throw new GoogleWriterError('ownership');
  }
}

function nativeClock(options: NativeLaunch, maximum: number) {
  const now = options.now ?? (() => performance.now());
  const began = now();
  if (
    !Number.isFinite(began) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > maximum ||
    (options.deadline !== undefined && !Number.isFinite(options.deadline))
  )
    throw new GoogleWriterError('deadline');
  const end = Math.min(began + options.timeoutMs, options.deadline ?? Infinity);
  let previous = began,
    invalid = false;
  const remaining = () => {
    const current = now();
    if (invalid || !Number.isFinite(current) || current < previous) {
      invalid = true;
      return 0;
    }
    previous = current;
    return Math.max(0, end - current);
  };
  const check = () => {
    if (remaining() <= CLEANUP_MS) throw new GoogleWriterError('deadline');
  };
  check();
  return { remaining, check };
}

function nativeLaunch(options: NativeLaunch, logFile: string) {
  let identity: GoogleClientIdentity;
  try {
    identity = client.parse(options.client);
    if (!googleVersionEligible(identity.version) || options.signal?.aborted) throw new Error();
  } catch {
    throw new GoogleWriterError('admission');
  }
  try {
    const root = ownedDirectory(options.repositoryRoot);
    const directory = ownedDirectory(options.directory, root, true);
    const temporary = ownedDirectory(options.temporaryDirectory, root, true);
    if (
      readdirSync(directory).length ||
      temporary === directory ||
      temporary.startsWith(`${directory}/`)
    )
      throw new Error();
    if (logFile === '/dev/null') {
      if (!lstatSync(logFile).isCharacterDevice()) throw new Error();
    } else {
      const logDirectory = ownedDirectory(dirname(logFile), root, true);
      if (
        logDirectory === directory ||
        logDirectory.startsWith(`${directory}/`) ||
        logFile !== `${logDirectory}/${logFile.split('/').at(-1)}`
      )
        throw new Error();
      try {
        lstatSync(logFile);
        throw new Error('existing-log');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const source = options.environment ?? process.env;
    if (
      process.platform === 'win32' ||
      !source.HOME ||
      source.HOME !== userInfo().homedir ||
      !isAbsolute(identity.executable) ||
      executableHash(identity.executable) !== identity.sha256
    )
      throw new Error();
    return {
      identity,
      directory,
      environment: {
        HOME: source.HOME,
        USER: userInfo().username,
        LOGNAME: userInfo().username,
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        TERM: 'dumb',
        NO_COLOR: '1',
        TMPDIR: temporary,
      },
    };
  } catch {
    throw new GoogleWriterError('identity');
  }
}

function ownedNativeCommand(
  options: NativeLaunch,
  launch: ReturnType<typeof nativeLaunch>,
  clock: ReturnType<typeof nativeClock>,
  phase: GoogleNativePhase,
  argv: (workMs: number) => string[],
  onStdout: (chunk: Buffer) => void,
  onSubmitted?: () => void,
) {
  const schedule =
    options.schedule ??
    ((work, delay) => {
      const timer = setTimeout(work, delay);
      return () => clearTimeout(timer);
    });
  const check = () => {
    clock.check();
    if (options.signal?.aborted) throw new GoogleWriterError('cancelled');
  };
  check();
  try {
    synchronousHook(() => options.lifecycle?.beforePhase(phase));
  } catch {
    throw new GoogleWriterError('ownership');
  }
  check();
  if (onSubmitted) {
    try {
      synchronousHook(onSubmitted);
    } catch {
      throw new GoogleWriterError('ownership');
    }
    check();
  }
  const args = argv(Math.floor(clock.remaining() - CLEANUP_MS));
  check();
  let child: ReturnType<typeof spawn>;
  try {
    child = (options.spawn ?? spawn)(launch.identity.executable, args, {
      cwd: launch.directory,
      env: launch.environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new GoogleWriterError('start');
  }
  const group = Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0 ? (child.pid ?? 0) : 0;
  let reason: Reason | null = group > 0 ? null : 'start',
    closed = false,
    finished = false,
    stopping = false;
  let exitCode: number | null = null,
    signal: NodeJS.Signals | null = null,
    bytes = 0,
    stderrBytes = 0,
    stderrTail = '';
  const timers: Array<() => void> = [];
  const complete = Promise.withResolvers<NativeExit>();
  const absent = () => group > 0 && groupAbsent(group);
  const send = (value: NodeJS.Signals) => {
    if (group > 0 && !absent())
      try {
        process.kill(-group, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reason ??= 'not-quiescent';
      }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const cancel of timers) cancel();
    options.signal?.removeEventListener('abort', abort);
    stderrTail = '';
    const quiescent = closed && absent();
    if (!quiescent) {
      reason = 'not-quiescent';
      send('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    if (quiescent)
      try {
        synchronousHook(() => options.lifecycle?.quiescent(phase, group));
      } catch {
        reason = 'ownership';
      }
    if (clock.remaining() <= 0) reason ??= 'deadline';
    if (exitCode !== 0) reason ??= 'not-complete';
    complete.resolve({ reason, quiescent, exitCode, signal });
  };
  const later = (work: () => void, delay: number) =>
    timers.push(schedule(work, Math.max(0, Math.min(delay, clock.remaining()))));
  const stop = (failure: Reason | null) => {
    reason ??= failure;
    if (stopping) return;
    stopping = true;
    if (closed && absent()) return finish();
    send('SIGTERM');
    later(() => send('SIGKILL'), 250);
    later(finish, Math.min(CLEANUP_MS, clock.remaining()));
  };
  const abort = () => stop('cancelled');
  child.stdout?.on('data', (chunk: Buffer) => {
    if (finished) return;
    bytes += chunk.length;
    if (bytes > MAX_BYTES) return stop('invalid-output');
    if (reason) return;
    try {
      onStdout(chunk);
    } catch {
      stop('invalid-output');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (finished) return;
    bytes += chunk.length;
    stderrBytes += chunk.length;
    if (bytes > MAX_BYTES || stderrBytes > 16384) return stop('invalid-output');
    const value = stderrTail + chunk.toString('utf8');
    stderrTail = value.slice(-64);
    if (
      /authentication required|not authenticated|not logged in|sign.in required|please (?:log|sign).in/i.test(
        value,
      )
    )
      stop('authentication');
  });
  child.once('error', () => stop('start'));
  child.once('exit', (code, value) => {
    exitCode = code;
    signal = value;
    later(() => {
      if (!closed || !absent()) stop('not-quiescent');
    }, 250);
  });
  child.once('close', (code, value) => {
    closed = true;
    exitCode = code;
    signal = value;
    if (absent()) finish();
    else stop('not-quiescent');
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  later(() => stop('deadline'), clock.remaining() - CLEANUP_MS);
  try {
    synchronousHook(() => options.lifecycle?.owned(phase, group));
  } catch {
    stop('ownership');
  }
  try {
    synchronousHook(() => options.onSpawn?.(group));
  } catch {
    stop('start');
  }
  if (options.signal?.aborted) abort();
  if (clock.remaining() <= CLEANUP_MS) stop('deadline');
  if (group <= 0 || !child.stdout || !child.stderr) stop('start');
  return { group, result: complete.promise, stop: () => stop('cancelled') };
}

export function googleWriterPlan(input: {
  attemptId: string;
  file: { path: string; baseHash: string; content: string };
  handoff?: z.input<typeof SealedHandoffPacketSchema>;
  task: string;
  model: string;
  effort: GoogleWriterAdmission['effort'];
}) {
  let file: ReturnType<typeof fileSchema.parse>, task: string;
  let handoff: z.output<typeof SealedHandoffPacketSchema> | undefined;
  try {
    file = fileSchema.parse(input.file);
    if (input.handoff !== undefined) {
      handoff = SealedHandoffPacketSchema.parse(input.handoff);
      if (Buffer.byteLength(JSON.stringify(handoff), 'utf8') > 65_536 || !verifyHandoff(handoff))
        throw new Error();
    }
    AttemptIdSchema.parse(input.attemptId);
    task = z
      .string()
      .min(1)
      .max(16384)
      .refine((value) => value.isWellFormed() && !value.includes('\0'))
      .parse(input.task);
    admission.shape.model.parse(input.model);
    effort.parse(input.effort);
    if (
      Buffer.byteLength(file.content) > 65536 ||
      createHash('sha256').update(file.content).digest('hex') !== file.baseHash
    )
      throw new Error();
  } catch {
    throw new GoogleWriterError('admission');
  }
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      attemptId: { const: input.attemptId },
      path: { const: file.path },
      baseHash: { const: file.baseHash },
      content: { type: 'string', maxLength: 65536 },
    },
    required: ['attemptId', 'path', 'baseHash', 'content'],
  };
  const prompt = `Return only the requested replacement object. Do not run tools or change files.\nTask: ${task}${handoff ? `\nHandoff: ${JSON.stringify(handoff)}` : ''}\nFile: ${JSON.stringify({ attemptId: input.attemptId, ...file })}`;
  return {
    prompt,
    schema,
    ...(handoff ? { handoff } : {}),
    attemptId: input.attemptId,
    file,
    task,
    model: input.model,
    effort: input.effort,
  };
}

export function startGoogleWriter(
  options: Omit<WriterOptions, 'onSpawn' | 'logFile'> & {
    onSpawn?: WriterOptions['onSpawn'];
    logFile?: string;
    onSubmitted: () => void;
  },
) {
  const clock = nativeClock(options, 300000);
  let allowed: GoogleWriterAdmission;
  try {
    if (typeof options.onSubmitted !== 'function') throw new Error();
    allowed = admission.parse(options.admission);
    if (
      allowed.clientExecutable !== options.client.executable ||
      allowed.clientVersion !== options.client.version ||
      allowed.clientSha256 !== options.client.sha256
    )
      throw new Error();
  } catch {
    throw new GoogleWriterError('admission');
  }
  const plan = googleWriterPlan({
    attemptId: options.attemptId,
    file: options.file,
    ...(options.handoff !== undefined ? { handoff: options.handoff } : {}),
    task: options.task,
    model: allowed.model,
    effort: allowed.effort,
  });
  const logFile = options.logFile ?? '/dev/null';
  const launch = nativeLaunch(options, logFile);
  const reader = new GoogleWriterOutput({
    attemptId: options.attemptId,
    permissionMode: allowed.permissions,
    directory: launch.directory,
    model: allowed.model,
    path: options.file.path,
    baseHash: options.file.baseHash,
  });
  const handle = ownedNativeCommand(
    options,
    launch,
    clock,
    'task',
    (workMs) => [
      '--print',
      plan.prompt,
      '--output-format',
      'stream-json',
      '--json-schema',
      JSON.stringify(plan.schema),
      '--model',
      allowed.model,
      '--effort',
      allowed.effort,
      '--disable-slash-commands',
      '--sandbox',
      '--print-timeout',
      `${workMs}ms`,
      '--log-file',
      logFile,
    ],
    (chunk) => reader.push(chunk),
    options.onSubmitted,
  );
  const result = handle.result.then((outcome) => {
    let metadata: (ReturnType<GoogleWriterOutput['finish']> & { conversationId: string }) | null =
      null;
    let reason = outcome.reason;
    if (!reason && outcome.quiescent)
      try {
        const value = reader.finish();
        if (!reader.conversationId) throw new GoogleWriterError('not-complete');
        metadata = { ...value, conversationId: reader.conversationId };
      } catch (error) {
        reason = error instanceof GoogleWriterError ? error.reason : 'invalid-output';
      }
    if (clock.remaining() <= 0) {
      reason ??= 'deadline';
      metadata = null;
    }
    return {
      ...outcome,
      reason,
      metadata: reason ? null : metadata,
      diagnostic: reader.diagnostic,
    };
  });
  return { ...handle, result };
}

/** Preserve the standalone replacement facade for existing callers. */
export async function runGoogleWriter(
  options: WriterOptions,
): Promise<ReturnType<GoogleWriterOutput['finish']>> {
  const handle = startGoogleWriter({ ...options, onSubmitted: options.onSubmitted ?? (() => {}) });
  const outcome = await handle.result;
  if (outcome.reason || !outcome.quiescent || !outcome.metadata)
    throw new GoogleWriterError(outcome.reason ?? 'not-quiescent', outcome.diagnostic);
  return { replacement: outcome.metadata.replacement, usage: outcome.metadata.usage };
}

const configOutput = z.object({
  status: z.literal('SUCCESS'),
  num_turns: z.literal(0),
  error: z.never().optional(),
  usage: z.object({
    input_tokens: z.literal(0),
    output_tokens: z.literal(0),
    thinking_tokens: z.literal(0),
    cache_read_tokens: z.literal(0),
    total_tokens: z.literal(0),
  }),
  command: z.object({
    data: z.object({
      config: z.object({
        toolPermission: permissionMode,
        useG1Credits: z.literal(false),
        artifactReviewPolicy: z.unknown().optional(),
        allowNonWorkspaceAccess: z.unknown().optional(),
        enableTerminalSandbox: z.unknown().optional(),
      }),
    }),
  }),
});
export function projectGoogleConfig(stdout: Uint8Array) {
  if (stdout.byteLength > 262144) throw new GoogleWriterError('invalid-output');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(stdout));
  } catch {
    throw new GoogleWriterError('invalid-output');
  }
  const parsed = configOutput.safeParse(value);
  if (!parsed.success) throw new GoogleWriterError('admission');
  const config = parsed.data.command.data.config;
  const artifact = z
    .enum(['asks-for-review', 'agent-decides', 'always-proceed'])
    .safeParse(config.artifactReviewPolicy);
  return {
    permissionMode: config.toolPermission,
    creditFallback: 'disabled' as const,
    artifactReviewPolicy: artifact.success ? artifact.data : null,
    allowNonWorkspaceAccess:
      typeof config.allowNonWorkspaceAccess === 'boolean' ? config.allowNonWorkspaceAccess : null,
    enableTerminalSandbox:
      typeof config.enableTerminalSandbox === 'boolean' ? config.enableTerminalSandbox : null,
    account: 'unknown' as const,
    billing: 'unknown' as const,
    observedTurns: 0 as const,
  };
}

// One zero-turn slash command, one owned process, one bounded projection.
// /config and /usage share this path; both report num_turns 0 and no model request.
function startGoogleMetadata<T>(
  options: NativeLaunch,
  command: '/config' | '/usage',
  project: (stdout: Uint8Array) => T,
) {
  const clock = nativeClock(options, 20000);
  const launch = nativeLaunch(options, '/dev/null');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const handle = ownedNativeCommand(
    options,
    launch,
    clock,
    'config',
    (workMs) => [
      '-p',
      command,
      '--output-format',
      'json',
      '--print-timeout',
      `${workMs}ms`,
      '--log-file',
      '/dev/null',
    ],
    (chunk) => {
      bytes += chunk.length;
      if (bytes > 262144) throw new GoogleWriterError('invalid-output');
      chunks.push(chunk);
    },
  );
  const result = handle.result.then((outcome) => {
    let metadata: T | null = null,
      reason = outcome.reason;
    if (!reason && outcome.quiescent)
      try {
        metadata = project(Buffer.concat(chunks));
      } catch (error) {
        reason = error instanceof GoogleWriterError ? error.reason : 'invalid-output';
      }
    chunks.length = 0;
    if (clock.remaining() <= 0) {
      reason ??= 'deadline';
      metadata = null;
    }
    return { ...outcome, reason, metadata: reason ? null : metadata };
  });
  return { ...handle, result };
}

export function startGoogleConfig(options: NativeLaunch) {
  return startGoogleMetadata(options, '/config', projectGoogleConfig);
}

// The /usage command reports account buckets, one per quota window, with zero model turns.
// A bucket is an account fact, so the caller attaches it to every Google route it names.
const usageBucket = z.looseObject({
  id: text(64),
  remaining_fraction: z.number().finite().min(0).max(1),
  reset_time: z.iso.datetime({ offset: true }),
});
const usageOutput = z.looseObject({
  status: z.literal('SUCCESS'),
  num_turns: z.literal(0),
  usage: z
    .record(z.string().max(64), z.literal(0))
    .refine((counters) => Object.keys(counters).length <= 32)
    .optional(),
  command: z.looseObject({
    data: z.looseObject({
      groups: z.array(z.looseObject({ buckets: z.array(usageBucket).max(32) })).max(32),
    }),
  }),
});
export type GoogleUsageBucket = Readonly<{
  windowId: string;
  kind: 'weekly' | 'rolling' | 'model';
  remainingPercent: number;
  resetsAt: string;
}>;

function usageWindowKind(id: string): GoogleUsageBucket['kind'] {
  if (/-weekly$/.test(id)) return 'weekly';
  if (/-\d+h$/.test(id)) return 'rolling';
  return 'model';
}

export function projectGoogleUsage(stdout: Uint8Array): GoogleUsageBucket[] {
  if (stdout.byteLength > 262144) throw new GoogleWriterError('invalid-output');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(stdout));
  } catch {
    throw new GoogleWriterError('invalid-output');
  }
  const parsed = usageOutput.safeParse(value);
  if (!parsed.success) throw new GoogleWriterError('invalid-output');
  const buckets = new Map<string, GoogleUsageBucket>();
  const fractions = new Map<string, number>();
  for (const group of parsed.data.command.data.groups)
    for (const bucket of group.buckets) {
      const next: GoogleUsageBucket = {
        windowId: bucket.id,
        kind: usageWindowKind(bucket.id),
        remainingPercent: bucket.remaining_fraction * 100,
        resetsAt: new Date(bucket.reset_time).toISOString(),
      };
      const previous = buckets.get(bucket.id);
      // The same bucket can appear under several model groups. Its values must agree.
      if (
        previous &&
        (fractions.get(bucket.id) !== bucket.remaining_fraction ||
          previous.resetsAt !== next.resetsAt)
      )
        throw new GoogleWriterError('invalid-output');
      fractions.set(bucket.id, bucket.remaining_fraction);
      buckets.set(bucket.id, next);
    }
  if (buckets.size === 0) throw new GoogleWriterError('invalid-output');
  return [...buckets.values()];
}

export function googleUsageObservations(
  buckets: readonly GoogleUsageBucket[],
  routeIds: readonly string[],
  observedAt: string,
): Observation[] {
  return routeIds.flatMap((routeId) =>
    buckets.map((bucket) => ({
      routeId,
      windowId: bucket.windowId,
      kind: bucket.kind,
      remaining: { value: bucket.remainingPercent, unit: 'percent' as const },
      resetsAt: bucket.resetsAt,
      observedAt,
      source: 'client' as const,
      confidence: 'reported' as const,
    })),
  );
}

export function startGoogleUsage(options: NativeLaunch) {
  return startGoogleMetadata(options, '/usage', projectGoogleUsage);
}
