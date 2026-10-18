import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ApprovalBinding } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { AcpPeerCase } from '../../../../../../packages/testkit/src/providers/acp-peer.ts';
import { spawnCheckChild } from '../../../host/check-ownership.ts';
import { groupAbsent } from '../../../host/worker.ts';
import {
  AcpConnection,
  AcpDiagnosticSchema,
  AcpError,
  type AcpLifecycle,
  type AcpSpawn,
} from './client.ts';
import { type AcpImportDependencies, importGoogleAcp } from './import.ts';
import {
  type AcpReviewMapping,
  type AcpSetupProof,
  acpClientPin,
  GoogleAcpReviewMappings,
  googleAcpDeveloperIdRequirement,
  readGoogleAcpPin,
  resolveGoogleAcpProfile,
  validateAcpSetupProof,
} from './profile.ts';
import {
  AcpPermissionActionSchema,
  type AcpPermissionProposal,
  type AcpTargetSnapshot,
  type AcpToolMapping,
  acpPermissionAfterHash,
  decodeAcpConfiguration,
  decodeAcpPermissionAction,
  GoogleAcpToolMappings,
  googleAcpWriterPlan,
  startGoogleAcpSetup,
  startGoogleAcpWriter,
} from './writer.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const attemptId = `att_${suffix}`;
const selection = {
  proofId: `art_${suffix}`,
  modelId: 'fixture-model',
  thoughtLevelId: 'fixture-low',
};
const original = 'export const total = 0;\n';
const harness = '#!/bin/sh\nexit 99\n';
const target = { path: 'net.mjs', baseHash: hash(original), mode: '100644' as const };
const environment = {
  HOME: userInfo().homedir,
  PATH: process.env.PATH,
  USER: 'fixture',
  SECRET_TOKEN: 'must-not-escape',
  BROWSER: 'must-not-escape',
};
function fixture(scenario: AcpPeerCase) {
  mkdirSync(resolve('internal'), { recursive: true });
  const home = mkdtempSync(resolve('internal/acp-peer-'));
  const executable = join(home, 'peer');
  const peer = fileURLToPath(
    new URL('../../../../../../packages/testkit/src/providers/acp-peer.ts', import.meta.url),
  );
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport {runAcpPeer} from ${JSON.stringify(new URL(`file://${peer}`).href)};runAcpPeer(${JSON.stringify(scenario)});\n`,
    { mode: 0o500 },
  );
  writeFileSync(join(home, 'localharness_external'), harness, { mode: 0o500 });
  const client = {
    executable,
    harnessSha256: hash(harness),
    version: '1.4.0' as const,
    sha256: hash(readFileSync(executable)),
    signerTeamId: 'TESTTEAM01',
  };
  const mapping: AcpReviewMapping = {
    client: acpClientPin(client),
    surface: 'config',
    configId: 'mode-slot',
    valueId: 'fixture-review',
    semantics: 'request-review',
    evidenceHash: 'e'.repeat(64),
  };
  const toolMapping: AcpToolMapping = {
    client: acpClientPin(client),
    toolName: 'fixture-replace',
    schema: 'replace-target-v1',
    evidenceHash: 'f'.repeat(64),
  };
  const hunkMapping: AcpToolMapping = {
    client: { ...acpClientPin(client), harnessSha256: client.harnessSha256 },
    toolTitle: 'Run replace_file_content?',
    schema: 'replace-hunk-v1',
    evidenceHash: 'f'.repeat(64),
  };
  const configOptions = {
    model: {
      optionId: 'model-slot',
      currentValue: 'fixture-model',
      supported: ['fixture-model', 'fixture-other'],
    },
    thoughtLevel: {
      optionId: 'thought-slot',
      currentValue: 'fixture-low',
      supported: ['fixture-low'],
    },
  };
  const modeValues = [
    { optionId: 'mode-slot', valueId: 'fixture-review' },
    { optionId: 'mode-slot', valueId: 'fixture-open' },
  ];
  const proof: AcpSetupProof = {
    version: 1,
    profileId: 'google-acp-v1',
    client: acpClientPin(client),
    capabilities: {
      protocolVersion: 1,
      authMethods: ['oauth-personal'],
      sessionClose: scenario !== 'no-close',
      fs: false,
      terminal: false,
    },
    auth: { method: 'oauth-personal', status: 'authenticated' },
    configOptions,
    modeValues,
    reviewMode: {
      surface: 'config',
      configId: mapping.configId,
      valueId: mapping.valueId,
      semantics: 'request-review',
      mappingEvidenceHash: mapping.evidenceHash,
      discoveryStateHash: hashCanonical({ configOptions, modeValues }),
    },
  };
  const scratch = join(home, 'scratch');
  mkdirSync(scratch, { mode: 0o700 });
  writeFileSync(join(scratch, target.path), original);
  let directoryNumber = 0;
  const groups: number[] = [];
  const phases: string[] = [];
  const lifecycle: AcpLifecycle = {
    beforePhase: () => {
      phases.push('intent');
    },
    owned: (g) => {
      groups.push(g);
      phases.push('owned');
    },
    quiescent: (g) => {
      assert(groupAbsent(g));
      phases.push('quiescent');
    },
  };
  const directory = () => {
    const p = join(home, `runtime-${++directoryNumber}`);
    mkdirSync(p, { mode: 0o700 });
    return p;
  };
  const plan = () =>
    googleAcpWriterPlan({
      attemptId,
      generation: 0,
      target,
      criteria: ['Set total to one.'],
      selection,
      proof,
      reviewMappings: [mapping],
    });
  return {
    home,
    client,
    mapping,
    toolMapping,
    hunkMapping,
    proof,
    scratch,
    directory,
    plan,
    groups,
    phases,
    lifecycle,
    dispose: () => {
      for (const g of groups) assert(groupAbsent(g));
      rmSync(home, { recursive: true, force: true });
    },
  };
}
function binding(proposal: AcpPermissionProposal): ApprovalBinding {
  return {
    approvalId: `apr_${suffix}`,
    taskId: `tsk_${suffix}`,
    attemptId,
    generation: 0,
    action: proposal.action,
    target: proposal.target,
    acpTarget: proposal.acpTarget,
    revision: 1,
  };
}
function writer(
  f: ReturnType<typeof fixture>,
  callbacks: Partial<Parameters<typeof startGoogleAcpWriter>[0]> = {},
) {
  return startGoogleAcpWriter({
    client: f.client,
    directory: f.directory(),
    scratch: f.scratch,
    environment,
    plan: f.plan(),
    reviewMappings: [f.mapping],
    toolMappings: [f.toolMapping],
    lifecycle: f.lifecycle,
    spawn: spawnCheckChild as AcpSpawn,
    mcpServer: {
      name: 'crewkite-context',
      command: process.execPath,
      args: ['fixture-context'],
      env: [],
    },
    onSubmitted() {},
    onPermission: binding,
    onActivity() {},
    ...callbacks,
  });
}

test('the acp writer binds an imported client and observed configuration before one prompt', async () => {
  const large = fixture('complete');
  try {
    const staged = join(large.home, 'imports/google-acp-v1');
    mkdirSync(staged, { recursive: true, mode: 0o700 });
    const server = join(staged, 'agy_acp_server.par');
    writeFileSync(server, '', { mode: 0o600 });
    const bytes = 280_980_064;
    truncateSync(server, bytes);
    const digest = createHash('sha256');
    const block = Buffer.alloc(65536);
    for (let remaining = bytes; remaining > 0; remaining -= Math.min(remaining, block.length))
      digest.update(block.subarray(0, Math.min(remaining, block.length)));
    const sha256 = digest.digest('hex');
    writeFileSync(join(staged, 'localharness_external'), harness, { mode: 0o600 });
    writeFileSync(
      join(staged, 'identity.json'),
      JSON.stringify({ ...acpClientPin(large.client), sha256, harnessSha256: hash(harness) }),
      { mode: 0o600 },
    );
    const imported = await importGoogleAcp(
      { home: large.home, consent: 'explicit' },
      {
        verifySignature: async ({ client }) => ({
          verified: true,
          quiescent: true,
          signerTeamId: client.signerTeamId,
          requirement: googleAcpDeveloperIdRequirement(client.signerTeamId),
        }),
      },
    );
    assert.equal(imported.reason, 'imported');
    assert.equal(imported.client?.sha256, sha256);
  } finally {
    large.dispose();
  }
  const f = fixture('complete');
  try {
    const staging = join(f.home, 'imports/google-acp-v1');
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    writeFileSync(join(staging, 'agy_acp_server.par'), readFileSync(f.client.executable), {
      mode: 0o600,
    });
    writeFileSync(join(staging, 'localharness_external'), harness, { mode: 0o600 });
    writeFileSync(
      join(staging, 'identity.json'),
      JSON.stringify({ ...acpClientPin(f.client), harnessSha256: f.client.harnessSha256 }),
      {
        mode: 0o600,
      },
    );
    let signatures = 0;
    const dependencies: AcpImportDependencies = {
      verifySignature: async ({ client, executable }) => {
        signatures++;
        assert.equal(
          executable,
          join(f.home, 'providers/google-acp-v1', f.client.sha256, basename(executable)),
        );
        const expected = readFileSync(executable);
        assert.equal(hash(expected), client.sha256);
        writeFileSync(join(staging, basename(executable)), 'different staged bytes');
        await Promise.resolve();
        assert.deepEqual(readFileSync(executable), expected);
        writeFileSync(join(staging, basename(executable)), expected);
        return {
          verified: true as const,
          signerTeamId: client.signerTeamId,
          requirement: googleAcpDeveloperIdRequirement(client.signerTeamId),
          quiescent: true as const,
        };
      },
    };
    const imported = await importGoogleAcp({ home: f.home, consent: 'explicit' }, dependencies);
    assert.equal(imported.reason, 'imported');
    assert.equal(
      (await importGoogleAcp({ home: f.home, consent: 'explicit' }, dependencies)).reason,
      'already-imported',
    );
    assert.equal(signatures, 2);
    for (const failure of [
      'team',
      'requirement',
      'ownership',
      'managed-mutation',
      'parent-mutation',
      'deadline',
      'bundle-deadline',
      'missing-harness',
      'harness-digest',
      'harness-signature',
      'harness-mutation',
      'identity-mutation',
    ] as const) {
      const row = fixture('complete');
      try {
        const staged = join(row.home, 'imports/google-acp-v1');
        mkdirSync(staged, { recursive: true, mode: 0o700 });
        writeFileSync(join(staged, 'agy_acp_server.par'), readFileSync(row.client.executable), {
          mode: 0o600,
        });
        if (failure !== 'missing-harness')
          writeFileSync(
            join(staged, 'localharness_external'),
            failure === 'harness-digest' ? 'changed' : harness,
            { mode: 0o600 },
          );
        writeFileSync(
          join(staged, 'identity.json'),
          JSON.stringify({ ...acpClientPin(row.client), harnessSha256: row.client.harnessSha256 }),
          {
            mode: 0o600,
          },
        );
        let clock = 0;
        const mutation: AcpImportDependencies =
          failure === 'deadline' || failure === 'bundle-deadline'
            ? {
                now: () => clock,
                schedule: () => () => {},
                spawn: (program, args, options) => {
                  assert.equal(program, '/usr/bin/codesign');
                  assert(
                    args.includes(`=${googleAcpDeveloperIdRequirement(row.client.signerTeamId)}`),
                  );
                  const child = spawnCheckChild(row.client.executable, [], options);
                  if (child.pid) row.groups.push(child.pid);
                  child.once('close', () => {
                    clock = failure === 'deadline' ? 5000 : clock + 2500;
                  });
                  return child;
                },
              }
            : {
                verifySignature: async ({ executable }) => {
                  if (failure === 'managed-mutation') {
                    const original = readFileSync(executable);
                    chmodSync(executable, 0o700);
                    writeFileSync(executable, 'changed');
                    writeFileSync(executable, original);
                    chmodSync(executable, 0o500);
                  }
                  if (failure === 'harness-mutation') {
                    const helper = join(dirname(executable), 'localharness_external');
                    chmodSync(helper, 0o700);
                    writeFileSync(helper, 'changed');
                    writeFileSync(helper, harness);
                    chmodSync(helper, 0o500);
                  }
                  if (failure === 'identity-mutation')
                    writeFileSync(join(staged, 'identity.json'), '{}');
                  if (failure === 'parent-mutation')
                    writeFileSync(join(executable, '..', 'unexpected'), 'changed');
                  return {
                    verified: true,
                    quiescent: failure !== 'ownership',
                    signerTeamId:
                      failure === 'team' ||
                      (failure === 'harness-signature' &&
                        basename(executable) === 'localharness_external')
                        ? 'WRONGTEAM1'
                        : row.client.signerTeamId,
                    requirement:
                      failure === 'requirement'
                        ? 'printed team only'
                        : googleAcpDeveloperIdRequirement(row.client.signerTeamId),
                  } as never;
                },
              };
        const result = await importGoogleAcp({ home: row.home, consent: 'explicit' }, mutation);
        assert.equal(result.imported, false, failure);
        assert.throws(() => readGoogleAcpPin(row.home));
      } finally {
        row.dispose();
      }
    }
    const managed = readGoogleAcpPin(f.home);
    assert.equal(managed.sha256, f.client.sha256);
    assert.equal(managed.harnessSha256, f.client.harnessSha256);
    assert.equal(
      readFileSync(join(dirname(managed.executable), 'localharness_external'), 'utf8'),
      harness,
    );
    const helperPath = join(dirname(managed.executable), 'localharness_external');
    chmodSync(helperPath, 0o700);
    writeFileSync(helperPath, 'changed');
    chmodSync(helperPath, 0o500);
    assert.throws(() => readGoogleAcpPin(f.home));
    chmodSync(helperPath, 0o700);
    writeFileSync(helperPath, harness);
    chmodSync(helperPath, 0o500);
    assert.equal(
      resolveGoogleAcpProfile({ home: f.home, proof: f.proof, environment }).facts.available,
      false,
    );
    const resolved = () =>
      resolveGoogleAcpProfile(
        { home: f.home, proof: f.proof, environment },
        { reviewMappings: [f.mapping] },
      ).facts.available;
    assert.equal(resolved(), true);
    // Resolution repeats on every notification. An unchanged client is not
    // read again, and a same-size rewrite in place is still detected.
    const rewritten = readFileSync(managed.executable);
    rewritten[0] ^= 1;
    const opens = mock.method(fs, 'openSync');
    syncBuiltinESMExports();
    try {
      const openedManaged = () =>
        opens.mock.calls.filter((call) =>
          [managed.executable, helperPath].includes(String(call.arguments[0])),
        ).length;
      assert.equal(resolved(), true);
      assert.equal(openedManaged(), 0);
      chmodSync(managed.executable, 0o700);
      writeFileSync(managed.executable, rewritten);
      chmodSync(managed.executable, 0o500);
      opens.mock.resetCalls();
      assert.equal(resolved(), false);
      assert.equal(openedManaged(), 1);
    } finally {
      opens.mock.restore();
      syncBuiltinESMExports();
    }
    chmodSync(managed.executable, 0o700);
    writeFileSync(managed.executable, 'changed');
    chmodSync(managed.executable, 0o500);
    assert.throws(() => readGoogleAcpPin(f.home));
    assert.equal(
      (await importGoogleAcp({ home: f.home, consent: 'explicit' }, dependencies)).imported,
      false,
    );
    const linked = join(f.home, 'linked');
    symlinkSync(f.client.executable, linked);
    assert.throws(() =>
      startGoogleAcpSetup({
        client: { ...f.client, executable: linked },
        directory: f.directory(),
        environment,
        operation: 'initialize',
        priorProof: null,
        lifecycle: f.lifecycle,
      }),
    );
    const init = await startGoogleAcpSetup({
      client: f.client,
      directory: f.directory(),
      environment,
      operation: 'initialize',
      priorProof: null,
      lifecycle: f.lifecycle,
      spawn: spawnCheckChild as AcpSpawn,
    }).result;
    assert.equal(init.reason, null);
    assert(init.quiescent && init.metadata);
    const auth = await startGoogleAcpSetup({
      client: f.client,
      directory: f.directory(),
      environment,
      operation: 'authenticate',
      priorProof: init.metadata,
      lifecycle: f.lifecycle,
      spawn: spawnCheckChild as AcpSpawn,
    }).result;
    assert.equal(auth.reason, null);
    assert(auth.metadata);
    const discovery = await startGoogleAcpSetup({
      client: f.client,
      directory: f.directory(),
      environment,
      operation: 'discover',
      priorProof: auth.metadata,
      lifecycle: f.lifecycle,
      spawn: spawnCheckChild as AcpSpawn,
    }).result;
    assert.equal(discovery.reason, null);
    assert.equal(discovery.metadata?.reviewMode, null);
    assert(discovery.metadata?.configOptions);
    const immediateUpdates = fixture('session-update');
    try {
      const observed = await startGoogleAcpSetup({
        client: immediateUpdates.client,
        directory: immediateUpdates.directory(),
        environment,
        operation: 'discover',
        priorProof: immediateUpdates.proof,
        lifecycle: immediateUpdates.lifecycle,
        reviewMappings: [immediateUpdates.mapping],
        spawn: spawnCheckChild as AcpSpawn,
      }).result;
      assert.equal(observed.reason, null);
      assert(observed.metadata?.reviewMode);
    } finally {
      immediateUpdates.dispose();
    }
    for (const mutate of [
      () =>
        googleAcpWriterPlan({
          attemptId,
          generation: 0,
          target,
          criteria: ['Edit.'],
          selection,
          proof: f.proof,
        }),
      () =>
        googleAcpWriterPlan({
          attemptId,
          generation: 0,
          target,
          criteria: ['Edit.'],
          selection: { ...selection, modelId: 'unknown-model' },
          proof: f.proof,
          reviewMappings: [f.mapping],
        }),
      () => writer(f, { client: { ...f.client, sha256: '0'.repeat(64) } }),
    ])
      assert.throws(mutate);
    const rows: AcpPeerCase[] = [
      'bad-version',
      'bad-frame',
      'bad-ack',
      'model-ack-drift',
      'mode-ack-drift',
      'lost-mode-ack',
      'corrected-model-ack',
      'corrected-mode-ack',
      'missing-thought',
      'missing-mode',
    ];
    for (const scenario of rows) {
      const row = fixture(scenario);
      let submitted = 0;
      try {
        const outcome = await writer(row, {
          onSubmitted: () => {
            submitted++;
          },
        }).result;
        assert.equal(submitted, 0, scenario);
        assert(outcome.reason, scenario);
        assert(outcome.quiescent, scenario);
      } finally {
        row.dispose();
      }
    }
    let outputs = 0;
    const markerFailure = await writer(f, {
      onSubmitted: () => {
        throw Error('marker persistence failed');
      },
      onActivity: () => {
        outputs++;
      },
    }).result;
    assert(markerFailure.reason);
    assert.equal(outputs, 0);
    let stoppedAtMarker: ReturnType<typeof writer>;
    stoppedAtMarker = writer(f, {
      onSubmitted: () => stoppedAtMarker.stop(),
      onActivity: () => assert.fail('Stop before prompt sends no turn.'),
    });
    assert.equal((await stoppedAtMarker.result).metadata, null);
    for (const expiration of ['before-marker', 'after-marker'] as const) {
      const row = fixture('complete');
      let clock = 0,
        markers = 0,
        outputs = 0;
      try {
        const expired = writer(row, {
          now: () => clock,
          schedule: () => () => {},
          spawn: (program, args, opts) => {
            const child = spawnCheckChild(program, args, opts);
            const write = child.stdin.write.bind(child.stdin);
            child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
              if (
                expiration === 'before-marker' &&
                String(chunk).includes('"configId":"mode-slot"')
              )
                clock = 299000;
              return Reflect.apply(write, child.stdin, [chunk, ...rest]);
            }) as typeof child.stdin.write;
            return child;
          },
          onSubmitted: () => {
            markers++;
            if (expiration === 'after-marker') clock = 300000;
          },
          onActivity: () => {
            outputs++;
          },
        });
        const outcome = await expired.result;
        assert.equal(outcome.reason, 'deadline');
        assert.equal(outcome.metadata, null);
        assert(outcome.quiescent);
        assert.equal(markers, expiration === 'before-marker' ? 0 : 1);
        assert.equal(outputs, 0);
      } finally {
        row.dispose();
      }
    }
    let submitted = 0;
    const outcome = await writer(f, {
      onSubmitted: () => {
        submitted++;
      },
    }).result;
    assert.equal(submitted, 1);
    assert.equal(outcome.reason, null);
    assert.equal(outcome.metadata?.stopReason, 'end_turn');
    assert.equal(readFileSync(join(f.scratch, 'net.mjs'), 'utf8'), 'export const total = 1;\n');
    assert.deepEqual(
      decodeAcpConfiguration([
        { id: 'unknown', name: 'Unknown', type: 'future', currentValue: null },
      ]).configOptions,
      null,
    );
  } finally {
    f.dispose();
  }
});

test('the acp protocol consumes one complete live permission and never treats context usage as allowance', async () => {
  const hunkFixture = fixture('hunk');
  try {
    const targetState = (): AcpTargetSnapshot => ({
      path: target.path,
      hash: target.baseHash,
      mode: target.mode,
      content: original,
    });
    const absolutePath = join(hunkFixture.scratch, target.path);
    const input = { TargetFile: absolutePath, TargetContent: '0', ReplacementContent: '1' };
    const diff = {
      type: 'diff',
      path: absolutePath,
      oldText: '0',
      newText: '1',
      _meta: { kind: 'modify' },
    };
    const tool = {
      toolCallId: 'one',
      title: 'Run replace_file_content?',
      kind: 'edit',
      status: 'pending',
      rawInput: input,
      content: [diff],
      locations: [{ path: absolutePath }],
    };
    const decode = (value: unknown, readTarget = targetState) =>
      decodeAcpPermissionAction({
        tool: value,
        client: hunkFixture.client,
        scratch: hunkFixture.scratch,
        target,
        toolMappings: [hunkFixture.hunkMapping],
        readTarget,
      });
    const productionTool = GoogleAcpToolMappings[0];
    assert.equal(GoogleAcpToolMappings.length, 1);
    assert.equal(GoogleAcpReviewMappings.length, 1);
    assert.equal(productionTool.schema, 'replace-hunk-v1');
    if (productionTool.schema !== 'replace-hunk-v1') assert.fail('Expected the pinned hunk tool.');
    const productionClient = {
      ...productionTool.client,
      executable: hunkFixture.client.executable,
    };
    const productionReview = GoogleAcpReviewMappings[0];
    assert.equal(productionReview.harnessSha256, productionClient.harnessSha256);
    assert.equal(productionReview.configId, 'mode');
    assert.equal(productionReview.valueId, 'default');
    assert.equal(productionReview.evidenceHash, productionTool.evidenceHash);
    const productionModes = [
      { optionId: 'mode', valueId: 'default' },
      { optionId: 'mode', valueId: 'auto_edit' },
      { optionId: 'mode', valueId: 'yolo' },
    ];
    const productionProof: AcpSetupProof = {
      ...hunkFixture.proof,
      client: acpClientPin(productionClient),
      modeValues: productionModes,
      reviewMode: {
        surface: 'config',
        configId: 'mode',
        valueId: 'default',
        semantics: 'request-review',
        mappingEvidenceHash: productionReview.evidenceHash,
        discoveryStateHash: hashCanonical({
          configOptions: hunkFixture.proof.configOptions,
          modeValues: productionModes,
        }),
      },
    };
    assert.deepEqual(validateAcpSetupProof(productionProof, productionClient), productionProof);
    assert.deepEqual(
      decodeAcpPermissionAction({
        tool,
        client: productionClient,
        scratch: hunkFixture.scratch,
        target,
        toolMappings: GoogleAcpToolMappings,
        readTarget: targetState,
      }),
      decode(tool),
    );
    for (const change of [
      { sha256: 'a'.repeat(64) },
      { harnessSha256: 'a'.repeat(64) },
      { signerTeamId: 'OTHERTEAM1' },
    ]) {
      const changed = { ...productionClient, ...change };
      assert.throws(() => validateAcpSetupProof(productionProof, changed));
      assert.throws(() =>
        decodeAcpPermissionAction({
          tool,
          client: changed,
          scratch: hunkFixture.scratch,
          target,
          toolMappings: GoogleAcpToolMappings,
          readTarget: targetState,
        }),
      );
    }
    for (const valueId of ['auto_edit', 'yolo'])
      assert.throws(() =>
        validateAcpSetupProof(
          { ...productionProof, reviewMode: { ...productionProof.reviewMode, valueId } },
          productionClient,
        ),
      );
    const action = decode(tool);
    assert.equal(action.type, 'replace-hunk');
    assert.equal(action.baseHash, hash(original));
    assert.notEqual(action.baseHash, hash(input.TargetContent));
    assert.equal(acpPermissionAfterHash(action, targetState()), hash(original.replace('0', '1')));
    for (const newText of ['界'.repeat(1400), '"'.repeat(2000)])
      assert.throws(() =>
        decode({
          ...tool,
          rawInput: { ...input, ReplacementContent: newText },
          content: [{ ...diff, newText }],
        }),
      );
    const maximumContent = `0${'x'.repeat(65535)}`;
    assert.throws(() =>
      decode(
        {
          ...tool,
          rawInput: { ...input, ReplacementContent: '11' },
          content: [{ ...diff, newText: '11' }],
        },
        () => ({ ...targetState(), hash: hash(maximumContent), content: maximumContent }),
      ),
    );
    for (const change of [
      { title: 'Run other_edit?' },
      { title: `Run replace_file_content? ${target.path}` },
      { name: 'replace_file_content' },
      { kind: 'other' },
      { status: 'in_progress' },
      { rawInput: { ...input, AllowMultiple: false } },
      { rawInput: { ...input, StartLine: 1 } },
      { rawInput: { ...input, TargetContent: '' } },
      { rawInput: { ...input, TargetFile: '../net.mjs' } },
      { rawInput: { ...input, path: target.path } },
      { rawInput: { ...input, ReplacementChunks: [] } },
      { rawInput: { ...input, ReplacementContent: '界'.repeat(1400) } },
      { content: [{ ...diff, oldText: original }] },
      { content: [{ ...diff, newText: '2' }] },
      { content: [diff, { ...diff, path: join(hunkFixture.scratch, 'other.mjs') }] },
      { content: [{ ...diff, _meta: { kind: 'add' } }] },
      { content: [{ ...diff, extra: 'unobserved' }] },
      { locations: [{ path: join(hunkFixture.scratch, 'other.mjs') }] },
      { locations: [{ path: absolutePath, line: 1 }] },
      { _meta: { mcp: {} } },
      { rawOutput: {} },
      { unobserved: true },
    ])
      assert.throws(() => decode({ ...tool, ...change }));
    for (const content of ['no match', '0 0', '00'])
      assert.throws(() => decode(tool, () => ({ ...targetState(), content, hash: hash(content) })));
    assert.throws(() => decode(tool, () => ({ ...targetState(), hash: 'a'.repeat(64) })));
    assert.throws(() => decode(tool, () => ({ ...targetState(), mode: '100755' })));
    assert.throws(() =>
      acpPermissionAfterHash({ ...action, baseHash: 'a'.repeat(64) }, targetState()),
    );
    if (action.type === 'replace-hunk')
      assert.throws(() =>
        acpPermissionAfterHash({ ...action, afterHash: 'a'.repeat(64) }, targetState()),
      );
    const pinned = { ...hunkFixture.mapping, harnessSha256: hunkFixture.client.harnessSha256 };
    assert.deepEqual(
      validateAcpSetupProof(hunkFixture.proof, hunkFixture.client, [pinned]),
      hunkFixture.proof,
    );
    assert.throws(() =>
      validateAcpSetupProof(
        hunkFixture.proof,
        { ...hunkFixture.client, harnessSha256: 'a'.repeat(64) },
        [pinned],
      ),
    );
    assert.throws(() =>
      decodeAcpPermissionAction({
        tool,
        client: { ...hunkFixture.client, harnessSha256: 'a'.repeat(64) },
        scratch: hunkFixture.scratch,
        target,
        toolMappings: [hunkFixture.hunkMapping],
        readTarget: targetState,
      }),
    );
  } finally {
    hunkFixture.dispose();
  }
  for (const scenario of [
    'permission',
    'hunk',
    'hunk-sequential',
    'hunk-control',
    'hunk-drift',
    'permanent',
    'ambiguous',
    'changed-action',
    'bad-action',
    'large-action',
    'drift',
    'duplicate',
    'usage-refusal',
    'activity-locations',
    'after-terminal',
    'late-permission',
    'open-tools',
    'pending-end',
  ] as const) {
    const f = fixture(scenario);
    let permissions = 0,
      usages = 0;
    const toolActivity: { toolCallId?: string; status?: string; locations?: unknown[] }[] = [];
    let handle: ReturnType<typeof writer>;
    try {
      handle = writer(f, {
        ...(scenario.startsWith('hunk')
          ? {
              toolMappings: [f.hunkMapping],
              readTarget: () => {
                const content = readFileSync(join(f.scratch, target.path), 'utf8');
                return { path: target.path, hash: hash(content), mode: target.mode, content };
              },
            }
          : {}),
        onActivity: (activity, text) => {
          if (activity.sessionUpdate === 'agent_thought_chunk') assert.equal(text, '');
          if (activity.sessionUpdate === 'usage_update') usages++;
          if (activity.toolCallId) {
            const { toolCallId, status, locations } = activity;
            toolActivity.push({ toolCallId, status, locations });
          }
        },
        onPermission: (proposal) => {
          permissions++;
          assert(Buffer.byteLength(proposal.consequence) <= 4096);
          assert.equal(proposal.actionHash, hashCanonical(proposal.detail));
          const bound = binding(proposal);
          if (scenario === 'permission' || scenario.startsWith('hunk'))
            queueMicrotask(() => {
              assert.throws(
                () => handle.replyPermission({ ...bound, generation: 1 }, 'approved'),
                AcpError,
              );
              handle.replyPermission(bound, 'approved');
              assert.throws(() => handle.replyPermission(bound, 'approved'), AcpError);
            });
          return bound;
        },
      });
      const outcome = await handle.result;
      assert(outcome.quiescent, scenario);
      if (['permission', 'hunk', 'hunk-sequential'].includes(scenario)) {
        assert.equal(outcome.reason, null);
        assert.equal(permissions, scenario === 'hunk-sequential' ? 2 : 1);
        assert.equal(outcome.metadata?.stopReason, 'end_turn');
        assert.equal(
          outcome.metadata?.targetHash,
          hash(`export const total = ${scenario === 'hunk-sequential' ? 2 : 1};\n`),
        );
      } else if (scenario === 'usage-refusal') {
        assert.equal(outcome.reason, null);
        assert.equal(outcome.metadata?.stopReason, 'refusal');
        assert.equal(permissions, 0);
      } else if (scenario === 'activity-locations') {
        assert.equal(outcome.reason, null, JSON.stringify(outcome.diagnostic));
        assert.equal(outcome.metadata?.stopReason, 'end_turn');
        assert.equal(permissions, 0);
        assert.deepEqual(
          toolActivity,
          ['fixture-search', 'fixture-read'].flatMap((toolCallId) => [
            { toolCallId, status: 'in_progress', locations: [] },
            { toolCallId, status: 'completed', locations: [] },
          ]),
        );
      } else if (scenario === 'after-terminal') {
        // A trailing usage update and a failed close leave the finished turn intact.
        assert.equal(outcome.reason, null);
        assert.equal(outcome.metadata?.stopReason, 'end_turn');
        assert.equal(outcome.trailingUpdates, 1);
        assert.deepEqual(outcome.diagnostic, {
          site: 'rpc-error',
          method: 'session/close',
          rpcCode: -32603,
        });
      } else if (scenario === 'late-permission') {
        // A permission request after the terminal response still refuses.
        assert.equal(outcome.reason, 'permission');
        assert.equal(outcome.metadata?.stopReason, 'end_turn');
        assert.equal(permissions, 0);
        assert.deepEqual(outcome.diagnostic, {
          site: 'request-method',
          method: 'session/request_permission',
        });
      } else if (scenario === 'open-tools') {
        // Read and search tools left open at a clean end let the turn finish.
        assert.equal(outcome.reason, null, JSON.stringify(outcome.diagnostic));
        assert.equal(outcome.metadata?.stopReason, 'end_turn');
        assert.equal(outcome.openToolCount, 3);
        assert.deepEqual(outcome.openToolKinds, ['read', 'search', 'execute']);
      } else if (scenario === 'pending-end') {
        // A permission still pending at the terminal response refuses the turn.
        assert.equal(outcome.reason, 'protocol');
        assert.equal(outcome.metadata, null);
        assert.equal(permissions, 1);
        assert.deepEqual(outcome.diagnostic, {
          site: 'incomplete-tool-terminal',
          method: 'session/prompt',
          pendingToolCount: 1,
        });
      } else {
        assert(outcome.reason, scenario);
        if (scenario === 'hunk-drift') assert.equal(permissions, 1, scenario);
        else if (scenario !== 'changed-action') assert.equal(permissions, 0, scenario);
      }
      if (scenario === 'hunk')
        assert.deepEqual(toolActivity[0], {
          toolCallId: 'fixture-hunk-1',
          status: 'pending',
          locations: [{ path: target.path }],
        });
      if (scenario === 'ambiguous') assert.equal(outcome.diagnostic?.site, 'permission-options');
      // The refused edit names its argument classes and carries none of their values.
      if (scenario === 'hunk-control')
        assert.deepEqual(outcome.diagnostic, {
          site: 'permission-action',
          method: 'session/request_permission',
          editArguments: ['TargetFile', 'TargetContent', 'ReplacementContent', 'AllowMultiple'],
        });
      if (scenario === 'duplicate') assert.equal(outcome.diagnostic?.site, 'correlation');
      assert.equal(usages, 1, scenario);
      assert(!Object.hasOwn(outcome, 'observations'));
    } finally {
      f.dispose();
    }
  }
  assert.equal(
    AcpPermissionActionSchema.safeParse({
      type: 'replace-target',
      ...target,
      oldText: original,
      newText: '界'.repeat(1400),
    }).success,
    false,
  );
});

test('acp stop settles the original prompt and retains process ownership through cleanup', async () => {
  for (const scenario of [
    'cancel',
    'cancel-late',
    'cancel-permission',
    'eof-cancel',
    'complete',
    'session-update',
    'no-close',
    'descendant',
  ] as const) {
    const f = fixture(scenario);
    let handle: ReturnType<typeof writer>;
    try {
      const spawn: AcpSpawn = (executable, args, options) => {
        assert.equal(options.env.SECRET_TOKEN, undefined);
        assert.equal(
          options.env.BROWSER,
          process.platform === 'darwin' ? '/usr/bin/open %s' : undefined,
        );
        const child = spawnCheckChild(executable, args, options);
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
          if (scenario === 'complete' && String(chunk).includes('"session/close"')) handle.stop();
          return Reflect.apply(write, child.stdin, [chunk, ...rest]);
        }) as typeof child.stdin.write;
        return child;
      };
      handle = writer(f, {
        spawn,
        onActivity: (_activity, text) => {
          if (text === 'fixture-ready-to-cancel') handle.stop();
        },
        onPermission: (proposal) => {
          handle.stop();
          return binding(proposal);
        },
      });
      const outcome = await handle.result;
      assert(outcome.quiescent, scenario);
      assert(groupAbsent(handle.group), scenario);
      if (scenario.startsWith('cancel')) {
        assert.equal(outcome.reason, 'stopped', scenario);
        assert.equal(outcome.metadata?.stopReason, 'cancelled', scenario);
      } else if (scenario === 'eof-cancel') {
        assert(outcome.reason);
        assert.equal(outcome.metadata, null);
      } else {
        assert.equal(outcome.reason, null, scenario);
        assert.equal(outcome.metadata?.stopReason, 'end_turn');
      }
      assert.deepEqual(f.phases, ['intent', 'owned', 'quiescent']);
    } finally {
      f.dispose();
    }
  }
  for (const [scenario, expected] of [
    ['tool-update', { site: 'tool-update', method: 'session/update', sessionUpdate: 'tool_call' }],
    ['prompt-result', { site: 'prompt-result', method: 'session/prompt' }],
    [
      'incomplete-tool-terminal',
      { site: 'incomplete-tool-terminal', method: 'session/prompt', pendingToolCount: 1 },
    ],
    ['prompt-terminal-state', { site: 'prompt-terminal-state', method: 'session/prompt' }],
  ] as const) {
    const f = fixture('complete');
    try {
      const peer = readFileSync(f.client.executable, 'utf8');
      const rewrite = `
const diagnosticCase = ${JSON.stringify(scenario)};
const emit = process.stdout.write.bind(process.stdout); let pending = '';
process.stdout.write = function(chunk) {
  pending += String(chunk);
  for (;;) {
    const at = pending.indexOf('\\n'); if (at < 0) break;
    const line = pending.slice(0, at); pending = pending.slice(at + 1);
    const value = JSON.parse(line);
    if (value.result?.stopReason) {
      if (diagnosticCase === 'tool-update' || diagnosticCase === 'incomplete-tool-terminal') emit(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'tool_call',toolCallId:'fixture-diagnostic',kind:'edit',status:diagnosticCase === 'tool-update' ? 'private-bad-status' : 'in_progress'}}})+'\\n');
      if (diagnosticCase === 'prompt-result') value.result.stopReason = 'private-bad-terminal';
      if (diagnosticCase === 'prompt-terminal-state') value.result.stopReason = 'cancelled';
    }
    emit(JSON.stringify(value)+'\\n');
  }
  return true;
};
`;
      chmodSync(f.client.executable, 0o700);
      writeFileSync(
        f.client.executable,
        peer.replace('runAcpPeer("complete");', `${rewrite}runAcpPeer("complete");`),
      );
      chmodSync(f.client.executable, 0o500);
      f.client.sha256 = hash(readFileSync(f.client.executable));
      f.proof.client.sha256 = f.client.sha256;
      f.mapping.client.sha256 = f.client.sha256;
      f.toolMapping.client.sha256 = f.client.sha256;
      const outcome = await writer(f).result;
      assert.equal(outcome.reason, 'protocol', scenario);
      assert.deepEqual(outcome.diagnostic, expected, scenario);
      assert.equal(outcome.metadata, null);
      assert(outcome.quiescent);
      assert(!JSON.stringify(outcome).includes('private-'));
    } finally {
      f.dispose();
    }
  }
  for (const cleanup of ['owned-term', 'unexpected-term', 'hard-kill', 'nonzero'] as const) {
    const f = fixture('complete');
    try {
      chmodSync(f.client.executable, 0o700);
      writeFileSync(
        f.client.executable,
        `#!${process.execPath}
