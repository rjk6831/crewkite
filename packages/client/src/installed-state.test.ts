import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  prepareInstalledState,
  preparePrivateStateDirectory,
  resolveInstalledState,
} from './installed-state.ts';

test('installed clients choose one state root and require complete isolated overrides', () => {
  for (const [platform, environment, root] of [
    ['darwin', {}, '/people/ray/Library/Application Support/CrewKite'],
    ['linux', {}, '/people/ray/.local/share/crewkite'],
    ['linux', { XDG_DATA_HOME: '' }, '/people/ray/.local/share/crewkite'],
    ['linux', { XDG_DATA_HOME: '/data with spaces' }, '/data with spaces/crewkite'],
    [
      'darwin',
      { CREWKITE_HOME: '/isolated/home', CREWKITE_PROFILE: '/isolated/profile' },
      '/isolated',
    ],
  ] as const) {
    assert.deepEqual(resolveInstalledState(environment, platform, '/people/ray'), {
      root,
      home: join(root, 'home'),
      profile: join(root, 'profile'),
    });
  }
  for (const environment of [
    { XDG_DATA_HOME: 'relative' },
    { CREWKITE_HOME: '/isolated/home' },
    { CREWKITE_PROFILE: '/isolated/profile' },
    { CREWKITE_HOME: '', CREWKITE_PROFILE: '' },
    { CREWKITE_HOME: 'relative/home', CREWKITE_PROFILE: 'relative/profile' },
    { CREWKITE_HOME: '/isolated/home', CREWKITE_PROFILE: '/elsewhere/profile' },
    { CREWKITE_HOME: '/isolated/home', CREWKITE_PROFILE: '/isolated/home/profile' },
  ])
    assert.throws(() => resolveInstalledState(environment, 'linux', '/people/ray'));
  assert.throws(() => resolveInstalledState({}, 'win32', '/people/ray'), /macOS and Linux/);
});

test('installed state refuses linked or shared directories and application overlap', (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-installed-')));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const state = (root: string) => ({
    root,
    home: join(root, 'home'),
    profile: join(root, 'profile'),
  });
  const valid = state(join(temporary, 'private state'));
  assert.deepEqual(prepareInstalledState(valid), valid);
  assert.deepEqual(prepareInstalledState(valid), valid);
  const provider = join(valid.root, 'providers/fixture/client-home');
  assert.equal(preparePrivateStateDirectory(valid.root, provider), provider);
  const escaped = join(temporary, 'escaped');
  assert.throws(
    () => preparePrivateStateDirectory(valid.root, escaped),
    /inside its selected root/,
  );
  assert.equal(existsSync(escaped), false);
  const shared = state(join(temporary, 'shared'));
  mkdirSync(shared.root, { mode: 0o700 });
  chmodSync(shared.root, 0o755);
  assert.throws(() => prepareInstalledState(shared), /private to their owner/);
  assert.equal(existsSync(shared.home), false);
  const linked = state(join(temporary, 'linked'));
  symlinkSync(valid.root, linked.root);
  assert.throws(() => prepareInstalledState(linked), /without links/);
  const parentLink = join(temporary, 'parent-link');
  symlinkSync(temporary, parentLink);
  assert.throws(() => prepareInstalledState(state(join(parentLink, 'nested'))), /without links/);
  assert.equal(existsSync(join(temporary, 'nested')), false);
  const payload = join(temporary, 'application');
  mkdirSync(payload);
  const overlap = state(join(payload, 'state'));
  assert.throws(() => prepareInstalledState(overlap, payload), /separate from application/);
  assert.equal(existsSync(overlap.root), false);
  assert.throws(
    () => prepareInstalledState(state(temporary), payload),
    /separate from application/,
  );
});
