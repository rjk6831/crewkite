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

test('owned commands stream bounded output and keep cancellation owned through closure', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-owned-command-')));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const executable = realpathSync(process.execPath);
  const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const successEvents: string[] = [];
  const outputBytes = 1024 * 1024 + chunkBytes + 17;
  const successful = new OwnedCommand({
    streaming: true,
    operationId: 'cmd_stream_success',
    executable,
    executableSha256,
    argv: [
      '-e',
      `process.stdout.write(Buffer.alloc(${outputBytes}, 65), () => process.stderr.write('ไทย'));`,
    ],
    directory,
    environment: { HOME: directory, LANG: 'C' },
    lifecycle: ownership(successEvents),
  });
  const successfulOutput = Promise.all([
    collect(successful.stdoutStream),
    collect(successful.stderrStream),
  ]);
  const successfulExit = await successful.exited;
  const [stdout, stderr] = await successfulOutput;
  await successful.closed;
  assert.equal(successfulExit.code, 0);
  assert.equal(successfulExit.signal, null);
  assert.equal(stdout.byteLength, outputBytes);
  assert.equal(stderr.toString('utf8'), 'ไทย');
  assert.deepEqual(successful.stdout, []);
  assert.deepEqual(successful.stderr, []);
  assert.equal(await successful.quiescent(), true);
  assert.deepEqual(successEvents, ['intent', 'owned', 'quiescent']);

  const cancelledEvents: string[] = [];
  const ready = Promise.withResolvers<void>();
  const cancelled = new OwnedCommand({
    streaming: true,
    operationId: 'cmd_stream_cancel',
    executable,
    executableSha256,
    argv: ['-e', "process.stdout.write('ready');setInterval(()=>{},1000);"],
    directory,
    environment: { HOME: directory, LANG: 'C' },
    lifecycle: ownership(cancelledEvents),
  });
  const cancelledOutput = Promise.all([
    collect(cancelled.stdoutStream, () => ready.resolve()),
    collect(cancelled.stderrStream),
  ]);
  await ready.promise;
  cancelled.stop();
  const cancelledExit = await cancelled.exited;
  const [beforeStop, cancelledError] = await cancelledOutput;
  await cancelled.closed;
  assert.equal(cancelledExit.code, null);
  assert.equal(cancelledExit.signal, 'SIGTERM');
  assert.equal(beforeStop.toString('utf8'), 'ready');
  assert.equal(cancelledError.byteLength, 0);
  assert.equal(await cancelled.quiescent(), true);
  assert.deepEqual(cancelledEvents, ['intent', 'owned', 'quiescent']);

  assert.throws(
    () =>
      new OwnedCommand({
        streaming: true,
        operationId: 'cmd_stream_changed_identity',
        executable,
        executableSha256: '0'.repeat(64),
        argv: ['--version'],
        directory,
        environment: { HOME: directory },
        lifecycle: ownership([]),
      }),
    /identity changed/,
  );
});
