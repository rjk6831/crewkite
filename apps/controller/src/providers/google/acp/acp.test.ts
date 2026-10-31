import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
import { type ApprovalBinding, CommandSchema, GOOGLE_TERMS_VERSION } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { createTestClock, createTestIds } from '../../../../../../packages/testkit/src/fixtures.ts';
import type { AcpPeerCase } from '../../../../../../packages/testkit/src/providers/acp-peer.ts';
import { Controller } from '../../../commands/controller.ts';
import { spawnCheckChild } from '../../../host/check-ownership.ts';
import { groupAbsent } from '../../../host/worker.ts';
import {
  AcpConnection,
  AcpDiagnosticSchema,
  AcpError,
  type AcpLifecycle,
  type AcpSpawn,
  AcpStderrClassifier,
  AcpStderrSummarySchema,
} from './client.ts';
import { type AcpImportDependencies, importGoogleAcp } from './import.ts';
import {
  ACP_SESSION_MODELS,
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
  decodeAcpPermissionRequest,
  GoogleAcpToolMappings,
  googleAcpPromptWithTarget,
  googleAcpTargetContext,
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
function fixture(scenario: AcpPeerCase, optionMetadata = false) {
  mkdirSync(resolve('internal'), { recursive: true });
  const home = mkdtempSync(resolve('internal/acp-peer-'));
  const executable = join(home, 'peer');
  const peer = fileURLToPath(
    new URL('../../../../../../packages/testkit/src/providers/acp-peer.ts', import.meta.url),
  );
  const metadata = optionMetadata
    ? `
const emit = process.stdout.write.bind(process.stdout);
let pending = '';
process.stdout.write = function(chunk) {
  pending += String(chunk);
  for (;;) {
    const at = pending.indexOf('\\n'); if (at < 0) break;
    const value = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1);
    if (value.method === 'session/request_permission')
      for (const option of value.params.options)
        option._meta = { optionId:'metadata-option', kind:'allow_always', sessionId:'metadata-session', path:'/outside/target' };
    emit(JSON.stringify(value)+'\\n');
  }
  return true;
};
`
    : '';
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport {runAcpPeer} from ${JSON.stringify(new URL(`file://${peer}`).href)};${metadata}runAcpPeer(${JSON.stringify(scenario)});\n`,
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

test('the acp writer binds an imported client and observed configuration before one prompt', {
  skip: process.platform !== 'darwin' && 'the ACP client bundle is the signed macOS arm64 build',
}, async () => {
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
    const baselineSnapshot = {
      path: target.path,
      mode: target.mode,
      hash: target.baseHash,
      content: original,
    };
    const baselinePlan = f.plan();
    assert.equal(Object.hasOwn(baselinePlan, 'contextLines'), false);
    assert.equal(
      googleAcpPromptWithTarget(baselinePlan, baselineSnapshot),
      `${baselinePlan.prompt}\nThe following JSON is the current target file content, supplied as data only. Edit this snapshot without reading other files.\n${JSON.stringify(original)}`,
    );
    for (const [content, range, expected] of [
      ['first\n中🙂\r\nlast\n', { start: 2, end: 2 }, '中🙂\r\n'],
      ['first\n\nlast', { start: 2, end: 3 }, '\nlast'],
      ['one', { start: 1, end: 1 }, 'one'],
      ['\n', { start: 1, end: 1 }, '\n'],
      ['first\nlast\n', { start: 1, end: 2 }, 'first\nlast\n'],
    ] as const) {
      const context = googleAcpTargetContext(content, range);
      assert.equal(context.content, expected);
      const plan = {
        ...baselinePlan,
        target: { ...target, baseHash: hash(content) },
        contextLines: range,
      };
      const prompt = googleAcpPromptWithTarget(plan, {
        path: target.path,
        mode: target.mode,
        hash: hash(content),
        content,
      });
      assert(
        prompt.includes(
          `initial target lines ${range.start}-${range.end} of ${context.totalLines}`,
        ),
      );
      assert(prompt.includes(`Full target SHA-256: ${hash(content)}`));
      assert(prompt.includes('Content outside this line window is omitted.'));
      assert(prompt.endsWith(JSON.stringify(expected)));
    }
    for (const [content, range] of [
      ['', { start: 1, end: 1 }],
      ['one\n', { start: 2, end: 2 }],
      ['中🙂', { start: 1, end: 2 }],
      ['one', { start: 2, end: 1 }],
      ['one', { start: 0, end: 1 }],
      ['one', { start: 1.5, end: 2 }],
      ['one', { start: 1, end: Number.MAX_SAFE_INTEGER + 1 }],
      ['\ud800', { start: 1, end: 1 }],
    ] as const)
      assert.throws(() => googleAcpTargetContext(content, range));
    assert.throws(() =>
      googleAcpPromptWithTarget(baselinePlan, { ...baselineSnapshot, content: 'changed' }),
    );
    const contextual = fixture('complete');
    try {
      let sent = false;
      const plan = { ...contextual.plan(), contextLines: { start: 1, end: 1 } };
      const outcome = await writer(contextual, {
        plan,
        readTarget: () => baselineSnapshot,
        spawn: (program, args, options) => {
          const child = spawnCheckChild(program, args, options);
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
            const frame = JSON.parse(chunk.toString());
            if (frame.method === 'session/new')
              assert.deepEqual(frame.params._meta.antigravity.enabledTools, [
                'edit_file',
                'finish',
              ]);
            if (frame.method === 'session/prompt') {
              assert.equal(
                frame.params.prompt[0].text,
                googleAcpPromptWithTarget(plan, baselineSnapshot),
              );
              sent = true;
            }
            return Reflect.apply(write, child.stdin, [chunk, ...rest]);
          }) as typeof child.stdin.write;
          return child;
        },
      }).result;
      assert.equal(outcome.reason, null);
      assert(sent);
      assert.throws(() => writer(contextual, { plan }));
    } finally {
      contextual.dispose();
    }
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
      'queued-close',
      'live-at-cutoff',
      'late-kill',
      'late-kill-reversed',
      'late-kill-near-deadline',
    ] as const) {
      const held =
        failure === 'queued-close' ||
        failure === 'live-at-cutoff' ||
        failure.startsWith('late-kill');
      // The signature phase runs only where codesign does.
      if (held && (process.platform !== 'darwin' || process.arch !== 'arm64')) continue;
      const row = fixture('complete');
      const exits: Array<Promise<unknown>> = [];
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
        const timers: Array<{ delay: number; work: () => void; live: boolean }> = [];
        let capture = true;
        const ready = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        let onExit: (() => void) | undefined;
        let callbackError: unknown;
        const fire = (delay: number) => {
          const timer = timers.find((timer) => timer.live && timer.delay === delay);
          assert(timer, `${failure}: pending ${delay}ms timer`);
          timer.live = false;
          timer.work();
        };
        const mutation: AcpImportDependencies =
          failure === 'deadline' || failure === 'bundle-deadline' || held
            ? {
                now: () => clock,
                schedule: held
                  ? (work, delay) => {
                      const timer = { delay, work, live: true };
                      timers.push(timer);
                      let scheduled: ReturnType<typeof setTimeout> | undefined;
                      if (!capture) {
                        const at = clock + delay;
                        scheduled = setTimeout(() => {
                          timer.live = false;
                          clock = Math.max(clock, at);
                          work();
                        }, delay);
                      }
                      return () => {
                        timer.live = false;
                        clearTimeout(scheduled);
                      };
                    }
                  : () => () => {},
                spawn: (program, args, options) => {
                  assert.equal(program, '/usr/bin/codesign');
                  assert(
                    args.includes(`=${googleAcpDeveloperIdRequirement(row.client.signerTeamId)}`),
                  );
                  // A held child ignores TERM and leaves only on the kill.
                  const child = held
                    ? spawnCheckChild(
                        process.execPath,
                        [
                          '-e',
                          "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(1), 10000); process.stdout.write('ready\\n');",
                        ],
                        options,
                      )
                    : spawnCheckChild(row.client.executable, [], options);
                  if (child.pid) row.groups.push(child.pid);
                  exits.push(new Promise((resolve) => child.once('close', resolve)));
                  if (held) {
                    child.stdout.once('data', () => ready.resolve());
                    child.once('exit', () => onExit?.());
                    child.once('error', ready.reject);
                    child.once('close', () => {
                      ready.reject(
                        new Error(`${failure}: the held child closed before it was ready`),
                      );
                      closed.resolve();
                    });
                  } else
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
        const pending = importGoogleAcp({ home: row.home, consent: 'explicit' }, mutation);
        if (held) {
          // A child that fails to start or exits early rejects here, and an import that settles
          // first fails the timer lookup below.
          await Promise.race([ready.promise, pending]);
          fire(4000);
          if (failure === 'queued-close') {
            // The group is gone when the cutoff runs, but its close event is still queued.
            clock = 2000;
            onExit = () => {
              try {
                capture = false;
                fire(1000);
              } catch (error) {
                callbackError = error;
              }
            };
            fire(250);
          } else if (failure === 'live-at-cutoff') {
            // No kill has gone out, so the group is still present when the cutoff decides.
            clock = 2000;
            fire(1000);
          } else {
            // A blocked loop runs the stop timers in one pass. Node runs one duration list at a
            // time, so the 1000 ms cutoff list can reach the cutoff before the 250 ms kill.
            clock = failure === 'late-kill-near-deadline' ? 4500 : 2000;
            capture = false;
            for (const delay of failure === 'late-kill-reversed' ? [1000, 250] : [250, 1000])
              fire(delay);
          }
        }
        const result = await pending;
        if (failure === 'live-at-cutoff')
          for (const group of row.groups) process.kill(-group, 'SIGKILL');
        if (held) await closed.promise;
        assert.ifError(callbackError);
        assert.equal(result.imported, false, failure);
        assert.throws(() => readGoogleAcpPin(row.home));
        if (held) {
          assert.equal(
            result.reason,
            failure === 'live-at-cutoff' ? 'ownership' : 'signature-refused',
            failure,
          );
          if (failure === 'queued-close')
            assert(
              timers.some((timer) => timer.delay === 0),
              `${failure}: the cutoff waits one tick for the close event`,
            );
          if (failure === 'late-kill-near-deadline')
            assert(
              timers.some((timer) => timer.delay === 500),
              `${failure}: the late kill waits only until the deadline`,
            );
          assert.equal(
            timers.some((timer) => timer.live),
            false,
            `${failure}: settlement cancels every timer`,
          );
        }
      } finally {
        // A row that fails midway reports its own assertion and leaves no child or directory.
        for (const group of row.groups) {
          try {
            process.kill(-group, 'SIGKILL');
          } catch {}
        }
        await Promise.all(exits);
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
    assert.equal(
      resolveGoogleAcpProfile(
        { home: f.home, proof: f.proof, environment },
        { reviewMappings: [f.mapping] },
      ).facts.maximumTaskMs,
      600000,
    );
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
    for (const elapsed of [4500, 29000]) {
      const cold = fixture('complete');
      let clock = 0;
      const scheduled: { work: () => void; milliseconds: number }[] = [];
      try {
        const outcome = await startGoogleAcpSetup({
          client: cold.client,
          directory: cold.directory(),
          environment,
          operation: 'initialize',
          priorProof: null,
          now: () => clock,
          schedule: (work, milliseconds) => {
            scheduled.push({ work, milliseconds });
            return () => {};
          },
          lifecycle: {
            ...cold.lifecycle,
            owned: (group) => {
              cold.lifecycle.owned(group);
              clock = elapsed;
              scheduled.find((timer) => timer.milliseconds <= elapsed)?.work();
            },
          },
          spawn: spawnCheckChild as AcpSpawn,
        }).result;
        assert.equal(outcome.reason, elapsed === 4500 ? null : 'deadline');
        assert.equal(outcome.metadata !== null, elapsed === 4500);
        assert.ok(outcome.quiescent);
        assert.ok(scheduled.some((timer) => timer.milliseconds === 29000));
        assert.deepEqual(cold.phases, ['intent', 'owned', 'quiescent']);
      } finally {
        cold.dispose();
      }
    }
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
    for (const timeoutMs of [undefined, 300000, 600000]) {
      for (const expiration of ['before-marker', 'after-marker'] as const) {
        const row = fixture('complete');
        const limit = timeoutMs ?? 300000;
        const scheduled: number[] = [];
        let clock = 0,
          markers = 0,
          outputs = 0;
        try {
          const expired = writer(row, {
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            now: () => clock,
            schedule: (_work, ms) => {
              scheduled.push(ms);
              return () => {};
            },
            spawn: (program, args, opts) => {
              const child = spawnCheckChild(program, args, opts);
              const write = child.stdin.write.bind(child.stdin);
              child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
                if (
                  expiration === 'before-marker' &&
                  String(chunk).includes('"configId":"mode-slot"')
                )
                  clock = limit - 1000;
                return Reflect.apply(write, child.stdin, [chunk, ...rest]);
              }) as typeof child.stdin.write;
              return child;
            },
            onSubmitted: () => {
              markers++;
              if (expiration === 'after-marker') clock = limit;
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
          assert(scheduled.includes(limit - 1000));
        } finally {
          row.dispose();
        }
      }
    }
    assert.throws(
      () => writer(f, { timeoutMs: 600001 }),
      (error) => error instanceof AcpError && error.reason === 'deadline',
    );
    const extended = fixture('complete');
    let extendedClock = 0;
    try {
      const outcome = await writer(extended, {
        timeoutMs: 600000,
        now: () => extendedClock,
        onSubmitted: () => {
          extendedClock = 300001;
        },
      }).result;
      assert.equal(outcome.reason, null);
      assert.equal(outcome.metadata?.stopReason, 'end_turn');
      assert(outcome.quiescent);
    } finally {
      extended.dispose();
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
    // A client that lists models in the session reply gets them as the configuration, config
    // options win when both exist, and a malformed list is dropped.
    const listed = {
      availableModels: [{ modelId: 'm-1' }, { modelId: 'm-2' }],
      currentModelId: 'm-2',
    };
    assert.deepEqual(decodeAcpConfiguration([], listed).configOptions, {
      model: { optionId: ACP_SESSION_MODELS, currentValue: 'm-2', supported: ['m-1', 'm-2'] },
      thoughtLevel: null,
    });
    const option = {
      id: 'model-slot',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'a',
      options: [{ value: 'a', name: 'A' }],
    };
    assert.equal(
      decodeAcpConfiguration([option], listed).configOptions?.model.optionId,
      'model-slot',
    );
    assert.equal(
      decodeAcpConfiguration([], { ...listed, currentModelId: 'gone' }).configOptions,
      null,
    );
  } finally {
    f.dispose();
  }
});

test('fresh acp writers keep broad editors disabled without an mcp server', async () => {
  const f = fixture('fresh-no-mcp');
  try {
    const launched: NodeJS.ProcessEnv[] = [];
    const completion = await writer(f, {
      mcpServer: undefined,
      spawn: (program, args, options) => {
        launched.push(options.env);
        return spawnCheckChild(program, args, options);
      },
    }).result;
    assert.equal(completion.reason, null);
    assert.equal(completion.metadata?.stopReason, 'end_turn');
    // The writer works in the scratch copy, which has no .git of its own.
    assert.deepEqual(
      launched.map((env) => env.GIT_CEILING_DIRECTORIES),
      [realpathSync.native(dirname(f.scratch))],
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
    const editFileTool = {
      ...tool,
      title: 'Run edit_file?',
      rawInput: {
        ...input,
        AllowMultiple: false,
        StartLine: 1,
        EndLine: 1,
        Instruction: 'Set net value to 1',
        Description: 'Update net value',
      },
      locations: [{ path: absolutePath, line: 1 }],
    };
    assert.deepEqual(decode(editFileTool), action);
    const refusalCases = [
      { tool: { ...tool, kind: 'other' }, stage: 'mapping-tool-shape' },
      {
        tool: { ...editFileTool, rawInput: { ...editFileTool.rawInput, AllowMultiple: true } },
        stage: 'native-arguments',
      },
      {
        tool: { ...tool, rawInput: { ...input, TargetFile: '../private-target' } },
        stage: 'scoped-path-location',
      },
      {
        tool: { ...tool, content: [{ ...diff, newText: 'private-value' }] },
        stage: 'displayed-diff',
      },
      {
        tool,
        read: () => ({ ...targetState(), hash: 'private-value' }),
        stage: 'target-snapshot',
      },
      {
        tool,
        read: () => ({ ...targetState(), content: '0 0', hash: hash('0 0') }),
        stage: 'unique-hunk-range',
      },
      {
        tool: {
          ...tool,
          rawInput: { ...input, ReplacementContent: '界'.repeat(1400) },
          content: [{ ...diff, newText: '界'.repeat(1400) }],
        },
        stage: 'complete-action',
      },
      {
        tool: {
          ...tool,
          rawInput: { ...input, ReplacementContent: '11' },
          content: [{ ...diff, newText: '11' }],
        },
        read: () => {
          const content = `0${'x'.repeat(65535)}`;
          return { ...targetState(), content, hash: hash(content) };
        },
        stage: 'resulting-target',
      },
    ];
    for (const row of refusalCases)
      assert.throws(
        () => decode(row.tool, row.read ?? targetState),
        (error: unknown) => {
          assert(error instanceof AcpError);
          assert.equal(error.reason, 'permission');
          assert.equal(error.diagnostic?.site, 'permission-action');
          assert.equal(error.diagnostic?.permissionStage, row.stage);
          assert(!JSON.stringify(error.diagnostic).includes('private-'));
          if (row.stage === 'complete-action') {
            assert((error.diagnostic?.permissionActionBytes ?? 0) > 4096);
            assert((error.diagnostic?.permissionActionBytes ?? Infinity) <= 1048576);
          }
          return true;
        },
      );
    for (const invalidEditFile of [
      { rawInput: { ...editFileTool.rawInput, AllowMultiple: true } },
      { rawInput: { ...editFileTool.rawInput, StartLine: 2, EndLine: 2 } },
      { rawInput: { ...editFileTool.rawInput, StartLine: 2, EndLine: 1 } },
      { locations: [{ path: absolutePath, line: 2 }] },
    ])
      assert.throws(() => decode({ ...editFileTool, ...invalidEditFile }));
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
  const validPermission = {
    sessionId: 'fixture-session',
    toolCall: { toolCallId: 'fixture-tool' },
    options: [{ optionId: 'once', name: 'Once', kind: 'allow_once' }],
  };
  assert.deepEqual(decodeAcpPermissionRequest(validPermission), validPermission);
  for (const metadata of [
    null,
    true,
    1,
    'fixture',
    [],
    { optionId: 'other', kind: 'allow_always' },
  ])
    assert.deepEqual(
      decodeAcpPermissionRequest({
        ...validPermission,
        options: validPermission.options.map((option) => ({ ...option, _meta: metadata })),
      }),
      validPermission,
    );
  const withMetadata = {
    ...validPermission,
    options: validPermission.options.map((option) => ({
      ...option,
      _meta: { optionId: 'once', kind: 'allow_once', sessionId: 'fixture-session' },
    })),
  };
  for (const input of [
    { ...withMetadata, sessionId: null },
    { ...withMetadata, toolCall: null },
    { ...withMetadata, extraAuthority: true },
    { ...withMetadata, options: [{ ...withMetadata.options[0], kind: null }] },
    { ...withMetadata, options: [{ ...withMetadata.options[0], optionId: null }] },
    { ...withMetadata, options: [{ ...withMetadata.options[0], extraAuthority: true }] },
  ])
    assert.throws(() => decodeAcpPermissionRequest(input), AcpError);
  for (const [input, expected] of [
    [null, { code: 'invalid_type', field: 'root', type: 'null' }],
    [
      { ...validPermission, sessionId: null },
      { code: 'invalid_type', field: 'sessionId', type: 'null' },
    ],
    [
      { ...validPermission, toolCall: null },
      { code: 'invalid_type', field: 'toolCall', type: 'null' },
    ],
    [
      { ...validPermission, options: null },
      { code: 'invalid_type', field: 'options', type: 'null' },
    ],
    [
      { ...validPermission, toolCall: { ...validPermission.toolCall, name: 'x'.repeat(201) } },
      { code: 'too_big', field: 'toolCall.name', type: 'string', size: 201 },
    ],
    [
      {
        ...validPermission,
        toolCall: {
          ...validPermission.toolCall,
          locations: [{ path: '/private/account/target', line: 0 }],
        },
      },
      { code: 'too_small', field: 'toolCall.locations.line', type: 'number' },
    ],
    [
      {
        ...validPermission,
        toolCall: { ...validPermission.toolCall, content: Array(33).fill(null) },
      },
      { code: 'too_big', field: 'toolCall.content', type: 'array', size: 33 },
    ],
    [
      { ...validPermission, options: [{ optionId: 'once', name: 'Once', kind: 'private-kind' }] },
      { code: 'invalid_value', field: 'options.kind', type: 'string', size: 12 },
    ],
  ]) {
    assert.throws(
      () => decodeAcpPermissionRequest(input),
      (error) => {
        assert(error instanceof AcpError);
        assert.equal(error.reason, 'permission');
        assert.deepEqual(error.diagnostic, {
          site: 'permission-request',
          method: 'session/request_permission',
          permissionSchema: {
            issueCount: 1,
            issues: [expected],
            unknownKeyCount: 0,
            unknownKeyHashes: [],
          },
        });
        return true;
      },
    );
  }
  const unknownNames = Array.from({ length: 1050 }, (_, index) => `private-key-${index}`);
  assert.throws(
    () =>
      decodeAcpPermissionRequest({
        ...validPermission,
        ...Object.fromEntries(unknownNames.map((name) => [name, '/private/account/value'])),
        toolCall: {
          ...validPermission.toolCall,
          locations: Array.from({ length: 32 }, () => ({ path: null, line: -1 })),
        },
        options: Array.from({ length: 16 }, () => ({ optionId: null, name: null, kind: null })),
      }),
    (error) => {
      assert(error instanceof AcpError);
      const summary = error.diagnostic?.permissionSchema;
      assert(summary);
      assert.equal(summary.issueCount, 113);
      assert.equal(summary.issues.length, 16);
      assert.equal(summary.unknownKeyCount, 1024);
      assert.deepEqual(summary.unknownKeyHashes, unknownNames.slice(0, 16).map(hash).sort());
      assert(!JSON.stringify(error.diagnostic).includes('private-'));
      assert(!JSON.stringify(error.diagnostic).includes('/private/'));
      assert(Buffer.byteLength(JSON.stringify(error.diagnostic)) < 3072);
      return true;
    },
  );
  const schemaFixture = fixture('permission');
  try {
    const peer = readFileSync(schemaFixture.client.executable, 'utf8');
    const rewrite = `
const emit = process.stdout.write.bind(process.stdout);
let pending = '';
process.stdout.write = function(chunk) {
  pending += String(chunk);
  for (;;) {
    const at = pending.indexOf('\\n'); if (at < 0) break;
    const value = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1);
    if (value.method === 'session/request_permission') {
      value.params.toolCall['private-schema-key'] = '/private/account/value';
      value.params.options[0].name = 'x'.repeat(201);
    }
    emit(JSON.stringify(value)+'\\n');
  }
  return true;
};
`;
    chmodSync(schemaFixture.client.executable, 0o700);
    writeFileSync(
      schemaFixture.client.executable,
      peer.replace('runAcpPeer("permission");', `${rewrite}runAcpPeer("permission");`),
    );
    chmodSync(schemaFixture.client.executable, 0o500);
    schemaFixture.client.sha256 = hash(readFileSync(schemaFixture.client.executable));
    schemaFixture.proof.client.sha256 = schemaFixture.client.sha256;
    schemaFixture.mapping.client.sha256 = schemaFixture.client.sha256;
    schemaFixture.toolMapping.client.sha256 = schemaFixture.client.sha256;
    const handle = writer(schemaFixture, {
      onPermission: () => {
        throw Error('Invalid schema reached permission approval.');
      },
    });
    const outcome = await handle.result;
    assert.equal(outcome.reason, 'permission');
    assert.equal(outcome.diagnostic?.site, 'permission-request');
    assert.deepEqual(outcome.diagnostic?.permissionSchema, {
      issueCount: 2,
      issues: [
        { code: 'unrecognized_keys', field: 'toolCall', type: 'object' },
        { code: 'too_big', field: 'options.name', type: 'string', size: 201 },
      ],
      unknownKeyCount: 1,
      unknownKeyHashes: [hash('private-schema-key')],
    });
    assert(outcome.quiescent);
    assert(groupAbsent(handle.group));
    assert.deepEqual(schemaFixture.phases, ['intent', 'owned', 'quiescent']);
    assert(!JSON.stringify(outcome).includes('private-schema-key'));
    assert(!JSON.stringify(outcome).includes('/private/account/'));
  } finally {
    schemaFixture.dispose();
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
    'late-message',
    'open-edits',
    'hunk-open',
    'outside-edit',
    'outside-completed',
    'outside-kind-flip',
    'outside-reverse-flip',
    'outside-open-flip',
    'permission-outside-completed',
    'outside-permission-completed',
    'outside-no-reject',
    'outside-two-rejects',
    'outside-execute',
    'hunk-brain-write',
  ] as const) {
    const f = fixture(scenario, true);
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
          if (
            scenario === 'permission' ||
            scenario === 'permission-outside-completed' ||
            scenario.startsWith('hunk')
          )
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
      if (['permission', 'hunk', 'hunk-sequential', 'hunk-brain-write'].includes(scenario)) {
        // A note write outside scratch gets a reject reply and never reaches the approval
        // callback. The turn then edits the target under the usual approval and ends clean.
        assert.equal(outcome.reason, null, JSON.stringify(outcome.diagnostic));
        assert.equal(permissions, scenario === 'hunk-sequential' ? 2 : 1);
        assert.equal(outcome.metadata?.stopReason, 'end_turn');
        assert.equal(
          outcome.metadata?.targetHash,
          hash(`export const total = ${scenario === 'hunk-sequential' ? 2 : 1};\n`),
        );
        assert.equal(outcome.rejectedOutsideWrites, scenario === 'hunk-brain-write' ? 1 : 0);
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
      } else if (scenario === 'late-message') {
        // Agent text while close is pending fails the turn but keeps its terminal outcome.
        assert.equal(outcome.reason, 'protocol');
        assert.equal(outcome.metadata?.stopReason, 'end_turn');
        assert.equal(outcome.trailingUpdates, 0);
        assert.deepEqual(outcome.diagnostic, {
          site: 'notification-after-terminal',
          method: 'session/update',
          sessionUpdate: 'agent_message_chunk',
        });
        assert(!JSON.stringify(outcome).includes('private-'));
      } else if (
        scenario === 'open-edits' ||
        scenario === 'hunk-open' ||
        scenario === 'outside-open-flip'
      ) {
        // Open edit, delete and move tools, an approved edit still open under another
        // kind, and an outside edit that flipped kind and stayed open each leave the
        // target undecided.
        assert.equal(outcome.reason, 'protocol');
        assert.equal(outcome.metadata, null);
        assert.equal(permissions, scenario === 'hunk-open' ? 1 : 0);
        assert.deepEqual(outcome.diagnostic, {
          site: 'incomplete-tool-terminal',
          method: 'session/prompt',
          pendingToolCount: scenario === 'open-edits' ? 3 : 1,
        });
      } else if (
        [
          'outside-edit',
          'outside-completed',
          'outside-kind-flip',
          'outside-reverse-flip',
          'permission-outside-completed',
          'outside-permission-completed',
        ].includes(scenario)
      ) {
        // A file change that completes outside the scratch lets the turn finish, but it
        // cannot be captured. The completion can arrive on the announcement or on a later
        // update that no longer names the path. The kind can change in either direction,
        // including after the tool first reports completion and later changes status. The
        // path and the edit kind can also first appear in a permission request, which gets
        // the reject reply and still blocks capture when the server then reports the tool
        // complete under another kind.
        assert.equal(outcome.reason, 'permission');
        assert.equal(outcome.metadata?.stopReason, 'end_turn');
        assert.equal(permissions, scenario === 'permission-outside-completed' ? 1 : 0);
        assert.equal(
          outcome.rejectedOutsideWrites,
          scenario === 'outside-permission-completed' ? 1 : 0,
        );
        assert.deepEqual(
          outcome.diagnostic,
          scenario === 'outside-permission-completed'
            ? {
                site: 'edit-location',
                method: 'session/request_permission',
                toolIdentityHash: createHash('sha256').update('write_to_file').digest('hex'),
                rawInputKeyHashes: ['TargetFile', 'CodeContent']
                  .map((key) => createHash('sha256').update(key).digest('hex'))
                  .sort(),
                editArguments: ['TargetFile', 'other'],
              }
            : {
                site: 'edit-location',
                method: 'session/update',
                sessionUpdate: scenario === 'outside-edit' ? 'tool_call' : 'tool_call_update',
              },
        );
      } else if (
        ['outside-no-reject', 'outside-two-rejects', 'outside-execute'].includes(scenario)
      ) {
        // A reject reply needs one reject option on an edit tool. Without that the request
        // gets the cancelled reply and the turn cancels, with nothing counted as rejected.
        assert.equal(outcome.reason, 'permission');
        assert.equal(outcome.metadata?.stopReason, 'cancelled');
        assert.equal(permissions, 0);
        assert.equal(outcome.rejectedOutsideWrites, 0);
        assert.equal(
          outcome.diagnostic?.site,
          scenario === 'outside-execute' ? 'permission-action' : 'permission-options',
        );
        assert.equal(outcome.diagnostic?.method, 'session/request_permission');
        if (scenario === 'outside-execute') {
          assert.equal(
            outcome.diagnostic?.toolIdentityHash,
            createHash('sha256').update('catalog_tool').digest('hex'),
          );
          assert.deepEqual(
            outcome.diagnostic?.rawInputKeyHashes,
            ['arguments', 'task_status']
              .map((key) => createHash('sha256').update(key).digest('hex'))
              .sort(),
          );
        }
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
          toolIdentityHash: createHash('sha256').update('replace_file_content').digest('hex'),
          rawInputKeyHashes: ['TargetFile', 'TargetContent', 'ReplacementContent', 'AllowMultiple']
            .map((key) => createHash('sha256').update(key).digest('hex'))
            .sort(),
          editArguments: ['TargetFile', 'TargetContent', 'ReplacementContent', 'AllowMultiple'],
          permissionStage: 'native-arguments',
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
  for (const [name, stderrBytes] of [
    ['ordinary-stderr', 32768],
    ['bounded-stderr', 1048577],
  ] as const) {
    const f = fixture('complete');
    try {
      chmodSync(f.client.executable, 0o700);
      writeFileSync(
        f.client.executable,
        `#!${process.execPath}
process.stderr.write(${name === 'ordinary-stderr' ? JSON.stringify('HTTP status 503\nretrying in 3s\n') : '""'});
process.stderr.write('x'.repeat(${stderrBytes}));
process.stdin.on('data', bytes => {
  const request = JSON.parse(bytes.toString());
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentInfo:{version:'1.4.0'},authMethods:[{id:'oauth-personal',name:'Personal'}]}})+'\\n');
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
      assert(outcome.quiescent, name);
      const prefixBytes =
        name === 'ordinary-stderr' ? Buffer.byteLength('HTTP status 503\nretrying in 3s\n') : 0;
      assert.equal(outcome.stderrBytes, stderrBytes + prefixBytes, name);
      if (name === 'ordinary-stderr')
        assert.deepEqual(outcome.stderrSummary, {
          lines: 3,
          unclassifiedLines: 0,
          oversizedLines: 1,
          signals: [{ kind: 'backoff', count: 1 }],
          httpStatuses: [{ code: 503, count: 1 }],
        });
      assert.equal(outcome.reason, name === 'ordinary-stderr' ? null : 'output-limit', name);
      assert.deepEqual(
        outcome.diagnostic,
        name === 'ordinary-stderr' ? null : { site: 'stderr-output' },
        name,
      );
    } finally {
      f.dispose();
    }
  }
  const signatureLines = [
    'UNAUTHENTICATED account=private@example.invalid',
    'quota_exceeded private/path',
    'rate_limit_exceeded secret-token',
    'rpc error: code = ResourceExhausted private reason',
    'ECONNRESET https://private.invalid?token=secret',
    'retrying in 3s',
    'PERMISSION_DENIED /private/home',
    'MODEL_NOT_FOUND private-model',
    'Traceback (most recent call last):',
    'HTTP status 400 private request',
    'HTTP/2 401 private headers',
    'HTTP status 403 private body',
    'HTTP response 404 private route',
    'HTTP error 429 private body',
    'HTTP response 503 private body',
    'HTTP status 200',
    'retry policy permits 3 attempts',
    'authentication configured; model catalog loaded; quota refreshed',
    'private status=429 and private path /HTTP/503',
  ].join('\n');
  const expectedSummary = {
    lines: 19,
    unclassifiedLines: 4,
    oversizedLines: 0,
    signals: [
      { kind: 'authentication', count: 1 },
      { kind: 'quota', count: 1 },
      { kind: 'rate-limit', count: 1 },
      { kind: 'resource-exhausted', count: 1 },
      { kind: 'network', count: 1 },
      { kind: 'backoff', count: 1 },
      { kind: 'permission', count: 1 },
      { kind: 'model', count: 1 },
      { kind: 'uncaught', count: 1 },
    ],
    httpStatuses: [
      { code: 400, count: 1 },
      { code: 401, count: 1 },
      { code: 403, count: 1 },
      { code: 404, count: 1 },
      { code: 429, count: 1 },
      { code: 503, count: 1 },
    ],
  };
  for (const chunkSize of [1, 7, 8192]) {
    const classifier = new AcpStderrClassifier();
    const bytes = Buffer.from(signatureLines);
    for (let at = 0; at < bytes.length; at += chunkSize)
      classifier.push(bytes.subarray(at, at + chunkSize));
    assert.deepEqual(classifier.finish(), expectedSummary, `stderr chunks ${chunkSize}`);
    assert.deepEqual(classifier.finish(), expectedSummary, 'EOF flush is idempotent');
    assert(!JSON.stringify(classifier.finish()).includes('private'));
  }
  for (const scenario of [
    { line: 'HTTP 502 upstream private body', signals: [] },
    {
      line: 'ERROR:root:Proxy failed to connect to CCPA API: HTTP 502 private account',
      signals: [{ kind: 'proxy-connect', count: 1 }],
    },
    {
      line: 'ERROR:root:Proxy unexpected connection error HTTP 502 private token',
      signals: [{ kind: 'proxy-unexpected', count: 1 }],
    },
  ]) {
    const classifier = new AcpStderrClassifier();
    classifier.push(Buffer.from(scenario.line));
    const summary = classifier.finish();
    assert.deepEqual(summary, {
      lines: 1,
      unclassifiedLines: 0,
      oversizedLines: 0,
      signals: scenario.signals,
      httpStatuses: [{ code: 502, count: 1 }],
    });
    assert(!JSON.stringify(summary).includes('private'));
    assert(!JSON.stringify(summary).includes('account'));
    assert(!JSON.stringify(summary).includes('token'));
  }
  const oversized = new AcpStderrClassifier();
  oversized.push(Buffer.from(`UNAUTHENTICATED${'x'.repeat(8193)}`));
  oversized.push(Buffer.from('HTTP 401\nECONNRESET\n'));
  assert.deepEqual(oversized.finish(), {
    lines: 2,
    unclassifiedLines: 0,
    oversizedLines: 1,
    signals: [{ kind: 'network', count: 1 }],
    httpStatuses: [],
  });
  const saturated = new AcpStderrClassifier();
  saturated.push(Buffer.from('HTTP 503\n'.repeat(1025)));
  assert.deepEqual(saturated.finish(), {
    lines: 1024,
    unclassifiedLines: 0,
    oversizedLines: 0,
    signals: [],
    httpStatuses: [{ code: 503, count: 1024 }],
  });
  for (const invalid of [
    { ...expectedSummary, raw: 'private' },
    { ...expectedSummary, signals: [{ kind: 'private', count: 1 }] },
    { ...expectedSummary, signals: [{ kind: 'network', count: 1025 }] },
    {
      ...expectedSummary,
      signals: [
        { kind: 'network', count: 1 },
        { kind: 'network', count: 1 },
      ],
    },
    { ...expectedSummary, httpStatuses: [{ code: 200, count: 1 }] },
    { ...expectedSummary, httpStatuses: [{ code: 503, count: 1.5 }] },
    { ...expectedSummary, httpStatuses: [{ code: 503, count: 1, message: 'private' }] },
  ])
    assert.equal(AcpStderrSummarySchema.safeParse(invalid).success, false);
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
  assert.equal(
    AcpDiagnosticSchema.safeParse({ site: 'permission-action', toolIdentityHash: 'task_boundary' })
      .success,
    false,
  );
  for (const diagnostic of [
    { site: 'permission-action', permissionStage: 'private-value' },
    { site: 'permission-action', permissionActionBytes: 1048577 },
    { site: 'permission-action', permissionActionBytes: -1 },
    { site: 'permission-action', permissionActionBytes: 1.5 },
    { site: 'permission-action', rawInput: 'private-value' },
    {
      site: 'permission-request',
      permissionSchema: {
        issueCount: 1,
        issues: [{ code: 'invalid_type', field: 'private-field', type: 'null' }],
        unknownKeyCount: 0,
        unknownKeyHashes: [],
      },
    },
    ...[
      { code: 'private-code', field: 'root', type: 'null' },
      { code: 'invalid_type', field: 'root', type: 'private-type' },
      { code: 'invalid_type', field: 'root', type: 'string', size: 1048577 },
      { code: 'invalid_type', field: 'root', type: 'null', message: 'private-value' },
    ].map((issue) => ({
      site: 'permission-request',
      permissionSchema: {
        issueCount: 1,
        issues: [issue],
        unknownKeyCount: 0,
        unknownKeyHashes: [],
      },
    })),
    ...[
      { issueCount: 1025 },
      { unknownKeyCount: 1025 },
      { issues: Array(17).fill({ code: 'invalid_type', field: 'root', type: 'null' }) },
      { unknownKeyHashes: ['private-key'] },
      { unknownKeyHashes: Array(17).fill('a'.repeat(64)) },
    ].map((extra) => ({
      site: 'permission-request',
      permissionSchema: {
        issueCount: 1,
        issues: [{ code: 'invalid_type', field: 'root', type: 'null' }],
        unknownKeyCount: 0,
        unknownKeyHashes: [],
        ...extra,
      },
    })),
  ])
    assert.equal(AcpDiagnosticSchema.safeParse(diagnostic).success, false);
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

