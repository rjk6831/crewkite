import { type ChildProcess, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ControllerClient, readControllerEndpoint } from '@crewkite/client/node';
import { RuntimeManifestSchema } from '@crewkite/contracts';
import { prepareStateDirectory } from '../../../../scripts/demo-state.ts';
import {
  checkEnvironment,
  spawnCheckChild as spawn,
} from '../../../controller/src/host/check-ownership.ts';

export { prepareStateDirectory } from '../../../../scripts/demo-state.ts';

export const desktopActor = { id: 'desktop', kind: 'desktop' as const };
export type RuntimePaths = {
  root: string;
  node: string;
  controller: string;
  home: string;
  profile: string;
};

function contained(root: string, path: string) {
  const actual = realpathSync(path);
  const part = relative(root, actual);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error('A bundled runtime entry escapes its package.');
  return actual;
}
function readRegular(path: string, limit: number) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const state = fstatSync(file);
    if (!state.isFile() || state.nlink !== 1 || state.size > limit)
      throw new Error('The runtime entry must be a bounded regular file.');
    return readFileSync(file);
  } finally {
    closeSync(file);
  }
}
export function resolveRuntime(appPath: string): RuntimePaths {
  const appRoot = realpathSync(appPath);
  const home = process.env.CREWKITE_HOME;
  const profile = process.env.CREWKITE_PROFILE;
  if (
    !home ||
    !profile ||
    !isAbsolute(home) ||
    !isAbsolute(profile) ||
    home === profile ||
    Buffer.byteLength(join(home, 'control.sock')) > 100
  )
    throw new Error('Choose separate absolute demo home and desktop profile paths.');
  let stateRoots: string[];
  let root: string;
  let node: string;
  let expectedHash: string;
  let platform: string;
  let arch: string;
  if (existsSync(join(appRoot, 'runtime'))) {
    root = contained(appRoot, join(appRoot, 'runtime'));
    stateRoots = [dirname(appRoot)];
    const manifest = RuntimeManifestSchema.parse(
      JSON.parse(readRegular(contained(root, join(root, 'manifest.json')), 4096).toString('utf8')),
    );
    node = contained(root, join(root, 'bin/node'));
    expectedHash = manifest.node.sha256;
    platform = manifest.node.platform;
    arch = manifest.node.arch;
  } else {
    root = realpathSync(resolve(appRoot, '../..'));
    const internal = join(root, 'internal');
    if (!existsSync(internal)) mkdirSync(internal, { mode: 0o700 });
    if (lstatSync(internal).isSymbolicLink())
      throw new Error('The source internal directory cannot be a symlink.');
    stateRoots = [realpathSync(internal)];
    if (existsSync(join(internal, 'tools')))
      stateRoots.push(dirname(realpathSync(join(internal, 'tools'))));
    if (
      appRoot !== join(root, 'apps/desktop') ||
      !process.env.CREWKITE_SOURCE_NODE ||
      !/^[a-f0-9]{64}$/.test(process.env.CREWKITE_SOURCE_NODE_HASH ?? '')
    )
      throw new Error('The source demo needs its explicit trusted launcher.');
    node = realpathSync(process.env.CREWKITE_SOURCE_NODE);
    expectedHash = process.env.CREWKITE_SOURCE_NODE_HASH ?? '';
    platform = process.platform;
    arch = process.arch;
  }
  if (platform !== process.platform || arch !== process.arch)
    throw new Error('The bundled runtime platform or architecture does not match.');
  if (
    createHash('sha256')
      .update(readRegular(node, 256 * 1024 * 1024))
      .digest('hex') !== expectedHash
  )
    throw new Error('The standalone Node checksum does not match.');
  const identity = execFileSync(
    node,
    [
      '--eval',
      'process.stdout.write([process.versions.node,process.platform,process.arch].join("\\n"))',
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 128,
      env: {},
    },
  );
  if (identity !== `24.22.0\n${platform}\n${arch}`)
    throw new Error('The standalone Node identity does not match.');
  const prepare = (path: string) => {
    const base = stateRoots.find((root) => path.startsWith(`${root}${sep}`));
    if (!base) throw new Error('Choose a state path under the repository demo directory.');
    return prepareStateDirectory(base, path);
  };
  return {
    root,
    node,
    home: prepare(resolve(home)),
    profile: prepare(resolve(profile)),
    controller: contained(root, join(root, 'scripts/demo-controller.ts')),
  };
}

export class DesktopController {
  readonly paths: RuntimePaths;
  client: ControllerClient | null = null;
  private child: ChildProcess | null = null;
  private starting: Promise<ControllerClient> | null = null;
  constructor(paths: RuntimePaths) {
    this.paths = paths;
  }
  connect(): Promise<ControllerClient> {
    if (this.starting) return this.starting;
    if (this.client) return this.client.connect().then(() => this.client as ControllerClient);
    this.starting = this.open().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  private async endpoint() {
    const client = new ControllerClient({
      ...readControllerEndpoint(this.paths.home),
      actor: desktopActor,
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  private async open() {
    try {
      this.client = await this.endpoint();
      return this.client;
    } catch {}
    await this.start();
    this.client = await this.endpoint();
    return this.client;
  }
  private start(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null)
      return Promise.reject(new Error('The owned controller is still starting.'));
    return new Promise((resolveReady, reject) => {
      const child = spawn(this.paths.node, [this.paths.controller], {
        cwd: this.paths.root,
        env: {
          ...checkEnvironment(),
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CODEX_HOME: process.env.CODEX_HOME,
          CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
          LANG: 'en_US.UTF-8',
          CREWKITE_HOME: this.paths.home,
          CREWKITE_FIXTURE_IDENTITY:
            process.env.CREWKITE_FIXTURE_IDENTITY === '1' ? '1' : undefined,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      console.log(`Controller PID: ${child.pid ?? 'starting'}`);
      let output = '';
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolveReady();
      };
      const timer = setTimeout(
        () => finish(new Error('The controller did not become ready. Check its owner and home.')),
        10000,
      );
      child.stdout?.on('data', (bytes: Buffer) => {
        if (finished) return;
        output += bytes.toString('utf8');
        if (output.length > 4096)
          finish(new Error('The controller startup output exceeded its bound.'));
        else if (output.split('\n').includes('CREWKITE_CONTROLLER_READY')) finish();
      });
      child.stderr?.on('data', () => {});
      child.once('error', () => finish(new Error('The standalone controller could not start.')));
      child.once('exit', () =>
        finish(new Error('The controller refused startup. Another process may own this home.')),
      );
    });
  }
  resetClient() {
    this.client?.close();
    this.client = null;
  }
  async close() {
    this.client?.close();
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolveClosed) => {
      const timer = setTimeout(resolveClosed, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveClosed();
      });
      child.kill('SIGTERM');
    });
  }
}
