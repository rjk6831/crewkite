import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { LocalSetupSchema, NativeProfileSchema } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { buildChatCatalog } from '../../chat/catalog.ts';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
import { resolveAnthropicNativeProfile } from '../anthropic/profile.ts';
import {
  matchesOpenAiModelCatalogObservation,
  startOpenAiModelCatalogObservation,
} from './model-catalog.ts';
import { unavailableRepositoryProfile } from './profile.ts';

const peer = `
const { createInterface } = require('node:readline');
if (process.argv[2] === 'features') {
  process.stdout.write(['plugins', 'remote_plugin', 'apps', 'hooks', 'multi_agent']
    .map(key => key + '  stable  false').join('\\n') + '\\n');
  process.exit(0);
}
const config = {
  model_provider: 'openai', service_tier: 'default', approval_policy: 'on-request',
  approvals_reviewer: 'user', sandbox_mode: 'read-only', web_search: 'disabled',
  chatgpt_base_url: 'https://chatgpt.com/backend-api/', openai_base_url: '',
  features: { plugins: false, remote_plugin: false, apps: false, hooks: false, multi_agent: false },
  mcp_servers: {},
};
const replies = {
  initialize: { userAgent: 'catalog-peer', platformFamily: 'unix', platformOs: 'fixture' },
  'account/read': { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true },
  'config/read': { config },
  'configRequirements/read': { requirements: null },
  'account/rateLimits/read': { ordinaryUsageAllowed: true, rateLimits: {} },
  'model/list': {
    data: [
      { id: 'fixture-b', model: 'fixture-b', supportedReasoningEfforts: [
        { reasoningEffort: 'medium' }
      ], defaultReasoningEffort: 'medium', hidden: true, upgradeInfo: { retirementAt: 1798761600 } },
      { id: 'fixture-a', model: 'fixture-a', supportedReasoningEfforts: [
        { reasoningEffort: 'low' }, { reasoningEffort: 'high' }
      ], defaultReasoningEffort: 'low', hidden: false, inputModalities: ['text', 'image', 'video'] },
    ],
    nextCursor: null,
  },
};
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method) process.stderr.write('method:' + message.method + '\\n');
  if (message.method === 'model/list') process.stderr.write('params:' + JSON.stringify(message.params) + '\\n');
  if (message.id) process.stdout.write(JSON.stringify({ id: message.id, result: replies[message.method] }) + '\\n');
});
input.on('close', () => process.exit(0));
`;

