import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent } from '@crewkite/contracts';
import { applyEvent, blankTurn } from './turn-fold.ts';

// Claim: a turn's blocks read in the order they arrived, also when a client sends a later message
// under an item id it used before (H6).
test('a later message under a reused item id lands after the tool calls that came before it', () => {
  const turnId = 'trn_01M51M322B2AEBXD9MA74CBCFM';
  const events: AgentEvent[] = [
    { type: 'text.delta', turnId, itemId: 'm', text: 'I will read the files.' },
    { type: 'text.completed', turnId, itemId: 'm', text: 'I will read the files.' },
    { type: 'tool.started', turnId, callId: 'c1', kind: 'read', title: 'src/money.js', input: {} },
    { type: 'tool.completed', turnId, callId: 'c1', status: 'ok' },
    { type: 'text.delta', turnId, itemId: 'm', text: 'The total ' },
    { type: 'text.delta', turnId, itemId: 'm', text: 'rounds once.' },
    { type: 'text.completed', turnId, itemId: 'm', text: 'The total rounds once.' },
    // A repeat of the finished text changes nothing.
    { type: 'text.completed', turnId, itemId: 'm', text: 'The total rounds once.' },
  ];
  const view = events.reduce(applyEvent, blankTurn(turnId));
  assert.deepEqual(
    view.blocks.map((block) =>
      block.kind === 'text' ? `text:${block.text}` : `${block.kind}:${block.id}`,
    ),
    ['text:I will read the files.', 'tool:tool:c1', 'text:The total rounds once.'],
  );
});
