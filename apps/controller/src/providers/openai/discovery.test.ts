import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscoveryError, OpenAiDiscovery } from './discovery.ts';

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
      credits: { hasCredits: false, unlimited: false, balance: privateText },
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
  deadline?: boolean;
  incomplete?: boolean;
  reason?: DiscoveryError['reason'];
  check?: (value: ReturnType<OpenAiDiscovery['finish']>) => void;
  configuration?: Record<string, unknown>;
  requirements?: unknown;
};

test('provider discovery emits only correlated metadata and excludes private fields', () => {
  const scenarios: Scenario[] = [
    { name: 'fragmented transcript retains exact native model and effort' },
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
    {
      name: 'credits are metadata only',
      change: (values) => {
        values[2] = {
          rateLimits: { credits: { hasCredits: true, unlimited: true, balance: privateText } },
        };
        return values;
      },
      check: (value) => assert.equal(value.limits.rateLimits.credits, 'unlimited'),
    },
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
      wire: (value) =>
        new TextEncoder().encode(`${JSON.stringify({ id: 1, result: value })}\n{"id":2`),
      whole: true,
      reason: 'unexpected-message',
    },
    {
      name: 'partial next reply before next request',
      afterResponse: true,
      reason: 'unexpected-message',
    },
    {
      name: 'partial reply after final response',
      wire: (value, index) =>
        new TextEncoder().encode(
          `${JSON.stringify({ id: index + 1, result: value })}\n${index === 3 ? '{' : ''}`,
        ),
      whole: true,
      reason: 'unexpected-message',
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
      name: 'turn notification',
      wire: () => line({ method: 'turn/started', params: { text: privateText } }),
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
      name: 'unknown envelope field',
      wire: () => line({ id: 1, result: {}, token: privateText }),
      reason: 'invalid-message',
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
      name: 'catalog requires another page',
      change: (values) => {
        values[3] = { ...catalog(), nextCursor: 'next-page' };
        return values;
      },
      reason: 'catalog-incomplete',
    },
    {
      name: 'too many models',
      change: (values) => {
        values[3] = { ...catalog(), data: Array(21).fill(catalog().data[0]) };
        return values;
      },
      reason: 'invalid-message',
    },
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
    const reader = new OpenAiDiscovery({
      now: () => now,
      timeoutMs: 100,
      readConfiguration: !!scenario.configuration,
      configurationDirectory: '/workspace',
    });
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
        assert.equal(reader.next(), null, scenario.name);
        const bytes =
          scenario.wire?.(values[index], index) ?? line({ id: index + 1, result: values[index] });
        if (!scenario.whole && bytes.length < 65_537) {
          for (const byte of bytes) reader.push(new Uint8Array([byte]));
        } else reader.push(bytes);
        if (scenario.afterResponse) reader.push(new TextEncoder().encode('{"id":2'));
        if (scenario.incomplete) break;
      }
      const metadata = reader.finish();
      assert.equal(scenario.reason, undefined, scenario.name);
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
    } catch (error) {
      assert(error instanceof DiscoveryError, scenario.name);
      assert.equal(error.reason, scenario.reason, scenario.name);
      assert(!error.message.includes(privateText), scenario.name);
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
        ],
      );
  }
});
