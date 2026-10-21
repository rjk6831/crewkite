import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { NativeProfileSchema } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { spawnCheckChild as spawn } from '../../host/check-ownership.ts';
import { groupAbsent } from '../../host/worker.ts';
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
      { id: 'fixture-a', model: 'fixture-a', supportedReasoningEfforts: [
        { reasoningEffort: 'low' }, { reasoningEffort: 'high' }
      ], defaultReasoningEffort: 'low' },
      { id: 'fixture-b', model: 'fixture-b', supportedReasoningEfforts: [
        { reasoningEffort: 'medium' }
      ], defaultReasoningEffort: 'medium' },
    ],
    nextCursor: null,
  },
};
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method) process.stderr.write('method:' + message.method + '\\n');
  if (message.id) process.stdout.write(JSON.stringify({ id: message.id, result: replies[message.method] }) + '\\n');
});
input.on('close', () => process.exit(0));
`;

test('OpenAI catalog refresh retains only advertised pairs after owned peer closure', async () => {
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
    assert.deepEqual(outcome.metadata?.models, [
      { model: 'fixture-a', efforts: ['low', 'high'], defaultEffort: 'low' },
      { model: 'fixture-b', efforts: ['medium'], defaultEffort: 'medium' },
    ]);
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
