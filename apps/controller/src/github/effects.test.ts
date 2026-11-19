import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ChatThreadSchema,
  type CommandResult,
  type RemoteEffect,
  type Task,
} from '@crewkite/contracts';
import { Controller } from '../commands/controller.ts';
import { type FakeGhAnswer, fakeGh, installedTools, setup } from '../store/controller-fixture.ts';
import { Store } from '../store/index.ts';
import { RemoteEffects } from './effects.ts';

// The fake gh answers with the recorded GitHub responses in fixtures/remote-writes.json.
const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/remote-writes.json', import.meta.url), 'utf8'),
);
const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const ulid = (prefix: string, n: number) =>
  `${prefix}_01JB7Q0V2N8W3X4Y5Z6A7B8C${String(n).padStart(2, '0')}`;
const taskId = ulid('tsk', 1);
const projectId = ulid('prj', 1);
const repo = { host: 'github.com', owner: 'crew-kite', name: 'demo-shop' };
const branch = 'feat/sales-chart';
// The head the recorded pull request and check runs name.
const head = '7c1e5d2a9f3b8e4c6d0a1b2c3d4e5f60718293a4';
const pull = '/repos/crew-kite/demo-shop/pulls/42';
const comments = `${pull}/comments?sort=created&direction=desc&per_page=100`;
const sealed = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: sealed, encoding: 'utf8' }).trim();

// A recorded GitHub refusal: gh prints the response body on stdout and its summary on stderr.
const refusedWith = (recordedAnswer: { stdout: unknown; stderr: string }): FakeGhAnswer => ({
  ...recordedAnswer,
  code: 1,
});

/** A process group that runs until the test ends it, standing for a write still in flight. */
function liveGroup(t: TestContext) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(() => {
    child.kill('SIGKILL');
    return exited;
  });
  return {
    group: child.pid as number,
    alive: () => child.exitCode === null && child.signalCode === null,
    end: () => {
      child.kill('SIGKILL');
      return exited;
    },
  };
}

// A project whose origin fetches from github.com and pushes to a local bare repository, a thread
// that accepted and pushed feat/sales-chart after a two slice plan, and the write journal on a
// real store. The clock stands still. `pushed` names another head the thread pushed last.
function world(t: TestContext, pushed?: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ck-effects-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'demo-shop');
  const remote = join(directory, 'remote.git');
  git(directory, 'init', '--quiet', '--bare', remote);
  git(directory, 'init', '--quiet', '--initial-branch=main', root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/chart.ts'), 'export const chart = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'base');
  git(root, 'switch', '--quiet', '-c', branch);
  writeFileSync(
    join(root, 'src/chart.ts'),
    'export const chart = 1;\nexport const months = 12;\n// sums\n',
  );
  writeFileSync(join(root, 'src/labels.ts'), 'export const axis = "Month";\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'feat: chart monthly sales');
  const commit = git(root, 'rev-parse', 'HEAD');
  git(root, 'remote', 'add', 'origin', 'https://github.com/crew-kite/demo-shop.git');
  git(root, 'remote', 'set-url', '--push', 'origin', remote);

  const now = () => '2026-11-18T09:00:00.000Z';
  const store = new Store(join(directory, 'state.sqlite'));
  store.applyMigrations(migrations);
  t.after(() => store.close());
  const thread = ChatThreadSchema.parse({
    taskId,
    scratchReady: true,
    base: commit,
    selection: null,
    lastAcceptance: { branch, at: now(), fileCount: 2, commit },
    lastPush: {
      branch,
      remote: 'origin',
      commit: pushed ?? commit,
      at: now(),
      pullRequestUrl: null,
    },
    plan: {
      planId: 'sales-chart',
      orchestratorTurnId: ulid('trn', 1),
      goal: 'Chart monthly sales',
      phase: 'finished',
      slices: [
        {
          id: 1,
          title: 'Add the chart',
          difficulty: 'easy',
          depends: [],
          readOnly: false,
          status: 'done',
          assignment: null,
          candidates: [],
          turnId: ulid('trn', 2),
        },
        {
          id: 2,
          title: 'Label the axes',
          difficulty: 'easy',
          depends: [1],
          readOnly: false,
          status: 'failed',
          assignment: null,
          candidates: [],
          turnId: ulid('trn', 3),
        },
      ],
    },
  });
  store.transaction(() => {
    store.put('project', projectId, 0, { id: projectId, name: 'demo-shop', revision: 0 });
    store.put('task', taskId, 0, { id: taskId, projectId, title: 'Chart monthly sales' });
    store.db
      .prepare('INSERT INTO chat_threads(task_id,body) VALUES (?,?)')
      .run(taskId, JSON.stringify(thread));
  });

  const gh = fakeGh(directory);
  mkdirSync(join(directory, 'user'));
  let next = 0;
  const effects = new RemoteEffects({
    store,
    home: join(directory, 'home'),
    now,
    id: () => ulid('rfx', ++next),
    projectPath: (id) => (id === projectId ? root : undefined),
    // The fake gh and git, and nothing else, so no test reaches an installed gh.
    environment: {
      HOME: join(directory, 'user'),
      PATH: `${gh.bin}${delimiter}${installedTools(directory, 'git')}`,
    },
  });
  t.after(() => effects.close());
  const effect = (result: CommandResult) => {
    assert(result.data?.kind === 'remote-effect', JSON.stringify(result));
    return result.data.effect;
  };
  return {
    ...gh,
    store,
    effects,
    root,
    remote,
    commit,
    now,
    effect,
    propose: (target: Partial<RemoteEffect['target']>, request: RemoteEffect['request']) =>
      effect(
        store.transaction(() =>
          effects.propose({
            taskId,
            target: { repo, branch: null, pr: 42, headSha: head, baseRef: null, ...target },
            request,
          }),
        ),
      ),
    confirm: (id: string) => effects.confirm({ effectId: id, confirm: 'explicit' }),
  };
}

