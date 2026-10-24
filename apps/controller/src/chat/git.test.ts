import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type ChatThread, ChatThreadSchema } from '@crewkite/contracts';
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

function host(root: string, thread: ChatThread, gh?: (args: string[]) => ToolRun | null) {
  const real = toolRunner(env);
  const notes: string[] = [];
  let saved = thread;
  const value: ChatGitHost = {
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

test('pushing an accepted branch reaches the remote once and is journaled on the thread', async (t) => {
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
  const { value, notes, saved } = host(root, thread);
  const payload = { taskId, branch: 'crewkite/net', remote: 'origin', confirmed: true } as const;

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
  // A second click finds the journaled push and runs nothing.
  assert.equal((await pushChatBranch(value, payload)).outcome, 'already-applied');

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
});

test('the branch status reads gh runs and says why when gh is missing', async () => {
  const thread = ChatThreadSchema.parse({
    taskId,
    scratchReady: true,
    base: null,
    selection: null,
  });
  const row = {
    databaseId: 101,
    name: 'verify',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/rjk6831/demo-shop/actions/runs/101',
    createdAt: '2026-10-24T08:00:00Z',
    event: 'push',
  };
  const cases: [string, ToolRun | null, { runs: unknown; reason: string | null }][] = [
    ['gh missing', null, { runs: null, reason: 'Install gh to see CI runs here.' }],
    [
      'gh signed out',
      {
        code: 4,
        stdout: '',
        stderr: 'To get started with GitHub CLI, please run:  gh auth login\n',
      },
      { runs: null, reason: 'To get started with GitHub CLI, please run:  gh auth login' },
    ],
    [
      'two runs, newest first, unknown status read as pending',
      {
        code: 0,
        stderr: '',
        stdout: JSON.stringify([
          row,
          {
            ...row,
            databaseId: 102,
            status: 'action_required',
            conclusion: '',
            createdAt: '2026-10-24T08:30:00Z',
          },
        ]),
      },
      {
        reason: null,
        runs: [
          {
            id: '102',
            name: 'verify',
            status: 'pending',
            conclusion: null,
            url: row.url,
            createdAt: '2026-10-24T08:30:00Z',
          },
          {
            id: '101',
            name: 'verify',
            status: 'completed',
            conclusion: 'success',
            url: row.url,
            createdAt: row.createdAt,
          },
        ],
      },
    ],
  ];
  for (const [name, answer, expected] of cases) {
    const asked: string[][] = [];
    const { value } = host('/project', thread, (args) => {
      asked.push(args);
      return answer;
    });
    const status = await readChatBranchStatus(value, { taskId, branch: 'crewkite/net' });
    assert.deepEqual(status, { branch: 'crewkite/net', readAt: now, ...expected }, name);
    assert.deepEqual(asked[0]?.slice(0, 4), ['run', 'list', '--branch', 'crewkite/net'], name);
  }
});
