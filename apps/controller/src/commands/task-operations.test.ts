import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommandSchema, type Task } from '@crewkite/contracts';
import { ArtifactFiles } from '../artifacts/index.ts';
import { git } from '../host/source.ts';
import { groupAbsent } from '../host/worker.ts';
import { Store } from '../store/index.ts';
import { type TaskOperationCommand, TaskOperations } from './task-operations.ts';

test('explicit task operations retain local output and fixed GitHub reads without replay or global mutation ownership', {
  timeout: 15000,
}, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ck-task-operations-')));
  const repo = join(home, 'repository');
  mkdirSync(repo);
  git(repo, ['init', '--quiet']);
  writeFileSync(join(repo, 'source.txt'), 'committed source\n');
  writeFileSync(
    join(repo, 'check.mjs'),
    "import {writeFileSync} from 'node:fs'; writeFileSync('ready','ready'); console.log('retained command output'); setInterval(()=>{},1000);\n",
  );
  git(repo, ['add', '.']);
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
  const base = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  writeFileSync(join(repo, 'source.txt'), 'local change stays here\n');
  writeFileSync(join(repo, 'untracked.txt'), 'untracked stays here\n');
  const sourceStatus = git(repo, ['status', '--porcelain=v1', '-z']);
  const previousPath = process.env.PATH;
  let sequence = 0;
  const id = (prefix: string) => `${prefix}_${String(++sequence).padStart(26, '0')}`;
  let store = new Store(join(home, 'state.sqlite'));
  const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
  store.applyMigrations(migrations);
  const artifacts = new ArtifactFiles(join(home, 'artifacts'));
  const outputReady = Promise.withResolvers<void>();
  const publish = artifacts.publishStream.bind(artifacts);
  artifacts.publishStream = (source, options) =>
    publish(
      (async function* () {
        let tail = '';
        for await (const chunk of source) {
          tail = (tail + Buffer.from(chunk).toString('utf8')).slice(-128);
          if (tail.includes('retained command output')) outputReady.resolve();
          yield chunk;
        }
      })(),
      options,
    );

  const task: Task = {
    id: id('tsk'),
    projectId: id('prj'),
    title: 'Explicit local tool',
    outcome: 'Retain output',
    criteria: ['Owned work closes'],
    state: 'draft',
    revision: 0,
    runId: null,
    waitingReason: null,
    next: null,
  };
  store.transaction(() => {
    store.put('project', task.projectId, 0, { id: task.projectId, name: 'Fixture', revision: 0 });
    store.put('task', task.id, 0, task);
    store.db
      .prepare('INSERT INTO project_paths(project_id,path) VALUES (?,?)')
      .run(task.projectId, repo);
  });
  let operations = new TaskOperations({
    store,
    artifacts,
    home,
    now: () => new Date().toISOString(),
    id,
    event: () => {},
  });
  t.after(async () => {
    await operations.close();
    store.close();
    process.env.PATH = previousPath;
    rmSync(home, { recursive: true, force: true });
  });
  const command = (name: TaskOperationCommand['command'], payload: unknown) =>
    CommandSchema.parse({
      protocol: 1,
      key: id('cmd'),
      actor: { id: 'fixture', kind: 'cli' },
      ...(!name.startsWith('Get') ? { expectedRevision: 0 } : {}),
      command: name,
      payload,
    }) as TaskOperationCommand;
  const prepared = await operations.execute(
    command('PrepareProjectCommand', {
      taskId: task.id,
      recipe: 'test',
      executable: realpathSync(process.execPath),
      argv: ['check.mjs'],
      deadlineMs: 30000,
    }),
  );
  assert.equal(prepared.outcome, 'applied');
  assert(prepared.data?.kind === 'project-operation' && prepared.data.definition);
  const definition = prepared.data.definition;
  assert.equal(definition.source.dirtyCount, 1);
  assert.equal(definition.source.untrackedCount, 1);
  assert.equal(
    existsSync(definition.scratchRoot),
    false,
    'Prepare freezes metadata without copying source.',
  );
  const start = command('StartProjectCommand', {
    taskId: task.id,
    operationId: definition.id,
    definitionHash: prepared.data.operation.definition.hash,
    sourceConsent: 'explicit',
    nativeTrust: 'accepted',
    grant: {
      taskId: task.id,
      action: 'run-native-tools',
      target: prepared.data.operation.definition.hash,
      expiresAt: new Date(Date.now() + 35000).toISOString(),
      revoked: false,
      usesRemaining: 1,
    },
  });
  const started = operations.execute(start);
  // Observe the actual owned stdout stream, without filesystem watchers or a delay.
  await outputReady.promise;
  assert.equal(readFileSync(join(definition.scratchRoot, 'ready'), 'utf8'), 'ready');
  assert.equal(
    readFileSync(join(definition.scratchRoot, 'source.txt'), 'utf8'),
    'committed source\n',
  );
  assert.equal(existsSync(join(definition.scratchRoot, 'untracked.txt')), false);
  const listing = await operations.execute(command('GetTaskOperations', { taskId: task.id }));
  assert(listing.data?.kind === 'task-operations');
  assert.equal(listing.data.operations[0]?.state, 'running');
  const otherTask = id('tsk');
  store.transaction(() => store.put('task', otherTask, 0, { ...task, id: otherTask }));
  const stopped = await operations.execute(
    command('StopProjectOperation', { taskId: task.id, operationId: definition.id }),
  );
  assert.equal(stopped.outcome, 'applied');
  const terminal = await started;
  assert.equal(terminal.reason, 'stopped');
  assert(terminal.data?.kind === 'project-operation');
  assert.equal(terminal.data.operation.state, 'cancelled');
  const stdout = terminal.data.operation.stdout;
  assert(stdout);
  assert.match(artifacts.read(stdout.hash).toString('utf8'), /retained command output/);
  const journal = JSON.parse(
    store.db.prepare('SELECT body FROM task_operations WHERE operation_id=?').get(definition.id)
      ?.body as string,
  );
  assert.equal(journal.phases[0].state, 'closed');
  assert.equal(groupAbsent(journal.phases[0].group), true);
  assert.deepEqual(
    await operations.execute(start),
    terminal,
    'An exact retry returns the retained receipt without relaunching.',
  );
  assert.deepEqual(git(repo, ['status', '--porcelain=v1', '-z']), sourceStatus);

  const bin = join(home, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    `#!${realpathSync(process.execPath)}\nconsole.log(JSON.stringify({number:1,head:{sha:'${base}'},state:'open',draft:false,html_url:'https://github.com/example/project/pull/1'}));\n`,
  );
  chmodSync(gh, 0o700);
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  const read = command('ReadGitHub', {
    taskId: task.id,
    request: {
      kind: 'pull-request',
      repository: { host: 'github.com', owner: 'example', name: 'project' },
      headSha: base,
      pullRequest: '1',
    },
  });
  const remote = await operations.execute(read);
  assert.equal(remote.outcome, 'applied', JSON.stringify(remote));
  assert(remote.data?.kind === 'project-operation');
  assert.equal(remote.data.operation.state, 'succeeded');
  assert.equal(remote.data.githubResult?.status, 'open');
  assert.equal(remote.data.githubResult?.url, 'https://github.com/example/project/pull/1');
  assert(remote.data.operation.result);
  const result = JSON.parse(artifacts.read(remote.data.operation.result.hash).toString('utf8'));
  assert.equal(result.status, 'open');
  assert.equal(result.source.headSha, base);
  assert.equal((await operations.execute(read)).outcome, 'already-applied');
  const publishJson = artifacts.publish.bind(artifacts);
  let failResult = true;
  artifacts.publish = (bytes) => {
    const value = JSON.parse(bytes.toString('utf8'));
    if (failResult && value.state === 'complete') {
      failResult = false;
      throw Error('injected-result-publication-failure');
    }
    return publishJson(bytes);
  };
  const failedOutput = await operations.execute(command('ReadGitHub', read.payload));
  assert.equal(failedOutput.reason, 'operation-output-failed');
  assert(failedOutput.data?.kind === 'project-operation');
  assert.equal(
    failedOutput.data.operation.state,
    'failed',
    'Closed ownership does not become unknown after result storage failure.',
  );
  artifacts.publish = publishJson;
  assert.equal(operations.close(), undefined, 'Idle close stays synchronous.');
  store.close();
  store = new Store(join(home, 'state.sqlite'));
  store.applyMigrations(migrations);
  operations = new TaskOperations({
    store,
    artifacts,
    home,
    now: () => new Date().toISOString(),
    id,
    event: () => {},
  });
  operations.recover();
  assert.equal((await operations.execute(read)).outcome, 'already-applied');
});
