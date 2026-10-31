import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { importGoogleAcp } from './import.ts';
import { googleAcpCacheDirectory, installGoogleAcp } from './install.ts';
import { googleAcpDeveloperIdRequirement } from './profile.ts';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const chunks: Buffer[] = [];
  const directory: Buffer[] = [];
  const files = ['agy_acp_server.par', 'localharness_external'].map((name) => {
    const bytes = Buffer.from(`bounded ${name}`);
    const compressed = deflateRawSync(bytes);
    const offset = chunks.reduce((size, value) => size + value.length, 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, Buffer.from(name), compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0x81ed0000, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, Buffer.from(name));
    return { name, bytes: bytes.length, compressed: compressed.length, sha256: digest(bytes) };
  });
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(
    directory.reduce((size, value) => size + value.length, 0),
    12,
  );
  end.writeUInt32LE(
    chunks.reduce((size, value) => size + value.length, 0),
    16,
  );
  const archive = Buffer.concat([...chunks, ...directory, end]);
  return {
    archive,
    release: {
      url: 'https://dl.google.com/fixed-fixture.zip',
      bytes: archive.length,
      sha256: digest(archive),
      files,
    },
  };
}

test('the fixed installer validates before publishing and preserves existing input on refusal', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'acp-install-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const scenario of [
    'success',
    'tamper',
    'oversize',
    'cancel',
    'cancel-stream',
    'http',
    'encoded',
    'layout',
    'inner',
    'staging',
    'retry-staging',
    'cancel-signature',
    'ownership-cancel',
    'pin',
    'signature',
  ] as const) {
    const home = join(root, scenario);
    mkdirSync(home, { mode: 0o700 });
    const sample = fixture();
    const controller = new AbortController();
    let downloads = 0;
    let signatures = 0;
    if (scenario === 'staging') {
      mkdirSync(join(home, 'imports'), { mode: 0o700 });
      mkdirSync(join(home, 'imports/google-acp-v1'), { mode: 0o700 });
      writeFileSync(join(home, 'imports/google-acp-v1/manual'), 'preserve');
    }
    if (scenario === 'retry-staging') {
      mkdirSync(join(home, 'imports'), { mode: 0o700 });
      mkdirSync(join(home, 'imports/.google-acp-install-Ab1234'), { mode: 0o700 });
      writeFileSync(join(home, 'imports/.google-acp-install-Ab1234/release.zip'), 'partial');
    }
    if (scenario === 'pin') {
      mkdirSync(join(home, 'providers'), { mode: 0o700 });
      mkdirSync(join(home, 'providers/google-acp-v1'), { mode: 0o700 });
      writeFileSync(join(home, 'providers/google-acp-v1/pin.json'), 'preserve', { mode: 0o400 });
    }
    let body = sample.archive;
    if (scenario === 'tamper')
      body = Buffer.from(body.map((byte, index) => (index === 40 ? byte ^ 1 : byte)));
    if (scenario === 'oversize') body = Buffer.concat([body, Buffer.from('extra')]);
    if (scenario === 'layout') {
      body.writeUInt32LE(0xa1ed0000, body.length - 22 - (46 + 21) + 38);
      sample.release.sha256 = digest(body);
    }
    if (scenario === 'inner') sample.release.files[0].sha256 = '0'.repeat(64);
    const dependencies = {
      release: sample.release,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        downloads++;
        assert.equal(init?.redirect, 'error');
        assert.equal(init?.credentials, 'omit');
        assert.equal(new Headers(init?.headers).get('accept-encoding'), 'identity');
        if (scenario === 'cancel') {
          controller.abort();
          throw Error('cancelled');
        }
        if (scenario === 'cancel-stream')
          return new Response(
            new ReadableStream({
              pull(stream) {
                stream.enqueue(body.subarray(0, 32));
                controller.abort();
                stream.close();
              },
            }),
          );
        return new Response(body, {
          status: scenario === 'http' ? 404 : 200,
          headers:
            scenario === 'encoded'
              ? { 'content-encoding': 'gzip', 'content-length': String(body.length) }
              : scenario === 'success'
                ? { 'content-encoding': 'identity' }
                : {},
        });
      }) as typeof fetch,
      import: {
        verifySignature: async () => {
          signatures++;
          if (scenario === 'signature') throw Error('refused');
          if (scenario === 'cancel-signature') controller.abort();
          if (scenario === 'ownership-cancel') {
            controller.abort();
            throw Error('ownership');
          }
          return {
            verified: true as const,
            signerTeamId: 'EQHXZ8M8AV',
            requirement: googleAcpDeveloperIdRequirement('EQHXZ8M8AV'),
            quiescent: true as const,
          };
        },
      },
    };
    const progress: { step: string; bytes: number; totalBytes: number }[] = [];
    const result = await installGoogleAcp(
      {
        home,
        consent: 'explicit',
        signal: controller.signal,
        onProgress: (value) => {
          progress.push(value);
          // A listener that throws never stops the install.
          if (scenario === 'success') throw Error('display failed');
        },
      },
      dependencies,
    );
    if (scenario === 'success' || scenario === 'staging' || scenario === 'retry-staging') {
      assert.equal(result.imported, true, JSON.stringify(result));
      assert.equal(signatures, 2);
      // Download counts archive bytes, extract counts the unpacked files, then verify runs.
      const inflated = sample.release.files.reduce((total, file) => total + file.bytes, 0);
      const steps = [...new Set(progress.map((value) => value.step))];
      assert.deepEqual(steps, ['download', 'extract', 'verify']);
      assert.deepEqual(
        progress.findLast((value) => value.step === 'download'),
        {
          step: 'download',
          bytes: sample.release.bytes,
          totalBytes: sample.release.bytes,
        },
      );
      assert.deepEqual(
        progress.findLast((value) => value.step === 'extract'),
        {
          step: 'extract',
          bytes: inflated,
          totalBytes: inflated,
        },
      );
      for (const [index, value] of progress.entries()) {
        assert.ok(value.bytes <= value.totalBytes);
        const prior = progress[index - 1];
        if (prior?.step === value.step) assert.ok(value.bytes >= prior.bytes);
      }
      const pin = readFileSync(join(home, 'providers/google-acp-v1/pin.json'));
      const again = await installGoogleAcp({ home, consent: 'explicit' }, dependencies);
      assert.equal(again.reason, 'already-imported');
      assert.equal(downloads, 1);
      assert.deepEqual(readFileSync(join(home, 'providers/google-acp-v1/pin.json')), pin);
    } else {
      assert.equal(result.imported, false, scenario);
      assert.equal(
        result.reason,
        (
          {
            tamper: 'archive-refused',
            oversize: 'archive-refused',
            cancel: 'cancelled',
            'cancel-stream': 'cancelled',
            http: 'download-unavailable',
            encoded: 'download-unavailable',
            layout: 'archive-refused',
            inner: 'archive-refused',
            'cancel-signature': 'cancelled',
            'ownership-cancel': 'ownership',
            pin: 'pin-conflict',
            signature: 'signature-refused',
          } as const
        )[scenario],
      );
      assert.equal(existsSync(join(home, 'providers/google-acp-v1/pin.json')), scenario === 'pin');
      if (scenario === 'pin')
        assert.equal(
          readFileSync(join(home, 'providers/google-acp-v1/pin.json'), 'utf8'),
          'preserve',
        );
      if (!['pin', 'signature', 'cancel-signature', 'ownership-cancel'].includes(scenario))
        assert.equal(signatures, 0);
    }
    if (scenario === 'staging')
      assert.equal(readFileSync(join(home, 'imports/google-acp-v1/manual'), 'utf8'), 'preserve');
    if (scenario === 'retry-staging')
      assert.equal(
        readFileSync(join(home, 'imports/.google-acp-install-Ab1234/release.zip'), 'utf8'),
        'partial',
      );
    if (existsSync(join(home, 'imports')))
      assert.equal(
        readdirSync(join(home, 'imports')).filter((name) => name.startsWith('.google-acp-install-'))
          .length,
        scenario === 'retry-staging' ? 1 : 0,
      );
  }
  const home = join(root, 'internal-path');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(home, 'imports'), { mode: 0o700 });
  for (const candidate of ['outside', 'imports/manual', 'imports/.google-acp-install-Ab1234']) {
    const staging = join(home, candidate);
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, 'extra'), 'unexpected');
    const refused = await importGoogleAcp({ home, consent: 'explicit', installerStaging: staging });
    assert.equal(refused.reason, 'invalid-import');
    assert.equal(existsSync(join(home, 'providers/google-acp-v1/pin.json')), false);
  }
});

