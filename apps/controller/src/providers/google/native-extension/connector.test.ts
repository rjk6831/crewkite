import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  type CommandResult,
  canonicalJson,
  type Snapshot,
  SnapshotSchema,
} from '@crewkite/contracts';
import { createDemoFixtures } from '../../../../../../packages/testkit/src/fixtures.ts';
import {
  BundleSchema,
  type ContextClient,
  captureContext,
  createSession,
  MAX_MESSAGE_BYTES,
  OwnedBundleSchema,
  prepareOwnedContext,
  privateFile,
  serve,
  writePrivate,
} from './connector.ts';

const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const at = Date.parse('2026-10-17T10:00:00.000Z');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const frame = (id: number, method: string, params?: object) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
type Reply = {
  error?: { code: number };
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    tools?: { name: string }[];
    protocolVersion?: string;
  };
};

function fixture() {
  const demo = createDemoFixtures();
  const task = { ...demo.task, revision: 3, state: 'stopped' as const, runId: `run_${suffix}` };
  const patch = 'diff --git a/net.mjs b/net.mjs\n+export const total = 1;\n';
  const artifact = {
    id: `art_${suffix}`,
    hash: hash(patch),
    bytes: Buffer.byteLength(patch),
    mediaType: 'text/x-patch',
  };
  const snapshot: Snapshot = SnapshotSchema.parse({
    ...demo.snapshot,
    tasks: [
      task,
      {
        ...task,
        id: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW',
        title: 'UNRELATED PRIVATE TASK',
        runId: null,
      },
    ],
    runs: [
      {
        id: task.runId,
        taskId: task.id,
        revision: 1,
        source: {
          projectId: task.projectId,
          base: 'a'.repeat(40),
          branch: 'main',
          dirtyCount: 0,
          untrackedCount: 0,
        },
        policy: { policy: demo.policy, hash: 'b'.repeat(64) },
        roles: demo.roles,
        decision: {
          chosen: demo.roles[0].routeId,
          rejected: [],
          rule: 'manual',
          inputsHash: 'c'.repeat(64),
        },
      },
    ],
    candidates: [
      {
        id: `cnd_${suffix}`,
        taskId: task.id,
        hash: 'd'.repeat(64),
        artifactId: `art_${suffix}`,
        revision: 0,
      },
    ],
    artifacts: [artifact],
  });
  const commands: string[] = [];
  let corrupt = false;
  const client: ContextClient = {
    snapshot: async () => structuredClone(snapshot),
    command: async (command): Promise<CommandResult> => {
      commands.push(command.command);
      if (command.command === 'GetChanges')
        return {
          outcome: 'applied',
          data: {
            kind: 'changes',
            taskId: task.id,
            candidateId: `cnd_${suffix}`,
            artifactId: artifact.id,
            files: [],
            diff: patch,
            truncated: false,
          },
        };
      assert.equal(command.command, 'GetArtifact');
      assert.equal(command.payload.artifactId, artifact.id);
      return {
        outcome: 'applied',
        data: {
          kind: 'artifact',
          artifact,
          offset: 0,
          encoding: 'base64',
          content: Buffer.from(corrupt ? `D${patch.slice(1)}` : patch).toString('base64'),
          eof: true,
        },
      };
    },
  };
  return {
    task,
    artifact,
    commands,
    client,
    patch,
    change: (update: (value: Snapshot) => void) => update(snapshot),
    corrupt: () => {
      corrupt = true;
    },
  };
}

async function prepared(f = fixture()) {
  const data = await captureContext(f.client, f.task.id);
  const bundle = BundleSchema.parse({
    version: 1,
    workspace: '/private/tmp/selected-workspace',
    home: '/private/tmp/selected-controller',
    expiresAt: new Date(at + 60000).toISOString(),
    ...data,
  });
  return { f, bundle };
}