test('OpenAI catalog refresh retains only advertised pairs, hidden ones flagged with their retirement date, and the input kinds the composer reports, and every list names its source, after owned peer closure', async () => {
  mkdirSync(resolve('internal'), { recursive: true });
  const root = mkdtempSync(resolve('internal/openai-model-catalog-'));
  const directory = resolve(root, 'run');
  mkdirSync(directory, { mode: 0o700 });
  const sha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const base = unavailableRepositoryProfile();
  if (base.facts.family !== 'openai') throw new Error('Expected an OpenAI repository profile.');
  const profile = {
    facts: NativeProfileSchema.parse({
      ...base.facts,
      available: true,
      reason: 'qualification-pending',
    }),
    client: { executable: process.execPath, sha256, version: base.facts.clientVersion },
    environment: { HOME: root, CODEX_HOME: resolve(root, 'native-home'), PATH: process.env.PATH },
    locationHash: 'b'.repeat(64),
  };
  const children: ChildProcessWithoutNullStreams[] = [];
  const lifecycle: string[] = [];
  let errors = '';
  try {
    const handle = startOpenAiModelCatalogObservation(
      profile,
      { directory, repositoryRoot: root },
      {
        timeoutMs: 5000,
        observedAt: () => '2026-10-21T12:00:00.000Z',
        lifecycle: {
          beforePhase: (phase) => lifecycle.push(`intent:${phase.sequence}:${phase.kind}`),
          owned: (phase) => lifecycle.push(`owned:${phase.sequence}:${phase.kind}`),
          quiescent: (phase) => lifecycle.push(`quiescent:${phase.sequence}:${phase.kind}`),
        },
        spawn: (executable, args, options) => {
          const phase = args.at(-1) === 'list' ? 'features' : 'discovery';
          const child = spawn(executable, ['-e', peer, 'catalog', phase], options);
          child.stderr.on('data', (bytes: Buffer) => {
            errors = (errors + bytes.toString('utf8')).slice(-4096);
          });
          children.push(child);
          return child;
        },
      },
    );
    const outcome = await handle.result;
    assert.equal(
      outcome.reason,
      null,
      JSON.stringify({
        lastRequest: outcome.lastRequest,
        lastEnvelope: outcome.lastEnvelope,
        refusedEnvelope: outcome.refusedEnvelope,
        errors,
        children: children.map((child) => ({
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        })),
      }),
    );
    assert.equal(outcome.quiescent, true);
    assert(handle.groups.every(groupAbsent));
    assert(children.every((child) => child.exitCode === 0));
    assert.deepEqual(lifecycle, [
      'intent:0:effective-features',
      'owned:0:effective-features',
      'quiescent:0:effective-features',
      'intent:1:app-server-task',
      'owned:1:app-server-task',
      'quiescent:1:app-server-task',
    ]);
    const methods = [...errors.matchAll(/^method:(.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(methods, [
      'initialize',
      'initialized',
      'account/read',
      'config/read',
      'configRequirements/read',
      'account/rateLimits/read',
      'model/list',
    ]);
    assert(methods.every((method) => !method.startsWith('thread/') && !method.startsWith('turn/')));
    // The read asks for the models the client keeps out of its picker. They stay flagged and
    // follow the listed ones.
    assert.deepEqual(
      [...errors.matchAll(/^params:(.+)$/gm)].map((match) => JSON.parse(match[1])),
      [{ limit: 20, includeHidden: true }],
    );
    // A kind the client may add later drops out, and a model that reports none keeps none.
    assert.deepEqual(outcome.metadata?.models, [
      {
        model: 'fixture-a',
        efforts: ['low', 'high'],
        defaultEffort: 'low',
        inputModalities: ['text', 'image'],
      },
      {
        model: 'fixture-b',
        efforts: ['medium'],
        defaultEffort: 'medium',
        hidden: true,
        retirementAt: 1798761600,
      },
    ]);
    // The composer reads what the default model takes, and the Anthropic list from its client's
    // block types. Without an observed list the OpenAI family reports nothing.
    const catalog = (
      openAiModels: Parameters<typeof buildChatCatalog>[0]['openAiModels'],
      anthropicModels?: Parameters<typeof buildChatCatalog>[0]['anthropicModels'],
    ) =>
      buildChatCatalog({
        profiles: [
          { ...profile.facts, model: 'fixture-a' },
          resolveAnthropicNativeProfile({ HOME: root, PATH: '' }).facts,
        ],
        openAiModels,
        anthropicModels,
        local: LocalSetupSchema.parse({
          revision: 0,
          connectionRevision: 0,
          connectorId: 'local-sdk-v1',
          endpoint: null,
          setupHash: null,
          connectionHash: null,
          secretConfigured: false,
          operation: null,
          generation: 'idle',
          observation: null,
          selection: null,
          reason: 'unconfigured',
        }),
        windows: [],
        nowMs: 0,
      }).families;
    const accepts = (openAiModels: Parameters<typeof buildChatCatalog>[0]['openAiModels']) =>
      catalog(openAiModels).map((entry) => [entry.family, entry.accepts]);
    assert.deepEqual(accepts(outcome.metadata?.models ?? null), [
      ['openai', ['image/*']],
      [
        'anthropic',
        ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/*'],
      ],
      ['google', null],
      ['local', null],
    ]);
    assert.deepEqual(accepts(null)[0], ['openai', null]);
    // The picker marks hidden models and shows the retirement date, and every entry says where it
    // came from. Anthropic shows the shipped four as known until a read brings the client's rows,
    // which then replace them, and the default row folds into the model it resolves to.
    const models = (family: string, list: ReturnType<typeof catalog>) =>
      list
        .find((entry) => entry.family === family)
        ?.models.map(({ model, label, hidden, source, efforts }) => ({
          model,
          label,
          hidden,
          source,
          efforts,
        }));
    assert.deepEqual(models('openai', catalog(outcome.metadata?.models ?? null)), [
      {
        model: 'fixture-a',
        label: 'fixture-a',
        hidden: undefined,
        source: 'live',
        efforts: ['low', 'high'],
      },
      {
        model: 'fixture-b',
        label: 'fixture-b, retires 2027-01-01',
        hidden: true,
        source: 'live',
        efforts: ['medium'],
      },
    ]);
    assert.deepEqual(
      models('anthropic', catalog(null))?.map((entry) => [entry.model, entry.source]),
      [
        ['claude-fable-5-1', 'known'],
        ['claude-opus-5-5', 'known'],
        ['claude-sonnet-5-5', 'known'],
        ['claude-haiku-5-5', 'known'],
      ],
    );
    const rows = [
      { value: 'default', model: 'claude-sonnet-5-5', label: 'Default', efforts: [] },
      {
        value: 'sonnet',
        model: 'claude-sonnet-5-5',
        label: 'Sonnet 5.5',
        efforts: ['low', 'high'],
      },
      { value: 'haiku', model: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: [] },
    ];
    const live = catalog(null, rows).find((entry) => entry.family === 'anthropic');
    assert.deepEqual(
      live?.models.map((entry) => [entry.model, entry.label, entry.source, entry.efforts]),
      [
        ['claude-sonnet-5-5', 'Sonnet 5.5', 'live', ['default', 'low', 'high']],
        ['claude-haiku-5-5', 'Haiku 5.5', 'live', ['default']],
      ],
    );
    assert.equal(outcome.metadata?.profileHash, hashCanonical(profile.facts));
    assert(outcome.metadata && matchesOpenAiModelCatalogObservation(profile, outcome.metadata));
    assert(
      outcome.metadata &&
        !matchesOpenAiModelCatalogObservation(
          { ...profile, locationHash: 'c'.repeat(64) },
          outcome.metadata,
        ),
    );
    assert.deepEqual(Object.keys(outcome.metadata ?? {}).sort(), [
      'client',
      'locationHash',
      'models',
      'observedAt',
      'profileHash',
      'profileId',
      'version',
    ]);
  } finally {
    for (const child of children) {
      const group = child.pid;
      if (group && !groupAbsent(group)) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {}
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
