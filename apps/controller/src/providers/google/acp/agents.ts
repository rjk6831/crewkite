import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { ClientVersionStatus } from '@crewkite/contracts';
import { z } from 'zod';
import {
  CLIENT_VERSIONS,
  clientCopies,
  clientCopy,
  clientDirectories,
  clientFileTrust,
  clientVersionStatus,
  compareClientVersions,
  inspectClients,
  MANAGED_REFUSED_LIMIT,
  managedVersions,
  readManagedRecord,
} from '../../client-versions.ts';
import { fileDigestSync } from '../../file-digest.ts';
import { machOFiles, verifyDeveloperId, writeRecord } from '../../managed-client.ts';
import type { GoogleGate } from '../chat.ts';
import {
  ACP_AGENT_ARGS,
  type AcpAgentIdentity,
  type AcpClient,
  AcpServerMaximumBytes,
  isAcpBundle,
  readAcpPrivateFile,
} from './profile.ts';
import type { AcpQualifyRefusal } from './writer.ts';

// The Google agents on this device that may serve the chat route besides the 1.4.0 bundle: a copy
// whose help lists the `acp` subcommand, on the search path or inside Google's desktop app, and a
// copy CrewKite fetched from the agent registry. Each is admitted only when Google's Developer ID
// signature, team EQHXZ8M8AV, verifies on the exact file. Its connect-time replies then decide
// what it may do. This runs off the hot path: the profile resolution only reads the last scan.

export const GOOGLE_TEAM = 'EQHXZ8M8AV';

export type GoogleAgent = AcpAgentIdentity &
  Readonly<{
    kind: 'cli' | 'fetched';
    place: 'search-path' | 'provider-app' | 'crewkite';
  }>;

/**
 * What a scan found. `unverified` lists the digests of copies that are on the device but whose
 * signature or help read did not finish this time, such as a signature check that ran out of
 * time. Such a copy is not run, and it is not gone either.
 */
export type GoogleScan = { agents: GoogleAgent[]; unverified: string[] };

/** What the help and signature reads found, by digest, for the life of the controller. */
export type GoogleAgentChecks = Map<string, 'acp' | 'no-acp' | 'signed' | 'unsigned'>;
const checks: GoogleAgentChecks = new Map();

const HELP_LINE = 'Usage: agy acp [flags]';
const HELP_BYTES = 16 * 1024;
const HELP_MS = 5000;

/**
 * The agent's own help for the subcommand, bounded, or null when the read did not finish. On a
 * build without the subcommand `agy acp` is no harmless error: an older build read the word as a
 * prompt, which is a live call. So the subcommand is proven here before `agy acp` is ever
 * started. 1.4.2 answered `help acp` with `Error: unknown subcommand: acp` and exit 1, so `help`
 * is parsed there too. A nonzero exit is that answer, returned as text that serves no acp. The
 * read gets a private empty home, since it has no reason to see the sign-in, and runs in its own
 * process group, killed afterwards. The help goes to stderr on the builds I measured, so stdout
 * counts first and stderr when it is empty.
 */
