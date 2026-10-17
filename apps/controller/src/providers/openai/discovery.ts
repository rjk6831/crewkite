import { ConversationModelCatalogEntriesSchema } from '@crewkite/contracts';
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
    id: z.literal(4),
    method: z.literal('model/list'),
    params: z.strictObject({ limit: z.literal(20), includeHidden: z.literal(false) }),
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
  [{ id: 4, method: 'model/list', params: { limit: 20, includeHidden: false } }],
];
const response = z.union([
  z.strictObject({ id: z.number().int().min(1).max(6), result: z.unknown() }),
  z.strictObject({ id: z.number().int().min(1).max(6), error: z.unknown() }),
]);

const position = z.strictObject({
  line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  column: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const emittedAtMs = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .optional();
const notification = z.union([
  z.strictObject({
    method: z.literal('configWarning'),
    emittedAtMs,
    params: z.strictObject({
      summary: z.string().max(4096),
      details: z.string().max(16_384).nullable(),
      path: z.string().max(4096).optional(),
      range: z.strictObject({ start: position, end: position }).optional(),
    }),
  }),
  z.strictObject({
    method: z.literal('account/updated'),
    emittedAtMs,
    params: z.strictObject({
      authMode: z
        .enum([
          'apikey',
          'chatgpt',
          'chatgptAuthTokens',
          'headers',
          'agentIdentity',
          'personalAccessToken',
          'bedrockApiKey',
          'bedrockAccessKeys',
        ])
        .nullable(),
      planType: z
        .enum([
          'free',
          'go',
          'plus',
          'pro',
          'prolite',
          'promax',
          'team',
          'self_serve_business_prolite',
          'self_serve_business_usage_based',
          'business',
          'ent26',
          'enterprise_cbp_automation',
          'enterprise_cbp_usage_based',
          'enterprise',
          'edu',
          'edu_plus',
          'edu_pro',
          'unknown',
        ])
        .nullable(),
    }),
  }),
  z.strictObject({
    method: z.literal('remoteControl/status/changed'),
    emittedAtMs,
    params: z.strictObject({
      status: z.literal('disabled'),
      serverName: z.string().max(4096),
      installationId: z.string().max(4096),
      environmentId: z.string().max(4096).nullable(),
    }),
  }),
]);
export type DiscoveryEnvelope =
  | 'response'
  | 'error'
  | 'config-warning'
  | 'account-updated'
  | 'remote-control-status'
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
const bucket = z
  .object({
    limitId: id.nullish(),
    primary: window.optional(),
    secondary: window.optional(),
    credits: z
      .object({
        hasCredits: z.boolean(),
        unlimited: z.boolean(),
        balance: z
          .string()
          .max(128)
          .regex(/^-?\d+(?:\.\d+)?$/)
          .nullish(),
      })
      .nullish(),
    spendControlReached: z.boolean().nullish(),
    rateLimitReachedType: z
      .enum([
        'rate_limit_reached',
        'workspace_owner_credits_depleted',
        'workspace_member_credits_depleted',
        'workspace_owner_usage_limit_reached',
        'workspace_member_usage_limit_reached',
      ])
      .nullish(),
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
          })
          .transform(({ supportedReasoningEfforts, ...value }) => ({
            ...value,
            supportedReasoningEfforts: supportedReasoningEfforts.map(
              (entry) => entry.reasoningEffort,
            ),
          })),
      )
      .max(20),
    nextCursor: text(256).nullable(),
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
    'A complete model catalog needs distinct bounded identifiers and supported efforts.',
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
  | 'upstream-error'
  | 'limit'
  | 'deadline'
  | 'incomplete'
  | 'catalog-incomplete'
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

  constructor(options: {
    now: () => number;
    timeoutMs: number;
    readConfiguration?: boolean;
    readMcpConfiguration?: boolean;
    configurationDirectory?: string;
  }) {
    this.now = options.now;
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
    if (this.awaiting || this.pending.length || this.step === requests.length) return null;
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
    const messages = requests[this.step].map((message) => outgoing.parse(message));
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
          if (this.step === 0) this.fail('unexpected-message');
          this.envelope =
            value.method === 'configWarning'
              ? 'config-warning'
              : value.method === 'account/updated'
                ? 'account-updated'
                : 'remote-control-status';
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
            this.limits = limits.parse(value.result);
            break;
          case 3: {
            const catalog = models.parse(value.result);
            if (catalog.nextCursor !== null) this.fail('catalog-incomplete');
            this.models = catalog.data;
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
      this.step !== requests.length ||
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
    return this.configurationRequested ? 5 : this.requirementsRequested ? 6 : this.step + 1;
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
    return this.step === requests.length && this.failed === null && this.pending.length === 0;
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
