import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  ChatCatalogRead,
  ChatCrew,
  ChatTurn,
  CommandResult,
  Event,
  PlanRecipe,
  PlanRecipeRun,
  Project,
  Task,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { type ChatScriptStep, createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import { chatFailure } from '../chat/adapter.ts';
import { reportCount } from '../chat/plan-runner.ts';
import { REPORT_LEAD } from '../chat/prompt.ts';
import { chatScratchDirectory } from '../chat/scratch-folder.ts';
import { ChatService } from '../chat/service.ts';
import { RemoteEffects } from '../github/effects.ts';
import { installedTools } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import type { PlanEvent } from './events.ts';
import { nextRun, RunTracker } from './tracker.ts';

/** The PATH this file started with. Each harness narrows it to git and node while it runs. */
const PATH = process.env.PATH;
const on = { family: 'openai', model: 'openai-model', effort: 'default' } as const;
const crewOf = (...roles: ChatCrew['members'][number]['role'][]): ChatCrew => ({
  name: 'Run crew',
  members: roles.map((role) => ({ role, selection: on })),
});
const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];
/** A turn that writes a file in its copy, net.mjs unless named, then answers. */
const write = (content: string, text: string, path = 'net.mjs'): ChatScriptStep[] => [
  {
    kind: 'tool',
    callId: `w-${path}`,
    toolKind: 'edit',
    title: `Write ${path}`,
    write: { path, content },
  },
  ...reply(text),
];
/** A plan of `count` slices, or of one slice per difficulty given. */
const planOf = (count: number | ('medium' | 'hard')[], readOnly = false) =>
  reply(
    `\`\`\`json plan\n${JSON.stringify({
      planId: 'p1',
      goal: 'Split it.',
      slices: (typeof count === 'number' ? Array(count).fill('medium') : count).map(
        (difficulty: string, at: number) => ({
          id: at + 1,
          title: `Part ${at + 1}`,
          brief: `Do part ${at + 1}.`,
          files: [],
          depends: [],
          difficulty,
          readOnly,
        }),
      ),
    })}\n\`\`\``,
  );
const broken = chatFailure({ stage: 'stream', kind: 'client-exit', message: 'It exited.' });
const wait: ChatScriptStep[] = [{ kind: 'wait' }];
/** The line a turn that failed on `broken` writes as it ends. */
const exited = `${broken.message} ${broken.nextAction}`;

type Setup = {
  openai: ChatScriptStep[][];
  /** Turns on Anthropic, which is connected only when these are given. */
  anthropic?: ChatScriptStep[][];
  crew: ChatCrew;
  mode?: 'glide' | 'balanced';
  /** The recipe's shape. A change recipe unless it says report. */
  shape?: 'report';
  /** Automatic handoff on a usage limit. */
  auto?: boolean;
  /** A schedule started the run, with this limit in percent used on OpenAI. */
  schedule?: { maxUsed: number };
  /** Percent of OpenAI's window left, by how many OpenAI turns have started. */
  openaiLeft?: (turns: number) => number;
  policy?: 'ask' | 'allow-all';
  checks?: string[];
  /** False leaves the service with no listener, as before a restart's reconcile. */
  observe?: false;
  /** The run's request. `Split the work.` unless given. */
  request?: string;
};

/**
 * A recipe run on a temp SQLite home, the way the plan tests build a chat service, with one
 * scripted OpenAI adapter and the run's row tracked from the service's events. The thread is set
 * up and its request sent the way RunRecipe does it. PATH holds git and node alone, so no gh or
 * provider client is ever found. `start` builds another service on the same store, as a restart
 * does.
 */
function harness(t: TestContext, setup: Setup) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'ck-runs-'));
  process.env.PATH = PATH;
  process.env.PATH = installedTools(directory, 'git', 'node');
  t.after(() => {
    process.env.PATH = PATH;
    rmSync(directory, { recursive: true, force: true });
  });
  const clock = createTestClock();
  const now = clock.now();
  const ids = createTestIds(now);
  const fixtures = createDemoFixtures(now);
  const repository = createSyntheticRepository(join(directory, 'demo-shop'));
  const root = repository.directory;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
  // A check the run turns on has to be in the commit the run's copy starts from.
  writeFileSync(join(root, 'gate.mjs'), "console.log('ok');\n");
  git('add', 'gate.mjs');
  git('commit', '-q', '-m', 'Add a check.');
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const project: Project = { id: fixtures.task.projectId, name: 'demo-shop', revision: 0 };
  const task: Task = fixtures.task;
  store.transaction(() => {
    store.put('project', project.id, 0, project);
    store.put('task', task.id, 0, task);
  });
  const taskId = task.id;
  const scripts = {
    openai: setup.openai,
    ...(setup.anthropic ? { anthropic: setup.anthropic } : {}),
  };
  const adapters = new Map(
    Object.entries(scripts).map(([family, turns]) => [
      family as 'openai' | 'anthropic',
      createScriptedChatAdapter({ family: family as 'openai' | 'anthropic', turns }),
    ]),
  );
  /** Percent of OpenAI's weekly window left, which a test may change. */
  const left = { openai: 10 };
  /** Whether Anthropic's reading is old, so a schedule cannot judge a turn there. */
  const stale = { anthropic: false };
  /** When OpenAI's window resets, for a start at reset, and whether OpenAI's model is gone. */
  const openai = { resetsAt: null as string | null, gone: false };
  /** The timers the service armed, which a test runs by hand. */
  const timers: (() => void)[] = [];
  const catalog = (): ChatCatalogRead => ({
    families: [...adapters.keys()].map((family) => ({
      family,
      connected: true,
      reason: null,
      models: [
        {
          model: `${family}-model`,
          label: family,
          efforts: ['default'],
          defaultEffort: 'default',
        },
      ],
      defaultModel: `${family}-model`,
      remaining: [
        {
          windowId: 'weekly',
          label: 'weekly',
          percent:
            family === 'openai'
              ? (setup.openaiLeft?.(adapters.get('openai')?.requests.length ?? 0) ?? left.openai)
              : 60,
          resetsAt: family === 'openai' ? openai.resetsAt : null,
          observedAt: family === 'anthropic' && stale.anthropic ? '2000-01-01T00:00:00.000Z' : now,
        },
      ],
      accepts: null,
      // OpenAI spends no credits, so a window at zero pauses what runs there.
      ...(family === 'openai' ? { creditSpending: false } : {}),
    })),
  });
  const events: PlanEvent[] = [];
  /** What the webhook was told, in order. */
  const notices: { kind: string; line: string }[] = [];
  /** What the tracker logged about rows it could not read. */
  const logs: string[] = [];
  /** The run's state after each change of its row, as the hook heard it. */
  const moves: string[] = [];
  let changed = 0;
  const tracker = new RunTracker({
    store,
    now: clock.now,
    home: directory,
    projectPath: () => root,
    families: () => catalog().families,
    changed: () => {
      changed += 1;
    },
    onRun: (next, before) => {
      assert.notEqual(next.state, before.state);
      moves.push(next.state);
    },
    log: (line) => logs.push(line),
  });
  const start = (observe = setup.observe !== false) =>
    new ChatService({
      store,
      artifacts: new ArtifactFiles(join(directory, 'artifacts')),
      home: directory,
      googleTermsAcknowledged: () => true,
      now: clock.now,
      id: (prefix) => (prefix === 'trn' ? `trn_${ids('msg').slice(4)}` : ids(prefix)),
      emit: (type, id, revision, payload) =>
        store.append({ protocol: 1, id: ids('evt'), at: now, taskId: id, revision, type, payload }),
      adapters,
      resolveEnvironment: () => ({}),
      notice: (event) => notices.push({ kind: event.kind, line: event.line }),
      projectPath: () => root,
      resolveSelection: (_taskId, value) =>
        openai.gone && value?.family === 'openai' ? null : (value ?? null),
      catalog,
      schedule: (run: () => void) => {
        timers.push(run);
        return () => {};
      },
      remoteEffects: new RemoteEffects({
        store,
        home: directory,
        now: clock.now,
        id: () => ids('rfx'),
        projectPath: () => root,
      }),
      ...(observe
        ? {
            observe: (event: PlanEvent) => {
              events.push(event);
              tracker.observe(event);
            },
          }
        : {}),
    });
  const chat = start();
  t.after(() => chat.close());
  const act = (work: (effects: (() => void)[]) => CommandResult) => {
    const effects: (() => void)[] = [];
    const result = store.transaction(() => work(effects));
    for (const effect of effects) effect();
    return result;
  };
  const until = (match: (event: Event) => boolean) =>
    new Promise<Event>((resolve) => {
      const stop = store.subscribe((event) => {
        if (!match(event)) return;
        stop();
        resolve(event);
      });
    });
  // A step after an ending runs a few ticks after the commit that wrote the ending.
  const quiet = async () => {
    for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  };

  // The recipe's record, its saved version and the run, written with the thread the way
  // RunRecipe writes them, in one transaction.
  const recipeId = `rcp_${ids('msg').slice(4)}`;
  const versionHash = 'a'.repeat(64);
  const recipe: PlanRecipe = {
    schema: 1,
    name: 'Split work',
    description: '',
    shape: setup.shape ?? 'change',
    crew: setup.crew,
    run: {
      flightMode: setup.mode ?? 'glide',
      permissionPolicy: setup.policy ?? 'allow-all',
      handoff: { auto: setup.auto ?? false, mode: 'most-left' },
      maxSlices: 8,
    },
    checks: (setup.checks ?? []).map((command) => ({ command })),
    trigger: setup.schedule ? { kind: 'interval', everyMinutes: 60 } : { kind: 'manual' },
    budget: setup.schedule
      ? {
          maxRuns: 10,
          maxUsedPercent: { openai: setup.schedule.maxUsed, anthropic: 99, google: 99 },
          maxWaiting: 3,
        }
      : null,
    work: setup.schedule ? { kind: 'request', text: 'Split the work.' } : null,
  };
  const reading = { family: 'openai', used: 90, window: 'weekly', observedAt: now } as const;
  const started = act((effects) => {
    store.putRecipe({
      id: recipeId,
      projectId: project.id,
      path: '.crewkite/recipes/split.json',
      version: 1,
      versionHash,
      updatedAt: now,
    });
    store.putRecipeVersion(recipeId, 1, versionHash, recipe, now);
    const result = chat.startRecipeThread(
      task,
      {
        crew: recipe.crew,
        flightMode: recipe.run.flightMode,
        permissionPolicy: recipe.run.permissionPolicy,
        handoff: recipe.run.handoff,
        checks: setup.checks ?? [],
        line: 'Run of Split work, version 1.',
        request: setup.request ?? 'Split the work.',
      },
      effects,
    );
    store.putRecipeRun({
      id: `rrn_${ids('msg').slice(4)}`,
      recipeId,
      projectId: project.id,
      taskId,
      version: 1,
      versionHash,
      origin: setup.schedule ? 'schedule' : 'manual',
      item: null,
      state: 'running',
      findings: null,
      changedFiles: null,
      reason: null,
      startedAt: now,
      endedAt: null,
      allowance: { start: [reading], end: null },
    });
    return result;
  });
  assert.equal(started.outcome, 'applied', JSON.stringify(started));
  const run = () => store.recipeRunOf(taskId) as PlanRecipeRun;
  /** Set the row as if it had reached `state` before what the test does next. */
  const put = (state: PlanRecipeRun['state']) =>
    store.transaction(() => store.updateRecipeRun({ ...run(), state }));
  const turns = () =>
    store.db
      .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence')
      .all(taskId)
      .map((row) => JSON.parse(row.body as string) as ChatTurn);
  return {
    chat,
    start,
    requests: (family: 'openai' | 'anthropic' = 'openai') => adapters.get(family)?.requests ?? [],
    notices,
    home: directory,
    store,
    tracker,
    taskId,
    clock,
    left,
    stale,
    openai,
    timers,
    now,
    reading,
    events,
    moves,
    changed: () => changed,
    logs,
    act,
    until,
    quiet,
    run,
    put,
    turns,
  };
}

