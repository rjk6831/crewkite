import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ChatCatalogRead,
  type ChatCrew,
  type ChatTurn,
  type CommandResult,
  type Event,
  type PlanRecipe,
  type PlanRecipeRun,
  type Project,
  ResultsExportSchema,
  type SliceResult,
  type Task,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { type ChatScriptStep, createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import { ChatService } from '../chat/service.ts';
import { RemoteEffects } from '../github/effects.ts';
import { installedTools } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import type { PlanEvent } from './events.ts';
import { ResultRecorder } from './results.ts';
import { RunTracker } from './tracker.ts';

/** The PATH this file started with. Each test narrows it while it runs. */
const PATH = process.env.PATH;
const on = { family: 'openai', model: 'openai-model', effort: 'default' } as const;
const crewOf = (...roles: ChatCrew['members'][number]['role'][]): ChatCrew => ({
  name: 'Run crew',
  members: roles.map((role) => ({ role, selection: on })),
});
const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];
/** A turn that writes each file in its copy, then answers. */
const write = (content: string, text: string, ...paths: string[]): ChatScriptStep[] => [
  ...(paths.length ? paths : ['net.mjs']).map(
    (path, at): ChatScriptStep => ({
      kind: 'tool',
      callId: `w${at}`,
      toolKind: 'edit',
      title: `Write ${path}`,
      write: { path, content },
    }),
  ),
  ...reply(text),
];
const planOf = (count: number, planId = 'p1', readOnly = false) =>
  reply(
    `\`\`\`json plan\n${JSON.stringify({
      planId,
      goal: 'Split it.',
      slices: Array.from({ length: count }, (_, at) => ({
        id: at + 1,
        title: `Part ${at + 1}`,
        brief: `Do part ${at + 1}.`,
        files: [],
        depends: [],
        difficulty: 'medium',
        readOnly,
      })),
    })}\n\`\`\``,
  );
const wait: ChatScriptStep[] = [{ kind: 'wait' }];
const lineIs = (pattern: RegExp) => (event: Event) =>
  event.type === 'conversation.entry' && pattern.test((event.payload as { text: string }).text);
const finished = lineIs(/^Crew finished/);
const spanOf = (turn: ChatTurn) => Date.parse(turn.endedAt as string) - Date.parse(turn.startedAt);

/** A temp home with PATH narrowed to `tools`, removed with the test. */
function home(t: TestContext, ...tools: string[]) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'ck-results-'));
  process.env.PATH = PATH;
  process.env.PATH = installedTools(directory, ...tools);
  t.after(() => {
    process.env.PATH = PATH;
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  return { directory, store };
}

type Setup = {
  openai: ChatScriptStep[][];
  crew: ChatCrew;
  checks?: string[];
  mode?: 'glide' | 'balanced';
  shape?: 'change' | 'report';
};

/**
 * A recipe run on a temp SQLite home, built the way the run tracker's tests build one: one
 * scripted OpenAI adapter, the thread set up and its request sent the way RunRecipe does, and the
 * service's events heard by the run tracker and then the recorder, as the controller wires them.
 * The clock moves a millisecond with every reading. PATH holds git and node alone, so no gh or
 * provider client is ever found. `start` builds another service and recorder on the same store,
 * as a restart does.
 */
function harness(t: TestContext, setup: Setup) {
  const { directory, store } = home(t, 'git', 'node');
  const clock = createTestClock();
  const now = clock.now();
  const tick = () => clock.advance(1);
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
  writeFileSync(join(root, 'gate.mjs'), "console.log('ok');\n");
  git('add', 'gate.mjs');
  git('commit', '-q', '-m', 'Add a check.');
  const project: Project = { id: fixtures.task.projectId, name: 'demo-shop', revision: 0 };
  const task: Task = fixtures.task;
  store.transaction(() => {
    store.put('project', project.id, 0, project);
    store.put('task', task.id, 0, task);
  });
  const taskId = task.id;
  const adapter = createScriptedChatAdapter({ family: 'openai', turns: setup.openai });
  const catalog = (): ChatCatalogRead => ({
    families: [
      {
        family: 'openai',
        connected: true,
        reason: null,
        models: [
          {
            model: 'openai-model',
            label: 'OpenAI',
            efforts: ['default'],
            defaultEffort: 'default',
          },
        ],
        defaultModel: 'openai-model',
        remaining: [],
        accepts: null,
      },
    ],
  });
  const tracker = new RunTracker({
    store,
    now: tick,
    home: directory,
    projectPath: () => root,
    families: () => catalog().families,
    changed: () => {},
  });
  const start = (log?: (line: string) => void) => {
    const recorder = new ResultRecorder({
      store,
      id: () => `srs_${ids('msg').slice(4)}`,
      home: directory,
      projectPath: () => root,
      ...(log ? { log } : {}),
    });
    const chat = new ChatService({
      store,
      artifacts: new ArtifactFiles(join(directory, 'artifacts')),
      home: directory,
      googleTermsAcknowledged: () => true,
      now: tick,
      id: (prefix) => (prefix === 'trn' ? `trn_${ids('msg').slice(4)}` : ids(prefix)),
      emit: (type, id, revision, payload) =>
        store.append({ protocol: 1, id: ids('evt'), at: now, taskId: id, revision, type, payload }),
      adapters: new Map([['openai', adapter]]),
      resolveEnvironment: () => ({}),
      projectPath: () => root,
      resolveSelection: (_taskId, value) => value ?? null,
      catalog,
      remoteEffects: new RemoteEffects({
        store,
        home: directory,
        now: tick,
        id: () => ids('rfx'),
        projectPath: () => root,
      }),
      observe: (event: PlanEvent) => {
        tracker.observe(event);
        recorder.observe(event);
      },
    });
    t.after(() => chat.close());
    return { chat, recorder };
  };
  const { chat, recorder } = start();
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
  const quiet = async () => {
    for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  };

  const recipeId = `rcp_${ids('msg').slice(4)}`;
  const runId = `rrn_${ids('msg').slice(4)}`;
  const versionHash = 'a'.repeat(64);
  const recipe: PlanRecipe = {
    schema: 1,
    name: 'Split work',
    description: '',
    shape: setup.shape ?? 'change',
    crew: setup.crew,
    run: {
      flightMode: setup.mode ?? 'glide',
      permissionPolicy: 'allow-all',
      handoff: { auto: false, mode: 'most-left' },
      maxSlices: 8,
    },
    checks: (setup.checks ?? []).map((command) => ({ command })),
    trigger: { kind: 'manual' },
    budget: null,
    work: null,
  };
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
        request: 'Split the work.',
      },
      effects,
    );
    store.putRecipeRun({
      id: runId,
      recipeId,
      projectId: project.id,
      taskId,
      version: 1,
      versionHash,
      origin: 'manual',
      item: null,
      state: 'running',
      findings: null,
      changedFiles: null,
      reason: null,
      startedAt: now,
      endedAt: null,
      allowance: { start: [], end: null },
    });
    return result;
  });
  assert.equal(started.outcome, 'applied', JSON.stringify(started));
  const turns = () =>
    store.db
      .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence')
      .all(taskId)
      .map((row) => JSON.parse(row.body as string) as ChatTurn);
  const records = () => store.sliceResultsOfTask(taskId);
  return {
    chat,
    recorder,
    start,
    store,
    taskId,
    projectId: project.id,
    recipeId,
    runId,
    versionHash,
    ids,
    act,
    until,
    quiet,
    turns,
    records,
  };
}

