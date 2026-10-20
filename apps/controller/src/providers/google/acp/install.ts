import { createHash } from 'node:crypto';
import {
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { type AcpImportDependencies, type AcpImportResult, importGoogleAcp } from './import.ts';
import { readGoogleAcpPin, validateAcpDirectory } from './profile.ts';

type ReleaseFile = { name: string; bytes: number; compressed: number; sha256: string };
type Release = { url: string; bytes: number; sha256: string; files: readonly ReleaseFile[] };
const release: Release = {
  url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-darwin-arm64.zip',
  bytes: 112734313,
  sha256: '21a32eeab85b394a515510c84539bda4b2504bf2917e0a201f5c4130b13581a5',
  files: [
    {
      name: 'agy_acp_server.par',
      bytes: 280980064,
      compressed: 74043015,
      sha256: '34e0cd2fe6fcafc4b280a81d38026c55689e54c0619c6729a781f1ebfefa1d88',
    },
    {
      name: 'localharness_external',
      bytes: 120246928,
      compressed: 38690942,
      sha256: 'e7d236a0761ef904cee649e6f42e56861ca953457f8f62bcd0cdf649640d0ff5',
    },
  ],
};
export type AcpInstallResult = (
  | AcpImportResult
  | {
      imported: false;
      reason: 'download-unavailable' | 'archive-refused' | 'cancelled' | 'install-unavailable';
      client: null;
    }
) & { cleanupReason?: 'temporary-cleanup-failed' };
export type AcpInstallDependencies = {
  fetch?: typeof fetch;
  release?: Release;
  import?: AcpImportDependencies;
};

function verifier(expected: { bytes: number; sha256: string }) {
  let length = 0;
  const hash = createHash('sha256');
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      length += chunk.length;
      if (length > expected.bytes) return done(Error('archive-refused'));
      hash.update(chunk);
      done(null, chunk);
    },
    flush(done) {
      done(
        length === expected.bytes && hash.digest('hex') === expected.sha256
          ? null
          : Error('archive-refused'),
      );
    },
  });
}

/** The frozen archive hash is checked before this two-entry layout is read or inflated. */
async function extract(path: string, target: string, expected: Release, signal: AbortSignal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await file.stat()).size !== expected.bytes) throw Error('archive-refused');
    const read = async (at: number, size: number) => {
      signal.throwIfAborted();
      const bytes = Buffer.alloc(size);
      const result = await file.read(bytes, 0, size, at);
      if (result.bytesRead !== size) throw Error('archive-refused');
      return bytes;
    };
    const end = await read(expected.bytes - 22, 22);
    if (
      end.readUInt32LE(0) !== 0x06054b50 ||
      end.readUInt16LE(4) !== 0 ||
      end.readUInt16LE(6) !== 0 ||
      end.readUInt16LE(8) !== 2 ||
      end.readUInt16LE(10) !== 2 ||
      end.readUInt16LE(20) !== 0
    )
      throw Error('archive-refused');
    const centralAt = end.readUInt32LE(16);
    const centralSize = end.readUInt32LE(12);
    if (centralAt + centralSize !== expected.bytes - 22 || centralSize > 1024)
      throw Error('archive-refused');
    let localAt = 0;
    let directoryAt = centralAt;
    const entries: { start: number; file: ReleaseFile }[] = [];
    if (
      expected.files.length !== 2 ||
      expected.files[0].name !== 'agy_acp_server.par' ||
      expected.files[1].name !== 'localharness_external'
    )
      throw Error('archive-refused');
    for (const entry of expected.files) {
      const local = await read(localAt, 30);
      const central = await read(directoryAt, 46);
      const nameBytes = Buffer.byteLength(entry.name);
      const localExtra = local.readUInt16LE(28);
      const centralExtra = central.readUInt16LE(30);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(6) !== 0 ||
        local.readUInt16LE(8) !== 8 ||
        local.readUInt32LE(18) !== entry.compressed ||
        local.readUInt32LE(22) !== entry.bytes ||
        local.readUInt16LE(26) !== nameBytes ||
        localExtra > 128 ||
        central.readUInt32LE(0) !== 0x02014b50 ||
        central.readUInt16LE(8) !== 0 ||
        central.readUInt16LE(10) !== 8 ||
        central.readUInt32LE(16) !== local.readUInt32LE(14) ||
        central.readUInt32LE(20) !== entry.compressed ||
        central.readUInt32LE(24) !== entry.bytes ||
        central.readUInt16LE(28) !== nameBytes ||
        centralExtra > 128 ||
        central.readUInt16LE(32) !== 0 ||
        central.readUInt16LE(34) !== 0 ||
        ((central.readUInt32LE(38) >>> 16) & 0xf000) !== 0x8000 ||
        central.readUInt32LE(42) !== localAt
      )
        throw Error('archive-refused');
      if (
        !(await read(localAt + 30, nameBytes)).equals(Buffer.from(entry.name)) ||
        !(await read(directoryAt + 46, nameBytes)).equals(Buffer.from(entry.name))
      )
        throw Error('archive-refused');
      const start = localAt + 30 + nameBytes + localExtra;
      localAt = start + entry.compressed;
      if (localAt > centralAt) throw Error('archive-refused');
      entries.push({ start, file: entry });
      directoryAt += 46 + nameBytes + centralExtra;
    }
    if (localAt !== centralAt || directoryAt !== expected.bytes - 22)
      throw Error('archive-refused');
    for (const entry of entries) {
      await pipeline(
        createReadStream(path, {
          fd: file.fd,
          autoClose: false,
          start: entry.start,
          end: entry.start + entry.file.compressed - 1,
        }),
        createInflateRaw(),
        verifier(entry.file),
        createWriteStream(join(target, entry.file.name), { flags: 'wx', mode: 0o600 }),
        { signal },
      );
    }
  } finally {
    await file.close();
  }
}

