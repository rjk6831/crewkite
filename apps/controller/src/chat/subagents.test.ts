import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AgentEvent, type ChatCrew, ChatCrewSchema, MAX_SUBAGENTS } from '@crewkite/contracts';
import { readableType, SubagentTracker, turnAllowsSubagents } from './subagents.ts';

const selection = { family: 'openai', model: 'model-a', effort: 'medium' } as const;
const crew = (members: Record<string, boolean | undefined>): ChatCrew =>
  ChatCrewSchema.parse({
    name: 'Full crew',
    members: Object.entries(members).map(([role, allow]) => ({
      role,
      selection,
      ...(allow === undefined ? {} : { allowSubagents: allow }),
    })),
  });

test('each turn reads the switch of the crew role it runs as', () => {
  const rows: {
    name: string;
    crew: ChatCrew | null;
    role: Parameters<typeof turnAllowsSubagents>[1];
    family?: Parameters<typeof turnAllowsSubagents>[2];
    allow: boolean;
  }[] = [
    { name: 'no crew', crew: null, role: 'assistant', allow: true },
    { name: 'no crew on OpenAI', crew: null, role: 'assistant', family: 'openai', allow: false },
    {
      name: 'builder left out on OpenAI',
      crew: crew({ builder: undefined }),
      role: 'assistant',
      family: 'openai',
      allow: false,
    },
    {
      name: 'builder turned on for OpenAI',
      crew: crew({ builder: true }),
      role: 'assistant',
      family: 'openai',
      allow: true,
    },
    { name: 'builder off', crew: crew({ builder: false }), role: 'assistant', allow: false },
    {
      name: 'builder left out',
      crew: crew({ builder: undefined }),
      role: 'assistant',
      allow: true,
    },
    {
      name: 'reviewer off, builder on',
      crew: crew({ builder: true, reviewer: false }),
      role: 'reviewer',
      allow: false,
    },
    {
      name: 'a fix with no fixer runs as the builder',
      crew: crew({ builder: false, reviewer: true }),
      role: 'fixer',
      allow: false,
    },
    {
      name: 'a fixer of its own',
      crew: crew({ builder: false, fixer: true }),
      role: 'fixer',
      allow: true,
    },
    {
      name: 'an advisor is not a crew role',
      crew: crew({ builder: false }),
      role: 'advisor',
      allow: true,
    },
  ];
  for (const row of rows)
    assert.equal(
      turnAllowsSubagents(row.crew, row.role, row.family ?? 'anthropic'),
      row.allow,
      row.name,
    );
});

test('a client type reads as words', () => {
  const rows = [
    ['collabAgentToolCall', 'Collab agent tool call'],
    ['image_generation', 'Image generation'],
    ['', 'Tool call'],
  ] as const;
  for (const [type, words] of rows) assert.equal(readableType(type), words);
});

test('the tracker sends one event per change, keeps a subagent under its first parent and bounds its list', () => {
  const events: AgentEvent[] = [];
  const tracker = new SubagentTracker('trn_00000000000000000000000001', (event) =>
    events.push(event),
  );
  tracker.update('spawn', 'a', { model: 'model-b' });
  tracker.update('spawn', 'a', { model: 'model-b' });
  tracker.update('wait', 'a', { state: 'done', action: '  Read\n src/app.ts ' });
  assert.deepEqual(
    events.map((event) => event.type === 'tool.subagents' && [event.callId, event.agents[0]]),
    [
      ['spawn', { id: 'a', state: 'running', action: null, model: 'model-b' }],
      ['spawn', { id: 'a', state: 'done', action: 'Read src/app.ts', model: 'model-b' }],
    ],
  );
  // A stand-in gives way to the subagents the client names later.
  tracker.update('spawn', 'spawn');
  tracker.remove('spawn');
  assert.deepEqual(events.at(-1)?.type === 'tool.subagents' && events.at(-1), {
    type: 'tool.subagents',
    turnId: 'trn_00000000000000000000000001',
    callId: 'spawn',
    running: 0,
    finished: 1,
    agents: [{ id: 'a', state: 'done', action: 'Read src/app.ts', model: 'model-b' }],
  });
  for (let index = 0; index < MAX_SUBAGENTS + 3; index++) tracker.update('many', `agent-${index}`);
  tracker.close('stopped');
  const last = events.at(-1);
  assert(last?.type === 'tool.subagents');
  assert.deepEqual(
    [last.callId, last.running, last.finished, last.agents.length],
    ['many', 0, MAX_SUBAGENTS + 3, MAX_SUBAGENTS],
  );
});
