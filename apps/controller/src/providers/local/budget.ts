import { LOCAL_REPLY_MARGIN, localBudget, localReplyFloor } from '@crewkite/contracts';

// The sizes a Local prompt may use, derived from the one reply rule in contracts. The chat turn,
// the file proposal and the orchestrator's fit check all read their room from here.

/** Tokens the prompt may take: the context less the margin and the smallest reply. */
export const localPromptRoom = (contextLength: number) =>
  Math.max(0, contextLength - LOCAL_REPLY_MARGIN - localReplyFloor(contextLength));

/**
 * The output cap of a file proposal on an instance with this context. It is the smallest reply
 * the rule allows, which holds for any prompt inside `localPromptRoom`. Null when the context is
 * too small for any prompt to leave that reply.
 */
export function localProposalBudget(contextLength: number) {
  if (contextLength - LOCAL_REPLY_MARGIN < localReplyFloor(contextLength)) return null;
  return localBudget(contextLength, localPromptRoom(contextLength), true);
}

// Text and code run three to five bytes a token. Three never undercounts.
const BYTES_PER_TOKEN = 3;
// The project outline takes up to 18 percent of the context and the rolling summary about 300
// tokens, both before any file, so a slice cannot count on that part of the room.
const OUTLINE_SHARE = 0.18;
const SUMMARY_TOKENS = 300;

/**
 * Whether a slice naming these files can run on Local: no image among them, and the files fit in
 * the prompt room once the outline and the summary have their share.
 */
export function localSliceFits(
  files: readonly { path: string; bytes: number }[],
  contextLength: number,
  hasImage: boolean,
): boolean {
  if (hasImage || !Number.isFinite(contextLength) || contextLength <= 0) return false;
  const usable =
    localPromptRoom(contextLength) - Math.floor(contextLength * OUTLINE_SHARE) - SUMMARY_TOKENS;
  const tokens = files.reduce((sum, file) => sum + Math.ceil(file.bytes / BYTES_PER_TOKEN), 0);
  return usable > 0 && tokens <= usable;
}
