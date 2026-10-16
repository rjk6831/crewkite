import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type Approval,
  type Artifact,
  ArtifactSchema,
  type Attempt,
  type CheckResult,
  canonicalJson,
  ProjectSchema,
  RunSchema,
  TaskSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import { Controller, type ControllerOptions } from '../commands/controller.ts';
import { CandidateEvidence } from '../evidence/index.ts';
import { committedFiles, git, materialize, readFiles } from '../host/source.ts';

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
  t.after(() => {
    controller.close();
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
  const plan = evidence.prepareChecks({
    candidate: captured.candidate,
    sourceFiles: committedFiles(source.directory, source.base),
    criteria: task.criteria,
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
