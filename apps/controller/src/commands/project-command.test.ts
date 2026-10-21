import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  type OwnedProjectCommandExecution,
  type OwnedProjectCommandLifecycle,
  type OwnedProjectCommandRequest,
  type OwnedProjectCommandTerminal,
  PROJECT_COMMAND_CHUNK_BYTES,
  type ProjectCommandDefinition,
  type ProjectCommandPublisher,
  startProjectCommand,
  validateProjectCommandDefinition,
} from './project-command.ts';

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crewkite-project-command-')));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const repositoryRoot = join(root, 'source');
  const scratchRoot = join(root, 'scratch');
  const cwd = join(scratchRoot, 'package');
  const executable = join(root, 'tool');
  mkdirSync(repositoryRoot);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(executable, '#!/bin/false\n');
  chmodSync(executable, 0o755);
  const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const definition: ProjectCommandDefinition = {
    version: 1,
    operationId: 'cmd_00000000000000000000000001',
    recipe: 'test',
    source: {
      projectId: 'prj_00000000000000000000000001',
      repositoryRoot,
      baseRevision: 'a'.repeat(40),
    },
    scratchRoot,
    cwd,
    executable,
    executableIdentity: 'verified-prelaunch-sha256',
    executableSha256,
    argv: ['--run', 'tests/unit.test.ts'],
    environment: { HOME: join(root, 'home'), LANG: 'C', PATH: join(root, 'bin') },
    output: { stdout: 'artifact', stderr: 'artifact', chunkBytes: PROJECT_COMMAND_CHUNK_BYTES },
  };
  return { root, definition };
}

function asyncBytes(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

const publishStream: ProjectCommandPublisher = async (source) => {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of source) {
    assert.ok(chunk.byteLength <= PROJECT_COMMAND_CHUNK_BYTES);
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { hash: hash.digest('hex'), bytes };
};

function lifecycle(): OwnedProjectCommandLifecycle {
  return { intent() {}, owned() {}, quiescent() {} };
}

test('project command definitions stay bound to their source, scratch, executable and environment', (t) => {
  const { root, definition } = fixture(t);
  const linked = join(root, 'linked');
  const dotted = join(definition.scratchRoot, '..cache');
  symlinkSync(definition.cwd, linked);
  mkdirSync(dotted);
  const cases: Array<{ name: string; value: ProjectCommandDefinition; message: RegExp }> = [
    {
      name: 'source checkout cwd',
      value: { ...definition, cwd: definition.source.repositoryRoot },
      message: /inside scratch/,
    },
    {
      name: 'linked cwd',
      value: { ...definition, cwd: linked },
      message: /canonical directory/,
    },
    {
      name: 'changed executable',
      value: { ...definition, executableSha256: '0'.repeat(64) },
      message: /identity changed/,
    },
    {
      name: 'ambient credential',
      value: { ...definition, environment: { ...definition.environment, TOKEN: 'secret' } },
      message: /not allowed/,
    },
    {
      name: 'shell executable',
      value: {
        ...definition,
        executable: '/bin/sh',
        executableSha256: createHash('sha256').update(readFileSync('/bin/sh')).digest('hex'),
      },
      message: /shell authority/,
    },
  ];
  assert.equal(validateProjectCommandDefinition(definition), definition);
  assert.equal(validateProjectCommandDefinition({ ...definition, cwd: dotted }).cwd, dotted);
  for (const row of cases)
    assert.throws(() => validateProjectCommandDefinition(row.value), row.message, row.name);
});

test('project commands retain streamed output and classify success, failure and cancellation', async (t) => {
  const { definition } = fixture(t);
  const large = [
    Buffer.alloc(PROJECT_COMMAND_CHUNK_BYTES, 1),
    Buffer.alloc(PROJECT_COMMAND_CHUNK_BYTES, 2),
    Buffer.from('complete'),
  ];
  const rows: Array<{
    name: string;
    stdout: readonly Uint8Array[];
    stderr: readonly Uint8Array[];
    terminal: OwnedProjectCommandTerminal | 'on-stop';
    status: 'succeeded' | 'failed' | 'cancelled';
    reason: 'exit-zero' | 'nonzero-exit' | 'stopped';
    stop: boolean;
  }> = [
    {
      name: 'successful large output',
      stdout: large,
      stderr: [],
      terminal: { code: 0, signal: null, quiescent: true, reason: 'exit' },
      status: 'succeeded',
      reason: 'exit-zero',
      stop: false,
    },
    {
      name: 'failed command',
      stdout: [Buffer.from('before failure')],
      stderr: [Buffer.from('lint failed')],
      terminal: { code: 2, signal: null, quiescent: true, reason: 'exit' },
      status: 'failed',
      reason: 'nonzero-exit',
      stop: false,
    },
    {
      name: 'cancelled command',
      stdout: [Buffer.from('before stop')],
      stderr: [],
      terminal: 'on-stop',
      status: 'cancelled',
      reason: 'stopped',
      stop: true,
    },
  ];
  for (const row of rows) {
    let resolveTerminal: (terminal: OwnedProjectCommandTerminal) => void = () => {};
    const terminal =
      row.terminal === 'on-stop'
        ? new Promise<OwnedProjectCommandTerminal>((resolve) => {
            resolveTerminal = resolve;
          })
        : Promise.resolve(row.terminal);
    let stops = 0;
    let request: OwnedProjectCommandRequest | undefined;
    const execution: OwnedProjectCommandExecution = {
      stdout: asyncBytes(row.stdout),
      stderr: asyncBytes(row.stderr),
      terminal,
      stop() {
        stops += 1;
        resolveTerminal({ code: null, signal: 'SIGTERM', quiescent: true, reason: 'stopped' });
      },
    };
    const operation = startProjectCommand(definition, {
      lifecycle: lifecycle(),
      publishStream,
      runner: {
        launch(next) {
          request = next;
          return execution;
        },
      },
    });
    if (row.stop) {
      operation.stop();
      operation.stop();
    }
    const result = await operation.result;
    assert.equal(result.status, row.status, row.name);
    assert.equal(result.reason, row.reason, row.name);
    assert.equal(
      result.stdout?.bytes,
      row.stdout.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    );
    assert.equal(
      result.stderr?.bytes,
      row.stderr.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    );
    assert.equal(stops, row.stop ? 1 : 0, row.name);
    assert.equal(request?.shell, false);
    assert.equal(request?.executableIdentity, 'verified-prelaunch-sha256');
    assert.equal(request?.executableSha256, definition.executableSha256);
  }

  let stops = 0;
  let close: (terminal: OwnedProjectCommandTerminal) => void = () => {};
  const terminal = new Promise<OwnedProjectCommandTerminal>((resolve) => {
    close = resolve;
  });
  const operation = startProjectCommand(definition, {
    lifecycle: lifecycle(),
    publishStream() {
      throw Error('disk unavailable');
    },
    runner: {
      launch() {
        return {
          stdout: asyncBytes([]),
          stderr: asyncBytes([]),
          terminal,
          stop() {
            stops += 1;
            close({ code: null, signal: 'SIGTERM', quiescent: true, reason: 'stopped' });
          },
        };
      },
    },
  });
  const failed = await operation.result;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'output');
  assert.equal(stops, 1);
});
