import {
  type ChatBranchStatus,
  type ChatThread,
  type CommandResult,
  DEFAULT_REPOSITORY_POLICY,
  type RemoteEffect,
  type ReviewCommentsRead,
} from '@crewkite/contracts';

// The GitHub part of the Changes tab in the browser preview. A `state` query parameter that starts
// with gh- picks one: gh-push, gh-push-unknown, gh-pr, gh-pr-sending, gh-pr-refused, gh-pr-unknown,
// gh-open, gh-draft, gh-moved, gh-green, gh-blocked, gh-conflict and gh-merge-unknown. The thread
// starts accepted, and pushed in every state past the two push states. Writes answer from memory the way the
// controller answers them, with the same states and sentences. Nothing leaves the window.

const HEAD = 'c41f9a2e7b0d58361fa2c9e04b7d3a1586e2f09c';
const BASE_TIP = 'e81b20f7c3d9a6450b1e7f2c98d3a0b6f4c21e57';
const MERGE_COMMIT = '5a0e2d9c71b84f36e0a1c7d29b5f3e8a4c60d21b';
const BRANCH = 'feat/net-minor';
const REPO = { host: 'github.com', owner: 'crew-kite', name: 'demo-shop' };
const SITE = `https://github.com/${REPO.owner}/${REPO.name}`;
const PR = 12;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let sequence = 0;
const effectId = () => `rfx_0${String(++sequence).padStart(25, '0')}`;

type Outcome = 'applied' | 'refused' | 'unknown' | 'hang';

const API =
  "gh api --method %M --hostname github.com --header 'Accept: application/vnd.github+json' --header 'X-GitHub-Api-Version: 2022-11-28'";
const api = (method: string, path: string, input: boolean) =>
  `${API.replace('%M', method)}${input ? ' --input request.json' : ''} ${path}`;
const pulls = `/repos/${REPO.owner}/${REPO.name}/pulls`;

/** The preview the controller writes for each kind, in the same words and command form. */
function previewOf(effect: RemoteEffect): string {
  const { request, target } = effect;
  const where = `${REPO.host}/${REPO.owner}/${REPO.name}`;
  const pr = `pull request #${target.pr} on ${where}`;
  const body = (keys: string) => `request.json holds ${keys} as shown above.`;
  switch (request.kind) {
    case 'pr-open':
      return [
        `Open a ${request.draft ? 'draft ' : ''}pull request on ${where} from ${target.branch} into ${target.baseRef}, head ${target.headSha}.`,
        `Title: ${request.title}`,
        'Body:',
        request.body || '(empty)',
        '',
        'Command:',
        api('POST', pulls, true),
        body('title, body, head, base, draft'),
      ].join('\n');
    case 'pr-update':
      return [
        `Update ${pr}, head ${target.headSha}.`,
        ...(request.title === undefined ? [] : [`New title: ${request.title}`]),
        ...(request.body === undefined ? [] : ['New body:', request.body || '(empty)']),
        '',
        'Command:',
        api('PATCH', `${pulls}/${target.pr}`, true),
        body('title, body'),
      ].join('\n');
    case 'pr-ready':
    case 'pr-draft':
      return [
        request.kind === 'pr-ready'
          ? `Mark ${pr} ready for review, head ${target.headSha}.`
          : `Turn ${pr} back into a draft, head ${target.headSha}.`,
        '',
        'Command:',
        `gh pr ready ${target.pr} --repo ${where}${request.kind === 'pr-draft' ? ' --undo' : ''}`,
      ].join('\n');
    case 'review-reply':
      return [
        `Reply to review comment ${request.commentId} on ${pr} as your GitHub account.`,
        'Reply:',
        request.body,
        '',
        'Command:',
        api('POST', `${pulls}/${target.pr}/comments/${request.commentId}/replies`, true),
        body('body'),
      ].join('\n');
    case 'rerun':
      return [
        `Run ${request.failedOnly ? 'the failed jobs' : 'every job'} of workflow run ${request.runId} on ${where} again. Attempt ${request.attempt} is the newest, for ${target.headSha}.`,
        '',
        'Command:',
        api(
          'POST',
          `/repos/${REPO.owner}/${REPO.name}/actions/runs/${request.runId}/${request.failedOnly ? 'rerun-failed-jobs' : 'rerun'}`,
          false,
        ),
      ].join('\n');
    case 'merge':
      return [
        `Merge ${pr} by ${request.method}, only while its head is ${request.expectedHead}.`,
        'Branch protection and the required checks for that head are read first. A merge they do not allow is refused here, and nothing asks GitHub to bypass them.',
        '',
        'Command:',
        api('PUT', `${pulls}/${target.pr}/merge`, true),
        body('merge_method, sha'),
      ].join('\n');
    default:
      return '';
  }
}

