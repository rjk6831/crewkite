import { realpathSync } from 'node:fs';
import {
  AgentEventSchema,
  type ChatExport,
  ChatExportSchema,
  type ChatFamily,
  type ChatToolKind,
  ChatTurnSchema,
  ConversationEntrySchema,
  EXPORT_CONTENT_BYTES,
  type ExportFormat,
  type Task,
} from '@crewkite/contracts';
import type { Store } from '../store/index.ts';
import { redact } from './thread-reader.ts';

// Thread export. The controller renders the thread as Markdown for the person's own notes or as a
// read-only share page, and the client writes the text where the person chose. The renderer never
// reads the database. Nothing here uploads, and the share page carries no script and loads
// nothing, so a reviewer can read what it holds.

/** One tool call folded to the line a reader needs: what kind, what it was called, how it ended. */
export type ExportTool = {
  kind: ChatToolKind;
  title: string;
  status: 'ok' | 'error' | 'denied' | 'open';
};
export type ExportMessage = {
  at: string;
  role: 'user' | 'assistant' | 'system';
  family?: ChatFamily;
  model?: string;
  text: string;
  /** File names only. The bytes of an attachment never reach an export. */
  files: string[];
  tools: ExportTool[];
  /** Tool calls past the lines the export keeps. */
  more?: number;
};
export type ExportModel = {
  title: string;
  turns: number;
  families: ChatFamily[];
  messages: ExportMessage[];
  /** Messages of the thread that the model does not hold, oldest first. */
  older: number;
};
/** Folders to reduce in text. Roots become relative paths, homes become `~`. */
export type ExportPaths = { roots: readonly string[]; homes: readonly string[] };

const MESSAGE_CHARACTERS = 32 * 1024;
const TOOL_LINES = 100;
const TOOL_TITLE = 200;
const MESSAGES_READ = 5000;
// Room for the header, the closing lines and the markup around the blocks.
const FRAME_RESERVE = 16 * 1024;

const escapeText = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEPARATOR = '[\\\\/]+';

/** Matches a folder and what follows it up to the next separator or word end, never a sibling. */
function folderPattern(folder: string): RegExp | null {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const lead = /^[\\/]/.test(folder) ? '[\\\\/]' : '';
  return new RegExp(
    `(?<![\\w.~-])${lead}${parts.map(escapeText).join(SEPARATOR)}(?:${SEPARATOR}|(?![\\w.-]))`,
    'g',
  );
}

