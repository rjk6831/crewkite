import { type SlashName, slashCommands } from '@crewkite/client';
import type { provision } from './actions.ts';

// The commands the palette lists. Every entry calls an action that already exists: an app function
// the sidebar and the shortcuts use, a slash command the composer runs, or the thread view's export.
// An entry holds no authority of its own. The ones that lead toward a change on disk or a push
// are marked explicit, so Enter after typing never picks them for the person.

export type EntryIcon =
  | 'new'
  | 'settings'
  | 'model'
  | 'crew'
  | 'changes'
  | 'help'
  | 'prompt'
  | 'export'
  | 'share'
  | 'thread'
  | 'folder'
  | 'theme'
  | 'sidebar'
  | 'about'
  | 'connect';

export type PaletteEntry = {
  id: string;
  label: string;
  /** What the command does, and the slash name where it has one. */
  hint: string;
  /** Extra words that find the command. */
  keywords: string;
  icon: EntryIcon;
  run: () => void;
  disabled?: boolean;
  explicit?: boolean;
};

/** What the app gives the palette. A null function is an action this window cannot take. */
export type PaletteApp = {
  newThread(): void;
  openSettings(): void;
  openSettingsSection(id: string): void;
  about(): void;
  switchThread(step: 1 | -1): void;
  addProject: (() => void) | null;
  reconnect: (() => void) | null;
  theme: 'light' | 'dark';
  toggleTheme(): void;
  sidebarCollapsed: boolean;
  toggleSidebar(): void;
};

/** Heading ids on the settings page. */
export const SETTINGS_SECTIONS: readonly { id: string; label: string }[] = [
  { id: 'settings-general', label: 'General' },
  { id: 'st-card-openai', label: 'OpenAI' },
  { id: 'st-card-anthropic', label: 'Anthropic' },
  { id: 'st-card-google', label: 'Google' },
  { id: 'st-card-local', label: 'Local' },
  { id: 'settings-mcp', label: 'MCP servers' },
  { id: 'settings-extensions', label: 'Extensions' },
  { id: 'settings-prompts', label: 'Prompts' },
];

// A new slash command fails to compile here until it has a name the palette can show.
const SLASH_LABELS: Record<SlashName, string> = {
  new: 'New thread',
  model: 'Pick a model',
  provider: 'Pick a provider',
  crew: 'Show the crew',
  plan: 'Show the plan',
  ask: 'Ask another model',
  handoff: 'Move the thread to another provider',
  changes: 'Show changes',
  accept: 'Accept changes',
  push: 'Push the branch',
  pr: 'Open a pull request',
  settings: 'Open settings',
  help: 'List slash commands',
  prompt: 'Insert a saved prompt',
};
const SLASH_ICONS: Record<SlashName, EntryIcon> = {
  new: 'new',
  model: 'model',
  provider: 'model',
  crew: 'crew',
  plan: 'crew',
  ask: 'model',
  handoff: 'model',
  changes: 'changes',
  accept: 'changes',
  push: 'changes',
  pr: 'changes',
  settings: 'settings',
  help: 'help',
  prompt: 'prompt',
};
// These end in a branch, a push or a pull request. The composer only opens Changes for them, and
// each step there asks again, but the palette still never selects them on its own.
const EXPLICIT = new Set<SlashName>(['accept', 'push', 'pr']);

const entry = (value: PaletteEntry) => value;

const NO_COMPOSER = 'Open a thread or start a new one first.';
const NO_THREAD = 'Open a saved thread first.';

/**
 * `provided` is read when a command runs, so a view that mounted or left since the list was built
 * is the one that answers. `defer` runs a view action after the palette has closed and focus has
 * gone back to where it was, so the control the action opens keeps the focus it takes.
 */
