/** Send is on for text, for files alone, or both, and off while a file is still being copied. */
export function canSend(input: {
  text: string;
  files: number;
  blocked: string | null;
  adding: boolean;
}): boolean {
  return !input.blocked && !input.adding && (input.text.trim() !== '' || input.files > 0);
}

export type Shortcut =
  | 'stop-turn'
  | 'new-thread'
  | 'open-settings'
  | 'edit-last'
  | 'previous-thread'
  | 'next-thread';

export type KeyInput = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
};

export type ShortcutContext = {
  /** Command is the primary key on a Mac, Control elsewhere. */
  mac: boolean;
  composerFocused: boolean;
  composerEmpty: boolean;
  running: boolean;
  /** Text is selected in the box or in the thread. */
  selecting: boolean;
  /** A dialog is open, so the window shortcuts wait. */
  dialogOpen: boolean;
};

/**
 * The action a key press asks for, or null. Escape and Up belong to the composer, so they need its
 * focus; the other four work from anywhere in the window unless a dialog is open. Control+N and
 * Control+P move the caret in a Mac text box, so on a Mac only Command counts.
 */
export function shortcutFor(event: KeyInput, context: ShortcutContext): Shortcut | null {
  if (event.isComposing) return null;
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (plain && event.key === 'Escape')
    return context.composerFocused && context.running && !context.selecting ? 'stop-turn' : null;
  if (plain && event.key === 'ArrowUp')
    return context.composerFocused && context.composerEmpty ? 'edit-last' : null;
  const primary = context.mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.shiftKey || context.dialogOpen) return null;
  const key = event.key.toLowerCase();
  if (event.altKey)
    return key === 'arrowup' ? 'previous-thread' : key === 'arrowdown' ? 'next-thread' : null;
  if (key === 'n') return 'new-thread';
  return key === ',' ? 'open-settings' : null;
}

/** The thread one step from `current` in rail order, held at either end. Null with no threads. */
export function adjacentThread(
  order: readonly string[],
  current: string | null,
  step: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  return order[Math.min(order.length - 1, Math.max(0, index + step))] ?? null;
}

/** Whether Command is the primary key. A browser preview without a platform reads as not a Mac. */
export const isMacPlatform = () =>
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

/** The search shortcut as the person's keyboard labels it: Command K on a Mac, Ctrl K elsewhere. */
export const searchHint = (mac: boolean) => (mac ? '⌘ K' : 'Ctrl K');
