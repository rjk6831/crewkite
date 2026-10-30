import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitCeiling, withGitCeiling } from './git-ceiling.ts';

const temporary = (t: test.TestContext) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-ceiling-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('the turn environment names the copy parent and keeps everything else', (t) => {
  const root = temporary(t);
  mkdirSync(join(root, 'real', 'copy'), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'link'));
  const rows = [
    { name: 'plain copy', copy: join(root, 'real', 'copy'), parent: join(root, 'real') },
    {
      name: 'copy reached through a link',
      copy: join(root, 'link', 'copy'),
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
