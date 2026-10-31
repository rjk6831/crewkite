import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AgentEvent, allowsSubagents, type ChatCatalogRead } from '@crewkite/contracts';
import { crewFromPreset, readCrewPresets, writeCrewPresets } from '../settings/preferences.ts';
import {
  subagentBadge,
  subagentRows,
  subagentSwitchNote,
  turnActivities,
  turnChip,
  unlistedLine,
} from './subagent-view.ts';
import { applyEvent, blankTurn, type SubagentActivity } from './turn-fold.ts';

const turnId = 'trn_00000000000000000000000001';
const agent = (id: string, state: 'running' | 'done' | 'failed' | 'stopped', action?: string) => ({
  id,
  state,
  action: action ?? null,
  model: null,
});
const activity = (agents: ReturnType<typeof agent>[], extra = 0): SubagentActivity => ({
  running: agents.filter((value) => value.state === 'running').length,
  finished: agents.filter((value) => value.state !== 'running').length + extra,
  agents,
});

test('the chip names the role, family, model and an effort the person picked', () => {
  const rows = [
    {
      identity: { family: 'openai', model: 'model-a', effort: 'medium', role: 'assistant' },
      chip: { role: 'Builder', familyName: 'OpenAI', model: 'model-a', effort: 'medium' },
    },
    {
      identity: { family: 'local', model: 'model-b', effort: 'default', role: 'reviewer' },
      chip: { role: 'Reviewer', familyName: 'Local', model: 'model-b', effort: null },
    },
  ] as const;
  for (const row of rows) {
    const { family: _family, ...chip } = turnChip(row.identity);
    assert.deepEqual(chip, row.chip);
  }
});

test('the chip shows the picker label for a listed model and the ID for one it does not list', () => {
  const label = (family: string, model: string) =>
    family === 'anthropic' && model === 'model-c-1-2' ? 'Model C 1.2' : model;
  const listed = {
    family: 'anthropic',
    model: 'model-c-1-2',
    effort: 'medium',
    role: 'orchestrator',
  } as const;
  const typed = { ...listed, model: 'model-c-0-9' } as const;
  assert.equal(turnChip(listed, label).model, 'Model C 1.2');
  assert.equal(turnChip(typed, label).model, 'model-c-0-9');
});

test('the badge counts live while subagents run, settles to the total, and keeps failures and stops', () => {
  const rows: {
    name: string;
    activities: SubagentActivity[];
    ended: boolean;
    badge: ReturnType<typeof subagentBadge>;
  }[] = [
    { name: 'no subagents', activities: [], ended: false, badge: null },
    {
      name: 'two of three running across two spawn cards',
      activities: [
        activity([agent('a', 'running'), agent('b', 'done')]),
        activity([agent('c', 'running')]),
      ],
      ended: false,
      badge: { text: '2 of 3 subagents', label: '3 subagents, 2 running', tone: 'running' },
    },
    {
      name: 'all finished',
      activities: [activity([agent('a', 'done'), agent('b', 'done'), agent('c', 'done')])],
      ended: true,
      badge: { text: '3 subagents', label: '3 subagents, all finished', tone: 'done' },
    },
    {
      name: 'one failed',
      activities: [activity([agent('a', 'failed')])],
      ended: true,
      badge: { text: '1 subagent', label: '1 subagent, 1 failed', tone: 'failed' },
    },
    {
      name: 'a turn that ended while one still ran',
      activities: [activity([agent('a', 'running'), agent('b', 'done')])],
      ended: true,
      badge: { text: '2 subagents', label: '2 subagents, 1 stopped', tone: 'failed' },
    },
  ];
  for (const row of rows)
    assert.deepEqual(subagentBadge(row.activities, row.ended), row.badge, row.name);
});

test('a spawn card lists each subagent with its latest action and names the ones it leaves out', () => {
  const listed = activity([agent('a', 'running', 'Read src/app.ts'), agent('b', 'running')], 3);
  assert.deepEqual(
    subagentRows(listed, false).map((row) => [row.name, row.stateText, row.action]),
    [
      ['Subagent 1', 'Running', 'Read src/app.ts'],
      ['Subagent 2', 'Running', 'Starting'],
    ],
  );
  assert.deepEqual(
    subagentRows(listed, true).map((row) => [row.stateText, row.action]),
    [
      ['Stopped', 'Read src/app.ts'],
      ['Stopped', 'No action reported'],
    ],
  );
  assert.equal(unlistedLine(listed), '3 subagents more not listed.');
  assert.equal(unlistedLine(activity([agent('a', 'done')])), null);
});

test('the fold keeps the newest report on the parent card, even one that arrives before the card', () => {
  const report = (running: number, finished: number): AgentEvent => ({
    type: 'tool.subagents',
    turnId,
    callId: 'spawn-1',
    running,
    finished,
    agents: [agent('a', running ? 'running' : 'done', 'ls')],
  });
  let view = applyEvent(blankTurn(turnId), report(1, 0));
  view = applyEvent(view, {
    type: 'tool.started',
    turnId,
    callId: 'spawn-1',
    kind: 'other',
    title: 'Task Survey the tests',
  });
  view = applyEvent(view, report(0, 1));
  assert.equal(view.blocks.length, 1);
  const [card] = turnActivities(view.blocks);
  assert.deepEqual([card.running, card.finished], [0, 1]);
  assert.equal(view.blocks[0].kind === 'tool' && view.blocks[0].title, 'Task Survey the tests');
});

test('a preset keeps what the person set for each role across a save and passes it to the crew it starts', () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const [, pair] = readCrewPresets(store);
  assert(pair.members.every((member) => member.allowSubagents === undefined));
  writeCrewPresets(
    readCrewPresets(store).map((preset) =>
      preset.name === 'Pair'
        ? {
            ...preset,
            members: preset.members.map((member) =>
              member.role === 'reviewer'
                ? { ...member, allowSubagents: false }
                : { ...member, allowSubagents: true },
            ),
          }
        : preset,
    ),
    store,
  );
  const saved = readCrewPresets(store)[1];
  assert.deepEqual(
    saved.members.map(({ role, allowSubagents }) => [role, allowSubagents]),
    [
      ['builder', true],
      ['reviewer', false],
    ],
  );
  const catalog = {
    families: [
      {
        family: 'openai',
        connected: true,
        reason: null,
        models: [{ model: 'model-a', label: 'A', efforts: ['low'], defaultEffort: 'low' }],
        defaultModel: 'model-a',
        remaining: [],
        accepts: null,
      },
    ],
  } as unknown as ChatCatalogRead;
  const crew = crewFromPreset(saved, catalog, null, 'most-left', 0, store);
  assert.deepEqual(
    crew?.members.map((member) => [member.role, member.allowSubagents]),
    [
      ['builder', true],
      ['reviewer', false],
    ],
  );
});

test('the switch line says why OpenAI starts off and why Local has nothing to switch', () => {
  assert.equal(subagentSwitchNote('anthropic'), null);
  assert.equal(subagentSwitchNote('google'), null);
  assert.equal(subagentSwitchNote('openai')?.disabled, false);
  assert.match(subagentSwitchNote('openai')?.text ?? '', /approval policy/);
  assert.equal(subagentSwitchNote('local')?.disabled, true);
  // A role saved without the switch shows the family default.
  assert.equal(allowsSubagents({}, 'openai'), false);
  assert.equal(allowsSubagents({}, 'anthropic'), true);
});
