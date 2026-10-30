import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ClientVersionState, ClientVersionStatus } from '@crewkite/contracts';

// The chat path and the Google quota reader accept a range of client builds (ADR 0009, amendment
// of 2026-10-31). The writer profiles keep their exact digest pins. Each row names the build I
// tested, the oldest build CrewKite accepts and the command that updates the client.
export const CLIENT_VERSIONS = {
  openai: {
    name: 'Codex',
    command: 'codex',
    tested: '0.163.0',
    // The launch passes --strict-config with settings keys the tested build reads, and a build
    // that lacks one of them exits before it answers initialize. No older build has a run.
    minimum: '0.163.0',
    update: 'npm install -g @openai/codex@latest',
    maximumBytes: 256 * 1024 * 1024,
    environment: {},
  },
  anthropic: {
    name: 'Claude Code',
    command: 'claude',
    tested: '2.1.302',
    // The stream-json control protocol, --setting-sources and the attribution settings the turn
    // passes all predate the 2.1 line.
    minimum: '2.1.0',
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

/**
 * The first version in a client's own version output: `codex-cli 0.170.2`, `2.1.302 (Claude
 * Code)`, `v1.4.2`. A prerelease suffix stays with it; build metadata is dropped.
 */
export function parseClientVersion(output: string): Version | null {
  const match =
    /(?:^|[\s(@/])v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?(?=$|[\s),;])/m.exec(
      output,
    );
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  const prerelease = match[4]?.slice(1) ?? null;
  return { core, prerelease, text: `${core.join('.')}${prerelease ? `-${prerelease}` : ''}` };
}

/** Negative when left is older. A prerelease ranks below its own release. */
function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index++)
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * Where a reported version stands against the family's tested build and minimum. A later major
 * version is refused: the adapters parse each client's native frames, and a major release is
 * where those change without notice.
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

/** The line Settings and the CLI show for a found client, in plain words. */
export function clientVersionStatus(
  family: ClientFamily,
  found:
    | { state: 'missing' | 'unavailable'; detail?: string }
    | { state: 'untrusted'; path: string; why: 'shared-write' | 'foreign-owner' }
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
  const message = (() => {
    switch (state) {
      case 'tested':
        return `${row.name} ${version} found. This is the build CrewKite was tested with.`;
      case 'newer':
        return `${row.name} ${version} found. Tested with ${row.tested}; newer builds usually work.`;
      case 'supported':
        return `${row.name} ${version} found. Tested with ${row.tested}; builds from ${row.minimum} on are supported.`;
      case 'older':
        return `${row.name} ${version} is older than the minimum ${row.minimum}. Update it with ${row.update}, then press Check again.`;
      case 'new-major':
        return `${row.name} ${version} found. CrewKite is tested with ${row.tested} and does not run a new major version yet. Install a ${tested}.x build, or update CrewKite.`;
      case 'unreadable':
        return `CrewKite could not read the version of ${row.name} at ${found.state === 'version' ? found.path : row.command}. Run ${row.command} --version in a terminal to see why, then check again.`;
      case 'untrusted':
        return found.state === 'untrusted' && found.why === 'foreign-owner'
          ? `${row.name} at ${found.path} belongs to another account, so CrewKite will not run it.`
          : `${row.name} at ${found.state === 'untrusted' ? found.path : row.command} can be changed by other users, so CrewKite will not run it.`;
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
    accepted: ACCEPTED.has(state),
    version,
    tested: row.tested,
    minimum: row.minimum,
    message: message.slice(0, 1024),
  };
}

/**
 * The file is a bounded regular file that the current user or the system owns, and nobody else
 * can write. A link counts by the file it resolves to.
 */
export function clientFileTrust(
  stat: Pick<Stats, 'isFile' | 'size' | 'uid' | 'mode'>,
  maximumBytes: number,
  uid = process.getuid?.(),
): 'trusted' | 'not-a-client' | 'shared-write' | 'foreign-owner' {
  if (!stat.isFile() || stat.size > maximumBytes) return 'not-a-client';
  if (stat.uid !== uid && stat.uid !== 0) return 'foreign-owner';
  if (stat.mode & 0o002) return 'shared-write';
  return 'trusted';
}

type Read = { key: string; version: string | null; sha256: string; at: number };
const identity = (stat: Stats) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const reads = new Map<string, Read>();
// An unreadable version is read again after a minute, so a slow first start does not stick.
const UNREADABLE_RETRY_MS = 60_000;

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
  cache?: Map<string, Read>;
  now?: () => number;
  timeoutMs?: number;
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
    let entry: string;
    try {
      entry = realpathSync(join(directory, row.command));
    } catch {
      continue;
    }
    for (const candidate of [...(options.siblings?.(entry) ?? []), entry]) {
      let executable: string;
      let stat: Stats;
      try {
        executable = realpathSync(candidate);
        stat = lstatSync(executable);
      } catch {
        continue;
      }
      if (seen.has(executable)) continue;
      seen.add(executable);
      const trust = clientFileTrust(stat, row.maximumBytes);
      if (trust === 'not-a-client') continue;
      if (trust !== 'trusted') {
        first ??= {
          status: clientVersionStatus(family, { state: 'untrusted', path: executable, why: trust }),
        };
        continue;
      }
      const key = identity(stat);
      let read = cache.get(executable);
      if (
        !read ||
        read.key !== key ||
        (read.version === null && now() - read.at >= UNREADABLE_RETRY_MS)
      ) {
        // The digest is taken before the client runs, and a file that changed while it ran keeps
        // no version, so the version and the digest describe the same bytes.
        const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
        let version = readVersion(executable, row, options);
        try {
          if (identity(lstatSync(executable)) !== key) version = null;
        } catch {
          version = null;
        }
        read = { key, version, sha256, at: now() };
        cache.set(executable, read);
      }
      const status = clientVersionStatus(family, {
        state: 'version',
        path: executable,
        version: read.version,
      });
      const found: FoundClient = status.accepted
        ? {
            status,
            client: { executable, sha256: read.sha256, version: status.version ?? row.tested },
          }
        : { status };
      if (status.accepted) return found;
      first ??= found;
    }
  }
  return first ?? { status: clientVersionStatus(family, { state: 'missing' }) };
}

// shortcut: the read is synchronous, so a client that ignores the bound blocks the controller for
// up to the timeout once per changed build. The result is cached by the file's identity. An
// asynchronous read with a pending state is the upgrade path if a client ever needs it.
function readVersion(executable: string, row: Row, options: FindOptions): string | null {
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
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 5000,
    killSignal: 'SIGKILL',
    maxBuffer: 4096,
    encoding: 'utf8',
  };
  const result = spawnSync(executable, ['--version'], spawnOptions);
  // The client ran in its own group. Anything it left behind goes with it.
  if (result.pid > 0)
    try {
      process.kill(-result.pid, 'SIGKILL');
    } catch {}
  if (result.error || result.status !== 0) return null;
  return parseClientVersion(result.stdout)?.text ?? null;
}