// Claim: a proposal reads only local Git and sends nothing, and text the policy refuses is never
// recorded; the person's confirmation sends the exact previewed write once, and the pull request
// it opened is recorded by number, including the one GitHub says is already open, never one that
// was closed without a merge.
test('nothing reaches the remote before the person confirms, and a confirmed pull request records its number', async (t) => {
  const w = world(t);
  w.answer({
    'POST /repos/crew-kite/demo-shop/pulls': {
      json: {
        ...recorded['pull-request-created'],
        head: { ...recorded['pull-request-created'].head, sha: w.commit },
      },
    },
  });
  const attributed = w.store.transaction(() =>
    w.effects.propose({
      taskId,
      target: { repo, branch, pr: null, headSha: w.commit, baseRef: 'main' },
      request: {
        kind: 'pr-open',
        title: 'feat: chart monthly sales',
        body: 'Charts sales.\n\nCo-authored-by: Helper <helper@example.invalid>',
        draft: false,
      },
    }),
  );
  assert.equal(attributed.reason, 'policy-attribution');
  const proposed = w.propose(
    { branch, pr: null, headSha: w.commit, baseRef: 'main' },
    { kind: 'pr-open', title: 'feat: chart monthly sales', body: '', draft: false },
  );
  assert.equal(proposed.state, 'proposed');
  const body = [
    'Chart monthly sales',
    '',
    'Slices:',
    `- 1. Add the chart: done, turn ${ulid('trn', 2)}`,
    `- 2. Label the axes: failed, turn ${ulid('trn', 3)}`,
    '',
    'Changed files (2):',
    '- src/chart.ts +2 -0',
    '- src/labels.ts +1 -0',
  ].join('\n');
  assert.deepEqual(proposed.request, {
    kind: 'pr-open',
    title: 'feat: chart monthly sales',
    body,
    draft: false,
  });
  const read = w.effects.read({ taskId });
  assert(read.data?.kind === 'remote-effects');
  assert.deepEqual(read.data.effects, [proposed]);
  assert.deepEqual(w.calls(), [], 'A proposal runs nothing.');

  const sent = await w.confirm(proposed.id);
  assert.equal(sent.outcome, 'applied', JSON.stringify(sent));
  assert(sent.data?.kind === 'remote-effect');
  assert.match(
    sent.data.preview,
    /^gh api --method POST --hostname github.com --header 'Accept: application\/vnd.github\+json' --header 'X-GitHub-Api-Version: 2022-11-28' --input request.json \/repos\/crew-kite\/demo-shop\/pulls$/m,
  );
  assert.deepEqual(
    { state: sent.data.effect.state, observed: sent.data.effect.observed },
    { state: 'applied', observed: { at: w.now(), result: 'applied', created: { pr: 42 } } },
  );
  const [call, ...more] = w.calls();
  assert.deepEqual(more, []);
  assert.deepEqual(
    call?.argv.filter((word) => !word.endsWith(`${proposed.id}.json`)),
    [
      'api',
      '--method',
      'POST',
      '--hostname',
      'github.com',
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      'X-GitHub-Api-Version: 2022-11-28',
      '--input',
      '/repos/crew-kite/demo-shop/pulls',
    ],
  );
  assert.deepEqual(call?.input, {
    title: 'feat: chart monthly sales',
    body,
    head: branch,
    base: 'main',
    draft: false,
  });

  assert.equal((await w.confirm(proposed.id)).outcome, 'already-applied');
  assert.equal(w.calls().length, 1, 'A second confirmation sends nothing.');

  // GitHub keeps one open pull request per branch and says so in the body on stdout. The open
  // one at the pushed head is adopted. The old closed one is not, and neither is #43, opened
  // within the clock skew of the confirmation and closed without a merge.
  const listed = recorded['pulls-from-branch'].map((entry: { head: object }, index: number) =>
    index === 0 ? { ...entry, head: { ...entry.head, sha: w.commit } } : entry,
  );
  listed.push({ ...listed[1], number: 43, created_at: '2026-11-18T08:58:00Z' });
  w.answer({
    'POST /repos/crew-kite/demo-shop/pulls': refusedWith(recorded['pull-request-exists']),
    'GET /repos/crew-kite/demo-shop/pulls?head=crew-kite%3Afeat%2Fsales-chart&state=all&per_page=30':
      { json: listed },
  });
  const again = await w.confirm(
    w.propose(
      { branch, pr: null, headSha: w.commit, baseRef: 'main' },
      { kind: 'pr-open', title: 'feat: chart monthly sales', body: 'Again.', draft: false },
    ).id,
  );
  assert.equal(again.outcome, 'applied', JSON.stringify(again));
  assert.deepEqual(w.effect(again).observed?.created, { pr: 42 });
});