export function paletteEntries(
  app: PaletteApp,
  provided: () => ReturnType<typeof provision>,
  defer: (action: () => void) => void,
): PaletteEntry[] {
  const composer = provided().slash !== null;
  const slash = (name: SlashName): PaletteEntry => {
    const command = slashCommands.find((value) => value.name === name);
    const own = name === 'new' ? app.newThread : name === 'settings' ? app.openSettings : null;
    return {
      id: `slash-${name}`,
      label: SLASH_LABELS[name],
      hint: `/${name} · ${command?.summary ?? ''}`,
      keywords: `/${name} ${command?.summary ?? ''}`,
      icon: SLASH_ICONS[name],
      run: own ?? (() => defer(() => provided().slash?.(name, ''))),
      disabled: !own && !composer,
      explicit: EXPLICIT.has(name),
    };
  };
  const exporter = provided().exporter;
  const settings = SETTINGS_SECTIONS.map(
    ({ id, label }): PaletteEntry => ({
      id: `settings-${id}`,
      label: `Settings: ${label}`,
      hint: `Open settings at ${label}.`,
      keywords: 'preferences',
      icon: 'settings',
      run: () => app.openSettingsSection(id),
    }),
  );
  const { addProject, reconnect } = app;
  const entries: PaletteEntry[] = [
    slash('new'),
    {
      id: 'next-thread',
      label: 'Next thread',
      hint: 'Open the thread below this one in the sidebar.',
      keywords: 'switch',
      icon: 'thread',
      run: () => app.switchThread(1),
    },
    {
      id: 'previous-thread',
      label: 'Previous thread',
      hint: 'Open the thread above this one in the sidebar.',
      keywords: 'switch',
      icon: 'thread',
      run: () => app.switchThread(-1),
    },
    ...(addProject
      ? [
          entry({
            id: 'add-project',
            label: 'Add a project',
            hint: 'Choose a folder to work in.',
            keywords: 'folder repository',
            icon: 'folder',
            run: addProject,
          }),
        ]
      : []),
    slash('model'),
    slash('provider'),
    slash('handoff'),
    slash('crew'),
    slash('plan'),
    slash('ask'),
    slash('prompt'),
    slash('changes'),
    slash('accept'),
    slash('push'),
    slash('pr'),
    {
      id: 'export-markdown',
      label: 'Export thread as Markdown',
      hint: 'Save the thread as a Markdown file. Tool calls are one line each.',
      keywords: 'save notes md',
      icon: 'export',
      run: () => defer(() => provided().exporter?.markdown()),
      disabled: !exporter,
      explicit: true,
    },
    {
      id: 'share-page',
      label: 'Share thread as a web page',
      hint: 'Preview a read-only page with secrets redacted, then save it as a file.',
      keywords: 'export html',
      icon: 'share',
      run: () => defer(() => provided().exporter?.share()),
      disabled: !exporter,
      explicit: true,
    },
    slash('settings'),
    ...settings,
    slash('help'),
    {
      id: 'toggle-theme',
      label: app.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      hint: 'Change the color theme.',
      keywords: 'appearance',
      icon: 'theme',
      run: app.toggleTheme,
    },
    {
      id: 'toggle-sidebar',
      label: app.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
      hint: 'Show or hide the thread list.',
      keywords: 'navigation rail',
      icon: 'sidebar',
      run: app.toggleSidebar,
    },
    ...(reconnect
      ? [
          entry({
            id: 'reconnect',
            label: 'Reconnect controller',
            hint: 'Try the controller connection again.',
            keywords: 'offline',
            icon: 'connect',
            run: reconnect,
          }),
        ]
      : []),
    {
      id: 'about',
      label: 'About and acknowledgments',
      hint: 'Version, credits and license.',
      keywords: 'credits license',
      icon: 'about',
      run: app.about,
    },
  ];
  return entries.map((entry) =>
    // The reason a command is off is part of what a screen reader announces for it.
    entry.disabled
      ? {
          ...entry,
          hint: `${entry.hint} ${entry.id.startsWith('slash-') ? NO_COMPOSER : NO_THREAD}`,
        }
      : entry,
  );
}
