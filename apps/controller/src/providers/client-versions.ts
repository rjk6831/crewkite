import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ClientVersionState, ClientVersionStatus } from '@crewkite/contracts';
import { timed } from '../diagnostics/timing.ts';
import { clientRecord } from './client-record.ts';
import { fileDigestSync } from './file-digest.ts';
import { platformGate } from './platform.ts';

// The chat path and the Google quota reader accept a range of client builds (ADR 0009, amendment
// of 2026-10-31). The writer profiles keep their exact digest pins. Each row names the build I
// tested, the oldest build CrewKite accepts and the command that updates the client.
export const CLIENT_VERSIONS = {
  openai: {
    name: 'Codex',
    command: 'codex',
    tested: '0.163.0',
    // For this client the version is information (ADR 0048). Every build runs; the replies and the
    // connect-time probe decide what a turn may use. checkedOn is the day the protocol check last
    // passed against the tested build. 0.133.0 is the oldest build whose read-only turns read
    // through a permission profile; older ones ask before each command.
    checkedOn: '2 Nov 2026',
    information: true,
    minimum: '0.133.0',
    update: 'npm install -g @openai/codex@latest',
    maximumBytes: 256 * 1024 * 1024,
    environment: {},
    // Codex finds its home from CODEX_HOME, else ~/.codex, and may create or touch it on any run.
    // The version read gets an empty private folder of its own, so it never reaches the person's
    // ~/.codex. CrewKite's own Codex home may not exist yet when the client is first found.
    privateHome: 'CODEX_HOME',
  },
  anthropic: {
    name: 'Claude Code',
    command: 'claude',
    tested: '2.1.316',
    // checkedOn is the day the protocol check last passed against the tested build.
    checkedOn: '3 Nov 2026',
    // 2.1.259 is the first build with --permission-prompts, which the usage read and the writer
    // pass. An older build answers the flag with an unknown option error. Optional flags are
    // probed per build, so a later build that drops one still runs.
    minimum: '2.1.259',
    update: 'claude update',
    maximumBytes: 512 * 1024 * 1024,
    environment: { DISABLE_UPDATES: '1', DISABLE_AUTOUPDATER: '1' },
  },
  google: {
    name: 'Antigravity CLI',
    command: 'agy',
    tested: '1.4.2',
    // 1.4.0 is the oldest build on record that ran a zero-turn -p metadata command with JSON
    // output. The pinned ACP bundle is separate and keeps its own exact digests.
    minimum: '1.4.0',
    update: 'agy update',
    maximumBytes: 256 * 1024 * 1024,
    environment: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  },
} as const;
export type ClientFamily = keyof typeof CLIENT_VERSIONS;
type Row = (typeof CLIENT_VERSIONS)[ClientFamily];

type Version = { core: [number, number, number]; prerelease: string | null; text: string };

// A client can print a notice about a newer release next to its own version. Those lines name
// someone else's version, so they never count.
const NOTICE = /update|available|latest/i;

/**
 * The first version in a client's own version output: `codex-cli 0.170.2`, `2.1.302 (Claude
 * Code)`, `v1.4.2`. Lines that announce an update are skipped, unless every line does; then the
 * first version on the first line counts. A prerelease suffix stays with the version; build
 * metadata is dropped.
 */
export function parseClientVersion(output: string): Version | null {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  const kept = lines.filter((line) => !NOTICE.test(line));
  // A client that prints its version and the notice on one line leaves only notices. Its own
  // version then comes first on the first line.
  const own = (kept.length ? kept : lines.slice(0, 1)).join('\n');
  const match =
    /(?:^|[\s(@/])v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?(?=$|[\s),;])/m.exec(
      own,
    );
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  const prerelease = match[4]?.slice(1) ?? null;
  return { core, prerelease, text: `${core.join('.')}${prerelease ? `-${prerelease}` : ''}` };
}

/**
 * Negative when left is older, by semantic versioning: a prerelease ranks below its own release,
 * and prerelease identifiers compare one by one, numbers by value and below any word, words in
 * ASCII order, a shorter list first when the rest are equal.
 */
function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index++)
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const a = left.prerelease.split('.');
  const b = right.prerelease.split('.');
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const x = /^\d+$/.test(a[index]) ? Number(a[index]) : null;
    const y = /^\d+$/.test(b[index]) ? Number(b[index]) : null;
    if (x !== null && y !== null) {
      if (x !== y) return x - y;
    } else if (x !== null) return -1;
    else if (y !== null) return 1;
    else if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Where a reported version stands against the family's tested build and minimum. A later major
 * version is refused: the adapters parse each client's native frames, and a major release is
 * where those change without notice. Under major 0 a newer minor is still accepted as newer,
 * because one client ships a new 0.minor about every week.
 */
