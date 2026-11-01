import assert from 'node:assert/strict';
import test from 'node:test';
import { type CommandResult, GOOGLE_TERMS_VERSION, type WorkspaceState } from '@crewkite/contracts';
import {
  googleSetupProgress,
  nextGoogleStage,
  pollGoogleSetupStatus,
  runGoogleSetupFlow,
} from './google-setup-flow.ts';

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
  // A setup that was ready before the gate still asks for the acknowledgement first.
  const readyStates: GoogleState[] = [
    { googleAcpInstall: null, googleAcpSetup: setup(6, 'ready', { client, googleTerms: null }) },
    { googleAcpInstall: null, googleAcpSetup: setup(6, 'ready', { client }) },
  ];
  const sent: string[] = [];
  const again = await runGoogleSetupFlow({
    read: async () => readyStates.shift() as GoogleState,
    active: () => true,
    onStage: () => {},
    command: async (input) => {
      sent.push(input.command);
      return { outcome: 'applied' };
    },
  });
  assert.deepEqual([again, sent], [{ kind: 'ready' }, ['AcknowledgeGoogleTerms']]);
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

test('Google setup clears an unknown step once and retries a blocked one', async () => {
  const operationId = 'cmd_01M69BW1J2CTWNBH0QKA4P08Y5';
  const states: GoogleState[] = [
    { googleAcpInstall: null, googleAcpSetup: setup(2, 'unknown', { client, operationId }) },
    { googleAcpInstall: null, googleAcpSetup: setup(3, 'blocked', { client }) },
    {
      googleAcpInstall: null,
      googleAcpSetup: setup(5, 'authentication-required', {
        client,
        proofId: 'art_01K7M1N2P3Q4R5S6T7V8W9X0YZ',
        auth: { method: 'oauth-personal', status: 'required' },
      }),
    },
  ];
  const sent: { command: string; revision: number }[] = [];
  const stages: string[] = [];
  const result = await runGoogleSetupFlow({
    read: async () => states.shift() as GoogleState,
    active: () => true,
    onStage: (stage) => stages.push(stage),
    command: async (input) => {
      sent.push({ command: input.command, revision: input.expectedRevision });
      if (input.command === 'StopGoogleAcpSetup')
        assert.deepEqual(input.payload, { profileId: 'google-acp-v1', operationId });
      return { outcome: input.command === 'AuthenticateGoogleAcp' ? 'blocked' : 'applied' };
    },
  });
  assert.equal(result.kind, 'blocked');
  assert.deepEqual(stages, ['clear', 'initialize', 'authenticate']);
  assert.deepEqual(sent, [
    { command: 'StopGoogleAcpSetup', revision: 2 },
    { command: 'InitializeGoogleAcp', revision: 3 },
    { command: 'AuthenticateGoogleAcp', revision: 5 },
  ]);
  // A refused clear stops the click. The card shows why and nothing replays.
  const refused = await runGoogleSetupFlow({
    read: async () => ({
      googleAcpInstall: null,
      googleAcpSetup: setup(2, 'unknown', { client, operationId }),
    }),
    active: () => true,
    onStage: () => {},
    command: async () => ({ outcome: 'blocked', reason: 'google-ownership-unknown' }),
  });
  assert.equal(refused.kind, 'blocked');
  // An install that failed is offered again. One still running is followed, not repeated.
  const failedInstall = {
    profileId: 'google-acp-v1' as const,
    state: 'blocked' as const,
    operationId: null,
    observedAt: '2026-10-31T00:00:00.000Z',
    reason: 'download-unavailable',
    next: 'Try again.',
  };
  assert.equal(
    nextGoogleStage({ googleAcpInstall: failedInstall, googleAcpSetup: setup(0, 'uninitialized') }),
    'install',
  );
  assert.equal(
    nextGoogleStage({
      googleAcpInstall: { ...failedInstall, state: 'installing', operationId, reason: null },
      googleAcpSetup: setup(0, 'uninitialized'),
    }),
    null,
  );
});