// Claim: each step of a plan leaves one record holding the role and model of its first turn, the
// rules that turn received, the first check after the step, the first review of a build or a fix
// and the fix rounds of the build. A check that lands while a step is open, a check of another
// slice, a review that failed and a step of the whole plan take nothing. A review with no count
// reads unknown, every fix that ended counts, an unknown round leaves the time unknown, and the
// rules stay the first round's.
test('a plan leaves one record per step, with who ran it and what the first check and the first review said', {
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
  await h.until(finished);
  await h.quiet();
  const [plan, build, review, fix, second, challenge] = h.turns();
  const rules = build.rules?.digest;
  assert.ok(rules);
  const records = h.records();
  assert.equal(new Set(records.map((record) => record.id)).size, records.length);
  for (const record of records) assert.ok(record.endedAt && record.endedAt >= record.startedAt);
  const base = {
    projectId: h.projectId,
    taskId: h.taskId,
    anchorTurnId: build.id,
    recipeId: h.recipeId,
    recipeHash: h.versionHash,
    runId: h.runId,
    slice: 1,
    family: 'openai',
    model: 'openai-model',
    effort: 'default',
    rulesDigest: null,
    designVersionHash: null,
    firstGate: 'passed',
    firstReview: 'none',
    findings: null,
    fixRounds: null,
    final: 'waiting',
    allowanceUsed: null,
    allowanceWindow: null,
  };
  assert.deepEqual(
    records.map(({ id: _id, startedAt: _started, endedAt: _ended, ...record }) => record),
    [
      {
        ...base,
        step: 'build',
        role: 'builder',
        rulesDigest: rules,
        firstReview: 'findings',
        findings: 1,
        fixRounds: 1,
        durationMs: spanOf(build),
      },
      // Two review rounds, one record. Its first check is the one after the fix.
      { ...base, step: 'review', role: 'reviewer', durationMs: spanOf(review) + spanOf(second) },
      {
        ...base,
        step: 'fix',
        role: 'fixer',
        rulesDigest: fix.rules?.digest,
        firstReview: 'clean',
        findings: 0,
        durationMs: spanOf(fix),
      },
      {
        ...base,
        step: 'merge',
        role: null,
        family: null,
        model: null,
        effort: null,
        durationMs: null,
      },
      // A step of the whole plan has no slice of its own to check.
      {
        ...base,
        step: 'challenge',
        slice: null,
        anchorTurnId: plan.id,
        role: 'challenger',
        firstGate: 'none',
        durationMs: spanOf(challenge),
      },
    ],
  );

  // The same rules on a second slice of the thread, step by step.
  const anchor = `trn_${h.ids('msg').slice(4)}`;
  let minute = 0;
  const at = () =>
    new Date(Date.parse('2026-11-18T10:00:00.000Z') + minute++ * 60_000).toISOString();
  const step = (name: SliceResult['step'], role: SliceResult['role']) => ({
    taskId: h.taskId,
    slice: 2,
    step: name,
    turnId: `trn_${h.ids('msg').slice(4)}`,
    anchorTurnId: anchor,
    role,
    family: 'openai',
    model: 'openai-model',
    effort: 'default',
  });
  const round = (
    name: SliceResult['step'],
    role: SliceResult['role'],
    end: {
      outcome?: 'done' | 'failed';
      durationMs?: number | null;
      findings?: number | null;
      rules?: string;
    },
    between?: () => void,
  ) => {
    const opened = step(name, role);
    h.recorder.observe({ ...opened, kind: 'step-started', at: at() } as PlanEvent);
    between?.();
    h.recorder.observe({
      ...opened,
      kind: 'step-ended',
      at: at(),
      rulesDigest: end.rules ?? null,
      designVersionHash: null,
      outcome: end.outcome ?? 'done',
      durationMs: end.durationMs === undefined ? 1000 : end.durationMs,
      findings: end.findings ?? null,
    } as PlanEvent);
  };
  const gate = (anchorTurnId: string, result: 'passed' | 'failed', slice: number | null = 2) =>
    h.recorder.observe({
      kind: 'gate',
      taskId: h.taskId,
      at: at(),
      slice,
      anchorTurnId,
      trigger: 'after-write',
      result,
    });
  round('build', 'builder', { rules: 'b'.repeat(64) }, () => gate(anchor, 'failed'));
  gate(build.id, 'failed', 1);
  gate(anchor, 'passed');
  round('review', 'reviewer', { outcome: 'failed', findings: 2 });
  round('review', 'reviewer', { findings: null });
  round('fix', 'fixer', { outcome: 'failed', rules: 'c'.repeat(64) });
  round('fix', 'fixer', { durationMs: null, rules: 'd'.repeat(64) });
  const planStep = `trn_${h.ids('msg').slice(4)}`;
  const challenged = { ...step('challenge', 'challenger'), slice: null, anchorTurnId: planStep };
  h.recorder.observe({ ...challenged, kind: 'step-started', at: at() } as PlanEvent);
  h.recorder.observe({
    ...challenged,
    kind: 'step-ended',
    at: at(),
    rulesDigest: null,
    designVersionHash: null,
    outcome: 'done',
    durationMs: 1000,
    findings: null,
  } as PlanEvent);
  gate(planStep, 'failed', null);
  const second2 = (name: string) =>
    h.records().find((record) => record.anchorTurnId === anchor && record.step === name);
  const pick = (record: SliceResult | undefined) =>
    record && [
      record.firstGate,
      record.firstReview,
      record.findings,
      record.fixRounds,
      record.rulesDigest,
      record.durationMs,
    ];
  assert.deepEqual(
    [pick(second2('build')), pick(second2('fix'))],
    [
      ['passed', 'unknown', null, 2, 'b'.repeat(64), 1000],
      ['none', 'none', null, null, 'c'.repeat(64), null],
    ],
  );
  assert.equal(h.records().find((record) => record.anchorTurnId === planStep)?.firstGate, 'none');
  // The first slice's records kept what they had.
  assert.deepEqual(
    h
      .records()
      .filter((record) => record.anchorTurnId === build.id)
      .map((record) => record.firstGate),
    ['passed', 'passed', 'passed', 'passed'],
  );
});