const lineIs = (pattern: RegExp) => (event: Event) =>
  event.type === 'conversation.entry' && pattern.test((event.payload as { text: string }).text);
const turnIn = (state: string, role?: string) => (event: Event) =>
  event.type === 'chat.turn' &&
  event.payload.state === state &&
  (role === undefined || event.payload.role === role);
const ends = lineIs(/^(Crew finished|Plan stopped|Plan paused)/);

/** Answer the thread's open checks question, when there is one. */
function answerChecks(h: ReturnType<typeof harness>, choice: 'allow' | 'deny'): boolean {
  const ask = h.store.chatThread(h.taskId)?.checks?.ask;
  if (!ask) return false;
  h.act((effects) =>
    h.chat.resolvePermission(
      { taskId: h.taskId, turnId: h.turns()[0].id, requestId: ask.requestId, choice },
      effects,
    ),
  );
  return true;
}

/**
 * Run slice 1 of a Balanced plan of two, so the plan pauses with slice 2 left. Every checks
 * question on the way is allowed.
 */
async function pause(h: ReturnType<typeof harness>) {
  await h.until(turnIn('done', 'orchestrator'));
  await h.quiet();
  let paused = false;
  void h.until(lineIs(/^Plan paused/)).then(() => {
    paused = true;
  });
  h.act((effects) => h.chat.runPlan({ taskId: h.taskId, planId: 'p1', sliceId: 1 }, effects));
  for (let n = 0; n < 400 && !paused; n++) {
    await h.quiet();
    answerChecks(h, 'allow');
  }
  assert.ok(paused, 'the plan paused');
}

// Claim: a run whose plan finishes with changes reads ready, with the files its copy changed and
// the findings of each slice's first review, and it ends with the readings of that moment. Accept
// settles it as accepted, and every move tells clients and the hook.
test('a run follows its thread from running to ready, and Accept settles it', {
  timeout: 60000,
}, async (t) => {
  const h = harness(t, {
    crew: crewOf('orchestrator', 'builder', 'reviewer'),
    openai: [
      planOf(1),
      [
        ...write('# Notes\n', 'Noted.', 'NOTES.txt').slice(0, 1),
        ...write('export const net = 1;\n', 'Built.'),
      ],
      reply('Rounding drops a cent.\nFindings: 2'),
      write('export const net = 2;\n', 'Fixed.'),
      reply('One left.\nFindings: 1'),
      write('export const net = 3;\n', 'Fixed again.'),
      reply('Looks right.\nFindings: 0'),
    ],
  });
  const finished = h.until(lineIs(/^Crew finished/));
  assert.equal(h.run().state, 'running');
  await finished;
  await h.quiet();
  // The first review found two, the later ones one and none.
  const { state, changedFiles, findings, reason, endedAt, allowance } = h.run();
  assert.deepEqual(
    { state, changedFiles, findings, reason, endedAt, allowance },
    {
      state: 'ready',
      changedFiles: 2,
      findings: 2,
      reason: null,
      endedAt: h.now,
      allowance: { start: [h.reading], end: [h.reading] },
    },
  );
  // Discarding one of the two files leaves a change to decide on.
  const discarded = h.act(() => h.chat.discardChange({ taskId: h.taskId, path: 'NOTES.txt' }));
  assert.equal(discarded.outcome, 'applied', JSON.stringify(discarded));
  assert.equal(h.run().state, 'ready');
  // Accept comes later, with other readings. The run keeps the end it had when it became ready.
  h.clock.advance(60_000);
  h.left.openai = 5;
  const accepted = h.act((effects) =>
    h.chat.accept(
      { taskId: h.taskId, branch: 'feat/split-work' },
      { name: 'Fixture', email: 'fixture@example.invalid' },
      effects,
    ),
  );
  assert.equal(accepted.outcome, 'applied', JSON.stringify(accepted));
  assert.deepEqual(
    [h.run().state, h.run().endedAt, h.run().allowance.end],
    ['accepted', h.now, [h.reading]],
  );
  assert.deepEqual(h.moves, ['ready', 'accepted']);
  assert.equal(h.changed(), 2);
});

// Claim: a plan waiting for Run plan and a permission request the person must answer each move
// the run to asked, and the answer moves it back to running, so a schedule counts it as waiting
// only while it waits.
test('a run that asks waits, and counts again as running once answered', {
  timeout: 60000,
}, async (t) => {
  const balanced = harness(t, {
    crew: crewOf('orchestrator', 'builder'),
    mode: 'balanced',
    openai: [planOf(1), write('export const net = 1;\n', 'Built.')],
  });
  await balanced.until(turnIn('done', 'orchestrator'));
  await balanced.quiet();
  assert.equal(balanced.run().state, 'asked');
  const finished = balanced.until(lineIs(/^Crew finished/));
  balanced.act((effects) =>
    balanced.chat.runPlan({ taskId: balanced.taskId, planId: 'p1' }, effects),
  );
  assert.equal(balanced.run().state, 'running');
  await finished;
  assert.deepEqual(balanced.moves, ['asked', 'running', 'ready']);

  const asking = harness(t, {
    crew: crewOf('orchestrator', 'builder'),
    policy: 'ask',
    openai: [
      planOf(1),
      [
        { kind: 'permission', requestId: 'edit', question: 'Edit net.mjs?' },
        ...write('export const net = 1;\n', 'Built.'),
      ],
    ],
  });
  const asked = await asking.until(
    (event) => event.type === 'agent.event' && event.payload.type === 'permission.requested',
  );
  await asking.quiet();
  assert.equal(asking.run().state, 'asked');
  const done = asking.until(lineIs(/^Crew finished/));
  const resolved = asking.until(
    (event) => event.type === 'agent.event' && event.payload.type === 'permission.resolved',
  );
  const answer = asking.act((effects) =>
    asking.chat.resolvePermission(
      {
        taskId: asking.taskId,
        turnId: (asked.payload as { turnId: string }).turnId,
        requestId: 'edit',
        choice: 'allow-once',
      },
      effects,
    ),
  );
  assert.equal(answer.outcome, 'applied');
  await resolved;
  // The answer alone moves it, while the builder that asked is still at work.
  assert.deepEqual([asking.run().state, asking.turns().at(-1)?.state], ['running', 'running']);
  await done;
  assert.deepEqual(asking.moves, ['asked', 'running', 'ready']);

  // Two families: slice 2 runs on the fixer's family and waits on a permission while slice 1
  // builds and merges. The run waits as long as that question is open.
  const fixer = { family: 'anthropic', model: 'anthropic-model', effort: 'default' } as const;
  const parallel = harness(t, {
    crew: {
      name: 'Two families',
      members: [
        { role: 'orchestrator', selection: on },
        { role: 'builder', selection: on },
        { role: 'fixer', selection: fixer },
      ],
    },
    policy: 'ask',
    openai: [
      planOf(['medium', 'hard']),
      // Many small chunks, so slice 2 asks before slice 1 merges.
      [
        ...write('export const net = 1;\n', 'Built.').slice(0, 1),
        { kind: 'text', itemId: 'r', chunks: Array(30).fill('Built. ') },
      ],
    ],
    anthropic: [
      [
        { kind: 'permission', requestId: 'notes', question: 'Write NOTES.txt?' },
        ...write('# Notes\n', 'Noted.', 'NOTES.txt'),
      ],
    ],
  });
  const second = parallel.until(
    (event) => event.type === 'agent.event' && event.payload.type === 'permission.requested',
  );
  await parallel.until(lineIs(/^Slice 1 finished/));
  const waiting = await second;
  await parallel.quiet();
  assert.equal(parallel.run().state, 'asked');
  const all = parallel.until(lineIs(/^Crew finished/));
  parallel.act((effects) =>
    parallel.chat.resolvePermission(
      {
        taskId: parallel.taskId,
        turnId: (waiting.payload as { turnId: string }).turnId,
        requestId: 'notes',
        choice: 'allow-once',
      },
      effects,
    ),
  );
  await all;
  assert.deepEqual(parallel.moves, ['asked', 'running', 'ready']);

  // The same two slices, and OpenAI runs out while slice 2 waits: slice 1's review cannot start,
  // the plan pauses and stops slice 2, and the question goes with that turn. The paused run still
  // waits on the person, and a restart reads it the same.
  const paused = harness(t, {
    crew: {
      name: 'Two families',
      members: [
        { role: 'orchestrator', selection: on },
        { role: 'builder', selection: on },
        { role: 'reviewer', selection: on },
        { role: 'fixer', selection: fixer },
      ],
    },
    policy: 'ask',
    openai: [
      planOf(['medium', 'hard']),
      [
        ...write('export const net = 1;\n', 'Built.').slice(0, 1),
        { kind: 'text', itemId: 'r', chunks: Array(30).fill('Built. ') },
      ],
      reply('Fine.\nFindings: 0'),
    ],
    anthropic: [
      [
        { kind: 'permission', requestId: 'notes', question: 'Write NOTES.txt?' },
        ...write('# Notes\n', 'Noted.', 'NOTES.txt'),
      ],
    ],
  });
  await paused.until((event) => {
    if (event.type !== 'agent.event' || event.payload.type !== 'permission.requested') return false;
    paused.left.openai = 0;
    return true;
  });
  const stopped = paused.until(turnIn('stopped'));
  await paused.until(lineIs(/^Plan paused/));
  await stopped;
  for (let n = 0; n < 5; n++) await paused.quiet();
  assert.deepEqual(
    [paused.run().state, paused.store.chatThread(paused.taskId)?.plan?.phase],
    ['asked', 'stopped'],
  );
  assert.ok(paused.events.some((event) => event.kind === 'answered'));
  const restarted = paused.start(false);
  t.after(() => restarted.close());
  restarted.recover();
  paused.tracker.reconcile();
  assert.equal(paused.run().state, 'asked');
});

