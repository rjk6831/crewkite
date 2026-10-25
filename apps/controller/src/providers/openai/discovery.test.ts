import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservationSchema } from '@crewkite/contracts';
import {
  DiscoveryError,
  OpenAiDiscovery,
  type OpenAiUsage,
  openAiUsageReporter,
  projectOpenAiUsage,
  type RefusedEnvelope,
} from './discovery.ts';

const privateText = 'private-token-email@example.test';
const catalog = () => ({
  data: [
    {
      id: 'native-model',
      model: 'native-model',
      description: privateText,
      displayName: `${privateText}é`,
      supportedReasoningEfforts: [{ reasoningEffort: 'native-effort', description: privateText }],
      defaultReasoningEffort: 'native-effort',
    },
  ],
  nextCursor: null,
});
const results = (): unknown[] => [
  {
    userAgent: privateText,
    codexHome: `/private/${privateText}`,
    platformFamily: 'unix',
    platformOs: 'macos',
  },
  {
    account: { type: 'chatgpt', email: privateText, planType: 'pro' },
    requiresOpenaiAuth: true,
    token: privateText,
  },
  {
    ordinaryUsageAllowed: true,
    accountId: privateText,
    rateLimitUpsell: { message: privateText },
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: null, private: privateText },
    },
    rateLimitsByLimitId: null,
  },
  catalog(),
];
const line = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
type Scenario = {
  name: string;
  change?: (values: ReturnType<typeof results>) => unknown[];
  wire?: (value: unknown, index: number) => Uint8Array;
  before?: Uint8Array;
  whole?: boolean;
  afterResponse?: boolean;
  unboundPartial?: boolean;
  notices?: unknown[];
  fragmentedNotice?: boolean;
  pendingNotice?: boolean;
  refusal?: {
    kind: RefusedEnvelope['kind'];
    fields?: Partial<RefusedEnvelope['fields']>;
    extraParamsFields?: boolean;
  };
  deadline?: boolean;
  timeoutMs?: number;
  incomplete?: boolean;
  reason?: DiscoveryError['reason'];
  check?: (value: ReturnType<OpenAiDiscovery['finish']>) => void;
  configuration?: Record<string, unknown>;
  requirements?: unknown;
  usage?: OpenAiUsage[];
  includeHidden?: boolean;
};

