import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandSchema } from '@crewkite/contracts';
import { takesWindowLock } from './command-lock.ts';

test('a command with no expectedRevision skips the window lock', () => {
  const reads = CommandSchema.options
    .filter((option) => !('expectedRevision' in option.shape))
    .map((option) => option.shape.command.value);
  assert.ok(reads.includes('ReadWritingRules') && reads.includes('ReadDesignSystem'));
  assert.deepEqual(
    reads.filter((name) => takesWindowLock(name)),
    [],
  );
  assert.equal(takesWindowLock('SendChatMessage'), true);
});
