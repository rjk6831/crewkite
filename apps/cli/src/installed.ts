import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstalledState, verifyRuntimeIntegrity } from '@crewkite/client/node';
import { assertSchemaCompatibility } from '../../controller/src/store/schema-compatibility.ts';
import { runTerminal } from './main.ts';

try {
  const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
  const { manifest, node } = verifyRuntimeIntegrity(root);
  if (
    manifest.layout !== 'installed' ||
    realpathSync(process.execPath) !== node ||
    process.versions.node !== manifest.node.version
  )
    throw new Error('The installed CLI requires its verified bundled runtime.');
  if (manifest.mode === 'demo' && (!process.env.CREWKITE_HOME || !process.env.CREWKITE_PROFILE))
    throw new Error('An installed demo requires explicit isolated state.');
  const state = resolveInstalledState();
  assertSchemaCompatibility(join(state.home, 'state.sqlite'));
  process.env.CREWKITE_HOME = state.home;
  process.env.CREWKITE_PROFILE = state.profile;
  process.env.CREWKITE_INSTALLED_STATE_ROOT = state.root;
  const appRoot = dirname(root);
  process.env.CREWKITE_INSTALLED_APP =
    process.platform === 'darwin' ? dirname(dirname(dirname(appRoot))) : dirname(dirname(appRoot));
  process.exitCode = await runTerminal(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The installed CLI could not start.');
  process.exitCode = 2;
}
