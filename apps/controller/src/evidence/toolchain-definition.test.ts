import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeTestNames, toolchainWorkspaces } from './toolchain-definition.ts';

test('the toolchain inventory names every pnpm workspace', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const found = ['apps', 'packages'].flatMap((parent) =>
    readdirSync(join(root, parent))
      .map((name) => `${parent}/${name}`)
      .filter((path) => existsSync(join(root, path, 'package.json'))),
  );
  assert.deepEqual([...toolchainWorkspaces].sort(), found.sort());
});

test('test discovery includes nested test context claims', () => {
  const source = [
    "test('parent claim', async (t) => {",
    "  await t.test('first child claim', () => {});",
    '  await t.test(',
    "    'second child claim',",
    '    () => {},',
    '  );',
    '});',
  ].join('\n');

  assert.deepEqual(nodeTestNames(source), [
    'parent claim',
    'first child claim',
    'second child claim',
  ]);
});