const signed = {
  verifySignature: async () => ({
    verified: true as const,
    signerTeamId: 'EQHXZ8M8AV',
    requirement: googleAcpDeveloperIdRequirement('EQHXZ8M8AV'),
    quiescent: true as const,
  }),
};

test('a download that stops making progress ends as stalled, and Stop still cancels', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'acp-stall-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sample = fixture();
  // The body sends a few bytes, then nothing. Only the stall rule ends it. An aborted fetch errors
  // its body, as the platform fetch does.
  const hanging = (async (_url: unknown, init?: RequestInit) =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(sample.archive.subarray(0, 16));
          init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), {
            once: true,
          });
        },
      }),
    )) as typeof fetch;
  for (const name of ['stall', 'stop'] as const) {
    const home = join(root, name);
    mkdirSync(home, { mode: 0o700 });
    const controller = new AbortController();
    const started = performance.now();
    if (name === 'stop') setTimeout(() => controller.abort(), 50);
    const result = await installGoogleAcp(
      { home, consent: 'explicit', signal: controller.signal },
      {
        release: sample.release,
        fetch: hanging,
        stallMs: name === 'stall' ? 150 : 60_000,
        import: signed,
      },
    );
    assert.equal(result.reason, name === 'stall' ? 'stalled' : 'cancelled');
    assert.ok(performance.now() - started < 5_000);
    assert.equal(existsSync(join(home, 'providers/google-acp-v1/pin.json')), false);
  }
  // Steady progress keeps the install going past the stall time.
  const home = join(root, 'slow');
  mkdirSync(home, { mode: 0o700 });
  let sent = 0;
  const slow = (async () =>
    new Response(
      new ReadableStream({
        async pull(stream) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          const part = sample.archive.subarray(sent, sent + 64);
          sent += part.length;
          if (part.length) stream.enqueue(part);
          if (sent >= sample.archive.length) stream.close();
        },
      }),
    )) as typeof fetch;
  const started = performance.now();
  const result = await installGoogleAcp(
    { home, consent: 'explicit' },
    { release: sample.release, fetch: slow, stallMs: 120, import: signed },
  );
  assert.equal(result.reason, 'imported', JSON.stringify(result));
  assert.ok(performance.now() - started > 120);
});