const run = (
  id: string,
  name: string,
  conclusion: string,
  jobs: [string, string, string][],
): NonNullable<ChatBranchStatus['runs']>[number] => ({
  id,
  name,
  status: 'completed',
  conclusion,
  url: `${SITE}/actions/runs/${id}`,
  createdAt: ago(600_000),
  attempt: 1,
  jobs: jobs.map(([jobId, jobName, jobConclusion]) => ({
    id: jobId,
    name: jobName,
    status: 'completed',
    conclusion: jobConclusion,
    url: `${SITE}/actions/runs/${id}/job/${jobId}`,
  })),
});

const REVIEW: ReviewCommentsRead['files'] = [
  {
    path: 'net.mjs',
    comments: [
      {
        id: '2001',
        author: 'mira-k',
        body: 'A discount larger than the subtotal returns 0 here. Should it throw so the caller notices?',
        line: 5,
        createdAt: ago(3_600_000),
        inReplyTo: null,
        url: `${SITE}/pull/${PR}#discussion_r2001`,
      },
      {
        id: '2002',
        author: 'jon-ellis',
        body: 'Zero matches the checkout page, so I would keep it.',
        line: 5,
        createdAt: ago(3_000_000),
        inReplyTo: '2001',
        url: `${SITE}/pull/${PR}#discussion_r2002`,
      },
    ],
  },
  {
    path: 'test/net.test.mjs',
    comments: [
      {
        id: '2003',
        author: 'mira-k',
        body: 'Add a case for Number.MAX_SAFE_INTEGER + 1, so the safe integer check has a test.',
        line: 14,
        createdAt: ago(2_400_000),
        inReplyTo: null,
        url: `${SITE}/pull/${PR}#discussion_r2003`,
      },
    ],
  },
];

export type GitHubPreview = {
  /** The thread fields the state starts from. Null outside the GitHub states. */
  thread: Partial<ChatThread> | null;
  command: (
    name: string,
    payload: Record<string, unknown>,
  ) => CommandResult | Promise<CommandResult> | null;
};

