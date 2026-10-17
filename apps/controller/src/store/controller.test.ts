import assert from 'node:assert/strict';
import {
  execFileSync,
  type SpawnOptionsWithoutStdio,
  spawn as spawnProcess,
  spawnSync,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { connectController, readControllerEndpoint } from '@crewkite/client/node';
import {
  type Approval,
  type Artifact,
  ArtifactSchema,
  type Attempt,
  type Candidate,
  type CheckEvent,
  type CheckResult,
  type CommandResult,
  CommandSchema,
  canonicalJson,
  GoogleAcpProfileSchema,
  LocalNativeProfileSchema,
  type Observation,
  type Route,
  RunSchema,
  type Task,
  TaskConversationStateSchema,
  TaskSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { createDemoFixtures } from '@crewkite/testkit';
import { writeChallengeSolution } from '@crewkite/testkit/repository';
import { fakeWorkerPath } from '@crewkite/testkit/worker';
import { ArtifactFiles } from '../artifacts/index.ts';
import {
  Controller,
  type ControllerOptions,
  type NativePilotAppointment,
} from '../commands/controller.ts';
import {
  CandidateEvidence,
  completedCheckDefinitionMatches,
  type NodeCheckDefinition,
} from '../evidence/index.ts';
import {
  journeyTitle,
  ToolchainDefinitionSchema,
  toolchainDefinitionHash,
  verificationStages,
} from '../evidence/toolchain-definition.ts';
import { type VerificationExecution, verificationCommand } from '../evidence/toolchain-verify.ts';
import {
  checkOwner,
  enrollCheckRoot,
  qualifiedWorkerExit,
  readCheckRoots,
  spawnCheckChild as spawn,
} from '../host/check-ownership.ts';
import { refValue } from '../host/publication.ts';
import { committedFiles, git, inspectSource, materialize, readFiles } from '../host/source.ts';
import { closedBefore, closedWithin, groupAbsent, OwnedCommand } from '../host/worker.ts';
import { type AcpSetupProof, acpClientPin } from '../providers/google/acp/profile.ts';
import {
  type NativeProfileResolution,
  unavailableNativeProfile,
} from '../providers/openai/profile.ts';
import { fixture, fixtureContent, fixtureModel } from '../providers/openai/replacement-fixture.ts';
import { serve as serveController } from '../server/index.ts';
import {
  binding,
  fixtureClientHash,
  nativeSetup,
  nativeWait,
  setup,
} from './controller-fixture.ts';

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
    const nativeRoute = fixture.fixtures.snapshot.routes.find(
      (route) => route.id === intent.route_id,
    );
    assert(nativeRoute);
    fixture.controller.store.transaction(() =>
      fixture.controller.store.put('route', nativeRoute.id, 0, {
        ...nativeRoute,
        family: 'openai',
        fake: false,
        qualified: false,
      }),
    );

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
  for (const first of ['close', 'deadline', 'cancel'] as const) {
    const closed = Promise.withResolvers<void>();
    const boundary = Promise.withResolvers<void>();
    let observed: boolean | undefined;
    const proof = closedBefore(closed.promise, boundary.promise).then((value) => {
      observed = value;
      return value;
    });
    await Promise.resolve();
    assert.equal(observed, undefined, 'leader exit does not complete the stream proof');
    if (first === 'close') closed.resolve();
    else boundary.resolve();
    assert.equal(await proof, first === 'close', first);
    closed.resolve();
    boundary.resolve();
    assert.equal(await proof, first === 'close', 'late closure cannot rewrite the boundary');
  }
  const { controller, command, draft, fixtures } = await setup(t, {
    scenarioForRoute: () => 'stubborn',
  });
  for (const streams of ['inherit', 'ignore'] as const) {
    const descendant = `process.on('SIGUSR2',()=>process.exit(0)); setInterval(()=>{},10000); process.stdout.write('ready\\n');`;
    const leader = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe',${JSON.stringify(streams)}]}); child.stdout.once('data',chunk=>{process.stdout.write(chunk);process.exit(0);});`;
    const job = new OwnedCommand({
      argv: ['-e', leader],
      directory: controller.home,
      environmentHome: join(controller.home, `closure-${streams}`),
      onSpawn: () => {},
    });
    t.after(() => {
      if (!groupAbsent(job.group))
        try {
          process.kill(-job.group, 'SIGKILL');
        } catch {}
    });
    const exit = await nativeWait('retained command descendant', job.exited);
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.equal(exit.quiescent, false);
    assert.equal(groupAbsent(job.group), false);
    const boundary = Promise.withResolvers<void>();
    let drained: boolean | undefined;
    const withinBudget = closedBefore(job.closed, boundary.promise).then((value) => {
      drained = value;
      return value;
    });
    if (streams === 'ignore') await nativeWait('closed command streams', job.closed);
    assert.equal(
      await job.quiescent((work, milliseconds) => {
        assert.equal(milliseconds, 1000);
        if (streams === 'inherit') queueMicrotask(work);
        return () => {};
      }),
      false,
      'a live descendant or retained stream cannot prove quiescence',
    );
    if (streams === 'inherit')
      assert.equal(drained, undefined, 'the old cleanup grace cannot spend the admitted deadline');
    process.kill(-job.group, 'SIGUSR2');
    await nativeWait('released command descendant', job.closed);
    if (streams === 'ignore') {
      let polling = true;
      try {
        await nativeWait(
          'released command group',
          new Promise<void>((resolve) => {
            const check = () => {
              if (groupAbsent(job.group)) resolve();
              else if (polling) setImmediate(check);
            };
            check();
          }),
          1000,
        );
      } finally {
        polling = false;
      }
    }
    assert.equal(await withinBudget, true, 'physical closure arrived before the owner boundary');
    boundary.resolve();
    assert.equal(await job.quiescent(), true);
    assert.equal(groupAbsent(job.group), true);
    assert.equal(exit.quiescent, false, 'the leader exit snapshot remains historical');
  }
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
  const ownership = join(directory, 'ownership');
  mkdirSync(ownership);
  const owner = {
    version: 1 as const,
    directory: ownership,
    stateRoot: directory,
    electronExecutable: process.execPath,
    attemptId: id('att'),
    generation: 0,
    stage: 'node-tests' as const,
    parentGroup: 12345,
  };
  // Negative fixtures must close, but their nonzero exits are deliberate evidence.
  for (const code of [0, 3]) {
    const ticket = enrollCheckRoot('fixture', true, owner);
    const child = spawn(process.execPath, ['-e', `process.exit(${code})`], {
      detached: true,
      stdio: 'ignore',
    });
    ticket.acknowledge(child);
    await new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('close', () => done());
    });
    const record = readCheckRoots(owner).find((row) => row.acknowledgment?.pid === child.pid);
    assert(record?.terminal);
    assert.equal(record.terminal.code, code);
    assert.equal(record.terminal.signal, null);
    assert.equal(record.acknowledgment?.group, child.pid);
    assert.equal(groupAbsent(child.pid ?? 0), true);
  }
  const attached = enrollCheckRoot('fixture', false, owner);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  attached.acknowledge(child);
  await new Promise<void>((done) => child.once('close', () => done()));
  assert.equal(
    readCheckRoots(owner).find((row) => row.acknowledgment?.pid === child.pid)?.acknowledgment
      ?.group,
    owner.parentGroup,
  );
  const witnessDirectory = join(directory, 'worker-exit');
  mkdirSync(witnessDirectory);
  const witnessOwner = { ...owner, directory: witnessDirectory };
  const witnessTicket = enrollCheckRoot('worker', true, witnessOwner, fakeWorkerPath);
  assert(witnessTicket.preload);
  const witnessed = spawnProcess(
    process.execPath,
    [`--import=${witnessTicket.preload}`, fakeWorkerPath],
    { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: witnessTicket.environment },
  );
  const witnessClosed = new Promise<void>((done) => witnessed.once('close', () => done()));
  witnessTicket.acknowledge(witnessed);
  witnessed.stdin.end();
  try {
    assert.equal(await closedWithin(witnessClosed), true);
  } finally {
    if (!groupAbsent(witnessed.pid ?? 0)) process.kill(-(witnessed.pid as number), 'SIGKILL');
    assert.equal(await closedWithin(witnessClosed), true);
  }
  const witnessedRoot = readCheckRoots(witnessOwner)[0];
  assert.equal(witnessedRoot.terminal?.code, 2);
  assert.deepEqual(witnessedRoot.exitEvent, { type: 'fixture-exit', pid: witnessed.pid, code: 2 });
  assert.equal(qualifiedWorkerExit(witnessedRoot), true);
  assert.equal(groupAbsent(witnessed.pid ?? 0), true);
  const witnessPath = join(witnessDirectory, witnessedRoot.id);
  const witnessRows = readFileSync(witnessPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((row) => JSON.parse(row));
  const writeWitnessRows = (rows: unknown[]) =>
    writeFileSync(witnessPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeWitnessRows(witnessRows.slice(0, -1));
  const witnessedExit = readCheckRoots(witnessOwner)[0];
  assert.equal(witnessedExit.terminal, undefined);
  assert.equal(qualifiedWorkerExit(witnessedExit), true);
  for (const change of [
    (rows: typeof witnessRows) => {
      rows.splice(1, 1);
    },
    (rows: typeof witnessRows) => {
      rows[2].pid += 1;
    },
    (rows: typeof witnessRows) => {
      rows.push(rows[2]);
    },
    (rows: typeof witnessRows) => {
      rows[0].role = 'fixture';
    },
    (rows: typeof witnessRows) => {
      rows[0].owner.stage = 'policy';
    },
    (rows: typeof witnessRows) => {
      [rows[2], rows[3]] = [rows[3], rows[2]];
    },
  ]) {
    const rows = structuredClone(witnessRows);
    change(rows);
    writeWitnessRows(rows);
    assert.throws(() => readCheckRoots(witnessOwner));
  }
  writeWitnessRows(witnessRows);
  for (const acknowledge of [false, true]) {
    const pendingDirectory = join(directory, `worker-exit-${acknowledge}`);
    mkdirSync(pendingDirectory);
    const pendingOwner = { ...owner, directory: pendingDirectory };
    const ticket = enrollCheckRoot('worker', true, pendingOwner, fakeWorkerPath);
    assert(ticket.preload);
    const child = spawnProcess(process.execPath, [`--import=${ticket.preload}`, fakeWorkerPath], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: ticket.environment,
    });
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    if (acknowledge) {
      ticket.acknowledge(child);
      child.kill('SIGKILL');
    } else child.stdin.end();
    try {
      assert.equal(await closedWithin(closed), true);
    } finally {
      if (!groupAbsent(child.pid ?? 0)) process.kill(-(child.pid as number), 'SIGKILL');
      assert.equal(await closedWithin(closed), true);
    }
    const root = readCheckRoots(pendingOwner)[0];
    assert.equal(root.exitEvent, undefined);
    assert.equal(qualifiedWorkerExit(root), false);
    assert.equal(groupAbsent(child.pid ?? 0), true);
    if (acknowledge) {
      assert.equal(root.terminal?.signal, 'SIGKILL');
      const path = join(pendingDirectory, root.id);
      writeFileSync(
        path,
        `${readFileSync(path, 'utf8').trimEnd().split('\n').slice(0, -1).join('\n')}\n`,
      );
      assert.equal(readCheckRoots(pendingOwner)[0].terminal, undefined);
    }
  }
  const ineligibleDirectory = join(directory, 'worker-exit-ineligible');
  mkdirSync(ineligibleDirectory);
  for (const [role, detached, stage, entrypoint] of [
    ['worker', true, 'node-tests', `${fakeWorkerPath}.custom`],
    ['fixture', true, 'node-tests', fakeWorkerPath],
    ['worker', false, 'node-tests', fakeWorkerPath],
    ['worker', true, 'policy', fakeWorkerPath],
  ] as const) {
    const ticket = enrollCheckRoot(
      role,
      detached,
      { ...owner, directory: ineligibleDirectory, stage },
      entrypoint,
    );
    assert.equal(ticket.preload, undefined);
    ticket.failed();
  }
  const stageDirectory = join(directory, 'isolated-stage');
  mkdirSync(stageDirectory);
  const stageOwner = { ...owner, directory: stageDirectory, parentGroup: 0 };
  const stageTicket = enrollCheckRoot('stage', true, stageOwner);
  const helper = new URL('../host/check-ownership.ts', import.meta.url).href;
  const files = [0, 1].map((index) => {
    const path = join(directory, `stage-${index}.test.mjs`);
    writeFileSync(
      path,
      `
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { test as fixtureTest } from 'node:test';
import { checkOwner, spawnCheckChild } from ${JSON.stringify(helper)};
fixtureTest('attached fixture keeps the admitted stage group', async () => {
  const owner = checkOwner();
  assert(owner);
  assert.equal(process.env.CREWKITE_CHECK_STAGE_ROOT, undefined);
  writeFileSync(${JSON.stringify(join(directory, `stage-${index}.json`))}, JSON.stringify({pid:process.pid,group:owner.parentGroup}));
  const child = spawnCheckChild(process.execPath, ['-e', 'process.exit(0)'], {stdio:'ignore'});
  const [code,signal] = await once(child, 'close');
  assert.equal(code,0);
  assert.equal(signal,null);
});
`,
    );
    return path;
  });
  const stageChild = spawnProcess(process.execPath, [`--import=${helper}`, '--test', ...files], {
    detached: true,
    stdio: 'ignore',
    env: stageTicket.environment,
  });
  const stageClosed = new Promise<void>((done) => stageChild.once('close', () => done()));
  stageTicket.acknowledge(stageChild);
  try {
    assert.equal(await closedWithin(stageClosed), true);
  } finally {
    if (!groupAbsent(stageChild.pid ?? 0)) process.kill(-(stageChild.pid as number), 'SIGKILL');
    assert.equal(await closedWithin(stageClosed), true);
  }
  assert.equal(stageChild.exitCode, 0);
  const stageRoots = readCheckRoots(stageOwner);
  assert.equal(stageRoots.length, 3);
  for (const root of stageRoots) {
    assert.equal(root.acknowledgment?.group, stageChild.pid);
    assert.equal(root.terminal?.code, 0);
  }
  for (const index of [0, 1]) {
    const observed = JSON.parse(readFileSync(join(directory, `stage-${index}.json`), 'utf8'));
    assert.notEqual(observed.pid, stageChild.pid);
    assert.equal(observed.group, stageChild.pid);
  }
  const unacknowledged = enrollCheckRoot('stage', true, stageOwner);
  const noAck = spawnProcess(process.execPath, [`--import=${helper}`, '-e', 'process.exit(0)'], {
    detached: true,
    stdio: 'ignore',
    env: unacknowledged.environment,
  });
  const noAckClosed = new Promise<void>((done) => noAck.once('close', () => done()));
  try {
    assert.equal(await closedWithin(noAckClosed), true);
  } finally {
    if (!groupAbsent(noAck.pid ?? 0)) process.kill(-(noAck.pid as number), 'SIGKILL');
    assert.equal(await closedWithin(noAckClosed), true);
  }
  assert.notEqual(noAck.exitCode, 0);
  assert.equal(readCheckRoots(stageOwner).filter((root) => !root.acknowledgment).length, 1);
  const faultDirectory = join(directory, 'ownership-fault');
  mkdirSync(faultDirectory);
  const faultOwner = { ...owner, directory: faultDirectory };
  const faultTicket = enrollCheckRoot('fixture', true, faultOwner);
  const faultChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const faultClosed = new Promise<void>((done) => faultChild.once('close', () => done()));
  const journalPath = join(faultDirectory, readdirSync(faultDirectory)[0]);
  rmSync(journalPath);
  mkdirSync(journalPath);
  const waitFaultClosed = () =>
    new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(Error('Fault fixture closure exceeded its bound.')),
        2000,
      );
      void faultClosed.then(() => {
        clearTimeout(timer);
        done();
      });
    });
  try {
    assert.throws(() => faultTicket.acknowledge(faultChild), { code: 'EISDIR' });
    await waitFaultClosed();
    assert.equal(faultChild.exitCode, null);
    assert.equal(faultChild.signalCode, 'SIGKILL');
    assert.equal(groupAbsent(faultChild.pid ?? 0), true);
    assert.throws(() => readCheckRoots(faultOwner), /ownership record/);
  } finally {
    if (!groupAbsent(faultChild.pid ?? 0)) {
      try {
        process.kill(-(faultChild.pid as number), 'SIGKILL');
      } catch {}
    }
    await waitFaultClosed();
  }
  const missingTicket = enrollCheckRoot('fixture', true, owner);
  const missing = spawn(join(directory, 'missing-executable'), [], {
    detached: true,
    stdio: 'ignore',
  });
  const missingClosed = new Promise<void>((done) => missing.once('close', () => done()));
  missingTicket.acknowledge(missing);
  assert.equal(await closedWithin(missingClosed), true);
  const missingRecord = readCheckRoots(owner).find((row) => row.spawnFailed);
  assert(missingRecord);
  assert.equal(missing.pid, undefined);
  assert.equal(missingRecord.terminal?.code, -2);
  assert.equal(missingRecord.acknowledgment, undefined);
  const absent = enrollCheckRoot('fixture', true, owner);
  absent.failed();
  assert.equal(readCheckRoots(owner).filter((row) => row.spawnFailed).length, 2);
  enrollCheckRoot('fixture', true, owner);
  assert.equal(
    readCheckRoots(owner).filter((row) => !row.acknowledgment && !row.spawnFailed).length,
    1,
  );

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
  const artifactFiles = new ArtifactFiles(join(directory, 'negative-artifacts'));
  const evidence = new CandidateEvidence({
    home: directory,
    artifacts: artifactFiles,
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
  assert.equal(definition.recipeId, 'node-tests-v1');
  type SyntheticDefinition = Extract<NodeCheckDefinition, { recipeId: 'node-tests-v1' }>;
  const withDigest = (value: SyntheticDefinition): SyntheticDefinition => {
    const {
      recipeId: _recipe,
      candidateId: _candidate,
      candidateHash: _hash,
      definitionHash: _definition,
      ...fields
    } = value;
    return { ...value, definitionHash: hashCanonical(fields) };
  };
  const historical = withDigest({
    ...definition,
    argv: definition.argv.map((argument, index) =>
      index === 1
        ? `--test-reporter=${join(directory, 'former-runtime', 'reporter.ts')}`
        : argument,
    ),
  });
  const historicalCases: {
    name: string;
    saved: SyntheticDefinition;
    current?: SyntheticDefinition;
    matches?: boolean;
  }[] = [
    { name: 'same runtime', saved: definition, matches: true },
    { name: 'identical relocated reporter', saved: historical, matches: true },
    { name: 'saved digest', saved: { ...historical, definitionHash: '0'.repeat(64) } },
    {
      name: 'relative reporter',
      saved: withDigest({
        ...historical,
        argv: historical.argv.map((value, index) =>
          index === 1 ? '--test-reporter=./reporter.ts' : value,
        ),
      }),
    },
    { name: 'reporter bytes', saved: withDigest({ ...historical, reporterHash: '0'.repeat(64) }) },
    { name: 'evaluator', saved: withDigest({ ...historical, evaluator: 'node:changed' }) },
    {
      name: 'flags',
      saved: withDigest({ ...historical, argv: ['--test-only', ...historical.argv.slice(1)] }),
    },
    {
      name: 'test scope',
      saved: withDigest({
        ...historical,
        collection: historical.collection.map((file, index) =>
          index === 0 ? { ...file, path: 'other.test.mjs' } : file,
        ),
        argv: historical.argv.map((value, index) => (index === 3 ? './other.test.mjs' : value)),
      }),
    },
    {
      name: 'criteria',
      saved: withDigest({ ...historical, criteria: [...historical.criteria, 'Changed criterion'] }),
    },
    {
      name: 'required tests',
      saved: withDigest({
        ...historical,
        required: { ...historical.required, count: historical.required.count + 1 },
      }),
    },
    { name: 'candidate', saved: { ...historical, candidateHash: '0'.repeat(64) } },
    {
      name: 'current reporter location',
      saved: historical,
      current: withDigest({ ...definition, argv: historical.argv }),
    },
  ];
  for (const row of historicalCases) {
    const current: SyntheticDefinition = row.current ?? definition;
    assert.equal(
      completedCheckDefinitionMatches(row.saved, current),
      row.matches ?? false,
      row.name,
    );
  }
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
  const outside = join(directory, 'outside.cjs');
  writeFileSync(outside, 'module.exports = 42;');
  const esm =
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('value',()=>assert.equal(42,42));";
  const common =
    "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('value',()=>assert.equal(require('./helper.cjs'),42));";
  for (const row of [
    {
      name: 'ESM and CommonJS',
      tests: { 'tests/日本 語.test.mjs': esm, 'check.cjs': common },
      passed: true,
    },
    {
      name: 'dynamic ESM',
      tests: {
        'check.mjs':
          "const {test}=await import('node:test'); const {default:value}=await import('./helper.cjs'); test('value',()=>{if(value!==42)throw Error('value');});",
      },
      passed: true,
    },
    {
      name: 'createRequire',
      tests: {
        'check.mjs':
          "import {test} from 'node:test'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); test('value',()=>{if(require('./helper.cjs')!==42)throw Error('value');});",
      },
      passed: true,
    },
    {
      name: 'missing dependency',
      tests: { 'check.mjs': "import 'crewkite-missing-test-package';" },
    },
    { name: 'outside ESM', tests: { 'check.mjs': `import ${JSON.stringify(outside)}; ${esm}` } },
    {
      name: 'outside require',
      tests: { 'check.cjs': `require(${JSON.stringify(outside)}); ${common}` },
    },
    {
      name: 'outside createRequire',
      tests: {
        'check.mjs': `import {createRequire} from 'node:module'; createRequire(import.meta.url)(${JSON.stringify(outside)}); ${esm}`,
      },
    },
    { name: 'no tests', tests: { 'check.mjs': 'export const value=42;' } },
    { name: 'exit before registration', tests: { 'check.mjs': 'process.exit(0);' } },
    {
      name: 'exit after registration',
      tests: {
        'check.mjs': "import {test} from 'node:test'; test('lost',()=>{}); process.exit(0);",
      },
    },
    {
      name: 'exit inside test',
      tests: { 'check.mjs': "import {test} from 'node:test'; test('lost',()=>process.exit(0));" },
    },
    {
      name: 'one file without tests',
      tests: { 'check.mjs': esm, 'empty.mjs': 'export const value=42;' },
    },
    { name: 'changed evaluated copy', tests: { 'check.mjs': esm }, changeCopy: true },
  ]) {
    const contents = { ...row.tests, 'helper.cjs': 'module.exports = 42;' };
    const files = Object.entries(contents).map(([path, text]) => {
      const content = Buffer.from(text);
      return {
        path,
        mode: '100644' as const,
        bytes: content.length,
        hash: createHash('sha256').update(content).digest('hex'),
        content,
      };
    });
    const saved = evidence.capture({ taskId: task.id, base: source.base, files, existing: [] });
    for (const artifact of saved.artifacts) metadata.set(artifact.id, artifact);
    const selection = {
      recipeId: 'project-node-tests-v1' as const,
      testFiles: Object.keys(row.tests).reverse(),
    };
    const selected = evidence.describeChecks({
      candidate: saved.candidate,
      sourceFiles: files,
      criteria: task.criteria,
      selection,
    });
    assert.equal(selected.recipeId, 'project-node-tests-v1');
    assert.deepEqual(
      selected.collection.map((file) => file.path),
      [...selection.testFiles].sort(),
    );
    const check = evidence.prepareChecks({
      candidate: saved.candidate,
      sourceFiles: files,
      criteria: task.criteria,
      expected: selected,
    });
    const output = spawnSync(process.execPath, check.argv, {
      cwd: check.directory,
      env: { PATH: process.env.PATH, LANG: 'C', HOME: controller.home },
      maxBuffer: 1048576,
      timeout: 5000,
    });
    assert.equal(output.error, undefined, row.name);
    if (row.changeCopy) appendFileSync(join(check.directory, selection.testFiles[0]), '\n');
    assert.equal(
      evidence.recordCheck({
        candidate: saved.candidate,
        plan: check,
        passed: output.status === 0,
        output: output.stdout,
      }).evidence.passed,
      row.passed === true,
      row.name,
    );
    if (row.passed) {
      const digestDefinition = (value: typeof selected) => {
        const {
          recipeId: _recipe,
          candidateId: _candidate,
          candidateHash: _hash,
          definitionHash: _definition,
          ...fields
        } = value;
        return { ...value, definitionHash: hashCanonical(fields) };
      };
      const relocated = digestDefinition({
        ...selected,
        argv: selected.argv.map((argument, index) =>
          index === 0
            ? `--import=${join(directory, 'old', 'import-guard.ts')}`
            : index === 2
              ? `--test-reporter=${join(directory, 'old', 'reporter.ts')}`
              : argument,
        ),
      });
      assert.equal(completedCheckDefinitionMatches(relocated, selected), true);
      for (const changed of [
        { guardHash: '0'.repeat(64) },
        { reporterHash: '0'.repeat(64) },
        { required: { files: ['other.mjs'] } },
      ])
        assert.equal(
          completedCheckDefinitionMatches(digestDefinition({ ...relocated, ...changed }), selected),
          false,
        );
      const rows = output.stdout
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      const incomplete = Buffer.from(
        `${rows
          .filter((row) => row.type !== 'summary' || row.file === null)
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`,
      );
      assert.equal(
        evidence.recordCheck({
          candidate: saved.candidate,
          plan: check,
          passed: true,
          output: incomplete,
        }).evidence.passed,
        false,
      );
      const altered = files.map((file) =>
        file.path === selection.testFiles[0]
          ? {
              ...file,
              content: Buffer.from('changed'),
              bytes: 7,
              hash: createHash('sha256').update('changed').digest('hex'),
            }
          : file,
      );
      assert.throws(
        () =>
          evidence.describeChecks({
            candidate: saved.candidate,
            sourceFiles: altered,
            criteria: task.criteria,
            selection,
          }),
        /selected committed Node test changed/,
      );
    }
  }
  const buildEntries = [
    { path: '.', kind: 'directory' as const, mode: 0o755 },
    ...['main', 'preload', 'renderer'].flatMap((path, index) => [
      { path, kind: 'directory' as const, mode: 0o755 },
      {
        path: `${path}/${['index.js', 'index.cjs', 'index.html'][index]}`,
        kind: 'file' as const,
        mode: 0o644,
        bytes: 1,
        hash: createHash('sha256').update('x').digest('hex'),
      },
    ]),
  ];
  const buildHash = createHash('sha256');
  for (const row of [{ version: 1, files: 3, bytes: 3 }, ...buildEntries])
    buildHash.update(`${JSON.stringify(row)}\n`);
  const build = {
    version: 1 as const,
    entries: buildEntries,
    files: 3,
    bytes: 3,
    hash: buildHash.digest('hex'),
  };
  const inventoryHash = createHash('sha256');
  for (const row of [{ version: 1, workspaces: [] }, { tree: build.hash }])
    inventoryHash.update(`${JSON.stringify(row)}\n`);
  const inventory = {
    version: 1,
    workspaces: [],
    projectFiles: [],
    buildDependencies: [],
    tree: build,
    hash: inventoryHash.digest('hex'),
  };
  const inventoryReference = artifactFiles.publish(Buffer.from(canonicalJson(inventory)));
  const executable = {
    path: join(directory, 'former-runtime', 'missing'),
    version: 'fixture-v1',
    sha256: fixtureClientHash,
  };
  const fields = {
    recipeId: 'crewkite-verify-v1' as const,
    candidateId: captured.candidate.id,
    candidateHash: captured.candidate.hash,
    evaluator: 'crewkite-verify-v1:fixture',
    criteria: task.criteria,
    baseline: definition.collection,
    baselineHash: hashCanonical(definition.collection),
    inventory: inventoryReference,
    toolchainHash: inventory.hash,
    lockHash: fixtureClientHash,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    executables: { node: executable, git: executable, electron: executable },
    mkfifo: { path: executable.path, sha256: executable.sha256 },
    entrypoints: {
      biome: 'node_modules/biome',
      types: 'node_modules/types.ts',
      build: 'node_modules/build.ts',
      desktop: 'node_modules/desktop.ts',
      electron: 'node_modules/electron',
    },
    collection: definition.collection.map((file) => ({
      ...file,
      tests: definition.required.tests,
    })),
    journey: { file: 'e2e/desktop.spec.ts', title: journeyTitle, hash: fixtureClientHash } as const,
    stages: [...verificationStages] as [...typeof verificationStages],
    provenancePattern: 'fixture',
    maximumMinutes: 5 as const,
  };
  const verification = ToolchainDefinitionSchema.parse({
    ...fields,
    definitionHash: toolchainDefinitionHash(fields),
  });
  const frames = (file: string, names: string[]): CheckEvent[] => {
    const counts = {
      tests: names.length,
      passed: names.length,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
      suites: 0,
    };
    return [
      { type: 'start', version: 1 },
      ...names.map((name) => ({
        type: 'test' as const,
        file,
        name,
        kind: 'test' as const,
        passed: true,
        skipped: false,
        todo: false,
      })),
      { type: 'summary', file, success: true, counts },
      { type: 'summary', file: null, success: true, counts },
      { type: 'end' },
    ];
  };
  const encoded = (rows: CheckEvent[]) =>
    Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`).toString('base64');
  const verificationOwner = { ...owner, directory: join(directory, 'verification-owner') };
  const execution: VerificationExecution = {
    version: 1,
    attemptId: owner.attemptId,
    generation: owner.generation,
    definitionHash: verification.definitionHash,
    stages: verificationStages.map((stage) => ({
      stage,
      commandHash: hashCanonical(verificationCommand(verification, stage)),
      code: 0,
      signal: null,
      closed: true,
      stdout:
        stage === 'node-tests'
          ? encoded(frames(definition.required.path, definition.required.tests))
          : stage === 'desktop'
            ? encoded(frames(verification.journey.file, [journeyTitle]))
            : '',
      stderr: '',
    })),
    roots: verificationStages.map((stage, index) => ({
      id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}.jsonl`,
      intent: {
        type: 'intent',
        owner: { ...verificationOwner, stage },
        role: 'stage',
        detached: true,
      },
      acknowledgment: {
        type: 'ack',
        pid: faultChild.pid as number,
        group: faultChild.pid as number,
      },
      terminal: { type: 'close', code: 0, signal: null },
      spawnFailed: false,
    })),
    quiescent: true,
    unchanged: true,
    build,
    failure: null,
  };
  const record = (value: VerificationExecution) => {
    const result = evidence.recordVerification({
      candidate: captured.candidate,
      definition: verification,
      execution: value,
      owner: verificationOwner,
    });
    for (const artifact of result.artifacts) metadata.set(artifact.id, artifact);
    return result;
  };
  const complete = record(execution);
  assert.equal(complete.evidence.passed, true);
  const workerExit = structuredClone(execution);
  workerExit.roots.push({
    ...witnessedExit,
    intent: { ...witnessedExit.intent, owner: { ...verificationOwner, stage: 'node-tests' } },
  });
  assert.equal(record(workerExit).evidence.passed, true);
  for (const change of [
    (value: VerificationExecution) => {
      value.roots[value.roots.length - 1].intent.role = 'stage';
    },
    (value: VerificationExecution) => {
      const event = value.roots[value.roots.length - 1].exitEvent;
      assert(event);
      event.pid += 1;
    },
    (value: VerificationExecution) => {
      delete value.roots[value.roots.length - 1].acknowledgment;
    },
  ]) {
    const value = structuredClone(workerExit);
    change(value);
    assert.throws(() => record(value));
  }
  const invalidClose = structuredClone(workerExit);
  invalidClose.roots[invalidClose.roots.length - 1].terminal = {
    type: 'close',
    code: null,
    signal: null,
  };
  assert.equal(record(invalidClose).evidence.passed, false);
  const failedSpawn = structuredClone(execution);
  failedSpawn.roots.push({
    ...missingRecord,
    intent: { ...missingRecord.intent, owner: verificationOwner },
  });
  assert.equal(record(failedSpawn).evidence.passed, true);
  const negativeStage = structuredClone(execution);
  negativeStage.stages[0].code = -2;
  assert.throws(() => record(negativeStage));
  const mutations: { name: string; change: (value: VerificationExecution) => void }[] = [
    { name: 'missing stage', change: (value) => void value.stages.pop() },
    {
      name: 'command binding',
      change: (value) => {
        value.stages[0].commandHash = fixtureClientHash;
      },
    },
    {
      name: 'failed stage',
      change: (value) => {
        value.stages[0].code = 1;
      },
    },
    {
      name: 'unclosed root',
      change: (value) => {
        delete value.roots[0].terminal;
      },
    },
    {
      name: 'unacknowledged root',
      change: (value) => {
        delete value.roots[0].acknowledgment;
      },
    },
    {
      name: 'wrong owner',
      change: (value) => {
        value.roots[0].intent.owner.generation += 1;
      },
    },
    {
      name: 'wrong candidate definition',
      change: (value) => {
        value.definitionHash = fixtureClientHash;
      },
    },
    {
      name: 'truncated Node report',
      change: (value) => {
        value.stages[3].stdout = encoded(
          frames(definition.required.path, definition.required.tests).slice(0, -1),
        );
      },
    },
    {
      name: 'wrong collected test',
      change: (value) => {
        value.stages[3].stdout = encoded(frames(definition.required.path, ['other']));
      },
    },
    {
      name: 'changed build inventory',
      change: (value) => {
        if (value.build) value.build = { ...value.build, hash: fixtureClientHash };
      },
    },
    {
      name: 'unfinished cleanup',
      change: (value) => {
        value.quiescent = false;
      },
    },
  ];
  for (const row of mutations) {
    const changed = structuredClone(execution);
    row.change(changed);
    assert.equal(record(changed).evidence.passed, false, row.name);
  }
  const reporter = new URL('../evidence/desktop-reporter.ts', import.meta.url).href;
  for (const scenario of [
    'passed',
    'retry',
    'expected failure',
    'extra case',
    'error',
    'missing exit',
  ]) {
    const output = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import Reporter from ${JSON.stringify(reporter)};
      const scenario = ${JSON.stringify(scenario)};
      const reporter = new Reporter();
      const test = { id: 'journey', title: ${JSON.stringify(journeyTitle)},
        location: { file: ${JSON.stringify(resolve('e2e/desktop.spec.ts'))} },
        expectedStatus: scenario === 'expected failure' ? 'failed' : 'passed' };
      reporter.onBegin({}, { allTests: () => scenario === 'extra case' ? [test, test] : [test] });
      reporter.onTestEnd(test, { status: 'passed', retry: scenario === 'retry' ? 1 : 0, errors: [] });
      if (scenario === 'error') reporter.onError();
      reporter.onEnd({ status: 'passed' });
      if (scenario !== 'missing exit') await reporter.onExit();
    `,
      ],
      {
        env: {
          LANG: 'C',
          CREWKITE_CHECK_JOURNEY: JSON.stringify({
            file: verification.journey.file,
            title: verification.journey.title,
          }),
        },
        timeout: 5000,
        maxBuffer: 65536,
      },
    );
    assert.equal(output.error, undefined, scenario);
    assert.equal(output.status, 0, scenario);
    const changed = structuredClone(execution);
    changed.stages[5].stdout = output.stdout.toString('base64');
    assert.equal(record(changed).evidence.passed, scenario === 'passed', scenario);
  }
  const savedArtifact = metadata.get(complete.evidence.artifactId);
  assert(savedArtifact);
  const savedMetadata = JSON.parse(artifactFiles.read(savedArtifact.hash).toString('utf8'));
  const historicalInput = {
    candidate: captured.candidate,
    definition: verification,
    metadata: savedMetadata,
    owner: verificationOwner,
  };
  const kill = t.mock.method(process, 'kill', () => {
    throw Error('Historical evidence probed a PID.');
  });
  try {
    assert.equal(evidence.verificationMatches(historicalInput), true);
    assert.equal(kill.mock.callCount(), 0);
  } finally {
    kill.mock.restore();
  }
  assert.equal(
    evidence.verificationMatches({
      ...historicalInput,
      owner: { ...verificationOwner, generation: 1 },
    }),
    false,
  );
  const proofReference = savedMetadata.verification.artifact;
  metadata.set(proofReference.id, { ...proofReference, hash: fixtureClientHash });
  assert.equal(evidence.verificationMatches(historicalInput), false);
});

test('acceptance creates one checked branch and preserves the original source', async (t) => {
  for (const transfer of ['reserve', 'manual'] as const)
    await acceptsTransferredCandidate(t, transfer);
  await acceptsNativeCandidate(t);
});

async function acceptsNativeCandidate(t: TestContext) {
  const context = await nativeSetup(t, 'google-checked', {
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
  });
  let controller = context.controller;
  const { command, task, source, clock, appointment } = context;
  const original = inspectSource(task.projectId, source.directory);
  const index = readFileSync(join(source.directory, '.git', 'index'));
  const sentinels = source.sentinels.map((file) => ({
    ...file,
    bytes: readFileSync(join(source.directory, file.path)),
    mode: lstatSync(join(source.directory, file.path)).mode & 0o777,
  }));
  const revision = () => controller.snapshot().tasks[0].revision;
  const retained = nativeCandidate(controller);
  const handoffPolicy = {
    ...appointment.policy,
    unknownUsage: {
      rule: 'fixed-allowance' as const,
      allowance: { launches: 2, minutes: appointment.policy.limits.minutes },
    },
  };
  const handoffTargets = [
    { profileId: 'openai-file-v1', creditPolicy: 'ordinary' },
    { profileId: 'google-file-v1', creditPolicy: 'ordinary' },
  ];
  const prepared = await controller.execute(
    command(
      'PrepareNativeRun',
      {
        taskId: task.id,
        profileId: context.reviewerProfile.facts.id,
        targetPath: 'net.mjs',
        policy: handoffPolicy,
        handoffTargets,
        consent: 'explicit',
      },
      revision(),
    ),
    'local-owner',
  );
  assert.equal(prepared.outcome, 'applied');
  const run = RunSchema.parse(prepared.entity);
  assert.equal(
    (
      await controller.execute(
        command(
          'StartRun',
          {
            taskId: task.id,
            runId: run.id,
          },
          revision(),
        ),
        'local-owner',
      )
    ).outcome,
    'applied',
  );
  await context.wait('native acceptance candidate', retained);
  const firstIntent = controller.store.intents().find((value) => value.run_id === run.id);
  assert(firstIntent);
  const firstBytes = readFiles(firstIntent.scratch_path);
  const firstCandidate = controller.snapshot().candidates.at(-1);
  assert(firstCandidate);
  assert.deepEqual(controller.snapshot().nativeRuns[0]?.handoff?.targets, handoffTargets);
  assert.deepEqual(
    controller.store.get<ReturnType<typeof RunSchema.parse>>('run', run.id)?.roles,
    run.roles,
  );
  const transferPayload = {
    taskId: task.id,
    runId: run.id,
    fromAttemptId: firstIntent.attempt_id,
    profileId: 'google-file-v1',
    creditPolicy: 'ordinary',
    consent: 'explicit',
    permissionMode: 'request-review',
    billingAttestation: {
      source: 'user-attested',
      subscriptionLoginConfirmed: true,
      paidExtraUsageDisabled: true,
    },
  };
  for (const change of [
    { fromAttemptId: context.id('att') },
    { profileId: 'anthropic-file-v1', permissionMode: undefined },
  ]) {
    const input = { ...transferPayload, ...change };
    if (input.permissionMode === undefined) delete input.permissionMode;
    assert.equal(
      (await controller.execute(command('PrepareNativeHandoff', input, revision()), 'local-owner'))
        .outcome,
      'blocked',
    );
  }
  const transfer = command('PrepareNativeHandoff', transferPayload, revision());
  assert.equal((await controller.execute(transfer, 'local-owner')).outcome, 'applied');
  assert.equal((await controller.execute(transfer, 'local-owner')).outcome, 'already-applied');
  const pending = controller.snapshot().nativeRuns[0]?.handoff?.pending;
  assert(pending?.start.available);
  assert.equal(pending.baseHash, firstBytes.find((file) => file.path === 'net.mjs')?.hash);
  assert.notEqual(pending.baseHash, appointment.target.baseHash);
  controller = await context.restart();
  assert.deepEqual(controller.snapshot().nativeRuns[0]?.handoff?.pending, pending);
  const transferred = nativeCandidate(controller);
  const startTransfer = command(
    'StartNativeHandoff',
    { taskId: task.id, runId: run.id, preparationId: pending.preparationId },
    revision(),
  );
  assert.equal((await controller.execute(startTransfer, 'local-owner')).outcome, 'applied');
  assert.equal((await controller.execute(startTransfer, 'local-owner')).outcome, 'already-applied');
  await context.wait('manual native successor candidate', transferred);
  const writerIntents = controller.store.intents().filter((value) => value.run_id === run.id);
  assert.equal(writerIntents.length, 2);
  const successor = writerIntents.at(-1);
  assert(successor);
  assert.notEqual(successor.scratch_path, firstIntent.scratch_path);
  assert.equal(successor.generation, 1);
  assert.deepEqual(readFiles(firstIntent.scratch_path), firstBytes);
  assert.equal(
    controller.store.receipt(`candidate:${firstIntent.attempt_id}`)?.hash,
    firstCandidate.hash,
  );
  const currentRun = RunSchema.parse(controller.store.get('run', run.id));
  assert.deepEqual(currentRun.roles, run.roles);
  assert.deepEqual(currentRun.policy, run.policy);
  assert.equal(currentRun.roles[0].pinned, true);
  assert.deepEqual(currentRun.roles[0].approvedFallbacks, []);
  assert(controller.store.receipt(`native-handoff-consumed:${successor.attempt_id}`));
  assert.equal(
    (
      await controller.execute(
        command('StartNativeHandoff', startTransfer.payload, revision()),
        'local-owner',
      )
    ).outcome,
    'blocked',
  );
  const candidate = controller.snapshot().candidates.at(-1);
  assert(candidate);
  const evaluation = await controller.execute(
    command(
      'PrepareCandidateEvaluation',
      {
        taskId: task.id,
        candidateId: candidate.id,
        checkRecipeId: 'node-tests-v1',
        reviewer: {
          profileId: context.reviewerProfile.facts.id,
          methodId: 'keep-it-simple',
          cycles: 1,
        },
        creditPolicy: 'existing-credits',
        consent: 'explicit',
        grants: [
          { action: 'run-check', target: 'node --test' },
          { action: 'run-review', target: 'keep-it-simple/cycle-1' },
        ].map((grant) => ({
          ...grant,
          taskId: task.id,
          revoked: false,
          usesRemaining: 1,
          expiresAt: new Date(Date.parse(clock.now()) + 86400000).toISOString(),
        })),
      },
      revision(),
    ),
    'local-owner',
  );
  const preparation = ArtifactSchema.parse(evaluation.entity);
  const evaluationPayload = {
    taskId: task.id,
    candidateId: candidate.id,
    preparationId: preparation.id,
  };
  for (const action of ['StartCandidateEvaluation', 'StartCandidateReview']) {
    const finished = Promise.withResolvers<void>();
    const off = context.observe(controller, (event) => {
      if (
        event.type === 'task.updated' &&
        ['stopped', 'ready', 'failed', 'unknown'].includes(event.payload.state)
      )
        finished.resolve();
    });
    assert.equal(
      (await controller.execute(command(action, evaluationPayload, revision()), 'local-owner'))
        .outcome,
      'applied',
    );
    await context.wait(`native acceptance ${action}`, finished.promise);
    off();
  }
  const checked = controller.snapshot();
  assert.equal(checked.tasks[0].state, 'ready');
  assert.equal(checked.candidateEvaluations[0]?.localAcceptance.available, true);
  assert.equal(context.submissions(), 3);
  const destinationRef = 'refs/heads/feat/native-checked';
  const payload = { taskId: task.id, candidateId: candidate.id, destinationRef };
  const evidence = checked.evidence.find((value) => value.review);
  assert(evidence?.review && !evidence.review.job.scripted);
  const job = evidence.review.job;
  const reviewPhases = controller.store.nativeProcesses(job.attemptId);
  const reviewRoute = checked.routes.find((route) => route.id === job.routeId);
  assert(reviewRoute);
  // A reviewer-family mutation must leave the frozen writer routes intact.
  assert.notEqual(reviewRoute.id, run.roles[0].routeId);
  assert.notEqual(reviewRoute.id, successor.route_id);
  const quiescentAt = reviewPhases[2]?.quiescent_at;
  assert(quiescentAt);
  const check = checked.evidence.find((value) => !value.review);
  assert(check);
  const resultKey = `native-review-result:${job.attemptId}`;
  const resultReceipt = controller.store.receipt(resultKey);
  assert(resultReceipt);
  const artifactFiles = new ArtifactFiles(join(controller.home, 'artifacts'));
  const metadata = JSON.parse(
    artifactFiles.read((resultReceipt.result.entity as Artifact).hash).toString('utf8'),
  );
  const changed = { ...metadata, review: { ...metadata.review, bindingHash: '0'.repeat(64) } };
  const altered = {
    ...artifactFiles.publish(Buffer.from(canonicalJson(changed))),
    id: context.id('art'),
    mediaType: 'application/vnd.crewkite.native+json',
  };
  const scratchTarget = join(successor.scratch_path, 'net.mjs');
  const targetBytes = readFileSync(scratchTarget);
  for (const boundary of ['candidate', 'check', 'job', 'result', 'phase', 'review-family']) {
    controller.store.transaction(() => {
      if (boundary === 'check')
        controller.store.db
          .prepare("UPDATE evidence SET body=? WHERE candidate_id=? AND kind='check'")
          .run(canonicalJson({ ...check, definitionHash: '0'.repeat(64) }), candidate.id);
      if (boundary === 'job')
        controller.store.db
          .prepare('UPDATE review_jobs SET body=? WHERE attempt_id=?')
          .run(canonicalJson({ ...job, generation: job.generation + 1 }), job.attemptId);
      if (boundary === 'result') {
        controller.store.put('artifact', altered.id, 0, altered);
        controller.store.db
          .prepare('UPDATE receipts SET request_hash=?,result=? WHERE command_key=?')
          .run(altered.hash, canonicalJson({ outcome: 'applied', entity: altered }), resultKey);
      }
      if (boundary === 'phase')
        controller.store.db
          .prepare(
            "UPDATE native_processes SET state='owned',quiescent_at=NULL WHERE attempt_id=? AND sequence=2",
          )
          .run(job.attemptId);
      if (boundary === 'review-family') {
        controller.store.put('route', reviewRoute.id, 0, { ...reviewRoute, family: 'anthropic' });
        controller.store.db
          .prepare('DELETE FROM native_processes WHERE attempt_id=? AND sequence=2')
          .run(job.attemptId);
        controller.store.db
          .prepare(
            "UPDATE native_processes SET phase=CASE sequence WHEN 0 THEN 'auth-status' ELSE 'native-task' END WHERE attempt_id=?",
          )
          .run(job.attemptId);
      }
    });
    if (boundary === 'candidate') appendFileSync(scratchTarget, '\n');
    if (boundary === 'review-family') {
      const phases = controller.store.nativeProcesses(job.attemptId);
      assert.deepEqual(
        phases.map((phase) => phase.phase),
        ['auth-status', 'native-task'],
      );
      assert(phases.every((phase) => phase.state === 'quiescent'));
    }

    assert.equal(
      controller.snapshot().candidateEvaluations[0]?.localAcceptance.available,
      false,
      boundary,
    );
    assert.equal(
      (await controller.execute(command('AcceptCandidate', payload, revision()), 'local-owner'))
        .outcome,
      'blocked',
      boundary,
    );
    assert.equal(controller.snapshot().approvals.length, 0);
    writeFileSync(scratchTarget, targetBytes);
    controller.store.transaction(() => {
      if (boundary === 'check')
        controller.store.db
          .prepare("UPDATE evidence SET body=? WHERE candidate_id=? AND kind='check'")
          .run(canonicalJson(check), candidate.id);
      if (boundary === 'job')
        controller.store.db
          .prepare('UPDATE review_jobs SET body=? WHERE attempt_id=?')
          .run(canonicalJson(job), job.attemptId);
      if (boundary === 'result')
        controller.store.db
          .prepare('UPDATE receipts SET request_hash=?,result=? WHERE command_key=?')
          .run(resultReceipt.hash, canonicalJson(resultReceipt.result), resultKey);
      if (boundary === 'phase')
        controller.store.db
          .prepare(
            "UPDATE native_processes SET state='quiescent',quiescent_at=? WHERE attempt_id=? AND sequence=2",
          )
          .run(quiescentAt, job.attemptId);
      if (boundary === 'review-family') {
        controller.store.put('route', reviewRoute.id, 0, reviewRoute);
        controller.store.db
          .prepare('DELETE FROM native_processes WHERE attempt_id=?')
          .run(job.attemptId);
        for (const phase of reviewPhases)
          controller.store.db
            .prepare(
              'INSERT INTO native_processes(attempt_id,sequence,phase,state,pid,process_group,intent_at,quiescent_at) VALUES (?,?,?,?,?,?,?,?)',
            )
            .run(
              phase.attempt_id,
              phase.sequence,
              phase.phase,
              phase.state,
              phase.pid,
              phase.process_group,
              phase.intent_at,
              phase.quiescent_at,
            );
      }
    });
  }
  clock.advance(86400001);
  context.fixtureProfile.facts.available = false;
  context.fixtureProfile.facts.reason = 'client-unavailable';
  assert.equal(controller.snapshot().candidateEvaluations[0]?.localAcceptance.available, true);
  const ask = command('AcceptCandidate', payload, revision());
  const asked = await controller.execute(ask, 'local-owner');
  const approval = controller.snapshot().approvals.find((value) => value.status === 'pending');
  assert(approval);
  assert.equal(approval.action, 'accept-candidate');
  assert.equal(approval.target, destinationRef);
  assert.equal(approval.attemptId, successor.attempt_id);
  assert.equal(
    controller.snapshot().candidateEvaluations[0]?.localAcceptance.reason,
    'approval-pending',
  );
  const sourceTarget = join(source.directory, 'net.mjs');
  const sourceBytes = readFileSync(sourceTarget);
  appendFileSync(sourceTarget, '\n');
  assert.equal(
    (
      await controller.execute(
        command(
          'ResolveApproval',
          { binding: binding(approval), decision: 'approved' },
          asked.revision,
        ),
        'local-owner',
      )
    ).outcome,
    'blocked',
  );
  assert.equal(
    controller.snapshot().approvals.find((value) => value.approvalId === approval.approvalId)
      ?.status,
    'pending',
  );
  writeFileSync(sourceTarget, sourceBytes);
  const accept = command(
    'ResolveApproval',
    { binding: binding(approval), decision: 'approved' },
    revision(),
  );
  assert.equal((await controller.execute(accept, 'local-owner')).outcome, 'applied');
  assert.equal((await controller.execute(accept, 'local-owner')).outcome, 'already-applied');
  assert.equal(controller.snapshot().tasks[0].state, 'accepted');
  const commit = git(source.directory, ['rev-parse', destinationRef]).toString().trim();
  assert.equal(
    git(source.directory, ['rev-parse', `${commit}^`])
      .toString()
      .trim(),
    run.source.base,
  );
  assert.deepEqual(git(source.directory, ['show', `${destinationRef}:net.mjs`]), targetBytes);
  assert.equal(
    controller.store.db.prepare('SELECT COUNT(*) AS count FROM publications').get()?.count,
    1,
  );
  for (const boundary of ['changed-source', 'missing-ref', 'conflict', 'existing-ref']) {
    if (
      (boundary === 'changed-source' || boundary === 'missing-ref') &&
      refValue(source.directory, destinationRef) !== null
    )
      git(source.directory, ['update-ref', '-d', destinationRef, commit]);
    if (boundary === 'changed-source' || boundary === 'existing-ref')
      appendFileSync(sourceTarget, '\n');
    if (boundary === 'conflict')
      git(source.directory, ['update-ref', destinationRef, run.source.base, commit]);
    controller.store.transaction(() =>
      controller.store.db
        .prepare("UPDATE publications SET state='prepared' WHERE candidate_id=?")
        .run(candidate.id),
    );
    controller = await context.restart();
    const observed = refValue(source.directory, destinationRef);
    if (boundary === 'changed-source') {
      assert.equal(observed, null);
      writeFileSync(sourceTarget, sourceBytes);
    } else if (boundary === 'conflict') {
      assert.equal(observed, run.source.base);
      git(source.directory, ['update-ref', destinationRef, commit, run.source.base]);
    } else assert.equal(observed, commit);
    if (boundary === 'existing-ref') writeFileSync(sourceTarget, sourceBytes);
    assert.equal(context.submissions(), 3);
    assert.equal(controller.snapshot().attempts.length, 4);
  }
  assert.deepEqual(inspectSource(task.projectId, source.directory), original);
  assert.deepEqual(readFileSync(join(source.directory, '.git', 'index')), index);
  for (const file of sentinels) {
    assert.deepEqual(readFileSync(join(source.directory, file.path)), file.bytes);
    assert.equal(lstatSync(join(source.directory, file.path)).mode & 0o777, file.mode);
  }
}

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
    assert(check.review && 'writerAttemptId' in check.review.job);
    assert.equal(check.review.job.writerAttemptId, writer.attempt_id);
    assert.equal(check.review.job.writerRouteId, writer.route_id);
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
    assert('writerAttemptId' in check.review.job);
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

function taskRevision(controller: Controller, taskId: string): number {
  return TaskSchema.parse(controller.store.get('task', taskId)).revision;
}

async function nativeRows<T>(rows: readonly T[], run: (row: T) => Promise<void>) {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const work = async () => {
    try {
      while (!failed && next < rows.length) await run(rows[next++]);
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  };
  await Promise.allSettled([work(), work()]);
  if (failed) throw failure;
}

function nativeCandidate(controller: Controller) {
  const candidate = Promise.withResolvers<void>();
  let settled = false;
  const off = controller.subscribe((event) => {
    if (event.type === 'candidate.sealed') {
      settled = true;
      off();
      candidate.resolve();
    }
    if (
      event.type === 'task.updated' &&
      ['stopped', 'interrupted', 'failed', 'unknown'].includes(event.payload.state)
    ) {
      // Successful capture follows the stopped event in the same call stack.
      queueMicrotask(() => {
        if (settled) return;
        settled = true;
        off();
        candidate.reject(
          new Error(`Native fixture ended ${event.payload.state} without a sealed candidate.`),
        );
      });
    }
  });
  return candidate.promise;
}

async function localControllerFixture(
  t: TestContext,
  initialMode = 'completed',
  authMode: 'token' | 'none' = 'token',
) {
  let mode = initialMode;
  let context: Awaited<ReturnType<typeof setup>>;
  let reopened: Controller | undefined;
  let submissions = 0;
  const submitted = Promise.withResolvers<void>();
  const children: Promise<void>[] = [];
  const runtime = { connectorId: 'local-sdk-v1', version: 'fixture-runtime', build: 1 };
  const identity = {
    modelKey: 'fixture-model',
    displayName: 'Local fixture',
    format: 'gguf',
    sizeBytes: 1234,
    quantization: null,
    selectedVariant: null,
    metadataHash: hashCanonical({ model: 'fixture-model', path: 'owned-fixture' }),
  };
  const choice = {
    selectionId: hashCanonical({ runtime, metadataHash: identity.metadataHash }),
    identity,
    instanceReference: 'fixture-instance',
    contextLength: 8192,
    state: 'loaded-eligible',
    reasons: [],
    qualification: 'unqualified',
  };
  const observed = {
    version: 1,
    runtime,
    models: [choice],
    residentLlms: 1,
    embeddingInstances: 0,
  };
  const observation = { ...observed, observationHash: hashCanonical(observed) };
  const secret = 'private-controller-local-canary';
  const inputPeer = `
const fs=require('node:fs'); const mode=process.argv[1]; let pending=Buffer.alloc(0);
process.stdin.on('data',part=>{pending=Buffer.concat([pending,part]);if(pending.length<4||pending.length<4+pending.readUInt32BE(0))return;
const prompt=JSON.parse(pending.subarray(4,4+pending.readUInt32BE(0)));pending=Buffer.alloc(0);
const body=Buffer.from(JSON.stringify({binding:prompt.binding,outcome:'submitted',secret:${JSON.stringify(secret)}}));const header=Buffer.alloc(4);header.writeUInt32BE(body.length);
const finish=()=>{fs.writeSync(3,Buffer.concat([header,body]));process.stdin.destroy();};if(mode==='input-hold')process.stdin.once('end',finish);else finish();});`;
  const clientPeer = `
const {createInterface}=require('node:readline');const mode=process.argv[1];const observation=${JSON.stringify(observation)};
let plan;const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const finish=value=>{emit(value);process.stdin.destroy();};
createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);
if(!plan){plan=value;if(plan.kind==='discovery'){finish({type:'discovery',terminal:mode==='discovery-failed'?{kind:'unavailable',binding:plan.binding,reason:'transport'}:{kind:'observed',binding:plan.binding,observation}});return;}emit({type:'ready',binding:plan.binding});return;}
const content=process.argv[2];const proof={stopReason:value==='stop'?'userStopped':'eosFound',promptTokens:1,predictedTokens:1,renderedPromptTokens:1,outputBytes:Buffer.byteLength(content),contextLength:8192,maxTokens:2048,contextOverflowPolicy:'stopAtLimit',draftModel:''};
if(value==='submit'&&mode==='hold')return;
if(value==='submit'&&mode==='client-loss'){process.stdin.destroy();return;}
if(value==='submit'&&mode==='unknown'){finish({type:'terminal',terminal:{kind:'unknown',binding:plan.binding,reason:'ownership'}});return;}
if(value==='submit'&&mode==='configuration-unknown'){finish({type:'terminal',terminal:{kind:'unknown',binding:plan.binding,reason:'configuration',detail:{version:1,stage:'terminal',check:'draft-disabled',status:'missing'}}});return;}
if(value==='submit'&&mode==='configuration-failed'){finish({type:'terminal',terminal:{kind:'failed',binding:plan.binding,reason:'configuration',proof,detail:{version:1,stage:'terminal',check:'draft-disabled',status:'missing'}}});return;}
if(value==='stop'){finish({type:'terminal',terminal:{kind:'stopped',binding:plan.binding,proof}});return;}
if(value==='submit')finish({type:'terminal',terminal:{kind:'completed',binding:plan.binding,proof,proposal:{version:1,attemptId:plan.binding.attemptId,path:plan.binding.path,baseHash:plan.binding.baseHash,content}}});});`;
  const spawnClient = ((
    executable: string,
    _args: readonly string[],
    settings: SpawnOptionsWithoutStdio,
  ) => {
    let content = 'export function netMinor() { return 0; }\n';
    if (mode === 'checked') {
      const solution = join(context.directory, 'local-solution');
      mkdirSync(solution, { recursive: true });
      writeFileSync(join(solution, 'net.mjs'), '');
      writeChallengeSolution(solution);
      content = readFileSync(join(solution, 'net.mjs'), 'utf8');
    }
    const child = spawn(executable, ['-e', clientPeer, mode, content], settings);
    children.push(new Promise<void>((done) => child.once('close', () => done())));
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: string | Uint8Array) => {
      for (const line of Buffer.from(chunk).toString().trim().split('\n')) {
        if (!line) continue;
        const value = JSON.parse(line);
        if (value === 'submit') {
          submissions++;
          submitted.resolve();
          const intent = context.controller.store.intents().at(-1);
          assert(intent);
          assert(context.controller.store.receipt(`native-submission:${intent.attempt_id}`));
        } else if (typeof value === 'object') {
          if (authMode === 'none') {
            assert.equal(value.authMode, 'none');
            assert.equal('token' in value, false);
          }
          const local = context.controller.store.localControl() as {
            operation?: { state: string };
          };
          if (value.kind === 'discovery') assert.equal(local.operation?.state, 'owned');
          else
            assert.equal(
              context.controller.store.nativeProcesses(value.binding.attemptId)[0]?.state,
              'owned',
            );
        }
      }
      return write(chunk);
    }) as typeof child.stdin.write;
    return child;
  }) as typeof spawnProcess;
  const reviewer = {
    ...unavailableNativeProfile(),
    facts: {
      ...unavailableNativeProfile().facts,
      available: true,
      reason: 'available',
      model: fixtureModel,
      clientVersion: process.version,
    },
    client: { executable: process.execPath, sha256: fixtureClientHash, version: process.version },
    environment: { ...process.env },
    locationHash: '1'.repeat(64),
  } satisfies NativeProfileResolution;
  const options: Partial<ControllerOptions> = {
    ...(initialMode === 'checked'
      ? ({
          identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
          nativeProfile: () => reviewer,
          nativeSpawn: (executable, args, settings) => {
            const activeController = reopened ?? context.controller;
            const phase =
              args.at(-1) === 'list'
                ? 'features'
                : activeController.store
                      .intents()
                      .flatMap((intent) =>
                        activeController.store.nativeProcesses(intent.attempt_id),
                      )
                      .filter((value) => value.state === 'intent')
                      .at(-1)?.phase === 'metadata-preparation'
                  ? 'prepare'
                  : 'task';
            const script = fixture
              .replace(
                'const path = message.params.outputSchema.properties.path.const;',
                'const path = message.params.outputSchema.properties.path?.const;',
              )
              .replace(
                'const edit = {version:1,attemptId:message.params.outputSchema.properties.attemptId.const,path,baseHash:message.params.outputSchema.properties.baseHash.const,content:content(path)};',
                "const edit = {version:1,bindingHash:message.params.outputSchema.properties.bindingHash.const,methodId:message.params.outputSchema.properties.methodId.const,cycle:1,outcome:'passed',findings:[],summary:'The Local replacement meets its bounded criteria.'};",
              );
            const child = spawn(executable, ['-e', script, 'success', phase], settings);
            children.push(new Promise<void>((done) => child.once('close', () => done())));
            return child;
          },
        } satisfies Partial<ControllerOptions>)
      : {}),
    localInputHelper:
      authMode === 'none'
        ? undefined
        : {
            root: resolve('internal'),
            sha256: 'a'.repeat(64),
            sourceHash: 'b'.repeat(64),
            target: 'darwin-arm64',
          },
    localInput: {
      platform: 'darwin',
      arch: 'arm64',
      verifyHelper: () => process.execPath,
      launch: (executable, settings) => {
        assert.equal(authMode, 'token', 'No-authentication mode must not open secure input.');
        assert.equal(
          (context.controller.store.localControl() as { operation?: { state: string } }).operation
            ?.state,
          'intent',
        );
        const child = spawn(executable, ['-e', inputPeer, mode], settings);
        children.push(new Promise<void>((done) => child.once('close', () => done())));
        return {
          group: child.pid ?? 0,
          input: child.stdin,
          output: child.stdio[3],
          onSpawn: (handler) => {
            child.once('spawn', handler);
          },
          onError: (handler) => {
            child.once('error', handler);
          },
          onClose: (handler) => {
            child.once('close', handler);
          },
        };
      },
    },
    localDiscovery: { spawn: spawnClient },
    localWriter: { spawn: spawnClient },
    afterIntent: () => {
      if (mode === 'intent-restart') throw Error('Local intent interrupted.');
    },
  };
  context = await setup(t, options, async (controller) => {
    await reopened?.close();
    await controller.close();
    await Promise.all(children);
  });
  const { controller, command, fixtures } = context;
  const setupState = () => controller.snapshot().localSetup;
  const local = (name: string, payload: object = {}) =>
    controller.execute(command(name, payload, setupState()?.revision ?? 0), 'local-owner');
  const operationDone = async () => {
    const operation = (controller as unknown as { localOperation?: { done: Promise<void> } })
      .localOperation;
    assert(operation);
    await nativeWait('Local metadata operation', operation.done);
  };
  await local('ConfigureLocal', {
    endpoint: 'ws://127.0.0.1:12345',
    ...(authMode === 'none' ? { authMode } : {}),
  });
  const connectionRevision = setupState()?.connectionRevision;
  const begin = command(
    'BeginLocalConnectionInput',
    { consent: 'explicit' },
    setupState()?.revision,
  );
  assert.equal((await controller.execute(begin, 'local-owner')).outcome, 'applied');
  assert.equal(setupState()?.operation?.kind, authMode === 'token' ? 'input' : undefined);
  assert.equal((await controller.execute(begin, 'local-owner')).outcome, 'already-applied');
  if (authMode === 'token') await operationDone();
  assert.equal(setupState()?.secretConfigured, authMode === 'token');
  assert.equal(setupState()?.connected, true);
  await local('RefreshLocalModels', { consent: 'explicit' });
  assert.equal(setupState()?.operation?.kind, 'discovery');
  await operationDone();
  assert.equal(setupState()?.connectionRevision, connectionRevision);
  assert.equal(setupState()?.secretConfigured, authMode === 'token');
  assert.equal(setupState()?.observation?.observationHash, observation.observationHash);
  assert.equal(
    (
      await local('SelectLocalModel', {
        selectionId: choice.selectionId,
        observationHash: 'f'.repeat(64),
      })
    ).reason,
    'local-selection-stale',
  );
  await local('SelectLocalModel', {
    selectionId: choice.selectionId,
    observationHash: observation.observationHash,
  });
  assert.equal(setupState()?.reason, 'qualification-pending');
  assert.equal(setupState()?.connectionRevision, connectionRevision);
  const task = TaskSchema.parse((await controller.execute(context.draft, 'local-owner')).entity);
  const policy = {
    ...fixtures.policy,
    authority: 'guided',
    quality: 'quick',
    methods: [{ id: 'keep-it-simple', cycles: 1, reviewerRole: 'advisor' }],
    limits: { attempts: 3, minutes: 5, concurrency: 1 },
    reserves: [],
    unknownUsage: { rule: 'fixed-allowance', allowance: { launches: 3, minutes: 5 } },
    effects: fixtures.policy.effects.map((grant) => ({
      ...grant,
      taskId: task.id,
      target: grant.action === 'export-patch' ? task.id : grant.target,
    })),
  };
  const revision = () => controller.store.get<{ revision: number }>('task', task.id)?.revision;
  const prepare = () =>
    controller.execute(
      command(
        'PrepareNativeRun',
        {
          taskId: task.id,
          profileId: 'local-file-v1',
          targetPath: 'net.mjs',
          policy,
          consent: 'explicit',
        },
        revision(),
      ),
      'local-owner',
    );
  const prepared = await prepare();
  assert.equal(prepared.outcome, 'applied', JSON.stringify(prepared));
  const run = RunSchema.parse(prepared.entity);
  const terminal = Promise.withResolvers<void>();
  const off = controller.subscribe((event) => {
    if (
      event.type === 'task.updated' &&
      event.taskId === task.id &&
      ['stopped', 'unknown'].includes(event.payload.state)
    )
      terminal.resolve();
  });
  t.after(off);
  const start = command('StartRun', { taskId: task.id, runId: run.id }, revision());
  const started = () => controller.execute(start, 'local-owner');
  const reopen = async () => {
    await controller.close();
    reopened = new Controller({
      ...options,
      home: controller.home,
      now: context.clock.now,
      id: context.id,
    });
    return reopened;
  };
  return {
    ...context,
    options,
    local,
    operationDone,
    setupState,
    task,
    run,
    start,
    started,
    terminal: terminal.promise,
    prepare,
    mode: (value: string) => {
      mode = value;
    },
    submissions: () => submissions,
    submitted: submitted.promise,
    reopen,
    secret,
  };
}

test('an appointed native proposal is retained and applied once after every phase stops', async (t) => {
  const local = await nativeSetup(t, 'success', {
    nativeProfiles: () => [
      {
        facts: LocalNativeProfileSchema.parse({
          id: 'local-file-v1',
          family: 'local',
          displayName: 'Local fixture',
          sdkVersion: '2.1.0',
          model: 'local-fixture',
          modelBinding: {
            setupHash: 'a'.repeat(64),
            modelKey: 'local-fixture',
            instanceReference: 'local-instance',
            modelSizeBytes: 1,
            artifactSha256: 'b'.repeat(64),
            quantization: 'Q4_K_M',
          },
          billing: 'local',
          contextLength: 8192,
          maximumOutputTokens: 2048,
          qualifiedAt: null,
          maximumTaskMs: 300000,
          maximumFileBytes: 65536,
          maximumSubmissions: 1,
          available: true,
          reason: 'qualification-pending',
        }),
      },
    ],
  });
  const beforeLocal = local.controller.snapshot();
  const refusedLocal = await local.controller.execute(
    local.command(
      'PrepareNativeRun',
      {
        taskId: local.task.id,
        profileId: 'local-file-v1',
        targetPath: 'net.mjs',
        policy: local.appointment.policy,
        consent: 'explicit',
      },
      local.task.revision,
    ),
    'local-owner',
  );
  assert.equal(refusedLocal.outcome, 'blocked');
  assert.equal(refusedLocal.reason, 'local-model-unavailable');
  assert.deepEqual(local.controller.snapshot(), beforeLocal);
  assert.equal(local.controller.store.intents().length, 0);
  const withoutToken = await localControllerFixture(t, 'checked', 'none');
  assert.equal((await withoutToken.started()).outcome, 'applied');
  await nativeWait('Local no-authentication completed writer', withoutToken.terminal);
  assert.equal(withoutToken.submissions(), 1);
  assert.equal(
    withoutToken.controller.snapshot().tasks.find((value) => value.id === withoutToken.task.id)
      ?.state,
    'stopped',
  );
  const noneCandidate = withoutToken.controller
    .snapshot()
    .candidates.find((value) => value.taskId === withoutToken.task.id);
  assert(noneCandidate);
  const noneEvaluation = await withoutToken.controller.execute(
    withoutToken.command(
      'PrepareCandidateEvaluation',
      {
        taskId: withoutToken.task.id,
        candidateId: noneCandidate.id,
        checkRecipeId: 'node-tests-v1',
        reviewer: { profileId: 'openai-file-v1', methodId: 'keep-it-simple', cycles: 1 },
        consent: 'explicit',
        grants: [
          { action: 'run-check', target: 'node --test' },
          { action: 'run-review', target: 'keep-it-simple/cycle-1' },
        ].map((grant) => ({
          ...grant,
          taskId: withoutToken.task.id,
          revoked: false,
          usesRemaining: 1,
          expiresAt: new Date(Date.parse(withoutToken.clock.now()) + 86400000).toISOString(),
        })),
      },
      taskRevision(withoutToken.controller, withoutToken.task.id),
    ),
    'local-owner',
  );
  assert.equal(noneEvaluation.outcome, 'applied', JSON.stringify(noneEvaluation));
  withoutToken.mode('discovery-failed');
  await withoutToken.local('RefreshLocalModels', { consent: 'explicit' });
  await withoutToken.operationDone();
  assert.equal(withoutToken.setupState()?.connected, false);
  assert.equal(withoutToken.setupState()?.reason, 'connection-unavailable');
  assert.equal(withoutToken.setupState()?.secretConfigured, false);
  await withoutToken.local('BeginLocalConnectionInput', { consent: 'explicit' });
  assert.equal(withoutToken.setupState()?.connected, true);
  assert.equal(withoutToken.setupState()?.operation, null);
  const noneReopened = await withoutToken.reopen();
  assert.equal(noneReopened.snapshot().localSetup?.connected, true);
  assert.equal(noneReopened.snapshot().localSetup?.secretConfigured, false);
  const noneRevision = noneReopened.snapshot().localSetup?.connectionRevision;
  const noneHash = noneReopened.snapshot().localSetup?.connectionHash;
  const changedMode = await noneReopened.execute(
    withoutToken.command(
      'ConfigureLocal',
      { endpoint: 'ws://127.0.0.1:12345', authMode: 'token' },
      noneReopened.snapshot().localSetup?.revision,
    ),
    'local-owner',
  );
  assert.equal(changedMode.outcome, 'applied');
  assert.equal(noneReopened.snapshot().localSetup?.connected, false);
  assert.equal(noneReopened.snapshot().localSetup?.authMode, 'token');
  assert.equal(
    noneReopened.snapshot().localSetup?.connectionRevision,
    (noneRevision as number) + 1,
  );
  assert.notEqual(noneReopened.snapshot().localSetup?.connectionHash, noneHash);
  assert.equal(noneReopened.snapshot().localSetup?.selection, null);
  const connectedLocal = await localControllerFixture(t, 'checked');
  assert.equal((await connectedLocal.started()).outcome, 'applied');
  connectedLocal.clock.advance(60000);
  await nativeWait('Local completed writer', connectedLocal.terminal);
  assert.equal(connectedLocal.submissions(), 1);
  assert.equal(
    connectedLocal.controller.snapshot().tasks.find((task) => task.id === connectedLocal.task.id)
      ?.state,
    'stopped',
  );
  const localCandidate = connectedLocal.controller
    .snapshot()
    .candidates.find((candidate) => candidate.taskId === connectedLocal.task.id);
  assert(localCandidate);
  assert.equal(connectedLocal.controller.snapshot().evidence.length, 0);
  const exportedLocal = await connectedLocal.controller.execute(
    connectedLocal.command(
      'ExportPatch',
      {
        taskId: connectedLocal.task.id,
        candidateId: localCandidate.id,
      },
      connectedLocal.controller.store.get<{ revision: number }>('task', connectedLocal.task.id)
        ?.revision,
    ),
    'local-owner',
  );
  assert.equal(exportedLocal.outcome, 'applied');
  ArtifactSchema.parse(exportedLocal.entity);
  assert.equal(
    (await connectedLocal.controller.execute(connectedLocal.start, 'local-owner')).outcome,
    'already-applied',
  );
  const originalLocalRun = structuredClone(
    connectedLocal.controller.store.get('run', connectedLocal.run.id),
  );
  const beforeLocalPlanning = structuredClone(connectedLocal.controller.snapshot());
  const plannedAfterLocal = await connectedLocal.controller.execute(
    connectedLocal.command(
      'ConfigureTaskConversation',
      {
        taskId: connectedLocal.task.id,
        planning: {
          role: 'lead',
          profileId: 'openai-file-v1',
          creditPolicy: 'ordinary',
          limits: { attempts: 3, minutes: 5, concurrency: 1 },
          consent: 'explicit',
        },
      },
      connectedLocal.controller.store.get<{ revision: number }>('task', connectedLocal.task.id)
        ?.revision,
    ),
    'local-owner',
  );
  assert.equal(plannedAfterLocal.outcome, 'blocked');
  assert.equal(plannedAfterLocal.reason, 'task-not-discussing');
  assert.deepEqual(connectedLocal.controller.snapshot(), beforeLocalPlanning);
  const allowance = await connectedLocal.controller.execute(
    connectedLocal.command('GetTaskConversationState', {
      taskId: connectedLocal.task.id,
    }),
    'local-owner',
  );
  assert.equal(allowance.data?.kind, 'conversation-state');
  if (allowance.data?.kind === 'conversation-state') {
    assert.equal(allowance.data.state.purpose, 'execution');
    assert.equal(allowance.data.state.budget, null);
  }
  assert.deepEqual(
    connectedLocal.controller.store.get('run', connectedLocal.run.id),
    originalLocalRun,
  );
  const retainedLocal = await connectedLocal.reopen();
  assert.equal(retainedLocal.snapshot().localSetup?.secretConfigured, false);
  assert.equal(retainedLocal.snapshot().localSetup?.generation, 'idle');
  assert.equal(
    retainedLocal.snapshot().candidates.find((candidate) => candidate.id === localCandidate.id)
      ?.hash,
    localCandidate.hash,
  );
  assert.equal(connectedLocal.submissions(), 1);
  const localRevision = () => taskRevision(retainedLocal, connectedLocal.task.id);
  const localSend = (name: string, payload: object) =>
    retainedLocal.execute(connectedLocal.command(name, payload, localRevision()), 'local-owner');
  const localPayload = {
    taskId: connectedLocal.task.id,
    candidateId: localCandidate.id,
    checkRecipeId: 'node-tests-v1',
    reviewer: { profileId: 'openai-file-v1', methodId: 'keep-it-simple', cycles: 1 },
    consent: 'explicit',
    grants: [
      { action: 'run-check', target: 'node --test' },
      { action: 'run-review', target: 'keep-it-simple/cycle-1' },
    ].map((grant) => ({
      ...grant,
      taskId: connectedLocal.task.id,
      revoked: false,
      usesRemaining: 1,
      expiresAt: new Date(Date.parse(connectedLocal.clock.now()) + 86400000).toISOString(),
    })),
  };
  const localIntent = retainedLocal.store
    .intents()
    .find((intent) => intent.run_id === connectedLocal.run.id);
  assert(localIntent);
  const terminalReceipt = retainedLocal.store.receipt(`local-terminal:${localIntent.attempt_id}`);
  assert(terminalReceipt);
  const terminalArtifact = ArtifactSchema.parse(terminalReceipt.result.entity);
  const files = new ArtifactFiles(join(retainedLocal.home, 'artifacts'));
  const terminalBytes = files.read(terminalArtifact.hash);
  const terminalProof = JSON.parse(terminalBytes.toString());
  for (const change of [
    { known: false },
    { terminal: { ...terminalProof.terminal, kind: 'unknown', reason: 'ownership' } },
    { bindingHash: '0'.repeat(64) },
    {
      terminal: {
        ...terminalProof.terminal,
        binding: { ...terminalProof.terminal.binding, generation: localIntent.generation + 1 },
      },
    },
  ]) {
    const altered = {
      id: connectedLocal.id('art'),
      ...files.publish(Buffer.from(canonicalJson({ ...terminalProof, ...change }))),
      mediaType: 'application/vnd.crewkite.native+json',
    };
    retainedLocal.store.transaction(() => {
      retainedLocal.store.put('artifact', altered.id, 0, altered);
      retainedLocal.store.db
        .prepare('UPDATE receipts SET result=? WHERE command_key=?')
        .run(
          canonicalJson({ outcome: 'applied', entity: altered }),
          `local-terminal:${localIntent.attempt_id}`,
        );
    });
    assert.equal((await localSend('PrepareCandidateEvaluation', localPayload)).outcome, 'blocked');
  }
  retainedLocal.store.transaction(() =>
    retainedLocal.store.db
      .prepare('UPDATE receipts SET result=? WHERE command_key=?')
      .run(canonicalJson(terminalReceipt.result), `local-terminal:${localIntent.attempt_id}`),
  );
  writeFileSync(join(retainedLocal.home, 'artifacts', terminalArtifact.hash), '{}');
  assert.equal((await localSend('PrepareCandidateEvaluation', localPayload)).outcome, 'blocked');
  writeFileSync(join(retainedLocal.home, 'artifacts', terminalArtifact.hash), terminalBytes);
  const localScratch = join(retainedLocal.home, 'scratch', connectedLocal.run.id, 'net.mjs');
  const retainedLocalBytes = readFileSync(localScratch);
  appendFileSync(localScratch, '\n');
  assert.equal((await localSend('PrepareCandidateEvaluation', localPayload)).outcome, 'blocked');
  writeFileSync(localScratch, retainedLocalBytes);
  const originalTask = retainedLocal.store.get<Task>('task', connectedLocal.task.id);
  assert(originalTask);
  const otherRun = { ...connectedLocal.run, id: connectedLocal.id('run') };
  retainedLocal.store.transaction(() => {
    retainedLocal.store.put('run', otherRun.id, 0, otherRun);
    retainedLocal.store.put('task', originalTask.id, originalTask.revision, {
      ...originalTask,
      runId: otherRun.id,
    });
  });
  assert.equal((await localSend('PrepareCandidateEvaluation', localPayload)).outcome, 'blocked');
  retainedLocal.store.transaction(() =>
    retainedLocal.store.put('task', originalTask.id, originalTask.revision, originalTask),
  );
  const localEvaluation = await localSend('PrepareCandidateEvaluation', localPayload);
  assert.equal(localEvaluation.outcome, 'applied', JSON.stringify(localEvaluation));
  const localPreparation = ArtifactSchema.parse(localEvaluation.entity);
  const localStart = {
    taskId: connectedLocal.task.id,
    candidateId: localCandidate.id,
    preparationId: localPreparation.id,
  };
  for (const action of ['StartCandidateEvaluation', 'StartCandidateReview']) {
    const finished = Promise.withResolvers<void>();
    const off = retainedLocal.subscribe((event) => {
      if (
        event.type === 'task.updated' &&
        ['stopped', 'ready', 'failed', 'unknown'].includes(event.payload.state)
      )
        finished.resolve();
    });
    const started = await localSend(action, localStart);
    assert.equal(started.outcome, 'applied', JSON.stringify(started));
    await nativeWait(`Local ${action} completion`, finished.promise);
    off();
  }
  assert.equal(
    retainedLocal.snapshot().tasks.find((task) => task.id === originalTask.id)?.state,
    'ready',
  );
  assert.equal(retainedLocal.snapshot().candidateEvaluations[0]?.localAcceptance.available, true);
  assert.equal(
    retainedLocal.store.receipt(`native-completion:${localIntent.attempt_id}`),
    undefined,
  );
  assert.equal(connectedLocal.submissions(), 1);
  const destinationRef = 'refs/heads/feat/local-checked';
  const askedLocal = await localSend('AcceptCandidate', {
    taskId: originalTask.id,
    candidateId: localCandidate.id,
    destinationRef,
  });
  const localApproval = retainedLocal
    .snapshot()
    .approvals.find((value) => value.status === 'pending');
  assert(localApproval);
  assert.equal(localApproval.attemptId, localIntent.attempt_id);
  assert.equal(
    (await localSend('ResolveApproval', { binding: binding(localApproval), decision: 'approved' }))
      .outcome,
    'applied',
    JSON.stringify(askedLocal),
  );
  assert.equal(
    retainedLocal.snapshot().tasks.find((task) => task.id === originalTask.id)?.state,
    'accepted',
  );
  const localAccepted = git(connectedLocal.source.directory, ['rev-parse', destinationRef])
    .toString()
    .trim();
  assert.equal(
    git(connectedLocal.source.directory, ['rev-parse', `${localAccepted}^`])
      .toString()
      .trim(),
    connectedLocal.run.source.base,
  );
  assert.equal(
    git(connectedLocal.source.directory, ['show', `${destinationRef}:net.mjs`]).toString(),
    readFileSync(join(retainedLocal.home, 'scratch', connectedLocal.run.id, 'net.mjs'), 'utf8'),
  );
  const checkPermissionMode = async (permissionMode: string) => {
    const context = await nativeSetup(t, `google-${permissionMode}`);
    let controller = context.controller;
    const { task, command, appointment } = context;
    const payload = {
      taskId: task.id,
      profileId: context.fixtureProfile.facts.id,
      targetPath: 'net.mjs',
      policy: appointment.policy,
      consent: 'explicit',
      permissionMode,
      billingAttestation: {
        source: 'user-attested',
        subscriptionLoginConfirmed: true,
        paidExtraUsageDisabled: true,
      },
    };
    let prepared = await controller.execute(
      command('PrepareNativeRun', payload, task.revision),
      'local-owner',
    );
    assert.equal(prepared.outcome, 'applied');
    const before = controller.snapshot();
    assert.equal(
      (
        await controller.execute(
          command(
            'PrepareNativeRun',
            {
              ...payload,
              consent: 'saved',
              permissionMode: permissionMode === 'strict' ? 'request-review' : 'strict',
            },
            taskRevision(controller, task.id),
          ),
          'local-owner',
        )
      ).outcome,
      'blocked',
    );
    assert.deepEqual(controller.snapshot(), before);
    prepared = await controller.execute(
      command(
        'PrepareNativeRun',
        { ...payload, consent: 'saved' },
        taskRevision(controller, task.id),
      ),
      'local-owner',
    );
    assert.equal(prepared.outcome, 'applied');
    const run = RunSchema.parse(prepared.entity);
    assert.equal(
      controller.snapshot().routes.filter((route) => route.family === 'google' && !route.fake)
        .length,
      1,
    );
    controller = await context.restart();
    const retained = nativeCandidate(controller);
    const start = command(
      'StartRun',
      { taskId: task.id, runId: run.id },
      taskRevision(controller, task.id),
    );
    assert.equal((await controller.execute(start, 'local-owner')).outcome, 'applied');
    await context.wait(`Google ${permissionMode} candidate`, retained);
    assert.equal((await controller.execute(start, 'local-owner')).outcome, 'already-applied');
    assert.equal(context.submissions(), 1);
    assert.equal(context.children.length, 2);
    const attempt = controller.snapshot().attempts[0];
    assert(controller.store.nativePhasesComplete(attempt.id, 'google'));
    assert.equal(controller.store.nativePhasesComplete(attempt.id, 'anthropic'), false);
    assert.equal(
      controller.store.receipt(`native-application:${attempt.id}`)?.result.outcome,
      'applied',
    );
    const artifact = ArtifactSchema.parse(
      controller.store.receipt(`native-config:${attempt.id}`)?.result.entity,
    );
    const observed = JSON.parse(
      new ArtifactFiles(join(controller.home, 'artifacts')).read(artifact.hash).toString(),
    );
    assert.equal(observed.metadata.permissionMode, permissionMode);
    assert.equal(observed.metadata.creditFallback, 'disabled');
    assert.equal(observed.metadata.account, 'unknown');
    assert.equal(observed.metadata.billing, 'unknown');
    assert.equal(observed.billingAttestationHash, hashCanonical(payload.billingAttestation));
    assert.deepEqual(inspectSource(task.projectId, context.source.directory), run.source);
    controller = await context.restart();
    assert.equal(context.submissions(), 1);
    assert.equal(controller.snapshot().attempts.length, 1);
  };
  await nativeRows(
    ['request-review', 'strict', 'always-proceed', 'proceed-in-sandbox'],
    checkPermissionMode,
  );

  const retain = async ({
    consent,
    path,
    publicRun,
  }: {
    consent: 'explicit' | 'policy';
    path: string;
    publicRun: boolean;
  }) => {
    console.error(
      `Native fixture row: retained/${consent}/${path}/${publicRun ? 'public' : 'private'}`,
    );
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
    const committedTargets = committedFiles(source.directory, appointment.consent.sourceBase);
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
            committedTargets.find((file) => file.path === path)?.hash ??
            appointment.target.baseHash,
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
                taskRevision(controller, task.id),
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
            taskRevision(controller, task.id),
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
            taskRevision(controller, task.id),
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
            taskRevision(controller, task.id),
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
        taskRevision(controller, task.id),
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
    await context.wait('candidate', sealed);
    if (activeReplay) await context.wait('active replay', activeReplay);
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
    if (!publicRun && consent === 'explicit' && path === 'net.mjs') {
      const previous = controller.store.nativeProcesses(attempt.attempt_id);
      controller.store.db.exec('ALTER TABLE native_processes RENAME TO native_processes_saved');
      controller.store.db.exec(
        readFileSync(
          new URL('../../migrations/004-native-attempt-ownership.sql', import.meta.url),
          'utf8',
        ),
      );
      controller.store.db.exec(
        'INSERT INTO native_processes SELECT * FROM native_processes_saved; DROP TABLE native_processes_saved; DROP TABLE combined_ref_intents; DROP TABLE combined_dispatches; DROP TABLE combined_members; DROP TABLE combined_groups; DROP TABLE conversation_entries; DROP TABLE task_conversations; DROP TABLE run_purposes; DROP TABLE local_control; DROP TABLE google_metadata_operations; DROP TABLE google_usage_reader; DROP TABLE native_profile_bindings; DROP TABLE google_acp_setup; DROP INDEX events_task_cursor; PRAGMA user_version=4',
      );
      controller.store.applyMigrations(new URL('../../migrations/', import.meta.url).pathname);
      assert.deepEqual(controller.store.nativeProcesses(attempt.attempt_id), previous);
      assert.equal(
        controller.store.db.prepare('PRAGMA user_version').get()?.user_version,
        readdirSync(new URL('../../migrations/', import.meta.url)).filter((name) =>
          /^\d{3}-[a-z0-9-]+\.sql$/.test(name),
        ).length,
      );
      assert.equal('enabled' in controller.store.googleUsageReader(), false);
      assert.deepEqual(controller.store.googleMetadataOperations(), []);
      assert.equal(controller.store.googleAcpSetup().state, 'uninitialized');
    }

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
            taskRevision(controller, task.id),
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
              taskRevision(controller, task.id),
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
              taskRevision(controller, task.id),
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
        taskRevision(controller, task.id),
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
            command(name, payload, taskRevision(controller, task.id)),
            'local-owner',
          )
        ).reason,
        'native-pilot-retain-only',
      );
    }
    await nativeWait(
      'controller close',
      Promise.resolve().then(() => controller.close()),
      10_000,
    );
    console.error('Native fixture stage: ordinary reopen');
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
              taskRevision(reopened, task.id),
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
          taskRevision(reopened, task.id),
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
          taskRevision(reopened, task.id),
        ),
        'local-owner',
      );
      assert.equal(prepared.outcome, 'applied', JSON.stringify(prepared));
      const ordinary = RunSchema.parse(prepared.entity);
      const resealed = nativeCandidate(reopened);
      let stopped: Promise<unknown> | undefined;
      const off = context.observe(reopened, (event) => {
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
              taskRevision(reopened, task.id),
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
      await context.wait('ordinary candidate', resealed);
      if (stopped) await context.wait('ordinary stop', stopped);
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
              taskRevision(reopened, task.id),
            ),
            'local-owner',
          )
        ).reason,
        'candidate-not-current',
      );
    } finally {
      await nativeWait(
        'reopened close',
        Promise.resolve().then(() => reopened.close()),
        10_000,
      );
    }
  };
  await nativeRows(
    [
      { consent: 'explicit', path: 'net.mjs', publicRun: false },
      { consent: 'policy', path: 'net.mjs', publicRun: false },
      { consent: 'explicit', path: 'docs/providers.md', publicRun: false },
      { consent: 'policy', path: 'docs/案内.md', publicRun: false },
      { consent: 'explicit', path: 'docs/providers.md', publicRun: true },
      { consent: 'policy', path: 'docs/案内.md', publicRun: true },
    ] as const,
    retain,
  );

  const evaluate = async (scenario: string) => {
    const passedReview =
      scenario === 'checked' ||
      scenario === 'project-checked' ||
      scenario === 'repository-checked' ||
      scenario === 'anthropic-checked' ||
      scenario === 'google-checked';
    console.error(`Native fixture row: evaluation/${scenario}`);
    const inventoryEntered = Promise.withResolvers<void>();
    const inventoryRelease = Promise.withResolvers<void>();
    let inventoryCalls = 0;
    let inventorySignal: AbortSignal | undefined;
    const socketRoot =
      scenario === 'repository-checked'
        ? mkdtempSync(join(realpathSync(checkOwner()?.stateRoot ?? tmpdir()), 'ck-socket-'))
        : undefined;
    const context = await nativeSetup(
      t,
      scenario === 'anthropic-checked' ||
        scenario === 'google-checked' ||
        scenario === 'repository-checked'
        ? scenario
        : scenario === 'failed'
          ? 'success'
          : scenario === 'review-blocked'
            ? 'checked-blocked'
            : 'checked',
      scenario === 'repository-checked'
        ? {
            home: join(socketRoot as string, 'home'),
            googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
            prepareVerification: async (input) => {
              inventoryCalls++;
              inventorySignal = input.budget.signal;
              inventoryEntered.resolve();
              await inventoryRelease.promise;
              throw Error(
                input.budget.signal?.aborted
                  ? 'cancelled inventory'
                  : 'incomplete inventory fixture',
              );
            },
          }
        : {},
    );
    if (socketRoot)
      t.after(async () => {
        inventoryRelease.resolve();
        await context.controller.close();
        rmSync(socketRoot, { recursive: true, force: true });
      });
    let controller = context.controller;
    if (scenario === 'repository-checked') {
      context.appointment.policy.limits.minutes = 10;
      assert.equal(context.appointment.policy.unknownUsage.rule, 'fixed-allowance');
      if (context.appointment.policy.unknownUsage.rule === 'fixed-allowance')
        context.appointment.policy.unknownUsage.allowance.minutes = 10;
    }

    const { command, task, appointment, clock } = context;
    const retained = nativeCandidate(controller);
    if (passedReview) {
      if (scenario === 'repository-checked') {
        const payload = {
          taskId: task.id,
          profileId: context.fixtureProfile.facts.id,
          policy: appointment.policy,
          consent: 'explicit',
        };
        for (const change of [
          {
            policy: {
              ...appointment.policy,
              effects: appointment.policy.effects.filter(
                (grant) => grant.action !== 'run-native-tools',
              ),
            },
          },
          {
            policy: {
              ...appointment.policy,
              effects: appointment.policy.effects.map((grant) =>
                grant.action === 'run-native-tools' ? { ...grant, revoked: true } : grant,
              ),
            },
          },
          {
            policy: {
              ...appointment.policy,
              effects: appointment.policy.effects.map((grant) =>
                grant.action === 'run-native-tools'
                  ? { ...grant, target: 'another-project' }
                  : grant,
              ),
            },
          },
          { consent: 'saved' },
        ]) {
          const before = controller.snapshot();
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
          assert.equal(controller.store.intents().length, 0);
        }
      }
      const prepared = await controller.execute(
        command(
          'PrepareNativeRun',
          {
            taskId: task.id,
            profileId: context.fixtureProfile.facts.id,
            ...(scenario === 'anthropic-checked' || scenario === 'google-checked'
              ? {
                  billingAttestation: {
                    source: 'user-attested',
                    subscriptionLoginConfirmed: true,
                    paidExtraUsageDisabled: true,
                  },
                }
              : {}),
            ...(scenario === 'google-checked' ? { permissionMode: 'request-review' } : {}),
            ...(scenario === 'repository-checked' ? {} : { targetPath: 'net.mjs' }),
            policy: appointment.policy,
            consent: 'explicit',
          },
          task.revision,
        ),
        'local-owner',
      );
      assert.equal(prepared.outcome, 'applied');
      const nativeRun = RunSchema.parse(prepared.entity);
      if (scenario === 'repository-checked') {
        const tools = appointment.policy.effects.find(
          (grant) => grant.action === 'run-native-tools',
        );
        assert(tools);
        assert.equal(controller.snapshot().nativeRuns[0].expiresAt, tools.expiresAt);
        const key = `grant:${hashCanonical({ taskId: tools.taskId, action: tools.action, target: tools.target, expiresAt: tools.expiresAt })}`;
        assert.equal(controller.store.receipt(key), undefined);
      }
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
    await context.wait(`${scenario} candidate`, retained);
    const run = controller.snapshot().runs.at(-1);
    const candidate = controller.snapshot().candidates.at(-1);
    assert(run && candidate);
    const originalRun = structuredClone(run);
    const payload = {
      taskId: task.id,
      candidateId: candidate.id,
      checkRecipeId: scenario === 'project-checked' ? 'project-node-tests-v1' : 'node-tests-v1',
      ...(scenario === 'project-checked' ? { testFiles: ['net.test.mjs'] } : {}),
      reviewer: {
        profileId: context.reviewerProfile.facts.id,
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
    const revision = () => taskRevision(controller, task.id);
    if (scenario === 'repository-checked') {
      const policy = process.env.PROVENANCE_PATTERN;
      process.env.PROVENANCE_PATTERN = 'private fixture identity';
      const server = await serveController(controller);
      const client = await connectController({
        ...readControllerEndpoint(controller.home),
        actor: { id: 'terminal', kind: 'cli' },
        timeoutMs: 2000,
      });
      const send = (input: unknown) => client.command(CommandSchema.parse(input));
      const fixedPayload = {
        ...payload,
        checkRecipeId: 'crewkite-verify-v1',
        grants: payload.grants.map((grant) =>
          grant.action === 'run-check' ? { ...grant, target: 'crewkite verify' } : grant,
        ),
      };
      const preparing = command('PrepareCandidateEvaluation', fixedPayload, revision());
      const artifactsBefore = controller.store.list('artifact').length;
      const pending = send(preparing);
      let repeat: Promise<unknown> | undefined;
      try {
        await context.wait('verification inventory entered', inventoryEntered.promise);
        repeat = controller.execute(preparing, 'local-owner');
        assert.equal(inventoryCalls, 1);
        assert.equal(
          (
            await controller.execute(
              { ...preparing, payload: { ...fixedPayload, consent: 'saved' } },
              'local-owner',
            )
          ).reason,
          'idempotency-key-reused',
        );
        assert.equal(
          (
            await controller.execute(
              { ...preparing, command: 'StopRun', payload: { taskId: task.id, runId: run.id } },
              'local-owner',
            )
          ).reason,
          'idempotency-key-reused',
        );
        assert.equal(
          (await send(command('PrepareCandidateEvaluation', fixedPayload, revision()))).reason,
          'verification-preparation-busy',
        );
        const read = await send(command('GetSnapshot', {}));
        assert.equal(read.outcome, 'applied');
        assert(read.data?.kind === 'snapshot');
        assert(read.data.snapshot.tasks.some((value) => value.id === task.id));
        assert.equal(controller.store.receipt(preparing.key), undefined);
        const stopped = await send(
          command('StopRun', { taskId: task.id, runId: run.id }, revision()),
        );
        assert.equal(stopped.outcome, 'applied');
        assert.equal(inventorySignal?.aborted, true);
        inventoryRelease.resolve();
        const result = await context.wait('cancelled verification preparation', pending);
        assert.equal(result.outcome, 'stale-revision');
        assert.deepEqual(await context.wait('joined verification preparation', repeat), result);
        assert.equal(inventoryCalls, 1);
        assert.equal(controller.store.receipt(`evaluation-ready:${run.id}`), undefined);
        assert.equal(controller.store.list('artifact').length, artifactsBefore);
        assert.equal(
          (await send(command('PrepareCandidateEvaluation', fixedPayload, revision()))).reason,
          'verification-preparation-unavailable',
        );
        assert.equal(inventoryCalls, 2);
      } finally {
        inventoryRelease.resolve();
        await Promise.allSettled([pending, ...(repeat ? [repeat] : [])]);
        client.close();
        await server.close();
        if (policy === undefined) delete process.env.PROVENANCE_PATTERN;
        else process.env.PROVENANCE_PATTERN = policy;
      }
    }
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
    if (scenario === 'anthropic-checked' || scenario === 'google-checked') {
      assert.deepEqual(
        controller.store
          .nativeProcesses(controller.snapshot().attempts[0].id)
          .map((phase) => phase.phase),
        [scenario === 'google-checked' ? 'google-config' : 'auth-status', 'native-task'],
      );
      assert.equal(
        (
          await controller.execute(
            command(
              'PrepareCandidateEvaluation',
              {
                ...payload,
                reviewer: { ...payload.reviewer, profileId: context.fixtureProfile.facts.id },
              },
              revision(),
            ),
            'local-owner',
          )
        ).outcome,
        'blocked',
      );
    }
    if (scenario === 'repository-checked') {
      const before = controller.snapshot();
      assert.equal(
        (
          await controller.execute(
            command(
              'PrepareCandidateEvaluation',
              {
                ...payload,
                reviewer: { ...payload.reviewer, profileId: context.fixtureProfile.facts.id },
              },
              revision(),
            ),
            'local-owner',
          )
        ).outcome,
        'blocked',
      );
      assert.deepEqual(controller.snapshot(), before);
    }
    const prepare = command('PrepareCandidateEvaluation', payload, revision());
    const prepared = await controller.execute(prepare, 'local-owner');
    assert.equal(prepared.outcome, 'applied');
    let artifact = ArtifactSchema.parse(prepared.entity);
    assert.equal((await controller.execute(prepare, 'local-owner')).outcome, 'already-applied');
    assert.equal(controller.snapshot().attempts.length, 1);
    assert.equal(controller.snapshot().evidence.length, 0);
    assert.deepEqual(controller.snapshot().runs.at(-1), originalRun);
    const preview = controller.snapshot().candidateEvaluations[0];
    assert.equal(preview?.preparationId, artifact.id);
    assert.equal(preview.stage, 'prepared');
    assert.equal(preview.recipe, payload.checkRecipeId);
    assert.deepEqual(
      preview.testFiles.map((file) => file.path),
      scenario === 'project-checked' ? ['net.test.mjs'] : [],
    );
    assert.deepEqual(preview.checkStart, { available: true, reason: 'available' });
    assert.deepEqual(preview.reviewStart, { available: false, reason: 'checks-required' });
    assert.equal(preview.creditPolicy, 'ordinary');
    assert.equal(preview.reviewer.independence, 'process-only');
    if (scenario === 'repository-checked') {
      assert(preview.repository);
      assert.equal(preview.target, undefined);
      assert.deepEqual(preview.repository, controller.snapshot().nativeRuns[0].repository);
      assert.equal(
        controller.store.receipt(`native-application:${controller.store.intents()[0].attempt_id}`),
        undefined,
      );
      assert.equal(
        controller.store.receipt(`native-capture:${controller.store.intents()[0].attempt_id}`)
          ?.result.outcome,
        'applied',
      );
    } else {
      assert(preview.target);
      assert.equal(preview.target.baseHash, appointment.target.baseHash);
      assert.notEqual(preview.target.candidateContentHash, preview.candidateHash);
    }
    const readState = () => ({
      cursor: controller.store.cursor(),
      receipts: controller.store.db.prepare('SELECT COUNT(*) AS count FROM receipts').get()?.count,
      artifacts: controller.store.list('artifact').length,
      intents: controller.store.intents().length,
    });
    const beforeRead = readState();
    assert.deepEqual(controller.snapshot().candidateEvaluations[0], preview);
    assert.deepEqual(readState(), beforeRead);
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
    let expiredAtClose = false;
    let replay: Promise<unknown> | undefined;
    const finished = Promise.withResolvers<void>();
    const off = context.observe(controller, (event) => {
      if (event.type === 'attempt.launched') {
        checkLaunches++;
        if (scenario === 'check-drain-expired')
          queueMicrotask(() => {
            const jobs = Reflect.get(controller, 'jobs') as Map<string, OwnedCommand>;
            const job = jobs.get(event.payload.id);
            assert(job instanceof OwnedCommand);
            job.child.once('close', () => {
              clock.advance(60001);
              expiredAtClose = true;
            });
          });
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
      if (event.type === 'task.updated') {
        if (['interrupted', 'unknown'].includes(event.payload.state))
          finished.reject(new Error(`Check fixture ended ${event.payload.state}.`));
        if (['stopped', 'failed'].includes(event.payload.state)) finished.resolve();
      }
    });
    const started = await controller.execute(
      command('StartCandidateEvaluation', startPayload(), revision()),
      'local-owner',
    );
    assert.equal(started.outcome, 'applied');
    await context.wait(`${scenario} check completion`, finished.promise);
    if (replay) await context.wait(`${scenario} replay`, replay);
    off();
    assert.equal(checkLaunches, scenario.endsWith('intent') ? 0 : 1);
    const snapshot = controller.snapshot();
    assert.equal(snapshot.attempts.length, 2);
    assert.equal(context.submissions(), 1);
    assert.equal(
      context.children.length,
      scenario === 'anthropic-checked' || scenario === 'google-checked' ? 2 : 3,
    );
    assert.equal(snapshot.reviewJobs?.length, 0);
    assert.equal(snapshot.evidence.length, scenario.endsWith('intent') ? 0 : 1);
    if (!scenario.endsWith('intent')) {
      assert.equal(
        snapshot.evidence[0].passed,
        scenario !== 'failed' && scenario !== 'check-drain-expired',
      );
      assert.equal(snapshot.evidence[0].evaluator.startsWith('node:'), true);
      const intent = controller.store.intents().at(-1);
      assert(intent);
      const route = snapshot.routes.find((route) => route.id === intent.route_id);
      assert.equal(route?.fake, false);
      assert.equal(route?.qualified, false);
      assert.equal(route?.family, 'local');
      if (scenario === 'check-drain-expired') {
        assert.equal(expiredAtClose, true);
        assert.equal(intent.state, 'stopped');
        assert.equal(snapshot.tasks[0].state, 'failed');
        const metadata = controller.store.get<Artifact>(
          'artifact',
          snapshot.evidence[0].artifactId,
        );
        assert(metadata);
        const proof = JSON.parse(
          new ArtifactFiles(join(controller.home, 'artifacts'))
            .read(metadata.hash)
            .toString('utf8'),
        );
        assert.equal(proof.complete, true, 'expiry does not erase the complete Node report');
        assert.equal(proof.unchanged, true);
      }
    }
    assert.deepEqual(snapshot.runs.at(-1), originalRun);
    assert.notEqual(snapshot.tasks[0].state, 'ready');
    const evaluationPreview = snapshot.candidateEvaluations[0];
    assert(evaluationPreview);
    assert.equal(evaluationPreview.checkStart.available, false);
    assert.equal(
      evaluationPreview.stage,
      scenario.endsWith('intent')
        ? 'blocked'
        : scenario === 'failed' || scenario === 'check-drain-expired'
          ? 'check-failed'
          : 'awaiting-review',
    );
    assert.equal(
      evaluationPreview.reviewStart.available,
      !scenario.endsWith('intent') && scenario !== 'failed' && scenario !== 'check-drain-expired',
    );
    const reviewPayload = startPayload();
    const shouldReview = passedReview || scenario.startsWith('review-');
    if (!shouldReview) {
      assert.equal(
        (
          await controller.execute(
            command('StartCandidateReview', reviewPayload, revision()),
            'local-owner',
          )
        ).outcome,
        'blocked',
      );
    } else {
      const artifacts = new ArtifactFiles(join(controller.home, 'artifacts'));
      const evaluation = JSON.parse(artifacts.read(artifact.hash).toString('utf8'));
      if (scenario === 'checked') {
        const grant = evaluation.grants.find(
          (value: { action: string }) => value.action === 'run-review',
        );
        const grantKey = `grant:${hashCanonical({ taskId: grant.taskId, action: grant.action, target: grant.target, expiresAt: grant.expiresAt })}`;
        const consentKey = `evaluation-consent:${evaluation.scopeHash}`;
        const consent = controller.store.receipt(consentKey);
        assert(consent);
        const check = controller.snapshot().evidence.find((value) => !value.review);
        assert(check);
        for (const boundary of [
          'used-grant',
          'revoked-consent',
          'changed-check',
          'changed-profile',
          'review-budget',
        ]) {
          if (boundary === 'used-grant')
            controller.store.transaction(() =>
              controller.store.saveReceipt(grantKey, hashCanonical(grant), 'local-owner', {
                outcome: 'applied',
                entity: run,
              }),
            );
          if (boundary === 'revoked-consent')
            controller.store.transaction(() =>
              controller.store.db
                .prepare('DELETE FROM receipts WHERE command_key=?')
                .run(consentKey),
            );
          if (boundary === 'changed-check')
            controller.store.transaction(() =>
              controller.store.db
                .prepare("UPDATE evidence SET body=? WHERE candidate_id=? AND kind='check'")
                .run(canonicalJson({ ...check, definitionHash: '0'.repeat(64) }), candidate.id),
            );
          if (boundary === 'changed-profile')
            context.fixtureProfile.facts.creditPolicies = ['existing-credits'];
          const charged = controller.store.intents()[0];
          if (boundary === 'review-budget')
            controller.store.transaction(() =>
              controller.store.db
                .prepare('UPDATE launch_intents SET admitted_at=? WHERE attempt_id=?')
                .run(
                  new Date(
                    Date.parse(charged.finished_at as string) -
                      run.policy.policy.limits.minutes * 60000,
                  ).toISOString(),
                  charged.attempt_id,
                ),
            );
          const before = controller.snapshot();
          assert.equal(before.candidateEvaluations[0]?.reviewStart.available, false);
          assert.equal(
            before.candidateEvaluations[0]?.reviewStart.reason,
            boundary === 'used-grant'
              ? 'grant-unavailable'
              : boundary === 'revoked-consent'
                ? 'consent-unavailable'
                : boundary === 'changed-profile'
                  ? 'profile-unavailable'
                  : boundary === 'review-budget'
                    ? 'budget-exhausted'
                    : 'checks-required',
          );
          assert.equal(
            (
              await controller.execute(
                command('StartCandidateReview', reviewPayload, revision()),
                'local-owner',
              )
            ).outcome,
            'blocked',
            boundary,
          );
          assert.deepEqual(controller.snapshot(), before);
          assert.equal(context.submissions(), 1);
          assert.equal(context.children.length, 3);
          if (boundary === 'used-grant')
            controller.store.transaction(() =>
              controller.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run(grantKey),
            );
          if (boundary === 'revoked-consent')
            controller.store.transaction(() =>
              controller.store.saveReceipt(
                consentKey,
                consent.hash,
                consent.principal,
                consent.result,
              ),
            );
          if (boundary === 'changed-check')
            controller.store.transaction(() =>
              controller.store.db
                .prepare("UPDATE evidence SET body=? WHERE candidate_id=? AND kind='check'")
                .run(canonicalJson(check), candidate.id),
            );
          if (boundary === 'changed-profile')
            context.fixtureProfile.facts.creditPolicies = ['ordinary', 'existing-credits'];
          if (boundary === 'review-budget')
            controller.store.transaction(() =>
              controller.store.db
                .prepare('UPDATE launch_intents SET admitted_at=? WHERE attempt_id=?')
                .run(charged.admitted_at, charged.attempt_id),
            );
        }
      }
      let reviewReplay: Promise<unknown> | undefined;
      let closing: Promise<void> | undefined;
      let stop: Promise<unknown> | undefined;
      const reviewed = Promise.withResolvers<void>();
      const offReview = context.observe(controller, (event) => {
        if (event.type === 'attempt.launched')
          reviewReplay = controller
            .execute(command('StartCandidateReview', reviewPayload, revision()), 'local-owner')
            .then((result) => assert.equal(result.outcome, 'already-applied'));
        if (
          event.type === 'task.updated' &&
          ['stopped', 'ready', 'failed', 'unknown'].includes(event.payload.state)
        )
          reviewed.resolve();
      });
      if (scenario === 'review-journal-read')
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
      context.onWritten((message) => {
        if (message.method !== 'turn/start' || context.submissions() !== 2) return;
        if (scenario === 'review-stop')
          stop = controller
            .execute(
              command('StopRun', { taskId: task.id, runId: run.id }, revision()),
              'local-owner',
            )
            .then((result) => assert.equal(result.outcome, 'applied'));
        if (scenario === 'review-close') closing = Promise.resolve(controller.close());
      });
      const reviewStart = command('StartCandidateReview', reviewPayload, revision());
      assert.equal((await controller.execute(reviewStart, 'local-owner')).outcome, 'applied');
      await context.wait(`${scenario} review completion`, reviewed.promise);
      if (reviewReplay) await context.wait(`${scenario} review replay`, reviewReplay);
      if (stop) await context.wait(`${scenario} review stop`, stop);
      if (closing) await context.wait(`${scenario} review close`, closing);
      offReview();
      if (scenario === 'review-close') controller = await context.restart();
      if (scenario === 'review-journal-read') {
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
          (
            await controller.execute(
              command('StopRun', { taskId: task.id, runId: run.id }, revision()),
              'local-owner',
            )
          ).reason,
          'writer-ownership-unknown',
        );
        assert.equal(controller.snapshot().tasks[0].state, 'unknown');
        controller.store.db.exec(
          'ALTER TABLE native_processes_unreadable RENAME TO native_processes',
        );
      }
      const result = controller.snapshot();
      const job = result.reviewJobs?.at(-1);
      assert(job && !job.scripted);
      if (scenario === 'repository-checked') {
        const artifact = ArtifactSchema.parse(
          controller.store.receipt(`native-review-input:${job.attemptId}`)?.result.entity,
        );
        const saved = JSON.parse(
          new ArtifactFiles(join(controller.home, 'artifacts'))
            .read(artifact.hash)
            .toString('utf8'),
        );
        assert.equal(saved.input.repository.candidateManifestHash, candidate.hash);
        assert.deepEqual(
          saved.input.repository.changes.map((change: { path: string }) => change.path),
          ['cli.mjs', 'docs/日本語.md', 'index.html', 'net.mjs'],
        );
        assert.equal(
          saved.input.repository.changes.find(
            (change: { path: string }) => change.path === 'index.html',
          ).candidate,
          null,
        );
        assert.equal(
          saved.input.repository.changes.find(
            (change: { path: string }) => change.path === 'docs/日本語.md',
          ).original,
          null,
        );
      }

      assert('writerAttemptId' in job);
      assert.equal(job.writerAttemptId, result.attempts[0].id);
      assert.equal(job.candidateId, candidate.id);
      assert.equal(job.preparationId, artifact.id);
      assert.equal(job.independence, 'process-only');
      assert.equal(context.submissions(), 2, scenario);
      assert.equal(
        context.children.length,
        scenario === 'anthropic-checked' || scenario === 'google-checked' ? 5 : 6,
      );
      assert.equal(result.attempts.length, 3);
      assert.equal(result.candidates.length, 1);
      assert.deepEqual(result.runs.at(-1), originalRun);
      assert.equal(
        result.evidence.filter((value) => value.review).length,
        scenario === 'review-journal-read' ? 0 : 1,
      );
      const review = result.evidence.find((value) => value.review);
      if (scenario !== 'review-journal-read') {
        assert(review);
        assert.equal(review.passed, passedReview);
        assert.equal(review.evaluator.startsWith('native:openai:'), true);
        assert.equal(review.review?.job.scripted, false);
      }
      assert(controller.store.receipt(`native-review-submission:${job.attemptId}`));
      assert.equal(
        !!controller.store.receipt(`native-review-completion:${job.attemptId}`),
        scenario !== 'review-journal-read',
      );
      assert.equal(controller.store.receipt(`native-application:${job.attemptId}`), undefined);
      assert.equal(controller.store.receipt(`candidate:${job.attemptId}`), undefined);
      assert(
        controller.store
          .nativeProcesses(job.attemptId)
          .every(
            (phase) =>
              (scenario === 'review-journal-read' || phase.state === 'quiescent') &&
              groupAbsent(phase.process_group),
          ),
      );
      assert.equal(result.tasks[0].state === 'ready', passedReview);
      const retainedPreview = result.candidateEvaluations[0];
      assert(retainedPreview);
      assert.equal(
        retainedPreview.stage,
        scenario === 'review-journal-read' ? 'blocked' : 'reviewed',
      );
      assert.equal(retainedPreview.reviewStart.available, false);
      assert.equal(
        retainedPreview.review?.outcome,
        scenario === 'review-journal-read' ? undefined : passedReview ? 'passed' : 'blocked',
      );
      assert.equal(
        retainedPreview.remainingBudgets.attempts,
        appointment.policy.limits.attempts - 3,
      );
      if (scenario === 'checked') {
        clock.advance(86400001);
        const expiredPreview = controller.snapshot().candidateEvaluations[0];
        assert.equal(expiredPreview?.stage, 'reviewed');
        assert.deepEqual(expiredPreview.check, retainedPreview.check);
        assert.deepEqual(expiredPreview.review, retainedPreview.review);
        assert.equal(expiredPreview.reviewStart.available, false);
      }
      assert.equal(
        (
          await controller.execute(
            command('StartCandidateReview', reviewPayload, revision()),
            'local-owner',
          )
        ).outcome,
        'already-applied',
      );
      controller = await context.restart();
      assert.equal(
        (
          await controller.execute(
            command('StartCandidateReview', reviewPayload, revision()),
            'local-owner',
          )
        ).outcome,
        'already-applied',
      );
      assert.equal(controller.snapshot().attempts.length, 3);
      assert.equal(context.submissions(), 2);
      assert.equal(
        controller.store.db.prepare('SELECT COUNT(*) AS count FROM publications').get()?.count,
        0,
      );
    }
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
      passedReview ? 'git-identity-missing' : 'native-pilot-retain-only',
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
    assert.equal(context.submissions(), shouldReview ? 2 : 1);
  };
  await nativeRows(['checked', 'project-checked'], evaluate);
  // This row changes process-wide policy. Both row pools stay outside its lifetime.
  await evaluate('repository-checked');
  await nativeRows(
    [
      'anthropic-checked',
      'google-checked',
      'failed',
      'check-drain-expired',
      'stop-intent',
      'expired-intent',
      'revoked-intent',
      'review-blocked',
      'review-stop',
      'review-close',
      'review-journal-read',
    ],
    evaluate,
  );

  const prepareBoundary = async (boundary: string) => {
    console.error(`Native fixture row: preparation/${boundary}`);
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
      return;
    }
    assert.equal(prepared.outcome, 'applied', JSON.stringify(prepared));
    assert.equal(context.children.length, 0);
    const run = RunSchema.parse(prepared.entity);
    if (boundary === 'unrelated-expired-grant') return;
    if (boundary === 'stop-prepared') {
      assert.equal(
        (
          await controller.execute(
            command(
              'StopRun',
              { taskId: task.id, runId: run.id },
              taskRevision(controller, task.id),
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
          taskRevision(controller, task.id),
        ),
        'local-owner',
      );
      assert.equal(
        (
          await controller.execute(
            command(
              'PrepareNativeRun',
              { ...payload, consent: 'saved' },
              taskRevision(controller, task.id),
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
            taskRevision(controller, task.id),
          ),
          'local-owner',
        )
      ).outcome,
      'blocked',
    );
    assert.equal(context.children.length, 0);
    assert.equal(controller.store.intents().length, 0);
  };
  await nativeRows(
    [
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
    ],
    prepareBoundary,
  );

  {
    console.error('Native fixture row: parallel tasks');
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
            taskRevision(controller, task.id),
          ),
          'local-owner',
        )
      ).outcome,
      'applied',
    );
    await context.wait('submission ready', context.ready);
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
            taskRevision(controller, secondTask.id),
          ),
          'local-owner',
        )
      ).outcome,
      'applied',
    );
    await context.wait('second submission', submitted.promise);
    assert.equal(controller.store.intents().length, 2);
    assert.equal(
      controller.store.db.prepare('SELECT COUNT(*) AS count FROM writer_leases').get()?.count,
      2,
    );
    await nativeWait(
      'controller close',
      Promise.resolve().then(() => controller.close()),
      10_000,
    );
    assert.equal(context.submissions(), 2);
  }
});

test('stop or restart cannot submit or apply late native work', async (t) => {
  for (const row of [
    'stop',
    'disconnect',
    'admission-stop',
    'input-cancel',
    'input-disconnect',
    'input-intent-restart',
    'configuration-unknown',
    'configuration-failed',
    'unknown',
    'client-loss',
    'missing-terminal',
    'missing-preparation',
    'corrupt-terminal',
    'intent-restart',
  ]) {
    const mode =
      row === 'stop' || row === 'disconnect'
        ? 'hold'
        : row === 'missing-terminal' || row === 'missing-preparation' || row === 'corrupt-terminal'
          ? 'unknown'
          : row;
    const context = await localControllerFixture(t, mode);
    const { controller, command, task, run } = context;
    if (row === 'input-intent-restart') {
      const control = controller.store.localControl() as Record<string, unknown>;
      const setup = context.setupState();
      assert(setup?.connectionHash);
      const operationId = context.id('cmd');
      controller.store.transaction(() =>
        controller.store.putLocalControl({
          ...control,
          revision: setup.revision + 1,
          operation: {
            kind: 'input',
            state: 'intent',
            group: null,
            revoked: false,
            clientQuiescent: false,
            binding: {
              version: 2,
              operationId,
              nonce: 'c'.repeat(64),
              connectionHash: setup.connectionHash,
              connectionRevision: setup.connectionRevision,
            },
          },
        }),
      );
      const reopened = await context.reopen();
      const retained = reopened.snapshot().localSetup;
      assert.equal(retained?.operation?.state, 'unknown');
      assert.equal(retained?.operation?.operationId, operationId);
      assert.equal(retained?.secretConfigured, false);
      assert.equal(
        (
          await reopened.execute(
            command('BeginLocalConnectionInput', { consent: 'explicit' }, retained?.revision),
            'local-owner',
          )
        ).reason,
        'local-operation-unknown',
      );
      assert.equal(context.submissions(), 0);
      assert.equal(reopened.store.intents().length, 0);
      continue;
    }
    if (row === 'input-cancel' || row === 'input-disconnect') {
      context.mode('input-hold');
      const before = context.setupState();
      await context.local('BeginLocalConnectionInput', { consent: 'explicit' });
      const operation = context.setupState()?.operation;
      assert(operation && operation.kind === 'input');
      assert.equal((await context.started()).outcome, 'blocked');
      assert.equal(controller.store.intents().length, 0);
      if (row === 'input-cancel')
        await context.local('CancelLocalConnectionInput', { operationId: operation.operationId });
      else await context.local('DisconnectLocal');
      await context.operationDone();
      assert.equal(context.setupState()?.secretConfigured, false);
      assert.equal(context.setupState()?.operation, null);
      assert.equal(context.submissions(), 0);
      assert.equal(
        context.setupState()?.connectionRevision,
        (before?.connectionRevision ?? 0) + (row === 'input-disconnect' ? 1 : 0),
      );
      continue;
    }
    let stoppedAtAdmission: Promise<CommandResult> | undefined;
    if (row === 'admission-stop') {
      const off = controller.subscribe((event) => {
        if (event.type === 'run.admitted' && event.taskId === task.id) {
          off();
          stoppedAtAdmission = controller.execute(
            command(
              'StopRun',
              { taskId: task.id, runId: run.id },
              controller.store.get<{ revision: number }>('task', task.id)?.revision,
            ),
            'local-owner',
          );
        }
      });
      t.after(off);
    }
    if (row === 'intent-restart')
      await assert.rejects(context.started(), /Local intent interrupted/);
    else {
      assert.equal((await context.started()).outcome, 'applied');
      if (row === 'stop' || row === 'disconnect') {
        await nativeWait('Local submission before Stop', context.submitted);
        assert.equal(
          (await context.local('RefreshLocalModels', { consent: 'explicit' })).reason,
          'generation-active',
        );
        assert.equal(
          (await context.local('ConfigureLocal', { endpoint: 'ws://127.0.0.1:23456' })).reason,
          'generation-active',
        );
        if (row === 'stop')
          await controller.execute(
            command(
              'StopRun',
              { taskId: task.id, runId: run.id },
              controller.store.get<{ revision: number }>('task', task.id)?.revision,
            ),
            'local-owner',
          );
        else await context.local('DisconnectLocal');
      }
      await nativeWait(`Local ${row} terminal`, context.terminal);
      if (stoppedAtAdmission) assert.equal((await stoppedAtAdmission).outcome, 'applied');
    }
    const intent = controller.store.intents().find((value) => value.run_id === run.id);
    assert(intent);
    const uncertain = [
      'configuration-unknown',
      'unknown',
      'client-loss',
      'missing-terminal',
      'corrupt-terminal',
      'missing-preparation',
      'intent-restart',
    ].includes(row);
    assert.equal(
      controller.snapshot().localSetup?.generation,
      row === 'intent-restart' ? 'active' : uncertain ? 'unknown' : 'idle',
    );
    assert.equal(controller.snapshot().candidates.length, 0);
    if (row === 'configuration-unknown' || row === 'configuration-failed') {
      const failedTask = controller.snapshot().tasks.find((value) => value.id === task.id);
      assert.equal(failedTask?.state, row === 'configuration-unknown' ? 'unknown' : 'stopped');
      assert.equal(
        failedTask?.next,
        row === 'configuration-unknown'
          ? 'Local settings could not be verified. Execution ownership is unknown. Checks and publication are blocked.'
          : 'Local settings could not be verified. No replacement was applied.',
      );
      assert(!failedTask?.next?.includes(context.secret));
    }
    assert.equal(
      context.submissions(),
      row === 'admission-stop' || row === 'intent-restart' ? 0 : 1,
    );
    if (row === 'missing-preparation')
      controller.store.transaction(() =>
        controller.store.db
          .prepare('DELETE FROM receipts WHERE command_key=?')
          .run(`local-prepared:${run.id}`),
      );
    if (row === 'missing-terminal')
      controller.store.transaction(() =>
        controller.store.db
          .prepare('DELETE FROM receipts WHERE command_key=?')
          .run(`local-terminal:${intent.attempt_id}`),
      );
    if (row === 'corrupt-terminal') {
      const artifact = ArtifactSchema.parse(
        controller.store.receipt(`local-terminal:${intent.attempt_id}`)?.result.entity,
      );
      writeFileSync(join(controller.home, 'artifacts', artifact.hash), '{}');
    }
    const before = context.submissions();
    const reopened = await context.reopen();
    assert.equal(reopened.snapshot().localSetup?.secretConfigured, false);
    assert.equal(reopened.snapshot().localSetup?.generation, uncertain ? 'unknown' : 'idle');
    const reservations = reopened.store.db
      .prepare('SELECT COUNT(*) AS count FROM reservations WHERE attempt_id=?')
      .get(intent.attempt_id)?.count;
    const leases = reopened.store.db
      .prepare('SELECT COUNT(*) AS count FROM writer_leases WHERE attempt_id=?')
      .get(intent.attempt_id)?.count;
    assert.equal(reservations, uncertain ? 1 : 0);
    assert.equal(leases, uncertain ? 1 : 0);
    if (uncertain) {
      const setup = reopened.snapshot().localSetup;
      assert.equal(
        (
          await reopened.execute(
            command('BeginLocalConnectionInput', { consent: 'explicit' }, setup?.revision),
            'local-owner',
          )
        ).reason,
        'generation-unknown',
      );
      await reopened.execute(
        command(
          'StopRun',
          { taskId: task.id, runId: run.id },
          reopened.store.get<{ revision: number }>('task', task.id)?.revision,
        ),
        'local-owner',
      );
      assert.equal(reopened.snapshot().localSetup?.generation, 'unknown');
      assert.equal(
        reopened.store.db
          .prepare('SELECT COUNT(*) AS count FROM reservations WHERE attempt_id=?')
          .get(intent.attempt_id)?.count,
        1,
      );
    }
    assert.equal(context.submissions(), before);
  }

  for (const scenario of ['auth-api', 'overage', 'stop-auth', 'stop-task'] as const) {
    const context = await nativeSetup(
      t,
      scenario === 'stop-task' ? 'anthropic-hold' : `anthropic-${scenario}`,
    );
    let controller = context.controller;
    const { command, task, appointment } = context;
    const attestation = {
      source: 'user-attested',
      subscriptionLoginConfirmed: true,
      paidExtraUsageDisabled: true,
    };
    const payload = {
      taskId: task.id,
      profileId: context.fixtureProfile.facts.id,
      targetPath: 'net.mjs',
      policy: appointment.policy,
      consent: 'explicit',
      billingAttestation: attestation,
    };
    const before = controller.snapshot();
    for (const change of [
      { billingAttestation: undefined },
      { creditPolicy: 'existing-credits' },
      { consent: 'saved' },
    ]) {
      const changed = { ...payload, ...change };
      if (changed.billingAttestation === undefined) delete changed.billingAttestation;
      const refused = await controller.execute(
        command('PrepareNativeRun', changed, task.revision),
        'local-owner',
      );
      assert.equal(refused.outcome, 'blocked');
      assert.deepEqual(controller.snapshot(), before);
    }
    const prepared = await controller.execute(
      command('PrepareNativeRun', payload, task.revision),
      'local-owner',
    );
    assert.equal(prepared.outcome, 'applied');
    const run = RunSchema.parse(prepared.entity);
    assert.deepEqual(controller.snapshot().nativeRuns[0].billingAttestation, attestation);
    assert.equal(
      run.roles[0].routeId,
      controller.snapshot().routes.find((route) => route.family === 'anthropic' && !route.fake)?.id,
    );
    assert.equal(
      controller.snapshot().routes.find((route) => route.id === run.roles[0].routeId)?.effort
        .effective,
      'unknown',
    );
    controller = await context.restart();
    let stopping: Promise<unknown> | undefined;
    const stop = () => {
      stopping = controller.execute(
        command('StopRun', { taskId: task.id, runId: run.id }, taskRevision(controller, task.id)),
        'local-owner',
      );
    };
    if (scenario === 'stop-auth')
      context.onSpawn((phase) => {
        if (phase === 'auth') queueMicrotask(stop);
      });
    if (scenario === 'stop-task')
      context.onWritten((message) => {
        if (message.method === 'prompt') queueMicrotask(stop);
      });
    const retained = nativeCandidate(controller);
    assert.equal(
      (
        await controller.execute(
          command(
            'StartRun',
            { taskId: task.id, runId: run.id },
            taskRevision(controller, task.id),
          ),
          'local-owner',
        )
      ).outcome,
      'applied',
    );
    await context.wait(`${scenario} retained`, retained);
    if (stopping) await context.wait(`${scenario} Stop`, stopping);
    assert.equal(context.submissions(), scenario === 'overage' || scenario === 'stop-task' ? 1 : 0);
    const attempt = controller.snapshot().attempts[0];
    const phases = controller.store.nativeProcesses(attempt.id);
    assert.deepEqual(
      phases.map((phase) => phase.phase),
      scenario === 'auth-api' || scenario === 'stop-auth'
        ? ['auth-status']
        : ['auth-status', 'native-task'],
    );
    assert(
      phases.every((phase) => phase.state === 'quiescent' && groupAbsent(phase.process_group)),
    );
    assert.equal(controller.store.receipt(`native-application:${attempt.id}`), undefined);
    assert.equal(controller.snapshot().tasks[0].state, 'interrupted');
    assert.deepEqual(inspectSource(task.projectId, context.source.directory), run.source);
    controller = await context.restart();
    assert.equal(controller.snapshot().attempts.length, 1);
    assert.equal(context.submissions(), scenario === 'overage' || scenario === 'stop-task' ? 1 : 0);
  }
  for (const scenario of [
    'config-error',
    'credits',
    'mode-mismatch',
    'stop-config',
    'stop-task',
  ] as const) {
    const context = await nativeSetup(
      t,
      scenario === 'stop-task' ? 'google-hold' : `google-${scenario}`,
    );
    let controller = context.controller;
    const { command, task, appointment } = context;
    const payload = {
      taskId: task.id,
      profileId: context.fixtureProfile.facts.id,
      targetPath: 'net.mjs',
      policy: appointment.policy,
      consent: 'explicit',
      permissionMode: 'request-review',
      billingAttestation: {
        source: 'user-attested',
        subscriptionLoginConfirmed: true,
        paidExtraUsageDisabled: true,
      },
    };
    const before = controller.snapshot();
    for (const change of [
      { permissionMode: undefined },
      { billingAttestation: undefined },
      { creditPolicy: 'existing-credits' },
      { consent: 'saved' },
    ]) {
      const changed: Record<string, unknown> = { ...payload, ...change };
      for (const key of Object.keys(changed)) if (changed[key] === undefined) delete changed[key];
      const refused = await controller.execute(
        command('PrepareNativeRun', changed, task.revision),
        'local-owner',
      );
      assert.equal(refused.outcome, 'blocked');
      assert.deepEqual(controller.snapshot(), before);
    }
    const prepared = await controller.execute(
      command('PrepareNativeRun', payload, task.revision),
      'local-owner',
    );
    assert.equal(prepared.outcome, 'applied');
    const run = RunSchema.parse(prepared.entity);
    assert.equal(controller.snapshot().nativeRuns[0].permissionMode, 'request-review');
    assert.deepEqual(
      controller.snapshot().nativeRuns[0].billingAttestation,
      payload.billingAttestation,
    );
    controller = await context.restart();
    let stopping: Promise<unknown> | undefined;
    context.onSpawn((phase) => {
      if (
        (scenario === 'stop-config' && phase === 'config') ||
        (scenario === 'stop-task' && phase === 'task')
      )
        queueMicrotask(() => {
          stopping = controller.execute(
            command(
              'StopRun',
              { taskId: task.id, runId: run.id },
              taskRevision(controller, task.id),
            ),
            'local-owner',
          );
        });
    });
    const retained = nativeCandidate(controller);
    assert.equal(
      (
        await controller.execute(
          command(
            'StartRun',
            { taskId: task.id, runId: run.id },
            taskRevision(controller, task.id),
          ),
          'local-owner',
        )
      ).outcome,
      'applied',
    );
    await context.wait(`Google ${scenario} retention`, retained);
    if (stopping) await context.wait(`Google ${scenario} Stop`, stopping);
    assert.equal(context.submissions(), scenario === 'stop-task' ? 1 : 0);
    const attempt = controller.snapshot().attempts[0];
    const phases = controller.store.nativeProcesses(attempt.id);
    assert.deepEqual(
      phases.map((row) => row.phase),
      scenario === 'stop-task' ? ['google-config', 'native-task'] : ['google-config'],
    );
    assert(phases.every((row) => row.state === 'quiescent' && groupAbsent(row.process_group)));
    assert.equal(controller.store.receipt(`native-application:${attempt.id}`), undefined);
    assert.equal(controller.snapshot().tasks[0].state, 'interrupted');
    assert.deepEqual(inspectSource(task.projectId, context.source.directory), run.source);
    controller = await context.restart();
    assert.equal(controller.snapshot().attempts.length, 1);
    assert.equal(context.submissions(), scenario === 'stop-task' ? 1 : 0);
  }
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
    'public-repository-after-submit',
    'public-repository-capture-failure',
    'public-close-at-admission',
    'public-restart-intent',
  ] as const) {
    const publicRun = scenario.startsWith('public-');
    const repository = scenario.startsWith('public-repository-');
    const boundary = scenario.replace(/^public-/, '').replace(/^repository-/, '');
    console.error(`Native fixture row: stop/${scenario}`);
    const context = await nativeSetup(
      t,
      repository
        ? boundary === 'capture-failure'
          ? 'repository-success'
          : 'repository-hold'
        : boundary === 'after-submit' || boundary === 'close'
          ? 'hold'
          : 'success',
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
      boundary === 'journal-read' || boundary === 'capture-failure'
        ? unknown.promise
        : boundary === 'restart-intent' || boundary === 'close-at-admission'
          ? Promise.resolve()
          : nativeCandidate(controller);
    if (boundary === 'capture-failure') {
      context.observe(controller, (event) => {
        if (event.type === 'task.updated' && event.payload.state === 'interrupted')
          unknown.resolve();
      });
      context.onWritten((message) => {
        if (message.method === 'turn/start')
          mkdirSync(
            join(
              controller.home,
              'scratch',
              controller.snapshot().tasks[0].runId as string,
              '.git',
            ),
          );
      });
    }
    if (boundary === 'journal-read') {
      context.observe(controller, (event) => {
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
      context.observe(controller, (event) => {
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
                taskRevision(controller, task.id),
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
              taskRevision(controller, task.id),
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
            ...(repository ? {} : { targetPath: appointment.target.path }),
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
        taskRevision(controller, task.id),
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
      await context.wait('submission ready', context.ready);
      if (boundary === 'close') {
        const first = controller.close();
        assert.equal(controller.close(), first);
        await context.wait(`${scenario} close`, Promise.resolve(first));
      } else {
        await controller.execute(
          command('StopRun', { taskId: task.id, runId }, taskRevision(controller, task.id)),
          'local-owner',
        );
        await context.wait('candidate', sealed);
      }
    } else {
      await context.wait('candidate', sealed);
      if (action) await context.wait(`${scenario} action`, action);
    }
    if (
      boundary !== 'application-intent' &&
      boundary !== 'capture-failure' &&
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
    if (boundary === 'capture-failure') {
      const snapshot = controller.snapshot();
      assert.equal(snapshot.tasks[0].state, 'interrupted');
      assert.equal(typeof snapshot.tasks[0].next, 'string');
      assert.match(snapshot.tasks[0].next as string, /capture failed/);
      assert.equal(snapshot.candidates.length, 0);
      assert.equal(
        controller.store.receipt(`native-capture:${snapshot.attempts[0].id}`),
        undefined,
      );
      const failure = ArtifactSchema.parse(
        controller.store.receipt(`native-capture-failure:${snapshot.attempts[0].id}`)?.result
          .entity,
      );
      assert.deepEqual(
        JSON.parse(
          new ArtifactFiles(join(controller.home, 'artifacts')).read(failure.hash).toString('utf8'),
        ),
        { attemptId: snapshot.attempts[0].id, reason: 'capture-unavailable' },
      );
      assert(existsSync(join(controller.home, 'scratch', runId, '.git')));
      assert.deepEqual(
        inspectSource(task.projectId, context.source.directory),
        snapshot.runs[0].source,
      );
    }
    await nativeWait(
      'controller close',
      Promise.resolve().then(() => controller.close()),
      10_000,
    );
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
            command('StartRun', { taskId: task.id, runId }, taskRevision(reopened, task.id)),
            'local-owner',
          )
        ).outcome,
        'blocked',
      );
      assert.equal(
        (
          await reopened.execute(
            command('ResumeRun', { taskId: task.id, runId }, taskRevision(reopened, task.id)),
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
      if (repository)
        assert.equal(
          reopened.store.receipt(`native-capture:${reopened.store.intents()[0].attempt_id}`),
          undefined,
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
      await nativeWait(
        'reopened close',
        Promise.resolve().then(() => reopened.close()),
        10_000,
      );
    }
  }
});

test('google quota authority survives retries and restart while sharing one operation gate', async (t) => {
  let controller: Controller;
  let mode: 'success' | 'invalid' | 'incomplete' | 'empty' = 'success';
  let available = true;
  let launches = 0;
  const report = {
    status: 'SUCCESS',
    num_turns: 0,
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            buckets: [
              { id: 'gemini-weekly', remaining_fraction: 0.8, reset_time: '2026-10-23T14:13:03Z' },
              { id: 'gemini-5h', remaining_fraction: 0.3, reset_time: '2026-10-16T19:13:03Z' },
              {
                id: 'gemini-argon-wtu-weekly',
                remaining_fraction: 1,
                reset_time: '2026-10-23T14:13:03Z',
              },
            ],
          },
        ],
      },
    },
  };
  const socketRoot = mkdtempSync(
    join(realpathSync(checkOwner()?.stateRoot ?? tmpdir()), 'ck-quota-'),
  );
  const options: Partial<ControllerOptions> = {
    home: join(socketRoot, 'home'),
    googleUsageClient: () =>
      available
        ? {
            available: true,
            reason: 'available',
            client: { executable: process.execPath, version: '1.4.0', sha256: fixtureClientHash },
            environment: { HOME: userInfo().homedir },
          }
        : { available: false, reason: 'client-unavailable' },
    googleUsageSpawn: (_, args, spawnOptions) => {
      launches++;
      assert.equal(args[1], '/usage');
      assert.deepEqual(Object.keys(spawnOptions.env).sort(), [
        'HOME',
        'LANG',
        'LOGNAME',
        'NO_COLOR',
        'PATH',
        'TERM',
        'TMPDIR',
        'USER',
      ]);
      const operation = controller.store.googleMetadataOperations().at(-1);
      assert.equal(operation?.state, 'intent', 'metadata ownership commits before spawn');
      controller.store.transaction(() => {
        assert.equal(controller.store.googleOperationBlocker(), 'google-operation-active');
        assert.throws(
          () =>
            controller.store.beginGoogleMetadata(
              context.id('cmd'),
              'acp-initialize',
              0,
              context.clock.now(),
            ),
          /google-operation-active/,
        );
      });
      const output =
        mode === 'invalid'
          ? {}
          : mode === 'success'
            ? report
            : {
                ...report,
                command: {
                  ...report.command,
                  data: { groups: [{ buckets: mode === 'empty' ? [] : [{ id: 'incomplete' }] }] },
                },
              };
      const child = spawn(
        process.execPath,
        ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(output))})`],
        spawnOptions,
      );
      return child;
    },
  };
  const context = await setup(t, options, () => controller.close());
  controller = context.controller;
  t.after(() => rmSync(socketRoot, { recursive: true, force: true }));
  const refresh = () => context.command('ObserveUsage', { family: 'google' }, 0);
  assert.equal(controller.snapshot().usageReaders[0]?.available, true);
  assert.equal('enabled' in controller.snapshot().usageReaders[0], false);
  assert.equal(launches, 0);
  const first = refresh();
  const pending = controller.execute(first, 'local-owner');
  const retry = controller.execute(first, 'local-owner');
  assert.equal(
    (
      await controller.execute(
        { ...first, actor: { id: 'changed-client', kind: 'cli' } },
        'local-owner',
      )
    ).reason,
    'idempotency-key-reused',
  );
  assert.equal((await pending).outcome, 'applied');
  assert.equal((await retry).outcome, 'applied');
  assert.equal((await controller.execute(first, 'local-owner')).outcome, 'already-applied');
  assert.equal(launches, 1);
  const displayRoute = controller
    .snapshot()
    .routes.find((route) => route.family === 'google' && !route.fake);
  assert(displayRoute);
  assert.equal(displayRoute.model, 'unknown');
  assert.deepEqual(displayRoute.effort, {
    requested: 'unknown',
    effective: 'unknown',
    supported: [],
  });
  assert.equal(displayRoute.qualified, false);
  assert.equal(
    controller.snapshot().usage.filter(({ observation }) => observation.routeId === displayRoute.id)
      .length,
    3,
  );
  assert.equal(controller.snapshot().usageReaders[0]?.lastObservedAt, context.clock.now());
  assert(
    controller.store
      .eventsAfter('0')
      .filter((event) => event.type === 'usage.observed')
      .every((event) => event.taskId === null),
  );
  assert.equal(
    (await controller.execute(refresh(), 'local-owner')).reason,
    'usage-reader-cooldown',
  );
  const second = { ...displayRoute, id: context.id('rte') };
  controller.store.transaction(() => controller.store.put('route', second.id, 0, second));
  context.clock.advance(60000);
  assert.equal((await controller.execute(refresh(), 'local-owner')).outcome, 'applied');
  const liveRoutes = controller
    .snapshot()
    .routes.filter((route) => route.family === 'google' && !route.fake);
  for (const route of liveRoutes)
    assert.equal(
      controller.snapshot().usage.filter(({ observation }) => observation.routeId === route.id)
        .length,
      3,
    );
  const removed = report.command.data.groups[0].buckets.pop();
  assert(removed);
  const originalWindow = controller.store.get<Observation>(
    'window',
    `${displayRoute.id}/${removed.id}`,
  );
  assert(originalWindow);
  const fixtureRoute = { ...displayRoute, id: context.id('rte'), fake: true };
  const foreignRoute = { ...displayRoute, id: context.id('rte'), family: 'anthropic' as const };
  const preserved = [
    { ...originalWindow, routeId: fixtureRoute.id },
    { ...originalWindow, routeId: foreignRoute.id },
    { ...originalWindow, routeId: second.id, windowId: 'manual-only', source: 'manual' as const },
  ];
  controller.store.transaction(() => {
    controller.store.put('route', fixtureRoute.id, 0, fixtureRoute);
    controller.store.put('route', foreignRoute.id, 0, foreignRoute);
    for (const observation of preserved)
      controller.store.put(
        'window',
        `${observation.routeId}/${observation.windowId}`,
        0,
        observation,
      );
  });
  context.clock.advance(300001);
  assert.equal((await controller.execute(refresh(), 'local-owner')).outcome, 'applied');
  for (const route of liveRoutes) {
    const windows = controller
      .snapshot()
      .usage.filter(
        ({ observation }) => observation.routeId === route.id && observation.source === 'client',
      );
    assert.equal(windows.length, 2);
    assert(windows.every(({ state }) => state === 'fresh'));
    assert(windows.every(({ observation }) => observation.windowId !== removed.id));
  }
  for (const observation of preserved)
    assert.deepEqual(
      controller.store.get<Observation>('window', `${observation.routeId}/${observation.windowId}`),
      observation,
    );
  controller.store.transaction(() =>
    controller.store.db
      .prepare("DELETE FROM entities WHERE kind='window' AND id=?")
      .run(`${second.id}/manual-only`),
  );
  report.command.data.groups[0].buckets.push(removed);
  context.clock.advance(60000);
  const beforeAutomatic = launches;
  const server = await serveController(controller);
  try {
    const startup = controller.refreshGoogleUsage('start');
    assert(startup);
    assert.equal((await startup).outcome, 'applied');
    assert.equal(launches, beforeAutomatic + 1);
    const connect = () =>
      connectController({
        ...readControllerEndpoint(controller.home),
        actor: { id: 'quota-fixture', kind: 'cli' },
        reconnectDelaysMs: [],
      });
    context.clock.advance(60000);
    const fresh = await connect();
    fresh.close();
    assert.equal(launches, beforeAutomatic + 1, 'fresh connection does not read again');
    context.clock.advance(300001);
    assert.equal(launches, beforeAutomatic + 1, 'elapsed time admits no background read');
    const clients = await Promise.all([connect(), connect()]);
    try {
      const connected = controller.refreshGoogleUsage('connect');
      assert(connected);
      assert.equal((await connected).outcome, 'applied');
      assert.equal(launches, beforeAutomatic + 2, 'stale connections share one read');
    } finally {
      for (const client of clients) client.close();
    }
  } finally {
    await server.close();
  }
  const retained = controller.snapshot().usage;
  for (const failure of ['invalid', 'incomplete', 'empty'] as const) {
    mode = failure;
    context.clock.advance(60000);
    assert.equal((await controller.execute(refresh(), 'local-owner')).reason, 'usage-read-failed');
    assert.deepEqual(controller.snapshot().usage, retained);
  }
  const attemptedAt = controller.snapshot().usageReaders[0]?.lastAttemptAt;
  await controller.close();
  controller = new Controller({
    ...options,
    home: options.home as string,
    now: context.clock.now,
    id: context.id,
  });
  assert.equal(controller.snapshot().usageReaders[0]?.available, true);
  assert.equal(controller.snapshot().usageReaders[0]?.lastAttemptAt, attemptedAt);
  assert.equal(
    (await controller.execute(refresh(), 'local-owner')).reason,
    'usage-reader-cooldown',
  );
  context.clock.advance(60000);
  available = false;
  assert.equal((await controller.execute(refresh(), 'local-owner')).reason, 'client-unavailable');
  assert.equal(
    (await controller.execute(refresh(), 'local-owner')).reason,
    'usage-reader-cooldown',
  );
  available = true;
  mode = 'success';
  context.clock.advance(60000);
  const googleRoute = context.fixtures.snapshot.routes.find((route) => route.family === 'google');
  assert(googleRoute);
  controller.store.transaction(() => {
    controller.store.db
      .prepare("DELETE FROM entities WHERE kind='window' AND id=?")
      .run(`${googleRoute.id}/weekly`);
    for (const { observation } of controller
      .snapshot()
      .usage.filter(({ observation }) => observation.routeId === displayRoute.id)) {
      const mapped = { ...observation, routeId: googleRoute.id };
      controller.store.put('window', `${googleRoute.id}/${mapped.windowId}`, 0, mapped);
    }
  });
  const task = TaskSchema.parse((await controller.execute(context.draft, 'local-owner')).entity);
  const prepared = await controller.execute(
    context.command(
      'PrepareRun',
      {
        taskId: task.id,
        policy: {
          ...context.fixtures.policy,
          quality: 'quick',
          methods: [],
          effects: context.fixtures.policy.effects.map((grant) => ({ ...grant, taskId: task.id })),
        },
        roles: [
          { role: 'coder', routeId: googleRoute.id, pinned: false, approvedFallbacks: [] },
          {
            role: 'advisor',
            routeId: context.fixtures.snapshot.routes[0].id,
            pinned: false,
            approvedFallbacks: [],
          },
        ],
      },
      task.revision,
    ),
    'local-owner',
  );
  assert.equal(prepared.outcome, 'applied', canonicalJson(prepared));
  const run = RunSchema.parse(prepared.entity);
  controller.store.transaction(() =>
    controller.store.put('route', googleRoute.id, 0, { ...googleRoute, fake: false }),
  );
  const setupId = context.id('cmd');
  controller.store.transaction(() =>
    controller.store.beginGoogleMetadata(setupId, 'acp-discover', 7, context.clock.now()),
  );
  assert.equal(controller.refreshGoogleUsage('start'), undefined);
  assert.equal(
    (await controller.execute(refresh(), 'local-owner')).reason,
    'google-operation-active',
  );
  controller.store.transaction(() => {
    assert.equal(controller.store.googleStartBlocker(googleRoute.id), 'google-operation-active');
  });
  const startCommand = context.command(
    'StartRun',
    { taskId: task.id, runId: run.id },
    prepared.revision,
  );
  assert.equal(
    (await controller.execute(startCommand, 'local-owner')).reason,
    'google-operation-active',
  );
  assert.equal(controller.store.intents().length, 0);
  controller.store.transaction(() =>
    controller.store.finishGoogleMetadata(setupId, null, context.clock.now()),
  );
  const writer = {
    id: context.id('att'),
    runId: run.id,
    routeId: googleRoute.id,
    generation: 0,
    state: 'intent' as const,
    revision: 0,
  };
  controller.store.transaction(() => {
    controller.store.put('attempt', writer.id, 0, writer);
    controller.store.db
      .prepare(
        "INSERT INTO launch_intents(attempt_id,task_id,run_id,route_id,generation,scratch_path,state,admitted_at) VALUES (?,?,?,?,0,?,'intent',?)",
      )
      .run(writer.id, task.id, run.id, displayRoute.id, context.directory, context.clock.now());
    assert.throws(
      () =>
        controller.store.beginGoogleMetadata(
          context.id('cmd'),
          'acp-initialize',
          0,
          context.clock.now(),
        ),
      /google-operation-active/,
    );
  });
  assert.equal(controller.refreshGoogleUsage('start'), undefined);
  assert.equal(
    (await controller.execute(refresh(), 'local-owner')).reason,
    'google-operation-active',
  );
  controller.store.transaction(() =>
    controller.store.db
      .prepare("UPDATE launch_intents SET state='outcome-unknown' WHERE attempt_id=?")
      .run(writer.id),
  );
  assert.equal(
    (await controller.execute(refresh(), 'local-owner')).reason,
    'google-ownership-unknown',
  );
  controller.store.transaction(() =>
    controller.store.db.prepare('DELETE FROM launch_intents WHERE attempt_id=?').run(writer.id),
  );
  assert.equal((await controller.execute(refresh(), 'local-owner')).outcome, 'applied');
  context.clock.advance(60000);
  const priorObservations = controller.snapshot().usage;
  const closingRead = controller.execute(refresh(), 'local-owner');
  const closing = controller.close();
  assert.equal((await closingRead).reason, 'usage-read-revoked');
  await closing;
  controller = new Controller({
    ...options,
    home: options.home as string,
    now: context.clock.now,
    id: context.id,
  });
  assert.deepEqual(controller.snapshot().usage, priorObservations);
  assert.equal(controller.store.googleMetadataOperations().at(-1)?.state, 'quiescent');
  context.clock.advance(60000);
  const absentGroup = controller.store
    .googleMetadataOperations()
    .find((row) => row.process_group)?.process_group;
  assert(absentGroup && groupAbsent(absentGroup));
  const closedCommand = refresh();
  controller.store.transaction(() => {
    controller.store.beginGoogleMetadata(
      closedCommand.key as string,
      'usage',
      controller.store.googleUsageReader().authority_revision,
      context.clock.now(),
    );
    controller.store.ownGoogleMetadata(closedCommand.key as string, absentGroup);
    controller.store.saveReceipt(
      closedCommand.key as string,
      hashCanonical(closedCommand),
      'local-owner',
      { outcome: 'outcome-unknown', reason: 'usage-read-pending' },
    );
  });
  await controller.close();
  const recoveryLaunches = launches;
  const originalKill = process.kill;
  let historicalProbes = 0;
  process.kill = (pid, signal) => {
    if (pid === -absentGroup) {
      historicalProbes++;
      throw new Error('A historical metadata group cannot establish stream closure.');
    }
    return originalKill(pid, signal);
  };
  try {
    controller = new Controller({
      ...options,
      home: options.home as string,
      now: context.clock.now,
      id: context.id,
    });
  } finally {
    process.kill = originalKill;
  }
  assert.equal(historicalProbes, 0);
  assert.equal(
    controller.store.googleMetadataOperations().find((row) => row.command_id === closedCommand.key)
      ?.state,
    'unknown',
  );
  assert.equal(
    (await controller.execute(closedCommand, 'local-owner')).reason,
    'google-ownership-unknown',
  );
  assert.equal(
    (await controller.execute(refresh(), 'local-owner')).reason,
    'google-ownership-unknown',
  );
  assert.equal(launches, recoveryLaunches);
  await controller.close();
  const unknownHome = join(context.directory, 'unknown-home');
  controller = new Controller({
    ...options,
    home: unknownHome,
    now: context.clock.now,
    id: context.id,
  });
  const interrupted = refresh();
  controller.store.transaction(() => {
    controller.store.beginGoogleMetadata(
      interrupted.key as string,
      'usage',
      controller.store.googleUsageReader().authority_revision,
      context.clock.now(),
    );
    controller.store.saveReceipt(
      interrupted.key as string,
      hashCanonical(interrupted),
      'local-owner',
      { outcome: 'outcome-unknown', reason: 'usage-read-pending' },
    );
  });
  assert.equal(
    (await controller.execute(interrupted, 'local-owner')).reason,
    'google-ownership-unknown',
  );
  assert.equal(
    controller.store.receipt(interrupted.key as string)?.result.reason,
    'google-ownership-unknown',
  );
  await controller.close();
  const beforeRecovery = launches;
  controller = new Controller({
    ...options,
    home: unknownHome,
    now: context.clock.now,
    id: context.id,
  });
  assert.equal(
    controller.store.googleMetadataOperations().find((row) => row.command_id === interrupted.key)
      ?.state,
    'unknown',
  );
  assert.equal(
    (await controller.execute(refresh(), 'local-owner')).reason,
    'google-ownership-unknown',
  );
  assert.equal(launches, beforeRecovery);
});

