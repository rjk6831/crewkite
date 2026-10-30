import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_VERSIONS } from '../client-versions.ts';
import {
  resolveNativeProfile,
  resolveOpenAiChatClient,
  resolveRepositoryProfile,
} from '../openai/profile.ts';
import {
  resolveAnthropicChatClient,
  resolveAnthropicCompactNativeProfile,
  resolveAnthropicNativeProfile,
} from './profile.ts';

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

test('the writer profiles keep their exact pinned builds while chat takes a version range', () => {
  const openai = resolveNativeProfile({}).facts;
  const repository = resolveRepositoryProfile({}).facts;
  const anthropic = resolveAnthropicNativeProfile({}).facts;
  assert.equal(openai.family === 'openai' && openai.clientVersion, '0.163.0');
  assert.equal(repository.family === 'openai' && repository.clientVersion, '0.163.0');
  assert.equal(anthropic.family === 'anthropic' && anthropic.clientVersion, '2.1.302');
  assert.equal(CLIENT_VERSIONS.openai.tested, '0.163.0');
  assert.equal(CLIENT_VERSIONS.anthropic.tested, '2.1.302');
  // Off the supported Mac, the chat path refuses before it searches and says why in words.
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    for (const chat of [resolveAnthropicChatClient({}), resolveOpenAiChatClient({})]) {
      assert.equal(chat.profile, undefined);
      assert.equal(chat.reason, 'unsupported-platform');
      assert.equal(chat.status.state, 'unavailable');
      assert.match(chat.status.message, /macOS with Apple silicon/);
    }
});
