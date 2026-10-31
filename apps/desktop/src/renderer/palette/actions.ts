import type { SlashName } from '@crewkite/client';

// What the open view lets the command palette run. The composer provides its slash commands and
// the thread view provides export and share. A palette entry calls the same function the view's
// own control calls, so an entry reaches only what that control reaches and grants nothing more.

export type ThreadExporter = { markdown: () => void; share: () => void };
type Provided = {
  slash: ((name: SlashName, argument: string) => void) | null;
  exporter: ThreadExporter | null;
};
const provided: Provided = { slash: null, exporter: null };

/** Offers an action while a view is mounted. The returned call withdraws it. */
export function provide<K extends keyof Provided>(
  key: K,
  value: NonNullable<Provided[K]>,
): () => void {
  provided[key] = value;
  return () => {
    // A view that mounted later may already have replaced this one.
    if (provided[key] === value) provided[key] = null;
  };
}

/** What the views offer right now. */
export const provision = (): Readonly<Provided> => ({ ...provided });
