import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChatAttachment, ChatFamily, ChatRole } from '@crewkite/contracts';
import { anthropicInstructionFile } from '../providers/anthropic/instructions.ts';
import { googleInstructionFile } from '../providers/google/instructions.ts';
import type { ChatHistoryEntry } from './adapter.ts';

export const familyName: Record<ChatFamily, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  local: 'Local',
};

// rerun: Retry or Regenerate on the family that already answered the message, in a new session.
// model: the person picked another model of the same family, which starts a new native session.
// session: the turns since the family last ran do not fit its session, so a new one starts.
export type HandoffReason = 'manual' | 'limit' | 'steer' | 'rerun' | 'model' | 'session';

export function handoffReason(reason: HandoffReason): string {
  if (reason === 'rerun') return 'the person asked for the reply again';
  if (reason === 'steer') return 'the person sent a new message during the reply';
  if (reason === 'model') return 'model changed in the composer';
  if (reason === 'session') return 'the thread moved past what the old session could carry';
  return reason === 'limit' ? 'usage limit reached' : 'switched in the composer';
}

/**
 * The framing for an assistant or fixer turn. The Anthropic client launches with no setting
 * sources and Local has no instruction loader, so those two get the project's instruction files
 * here. The OpenAI and Google clients read their own files from the working folder.
 */
