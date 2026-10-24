import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { groupAbsent, type Schedule } from '../../../host/worker.ts';
import {
  type AcpClientIdentity,
  validateAcpClientIdentity,
  validateAcpDirectory,
} from './profile.ts';

const stderrSignalKinds = [
  'authentication',
  'quota',
  'rate-limit',
  'resource-exhausted',
  'network',
  'backoff',
  'permission',
  'model',
  'uncaught',
  'proxy-connect',
  'proxy-unexpected',
] as const;
const stderrStatusCodes = [400, 401, 403, 404, 408, 413, 429, 500, 502, 503, 504] as const;
const stderrCount = z.number().int().min(0).max(1024);
export const AcpStderrSummarySchema = z.strictObject({
  lines: stderrCount,
  unclassifiedLines: stderrCount,
  oversizedLines: stderrCount,
  signals: z
    .array(z.strictObject({ kind: z.enum(stderrSignalKinds), count: stderrCount.min(1) }))
    .max(stderrSignalKinds.length)
    .refine((values) => new Set(values.map((value) => value.kind)).size === values.length),
  httpStatuses: z
    .array(
      z.strictObject({
        code: z.union(stderrStatusCodes.map((code) => z.literal(code))),
        count: stderrCount.min(1),
      }),
    )
    .max(stderrStatusCodes.length)
    .refine((values) => new Set(values.map((value) => value.code)).size === values.length),
});
export type AcpStderrSummary = z.infer<typeof AcpStderrSummarySchema>;
const stderrPatterns: Record<(typeof stderrSignalKinds)[number], RegExp> = {
  authentication: /\b(?:UNAUTHENTICATED|invalid_grant|invalid_token|authentication failed)\b/i,
  quota: /\b(?:quota_exceeded|insufficient_quota|quota exceeded)\b/i,
  'resource-exhausted': /\b(?:RESOURCE_EXHAUSTED|ResourceExhausted)\b/,
  'rate-limit': /\b(?:rate_limit_exceeded|rate limit exceeded|too many requests)\b/i,
  network:
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|certificate verify failed)\b|\brpc error: code = (?:Unavailable|DeadlineExceeded)\b/i,
  backoff: /\b(?:retrying (?:in|after) |backoff(?: delay)?[ :=]+)[0-9]+(?:ms|s| seconds?)?\b/i,
  permission: /\b(?:PERMISSION_DENIED|permission denied)\b/i,
  model: /\b(?:MODEL_NOT_FOUND|unsupported model|model not found)\b/i,
  uncaught: /^(?:Traceback \(most recent call last\):|panic:|fatal error:)/,
  'proxy-connect': /\bProxy failed to connect to CCPA API:/,
  'proxy-unexpected': /\bProxy unexpected connection error\b/,
};

