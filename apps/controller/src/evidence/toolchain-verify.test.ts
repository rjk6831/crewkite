import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { canonicalJson } from '@crewkite/contracts';
import { type TreeInventory, treeInventoryRecords } from '../host/toolchain.ts';
import type { ToolchainDefinition } from './toolchain-definition.ts';
import { verificationCommand } from './toolchain-verify.ts';

test('repository verification bounds Node test file concurrency', () => {
  const definition = {
    collection: [{ path: 'apps/controller/src/example.test.ts' }],
  } as ToolchainDefinition;

  assert.deepEqual(verificationCommand(definition, 'node-tests'), {
    runtime: 'node',
    cwd: '.',
    argv: [
      '--import=./apps/controller/src/host/check-ownership.ts',
      '--test',
      '--test-concurrency=3',
      '--test-reporter=./apps/controller/src/evidence/reporter.ts',
      '--',
      './apps/controller/src/example.test.ts',
    ],
  });
});

test('build inventory keeps its digest after artifact persistence', () => {
  const entries: TreeInventory['entries'] = [
    { path: '.', kind: 'directory', mode: 0o755 },
    { path: 'main/index.js', kind: 'file', mode: 0o644, bytes: 1, hash: '0'.repeat(64) },
    { path: 'runtime', kind: 'link', target: '../runtime', resolved: 'runtime' },
  ];
  const inventory = { entries, files: 1, bytes: 1 };
  const rawDigest = (value: typeof inventory) => {
    const hash = createHash('sha256');
    for (const row of [{ version: 1, files: value.files, bytes: value.bytes }, ...value.entries])
      hash.update(`${JSON.stringify(row)}\n`);
    return hash.digest('hex');
  };
  const digest = (value: typeof inventory) => {
    const hash = createHash('sha256');
    for (const row of treeInventoryRecords(value)) hash.update(`${JSON.stringify(row)}\n`);
    return hash.digest('hex');
  };

  const persisted = JSON.parse(canonicalJson(inventory)) as typeof inventory;
  assert.notEqual(rawDigest(persisted), rawDigest(inventory));
  assert.equal(digest(persisted), digest(inventory));
});
