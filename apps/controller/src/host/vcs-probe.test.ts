import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectGit, gitProblem } from './vcs-probe.ts';

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
