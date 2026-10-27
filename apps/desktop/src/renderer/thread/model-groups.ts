import type { ChatCatalogRead, ChatModelSelection } from '@crewkite/contracts';

type Entry = ChatCatalogRead['families'][number];

/** The shape of an ID the Anthropic client passes after --model. The other clients take the same. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,199}$/;

/**
 * How the picker lays out one family. Live models are the ones the client listed for this
 * account, hidden ones among them. Known models are CrewKite's own list, shown when the client
 * could not confirm any. A typed ID is the selection when the list does not hold it.
 */
export function modelGroups(entry: Entry, selection: ChatModelSelection | null) {
  const picked = selection?.family === entry.family ? selection.model : null;
  const live = entry.models.filter((model) => model.source !== 'known');
  return {
    live: live.filter((model) => !model.hidden),
    hidden: live.filter((model) => model.hidden),
    known: entry.models.filter((model) => model.source === 'known'),
    typed: picked !== null && !entry.models.some((model) => model.model === picked) ? picked : null,
  };
}
