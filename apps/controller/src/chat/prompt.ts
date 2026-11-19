import { createHash } from 'node:crypto';
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
import {
  type ChatAttachment,
  type ChatFamily,
  type ChatRole,
  MAX_PLAN_SLICES,
  PROJECT_NOTES_BYTES,
  PROJECT_NOTES_MAX,
  projectNotesBytes,
  renderProjectNotes,
  WRITING_RULES,
  WRITING_RULES_CATALOGUE_VERSION,
  type WritingRuleSet,
  type WritingRulesRead,
} from '@crewkite/contracts';
import { writingRuleDigest } from '@crewkite/contracts/hash';
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
// ask: a read-only side question to one family, which reads the thread from the packet.
// schedule: a step of a scheduled run that the loop's limit for `from` held back, so `from`
// never received it and no usage limit was reached there.
export type HandoffReason =
  | 'manual'
  | 'limit'
  | 'schedule'
  | 'steer'
  | 'rerun'
  | 'model'
  | 'session'
  | 'ask'
  | 'plan';

/** The reason a handoff gives, in the thread's line and in the packet. `from` is where it moved from. */
export function handoffReason(reason: HandoffReason, from: ChatFamily): string {
  if (reason === 'schedule') return `the loop's limit for ${familyName[from]}`;
  if (reason === 'rerun') return 'the person asked for the reply again';
  if (reason === 'steer') return 'the person sent a new message during the reply';
  if (reason === 'model') return 'model changed in the composer';
  if (reason === 'session') return 'the thread moved past what the old session could carry';
  if (reason === 'ask') return 'the person asked a side question';
  if (reason === 'plan') return 'the orchestrator reads the thread before it plans';
  return reason === 'limit' ? 'usage limit reached' : 'switched in the composer';
}

/**
 * The framing for an assistant or fixer turn. The Anthropic client launches with no setting
 * sources and Local has no instruction loader, so those two get the project's instruction files
 * here. The OpenAI and Google clients read their own files from the working folder. Every family
 * gets the project's notes. The notes and the instruction files share 64 KiB: the notes come first
 * with at most 16 KiB, and the instruction files keep the rest. The writing rules, with the project's
 * design system after them when it is delivered, come between the framing and the notes, and their
 * bytes come out of the same 64 KiB.
 */
