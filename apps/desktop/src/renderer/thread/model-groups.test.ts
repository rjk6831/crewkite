import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatCatalogRead } from '@crewkite/contracts';
import { effortLevels, MODEL_ID, modelGroups, offLine, shownEffort } from './model-groups.ts';

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
      'typed-9',
      { live: ['a'], hidden: [], known: [], typed: 'typed-9' },
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
    ['family-model-4-1', true],
    ['model-3.8-flash', true],
    ['-rf', false],
    ['two words', false],
    ['', false],
  ] as const)
    assert.equal(MODEL_ID.test(text), ok, text);
});

test('a model that lists levels offers no Default, and a saved Default shows the preselected level', () => {
  const levels = { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };
  const none = { efforts: ['default'], defaultEffort: 'default' };
  assert.deepEqual(effortLevels(levels.efforts), ['low', 'medium', 'high']);
  assert.deepEqual(effortLevels(none.efforts), []);
  assert.equal(shownEffort('default', levels), 'medium');
  assert.equal(shownEffort('high', levels), 'high');
  assert.equal(shownEffort('default', none), 'default');
  assert.equal(shownEffort('default', undefined), 'default');
});

test('a cloud family that is not connected reads Not connected whatever its reason, and Local keeps its own words', () => {
  const rows: [Parameters<typeof offLine>[0], string | null, string][] = [
    [{ family: 'openai', needsConnect: false }, null, 'Not connected'],
    [{ family: 'anthropic', needsConnect: true }, null, 'Not connected'],
    [{ family: 'google', needsConnect: false }, null, 'Not connected'],
    [
      { family: 'google', needsConnect: undefined },
      'Last seen 2 min ago. Not connected.',
      'Not connected',
    ],
    [{ family: 'local', needsConnect: false }, null, 'Not connected'],
    [{ family: 'local', needsConnect: true }, null, 'Connect in Settings'],
    [
      { family: 'local', needsConnect: false },
      'Last seen 2 min ago. Not connected.',
      'Last seen 2 min ago. Not connected.',
    ],
  ];
  for (const [entry, localSeen, expected] of rows)
    assert.equal(offLine(entry, localSeen), expected, `${entry.family} ${localSeen ?? ''}`);
});
