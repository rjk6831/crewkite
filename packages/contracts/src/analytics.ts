import { z } from 'zod';
import { ChatFamilySchema, ChatRoleSchema, ChatTurnIdSchema, ChatTurnStateSchema } from './chat.ts';

// Usage analytics for one thread or one project. The controller derives every number from what it
// already records, so a reader never holds a second copy of the history. A value the client did
// not report is null. Null never means zero.

const taskId = z.string().regex(/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const projectId = z.string().regex(/^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative();
const known = count.nullable();

/** The most threads a project read lists and the most turns a thread read lists. */
export const ANALYTICS_MAX_THREADS = 500;
export const ANALYTICS_MAX_TURNS = 1000;

export const ReadChatAnalyticsPayloadSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('thread'), taskId }),
  z.strictObject({ scope: z.literal('project'), projectId }),
]);
export type ReadChatAnalyticsPayload = z.infer<typeof ReadChatAnalyticsPayloadSchema>;

/** The unit a gauge window reports remaining allowance in. */
const allowanceUnit = z.enum(['percent', 'tokens', 'requests', 'credits', 'minutes']);

/**
 * What one gauge window lost across turns of a family. `consumed` sums the turns the controller
 * could bracket with two readings of the window and null when it could bracket none. The other
 * turns are counted in `unmeasuredTurns`, so a total never hides how many turns it leaves out.
 */
export const AnalyticsAllowanceSchema = z.strictObject({
  windowId: z.string().min(1).max(200),
  unit: allowanceUnit,
  consumed: z.number().finite().nonnegative().nullable(),
  measuredTurns: count,
  unmeasuredTurns: count,
});
export type AnalyticsAllowance = z.infer<typeof AnalyticsAllowanceSchema>;

export const AnalyticsFamilySchema = z.strictObject({
  family: ChatFamilySchema,
  turns: count,
  /** Summed over turns that ended. A turn still open adds nothing. */
  wallMs: count,
  tokensIn: known,
  tokensOut: known,
  /** Turns whose client reported tokens in or out. The sums above cover these turns only. */
  tokenTurns: count,
  allowance: z.array(AnalyticsAllowanceSchema).max(16),
});
export type AnalyticsFamily = z.infer<typeof AnalyticsFamilySchema>;

export const AnalyticsPlanSlicesSchema = z.strictObject({
  total: count,
  done: count,
  failed: count,
  blocked: count,
});

/** The numbers a thread and a project row share. */
const rowShape = {
  turns: count,
  /** Turns not settled: queued, running or waiting. They have no wall time yet. */
  openTurns: count,
  /** Turns that continued another family's work. */
  handoffs: count,
  wallMs: count,
  tokensIn: known,
  tokensOut: known,
  tokenTurns: count,
  checksRun: count,
  checksPassed: count,
  checksFailed: count,
  branchesAccepted: count,
  /** The plan of the thread now. Null when the thread has no plan. */
  slices: AnalyticsPlanSlicesSchema.nullable(),
};

export const AnalyticsThreadRowSchema = z.strictObject({
  taskId,
  title: z.string().min(1).max(200),
  ...rowShape,
});
export type AnalyticsThreadRow = z.infer<typeof AnalyticsThreadRowSchema>;

export const AnalyticsTurnRowSchema = z.strictObject({
  id: ChatTurnIdSchema,
  sequence: count,
  role: ChatRoleSchema,
  family: ChatFamilySchema,
  model: z.string().min(1).max(200),
  state: ChatTurnStateSchema,
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
  wallMs: known,
  tokensIn: known,
  tokensOut: known,
  handoffFrom: ChatFamilySchema.nullable(),
  /** Only the windows the controller could measure for this turn. */
  allowance: z
    .array(
      z.strictObject({
        windowId: z.string().min(1).max(200),
        unit: allowanceUnit,
        consumed: z.number().finite().nonnegative(),
      }),
    )
    .max(16),
});
export type AnalyticsTurnRow = z.infer<typeof AnalyticsTurnRowSchema>;

export const ChatAnalyticsReadSchema = z.strictObject({
  scope: z.enum(['thread', 'project']),
  /** The task ID or the project ID that was read. */
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  readAt: timestamp,
  ...rowShape,
  families: z.array(AnalyticsFamilySchema).max(4),
  /** Project reads list their threads ordered by title. `threadCount` counts every thread. */
  threads: z.array(AnalyticsThreadRowSchema).max(ANALYTICS_MAX_THREADS),
  threadCount: count,
  /** Thread reads list their turns in order. A thread past the cap lists the newest turns. */
  turnRows: z.array(AnalyticsTurnRowSchema).max(ANALYTICS_MAX_TURNS),
  turnRowsTruncated: z.boolean(),
});
export type ChatAnalyticsRead = z.infer<typeof ChatAnalyticsReadSchema>;
