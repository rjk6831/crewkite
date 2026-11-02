import assert from 'node:assert/strict';
import test from 'node:test';
import { type CommandResult, GOOGLE_TERMS_VERSION, type WorkspaceState } from '@crewkite/contracts';
import {
  classifyGoogleFailure,
  GOOGLE_CONNECT_LIMIT_MS,
  GOOGLE_READ_TRIES,
  googleClientStatus,
  googleConnectButton,
  googleConnectError,
  googleSetupProgress,
  nextGoogleStage,
  pollGoogleSetupStatus,
  runGoogleSetupFlow,
  startingGoogleStage,
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
  // The flow reads the state once more to follow the step, finds nothing moved and stops there.
  assert.equal(result.kind, 'blocked');
  assert.equal(reads, 2);
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

test('Google connect progress follows the real work: download, unpack, then each file checked', () => {
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
  // Checks report the files copied and hashed. The bar moves with them and with the elapsed time,
  // and stays under the end of the step while the signature checks run.
  const first = googleSetupProgress(
    installing({ step: 'verify', bytes: 0, totalBytes: 2 }),
    'install',
    0,
  );
  const second = googleSetupProgress(
    installing({ step: 'verify', bytes: 1, totalBytes: 2 }),
    'install',
    12_000,
  );
  const signatures = googleSetupProgress(
    installing({ step: 'verify', bytes: 2, totalBytes: 2 }),
    'install',
    90_000,
  );
  assert.equal(first?.step, 'verify');
  assert.equal(first?.detail, 'Checking file 1 of 2. 0 s elapsed.');
  assert.equal(second?.detail, 'Checking file 2 of 2. 12 s elapsed.');
  assert.equal(
    signatures?.detail,
    'Checking the Google signatures on both files. 1 min 30 s elapsed.',
  );
  assert.ok(first && second && signatures);
  assert.ok(first.percent < second.percent && second.percent < signatures.percent);
  assert.ok(signatures.percent < 65);
  assert.equal(
    googleClientStatus(installing({ step: 'extract', bytes: 1, totalBytes: 2 })),
    'Installing',
  );
  assert.equal(
    googleClientStatus(installing({ step: 'verify', bytes: 1, totalBytes: 2 })),
    'Checking',
  );
  assert.equal(
    googleClientStatus({ googleAcpInstall: null, googleAcpSetup: setup(0, 'uninitialized') }),
    'Not installed',
  );
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

const operation = 'cmd_01M69BW1J2CTWNBH0QKA4P08Y6';
const installStatus = (
  state: NonNullable<GoogleState['googleAcpInstall']>['state'],
  reason: string | null = null,
): NonNullable<GoogleState['googleAcpInstall']> => ({
  profileId: 'google-acp-v1',
  state,
  operationId: ['installing', 'stopping', 'unknown'].includes(state) ? operation : null,
  observedAt: '2026-11-01T00:00:00.000Z',
  reason,
  next: 'Status.',
});
const signedIn = (
  revision: number,
  change: Partial<NonNullable<GoogleState['googleAcpSetup']>> = {},
) =>
  setup(revision, 'discovery-required', {
    client,
    proofId: proof,
    auth: { method: 'oauth-personal', status: 'authenticated' },
    ...change,
  });

test('one Connect runs every step to the end when the install outlives its command', async () => {
  // The 383 MB unpack outlived the install command's answer. The flow used to stop there with
  // "The controller has not answered yet", and the card then offered a separate sign-in button.
  const reads: GoogleState[] = [
    { googleAcpInstall: null, googleAcpSetup: setup(0, 'uninitialized') },
    { googleAcpInstall: installStatus('installing'), googleAcpSetup: setup(0, 'uninitialized') },
    { googleAcpInstall: installStatus('installing'), googleAcpSetup: setup(0, 'uninitialized') },
    // The controller initializes on its own after the install.
    {
      googleAcpInstall: installStatus('installed'),
      googleAcpSetup: setup(1, 'initializing', { client, operationId: operation }),
    },
    { googleAcpInstall: installStatus('installed'), googleAcpSetup: signIn(2) },
    { googleAcpInstall: installStatus('installed'), googleAcpSetup: signedIn(4) },
    { googleAcpInstall: installStatus('installed'), googleAcpSetup: ready },
  ];
  const sent: string[] = [];
  const stages: string[] = [];
  let waits = 0;
  const result = await runGoogleSetupFlow({
    read: async () => reads.shift() as GoogleState,
    active: () => true,
    onStage: (stage) => stages.push(stage),
    wait: async () => {
      waits++;
    },
    command: async (input) => {
      sent.push(input.command);
      return input.command === 'InstallGoogleAcp'
        ? { outcome: 'outcome-unknown', reason: 'response-timeout' }
        : { outcome: 'applied' };
    },
  });
  assert.deepEqual(result, { kind: 'ready' });
  assert.deepEqual(sent, ['InstallGoogleAcp', 'AuthenticateGoogleAcp', 'DiscoverGoogleAcp']);
  assert.deepEqual(stages, ['install', 'authenticate', 'discover']);
  assert.equal(waits, 3);
});

test('transient failures run their step again with no word to the person', async () => {
  // A signature check that ran out of time, then one codesign refused, then the install passes.
  for (const reason of ['signature-timeout', 'signature-refused']) {
    const flow = scripted({ googleAcpInstall: null, googleAcpSetup: setup(0, 'uninitialized') }, [
      () => ({
        result: {
          outcome: 'blocked',
          reason,
          data: { kind: 'google-acp-install', install: installStatus('blocked', reason) },
        },
        state: {
          googleAcpInstall: installStatus('blocked', reason),
          googleAcpSetup: setup(0, 'uninitialized'),
        },
      }),
      () => ({
        result: { outcome: 'applied' },
        state: { googleAcpInstall: installStatus('installed'), googleAcpSetup: ready },
      }),
    ]);
    assert.deepEqual(await flow.run(), { kind: 'ready' }, reason);
    assert.deepEqual(flow.sent, ['InstallGoogleAcp', 'InstallGoogleAcp'], reason);
  }
  // Discovery that applied but found no model choices or review mode yet is run again.
  const missing = signedIn(5, { state: 'blocked', reason: 'acp-capability-missing' });
  const discovery = scripted({ googleAcpInstall: null, googleAcpSetup: signedIn(4) }, [
    () => ({
      result: { outcome: 'applied' },
      state: { googleAcpInstall: null, googleAcpSetup: missing },
    }),
    () => ({
      result: { outcome: 'applied' },
      state: { googleAcpInstall: null, googleAcpSetup: ready },
    }),
  ]);
  assert.deepEqual(await discovery.run(), { kind: 'ready' });
  assert.deepEqual(discovery.sent, ['DiscoverGoogleAcp', 'DiscoverGoogleAcp']);
  assert.deepEqual(discovery.retries, ['discover 2 of 3']);
  // Three tries that each find nothing end with the reason the state saved.
  const never = scripted({ googleAcpInstall: null, googleAcpSetup: signedIn(4) }, [
    () => ({
      result: { outcome: 'applied' },
      state: { googleAcpInstall: null, googleAcpSetup: missing },
    }),
    () => ({
      result: { outcome: 'applied' },
      state: { googleAcpInstall: null, googleAcpSetup: missing },
    }),
    () => ({
      result: { outcome: 'applied' },
      state: { googleAcpInstall: null, googleAcpSetup: missing },
    }),
  ]);
  const result = await never.run();
  assert.equal(result.kind === 'blocked' && result.result?.reason, 'acp-capability-missing');
  assert.equal(never.sent.length, 3);
});

test('Try again resumes at the step that failed', async () => {
  const rows: { name: string; state: GoogleState; command: string }[] = [
    {
      name: 'initialize',
      state: {
        googleAcpInstall: installStatus('installed'),
        googleAcpSetup: setup(3, 'blocked', { client, reason: 'acp-setup-timeout' }),
      },
      command: 'InitializeGoogleAcp',
    },
    {
      name: 'sign-in',
      state: {
        googleAcpInstall: installStatus('installed'),
        googleAcpSetup: stuck(3, 'acp-setup-timeout'),
      },
      command: 'AuthenticateGoogleAcp',
    },
    {
      name: 'discovery',
      state: {
        googleAcpInstall: installStatus('installed'),
        googleAcpSetup: signedIn(5, { state: 'blocked', reason: 'acp-capability-missing' }),
      },
      command: 'DiscoverGoogleAcp',
    },
    {
      // An install that failed earlier stays in the journal, and the client is installed now.
      name: 'an older failed install',
      state: {
        googleAcpInstall: installStatus('blocked', 'signature-refused'),
        googleAcpSetup: signedIn(5, { state: 'blocked', reason: 'acp-capability-missing' }),
      },
      command: 'DiscoverGoogleAcp',
    },
  ];
  for (const row of rows) {
    const flow = scripted(row.state, [
      () => ({
        result: { outcome: 'applied' },
        state: { googleAcpInstall: null, googleAcpSetup: ready },
      }),
    ]);
    assert.deepEqual(await flow.run(), { kind: 'ready' }, row.name);
    assert.deepEqual(flow.sent, [row.command], row.name);
  }
});

test('one Connect stops after twenty minutes', async () => {
  let clock = 0;
  const running = setup(1, 'authenticating', {
    client,
    proofId: proof,
    operationId: operation,
    auth: { method: 'oauth-personal', status: 'required' },
  });
  const result = await runGoogleSetupFlow({
    read: async () => ({ googleAcpInstall: null, googleAcpSetup: running }),
    active: () => true,
    onStage: () => {},
    now: () => clock,
    wait: async () => {
      clock += 60_000;
    },
    command: async () => assert.fail('A running step is followed, not sent.'),
  });
  assert.deepEqual(result, {
    kind: 'blocked',
    result: { outcome: 'blocked', reason: 'google-connect-limit' },
  });
  assert.equal(clock, GOOGLE_CONNECT_LIMIT_MS);
});

test('Google failures are transient or wait for the person', () => {
  const state = (reason: string | null): GoogleState => ({
    googleAcpInstall: installStatus('blocked', reason),
    googleAcpSetup: signIn(3, { state: 'blocked', reason: reason as never }),
  });
  const rows: [string, CommandResult | undefined, GoogleState, string][] = [
    ['install', { outcome: 'blocked', reason: 'signature-timeout' }, state(null), 'transient'],
    ['install', { outcome: 'blocked', reason: 'stalled' }, state(null), 'transient'],
    ['install', { outcome: 'blocked', reason: 'cancelled' }, state(null), 'person'],
    ['install', { outcome: 'blocked', reason: 'pin-conflict' }, state(null), 'person'],
    ['authenticate', { outcome: 'blocked', reason: 'acp-setup-timeout' }, state(null), 'transient'],
    ['authenticate', { outcome: 'blocked', reason: 'acp-setup-stopped' }, state(null), 'person'],
    [
      'authenticate',
      { outcome: 'blocked', reason: 'acp-setup-failed' },
      state('authentication-required'),
      'person',
    ],
    ['discover', { outcome: 'applied' }, state('acp-capability-missing'), 'transient'],
    [
      'discover',
      { outcome: 'outcome-unknown', reason: 'response-timeout' },
      state('acp-setup-timeout'),
      'transient',
    ],
    ['initialize', { outcome: 'outcome-unknown' }, state(null), 'person'],
    ['clear', { outcome: 'blocked', reason: 'google-ownership-unknown' }, state(null), 'person'],
    ['initialize', { outcome: 'blocked', reason: 'something-new' }, state(null), 'person'],
  ];
  for (const [stage, result, value, expected] of rows)
    assert.equal(
      classifyGoogleFailure(stage as never, result, value),
      expected,
      `${stage} ${result?.reason ?? result?.outcome}`,
    );
});

test('a status read that fails once after the sign-in does not need a second press', async () => {
  // A first connect on a fresh install: the install and initialize end, the sign-in finishes in
  // the browser, and the next status read fails once while the account still reads unknown. The
  // card used to pause there, and a second press resumed at the sign-in.
  const installed = installStatus('installed');
  const afterInitialize = signIn(2, { auth: { method: null, status: 'unknown' } });
  const reads: (GoogleState | Error)[] = [
    { googleAcpInstall: installed, googleAcpSetup: afterInitialize },
    // The sign-in ended. The controller has not saved it yet, then one read fails.
    {
      googleAcpInstall: installed,
      googleAcpSetup: setup(3, 'authenticating', {
        client,
        proofId: proof,
        operationId: operation,
      }),
    },
    new Error('response-timeout'),
    {
      googleAcpInstall: installed,
      googleAcpSetup: setup(4, 'discovery-required', {
        client,
        proofId: proof,
        auth: { method: 'oauth-personal', status: 'authenticated' },
      }),
    },
    { googleAcpInstall: installed, googleAcpSetup: ready },
  ];
  const sent: string[] = [];
  const stages: string[] = [];
  const result = await runGoogleSetupFlow({
    read: async () => {
      const next = reads.shift();
      if (next instanceof Error) throw next;
      return next as GoogleState;
    },
    active: () => true,
    onStage: (stage) => stages.push(stage),
    wait: async () => {},
    command: async (input) => {
      sent.push(input.command);
      return input.command === 'AuthenticateGoogleAcp'
        ? { outcome: 'outcome-unknown', reason: 'response-timeout' }
        : { outcome: 'applied' };
    },
  });
  assert.deepEqual(result, { kind: 'ready' });
  assert.deepEqual(sent, ['AuthenticateGoogleAcp', 'DiscoverGoogleAcp']);
  assert.deepEqual(stages, ['authenticate', 'discover']);
  assert.equal(reads.length, 0);
});

test('Connect pauses only after three failed status reads in a row', async () => {
  let reads = 0;
  let waits = 0;
  const result = await runGoogleSetupFlow({
    read: async () => {
      reads++;
      throw new Error('Controller is offline.');
    },
    active: () => true,
    onStage: () => {},
    wait: async () => {
      waits++;
    },
    command: async () => ({ outcome: 'applied' }),
  });
  assert.deepEqual(result, {
    kind: 'blocked',
    result: { outcome: 'blocked', reason: 'google-status-unreadable' },
  });
  assert.equal(reads, GOOGLE_READ_TRIES);
  assert.equal(waits, GOOGLE_READ_TRIES - 1);
});

test('the status poll tries a failed read again and gives up after three in a row', async () => {
  const outcomes = [true, false, true, false, false, true, true];
  let reads = 0;
  const once = await pollGoogleSetupStatus({
    wait: async () => {},
    read: async () => {
      if (!outcomes[reads++]) throw new Error('response-timeout');
    },
    active: () => true,
    attempts: outcomes.length,
  });
  assert.equal(once, 'timeout');
  assert.equal(reads, outcomes.length);

  let failures = 0;
  const always = await pollGoogleSetupStatus({
    wait: async () => {},
    read: async () => {
      failures++;
      throw new Error('response-timeout');
    },
    active: () => true,
  });
  assert.equal(always, 'unreadable');
  assert.equal(failures, GOOGLE_READ_TRIES);
});

test('a Connect press shows its first step and keeps the button in place', () => {
  // Nothing installed: the download is step 1 of 5 from the press on.
  const fresh = { googleAcpInstall: null, googleAcpSetup: null };
  assert.equal(startingGoogleStage(fresh), 'install');
  assert.equal(googleSetupProgress(fresh, startingGoogleStage(fresh))?.step, 'download');
  // An installed client starts at initialize.
  const installed = {
    googleAcpInstall: null,
    googleAcpSetup: setup(1, 'uninitialized', { client }),
  };
  assert.equal(startingGoogleStage(installed), 'initialize');
  const button = (working: boolean, running: boolean, cancelling = false) =>
    googleConnectButton({ working, running, cancelling, label: 'Connect Google' });
  assert.deepEqual(button(false, false), { label: 'Connect Google', disabled: false });
  assert.deepEqual(button(true, false), { label: 'Starting…', disabled: true });
  assert.deepEqual(button(true, true), { label: 'Connecting…', disabled: true });
  assert.deepEqual(button(true, true, true), { label: 'Connect Google', disabled: true });
});

test('the unconfirmed outcome line shows only after a step ended in an unknown state', () => {
  const unconfirmed = 'The setup outcome could not be confirmed. Review status before retrying.';
  const plain = 'Connect stopped. Press Connect to try again.';
  // A fresh launch with no attempt, an unreadable state and a blocked step say nothing unknown.
  assert.equal(googleConnectError({ googleAcpInstall: null, googleAcpSetup: null }), plain);
  assert.equal(googleConnectError(null), plain);
  assert.equal(
    googleConnectError({ googleAcpInstall: null, googleAcpSetup: setup(2, 'blocked') }),
    plain,
  );
  assert.equal(
    googleConnectError({ googleAcpInstall: null, googleAcpSetup: setup(2, 'unknown') }),
    unconfirmed,
  );
});