// Claim: a merge reads branch protection, the branch rules and the head's checks first and
// refuses, with nothing sent, while a required check is not green or the head moved; GitHub's own
// refusal is recorded with its message; no call ever asks for an administrator bypass. Before the
// click, the same read names each required check on the head the thread pushed and GitHub's merge
// state.
test('a merge refuses on a red required check or a moved head and never asks for a bypass', async (t) => {
  // The thread pushed the head the recorded pull request names, and opened #42 from it.
  const w = world(t, head);
  w.store.transaction(() =>
    w.store.putRemoteEffect(
      {
        id: ulid('rfx', 60),
        taskId,
        kind: 'pr-open',
        state: 'applied',
        target: { repo, branch, pr: null, headSha: head, baseRef: 'main' },
        request: { kind: 'pr-open', title: 'feat: chart monthly sales', body: '', draft: false },
        confirmation: { at: w.now(), by: 'person' },
        observed: { at: w.now(), result: 'applied', created: { pr: 42 } },
        reason: null,
      },
      w.now(),
    ),
  );
  const reads = (
    pullRequest: unknown,
    checks: unknown,
    merging: FakeGhAnswer = { json: recorded['merge-applied'] },
  ): Record<string, FakeGhAnswer> => ({
    [`GET ${pull}`]: { json: pullRequest },
    'GET /repos/crew-kite/demo-shop/branches/main': { json: recorded['branch-main-protected'] },
    'GET /repos/crew-kite/demo-shop/rules/branches/main?per_page=100': {
      json: recorded['rules-main'],
    },
    [`GET /repos/crew-kite/demo-shop/commits/${head}/check-runs?per_page=100`]: { json: checks },
    [`GET /repos/crew-kite/demo-shop/commits/${head}/status?per_page=100`]: {
      json: recorded['commit-status-empty'],
    },
    [`PUT ${pull}/merge`]: merging,
  });
  const merge = () =>
    w.propose({ baseRef: 'main' }, { kind: 'merge', method: 'squash', expectedHead: head });
  const open = recorded['pull-request-open'];
  const moved = { ...open, head: { ...open.head, sha: 'e'.repeat(40) } };
  const readiness = async () => {
    const read = await w.effects.readMergeReadiness({ taskId });
    assert(read.data?.kind === 'merge-readiness', JSON.stringify(read));
    const { pr, headSha, checks, mergeState, reason, line } = read.data;
    return { pr, headSha, checks, mergeState, reason, line };
  };
  w.answer(reads(open, recorded['check-runs-red']));
  assert.deepEqual(await readiness(), {
    pr: 42,
    headSha: head,
    checks: [
      { name: 'e2e', state: 'missing' },
      { name: 'verify', state: 'failure' },
    ],
    mergeState: 'clean',
    reason: 'Required checks are not green on 7c1e5d2a9f3b: e2e (missing), verify (failure).',
    line: null,
  });
  w.answer(reads(open, recorded['check-runs-green']));
  assert.equal(
    (await readiness()).line,
    'Required checks green on 7c1e5d2a9f3b: e2e, verify. No review or rule GitHub enforces blocks it.',
  );
  assert.ok(
    w.calls().every((call) => call.argv.includes('GET')),
    'The read before the click only reads.',
  );
  for (const [name, pullRequest, checks, reason] of [
    [
      'red required check',
      open,
      recorded['check-runs-red'],
      /^Required checks are not green on 7c1e5d2a9f3b: e2e \(missing\), verify \(failure\)\.$/,
    ],
    ['moved head', moved, recorded['check-runs-green'], /moved to eeeeeeeeeeee/],
  ] as const) {
    w.answer(reads(pullRequest, checks));
    const refused = await w.confirm(merge().id);
    assert.equal(refused.outcome, 'blocked', name);
    assert.equal(w.effect(refused).state, 'refused', name);
    assert.match(w.effect(refused).reason ?? '', reason, name);
  }
  assert.equal(
    w.calls().some((call) => call.argv.at(-1)?.endsWith('/merge')),
    false,
    'A refused merge sends nothing.',
  );

  w.answer(reads(open, recorded['check-runs-green'], refusedWith(recorded['merge-refused'])));
  const turnedAway = await w.confirm(merge().id);
  assert.equal(w.effect(turnedAway).state, 'refused');
  assert.equal(w.effect(turnedAway).reason, 'Required status check "verify" is expected.');

  w.answer(reads(open, recorded['check-runs-green']));
  const merged = await w.confirm(merge().id);
  assert.equal(merged.outcome, 'applied', JSON.stringify(merged));
  assert.deepEqual(w.effect(merged).observed?.created, {
    sha: recorded['merge-applied'].sha,
  });
  const put = w.calls().find((call) => call.argv.at(-1)?.endsWith('/merge'));
  assert.deepEqual(put?.input, { merge_method: 'squash', sha: head });
  assert.equal(
    w.calls().some((call) => call.argv.some((word) => /admin/i.test(word))),
    false,
  );
});

