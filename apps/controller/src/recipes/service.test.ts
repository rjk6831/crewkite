import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type PlanRecipe, PlanRecipeSchema, type Project } from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { createTestClock, createTestIds } from '@crewkite/testkit';
import { ADDED_RULE, detectChecks, sourceDigest } from '../chat/checks.ts';
import { installedTools, setup } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import { resolveAtHead, resolveCheck } from './checks.ts';
import { RecipeRefused, Recipes } from './service.ts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const env = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const base: PlanRecipe = {
  schema: 1,
  name: 'Tidy',
  description: 'Tidy one module at a time.',
  shape: 'change',
  crew: {
    name: 'Pair',
    members: [
      {
        role: 'orchestrator',
        selection: { family: 'openai', model: 'fixture-model-a', effort: 'default' },
      },
      { role: 'builder', selection: { family: 'anthropic', model: 'model-b', effort: 'high' } },
    ],
  },
  run: {
    flightMode: 'balanced',
    permissionPolicy: 'ask',
    handoff: { auto: false, mode: 'most-left' },
    maxSlices: 3,
  },
  checks: [{ command: 'pnpm run test' }],
  trigger: { kind: 'manual' },
  budget: null,
  work: null,
};
const scheduled = (checks: string[]): PlanRecipe => ({
  ...base,
  checks: checks.map((command) => ({ command })),
  trigger: { kind: 'interval', everyMinutes: 60 },
  budget: { maxRuns: 5, maxUsedPercent: { openai: 80, anthropic: 80 }, maxWaiting: 3 },
  work: { kind: 'request', text: 'Tidy the next module.' },
});

/** Only git on PATH, so nothing a test runs can find gh or a provider client. */
function lockPath(t: TestContext) {
  const tools = mkdtempSync(join(tmpdir(), 'ck-recipes-path-'));
  const saved = process.env.PATH;
  process.env.PATH = installedTools(tools, 'git');
  t.after(() => {
    process.env.PATH = saved;
    rmSync(tools, { recursive: true, force: true });
  });
}

