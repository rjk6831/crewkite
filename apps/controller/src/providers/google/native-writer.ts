import { spawn } from 'node:child_process';
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
import { AttemptIdSchema } from '@crewkite/contracts';
import { z } from 'zod';
import { groupAbsent } from '../../host/worker.ts';

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
const path = text(512).refine(
  (value) =>
    !isAbsolute(value) &&
    !value.includes('\\') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
);
const fileSchema = z.strictObject({
  path,
  baseHash: hash,
  content: z
    .string()
    .max(65_536)
    .refine((value) => value.isWellFormed()),
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
    permission_mode: z.enum(['request-review', 'strict']),
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
    state: z.enum(['ACTIVE', 'DONE']),
    step_type: z.enum(['user_input', 'agent_response', 'tool', 'checkpoint']).optional(),
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
  | 'not-quiescent';
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
  permissionMode: 'request-review' | 'strict';
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
  permissions: z.enum(['request-review', 'strict']),
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

export async function runGoogleWriter(options: {
  client: GoogleClientIdentity;
  admission: GoogleWriterAdmission;
  attemptId: string;
  repositoryRoot: string;
  directory: string;
  logFile: string;
  temporaryDirectory: string;
  file: { path: string; baseHash: string; content: string };
  task: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onSpawn: (group: number) => void;
}): Promise<ReturnType<GoogleWriterOutput['finish']>> {
  const started = performance.now();
  let identity: GoogleClientIdentity;
  let allowed: GoogleWriterAdmission;
  try {
    identity = client.parse(options.client);
    allowed = admission.parse(options.admission);
    fileSchema.parse(options.file);
    AttemptIdSchema.parse(options.attemptId);
    z.string()
      .min(1)
      .max(16_384)
      .refine((value) => !value.includes(String.fromCharCode(0)))
      .parse(options.task);
    if (Buffer.byteLength(options.file.content) > 65_536) throw new Error();
    if (
      !googleVersionEligible(identity.version) ||
      allowed.clientExecutable !== identity.executable ||
      allowed.clientVersion !== identity.version ||
      allowed.clientSha256 !== identity.sha256 ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 300_000 ||
      options.signal?.aborted
    )
      throw new Error();
  } catch {
    throw new GoogleWriterError('admission');
  }
  let directory: string;
  let temporaryDirectory: string;
  try {
    const root = ownedDirectory(options.repositoryRoot);
    directory = ownedDirectory(options.directory, root, true);
    temporaryDirectory = ownedDirectory(options.temporaryDirectory, root, true);
    const logDirectory = ownedDirectory(dirname(options.logFile), root, true);
    if (readdirSync(directory).length !== 0) throw new Error();
    try {
      lstatSync(options.logFile);
      throw new Error('existing-log');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      !directory.startsWith(`${root}/`) ||
      !temporaryDirectory.startsWith(`${root}/`) ||
      temporaryDirectory.startsWith(`${directory}/`) ||
      temporaryDirectory === directory ||
      !logDirectory.startsWith(`${root}/`) ||
      logDirectory.startsWith(`${directory}/`) ||
      logDirectory === directory ||
      options.logFile !== `${logDirectory}/${options.logFile.split('/').at(-1)}`
    )
      throw new Error();
    if (
      !isAbsolute(identity.executable) ||
      executableHash(identity.executable) !== identity.sha256 ||
      createHash('sha256').update(options.file.content).digest('hex') !== options.file.baseHash ||
      process.platform === 'win32' ||
      !process.env.HOME
    )
      throw new Error();
  } catch {
    throw new GoogleWriterError('identity');
  }
  const workMs = Math.floor(options.timeoutMs - (performance.now() - started) - 1500);
  if (workMs < 1) throw new GoogleWriterError('deadline');
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      attemptId: { const: options.attemptId },
      path: { const: options.file.path },
      baseHash: { const: options.file.baseHash },
      content: { type: 'string', maxLength: 65_536 },
    },
    required: ['attemptId', 'path', 'baseHash', 'content'],
  };
  const prompt = `Return only the requested replacement object. Do not run tools or change files.\nTask: ${options.task}\nFile: ${JSON.stringify({ attemptId: options.attemptId, ...options.file })}`;
  const reader = new GoogleWriterOutput({
    attemptId: options.attemptId,
    permissionMode: allowed.permissions,
    directory,
    model: allowed.model,
    path: options.file.path,
    baseHash: options.file.baseHash,
  });
  const child = spawn(
    identity.executable,
    [
      '--print',
      prompt,
      '--output-format',
      'stream-json',
      '--json-schema',
      JSON.stringify(schema),
      '--model',
      allowed.model,
      '--effort',
      allowed.effort,
      '--disable-slash-commands',
      '--sandbox',
      '--print-timeout',
      `${workMs}ms`,
      '--log-file',
      options.logFile,
    ],
    {
      cwd: directory,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: process.env.HOME,
        USER: userInfo().username,
        LOGNAME: userInfo().username,
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        TERM: 'dumb',
        NO_COLOR: '1',
        TMPDIR: temporaryDirectory,
      },
    },
  );
  const group = child.pid ?? 0;
  let failure: Reason | null = null;
  let bytes = 0;
  let closed = false;
  let exitCode: number | null = null;
  const kill = (signal: NodeJS.Signals) => {
    if (!Number.isSafeInteger(group) || group <= 0) return;
    try {
      process.kill(-group, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= 'not-quiescent';
    }
  };
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: Reason) => {
    failure ??= reason;
    kill('SIGTERM');
    force ??= setTimeout(() => kill('SIGKILL'), 250);
  };
  const cancel = () => stop('cancelled');
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => stop('deadline'), workMs);
  let exitGrace: ReturnType<typeof setTimeout> | undefined;
  child.once('exit', () => {
    exitGrace = setTimeout(() => {
      if (!closed || !groupAbsent(group)) stop('not-quiescent');
    }, 250);
  });
  const completion = new Promise<void>((resolve) => {
    child.once('close', (code) => {
      closed = true;
      exitCode = code;
      resolve();
    });
    child.once('error', () => {
      failure ??= 'start';
    });
  });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) return stop('invalid-output');
    try {
      reader.push(chunk);
    } catch {
      stop('invalid-output');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) stop('invalid-output');
  });
  try {
    try {
      if (group > 0) options.onSpawn(group);
      else stop('start');
    } catch {
      stop('start');
    }
    await Promise.race([
      completion,
      new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          Math.max(1, options.timeoutMs - (performance.now() - started)),
        );
        timer.unref();
        completion.then(() => clearTimeout(timer));
      }),
    ]);
    if (!closed || !groupAbsent(group)) {
      kill('SIGKILL');
      throw new GoogleWriterError('not-quiescent', reader.diagnostic);
    }
    if (failure) throw new GoogleWriterError(failure, reader.diagnostic);
    if (exitCode !== 0) throw new GoogleWriterError('not-complete', reader.diagnostic);
    return reader.finish();
  } finally {
    clearTimeout(timer);
    if (force) clearTimeout(force);
    if (exitGrace) clearTimeout(exitGrace);
    options.signal?.removeEventListener('abort', cancel);
    if (!closed || !groupAbsent(group)) kill('SIGKILL');
  }
}
