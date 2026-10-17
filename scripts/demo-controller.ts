import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOwner } from '../apps/controller/src/host/check-ownership.ts';
import { configuredIdentity } from '../apps/controller/src/host/publication.ts';
import { startController } from '../apps/controller/src/main.ts';
import { createCommandKey } from '../packages/client/src/node.ts';
import { CommandSchema, SnapshotSchema } from '../packages/contracts/src/index.ts';
import { createDemoFixtures } from '../packages/testkit/src/index.ts';
import { createSyntheticRepository } from '../packages/testkit/src/repository.ts';
import { prepareStateDirectory, syncDirectory } from './demo-state.ts';

export async function startDemoController(home: string) {
  const directory = resolve(home);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const internal =
    checkOwner()?.stateRoot ??
    (existsSync(join(root, 'manifest.json'))
      ? dirname(dirname(root))
      : existsSync(join(root, 'internal/tools'))
        ? dirname(realpathSync(join(root, 'internal/tools')))
        : join(root, 'internal'));
  if (!existsSync(internal)) prepareStateDirectory(root, internal);
  prepareStateDirectory(internal, directory);
  const state = lstatSync(directory);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.uid !== process.getuid?.() ||
    (state.mode & 0o777) !== 0o700
  )
    throw new Error('The demo home must be private to its owner.');
  const catalogPath = join(directory, 'demo-catalog.json');
  let catalog: ReturnType<typeof SnapshotSchema.parse>;
  try {
    const file = openSync(
      catalogPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const state = fstatSync(file);
      if (
        !state.isFile() ||
        state.nlink !== 1 ||
        state.size > 1048576 ||
        state.uid !== process.getuid?.() ||
        (state.mode & 0o777) !== 0o600
      )
        throw new Error('The demo catalog must be a bounded private file.');
      catalog = SnapshotSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } finally {
      closeSync(file);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    catalog = createDemoFixtures(new Date().toISOString()).snapshot;
    const file = openSync(
      catalogPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(file, `${JSON.stringify(catalog)}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
  }
  syncDirectory(directory);
  if (catalog.routes.length !== 4 || catalog.routes.some((route) => !route.fake))
    throw new Error('The demo catalog is invalid.');
  const runtime = await startController({
    home: directory,
    googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
    routes: catalog.routes,
    observations: catalog.usage.map(({ observation }) => observation),
    identity:
      process.env.CREWKITE_FIXTURE_IDENTITY === '1'
        ? { name: 'CrewKite fixture', email: 'fixture@example.invalid' }
        : () => configuredIdentity(directory),
    scenarioForRoute: (route, generation) =>
      generation === 0 && route.family === 'anthropic'
        ? 'approval-reserve'
        : generation === 1
          ? 'crash'
          : 'complete',
  });
  try {
    const source = join(directory, 'demo-shop');
    if (!existsSync(source)) createSyntheticRepository(source);
    const result = await runtime.controller.execute(
      CommandSchema.parse({
        protocol: 1,
        key: createCommandKey(),
        actor: { id: 'demo-bootstrap', kind: 'controller' },
        command: 'RegisterProject',
        expectedRevision: 0,
        payload: { path: source },
      }),
      'local-owner',
    );
    if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
      throw new Error('The demo source could not be registered.');
    return runtime;
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.CREWKITE_HOME) throw new Error('Choose an explicit demo home.');
    const runtime = await startDemoController(process.env.CREWKITE_HOME);
    console.log('CREWKITE_CONTROLLER_READY');
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await runtime.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
  } catch {
    console.error('The demo controller could not start. Its home may have another owner.');
    process.exitCode = 1;
  }
}
