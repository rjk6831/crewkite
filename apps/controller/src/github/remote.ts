import { spawnSync } from 'node:child_process';
import { type GitHubRepository, GitHubRepositorySchema } from '@crewkite/contracts';

// One answer for what a project remote is. Push is plain git and works for any of them. The GitHub
// parts (pull requests, CI, merge readiness, review comments, re-runs, deploys) need a GitHub
// repository, and gh is only ever pointed at a host this file resolved.

/**
 * The variables git and gh read to find the person's own sign-in, ssh agent and proxy. Every
 * process that runs git or gh for a remote gets these and nothing else the controller holds.
 */
export const GIT_AND_GH_VARIABLES = [
  'USER',
  'LOGNAME',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'SSH_AUTH_SOCK',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
] as const;

/** The allowlisted variables of `source` that are set, for a git or gh process. */
export function gitAndGhEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of GIT_AND_GH_VARIABLES) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  return environment;
}

export type RemoteRead =
  | { kind: 'github'; repo: GitHubRepository }
  /** A remote git can reach that is no GitHub repository: a path, file://, git://, another host. */
  | { kind: 'git' }
  /** An ssh remote whose real host the ssh configuration did not give. Nothing asks gh about it. */
  | { kind: 'unresolved'; alias: string };

/**
 * The host ssh connects to for a name, as `ssh -G` prints it from the person's ssh configuration.
 * It reads the configuration only and opens no connection. Null when ssh cannot answer.
 */
export type SshHost = (alias: string, port: string | null) => string | null;

export const sshHost: SshHost = (alias, port) => {
  // A name that starts with a dash would read as an option.
  if (alias.startsWith('-')) return null;
  const ran = spawnSync('ssh', ['-G', ...(port ? ['-p', port] : []), alias], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (ran.status !== 0) return null;
  return /^hostname (\S+)$/m.exec(ran.stdout)?.[1] ?? null;
};

// GitHub serves ssh on port 443 under this name for networks that block port 22.
const SSH_OVER_HTTPS = 'ssh.github.com';

const https = /^https:\/\/(?:[^@/]+@)?([^/:@]+)(?::\d+)?\/(.+)$/;
const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:@]+)(?::(\d+))?\/(.+)$/;
// scp style: [user@]host:path. A path with a slash before the colon, or a drive letter, is local.
const scp = /^(?:[^@/:]+@)?([^/:@]+):(?!\/\/)(.+)$/;
const path = /^\/?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** The hosts whose repositories are GitHub's: github.com, and an enterprise host GH_HOST names. */
export function githubHosts(environment: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set(['github.com']);
  const named = environment.GH_HOST?.trim().toLowerCase();
  if (named) hosts.add(named);
  return hosts;
}

/**
 * What a remote URL points at. An https remote names its host as written. An ssh remote names a
 * name the ssh configuration may map to another host, so that name is resolved first.
 */
export function readRemote(
  url: string,
  resolve: SshHost = sshHost,
  hosts: Set<string> = githubHosts(),
): RemoteRead {
  const text = url.trim();
  let host: string;
  let rest: string;
  const web = https.exec(text);
  const shell = web ? null : ssh.exec(text);
  const short = web || shell ? null : scp.exec(text);
  if (web) {
    host = web[1];
    rest = web[2];
  } else if (shell || short) {
    const alias = (shell?.[1] ?? short?.[1]) as string;
    const resolved = resolve(alias, shell?.[2] ?? null);
    if (!resolved) return { kind: 'unresolved', alias };
    host = resolved;
    rest = (shell?.[3] ?? short?.[2]) as string;
  } else return { kind: 'git' };
  host = host.toLowerCase();
  if (host === SSH_OVER_HTTPS) host = 'github.com';
  const named = path.exec(rest);
  if (!hosts.has(host) || !named) return { kind: 'git' };
  const parsed = GitHubRepositorySchema.safeParse({ host, owner: named[1], name: named[2] });
  return parsed.success ? { kind: 'github', repo: parsed.data } : { kind: 'git' };
}

/** The one line a GitHub part shows for a remote that is not a GitHub repository. */
export function notGitHubLine(remote: string, read: Exclude<RemoteRead, { kind: 'github' }>) {
  return read.kind === 'unresolved'
    ? `CrewKite could not tell which host ${remote} reaches through ssh, so it does not ask GitHub about it.`
    : `${remote} is not a GitHub repository, so pull requests, CI and deploys are not read for it.`;
}
