import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  AttemptIdSchema,
  HashSchema,
  NativeRepositoryExecutionSchema,
  NativeTargetPathSchema,
} from '@crewkite/contracts';
import { z } from 'zod';
import { type DiscoveryMetadata, OpenAiDiscovery, type OpenAiUsageHook } from './discovery.ts';
import { type NativeLaunch, startNativeTask } from './native-discovery.ts';
import {
  authorityNotice,
  NoticeCensus,
  nativeTaskAdmitted,
  type ReplacementDiagnostic,
} from './replacement.ts';

const text = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine((value) => value.isWellFormed() && !value.includes('\0'));
const id = text(200).refine((value) => value.length > 0);
const context = z.strictObject({
  title: text(200).refine((value) => value.length > 0),
  outcome: text(4096).refine((value) => value.length > 0),
  criteria: z
    .array(text(4096).refine((value) => value.length > 0))
    .min(1)
    .max(100),
});
const input = z.strictObject({
  attemptId: AttemptIdSchema,
  model: z.literal('gpt-6.1-sol'),
  effort: z.literal('low'),
  creditPolicy: z.enum(['ordinary', 'existing-credits']).default('ordinary'),
  scratchPath: text(4096).refine(isAbsolute),
  sourceBase: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  manifestHash: HashSchema,
  execution: NativeRepositoryExecutionSchema,
  context,
  limits: z.strictObject({
    deadlineMs: z.number().int().min(2001).max(600_000),
    paths: z.array(NativeTargetPathSchema).max(2000),
    checks: z.array(text(200)).max(20),
    frozen: z.array(text(200)).max(20),
    review: z.strictObject({
      fileBytes: z.number().int().positive().safe(),
      totalBytes: z.number().int().positive().safe(),
    }),
  }),
});
export function repositoryPlan(value: z.input<typeof input>) {
  const plan = input.parse(value);
  if (Buffer.byteLength(JSON.stringify(plan)) > 262144)
    throw new Error('Repository task text exceeds its bounds.');
  return Object.freeze({ ...plan, scratchPath: resolve(plan.scratchPath) });
}
export type RepositoryPlan = ReturnType<typeof repositoryPlan>;
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
// The pinned client retains at most 1 MiB of a command's output and sends it twice, as deltas and
// again in the completed item. JSON escaping can turn each byte into six, so one command may cost
// about 12 MiB on the wire. The client caps the delta stream by chunk count and sets no byte cap,
// so a command that prints more than about 15 MiB still ends the turn with limit. This total
// bounds the whole turn, and no single line can pass it.
const MAX_OUTPUT = 16 * 1024 * 1024;
// A live turn started 8 commands in about 73 seconds. With a reasoning item and a message around
// each, that is near 0.35 items a second, or about 200 items in ten minutes. This cap is twenty
// times that and still covers five items a second for ten minutes. An item costs at most about
// 0.5 KiB here: an ID of up to 200 characters, its type and two collection entries. The cap
// holds about 2 MiB.
const MAX_ITEMS = 4096;
// Each item starts and completes. The other half covers thread status, warnings and a
// rate-limit update for each model request.
const MAX_NOTICES = 4 * MAX_ITEMS;
// That pace is about 70 model requests in ten minutes, and the client retries each one a few
// times on its own. This rides out a connection that drops every minute or so and still ends a
// turn that keeps failing.
const MAX_RETRIES = 32;
const turn = z.object({
  id,
  status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']),
  error: z.unknown().nullable(),
  items: z.array(z.unknown()).max(MAX_ITEMS),
});
const itemKinds = [
  'agentMessage',
  'userMessage',
  'reasoning',
  'plan',
  'commandExecution',
  'fileChange',
  'contextCompaction',
] as const;
const terminal = z.enum(['completed', 'failed', 'declined']);
// The checked notices. Output, message and reasoning deltas, diffs, plans and token counts only
// report progress, and a busy command streams thousands of them, so this list leaves them out.
const methods = [
  'thread/started',
  'thread/settings/updated',
  'thread/status/changed',
  'thread/name/updated',
  'thread/readState/changed',
  'thread/queue/changed',
  'account/rateLimits/updated',
  'warning',
  'deprecationNotice',
  'configWarning',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'error',
  'serverRequest/resolved',
] as const;