async function ownedPrepared(directory: string) {
  directory = realpathSync(directory);
  const f = fixture();
  const context = await captureContext(f.client, f.task.id);
  const snapshot = await f.client.snapshot();
  const owner = {
    taskId: f.task.id,
    runId: context.binding.run.id,
    attemptId: `att_${suffix}`,
    routeId: snapshot.runs[0].roles[0].routeId,
    generation: 0,
    policyHash: hash(canonicalJson(snapshot.runs[0].policy.policy)),
    profileId: 'google-acp-v1' as const,
    selection: { proofId: `art_${suffix}`, modelId: 'model', thoughtLevelId: null },
  };
  const expiresAt = new Date(at + 60000).toISOString();
  f.change((value) => {
    value.tasks[0].revision++;
    value.tasks[0].state = 'running';
    value.runs[0].revision++;
    value.runs[0].policy.hash = owner.policyHash;
    value.attempts = [
      {
        id: owner.attemptId,
        runId: owner.runId,
        routeId: owner.routeId,
        generation: 0,
        state: 'running',
        revision: 1,
      },
    ];
    value.nativeRuns = [
      {
        runId: owner.runId,
        profileId: owner.profileId,
        stage: 'retain-only',
        expiresAt,
        target: { path: 'net.mjs', baseHash: 'a'.repeat(64), bytes: 1 },
        acp: owner.selection,
        permissionMode: 'request-review',
        billingAttestation: {
          source: 'user-attested',
          subscriptionLoginConfirmed: true,
          paidExtraUsageDisabled: true,
          quotaAccountConfirmed: true,
        },
      },
    ];
  });
  const home = join(directory, 'home');
  const scratch = join(home, 'scratch');
  const runtime = join(home, 'runtime');
  for (const path of [home, scratch, runtime]) mkdirSync(path, { mode: 0o700 });
  const input = {
    client: f.client,
    context,
    home,
    scratch,
    directory: join(runtime, 'context'),
    expiresAt,
    owner,
    now: () => at,
  };
  const result = await prepareOwnedContext(input);
  const bytes = privateFile(result.capability.path, MAX_MESSAGE_BYTES);
  const bundle = OwnedBundleSchema.parse(JSON.parse(bytes.toString('utf8')));
  return { f, bundle, result, input, bytes };
}

async function initialize(session: ReturnType<typeof createSession>) {
  const response = (await session.receive(
    frame(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fixture', version: '1' },
    }),
  )) as Reply;
  assert.equal(response.result?.protocolVersion, '2025-06-18');
  assert.equal(
    await session.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
    undefined,
  );
}