test('a controller that registers the Google client sets it up at launch and leaves the sign-in to the person', async () => {
  const f = fixture('complete');
  const started: string[] = [];
  const clock = createTestClock();
  const id = createTestIds();
  const client = { HOME: userInfo().homedir, PATH: process.env.PATH };
  const open = () =>
    new Controller({
      home: join(f.home, 'controller'),
      now: clock.now,
      id,
      registerGoogleAcp: true,
      googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
      googleAcp: {
        reviewMappings: [f.mapping],
        spawn: ((...args: Parameters<AcpSpawn>) => {
          started.push('spawn');
          return spawnCheckChild(...args);
        }) as AcpSpawn,
        resolve: (proof) => ({
          ...resolveGoogleAcpProfile({ home: f.home, proof, environment: client }),
          client: f.client,
          environment: client,
        }),
      },
    });
  const steps = (controller: Controller) =>
    controller.store.googleMetadataOperations().map((row) => `${row.kind} ${row.state}`);
  let controller = open();
  try {
    // Before the acknowledgement the client does not start at all.
    await controller.googleAcpPreparation;
    let setup = controller.store.googleAcpSetup();
    assert.equal(setup.state, 'uninitialized');
    assert.deepEqual(started, []);
    assert.deepEqual(steps(controller), []);

    // Acknowledging Google's terms runs the launch steps at once. A fresh client initializes on
    // its own and stops before the browser sign-in, which is the person's choice.
    const acknowledged = await controller.execute(
      CommandSchema.parse({
        protocol: 1,
        key: id('cmd'),
        actor: { id: 'terminal', kind: 'cli' },
        command: 'AcknowledgeGoogleTerms',
        expectedRevision: setup.revision,
        payload: { textVersion: GOOGLE_TERMS_VERSION },
      }),
      'local-owner',
    );
    assert.equal(acknowledged.outcome, 'applied');
    await controller.googleAcpPreparation;
    setup = controller.store.googleAcpSetup();
    assert.equal(setup.state, 'authentication-required');
    assert.ok(started.length > 0);
    assert.deepEqual(steps(controller), ['acp-initialize quiescent']);

    const signIn = await controller.execute(
      CommandSchema.parse({
        protocol: 1,
        key: id('cmd'),
        actor: { id: 'terminal', kind: 'cli' },
        command: 'AuthenticateGoogleAcp',
        expectedRevision: setup.revision,
        payload: {
          profileId: 'google-acp-v1',
          proofId: setup.proofId,
          method: 'oauth-personal',
          consent: 'explicit',
        },
      }),
      'local-owner',
    );
    assert.equal(signIn.outcome, 'applied');
    assert.equal(controller.store.googleAcpSetup().state, 'discovery-required');
    await controller.close();

    // A proof that records the sign-in goes on to discover at the next launch.
    controller = open();
    await controller.googleAcpPreparation;
    setup = controller.store.googleAcpSetup();
    assert.equal(setup.state, 'ready');
    assert.deepEqual(steps(controller), [
      'acp-initialize quiescent',
      'acp-authenticate quiescent',
      'acp-discover quiescent',
    ]);
    await controller.close();

    // A ready client with a valid proof starts nothing.
    controller = open();
    await controller.googleAcpPreparation;
    assert.deepEqual(controller.store.googleAcpSetup(), setup);
    assert.equal(steps(controller).length, 3);
  } finally {
    await controller.close();
    f.dispose();
  }
});
