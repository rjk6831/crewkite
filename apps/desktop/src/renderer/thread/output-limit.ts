import type { ChatOutputLimit } from '@crewkite/contracts';

const count = (value: number) => value.toLocaleString('en-US');

/** The system line for a reply that used its whole output budget. */
export const outputLimitLine = (limit: ChatOutputLimit) =>
  `Reply stopped at the output limit: ${count(limit.reasoningTokens)} reasoning and ${count(limit.replyTokens)} reply of ${count(limit.allowedTokens)} allowed.`;

/** The split the Local stats line shows beside the context figures. */
export const outputSplit = (limit: ChatOutputLimit) =>
  `reasoning ${count(limit.reasoningTokens)} · reply ${count(limit.replyTokens)}`;
