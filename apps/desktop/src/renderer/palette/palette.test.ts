import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slashCommands } from '@crewkite/client';
import { clearsDraft } from '../thread/slash-actions.ts';
import { provision } from './actions.ts';
import { type PaletteApp, paletteEntries } from './entries.ts';
import { fuzzyMatch, rankCommands } from './fuzzy.ts';
import { selectedOption } from './select.ts';

test('fuzzy matching finds words in order, prefers word starts and marks what matched', () => {
  const table: { query: string; text: string; indexes: number[] | null }[] = [
    { query: 'nt', text: 'New thread', indexes: [0, 4] },
    { query: 'NEW', text: 'New thread', indexes: [0, 1, 2] },
    { query: 'open set', text: 'Open settings', indexes: [0, 1, 2, 3, 5, 6, 7] },
    { query: 'tn', text: 'New thread', indexes: null },
    { query: 'zz', text: 'New thread', indexes: null },
    // The matched letters of an astral character cover both of its UTF-16 units.
    { query: 'go', text: '\u{1f600} go', indexes: [3, 4] },
    { query: 'é', text: 'Café', indexes: [3] },
  ];
  for (const row of table)
    assert.deepEqual(fuzzyMatch(row.query, row.text)?.indexes ?? null, row.indexes, row.query);

  const commands = [
    { label: 'Show changes', keywords: '/changes Show the changes in the scratch copy.' },
    { label: 'Open settings', keywords: '/settings' },
    { label: 'Settings: OpenAI' },
    { label: 'Pick a model', keywords: '/model Pick the model for this thread.' },
  ];
  const order = (query: string) =>
    rankCommands(commands, query).map(({ command }) => command.label);
  assert.deepEqual(
    order(''),
    commands.map(({ label }) => label),
  );
  assert.deepEqual(order('set'), ['Settings: OpenAI', 'Open settings']);
  assert.deepEqual(order('chg'), ['Show changes']);
  // A word in the keywords finds a command by what it does, with no mark in its label.
  assert.deepEqual(rankCommands(commands, 'scratch'), [{ command: commands[0], match: null }]);
  assert.deepEqual(order('/model'), ['Pick a model']);
});

const app = (calls: string[]): PaletteApp => ({
  newThread: () => calls.push('new'),
  openSettings: () => calls.push('settings'),
  openSettingsSection: (id) => calls.push(`section:${id}`),
  about: () => calls.push('about'),
  switchThread: (step) => calls.push(`switch:${step}`),
  addProject: null,
  reconnect: null,
  theme: 'light',
  toggleTheme: () => calls.push('theme'),
  sidebarCollapsed: false,
  toggleSidebar: () => calls.push('sidebar'),
});

test('every palette entry runs an action that exists and grants nothing of its own', () => {
  const calls: string[] = [];
  const now = (action: () => void) => action();
  const entries = paletteEntries(app(calls), provision, now);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  // Every slash command is listed once, so a new one cannot be left out of the palette.
  for (const { name } of slashCommands) assert.ok(byId.has(`slash-${name}`), name);
  assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);

  // With no composer or thread open, the commands that need one are off and say why. Opening
  // settings, a new thread and every settings section still work.
  const off = entries.filter((entry) => entry.disabled).map((entry) => entry.id);
  assert.ok(off.includes('slash-changes') && off.includes('export-markdown'));
  assert.ok(!off.includes('slash-new') && !off.includes('slash-settings'));
  assert.ok(entries.filter((entry) => entry.disabled).every((entry) => /first/.test(entry.hint)));
  byId.get('slash-new')?.run();
  byId.get('settings-st-card-openai')?.run();
  byId.get('next-thread')?.run();
  assert.deepEqual(calls.splice(0), ['new', 'section:st-card-openai', 'switch:1']);

  // The consequential commands are never the one Enter picks after typing.
  for (const id of ['slash-accept', 'slash-push', 'slash-pr', 'export-markdown', 'share-page'])
    assert.equal(byId.get(id)?.explicit, true, id);

  // A view's actions run through what the view provided, and only once it is provided.
  const ran: string[] = [];
  const withViews = () => ({
    slash: (name: string, argument: string) => ran.push(`${name}:${JSON.stringify(argument)}`),
    exporter: { markdown: () => ran.push('markdown'), share: () => ran.push('share') },
  });
  const active = paletteEntries(app(calls), withViews as never, now);
  assert.ok(active.every((entry) => !entry.disabled));
  for (const id of ['slash-changes', 'slash-model', 'export-markdown', 'share-page'])
    active.find((entry) => entry.id === id)?.run();
  assert.deepEqual(ran, ['changes:""', 'model:""', 'markdown', 'share']);
});

test('Enter runs the top match only when it is not explicit, and never skips to a lower one', () => {
  const views = () => ({
    slash: () => {},
    exporter: { markdown: () => {}, share: () => {} },
  });
  const entries = paletteEntries(app([]), views as never, (action) => action());
  const options = (query: string) =>
    rankCommands(entries, query)
      .map(({ command }) => command)
      .filter((command) => !command.disabled)
      .map((command) => ({ key: command.id, explicit: Boolean(command.explicit) }));
  const picked = (query: string, active: string | null = null) =>
    selectedOption(options(query), active)?.key ?? null;

  // The top match is an explicit command: Enter does nothing until the person moves to something.
  assert.equal(options('push')[0]?.key, 'slash-push');
  assert.equal(picked('push'), null);
  assert.equal(picked('push', 'slash-push'), 'slash-push');
  assert.equal(picked('share'), null);
  assert.equal(options('ext')[0]?.key, 'export-markdown');
  assert.equal(picked('ext'), null);
  // A top match that is not explicit runs, and an arrow choice wins over it.
  assert.equal(picked('set'), 'settings-settings-general');
  assert.equal(picked('set', 'slash-settings'), 'slash-settings');
  // A key that is no longer listed falls back to the same rule, and an empty list picks nothing.
  assert.equal(picked('set', 'gone'), 'settings-settings-general');
  assert.equal(selectedOption([], null), null);
  // Lower matches are not reached around an explicit top match.
  assert.deepEqual(
    selectedOption(
      [
        { key: 'a', explicit: true },
        { key: 'b', explicit: false },
      ],
      null,
    ),
    null,
  );
});

test('a palette command leaves the draft in the box and a typed command clears it', () => {
  const table: [Parameters<typeof clearsDraft>[0], boolean, boolean][] = [
    ['new-thread', false, true],
    ['open-settings', false, true],
    ['ask', false, true],
    ['new-thread', true, false],
    ['open-changes', true, false],
    ['ask', true, false],
    ['none', false, false],
    ['prompt', false, false],
  ];
  for (const [action, keepDraft, clears] of table)
    assert.equal(clearsDraft(action, keepDraft), clears, `${action} ${keepDraft}`);
});