/** A recipe service over a real store and a project that is a real repository. */
function harness(t: TestContext) {
  lockPath(t);
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-recipes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(migrations);
  const clock = createTestClock();
  const ids = createTestIds(clock.now());
  const project: Project = { id: ids('prj'), name: 'shop', revision: 0 };
  store.transaction(() => store.put('project', project.id, 0, project));
  const folder = join(directory, 'shop');
  mkdirSync(folder);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: folder, env: { ...process.env, ...env }, encoding: 'utf8' });
  const manifest = (test: string) =>
    writeFileSync(
      join(folder, 'package.json'),
      `${JSON.stringify({ name: 'shop', scripts: { test } }, null, 2)}\n`,
    );
  git('init', '--quiet');
  manifest('node --test');
  writeFileSync(join(folder, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  git('add', '.');
  git('commit', '--quiet', '-m', 'start');
  const home = join(directory, 'home');
  const recipes = new Recipes({
    store,
    now: clock.now,
    id: () => `rcp_${ids('msg').slice(4)}`,
    home,
    projectPath: (id) => (id === project.id ? folder : undefined),
    readiness: (selections) =>
      selections.map((selection) => (selection.family === 'anthropic' ? 'not-connected' : null)),
    changed: () => {},
  });
  const projectId = project.id;
  // The controller runs every command in one store transaction. So do these calls.
  const save = (
    path: string,
    body: PlanRecipe,
    expectedVersion: number,
    more: { recipeId?: string; seen?: { command: string; digest: string }[] } = {},
  ) =>
    store.transaction(() =>
      recipes.save({ projectId, path, body, expectedVersion, confirm: 'explicit', ...more }),
    );
  const refused = (run: () => unknown) => {
    try {
      run();
    } catch (failure) {
      if (failure instanceof RecipeRefused) return failure.reason;
      throw failure;
    }
    return 'saved';
  };
  const resolve = (commands: string[]) => recipes.resolveChecks({ projectId, commands }).resolved;
  return {
    recipes,
    store,
    projectId,
    folder,
    directory,
    home,
    git,
    manifest,
    save,
    refused,
    resolve,
  };
}

test('a save writes the file and the next version, and refuses a stale version, an edit on disk and a path through a link', (t) => {
  const { store, projectId, folder, directory, save, refused } = harness(t);
  const path = '.crewkite/recipes/tidy.json';
  const file = join(folder, path);

  const first = save(path, base, 0);
  assert(!('stale' in first));
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(base, null, 2)}\n`);
  assert.deepEqual(
    [first.record.version, first.record.versionHash, first.approved, first.schedule],
    [1, hashCanonical(base), [], null],
  );
  assert.equal(store.recipeFolder(projectId), '.crewkite/recipes');
  const recipeId = first.record.id;

  const reviewer = {
    role: 'reviewer' as const,
    selection: { family: 'openai' as const, model: 'fixture-model-c', effort: 'default' },
  };
  const next: PlanRecipe = {
    ...base,
    crew: {
      ...base.crew,
      members: [
        base.crew.members[0],
        { ...base.crew.members[1], selection: { ...base.crew.members[1].selection, model: 'm' } },
        reviewer,
      ],
    },
    checks: [{ command: 'pnpm run lint' }],
  };
  const second = save(path, next, 1, { recipeId });
  assert(!('stale' in second));
  assert.deepEqual(second.changed.toSorted(), [
    'checks.pnpm run lint',
    'checks.pnpm run test',
    'crew.builder.model',
    'crew.reviewer.effort',
    'crew.reviewer.family',
    'crew.reviewer.model',
  ]);
  assert.equal(store.recipeVersion(recipeId, 2)?.versionHash, hashCanonical(next));
  assert.equal(store.recipe(recipeId)?.versionHash, hashCanonical(next));

  assert.deepEqual(save(path, base, 1, { recipeId }), { stale: 2 });

  // Someone edits the file by hand. Saving over it would lose that edit, so it refuses and the
  // edit stays. Saving the file's own content records it as the next version.
  const edited = JSON.stringify(base);
  writeFileSync(file, edited);
  assert.equal(
    refused(() => save(path, next, 2, { recipeId })),
    'recipe-file-changed',
  );
  assert.equal(readFileSync(file, 'utf8'), edited);
  assert.equal(
    refused(() => save(path, base, 2, { recipeId })),
    'saved',
  );

  // A first save neither takes a path another recipe holds nor writes over a file it never saved.
  // A path that differs only in letter case is the same file on a case-insensitive disk.
  for (const taken of [path, '.crewkite/recipes/TIDY.json'])
    assert.equal(
      refused(() => save(taken, base, 0)),
      'recipe-path-taken',
      taken,
    );
  writeFileSync(join(folder, '.crewkite/recipes/other.json'), '{}\n');
  assert.equal(
    refused(() => save('.crewkite/recipes/other.json', base, 0)),
    'recipe-file-exists',
  );

  // A link inside the project can point anywhere. Nothing is written through it.
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(folder, 'linked'));
  assert.equal(
    refused(() => save('linked/tidy.json', base, 0)),
    'recipe-path-unsafe',
  );
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(store.recipe(recipeId)?.version, 3);
  assert.equal(store.recipes(projectId).length, 1);
});

test('a read reports each file as current, changed, missing, invalid with its line, or not saved here, and lists no more than the bound', (t) => {
  const { recipes, projectId, folder, directory, save } = harness(t);
  const at = (name: string) => `.crewkite/recipes/${name}.json`;
  const write = (name: string, text: string) => writeFileSync(join(folder, at(name)), text);
  for (const name of ['current', 'changed', 'missing', 'invalid']) save(at(name), base, 0);
  write('changed', JSON.stringify({ ...base, name: 'Tidy more' }));
  rmSync(join(folder, at('missing')));
  const invalid = JSON.stringify(base, null, 2).replace('"maxSlices": 3', '"maxSlices": 30');
  const line = invalid.split('\n').findIndex((text) => text.includes('maxSlices')) + 1;
  write('invalid', invalid);
  write('unrecorded', JSON.stringify({ ...base, name: 'From a teammate' }));
  // Only plain JSON files directly in the folder count: no other name, no subfolder, no link.
  write('notes', 'x');
  writeFileSync(join(folder, '.crewkite/recipes/readme.md'), '# Recipes\n');
  mkdirSync(join(folder, '.crewkite/recipes/nested'));
  writeFileSync(join(folder, '.crewkite/recipes/nested/deep.json'), JSON.stringify(base));
  writeFileSync(join(directory, 'outside.json'), JSON.stringify(base));
  symlinkSync(join(directory, 'outside.json'), join(folder, at('linked')));

  const read = recipes.list(projectId);
  assert.equal(read.folder, '.crewkite/recipes');
  const rows = read.recipes.map((entry) => [
    entry.path,
    entry.file,
    entry.name,
    entry.record?.version ?? null,
    entry.problem,
  ]);
  assert.deepEqual(rows, [
    [at('changed'), 'changed', 'Tidy more', 1, null],
    [at('current'), 'current', 'Tidy', 1, null],
    [
      at('invalid'),
      'invalid',
      'Tidy',
      1,
      `Line ${line}: run.maxSlices: Too big: expected number to be <=8.`,
    ],
    [at('missing'), 'missing', 'Tidy', 1, null],
    [at('notes'), 'invalid', null, null, 'Line 1 is not valid JSON.'],
    [at('unrecorded'), 'unrecorded', 'From a teammate', null, null],
  ]);
  assert.equal(read.more, 0);

  for (let index = 0; index < 64; index++) write(`extra-${String(index).padStart(2, '0')}`, '{}');
  // Saved recipes come first, so files nobody saved here never push one past the bound.
  const bounded = recipes.list(projectId);
  assert.deepEqual([bounded.recipes.length, bounded.more], [64, 6]);
  assert.deepEqual(
    bounded.recipes.slice(0, 5).map((entry) => entry.file),
    ['changed', 'current', 'invalid', 'missing', 'invalid'],
  );
});

test('a recipe written by the save reads back as current', (t) => {
  const { recipes, projectId, folder, save } = harness(t);
  const path = 'recipes/hourly.json';
  // The waiting limit is left out, so parsing fills its default. The hash is over the parsed
  // value, so the file the save writes and a hand-written copy of it both read as current.
  const { maxWaiting: _left, ...budget } = scheduled([]).budget ?? {};
  const body = { ...scheduled([]), budget } as PlanRecipe;
  const saved = save(path, body, 0);
  assert(!('stale' in saved));
  const parsed = PlanRecipeSchema.parse(body);
  assert.equal(saved.record.versionHash, hashCanonical(parsed));

  const read = () => recipes.read({ projectId, recipeId: saved.record.id });
  const first = read();
  assert.equal(first.entry.file, 'current');
  assert.deepEqual([first.recipe, first.saved, first.savedVersion], [parsed, parsed, 1]);
  assert.deepEqual(
    first.readiness.map((entry) => [entry.role, entry.ready, entry.reason]),
    [
      ['orchestrator', true, null],
      ['builder', false, 'not-connected'],
    ],
  );

  const reordered = Object.fromEntries(Object.entries(body).reverse());
  writeFileSync(join(folder, path), JSON.stringify(reordered));
  assert.equal(read().entry.file, 'current');
});

test('a check resolves from the committed HEAD, and a save refuses when a check moved since it was shown or resolves to nothing', (t) => {
  const { home, folder, directory, git, manifest, save, refused, resolve } = harness(t);
  const path = 'recipes/nightly.json';
  const [shown, nothing] = resolve(['pnpm run test', 'pnpm run lint']);
  assert.equal(shown.resolved, 'pnpm run test runs test: node --test');
  assert.deepEqual([nothing.resolved, nothing.digest], [null, null]);
  assert(shown.digest);
  // The files read from HEAD are gone once the answer is known.
  assert.deepEqual(readdirSync(join(home, 'recipes')), []);

  // An edit nobody committed is not what a run's copy starts from, so the digest holds.
  manifest('node --test --watch');
  assert.deepEqual(resolve(['pnpm run test']), [shown]);
  const seen = [{ command: 'pnpm run test', digest: shown.digest }];
  const saved = save(path, scheduled(['pnpm run test']), 0, { seen });
  assert(!('stale' in saved));
  assert.deepEqual(saved.approved, [
    { command: 'pnpm run test', resolved: shown.resolved, digest: shown.digest },
  ]);
  const recipeId = saved.record.id;

  // Once committed, the script behind the check changed, and the review shown before is stale.
  git('commit', '--quiet', '-am', 'watch');
  assert.notEqual(resolve(['pnpm run test'])[0].digest, shown.digest);
  const next = { ...scheduled(['pnpm run test']), name: 'Nightly' };
  assert.equal(
    refused(() => save(path, next, 1, { recipeId, seen })),
    'recipe-checks-moved',
  );
  assert.equal(
    refused(() => save(path, next, 1, { recipeId })),
    'recipe-checks-unseen',
  );
  assert.equal(
    refused(() => save(path, scheduled(['pnpm run lint']), 1, { recipeId, seen })),
    'recipe-check-unresolved',
  );
  // A once loop in the past would start the moment it is armed.
  assert.equal(
    refused(() =>
      save(
        path,
        {
          ...scheduled(['pnpm run test']),
          trigger: { kind: 'once', at: '2000-01-01T00:00:00.000Z' },
        },
        1,
        { recipeId, seen },
      ),
    ),
    'schedule-time-passed',
  );
  // Checklist work is off in the app: a loop that names a checklist is refused at the save.
  assert.equal(
    refused(() =>
      save(
        path,
        { ...scheduled(['pnpm run test']), work: { kind: 'checklist', path: 'TODO.md' } },
        1,
        { recipeId, seen },
      ),
    ),
    'recipe-work-unavailable',
  );
  // Report runs are off in the app: a report recipe with a trigger would arm a loop whose every
  // start is refused, so the save refuses it.
  const reporting = scheduled(['pnpm run test']);
  assert.equal(
    refused(() =>
      save(
        path,
        {
          ...reporting,
          shape: 'report',
          crew: {
            ...reporting.crew,
            members: [
              ...reporting.crew.members,
              { role: 'challenger', selection: reporting.crew.members[0].selection },
            ],
          },
        },
        1,
        { recipeId, seen },
      ),
    ),
    'recipe-shape-unavailable',
  );

  // The digest is the pin a thread takes in a checkout of the same commit. A command whose digest
  // covers no project file, such as a folder or a program path, resolves to nothing. The digest
  // never covers the program, so a program path resolves to nothing whatever file it also names.
  writeFileSync(join(folder, 'Makefile'), 'lint:\n\teslint .\ndocs:\n\tmkdocs build\n');
  for (const name of [
    'scripts/x.mjs',
    'tests/test_a.py',
    'docs/index.md',
    'gradlew',
    'build.gradle',
  ]) {
    mkdirSync(join(folder, name, '..'), { recursive: true });
    writeFileSync(join(folder, name), 'x\n');
  }
  git('add', '.');
  git('commit', '--quiet', '-m', 'more checks');
  const checkout = join(directory, 'checkout');
  git('worktree', 'add', '--quiet', '--detach', checkout, 'HEAD');
  const pin = (command: string) =>
    sourceDigest(
      detectChecks(checkout).find((check) => check.command === command) ?? {
        kind: 'custom',
        source: 'custom',
        command,
      },
      checkout,
    );
  const rows: [string, string | null][] = [
    ['pnpm run test', pin('pnpm run test')],
    ['make lint', pin('make lint')],
    ['node scripts/x.mjs', pin('node scripts/x.mjs')],
    ['make docs', null],
    ['pytest tests/', null],
    ['./gradlew test', null],
    ['./gradlew --build-file build.gradle test', null],
    ['./scripts/x.mjs package.json', null],
  ];
  assert.equal(detectChecks(checkout).filter((check) => check.command === 'make lint').length, 1);
  assert.deepEqual(
    resolve(rows.map(([command]) => command)).map((check) => [check.command, check.digest]),
    rows,
  );

  // An absolute path is refused in a name=value word too, as the thread's rule reads one.
  assert.throws(
    () => resolve([`tsc --project=${join(folder, 'tsconfig.json')}`]),
    (failure) =>
      failure instanceof RecipeRefused &&
      failure.next ===
        'A check command cannot name an absolute path. A recipe travels with the project.',
  );

  // A manual recipe approves nothing, so a check that resolves to nothing yet still saves.
  const manual = save(path, { ...base, checks: [{ command: 'pnpm run lint' }] }, 1, { recipeId });
  assert(!('stale' in manual));
  assert.deepEqual([manual.record.version, manual.approved], [2, []]);

  // Files over the read limit are not copied from HEAD, and still answer as a checkout does.
  const large = (text: string) => `${text}${'#'.repeat(1024 * 1024)}\n`;
  writeFileSync(join(folder, 'pnpm-lock.yaml'), large("lockfileVersion: '9.0'\n"));
  writeFileSync(join(folder, 'Makefile'), large('lint:\n\teslint .\n'));
  writeFileSync(join(folder, 'fixtures.json'), large('{}\n'));
  git('add', '.');
  git('commit', '--quiet', '-m', 'large files');
  const larger = join(directory, 'checkout-large');
  git('worktree', 'add', '--quiet', '--detach', larger, 'HEAD');
  const commands = ['pnpm run test', 'make lint', 'node fixtures.json', 'node scripts/x.mjs'];
  assert.deepEqual(
    resolve(commands),
    commands.map((command) => resolveCheck(command, larger)),
  );
  assert.deepEqual(resolveAtHead(join(directory, 'no-repository'), home, []), []);
});

test('a check command with a shell or inline code refuses', (t) => {
  const { save, refused, resolve } = harness(t);
  const commands = [
    'sh -c test',
    'bash scripts/test.sh',
    'pnpm test && rm -rf build',
    'env CI=1 pnpm test',
    'npx vitest',
    'node -e process.exit(0)',
    'python3 -c 1',
    'pnpm test ../outside',
  ];
  for (const command of commands) {
    assert.throws(
      () => resolve(['pnpm run test', command]),
      (failure) =>
        failure instanceof RecipeRefused &&
        failure.reason === 'recipe-check-refused' &&
        failure.next === ADDED_RULE,
      command,
    );
    assert.equal(
      refused(() => save('recipes/a.json', { ...base, checks: [{ command }] }, 0)),
      'recipe-check-refused',
      command,
    );
  }
  // An absolute path names a place on one computer, so a recipe that travels cannot hold it.
  assert.throws(
    () => resolve(['pnpm test /tmp/report.xml']),
    (failure) =>
      failure instanceof RecipeRefused &&
      failure.reason === 'recipe-check-refused' &&
      failure.next ===
        'A check command cannot name an absolute path. A recipe travels with the project.',
  );
  assert.equal(
    refused(() => save('recipes/a.json', base, 0)),
    'saved',
  );
});

test('forgetting a recipe drops its record and versions and leaves the file', async (t) => {
  lockPath(t);
  const { controller, command, draft, source } = await setup(t);
  const { projectId } = draft.payload as { projectId: string };
  const path = '.crewkite/recipes/tidy.json';
  const events = () =>
    controller.store
      .eventsAfter('0')
      .filter((event) => event.type === 'recipes.changed')
      .map((event) => event.payload);
  const saved = await controller.execute(
    command(
      'SaveRecipe',
      { projectId, path, body: base, expectedVersion: 0, confirm: 'explicit' },
      0,
    ),
    'local-owner',
  );
  assert(saved.data?.kind === 'recipe-saved', JSON.stringify(saved));
  const recipeId = saved.data.record.id;

  // A run that is still going holds its recipe.
  const run = (state: string) =>
    controller.store.transaction(() =>
      controller.store.db
        .prepare(
          `INSERT INTO recipe_runs(id,project_id,recipe_id,task_id,origin,state,body,started_at)
          VALUES ('rrn_1',?,?,'tsk_run','manual',?,'{}','2026-11-18T09:00:00.000Z')
          ON CONFLICT(id) DO UPDATE SET state=excluded.state`,
        )
        .run(projectId, recipeId, state),
    );
  run('running');
  const held = await controller.execute(
    command('ForgetRecipe', { recipeId, confirm: 'explicit' }, 0),
    'local-owner',
  );
  assert.deepEqual(
    [held.outcome, held.reason, held.next],
    [
      'blocked',
      'recipe-run-active',
      'A run of this recipe is still going or waits on you. Finish or delete it first.',
    ],
  );
  run('accepted');

  const forget = command('ForgetRecipe', { recipeId, confirm: 'explicit' }, 0);
  assert.equal((await controller.execute(forget, 'local-owner')).outcome, 'applied');
  // A repeated key answers from its receipt and forgets nothing twice.
  assert.equal((await controller.execute(forget, 'local-owner')).outcome, 'already-applied');
  assert.equal(controller.store.recipe(recipeId), undefined);
  assert.equal(controller.store.recipeVersion(recipeId, 1), undefined);
  assert.ok(existsSync(join(source.directory, path)));
  assert.deepEqual(events(), [
    { projectId, recipeId },
    { projectId, recipeId },
  ]);

  const read = await controller.execute(command('ReadRecipes', { projectId }), 'local-owner');
  assert(read.data?.kind === 'recipes', JSON.stringify(read));
  assert.deepEqual(
    read.data.recipes.map((entry) => [entry.path, entry.file, entry.record]),
    [[path, 'unrecorded', null]],
  );
});

test('the recipe list tells the editor which switched-off choices it may offer, from the controller options', async (t) => {
  // Claim: the editor reads the same options that refuse a save or a run, so the app shows both
  // choices as unavailable, and turning an option on offers that choice with no other change.
  lockPath(t);
  for (const options of [{}, { checklistWork: true }, { reportRuns: true }] as const) {
    const { controller, command, draft } = await setup(t, options);
    const { projectId } = draft.payload as { projectId: string };
    const read = await controller.execute(command('ReadRecipes', { projectId }), 'local-owner');
    assert(read.data?.kind === 'recipes', JSON.stringify(read));
    assert.deepEqual(read.data.available, {
      checklistWork: 'checklistWork' in options,
      reportRuns: 'reportRuns' in options,
    });
  }
});
