import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import {
  type Approval,
  type Artifact,
  ArtifactSchema,
  type Attempt,
  type Candidate,
  type CheckResult,
  canonicalJson,
  ProjectSchema,
  RunSchema,
  TaskSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { createSyntheticRepository, writeChallengeSolution } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import {
  Controller,
  type ControllerOptions,
  type NativePilotAppointment,
} from '../commands/controller.ts';
import { CandidateEvidence } from '../evidence/index.ts';
import { committedFiles, git, inspectSource, materialize, readFiles } from '../host/source.ts';
import { groupAbsent } from '../host/worker.ts';
import {
  type NativeProfileResolution,
  unavailableNativeProfile,
} from '../providers/openai/profile.ts';
import { fixture, fixtureContent, fixtureModel } from '../providers/openai/replacement-fixture.ts';

async function setup(t: TestContext, options: Partial<ControllerOptions> = {}) {
  mkdirSync(resolve('internal'), { recursive: true });
  const directory = mkdtempSync(join(resolve('internal'), 'controller-test-'));
  const clock = createTestClock();
  const id = createTestIds(clock.now(), 1000n);
  const fixtures = createDemoFixtures(clock.now());
  const source = createSyntheticRepository(join(directory, 'demo-shop'));
  const controller = new Controller({
    ...options,
    home: join(directory, 'home'),
    now: clock.now,
    id,
    routes: fixtures.snapshot.routes,
    observations: fixtures.snapshot.usage.map((window) => window.observation),
  });
  t.after(async () => {
    await controller.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const command = (name: string, payload: unknown, revision?: number) => ({
    protocol: 1,
    key: id('cmd'),
    actor: { id: 'terminal', kind: 'cli' },
    command: name,
    payload,
    ...(revision === undefined ? {} : { expectedRevision: revision }),
  });
  const project = ProjectSchema.parse(
    (
      await controller.execute(
        command('RegisterProject', { path: source.directory }, 0),
        'local-owner',
      )
    ).entity,
  );
  const draft = command(
    'CreateTask',
    {
      projectId: project.id,
      title: fixtures.task.title,
      outcome: fixtures.task.outcome,
      criteria: fixtures.task.criteria,
    },
    0,
  );
  return { controller, command, draft, fixtures, source, directory, clock, id };
}

function quickRoles(fixtures: ReturnType<typeof createDemoFixtures>) {
  return [
    ...fixtures.roles,
    {
      role: 'advisor' as const,
      routeId: fixtures.snapshot.routes[0].id,
      pinned: false,
      approvedFallbacks: [],
    },
  ];
}

test('an idempotent retry returns the receipt without creating another task', async (t) => {
  const { controller, draft } = await setup(t);
  const first = await controller.execute(draft, 'local-owner');
  const retry = await controller.execute(draft, 'local-owner');
  assert.equal(first.outcome, 'applied');
  assert.equal(retry.outcome, 'already-applied');
  assert.deepEqual(retry.entity, first.entity);
  assert.equal(controller.snapshot().tasks.length, 1);
  assert.equal(
    controller.store.eventsAfter('0').filter((event) => event.type === 'task.created').length,
    1,
  );
});

test('reusing a command key with changed content cannot change its result', async (t) => {
  const { controller, draft } = await setup(t);
  const first = await controller.execute(draft, 'local-owner');
  const changed = {
    ...draft,
    payload: { ...(draft.payload as object), title: 'Changed criteria' },
  };
  assert.equal((await controller.execute(changed, 'local-owner')).reason, 'idempotency-key-reused');
  assert.deepEqual(controller.snapshot().tasks, [first.entity]);
});

test('a stale task revision leaves the current task and event cursor intact', async (t) => {
  const { controller, command, draft } = await setup(t);
  const task = TaskSchema.parse((await controller.execute(draft, 'local-owner')).entity);
  const amend = {
    taskId: task.id,
    title: task.title,
    outcome: 'A bounded amendment.',
    criteria: task.criteria,
  };
  const updated = await controller.execute(command('AmendTask', amend, 0), 'local-owner');
  const cursor = controller.snapshot().cursor;
  const stale = await controller.execute(
    command('AmendTask', { ...amend, outcome: 'Stale amendment.' }, 0),
    'local-owner',
  );
  assert.equal(stale.outcome, 'stale-revision');
  assert.deepEqual(stale.entity, updated.entity);
  assert.equal(controller.snapshot().cursor, cursor);
  const receipts = controller.store.db
    .prepare('SELECT COUNT(*) AS count FROM receipts')
    .get()?.count;
  await controller.execute(command('GetSnapshot', {}), 'local-owner');
  await controller.execute(command('GetUsage', {}), 'local-owner');
  assert.equal(
    controller.store.db.prepare('SELECT COUNT(*) AS count FROM receipts').get()?.count,
    receipts,
  );
  assert.equal(
    (await controller.execute(command('GetSnapshot', {}), 'untrusted')).outcome,
    'denied',
  );
});

test('a prepared draft is editable only before it has pending work', async (t) => {
  const { controller, command, draft, fixtures } = await setup(t);
  const task = TaskSchema.parse((await controller.execute(draft, 'local-owner')).entity);
  const amend = {
    taskId: task.id,
    title: task.title,
    outcome: 'Revised before launch.',
    criteria: task.criteria,
  };
  const policy = { ...fixtures.policy, quality: 'quick', methods: [], effects: [] };
  const roles = quickRoles(fixtures);
  const prepare = () =>
    command(
      'PrepareRun',
      { taskId: task.id, policy, roles },
      controller.snapshot().tasks[0].revision,
    );
  const first = RunSchema.parse((await controller.execute(prepare(), 'local-owner')).entity);
  const second = RunSchema.parse((await controller.execute(prepare(), 'local-owner')).entity);
  assert.notEqual(first.id, second.id);
  assert.ok(controller.snapshot().runs.some((run) => run.id === first.id));
  assert.equal(controller.store.intents().length, 0);
  const edited = await controller.execute(
    command('AmendTask', amend, controller.snapshot().tasks[0].revision),
    'local-owner',
  );
  assert.equal(TaskSchema.parse(edited.entity).runId, null);
  assert.equal(TaskSchema.parse(edited.entity).next, 'Prepare the run.');
  const prepared = RunSchema.parse((await controller.execute(prepare(), 'local-owner')).entity);
  const attemptId = `att_${'0'.repeat(25)}1`;
  controller.store.transaction(() =>
    controller.store.put('attempt', attemptId, 0, {
      id: attemptId,
      runId: prepared.id,
      routeId: roles[0].routeId,
      generation: 0,
      state: 'intent',
      revision: 0,
    }),
  );
  for (const action of [
    prepare(),
    command('AmendTask', amend, controller.snapshot().tasks[0].revision),
  ])
    assert.equal((await controller.execute(action, 'local-owner')).reason, 'prepared-run-started');
  const approvalId = `apr_${'0'.repeat(25)}1`;
  controller.store.transaction(() => {
    controller.store.put('approval', approvalId, 0, {
      approvalId,
      taskId: task.id,
      attemptId,
      generation: 0,
      action: 'write-scratch',
      target: 'demo-shop',
      revision: 0,
      requester: 'Controller',
      consequence: 'One scratch allocation.',
      status: 'approved',
    });
    controller.store.db
      .prepare(
        "INSERT INTO pending_effects(approval_id,task_id,attempt_id,task_revision,effect_hash,request,state) VALUES (?,?,?,?,?,?,'approved')",
      )
      .run(
        approvalId,
        task.id,
        attemptId,
        controller.snapshot().tasks[0].revision,
        'a'.repeat(64),
        '{}',
      );
  });
  for (const action of [
    prepare(),
    command('AmendTask', amend, controller.snapshot().tasks[0].revision),
  ])
    assert.equal(
      (await controller.execute(action, 'local-owner')).reason,
      'draft-has-pending-work',
    );
  assert.equal(controller.store.intents().length, 0);
  assert.equal(controller.snapshot().tasks[0].runId, prepared.id);
});

test('new preparations enforce review floors and require eligible method roles', async (t) => {
  const { controller, command, draft, fixtures } = await setup(t);
  const task = TaskSchema.parse((await controller.execute(draft, 'local-owner')).entity);
  const roles = [
    ...fixtures.roles,
    {
      role: 'reviewer',
      routeId: fixtures.snapshot.routes[0].id,
      pinned: true,
      approvedFallbacks: [],
    },
  ];
  for (const [quality, expected] of [
    ['quick', ['keep-it-simple']],
    ['standard', ['keep-it-simple', 'second-opinion']],
    ['thorough', ['keep-it-simple', 'second-opinion', 'challenge-assumptions']],
  ] as const) {
    const result = await controller.execute(
      command(
        'PrepareRun',
        {
          taskId: task.id,
          roles,
          policy: {
            ...fixtures.policy,
            quality,
            methods: [],
            effects: [],
            limits: { attempts: 5, minutes: 30, concurrency: 1 },
          },
        },
        controller.snapshot().tasks[0].revision,
      ),
      'local-owner',
    );
    const run = RunSchema.parse(result.entity);
    assert.deepEqual(
      run.policy.policy.methods?.map((method) => method.id),
      expected,
    );
    const reordered = await controller.execute(
      command(
        'PrepareRun',
        {
          taskId: task.id,
          roles,
          policy: {
            ...run.policy.policy,
            methods: [...(run.policy.policy.methods ?? [])].reverse(),
          },
        },
        controller.snapshot().tasks[0].revision,
      ),
      'local-owner',
    );
    assert.equal(RunSchema.parse(reordered.entity).policy.hash, run.policy.hash);
  }
  for (const [id, reason] of [
    ['second-opinion', 'review-role-ineligible'],
    ['round-robin', 'review-panel-unavailable'],
  ]) {
    const result = await controller.execute(
      command(
        'PrepareRun',
        {
          taskId: task.id,
          roles: quickRoles(fixtures),
          policy: {
            ...fixtures.policy,
            quality: 'quick',
            methods: [{ id, cycles: 1, reviewerRole: 'advisor' }],
          },
        },
        controller.snapshot().tasks[0].revision,
      ),
      'local-owner',
    );
    assert.equal(result.reason, reason);
  }
  const missing = await controller.execute(
    command(
      'PrepareRun',
      {
        taskId: task.id,
        roles: quickRoles(fixtures),
        policy: { ...fixtures.policy, quality: 'standard' },
      },
      controller.snapshot().tasks[0].revision,
    ),
    'local-owner',
  );
  assert.equal(missing.reason, 'review-role-missing');
  assert.equal(controller.store.intents().length, 0);
});

test('a committed launch intent survives restart without another launch', async (t) => {
  let launches = 0;
  const { controller, command, draft, fixtures, directory, clock, id, source } = await setup(t, {
    afterIntent: () => {
      launches++;
      throw new Error('Simulated crash after intent commit.');
    },
  });
  const task = TaskSchema.parse((await controller.execute(draft, 'local-owner')).entity);
  const policy = {
    ...fixtures.policy,
    quality: 'quick',
    methods: [],
    effects: fixtures.policy.effects.map((grant) => ({ ...grant, taskId: task.id })),
  };
  const prepared = await controller.execute(
    command('PrepareRun', { taskId: task.id, policy, roles: quickRoles(fixtures) }, task.revision),
    'local-owner',
  );
  const run = RunSchema.parse(prepared.entity);
  const start = command('StartRun', { taskId: task.id, runId: run.id }, prepared.revision);
  await assert.rejects(controller.execute(start, 'local-owner'), /Simulated crash/);
  assert.equal(launches, 1);
  assert.equal(controller.store.intents().length, 1);
  assert.equal(controller.store.intents()[0].state, 'intent');
  assert.equal(controller.store.intents()[0].pid, null);
  assert.equal((await controller.execute(start, 'local-owner')).outcome, 'already-applied');
  assert.equal(launches, 1);
  controller.close();
  const recovered = new Controller({
    home: join(directory, 'home'),
    now: clock.now,
    id,
    afterIntent: () => {
      launches++;
    },
  });
  assert.throws(
    () => new Controller({ home: join(directory, 'home'), now: clock.now, id }),
    /locked/,
  );
  const snapshot = recovered.snapshot();
  assert.equal(snapshot.tasks[0].state, 'unknown');
  assert.equal(recovered.store.intents()[0].state, 'outcome-unknown');
  assert.equal(
    (
      await recovered.execute(
        command('ResumeRun', { taskId: task.id, runId: run.id }, snapshot.tasks[0].revision),
        'local-owner',
      )
    ).reason,
    'writer-ownership-unknown',
  );
  assert.equal(launches, 1);
  materialize(
    join(directory, 'home', 'scratch', run.id),
    committedFiles(source.directory, run.source.base),
  );
  const owned = spawn(
    process.execPath,
    ['-e', "process.stdin.resume();process.stdout.write('ready\\n');"],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} },
  );
  t.after(() => owned.stdin.end());
  await once(owned.stdout, 'data');
  const group = owned.pid;
  recovered.store.transaction(() =>
    recovered.store.db
      .prepare(
        "UPDATE launch_intents SET state='acknowledged',pid=?,process_group=? WHERE attempt_id=?",
      )
      .run(group as number, group as number, recovered.store.intents()[0].attempt_id),
  );
  recovered.close();
  const present = new Controller({ home: join(directory, 'home'), now: clock.now, id });
  assert.equal(present.snapshot().tasks[0].state, 'unknown');
  assert.equal(present.store.intents()[0].state, 'acknowledged');
  present.close();
  owned.stdin.end();
  await once(owned, 'exit');
  const absent = new Controller({
    home: join(directory, 'home'),
    now: clock.now,
    id,
    afterIntent: () => {
      launches++;
      throw new Error('Explicit resume reached admission.');
    },
  });
  assert.equal(absent.snapshot().tasks[0].state, 'interrupted');
  assert.equal(absent.store.intents()[0].finished_at, clock.now());
  const revision = absent.snapshot().tasks[0].revision;
  await assert.rejects(
    absent.execute(
      command('ResumeRun', { taskId: task.id, runId: run.id }, revision),
      'local-owner',
    ),
    /Explicit resume/,
  );
  assert.equal(launches, 2);
  absent.close();
  const phases = ['effective-features', 'metadata-preparation', 'app-server-task'] as const;
  for (const entry of [
    { sequence: 0, state: 'intent', unknown: true },
    { sequence: 1, state: 'intent', unknown: true },
    { sequence: 2, state: 'intent', unknown: true },
    { sequence: 2, state: 'owned-present', unknown: true },
    { sequence: 2, state: 'owned-absent', unknown: false },
    { sequence: 0, state: 'quiescent', unknown: false },
    { sequence: 1, state: 'quiescent', unknown: false },
    { sequence: 2, state: 'quiescent', unknown: false },
  ]) {
    let submissions = 0;
    const fixture = await setup(t, {
      afterIntent: () => {
        submissions++;
        throw new Error('Native fixture stopped after admission.');
      },
    });
    const task = TaskSchema.parse(
      (await fixture.controller.execute(fixture.draft, 'local-owner')).entity,
    );
    const prepared = await fixture.controller.execute(
      fixture.command(
        'PrepareRun',
        {
          taskId: task.id,
          policy: {
            ...fixture.fixtures.policy,
            quality: 'quick',
            methods: [],
            effects: fixture.fixtures.policy.effects.map((grant) => ({
              ...grant,
              taskId: task.id,
            })),
          },
          roles: quickRoles(fixture.fixtures),
        },
        task.revision,
      ),
      'local-owner',
    );
    const run = RunSchema.parse(prepared.entity);
    await assert.rejects(
      fixture.controller.execute(
        fixture.command('StartRun', { taskId: task.id, runId: run.id }, prepared.revision),
        'local-owner',
      ),
      /Native fixture stopped/,
    );
    const intent = fixture.controller.store.intents()[0];
    const processes: Array<{ child: ReturnType<typeof spawn>; closed: Promise<void> }> = [];
    t.after(async () => {
      for (const process of processes) process.child.stdin?.end();
      await Promise.all(processes.map((process) => process.closed));
    });
    assert.throws(
      () =>
        fixture.controller.store.intendNativePhase(
          intent.attempt_id,
          0,
          phases[0],
          fixture.clock.now(),
        ),
      /require a transaction/,
    );
    for (let sequence = 0; sequence <= entry.sequence; sequence++) {
      fixture.controller.store.transaction(() => {
        assert.throws(
          () =>
            fixture.controller.store.intendNativePhase(
              intent.attempt_id,
              sequence + 1,
              phases[sequence],
              fixture.clock.now(),
            ),
          /preceding process/,
        );
        fixture.controller.store.intendNativePhase(
          intent.attempt_id,
          sequence,
          phases[sequence],
          fixture.clock.now(),
        );
      });
      if (sequence === entry.sequence && entry.state === 'intent') break;
      const child = spawn(
        process.execPath,
        ['-e', "process.stdin.resume();process.stdout.write('ready\\n');"],
        {
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {},
        },
      );
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      processes.push({ child, closed });
      await once(child.stdout, 'data');
      const group = child.pid as number;
      fixture.controller.store.transaction(() => {
        assert.throws(
          () => fixture.controller.store.ownNativePhase(intent.attempt_id, sequence, 0),
          /positive integer/,
        );
        fixture.controller.store.ownNativePhase(intent.attempt_id, sequence, group);
        assert.throws(
          () =>
            fixture.controller.store.intendNativePhase(
              intent.attempt_id,
              sequence + 1,
              phases[Math.min(2, sequence + 1)],
              fixture.clock.now(),
            ),
          /preceding process/,
        );
      });
      if (sequence === entry.sequence && entry.state === 'owned-present') break;
      child.stdin.end();
      await closed;
      if (sequence === entry.sequence && entry.state === 'owned-absent') break;
      fixture.controller.store.transaction(() => {
        assert.throws(
          () =>
            fixture.controller.store.finishNativePhase(
              intent.attempt_id,
              sequence,
              0,
              fixture.clock.now(),
            ),
          /ownership does not match/,
        );
        fixture.controller.store.finishNativePhase(
          intent.attempt_id,
          sequence,
          group,
          fixture.clock.now(),
        );
      });
    }
    fixture.controller.close();
    const recovered = new Controller({
      home: join(fixture.directory, 'home'),
      now: fixture.clock.now,
      id: fixture.id,
      afterIntent: () => {
        submissions++;
      },
    });
    try {
      assert.equal(
        recovered.snapshot().tasks[0].state,
        entry.unknown ? 'unknown' : 'interrupted',
        `${entry.sequence}/${entry.state}`,
      );
      assert.equal(
        recovered.snapshot().candidates.length,
        0,
        'restart cannot apply or seal native output',
      );
      assert.equal(recovered.store.nativeProcesses(intent.attempt_id).length, entry.sequence + 1);
      assert.equal(
        recovered.store.db.prepare('SELECT COUNT(*) AS count FROM writer_leases').get()?.count,
        entry.unknown ? 1 : 0,
      );
      assert.equal(submissions, 1, 'restart cannot resubmit or advance a native phase');
    } finally {
      recovered.close();
      for (const process of processes) process.child.stdin?.end();
      await Promise.all(processes.map((process) => process.closed));
    }
  }
});

test('a retained descendant blocks sealing and transfer after its leader exits', async (t) => {
  const { controller, command, draft, fixtures } = await setup(t, {
    scenarioForRoute: () => 'stubborn',
  });
  const task = TaskSchema.parse((await controller.execute(draft, 'local-owner')).entity);
  const policy = {
    ...fixtures.policy,
    quality: 'quick',
    methods: [],
    effects: fixtures.policy.effects.map((grant) => ({ ...grant, taskId: task.id })),
  };
  const prepared = await controller.execute(
    command('PrepareRun', { taskId: task.id, policy, roles: quickRoles(fixtures) }, 0),
    'local-owner',
  );
  const run = RunSchema.parse(prepared.entity);
  const ready = new Promise<void>((resolve) => {
    const off = controller.subscribe((event) => {
      if (event.type === 'attempt.output' && event.payload.text.includes('stubborn-child-ready')) {
        off();
        resolve();
      }
    });
  });
  await controller.execute(
    command('StartRun', { taskId: task.id, runId: run.id }, prepared.revision),
    'local-owner',
  );
  const group = controller.store.intents()[0].process_group;
  t.after(() => {
    if (group)
      try {
        process.kill(-group, 'SIGKILL');
      } catch {}
  });
  await ready;
  const unknown = new Promise<void>((resolve) => {
    const off = controller.subscribe((event) => {
      if (event.type === 'ownership.unknown') {
        off();
        resolve();
      }
    });
  });
  const current = controller.snapshot().tasks[0];
  await controller.execute(
    command('StopRun', { taskId: task.id, runId: run.id }, current.revision),
    'local-owner',
  );
  await unknown;
  const stopped = controller.snapshot().tasks[0];
  assert.equal(stopped.state, 'unknown');
  assert.equal(controller.snapshot().attempts[0].state, 'unknown');
  assert.equal(
    (await controller.execute(command('GetChanges', { taskId: task.id }), 'local-owner')).reason,
    'writer-ownership-unknown',
  );
  assert.equal(
    (
      await controller.execute(
        command('ResumeRun', { taskId: task.id, runId: run.id }, stopped.revision),
        'local-owner',
      )
    ).reason,
    'writer-ownership-unknown',
  );
});

test('candidate evidence requires unchanged bytes and completed checks', async (t) => {
  const { controller, command, draft, fixtures, directory, id, source } = await setup(t);
  const task = TaskSchema.parse((await controller.execute(draft, 'local-owner')).entity);
  const policy = {
    ...fixtures.policy,
    quality: 'quick',
    methods: [],
    effects: [
      ...fixtures.policy.effects.map((grant) => ({ ...grant, taskId: task.id })),
      {
        taskId: task.id,
        action: 'run-review',
        target: 'keep-it-simple/cycle-1',
        expiresAt: fixtures.policy.effects[0].expiresAt,
        revoked: false,
        usesRemaining: 1,
      },
    ],
  };
  const prepared = await controller.execute(
    command('PrepareRun', { taskId: task.id, policy, roles: quickRoles(fixtures) }, 0),
    'local-owner',
  );
  const run = RunSchema.parse(prepared.entity);
  const ready = new Promise<void>((resolve) => {
    const off = controller.subscribe((event) => {
      if (event.type === 'task.updated' && event.payload.state === 'ready') {
        off();
        resolve();
      }
    });
  });
  await controller.execute(
    command('StartRun', { taskId: task.id, runId: run.id }, prepared.revision),
    'local-owner',
  );
  await ready;
  const snapshot = controller.snapshot();
  assert.equal(snapshot.evidence.filter((check) => !check.review).length, 1);
  assert.equal(
    snapshot.evidence.filter((check) => check.review?.job.methodId === 'keep-it-simple').length,
    1,
  );
  assert.match(snapshot.tasks[0].next ?? '', /No independent review/);
  assert.equal(snapshot.evidence[0].passed, true);
  assert.equal(snapshot.evidence[0].candidateHash, snapshot.candidates[0].hash);
  appendFileSync(join(controller.home, 'scratch', run.id, 'net.mjs'), ' ');
  assert.equal(
    (
      await controller.execute(
        command(
          'AcceptCandidate',
          {
            taskId: task.id,
            candidateId: snapshot.candidates[0].id,
            destinationRef: 'refs/heads/feat/net-minor',
          },
          snapshot.tasks[0].revision,
        ),
        'local-owner',
      )
    ).reason,
    'candidate-binding-changed',
  );
  const scratch = join(controller.home, 'scratch', run.id);
  const module = join(scratch, 'net.mjs');
  writeFileSync(module, Buffer.concat([Buffer.from('process.exit(0);\n'), readFileSync(module)]));
  const metadata = new Map<string, Artifact>();
  const evidence = new CandidateEvidence({
    home: directory,
    artifacts: new ArtifactFiles(join(directory, 'negative-artifacts')),
    id,
    getArtifact: (artifactId) => {
      const artifact = metadata.get(artifactId);
      if (!artifact) throw new Error('Missing fixture artifact.');
      return artifact;
    },
  });
  const captured = evidence.capture({
    taskId: task.id,
    base: source.base,
    files: readFiles(scratch),
    existing: [],
  });
  for (const artifact of captured.artifacts) metadata.set(artifact.id, artifact);
  const definition = evidence.describeChecks({
    candidate: captured.candidate,
    sourceFiles: committedFiles(source.directory, source.base),
    criteria: task.criteria,
  });
  assert.throws(
    () =>
      evidence.prepareChecks({
        candidate: captured.candidate,
        sourceFiles: committedFiles(source.directory, source.base),
        criteria: task.criteria,
        expected: { ...definition, required: { ...definition.required, tests: [] } },
      }),
    /frozen check definition changed/,
  );
  const plan = evidence.prepareChecks({
    candidate: captured.candidate,
    sourceFiles: committedFiles(source.directory, source.base),
    criteria: task.criteria,
    expected: definition,
  });
  const output = execFileSync(process.execPath, plan.argv, {
    cwd: plan.directory,
    env: { PATH: process.env.PATH, LANG: 'C', HOME: controller.home },
    maxBuffer: 1024 * 1024,
  });
  assert.equal(
    evidence.recordCheck({ candidate: captured.candidate, plan, passed: true, output }).evidence
      .passed,
    false,
  );
});

function binding(approval: Approval) {
  return {
    approvalId: approval.approvalId,
    taskId: approval.taskId,
    attemptId: approval.attemptId,
    generation: approval.generation,
    action: approval.action,
    target: approval.target,
    revision: approval.revision,
  };
}

test('acceptance creates one checked branch and preserves the original source', async (t) => {
  for (const transfer of ['reserve', 'manual'] as const)
    await acceptsTransferredCandidate(t, transfer);
});

async function acceptsTransferredCandidate(t: TestContext, transfer: 'reserve' | 'manual') {
  const identity = { name: 'Fixture owner', email: 'owner@example.invalid' };
  let { controller, command, draft, fixtures, source, directory, clock, id } = await setup(t, {
    identity,
    scenarioForRoute: (route, generation) =>
      (route.family === 'anthropic' && generation === 0) ||
      (transfer === 'manual' && generation === 1)
        ? 'approval-reserve'
        : 'complete',
  });
  let base = source.base;
  const tree = git(source.directory, ['rev-parse', `${base}^{tree}`])
    .toString()
    .trim();
  for (let index = 0; index < 2; index++) {
    const next = git(
      source.directory,
      ['commit-tree', tree, '-p', base],
      `fixture history ${index}\n`,
      { ...identity, at: clock.now() },
    )
      .toString()
      .trim();
    git(source.directory, ['update-ref', 'refs/heads/main', next, base]);
    base = next;
  }
  const canary = join(directory, 'filter-executed');
  writeFileSync(join(source.directory, '.gitattributes'), '*.mjs filter=canary\n');
  git(source.directory, ['config', 'filter.canary.clean', `touch '${canary}'`]);
  const index = readFileSync(join(source.directory, '.git', 'index'));
  const sentinels = source.sentinels.map((file) => ({
    path: file.path,
    bytes: readFileSync(join(source.directory, file.path)),
    mode: lstatSync(join(source.directory, file.path)).mode & 0o777,
  }));
  const task = TaskSchema.parse((await controller.execute(draft, 'local-owner')).entity);
  const methods = ['second-opinion', 'keep-it-simple'] as const;
  const policy = {
    ...fixtures.policy,
    limits: { attempts: transfer === 'manual' ? 6 : 5, minutes: 30, concurrency: 1 },
    effects: [
      ...fixtures.policy.effects
        .filter((grant) => !['run-check', 'accept-candidate'].includes(grant.action))
        .map((grant) => ({
          ...grant,
          taskId: task.id,
          target: grant.action === 'export-patch' ? task.id : grant.target,
        })),
      ...methods.map((method) => ({
        taskId: task.id,
        action: 'run-review',
        target: `${method}/cycle-1`,
        expiresAt: fixtures.policy.effects[0].expiresAt,
        revoked: false,
        usesRemaining: 1,
      })),
    ],
  };
  const roles = [
    ...fixtures.roles.map((role) => ({ ...role, pinned: transfer === 'manual' })),
    {
      role: 'reviewer',
      routeId: fixtures.snapshot.routes[0].id,
      pinned: true,
      approvedFallbacks: [],
    },
  ];
  const ungranted = {
    ...policy,
    effects: policy.effects.filter((grant) => grant.action !== 'write-scratch'),
  };
  const planned = await controller.execute(
    command('PrepareRun', { taskId: task.id, policy: ungranted, roles }, 0),
    'local-owner',
  );
  const plannedRun = RunSchema.parse(planned.entity);
  const waiting = await controller.execute(
    command('StartRun', { taskId: task.id, runId: plannedRun.id }, planned.revision),
    'local-owner',
  );
  const cancelled = controller
    .snapshot()
    .approvals.find((value) => value.status === 'pending') as Approval;
  const stopped = await controller.execute(
    command('StopRun', { taskId: task.id, runId: plannedRun.id }, waiting.revision),
    'local-owner',
  );
  assert.equal(
    controller.snapshot().approvals.filter((value) => value.status === 'pending').length,
    0,
  );
  assert.equal(
    (
      await controller.execute(
        command(
          'ResolveApproval',
          { binding: binding(cancelled), decision: 'approved' },
          stopped.revision,
        ),
        'local-owner',
      )
    ).reason,
    'approval-not-pending',
  );
  const prepared = await controller.execute(
    command(
      'PrepareRun',
      { taskId: task.id, policy, roles },
      controller.snapshot().tasks[0].revision,
    ),
    'local-owner',
  );
  const run = RunSchema.parse(prepared.entity);
  const nextApproval = () =>
    new Promise<Approval>((resolve) => {
      const off = controller.subscribe((event) => {
        if (event.type === 'approval.requested' && event.payload.action === 'run-check') {
          off();
          resolve(event.payload);
        }
      });
    });
  if (transfer === 'manual')
    assert.equal(
      (
        await controller.execute(
          command(
            'SwitchRoute',
            { taskId: task.id, runId: run.id, routeId: fixtures.snapshot.routes[0].id },
            prepared.revision,
          ),
          'local-owner',
        )
      ).reason,
      'switch-needs-writer',
    );
  const approvalReady = nextApproval();
  const completion = () =>
    new Promise<void>((resolve) => {
      const off = controller.subscribe((event) => {
        if (
          event.type === 'task.updated' &&
          ['ready', 'failed', 'unknown'].includes(event.payload.state)
        ) {
          off();
          resolve();
        }
      });
    });
  let completed = completion();
  await controller.execute(
    command('StartRun', { taskId: task.id, runId: run.id }, prepared.revision),
    'local-owner',
  );
  let approval = await approvalReady;
  if (transfer === 'manual') {
    const target = fixtures.snapshot.routes[0].id;
    const unrelated = fixtures.snapshot.routes[2].id;
    assert.equal(
      (
        await controller.execute(
          command(
            'SwitchRoute',
            { taskId: task.id, runId: run.id, routeId: unrelated },
            controller.snapshot().tasks[0].revision,
          ),
          'local-owner',
        )
      ).reason,
      'route-not-approved',
    );
    assert.equal(
      (
        await controller.execute(
          command(
            'SwitchRoute',
            { taskId: task.id, runId: run.id, routeId: target },
            controller.snapshot().tasks[0].revision,
          ),
          'local-owner',
        )
      ).reason,
      'route-not-admissible',
    );
    assert.equal(controller.snapshot().tasks[0].state, 'waiting');
    const primary = fixtures.snapshot.usage[1].observation;
    const setPrimary = (value: number) =>
      controller.store.transaction(() =>
        controller.store.put('window', `${primary.routeId}/${primary.windowId}`, 0, {
          ...primary,
          remaining: { value, unit: 'percent' },
        }),
      );
    setPrimary(5);
    const restorePin = controller.subscribe((event) => {
      if (event.type === 'attempt.stopped' && event.payload.generation === 0) {
        restorePin();
        setPrimary(30);
      }
    });
    const targetBlocked = new Promise<void>((resolve) => {
      const off = controller.subscribe((event) => {
        if (
          event.type === 'task.updated' &&
          event.payload.state === 'stopped' &&
          event.payload.next?.includes('Admissions are paused')
        ) {
          off();
          resolve();
        }
      });
    });
    const switchCommand = command(
      'SwitchRoute',
      { taskId: task.id, runId: run.id, routeId: target },
      controller.snapshot().tasks[0].revision,
    );
    assert.equal((await controller.execute(switchCommand, 'local-owner')).outcome, 'applied');
    assert.equal(
      (await controller.execute(switchCommand, 'local-owner')).outcome,
      'already-applied',
    );
    assert.equal(
      (
        await controller.execute(
          command(
            'PauseAdmissions',
            { taskId: task.id, runId: run.id },
            controller.snapshot().tasks[0].revision,
          ),
          'local-owner',
        )
      ).outcome,
      'applied',
    );
    await targetBlocked;
    assert.equal(controller.snapshot().tasks[0].state, 'stopped');
    assert.ok(controller.store.receipt(`paused:${run.id}`));
    assert.equal(
      (
        await controller.execute(
          command(
            'ResumeRun',
            { taskId: task.id, runId: run.id },
            controller.snapshot().tasks[0].revision,
          ),
          'local-owner',
        )
      ).reason,
      'route-not-admissible',
    );
    assert.equal(controller.store.intents().filter((intent) => intent.run_id === run.id).length, 1);
    assert.equal(controller.store.receipt(`switch:${run.id}`)?.result.outcome, 'outcome-unknown');
    const home = controller.home;
    controller.close();
    controller = new Controller({
      home,
      now: clock.now,
      id,
      identity,
      scenarioForRoute: (_route, generation) =>
        generation === 1 ? 'approval-reserve' : 'complete',
    });
    t.after(() => controller.close());
    assert.equal(controller.store.intents().filter((intent) => intent.run_id === run.id).length, 1);
    controller.store.transaction(() =>
      controller.store.put('window', `${primary.routeId}/${primary.windowId}`, 0, {
        ...primary,
        remaining: { value: 5, unit: 'percent' },
      }),
    );
    completed = completion();
    const checkApproval = nextApproval();
    const resumed = await controller.execute(
      command(
        'ResumeRun',
        { taskId: task.id, runId: run.id },
        controller.snapshot().tasks[0].revision,
      ),
      'local-owner',
    );
    assert.equal(resumed.outcome, 'applied');
    approval = await checkApproval;
    setPrimary(30);
    const finalApproval = nextApproval();
    const secondSwitch = command(
      'SwitchRoute',
      { taskId: task.id, runId: run.id, routeId: primary.routeId },
      controller.snapshot().tasks[0].revision,
    );
    assert.equal((await controller.execute(secondSwitch, 'local-owner')).outcome, 'applied');
    assert.equal(
      (await controller.execute(secondSwitch, 'local-owner')).outcome,
      'already-applied',
    );
    approval = await finalApproval;
    assert.equal(
      controller
        .snapshot()
        .approvals.find(
          (item) =>
            item.approvalId !== approval.approvalId && item.attemptId !== cancelled.attemptId,
        )?.status,
      'denied',
    );
  }
  const approved = await controller.execute(
    command(
      'ResolveApproval',
      { binding: binding(approval), decision: 'approved' },
      controller.snapshot().tasks[0].revision,
    ),
    'local-owner',
  );
  assert.equal(approved.outcome, 'applied');
  await completed;
  const snapshot = controller.snapshot();
  assert.equal(
    snapshot.tasks[0].state,
    'ready',
    snapshot.tasks[0].next ?? 'Task did not become ready.',
  );
  assert.equal(
    snapshot.attempts.filter((attempt) => attempt.runId === run.id).length,
    transfer === 'manual' ? 6 : 5,
  );
  assert.deepEqual(snapshot.runs.find((value) => value.id === run.id)?.policy, run.policy);
  assert.deepEqual(snapshot.runs.find((value) => value.id === run.id)?.roles, run.roles);
  if (transfer === 'manual') {
    assert.equal(controller.store.receipt(`switch:${run.id}`)?.result.outcome, 'applied');
    assert.deepEqual(
      controller.store
        .intents()
        .filter((intent) => intent.scratch_path === join(controller.home, 'scratch', run.id))
        .map((intent) => intent.route_id),
      [
        fixtures.snapshot.routes[1].id,
        fixtures.snapshot.routes[0].id,
        fixtures.snapshot.routes[1].id,
      ],
    );
  }
  assert.equal(snapshot.evidence.filter((check) => check.review).length, 2);
  assert.ok(snapshot.evidence.every((check) => check.passed));
  const handoffs = controller.store
    .eventsAfter('0')
    .filter((event) => event.type === 'handoff.sealed');
  assert.equal(handoffs.length, transfer === 'manual' ? 4 : 1);
  assert.ok(handoffs[0].payload.packet.artifacts.length > 3);
  assert.deepEqual(
    controller.store
      .intents()
      .filter((intent) => intent.scratch_path === join(controller.home, 'scratch', run.id))
      .map((intent) => intent.generation),
    transfer === 'manual' ? [0, 1, 2] : [0, 1],
  );
  const candidate = snapshot.candidates[0];
  const writer = controller.store
    .intents()
    .filter(
      (intent) =>
        intent.run_id === run.id &&
        intent.scratch_path === join(controller.home, 'scratch', run.id),
    )
    .at(-1);
  assert.ok(writer);
  for (const check of snapshot.evidence.filter((check) => check.review)) {
    assert.equal(check.review?.job.writerAttemptId, writer.attempt_id);
    assert.equal(check.review?.job.writerRouteId, writer.route_id);
  }
  if (transfer === 'reserve') {
    const check = snapshot.evidence.find((check) => check.review) as CheckResult;
    assert.ok(check.review);
    const blocked = async () => {
      const result = await controller.execute(
        command(
          'AcceptCandidate',
          {
            taskId: task.id,
            candidateId: candidate.id,
            destinationRef: 'refs/heads/feat/invalid-review',
          },
          snapshot.tasks[0].revision,
        ),
        'local-owner',
      );
      assert.equal(result.reason, 'selected-review-not-complete');
      assert.equal(controller.snapshot().tasks[0].state, 'ready');
    };
    const receiptKey = `candidate:${writer.attempt_id}`;
    const receipt = controller.store.receipt(receiptKey);
    assert.ok(receipt);
    controller.store.db
      .prepare('UPDATE receipts SET request_hash=? WHERE command_key=?')
      .run('a'.repeat(64), receiptKey);
    try {
      await blocked();
    } finally {
      controller.store.db
        .prepare('UPDATE receipts SET request_hash=? WHERE command_key=?')
        .run(receipt.hash, receiptKey);
    }
    const original = controller.store.get<Attempt>('attempt', writer.attempt_id);
    assert.ok(original);
    controller.store.transaction(() =>
      controller.store.put('attempt', writer.attempt_id, 0, {
        ...original,
        routeId: fixtures.snapshot.routes[2].id,
      }),
    );
    try {
      await blocked();
    } finally {
      controller.store.transaction(() =>
        controller.store.put('attempt', writer.attempt_id, 0, original),
      );
    }
    const {
      writerAttemptId: _writerAttemptId,
      writerRouteId: _writerRouteId,
      ...legacyJob
    } = check.review.job;
    const legacyReview = { ...check.review, job: legacyJob };
    const stripped = { ...check, review: legacyReview };
    const updateBody = controller.store.db.prepare(
      'UPDATE evidence SET body=? WHERE candidate_id=? AND definition_hash=?',
    );
    updateBody.run(canonicalJson(stripped), candidate.id, check.definitionHash);
    try {
      await blocked();
    } finally {
      updateBody.run(canonicalJson(check), candidate.id, check.definitionHash);
    }
    const artifact = {
      id: id('art'),
      ...new ArtifactFiles(join(controller.home, 'artifacts')).publish(
        Buffer.from(canonicalJson(legacyReview)),
      ),
      mediaType: 'application/json',
    };
    const legacyCheck = {
      ...stripped,
      artifactId: artifact.id,
      definitionHash: hashCanonical({
        methodId: legacyJob.methodId,
        cycle: legacyJob.cycle,
        routeId: legacyJob.routeId,
        policyHash: run.policy.hash,
      }),
    };
    controller.store.transaction(() => {
      controller.store.put('artifact', artifact.id, 0, artifact);
      controller.store.db
        .prepare('UPDATE review_jobs SET body=? WHERE attempt_id=?')
        .run(canonicalJson(legacyJob), legacyJob.attemptId);
      controller.store.db
        .prepare(
          'UPDATE evidence SET definition_hash=?,body=? WHERE candidate_id=? AND definition_hash=?',
        )
        .run(
          legacyCheck.definitionHash,
          canonicalJson(legacyCheck),
          candidate.id,
          check.definitionHash,
        );
    });
  }
  git(source.directory, ['update-ref', 'refs/heads/feat/existing', base, '0'.repeat(40)]);
  assert.equal(
    (
      await controller.execute(
        command(
          'AcceptCandidate',
          {
            taskId: task.id,
            candidateId: candidate.id,
            destinationRef: 'refs/heads/feat/existing',
          },
          snapshot.tasks[0].revision,
        ),
        'local-owner',
      )
    ).reason,
    'destination-ref-exists',
  );
  const asked = await controller.execute(
    command(
      'AcceptCandidate',
      { taskId: task.id, candidateId: candidate.id, destinationRef: 'refs/heads/feat/net-minor' },
      snapshot.tasks[0].revision,
    ),
    'local-owner',
  );
  const acceptApproval = controller
    .snapshot()
    .approvals.find(
      (value) => value.action === 'accept-candidate' && value.status === 'pending',
    ) as Approval;
  const accept = command(
    'ResolveApproval',
    { binding: binding(acceptApproval), decision: 'approved' },
    asked.revision,
  );
  const accepted = await controller.execute(accept, 'local-owner');
  assert.equal(accepted.outcome, 'applied');
  assert.equal(TaskSchema.parse(accepted.entity).state, 'accepted');
  const commit = git(source.directory, ['rev-parse', 'refs/heads/feat/net-minor'])
    .toString()
    .trim();
  assert.equal(
    git(source.directory, ['rev-parse', `${commit}^`])
      .toString()
      .trim(),
    base,
  );
  assert.equal((await controller.execute(accept, 'local-owner')).outcome, 'already-applied');
  assert.equal(
    git(source.directory, ['rev-parse', 'refs/heads/feat/net-minor']).toString().trim(),
    commit,
  );
  assert.equal(
    git(source.directory, ['rev-parse', 'refs/heads/feat/existing']).toString().trim(),
    base,
  );
  const exported = await controller.execute(
    command(
      'ExportPatch',
      { taskId: task.id, candidateId: candidate.id },
      controller.snapshot().tasks[0].revision,
    ),
    'local-owner',
  );
  const artifact = ArtifactSchema.parse(exported.entity);
  const chunk = await controller.execute(
    command('GetArtifact', { artifactId: artifact.id, offset: 0, limit: 65536 }),
    'local-owner',
  );
  assert.equal(chunk.data?.kind, 'artifact');
  if (chunk.data?.kind === 'artifact')
    assert.match(Buffer.from(chunk.data.content, 'base64').toString(), /netMinor/);
  for (const resolution of ['denied', 'stop', 'approved'] as const) {
    const askedExport = await controller.execute(
      command(
        'ExportPatch',
        { taskId: task.id, candidateId: candidate.id },
        controller.snapshot().tasks[0].revision,
      ),
      'local-owner',
    );
    const exportApproval = controller
      .snapshot()
      .approvals.find(
        (value) => value.action === 'export-patch' && value.status === 'pending',
      ) as Approval;
    assert.ok(exportApproval);
    assert.equal(controller.snapshot().tasks[0].waitingReason, 'approval');
    if (resolution === 'stop')
      await controller.execute(
        command('StopRun', { taskId: task.id, runId: run.id }, askedExport.revision),
        'local-owner',
      );
    else {
      const result = await controller.execute(
        command(
          'ResolveApproval',
          { binding: binding(exportApproval), decision: resolution },
          askedExport.revision,
        ),
        'local-owner',
      );
      assert.equal(result.outcome, 'applied');
      if (resolution === 'approved') ArtifactSchema.parse(result.entity);
    }
    assert.equal(controller.snapshot().tasks[0].state, 'accepted');
    assert.equal(controller.snapshot().tasks[0].waitingReason, null);
    assert.equal(
      controller.snapshot().approvals.filter((value) => value.status === 'pending').length,
      0,
    );
  }
  assert.deepEqual(readFileSync(join(source.directory, '.git', 'index')), index);
  for (const sentinel of sentinels) {
    assert.deepEqual(readFileSync(join(source.directory, sentinel.path)), sentinel.bytes);
    assert.equal(lstatSync(join(source.directory, sentinel.path)).mode & 0o777, sentinel.mode);
  }
  assert.equal(existsSync(canary), false);
  controller.close();
}

async function nativeSetup(
  t: TestContext,
  mode = 'success',
  options: Partial<ControllerOptions> = {},
  targetPath = 'net.mjs',
) {
  let submissions = 0;
  const ready = Promise.withResolvers<void>();
  const children: ReturnType<typeof spawn>[] = [];
  let onSpawn: ((phase: string) => void) | undefined;
  let onInput: ((message: { method?: string }, phase: string) => void) | undefined;
  const fixtureProfile: NativeProfileResolution = {
    ...unavailableNativeProfile(),
    facts: {
      ...unavailableNativeProfile().facts,
      available: true,
      reason: 'available',
      model: fixtureModel,
      clientVersion: process.version,
    },
    client: {
      executable: process.execPath,
      sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
      version: process.version,
    },
    environment: { ...process.env },
    locationHash: '1'.repeat(64),
  };
  const nativeOptions: Partial<ControllerOptions> = {
    nativeProfile: () => fixtureProfile,
    ...options,
    nativeSpawn: (executable, args, spawnOptions) => {
      const pending = context.controller.store
        .intents()
        .flatMap((intent) => context.controller.store.nativeProcesses(intent.attempt_id))
        .filter((row) => row.state === 'intent')
        .at(-1);
      const phase =
        args.at(-1) === 'list'
          ? 'features'
          : pending?.phase === 'metadata-preparation'
            ? 'prepare'
            : 'task';
      let transcript = fixture;
      if (mode === 'checked') {
        const proposal = join(context.directory, 'checked-proposal');
        mkdirSync(proposal, { recursive: true });
        writeFileSync(join(proposal, 'net.mjs'), '');
        writeChallengeSolution(proposal);
        transcript = fixture.replace(
          `const content = ${fixtureContent.toString()};`,
          `const content = () => ${JSON.stringify(readFileSync(join(proposal, 'net.mjs'), 'utf8'))};`,
        );
      }
      const child = spawn(
        executable,
        ['-e', transcript, mode === 'checked' ? 'success' : mode, phase],
        spawnOptions,
      );
      children.push(child);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((data: Uint8Array) => {
        const messages = Buffer.from(data)
          .toString()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { method?: string });
        const attempt = context.controller.store.intents()[0];
        assert(attempt, 'the controller commits admission before native input');
        assert.equal(
          context.controller.store.nativeProcesses(attempt.attempt_id).at(-1)?.state,
          'owned',
        );
        for (const message of messages) {
          if (message.method === 'turn/start') {
            submissions++;
            assert(context.controller.store.receipt(`native-submission:${attempt.attempt_id}`));
          }
          onInput?.(message, phase);
        }
        const result = write(data);
        if (messages.some((message) => message.method === 'turn/start')) ready.resolve();
        return result;
      }) as typeof child.stdin.write;
      onSpawn?.(phase);
      return child;
    },
  };
  const context = await setup(t, nativeOptions);
  if (targetPath !== 'net.mjs') {
    const files = [
      { path: targetPath, content: Buffer.from('# Provider notes\nOriginal café notes.\n') },
      { path: 'docs/nul.txt', content: Buffer.from('text\0tail') },
      { path: 'docs/invalid.txt', content: Buffer.from([0xc3, 0x28]) },
      { path: 'docs/large.txt', content: Buffer.alloc(65_537, 97) },
    ];
    for (const file of files) {
      mkdirSync(dirname(join(context.source.directory, file.path)), { recursive: true });
      writeFileSync(join(context.source.directory, file.path), file.content);
    }
    const paths = files.map((file) => file.path);
    git(context.source.directory, ['add', '--', ...paths]);
    git(
      context.source.directory,
      ['commit', '-s', '--only', '-m', 'test: seed bounded text targets', '--', ...paths],
      undefined,
      {
        name: 'CrewKite fixture',
        email: 'fixture@example.invalid',
        at: '2026-10-15T17:00:00Z',
      },
    );
  }
  const task = TaskSchema.parse(
    (await context.controller.execute(context.draft, 'local-owner')).entity,
  );
  const source = inspectSource(task.projectId, context.source.directory);
  const policy: NativePilotAppointment['policy'] = {
    ...context.fixtures.policy,
    quality: 'quick',
    methods: [{ id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' }],
    reserves: [],
    limits: { attempts: 4, minutes: 5, concurrency: 1 },
    unknownUsage: { rule: 'fixed-allowance', allowance: { launches: 1, minutes: 5 } },
    effects: context.fixtures.policy.effects.map((grant) => ({
      ...grant,
      taskId: task.id,
      ...(grant.action === 'export-patch' ? { target: task.id } : {}),
    })),
  };
  const appointment: NativePilotAppointment = {
    id: 'controller-native-fixture',
    taskId: task.id,
    route: {
      ...context.fixtures.snapshot.routes[0],
      id: context.id('rte'),
      family: 'openai',
      model: fixtureModel,
      effort: { requested: 'low', effective: 'low', supported: ['low'] },
      billing: 'included',
      qualified: false,
      fake: false,
    },
    client: {
      executable: process.execPath,
      sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
      version: process.version,
    },
    creditPolicy: 'ordinary',
    target: {
      path: targetPath,
      baseHash: committedFiles(context.source.directory, source.base).find(
        (file) => file.path === targetPath,
      )?.hash as string,
    },
    consent: {
      nativeTrust: 'accepted',
      source: 'explicit',
      policyHash: hashCanonical(policy),
      sourceBase: source.base,
      criteriaHash: hashCanonical(task.criteria),
    },
    policy,
    expiresAt: new Date(Date.parse(context.clock.now()) + 300_000).toISOString(),
    maximumTaskMs: 300_000,
    maximumSubmissions: 1,
  };
  return {
    ...context,
    task,
    appointment,
    fixtureProfile,
    restart: async () => {
      await context.controller.close();
      context.controller = new Controller({
        ...nativeOptions,
        home: context.controller.home,
        now: context.clock.now,
        id: context.id,
      });
      t.after(() => context.controller.close());
      return context.controller;
    },
    children,
    ready: ready.promise,
    submissions: () => submissions,
    onSpawn: (listener: typeof onSpawn) => {
      onSpawn = listener;
    },
    onInput: (listener: typeof onInput) => {
      onInput = listener;
    },
  };
}

function nativeCandidate(controller: Controller) {
  const candidate = Promise.withResolvers<void>();
  const off = controller.subscribe((event) => {
    if (event.type === 'task.updated' && event.payload.state === 'unknown') {
      off();
      candidate.reject(new Error('Native ownership became unknown.'));
    }
    if (event.type === 'candidate.sealed') {
      off();
      candidate.resolve();
    }
  });
  return candidate.promise;
}

test('an appointed native proposal is retained and applied once after every phase stops', async (t) => {
  for (const { consent, path, publicRun } of [
    { consent: 'explicit', path: 'net.mjs', publicRun: false },
    { consent: 'policy', path: 'net.mjs', publicRun: false },
    { consent: 'explicit', path: 'docs/providers.md', publicRun: false },
    { consent: 'policy', path: 'docs/案内.md', publicRun: false },
    { consent: 'explicit', path: 'docs/providers.md', publicRun: true },
    { consent: 'policy', path: 'docs/案内.md', publicRun: true },
  ] as const) {
    const context = await nativeSetup(t, 'success', {}, path);
    const {
      controller: initialController,
      appointment,
      task,
      command,
      source,
      clock,
      id,
    } = context;
    let controller = initialController;
    appointment.id += `-${consent}`;
    appointment.consent.source = consent;
    for (const change of [
      { maximumSubmissions: 2 },
      { target: { ...appointment.target, baseHash: '0'.repeat(64) } },
      ...[
        'missing.md',
        '../outside.md',
        'docs/\nfile.md',
        'docs/\ud800.md',
        ...(path !== 'net.mjs' ? ['docs/nul.txt', 'docs/invalid.txt', 'docs/large.txt'] : []),
      ].map((path) => ({
        target: {
          path,
          baseHash:
            committedFiles(source.directory, appointment.consent.sourceBase).find(
              (file) => file.path === path,
            )?.hash ?? appointment.target.baseHash,
        },
      })),
      { consent: { ...appointment.consent, nativeTrust: 'denied' } },
      { consent: { ...appointment.consent, policyHash: '0'.repeat(64) } },
      { expiresAt: clock.now() },
      { route: { ...appointment.route, fake: true } },
      { route: { ...appointment.route, qualified: true } },
      {
        policy: {
          ...appointment.policy,
          reserves: [
            { routeId: appointment.route.id, windowId: 'weekly', value: 5, unit: 'percent' },
          ],
        },
      },
      {
        policy: {
          ...appointment.policy,
          unknownUsage: { rule: 'fixed-allowance', allowance: { launches: 0, minutes: 5 } },
        },
      },
    ]) {
      assert.equal(
        controller.startNativePilot({
          ...appointment,
          ...change,
          ...('policy' in change
            ? { consent: { ...appointment.consent, policyHash: hashCanonical(change.policy) } }
            : {}),
        } as NativePilotAppointment).outcome,
        'blocked',
      );
      assert.equal(controller.store.intents().length, 0);
    }
    assert.equal(
      (await controller.execute(command('StartNativePilot', appointment), 'local-owner')).outcome,
      'unsupported',
    );
    assert(!controller.snapshot().routes.some((route) => route.id === appointment.route.id));
    const frozen = structuredClone(appointment);
    let startCommand: ReturnType<typeof command> | undefined;
    let nativeRouteId = frozen.route.id;
    if (publicRun) {
      const payload = {
        taskId: task.id,
        profileId: context.fixtureProfile.facts.id,
        targetPath: path,
        policy: frozen.policy,
        consent: 'explicit',
      };
      const before = controller.snapshot();
      for (const change of [
        { consent: 'saved' },
        { targetPath: 'missing.md' },
        { policy: { ...frozen.policy, effects: [] } },
        { policy: { ...frozen.policy, limits: { ...frozen.policy.limits, attempts: 1 } } },
      ]) {
        assert.equal(
          (
            await controller.execute(
              command('PrepareNativeRun', { ...payload, ...change }, task.revision),
              'local-owner',
            )
          ).outcome,
          'blocked',
        );
        assert.deepEqual(controller.snapshot(), before);
      }
      const prepare = command('PrepareNativeRun', payload, task.revision);
      let prepared = await controller.execute(prepare, 'local-owner');
      assert.equal(prepared.outcome, 'applied', JSON.stringify(prepared));
      assert.equal((await controller.execute(prepare, 'local-owner')).outcome, 'already-applied');
      assert.equal(context.children.length, 0);
      assert.equal(controller.store.intents().length, 0);
      if (consent === 'explicit') {
        const ordinaryRoute = RunSchema.parse(prepared.entity).roles[0].routeId;
        const count = controller.snapshot().routes.length;
        const beforeCredit = controller.snapshot();
        assert.equal(
          (
            await controller.execute(
              command(
                'PrepareNativeRun',
                { ...payload, creditPolicy: 'existing-credits', consent: 'saved' },
                controller.snapshot().tasks[0].revision,
              ),
              'local-owner',
            )
          ).outcome,
          'blocked',
        );
        assert.deepEqual(controller.snapshot(), beforeCredit);
        const credit = await controller.execute(
          command(
            'PrepareNativeRun',
            { ...payload, creditPolicy: 'existing-credits' },
            controller.snapshot().tasks[0].revision,
          ),
          'local-owner',
        );
        assert.equal(credit.outcome, 'applied');
        assert.notEqual(RunSchema.parse(credit.entity).roles[0].routeId, ordinaryRoute);
        assert.equal(controller.snapshot().routes.length, count + 1);
        prepared = await controller.execute(
          command(
            'PrepareNativeRun',
            { ...payload, consent: 'saved' },
            controller.snapshot().tasks[0].revision,
          ),
          'local-owner',
        );
        assert.equal(prepared.outcome, 'applied');
        assert.equal(RunSchema.parse(prepared.entity).roles[0].routeId, ordinaryRoute);
        assert.equal(controller.snapshot().routes.length, count + 1);
      }
      if (consent === 'policy') {
        const routeId = RunSchema.parse(prepared.entity).roles[0].routeId;
        const routeCount = controller.snapshot().routes.length;
        prepared = await controller.execute(
          command(
            'PrepareNativeRun',
            { ...payload, consent: 'saved' },
            controller.snapshot().tasks[0].revision,
          ),
          'local-owner',
        );
        assert.equal(prepared.outcome, 'applied');
        assert.equal(RunSchema.parse(prepared.entity).roles[0].routeId, routeId);
        assert.equal(controller.snapshot().routes.length, routeCount);
        controller = await context.restart();
      }
      const preview = RunSchema.parse(prepared.entity);
      nativeRouteId = preview.roles[0].routeId;
      assert.equal(
        controller.snapshot().nativeRuns.find((value) => value.runId === preview.id)?.stage,
        'prepared',
      );
      const plan = controller.store.receipt(`native-run:${preview.id}`)?.result.entity as Artifact;
      const retained = JSON.parse(
        new ArtifactFiles(join(controller.home, 'artifacts')).read(plan.hash).toString(),
      );
      assert.equal(retained.appointment.creditPolicy, 'ordinary');
      assert.equal(
        retained.appointment.expiresAt,
        frozen.policy.effects.find((grant) => grant.action === 'write-scratch')?.expiresAt,
      );
      startCommand = command(
        'StartRun',
        { taskId: task.id, runId: preview.id },
        controller.snapshot().tasks[0].revision,
      );
    }
    const sealed = nativeCandidate(controller);
    let activeReplay: Promise<unknown> | undefined;
    context.onInput((message) => {
      if (message.method === 'turn/start') {
        const intents = controller.store.intents().length;
        const submissions = context.submissions();
        const processes = context.children.length;
        if (startCommand)
          activeReplay = controller
            .execute(startCommand, 'local-owner')
            .then((result) => assert.equal(result.outcome, 'already-applied'));
        else assert.equal(controller.startNativePilot(frozen).outcome, 'already-applied');
        assert.equal(controller.store.intents().length, intents);
        assert.equal(context.submissions(), submissions);
        assert.equal(context.children.length, processes);
      }
    });
    assert.equal(
      startCommand
        ? (await controller.execute(startCommand, 'local-owner')).outcome
        : controller.startNativePilot(appointment).outcome,
      'applied',
    );
    appointment.consent.nativeTrust = 'denied' as 'accepted';
    appointment.policy.effects.length = 0;
    appointment.route.qualified = true;
    appointment.target.path = 'docs/other.md';
    appointment.target.baseHash = '0'.repeat(64);
    await sealed;
    await activeReplay;
    const run = controller.snapshot().runs.at(-1);
    assert(run);
    const attempt = controller.store.intents()[0];
    assert.equal(context.submissions(), 1);
    assert.equal(context.children.length, 3);
    const completion = controller.store.receipt(`native-completion:${attempt.attempt_id}`)?.result
      .entity as Artifact;
    const facts = JSON.parse(
      new ArtifactFiles(join(controller.home, 'artifacts')).read(completion.hash).toString(),
    );
    assert.equal(facts.reason, null);
    assert.equal(facts.quiescent, true);
    assert(
      controller.store
        .nativeProcesses(attempt.attempt_id)
        .every((phase) => phase.state === 'quiescent' && groupAbsent(phase.process_group)),
    );
    assert.equal(
      controller.store.receipt(`native-application:${attempt.attempt_id}`)?.result.outcome,
      'applied',
    );
    assert.equal(controller.snapshot().tasks[0].state, 'stopped');
    assert.equal(
      controller.snapshot().routes.find((route) => route.id === nativeRouteId)?.qualified,
      false,
    );
    assert.equal(
      controller.snapshot().routes.find((route) => route.id === nativeRouteId)?.fake,
      false,
    );
    assert.equal(
      startCommand
        ? (await controller.execute(startCommand, 'local-owner')).outcome
        : controller.startNativePilot(frozen).outcome,
      'already-applied',
    );
    if (!publicRun)
      assert.equal(
        controller.startNativePilot({ ...frozen, creditPolicy: 'existing-credits' }).outcome,
        'denied',
      );
    assert.equal(
      controller.snapshot().nativeRuns.find((value) => value.runId === run.id)?.stage,
      'retain-only',
    );
    const candidate = controller.store.list<Candidate>('candidate').at(-1);
    assert(candidate);
    const expected = committedFiles(source.directory, run.source.base).map(
      ({ content: _content, ...file }) => file,
    );
    const actual = readFiles(join(controller.home, 'scratch', run.id)).map(
      ({ content: _content, ...file }) => file,
    );
    assert.deepEqual(
      actual.filter((file) => file.path !== frozen.target.path),
      expected.filter((file) => file.path !== frozen.target.path),
    );
    assert.equal(
      controller.store.db.prepare('SELECT COUNT(*) AS count FROM evidence').get()?.count,
      0,
    );
    assert.equal(
      readFileSync(join(controller.home, 'scratch', run.id, frozen.target.path), 'utf8'),
      fixtureContent(frozen.target.path),
    );
    assert.equal(
      git(source.directory, ['show', `${run.source.base}:${frozen.target.path}`]).toString(),
      readFileSync(join(source.directory, frozen.target.path), 'utf8'),
    );
    for (const kind of ['command', 'accept', 'check', 'review']) {
      const approval: Approval = {
        approvalId: id('apr'),
        taskId: task.id,
        attemptId: attempt.attempt_id,
        generation: 0,
        action: 'run-check',
        target: 'node --test',
        revision: 0,
        requester: 'Controller',
        consequence: 'A synthetic pending continuation.',
        status: 'pending',
      };
      const {
        status: _status,
        requester: _requester,
        consequence: _consequence,
        ...binding
      } = approval;
      const request = { kind };
      controller.store.transaction(() => {
        controller.store.put('approval', approval.approvalId, 0, approval);
        controller.store.db
          .prepare(
            "INSERT INTO pending_effects(approval_id,task_id,attempt_id,task_revision,effect_hash,request,state) VALUES (?,?,?,?,?,?,'pending')",
          )
          .run(
            approval.approvalId,
            task.id,
            attempt.attempt_id,
            controller.snapshot().tasks[0].revision,
            hashCanonical(request),
            canonicalJson(request),
          );
      });
      assert.equal(
        (
          await controller.execute(
            command(
              'ResolveApproval',
              { binding, decision: 'approved' },
              controller.snapshot().tasks[0].revision,
            ),
            'local-owner',
          )
        ).reason,
        'native-pilot-retain-only',
      );
      assert.equal(
        controller.store.get<Approval>('approval', approval.approvalId)?.status,
        'pending',
      );
      assert.equal(
        (
          await controller.execute(
            command(
              'ResolveApproval',
              { binding, decision: 'denied' },
              controller.snapshot().tasks[0].revision,
            ),
            'local-owner',
          )
        ).outcome,
        'applied',
      );
    }
    assert.equal(controller.store.intents().length, 1);
    assert.equal(
      controller.store.db.prepare('SELECT COUNT(*) AS count FROM evidence').get()?.count,
      0,
    );
    const changes = await controller.execute(
      command('GetChanges', { taskId: task.id }),
      'local-owner',
    );
    assert.equal(changes.data?.kind, 'changes');
    const proposal = controller.store.receipt(`native-proposal:${attempt.attempt_id}`)?.result
      .entity as Artifact;
    const retained = await controller.execute(
      command('GetArtifact', { artifactId: proposal.id, offset: 0, limit: 65536 }),
      'local-owner',
    );
    assert.equal(retained.data?.kind, 'artifact');
    const exported = await controller.execute(
      command(
        'ExportPatch',
        { taskId: task.id, candidateId: candidate.id },
        controller.snapshot().tasks[0].revision,
      ),
      'local-owner',
    );
    assert.equal(exported.outcome, 'applied');
    const patch = ArtifactSchema.parse(exported.entity);
    for (const name of ['StartRun', 'ResumeRun', 'SwitchRoute', 'AcceptCandidate'] as const) {
      const payload: Record<string, unknown> =
        name === 'AcceptCandidate'
          ? {
              taskId: task.id,
              candidateId: candidate.id,
              destinationRef: 'refs/heads/feat/native-fixture',
            }
          : {
              taskId: task.id,
              runId: run.id,
              ...(name === 'SwitchRoute'
                ? { routeId: context.fixtures.snapshot.routes[0].id }
                : {}),
            };
      assert.equal(
        (
          await controller.execute(
            command(name, payload, controller.snapshot().tasks[0].revision),
            'local-owner',
          )
        ).reason,
        'native-pilot-retain-only',
      );
    }
    await controller.close();
    const reopened = new Controller({
      home: controller.home,
      now: clock.now,
      id,
      scenarioForRoute: () => 'approval',
    });
    try {
      assert.equal(
        startCommand
          ? (await reopened.execute(startCommand, 'local-owner')).outcome
          : reopened.startNativePilot(frozen).outcome,
        'already-applied',
      );
      assert.equal(
        (
          await reopened.execute(
            command(
              'ResumeRun',
              { taskId: task.id, runId: run.id },
              reopened.snapshot().tasks[0].revision,
            ),
            'local-owner',
          )
        ).reason,
        'native-pilot-retain-only',
      );
      const chunk = await reopened.execute(
        command('GetArtifact', { artifactId: patch.id, offset: 0, limit: 65536 }),
        'local-owner',
      );
      assert.equal(chunk.data?.kind, 'artifact');
      assert.equal(reopened.store.intents().length, 1);
      const amended = await reopened.execute(
        command(
          'AmendTask',
          { taskId: task.id, title: task.title, outcome: task.outcome, criteria: task.criteria },
          reopened.snapshot().tasks[0].revision,
        ),
        'local-owner',
      );
      assert.equal(amended.outcome, 'applied');
      assert.equal(TaskSchema.parse(amended.entity).runId, null);
      assert(reopened.store.receipt(`native-run:${run.id}`));
      const freshPolicy = {
        ...frozen.policy,
        methods: frozen.policy.methods?.map((method) => ({
          ...method,
          reviewerRole: 'advisor' as const,
        })),
        effects: frozen.policy.effects.map((grant) => ({
          ...grant,
          expiresAt: new Date(Date.parse(grant.expiresAt) + 1).toISOString(),
        })),
      };
      const prepared = await reopened.execute(
        command(
          'PrepareRun',
          { taskId: task.id, policy: freshPolicy, roles: quickRoles(context.fixtures) },
          reopened.snapshot().tasks[0].revision,
        ),
        'local-owner',
      );
      assert.equal(prepared.outcome, 'applied', JSON.stringify(prepared));
      const ordinary = RunSchema.parse(prepared.entity);
      const resealed = nativeCandidate(reopened);
      let stopped: Promise<unknown> | undefined;
      const off = reopened.subscribe((event) => {
        if (event.type === 'attempt.output' && event.payload.attemptId !== attempt.attempt_id) {
          off();
          writeFileSync(
            join(reopened.home, 'scratch', ordinary.id, 'net.mjs'),
            git(source.directory, ['show', `${run.source.base}:net.mjs`]),
          );
          writeFileSync(
            join(reopened.home, 'scratch', ordinary.id, frozen.target.path),
            fixtureContent(frozen.target.path),
          );
          stopped = reopened.execute(
            command(
              'StopRun',
              { taskId: task.id, runId: ordinary.id },
              reopened.snapshot().tasks[0].revision,
            ),
            'local-owner',
          );
        }
      });
      assert.equal(
        (
          await reopened.execute(
            command('StartRun', { taskId: task.id, runId: ordinary.id }, prepared.revision),
            'local-owner',
          )
        ).outcome,
        'applied',
      );
      await resealed;
      await stopped;
      const ordinaryCandidate = reopened.snapshot().candidates.at(-1);
      assert(ordinaryCandidate);
      assert.equal(ordinaryCandidate.hash, candidate.hash);
      assert.notEqual(ordinaryCandidate.id, candidate.id);
      assert.equal(
        (
          await reopened.execute(
            command(
              'AcceptCandidate',
              {
                taskId: task.id,
                candidateId: candidate.id,
                destinationRef: 'refs/heads/feat/native-fixture',
              },
              reopened.snapshot().tasks[0].revision,
            ),
            'local-owner',
          )
        ).reason,
        'candidate-not-current',
      );
    } finally {
      await reopened.close();
    }
  }
  for (const scenario of ['checked', 'failed', 'stop-intent', 'expired-intent', 'revoked-intent']) {
    const context = await nativeSetup(t, scenario === 'failed' ? 'success' : 'checked');
    let controller = context.controller;
    const { command, task, appointment, clock } = context;
    const retained = nativeCandidate(controller);
    if (scenario === 'checked') {
      const prepared = await controller.execute(
        command(
          'PrepareNativeRun',
          {
            taskId: task.id,
            profileId: context.fixtureProfile.facts.id,
            targetPath: 'net.mjs',
            policy: appointment.policy,
            consent: 'explicit',
          },
          task.revision,
        ),
        'local-owner',
      );
      assert.equal(prepared.outcome, 'applied');
      const nativeRun = RunSchema.parse(prepared.entity);
      assert.equal(
        (
          await controller.execute(
            command('StartRun', { taskId: task.id, runId: nativeRun.id }, prepared.revision),
            'local-owner',
          )
        ).outcome,
        'applied',
      );
    } else assert.equal(controller.startNativePilot(appointment).outcome, 'applied');
    await retained;
    const run = controller.snapshot().runs.at(-1);
    const candidate = controller.snapshot().candidates.at(-1);
    assert(run && candidate);
    const originalRun = structuredClone(run);
    const payload = {
      taskId: task.id,
      candidateId: candidate.id,
      checkRecipeId: 'node-tests-v1',
      reviewer: {
        profileId: context.fixtureProfile.facts.id,
        methodId: 'keep-it-simple',
        cycles: 1,
      },
      consent: 'explicit',
      grants: [
        {
          taskId: task.id,
          action: 'run-check',
          target: 'node --test',
          expiresAt: new Date(Date.parse(clock.now()) + 86400000).toISOString(),
          revoked: false,
          usesRemaining: 1,
        },
        {
          taskId: task.id,
          action: 'run-review',
          target: 'keep-it-simple/cycle-1',
          expiresAt: new Date(Date.parse(clock.now()) + 86400000).toISOString(),
          revoked: false,
          usesRemaining: 1,
        },
      ],
    };
    const revision = () => controller.snapshot().tasks[0].revision;
    if (scenario === 'checked') {
      for (const change of [
        { consent: 'saved' },
        { reviewer: { ...payload.reviewer, methodId: 'second-opinion' } },
        {
          grants: payload.grants.map((grant, index) =>
            index ? grant : { ...grant, revoked: true },
          ),
        },
        {
          grants: payload.grants.map((grant, index) =>
            index ? grant : { ...grant, action: 'accept-candidate' },
          ),
        },
      ]) {
        const before = controller.snapshot();
        assert.equal(
          (
            await controller.execute(
              command('PrepareCandidateEvaluation', { ...payload, ...change }, revision()),
              'local-owner',
            )
          ).outcome,
          'blocked',
        );
        assert.deepEqual(controller.snapshot(), before);
      }
    }
    const prepare = command('PrepareCandidateEvaluation', payload, revision());
    const prepared = await controller.execute(prepare, 'local-owner');
    assert.equal(prepared.outcome, 'applied');
    let artifact = ArtifactSchema.parse(prepared.entity);
    assert.equal((await controller.execute(prepare, 'local-owner')).outcome, 'already-applied');
    assert.equal(controller.snapshot().attempts.length, 1);
    assert.equal(controller.snapshot().evidence.length, 0);
    assert.deepEqual(controller.snapshot().runs.at(-1), originalRun);
    const startPayload = () => ({
      taskId: task.id,
      candidateId: candidate.id,
      preparationId: artifact.id,
    });
    if (scenario === 'checked') {
      assert.equal(
        (
          await controller.execute(
            command('PrepareCandidateEvaluation', { ...payload, consent: 'saved' }, revision()),
            'local-owner',
          )
        ).outcome,
        'applied',
      );
      const latest = controller.store.receipt(`evaluation-ready:${run.id}`)?.result.entity;
      artifact = ArtifactSchema.parse(latest);
      context.fixtureProfile.facts.creditPolicies = ['existing-credits'];
      assert.equal(
        (
          await controller.execute(
            command('StartCandidateEvaluation', startPayload(), revision()),
            'local-owner',
          )
        ).outcome,
        'blocked',
      );
      assert.equal(controller.snapshot().attempts.length, 1);
      context.fixtureProfile.facts.creditPolicies = ['ordinary', 'existing-credits'];
      await controller.execute(
        command('StopRun', { taskId: task.id, runId: run.id }, revision()),
        'local-owner',
      );
      assert.equal(
        (
          await controller.execute(
            command('StartCandidateEvaluation', startPayload(), revision()),
            'local-owner',
          )
        ).outcome,
        'blocked',
      );
      const renewed = await controller.execute(
        command('PrepareCandidateEvaluation', payload, revision()),
        'local-owner',
      );
      artifact = ArtifactSchema.parse(renewed.entity);
      controller = await context.restart();
    }
    let checkLaunches = 0;
    let replay: Promise<unknown> | undefined;
    const finished = Promise.withResolvers<void>();
    const off = controller.subscribe((event) => {
      if (event.type === 'attempt.launched') {
        checkLaunches++;
        replay = controller
          .execute(command('StartCandidateEvaluation', startPayload(), revision()), 'local-owner')
          .then((result) => assert.equal(result.outcome, 'already-applied'));
      }
      if (event.type === 'task.updated' && event.payload.state === 'checking') {
        if (scenario === 'expired-intent') clock.advance(86400001);
        if (scenario === 'revoked-intent') {
          const artifactFiles = new ArtifactFiles(join(controller.home, 'artifacts'));
          const plan = JSON.parse(artifactFiles.read(artifact.hash).toString('utf8'));
          controller.store.transaction(() =>
            controller.store.db
              .prepare('DELETE FROM receipts WHERE command_key=?')
              .run(`evaluation-consent:${plan.scopeHash}`),
          );
        }
      }
      if (
        scenario === 'stop-intent' &&
        event.type === 'task.updated' &&
        event.payload.state === 'checking'
      )
        void controller
          .execute(
            command('StopRun', { taskId: task.id, runId: run.id }, event.payload.revision),
            'local-owner',
          )
          .then((result) => assert.equal(result.outcome, 'applied'));
      if (event.type === 'task.updated' && ['stopped', 'failed'].includes(event.payload.state))
        finished.resolve();
    });
    const started = await controller.execute(
      command('StartCandidateEvaluation', startPayload(), revision()),
      'local-owner',
    );
    assert.equal(started.outcome, 'applied');
    await finished.promise;
    await replay;
    off();
    assert.equal(checkLaunches, scenario.endsWith('intent') ? 0 : 1);
    const snapshot = controller.snapshot();
    assert.equal(snapshot.attempts.length, 2);
    assert.equal(context.submissions(), 1);
    assert.equal(context.children.length, 3);
    assert.equal(snapshot.reviewJobs?.length, 0);
    assert.equal(snapshot.evidence.length, scenario.endsWith('intent') ? 0 : 1);
    if (!scenario.endsWith('intent')) {
      assert.equal(snapshot.evidence[0].passed, scenario === 'checked');
      assert.equal(snapshot.evidence[0].evaluator.startsWith('node:'), true);
      const intent = controller.store.intents().at(-1);
      assert(intent);
      const route = snapshot.routes.find((route) => route.id === intent.route_id);
      assert.equal(route?.fake, false);
      assert.equal(route?.qualified, false);
      assert.equal(route?.family, 'local');
    }
    assert.deepEqual(snapshot.runs.at(-1), originalRun);
    assert.notEqual(snapshot.tasks[0].state, 'ready');
    assert.equal(
      (
        await controller.execute(
          command(
            'AcceptCandidate',
            {
              taskId: task.id,
              candidateId: candidate.id,
              destinationRef: 'refs/heads/feat/native-evaluated',
            },
            revision(),
          ),
          'local-owner',
        )
      ).reason,
      'native-pilot-retain-only',
    );
    controller = await context.restart();
    const intents = controller.store.intents().length;
    assert.equal(
      (
        await controller.execute(
          command('StartCandidateEvaluation', startPayload(), revision()),
          'local-owner',
        )
      ).outcome,
      'already-applied',
    );
    assert.equal(controller.store.intents().length, intents);
    assert.equal(context.submissions(), 1);
  }
  for (const boundary of [
    'stop-prepared',
    'client-changed',
    'model-changed',
    'credit-withdrawn',
    'consent-revoked',
    'expired',
    'context-changed',
    'unrelated-expired-grant',
    'oversized-plan',
    'credit-unavailable',
  ]) {
    const context = await nativeSetup(t);
    const { controller, appointment, task, command, clock } = context;
    if (boundary === 'credit-unavailable')
      context.fixtureProfile.facts.creditPolicies = ['ordinary'];
    const policy = structuredClone(appointment.policy);
    if (boundary === 'oversized-plan')
      while (policy.effects.length < 100)
        policy.effects.push({
          ...policy.effects[0],
          action: 'run-check',
          target: `${'界'.repeat(2000)}${policy.effects.length}`,
        });
    if (boundary === 'unrelated-expired-grant')
      for (const grant of policy.effects)
        if (grant.action !== 'write-scratch') grant.expiresAt = clock.now();
    const payload = {
      taskId: task.id,
      profileId: context.fixtureProfile.facts.id,
      targetPath: 'net.mjs',
      policy,
      consent: 'explicit',
      creditPolicy:
        boundary === 'credit-unavailable' || boundary === 'credit-withdrawn'
          ? 'existing-credits'
          : 'ordinary',
    };
    const before = controller.snapshot();
    assert(
      Buffer.byteLength(canonicalJson(command('PrepareNativeRun', payload, task.revision))) <
        1024 * 1024,
    );
    const prepared = await controller.execute(
      command('PrepareNativeRun', payload, task.revision),
      'local-owner',
    );
    if (boundary === 'oversized-plan' || boundary === 'credit-unavailable') {
      assert.equal(prepared.outcome, 'blocked');
      assert.deepEqual(controller.snapshot(), before);
      assert.equal(controller.store.intents().length, 0);
      continue;
    }
    assert.equal(prepared.outcome, 'applied', JSON.stringify(prepared));
    assert.equal(context.children.length, 0);
    const run = RunSchema.parse(prepared.entity);
    if (boundary === 'unrelated-expired-grant') continue;
    if (boundary === 'stop-prepared') {
      assert.equal(
        (
          await controller.execute(
            command(
              'StopRun',
              { taskId: task.id, runId: run.id },
              controller.snapshot().tasks[0].revision,
            ),
            'local-owner',
          )
        ).outcome,
        'applied',
      );
      assert.equal(
        controller.snapshot().nativeRuns.find((value) => value.runId === run.id)?.stage,
        'retain-only',
      );
    }
    if (boundary === 'credit-withdrawn') context.fixtureProfile.facts.creditPolicies = ['ordinary'];
    if (boundary === 'model-changed') context.fixtureProfile.facts.model = 'changed-profile-model';
    if (boundary === 'client-changed')
      context.fixtureProfile.client = {
        ...(context.fixtureProfile.client as NonNullable<typeof context.fixtureProfile.client>),
        sha256: '0'.repeat(64),
      };
    if (boundary === 'expired')
      clock.advance(
        Date.parse(
          appointment.policy.effects.find((grant) => grant.action === 'write-scratch')
            ?.expiresAt as string,
        ) -
          Date.parse(clock.now()) +
          1,
      );
    if (boundary === 'context-changed') {
      await controller.execute(
        command(
          'AmendTask',
          {
            taskId: task.id,
            title: `${task.title} changed`,
            outcome: task.outcome,
            criteria: task.criteria,
          },
          controller.snapshot().tasks[0].revision,
        ),
        'local-owner',
      );
      assert.equal(
        (
          await controller.execute(
            command(
              'PrepareNativeRun',
              { ...payload, consent: 'saved' },
              controller.snapshot().tasks[0].revision,
            ),
            'local-owner',
          )
        ).outcome,
        'blocked',
      );
    }
    if (boundary === 'consent-revoked')
      controller.store.db
        .prepare("UPDATE receipts SET result=? WHERE command_key LIKE 'native-consent:%'")
        .run(canonicalJson({ outcome: 'denied', reason: 'consent-revoked' }));
    assert.equal(
      (
        await controller.execute(
          command(
            'StartRun',
            { taskId: task.id, runId: run.id },
            controller.snapshot().tasks[0].revision,
          ),
          'local-owner',
        )
      ).outcome,
      'blocked',
    );
    assert.equal(context.children.length, 0);
    assert.equal(controller.store.intents().length, 0);
  }
  {
    const context = await nativeSetup(t, 'hold');
    const { controller, appointment, task, command } = context;
    const payload = {
      taskId: task.id,
      profileId: context.fixtureProfile.facts.id,
      targetPath: appointment.target.path,
      policy: appointment.policy,
      consent: 'explicit',
    };
    const prepared = await controller.execute(
      command('PrepareNativeRun', payload, task.revision),
      'local-owner',
    );
    assert.equal(prepared.outcome, 'applied');
    const first = RunSchema.parse(prepared.entity);
    assert.equal(
      (
        await controller.execute(
          command(
            'StartRun',
            { taskId: task.id, runId: first.id },
            controller.snapshot().tasks[0].revision,
          ),
          'local-owner',
        )
      ).outcome,
      'applied',
    );
    await context.ready;
    const secondTask = TaskSchema.parse(
      (
        await controller.execute(
          command(
            'CreateTask',
            {
              projectId: task.projectId,
              title: 'A separate bounded native task',
              outcome: task.outcome,
              criteria: task.criteria,
            },
            0,
          ),
          'local-owner',
        )
      ).entity,
    );
    const policy = {
      ...appointment.policy,
      effects: appointment.policy.effects.map((grant) => ({
        ...grant,
        taskId: secondTask.id,
        ...(grant.action === 'export-patch' ? { target: secondTask.id } : {}),
      })),
    };
    const secondPrepared = await controller.execute(
      command(
        'PrepareNativeRun',
        { ...payload, taskId: secondTask.id, policy },
        secondTask.revision,
      ),
      'local-owner',
    );
    assert.equal(secondPrepared.outcome, 'applied');
    const second = RunSchema.parse(secondPrepared.entity);
    assert.equal(second.roles[0].routeId, first.roles[0].routeId);
    const submitted = Promise.withResolvers<void>();
    context.onInput((message) => {
      if (message.method === 'turn/start' && context.submissions() === 2) submitted.resolve();
    });
    assert.equal(
      (
        await controller.execute(
          command(
            'StartRun',
            { taskId: secondTask.id, runId: second.id },
            controller.snapshot().tasks.find((value) => value.id === secondTask.id)?.revision,
          ),
          'local-owner',
        )
      ).outcome,
      'applied',
    );
    await submitted.promise;
    assert.equal(controller.store.intents().length, 2);
    assert.equal(
      controller.store.db.prepare('SELECT COUNT(*) AS count FROM writer_leases').get()?.count,
      2,
    );
    await controller.close();
    assert.equal(context.submissions(), 2);
  }
});

test('stop or restart cannot submit or apply late native work', async (t) => {
  for (const scenario of [
    'before-submit',
    'restart-intent',
    'close-at-admission',
    'owned-features',
    'owned-prepare',
    'owned-task',
    'close-before-handle',
    'deadline',
    'manifest',
    'after-submit',
    'close',
    'changed-source',
    'application-intent',
    'journal-read',
    'public-before-submit',
    'public-after-submit',
    'public-close-at-admission',
    'public-restart-intent',
  ] as const) {
    const publicRun = scenario.startsWith('public-');
    const boundary = scenario.replace(/^public-/, '');
    const context = await nativeSetup(
      t,
      boundary === 'after-submit' || boundary === 'close' ? 'hold' : 'success',
      boundary === 'restart-intent'
        ? {
            afterIntent: () => {
              throw new Error('synthetic crash before the first phase');
            },
          }
        : {},
    );
    const { controller, task, appointment, command, clock, id } = context;
    let action: Promise<unknown> | undefined;
    const unknown = Promise.withResolvers<void>();
    const sealed =
      boundary === 'journal-read'
        ? unknown.promise
        : boundary === 'restart-intent' || boundary === 'close-at-admission'
          ? Promise.resolve()
          : nativeCandidate(controller);
    if (boundary === 'journal-read') {
      controller.subscribe((event) => {
        if (event.type === 'task.updated' && event.payload.state === 'unknown') unknown.resolve();
      });
      context.onSpawn((phase) => {
        if (phase === 'task')
          context.children.at(-1)?.once('close', () =>
            queueMicrotask(() => {
              controller.store.db.exec(
                'ALTER TABLE native_processes RENAME TO native_processes_unreadable',
              );
            }),
          );
      });
    }
    if (boundary === 'close-at-admission')
      controller.subscribe((event) => {
        if (event.type === 'run.admitted') action = Promise.resolve(controller.close());
      });
    if (boundary.startsWith('owned-') || boundary === 'close-before-handle')
      context.onSpawn((phase) => {
        if (boundary === `owned-${phase}` || boundary === 'close-before-handle') {
          if (boundary === 'close-before-handle') action = Promise.resolve(controller.close());
          else
            action = controller.execute(
              command(
                'StopRun',
                { taskId: task.id, runId: controller.snapshot().tasks[0].runId },
                controller.snapshot().tasks[0].revision,
              ),
              'local-owner',
            );
        }
      });
    if (boundary === 'deadline' || boundary === 'manifest')
      context.onInput((message) => {
        if (message.method === 'turn/start') {
          if (boundary === 'deadline') clock.advance(300_001);
          else
            writeFileSync(
              join(
                controller.home,
                'scratch',
                controller.snapshot().tasks[0].runId as string,
                'sibling.txt',
              ),
              'changed sibling\n',
            );
        }
      });
    if (boundary === 'before-submit')
      context.onInput((message, phase) => {
        if (phase === 'prepare' && message.method === 'initialize')
          action = controller.execute(
            command(
              'StopRun',
              { taskId: task.id, runId: controller.snapshot().tasks[0].runId },
              controller.snapshot().tasks[0].revision,
            ),
            'local-owner',
          );
      });
    if (boundary === 'changed-source')
      context.onInput((message) => {
        if (message.method === 'turn/start')
          writeFileSync(join(context.source.directory, 'README.md'), 'source changed\n');
      });
    if (boundary === 'application-intent') {
      const statement = controller.store.db.prepare.bind(controller.store.db);
      controller.store.db.prepare = ((sql: string) => {
        if (sql === 'UPDATE receipts SET result=? WHERE command_key=?')
          throw new Error('synthetic application receipt failure');
        return statement(sql);
      }) as typeof controller.store.db.prepare;
    }
    let startCommand: ReturnType<typeof command> | undefined;
    if (publicRun) {
      const prepared = await controller.execute(
        command(
          'PrepareNativeRun',
          {
            taskId: task.id,
            profileId: context.fixtureProfile.facts.id,
            targetPath: appointment.target.path,
            policy: appointment.policy,
            consent: 'explicit',
          },
          task.revision,
        ),
        'local-owner',
      );
      assert.equal(prepared.outcome, 'applied');
      startCommand = command(
        'StartRun',
        { taskId: task.id, runId: RunSchema.parse(prepared.entity).id },
        controller.snapshot().tasks[0].revision,
      );
    }
    const started = startCommand
      ? await controller.execute(startCommand, 'local-owner')
      : controller.startNativePilot(appointment);
    assert.equal(started.outcome, 'applied');
    const runId = TaskSchema.parse(started.entity).runId;
    assert(runId);
    const original = git(context.source.directory, [
      'show',
      `${appointment.consent.sourceBase}:net.mjs`,
    ]).toString();
    if (boundary === 'after-submit' || boundary === 'close') {
      await context.ready;
      if (boundary === 'close') {
        const first = controller.close();
        assert.equal(controller.close(), first);
        await first;
      } else {
        await controller.execute(
          command('StopRun', { taskId: task.id, runId }, controller.snapshot().tasks[0].revision),
          'local-owner',
        );
        await sealed;
      }
    } else {
      await sealed;
      await action;
    }
    if (
      boundary !== 'application-intent' &&
      boundary !== 'restart-intent' &&
      boundary !== 'close-at-admission'
    )
      assert.equal(
        readFileSync(join(controller.home, 'scratch', runId, 'net.mjs'), 'utf8'),
        original,
      );
    if (boundary === 'journal-read') {
      assert.equal(controller.snapshot().tasks[0].state, 'unknown');
      assert.equal(
        controller.store.db.prepare('SELECT COUNT(*) AS count FROM writer_leases').get()?.count,
        1,
      );
      assert.equal(
        controller.store.db.prepare('SELECT COUNT(*) AS count FROM reservations').get()?.count,
        1,
      );
      assert.equal(
        controller.store.receipt(`native-application:${controller.store.intents()[0].attempt_id}`),
        undefined,
      );
    }
    await controller.close();
    if (boundary === 'journal-read') {
      const journal = new DatabaseSync(join(controller.home, 'state.sqlite'));
      try {
        journal.exec('ALTER TABLE native_processes_unreadable RENAME TO native_processes');
      } finally {
        journal.close();
      }
    }
    const reopened = new Controller({ home: controller.home, now: clock.now, id });
    try {
      assert.equal(reopened.store.intents().length, 1);
      assert.equal(
        startCommand
          ? (await reopened.execute(startCommand, 'local-owner')).outcome
          : reopened.startNativePilot(appointment).outcome,
        'already-applied',
      );
      assert.equal(
        reopened.snapshot().nativeRuns.find((value) => value.runId === runId)?.stage,
        'retain-only',
      );
      assert.equal(
        (
          await reopened.execute(
            command('StartRun', { taskId: task.id, runId }, reopened.snapshot().tasks[0].revision),
            'local-owner',
          )
        ).outcome,
        'blocked',
      );
      assert.equal(
        (
          await reopened.execute(
            command('ResumeRun', { taskId: task.id, runId }, reopened.snapshot().tasks[0].revision),
            'local-owner',
          )
        ).reason,
        'native-pilot-retain-only',
      );
      assert.equal(
        context.submissions(),
        boundary === 'before-submit' ||
          boundary === 'restart-intent' ||
          boundary === 'close-at-admission' ||
          boundary.startsWith('owned-') ||
          boundary === 'close-before-handle'
          ? 0
          : 1,
      );
      if (boundary === 'journal-read')
        assert(reopened.store.eventsAfter('0').some((event) => event.type === 'ownership.unknown'));
      if (boundary === 'restart-intent' || boundary === 'close-at-admission') {
        assert.equal(reopened.snapshot().tasks[0].state, 'unknown');
        assert.equal(
          reopened.store.db.prepare('SELECT COUNT(*) AS count FROM writer_leases').get()?.count,
          1,
        );
        assert.equal(context.children.length, 0);
      }
      const application = reopened.store.receipt(
        `native-application:${reopened.store.intents()[0].attempt_id}`,
      );
      assert.equal(
        application?.result.outcome,
        boundary === 'application-intent' || boundary === 'manifest'
          ? 'outcome-unknown'
          : undefined,
      );
      assert(
        reopened.store
          .nativeProcesses(reopened.store.intents()[0].attempt_id)
          .every((phase) => groupAbsent(phase.process_group)),
      );
    } finally {
      await reopened.close();
    }
  }
});
