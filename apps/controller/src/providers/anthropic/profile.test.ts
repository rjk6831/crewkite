import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAnthropicCompactNativeProfile, resolveAnthropicNativeProfile } from './profile.ts';

test('Anthropic profiles keep the existing default and expose the compact model separately', () => {
  const environment = {};
  const standard = resolveAnthropicNativeProfile(environment);
  const compact = resolveAnthropicCompactNativeProfile(environment);

  assert.equal(standard.facts.id, 'anthropic-file-v1');
  assert.equal(standard.facts.model, 'claude-sonnet-5-5');
  assert.equal(compact.facts.id, 'anthropic-file-compact-v1');
  assert.equal(compact.facts.model, 'claude-haiku-5-5');
  assert.equal(standard.facts.maximumTaskMs, 300000);
  assert.equal(compact.facts.maximumTaskMs, 300000);
});
