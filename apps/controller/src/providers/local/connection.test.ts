import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retainedSelection } from './connection.ts';

type Observation = Parameters<typeof retainedSelection>[1];
type Choice = Observation['models'][number];

const choice = (modelKey: string, loaded: boolean): Choice =>
  ({
    selectionId: `${modelKey}:${loaded ? 'loaded' : 'installed'}`,
    identity: { modelKey },
    instanceReference: loaded ? `${modelKey}-instance` : null,
    state: loaded ? 'loaded-eligible' : 'installed-unloaded',
  }) as unknown as Choice;
const read = (...models: Choice[]) => ({ models }) as unknown as Observation;

// Claim: a selection follows its model key to one loaded instance, and a model picked while
// unloaded stays picked while the read still lists it unloaded, so the card can name it.
test('a fresh read keeps a loaded selection by key and an unloaded pick while it stays unloaded', () => {
  const rows: [string, Parameters<typeof retainedSelection>, string | null][] = [
    ['loaded, still loaded', ['a', read(choice('a', true)), false], 'a:loaded'],
    ['loaded, now unloaded', ['a', read(choice('a', false)), false], null],
    ['picked unloaded, still unloaded', ['a', read(choice('a', false)), true], 'a:installed'],
    ['picked unloaded, now loaded', ['a', read(choice('a', true)), true], 'a:loaded'],
    ['picked unloaded, gone', ['a', read(choice('b', true)), true], null],
    ['nothing picked', [null, read(choice('a', true)), false], null],
  ];
  for (const [label, input, expected] of rows)
    assert.equal(retainedSelection(...input)?.selectionId ?? null, expected, label);
});