test('Google connect progress names the step and counts the download', () => {
  const operationId = 'cmd_01M69BW1J2CTWNBH0QKA4P08Y5';
  const installing = (progress: NonNullable<GoogleState['googleAcpInstall']>['progress']) => ({
    googleAcpInstall: {
      profileId: 'google-acp-v1' as const,
      state: 'installing' as const,
      operationId,
      observedAt: null,
      reason: null,
      next: 'Downloading and verifying the official client.',
      progress,
    },
    googleAcpSetup: setup(0, 'uninitialized'),
  });
  assert.equal(googleSetupProgress(installing(undefined), null)?.step, 'download');
  const download = googleSetupProgress(
    installing({ step: 'download', bytes: 56_367_157, totalBytes: 112_734_313 }),
    'install',
  );
  assert.deepEqual(download, {
    step: 'download',
    percent: 25,
    detail: 'Downloading the official client: 50%, 53.8 MB of 108 MB.',
  });
  const unpack = googleSetupProgress(
    installing({ step: 'extract', bytes: 0, totalBytes: 401_226_992 }),
    'install',
  );
  assert.equal(unpack?.step, 'verify');
  assert.equal(unpack?.percent, 50);
  assert.equal(
    googleSetupProgress(
      installing({ step: 'extract', bytes: 17_900_000, totalBytes: 401_226_992 }),
      'install',
    )?.detail,
    'Unpacking the client: 4%, 17.1 MB of 383 MB.',
  );
  const verify = googleSetupProgress(
    installing({ step: 'verify', bytes: 401_226_992, totalBytes: 401_226_992 }),
    'install',
  );
  assert.equal(verify?.detail, 'Checking the Google signatures on the client.');
  // After the install the controller's own setup state names the step.
  const signIn = googleSetupProgress(
    { googleAcpInstall: null, googleAcpSetup: setup(3, 'authenticating', { client, operationId }) },
    null,
  );
  assert.deepEqual(signIn, {
    step: 'authenticate',
    percent: 75,
    detail: 'Finish the Google sign-in in your browser.',
  });
  // A step this card asked for shows before the controller reports it, and an unknown step and a
  // clear show no bar.
  assert.equal(
    googleSetupProgress({ googleAcpInstall: null, googleAcpSetup: setup(2, 'ready') }, 'discover')
      ?.percent,
    90,
  );
  assert.equal(
    googleSetupProgress(
      { googleAcpInstall: null, googleAcpSetup: setup(2, 'unknown', { operationId }) },
      'clear',
    ),
    null,
  );
  assert.equal(
    googleSetupProgress({ googleAcpInstall: null, googleAcpSetup: setup(2, 'ready') }, null),
    null,
  );
});

// A controller stand-in: each command answers from a script, and the state it leaves is what the
// next read returns.
function scripted(
  start: GoogleState,
  answers: ((input: { command: string }) => { result: CommandResult; state: GoogleState })[],
) {
  let state = start;
  const sent: string[] = [];
  const retries: string[] = [];
  const run = (wait?: () => Promise<void>, reads?: GoogleState[]) =>
    runGoogleSetupFlow({
      read: async () => reads?.shift() ?? state,
      active: () => true,
      onStage: () => {},
      onRetry: (stage, attempt, tries) => retries.push(`${stage} ${attempt} of ${tries}`),
      ...(wait ? { wait } : {}),
      command: async (input) => {
        sent.push(input.command);
        const answer = answers.shift();
        if (!answer) throw Error(`No answer for ${input.command}`);
        const next = answer(input);
        state = next.state;
        return next.result;
      },
    });
  return { run, sent, retries };
}

const proof = 'art_01K7M1N2P3Q4R5S6T7V8W9X0YZ';
const signIn = (
  revision: number,
  change: Partial<NonNullable<GoogleState['googleAcpSetup']>> = {},
) =>
  setup(revision, 'authentication-required', {
    client,
    proofId: proof,
    auth: { method: 'oauth-personal', status: 'required' },
    ...change,
  });
const stuck = (revision: number, reason: 'acp-setup-timeout' | null) =>
  signIn(revision, { state: 'blocked', reason });
const blocked = (
  reason: string,
  state: NonNullable<GoogleState['googleAcpSetup']>,
): CommandResult => ({
  outcome: 'blocked',
  reason,
  data: { kind: 'google-acp-setup', setup: state },
});
const ready = setup(9, 'ready', {
  client,
  proofId: proof,
  auth: { method: 'oauth-personal', status: 'authenticated' },
});

test('a step that times out starts again at that step, up to three tries', async () => {
  const twice = scripted({ googleAcpInstall: null, googleAcpSetup: signIn(2) }, [
    () => ({
      result: blocked('acp-setup-timeout', stuck(3, 'acp-setup-timeout')),
      state: { googleAcpInstall: null, googleAcpSetup: stuck(3, 'acp-setup-timeout') },
    }),
    () => ({
      result: blocked('acp-setup-failed', stuck(4, null)),
      state: { googleAcpInstall: null, googleAcpSetup: stuck(4, null) },
    }),
    () => ({
      result: { outcome: 'applied' },
      state: { googleAcpInstall: null, googleAcpSetup: ready },
    }),
  ]);
  assert.deepEqual(await twice.run(), { kind: 'ready' });
  assert.deepEqual(twice.sent, [
    'AuthenticateGoogleAcp',
    'AuthenticateGoogleAcp',
    'AuthenticateGoogleAcp',
  ]);
  assert.deepEqual(twice.retries, ['authenticate 2 of 3', 'authenticate 3 of 3']);

  const timeout = () => ({
    result: blocked('acp-setup-timeout', stuck(3, 'acp-setup-timeout')),
    state: { googleAcpInstall: null, googleAcpSetup: stuck(3, 'acp-setup-timeout') },
  });
  const always = scripted({ googleAcpInstall: null, googleAcpSetup: signIn(2) }, [
    timeout,
    timeout,
    timeout,
  ]);
  const result = await always.run();
  assert.equal(result.kind, 'blocked');
  assert.equal(result.kind === 'blocked' && result.result?.reason, 'acp-setup-timeout');
  assert.equal(always.sent.length, 3);
  assert.deepEqual(always.retries, ['authenticate 2 of 3', 'authenticate 3 of 3']);
});

