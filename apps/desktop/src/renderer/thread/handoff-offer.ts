import {
  type ChatCatalogRead,
  type ChatFamily,
  type ChatHandoffMode,
  type ChatModelSelection,
  rankFamilies,
  tightestAllowance,
} from '@crewkite/contracts';
import { familyModel } from '../settings/preferences.ts';
import { activeTurnId, type ThreadState } from './thread-state.ts';

// What the thread offers after a provider stops on a usage limit. Both are plain functions so the
// rule can be tested without React.

export type LimitOffer = {
  turnId: string;
  /** The family that stopped. It is never offered as the place to continue. */
  family: ChatFamily;
  /** The thread's handoff mode. The offer ranks the other families the way it says. */
  mode: ChatHandoffMode;
};

// A turn known from a read has a sequence. One seen only on the stream is newer than all of them.
function latestTurnId(state: ThreadState): string | null {
  const streamed = Object.keys(state.turns).filter((id) => !state.turnMeta[id]);
  if (streamed.length > 0) return streamed[streamed.length - 1];
  const turns = Object.values(state.turnMeta);
  return turns.reduce((a, b) => (b.sequence > a.sequence ? b : a), turns[0])?.id ?? null;
}

/**
 * The offer exists while the newest turn is the one that hit a limit. A message being sent or a
 * turn that has started ends it, and so does any turn that is not the newest.
 */
export function limitOffer(state: ThreadState): LimitOffer | null {
  const id = latestTurnId(state);
  if (!id || state.pending.length > 0 || activeTurnId(state) !== null) return null;
  const record = state.turns[id];
  const meta = state.turnMeta[id];
  const completed = record?.events.findLast(({ event }) => event.type === 'turn.completed')?.event;
  const failure = record?.view.failure ?? meta?.failure ?? null;
  // The stored stop reason is exact. Turns written before it existed fall back to what the
  // stream or the failure says.
  const limited = meta?.stopReason
    ? meta.stopReason === 'limit'
    : (completed?.type === 'turn.completed' && completed.stopReason === 'limit') ||
      failure?.kind === 'usage-limit';
  const family = record?.view.identity?.family ?? meta?.selection.family;
  const mode = state.thread?.handoffMode ?? 'most-left';
  return limited && family ? { turnId: id, family, mode } : null;
}

export type OfferChoice = {
  family: ChatFamily;
  selection: ChatModelSelection;
  /** Remaining allowance of the tightest window, or null when none was observed. */
  percent: number | null;
};

/**
 * One choice per connected family other than the one that stopped, on its default model, in the
 * order the contract ranks them for the thread's mode. A family with nothing left is not offered.
 */
export function offerChoices(
  catalog: ChatCatalogRead,
  stopped: ChatFamily,
  mode: ChatHandoffMode = 'most-left',
): OfferChoice[] {
  const ranked = rankFamilies(catalog.families, [stopped], (entry) => familyModel(entry), mode);
  return ranked.flatMap((entry) => {
    const model = familyModel(entry) ?? entry.models[0]?.model;
    if (!model) return [];
    const effort = entry.models.find((value) => value.model === model)?.defaultEffort;
    const { percent } = tightestAllowance(entry, model);
    return [
      {
        family: entry.family,
        selection: { family: entry.family, model, effort: effort ?? 'default' },
        percent: percent === null ? null : Math.floor(percent),
      },
    ];
  });
}
