import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { CliSettings } from '@crewkite/contracts';
import type { Key } from 'ink';
import {
  familyModel,
  readCrewPresets,
  readThreadDefaults,
} from '../../desktop/src/renderer/settings/preferences.ts';
import { pressed } from './interactive/keys.ts';
import {
  crewkiteHome,
  defaultSettings,
  loadSettings,
  SETTINGS_FILE,
  saveSettings,
  settingsStore,
} from './settings.ts';

test('installed CLI state refuses another home and newer schemas before creating its profile', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-cli-state-')));
  const payload = join(directory, 'CrewKite.app');
  const home = join(directory, 'state/home');
  const profile = join(directory, 'state/profile');
  const keys = ['CREWKITE_INSTALLED_APP', 'CREWKITE_HOME', 'CREWKITE_PROFILE'] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(payload);
  process.env.CREWKITE_INSTALLED_APP = payload;
  process.env.CREWKITE_HOME = home;
  process.env.CREWKITE_PROFILE = profile;
  const alternate = join(directory, 'other');
  for (const run of [
    () => crewkiteHome(alternate),
    () => saveSettings(alternate, defaultSettings()),
  ])
    assert.throws(run, /installed CLI uses its selected workspace/);
  assert.equal(existsSync(alternate), false);
  assert.equal(existsSync(home), false);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const database = join(home, 'state.sqlite');
  const writer = new DatabaseSync(database);
  writer.exec('CREATE TABLE retained(value TEXT); PRAGMA user_version=999;');
  writer.close();
  const before = readFileSync(database);
  for (const run of [() => crewkiteHome(), () => saveSettings(home, defaultSettings())])
    assert.throws(run, /needs a newer controller/);
  assert.deepEqual(readFileSync(database), before);
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(join(home, SETTINGS_FILE)), false);
  rmSync(database);
  assert.equal(crewkiteHome(), home);
  saveSettings(home, defaultSettings());
  for (const path of [join(directory, 'state'), home, profile])
    assert.equal(statSync(path).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, SETTINGS_FILE)).mode & 0o777, 0o600);
});

test('cli.json is checked with the desktop schemas, saved privately and read by its preference functions', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'crewkite-settings-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, SETTINGS_FILE);

  assert.deepEqual(loadSettings(home), { settings: defaultSettings(), problem: null });
  const refused: [unknown, RegExp][] = [
    [{ permissionPolicy: 'allow-everything' }, /permissionPolicy/],
    [{ selection: { family: 'openai', model: '' } }, /selection/],
    [{ keybindings: { send: ['hyper+enter'] } }, /keybindings/],
    [{ animation: 'spin' }, /animation/],
    [{ theme: 'dark', extra: true }, /the file|extra/],
  ];
  for (const [value, where] of refused) {
    writeFileSync(file, JSON.stringify(value));
    const loaded = loadSettings(home);
    assert.deepEqual(loaded.settings, defaultSettings(), JSON.stringify(value));
    assert.match(loaded.problem ?? '', where);
  }
  writeFileSync(file, '{ not json');
  assert.match(loadSettings(home).problem ?? '', /not valid JSON/);

  // An older saved mode name reads as the current one, as the desktop's schema reads it.
  writeFileSync(file, JSON.stringify({ handoffMode: 'balanced', theme: 'light' }));
  assert.equal(loadSettings(home).settings.handoffMode, 'even-spend');

  let current: CliSettings = {
    ...defaultSettings(),
    selection: { family: 'anthropic', model: 'fixture-model', effort: 'high' },
    permissionPolicy: 'allow-edits',
    familyModels: { local: 'fixture-local' },
    crewPresets: {
      Pair: { reviewer: { family: 'local', model: 'fixture-local', effort: 'default' } },
    },
  };
  current = saveSettings(home, current);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadSettings(home).settings, current);
  assert.throws(() => saveSettings(home, { ...current, theme: 'neon' as never }));

  // The renderer's preference functions read and write cli.json through the store.
  const store = settingsStore(
    () => current,
    (next) => {
      current = saveSettings(home, next);
    },
  );
  assert.deepEqual(readThreadDefaults(store), {
    selection: { family: 'anthropic', model: 'fixture-model', effort: 'high' },
    permissionPolicy: 'allow-edits',
    handoffMode: 'most-left',
  });
  const local = {
    family: 'local' as const,
    models: [{ model: 'fixture-local' }] as never,
    defaultModel: 'other',
  };
  assert.equal(familyModel(local, store), 'fixture-local');
  const pair = readCrewPresets(store).find((preset) => preset.name === 'Pair');
  assert.deepEqual(pair?.members.find((member) => member.role === 'reviewer')?.selection, {
    family: 'local',
    model: 'fixture-local',
    effort: 'default',
  });
  assert.throws(() =>
    store.setItem('crewkite-thread-defaults-v1', JSON.stringify({ permissionPolicy: 'yes' })),
  );
  assert.equal(loadSettings(home).settings.permissionPolicy, 'allow-edits');

  // Bindings match their modifiers exactly.
  const key = (patch: Partial<Key>) =>
    ({ ctrl: false, meta: false, shift: false, return: false, escape: false, ...patch }) as Key;
  assert.equal(pressed('ctrl+t', 't', key({ ctrl: true })), true);
  assert.equal(pressed('ctrl+t', 't', key({})), false);
  assert.equal(pressed('alt+enter', '', key({ meta: true, return: true })), true);
  assert.equal(pressed('enter', '', key({ meta: true, return: true })), false);
  assert.equal(pressed('escape', '', key({ escape: true })), true);
});
