import type { ChatCatalogRead, ChatFamily, ChatModelSelection } from '@crewkite/contracts';
import { activeTurnId, type ThreadState } from './thread-state.ts';

// What the thread offers after a provider stops on a usage limit. Both functions are pure so the
// rule can be tested without React.

export type LimitOffer = {
  turnId: string;
  /** The family that stopped. It is never offered as the place to continue. */
  family: ChatFamily;
  /** The message that hit the limit, sent again on the family the person picks. */
  text: string;
  attachments: string[];
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
  const message =
    state.messages.find((value) => value.id === meta?.userMessageId) ??
    state.messages.findLast((value) => value.author.kind === 'user');
  if (!limited || !family || !message) return null;
  return { turnId: id, family, text: message.text, attachments: [...message.attachments] };
}

export type OfferChoice = {
  family: ChatFamily;
  selection: ChatModelSelection;
  /** Remaining allowance of the tightest window, or null when none was observed. */
  percent: number | null;
};

/** One choice per connected family other than the one that stopped, on its default model. */
export function offerChoices(catalog: ChatCatalogRead, stopped: ChatFamily): OfferChoice[] {
  return catalog.families.flatMap((entry) => {
    const model = entry.defaultModel ?? entry.models[0]?.model;
    if (!entry.connected || entry.family === stopped || !model) return [];
    const effort = entry.models.find((value) => value.model === model)?.defaultEffort;
    const known = entry.remaining.flatMap((window) =>
      window.percent === null ? [] : [window.percent],
    );
    return [
      {
        family: entry.family,
        selection: { family: entry.family, model, effort: effort ?? 'default' },
        percent: known.length > 0 ? Math.floor(Math.min(...known)) : null,
      },
    ];
  });
}
