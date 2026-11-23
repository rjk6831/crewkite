import { execFile } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import {
  CLIENT_VERSIONS,
  type ManagedRecord,
  managedRecordFile,
  managedVersionOf,
  managedVersions,
  newerClientVersion,
  parseClientVersion,
  readManagedRecord,
} from './client-versions.ts';
import { ACP_SIGNATURE_MS, signaturePhase } from './google/acp/import.ts';
import { ACP_AGENT_ARGS, googleAcpDeveloperIdRequirement } from './google/acp/profile.ts';

// CrewKite's own copy of a provider client. When the vendor has published a build newer than
// every copy on the device, CrewKite fetches it into clients/<family>/<version> under its state
// root. Nothing here writes anywhere else, so a client the person installed stays as it is. A
// download is kept only when its macOS signature names the vendor's Developer ID team and, where
// the vendor publishes a checksum for that build, its bytes match it. No digest of one build lives
// here.
//
// Google publishes no checksum and no list of its builds I can read. The agent protocol's public
// registry lists Google's chat agent, but Google does not host it. So the registry only says which
// build is newest and what to start. The archive must come from Google's own download host, under
// the path the reviewed 1.4.0 archive uses, and every program in it must carry Google's signature.
// A wrong registry can at worst name another file Google signed. The entry's launch line is kept
// beside the copy in agent.json, and only with arguments I have read the meaning of.

export type ManagedFamily = 'openai' | 'anthropic' | 'google';

// file: the download is the client. npm: a package tarball with the native build inside.
// archive: a zip or gzip tar with the client and its helpers, started as cmd with args.
type Checksum = { algorithm: 'sha256' | 'sha512'; encoding: 'hex' | 'base64'; value: string };
type Published = { url: string } & (
  | { form: 'file' | 'npm'; hash: Checksum }
  // Google publishes no checksum for its archive. The signature is the trust rule there.
  | { form: 'archive'; hash?: undefined; cmd: string; args: readonly string[] }
);
type Read = (url: string) => Promise<Buffer>;
type Source = {
  vendor: string;
  /** The Developer ID team that signs the vendor's macOS builds. */
  team: string;
  /** The one host a fetch for this family may read metadata from. */
  host: string;
  /** The one host the build itself may come from, when it differs from the metadata host. */
  downloadHost?: string;
  latest: (read: Read) => Promise<string>;
  published: (read: Read, version: string) => Promise<Published>;
};

const json = (bytes: Buffer) => JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
const NPM = 'https://registry.npmjs.org/@openai%2fcodex';
const RELEASES = 'https://downloads.claude.ai/claude-code-releases';
// The native build inside the OpenAI platform package, the same path openAiNativeSibling reads.
const NPM_BUILD = 'package/vendor/aarch64-apple-darwin';
const REGISTRY = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
// The launch lines whose meaning I have read, the same list the launch checks. Any other argument
// could change what the agent may do, so an entry that names one is not fetched.
const GOOGLE_ARGS = ACP_AGENT_ARGS.map((args) => JSON.stringify(args));

const object = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Google's entry in the agent registry, strict on every field CrewKite uses and blind to the
 * rest. The entry is the one whose macOS arm64 archive sits on Google's download host. An ID or a
 * name in a registry Google does not host proves nothing. The entry's environment is never read,
 * and package manager entries are ignored: CrewKite runs no package manager for this.
 */