export function systemContext(
  projectName: string,
  directory: string,
  family: ChatFamily,
  notes: readonly string[] = [],
  rules = '',
): string {
  const framing = [
    `You are working on the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    'Read and edit files only inside that copy. The person reviews every change in Changes before it reaches their repository.',
    'When you change files, say which files you changed and why.',
    'The scratch copy has no `.git` folder and no installed dependencies, so git commands and tests may fail there.',
  ].join('\n');
  const section = notesSection(notes);
  const instructions =
    family === 'anthropic' || family === 'local'
      ? projectInstructions(
          directory,
          INSTRUCTION_BYTES - Buffer.byteLength(section) - Buffer.byteLength(rules),
        )
      : [];
  return [framing, ...(rules ? [rules] : []), ...(section ? [section] : []), ...instructions].join(
    '\n\n',
  );
}

/**
 * Obligations no switch removes. They ride with every writing turn, so turning the ladder off
 * never drops them. Rules only add guidance. None of them grants a permission.
 */
export const MANDATORY_OBLIGATIONS =
  'Whatever else applies, validate input at trust boundaries, handle errors so no data is lost, keep security and accessibility intact, stay inside the permissions this turn was given, and follow the architecture decisions the project records.';

const RULES_HEAD = 'Writing rules for this work:';

/** The rules a writing turn receives and the section that carries them. */
export type WritingRuleTurn = Readonly<{ set: WritingRuleSet; section: string }>;

/**
 * The rule set for the next writing turn. It reads the catalogue, so the order is the
 * catalogue's and an export-only rule never joins, whatever the stored rows say. A rule with no
 * row takes its default.
 */
export function resolveWritingRules(
  rows: readonly { ruleId: string; enabled: boolean }[] = [],
): WritingRuleTurn {
  const chosen = new Map(rows.map((row) => [row.ruleId, row.enabled]));
  const picked = WRITING_RULES.filter(
    (rule) => rule.surface === 'settings' && (chosen.get(rule.id) ?? rule.defaultEnabled),
  );
  const enabled = picked.map((rule) => rule.id);
  const set = {
    catalogueVersion: WRITING_RULES_CATALOGUE_VERSION,
    enabled,
    digest: writingRuleDigest(enabled),
  };
  const lines = picked.map((rule) => `- ${rule.text}`);
  return { set, section: [RULES_HEAD, ...lines, MANDATORY_OBLIGATIONS].join('\n') };
}

/** What ReadWritingRules answers: every catalogue rule with the switch that applies now. */
export function readWritingRules(
  rows: readonly { ruleId: string; enabled: boolean }[],
): WritingRulesRead {
  const chosen = new Map(rows.map((row) => [row.ruleId, row.enabled]));
  return {
    rules: WRITING_RULES.map((rule) => ({
      id: rule.id,
      enabled: chosen.get(rule.id) ?? rule.defaultEnabled,
      surface: rule.surface,
      text: rule.text,
      version: rule.version,
    })),
    digest: resolveWritingRules(rows).set.digest,
  };
}

/**
 * Refuses the turn when the rules, with any design system they carry, and the notes leave no room
 * under the shared context limit. A required rule or a token is never cut to fit. Rules and notes
 * alone stay well under the limit, so a large design system is what usually refuses.
 */
export function fitWritingRules(
  rules: string,
  notes: readonly string[],
  limit = INSTRUCTION_BYTES,
): void {
  if (Buffer.byteLength(rules) + Buffer.byteLength(notesSection(notes)) > limit)
    throw Error(
      'The writing rules, design system and project notes do not fit the 64 KiB context limit. Shorten the design system, turn off its delivery or remove project notes.',
    );
}

/**
 * The rule line of a read-only brief. The OpenAI client reads and searches through shell
 * commands, so its line allows the read-only ones. Its turn runs in a read-only sandbox that
 * never asks: each command runs without a question, and the sandbox refuses any write or network
 * call. The other clients read through their own file tools and run no command on a read-only
 * turn.
 */
export function readOnlyRules(family: ChatFamily, purpose: string): string {
  if (family === 'openai')
    return `Do not edit, create or delete files. You may read and search files to ${purpose}: run read-only commands such as ls, cat, sed -n, head, wc, rg, grep and find inside the scratch copy. Do not run a command that changes a file, installs a package or reaches the network.`;
  return `Do not edit, create or delete files, and do not run commands. You may read and search files to ${purpose}.`;
}

/**
 * The project's notes as a section, or an empty string. The controller holds a project to 16 KiB
 * and 200 notes. A longer list is cut at a whole note, so the section never outgrows its share.
 */
export function notesSection(notes: readonly string[]): string {
  let kept = notes.slice(0, PROJECT_NOTES_MAX);
  while (kept.length > 0 && projectNotesBytes(kept) > PROJECT_NOTES_BYTES) kept = kept.slice(0, -1);
  return renderProjectNotes(kept);
}

/** A brief for a role that reads only, followed by the project's notes. */
export function withNotes(brief: string, notes: readonly string[]): string {
  const section = notesSection(notes);
  return section ? `${brief}\n\n${section}` : brief;
}

/** The hash of the notes section a session receives. The session keeps it to see a change. */
export function notesDigest(notes: readonly string[]): string {
  return createHash('sha256').update(notesSection(notes)).digest('hex');
}

const TURN_NOTES_LEAD =
  'CrewKite attaches the current notes for this project to the message below.';
const TURN_NOTES_END = 'End of project notes.';
const NO_NOTES = 'This project has no notes now.';
const TURN_RULES_LEAD = 'CrewKite attaches the writing rules for this turn to the message below.';
const TURN_RULES_END = 'End of writing rules.';

/**
 * A resumed session skips the system context, so the writing rules reach it in front of its
 * message, and with them the design brief when the project delivers one. The block starts and
 * ends on fixed lines, so `stripTurnNotes` can take it out when a new session starts.
 */
export function turnRulesBlock(rules: string): string {
  return `${TURN_RULES_LEAD}\n\n${rules}\n\n${TURN_RULES_END}`;
}

/**
 * A resumed session skips the system context, so the notes reach it in front of its message. They
 * go only when they differ from what the session last received, which `held` is the hash of. A
 * session that never received notes needs nothing while the project has none. A session that held
 * notes the project has since dropped is told so. The block is empty when nothing has to be said.
 * It starts and ends on fixed lines, so an adapter that starts a new session can take it out.
 */
export function turnNotesBlock(notes: readonly string[], held: string | undefined): string {
  const section = notesSection(notes);
  if (held === notesDigest(notes) || (held === undefined && !section)) return '';
  return `${TURN_NOTES_LEAD}\n\n${section || NO_NOTES}\n\n${TURN_NOTES_END}`;
}

/**
 * The prompt without the blocks `turnRulesBlock` and `turnNotesBlock` put in front of it. An adapter calls it when a
 * resume fails and a new session starts, because that session reads both in its system
 * context and would otherwise see them twice.
 */
export function stripTurnNotes(prompt: string): string {
  return stripBlock(
    stripBlock(prompt, TURN_RULES_LEAD, TURN_RULES_END),
    TURN_NOTES_LEAD,
    TURN_NOTES_END,
  );
}

function stripBlock(prompt: string, lead: string, trail: string): string {
  if (!prompt.startsWith(`${lead}\n\n`)) return prompt;
  const end = prompt.indexOf(`\n\n${trail}\n\n`);
  return end < 0 ? prompt : prompt.slice(end + trail.length + 4);
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
export const INSTRUCTION_BYTES = 64 * 1024;
const INSTRUCTIONS_CUT = '[The project instructions stop here at the 64 KiB limit.]';

/**
 * One section per instruction file at the scratch root, in a fixed order. A link that resolves to a
 * file inside the copy counts once, under the first name that reaches it. Headers and text share
 * `budget` bytes, 64 KiB less what the notes take, and a cut ends on a whole line.
 */
function projectInstructions(directory: string, budget: number): string[] {
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
    const room = budget - used - Buffer.byteLength(header);
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
  family: ChatFamily,
  statesFindings = false,
  /** Why the changes could not be read, when the cause was their size. */
  unreadable?: string,
): string {
  const lines = [
    `You are reviewing changes in the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    `Review the current changes in that copy against the base commit ${base}.`,
    readOnlyRules(family, 'check a change against the code around it'),
    'List your findings ordered by severity, most severe first. For each one, name the file and the line, say what is wrong and why it matters, and say what you would change. If you find nothing worth reporting, say so in one sentence.',
    ...(statesFindings
      ? [
          'End your reply with one line that reads exactly `Findings: N`, where N is the number of findings you listed. Write `Findings: 0` when there are none.',
        ]
      : []),
  ];
  if (files === null) return [...lines, unreadable ?? 'The changes could not be read.'].join('\n');
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
  family: ChatFamily,
  answer: string | null,
): string {
  const lines = [
    `You are giving a second opinion in a thread about the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    readOnlyRules(family, 'check the answer'),
    'Say what holds up, what is wrong or missing, and what you would do next. Keep it under 300 words.',
  ];
  if (answer === null) return [...lines, 'There is no earlier answer in this thread.'].join('\n');
  const text =
    answer.length > ADVICE_ANSWER_CHARACTERS
      ? `${answer.slice(0, ADVICE_ANSWER_CHARACTERS).toWellFormed()} [trimmed]`
      : answer;
  return [...lines, `The last answer:\n\n${text}`].join('\n');
}

/** Brief for an ask turn: a read-only answer to one side question about the thread. */
export function askContext(projectName: string, directory: string, family: ChatFamily): string {
  return [
    `You are answering a side question in a thread about the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    readOnlyRules(family, 'answer'),
    'Answer the question directly. The thread goes on without you, so do not offer to make changes.',
  ].join('\n');
}