test('provider discovery emits only correlated metadata and excludes private fields', () => {
  const scenarios: Scenario[] = [
    { name: 'fragmented transcript retains exact native model and effort' },
    {
      name: 'the rate-limit read reaches a usage hook passed in prepared options',
      usage: [
        {
          complete: false,
          windows: [
            {
              windowId: 'codex:primary',
              kind: 'rolling',
              semantics: { scope: 'provider', periodSeconds: 18000 },
              remaining: { value: 75, unit: 'percent' },
              resetsAt: '2027-01-15T08:00:00.000Z',
              source: 'client',
              confidence: 'reported',
            },
          ],
          credits: [{ limitId: 'codex', state: 'none', balance: null }],
        },
      ],
    },
    { name: 'sixty-second metadata bound is accepted', timeoutMs: 60_000 },
    ...[false, true].map(
      (fragmentedNotice): Scenario => ({
        name: fragmentedNotice
          ? 'fragmented startup notices block the next request'
          : 'coalesced startup notices carry no authority',
        fragmentedNotice,
        notices: [
          {
            method: 'configWarning',
            ...(fragmentedNotice ? {} : { emittedAtMs: 1234 }),
            params: {
              summary: privateText,
              details: privateText,
              path: privateText,
              range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
            },
          },
          {
            method: 'account/updated',
            emittedAtMs: -1,
            params: { authMode: null, planType: null },
          },
          {
            method: 'remoteControl/status/changed',
            emittedAtMs: 1234,
            params: {
              status: 'disabled',
              serverName: privateText,
              installationId: privateText,
              environmentId: null,
            },
          },
        ],
      }),
    ),
    {
      name: 'account notice does not complete outstanding account request',
      pendingNotice: true,
      reason: 'incomplete',
    },
    {
      // Discovery reads only the remote control status, so a method, field or value a later
      // client adds passes.
      name: 'a notice passes whatever method, fields or values it carries',
      notices: [
        { method: 'warning', params: { message: privateText } },
        { method: 'unknown/private-method', emittedAtMs: 1.5, params: { secret: privateText } },
        { method: 'configWarning', params: { summary: privateText, details: 7, extra: true } },
        { method: 'account/updated', params: { authMode: 'future-auth', planType: 'sci' } },
        {
          method: 'remoteControl/status/changed',
          params: { status: 'disabled', serverName: privateText, extra: privateText },
        },
      ],
    },
    {
      name: 'remote control that is not disabled stops metadata',
      notices: [
        {
          method: 'remoteControl/status/changed',
          params: {
            status: 'connecting',
            serverName: privateText,
            installationId: privateText,
            environmentId: null,
          },
        },
      ],
      reason: 'invalid-message',
    },
    {
      // A task's metadata phase runs through discovery, so a notice the task transcript refuses
      // stops it here too.
      name: 'a notice that carries authority stops metadata',
      notices: [{ method: 'hook/started', params: { threadId: privateText } }],
      reason: 'authority-notice',
    },
    {
      name: 'known notification cannot precede initialize response',
      wire: () =>
        line({ method: 'configWarning', params: { summary: privateText, details: null } }),
      reason: 'unexpected-message',
    },
    ...[
      {
        params: { summary: privateText, details: 7 },
        fields: { details: 'number' as const },
        extraParamsFields: false,
      },
      {
        params: { summary: privateText, 'private-field-name': privateText },
        fields: { details: 'missing' as const },
        extraParamsFields: true,
      },
    ].map(
      ({ params, fields, extraParamsFields }): Scenario => ({
        name: 'refused server request reveals only fixed field kinds',
        notices: [{ id: 7, method: 'configWarning', params }],
        reason: 'invalid-message',
        refusal: { kind: 'config-warning', fields, extraParamsFields },
      }),
    ),
    {
      name: 'startup notice count is bounded',
      notices: Array(33).fill({
        method: 'configWarning',
        params: { summary: privateText, details: null },
      }),
      reason: 'limit',
    },
    ...[false, true].map(
      (mismatch): Scenario => ({
        name: mismatch
          ? 'effective configuration mismatch stops metadata'
          : 'effective configuration is projected',
        configuration: {
          model_provider: mismatch ? 'gateway' : 'openai',
          openai_base_url: '',
          chatgpt_base_url: 'https://chatgpt.com/backend-api/',
          model_providers: { openai: { ignored: privateText } },
          features: {
            plugins: false,
            remote_plugin: false,
            apps: false,
            hooks: false,
            multi_agent: false,
          },
          service_tier: 'default',
          approval_policy: 'on-request',
          approvals_reviewer: 'user',
          sandbox_mode: 'read-only',
          web_search: 'disabled',
          secret: privateText,
        },
        ...(mismatch ? { reason: 'invalid-message' as const } : {}),
        check: (value) => assert.equal(value.configuration?.model_provider, 'openai'),
      }),
    ),
    ...[
      { chatgpt_base_url: 'https://gateway.invalid' },
      { openai_base_url: 'https://gateway.invalid' },
    ].map(
      (override): Scenario => ({
        name: 'effective endpoint override refuses further metadata',
        configuration: {
          model_provider: 'openai',
          openai_base_url: '',
          chatgpt_base_url: 'https://chatgpt.com/backend-api/',
          features: {
            plugins: false,
            remote_plugin: false,
            apps: false,
            hooks: false,
            multi_agent: false,
          },
          service_tier: 'default',
          approval_policy: 'on-request',
          approvals_reviewer: 'user',
          sandbox_mode: 'read-only',
          web_search: 'disabled',
          ...override,
        },
        reason: 'invalid-message',
      }),
    ),
    {
      name: 'changed managed startup policy refuses allowance requests',
      configuration: {
        model_provider: 'openai',
        openai_base_url: '',
        chatgpt_base_url: 'https://chatgpt.com/backend-api/',
        service_tier: 'default',
        approval_policy: 'on-request',
        approvals_reviewer: 'user',
        sandbox_mode: 'read-only',
        web_search: 'disabled',
        features: {
          plugins: false,
          remote_plugin: false,
          apps: false,
          hooks: false,
          multi_agent: false,
        },
      },
      requirements: { requirements: { featureRequirements: { plugins: true } } },
      reason: 'invalid-message',
    },
    {
      name: 'missing allowance stays unknown',
      change: (values) => {
        values[2] = { rateLimits: {} };
        return values;
      },
      check: (value) => {
        assert.equal(value.limits.ordinaryUsageAllowed, null);
        assert.equal(value.limits.rateLimits.primary, null);
        assert.equal(value.limits.rateLimits.credits, 'unknown');
        assert.equal(value.limits.rateLimits.creditBalance, null);
        assert.equal(value.limits.rateLimits.spendControlReached, null);
        assert.equal(value.limits.rateLimits.rateLimitReachedType, null);
        assert.equal(value.limits.availableResetCount, null);
      },
    },
    {
      name: 'unknown ChatGPT plan stays unknown',
      change: (values) => {
        values[1] = {
          account: { type: 'chatgpt', planType: 'future-plan' },
          requiresOpenaiAuth: true,
        };
        return values;
      },
      check: (value) => assert.equal(value.account.plan, 'unknown'),
    },
    ...[null, { type: 'apiKey' }, { type: 'amazonBedrock' }, { type: 'future-auth' }].map(
      (account): Scenario => ({
        name: `unsupported account ${account?.type ?? 'none'} stops before more requests`,
        change: (values) => {
          values[1] = { account, requiresOpenaiAuth: true };
          return values;
        },
        reason: 'unsupported-account',
      }),
    ),
    {
      name: 'non-OpenAI provider context stops before more requests',
      change: (values) => {
        values[1] = { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: false };
        return values;
      },
      reason: 'unsupported-account',
    },
    ...[undefined, null, '1234.5678900000', '-0.125'].map(
      (balance): Scenario => ({
        name: 'credit balances retain decimal precision and unknowns without private fields',
        change: (values) => {
          values[2] = {
            rateLimits: {
              limitId: 'codex',
              credits: { hasCredits: true, unlimited: true, balance, private: privateText },
              spendControlReached: false,
              rateLimitReachedType: 'rate_limit_reached',
            },
            rateLimitResetCredits: {
              availableCount: 1,
              credits: [{ id: privateText, title: privateText, expiresAt: 1800000000 }],
            },
          };
          return values;
        },
        check: (value) => {
          assert.equal(value.limits.ordinaryUsageAllowed, null);
          assert.equal(value.limits.rateLimits.credits, 'unlimited');
          assert.equal(value.limits.rateLimits.creditBalance, balance ?? null);
          assert.equal(value.limits.rateLimits.spendControlReached, false);
          assert.equal(value.limits.rateLimits.rateLimitReachedType, 'rate_limit_reached');
          assert.equal(value.limits.availableResetCount, 1);
          assert(!JSON.stringify(value.limits).includes('expiresAt'));
        },
      }),
    ),
    {
      // Admission treats any type but rate_limit_reached as a refusal, so a new one is safe to pass.
      name: 'a limit type a later client adds reaches admission',
      change: (values) => {
        values[2] = {
          ordinaryUsageAllowed: false,
          rateLimits: { limitId: 'codex', rateLimitReachedType: 'workspace_future_limit_reached' },
        };
        return values;
      },
      check: (value) =>
        assert.equal(
          value.limits.rateLimits.rateLimitReachedType,
          'workspace_future_limit_reached',
        ),
    },
    ...[null, { availableCount: 0, credits: null }].map(
      (rateLimitResetCredits): Scenario => ({
        name: 'missing reset detail does not turn the reset count into a usage balance',
        change: (values) => {
          values[2] = { rateLimits: {}, rateLimitResetCredits };
          return values;
        },
        check: (value) => {
          assert.equal(value.limits.availableResetCount, rateLimitResetCredits ? 0 : null);
          assert.equal(value.limits.rateLimits.creditBalance, null);
        },
      }),
    ),
    ...[
      { rateLimits: { credits: { hasCredits: true, unlimited: false, balance: privateText } } },
      { rateLimits: { credits: { hasCredits: true, unlimited: false, balance: 1 } } },
      { rateLimits: { credits: { hasCredits: true, unlimited: false, balance: '1'.repeat(129) } } },
      { rateLimits: { spendControlReached: 'false' } },
      { rateLimits: { rateLimitReachedType: 'x'.repeat(65) } },
      { rateLimits: {}, rateLimitResetCredits: { availableCount: -1 } },
      { rateLimits: {}, rateLimitResetCredits: { availableCount: 1.5 } },
      { rateLimits: {}, rateLimitResetCredits: { availableCount: Number.MAX_SAFE_INTEGER + 1 } },
    ].map(
      (result): Scenario => ({
        name: 'malformed credit and reset observations stop metadata',
        change: (values) => {
          values[2] = result;
          return values;
        },
        reason: 'invalid-message',
      }),
    ),
    {
      name: 'reply before request',
      before: line({ id: 1, result: results()[0] }),
      reason: 'unexpected-message',
    },
    {
      name: 'partial reply before request',
      before: new TextEncoder().encode('{"id":1'),
      reason: 'unexpected-message',
    },
    {
      name: 'partial next reply in same chunk',
      unboundPartial: true,
      wire: (value) =>
        new TextEncoder().encode(`${JSON.stringify({ id: 1, result: value })}\n{"id":2`),
      whole: true,
      reason: 'unexpected-message',
    },
    {
      name: 'partial next reply before next request',
      afterResponse: true,
      unboundPartial: true,
      reason: 'unexpected-message',
    },
    {
      name: 'partial reply after final response',
      wire: (value, index) =>
        new TextEncoder().encode(
          `${JSON.stringify({ id: index + 1, result: value })}\n${index === 3 ? '{' : ''}`,
        ),
      whole: true,
      reason: 'incomplete',
    },
    {
      name: 'wrong id',
      wire: (value, index) => line({ id: index === 0 ? 2 : index + 1, result: value }),
      reason: 'unexpected-message',
    },
    {
      name: 'duplicate reply',
      wire: (value, index) => line({ id: index === 1 ? 1 : index + 1, result: value }),
      reason: 'unexpected-message',
    },
    {
      name: 'server auth refresh request',
      wire: () =>
        line({
          id: 1,
          method: 'account/chatgptAuthTokens/refresh',
          params: { accessToken: privateText },
        }),
      reason: 'invalid-message',
    },
    {
      name: 'error body is never echoed',
      wire: () =>
        line({ id: 1, error: { code: 500, message: privateText, data: { token: privateText } } }),
      reason: 'upstream-error',
    },
    {
      name: 'result and error together',
      wire: () => line({ id: 1, result: {}, error: { message: privateText } }),
      reason: 'invalid-message',
    },
    {
      name: 'an envelope field a later client adds passes',
      wire: (value, index) =>
        line({ id: index + 1, result: value, jsonrpc: '2.0', token: privateText }),
    },
    { name: 'wrong result shape', change: () => [privateText], reason: 'invalid-message' },
    {
      name: 'malformed JSON',
      wire: () => new TextEncoder().encode(`{"${privateText}\n`),
      reason: 'invalid-message',
    },
    {
      name: 'invalid UTF-8',
      wire: () => new Uint8Array([0xc3, 0x28, 10]),
      reason: 'invalid-message',
    },
    { name: 'oversized line', wire: () => new Uint8Array(65_537).fill(32), reason: 'limit' },
    { name: 'total byte limit', wire: () => new Uint8Array(1_048_577), reason: 'limit' },
    {
      name: 'truncated reply',
      wire: () => new TextEncoder().encode('{"id":1'),
      reason: 'incomplete',
      incomplete: true,
    },
    { name: 'expired injected deadline', deadline: true, reason: 'deadline' },
    { name: 'partial transcript', change: (values) => values.slice(0, 2), reason: 'incomplete' },
    {
      name: 'a longer catalog keeps the first page the contract holds',
      change: (values) => {
        values[3] = { ...catalog(), nextCursor: '20' };
        return values;
      },
    },
    {
      // Hidden models sort in among listed ones, so a full first page can hide a listed model.
      name: 'a full page with hidden models reads one more and keeps listed models first',
      includeHidden: true,
      change: (values) => {
        values[3] = {
          data: Array.from({ length: 20 }, (_, index) => ({
            ...catalog().data[0],
            id: `legacy-${index}`,
            model: `legacy-${index}`,
            hidden: true,
          })),
          nextCursor: '20',
        };
        values[4] = catalog();
        return values;
      },
      wire: (value, index) => line({ id: index === 4 ? 7 : index + 1, result: value }),
      check: (value) => {
        assert.equal(value.models.length, 20);
        assert.deepEqual(value.models[1].hidden, true);
        assert.equal(value.models[19].model, 'legacy-18');
      },
    },
    {
      name: 'too many models',
      change: (values) => {
        values[3] = { ...catalog(), data: Array(21).fill(catalog().data[0]) };
        return values;
      },
      reason: 'invalid-message',
    },
    ...[
      [],
      [catalog().data[0], catalog().data[0]],
      [{ ...catalog().data[0], supportedReasoningEfforts: [] }],
      [
        {
          ...catalog().data[0],
          supportedReasoningEfforts: Array(17).fill({ reasoningEffort: 'native-effort' }),
        },
      ],
      [
        {
          ...catalog().data[0],
          supportedReasoningEfforts: [
            { reasoningEffort: 'native-effort' },
            { reasoningEffort: 'native-effort' },
          ],
        },
      ],
      [{ ...catalog().data[0], defaultReasoningEffort: 'unadvertised' }],
      [{ ...catalog().data[0], model: 'é'.repeat(101) }],
      [{ ...catalog().data[0], model: 'private\nmodel' }],
      [{ ...catalog().data[0], supportedReasoningEfforts: [{ reasoningEffort: 'é'.repeat(17) }] }],
    ].map(
      (data): Scenario => ({
        name: 'model catalog remains complete, unambiguous and bounded',
        change: (values) => {
          values[3] = { ...catalog(), data };
          return values;
        },
        reason: 'invalid-message',
      }),
    ),
    {
      name: 'nonfinite allowance',
      change: (values) => {
        values[2] = {
          rateLimits: {
            primary: {
              usedPercent: Number.POSITIVE_INFINITY,
              windowDurationMins: null,
              resetsAt: null,
            },
          },
        };
        return values;
      },
      reason: 'invalid-message',
    },
  ];
  for (const scenario of scenarios) {
    let now = 0;
    const usages: OpenAiUsage[] = [];
    const options = {
      now: () => now,
      timeoutMs: scenario.timeoutMs ?? 100,
      readConfiguration: !!scenario.configuration,
      configurationDirectory: '/workspace',
      onUsage: (usage: OpenAiUsage) => usages.push(usage),
      includeHidden: scenario.includeHidden,
    };
    const reader = new OpenAiDiscovery(options);
    const emitted: unknown[] = [];
    try {
      if (scenario.before) reader.push(scenario.before);
      if (scenario.deadline) now = 100;
      const values = scenario.change?.(results()) ?? results();
      for (let index = 0; index < values.length; index++) {
        if (index === 2 && scenario.configuration) {
          const request = reader.next();
          assert(request);
          const message = JSON.parse(new TextDecoder().decode(request));
          assert.deepEqual(message.params, { includeLayers: false, cwd: '/workspace' });
          emitted.push(message);
          reader.push(
            line({
              id: 5,
              result: { config: scenario.configuration, origins: { secret: privateText } },
            }),
          );
          const requirementsRequest = reader.next();
          assert(requirementsRequest);
          const requirementsMessage = JSON.parse(new TextDecoder().decode(requirementsRequest));
          assert.deepEqual(requirementsMessage, { id: 6, method: 'configRequirements/read' });
          emitted.push(requirementsMessage);
          reader.push(line({ id: 6, result: scenario.requirements ?? { requirements: null } }));
        }
        const request = reader.next();
        assert(request, scenario.name);
        emitted.push(
          ...new TextDecoder()
            .decode(request)
            .trim()
            .split('\n')
            .map((value) => JSON.parse(value)),
        );
        if (index === 0)
          assert.deepEqual(
            (emitted[0] as { params: { capabilities: unknown } }).params.capabilities,
            { experimentalApi: false, explicitGatewayOauth: true },
          );
        assert.equal(reader.next(), null, scenario.name);
        if (index === 1 && scenario.pendingNotice) {
          reader.push(
            line({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' } }),
          );
          assert.equal(reader.next(), null);
          assert.equal(reader.pendingRequest, 'account/read');
          assert.throws(() => reader.finish(), { reason: 'incomplete' });
          break;
        }
        const bytes =
          scenario.wire?.(values[index], index) ?? line({ id: index + 1, result: values[index] });
        if (!scenario.whole && bytes.length < 65_537) {
          for (const byte of bytes) reader.push(new Uint8Array([byte]));
        } else reader.push(bytes);
        if (scenario.afterResponse) reader.push(new TextEncoder().encode('{"id":2'));
        if (scenario.unboundPartial) {
          assert.equal(reader.next(), null, scenario.name);
          reader.push(new TextEncoder().encode(',"result":{}}\n'));
        }
        if (index === 0 && scenario.notices) {
          const notices = new TextEncoder().encode(
            `${scenario.notices.map((value) => JSON.stringify(value)).join('\n')}\n`,
          );
          if (scenario.fragmentedNotice) {
            reader.push(notices.subarray(0, 5));
            assert.equal(reader.next(), null);
            reader.push(notices.subarray(5));
          } else reader.push(notices);
          assert.equal(reader.notifications, scenario.notices.length);
          assert.equal(reader.pendingRequest, 'account/read');
        }
        if (scenario.incomplete) break;
      }
      const metadata = reader.finish();
      assert.equal(scenario.reason, undefined, scenario.name);
      assert.equal(reader.refusedEnvelope, null, scenario.name);
      const serialized = JSON.stringify(metadata);
      assert(!serialized.includes(privateText), scenario.name);
      assert(!serialized.includes('qualified') && !serialized.includes('ready'), scenario.name);
      assert.equal(reader.next(), null);
      assert.deepEqual(metadata.models[0], {
        id: 'native-model',
        model: 'native-model',
        supportedReasoningEfforts: ['native-effort'],
        defaultReasoningEffort: 'native-effort',
      });
      scenario.check?.(metadata);
      if (scenario.usage) assert.deepEqual(usages, scenario.usage, scenario.name);
    } catch (error) {
      assert(error instanceof DiscoveryError, scenario.name);
      assert.equal(error.reason, scenario.reason, scenario.name);
      assert(!error.message.includes(privateText), scenario.name);
      const diagnostic = reader.refusedEnvelope;
      const safe = JSON.stringify(diagnostic);
      for (const privateValue of [privateText, 'private-field-name', 'unknown/private-method'])
        assert(!safe.includes(privateValue), scenario.name);
      if (scenario.refusal) {
        assert.equal(diagnostic?.kind, scenario.refusal.kind, scenario.name);
        assert.equal(
          diagnostic?.extraParamsFields,
          scenario.refusal.extraParamsFields,
          scenario.name,
        );
        for (const [field, kind] of Object.entries(scenario.refusal.fields ?? {}))
          assert.equal(
            diagnostic?.fields[field as keyof RefusedEnvelope['fields']],
            kind,
            scenario.name,
          );
      }
      assert.throws(
        () => reader.next(),
        (next) => next instanceof DiscoveryError && next.reason === error.reason,
        scenario.name,
      );
    }
    assert(
      emitted.every((message) =>
        [
          'initialize',
          'initialized',
          'account/read',
          'account/rateLimits/read',
          'model/list',
          'config/read',
          'configRequirements/read',
        ].includes((message as { method: string }).method),
      ),
      scenario.name,
    );
    assert(!JSON.stringify(emitted).includes(privateText), scenario.name);
    if (scenario.reason === 'unsupported-account')
      assert.deepEqual(
        emitted.map((message) => (message as { method: string }).method),
        ['initialize', 'initialized', 'account/read'],
        scenario.name,
      );
    if (!scenario.reason)
      assert.deepEqual(
        emitted.map((message) => (message as { method: string }).method),
        [
          'initialize',
          'initialized',
          'account/read',
          ...(scenario.configuration ? ['config/read', 'configRequirements/read'] : []),
          'account/rateLimits/read',
          'model/list',
          ...(scenario.includeHidden ? ['model/list'] : []),
        ],
      );
    if (scenario.includeHidden)
      assert.deepEqual(
        emitted.flatMap((message) => {
          const { method, params } = message as { method: string; params: unknown };
          return method === 'model/list' ? [params] : [];
        }),
        [
          { limit: 20, includeHidden: true },
          { limit: 20, includeHidden: true, cursor: '20' },
        ],
      );
  }
  assert.throws(() => new OpenAiDiscovery({ now: () => 0, timeoutMs: 60_001 }), {
    name: 'DiscoveryError',
    reason: 'deadline',
  });
});

// The client's wire shape for one bucket. On 16 October 2026 a Pro read reported only the codex
// bucket, with a seven-day primary window at 34 percent used and resetsAt 1792679628.
const weekly = { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1792679628 };
const fiveHour = { usedPercent: 10, windowDurationMins: 300, resetsAt: 1792000000 };
const snapshot = (
  limitId: string | null,
  primary: unknown,
  secondary: unknown = null,
  credits: unknown = null,
) => ({
  limitId,
  limitName: null,
  normalModelSlug: null,
  primary,
  secondary,
  credits,
  individualLimit: null,
  spendControlReached: false,
  planType: 'pro',
  rateLimitReachedType: null,
});
const rateLimitRead = (
  rateLimitsByLimitId: Record<string, unknown> | null,
  rateLimits: unknown = snapshot('codex', weekly),
) => ({
  ordinaryUsageAllowed: true,
  rateLimits,
  rateLimitsByLimitId,
  rateLimitResetCredits: { availableCount: 0, credits: null },
  accountId: privateText,
  rateLimitUpsell: null,
});
const usageRead = (...values: Parameters<typeof rateLimitRead>) =>
  projectOpenAiUsage('account/rateLimits/read', rateLimitRead(...values));
const usageUpdate = (rateLimits: unknown) =>
  projectOpenAiUsage('account/rateLimits/updated', { rateLimits });

test('rate-limit windows become percent readings under their own bucket identity', () => {
  const reading = (windowId: string, kind: string, remaining: number, resetsAt: string | null) => ({
    windowId,
    kind,
    remaining: { value: remaining, unit: 'percent' },
    resetsAt,
    source: 'client',
    confidence: 'reported',
  });
  const reset = '2026-10-22T14:33:48.000Z';
  const provider = (periodSeconds: number) => ({ semantics: { scope: 'provider', periodSeconds } });
  for (const [limitId, reported, expected] of [
    ['codex', weekly, { ...reading('codex:primary', 'weekly', 66, reset), ...provider(604800) }],
    [
      'codex',
      { usedPercent: 0, windowDurationMins: 300, resetsAt: 1792679628 },
      { ...reading('codex:primary', 'rolling', 100, reset), ...provider(18000) },
    ],
    [
      'codex',
      { usedPercent: 100, windowDurationMins: 15, resetsAt: 123 },
      { ...reading('codex:primary', 'rolling', 0, '1970-01-01T00:02:03.000Z'), ...provider(900) },
    ],
    // An over-limit window shows as exhausted.
    [
      'codex',
      { usedPercent: 101, windowDurationMins: 300, resetsAt: null },
      { ...reading('codex:primary', 'rolling', 0, null), ...provider(18000) },
    ],
    // Labels come from the reported duration only. A limit ID never implies a period.
    [
      'weekly',
      { usedPercent: 50, windowDurationMins: 300, resetsAt: null },
      { ...reading('weekly:primary', 'rolling', 50, null), ...provider(18000) },
    ],
    [
      'codex',
      { usedPercent: 50, windowDurationMins: null, resetsAt: null },
      reading('codex:primary', 'rolling', 50, null),
    ],
  ] as const) {
    const [window, ...others] = usageUpdate(snapshot(limitId, reported)).windows;
    assert.deepEqual([window, ...others], [expected], JSON.stringify(reported));
    const routeId = 'rte_01M51M322B2AEBXD9MA74CBCFM';
    const observedAt = '2026-10-16T08:13:20.161Z';
    assert.deepEqual(ObservationSchema.parse({ ...window, routeId, observedAt }), {
      ...expected,
      routeId,
      observedAt,
    });
  }
});

test('only a read that lists every bucket is complete and an update names only what it reports', () => {
  const available = { hasCredits: true, unlimited: false, balance: '12.50' };
  const unlimited = { hasCredits: false, unlimited: true, balance: null };
  const none = { hasCredits: false, unlimited: false, balance: null };
  for (const [usage, complete, windowIds, credits] of [
    // The legacy rateLimits view mirrors the codex entry and adds no second copy. Credit
    // balances come back beside the windows and never become one.
    [
      usageRead({
        codex_other: snapshot('codex_other', weekly, null, unlimited),
        codex: snapshot('codex', weekly, fiveHour, available),
      }),
      true,
      ['codex:primary', 'codex:secondary', 'codex_other:primary'],
      [
        { limitId: 'codex', state: 'available', balance: '12.50' },
        { limitId: 'codex_other', state: 'unlimited', balance: null },
      ],
    ],
    [usageRead({ codex: snapshot(null, weekly) }), true, ['codex:primary'], []],
    [usageRead({ codex: snapshot('codex', null) }), true, [], []],
    // A bucket without a usable identity is dropped and the read stops claiming every bucket.
    [
      usageRead({
        codex: snapshot('codex', weekly),
        'codex primary': snapshot(null, weekly),
        other: snapshot('codex', weekly),
        ['x'.repeat(65)]: snapshot(null, weekly),
      }),
      false,
      ['codex:primary'],
      [],
    ],
    [usageRead(null), false, ['codex:primary'], []],
    [usageRead(null, snapshot(null, weekly)), false, [], []],
    [usageUpdate(snapshot('codex', null, fiveHour)), false, ['codex:secondary'], []],
    [usageUpdate(snapshot('codex', null)), false, [], []],
    [usageUpdate(snapshot(null, weekly, fiveHour)), false, [], []],
    [usageUpdate(snapshot('codex/primary', weekly)), false, [], []],
    [
      usageUpdate(snapshot('codex', null, null, none)),
      false,
      [],
      [{ limitId: 'codex', state: 'none', balance: null }],
    ],
  ] as const) {
    assert.deepEqual(
      [usage.complete, usage.windows.map((value) => value.windowId), usage.credits],
      [complete, windowIds, credits],
    );
    assert(usage.windows.every((value) => value.remaining?.unit === 'percent'));
  }
});

test('malformed rate-limit payloads are refused', () => {
  for (const rateLimits of [
    snapshot('codex', { ...weekly, usedPercent: -1 }),
    snapshot('codex', { ...weekly, usedPercent: 33.5 }),
    snapshot('codex', { ...weekly, usedPercent: '34' }),
    snapshot('codex', { ...weekly, usedPercent: 2_147_483_648 }),
    snapshot('codex', { windowDurationMins: 10080, resetsAt: 1792679628 }),
    snapshot('codex', { ...weekly, windowDurationMins: 0 }),
    snapshot('codex', { ...weekly, windowDurationMins: 525_601 }),
    // A reset in milliseconds lands past the year 9999 and is refused.
    snapshot('codex', { ...weekly, resetsAt: 1792679628000 }),
    snapshot('codex', { ...weekly, resetsAt: -1 }),
    snapshot('', weekly),
    null,
  ])
    assert.throws(() => usageUpdate(rateLimits), JSON.stringify(rateLimits));
  for (const payload of [null, [], {}, 'private'])
    assert.throws(() => projectOpenAiUsage('account/rateLimits/updated', payload));
  assert.throws(() =>
    usageRead(
      Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`b${index}`, snapshot(null, weekly)]),
      ),
    ),
  );
  assert.throws(() =>
    projectOpenAiUsage('account/rateLimits/read', {
      rateLimitsByLimitId: { codex: snapshot('codex', weekly) },
    }),
  );
});