export function clientVersionState(
  reported: string | null,
  row: { tested: string; minimum: string },
): Extract<
  ClientVersionState,
  'tested' | 'newer' | 'supported' | 'older' | 'new-major' | 'unreadable'
> {
  const version = reported === null ? null : parseClientVersion(reported);
  const tested = parseClientVersion(row.tested);
  const minimum = parseClientVersion(row.minimum);
  if (!tested || !minimum) throw new Error('The client version table is invalid.');
  if (!version) return 'unreadable';
  if (compare(version, minimum) < 0) return 'older';
  if (version.core[0] > tested.core[0]) return 'new-major';
  const order = compare(version, tested);
  return order === 0 ? 'tested' : order > 0 ? 'newer' : 'supported';
}

const ACCEPTED = new Set<ClientVersionState>(['tested', 'newer', 'supported']);

/** The reader reason code for a client CrewKite does not run. */
export function clientStatusReason(
  status: ClientVersionStatus,
):
  | 'client-unavailable'
  | 'client-untrusted'
  | 'client-version-unreadable'
  | 'client-version-unsupported' {
  switch (status.state) {
    case 'untrusted':
      return 'client-untrusted';
    case 'unreadable':
      return 'client-version-unreadable';
    case 'older':
    case 'new-major':
      return 'client-version-unsupported';
    default:
      return 'client-unavailable';
  }
}

/** The line Settings and the CLI show for a found client, in plain words. */
export function clientVersionStatus(
  family: ClientFamily,
  found:
    | { state: 'missing' | 'unavailable'; detail?: string }
    | { state: 'untrusted'; path: string; why: 'shared-write' | 'shared-folder' | 'foreign-owner' }
    | { state: 'version'; path: string; version: string | null }
    | { state: 'pinned'; version: string },
): ClientVersionStatus {
  const row = CLIENT_VERSIONS[family];
  const parsed =
    found.state === 'version' || found.state === 'pinned'
      ? parseClientVersion(found.version ?? '')
      : null;
  // A pinned writer profile matched the tested build by its digest, so it is the tested build.
  const state: ClientVersionState =
    found.state === 'pinned'
      ? 'tested'
      : found.state === 'version'
        ? clientVersionState(found.version, row)
        : found.state;
  const version = parsed?.text ?? (found.state === 'pinned' ? found.version : null);
  const tested = parseClientVersion(row.tested)?.core[0] ?? 0;
  const checked = 'checkedOn' in row ? `Checked with ${row.tested} on ${row.checkedOn}` : null;
  // A row marked as information accepts every build and says what the probe decides. Other rows
  // refuse a build below the minimum and a new major version.
  const information = 'information' in row;
  const informed = information && (state === 'older' || state === 'new-major' || state === 'newer');
  const message = (() => {
    if (information && checked !== null)
      switch (state) {
        // The found build is the checked build, so the line names it once.
        case 'tested':
          return `${row.name} ${version} found, checked on ${'checkedOn' in row ? row.checkedOn : ''}.`;
        case 'supported':
          return `${row.name} ${version} found. ${checked}; builds from ${row.minimum} on are supported.`;
        case 'newer':
        case 'new-major':
          return `${row.name} ${version} found. ${checked}; this build is newer than the last checked build.`;
        case 'older':
          return `${row.name} ${version} found. ${checked}; this build is older than ${row.minimum}, so read-only turns ask before each command.`;
      }
    switch (state) {
      case 'tested':
        return 'checkedOn' in row
          ? `${row.name} ${version} found, checked on ${row.checkedOn}.`
          : `${row.name} ${version} found, the tested build.`;
      case 'newer':
        return `${row.name} ${version} found. ${checked ?? `Tested with ${row.tested}`}; a newer build runs while its flags and replies match what CrewKite sends.`;
      case 'supported':
        return `${row.name} ${version} found. ${checked ?? `Tested with ${row.tested}`}; builds from ${row.minimum} on are supported.`;
      case 'older':
        return `${row.name} ${version} is older than the minimum ${row.minimum}. Update it with ${row.update}, then press Check again.`;
      case 'new-major':
        return `${row.name} ${version} found. CrewKite is tested with ${row.tested} and does not run a new major version yet. Install a ${tested}.x build, or update CrewKite.`;
      case 'unreadable':
        return `CrewKite could not read the version of ${row.name} at ${found.state === 'version' ? found.path : row.command}. Run ${row.command} --version in a terminal to see why, then check again.`;
      case 'untrusted': {
        const path = found.state === 'untrusted' ? found.path : row.command;
        const why = found.state === 'untrusted' ? found.why : 'shared-write';
        return why === 'foreign-owner'
          ? `${row.name} at ${path} belongs to another account, so CrewKite will not run it.`
          : why === 'shared-folder'
            ? `${row.name} at ${path} is in a folder other users can change, so CrewKite will not run it.`
            : `${row.name} at ${path} can be changed by other users, so CrewKite will not run it.`;
      }
      case 'missing':
        return `${row.name} was not found. Install it and sign in, then check again.`;
      default:
        return found.state === 'unavailable' && found.detail
          ? found.detail
          : `${row.name} cannot run on this computer.`;
    }
  })();
  return {
    state,
    accepted: informed || ACCEPTED.has(state),
    version,
    tested: row.tested,
    minimum: row.minimum,
    message: message.slice(0, 1024),
    ...('checkedOn' in row ? { checkedOn: row.checkedOn } : {}),
    ...recordFields(family, version),
  };
}

