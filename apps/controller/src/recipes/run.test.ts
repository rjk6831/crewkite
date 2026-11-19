import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type {
  ChatCatalogRead,
  ChatCrew,
  ChatFamily,
  ChatModelSelection,
  ChatThread,
  ChatThreadRead,
  Event,
  PlanRecipe,
  Task,
} from '@crewkite/contracts';
import { type ChatScriptStep, createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { installedTools, setup } from '../store/controller-fixture.ts';
import { resolveAtHead } from './checks.ts';
import type { RecipeRuns } from './run.ts';

const pick: ChatModelSelection = { family: 'openai', model: 'fixture-model', effort: 'default' };
const crew: ChatCrew = {
  name: 'Pair',
  members: [
    { role: 'orchestrator', selection: pick },
    { role: 'builder', selection: pick },
  ],
};
const reply = (text: string): ChatScriptStep[] => [{ kind: 'text', itemId: 'r', chunks: [text] }];
const planOf = (count: number) =>
  reply(
    `Parts.\n\n\`\`\`json plan\n${JSON.stringify({
      planId: 'p1',
      goal: 'Do the parts.',
      slices: Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        title: `Part ${index + 1}`,
        brief: `Do part ${index + 1}.`,
        files: [],
        depends: [],
        difficulty: 'medium',
        readOnly: false,
      })),
    })}\n\`\`\``,
  );

/** Only git on PATH, so nothing a test runs can find gh or a provider client. */
function lockPath(t: TestContext) {
  const tools = mkdtempSync(join(tmpdir(), 'ck-run-path-'));
  const saved = process.env.PATH;
  process.env.PATH = installedTools(tools, 'git');
  t.after(() => {
    process.env.PATH = saved;
    rmSync(tools, { recursive: true, force: true });
  });
}

/** A connected family that lists `fixture-model` and has `percent` of its weekly window left. */
const family = (name: ChatFamily, percent: number): ChatCatalogRead['families'][number] => ({
  family: name,
  connected: true,
  reason: null,
  models: [
    { model: 'fixture-model', label: 'Fixture', efforts: ['default'], defaultEffort: 'default' },
  ],
  defaultModel: 'fixture-model',
  remaining: [
    {
      windowId: 'weekly',
      label: 'Weekly',
      percent,
      resetsAt: null,
      observedAt: '2026-10-15T16:55:00.000Z',
    },
  ],
  accepts: null,
});

/** A controller whose OpenAI turns play the scripts in order. */
async function open(
  t: TestContext,
  turns: ChatScriptStep[][],
  options: { reportRuns?: true } = {},
) {
  lockPath(t);
  const adapter = createScriptedChatAdapter({ family: 'openai', turns });
  const context = await setup(t, {
    ...options,
    chatAdapters: new Map([['openai', adapter]]),
    identity: { name: 'Fixture owner', email: 'owner@example.invalid' },
  });
  const { controller, command } = context;
  // The fixture controller has no connected provider. The catalog is the one fact the test sets.
  const families = [family('openai', 40)];
  Object.assign(controller, { chatCatalog: () => ({ families }) });
  // A command that changes something names a revision. The recipe and thread ones ignore it.
  const run = (name: string, payload: object, revision?: number) =>
    controller.execute(
      command(name, payload, revision ?? (/^(Read|Draft)/.test(name) ? undefined : 0)),
      'local-owner',
    );
  const task = (await controller.execute(context.draft, 'local-owner')).entity as Task;
  const projectId = task.projectId;
  const ended = (match: RegExp) =>
    new Promise<Event>((resolve) => {
      const stop = controller.store.subscribe((event) => {
        if (event.type !== 'conversation.entry' || !match.test(event.payload.text ?? '')) return;
        stop();
        resolve(event);
      });
    });
  const thread = async (taskId: string) =>
    (await run('ReadChatThread', { taskId })).data as ChatThreadRead & { kind: 'chat-thread' };
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: context.source.directory,
      encoding: 'utf8',
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
  /** Saves a manual recipe the way the Recipes page does and answers its record. */
  const save = async (body: PlanRecipe, path = '.crewkite/recipes/tidy.json') => {
    const saved = await run('SaveRecipe', {
      projectId,
      path,
      body,
      expectedVersion: 0,
      confirm: 'explicit',
    });
    assert(saved.data?.kind === 'recipe-saved', JSON.stringify(saved));
    return saved.data.record;
  };
  /** What a refused run left behind: threads and run rows. */
  const counts = () => [
    controller.store.list('task').length,
    controller.store.db.prepare('SELECT count(*) AS n FROM recipe_runs').get()?.n,
  ];
  return { ...context, adapter, run, task, projectId, ended, thread, families, git, save, counts };
}

test('a finished plan thread saved as a recipe and run again sets up the same crew, flight mode, handoff and checks, with the recipe version on the run', {
  timeout: 20000,
}, async (t) => {
  const { run, task, projectId, ended, thread, git, save, source } = await open(t, [
    planOf(2),
    reply('Built.'),
    reply('Built.'),
    reply('Nothing to split.'),
    reply('Nothing to repeat.'),
  ]);
  // The project declares a test script, so every thread detects a check for it.
  writeFileSync(
    join(source.directory, 'package.json'),
    `${JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } })}\n`,
  );
  git('add', 'package.json');
  git('commit', '--quiet', '-m', 'add a manifest');
  // Glide, then the person's own handoff choices, a policy and one check they added.
  const configured = async (payload: object) => {
    const done = await run('ConfigureChatThread', { taskId: task.id, ...payload });
    assert.equal(done.outcome, 'applied', JSON.stringify(done));
  };
  await configured({ crew, flightMode: 'glide' });
  await configured({
    autoHandoff: false,
    handoffMode: 'resets-first',
    permissionPolicy: 'allow-edits',
  });
  const finished = ended(/^Crew finished/);
  assert.equal(
    (
      await run(
        'SendChatMessage',
        { taskId: task.id, text: 'Split it.', selection: pick },
        task.revision,
      )
    ).outcome,
    'applied',
  );
  await finished;
  await configured({ checks: { switch: { id: 'package.json:test', enabled: true } } });
  await configured({ checks: { add: 'node --test' } });

  const drafted = await run('DraftRecipe', { taskId: task.id });
  assert(drafted.data?.kind === 'recipe-draft', JSON.stringify(drafted));
  const recipe: PlanRecipe = drafted.data.recipe;
  assert.deepEqual(drafted.data.defaults, []);
  assert.deepEqual(
    [
      recipe.crew,
      recipe.run,
      recipe.checks,
      recipe.shape,
      recipe.trigger,
      recipe.budget,
      recipe.work,
      recipe.name,
    ],
    [
      crew,
      {
        flightMode: 'glide',
        permissionPolicy: 'allow-edits',
        handoff: { auto: false, mode: 'resets-first' },
        maxSlices: 2,
      },
      [{ command: 'npm run test' }, { command: 'node --test' }],
      'change',
      { kind: 'manual' },
      null,
      null,
      task.title.slice(0, 80),
    ],
  );

  const path = '.crewkite/recipes/split.json';
  const saved = await run('SaveRecipe', {
    projectId,
    path,
    body: recipe,
    expectedVersion: 0,
    confirm: 'explicit',
  });
  assert(saved.data?.kind === 'recipe-saved', JSON.stringify(saved));
  const record = saved.data.record;

  const second = ended(/^Nothing to split|^Crew finished/);
  const started = await run('RunRecipe', { recipeId: record.id, request: 'Split it again.' });
  assert(started.data?.kind === 'recipe-run', JSON.stringify(started));
  const row = started.data.run;
  await second;
  assert.notEqual(row.taskId, task.id);
  assert.deepEqual(
    [row.recipeId, row.projectId, row.version, row.versionHash, row.origin, row.state, row.item],
    [record.id, projectId, 1, record.versionHash, 'manual', 'running', null],
  );
  assert.deepEqual(row.allowance.end, null);
  assert.deepEqual(
    row.allowance.start.map((reading) => reading.family),
    ['openai'],
  );

  const made = (await thread(row.taskId)).thread as ChatThread;
  const was = (await thread(task.id)).thread as ChatThread;
  const fields = (value: ChatThread) => [
    value.crew,
    value.flightMode,
    value.autoHandoff,
    value.handoffMode,
    value.permissionPolicy,
    value.checks?.items.filter((item) => item.enabled).map((item) => item.command),
  ];
  assert.deepEqual(fields(made), fields(was));
  // The detected check is switched on, and no custom copy of it is added.
  assert.deepEqual(
    made.checks?.items.filter((item) => item.enabled).map((item) => [item.id, item.command]),
    [
      ['package.json:test', 'npm run test'],
      ['custom:1', 'node --test'],
    ],
  );
  // A manual run approves nothing, so the thread asks about its check the way it does today.
  assert.equal(made.checks?.approved, null);
  const lines = (await thread(row.taskId)).messages.map((message) => message.text);
  assert.deepEqual(lines.slice(0, 2), [`Run of ${recipe.name}, version 1.`, 'Split it again.']);
  const byThread = await run('ReadRecipeRuns', { taskId: row.taskId });
  assert(byThread.data?.kind === 'recipe-runs');
  assert.deepEqual(
    [byThread.data.runs.map((value) => value.id), byThread.data.name],
    [[row.id], recipe.name],
  );

  // Two commands that read the same once normalized turn one check on.
  const twice = await save(
    body({ checks: [{ command: 'node --test' }, { command: 'node  --test' }] }),
    '.crewkite/recipes/twice.json',
  );
  const third = ended(/^Nothing to repeat/);
  const doubled = await run('RunRecipe', { recipeId: twice.id, request: 'Repeat it.' });
  assert(doubled.data?.kind === 'recipe-run', JSON.stringify(doubled));
  await third;
  const once = (await thread(doubled.data.run.taskId)).thread as ChatThread;
  assert.deepEqual(
    once.checks?.items.filter((item) => item.command === 'node --test').map((item) => item.enabled),
    [true],
  );
});

const body = (more: Partial<PlanRecipe> = {}): PlanRecipe => ({
  schema: 1,
  name: 'Tidy',
  description: '',
  shape: 'change',
  crew,
  run: {
    flightMode: 'balanced',
    permissionPolicy: 'ask',
    handoff: { auto: false, mode: 'most-left' },
    maxSlices: 2,
  },
  checks: [],
  trigger: { kind: 'manual' },
  budget: null,
  work: null,
  ...more,
});

test('a run refuses a file that is not the saved version, a crew member that is not ready, and a version that moved', {
  timeout: 30000,
}, async (t) => {
  const { controller, run, save, counts, families, source, git, projectId } = await open(t, [
    reply('Ok.'),
  ]);
  const record = await save(body());
  const file = join(source.directory, '.crewkite/recipes/tidy.json');
  const text = readFileSync(file, 'utf8');
  const withCrew = (members: ChatCrew['members']) => ({ crew: { name: 'Crew', members } });
  const [orchestrator, builder] = crew.members;
  const google: ChatModelSelection = {
    family: 'google',
    model: 'fixture-model',
    effort: 'default',
  };
  const high: ChatModelSelection = { ...pick, effort: 'high' };
  const googleBuilder = await save(
    body(withCrew([orchestrator, { ...builder, selection: google }])),
    '.crewkite/recipes/google.json',
  );
  const unlisted = await save(
    body(withCrew([{ ...orchestrator, selection: high }, builder])),
    '.crewkite/recipes/high.json',
  );
  // The project detects one check, so a recipe with sixteen of its own does not fit in one thread.
  writeFileSync(
    join(source.directory, 'package.json'),
    `${JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } })}\n`,
  );
  git('add', 'package.json');
  git('commit', '--quiet', '-m', 'add a manifest');
  const crowded = await save(
    body({ checks: Array.from({ length: 16 }, (_, n) => ({ command: `node scripts/c${n}.mjs` })) }),
    '.crewkite/recipes/crowded.json',
  );
  // The person looked at version 1, and a second save made version 2 meanwhile.
  const movedPath = '.crewkite/recipes/moved.json';
  const looked = await save(body({ name: 'Moved' }), movedPath);
  const again = await run('SaveRecipe', {
    projectId,
    recipeId: looked.id,
    path: movedPath,
    body: body({ name: 'Moved again' }),
    expectedVersion: 1,
    confirm: 'explicit',
  });
  assert.equal(again.outcome, 'applied');
  const reporting = await save(
    body({
      shape: 'report',
      crew: { name: 'Crew', members: [...crew.members, { role: 'challenger', selection: pick }] },
    }),
    '.crewkite/recipes/report.json',
  );
  const before = counts();
  const none = 'rcp_01M50838M000000000000000ZB';
  const rows: {
    name: string;
    recipeId: string;
    versionHash?: string;
    arrange?: () => void;
    reason: string;
    next: string;
  }[] = [
    {
      name: 'the record is gone',
      recipeId: none,
      reason: 'recipe-not-found',
      next: 'That recipe is not saved here.',
    },
    {
      // Report runs are off in the app, so a report recipe saves and does not run.
      name: 'a report recipe',
      recipeId: reporting.id,
      reason: 'recipe-shape-unavailable',
      next: 'Report only runs are not available in this version. Set Run type to Changes files.',
    },
    {
      name: 'the version moved',
      recipeId: looked.id,
      versionHash: looked.versionHash,
      reason: 'recipe-version-moved',
      next: 'This recipe was saved again as version 2. Look at it, then run.',
    },
    {
      name: 'the file changed',
      recipeId: record.id,
      arrange: () => writeFileSync(file, text.replace('"Tidy"', '"Tidied"')),
      reason: 'recipe-file-changed',
      next: 'The recipe file changed on disk. Review it and save, then try again.',
    },
    {
      name: 'the file is gone',
      recipeId: record.id,
      arrange: () => rmSync(file),
      reason: 'recipe-file-missing',
      next: 'The recipe file is missing. Write it again, or forget the recipe.',
    },
    {
      name: 'the file does not read',
      recipeId: record.id,
      arrange: () => writeFileSync(file, '{'),
      reason: 'recipe-file-invalid',
      next: 'The recipe file no longer reads as a recipe. Fix it, then try again.',
    },
    {
      name: 'a provider is not connected',
      recipeId: record.id,
      arrange: () => {
        writeFileSync(file, text);
        families.splice(0);
      },
      reason: 'recipe-not-connected',
      next: "OpenAI is not connected. Connect it in Settings, or change the recipe's orchestrator.",
    },
    {
      name: 'a model is not listed',
      recipeId: unlisted.id,
      arrange: () => families.push(family('openai', 40)),
      reason: 'recipe-model-unknown',
      next: 'OpenAI does not list fixture-model. Pick another model for the orchestrator.',
    },
    {
      name: 'terms are pending',
      recipeId: googleBuilder.id,
      arrange: () => families.push(family('google', 40)),
      reason: 'recipe-terms-pending',
      next: 'Accept the Google terms in Settings, then run again.',
    },
    {
      name: 'the checks do not fit in one thread',
      recipeId: crowded.id,
      reason: 'recipe-checks-full',
      next: "This project's checks and the recipe's do not fit in one thread, which holds 16. Remove a check from the recipe.",
    },
    {
      name: "the orchestrator's first turn would be refused",
      recipeId: record.id,
      arrange: () => {
        families.splice(0);
        families.push({ ...family('openai', 0), creditSpending: false });
      },
      reason: 'credits-paused',
      next: 'OpenAI is out of included allowance and credit spending is off. Turn credit spending on in Settings or pick another provider.',
    },
    {
      name: 'a start that throws once the copy exists',
      recipeId: record.id,
      arrange: () => {
        families.splice(0);
        families.push(family('openai', 40));
        Object.assign(service, {
          sendMessage: () => {
            throw new Error('The send failed.');
          },
        });
      },
      reason: 'thrown',
      next: 'The send failed.',
    },
  ];
  const service = Reflect.apply(Reflect.get(controller, 'chat'), controller, []) as object;
  for (const row of rows) {
    row.arrange?.();
    // A throw rolls the whole command back, so it answers as the error.
    const result = await run('RunRecipe', {
      recipeId: row.recipeId,
      request: 'Go.',
      ...(row.versionHash ? { versionHash: row.versionHash } : {}),
    }).catch((error: Error) => ({ outcome: 'blocked', reason: 'thrown', next: error.message }));
    assert.deepEqual(
      [result.outcome, result.reason, result.next],
      ['blocked', row.reason, row.next],
      row.name,
    );
    assert.deepEqual(counts(), before, row.name);
  }
  // No refused run left a copy in the home or a ref in the person's repository.
  const chat = join(controller.home, 'chat');
  assert.deepEqual(
    existsSync(chat) ? readdirSync(chat).filter((name) => name.startsWith('tsk_')) : [],
    [],
  );
  assert.equal(git('for-each-ref', 'refs/crewkite/threads'), '');
});

test('a report recipe starts a run like any other, and a reply with no plan is sent back and then stops it', {
  timeout: 20000,
}, async (t) => {
  // The app keeps report runs off. This test holds what a report run does once they are on.
  const { run, save, ended, thread } = await open(
    t,
    [reply('Nothing here needs a report.'), reply('Still nothing.')],
    { reportRuns: true },
  );
  const record = await save(
    body({
      shape: 'report',
      crew: { name: 'Crew', members: [...crew.members, { role: 'challenger', selection: pick }] },
    }),
    '.crewkite/recipes/report.json',
  );
  const stopped = ended(/^Plan stopped/);
  const started = await run('RunRecipe', { recipeId: record.id, request: 'Look at the totals.' });
  assert(started.data?.kind === 'recipe-run', JSON.stringify(started));
  const line = ((await stopped).payload as { text: string }).text;
  assert.equal(
    line,
    'Plan stopped: the plan did not pass validation. The reply has no fenced json block tagged plan.',
  );
  const { taskId } = started.data.run;
  assert.equal(((await thread(taskId)).thread as ChatThread).crew?.members.length, 3);
  const read = await run('ReadRecipeRuns', { taskId });
  assert(read.data?.kind === 'recipe-runs');
  assert.deepEqual([read.data.runs[0].state, read.data.runs[0].reason], ['failed', line]);
});

test('a repeated run key answers the first run and starts none', {
  timeout: 20000,
}, async (t) => {
  const { controller, command, run, save, counts } = await open(t, [reply('Ok.'), reply('Built.')]);
  const record = await save(body());
  const before = counts();
  let taskId = '';
  const over = () => taskId !== '' && controller.store.recipeRunOf(taskId)?.state !== 'running';
  const settled = new Promise<void>((resolve) => {
    const stop = controller.store.subscribe(() => {
      if (!over()) return;
      stop();
      resolve();
    });
  });
  const once = command('RunRecipe', { recipeId: record.id, request: 'Tidy once.' }, 0);
  const first = await controller.execute(once, 'local-owner');
  assert(first.data?.kind === 'recipe-run', JSON.stringify(first));
  const again = await controller.execute(once, 'local-owner');
  assert(again.data?.kind === 'recipe-run');
  assert.deepEqual([again.outcome, again.data.run.id], ['already-applied', first.data.run.id]);
  assert.deepEqual(counts(), [Number(before[0]) + 1, Number(before[1]) + 1]);

  // The run keeps its run type. Forgetting the recipe drops the saved version, and the thread of
  // a change run that never planned still takes a builder's turn.
  assert.equal(first.data.run.shape, 'change');
  taskId = first.data.run.taskId;
  if (!over()) await settled;
  const forgot = await run('ForgetRecipe', { recipeId: record.id, confirm: 'explicit' });
  assert.equal(forgot.outcome, 'applied', JSON.stringify(forgot));
  const manual = await run('ConfigureChatThread', { taskId, flightMode: 'manual' });
  assert.equal(manual.outcome, 'applied', JSON.stringify(manual));
  const sent = await run('SendChatMessage', {
    taskId,
    text: 'Edit net.mjs.',
    role: 'assistant',
    selection: pick,
  });
  assert.equal(sent.outcome, 'applied', JSON.stringify(sent));
});

test('a plan with more slices than the recipe allows is refused', {
  timeout: 20000,
}, async (t) => {
  const { run, save, ended, adapter } = await open(t, [planOf(3), planOf(3)]);
  const record = await save(body());
  const stopped = ended(/^Plan stopped/);
  const started = await run('RunRecipe', { recipeId: record.id, request: 'Split it.' });
  assert.equal(started.outcome, 'applied', JSON.stringify(started));
  const line = ((await stopped).payload as { text: string }).text;
  // The orchestrator hears the limit once and tries again, as it does for more than eight.
  assert.equal(
    line,
    'Plan stopped: the plan did not pass validation. The plan does not match the schema. slices: Too big: expected array to have <=2 items',
  );
  assert.equal(adapter.requests.length, 2);
  assert.match(
    adapter.requests[0].systemContext,
    /- slices: 1 to 2\. Each id is a number from 1 to 2/,
  );
});

test('a scheduled start approves its checks only when every digest matches', {
  timeout: 30000,
}, async (t) => {
  const { controller, save, git, source } = await open(t, [reply('Ok.')]);
  const command = 'node scripts/x.mjs';
  mkdirSync(join(source.directory, 'scripts'));
  const script = join(source.directory, 'scripts/x.mjs');
  const commit = (text: string) => {
    writeFileSync(script, text);
    git('add', 'scripts/x.mjs');
    git('commit', '--quiet', '-m', 'script');
  };
  commit('console.log(1);\n');
  const saved = await save(body({ checks: [{ command }] }));
  const record = controller.store.recipe(saved.id);
  assert(record);
  const [seen] = resolveAtHead(source.directory, controller.home, [command]);
  assert(seen.digest);
  const approved = [{ command, resolved: seen.resolved ?? command, digest: seen.digest }];
  const runs = Reflect.apply(Reflect.get(controller, 'recipeRuns'), controller, []) as RecipeRuns;
  const start = (item: string) =>
    runs.startRun({ record, request: 'Tick.', origin: 'schedule', item, approved });

  const matching = start('First item');
  const asked = controller.store.chatThread(matching.taskId)?.checks?.approved;
  assert.match(asked ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual([matching.origin, matching.item], ['schedule', 'First item']);

  // The script changed after the person approved it, so the new copy holds another digest.
  commit('console.log(2);\n');
  const changed = start('Second item');
  assert.equal(controller.store.chatThread(changed.taskId)?.checks?.approved, null);
});
