import { z } from 'zod';

// Parallel plan slices (ADR 0045, amendment of 2026-10-28). Each running slice is a lane: its
// own scratch copy, its own builder turn and its own review chain. The controller keeps the lane
// on the plan card, so a restart reads where each slice stood.

/** Where a lane stands. `merge` waits for the slices before it in plan order to merge first. */
export const ChatPlanLaneStepSchema = z.enum(['build', 'review', 'fix', 'merge', 'resolve']);
export type ChatPlanLaneStep = z.infer<typeof ChatPlanLaneStepSchema>;

/** The most conflicting paths a blocked slice lists on the card. */
export const MAX_PLAN_CONFLICTS = 16;

/** The paths of a blocked slice that the thread copy changed too. */
export const ChatPlanConflictsSchema = z.array(z.string().min(1).max(4096)).max(MAX_PLAN_CONFLICTS);

/**
 * One slice's lane. `pending` is true while the step waits for a turn to open, as when its family
 * answers elsewhere. `build` is the slice's builder turn, which the challenge reads after the
 * plan. The turn ID shape comes from the chat contract, which owns it.
 */
export const chatPlanLaneSchema = <T extends z.ZodType>(turnId: T) =>
  z.strictObject({
    step: ChatPlanLaneStepSchema,
    pending: z.boolean(),
    rounds: z.number().int().min(0).max(3),
    fixes: z.number().int().min(0).max(2),
    build: turnId.nullable(),
  });