// Only fixed signatures survive. An oversized line is discarded in full.
export class AcpStderrClassifier {
  private pending = Buffer.alloc(0);
  private oversized = false;
  private lines = 0;
  private unclassifiedLines = 0;
  private oversizedLines = 0;
  private readonly signals = new Map<(typeof stderrSignalKinds)[number], number>();
  private readonly statuses = new Map<(typeof stderrStatusCodes)[number], number>();
  private line() {
    this.lines = Math.min(1024, this.lines + 1);
    if (this.oversized) this.oversizedLines = Math.min(1024, this.oversizedLines + 1);
    else {
      const text = this.pending.toString('latin1');
      let matched = false;
      for (const kind of stderrSignalKinds)
        if (stderrPatterns[kind].test(text)) {
          this.signals.set(kind, Math.min(1024, (this.signals.get(kind) ?? 0) + 1));
          matched = true;
        }
      const status =
        /\bHTTP(?:\/[12](?:\.[0-9])?)?(?:[ "']+(?:status|error|response))?[ "':=]+(400|401|403|404|408|413|429|500|502|503|504)\b/i.exec(
          text,
        );
      if (status) {
        const code = Number(status[1]) as (typeof stderrStatusCodes)[number];
        this.statuses.set(code, Math.min(1024, (this.statuses.get(code) ?? 0) + 1));
        matched = true;
      }
      if (!matched) this.unclassifiedLines = Math.min(1024, this.unclassifiedLines + 1);
    }
    this.pending = Buffer.alloc(0);
    this.oversized = false;
  }
  push(bytes: Buffer) {
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start);
      const stop = end < 0 ? bytes.length : end;
      if (!this.oversized) {
        if (this.pending.length + stop - start > 8192) {
          this.pending = Buffer.alloc(0);
          this.oversized = true;
        } else this.pending = Buffer.concat([this.pending, bytes.subarray(start, stop)]);
      }
      if (end < 0) break;
      this.line();
      start = end + 1;
    }
  }
  finish(): AcpStderrSummary {
    if (this.pending.length || this.oversized) this.line();
    return AcpStderrSummarySchema.parse({
      lines: this.lines,
      unclassifiedLines: this.unclassifiedLines,
      oversizedLines: this.oversizedLines,
      signals: stderrSignalKinds.flatMap((kind) =>
        this.signals.has(kind) ? [{ kind, count: this.signals.get(kind) }] : [],
      ),
      httpStatuses: stderrStatusCodes.flatMap((code) =>
        this.statuses.has(code) ? [{ code, count: this.statuses.get(code) }] : [],
      ),
    });
  }
}

export type AcpReason =
  | 'identity'
  | 'launch'
  | 'protocol'
  | 'output-limit'
  | 'authentication'
  | 'configuration'
  | 'permission'
  | 'stopped'
  | 'deadline'
  | 'ownership';
