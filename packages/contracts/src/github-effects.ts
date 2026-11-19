import { z } from 'zod';
import { AcceptChatChangesPayloadSchema } from './chat.ts';

// Commit and branch policy per repository, and every write CrewKite makes to a GitHub remote. A
// write starts as a proposal the person reads, needs their confirmation before it is sent, and is
// journaled before and after. When the result is unknown, a read of the remote settles it; nothing
// sends the same write again on a guess.

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
const timestamp = z.iso.datetime();
const objectId = z.string().regex(/^[a-f0-9]{40}$/);
const githubId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const branch = AcceptChatChangesPayloadSchema.shape.branch;
const bounded = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) => value.isWellFormed() && new TextEncoder().encode(value).byteLength <= max,
      `Text exceeds ${max} bytes.`,
    );

export const GitHubRepositorySchema = z.strictObject({
  host: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/),
  owner: z.string().regex(/^(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/),
  name: z.string().regex(/^(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/),
});
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;

export const MergeMethodSchema = z.enum(['squash', 'merge', 'rebase']);

/**
 * The expression a branch name must match whole. The source is wrapped as `^(?:source)$`, so an
 * alternation in it cannot match only part of a name.
 */
export const branchPatternRegExp = (source: string): RegExp => new RegExp(`^(?:${source})$`);

const branchPattern = z
  .string()
  .min(1)
  .max(200)
  .refine((source) => {
    try {
      branchPatternRegExp(source);
      return true;
    } catch {
      return false;
    }
  }, 'A branch pattern is a regular expression that compiles.');

export const RepositoryPolicySchema = z.strictObject({
  conventionalCommits: z.boolean(),
  subjectMax: z.number().int().min(20).max(200),
  signOff: z.boolean(),
  /** repository: the identity the project's own Git config resolves. global: the user's. */
  identity: z.enum(['repository', 'global']),
  /** off refuses co-author, generated-by and session-link lines in commits and PR text. */
  attribution: z.enum(['off', 'allowed']),
  branchPattern,
  mergeMethod: MergeMethodSchema,
});
export type RepositoryPolicy = z.infer<typeof RepositoryPolicySchema>;

/** The policy a project has until the person sets one. It matches this repository's own rules. */
export const DEFAULT_REPOSITORY_POLICY: RepositoryPolicy = Object.freeze({
  conventionalCommits: true,
  subjectMax: 72,
  signOff: true,
  identity: 'repository',
  attribution: 'off',
  branchPattern: '(feat|fix|docs|refactor|perf|test|build|ci|chore|revert)/[a-z0-9-]+',
  mergeMethod: 'squash',
});

/**
 * The commit subject CrewKite suggests for a thread title: a feat type, then the title. A first
 * word of letters with one capital, such as "Add", goes to lower case. Code such as netMinor or
 * README stays as written. A title too long for `subjectMax` is cut at a word, so the default
 * policy takes the subject as it stands.
 */
export function suggestedSubject(
  title: string,
  subjectMax: number = DEFAULT_REPOSITORY_POLICY.subjectMax,
): string {
  const text = title.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const subject = `feat: ${text.replace(/^[A-Z][a-z]*(?=\s|$)/, (word) => word.toLowerCase())}`;
  const characters = [...subject];
  if (characters.length <= subjectMax) return subject;
  const cut = characters.slice(0, subjectMax + 1).join('');
  const space = cut.lastIndexOf(' ');
  const kept =
    space > 'feat: '.length ? cut.slice(0, space) : characters.slice(0, subjectMax).join('');
  return kept.replace(/[\s,;:(-]+$/, '');
}

export const PolicyViolationSchema = z.strictObject({
  rule: z.enum([
    'conventional',
    'subject-length',
    'sign-off',
    'identity',
    'attribution',
    'branch-name',
  ]),
  message: z.string().min(1).max(300),
});
export type PolicyViolation = z.infer<typeof PolicyViolationSchema>;

export const ReadRepositoryPolicyPayloadSchema = z.strictObject({ projectId: id('prj') });
export const RepositoryPolicyReadSchema = z.strictObject({
  projectId: id('prj'),
  policy: RepositoryPolicySchema,
  /** Null while the project uses the default. */
  updatedAt: timestamp.nullable(),
});
export type RepositoryPolicyRead = z.infer<typeof RepositoryPolicyReadSchema>;
export const SetRepositoryPolicyPayloadSchema = z.strictObject({
  projectId: id('prj'),
  policy: RepositoryPolicySchema,
});

export const RemoteEffectIdSchema = id('rfx');
export const RemoteEffectKindSchema = z.enum([
  'push',
  'pr-open',
  'pr-update',
  'pr-ready',
  'pr-draft',
  'review-reply',
  'rerun',
  'merge',
]);
export type RemoteEffectKind = z.infer<typeof RemoteEffectKindSchema>;
/**
 * proposed: waiting for the person. confirmed: they confirmed it and nothing was sent yet.
 * sent: the process started. unknown: it ended without a result CrewKite can trust.
 */
export const RemoteEffectStateSchema = z.enum([
  'proposed',
  'confirmed',
  'sent',
  'applied',
  'refused',
  'unknown',
  'cancelled',
]);
export type RemoteEffectState = z.infer<typeof RemoteEffectStateSchema>;

/** What one write sends. Each kind carries only its own fields. */
export const RemoteEffectRequestSchema = z.discriminatedUnion('kind', [
  /** Pushes the accepted commit itself. `expectedRemote` null means the branch must not exist. */
  z.strictObject({
    kind: z.literal('push'),
    remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    commit: objectId,
    expectedRemote: objectId.nullable(),
  }),
  z.strictObject({
    kind: z.literal('pr-open'),
    title: bounded(256, 1),
    body: bounded(16_384),
    draft: z.boolean(),
  }),
  z
    .strictObject({
      kind: z.literal('pr-update'),
      title: bounded(256, 1).optional(),
      body: bounded(16_384).optional(),
    })
    .refine(
      (request) => request.title !== undefined || request.body !== undefined,
      'An update changes the title or the body.',
    ),
  z.strictObject({ kind: z.literal('pr-ready') }),
  z.strictObject({ kind: z.literal('pr-draft') }),
  z.strictObject({
    kind: z.literal('review-reply'),
    commentId: githubId,
    body: bounded(16_384, 1),
  }),
  z.strictObject({
    kind: z.literal('rerun'),
    runId: githubId,
    attempt: z.number().int().min(1).max(10000),
    failedOnly: z.boolean(),
  }),
  /** Merges only while the pull request head is still `expectedHead`. */
  z.strictObject({
    kind: z.literal('merge'),
    method: MergeMethodSchema,
    expectedHead: objectId,
  }),
]);
export type RemoteEffectRequest = z.infer<typeof RemoteEffectRequestSchema>;

export const RemoteEffectTargetSchema = z.strictObject({
  repo: GitHubRepositorySchema,
  branch: branch.nullable(),
  pr: z.number().int().min(1).nullable(),
  headSha: objectId.nullable(),
  baseRef: branch.nullable(),
});
export type RemoteEffectTarget = z.infer<typeof RemoteEffectTargetSchema>;

/** States that exist only after the person confirmed. Refused and cancelled can come either side. */
const confirmedStates: readonly RemoteEffectState[] = ['confirmed', 'sent', 'applied', 'unknown'];

/**
 * Each write names exactly what it acts on. A push names the branch and pushes the commit it names
 * as its head. A new pull request names its head branch, base and head commit. Every other write
 * names the pull request and the head it saw, and a merge merges only that head.
 */
function targetFits(target: RemoteEffectTarget, request: RemoteEffectRequest): boolean {
  switch (request.kind) {
    case 'push':
      return target.branch !== null && target.headSha === request.commit;
    case 'pr-open':
      return target.branch !== null && target.baseRef !== null && target.headSha !== null;
    case 'merge':
      return target.pr !== null && target.headSha === request.expectedHead;
    default:
      return target.pr !== null && target.headSha !== null;
  }
}
const targetMessage = 'The target names what this kind of write acts on.';

/** What a send or a later read of the remote showed. `created` names what the write made. */
const observed = z.strictObject({
  at: timestamp,
  result: z.enum(['applied', 'absent', 'refused']),
  created: z
    .strictObject({
      pr: z.number().int().min(1).optional(),
      sha: objectId.optional(),
      id: githubId.optional(),
      attempt: z.number().int().min(1).max(10000).optional(),
    })
    .nullable(),
});

/** What the person wrote when they settled a write after checking GitHub themselves. */
const settlementNote = bounded(300, 1).regex(/\S/, 'Say what you saw on GitHub.');

export const RemoteEffectSchema = z
  .strictObject({
    id: RemoteEffectIdSchema,
    taskId: id('tsk'),
    kind: RemoteEffectKindSchema,
    state: RemoteEffectStateSchema,
    target: RemoteEffectTargetSchema,
    request: RemoteEffectRequestSchema,
    confirmation: z.strictObject({ at: timestamp, by: z.literal('person') }).nullable(),
    observed: observed.nullable(),
    reason: z.string().min(1).max(300).nullable(),
    /**
     * Set when a read of the remote could not settle an unknown write and the person did, after
     * checking GitHub. Applied or refused then rests on their word. No read observed it.
     */
    settled: z
      .strictObject({ at: timestamp, by: z.literal('person'), note: settlementNote })
      .optional(),
  })
  .refine((effect) => effect.request.kind === effect.kind, 'The request matches the kind.')
  .refine((effect) => targetFits(effect.target, effect.request), targetMessage)
  .refine(
    (effect) =>
      confirmedStates.includes(effect.state)
        ? effect.confirmation !== null
        : effect.state !== 'proposed' || effect.confirmation === null,
    'Every write is confirmed before it is sent, and a proposal carries no confirmation.',
  )
  .refine(
    (effect) =>
      effect.state !== 'applied' || effect.observed !== null || effect.settled !== undefined,
    'An applied write was observed or settled by the person.',
  )
  .refine(
    (effect) =>
      effect.settled === undefined ||
      ((effect.state === 'applied' || effect.state === 'refused') && effect.confirmation !== null),
    'Only a confirmed write the person settled as applied or refused carries their word.',
  );
export type RemoteEffect = z.infer<typeof RemoteEffectSchema>;

/** Records a proposal and answers with its preview. It sends nothing. */
export const ProposeRemoteEffectPayloadSchema = z
  .strictObject({
    taskId: id('tsk'),
    target: RemoteEffectTargetSchema,
    request: RemoteEffectRequestSchema,
  })
  .refine((payload) => targetFits(payload.target, payload.request), targetMessage);
export const RemoteEffectPreviewSchema = z.strictObject({
  effect: RemoteEffectSchema,
  /** The exact write in words, as the confirmation shows it. */
  preview: bounded(32_768),
});
export type RemoteEffectPreview = z.infer<typeof RemoteEffectPreviewSchema>;
export const ConfirmRemoteEffectPayloadSchema = z.strictObject({
  effectId: RemoteEffectIdSchema,
  confirm: z.literal('explicit'),
});
export const CancelRemoteEffectPayloadSchema = z.strictObject({ effectId: RemoteEffectIdSchema });
/** The most remote writes one read returns, oldest first. */
export const MAX_THREAD_REMOTE_EFFECTS = 256;
export const ReadRemoteEffectsPayloadSchema = z.strictObject({ taskId: id('tsk') });
export const RemoteEffectsReadSchema = z.strictObject({
  taskId: id('tsk'),
  effects: z.array(RemoteEffectSchema).max(MAX_THREAD_REMOTE_EFFECTS),
});
export type RemoteEffectsRead = z.infer<typeof RemoteEffectsReadSchema>;
/** Reads the remote to settle an unknown write. It sends nothing. */
export const ReconcileRemoteEffectPayloadSchema = z.strictObject({
  effectId: RemoteEffectIdSchema,
});
/**
 * Settles an unknown write on the person's word, once a reconcile in this controller read the
 * remote and could not. applied: they saw it on GitHub. not-applied: they saw it was not sent. It
 * frees the write's kind and the thread delete. It reads and sends nothing.
 */
export const SettleRemoteEffectPayloadSchema = z.strictObject({
  effectId: RemoteEffectIdSchema,
  outcome: z.enum(['applied', 'not-applied']),
  confirm: z.literal('explicit'),
  note: settlementNote,
});
/**
 * One write's record and its preview, read from the journal, so a proposal made before a restart
 * can still be read and confirmed. It proposes nothing again.
 */
export const ReadRemoteEffectPreviewPayloadSchema = z.strictObject({
  effectId: RemoteEffectIdSchema,
});
/** A change to one remote write. The thread reads the record again when it hears one. */
export const RemoteEffectChangeSchema = z.strictObject({
  id: RemoteEffectIdSchema,
  kind: RemoteEffectKindSchema,
  state: RemoteEffectStateSchema,
  reason: z.string().min(1).max(300).nullable(),
});
export type RemoteEffectChange = z.infer<typeof RemoteEffectChangeSchema>;

/** The newest review comments one read returns, and the most text it keeps of each. */
export const MAX_REVIEW_COMMENTS = 100;
export const MAX_REVIEW_COMMENT_CHARS = 4000;
/** Reads a pull request's review comments for the head the thread saw. It sends nothing. */
export const ReadReviewCommentsPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  repo: GitHubRepositorySchema,
  pr: z.number().int().min(1),
  headSha: objectId,
});
export const ReviewCommentSchema = z.strictObject({
  id: githubId,
  author: z.string().min(1).max(100),
  body: z.string().max(MAX_REVIEW_COMMENT_CHARS),
  line: z.number().int().min(1).nullable(),
  createdAt: timestamp,
  inReplyTo: githubId.nullable(),
  url: z.url().max(2048),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
/**
 * The newest review comments grouped by file, oldest first in each file, read for the pull
 * request and the head named. `truncated` says older comments were not read.
 */
export const ReviewCommentsReadSchema = z.strictObject({
  taskId: id('tsk'),
  repo: GitHubRepositorySchema,
  pr: z.number().int().min(1),
  headSha: objectId,
  readAt: timestamp,
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4096),
        comments: z.array(ReviewCommentSchema).min(1).max(MAX_REVIEW_COMMENTS),
      }),
    )
    .max(MAX_REVIEW_COMMENTS),
  truncated: z.boolean(),
});
export type ReviewCommentsRead = z.infer<typeof ReviewCommentsReadSchema>;

