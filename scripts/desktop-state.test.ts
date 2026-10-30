import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sourceDesktopState } from './desktop-state.ts';

test('the source desktop keeps its CrewKite state in the home folder and away from the checkout', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-desktop-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const person = join(base, 'person');
  const checkout = join(person, 'code', 'checkout');
  const elsewhere = join(person, 'elsewhere');
  mkdirSync(join(elsewhere, 'tools'), { recursive: true });
  mkdirSync(checkout, { recursive: true });
  mkdirSync(join(base, 'other'));
  symlinkSync(elsewhere, join(checkout, 'internal'));
  const ok = {
    root: person,
    home: join(person, '.crewkite'),
    profile: join(person, '.crewkite-p'),
  };
  const refused = /in or around this checkout/;
  const rows = [
    { name: 'the usual folders', ...ok, error: null },
    {
      name: 'a home in the internal folder',
      ...ok,
      home: join(checkout, 'internal', 'demo-home'),
      error: refused,
    },
    {
      name: 'a profile where internal points',
      ...ok,
      profile: join(elsewhere, 'profile'),
      error: refused,
    },
    { name: 'the internal folder itself', ...ok, home: join(checkout, 'internal'), error: refused },
    { name: 'a folder that holds the checkout', ...ok, home: join(person, 'code'), error: refused },
    { name: 'the checkout itself', ...ok, profile: checkout, error: refused },
    { name: 'a folder inside the checkout', ...ok, home: join(checkout, 'state'), error: refused },
    {
      name: 'a home outside the state root',
      ...ok,
      home: join(base, 'outside'),
      error: /inside your home folder/,
    },
    {
      name: 'the state root as the home',
      ...ok,
      home: person,
      error: /inside your home folder|in or around/,
    },
    {
      name: 'a state root that is not the home folder',
      ...ok,
      root: join(base, 'other'),
      home: join(base, 'other', 'h'),
      profile: join(base, 'other', 'p'),
      error: /must be your home folder/,
    },
    { name: 'one folder for both', ...ok, profile: ok.home, error: /separate/ },
    { name: 'a profile inside the home', ...ok, profile: join(ok.home, 'p'), error: /separate/ },
  ];
  for (const row of rows) {
    const run = () => sourceDesktopState(checkout, row.root, row.home, row.profile, person);
    if (row.error) assert.throws(run, row.error, row.name);
    else assert.deepEqual(run(), { root: person, home: row.home, profile: row.profile }, row.name);
  }
});
