import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationModelRequest } from '@crewkite/contracts';
import {
  legacyOpenAiProjectSelection,
  resolveOpenAiProjectSelection,
} from './execution-selection.ts';

const observation = { artifactId: `art_${'1'.repeat(26)}`, hash: 'a'.repeat(64) };
const models = [
  { model: 'gpt-6.1-sol', efforts: ['low', 'medium'], defaultEffort: 'low' },
  { model: 'gpt-6-astra', efforts: ['high', 'xhigh'], defaultEffort: 'high' },
];
const request: ConversationModelRequest = {
  version: 1,
  observation,
  model: 'gpt-6-astra',
  effort: 'xhigh',
};

test('OpenAI project selection preserves legacy omission', () => {
  assert.equal(resolveOpenAiProjectSelection(undefined, undefined), legacyOpenAiProjectSelection);
  assert.deepEqual(legacyOpenAiProjectSelection, {
    model: 'gpt-6.1-sol',
    effort: 'low',
    source: 'legacy-profile',
  });
});

test('OpenAI project selection resolves an exact retained advertised pair', () => {
  const resolved = resolveOpenAiProjectSelection({ observation, models }, request);
  assert.deepEqual(resolved, {
    model: 'gpt-6-astra',
    effort: 'xhigh',
    source: 'retained-advertisement',
    observation,
  });
  assert(Object.isFrozen(resolved));
  assert(Object.isFrozen(resolved.observation));
});

test('OpenAI project selection refuses observation or advertised-pair drift', () => {
  for (const [retained, changed, message] of [
    [
      { observation: { ...observation, hash: 'b'.repeat(64) }, models },
      request,
      'observation changed',
    ],
    [{ observation, models }, { ...request, model: 'gpt-unadvertised' }, 'model is not advertised'],
    [{ observation, models }, { ...request, effort: 'medium' }, 'effort is not advertised'],
  ] as const)
    assert.throws(
      () => resolveOpenAiProjectSelection(retained, changed as ConversationModelRequest),
      new RegExp(message),
    );
});

test('OpenAI project selection keeps catalog and request bounds fail closed', () => {
  assert.throws(() =>
    resolveOpenAiProjectSelection({ observation, models: [...models, models[0]] }, request),
  );
  assert.throws(() =>
    resolveOpenAiProjectSelection({ observation, models }, { ...request, effort: 'x'.repeat(33) }),
  );
});