/** What the client reported about itself, for the build found. */
function recordFields(family: ClientFamily, version: string | null) {
  const record = clientRecord(family, version);
  return {
    ...(record?.capabilities.length ? { capabilities: [...record.capabilities] } : {}),
    ...(record?.probe ? { probe: record.probe } : {}),
  };
}

/**
 * The file is a bounded regular file that the current user or the system owns, that neither its
 * group nor other users can write, in a folder other users cannot write. A link counts by the
 * file it resolves to.
 */
export function clientFileTrust(
  stat: Pick<Stats, 'isFile' | 'size' | 'uid' | 'mode'>,
  maximumBytes: number,
  uid = process.getuid?.(),
  folder?: Pick<Stats, 'mode'>,
): 'trusted' | 'not-a-client' | 'shared-write' | 'shared-folder' | 'foreign-owner' {
  if (!stat.isFile() || stat.size > maximumBytes) return 'not-a-client';
  if (stat.uid !== uid && stat.uid !== 0) return 'foreign-owner';
  if (stat.mode & 0o022) return 'shared-write';
  if (folder && folder.mode & 0o002) return 'shared-folder';
  return 'trusted';
}

/**
 * The folder a client was found in, before any link is followed. Other users must not be able to
 * write it, unless it has the sticky bit and the entry belongs to the person or the system, as in
 * a shared temporary folder where nobody can replace another user's file.
 */
export function foundLocationTrust(
  folder: Pick<Stats, 'mode'>,
  entry: Pick<Stats, 'uid'>,
  uid = process.getuid?.(),
): 'trusted' | 'shared-folder' {
  if (!(folder.mode & 0o002)) return 'trusted';
  if (folder.mode & 0o1000 && (entry.uid === uid || entry.uid === 0)) return 'trusted';
  return 'shared-folder';
}

type Read = {
  key: string;
  version: string | null;
  sha256: string;
  at: number;
  /** Unreadable reads in a row of this same file. */
  failures: number;
};
export type ClientReads = Map<string, Read>;
const identity = (stat: Stats) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const reads: ClientReads = new Map();
// An unreadable version is read again after a minute, then after twice as long each time up to
// fifteen minutes, so a client that hangs on --version costs its timeout rarely. A changed file
// or Check again reads at once.
const UNREADABLE_RETRY_MS = 60_000;
const UNREADABLE_RETRY_MAX_MS = 15 * 60_000;
export function unreadableRetryMs(failures: number) {
  return Math.min(UNREADABLE_RETRY_MAX_MS, UNREADABLE_RETRY_MS * 2 ** Math.max(0, failures - 1));
}

/** Check again: the next resolution of this family reads every file afresh. */
export function forgetClientReads(family: ClientFamily, cache: ClientReads = reads) {
  for (const key of [...cache.keys()]) if (key.startsWith(`${family}\0`)) cache.delete(key);
}

export type FoundClient = {
  status: ClientVersionStatus;
  client?: { executable: string; sha256: string; version: string };
};

