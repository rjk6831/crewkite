import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TimestampSchema } from '@crewkite/contracts';
import { type FileContent, git, treeFromFiles } from './source.ts';

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
export function configuredIdentity(directory: string): GitIdentity | undefined {
  try {
    const read = (key: string) =>
      execFileSync('git', ['config', '--global', '--includes', '--get', key], {
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

export function preparePublication(input: {
  source: string;
  repository: string;
  base: string;
  files: FileContent[];
  identity: GitIdentity;
  at: string;
  /** Chat acceptance names the thread. Candidates keep the checked-candidate message. */
  message?: string;
}) {
  if (input.base.length !== 40)
    throw new Error('Publication from this Git object format is unsupported in D0.');
  const identity = validateIdentity(input.identity);
  const at = TimestampSchema.parse(input.at);
  const treeOid = treeFromFiles(input.repository, input.files);
  const parent = git(input.source, ['cat-file', 'commit', input.base]);
  const copied = git(input.repository, ['hash-object', '-t', 'commit', '-w', '--stdin'], parent)
    .toString()
    .trim();
  if (copied !== input.base) throw new Error('Source parent identity changed.');
  const commitOid = git(
    input.repository,
    ['commit-tree', treeOid, '-p', input.base],
    input.message ??
      `feat: apply checked task candidate\n\nApply the accepted candidate after its required checks.\n\nSigned-off-by: ${identity.name} <${identity.email}>\n`,
    { ...identity, at },
  )
    .toString()
    .trim();
  const objects = git(input.repository, ['ls-tree', '-r', '-t', '--format=%(objectname)', treeOid])
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  const pack = git(
    input.repository,
    ['pack-objects', '--stdout'],
    `${[...new Set([commitOid, treeOid, ...objects])].join('\n')}\n`,
  );
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
  pack: Buffer;
  destinationRef: string;
  treeOid: string;
  commitOid: string;
  base: string;
}) {
  const existing = refValue(input.source, input.destinationRef);
  if (existing !== null) {
    if (existing === input.commitOid) return;
    throw new Error('The destination branch already exists. Choose an unused name.');
  }
  git(input.source, ['index-pack', '--stdin'], input.pack);
  const tree = git(input.source, ['rev-parse', `${input.commitOid}^{tree}`])
    .toString()
    .trim();
  if (tree !== input.treeOid) throw new Error('Imported candidate tree identity changed.');
  const parents = git(input.source, ['cat-file', 'commit', input.commitOid])
    .toString()
    .split('\n\n')[0]
    .split('\n')
    .filter((line) => line.startsWith('parent '));
  if (parents.length !== 1 || parents[0] !== `parent ${input.base}`)
    throw new Error('Imported candidate parent identity changed.');
  git(input.source, [
    'update-ref',
    '--no-deref',
    input.destinationRef,
    input.commitOid,
    '0'.repeat(input.commitOid.length),
  ]);
}