// Claim: a write whose process dies after sending is unknown, is never sent again, and only a
// read of the remote settles it: applied when the remote shows it, whole and within the clock
// skew; refused when the remote shows nothing and the process is proven gone; still unknown while
// the remote cannot be read, the read was cut short, or the process may still run.
test('a write that dies after sending stays unknown until a read of the remote settles it', async (t) => {
  const w = world(t);
  // Longer than the thread shows, so only a whole comparison finds it.
  const text = recorded['review-comments-with-long-reply'][0].body;
  const reply = () => w.propose({}, { kind: 'review-reply', commentId: '1999', body: text });
  const sending: Record<string, FakeGhAnswer> = {
    [`GET ${pull}`]: { json: recorded['pull-request-open'] },
    [`POST ${pull}/comments/1999/replies`]: { die: true },
  };
  w.answer(sending);
  const first = reply();
  const lost = await w.confirm(first.id);
  assert.equal(lost.reason, 'remote-result-unknown');
  assert.equal(w.effect(lost).state, 'unknown');
  assert.equal((await w.confirm(first.id)).reason, 'remote-result-unknown');
  assert.equal(
    w.calls().filter((call) => call.argv.at(-1)?.endsWith('/replies')).length,
    1,
    'An unknown write is never sent again.',
  );

  w.answer({ 'GET /user': { code: 1, stderr: 'error connecting to api.github.com\n' } });
  const unreadable = await w.effects.reconcile({ effectId: first.id });
  assert.equal(unreadable.reason, 'remote-unreadable');
  assert.match(unreadable.next ?? '', /error connecting to api.github.com/);
  assert.equal(w.store.remoteEffect(first.id)?.state, 'unknown');

  const remote = (listed: unknown): Record<string, FakeGhAnswer> => ({
    'GET /user': { json: recorded.user },
    [`GET ${pull}`]: { json: recorded['pull-request-open'] },
    [`GET ${comments}`]: { json: listed },
  });
  // GitHub stamped the reply two minutes before this computer's confirmation time.
  w.answer(remote(recorded['review-comments-with-long-reply']));
  const found = await w.effects.reconcile({ effectId: first.id });
  assert.equal(found.outcome, 'applied');
  assert.deepEqual(w.effect(found).observed?.created, { id: '2001' });
  // The read the thread shows: by file, oldest first, bodies bounded, bound to the head.
  const grouped = await w.effects.readReviewComments({ taskId, repo, pr: 42, headSha: head });
  assert(grouped.data?.kind === 'review-comments', JSON.stringify(grouped));
  assert.deepEqual(
    grouped.data.files.map((file) => [file.path, file.comments.map((comment) => comment.id)]),
    [
      ['src/chart.ts', ['1999', '2001']],
      ['src/labels.ts', ['1998']],
    ],
  );
  assert.equal(grouped.data.files[0]?.comments[1]?.body.length, 4000);
  const moved = await w.effects.readReviewComments({
    taskId,
    repo,
    pr: 42,
    headSha: 'e'.repeat(40),
  });
  assert.deepEqual(
    [moved.reason, moved.next],
    ['review-comments-unreadable', 'The pull request head is no longer eeeeeeeeeeee.'],
  );

  w.answer(sending);
  const second = reply();
  assert.equal(w.effect(await w.confirm(second.id)).state, 'unknown');
  const others = Array.from({ length: 100 }, (_, index) => ({
    ...recorded['review-comments-without-reply'][0],
    id: 3000 + index,
  }));
  w.answer(remote(others));
  assert.equal((await w.effects.reconcile({ effectId: second.id })).reason, 'remote-unreadable');
  // This controller saw the process end, so nothing on the remote settles it.
  w.answer(remote(recorded['review-comments-without-reply']));
  const absent = await w.effects.reconcile({ effectId: second.id });
  assert.equal(w.effect(absent).state, 'refused');
  assert.deepEqual(w.effect(absent).observed, { at: w.now(), result: 'absent', created: null });

  // A write whose process may still run waits for it to end before nothing settles it.
  const running = liveGroup(t);
  const third: RemoteEffect = {
    ...second,
    id: ulid('rfx', 80),
    state: 'unknown',
    confirmation: { at: w.now(), by: 'person' },
  };
  w.store.transaction(() => {
    w.store.putRemoteEffect(third, w.now());
    w.store.setRemoteEffectProcess(third.id, running.group);
  });
  assert.equal((await w.effects.reconcile({ effectId: third.id })).reason, 'remote-write-may-land');
  await running.end();
  assert.equal(w.effect(await w.effects.reconcile({ effectId: third.id })).state, 'refused');

  // A push is read back from where it went: the push URL.
  git(w.root, 'push', '--quiet', w.remote, `${w.commit}:refs/heads/${branch}`);
  const push: RemoteEffect = {
    id: ulid('rfx', 90),
    taskId,
    kind: 'push',
    state: 'unknown',
    target: { repo, branch, pr: null, headSha: w.commit, baseRef: null },
    request: { kind: 'push', remote: 'origin', commit: w.commit, expectedRemote: null },
    confirmation: { at: w.now(), by: 'person' },
    observed: null,
    reason: null,
  };
  w.store.transaction(() => w.store.putRemoteEffect(push, w.now()));
  const pushed = await w.effects.reconcile({ effectId: push.id });
  assert.equal(w.effect(pushed).state, 'applied', JSON.stringify(pushed));
});