/** Brief for a challenger turn: the assumptions the last answer rests on, and which may not hold. */
export function challengeContext(
  projectName: string,
  directory: string,
  family: ChatFamily,
  answer: string | null,
): string {
  const lines = [
    `You are challenging the last answer in a thread about the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    readOnlyRules(family, 'check an assumption'),
    'Name the assumptions the answer rests on, starting with the one that would change it most if it were wrong. For each, say whether it is verified, unverified or wrong, and what evidence would settle it. Keep it under 300 words.',
  ];
  if (answer === null) return [...lines, 'There is no earlier answer in this thread.'].join('\n');
  const text =
    answer.length > ADVICE_ANSWER_CHARACTERS
      ? `${answer.slice(0, ADVICE_ANSWER_CHARACTERS).toWellFormed()} [trimmed]`
      : answer;
  return [...lines, `The last answer:\n\n${text}`].join('\n');
}

/** What a report run adds to the orchestrator's brief. The controller refuses a slice that writes. */
const REPORT_PLAN_RULES =
  'This is a report run, so always reply with a plan, whatever the request asks, and never answer it yourself. Every slice only reads, so set readOnly to true on each one. Write each slice brief so the slice ends with its findings, one per line, each with the file and line it rests on. After the last slice a challenger argues against the findings, and you then write one message with the findings that stand.';

/** The ending a read-only slice of a report run is told to give. */
const REPORT_SLICE_ENDING =
  'End with your findings, one per line, each with the file and line it rests on.';

/** Brief for the challenger of a report run: argue against each finding the slices stated. */
export function reportChallengeContext(
  projectName: string,
  directory: string,
  family: ChatFamily,
): string {
  return [
    `You are challenging the findings of a report in a thread about the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    readOnlyRules(family, 'check a finding'),
    'The message lists the findings of each slice, one per line, each with the file and line it rests on. Argue against every finding. Open the file at that line and say whether the finding stands, and why. Say so when a line does not hold what the finding claims, or when you could not verify it. Add no finding of your own.',
  ].join('\n');
}