const cleanup = ${JSON.stringify(cleanup)};
if (cleanup === 'hard-kill') process.on('SIGTERM', () => {});
process.stdin.on('data', bytes => {
  const request = JSON.parse(bytes.toString());
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentInfo:{version:'1.4.0'},authMethods:[{id:'oauth-personal',name:'Personal'}]}})+'\\n');
});
process.stdin.on('end', () => {
  if (cleanup === 'unexpected-term') process.kill(process.pid, 'SIGTERM');
  if (cleanup === 'nonzero') process.exit(17);
});
setInterval(() => {}, 1000);
`,
      );
      chmodSync(f.client.executable, 0o500);
      f.client.sha256 = hash(readFileSync(f.client.executable));
      const outcome = await startGoogleAcpSetup({
        client: f.client,
        directory: f.directory(),
        environment,
        operation: 'initialize',
        priorProof: null,
        lifecycle: f.lifecycle,
        spawn: spawnCheckChild as AcpSpawn,
      }).result;
      assert(outcome.metadata, cleanup);
      assert(outcome.quiescent, cleanup);
      assert.equal(outcome.reason, cleanup === 'owned-term' ? null : 'protocol', cleanup);
      assert.deepEqual(outcome.diagnostic, cleanup === 'owned-term' ? null : { site: 'exit' });
      assert(outcome.stdoutBytes > 0);
      assert.equal(outcome.stderrBytes, 0);
      assert.equal(
        outcome.signal,
        cleanup === 'hard-kill' ? 'SIGKILL' : cleanup === 'nonzero' ? null : 'SIGTERM',
      );
      assert.deepEqual(f.phases, ['intent', 'owned', 'quiescent']);
    } finally {
      f.dispose();
    }
  }
  const late = fixture('complete');
  let lateClock = 0;
  try {
    const outcome = await writer(late, {
      now: () => lateClock,
      schedule: () => () => {},
      spawn: (program, args, opts) => {
        const child = spawnCheckChild(program, args, opts);
        child.once('close', () => {
          lateClock = 300000;
        });
        return child;
      },
    }).result;
    assert.equal(outcome.reason, 'deadline');
    assert.equal(outcome.metadata?.stopReason, 'end_turn');
    assert(outcome.quiescent);
  } finally {
    late.dispose();
  }
  const sink = fixture('complete');
  try {
    const outcome = await writer(sink, {
      onActivity: () => {
        throw Error('private-sink-failure');
      },
    }).result;
    assert.equal(outcome.reason, 'protocol');
    assert.deepEqual(outcome.diagnostic, {
      site: 'activity-sink',
      method: 'session/update',
      sessionUpdate: 'usage_update',
    });
    assert.equal(outcome.metadata, null);
    assert(outcome.quiescent);
  } finally {
    sink.dispose();
  }
  const timed = fixture('cancel');
  try {
    const timers: { work: () => void; ms: number }[] = [];
    const handle = writer(timed, {
      now: () => 0,
      schedule: (work, ms) => {
        timers.push({ work, ms });
        return () => {};
      },
      onActivity: (_activity, text) => {
        if (text === 'fixture-ready-to-cancel') timers.find((v) => v.ms === 299000)?.work();
      },
    });
    const outcome = await handle.result;
    assert.equal(outcome.reason, 'deadline');
    assert.equal(outcome.metadata?.stopReason, 'cancelled');
    assert(outcome.quiescent);
  } finally {
    timed.dispose();
  }
  for (const [name, bytes, expected] of [
    ['utf8', Buffer.from([255, 10]), { site: 'utf8' }],
    ['json', Buffer.from('private-not-json\n'), { site: 'json' }],
    [
      'envelope',
      Buffer.from('{"jsonrpc":"private-version","id":1,"result":{}}\n'),
      { site: 'envelope' },
    ],
    [
      'correlation',
      Buffer.from('{"jsonrpc":"2.0","id":99,"result":{}}\n'),
      { site: 'correlation' },
    ],
    [
      'rpc',
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"private-provider-message","data":"private-provider-data"}}\n',
      ),
      { site: 'rpc-error', method: 'session/prompt', rpcCode: -32603 },
    ],
    [
      'result',
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"private-provider-result"}\n'),
      { site: 'rpc-result', method: 'session/prompt' },
    ],
    ['eof', Buffer.alloc(0), { site: 'eof-pending' }],
    [
      'notification',
      Buffer.from(
        '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"private-tool"}}}\n',
      ),
      { site: 'notification', method: 'session/update', sessionUpdate: 'tool_call' },
    ],
  ] as const) {
    const stream = new (await import('node:stream')).PassThrough();
    const connection = new AcpConnection(stream, () => {});
    const pending = connection.request(
      'session/prompt',
      {},
      name === 'result'
        ? () => {
            throw Error('private-validator-details');
          }
        : undefined,
    );
    if (name === 'eof') connection.end();
    else connection.push(bytes);
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof AcpError && JSON.stringify(error.diagnostic) === JSON.stringify(expected),
    );
    assert.deepEqual(connection.diagnostic, expected, name);
    connection.fail(new AcpError('protocol', { site: 'stdout-stream' }));
    assert.deepEqual(
      connection.diagnostic,
      expected,
      'The first failure survives later cleanup errors.',
    );
    assert(!JSON.stringify(connection.diagnostic).includes('private-'));
    stream.destroy();
  }
  assert.equal(AcpDiagnosticSchema.safeParse({ site: 'json', message: 'private' }).success, false);
  assert.equal(
    AcpDiagnosticSchema.safeParse({ site: 'json', method: 'private-method' }).success,
    false,
  );
  assert.equal(
    AcpDiagnosticSchema.safeParse({ site: 'tool-update', sessionUpdate: 'private-update' }).success,
    false,
  );
  const output = new (await import('node:stream')).PassThrough();
  let reason = '';
  const connection = new AcpConnection(output, (error) => {
    reason = error.reason;
  });
  const pending = connection.request('initialize', {});
  connection.push(Buffer.from('x'.repeat(1048577)));
  await assert.rejects(pending);
  assert.equal(reason, 'output-limit');
  output.destroy();
});
