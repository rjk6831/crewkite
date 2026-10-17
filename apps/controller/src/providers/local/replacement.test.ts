import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { LLMPredictionOpts, PredictionResult } from '@lmstudio/sdk';
import { resolveLocalConnection } from './connection.ts';
import { type LocalStart, type LocalTerminal, localPlan } from './profile.ts';
import { startLocalReplacement } from './replacement.ts';
import {
  discoverLocalModels,
  type LoadedModel,
  type LocalDiscoveryClient,
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
  task: 'Change n to 2.',
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
function terminal(stopReason: 'eosFound' | 'userStopped' = 'eosFound') {
  const content = JSON.stringify({
    version: 1,
    attemptId: plan.binding.attemptId,
    path: plan.binding.path,
    baseHash: plan.binding.baseHash,
    content: 'export const n = 2;\n',
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
      'llm.prediction.maxPredictedTokens': { checked: true, value: 2048 },
      'llm.prediction.contextOverflowPolicy': 'stopAtLimit',
      'llm.prediction.speculativeDecoding.draftModel': '',
    }),
  } satisfies PredictionResult;
}
function fixture() {
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
      assert.ok(JSON.stringify(chat).includes(plan.original.trim()));
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

test('Local generation requires authenticated loopback and an exact loaded instance within context', async () => {
  for (const endpoint of [
    'ws://localhost:1234',
    'wss://127.0.0.1:1234',
    'ws://127.0.0.1:65536',
    'ws://127.0.0.1:1234/path',
    'ws://127.1:1234',
  ])
    assert.throws(() => localPlan({ ...plan, endpoint }), endpoint);
  for (const token of ['', ' ', '\0']) assert.throws(() => localPlan({ ...plan, token }));
  assert.throws(() => localPlan({ ...plan, original: 'changed' }));
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
  }
  for (const format of ['gguf', 'safetensors'] as const) {
    const f = fixture();
    const metadata = {
      ...info,
      format,
      selectedVariant: 'selected-variant',
      quantization: { name: 'arbitrary-quantization', bits: 6 },
    };
    f.model.getModelInfo = async () => metadata;
    const client = discoveryClient(f, [metadata]);
    const discovery = await discoverLocalModels(client, { now: () => 0 });
    assert.equal(discovery.kind, 'observed');
    assert(discovery.kind === 'observed');
    const choice = discovery.observation.models[0];
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
    const run = startLocalPrediction(genericPlan, {
      createClient: () => client,
      schedule: f.schedule,
      now: () => 0,
    });
    await flush();
    assert.equal(f.submitted, 1);
    f.resolve({ ...terminal(), modelInfo: metadata });
    assert.equal((await run.result).kind, 'completed');
    for (const drift of ['runtime', 'model-path', 'extra-resident'] as const) {
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
  let completed!: LocalTerminal;
  for (const row of [
    'complete',
    'stop',
    'completion race',
    'transport loss',
    'cancel timeout',
    'wrong terminal instance',
    'missing raw config',
    'duplicate raw config',
    'reasoning limit',
  ] as const) {
    const f = fixture();
    let markers = 0;
    const run = startLocalPrediction(plan, {
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
    } else f.resolve(terminal(row === 'stop' ? 'userStopped' : 'eosFound'));
    const outcome = await run.result;
    const expected =
      row === 'complete' || row === 'completion race'
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
      completed = outcome;
      assert.equal(outcome.proof.promptTokens, null);
      assert.equal(outcome.proof.predictedTokens, null);
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-local-'));
  try {
    for (const row of [
      'client loss',
      'submitted client loss',
      'complete',
      'terminal before submission',
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
      const launch = () =>
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