// Claim: a record reads waiting once its plan ends with changes in the thread's copy, and moves
// once to what the person decided: accepted on Accept, discarded once a discard leaves nothing or
// on a delete. A discard that leaves a change moves nothing. A paused plan's records move the
// same way from unknown. An emptied copy while the plan works settles the slices it shows done,
// and the rest wait for its end. A plan with no change leaves nothing to decide, and a decided
// record never moves again.
test("a record's final state moves once, from waiting to what the person decided", {
  timeout: 180000,
}, async (t) => {
  type H = ReturnType<typeof harness>;
  type Row = {
    name: string;
    openai: ChatScriptStep[][];
    mode?: 'balanced';
    begin?: (h: H) => Promise<void>;
    /** What the records read before the person does anything. */
    before: string;
    steps: [string, (h: H) => void, string][];
    /** The steps on record, when the plan is cut short of its merge. */
    records?: string[];
  };
  const finals = (h: H) => [...new Set(h.records().map((record) => record.final))].join();
  const accept = (h: H, branch: string) =>
    h.act((effects) =>
      h.chat.accept(
        { taskId: h.taskId, branch },
        { name: 'Fixture', email: 'fixture@example.invalid' },
        effects,
      ),
    );
  const discard = (path: string) => (h: H) => {
    const result = h.act(() => h.chat.discardChange({ taskId: h.taskId, path }));
    assert.equal(result.outcome, 'applied', JSON.stringify(result));
  };
  const remove = (h: H) => {
    h.act((effects) => h.chat.deleteThread({ taskId: h.taskId }, effects));
  };
  const pause = async (h: H) => {
    await h.until(
      (event) =>
        event.type === 'chat.turn' &&
        event.payload.role === 'orchestrator' &&
        event.payload.state === 'done',
    );
    await h.quiet();
    const paused = h.until(lineIs(/^Plan paused/));
    h.act((effects) => h.chat.runPlan({ taskId: h.taskId, planId: 'p1', sliceId: 1 }, effects));
    await paused;
  };
  const changed = [planOf(1), write('export const net = 1;\n', 'Built.')];
  /** An emptied copy as the service reports it, heard while the build is still at work. */
  const emptied = (h: H) =>
    h.recorder.observe({
      kind: 'changes-discarded',
      taskId: h.taskId,
      at: new Date().toISOString(),
    });
  const rows: Row[] = [
    {
      name: 'Accept, then a second Accept and a delete',
      openai: changed,
      before: 'waiting',
      steps: [
        [
          'Accept',
          (h) => assert.equal(accept(h, 'feat/split-work').outcome, 'applied'),
          'accepted',
        ],
        ['a second Accept', (h) => accept(h, 'feat/split-work-again'), 'accepted'],
        ['a delete', remove, 'accepted'],
      ],
    },
    {
      name: 'a change in two files, discarded one at a time',
      openai: [planOf(1), write('export const net = 1;\n', 'Built.', 'net.mjs', 'other.mjs')],
      before: 'waiting',
      steps: [
        ['the first discard', discard('net.mjs'), 'waiting'],
        ['the second discard', discard('other.mjs'), 'discarded'],
        [
          'an Accept heard after it',
          (h) =>
            h.recorder.observe({
              kind: 'accepted',
              taskId: h.taskId,
              at: new Date().toISOString(),
            }),
          'discarded',
        ],
      ],
    },
    {
      name: 'a delete',
      openai: changed,
      before: 'waiting',
      steps: [['a delete', remove, 'discarded']],
    },
    {
      name: 'a plan with no change',
      openai: [planOf(1), reply('Nothing needs to change.')],
      before: 'none',
      steps: [
        [
          'an Accept heard',
          (h) =>
            h.recorder.observe({
              kind: 'accepted',
              taskId: h.taskId,
              at: new Date().toISOString(),
            }),
          'none',
        ],
        ['a delete', remove, 'none'],
      ],
    },
    {
      name: 'a paused plan, accepted',
      openai: [planOf(2), write('export const net = 1;\n', 'Built.')],
      mode: 'balanced',
      begin: pause,
      before: 'unknown',
      steps: [
        [
          'Accept',
          (h) => assert.equal(accept(h, 'feat/split-work').outcome, 'applied'),
          'accepted',
        ],
      ],
    },
    {
      name: 'a paused plan, its copy emptied',
      openai: [planOf(2), write('export const net = 1;\n', 'Built.')],
      mode: 'balanced',
      begin: pause,
      before: 'unknown',
      steps: [['the discard of its one change', discard('net.mjs'), 'discarded']],
    },
    {
      name: 'a plan at work whose copy holds no change',
      openai: [planOf(1), wait],
      begin: async (h) => {
        await h.until(
          (event) =>
            event.type === 'chat.turn' &&
            event.payload.role === 'assistant' &&
            event.payload.state === 'running',
        );
      },
      before: 'unknown',
      steps: [['an emptied copy', emptied, 'unknown']],
      records: ['build'],
    },
    {
      name: 'a plan at work with one slice done and one at work, its copy emptied',
      openai: [planOf(2), reply('Nothing needs to change.'), wait],
      begin: async (h) => {
        await h.until(
          (event) =>
            event.type === 'chat.turn' &&
            event.payload.role === 'assistant' &&
            event.payload.state === 'running' &&
            h.records().filter((record) => record.step === 'build').length === 2,
        );
      },
      before: 'unknown',
      // The done slice's build and merge settle. The slice at work waits for the plan's end.
      steps: [['an emptied copy', emptied, 'discarded,unknown']],
      records: ['build', 'merge', 'build'],
    },
    {
      name: 'a paused plan, deleted',
      openai: [planOf(2), write('export const net = 1;\n', 'Built.')],
      mode: 'balanced',
      begin: pause,
      before: 'unknown',
      steps: [['a delete', remove, 'discarded']],
    },
  ];
  for (const row of rows) {
    const h = harness(t, {
      crew: crewOf('orchestrator', 'builder'),
      openai: row.openai,
      mode: row.mode,
    });
    if (row.begin) await row.begin(h);
    else await h.until(finished);
    await h.quiet();
    const seen = [finals(h)];
    for (const [, act] of row.steps) {
      act(h);
      seen.push(finals(h));
    }
    assert.deepEqual(seen, [row.before, ...row.steps.map(([, , expect]) => expect)], row.name);
    assert.deepEqual(
      h.records().map((record) => record.step),
      row.records ?? ['build', 'merge'],
      row.name,
    );
  }
});

