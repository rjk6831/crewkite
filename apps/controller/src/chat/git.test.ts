import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type ChatThread, ChatThreadSchema, type RemoteEffect } from '@crewkite/contracts';
import { RemoteEffects } from '../github/effects.ts';
import type { SshHost } from '../github/remote.ts';
import { fakeGh, installedTools } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import {
  type ChatGitHost,
  openChatPullRequest,
  pushChatBranch,
  readChatBranchStatus,
  type ToolRun,
  toolRunner,
} from './git.ts';

// The fake gh answers `gh run list --json databaseId,name,status,conclusion,url,createdAt` the way
// gh 2.x prints it: a JSON array, newest first, with numeric databaseId and an empty conclusion
// while a run is going.

const taskId = `tsk_${'0'.repeat(26)}`;
const now = '2026-10-24T09:00:00.000Z';
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

// The write journal on a real store that holds the thread as Accept left it. Git runs through the
// process owner with a temporary HOME. PATH holds git and the folder `gh` fills with a fake gh, so
// no installed gh is ever found.
function writeJournal(
  t: TestContext,
  root: string,
  thread: ChatThread,
  options: { sshHost?: SshHost } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'chat-git-journal-'));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.applyMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const projectId = `prj_${'0'.repeat(26)}`;
  store.transaction(() => {
    store.put('project', projectId, 0, { id: projectId, name: 'demo-shop', revision: 0 });
    store.put('task', taskId, 0, { id: taskId, projectId, title: 'Net' });
    store.db
      .prepare('INSERT INTO chat_threads(task_id,body) VALUES (?,?)')
      .run(taskId, JSON.stringify(thread));
  });
  let next = 0;
  const effects = new RemoteEffects({
    store,
    home: directory,
    now: () => now,
    id: () => `rfx_${String(++next).padStart(26, '0')}`,
    projectPath: () => root,
    environment: {
      HOME: directory,
      PATH: `${join(directory, 'gh-bin')}${delimiter}${installedTools(directory, 'git')}`,
    },
    sshHost: options.sshHost ?? ((alias) => alias),
  });
  t.after(() => effects.close());
  return { effects, store, gh: () => fakeGh(directory) };
}

function host(
  root: string,
  thread: ChatThread,
  effects: RemoteEffects,
  gh?: (args: string[]) => ToolRun | null,
) {
  const real = toolRunner(env);
  const notes: string[] = [];
  let saved = thread;
  const value: ChatGitHost = {
    effects,
    thread: () => saved,
    journal: (_id, update, line) => {
      saved = ChatThreadSchema.parse(update(saved));
      notes.push(line);
    },
    projectRoot: () => root,
    now: () => now,
    run: (tool, args, cwd) =>
      tool === 'gh' ? Promise.resolve(gh ? gh(args) : null) : real(tool, args, cwd),
  };
  return { value, notes, saved: () => saved };
}

// A project with a bare remote and an accepted commit on crewkite/net.
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'chat-git-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'project');
  const remote = join(directory, 'remote.git');
  git(directory, 'init', '--quiet', '--bare', remote);
  git(directory, 'init', '--quiet', root);
  writeFileSync(join(root, 'net.mjs'), 'export const net = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'base');
  git(root, 'branch', 'crewkite/net');
  const commit = git(root, 'rev-parse', 'crewkite/net');
  // Fetches name the github.com repository and pushes go to the local bare one, so no test reaches
  // the network.
  git(root, 'remote', 'add', 'origin', 'git@github.com:rjk6831/demo-shop.git');
  git(root, 'remote', 'set-url', '--push', 'origin', remote);
  const thread = ChatThreadSchema.parse({
    taskId,
    scratchReady: true,
    base: commit,
    selection: null,
    lastAcceptance: { branch: 'crewkite/net', at: now, fileCount: 1, commit },
  });
  return { root, remote, commit, thread };
}

