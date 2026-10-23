import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatCatalogRead } from '@crewkite/contracts';
import { railRows } from './allowance.ts';
import { preferredSelection, readThreadDefaults, writeThreadDefaults } from './preferences.ts';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const window = (windowId: string, percent: number | null, resetsAt: string | null) => ({
  windowId,
  label: windowId,
  percent,
  resetsAt,
  observedAt: at(-1),
});
const models = [
  {
    model: 'large-1',
    label: 'Large 1',
    efforts: ['low', 'high'] as const,
    defaultEffort: 'low' as const,
  },
];
const entry = (
  family: 'openai' | 'anthropic' | 'google' | 'local',
  connected: boolean,
  remaining: ReturnType<typeof window>[],
) => ({
  family,
  connected,
  reason: null,
  models: connected ? models.map((model) => ({ ...model, efforts: [...model.efforts] })) : [],
  defaultModel: connected ? 'large-1' : null,
  remaining,
});

test('the rail lists every connected family and says unknown when a value is missing', () => {
  const catalog: ChatCatalogRead = {
    families: [
      entry('openai', true, [window('five-hour', 40, at(90)), window('weekly', 10, at(2880))]),
      // The window reset an hour ago, so its percent says nothing about now.
      entry('anthropic', true, [window('weekly', 55, at(-60))]),
      entry('google', false, []),
      entry('local', true, []),
    ],
  };
  assert.deepEqual(railRows(catalog, NOW), [
    { family: 'openai', percent: 10, resetsIn: 2880 * 60_000, onDevice: false },
    { family: 'anthropic', percent: null, resetsIn: null, onDevice: false },
    { family: 'local', percent: null, resetsIn: null, onDevice: true },
  ]);
  assert.deepEqual(railRows(null, NOW), []);
});

test('saved thread defaults survive bad storage and apply only to a connected, listed model', () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const catalog: ChatCatalogRead = {
    families: [entry('openai', true, []), entry('anthropic', false, [])],
  };
  assert.deepEqual(readThreadDefaults(store), { selection: null, permissionPolicy: 'ask' });
  values.set('crewkite-thread-defaults-v1', '{not json');
  assert.deepEqual(readThreadDefaults(store), { selection: null, permissionPolicy: 'ask' });
  assert.deepEqual(readThreadDefaults(null), { selection: null, permissionPolicy: 'ask' });

  writeThreadDefaults(
    {
      selection: { family: 'openai', model: 'large-1', effort: 'medium' },
      permissionPolicy: 'allow-edits',
    },
    store,
  );
  assert.equal(readThreadDefaults(store).permissionPolicy, 'allow-edits');
  // Medium is not offered for this model, so the model's own default effort replaces it.
  assert.deepEqual(preferredSelection(catalog, store), {
    family: 'openai',
    model: 'large-1',
    effort: 'low',
  });
  writeThreadDefaults(
    {
      selection: { family: 'anthropic', model: 'large-1', effort: 'low' },
      permissionPolicy: 'ask',
    },
    store,
  );
  assert.equal(preferredSelection(catalog, store), null);
});
