import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type RepositoryPolicy, TimestampSchema } from '@crewkite/contracts';
import { checkCommit } from '../github/policy.ts';
import {
  type FileContent,
  git,
  gitFromFile,
  gitToFile,
  type KeptEntry,
  treeFromFiles,
} from './source.ts';

export type GitIdentity = { name: string; email: string };
export function validateIdentity(identity: GitIdentity): GitIdentity {
  if (
    !identity.name.trim() ||
    identity.name.length > 256 ||
    /[<>\r\n\0]/.test(identity.name) ||
    identity.email.length > 256 ||
    !/^[^@\s<>]+@[^@\s<>]+$/.test(identity.email) ||
    /[\r\n\0]/.test(identity.email)
  )
    throw new Error('Configure a valid Git name and email before acceptance.');
  return { name: identity.name.trim(), email: identity.email };
}
/**
 * The name and email Git config gives. `global` reads the user's global file. `repository` reads
 * what Git resolves inside the repository at `directory`: its own config over the user's, with
 * its includes and conditional includes.
 */
export function configuredIdentity(
  directory: string,
  scope: 'global' | 'repository' = 'global',
): GitIdentity | undefined {
  const where = scope === 'global' ? ['--global'] : [];
  try {
    const read = (key: string) =>
      execFileSync('git', ['config', ...where, '--includes', '--get', key], {
        cwd: directory,
        timeout: 1000,
        maxBuffer: 1024,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: homedir(),
          XDG_CONFIG_HOME: join(homedir(), '.config'),
          GIT_CONFIG_NOSYSTEM: '1',
        },
      }).trim();
    return validateIdentity({ name: read('user.name'), email: read('user.email') });
  } catch {
    return undefined;
  }
}

/** What the controller is given: a fixed identity, or a reader of the user's global config. */
export type GitIdentitySource = GitIdentity | (() => GitIdentity | undefined);

/**
 * Who a commit in this project is from. A fixed identity, as tests and the scripted controller
 * pass, stands for every project. Otherwise the policy picks the config: the project's own, or
 * the user's global config through the reader.
 */
export function commitIdentity(
  policy: RepositoryPolicy,
  root: string,
  source: GitIdentitySource | undefined,
): GitIdentity | undefined {
  if (typeof source !== 'function') return source;
  return policy.identity === 'repository' ? configuredIdentity(root, 'repository') : source();
}

type PublicationInput = {
  source: string;
  repository: string;
  base: string;
  files?: FileContent[];
  /** Base entries a chat scratch copy left out. They go into the tree unchanged. */
  kept?: readonly KeptEntry[];
  /** The project's policy. The commit, its identity and its branch must meet it. */
  policy: RepositoryPolicy;
  /** The branch the commit is for. `applyPublication` writes it. */
  destinationRef: string;
  /** Undefined when the policy's identity source resolved none. The policy refuses that. */
  identity: GitIdentity | undefined;
  at: string;
  message: string;
  /**
   * The commit's parents, first parent first. Absent means `base` alone. A merge of the pull
   * request's base names the accepted commit and the base.
   */
  parents?: readonly string[];
};
type Prepared = { treeOid: string; commitOid: string };