test('a stop, a refused sign-in or a cancelled install waits for the person', async () => {
  const refusedSignIn = signIn(3, { state: 'blocked', reason: 'authentication-required' });
  const rows: { name: string; result: CommandResult; state: GoogleState }[] = [
    {
      name: 'stop',
      result: blocked('acp-setup-stopped', stuck(3, null)),
      state: { googleAcpInstall: null, googleAcpSetup: stuck(3, null) },
    },
    {
      name: 'sign-in cancelled in the browser',
      result: blocked('acp-setup-failed', refusedSignIn),
      state: { googleAcpInstall: null, googleAcpSetup: refusedSignIn },
    },
  ];
  for (const row of rows) {
    const flow = scripted({ googleAcpInstall: null, googleAcpSetup: signIn(2) }, [
      () => ({ result: row.result, state: row.state }),
    ]);
    const result = await flow.run();
    assert.equal(result.kind, 'blocked', row.name);
    assert.deepEqual([flow.sent.length, flow.retries], [1, []], row.name);
  }
  // A step sent while another Google step holds the journal is sent again once it ends, with no
  // try spent.
  const busy = scripted({ googleAcpInstall: null, googleAcpSetup: signIn(2) }, [
    () => ({
      result: { outcome: 'blocked', reason: 'google-operation-active' },
      state: { googleAcpInstall: null, googleAcpSetup: signIn(2) },
    }),
    () => ({
      result: { outcome: 'applied' },
      state: { googleAcpInstall: null, googleAcpSetup: ready },
    }),
  ]);
  assert.deepEqual(await busy.run(async () => {}), { kind: 'ready' });
  assert.deepEqual([busy.sent.length, busy.retries], [2, []]);
  const install = (reason: string): GoogleState['googleAcpInstall'] => ({
    profileId: 'google-acp-v1',
    state: 'blocked',
    operationId: null,
    observedAt: '2026-10-21T00:00:00.000Z',
    reason,
    next: 'Try again.',
  });
  const installResult = (reason: string): CommandResult => ({
    outcome: 'blocked',
    reason,
    data: {
      kind: 'google-acp-install',
      install: install(reason) as NonNullable<GoogleState['googleAcpInstall']>,
    },
  });
  const cancelled = scripted(
    { googleAcpInstall: null, googleAcpSetup: setup(0, 'uninitialized') },
    [
      () => ({
        result: installResult('cancelled'),
        state: {
          googleAcpInstall: install('cancelled'),
          googleAcpSetup: setup(0, 'uninitialized'),
        },
      }),
    ],
  );
  assert.equal((await cancelled.run()).kind, 'blocked');
  assert.deepEqual(cancelled.sent, ['InstallGoogleAcp']);
  // A stalled download starts again.
  const stalled = scripted({ googleAcpInstall: null, googleAcpSetup: setup(0, 'uninitialized') }, [
    () => ({
      result: installResult('stalled'),
      state: { googleAcpInstall: install('stalled'), googleAcpSetup: setup(0, 'uninitialized') },
    }),
    () => ({
      result: { outcome: 'applied' },
      state: { googleAcpInstall: null, googleAcpSetup: ready },
    }),
  ]);
  assert.deepEqual(await stalled.run(), { kind: 'ready' });
  assert.deepEqual(stalled.sent, ['InstallGoogleAcp', 'InstallGoogleAcp']);
  assert.deepEqual(stalled.retries, ['install 2 of 3']);
});

test('a step the controller started on its own is followed to its end', async () => {
  // The acknowledgement starts the initialize in the controller. The flow reads it running, waits,
  // then signs in.
  const running = setup(1, 'initializing', {
    client,
    operationId: 'cmd_01M69BW1J2CTWNBH0QKA4P08Y5',
  });
  const flow = scripted({ googleAcpInstall: null, googleAcpSetup: signIn(2) }, [
    () => ({
      result: { outcome: 'applied' },
      state: { googleAcpInstall: null, googleAcpSetup: ready },
    }),
  ]);
  let waits = 0;
  const result = await flow.run(async () => {
    waits++;
  }, [
    { googleAcpInstall: null, googleAcpSetup: running },
    { googleAcpInstall: null, googleAcpSetup: running },
  ]);
  assert.deepEqual(result, { kind: 'ready' });
  assert.equal(waits, 2);
  assert.deepEqual(flow.sent, ['AuthenticateGoogleAcp']);
});
