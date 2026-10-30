import { z } from 'zod';
import { ChatFileDiffSchema } from './chat.ts';

// The Changes tab in pages, the hunks of each text file and the person's decisions on them, and
// review comments that quote a hunk. The controller computes every hunk from the scratch copy and
// the thread's base and holds the decisions, so nothing here carries file bytes back to it.

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const line = z.number().int().nonnegative();
// A page cursor names whatever path the copy holds. A hunk command names a file a comment may
// quote, so control characters there would let the message carry line breaks nobody typed.
const changePath = z.string().min(1).max(4096);
const hunkPath = changePath.refine(
  (path) => path.isWellFormed() && !/\p{Cc}/u.test(path),
  'A hunk path needs no control characters.',
);

/** The most entries one Changes page holds. */
export const MAX_CHANGES_PAGE = 2000;
/** The most hunks one file lists. A file with more shows its patch with whole-file controls. */
export const MAX_FILE_HUNKS = 1000;
/** The longest review comment a person can type. */
export const MAX_REVIEW_COMMENT = 8192;

/** One `@@` block of a file's patch, in patch order. */
export const ChatHunkSchema = z.strictObject({
  /** Names the hunk by its base start line and its lines, so it survives a discard elsewhere. */
  key: hex64,
  oldStart: line,
  oldLines: line,
  newStart: line,
  newLines: line,
  decision: z.enum(['accepted', 'undecided']),
});
export type ChatHunk = z.infer<typeof ChatHunkSchema>;

export const ChatChangeEntrySchema = ChatFileDiffSchema.extend({
  hunks: z.array(ChatHunkSchema).max(MAX_FILE_HUNKS).default([]),
  /**
   * Accept and Discard per hunk apply. True only for a text file both the base and the copy hold.
   * Binary files, links, added and deleted files stay whole-file.
   */
  hunkControls: z.boolean().default(false),
  /** The person decided on this file's hunks, so Accept takes only its accepted hunks. */
  decided: z.boolean().default(false),
});
export type ChatChangeEntry = z.infer<typeof ChatChangeEntrySchema>;

export const ReadChatChangesPayloadSchema = z.strictObject({
  taskId: id('tsk'),
  /** The `next` value of the previous page. Missing reads from the first path. */
  after: changePath.optional(),
  /** The `listing` of the first page. A different current listing refuses the page. */
  listing: hex64.optional(),
  limit: z.number().int().min(1).max(MAX_CHANGES_PAGE).default(500),
});

export const ChatChangesReadSchema = z.strictObject({
  taskId: id('tsk'),
  base: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  /** Entries sorted by path, after the payload's `after`. */
  files: z.array(ChatChangeEntrySchema).max(MAX_CHANGES_PAGE),
  /** Every entry the list holds across all pages. */
  total: z.number().int().nonnegative(),
  /** Pass as `after` to read the next page. Null on the last page. */
  next: changePath.nullable(),
  /**
   * A digest of every entry and hunk decision. Accept with it publishes only this list. Null when
   * the copy could not be compared.
   */
  listing: hex64.nullable(),
});
export type ChatChangesRead = z.infer<typeof ChatChangesReadSchema>;

const hunkRef = { taskId: id('tsk'), path: hunkPath, hunk: hex64 };

/** Mark one hunk accepted, or take the mark back. Accept then takes only accepted hunks. */
export const DecideChatHunkPayloadSchema = z.strictObject({
  ...hunkRef,
  decision: z.enum(['accepted', 'undecided']),
});
/** Revert one hunk in the scratch copy. The file keeps its other hunks. */
export const DiscardChatHunkPayloadSchema = z.strictObject(hunkRef);
/** A comment on a hunk, or on lines of it, sent to the thread as a message that quotes them. */
export const CommentChatChangePayloadSchema = z.strictObject({
  ...hunkRef,
  /** Lines on one side of the hunk. Missing comments on the whole hunk. */
  lines: z
    .strictObject({
      side: z.enum(['old', 'new']),
      start: z.number().int().min(1),
      end: z.number().int().min(1),
    })
    .refine(({ start, end }) => end >= start, 'A line range needs start before end.')
    .optional(),
  text: z.string().trim().min(1).max(MAX_REVIEW_COMMENT),
});
