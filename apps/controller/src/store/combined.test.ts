import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ArtifactSchema,
  type CommandResult,
  type Run,
  type Task,
  TaskConversationStateSchema,
  TaskSchema,
} from '@crewkite/contracts';
import {
  chargedIntegrationMinutes,
  remainingCombinedBudgets,
  unspentIntegrationMinutes,
} from '../commands/budgets.ts';
import { refValue } from '../host/publication.ts';
import { git } from '../host/source.ts';
import { groupAbsent } from '../host/worker.ts';
import { binding, nativeSetup } from './controller-fixture.ts';
import { type CombinedGroup, Store } from './index.ts';

test('combined tasks share seven real dispatches and require a separate full barrier', async (t) => {
  const scenarioQueues = [
    [
      'passed',
      'paused',
      'interaction-failed',
      'stopped-before-check',
      'closed-before-check',
      'empty-journal',
    ],
    ['recovered', 'quota', 'stopped', 'unknown', 'child-budget', 'quota-both', 'quota-stop'],
  ] as const;
  let fullBarrier = Promise.resolve();
  const enterFullBarrier = async () => {
    const prior = fullBarrier;
    const release = Promise.withResolvers<void>();
    fullBarrier = release.promise;
    await prior;
    return release.resolve;
  };
  const activeScenario: (string | undefined)[] = [];
  const run = async (scenarios: (typeof scenarioQueues)[number], queue: number) => {
    for (const scenario of scenarios) {
      activeScenario[queue] = scenario;
      const quotaScenario = scenario.startsWith('quota');
      const scheduled: { callback: () => void; delay: number; cancelled: boolean }[] = [];
      const context = await nativeSetup(
        t,
        quotaScenario ? 'combined-quota' : `combined-${scenario}`,
        {
          identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
          ...(quotaScenario
            ? {
                schedule: (callback: () => void, delay: number) => {
                  if (delay !== 60_000) {
                    const timer = setTimeout(callback, delay);
                    return () => clearTimeout(timer);
                  }
                  const pending = { callback, delay, cancelled: false };
                  scheduled.push(pending);
                  return () => {
                    pending.cancelled = true;
                  };
                },
              }
            : {}),
        },
      );
      let controller = context.controller;
      const { command, task: parent } = context;
      const seeded: Record<string, string> = {
        'src/a.mjs': 'export const value = 0;\n',
        'src/b.mjs': 'export const value = 0;\n',
        'a.test.mjs':
          "import { test } from 'node:test'; import assert from 'node:assert/strict'; import {value} from './src/a.mjs'; test('a stays finite',()=>assert.ok(value===0||value===1));\n",
        'b.test.mjs':
          "import { test } from 'node:test'; import assert from 'node:assert/strict'; import {value} from './src/b.mjs'; test('b stays finite',()=>assert.ok(value===0||value===1));\n",
        'interaction.test.mjs': `import { test } from 'node:test'; import assert from 'node:assert/strict'; import {value as a} from './src/a.mjs'; import {value as b} from './src/b.mjs'; test('combined interaction remains valid',()=>assert.ok(a+b<=${scenario === 'interaction-failed' ? 1 : 2}));\n`,
      };
      for (const [path, content] of Object.entries(seeded)) {
        mkdirSync(dirname(join(context.source.directory, path)), { recursive: true });
        writeFileSync(join(context.source.directory, path), content);
      }
      git(context.source.directory, ['add', '--', ...Object.keys(seeded)]);
      git(
        context.source.directory,
        [
          'commit',
          '-s',
          '--only',
          '-m',
          'test: seed independent combined slices',
          '--',
          ...Object.keys(seeded),
        ],
        undefined,
        { name: 'CrewKite fixture', email: 'fixture@example.invalid', at: context.clock.now() },
      );
      const children: Task[] = [];
      for (const name of ['a', 'b'])
        children.push(
          TaskSchema.parse(
            (
              await controller.execute(
                command(
                  'CreateTask',
                  {
                    projectId: parent.projectId,
                    title: `Update ${name}`,
                    outcome: `Update ${name} without changing its neighbor.`,
                    criteria: [`${name} remains finite.`],
                  },
                  0,
                ),
                'local-owner',
              )
            ).entity,
          ),
        );
      for (const [index, child] of children.entries()) {
        const configured = await controller.execute(
          command(
            'ConfigureTaskConversation',
            {
              taskId: child.id,
              planning: {
                role: 'lead',
                profileId: 'openai-file-v1',
                creditPolicy: 'ordinary',
                consent: 'explicit',
                limits: { attempts: 3, minutes: 5, concurrency: 1 },
              },
            },
            child.revision,
          ),
          'local-owner',
        );
        assert.equal(configured.outcome, 'applied', JSON.stringify(configured));
        const reply = Promise.withResolvers<void>();
        const off = context.observe(controller, (event) => {
          if (
            event.type === 'task.updated' &&
            event.taskId === child.id &&
            ['interrupted', 'stopped', 'failed'].includes(event.payload.state)
          )
            throw Error(`Prior child planning terminated: ${context.planningTrace(child.id)}`);
          if (
            event.type === 'conversation.entry' &&
            event.taskId === child.id &&
            event.payload.kind === 'plan-proposal'
          )
            reply.resolve();
        });
        context.onWritten((message, phase) => {
          if (
            scenario === 'child-budget' &&
            index === 0 &&
            phase === 'task' &&
            message.method === 'turn/start'
          )
            context.clock.advance(1000);
        });
        const sent = await controller.execute(
          command(
            'SendTaskMessage',
            { taskId: child.id, text: 'Retain this bounded scope.' },
            configured.revision,
          ),
          'local-owner',
        );
        assert.equal(sent.outcome, 'applied', JSON.stringify(sent));
        try {
          await context.wait('prior child planning proposal', reply.promise);
        } catch (error) {
          throw new Error(`Prior child planning failed: ${context.planningTrace(child.id)}`, {
            cause: error,
          });
        }
        off();
        context.onWritten(undefined);
        const stateResult = await controller.execute(
          command('GetTaskConversationState', { taskId: child.id }),
          'local-owner',
        );
        const state = TaskConversationStateSchema.parse(
          stateResult.data && 'state' in stateResult.data ? stateResult.data.state : undefined,
        );
        assert(state.proposal);
        const current = controller.snapshot().tasks.find((task) => task.id === child.id) as Task;
        const adopted = await controller.execute(
          command(
            'AdoptTaskPlan',
            { taskId: child.id, proposalId: state.proposal.id, proposalHash: state.proposal.hash },
            current.revision,
          ),
          'local-owner',
        );
        assert.equal(adopted.outcome, 'applied', JSON.stringify(adopted));
        children[index] = TaskSchema.parse(adopted.entity);
      }
      const expiresAt = new Date(Date.parse(context.clock.now()) + 300000).toISOString();
      const policy = {
        ...context.appointment.policy,
        authority: quotaScenario ? 'balanced' : 'guided',
        limits: { attempts: 7, minutes: 22, concurrency: 2 },
        unknownUsage: { rule: 'fixed-allowance', allowance: { launches: 7, minutes: 22 } },
        effects: children.map((child) => ({
          taskId: child.id,
          action: 'write-scratch',
          target: context.controller.snapshot().projects[0].name,
          expiresAt,
          usesRemaining: 1,
          revoked: false,
        })),
      };
      const input = {
        taskId: parent.id,
        policy,
        children: children.map((child, index) => ({
          taskId: child.id,
          expectedRevision: child.revision,
          scope: [index ? 'src/b.mjs' : 'src/a.mjs'],
          writer: {
            profileId:
              quotaScenario && (index === 0 || scenario === 'quota-both')
                ? 'anthropic-file-v1'
                : 'openai-file-v1',
            creditPolicy: 'ordinary',
            ...(quotaScenario && (index === 0 || scenario === 'quota-both')
              ? {
                  billingAttestation: {
                    source: 'user-attested' as const,
                    subscriptionLoginConfirmed: true,
                    paidExtraUsageDisabled: true,
                  },
                }
              : {}),
          },
          consent: 'explicit',
          maximumMinutes: 5,
        })),
        ...(scenario === 'empty-journal' ? {} : { integration: { maximumMinutes: 3 } }),
        checks: {
          recipeId: 'project-node-tests-v1',
          testFiles: ['a.test.mjs', 'b.test.mjs', 'interaction.test.mjs'],
          replayTestFiles: [['a.test.mjs'], ['b.test.mjs']],
          interactionTestFiles: ['interaction.test.mjs'],
          maximumMinutes: 1,
          baselineConsent: 'explicit',
          replayConsents: ['explicit', 'explicit'],
        },
        reviewer: { profileId: 'openai-file-v1', creditPolicy: 'ordinary', maximumMinutes: 5 },
      };
      const rev = (taskId = parent.id) =>
        (controller.snapshot().tasks.find((task) => task.id === taskId) as Task).revision;
      const phase = () => controller.snapshot().combinedRuns[0];
      const stagePhases = {
        baseline: ['baseline'],
        writers: ['writer-0', 'writer-1'],
        assembly: ['replay-0', 'replay-1'],
        checks: ['final-check'],
        review: ['review'],
      } as const;
      const stageAllowance = (stage: keyof typeof stagePhases) => {
        const group = controller.store.combinedGroup(phase()?.runId ?? '');
        assert(group);
        const dispatches = controller.store.combinedDispatches(group.run_id);
        const minutes = stagePhases[stage].map((phase) => {
          const slot = dispatches.find((slot) => slot.phase === phase);
          assert(slot);
          return slot.maximum_minutes;
        });
        // Writers overlap. Replays and their integration operations run in order.
        return (
          (stage === 'writers'
            ? Math.max(...minutes)
            : minutes.reduce((sum, value) => sum + value)) *
            60_000 +
          (stage === 'baseline' || stage === 'assembly'
            ? Math.max(
                0,
                group.integration_maximum_minutes * 60_000 - group.integration_milliseconds,
              )
            : 0) +
          // The three-file runner can pause this process while sibling fixtures own the host.
          60_000
        );
      };
      const waitFor = async (
        label: string,
        predicate: () => boolean,
        stage?: keyof typeof stagePhases,
      ) => {
        if (predicate()) return;
        const done = Promise.withResolvers<void>();
        const off = context.observe(controller, () => {
          if (predicate()) done.resolve();
        });
        try {
          try {
            await context.wait(
              `${scenario}/${label}`,
              done.promise,
              stage === undefined ? undefined : stageAllowance(stage),
            );
          } catch (error) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (!predicate()) throw error;
          }
        } finally {
          off();
        }
      };
      if (scenario === 'passed')
        for (const childrenInput of [
          input.children.map((child, index) =>
            index ? { ...child, expectedRevision: child.expectedRevision + 1 } : child,
          ),
          input.children.map((child, index) =>
            index ? { ...child, scope: ['src/missing.mjs'] } : child,
          ),
        ]) {
          assert.equal(
            (
              await controller.execute(
                command('PrepareCombinedRun', { ...input, children: childrenInput }, rev()),
                'local-owner',
              )
            ).outcome,
            'blocked',
          );
          assert.equal(controller.snapshot().combinedRuns.length, 0);
          assert.equal(
            controller.store
              .intents()
              .filter((intent) => controller.store.runPurpose(intent.run_id) !== 'conversation')
              .length,
            0,
          );
        }
      const prepared = await controller.execute(
        command('PrepareCombinedRun', input, rev()),
        'local-owner',
      );
      if (scenario === 'child-budget') {
        assert.equal(prepared.outcome, 'blocked');
        assert.equal(prepared.reason, 'combined-child-budget-insufficient');
        assert.equal(controller.snapshot().combinedRuns.length, 0);
        assert.equal(controller.store.intents().length, 2);
        continue;
      }
      assert.equal(prepared.outcome, 'applied', JSON.stringify(prepared));
      const preview = phase();
      assert(preview);
      const group = controller.store.combinedGroup(preview.runId);
      assert(group);
      assert.equal(group.integration_maximum_minutes, input.integration?.maximumMinutes ?? 1);
      if (scenario === 'passed') {
        const owner = controller.store.get<Run>('run', preview.runId);
        assert(owner);
        for (const [maximum, elapsed, active, unknown, charged, unspent] of [
          [1, 0, 0, false, 0, 1],
          [1, 1, 1, false, 1, 0],
          [3, 0, 0, false, 0, 3],
          [3, 1, 0, false, 1, 2],
          [3, 60001, 0, false, 2, 1],
          [3, 180000, 0, false, 3, 0],
          [3, 60001, 1, false, 3, 1],
          [3, 1, 0, true, 3, 2],
        ] as const) {
          const sample: CombinedGroup = {
            ...group,
            integration_maximum_minutes: maximum,
            integration_milliseconds: elapsed,
            integration_active: active,
            phase: unknown ? ('unknown' as const) : group.phase,
          };
          assert.equal(chargedIntegrationMinutes(sample), charged);
          assert.equal(unspentIntegrationMinutes(sample), unspent);
          assert.equal(
            remainingCombinedBudgets(owner, [], [], sample).minutes,
            owner.policy.policy.limits.minutes - charged,
          );
        }
      }
      if (scenario === 'empty-journal') {
        const migrations = new URL('../../migrations/', import.meta.url);
        const oldMigrations = join(context.directory, 'legacy-migrations');
        mkdirSync(oldMigrations);
        for (const file of readdirSync(migrations).filter((file) => file < '013'))
          writeFileSync(join(oldMigrations, file), readFileSync(new URL(file, migrations)));
        const legacy = new Store(join(context.directory, 'legacy.sqlite'));
        try {
          legacy.applyMigrations(oldMigrations);
          const tables = [
            'entities',
            'combined_groups',
            'combined_members',
            'combined_dispatches',
            'combined_ref_intents',
          ];
          for (const table of tables)
            for (const row of controller.store.db.prepare(`SELECT * FROM ${table}`).all()) {
              if (table === 'combined_groups') delete row.integration_maximum_minutes;
              const columns = Object.keys(row);
              legacy.db
                .prepare(
                  `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
                )
                .run(...Object.values(row));
            }
          legacy.db
            .prepare(
              'UPDATE combined_groups SET integration_milliseconds=42000,integration_active=1',
            )
            .run();
          legacy.db
            .prepare(
              "INSERT INTO combined_ref_intents(parent_run_id,generation,operation,state,body,intent_at,finished_at) VALUES (?,0,'legacy-checkpoint','applied',?,?,?)",
            )
            .run(
              preview.runId,
              JSON.stringify({ phases: [] }),
              context.clock.now(),
              context.clock.now(),
            );
          assert.equal(legacy.db.prepare('SELECT COUNT(*) AS n FROM combined_members').get()?.n, 2);
          assert.equal(
            legacy.db.prepare('SELECT COUNT(*) AS n FROM combined_dispatches').get()?.n,
            7,
          );
          assert.equal(
            legacy.db.prepare('SELECT COUNT(*) AS n FROM combined_ref_intents').get()?.n,
            1,
          );
          const before = tables.map((table) => legacy.db.prepare(`SELECT * FROM ${table}`).all());
          const foreignKeys = tables.map((table) =>
            legacy.db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
          );
          legacy.applyMigrations(fileURLToPath(migrations));
          for (const [index, table] of tables.entries()) {
            assert.deepEqual(
              legacy.db.prepare(`SELECT * FROM ${table}`).all(),
              table === 'combined_groups'
                ? before[index].map((row) =>
                    Object.assign(Object.create(Object.getPrototypeOf(row)), row, {
                      integration_maximum_minutes: 1,
                    }),
                  )
                : before[index],
            );
            assert.deepEqual(
              legacy.db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
              foreignKeys[index],
            );
          }
          assert.equal(legacy.db.prepare('PRAGMA user_version').get()?.user_version, 13);
          assert.deepEqual(legacy.db.prepare('PRAGMA foreign_key_check').all(), []);
          assert.throws(() =>
            legacy.db.prepare('UPDATE combined_groups SET integration_milliseconds=60001').run(),
          );
          legacy.db
            .prepare(
              'UPDATE combined_groups SET integration_maximum_minutes=3,integration_milliseconds=60001',
            )
            .run();
          assert.throws(() =>
            legacy.db.prepare('UPDATE combined_groups SET integration_maximum_minutes=1').run(),
          );
        } finally {
          legacy.close();
        }
      }
      for (const task of [parent, ...children]) {
        const scoped = controller.snapshot({ taskId: task.id });
        assert.deepEqual(
          new Set(scoped.tasks.map((value) => value.id)),
          new Set([parent.id, ...children.map((child) => child.id)]),
        );
        assert.deepEqual(scoped.combinedRuns, [preview]);
        assert(scoped.artifacts.some((artifact) => artifact.id === preview.preparationId));
      }
      assert.equal(controller.snapshot().attempts.length, 2);
      assert.deepEqual(
        preview.dispatches.map((dispatch) => dispatch.state),
        Array(7).fill('reserved'),
      );
      for (const child of children) {
        const member = preview.members.find((member) => member.taskId === child.id);
        assert(member);
        assert.equal(
          (
            await controller.execute(
              command('StartRun', { taskId: child.id, runId: member.runId }, rev(child.id)),
              'local-owner',
            )
          ).outcome,
          'blocked',
        );
        assert.equal(
          (
            await controller.execute(
              command(
                'AcceptCandidate',
                {
                  taskId: child.id,
                  candidateId: context.id('art').replace(/^art_/, 'cnd_'),
                  destinationRef: 'refs/heads/partial',
                },
                rev(child.id),
              ),
              'local-owner',
            )
          ).outcome,
          'blocked',
        );
      }
      if (scenario === 'paused' || scenario === 'empty-journal') {
        assert.equal(
          (
            await controller.execute(
              command('PauseAdmissions', { taskId: parent.id, runId: preview.runId }, rev()),
              'local-owner',
            )
          ).outcome,
          'applied',
        );
        assert.equal(phase()?.phase, 'paused');
        assert.equal(
          (
            await controller.execute(
              command('StartRun', { taskId: parent.id, runId: preview.runId }, rev()),
              'local-owner',
            )
          ).outcome,
          'blocked',
        );
        if (scenario === 'empty-journal')
          controller.store.db
            .prepare(
              "INSERT INTO combined_ref_intents(parent_run_id,generation,operation,state,body,intent_at,finished_at) VALUES (?,?,'baseline-initialize','prepared',?,?,?)",
            )
            .run(
              preview.runId,
              preview.generation,
              '{"phases":[]}',
              context.clock.now(),
              context.clock.now(),
            );
        controller = await context.restart();
        assert.equal(phase()?.phase, 'paused');
        assert.equal(controller.store.intents().length, 2);
        if (scenario === 'empty-journal') {
          assert.equal(controller.store.combinedRefIntents(preview.runId)[0].state, 'prepared');
          controller.store.db
            .prepare('UPDATE combined_ref_intents SET finished_at=NULL WHERE parent_run_id=?')
            .run(preview.runId);
          controller = await context.restart();
          assert.equal(phase()?.phase, 'unknown');
          assert.equal(controller.store.combinedRefIntents(preview.runId)[0].state, 'unknown');
          assert.equal(controller.store.intents().length, 2);
          assert.equal(
            phase()?.dispatches.every((slot) => slot.state === 'reserved'),
            true,
          );
          continue;
        }
        assert.equal(
          (
            await controller.execute(
              command(
                'ResumeRun',
                { taskId: preview.members[0].taskId, runId: preview.members[0].runId },
                rev(preview.members[0].taskId),
              ),
              'local-owner',
            )
          ).outcome,
          'blocked',
        );
        assert.equal(
          (
            await controller.execute(
              command('ResumeRun', { taskId: parent.id, runId: preview.runId }, rev()),
              'local-owner',
            )
          ).outcome,
          'applied',
        );
        assert.equal(phase()?.phase, 'prepared');
        assert.equal(controller.store.intents().length, 2);
      }
      let closeBeforeCheck: Promise<void> | undefined;
      let stopBeforeCheck: Promise<CommandResult> | undefined;
      const offBeforeCheck = context.observe(controller, (event) => {
        if (
          scenario === 'closed-before-check' &&
          !closeBeforeCheck &&
          event.type === 'combined.updated' &&
          event.payload.phase === 'baseline'
        ) {
          closeBeforeCheck = Promise.resolve();
          controller.execute(
            command('PauseAdmissions', { taskId: parent.id, runId: preview.runId }, rev()),
            'local-owner',
          );
          closeBeforeCheck = Promise.resolve(controller.close());
        }
        if (
          scenario === 'stopped-before-check' &&
          !stopBeforeCheck &&
          event.type === 'combined.updated' &&
          event.payload.phase === 'baseline'
        )
          stopBeforeCheck = controller.execute(
            command('StopRun', { taskId: parent.id, runId: preview.runId }, rev()),
            'local-owner',
          );
      });
      assert.equal(
        (
          await controller.execute(
            command('StartRun', { taskId: parent.id, runId: preview.runId }, rev()),
            'local-owner',
          )
        ).outcome,
        'applied',
      );
      offBeforeCheck();
      if (scenario === 'closed-before-check') {
        assert(closeBeforeCheck);
        await closeBeforeCheck;
        controller = await context.restart();
        assert.equal(phase()?.phase, 'paused');
        assert.equal(controller.store.combinedDispatches(preview.runId)[0].state, 'stopped');
        assert.equal(
          controller.store
            .intents()
            .filter((intent) => controller.store.runPurpose(intent.run_id) !== 'conversation')
            .every((intent) => intent.pid === null && intent.state === 'stopped'),
          true,
        );
        continue;
      }
      if (scenario === 'stopped-before-check') {
        assert(stopBeforeCheck);
        assert.equal((await stopBeforeCheck).outcome, 'applied');
        assert.equal(phase()?.phase, 'stopped');
        assert.equal(controller.store.combinedDispatches(preview.runId)[0].state, 'stopped');
        assert.equal(
          controller.store
            .intents()
            .filter((intent) => controller.store.runPurpose(intent.run_id) !== 'conversation')
            .every((intent) => intent.pid === null && intent.state === 'stopped'),
          true,
        );
        continue;
      }
      await waitFor(
        'baseline',
        () => phase()?.phase === 'writers' || ['blocked', 'unknown'].includes(phase()?.phase ?? ''),
        'baseline',
      );
      assert.equal(phase()?.phase, 'writers', JSON.stringify(phase()));
      let written = 0;
      let writerPause: Promise<CommandResult> | undefined;
      let activeResume: Promise<CommandResult> | undefined;
      context.onWritten((message, nativePhase) => {
        if (quotaScenario) return;
        if (nativePhase !== 'task' || message.method !== 'turn/start') return;
        written++;
        if (written !== 2) return;
        const active = controller.store
          .intents()
          .filter(
            (intent) =>
              children.some((child) => child.id === intent.task_id) && intent.state !== 'stopped',
          );
        assert.equal(active.length, 2);
        assert(
          active.every((intent) => {
            const phase = controller.store.nativeProcesses(intent.attempt_id).at(-1);
            return phase?.state === 'owned' && !groupAbsent(phase.process_group);
          }),
        );
        assert.equal(phase()?.remainingBudgets.concurrency, 0);
        if (scenario === 'paused') {
          writerPause = controller.execute(
            command('PauseAdmissions', { taskId: parent.id, runId: preview.runId }, rev()),
            'local-owner',
          );
          activeResume = controller.execute(
            command('ResumeRun', { taskId: parent.id, runId: preview.runId }, rev()),
            'local-owner',
          );
        }
        if (scenario === 'stopped') {
          void controller.execute(
            command('StopRun', { taskId: parent.id, runId: preview.runId }, rev()),
            'local-owner',
          );
        } else
          for (const intent of active) {
            const taskPhase = controller.store.nativeProcesses(intent.attempt_id).at(-1);
            const child = context.children.find((child) => child.pid === taskPhase?.process_group);
            assert(child);
            child.stdin?.write(`${JSON.stringify({ method: 'fixture/release' })}\n`);
          }
      });
      const members =
        quotaScenario && scenario !== 'quota-both'
          ? [...preview.members].reverse()
          : preview.members;
      for (const [index, member] of members.entries()) {
        if (scenario === 'unknown' && index === 1) break;
        assert.equal(
          (
            await controller.execute(
              command(
                'StartRun',
                { taskId: member.taskId, runId: member.runId },
                rev(member.taskId),
              ),
              'local-owner',
            )
          ).outcome,
          'applied',
        );
        if (quotaScenario && scenario !== 'quota-both' && index === 0)
          await waitFor(
            'quota sibling passes',
            () =>
              controller.store
                .combinedDispatches(preview.runId)
                .find((slot) => slot.phase === 'writer-1')?.state === 'passed',
            'writers',
          );
      }
      if (scenario === 'quota-both') {
        await waitFor(
          'both quota children wait for reset',
          () =>
            controller.store
              .combinedDispatches(preview.runId)
              .filter((slot) => slot.phase.startsWith('writer-'))
              .every((slot) => slot.state === 'stopped'),
          'writers',
        );
        assert.equal(phase()?.phase, 'blocked');
        controller = await context.restart();
        const pending = scheduled.filter((entry) => entry.delay === 60_000 && !entry.cancelled);
        assert.equal(pending.length, 2);
        context.clock.advance(60_000);
        pending[0]?.callback();
        pending[1]?.callback();
        await waitFor(
          'both quota children retry',
          () =>
            controller.store
              .combinedDispatches(preview.runId)
              .filter((slot) => slot.phase.startsWith('writer-'))
              .every((slot) => slot.state === 'passed') && phase()?.assemble.available === true,
          'writers',
        );
        for (const member of preview.members)
          assert.equal(
            controller.store.intents().filter((intent) => intent.run_id === member.runId).length,
            2,
          );
        continue;
      }
      if (scenario === 'quota' || scenario === 'quota-stop') {
        await waitFor(
          'quota child waits for reset',
          () => {
            const slots = controller.store.combinedDispatches(preview.runId);
            return (
              slots.find((slot) => slot.phase === 'writer-0')?.state === 'stopped' &&
              slots.find((slot) => slot.phase === 'writer-1')?.state === 'passed'
            );
          },
          'writers',
        );
        assert.equal(phase()?.phase, 'blocked');
        assert.equal(phase()?.blocker, 'writers-incomplete');
        const quotaSchedules = () => scheduled.filter((pending) => pending.delay === 60_000);
        const pendingReset = quotaSchedules().find((pending) => !pending.cancelled);
        assert(pendingReset);
        const before = controller.store.combinedDispatches(preview.runId);
        const deniedAttempt = before.find((slot) => slot.phase === 'writer-0')?.attempt_id;
        const sibling = before.find((slot) => slot.phase === 'writer-1');
        assert(deniedAttempt && sibling?.candidate_id);
        const denial = controller.store.receipt(`native-completion:${deniedAttempt}`);
        assert(denial);
        assert.equal(
          controller.store.intents().filter((intent) => intent.run_id === preview.members[1].runId)
            .length,
          1,
        );
        assert.equal(
          controller.store.intents().filter((intent) => intent.run_id === preview.members[0].runId)
            .length,
          1,
        );
        if (scenario === 'quota-stop') {
          const stopped = await controller.execute(
            command(
              'StopRun',
              { taskId: preview.members[1].taskId, runId: preview.members[1].runId },
              rev(preview.members[1].taskId),
            ),
            'local-owner',
          );
          assert.equal(stopped.outcome, 'applied');
          context.clock.advance(60_000);
          pendingReset.callback();
          assert.equal(
            controller.store
              .intents()
              .filter((intent) => intent.run_id === preview.members[0].runId).length,
            1,
          );
          assert.equal(phase()?.phase, 'blocked');
          assert.equal(phase()?.blocker, 'stopped');
          continue;
        }
        controller = await context.restart();
        assert.equal(phase()?.phase, 'blocked');
        assert.equal(pendingReset.cancelled, true);
        const rearmed = quotaSchedules().filter((pending) => !pending.cancelled);
        assert.equal(rearmed.length, 1);
        context.clock.advance(60_000);
        rearmed[0]?.callback();
        await waitFor(
          'quota child retry',
          () =>
            controller.store.combinedDispatches(preview.runId)[1]?.state === 'passed' &&
            phase()?.assemble.available === true,
          'writers',
        );
        assert.equal(
          controller.store.intents().filter((intent) => intent.run_id === preview.members[0].runId)
            .length,
          2,
        );
        rearmed[0]?.callback();
        assert.equal(
          controller.store.intents().filter((intent) => intent.run_id === preview.members[0].runId)
            .length,
          2,
        );
        const after = controller.store.combinedDispatches(preview.runId);
        assert.equal(
          after.find((slot) => slot.phase === 'writer-1')?.attempt_id,
          sibling.attempt_id,
        );
        assert.equal(
          after.find((slot) => slot.phase === 'writer-1')?.candidate_id,
          sibling.candidate_id,
        );
        assert.deepEqual(controller.store.receipt(`native-completion:${deniedAttempt}`), denial);
      }
      if (scenario === 'unknown') {
        await waitFor('unknown owner', () => phase()?.phase === 'unknown');
        const unknown = controller.store.combinedDispatches(preview.runId)[1];
        assert.equal(unknown.state, 'unknown');
        assert.equal(
          controller.store.db
            .prepare('SELECT count(*) AS total FROM reservations WHERE attempt_id=?')
            .get(unknown.attempt_id)?.total,
          1,
        );
        const before = controller.store.intents().length;
        assert.equal(
          (
            await controller.execute(
              command(
                'StartRun',
                { taskId: preview.members[1].taskId, runId: preview.members[1].runId },
                rev(preview.members[1].taskId),
              ),
              'local-owner',
            )
          ).outcome,
          'blocked',
        );
        controller = await context.restart();
        assert.equal(phase()?.phase, 'unknown');
        assert.equal(controller.store.intents().length, before);
        assert.equal(controller.store.combinedDispatches(preview.runId)[1].state, 'unknown');
        continue;
      }
      if (scenario === 'stopped') {
        await waitFor('aggregate stop', () =>
          ['stopped', 'unknown'].includes(phase()?.phase ?? ''),
        );
        assert.equal(phase()?.phase, 'stopped');
        assert.equal(
          controller.store.intents().every((intent) => intent.state === 'stopped'),
          true,
        );
        assert.equal(phase()?.assemble.available, false);
        continue;
      }
      if (scenario === 'paused') {
        await waitFor('both admitted writers paused', () => !!writerPause && !!activeResume);
        assert(writerPause && activeResume);
        assert.equal((await writerPause).outcome, 'applied');
        assert.equal((await activeResume).outcome, 'blocked');
        await waitFor(
          'paused writers close',
          () =>
            controller.store
              .combinedDispatches(preview.runId)
              .slice(1, 3)
              .every((slot) => slot.state === 'passed'),
          'writers',
        );
        assert.equal(phase()?.phase, 'paused');
        assert.equal(phase()?.assemble.available, false);
        const before = controller.store.intents().length;
        assert.equal(
          (
            await controller.execute(
              command('ResumeRun', { taskId: parent.id, runId: preview.runId }, rev()),
              'local-owner',
            )
          ).outcome,
          'applied',
        );
        assert.equal(controller.store.intents().length, before);
        assert.equal(phase()?.phase, 'writers');
      }
      await waitFor(
        'writers',
        () =>
          phase()?.assemble.available === true ||
          ['blocked', 'unknown'].includes(phase()?.phase ?? ''),
        'writers',
      );
      assert.equal(phase()?.assemble.available, true, JSON.stringify(phase()));
      if (scenario === 'recovered')
        controller.store.db.exec(
          "CREATE TRIGGER interrupt_combined_receipt BEFORE UPDATE OF state ON combined_ref_intents WHEN NEW.operation='replay-0-ref' AND NEW.state='applied' BEGIN SELECT RAISE(ABORT,'interrupted ref receipt'); END",
        );
      assert.equal(
        (
          await controller.execute(
            command(
              'AssembleCombinedCandidate',
              { taskId: parent.id, runId: preview.runId, preparationId: preview.preparationId },
              rev(),
            ),
            'local-owner',
          )
        ).outcome,
        'applied',
      );
      if (scenario === 'recovered') {
        await waitFor('ref receipt interruption', () => phase()?.phase === 'blocked', 'assembly');
        const pending = controller.store
          .combinedRefIntents(preview.runId)
          .find((row) => row.operation === 'replay-0-ref');
        assert(pending?.expected_new);
        assert.equal(pending.state, 'prepared');
        assert.equal(
          readFileSync(
            join(
              controller.home,
              'integration',
              preview.runId,
              `integration-${preview.runId}.git`,
              `refs/crewkite/integration/${preview.runId}`,
            ),
            'utf8',
          ),
          `${pending.expected_new}\n`,
        );
        controller.store.db.exec('DROP TRIGGER interrupt_combined_receipt');
        const attempts = controller.store.intents().length;
        context.clock.advance(61000);
        controller = await context.restart();
        const recovered = controller.store.combinedGroup(preview.runId);
        assert(recovered);
        assert.equal(recovered.integration_maximum_minutes, 3);
        assert(recovered.integration_milliseconds >= 61000);
        assert(recovered.integration_milliseconds < 180000);
        assert.equal(phase()?.phase, 'assembling');
        assert.equal(controller.store.intents().length, attempts);
        assert.equal(
          (
            await controller.execute(
              command(
                'AssembleCombinedCandidate',
                { taskId: parent.id, runId: preview.runId, preparationId: preview.preparationId },
                rev(),
              ),
              'local-owner',
            )
          ).outcome,
          'applied',
        );
      }
      await waitFor(
        'assembly',
        () =>
          phase()?.phase === 'awaiting-evaluation' ||
          ['blocked', 'unknown'].includes(phase()?.phase ?? ''),
        'assembly',
      );
      assert.equal(
        phase()?.phase,
        'awaiting-evaluation',
        JSON.stringify({
          capturedAt: new Date().toISOString(),
          integration: {
            maximumMinutes: controller.store.combinedGroup(preview.runId)
              ?.integration_maximum_minutes,
            milliseconds: controller.store.combinedGroup(preview.runId)?.integration_milliseconds,
            journals: controller.store.combinedRefIntents(preview.runId).map((row) => ({
              operation: row.operation,
              state: row.state,
              phases: (
                JSON.parse(row.body).phases as {
                  kind: string;
                  state: string;
                  group: number | null;
                }[]
              ).map((phase) => ({
                kind: phase.kind,
                state: phase.state,
                group: phase.group,
              })),
            })),
          },
          preview: phase(),
        }),
      );
      const candidate = phase()?.candidate;
      assert(candidate);
      const slots = controller.store.combinedDispatches(preview.runId);
      assert.equal(new Set(slots.slice(1, 5).map((slot) => slot.candidate_id)).size, 4);
      assert(!slots.some((slot) => slot.candidate_id === candidate.id));
      if (scenario === 'passed') {
        const exported = await controller.execute(
          command('ExportPatch', { taskId: parent.id, candidateId: candidate.id }, rev()),
          'local-owner',
        );
        const approval = controller
          .snapshot()
          .approvals.find(
            (approval) =>
              approval.taskId === parent.id &&
              approval.action === 'export-patch' &&
              approval.status === 'pending',
          );
        assert(approval, JSON.stringify(exported));
        assert.equal(
          approval.attemptId,
          controller.store.combinedDispatches(preview.runId)[4].attempt_id,
        );
        const exportedResult = await controller.execute(
          command('ResolveApproval', { binding: binding(approval), decision: 'approved' }, rev()),
          'local-owner',
        );
        assert.equal(exportedResult.outcome, 'applied', JSON.stringify(exportedResult));
        assert.equal(ArtifactSchema.parse(exportedResult.entity).mediaType, 'text/x-patch');
        assert.equal(
          controller.store
            .intents()
            .filter((intent) => controller.store.runPurpose(intent.run_id) !== 'conversation')
            .length,
          5,
        );
      }

      const evaluation = await controller.execute(
        command(
          'PrepareCandidateEvaluation',
          {
            taskId: parent.id,
            candidateId: candidate.id,
            checkRecipeId: 'project-node-tests-v1',
            testFiles: input.checks.testFiles,
            reviewer: { profileId: 'openai-file-v1', methodId: 'keep-it-simple', cycles: 1 },
            creditPolicy: 'ordinary',
            consent: 'explicit',
            grants: ['run-check', 'run-review'].map((action) => ({
              taskId: parent.id,
              action,
              target: action === 'run-check' ? 'node --test' : 'keep-it-simple/cycle-1',
              expiresAt,
              usesRemaining: 1,
              revoked: false,
            })),
          },
          rev(),
        ),
        'local-owner',
      );
      assert.equal(evaluation.outcome, 'applied', JSON.stringify(evaluation));
      const evaluationArtifact = ArtifactSchema.parse(evaluation.entity);
      const start = {
        taskId: parent.id,
        candidateId: candidate.id,
        preparationId: evaluationArtifact.id,
      };
      assert.equal(
        (await controller.execute(command('StartCandidateReview', start, rev()), 'local-owner'))
          .outcome,
        'blocked',
      );
      let checkPause: Promise<CommandResult> | undefined;
      const offCheckPause = context.observe(controller, (event) => {
        if (
          scenario === 'paused' &&
          event.type === 'check.completed' &&
          event.payload.candidateId === candidate.id &&
          event.payload.passed
        )
          checkPause = controller.execute(
            command('PauseAdmissions', { taskId: parent.id, runId: preview.runId }, rev()),
            'local-owner',
          );
      });
      const leaveFullBarrier = await enterFullBarrier();
      try {
        assert.equal(
          (
            await controller.execute(
              command('StartCandidateEvaluation', start, rev()),
              'local-owner',
            )
          ).outcome,
          'applied',
        );
        if (scenario === 'paused') {
          await waitFor(
            'paused final check',
            () =>
              phase()?.phase === 'paused' &&
              controller.store.combinedDispatches(preview.runId)[5].state === 'passed' &&
              controller.store
                .intents()
                .filter((intent) => intent.run_id === preview.runId)
                .every((intent) => intent.state === 'stopped'),
            'checks',
          );
          assert(checkPause);
          assert.equal((await checkPause).outcome, 'applied');
          assert.equal(phase()?.review.available, false);
          const before = controller.store.intents().length;
          assert.equal(
            (
              await controller.execute(
                command('ResumeRun', { taskId: parent.id, runId: preview.runId }, rev()),
                'local-owner',
              )
            ).outcome,
            'applied',
          );
          assert.equal(controller.store.intents().length, before);
        }
        offCheckPause();
        await waitFor(
          'full checks',
          () => ['awaiting-review', 'blocked', 'unknown'].includes(phase()?.phase ?? ''),
          'checks',
        );
      } finally {
        leaveFullBarrier();
      }
      if (scenario === 'interaction-failed') {
        assert.equal(phase()?.phase, 'blocked');
        assert.equal(controller.store.combinedDispatches(preview.runId)[5].state, 'failed');
        assert.equal(
          (await controller.execute(command('StartCandidateReview', start, rev()), 'local-owner'))
            .outcome,
          'blocked',
        );
        assert.equal(
          (
            await controller.execute(
              command(
                'AcceptCandidate',
                {
                  taskId: parent.id,
                  candidateId: candidate.id,
                  destinationRef: 'refs/heads/combined',
                },
                rev(),
              ),
              'local-owner',
            )
          ).outcome,
          'blocked',
        );
        assert.equal(refValue(context.source.directory, 'refs/heads/combined'), null);
        continue;
      }
      assert.equal(phase()?.phase, 'awaiting-review', JSON.stringify(phase()));
      let reviewPause: Promise<CommandResult> | undefined;
      const offReviewPause = context.observe(controller, (event) => {
        if (
          scenario === 'paused' &&
          event.type === 'review.completed' &&
          event.payload.candidateId === candidate.id &&
          event.payload.passed
        )
          reviewPause = controller.execute(
            command('PauseAdmissions', { taskId: parent.id, runId: preview.runId }, rev()),
            'local-owner',
          );
      });
      assert.equal(
        (await controller.execute(command('StartCandidateReview', start, rev()), 'local-owner'))
          .outcome,
        'applied',
      );
      if (scenario === 'paused') {
        await waitFor(
          'paused completed review',
          () =>
            phase()?.phase === 'paused' &&
            controller.store.combinedDispatches(preview.runId)[6].state === 'passed' &&
            controller.store
              .intents()
              .filter((intent) => intent.run_id === preview.runId)
              .every((intent) => intent.state === 'stopped'),
          'review',
        );
        assert(reviewPause);
        assert.equal((await reviewPause).outcome, 'applied');
        assert.equal(phase()?.accept.available, false);
        const before = controller.store.intents().length;
        assert.equal(
          (
            await controller.execute(
              command('ResumeRun', { taskId: parent.id, runId: preview.runId }, rev()),
              'local-owner',
            )
          ).outcome,
          'applied',
        );
        assert.equal(controller.store.intents().length, before);
      }
      offReviewPause();
      await waitFor(
        'review',
        () => ['ready', 'blocked', 'unknown'].includes(phase()?.phase ?? ''),
        'review',
      );
      assert.equal(phase()?.phase, 'ready', JSON.stringify(phase()));
      const snapshot = controller.snapshot();
      assert.equal(snapshot.attempts.length, scenario === 'quota' ? 10 : 9);
      assert.equal(
        controller.store
          .intents()
          .filter((intent) => controller.store.runPurpose(intent.run_id) !== 'conversation').length,
        scenario === 'quota' ? 8 : 7,
      );
      assert(
        snapshot.reviewJobs?.every(
          (job) => !job.scripted && 'origin' in job && !('writerAttemptId' in job),
        ),
      );
      assert.equal(
        snapshot.runs.find((run) => run.id === preview.runId)?.roles[0].role,
        'reviewer',
      );
      if (scenario === 'passed') {
        const path = join(context.source.directory, 'src/a.mjs');
        const original = readFileSync(path);
        appendFileSync(path, '// Source drift.\n');
        assert.equal(phase()?.accept.available, false);
        assert.equal(
          (await controller.execute(command('GetChanges', { taskId: parent.id }), 'local-owner'))
            .outcome,
          'blocked',
        );
        writeFileSync(path, original);
        assert.equal(phase()?.accept.available, true);
      }
      const ask = await controller.execute(
        command(
          'AcceptCandidate',
          { taskId: parent.id, candidateId: candidate.id, destinationRef: 'refs/heads/combined' },
          rev(),
        ),
        'local-owner',
      );
      const approval = controller
        .snapshot()
        .approvals.find(
          (approval) =>
            approval.taskId === parent.id &&
            approval.action === 'accept-candidate' &&
            approval.status === 'pending',
        );
      assert(approval, JSON.stringify(ask));
      assert.equal(
        approval.attemptId,
        controller.store.combinedDispatches(preview.runId)[6].attempt_id,
      );
      const accept = command(
        'ResolveApproval',
        { binding: binding(approval), decision: 'approved' },
        rev(),
      );
      const accepted = await controller.execute(accept, 'local-owner');
      assert.equal(accepted.outcome, 'applied', JSON.stringify(accepted));
      assert.equal(phase()?.phase, 'accepted');
      for (const stoppedTaskId of [parent.id, children[0].id]) {
        const stoppedRunId = (
          controller.snapshot().tasks.find((task) => task.id === stoppedTaskId) as Task
        ).runId;
        assert.equal(
          (
            await controller.execute(
              command(
                'StopRun',
                { taskId: stoppedTaskId, runId: stoppedRunId },
                rev(stoppedTaskId),
              ),
              'local-owner',
            )
          ).outcome,
          'applied',
        );
        assert.equal(phase()?.phase, 'accepted');
        assert.equal(
          controller.snapshot().tasks.find((task) => task.id === parent.id)?.state,
          'accepted',
        );
      }

      const acceptedHead = refValue(context.source.directory, 'refs/heads/combined');
      assert(acceptedHead);
      assert.equal(
        git(context.source.directory, ['show', `${acceptedHead}:src/a.mjs`]).toString(),
        'export const value = 1;\n',
      );
      assert.equal(
        git(context.source.directory, ['show', `${acceptedHead}:src/b.mjs`]).toString(),
        'export const value = 1;\n',
      );
      assert.equal((await controller.execute(accept, 'local-owner')).outcome, 'already-applied');
      controller = await context.restart();
      assert.equal(controller.snapshot().combinedRuns[0]?.phase, 'accepted');
      assert.equal(refValue(context.source.directory, 'refs/heads/combined'), acceptedHead);
    }
  };
  const pending = scenarioQueues.map((scenarios, queue) => run(scenarios, queue));
  const results = await Promise.allSettled(pending);
  for (const [index, result] of results.entries())
    if (result.status === 'rejected') {
      const error = result.reason instanceof Error ? result.reason : Error(String(result.reason));
      console.error(
        `Combined fixture scenario ${activeScenario[index] ?? 'unknown'} failed:\n${(error.stack ?? error.message).slice(0, 8192)}`,
      );
      throw result.reason;
    }
});