test('a verified archive in the user cache serves a new home without a download', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'acp-cache-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sample = fixture();
  const cache = join(root, 'cache/crewkite');
  let downloads = 0;
  const dependencies = {
    release: sample.release,
    cache,
    fetch: (async () => {
      downloads++;
      return new Response(sample.archive);
    }) as typeof fetch,
    import: signed,
  };
  const install = async (name: string) => {
    const home = join(root, name);
    mkdirSync(home, { mode: 0o700 });
    return installGoogleAcp({ home, consent: 'explicit' }, dependencies);
  };
  assert.equal((await install('first')).reason, 'imported');
  assert.equal(downloads, 1);
  const kept = join(cache, `google-acp-${sample.release.sha256}.zip`);
  assert.deepEqual(readFileSync(kept), sample.archive);
  assert.equal(statSync(cache).mode & 0o777, 0o700);
  assert.equal(statSync(kept).mode & 0o777, 0o600);
  // A new home reuses the copy and still runs both signature checks on what it unpacks.
  const second = await install('second');
  assert.equal(second.reason, 'imported');
  assert.equal(downloads, 1);
  // A copy that fails the hash is removed and the install downloads again.
  const tampered = Buffer.from(sample.archive);
  tampered[40] ^= 1;
  chmodSync(kept, 0o600);
  writeFileSync(kept, tampered);
  assert.equal((await install('third')).reason, 'imported');
  assert.equal(downloads, 2);
  assert.deepEqual(readFileSync(kept), sample.archive);
  // A copy others can read is refused the same way.
  chmodSync(kept, 0o644);
  assert.equal((await install('fourth')).reason, 'imported');
  assert.equal(downloads, 3);
  assert.equal(statSync(kept).mode & 0o777, 0o600);
  // The cache sits outside the home and the home keeps no archive.
  for (const name of ['first', 'second', 'third', 'fourth'])
    assert.deepEqual(readdirSync(join(root, name, 'imports')), []);
});

test('the cache folder is the per-user cache directory', () => {
  assert.equal(
    googleAcpCacheDirectory({}, '/Users/someone', 'darwin'),
    '/Users/someone/Library/Caches/CrewKite',
  );
  assert.equal(
    googleAcpCacheDirectory({ XDG_CACHE_HOME: '/var/cache/someone' }, '/home/someone', 'linux'),
    '/var/cache/someone/crewkite',
  );
  assert.equal(
    googleAcpCacheDirectory({}, '/home/someone', 'linux'),
    '/home/someone/.cache/crewkite',
  );
});
