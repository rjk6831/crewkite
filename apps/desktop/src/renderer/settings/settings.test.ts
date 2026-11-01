import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatCatalogRead } from '@crewkite/contracts';
import {
  applyDraft,
  crewChoices,
  crewForProject,
  crewFromPreset,
  crewNameProblem,
  draftConfigure,
  draftSettings,
  familyModel,
  firstAnswer,
  flightPreset,
  preferredSelection,
  readCrewPresets,
  readDefaultCrew,
  readSavedCrews,
  readThreadDefaults,
  writeCrewPresets,
  writeDefaultCrew,
  writeFamilyDefault,
  writeProjectCrew,
  writeSavedCrews,
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
  accepts: null,
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
  // Even spend was first saved as balanced.
  values.set('crewkite-thread-defaults-v1', '{"handoffMode":"balanced"}');
  assert.equal(readThreadDefaults(store).handoffMode, 'even-spend');

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
    'orchestrator:openai',
  ]);
  // Solo and Pair leave the orchestrator out.
  const [solo] = readCrewPresets(store);
  assert.deepEqual(roles(crewFromPreset(solo, three, null, 'most-left', NOW, store)), [
    'builder:openai',
  ]);
  assert.deepEqual(roles(crewFromPreset(pair, three, null, 'most-left', NOW, store)), [
    'builder:openai',
    'reviewer:anthropic',
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

test('Balanced and Glide start the Solo crew on a thread with none, and keep a crew the thread has', () => {
  assert.equal(flightPreset(false, 'balanced'), 'Solo');
  assert.equal(flightPreset(false, 'glide'), 'Solo');
  assert.equal(flightPreset(false, 'manual'), null);
  assert.equal(flightPreset(true, 'glide'), null);
});

// Claim: a new thread's side panel follows the controller's rules before the thread exists, and
// the first send applies only what differs from a just created thread.
test('new thread settings follow the controller rules and configure only what changed', () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const fresh = draftSettings(store);
  assert.deepEqual(draftConfigure(fresh), []);
  writeThreadDefaults(
    { selection: null, permissionPolicy: 'allow-edits', handoffMode: 'even-spend' },
    store,
  );
  const saved = draftSettings(store);
  assert.deepEqual(draftConfigure(saved), [
    { permissionPolicy: 'allow-edits', handoffMode: 'even-spend' },
  ]);
  const selection = { family: 'openai', model: 'large-1', effort: 'low' } as const;
  const crew = { name: 'Solo', members: [{ role: 'builder' as const, selection }] };
  // No crew keeps the thread manual.
  assert.equal(applyDraft(fresh, { flightMode: 'glide' }).flightMode, 'manual');
  // Entering Glide turns automatic handoff on, and turning it off afterwards takes a second call.
  const glide = applyDraft(fresh, { crew, flightMode: 'glide', selection });
  assert.equal(glide.autoHandoff, true);
  assert.deepEqual(glide.selection, selection);
  assert.deepEqual(draftConfigure(glide), [{ crew, flightMode: 'glide' }]);
  const off = applyDraft(glide, { autoHandoff: false });
  assert.deepEqual(draftConfigure(off), [{ crew, flightMode: 'glide' }, { autoHandoff: false }]);
  // Clearing the crew goes back to manual.
  assert.equal(applyDraft(glide, { crew: null }).flightMode, 'manual');
  assert.deepEqual(draftConfigure(applyDraft(fresh, { autoHandoff: true })), [
    { autoHandoff: true },
  ]);
  // The starting chip names who answers the first message: the orchestrator when the crew has one
  // and the thread runs on its own, else the builder on the model the message went to (H3).
  const planner = { family: 'anthropic', model: 'opus', effort: 'medium' } as const;
  const planned = {
    name: 'Full crew',
    members: [
      { role: 'builder' as const, selection },
      { role: 'orchestrator' as const, selection: planner },
    ],
  };
  assert.deepEqual(firstAnswer({ crew: planned, flightMode: 'glide' }, selection), {
    ...planner,
    role: 'orchestrator',
  });
  assert.deepEqual(firstAnswer({ crew: planned, flightMode: 'manual' }, selection), {
    ...selection,
    role: 'assistant',
  });
  assert.deepEqual(firstAnswer({ crew, flightMode: 'balanced' }, selection), {
    ...selection,
    role: 'assistant',
  });
  assert.equal(firstAnswer({ crew: null, flightMode: 'manual' }, null), null);
});

// Claim: saved crews list with the presets in one set of choices, one of them is the default for
// new threads, a project can start with its own, and a deleted or broken crew falls back to Solo.
test('saved crews join the presets, one is the default, and bad storage falls back to Solo', () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  assert.deepEqual(
    crewChoices(store).map((choice) => choice.id),
    ['preset:Solo', 'preset:Pair', 'preset:Full crew'],
  );
  assert.equal(readDefaultCrew(store), 'preset:Solo');
  const pinned = { family: 'openai', model: 'large-1', effort: 'high' } as const;
  writeSavedCrews(
    [
      {
        id: 'crew-a',
        name: 'Review heavy',
        // Saved out of order: the roles read back in crew order.
        members: [
          { role: 'challenger', selection: null },
          { role: 'builder', selection: pinned, allowSubagents: false },
        ],
        flightMode: 'glide',
      },
    ],
    store,
  );
  const [, , , saved] = crewChoices(store);
  assert.equal(saved.id, 'saved:crew-a');
  assert.equal(saved.flightMode, 'glide');
  assert.equal(saved.hint, 'Builder, Challenger. Glide.');
  assert.deepEqual(
    saved.template.members.map((member) => member.role),
    ['builder', 'challenger'],
  );
  // A saved crew builds a thread crew the same way a preset does, its pins included.
  const catalog: ChatCatalogRead = {
    families: [entry('openai', true, []), entry('anthropic', true, [])],
  };
  const crew = crewFromPreset(saved.template, catalog, null, 'most-left', NOW, store);
  assert.equal(crew?.name, 'Review heavy');
  assert.deepEqual(crew?.members[0], { role: 'builder', selection: pinned, allowSubagents: false });
  assert.equal(crew?.members[1].selection.family, 'anthropic');

  writeDefaultCrew('saved:crew-a', store);
  assert.equal(readDefaultCrew(store), 'saved:crew-a');
  assert.equal(crewForProject('prj-1', store).id, 'saved:crew-a');
  writeProjectCrew('prj-1', 'preset:Pair', store);
  assert.equal(crewForProject('prj-1', store).id, 'preset:Pair');
  assert.equal(crewForProject('prj-2', store).id, 'saved:crew-a');
  writeProjectCrew('prj-1', null, store);
  assert.equal(crewForProject('prj-1', store).id, 'saved:crew-a');

  // Names are unique across presets and saved crews, and an edit may keep its own name.
  assert.equal(crewNameProblem(' ', [], null), 'Name the crew.');
  assert.equal(crewNameProblem('pair', [], null), 'Another crew has this name.');
  const list = readSavedCrews(store);
  assert.equal(crewNameProblem('review HEAVY', list, null), 'Another crew has this name.');
  assert.equal(crewNameProblem('Review heavy', list, 'crew-a'), null);

  // A crew without a builder, or with a bad id, does not read; the default goes back to Solo.
  values.set(
    'crewkite-saved-crews-v1',
    JSON.stringify([
      { id: 'crew-b', name: 'No builder', members: [{ role: 'reviewer' }], flightMode: 'manual' },
      { id: 'Bad id!', name: 'X', members: [{ role: 'builder' }] },
    ]),
  );
  assert.deepEqual(readSavedCrews(store), []);
  assert.equal(readDefaultCrew(store), 'preset:Solo');
  values.set('crewkite-saved-crews-v1', '{not json');
  assert.deepEqual(readSavedCrews(store), []);
});