// Claim: one write of a kind is in flight per thread, so a second of that kind waits until the
// first settles while other kinds go ahead, a confirmed one nothing sent gives way, and the
// thread cannot be deleted under a write in flight.
test('one write of each kind is in flight per thread, and the thread stays until it settles', async (t) => {
  const w = world(t);
  w.answer({
    [`GET ${pull}`]: { json: recorded['pull-request-open'] },
    [`POST ${pull}/comments/1999/replies`]: { die: true },
    'pr ready 42 --repo github.com/crew-kite/demo-shop': { stderr: 'Pull request #42 is ready.\n' },
  });
  const reply = (body: string) => w.propose({}, { kind: 'review-reply', commentId: '1999', body });
  const lost = reply('Rounded in the next commit.');
  assert.equal(w.effect(await w.confirm(lost.id)).state, 'unknown');
  const sentBefore = w.calls().length;

  const waiting = reply('Rounded, and the labels too.');
  const held = await w.confirm(waiting.id);
  assert.equal(held.reason, 'remote-write-in-flight');
  assert.equal(w.store.remoteEffect(waiting.id)?.state, 'proposed');
  assert.equal(w.calls().length, sentBefore, 'A held write reads and sends nothing.');
  // A restart left a pr-ready confirmed and unsent. The next one cancels it and goes ahead.
  const leftover: RemoteEffect = {
    ...w.propose({}, { kind: 'pr-ready' }),
    state: 'confirmed',
    confirmation: { at: w.now(), by: 'person' },
  };
  w.store.transaction(() => w.store.putRemoteEffect(leftover, w.now()));
  const ready = await w.confirm(w.propose({}, { kind: 'pr-ready' }).id);
  assert.equal(ready.outcome, 'applied', JSON.stringify(ready));
  assert.equal(w.store.remoteEffect(leftover.id)?.state, 'cancelled');

  assert.equal(
    w.store.transaction(() => w.store.removeTask(taskId)),
    false,
  );
  const cancel = (effectId: string) => w.store.transaction(() => w.effects.cancel({ effectId }));
  assert.equal(cancel(lost.id).reason, 'remote-write-not-cancellable');
  assert.equal(w.effect(cancel(waiting.id)).state, 'cancelled');
});

