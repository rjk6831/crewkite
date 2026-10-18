import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { canonicalJson } from '@crewkite/contracts';
import type { LLMPredictionOpts, PredictionResult } from '@lmstudio/sdk';
import { localConfiguredConnectionHash, resolveLocalConnection } from './connection.ts';
import {
  type LocalDiscoveryStart,
  type LocalStart,
  type LocalTerminal,
  type localChat,
  localDiscoveryPlan,
  localPlan,
  localStructuredOutput,
  localTests,
  TerminalSchema,
} from './profile.ts';
import { startLocalDiscovery, startLocalReplacement } from './replacement.ts';
import {
  discoverLocalModels,
  type LoadedModel,
  type LocalDiscoveryClient,
  localClientOptions,
  startLocalPrediction,
} from './sdk.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const plan: LocalStart = {
  binding: {
    attemptId: 'att_01J00000000000000000000001',
    generation: 0,
    profileHash: hash('profile'),
    sourceHash: hash('source'),
    path: 'net.mjs',
    baseHash: hash('export const n = 1;\n'),
    modelKey: 'local-fixture',
    instanceReference: 'instance-1',
    modelSizeBytes: 5_630_000_000,
    artifactSha256: hash('fixture weights'),
    quantization: 'Q4_K_M',
  },
  endpoint: 'ws://127.0.0.1:1234',
  token: 'private-fixture-token',
  original: 'export const n = 1;\n',
  task: {
    title: 'Raise the fixture constant',
    outcome: 'Change n to 2.',
    criteria: ['Keep the export named n.'],
  },
  tests: [
    { path: 'net.test.mjs', content: "import { n } from './net.mjs';\nif (n !== 2) throw 1;\n" },
  ],
  timeoutMs: 30_000,
};
const info = {
  type: 'llm' as const,
  modelKey: plan.binding.modelKey,
  instanceReference: 'instance-1',
  identifier: 'fixture',
  sizeBytes: plan.binding.modelSizeBytes,
  format: 'gguf' as const,
  deviceIdentifier: null,
  contextLength: 8192,
  maxContextLength: 32768,
  displayName: 'fixture',
  path: 'fixture.gguf',
  publisher: 'fixture',
  indexedModelIdentifier: 'fixture',
  vision: false,
  trainedForToolUse: false,
  ttlMs: null,
  lastUsedTime: null,
};
const kv = (values: Record<string, unknown>) => ({
  fields: Object.entries(values).map(([key, value]) => ({ key, value })),
});
function terminal(
  stopReason: PredictionResult['stats']['stopReason'] = 'eosFound',
  maximumOutputTokens = 2048,
  input: LocalStart = plan,
  proposed = 'export const n = 2;\n',
) {
  const content = JSON.stringify({
    version: 1,
    attemptId: input.binding.attemptId,
    path: input.binding.path,
    baseHash: input.binding.baseHash,
    content: proposed,
  });
  return {
    content,
    reasoningContent: '',
    nonReasoningContent: content,
    stats: { stopReason },
    modelInfo: info,
    roundIndex: 0,
    loadConfig: kv({ 'llm.load.contextLength': 8192 }),
    predictionConfig: kv({
      'llm.prediction.maxPredictedTokens': { checked: true, value: maximumOutputTokens },
      'llm.prediction.contextOverflowPolicy': 'stopAtLimit',
      'llm.prediction.speculativeDecoding.draftModel': '',
      'llm.prediction.structured': localStructuredOutput(input.binding).format,
    }),
  } satisfies PredictionResult;
}
function fixture(input: LocalStart = plan) {
  let resolve!: (value: PredictionResult) => void, reject!: (error: Error) => void;
  const result = new Promise<PredictionResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let submitted = 0,
    cancelled = 0,
    prompt = '',
    options: LLMPredictionOpts | undefined;
  const model: LoadedModel = {
    modelKey: plan.binding.modelKey,
    instanceReference: plan.binding.instanceReference,
    sizeBytes: plan.binding.modelSizeBytes,
    getModelInfo: async () => info,
    getBasePredictionConfig: async () => ({ draftModel: '' }),
    getInstanceProcessingState: async () => ({ status: 'idle', queued: 0 }),
    applyPromptTemplate: async (chat) => {
      // The task reads once as plain text and the file arrives byte for byte inside attempt fences.
      const [message, ...rest] = chat as ReturnType<typeof localChat>;
      assert.equal(rest.length, 0);
      const { title, outcome, criteria } = input.task;
      assert.equal(message.content.split(title).length, 2);
      assert.ok(
        message.content.includes(
          `\nTitle: ${title}\nOutcome: ${outcome}\nRequirements:\n1. ${criteria[0]}\n`,
        ),
      );
      const fence = (edge: string, kind: string, path: string) =>
        `----- ${edge} ${kind} ${path} ${input.binding.attemptId} -----`;
      for (const [kind, path, content] of [
        ['FILE', input.binding.path, input.original],
        ...input.tests.map((test) => ['READ-ONLY TEST', test.path, test.content]),
      ])
        assert.ok(
          message.content.includes(
            `\n${fence('BEGIN', kind, path)}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence('END', kind, path)}\n`,
          ),
        );
      return 'rendered chat';
    },
    tokenize: async () => [1, 2, 3],
    complete: (value, config) => {
      submitted++;
      prompt = value;
      options = config;
      return {
        result: () => result,
        cancel: async () => {
          cancelled++;
        },
      };
    },
  };
  const timers: Array<{ work: () => void; delay: number; active: boolean }> = [];
  const schedule = (work: () => void, delay: number) => {
    const timer = { work, delay, active: true };
    timers.push(timer);
    return () => {
      timer.active = false;
    };
  };
  return {
    model,
    client: {
      llm: { listLoaded: async () => [model] },
      embedding: { listLoaded: async () => [] as unknown[] },
    },
    resolve,
    reject,
    schedule,
    timers,
    get submitted() {
      return submitted;
    },
    get cancelled() {
      return cancelled;
    },
    get prompt() {
      return prompt;
    },
    get options() {
      return options;
    },
  };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function discoveryClient(
  f: ReturnType<typeof fixture>,
  downloaded: unknown[] = [info],
): LocalDiscoveryClient {
  return {
    ...f.client,
    system: {
      getLMStudioVersion: async () => ({ version: '0.5.0', build: 9 }),
      listDownloadedModels: async () => downloaded,
      listDownloadedModelVariants: async () => {
        throw new Error('No variants were declared.');
      },
    },
  };
}

test('Local generation binds its loopback authentication mode and loaded instance', async () => {
  for (const endpoint of [
    'ws://localhost:1234',
    'wss://127.0.0.1:1234',
    'ws://127.0.0.1:65536',
    'ws://127.0.0.1:1234/path',
    'ws://127.1:1234',
  ])
    assert.throws(() => localPlan({ ...plan, endpoint }), endpoint);
  for (const token of ['', ' ', '\0']) assert.throws(() => localPlan({ ...plan, token }));
  assert.deepEqual(localPlan({ ...plan, authMode: 'token' }), { ...plan, authMode: 'token' });
  assert.deepEqual(localPlan(plan), plan);
  assert.equal(canonicalJson(localPlan(plan)), canonicalJson(plan));
  for (const maximumOutputTokens of [2048, 4096] as const) {
    const explicit: LocalStart = { ...plan, maximumOutputTokens };
    assert.deepEqual(localPlan(explicit), explicit);
  }
  for (const maximumOutputTokens of [0, 2049, 8192, false])
    assert.throws(() => localPlan({ ...plan, maximumOutputTokens }));
  assert.equal(localClientOptions(plan).apiToken, plan.token);
  assert.throws(() => localPlan({ ...plan, authMode: 'none' }));
  const { token: _legacyToken, ...legacyWithoutToken } = plan;
  assert.throws(() => localPlan({ ...legacyWithoutToken, authMode: 'none' }));
  assert.throws(() => localPlan({ ...plan, original: 'changed' }));
  for (const task of [
    JSON.stringify(plan.task),
    { ...plan.task, extra: true },
    { ...plan.task, criteria: [] },
    { ...plan.task, criteria: ['x'.repeat(4096), 'x'.repeat(4096)] },
  ])
    assert.throws(() => localPlan({ ...plan, task }));
  for (const tests of [
    [...plan.tests, ...plan.tests, ...plan.tests],
    [
      { path: 'a.test.mjs', content: 'x'.repeat(6144) },
      { path: 'b.test.mjs', content: 'x'.repeat(6145) },
    ],
  ])
    assert.throws(() => localPlan({ ...plan, tests }));
  const sibling = (path: string, content: string) => ({ path, content: Buffer.from(content) });
  const imports = "import { run } from './run.ts';\n";
  assert.deepEqual(
    localTests('src/run.ts', [
      sibling('src/z.test.ts', imports),
      sibling('src/y.test.mjs', imports.replaceAll("'", '"')),
      sibling('src/b.test.ts', imports),
      sibling('src/a.test.ts', imports.padEnd(12_289)),
      sibling('src/other.test.ts', "import { run } from './runner.ts';\n"),
      sibling('src/run.ts', imports),
      sibling('src/helper.ts', imports),
      sibling('src/nested/run.test.ts', "import { run } from '../run.ts';\n"),
      sibling('run.test.ts', "import { run } from './src/run.ts';\n"),
    ]).map((test) => test.path),
    ['src/b.test.ts', 'src/y.test.mjs'],
  );
  const cases: Array<{
    name: string;
    change: (value: ReturnType<typeof fixture>) => void;
    reason: string;
  }> = [
    {
      name: 'missing model',
      change: (f) => {
        f.client.llm.listLoaded = async () => [];
      },
      reason: 'identity',
    },
    {
      name: 'extra resident model',
      change: (f) => {
        f.client.llm.listLoaded = async () => [f.model, f.model];
      },
      reason: 'identity',
    },
    {
      name: 'resident embedding',
      change: (f) => {
        f.client.embedding.listLoaded = async () => [{}];
      },
      reason: 'identity',
    },
    {
      name: 'different instance',
      change: (f) => {
        f.client.llm.listLoaded = async () => [{ ...f.model, instanceReference: 'instance-2' }];
      },
      reason: 'identity',
    },
    {
      name: 'different bytes',
      change: (f) => {
        f.client.llm.listLoaded = async () => [{ ...f.model, sizeBytes: f.model.sizeBytes + 1 }];
      },
      reason: 'identity',
    },
    {
      name: 'remote instance',
      change: (f) => {
        f.model.getModelInfo = async () => ({ ...info, deviceIdentifier: 'remote' });
      },
      reason: 'identity',
    },
    {
      name: 'wrong context',
      change: (f) => {
        f.model.getModelInfo = async () => ({ ...info, contextLength: 16384 });
      },
      reason: 'identity',
    },
    {
      name: 'busy model',
      change: (f) => {
        f.model.getInstanceProcessingState = async () => ({ status: 'generating', queued: 1 });
      },
      reason: 'identity',
    },
    {
      name: 'draft selected',
      change: (f) => {
        f.model.getBasePredictionConfig = async () => ({ draftModel: 'draft' });
      },
      reason: 'configuration',
    },
    {
      name: 'missing draft evidence',
      change: (f) => {
        f.model.getBasePredictionConfig = async () => ({});
      },
      reason: 'configuration',
    },
    {
      name: 'input cannot fit',
      change: (f) => {
        f.model.tokenize = async () => Array(6145).fill(1);
      },
      reason: 'context',
    },
  ];
  for (const row of cases) {
    const f = fixture();
    row.change(f);
    const run = startLocalPrediction(plan, {
      createClient: () => f.client,
      schedule: f.schedule,
      now: () => 0,
    });
    const result = await run.result;
    assert.equal(result.kind, 'failed', row.name);
    assert.equal('reason' in result && result.reason, row.reason, row.name);
    assert.equal(f.submitted, 0, row.name);
    if (row.reason === 'configuration') {
      assert(result.kind === 'failed');
      assert.deepEqual(result.detail, {
        version: 1,
        stage: 'base',
        check: 'base-draft',
        status: row.name === 'missing draft evidence' ? 'missing' : 'mismatch',
      });
    }
  }
  for (const [format, catalog] of [
    ['gguf', 'exact'],
    ['safetensors', 'exact'],
    ['gguf', 'variant'],
    ['safetensors', 'variant'],
    ['gguf', 'expanded-variant'],
    ['safetensors', 'expanded-variant'],
  ] as const) {
    const f = fixture();
    const metadata = {
      ...info,
      format,
      selectedVariant: 'selected-variant',
      quantization: { name: 'arbitrary-quantization', bits: 6 },
      ...(catalog === 'expanded-variant' ? { variants: ['selected-variant'] } : {}),
    };
    f.model.getModelInfo = async () => metadata;
    const installed = {
      ...metadata,
      modelKey: metadata.selectedVariant,
      selectedVariant: undefined,
      variants: undefined,
    };
    const client = discoveryClient(f, [catalog === 'variant' ? installed : metadata]);
    let variantReads = 0;
    client.system.listDownloadedModelVariants = async (key) => {
      assert.equal(catalog, 'expanded-variant');
      assert.equal(key, metadata.modelKey);
      variantReads++;
      return [installed];
    };
    const discovery = await discoverLocalModels(client, { now: () => 0 });
    assert.equal(discovery.kind, 'observed');
    assert(discovery.kind === 'observed');
    assert.equal(variantReads, catalog === 'expanded-variant' ? 1 : 0);
    assert.equal(discovery.observation.models.length, 1);
    const choice = discovery.observation.models[0];
    assert.equal(choice.identity.modelKey, metadata.modelKey);
    assert.equal(choice.identity.selectedVariant, metadata.selectedVariant);
    assert.equal(
      choice.identity.metadataHash,
      hash(
        canonicalJson({
          modelKey: metadata.modelKey,
          path: metadata.path,
          format: metadata.format,
          sizeBytes: metadata.sizeBytes,
          deviceIdentifier: metadata.deviceIdentifier,
          quantization: metadata.quantization,
          selectedVariant: metadata.selectedVariant,
        }),
      ),
    );
    assert.equal(choice.state, 'loaded-eligible');
    assert.equal(choice.qualification, 'unqualified');
    assert.equal(f.submitted, 0);
    assert(!JSON.stringify(discovery).includes(metadata.path));
    assert(!JSON.stringify(discovery).includes('deviceIdentifier'));
    const selected = resolveLocalConnection(
      {
        endpoint: plan.endpoint,
        connectionRevision: 1,
        observation: discovery.observation,
        selectionId: choice.selectionId,
      },
      { platform: 'darwin', arch: 'arm64', secretConfigured: true },
    );
    assert(selected.connection);
    assert.equal(selected.connection.modelBinding.modelKey, metadata.modelKey);
    assert.equal(selected.connection.modelBinding.instanceReference, metadata.instanceReference);
    const genericPlan = localPlan({
      ...plan,
      binding: {
        ...selected.connection.modelBinding,
        attemptId: plan.binding.attemptId,
        generation: plan.binding.generation,
        profileHash: plan.binding.profileHash,
        sourceHash: plan.binding.sourceHash,
        path: plan.binding.path,
        baseHash: plan.binding.baseHash,
      },
    });
    assert.throws(() => localPlan({ ...genericPlan, endpoint: 'ws://127.0.0.1:4321' }));
    const none = resolveLocalConnection(
      {
        endpoint: plan.endpoint,
        authMode: 'none',
        connectionRevision: 1,
        observation: discovery.observation,
        selectionId: choice.selectionId,
      },
      { platform: 'darwin', arch: 'arm64', secretConfigured: false, connected: true },
    );
    assert(none.connection);
    const { token: _token, ...withoutToken } = plan;
    const nonePlan = localPlan({
      ...withoutToken,
      authMode: 'none',
      binding: { ...genericPlan.binding, ...none.connection.modelBinding },
    });
    assert.throws(() => localPlan({ ...nonePlan, token: plan.token }));
    assert.throws(() => localPlan({ ...nonePlan, authMode: 'token', token: plan.token }));
    assert.throws(() => localPlan({ ...nonePlan, binding: genericPlan.binding }));
    assert.equal(Object.hasOwn(localClientOptions(nonePlan, {}), 'apiToken'), false);
    const inherited = Object.defineProperty({}, 'LM_API_TOKEN', {
      get() {
        throw new Error('The inherited token value must not be read.');
      },
    });
    assert.throws(() => localClientOptions(nonePlan, inherited), /environment is unavailable/);
    assert.equal(localClientOptions(plan, inherited).apiToken, plan.token);
    const unauthenticated = fixture();
    unauthenticated.model.getModelInfo = async () => metadata;
    const noAuthRun = startLocalPrediction(nonePlan, {
      createClient: (input) => {
        assert.equal(input.authMode, 'none');
        assert(!('token' in input));
        return discoveryClient(unauthenticated, [metadata]);
      },
      schedule: unauthenticated.schedule,
      now: () => 0,
    });
    await flush();
    assert.equal(unauthenticated.submitted, 1);
    unauthenticated.resolve({ ...terminal(), modelInfo: metadata });
    assert.equal((await noAuthRun.result).kind, 'completed');
    const run = startLocalPrediction(genericPlan, {
      createClient: () => client,
      schedule: f.schedule,
      now: () => 0,
    });
    await flush();
    assert.equal(f.submitted, 1);
    f.resolve({ ...terminal(), modelInfo: metadata });
    assert.equal((await run.result).kind, 'completed');
    for (const drift of ['runtime', 'model-path', 'model-variant', 'extra-resident'] as const) {
      const next = fixture();
      next.model.getModelInfo = async () => metadata;
      const changed = discoveryClient(next, [metadata]);
      const refused = startLocalPrediction(genericPlan, {
        createClient: () => changed,
        schedule: next.schedule,
        now: () => 0,
        onSubmitted: () => {
          if (drift === 'runtime')
            changed.system.getLMStudioVersion = async () => ({ version: '0.5.0', build: 10 });
          if (drift === 'model-path')
            next.model.getModelInfo = async () => ({ ...metadata, path: 'different-model' });
          if (drift === 'model-variant')
            next.model.getModelInfo = async () => ({ ...metadata, selectedVariant: 'other' });
          if (drift === 'extra-resident')
            changed.llm.listLoaded = async () => [next.model, next.model];
        },
      });
      const outcome = await refused.result;
      assert.equal(outcome.kind, 'failed', drift);
      assert.equal('reason' in outcome && outcome.reason, 'identity', drift);
      assert.equal(next.submitted, 0, drift);
    }
  }
  for (const row of [
    'path',
    'size',
    'format',
    'device',
    'quantization-name',
    'quantization-bits',
    'quantization-missing',
    'selected-conflict',
    'duplicate-key',
    'conflicting-key',
    'parent-conflict',
    'loaded-membership',
    'duplicate-membership',
    'expanded-unlisted',
    'expanded-missing',
    'missing-variant',
    'no-selector',
    'unsupported-variant',
    'remote-variant',
    'multiple-instances',
  ] as const) {
    const f = fixture();
    const metadata = {
      ...info,
      format: 'safetensors' as const,
      selectedVariant: 'fixture/variant',
      quantization: { name: 'fixture-quantization', bits: 4 },
    };
    const installed = {
      ...metadata,
      modelKey: metadata.selectedVariant,
      selectedVariant: undefined as string | undefined,
      quantization: metadata.quantization as typeof metadata.quantization | undefined,
    };
    const downloaded: unknown[] = [installed];
    if (row === 'path') installed.path = 'other/model';
    if (row === 'size') installed.sizeBytes++;
    if (row === 'format') Object.assign(installed, { format: 'gguf' });
    if (row === 'device') Object.assign(installed, { deviceIdentifier: 'remote-runtime' });
    if (row === 'quantization-name') installed.quantization = { name: 'other', bits: 4 };
    if (row === 'quantization-bits')
      installed.quantization = { name: 'fixture-quantization', bits: 5 };
    if (row === 'quantization-missing') installed.quantization = undefined;
    if (row === 'selected-conflict') installed.selectedVariant = 'another-variant';
    if (row === 'duplicate-key') downloaded.push(installed);
    if (row === 'conflicting-key') downloaded.push({ ...installed, path: 'other/model' });
    if (row === 'parent-conflict') downloaded.push(metadata);
    if (row === 'loaded-membership') Object.assign(metadata, { variants: ['other'] });
    if (row === 'duplicate-membership')
      Object.assign(metadata, { variants: [metadata.selectedVariant, metadata.selectedVariant] });
    if (row === 'missing-variant') installed.modelKey += '-different';
    if (row === 'no-selector') Object.assign(metadata, { selectedVariant: undefined });
    if (row === 'unsupported-variant') {
      Object.assign(installed, { format: 'unsupported' });
      Object.assign(metadata, { format: 'unsupported' });
    }
    if (row === 'remote-variant') {
      Object.assign(installed, { deviceIdentifier: 'remote-runtime' });
      Object.assign(metadata, { deviceIdentifier: 'remote-runtime' });
    }
    f.model.getModelInfo = async () => metadata;
    const client = discoveryClient(f, downloaded);
    if (row === 'expanded-unlisted' || row === 'expanded-missing') {
      client.system.listDownloadedModels = async () => [
        { ...metadata, variants: [metadata.selectedVariant, 'other'] },
      ];
      client.system.listDownloadedModelVariants = async () =>
        row === 'expanded-unlisted'
          ? [installed, { ...installed, modelKey: 'unlisted' }]
          : [installed];
    }
    if (row === 'multiple-instances')
      client.llm.listLoaded = async () => [
        f.model,
        {
          ...f.model,
          instanceReference: 'instance-2',
          getModelInfo: async () => ({ ...metadata, instanceReference: 'instance-2' }),
        },
      ];
    const outcome = await discoverLocalModels(client, { now: () => 0 });
    const observed = [
      'missing-variant',
      'no-selector',
      'unsupported-variant',
      'remote-variant',
      'multiple-instances',
    ].includes(row);
    assert.equal(outcome.kind, observed ? 'observed' : 'unavailable', row);
    if (outcome.kind === 'observed') {
      assert(
        outcome.observation.models.every((choice) => choice.state !== 'loaded-eligible'),
        row,
      );
      const reason =
        row === 'unsupported-variant'
          ? 'unsupported-format'
          : row === 'remote-variant'
            ? 'remote-model'
            : row === 'multiple-instances'
              ? 'identity-ambiguous'
              : 'not-downloaded';
      assert(
        outcome.observation.models.some((choice) => choice.reasons.includes(reason)),
        row,
      );
    } else assert.equal(outcome.reason, 'metadata', row);
    assert.equal(f.submitted, 0, row);
  }
  for (const row of [
    'downloaded-limit',
    'variant-limit',
    'loaded-limit',
    'duplicate',
    'remote',
    'unloaded',
    'unsupported',
    'deadline',
    'stopped',
    'transport',
  ] as const) {
    const f = fixture();
    const client = discoveryClient(f);
    let clock = 0;
    const signal = new AbortController();
    if (row === 'downloaded-limit')
      client.system.listDownloadedModels = async () => Array(65).fill(info);
    if (row === 'variant-limit') {
      client.system.listDownloadedModels = async () => [{ ...info, variants: ['many'] }];
      client.system.listDownloadedModelVariants = async () => Array(65).fill(info);
    }
    if (row === 'loaded-limit') client.llm.listLoaded = async () => Array(9).fill(f.model);
    if (row === 'duplicate') client.system.listDownloadedModels = async () => [info, info];
    if (row === 'remote') {
      const remote = { ...info, deviceIdentifier: 'remote-runtime' };
      client.system.listDownloadedModels = async () => [remote];
      f.model.getModelInfo = async () => remote;
    }
    if (row === 'unloaded') client.llm.listLoaded = async () => [];
    if (row === 'unsupported') {
      client.system.listDownloadedModels = async () => [{ ...info, format: 'unknown-format' }];
      client.llm.listLoaded = async () => [];
    }
    if (row === 'deadline')
      client.system.listDownloadedModels = async () => {
        clock = 15000;
        return [info];
      };
    if (row === 'stopped') signal.abort();
    if (row === 'transport')
      client.system.listDownloadedModels = async () => {
        throw new Error('private runtime details');
      };
    const outcome = await discoverLocalModels(client, { now: () => clock, signal: signal.signal });
    const observed = ['remote', 'unloaded', 'unsupported'].includes(row);
    assert.equal(outcome.kind, observed ? 'observed' : 'unavailable', row);
    if (outcome.kind === 'observed')
      assert.equal(
        outcome.observation.models[0].state,
        row === 'unloaded' ? 'installed-unloaded' : 'incompatible',
        row,
      );
    else
      assert.equal(
        outcome.reason,
        row.endsWith('limit') ? 'limit' : row === 'duplicate' ? 'metadata' : row,
        row,
      );
    assert.equal(f.submitted, 0, row);
    assert(!JSON.stringify(outcome).includes('private runtime details'));
  }
  for (const reason of ['deadline', 'stopped'] as const) {
    const f = fixture();
    const client = discoveryClient(f);
    let release!: (value: { version: string; build: number }) => void;
    client.system.getLMStudioVersion = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    let laterReads = 0;
    client.system.listDownloadedModels = async () => {
      laterReads++;
      return [info];
    };
    const signal = new AbortController();
    const pending = discoverLocalModels(client, {
      now: () => 0,
      schedule: f.schedule,
      signal: signal.signal,
    });
    if (reason === 'deadline') f.timers.find((timer) => timer.active)?.work();
    else signal.abort();
    assert.deepEqual(await pending, { kind: 'unavailable', reason });
    release({ version: '0.5.0', build: 9 });
    await flush();
    assert.equal(laterReads, 0);
    assert.equal(f.submitted, 0);
    assert.equal(f.timers.filter((timer) => timer.active).length, 0);
  }
});

test('Local ownership needs the same prediction terminal after cancellation or client loss', async () => {
  for (const row of [
    { cap: undefined, prompt: 6144, stop: 'eosFound' },
    { cap: 2048, prompt: 3, stop: 'eosFound' },
    { cap: 4096, prompt: 4096, stop: 'eosFound' },
    { cap: undefined, prompt: 6145, stop: 'eosFound' },
    { cap: 4096, prompt: 4097, stop: 'eosFound' },
    { cap: undefined, prompt: 3, stop: 'maxPredictedTokensReached' },
    { cap: 4096, prompt: 1070, stop: 'maxPredictedTokensReached' },
    { cap: 4096, prompt: 3, stop: 'eosFound', terminalCap: 2048 },
    { cap: undefined, prompt: 3, stop: 'eosFound', terminalCap: 4096 },
  ] as const) {
    const label = JSON.stringify(row);
    const f = fixture();
    f.model.tokenize = async () => Array.from({ length: row.prompt }, () => 1);
    const input = { ...plan, ...(row.cap === undefined ? {} : { maximumOutputTokens: row.cap }) };
    let markers = 0;
    const run = startLocalPrediction(input, {
      createClient: () => f.client,
      schedule: f.schedule,
      now: () => 0,
      onSubmitted: () => {
        markers++;
      },
    });
    await flush();
    const cap = row.cap ?? 2048;
    const fits = row.prompt + cap <= 8192;
    assert.equal(f.submitted, fits ? 1 : 0, label);
    assert.equal(markers, fits ? 1 : 0, label);
    if (fits) {
      assert.equal(f.options?.maxTokens, cap, label);
      assert.deepEqual(f.options?.structured, {
        type: 'json',
        jsonSchema: {
          type: 'object',
          properties: {
            version: { const: 1 },
            attemptId: { const: plan.binding.attemptId },
            path: { const: plan.binding.path },
            baseHash: { const: plan.binding.baseHash },
            content: { type: 'string', maxLength: 65536 },
          },
          required: ['version', 'attemptId', 'path', 'baseHash', 'content'],
          additionalProperties: false,
        },
      });
      const value = terminal(row.stop, 'terminalCap' in row ? row.terminalCap : cap);
      if (row.stop === 'maxPredictedTokensReached') {
        value.nonReasoningContent = '{"version":';
        value.stats = {
          ...value.stats,
          ...{ promptTokensCount: row.prompt, predictedTokensCount: cap },
        };
      }
      f.resolve(value);
    }
    const outcome = await run.result;
    if (!fits) {
      assert(
        outcome.kind === 'failed' && outcome.reason === 'context' && outcome.proof === null,
        label,
      );
    } else if ('terminalCap' in row) {
      assert(outcome.kind === 'unknown' && outcome.reason === 'configuration', label);
      assert.equal(outcome.detail?.check, 'max-tokens', label);
    } else {
      assert(outcome.kind === (row.stop === 'eosFound' ? 'completed' : 'failed'), label);
      assert('proof' in outcome && outcome.proof !== null, label);
      assert.equal(outcome.proof.maxTokens, cap, label);
      assert.equal(outcome.proof.renderedPromptTokens, row.prompt, label);
      assert.equal(
        outcome.proof.structured?.schemaHash,
        localStructuredOutput(plan.binding).schemaHash,
      );
      assert.deepEqual(TerminalSchema.parse(outcome), outcome);
      assert.equal(
        TerminalSchema.safeParse({
          ...outcome,
          proof: { ...outcome.proof, renderedPromptTokens: 8193 - cap },
        }).success,
        false,
      );
      if (outcome.kind === 'failed') assert.equal(outcome.reason, 'limit', label);
    }
  }
  for (const maximumOutputTokens of [2048, 4096] as const) {
    for (const row of [
      'invalid JSON',
      'fenced JSON',
      'unknown field',
      'wrong attempt',
      'wrong path',
      'wrong base',
      'malformed content',
      'invalid token count',
      'excess tokens',
      'prompt mismatch',
    ]) {
      const f = fixture();
      const run = startLocalPrediction(
        { ...plan, maximumOutputTokens },
        {
          createClient: () => f.client,
          schedule: f.schedule,
          now: () => 0,
        },
      );
      await flush();
      const value = terminal('eosFound', maximumOutputTokens);
      const proposal = JSON.parse(value.nonReasoningContent);
      if (row === 'invalid JSON') value.nonReasoningContent = '{"version":';
      if (row === 'fenced JSON')
        value.nonReasoningContent = `\x60\x60\x60json\n${value.nonReasoningContent}\n\x60\x60\x60`;
      if (row === 'unknown field')
        value.nonReasoningContent = JSON.stringify({ ...proposal, extra: true });
      if (row === 'wrong attempt')
        value.nonReasoningContent = JSON.stringify({
          ...proposal,
          attemptId: 'att_01J00000000000000000000002',
        });
      if (row === 'wrong path')
        value.nonReasoningContent = JSON.stringify({ ...proposal, path: 'other.mjs' });
      if (row === 'wrong base')
        value.nonReasoningContent = JSON.stringify({ ...proposal, baseHash: hash('other') });
      if (row === 'malformed content') value.nonReasoningContent = '\ud800';
      if (row === 'invalid token count')
        value.stats = { ...value.stats, ...{ predictedTokensCount: 1.5 } };
      if (row === 'excess tokens')
        value.stats = { ...value.stats, ...{ predictedTokensCount: maximumOutputTokens + 1 } };
      if (row === 'prompt mismatch') value.stats = { ...value.stats, ...{ promptTokensCount: 4 } };
      value.content = value.nonReasoningContent;
      f.resolve(value);
      const outcome = await run.result;
      const unproven = [
        'malformed content',
        'invalid token count',
        'excess tokens',
        'prompt mismatch',
      ].includes(row);
      assert.equal(outcome.kind, unproven ? 'unknown' : 'failed', row);
      assert(outcome.kind === 'unknown' || outcome.kind === 'failed');
      assert.equal(outcome.reason, 'protocol', row);
      if (outcome.kind === 'failed') {
        assert(outcome.proof);
        assert.equal(outcome.proof.stopReason, 'eosFound');
        assert.equal(outcome.proof.maxTokens, maximumOutputTokens);
      } else assert.equal('proof' in outcome, false);
      assert.equal(f.submitted, 1);
      assert.equal(f.cancelled, 0);
    }
  }
  for (const row of ['classified bytes', 'malformed reasoning', 'unsupported engine'] as const) {
    const f = fixture();
    const run = startLocalPrediction(plan, {
      createClient: () => f.client,
      schedule: f.schedule,
      now: () => 0,
    });
    await flush();
    const value = terminal();
    if (row === 'unsupported engine') f.reject(new Error('private engine refusal'));
    else {
      value.reasoningContent = row === 'malformed reasoning' ? '\ud800' : 'คิด';
      value.content = `<think>${value.reasoningContent}</think>${value.nonReasoningContent}`;
      f.resolve(value);
    }
    const outcome = await run.result;
    if (row === 'classified bytes') {
      assert(outcome.kind === 'completed');
      assert.deepEqual(outcome.proof.structured, {
        schemaHash: localStructuredOutput(plan.binding).schemaHash,
        reasoningBytes: Buffer.byteLength(value.reasoningContent),
        nonReasoningBytes: Buffer.byteLength(value.nonReasoningContent),
      });
      const { structured: _structured, ...oldProof } = outcome.proof;
      const historical = { ...outcome, proof: oldProof };
      assert.deepEqual(TerminalSchema.parse(historical), historical);
      for (const structured of [
        { ...outcome.proof.structured, reasoningBytes: -1 },
        { ...outcome.proof.structured, nonReasoningBytes: outcome.proof.outputBytes + 1 },
        { ...outcome.proof.structured, content: value.reasoningContent },
      ])
        assert.equal(
          TerminalSchema.safeParse({ ...outcome, proof: { ...outcome.proof, structured } }).success,
          false,
        );
      assert(!JSON.stringify(outcome.proof).includes(value.reasoningContent));
    } else {
      assert(outcome.kind === 'unknown');
      assert.equal(outcome.reason, row === 'unsupported engine' ? 'transport' : 'protocol');
      assert(!JSON.stringify(outcome).includes('private engine refusal'));
    }
    assert.equal(f.submitted, 1);
  }
  let completed!: LocalTerminal;
  const endings: Record<string, readonly [string, string, string] | undefined> = {
    'missing final newline': [
      'export const n = 1;\n',
      'export const n = 2;',
      'export const n = 2;\n',
    ],
    'missing final CRLF': [
      'export const n = 1;\r\n',
      'export const n = 2;',
      'export const n = 2;\r\n',
    ],
    'original without final newline': [
      'export const n = 1;',
      'export const n = 2;',
      'export const n = 2;',
    ],
  };
  for (const row of [
    'complete',
    'missing final newline',
    'missing final CRLF',
    'original without final newline',
    'omitted prediction draft with default load selectors',
    'omitted prediction draft with explicit load selectors',
    'stop',
    'completion race',
    'transport loss',
    'cancel timeout',
    'wrong terminal instance',
    'missing raw config',
    'duplicate raw config',
    'reasoning limit',
  ] as const) {
    const ending = endings[row];
    const input: LocalStart = ending
      ? { ...plan, original: ending[0], binding: { ...plan.binding, baseHash: hash(ending[0]) } }
      : plan;
    const f = fixture(input);
    let markers = 0;
    const run = startLocalPrediction(input, {
      createClient: () => f.client,
      schedule: f.schedule,
      now: () => 0,
      onSubmitted: () => {
        markers++;
      },
    });
    await flush();
    assert.equal(f.submitted, 1, row);
    assert.equal(markers, 1, row);
    assert.equal(f.prompt, 'rendered chat');
    assert.equal(f.options?.maxTokens, 2048);
    assert.equal(f.options?.contextOverflowPolicy, 'stopAtLimit');
    assert.equal(f.options?.draftModel, '');
    if (row === 'stop' || row === 'completion race' || row === 'cancel timeout') {
      run.stop();
      run.stop();
    }
    if (row === 'transport loss') f.reject(new Error('fixture transport failed'));
    else if (row === 'cancel timeout') {
      for (const timer of [...f.timers]) if (timer.active && timer.delay === 5000) timer.work();
    } else if (row === 'wrong terminal instance')
      f.resolve({ ...terminal(), modelInfo: { ...info, instanceReference: 'instance-2' } });
    else if (row === 'missing raw config') f.resolve({ ...terminal(), predictionConfig: kv({}) });
    else if (row === 'duplicate raw config') {
      const value = terminal();
      value.predictionConfig.fields.push(value.predictionConfig.fields[0]);
      f.resolve(value);
    } else if (row === 'reasoning limit') {
      f.options?.onPredictionFragment?.({
        content: 'x'.repeat(131_073),
        reasoningType: 'reasoning',
        isStructural: false,
        tokensCount: 2049,
        containsDrafted: false,
      });
      f.resolve(terminal('userStopped'));
    } else if (row.startsWith('omitted prediction draft')) {
      const value = terminal();
      value.predictionConfig.fields = value.predictionConfig.fields.filter(
        ({ key }) => key !== 'llm.prediction.speculativeDecoding.draftModel',
      );
      if (row === 'omitted prediction draft with explicit load selectors') {
        for (const key of [
          'draftMtp',
          'draftSimple',
          'draftDflashSidecar',
          'draftDsparkSidecar',
          'draftMtpSidecar',
        ])
          value.loadConfig.fields.push({
            key: `llm.load.speculativeDecoding.${key}`,
            value: false,
          });
        value.loadConfig.fields.push({ key: 'llm.load.speculativeDecoding.draftModel', value: '' });
        value.stats = { ...value.stats, ...{ usedDraftModelKey: '', totalDraftTokensCount: 0 } };
      }
      f.resolve(value);
    } else if (ending) f.resolve(terminal('eosFound', 2048, input, ending[1]));
    else f.resolve(terminal(row === 'stop' ? 'userStopped' : 'eosFound'));
    const outcome = await run.result;
    const expected =
      row === 'complete' ||
      ending ||
      row === 'completion race' ||
      row.startsWith('omitted prediction draft')
        ? 'completed'
        : row === 'stop'
          ? 'stopped'
          : row === 'reasoning limit'
            ? 'failed'
            : 'unknown';
    assert.equal(outcome.kind, expected, row);
    assert.equal(f.submitted, 1, row);
    assert.equal(
      f.cancelled,
      ['stop', 'completion race', 'cancel timeout', 'reasoning limit'].includes(row) ? 1 : 0,
      row,
    );
    if (outcome.kind === 'completed') {
      if (input === plan) completed = outcome;
      assert.equal(outcome.proposal.content, ending?.[2] ?? 'export const n = 2;\n', row);
      assert.equal(outcome.proof.promptTokens, null);
      assert.equal(outcome.proof.predictedTokens, null);
    }
  }
  const canary = 'private-config-value-must-not-escape';
  const setField = (config: ReturnType<typeof kv>, key: string, value: unknown) => {
    const field = config.fields.find((entry) => entry.key === key);
    assert(field);
    field.value = value;
  };
  const configurationCases: Array<{
    check: string;
    status: string;
    change: (value: ReturnType<typeof terminal>) => void;
  }> = [
    {
      check: 'structured-output',
      status: 'missing',
      change: (value) => {
        value.predictionConfig.fields = value.predictionConfig.fields.filter(
          ({ key }) => key !== 'llm.prediction.structured',
        );
      },
    },
    {
      check: 'structured-output',
      status: 'malformed',
      change: (value) => {
        setField(value.predictionConfig, 'llm.prediction.structured', { type: 'json' });
      },
    },
    {
      check: 'prediction-fields',
      status: 'duplicate',
      change: (value) => {
        value.predictionConfig.fields.push({
          key: 'llm.prediction.structured',
          value: localStructuredOutput(plan.binding).format,
        });
      },
    },
    {
      check: 'load-fields',
      status: 'malformed',
      change: (value) => {
        value.loadConfig = kv({ ['x'.repeat(201)]: canary });
      },
    },
    {
      check: 'load-fields',
      status: 'duplicate',
      change: (value) => {
        value.loadConfig.fields.push(value.loadConfig.fields[0]);
      },
    },
    {
      check: 'prediction-fields',
      status: 'malformed',
      change: (value) => {
        value.predictionConfig = kv({ ['x'.repeat(201)]: canary });
      },
    },
    {
      check: 'prediction-fields',
      status: 'duplicate',
      change: (value) => {
        value.predictionConfig.fields.push(value.predictionConfig.fields[0]);
      },
    },
    {
      check: 'context-length',
      status: 'missing',
      change: (value) => {
        value.loadConfig = kv({});
      },
    },
    {
      check: 'context-length',
      status: 'malformed',
      change: (value) => {
        setField(value.loadConfig, 'llm.load.contextLength', canary);
      },
    },
    {
      check: 'context-length',
      status: 'mismatch',
      change: (value) => {
        setField(value.loadConfig, 'llm.load.contextLength', 16384);
      },
    },
    {
      check: 'overflow-policy',
      status: 'missing',
      change: (value) => {
        value.predictionConfig = kv({});
      },
    },
    {
      check: 'overflow-policy',
      status: 'malformed',
      change: (value) => {
        setField(value.predictionConfig, 'llm.prediction.contextOverflowPolicy', canary);
      },
    },
    {
      check: 'overflow-policy',
      status: 'mismatch',
      change: (value) => {
        setField(value.predictionConfig, 'llm.prediction.contextOverflowPolicy', 'truncateMiddle');
      },
    },
    {
      check: 'draft-disabled',
      status: 'malformed',
      change: (value) => {
        setField(value.predictionConfig, 'llm.prediction.speculativeDecoding.draftModel', {
          private: canary,
        });
      },
    },
    {
      check: 'draft-disabled',
      status: 'mismatch',
      change: (value) => {
        setField(value.predictionConfig, 'llm.prediction.speculativeDecoding.draftModel', canary);
      },
    },
    {
      check: 'round-index',
      status: 'malformed',
      change: (value) => {
        value.roundIndex = Number.NaN;
      },
    },
    {
      check: 'round-index',
      status: 'mismatch',
      change: (value) => {
        value.roundIndex = 1;
      },
    },
    {
      check: 'max-tokens',
      status: 'missing',
      change: (value) => {
        value.predictionConfig.fields = value.predictionConfig.fields.filter(
          (entry) => entry.key !== 'llm.prediction.maxPredictedTokens',
        );
      },
    },
    {
      check: 'max-tokens',
      status: 'malformed',
      change: (value) => {
        setField(value.predictionConfig, 'llm.prediction.maxPredictedTokens', {
          checked: canary,
          value: 2048,
        });
      },
    },
    {
      check: 'max-tokens',
      status: 'mismatch',
      change: (value) => {
        setField(value.predictionConfig, 'llm.prediction.maxPredictedTokens', {
          checked: false,
          value: 2048,
        });
      },
    },
    {
      check: 'max-tokens',
      status: 'mismatch',
      change: (value) => {
        setField(value.predictionConfig, 'llm.prediction.maxPredictedTokens', {
          checked: true,
          value: 1024,
        });
      },
    },
  ];
  for (const field of ['attemptId', 'path', 'baseHash', 'additionalProperties'])
    configurationCases.push({
      check: 'structured-output',
      status: 'mismatch',
      change: (value) => {
        const structured = localStructuredOutput(plan.binding).format;
        if (field === 'additionalProperties') structured.jsonSchema.additionalProperties = true;
        else Object.assign(structured.jsonSchema.properties, { [field]: { const: canary } });
        setField(value.predictionConfig, 'llm.prediction.structured', structured);
      },
    });
  for (const key of [
    'draftMtp',
    'draftSimple',
    'draftDflashSidecar',
    'draftDsparkSidecar',
    'draftMtpSidecar',
    'draftModel',
    'unrecognizedDrafter',
  ])
    configurationCases.push({
      check: 'load-draft-disabled',
      status: 'mismatch',
      change: (value) => {
        value.loadConfig.fields.push({
          key: `llm.load.speculativeDecoding.${key}`,
          value: key === 'draftModel' ? canary : true,
        });
        value.predictionConfig.fields = value.predictionConfig.fields.filter(
          (entry) => entry.key !== 'llm.prediction.speculativeDecoding.draftModel',
        );
      },
    });
  for (const key of ['draftMtp', 'draftModel'])
    configurationCases.push({
      check: 'load-draft-disabled',
      status: 'malformed',
      change: (value) => {
        value.loadConfig.fields.push({ key: `llm.load.speculativeDecoding.${key}`, value: null });
      },
    });
  for (const key of [
    'usedDraftModelKey',
    'totalDraftTokensCount',
    'acceptedDraftTokensCount',
    'rejectedDraftTokensCount',
    'ignoredDraftTokensCount',
  ])
    configurationCases.push({
      check: 'draft-stats',
      status: 'mismatch',
      change: (value) => {
        value.stats = { ...value.stats, [key]: key === 'usedDraftModelKey' ? canary : 1 };
      },
    });
  for (const value of [canary, -1, Number.MAX_SAFE_INTEGER + 1])
    configurationCases.push({
      check: 'draft-stats',
      status: 'malformed',
      change: (terminal) => {
        terminal.stats = { ...terminal.stats, ...{ totalDraftTokensCount: value } };
      },
    });
  for (const row of configurationCases) {
    const f = fixture();
    const run = startLocalPrediction(plan, {
      createClient: () => f.client,
      now: () => 0,
      schedule: f.schedule,
    });
    await flush();
    const value = terminal();
    row.change(value);
    f.resolve(value);
    const outcome = await run.result;
    assert(outcome.kind === 'unknown');
    assert.equal(outcome.reason, 'configuration');
    assert.deepEqual(outcome.detail, {
      version: 1,
      stage: 'terminal',
      check: row.check,
      status: row.status,
    });
    assert.equal(f.submitted, 1);
    assert(!JSON.stringify(outcome).includes(canary));
    assert.deepEqual(TerminalSchema.parse(outcome), outcome);
    assert.equal(TerminalSchema.safeParse({ ...outcome, reason: 'transport' }).success, false);
    assert.equal(
      TerminalSchema.safeParse({ ...outcome, detail: { ...outcome.detail, value: canary } })
        .success,
      false,
    );
    assert.equal(
      TerminalSchema.safeParse({ ...outcome, detail: { ...outcome.detail, check: canary } })
        .success,
      false,
    );
    assert.equal(
      TerminalSchema.safeParse({ ...outcome, detail: { ...outcome.detail, stage: 'base' } })
        .success,
      false,
    );
    const { detail: _detail, ...legacy } = outcome;
    assert.deepEqual(TerminalSchema.parse(legacy), legacy);
  }
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-local-'));
  try {
    for (const row of [
      'client loss',
      'submitted client loss',
      'complete',
      'terminal before submission',
      'wrong output limit',
      'missing structured proof',
      'wrong structured proof',
      'bad then valid',
      'duplicate submission',
      'async marker',
      'resolved async marker',
      'spawn failed',
    ] as const) {
      const child = Object.assign(new EventEmitter(), {
        pid: row === 'spawn failed' ? undefined : 12345,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      let markers = 0,
        privateInput = '';
      child.stdin.on('data', (chunk) => {
        privateInput += chunk.toString();
      });
      const run = startLocalReplacement(plan, directory, {
        spawn: ((_executable: string, args: string[], launch: { env: Record<string, string> }) => {
          assert.equal(JSON.stringify(args).includes(plan.token), false);
          assert.equal(JSON.stringify(launch.env).includes(plan.token), false);
          return child;
        }) as unknown as typeof spawn,
        groupAbsent: () => true,
        lifecycle: { beforePhase() {}, owned() {}, quiescent() {} },
        now: () => 0,
        schedule: () => () => {},
        onSubmitted: (() => {
          markers++;
          if (row === 'async marker') return Promise.reject(new Error('fixture journal pending'));
          if (row === 'resolved async marker') return Promise.resolve();
        }) as () => undefined,
      });
      const ready = `${JSON.stringify({ type: 'ready', binding: plan.binding })}\n`;
      const done = `${JSON.stringify({ type: 'terminal', terminal: completed })}\n`;
      if (row !== 'client loss' && row !== 'terminal before submission' && row !== 'spawn failed')
        child.stdout.write(ready);
      if (row === 'complete' || row === 'terminal before submission') child.stdout.write(done);
      if (row === 'wrong output limit') {
        assert(completed.kind === 'completed');
        child.stdout.write(
          `${JSON.stringify({
            type: 'terminal',
            terminal: { ...completed, proof: { ...completed.proof, maxTokens: 4096 } },
          })}\n`,
        );
      }
      if (row === 'missing structured proof' || row === 'wrong structured proof') {
        assert(completed.kind === 'completed');
        const { structured, ...proof } = completed.proof;
        child.stdout.write(
          `${JSON.stringify({
            type: 'terminal',
            terminal: {
              ...completed,
              proof:
                row === 'missing structured proof'
                  ? proof
                  : {
                      ...proof,
                      structured: { ...structured, schemaHash: hash('different schema') },
                    },
            },
          })}\n`,
        );
      }
      if (row === 'bad then valid') child.stdout.write(`{}\n${done}`);
      if (row === 'duplicate submission') child.stdout.write(ready + done);
      if (row === 'spawn failed') child.emit('error', new Error('fixture spawn failed'));
      else {
        for (const stream of [child.stdout, child.stderr]) {
          const ended = once(stream, 'end');
          stream.end();
          stream.resume();
          await ended;
        }
        const finished = child.stdin.writableFinished
          ? Promise.resolve()
          : once(child.stdin, 'finish');
        child.stdin.end();
        await finished;
        child.emit('close', row === 'complete' ? 1 : 0, null);
      }
      const result = await run.result;
      assert.equal(result.clientQuiescent, true, row);
      const expected =
        row === 'complete'
          ? 'completed'
          : ['client loss', 'terminal before submission'].includes(row)
            ? 'failed'
            : 'unknown';
      assert.equal(result.terminal.kind, expected, row);
      if (row === 'async marker' || row === 'resolved async marker')
        assert.equal(privateInput.split('\n').includes(JSON.stringify('submit')), false);
      assert.equal(
        markers,
        row === 'client loss' || row === 'terminal before submission' || row === 'spawn failed'
          ? 0
          : 1,
      );
      assert.equal(privateInput.includes(plan.token), row !== 'spawn failed', row);
    }
    for (const boundary of [
      'complete',
      'before-failed',
      'before-async',
      'before-value',
      'before-deadline',
      'spawn-throw',
      'owned-failed',
      'owned-async',
      'owned-deadline',
      'ready-in-owned',
      'quiescent-failed',
      'quiescent-async',
      'quiescent-deadline',
      'missing-close',
      'group-present',
      'stdout-open',
      'stderr-open',
      'stop-before-ready',
      'stop-in-submitted',
      'close-in-submitted',
    ] as const) {
      let clock = 0;
      let absent = boundary !== 'group-present';
      const trace: string[] = [];
      let requestStop = () => {};
      const privateFrames: string[] = [];
      const timers: Array<() => void> = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      child.stdin.on('data', (bytes) => privateFrames.push(bytes.toString()));
      const ready = `${JSON.stringify({ type: 'ready', binding: plan.binding })}\n`;
      const launch = (): ReturnType<typeof startLocalReplacement> =>
        startLocalReplacement(plan, directory, {
          now: () => clock,
          schedule: (work) => {
            timers.push(work);
            return () => {};
          },
          signal: () => {},
          groupAbsent: () => absent,
          spawn: (() => {
            trace.push('spawn');
            if (boundary === 'spawn-throw') throw Error('synthetic spawn failure');
            return child;
          }) as unknown as typeof spawn,
          lifecycle: {
            beforePhase: (phase) => {
              assert.equal(phase, 'task');
              trace.push('before');
              if (boundary === 'before-failed') throw Error('synthetic intent failure');
              if (boundary === 'before-async')
                return Promise.reject(Error('synthetic async intent'));
              if (boundary === 'before-value') return 1;
              if (boundary === 'before-deadline') clock = plan.timeoutMs - 5000;
            },
            owned: (phase, group) => {
              assert.equal(phase, 'task');
              assert.equal(group, 12345);
              assert.equal(privateFrames.length, 0);
              trace.push('owned');
              if (boundary === 'owned-failed') throw Error('synthetic ownership failure');
              if (boundary === 'owned-async') return Promise.resolve();
              if (boundary === 'owned-deadline') clock = plan.timeoutMs - 5000;
              if (boundary === 'ready-in-owned') child.stdout.write(ready);
            },
            quiescent: (phase, group) => {
              assert.equal(phase, 'task');
              assert.equal(group, 12345);
              assert(child.stdout.readableEnded && child.stderr.readableEnded && absent);
              trace.push('quiescent');
              if (boundary === 'quiescent-failed') throw Error('synthetic closure failure');
              if (boundary === 'quiescent-async') return Promise.resolve();
              if (boundary === 'quiescent-deadline') clock = plan.timeoutMs;
            },
          },
          onSubmitted: () => {
            trace.push('submitted');
            if (boundary === 'stop-in-submitted') requestStop();
            if (boundary === 'close-in-submitted') child.emit('close');
          },
        });
      if (boundary.startsWith('before-') || boundary === 'spawn-throw') {
        assert.throws(launch);
        assert.deepEqual(trace, boundary === 'spawn-throw' ? ['before', 'spawn'] : ['before']);
        assert.equal(privateFrames.length, 0);
        continue;
      }
      const run = launch();
      requestStop = run.stop;
      if (boundary === 'stop-before-ready') run.stop();
      const ownershipRefused = [
        'owned-failed',
        'owned-async',
        'owned-deadline',
        'ready-in-owned',
      ].includes(boundary);
      if (!ownershipRefused) {
        assert(privateFrames.join('').includes(plan.token));
        child.stdout.write(ready);
        if (boundary !== 'stop-before-ready')
          child.stdout.write(`${JSON.stringify({ type: 'terminal', terminal: completed })}\n`);
      } else assert(!privateFrames.join('').includes(plan.token));
      for (const [stream, open] of [
        [child.stdout, 'stdout-open'],
        [child.stderr, 'stderr-open'],
      ] as const) {
        if (boundary === open) continue;
        const ended = once(stream, 'end');
        stream.end();
        stream.resume();
        await ended;
      }
      const finished = child.stdin.writableFinished
        ? Promise.resolve()
        : once(child.stdin, 'finish');
      child.stdin.end();
      await finished;
      if (boundary !== 'missing-close') child.emit('close');
      if (['missing-close', 'group-present'].includes(boundary)) {
        for (const work of [...timers]) work();
      }
      const result = await run.result;
      const physical = ![
        'missing-close',
        'group-present',
        'stdout-open',
        'stderr-open',
        'close-in-submitted',
      ].includes(boundary);
      assert.equal(result.clientQuiescent, physical, boundary);
      assert.equal(
        result.terminal.kind,
        boundary === 'complete'
          ? 'completed'
          : ['stop-before-ready', 'stop-in-submitted'].includes(boundary)
            ? 'failed'
            : 'unknown',
        boundary,
      );
      assert.equal(
        trace.filter((event) => event === 'quiescent').length,
        physical && !['owned-failed', 'owned-async'].includes(boundary) ? 1 : 0,
        boundary,
      );
      const priorTrace = [...trace];
      absent = true;
      child.emit('close');
      child.emit('exit');
      assert.deepEqual(trace, priorTrace, 'late closure cannot amend a settled ownership result');
      if (['stop-in-submitted', 'close-in-submitted'].includes(boundary))
        assert(!privateFrames.join('').split('\n').includes(JSON.stringify('submit')));
      if (ownershipRefused || boundary === 'stop-before-ready')
        assert(!trace.includes('submitted'));
      if (boundary === 'complete')
        assert.deepEqual(trace, ['before', 'spawn', 'owned', 'submitted', 'quiescent']);
    }
    const discoveryPlan: LocalDiscoveryStart = {
      kind: 'discovery',
      endpoint: plan.endpoint,
      token: plan.token,
      timeoutMs: 20000,
      binding: {
        version: 1,
        operationId: 'cmd_01J00000000000000000000001',
        nonce: hash('discovery operation'),
        connectionRevision: 3,
        connectionHash: localConfiguredConnectionHash(plan.endpoint, 3),
      },
    };
    const discovery = await discoverLocalModels(discoveryClient(fixture()), { now: () => 0 });
    assert(discovery.kind === 'observed');
    for (const boundary of [
      'complete',
      'complete-none',
      'before-failed',
      'before-async',
      'before-deadline',
      'owned-failed',
      'owned-async',
      'owned-deadline',
      'quiescent-failed',
      'quiescent-async',
      'missing-close',
      'group-present',
      'wrong-binding',
      'task-ready',
      'duplicate-terminal',
      'payload-limit',
      'stop',
      'deadline',
    ] as const) {
      let clock = 0;
      let absent = boundary !== 'group-present';
      const trace: string[] = [];
      const frames: string[] = [];
      const timers: Array<() => void> = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      child.stdin.on('data', (bytes) => frames.push(bytes.toString()));
      const { token: _discoveryToken, ...noTokenDiscovery } = discoveryPlan;
      const currentPlan: LocalDiscoveryStart =
        boundary === 'complete-none'
          ? {
              ...noTokenDiscovery,
              authMode: 'none',
              binding: {
                ...discoveryPlan.binding,
                connectionHash: localConfiguredConnectionHash(plan.endpoint, 3, 'none'),
              },
            }
          : discoveryPlan;
      if (boundary === 'complete-none') {
        assert.throws(() => localDiscoveryPlan({ ...currentPlan, binding: discoveryPlan.binding }));
        assert.throws(() => localDiscoveryPlan({ ...currentPlan, token: plan.token }));
        assert.equal(Object.hasOwn(localClientOptions(currentPlan, {}), 'apiToken'), false);
      }
      const launch = (): ReturnType<typeof startLocalDiscovery> =>
        startLocalDiscovery(currentPlan, directory, {
          now: () => clock,
          schedule: (work) => {
            timers.push(work);
            return () => {};
          },
          signal: () => {},
          groupAbsent: () => absent,
          spawn: ((
            _executable: string,
            args: string[],
            options: { env: Record<string, string> },
          ) => {
            trace.push('spawn');
            assert(!JSON.stringify([args, options]).includes(plan.token));
            assert.deepEqual(options.env, { HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8' });
            return child;
          }) as unknown as typeof spawn,
          lifecycle: {
            beforePhase: (phase) => {
              assert.equal(phase, 'discovery');
              trace.push('before');
              if (boundary === 'before-failed') throw new Error();
              if (boundary === 'before-async') return Promise.resolve();
              if (boundary === 'before-deadline') clock = 15000;
            },
            owned: (phase, group) => {
              assert.equal(phase, 'discovery');
              assert.equal(group, 12345);
              assert.equal(frames.length, 0);
              trace.push('owned');
              if (boundary === 'owned-failed') throw new Error();
              if (boundary === 'owned-async') return Promise.resolve();
              if (boundary === 'owned-deadline') clock = 15000;
            },
            quiescent: (phase, group) => {
              assert.equal(phase, 'discovery');
              assert.equal(group, 12345);
              assert(child.stdout.readableEnded && child.stderr.readableEnded && absent);
              trace.push('quiescent');
              if (boundary === 'quiescent-failed') throw new Error();
              if (boundary === 'quiescent-async') return Promise.resolve();
            },
          },
        });
      if (boundary.startsWith('before-')) {
        assert.throws(launch);
        assert.deepEqual(trace, ['before']);
        assert.equal(frames.length, 0);
        continue;
      }
      const run = launch();
      const refused = boundary.startsWith('owned-');
      if (refused) assert(!frames.join('').includes(plan.token));
      else {
        assert.equal(JSON.parse(frames[0]).kind, 'discovery');
        if (boundary === 'complete-none') {
          assert.equal(JSON.parse(frames[0]).authMode, 'none');
          assert(!Object.hasOwn(JSON.parse(frames[0]), 'token'));
        }
        assert(!frames[0].includes('attemptId'));
        if (boundary === 'stop') run.stop();
        if (boundary === 'deadline') clock = 20000;
        const terminal = {
          ...discovery,
          binding:
            boundary === 'wrong-binding'
              ? { ...discoveryPlan.binding, nonce: hash('other operation') }
              : currentPlan.binding,
        };
        const frame = `${JSON.stringify({ type: 'discovery', terminal })}\n`;
        if (boundary === 'task-ready')
          child.stdout.write(`${JSON.stringify({ type: 'ready', binding: plan.binding })}\n`);
        else if (boundary === 'payload-limit') child.stdout.write(' '.repeat(131073));
        else child.stdout.write(boundary === 'duplicate-terminal' ? frame + frame : frame);
      }
      for (const stream of [child.stdout, child.stderr]) {
        const ended = once(stream, 'end');
        stream.end();
        stream.resume();
        await ended;
      }
      const finished = child.stdin.writableFinished
        ? Promise.resolve()
        : once(child.stdin, 'finish');
      child.stdin.end();
      await finished;
      if (boundary !== 'missing-close') child.emit('close', 0, null);
      if (['missing-close', 'group-present'].includes(boundary))
        for (const work of [...timers]) work();
      const result = await run.result;
      assert.equal(
        result.terminal.kind,
        boundary === 'complete' || boundary === 'complete-none' ? 'observed' : 'unavailable',
        boundary,
      );
      assert.equal(
        result.clientQuiescent,
        !['missing-close', 'group-present'].includes(boundary),
        boundary,
      );
      if (boundary === 'stop')
        assert.equal(result.terminal.kind === 'unavailable' && result.terminal.reason, 'stopped');
      assert(!frames.join('').split('\n').includes(JSON.stringify('submit')));
      const savedTrace = [...trace];
      absent = true;
      child.emit('close');
      assert.deepEqual(trace, savedTrace);
      if (boundary === 'complete' || boundary === 'complete-none')
        assert.deepEqual(trace, ['before', 'spawn', 'owned', 'quiescent']);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
