import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChatSearchResultSchema,
  CommandSchema,
  MAX_CHAT_SEARCH_BYTES,
  ReadDataSchema,
  SearchChatHistoryPayloadSchema,
} from './index.ts';

const taskId = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const turnId = 'trn_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const msgId = 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const hit = {
  kind: 'message',
  turnId,
  messageId: msgId,
  messageCursor: '12',
  snippet: 'fix the rounding',
  marks: [{ start: 8, end: 16 }],
};
const group = { taskId, title: 'Rounding', hits: [hit] };

test('the search payload and its page keep the bounds the controller relies on', () => {
  const rows: [string, { safeParse(value: unknown): { success: boolean } }, unknown, boolean][] = [
    [
      'a plain query takes the default page size',
      SearchChatHistoryPayloadSchema,
      { query: 'a b' },
      true,
    ],
    ['a blank query is refused', SearchChatHistoryPayloadSchema, { query: '   ' }, false],
    [
      'a query over its length is refused',
      SearchChatHistoryPayloadSchema,
      { query: 'x'.repeat(201) },
      false,
    ],
    [
      'more than fifty threads is refused',
      SearchChatHistoryPayloadSchema,
      { query: 'abc', limit: 51 },
      false,
    ],
    [
      'more than five hits per thread is refused',
      SearchChatHistoryPayloadSchema,
      { query: 'abc', perThread: 6 },
      false,
    ],
    [
      'an unknown field is refused',
      SearchChatHistoryPayloadSchema,
      { query: 'abc', sql: 'x' },
      false,
    ],
    [
      'a page of one group is accepted',
      ChatSearchResultSchema,
      { query: 'abc', groups: [group], tooShort: false, more: false },
      true,
    ],
    [
      'a mark that ends before it starts is refused',
      ChatSearchResultSchema,
      {
        query: 'abc',
        groups: [{ ...group, hits: [{ ...hit, marks: [{ start: 5, end: 5 }] }] }],
        tooShort: false,
        more: false,
      },
      false,
    ],
    [
      'a group with no hit is refused',
      ChatSearchResultSchema,
      { query: 'abc', groups: [{ ...group, hits: [] }], tooShort: false, more: false },
      false,
    ],
    [
      'a title hit names no turn or message',
      ChatSearchResultSchema,
      {
        query: 'abc',
        groups: [
          {
            ...group,
            hits: [{ ...hit, kind: 'title', turnId: null, messageId: null, messageCursor: null }],
          },
        ],
        tooShort: false,
        more: false,
      },
      true,
    ],
  ];
  for (const [claim, schema, input, accepted] of rows)
    assert.equal(schema.safeParse(input).success, accepted, claim);
  assert.equal(SearchChatHistoryPayloadSchema.parse({ query: ' a b ' }).query, 'a b');
  assert.equal(SearchChatHistoryPayloadSchema.parse({ query: 'abc' }).limit, 20);
});

test('a search page over its byte limit is refused, whatever the group count', () => {
  const wide = Array.from({ length: 50 }, () => ({
    ...group,
    hits: Array.from({ length: 5 }, () => ({ ...hit, snippet: 'x'.repeat(240) })),
  }));
  const page = { query: 'abc', groups: wide, tooShort: false, more: true };
  assert.ok(JSON.stringify(page).length > MAX_CHAT_SEARCH_BYTES);
  assert.equal(ChatSearchResultSchema.safeParse(page).success, false);
});

test('the search command is a read and its data carries the chat-search kind', () => {
  const command = {
    protocol: 1,
    key: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    actor: { id: 'terminal', kind: 'cli' },
    command: 'SearchChatHistory',
    payload: { query: 'rounding' },
  };
  assert.equal(CommandSchema.safeParse(command).success, true);
  assert.equal(
    CommandSchema.safeParse({ ...command, expectedRevision: 0 }).success,
    false,
    'a read carries no revision',
  );
  assert.equal(
    ReadDataSchema.safeParse({
      kind: 'chat-search',
      query: 'abc',
      groups: [],
      tooShort: false,
      more: false,
    }).success,
    true,
  );
});
