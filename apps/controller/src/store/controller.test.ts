import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type Approval,
  type Artifact,
  ArtifactSchema,
  ProjectSchema,
  RunSchema,
  TaskSchema,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import { Controller, type ControllerOptions } from '../commands/controller.ts';
import { CandidateEvidence } from '../evidence/index.ts';
import { committedFiles, git, inspectSource, materialize, readFiles } from '../host/source.ts';

async function setup(t: TestContext, options: Partial<ControllerOptions> = {}) {
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
    command('PrepareRun', { taskId: task.id, policy, roles: fixtures.roles }, task.revision),
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
    command('PrepareRun', { taskId: task.id, policy, roles: fixtures.roles }, 0),
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
    effects: fixtures.policy.effects.map((grant) => ({ ...grant, taskId: task.id })),
  };
  const prepared = await controller.execute(
    command('PrepareRun', { taskId: task.id, policy, roles: fixtures.roles }, 0),
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
  assert.equal(snapshot.evidence.length, 1);
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
  const identity = { name: 'Fixture owner', email: 'owner@example.invalid' };
  const { controller, command, draft, fixtures, source, directory, clock } = await setup(t, {
    identity,
    scenarioForRoute: (route, generation) =>
      route.family === 'anthropic' && generation === 0 ? 'approval-reserve' : 'complete',
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
  const cli = readFileSync(join(source.directory, 'cli.mjs'));
  unlinkSync(join(source.directory, 'cli.mjs'));
  execFileSync('mkfifo', [join(source.directory, 'cli.mjs')]);
  assert.ok(inspectSource(fixtures.task.projectId, source.directory).dirtyCount >= 3);
  const special = join(directory, 'special');
  execFileSync('mkdir', [special]);
  execFileSync('mkfifo', [join(special, 'pipe')]);
  assert.throws(() => readFiles(special), /unsupported|regular/);
  unlinkSync(join(source.directory, 'cli.mjs'));
  writeFileSync(join(source.directory, 'cli.mjs'), cli);
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
    limits: { attempts: 5, minutes: 30, concurrency: 1 },
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
    ...fixtures.roles,
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
  const approvalReady = new Promise<Approval>((resolve) => {
    const off = controller.subscribe((event) => {
      if (event.type === 'approval.requested' && event.payload.action === 'run-check') {
        off();
        resolve(event.payload);
      }
    });
  });
  const completed = new Promise<void>((resolve) => {
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
  await controller.execute(
    command('StartRun', { taskId: task.id, runId: run.id }, prepared.revision),
    'local-owner',
  );
  const approval = await approvalReady;
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
  assert.equal(snapshot.attempts.filter((attempt) => attempt.runId === run.id).length, 5);
  assert.equal(snapshot.evidence.filter((check) => check.review).length, 2);
  assert.ok(snapshot.evidence.every((check) => check.passed));
  const handoffs = controller.store
    .eventsAfter('0')
    .filter((event) => event.type === 'handoff.sealed');
  assert.equal(handoffs.length, 1);
  assert.ok(handoffs[0].payload.packet.artifacts.length > 3);
  assert.deepEqual(
    controller.store
      .intents()
      .filter((intent) => intent.scratch_path === join(controller.home, 'scratch', run.id))
      .map((intent) => intent.generation),
    [0, 1],
  );
  const candidate = snapshot.candidates[0];
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
});