export type FindOptions = {
  /** Directories in search order. Tests pass their own. */
  directories: readonly string[];
  home: string;
  path?: string;
  /** Extra candidates beside a found entry, as the OpenAI package keeps its native binary. */
  siblings?: (entry: string) => string[];
  cache?: ClientReads;
  now?: () => number;
  timeoutMs?: number;
  /** Reads the file for its digest. Tests pass one that fails. */
  hash?: (path: string) => string;
  /**
   * Use only versions already read. A file that needs a fresh read counts as unreadable and is
   * not run, for callers inside a database transaction.
   */
  cachedOnly?: boolean;
};

/**
 * The first trusted client in the search directories whose version CrewKite accepts. The real
 * path, owner and mode checks run before the client does. The version comes from the client's
 * own --version flag in its own process group, with no input, a minimal environment and a time
 * bound. When no build is accepted, the first one found explains why.
 */
export function findClient(family: ClientFamily, options: FindOptions): FoundClient {
  const row = CLIENT_VERSIONS[family];
  const cache = options.cache ?? reads;
  const now = options.now ?? Date.now;
  let first: FoundClient | null = null;
  const seen = new Set<string>();
  for (const directory of new Set(options.directories.filter(isAbsolute))) {
    const location = join(directory, row.command);
    let entry: string;
    try {
      // Where the client was found counts too: anyone who can write that folder can place a link
      // there to any trusted binary, and CrewKite would then run it.
      if (
        foundLocationTrust(lstatSync(directory), lstatSync(location), process.getuid?.()) !==
        'trusted'
      ) {
        first ??= {
          status: clientVersionStatus(family, {
            state: 'untrusted',
            path: location,
            why: 'shared-folder',
          }),
        };
        continue;
      }
      entry = realpathSync(location);
    } catch {
      continue;
    }
    for (const candidate of [...(options.siblings?.(entry) ?? []), entry]) {
      let found: FoundClient | null;
      try {
        found = inspect(family, candidate, seen, options, cache, now);
      } catch {
        // Nothing about one candidate may stop the search or the caller.
        found = null;
      }
      if (!found) continue;
      if (found.client) return found;
      first ??= found;
    }
  }
  return first ?? { status: clientVersionStatus(family, { state: 'missing' }) };
}

/** One candidate: null to skip it, a status that refuses it, or an accepted client. */
function inspect(
  family: ClientFamily,
  candidate: string,
  seen: Set<string>,
  options: FindOptions,
  cache: ClientReads,
  now: () => number,
): FoundClient | null {
  const row = CLIENT_VERSIONS[family];
  let executable: string;
  let stat: Stats;
  let folder: Stats;
  try {
    executable = realpathSync(candidate);
    stat = lstatSync(executable);
    folder = lstatSync(dirname(executable));
  } catch {
    return null;
  }
  if (seen.has(executable)) return null;
  seen.add(executable);
  const trust = clientFileTrust(stat, row.maximumBytes, process.getuid?.(), folder);
  if (trust === 'not-a-client') return null;
  if (trust !== 'trusted')
    return {
      status: clientVersionStatus(family, { state: 'untrusted', path: executable, why: trust }),
    };
  const key = identity(stat);
  const slot = `${family}\0${executable}`;
  let read = cache.get(slot);
  if (
    !read ||
    read.key !== key ||
    (read.version === null && now() - read.at >= unreadableRetryMs(read.failures))
  ) {
    if (options.cachedOnly)
      return {
        status: clientVersionStatus(family, { state: 'version', path: executable, version: null }),
      };
    const failures = read?.key === key ? read.failures : 0;
    // The digest is taken before the client runs. A file CrewKite cannot read, such as one that
    // is execute-only or that an update removed a moment ago, has no version.
    let sha256: string | null = null;
    try {
      sha256 = (options.hash ?? digest)(executable);
    } catch {}
    let version = sha256 === null ? null : readVersion(executable, row, options);
    // A file that changed while it ran keeps no version, so the version and the digest describe
    // the same bytes. A swap that lands after this check is caught when the launch hashes again.
    try {
      if (identity(lstatSync(executable)) !== key) version = null;
    } catch {
      version = null;
    }
    read = {
      key,
      version,
      sha256: sha256 ?? '',
      at: now(),
      failures: version === null ? failures + 1 : 0,
    };
    cache.set(slot, read);
  }
  const status = clientVersionStatus(family, {
    state: 'version',
    path: executable,
    version: read.version,
  });
  return status.accepted && read.sha256
    ? {
        status,
        client: { executable, sha256: read.sha256, version: status.version ?? row.tested },
      }
    : { status };
}