// Claim: Push sends the accepted commit once through the write journal and journals it on the
// thread. Open pull request with gh only proposes and answers with the preview; the pull request
// the person confirmed reaches the thread on the next click. Without gh it gives the compare link.
test('pushing an accepted branch reaches the remote once through the write journal and is journaled on the thread', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chat-git-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'project');
  const remote = join(directory, 'remote.git');
  git(directory, 'init', '--quiet', '--bare', remote);
  git(directory, 'init', '--quiet', root);
  writeFileSync(join(root, 'net.mjs'), 'export const net = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'base');
  git(root, 'branch', 'crewkite/net');
  const commit = git(root, 'rev-parse', 'crewkite/net');
  // Fetches name the github.com repository and pushes go to the local bare one, so the compare
  // link is built from a real remote form without any network.
  git(root, 'remote', 'add', 'origin', 'git@github.com:rjk6831/demo-shop.git');
  git(root, 'remote', 'set-url', '--push', 'origin', remote);
  const thread = ChatThreadSchema.parse({
    taskId,
    scratchReady: true,
    base: commit,
    selection: null,
    lastAcceptance: { branch: 'crewkite/net', at: now, fileCount: 1, commit },
  });
  const journal = writeJournal(t, root, thread);
  const { effects } = journal;
  const { value, notes, saved } = host(root, thread, effects);
  const payload = {
    taskId,
    branch: 'crewkite/net',
    commit,
    remote: 'origin',
    confirmed: true,
  } as const;

  const first = await pushChatBranch(value, payload);
  assert.equal(first.outcome, 'applied');
  assert.deepEqual(first.data, {
    kind: 'chat-push',
    branch: 'crewkite/net',
    remote: 'origin',
    commit,
  });
  assert.equal(git(remote, 'rev-parse', 'refs/heads/crewkite/net'), commit);
  assert.deepEqual(saved().lastPush, {
    branch: 'crewkite/net',
    remote: 'origin',
    commit,
    at: now,
    pullRequestUrl: null,
  });
  assert.deepEqual(
    effects.list(taskId).map((effect) => [effect.kind, effect.state, effect.request]),
    [['push', 'applied', { kind: 'push', remote: 'origin', commit, expectedRemote: null }]],
  );
  // A second click finds the journaled push and runs nothing.
  assert.equal((await pushChatBranch(value, payload)).outcome, 'already-applied');
  assert.equal(effects.list(taskId).length, 1);

  const opened = await openChatPullRequest(value, {
    taskId,
    branch: 'crewkite/net',
    title: 'Add netMinor',
    body: '',
  });
  const url = 'https://github.com/rjk6831/demo-shop/compare/crewkite/net?expand=1';
  assert.deepEqual(opened.data, { kind: 'chat-pull-request', url, via: 'compare-link' });
  assert.equal(saved().lastPush?.pullRequestUrl, url);
  assert.deepEqual(notes, [
    'Pushed crewkite/net to origin.',
    'Copied the compare link for crewkite/net.',
  ]);

  const gh = journal.gh();
  gh.answer({
    'GET /repos/rjk6831/demo-shop': { json: { default_branch: 'main' } },
    'POST /repos/rjk6831/demo-shop/pulls': {
      json: {
        number: 7,
        state: 'open',
        head: { ref: 'crewkite/net', sha: commit },
        html_url: 'https://github.com/rjk6831/demo-shop/pull/7',
      },
    },
  });
  const request = { taskId, branch: 'crewkite/net', title: 'Add netMinor', body: '' };
  const offered = await openChatPullRequest(value, request);
  assert.equal(offered.reason, 'pull-request-needs-confirmation');
  assert(offered.data?.kind === 'remote-effect');
  const proposal = offered.data.effect;
  assert.equal(proposal.state, 'proposed');
  assert.match(offered.data.preview, /--input request.json \/repos\/rjk6831\/demo-shop\/pulls$/m);
  const again = await openChatPullRequest(value, request);
  assert(again.data?.kind === 'remote-effect');
  assert.equal(again.data.effect.id, proposal.id, 'A second click shows the same proposal.');
  assert.deepEqual(
    gh.calls().map((call) => call.argv.at(-1)),
    ['/repos/rjk6831/demo-shop'],
    'Nothing is sent before the person confirms.',
  );
  assert.equal(
    (await effects.confirm({ effectId: proposal.id, confirm: 'explicit' })).outcome,
    'applied',
  );
  const done = await openChatPullRequest(value, request);
  const pull = 'https://github.com/rjk6831/demo-shop/pull/7';
  assert.deepEqual(
    [done.outcome, done.data],
    ['already-applied', { kind: 'chat-pull-request', url: pull, via: 'gh' }],
  );
  assert.equal(saved().lastPush?.pullRequestUrl, pull);
});

