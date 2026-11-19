import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GOOGLE_TERMS_VERSION } from '@crewkite/contracts';
import { acknowledgeGoogleTerms } from '../commands/google-terms.ts';
import { Store } from './index.ts';
import { assertSchemaCompatibility } from './schema-compatibility.ts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const at = '2026-10-02T09:00:00.000Z';

// Every table as sorted rows of SQL literals, so a changed byte, type or row shows.
function dump(db: DatabaseSync) {
  const tables: Record<string, string[]> = {};
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name");
  for (const { name } of names.all() as { name: string }[]) {
    const row = (
      db.prepare('SELECT name FROM pragma_table_info(?)').all(name) as { name: string }[]
    )
      .map((column) => `quote("${column.name}")`)
      .join(" || ',' || ");
    tables[name] = db
      .prepare(`SELECT ${row} AS row FROM "${name}"`)
      .all()
      .map((value) => value.row as string)
      .sort();
  }
  return { version: db.prepare('PRAGMA user_version').get()?.user_version, tables };
}
type Dump = ReturnType<typeof dump>;

const metadata = (db: DatabaseSync) =>
  db
    .prepare('SELECT * FROM google_metadata_operations ORDER BY command_id')
    .all()
    .map((row) => ({ ...row }));

// A migration folder holding only the files a release shipped, up to `version`.
function migrationsThrough(directory: string, version: number) {
  const folder = join(directory, `migrations-${version}`);
  mkdirSync(folder);
  for (const file of readdirSync(migrations))
    if (Number(file.slice(0, 3)) <= version)
      copyFileSync(join(migrations, file), join(folder, file));
  return folder;
}

