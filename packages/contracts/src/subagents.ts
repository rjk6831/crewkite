import { z } from 'zod';

// Subagents a provider client starts inside one turn. The client spends the same family's
// allowance on them, so the thread shows each one under the tool call that started it.

/** The most subagents one tool call lists. The counts keep going past it. */
export const MAX_SUBAGENTS = 32;
const count = z.number().int().min(0).max(10_000);

/**
 * One subagent as the adapter last saw it. stopped means the turn ended before the client said
 * the subagent finished.
 */
export const SubagentStateSchema = z.enum(['running', 'done', 'failed', 'stopped']);
export type SubagentState = z.infer<typeof SubagentStateSchema>;

export const SubagentSchema = z.strictObject({
  /** The client's own ID for the subagent, or the tool call ID when it gives none. */
  id: z.string().min(1).max(200),
  state: SubagentStateSchema,
  /** The title of the subagent's latest action, written the way a tool card title is. */
  action: z.string().min(1).max(300).nullable(),
  /** The model, when the client names it. */
  model: z.string().min(1).max(200).nullable(),
});
export type Subagent = z.infer<typeof SubagentSchema>;

/**
 * The fields of a `tool.subagents` event: the whole picture for one parent tool call, so the
 * newest event replaces the one before it.
 */
export const subagentActivityFields = {
  /** The tool call that started the subagents. */
  callId: z.string().min(1).max(200),
  running: count,
  finished: count,
  agents: z.array(SubagentSchema).max(MAX_SUBAGENTS),
};

/**
 * Whether a crew role lets its client start subagents. A crew saved before the switch leaves it
 * out, and then the family decides: subagents are on, except for the families listed below.
 */
export const AllowSubagentsSchema = z.boolean().optional();
/**
 * Families whose subagents stay off until the person turns them on for a role. OpenAI child
 * approvals rely on the client passing the turn's approval policy to each child, which a live
 * check has yet to confirm.
 */
export const SUBAGENTS_OFF_UNLESS_ALLOWED: readonly string[] = ['openai'];
export const allowsSubagents = (
  member: { allowSubagents?: boolean } | null | undefined,
  family?: string,
) => member?.allowSubagents ?? !SUBAGENTS_OFF_UNLESS_ALLOWED.includes(family ?? '');