// Claim: a push sends the commit the thread accepted, by id, and only when the question named that
// commit; the lease refuses a branch that moved on the remote.
test('a push sends the accepted commit by id under a lease and refuses when the remote moved', async (t) => {
  const { root, remote, commit, thread } = fixture(t);
  // The local branch moves after Accept. The push still sends the accepted object.
  writeFileSync(join(root, 'net.mjs'), 'export const net = 2;\n');
  git(root, 'commit', '--quiet', '-am', 'later');
  git(root, 'branch', '-f', 'crewkite/net', 'HEAD');
  const { effects } = writeJournal(t, root, thread);
  const { value, notes } = host(root, thread, effects);
  const payload = {
    taskId,
    branch: 'crewkite/net',
    commit,
    remote: 'origin',
    confirmed: true,
  } as const;
  // A question that named another commit, such as one asked before the thread accepted again,
  // pushes nothing.
  const stale = await pushChatBranch(value, { ...payload, commit: git(root, 'rev-parse', 'HEAD') });
  assert.deepEqual(
    [stale.reason, stale.next],
    [
      'branch-not-accepted',
      `The thread accepted ${commit.slice(0, 12)} after you were asked. Read it again, then push.`,
    ],
  );
  assert.deepEqual(effects.list(taskId), []);
  // Someone else took the name first, so the lease for a new branch refuses.
  git(root, 'push', '--quiet', remote, 'HEAD:refs/heads/crewkite/net');
  const refused = await pushChatBranch(value, payload);
  assert.equal(refused.outcome, 'blocked');
  assert.match(refused.reason ?? '', /changed on origin/);
  assert.deepEqual(notes, []);
  assert.equal(effects.list(taskId)[0]?.state, 'refused');
  git(remote, 'update-ref', '-d', 'refs/heads/crewkite/net');
  assert.equal((await pushChatBranch(value, payload)).outcome, 'applied');
  assert.equal(git(remote, 'rev-parse', 'refs/heads/crewkite/net'), commit);
});

test('the branch status reads CI for the accepted commit and says when the branch moved on', async (t) => {
  const { root, remote, commit, thread } = fixture(t);
  const { effects } = writeJournal(t, root, thread);
  git(root, 'push', '--quiet', remote, 'crewkite/net');
  const row = {
    databaseId: 101,
    name: 'verify',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/rjk6831/demo-shop/actions/runs/101',
    createdAt: '2026-10-24T08:00:00Z',
    headSha: commit,
  };
  const other = { ...row, databaseId: 99, headSha: 'f'.repeat(40) };
  const cases: [string, ToolRun | null, string | null, (string | null)[] | null][] = [
    ['gh missing', null, 'Install gh to see CI runs here.', null],
    [
      'gh signed out',
      { code: 4, stdout: '', stderr: 'run:  gh auth login\n' },
      'run:  gh auth login',
      null,
    ],
    [
      'a run for another commit is dropped and the answer is not a pass',
      { code: 0, stderr: '', stdout: JSON.stringify([other]) },
      'No CI run has been reported for the accepted commit yet.',
      [],
    ],
    [
      'a run for the accepted commit',
      { code: 0, stderr: '', stdout: JSON.stringify([row, other]) },
      null,
      ['101'],
    ],
  ];
  for (const [name, answer, reason, ids] of cases) {
    const asked: string[][] = [];
    const { value } = host(root, thread, effects, (args) => {
      asked.push(args);
      return answer;
    });
    const status = await readChatBranchStatus(value, { taskId, branch: 'crewkite/net' });
    assert.equal(status.reason, reason, name);
    assert.deepEqual(status.runs?.map((run) => run.id) ?? null, ids, name);
    assert.deepEqual(asked[0]?.slice(0, 4), ['run', 'list', '--commit', commit], name);
  }
  // The remote branch gains a commit after Accept.
  writeFileSync(join(root, 'net.mjs'), 'export const net = 2;\n');
  git(root, 'commit', '--quiet', '-am', 'later');
  git(root, 'push', '--quiet', remote, 'HEAD:refs/heads/crewkite/net');
  const { value } = host(root, thread, effects, () => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify([row]),
  }));
  const moved = await readChatBranchStatus(value, { taskId, branch: 'crewkite/net' });
  assert.equal(moved.reason, 'The branch now points at a newer commit than the one you accepted.');
  assert.equal(moved.runs?.length, 1);
});

