import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareStateDirectory } from './demo-state.ts';
import { sourceDesktopState } from './desktop-state.ts';

// Starts the desktop from this checkout on the real controller and your own CrewKite home, the
// one the command line uses. `pnpm demo` stays the synthetic project with scripted providers.
if (process.versions.node !== '24.22.0') throw new Error('The desktop needs Node 24.22.0.');
const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const stateRoot = realpathSync(homedir());
const state = sourceDesktopState(
  root,
  stateRoot,
  process.env.CREWKITE_HOME ?? join(stateRoot, '.crewkite'),
  process.env.CREWKITE_PROFILE ?? join(stateRoot, '.crewkite-desktop'),
);
prepareStateDirectory(state.root, state.home);
prepareStateDirectory(state.root, state.profile);
const require = createRequire(join(root, 'apps/desktop/package.json'));
const executable: string = require('electron');
const node = realpathSync(process.execPath);
console.log(`CREWKITE_HOME=${state.home}`);
const child = spawn(executable, [join(root, 'apps/desktop')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    LANG: 'en_US.UTF-8',
    CREWKITE_HOME: state.home,
    CREWKITE_PROFILE: state.profile,
    CREWKITE_SOURCE_NODE: node,
    CREWKITE_SOURCE_NODE_HASH: createHash('sha256').update(readFileSync(node)).digest('hex'),
    CREWKITE_SOURCE_STATE_ROOT: state.root,
  },
});
child.once('error', () => {
  console.error('The desktop could not start. Run pnpm desktop:install first.');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
