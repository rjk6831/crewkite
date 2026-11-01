import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens, FRAMING_TOKENS, meterTone, nextMessage } from './next-message.ts';
import { reportedWindow, type ThreadItem } from './thread-state.ts';

// Three bytes a token, and eight more for each message's role markers.
const turn = (role: 'user' | 'assistant', tokens: number) => ({
  role,
  text: 'x'.repeat(tokens * 3),
});

test('the meter estimates the next message against the selected window', () => {
  const draft = 'Rename n to count.';
  const own = FRAMING_TOKENS + estimateTokens(draft) + 8;
  // Local at 8,192: the outline takes 1,474 and the prompt room is 5,478.
  const short = nextMessage({
    family: 'local',
    capacity: 8192,
    history: [turn('user', 100), turn('assistant', 200)],
    draft,
    fileBytes: 0,
  });
  assert.deepEqual(short && [short.tokens, short.storedTokens, short.folds], [
    own + 1474 + 316,
    316,
    false,
  ]);
  assert.equal(short?.olderTurns, 'Older turns go in as a summary.');
  // A thread past the room: the summary and the newest turns that fit, never the whole thread.
  const long = nextMessage({
    family: 'local',
    capacity: 8192,
    history: [turn('user', 2000), turn('assistant', 2000), turn('user', 1000)],
    draft,
    fileBytes: 0,
  });
  assert.equal(long?.folds, true);
  assert.equal(long?.tokens, own + 1474 + 300 + 1008);
  assert.equal(long?.storedTokens, 5024);
  assert.ok((long?.tokens ?? 0) <= 8192 - 256 - 2458);
  // The draft and the files move the estimate.
  const attached = nextMessage({
    family: 'local',
    capacity: 8192,
    history: [],
    draft,
    fileBytes: 3000,
  });
  assert.equal(attached?.tokens, own + 1474 + 1000);
  // A cloud window of a million reads low, and older turns travel as catch-up notes.
  const cloud = nextMessage({
    family: 'anthropic',
    capacity: 1_000_000,
    history: [turn('user', 2000), turn('assistant', 2000)],
    draft,
    fileBytes: 0,
  });
  assert.equal(cloud?.tokens, own + 4016);
  assert.equal(cloud?.tone, 'neutral');
  assert.equal(cloud?.olderTurns, 'Older turns go in as catch-up notes.');
  // No reported window, no meter.
  assert.equal(
    nextMessage({ family: 'openai', capacity: null, history: [], draft, fileBytes: 0 }),
    null,
  );
});

test('the meter colors by share and never reads a finished turn as the next message', () => {
  assert.deepEqual([0, 0.59, 0.6, 0.85, 0.851, 1].map(meterTone), [
    'neutral',
    'neutral',
    'amber',
    'amber',
    'red',
    'red',
  ]);
  // A failed turn filled 8,192 of 8,192. The meter takes only the window it reported.
  const items = [
    {
      kind: 'turn',
      key: 'a',
      turn: {
        identity: { family: 'local', model: 'flint', effort: 'default', role: 'assistant' },
        context: { used: 8192, capacity: 8192 },
      },
    },
  ] as unknown as ThreadItem[];
  assert.equal(reportedWindow(items, 'local', 'flint'), 8192);
  assert.equal(reportedWindow(items, 'openai', 'flint'), null);
  const next = nextMessage({
    family: 'local',
    capacity: reportedWindow(items, 'local', 'flint'),
    history: [turn('user', 50), turn('assistant', 50)],
    draft: '',
    fileBytes: 0,
  });
  assert.ok(next && next.share < 0.4);
});