function googleEntry(bytes: Buffer) {
  const agents = object(json(bytes))?.agents;
  if (!Array.isArray(agents) || agents.length > 512 || !agents.every(object))
    throw new Error('registry');
  const found = agents.flatMap((agent: Record<string, unknown>) => {
    const binary = object(object(object(agent.distribution)?.binary)?.['darwin-aarch64']);
    let archive: URL;
    try {
      archive = new URL(String(binary?.archive));
    } catch {
      return [];
    }
    const google =
      typeof binary?.archive === 'string' &&
      archive.protocol === 'https:' &&
      archive.host === 'dl.google.com' &&
      !archive.username &&
      !archive.password &&
      archive.pathname.startsWith('/agy-extensions/releases/');
    return binary && google ? [{ agent, binary, archive }] : [];
  });
  if (found.length !== 1) throw new Error('registry');
  const [{ agent, binary, archive }] = found;
  const version = typeof agent.version === 'string' ? parseClientVersion(agent.version) : null;
  const { cmd, args = [] } = binary;
  const segments = typeof cmd === 'string' ? cmd.replace(/^\.\//, '').split('/') : [];
  if (
    !version ||
    version.text !== agent.version ||
    version.prerelease ||
    !/\.(zip|tar\.gz|tgz)$/.test(archive.pathname) ||
    typeof cmd !== 'string' ||
    cmd.length > 200 ||
    segments.some((segment) => !segment || segment === '..' || /[\\\0]/.test(segment)) ||
    !GOOGLE_ARGS.includes(JSON.stringify(args))
  )
    throw new Error('registry');
  return { version: version.text, archive: archive.href, cmd, args: args as string[] };
}

const SOURCES: Record<ManagedFamily, Source> = {
  // npm publishes the macOS arm64 build as its own version of the package, with a sha512
  // integrity hash per tarball. The binary inside carries OpenAI's Developer ID signature.
  openai: {
    vendor: 'OpenAI',
    team: '2DC432GLL2',
    host: 'registry.npmjs.org',
    latest: async (read) => String(json(await read(`${NPM}/latest`)).version),
    published: async (read, version) => {
      const dist = json(await read(`${NPM}/${version}-darwin-arm64`)).dist as
        | { tarball?: unknown; integrity?: unknown }
        | undefined;
      const integrity = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(String(dist?.integrity));
      if (!integrity || typeof dist?.tarball !== 'string') throw new Error('unpublished');
      return {
        url: dist.tarball,
        hash: { algorithm: 'sha512', encoding: 'base64', value: integrity[1] },
        form: 'npm',
      };
    },
  },
  // The release folder the client's own updater reads: a latest pointer, and per version a
  // manifest with a sha256 checksum for each platform's binary. The binary carries Anthropic's
  // Developer ID signature.
  anthropic: {
    vendor: 'Anthropic',
    team: 'Q6L2SF6YDW',
    host: 'downloads.claude.ai',
    latest: async (read) => (await read(`${RELEASES}/latest`)).toString('utf8').trim(),
    published: async (read, version) => {
      const platforms = json(await read(`${RELEASES}/${version}/manifest.json`)).platforms as
        | Record<string, { checksum?: unknown } | undefined>
        | undefined;
      const checksum = platforms?.['darwin-arm64']?.checksum;
      if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum))
        throw new Error('unpublished');
      return {
        url: `${RELEASES}/${version}/darwin-arm64/claude`,
        hash: { algorithm: 'sha256', encoding: 'hex', value: checksum },
        form: 'file',
      };
    },
  },
  // The agent registry's one Google entry names the version, the archive and the launch line. Both
  // reads below are the same GET, because a fetch reads each URL once.
  google: {
    vendor: 'Google',
    team: 'EQHXZ8M8AV',
    host: 'cdn.agentclientprotocol.com',
    downloadHost: 'dl.google.com',
    latest: async (read) => googleEntry(await read(REGISTRY)).version,
    published: async (read, version) => {
      const entry = googleEntry(await read(REGISTRY));
      if (entry.version !== version) throw new Error('unpublished');
      return { url: entry.archive, form: 'archive', cmd: entry.cmd, args: entry.args };
    },
  },
};

export type FetchOutcome =
  | { outcome: 'fetched'; version: string }
  /** Nothing newer is published, or the newer build already failed a check that would fail again. */
  | { outcome: 'current' }
  /** The download was dropped. The reason is one sentence for the card. */
  | { outcome: 'refused'; version: string; reason: string }
  /** No answer this time: another platform, the network, a stalled download. Nothing is recorded. */
  | { outcome: 'unavailable' };

export type FetchOptions = {
  /** CrewKite's own client folder, from `managedClientRoot`. */
  root: string;
  /** The newest version among the copies on the device. Only a later build is fetched. */
  installed: string;
  /** The version of the copy in use. A held copy of it is never pruned. */
  inUse?: string;
  /** The only network access. The controller passes the real one; every test passes its own. */
  fetch: typeof fetch;
  /** The time a record carries, as the controller's clock gives it. */
  now: () => string;
  /** Resolves when the file's signature names the team. Defaults to macOS codesign. */
  verify?: (executable: string, team: string) => Promise<void>;
  host?: { platform: string; arch: string };
  signal?: AbortSignal;
  /** How long the download may go without a byte before it stops. */
  stallMs?: number;
  /** How long the whole fetch may take, checks included. */
  totalMs?: number;
};

