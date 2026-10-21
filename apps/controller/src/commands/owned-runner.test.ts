import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOwnedProjectCommandRunner } from './owned-runner.ts';

test('the shared command adapter keeps deadlines through pipe closure and reports only positive ownership proof', async () => {
  const fixture = () => {
    const timers: Array<{ ms: number; active: boolean; work: () => void }> = [];
    const exited = Promise.withResolvers<{
      code: number | null;
      signal: NodeJS.Signals | null;
      quiescent: boolean;
    }>();
    const closed = Promise.withResolvers<void>();
    let absent = false;
    let stops = 0;
    let discarded = 0;
    const owner = {
      stdoutStream: (async function* () {})(),
      stderrStream: (async function* () {})(),
      inputCompleted: Promise.resolve({ bytes: 0 }),
      exited: exited.promise,
      closed: closed.promise,
      failed: false,
      ownershipUnknown: false,
      stop: () => {
        stops++;
      },
      quiescent: async () => absent,
      discardOutput: () => {
        discarded++;
      },
    };
    const runner = createOwnedProjectCommandRunner({
      deadlineMs: 900000,
      now: () => 0,
      schedule: (work, ms) => {
        const timer = { work, ms, active: true };
        timers.push(timer);
        return () => {
          timer.active = false;
        };
      },
      create: () => owner,
    });
    const execution = runner.launch(
      {
        operationId: 'cmd_test',
        executable: '/test/tool',
        executableIdentity: 'verified-prelaunch-sha256',
        executableSha256: 'a'.repeat(64),
        argv: [],
        cwd: '/scratch',
        environment: {},
        shell: false,
      },
      { intent() {}, owned() {}, quiescent() {} },
    );
    const fire = (ms: number) => {
      const timer = timers.find((value) => value.active && value.ms === ms);
      assert(timer);
      timer.active = false;
      timer.work();
    };
    return {
      execution,
      owner,
      exited,
      closed,
      fire,
      timers,
      absent: () => {
        absent = true;
      },
      stops: () => stops,
      discarded: () => discarded,
    };
  };
  const flush = async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  };
  const held = fixture();
  held.exited.resolve({ code: 0, signal: null, quiescent: false });
  let settled = false;
  void held.execution.terminal.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false, 'Leader exit does not retire the admitted deadline.');
  held.fire(900000);
  assert.equal(held.stops(), 1);
  held.fire(3000);
  assert.equal((await held.execution.terminal).quiescent, false);
  assert.equal(
    held.discarded(),
    1,
    'Unproven output fails instead of retaining infinite publishers.',
  );

  const descendant = fixture();
  descendant.exited.resolve({ code: 0, signal: null, quiescent: false });
  descendant.closed.resolve();
  await flush();
  assert.equal(descendant.stops(), 1, 'Closed pipes do not prove same-group descendants absent.');
  descendant.absent();
  descendant.fire(25);
  const cleaned = await descendant.execution.terminal;
  assert.equal(cleaned.quiescent, true);
  assert.equal(
    cleaned.reason,
    'ownership',
    'A leftover child cannot turn into an ordinary successful exit.',
  );

  const launchUnknown = fixture();
  launchUnknown.owner.ownershipUnknown = true;
  launchUnknown.exited.resolve({ code: null, signal: 'SIGKILL', quiescent: false });
  launchUnknown.closed.resolve();
  await flush();
  assert.equal(launchUnknown.stops(), 1);
  assert(launchUnknown.timers.some((value) => value.active && value.ms === 3000));
  launchUnknown.absent();
  launchUnknown.fire(25);
  assert.equal((await launchUnknown.execution.terminal).reason, 'ownership');

  const callbackFailure = fixture();
  let closureCalls = 0;
  callbackFailure.owner.quiescent = async () => {
    closureCalls++;
    callbackFailure.owner.ownershipUnknown = true;
    return false;
  };
  callbackFailure.exited.resolve({ code: 0, signal: null, quiescent: true });
  callbackFailure.closed.resolve();
  assert.equal((await callbackFailure.execution.terminal).reason, 'ownership');
  assert.equal(closureCalls, 1, 'A failed durable closure is not replayed by polling.');
  assert.equal(callbackFailure.timers.filter((value) => value.active).length, 0);

  const stopped = fixture();
  stopped.execution.stop();
  stopped.fire(900000);
  stopped.absent();
  stopped.exited.resolve({ code: null, signal: 'SIGTERM', quiescent: true });
  stopped.closed.resolve();
  assert.equal((await stopped.execution.terminal).reason, 'stopped');

  const clean = fixture();
  clean.absent();
  clean.exited.resolve({ code: 0, signal: null, quiescent: true });
  clean.closed.resolve();
  assert.deepEqual(await clean.execution.terminal, {
    code: 0,
    signal: null,
    quiescent: true,
    reason: 'exit',
  });
  assert.equal(clean.stops(), 0);
  assert.equal(clean.timers.filter((value) => value.active).length, 0);
});
