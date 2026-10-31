import type { DatabaseSync } from 'node:sqlite';
import {
  CHAT_SEARCH_MIN_CHARACTERS,
  type ChatSearchGroup,
  type ChatSearchHit,
  type ChatSearchKind,
  type ChatSearchResult,
  ChatSearchResultSchema,
  MAX_CHAT_SEARCH_BYTES,
  MAX_CHAT_SEARCH_SNIPPET,
  type SearchChatHistoryPayloadSchema,
} from '@crewkite/contracts';
import type { z } from 'zod';

// Search over the index that migration 018 builds and its triggers keep. Reads only: nothing here
// writes a row, so a search never changes a thread. The index covers titles, message text, the
// titles and summaries of tool cards and the paths they named. See that migration for how a row
// gets in.

export type SearchRequest = z.output<typeof SearchChatHistoryPayloadSchema>;

/** Matches kept after each thread is capped. A query that matches more than this is cut at the best ones. */
const CANDIDATES = 400;
/** Trigram tokens around a match in a snippet. */
const SNIPPET_TOKENS = 48;
/** Room kept for the page's own fields when hits are added up. */
const PAGE_MARGIN = 1024;
/**
 * A title says what the thread is about and a path names a file the person looks for, so both
 * outrank the same words inside a long message. The rank is negative, so a larger factor wins.
 */
const KIND_WEIGHT: Record<ChatSearchKind, number> = { title: 3, path: 2, tool: 1.5, message: 1 };
const OPEN = '\u0001';
const CLOSE = '\u0002';

type Candidate = {
  id: number;
  taskId: string;
  kind: ChatSearchKind;
  turnId: string | null;
  messageId: string | null;
};

/** The words the index can match: three characters or more, each once, in the order given. */
export function searchTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const word of query.split(/\s+/)) {
    const term = word.normalize('NFC');
    if ([...term].length >= CHAT_SEARCH_MIN_CHARACTERS) seen.add(term);
  }
  return [...seen];
}

/** Each word as an FTS5 string, so no character of it is read as query syntax. */
const matchExpression = (terms: readonly string[]) =>
  terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');

/**
 * The snippet without its markers, and the marked stretches as offsets into what remains. A text
 * that holds a marker character of its own cannot be told apart from the markers snippet() adds,
 * so `ambiguous` drops every marker and the result carries no marks. A marker that does not open or
 * close a stretch is dropped.
 */