const METADATA_BYTES = 1024 * 1024;
const PACKAGE_BYTES = 512 * 1024 * 1024;
// The OpenAI package unpacks to about 325 MB. A tarball that claims more than this is refused
// before tar writes a byte of it.
const UNPACKED_BYTES = 1024 * 1024 * 1024;
const STALL_MS = 90_000;
const TOTAL_MS = 30 * 60_000;
const MACH_O = new Set([
  'feedface',
  'feedfacf',
  'cefaedfe',
  'cffaedfe',
  'cafebabe',
  'cafebabf',
  'bebafeca',
]);

/**
 * Every Mach-O file under a folder. The package brings helper programs and libraries beside the
 * client, and each of them runs too. A link that leaves the folder throws.
 */
export function machOFiles(folder: string, root = realpathSync(folder)): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) {
      if (!realpathSync(path).startsWith(`${root}/`)) throw new Error('link');
    } else if (entry.isDirectory()) found.push(...machOFiles(path, root));
    else if (entry.isFile()) {
      const magic = Buffer.alloc(4);
      const descriptor = openSync(path, 'r');
      try {
        readSync(descriptor, magic, 0, 4, 0);
      } finally {
        closeSync(descriptor);
      }
      if (MACH_O.has(magic.toString('hex'))) found.push(path);
    }
  }
  return found;
}

const execute = promisify(execFile);
const TOOL = { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 120_000 };

/** Throws once a gzip file inflates past the bound, before tar writes a byte of it. */
async function gunzipWithin(file: string, signal: AbortSignal) {
  let unpacked = 0;
  await pipeline(
    createReadStream(file),
    createGunzip(),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        unpacked += chunk.length;
        done(unpacked > UNPACKED_BYTES ? new Error('too-large') : null);
      },
    }),
    { signal },
  );
}

/** The bytes of every file under a folder. Links are counted as links and never followed. */
function folderBytes(folder: string): number {
  let total = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    total += entry.isDirectory() ? folderBytes(path) : lstatSync(path).size;
  }
  return total;
}

/** The same Developer ID requirement the Google bundle is checked against, for another team. */
export async function verifyDeveloperId(executable: string, team: string) {
  if (process.platform !== 'darwin') throw new Error('signature-refused');
  await signaturePhase(
    executable,
    [
      '--verify',
      '--strict',
      '--all-architectures',
      '-R',
      `=${googleAcpDeveloperIdRequirement(team)}`,
      executable,
    ],
    performance.now() + ACP_SIGNATURE_MS,
    {},
  );
}

