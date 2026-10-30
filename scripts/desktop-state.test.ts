import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sourceDesktopState } from './desktop-state.ts';

test('the source desktop keeps its CrewKite state out of internal and inside the state root', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-desktop-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const checkout = join(base, 'checkout');
  const person = join(base, 'person');
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(join(elsewhere, 'tools'), { recursive: true });
  mkdirSync(checkout);
  mkdirSync(person);
  symlinkSync(elsewhere, join(checkout, 'internal'));
  const ok = { home: join(person, '.crewkite'), profile: join(person, '.crewkite-desktop') };
  const rows = [
    { name: 'the usual folders', ...ok, error: null },
    {
      name: 'a home in the checkout internal folder',
      ...ok,
      home: join(checkout, 'internal', 'demo-home'),
      error: /internal folder/,
    },
    {
      name: 'a profile where internal points',
      ...ok,
      profile: join(elsewhere, 'profile'),
      error: /internal folder/,
    },
    {
      name: 'a home outside the state root',
      ...ok,
      home: join(base, 'outside'),
      error: /inside your home folder/,
    },
    { name: 'the state root as the home', ...ok, home: person, error: /inside your home folder/ },
    { name: 'one folder for both', ...ok, profile: ok.home, error: /separate/ },
    { name: 'a profile inside the home', ...ok, profile: join(ok.home, 'p'), error: /separate/ },
  ];
  for (const row of rows) {
    const run = () => sourceDesktopState(checkout, person, row.home, row.profile);
    if (row.error) assert.throws(run, row.error, row.name);
    else assert.deepEqual(run(), { root: person, home: row.home, profile: row.profile }, row.name);
  }
});
