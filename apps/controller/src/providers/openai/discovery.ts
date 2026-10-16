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
    credits: z.object({ hasCredits: z.boolean(), unlimited: z.boolean() }).nullish(),
  })
  .transform(({ limitId, primary, secondary, credits }) => ({
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
  }));
const limits = z.object({
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
});
const models = z.object({
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
});

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
  private failed: Failure | null = null;
  private platform?: DiscoveryMetadata['platform'];
  private account?: DiscoveryMetadata['account'];
  private limits?: DiscoveryMetadata['limits'];
  private models?: DiscoveryMetadata['models'];
  private configuration?: DiscoveryMetadata['configuration'];
  private readonly readConfiguration: boolean;
  private configurationRequested = false;
  private requirementsRequested = false;
  private requirements?: DiscoveryMetadata['requirements'];
  private readonly configurationDirectory?: string;

  constructor(options: {
    now: () => number;
    timeoutMs: number;
    readConfiguration?: boolean;
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
    if (this.awaiting || this.step === requests.length) return null;
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
      if (!this.awaiting) this.fail('unexpected-message');
      if (byte !== 10) {
        if (this.pending.length === MAX_LINE_BYTES) this.fail('limit');
        this.pending.push(byte);
        continue;
      }
      try {
        const line = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(this.pending));
        this.pending = [];
        const value = response.parse(JSON.parse(line));
        const expectedId = this.configurationRequested
          ? 5
          : this.requirementsRequested
            ? 6
            : this.step + 1;
        if (!this.awaiting || value.id !== expectedId) this.fail('unexpected-message');
        if ('error' in value) this.fail('upstream-error');
        if (this.requirementsRequested) {
          this.requirements = requirements.parse(value.result);
          this.requirementsRequested = false;
          this.awaiting = false;
          continue;
        }
        if (this.configurationRequested) {
          this.configuration = configuration.parse(value.result);
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
    };
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
