import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ArtifactSchema, CommandSchema } from '@crewkite/contracts';
import { runCli } from '../../../apps/cli/src/main.ts';
import { ArtifactFiles } from '../../../apps/controller/src/artifacts/index.ts';
import { Controller } from '../../../apps/controller/src/commands/controller.ts';
import { serve } from '../../../apps/controller/src/server/index.ts';
import {
  connectController,
  controllerSocketPath,
  ownSocketDirectory,
  readControllerEndpoint,
} from './node.ts';
import { transferArtifact } from './output.ts';

test('native output reads verify large retained bytes with cancellation and explicit corruption failure', async (t) => {
  // The home is 120 characters deep and a crashed run left its control socket file behind. The
  // socket lives in the per-user temporary folder, so the next start unlinks the leftover and
  // still serves both the client and the CLI.
  const base = mkdtempSync(join(tmpdir(), 'ck-output-'));
  const home = join(base, 'h'.repeat(100));
  assert.ok(home.length >= 120);
  mkdirSync(home, { mode: 0o700 });
  const socketPath = controllerSocketPath(home);
  ownSocketDirectory(dirname(socketPath));
  spawnSync(process.execPath, [
    '-e',
    'require("node:net").createServer().listen(process.argv[1],()=>process.exit(0))',
    socketPath,
  ]);
  assert.ok(existsSync(socketPath));
  const controller = new Controller({
    home,
    nativeProfiles: () => [],
    googleUsageClient: () => ({ available: false, reason: 'client-unavailable' }),
  });
  const files = new ArtifactFiles(join(home, 'artifacts'));
  const expected = createHash('sha256');
  const length = 65 * 1024 * 1024 + 19;
  const published = await files.publishStream(
    (async function* () {
      const chunk = Buffer.alloc(65536, 37);
      for (let offset = 0; offset < length; offset += chunk.length) {
        const bytes = chunk.subarray(0, Math.min(chunk.length, length - offset));
        expected.update(bytes);
        yield bytes;
      }
    })(),
  );
  const artifact = ArtifactSchema.parse({
    id: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ...published,
    mediaType: 'application/octet-stream',
  });
  controller.store.transaction(() => controller.store.put('artifact', artifact.id, 0, artifact));
  const server = await serve(controller);
  assert.equal(server.socketPath, socketPath);
  const client = await connectController({
    ...readControllerEndpoint(home),
    actor: { id: 'terminal', kind: 'cli' },
  });
  t.after(async () => {
    client.close();
    await server.close();
    await controller.close();
    rmSync(base, { recursive: true, force: true });
    assert.equal(existsSync(socketPath), false);
  });
  const received = createHash('sha256');
  let largest = 0;
  const proof = await transferArtifact(
    artifact,
    (input) => client.artifactRange(input),
    (bytes) => {
      received.update(bytes);
      largest = Math.max(largest, bytes.length);
    },
  );
  assert.equal(largest, 65536);
  assert.equal(proof.integrity, 'whole-verified');
  assert.equal(proof.bytes, length);
  assert.equal(proof.hash, expected.digest('hex'));
  assert.equal(received.digest('hex'), artifact.hash);
  const abort = new AbortController();
  let reads = 0;
  await assert.rejects(
    transferArtifact(
      artifact,
      (input) => {
        reads++;
        return client.artifactRange(input);
      },
      () => abort.abort(),
      { signal: abort.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(reads, 1);
  assert.equal((await client.workspaceState()).kind, 'workspace-state');
  const smallText = 'Retained output, 界.'.repeat(5000);
  const small = ArtifactSchema.parse({
    id: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAW',
    ...files.publish(Buffer.from(smallText)),
    mediaType: 'text/plain',
  });
  controller.store.transaction(() => controller.store.put('artifact', small.id, 0, small));
  const output = join(home, 'saved-output');
  const errors: string[] = [];
  assert.equal(
    await runCli(['artifact', 'save', small.id, '--output', output, '--home', home], {
      out: () => {},
      err: (text) => errors.push(text),
    }),
    0,
  );
  assert.equal(readFileSync(output, 'utf8'), smallText);
  assert.match(errors.join(''), /Verified/);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0,
    rangeReads = 0;
  const execute = controller.execute.bind(controller);
  controller.execute = async (input, principal) => {
    const command = CommandSchema.parse(input);
    if (command.command === 'GetArtifactRange' && command.payload.artifactId === small.id)
      rangeReads++;
    return execute(input, principal);
  };
  const reading = runCli(['artifact', 'read', small.id, '--json', '--home', home], {
    out: () => {
      writes++;
      if (writes === 1) {
        entered.resolve();
        return release.promise;
      }
    },
    err: () => {},
  });
  try {
    await entered.promise;
    const before = rangeReads;
    await client.workspaceState();
    assert.equal(rangeReads, before, 'No next range can be requested before the receiver drains.');
    release.resolve();
    assert.equal(await reading, 0);
    assert.ok(writes >= 3);
  } finally {
    release.resolve();
    controller.execute = execute;
  }
  writeFileSync(join(home, 'artifacts', small.hash), Buffer.alloc(small.bytes, 88));
  await assert.rejects(
    transferArtifact(
      small,
      (input) => client.artifactRange(input),
      () => {},
    ),
    /checksum/,
  );
});
