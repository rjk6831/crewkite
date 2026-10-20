import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import {
  AnthropicNativeProfileSchema,
  type Approval,
  ArtifactSchema,
  type Attempt,
  GoogleNativeProfileSchema,
  NativeRepositoryProfileSchema,
  ProjectSchema,
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
import { spawnCheckChild as spawn } from '../host/check-ownership.ts';
import { committedFiles, git, inspectSource } from '../host/source.ts';
import { groupAbsent } from '../host/worker.ts';
import { replacementFixture as anthropicFixture } from '../providers/anthropic/replacement-fixture.ts';
import { replacementFixture as googleFixture } from '../providers/google/replacement-fixture.ts';
import {
  type NativeProfileResolution,
  unavailableNativeProfile,
  unavailableRepositoryProfile,
} from '../providers/openai/profile.ts';
import {
  fixture,
  fixtureContent,
  fixtureModel,
  repositoryFixture,
} from '../providers/openai/replacement-fixture.ts';

const fixtureClientHash = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');

async function setup(
  t: TestContext,
  options: Partial<ControllerOptions> = {},
  close: (controller: Controller) => void | Promise<void> = (controller) => controller.close(),
) {
  mkdirSync(resolve('internal'), { recursive: true });
  const directory = mkdtempSync(join(resolve('internal'), 'controller-test-'));
  const clock = createTestClock();
  const id = createTestIds(clock.now(), 1000n);
  const fixtures = createDemoFixtures(clock.now());
  const source = createSyntheticRepository(join(directory, 'demo-shop'));
  const controller = new Controller({
    ...options,
    home: options.home ?? join(directory, 'home'),
    now: clock.now,
    id,
    routes: fixtures.snapshot.routes,
    observations: fixtures.snapshot.usage.map((window) => window.observation),
  });
  t.after(async () => {
    await close(controller);
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

async function nativeWait<T>(
  stage: string,
  pending: Promise<T>,
  milliseconds = 30_000,
): Promise<T> {
  console.error(`Native fixture stage: ${stage}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Native fixture ${stage} timed out.`));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function nativeSetup(
  t: TestContext,
  mode = 'success',
  options: Partial<ControllerOptions> = {},
  targetPath = 'net.mjs',
) {
  const anthropic = mode.startsWith('anthropic-') || mode === 'combined-quota';
  const google = mode.startsWith('google-');
  const repository = mode.startsWith('repository-');
  let repositoryCli = '';
  let submissions = 0;
  const ready = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<never>();
  let callbackError: unknown;
  const fail = (error: unknown) => {
    callbackError ??= error;
    failure.reject(error);
  };
  void failure.promise.catch(() => {});
  t.after(() => {
    if (callbackError) throw callbackError;
  });
  const observe = (controller: Controller, listener: Parameters<Controller['subscribe']>[0]) =>
    controller.subscribe((event) => {
      try {
        listener(event);
      } catch (error) {
        fail(error);
      }
    });
  const childrenClosed: Promise<void>[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  let onSpawn: ((phase: string) => void) | undefined;
  let onInput: ((message: { method?: string }, phase: string) => void) | undefined;
  let onWritten: typeof onInput;
  const reviewerProfile = {
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
      sha256: fixtureClientHash,
      version: process.version,
    },
    environment: { ...process.env },
    locationHash: '1'.repeat(64),
  } satisfies NativeProfileResolution;
  const repositoryFields = unavailableRepositoryProfile().facts;
  const fixtureProfile = anthropic
    ? {
        ...reviewerProfile,
        facts: AnthropicNativeProfileSchema.parse({
          id: 'anthropic-file-v1',
          family: 'anthropic',
          displayName: 'Anthropic fixture',
          clientVersion: process.version,
          model: fixtureModel,
          effort: 'medium',
          effectiveEffort: 'unknown',
          accountClass: 'unknown',
          serviceTier: 'unknown',
          billingBasis: 'requires-user-attestation',
          qualifiedAt: null,
          creditPolicies: ['ordinary'],
          maximumTaskMs: 300000,
          maximumFileBytes: 65536,
          maximumSubmissions: 1,
          available: true,
          reason: 'qualification-pending',
        }),
        locationHash: '2'.repeat(64),
      }
    : google
      ? {
          ...reviewerProfile,
          environment: { ...reviewerProfile.environment, HOME: userInfo().homedir },
          client: {
            executable: process.execPath,
            sha256: fixtureClientHash,
            version: '1.4.0',
          },
          facts: GoogleNativeProfileSchema.parse({
            ...reviewerProfile.facts,
            id: 'google-file-v1',
            family: 'google',
            displayName: 'Google fixture',
            clientVersion: '1.4.0',
            effort: 'low',
            effectiveEffort: 'unknown',
            accountClass: 'unknown',
            serviceTier: 'unknown',
            billingBasis: 'requires-user-attestation',
            qualifiedAt: null,
            creditPolicies: ['ordinary'],
            reason: 'qualification-pending',
            permissionModes: ['request-review', 'strict', 'always-proceed', 'proceed-in-sandbox'],
          }),
          locationHash: '3'.repeat(64),
        }
      : repository
        ? {
            ...reviewerProfile,
            facts: NativeRepositoryProfileSchema.parse({
              ...repositoryFields,
              id: 'openai-repository-v1',
              model: fixtureModel,
              clientVersion: process.version,
              displayName: 'Repository fixture',
              available: true,
              reason: 'qualification-pending',
              qualifiedAt: null,
              maximumSourceFiles: 10000,
              maximumSourceBytes: 67108864,
              execution: {
                sandbox: 'workspace-write',
                approvalPolicy: 'never',
                networkAccess: false,
              },
            }),
            locationHash: '4'.repeat(64),
          }
        : reviewerProfile;
  const nativeOptions: Partial<ControllerOptions> = {
    ...(anthropic || google || repository
      ? { nativeProfiles: () => [reviewerProfile, fixtureProfile] }
      : { nativeProfile: () => fixtureProfile }),
    ...options,
    nativeSpawn: (executable, args, spawnOptions) => {
      const pending = context.controller.store
        .intents()
        .flatMap((intent) => context.controller.store.nativeProcesses(intent.attempt_id))
        .filter((row) => row.state === 'intent')
        .at(-1);
      const pendingFamily = pending
        ? context.controller.store.get<{ family: string }>(
            'route',
            context.controller.store
              .intents()
              .find((intent) => intent.attempt_id === pending.attempt_id)?.route_id ?? '',
          )?.family
        : undefined;
      const googleChild = pendingFamily === 'google';
      const anthropicChild =
        pendingFamily === 'anthropic' &&
        (pending?.phase === 'auth-status' || pending?.phase === 'native-task');
      const phase =
        pending?.phase === 'google-config'
          ? 'config'
          : pending?.phase === 'auth-status'
            ? 'auth'
            : args.at(-1) === 'list'
              ? 'features'
              : pending?.phase === 'metadata-preparation'
                ? 'prepare'
                : 'task';
      if (
        mode === 'combined-unknown' &&
        phase === 'features' &&
        context.controller.store.runPurpose(
          context.controller.store.get<Attempt>('attempt', pending?.attempt_id ?? '')?.runId ?? '',
        ) !== 'conversation'
      )
        throw Error('The fixture could not spawn its admitted phase.');
      let transcript = fixture;
      if (mode.includes('checked')) {
        const proposal = join(context.directory, 'checked-proposal');
        mkdirSync(proposal, { recursive: true });
        writeFileSync(join(proposal, 'net.mjs'), '');
        writeChallengeSolution(proposal);
        transcript = fixture.replace(
          `const content = ${fixtureContent.toString()};`,
          `const content = () => ${JSON.stringify(readFileSync(join(proposal, 'net.mjs'), 'utf8'))};`,
        );
      }
      transcript = transcript.replace(
        'const path = message.params.outputSchema.properties.path.const;',
        'const path = message.params.outputSchema.properties.path?.const;',
      );
      if (mode.startsWith('combined-')) {
        transcript = transcript.replace(
          `const content = ${fixtureContent.toString()};`,
          `const content = () => 'export const value = 1;\\n';`,
        );
        transcript = transcript.replace(
          '  if (!message.id) return;',
          "  if (message.method === 'fixture/release') { globalThis.release?.(); return; }\n  if (!message.id) return;",
        );
        transcript = transcript.replace(
          "  if (message.method === 'turn/start' && mode === 'success') {",
          "  if (message.method === 'turn/start' && mode === 'success') { const complete = () => {",
        );
        transcript = transcript.replace(
          '\n  }\n});',
          mode === 'combined-quota'
            ? '\n    }; complete();\n  }\n});'
            : '\n    }; if (message.params.outputSchema.properties.bindingHash) complete(); else globalThis.release=complete;\n  }\n});',
        );
      }
      const replacement =
        'const edit = {version:1,attemptId:message.params.outputSchema.properties.attemptId.const,path,baseHash:message.params.outputSchema.properties.baseHash.const,content:content(path)};';
      transcript = transcript.replace(
        replacement,
        `const edit = message.params.outputSchema.properties.message ? {version:1,bindingHash:message.params.outputSchema.properties.bindingHash.const,message:'The scoped request is retained.',questions:[],proposal:{summary:'Keep the bounded export.',criteria:JSON.parse(message.params.input[0].text.split('\\n').at(-1)).context.criteria,slices:[{id:'target',title:'Change the bounded target',role:'coder',scope:[JSON.parse(message.params.input[0].text.split('\\n').at(-1)).context.title.endsWith('a')?'src/a.mjs':'src/b.mjs'],dependsOn:[]}],checks:[]}} : message.params.outputSchema.properties.bindingHash ? {version:1,bindingHash:message.params.outputSchema.properties.bindingHash.const,methodId:message.params.outputSchema.properties.methodId.const,cycle:1,outcome:${JSON.stringify(mode === 'checked-blocked' ? 'blocked' : 'passed')},findings:[],summary:'The bounded review completed.'} : ${replacement.slice('const edit = '.length)}`,
      );
      const repositoryWriter =
        repository &&
        pending &&
        !context.controller.store.db
          .prepare('SELECT attempt_id FROM review_jobs WHERE attempt_id=?')
          .get(pending.attempt_id);
      if (repositoryWriter)
        transcript = repositoryFixture([
          {
            path: 'net.mjs',
            content: mode.includes('checked')
              ? readFileSync(join(context.directory, 'checked-proposal/net.mjs'), 'utf8')
              : fixtureContent(targetPath),
          },
          {
            path: 'cli.mjs',
            content: `${repositoryCli}// The command keeps the same interface.\n`,
          },
          {
            path: 'docs/日本語.md',
            content: '# Calculation notes\nThe discount clamps at zero.\n',
          },
          { path: 'index.html', content: null },
        ]);
      if (anthropicChild) {
        const pendingIntent = context.controller.store
          .intents()
          .find((value) => value.attempt_id === pending?.attempt_id);
        const content = mode.includes('checked')
          ? readFileSync(join(context.directory, 'checked-proposal/net.mjs'), 'utf8')
          : mode === 'combined-quota'
            ? 'export const value = 1;\n'
            : fixtureContent(targetPath);
        transcript = anthropicFixture(args, {
          content,
          mode:
            mode === 'anthropic-hold'
              ? 'hold'
              : mode === 'anthropic-overage'
                ? 'overage'
                : mode === 'anthropic-quota' ||
                    mode === 'anthropic-quota-future' ||
                    (mode === 'combined-quota' && pendingIntent?.generation === 0)
                  ? 'quota'
                  : mode === 'anthropic-auth-api'
                    ? 'auth-api'
                    : 'success',
        });
        if (mode === 'anthropic-quota-future')
          transcript = transcript.replace('resetsAt:1792000000', 'resetsAt:1792094400');
        if (mode === 'combined-quota')
          transcript = transcript.replace('resetsAt:1792000000', 'resetsAt:1792083660');
      }
      if (googleChild) {
        transcript = googleFixture(args, {
          content: mode.includes('checked')
            ? readFileSync(join(context.directory, 'checked-proposal/net.mjs'), 'utf8')
            : fixtureContent(targetPath),
          permissionMode:
            mode === 'google-strict'
              ? 'strict'
              : mode === 'google-always-proceed'
                ? 'always-proceed'
                : mode === 'google-proceed-in-sandbox'
                  ? 'proceed-in-sandbox'
                  : 'request-review',
          mode:
            mode === 'google-hold'
              ? 'hold'
              : mode === 'google-credits'
                ? 'credits'
                : mode === 'google-mode-mismatch'
                  ? 'mode-mismatch'
                  : mode === 'google-config-error'
                    ? 'config-error'
                    : 'success',
        });
        if (phase === 'task') {
          assert(pending);
          assert.equal(pending.state, 'intent');
          assert(
            context.controller.store.receipt(`native-submission:${pending.attempt_id}`),
            'the argv prompt marker commits before spawn',
          );
          submissions++;
          onInput?.({ method: 'prompt' }, phase);
        }
      }
      const child = spawn(
        executable,
        [
          '-e',
          transcript,
          mode.includes('checked') || mode.startsWith('combined-') || anthropic || repository
            ? mode === 'repository-hold'
              ? 'hold'
              : 'success'
            : mode,
          phase,
        ],
        spawnOptions,
      );
      children.push(child);
      childrenClosed.push(new Promise((resolve) => child.once('close', () => resolve())));
      const write = child.stdin?.write.bind(child.stdin);
      if (!anthropicChild && !googleChild)
        child.stdin.write = ((data: Uint8Array) => {
          try {
            const messages = Buffer.from(data)
              .toString()
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as { method?: string });
            const attempt = context.controller.store
              .intents()
              .find((intent) => intent.attempt_id === pending?.attempt_id);
            assert(attempt, 'the controller commits admission before native input');
            assert.equal(
              context.controller.store.nativeProcesses(attempt.attempt_id).at(-1)?.state,
              'owned',
            );
            for (const message of messages) {
              if (message.method === 'turn/start') {
                submissions++;
                const review = context.controller.store.db
                  .prepare('SELECT body FROM review_jobs WHERE attempt_id=?')
                  .get(attempt.attempt_id);
                assert(
                  context.controller.store.receipt(
                    `${context.controller.store.runPurpose(attempt.run_id) === 'conversation' ? 'conversation-submission' : review ? 'native-review-submission' : 'native-submission'}:${attempt.attempt_id}`,
                  ),
                );
              }
              onInput?.(message, phase);
            }
            if (!write) throw Error('Missing fixture input.');
            const result = write(data);
            for (const message of messages) onWritten?.(message, phase);
            if (messages.some((message) => message.method === 'turn/start')) ready.resolve();
            return result;
          } catch (error) {
            fail(error);
            throw error;
          }
        }) as typeof child.stdin.write;
      if (anthropicChild && phase === 'task') {
        const end = child.stdin.end.bind(child.stdin);
        child.stdin.end = ((data: string) => {
          if (data === undefined) return end();
          try {
            assert(pending);
            assert.equal(
              context.controller.store.nativeProcesses(pending.attempt_id).at(-1)?.state,
              'owned',
            );
            assert(context.controller.store.receipt(`native-submission:${pending.attempt_id}`));
            submissions++;
            onInput?.({ method: 'prompt' }, phase);
            const result = end(data);
            onWritten?.({ method: 'prompt' }, phase);
            ready.resolve();
            return result;
          } catch (error) {
            fail(error);
            throw error;
          }
        }) as typeof child.stdin.end;
      }
      if (googleChild && phase === 'task') {
        onWritten?.({ method: 'prompt' }, phase);
        ready.resolve();
      }
      try {
        onSpawn?.(phase);
      } catch (error) {
        fail(error);
        throw error;
      }
      return child;
    },
  };
  const close = async (controller: Controller) => {
    try {
      await nativeWait(
        'cleanup',
        Promise.resolve().then(() => controller.close()),
        10_000,
      );
      if (callbackError) throw callbackError;
    } catch (error) {
      for (const child of children) {
        if (child.pid && !groupAbsent(child.pid)) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }
      }
      await nativeWait('forced fixture cleanup', Promise.all(childrenClosed), 2000);
      assert(children.every((child) => !child.pid || groupAbsent(child.pid)));
      throw error;
    }
  };
  const context = await nativeWait(
    `${mode}/${targetPath}/setup`,
    Promise.resolve().then(() => setup(t, nativeOptions, close)),
  );
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
  const sourceFiles = committedFiles(context.source.directory, source.base);
  if (repository) {
    const cli = sourceFiles.find((file) => file.path === 'cli.mjs');
    assert(cli);
    repositoryCli = cli.content.toString('utf8');
  }
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
  if (repository) {
    const write = policy.effects.find((grant) => grant.action === 'write-scratch');
    assert(write);
    policy.effects.push({
      ...write,
      action: 'run-native-tools',
      expiresAt: new Date(Date.parse(context.clock.now()) + 180000).toISOString(),
    });
  }
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
      sha256: fixtureClientHash,
      version: process.version,
    },
    creditPolicy: 'ordinary',
    target: {
      path: targetPath,
      baseHash: sourceFiles.find((file) => file.path === targetPath)?.hash as string,
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
    reviewerProfile,
    restart: async () => {
      await close(context.controller);
      context.controller = await nativeWait(
        `${mode}/${targetPath}/restart`,
        Promise.resolve().then(
          () =>
            new Controller({
              ...nativeOptions,
              home: context.controller.home,
              now: context.clock.now,
              id: context.id,
            }),
        ),
      );
      t.after(() => close(context.controller));
      return context.controller;
    },
    children,
    planningTrace: (taskId: string) => {
      const task = context.controller.store.get<{ state: string; next: string | null }>(
        'task',
        taskId,
      );
      const attempts = context.controller.store
        .list<Attempt>('attempt')
        .filter(
          (attempt) =>
            context.controller.store.get<{ taskId: string }>('run', attempt.runId)?.taskId ===
            taskId,
        )
        .map((attempt) => {
          const receipt = context.controller.store.receipt(`conversation-completion:${attempt.id}`);
          const artifact = ArtifactSchema.safeParse(receipt?.result.entity);
          const completion = artifact.success
            ? JSON.parse(
                new ArtifactFiles(join(context.controller.home, 'artifacts'))
                  .read(artifact.data.hash)
                  .toString('utf8'),
              )
            : null;
          return {
            id: attempt.id,
            state: attempt.state,
            phases: context.controller.store.nativeProcesses(attempt.id),
            completion,
          };
        });
      return JSON.stringify({
        task: task ? { state: task.state, next: task.next } : null,
        attempts,
      });
    },
    observe,
    wait: <T>(stage: string, pending: Promise<T>, milliseconds?: number) =>
      nativeWait(
        `${mode}/${targetPath}/${stage}`,
        Promise.race([pending, failure.promise]),
        milliseconds,
      ),
    ready: ready.promise,
    submissions: () => submissions,
    onSpawn: (listener: typeof onSpawn) => {
      onSpawn = listener;
    },
    onInput: (listener: typeof onInput) => {
      onInput = listener;
    },
    onWritten: (listener: typeof onWritten) => {
      onWritten = listener;
    },
  };
}

export { binding, fixtureClientHash, nativeSetup, nativeWait, setup };
