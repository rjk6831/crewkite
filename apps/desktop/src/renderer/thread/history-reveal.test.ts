import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMarks, queryTerms, revealKey, snippetParts } from './history-reveal.ts';
import type { ThreadItem } from './thread-state.ts';

const user = (key: string): ThreadItem => ({
  kind: 'user',
  key,
  at: '2026-10-31T00:00:00.000Z',
  text: 'hello',
  attachments: [],
  files: [],
  pending: false,
});
const turn = (id: string): ThreadItem =>
  ({ kind: 'turn', key: `turn:${id}`, turn: { id } }) as unknown as ThreadItem;

test('a hit lands on the row that holds the match, and falls back to the message that began the turn', () => {
  const items = [user('msg_a'), turn('trn_a'), user('msg_b')];
  const rows: [string, Parameters<typeof revealKey>[0], string | null][] = [
    [
      'a user message hit lands on the bubble',
      { kind: 'message', turnId: 'trn_a', messageId: 'msg_a' },
      'msg_a',
    ],
    [
      'an assistant message hit lands on its turn row',
      { kind: 'message', turnId: 'trn_a', messageId: 'msg_reply' },
      'turn:trn_a',
    ],
    [
      'a tool hit lands on its turn row, not on the message that began it',
      { kind: 'tool', turnId: 'trn_a', messageId: 'msg_a' },
      'turn:trn_a',
    ],
    [
      'a path hit on a turn with no row falls back to the message that began it',
      { kind: 'path', turnId: 'trn_gone', messageId: 'msg_b' },
      'msg_b',
    ],
    [
      'a hit whose rows are not loaded finds nothing',
      { kind: 'message', turnId: 'trn_gone', messageId: 'msg_gone' },
      null,
    ],
    ['a title has no row', { kind: 'title', turnId: null, messageId: null }, null],
  ];
  for (const [claim, hit, key] of rows) assert.equal(revealKey(hit, items), key, claim);
});

test('a snippet splits at the controller marks, and a stray mark cannot break it', () => {
  const rows: [string, string, { start: number; end: number }[], [string, boolean][]][] = [
    ['no marks', 'plain text', [], [['plain text', false]]],
    [
      'one mark in the middle',
      'fix the rounding bug',
      [{ start: 8, end: 16 }],
      [
        ['fix the ', false],
        ['rounding', true],
        [' bug', false],
      ],
    ],
    [
      'marks at both ends',
      'abc def',
      [
        { start: 0, end: 3 },
        { start: 4, end: 7 },
      ],
      [
        ['abc', true],
        [' ', false],
        ['def', true],
      ],
    ],
    [
      'a mark past the end is cut',
      'abc',
      [{ start: 1, end: 99 }],
      [
        ['a', false],
        ['bc', true],
      ],
    ],
    ['a mark wholly past the end is dropped', 'abc', [{ start: 50, end: 60 }], [['abc', false]]],
    [
      'overlapping marks do not repeat text',
      'abcdef',
      [
        { start: 0, end: 4 },
        { start: 2, end: 6 },
      ],
      [
        ['abcd', true],
        ['ef', true],
      ],
    ],
    [
      'markup stays text',
      '<b>hi</b>',
      [{ start: 3, end: 5 }],
      [
        ['<b>', false],
        ['hi', true],
        ['</b>', false],
      ],
    ],
  ];
  for (const [claim, snippet, marks, parts] of rows)
    assert.deepEqual(
      snippetParts({ snippet, marks }).map(({ text, marked }) => [text, marked]),
      parts,
      claim,
    );
});

test('the view marks the words the index matches, folded the same way', () => {
  assert.deepEqual(queryTerms('go  fix rounding rounding'), ['fix', 'rounding']);
  const rows: [string, string, string[], [number, number][]][] = [
    ['case', 'The Rounding bug', ['rounding'], [[4, 12]]],
    ['accents', 'Un Café ouvert', ['cafe'], [[3, 7]]],
    ['accent in the query', 'cafe au lait', ['café'], [[0, 4]]],
    [
      'two words',
      'fix the bug, then fix it',
      ['fix', 'bug'],
      [
        [0, 3],
        [8, 11],
        [18, 21],
      ],
    ],
    ['overlap joins', 'abcdef', ['abcd', 'cdef'], [[0, 6]]],
    ['Thai', 'วันนี้อากาศดี', ['อากาศ'], [[6, 11]]],
    ['a pair of code units stays whole', 'x 😀 needle', ['needle'], [[5, 11]]],
    ['no match', 'nothing here', ['absent'], []],
  ];
  for (const [claim, text, terms, marks] of rows)
    assert.deepEqual(
      findMarks(text, terms).map(({ start, end }) => [start, end]),
      marks,
      claim,
    );
});