/** Brief for the orchestrator's closing turn of a report run: one message with what stands. */
export function reportContext(projectName: string, directory: string, family: ChatFamily): string {
  return [
    `You are the orchestrator writing the report of a run in a thread about the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    readOnlyRules(family, 'check a finding'),
    "The message holds the findings of each slice and the challenger's answer to them. Write one message with the findings that stand, one per line, each with the file and line it rests on. Leave out a finding the challenger showed does not hold. End with a last line that reads Findings: followed by how many you listed, such as Findings: 3, or Findings: 0 when none stand.",
  ].join('\n');
}

/** A chat message holds 65,536 bytes. The parts of a closing brief share what the framing leaves. */
const REPORT_PART_BYTES = 56_000;
const TRIMMED = ' [trimmed]';
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

/** Cut text to `limit` UTF-8 bytes at a code point, and say so. */
function fitted(text: string, limit: number): string {
  if (utf8(text) <= limit) return text;
  let kept = '';
  let bytes = utf8(TRIMMED);
  for (const point of text) {
    bytes += utf8(point);
    if (bytes > limit) break;
    kept += point;
  }
  return `${kept}${TRIMMED}`;
}

/** What each slice of a report run answered, in plan order, within `limit` bytes in all. */
function sliceFindings(
  slices: readonly { id: number; title: string; findings: string }[],
  limit: number,
): string {
  const share = Math.max(utf8(TRIMMED) + 1, Math.floor(limit / Math.max(1, slices.length)));
  return slices
    .map(
      (slice) =>
        `Slice ${slice.id}: ${slice.title}\n${fitted(slice.findings.trim() || 'It gave no findings.', share)}`,
    )
    .join('\n\n');
}

/** The message the challenger of a report run answers. */
export function reportChallengeBrief(
  slices: readonly { id: number; title: string; findings: string }[],
): string {
  return [
    'Challenge the findings below. For each one, say whether it stands and why.',
    sliceFindings(slices, REPORT_PART_BYTES),
  ].join('\n\n');
}

/** The first words of the message the orchestrator answers to write the report. */
export const REPORT_LEAD = 'Write the report. Keep the findings that stand after the challenge.';

/** The message the orchestrator answers to write the report. */
export function reportBrief(
  slices: readonly { id: number; title: string; findings: string }[],
  challenge: string,
): string {
  const half = REPORT_PART_BYTES / 2;
  return [
    REPORT_LEAD,
    `Findings of each slice:\n\n${sliceFindings(slices, half)}`,
    `The challenger's answer:\n\n${fitted(challenge.trim() || 'The challenger gave no answer.', half)}`,
  ].join('\n\n');
}

/** The example in the orchestrator brief. A test parses it with the plan schema. */
export const PLAN_EXAMPLE =
  '{"planId": "p1", "goal": "Add tax to the order total.", "slices": [{"id": 1, "title": "Add the tax rate", "brief": "Add TAX_RATE to src/config.ts and export it.", "files": ["src/config.ts"], "depends": [], "difficulty": "easy", "readOnly": false}, {"id": 2, "title": "Apply tax in totals", "brief": "Use TAX_RATE in orderTotal in src/totals.ts and round to the cent.", "files": ["src/totals.ts", "src/config.ts"], "depends": [1], "difficulty": "medium", "readOnly": false}]}';

