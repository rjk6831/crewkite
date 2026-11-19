import type {
  ChatBranchStatus,
  GitHubRepository,
  RemoteEffect,
  RepositoryPolicy,
  ReviewComment,
} from '@crewkite/contracts';

// How the Changes tab shows the thread's GitHub writes and the pull request they act on. Every
// value here comes from the controller's records, so a window that opens later shows the same.

export type WriteAction = 'confirm' | 'cancel' | 'check';
export type WriteView = {
  label: 'Waiting for you' | 'Sending' | 'Done' | 'Refused' | 'Not sent' | 'Unknown' | 'Cancelled';
  tone: 'waiting' | 'busy' | 'done' | 'refused' | 'unknown' | 'quiet';
  /** GitHub's reason, the controller's note, or the line for a result nobody can tell. */
  text: string | null;
  actions: readonly WriteAction[];
};

export const UNKNOWN_LINE = 'CrewKite cannot tell whether GitHub took this. Check it.';

/**
 * One write's state in words and the actions it allows. `sending` is this window's own confirm
 * still on its way, so a proposal reads as sending before its record says so. Cancel exists only
 * while nothing was sent, and Check only while the result is unknown. A write the person settled
 * after checking GitHub says so, and one they marked as not sent reads Not sent.
 */
export function writeView(
  effect: Pick<RemoteEffect, 'state' | 'reason' | 'settled'>,
  sending = false,
): WriteView {
  switch (effect.state) {
    case 'proposed':
      return sending
        ? { label: 'Sending', tone: 'busy', text: null, actions: [] }
        : { label: 'Waiting for you', tone: 'waiting', text: null, actions: ['confirm', 'cancel'] };
    case 'confirmed':
      return { label: 'Sending', tone: 'busy', text: null, actions: sending ? [] : ['cancel'] };
    case 'sent':
      return { label: 'Sending', tone: 'busy', text: null, actions: [] };
    case 'applied':
      return { label: 'Done', tone: 'done', text: effect.reason, actions: [] };
    case 'refused':
      if (effect.settled)
        return { label: 'Not sent', tone: 'quiet', text: effect.reason, actions: [] };
      return {
        label: 'Refused',
        tone: 'refused',
        text: effect.reason ?? 'GitHub refused it, and nothing changed there.',
        actions: [],
      };
    case 'unknown':
      return { label: 'Unknown', tone: 'unknown', text: UNKNOWN_LINE, actions: ['check'] };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'quiet', text: null, actions: [] };
  }
}

/**
 * The write a row shows: the newest that matches, unless it was cancelled, or it ended applied
 * before this window touched it. A refusal stays until a newer write of its kind.
 */
export function shownWrite(
  effects: readonly RemoteEffect[],
  match: (effect: RemoteEffect) => boolean,
  touched: ReadonlySet<string>,
): RemoteEffect | null {
  const newest = effects.findLast(match);
  if (!newest || newest.state === 'cancelled') return null;
  if (newest.state === 'applied' && !touched.has(newest.id)) return null;
  return newest;
}

/** A write that still holds its kind: it waits, runs or has no known result. */
export const writeOpen = (effect: RemoteEffect | null) =>
  effect !== null && ['proposed', 'confirmed', 'sent', 'unknown'].includes(effect.state);

/**
 * The push the Changes tab shows. One still running or unknown holds every push of the thread
 * until it settles, so it shows whatever branch it went to. Otherwise the newest push of `branch`.
 */
export function pushShown(
  effects: readonly RemoteEffect[],
  branch: string,
  touched: ReadonlySet<string>,
): RemoteEffect | null {
  return (
    effects.findLast(
      (effect) => effect.kind === 'push' && ['confirmed', 'sent', 'unknown'].includes(effect.state),
    ) ??
    shownWrite(
      effects,
      (effect) => effect.kind === 'push' && effect.target.branch === branch,
      touched,
    )
  );
}

export type PullRequestView = {
  repo: GitHubRepository;
  number: number;
  url: string;
  baseRef: string | null;
  draft: boolean;
  /** The merge commit, once a merge from this thread applied. */
  merged: string | null;
};