/** Installation pins only the reviewed release. Authentication remains a separate action. */
export async function installGoogleAcp(
  options: { home: string; consent: 'explicit'; signal?: AbortSignal },
  dependencies: AcpInstallDependencies = {},
): Promise<AcpInstallResult> {
  const refused = (
    reason: Exclude<AcpInstallResult['reason'], AcpImportResult['reason']>,
  ): AcpInstallResult => ({ imported: false, reason, client: null });
  const expected = dependencies.release ?? release;
  const signal = AbortSignal.any([
    AbortSignal.timeout(180000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let temporary: string | undefined;
  let failure: 'download-unavailable' | 'archive-refused' | 'install-unavailable' =
    'install-unavailable';
  const run = async (): Promise<AcpInstallResult> => {
    try {
      signal.throwIfAborted();
      if (options.consent !== 'explicit') return refused('install-unavailable');
      validateAcpDirectory(options.home);
      if (existsSync(join(options.home, 'providers/google-acp-v1/pin.json'))) {
        try {
          const client = readGoogleAcpPin(options.home);
          return client.version === '1.4.0' &&
            client.signerTeamId === 'EQHXZ8M8AV' &&
            client.sha256 === expected.files[0]?.sha256 &&
            client.harnessSha256 === expected.files[1]?.sha256
            ? { imported: true, reason: 'already-imported', client }
            : { imported: false, reason: 'pin-conflict', client: null };
        } catch {
          return { imported: false, reason: 'pin-conflict', client: null };
        }
      }
      const imports = join(options.home, 'imports');
      if (!existsSync(imports)) mkdirSync(imports, { mode: 0o700 });
      validateAcpDirectory(imports, options.home);
      temporary = mkdtempSync(join(imports, '.google-acp-install-'));
      const archive = join(temporary, 'release.zip');
      failure = 'download-unavailable';
      const response = await (dependencies.fetch ?? fetch)(expected.url, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Accept-Encoding': 'identity' },
      });
      const encoding = response.headers.get('content-encoding');
      if (
        (encoding !== null && encoding !== 'identity') ||
        !response.ok ||
        response.status !== 200 ||
        !response.body ||
        (response.headers.has('content-length') &&
          response.headers.get('content-length') !== String(expected.bytes))
      ) {
        await response.body?.cancel();
        return refused('download-unavailable');
      }
      failure = 'archive-refused';
      await pipeline(
        response.body,
        verifier(expected),
        createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      await extract(archive, temporary, expected, signal);
      signal.throwIfAborted();
      failure = 'install-unavailable';
      unlinkSync(archive);
      writeFileSync(
        join(temporary, 'identity.json'),
        JSON.stringify({
          version: '1.4.0',
          sha256: expected.files[0]?.sha256,
          harnessSha256: expected.files[1]?.sha256,
          signerTeamId: 'EQHXZ8M8AV',
        }),
        { flag: 'wx', mode: 0o600 },
      );
      signal.throwIfAborted();
      const lifecycle = dependencies.import?.lifecycle;
      const verify = dependencies.import?.verifySignature;
      const imported = await importGoogleAcp(
        { home: options.home, consent: 'explicit', installerStaging: temporary },
        {
          ...dependencies.import,
          ...(verify
            ? {
                verifySignature: async (input: Parameters<typeof verify>[0]) => {
                  signal.throwIfAborted();
                  const receipt = await verify(input);
                  signal.throwIfAborted();
                  return receipt;
                },
              }
            : {}),
          lifecycle: {
            beforePhase: () => {
              signal.throwIfAborted();
              lifecycle?.beforePhase();
            },
            owned: (group) => lifecycle?.owned(group),
            quiescent: (group) => {
              lifecycle?.quiescent(group);
              signal.throwIfAborted();
            },
          },
        },
      );
      return imported.imported || imported.reason === 'ownership'
        ? imported
        : signal.aborted
          ? refused('cancelled')
          : imported;
    } catch {
      return refused(signal.aborted ? 'cancelled' : failure);
    }
  };
  const result = await run();
  try {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  } catch {
    return { ...result, cleanupReason: 'temporary-cleanup-failed' };
  }
  return result;
}
