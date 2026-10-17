import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { hashCanonical } from '@crewkite/contracts/hash';
import {
  localConfiguredConnectionHash,
  localConnectionHash,
  resolveLocalConnection,
} from './connection.ts';
import {
  type LocalInputChild,
  type LocalInputHelper,
  resolveLocalInputHelper,
  startLocalSecretInput,
} from './secure-input.ts';

const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const binding = {
  version: 1 as const,
  operationId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  nonce: 'a'.repeat(64),
  setupHash: 'b'.repeat(64),
  connectionHash: localConnectionHash('ws://127.0.0.1:1234', 'b'.repeat(64)),
  revision: 1,
};
const prompt = { binding, endpoint: 'ws://127.0.0.1:1234' };
const descriptor: LocalInputHelper = {
  root: '/owned/runtime',
  sha256: digest('synthetic helper'),
  sourceHash: digest('synthetic helper source'),
  target: 'darwin-arm64',
};
const secret = ' synthetic-connection-secret ';
const submitted = { binding, outcome: 'submitted', secret };
function frame(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}
function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const inputBytes: Buffer[] = [];
  input.on('data', (bytes: Buffer) => inputBytes.push(bytes));
  let onSpawn: (() => void) | undefined;
  let onError: (() => void) | undefined;
  let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let clock = 0,
    absent = false;
  const timers: Array<{ at: number; work: () => void; active: boolean }> = [];
  const launches: Array<{ executable: string; settings: unknown }> = [];
  const signals: NodeJS.Signals[] = [];
  const child: LocalInputChild = {
    group: 12345,
    input,
    output,
    onSpawn: (handler) => {
      onSpawn = handler;
    },
    onError: (handler) => {
      onError = handler;
    },
    onClose: (handler) => {
      onClose = handler;
    },
  };
  const options = {
    platform: 'darwin',
    arch: 'arm64',
    now: () => clock,
    schedule: (work: () => void, delay: number) => {
      const timer = { at: clock + delay, work, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
    verifyHelper: (value: LocalInputHelper) => {
      assert.deepEqual(value, descriptor);
      return '/owned/runtime/bin/local-secure-input';
    },
    launch: (executable: string, settings: unknown) => {
      launches.push({ executable, settings });
      return child;
    },
    groupAbsent: (group: number) => {
      assert.equal(group, 12345);
      return absent;
    },
    signal: (group: number, value: NodeJS.Signals) => {
      assert.equal(group, 12345);
      signals.push(value);
    },
  };
  return {
    options,
    child,
    input,
    output,
    launches,
    inputBytes,
    signals,
    spawn: () => onSpawn?.(),
    error: () => onError?.(),
    absent: () => {
      absent = true;
    },
    close: async (code: number | null = 0, signal: NodeJS.Signals | null = null, ended = true) => {
      if (ended) {
        const end = once(output, 'end');
        output.end();
        output.resume();
        await end;
      }
      onClose?.(code, signal);
    },
    jump: (milliseconds: number) => {
      clock += milliseconds;
    },
    advance: (milliseconds: number) => {
      clock += milliseconds;
      for (;;) {
        const next = timers
          .filter((value) => value.active && value.at <= clock)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        next.active = false;
        next.work();
      }
    },
  };
}

test('Local secret input returns one current private result after helper cleanup', async () => {
  const receipt = {
    version: 1,
    runtimeVersion: '0.4.26+4',
    artifactSha256: 'cd76ec205963b3b33350093e6904d9de16c4e666fd104e1f632d25c7f15f2a13',
    artifactSizeBytes: 5627044256,
    quantization: 'Q4_K_M',
    model: {
      modelKey: 'local-fixture',
      instanceReference: 'instance-1',
      modelSizeBytes: 5627044256,
    },
    contextLength: 8192,
    residentLlms: 1,
    embeddingInstances: 0,
    draftModel: '',
  };
  const capability = { platform: 'darwin', arch: 'arm64', secretConfigured: true };
  const configuration = { endpoint: prompt.endpoint, receipt };
  const resolved = resolveLocalConnection(configuration, capability);
  assert.equal(resolved.facts.available, true);
  assert.equal(resolved.facts.qualifiedAt, null);
  assert.equal(resolved.facts.reason, 'qualification-pending');
  assert.equal(resolved.facts.family, 'local');
  assert.equal(resolved.facts.billing, 'local');
  assert(!('creditPolicies' in resolved.facts));
  const runtime = { connectorId: 'local-sdk-v1', version: '0.5.0', build: 9 };
  const identity = {
    modelKey: 'fixture/new-model',
    displayName: 'Installed fixture',
    format: 'safetensors',
    sizeBytes: 1234567,
    quantization: { name: 'fixture-quant', bits: 6 },
    selectedVariant: 'fixture-variant',
    metadataHash: digest('runtime metadata'),
  };
  const selectionId = hashCanonical({ runtime, metadataHash: identity.metadataHash });
  const observed = {
    version: 1,
    runtime,
    residentLlms: 1,
    embeddingInstances: 0,
    models: [
      {
        selectionId,
        identity,
        instanceReference: 'new-instance',
        contextLength: 8192,
        state: 'loaded-eligible',
        reasons: [],
        qualification: 'unqualified',
      },
    ],
  };
  const selection = {
    endpoint: prompt.endpoint,
    connectionRevision: 2,
    selectionId,
    observation: { ...observed, observationHash: hashCanonical(observed) },
  };
  const selected = resolveLocalConnection(selection, capability);
  assert.equal(selected.facts.reason, 'qualification-pending');
  assert.equal(selected.facts.qualifiedAt, null);
  assert.equal(selected.connection?.modelBinding.modelKey, identity.modelKey);
  assert.equal(
    selected.connection?.connectionHash,
    localConfiguredConnectionHash(prompt.endpoint, 2),
  );
  assert.ok(selected.connection && 'version' in selected.connection.modelBinding);
  assert(!('artifactSha256' in selected.connection.modelBinding));
  assert.equal(
    selected.connection.modelBinding.setupHash,
    hashCanonical({
      version: 2,
      connectionHash: selected.connection.connectionHash,
      observationHash: selection.observation.observationHash,
      selectionId,
    }),
  );
  const changedConnection = resolveLocalConnection(
    { ...selection, connectionRevision: 3 },
    capability,
  );
  assert.notEqual(changedConnection.connection?.connectionHash, selected.connection.connectionHash);
  assert.notEqual(
    changedConnection.connection?.modelBinding.setupHash,
    selected.connection.modelBinding.setupHash,
  );
  for (const invalid of [
    { ...selection, selectionId: digest('missing choice') },
    { ...selection, observation: { ...selection.observation, observationHash: digest('stale') } },
    { ...selection, connectionRevision: -1 },
    { ...selection, receipt },
    { ...selection, observation: { ...selection.observation, models: [] } },
  ])
    assert.equal(resolveLocalConnection(invalid, capability).connection, null);
  const unloaded = {
    ...observed,
    residentLlms: 0,
    models: [
      {
        ...observed.models[0],
        instanceReference: null,
        contextLength: null,
        state: 'installed-unloaded',
      },
    ],
  };
  assert.equal(
    resolveLocalConnection(
      { ...selection, observation: { ...unloaded, observationHash: hashCanonical(unloaded) } },
      capability,
    ).connection,
    null,
  );
  assert.equal(
    resolveLocalConnection(configuration, { ...capability, secretConfigured: false }).facts
      .available,
    false,
  );
  for (const [input, platform] of [
    [null, capability],
    [configuration, { ...capability, platform: 'linux' }],
    [configuration, { ...capability, arch: 'x64' }],
    [{ ...configuration, token: secret }, capability],
    [{ ...configuration, endpoint: 'ws://localhost:1234' }, capability],
    [{ ...configuration, endpoint: 'ws://127.0.0.1:65536' }, capability],
    [{ ...configuration, receipt: { ...receipt, token: secret } }, capability],
    [{ ...configuration, receipt: { ...receipt, residentLlms: 2 } }, capability],
    [{ ...configuration, receipt: { ...receipt, embeddingInstances: 1 } }, capability],
    [{ ...configuration, receipt: { ...receipt, contextLength: 16384 } }, capability],
    [{ ...configuration, receipt: { ...receipt, draftModel: 'other' } }, capability],
    [{ ...configuration, receipt: { ...receipt, artifactSha256: 'e'.repeat(64) } }, capability],
    [
      {
        ...configuration,
        receipt: { ...receipt, model: { ...receipt.model, instanceReference: 'bad\ninstance' } },
      },
      capability,
    ],
  ] as const) {
    const refused = resolveLocalConnection(input, platform);
    assert.equal(refused.facts.available, false);
    assert.equal(refused.connection, null);
    assert(!JSON.stringify(refused).includes(secret));
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'local-input-')));
  try {
    mkdirSync(join(directory, 'bin'));
    const executable = join(directory, 'bin/local-secure-input');
    writeFileSync(executable, 'synthetic helper', { mode: 0o500 });
    const helper = { ...descriptor, root: directory };
    assert.equal(resolveLocalInputHelper(helper), executable);
    assert.throws(() => resolveLocalInputHelper({ ...helper, sha256: 'f'.repeat(64) }));
    assert.throws(() => resolveLocalInputHelper({ ...helper, token: secret }));
    chmodSync(executable, 0o520);
    assert.throws(() => resolveLocalInputHelper(helper));
    chmodSync(executable, 0o500);
    chmodSync(executable, 0o700);
    for (const size of [0, 1024 * 1024 + 1]) {
      truncateSync(executable, size);
      assert.throws(() => resolveLocalInputHelper(helper));
    }
    rmSync(executable);
    symlinkSync('/dev/null', executable);
    assert.throws(() => resolveLocalInputHelper(helper));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const valid = fixture();
  const owner = startLocalSecretInput(prompt, descriptor, valid.options);
  valid.spawn();
  assert.deepEqual(valid.launches, [
    {
      executable: '/owned/runtime/bin/local-secure-input',
      settings: {
        cwd: descriptor.root,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
        env: { LANG: 'C.UTF-8' },
      },
    },
  ]);
  assert(!Buffer.concat(valid.inputBytes).includes(Buffer.from(secret)));
  const resultBytes = frame(submitted);
  for (const bytes of [
    resultBytes.subarray(0, 2),
    resultBytes.subarray(2, 11),
    resultBytes.subarray(11),
  ])
    valid.output.write(bytes);
  let settled = false;
  void owner.result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  valid.absent();
  await valid.close();
  const ready = await owner.result;
  assert.equal(ready.kind, 'ready');
  if (ready.kind === 'ready') assert(Object.isFrozen(ready.binding));
  assert(!JSON.stringify(ready).includes(secret));
  assert(!inspect(ready, { showHidden: true }).includes(secret));
  if (ready.kind !== 'ready') throw Error('Expected a private candidate.');
  assert.equal(ready.candidate.take(binding), secret);
  assert.equal(ready.candidate.take(binding), null);

  for (const boundary of ['late-frame', 'late-close-timer', 'late-close-delayed-timer'] as const) {
    const child = fixture();
    const current = startLocalSecretInput(prompt, descriptor, child.options);
    if (boundary === 'late-frame') child.jump(62000);
    else child.jump(59000);
    child.output.write(frame(submitted));
    if (boundary === 'late-close-timer') child.advance(3000);
    if (boundary === 'late-close-delayed-timer') child.jump(3000);
    child.absent();
    await child.close();
    const result = await current.result;
    assert.equal(result.kind, boundary === 'late-frame' ? 'failed' : 'ready');
    if (result.kind === 'ready') result.candidate.discard();
  }
  const lateVerification = fixture();
  const verifying = startLocalSecretInput(prompt, descriptor, {
    ...lateVerification.options,
    verifyHelper: (helper) => {
      lateVerification.jump(60000);
      return lateVerification.options.verifyHelper(helper);
    },
  });
  assert.equal(lateVerification.launches.length, 0);
  assert.deepEqual(await verifying.result, {
    kind: 'failed',
    reason: 'deadline',
    clientQuiescent: true,
  });

  for (const payload of [
    { ...submitted, binding: { ...binding, nonce: 'e'.repeat(64) } },
    { ...submitted, binding: { ...binding, revision: 2 } },
    { ...submitted, secret: '' },
    { ...submitted, secret: ' ' },
    { ...submitted, secret: 'a'.repeat(4097) },
    { ...submitted, secret: 'x\ny' },
    { ...submitted, secret: 'x\u2028y' },
    { ...submitted, secret: '\ud800' },
    { ...submitted, extra: true },
  ]) {
    const child = fixture();
    const current = startLocalSecretInput(prompt, descriptor, child.options);
    child.output.write(frame(payload));
    child.absent();
    await child.close();
    const result = await current.result;
    assert.equal(result.kind, 'failed');
    assert(!JSON.stringify(result).includes(secret));
  }
  for (const bytes of [
    Buffer.concat([frame(submitted), frame(submitted)]),
    Buffer.concat([frame(submitted), Buffer.from([0])]),
    Buffer.from([0, 0, 0, 1, 0xff]),
    Buffer.from([0, 0, 128, 1]),
    frame(submitted).subarray(0, 20),
  ]) {
    const child = fixture();
    const current = startLocalSecretInput(prompt, descriptor, child.options);
    child.output.write(bytes);
    child.absent();
    await child.close();
    assert.equal((await current.result).kind, 'failed');
  }
  for (const outcome of ['cancelled', 'failed'] as const) {
    const child = fixture();
    const current = startLocalSecretInput(prompt, descriptor, child.options);
    child.output.write(frame({ binding, outcome }));
    child.absent();
    await child.close();
    assert.equal((await current.result).kind, outcome === 'cancelled' ? 'cancelled' : 'failed');
  }
  for (const boundary of [
    'group-present',
    'exit-failed',
    'signal',
    'streams-open',
    'stop',
    'deadline',
  ] as const) {
    const child = fixture();
    const current = startLocalSecretInput(prompt, descriptor, child.options);
    child.output.write(frame(submitted));
    if (boundary !== 'group-present') child.absent();
    if (boundary === 'stop') current.stop();
    if (boundary === 'deadline') child.advance(65000);
    else
      await child.close(
        boundary === 'exit-failed' ? 1 : 0,
        boundary === 'signal' ? 'SIGTERM' : null,
        boundary !== 'streams-open',
      );
    if (boundary === 'group-present') child.advance(5000);
    assert.equal((await current.result).kind, 'failed');
  }
  for (const boundary of ['wrong-binding', 'revoke-ready'] as const) {
    const child = fixture();
    const current = startLocalSecretInput(prompt, descriptor, child.options);
    child.output.write(frame(submitted));
    child.absent();
    await child.close();
    const result = await current.result;
    if (result.kind !== 'ready') throw Error('Expected a private candidate.');
    if (boundary === 'revoke-ready') current.stop();
    assert.equal(
      result.candidate.take(boundary === 'wrong-binding' ? { ...binding, revision: 2 } : binding),
      null,
    );
    assert.equal(result.candidate.take(binding), null);
  }
  const missing = fixture();
  const waiting = startLocalSecretInput(prompt, descriptor, missing.options);
  missing.advance(65000);
  assert.equal((await waiting.result).kind, 'failed');
  assert(missing.signals.includes('SIGKILL'));
  const failedSpawn = fixture();
  failedSpawn.child.group = 0;
  const launching = startLocalSecretInput(prompt, descriptor, failedSpawn.options);
  failedSpawn.error();
  await failedSpawn.close(1);
  assert.deepEqual(await launching.result, {
    kind: 'failed',
    reason: 'helper',
    clientQuiescent: true,
  });
  for (const invalid of [
    { ...prompt, token: secret },
    { ...prompt, endpoint: 'ws://localhost:1234' },
    { ...prompt, binding: { ...binding, connectionHash: 'f'.repeat(64) } },
  ])
    assert.throws(
      () => startLocalSecretInput(invalid, descriptor, fixture().options),
      /Local input configuration is unavailable/,
    );
});