// Claim: each way a plan ends gives the run its state: no change, failed or stopped with the
// thread's line as the reason, and a pause leaves it asked, waiting for the person to run the
// rest, accept or discard, whatever question comes and goes meanwhile. A turn that ends with its
// question open closes the question. A report ends as reported with the findings its closing
// message kept.
test('a run that changes nothing reads no-change, and a failed or stopped plan reads failed or stopped', {
  timeout: 120000,
}, async (t) => {
  type Row = {
    name: string;
    openai: ChatScriptStep[][];
    mode?: 'balanced';
    policy?: 'ask';
    checks?: string[];
    act: (h: ReturnType<typeof harness>) => Promise<void>;
    expect: [string, number | null, string | null, boolean];
    /** The kinds of the last events, in order. */
    last?: string[];
  };
  const toEnd = async (h: ReturnType<typeof harness>) => {
    await h.until(ends);
  };
  const stopSlice = async (h: ReturnType<typeof harness>) => {
    const turnId = ((await h.until(turnIn('running', 'assistant'))).payload as { id: string }).id;
    const ended = h.until(ends);
    h.act((effects) => h.chat.stopTurn({ taskId: h.taskId, turnId }, effects));
    await ended;
  };
  const rows: Row[] = [
    {
      name: 'a plan that changes nothing',
      openai: [planOf(1), reply('Nothing needs to change.')],
      act: toEnd,
      expect: ['no-change', 0, null, true],
    },
    {
      name: 'a slice that fails',
      openai: [planOf(1), [{ kind: 'fail', stopReason: 'error', failure: broken }]],
      act: toEnd,
      expect: [
        'failed',
        null,
        'Plan stopped: slice 1 failed. Run it again from the plan card.',
        true,
      ],
    },
    {
      name: 'a slice the person stops',
      openai: [planOf(1), wait],
      act: stopSlice,
      expect: ['stopped', null, 'Plan stopped: you stopped the reply.', true],
    },
    {
      name: 'a slice the person stops while it waits on a permission',
      openai: [
        planOf(1),
        [
          { kind: 'permission', requestId: 'edit', question: 'Edit net.mjs?' },
          ...write('export const net = 1;\n', 'Built.'),
        ],
      ],
      policy: 'ask',
      act: async (h) => {
        const asked = await h.until(
          (event) => event.type === 'agent.event' && event.payload.type === 'permission.requested',
        );
        await h.quiet();
        assert.equal(h.run().state, 'asked');
        const ended = h.until(ends);
        const turnId = (asked.payload as { turnId: string }).turnId;
        h.act((effects) => h.chat.stopTurn({ taskId: h.taskId, turnId }, effects));
        await ended;
      },
      expect: ['stopped', null, 'Plan stopped: you stopped the reply.', true],
      last: ['step-ended', 'answered', 'plan-ended'],
    },
    {
      name: 'a plan the person cancels',
      openai: [planOf(1), wait],
      act: async (h) => {
        await h.until(turnIn('running', 'assistant'));
        const ended = h.until(ends);
        h.act((effects) => h.chat.cancelPlan({ taskId: h.taskId, planId: 'p1' }, effects));
        await ended;
      },
      expect: ['stopped', null, 'Plan stopped: you cancelled it.', true],
    },
    {
      name: 'a plan that pauses with a slice left to run',
      openai: [planOf(2), write('export const net = 1;\n', 'Built.')],
      mode: 'balanced',
      act: pause,
      expect: ['asked', null, null, false],
    },
    {
      name: 'a paused plan the person accepts',
      openai: [planOf(2), write('export const net = 1;\n', 'Built.')],
      mode: 'balanced',
      act: async (h) => {
        await pause(h);
        const accepted = h.act((effects) =>
          h.chat.accept(
            { taskId: h.taskId, branch: 'feat/part-one' },
            { name: 'Fixture', email: 'fixture@example.invalid' },
            effects,
          ),
        );
        assert.equal(accepted.outcome, 'applied', JSON.stringify(accepted));
      },
      expect: ['accepted', null, null, true],
    },
    {
      name: 'a paused plan whose only change the person discards',
      openai: [planOf(2), write('export const net = 1;\n', 'Built.')],
      mode: 'balanced',
      act: async (h) => {
        await pause(h);
        const discarded = h.act(() => h.chat.discardChange({ taskId: h.taskId, path: 'net.mjs' }));
        assert.equal(discarded.outcome, 'applied', JSON.stringify(discarded));
      },
      expect: ['discarded', null, null, true],
    },
    {
      name: 'a paused plan whose checks the person denies at Accept',
      openai: [planOf(2), write('export const net = 1;\n', 'Built.')],
      mode: 'balanced',
      checks: ['node gate.mjs'],
      act: async (h) => {
        await pause(h);
        assert.equal(h.run().state, 'asked');
        h.act((effects) =>
          h.chat.accept(
            { taskId: h.taskId, branch: 'feat/part-one' },
            { name: 'Fixture', email: 'fixture@example.invalid' },
            effects,
          ),
        );
        assert.ok(answerChecks(h, 'deny'), 'Accept asked about its checks');
      },
      expect: ['asked', null, null, false],
    },
    {
      name: 'an orchestrator turn that fails with a message queued behind it',
      openai: [[{ kind: 'fail', stopReason: 'error', failure: broken }]],
      act: async (h) => {
        const failed = h.until(turnIn('failed', 'orchestrator'));
        // The failure holds the queue, so nothing goes on and the run ends with the turn.
        const queued = h.act((effects) =>
          h.chat.sendMessage(
            { taskId: h.taskId, text: 'And this.', role: 'assistant', attachments: [], files: [] },
            effects,
          ),
        );
        assert.equal(queued.outcome, 'applied', JSON.stringify(queued));
        await failed;
      },
      expect: ['failed', null, exited, true],
    },
  ];
  for (const row of rows) {
    const h = harness(t, {
      crew: crewOf('orchestrator', 'builder'),
      mode: row.mode,
      policy: row.policy,
      checks: row.checks,
      openai: row.openai,
    });
    await row.act(h);
    for (let n = 0; n < 4; n++) await h.quiet();
    const run = h.run();
    assert.deepEqual(
      [run.state, run.changedFiles, run.reason, run.endedAt !== null],
      row.expect,
      row.name,
    );
    if (row.last)
      assert.deepEqual(
        h.events.slice(-row.last.length).map((event) => event.kind),
        row.last,
        row.name,
      );
  }

  // The rule is read off the function alone, with the facts a finished report plan brings.
  const at = '2026-10-15T18:00:00.000Z';
  const reading = { family: 'openai', used: 40, window: 'weekly', observedAt: at } as const;
  const report: PlanRecipeRun = {
    id: 'rrn_01JA0000000000000000000000',
    recipeId: 'rcp_01JA0000000000000000000000',
    projectId: 'prj_01JA0000000000000000000000',
    taskId: 'tsk_01JA0000000000000000000000',
    version: 1,
    versionHash: 'a'.repeat(64),
    origin: 'manual',
    item: null,
    state: 'running',
    findings: null,
    changedFiles: null,
    reason: null,
    startedAt: at,
    endedAt: null,
    allowance: { start: [reading], end: null },
  };
  const ended = nextRun(
    report,
    {
      kind: 'plan-ended',
      taskId: report.taskId,
      at,
      outcome: 'finished',
      line: '',
      findings: 3,
    },
    { shape: 'report', changedFiles: 0, readings: [reading], phase: 'finished' },
  );
  assert.deepEqual(ended, {
    ...report,
    state: 'reported',
    findings: 3,
    endedAt: at,
    allowance: { start: [reading], end: [reading] },
  });
  // A discard that empties the copy while the plan is still at work settles nothing: the next
  // step writes again. The same discard on a run that waits settles it.
  const emptied = { kind: 'changes-discarded' as const, taskId: report.taskId, at };
  const none = { shape: 'change' as const, changedFiles: 0, readings: [reading], phase: null };
  assert.equal(nextRun(report, emptied, { ...none, phase: 'running' }), report);
  assert.equal(
    nextRun({ ...report, state: 'asked' }, emptied, { ...none, phase: 'stopped' }).state,
    'discarded',
  );
});

// Claim: deleting a run's thread settles the run the way the contract says. A run that was
// going or waiting stops, one ready for Accept is discarded, and a final state stays.
test("deleting a run's thread settles the run", { timeout: 60000 }, async (t) => {
  const rows: [PlanRecipeRun['state'], PlanRecipeRun['state'], boolean][] = [
    ['running', 'stopped', true],
    ['asked', 'stopped', true],
    ['ready', 'discarded', true],
    ['failed', 'failed', false],
  ];
  for (const [before, after, moved] of rows) {
    // A plan that waits for Run plan leaves the thread idle, so it can be deleted.
    const h = harness(t, {
      crew: crewOf('orchestrator', 'builder'),
      mode: 'balanced',
      openai: [planOf(1)],
    });
    await h.until(turnIn('done', 'orchestrator'));
    await h.quiet();
    h.put(before);
    const deleted = h.act((effects) => h.chat.deleteThread({ taskId: h.taskId }, effects));
    assert.equal(deleted.outcome, 'applied', before);
    const run = h.run();
    assert.deepEqual(
      [run.state, run.endedAt !== null, run.allowance.end !== null],
      [after, moved, moved],
      before,
    );
  }
});