// Claim: settling by hand needs an unknown write that a reconcile in this controller read and could
// not settle. It records the person, the time and their note, reads and sends nothing, and frees the
// write's kind and the thread delete.
test('settle refuses from any state but unknown and frees the slot and the thread delete', async (t) => {
  const w = world(t);
  w.answer({
    [`GET ${pull}`]: { json: recorded['pull-request-open'] },
    [`POST ${pull}/comments/1999/replies`]: { die: true },
    'GET /user': { code: 1, stderr: 'error connecting to api.github.com\n' },
  });
  const note = 'PR #42 shows no reply from me.';
  const settle = (effectId: string, outcome: 'applied' | 'not-applied') =>
    w.store.transaction(() =>
      w.effects.settle({ effectId, outcome, confirm: 'explicit', note: ` ${note}\n` }),
    );
  const reply = (body: string) => w.propose({}, { kind: 'review-reply', commentId: '1999', body });

  const first = reply('Rounded in the next commit.');
  assert.equal(settle(first.id, 'not-applied').reason, 'remote-write-not-unknown');
  assert.equal(w.effect(await w.confirm(first.id)).state, 'unknown');
  assert.equal(settle(first.id, 'not-applied').reason, 'remote-write-not-checked');
  assert.equal(
    w.store.transaction(() => w.store.removeTask(taskId)),
    false,
  );
  assert.equal((await w.effects.reconcile({ effectId: first.id })).reason, 'remote-unreadable');
  const before = w.calls().length;
  const notSent = settle(first.id, 'not-applied');
  assert.equal(notSent.outcome, 'applied', JSON.stringify(notSent));
  const { state, observed, settled } = w.effect(notSent);
  assert.deepEqual(
    { state, observed, settled },
    { state: 'refused', observed: null, settled: { at: w.now(), by: 'person', note } },
  );
  assert.deepEqual(w.store.remoteEffect(first.id), w.effect(notSent));
  assert.equal(w.calls().length, before, 'Settling reads and sends nothing.');
  assert.equal(settle(first.id, 'applied').reason, 'remote-write-not-unknown');

  // The kind is free again, so the next reply is sent. Settled as done, it frees the thread.
  const second = reply('Rounded, and the labels too.');
  assert.equal(w.effect(await w.confirm(second.id)).state, 'unknown');
  await w.effects.reconcile({ effectId: second.id });
  assert.equal(w.effect(settle(second.id, 'applied')).state, 'applied');
  assert.equal(settle(second.id, 'applied').reason, 'remote-write-not-unknown');
  assert.equal(
    w.store.transaction(() => w.store.removeTask(taskId)),
    true,
  );
});

