import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_SAVED_PROMPTS,
  type SavedPrompt,
  type SavedPrompts,
  SavedPromptsSchema,
} from '@crewkite/contracts';

// Named prompts with {{placeholders}}, kept in the controller home so every client reads the same
// list. A saved prompt is text for the composer. It grants nothing and runs nothing.

const file = (home: string) => join(home, 'prompts.json');

export class PromptsRefused extends Error {
  reason: 'prompts-unreadable' | 'prompts-full' | 'prompt-not-found';
  next: string;
  constructor(reason: PromptsRefused['reason'], next: string) {
    super(next);
    this.reason = reason;
    this.next = next;
  }
}

export function readPrompts(home: string): SavedPrompts {
  let raw: string;
  try {
    raw = readFileSync(file(home), 'utf8');
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return { prompts: [] };
    throw new PromptsRefused('prompts-unreadable', 'The saved prompts file could not be read.');
  }
  const parsed = SavedPromptsSchema.safeParse(safeJson(raw));
  // A file that does not parse stays on disk untouched until the person fixes or removes it.
  if (!parsed.success)
    throw new PromptsRefused(
      'prompts-unreadable',
      'The saved prompts file is not valid. Fix or remove prompts.json in the controller home.',
    );
  return parsed.data;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(home: string, prompts: SavedPrompt[]) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = `${file(home)}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({ prompts: prompts.sort((a, b) => (a.name < b.name ? -1 : 1)) }),
    { mode: 0o600 },
  );
  renameSync(temporary, file(home));
}

/** Saving a name that exists replaces its body. */
export function savePrompt(home: string, prompt: SavedPrompt): SavedPrompts {
  const current = readPrompts(home).prompts.filter(({ name }) => name !== prompt.name);
  if (current.length >= MAX_SAVED_PROMPTS)
    throw new PromptsRefused('prompts-full', 'Delete a saved prompt before adding another.');
  write(home, [...current, prompt]);
  return readPrompts(home);
}

export function deletePrompt(home: string, name: string): SavedPrompts {
  const current = readPrompts(home).prompts;
  if (!current.some((prompt) => prompt.name === name))
    throw new PromptsRefused('prompt-not-found', 'No saved prompt has that name.');
  write(
    home,
    current.filter((prompt) => prompt.name !== name),
  );
  return readPrompts(home);
}
