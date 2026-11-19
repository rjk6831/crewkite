import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Connection, ConnectionsRead } from '@crewkite/contracts';
import { readyApiConnections } from './connection-view.ts';

const at = '2026-11-18T08:00:00.000Z';
const id = (n: number) => `con_01KA${String(n).padStart(22, '0')}`;
const ready: Connection = {
  connectionId: id(1),
  family: 'openai',
  backend: 'native-client',
  billingMode: 'api',
  profileId: 'api-1',
  keepConnected: false,
  readiness: 'ready',
  proofGeneration: 1,
  observedMode: 'api',
  observedAt: at,
};
const connections: Connection[] = [
  ready,
  { ...ready, connectionId: id(2), family: 'anthropic', profileId: 'api-2' },
  // Added and never checked.
  {
    ...ready,
    connectionId: id(3),
    readiness: 'needs-attention',
    observedMode: null,
    observedAt: null,
  },
  // Its profile reports a subscription sign-in.
  { ...ready, connectionId: id(4), readiness: 'needs-attention', observedMode: 'subscription' },
  {
    ...ready,
    connectionId: id(5),
    readiness: 'disconnected',
    observedMode: null,
    observedAt: null,
  },
  // A subscription record is ready, and it is never API billing.
  { ...ready, connectionId: id(6), billingMode: 'subscription', observedMode: 'subscription' },
];
const read: ConnectionsRead = { connections, assignments: [], spend: [], loginLines: [] };

// Claim: AssignConnection takes any connection that exists, so the Crew tab and the CLI are what
// keep an unproven, mismatched, disconnected or subscription connection, or one on another family,
// out of the choices.
test('Use API billing offers only ready API connections on the role family', () => {
  const rows: [string, Parameters<typeof readyApiConnections>, string[]][] = [
    ['an OpenAI role', [read, 'openai'], [id(1)]],
    ['an Anthropic role', [read, 'anthropic'], [id(2)]],
    ['the whole thread, any family', [read, null], [id(1), id(2)]],
    ['a Google role', [read, 'google'], []],
    ['no read yet', [null, 'openai'], []],
  ];
  for (const [name, input, expected] of rows)
    assert.deepEqual(
      readyApiConnections(...input).map(({ connectionId }) => connectionId),
      expected,
      name,
    );
});