// The profiles and every launch read the same digest cache, so a build is hashed once per file
// identity whichever of them sees it first.
const digest = (path: string) => fileDigestSync(path);

// shortcut: the read is synchronous, so a client that ignores the bound blocks the controller for
// up to the timeout once per changed build. The result is cached by the file's identity. An
// asynchronous read with a pending state is the upgrade path if a client ever needs it.
function readVersion(executable: string, row: Row, options: FindOptions): string | null {
  let home: string | undefined;
  if ('privateHome' in row)
    try {
      // mkdtemp creates the folder with mode 0700.
      home = mkdtempSync(join(tmpdir(), 'crewkite-version-'));
    } catch {
      return null;
    }
  try {
    return runVersion(executable, row, options, home);
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
  }
}

function runVersion(
  executable: string,
  row: Row,
  options: FindOptions,
  home: string | undefined,
): string | null {
  // Node honors detached for spawnSync, which puts the client in its own group; the types omit it.
  const spawnOptions: SpawnSyncOptionsWithStringEncoding & { detached: true } = {
    cwd: '/',
    env: {
      HOME: options.home,
      // A client installed as a script finds its interpreter on the person's PATH.
      PATH: options.path || '/usr/bin:/bin',
      LANG: 'C',
      NO_COLOR: '1',
      ...row.environment,
      ...('privateHome' in row && home ? { [row.privateHome]: home } : {}),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 5000,
    killSignal: 'SIGKILL',
    maxBuffer: 4096,
    encoding: 'utf8',
  };
  let result: SpawnSyncReturns<string>;
  try {
    result = timed(`spawnSync ${row.command} --version`, () =>
      spawnSync(executable, ['--version'], spawnOptions),
    );
  } catch {
    return null;
  }
  // The client ran in its own group. Anything it left behind goes with it. A child that calls
  // setsid leaves the group and escapes this kill; --version has no reason to, and every later
  // launch of the client runs under the adapters' own ownership checks.
  if (result.pid > 0)
    try {
      process.kill(-result.pid, 'SIGKILL');
    } catch {}
  if (result.error || result.status !== 0) return null;
  return parseClientVersion(result.stdout)?.text ?? null;
}

/**
 * The directories the profiles search for a family, in their order: the person's PATH, then fixed
 * install locations. macOS keeps Homebrew and /usr/local. Linux adds ~/.local/bin for the native
 * installers and a user-prefix npm install, /usr/local/bin for a global npm install and /usr/bin
 * for a distribution package. No other directory is searched.
 */
export function clientDirectories(
  family: ClientFamily,
  environment: NodeJS.ProcessEnv,
  host: { platform: string } = process,
): string[] {
  const path = (environment.PATH ?? '').split(':').filter(isAbsolute);
  const local = environment.HOME ? [join(environment.HOME, '.local/bin')] : [];
  if (host.platform === 'linux') return [...path, ...local, '/usr/local/bin', '/usr/bin'];
  return family === 'openai'
    ? [...path, '/opt/homebrew/bin', '/usr/local/bin']
    : [...path, ...local, '/opt/homebrew/bin', '/usr/local/bin'];
}

/** The npm package keeps the native binary beside its script entry. */
export function openAiNativeSibling(
  entry: string,
  host: { platform: string; arch: string } = process,
): string[] {
  const native =
    host.platform !== 'linux'
      ? '@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
      : host.arch === 'x64'
        ? '@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
        : host.arch === 'arm64'
          ? '@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex'
          : null;
  return native ? [join(dirname(dirname(entry)), 'node_modules', native)] : [];
}

/** The gates every resolution shares with the profiles: platform and the person's own home. */
export function clientHostGate(
  family: ClientFamily,
  environment: NodeJS.ProcessEnv,
  host: { platform: string; arch: string } = process,
): { reason: 'unsupported-platform' | 'native-home-unavailable'; detail: string } | null {
  const name = CLIENT_VERSIONS[family].name;
  const platform = platformGate(family, host);
  if (!platform.allowed) return { reason: 'unsupported-platform', detail: platform.line };
  if (!environment.HOME || environment.HOME !== userInfo().homedir)
    return {
      reason: 'native-home-unavailable',
      detail: `${name} needs HOME set to your own home folder.`,
    };
  return null;
}