test('the branch status reads attempt and jobs for each run of the accepted commit', async (t) => {
  const { root, remote, commit, thread } = fixture(t);
  const { effects } = writeJournal(t, root, thread);
  git(root, 'push', '--quiet', remote, 'crewkite/net');
  const row = {
    databaseId: 101,
    name: 'verify',
    status: 'completed',
    conclusion: 'failure',
    url: 'https://github.com/rjk6831/demo-shop/actions/runs/101',
    createdAt: '2026-10-24T08:00:00Z',
    headSha: commit,
  };
  // A recorded `gh run view --json attempt,headSha,jobs` answer, with the steps gh adds.
  const recorded = readFileSync(
    new URL('./fixtures/gh-run-view.json', import.meta.url),
    'utf8',
  ).replace('__COMMIT__', commit);
  const cases: [string, ToolRun | null, number | null, string[]][] = [
    [
      'the view names attempt and jobs',
      { code: 0, stderr: '', stdout: recorded },
      2,
      ['lint', 'test'],
    ],
    [
      'a view that fails leaves the jobs unread',
      { code: 1, stderr: 'HTTP 502', stdout: '' },
      null,
      [],
    ],
    ['gh missing leaves the jobs unread', null, null, []],
    [
      'a view for another commit is not trusted',
      { code: 0, stderr: '', stdout: recorded.replace(commit, 'f'.repeat(40)) },
      null,
      [],
    ],
    [
      'one job gh reports with an unusable address leaves them all unread',
      { code: 0, stderr: '', stdout: recorded.replace(/https:[^"]*9002/, 'not an address') },
      null,
      [],
    ],
  ];
  for (const [name, view, attempt, jobs] of cases) {
    const asked: string[][] = [];
    const { value } = host(root, thread, effects, (args) => {
      asked.push(args);
      return args[1] === 'list' ? { code: 0, stderr: '', stdout: JSON.stringify([row]) } : view;
    });
    const status = await readChatBranchStatus(value, { taskId, branch: 'crewkite/net' });
    const read = status.runs?.[0];
    assert.equal(read?.attempt, attempt, name);
    assert.deepEqual(
      read?.jobs.map((job) => job.name),
      jobs,
      name,
    );
    assert.equal(status.commit, commit, name);
    assert.deepEqual(asked.at(-1)?.slice(0, 4), ['run', 'view', '101', '--json'], name);
  }
});

// A pull request merged into main, as the write journal records it: the merge commit is in
// observed.created.sha.
let mergedCount = 0;
function merged(store: Store, commit: string, mergeCommit: string, at: string) {
  const effect: RemoteEffect = {
    id: `rfx_${String(++mergedCount).padStart(26, '0')}`,
    taskId,
    kind: 'merge',
    state: 'applied',
    target: {
      repo: { host: 'github.com', owner: 'rjk6831', name: 'demo-shop' },
      branch: 'crewkite/net',
      pr: 42,
      headSha: commit,
      baseRef: 'main',
    },
    request: { kind: 'merge', method: 'squash', expectedHead: commit },
    confirmation: { at, by: 'person' },
    observed: { at, result: 'applied', created: { sha: mergeCommit } },
    reason: null,
  };
  store.transaction(() => store.putRemoteEffect(effect, at));
}

const deployFixture = JSON.parse(
  readFileSync(new URL('./fixtures/gh-deploy.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const recorded = (key: string, mergeCommit: string): ToolRun => ({
  code: 0,
  stderr: '',
  stdout: JSON.stringify(deployFixture[key]).replaceAll('__MERGE__', mergeCommit),
});

// Claim: after a merge the thread reads the workflow runs of the merge commit on the base branch
// and its deployments with their environment and latest status. It reads again while anything is
// unfinished, stops asking once all finished, and gives up after two hours with a plain line.
test('the runs and deployments for the merge commit are read, followed until they finish, and shown', async (t) => {
  const { root, commit, thread } = fixture(t);
  const { effects, store } = writeJournal(t, root, thread);
  const mergeCommit = 'a'.repeat(40);
  merged(store, commit, mergeCommit, now);
  const asked: string[][] = [];
  let statusKey = 'statusInProgress';
  const { value } = host(root, thread, effects, (args) => {
    asked.push(args);
    if (args[0] === 'run') return recorded('runList', mergeCommit);
    return args[3]?.includes('/statuses')
      ? recorded(statusKey, mergeCommit)
      : recorded('deployments', mergeCommit);
  });
  const read = () => readChatBranchStatus(value, { taskId, branch: 'crewkite/net' });
  const first = (await read()).deploy;
  assert.deepEqual(asked.find((args) => args.includes('--branch'))?.slice(2, 8), [
    '--repo',
    'github.com/rjk6831/demo-shop',
    '--commit',
    mergeCommit,
    '--branch',
    'main',
  ]);
  assert.ok(
    asked.some(
      (args) => args[3] === `repos/rjk6831/demo-shop/deployments?sha=${mergeCommit}&per_page=10`,
    ),
  );
  assert.deepEqual(
    first?.runs?.map((run) => [run.name, run.status, run.conclusion]),
    [
      ['release', 'completed', 'success'],
      ['deploy', 'in_progress', null],
    ],
  );
  assert.deepEqual(
    first?.deployments?.map((entry) => [entry.environment, entry.state]),
    [['production', 'in_progress']],
  );
  assert.equal(first?.following, true);
  // Everything finished: the answer is final and gh is not asked again.
  statusKey = 'statusSuccess';
  asked.length = 0;
  const settled = await readChatBranchStatus(
    host(root, thread, effects, (args) => {
      asked.push(args);
      if (args[0] === 'run')
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify(
            (deployFixture.runList as Record<string, unknown>[]).map((row) => ({
              ...row,
              status: 'completed',
              conclusion: 'success',
              headSha: mergeCommit,
            })),
          ),
        };
      return args[3]?.includes('/statuses')
        ? recorded(statusKey, mergeCommit)
        : recorded('deployments', mergeCommit);
    }).value,
    { taskId, branch: 'crewkite/net' },
  );
  assert.equal(settled.deploy?.following, false);
  assert.equal(settled.deploy?.deployments?.[0]?.url, 'https://shop.example.com');
  asked.length = 0;
  const again = await read();
  assert.equal(again.deploy?.following, false);
  assert.equal(asked.filter((args) => args.includes('--branch') || args[0] === 'api').length, 0);
  // Two hours after the merge, something still running stops the polling with a plain line.
  const slow = 'b'.repeat(40);
  merged(store, commit, slow, now);
  const late = host(root, thread, effects, (args) =>
    args[0] === 'run'
      ? recorded('runList', slow)
      : args[3]?.includes('/statuses')
        ? recorded('statusInProgress', slow)
        : recorded('deployments', slow),
  ).value;
  late.now = () => '2026-10-24T11:00:01.000Z';
  const expired = (await readChatBranchStatus(late, { taskId, branch: 'crewkite/net' })).deploy;
  assert.equal(expired?.following, false);
  assert.equal(expired?.reason, 'Still running on GitHub. Check it there.');
});

// Claim: a deployment or run CrewKite cannot read shows as unknown or unread and never as passed.
test('a deployment whose status cannot be read is unknown, and an unreadable list is not a pass', async (t) => {
  const { root, commit, thread } = fixture(t);
  const { effects, store } = writeJournal(t, root, thread);
  const mergeCommit = 'c'.repeat(40);
  merged(store, commit, mergeCommit, now);
  const cases: [string, (args: string[]) => ToolRun | null, string | null, string | null][] = [
    [
      'the status call fails',
      (args) =>
        args[0] === 'run'
          ? recorded('runList', mergeCommit)
          : args[3]?.includes('/statuses')
            ? { code: 1, stderr: 'HTTP 502', stdout: '' }
            : recorded('deployments', mergeCommit),
      'unknown',
      null,
    ],
    [
      'the status answer is not JSON',
      (args) =>
        args[0] === 'run'
          ? recorded('runList', mergeCommit)
          : args[3]?.includes('/statuses')
            ? { code: 0, stderr: '', stdout: '<html>' }
            : recorded('deployments', mergeCommit),
      'unknown',
      null,
    ],
    [
      'the deployments list fails',
      (args) =>
        args[0] === 'run'
          ? recorded('runList', mergeCommit)
          : { code: 1, stderr: 'HTTP 403', stdout: '' },
      null,
      'HTTP 403',
    ],
  ];
  for (const [name, answer, state, reason] of cases) {
    const { value } = host(root, thread, effects, answer);
    const deploy = (await readChatBranchStatus(value, { taskId, branch: 'crewkite/net' })).deploy;
    assert.equal(deploy?.deployments?.[0]?.state ?? null, state, name);
    assert.equal(deploy?.deployments === null, state === null, name);
    assert.equal(deploy?.reason, reason, name);
    assert.equal(deploy?.following, true, name);
  }
});

// A commit on `branch` in the project, with one file changed, and the thread accepting it there.
function accept(root: string, thread: ChatThread, branch: string, text: string): ChatThread {
  git(root, 'checkout', '--quiet', '-B', branch);
  writeFileSync(join(root, 'net.mjs'), `export const net = ${JSON.stringify(text)};\n`);
  git(root, 'commit', '--quiet', '-am', text);
  const commit = git(root, 'rev-parse', 'HEAD');
  return { ...thread, lastAcceptance: { branch, at: now, fileCount: 1, commit } };
}
// The write journal reads the thread from the store, as the controller keeps it.
const keep = (store: Store, thread: ChatThread) =>
  store.transaction(() =>
    store.db
      .prepare('UPDATE chat_threads SET body = ? WHERE task_id = ?')
      .run(JSON.stringify(thread), taskId),
  );
const pushOf = (thread: ChatThread) => ({
  taskId,
  branch: thread.lastAcceptance?.branch as string,
  commit: thread.lastAcceptance?.commit as string,
  remote: 'origin',
  confirmed: true as const,
});

// Claim: a push with a lease is plain git and reaches any remote git can reach, as it did before
// the write journal. Each branch keeps its own lease, so pushing A, then B, then A again goes
// through, and a branch someone else moved still refuses. The GitHub parts say in one line that
// the remote is not GitHub and never run gh for it.
test('a push reaches a remote that is no GitHub repository, with a lease for each branch', async (t) => {
  for (const form of ['path', 'file'] as const) {
    const { root, remote, thread } = fixture(t);
    const url = form === 'path' ? remote : `file://${remote}`;
    git(root, 'remote', 'set-url', 'origin', url);
    git(root, 'remote', 'set-url', '--push', 'origin', url);
    const { effects } = writeJournal(t, root, thread);
    const ghCalls: string[][] = [];
    let current = thread;
    const push = async (next: ChatThread) => {
      const { value, saved } = host(root, next, effects, (args) => {
        ghCalls.push(args);
        return null;
      });
      const answer = await pushChatBranch(value, pushOf(next));
      current = saved();
      return answer;
    };
    const first = accept(root, current, 'crewkite/net', 'one');
    assert.equal((await push(first)).outcome, 'applied', form);
    assert.equal((await push(accept(root, current, 'crewkite/other', 'two'))).outcome, 'applied');
    const again = accept(root, current, 'crewkite/net', 'three');
    assert.equal((await push(again)).outcome, 'applied', `${form}: A, B, then A again`);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/crewkite/net'), again.lastAcceptance?.commit);
    assert.deepEqual(
      current.pushes?.map((entry) => [entry.branch, entry.commit]),
      [
        ['crewkite/net', again.lastAcceptance?.commit],
        ['crewkite/other', git(remote, 'rev-parse', 'refs/heads/crewkite/other')],
      ],
    );
    assert.deepEqual(effects.list(taskId), [], 'A plain push writes no GitHub journal entry.');
    // Someone else moves the branch. The lease refuses and nothing is overwritten.
    git(root, 'push', '--quiet', remote, 'crewkite/other:refs/heads/crewkite/net', '--force');
    const moved = await push(accept(root, current, 'crewkite/net', 'four'));
    assert.deepEqual(
      [moved.outcome, moved.reason],
      ['blocked', 'crewkite/net changed on origin since you last saw it.'],
    );
    const { value } = host(root, current, effects, (args) => {
      ghCalls.push(args);
      return null;
    });
    const line =
      'origin is not a GitHub repository, so pull requests, CI and deploys are not read for it.';
    const pull = await openChatPullRequest(value, {
      taskId,
      branch: 'crewkite/net',
      title: 'Net',
      body: '',
    });
    assert.deepEqual([pull.reason, pull.next], ['remote-not-github', line]);
    const status = await readChatBranchStatus(value, { taskId, branch: 'crewkite/net' });
    assert.equal(status.reason, line);
    assert.deepEqual(ghCalls, [], 'gh is never asked about a remote that is not GitHub.');
  }
});

// Claim: a push to GitHub leases on the write journal for its own branch, so pushing A, then B,
// then A again goes through, and a push a person settled as done leases on what it sent.
test('a GitHub push leases on the journal for its branch, settled writes included', async (t) => {
  const { root, remote, thread } = fixture(t);
  const { effects, store } = writeJournal(t, root, thread);
  let current = thread;
  const push = async (next: ChatThread) => {
    keep(store, next);
    const { value, saved } = host(root, next, effects);
    const answer = await pushChatBranch(value, pushOf(next));
    current = saved();
    keep(store, current);
    return answer;
  };
  assert.equal((await push(accept(root, current, 'crewkite/net', 'one'))).outcome, 'applied');
  assert.equal((await push(accept(root, current, 'crewkite/other', 'two'))).outcome, 'applied');
  const again = accept(root, current, 'crewkite/net', 'three');
  assert.equal((await push(again)).outcome, 'applied', 'A, B, then A again');
  assert.equal(git(remote, 'rev-parse', 'refs/heads/crewkite/net'), again.lastAcceptance?.commit);

  // A push that ended unknown and that the person settled as done after checking GitHub.
  const settledThread = accept(root, current, 'crewkite/settled', 'four');
  const sent = settledThread.lastAcceptance?.commit as string;
  git(root, 'push', '--quiet', remote, `${sent}:refs/heads/crewkite/settled`);
  const effect: RemoteEffect = {
    id: `rfx_0${'9'.repeat(25)}`,
    taskId,
    kind: 'push',
    state: 'applied',
    target: {
      repo: { host: 'github.com', owner: 'rjk6831', name: 'demo-shop' },
      branch: 'crewkite/settled',
      pr: null,
      headSha: sent,
      baseRef: null,
    },
    request: { kind: 'push', remote: 'origin', commit: sent, expectedRemote: null },
    confirmation: { at: now, by: 'person' },
    observed: null,
    reason: 'You checked GitHub and marked this as done.',
    settled: { at: now, by: 'person', note: 'The branch is there.' },
  };
  store.transaction(() => store.putRemoteEffect(effect, now));
  const after = accept(root, current, 'crewkite/settled', 'five');
  assert.equal((await push(after)).outcome, 'applied', 'The settled push is the lease.');
  assert.equal(
    git(remote, 'rev-parse', 'refs/heads/crewkite/settled'),
    after.lastAcceptance?.commit,
  );
});

// Claim: Open pull request with another title or body replaces the proposal waiting for the
// person, so the preview they confirm holds what they wrote last.
test('a pull request proposal follows a changed title or body', async (t) => {
  const { root, thread } = fixture(t);
  const journal = writeJournal(t, root, thread);
  const { effects, store } = journal;
  const pushed = accept(root, thread, 'crewkite/net', 'one');
  keep(store, pushed);
  const { value, saved } = host(root, pushed, effects);
  assert.equal((await pushChatBranch(value, pushOf(pushed))).outcome, 'applied');
  keep(store, saved());
  journal.gh().answer({ 'GET /repos/rjk6831/demo-shop': { json: { default_branch: 'main' } } });
  const open = async (title: string, body: string) => {
    const answer = await openChatPullRequest(host(root, saved(), effects).value, {
      taskId,
      branch: 'crewkite/net',
      title,
      body,
    });
    assert(answer.data?.kind === 'remote-effect');
    return answer.data.effect;
  };
  const first = await open('Add net', 'First body.');
  assert.equal((await open('Add net', 'First body.')).id, first.id, 'The same words reuse it.');
  const retitled = await open('Add the net helper', 'First body.');
  assert.notEqual(retitled.id, first.id);
  assert.deepEqual(retitled.request, {
    kind: 'pr-open',
    title: 'Add the net helper',
    body: 'First body.',
    draft: false,
  });
  const rewritten = await open('Add the net helper', 'Second body.');
  assert.equal(rewritten.request.kind === 'pr-open' && rewritten.request.body, 'Second body.');
  assert.deepEqual(
    effects.list(taskId).map((effect) => [effect.kind, effect.state]),
    [
      ['push', 'applied'],
      ['pr-open', 'cancelled'],
      ['pr-open', 'cancelled'],
      ['pr-open', 'proposed'],
    ],
  );
});

// Claim: a merge after which nothing ran on the base branch says so once GitHub has had time to
// list a run, and stops following. It never reads as still running.
test('a merge with no runs and no deployments says nothing ran', async (t) => {
  const { root, commit, thread } = fixture(t);
  const { effects, store } = writeJournal(t, root, thread);
  const mergeCommit = 'd'.repeat(40);
  merged(store, commit, mergeCommit, now);
  const empty: ToolRun = { code: 0, stderr: '', stdout: '[]' };
  const at = (time: string) => {
    const { value } = host(root, thread, effects, () => empty);
    value.now = () => time;
    return readChatBranchStatus(value, { taskId, branch: 'crewkite/net' });
  };
  const early = (await at('2026-10-24T09:01:00.000Z')).deploy;
  assert.deepEqual([early?.following, early?.reason], [true, null], 'A minute in it may be early.');
  const quiet = (await at('2026-10-24T09:20:00.000Z')).deploy;
  assert.deepEqual(
    [quiet?.following, quiet?.reason, quiet?.runs, quiet?.deployments],
    [false, 'Nothing ran on GitHub for this merge.', [], []],
  );
  const later = (await at('2026-10-24T11:30:00.000Z')).deploy;
  assert.equal(later?.reason, 'Nothing ran on GitHub for this merge.');
});
