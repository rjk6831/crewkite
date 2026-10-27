import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatCatalogRead } from '@crewkite/contracts';
import { MODEL_ID, modelGroups } from './model-groups.ts';

type Entry = ChatCatalogRead['families'][number];
const model = (name: string, extra: Partial<Entry['models'][number]> = {}) => ({
  model: name,
  label: name,
  efforts: ['default' as const],
  defaultEffort: 'default' as const,
  ...extra,
});
const family = (models: Entry['models']) =>
  ({ family: 'anthropic', connected: true, models }) as unknown as Entry;

test('the picker lists live models first, folds hidden ones, sets known ones apart, and keeps a typed ID in view', () => {
  const names = (list: readonly { model: string }[]) => list.map((value) => value.model);
  for (const [label, entry, selected, want] of [
    [
      'the client listed models, one of them hidden',
      family([model('a', { source: 'live' }), model('b', { source: 'live', hidden: true })]),
      'a',
      { live: ['a'], hidden: ['b'], known: [], typed: null },
    ],
    [
      'a catalog from before sources existed reads as live',
      family([model('a')]),
      null,
      { live: ['a'], hidden: [], known: [], typed: null },
    ],
    [
      'the read failed, so only the shipped list shows, as known',
      family([model('a', { source: 'known' }), model('b', { source: 'known' })]),
      'b',
      { live: [], hidden: [], known: ['a', 'b'], typed: null },
    ],
    [
      'the selection is an ID the list does not hold',
      family([model('a', { source: 'live' })]),
      'claude-typed-9',
      { live: ['a'], hidden: [], known: [], typed: 'claude-typed-9' },
    ],
  ] as const) {
    const groups = modelGroups(
      entry,
      selected === null ? null : { family: 'anthropic', model: selected, effort: 'default' },
    );
    assert.deepEqual(
      {
        live: names(groups.live),
        hidden: names(groups.hidden),
        known: names(groups.known),
        typed: groups.typed,
      },
      want,
      label,
    );
  }
  // A selection on another family says nothing about this one.
  assert.equal(
    modelGroups(family([model('a')]), { family: 'google', model: 'x', effort: 'default' }).typed,
    null,
  );
  // The typed ID is passed to the client as an argument, so its shape is checked first.
  for (const [text, ok] of [
    ['claude-opus-4-1', true],
    ['gemini-3.8-flash', true],
    ['-rf', false],
    ['two words', false],
    ['', false],
  ] as const)
    assert.equal(MODEL_ID.test(text), ok, text);
});