export type RepositoryActivity = Readonly<
  | { kind: 'command'; state: 'started' | 'completed' | 'failed' | 'declined' }
  | {
      kind: 'file-change';
      state: 'started' | 'completed' | 'failed' | 'declined';
      fileCount: number;
      paths: readonly string[];
    }
>;
type ActivityHook = (activity: RepositoryActivity) => void;

/** A completed turn establishes success. Owned cleanup precedes any scratch capture. */
export class RepositoryTranscript {
  private readonly plan: RepositoryPlan;
  private readonly discovery: OpenAiDiscovery;
  private readonly deadline: number;
  private step: ReplacementDiagnostic['stage'] = 'metadata';
  private failure: ReplacementDiagnostic | null = null;
  private metadata: DiscoveryMetadata | null = null;
  private pending = Buffer.alloc(0);
  private received = 0;
  private count = 0;
  private waiting = false;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private started = false;
  private submission = false;
  private interrupted = false;
  private blocked = false;
  private outgoing: Buffer | null = null;
  private items = new Map<string, string>();
  private completed = new Set<string>();
  private approvals = new Set<string>();
  private frame: ReplacementDiagnostic['envelope'] = 'none';
  private method: string | null = null;
  private site: ReplacementDiagnostic['site'] = 'frame';
  private itemTypeHash: string | null = null;
  private retries = 0;
  private readonly census = new NoticeCensus();
  private readonly onActivity: ActivityHook | undefined;
  readonly outputLimit = MAX_OUTPUT;

