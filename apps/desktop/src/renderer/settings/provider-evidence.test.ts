import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ChatCatalogEntry,
  GOOGLE_RECOVERY_HOLD_COPY,
  type WorkspaceState,
} from '@crewkite/contracts';
import { providerEvidence, recoveryLine } from './provider-evidence.ts';

const now = Date.parse('2026-11-18T12:00:00.000Z');
const entry = (change: Partial<ChatCatalogEntry> = {}): ChatCatalogEntry => ({
  family: 'google',
  connected: true,
  reason: null,
  models: [{ model: 'm1', label: 'M1', efforts: [], defaultEffort: 'medium' }],
  defaultModel: 'm1',
  remaining: [],
  readAt: '2026-11-18T11:50:00.000Z',
  accepts: null,
  ...change,
});
type Header = Pick<WorkspaceState, 'googleAcpSetup' | 'googleMetadataHolds'>;
const ready = (modelRefresh: NonNullable<Header['googleAcpSetup']>['modelRefresh']): Header => ({
  googleAcpSetup: {
    profileId: 'google-acp-v1',
    revision: 4,
    state: 'ready',
    operationId: null,
    proofId: `art_${'0'.repeat(26)}`,
    client: { version: '1.4.0', sha256: 'a'.repeat(64), signerTeamId: 'TEAM' },
    auth: { method: 'oauth-personal', status: 'authenticated' },
    reason: 'qualification-pending',
    googleTerms: null,
    modelRefresh,
  },
});
const commandId = `cmd_${'1'.repeat(26)}`;

test('each card states sign-in, models, quota age and a blocker as separate facts', () => {
  const cases: [
    string,
    Parameters<typeof providerEvidence>,
    Partial<ReturnType<typeof providerEvidence>>,
  ][] = [
    [
      'Ready Google with a held discover keeps its sign-in and names the hold',
      [
        'google',
        entry(),
        {
          ...ready(null),
          googleMetadataHolds: [{ commandId, operation: 'acp-discover', reason: 'owner-present' }],
        },
        now,
      ],
      {
        signIn: 'Signed in',
        usage: 'Read 10 min ago',
        blocker: GOOGLE_RECOVERY_HOLD_COPY['owner-present'],
      },
    ],
    [
      'a failed refresh keeps the earlier list and says why',
      [
        'google',
        entry(),
        ready({
          commandId,
          at: '2026-11-18T11:00:00.000Z',
          outcome: 'failed',
          reason: 'acp-setup-timeout',
          evidenceId: null,
        }),
        now,
      ],
      {
        models: '1 listed. Last refresh failed (acp setup timeout), earlier list kept',
        blocker: null,
      },
    ],
    [
      'a running quota read is normal work and is not a blocker',
      [
        'google',
        entry(),
        {
          ...ready(null),
          googleMetadataHolds: [{ commandId, operation: 'usage', reason: 'runtime-active' }],
        },
        now,
      ],
      { blocker: null },
    ],
    [
      'a family with no catalog entry reads as unknown',
      ['openai', undefined, { googleAcpSetup: null }, now],
      { signIn: 'Unknown', models: 'Not read yet', usage: 'Not read yet' },
    ],
    [
      'Local reports no quota and takes sign-in from its connection',
      ['local', entry({ family: 'local', readAt: null }), { googleAcpSetup: null }, now],
      { signIn: 'Connected', usage: 'None. Runs on this computer' },
    ],
  ];
  for (const [claim, input, expected] of cases)
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(expected).map((key) => [
          key,
          providerEvidence(...input)[key as keyof typeof expected],
        ]),
      ),
      expected,
      claim,
    );
  assert.equal(
    recoveryLine({
      kind: 'google-metadata-recovery',
      outcome: 'settled',
      settled: [
        { commandId, operation: 'usage' },
        { commandId: `cmd_${'3'.repeat(26)}`, operation: 'acp-discover' },
      ],
      held: [],
      swept: { removed: 0, failed: 0 },
    }),
    'Released 2 interrupted operations. Their results stay unknown.',
    'several released operations read in the plural',
  );
  assert.equal(
    recoveryLine({
      kind: 'google-metadata-recovery',
      outcome: 'held',
      settled: [{ commandId, operation: 'usage' }],
      held: [
        {
          commandId: `cmd_${'2'.repeat(26)}`,
          operation: 'acp-authenticate',
          reason: 'authentication-needs-person',
        },
      ],
      swept: { removed: 0, failed: 0 },
    }),
    `Released one interrupted operation. Its result stays unknown. Sign-in: ${GOOGLE_RECOVERY_HOLD_COPY['authentication-needs-person']}`,
    'a held row keeps its own reason beside what was released',
  );
});