/**
 * A store with two projects, one thread each, and an OpenAI and a Local route whose readings the
 * journal holds.
 */
function journalHome(t: TestContext) {
  const { store } = home(t);
  const fixtures = createDemoFixtures();
  // Seeded past the fixtures' own IDs, so no ID repeats one of theirs.
  const ids = createTestIds(undefined, 1000n);
  const as = (prefix: string) => `${prefix}_${ids('msg').slice(4)}`;
  const task = fixtures.task;
  const other: Task = { ...task, id: ids('tsk'), projectId: as('prj') };
  const routes = { openai: as('rte'), anthropic: as('rte'), local: as('rte') };
  store.transaction(() => {
    for (const id of [task.projectId, other.projectId])
      store.put('project', id, 0, { id, name: 'demo-shop', revision: 0 });
    store.put('task', task.id, 0, task);
    store.put('task', other.id, 0, other);
    for (const [family, id] of Object.entries(routes)) store.put('route', id, 0, { id, family });
  });
  const base = Date.parse('2026-11-18T10:00:00.000Z');
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
  const resets = at(6000);
  /** One reading of a window, journaled the moment it was observed. */
  const reading = (
    minutes: number,
    windowId: string,
    value: number,
    resetsAt: string | null = resets,
    family: keyof typeof routes = 'openai',
  ) =>
    store.transaction(() =>
      store.append({
        protocol: 1,
        id: ids('evt'),
        at: at(minutes),
        taskId: null,
        revision: 0,
        type: 'usage.observed',
        payload: {
          routeId: routes[family],
          windowId,
          kind: 'rolling',
          semantics: { scope: 'provider' },
          remaining: { value, unit: 'percent' },
          resetsAt,
          observedAt: at(minutes),
          source: 'provider',
          confidence: 'reported',
        },
      } as never),
    );
  /** A chat turn's row, which the overlap rule reads. */
  const turnRow = (
    taskId: string,
    family: string,
    from: number,
    to: number | null,
    id = as('trn'),
    extra: object = {},
  ) => {
    store.db.prepare('INSERT INTO chat_turns(id,task_id,sequence,body) VALUES (?,?,?,?)').run(
      id,
      taskId,
      Number(
        store.db.prepare('SELECT coalesce(max(sequence), -1) + 1 AS n FROM chat_turns').get()?.n,
      ),
      JSON.stringify({
        selection: { family },
        startedAt: at(from),
        endedAt: to === null ? null : at(to),
        ...extra,
      }),
    );
    return id;
  };
  /** Another thread in the other project, for turns a row places around its readings. */
  const newTask = () => {
    const value: Task = { ...task, id: ids('tsk'), projectId: other.projectId };
    store.transaction(() => store.put('task', value.id, 0, value));
    return value;
  };
  return { store, ids, as, task, other, at, reading, turnRow, newTask };
}

