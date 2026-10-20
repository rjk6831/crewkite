import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ARTIFACT_CHUNK_BYTES, ArtifactFiles } from './index.ts';

test('streamed artifacts retain complete identities through bounded ranges and failed publication', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ck-artifact-stream-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifacts = new ArtifactFiles(directory);
  const total = 65 * 1024 * 1024 + 19;
  const expected = createHash('sha256');
  async function* source() {
    const chunk = Buffer.alloc(ARTIFACT_CHUNK_BYTES);
    for (let offset = 0; offset < total; offset += chunk.length) {
      chunk.fill((offset / chunk.length) % 251);
      const part = chunk.subarray(0, Math.min(chunk.length, total - offset));
      expected.update(part);
      yield part;
    }
  }
  const published = await artifacts.publishStream(source());
  assert.deepEqual(published, { hash: expected.digest('hex'), bytes: total });
  assert.throws(() => artifacts.read(published.hash), /bounded/);
  assert.deepEqual(await artifacts.verify(published.hash), published);
  const reconstructed = createHash('sha256');
  for (let offset = 0; offset < total; ) {
    const page = await artifacts.readRange(published.hash, { offset, limit: ARTIFACT_CHUNK_BYTES });
    assert.equal(page.totalBytes, total);
    assert.ok(page.bytes.length > 0 && page.bytes.length <= ARTIFACT_CHUNK_BYTES);
    reconstructed.update(page.bytes);
    offset += page.bytes.length;
    assert.equal(page.eof, offset === total);
  }
  assert.equal(reconstructed.digest('hex'), published.hash);
  const reopened = new ArtifactFiles(directory);
  assert.deepEqual(await reopened.verify(published.hash), published);
  assert.deepEqual(await reopened.readRange(published.hash, { offset: total, limit: 1 }), {
    bytes: Buffer.alloc(0),
    totalBytes: total,
    eof: true,
  });
  await assert.rejects(
    reopened.readRange(published.hash, { offset: total + 1, limit: 1 }),
    /range/,
  );
  const previous = artifacts.publish(Buffer.from('Keep the previous complete artifact.'));
  const abort = new AbortController();
  async function* cancelled() {
    yield Buffer.alloc(ARTIFACT_CHUNK_BYTES, 5);
    abort.abort();
    yield Buffer.from('Never publish this suffix.');
  }
  await assert.rejects(artifacts.publishStream(cancelled(), { signal: abort.signal }), {
    name: 'AbortError',
  });
  async function* failed() {
    yield Buffer.from('An incomplete incoming file.');
    throw Object.assign(new Error('Injected source failure.'), { code: 'ENOSPC' });
  }
  await assert.rejects(artifacts.publishStream(failed()), { code: 'ENOSPC' });
  assert.equal(
    readdirSync(directory).some((name) => name.startsWith('.incoming-')),
    false,
  );
  assert.equal(artifacts.read(previous.hash).toString(), 'Keep the previous complete artifact.');
  const interrupted = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { ArtifactFiles } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const files = new ArtifactFiles(${JSON.stringify(directory)});
    await files.publishStream((async function* () {
      yield Buffer.alloc(65536, 17);
      process.exit(23);
    })());
  `,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(interrupted.status, 23, interrupted.stderr);
  assert.equal(readdirSync(directory).filter((name) => name.startsWith('.incoming-')).length, 1);
  assert.equal(
    new ArtifactFiles(directory).read(previous.hash).toString(),
    'Keep the previous complete artifact.',
  );
  const corrupt = artifacts.publish(Buffer.from('original'));
  writeFileSync(join(directory, corrupt.hash), 'modified');
  assert.equal(
    (await artifacts.readRange(corrupt.hash, { offset: 0, limit: 8 })).bytes.toString(),
    'modified',
  );
  await assert.rejects(artifacts.verify(corrupt.hash), /checksum/);
  await assert.rejects(
    artifacts.publishStream(
      (async function* () {
        yield Buffer.from('original');
      })(),
    ),
    /checksum/,
  );
  assert.equal(
    (await artifacts.readRange(corrupt.hash, { offset: 0, limit: 8 })).bytes.toString(),
    'modified',
  );
  await assert.rejects(artifacts.verify('f'.repeat(64)), { code: 'ENOENT' });
});
