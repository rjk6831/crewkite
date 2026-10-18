import assert from 'node:assert/strict';
import { test } from 'node:test';
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