export const AcpDiagnosticSchema = z.strictObject({
  site: z.enum([
    'utf8',
    'json',
    'json-bound',
    'envelope',
    'correlation',
    'rpc-error',
    'rpc-result',
    'notification',
    'request',
    'write',
    'eof-pending',
    'stdout-stream',
    'stderr-stream',
    'stderr-output',
    'stdin-stream',
    'launch',
    'work',
    'exit',
    'stop',
    'deadline',
    'ownership',
    'notification-after-terminal',
    'notification-session',
    'notification-update',
    'configuration-update',
    'tool-update',
    'tool-duplicate',
    'permission-drift',
    'message-content',
    'edit-location',
    'activity-sink',
    'request-method',
    'permission-request',
    'permission-options',
    'permission-action',
    'permission-binding',
    'prompt-result',
    'prompt-terminal-state',
    'incomplete-tool-terminal',
    'session-close',
  ]),
  method: z
    .enum([
      'initialize',
      'authenticate',
      'session/new',
      'session/set_config_option',
      'session/prompt',
      'session/cancel',
      'session/close',
      'session/update',
      'session/request_permission',
      'other',
    ])
    .optional(),
  sessionUpdate: z
    .enum([
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'user_message_chunk',
      'agent_thought_chunk',
      'config_option_update',
      'current_mode_update',
      'usage_update',
      'available_commands_update',
      'session_info_update',
      'other',
    ])
    .optional(),
  rpcCode: z.number().int().safe().optional(),
  pendingToolCount: z.number().int().min(0).max(256).optional(),
  permissionStage: z
    .enum([
      'mapping-tool-shape',
      'native-arguments',
      'scoped-path-location',
      'displayed-diff',
      'target-snapshot',
      'unique-hunk-range',
      'complete-action',
      'resulting-target',
    ])
    .optional(),
  permissionActionBytes: z.number().int().min(0).max(1048576).optional(),
  permissionSchema: z
    .strictObject({
      issueCount: z.number().int().min(1).max(1024),
      issues: z
        .array(
          z.strictObject({
            code: z.enum([
              'invalid_type',
              'too_big',
              'too_small',
              'invalid_format',
              'not_multiple_of',
              'unrecognized_keys',
              'invalid_union',
              'invalid_key',
              'invalid_element',
              'invalid_value',
              'custom',
              'other',
            ]),
            field: z.enum([
              'root',
              'sessionId',
              'toolCall',
              'toolCall.sessionUpdate',
              'toolCall.toolCallId',
              'toolCall.name',
              'toolCall.title',
              'toolCall.kind',
              'toolCall.status',
              'toolCall.rawInput',
              'toolCall.rawOutput',
              'toolCall._meta',
              'toolCall.content',
              'toolCall.locations',
              'toolCall.locations.path',
              'toolCall.locations.line',
              'options',
              'options.optionId',
              'options.name',
              'options.kind',
              'other',
            ]),
            type: z.enum([
              'undefined',
              'null',
              'array',
              'object',
              'string',
              'number',
              'boolean',
              'other',
            ]),
            size: z.number().int().min(0).max(1048576).optional(),
          }),
        )
        .min(1)
        .max(16),
      unknownKeyCount: z.number().int().min(0).max(1024),
      unknownKeyHashes: z
        .array(z.string().regex(/^[0-9a-f]{64}$/))
        .max(16)
        .refine((hashes) => new Set(hashes).size === hashes.length),
    })
    .optional(),
  // Keep only digests of machine identifiers. Provider text and argument values stay out.
  toolIdentityHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  rawInputKeyHashes: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .max(32)
    .refine((hashes) => new Set(hashes).size === hashes.length)
    .optional(),
  // A refused edit keeps the names of the arguments it carried, never their values.
  editArguments: z
    .array(
      z.enum([
        'TargetFile',
        'TargetContent',
        'ReplacementContent',
        'AllowMultiple',
        'StartLine',
        'EndLine',
        'other',
      ]),
    )
    .max(7)
    .refine((names) => new Set(names).size === names.length)
    .optional(),
});
export type AcpDiagnostic = z.infer<typeof AcpDiagnosticSchema>;
export function acpMethod(method: string): NonNullable<AcpDiagnostic['method']> {
  return AcpDiagnosticSchema.shape.method.unwrap().safeParse(method).data ?? 'other';
}
export function acpSessionUpdate(update: unknown): NonNullable<AcpDiagnostic['sessionUpdate']> {
  const kind =
    update && typeof update === 'object'
      ? (update as { sessionUpdate?: unknown }).sessionUpdate
      : undefined;
  return AcpDiagnosticSchema.shape.sessionUpdate.unwrap().safeParse(kind).data ?? 'other';
}
export function acpErrorAt(error: unknown, diagnostic: AcpDiagnostic): AcpError {
  return new AcpError(
    error instanceof AcpError ? error.reason : 'protocol',
    error instanceof AcpError && error.diagnostic ? error.diagnostic : diagnostic,
  );
}
export function acpValidate<T>(diagnostic: AcpDiagnostic, work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw acpErrorAt(error, diagnostic);
  }
}
export class AcpError extends Error {
  readonly reason: AcpReason;
  readonly diagnostic: AcpDiagnostic | null;
  constructor(reason: AcpReason, diagnostic: AcpDiagnostic | null = null) {
    super(`Google ACP refused: ${reason}.`);
    this.reason = reason;
    this.diagnostic = diagnostic ? AcpDiagnosticSchema.parse(diagnostic) : null;
  }
}
export const acpIdentifier = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v.isWellFormed() && !/\p{C}/u.test(v));
const rpcId = z.union([acpIdentifier, z.number().int().safe()]);
type RpcId = z.infer<typeof rpcId>;
const object = z.record(z.string(), z.unknown());
const envelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: rpcId.optional(),
  method: z.string().min(1).max(128).optional(),
  params: object.optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string().max(16384),
      data: z.unknown().optional(),
    })
    .optional(),
});
export type AcpLifecycle = {
  beforePhase(): void;
  owned(group: number): void;
  quiescent(group: number): void;
};
export type AcpProcessOutcome<T> = {
  metadata: T | null;
  reason: AcpReason | null;
  quiescent: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutBytes: number;
  stderrBytes: number;
  stderrSummary: AcpStderrSummary;
  diagnostic: AcpDiagnostic | null;
};
export type AcpSpawn = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: true;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcessWithoutNullStreams;
export type AcpProcessOptions = {
  client: AcpClientIdentity;
  directory: string;
  environment: NodeJS.ProcessEnv;
  lifecycle: AcpLifecycle;
  timeoutMs: number;
  now?: () => number;
  schedule?: Schedule;
  spawn?: AcpSpawn;
  /** A chat turn streams far more than a bounded writer. Callers raise these on purpose. */
  limits?: Partial<AcpLimits>;
};

