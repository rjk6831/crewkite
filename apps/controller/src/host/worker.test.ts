import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OwnedCommand, type OwnedCommandLaunch, type OwnedCommandLifecycle } from './worker.ts';

const chunkBytes = 64 * 1024;

function ownership(events: string[]): OwnedCommandLifecycle {
  return {
    intent(launch: OwnedCommandLaunch) {
      assert.equal(launch.shell, false);
      events.push('intent');
    },
    owned(group) {
      assert(group > 0);
      events.push('owned');
    },
    quiescent(group) {
      assert(group > 0);
      events.push('quiescent');
    },
  };
}

async function collect(
  source: AsyncIterable<Uint8Array> | undefined,
  onChunk: (chunk: Uint8Array) => void = () => {},
): Promise<Buffer> {
  assert(source);
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    assert(chunk.byteLength <= chunkBytes);
    onChunk(chunk);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test('owned commands stream bounded output and keep cancellation owned through closure', {
  skip:
    process.platform !== 'darwin' &&
    'Linux process ownership is unqualified: an orphan that init never reaps keeps its group present after SIGKILL',
}, async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-owned-command-')));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const executable = realpathSync(process.execPath);
  const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const successEvents: string[] = [];
  const outputBytes = 1024 * 1024 + chunkBytes + 17;
  const inputBytes = 2 * 1024 * 1024 + 19;
  async function* successfulInput() {
    let remaining = inputBytes;
    while (remaining) {
      const bytes = Math.min(chunkBytes, remaining);
      yield Buffer.alloc(bytes, 66);
      remaining -= bytes;
    }
  }
  const successful = new OwnedCommand({
    streaming: true,
    operationId: 'cmd_stream_success',
    executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256,
    argv: [
      '-e',
      `let bytes=0;process.stdin.on('data',(chunk)=>bytes+=chunk.length);process.stdin.on('end',()=>process.stdout.write(Buffer.alloc(${outputBytes},65),()=>process.stderr.write(String(bytes))));`,
    ],
    directory,
    environment: { HOME: directory, LANG: 'C' },
    lifecycle: ownership(successEvents),
    input: successfulInput(),
  });
  const successfulOutput = Promise.all([
    collect(successful.stdoutStream),
    collect(successful.stderrStream),
  ]);
  const successfulExit = await successful.exited;
  assert.deepEqual(await successful.inputCompleted, { bytes: inputBytes });
  const [stdout, stderr] = await successfulOutput;
  await successful.closed;
  assert.equal(successfulExit.code, 0);
  assert.equal(successfulExit.signal, null);
  assert.equal(stdout.byteLength, outputBytes);
  assert.equal(stderr.toString('utf8'), String(inputBytes));
  assert.deepEqual(successful.stdout, []);
  assert.deepEqual(successful.stderr, []);
  assert.equal(await successful.quiescent(), true);
  assert.deepEqual(successEvents, ['intent', 'owned', 'quiescent']);

  let failedSourceClosed = false;
  async function* failedInput() {
    try {
      yield Buffer.from('partial');
      throw Error('source failed');
    } finally {
      failedSourceClosed = true;
    }
  }
  const inputFailure = new OwnedCommand({
    streaming: true,
    operationId: 'cmd_stream_input_failure',
    executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256,
    argv: ['-e', 'process.stdin.resume();setInterval(()=>{},1000);'],
    directory,
    environment: { HOME: directory, LANG: 'C' },
    lifecycle: ownership([]),
    input: failedInput(),
  });
  const failedOutput = Promise.all([
    collect(inputFailure.stdoutStream),
    collect(inputFailure.stderrStream),
  ]);
  await assert.rejects(inputFailure.inputCompleted, /source failed/);
  await Promise.all([failedOutput, inputFailure.exited, inputFailure.closed]);
  assert.equal(failedSourceClosed, true);
  assert.equal(inputFailure.failed, true);
  assert.equal(await inputFailure.quiescent(), true);

  let stoppedSourceClosed = false;
  async function* stoppedInput() {
    try {
      for (;;) {
        yield Buffer.alloc(chunkBytes, 67);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    } finally {
      stoppedSourceClosed = true;
    }
  }
  const inputReady = Promise.withResolvers<void>();
  const inputCancellation = new OwnedCommand({
    streaming: true,
    operationId: 'cmd_stream_input_cancel',
    executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256,
    argv: [
      '-e',
      "process.stdin.once('data',()=>{process.stdin.pause();process.stdout.write('ready');});setInterval(()=>{},1000);",
    ],
    directory,
    environment: { HOME: directory, LANG: 'C' },
    lifecycle: ownership([]),
    input: stoppedInput(),
  });
  const cancelledInputOutput = Promise.all([
    collect(inputCancellation.stdoutStream, () => inputReady.resolve()),
    collect(inputCancellation.stderrStream),
  ]);
  await inputReady.promise;
  inputCancellation.stop();
  await assert.rejects(inputCancellation.inputCompleted);
  await Promise.all([cancelledInputOutput, inputCancellation.exited, inputCancellation.closed]);
  assert.equal(stoppedSourceClosed, true);
  assert.equal(await inputCancellation.quiescent(), true);

  let heldInputReturns = 0;
  const heldInput: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return: async () => {
          heldInputReturns += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const heldCancellation = new OwnedCommand({
    streaming: true,
    operationId: 'cmd_stream_held_input_cancel',
    executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256,
    argv: ['-e', 'process.stdin.resume();setInterval(()=>{},1000);'],
    directory,
    environment: { HOME: directory, LANG: 'C' },
    lifecycle: ownership([]),
    input: heldInput,
  });
  const heldOutput = Promise.all([
    collect(heldCancellation.stdoutStream),
    collect(heldCancellation.stderrStream),
  ]);
  heldCancellation.stop();
  await assert.rejects(
    Promise.race([
      heldCancellation.inputCompleted,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('input cancellation timed out')), 500),
      ),
    ]),
    /stopped/,
  );
  await Promise.all([heldOutput, heldCancellation.exited, heldCancellation.closed]);
  assert.equal(heldInputReturns, 1);
  assert.equal(await heldCancellation.quiescent(), true);

  const acquisitionFailure = new OwnedCommand({
    streaming: true,
    operationId: 'cmd_stream_input_acquire_failure',
    executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256,
    argv: ['-e', 'process.stdin.resume();setInterval(()=>{},1000);'],
    directory,
    environment: { HOME: directory, LANG: 'C' },
    lifecycle: ownership([]),
    input: {
      [Symbol.asyncIterator]() {
        throw Error('input acquisition failed');
      },
    },
  });
  const acquisitionOutput = Promise.all([
    collect(acquisitionFailure.stdoutStream),
    collect(acquisitionFailure.stderrStream),
  ]);
  await assert.rejects(acquisitionFailure.inputCompleted, /input acquisition failed/);
  await Promise.all([acquisitionOutput, acquisitionFailure.exited, acquisitionFailure.closed]);
  assert.equal(acquisitionFailure.failed, true);
  assert.equal(await acquisitionFailure.quiescent(), true);

  let throwingReturnCalls = 0;
  const throwingReturn = new OwnedCommand({
    streaming: true,
    operationId: 'cmd_stream_input_return_failure',
    executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256,
    argv: ['-e', 'process.stdin.resume();setInterval(()=>{},1000);'],
    directory,
    environment: { HOME: directory, LANG: 'C' },
    lifecycle: ownership([]),
    input: {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: () => {
            throwingReturnCalls += 1;
            throw Error('input return failed');
          },
        };
      },
    },
  });
  const throwingReturnOutput = Promise.all([
    collect(throwingReturn.stdoutStream),
    collect(throwingReturn.stderrStream),
  ]);
  assert.doesNotThrow(() => throwingReturn.stop());
  await assert.rejects(throwingReturn.inputCompleted, /stopped/);
  await Promise.all([throwingReturnOutput, throwingReturn.exited, throwingReturn.closed]);
  assert.equal(throwingReturnCalls, 1);
  assert.equal(await throwingReturn.quiescent(), true);

  const cancelledEvents: string[] = [];
  const ready = Promise.withResolvers<void>();
  const stubborn = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);";
  const descendant = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>process.stdout.write('ready',()=>process.exit(0)));`;
  const cancelled = new OwnedCommand({
    streaming: true,
    operationId: 'cmd_stream_cancel',
    executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256,
    argv: ['-e', descendant],
    directory,
    environment: { HOME: directory, LANG: 'C' },
    lifecycle: ownership(cancelledEvents),
  });
  let readyText = '';
  const cancelledOutput = Promise.all([
    collect(cancelled.stdoutStream, (chunk) => {
      readyText += Buffer.from(chunk).toString('utf8');
      if (readyText.includes('ready')) ready.resolve();
    }),
    collect(cancelled.stderrStream),
  ]);
  await ready.promise;
  const leaderExit = await cancelled.exited;
  assert.equal(leaderExit.code, 0);
  assert.equal(leaderExit.signal, null);
  const [beforeStop, cancelledError] = await cancelledOutput;
  await cancelled.closed;
  assert.equal(await cancelled.quiescent(), false);
  cancelled.stop();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(beforeStop.toString('utf8'), 'ready');
  assert.equal(cancelledError.byteLength, 0);
  assert.equal(await cancelled.quiescent(), true);
  assert.deepEqual(cancelledEvents, ['intent', 'owned', 'quiescent']);

  const unknownEvents: string[] = [];
  const ownershipFailure = new OwnedCommand({
    streaming: true,
    operationId: 'cmd_stream_owned_failure',
    executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256,
    argv: ['-e', 'setInterval(()=>{},1000);'],
    directory,
    environment: { HOME: directory, LANG: 'C' },
    lifecycle: {
      intent() {
        unknownEvents.push('intent');
      },
      owned() {
        unknownEvents.push('owned');
        throw Error('journal unavailable');
      },
      quiescent() {
        unknownEvents.push('quiescent');
      },
    },
  });
  await Promise.all([
    collect(ownershipFailure.stdoutStream),
    collect(ownershipFailure.stderrStream),
    ownershipFailure.exited,
    ownershipFailure.closed,
  ]);
  assert.equal(await ownershipFailure.quiescent(), true);
  assert.equal(ownershipFailure.ownershipUnknown, true);
  await assert.rejects(ownershipFailure.inputCompleted, /journal unavailable/);
  assert.deepEqual(unknownEvents, ['intent', 'owned', 'quiescent']);

  assert.throws(
    () =>
      new OwnedCommand({
        streaming: true,
        operationId: 'cmd_stream_changed_identity',
        executable,
        executableIdentity: 'verified-prelaunch-sha256',
        executableSha256: '0'.repeat(64),
        argv: ['--version'],
        directory,
        environment: { HOME: directory },
        lifecycle: ownership([]),
      }),
    /identity changed/,
  );
});