export function writeRecord(root: string, family: ManagedFamily, record: ManagedRecord) {
  const file = managedRecordFile(root, family);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.next`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(`${file}.next`, file);
}

/**
 * Fetches the vendor's newest published build when it is later than every copy on the device,
 * checks it and places it beside the copy fetched before it. One earlier copy stays as the
 * fallback and older ones go. A build that fails a check is dropped and the record says why.
 */
export async function fetchNewerClient(
  family: ManagedFamily,
  options: FetchOptions,
): Promise<FetchOutcome> {
  const source = SOURCES[family];
  const command = CLIENT_VERSIONS[family].command;
  const host = options.host ?? process;
  // A Developer ID signature exists only on macOS, and arm64 is the build CrewKite runs there.
  if (host.platform !== 'darwin' || host.arch !== 'arm64') return { outcome: 'unavailable' };
  const stall = new AbortController();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => stall.abort(), options.stallMs ?? STALL_MS);
  };
  const signal = AbortSignal.any([
    stall.signal,
    AbortSignal.timeout(options.totalMs ?? TOTAL_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  const receive = async (
    url: string,
    host: string,
    maximum: number,
    hash?: Hash,
    path?: string,
  ) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.host !== host) throw new Error('host');
    watch();
    const response = await options.fetch(url, {
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error('unavailable');
    }
    const kept: Buffer[] = [];
    let size = 0;
    await pipeline(
      response.body,
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > maximum) return done(new Error('too-large'));
          watch();
          hash?.update(chunk);
          if (!path) kept.push(chunk);
          done(null, chunk);
        },
      }),
      path
        ? createWriteStream(path, { flags: 'wx', mode: 0o600 })
        : new Writable({ write: (_chunk, _encoding, done) => done() }),
      { signal },
    );
    return Buffer.concat(kept);
  };
  // Each URL is read once per fetch. Google's version and its archive come from one registry GET.
  const reads = new Map<string, Promise<Buffer>>();
  const read: Read = (url) => {
    const reply = reads.get(url) ?? receive(url, source.host, METADATA_BYTES);
    reads.set(url, reply);
    return reply;
  };
  const folder = join(options.root, family);
  let staging: string | undefined;
  let archive: string | undefined;
  try {
    const latest = parseClientVersion(await source.latest(read));
    // A prerelease is never what the vendor calls its latest build.
    if (!latest || latest.prerelease) return { outcome: 'unavailable' };
    const version = latest.text;
    const before = readManagedRecord(options.root, family);
    if (
      !newerClientVersion(version, options.installed) ||
      (before.notUsed?.sticky && before.notUsed.version === version) ||
      // A build the Google route refused would fail the same checks again. Its download would
      // have a new digest, so the version decides here.
      before.refused?.some((build) => build.version === version)
    )
      return { outcome: 'current' };
    // A download takes minutes. The route may record a refusal or a sign-in meanwhile, so each
    // write reads the record again and changes only what the fetch owns.
    const refuse = (reason: string, sticky: boolean): FetchOutcome => {
      writeRecord(options.root, family, {
        ...readManagedRecord(options.root, family),
        notUsed: { version, at: options.now(), reason, sticky },
      });
      return { outcome: 'refused', version, reason };
    };
    if (managedVersions(options.root, family).includes(version)) {
      // CrewKite holds this build and discovery, which just ran, did not pick it: its version
      // could not be read or it sits below the minimum. It goes like any refused build, so it
      // does not stand in the way of the next one.
      const outcome = refuse(
        'CrewKite holds this build and could not run it: its version could not be read or it is older than the minimum.',
        true,
      );
      rmSync(join(folder, version), { recursive: true, force: true });
      return outcome;
    }
    const published = await source.published(read, version);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // A fetch that a crash cut short left its folder behind. Only one fetch per family runs.
    for (const name of readdirSync(folder))
      if (name.startsWith('.fetch-')) rmSync(join(folder, name), { recursive: true, force: true });
    staging = mkdtempSync(join(folder, '.fetch-'));
    // An archive lands beside the staging folder, so no member it holds can write over it.
    const zip = published.form === 'archive' && new URL(published.url).pathname.endsWith('.zip');
    if (published.form === 'archive') archive = `${staging}${zip ? '.zip' : '.tgz'}`;
    const download = archive ?? join(staging, published.form === 'npm' ? '.package.tgz' : command);
    const hash = published.hash && createHash(published.hash.algorithm);
    await receive(
      published.url,
      source.downloadHost ?? source.host,
      published.form === 'file' ? CLIENT_VERSIONS[family].maximumBytes : PACKAGE_BYTES,
      hash,
      download,
    );
    // The stall bound is for the network. The unpack and each signature check have their own.
    clearTimeout(watchdog);
    if (published.hash && hash?.digest(published.hash.encoding) !== published.hash.value)
      // A cut download reads the same as a changed one, so the same version may be tried again.
      return refuse(
        `The download did not match the checksum ${source.vendor} publishes for it.`,
        false,
      );
    if (published.form === 'npm') {
      await gunzipWithin(download, signal);
      // tar refuses a member that leaves the folder or passes through a link.
      await execute(
        '/usr/bin/tar',
        ['-xzf', download, '-C', staging, '--strip-components=3', NPM_BUILD],
        { ...TOOL, signal },
      );
      rmSync(download);
      // Discovery reads clients/<family>/<version>/<command>. The package keeps it under bin.
      symlinkSync(join('bin', command), join(staging, command));
    } else if (published.form === 'archive') {
      // A zip states its unpacked size up front. A gzip tar is counted as it inflates.
      if (zip) {
        const listing = await execute('/usr/bin/zipinfo', ['-t', download], { ...TOOL, signal });
        const declared = /(\d+) bytes uncompressed/.exec(listing.stdout);
        if (!declared || Number(declared[1]) > UNPACKED_BYTES) throw new Error('too-large');
      } else await gunzipWithin(download, signal);
      // bsdtar reads zip and gzip tar alike, and refuses a member that leaves the folder.
      await execute('/usr/bin/tar', ['-xf', download, '-C', staging], { ...TOOL, signal });
      // shortcut: a zip that lies about its sizes can fill the disk until the 120 s bound.
      // Upgrade: count bytes while inflating, as install.ts does for the fixed archive.
      if (folderBytes(staging) > UNPACKED_BYTES) throw new Error('too-large');
    } else chmodSync(download, 0o500);
    const executable = realpathSync(
      join(staging, published.form === 'archive' ? published.cmd : command),
    );
    if (!executable.startsWith(`${realpathSync(staging)}/`) || !lstatSync(executable).isFile())
      return refuse('The download holds no client where the package keeps it.', true);
    let programs: string[];
    try {
      programs = [...new Set([executable, ...machOFiles(staging)])];
    } catch {
      return refuse('The download holds a link that leaves its own folder.', true);
    }
    try {
      // The client and every helper program and library beside it must name the vendor.
      for (const program of programs) {
        signal.throwIfAborted();
        await (options.verify ?? verifyDeveloperId)(program, source.team);
      }
    } catch (error) {
      // A check that ran out of time proves nothing about the signature.
      if (signal.aborted || (error instanceof Error && error.message !== 'signature-refused'))
        return { outcome: 'unavailable' };
      return refuse(
        `Its signature does not name the ${source.vendor} Developer ID team ${source.team}.`,
        true,
      );
    }
    if (published.form === 'archive') {
      // Discovery starts the copy with the entry's launch line, which only this file carries. A
      // file of that name from the archive is CrewKite's to replace.
      const launch = join(staging, 'agent.json');
      rmSync(launch, { recursive: true, force: true });
      writeFileSync(launch, `${JSON.stringify({ cmd: published.cmd, args: published.args })}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
    }
    rmSync(join(folder, version), { recursive: true, force: true });
    renameSync(staging, join(folder, version));
    const held = managedVersions(options.root, family).sort((left, right) =>
      newerClientVersion(left, right) ? -1 : 1,
    );
    for (const older of held.filter((name) => name !== version).slice(1))
      if (older !== options.inUse) rmSync(join(folder, older), { recursive: true, force: true });
    const current = readManagedRecord(options.root, family);
    writeRecord(options.root, family, {
      ...current,
      fetched: { version, at: options.now() },
      // A note the Google route wrote names its copy by digest and stays. Any other note was
      // about an earlier fetch.
      notUsed: current.notUsed?.sha256 ? current.notUsed : null,
    });
    return { outcome: 'fetched', version };
  } catch {
    return { outcome: 'unavailable' };
  } finally {
    clearTimeout(watchdog);
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (archive) rmSync(archive, { force: true });
  }
}

