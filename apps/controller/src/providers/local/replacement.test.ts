import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { LLMPredictionOpts, PredictionResult } from '@lmstudio/sdk';
import { type LocalStart, type LocalTerminal, localPlan } from './profile.ts';
import { startLocalReplacement } from './replacement.ts';
import { type LoadedModel, startLocalPrediction } from './sdk.ts';

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
      else child.emit('close', row === 'complete' ? 1 : 0, null);
      const result = await run.result;
      assert.equal(result.clientQuiescent, true);
      const expected =
        row === 'complete'
          ? 'completed'
          : [
                'client loss',
                'terminal before submission',
                'async marker',
                'resolved async marker',
                'spawn failed',
              ].includes(row)
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
      assert.ok(privateInput.includes(plan.token));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
