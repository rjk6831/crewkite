import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type CommandResult,
  DEFAULT_REPOSITORY_POLICY,
  type Event,
  type RepositoryPolicy,
  suggestedSubject,
  type Task,
} from '@crewkite/contracts';
import { createScriptedChatAdapter } from '@crewkite/testkit/chat-adapter';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import {
  type GitIdentity,
  type GitIdentitySource,
  preparePublication,
  refValue,
} from '../host/publication.ts';
import { git } from '../host/source.ts';
import { setup } from '../store/controller-fixture.ts';
import { checkCommit, PolicyRefused } from './policy.ts';

const owner = { name: 'Fixture owner', email: 'owner@example.invalid' };
const signOff = 'Signed-off-by: Fixture owner <owner@example.invalid>';

// Claim: the one place that builds a commit refuses any commit or branch the policy refuses,
// names the rule, and writes nothing; a commit that meets it gains the sign-off it lacked; and the
// subject suggested from a thread title meets the default policy without an edit.
test('each policy rule refuses the commit by name before anything is written, and a compliant one is signed off', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'crewkite-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = createSyntheticRepository(join(directory, 'project'));
  const content = Buffer.from('export const net = 1;\n');
  const publish = (
    work: string,
    change: { message?: string; destinationRef?: string; identity?: GitIdentity | undefined },
  ) =>
    preparePublication({
      source: source.directory,
      repository: join(directory, work),
      base: source.base,
      files: [{ path: 'net.mjs', mode: '100644', hash: '', bytes: content.length, content }],
      policy: DEFAULT_REPOSITORY_POLICY,
      destinationRef: 'refs/heads/fix/round-totals',
      identity: owner,
      at: '2026-11-18T09:00:00.000Z',
      message: 'fix: round totals\n',
      ...change,
    });
  const lines = (...text: string[]) => `${text.join('\n')}\n`;
  for (const [rule, change] of [
    ['branch-name', { destinationRef: 'refs/heads/agent/round-totals' }],
    ['conventional', { message: 'Round totals\n' }],
    ['subject-length', { message: `fix: ${'round the totals '.repeat(4)}\n` }],
    [
      'attribution',
      {
        message: lines('fix: round totals', '', 'Co-authored-by: Helper <helper@example.invalid>'),
      },
    ],
    [
      'attribution',
      { message: lines('fix: round totals', '', 'See https://chat.example.invalid/session/01ABC') },
    ],
    ['identity', { identity: undefined }],
    [
      'sign-off',
      { message: lines('fix: round totals', '', 'Signed-off-by: Someone <else@example.invalid>') },
    ],
  ] as const) {
    assert.throws(
      () => publish(rule, change),
      (error) => error instanceof PolicyRefused && error.violation.rule === rule,
      rule,
    );
    assert.equal(existsSync(join(directory, rule)), false, rule);
  }
  // Git's own rule for -s: a trailer block that ends the message takes the line, and a sign-off
  // the message already has stays the only one.
  for (const [index, [message, committed]] of [
    ['fix: round totals\n', lines('fix: round totals', '', signOff)],
    [
      lines('fix: round totals', '', 'Refs: #12'),
      lines('fix: round totals', '', 'Refs: #12', signOff),
    ],
    [lines('fix: round totals', '', signOff), lines('fix: round totals', '', signOff)],
  ].entries()) {
    const work = `pass-${index}`;
    const prepared = publish(work, { message });
    const body = git(join(directory, work), ['cat-file', 'commit', prepared.commitOid]).toString();
    assert.equal(body.slice(body.indexOf('\n\n') + 2), committed);
  }
  // A plain first word goes to lower case, code stays as written, and a long title is cut at a
  // word to the subject length.
  const long = `Keep ${'every cent of the discount '.repeat(4)}`;
  for (const [title, subject] of [
    [
      'Add netMinor(subtotalMinor, discountMinor)',
      'feat: add netMinor(subtotalMinor, discountMinor)',
    ],
    ['README badge for the release', 'feat: README badge for the release'],
    ['GitHub sign-in in  the rail', 'feat: GitHub sign-in in the rail'],
    ['netMinor rejects fractions', 'feat: netMinor rejects fractions'],
    [long, 'feat: keep every cent of the discount every cent of the discount every'],
  ]) {
    assert.equal(suggestedSubject(title), subject, title);
    assert.doesNotThrow(
      () =>
        checkCommit(DEFAULT_REPOSITORY_POLICY, {
          message: `${suggestedSubject(title)}\n`,
          destinationRef: 'refs/heads/feat/net-minor',
          identity: owner,
        }),
      title,
    );
  }
});

const selection = { family: 'openai', model: 'model-a', effort: 'default' } as const;

