import { z } from 'zod';
import { AcceptChatChangesPayloadSchema } from './chat.ts';
import { ChatCheckRunSchema, ChatCheckSchema } from './checks.ts';

// A checked Accept. The controller reserves the thread, freezes the reviewed tree, runs the
// required checks on a copy of exactly that tree and publishes it only when they pass without
// changing a publishable byte. A crash or an uncertain end never replays publication: a new
// Accept checks again.

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const objectId = z.string().regex(/^[a-f0-9]{40}$/);

/** The most changed paths a refusal names. `mutatedCount` holds the full count. */
export const MAX_MUTATED_PATHS = 50;
/** The most required checks one Accept runs. */
export const MAX_REQUIRED_CHECKS = 32;

export const AcceptanceAttemptIdSchema = id('acc');
/**
 * reserved, checking and publishing hold the thread. The others have ended. unknown means the
 * controller stopped, or could not confirm, while publication may have run: nothing replays it.
 * That is a different fact from the refusal process-unknown, where a check's processes were not
 * proven closed and nothing was published.
 */
export const AcceptanceAttemptStateSchema = z.enum([
  'reserved',
  'checking',
  'publishing',
  'published',
  'refused',
  'cancelled',
  'unknown',
]);
export type AcceptanceAttemptState = z.infer<typeof AcceptanceAttemptStateSchema>;
export const AcceptanceRefusalSchema = z.enum([
  'check-failed',
  'check-mutated',
  'preparation-stale',
  'preparation-unsupported',
  'choice-changed',
  'process-unknown',
  'publish-conflict',
  'design-system-findings',
  'candidate-unsupported',
  'policy-violation',
]);
export type AcceptanceRefusal = z.infer<typeof AcceptanceRefusalSchema>;

export const AcceptanceCheckSchema = z.strictObject({
  checkId: ChatCheckSchema.shape.id,
  label: ChatCheckSchema.shape.label,
  /** The check run this attempt started. Null until it starts. */
  runId: ChatCheckRunSchema.shape.id.nullable(),
  /** mutated: the check changed a publishable file, so it cannot pass whatever its exit code. */
  status: z.enum(['pending', 'running', 'passed', 'failed', 'mutated', 'unknown']),
});
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

export const AcceptanceAttemptSchema = z
  .strictObject({
    id: AcceptanceAttemptIdSchema,
    taskId: id('tsk'),
    state: AcceptanceAttemptStateSchema,
    /** The thread's base the candidate was built on. Publication commits on it. */
    baseCommit: objectId,
    /** The tree object Accept froze. Checks run on a copy of it and publication commits it. */
    candidateTree: objectId,
    /** The required commands and their permissions as frozen at reservation. */
    commandsDigest: hash,
    /** The reviewed hunks and file choices as frozen at reservation. A change cancels the attempt. */
    choicesDigest: hash,
    preparationId: id('prp').nullable(),
    requiredChecks: z.array(AcceptanceCheckSchema).max(MAX_REQUIRED_CHECKS),
    /** Publishable files a check changed, the first 50 by path. */
    mutatedPaths: z.array(z.string().min(1).max(1024)).max(MAX_MUTATED_PATHS),
    mutatedCount: z.number().int().nonnegative(),
    refusal: AcceptanceRefusalSchema.nullable(),
    branch: AcceptChatChangesPayloadSchema.shape.branch,
    /** The published commit. Set once publication wrote it. */
    commit: objectId.nullable(),
  })
  .refine(
    (attempt) => attempt.mutatedPaths.length <= attempt.mutatedCount,
    'The changed paths are part of the changed count.',
  )
  .refine(
    (attempt) => (attempt.state === 'refused') === (attempt.refusal !== null),
    'A refused attempt says why, and only a refused attempt does.',
  )
  .refine(
    (attempt) => attempt.state !== 'published' || attempt.commit !== null,
    'A published attempt names its commit.',
  );
export type AcceptanceAttempt = z.infer<typeof AcceptanceAttemptSchema>;

const holding: readonly AcceptanceAttemptState[] = ['reserved', 'checking', 'publishing'];

/** Accept itself starts with AcceptChatChanges. This stops an attempt that has not published. */
export const CancelAcceptancePayloadSchema = z.strictObject({
  attemptId: AcceptanceAttemptIdSchema,
});
export const ReadAcceptancePayloadSchema = z.strictObject({ taskId: id('tsk') });
export const AcceptanceReadSchema = z
  .strictObject({
    taskId: id('tsk'),
    /** The attempt that holds the thread now. */
    current: AcceptanceAttemptSchema.nullable(),
    /** The newest attempt that ended. */
    last: AcceptanceAttemptSchema.nullable(),
  })
  .refine(
    (read) =>
      (read.current === null || holding.includes(read.current.state)) &&
      (read.last === null || !holding.includes(read.last.state)),
    'The current attempt holds the thread and the last one has ended.',
  );
export type AcceptanceRead = z.infer<typeof AcceptanceReadSchema>;