// Claim: a run left running or asked when the controller stopped is read again from its thread
// once recovery has run: a slice recovery stopped fails with the thread's line, a plan waiting for
// Run plan is asked, a plan that finished with changes is ready, and a deleted thread stops it.
test('a restart recomputes a run that was running or asked', { timeout: 60000 }, async (t) => {
  const rows: {
    name: string;
    openai: ChatScriptStep[][];
    mode?: 'balanced';
    before: (h: ReturnType<typeof harness>) => Promise<void>;
    /** The row's state before the restart. Running unless named. */
    from?: PlanRecipeRun['state'];
    expect: [string, number | null, string | null];
    /** More to check once the pass ran. */
    after?: (h: ReturnType<typeof harness>) => void;
  }[] = [
    {
      name: 'a slice that ran at the restart',
      openai: [planOf(1), wait],
      before: async (h) => {
        await h.until(turnIn('running', 'assistant'));
      },
      expect: ['failed', null, 'Plan stopped: restarted.'],
    },
    {
      name: 'a plan that waits for Run plan',
      openai: [planOf(1)],
      mode: 'balanced',
      before: async (h) => {
        await h.until(turnIn('done', 'orchestrator'));
      },
      expect: ['asked', null, null],
    },
    {
      name: 'a plan that finished with changes',
      openai: [planOf(1), write('export const net = 1;\n', 'Built.')],
      before: async (h) => {
        await h.until(lineIs(/^Crew finished/));
      },
      expect: ['ready', 1, null],
    },
    {
      name: 'a thread that is gone',
      openai: [planOf(1)],
      mode: 'balanced',
      before: async (h) => {
        await h.until(turnIn('done', 'orchestrator'));
        await h.quiet();
        h.act((effects) => h.chat.deleteThread({ taskId: h.taskId }, effects));
      },
      expect: ['stopped', null, null],
    },
    {
      name: 'a ready run whose thread is gone',
      openai: [planOf(1)],
      mode: 'balanced',
      before: async (h) => {
        await h.until(turnIn('done', 'orchestrator'));
        await h.quiet();
        h.put('ready');
        h.act((effects) => h.chat.deleteThread({ taskId: h.taskId }, effects));
      },
      from: 'ready',
      expect: ['discarded', null, null],
    },
    {
      name: 'an orchestrator turn that failed before any plan',
      openai: [[{ kind: 'fail', stopReason: 'error', failure: broken }]],
      before: async (h) => {
        await h.until(turnIn('failed', 'orchestrator'));
      },
      expect: ['failed', null, exited],
    },
    {
      name: 'a paused plan whose run was left running',
      openai: [planOf(2), write('export const net = 1;\n', 'Built.')],
      mode: 'balanced',
      before: pause,
      expect: ['asked', null, null],
    },
    {
      name: 'a paused plan whose run waits',
      openai: [planOf(2), write('export const net = 1;\n', 'Built.')],
      mode: 'balanced',
      before: async (h) => {
        await pause(h);
        h.put('asked');
      },
      from: 'asked',
      expect: ['asked', null, null],
    },
    {
      name: 'a stopped plan that changed nothing',
      openai: [planOf(2), reply('Nothing to change.')],
      mode: 'balanced',
      before: pause,
      expect: ['stopped', null, 'Plan paused: 1 slice has not run. Run it from the plan card.'],
    },
    {
      name: 'a row that cannot be read, beside one that can',
      openai: [planOf(1), write('export const net = 1;\n', 'Built.')],
      before: async (h) => {
        await h.until(lineIs(/^Crew finished/));
        const { projectId, recipeId } = h.run();
        // Older than the good row, so the pass meets it first.
        h.store.db
          .prepare(
            `INSERT INTO recipe_runs(id,project_id,recipe_id,task_id,origin,state,body,started_at,ended_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            'rrn_01JA0000000000000000000000',
            projectId,
            recipeId,
            'tsk_01JA0000000000000000000000',
            'manual',
            'running',
            '{}',
            '2026-01-01T00:00:00.000Z',
            null,
          );
      },
      expect: ['ready', 1, null],
      after: (h) => {
        assert.equal(h.logs.length, 1);
        assert.match(h.logs[0] ?? '', /^rrn_01JA0000000000000000000000: /);
      },
    },
  ];
  for (const row of rows) {
    // Nothing listens before the restart, so only the thread's records say what happened.
    const h = harness(t, {
      crew: crewOf('orchestrator', 'builder'),
      mode: row.mode,
      openai: row.openai,
      observe: false,
    });
    await row.before(h);
    await h.quiet();
    assert.equal(h.run().state, row.from ?? 'running', row.name);
    const restarted = h.start(false);
    t.after(() => restarted.close());
    restarted.recover();
    h.tracker.reconcile();
    const run = h.run();
    assert.deepEqual([run.state, run.changedFiles, run.reason], row.expect, row.name);
    row.after?.(h);
  }
});

// Claim: one plan with a review, a fix round, gates and a challenge sends exactly these events, in
// this order, so a listener can rebuild each step's role, model, first review and gate result.
test("the events carry each step's role, model, first review findings and gate result", {
  timeout: 60000,
}, async (t) => {
  const h = harness(t, {
    crew: crewOf('orchestrator', 'builder', 'reviewer', 'challenger'),
    checks: ['node gate.mjs'],
    openai: [
      planOf(1),
      write('export const net = 1;\n', 'Built.'),
      reply('Rounding drops a cent.\nFindings: 1'),
      write('export const net = 2;\n', 'Fixed.'),
      reply('Looks right.\nFindings: 0'),
      reply('The rounding holds.'),
    ],
  });
  await h.until(lineIs(/^Crew finished/));
  await h.quiet();
  const turns = h.turns();
  assert.deepEqual(
    turns.map((turn) => turn.role),
    ['orchestrator', 'assistant', 'reviewer', 'fixer', 'reviewer', 'challenger'],
  );
  const [plan, build, review, fix, second, challenge] = turns.map((turn) => turn.id);
  const rules = turns[1].rules?.digest;
  assert.ok(rules);
  assert.equal(turns[3].rules?.digest, rules);
  for (const event of h.events) assert.deepEqual([event.taskId, event.at], [h.taskId, h.now]);
  const lane = { slice: 1, anchorTurnId: build, family: 'openai', model: 'openai-model' };
  const turn = (step: string, turnId: string, role: string) => ({
    ...lane,
    step,
    turnId,
    role,
    effort: 'default',
  });
  const end = (rulesDigest: string | null, findings: number | null = null) => ({
    kind: 'step-ended',
    rulesDigest,
    designVersionHash: null,
    outcome: 'done',
    durationMs: 0,
    findings,
  });
  const merge = {
    slice: 1,
    step: 'merge',
    turnId: null,
    anchorTurnId: build,
    role: null,
    family: null,
    model: null,
    effort: null,
  };
  const gate = (trigger: string) => ({
    kind: 'gate',
    slice: 1,
    anchorTurnId: build,
    trigger,
    result: 'passed',
  });
  const challenger = {
    ...turn('challenge', challenge, 'challenger'),
    slice: null,
    anchorTurnId: plan,
  };
  assert.deepEqual(
    h.events.map(({ taskId: _taskId, at: _at, ...event }) => event),
    [
      { kind: 'plan-proposed', orchestratorTurnId: plan, slices: 1, waits: false },
      { kind: 'plan-started' },
      { kind: 'step-started', ...turn('build', build, 'builder') },
      { ...end(rules), ...turn('build', build, 'builder') },
      gate('after-write'),
      { kind: 'step-started', ...turn('review', review, 'reviewer') },
      { ...end(null, 1), ...turn('review', review, 'reviewer') },
      { kind: 'step-started', ...turn('fix', fix, 'fixer') },
      { ...end(rules), ...turn('fix', fix, 'fixer') },
      gate('after-write'),
      { kind: 'step-started', ...turn('review', second, 'reviewer') },
      { ...end(null, 0), ...turn('review', second, 'reviewer') },
      { kind: 'step-started', ...merge },
      { ...end(null), ...merge, durationMs: null },
      gate('combined'),
      { kind: 'step-started', ...challenger },
      { ...end(null), ...challenger },
      {
        kind: 'plan-ended',
        outcome: 'finished',
        line: 'Crew finished: 1 slice, 2 reviews, 1 fix.',
        findings: 1,
      },
    ],
  );
  // The run's only change discarded leaves nothing to decide, and the end stays where it was.
  assert.equal(h.run().state, 'ready');
  h.clock.advance(60_000);
  const discarded = h.act(() => h.chat.discardChange({ taskId: h.taskId, path: 'net.mjs' }));
  assert.equal(discarded.outcome, 'applied', JSON.stringify(discarded));
  assert.deepEqual([h.run().state, h.run().endedAt], ['discarded', h.now]);
  assert.equal(h.events.at(-1)?.kind, 'changes-discarded');
});

/** The thread's entries in order, each as its kind, its author's role and its text. */
const entries = (h: ReturnType<typeof harness>) =>
  h.store.db
    .prepare('SELECT body FROM conversation_entries WHERE task_id=? ORDER BY sequence')
    .all(h.taskId)
    .map((row) => {
      const entry = JSON.parse(row.body as string) as {
        kind: string;
        text: string;
        author?: { role?: string };
      };
      return { kind: entry.kind, role: entry.author?.role, text: entry.text };
    });
const reportCrew = crewOf('orchestrator', 'builder', 'challenger');
/** Any line that ends a plan, so a run that goes wrong fails on its assertions and not on a wait. */
const reportEnds = lineIs(
  /^(Plan stopped|Plan paused|Report finished|Report stopped|Crew finished|Crew stopped)/,
);
const limited: ChatScriptStep[] = [
  {
    kind: 'fail',
    stopReason: 'limit',
    failure: chatFailure({ stage: 'stream', kind: 'usage-limit', message: 'Limit.' }),
  },
];
/** How many plan-ended events a run sent. A plan ends once. */
const endings = (h: ReturnType<typeof harness>) =>
  h.events.filter((event) => event.kind === 'plan-ended').length;
/** Each plan-ended event, as its outcome and line. */
const ended = (h: ReturnType<typeof harness>) =>
  h.events.flatMap((event) =>
    event.kind === 'plan-ended' ? [`${event.outcome}: ${event.line}`] : [],
  );
/** A reply that streams in many chunks, so a test can act while its turn runs. */
const slow = (text: string): ChatScriptStep[] => [
  { kind: 'text', itemId: 'r', chunks: [...Array(30).fill(''), text] },
];
/** Wait, a tick at a time, until `ready` holds. */
const ticks = async (ready: () => boolean) => {
  for (let n = 0; n < 4000 && !ready(); n++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ready(), 'the run reached the point the test acts at');
};

// Claim: a report run reads every slice, has the challenger argue against what they found and
// ends with the orchestrator's one message. Both closing turns run on the read-only profile, so
// a write one of them attempts is refused, and nothing in the copy changes.
test('a report run reads in parallel, has the challenger argue against the findings and ends with one message', {
  timeout: 60000,
}, async (t) => {
  const h = harness(t, {
    shape: 'report',
    crew: reportCrew,
    openai: [
      planOf(2, true),
      reply('net.mjs:12 rounds half up.\ntotals.mjs:4 skips the tax.'),
      reply('cart.mjs:30 reads the old rate.'),
      [
        // The thread allows every edit, so only the read-only profile can refuse this one.
        { kind: 'permission', requestId: 'ask-1', question: 'Write a note?' },
        {
          kind: 'tool',
          callId: 'leak-1',
          toolKind: 'edit',
          title: 'Write leak.txt',
          write: { path: 'leak.txt', content: 'changed\n' },
        },
        ...reply('Two stand. cart.mjs:30 does not: the rate is read once at start.'),
      ],
      [
        { kind: 'permission', requestId: 'ask-2', question: 'Write a note?' },
        {
          kind: 'tool',
          callId: 'leak-2',
          toolKind: 'edit',
          title: 'Write leak.txt',
          write: { path: 'leak.txt', content: 'changed\n' },
        },
        ...reply('net.mjs:12 rounds half up.\ntotals.mjs:4 skips the tax.\nFindings: 2'),
      ],
      // After the run: a direct challenge, then a request for a change, planned twice with a
      // slice that writes.
      reply('A plain answer to the challenge.'),
      planOf(1, false),
      planOf(1, false),
    ],
  });
  await h.until(reportEnds);
  await h.quiet();

  const turns = h.turns();
  assert.deepEqual(
    turns.map((turn) => turn.role),
    ['orchestrator', 'ask', 'ask', 'challenger', 'orchestrator'],
  );
  const [plan, first, second, challenge, report] = turns.map((turn) => turn.id);
  const requests = h.requests();
  // The challenger answers one message that holds each slice's findings, in plan order.
  assert.match(
    requests[3].prompt,
    /^Slice 1: Part 1\nnet\.mjs:12 rounds half up\.\ntotals\.mjs:4 skips the tax\.$/m,
  );
  assert.match(requests[3].prompt, /^Slice 2: Part 2\ncart\.mjs:30 reads the old rate\.$/m);
  assert.match(requests[4].prompt, /^Two stand\. cart\.mjs:30 does not/m);
  assert.match(requests[4].prompt, /^Slice 2: Part 2\ncart\.mjs:30 reads the old rate\.$/m);
  // Both closing turns ask for the read-only profile and never inherit the thread's allow-all.
  for (const request of [requests[3], requests[4]]) {
    assert.equal(request.readOnly, true);
    assert.equal(request.permissionPolicy, 'ask');
    assert.equal(existsSync(join(request.scratch.directory, 'leak.txt')), false);
  }
  assert.equal(requests[1].readOnly, true);
  // Each closing turn has its own brief, and the plan's brief never lets the orchestrator answer
  // a request itself.
  assert.match(requests[0].systemContext, /always reply with a plan, whatever the request asks/);
  assert.doesNotMatch(requests[0].systemContext, /Answer a question, or a request/);
  // The brief reads as one piece: nothing points back at the sentence a report run leaves out.
  assert.doesNotMatch(requests[0].systemContext, /For that work/);
  assert.match(requests[3].systemContext, /Argue against every finding/);
  assert.match(requests[4].systemContext, /orchestrator writing the report/);
  assert.match(requests[4].systemContext, /Findings: followed by how many you listed/);
  assert.match(requests[1].prompt, /End with your findings, one per line/);
  // One message ends the thread's model output, then the one line.
  const thread = entries(h);
  assert.deepEqual(
    thread
      .filter((entry) => entry.role === 'orchestrator')
      .map((entry) => entry.text.split('\n').at(-1)),
    [`\`\`\``, 'Findings: 2'],
  );
  assert.deepEqual(
    thread
      .slice(-2)
      .map((entry) => [entry.kind, entry.role ?? null, entry.text.split('\n').at(-1)]),
    [
      ['chat-assistant', 'orchestrator', 'Findings: 2'],
      ['chat-system', null, 'Report finished: 2 findings stand.'],
    ],
  );
  assert.equal(thread.filter((entry) => /^(Report|Crew) finished/.test(entry.text)).length, 1);
  assert.equal(h.store.chatThread(h.taskId)?.plan?.phase, 'finished');
  // The plan's record names the message the report turn answers.
  assert.deepEqual(h.store.chatThread(h.taskId)?.plan?.report, {
    messageId: turns[4].userMessageId,
  });
  assert.deepEqual(
    [h.run().state, h.run().findings, h.run().changedFiles, h.run().endedAt],
    ['reported', 2, null, h.now],
  );
  assert.deepEqual(h.notices, [{ kind: 'finished', line: 'Report finished: 2 findings stand.' }]);

  const lane = (turnId: string, anchor: string) => ({
    slice: 1,
    anchorTurnId: anchor,
    turnId,
    family: 'openai',
    model: 'openai-model',
    effort: 'default',
  });
  const closing = (step: string, turnId: string, role: string) => ({
    slice: null,
    step,
    anchorTurnId: plan,
    turnId,
    role,
    family: 'openai',
    model: 'openai-model',
    effort: 'default',
  });
  const done = {
    kind: 'step-ended',
    rulesDigest: null,
    designVersionHash: null,
    outcome: 'done',
    durationMs: 0,
    findings: null,
  };
  const read = (n: number, turnId: string) => ({
    ...lane(turnId, turnId),
    slice: n,
    step: 'build',
    role: 'builder',
  });
  const merge = (n: number, anchor: string) => ({
    slice: n,
    step: 'merge',
    turnId: null,
    anchorTurnId: anchor,
    role: null,
    family: null,
    model: null,
    effort: null,
  });
  assert.deepEqual(
    h.events.map(({ taskId: _taskId, at: _at, ...event }) => event),
    [
      { kind: 'plan-proposed', orchestratorTurnId: plan, slices: 2, waits: false },
      { kind: 'plan-started' },
      { kind: 'step-started', ...read(1, first) },
      { ...done, ...read(1, first) },
      { kind: 'step-started', ...merge(1, first) },
      { ...done, ...merge(1, first), durationMs: null },
      { kind: 'step-started', ...read(2, second) },
      { ...done, ...read(2, second) },
      { kind: 'step-started', ...merge(2, second) },
      { ...done, ...merge(2, second), durationMs: null },
      { kind: 'step-started', ...closing('challenge', challenge, 'challenger') },
      // The refused write leaves the turn's ask to the person, which the end of the turn clears.
      { kind: 'answered' },
      { ...done, ...closing('challenge', challenge, 'challenger') },
      { kind: 'step-started', ...closing('report', report, 'orchestrator') },
      { kind: 'answered' },
      { ...done, ...closing('report', report, 'orchestrator') },
      {
        kind: 'plan-ended',
        outcome: 'finished',
        line: 'Report finished: 2 findings stand.',
        findings: 2,
      },
    ],
  );

  // The thread reports for its whole life. A direct challenge gets the plain challenge brief and
  // only reads. A change the person asks for plans with the report's brief, and its plan with a
  // slice that writes is refused with the sentence that points to a new thread. A turn sent
  // straight to the fixer does not start.
  const challenged = h.until(turnIn('done', 'challenger'));
  h.act((effects) =>
    h.chat.sendMessage(
      { taskId: h.taskId, text: 'Challenge that.', role: 'challenger', attachments: [], files: [] },
      effects,
    ),
  );
  await challenged;
  assert.match(h.requests()[5].systemContext, /You are challenging the last answer/);
  const afterwards = 'This thread reports and only reads. Start a new thread to change files.';
  const later = h.until(lineIs(/^Plan stopped/));
  h.act((effects) =>
    h.chat.sendMessage(
      { taskId: h.taskId, text: 'Fix net.mjs:12.', role: 'assistant', attachments: [], files: [] },
      effects,
    ),
  );
  await later;
  await h.quiet();
  const refused = `Plan stopped: the plan did not pass validation. ${afterwards}`;
  assert.match(h.requests()[6].systemContext, /This is a report run, so always reply/);
  assert.ok(h.requests()[7].prompt.includes(`The plan did not pass validation. ${afterwards}`));
  assert.equal(entries(h).at(-1)?.text, refused);
  const fixer = h.act((effects) =>
    h.chat.sendMessage(
      { taskId: h.taskId, text: 'Fix it.', role: 'fixer', attachments: [], files: [] },
      effects,
    ),
  );
  assert.equal(fixer.outcome, 'blocked');
  assert.equal(entries(h).at(-1)?.text, afterwards);
  assert.equal(h.requests().length, 8);
  assert.equal(h.turns().at(-1)?.role, 'orchestrator');
  assert.deepEqual(ended(h), [
    'finished: Report finished: 2 findings stand.',
    `failed: ${refused}`,
  ]);
  assert.deepEqual([h.run().state, h.run().findings], ['reported', 2]);

  // The count is the last line that is not empty, and nothing else. Bold marks must match, and a
  // period may end it. A zero after a line that is a finding, one whose first word is a file and
  // line, is no count. A sentence that names a file and line, an address with a port and a time
  // are no findings.
  const counts: [string, number | null][] = [
    ['net.mjs:12 rounds half up.', null],
    ['Findings: 2\nnet.mjs:12\nFindings: 3', 3],
    ['Findings: 2\n\n  \n', 2],
    ['Findings: -1', null],
    ['Findings: 99999', null],
    ['Findings: 10000', null],
    ['Findings: 9999', 9999],
    ['Findings: 0', 0],
    ['```\nFindings: 5\n```', null],
    ['> Findings: 4', null],
    ['Findings: 2\nThat is all I found.', null],
    ['Findings: 2 (two stand)', null],
    ['**Findings: 3**', 3],
    ['__Findings: 3__', 3],
    ['**Findings: 3__', null],
    ['**Findings: 3', null],
    ['Findings: 3**', null],
    ['Findings: 3.', 3],
    ['**Findings: 3.**', 3],
    ['**Findings: 3**.', 3],
    ['Findings: 3..', null],
    ['Nothing holds.\nFindings: 0', 0],
    ['net.mjs:12 rounds half up.\nFindings: 0', null],
    ['- `src/totals.ts:4`: skips the tax.\n**Findings: 0**', null],
    ['net.mjs:12 does not stand: the rate is read once at start.\nFindings: 0', null],
    ['I checked src/totals.ts:4 and it is fine.\nFindings: 0', 0],
    ['See http://localhost:8080 for the app.\nFindings: 0', 0],
    ['Checked at 10:30.\nFindings: 0', 0],
    ['No finding stands.\nFindings: 0', 0],
    ['net.mjs:12 rounds half up.\nFindings: 1', 1],
    ['findings: 3', null],
    ['Findings:3', null],
    ['Findings: \u0663', null],
    ['Findings: \uff13', null],
    ['', null],
  ];
  for (const [text, count] of counts) assert.equal(reportCount(text), count, JSON.stringify(text));

  // The thread line follows the count. An empty reply and a missing line state no count, and a
  // zero after findings says it contradicts them. A copy that changed, or that cannot be compared with its base, ends
  // the plan failed. A brief that is long in bytes stays within the message bound and says where
  // it was cut.
  const wide = '\u6f22'.repeat(23_000);
  const rows = [
    {
      name: 'one finding',
      closing: reply('net.mjs:12\nFindings: 1'),
      line: 'Report finished: 1 finding stands.',
      run: ['reported', 1],
    },
    {
      name: 'no finding',
      closing: reply('Nothing holds.\nFindings: 0'),
      line: 'Report finished: no finding stands.',
      run: ['reported', 0],
    },
    {
      name: 'no count line',
      closing: reply('net.mjs:12 rounds half up.'),
      line: 'Report finished. It did not state how many findings stand.',
      run: ['reported', null],
    },
    {
      name: 'an empty reply',
      closing: [],
      line: 'Report finished. It did not state how many findings stand.',
      run: ['reported', null],
    },
    {
      name: 'a zero after findings',
      closing: reply('net.mjs:12 rounds half up.\ntotals.mjs:4 skips the tax.\nFindings: 0'),
      line: 'Report finished. Its count says no finding stands, and it lists findings.',
      run: ['reported', null],
    },
    {
      name: 'a copy that changed',
      closing: reply('net.mjs:12\nFindings: 1'),
      stray: true,
      line: 'Report stopped: the run changed files, and a report only reads.',
      run: ['failed', null],
    },
    {
      // A link in the copy, left after the slices, makes it impossible to list.
      name: 'a copy that cannot be compared',
      closing: reply('net.mjs:12\nFindings: 1'),
      link: true,
      line: "Report stopped: the run's copy could not be compared, and a report only reads.",
      run: ['failed', null],
    },
    {
      name: 'a long reply in three-byte characters',
      slice: `\u58f2\u4e0a.mjs:1 ${wide}`,
      challenge: wide,
      closing: reply('x\nFindings: 1'),
      line: 'Report finished: 1 finding stands.',
      run: ['reported', 1],
    },
  ];
  for (const row of rows) {
    const g = harness(t, {
      shape: 'report',
      crew: reportCrew,
      openai: [
        planOf(1, true),
        reply(row.slice ?? 'net.mjs:12 rounds half up.'),
        row.link ? slow('It stands.') : reply(row.challenge ?? 'It stands.'),
        row.closing,
      ],
    });
    const copy = chatScratchDirectory(g.home, g.taskId);
    if (row.stray) writeFileSync(join(copy, 'stray.txt'), 'x\n');
    const finished = g.until(reportEnds);
    if (row.link) {
      await ticks(() => g.turns().some((turn) => turn.role === 'challenger'));
      writeFileSync(join(copy, 'stray.txt'), 'x\n');
      symlinkSync('stray.txt', join(copy, 'stray-link'));
    }
    await finished;
    await g.quiet();
    assert.equal(entries(g).at(-1)?.text, row.line, row.name);
    assert.deepEqual([g.run().state, g.run().findings], row.run, row.name);
    assert.equal(endings(g), 1, row.name);
    assert.deepEqual(
      g.notices,
      [{ kind: row.run[0] === 'failed' ? 'failed' : 'finished', line: row.line }],
      row.name,
    );
    for (const entry of entries(g).filter((value) => value.kind === 'user-message'))
      assert.ok(Buffer.byteLength(entry.text, 'utf8') <= 65_536, row.name);
    if (row.challenge) assert.match(g.requests()[3].prompt, /\[trimmed\]/, row.name);
  }
});

// Claim: the controller refuses a plan a report run cannot use, in its fixed sentences, and runs
// no slice. A plan with a slice that writes and a reply with no plan are sent back once, as a plan
// over the cap is, and then stop the plan. Only a report recipe's thread plans this way, whatever
// its request says, and on that thread a message the person sends plans as a report too.
test('a report run refuses a plan with a writing slice', { timeout: 60000 }, async (t) => {
  const refusal = 'A report run only reads. The plan has a slice that writes.';
  const rows = [
    { name: 'a slice that writes', openai: [planOf(2, false), planOf(2, false)], why: refusal },
    {
      name: 'a direct answer',
      openai: [reply('Nothing here needs splitting.'), reply('Still nothing.')],
      why: 'The reply has no fenced json block tagged plan.',
    },
  ];
  for (const row of rows) {
    const h = harness(t, { shape: 'report', crew: reportCrew, openai: row.openai });
    await h.until(reportEnds);
    await h.quiet();
    assert.deepEqual(
      h.turns().map((turn) => turn.role),
      ['orchestrator', 'orchestrator'],
      row.name,
    );
    assert.ok(h.requests()[1].prompt.includes(`The plan did not pass validation. ${row.why}`));
    assert.match(
      h.requests()[0].systemContext,
      /This is a report run, so always reply with a plan/,
    );
    const line = `Plan stopped: the plan did not pass validation. ${row.why}`;
    assert.equal(entries(h).at(-1)?.text, line, row.name);
    assert.deepEqual(
      [h.run().state, h.run().reason, h.store.chatThread(h.taskId)?.plan ?? null],
      ['failed', line, null],
      row.name,
    );
    assert.deepEqual(h.notices, [{ kind: 'failed', line }], row.name);
    assert.equal(endings(h), 1, row.name);
  }

  // Nothing about a report run is read from a message's words. A change recipe whose request
  // begins with the report's first sentence plans and runs like any other, and a report recipe
  // with that request gets the planning brief and reports.
  const lead = `${REPORT_LEAD} Then fix the totals.`;
  const crewLine = 'Crew finished: 1 slice, 0 reviews, 0 fixes.';
  const change = harness(t, {
    crew: crewOf('orchestrator', 'builder'),
    request: lead,
    openai: [planOf(1, false), reply('Built.')],
  });
  await change.until(reportEnds);
  await change.quiet();
  assert.match(change.requests()[0].systemContext, /Answer a question, or a request/);
  assert.deepEqual(
    change.turns().map((turn) => turn.role),
    ['orchestrator', 'assistant'],
  );
  assert.equal(entries(change).at(-1)?.text, crewLine);
  assert.deepEqual(ended(change), [`finished: ${crewLine}`]);
  assert.deepEqual(change.notices, [{ kind: 'finished', line: crewLine }]);
  assert.equal(change.run().state, 'no-change');
  assert.equal(change.store.chatThread(change.taskId)?.plan?.report, undefined);
  const reportLine = 'Report finished: 1 finding stands.';
  const report = harness(t, {
    shape: 'report',
    crew: reportCrew,
    request: lead,
    openai: [
      planOf(1, true),
      reply('net.mjs:12 rounds half up.'),
      reply('It stands.'),
      reply('net.mjs:12\nFindings: 1'),
    ],
  });
  await report.until(reportEnds);
  await report.quiet();
  assert.match(report.requests()[0].systemContext, /This is a report run, so always reply/);
  assert.equal(entries(report).at(-1)?.text, reportLine);
  assert.deepEqual(ended(report), [`finished: ${reportLine}`]);
  assert.deepEqual(report.notices, [{ kind: 'finished', line: reportLine }]);
  assert.deepEqual([report.run().state, report.run().findings], ['reported', 1]);

  // A message the person sends while the run plans waits, and the refusal ends the run. The thread
  // still reports, so that message plans with the report's brief too, and its plan with a slice
  // that writes is refused with the sentence that points to a new thread.
  const plan = planOf(1, false)[0] as Extract<ChatScriptStep, { kind: 'text' }>;
  const queued = harness(t, {
    shape: 'report',
    crew: reportCrew,
    openai: [slow(plan.chunks.join('')), planOf(1, false), planOf(1, false)],
  });
  const later = queued.until(lineIs(/^Plan stopped: .*Start a new thread to change files\.$/));
  queued.act((effects) =>
    queued.chat.sendMessage(
      {
        taskId: queued.taskId,
        text: 'Fix net.mjs:12.',
        role: 'assistant',
        attachments: [],
        files: [],
      },
      effects,
    ),
  );
  await later;
  await queued.quiet();
  const stopped = `Plan stopped: the plan did not pass validation. ${refusal}`;
  const afterwards = `Plan stopped: the plan did not pass validation. This thread reports and only reads. Start a new thread to change files.`;
  assert.match(queued.requests()[1].systemContext, /This is a report run, so always reply/);
  assert.deepEqual(
    queued.turns().map((turn) => turn.role),
    ['orchestrator', 'orchestrator', 'orchestrator'],
  );
  assert.equal(queued.store.chatThread(queued.taskId)?.plan ?? null, null);
  assert.equal(entries(queued).at(-1)?.text, afterwards);
  assert.deepEqual(ended(queued), [`failed: ${stopped}`, `failed: ${afterwards}`]);
  assert.deepEqual(queued.notices, [
    { kind: 'failed', line: stopped },
    { kind: 'failed', line: afterwards },
  ]);
  assert.deepEqual([queued.run().state, queued.run().reason], ['failed', stopped]);
});

// Claim: a report run ends once however its closing step goes wrong, and nothing runs after the
// step that ended it. A limit that a handoff or the schedule moved to another provider leaves the
// plan waiting for the rerun, which writes the report with the report's own brief and counts it.
// The plan stays a report plan after the run has ended: Retry of a failed slice or of the failed
// report, and Continue on the limit card, run it to its report line, and the run's row stays as
// it ended.
test('a report run with a failed slice ends failed and runs no closing turn', {
  timeout: 60000,
}, async (t) => {
  type H = ReturnType<typeof harness>;
  const fails: ChatScriptStep[] = [{ kind: 'fail', stopReason: 'error', failure: broken }];
  const stops = (line: string, notice: string, roles: string[], openai: ChatScriptStep[][]) => ({
    openai,
    roles,
    line,
    ended: [`failed: ${line}`],
    notices: [{ kind: notice, line }],
    run: ['failed', null, line] as Row['run'],
  });
  const reported = 'Report finished: 1 finding stands.';
  const finished = {
    line: reported,
    ended: [`finished: ${reported}`],
    notices: [{ kind: 'finished', line: reported }],
    run: ['reported', 1, null] as Row['run'],
  };
  const closing = [planOf(1, true), reply('net.mjs:12 rounds half up.'), reply('It stands.')];
  const firstLimit = 'OpenAI reached its usage limit. Resets at an unknown time.';
  const afterwards = 'This thread reports and only reads. Start a new thread to change files.';
  const refusedAfter = `the plan did not pass validation. ${afterwards}`;
  const planBlock = (planOf(1, false)[0] as Extract<ChatScriptStep, { kind: 'text' }>).chunks.join(
    '',
  );
  /** A second thread, so a turn there can end while this one runs. */
  const OTHER_TASK = 'tsk_01M50838M0000000000000ZZZ9';
  /** Act once the run has ended, and wait for the plan to end again. */
  const again = async (h: H, act: (effects: (() => void)[]) => CommandResult) => {
    const next = h.until(reportEnds);
    const result = h.act(act);
    assert.equal(result.outcome, 'applied', JSON.stringify(result));
    await next;
    await h.quiet();
  };
  type Row = {
    name: string;
    openai: ChatScriptStep[][];
    anthropic?: ChatScriptStep[][];
    auto?: boolean;
    mode?: 'balanced';
    schedule?: { maxUsed: number };
    openaiLeft?: () => number;
    /** What happens while the run goes on, before it first ends. */
    during?: (h: H) => Promise<void>;
    /** What happens after it first ends. */
    after?: (h: H) => Promise<void>;
    roles: string[];
    /** The thread's last system line. */
    line: string;
    /** Each plan-ended, as its outcome and line. */
    ended: string[];
    notices: { kind: string; line: string }[];
    /** The run's state, findings and reason. */
    run: [string, number | null, string | null];
    /** How many requests answered the report's message. Each had the report's brief. */
    reports?: number;
    check?: (h: H) => void;
  };
  const rows: Row[] = [
    {
      name: 'a slice fails',
      ...stops(
        'Plan stopped: slice 1 failed. Run it again from the plan card.',
        'failed',
        ['orchestrator', 'ask'],
        [planOf(2, true), fails, reply('Late.')],
      ),
    },
    {
      name: 'the challenge fails',
      ...stops(
        'Crew stopped: the challenge failed.',
        'failed',
        ['orchestrator', 'ask', 'challenger'],
        [planOf(1, true), reply('net.mjs:12 rounds.'), fails, reply('Late.')],
      ),
    },
    {
      name: 'the report fails',
      ...stops(
        'Plan stopped: the report failed.',
        'failed',
        ['orchestrator', 'ask', 'challenger', 'orchestrator'],
        [...closing, fails],
      ),
      reports: 1,
    },
    {
      name: 'the report fails and Retry runs it again as the report',
      openai: [...closing, fails, reply('net.mjs:12\nFindings: 1')],
      after: (h) =>
        again(h, (effects) =>
          h.chat.retryTurn(
            { taskId: h.taskId, turnId: h.turns().at(-1)?.id as string, mode: 'retry' },
            effects,
          ),
        ),
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator'],
      ...finished,
      ended: ['failed: Plan stopped: the report failed.', `finished: ${reported}`],
      notices: [
        { kind: 'failed', line: 'Plan stopped: the report failed.' },
        { kind: 'finished', line: reported },
      ],
      run: ['failed', null, 'Plan stopped: the report failed.'],
      reports: 2,
    },
    {
      name: 'a slice fails and Retry runs it again as a report slice',
      openai: [
        planOf(1, true),
        fails,
        reply('net.mjs:12 rounds half up.'),
        reply('It stands.'),
        reply('net.mjs:12\nFindings: 1'),
      ],
      after: (h) =>
        again(h, (effects) =>
          h.chat.retryTurn(
            {
              taskId: h.taskId,
              turnId: h.turns().find((turn) => turn.slice === 1)?.id as string,
              mode: 'retry',
            },
            effects,
          ),
        ),
      roles: ['orchestrator', 'ask', 'ask', 'challenger', 'orchestrator'],
      ...finished,
      ended: [
        'failed: Plan stopped: slice 1 failed. Run it again from the plan card.',
        `finished: ${reported}`,
      ],
      notices: [
        { kind: 'failed', line: 'Plan stopped: slice 1 failed. Run it again from the plan card.' },
        { kind: 'finished', line: reported },
      ],
      run: ['failed', null, 'Plan stopped: slice 1 failed. Run it again from the plan card.'],
      reports: 1,
      check: (h) => {
        assert.match(h.requests()[2].prompt, /End with your findings, one per line/);
        assert.match(h.requests()[3].systemContext, /Argue against every finding/);
      },
    },
    {
      name: 'the report reaches a limit with nowhere to go, and Continue on the card runs it again',
      openai: [...closing, limited],
      anthropic: [reply('net.mjs:12\nFindings: 1')],
      after: (h) =>
        again(h, (effects) =>
          h.chat.handoff(
            {
              taskId: h.taskId,
              selection: { family: 'anthropic', model: 'anthropic-model', effort: 'default' },
              reason: 'limit',
            },
            effects,
          ),
        ),
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator'],
      ...finished,
      ended: ['failed: Plan stopped: OpenAI reached its usage limit.', `finished: ${reported}`],
      notices: [
        { kind: 'limit', line: 'Plan stopped: OpenAI reached its usage limit.' },
        { kind: 'finished', line: reported },
      ],
      run: ['failed', null, 'Plan stopped: OpenAI reached its usage limit.'],
      reports: 2,
    },
    {
      name: 'the report reaches a limit and the handoff moves it',
      auto: true,
      openai: [...closing, limited],
      anthropic: [reply('net.mjs:12 rounds half up.\nFindings: 1')],
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator'],
      ...finished,
      reports: 2,
    },
    {
      name: 'the schedule refuses the report and the handoff moves it',
      auto: true,
      schedule: { maxUsed: 50 },
      openai: [...closing, reply('Never runs.')],
      anthropic: [reply('net.mjs:12 rounds half up.\nFindings: 1')],
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator'],
      ...finished,
      reports: 1,
    },
    {
      name: 'the rerun after a handoff reaches a limit too',
      auto: true,
      anthropic: [limited],
      ...stops(
        'Plan stopped: Anthropic reached its usage limit.',
        'limit',
        ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator'],
        [...closing, limited],
      ),
      reports: 2,
    },
    {
      name: 'the handoff lands on a provider the schedule refuses',
      auto: true,
      schedule: { maxUsed: 50 },
      anthropic: [reply('Never runs.')],
      // Anthropic's reading turns old as the handoff lands there.
      during: async (h) => {
        const stop = h.store.subscribe((event) => {
          if (lineIs(/^Continued on Anthropic/)(event)) h.stale.anthropic = true;
        });
        await h.until(reportEnds);
        stop();
      },
      ...stops(
        'Plan stopped: The report did not start. CrewKite has no current allowance reading for Anthropic.',
        'limit',
        ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator'],
        [...closing, reply('Never runs.')],
      ),
      reports: 0,
    },
    {
      name: 'the person stops the rerun',
      auto: true,
      openai: [...closing, limited],
      anthropic: [wait],
      during: async (h) => {
        const rerun = () =>
          h
            .turns()
            .find((turn) => turn.selection.family === 'anthropic' && turn.state === 'running');
        await ticks(() => !!rerun());
        await h.quiet();
        h.act((effects) =>
          h.chat.stopTurn({ taskId: h.taskId, turnId: rerun()?.id as string }, effects),
        );
      },
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator'],
      line: 'Plan stopped: you stopped the reply.',
      ended: ['stopped: Plan stopped: you stopped the reply.'],
      notices: [],
      run: ['stopped', null, 'Plan stopped: you stopped the reply.'],
      reports: 2,
    },
    {
      name: 'both closing turns move to another provider',
      auto: true,
      openai: [planOf(1, true), reply('net.mjs:12 rounds half up.'), limited, limited],
      anthropic: [reply('It stands.'), reply('net.mjs:12\nFindings: 1')],
      roles: ['orchestrator', 'ask', 'challenger', 'challenger', 'orchestrator', 'orchestrator'],
      ...finished,
      reports: 2,
    },
    {
      name: 'a report reply holds a plan block',
      openai: [
        ...closing,
        reply(
          `\`\`\`json plan\n${JSON.stringify({ planId: 'p2', goal: 'g', slices: [{ id: 1, title: 't', brief: 'b', files: [], depends: [], difficulty: 'medium', readOnly: true }] })}\n\`\`\`\nFindings: 1`,
        ),
        reply('Never runs.'),
      ],
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator'],
      ...finished,
      reports: 1,
      check: (h) => assert.equal(h.store.chatThread(h.taskId)?.plan?.planId, 'p1'),
    },
    {
      // The message waits for the plan, then plans with the report's brief, since the thread still
      // reports. Its plan with a slice that writes is refused, and the run keeps its count.
      name: 'a message sent while the report runs',
      openai: [...closing, slow('net.mjs:12\nFindings: 1'), planOf(1, false), planOf(1, false)],
      during: async (h) => {
        await ticks(
          () =>
            h.turns().filter((turn) => turn.role === 'orchestrator').length === 2 &&
            h.turns().at(-1)?.state === 'running',
        );
        h.act((effects) =>
          h.chat.sendMessage(
            {
              taskId: h.taskId,
              text: 'One more thing.',
              role: 'assistant',
              attachments: [],
              files: [],
            },
            effects,
          ),
        );
      },
      after: async (h) => {
        await ticks(() => entries(h).at(-1)?.text === `Plan stopped: ${refusedAfter}`);
        await h.quiet();
      },
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator', 'orchestrator'],
      ...finished,
      line: `Plan stopped: ${refusedAfter}`,
      ended: [`finished: ${reported}`, `failed: Plan stopped: ${refusedAfter}`],
      notices: [
        { kind: 'finished', line: reported },
        { kind: 'failed', line: `Plan stopped: ${refusedAfter}` },
      ],
      reports: 1,
      check: (h) => {
        assert.match(h.requests()[4].systemContext, /This is a report run, so always reply/);
        assert.equal(h.store.chatThread(h.taskId)?.plan?.phase, 'finished');
      },
    },
    {
      // The run's first turn stops on a limit, which ends the run. Continue on the card plans the
      // request again on another provider, as a report: a plan that writes is refused with the
      // sentence for a thread whose run has ended, and the read-only plan the retry gives runs to
      // its report.
      name: 'the first turn reaches a limit, and Continue on the card plans a report',
      openai: [limited, ...closing.slice(1), reply('net.mjs:12\nFindings: 1')],
      anthropic: [planOf(1, false), planOf(1, true)],
      during: async (h) => {
        await ticks(() => h.turns()[0]?.state === 'failed');
        await h.quiet();
        h.act((effects) =>
          h.chat.handoff(
            {
              taskId: h.taskId,
              selection: { family: 'anthropic', model: 'anthropic-model', effort: 'default' },
              reason: 'limit',
            },
            effects,
          ),
        );
      },
      roles: ['orchestrator', 'orchestrator', 'orchestrator', 'ask', 'challenger', 'orchestrator'],
      ...finished,
      ended: [`failed: ${firstLimit}`, `finished: ${reported}`],
      notices: [
        { kind: 'limit', line: firstLimit },
        { kind: 'finished', line: reported },
      ],
      run: ['failed', null, firstLimit],
      reports: 1,
      check: (h) => {
        for (const request of h.requests('anthropic'))
          assert.match(request.systemContext, /This is a report run, so always reply/);
        assert.ok(h.requests('anthropic')[1].prompt.includes(afterwards));
      },
    },
    {
      // The same with nobody there: the start at reset reruns the request when the window reopens.
      name: 'the first turn reaches a limit, and the start at reset plans a report',
      openaiLeft: () => 50,
      openai: [
        limited,
        planOf(1, false),
        planOf(1, true),
        ...closing.slice(1),
        reply('net.mjs:12\nFindings: 1'),
      ],
      during: async (h) => {
        h.openai.resetsAt = '2026-10-15T19:00:00.000Z';
        await ticks(() => h.turns()[0]?.state === 'failed');
        await h.quiet();
        const armed = h.act((effects) =>
          h.chat.configure({ taskId: h.taskId, startAtReset: true }, effects),
        );
        assert.equal(armed.outcome, 'applied');
        h.clock.advance(3 * 60 * 60 * 1000);
        for (const run of h.timers.splice(0)) run();
      },
      roles: ['orchestrator', 'orchestrator', 'orchestrator', 'ask', 'challenger', 'orchestrator'],
      ...finished,
      ended: [`failed: ${firstLimit}`, `finished: ${reported}`],
      notices: [
        { kind: 'limit', line: firstLimit },
        { kind: 'finished', line: reported },
      ],
      run: ['failed', null, firstLimit],
      reports: 1,
      check: (h) => {
        assert.match(h.requests()[1].systemContext, /This is a report run, so always reply/);
        assert.ok(h.requests()[2].prompt.includes(afterwards));
      },
    },
    {
      // A plan card stored before plans carried the report mark runs as a report.
      name: 'a stored plan card without the report mark',
      mode: 'balanced',
      openai: [...closing, reply('net.mjs:12\nFindings: 1')],
      during: async (h) => {
        await ticks(() => h.store.chatThread(h.taskId)?.plan?.phase === 'proposed');
        const row = h.store.db
          .prepare('SELECT body FROM chat_threads WHERE task_id=?')
          .get(h.taskId) as { body: string };
        const stored = JSON.parse(row.body) as { plan: { report?: unknown } };
        delete stored.plan.report;
        h.store.db
          .prepare('UPDATE chat_threads SET body=? WHERE task_id=?')
          .run(JSON.stringify(stored), h.taskId);
        assert.equal(h.store.chatThread(h.taskId)?.plan?.report, undefined);
        h.act((effects) => h.chat.runPlan({ taskId: h.taskId, planId: 'p1' }, effects));
        assert.deepEqual(h.store.chatThread(h.taskId)?.plan?.report, { messageId: null });
      },
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator'],
      ...finished,
      notices: [
        { kind: 'approval-needed', line: 'waiting for approval' },
        { kind: 'finished', line: reported },
      ],
      reports: 1,
    },
    {
      // Run plan again after the report failed: the plan names no report message until the new
      // report writes one.
      name: 'the report fails and Run plan runs the plan again',
      openai: [...closing, fails, reply('It still stands.'), reply('net.mjs:12\nFindings: 1')],
      after: async (h) => {
        const next = h.until(reportEnds);
        h.act((effects) => h.chat.runPlan({ taskId: h.taskId, planId: 'p1' }, effects));
        assert.deepEqual(h.store.chatThread(h.taskId)?.plan?.report, { messageId: null });
        await next;
        await h.quiet();
      },
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator', 'challenger', 'orchestrator'],
      ...finished,
      ended: ['failed: Plan stopped: the report failed.', `finished: ${reported}`],
      notices: [
        { kind: 'failed', line: 'Plan stopped: the report failed.' },
        { kind: 'finished', line: reported },
      ],
      run: ['failed', null, 'Plan stopped: the report failed.'],
      reports: 1,
    },
    {
      // The person stops the report as it writes, then asks for the rest. The continuation answers
      // a message of its own, which the plan now names, and it ends the plan with its count. A plan
      // block in it starts nothing.
      name: 'a stopped report continued',
      openai: [
        ...closing,
        [{ kind: 'text', itemId: 'r', chunks: ['net.mjs:12 ', ...Array(30).fill('')] }, ...wait],
        reply(`${planBlock}\nnet.mjs:12 rounds half up.\nFindings: 1`),
      ],
      during: async (h) => {
        const writing = () =>
          h.turns().filter((turn) => turn.role === 'orchestrator').length === 2 &&
          h.turns().at(-1)?.state === 'running';
        await ticks(writing);
        await h.quiet();
        h.act((effects) =>
          h.chat.stopTurn({ taskId: h.taskId, turnId: h.turns().at(-1)?.id as string }, effects),
        );
      },
      after: (h) =>
        again(h, (effects) =>
          h.chat.retryTurn(
            { taskId: h.taskId, turnId: h.turns().at(-1)?.id as string, mode: 'continue' },
            effects,
          ),
        ),
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator'],
      ...finished,
      ended: ['stopped: Plan stopped: you stopped the reply.', `finished: ${reported}`],
      notices: [{ kind: 'finished', line: reported }],
      run: ['stopped', null, 'Plan stopped: you stopped the reply.'],
      reports: 1,
      check: (h) => {
        const [stopped, continued] = h.turns().slice(-2);
        const plan = h.store.chatThread(h.taskId)?.plan;
        assert.equal(plan?.planId, 'p1');
        assert.equal(plan?.report?.messageId, continued.userMessageId);
        assert.notEqual(stopped.userMessageId, continued.userMessageId);
      },
    },
    {
      // Regenerate reruns a finished report the way Retry does, with the copy check and its line.
      name: 'a finished report regenerated',
      openai: [...closing, reply('net.mjs:12\nFindings: 1'), reply('Nothing stands.\nFindings: 0')],
      after: (h) =>
        again(h, (effects) =>
          h.chat.retryTurn(
            { taskId: h.taskId, turnId: h.turns().at(-1)?.id as string, mode: 'regenerate' },
            effects,
          ),
        ),
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator'],
      line: 'Report finished: no finding stands.',
      ended: [`finished: ${reported}`, 'finished: Report finished: no finding stands.'],
      notices: [
        { kind: 'finished', line: reported },
        { kind: 'finished', line: 'Report finished: no finding stands.' },
      ],
      run: ['reported', 1, null],
      reports: 2,
    },
    {
      // The orchestrator's model can no longer be picked when the report would start. The thread
      // says why before the plan's stop line.
      name: 'the report cannot start',
      during: async (h) => {
        await ticks(() => h.turns().some((turn) => turn.role === 'challenger'));
        h.openai.gone = true;
      },
      ...stops(
        'Plan stopped: the report could not start.',
        'failed',
        ['orchestrator', 'ask', 'challenger'],
        [planOf(1, true), reply('net.mjs:12 rounds half up.'), slow('It stands.')],
      ),
      check: (h) => {
        const lines = entries(h).filter((entry) => entry.kind === 'chat-system');
        assert.equal(lines.at(-2)?.text, 'Pick a provider and model in the composer.');
        assert.equal(h.store.chatThread(h.taskId)?.plan?.report?.messageId, null);
      },
    },
    {
      // A turn in another thread ends while the reopened report runs, which wakes every plan. The
      // report plan does not start its challenge again.
      name: 'another thread wakes the plans while a reopened report runs',
      openai: [...closing, limited, reply('A plain answer.')],
      anthropic: [
        [
          {
            kind: 'text',
            itemId: 'r',
            chunks: [...Array(200).fill(''), 'net.mjs:12\nFindings: 1'],
          },
        ],
      ],
      after: async (h) => {
        const next = h.until(lineIs(/^Report finished/));
        h.act((effects) =>
          h.chat.handoff(
            {
              taskId: h.taskId,
              selection: { family: 'anthropic', model: 'anthropic-model', effort: 'default' },
              reason: 'limit',
            },
            effects,
          ),
        );
        await ticks(() => h.turns().at(-1)?.selection.family === 'anthropic');
        const other = {
          ...(h.store.get('task', h.taskId) as Task),
          id: OTHER_TASK,
          title: 'Other',
        };
        h.store.transaction(() => h.store.put('task', other.id, 0, other));
        const sent = h.act((effects) =>
          h.chat.sendMessage(
            {
              taskId: other.id,
              text: 'Hello.',
              role: 'assistant',
              selection: on,
              attachments: [],
              files: [],
            },
            effects,
          ),
        );
        assert.equal(sent.outcome, 'applied');
        await next;
        await ticks(() => h.notices.length === 3);
        await h.quiet();
      },
      roles: ['orchestrator', 'ask', 'challenger', 'orchestrator', 'orchestrator'],
      ...finished,
      ended: ['failed: Plan stopped: OpenAI reached its usage limit.', `finished: ${reported}`],
      notices: [
        { kind: 'limit', line: 'Plan stopped: OpenAI reached its usage limit.' },
        // The other thread's own answer, which ends while the report still streams.
        { kind: 'finished', line: '' },
        { kind: 'finished', line: reported },
      ],
      run: ['failed', null, 'Plan stopped: OpenAI reached its usage limit.'],
      reports: 2,
    },
  ];
  for (const row of rows) {
    const h = harness(t, {
      shape: 'report',
      crew: reportCrew,
      openai: row.openai,
      ...(row.auto ? { auto: true } : {}),
      ...(row.mode ? { mode: row.mode } : {}),
      ...(row.openaiLeft ? { openaiLeft: row.openaiLeft } : {}),
      ...(row.anthropic ? { anthropic: row.anthropic } : {}),
      ...(row.schedule
        ? { schedule: row.schedule, openaiLeft: (turns: number) => (turns >= 3 ? 10 : 60) }
        : {}),
    });
    const first = h.until(reportEnds);
    await row.during?.(h);
    await first;
    await h.quiet();
    await row.after?.(h);
    assert.deepEqual(
      h.turns().map((turn) => turn.role),
      row.roles,
      row.name,
    );
    const lines = entries(h).filter((entry) => entry.kind === 'chat-system');
    assert.equal(lines.at(-1)?.text, row.line, row.name);
    if (!row.check) assert.equal(entries(h).at(-1)?.text, row.line, row.name);
    assert.deepEqual(ended(h), row.ended, row.name);
    assert.deepEqual(h.notices, row.notices, row.name);
    assert.deepEqual([h.run().state, h.run().findings, h.run().reason], row.run, row.name);
    assert.equal(
      lines.some((entry) => /^Crew finished/.test(entry.text)),
      false,
      row.name,
    );
    // Every slice's prompt tells it to end with findings, which only a report says.
    const slices = h.requests().filter((request) => request.role === 'ask');
    assert.ok(slices.length > 0, row.name);
    for (const request of slices)
      assert.match(request.prompt, /End with your findings, one per line/, row.name);
    // Whichever provider answers the report's message, it gets the report's brief, read only.
    const asked = h.store.chatThread(h.taskId)?.plan?.report?.messageId;
    const answering = new Set(
      h
        .turns()
        .filter((turn) => turn.userMessageId === asked)
        .map((turn) => turn.id),
    );
    const reports = [...h.requests(), ...h.requests('anthropic')].filter((request) =>
      answering.has(request.turnId),
    );
    if (row.reports !== undefined) assert.equal(reports.length, row.reports, row.name);
    for (const request of reports) {
      assert.match(request.systemContext, /orchestrator writing the report/, row.name);
      assert.equal(request.readOnly, true, row.name);
      assert.equal(request.permissionPolicy, 'ask', row.name);
    }
    row.check?.(h);
  }
});