test('a process merges sparse updates into the windows it reported', () => {
  const emitted: OpenAiUsage[] = [];
  const reporter = openAiUsageReporter((usage) => emitted.push(usage));
  const at = (seconds: number) => new Date(seconds * 1000).toISOString();
  const send = (method: Parameters<typeof reporter>[0], payload: unknown, report = reporter) => {
    emitted.length = 0;
    report(method, payload);
    return emitted.map((usage) => [
      usage.complete,
      usage.windows.map((value) => [
        value.windowId,
        value.remaining?.value,
        value.semantics?.periodSeconds ?? null,
        value.resetsAt,
      ]),
    ]);
  };
  const read = (payload: unknown) => send('account/rateLimits/read', payload);
  const update = (primary: unknown, secondary: unknown = null) =>
    send('account/rateLimits/updated', { rateLimits: snapshot('codex', primary, secondary) });
  const sparse = (usedPercent: number) => ({
    usedPercent,
    windowDurationMins: null,
    resetsAt: null,
  });

  assert.deepEqual(read(rateLimitRead({ codex: snapshot('codex', weekly, fiveHour) })), [
    [
      true,
      [
        ['codex:primary', 66, 604800, at(1792679628)],
        ['codex:secondary', 90, 18000, at(1792000000)],
      ],
    ],
  ]);
  // A sparse update takes the duration and reset reported before.
  assert.deepEqual(update(sparse(34)), [[false, [['codex:primary', 66, 604800, at(1792679628)]]]]);
  assert.deepEqual(update(sparse(35)), [[false, [['codex:primary', 65, 604800, at(1792679628)]]]]);
  assert.deepEqual(update({ ...weekly, usedPercent: 35, windowDurationMins: 300 }), [
    [false, [['codex:primary', 65, 18000, at(1792679628)]]],
  ]);
  assert.deepEqual(update({ ...weekly, usedPercent: -1 }), []);
  // A complete read forgets the windows it no longer lists, so their old period is not reused.
  assert.deepEqual(read(rateLimitRead({ codex: snapshot('codex', weekly) })), [
    [true, [['codex:primary', 66, 604800, at(1792679628)]]],
  ]);
  assert.deepEqual(update(null, sparse(20)), [[false, [['codex:secondary', 80, null, null]]]]);
  // Memory belongs to one process. Another process has nothing to merge a sparse update with.
  assert.deepEqual(
    send(
      'account/rateLimits/updated',
      { rateLimits: snapshot('codex', sparse(35)) },
      openAiUsageReporter((usage) => emitted.push(usage)),
    ),
    [[false, [['codex:primary', 65, null, null]]]],
  );
  assert.doesNotThrow(() =>
    openAiUsageReporter(() => {
      throw new Error('private-usage-canary');
    })('account/rateLimits/read', rateLimitRead({ codex: snapshot('codex', weekly) })),
  );
});
