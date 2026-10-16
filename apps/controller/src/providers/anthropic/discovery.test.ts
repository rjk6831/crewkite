import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscoveryError, metadataCommand, projectAuthStatus } from './discovery.ts';

const privateText = 'private-token-email@example.test';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
type Scenario = {
  name: string;
  value?: unknown;
  stdout?: Uint8Array;
  stderrBytes?: number;
  exitCode?: number | null;
  reason?: DiscoveryError['reason'];
  expected?: ReturnType<typeof projectAuthStatus>['status'];
};

test('authentication discovery exposes only bounded metadata and grants no authority', () => {
  const cases: Scenario[] = [
    ...(
      ['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'] as const
    ).map(
      (authMethod): Scenario => ({
        name: `known method ${authMethod}`,
        value: {
          authMethod,
          email: privateText,
          accountId: privateText,
          organizationId: privateText,
          configDirectory: `/private/${privateText}`,
          token: privateText,
          subscriptionType: privateText,
        },
        exitCode: authMethod === 'none' ? 1 : 0,
        expected:
          authMethod === 'none'
            ? 'signed-out'
            : authMethod === 'claude.ai'
              ? 'subscription-candidate'
              : 'unsupported',
      }),
    ),
    { name: 'unknown method', value: { authMethod: privateText }, reason: 'invalid-message' },
    { name: 'missing method', value: { email: privateText }, reason: 'invalid-message' },
    { name: 'array', value: [{ authMethod: 'claude.ai' }], reason: 'invalid-message' },
    {
      name: 'logged in without method',
      value: { authMethod: 'none' },
      reason: 'inconsistent-status',
    },
    { name: 'nonzero signed-in status', exitCode: 1, reason: 'inconsistent-status' },
    { name: 'no child exit', exitCode: null, reason: 'incomplete' },
    { name: 'native failure', exitCode: 2, reason: 'incomplete' },
    ...['type', 'method', 'request_id', 'response'].map(
      (field): Scenario => ({
        name: `reject protocol field ${field}`,
        value: { authMethod: 'claude.ai', [field]: privateText },
        reason: 'invalid-message',
      }),
    ),
    {
      name: 'trailing document',
      stdout: new TextEncoder().encode('{"authMethod":"claude.ai"}\n{}'),
      reason: 'invalid-message',
    },
    { name: 'malformed JSON', stdout: encode(privateText), reason: 'invalid-message' },
    {
      name: 'truncated JSON',
      stdout: new TextEncoder().encode('{"authMethod":'),
      reason: 'invalid-message',
    },
    { name: 'invalid UTF-8', stdout: new Uint8Array([0xc3, 0x28]), reason: 'invalid-message' },
    { name: 'truncated UTF-8', stdout: new Uint8Array([0xc3]), reason: 'invalid-message' },
    {
      name: 'stdout byte bound',
      stdout: new Uint8Array(65_537),
      reason: 'limit',
    },
    { name: 'stderr byte bound', stderrBytes: 16_385, reason: 'limit' },
    { name: 'invalid stderr count', stderrBytes: -1, reason: 'limit' },
    { name: 'nonfinite stderr count', stderrBytes: Number.NaN, reason: 'limit' },
    { name: 'stderr boundary', stderrBytes: 16_384, expected: 'subscription-candidate' },
    {
      name: 'stdout boundary with trailing whitespace',
      stdout: new TextEncoder().encode('{"authMethod":"claude.ai"}'.padEnd(65_536)),
      expected: 'subscription-candidate',
    },
  ];
  for (const scenario of cases) {
    try {
      const result = projectAuthStatus({
        stdout: scenario.stdout ?? encode(scenario.value ?? { authMethod: 'claude.ai' }),
        stderrBytes: scenario.stderrBytes ?? 0,
        exitCode: scenario.exitCode === undefined ? 0 : scenario.exitCode,
      });
      assert.equal(scenario.reason, undefined, scenario.name);
      assert.equal(result.status, scenario.expected, scenario.name);
      assert.equal(result.billing, 'unknown', scenario.name);
      assert.equal(result.qualified, false, scenario.name);
      assert.deepEqual(Object.keys(result).sort(), [
        'authMethod',
        'billing',
        'qualified',
        'status',
      ]);
      assert(!JSON.stringify(result).includes(privateText), scenario.name);
    } catch (error) {
      assert(error instanceof DiscoveryError, scenario.name);
      assert.equal(error.reason, scenario.reason, scenario.name);
      assert(!error.message.includes(privateText), scenario.name);
      assert.equal(error.cause, undefined, scenario.name);
    }
  }
  for (const [kind, argv] of [
    ['version', ['--version']],
    ['help', ['--help']],
    ['auth-status', ['auth', 'status']],
  ] as const) {
    const plan = metadataCommand(kind);
    assert.deepEqual(plan.argv, argv);
    assert.equal(plan.timeoutMs, kind === 'auth-status' ? 30_000 : 5_000);
    assert(plan.maxStdoutBytes <= 65_536 && plan.maxStderrBytes <= 16_384);
    plan.argv.push('login');
    assert.deepEqual(metadataCommand(kind).argv, argv);
  }
  assert.throws(() => metadataCommand('login' as 'auth-status'), {
    name: 'DiscoveryError',
    reason: 'invalid-command',
  });
});