export function systemContext(projectName: string, directory: string, family: ChatFamily): string {
  const framing = [
    `You are working on the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    'Read and edit files only inside that copy. The person reviews every change in Changes before it reaches their repository.',
    'When you change files, say which files you changed and why.',
    'The scratch copy has no `.git` folder and no installed dependencies, so git commands and tests may fail there.',
  ].join('\n');
  const instructions =
    family === 'anthropic' || family === 'local' ? projectInstructions(directory) : [];
  return [framing, ...instructions].join('\n\n');
}

/** Instruction files at the scratch root, in the order systemContext reads them. */
export const instructionFiles = ['AGENTS.md', anthropicInstructionFile, googleInstructionFile];

/** The instruction files the scratch copy holds, so the next provider knows where to look. */
export function presentInstructions(directory: string): string[] {
  return instructionFiles.filter((name) => {
    try {
      return statSync(join(directory, name)).isFile();
    } catch {
      return false;
    }
  });
}
const INSTRUCTION_BYTES = 64 * 1024;
const INSTRUCTIONS_CUT = '[The project instructions stop here at the 64 KiB limit.]';

/**
 * One section per instruction file at the scratch root, in a fixed order. A link that resolves to a
 * file inside the copy counts once, under the first name that reaches it. Headers and text share
 * 64 KiB, and a cut ends on a whole line.
 */
function projectInstructions(directory: string): string[] {
  let root: string;
  try {
    root = realpathSync.native(directory);
  } catch {
    return [];
  }
  const read = new Set<string>();
  const sections: string[] = [];
  let used = 0;
  for (const name of instructionFiles) {
    let file: string;
    try {
      file = realpathSync.native(join(root, name));
    } catch {
      continue;
    }
    if (!file.startsWith(`${root}${sep}`) || read.has(file)) continue;
    read.add(file);
    const header = `Project instructions from ${name}:\n\n`;
    const room = INSTRUCTION_BYTES - used - Buffer.byteLength(header);
    const bytes = readFileStart(file, Math.max(room, 0) + 1);
    if (bytes === null || bytes.length === 0) continue;
    if (bytes.length <= room) {
      sections.push(`${header}${bytes.toString('utf8').trimEnd()}`);
      used += Buffer.byteLength(header) + bytes.length;
      continue;
    }
    const end = room > 0 ? bytes.lastIndexOf(10, room - 1) : -1;
    const kept = end < 0 ? '' : bytes.subarray(0, end).toString('utf8').trimEnd();
    sections.push(kept ? `${header}${kept}\n${INSTRUCTIONS_CUT}` : INSTRUCTIONS_CUT);
    break;
  }
  return sections;
}

/** The first bytes of a regular file, or null for anything else. A FIFO never blocks the read. */
function readFileStart(path: string, limit: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(limit);
    let length = 0;
    while (length < limit) {
      const count = readSync(fd, buffer, length, limit - length, length);
      if (count === 0) break;
      length += count;
    }
    return buffer.subarray(0, length);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// A review reads the changed files and their patches, so the patches get a fixed share of the prompt.
const REVIEW_PATCH_BYTES = 48 * 1024;
// shortcut: the file list stops at 300 names. Upgrade: summarize by directory past that.
const REVIEW_LISTED_FILES = 300;
const ADVICE_ANSWER_CHARACTERS = 16_000;

type ReviewFile = { path: string; additions: number; deletions: number; patch: string | null };

/**
 * Brief for a reviewer turn. It lists every changed file with its counts, then as many whole
 * patches as fit in 48 KiB, and names the files whose patch had to be left out. A review inside
 * a crew chain ends on a count line, so the controller decides on a fix without reading prose.
 */
export function reviewContext(
  projectName: string,
  directory: string,
  base: string,
  files: readonly ReviewFile[] | null,
  statesFindings = false,
): string {
  const lines = [
    `You are reviewing changes in the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    `Review the current changes in that copy against the base commit ${base}.`,
    'Do not edit, create or delete files, and do not run commands. You may read and search files to check a change against the code around it.',
    'List your findings ordered by severity, most severe first. For each one, name the file and the line, say what is wrong and why it matters, and say what you would change. If you find nothing worth reporting, say so in one sentence.',
    ...(statesFindings
      ? [
          'End your reply with one line that reads exactly `Findings: N`, where N is the number of findings you listed. Write `Findings: 0` when there are none.',
        ]
      : []),
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

/** Brief for a challenger turn: the assumptions the last answer rests on, and which may not hold. */
export function challengeContext(
  projectName: string,
  directory: string,
  answer: string | null,
): string {
  const lines = [
    `You are challenging the last answer in a thread about the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    'Do not edit, create or delete files, and do not run commands. You may read and search files to check an assumption.',
    'Name the assumptions the answer rests on, starting with the one that would change it most if it were wrong. For each, say whether it is verified, unverified or wrong, and what evidence would settle it. Keep it under 300 words.',
  ];
  if (answer === null) return [...lines, 'There is no earlier answer in this thread.'].join('\n');
  const text =
    answer.length > ADVICE_ANSWER_CHARACTERS
      ? `${answer.slice(0, ADVICE_ANSWER_CHARACTERS).toWellFormed()} [trimmed]`
      : answer;
  return [...lines, `The last answer:\n\n${text}`].join('\n');
}

const FIXER_REVIEW_CHARACTERS = 16_000;

/**
 * The message a fixer turn answers. It is the builder again, so it may resume the builder's native
 * session, which skips the system context. The findings therefore travel in the message itself.
 */
export function fixerBrief(review: string): string {
  const text =
    review.length > FIXER_REVIEW_CHARACTERS
      ? `${review.slice(0, FIXER_REVIEW_CHARACTERS).toWellFormed()} [trimmed]`
      : review;
  return [
    'A review of the changes in the scratch copy found the problems quoted below. Fix each one in the scratch copy. Read a file before you change it.',
    'When you are done, say what you changed for each finding. Name any finding you left alone and say why.',
    `The review:\n\n${text
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`,
  ].join('\n\n');
}

/**
 * The model works in the scratch copy, and the person reviews only what changes there. A path
 * under the project root, the way an editor or Finder copies it, means the same file in the
 * copy. Any other path that resolves outside the copy is left out, with one line saying so.
 */
export function withAttachments(
  text: string,
  attachments: readonly string[],
  directory: string,
  projectRoot: string,
): string {
  const root = resolve(directory);
  const project = resolve(projectRoot);
  const under = (base: string, target: string) =>
    target === base || target.startsWith(`${base}${sep}`);
  const inProject = (path: string) =>
    isAbsolute(path) && under(project, resolve(path))
      ? relative(project, resolve(path)) || '.'
      : path;
  const inside = (path: string) => under(root, resolve(root, path));
  const kept = attachments.map(inProject).filter(inside);
  const dropped = attachments.filter((path) => !inside(inProject(path)));
  return [
    ...(text ? [text] : []),
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
  /** Instruction files at the scratch root. The next provider reads them from the copy. */
  instructions?: readonly string[];
  /** Files from earlier messages that travel with this request. The new message's own files are not here. */
  earlier?: readonly EarlierFile[];
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
  // Send now stops a reply and starts the next message on the same family. The packet then tells
  // the model what the stopped reply left behind. A rerun starts a new session, since the old one
  // holds the reply it replaces. A model change or a session that fell too far behind starts a new
  // session on the same family, and nothing was stopped.
  const opening =
    input.reason === 'rerun'
      ? `This message runs again on ${familyName[input.to]} in a new session. Reason: ${handoffReason(input.reason)}.`
      : input.from === input.to && (input.reason === 'model' || input.reason === 'session')
        ? `This thread continues on ${familyName[input.to]} in a new session. Reason: ${handoffReason(input.reason)}.`
        : input.from === input.to
          ? `The last reply on ${familyName[input.from]} was stopped before it finished. Reason: ${handoffReason(input.reason)}.`
          : `This thread moved from ${familyName[input.from]} to ${familyName[input.to]}. Reason: ${handoffReason(input.reason)}.`;
  return [
    opening,
    'Earlier work is in the same scratch copy. Read files before you change them.',
    THREAD_TOOLS_LINE,
    `Conversation so far, oldest first:\n\n${transcript.join('\n\n') || 'No earlier messages.'}`,
    `Files changed in the scratch copy against the base commit:\n${files}`,
    ...(input.instructions?.length
      ? [`Project instructions: ${input.instructions.join(', ')}`]
      : []),
    earlierFilesSection(input.earlier ?? []),
    newMessageBlock(input.prompt),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A file from an earlier message, and how this request reaches it. */
export type EarlierFile = {
  attachment: Pick<ChatAttachment, 'name' | 'mimeType' | 'bytes'>;
  /** A short quote of the message the file came with. */
  came: string;
  /** What the family does with it: `Path: <path>`, or the link or note the adapter sends. */
  reach: string;
};

/**
 * How an earlier file reaches a family. Anthropic's adapter swaps the stored path for its staged
 * copy. Google gets a link block after the text. Local reads no file by path.
 */
export function earlierReach(family: ChatFamily, path: string): string {
  if (family === 'google') return 'sent as a file link below';
  return family === 'local' ? 'not sent to Local' : `Path: ${path}`;
}

/** The packet names the read-only thread tools, so a model knows it can ask for more. */
export const THREAD_TOOLS_LINE =
  'Thread tools are available: thread_turns, thread_turn, thread_diff, thread_checks, thread_live.';

/**
 * The message text under its heading. The request carries it once. A message of files alone has
 * no text, and the file section the adapter adds below is its body.
 */
export function newMessageBlock(text: string): string {
  return text
    ? `New message from the person:\n${text}`
    : 'New message from the person: the files attached to this message, with no text.';
}

/** What a transcript shows for a person's message. A message of files alone names them. */
export function spokenText(text: string, files: readonly Pick<ChatAttachment, 'name'>[]): string {
  if (text || !files.length) return text;
  return `(Files only: ${files.map((file) => file.name).join(', ')})`;
}

/** One line for a file: name, type, size, then the tail. */
export function attachedLine(
  file: Pick<ChatAttachment, 'name' | 'mimeType' | 'bytes'>,
  tail: string,
): string {
  return `${file.name}, ${file.mimeType}, ${byteSize(file.bytes)}, ${tail}`;
}

/** The files of the new message, one line each, or nothing. Adapters add it directly under the text. */
export function attachedSection(lines: readonly string[]): string {
  return lines.length ? `Files attached to this message:\n${lines.join('\n')}` : '';
}

export function earlierFileLine(file: EarlierFile): string {
  const came = file.came ? `came with "${file.came}"` : 'came with a message with no text';
  return attachedLine(file.attachment, `${came}, ${file.reach}`);
}

/** Files from before the new message, listed once, or nothing. The packet and the delta packet both use it. */
export function earlierFilesSection(files: readonly EarlierFile[]): string {
  return files.length
    ? [
        'Files attached earlier in this thread. They are not part of the new message.',
        ...files.map(earlierFileLine),
      ].join('\n')
    : '';
}

/** A turn the resumed session has not seen, as the delta packet tells it. */
export type DeltaTurn = Readonly<{
  family: ChatFamily;
  model: string;
  role: ChatRole;
  /** The person's message, or null when an earlier turn in the packet or the new message carries it. */
  message: string | null;
  reply: string | null;
  /** Why the turn ended early, or null when it finished. */
  early: string | null;
  tools: readonly string[];
}>;

// Each delta line names the family and the role, so a reviewer's words never read as the
// builder's answer.
const roleName: Record<ChatRole, string> = {
  assistant: 'builder',
  fixer: 'fixer',
  reviewer: 'reviewer',
  advisor: 'advisor',
  challenger: 'challenger',
  orchestrator: 'orchestrator',
  ask: 'ask',
};

/**
 * A resumed session already holds the turns its family ran. The delta packet tells it what the
 * thread did since then: the other turns, what changed in the scratch copy, check results and
 * files. Replies keep their full text for the last three and 600 characters before that, the
 * same rule as the handoff packet. `clip` caps each message and reply when the packet must shrink.
 */
export function deltaPacket(input: {
  from: ChatFamily | null;
  to: ChatFamily;
  reason: HandoffReason | null;
  turns: readonly DeltaTurn[];
  changes: readonly string[];
  checks: readonly string[];
  earlier: readonly EarlierFile[];
  prompt: string;
  clip?: number;
}): string {
  const cut = (text: string, characters: number) =>
    text.length > characters ? `${text.slice(0, characters).toWellFormed()} [trimmed]` : text;
  const capped = (text: string) => (input.clip === undefined ? text : cut(text, input.clip));
  const replies = input.turns.flatMap((turn, index) => (turn.reply ? [index] : []));
  const full = new Set(replies.slice(-3));
  const turns = input.turns.map((turn, index) => {
    const reply = turn.reply && (full.has(index) ? turn.reply : cut(turn.reply, 600));
    return [
      ...(turn.message === null ? [] : [`Person:\n${capped(turn.message)}`]),
      `${familyName[turn.family]}, ${roleName[turn.role]} (${turn.model}):\n${reply ? capped(reply) : 'No reply.'}`,
      ...(turn.early ? [`The turn ended early. Reason: ${turn.early}.`] : []),
      ...(turn.tools.length
        ? [`Tool activity:\n${turn.tools.map((line) => `- ${line}`).join('\n')}`]
        : []),
    ].join('\n\n');
  });
  const to = familyName[input.to];
  const opening =
    input.from && input.from !== input.to && input.reason
      ? `This thread moved from ${familyName[input.from]} to ${to}. Reason: ${handoffReason(input.reason)}. This session holds the thread up to its last turn on ${to}.`
      : `Other providers took turns in this thread since its last turn on ${to}.`;
  return [
    opening,
    'Earlier work is in the same scratch copy. Read files before you change them.',
    THREAD_TOOLS_LINE,
    `Turns since then, oldest first:\n\n${turns.join('\n\n')}`,
    input.changes.join('\n'),
    input.checks.length
      ? `System lines since then that mention checks:\n${input.checks.join('\n')}`
      : '',
    earlierFilesSection(input.earlier),
    newMessageBlock(input.prompt),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** "812 bytes", "12.4 KiB", "3.0 MiB". */
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
