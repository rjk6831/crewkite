import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  completeSlash,
  expandPrompt,
  parsePromptArgument,
  parseSlash,
  promptsToJson,
} from '@crewkite/client';
import { SavedPromptsExportSchema } from '@crewkite/contracts';
import { deletePrompt, PromptsRefused, readPrompts, savePrompt } from './saved-prompts.ts';

test('saved prompts persist in the controller home, export as JSON and insert with their placeholders filled', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'crewkite-prompts-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(readPrompts(home).prompts, []);
  savePrompt(home, { name: 'review-notes', body: 'Review {{area}} for {{risk}}.' });
  savePrompt(home, { name: 'explain', body: 'Explain {{area}}.' });
  // Saving a name again replaces its body.
  savePrompt(home, { name: 'explain', body: 'Explain {{area}} to a new teammate.' });
  assert.deepEqual(
    readPrompts(home).prompts.map(({ name }) => name),
    ['explain', 'review-notes'],
  );
  assert.equal(readFileSync(join(home, 'prompts.json'), 'utf8').includes('new teammate'), true);

  // The export is a versioned JSON file that the schema accepts and that sorts by name.
  const exported = SavedPromptsExportSchema.parse(
    JSON.parse(promptsToJson(readPrompts(home).prompts)),
  );
  assert.deepEqual(
    exported.prompts.map(({ name }) => name),
    ['explain', 'review-notes'],
  );

  // /prompt name key=value fills what it is given and names what is still open.
  assert.deepEqual(
    completeSlash('/pr').map(({ name }) => name),
    ['pr', 'provider', 'prompt'],
  );
  assert.equal(parseSlash('/usr/bin/env is missing'), null);
  // A message that starts with a command word is a message, and an exact name selects itself.
  assert.equal(parseSlash('/new endpoint returns 500'), null);
  assert.equal(parseSlash('/help me fix the build'), null);
  assert.equal(parseSlash('/new')?.name, 'new');
  assert.equal(completeSlash('/pr')[0].name, 'pr');
  const slash = parseSlash('/prompt review-notes area="the login form" risk=leaks');
  assert.equal(slash?.name, 'prompt');
  const { name, values } = parsePromptArgument(slash?.argument ?? '');
  const body = readPrompts(home).prompts.find((prompt) => prompt.name === name)?.body ?? '';
  assert.deepEqual(expandPrompt(body, values), {
    text: 'Review the login form for leaks.',
    missing: [],
  });
  assert.deepEqual(expandPrompt(body, { area: 'docs' }), {
    text: 'Review docs for {{risk}}.',
    missing: ['risk'],
  });

  deletePrompt(home, 'explain');
  assert.deepEqual(
    readPrompts(home).prompts.map((prompt) => prompt.name),
    ['review-notes'],
  );
  assert.throws(() => deletePrompt(home, 'explain'), PromptsRefused);
  // A damaged file is refused and left for the person to fix, not overwritten.
  writeFileSync(join(home, 'prompts.json'), '{broken');
  assert.throws(() => savePrompt(home, { name: 'x', body: 'y' }), PromptsRefused);
  assert.equal(readFileSync(join(home, 'prompts.json'), 'utf8'), '{broken');
});
