import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { clientRecord, recordClient } from '../client-record.ts';
import { CLIENT_VERSIONS } from '../client-versions.ts';
import {
  flagsIn,
  OPTIONAL_FLAGS,
  PASSED_FLAGS,
  rememberFlags,
  UNLISTED_FLAGS,
} from './protocol.ts';

// The connect-time self-test. When the client's build changes, its own --help says which flags it
// lists, and the result is compared with the last build that passed. The line goes on the
// Settings card before the first turn. No account is read and no model runs.

const good = z.object({
  version: z.string(),
  /** The build whose capabilities and model keys are on record. */
  from: z.string(),
  flags: z.array(z.string()).max(512),
  capabilities: z.array(z.string()).max(64),
  modelKeys: z.array(z.string()).max(64),
});
type Good = z.infer<typeof good>;

const attempted = new Set<string>();
const compared = new Set<string>();

/** Forgets what was probed, so the next resolution probes again. Tests and Check again use it. */
export function forgetProbes() {
  attempted.clear();
  compared.clear();
}

const goodFile = (home: string) => join(home, 'native', 'client-record-anthropic.json');

function readGood(home: string): Good | null {
  try {
    return good.parse(JSON.parse(readFileSync(goodFile(home), 'utf8')));
  } catch {
    return null;
  }
}

function writeGood(home: string, value: Good) {
  try {
    mkdirSync(join(home, 'native'), { recursive: true, mode: 0o700 });
    writeFileSync(goodFile(home), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch {
    // The comparison is a convenience. A folder that cannot be written costs the next one.
  }
}

/** Where CrewKite keeps its own files, the same folder the controller opens. */
export const crewkiteHome = (environment: NodeJS.ProcessEnv) =>
  environment.CREWKITE_HOME ?? join(environment.HOME ?? '', '.crewkite');

const list = (names: readonly string[]) => names.join(', ');

/**
 * Reads the flags the build lists, once per build digest. Dropped optional flags are remembered
 * for the adapters; the card line says what the build does not list.
 * shortcut: the read is synchronous and runs --help once per changed build with a five second
 * bound, like the version read. Upgrade: an asynchronous probe with a pending state on the card.
 */
export function probeClient(input: {
  executable: string;
  sha256: string;
  version: string;
  environment: NodeJS.ProcessEnv;
  /** Runs the client's help. Tests pass their own. */
  help?: (executable: string) => string | null;
}) {
  const home = crewkiteHome(input.environment);
  const { sha256, version } = input;
  if (!attempted.has(sha256)) {
    attempted.add(sha256);
    const help = (input.help ?? ((path) => readHelp(path, input.environment)))(input.executable);
    const flags = help === null ? null : flagsIn(help);
    // A help text with almost no flags is something other than the client's help.
    if (!flags || flags.size < 8) {
      recordClient('anthropic', {
        version,
        build: sha256,
        probe: `Self-test of ${version}: the client's help could not be read, so every flag is passed as is.`,
      });
    } else {
      rememberFlags(sha256, flags);
      const missing = PASSED_FLAGS.filter((flag) => !flags.has(flag) && !UNLISTED_FLAGS.has(flag));
      const optional = missing.filter((flag) => OPTIONAL_FLAGS.has(flag));
      const required = missing.filter((flag) => !OPTIONAL_FLAGS.has(flag));
      const before = readGood(home);
      const lost = before
        ? before.flags.filter((flag) => !flags.has(flag) && PASSED_FLAGS.includes(flag))
        : [];
      const lines = [
        required.length
          ? `${CLIENT_VERSIONS.anthropic.name} ${version} does not list ${list(required)}, which CrewKite passes. Turns that need them fail until you run ${CLIENT_VERSIONS.anthropic.update}.`
          : optional.length
            ? `Self-test of ${version}: runs without ${list(optional)}, which this build does not list.`
            : `Self-test of ${version}: every flag CrewKite passes is listed.`,
        lost.length && before
          ? `The last good build, ${before.version}, listed ${list(lost)}.`
          : null,
      ];
      recordClient('anthropic', {
        version,
        build: sha256,
        probe: lines.filter(Boolean).join(' '),
      });
      if (!required.length)
        writeGood(home, {
          version,
          from: before?.from ?? version,
          flags: PASSED_FLAGS.filter((flag) => flags.has(flag)),
          capabilities: before?.capabilities ?? [],
          modelKeys: before?.modelKeys ?? [],
        });
    }
  }
  review(home, sha256, version);
}

/**
 * Once the client has answered its initialize request, its capability list and model rows are
 * compared with the last good record. The first build with nothing on record only writes one.
 */
function review(home: string, sha256: string, version: string) {
  const record = clientRecord('anthropic', version);
  if (compared.has(sha256) || !record?.capabilities.length) return;
  compared.add(sha256);
  const before = readGood(home);
  // Only a build that passed the flag check becomes the record.
  if (before?.version !== version) return;
  const models = (record.kept.initialize as { models?: unknown[] } | undefined)?.models ?? [];
  const keys = Object.keys((models[0] ?? {}) as Record<string, unknown>).sort();
  const lostCapabilities =
    before.from === version
      ? []
      : before.capabilities.filter((name) => !record.capabilities.includes(name));
  const lostKeys =
    before.from === version ? [] : before.modelKeys.filter((key) => !keys.includes(key));
  const notes = [
    lostCapabilities.length
      ? `The last good build, ${before.from}, reported ${list(lostCapabilities)}; this one does not.`
      : null,
    lostKeys.length ? `Model rows no longer carry ${list(lostKeys)}.` : null,
  ].filter(Boolean);
  if (notes.length)
    recordClient('anthropic', { probe: `${record.probe ?? ''} ${notes.join(' ')}`.trim() });
  writeGood(home, {
    ...before,
    from: version,
    capabilities: [...record.capabilities],
    modelKeys: keys,
  });
}

function readHelp(executable: string, environment: NodeJS.ProcessEnv): string | null {
  // Node honors detached for spawnSync, which puts the client in its own group; the types omit it.
  const options: SpawnSyncOptionsWithStringEncoding & { detached: true } = {
    cwd: '/',
    env: {
      HOME: environment.HOME,
      PATH: environment.PATH || '/usr/bin:/bin',
      LANG: 'C',
      NO_COLOR: '1',
      ...CLIENT_VERSIONS.anthropic.environment,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  };
  const run = spawnSync(executable, ['--help'], options);
  if (run.pid > 0)
    try {
      process.kill(-run.pid, 'SIGKILL');
    } catch {}
  if (run.error || run.status !== 0) return null;
  return run.stdout;
}
