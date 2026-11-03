import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommandSchema, SAVED_CREWS_MAX, type SavedCrew } from '@crewkite/contracts';
import { createTestClock, createTestIds } from '@crewkite/testkit';
import { Controller } from '../commands/controller.ts';
import { Store } from '../store/index.ts';
import { CrewsRefused, SavedCrews } from './saved-crews.ts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));

const temp = (t: TestContext, prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

function opened(t: TestContext) {
  const store = new Store(join(temp(t, 'crewkite-crews-'), 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(migrations);
  return { store, crews: new SavedCrews(store.db, () => '2026-11-02T10:00:00.000Z') };
}

const pinned = { family: 'openai', model: 'large-1', effort: 'high' } as const;
const crew = (id: string, name: string, extra: Partial<SavedCrew> = {}): SavedCrew => ({
  id,
  name,
  members: [{ role: 'builder', selection: null }],
  flightMode: 'manual',
  ...extra,
});

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (failure) {
    if (failure instanceof CrewsRefused) return failure.reason;
    throw failure;
  }
  return 'accepted';
};

// Claim: saved crews keep the order they were first saved in, an edit keeps its place, names are
// unique across presets and crews whatever their case, and the list stops at its limit.
test('saved crews keep their order, unique names and the limit', (t) => {
  const { crews } = opened(t);
  assert.deepEqual(crews.read(), { crews: [], defaultCrew: 'preset:Solo', imported: false });
  crews.save(
    crew('crew-a', 'Review heavy', {
      // Saved out of order: the roles read back in crew order.
      members: [
        { role: 'challenger', selection: null },
        { role: 'builder', selection: pinned, allowSubagents: false },
      ],
      flightMode: 'glide',
    }),
  );
  crews.save(crew('crew-b', 'Quick'));
  const edited = crews.save(crew('crew-a', 'Review HEAVY', { flightMode: 'balanced' }));
  assert.deepEqual(
    edited.crews.map(({ id, name, flightMode }) => [id, name, flightMode]),
    [
      ['crew-a', 'Review HEAVY', 'balanced'],
      ['crew-b', 'Quick', 'manual'],
    ],
  );
  const ordered = crews.save(
    crew('crew-c', 'Ordered', {
      members: [
        { role: 'orchestrator', selection: null },
        { role: 'builder', selection: pinned, allowSubagents: false },
      ],
    }),
  );
  assert.deepEqual(ordered.crews[2].members, [
    { role: 'builder', selection: pinned, allowSubagents: false },
    { role: 'orchestrator', selection: null },
  ]);
  assert.equal(
    refusal(() => crews.save(crew('crew-d', 'quick'))),
    'crew-name-taken',
  );
  assert.equal(
    refusal(() => crews.save(crew('crew-d', 'full CREW'))),
    'crew-name-taken',
  );
  for (let index = 3; index < SAVED_CREWS_MAX; index++)
    crews.save(crew(`crew-${index}`, `Crew ${index}`));
  assert.equal(
    refusal(() => crews.save(crew('crew-late', 'Late'))),
    'crews-full',
  );
  // An edit at the limit still saves.
  assert.equal(
    refusal(() => crews.save(crew('crew-b', 'Quicker'))),
    'accepted',
  );
  // A crew without a builder never reaches the table.
  assert.throws(() =>
    crews.save({
      ...crew('crew-x', 'No builder'),
      members: [{ role: 'reviewer', selection: null }],
    }),
  );
});

// Claim: one crew is the default for new threads. Only a preset or a saved crew can be the default,
// deleting the default saved crew hands the default back to Solo, and a default saved as Pair, the
// earlier name of Tandem, reads as Tandem.
test('the default crew names a preset or a saved crew and falls back to Solo', (t) => {
  const { store, crews } = opened(t);
  store.db.prepare("UPDATE crew_settings SET default_crew='preset:Pair' WHERE id=1").run();
  assert.equal(crews.read().defaultCrew, 'preset:Tandem');
  crews.save(crew('crew-a', 'Review heavy'));
  assert.equal(crews.setDefault('saved:crew-a').defaultCrew, 'saved:crew-a');
  assert.equal(
    refusal(() => crews.setDefault('saved:crew-z')),
    'crew-choice-unknown',
  );
  assert.equal(crews.setDefault('preset:Tandem').defaultCrew, 'preset:Tandem');
  crews.setDefault('saved:crew-a');
  assert.equal(crews.delete('crew-a').defaultCrew, 'preset:Solo');
  assert.equal(
    refusal(() => crews.delete('crew-a')),
    'crew-not-found',
  );
});

// Claim: the crews the desktop kept in its own storage move once. Entries that do not fit are left
// out without blocking the rest, the default comes along when it still names a crew, and a second
// import changes nothing.
test('crews from the desktop storage are imported once', (t) => {
  const { crews } = opened(t);
  crews.save(crew('crew-a', 'Mine'));
  const read = crews.importOnce(
    [
      crew('crew-a', 'Same id'),
      crew('crew-b', 'MINE'),
      crew('crew-c', 'Tandem'),
      crew('crew-d', 'Kept', { flightMode: 'glide' }),
    ],
    'saved:crew-d',
  );
  assert.deepEqual(
    read.crews.map(({ id }) => id),
    ['crew-a', 'crew-d'],
  );
  assert.equal(read.defaultCrew, 'saved:crew-d');
  assert.equal(read.imported, true);
  const again = crews.importOnce([crew('crew-e', 'Later')], 'preset:Tandem');
  assert.deepEqual(again, read);
  // A default that names a crew that did not come along keeps the controller's own.
  const fresh = opened(t).crews;
  assert.equal(fresh.importOnce([], 'saved:crew-gone').defaultCrew, 'preset:Solo');
});

// Claim: migration 021 follows 020 without a gap. A database at 020 takes a backup copy before it
// upgrades, keeps its rows and starts with no saved crews, Solo as the default and nothing
// imported.
test('migration 021 upgrades a version 20 database after its backup', (t) => {
  const directory = temp(t, 'crewkite-crews-upgrade-');
  const twenty = temp(t, 'crewkite-mig-20-');
  for (const file of readdirSync(migrations))
    if (Number(file.slice(0, 3)) <= 20) copyFileSync(join(migrations, file), join(twenty, file));
  const path = join(directory, 'state.sqlite');
  const old = new Store(path);
  old.applyMigrations(twenty);
  old.db
    .prepare("INSERT INTO entities(id,kind,revision,body) VALUES ('prj_a', 'project', 0, '{}')")
    .run();
  old.close();
  const store = new Store(path);
  t.after(() => store.close());
  store.applyMigrations(migrations);
  assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 21);
  assert.ok(readdirSync(directory).includes('state.sqlite.before-v20.sqlite'));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM entities').get()?.n, 1);
  assert.deepEqual(new SavedCrews(store.db, () => '').read(), {
    crews: [],
    defaultCrew: 'preset:Solo',
    imported: false,
  });
});

// Claim: the commands reach the crews through the real controller, a refusal carries the sentence
// for the person, a replayed key answers from its receipt, and the crews survive a restart.
test('crew commands run through the controller and survive a restart', async (t) => {
  const home = temp(t, 'crewkite-crews-home-');
  const clock = createTestClock();
  const id = createTestIds(clock.now(), 9000n);
  let controller = new Controller({ home, now: clock.now, id });
  t.after(() => controller.close());
  const command = (name: string, payload: unknown, key = id('cmd')) =>
    CommandSchema.parse({
      protocol: 1,
      key,
      actor: { id: 'crews-fixture', kind: name === 'ReadSavedCrews' ? 'cli' : 'desktop' },
      command: name,
      payload,
      ...(name === 'ReadSavedCrews' ? {} : { expectedRevision: 0 }),
    });
  const run = (name: string, payload: unknown, key?: string) =>
    controller.commitCommand(command(name, payload, key), 'crews-fixture');

  const save = id('cmd');
  const saved = run('SaveCrew', { crew: crew('crew-a', 'Review heavy') }, save);
  assert.equal(saved.outcome, 'applied');
  assert.equal(saved.data?.kind, 'saved-crews');
  assert.equal(
    run('SaveCrew', { crew: crew('crew-a', 'Review heavy') }, save).outcome,
    'already-applied',
  );
  const taken = run('SaveCrew', { crew: crew('crew-b', 'review heavy') });
  assert.deepEqual(
    { outcome: taken.outcome, reason: taken.reason, next: taken.next },
    {
      outcome: 'blocked',
      reason: 'crew-name-taken',
      next: 'Another crew has this name. Pick another name.',
    },
  );
  assert.equal(run('SetDefaultCrew', { id: 'saved:crew-a' }).outcome, 'applied');
  const imported = run('ImportSavedCrews', { crews: [crew('crew-c', 'Old')], defaultCrew: null });
  assert.deepEqual(
    imported.data?.kind === 'saved-crews' && imported.data.crews.map(({ id }) => id),
    ['crew-a', 'crew-c'],
  );

  await controller.close();
  controller = new Controller({ home, now: clock.now, id });
  const read = run('ReadSavedCrews', {});
  assert.equal(read.data?.kind, 'saved-crews');
  if (read.data?.kind !== 'saved-crews') return;
  assert.deepEqual(
    read.data.crews.map(({ name }) => name),
    ['Review heavy', 'Old'],
  );
  assert.equal(read.data.defaultCrew, 'saved:crew-a');
  assert.equal(read.data.imported, true);
  assert.equal(run('DeleteCrew', { id: 'crew-a' }).data?.kind, 'saved-crews');
  const after = run('ReadSavedCrews', {});
  assert.equal(after.data?.kind === 'saved-crews' && after.data.defaultCrew, 'preset:Solo');
});
