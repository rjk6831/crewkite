import type { PlanRecipeDraft } from '@crewkite/contracts';

// How a finished plan thread hands a drafted recipe to the Recipes page. The Work tab and the page
// sit far apart in the tree, and the draft crosses once, so one listener is all it takes.

/** A draft made from a finished plan thread. */
export type ThreadDraft = { projectId: string; draft: PlanRecipeDraft; threadTitle: string };

let listener: ((draft: ThreadDraft) => void) | null = null;

/** Opens the Recipes page on this draft. Nothing is saved until the person saves it there. */
export function openRecipeDraft(draft: ThreadDraft): void {
  listener?.(draft);
}

/** The app shell listens while it is mounted. Returns the function that stops listening. */
export function onRecipeDraft(next: (draft: ThreadDraft) => void): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}