/**
 * A fetched build failed its connect-time read. It is removed and the record keeps the reason, so
 * discovery runs the next newest copy and the same build is not fetched again. False, and nothing
 * touched, when the file is not one of CrewKite's own copies.
 */
export function refuseManagedClient(
  root: string | null,
  family: ManagedFamily,
  executable: string,
  reason: string,
  now: () => string,
): boolean {
  if (!root) return false;
  const version = managedVersionOf(root, family, executable);
  if (!version) return false;
  try {
    // The record comes first. A crash between the two leaves a noted build to remove, never a
    // removed build nothing explains.
    writeRecord(root, family, {
      ...readManagedRecord(root, family),
      notUsed: { version, at: now(), reason: reason.slice(0, 300), sticky: true },
    });
    rmSync(join(root, family, version), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const strikes = new Map<string, number>();

/**
 * One rule for how a client's start counts against a build CrewKite fetched, for the chat turn
 * and the model read alike. A reason means the client itself failed a connect-time read: it
 * closed or crashed before it answered, or answered with a refusal. Null means the reads passed.
 * Stop, a deadline and a launch that never started are not reported here at all.
 *
 * The build goes on the second failure in a row. One failure can be a full disk or a home that
 * could not be written on that run, and removing a build is sticky. True when it was removed.
 */
export function connectReadEnded(
  root: string | null,
  family: ManagedFamily,
  executable: string,
  failure: string | null,
  now: () => string,
): boolean {
  if (!root) return false;
  const version = managedVersionOf(root, family, executable);
  if (!version) return false;
  const key = `${root}\0${family}\0${version}`;
  if (failure === null || !strikes.has(key)) {
    if (failure === null) strikes.delete(key);
    else strikes.set(key, 1);
    return false;
  }
  strikes.delete(key);
  return refuseManagedClient(root, family, executable, failure, now);
}
