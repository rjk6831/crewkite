import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writingRuleDigest } from './hash.ts';
import { WRITING_RULES, type WritingRule } from './writing-rules.ts';

const changed = (id: string, change: Partial<WritingRule>) =>
  WRITING_RULES.map((rule) => (rule.id === id ? { ...rule, ...change } : rule));

test('the writing rule digest ignores key and list order and moves with any enabled ID, version or text', () => {
  const enabled = ['ladder', 'testing', 'rereads'];
  const digest = writingRuleDigest(enabled);
  // The same set listed in another order, from entries that list their keys in another order.
  const reordered = WRITING_RULES.map(({ text, defaultEnabled, surface, version, id }) => ({
    text,
    defaultEnabled,
    surface,
    version,
    id,
  }));
  assert.equal(writingRuleDigest(['rereads', 'ladder', 'testing'], reordered), digest);
  // A rule that is off changes nothing.
  assert.equal(writingRuleDigest(enabled, changed('stop-at-scope', { text: 'Stop.' })), digest);

  const moved = [
    digest,
    writingRuleDigest(['ladder', 'testing']),
    writingRuleDigest(['ladder', 'testing', 'stop-at-scope']),
    writingRuleDigest(enabled, changed('testing', { version: 2 })),
    writingRuleDigest(enabled, changed('testing', { text: 'Run every check after each edit.' })),
    writingRuleDigest(enabled, WRITING_RULES, 2),
  ];
  assert.equal(new Set(moved).size, moved.length);
  assert.throws(() => writingRuleDigest(['ladder', 'lader']), /catalogue does not hold/);
});