export type AcpLimits = {
  maxTimeoutMs: number;
  stdoutBytes: number;
  frames: number;
  requests: number;
};
export const writerAcpLimits: AcpLimits = {
  maxTimeoutMs: 600000,
  stdoutBytes: 4194304,
  frames: 4096,
  requests: 128,
};
export const chatAcpLimits: AcpLimits = {
  maxTimeoutMs: 7200000,
  stdoutBytes: 134217728,
  frames: 262144,
  requests: 4096,
};

const stderrLimit = 1048576;

function boundedJson(value: unknown) {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || ++count > 8192 || item.depth > 24) throw new AcpError('output-limit');
    if (typeof item.value === 'string' && !item.value.isWellFormed())
      throw new AcpError('protocol');
    if (item.value && typeof item.value === 'object') {
      for (const [key, child] of Object.entries(item.value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new AcpError('protocol');
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
}

/** Request correlation stays private; callers receive only normalized protocol facts. */
export class AcpConnection {
  private pending = Buffer.alloc(0);
  private requests = new Map<
    RpcId,
    {
      resolve(value: unknown): void;
      reject(error: unknown): void;
      accept?: (value: unknown) => void;
      method: NonNullable<AcpDiagnostic['method']>;
    }
  >();
  private seen = new Set<RpcId>();
  private incoming = new Set<RpcId>();
  private nextId = 0;
  private sent = 0;
  private received = 0;
  private frames = 0;
  private failure: AcpError | null = null;
  private firstDiagnostic: AcpDiagnostic | null = null;
  get diagnostic() {
    return this.firstDiagnostic;
  }
  noteDiagnostic(diagnostic: AcpDiagnostic | null) {
    if (diagnostic && !this.firstDiagnostic)
      this.firstDiagnostic = AcpDiagnosticSchema.parse(diagnostic);
  }
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {
    throw new AcpError('protocol');
  };
  onRequest: (id: RpcId, method: string, params: Record<string, unknown>) => void = () => {
    throw new AcpError('protocol');
  };
  readonly output: Writable;
  private readonly failOwner: (error: AcpError) => void;
  private readonly checkActive: () => void;
  private readonly limits: AcpLimits;
  constructor(
    output: Writable,
    fail: (error: AcpError) => void,
    checkActive: () => void = () => {},
    limits: AcpLimits = writerAcpLimits,
  ) {
    this.output = output;
    this.failOwner = fail;
    this.checkActive = checkActive;
    this.limits = limits;
  }
  assertActive() {
    this.checkActive();
  }
  get stdoutBytes() {
    return this.received;
  }
  get failed() {
    return this.failure !== null;
  }
  private write(value: unknown) {
    if (this.failure || this.output.destroyed || !this.output.writable)
      throw this.failure ?? new AcpError('protocol', { site: 'write' });
    const line = `${JSON.stringify(value)}\n`;
    this.sent += Buffer.byteLength(line);
    if (Buffer.byteLength(line) > 1048576 || this.sent > this.limits.stdoutBytes)
      throw new AcpError('output-limit');
    this.output.write(line);
  }
  request(method: string, params: object, accept?: (value: unknown) => void): Promise<unknown> {
    if (this.requests.size >= 32 || this.nextId >= this.limits.requests)
      return Promise.reject(new AcpError('output-limit'));
    const id = ++this.nextId;
    const result = Promise.withResolvers<unknown>();
    this.requests.set(id, { ...result, accept, method: acpMethod(method) });
    try {
      this.write({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      this.requests.delete(id);
      result.reject(error);
    }
    return result.promise;
  }
  notify(method: string, params: object) {
    this.write({ jsonrpc: '2.0', method, params });
  }
  respond(id: RpcId, result: object) {
    if (!this.incoming.delete(id)) throw new AcpError('protocol', { site: 'correlation' });
    this.write({ jsonrpc: '2.0', id, result });
  }
  fail(error: AcpError) {
    if (this.failure) return;
    this.failure = error;
    this.noteDiagnostic(error.diagnostic);
    for (const pending of this.requests.values()) pending.reject(error);
    this.requests.clear();
    this.failOwner(error);
  }
  end() {
    if (this.pending.length || this.requests.size || this.incoming.size)
      this.fail(new AcpError('protocol', { site: 'eof-pending' }));
  }
  push(chunk: Uint8Array) {
    if (this.failure) return;
    let diagnostic: AcpDiagnostic = { site: 'json-bound' };
    try {
      this.received += chunk.byteLength;
      if (this.received > this.limits.stdoutBytes) throw new AcpError('output-limit');
      this.pending = Buffer.concat([this.pending, chunk]);
      for (;;) {
        diagnostic = { site: 'json-bound' };
        const end = this.pending.indexOf(10);
        if (end < 0) break;
        if (end > 1048576 || ++this.frames > this.limits.frames) throw new AcpError('output-limit');
        const bytes = this.pending.subarray(0, end);
        this.pending = this.pending.subarray(end + 1);
        diagnostic = { site: 'utf8' };
        const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        diagnostic = { site: 'json' };
        const raw: unknown = JSON.parse(line);
        diagnostic = { site: 'json-bound' };
        boundedJson(raw);
        diagnostic = { site: 'envelope' };
        const value = envelope.parse(raw);
        diagnostic = { site: 'correlation' };
        const hasResult = Object.hasOwn(raw as object, 'result');
        if (value.method !== undefined) {
          if (hasResult || value.error) throw new AcpError('protocol');
          if (value.id === undefined) {
            diagnostic = {
              site: 'notification',
              method: acpMethod(value.method),
              ...(value.method === 'session/update'
                ? { sessionUpdate: acpSessionUpdate(value.params?.update) }
                : {}),
            };
            this.onNotification(value.method, value.params ?? {});
          } else {
            if (this.seen.has(value.id) || this.seen.size >= 128 || this.incoming.size >= 16)
              throw new AcpError('protocol');
            this.seen.add(value.id);
            this.incoming.add(value.id);
            diagnostic = { site: 'request', method: acpMethod(value.method) };
            this.onRequest(value.id, value.method, value.params ?? {});
          }
        } else {
          if (value.id === undefined || hasResult === !!value.error || value.params)
            throw new AcpError('protocol');
          const pending = this.requests.get(value.id);
          if (!pending) throw new AcpError('protocol');
          this.requests.delete(value.id);
          if (value.error) {
            const error = new AcpError(
              value.error.code === -32000 ? 'authentication' : 'protocol',
              {
                site: 'rpc-error',
                method: pending.method,
                ...(Number.isSafeInteger(value.error.code) ? { rpcCode: value.error.code } : {}),
              },
            );
            this.noteDiagnostic(error.diagnostic);
            pending.reject(error);
          } else {
            diagnostic = { site: 'rpc-result', method: pending.method };
            try {
              pending.accept?.(value.result);
              pending.resolve(value.result);
            } catch (error) {
              const failure = acpErrorAt(error, diagnostic);
              pending.reject(failure);
              throw failure;
            }
          }
        }
      }
      if (this.pending.length > 1048576) throw new AcpError('output-limit');
    } catch (error) {
      this.fail(acpErrorAt(error, diagnostic));
    }
  }
}

export function acpEnvironment(source: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  if (!source.HOME || !isAbsolute(source.HOME)) throw new AcpError('identity');
  const result: NodeJS.ProcessEnv = {
    HOME: source.HOME,
    LANG: 'C',
    NO_COLOR: '1',
    TMPDIR: join(directory, 'tmp'),
    // Prefer the native URL handler before Python's AppleScript browser routes.
    ...(process.platform === 'darwin' ? { BROWSER: '/usr/bin/open %s' } : {}),
  };
  for (const key of ['USER', 'LOGNAME', 'PATH', 'TERM'])
    if (source[key] !== undefined) result[key] = source[key];
  return result;
}
function sync(callback: () => unknown) {
  const result = callback();
  if (result instanceof Promise) {
    void result.catch(() => {});
    throw new AcpError('ownership');
  }
}

/** A protocol result cannot release ownership before all streams and the group end. */
export function startAcpProcess<T>(
  options: AcpProcessOptions,
  work: (
    connection: AcpConnection,
    onStop: (stop: () => void) => void,
    settle: (metadata: T) => void,
  ) => Promise<T>,
) {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const limits: AcpLimits = { ...writerAcpLimits, ...options.limits };
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 1000 ||
    options.timeoutMs > limits.maxTimeoutMs
  )
    throw new AcpError('deadline');
  if (process.platform === 'win32' || !isAbsolute(options.directory))
    throw new AcpError('identity');
  const executable = validateAcpClientIdentity(options.client).executable;
  validateAcpDirectory(options.directory);
  try {
    mkdirSync(join(options.directory, 'tmp'), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  validateAcpDirectory(join(options.directory, 'tmp'), options.directory);
  const schedule =
    options.schedule ??
    ((work, ms) => {
      const timer = setTimeout(work, ms);
      return () => clearTimeout(timer);
    });
  if (now() - started >= options.timeoutMs - 1000) throw new AcpError('deadline');
  sync(() => options.lifecycle.beforePhase());
  const child = (options.spawn ?? spawn)(executable, [], {
    cwd: options.directory,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: acpEnvironment(options.environment, options.directory),
  });
  const group = child.pid ?? 0;
  let reason: AcpReason | null = null,
    stopping = false,
    finished = false,
    completed = false,
    cleanupTerminated = false,
    stderrBytes = 0;
  let stopper: (() => void) | undefined;
  let code: number | null = null,
    signal: NodeJS.Signals | null = null;
  const closed = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => {});
  const timers: (() => void)[] = [];
  function kill(value: NodeJS.Signals) {
    if (group > 0 && !groupAbsent(group)) {
      try {
        process.kill(-group, value);
        if (completed && reason === null && value === 'SIGTERM') cleanupTerminated = true;
      } catch {}
    }
  }
  function shutdown() {
    if (!child.stdin.destroyed) child.stdin.end();
    timers.push(schedule(() => kill('SIGTERM'), 100));
    timers.push(schedule(() => kill('SIGKILL'), 250));
  }
  const connection = new AcpConnection(
    child.stdin,
    (error) => {
      connection.noteDiagnostic(error.diagnostic);
      reason ??= error.reason;
      failed.reject(error);
      shutdown();
    },
    () => {
      if (stopping) throw new AcpError(reason === 'deadline' ? 'deadline' : 'stopped');
      if (now() - started >= options.timeoutMs - 1000) throw new AcpError('deadline');
    },
    limits,
  );

  child.stdout.on('data', (bytes: Buffer) => connection.push(bytes));
  child.stdout.once('end', () => connection.end());
  child.stdout.on('error', () =>
    connection.fail(new AcpError('protocol', { site: 'stdout-stream' })),
  );
  child.stderr.on('error', () =>
    connection.fail(new AcpError('protocol', { site: 'stderr-stream' })),
  );
  const stderrClassifier = new AcpStderrClassifier();
  child.stderr.on('data', (bytes: Buffer) => {
    stderrBytes += bytes.length;
    if (stderrBytes <= stderrLimit) stderrClassifier.push(bytes);
    if (stderrBytes > stderrLimit)
      connection.fail(new AcpError('output-limit', { site: 'stderr-output' }));
  });
  child.stdin.on('error', () =>
    connection.fail(new AcpError('protocol', { site: 'stdin-stream' })),
  );
  child.once('error', () => {
    connection.noteDiagnostic({ site: 'launch' });
    reason ??= 'launch';
    failed.reject(new AcpError('launch'));
  });
  child.once('close', (exitCode, exitSignal) => {
    code = exitCode;
    signal = exitSignal;
    closed.resolve();
  });
  function stop(cause: 'stopped' | 'deadline' = 'stopped') {
    if (finished || stopping) return;
    stopping = true;
    connection.noteDiagnostic({ site: cause === 'deadline' ? 'deadline' : 'stop' });
    reason ??= cause;
    try {
      if (stopper) stopper();
      else {
        failed.reject(new AcpError(cause));
        shutdown();
      }
    } catch {
      failed.reject(new AcpError(cause));
      shutdown();
    }
    timers.push(
      schedule(() => {
        failed.reject(new AcpError(cause));
        shutdown();
      }, 500),
    );
  }
  timers.push(
    schedule(() => stop('deadline'), Math.max(0, options.timeoutMs - 1000 - (now() - started))),
  );
  const result = (async (): Promise<AcpProcessOutcome<T>> => {
    let metadata: T | null = null;
    let working = true;
    try {
      if (!group) throw new AcpError('launch');
      sync(() => options.lifecycle.owned(group));
      metadata = await Promise.race([
        work(
          connection,
          (callback) => {
            stopper = callback;
            if (stopping) callback();
          },
          (value) => {
            // A terminal outcome recorded before any failure survives a later cleanup error.
            if (working && !connection.failed) metadata = value;
          },
        ),
        failed.promise,
      ]);
      completed = true;
    } catch (error) {
      connection.noteDiagnostic(acpErrorAt(error, { site: 'work' }).diagnostic);
      reason ??= error instanceof AcpError ? error.reason : 'protocol';
    }
    working = false;
    {
      shutdown();
      const closedInTime = await Promise.race([
        closed.promise.then(() => true),
        new Promise<false>((resolve) => timers.push(schedule(() => resolve(false), 500))),
      ]);
      const quiescent = closedInTime && group > 0 && groupAbsent(group);
      if (quiescent) {
        try {
          sync(() => options.lifecycle.quiescent(group));
        } catch {
          connection.noteDiagnostic({ site: 'ownership' });
          reason = 'ownership';
        }
      } else {
        connection.noteDiagnostic({ site: 'ownership' });
        reason = 'ownership';
      }
      finished = true;
      for (const cancel of timers) cancel();
      if (!closedInTime) kill('SIGKILL');
      // A completed response survives the SIGTERM sent for owned cleanup.
      const expectedExit =
        (code === 0 && signal === null) ||
        (completed && cleanupTerminated && code === null && signal === 'SIGTERM');
      if (quiescent && reason === null && !expectedExit) {
        connection.noteDiagnostic({ site: 'exit' });
        reason = 'protocol';
      }
      if (reason === null && now() - started >= options.timeoutMs) {
        connection.noteDiagnostic({ site: 'deadline' });
        reason = 'deadline';
      }
      return {
        metadata,
        reason,
        quiescent,
        exitCode: code,
        signal,
        stdoutBytes: connection.stdoutBytes,
        stderrBytes,
        stderrSummary: stderrClassifier.finish(),
        diagnostic: connection.diagnostic,
      };
    }
  })();
  return { group, result, stop: () => stop() };
}