/**
 * Brief for an orchestrator turn. It reads, then answers a question itself or proposes one plan
 * block the controller validates. The controller assigns each slice inside the crew, so the brief asks for difficulty
 * and leaves the choice of family out.
 */
export function orchestratorContext(
  projectName: string,
  directory: string,
  family: ChatFamily,
  sliceCap: number = MAX_PLAN_SLICES,
  report = false,
): string {
  return [
    `You are the orchestrator in a thread about the project ${projectName}. Its files are in a scratch copy at ${directory}.`,
    readOnlyRules(family, 'plan the work'),
    // A report run always plans, so its brief opens with that and has no work to point back to.
    report
      ? REPORT_PLAN_RULES
      : 'Answer a question, or a request that changes no file, yourself in plain sentences and write no plan block. A plan costs a turn per slice, so propose one only for work that changes files or splits into independent parts.',
    `${report ? 'Split' : 'For that work, split'} the request into slices that one model can each finish in one turn. CrewKite checks the plan and assigns each slice inside the crew: every slice runs on the crew builder, and a hard slice runs on the crew fixer when the crew has one. No provider outside the crew takes a slice, and Local takes one only when a crew role is Local. When the crew builder reaches its usage limit and Continue on another provider is on, the handoff rule may still move a slice to another provider. A provider the person rules out in the message, such as "do not assign anything to Local", takes no slice, and CrewKite reads that from the message itself. Slices whose dependencies are done start together, each in its own copy of the project, with at most one turn per provider at a time. Each slice that changes files gets a review.`,
    'The slices are the parallel workers, and CrewKite starts them after your turn. Your own turn only reads and plans, so you start no agent to do the work. When the person asks for a number of agents or subagents, split the work into that many slices where it divides that way, leave the independent ones without depends, and say in your summary which slices run side by side.',
    'With a plan, reply with a short summary in plain sentences: what each slice does and which ones run side by side. The person sees the plan as a card, so the summary does not repeat its JSON or list its fields. End the reply with exactly one fenced code block whose opening line is ```json plan and which holds one JSON object of this shape:',
    PLAN_EXAMPLE,
    'Rules:',
    '- planId: letters, digits, dot, underscore or hyphen, at most 64 characters.',
    '- goal: at most 2,000 characters.',
    `- slices: 1 to ${sliceCap}. Each id is a number from 1 to ${sliceCap}, used once.`,
    '- title: at most 120 characters. brief: at most 4,000 characters, written so a model can do the slice without reading this reply.',
    '- files: at most 40 paths the slice reads or changes, relative to the root of the scratch copy, with forward slashes, no leading slash and no `..`. Name a file the slice creates by the path it will have.',
    '- depends: ids of the slices that must finish first. No cycles.',
    '- difficulty: easy for a small change a small local model can make from the named files alone; medium for a change across a few files that needs judgment; hard for design work or a change that needs much of the codebase in view.',
    '- readOnly: true when the slice only reads, such as an investigation, and changes no file.',
    '- hint is optional and can be left out. hint.family only breaks a tie when the handoff rule moves a slice out of the crew.',
  ].join('\n');
}

/** The message that sends a plan that failed validation back to the orchestrator, once. */
export const PLAN_RETRY = 'The plan did not pass validation.';
/**
 * The retry runs in a fresh session on clients that read no history, so it carries the request.
 */
export const planRetryText = (error: string, request: string) =>
  [
    `${PLAN_RETRY} ${error}`,
    'Reply again with one corrected plan block for this request:',
    request
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
  ].join('\n\n');

/**
 * The message a slice's builder turn answers. It may resume the builder's native session, which
 * skips the system context, so the slice travels in the message with its assignment line.
 */