test('an acp scratch permission binds one live action and crash recovery cannot invent completion', async (t) => {
  for (const row of [
    'approved',
    'hunk-approved',
    'hunk-after-mismatch',
    'denied',
    'stop',
    'eof',
    'preflight',
    'refresh-missing',
    'refresh-stale',
    'refresh-unknown',
    'refresh-reset',
    'fresh-zero',
    'refresh-zero',
    'cooldown',
    'invalid-read',
    'unavailable',
    'active-owner',
    'unknown-owner',
    'stop-read',
    'close-read',
    'deadline-read',
    'source-read',
    'proof-read',
    'profile-read',
    'unrelated-read',
    'reserve',
    'missing-reserve',
  ] as const) {
    const hunk = row.startsWith('hunk-');
    const scenario =
      row === 'hunk-approved'
        ? 'hunk'
        : row === 'hunk-after-mismatch'
          ? row
          : row === 'eof'
            ? 'eof-cancel'
            : row === 'stop'
              ? 'cancel-permission'
              : 'permission';
    const fixtureHome = mkdtempSync(resolve('internal/acp-controller-'));
    t.after(() => rmSync(fixtureHome, { recursive: true, force: true }));
    const executable = join(fixtureHome, 'peer');
    const peer = new URL('../../../../packages/testkit/src/providers/acp-peer.ts', import.meta.url)
      .href;
    writeFileSync(
      executable,
      `#!${process.execPath}\nimport {runAcpPeer} from ${JSON.stringify(peer)};runAcpPeer(${JSON.stringify(scenario)});\n`,
      { mode: 0o500 },
    );
    const harness = '#!/bin/sh\nexit 99\n';
    writeFileSync(join(fixtureHome, 'localharness_external'), harness, { mode: 0o500 });
    const client = {
      executable,
      harnessSha256: createHash('sha256').update(harness).digest('hex'),
      version: '1.4.0' as const,
      signerTeamId: 'TESTTEAM01',
      sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    };
    const mapping = {
      client: acpClientPin(client),
      surface: 'config' as const,
      configId: 'mode-slot',
      valueId: 'fixture-review',
      semantics: 'request-review' as const,
      evidenceHash: 'e'.repeat(64),
    };
    let liveController: Controller | undefined;
    let interruptSetup = false;
    let setupStop: Promise<CommandResult> | undefined;
    let quotaReads = 0;
    let acpLaunches = 0;
    let profileAvailable = true;
    let quotaAction: (() => void) | undefined;
    let quotaReset = '2026-10-24T17:00:00.000Z';
    const planningProfile = {
      ...unavailableNativeProfile(),
      facts: {
        ...unavailableNativeProfile().facts,
        available: true,
        reason: 'available',
        model: fixtureModel,
        clientVersion: process.version,
      },
      client: { executable: process.execPath, sha256: fixtureClientHash, version: process.version },
      environment: { ...process.env },
      locationHash: '1'.repeat(64),
    } satisfies NativeProfileResolution;
    const options: Partial<ControllerOptions> = {
      nativeProfiles: () => (row === 'approved' ? [planningProfile] : []),
      googleUsageClient: () =>
        row === 'unavailable'
          ? { available: false, reason: 'client-unavailable' }
          : {
              available: true,
              reason: 'available',
              client: { executable: process.execPath, version: '1.4.0', sha256: fixtureClientHash },
              environment: { HOME: userInfo().homedir },
            },
      googleUsageSpawn: (_executable, args, spawnOptions) => {
        quotaReads++;
        assert.equal(args[1], '/usage');
        assert.equal(liveController?.store.intents().length, 0);
        assert.equal(liveController?.store.googleMetadataOperations().at(-1)?.state, 'intent');
        const report = {
          status: 'SUCCESS',
          num_turns: 0,
          command: {
            data: {
              groups: [
                {
                  buckets: [
                    {
                      id: 'quota',
                      remaining_fraction: 0.8,
                      reset_time: quotaReset,
                    },
                    {
                      id: 'satellite',
                      remaining_fraction: row === 'refresh-zero' ? 0 : 0.7,
                      reset_time: quotaReset,
                    },
                  ],
                },
              ],
            },
          },
        };
        const child = spawn(
          process.execPath,
          [
            '-e',
            `process.stdout.write(${JSON.stringify(JSON.stringify(row === 'invalid-read' ? {} : report))})`,
          ],
          spawnOptions,
        );
        if (quotaAction) queueMicrotask(quotaAction);
        return child;
      },
      googleAcp: {
        reviewMappings: [mapping],
        toolMappings: [
          hunk
            ? {
                client: { ...acpClientPin(client), harnessSha256: client.harnessSha256 },
                toolTitle: 'Run replace_file_content?',
                schema: 'replace-hunk-v1',
                evidenceHash: 'f'.repeat(64),
              }
            : {
                client: acpClientPin(client),
                toolName: 'fixture-replace',
                schema: 'replace-target-v1',
                evidenceHash: 'f'.repeat(64),
              },
        ],
        spawn: (...args) => {
          acpLaunches++;
          const child = spawn(...args);
          if (interruptSetup) {
            interruptSetup = false;
            queueMicrotask(() => {
              const current = liveController?.store.googleAcpSetup();
              assert(current?.operationId);
              setupStop = liveController?.execute(
                CommandSchema.parse({
                  protocol: 1,
                  key: liveController.id('cmd'),
                  actor: { id: 'terminal', kind: 'cli' },
                  command: 'StopGoogleAcpSetup',
                  expectedRevision: current.revision,
                  payload: { profileId: 'google-acp-v1', operationId: current.operationId },
                }),
                'local-owner',
              );
            });
          }
          return child;
        },
        resolve: (proof: AcpSetupProof | null) => {
          const config = proof?.configOptions ?? null;
          const available =
            profileAvailable && !!proof?.reviewMode && proof.auth.status === 'authenticated';
          return {
            client,
            environment: { HOME: userInfo().homedir, PATH: process.env.PATH },
            facts: GoogleAcpProfileSchema.parse({
              id: 'google-acp-v1',
              family: 'google',
              displayName: 'Google ACP single-file proposal',
              clientVersion: '1.4.0',
              model: config?.model.currentValue ?? 'unknown',
              effort: config?.thoughtLevel?.currentValue ?? 'unknown',
              effortSupported: config?.thoughtLevel?.supported ?? [],
              effectiveEffort: 'unknown',
              accountClass: 'unknown',
              serviceTier: 'unknown',
              billingBasis: 'requires-user-attestation',
              qualifiedAt: null,
              creditPolicies: ['ordinary'],
              permissionModes: ['request-review'],
              maximumTaskMs: 300000,
              maximumFileBytes: 65536,
              maximumSubmissions: 1,
              available,
              reason: available ? 'qualification-pending' : 'acp-capability-missing',
              configOptions: config,
              capabilities: proof?.capabilities ?? null,
            }),
          };
        },
      },
    };
    const context = await setup(t, options);
    let controller = context.controller;
    liveController = controller;
    const { command, source, fixtures, clock, id } = context;
    const original = 'export const total = 0;\n';
    writeFileSync(join(source.directory, 'net.mjs'), original);
    git(source.directory, ['add', 'net.mjs']);
    git(source.directory, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'fixture target',
    ]);
    if (row === 'stop') {
      interruptSetup = true;
      const firstSetup = command(
        'InitializeGoogleAcp',
        { profileId: 'google-acp-v1', consent: 'explicit' },
        controller.store.googleAcpSetup().revision,
      );
      assert.equal(
        (await controller.execute(firstSetup, 'local-owner')).reason,
        'acp-setup-stopped',
      );
      assert.equal((await setupStop)?.outcome, 'applied');
      assert.equal(controller.store.googleAcpSetup().state, 'blocked');
      assert.equal(controller.store.googleMetadataOperations().at(-1)?.state, 'quiescent');
      assert.equal(
        (await controller.execute(firstSetup, 'local-owner')).reason,
        'acp-setup-stopped',
      );
    }
    for (const name of ['InitializeGoogleAcp', 'AuthenticateGoogleAcp', 'DiscoverGoogleAcp']) {
      const setup = controller.store.googleAcpSetup();
      const input = command(
        name,
        {
          profileId: 'google-acp-v1',
          consent: 'explicit',
          ...(name === 'InitializeGoogleAcp' ? {} : { proofId: setup.proofId }),
          ...(name === 'AuthenticateGoogleAcp' ? { method: 'oauth-personal' } : {}),
        },
        setup.revision,
      );
      const first = controller.execute(input, 'local-owner');
      const retry = controller.execute(input, 'local-owner');
      assert.deepEqual(await first, await retry);
      assert.equal((await first).outcome, 'applied', canonicalJson(await first));
      assert.equal((await controller.execute(input, 'local-owner')).outcome, 'already-applied');
    }
    assert.equal(controller.store.googleAcpSetup().state, 'ready');
    assert.equal(controller.store.googleMetadataOperations().length, row === 'stop' ? 4 : 3);
    assert(controller.store.googleMetadataOperations().every((row) => row.state === 'quiescent'));
    const setupLaunches = acpLaunches;
    let appointedRouteId: string | undefined;
    if (row === 'reserve' || row === 'missing-reserve') {
      appointedRouteId = id('rte');
      await controller.close();
      controller = new Controller({
        ...options,
        home: context.controller.home,
        now: clock.now,
        id: (prefix) => (prefix === 'rte' ? (appointedRouteId as string) : id(prefix)),
      });
      liveController = controller;
    }
    const task = TaskSchema.parse((await controller.execute(context.draft, 'local-owner')).entity);
    const policy = {
      ...fixtures.policy,
      quality: 'quick',
      ...(row === 'fresh-zero'
        ? { unknownUsage: { rule: 'fixed-allowance', allowance: { launches: 10, minutes: 5 } } }
        : {}),
      methods: [{ id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' }],
      reserves: appointedRouteId
        ? [
            {
              routeId: appointedRouteId,
              windowId: row === 'missing-reserve' ? 'missing' : 'quota',
              value: 25,
              unit: 'percent',
            },
          ]
        : [],
      limits: { attempts: 4, minutes: 5, concurrency: 1 },
      effects: fixtures.policy.effects.map((grant) => ({ ...grant, taskId: task.id })),
    };
    const prepareAcpTask = (target: ReturnType<typeof TaskSchema.parse>) =>
      command(
        'PrepareNativeRun',
        {
          taskId: target.id,
          profileId: 'google-acp-v1',
          proofId: controller.store.googleAcpSetup().proofId,
          modelId: 'fixture-model',
          thoughtLevelId: 'fixture-low',
          targetPath: 'net.mjs',
          consent: 'explicit',
          permissionMode: 'request-review',
          billingAttestation: {
            source: 'user-attested',
            subscriptionLoginConfirmed: true,
            paidExtraUsageDisabled: true,
            quotaAccountConfirmed: true,
          },
          policy: {
            ...policy,
            effects: policy.effects.map((grant) => ({ ...grant, taskId: target.id })),
          },
        },
        target.revision,
      );
    if (row === 'approved') {
      const planningTask = TaskSchema.parse(
        (
          await controller.execute(
            command(
              'CreateTask',
              {
                projectId: task.projectId,
                title: 'Confirm the plan before native preparation',
                outcome: task.outcome,
                criteria: task.criteria,
              },
              0,
            ),
            'local-owner',
          )
        ).entity,
      );
      const configured = await controller.execute(
        command(
          'ConfigureTaskConversation',
          {
            taskId: planningTask.id,
            planning: {
              role: 'lead',
              profileId: 'openai-file-v1',
              creditPolicy: 'ordinary',
              limits: policy.limits,
              consent: 'explicit',
            },
          },
          planningTask.revision,
        ),
        'local-owner',
      );
      assert.equal(configured.outcome, 'applied');
      const unconfirmed = await controller.execute(
        prepareAcpTask(TaskSchema.parse(configured.entity)),
        'local-owner',
      );
      assert.equal(unconfirmed.reason, 'task-contract-unconfirmed');
      assert.equal(unconfirmed.next, 'Review and adopt a plan before preparing execution.');
      assert.equal(controller.store.intents().length, 0);
      assert.equal(acpLaunches, setupLaunches);
    }
    const prepared = await controller.execute(prepareAcpTask(task), 'local-owner');
    assert.equal(prepared.outcome, 'applied', canonicalJson(prepared));
    const run = RunSchema.parse(prepared.entity);
    const start = () =>
      command('StartRun', { taskId: task.id, runId: run.id }, taskRevision(controller, task.id));
    quotaReset = new Date(Date.parse(clock.now()) + 3600000).toISOString();
    const autoRefresh = ![
      'approved',
      'denied',
      'stop',
      'eof',
      'preflight',
      'fresh-zero',
      'reserve',
    ].includes(row);
    controller.store.transaction(() => {
      controller.store.recordGoogleUsageObservation(clock.now());
      const observation = {
        routeId: run.roles[0].routeId,
        windowId: 'quota',
        kind: 'weekly',
        remaining:
          row === 'refresh-unknown'
            ? null
            : { value: row === 'fresh-zero' ? 0 : row === 'reserve' ? 20 : 80, unit: 'percent' },
        resetsAt: row === 'refresh-reset' ? clock.now() : quotaReset,
        observedAt:
          autoRefresh && row !== 'refresh-unknown' && row !== 'refresh-reset'
            ? new Date(Date.parse(clock.now()) - 300001).toISOString()
            : clock.now(),
        source: 'client',
        confidence: 'reported',
      };
      if (row !== 'refresh-missing' && row !== 'refresh-zero')
        controller.store.put('window', `${run.roles[0].routeId}/quota`, 0, observation);
      if (row === 'fresh-zero')
        controller.store.put('window', `${run.roles[0].routeId}/old`, 0, {
          ...observation,
          windowId: 'old',
          remaining: null,
        });
      if (row === 'cooldown' || row === 'approved')
        controller.store.recordGoogleUsageAttempt(clock.now());
      if (row === 'active-owner' || row === 'unknown-owner') {
        const key = id('cmd');
        controller.store.beginGoogleMetadata(
          key,
          'usage',
          controller.store.googleUsageReader().authority_revision,
          clock.now(),
        );
        if (row === 'unknown-owner') controller.store.unknownGoogleMetadata(key);
      }
    });
    let closeDuringRead: Promise<void> | undefined;
    let cancellation: Promise<unknown> | undefined;
    if (
      [
        'stop-read',
        'close-read',
        'deadline-read',
        'source-read',
        'proof-read',
        'profile-read',
      ].includes(row)
    )
      quotaAction = () => {
        if (row === 'stop-read')
          cancellation = controller.execute(
            command(
              'StopRun',
              { taskId: task.id, runId: run.id },
              taskRevision(controller, task.id),
            ),
            'local-owner',
          );
        if (row === 'close-read') closeDuringRead = Promise.resolve(controller.close());
        if (row === 'deadline-read') clock.advance(30001);
        if (row === 'profile-read') profileAvailable = false;
        if (row === 'source-read')
          writeFileSync(join(source.directory, 'net.mjs'), 'source changed');
        if (row === 'proof-read')
          controller.store.transaction(() => {
            const setup = controller.store.googleAcpSetup();
            controller.store.putGoogleAcpSetup({ ...setup, revision: setup.revision + 1 });
          });
      };
    if (row === 'unrelated-read') {
      let pendingStart: Promise<CommandResult> | undefined;
      let pendingStop: Promise<CommandResult> | undefined;
      quotaAction = () => {
        pendingStart = controller.execute(start(), 'local-owner');
        pendingStop = controller.execute(
          command('StopRun', { taskId: task.id, runId: run.id }, taskRevision(controller, task.id)),
          'local-owner',
        );
      };
      const manual = await controller.execute(
        command('ObserveUsage', { family: 'google' }, 0),
        'local-owner',
      );
      assert.equal(manual.outcome, 'applied');
      assert.equal((await pendingStop)?.outcome, 'applied');
      assert.notEqual((await pendingStart)?.outcome, 'applied');
      assert.equal(controller.store.intents().length, 0);
      assert.equal(controller.store.googleMetadataOperations().at(-1)?.state, 'quiescent');
      assert.equal(quotaReads, 1);
      assert.equal(acpLaunches, setupLaunches);
      await controller.close();
      continue;
    }
    const blockedRows = [
      'fresh-zero',
      'reserve',
      'refresh-zero',
      'missing-reserve',
      'cooldown',
      'invalid-read',
      'unavailable',
      'active-owner',
      'unknown-owner',
      'stop-read',
      'close-read',
      'deadline-read',
      'source-read',
      'proof-read',
      'profile-read',
    ];
    if (blockedRows.includes(row)) {
      const before = controller.snapshot().usage;
      const input = start();
      const first = controller.execute(input, 'local-owner');
      const repeated = controller.execute(input, 'local-owner');
      const refused = await first;
      assert.deepEqual(await repeated, refused);
      assert.notEqual(refused.outcome, 'applied', row);
      if (cancellation) await cancellation;
      if (closeDuringRead) {
        await closeDuringRead;
        controller = new Controller({
          ...options,
          home: context.controller.home,
          now: clock.now,
          id,
        });
        liveController = controller;
      }
      assert.equal(controller.store.intents().length, 0, row);
      assert.equal(acpLaunches, setupLaunches, row);
      assert.equal(controller.store.receipt(input.key)?.hash, hashCanonical(input));
      assert.deepEqual(await controller.execute(input, 'local-owner'), refused);
      assert.equal(
        quotaReads,
        [
          'fresh-zero',
          'reserve',
          'cooldown',
          'unavailable',
          'active-owner',
          'unknown-owner',
        ].includes(row)
          ? 0
          : 1,
        row,
      );
      if (['invalid-read', 'unavailable', 'cooldown', 'stop-read', 'close-read'].includes(row))
        assert.deepEqual(controller.snapshot().usage, before, row);
      if (['invalid-read', 'unavailable', 'stop-read', 'close-read'].includes(row))
        assert.equal(controller.store.googleUsageReader().last_attempt_at, context.clock.now());
      if (row === 'invalid-read' || row === 'unavailable') {
        const beforeRetry = quotaReads;
        assert.equal(
          (await controller.execute(start(), 'local-owner')).reason,
          'usage-reader-cooldown',
        );
        assert.equal(quotaReads, beforeRetry);
      }
      if (row === 'unknown-owner') {
        await controller.close();
        controller = new Controller({
          ...options,
          home: context.controller.home,
          now: clock.now,
          id,
        });
        liveController = controller;
        assert.equal(
          (await controller.execute(start(), 'local-owner')).reason,
          'google-ownership-unknown',
        );
        assert.equal(quotaReads, 0);
      }
      if (row === 'cooldown') assert.equal(refused.reason, 'usage-reader-cooldown');
      if (row === 'unknown-owner') assert.equal(refused.reason, 'google-ownership-unknown');
      if (row === 'active-owner') assert.equal(refused.reason, 'google-operation-active');
      if (row === 'deadline-read') assert.equal(refused.reason, 'acp-start-deadline');
      await controller.close();
      continue;
    }
    if (row === 'preflight') {
      const input = start();
      const pending = controller.execute(input, 'local-owner');
      assert.equal(
        (
          await controller.execute(
            command(
              'StopRun',
              { taskId: task.id, runId: run.id },
              taskRevision(controller, task.id),
            ),
            'local-owner',
          )
        ).outcome,
        'applied',
      );
      const refused = await pending;
      assert.notEqual(refused.outcome, 'applied');
      assert.deepEqual(await controller.execute(input, 'local-owner'), refused);
      assert.equal(
        (
          await controller.execute(
            { ...input, payload: { taskId: task.id, runId: id('run') } },
            'local-owner',
          )
        ).reason,
        'idempotency-key-reused',
      );
      assert.equal(controller.store.intents().length, 0);
      assert.equal(controller.store.receipt(input.key)?.hash, hashCanonical(input));
      await controller.close();
      continue;
    }
    const permission = Promise.withResolvers<Approval>();
    const readyToCancel = Promise.withResolvers<void>();
    const off = controller.subscribe((event) => {
      if (event.type === 'approval.requested') permission.resolve(event.payload);
      if (event.type === 'attempt.output' && event.payload.text === 'fixture-ready-to-cancel')
        readyToCancel.resolve();
    });
    t.after(off);
    const input = start();
    const first = controller.execute(input, 'local-owner');
    const retry = controller.execute(input, 'local-owner');
    assert.equal(
      (
        await controller.execute(
          command(
            'StopRun',
            { taskId: task.id, runId: id('run') },
            taskRevision(controller, task.id),
          ),
          'local-owner',
        )
      ).reason,
      'run-not-current',
    );
    assert.equal((await controller.execute(start(), 'local-owner')).reason, 'acp-start-preparing');
    assert.deepEqual(await first, await retry);
    assert.equal((await first).outcome, 'applied', canonicalJson(await first));
    assert.equal(quotaReads, autoRefresh ? 1 : 0, row);
    if (autoRefresh) {
      assert.equal(controller.store.googleMetadataOperations().at(-1)?.kind, 'usage');
      assert.equal(controller.store.googleMetadataOperations().at(-1)?.state, 'quiescent');
      assert.equal(
        controller
          .snapshot()
          .usage.filter(({ observation }) => observation.routeId === run.roles[0].routeId).length,
        2,
      );
      assert.equal(controller.store.intents().length, 1);
    }
    if (row === 'eof') {
      await nativeWait('acp cancellation readiness', readyToCancel.promise);
      const terminal = Promise.withResolvers<void>();
      const offUnknown = controller.subscribe((event) => {
        if (event.type === 'task.updated' && event.payload.state === 'unknown') terminal.resolve();
      });
      t.after(offUnknown);
      assert.equal(
        (
          await controller.execute(
            command(
              'StopRun',
              { taskId: task.id, runId: run.id },
              taskRevision(controller, task.id),
            ),
            'local-owner',
          )
        ).outcome,
        'applied',
      );
      await nativeWait('acp eof ownership', terminal.promise);
      const attemptId = controller.store.intents()[0].attempt_id;
      assert.equal(controller.store.get<Attempt>('attempt', attemptId)?.state, 'unknown');
      assert.equal(controller.store.receipt(`native-acp-terminal:${attemptId}`), undefined);
      await controller.close();
      controller = new Controller({
        ...options,
        home: context.controller.home,
        now: clock.now,
        id,
      });
      assert.equal(controller.store.get<Attempt>('attempt', attemptId)?.state, 'unknown');
      assert.equal(
        controller.store.transaction(() =>
          controller.store.googleStartBlocker(run.roles[0].routeId),
        ),
        'google-ownership-unknown',
      );
      await controller.close();
      continue;
    }
    const approval = await nativeWait('acp permission', permission.promise);
    assert.equal(approval.action, 'write-scratch');
    assert.equal(approval.target, 'net.mjs');
    assert.equal(approval.acpTarget?.kind, 'allow_once');
    const action = JSON.parse(approval.consequence);
    const expectedContent = 'export const total = 1;\n';
    assert.equal(action.type, hunk ? 'replace-hunk' : 'replace-target');
    assert.equal(action.oldText, hunk ? '0' : original);
    assert.equal(action.newText, hunk ? '1' : expectedContent);
    if (hunk) {
      assert.equal(action.baseHash, createHash('sha256').update(original).digest('hex'));
      assert.equal(action.afterHash, createHash('sha256').update(expectedContent).digest('hex'));
      assert.equal(action.mode, '100644');
    }
    assert(Buffer.byteLength(approval.consequence) <= 4096);
    const {
      requester: _requester,
      consequence: _consequence,
      status: _status,
      ...binding
    } = approval;
    const resolveApproval = (value: unknown = binding) =>
      command(
        'ResolveApproval',
        { binding: value, decision: 'approved' },
        taskRevision(controller, task.id),
      );
    assert.equal(
      (
        await controller.execute(
          resolveApproval({
            ...binding,
            acpTarget: { ...binding.acpTarget, kind: 'allow_always' },
          }),
          'local-owner',
        )
      ).outcome,
      'unsupported',
    );
    assert.equal(
      (
        await controller.execute(
          resolveApproval({ ...binding, generation: binding.generation + 1 }),
          'local-owner',
        )
      ).outcome,
      'denied',
    );
    const pendingAuthority = controller.store.db
      .prepare('SELECT * FROM pending_effects WHERE approval_id=?')
      .get(approval.approvalId);
    const pendingRevision = taskRevision(controller, task.id);
    for (const name of ['SendTaskMessage', 'QueueTaskGuidance', 'AnswerTaskQuestion']) {
      const result = await controller.execute(
        command(
          name,
          {
            taskId: task.id,
            text: 'Keep this pending action unchanged.',
            ...(name === 'AnswerTaskQuestion' ? { questionId: id('msg') } : {}),
          },
          pendingRevision,
        ),
        'local-owner',
      );
      assert.equal(result.reason, 'effects-unresolved');
      assert.equal(taskRevision(controller, task.id), pendingRevision);
      assert.deepEqual(
        controller.store.db
          .prepare('SELECT * FROM pending_effects WHERE approval_id=?')
          .get(approval.approvalId),
        pendingAuthority,
      );
    }
    const intent = controller.store.intents()[0];
    assert.equal(controller.store.nativeProfileId(intent.attempt_id), 'google-acp-v1');
    assert.deepEqual(
      controller.store.nativeProcesses(intent.attempt_id).map((phase) => phase.phase),
      ['google-acp-task'],
    );
    writeFileSync(join(intent.scratch_path, 'net.mjs'), 'changed');
    assert.equal((await controller.execute(resolveApproval(), 'local-owner')).outcome, 'blocked');
    writeFileSync(join(intent.scratch_path, 'net.mjs'), original);
    if (row !== 'approved' && !hunk) {
      const terminal = Promise.withResolvers<void>();
      const offTerminal = controller.subscribe((event) => {
        if (
          event.type === 'task.updated' &&
          ['interrupted', 'unknown', 'stopped'].includes(event.payload.state)
        )
          terminal.resolve();
      });
      t.after(offTerminal);
      const ending =
        row === 'denied'
          ? command(
              'ResolveApproval',
              { binding, decision: 'denied' },
              taskRevision(controller, task.id),
            )
          : command(
              'StopRun',
              { taskId: task.id, runId: run.id },
              taskRevision(controller, task.id),
            );
      assert.equal((await controller.execute(ending, 'local-owner')).outcome, 'applied');
      await nativeWait(`acp ${row}`, terminal.promise);
      assert.equal(controller.store.receipt(`native-acp-capture:${intent.attempt_id}`), undefined);
      await controller.close();
      controller = new Controller({
        ...options,
        home: context.controller.home,
        now: clock.now,
        id,
      });
      assert.equal(controller.store.get<Attempt>('attempt', intent.attempt_id)?.state, 'stopped');
      assert.equal(controller.store.intents().length, 1);
      assert.equal(
        controller.store.get<Approval>('approval', approval.approvalId)?.status,
        'denied',
      );
      assert.equal(readFileSync(join(source.directory, 'net.mjs'), 'utf8'), original);
      await controller.close();
      continue;
    }
    const sealed = nativeCandidate(controller);
    assert.equal((await controller.execute(resolveApproval(), 'local-owner')).outcome, 'applied');
    await nativeWait('acp capture', sealed);
    assert.equal(controller.store.intents().length, 1);
    if (row === 'hunk-after-mismatch') {
      assert.equal(controller.store.receipt(`native-acp-capture:${intent.attempt_id}`), undefined);
      assert.equal(controller.snapshot().tasks[0].state, 'interrupted');
      assert.equal(
        controller.store.get<Approval>('approval', approval.approvalId)?.status,
        'approved',
      );
      assert.equal(controller.store.get<Attempt>('attempt', intent.attempt_id)?.state, 'stopped');
      assert.equal(readFileSync(join(source.directory, 'net.mjs'), 'utf8'), original);
      assert.equal(
        readFileSync(join(intent.scratch_path, 'net.mjs'), 'utf8'),
        'export const total = 2;\n',
      );
      await controller.close();
      controller = new Controller({
        ...options,
        home: context.controller.home,
        now: clock.now,
        id,
      });
      assert.equal(controller.store.receipt(`native-acp-capture:${intent.attempt_id}`), undefined);
      assert.equal(controller.store.get<Attempt>('attempt', intent.attempt_id)?.state, 'stopped');
      assert.equal(controller.snapshot().tasks[0].state, 'interrupted');
      assert.equal(controller.store.intents().length, 1);
      await controller.close();
      continue;
    }
    assert(controller.store.receipt(`native-acp-capture:${intent.attempt_id}`));
    assert.equal(controller.snapshot().tasks[0].state, 'stopped');
    assert.equal(readFileSync(join(source.directory, 'net.mjs'), 'utf8'), original);
    assert.equal(readFileSync(join(intent.scratch_path, 'net.mjs'), 'utf8'), expectedContent);
    assert.equal((await controller.execute(input, 'local-owner')).outcome, 'already-applied');
    await controller.close();
    controller = new Controller({ ...options, home: context.controller.home, now: clock.now, id });
    assert.equal(controller.snapshot().tasks[0].state, 'stopped');
    assert.equal(controller.store.intents().length, 1);
    const currentSetup = controller.store.googleAcpSetup();
    const orphanSetup = command(
      'InitializeGoogleAcp',
      { profileId: 'google-acp-v1', consent: 'explicit' },
      currentSetup.revision,
    );
    controller.store.transaction(() => {
      controller.store.putGoogleAcpSetup({
        ...currentSetup,
        revision: currentSetup.revision + 1,
        state: 'initializing',
        operationId: orphanSetup.key,
      });
      controller.store.beginGoogleMetadata(
        orphanSetup.key,
        'acp-initialize',
        currentSetup.revision + 1,
        clock.now(),
      );
      controller.store.saveReceipt(orphanSetup.key, hashCanonical(orphanSetup), 'local-owner', {
        outcome: 'outcome-unknown',
        reason: 'acp-setup-pending',
      });
    });
    assert.equal(
      (await controller.execute(orphanSetup, 'local-owner')).reason,
      'google-ownership-unknown',
    );
    assert.equal(controller.store.googleAcpSetup().state, 'unknown');
    assert.equal(controller.store.googleMetadataOperations().at(-1)?.state, 'unknown');
    controller.store.transaction(() => {
      controller.store.db
        .prepare('DELETE FROM receipts WHERE command_key=?')
        .run(`native-acp-terminal:${intent.attempt_id}`);
      const attempt = controller.store.get<Attempt>('attempt', intent.attempt_id) as Attempt;
      controller.store.put('attempt', attempt.id, attempt.revision + 1, {
        ...attempt,
        state: 'running',
        revision: attempt.revision + 1,
      });
      controller.store.db
        .prepare(
          "UPDATE launch_intents SET state='acknowledged',finished_at=NULL WHERE attempt_id=?",
        )
        .run(attempt.id);
    });
    await controller.close();
    controller = new Controller({ ...options, home: context.controller.home, now: clock.now, id });
    assert.equal(controller.store.get<Attempt>('attempt', intent.attempt_id)?.state, 'unknown');
    assert.equal(
      controller.store.transaction(() => controller.store.googleStartBlocker(run.roles[0].routeId)),
      'google-ownership-unknown',
    );
    await controller.close();
  }
});

test('planning turns keep task authority and allowance across execution', async (t) => {
  let context: Awaited<ReturnType<typeof setup>>;
  let reopened: Controller | undefined;
  let mode = 'success';
  let askQuestion = true;
  let reportedCapacity: number | null = 4096;
  let crashAfterIntent = false;
  let modelAvailability: 'available' | 'missing-model' | 'missing-effort' = 'available';
  let usageChecked = false;
  let lateUsage: (() => void) | undefined;
  const held = Promise.withResolvers<void>();
  const children: Promise<void>[] = [];
  const profile = {
    ...unavailableNativeProfile(),
    facts: {
      ...unavailableNativeProfile().facts,
      available: true,
      reason: 'available',
      model: fixtureModel,
      clientVersion: process.version,
    },
    client: { executable: process.execPath, sha256: fixtureClientHash, version: process.version },
    environment: { ...process.env },
    locationHash: '1'.repeat(64),
  } satisfies NativeProfileResolution;
  const options: Partial<ControllerOptions> = {
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
    nativeProfile: () => profile,
    afterIntent: () => {
      if (crashAfterIntent) throw Error('Interrupted after durable planning admission.');
    },
    scenarioForRoute: () => 'complete',
    nativeSpawn: (executable, args, spawnOptions) => {
      const phase =
        args.at(-1) === 'list'
          ? 'features'
          : context.controller.store
                .intents()
                .flatMap((intent) => context.controller.store.nativeProcesses(intent.attempt_id))
                .filter((value) => value.state === 'intent')
                .at(-1)?.phase === 'metadata-preparation'
            ? 'prepare'
            : 'task';
      let script = fixture.replace(
        'const path = message.params.outputSchema.properties.path.const;',
        'const path = message.params.outputSchema.properties.path?.const;',
      );
      script = script
        .replace(
          'const thread =',
          `replies['model/list'].data.push(...${JSON.stringify(
            modelAvailability === 'missing-model'
              ? []
              : [
                  {
                    id: 'fixture-secondary',
                    model: 'fixture-secondary',
                    supportedReasoningEfforts: (modelAvailability === 'missing-effort'
                      ? ['low']
                      : ['low', 'medium']
                    ).map((reasoningEffort) => ({ reasoningEffort })),
                    defaultReasoningEffort: 'low',
                  },
                ],
          )}); const thread =`,
        )
        .replace(
          "if (message.method === 'thread/start') result = thread(process.cwd());",
          "if (message.method === 'thread/start') result = {...thread(process.cwd()),model:message.params.model,reasoningEffort:message.params.config.model_reasoning_effort};",
        );
      script = script.replace(
        'const edit = {version:1,attemptId:message.params.outputSchema.properties.attemptId.const,path,baseHash:message.params.outputSchema.properties.baseHash.const,content:content(path)};',
        `const edit = {version:1,bindingHash:message.params.outputSchema.properties.bindingHash.const,message:'The bounded plan is ready.',questions:${JSON.stringify(askQuestion ? ['Keep the current export?'] : [])},proposal:{summary:'Keep the export.',criteria:${JSON.stringify(mode === 'escaped-boundary' ? Array.from({ length: 12 }, (_, index) => `${index}: ${'x'.repeat(3500)}`) : ['Preserve the source sentinels.'])},slices:[{id:'net',title:'Change the module',role:'coder',scope:['net.mjs'],dependsOn:[]}],checks:['node-tests-v1']}}${mode === 'invalid' ? '; edit.effects=[]' : ''};`,
      );
      script = script.replace(
        "['turn/completed',{threadId:'thread-1',turn:{...running,status:'completed'}}],",
        `['thread/tokenUsage/updated',{threadId:'thread-1',turnId:'turn-1',tokenUsage:{total:{totalTokens:900000},last:{totalTokens:123},modelContextWindow:${JSON.stringify(reportedCapacity)}}}],\n      ['turn/completed',{threadId:'thread-1',turn:{...running,status:'completed'}}],`,
      );
      const child = spawn(
        executable,
        ['-e', script, phase === 'task' && mode === 'hold' ? 'hold' : 'success', phase],
        spawnOptions,
      );
      if (phase === 'task' && !usageChecked)
        child.stdout.once('data', () => {
          usageChecked = true;
          const controller = context.controller;
          const intent = controller.store.intents().find((row) => row.state === 'acknowledged');
          assert.ok(intent);
          const attempt = controller.store.get<Attempt>('attempt', intent.attempt_id);
          assert.ok(attempt);
          let ownsRuntime = true;
          let current = true;
          const ingress = (
            controller as unknown as {
              providerUsage: (
                attempt: Attempt,
                current: () => void,
                ownsRuntime: () => boolean,
                phases: string[],
              ) => { usage: { onReport: (value: unknown) => void } };
            }
          ).providerUsage(
            attempt,
            () => {
              if (!current) throw Error('Changed authority.');
            },
            () => ownsRuntime,
            ['app-server-task'],
          );
          const observedAt = controller.now();
          const oldTime = new Date(Date.parse(observedAt) - 1000).toISOString();
          const observation = (windowId: string, at = oldTime): Observation => ({
            routeId: attempt.routeId,
            windowId,
            kind: 'rolling',
            remaining: { value: 80, unit: 'percent' },
            resetsAt: null,
            observedAt: at,
            source: 'client',
            confidence: 'reported',
          });
          const report = (values: Observation[], mode = 'partial', at = values[0].observedAt) =>
            ingress.usage.onReport({ mode, observedAt: at, observations: values });
          const retained = () =>
            controller.store
              .list<Observation>('window')
              .filter((value) => value.routeId === attempt.routeId && value.source === 'client');
          const originalRoute = controller.store.get<Route>('route', attempt.routeId);
          assert.ok(originalRoute);
          report([observation('observed-a'), observation('observed-b')]);
          assert.equal(retained().length, 2);
          assert.equal(retained()[0].observedAt, oldTime);
          report([
            observation('older-omitted', new Date(Date.parse(oldTime) - 1000).toISOString()),
          ]);
          const before = retained();
          const beforeConflict = controller.store.cursor();
          const equivalentTime = oldTime.replace('.000Z', 'Z');
          assert.notEqual(equivalentTime, oldTime);
          report([{ ...observation('observed-a', equivalentTime), remaining: null }], 'complete');
          assert.deepEqual(retained(), before);
          assert.equal(controller.store.cursor(), beforeConflict);
          const otherRoute = context.fixtures.snapshot.routes.find(
            (route) => route.id !== attempt.routeId,
          );
          assert.ok(otherRoute);
          for (const value of [
            { ...observation('invalid'), routeId: otherRoute.id },
            { ...observation('invalid'), source: 'fixture' },
            { ...observation('invalid'), confidence: 'estimated' },
            { ...observation('invalid'), remaining: { value: 101, unit: 'percent' } },
          ]) {
            ingress.usage.onReport({
              mode: 'partial',
              observedAt: oldTime,
              observations: [observation('would-write'), value],
            });
            assert.deepEqual(retained(), before);
          }
          report([observation('duplicate'), observation('duplicate')]);
          report(Array.from({ length: 33 }, (_, index) => observation(`over-count-${index}`)));
          report([observation('different-time')], 'partial', observedAt);
          ingress.usage.onReport({
            mode: 'partial',
            observedAt: oldTime,
            observations: [observation('extra-field')],
            authority: true,
          });
          report([observation('future', new Date(Date.parse(observedAt) + 1000).toISOString())]);
          report([{ ...observation('observed-a'), remaining: null }]);
          ownsRuntime = false;
          report([observation('unowned')]);
          ownsRuntime = true;
          current = false;
          report([observation('changed-authority')]);
          current = true;
          controller.store.db
            .prepare('UPDATE writer_leases SET generation=generation+1 WHERE task_id=?')
            .run(intent.task_id);
          report([observation('changed-lease')]);
          controller.store.db
            .prepare('UPDATE writer_leases SET generation=? WHERE task_id=?')
            .run(attempt.generation, intent.task_id);
          controller.store.transaction(() =>
            controller.store.put('attempt', attempt.id, attempt.revision, {
              ...attempt,
              state: 'unknown',
            }),
          );
          report([observation('unknown-attempt')]);
          controller.store.transaction(() =>
            controller.store.put('attempt', attempt.id, attempt.revision, attempt),
          );
          const process = controller.store.nativeProcesses(attempt.id).at(-1);
          assert.ok(process);
          controller.store.db
            .prepare(
              "UPDATE native_processes SET state='intent',pid=NULL,process_group=NULL WHERE attempt_id=? AND phase='app-server-task'",
            )
            .run(attempt.id);
          report([observation('unowned-phase')]);
          controller.store.db
            .prepare(
              "UPDATE native_processes SET state='owned',pid=?,process_group=? WHERE attempt_id=? AND phase='app-server-task'",
            )
            .run(process.pid, process.process_group, attempt.id);
          controller.store.transaction(() =>
            controller.store.put('route', attempt.routeId, 0, {
              ...originalRoute,
              model: 'changed-model',
            }),
          );
          report([observation('changed-route')]);
          controller.store.transaction(() =>
            controller.store.put('route', attempt.routeId, 0, originalRoute),
          );
          assert.deepEqual(retained(), before);
          assert.deepEqual(controller.store.get('route', attempt.routeId), originalRoute);
          report([observation('observed-a', observedAt)]);
          const cursor = controller.store.cursor();
          report([observation('observed-a', observedAt)], 'complete');
          assert.notEqual(controller.store.cursor(), cursor);
          assert.deepEqual(retained(), [observation('observed-a', observedAt)]);
          report([observation('observed-b')], 'complete');
          assert.deepEqual(retained(), [observation('observed-a', observedAt)]);
          const manual = { ...observation('manual', observedAt), source: 'manual' as const };
          controller.store.transaction(() =>
            controller.store.put('window', `${attempt.routeId}/manual`, 0, manual),
          );
          report([observation('manual')]);
          assert.deepEqual(controller.store.get('window', `${attempt.routeId}/manual`), manual);
          report([observation('observed-a', observedAt)], 'complete');
          assert.deepEqual(controller.store.get('window', `${attempt.routeId}/manual`), manual);
          lateUsage = () => report([observation('late', observedAt)]);
        });
      children.push(new Promise<void>((done) => child.once('close', () => done())));
      let output = '';
      if (phase === 'task' && mode === 'hold')
        child.stdout.on('data', (bytes: Buffer) => {
          output += bytes.toString();
          for (;;) {
            const end = output.indexOf('\n');
            if (end < 0) break;
            const line = output.slice(0, end);
            output = output.slice(end + 1);
            try {
              const value = JSON.parse(line);
              if (value.id === 11) held.resolve();
            } catch {}
          }
        });
      return child;
    },
  };
  context = await setup(t, options, async (controller) => {
    await reopened?.close();
    await controller.close();
    await Promise.all(children);
  });
  const { controller, command, fixtures, clock } = context;
  const projectId = controller.snapshot().projects[0].id;
  const planning = {
    role: 'lead',
    profileId: 'openai-file-v1',
    creditPolicy: 'ordinary',
    limits: { attempts: 12, minutes: 30, concurrency: 2 },
    consent: 'explicit',
  };
  const capturePayload = {
    projectId,
    base: context.source.base,
    selections: [{ kind: 'source-file', path: join(context.source.directory, 'net.mjs') }],
  };
  const captureCommand = command('CaptureConversationContext', capturePayload, 0);
  const capture = await controller.execute(captureCommand, 'local-owner');
  const contextArtifact = ArtifactSchema.parse(capture.entity);
  const refs = [{ artifactId: contextArtifact.id, hash: contextArtifact.hash }];
  assert.equal(capture.outcome, 'applied');
  assert.equal(
    (await controller.execute(captureCommand, 'local-owner')).outcome,
    'already-applied',
  );
  assert.equal(
    (
      await controller.execute(
        { ...captureCommand, payload: { ...capturePayload, base: '0'.repeat(40) } },
        'local-owner',
      )
    ).reason,
    'idempotency-key-reused',
  );
  assert.equal(
    (
      await controller.execute(
        command(
          'CaptureConversationContext',
          {
            ...capturePayload,
            selections: [{ kind: 'source-file', path: context.directory }],
          },
          0,
        ),
        'local-owner',
      )
    ).outcome,
    'blocked',
  );
  const beforeInvalidContext = controller.snapshot().tasks.length;
  assert.equal(
    (
      await controller.execute(
        command(
          'CreateTaskDiscussion',
          {
            projectId,
            text: 'Reject a changed context digest.',
            planning,
            context: [{ ...refs[0], hash: '0'.repeat(64) }],
          },
          0,
        ),
        'local-owner',
      )
    ).reason,
    'conversation-context-invalid',
  );
  assert.equal(controller.snapshot().tasks.length, beforeInvalidContext);
  const largeRefs: { artifactId: string; hash: string }[] = [];
  for (const [index, character] of ['"', '\\', '\t', '\n'].entries()) {
    const path = join(context.source.directory, `selected-${index}.log`);
    writeFileSync(path, character.repeat(8192));
    const result = await controller.execute(
      command(
        'CaptureConversationContext',
        {
          projectId,
          base: context.source.base,
          selections: [{ kind: 'log-file', path }],
        },
        0,
      ),
      'local-owner',
    );
    const artifact = ArtifactSchema.parse(result.entity);
    largeRefs.push({ artifactId: artifact.id, hash: artifact.hash });
    rmSync(path);
  }
  assert.equal(
    (
      await controller.execute(
        command(
          'CreateTaskDiscussion',
          {
            projectId,
            text: 'Keep every byte of selected context.',
            planning,
            context: largeRefs,
          },
          0,
        ),
        'local-owner',
      )
    ).reason,
    'conversation-context-too-large',
  );
  assert.equal(controller.snapshot().tasks.length, beforeInvalidContext);
  const oversized = TaskSchema.parse(
    (
      await controller.execute(
        command(
          'CreateTask',
          {
            projectId,
            title: 'A retained contract',
            outcome: 'Keep the full criteria.',
            criteria: Array.from({ length: 100 }, (_, index) => `${index}: ${'x'.repeat(4000)}`),
          },
          0,
        ),
        'local-owner',
      )
    ).entity,
  );
  const oversizedResult = await controller.execute(
    command('ConfigureTaskConversation', { taskId: oversized.id, planning }, oversized.revision),
    'local-owner',
  );
  assert.equal(oversizedResult.reason, 'conversation-input-too-large');
  assert.deepEqual(controller.store.get('task', oversized.id), oversized);
  assert.equal(controller.store.conversationTask(oversized.id), undefined);
  const nextReply = () =>
    new Promise<void>((done) => {
      const off = controller.subscribe((event) => {
        if (event.type === 'conversation.entry' && event.payload.kind === 'agent-message') {
          off();
          done();
        }
      });
    });
  const state = (taskId: string) =>
    TaskConversationStateSchema.parse(
      (controller as unknown as { conversationState: (id: string) => unknown }).conversationState(
        taskId,
      ),
    );
  const current = (id: string) =>
    controller.snapshot().tasks.find((task) => task.id === id) as ReturnType<
      typeof TaskSchema.parse
    >;
  const send = (name: string, taskId: string, payload: object) =>
    controller.execute(
      command(name, { taskId, ...payload }, current(taskId).revision),
      'local-owner',
    );
  askQuestion = false;
  const catalogReply = nextReply();
  const catalogTask = TaskSchema.parse(
    (
      await controller.execute(
        command(
          'CreateTaskDiscussion',
          { projectId, text: 'Use an observed planning model.', planning },
          0,
        ),
        'local-owner',
      )
    ).entity,
  );
  assert.equal(state(catalogTask.id).modelChoices?.status, 'not-observed');
  assert.equal(state(catalogTask.id).contextUsage, null);
  await catalogReply;
  assert.equal(usageChecked, true);
  const usageAfterCompletion = controller.store.list<Observation>('window');
  lateUsage?.();
  assert.deepEqual(controller.store.list<Observation>('window'), usageAfterCompletion);
  const observed = state(catalogTask.id).modelChoices;
  assert.equal(observed?.status, 'last-observed');
  assert(observed?.observation);
  assert.deepEqual(
    observed.models.map((model) => model.model),
    [fixtureModel, 'fixture-secondary'],
  );
  assert(!JSON.stringify(observed).includes(process.execPath));
  const reportedContext = state(catalogTask.id).contextUsage;
  assert(reportedContext);
  assert.equal(reportedContext.usedTokens, 123);
  assert.equal(reportedContext.capacityTokens, 4096);
  assert.equal(reportedContext.model, fixtureModel);
  assert.equal(reportedContext.runId, current(catalogTask.id).runId);
  assert.deepEqual(reportedContext.observation, observed.observation);
  const retainedContext = JSON.parse(
    new ArtifactFiles(join(controller.home, 'artifacts'))
      .read(reportedContext.observation.hash)
      .toString('utf8'),
  ).contextUsage;
  assert.deepEqual(retainedContext, {
    threadId: 'thread-1',
    turnId: 'turn-1',
    model: fixtureModel,
    usedTokens: 123,
    capacityTokens: 4096,
  });
  const catalogReference = observed.observation;
  const selectedPlanning = {
    ...planning,
    modelRequest: {
      version: 1,
      observation: catalogReference,
      model: 'fixture-secondary',
      effort: 'medium',
    },
  };
  const beforeSelection = state(catalogTask.id).budget?.remaining;
  const beforeSelectionSpawns = children.length;
  const beforeSelectionRun = current(catalogTask.id).runId;
  const tasksBeforeForeignCatalog = controller.snapshot().tasks.length;
  assert.equal(
    (
      await controller.execute(
        command(
          'CreateTaskDiscussion',
          { projectId, text: 'Reject another task catalog.', planning: selectedPlanning },
          0,
        ),
        'local-owner',
      )
    ).reason,
    'observation-stale',
  );
  assert.equal(controller.snapshot().tasks.length, tasksBeforeForeignCatalog);
  for (const [modelRequest, reason] of [
    [
      {
        ...selectedPlanning.modelRequest,
        observation: { ...catalogReference, hash: '0'.repeat(64) },
      },
      'observation-missing',
    ],
    [{ ...selectedPlanning.modelRequest, model: 'unobserved-model' }, 'model-unavailable'],
    [{ ...selectedPlanning.modelRequest, effort: 'unobserved-effort' }, 'effort-unavailable'],
  ] as const) {
    assert.equal(
      (
        await send('ConfigureTaskConversation', catalogTask.id, {
          planning: { ...planning, modelRequest },
        })
      ).reason,
      reason,
    );
  }
  assert.equal(current(catalogTask.id).runId, beforeSelectionRun);
  const configureSelection = command(
    'ConfigureTaskConversation',
    { taskId: catalogTask.id, planning: selectedPlanning },
    current(catalogTask.id).revision,
  );
  assert.equal((await controller.execute(configureSelection, 'local-owner')).outcome, 'applied');
  assert.equal(
    (await controller.execute(configureSelection, 'local-owner')).outcome,
    'already-applied',
  );
  assert.notEqual(current(catalogTask.id).runId, beforeSelectionRun);
  assert.equal(children.length, beforeSelectionSpawns);
  assert.deepEqual(state(catalogTask.id).budget?.remaining, beforeSelection);
  assert.equal(state(catalogTask.id).configuration?.requestedModel, 'fixture-secondary');
  assert.equal(state(catalogTask.id).configuration?.requestedEffort, 'medium');
  assert.equal(state(catalogTask.id).configuration?.effectiveModel, null);
  assert.equal(state(catalogTask.id).contextUsage, null);
  reportedCapacity = null;
  const selectedReply = nextReply();
  await send('SendTaskMessage', catalogTask.id, { text: 'Use the saved exact pair.' });
  const activeConfiguration = await send('ConfigureTaskConversation', catalogTask.id, {
    planning: { ...selectedPlanning, role: 'orchestrator' },
  });
  assert.equal(activeConfiguration.outcome, 'blocked');
  assert(['owner-active', 'ownership-unknown'].includes(activeConfiguration.reason ?? ''));
  assert.equal(state(catalogTask.id).configuration?.selection.role, 'lead');
  const lowerPlanning = {
    ...selectedPlanning,
    limits: { ...planning.limits, attempts: 11, minutes: 29 },
  };
  assert.equal(
    (await send('ConfigureTaskConversation', catalogTask.id, { planning: lowerPlanning })).outcome,
    'applied',
  );
  await selectedReply;
  assert.equal(state(catalogTask.id).configuration?.effectiveModel, 'fixture-secondary');
  assert.equal(state(catalogTask.id).configuration?.effectiveEffort, 'medium');
  assert.equal(state(catalogTask.id).contextUsage?.model, 'fixture-secondary');
  assert.equal(state(catalogTask.id).contextUsage?.usedTokens, 123);
  assert.equal(state(catalogTask.id).contextUsage?.capacityTokens, null);
  const selectedIntent = controller.store
    .intents()
    .filter((intent) => intent.task_id === catalogTask.id)
    .at(-1);
  assert(selectedIntent);
  const selectedInputArtifact = ArtifactSchema.parse(
    controller.store.receipt(`conversation-turn:${selectedIntent.attempt_id}`)?.result.entity,
  );
  const selectedInput = JSON.parse(
    new ArtifactFiles(join(controller.home, 'artifacts'))
      .read(selectedInputArtifact.hash)
      .toString('utf8'),
  );
  assert.equal(selectedInput.model, 'fixture-secondary');
  assert.equal(selectedInput.effort, 'medium');
  assert.deepEqual(selectedInput.selection.modelRequest, selectedPlanning.modelRequest);
  assert(
    selectedInput.selection.configurationRevision <
      (state(catalogTask.id).configuration?.revision ?? 0),
  );
  assert.equal(state(catalogTask.id).budget?.remaining.attempts, 9);
  const selectedObservation = state(catalogTask.id).modelChoices?.observation;
  for (const unavailable of ['missing-model', 'missing-effort'] as const) {
    modelAvailability = unavailable;
    const failed = new Promise<void>((done) => {
      const off = controller.subscribe((event) => {
        if (event.type === 'attempt.stopped' && event.taskId === catalogTask.id) {
          off();
          done();
        }
      });
    });
    await send('SendTaskMessage', catalogTask.id, {
      text: 'Validate the current advertised pair.',
    });
    await failed;
    const failedIntent = controller.store
      .intents()
      .filter((intent) => intent.task_id === catalogTask.id)
      .at(-1);
    assert(failedIntent);
    assert.equal(
      controller.store.receipt(`conversation-submission:${failedIntent.attempt_id}`),
      undefined,
    );
    assert.equal(state(catalogTask.id).configuration?.requestedModel, 'fixture-secondary');
    assert.equal(state(catalogTask.id).configuration?.effectiveModel, null);
    assert.equal(state(catalogTask.id).modelChoices?.status, 'last-observed');
    assert.deepEqual(state(catalogTask.id).modelChoices?.observation, selectedObservation);
    assert.equal(
      state(catalogTask.id).modelChoices?.reason,
      unavailable === 'missing-model' ? 'model-unavailable' : 'effort-unavailable',
    );
  }
  modelAvailability = 'available';
  const originalLocation = profile.locationHash;
  profile.locationHash = '2'.repeat(64);
  assert.equal(state(catalogTask.id).modelChoices?.status, 'client-changed');
  assert.equal(state(catalogTask.id).contextUsage, null);
  assert.equal(state(catalogTask.id).send.reason, 'profile-unavailable');
  assert.equal(
    (
      await send('ConfigureTaskConversation', catalogTask.id, {
        planning: { ...lowerPlanning, role: 'orchestrator' },
      })
    ).reason,
    'client-changed',
  );
  assert.equal(
    (
      await send('ConfigureTaskConversation', catalogTask.id, {
        planning: { ...planning, limits: lowerPlanning.limits },
      })
    ).outcome,
    'applied',
  );
  assert.equal(state(catalogTask.id).configuration?.selection.modelRequest, undefined);
  assert.equal(state(catalogTask.id).configuration?.requestedModel, fixtureModel);
  assert.equal(state(catalogTask.id).configuration?.effectiveModel, null);
  profile.locationHash = originalLocation;
  mode = 'escaped-boundary';
  askQuestion = false;
  const boundaryReply = nextReply();
  const boundaryTask = TaskSchema.parse(
    (
      await controller.execute(
        command(
          'CreateTaskDiscussion',
          { projectId, text: 'Keep a large bounded contract.', planning },
          0,
        ),
        'local-owner',
      )
    ).entity,
  );
  await boundaryReply;
  const boundaryProposal = state(boundaryTask.id).proposal;
  assert(boundaryProposal);
  await send('AdoptTaskPlan', boundaryTask.id, {
    proposalId: boundaryProposal.id,
    proposalHash: boundaryProposal.hash,
  });
  assert.equal(state(boundaryTask.id).send.reason, 'conversation-input-too-large');
  const entryCount = controller.store.db
    .prepare('SELECT COUNT(*) AS count FROM conversation_entries WHERE task_id=?')
    .get(boundaryTask.id)?.count;
  assert.equal(
    (await send('SendTaskMessage', boundaryTask.id, { text: '\u0001'.repeat(4096) })).reason,
    'conversation-input-too-large',
  );
  assert.equal(
    controller.store.db
      .prepare('SELECT COUNT(*) AS count FROM conversation_entries WHERE task_id=?')
      .get(boundaryTask.id)?.count,
    entryCount,
  );
  mode = 'success';
  askQuestion = false;
  for (const boundary of ['admission-stop', 'completion-stop', 'completion-send']) {
    const title = `Bounded ${boundary}`;
    let raceTaskId: string | undefined;
    let triggered = false;
    let replies = 0;
    const action = Promise.withResolvers<CommandResult>();
    const replied = Promise.withResolvers<void>();
    const off = controller.subscribe((event) => {
      if (event.type === 'task.created' && event.payload.title === title)
        raceTaskId = event.payload.id;
      if (!raceTaskId || event.taskId !== raceTaskId) return;
      const atBoundary =
        boundary === 'admission-stop'
          ? event.type === 'run.admitted'
          : event.type === 'attempt.stopped';
      if (!triggered && atBoundary) {
        triggered = true;
        const result =
          boundary === 'completion-send'
            ? send('SendTaskMessage', raceTaskId, { text: 'Continue from this exact boundary.' })
            : send('StopRun', raceTaskId, { runId: current(raceTaskId).runId });
        void result.then(action.resolve, action.reject);
      }
      if (event.type === 'conversation.entry' && event.payload.kind === 'agent-message') {
        replies++;
        if (replies === (boundary === 'completion-send' ? 2 : 1)) replied.resolve();
      }
    });
    t.after(off);
    const started = await controller.execute(
      command('CreateTaskDiscussion', { projectId, text: title, planning }, 0),
      'local-owner',
    );
    const raced = TaskSchema.parse(started.entity);
    assert.equal((await action.promise).outcome, 'applied');
    if (boundary !== 'admission-stop') await replied.promise;
    off();
    const attempts = controller.store.intents().filter((intent) => intent.task_id === raced.id);
    assert.equal(attempts.length, boundary === 'completion-send' ? 2 : 1);
    assert(attempts.every((intent) => intent.state === 'stopped'));
    if (boundary === 'admission-stop') {
      assert.deepEqual(controller.store.nativeProcesses(attempts[0].attempt_id), []);
      assert.equal(state(raced.id).contextUsage, null);
    }
    assert.equal(current(raced.id).state, boundary === 'completion-send' ? 'draft' : 'stopped');
    if (boundary !== 'completion-send')
      assert.equal(state(raced.id).send.reason, 'admissions-paused');
  }
  askQuestion = true;
  const firstReply = nextReply();
  const create = command(
    'CreateTaskDiscussion',
    { projectId, text: 'Keep the export and change netMinor.', planning, context: refs },
    0,
  );
  const created = await controller.execute(create, 'local-owner');
  assert.equal(created.outcome, 'applied');
  const taskId = TaskSchema.parse(created.entity).id;
  assert.equal(state(taskId).contractStatus, 'provisional');
  assert.equal(state(taskId).phase, 'planning');
  assert.equal(state(taskId).budget?.remaining.attempts, 11);
  assert.equal(state(taskId).budget?.remaining.concurrency, 1);
  assert.equal((await controller.execute(create, 'local-owner')).outcome, 'already-applied');
  assert.equal(controller.store.intents().filter((intent) => intent.task_id === taskId).length, 1);
  const policy = {
    ...fixtures.policy,
    quality: 'quick',
    limits: { attempts: 4, minutes: 20, concurrency: 2 },
    methods: [],
    effects: [
      ...fixtures.policy.effects.map((grant) => ({ ...grant, taskId })),
      {
        taskId,
        action: 'run-review',
        target: 'keep-it-simple/cycle-1',
        expiresAt: fixtures.policy.effects[0].expiresAt,
        revoked: false,
        usesRemaining: 1,
      },
    ],
  };
  assert.equal(
    (await send('PrepareRun', taskId, { policy, roles: quickRoles(fixtures) })).reason,
    'task-not-preparable',
  );
  await firstReply;
  const nativePreparation = {
    profileId: 'openai-file-v1',
    targetPath: 'net.mjs',
    policy: {
      ...policy,
      methods: [{ id: 'keep-it-simple', cycles: 1, reviewerRole: 'reviewer' }],
    },
    creditPolicy: 'ordinary',
    consent: 'explicit',
  };
  const provisionalPreparation = await send('PrepareNativeRun', taskId, nativePreparation);
  assert.equal(provisionalPreparation.reason, 'task-contract-unconfirmed');
  assert.equal(provisionalPreparation.next, 'Review and adopt a plan before preparing execution.');
  const admitted = controller.store.intents().find((intent) => intent.task_id === taskId);
  assert(admitted);
  const savedInputReceipt = controller.store.receipt(`conversation-turn:${admitted.attempt_id}`);
  const savedInputArtifact = ArtifactSchema.parse(savedInputReceipt?.result.entity);
  const savedInput = JSON.parse(
    new ArtifactFiles(join(context.directory, 'home', 'artifacts'))
      .read(savedInputArtifact.hash)
      .toString('utf8'),
  );
  assert.deepEqual(savedInput.contextSource, { projectId, base: context.source.base });
  assert.equal(savedInput.contextAttachments.length, 1);
  assert.equal(savedInput.contextAttachments[0].artifactId, contextArtifact.id);
  assert.equal(savedInput.contextAttachments[0].hash, contextArtifact.hash);
  assert.equal(
    savedInput.history.find(
      (entry: { messageId?: string }) =>
        entry.messageId === savedInput.contextAttachments[0].messageId,
    )?.role,
    'user',
  );
  const retainedInput = controller.store.db
    .prepare(
      "SELECT body FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='user-message'",
    )
    .get(taskId);
  assert.deepEqual(JSON.parse(retainedInput?.body as string).context, refs);
  assert.equal(state(taskId).pendingQuestions.length, 1);
  assert.equal(state(taskId).adopt.reason, 'pending-question');
  assert.equal(state(taskId).configuration?.effectiveModel, fixtureModel);
  mode = 'hold';
  askQuestion = false;
  await send('AnswerTaskQuestion', taskId, {
    questionId: state(taskId).pendingQuestions[0].id,
    text: 'Keep it.',
    context: refs,
  });
  await held.promise;
  const queuedRevision = current(taskId).revision;
  await send('SendTaskMessage', taskId, {
    text: 'Use the existing helper in the next plan.',
    context: refs,
  });
  assert.equal(state(taskId).queuedInputCount, 1);
  assert.equal(state(taskId).send.disposition, 'queue');
  assert.equal(
    (
      await controller.execute(
        command('SendTaskMessage', { taskId, text: 'Stale text.' }, queuedRevision),
        'local-owner',
      )
    ).outcome,
    'stale-revision',
  );
  clock.advance(60000);
  const stopped = new Promise<void>((done) => {
    const off = controller.subscribe((event) => {
      if (
        event.type === 'task.updated' &&
        event.taskId === taskId &&
        event.payload.state === 'stopped'
      ) {
        off();
        done();
      }
    });
  });
  await send('StopRun', taskId, { runId: current(taskId).runId });
  await stopped;
  assert.equal(controller.store.intents().filter((intent) => intent.task_id === taskId).length, 2);
  assert.equal(state(taskId).send.reason, 'admissions-paused');
  assert.equal(state(taskId).budget?.remaining.minutes, 29);
  mode = 'success';
  const resumed = nextReply();
  await send('ResumeRun', taskId, { runId: current(taskId).runId });
  await resumed;
  assert.equal(state(taskId).queuedInputCount, 0);
  assert.equal(state(taskId).adopt.available, true);
  mode = 'invalid';
  const invalid = new Promise<void>((done) => {
    const off = controller.subscribe((event) => {
      if (
        event.type === 'task.updated' &&
        event.taskId === taskId &&
        event.payload.state === 'interrupted'
      ) {
        off();
        done();
      }
    });
  });
  const plansBefore = controller.store.db
    .prepare(
      "SELECT COUNT(*) AS count FROM conversation_entries WHERE json_extract(body,'$.kind')='plan-proposal'",
    )
    .get()?.count;
  await send('SendTaskMessage', taskId, { text: 'Keep the same bounded plan.' });
  await invalid;
  assert.equal(
    controller.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM conversation_entries WHERE json_extract(body,'$.kind')='plan-proposal'",
      )
      .get()?.count,
    plansBefore,
  );
  assert.equal(state(taskId).adopt.available, false);
  mode = 'success';
  const restored = nextReply();
  await send('SendTaskMessage', taskId, { text: 'Return the valid plan.' });
  await restored;
  const proposed = state(taskId).proposal;
  assert(proposed);
  const planningRun = controller.store.get('run', proposed.runId);
  const effectsBefore = (planningRun as ReturnType<typeof RunSchema.parse>).policy.policy.effects;
  assert.deepEqual(effectsBefore, []);
  assert.equal(
    (await send('AdoptTaskPlan', taskId, { proposalId: proposed.id, proposalHash: 'f'.repeat(64) }))
      .reason,
    'proposal-hash-changed',
  );
  await send('AdoptTaskPlan', taskId, { proposalId: proposed.id, proposalHash: proposed.hash });
  assert.equal(state(taskId).contractStatus, 'confirmed');
  const changedSource = join(context.source.directory, 'planning-note.txt');
  writeFileSync(changedSource, 'Source changed after adoption.\n');
  const stalePreparation = await send('PrepareNativeRun', taskId, nativePreparation);
  assert.equal(stalePreparation.reason, 'proposal-not-current');
  assert.equal(
    stalePreparation.next,
    'Adopt the current planning proposal before preparing execution.',
  );
  rmSync(changedSource);
  const prepared = await send('PrepareRun', taskId, { policy, roles: quickRoles(fixtures) });
  assert.equal(prepared.outcome, 'applied');
  const execution = RunSchema.parse(prepared.entity);
  assert.equal(
    (await send('ResumeRun', taskId, { runId: proposed.runId })).reason,
    'run-not-current',
  );
  assert.equal(state(taskId).budget?.remaining.attempts, 7);
  const retainGuidance = async (text: string) => {
    const before = structuredClone(current(taskId));
    const snapshot = controller.snapshot();
    const runs = structuredClone(snapshot.runs);
    const candidates = structuredClone(snapshot.candidates);
    const evidence = structuredClone(snapshot.evidence);
    const allowance = state(taskId).budget;
    const attempts = controller.store.intents().length;
    const spawns = children.length;
    const result = await send('SendTaskMessage', taskId, { text, context: refs });
    assert.equal(result.outcome, 'applied', JSON.stringify(result));
    assert.deepEqual({ ...current(taskId), revision: before.revision }, before);
    assert.deepEqual(controller.snapshot().runs, runs);
    assert.deepEqual(controller.snapshot().candidates, candidates);
    assert.deepEqual(controller.snapshot().evidence, evidence);
    assert.deepEqual(state(taskId).budget, allowance);
    assert.equal(controller.store.intents().length, attempts);
    assert.equal(children.length, spawns);
    assert.equal(state(taskId).send.disposition, 'queue');
    const entry = controller.store.db
      .prepare(
        'SELECT body FROM conversation_entries WHERE task_id=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(taskId);
    const guidance = JSON.parse(entry?.body as string);
    assert.equal(guidance.kind, 'guidance');
    assert.equal(guidance.text, text);
    assert.deepEqual(guidance.context, refs);
  };
  await retainGuidance('Keep this prepared run while retaining the question.');
  const preparedRunId = current(taskId).runId;
  const reconfigure = await send('ConfigureTaskConversation', taskId, {
    planning: { ...planning, role: 'orchestrator' },
  });
  assert.equal(reconfigure.reason, 'task-not-discussing');
  assert.equal(current(taskId).runId, preparedRunId);
  assert.equal(
    (
      await send('ConfigureTaskConversation', taskId, {
        planning: { ...planning, limits: { ...planning.limits, attempts: 11 } },
      })
    ).outcome,
    'applied',
  );
  assert.equal(current(taskId).runId, preparedRunId);
  const reviewed = new Promise<void>((done) => {
    const off = controller.subscribe((event) => {
      if (event.type === 'review.completed' && event.taskId === taskId) {
        off();
        done();
      }
    });
  });
  await send('StartRun', taskId, { runId: execution.id });
  await send('SendTaskMessage', taskId, {
    text: 'Discuss a later revision after this work closes.',
  });
  assert.equal(state(taskId).send.disposition, 'queue');
  await reviewed;
  const exportCandidate = controller
    .snapshot()
    .candidates.find((candidate) => candidate.taskId === taskId);
  assert(exportCandidate);
  await send('ExportPatch', taskId, { candidateId: exportCandidate.id });
  const exportApproval = controller
    .snapshot()
    .approvals.find((approval) => approval.taskId === taskId && approval.status === 'pending');
  assert(exportApproval);
  assert.equal(state(taskId).activeAttempt, null);
  assert.equal(state(taskId).send.reason, 'effects-unresolved');
  const pendingExport = controller.store.db
    .prepare('SELECT * FROM pending_effects WHERE approval_id=?')
    .get(exportApproval.approvalId);
  const exportRevision = current(taskId).revision;
  for (const name of ['SendTaskMessage', 'QueueTaskGuidance']) {
    assert.equal(
      (await send(name, taskId, { text: 'Keep the export approval exact.' })).reason,
      'effects-unresolved',
    );
    assert.equal(current(taskId).revision, exportRevision);
    assert.deepEqual(
      controller.store.db
        .prepare('SELECT * FROM pending_effects WHERE approval_id=?')
        .get(exportApproval.approvalId),
      pendingExport,
    );
  }
  assert.equal(
    (
      await controller.execute(
        command(
          'ResolveApproval',
          {
            binding: binding(exportApproval),
            decision: 'approved',
          },
          exportRevision,
        ),
        'local-owner',
      )
    ).outcome,
    'applied',
  );
  const retainedExecution = structuredClone(controller.store.get('run', execution.id));
  const retainedCandidates = structuredClone(controller.snapshot().candidates);
  const retainedEvidence = structuredClone(controller.snapshot().evidence);
  assert.equal(state(taskId).queuedInputCount, 2);
  await retainGuidance('Thanks. Keep the checked candidate current.');
  assert.equal(current(taskId).runId, execution.id);
  assert.deepEqual(controller.store.get('run', execution.id), retainedExecution);
  assert.deepEqual(controller.store.get('run', proposed.runId), planningRun);
  const acceptance = await send('AcceptCandidate', taskId, {
    candidateId: exportCandidate.id,
    destinationRef: 'refs/heads/retained-conversation',
  });
  assert.equal(acceptance.outcome, 'applied', JSON.stringify(acceptance));
  const acceptApproval = controller
    .snapshot()
    .approvals.find(
      (approval) =>
        approval.taskId === taskId &&
        approval.action === 'accept-candidate' &&
        approval.status === 'pending',
    );
  assert(acceptApproval);
  assert.equal(
    (
      await controller.execute(
        command(
          'ResolveApproval',
          { binding: binding(acceptApproval), decision: 'approved' },
          current(taskId).revision,
        ),
        'local-owner',
      )
    ).outcome,
    'applied',
  );
  assert.equal(current(taskId).state, 'accepted');
  const acceptedHead = refValue(context.source.directory, 'refs/heads/retained-conversation');
  assert(acceptedHead);
  await retainGuidance('Keep the accepted result and this follow-up.');
  assert.equal(current(taskId).state, 'accepted');
  assert.equal(current(taskId).runId, execution.id);
  assert.equal(
    refValue(context.source.directory, 'refs/heads/retained-conversation'),
    acceptedHead,
  );
  assert.equal(
    (
      await send('ConfigureTaskConversation', taskId, {
        planning: { ...planning, role: 'orchestrator' },
      })
    ).reason,
    'task-not-discussing',
  );
  assert.equal(
    (
      await send('ConfigureTaskConversation', catalogTask.id, {
        planning: { ...planning, role: 'orchestrator', limits: lowerPlanning.limits },
      })
    ).outcome,
    'applied',
  );
  crashAfterIntent = true;
  const crash = command(
    'SendTaskMessage',
    { taskId: catalogTask.id, text: 'Keep the next turn bounded.', context: refs },
    current(catalogTask.id).revision,
  );
  await assert.rejects(
    controller.execute(crash, 'local-owner'),
    /Interrupted after durable planning admission/,
  );
  const count = controller.store.intents().length;
  await controller.close();
  crashAfterIntent = false;
  reopened = new Controller({ ...options, home: controller.home, now: clock.now, id: context.id });
  const afterReopen = await reopened.execute(
    command('GetTaskConversationState', { taskId: catalogTask.id }),
    'local-owner',
  );
  assert.equal(afterReopen.data?.kind, 'conversation-state');
  if (afterReopen.data?.kind === 'conversation-state')
    assert.equal(afterReopen.data.state.send.reason, 'ownership-unknown');
  const reopenedCatalog = await reopened.execute(
    command('GetTaskConversationState', { taskId: catalogTask.id }),
    'local-owner',
  );
  assert.equal(reopenedCatalog.data?.kind, 'conversation-state');
  if (reopenedCatalog.data?.kind === 'conversation-state') {
    assert.equal(reopenedCatalog.data.state.configuration?.selection.modelRequest, undefined);
    assert.deepEqual(reopenedCatalog.data.state.modelChoices?.observation, selectedObservation);
  }
  assert.equal((await reopened.execute(crash, 'local-owner')).outcome, 'already-applied');
  assert.equal(reopened.store.intents().length, count);
  const recoveredEntry = reopened.store.db
    .prepare(
      "SELECT body FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.text')=?",
    )
    .get(catalogTask.id, 'Keep the next turn bounded.');
  assert.deepEqual(JSON.parse(recoveredEntry?.body as string).context, refs);
  assert.deepEqual(reopened.snapshot().candidates, retainedCandidates);
  assert.deepEqual(reopened.snapshot().evidence, retainedEvidence);
  for (const sentinel of context.source.sentinels) {
    const path = join(context.source.directory, sentinel.path);
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), sentinel.hash);
    assert.equal(lstatSync(path).mode & 0o777, sentinel.mode);
  }
});
