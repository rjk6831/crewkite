import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ReadDataSchema } from '@crewkite/contracts';
import { createSyntheticRepository } from '@crewkite/testkit/repository';
import { git, inspectSource, inspectSourceDetails, readFiles } from './source.ts';

test('source inspection bounds file metadata without running filters or reading special files', (t) => {
  mkdirSync(resolve('internal'), { recursive: true });
  const directory = mkdtempSync(join(resolve('internal'), 'source-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = createSyntheticRepository(join(directory, 'demo-shop'));
  const projectId = `prj_${'0'.repeat(26)}`;
  const canary = join(directory, 'filter-executed');
  writeFileSync(join(source.directory, '.gitattributes'), '*.mjs filter=canary\n');
  git(source.directory, ['config', 'filter.canary.clean', `touch '${canary}'`]);
  const index = readFileSync(join(source.directory, '.git', 'index'));
  unlinkSync(join(source.directory, 'cli.mjs'));
  execFileSync('mkfifo', [join(source.directory, 'cli.mjs')]);
  const inspected = inspectSourceDetails(projectId, source.directory);
  assert.deepEqual(inspected.source, inspectSource(projectId, source.directory));
  assert.ok(
    inspected.details.files.some(
      (file) => file.path === 'cli.mjs' && file.status === 'type-changed' && file.unstaged,
    ),
  );
  assert.ok(
    inspected.details.files.some(
      (file) => file.path === 'sentinels/staged.txt' && file.staged && !file.unstaged,
    ),
  );
  assert.ok(
    inspected.details.files.some(
      (file) => file.path === 'sentinels/unstaged.txt' && !file.staged && file.unstaged,
    ),
  );
  assert.ok(inspected.details.files.some((file) => file.status === 'untracked' && !file.staged));
  ReadDataSchema.parse({ kind: 'source', ...inspected });
  const longDirectory = join(
    source.directory,
    'inventory-bound',
    'a'.repeat(230),
    'b'.repeat(230),
    'c'.repeat(230),
  );
  mkdirSync(longDirectory, { recursive: true });
  for (let index = 0; index < 110; index++) writeFileSync(join(longDirectory, `file-${index}`), '');
  const bounded = inspectSourceDetails(projectId, source.directory);
  assert.ok(bounded.details.omittedUntracked > 0);
  assert.ok(bounded.details.files.length < 200);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.details)) <= 65_536);
  ReadDataSchema.parse({ kind: 'source', ...bounded });
  const special = join(directory, 'special');
  mkdirSync(special);
  execFileSync('mkfifo', [join(special, 'pipe')]);
  assert.throws(() => readFiles(special), /unsupported|regular/);
  assert.equal(existsSync(canary), false);
  assert.deepEqual(readFileSync(join(source.directory, '.git', 'index')), index);
});
