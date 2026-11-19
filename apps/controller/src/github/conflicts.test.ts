import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ChatThreadRead,
  type ChatTurn,
  type CommandResult,
  DEFAULT_REPOSITORY_POLICY,
  type Project,
  type RemoteEffectsRead,
  type RepositoryPolicy,
  type Task,
} from '@crewkite/contracts';
import { createDemoFixtures, createTestClock, createTestIds } from '@crewkite/testkit';
import { type ChatScriptStep, createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { ArtifactFiles } from '../artifacts/index.ts';
import { ChatService } from '../chat/service.ts';
import { installedTools, setup } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import { RemoteEffects } from './effects.ts';

// A project with a local bare remote as origin. The thread writes one file and accepts it to
// feat/net, then a clone pushes a commit to origin's main, as a teammate would. The merge check
// fetches that main over the file protocol, so no network is used.

const selection = { family: 'openai', model: 'fixture-model', effort: 'default' } as const;
const identity = { name: 'Fixture owner', email: 'owner@example.invalid' };
const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: 'Teammate',
  GIT_AUTHOR_EMAIL: 'teammate@example.invalid',
  GIT_COMMITTER_NAME: 'Teammate',
  GIT_COMMITTER_EMAIL: 'teammate@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

const ENDED = new Set<ChatTurn['state']>(['done', 'failed', 'stopped']);
const ancestor = "  throw new Error('netMinor is not implemented.');";
const net = (line: string) => `export function netMinor() {\n${line}\n}\n`;
const write = (path: string, content: string): ChatScriptStep[] => [
  { kind: 'tool', callId: 'edit-1', toolKind: 'edit', title: path, write: { path, content } },
  { kind: 'text', itemId: 'reply', chunks: ['Done.'] },
];

async function accepted(
  t: TestContext,
  turns: ChatScriptStep[][],
  policy: RepositoryPolicy = DEFAULT_REPOSITORY_POLICY,
) {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-merge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = createTestClock();
  const ids = createTestIds(clock.now());
  const fixtures = createDemoFixtures(clock.now());
  const root = createSyntheticRepository(join(directory, 'demo-shop')).directory;
  const remote = join(directory, 'remote.git');
  git(directory, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  git(root, 'push', '--quiet', remote, 'main');
  git(root, 'remote', 'add', 'origin', remote);
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const project: Project = { id: fixtures.task.projectId, name: 'demo-shop', revision: 0 };
  store.transaction(() => {
    store.put('project', project.id, 0, project);
    store.put('task', fixtures.task.id, 0, fixtures.task);
    store.putRepositoryPolicy(project.id, policy, clock.now());
  });
  const taskId = fixtures.task.id;
  const adapter = createScriptedChatAdapter({ family: 'openai', turns });
  const service = new ChatService({
    store,
    artifacts: new ArtifactFiles(join(directory, 'artifacts')),
    remoteEffects: new RemoteEffects({
      store,
      home: directory,
      now: clock.now,
      id: () => ids('rfx'),
      projectPath: () => root,
    }),
    home: directory,
    googleTermsAcknowledged: () => true,
    now: clock.now,
    id: (prefix) => (prefix === 'trn' ? `trn_${ids('msg').slice(4)}` : ids(prefix)),
    emit: (type, task, revision, payload) =>
      store.append({
        protocol: 1,
        id: ids('evt'),
        at: clock.now(),
        taskId: task,
        revision,
        type,
        payload,
      }),
    adapters: new Map([['openai', adapter]]),
    resolveEnvironment: () => ({}),
    projectPath: () => root,
    resolveSelection: (_taskId, value) => value ?? null,
    catalog: () => ({ families: [] }),
  });
  t.after(() => service.close());
  /** Subscribe before the command, then await the turn in this role ending. */
  const ended = (role: ChatTurn['role']) =>
    new Promise<ChatTurn>((resolve) => {
      const stop = store.subscribe((event) => {
        const turn = event.payload as ChatTurn;
        if (event.type !== 'chat.turn' || turn.role !== role || !ENDED.has(turn.state)) return;
        stop();
        resolve(turn);
      });
    });
  const thread = () => service.readThread({ taskId, limit: 100 });
  const accept = (branch: string) =>
    store.transaction(() => service.accept({ taskId, branch }, identity));

  const built = ended('assistant');
  const effects: (() => void)[] = [];
  store.transaction(() =>
    service.sendMessage(
      { taskId, text: 'Return a value.', selection, role: 'assistant', attachments: [], files: [] },
      effects,
    ),
  );
  for (const effect of effects) effect();
  await built;
  assert.equal(accept('feat/net').outcome, 'applied');
  const commit = git(root, 'rev-parse', 'refs/heads/feat/net');

  /** A teammate's commit lands on origin's main. */
  const upstream = (files: Record<string, string>) => {
    const clone = join(mkdtempSync(join(directory, 'clone-')), 'demo-shop');
    git(directory, 'clone', '--quiet', remote, clone);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(clone, path), content);
    git(clone, 'commit', '--quiet', '-am', 'fix: change the base');
    git(clone, 'push', '--quiet', 'origin', 'HEAD:main');
    return git(clone, 'rev-parse', 'HEAD');
  };
  const check = (): Promise<CommandResult> =>
    service.checkMerge({ taskId, remote: 'origin', base: 'main' });
  return { root, adapter, commit, upstream, check, ended, thread, accept, store, taskId };
}

test('a clean merge onto the fetched base reports clean and starts no turn', async (t) => {
  const project = await accepted(t, [write('net.mjs', net("  return 'thread';"))]);
  const base = project.upstream({ 'cli.mjs': '// The base moved on.\n' });

  const result = await project.check();

  assert.deepEqual(
    [result.outcome, result.reason, result.next],
    ['applied', 'merge-clean', `feat/net merges cleanly onto origin/main at ${base.slice(0, 7)}.`],
  );
  assert.equal(project.adapter.requests.length, 1);
  assert.equal(project.thread().thread.base, project.commit);
  assert.equal(git(project.root, 'for-each-ref', 'refs/crewkite/fetched'), '');
});

// The fixer's turn leaves the markers, so the first Accept shows that none goes out. The person
// then merges the line by hand, as a second fix would.
test('a conflicting file reaches one fixer turn with its three sides and accepts onto the branch under the merge method', async (t) => {
  const resolved = net("  return 'thread and base';");
  for (const row of [
    { method: 'squash', line: 'Merged origin/main into feat/net.' },
    { method: 'rebase', line: 'Rebased feat/net onto origin/main as one commit.' },
  ] as const) {
    const project = await accepted(
      t,
      [
        write('net.mjs', net("  return 'thread';")),
        [{ kind: 'text', itemId: 'r', chunks: ['Kept both.'] }],
      ],
      { ...DEFAULT_REPOSITORY_POLICY, mergeMethod: row.method },
    );
    const base = project.upstream({
      'net.mjs': net("  return 'base';"),
      'cli.mjs': '// The base moved on.\n',
    });
    const resolving = project.ended('fixer');

    const result = await project.check();
    assert.equal((await resolving).state, 'done');

    assert.deepEqual([result.outcome, result.reason], ['applied', 'merge-conflicts'], row.method);
    assert.equal(project.adapter.requests.length, 2);
    const [, fixer] = project.adapter.requests;
    assert.equal(fixer.role, 'fixer');
    for (const part of [
      "Resolve these conflicts so both changes hold. Keep the thread's intent. Do not change files that do not conflict.",
      'Conflicting files: net.mjs.',
      `net.mjs, the common ancestor:\n\n\`\`\`\n${net(ancestor).trimEnd()}\n\`\`\``,
      `net.mjs, the thread:\n\n\`\`\`\n${net("  return 'thread';").trimEnd()}\n\`\`\``,
      `net.mjs, origin/main:\n\n\`\`\`\n${net("  return 'base';").trimEnd()}\n\`\`\``,
    ])
      assert.ok(fixer.prompt.includes(part), part);
    assert.equal(project.thread().thread.base, base);
    const copy = join(fixer.scratch.directory, 'net.mjs');
    assert.match(readFileSync(copy, 'utf8'), /^<<<<<<< thread$/m);

    assert.deepEqual(
      [project.accept('feat/net').reason, git(project.root, 'rev-parse', 'feat/net')],
      ['conflicts-unresolved', project.commit],
    );
    writeFileSync(copy, resolved);
    const done = project.accept('feat/net');

    assert.equal(done.outcome, 'applied');
    const merged = git(project.root, 'rev-parse', 'feat/net');
    assert.equal(
      git(project.root, 'rev-list', '--parents', '-n', '1', merged),
      [merged, ...(row.method === 'rebase' ? [base] : [project.commit, base])].join(' '),
    );
    assert.equal(git(project.root, 'show', 'feat/net:net.mjs'), resolved.trimEnd());
    assert.equal(git(project.root, 'show', 'feat/net:cli.mjs'), '// The base moved on.');
    const message = git(project.root, 'log', '-1', '--format=%B', merged);
    const subject =
      row.method === 'rebase'
        ? git(project.root, 'log', '-1', '--format=%s', project.commit)
        : 'chore: merge origin/main';
    assert.equal(message, `${subject}\n\nSigned-off-by: Fixture owner <owner@example.invalid>`);
    const after = project.thread();
    assert.equal(after.thread.lastAcceptance?.commit, merged);
    assert.equal(after.messages.at(-1)?.text, row.line);
  }
});

test('a binary conflict refuses with its path and leaves the thread as it was', async (t) => {
  const project = await accepted(t, [write('sentinels/binary.bin', '\0thread')]);
  project.upstream({ 'sentinels/binary.bin': '\0base' });

  const result = await project.check();

  assert.deepEqual(
    [result.outcome, result.reason, result.next],
    [
      'blocked',
      'conflicts-need-checkout',
      'CrewKite cannot merge sentinels/binary.bin (binary) in the copy. Resolve the merge in a local checkout.',
    ],
  );
  assert.equal(project.adapter.requests.length, 1);
  assert.equal(project.thread().thread.base, project.commit);
});

// Claim: through the controller, a merge proposal for a repository no project remote names refuses
// before any fetch; one for the project's repository first merges its head onto the base fetched
// from that remote and refuses with the conflicting paths, recording no write and starting no turn. CheckChatMerge, the
// Resolve conflicts button, reaches the merge check: the fixer turn starts and the thread carries
// the waiting merge until Accept commits it.
test('a merge proposal refuses with the conflicting paths, and CheckChatMerge starts their resolution', async (t) => {
  const tools = mkdtempSync(join(tmpdir(), 'ck-merge-tools-'));
  t.after(() => rmSync(tools, { recursive: true, force: true }));
  const adapter = createScriptedChatAdapter({
    family: 'openai',
    turns: [
      write('net.mjs', net("  return 'thread';")),
      [{ kind: 'text', itemId: 'r', chunks: ['Kept both.'] }],
    ],
  });
  const context = await setup(t, {
    chatAdapters: new Map([['openai', adapter]]),
    identity,
    gitEnvironment: { HOME: tools, PATH: installedTools(tools, 'git') },
  });
  const { controller, command } = context;
  const task = (await controller.execute(context.draft, 'local-owner')).entity as Task;
  // Reads carry no revision. Every other command here carries the task's.
  const run = (name: string, payload: object) =>
    controller.execute(
      command(name, { taskId: task.id, ...payload }, name.startsWith('Read') ? undefined : 0),
      'local-owner',
    );
  const thread = async () => ((await run('ReadChatThread', {})).data as ChatThreadRead).thread;
  const ended = (role: ChatTurn['role']) =>
    new Promise<void>((resolve) => {
      const stop = controller.store.subscribe((event) => {
        const turn = event.payload as ChatTurn;
        if (event.type !== 'chat.turn' || turn.role !== role || !ENDED.has(turn.state)) return;
        stop();
        resolve();
      });
    });
  const built = ended('assistant');
  await run('SendChatMessage', { text: 'Return a value.', selection });
  await built;
  assert.equal((await run('AcceptChatChanges', { branch: 'feat/net' })).outcome, 'applied');
  const root = context.source.directory;
  const commit = git(root, 'rev-parse', 'refs/heads/feat/net');
  const remote = join(context.directory, 'remote.git');
  git(context.directory, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  git(root, 'push', '--quiet', remote, 'main');
  // origin names the pull request's repository, and git reads it from the local bare one, so the
  // merge resolves its remote from the repository and no fetch leaves this computer.
  const github = 'https://github.com/crew-kite/demo-shop.git';
  git(root, 'remote', 'add', 'origin', github);
  git(root, 'config', `url.${remote}.insteadOf`, github);
  const clone = join(context.directory, 'clone');
  git(context.directory, 'clone', '--quiet', remote, clone);
  writeFileSync(join(clone, 'net.mjs'), net("  return 'base';"));
  git(clone, 'commit', '--quiet', '-am', 'fix: change the base');
  git(clone, 'push', '--quiet', 'origin', 'HEAD:main');
  const base = git(clone, 'rev-parse', 'HEAD');
  const merge = {
    target: {
      repo: { host: 'github.com', owner: 'crew-kite', name: 'demo-shop' },
      branch: 'feat/net',
      pr: 7,
      headSha: commit,
      baseRef: 'main',
    },
    request: { kind: 'merge', method: 'squash', expectedHead: commit },
  };
  const conflicts = { kind: 'chat-merge-check', state: 'conflicts', base, paths: ['net.mjs'] };
  // A repository no remote of the project names refuses before any fetch, so it never reaches
  // the merge check.
  const elsewhere = {
    ...merge,
    target: { ...merge.target, repo: { ...merge.target.repo, name: 'other-shop' } },
  };
  assert.equal((await run('ProposeRemoteEffect', elsewhere)).reason, 'repository-not-a-remote');

  const proposed = await run('ProposeRemoteEffect', merge);

  assert.deepEqual(
    [proposed.outcome, proposed.reason, proposed.data],
    ['blocked', 'merge-conflicts', conflicts],
  );
  const journal = (await run('ReadRemoteEffects', {})).data as RemoteEffectsRead;
  assert.deepEqual(journal.effects, []);
  assert.equal(adapter.requests.length, 1);
  assert.equal((await thread()).base, commit);

  const resolving = ended('fixer');
  const checked = await run('CheckChatMerge', { remote: 'origin', base: 'main' });
  await resolving;

  assert.deepEqual(
    [checked.outcome, checked.reason, checked.data],
    ['applied', 'merge-conflicts', conflicts],
  );
  assert.equal(adapter.requests[1]?.role, 'fixer');
  const waiting = { remote: 'origin', branch: 'main', target: 'feat/net', paths: ['net.mjs'] };
  assert.deepEqual((await thread()).pendingMerge, waiting);
  assert.equal((await run('ProposeRemoteEffect', merge)).reason, 'merge-in-copy');
  writeFileSync(join(adapter.requests[1].scratch.directory, 'net.mjs'), net("  return 'both';"));
  assert.equal((await run('AcceptChatChanges', { branch: 'feat/net' })).outcome, 'applied');
  assert.equal((await thread()).pendingMerge, undefined);
});

// Claim: a merge check on a thread held for a provider process that has since exited releases
// the hold and checks the merge. Releasing writes the turn and its event together, so the
// check never ends in an internal error with the row changed and no event sent.
test('a merge check on a thread held for an exited process releases the hold and checks', async (t) => {
  const project = await accepted(t, [write('net.mjs', net("  return 'thread';"))]);
  project.upstream({ 'cli.mjs': '// The base moved on.\n' });
  // The turn saved a process group that no longer exists, and the thread is held for it.
  const gone = 2_147_483_000;
  project.store.db
    .prepare("UPDATE chat_turns SET body=json_set(body,'$.groups',json(?)) WHERE task_id=?")
    .run(JSON.stringify([gone]), project.taskId);
  project.store.db
    .prepare(
      "UPDATE chat_threads SET body=json_set(body,'$.ownershipUnknown',json('true')) WHERE task_id=?",
    )
    .run(project.taskId);
  const result = await project.check();
  assert.equal(result.outcome, 'applied', JSON.stringify(result));
  const after = project.thread();
  assert.equal(after.thread.ownershipUnknown, undefined);
  assert.equal(after.turns[0]?.groups, undefined);
});
