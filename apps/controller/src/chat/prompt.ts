import type { ChatFamily } from '@crewkite/contracts';
import type { ChatHistoryEntry } from './adapter.ts';

export const familyName: Record<ChatFamily, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  local: 'Local',
};

export type HandoffReason = 'manual' | 'limit';

export function handoffReason(reason: HandoffReason): string {
  return reason === 'limit' ? 'usage limit reached' : 'switched in the composer';
}

export function systemContext(projectName: string, directory: string): string {
  return [
    `You are working on the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    'Read and edit files only inside that copy. The person reviews every change in Changes before it reaches their repository.',
    'When you change files, say which files you changed and why.',
  ].join('\n');
}

export function withAttachments(text: string, attachments: readonly string[]): string {
  return attachments.length ? `${text}\n\nAttached paths:\n${attachments.join('\n')}` : text;
}

/**
 * The next provider starts cold. It gets durable facts only: what the person wrote, what
 * the assistant answered, and what changed in the scratch copy. The stopped model is never
 * asked to summarize itself.
 */
export function handoffPacket(input: {
  from: ChatFamily;
  to: ChatFamily;
  reason: HandoffReason;
  history: readonly ChatHistoryEntry[];
  files: readonly string[] | null;
  prompt: string;
}): string {
  const answers = input.history.flatMap((entry, index) =>
    entry.role === 'assistant' ? [index] : [],
  );
  const full = new Set(answers.slice(-3));
  const transcript = input.history.map((entry, index) => {
    const trimmed =
      entry.role === 'assistant' && !full.has(index) && entry.text.length > 600
        ? `${entry.text.slice(0, 600).toWellFormed()} [trimmed]`
        : entry.text;
    return `${entry.role === 'user' ? 'Person' : 'Assistant'}:\n${trimmed}`;
  });
  const files =
    input.files === null
      ? 'The scratch changes could not be read.'
      : input.files.length
        ? input.files.join('\n')
        : 'No files changed yet.';
  return [
    `This thread moved from ${familyName[input.from]} to ${familyName[input.to]}. Reason: ${handoffReason(input.reason)}.`,
    'Earlier work is in the same scratch copy. Read files before you change them.',
    `Conversation so far, oldest first:\n\n${transcript.join('\n\n') || 'No earlier messages.'}`,
    `Files changed in the scratch copy against the base commit:\n${files}`,
    `New message:\n${input.prompt}`,
  ].join('\n\n');
}