export function readSnippet(
  raw: string,
  ambiguous = false,
): { snippet: string; marks: ChatSearchHit['marks'] } {
  let snippet = '';
  const marks: ChatSearchHit['marks'] = [];
  let open: number | null = null;
  for (const part of raw.split(new RegExp(`([${OPEN}${CLOSE}])`, 'u'))) {
    if (part === OPEN) {
      if (open === null) open = snippet.length;
    } else if (part === CLOSE) {
      if (open !== null && snippet.length > open) marks.push({ start: open, end: snippet.length });
      open = null;
    } else {
      // Line breaks and control characters in a message never reach a one-line result.
      snippet += part.replace(/[\p{Cc}\s]+/gu, ' ');
    }
  }
  if (ambiguous) marks.length = 0;
  if (snippet.length <= MAX_CHAT_SEARCH_SNIPPET) return { snippet, marks: marks.slice(0, 32) };
  const clipped = snippet.slice(0, MAX_CHAT_SEARCH_SNIPPET).toWellFormed();
  return {
    snippet: clipped,
    marks: marks
      .filter((mark) => mark.start < clipped.length)
      .map((mark) => ({ start: mark.start, end: Math.min(mark.end, clipped.length) }))
      .slice(0, 32),
  };
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Threads that match, best first, each with its best hits. A page holds at most `limit` threads
 * and `perThread` hits under each, and stops adding hits before it passes the byte limit; `more`
 * says anything was left out.
 */
export function searchHistory(db: DatabaseSync, request: SearchRequest): ChatSearchResult {
  const terms = searchTerms(request.query);
  const empty = { query: request.query, groups: [], tooShort: false, more: false };
  if (terms.length === 0) return ChatSearchResultSchema.parse({ ...empty, tooShort: true });
  const match = matchExpression(terms);
  // Rank in SQL, and cap each thread there, so one busy thread cannot use up the candidates other
  // threads need. A file named by a call and by its diff is one place to open, so the first window
  // keeps one hit of a kind per turn, and the second keeps the best few hits of each thread. The
  // candidates are then cut across threads. A thread brings at most `perThread` of them, so the cut
  // always leaves more threads than a page can show.
  const ranked = db
    .prepare(
      `WITH hits AS (
        SELECT d.id AS id, d.task_id AS task_id, d.kind AS kind, d.turn_id AS turn_id,
          d.message_id AS message_id,
          bm25(chat_search) * CASE d.kind WHEN 'title' THEN ${KIND_WEIGHT.title} WHEN 'path' THEN ${KIND_WEIGHT.path} WHEN 'tool' THEN ${KIND_WEIGHT.tool} ELSE ${KIND_WEIGHT.message} END AS score
        FROM chat_search JOIN chat_search_docs d ON d.id = chat_search.rowid
        WHERE chat_search MATCH ?
      ), per_turn AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY task_id, kind, COALESCE(turn_id, 'row:' || id) ORDER BY score, id DESC
        ) AS same_turn FROM hits
      ), per_thread AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY score, id DESC) AS place
        FROM per_turn WHERE same_turn = 1
      )
      SELECT id, task_id, kind, turn_id, message_id FROM per_thread
      WHERE place <= ? ORDER BY score, id DESC LIMIT ?`,
    )
    .all(match, request.perThread + 1, CANDIDATES + 1);
  let more = ranked.length > CANDIDATES;
  // Group in rank order: a thread sits where its best match sits.
  const order: string[] = [];
  const byThread = new Map<string, Candidate[]>();
  for (const row of ranked.slice(0, CANDIDATES)) {
    const candidate: Candidate = {
      id: Number(row.id),
      taskId: row.task_id as string,
      kind: row.kind as ChatSearchKind,
      turnId: text(row.turn_id),
      messageId: text(row.message_id),
    };
    const hits = byThread.get(candidate.taskId);
    if (!hits) {
      if (order.length === request.limit) {
        more = true;
        continue;
      }
      order.push(candidate.taskId);
      byThread.set(candidate.taskId, [candidate]);
    } else if (hits.length < request.perThread) hits.push(candidate);
    else more = true;
  }
  const title = db.prepare("SELECT json_extract(body,'$.title') AS title FROM entities WHERE id=?");
  const cursorOf = db.prepare('SELECT sequence FROM conversation_entries WHERE id=?');
  const turnMessage = db.prepare(
    "SELECT json_extract(body,'$.userMessageId') AS message FROM chat_turns WHERE id=?",
  );
  const snippetOf = db.prepare(
    `SELECT snippet(chat_search, 0, '${OPEN}', '${CLOSE}', '…', ${SNIPPET_TOKENS}) AS snippet,
      (instr(d.body, char(1)) > 0 OR instr(d.body, char(2)) > 0) AS ambiguous
    FROM chat_search JOIN chat_search_docs d ON d.id = chat_search.rowid
    WHERE chat_search MATCH ? AND chat_search.rowid = ?`,
  );
  // The turn a user message started, for the messages of one thread in a single read.
  const turnsOf = (taskId: string, messageIds: readonly string[]) => {
    const found = new Map<string, string>();
    if (messageIds.length === 0) return found;
    const rows = db
      .prepare(
        `SELECT id, json_extract(body,'$.userMessageId') AS message FROM chat_turns
        WHERE task_id=? AND json_extract(body,'$.userMessageId') IN (${messageIds.map(() => '?').join(',')})
        ORDER BY sequence`,
      )
      .all(taskId, ...messageIds);
    for (const row of rows) {
      const message = text(row.message);
      if (message && !found.has(message)) found.set(message, row.id as string);
    }
    return found;
  };
  const hitOf = (candidate: Candidate, turns: ReadonlyMap<string, string>): ChatSearchHit => {
    let { turnId, messageId } = candidate;
    if (candidate.kind === 'message' && !turnId && messageId) turnId = turns.get(messageId) ?? null;
    // A tool card belongs to a turn, and the turn names the message that started it.
    else if (candidate.kind !== 'title' && candidate.kind !== 'message' && turnId)
      messageId = text(turnMessage.get(turnId)?.message);
    const sequence = messageId ? cursorOf.get(messageId)?.sequence : undefined;
    const found = snippetOf.get(match, candidate.id);
    return {
      kind: candidate.kind,
      turnId,
      messageId,
      messageCursor: sequence === undefined ? null : String(sequence),
      ...readSnippet(text(found?.snippet) ?? '', Number(found?.ambiguous ?? 0) === 1),
    };
  };
  const groups: ChatSearchGroup[] = [];
  let bytes = PAGE_MARGIN + Buffer.byteLength(request.query);
  for (const taskId of order) {
    const heading = (text(title.get(taskId)?.title) ?? '').slice(0, 200).toWellFormed();
    const candidates = byThread.get(taskId) ?? [];
    const turns = turnsOf(
      taskId,
      candidates.flatMap((one) =>
        one.kind === 'message' && !one.turnId && one.messageId ? [one.messageId] : [],
      ),
    );
    const hits = candidates.map((one) => hitOf(one, turns));
    const group: ChatSearchGroup = { taskId, title: heading, hits };
    // A group that would pass the limit loses its last hits first, and a page never holds less
    // than its best group.
    while (
      group.hits.length > 1 &&
      bytes + Buffer.byteLength(JSON.stringify(group)) > MAX_CHAT_SEARCH_BYTES
    ) {
      group.hits.pop();
      more = true;
    }
    bytes += Buffer.byteLength(JSON.stringify(group)) + 1;
    if (groups.length > 0 && bytes > MAX_CHAT_SEARCH_BYTES) {
      more = true;
      break;
    }
    groups.push(group);
  }
  return ChatSearchResultSchema.parse({ ...empty, groups, more });
}
