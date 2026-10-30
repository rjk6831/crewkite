import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChatChangesReadSchema,
  CommentChatChangePayloadSchema,
  DecideChatHunkPayloadSchema,
  MAX_CHANGES_PAGE,
  ReadChatChangesPayloadSchema,
} from './changes.ts';
import { CommandSchema } from './index.ts';

const taskId = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const hunk = 'a'.repeat(64);

test('changes pages, hunk decisions and review comments accept only bounded input', () => {
  const table: [string, { safeParse(value: unknown): { success: boolean } }, unknown, boolean][] = [
    ['a first page needs only the thread', ReadChatChangesPayloadSchema, { taskId }, true],
    [
      'a later page names the last path and the listing',
      ReadChatChangesPayloadSchema,
      { taskId, after: 'src/a.ts', listing: hunk, limit: MAX_CHANGES_PAGE },
      true,
    ],
    [
      'a page larger than the cap is refused',
      ReadChatChangesPayloadSchema,
      { taskId, limit: MAX_CHANGES_PAGE + 1 },
      false,
    ],
    [
      'a page with more entries than the cap is refused',
      ChatChangesReadSchema,
      {
        taskId,
        base: null,
        files: Array.from({ length: MAX_CHANGES_PAGE + 1 }, (_, index) => ({
          path: `f${index}`,
          additions: 0,
          deletions: 0,
        })),
        total: MAX_CHANGES_PAGE + 1,
        next: null,
        listing: null,
      },
      false,
    ],
    [
      'a hunk decision names a 64 character key',
      DecideChatHunkPayloadSchema,
      { taskId, path: 'a.ts', hunk, decision: 'accepted' },
      true,
    ],
    [
      'a discarded decision is a separate command',
      DecideChatHunkPayloadSchema,
      { taskId, path: 'a.ts', hunk, decision: 'discarded' },
      false,
    ],
    [
      'a comment on lines needs an ordered range',
      CommentChatChangePayloadSchema,
      { taskId, path: 'a.ts', hunk, lines: { side: 'new', start: 4, end: 2 }, text: 'Why?' },
      false,
    ],
    [
      'a blank comment is refused',
      CommentChatChangePayloadSchema,
      { taskId, path: 'a.ts', hunk, text: '   ' },
      false,
    ],
    [
      'a comment on a hunk carries its text',
      CommentChatChangePayloadSchema,
      { taskId, path: 'a.ts', hunk, text: 'Keep the guard.' },
      true,
    ],
  ];
  for (const [claim, schema, value, valid] of table)
    assert.equal(schema.safeParse(value).success, valid, claim);
});

test('the three hunk commands are mutations in the command list', () => {
  for (const [command, payload] of [
    ['DecideChatHunk', { taskId, path: 'a.ts', hunk, decision: 'undecided' }],
    ['DiscardChatHunk', { taskId, path: 'a.ts', hunk }],
    ['CommentChatChange', { taskId, path: 'a.ts', hunk, text: 'Rename this.' }],
  ] as const) {
    const envelope = {
      protocol: 1,
      key: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      actor: { id: 'desktop', kind: 'desktop' },
      command,
      payload,
    };
    assert.equal(CommandSchema.safeParse(envelope).success, false, `${command} needs a revision`);
    assert.equal(
      CommandSchema.safeParse({ ...envelope, expectedRevision: 0 }).success,
      true,
      `${command} parses with a revision`,
    );
  }
});