/** With `tree`, a tree already built in `repository` such as `treeFromScratch` makes, the pack is a file. */
export function preparePublication(
  input: PublicationInput & { tree: string },
): Prepared & { pack: { file: string } };
export function preparePublication(input: PublicationInput & { tree?: undefined }): Prepared & {
  pack: Buffer;
};
export function preparePublication(
  input: PublicationInput & { tree?: string },
): Prepared & { pack: Buffer | { file: string } } {
  if (input.base.length !== 40)
    throw new Error('Publication from this Git object format is unsupported in D0.');
  // Every commit CrewKite makes is built here, and the policy check runs before it. Providers
  // cannot commit: chat scratch copies and run copies hold no .git, and the local tools refuse
  // .git paths. A new way to commit calls this function, so no commit skips the policy.
  const { message, identity } = checkCommit(input.policy, {
    message: input.message,
    destinationRef: input.destinationRef,
    identity: input.identity && validateIdentity(input.identity),
  });
  const at = TimestampSchema.parse(input.at);
  const treeOid = input.tree ?? treeFromFiles(input.repository, input.files ?? [], input.kept);
  const parents = input.parents ?? [input.base];
  for (const parent of parents) {
    const body = git(input.source, ['cat-file', 'commit', parent]);
    const copied = git(input.repository, ['hash-object', '-t', 'commit', '-w', '--stdin'], body)
      .toString()
      .trim();
    if (copied !== parent) throw new Error('Source parent identity changed.');
  }
  const commitOid = git(
    input.repository,
    ['commit-tree', treeOid, ...parents.flatMap((parent) => ['-p', parent])],
    message,
    { ...identity, at },
  )
    .toString()
    .trim();
  // A submodule entry names a commit in another repository, so the pack leaves it out. A tree
  // built on the project's objects also leaves out what the base already holds.
  const held = input.tree
    ? new Set(
        git(input.source, ['ls-tree', '-r', '-t', '--format=%(objectname)', input.base])
          .toString()
          .trim()
          .split('\n'),
      )
    : new Set<string>();
  const objects = git(input.repository, [
    'ls-tree',
    '-r',
    '-t',
    '--format=%(objecttype) %(objectname)',
    treeOid,
  ])
    .toString()
    .trim()
    .split('\n')
    .filter((line) => line && !line.startsWith('commit '))
    .map((line) => line.slice(line.indexOf(' ') + 1))
    .filter((oid) => !held.has(oid));
  const wanted = `${[...new Set([commitOid, treeOid, ...objects])].join('\n')}\n`;
  if (input.tree) {
    // A tree built from a large scratch copy can carry more than a buffer holds, so the pack goes
    // to a file inside the new repository and index-pack reads it from there.
    const file = join(mkdtempSync(join(input.repository, 'pack-')), 'publication.pack');
    gitToFile(input.repository, ['pack-objects', '--stdout'], wanted, file);
    return { treeOid, commitOid, pack: { file } };
  }
  const pack = git(input.repository, ['pack-objects', '--stdout'], wanted);
  return { treeOid, commitOid, pack };
}
export function refValue(source: string, ref: string): string | null {
  if (!/^refs\/heads\/[a-z0-9][a-z0-9/-]{0,199}$/.test(ref))
    throw new Error('Unsupported destination ref.');
  git(source, ['check-ref-format', ref]);
  try {
    return git(source, ['rev-parse', '--verify', ref]).toString().trim();
  } catch (error) {
    if ((error as { status?: number }).status === 128) return null;
    throw error;
  }
}
export function applyPublication(input: {
  source: string;
  pack: Buffer | { file: string };
  destinationRef: string;
  treeOid: string;
  commitOid: string;
  base: string;
  /** The parents the commit must have. Absent means `base` alone. */
  parents?: readonly string[];
  /** The commit the branch must hold now. Absent means the branch must not exist. */
  expected?: string;
}) {
  const existing = refValue(input.source, input.destinationRef);
  if (existing !== null && existing === input.commitOid) return;
  if (existing !== (input.expected ?? null))
    throw new Error(
      input.expected
        ? 'The destination branch moved since it was accepted.'
        : 'The destination branch already exists. Choose an unused name.',
    );
  if (Buffer.isBuffer(input.pack)) git(input.source, ['index-pack', '--stdin'], input.pack);
  else gitFromFile(input.source, ['index-pack', '--stdin'], input.pack.file);
  const tree = git(input.source, ['rev-parse', `${input.commitOid}^{tree}`])
    .toString()
    .trim();
  if (tree !== input.treeOid) throw new Error('Imported candidate tree identity changed.');
  const parents = git(input.source, ['cat-file', 'commit', input.commitOid])
    .toString()
    .split('\n\n')[0]
    .split('\n')
    .filter((line) => line.startsWith('parent '));
  const wanted = (input.parents ?? [input.base]).map((parent) => `parent ${parent}`);
  if (parents.length !== wanted.length || parents.some((line, index) => line !== wanted[index]))
    throw new Error('Imported candidate parent identity changed.');
  git(input.source, [
    'update-ref',
    '--no-deref',
    input.destinationRef,
    input.commitOid,
    input.expected ?? '0'.repeat(input.commitOid.length),
  ]);
}
