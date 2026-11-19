import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LaunchIdentity } from '../store/index.ts';

// Every launch intent records the boot and the machine this controller saw. A later recovery rule
// can then tell a reboot or a copied home from a live owner, once that rule is qualified. The raw
// values stay in this file. The store keeps an HMAC keyed to the home.

/** How the reader asks the computer. Tests pass their own, so no test runs sysctl or reads /proc. */
export type PlatformReads = {
  platform: NodeJS.Platform;
  run: (file: string, args: readonly string[]) => string;
  read: (path: string) => string;
};

const KEY_FILE = 'launch-identity.key';
const KEY_BYTES = 32;
// Both reads return in milliseconds. A wedged one costs a null pair, never a launch.
const READ_MS = 1_000;
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const system: PlatformReads = {
  platform: process.platform,
  run: (file, args) =>
    execFileSync(file, args, {
      encoding: 'utf8',
      env: {},
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: READ_MS,
      killSignal: 'SIGKILL',
    }),
  read: (path) => readFileSync(path, 'utf8'),
};

type Source<Name> = {
  source: Name;
  value: (reads: PlatformReads) => string | undefined;
  shape: RegExp;
};
type Platform = {
  boot: Source<NonNullable<LaunchIdentity['boot']>['source']>;
  machine: Source<NonNullable<LaunchIdentity['machine']>['source']>;
};

// The executables are named by absolute path, so PATH cannot pick another program.
const platforms: Partial<Record<NodeJS.Platform, Platform>> = {
  darwin: {
    boot: {
      source: 'darwin-boot-session-v1',
      value: (reads) => reads.run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']),
      shape: UUID,
    },
    machine: {
      source: 'darwin-platform-uuid-v1',
      value: (reads) =>
        /"IOPlatformUUID" = "([^"]*)"/.exec(
          reads.run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']),
        )?.[1],
      shape: UUID,
    },
  },
  linux: {
    boot: {
      source: 'linux-boot-id-v1',
      value: (reads) => reads.read('/proc/sys/kernel/random/boot_id'),
      shape: UUID,
    },
    machine: {
      source: 'linux-machine-id-v1',
      value: (reads) => reads.read('/etc/machine-id'),
      shape: /^[0-9a-f]{32}$/,
    },
  },
};

type Observed<Name> = { source: Name; value: string } | null;
type Observation = {
  boot: Observed<Platform['boot']['source']>;
  machine: Observed<Platform['machine']['source']>;
};

function take<Name>(entry: Source<Name>, reads: PlatformReads): Observed<Name> {
  try {
    const value = entry.value(reads)?.trim();
    return value && entry.shape.test(value) ? { source: entry.source, value } : null;
  } catch {
    return null;
  }
}

function observe(reads: PlatformReads): Observation {
  const platform = platforms[reads.platform];
  return platform
    ? { boot: take(platform.boot, reads), machine: take(platform.machine, reads) }
    : { boot: null, machine: null };
}

function readKey(path: string): Buffer {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = fstatSync(file);
    if (!state.isFile() || state.size !== KEY_BYTES)
      throw Error('The launch identity key is invalid.');
    return readFileSync(file);
  } finally {
    closeSync(file);
  }
}

/**
 * The home's digest key. A copied home brings its key, so its machine digest changes only when
 * the machine does. The key lands whole through a link: a crash leaves no key or a full one.
 */
function homeKey(home: string): Buffer {
  const path = join(home, KEY_FILE);
  try {
    return readKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(home, `.${KEY_FILE}-${randomUUID()}`);
  const file = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(file, randomBytes(KEY_BYTES));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    linkSync(temporary, path);
    // The rows that use this key are durable, so its name must be too.
    const directory = openSync(home, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    unlinkSync(temporary);
  }
  return readKey(path);
}

// Boot and machine do not change while the process runs, so the computer is asked once.
let observed: Observation | undefined;
function observeSystem(): Observation {
  observed ??= observe(system);
  return observed;
}

/**
 * Digests of this boot and this machine, keyed to the home. Any failure gives null for its pair.
 * It never throws, so a missing tool or an odd home never stops a launch.
 */
export function readLaunchIdentity(home: string, reads?: PlatformReads): LaunchIdentity {
  try {
    const key = homeKey(home);
    const seen = reads ? observe(reads) : observeSystem();
    const digest = (source: string, value: string) =>
      createHmac('sha256', key).update(`${source}\n${value}`).digest('hex');
    return {
      boot: seen.boot && {
        source: seen.boot.source,
        digest: digest(seen.boot.source, seen.boot.value),
      },
      machine: seen.machine && {
        source: seen.machine.source,
        digest: digest(seen.machine.source, seen.machine.value),
      },
    };
  } catch {
    return { boot: null, machine: null };
  }
}
