import type { CliKeyAction, CliSettings } from '@crewkite/contracts';
import type { Key } from 'ink';

/** The keys each action answers to when cli.json names none. */
export const defaultKeys: Record<CliKeyAction, readonly string[]> = {
  send: ['enter'],
  newline: ['alt+enter', 'shift+enter'],
  stop: ['escape'],
  threads: ['ctrl+t'],
  changes: ['ctrl+g'],
  settings: ['ctrl+o'],
  help: ['ctrl+k'],
};

export const keysFor = (settings: CliSettings, action: CliKeyAction): readonly string[] =>
  settings.keybindings[action] ?? defaultKeys[action];

const named: Record<string, (key: Key) => boolean> = {
  enter: (key) => key.return,
  escape: (key) => key.escape,
  tab: (key) => key.tab,
  up: (key) => key.upArrow,
  down: (key) => key.downArrow,
  left: (key) => key.leftArrow,
  right: (key) => key.rightArrow,
  pageup: (key) => key.pageUp,
  pagedown: (key) => key.pageDown,
  home: (key) => key.home,
  end: (key) => key.end,
};

/** Whether one key press is `binding`, such as `ctrl+t` or `alt+enter`. Modifiers must match. */
export function pressed(binding: string, input: string, key: Key): boolean {
  const parts = binding.split('+');
  const name = parts.at(-1) ?? '';
  const want = new Set(parts.slice(0, -1));
  if (want.has('ctrl') !== key.ctrl || want.has('alt') !== key.meta) return false;
  const test = named[name];
  if (test) return test(key) && want.has('shift') === key.shift;
  return input.toLowerCase() === name;
}

export const matches = (settings: CliSettings, action: CliKeyAction, input: string, key: Key) =>
  keysFor(settings, action).some((binding) => pressed(binding, input, key));

/** How a binding reads in the help view. */
export const keyLabel = (binding: string) =>
  binding
    .split('+')
    .map((part) =>
      part === 'ctrl'
        ? 'Ctrl'
        : part === 'alt'
          ? 'Alt'
          : part === 'shift'
            ? 'Shift'
            : part.length === 1
              ? part.toUpperCase()
              : part[0].toUpperCase() + part.slice(1),
    )
    .join('+');
