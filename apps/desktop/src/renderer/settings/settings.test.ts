import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatCatalogRead } from '@crewkite/contracts';
import {
  crewFromPreset,
  familyModel,
  preferredSelection,
  readCrewPresets,
  readThreadDefaults,
  writeCrewPresets,
  writeFamilyDefault,
  writeThreadDefaults,
} from './preferences.ts';

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

test('saved thread defaults and crew presets survive bad storage and apply only to connected, listed models', () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const catalog: ChatCatalogRead = {
    families: [entry('openai', true, []), entry('anthropic', false, [])],
  };
  const none = { selection: null, permissionPolicy: 'ask', handoffMode: 'most-left' };
  assert.deepEqual(readThreadDefaults(store), none);
  values.set('crewkite-thread-defaults-v1', '{not json');
  assert.deepEqual(readThreadDefaults(store), none);
  assert.deepEqual(readThreadDefaults(null), none);
  values.set('crewkite-thread-defaults-v1', '{"handoffMode":"balanced"}');
  assert.equal(readThreadDefaults(store).handoffMode, 'balanced');

  writeThreadDefaults(
    {
      selection: { family: 'openai', model: 'large-1', effort: 'medium' },
      permissionPolicy: 'allow-edits',
      handoffMode: 'most-left',
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
      handoffMode: 'most-left',
    },
    store,
  );
  assert.equal(preferredSelection(catalog, store), null);

  // A family's default model survives a reload. Once the family stops listing it, the catalog's
  // default takes over, also for a thread default whose own model is gone.
  const openai = catalog.families[0];
  const larger = {
    ...openai,
    models: [...openai.models, { ...openai.models[0], model: 'large-2' }],
  };
  writeFamilyDefault('openai', 'large-2', store);
  assert.equal(familyModel(larger, store), 'large-2');
  assert.equal(familyModel(openai, store), 'large-1');
  writeThreadDefaults(
    {
      selection: { family: 'openai', model: 'large-9', effort: 'high' },
      permissionPolicy: 'ask',
      handoffMode: 'most-left',
    },
    store,
  );
  assert.deepEqual(preferredSelection(catalog, store), {
    family: 'openai',
    model: 'large-1',
    effort: 'high',
  });

  // A preset puts the reviewer and the challenger on other connected families, the best ranked
  // first, and the fixer on the builder. A pin applies only while its family lists the model.
  const three: ChatCatalogRead = {
    families: [
      entry('openai', true, [window('weekly', 30, at(600))]),
      entry('anthropic', true, [window('weekly', 80, at(600))]),
      entry('google', true, [window('weekly', 50, at(600))]),
    ],
  };
  const roles = (crew: ReturnType<typeof crewFromPreset>) =>
    crew?.members.map(({ role, selection }) => `${role}:${selection.family}`);
  const [, pair, full] = readCrewPresets(store);
  assert.deepEqual(roles(crewFromPreset(full, three, null, 'most-left', NOW, store)), [
    'builder:openai',
    'reviewer:anthropic',
    'challenger:google',
    'fixer:openai',
  ]);
  const lone: ChatCatalogRead = { families: [entry('openai', true, [])] };
  assert.deepEqual(roles(crewFromPreset(pair, lone, null, 'most-left', NOW, store)), [
    'builder:openai',
    'reviewer:openai',
  ]);
  const pinned = { family: 'google' as const, model: 'large-1', effort: 'low' as const };
  writeCrewPresets(
    readCrewPresets(store).map((preset) =>
      preset.name === 'Pair'
        ? { ...preset, members: [preset.members[0], { role: 'reviewer', selection: pinned }] }
        : preset,
    ),
    store,
  );
  const repinned = readCrewPresets(store)[1];
  assert.deepEqual(roles(crewFromPreset(repinned, three, null, 'most-left', NOW, store)), [
    'builder:openai',
    'reviewer:google',
  ]);
  assert.deepEqual(roles(crewFromPreset(repinned, lone, null, 'most-left', NOW, store)), [
    'builder:openai',
    'reviewer:openai',
  ]);
  assert.equal(crewFromPreset(repinned, { families: [] }, null, 'most-left', NOW, store), null);
});

test('a preset carries each pinned effort into the crew and drops an effort the model no longer offers', () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const catalog: ChatCatalogRead = {
    families: [entry('openai', true, []), entry('anthropic', true, [])],
  };
  const pin = (builder: 'low' | 'high' | 'medium', reviewer: 'low' | 'high' | 'medium') =>
    writeCrewPresets(
      readCrewPresets(store).map((preset) =>
        preset.name === 'Pair'
          ? {
              ...preset,
              members: [
                {
                  role: 'builder',
                  selection: { family: 'openai', model: 'large-1', effort: builder },
                },
                {
                  role: 'reviewer',
                  selection: { family: 'anthropic', model: 'large-1', effort: reviewer },
                },
              ],
            }
          : preset,
      ),
      store,
    );
  const efforts = () => {
    const pair = readCrewPresets(store).find((p) => p.name === 'Pair');
    assert.ok(pair);
    return crewFromPreset(pair, catalog, null, 'most-left', NOW, store)?.members.map(
      ({ role, selection }) => `${role}:${selection.effort}`,
    );
  };
  pin('high', 'high');
  assert.deepEqual(efforts(), ['builder:high', 'reviewer:high']);
  // The test models offer low and high only, so a saved medium becomes the default, low.
  pin('high', 'medium');
  assert.deepEqual(efforts(), ['builder:high', 'reviewer:low']);
});
