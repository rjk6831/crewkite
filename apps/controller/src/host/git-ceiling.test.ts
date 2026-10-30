import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitCeiling, withGitCeiling } from './git-ceiling.ts';
import { OwnedCommand } from './worker.ts';

const temporary = (t: test.TestContext) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-ceiling-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('the turn environment names the copy parent and keeps everything else', (t) => {
  const root = temporary(t);
  mkdirSync(join(root, 'real', 'copy'), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'link'));
  // A copy that is itself a link: Git resolves the working directory to the target.
  mkdirSync(join(root, 'elsewhere', 'target'), { recursive: true });
  symlinkSync(join(root, 'elsewhere', 'target'), join(root, 'real', 'linked-copy'));
  const rows = [
    { name: 'plain copy', copy: join(root, 'real', 'copy'), parent: join(root, 'real') },
    {
      name: 'copy reached through a link',
      copy: join(root, 'link', 'copy'),
      parent: join(root, 'real'),
    },
    {
      name: 'copy that is a link to a folder elsewhere',
      copy: join(root, 'real', 'linked-copy'),
      parent: join(root, 'elsewhere'),
    },
    {
      name: 'copy not made yet under a link',
      copy: join(root, 'link', 'later'),
      parent: join(root, 'real'),
    },
    { name: 'copy not made yet', copy: join(root, 'real', 'later'), parent: join(root, 'real') },
    {
      name: 'plan slice folder',
      copy: join(root, 'real', 'copy', 'a'),
      parent: join(root, 'real', 'copy'),
    },
  ];
  for (const row of rows) {
    mkdirSync(row.parent, { recursive: true });
    assert.equal(gitCeiling(row.copy), row.parent, row.name);
    assert.deepEqual(
      withGitCeiling({ HOME: '/home/x', GIT_CEILING_DIRECTORIES: '/elsewhere' }, row.copy),
      { HOME: '/home/x', GIT_CEILING_DIRECTORIES: row.parent },
      row.name,
    );
  }
});

test('a repository lookup from a scratch copy under a repository finds none with the ceiling and the repository without it', (t) => {
  const root = temporary(t);
  // A home folder that is itself a repository, with the copy somewhere below it.
  execFileSync('git', ['init', '--quiet', root]);
  const copy = join(root, '.crewkite', 'chat', 'copy');
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, 'a.txt'), 'x');
  const clean = { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1' };
  const lookup = (env: NodeJS.ProcessEnv) =>
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: copy,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  assert.equal(lookup(clean), root);
  assert.throws(() => lookup(withGitCeiling(clean, copy)));
  // A copy that carries its own repository is still found.
  execFileSync('git', ['init', '--quiet', copy]);
  assert.equal(lookup(withGitCeiling(clean, copy)), copy);
});

test('a parent folder with a colon in its name is refused with a plain line', (t) => {
  const root = temporary(t);
  const copy = join(root, 'home:one', 'copy');
  mkdirSync(copy, { recursive: true });
  for (const target of [copy, join(root, 'home:one', 'later')])
    assert.throws(
      () => withGitCeiling({}, target),
      (error: Error) =>
        error.message.startsWith('CrewKite cannot hold Git to the folder ') &&
        error.message.includes('home:one') &&
        !error.message.includes('\n'),
      target,
    );
});

test('a node check process of an evaluated copy starts with the ceiling above that copy', async (t) => {
  const root = temporary(t);
  const copy = join(root, 'candidate', 'copy');
  mkdirSync(copy, { recursive: true });
  const job = new OwnedCommand({
    argv: ['-e', 'process.stdout.write(process.env.GIT_CEILING_DIRECTORIES ?? "none")'],
    directory: copy,
    environmentHome: join(root, 'environment'),
    onSpawn: () => {},
  });
  const chunks: Buffer[] = [];
  job.child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  await job.closed;
  assert.equal(Buffer.concat(chunks).toString('utf8'), join(root, 'candidate'));
});
