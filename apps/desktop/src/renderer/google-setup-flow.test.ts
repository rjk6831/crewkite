import assert from 'node:assert/strict';
import test from 'node:test';
import { GOOGLE_TERMS_VERSION, type WorkspaceState } from '@crewkite/contracts';
import { pollGoogleSetupStatus, runGoogleSetupFlow } from './google-setup-flow.ts';

type GoogleState = Pick<WorkspaceState, 'googleAcpInstall' | 'googleAcpSetup'>;
const client = { version: '1.0.0', sha256: 'a'.repeat(64), signerTeamId: 'team' };
const setup = (
  revision: number,
  state: NonNullable<GoogleState['googleAcpSetup']>['state'],
  change: Partial<NonNullable<GoogleState['googleAcpSetup']>> = {},
): NonNullable<GoogleState['googleAcpSetup']> => ({
  profileId: 'google-acp-v1',
  revision,
  state,
  operationId: null,
  proofId: null,
  client: null,
  auth: { method: null, status: 'unknown' },
  reason: null,
  googleTerms: { version: GOOGLE_TERMS_VERSION, at: '2026-10-28T00:00:00.000Z' },
  ...change,
});

test('Google setup uses each saved revision and proof once', async () => {
  const states: GoogleState[] = [
    { googleAcpInstall: null, googleAcpSetup: setup(0, 'uninitialized') },
    {
      googleAcpInstall: {
        profileId: 'google-acp-v1',
        state: 'installed',
        operationId: null,
        observedAt: '2026-10-21T00:00:00.000Z',
        reason: null,
        next: 'Installed.',
      },
      googleAcpSetup: setup(0, 'uninitialized', { client }),
    },
    {
      googleAcpInstall: null,
      googleAcpSetup: setup(2, 'authentication-required', {
        client,
        proofId: 'art_01K7M1N2P3Q4R5S6T7V8W9X0YZ',
        auth: { method: 'oauth-personal', status: 'required' },
      }),
    },
    {
      googleAcpInstall: null,
      googleAcpSetup: setup(4, 'discovery-required', {
        client,
        proofId: 'art_01K7M1N2P3Q4R5S6T7V8W9X0YX',
        auth: { method: 'oauth-personal', status: 'authenticated' },
      }),
    },
    {
      googleAcpInstall: null,
      googleAcpSetup: setup(6, 'ready', {
        client,
        proofId: 'art_01K7M1N2P3Q4R5S6T7V8W9X0YX',
        auth: { method: 'oauth-personal', status: 'authenticated' },
      }),
    },
  ];
  const commands: { command: string; revision: number; proofId?: string }[] = [];
  const stages: string[] = [];
  const result = await runGoogleSetupFlow({
    read: async () => states.shift() as GoogleState,
    active: () => true,
    onStage: (stage) => stages.push(stage),
    command: async (input) => {
      commands.push({
        command: input.command,
        revision: input.expectedRevision,
        ...('proofId' in input.payload ? { proofId: input.payload.proofId } : {}),
      });
      return { outcome: 'applied' };
    },
  });
  assert.deepEqual(result, { kind: 'ready' });
  assert.deepEqual(stages, ['install', 'initialize', 'authenticate', 'discover']);
  assert.deepEqual(commands, [
    { command: 'InstallGoogleAcp', revision: 0 },
    { command: 'InitializeGoogleAcp', revision: 0 },
    {
      command: 'AuthenticateGoogleAcp',
      revision: 2,
      proofId: 'art_01K7M1N2P3Q4R5S6T7V8W9X0YZ',
    },
    {
      command: 'DiscoverGoogleAcp',
      revision: 4,
      proofId: 'art_01K7M1N2P3Q4R5S6T7V8W9X0YX',
    },
  ]);
});

test('Google setup stops after ownership changes during an awaited action', async () => {
  let active = true;
  const installed = Promise.withResolvers<{ outcome: 'applied' }>();
  const commands: string[] = [];
  const running = runGoogleSetupFlow({
    read: async () => ({ googleAcpInstall: null, googleAcpSetup: setup(0, 'uninitialized') }),
    active: () => active,
    onStage: () => {},
    command: async (input) => {
      commands.push(input.command);
      return installed.promise;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(commands, ['InstallGoogleAcp']);
  active = false;
  installed.resolve({ outcome: 'applied' });
  assert.deepEqual(await running, { kind: 'stopped' });
  assert.deepEqual(commands, ['InstallGoogleAcp']);
});

test('Google setup does not replay an unknown command outcome', async () => {
  let reads = 0;
  let commands = 0;
  const result = await runGoogleSetupFlow({
    read: async () => {
      reads++;
      return { googleAcpInstall: null, googleAcpSetup: setup(0, 'uninitialized') };
    },
    active: () => true,
    onStage: () => {},
    command: async () => {
      commands++;
      return { outcome: 'outcome-unknown' };
    },
  });
  assert.equal(result.kind, 'blocked');
  assert.equal(reads, 1);
  assert.equal(commands, 1);
});

test('Google status polling stays sequential and stops at twenty fake ticks', async () => {
  let ticks = 0;
  let activeReads = 0;
  let maximumReads = 0;
  let reads = 0;
  const result = await pollGoogleSetupStatus({
    wait: async () => {
      ticks++;
    },
    read: async () => {
      activeReads++;
      maximumReads = Math.max(maximumReads, activeReads);
      await Promise.resolve();
      reads++;
      activeReads--;
    },
    active: () => true,
  });
  assert.equal(result, 'timeout');
  assert.equal(ticks, 20);
  assert.equal(reads, 20);
  assert.equal(maximumReads, 1);
});