/** The directories the profiles search for a family, in their order. */
export function clientDirectories(family: ClientFamily, environment: NodeJS.ProcessEnv): string[] {
  const path = (environment.PATH ?? '').split(':').filter(isAbsolute);
  return family === 'openai'
    ? [...path, '/opt/homebrew/bin', '/usr/local/bin']
    : [
        ...path,
        ...(environment.HOME ? [join(environment.HOME, '.local/bin')] : []),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ];
}

/** The npm package keeps the native binary beside its script entry. */
export function openAiNativeSibling(entry: string): string[] {
  return [
    join(
      dirname(dirname(entry)),
      'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    ),
  ];
}

/** The gates every resolution shares with the profiles: platform and the person's own home. */
export function clientHostGate(
  family: ClientFamily,
  environment: NodeJS.ProcessEnv,
  host: { platform: string; arch: string } = process,
): { reason: 'unsupported-platform' | 'native-home-unavailable'; detail: string } | null {
  const name = CLIENT_VERSIONS[family].name;
  if (host.platform !== 'darwin' || host.arch !== 'arm64')
    return {
      reason: 'unsupported-platform',
      detail: `${name} runs from CrewKite on macOS with Apple silicon only.`,
    };
  if (!environment.HOME || environment.HOME !== userInfo().homedir)
    return {
      reason: 'native-home-unavailable',
      detail: `${name} needs HOME set to your own home folder.`,
    };
  return null;
}