export function githubPreview(
  state: string | null,
  taskId: string,
  host: {
    publish: (type: string, payload: unknown) => void;
    /** Changes the scripted thread, the way a merge check moves it. */
    patch: (thread: Partial<ChatThread>) => void;
  },
): GitHubPreview {
  if (!state?.startsWith('gh-')) return { thread: null, command: () => null };
  const pushed = state !== 'gh-push' && state !== 'gh-push-unknown';
  const opened = ![
    'gh-push',
    'gh-push-unknown',
    'gh-pr',
    'gh-pr-sending',
    'gh-pr-refused',
    'gh-pr-unknown',
  ].includes(state);
  const outcome: Outcome =
    state === 'gh-pr-sending'
      ? 'hang'
      : state === 'gh-pr-refused'
        ? 'refused'
        : state === 'gh-pr-unknown' || state === 'gh-merge-unknown'
          ? 'unknown'
          : 'applied';
  const at = ago(900_000);
  const effects: RemoteEffect[] = [];
  const target = { repo: REPO, branch: BRANCH, pr: PR, headSha: HEAD, baseRef: 'main' };
  if (opened)
    effects.push({
      id: effectId(),
      taskId,
      kind: 'pr-open',
      state: 'applied',
      target: { ...target, pr: null },
      request: {
        kind: 'pr-open',
        title: 'feat: add netMinor(subtotalMinor, discountMinor)',
        body: 'Changed files (2):\n- net.mjs +5 -2\n- test/net.test.mjs +18 -0',
        draft: state === 'gh-draft',
      },
      confirmation: { at, by: 'person' },
      observed: { at, result: 'applied', created: { pr: PR } },
      reason: null,
    });

  const changed = (effect: RemoteEffect) => {
    const at = effects.findIndex(({ id }) => id === effect.id);
    if (at === -1) effects.push(effect);
    else effects[at] = effect;
    const { id, kind, state, reason } = effect;
    host.publish('remote-effect.updated', { id, kind, state, reason });
  };
  const answer = (effect: RemoteEffect, next?: string): CommandResult => {
    const data = { kind: 'remote-effect' as const, effect, preview: previewOf(effect) };
    if (effect.state === 'refused')
      return {
        outcome: 'blocked',
        reason: 'remote-write-refused',
        next: effect.reason ?? '',
        data,
      };
    if (effect.state === 'unknown')
      return {
        outcome: 'blocked',
        reason: 'remote-result-unknown',
        next: `${effect.reason} Reconcile it to read what the remote holds. CrewKite never sends it again on its own.`,
        data,
      };
    return { outcome: 'applied', data, ...(next ? { next } : {}) };
  };
  const propose = (payload: Record<string, unknown>): RemoteEffect => {
    const request = payload.request as RemoteEffect['request'];
    const effect = {
      id: effectId(),
      taskId,
      kind: request.kind,
      state: 'proposed',
      target: payload.target as RemoteEffect['target'],
      request,
      confirmation: null,
      observed: null,
      reason: null,
    } as RemoteEffect;
    changed(effect);
    return effect;
  };
  const created = (effect: RemoteEffect) => {
    switch (effect.request.kind) {
      case 'pr-open':
        return { pr: PR };
      case 'review-reply':
        return { id: '2101' };
      case 'rerun':
        return { attempt: effect.request.attempt + 1 };
      case 'merge':
        return { sha: MERGE_COMMIT };
      default:
        return null;
    }
  };
  const applied = (effect: RemoteEffect): RemoteEffect => ({
    ...effect,
    state: 'applied',
    observed: { at: ago(0), result: 'applied', created: created(effect) },
    reason: null,
  });

  const runs =
    state === 'gh-open'
      ? [
          run('9001', 'verify', 'success', [['31', 'verify', 'success']]),
          run('9002', 'e2e', 'failure', [
            ['32', 'e2e / checkout', 'success'],
            ['33', 'e2e / browser', 'failure'],
          ]),
        ]
      : [
          run('9001', 'verify', 'success', [['31', 'verify', 'success']]),
          run('9002', 'e2e', 'success', [
            ['32', 'e2e / checkout', 'success'],
            ['33', 'e2e / browser', 'success'],
          ]),
        ];

  function command(
    name: string,
    payload: Record<string, unknown>,
  ): CommandResult | Promise<CommandResult> | null {
    const read = (data: unknown) => ({ outcome: 'applied', data }) as CommandResult;
    const find = () => effects.find(({ id }) => id === payload.effectId);
    switch (name) {
      case 'ReadRemoteEffects':
        return read({ kind: 'remote-effects', taskId, effects: structuredClone(effects) });
      case 'ReadRepositoryPolicy':
        return read({
          kind: 'repository-policy',
          projectId: payload.projectId,
          policy: DEFAULT_REPOSITORY_POLICY,
          updatedAt: null,
        });
      case 'ReadChatBranchStatus':
        return read({
          kind: 'chat-branch-status',
          branch: BRANCH,
          runs,
          commit: HEAD,
          headMoved: state === 'gh-moved',
          reason: null,
          readAt: ago(0),
        });
      case 'ReadReviewComments':
        return state === 'gh-moved'
          ? {
              outcome: 'blocked',
              reason: 'review-comments-unreadable',
              next: `The pull request head is no longer ${HEAD.slice(0, 12)}.`,
            }
          : read({
              kind: 'review-comments',
              taskId,
              repo: REPO,
              pr: PR,
              headSha: HEAD,
              readAt: ago(0),
              files: REVIEW,
              truncated: false,
            });
      case 'OpenChatPullRequest': {
        const effect = propose({
          target: { ...target, pr: null },
          request: {
            kind: 'pr-open',
            title: String(payload.title),
            body: String(payload.body ?? '') || 'Changed files (1):\n- net.mjs +5 -2',
            draft: false,
          },
        });
        return {
          outcome: 'blocked',
          reason: 'pull-request-needs-confirmation',
          next: 'The pull request is proposed and waits for you to confirm its preview. Nothing was sent.',
          data: { kind: 'remote-effect', effect, preview: previewOf(effect) },
        };
      }
      case 'ProposeRemoteEffect': {
        const request = payload.request as RemoteEffect['request'];
        if (request.kind === 'merge' && state === 'gh-conflict')
          return {
            outcome: 'blocked',
            reason: 'merge-conflicts',
            next: `${HEAD.slice(0, 7)} conflicts with origin/main at ${BASE_TIP.slice(0, 7)} in net.mjs. Resolve the conflicts, then merge.`,
            data: {
              kind: 'chat-merge-check',
              state: 'conflicts',
              base: BASE_TIP,
              paths: ['net.mjs'],
            },
          };
        if (request.kind === 'merge' && state === 'gh-blocked')
          return {
            outcome: 'blocked',
            reason: 'merge-not-ready',
            next: 'Branch protection blocks this merge. Get the reviews or checks it asks for, then merge.',
          };
        const effect = propose(payload);
        return answer(
          effect,
          request.kind === 'merge'
            ? `Required checks green on ${HEAD.slice(0, 12)}: e2e, verify. No review or rule GitHub enforces blocks it.`
            : undefined,
        );
      }
      case 'PushChatBranch': {
        // The push dies after sending, so its row stays unknown where Push was.
        if (state !== 'gh-push-unknown') return null;
        const commit = String(payload.commit);
        changed({
          id: effectId(),
          taskId,
          kind: 'push',
          state: 'unknown',
          target: { repo: REPO, branch: BRANCH, pr: null, headSha: commit, baseRef: null },
          request: { kind: 'push', remote: 'origin', commit, expectedRemote: null },
          confirmation: { at: ago(0), by: 'person' },
          observed: null,
          reason: 'git ended without a result CrewKite can trust: Connection reset by peer.',
        });
        return {
          outcome: 'blocked',
          reason: 'remote-result-unknown',
          next: 'git ended without a result CrewKite can trust: Connection reset by peer. Reconcile it to read what the remote holds. CrewKite never sends it again on its own.',
        };
      }
      case 'ReadRemoteEffectPreview': {
        const effect = find();
        if (!effect) return { outcome: 'blocked', reason: 'remote-effect-not-found' };
        return read({ kind: 'remote-effect', effect, preview: previewOf(effect) });
      }
      case 'ReadMergeReadiness': {
        const blocked = state === 'gh-blocked';
        return read({
          kind: 'merge-readiness',
          taskId,
          repo: REPO,
          pr: PR,
          headSha: HEAD,
          readAt: ago(0),
          checks: [
            { name: 'e2e', state: 'green' },
            { name: 'verify', state: 'green' },
          ],
          mergeState: blocked ? 'blocked' : 'clean',
          reason: blocked
            ? 'Branch protection blocks this merge. Get the reviews or checks it asks for, then merge.'
            : null,
          line: blocked
            ? null
            : `Required checks green on ${HEAD.slice(0, 12)}: e2e, verify. No review or rule GitHub enforces blocks it.`,
        });
      }
      case 'ConfirmRemoteEffect': {
        const effect = find();
        if (!effect) return { outcome: 'blocked', reason: 'remote-effect-not-found' };
        const confirmed: RemoteEffect = {
          ...effect,
          state: 'confirmed',
          confirmation: { at: ago(0), by: 'person' },
        };
        changed(confirmed);
        if (outcome === 'hang') return new Promise<CommandResult>(() => {});
        const ended: RemoteEffect =
          outcome === 'refused'
            ? {
                ...confirmed,
                state: 'refused',
                observed: { at: ago(0), result: 'refused', created: null },
                reason: `Validation Failed: No commits between main and ${BRANCH}.`,
              }
            : outcome === 'unknown'
              ? {
                  ...confirmed,
                  state: 'unknown',
                  reason: 'gh ended without a result CrewKite can trust: connection reset by peer.',
                }
              : applied(confirmed);
        changed(ended);
        return answer(ended);
      }
      case 'CancelRemoteEffect': {
        const effect = find();
        if (!effect) return { outcome: 'blocked', reason: 'remote-effect-not-found' };
        const cancelled: RemoteEffect = { ...effect, state: 'cancelled' };
        changed(cancelled);
        return answer(cancelled);
      }
      case 'ReconcileRemoteEffect': {
        const effect = find();
        if (!effect) return { outcome: 'blocked', reason: 'remote-effect-not-found' };
        // The merge's read cannot reach GitHub here. The push's read finds nothing while its
        // process still runs. Either way the person can settle the write by hand.
        if (state === 'gh-merge-unknown')
          return {
            ...answer(effect),
            reason: 'remote-unreadable',
            next: 'The remote could not be read, so the write stays unknown. error connecting to api.github.com',
          };
        if (state === 'gh-push-unknown')
          return {
            ...answer(effect),
            reason: 'remote-write-may-land',
            next: 'The remote shows nothing yet, and the process that sent this write still runs. Reconcile again once it has ended.',
          };
        const settled = applied(effect);
        changed(settled);
        return answer(settled);
      }
      case 'SettleRemoteEffect': {
        const effect = find();
        if (!effect) return { outcome: 'blocked', reason: 'remote-effect-not-found' };
        const done = payload.outcome === 'applied';
        const settled: RemoteEffect = {
          ...effect,
          state: done ? 'applied' : 'refused',
          reason: done
            ? 'You checked GitHub and marked this as done.'
            : 'You checked GitHub and marked this as not sent.',
          settled: { at: ago(0), by: 'person', note: String(payload.note) },
        };
        changed(settled);
        return read({ kind: 'remote-effect', effect: settled, preview: previewOf(settled) });
      }
      case 'CheckChatMerge':
        host.patch({
          pendingMerge: { remote: 'origin', branch: 'main', target: BRANCH, paths: ['net.mjs'] },
        });
        return {
          outcome: 'applied',
          reason: 'merge-conflicts',
          next: `The fixer resolves 1 file in the copy. Accept the result to ${BRANCH}, then push it.`,
          data: {
            kind: 'chat-merge-check',
            state: 'conflicts',
            base: BASE_TIP,
            paths: ['net.mjs'],
          },
        };
      default:
        return null;
    }
  }

  return {
    thread: {
      lastAcceptance: { branch: BRANCH, at, fileCount: 1, commit: HEAD },
      lastPush: pushed
        ? {
            branch: BRANCH,
            remote: 'origin',
            commit: HEAD,
            at,
            pullRequestUrl: opened ? `${SITE}/pull/${PR}` : null,
          }
        : null,
    },
    command,
  };
}
