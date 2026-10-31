import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from './runtime.ts';

const app = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const node = realpathSync(process.execPath);

test('a source desktop on the real controller starts apps/controller and never the demo controller', {
  skip: process.versions.node !== '24.22.0',
}, (t) => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-runtime-')));
  // The guard takes the person's home folder from the system, which follows HOME.
  const savedHome = process.env.HOME;
  process.env.HOME = state;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(state, { recursive: true, force: true });
  });
  const environment = {
    CREWKITE_HOME: join(state, '.crewkite'),
    CREWKITE_PROFILE: join(state, '.crewkite-desktop'),
    CREWKITE_SOURCE_NODE: node,
    CREWKITE_SOURCE_NODE_HASH: createHash('sha256').update(readFileSync(node)).digest('hex'),
    CREWKITE_SOURCE_STATE_ROOT: state,
  };
  const paths = resolveRuntime(app, environment);
  assert.equal(paths.mode, 'workspace');
  assert.equal(paths.controller, join(paths.root, 'apps/controller/src/main.ts'));
  assert.equal(paths.home, environment.CREWKITE_HOME);
  // A home in the checkout's internal folder is refused before anything is created there.
  assert.throws(
    () =>
      resolveRuntime(app, {
        ...environment,
        CREWKITE_HOME: join(paths.root, 'internal', 'demo-home'),
      }),
    /in or around this checkout/,
  );
  // A state root that is not the person's home folder is refused.
  assert.throws(
    () => resolveRuntime(app, { ...environment, CREWKITE_SOURCE_STATE_ROOT: tmpdir() }),
    /must be your home folder/,
  );
});
