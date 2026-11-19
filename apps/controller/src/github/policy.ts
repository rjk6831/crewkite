import {
  branchPatternRegExp,
  type Command,
  type CommandResult,
  DEFAULT_REPOSITORY_POLICY,
  type PolicyViolation,
  type RepositoryPolicy,
} from '@crewkite/contracts';
import type { GitIdentity } from '../host/publication.ts';
import type { Store } from '../store/index.ts';

// A type, an optional scope in parentheses, an optional ! for a breaking change, then the summary.
const CONVENTIONAL = /^[a-z]+(?:\([^()\s]+\))?!?: \S/;
// A co-author trailer, a generated-with or generated-by line, and a link to a tool's session. Each
// pattern needs the marker at the start of the line or a session URL, so plain prose passes.
const ATTRIBUTION = [
  /^\s*co-authored-by:/i,
  /^\W*generated[ -](?:with|by)\b/i,
  /https?:\/\/\S*\/sessions?[_/]/i,
];
const SIGN_OFF = /^signed-off-by:/i;
const TRAILER = /^[A-Za-z0-9-]+: \S/;

/** A commit or branch the project's policy refuses. Nothing was written. */
export class PolicyRefused extends Error {
  readonly violation: PolicyViolation;
  constructor(violation: PolicyViolation) {
    super(violation.message);
    this.violation = violation;
  }
}

/** The answer to a refused commit: the rule it broke and what to change. */
export const policyBlocked = ({ rule, message }: PolicyViolation): CommandResult => ({
  outcome: 'blocked',
  reason: `policy-${rule}`,
  next: message,
});

/** The project's saved policy, or the default until the person sets one. */
export const repositoryPolicy = (store: Store, projectId: string): RepositoryPolicy =>
  store.repositoryPolicy(projectId)?.policy ?? DEFAULT_REPOSITORY_POLICY;

const refused = (rule: PolicyViolation['rule'], message: string) =>
  new PolicyRefused({ rule, message });
const clip = (line: string) => (line.length > 80 ? `${line.slice(0, 80)}...` : line);

/**
 * The attribution line the policy refuses in a commit message or in pull request text, as the
 * violation to report. `retry` says what the person does once the line is gone.
 */
export function attributionViolation(
  policy: RepositoryPolicy,
  text: string,
  retry: string,
): PolicyViolation | undefined {
  if (policy.attribution !== 'off') return;
  const line = text.split('\n').find((entry) => ATTRIBUTION.some((pattern) => pattern.test(entry)));
  if (line === undefined) return;
  return {
    rule: 'attribution',
    message: `This project refuses co-author, generated-by and session lines. Remove "${clip(line.trim())}" and ${retry}.`,
  };
}

/**
 * Checks one commit and the branch it goes on against the project's policy, and returns the
 * message to commit. When the policy wants a sign-off and the message has none, the sign-off is
 * added for the identity that makes the commit, the way `git commit -s` adds it. Nothing else in
 * the message changes. A message with an attribution line is refused, never stripped, so a commit
 * says what the person wrote. The first broken rule throws `PolicyRefused`.
 */
export function checkCommit(
  policy: RepositoryPolicy,
  commit: { message: string; destinationRef: string; identity: GitIdentity | undefined },
): { message: string; identity: GitIdentity } {
  const branch = commit.destinationRef.replace(/^refs\/heads\//, '');
  if (!branchPatternRegExp(policy.branchPattern).test(branch))
    throw refused(
      'branch-name',
      `This project names branches to match ${policy.branchPattern}. Rename the branch and accept again.`,
    );
  const lines = commit.message.split('\n');
  const subject = lines[0];
  if (policy.conventionalCommits && !CONVENTIONAL.test(subject))
    throw refused(
      'conventional',
      'This project uses Conventional Commits. Start the subject with a type, as in "fix: round totals", and accept again.',
    );
  const length = [...subject].length;
  if (length > policy.subjectMax)
    throw refused(
      'subject-length',
      `The subject is ${length} characters and this project allows ${policy.subjectMax}. Shorten it and accept again.`,
    );
  const attribution = attributionViolation(policy, commit.message, 'accept again');
  if (attribution) throw new PolicyRefused(attribution);
  const identity = commit.identity;
  if (!identity)
    throw refused(
      'identity',
      policy.identity === 'repository'
        ? 'Set a Git name and email for this repository, then accept again.'
        : 'Set a global Git name and email, then accept again.',
    );
  if (!policy.signOff) return { message: commit.message, identity };
  // A sign-off certifies where the change came from. Only the person committing can give it here.
  const own = `${identity.name} <${identity.email}>`;
  const signed = lines.filter((line) => SIGN_OFF.test(line));
  if (signed.some((line) => line.slice('Signed-off-by:'.length).trim() !== own))
    throw refused(
      'sign-off',
      'Each Signed-off-by line here names the identity making the commit. Remove the others and accept again.',
    );
  if (signed.length) return { message: commit.message, identity };
  // Git joins a trailer block that ends the message. Otherwise the sign-off starts its own.
  const body = commit.message.trimEnd();
  const paragraphs = body.split(/\n[ \t]*\n/);
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1].split('\n') : [];
  const joins = last.length > 0 && last.every((line) => TRAILER.test(line));
  return { message: `${body}${joins ? '\n' : '\n\n'}Signed-off-by: ${own}\n`, identity };
}

export type PolicyCommand = Extract<
  Command,
  { command: 'ReadRepositoryPolicy' | 'SetRepositoryPolicy' }
>;

/**
 * Reads or replaces one project's policy. Both answer with the policy the next commit meets, and
 * a project with no saved policy reads the default with no save time.
 */
export function policyCommand(
  deps: {
    store: Store;
    now: () => string;
    projectPath: (projectId: string) => string | undefined;
  },
  command: PolicyCommand,
): CommandResult {
  const { projectId } = command.payload;
  if (!deps.projectPath(projectId))
    return {
      outcome: 'blocked',
      reason: 'project-not-found',
      next: 'Choose a registered project.',
    };
  if (command.command === 'SetRepositoryPolicy')
    deps.store.putRepositoryPolicy(projectId, command.payload.policy, deps.now());
  const saved = deps.store.repositoryPolicy(projectId);
  return {
    outcome: 'applied',
    data: {
      kind: 'repository-policy',
      projectId,
      policy: saved?.policy ?? DEFAULT_REPOSITORY_POLICY,
      updatedAt: saved?.updatedAt ?? null,
    },
  };
}