/** The most required checks one merge readiness read names. A base rarely requires more. */
export const MAX_MERGE_CHECKS = 100;
/** Reads what GitHub asks of a merge of the thread's pull request at the head it pushed. */
export const ReadMergeReadinessPayloadSchema = z.strictObject({ taskId: id('tsk') });
/**
 * What GitHub asks of a merge at one head, read before the person clicks Merge: each check the
 * base requires and where it stands on that head, and GitHub's merge state, which covers required
 * reviews. `reason` says why the merge cannot go now. `line` says what was read when it can. The
 * proposal and the send read all of it again.
 */
export const MergeReadinessSchema = z
  .strictObject({
    taskId: id('tsk'),
    repo: GitHubRepositorySchema,
    pr: z.number().int().min(1),
    headSha: objectId,
    readAt: timestamp,
    /** green, pending, missing, or GitHub's own conclusion or status, such as failure. */
    checks: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(256),
          state: z.string().min(1).max(64),
        }),
      )
      .max(MAX_MERGE_CHECKS),
    /** GitHub's mergeable_state, such as clean, blocked or behind. Null when it was not read. */
    mergeState: z.string().min(1).max(64).nullable(),
    reason: z.string().min(1).max(1000).nullable(),
    line: z.string().min(1).max(1000).nullable(),
  })
  .refine(
    (read) => (read.reason === null) !== (read.line === null),
    'A read says why the merge waits or what it found, never both.',
  );
export type MergeReadiness = z.infer<typeof MergeReadinessSchema>;