/**
 * The pull request this thread opened from `branch`, read from its writes: the number GitHub gave
 * it, draft or ready by the newest of the open, ready and draft writes that applied, and the merge
 * commit once a merge applied.
 */
export function pullRequestOf(
  effects: readonly RemoteEffect[],
  branch: string,
): PullRequestView | null {
  const opened = effects.findLast(
    (effect) =>
      effect.request.kind === 'pr-open' &&
      effect.target.branch === branch &&
      effect.state === 'applied' &&
      Boolean(effect.observed?.created?.pr),
  );
  const number = opened?.observed?.created?.pr;
  if (opened?.request.kind !== 'pr-open' || !number) return null;
  let draft = opened.request.draft;
  let merged: string | null = null;
  for (const effect of effects.slice(effects.indexOf(opened) + 1)) {
    if (effect.state !== 'applied' || effect.target.pr !== number) continue;
    if (effect.kind === 'pr-ready' || effect.kind === 'pr-draft')
      draft = effect.kind === 'pr-draft';
    if (effect.kind === 'merge') merged = effect.observed?.created?.sha ?? null;
  }
  const { repo } = opened.target;
  return {
    repo,
    number,
    url: `https://${repo.host}/${repo.owner}/${repo.name}/pull/${number}`,
    baseRef: opened.target.baseRef,
    draft,
    merged,
  };
}

const GREEN = new Set(['success', 'neutral', 'skipped']);

/**
 * One line for the checks on the head, and why Merge waits while they are not green. The runs are
 * every run on the head, read before the merge's own read of what the base requires.
 */
export function checksSummary(status: Pick<ChatBranchStatus, 'runs' | 'commit' | 'reason'>): {
  line: string;
  wait: string | null;
} {
  const head = status.commit?.slice(0, 7) ?? 'the head';
  const runs = status.runs;
  if (!runs) return { line: status.reason ?? 'The checks could not be read.', wait: null };
  if (!runs.length) return { line: `No checks ran on ${head}.`, wait: null };
  const running = runs.filter((run) => run.status !== 'completed');
  const red = runs.filter((run) => run.status === 'completed' && !GREEN.has(run.conclusion ?? ''));
  const passed = runs.length - running.length - red.length;
  if (red.length)
    return {
      line: `${red.map((run) => run.name).join(', ')} did not pass on ${head}. ${passed} of ${runs.length} passed.`,
      wait: `A check did not pass on ${head}. Rerun it or fix it, then merge.`,
    };
  if (running.length)
    return {
      line: `${running.length} of ${runs.length} checks still running on ${head}.`,
      wait: `Checks are still running on ${head}.`,
    };
  return {
    line: `${runs.length === 1 ? '1 check' : `${runs.length} checks`} passed on ${head}.`,
    wait: null,
  };
}

/**
 * Why Merge cannot be proposed now, or null when the controller's read decides. `refused` is that
 * read's own reason, such as a review branch protection asks for, while it still applies.
 */
export function mergeWait(input: {
  headMoved: boolean;
  draft: boolean;
  head: string;
  checks: { wait: string | null };
  refused?: string | null;
}): string | null {
  if (input.headMoved)
    return `The branch moved on GitHub after ${input.head.slice(0, 7)}, so this head cannot merge.`;
  if (input.draft) return 'The pull request is a draft. Mark it ready for review, then merge.';
  return input.checks.wait ?? input.refused ?? null;
}

export const MERGE_LABELS: Record<RepositoryPolicy['mergeMethod'], string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
};

/**
 * The fixer's message for review comments the person picked. Each comment is quoted as the
 * reviewer wrote it, with the file and line it sits on.
 */
export function reviewBrief(input: {
  pr: number;
  head: string;
  comments: readonly (Pick<ReviewComment, 'author' | 'body' | 'line'> & { path: string })[];
}): string {
  return [
    `The person picked these review comments from pull request #${input.pr} (head ${input.head.slice(0, 12)}) for you to address in the scratch copy. Change what each one asks for and nothing else. Read a file before you change it.`,
    ...input.comments.map(
      (comment) =>
        `${comment.path}${comment.line ? `, line ${comment.line}` : ''}, from ${comment.author}:\n\n${comment.body
          .trim()
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}`,
    ),
  ].join('\n\n');
}