/** A thread after one finished turn, with Accept and the policy commands for its project. */
async function acceptingThread(t: TestContext, identity: GitIdentitySource) {
  const adapter = createScriptedChatAdapter({
    family: 'openai',
    turns: [[{ kind: 'text', itemId: 'reply', chunks: ['Done.'] }]],
  });
  const context = await setup(t, { chatAdapters: new Map([['openai', adapter]]), identity });
  const { controller, command, source } = context;
  const task = (await controller.execute(context.draft, 'local-owner')).entity as Task;
  const done = new Promise<void>((resolve) => {
    const stop = controller.store.subscribe((event: Event) => {
      if (event.type !== 'chat.turn' || (event.payload as { state: string }).state !== 'done')
        return;
      stop();
      resolve();
    });
  });
  await controller.execute(
    command('SendChatMessage', { taskId: task.id, text: 'Keep cents.', selection }, task.revision),
    'local-owner',
  );
  await done;
  const scratch = adapter.requests[0].scratch.directory;
  return {
    repo: (...args: string[]) => git(source.directory, args).toString('utf8').trim(),
    edit: (line: string) => appendFileSync(join(scratch, 'net.mjs'), line),
    accept: (branch: string, message: string) =>
      controller.execute(
        command('AcceptChatChanges', { taskId: task.id, branch, message }, task.revision),
        'local-owner',
      ),
    read: () =>
      controller.execute(
        command('ReadRepositoryPolicy', { projectId: task.projectId }),
        'local-owner',
      ),
    set: (policy: RepositoryPolicy): Promise<CommandResult> =>
      controller.execute(
        command('SetRepositoryPolicy', { projectId: task.projectId, policy }, 0),
        'local-owner',
      ),
    projectId: task.projectId,
    source: source.directory,
    now: context.clock.now,
  };
}

// Claim: a project commits as the identity its own Git config gives until its policy names the
// global config, and the policy reads back as saved.
test('Accept commits as the repository identity by default and as the global one when set', {
  timeout: 30000,
}, async (t) => {
  const at = await acceptingThread(t, () => ({
    name: 'Global owner',
    email: 'global@example.invalid',
  }));
  at.repo('config', 'user.name', 'Repository owner');
  at.repo('config', 'user.email', 'repository@example.invalid');
  assert.deepEqual((await at.read()).data, {
    kind: 'repository-policy',
    projectId: at.projectId,
    policy: DEFAULT_REPOSITORY_POLICY,
    updatedAt: null,
  });
  const author = (branch: string) =>
    at.repo('log', '-1', '--format=%an <%ae>%n%(trailers)', branch);

  at.edit('// first\n');
  assert.equal((await at.accept('fix/first', 'fix: keep cents')).outcome, 'applied');
  assert.equal(
    author('fix/first'),
    'Repository owner <repository@example.invalid>\nSigned-off-by: Repository owner <repository@example.invalid>',
  );

  const global = { ...DEFAULT_REPOSITORY_POLICY, identity: 'global' } as const;
  const saved = {
    kind: 'repository-policy',
    projectId: at.projectId,
    policy: global,
    updatedAt: at.now(),
  };
  assert.deepEqual((await at.set(global)).data, saved);
  assert.deepEqual((await at.read()).data, saved);
  at.edit('// second\n');
  assert.equal((await at.accept('fix/second', 'fix: keep more cents')).outcome, 'applied');
  assert.equal(
    author('fix/second'),
    'Global owner <global@example.invalid>\nSigned-off-by: Global owner <global@example.invalid>',
  );
});

// Claim: Accept refuses a message with an attribution line and never strips it to get through.
// With attribution allowed, the same message is committed as written.
test('an attribution line refuses Accept whole and is kept as written when the policy allows it', {
  timeout: 30000,
}, async (t) => {
  const at = await acceptingThread(t, owner);
  at.edit('// cents\n');
  const message = ['fix: keep cents', '', 'Co-authored-by: Helper <helper@example.invalid>'].join(
    '\n',
  );
  const refused = await at.accept('fix/cents', message);
  assert.deepEqual([refused.outcome, refused.reason], ['blocked', 'policy-attribution']);
  assert.match(refused.next ?? '', /Remove "Co-authored-by: Helper <helper@example\.invalid>"/);
  assert.equal(refValue(at.source, 'refs/heads/fix/cents'), null);

  await at.set({ ...DEFAULT_REPOSITORY_POLICY, attribution: 'allowed' });
  assert.equal((await at.accept('fix/cents', message)).outcome, 'applied');
  assert.equal(at.repo('log', '-1', '--format=%B', 'fix/cents'), `${message}\n${signOff}`);
});
