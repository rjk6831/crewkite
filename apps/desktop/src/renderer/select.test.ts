import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, Fragment } from 'react';
import { nextEnabled, selectOptions, typedMatch } from './select-options.ts';

// Claim: the dropdown reads the same children a native select takes, so a form keeps its values,
// groups, labels, titles and disabled entries when it moves to it.
test('the dropdown lists what a native select would, in order and in groups', () => {
  const options = selectOptions([
    createElement('option', { key: 'p', value: '', disabled: true }, 'Pick a crew'),
    createElement(
      'optgroup',
      { key: 'g', label: 'Presets' },
      createElement('option', { value: 'preset:solo', title: 'The builder only' }, 'Solo'),
      createElement('option', { value: 'preset:tandem' }, 'Tandem'),
    ),
    false,
    createElement(
      Fragment,
      { key: 'f' },
      createElement('option', { value: 7 }, 'Seven ', 'days'),
      createElement('option', {}, 'Bare'),
    ),
  ]);
  assert.deepEqual(options, [
    { value: '', label: 'Pick a crew', disabled: true, group: null },
    {
      value: 'preset:solo',
      label: 'Solo',
      disabled: false,
      title: 'The builder only',
      group: 'Presets',
    },
    { value: 'preset:tandem', label: 'Tandem', disabled: false, group: 'Presets' },
    { value: '7', label: 'Seven days', disabled: false, group: null },
    { value: 'Bare', label: 'Bare', disabled: false, group: null },
  ]);
});

// Claim: the arrow keys and Home and End skip disabled entries and stop at the ends, and typing
// finds the next label that starts with what was typed.
test('keys move over enabled entries and typing finds a label', () => {
  const options = selectOptions([
    createElement('option', { key: 1, value: 'a', disabled: true }, 'Auto'),
    createElement('option', { key: 2, value: 'b' }, 'Balanced'),
    createElement('option', { key: 3, value: 'c', disabled: true }, 'Careful'),
    createElement('option', { key: 4, value: 'g' }, 'Glide'),
    createElement('option', { key: 5, value: 'm' }, 'Manual'),
  ]);
  assert.equal(nextEnabled(options, -1, 1), 1, 'first enabled');
  assert.equal(nextEnabled(options, 1, 1), 3, 'skips a disabled entry');
  assert.equal(nextEnabled(options, 4, 1), 4, 'stops at the end');
  assert.equal(nextEnabled(options, options.length, -1), 4, 'last enabled');
  assert.equal(nextEnabled(options, 1, -1), 1, 'stops at the start');
  assert.equal(typedMatch(options, 1, 'm'), 4);
  assert.equal(typedMatch(options, 4, 'b'), 1, 'wraps');
  assert.equal(typedMatch(options, 1, 'c'), 1, 'never lands on a disabled entry');
  assert.equal(typedMatch(options, 1, 'gl'), 3);
});
