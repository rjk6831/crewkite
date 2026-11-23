import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClientVersionStatus } from '@crewkite/contracts';
import { actionCommand, clientCopyLine } from './card-actions.ts';

const families = ['openai', 'anthropic', 'google'] as const;
const google = { revision: 4, proofId: 'proof-1' };

test('each family sends its own command for every card action', () => {
  const sent = (id: 'check' | 'models' | 'sign-out') =>
    families.map((family) => actionCommand(id, family, google));
  assert.deepEqual(
    sent('check').map((command) => command.command),
    Array(3).fill('CheckProviderClient'),
  );
  assert.deepEqual(
    sent('models').map((command) => command.command),
    ['RefreshChatModels', 'RefreshChatModels', 'RefreshGoogleAcpModels'],
  );
  // The Google read is gated on the setup revision and the proof it holds.
  assert.deepEqual(sent('models')[2], {
    command: 'RefreshGoogleAcpModels',
    expectedRevision: 4,
    payload: { profileId: 'google-acp-v1', proofId: 'proof-1', consent: 'explicit' },
  });
  assert.deepEqual(
    sent('sign-out').map((command) => command.command),
    ['SignOutOpenAi', 'SignOutProvider', 'SignOutProvider'],
  );
});

const status = (patch: Partial<ClientVersionStatus>): ClientVersionStatus => ({
  state: 'tested',
  accepted: true,
  version: '2.1.330',
  tested: '2.1.316',
  minimum: '2.1.259',
  message: 'Found.',
  ...patch,
});
const copy = (
  place: 'search-path' | 'provider-app' | 'crewkite',
  path: string,
  rest: Partial<NonNullable<ClientVersionStatus['copy']>> = {},
) => ({ place, path, fetched: null, notUsed: null, ...rest });

// The status message above the line already names the version and the app, so the line adds only
// the rest.
test('the client line adds only what the status message lacks', () => {
  const cases: [string, 'openai' | 'anthropic' | 'google', ClientVersionStatus, string | null][] = [
    [
      'provider app is named by the message',
      'openai',
      status({
        copy: copy('provider-app', '/Applications/ChatGPT.app/Contents/Resources/codex'),
      }),
      null,
    ],
    [
      'Claude support folder is named by the message',
      'anthropic',
      status({
        copy: copy(
          'provider-app',
          '/Users/a/Library/Application Support/Claude/claude-code/2.1/claude',
        ),
      }),
      null,
    ],
    [
      'search path',
      'openai',
      status({ copy: copy('search-path', '/usr/local/bin/codex') }),
      'Runs from your search path.',
    ],
    [
      'Google reads quota',
      'google',
      status({ copy: copy('search-path', '/usr/local/bin/agy') }),
      'Reads quota from your search path.',
    ],
    [
      'fetched copy in use',
      'anthropic',
      status({
        copy: copy('crewkite', '/s/clients/anthropic/2.1.330/claude', {
          fetched: { version: '2.1.330', at: '2026-11-21T03:04:05.000Z' },
        }),
      }),
      'Fetched by CrewKite on 21 Nov 2026.',
    ],
    [
      'kept copy that is not the recorded fetch',
      'anthropic',
      status({
        copy: copy('crewkite', '/s/clients/anthropic/2.1.330/claude', {
          fetched: { version: '2.1.340', at: '2026-11-21T03:04:05.000Z' },
        }),
      }),
      'Kept by CrewKite.',
    ],
    [
      'fetched build that is not used',
      'anthropic',
      status({
        copy: copy('search-path', '/usr/local/bin/claude', {
          notUsed: { version: '2.1.340', reason: 'The checksum did not match' },
        }),
      }),
      'Runs from your search path. CrewKite fetched 2.1.340 and does not use it. The checksum did not match.',
    ],
    ['client not accepted', 'google', status({ accepted: false, version: null }), null],
  ];
  for (const [name, family, input, line] of cases)
    assert.equal(clientCopyLine(family, input), line, name);
});
