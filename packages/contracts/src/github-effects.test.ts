import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  branchPatternRegExp,
  DEFAULT_REPOSITORY_POLICY,
  RepositoryPolicySchema,
} from './github-effects.ts';

test('the default repository policy validates and its branch pattern refuses a tool prefix', () => {
  const policy = RepositoryPolicySchema.parse(DEFAULT_REPOSITORY_POLICY);
  // An alternation matches whole names only, so a type cannot hide behind a prefix.
  const alternation = 'feat/[a-z-]+|fix/[a-z-]+';
  for (const [pattern, branch, allowed] of [
    [policy.branchPattern, 'feat/round-totals', true],
    [policy.branchPattern, 'revert/round-totals', true],
    [policy.branchPattern, 'agent/round-totals', false],
    [policy.branchPattern, 'assistant/fix-round-totals', false],
    [policy.branchPattern, 'feat/Round-Totals', false],
    [alternation, 'fix/round-totals', true],
    [alternation, 'agent/feat/round-totals', false],
    [alternation, 'feat/round-totals/agent', false],
  ] as const)
    assert.equal(branchPatternRegExp(pattern).test(branch), allowed, `${pattern} ${branch}`);
  assert.equal(
    RepositoryPolicySchema.safeParse({ ...policy, branchPattern: 'feat/(' }).success,
    false,
  );
});