// Claim: a step's allowance is written once, when the step can have no more rounds and each of
// its turns stood between the reading just before it and the first reading of the same window ID
// after it, read from the usage journal after the step's transaction, the way readings arrive. A
// reading that comes past the limit, a reset or a rise between the two, no reset time on either,
// any other chat turn on the provider that started before the closing reading and had not ended
// by the opening one, in this thread or any project, whatever the order of their IDs, a thread
// deleted after the opening reading, a recorder built after it, a round on another window ID, a
// turn whose end never committed, a turn on an assigned connection and a restart with a turn
// waiting leave the step with none, for good. Local is never read.
test('allowance is stored only where a reading stood on both sides', (t) => {
  const j = journalHome(t);
  // Each recorder starts before the first reading of its row.
  let clock = -60;
  const recorderAt = () =>
    new ResultRecorder({
      store: j.store,
      id: () => j.as('srs'),
      home: '/nowhere',
      projectPath: () => undefined,
      // The clock moves a millisecond with every reading, from wherever the row has got to.
      now: () => {
        clock += 1 / 60_000;
        return j.at(clock);
      },
    });
  type Read = [minute: number, windowId: string, value: number, resetsAt?: string | null];
  type Family = 'openai' | 'anthropic' | 'local';
  /**
   * One turn from `from` to `from + 5`. `before` is journaled ahead of it, `after` once its end
   * committed. `restart` drops the recorder's memory after the end.
   */
  type Turn = {
    from: number;
    before?: Read[];
    after: Read[];
    restart?: true;
    family?: 'anthropic';
    /** Its row never takes an end: the write that settled it did not commit. */
    unsettled?: true;
    /** It ran on a connection the person assigned. */
    connection?: true;
  };
  /** A chat turn of another thread, by default in the other project. */
  type Other = {
    family: Family;
    from: number;
    to: number | null;
    extra?: object;
    /** In this row's own thread, as another lane of the same plan. */
    inThread?: true;
  };
  type Row = {
    name: string;
    family?: 'local';
    turns: Turn[];
    others?: Other[];
    /** The next round opens before the reading after this one comes. */
    overlap?: true;
    /** A round opens first in a transaction that rolls back, so its turn row never lands. */
    ghost?: true;
    /**
     * The other project's thread, with its turns, is deleted: before the step starts, while its
     * turn waits, or after the reading that closes it was journaled and before the recorder looked.
     */
    deleted?: 'before' | 'waiting' | 'after-reading';
    /** The recorder restarts before the step, after the reading that opens it. */
    restartBefore?: true;
    expect: unknown[];
  };
  const rows: Row[] = [
    {
      name: 'a reading after each of two rounds, in time',
      ghost: true,
      turns: [
        { from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75]] },
        { from: 10, after: [[16, 'weekly', 72]] },
      ],
      expect: [8, 'weekly'],
    },
    {
      name: 'a first reading after the end that comes past the limit',
      turns: [{ from: 0, before: [[-1, 'weekly', 80]], after: [[21, 'weekly', 75]] }],
      expect: [null, null],
    },
    {
      name: "another project's turn on the provider between the readings",
      turns: [{ from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      others: [{ family: 'openai', from: 2, to: 3 }],
      expect: [null, null],
    },
    {
      name: 'a window that reset between the readings',
      turns: [{ from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75, j.at(3)]] }],
      expect: [null, null],
    },
    {
      name: 'a first reading after the end that rose, with a later one that would stand',
      turns: [
        {
          from: 0,
          before: [[-1, 'weekly', 80]],
          after: [
            [6, 'weekly', 85],
            [7, 'weekly', 70],
          ],
        },
        { from: 10, after: [[16, 'weekly', 62]] },
      ],
      expect: [null, null],
    },
    {
      name: 'a second round read on another window ID',
      turns: [
        {
          from: 0,
          before: [
            [-1, 'weekly', 80],
            [-1, 'weekly-model', 90],
          ],
          after: [[6, 'weekly', 75]],
        },
        { from: 10, before: [[9, 'weekly-model', 50]], after: [[16, 'weekly-model', 45]] },
      ],
      expect: [null, null],
    },
    {
      name: 'a second round on another provider, on a window with the same ID',
      turns: [
        { from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75]] },
        {
          from: 10,
          family: 'anthropic',
          before: [[9, 'weekly', 60]],
          after: [[16, 'weekly', 58]],
        },
      ],
      expect: [null, null],
    },
    {
      name: 'a next round that opens before the reading after the first',
      turns: [
        { from: 0, before: [[-1, 'weekly', 80]], after: [[8, 'weekly', 75]] },
        { from: 6, after: [[12, 'weekly', 72]] },
      ],
      overlap: true,
      expect: [null, null],
    },
    {
      name: 'a restart with a turn waiting for its reading',
      turns: [{ from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75]], restart: true }],
      expect: [null, null],
    },
    {
      name: 'a turn on an assigned connection',
      turns: [
        { from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75]], connection: true },
      ],
      expect: [null, null],
    },
    {
      name: 'no reset time on either reading',
      turns: [{ from: 0, before: [[-1, 'weekly', 10, null]], after: [[6, 'weekly', 5, null]] }],
      expect: [null, null],
    },
    {
      name: "another project's thread, with a turn between the readings, deleted while the turn waits",
      turns: [{ from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      others: [{ family: 'openai', from: 2, to: 3 }],
      deleted: 'waiting',
      expect: [null, null],
    },
    {
      name: "another project's thread deleted after the closing reading came, before the recorder looked",
      turns: [{ from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      others: [{ family: 'openai', from: 2, to: 3 }],
      deleted: 'after-reading',
      expect: [null, null],
    },
    {
      name: "another project's thread deleted before the step, its turn after the opening reading",
      turns: [{ from: 0, before: [[-6, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      others: [{ family: 'openai', from: -5, to: -3 }],
      deleted: 'before',
      expect: [null, null],
    },
    {
      name: 'an older turn that ended inside the bracket, behind a turn on another provider',
      turns: [{ from: 0, before: [[-3, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      others: [
        { family: 'openai', from: -10, to: -1 },
        { family: 'anthropic', from: -8, to: -7 },
      ],
      expect: [null, null],
    },
    {
      name: 'an older turn that ended inside the bracket, behind a side question on its provider',
      turns: [{ from: 0, before: [[-3, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      others: [
        { family: 'openai', from: -10, to: -1 },
        { family: 'openai', from: -8, to: -7, extra: { role: 'ask' } },
      ],
      expect: [null, null],
    },
    {
      name: 'an older turn at work through the bracket that ended before the recorder looked',
      turns: [{ from: 0, before: [[-3, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      others: [
        { family: 'openai', from: -10, to: 6 },
        { family: 'anthropic', from: -8, to: -7 },
      ],
      expect: [null, null],
    },
    {
      name: 'a turn recovery ended at a restart, before a step on a recorder built after it',
      turns: [{ from: 0, before: [[-4, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      others: [
        { family: 'openai', from: -10, to: -1, extra: { state: 'failed' } },
        { family: 'anthropic', from: -9, to: -8 },
      ],
      restartBefore: true,
      expect: [null, null],
    },
    {
      name: 'a recorder built after the opening reading',
      turns: [{ from: 0, before: [[-4, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      restartBefore: true,
      expect: [null, null],
    },
    {
      name: "a review whose opening reading came during its slice's build, with a lane on another provider",
      turns: [{ from: 10.5, before: [[8, 'weekly', 80]], after: [[16, 'weekly', 75]] }],
      others: [
        { family: 'openai', from: 0, to: 10, inThread: true },
        { family: 'anthropic', from: 1, to: 3, inThread: true },
      ],
      expect: [null, null],
    },
    {
      name: 'Local',
      family: 'local',
      turns: [{ from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      expect: [null, null],
    },
    // Near the end, since its turn reads as open and overlaps every later reading but the last.
    {
      name: 'a turn whose end never committed',
      turns: [
        { from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75]], unsettled: true },
      ],
      expect: [null, null],
    },
    // Last, since the turn it leaves open overlaps every later reading.
    {
      name: 'a turn waiting on a permission in another project, older than one that ended before',
      turns: [{ from: 0, before: [[-1, 'weekly', 80]], after: [[6, 'weekly', 75]] }],
      others: [
        { family: 'openai', from: -30, to: null, extra: { state: 'waiting-permission' } },
        { family: 'anthropic', from: -25, to: -20 },
      ],
      expect: [null, null],
    },
  ];
  const allowance = (anchorTurnId: string) => {
    const record = j.store
      .sliceResultsOfTask(j.task.id)
      .find((value) => value.anchorTurnId === anchorTurnId);
    return [record?.allowanceUsed, record?.allowanceWindow];
  };
  rows.forEach((row, index) => {
    // Each row an hour after the last, so no reading of one stands beside a turn of another.
    const shift = index * 60;
    const family: Family = row.family ?? 'openai';
    const read = ([minute, windowId, value, resetsAt]: Read, on: Family = family) =>
      j.reading(minute + shift, windowId, value, resetsAt, on);
    let recorder = recorderAt();
    const elsewhere = j.newTask();
    for (const other of row.others ?? [])
      j.turnRow(
        other.inThread ? j.task.id : elsewhere.id,
        other.family,
        shift + other.from,
        other.to === null ? null : shift + other.to,
        j.as('trn'),
        other.extra,
      );
    const remove = () =>
      j.store.transaction(() => {
        assert.equal(j.store.removeTask(elsewhere.id), true);
        recorder.observe({ kind: 'thread-deleted', taskId: elsewhere.id, at: j.at(clock) });
      });
    const anchorTurnId = j.as('trn');
    const opened = row.turns.map((turn) => {
      const turnId = j.turnRow(
        j.task.id,
        turn.family ?? family,
        shift + turn.from,
        turn.unsettled ? null : shift + turn.from + 5,
        j.as('trn'),
        turn.connection ? { connectionId: 'con_01JABCDEFGHJKMNPQRSTVWXYZ0' } : {},
      );
      return { ...turn, turnId };
    });
    const step = (turnId: string, on: Family = family) =>
      ({
        taskId: j.task.id,
        slice: 1,
        step: 'review',
        turnId,
        anchorTurnId,
        role: 'reviewer',
        family: on,
        model: `${on}-model`,
        effort: 'default',
      }) as const;
    const start = (turn: (typeof opened)[number]) => {
      clock = shift + turn.from;
      for (const value of turn.before ?? []) read(value, turn.family);
      recorder.observe({
        ...step(turn.turnId, turn.family),
        kind: 'step-started',
        at: j.at(clock),
      });
    };
    const end = (turn: (typeof opened)[number]) => {
      clock = shift + turn.from + 5;
      recorder.observe({
        ...step(turn.turnId, turn.family),
        kind: 'step-ended',
        at: j.at(clock),
        rulesDigest: null,
        designVersionHash: null,
        outcome: 'done',
        durationMs: 300_000,
        findings: null,
      });
      if (turn.restart) recorder = recorderAt();
      if (row.deleted === 'waiting') remove();
    };
    // Every reading after the turn lands before the recorder looks again.
    const arrive = (turn: (typeof opened)[number]) => {
      for (const value of turn.after) read(value, turn.family);
      clock = shift + Math.max(...turn.after.map(([minute]) => minute));
      if (row.deleted === 'after-reading') {
        clock += 1;
        remove();
      }
      recorder.read(j.task.projectId);
    };
    for (const value of opened[0].before ?? []) read(value, opened[0].family);
    opened[0].before = [];
    if (row.deleted === 'before') {
      clock = shift + opened[0].from - 2;
      remove();
    }
    if (row.restartBefore) {
      clock = shift + opened[0].from - 1;
      recorder = recorderAt();
    }
    if (row.ghost) {
      clock = shift - 2;
      recorder.observe({ ...step(j.as('trn')), kind: 'step-started', at: j.at(clock) });
    }
    for (const [at, turn] of opened.entries()) {
      start(turn);
      end(turn);
      if (row.overlap && opened[at + 1]) start(opened[at + 1]);
      arrive(turn);
      if (row.overlap && opened[at + 1]) {
        end(opened[at + 1]);
        arrive(opened[at + 1]);
        break;
      }
    }
    // A review can run again until the plan ends, so nothing is written before then.
    assert.deepEqual(allowance(anchorTurnId), [null, null], row.name);
    clock = shift + 40;
    recorder.observe({
      kind: 'plan-ended',
      taskId: j.task.id,
      at: j.at(clock),
      outcome: 'finished',
      line: '',
      findings: null,
    });
    assert.deepEqual(allowance(anchorTurnId), row.expect, row.name);
  });
});

// Claim: a slice run again after a restart cut a fix off, and a second plan on the same thread,
// each get records of their own, and once the run has ended they name no recipe. A step's later
// rounds fold into its record, adding their time. The cut-off fix ends once, from its turn, with
// no duration, and counts once on its build. A report cut off in its turn ends the same way, a
// later orchestrator turn never ends it again, and a turn row the pass cannot read is named in
// one line.
test('a retried slice and a second plan on the same thread get their own records, and repeated rounds fold into one', {
  timeout: 60000,
}, async (t) => {
  const h = harness(t, {
    crew: crewOf('orchestrator', 'builder', 'reviewer'),
    openai: [
      planOf(1),
      write('export const net = 1;\n', 'Built.'),
      reply('Rounding drops a cent.\nFindings: 1'),
      wait,
      write('export const net = 2;\n', 'Built again.'),
      reply('Rounding drops a cent.\nFindings: 1'),
      write('export const net = 3;\n', 'Fixed.'),
      reply('Looks right.\nFindings: 0'),
      planOf(1, 'p2'),
      write('export const net = 4;\n', 'Built once more.'),
      reply('Looks right.\nFindings: 0'),
    ],
  });
  await h.until(
    (event) =>
      event.type === 'chat.turn' &&
      event.payload.state === 'running' &&
      event.payload.role === 'fixer',
  );
  await h.quiet();
  // The controller stops with the fix running. Startup recovers the thread, then closes the
  // step, and a second startup closes nothing: the build still counts one fix.
  const { chat, recorder } = h.start();
  chat.recover();
  recorder.reconcile();
  const closed = h.records();
  recorder.reconcile();
  assert.deepEqual(h.records(), closed);

  const retried = h.until(finished);
  const run = h.act((effects) =>
    chat.runPlan({ taskId: h.taskId, planId: 'p1', sliceId: 1 }, effects),
  );
  assert.equal(run.outcome, 'applied', JSON.stringify(run));
  await retried;
  await h.quiet();
  const again = h.until(finished);
  const sent = h.act((effects) =>
    chat.sendMessage(
      { taskId: h.taskId, text: 'Split it again.', role: 'assistant', attachments: [], files: [] },
      effects,
    ),
  );
  assert.equal(sent.outcome, 'applied', JSON.stringify(sent));
  await again;
  await h.quiet();

  const turns = h.turns();
  const of = (role: string) => turns.filter((turn) => turn.role === role && turn.slice === 1);
  const builds = of('assistant');
  const [cutReview, retryReview, retrySecond, secondReview] = of('reviewer');
  const [cutFix, retryFix] = of('fixer');
  assert.equal(builds.length, 3);
  const anchor = new Map(builds.map((turn, at) => [turn.id, ['cut', 'retry', 'second'][at]]));
  const records = h.records();
  assert.ok(records.every((record) => record.endedAt !== null));
  assert.equal(records[2].endedAt, cutFix.endedAt);
  assert.deepEqual(
    records.map((record) => [
      anchor.get(record.anchorTurnId),
      record.step,
      record.durationMs,
      record.fixRounds,
      record.recipeId,
    ]),
    [
      ['cut', 'build', spanOf(builds[0]), 1, h.recipeId],
      ['cut', 'review', spanOf(cutReview), null, h.recipeId],
      ['cut', 'fix', null, null, h.recipeId],
      // The restart ended the run, so the slice run again belongs to no run.
      ['retry', 'build', spanOf(builds[1]), 1, null],
      ['retry', 'review', spanOf(retryReview) + spanOf(retrySecond), null, null],
      ['retry', 'fix', spanOf(retryFix), null, null],
      ['retry', 'merge', null, null, null],
      ['second', 'build', spanOf(builds[2]), 0, null],
      ['second', 'review', spanOf(secondReview), null, null],
      ['second', 'merge', null, null, null],
    ],
  );

  // A report run cut off in its report turn. Its record ends from the turn, once. A turn row the
  // pass cannot read is named in one line and the rest still close.
  const report = harness(t, {
    shape: 'report',
    crew: crewOf('orchestrator', 'builder', 'challenger'),
    openai: [planOf(1, 'p1', true), reply('net.mjs:12 rounds.'), reply('It holds.'), wait],
  });
  await report.until(
    (event) =>
      event.type === 'chat.turn' &&
      event.payload.state === 'running' &&
      event.payload.role === 'orchestrator' &&
      report.records().some((record) => record.step === 'report'),
  );
  await report.quiet();
  report.store.db
    .prepare('INSERT INTO chat_turns(id,task_id,sequence,body) VALUES (?,?,?,?)')
    .run(
      `trn_${report.ids('msg').slice(4)}`,
      report.taskId,
      99,
      JSON.stringify({ state: 'failed', failure: { kind: 'internal' } }),
    );
  const lines: string[] = [];
  const later = report.start((line) => lines.push(line));
  later.chat.recover();
  later.recorder.reconcile();
  const reportTurn = report.turns().findLast((turn) => turn.role === 'orchestrator');
  const reported = () => report.records().find((record) => record.step === 'report');
  assert.deepEqual(
    [reported()?.endedAt, reported()?.durationMs, lines.length],
    [reportTurn?.endedAt, null, 1],
  );
  // One line: the row's ID and the error's first line.
  assert.match(lines[0], /^trn_[0-9A-Z]{26}: [^\n]+$/);
  // The person's next request, cut off by another restart after the report ended, ends nothing.
  const next = { ...reportTurn } as ChatTurn;
  next.id = `trn_${report.ids('msg').slice(4)}`;
  next.sequence = 100;
  next.startedAt = new Date(Date.parse(reportTurn?.endedAt as string) + 1000).toISOString();
  next.endedAt = new Date(Date.parse(next.startedAt) + 1000).toISOString();
  report.store.db
    .prepare('INSERT INTO chat_turns(id,task_id,sequence,body) VALUES (?,?,?,?)')
    .run(next.id, report.taskId, next.sequence, JSON.stringify(next));
  const once = reported();
  later.recorder.reconcile();
  assert.deepEqual(reported(), once);
});

// Claim: the read counts each figure the way the contract defines it, per recipe and per role and
// model. A role's row counts the slices it ran a step on. A slice counts as reviewed only when
// its first review gave a verdict, and the mean of fix rounds takes only builds whose plan ended.
// A recipe counts every run it started, and a forgotten recipe keeps its rows with no name. A row
// that does not parse is left out. An
// export pages through every record, newest first, with `next` until the last page, also when
// every record started at the same moment.
test('the tallies count what the contract says and an export pages through every record', (t) => {
  const { store } = home(t);
  const fixtures = createDemoFixtures();
  // Seeded past the fixtures' own IDs, so no ID repeats one of theirs.
  const ids = createTestIds(undefined, 1000n);
  const as = (prefix: string) => `${prefix}_${ids('msg').slice(4)}`;
  const projectId = fixtures.task.projectId;
  const elsewhere = as('prj');
  const [named, forgotten] = [as('rcp'), as('rcp')];
  const [first, second, third, idle] = [as('rrn'), as('rrn'), as('rrn'), as('rrn')];
  const at = (minutes: number) =>
    new Date(Date.parse('2026-11-18T10:00:00.000Z') + minutes * 60_000).toISOString();
  let minute = 0;
  const record = (change: Partial<SliceResult>): SliceResult => ({
    id: as('srs'),
    projectId,
    taskId: fixtures.task.id,
    anchorTurnId: as('trn'),
    recipeId: named,
    recipeHash: 'a'.repeat(64),
    runId: first,
    slice: 1,
    step: 'build',
    role: 'builder',
    family: 'openai',
    model: 'openai-model',
    effort: 'default',
    rulesDigest: null,
    designVersionHash: null,
    firstGate: 'none',
    firstReview: 'none',
    findings: null,
    fixRounds: 0,
    final: 'waiting',
    durationMs: 1000,
    allowanceUsed: null,
    allowanceWindow: null,
    startedAt: at(minute++),
    endedAt: null,
    ...change,
  });
  const weekly = (used: number) => ({ allowanceUsed: used, allowanceWindow: 'weekly' });
  const lane = (anchorTurnId: string, step: 'review' | 'fix' | 'merge', change = {}) =>
    record({
      anchorTurnId,
      step,
      role: step === 'review' ? 'reviewer' : step === 'fix' ? 'fixer' : null,
      ...(step === 'merge' ? { family: null, model: null, effort: null } : {}),
      fixRounds: null,
      ...change,
    });
  const b1 = record({
    firstReview: 'findings',
    findings: 2,
    fixRounds: 2,
    final: 'accepted',
    ...weekly(5),
  });
  const b2 = record({
    runId: second,
    firstReview: 'clean',
    findings: 0,
    final: 'discarded',
    ...weekly(2),
  });
  const b3 = record({ runId: second, slice: 2, fixRounds: 1 });
  const records = [
    b1,
    lane(b1.anchorTurnId, 'review', { final: 'accepted' }),
    lane(b1.anchorTurnId, 'fix', { final: 'accepted', ...weekly(3) }),
    lane(b1.anchorTurnId, 'merge'),
    b2,
    b3,
    lane(b2.anchorTurnId, 'review', { runId: second }),
    lane(b3.anchorTurnId, 'review', { runId: second, slice: 2 }),
    record({
      recipeId: forgotten,
      runId: third,
      family: 'anthropic',
      model: 'anthropic-model',
      effort: 'high',
      firstReview: 'unknown',
      allowanceUsed: 4,
      allowanceWindow: 'five-hour',
    }),
    record({
      recipeId: null,
      recipeHash: null,
      runId: null,
      firstReview: 'clean',
      findings: 0,
      final: 'accepted',
      allowanceUsed: 1,
      allowanceWindow: 'daily',
    }),
  ];
  // In a third project: three builds whose first review stated no count, each after two fix
  // rounds, and one build still at work, which has had no fix round yet.
  const judged = as('prj');
  const unjudged = [
    ...Array.from({ length: 3 }, () =>
      record({ projectId: judged, firstReview: 'unknown', fixRounds: 2 }),
    ),
    record({ projectId: judged, final: 'unknown' }),
  ];
  // One record past a page, in another project, every one started at the same moment.
  const paged = Array.from({ length: 501 }, () =>
    record({ projectId: elsewhere, startedAt: at(100) }),
  );
  const run = (id: string, recipeId: string, startedAt: string): PlanRecipeRun => ({
    id,
    recipeId,
    projectId,
    taskId: ids('tsk'),
    version: 1,
    versionHash: 'a'.repeat(64),
    origin: 'manual',
    item: null,
    state: 'accepted',
    findings: null,
    changedFiles: null,
    reason: null,
    startedAt,
    endedAt: null,
    allowance: { start: [], end: null },
  });
  const recipe: PlanRecipe = {
    schema: 1,
    name: 'Split work',
    description: '',
    shape: 'change',
    crew: crewOf('orchestrator', 'builder'),
    run: {
      flightMode: 'glide',
      permissionPolicy: 'allow-all',
      handoff: { auto: false, mode: 'most-left' },
      maxSlices: 8,
    },
    checks: [],
    trigger: { kind: 'manual' },
    budget: null,
    work: null,
  };
  store.transaction(() => {
    for (const id of [projectId, elsewhere, judged])
      store.put('project', id, 0, { id, name: 'demo-shop', revision: 0 });
    store.putRecipe({
      id: named,
      projectId,
      path: '.crewkite/recipes/split.json',
      version: 1,
      versionHash: 'a'.repeat(64),
      updatedAt: at(0),
    });
    store.putRecipeVersion(named, 1, 'a'.repeat(64), recipe, at(0));
    for (const value of [...records, ...paged, ...unjudged]) store.insertSliceResult(value);
    store.putRecipeRun(run(first, named, at(0)));
    store.putRecipeRun(run(second, named, at(4)));
    store.putRecipeRun(run(third, forgotten, at(8)));
    // A run that ended before any step opened.
    store.putRecipeRun(run(idle, named, at(9)));
  });
  // A row an older or damaged version wrote: valid JSON, not a record.
  store.db
    .prepare(
      "INSERT INTO slice_results(id,project_id,task_id,anchor_turn_id,recipe_id,slice,step,body,started_at,ended_at) VALUES (?,?,?,?,?,1,'build','{}',?,NULL)",
    )
    .run(as('srs'), projectId, fixtures.task.id, as('trn'), named, at(50));
  const recorder = new ResultRecorder({
    store,
    id: () => as('srs'),
    home: '/nowhere',
    projectPath: () => undefined,
  });
  const b1Slice = {
    slices: 1,
    reviewed: 1,
    passedFirstReview: 0,
    fixRounds: 2,
    settled: 1,
    accepted: 1,
  };
  assert.deepEqual(recorder.read(projectId), {
    projectId,
    records: 10,
    first: at(0),
    last: at(9),
    recipes: [
      {
        recipeId: named,
        name: 'Split work',
        runs: 3,
        slices: 3,
        reviewed: 2,
        passedFirstReview: 1,
        fixRounds: 1,
        settled: 2,
        accepted: 1,
        // The row with the most steps comes first.
        allowance: [
          { family: 'openai', window: null, used: 0, steps: 4 },
          { family: 'openai', window: 'weekly', used: 10, steps: 3 },
        ],
      },
      {
        recipeId: forgotten,
        name: null,
        runs: 1,
        slices: 1,
        // A first review that stated no count gave no verdict.
        reviewed: 0,
        passedFirstReview: 0,
        fixRounds: 0,
        settled: 0,
        accepted: 0,
        allowance: [{ family: 'anthropic', window: 'five-hour', used: 4, steps: 1 }],
      },
    ],
    crew: [
      {
        role: 'builder',
        family: 'anthropic',
        model: 'anthropic-model',
        effort: 'high',
        steps: 1,
        slices: 1,
        reviewed: 0,
        passedFirstReview: 0,
        fixRounds: 0,
        settled: 0,
        accepted: 0,
        allowanceUsed: 4,
        allowanceWindow: 'five-hour',
        allowanceUnknown: 0,
      },
      {
        role: 'builder',
        family: 'openai',
        model: 'openai-model',
        effort: 'default',
        steps: 4,
        slices: 4,
        reviewed: 3,
        passedFirstReview: 2,
        fixRounds: 0.75,
        settled: 3,
        accepted: 2,
        // weekly is the row's most common window. The daily step counts as unknown.
        allowanceUsed: 7,
        allowanceWindow: 'weekly',
        allowanceUnknown: 2,
      },
      // The reviewer read three slices, and the first review found one of them clean.
      {
        role: 'reviewer',
        family: 'openai',
        model: 'openai-model',
        effort: 'default',
        steps: 3,
        slices: 3,
        reviewed: 2,
        passedFirstReview: 1,
        fixRounds: 1,
        settled: 2,
        accepted: 1,
        allowanceUsed: null,
        allowanceWindow: null,
        allowanceUnknown: 3,
      },
      {
        role: 'fixer',
        family: 'openai',
        model: 'openai-model',
        effort: 'default',
        steps: 1,
        ...b1Slice,
        allowanceUsed: 3,
        allowanceWindow: 'weekly',
        allowanceUnknown: 0,
      },
    ],
    moreRecipes: 0,
    moreCrew: 0,
  });
  const [figures] = recorder.read(judged).recipes;
  assert.deepEqual(
    [figures.slices, figures.reviewed, figures.passedFirstReview, figures.fixRounds],
    [4, 0, 0, 2],
  );
  const one = recorder.read(projectId, named);
  assert.deepEqual([one.records, one.recipes.map((value) => value.recipeId)], [8, [named]]);

  const newest = recorder.page({ projectId: elsewhere, part: 'records' });
  assert.ok(newest.next);
  const oldest = recorder.page({ projectId: elsewhere, part: 'records', before: newest.next });
  for (const page of [newest, oldest]) ResultsExportSchema.parse(page);
  assert.deepEqual([newest.records.length, oldest.records.length, oldest.next], [500, 1, null]);
  assert.deepEqual(
    [...newest.records, ...oldest.records].map((value) => value.id),
    paged.map((value) => value.id).reverse(),
  );
  const runs = recorder.page({ projectId, part: 'runs' });
  assert.deepEqual(
    [runs.runs.map((value) => value.id), runs.records, runs.next],
    [[idle, third, second, first], [], null],
  );
  // The damaged row is left out of a page too.
  const mine = recorder.page({ projectId, part: 'records' });
  assert.equal(mine.records.length, 10);
});
