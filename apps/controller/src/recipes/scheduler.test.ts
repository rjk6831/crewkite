import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type ChatCatalogRead,
  type ChatCrew,
  type ChatModelSelection,
  type CommandResult,
  type PlanRecipe,
  type PlanRecipeRecord,
  type PlanRecipeRun,
  type PlanRecipeTrigger,
  type PlanScheduleNote,
  type PlanScheduleRecord,
  planScheduleLine,
  type Task,
} from '@crewkite/contracts';
import { type ChatScriptStep, createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { chatFailure } from '../chat/adapter.ts';
import { Controller, type ControllerOptions } from '../commands/controller.ts';
import { git } from '../host/source.ts';
import { installedTools, setup } from '../store/controller-fixture.ts';
import { settleRun } from './scheduler.ts';

const MINUTE = 60_000;
const pick: ChatModelSelection = { family: 'openai', model: 'fixture-model', effort: 'default' };
const crew: ChatCrew = {
  name: 'Pair',
  members: [
    { role: 'orchestrator', selection: pick },
    { role: 'builder', selection: pick },
  ],
};
const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];
const plan = reply(
  `\`\`\`json plan\n${JSON.stringify({
    planId: 'p1',
    goal: 'Tidy it.',
    slices: [
      {
        id: 1,
        title: 'Part 1',
        brief: 'Do part 1.',
        files: [],
        depends: [],
        difficulty: 'medium',
        readOnly: false,
      },
    ],
  })}\n\`\`\``,
);
/** A slice that writes one file, so its run ends ready for Accept. */
const builds = (content: string): ChatScriptStep[] => [
  {
    kind: 'tool',
    callId: 'w',
    toolKind: 'edit',
    title: 'Write net.mjs',
    write: { path: 'net.mjs', content },
  },
  ...reply('Built.'),
];
/** An orchestrator that fails at once, so its run ends failed. */
const fails: ChatScriptStep[] = [
  {
    kind: 'fail',
    stopReason: 'error',
    failure: chatFailure({ stage: 'stream', kind: 'client-exit', message: 'It exited.' }),
  },
];
/** An orchestrator that answers with no plan, so its run changes nothing and finds nothing. */
const nothing = reply('Nothing to change.');
/** An orchestrator that keeps going until it is stopped. */
const parks: ChatScriptStep[] = [{ kind: 'wait' }];

type Timer = { work: () => void; ms: number; cancelled: boolean; fired: boolean };
type Post = { event: string; schedule?: string; text: string };

/** Only git on PATH, so nothing a test runs can find gh or a provider client. */
function lockPath(t: TestContext) {
  const tools = mkdtempSync(join(tmpdir(), 'ck-schedule-path-'));
  const saved = process.env.PATH;
  process.env.PATH = installedTools(tools, 'git');
  t.after(() => {
    process.env.PATH = saved;
    rmSync(tools, { recursive: true, force: true });
  });
}

/**
 * A controller whose OpenAI turns play the scripts in order, with a fake clock, a timer that only
 * records, a catalog the test sets and a usage read that only marks the reading fresh. Nothing
 * starts a real timer, a provider or a network call, and no client is attached until the test
 * says so.
 */