// Claim: a controller that starts again finds a write it was sending, marks it unknown and sends
// nothing, even when the person confirms it again; the process group it recorded is kept as
// evidence and never signalled, and the person cannot settle it by hand before this controller
// read the remote. A proposal left waiting is read back with its preview and proposed again
// nowhere.
test('startup turns a write that was being sent into unknown and sends nothing', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'ck-effects-start-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const gh = fakeGh(folder);
  const gitEnvironment = {
    HOME: folder,
    PATH: `${gh.bin}${delimiter}${installedTools(folder, 'git')}`,
  };
  const context = await setup(t, { gitEnvironment });
  const { command, clock, id } = context;
  const task = (await context.controller.execute(context.draft, 'local-owner')).entity as Task;
  const running = liveGroup(t);
  const effectId = ulid('rfx', 7);
  const waitingId = ulid('rfx', 8);
  context.controller.store.transaction(() => {
    context.controller.store.putRemoteEffect(
      {
        id: effectId,
        taskId: task.id,
        kind: 'pr-ready',
        state: 'sent',
        target: { repo, branch: null, pr: 42, headSha: head, baseRef: null },
        request: { kind: 'pr-ready' },
        confirmation: { at: clock.now(), by: 'person' },
        observed: null,
        reason: null,
      },
      clock.now(),
    );
    context.controller.store.setRemoteEffectProcess(effectId, running.group);
    context.controller.store.putRemoteEffect(
      {
        id: waitingId,
        taskId: task.id,
        kind: 'pr-draft',
        state: 'proposed',
        target: { repo, branch: null, pr: 42, headSha: head, baseRef: null },
        request: { kind: 'pr-draft' },
        confirmation: null,
        observed: null,
        reason: null,
      },
      clock.now(),
    );
  });
  await context.controller.close();

  const restarted = new Controller({
    home: join(context.directory, 'home'),
    now: clock.now,
    id,
    gitEnvironment,
  });
  t.after(() => restarted.close());
  const read = await restarted.execute(
    command('ReadRemoteEffects', { taskId: task.id }),
    'local-owner',
  );
  assert(read.data?.kind === 'remote-effects', JSON.stringify(read));
  assert.equal(read.data.effects[0]?.state, 'unknown');
  assert.match(read.data.effects[0]?.reason ?? '', /stopped while this write was running/);
  const again = await restarted.execute(
    command('ConfirmRemoteEffect', { effectId, confirm: 'explicit' }, 0),
    'local-owner',
  );
  assert.equal(again.reason, 'remote-result-unknown');
  const settled = await restarted.execute(
    command(
      'SettleRemoteEffect',
      { effectId, outcome: 'not-applied', confirm: 'explicit', note: 'Nothing on GitHub.' },
      0,
    ),
    'local-owner',
  );
  assert.equal(settled.reason, 'remote-write-not-checked');
  const waiting = await restarted.execute(
    command('ReadRemoteEffectPreview', { effectId: waitingId }),
    'local-owner',
  );
  assert(waiting.data?.kind === 'remote-effect', JSON.stringify(waiting));
  assert.equal(waiting.data.effect.state, 'proposed');
  assert.match(
    waiting.data.preview,
    /^Turn pull request #42 on github.com\/crew-kite\/demo-shop back into a draft, head 7c1e5d2a/,
  );
  assert.equal(restarted.store.remoteEffects(task.id).length, 2, 'Nothing was proposed again.');
  assert.deepEqual(gh.calls(), []);
  // The thread heard the change, and the review comment read answers through the controller.
  assert.deepEqual(
    restarted.store
      .eventsAfter('0')
      .flatMap((event) =>
        event.type === 'remote-effect.updated' ? [[event.taskId, event.payload.state]] : [],
      ),
    [[task.id, 'unknown']],
  );
  const comments = await restarted.execute(
    command('ReadReviewComments', { taskId: task.id, repo, pr: 42, headSha: head }),
    'local-owner',
  );
  assert.equal(comments.reason, 'repository-not-a-remote');
  assert.equal(running.alive(), true);
  assert.equal(restarted.store.remoteEffectProcess(effectId), running.group);
});
