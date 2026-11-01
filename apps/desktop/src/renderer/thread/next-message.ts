import {
  BYTES_PER_TOKEN_ESTIMATE,
  type ChatFamily,
  LOCAL_OUTLINE_SHARE,
  LOCAL_REPLY_MARGIN,
  LOCAL_SUMMARY_TOKENS,
  localReplyFloor,
} from '@crewkite/contracts';

// The composer meter describes the next message for the selected model: what CrewKite would send
// now against that model's window. It counts bytes, three to a token, so it never undercounts and
// never calls a model. A finished or failed turn has no part in it; that turn's peak stays in its
// own stats line.

/** The framing every turn carries: the scratch rules, the tool rules and the project notes. */
export const FRAMING_TOKENS = 1024;
// Each message carries its role markers.
const MESSAGE_TOKENS = 8;

export type NextMessageInput = {
  family: ChatFamily;
  /** The selected model's window, or null when nothing reported it. */
  capacity: number | null;
  /** The thread's stored user and assistant messages, oldest first. */
  history: readonly { role: 'user' | 'assistant'; text: string }[];
  draft: string;
  /** Bytes of the files attached to the draft. */
  fileBytes: number;
};

export type MeterTone = 'neutral' | 'amber' | 'red';

export type NextMessage = {
  /** About how many tokens the next message sends. */
  tokens: number;
  capacity: number;
  /** Every stored turn of the thread, counted the same way. */
  storedTokens: number;
  /** True when the whole thread passes the room, so older turns are summarized first. */
  folds: boolean;
  share: number;
  tone: MeterTone;
  /** How this model sees older turns. */
  olderTurns: string;
};

export const estimateTokens = (text: string) =>
  Math.ceil(new TextEncoder().encode(text).length / BYTES_PER_TOKEN_ESTIMATE);

/** Neutral under 60 percent of the window, amber to 85 percent, red above. */
export const meterTone = (share: number): MeterTone =>
  share > 0.85 ? 'red' : share >= 0.6 ? 'amber' : 'neutral';

export function nextMessage(input: NextMessageInput): NextMessage | null {
  const { capacity, family } = input;
  if (capacity === null || !Number.isFinite(capacity) || capacity <= 0) return null;
  const turns = input.history.map((entry) => estimateTokens(entry.text) + MESSAGE_TOKENS);
  const storedTokens = turns.reduce((sum, value) => sum + value, 0);
  const own =
    FRAMING_TOKENS +
    estimateTokens(input.draft) +
    MESSAGE_TOKENS +
    Math.ceil(Math.max(0, input.fileBytes) / BYTES_PER_TOKEN_ESTIMATE);
  const local = family === 'local';
  // Local builds every prompt itself: the outline goes in, and the reply keeps its floor. A cloud
  // client keeps its own session, so the room is the window.
  const fixed = local ? own + Math.floor(capacity * LOCAL_OUTLINE_SHARE) : own;
  const room = local
    ? Math.max(0, capacity - LOCAL_REPLY_MARGIN - localReplyFloor(capacity))
    : capacity;
  const whole = fixed + storedTokens;
  const folds = whole > room;
  let tokens = whole;
  if (folds && local) {
    // Older turns fold into the summary, and the newest turns that still fit go in whole.
    tokens = fixed + (turns.length ? LOCAL_SUMMARY_TOKENS : 0);
    for (const value of turns.toReversed()) {
      if (tokens + value > room) break;
      tokens += value;
    }
  }
  const share = Math.min(1, tokens / capacity);
  return {
    tokens,
    capacity,
    storedTokens,
    folds,
    share,
    tone: meterTone(share),
    olderTurns: local ? 'Older turns go in as a summary.' : 'Older turns go in as catch-up notes.',
  };
}
