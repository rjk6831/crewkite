import { ConversationModelCatalogEntriesSchema, type Observation } from '@crewkite/contracts';
import { z } from 'zod';

const MAX_LINE_BYTES = 65_536;
const MAX_TOTAL_BYTES = 1_048_576;
const text = (maximum: number) => z.string().min(1).max(maximum);
const id = text(200);
const plan = z.enum(['free', 'go', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu']);
const outgoing = z.union([
  z.strictObject({
    id: z.literal(1),
    method: z.literal('initialize'),
    params: z.strictObject({
      clientInfo: z.strictObject({
        name: z.literal('crewkite'),
        title: z.literal('CrewKite'),
        version: z.literal('0.0.0'),
      }),
      capabilities: z.strictObject({
        experimentalApi: z.literal(false),
        explicitGatewayOauth: z.literal(true),
      }),
    }),
  }),
  z.strictObject({ method: z.literal('initialized') }),
  z.strictObject({
    id: z.literal(2),
    method: z.literal('account/read'),
    params: z.strictObject({ refreshToken: z.literal(false) }),
  }),
  z.strictObject({
    id: z.literal(3),
    method: z.literal('account/rateLimits/read'),
    params: z.strictObject({
      supportsLunaReserve: z.literal(false),
      excludeResetCreditDetails: z.literal(true),
    }),
  }),
  z.strictObject({
    id: z.union([z.literal(4), z.literal(7)]),
    method: z.literal('model/list'),
    params: z.strictObject({
      limit: z.literal(20),
      includeHidden: z.boolean(),
      cursor: text(200).optional(),
    }),
  }),
  z.strictObject({
    id: z.literal(5),
    method: z.literal('config/read'),
    params: z.strictObject({ includeLayers: z.literal(false), cwd: text(4096) }),
  }),
  z.strictObject({ id: z.literal(6), method: z.literal('configRequirements/read') }),
]);
const requests: z.input<typeof outgoing>[][] = [
  [
    {
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'crewkite', title: 'CrewKite', version: '0.0.0' },
        capabilities: { experimentalApi: false, explicitGatewayOauth: true },
      },
    },
  ],
  [{ method: 'initialized' }, { id: 2, method: 'account/read', params: { refreshToken: false } }],
  [
    {
      id: 3,
      method: 'account/rateLimits/read',
      params: { supportsLunaReserve: false, excludeResetCreditDetails: true },
    },
  ],
];
// The fixed requests, then model/list, whose page and cursor depend on the read.
const STEPS = requests.length + 1;
// A reply holds a result or an error, never both. Envelope fields a later client adds pass.
const responseId = z.number().int().min(1).max(7);
const response = z.union([
  z.object({ id: responseId, result: z.unknown(), error: z.never().optional() }),
  z.object({ id: responseId, error: z.unknown(), result: z.never().optional() }),
]);

// Discovery reads nothing else from a notice, so any method and params pass and only count toward
// the bound. A server request carries an id and waits for an answer this reader never sends, so it
// still stops discovery.
const notification = z.object({ method: z.string().min(1).max(200), id: z.never().optional() });
// A task's metadata phase runs through this reader, and remote control reaching the client
// refuses a task. Only the status decides; the notice's other fields pass.
const remoteControl = z.object({ params: z.object({ status: z.literal('disabled') }) });
// A notice carries authority when it ends or moves the thread, opens a realtime session, reroutes
// the model, starts a hook or MCP server, changes the account or remote control, or touches
// approvals. A task's transcript refuses every one of them. Discovery runs as a task's metadata
// phase, so it refuses them too, except the account update and remote control status that arrive
// at startup. Any other notice passes.
const authorityNotices: ReadonlySet<string> = new Set([
  'thread/archived',
  'thread/unarchived',
  'thread/deleted',
  'thread/closed',
  'thread/reverted',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'remoteControl/status/changed',
  'model/rerouted',
  'hook/started',
  'hook/completed',
  'account/updated',
  'account/login/completed',
  'account/gatewayOAuth/changed',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'autoApprovalReview/strictReviewRequired',
  'guardianWarning',
]);
export const authorityNotice = (method: string) =>
  authorityNotices.has(method) ||
  method.startsWith('thread/realtime/') ||
  method.startsWith('mcpServer/');
export type DiscoveryEnvelope =
  | 'response'
  | 'error'
  | 'config-warning'
  | 'account-updated'
  | 'remote-control-status'
  | 'notification'
  | 'invalid'
  | null;