test('native context protocol discloses only the selected current bounded task', async () => {
  const { f, bundle } = await prepared();
  assert.deepEqual(f.commands, ['GetChanges', 'GetArtifact']);
  const session = createSession(bundle, {
    client: f.client,
    now: () => at,
    save: () => {
      throw Error('A read cannot save a result.');
    },
  });
  const input = new PassThrough(),
    output = new PassThrough();
  const served = serve(input, output, session);
  async function exchange(line: string, split = 0) {
    const received = once(output, 'data');
    input.write(line.slice(0, split));
    input.write(`${line.slice(split)}\n`);
    const [bytes] = await received;
    assert(Buffer.isBuffer(bytes));
    assert.equal(bytes.toString('utf8').split('\n').length, 2);
    return JSON.parse(bytes.toString('utf8')) as Reply;
  }
  try {
    const initialized = await exchange(
      frame(1, 'initialize', { protocolVersion: '2025-06-18' }),
      12,
    );
    assert.equal(initialized.result?.protocolVersion, '2025-06-18');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await exchange(frame(2, 'tools/list'));
    assert.deepEqual(
      listed.result?.tools?.map((tool) => tool.name),
      ['task_context', 'retained_patch', 'submit_unverified_result'],
    );
    const context = await exchange(frame(3, 'tools/call', { name: 'task_context', arguments: {} }));
    const content = context.result?.content?.[0].text ?? '';
    assert(content.includes(f.task.id));
    assert(!content.includes('UNRELATED PRIVATE TASK'));
    assert(!content.includes('selected-controller'));
    const retained = await exchange(
      frame(4, 'tools/call', { name: 'retained_patch', arguments: {} }),
    );
    assert.equal(JSON.parse(retained.result?.content?.[0].text ?? '{}').patch, f.patch);
    for (const [id, method, params, code] of [
      [5, 'tools/call', { name: 'task_context', arguments: { taskId: 'other' } }, -32602],
      [6, 'tools/call', { name: 'GetArtifact', arguments: { artifactId: f.artifact.id } }, -32602],
      [7, 'tasks/create', {}, -32601],
    ] as const)
      assert.equal((await exchange(frame(id, method, params))).error?.code, code);
    assert.equal((await exchange(frame(7, 'ping'))).error?.code, -32600);
    assert.equal((await exchange('{bad json')).error?.code, -32700);
    assert.equal((await exchange('[]')).error?.code, -32600);
  } finally {
    input.end();
    await served;
    output.destroy();
  }
  assert.equal(((await session.receive(frame(8, 'ping'))) as Reply).error?.code, -32000);

  for (const mutate of [
    (s: Snapshot) => {
      s.tasks[0].revision++;
    },
    (s: Snapshot) => {
      s.runs[0].source.base = 'e'.repeat(40);
    },
    (s: Snapshot) => {
      s.candidates[0].hash = 'f'.repeat(64);
    },
    (s: Snapshot) => {
      s.artifacts[0].hash = '0'.repeat(64);
    },
  ]) {
    const row = await prepared();
    const stale = createSession(row.bundle, {
      client: row.f.client,
      now: () => at,
      save: () => assert.fail('Stale context cannot write.'),
    });
    await initialize(stale);
    row.f.change(mutate);
    assert.equal(
      ((await stale.receive(frame(2, 'tools/call', { name: 'task_context' }))) as Reply).result
        ?.isError,
      true,
    );
  }
  const bad = fixture();
  bad.corrupt();
  await assert.rejects(captureContext(bad.client, bad.task.id));
  assert.equal(BundleSchema.safeParse({ ...bundle, patch: 'tampered' }).success, false);
  assert.equal(
    BundleSchema.safeParse({
      ...bundle,
      patch: 'x'.repeat(65536),
      binding: {
        ...bundle.binding,
        patch: { ...f.artifact, bytes: 65536, hash: hash('x'.repeat(65536)) },
      },
    }).success,
    false,
  );
  assert.equal(
    (
      (await createSession(bundle, { client: f.client, now: () => at, save: () => {} }).receive(
        'x'.repeat(MAX_MESSAGE_BYTES + 1),
      )) as Reply
    ).error?.code,
    -32700,
  );
  const oversizedInput = new PassThrough(),
    oversizedOutput = new PassThrough();
  let disclosed = false;
  oversizedOutput.on('data', () => {
    disclosed = true;
  });
  const bounded = serve(
    oversizedInput,
    oversizedOutput,
    createSession(bundle, {
      client: f.client,
      now: () => at,
      save: () => assert.fail('Oversized input cannot write.'),
    }),
  );
  oversizedInput.write(Buffer.alloc(MAX_MESSAGE_BYTES + 1, 120));
  await bounded;
  oversizedOutput.destroy();
  assert.equal(disclosed, false);

  const directory = mkdtempSync(join(tmpdir(), 'crewkite-owned-context-'));
  try {
    const owned = await ownedPrepared(directory);
    assert.equal(owned.result.capability.sha256, hash(owned.bytes.toString('utf8')));
    assert.deepEqual(owned.result.server.env, []);
    assert.equal(owned.result.server.args[1], '--owned-mcp');
    assert.equal(owned.result.server.args[2], owned.result.capability.path);
    assert.equal('cwd' in owned.result.server, false);
    assert.deepEqual(readdirSync(owned.input.scratch), []);
    assert.deepEqual(owned.f.commands, ['GetChanges', 'GetArtifact']);
    await assert.rejects(prepareOwnedContext(owned.input), /EEXIST/);
    await assert.rejects(
      prepareOwnedContext({
        ...owned.input,
        directory: join(owned.input.scratch, 'context'),
      }),
      /outside scratch/,
    );
    const advertised = createSession(owned.bundle, {
      client: owned.f.client,
      now: () => at,
      save: () => assert.fail('A read cannot save.'),
    });
    await initialize(advertised);
    assert.deepEqual(
      ((await advertised.receive(frame(2, 'tools/list'))) as Reply).result?.tools?.map(
        (tool) => tool.name,
      ),
      ['retained_patch', 'submit_unverified_result'],
    );
    assert.equal(
      (
        (await advertised.receive(
          frame(3, 'tools/call', { name: 'task_context', arguments: {} }),
        )) as Reply
      ).error?.code,
      -32601,
    );
    const before = await owned.f.client.snapshot();
    for (const [name, change, allowed] of [
      [
        'task activity revision',
        (s: Snapshot) => {
          s.tasks[0].revision++;
        },
        true,
      ],
      [
        'run activity revision',
        (s: Snapshot) => {
          s.runs[0].revision++;
        },
        true,
      ],
      [
        'owned approval',
        (s: Snapshot) => {
          s.tasks[0].revision++;
          s.tasks[0].state = 'waiting';
          s.tasks[0].waitingReason = 'approval';
          s.approvals = [
            {
              approvalId: `apr_${suffix}`,
              taskId: owned.bundle.owner.taskId,
              attemptId: owned.bundle.owner.attemptId,
              generation: owned.bundle.owner.generation,
              action: 'write-scratch',
              target: 'net.mjs',
              revision: s.tasks[0].revision,
              requester: 'native',
              consequence: 'Replace the selected target.',
              status: 'pending',
            },
          ];
        },
        true,
      ],
      [
        'unowned approval',
        (s: Snapshot) => {
          s.tasks[0].state = 'waiting';
          s.tasks[0].waitingReason = 'approval';
        },
        false,
      ],
      [
        'task criteria',
        (s: Snapshot) => {
          s.tasks[0].criteria = ['changed'];
        },
        false,
      ],
      [
        'source',
        (s: Snapshot) => {
          s.runs[0].source.base = 'e'.repeat(40);
        },
        false,
      ],
      [
        'policy',
        (s: Snapshot) => {
          s.runs[0].policy.policy.quality = 'thorough';
        },
        false,
      ],
      [
        'attempt generation',
        (s: Snapshot) => {
          s.attempts[0].generation++;
        },
        false,
      ],
      [
        'attempt route',
        (s: Snapshot) => {
          s.attempts[0].routeId = `rte_${'0'.repeat(26)}`;
        },
        false,
      ],
      [
        'unknown attempt',
        (s: Snapshot) => {
          s.attempts[0].state = 'unknown';
        },
        false,
      ],
      [
        'stopping',
        (s: Snapshot) => {
          s.tasks[0].state = 'stopping';
        },
        false,
      ],
      [
        'profile selection',
        (s: Snapshot) => {
          const selection = s.nativeRuns[0].acp;
          assert(selection);
          selection.modelId = 'other';
        },
        false,
      ],
      [
        'expiry changed',
        (s: Snapshot) => {
          s.nativeRuns[0].expiresAt = new Date(at + 120000).toISOString();
        },
        false,
      ],
      [
        'retained candidate',
        (s: Snapshot) => {
          s.candidates[0].hash = 'f'.repeat(64);
        },
        false,
      ],
    ] as const) {
      owned.f.change((value) => {
        Object.assign(value, structuredClone(before));
        change(value);
      });
      const session = createSession(owned.bundle, {
        client: owned.f.client,
        now: () => at,
        save: () => assert.fail('A read cannot save.'),
      });
      await initialize(session);
      const reply = (await session.receive(
        frame(2, 'tools/call', { name: 'retained_patch' }),
      )) as Reply;
      assert.equal(!reply.result?.isError, allowed, name);
      if (allowed) {
        const text = reply.result?.content?.[0].text ?? '';
        assert(!text.includes('UNRELATED PRIVATE TASK'), name);
        assert(!text.includes(owned.input.home), name);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native results stay single unverified sidecars bound to current unexpired context', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-context-'));
  try {
    const { f, bundle } = await prepared();
    const path = join(directory, 'result.unverified.json');
    const before = await f.client.snapshot();
    const session = createSession(bundle, {
      client: f.client,
      now: () => at,
      save: (text) => writePrivate(path, text),
    });
    await initialize(session);
    for (const [id, args] of [
      [2, { text: 'x'.repeat(32769) }],
      [3, { text: 'safe', taskId: 'wrong' }],
    ] as const)
      assert.equal(
        (
          (await session.receive(
            frame(id, 'tools/call', { name: 'submit_unverified_result', arguments: args }),
          )) as Reply
        ).error?.code,
        -32602,
      );
    assert.equal(
      (
        (await session.receive(
          frame(6, 'tools/call', {
            name: 'submit_unverified_result',
            arguments: { text: '界'.repeat(11000) },
          }),
        )) as Reply
      ).result?.isError,
      true,
    );
    const result = (await session.receive(
      frame(4, 'tools/call', {
        name: 'submit_unverified_result',
        arguments: {
          text: 'A proposal, not check evidence.',
          conversationId: 'untrusted-correlation',
        },
      }),
    )) as Reply;
    assert.equal(result.result?.isError, undefined);
    const bytes = privateFile(path, MAX_MESSAGE_BYTES);
    const saved = JSON.parse(bytes.toString('utf8'));
    assert.equal(saved.status, 'UNVERIFIED');
    assert.equal(saved.binding.task.id, f.task.id);
    assert.equal(saved.conversationIdentityVerified, false);
    assert.equal(saved.textHash, hash(saved.text));
    assert.equal(
      (
        (await session.receive(
          frame(5, 'tools/call', {
            name: 'submit_unverified_result',
            arguments: { text: 'second' },
          }),
        )) as Reply
      ).result?.isError,
      true,
    );
    assert.throws(() => writePrivate(path, 'replacement'));
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(await f.client.snapshot(), before);
    symlinkSync(path, join(directory, 'alias'));
    assert.throws(() => privateFile(join(directory, 'alias'), MAX_MESSAGE_BYTES));
    chmodSync(path, 0o644);
    assert.throws(() => privateFile(path, MAX_MESSAGE_BYTES));
    chmodSync(path, 0o600);
    for (const mode of ['cancelled', 'expired', 'stale', 'closed'] as const) {
      const row = await prepared();
      let now = at;
      const gate = Promise.withResolvers<Snapshot>();
      const waiting = createSession(row.bundle, {
        client: { ...row.f.client, snapshot: () => gate.promise },
        now: () => now,
        save: () => assert.fail('Invalid context cannot save.'),
      });
      await initialize(waiting);
      const pending = waiting.receive(
        frame(2, 'tools/call', {
          name: 'submit_unverified_result',
          arguments: { text: 'unsafe late proposal' },
        }),
      );
      if (mode === 'cancelled') waiting.cancel(2);
      if (mode === 'expired') now = at + 60000;
      if (mode === 'stale')
        row.f.change((s) => {
          s.tasks[0].revision++;
        });
      if (mode === 'closed') waiting.close();
      gate.resolve(await row.f.client.snapshot());
      const reply = (await pending) as Reply;
      assert(reply.result?.isError || reply.error);
    }
    const ownedRoot = join(directory, 'owned');
    mkdirSync(ownedRoot, { mode: 0o700 });
    const owned = await ownedPrepared(ownedRoot);
    const ownedResult = join(owned.input.directory, 'result.unverified.json');
    const ownedSession = createSession(owned.bundle, {
      client: owned.f.client,
      now: () => at,
      save: (text) => writePrivate(ownedResult, text),
    });
    await initialize(ownedSession);
    const accepted = (await ownedSession.receive(
      frame(2, 'tools/call', {
        name: 'submit_unverified_result',
        arguments: { text: 'An owned unverified proposal.' },
      }),
    )) as Reply;
    assert.equal(accepted.result?.isError, undefined);
    assert.deepEqual(
      JSON.parse(privateFile(ownedResult, MAX_MESSAGE_BYTES).toString()).owner,
      owned.bundle.owner,
    );
    assert.deepEqual(readdirSync(owned.input.scratch), []);
    assert.deepEqual(owned.f.commands, ['GetChanges', 'GetArtifact']);
    for (const mode of ['stopping', 'expired', 'cancelled', 'closed'] as const) {
      let now = at;
      const gate = Promise.withResolvers<Snapshot>();
      const waiting = createSession(owned.bundle, {
        client: { ...owned.f.client, snapshot: () => gate.promise },
        now: () => now,
        save: () => assert.fail('Late owned context cannot save.'),
      });
      await initialize(waiting);
      const pending = waiting.receive(
        frame(2, 'tools/call', {
          name: 'submit_unverified_result',
          arguments: { text: 'late' },
        }),
      );
      if (mode === 'stopping')
        owned.f.change((s) => {
          s.tasks[0].state = 'stopping';
        });
      if (mode === 'expired') now = at + 60000;
      if (mode === 'cancelled') waiting.cancel(2);
      if (mode === 'closed') waiting.close();
      const snapshot = await owned.f.client.snapshot();
      if (mode !== 'stopping') snapshot.tasks[0].state = 'running';
      gate.resolve(snapshot);
      const reply = (await pending) as Reply;
      assert(reply.result?.isError || reply.error, mode);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