const OTHER_HOMES = [
  /(?<![\w.~-])\/(?:Users|home)\/[^/\\\s'"`:;,)\]}>]+/g,
  /(?<![\w.~-])[A-Za-z]:\\Users\\[^\\\s'"`:;,)\]}>]+/g,
  /(?<![\w.~-])\/root(?![\w.-])/g,
];
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// Control characters other than the line break and the tab, and the bidirectional controls that
// can reorder text on screen.
const CONTROL = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;
const KEEP = new Set(['\n', '\t']);

/**
 * Every text field goes through this before it is placed in an export: well-formed Unicode with no
 * control or reordering characters, paths reduced, the controller's pattern redaction for secrets,
 * then email addresses. Redaction matches known shapes and misses others, which ADR 0044 says.
 */
export function scrubber(paths: ExportPaths): (text: string) => string {
  const folders = [...new Set(paths.roots)]
    .sort((a, b) => b.length - a.length)
    .flatMap((folder) => {
      const pattern = folderPattern(folder);
      return pattern ? [{ pattern, to: '' }] : [];
    });
  const homes = [...new Set(paths.homes)]
    .sort((a, b) => b.length - a.length)
    .flatMap((folder) => {
      const pattern = folderPattern(folder);
      return pattern ? [pattern] : [];
    });
  return (text) => {
    let next = text.toWellFormed().replace(CONTROL, (found) => (KEEP.has(found) ? found : ''));
    for (const { pattern, to } of folders)
      next = next.replace(pattern, (found) => (/[\\/]$/.test(found) ? to : '.'));
    for (const pattern of homes)
      next = next.replace(pattern, (found) => (/[\\/]$/.test(found) ? '~/' : '~'));
    for (const pattern of OTHER_HOMES) next = next.replace(pattern, '~');
    return redact(next).replace(EMAIL, '[redacted]');
  };
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Keep a surrogate pair whole.
  const end = /[\ud800-\udbff]/.test(text[limit - 1] ?? '') ? limit - 1 : limit;
  return `${text.slice(0, end)}\n[cut: ${Math.ceil(limit / 1024)} KiB of ${Math.ceil(text.length / 1024)} KiB shown]`;
}

/** A model with every field scrubbed and bounded. Both renderers take this and nothing else. */
export function scrubModel(model: ExportModel, scrub: (text: string) => string): ExportModel {
  const line = (text: string) => scrub(text).replace(/\s+/g, ' ').trim();
  return {
    title: line(model.title) || 'Thread',
    turns: model.turns,
    older: model.older,
    families: model.families,
    messages: model.messages.map((message) => ({
      at: message.at,
      role: message.role,
      ...(message.family ? { family: message.family } : {}),
      ...(message.model ? { model: line(message.model).slice(0, 128) } : {}),
      text: clip(scrub(message.text), MESSAGE_CHARACTERS),
      files: message.files.map((name) => line(name).slice(0, 255)),
      tools: message.tools
        .slice(0, TOOL_LINES)
        .map((tool) => ({ ...tool, title: line(tool.title).slice(0, TOOL_TITLE) })),
      more: Math.max(0, message.tools.length - TOOL_LINES),
    })),
  };
}

const day = (at: string) => at.slice(0, 10);
function dateRange(model: ExportModel): string {
  const days = model.messages.map((message) => day(message.at)).sort();
  if (days.length === 0) return 'no messages';
  const [first, last] = [days[0], days[days.length - 1]];
  return first === last ? first : `${first} to ${last}`;
}
const toolWord = (tool: ExportTool) =>
  tool.status === 'open' ? `${tool.kind}, no result` : `${tool.kind}, ${tool.status}`;
const speaker = (message: ExportMessage) =>
  message.role === 'user'
    ? 'You'
    : message.role === 'system'
      ? 'CrewKite'
      : `Assistant (${message.family ?? 'unknown'}${message.model ? `, ${message.model}` : ''})`;

/**
 * The newest blocks that fit. A block is never cut here: its text was bounded in scrubModel. The
 * count of blocks dropped from the front is what the header reports.
 */
function newest(blocks: readonly string[]): { kept: string[]; dropped: number } {
  const limit = EXPORT_CONTENT_BYTES - FRAME_RESERVE;
  let used = 0;
  let start = blocks.length;
  while (start > 0) {
    const size = Buffer.byteLength(blocks[start - 1]);
    if (used + size > limit) break;
    used += size;
    start -= 1;
  }
  return { kept: blocks.slice(start), dropped: start };
}

const fence = (value: string) => {
  const text = value || 'no title';
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(Math.max(1, longest + 1));
  return `${ticks}${text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text}${ticks}`;
};

/** The thread as Markdown. A tool call is one line, and attachments are named, not embedded. */
export function renderMarkdown(model: ExportModel): { text: string; omitted: number } {
  const blocks = model.messages.map((message) => {
    const lines = [`## ${speaker(message)}`, '', `_${message.at}_`, ''];
    if (message.tools.length > 0) {
      for (const tool of message.tools) lines.push(`- ${toolWord(tool)}: ${fence(tool.title)}`);
      if (message.more) lines.push(`- and ${message.more} more tool calls`);
      lines.push('');
    }
    if (message.text) lines.push(message.text, '');
    if (message.files.length > 0)
      lines.push(`Attachments, not included: ${message.files.join(', ')}`, '');
    return `${lines.join('\n')}\n`;
  });
  const { kept, dropped } = newest(blocks);
  const omitted = model.older + dropped;
  const head = [
    `# ${model.title}`,
    '',
    `${model.turns} ${model.turns === 1 ? 'turn' : 'turns'} on ${model.families.join(', ') || 'no provider'}. ${dateRange(model)}.`,
    'Secrets and email addresses are redacted. Each tool call is one line. Attachments are named and not included.',
    ...(omitted > 0
      ? [`${omitted} earlier ${omitted === 1 ? 'message is' : 'messages are'} not in this file.`]
      : []),
    '',
    '',
  ];
  return { text: `${head.join('\n')}${kept.join('\n')}`, omitted };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (found) => `&#${found.charCodeAt(0)};`);

// The page's own rules. Colors follow the reader's light or dark setting, fonts are the system's,
// and nothing is fetched.
const STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--muted:#5f6368;--line:#d8dadd;--panel:#f5f6f7}
@media (prefers-color-scheme:dark){:root{--bg:#161718;--fg:#ececec;--muted:#a0a4a8;--line:#34373a;--panel:#202224}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main,header{max-width:46rem;margin:0 auto;padding:0 1rem}
header{padding-top:2rem;padding-bottom:1rem;border-bottom:1px solid var(--line)}
h1{font-size:1.5rem;margin:0 0 .5rem}h2{font-size:1rem;margin:0 0 .25rem}
dl{margin:1rem 0 0}dt{font-weight:600;margin-top:.5rem}dd{margin:0;color:var(--muted)}
section{margin:1.5rem 0;padding:.75rem 1rem;border:1px solid var(--line);border-radius:8px}
section.user{background:var(--panel)}
time{color:var(--muted);font-size:.85rem;margin-left:.5rem;font-weight:400}
ul{margin:.5rem 0;padding-left:1.25rem;color:var(--muted);font-size:.9rem}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:ui-monospace,monospace;font-size:.9em;overflow-wrap:anywhere}
.files{color:var(--muted);font-size:.9rem;margin:.5rem 0 0}`;
// No script source, no frame, no form, no fetch, no font and no image except an inline one.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/**
 * The thread as one self-contained HTML page. Message text is shown as escaped plain text, never
 * parsed, so no link, image or markup in a message can act.
 */
export function renderShare(model: ExportModel): { text: string; omitted: number } {
  const blocks = model.messages.map((message) => {
    const list =
      message.tools.length > 0
        ? `<ul>${message.tools
            .map(
              (tool) =>
                `<li>${escapeHtml(toolWord(tool))}: <code>${escapeHtml(tool.title)}</code></li>`,
            )
            .join('')}${message.more ? `<li>and ${message.more} more tool calls</li>` : ''}</ul>`
        : '';
    const files =
      message.files.length > 0
        ? `<p class="files">Attachments, not included: ${escapeHtml(message.files.join(', '))}</p>`
        : '';
    return `<section class="${message.role}"><h2>${escapeHtml(speaker(message))}<time>${escapeHtml(message.at)}</time></h2>${list}${message.text ? `<div class="text">${escapeHtml(message.text)}</div>` : ''}${files}</section>\n`;
  });
  const { kept, dropped } = newest(blocks);
  const omitted = model.older + dropped;
  const title = escapeHtml(model.title);
  const families = escapeHtml(model.families.join(', ') || 'no provider');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>${title}</h1>
<p>A read-only copy of a CrewKite thread. This page runs no code and loads nothing from the network.</p>
<dl>
<dt>Contains</dt><dd>${model.turns} ${model.turns === 1 ? 'turn' : 'turns'} on ${families}, ${escapeHtml(dateRange(model))}. The messages in order, with each tool call as one line.${omitted > 0 ? ` ${omitted} earlier ${omitted === 1 ? 'message is' : 'messages are'} not on this page.` : ''}</dd>
<dt>Redacted</dt><dd>Secrets and email addresses are replaced with [redacted]. Folder paths inside the project are shown relative to it, and home folders are shown as ~. Redaction matches known patterns and can miss other formats, so read the page before you share it.</dd>
<dt>Left out</dt><dd>Attachments, which are listed by name only, tool output, file contents and diffs, model reasoning, and the thread settings.</dd>
</dl>
</header>
<main>
${kept.join('')}</main>
</body>
</html>
`;
  return { text: html, omitted };
}

const slug = (title: string) =>
  title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 60)
    .replace(/-+$/, '');

export type ExportSource = Readonly<{
  store: Store;
  projectPath: (projectId: string) => string | undefined;
  scratchDirectory: (taskId: string) => string;
  /** The person's home folders, shown as `~`. */
  homes: readonly string[];
}>;

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Reads the thread from the store for the renderers. The newest messages come first when many. */
export function readExportModel(source: ExportSource, taskId: string): ExportModel | null {
  const { store } = source;
  const task = store.get<Task>('task', taskId);
  if (!task) return null;
  const turns = store.db
    .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence')
    .all(taskId)
    .map((row) => ChatTurnSchema.parse(JSON.parse(row.body as string)));
  const total = Number(
    (
      store.db
        .prepare(
          "SELECT count(*) AS n FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind') IN ('user-message','chat-assistant','chat-system')",
        )
        .get(taskId) as { n: number | bigint }
    ).n,
  );
  const entries = store.db
    .prepare(
      "SELECT body FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind') IN ('user-message','chat-assistant','chat-system') ORDER BY sequence DESC LIMIT ?",
    )
    .all(taskId, MESSAGES_READ)
    .reverse()
    .map((row) => ConversationEntrySchema.parse(JSON.parse(row.body as string)));
  // Tool calls by turn, in the order they started, with how each ended.
  const calls = new Map<string, Map<string, ExportTool>>();
  for (const row of store.db
    .prepare(
      "SELECT body FROM events WHERE task_id=? AND json_extract(body,'$.type')='agent.event' AND json_extract(body,'$.payload.type') IN ('tool.started','tool.completed') ORDER BY cursor",
    )
    .iterate(taskId)) {
    const event = AgentEventSchema.parse(JSON.parse(row.body as string).payload);
    if (event.type !== 'tool.started' && event.type !== 'tool.completed') continue;
    const turn = calls.get(event.turnId) ?? new Map<string, ExportTool>();
    calls.set(event.turnId, turn);
    if (event.type === 'tool.started')
      turn.set(event.callId, { kind: event.kind, title: event.title, status: 'open' });
    else {
      const call = turn.get(event.callId);
      if (call) call.status = event.status;
    }
  }
  const toolsOf = (turnId: string) => [...(calls.get(turnId)?.values() ?? [])];
  const unanswered = new Map(
    turns.filter((turn) => !turn.assistantMessageId).map((turn) => [turn.userMessageId, turn]),
  );
  const messages: ExportMessage[] = [];
  // A turn can save more than one reply. Its tool lines belong to the first.
  const listed = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'user-message') {
      messages.push({
        at: entry.at,
        role: 'user',
        text: entry.text,
        // A saved path string names a file by its last part.
        files: [
          ...(entry.files ?? []).map((file) => file.name),
          ...(entry.attachments ?? []).map((path) => path.split(/[\\/]/).at(-1) ?? path),
        ],
        tools: [],
      });
      const turn = unanswered.get(entry.id);
      if (turn)
        messages.push({
          at: turn.endedAt ?? turn.startedAt,
          role: 'system',
          text: `The turn on ${turn.selection.family} ended without a saved reply (${turn.state}).`,
          files: [],
          tools: toolsOf(turn.id),
        });
    } else if (entry.kind === 'chat-assistant') {
      messages.push({
        at: entry.at,
        role: 'assistant',
        family: entry.author.family,
        model: entry.author.model,
        text: entry.text,
        files: [],
        tools: listed.has(entry.author.turnId) ? [] : toolsOf(entry.author.turnId),
      });
      listed.add(entry.author.turnId);
    } else if (entry.kind === 'chat-system')
      messages.push({ at: entry.at, role: 'system', text: entry.text, files: [], tools: [] });
  }
  const families = [...new Set(turns.map((turn) => turn.selection.family))];
  return {
    title: task.title,
    turns: turns.length,
    families,
    messages,
    older: Math.max(0, total - entries.length),
  };
}

/** The thread rendered in one format, or null when the task does not exist. */
export function exportThread(
  source: ExportSource,
  payload: { taskId: string; format: ExportFormat },
): ChatExport | null {
  const model = readExportModel(source, payload.taskId);
  if (!model) return null;
  const task = source.store.get<Task>('task', payload.taskId);
  const project = task && source.projectPath(task.projectId);
  const scratch = source.scratchDirectory(payload.taskId);
  const roots = [project, scratch].flatMap((path) => (path ? [path, real(path)] : []));
  const scrub = scrubber({ roots, homes: source.homes.flatMap((path) => [path, real(path)]) });
  const safe = scrubModel(model, scrub);
  const { text, omitted } = payload.format === 'html' ? renderShare(safe) : renderMarkdown(safe);
  const extension = payload.format === 'html' ? 'html' : 'md';
  return ChatExportSchema.parse({
    taskId: payload.taskId,
    format: payload.format,
    filename: `crewkite-${slug(safe.title) || 'thread'}.${extension}`,
    content: text,
    turns: model.turns,
    omitted,
  });
}