type FieldKind = 'missing' | 'null' | 'object' | 'array' | 'string' | 'number' | 'boolean';
export type RefusedEnvelope = {
  kind:
    | 'invalid-json'
    | 'response'
    | 'error'
    | 'config-warning'
    | 'account-updated'
    | 'remote-control-status'
    | 'other-notification'
    | 'other';
  extraEnvelopeFields: boolean;
  extraParamsFields: boolean | null;
  fields: Record<
    | 'id'
    | 'result'
    | 'error'
    | 'params'
    | 'summary'
    | 'details'
    | 'path'
    | 'range'
    | 'authMode'
    | 'planType',
    FieldKind
  >;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function fieldKind(value: Record<string, unknown> | null, key: string): FieldKind {
  if (!value || !Object.hasOwn(value, key)) return 'missing';
  const field = value[key];
  if (field === null) return 'null';
  if (Array.isArray(field)) return 'array';
  if (typeof field === 'object') return 'object';
  if (typeof field === 'string') return 'string';
  if (typeof field === 'number') return 'number';
  return 'boolean';
}
function refusedEnvelope(value: unknown, invalidJson = false): RefusedEnvelope {
  const envelope = record(value);
  const params = record(envelope?.params);
  const method = envelope?.method;
  const kind: RefusedEnvelope['kind'] = invalidJson
    ? 'invalid-json'
    : method === 'configWarning'
      ? 'config-warning'
      : method === 'account/updated'
        ? 'account-updated'
        : method === 'remoteControl/status/changed'
          ? 'remote-control-status'
          : envelope && Object.hasOwn(envelope, 'method')
            ? 'other-notification'
            : envelope && Object.hasOwn(envelope, 'result')
              ? 'response'
              : envelope && Object.hasOwn(envelope, 'error')
                ? 'error'
                : 'other';
  const envelopeKeys =
    kind.endsWith('notification') ||
    kind === 'config-warning' ||
    kind === 'account-updated' ||
    kind === 'remote-control-status'
      ? ['method', 'params', 'emittedAtMs']
      : ['id', 'result', 'error'];
  const paramsKeys =
    kind === 'config-warning'
      ? ['summary', 'details', 'path', 'range']
      : kind === 'account-updated'
        ? ['authMode', 'planType']
        : kind === 'remote-control-status'
          ? ['status', 'serverName', 'installationId', 'environmentId']
          : [];
  return {
    kind,
    extraEnvelopeFields:
      !!envelope && Object.keys(envelope).some((key) => !envelopeKeys.includes(key)),
    extraParamsFields: params ? Object.keys(params).some((key) => !paramsKeys.includes(key)) : null,
    fields: {
      id: fieldKind(envelope, 'id'),
      result: fieldKind(envelope, 'result'),
      error: fieldKind(envelope, 'error'),
      params: fieldKind(envelope, 'params'),
      summary: fieldKind(params, 'summary'),
      details: fieldKind(params, 'details'),
      path: fieldKind(params, 'path'),
      range: fieldKind(params, 'range'),
      authMode: fieldKind(params, 'authMode'),
      planType: fieldKind(params, 'planType'),
    },
  };
}

// Project only the metadata this reader uses. Native identity and extra fields stay private.
const platform = z
  .object({ userAgent: text(512), platformFamily: text(32), platformOs: text(32) })
  .transform(({ platformFamily, platformOs }) => ({ platformFamily, platformOs }));
const account = z
  .object({
    account: z.object({ type: text(64), planType: text(64).optional() }).nullable(),
    requiresOpenaiAuth: z.boolean(),
  })
  .transform(({ account, requiresOpenaiAuth }) => ({
    type:
      account === null
        ? ('none' as const)
        : account.type === 'chatgpt' ||
            account.type === 'apiKey' ||
            account.type === 'amazonBedrock'
          ? account.type
          : ('unknown' as const),
    plan:
      account?.type === 'chatgpt'
        ? (plan.safeParse(account.planType).data ?? ('unknown' as const))
        : ('unknown' as const),
    requiresOpenaiAuth,
  }));
const window = z
  .object({
    usedPercent: z.number().int().min(0).max(100),
    windowDurationMins: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    resetsAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .nullable();
const creditSnapshot = z
  .object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z
      .string()
      .max(128)
      .regex(/^-?\d+(?:\.\d+)?$/)
      .nullish(),
  })
  .nullish();
const bucket = z
  .object({
    limitId: id.nullish(),
    primary: window.optional(),
    secondary: window.optional(),
    credits: creditSnapshot,
    spendControlReached: z.boolean().nullish(),
    // Admission spends existing credits only when this is null or rate_limit_reached. Any other
    // value, including one a later client adds, refuses there and never stops discovery.
    rateLimitReachedType: z.string().max(64).nullish(),
  })
  .transform(
    ({ limitId, primary, secondary, credits, spendControlReached, rateLimitReachedType }) => ({
      limitId: limitId ?? null,
      primary: primary ?? null,
      secondary: secondary ?? null,
      credits: !credits
        ? ('unknown' as const)
        : credits.unlimited
          ? ('unlimited' as const)
          : credits.hasCredits
            ? ('available' as const)
            : ('none' as const),
      creditBalance: credits?.balance ?? null,
      spendControlReached: spendControlReached ?? null,
      rateLimitReachedType: rateLimitReachedType ?? null,
    }),
  );
const limits = z
  .object({
    ordinaryUsageAllowed: z
      .boolean()
      .nullish()
      .transform((value) => value ?? null),
    rateLimits: bucket,
    rateLimitsByLimitId: z
      .record(id, bucket)
      .refine((value) => Object.keys(value).length <= 32)
      .nullish()
      .transform((value) => value ?? null),
    rateLimitResetCredits: z
      .object({ availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
      .nullish(),
  })
  .transform(({ rateLimitResetCredits, ...limits }) => ({
    ...limits,
    availableResetCount: rateLimitResetCredits?.availableCount ?? null,
  }));

export type OpenAiUsageWindow = Omit<Observation, 'routeId' | 'observedAt'>;
export type OpenAiCredits = Readonly<{
  limitId: string;
  state: 'available' | 'unlimited' | 'none';
  balance: string | null;
}>;
export type OpenAiUsage = Readonly<{
  complete: boolean;
  windows: readonly OpenAiUsageWindow[];
  credits: readonly OpenAiCredits[];
}>;
/** Runs synchronously on arrival, so the receiver's clock at call time is the receive time. */
export type OpenAiUsageHook = (usage: OpenAiUsage) => void;
type UsageMethod = 'account/rateLimits/read' | 'account/rateLimits/updated';
export type UsageReporter = (method: UsageMethod, payload: unknown) => void;

// The limit ID becomes part of a stored key and a visible label, so it stays short and plain.
const usageLimitId = /^[A-Za-z0-9._-]{1,64}$/;
// Usage reads the wire bounds. Admission keeps its own stricter window schema above.
const usageWindowValue = z
  .object({
    // An i32 on the wire. Above 100 means the window is over its limit.
    usedPercent: z.number().int().min(0).max(2_147_483_647),
    // The contract caps a period at one year.
    windowDurationMins: z.number().int().positive().max(525_600).nullable(),
    // 9999-12-31T23:59:59Z. Later instants have no ISO form the contract accepts.
    resetsAt: z.number().int().nonnegative().max(253_402_300_799).nullable(),
  })
  .nullish();
const usageBucket = z.object({
  limitId: id.nullish(),
  primary: usageWindowValue,
  secondary: usageWindowValue,
  credits: creditSnapshot,
});
const usagePayload = {
  'account/rateLimits/read': z.object({
    rateLimits: usageBucket,
    // Two windows per bucket keep a complete read within one 32-window batch.
    rateLimitsByLimitId: z
      .record(id, usageBucket)
      .refine((value) => Object.keys(value).length <= 16)
      .nullish(),
  }),
  'account/rateLimits/updated': z.object({ rateLimits: usageBucket }),
};
const compareKeys = ([left]: [string, unknown], [right]: [string, unknown]) =>
  left < right ? -1 : left > right ? 1 : 0;

function usageWindow(
  windowId: string,
  value: NonNullable<z.output<typeof usageWindowValue>>,
): OpenAiUsageWindow {
  const periodSeconds = value.windowDurationMins === null ? null : value.windowDurationMins * 60;
  return {
    windowId,
    // The contract requires a kind. Only an exact seven-day duration is called weekly.
    kind: periodSeconds === 604_800 ? 'weekly' : 'rolling',
    ...(periodSeconds === null ? {} : { semantics: { scope: 'provider' as const, periodSeconds } }),
    // An over-limit window has nothing left. It stays visible as exhausted.
    remaining: { value: 100 - Math.min(value.usedPercent, 100), unit: 'percent' },
    resetsAt: value.resetsAt === null ? null : new Date(value.resetsAt * 1000).toISOString(),
    source: 'client',
    confidence: 'reported',
  };
}

/**
 * Maps one rate-limit read or update to client windows, without routes or observation time.
 * A window ID joins the bucket's own limit ID and the field that carried the window, as
 * `${limitId}:primary` or `${limitId}:secondary`. usedPercent is an integer percent,
 * windowDurationMins is minutes and resetsAt is Unix seconds. Only a read with
 * rateLimitsByLimitId lists every bucket. The legacy rateLimits view in that read mirrors one
 * entry and is skipped. An update is sparse by protocol, and a null window there means not
 * reported. Credit balances stay separate.
 */
export function projectOpenAiUsage(method: UsageMethod, payload: unknown): OpenAiUsage {
  const parsed = usagePayload[method].parse(payload);
  const listed = 'rateLimitsByLimitId' in parsed ? (parsed.rateLimitsByLimitId ?? null) : null;
  const single = parsed.rateLimits;
  // A sparse view without a limit ID has no identity to store a window under.
  const buckets: [string, typeof single][] = listed
    ? Object.entries(listed)
    : single.limitId == null
      ? []
      : [[single.limitId, single]];
  let complete = listed !== null;
  const windows: OpenAiUsageWindow[] = [];
  const credits: OpenAiCredits[] = [];
  for (const [limitId, value] of buckets.sort(compareKeys)) {
    // A bucket without a usable identity is dropped, so the read no longer lists every bucket.
    if (!usageLimitId.test(limitId) || (value.limitId != null && value.limitId !== limitId)) {
      complete = false;
      continue;
    }
    if (value.primary) windows.push(usageWindow(`${limitId}:primary`, value.primary));
    if (value.secondary) windows.push(usageWindow(`${limitId}:secondary`, value.secondary));
    if (value.credits)
      credits.push({
        limitId,
        state: value.credits.unlimited
          ? 'unlimited'
          : value.credits.hasCredits
            ? 'available'
            : 'none',
        balance: value.credits.balance ?? null,
      });
  }
  return { complete, windows, credits };
}

/**
 * One reporter per client process. A read hands on every window it lists. A null duration or
 * reset in an update keeps the value reported before, as the protocol asks clients to merge. The
 * receiver drops a repeat only after it accepted the first copy, so a refused report can return.
 * Usage is advisory. A refused payload or a failing hook never changes the transcript.
 */
export function openAiUsageReporter(hook: OpenAiUsageHook | undefined): UsageReporter {
  const reported = new Map<string, OpenAiUsageWindow>();
  return (method, payload) => {
    if (!hook) return;
    try {
      const usage = projectOpenAiUsage(method, payload);
      if (usage.complete) reported.clear();
      const windows = usage.windows.map((window) => {
        const previous =
          method === 'account/rateLimits/updated' ? reported.get(window.windowId) : undefined;
        const merged: OpenAiUsageWindow = previous
          ? {
              ...window,
              ...(window.semantics || !previous.semantics
                ? {}
                : { kind: previous.kind, semantics: previous.semantics }),
              resetsAt: window.resetsAt ?? previous.resetsAt,
            }
          : window;
        reported.set(window.windowId, merged);
        return merged;
      });
      if (windows.length) hook({ ...usage, windows });
    } catch {
      // Older windows keep their own times. The next read or update can replace them.
    }
  };
}

// shortcut: the conversation catalog contract holds at most 20 models, so a read keeps 20. The
// client sorts hidden models in among the listed ones, so with hidden models a full first page can
// push a listed model off it. Only then does the read take one more page, and listed models come
// first in what it keeps. Upgrade: raise the contract bound and page through model/list.
const models = z
  .object({
    data: z
      .array(
        z
          .object({
            id,
            model: id,
            supportedReasoningEfforts: z.array(z.object({ reasoningEffort: text(32) })).max(16),
            defaultReasoningEffort: text(32),
            hidden: z.boolean().nullish(),
          })
          .transform(({ supportedReasoningEfforts, hidden, ...value }) => ({
            ...value,
            supportedReasoningEfforts: supportedReasoningEfforts.map(
              (entry) => entry.reasoningEffort,
            ),
            ...(hidden ? { hidden: true as const } : {}),
          })),
      )
      .max(20),
    nextCursor: text(200).nullish(),
  })
  .refine(
    (catalog) =>
      new Set(catalog.data.map((entry) => entry.id)).size === catalog.data.length &&
      ConversationModelCatalogEntriesSchema.safeParse(
        catalog.data.map((entry) => ({
          model: entry.model,
          efforts: entry.supportedReasoningEfforts,
          defaultEffort: entry.defaultReasoningEffort,
        })),
      ).success,
    'A model catalog needs distinct bounded identifiers and supported efforts.',
  );

const configuration = z
  .object({
    config: z.object({
      model_provider: z.literal('openai'),
      service_tier: z.literal('default'),
      approval_policy: z.literal('on-request'),
      approvals_reviewer: z.literal('user'),
      sandbox_mode: z.literal('read-only'),
      web_search: z.literal('disabled'),
      chatgpt_base_url: z.literal('https://chatgpt.com/backend-api/'),
      openai_base_url: z.literal(''),
      features: z.object({
        plugins: z.literal(false),
        remote_plugin: z.literal(false),
        apps: z.literal(false),
        hooks: z.literal(false),
        multi_agent: z.literal(false),
      }),
    }),
  })
  .transform(({ config: { chatgpt_base_url: _chatgpt, openai_base_url: _openai, ...config } }) => ({
    ...config,
    endpoints: 'official' as const,
  }));
const mcpConfiguration = z
  .object({
    config: z.object({
      mcp_servers: z
        .record(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), z.object({ enabled: z.boolean() }))
        .refine((servers) => Object.keys(servers).length <= 128),
    }),
  })
  .transform(({ config }) =>
    Object.fromEntries(
      Object.entries(config.mcp_servers).map(([name, server]) => [name, server.enabled]),
    ),
  );
const requirements = z
  .object({
    requirements: z
      .object({
        modelProvider: z.literal('openai').nullish(),
        modelProviders: z
          .record(text(200), z.unknown())
          .nullish()
          .refine((value) => !value || Object.keys(value).length === 0),
        chatgptBaseUrl: z.literal('https://chatgpt.com/backend-api/').nullish(),
        featureRequirements: z
          .record(text(200), z.boolean())
          .nullish()
          .refine(
            (value) =>
              !value ||
              (Object.keys(value).length <= 128 &&
                Object.values(value).every((enabled) => !enabled)),
          ),
        hooks: z.null().nullish(),
      })
      .nullable(),
  })
  .transform(({ requirements }) =>
    requirements === null ? ('absent' as const) : ('compatible' as const),
  );

export type DiscoveryMetadata = {
  platform: z.output<typeof platform>;
  account: z.output<typeof account>;
  limits: z.output<typeof limits>;
  models: z.output<typeof models>['data'];
  configuration?: z.output<typeof configuration>;
  requirements?: z.output<typeof requirements>;
  mcpServers?: z.output<typeof mcpConfiguration>;
};
export type DiscoveryRequest =
  | 'features-list'
  | 'initialize'
  | 'account/read'
  | 'config/read'
  | 'configRequirements/read'
  | 'account/rateLimits/read'
  | 'model/list'
  | 'complete';
type Failure =
  | 'invalid-message'
  | 'unexpected-message'
  | 'authority-notice'
  | 'upstream-error'
  | 'limit'
  | 'deadline'
  | 'incomplete'
  | 'unsupported-account';

export class DiscoveryError extends Error {
  readonly reason: Failure;
  constructor(reason: Failure) {
    super(`Provider discovery stopped: ${reason}.`);
    this.name = 'DiscoveryError';
    this.reason = reason;
  }
}

/** A fixed metadata transcript. Completion says nothing about billing or process ownership. */
export class OpenAiDiscovery {
  private readonly now: () => number;
  private readonly deadline: number;
  private step = 0;
  private awaiting = false;
  private received = 0;
  private pending: number[] = [];
  private frameRequest: number | null = null;
  private envelope: DiscoveryEnvelope = null;
  private refused: RefusedEnvelope | null = null;
  private notificationCount = 0;
  private failed: Failure | null = null;
  private platform?: DiscoveryMetadata['platform'];
  private account?: DiscoveryMetadata['account'];
  private limits?: DiscoveryMetadata['limits'];
  private models?: DiscoveryMetadata['models'];
  private configuration?: DiscoveryMetadata['configuration'];
  private readonly readConfiguration: boolean;
  private readonly readMcpConfiguration: boolean;
  private mcpServers?: DiscoveryMetadata['mcpServers'];
  private configurationRequested = false;
  private requirementsRequested = false;
  private requirements?: DiscoveryMetadata['requirements'];
  private readonly configurationDirectory?: string;
  private readonly includeHidden: boolean;
  private readonly modelPages: DiscoveryMetadata['models'][] = [];
  // Set once a full first page with hidden models names a next page.
  private modelCursor: string | null = null;
  // One reporter per client process. Transcripts send their sparse updates through it too, so
  // an update merges with this process's read.
  readonly reportUsage: UsageReporter;

  constructor(options: {
    now: () => number;
    timeoutMs: number;
    readConfiguration?: boolean;
    readMcpConfiguration?: boolean;
    configurationDirectory?: string;
    onUsage?: OpenAiUsageHook;
    /** List the models the client keeps out of its picker, flagged hidden. */
    includeHidden?: boolean;
  }) {
    this.now = options.now;
    this.reportUsage = openAiUsageReporter(options.onUsage);
    const start = this.now();
    if (
      !Number.isFinite(start) ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 60_000
    )
      throw new DiscoveryError('deadline');
    this.deadline = start + options.timeoutMs;
    this.readConfiguration = options.readConfiguration ?? false;
    this.readMcpConfiguration = options.readMcpConfiguration ?? false;
    if (this.readMcpConfiguration && !this.readConfiguration)
      throw new DiscoveryError('invalid-message');
    this.configurationDirectory = options.configurationDirectory;
    if (this.readConfiguration && !text(4096).safeParse(this.configurationDirectory).success)
      throw new DiscoveryError('invalid-message');
    this.includeHidden = options.includeHidden ?? false;
  }

  private fail(reason: Failure): never {
    this.failed = reason;
    this.pending = [];
    throw new DiscoveryError(reason);
  }

  private check() {
    if (this.failed) throw new DiscoveryError(this.failed);
    const now = this.now();
    if (!Number.isFinite(now) || now >= this.deadline) this.fail('deadline');
  }

  next(): Uint8Array | null {
    this.check();
    if (this.awaiting || this.pending.length || this.step === STEPS) return null;
    if (this.readConfiguration && this.step === 2 && !this.configuration) {
      this.configurationRequested = true;
      this.awaiting = true;
      return new TextEncoder().encode(
        `${JSON.stringify(outgoing.parse({ id: 5, method: 'config/read', params: { includeLayers: false, cwd: this.configurationDirectory } }))}\n`,
      );
    }
    if (this.readConfiguration && this.step === 2 && !this.requirements) {
      this.requirementsRequested = true;
      this.awaiting = true;
      return new TextEncoder().encode(
        `${JSON.stringify(outgoing.parse({ id: 6, method: 'configRequirements/read' }))}\n`,
      );
    }
    const cursor = this.modelCursor;
    const messages = (
      this.step === requests.length
        ? [
            {
              id: cursor ? 7 : 4,
              method: 'model/list',
              params: {
                limit: 20,
                includeHidden: this.includeHidden,
                ...(cursor ? { cursor } : {}),
              },
            },
          ]
        : requests[this.step]
    ).map((message) => outgoing.parse(message));
    this.awaiting = true;
    return new TextEncoder().encode(
      `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    );
  }

  push(bytes: Uint8Array) {
    this.check();
    this.received += bytes.byteLength;
    if (this.received > MAX_TOTAL_BYTES) this.fail('limit');
    for (const byte of bytes) {
      if (this.pending.length === 0) {
        if (this.step === 0 && !this.awaiting) this.fail('unexpected-message');
        this.frameRequest = this.awaiting ? this.expectedId() : null;
      }
      if (byte !== 10) {
        if (this.pending.length === MAX_LINE_BYTES) this.fail('limit');
        this.pending.push(byte);
        continue;
      }
      let diagnostic = refusedEnvelope(undefined, true);
      try {
        const line = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(this.pending));
        this.pending = [];
        this.envelope = 'invalid';
        const decoded: unknown = JSON.parse(line);
        diagnostic = refusedEnvelope(decoded);
        if (decoded !== null && typeof decoded === 'object' && 'method' in decoded) {
          const value = notification.parse(decoded);
          if (value.method === 'remoteControl/status/changed') remoteControl.parse(decoded);
          else if (value.method !== 'account/updated' && authorityNotice(value.method))
            this.fail('authority-notice');
          if (this.step === 0) this.fail('unexpected-message');
          this.envelope =
            value.method === 'configWarning'
              ? 'config-warning'
              : value.method === 'account/updated'
                ? 'account-updated'
                : value.method === 'remoteControl/status/changed'
                  ? 'remote-control-status'
                  : 'notification';
          if (++this.notificationCount > 32) this.fail('limit');
          continue;
        }
        const value = response.parse(decoded);
        this.envelope = 'error' in value ? 'error' : 'response';
        // A response begun between requests cannot acquire authority from a later request.
        if (
          !this.awaiting ||
          this.frameRequest === null ||
          value.id !== this.frameRequest ||
          value.id !== this.expectedId()
        )
          this.fail('unexpected-message');
        if ('error' in value) this.fail('upstream-error');
        if (this.requirementsRequested) {
          this.requirements = requirements.parse(value.result);
          this.requirementsRequested = false;
          this.awaiting = false;
          continue;
        }
        if (this.configurationRequested) {
          this.configuration = configuration.parse(value.result);
          if (this.readMcpConfiguration) this.mcpServers = mcpConfiguration.parse(value.result);
          this.configurationRequested = false;
          this.awaiting = false;
          continue;
        }
        switch (this.step) {
          case 0:
            this.platform = platform.parse(value.result);
            break;
          case 1:
            this.account = account.parse(value.result);
            if (this.account.type !== 'chatgpt' || !this.account.requiresOpenaiAuth)
              this.fail('unsupported-account');
            break;
          case 2:
            // Usage reads first, so an over-limit window still shows when admission refuses it.
            this.reportUsage('account/rateLimits/read', value.result);
            this.limits = limits.parse(value.result);
            break;
          case 3: {
            const page = models.parse(value.result);
            this.modelPages.push(page.data);
            if (
              this.includeHidden &&
              !this.modelCursor &&
              page.data.length === 20 &&
              page.nextCursor
            ) {
              this.modelCursor = page.nextCursor;
              this.awaiting = false;
              continue;
            }
            const all = this.modelPages.flat();
            if (
              new Set(all.map((entry) => entry.id)).size !== all.length ||
              new Set(all.map((entry) => entry.model)).size !== all.length
            )
              this.fail('invalid-message');
            this.models = [
              ...all.filter((entry) => !entry.hidden),
              ...all.filter((entry) => entry.hidden),
            ].slice(0, 20);
            break;
          }
        }
        this.awaiting = false;
        this.step++;
      } catch (error) {
        this.refused = diagnostic;
        if (error instanceof DiscoveryError) throw error;
        this.fail('invalid-message');
      }
    }
  }

  finish(): DiscoveryMetadata {
    this.check();
    if (
      this.pending.length ||
      this.step !== STEPS ||
      !this.platform ||
      !this.account ||
      !this.limits ||
      !this.models ||
      (this.readConfiguration && !this.configuration) ||
      (this.readConfiguration && !this.requirements)
    )
      this.fail('incomplete');
    return {
      platform: this.platform,
      account: this.account,
      limits: this.limits,
      models: this.models,
      ...(this.configuration ? { configuration: this.configuration } : {}),
      ...(this.requirements ? { requirements: this.requirements } : {}),
      ...(this.mcpServers ? { mcpServers: this.mcpServers } : {}),
    };
  }

  private expectedId(): number {
    if (this.configurationRequested) return 5;
    if (this.requirementsRequested) return 6;
    return this.step === requests.length && this.modelCursor ? 7 : this.step + 1;
  }

  get lastEnvelope(): DiscoveryEnvelope {
    return this.envelope;
  }

  get refusedEnvelope(): RefusedEnvelope | null {
    return this.refused;
  }

  get notifications(): number {
    return this.notificationCount;
  }

  get complete(): boolean {
    return this.step === STEPS && this.failed === null && this.pending.length === 0;
  }

  get pendingRequest(): DiscoveryRequest {
    if (this.step === 0) return 'initialize';
    if (this.step === 1) return 'account/read';
    if (this.step === 2) {
      if (this.readConfiguration && !this.configuration) return 'config/read';
      if (this.readConfiguration && !this.requirements) return 'configRequirements/read';
      return 'account/rateLimits/read';
    }
    return this.step === 3 ? 'model/list' : 'complete';
  }
}
