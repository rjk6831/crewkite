import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeTestNames } from './toolchain-definition.ts';

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
