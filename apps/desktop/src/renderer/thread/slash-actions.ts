import { type SlashName, slashHelp } from '@crewkite/client';

/** What the desktop does for a slash command. `none` means it only shows the note. */
export type SlashAction =
  | 'new-thread'
  | 'pick-model'
  | 'open-crew'
  | 'open-changes'
  | 'open-settings'
  | 'ask'
  | 'prompt'
  | 'none';

/** What this view can do. A hook the parent did not give is false. */
export type SlashContext = {
  thread: boolean;
  newThread: boolean;
  settings: boolean;
  crew: boolean;
  changes: boolean;
};

const needsThread = (what: string) => `${what} Send a first message to start the thread.`;

/**
 * Every command maps to an existing desktop action. Accept, push and pull request only open
 * Changes, where each step keeps its own confirmation. A command the view cannot run says so.
 */
export function slashEffect(
  name: SlashName,
  context: SlashContext,
): { action: SlashAction; note: string | null } {
  const none = (note: string) => ({ action: 'none' as const, note });
  switch (name) {
    case 'new':
      return context.newThread
        ? { action: 'new-thread', note: null }
        : none('This view cannot start a thread. Use New thread in the sidebar.');
    case 'model':
      return { action: 'pick-model', note: null };
    case 'provider':
      return { action: 'pick-model', note: 'Pick a model from the provider you want.' };
    case 'handoff':
      return context.thread
        ? {
            action: 'pick-model',
            note: 'Pick a model from another provider, then use Move thread to hand it over.',
          }
        : none(needsThread('There is nothing to hand off yet.'));
    case 'crew':
      return context.thread && context.crew
        ? { action: 'open-crew', note: null }
        : none(needsThread('A new thread has no crew yet.'));
    case 'plan':
      return context.thread && context.crew
        ? {
            action: 'open-crew',
            note: 'The orchestrator proposes the plan. Add one in Crew and its plan shows in the thread.',
          }
        : none(needsThread('A new thread has no plan yet.'));
    case 'ask':
      return context.thread
        ? { action: 'ask', note: null }
        : none(needsThread('Ask works inside a thread.'));
    case 'changes':
      return context.thread && context.changes
        ? { action: 'open-changes', note: null }
        : none(needsThread('A new thread has no changes yet.'));
    case 'accept':
    case 'push':
    case 'pr':
      return context.thread && context.changes
        ? {
            action: 'open-changes',
            note: 'Accept, push and pull request each wait for your confirmation in Changes.',
          }
        : none(needsThread('A new thread has no changes yet.'));
    case 'settings':
      return context.settings
        ? { action: 'open-settings', note: null }
        : none('This view cannot open settings. Use Settings in the sidebar.');
    case 'help':
      return none(slashHelp());
    case 'prompt':
      return { action: 'prompt', note: null };
  }
}