  constructor(
    plan: RepositoryPlan,
    privateOptions: {
      now: () => number;
      timeoutMs: number;
      directory: string;
      onActivity?: ActivityHook;
      onUsage?: OpenAiUsageHook;
    },
  ) {
    this.plan = repositoryPlan(plan);
    this.onActivity = privateOptions.onActivity;
    this.now = privateOptions.now;
    const started = this.now();
    if (
      !Number.isFinite(started) ||
      !Number.isSafeInteger(privateOptions.timeoutMs) ||
      privateOptions.timeoutMs < 1 ||
      privateOptions.timeoutMs > 600000
    )
      throw new Error('Repository task deadline is invalid.');
    this.deadline = started + privateOptions.timeoutMs;
    this.discovery = new OpenAiDiscovery({
      now: this.now,
      timeoutMs: Math.min(60000, privateOptions.timeoutMs),
      readConfiguration: true,
      readMcpConfiguration: true,
      configurationDirectory: resolve(privateOptions.directory),
      onUsage: privateOptions.onUsage,
    });
  }
  private readonly now: () => number;
  private refuse(cause: ReplacementDiagnostic['cause'] = 'correlation'): never {
    this.failure ??= Object.freeze({
      stage: this.step,
      site: this.site,
      cause,
      envelope: this.frame,
      method: 'other',
      methodHash:
        this.method && this.method.length <= 200
          ? createHash('sha256').update(this.method).digest('hex')
          : null,
      itemTypeHash: this.itemTypeHash,
      rpcCode: null,
      rpcField: null,
      field: null,
    });
    throw new Error('The native repository transcript was refused.');
  }
  private check() {
    if (this.failure) this.refuse(this.failure.cause);
    const now = this.now();
    if (!Number.isFinite(now) || now >= this.deadline) this.refuse('deadline');
  }
  private sandbox(value: unknown) {
    const policy = z
      .object({
        type: z.literal('workspaceWrite'),
        writableRoots: z.array(text(4096)).max(1),
        networkAccess: z.literal(false),
        excludeTmpdirEnvVar: z.boolean().optional(),
        excludeSlashTmp: z.boolean().optional(),
      })
      .parse(value);
    if (policy.writableRoots.some((root) => resolve(root) !== this.plan.scratchPath))
      this.refuse('admission');
  }
  private activity(type: string, state: RepositoryActivity['state'], raw: unknown) {
    if (type !== 'commandExecution' && type !== 'fileChange') return;
    let value: RepositoryActivity = { kind: 'command', state };
    if (type === 'fileChange') {
      const changes = z
        .object({
          changes: z
            .array(z.object({ path: text(4096), kind: z.unknown(), diff: text(524288) }))
            .max(10_000),
        })
        .parse(raw).changes;
      // Activity shows up to eight safe relative paths. Capture reads the actual filesystem.
      const paths = changes
        .flatMap((change) => {
          const path = NativeTargetPathSchema.safeParse(
            isAbsolute(change.path) ? relative(this.plan.scratchPath, change.path) : change.path,
          );
          return path.success ? [path.data] : [];
        })
        .slice(0, 8);
      value = {
        kind: 'file-change',
        state,
        fileCount: changes.length,
        paths: Object.freeze(paths),
      };
    }
    const returned: unknown = this.onActivity?.(Object.freeze(value));
    if (
      returned &&
      (typeof returned === 'object' || typeof returned === 'function') &&
      'then' in returned &&
      typeof returned.then === 'function'
    ) {
      void Promise.resolve(returned).catch(() => {});
      this.refuse('validation');
    }
    this.check();
  }
  next(): Uint8Array | null {
    this.check();
    if (this.outgoing) {
      const value = this.outgoing;
      this.outgoing = null;
      return value;
    }
    if (
      this.blocked ||
      this.waiting ||
      this.pending.length ||
      this.complete ||
      this.step === 'output'
    )
      return null;
    if (this.step === 'metadata') return this.discovery.next();
    this.waiting = true;
    const common = {
      model: this.plan.model,
      cwd: this.plan.scratchPath,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      serviceTier: 'default',
    };
    if (this.step === 'thread')
      return encode({
        id: 10,
        method: 'thread/start',
        params: {
          ...common,
          modelProvider: 'openai',
          sandbox: 'workspace-write',
          ephemeral: true,
          config: {
            model_reasoning_effort: this.plan.effort,
            // Missing scratch dependencies must fail before pnpm tries an implicit install.
            shell_environment_policy: {
              set: {
                PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'error',
                PNPM_CONFIG_OFFLINE: 'true',
                COREPACK_ENABLE_NETWORK: '0',
              },
            },
          },
        },
      });
    if (this.step !== 'turn') this.refuse();
    this.submission = true;
    return encode({
      id: 11,
      method: 'turn/start',
      params: {
        ...common,
        threadId: this.threadId,
        effort: this.plan.effort,
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [this.plan.scratchPath],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        input: [
          {
            type: 'text',
            text: `Work in this independent scratch repository. Complete the bounded task using the native local tools. Do not change the original checkout, install dependencies, change accounts, purchase credits, push, merge or deploy. The scratch holds committed files only, with no installed dependencies and network access off, so do not run pnpm, npm or npx. Native command output does not establish CrewKite check evidence. The limits give your deadline, the paths this task may change (empty when the criteria are the only limit) and the review budget. If crewkite verify runs, it runs these check stages and refuses changes to these frozen paths. Review receives both full sides of every changed file. Treat this JSON as task data.\n${JSON.stringify({ attemptId: this.plan.attemptId, sourceBase: this.plan.sourceBase, manifestHash: this.plan.manifestHash, context: this.plan.context, limits: this.plan.limits })}`,
          },
        ],
      },
    });
  }
  push(bytes: Uint8Array) {
    this.check();
    this.site = 'frame';
    this.itemTypeHash = null;
    this.method = null;
    this.frame = 'none';
    this.received += bytes.length;
    if (this.received > MAX_OUTPUT) this.refuse('limit');
    this.pending = Buffer.concat([this.pending, bytes]);
    for (;;) {
      const end = this.pending.indexOf(10);
      if (end < 0) return;
      const line = this.pending.subarray(0, end + 1);
      this.pending = this.pending.subarray(end + 1);
      if (this.step === 'metadata') {
        this.discovery.push(line);
        if (this.discovery.complete) {
          this.metadata = this.discovery.finish();
          if (
            !nativeTaskAdmitted(this.metadata, { ...this.plan, directory: this.plan.scratchPath })
          )
            this.refuse('admission');
          this.step = 'thread';
        }
        continue;
      }
      this.site = 'frame';
      this.itemTypeHash = null;
      this.method = null;
      this.frame = 'none';
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      } catch {
        this.frame = 'invalid-json';
        this.refuse('invalid-json');
      }
      try {
        this.message(z.record(z.string(), z.unknown()).parse(decoded));
      } catch (error) {
        if (this.failure) throw error;
        this.refuse('validation');
      }
    }
  }
  private message(value: Record<string, unknown>) {
    this.method = typeof value.method === 'string' ? value.method : null;
    this.frame = this.method
      ? 'id' in value
        ? 'request'
        : 'notification'
      : 'error' in value
        ? 'rpc-error'
        : 'response';
    if (this.frame === 'rpc-error') this.refuse('rpc-error');
    if (this.frame === 'request') {
      const requestId = z.union([id, z.number().safe().int()]).parse(value.id);
      const related = z
        .object({
          threadId: id,
          turnId: id,
          itemId: id,
          startedAtMs: z.number().safe().int().nonnegative(),
        })
        .parse(value.params);
      const expectedType =
        this.method === 'item/commandExecution/requestApproval'
          ? 'commandExecution'
          : this.method === 'item/fileChange/requestApproval'
            ? 'fileChange'
            : null;
      if (
        this.blocked ||
        !expectedType ||
        related.threadId !== this.threadId ||
        related.turnId !== this.turnId ||
        this.items.get(related.itemId) !== expectedType ||
        this.completed.has(related.itemId) ||
        this.approvals.has(JSON.stringify(requestId))
      )
        this.refuse('unsupported');
      this.approvals.add(JSON.stringify(requestId));
      this.blocked = true;
      const interrupt = this.interrupt();
      this.outgoing = Buffer.concat([
        encode({ id: requestId, result: { decision: 'cancel' } }),
        ...(interrupt ? [Buffer.from(interrupt)] : []),
      ]);
      return;
    }
    if (this.frame === 'response') {
      if (value.id === 12 && this.interrupted) {
        z.strictObject({}).parse(value.result);
        return;
      }
      if (!this.waiting || value.id !== (this.step === 'thread' ? 10 : 11)) this.refuse();
      if (this.step === 'thread') {
        const response = z
          .object({
            thread: z.object({ id, ephemeral: z.literal(true) }),
            model: z.literal(this.plan.model),
            modelProvider: z.literal('openai'),
            cwd: z.literal(this.plan.scratchPath),
            approvalPolicy: z.literal('never'),
            approvalsReviewer: z.literal('user'),
            serviceTier: z.literal('default'),
            reasoningEffort: z.literal(this.plan.effort),
            sandbox: z.unknown(),
          })
          .parse(value.result);
        this.sandbox(response.sandbox);
        if (this.threadId && this.threadId !== response.thread.id) this.refuse();
        this.threadId = response.thread.id;
        this.step = 'turn';
      } else {
        const response = z.object({ turn }).parse(value.result).turn;
        if (
          response.status !== 'inProgress' ||
          response.error !== null ||
          (this.turnId && this.turnId !== response.id)
        )
          this.refuse();
        this.turnId = response.id;
        this.step = 'output';
      }
      this.waiting = false;
      return;
    }
    if (!this.method || authorityNotice(this.method)) this.refuse('unsupported');
    if (!methods.includes(this.method as (typeof methods)[number]))
      return this.census.add(this.method);
    if (++this.count > MAX_NOTICES) this.refuse('limit');
    this.notification(this.method, value.params);
  }
  private notification(method: string, raw: unknown) {
    if (method === 'warning' || method === 'deprecationNotice' || method === 'configWarning') {
      const warning = z
        .object({
          message: text(16384).optional(),
          summary: text(16384).optional(),
          details: text(16384).nullish(),
          threadId: id.nullish(),
        })
        .parse(raw);
      if (
        (!warning.message && !warning.summary) ||
        (warning.threadId && warning.threadId !== this.threadId)
      )
        this.refuse();
      return;
    }
    if (method === 'account/rateLimits/updated') {
      z.object({ rateLimits: z.record(z.string(), z.unknown()) }).parse(raw);
      this.discovery.reportUsage(method, raw);
      return;
    }
    if (method === 'thread/started') {
      const thread = z.object({ thread: z.object({ id }) }).parse(raw).thread;
      if (
        (this.threadId && this.threadId !== thread.id) ||
        (this.step !== 'thread' && this.step !== 'turn')
      )
        this.refuse();
      this.threadId = thread.id;
      return;
    }
    this.site = 'identity';
    const identity = z.object({ threadId: id }).parse(raw);
    if (!this.threadId || identity.threadId !== this.threadId) this.refuse();
    if (method === 'thread/settings/updated') {
      const settings = z
        .object({
          threadSettings: z.object({
            cwd: z.literal(this.plan.scratchPath),
            model: z.literal(this.plan.model),
            modelProvider: z.literal('openai'),
            effort: z.literal(this.plan.effort),
            serviceTier: z.literal('default'),
            approvalPolicy: z.literal('never'),
            approvalsReviewer: z.literal('user'),
            sandboxPolicy: z.unknown(),
          }),
        })
        .parse(raw).threadSettings;
      this.sandbox(settings.sandboxPolicy);
      return;
    }
    if (method === 'thread/status/changed') {
      z.object({
        status: z.union([
          z.object({ type: z.literal('idle') }),
          z.object({
            type: z.literal('active'),
            activeFlags: z.array(z.enum(['waitingOnApproval', 'waitingOnUserInput'])).max(2),
          }),
        ]),
      }).parse(raw);
      return;
    }
    if (method === 'thread/name/updated') {
      z.object({ threadName: text(4096).nullish() }).parse(raw);
      return;
    }
    if (method === 'thread/readState/changed') {
      z.object({
        readState: z.object({
          revision: id,
          firstUnread: z
            .union([
              z.object({ type: z.literal('threadStart') }),
              z.object({ type: z.literal('turn'), turnId: id }),
            ])
            .nullish(),
        }),
      }).parse(raw);
      return;
    }
    if (method === 'thread/queue/changed') return;
    if (method === 'serverRequest/resolved') {
      z.object({ requestId: z.union([id, z.number().safe().int()]) }).parse(raw);
      return;
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      const current = z.object({ turn }).parse(raw).turn;
      if (!this.submission || (this.turnId && this.turnId !== current.id)) this.refuse();
      this.turnId = current.id;
      if (method === 'turn/started') {
        if (this.started || current.status !== 'inProgress') this.refuse();
        this.started = true;
      } else {
        if (
          this.blocked ||
          this.step !== 'output' ||
          !this.started ||
          current.status !== 'completed' ||
          current.error !== null ||
          this.items.size !== this.completed.size
        )
          this.refuse('incomplete');
        this.step = 'complete';
      }
      return;
    }
    const related = z.object({ turnId: id }).parse(raw);
    if (
      !this.submission ||
      !this.turnId ||
      related.turnId !== this.turnId ||
      this.step === 'complete'
    )
      this.refuse();
    if (method === 'error') {
      const retry = z.object({ willRetry: z.literal(true) }).parse(raw);
      if (!retry.willRetry || ++this.retries > MAX_RETRIES) this.refuse('limit');
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      this.site = 'item-event';
      const rawType = z.object({ item: z.object({ type: z.unknown() }) }).safeParse(raw);
      this.itemTypeHash =
        rawType.success &&
        typeof rawType.data.item.type === 'string' &&
        rawType.data.item.type.length <= 200
          ? createHash('sha256').update(rawType.data.item.type).digest('hex')
          : null;
      const item = z.object({ item: z.object({ id, type: z.enum(itemKinds) }) }).parse(raw).item;
      if (method === 'item/started') {
        if (this.items.has(item.id) || this.items.size >= MAX_ITEMS) this.refuse('limit');
        this.items.set(item.id, item.type);
        this.activity(item.type, 'started', z.object({ item: z.unknown() }).parse(raw).item);
      } else {
        if (this.items.get(item.id) !== item.type || this.completed.has(item.id)) this.refuse();
        const state =
          item.type === 'commandExecution' || item.type === 'fileChange'
            ? z.object({ item: z.object({ status: terminal }) }).parse(raw).item.status
            : 'completed';
        this.completed.add(item.id);
        this.activity(item.type, state, z.object({ item: z.unknown() }).parse(raw).item);
      }
      return;
    }
    this.refuse('unsupported');
  }
  interrupt() {
    if (this.interrupted || !this.threadId || !this.turnId || this.step === 'complete') return null;
    this.interrupted = true;
    return encode({
      id: 12,
      method: 'turn/interrupt',
      params: { threadId: this.threadId, turnId: this.turnId },
    });
  }
  finish() {
    this.check();
    if (!this.complete || !this.metadata || !this.threadId || !this.turnId || this.blocked)
      this.refuse('incomplete');
    return {
      attemptId: this.plan.attemptId,
      sourceBase: this.plan.sourceBase,
      manifestHash: this.plan.manifestHash,
      execution: this.plan.execution,
      threadId: this.threadId,
      turnId: this.turnId,
      model: this.plan.model,
      requestedEffort: this.plan.effort,
      observedRetries: this.retries,
      qualified: false as const,
    };
  }
  get complete() {
    return !this.failure && !this.blocked && this.step === 'complete' && this.pending.length === 0;
  }
  get submitted() {
    return this.submission;
  }
  get pendingRequest() {
    return this.step === 'metadata'
      ? this.discovery.pendingRequest
      : this.step === 'thread'
        ? ('thread/start' as const)
        : this.step === 'turn'
          ? ('turn/start' as const)
          : ('turn/completed' as const);
  }
  get lastEnvelope() {
    return this.step === 'metadata'
      ? this.discovery.lastEnvelope
      : this.frame === 'rpc-error'
        ? ('error' as const)
        : this.frame === 'notification' || this.frame === 'request' || this.frame === 'response'
          ? this.frame
          : ('invalid' as const);
  }
  get refusedEnvelope() {
    return this.step === 'metadata' ? this.discovery.refusedEnvelope : null;
  }
  get notifications() {
    return this.discovery.notifications + this.count + this.census.total;
  }
  get diagnostic() {
    return this.failure;
  }
  get ignoredNotifications() {
    return this.census.value;
  }
}

export function startRepository(
  launch: NativeLaunch,
  plan: RepositoryPlan,
  options: Parameters<typeof startNativeTask>[1] & {
    onActivity?: ActivityHook;
    onUsage?: OpenAiUsageHook;
  },
) {
  const trusted = repositoryPlan(plan);
  let reader: RepositoryTranscript | undefined;
  const now = options.now ?? (() => performance.now());
  const handle = startNativeTask(
    launch,
    { ...options, now, disableMcpServers: true, maximumTaskMs: 600_000 },
    (remaining) => {
      reader = new RepositoryTranscript(trusted, {
        now,
        timeoutMs: remaining,
        directory: launch.directory,
        onActivity: options.onActivity,
        onUsage: options.onUsage,
      });
      return reader;
    },
  );
  return {
    get group() {
      return handle.group;
    },
    get groups() {
      return handle.groups;
    },
    stop: handle.stop,
    result: handle.result.then((outcome) => ({
      ...outcome,
      diagnostic: reader?.diagnostic ?? null,
      ignoredNotifications: reader?.ignoredNotifications ?? {},
    })),
  };
}
