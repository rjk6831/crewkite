import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareStateDirectory } from './demo-state.ts';

if (process.versions.node !== '24.22.0') throw new Error('The demo needs Node 24.22.0.');
const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const internal = existsSync(join(root, 'internal/tools'))
  ? dirname(realpathSync(join(root, 'internal/tools')))
  : join(root, 'internal');
if (!existsSync(internal)) prepareStateDirectory(root, internal);
const home = resolve(process.env.CREWKITE_HOME ?? join(internal, 'demo-home'));
const profile = resolve(process.env.CREWKITE_PROFILE ?? join(internal, 'desktop-profile'));
if (Buffer.byteLength(join(home, 'control.sock')) > 100)
  throw new Error('Choose a shorter demo home under the repository internal directory.');
for (const directory of [home, profile]) {
  if (!directory.startsWith(`${internal}/`) && !directory.startsWith(`${root}/internal/`))
    throw new Error('Demo state and profile must stay under this checkout internal directory.');
  const base = directory.startsWith(`${internal}/`) ? internal : join(root, 'internal');
  prepareStateDirectory(base, directory);
}
const require = createRequire(join(root, 'apps/desktop/package.json'));
const executable: string = require('electron');
const node = realpathSync(process.execPath);
console.log(`CREWKITE_HOME=${home}`);
console.log(
  `Restart controller: CREWKITE_HOME='${home}' '${node}' '${join(root, 'scripts/demo-controller.ts')}'`,
);
const child = spawn(executable, [join(root, 'apps/desktop')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    LANG: 'en_US.UTF-8',
    CREWKITE_HOME: home,
    CREWKITE_PROFILE: profile,
    CREWKITE_SOURCE_NODE: node,
    CREWKITE_SOURCE_NODE_HASH: createHash('sha256').update(readFileSync(node)).digest('hex'),
  },
});
child.once('error', () => {
  console.error('The desktop could not start. Install the pinned desktop binary first.');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
