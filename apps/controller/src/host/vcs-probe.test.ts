import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cachedGitState, detectGit, gitProblem } from './vcs-probe.ts';

test('the git probe tells a missing git from one that fails to run and from one that works', (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'crewkite-nogit-'));
  const broken = mkdtempSync(join(tmpdir(), 'crewkite-badgit-'));
  t.after(() => {
    rmSync(empty, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  });
  writeFileSync(join(broken, 'git'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(broken, 'git'), 0o755);
  const rows = [
    { name: 'a path with no git', path: empty, state: 'missing', line: 'git was not found' },
    {
      name: 'a git that exits with an error',
      path: broken,
      state: 'broken',
      line: 'git failed to run',
    },
    { name: 'the real git', path: process.env.PATH, state: 'ready', line: null },
  ] as const;
  for (const row of rows) {
    const state = detectGit(row.path);
    assert.equal(state, row.state, row.name);
    assert.equal(gitProblem(state), row.line, row.name);
  }
});

test('a working tool is remembered and a failure is asked again after about 30 seconds', () => {
  const rows = [
    {
      name: 'ready stays ready',
      answers: ['ready', 'missing'],
      at: [0, 1_000_000],
      want: ['ready', 'ready'],
      asked: 1,
    },
    {
      name: 'a failure holds inside 30 seconds',
      answers: ['missing', 'ready'],
      at: [0, 29_999],
      want: ['missing', 'missing'],
      asked: 1,
    },
    {
      name: 'a failure is asked again after 30 seconds',
      answers: ['missing', 'ready'],
      at: [0, 30_000],
      want: ['missing', 'ready'],
      asked: 2,
    },
  ] as const;
  for (const row of rows) {
    let calls = 0;
    let clock = 0;
    const read = cachedGitState(
      () => row.answers[calls++],
      () => clock,
    );
    const seen = row.at.map((time) => {
      clock = time;
      return read();
    });
    assert.deepEqual(seen, row.want, row.name);
    assert.equal(calls, row.asked, row.name);
  }
});