// A home as a release left it: that release's migrations and the rows a day of use writes.
// `rows` adds what depends on the release's own schema.
function releasedHome(t: TestContext, version: number, rows: string) {
  const directory = mkdtempSync(join(tmpdir(), 'ck-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'home', 'state.sqlite');
  const old = new Store(database);
  try {
    old.applyMigrations(migrationsThrough(directory, version));
    old.transaction(() => {
      old.put('project', 'prj_ledger', 1, { id: 'prj_ledger', name: 'Ledger' });
      old.put('task', 'tsk_rounding', 3, {
        id: 'tsk_rounding',
        projectId: 'prj_ledger',
        title: 'Round invoice totals half up',
      });
      old.saveReceipt('cmd_01JB7Q0V2N8W3X4Y5Z6A7B8C9D', 'ab'.repeat(32), 'desktop', {
        outcome: 'applied',
      });
      old.setCreditSpending('openai', true);
      old.setFamilyModel('anthropic', { model: 'model-b', effort: 'high' });
      old.markConnectedOnce('google');
      old.recordGoogleUsageObservation(at);
      acknowledgeGoogleTerms(old, GOOGLE_TERMS_VERSION, at);
    });
    old.db.exec(`
      INSERT INTO chat_threads(task_id, body) VALUES
        ('tsk_rounding', '{"taskId":"tsk_rounding","family":"anthropic","model":"model-b"}');
      INSERT INTO chat_turns(id, task_id, sequence, body) VALUES
        ('turn_1', 'tsk_rounding', 0, '{"id":"turn_1","sequence":0,"state":"done"}'),
        ('turn_2', 'tsk_rounding', 1, '{"id":"turn_2","sequence":1,"state":"interrupted"}');
      -- The chat writer inserts an entry and then sets its body, which indexes it for search.
      INSERT INTO conversation_entries(id, task_id, body) VALUES
        ('msg_1', 'tsk_rounding', '{}'), ('msg_2', 'tsk_rounding', '{}');
      UPDATE conversation_entries SET body = '{"id":"msg_1","kind":"user-message","text":"Round totals half up.","author":{"turnId":"turn_1"}}'
        WHERE id = 'msg_1';
      UPDATE conversation_entries SET body = '{"id":"msg_2","kind":"chat-assistant","text":"invoice.ts rounds half up now.","author":{"turnId":"turn_1"}}'
        WHERE id = 'msg_2';
      INSERT INTO project_notes(id, project_id, text, created_at) VALUES
        ('note_1', 'prj_ledger', 'Totals round half up. Never truncate.', '2026-10-01T08:00:00.000Z');
      INSERT INTO chat_hunk_decisions(task_id, path, hunk, base, blob) VALUES
        ('tsk_rounding', 'src/invoice.ts', '${'c'.repeat(64)}', '${'d'.repeat(40)}', '${'e'.repeat(40)}');
      INSERT INTO saved_crews(id, name, position, body) VALUES
        ('crew_review', 'Review pair', 0, '{"id":"crew_review","name":"Review pair","steps":[]}');
      UPDATE crew_settings SET default_crew = 'saved:crew_review', imported_at = '2026-10-01T08:00:00.000Z';
      ${rows}
    `);
    return { directory, database, before: dump(old.db), metadata: metadata(old.db) };
  } finally {
    old.close();
  }
}

// Every table the home had keeps its rows byte for byte, except the ones a migration reshaped on
// purpose. A table added since starts empty: no row is invented for work an older version did.
function assertIntact(before: Dump, after: Dump, reshaped: readonly string[] = []) {
  assert.deepEqual(
    Object.keys(before.tables).filter((name) => !(name in after.tables)),
    [],
  );
  for (const [name, rows] of Object.entries(after.tables))
    if (!reshaped.includes(name)) assert.deepEqual(rows, before.tables[name] ?? [], name);
}

test('a 0.1.0 home upgrades with every row intact, old metadata rows settled by what they recorded and a copy left at its version', (t) => {
  // 0.1.0 shipped migrations 001 to 021. A settled read that ran a process group, one that never
  // spawned, and one still owned when the old controller stopped.
  const {
    database,
    before,
    metadata: rows,
  } = releasedHome(
    t,
    21,
    `INSERT INTO google_metadata_operations
      (command_id, kind, authority_revision, state, pid, process_group, started_at, finished_at)
    VALUES
      ('cmd_grouped', 'usage', 3, 'quiescent', 4242, 4242, '${at}', '${at}'),
      ('cmd_unspawned', 'acp-discover', 3, 'quiescent', NULL, NULL, '${at}', '${at}'),
      ('cmd_owned', 'acp-initialize', 4, 'unknown', 4343, 4343, '${at}', NULL);`,
  );
  const settlement: Record<string, string | null> = {
    cmd_grouped: 'legacy',
    cmd_unspawned: 'never-spawned',
    cmd_owned: null,
  };
  const settled = rows.map((row) => ({
    ...row,
    settlement: settlement[row.command_id as string],
  }));
  const store = new Store(database);
  try {
    store.applyMigrations(migrations);
    const after = dump(store.db);
    assert.equal(after.version, readdirSync(migrations).length);
    // Only the metadata table changed shape. It keeps its rows and says how each one settled.
    assertIntact(before, after, ['google_metadata_operations']);
    assert.deepEqual(metadata(store.db), settled);
  } finally {
    store.close();
  }
  const copy = new DatabaseSync(`${database}.before-v21.sqlite`, { readOnly: true });
  try {
    assert.deepEqual(dump(copy), before);
  } finally {
    copy.close();
  }
});

test('0.1.0 refuses a 0.1.0 home once it is upgraded, and writes nothing to it', (t) => {
  // schema-compatibility.ts is unchanged since v0.1.0, so with 0.1.0's 21 migrations this is the
  // check 0.1.0 runs before it opens a database.
  const { directory, database } = releasedHome(t, 21, '');
  const store = new Store(database);
  try {
    store.applyMigrations(migrations);
  } finally {
    store.close();
  }
  const home = join(directory, 'home');
  const inventory = () =>
    readdirSync(home)
      .sort()
      .map((name) => ({
        name,
        mode: statSync(join(home, name)).mode,
        bytes: readFileSync(join(home, name)),
      }));
  const before = inventory();
  assert.throws(
    () => assertSchemaCompatibility(database, join(directory, 'migrations-21')),
    /^Error: The database needs a newer controller\.$/,
  );
  assert.deepEqual(inventory(), before);
});

test('a schema 22 home upgrades to the current schema with every table byte for byte and its sixteen new tables empty', (t) => {
  // At schema 22, migrations 001 to 022, metadata rows carry a settlement and launches carry an
  // identity. Migrations 023 to 025 add tables and then columns to two of them, and 026 adds the
  // tables for recipes, schedules, runs and results.
  const { database, before } = releasedHome(
    t,
    22,
    `INSERT INTO google_metadata_operations
      (command_id, kind, authority_revision, state, pid, process_group, started_at, finished_at,
       settlement)
    VALUES
      ('cmd_closed', 'usage', 3, 'quiescent', 4242, 4242, '${at}', '${at}', 'closed'),
      ('cmd_owned', 'acp-initialize', 4, 'owned', 4343, 4343, '${at}', NULL, NULL);
    INSERT INTO launch_identity
      (owner_kind, owner_id, boot_source, boot_digest, machine_source, machine_digest, recorded_at)
    VALUES
      ('chat-turn', 'turn_2', 'darwin-boot-session-v1', '${'a'.repeat(64)}', NULL, NULL, '${at}');`,
  );
  const store = new Store(database);
  try {
    store.applyMigrations(migrations);
    const after = dump(store.db);
    assert.equal(after.version, readdirSync(migrations).length);
    assertIntact(before, after);
    assert.deepEqual(
      Object.keys(after.tables).filter((name) => !(name in before.tables)),
      [
        'acceptance_attempts',
        'connection_assignments',
        'connections',
        'dependency_preparations',
        'design_findings',
        'design_system_versions',
        'design_systems',
        'recipe_folders',
        'recipe_runs',
        'recipe_schedules',
        'recipe_versions',
        'recipes',
        'remote_effects',
        'repository_policies',
        'slice_results',
        'writing_rules',
      ],
    );
  } finally {
    store.close();
  }
});
