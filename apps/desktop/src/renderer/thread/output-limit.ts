import type { ChatOutputLimit, ChatTurnStats } from '@crewkite/contracts';

const count = (value: number) => value.toLocaleString('en-US');

/** The system line for a reply that used its whole output budget. */
export const outputLimitLine = (limit: ChatOutputLimit) =>
  `Reply stopped at the output limit: ${count(limit.reasoningTokens)} reasoning and ${count(limit.replyTokens)} reply of ${count(limit.allowedTokens)} allowed.`;

/** The split the Local stats line shows beside the context figures. */
export const outputSplit = (limit: Pick<ChatOutputLimit, 'reasoningTokens' | 'replyTokens'>) =>
  `reasoning ${count(limit.reasoningTokens)} · reply ${count(limit.replyTokens)}`;

/**
 * The split for a turn's stats line. Local reports it on every turn. A turn read back without it
 * still has the split from its output limit, when the reply stopped there. Null otherwise.
 */
export function statsSplit(stats: ChatTurnStats, limit: ChatOutputLimit | null): string | null {
  const { reasoningTokens, replyTokens } = stats;
  if (reasoningTokens !== undefined && replyTokens !== undefined)
    return outputSplit({ reasoningTokens, replyTokens });
  return limit ? outputSplit(limit) : null;
}
