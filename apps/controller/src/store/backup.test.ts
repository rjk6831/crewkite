import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { Store } from './index.ts';

const migrations = resolve('apps/controller/migrations');
const newest = readdirSync(migrations).filter((file) => /^\d{3}-.*\.sql$/.test(file)).length;
const temp = (t: TestContext, prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
// A migration folder that holds only the first `version` files.
const upTo = (t: TestContext, version: number) => {
  const directory = temp(t, `ck-mig-${version}-`);
  for (const file of readdirSync(migrations))
    if (Number(file.slice(0, 3)) <= version)
      copyFileSync(join(migrations, file), join(directory, file));
  return directory;
};
const upgrade = (database: string, version: number, t: TestContext) => {
  const store = new Store(database);
  store.applyMigrations(upTo(t, version));
  return store;
};
const addRow = (store: Store, id: string) =>
  store.db
    .prepare("INSERT INTO entities(id,kind,revision,body) VALUES (?, 'project', 0, '{}')")
    .run(id);
const backups = (directory: string) =>
  readdirSync(directory)
    .filter((name) => name.includes('.before-v'))
    .sort();
const contents = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: db.prepare('PRAGMA user_version').get()?.user_version,
      ids: db
        .prepare('SELECT id FROM entities ORDER BY id')
        .all()
        .map((row) => row.id),
    };
  } finally {
    db.close();
  }
};

test('a pending migration leaves a private copy at the old version, a fresh database leaves none, and only the newest two stay', (t) => {
  const directory = temp(t, 'ck-backup-');
  const database = join(directory, 'state.sqlite');
  const steps = [
    { to: 5, expect: [] as string[] },
    { to: 10, expect: ['state.sqlite.before-v5.sqlite'] },
    { to: 15, expect: ['state.sqlite.before-v10.sqlite', 'state.sqlite.before-v5.sqlite'] },
    { to: 19, expect: ['state.sqlite.before-v10.sqlite', 'state.sqlite.before-v15.sqlite'] },
  ];
  const rows: string[] = [];
  let previous = 0;
  for (const step of steps) {
    const store = upgrade(database, step.to, t);
    try {
      assert.deepEqual(backups(directory), step.expect, `after upgrading to v${step.to}`);
      assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, step.to);
      if (previous > 0) {
        const copy = join(directory, `state.sqlite.before-v${previous}.sqlite`);
        assert.deepEqual(contents(copy), { version: previous, ids: [...rows].sort() });
        assert.equal(statSync(copy).mode & 0o777, 0o600);
      }
      rows.push(`row-v${step.to}`);
      addRow(store, `row-v${step.to}`);
    } finally {
      store.close();
    }
    previous = step.to;
  }
});

test('a database already at the newest version takes no copy', (t) => {
  const directory = temp(t, 'ck-backup-');
  const database = join(directory, 'state.sqlite');
  upgrade(database, newest, t).close();
  upgrade(database, newest, t).close();
  assert.deepEqual(backups(directory), []);
});

test('a copy never overwrites an existing file', (t) => {
  const directory = temp(t, 'ck-backup-');
  const database = join(directory, 'state.sqlite');
  upgrade(database, 5, t).close();
  const taken = join(directory, 'state.sqlite.before-v5.sqlite');
  writeFileSync(taken, 'not a database');
  upgrade(database, 10, t).close();
  assert.equal(readFileSync(taken, 'utf8'), 'not a database');
  assert.deepEqual(backups(directory), [
    'state.sqlite.before-v5-2.sqlite',
    'state.sqlite.before-v5.sqlite',
  ]);
  assert.equal(contents(join(directory, 'state.sqlite.before-v5-2.sqlite')).version, 5);
});
