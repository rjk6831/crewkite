import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localPromptRoom, localThreadReadBytes } from './budget.ts';

const CAP = 64 * 1024;

test('a thread read gets the prompt room the prompt leaves, three bytes a token, within the cap', () => {
  // Room: an 8,192 context leaves 8192 - 256 - 2458 = 5478 tokens. A 4,096 context leaves 1792.
  // A 32,768 context leaves 22681, which is 68043 bytes and so meets the cap.
  const cases: [label: string, context: number, promptTokens: number, expected: number][] = [
    ['a small prompt leaves most of the room', 8192, 500, (5478 - 500) * 3],
    ['large attachments leave less', 8192, 3000, (5478 - 3000) * 3],
    ['an empty prompt gets the whole room', 4096, 0, 1792 * 3],
    ['a prompt that fills the room leaves nothing', 8192, 5478, 0],
    ['a prompt past the room leaves nothing', 8192, 6000, 0],
    ['a context too small for any prompt leaves nothing', 1000, 0, 0],
    ['a large room stops at the cap', 32768, 0, CAP],
    ['a negative count is no prompt', 4096, -10, 1792 * 3],
  ];
  for (const [label, context, promptTokens, expected] of cases)
    assert.equal(localThreadReadBytes(context, promptTokens, CAP), expected, label);
});

test('a thread read never passes the prompt room, and a fuller prompt never gives a larger read', () => {
  for (const context of [2048, 4096, 8192, 16384, 32768, 131072]) {
    const room = localPromptRoom(context);
    let previous = Number.POSITIVE_INFINITY;
    const fills = [0, 100, 1000, Math.floor(room / 2), room - 1, room, room + 500];
    for (const promptTokens of fills.sort((a, b) => a - b)) {
      const bytes = localThreadReadBytes(context, promptTokens, CAP);
      const label = `${context} context, ${promptTokens} prompt tokens`;
      assert(bytes <= previous, label);
      assert(bytes <= CAP, label);
      // Three bytes a token never undercounts, so the read adds at most this many tokens.
      assert(promptTokens + Math.ceil(bytes / 3) <= Math.max(room, promptTokens), label);
      previous = bytes;
    }
  }
});