export function sliceBrief(
  plan: { planId: string; goal: string; slices: readonly unknown[] },
  slice: { id: number; title: string; brief: string; files: readonly string[]; readOnly: boolean },
  assignment: string,
  report = false,
): string {
  return [
    `Slice ${slice.id} of ${plan.slices.length} in plan ${plan.planId}: ${slice.title}`,
    `The plan's goal: ${plan.goal}`,
    assignment,
    slice.brief,
    slice.files.length
      ? `Files for this slice, relative to the scratch copy:\n${slice.files.join('\n')}`
      : '',
    slice.readOnly
      ? 'This slice only reads. Read and search the files it needs, change none of them, and report what you found.'
      : 'Do only this slice. Later slices cover the rest of the plan. Say which files you changed and why.',
    report ? REPORT_SLICE_ENDING : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The slice brief for a Local builder: the goal on one line, the task and the files. A small
 * window has no room for the plan's framing, and Local starts fresh each turn, so nothing else
 * has to travel in the message.
 */
export function localSliceBrief(
  plan: { goal: string },
  slice: { brief: string; files: readonly string[]; readOnly: boolean },
  report = false,
): string {
  return [
    `Goal: ${plan.goal.replace(/\s+/g, ' ').trim()}`,
    `Task: ${slice.brief}${slice.readOnly ? ' Read only and change no file.' : ''}`,
    slice.files.length ? `Files:\n${slice.files.join('\n')}` : '',
    report ? REPORT_SLICE_ENDING : '',
  ]
    .filter(Boolean)
    .join('\n\n');
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
  /** True when this turn has the thread tools. The packet names them only then. */
  threadTools: boolean;
  /** The thread's last plan and its slice results, for an orchestrator turn. */
  plan?: string | null;
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
    input.reason === 'ask'
      ? `This is a side question to ${familyName[input.to]} about the thread below. Answer it from the thread and the scratch copy, and change nothing.`
      : input.reason === 'plan'
        ? 'You are the orchestrator of this thread. The conversation below holds the earlier plans: the plan replies, the slice briefs and what each slice answered. The last plan and its results follow it.'
        : input.reason === 'rerun'
          ? `This message runs again on ${familyName[input.to]} in a new session. Reason: ${handoffReason(input.reason, input.from)}.`
          : input.from === input.to && (input.reason === 'model' || input.reason === 'session')
            ? `This thread continues on ${familyName[input.to]} in a new session. Reason: ${handoffReason(input.reason, input.from)}.`
            : input.from === input.to
              ? `The last reply on ${familyName[input.from]} was stopped before it finished. Reason: ${handoffReason(input.reason, input.from)}.`
              : `This thread moved from ${familyName[input.from]} to ${familyName[input.to]}. Reason: ${handoffReason(input.reason, input.from)}.`;
  return [
    opening,
    'Earlier work is in the same scratch copy. Read files before you change them.',
    ...(input.threadTools ? [THREAD_TOOLS_LINE] : []),
    `Conversation so far, oldest first:\n\n${transcript.join('\n\n') || 'No earlier messages.'}`,
    input.plan ? `The last plan in this thread:\n${input.plan}` : '',
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

/**
 * The thread's last plan in words for the orchestrator: its goal, where it stands, and each
 * slice with its status and the model it ran on.
 */
export function planSummary(plan: {
  goal: string;
  phase: string;
  slices: readonly {
    id: number;
    title: string;
    status: string;
    assignment: { family: ChatFamily; model: string } | null;
  }[];
}): string {
  return [
    `Goal: ${plan.goal}`,
    `Plan: ${plan.phase}.`,
    ...plan.slices.map(
      (slice) =>
        `Slice ${slice.id}, ${slice.title}: ${slice.status}${slice.assignment ? `, on ${familyName[slice.assignment.family]} (${slice.assignment.model})` : ''}.`,
    ),
  ].join('\n');
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

/** A packet for a turn that found out late it has no thread tools, with the line taken out. */
export const withoutThreadToolsLine = (text: string): string =>
  text.replace(`\n\n${THREAD_TOOLS_LINE}`, '');

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
  /** True when this turn has the thread tools. The packet names them only then. */
  threadTools: boolean;
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
      ? `This thread moved from ${familyName[input.from]} to ${to}. Reason: ${handoffReason(input.reason, input.from)}. This session holds the thread up to its last turn on ${to}.`
      : `Other providers took turns in this thread since its last turn on ${to}.`;
  return [
    opening,
    'Earlier work is in the same scratch copy. Read files before you change them.',
    ...(input.threadTools ? [THREAD_TOOLS_LINE] : []),
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
