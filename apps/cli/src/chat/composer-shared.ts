// shortcut: a thin local stand-in for packages/client/src/slash-commands.ts and
// packages/client/src/mentions.ts, which the composer lane owns and merges first. The names and
// signatures match those modules; at merge this file becomes two re-exports from @crewkite/client.
// Limit: the ranking here is a plain subsequence score, so an order can differ from the desktop's
// until the switch.

export type SlashName =
  | 'new'
  | 'model'
  | 'provider'
  | 'crew'
  | 'plan'
  | 'ask'
  | 'handoff'
  | 'changes'
  | 'accept'
  | 'push'
  | 'pr'
  | 'settings'
  | 'help'
  | 'prompt';
export type SlashCommand = Readonly<{ name: SlashName; summary: string; argument?: string }>;
export type ParsedSlash = Readonly<{ name: SlashName; argument: string }>;

export const slashCommands: readonly SlashCommand[] = [
  { name: 'new', summary: 'Start a new thread.' },
  { name: 'model', summary: 'Pick the model for this thread.', argument: 'model' },
  { name: 'provider', summary: 'Pick the provider for this thread.', argument: 'family' },
  { name: 'crew', summary: 'Show the crew and the flight mode.' },
  { name: 'plan', summary: 'Show the plan the orchestrator proposed.' },
  { name: 'ask', summary: 'Ask another model a read-only question.', argument: 'question' },
  { name: 'handoff', summary: 'Move the thread to another provider.', argument: 'family' },
  { name: 'changes', summary: 'Show the changes in the scratch copy.' },
  { name: 'accept', summary: 'Accept the changes on a new local branch.', argument: 'branch' },
  { name: 'push', summary: 'Push the accepted branch.' },
  { name: 'pr', summary: 'Open a pull request for the pushed branch.' },
  { name: 'settings', summary: 'Open settings.' },
  { name: 'help', summary: 'List the slash commands and keys.' },
  { name: 'prompt', summary: 'Insert a saved prompt.', argument: 'name' },
];

/** A line that starts with a known command name. Any other text, such as a path, is a message. */
export function parseSlash(text: string): ParsedSlash | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const command = slashCommands.find(({ name }) => name === match[1]);
  return command ? { name: command.name, argument: (match[2] ?? '').trim() } : null;
}

/** Commands whose name starts with what is typed after the slash, while the name is unfinished. */
export function completeSlash(text: string): SlashCommand[] {
  const match = /^\/([a-z]*)$/.exec(text);
  return match ? slashCommands.filter(({ name }) => name.startsWith(match[1])) : [];
}

export const slashHelp = (): string =>
  slashCommands
    .map(({ name, argument, summary }) => `/${name}${argument ? ` ${argument}` : ''}: ${summary}`)
    .join('\n');

export type MentionCandidate = Readonly<{ path: string; kind: 'file' | 'folder' }>;
export type MentionTrigger = Readonly<{ start: number; end: number; query: string }>;

/** The mention being typed at the caret: an at sign at the start or after white space. */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  if (text[start] !== '@') return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { start, end, query: text.slice(start + 1, caret) };
}

export function mentionText(mention: MentionCandidate): string {
  const path = mention.kind === 'folder' ? `${mention.path.replace(/\/+$/, '')}/` : mention.path;
  return /[\s`]/.test(path) ? `\`${path.replaceAll('`', '')}\`` : path;
}

export function insertMention(
  text: string,
  trigger: MentionTrigger,
  mention: MentionCandidate,
): { text: string; caret: number } {
  const inserted = `${mentionText(mention)} `;
  const rest = text.slice(trigger.end).replace(/^ /, '');
  return {
    text: `${text.slice(0, trigger.start)}${inserted}${rest}`,
    caret: trigger.start + inserted.length,
  };
}

function score(path: string, query: string): number {
  const full = path.toLowerCase();
  const name = full.slice(full.lastIndexOf('/', full.length - 2) + 1).replace(/\/$/, '');
  if (name === query) return 1000;
  if (name.startsWith(query)) return 800;
  if (name.includes(query)) return 600 - name.indexOf(query);
  if (full.includes(query)) return 400 - Math.min(full.indexOf(query), 200) / 2;
  let at = 0;
  for (const char of full) if (char === query[at]) at++;
  return at === query.length ? 100 : 0;
}

export function rankMentions<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string,
  limit: number,
): T[] {
  const needle = query.trim().toLowerCase().replace(/^\.\//, '');
  return candidates
    .map((item) => ({ item, score: needle === '' ? 1 : score(item.path, needle) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.item.path.split('/').length - b.item.path.split('/').length ||
        a.item.path.length - b.item.path.length ||
        (a.item.path < b.item.path ? -1 : 1),
    )
    .slice(0, Math.max(0, Math.min(Math.floor(limit), 50)))
    .map(({ item }) => item);
}

/** Files and the folders that hold them, ranked for one query. */
export function completeMentionLocally(
  files: readonly string[],
  query: string,
  limit: number,
): MentionCandidate[] {
  const folders = new Set<string>();
  for (const path of files)
    for (let slash = path.indexOf('/'); slash > 0; slash = path.indexOf('/', slash + 1))
      folders.add(path.slice(0, slash));
  const candidates: MentionCandidate[] = [
    ...[...folders].map((path) => ({ path, kind: 'folder' as const })),
    ...files.map((path) => ({ path, kind: 'file' as const })),
  ];
  return rankMentions(candidates, query, limit);
}