async function open(t: TestContext, turns: ChatScriptStep[][]) {
  lockPath(t);
  const timers: Timer[] = [];
  /** What the webhook was sent for schedules. Thread events go to the same address. */
  const posts: Post[] = [];
  const options = {
    chatAdapters: new Map([['openai', createScriptedChatAdapter({ family: 'openai', turns })]]),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
    // The app keeps checklist work off. These tests hold the scheduler's side of it.
    checklistWork: true,
    scheduleStarts: (work: () => void, ms: number) => {
      const timer = { work, ms, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    webhookFetch: (async (_url: unknown, init?: RequestInit) => {
      const post: Post = JSON.parse(String(init?.body));
      if (post.schedule !== undefined) posts.push(post);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  } satisfies Partial<ControllerOptions>;
  const context = await setup(t, options);
  const { command, clock } = context;
  let controller = context.controller;
  /** OpenAI's weekly window. A usage read marks it observed now unless the read is `lost`. */
  const window = {
    percent: 60 as number | null,
    observedAt: clock.now(),
    resetsAt: null as string | null,
    lost: false,
    /** OpenAI reports its credits used up with spending off, so a turn there is refused. */
    creditsOut: false,
  };
  let reads = 0;
  const stub = (target: Controller) =>
    Object.assign(target, {
      chatCatalog: (): ChatCatalogRead => ({
        families: [
          {
            family: 'openai',
            connected: true,
            reason: null,
            models: [
              {
                model: 'fixture-model',
                label: 'Fixture',
                efforts: ['default'],
                defaultEffort: 'default',
              },
            ],
            defaultModel: 'fixture-model',
            remaining: [
              {
                windowId: 'weekly',
                label: 'Weekly',
                percent: window.percent,
                resetsAt: window.resetsAt,
                observedAt: window.observedAt,
              },
            ],
            accepts: null,
            ...(window.creditsOut
              ? {
                  creditSpending: false,
                  credits: {
                    state: 'none' as const,
                    balance: null,
                    limitReached: true,
                    observedAt: clock.now(),
                  },
                }
              : {}),
          },
        ],
      }),
      refreshOpenAiUsage: async () => {
        reads += 1;
        if (!window.lost) window.observedAt = clock.now();
      },
    });
  stub(controller);
  const run = (name: string, payload: object, revision?: number): Promise<CommandResult> =>
    controller.execute(
      command(name, payload, revision ?? (/^Read/.test(name) ? undefined : 0)),
      'local-owner',
    );
  assert.equal((await run('SetWebhook', { url: 'http://127.0.0.1:9/hook' })).outcome, 'applied');
  const projectId = ((await controller.execute(context.draft, 'local-owner')).entity as Task)
    .projectId;
  const quiet = async () => {
    for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  };
  /** Resolves once `check` holds, re-checked on every event the store commits. */
  const when = (check: () => boolean) =>
    new Promise<void>((resolve) => {
      if (check()) return resolve();
      const stop = controller.store.subscribe(() => {
        if (!check()) return;
        stop();
        resolve();
      });
    });
  const recipeOf = (trigger: PlanRecipeTrigger, change: Partial<PlanRecipe> = {}): PlanRecipe => ({
    schema: 1,
    name: 'Tidy',
    description: '',
    shape: 'change',
    crew,
    run: {
      flightMode: 'glide',
      permissionPolicy: 'allow-all',
      handoff: { auto: false, mode: 'most-left' },
      maxSlices: 2,
    },
    checks: [],
    trigger,
    budget: { maxRuns: 3, maxUsedPercent: { openai: 80 }, maxWaiting: 3 },
    work: { kind: 'request', text: 'Tidy the module.' },
    ...change,
  });
  const save = async (
    body: PlanRecipe,
    path = '.crewkite/recipes/tidy.json',
    expectedVersion = 0,
    recipeId?: string,
  ): Promise<PlanRecipeRecord> => {
    const saved = await run('SaveRecipe', {
      projectId,
      ...(recipeId ? { recipeId } : {}),
      path,
      body,
      expectedVersion,
      confirm: 'explicit',
    });
    assert(saved.data?.kind === 'recipe-saved', JSON.stringify(saved));
    await quiet();
    return saved.data.record;
  };
  const schedule = (recipeId: string) => controller.store.recipeSchedule(recipeId);
  const runs = (recipeId: string) => controller.store.recipeRuns(recipeId, 100).runs.reverse();
  /** Timers still waiting: armed, not cancelled and not fired. */
  const pending = () => timers.filter((timer) => !timer.cancelled && !timer.fired);
  /** Calls a timer's work, as the clock reaching it would, and lets the start settle. */
  const fire = async (timer: Timer | undefined) => {
    assert(timer, 'a timer is armed');
    timer.fired = true;
    timer.work();
    await quiet();
  };
  const at = (start: string, minutes: number) =>
    new Date(Date.parse(start) + minutes * MINUTE).toISOString();
  /** Holds every usage read until `release`, as a slow read would. */
  const gate = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(controller, {
      refreshOpenAiUsage: async () => {
        reads += 1;
        await held;
        if (!window.lost) window.observedAt = clock.now();
      },
    });
    return () => {
      release();
      stub(controller);
    };
  };
  /** Writes a run row as another part of the controller would have, for a state to start from. */
  const putRun = (run: PlanRecipeRun) =>
    controller.store.transaction(() => controller.store.putRecipeRun(run));
  /** Stops, closes and starts the controller again on the same home and clock. */
  const restart = async (over: Partial<ControllerOptions> = {}) => {
    const home = controller.home;
    await controller.close();
    controller = new Controller({
      ...options,
      ...over,
      home,
      now: clock.now,
      id: context.id,
      routes: context.fixtures.snapshot.routes,
      observations: context.fixtures.snapshot.usage.map((value) => value.observation),
    });
    stub(controller);
    return controller;
  };
  return {
    ...context,
    controller: () => controller,
    run,
    projectId,
    window,
    reads: () => reads,
    timers,
    posts,
    quiet,
    when,
    recipeOf,
    save,
    schedule,
    runs,
    pending,
    fire,
    at,
    gate,
    putRun,
    restart,
  };
}

const stopped = async (h: Awaited<ReturnType<typeof open>>, taskId: string) => {
  const controller = h.controller();
  const turn = controller.store.db
    .prepare('SELECT id FROM chat_turns WHERE task_id=? ORDER BY sequence DESC LIMIT 1')
    .get(taskId)?.id as string;
  const revision = controller.store.get<Task>('task', taskId)?.revision ?? 0;
  const result = await h.run('StopChatTurn', { taskId, turnId: turn }, revision);
  assert.equal(result.outcome, 'applied', JSON.stringify(result));
};

// Claim: an interval schedule starts on the grid that begins when it was armed, a late timer
// keeps the grid, a repeated or a late callback for a start that already happened starts
// nothing, a client that leaves during the usage read takes the start with it, a run still going
// holds the next start without a usage read even behind a newer run that ended, and the third
// start of a three-run limit stops the schedule at once, posts the stop and leaves no timer.
test('an interval schedule runs on its grid, stops at its run limit and never shifts when a timer is late', {
  timeout: 60000,
}, async (t) => {
  const h = await open(t, [fails, parks, fails]);
  const armed = h.clock.now();
  const record = await h.save(h.recipeOf({ kind: 'interval', everyMinutes: 30 }));
  assert.equal(h.schedule(record.id)?.nextAt, h.at(armed, 30));
  assert.deepEqual(
    h.pending().map((timer) => timer.ms),
    [30 * MINUTE],
  );
  h.controller().clientsChanged(1);
  // A timer that wakes before its start arms again and starts nothing.
  await h.fire(h.pending()[0]);
  assert.deepEqual(
    [h.runs(record.id).length, h.pending().map((timer) => timer.ms)],
    [0, [30 * MINUTE]],
  );

  // The client leaves while the usage is read, so nothing starts and the start stays due.
  h.clock.advance(30 * MINUTE);
  const first = h.pending()[0];
  const release = h.gate();
  await h.fire(first);
  h.controller().clientsChanged(0);
  release();
  await h.quiet();
  assert.deepEqual(
    [h.runs(record.id).length, h.schedule(record.id)?.nextAt, h.pending().length],
    [0, h.at(armed, 30), 0],
  );
  // It comes back, and the start that is due runs at once.
  h.controller().clientsChanged(1);
  await h.when(() => h.runs(record.id)[0]?.state === 'failed');
  assert.equal(h.runs(record.id)[0].origin, 'schedule');
  assert.equal(h.reads(), 2);
  // A run's reading names its window by the ID, which stays unique where labels repeat.
  assert.deepEqual(h.runs(record.id)[0].allowance.start, [
    { family: 'openai', used: 40, window: 'weekly', observedAt: h.clock.now() },
  ]);
  // The same callback again finds the next start moved and starts nothing.
  await h.fire(first);
  assert.equal(h.runs(record.id).length, 1);
  assert.deepEqual(
    [h.schedule(record.id)?.runsStarted, h.schedule(record.id)?.nextAt],
    [1, h.at(armed, 60)],
  );
  assert.equal(h.pending().length, 1);

  // Ten minutes late: the run starts, and the next start stays on the grid. The same callback
  // again while the first one reads the usage starts nothing more.
  h.clock.advance(40 * MINUTE);
  const late = h.pending()[0];
  const hold = h.gate();
  await h.fire(late);
  await h.fire(late);
  hold();
  await h.quiet();
  assert.equal(h.runs(record.id).length, 2);
  assert.equal(h.schedule(record.id)?.nextAt, h.at(armed, 90));
  assert.deepEqual(
    h.pending().map((timer) => timer.ms),
    [20 * MINUTE],
  );

  // The second run is still going, so the start is passed over with no usage read, even with a
  // newer run that already ended.
  h.clock.advance(20 * MINUTE);
  h.putRun({
    ...h.runs(record.id)[0],
    id: `rrn_${h.id('msg').slice(4)}`,
    taskId: h.id('tsk'),
    origin: 'manual',
    startedAt: h.clock.now(),
    endedAt: h.clock.now(),
  });
  await h.fire(h.pending()[0]);
  const held = h.schedule(record.id);
  assert.deepEqual(
    [h.runs(record.id).length, held?.note?.code, held?.nextAt, h.reads()],
    [3, 'run-active', h.at(armed, 120), 4],
  );
  const second = h.runs(record.id)[1];
  await stopped(h, second.taskId);
  await h.when(() => h.runs(record.id)[1]?.state === 'stopped');

  h.clock.advance(30 * MINUTE);
  const last = h.pending()[0];
  await h.fire(last);
  const done = h.schedule(record.id);
  assert.deepEqual(
    [h.runs(record.id).length, done?.state, done?.runsStarted, done?.nextAt, h.pending().length],
    [4, 'stopped', 3, null, 0],
  );
  assert.equal(done?.note?.code, 'run-limit');
  // A late callback after the stop starts nothing.
  await h.fire(last);
  assert.equal(h.runs(record.id).length, 4);
  await h.quiet();
  assert.deepEqual(
    h.posts.map(({ event, schedule, text }) => ({ event, schedule, text })),
    [{ event: 'stopped', schedule: 'Tidy', text: 'Stopped. The run limit of 3 is reached.' }],
  );
  assert(h.timers.every((timer) => [20, 30].includes(timer.ms / MINUTE)));
});

// Claim: a schedule pauses as soon as its waiting limit of runs ready for Accept is reached, posts
// the pause, keeps no timer and refuses Resume with the count. A save that raises the limit
// lifts that pause, and one that lowers it under the count pauses again. Accepting one run brings
// it back to active with its next start on the grid after now. A pause the person makes over a
// waiting pause holds through an Accept, and only Resume lifts it.
test('a schedule pauses at the waiting limit and resumes when a run is accepted', {
  timeout: 60000,
}, async (t) => {
  const h = await open(t, [
    plan,
    builds('export const net = 1;\n'),
    plan,
    builds('export const net = 2;\n'),
    plan,
    builds('export const net = 3;\n'),
  ]);
  const armed = h.clock.now();
  const limit = (maxWaiting: number) =>
    h.recipeOf(
      { kind: 'interval', everyMinutes: 30 },
      { budget: { maxRuns: 5, maxUsedPercent: { openai: 80 }, maxWaiting } },
    );
  const record = await h.save(limit(2));
  h.controller().clientsChanged(1);
  const ready = async (count: number, minutes = 30) => {
    h.clock.advance(minutes * MINUTE);
    await h.fire(h.pending()[0]);
    await h.when(() => h.runs(record.id)[count - 1]?.state === 'ready');
    await h.quiet();
  };
  const accept = async (index: number, branch: string) => {
    const run = h.runs(record.id)[index];
    const revision = h.controller().store.get<Task>('task', run.taskId)?.revision ?? 0;
    const accepted = await h.run('AcceptChatChanges', { taskId: run.taskId, branch }, revision);
    assert.equal(accepted.outcome, 'applied', JSON.stringify(accepted));
    await h.when(() => h.runs(record.id)[index]?.state === 'accepted');
    await h.quiet();
  };
  const state = () => {
    const schedule = h.schedule(record.id);
    return [schedule?.state, schedule?.note?.code ?? null, schedule?.waiting, schedule?.nextAt];
  };
  await ready(1);
  await ready(2);
  assert.deepEqual([...state(), h.pending().length], ['paused', 'waiting-limit', 2, null, 0]);
  await h.quiet();
  assert.deepEqual(
    h.posts.map(({ event, schedule, text }) => ({ event, schedule, text })),
    [{ event: 'paused', schedule: 'Tidy', text: 'Paused. 2 runs are waiting for you.' }],
  );
  const resume = await h.run('SetRecipeSchedule', { recipeId: record.id, action: 'resume' });
  assert.deepEqual(resume, {
    outcome: 'blocked',
    reason: 'schedule-waiting',
    next: '2 runs are waiting for you. Accept or discard one, and the loop resumes on its own.',
  });

  // The saved limit decides the pause: above the count it lifts, at the count it holds again.
  await h.save(limit(5), '.crewkite/recipes/tidy.json', 1, record.id);
  assert.deepEqual(state(), ['active', null, 2, h.at(armed, 90)]);
  await h.save(limit(2), '.crewkite/recipes/tidy.json', 2, record.id);
  assert.deepEqual(state(), ['paused', 'waiting-limit', 2, null]);

  h.clock.advance(5 * MINUTE);
  await accept(0, 'feat/tidy-one');
  assert.deepEqual(state(), ['active', null, 1, h.at(armed, 90)]);
  assert.deepEqual(
    h.pending().map((timer) => timer.ms),
    [25 * MINUTE],
  );

  // A third run waits too, and the person pauses over the waiting pause.
  await ready(3, 25);
  assert.deepEqual(state(), ['paused', 'waiting-limit', 2, null]);
  assert.equal(
    (await h.run('SetRecipeSchedule', { recipeId: record.id, action: 'pause' })).outcome,
    'applied',
  );
  assert.deepEqual(state(), ['paused', 'by-person', 2, null]);
  // A save lifts only what the file caused, never the person's pause.
  await h.save(limit(5), '.crewkite/recipes/tidy.json', 3, record.id);
  assert.deepEqual(state(), ['paused', 'by-person', 2, null]);
  await accept(1, 'feat/tidy-two');
  assert.deepEqual([...state(), h.pending().length], ['paused', 'by-person', 1, null, 0]);
  assert.equal(
    (await h.run('SetRecipeSchedule', { recipeId: record.id, action: 'resume' })).outcome,
    'applied',
  );
  assert.deepEqual(state(), ['active', null, 1, h.at(armed, 120)]);
  assert.deepEqual(
    h.posts.map(({ event }) => event),
    ['paused', 'paused'],
  );
});

// Claim: a reading that is too old to trust, or none, never starts a run. An interval schedule
// passes over that start and tries at its next grid point, a reset schedule tries again 15
// minutes later, and a once schedule stops with the skip as its reason and posts it. A reading
// over the limit is passed over the same way, and the next fresh reading under it starts. A reset
// schedule whose provider reports no reset time has no next start and starts nothing, however
// long it waits: it only reads again every 15 minutes, and starts once at a reset it is told.
test('a schedule refuses on an unknown or stale reading and tries again', {
  timeout: 60000,
}, async (t) => {
  const h = await open(t, [fails, fails]);
  const armed = h.clock.now();
  const unknown = 'Did not start. CrewKite has no current allowance reading for OpenAI.';
  h.controller().clientsChanged(1);

  // The usage read does not land, so the reading stays twenty minutes old.
  h.window.lost = true;
  h.window.observedAt = h.at(armed, -20);
  const interval = await h.save(h.recipeOf({ kind: 'interval', everyMinutes: 30 }));
  h.clock.advance(30 * MINUTE);
  await h.fire(h.pending()[0]);
  const stale = h.schedule(interval.id);
  assert.deepEqual(
    [h.runs(interval.id).length, stale?.note?.code, stale?.nextAt, h.reads()],
    [0, 'allowance-unknown', h.at(armed, 60), 1],
  );
  assert.equal(stale?.note && planScheduleLine(stale.note), unknown);
  // A fresh reading over the limit is passed over too.
  h.window.lost = false;
  h.window.percent = 14;
  h.clock.advance(30 * MINUTE);
  await h.fire(h.pending()[0]);
  const over = h.schedule(interval.id);
  assert.deepEqual(
    [h.runs(interval.id).length, over?.note, over?.nextAt],
    [
      0,
      { code: 'allowance-limit', at: h.at(armed, 60), family: 'openai', used: 86, limit: 80 },
      h.at(armed, 90),
    ],
  );
  // Under the limit again, the next start runs, and the note of the starts passed over goes.
  h.window.percent = 60;
  h.clock.advance(30 * MINUTE);
  await h.fire(h.pending()[0]);
  assert.deepEqual([h.runs(interval.id).length, h.schedule(interval.id)?.note], [1, null]);
  const pause = await h.run('SetRecipeSchedule', { recipeId: interval.id, action: 'pause' });
  assert.equal(pause.outcome, 'applied');

  // A reset schedule with no reading of its window tries again in 15 minutes.
  h.window.resetsAt = h.at(h.clock.now(), 60);
  const reset = await h.save(
    h.recipeOf({ kind: 'reset', family: 'openai' }),
    '.crewkite/recipes/reset.json',
  );
  assert.equal(h.schedule(reset.id)?.nextAt, h.window.resetsAt);
  h.window.percent = null;
  h.clock.advance(60 * MINUTE);
  await h.fire(h.pending()[0]);
  const later = h.schedule(reset.id);
  assert.deepEqual(
    [h.runs(reset.id).length, later?.state, later?.note?.code, later?.nextAt],
    [0, 'active', 'allowance-unknown', h.at(h.clock.now(), 15)],
  );
  assert.equal(
    (await h.run('SetRecipeSchedule', { recipeId: reset.id, action: 'pause' })).outcome,
    'applied',
  );

  // A once schedule that cannot read its allowance stops and says why.
  const once = await h.save(
    h.recipeOf({ kind: 'once', at: h.at(h.clock.now(), 10) }),
    '.crewkite/recipes/once.json',
  );
  h.clock.advance(10 * MINUTE);
  await h.fire(h.pending()[0]);
  const ended = h.schedule(once.id);
  assert.deepEqual(
    [h.runs(once.id).length, ended?.state, ended?.note?.code, ended?.nextAt, h.pending().length],
    [0, 'stopped', 'allowance-unknown', null, 0],
  );
  await h.quiet();
  assert.deepEqual(
    h.posts.map(({ event, text }) => ({ event, text })),
    [{ event: 'stopped', text: unknown }],
  );
  // Its time has passed, so restart refuses and changes nothing.
  assert.deepEqual(await h.run('SetRecipeSchedule', { recipeId: once.id, action: 'restart' }), {
    outcome: 'blocked',
    reason: 'schedule-time-passed',
    next: "This loop's time has passed. Save the recipe with a new time, then restart it.",
  });
  assert.deepEqual(h.schedule(once.id), ended);

  // No reset time is reported. The schedule has no next start, says why, and only reads again.
  h.window.percent = 60;
  h.window.resetsAt = null;
  const looks = await h.save(
    h.recipeOf({ kind: 'reset', family: 'openai' }),
    '.crewkite/recipes/looks.json',
  );
  const waiting = () => {
    const schedule = h.schedule(looks.id);
    return [h.runs(looks.id).length, schedule?.state, schedule?.nextAt, schedule?.note?.code];
  };
  assert.deepEqual(waiting(), [0, 'active', null, 'reset-unknown']);
  assert.equal(
    h.schedule(looks.id)?.note && planScheduleLine(h.schedule(looks.id)?.note as PlanScheduleNote),
    'Waiting. OpenAI has not reported when its allowance resets.',
  );
  const before = h.reads();
  for (let look = 0; look < 16; look++) {
    assert.deepEqual(
      h.pending().map((timer) => timer.ms),
      [15 * MINUTE],
    );
    h.clock.advance(15 * MINUTE);
    await h.fire(h.pending()[0]);
    assert.deepEqual(waiting(), [0, 'active', null, 'reset-unknown']);
  }
  assert.equal(h.reads() - before, 16);
  // A reading reports a reset. That is the next start, and the run starts there, once.
  h.window.resetsAt = h.at(h.clock.now(), 30);
  h.clock.advance(15 * MINUTE);
  await h.fire(h.pending()[0]);
  assert.deepEqual(waiting(), [0, 'active', h.window.resetsAt, undefined]);
  h.clock.advance(15 * MINUTE);
  // At the start the reading reports the same reset five minutes late, as a relative reading
  // can. That reset was just used, so it is no next start.
  h.window.resetsAt = h.at(h.clock.now(), 5);
  await h.fire(h.pending()[0]);
  await h.when(() => h.runs(looks.id)[0]?.state === 'failed');
  await h.quiet();
  assert.deepEqual(waiting(), [1, 'active', null, 'reset-unknown']);
  // The next look still reads that reset, now passed. It starts nothing and keeps waiting.
  h.clock.advance(15 * MINUTE);
  await h.fire(h.pending()[0]);
  assert.deepEqual(waiting(), [1, 'active', null, 'reset-unknown']);
  // A save that finds a reset ahead clears the note that said the schedule waited for one.
  h.window.resetsAt = h.at(h.clock.now(), 300);
  await h.save(
    h.recipeOf({ kind: 'reset', family: 'openai' }, { description: 'Again.' }),
    '.crewkite/recipes/looks.json',
    1,
    looks.id,
  );
  assert.deepEqual(waiting(), [1, 'active', h.window.resetsAt, undefined]);
  // Paused and resumed with no reset known, it waits again.
  h.window.resetsAt = null;
  for (const action of ['pause', 'resume'])
    assert.equal(
      (await h.run('SetRecipeSchedule', { recipeId: looks.id, action })).outcome,
      'applied',
    );
  assert.deepEqual(waiting(), [1, 'active', null, 'reset-unknown']);
  // The first client after a time with none looks at once and finds the next reset.
  h.controller().clientsChanged(0);
  h.window.resetsAt = h.at(h.clock.now(), 240);
  h.controller().clientsChanged(1);
  await h.quiet();
  assert.deepEqual(waiting(), [1, 'active', h.window.resetsAt, undefined]);
});

// Claim: a run that changed nothing and found nothing counts toward the dry limit, a failed run
// leaves the count where it was, and the second dry run in a row stops the schedule and posts it.
// Restart arms it again with its counts at zero. By the rule alone: a report that kept no finding
// is dry, one with no count is not, a run that found something is not, and a run by hand never
// moves the count.
test('a schedule stops after two dry runs, and a failed run does not count', {
  timeout: 60000,
}, async (t) => {
  const h = await open(t, [nothing, fails, nothing]);
  const record = await h.save(
    h.recipeOf(
      { kind: 'interval', everyMinutes: 30 },
      { budget: { maxRuns: 10, maxUsedPercent: { openai: 80 }, maxWaiting: 3 } },
    ),
  );
  h.controller().clientsChanged(1);
  const counts: [string, number, string][] = [];
  for (const ending of ['no-change', 'failed', 'no-change']) {
    h.clock.advance(30 * MINUTE);
    await h.fire(h.pending()[0]);
    const index = counts.length;
    await h.when(() => h.runs(record.id)[index]?.state === ending);
    await h.quiet();
    const schedule = h.schedule(record.id);
    counts.push([ending, schedule?.dryRuns ?? -1, schedule?.state ?? '']);
  }
  assert.deepEqual(counts, [
    ['no-change', 1, 'active'],
    ['failed', 1, 'active'],
    ['no-change', 2, 'stopped'],
  ]);
  assert.deepEqual(
    [h.schedule(record.id)?.note?.code, h.schedule(record.id)?.nextAt, h.pending().length],
    ['dry-runs', null, 0],
  );
  await h.quiet();
  assert.deepEqual(
    h.posts.map(({ event, text }) => ({ event, text })),
    [{ event: 'stopped', text: 'Stopped. Two runs in a row changed nothing and found nothing.' }],
  );
  const stoppedAt = h.schedule(record.id) as PlanScheduleRecord;
  assert.equal(
    (await h.run('SetRecipeSchedule', { recipeId: record.id, action: 'restart' })).outcome,
    'applied',
  );
  const again = h.schedule(record.id);
  assert.deepEqual(
    [again?.state, again?.runsStarted, again?.dryRuns, again?.note, h.pending().length],
    ['active', 0, 0, null, 1],
  );

  // The dry count at a run's first end, by how the run ended, from the count before it.
  const ran = h.runs(record.id)[0];
  const DRY: [string, Partial<PlanRecipeRun>, number, [number, string]][] = [
    ['changed nothing with no count', { state: 'no-change', findings: null }, 0, [1, 'active']],
    ['changed nothing but found something', { state: 'no-change', findings: 1 }, 1, [0, 'active']],
    ['a report that kept no finding', { state: 'reported', findings: 0 }, 0, [1, 'active']],
    ['a second report that kept no finding', { state: 'reported', findings: 0 }, 1, [2, 'stopped']],
    ['a report with no count', { state: 'reported', findings: null }, 1, [0, 'active']],
    ['ready for Accept', { state: 'ready', findings: 0, changedFiles: 1 }, 1, [0, 'active']],
    ['stopped', { state: 'stopped' }, 1, [1, 'active']],
    ['a run by hand', { state: 'no-change', findings: 0, origin: 'manual' }, 1, [1, 'active']],
    ['a second dry run while paused', { state: 'no-change', findings: 0 }, 1, [2, 'stopped']],
  ];
  for (const [name, change, dryRuns, expected] of DRY) {
    const before = { ...ran, ...change, endedAt: null };
    const next = { ...before, endedAt: h.clock.now() };
    const paused = name.endsWith('while paused');
    const after = settleRun(
      {
        ...stoppedAt,
        state: paused ? 'paused' : 'active',
        note: paused ? { code: 'by-person', at: h.clock.now() } : null,
        dryRuns,
      },
      next,
      before,
      { waiting: 0, newest: next },
      { trigger: { kind: 'interval', everyMinutes: 30 }, budget: { maxWaiting: 3 } },
      h.clock.now(),
      null,
    );
    assert.deepEqual([after.dryRuns, after.state], expected, name);
  }
});

// Claim: a start that comes due with no client attached starts nothing and arms nothing. After a
// restart, nothing starts until a client attaches, and then exactly one catch-up run starts and
// the other missed starts are logged as one note. A single missed start logs nothing and leaves
// no note. A schedule row that does not read is left out of every pass, each of its failures is
// logged once, a client still attaches, a schedule action on it refuses with a sentence, and a
// save arms a fresh schedule over it.
test('a restart makes one catch-up start and logs the rest, and no client means no start', {
  timeout: 60000,
}, async (t) => {
  const h = await open(t, [fails, fails]);
  const armed = h.clock.now();
  const record = await h.save(h.recipeOf({ kind: 'interval', everyMinutes: 30 }));
  h.clock.advance(30 * MINUTE);
  await h.fire(h.pending()[0]);
  assert.deepEqual(
    [h.runs(record.id).length, h.schedule(record.id)?.nextAt, h.pending().length, h.reads()],
    [0, h.at(armed, 30), 0, 0],
  );

  // Closed for two more hours: five starts came due.
  h.clock.advance(120 * MINUTE);
  const controller = await h.restart();
  await h.quiet();
  assert.deepEqual([h.runs(record.id).length, h.pending().length], [0, 0]);
  controller.clientsChanged(1);
  await h.quiet();
  await h.when(() => h.runs(record.id)[0]?.state === 'failed');
  const caught = h.schedule(record.id);
  assert.deepEqual(
    [h.runs(record.id).length, caught?.note, caught?.nextAt],
    [1, { code: 'missed', at: h.at(armed, 150), runs: 4 }, h.at(armed, 180)],
  );

  // One start missed while the client was away is the catch-up itself, with nothing logged.
  controller.clientsChanged(0);
  h.clock.advance(30 * MINUTE);
  await h.fire(h.pending()[0]);
  assert.equal(h.runs(record.id).length, 1);
  h.clock.advance(5 * MINUTE);
  controller.clientsChanged(1);
  await h.quiet();
  await h.when(() => h.runs(record.id)[1]?.state === 'failed');
  assert.deepEqual(
    [h.runs(record.id).length, h.schedule(record.id)?.note, h.schedule(record.id)?.nextAt],
    [2, null, h.at(armed, 210)],
  );

  const broken = await h.save(
    h.recipeOf({ kind: 'interval', everyMinutes: 30 }),
    '.crewkite/recipes/broken.json',
  );
  controller.store.db
    .prepare("UPDATE recipe_schedules SET body=json_set(body,'$.dryRuns',3) WHERE recipe_id=?")
    .run(broken.id);
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const timer = h.pending().at(-1);
  try {
    controller.clientsChanged(0);
    controller.clientsChanged(1);
    for (const _read of [1, 2]) {
      const listed = await h.run('ReadSchedules', {});
      assert(listed.data?.kind === 'schedules', JSON.stringify(listed));
      assert.deepEqual(
        listed.data.schedules.map(({ schedule }) => schedule.recipeId),
        [record.id],
      );
    }
    // Its timer fails another way, which is logged once more, and only once.
    h.clock.advance(30 * MINUTE);
    await h.fire(timer);
    await h.fire(timer);
    assert.deepEqual(await h.run('SetRecipeSchedule', { recipeId: broken.id, action: 'pause' }), {
      outcome: 'blocked',
      reason: 'schedule-unreadable',
      next: 'That did not go through.',
    });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(new Set(lines.filter((line) => line.includes(broken.id))).size, 2);
  assert.equal(lines.filter((line) => line.includes(broken.id)).length, 2);
  // Saving the recipe again arms a fresh schedule over the row that did not read.
  await h.save(
    h.recipeOf({ kind: 'interval', everyMinutes: 30 }, { description: 'Again.' }),
    '.crewkite/recipes/broken.json',
    1,
    broken.id,
  );
  assert.deepEqual(
    [
      h.schedule(broken.id)?.state,
      h.schedule(broken.id)?.runsStarted,
      h.schedule(broken.id)?.dryRuns,
    ],
    ['active', 0, 0],
  );
  await controller.close();
});

// Claim: saving a recipe with a trigger arms one timer and shows the schedule where the Recipes
// page and the Schedules view read it. A file edited on disk pauses the schedule at its next
// start, starts nothing and refuses Resume, even once the file reads as the saved version again.
// Saving the file's version lifts the pause, keeps the grid and leaves one timer. Forgetting the
// recipe cancels the timer, and a late callback for it starts nothing. A save while a start reads
// the usage passes that start over, so no run takes work from a version that no longer runs. A
// checklist start passes over the items runs hold, also one taken while the usage was read. A
// start the controller refuses for its own reason pauses the schedule with that sentence, and
// Resume lifts it. With checklist work off, a loop armed while it was on starts nothing and pauses.
test('saving arms, a file change pauses, saving again lifts the pause, and forgetting cancels the timer', {
  timeout: 60000,
}, async (t) => {
  const h = await open(t, [fails]);
  const armed = h.clock.now();
  const body = h.recipeOf({ kind: 'interval', everyMinutes: 30 });
  const record = await h.save(body);
  assert.equal(h.pending().length, 1);
  const read = await h.run('ReadRecipe', { projectId: h.projectId, recipeId: record.id });
  assert(read.data?.kind === 'recipe');
  assert.deepEqual(read.data.approved, []);
  assert.equal(read.data.entry.schedule?.state, 'active');
  assert.equal('approved' in (read.data.entry.schedule ?? {}), false);
  const listed = await h.run('ReadSchedules', {});
  assert(listed.data?.kind === 'schedules');
  assert.deepEqual(
    listed.data.schedules.map(({ name, path, trigger, schedule }) => [
      name,
      path,
      trigger,
      schedule.nextAt,
    ]),
    [['Tidy', '.crewkite/recipes/tidy.json', body.trigger, h.at(armed, 30)]],
  );
  assert.equal(listed.data.more, 0);

  // Someone edits the file. The next start pauses the schedule and starts nothing.
  const file = join(h.source.directory, '.crewkite/recipes/tidy.json');
  const edited = { ...body, description: 'Edited by hand.' };
  writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
  h.controller().clientsChanged(1);
  h.clock.advance(30 * MINUTE);
  await h.fire(h.pending()[0]);
  const paused = h.schedule(record.id);
  assert.deepEqual(
    [paused?.state, paused?.note?.code, h.runs(record.id).length, h.reads(), h.pending().length],
    ['paused', 'recipe-changed', 0, 0, 0],
  );
  assert.deepEqual(await h.run('SetRecipeSchedule', { recipeId: record.id, action: 'resume' }), {
    outcome: 'blocked',
    reason: 'recipe-file-changed',
    next: 'The recipe file changed on disk. Review it and save, then try again.',
  });
  await h.quiet();
  assert.deepEqual(
    h.posts.map(({ event, text }) => ({ event, text })),
    [
      {
        event: 'paused',
        text: 'Paused. The recipe file changed on disk. Review it and save to continue.',
      },
    ],
  );

  // The file back as it was saved still leaves the pause to a save.
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  assert.equal(
    (await h.run('SetRecipeSchedule', { recipeId: record.id, action: 'resume' })).reason,
    'recipe-file-changed',
  );

  // Saving the file's version lifts the pause on the same grid, with one timer.
  h.clock.advance(10 * MINUTE);
  await h.save(edited, '.crewkite/recipes/tidy.json', 1, record.id);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), edited);
  const lifted = h.schedule(record.id);
  assert.deepEqual(
    [lifted?.state, lifted?.note, lifted?.version, lifted?.armedAt, lifted?.nextAt],
    ['active', null, 2, armed, h.at(armed, 60)],
  );
  assert.deepEqual(
    h.pending().map((timer) => timer.ms),
    [20 * MINUTE],
  );

  // A new trigger starts a new grid. Still one timer.
  await h.save(
    { ...edited, trigger: { kind: 'interval', everyMinutes: 60 } },
    '.crewkite/recipes/tidy.json',
    2,
    record.id,
  );
  assert.deepEqual(
    [h.schedule(record.id)?.armedAt, h.pending().map((timer) => timer.ms)],
    [h.clock.now(), [60 * MINUTE]],
  );

  const timer = h.pending()[0];
  const forgot = await h.run('ForgetRecipe', { recipeId: record.id, confirm: 'explicit' });
  assert.equal(forgot.outcome, 'applied');
  await h.quiet();
  assert.deepEqual(
    [timer.cancelled, h.schedule(record.id), h.pending().length],
    [true, undefined, 0],
  );
  h.clock.advance(60 * MINUTE);
  await h.fire(timer);
  assert.equal(h.runs(record.id).length, 0);

  // Two checklists in the project's HEAD.
  const lists = {
    'TODO.md': ['first item', 'second item', 'third item'],
    'OTHER.md': ['other item'],
  };
  for (const [path, items] of Object.entries(lists))
    writeFileSync(join(h.source.directory, path), items.map((item) => `- [ ] ${item}\n`).join(''));
  git(h.source.directory, ['add', '--', ...Object.keys(lists)]);
  git(
    h.source.directory,
    ['commit', '-q', '--only', '-m', 'test: lists', '--', ...Object.keys(lists)],
    undefined,
    { name: 'Fixture owner', email: 'owner@example.invalid', at: h.clock.now() },
  );
  const checklist = h.recipeOf(
    { kind: 'interval', everyMinutes: 30 },
    { work: { kind: 'checklist', path: 'TODO.md' } },
  );
  const todo = await h.save(checklist, '.crewkite/recipes/todo.json');
  const starts = h.clock.now();
  const holding = (item: string) =>
    h.putRun({
      id: `rrn_${h.id('msg').slice(4)}`,
      recipeId: todo.id,
      projectId: h.projectId,
      taskId: h.id('tsk'),
      version: 1,
      versionHash: todo.versionHash,
      origin: 'schedule',
      item,
      state: 'accepted',
      findings: null,
      changedFiles: 1,
      reason: null,
      startedAt: h.clock.now(),
      endedAt: h.clock.now(),
      allowance: { start: [], end: null },
    });
  // An accepted run still holds its item, since Accept leaves the item unchecked at HEAD.
  holding('first item');
  // A save lands while the start reads the usage: that start is passed over.
  h.clock.advance(30 * MINUTE);
  let release = h.gate();
  await h.fire(h.pending()[0]);
  await h.save(
    { ...checklist, work: { kind: 'checklist', path: 'OTHER.md' } },
    '.crewkite/recipes/todo.json',
    1,
    todo.id,
  );
  release();
  await h.quiet();
  const passed = h.schedule(todo.id);
  assert.deepEqual(
    [h.runs(todo.id).length, passed?.version, passed?.note, passed?.nextAt],
    [1, 2, null, h.at(starts, 60)],
  );
  await h.save(checklist, '.crewkite/recipes/todo.json', 2, todo.id);
  // The item the read found is taken by a run while the usage is read: held, nothing starts.
  h.clock.advance(30 * MINUTE);
  release = h.gate();
  await h.fire(h.pending()[0]);
  holding('second item');
  release();
  await h.quiet();
  assert.deepEqual([h.runs(todo.id).length, h.schedule(todo.id)?.nextAt], [2, h.at(starts, 90)]);
  // The next start takes the first item no run holds.
  h.clock.advance(30 * MINUTE);
  await h.fire(h.pending()[0]);
  await h.when(() => h.runs(todo.id)[2]?.state === 'failed');
  const took = h.runs(todo.id)[2];
  assert.deepEqual(
    [took.origin, took.item, h.controller().store.get<Task>('task', took.taskId)?.outcome],
    [
      'schedule',
      'third item',
      'Do this item from TODO.md:\n\nthird item\n\nTick it in TODO.md as part of the change.',
    ],
  );
  // The schedules read says whether the last run's thread is still there.
  const thread = async () => {
    const listed = await h.run('ReadSchedules', {});
    assert(listed.data?.kind === 'schedules');
    return listed.data.schedules.find(({ schedule }) => schedule.recipeId === todo.id)?.schedule
      .lastRun?.thread;
  };
  assert.equal(await thread(), true);
  const deleted = await h.run(
    'DeleteChatThread',
    { taskId: took.taskId },
    h.controller().store.get<Task>('task', took.taskId)?.revision ?? 0,
  );
  assert.equal(deleted.outcome, 'applied', JSON.stringify(deleted));
  assert.equal(await thread(), false);

  // A start the controller refuses for a reason no other note names pauses with its sentence.
  assert.equal(
    (await h.run('SetRecipeSchedule', { recipeId: todo.id, action: 'pause' })).outcome,
    'applied',
  );
  const refused = await h.save(
    h.recipeOf({ kind: 'once', at: h.at(h.clock.now(), 10) }),
    '.crewkite/recipes/refused.json',
  );
  h.window.creditsOut = true;
  h.clock.advance(10 * MINUTE);
  await h.fire(h.pending()[0]);
  const sentence =
    'OpenAI is out of included allowance and credit spending is off. Turn credit spending on in Settings or pick another provider.';
  const paused2 = h.schedule(refused.id);
  assert.deepEqual(
    [h.runs(refused.id).length, paused2?.state, paused2?.note?.code, paused2?.nextAt],
    [0, 'paused', 'start-refused', null],
  );
  assert.equal(
    paused2?.note && planScheduleLine(paused2.note),
    `Paused. The run could not start. ${sentence}`,
  );
  await h.quiet();
  assert.deepEqual(h.posts.at(-1), {
    event: 'paused',
    schedule: 'Tidy',
    at: h.clock.now(),
    text: `Paused. The run could not start. ${sentence}`.slice(0, 300),
  });
  // A once schedule whose time has passed is not resumed: it would start at once.
  const onceRefused = h.schedule(refused.id);
  assert.deepEqual(await h.run('SetRecipeSchedule', { recipeId: refused.id, action: 'resume' }), {
    outcome: 'blocked',
    reason: 'schedule-time-passed',
    next: "This loop's time has passed. Save the recipe with a new time, then restart it.",
  });
  assert.deepEqual(h.schedule(refused.id), onceRefused);
  // An interval refused the same way pauses too, and Resume lifts it.
  const again = await h.save(
    h.recipeOf({ kind: 'interval', everyMinutes: 30 }),
    '.crewkite/recipes/refused-again.json',
  );
  h.clock.advance(30 * MINUTE);
  await h.fire(h.pending()[0]);
  assert.deepEqual(
    [h.runs(again.id).length, h.schedule(again.id)?.state, h.schedule(again.id)?.note?.code],
    [0, 'paused', 'start-refused'],
  );
  h.window.creditsOut = false;
  assert.equal(
    (await h.run('SetRecipeSchedule', { recipeId: again.id, action: 'resume' })).outcome,
    'applied',
  );
  assert.deepEqual([h.schedule(again.id)?.state, h.schedule(again.id)?.note], ['active', null]);

  // The app keeps checklist work off. A loop armed while it was on starts nothing after that: its
  // start is refused with the save's sentence, and the loop pauses.
  for (const action of ['pause', 'resume'] as const)
    assert.equal(
      (
        await h.run('SetRecipeSchedule', {
          recipeId: action === 'pause' ? again.id : todo.id,
          action,
        })
      ).outcome,
      'applied',
    );
  const ran = h.runs(todo.id).length;
  const off = await h.restart({ checklistWork: false });
  off.clientsChanged(1);
  await h.quiet();
  h.clock.advance(30 * MINUTE);
  for (const timer of h.pending()) await h.fire(timer);
  await h.quiet();
  const kept = h.schedule(todo.id);
  assert.deepEqual(
    [h.runs(todo.id).length, kept?.state, kept?.note?.code],
    [ran, 'paused', 'start-refused'],
  );
  assert.equal(
    kept?.note && planScheduleLine(kept.note),
    'Paused. The run could not start. Checklist work is not available in this version. Give the loop a fixed request.',
  );
});
