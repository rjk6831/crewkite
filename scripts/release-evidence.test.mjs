import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildManifest } from './release-evidence.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');

test('the release manifest records the commit, versions, migrations, tests and artifact checksums', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'release-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('package.json', JSON.stringify({ name: 'crewkite', version: '0.1.0' }));
  write(
    'apps/controller/package.json',
    JSON.stringify({ name: '@crewkite/controller', version: '0.1.0' }),
  );
  write(
    'packages/contracts/package.json',
    JSON.stringify({ name: '@crewkite/contracts', version: '0.2.0' }),
  );
  write('pnpm-lock.yaml', 'lockfile\n');
  write('apps/controller/migrations/001-first.sql', 'create table a (id);');
  write('apps/controller/migrations/002-second.sql', 'create table b (id);');
  write('artifacts/CrewKite.zip', 'archive');
  const testOutput = [
    `✔ ${join(root, 'apps/controller/src/a.test.ts')} (12.5ms)`,
    `✔ ${join(root, 'scripts/b.test.mjs')} (3.1ms)`,
    'ℹ tests 3',
    'ℹ suites 0',
    'ℹ pass 2',
    'ℹ fail 0',
    'ℹ cancelled 0',
    'ℹ skipped 1',
    'ℹ todo 0',
    'ℹ duration_ms 20.1',
  ].join('\n');

  const manifest = buildManifest({
    root,
    source: { commit: 'abc1234', clean: true },
    nodeVersion: 'v24.22.0',
    testOutput,
    artifactsDir: join(root, 'artifacts'),
  });

  assert.deepEqual(manifest, {
    format: 1,
    source: { commit: 'abc1234', clean: true },
    node: 'v24.22.0',
    packages: {
      crewkite: '0.1.0',
      '@crewkite/controller': '0.1.0',
      '@crewkite/contracts': '0.2.0',
    },
    lockfile: { path: 'pnpm-lock.yaml', sha256: hash('lockfile\n') },
    migrations: { count: 2, latest: '002-second.sql' },
    tests: {
      files: ['apps/controller/src/a.test.ts', 'scripts/b.test.mjs'],
      counts: { tests: 3, pass: 2, fail: 0, cancelled: 0, skipped: 1, todo: 0 },
    },
    artifacts: [{ name: 'CrewKite.zip', bytes: 7, sha256: hash('archive') }],
  });
});
