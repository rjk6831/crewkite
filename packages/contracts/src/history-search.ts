import { z } from 'zod';
import { ChatTurnIdSchema } from './chat.ts';

// Search over every thread's history: titles, messages, the titles and summaries of tool cards
// and the file paths they named. The controller answers from its own index and returns a bounded
// page grouped by thread. A hit names the turn and message to open, and a snippet with the
// matched text marked by offsets, so the view never renders markup from a message.

const taskId = z.string().regex(/^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const messageId = z.string().regex(/^msg_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const cursor = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);

/** The index matches runs of this many characters or more, so a shorter word finds nothing. */
export const CHAT_SEARCH_MIN_CHARACTERS = 3;
export const MAX_CHAT_SEARCH_QUERY = 200;
export const MAX_CHAT_SEARCH_THREADS = 50;
export const MAX_CHAT_SEARCH_HITS_PER_THREAD = 5;
export const MAX_CHAT_SEARCH_SNIPPET = 240;
/** One page of results, as encoded JSON. The controller stops adding hits before it. */
export const MAX_CHAT_SEARCH_BYTES = 65_536;

export const ChatSearchKindSchema = z.enum(['title', 'message', 'tool', 'path']);
export type ChatSearchKind = z.infer<typeof ChatSearchKindSchema>;

export const SearchChatHistoryPayloadSchema = z.strictObject({
  /** Words, all of which have to appear in one place. Each needs three characters or more. */
  query: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CHAT_SEARCH_QUERY)
    .refine((value) => !value.includes('\0'), 'A query holds no NUL character.'),
  /** Threads in the page. */
  limit: z.number().int().min(1).max(MAX_CHAT_SEARCH_THREADS).default(20),
  /** Hits listed under each thread. */
  perThread: z.number().int().min(1).max(MAX_CHAT_SEARCH_HITS_PER_THREAD).default(3),
});

/** A matched stretch of a snippet, in UTF-16 code units. */
export const ChatSearchMarkSchema = z
  .strictObject({
    start: z.number().int().nonnegative().max(MAX_CHAT_SEARCH_SNIPPET),
    end: z.number().int().positive().max(MAX_CHAT_SEARCH_SNIPPET),
  })
  .refine(({ start, end }) => end > start, 'A mark covers at least one character.');

export const ChatSearchHitSchema = z.strictObject({
  kind: ChatSearchKindSchema,
  /** The turn the match belongs to. Null for a title and for a message no turn names. */
  turnId: ChatTurnIdSchema.nullable(),
  /** The message the match is in, or the one that started the turn. Null for a title. */
  messageId: messageId.nullable(),
  /** The conversation cursor of that message, so the view can page back to it. */
  messageCursor: cursor.nullable(),
  snippet: z.string().max(MAX_CHAT_SEARCH_SNIPPET),
  marks: z.array(ChatSearchMarkSchema).max(32),
});
export type ChatSearchHit = z.infer<typeof ChatSearchHitSchema>;

export const ChatSearchGroupSchema = z.strictObject({
  taskId,
  title: z.string().max(200),
  hits: z.array(ChatSearchHitSchema).min(1).max(MAX_CHAT_SEARCH_HITS_PER_THREAD),
});
export type ChatSearchGroup = z.infer<typeof ChatSearchGroupSchema>;

/** Threads in order of their best match. `more` is true when matches were left out. */
export const ChatSearchResultSchema = z
  .strictObject({
    query: z.string().max(MAX_CHAT_SEARCH_QUERY),
    groups: z.array(ChatSearchGroupSchema).max(MAX_CHAT_SEARCH_THREADS),
    /** Set when the query held no word the index can match. */
    tooShort: z.boolean(),
    more: z.boolean(),
  })
  .superRefine((page, context) => {
    if (new TextEncoder().encode(JSON.stringify(page)).byteLength > MAX_CHAT_SEARCH_BYTES)
      context.addIssue({ code: 'custom', message: 'A search page exceeds its byte limit.' });
  });
export type ChatSearchResult = z.infer<typeof ChatSearchResultSchema>;
