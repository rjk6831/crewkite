// The slash commands the desktop and the command line composer offer. The list and the parsing
// are shared. Each client maps a name to its own action, and says so when it has none.

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

export const slashCommands: readonly SlashCommand[] = [
  { name: 'new', summary: 'Start a new thread.' },
  { name: 'model', summary: 'Pick the model for this thread.' },
  { name: 'provider', summary: 'Pick the provider for this thread.' },
  { name: 'crew', summary: 'Show the crew and the flight mode.' },
  { name: 'plan', summary: 'Show the plan the orchestrator proposed.' },
  { name: 'ask', summary: 'Ask another model a read-only question.', argument: 'question' },
  { name: 'handoff', summary: 'Move the thread to another provider.' },
  { name: 'changes', summary: 'Show the changes in the scratch copy.' },
  { name: 'accept', summary: 'Go to Changes to accept them on a branch.' },
  { name: 'push', summary: 'Go to Changes to push the branch.' },
  { name: 'pr', summary: 'Go to Changes to open a pull request.' },
  { name: 'settings', summary: 'Open settings.' },
  { name: 'help', summary: 'List the slash commands.' },
  { name: 'prompt', summary: 'Insert a saved prompt.', argument: 'name' },
];

export type ParsedSlash = Readonly<{ name: SlashName; argument: string }>;

/**
 * A line that is a known command. A command that takes no argument matches only on its own, so
 * "/new endpoint returns 500" stays a message. Any other text, such as a path, is a message too.
 */
export function parseSlash(text: string): ParsedSlash | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const command = slashCommands.find(({ name }) => name === match[1]);
  const argument = (match[2] ?? '').trim();
  if (!command || (argument !== '' && !command.argument)) return null;
  return { name: command.name, argument };
}

/**
 * Commands whose name starts with what is typed after the slash, while the name is unfinished.
 * An exact name comes first, so "/pr" selects /pr and not /provider.
 */
export function completeSlash(text: string): SlashCommand[] {
  const match = /^\/([a-z]*)$/.exec(text);
  if (!match) return [];
  const found = slashCommands.filter(({ name }) => name.startsWith(match[1]));
  return [
    ...found.filter(({ name }) => name === match[1]),
    ...found.filter(({ name }) => name !== match[1]),
  ];
}

/** The text `/help` shows. */
export const slashHelp = (): string =>
  slashCommands
    .map(({ name, argument, summary }) => `/${name}${argument ? ` ${argument}` : ''}: ${summary}`)
    .join('\n');

const PLACEHOLDER = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;

/** The placeholder names in a saved prompt, in order, once each. */
export const promptPlaceholders = (body: string): string[] => [
  ...new Set([...body.matchAll(PLACEHOLDER)].map((match) => match[1])),
];

/** Split `key=value` words, where a value in double quotes may hold spaces. */
export function parsePromptValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of text.matchAll(/([a-z][a-z0-9_]*)=(?:"([^"]*)"|(\S*))/g))
    values[match[1]] = match[2] ?? match[3] ?? '';
  return values;
}

/**
 * A saved prompt with the given values filled in. A placeholder with no value stays as written,
 * and `missing` names it so the person can fill it in the box.
 */
export function expandPrompt(
  body: string,
  values: Readonly<Record<string, string>>,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = body.replace(PLACEHOLDER, (whole, name: string) => {
    if (Object.hasOwn(values, name)) return values[name];
    missing.add(name);
    return whole;
  });
  return { text, missing: [...missing] };
}

/** `/prompt name key=value ...` split into the prompt name and its values. */
export function parsePromptArgument(argument: string): {
  name: string;
  values: Record<string, string>;
} {
  const text = argument.trim();
  const name = /^\S*/.exec(text)?.[0] ?? '';
  return { name, values: parsePromptValues(text.slice(name.length)) };
}

/** The JSON file for exported saved prompts. Sorted by name so two exports compare equal. */
export const promptsToJson = (prompts: readonly { name: string; body: string }[]): string =>
  `${JSON.stringify(
    {
      version: 1,
      prompts: [...prompts]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, body }) => ({ name, body })),
    },
    null,
    2,
  )}\n`;
