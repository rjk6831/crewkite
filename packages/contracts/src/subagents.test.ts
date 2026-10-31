import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentEventSchema, ChatCrewSchema } from './chat.ts';
import { allowsSubagents, MAX_SUBAGENTS } from './subagents.ts';

const selection = { family: 'openai', model: 'model-a', effort: 'medium' } as const;

test('a crew role allows subagents as saved, and a role saved without the switch takes the family default', () => {
  const table: { name: string; member: Record<string, unknown>; family: string; allow: boolean }[] =
    [
      { name: 'saved before the switch', member: {}, family: 'anthropic', allow: true },
      { name: 'saved before the switch', member: {}, family: 'google', allow: true },
      { name: 'saved before the switch', member: {}, family: 'openai', allow: false },
      { name: 'turned on', member: { allowSubagents: true }, family: 'openai', allow: true },
      { name: 'turned off', member: { allowSubagents: false }, family: 'anthropic', allow: false },
    ];
  for (const row of table) {
    const crew = ChatCrewSchema.parse({
      name: 'Pair',
      members: [{ role: 'builder', selection, ...row.member }],
    });
    assert.equal(
      allowsSubagents(crew.members[0], row.family),
      row.allow,
      `${row.name} ${row.family}`,
    );
  }
  assert.equal(allowsSubagents(undefined, 'google'), true, 'a turn with no crew role');
  assert.equal(allowsSubagents(undefined, 'openai'), false, 'an OpenAI turn with no crew role');
  assert.equal(
    ChatCrewSchema.safeParse({
      name: 'Pair',
      members: [{ role: 'builder', selection, allowSubagents: 'no' }],
    }).success,
    false,
  );
});

test('a subagent event names its parent call and keeps its list bounded', () => {
  const agent = { id: 'agent-1', state: 'running', action: 'Read src/app.ts', model: null };
  const event = (agents: unknown[]) => ({
    type: 'tool.subagents',
    turnId: 'trn_00000000000000000000000001',
    callId: 'call-1',
    running: agents.length,
    finished: 0,
    agents,
  });
  const table: { name: string; agents: unknown[]; ok: boolean }[] = [
    { name: 'one running subagent', agents: [agent], ok: true },
    { name: 'the list at its bound', agents: Array(MAX_SUBAGENTS).fill(agent), ok: true },
    { name: 'one past the bound', agents: Array(MAX_SUBAGENTS + 1).fill(agent), ok: false },
    { name: 'an unknown state', agents: [{ ...agent, state: 'paused' }], ok: false },
    { name: 'an empty action title', agents: [{ ...agent, action: '' }], ok: false },
  ];
  for (const row of table)
    assert.equal(AgentEventSchema.safeParse(event(row.agents)).success, row.ok, row.name);
});
