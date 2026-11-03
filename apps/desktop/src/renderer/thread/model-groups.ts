import type { ChatCatalogRead, ChatEffort, ChatModelSelection } from '@crewkite/contracts';

type Entry = ChatCatalogRead['families'][number];

/** The shape of an ID the Anthropic client passes after --model. The other clients take the same. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,199}$/;

/**
 * How the picker lays out one family. Live models are the ones the client listed for this
 * account, hidden ones among them. Used models finished a turn in this home and the client's list
 * leaves them out, as an older model typed once does. Known models are a list CrewKite shipped,
 * which it no longer does. A typed ID is the selection when the list does not hold it.
 */
export function modelGroups(entry: Entry, selection: ChatModelSelection | null) {
  const picked = selection?.family === entry.family ? selection.model : null;
  const live = entry.models.filter((model) => model.source !== 'known' && model.source !== 'used');
  return {
    live: live.filter((model) => !model.hidden),
    hidden: live.filter((model) => model.hidden),
    known: entry.models.filter((model) => model.source === 'known'),
    used: entry.models.filter((model) => model.source === 'used'),
    typed: picked !== null && !entry.models.some((model) => model.model === picked) ? picked : null,
  };
}

/** The levels a model offers. A model that lists none, such as a Local one, has no effort control. */
export const effortLevels = (efforts: readonly ChatEffort[]): ChatEffort[] =>
  efforts.filter((effort) => effort !== 'default');

/**
 * The effort a selection shows. A thread saved with Default on a model that lists levels runs at
 * the model's preselected level, so it shows that level.
 */
export const shownEffort = (
  effort: ChatEffort,
  model: { efforts: readonly ChatEffort[]; defaultEffort: ChatEffort } | undefined,
): ChatEffort =>
  effort === 'default' && model && effortLevels(model.efforts).length
    ? model.defaultEffort
    : effort;

/**
 * What the picker says about a family that is not connected, in its head and its tooltip. Every
 * cloud family reads the same whatever stopped it, and the controller's reason codes never reach
 * the person. Local keeps what its setup last saw.
 */
export function offLine(entry: Pick<Entry, 'family' | 'needsConnect'>, localSeen: string | null) {
  if (entry.family !== 'local') return 'Not connected';
  if (localSeen) return localSeen;
  return entry.needsConnect ? 'Connect in Settings' : 'Not connected';
}
