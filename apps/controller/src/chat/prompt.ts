import { resolve, sep } from 'node:path';
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

// A review reads the changed files and their patches, so the patches get a fixed share of the prompt.
const REVIEW_PATCH_BYTES = 48 * 1024;
// shortcut: the file list stops at 300 names. Upgrade: summarize by directory past that.
const REVIEW_LISTED_FILES = 300;
const ADVICE_ANSWER_CHARACTERS = 16_000;

type ReviewFile = { path: string; additions: number; deletions: number; patch: string | null };

/**
 * Brief for a reviewer turn. It lists every changed file with its counts, then as many whole
 * patches as fit in 48 KiB, and names the files whose patch had to be left out.
 */
export function reviewContext(
  projectName: string,
  directory: string,
  base: string,
  files: readonly ReviewFile[] | null,
): string {
  const lines = [
    `You are reviewing changes in the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    `Review the current changes in that copy against the base commit ${base}.`,
    'Do not edit, create or delete files, and do not run commands. You may read and search files to check a change against the code around it.',
    'List your findings ordered by severity, most severe first. For each one, name the file and the line, say what is wrong and why it matters, and say what you would change. If you find nothing worth reporting, say so in one sentence.',
  ];
  if (files === null) return [...lines, 'The changes could not be read.'].join('\n');
  if (files.length === 0)
    return [...lines, 'No files have changed since the base commit.'].join('\n');
  let budget = REVIEW_PATCH_BYTES;
  const shown: string[] = [];
  const left: string[] = [];
  for (const file of files) {
    const bytes = file.patch === null ? 0 : Buffer.byteLength(file.patch);
    if (file.patch !== null && bytes <= budget) {
      budget -= bytes;
      shown.push(file.patch.trimEnd());
    } else left.push(file.path);
  }
  const listed = [
    ...files
      .slice(0, REVIEW_LISTED_FILES)
      .map((file) => `${file.path} +${file.additions} -${file.deletions}`),
    ...(files.length > REVIEW_LISTED_FILES
      ? [`And ${files.length - REVIEW_LISTED_FILES} more files.`]
      : []),
  ].join('\n');
  return [
    ...lines,
    `Changed files:\n${listed}`,
    shown.length ? `Patches:\n\n${shown.join('\n\n')}` : '',
    left.length
      ? `These files have no patch above because it is binary or did not fit in 48 KiB. Read them in the scratch copy:\n${left.slice(0, REVIEW_LISTED_FILES).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Brief for an advisor turn: a short second opinion on the last assistant answer. */
export function adviceContext(
  projectName: string,
  directory: string,
  answer: string | null,
): string {
  const lines = [
    `You are giving a second opinion in a thread about the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    'Do not edit, create or delete files, and do not run commands. You may read and search files to check the answer.',
    'Say what holds up, what is wrong or missing, and what you would do next. Keep it under 300 words.',
  ];
  if (answer === null) return [...lines, 'There is no earlier answer in this thread.'].join('\n');
  const text =
    answer.length > ADVICE_ANSWER_CHARACTERS
      ? `${answer.slice(0, ADVICE_ANSWER_CHARACTERS).toWellFormed()} [trimmed]`
      : answer;
  return [...lines, `The last answer:\n\n${text}`].join('\n');
}

/**
 * The model works in the scratch copy, and the person reviews only what changes there. A path
 * that resolves outside the copy is left out, with one line saying so.
 */
export function withAttachments(
  text: string,
  attachments: readonly string[],
  directory: string,
): string {
  const root = resolve(directory);
  const inside = (path: string) => {
    const target = resolve(root, path);
    return target === root || target.startsWith(`${root}${sep}`);
  };
  const kept = attachments.filter(inside);
  const dropped = attachments.filter((path) => !inside(path));
  return [
    text,
    ...(kept.length ? [`Attached paths:\n${kept.join('\n')}`] : []),
    ...(dropped.length
      ? [
          dropped
            .map((path) => `Attachment outside the scratch copy was not included: ${path}`)
            .join('\n'),
        ]
      : []),
  ].join('\n\n');
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