export async function readAgentHelp(executable: string): Promise<string | null> {
  let home: string;
  try {
    home = await mkdtemp(join(tmpdir(), 'crewkite-agent-help-'));
  } catch {
    return null;
  }
  try {
    return await new Promise<string | null>((resolve) => {
      const child = spawn(executable, ['help', 'acp'], {
        cwd: '/',
        env: {
          HOME: home,
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          NO_COLOR: '1',
          ...CLIENT_VERSIONS.google.environment,
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0;
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child.pid)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), HELP_MS);
      const take = (into: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > HELP_BYTES) finish(null);
        else into.push(chunk);
      };
      child.stdout.on('data', take(out));
      child.stderr.on('data', take(err));
      child.once('error', () => finish(null));
      child.once('close', (code) => {
        if (code === null) return finish(null);
        const stdout = Buffer.concat(out).toString('utf8');
        const text = stdout.trim() ? stdout : Buffer.concat(err).toString('utf8');
        finish(code === 0 ? text : `exit ${code}\n${text}`);
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const servesAcp = (help: string) =>
  help
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim() === HELP_LINE;

const agentFile = z.strictObject({
  cmd: z
    .string()
    .min(1)
    .max(200)
    .regex(/^(\.\/)?[^/\\]+(\/[^/\\]+)*$/)
    .refine((value) => !value.split('/').includes('..')),
  args: z.array(z.string().max(16)).max(2),
});

type Check = (path: string, sha256: string) => Promise<boolean | null>;

/**
 * The signed agents on the device, newest first. The signature is checked before the help is
 * read, so no unsigned file runs at all. A check that did not finish proves nothing: the copy is
 * left out and listed as unverified, and the next scan tries again. A refused signature and a help
 * text without the subcommand are remembered by digest.
 */
export async function scanGoogleAgents(options: {
  environment: NodeJS.ProcessEnv;
  /** CrewKite's own client folder, from managedClientRoot. Its copies are the fetched kind. */
  managed: string | null;
  /** Resolves when the file's signature names the team. Defaults to macOS codesign. */
  verify?: (executable: string, team: string) => Promise<void>;
  /** The agent's help for the acp subcommand, null when it did not finish. */
  help?: (executable: string) => Promise<string | null>;
  cache?: GoogleAgentChecks;
  host?: { platform: string; arch: string };
  /** Where to look. Tests pass their own; the defaults are the quota client's places. */
  directories?: readonly string[];
  copies?: readonly string[];
}): Promise<GoogleScan> {
  const host = options.host ?? process;
  const scan: GoogleScan = { agents: [], unverified: [] };
  // A Developer ID signature exists only on macOS, and arm64 is the build the route runs there.
  if (host.platform !== 'darwin' || host.arch !== 'arm64') return scan;
  const environment = options.environment;
  if (!environment.HOME) return scan;
  const cache = options.cache ?? checks;
  const verify = options.verify ?? verifyDeveloperId;
  const help = options.help ?? readAgentHelp;
  const own = options.managed ? `${options.managed}${sep}` : null;
  const signed: Check = async (path, sha256) => {
    const known = cache.get(`signature\0${sha256}`);
    if (known) return known === 'signed';
    try {
      await verify(path, GOOGLE_TEAM);
      cache.set(`signature\0${sha256}`, 'signed');
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'signature-refused') return null;
      cache.set(`signature\0${sha256}`, 'unsigned');
      return false;
    }
  };
  const serves: Check = async (path, sha256) => {
    const key = `help\0${sha256}`;
    const known = cache.get(key);
    if (known) return known === 'acp';
    const text = await help(path);
    if (text === null) return null;
    const acp = servesAcp(text);
    cache.set(key, acp ? 'acp' : 'no-acp');
    return acp;
  };
  const found = inspectClients('google', {
    directories: options.directories ?? clientDirectories('google', environment, host),
    // CrewKite's own copies came from the registry with their own launch line, read below.
    copies: (options.copies ?? clientCopies('google', environment, host)).filter(
      (copy) => !own || !copy.startsWith(own),
    ),
    home: environment.HOME,
    path: environment.PATH,
  });
  for (const client of found) {
    const signature = await signed(client.executable, client.sha256);
    const acp = signature ? await serves(client.executable, client.sha256) : signature;
    if (acp === null) scan.unverified.push(client.sha256);
    if (!acp) continue;
    scan.agents.push({
      kind: 'cli',
      executable: client.executable,
      args: ['acp'],
      version: client.version,
      sha256: client.sha256,
      signerTeamId: GOOGLE_TEAM,
      helpers: [],
      place: /\/[^/]+\.app\/Contents\//.test(client.executable) ? 'provider-app' : 'search-path',
    });
  }
  if (options.managed)
    for (const version of managedVersions(options.managed, 'google'))
      await fetchedAgent(options.managed, version, signed, serves, scan);
  scan.agents.sort(
    (left, right) =>
      compareClientVersions(left.version, right.version) ||
      left.executable.localeCompare(right.executable),
  );
  return scan;
}

/**
 * A copy CrewKite fetched, as its own record names it: the launch line the registry gave, from the
 * closed list, a file inside the folder that passes the owner and mode checks, every Mach-O file
 * in the folder signed by Google, and the help read for a line that starts with the subcommand.
 * Programs are held to the bundle server's size bound, since a fetched server is near 281 MB.
 * Anything else leaves the copy out.
 */
async function fetchedAgent(
  root: string,
  version: string,
  signed: Check,
  serves: Check,
  scan: GoogleScan,
) {
  let main: string | undefined;
  try {
    const folder = realpathSync(join(root, 'google', version));
    const launch = agentFile.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          readAcpPrivateFile(join(folder, 'agent.json'), 4096),
        ),
      ),
    );
    if (!ACP_AGENT_ARGS.some((args) => JSON.stringify(args) === JSON.stringify(launch.args)))
      return;
    const executable = realpathSync(join(folder, launch.cmd));
    const programs = [...new Set([executable, ...machOFiles(folder)])];
    const digests: { path: string; sha256: string }[] = [];
    for (const path of programs) {
      if (
        !path.startsWith(`${folder}${sep}`) ||
        clientFileTrust(
          lstatSync(path),
          AcpServerMaximumBytes,
          process.getuid?.(),
          lstatSync(dirname(path)),
        ) !== 'trusted'
      )
        return;
      digests.push({ path, sha256: fileDigestSync(path) });
    }
    main = digests[0].sha256;
    for (const program of digests) {
      const signature = await signed(program.path, program.sha256);
      if (signature === null) scan.unverified.push(main);
      if (!signature) return;
    }
    if (launch.args[0] === 'acp') {
      const acp = await serves(executable, main);
      if (acp === null) scan.unverified.push(main);
      if (!acp) return;
    }
    scan.agents.push({
      kind: 'fetched',
      executable,
      args: launch.args,
      version,
      sha256: main,
      signerTeamId: GOOGLE_TEAM,
      helpers: digests.slice(1),
      place: 'crewkite',
    });
  } catch {}
}

/**
 * The chat agent's row for the card. The quota client keeps the CLIENT_VERSIONS row. 1.4.0 is the
 * build I tested the route with, and the oldest a home can hold.
 */
export const GOOGLE_AGENT_ROW = { name: 'Antigravity agent', tested: '1.4.0', minimum: '1.4.0' };

/** The card's status for the agent in use, in the words the other cards use. */
export function googleAgentStatus(client: AcpClient, root: string | null): ClientVersionStatus {
  const bundle = isAcpBundle(client);
  const status = clientVersionStatus(
    'google',
    { state: 'version', path: client.executable, version: client.version, managed: root },
    { ...GOOGLE_AGENT_ROW, ...(bundle ? { where: " in CrewKite's home" } : {}) },
  );
  const copy = clientCopy('google', client.executable, root);
  return { ...status, copy: bundle ? { ...copy, place: 'crewkite' } : copy };
}

/** Where a copy sits, as the first words of its card line. */
function where(agent: GoogleAgent) {
  if (agent.place === 'crewkite') return 'The copy CrewKite fetched';
  const app = /\/([^/]+\.app)\/Contents\//.exec(agent.executable);
  return app ? `The copy in ${app[1]}` : 'The copy on your search path';
}

/** What went wrong with a build, as the reason the card gives for not using it. */
export type GoogleAgentVerdict = AcpQualifyRefusal | GoogleGate | 'unsteady' | 'sign-in';

const VERDICT_LINES: Record<Exclude<GoogleAgentVerdict, 'sign-in'>, string> = {
  protocol: 'speaks a protocol version CrewKite does not',
  version: 'reported another version than the one it was found under',
  'sign-in-method': 'offers no sign-in CrewKite can start',
  models: 'did not list its models in a form CrewKite reads',
  mode: 'did not offer the mode that asks before edits',
  unsteady: 'did not finish its connect-time reads',
  edit: 'edited a file without asking',
  service: 'asked for a file or terminal service CrewKite keeps off',
  subagent: 'started a subagent in a turn that runs without them',
};

/**
 * One sentence for the card. `inUse` is the version that keeps running meanwhile, or null while
 * no copy runs, as when the copy in use went away and the next one is being set up.
 */
export function googleAgentLine(
  agent: GoogleAgent,
  verdict: GoogleAgentVerdict,
  inUse: string | null,
): string {
  return verdict === 'sign-in'
    ? `${where(agent)} needs its own Google sign-in. Press Connect to sign in with it.${inUse ? ` Until then ${inUse} runs.` : ''}`
    : `${where(agent)} ${VERDICT_LINES[verdict]}.`;
}

/**
 * Notes what became of a build in `clients/google.json`: refused for good by digest, not used this
 * time, waiting for the person's sign-in, or passed, which clears a note about the same copy. The
 * record decides no trust. Deleting it means each refused copy is checked once more and refused
 * again.
 */
export function recordGoogleAgent(
  root: string,
  agent: GoogleAgent,
  outcome: { refused: string } | { notUsed: string } | { signIn: string } | 'passed',
  now: string,
) {
  const record = readManagedRecord(root, 'google');
  if (outcome === 'passed') {
    if (record.notUsed?.sha256 === agent.sha256)
      writeRecord(root, 'google', { ...record, notUsed: null });
    return;
  }
  const refused = 'refused' in outcome;
  const reason =
    'refused' in outcome ? outcome.refused : 'signIn' in outcome ? outcome.signIn : outcome.notUsed;
  writeRecord(root, 'google', {
    ...record,
    notUsed: {
      version: agent.version,
      at: now,
      reason: reason.slice(0, 300),
      sticky: refused,
      sha256: agent.sha256,
      ...('signIn' in outcome ? { signIn: true as const } : {}),
    },
    ...(refused
      ? {
          refused: [
            { sha256: agent.sha256, version: agent.version },
            ...(record.refused ?? []).filter((entry) => entry.sha256 !== agent.sha256),
          ].slice(0, MANAGED_REFUSED_LIMIT),
        }
      : {}),
  });
}

const strikes = new Map<string, number>();

/**
 * The rule managed-client.ts applies to a fetched build, keyed by digest: a read that can fail
 * for a passing reason counts against a build only on the second failure in a row, since one
 * failure can be a full disk, a home that could not be written or options that came late. True
 * when this failure is the second.
 */
export function googleAgentStrike(sha256: string, failed: boolean): boolean {
  if (!failed) {
    strikes.delete(sha256);
    return false;
  }
  if (strikes.has(sha256)) {
    strikes.delete(sha256);
    return true;
  }
  strikes.set(sha256, 1);
  return false;
}
