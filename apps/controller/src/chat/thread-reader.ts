import { join } from 'node:path';
import {
  type AgentEvent,
  AgentEventSchema,
  type ChatCheckRun,
  ChatChecksStateSchema,
  type ChatTurn,
  ChatTurnSchema,
  ConversationEntrySchema,
  MAX_THREAD_TURNS,
  type Task,
  ThreadChecksResultSchema,
  type ThreadDiffArgsSchema,
  type ThreadDiffResult,
  ThreadDiffResultSchema,
  type ThreadLiveResult,
  ThreadLiveResultSchema,
  type ThreadTurnArgsSchema,
  type ThreadTurnResult,
  ThreadTurnResultSchema,
  type ThreadTurnsArgsSchema,
  type ThreadTurnsResult,
  ThreadTurnsResultSchema,
} from '@crewkite/contracts';
import type { z } from 'zod';
import { ScratchTooLarge } from '../host/source.ts';
import type { Store } from '../store/index.ts';
import { scratchChanges } from './changes.ts';

// The five read-only thread tools of ADR 0044, over the thread store. Cloud clients reach them
// through the controller's MCP server and Local through native functions; both call the reader
// this file makes. Every result is redacted and bounded before it leaves, and parsed against its
// contract. Nothing here reads stdin bodies, the environment or the token window.

export type ThreadChecksResult = z.output<typeof ThreadChecksResultSchema>;

/** The reads one turn gets, scoped to its thread. The same shape the Local tools take. */
export type ThreadReads = {
  turns(args: z.output<typeof ThreadTurnsArgsSchema>): ThreadTurnsResult;
  turn(args: z.output<typeof ThreadTurnArgsSchema>): ThreadTurnResult;
  diff(args: z.output<typeof ThreadDiffArgsSchema>): ThreadDiffResult;
  checks(): ThreadChecksResult;
  live(): ThreadLiveResult;
};

export type ThreadReaderSource = Readonly<{
  store: Store;
  /** The controller home. The thread's scratch copy is under it. */
  home: string;
  projectPath: (projectId: string) => string | undefined;
  /** Milliseconds, for the elapsed time of a running turn. */
  now: () => number;
}>;

const REPLY_PREVIEW = 300;
const REPLY_BYTES = 32 * 1024;
const DIFF_BYTES = 64 * 1024;
const LIVE_BYTES = 8 * 1024;
const TRACE_ENTRIES = 200;
const TRACE_CHARACTERS = 500;
const FILES = 200;
const CHECK_LINES = 64;
const RUN_OUTPUT_LINES = 6;
const TRUNCATED = '\n[truncated]';
const OPEN = new Set<ChatTurn['state']>(['queued', 'running', 'waiting-permission']);

/**
 * Pattern redaction, a second guard for text a model or a command printed. It misses shapes it
 * does not know, and ADR 0044 says so.
 */
export function redact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/\bBearer\s+[^\s"'`]+/gi, 'Bearer [redacted]')
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_.-]*(?:TOKEN|SECRET|KEY)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      '$1$2[redacted]',
    );
}

/** The newest run of each check as lines: a summary, then the last lines of its output. */
function runLines(runs: readonly ChatCheckRun[]): { at: string; lines: string[] }[] {
  // Delete before set, so a check that ran again moves to the end with its newest run.
  const latest = new Map<string, ChatCheckRun>();
  for (const run of runs) {
    latest.delete(run.checkId);
    latest.set(run.checkId, run);
  }
  return [...latest.values()].map((run) => {
    const seconds = run.durationMs === null ? '' : ` in ${(run.durationMs / 1000).toFixed(1)} s`;
    const head = `${run.label} (${run.command}): ${run.status}${seconds}${run.reason ? `. ${run.reason}` : ''}`;
    const output = redact(run.tail)
      .split('\n')
      .filter((line) => line.trim())
      .slice(-RUN_OUTPUT_LINES)
      .map((line) => `  ${line}`);
    return {
      at: run.startedAt,
      lines: [head, ...output].map((line) => clipped(line, TRACE_CHARACTERS)),
    };
  });
}

/** The newest text that fits the byte budget, cut at a character. */
function tail(text: string, budget: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= budget) return text;
  return buffer
    .subarray(buffer.length - budget)
    .toString('utf8')
    .replace(/^�+/, '')
    .toWellFormed();
}

/** The oldest text that fits the byte budget, cut at a character. */
function head(text: string, budget: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= budget) return text;
  return buffer.subarray(0, budget).toString('utf8').replace(/�+$/, '').toWellFormed();
}

const clipped = (text: string, characters: number) =>
  text.length > characters ? text.slice(0, characters).toWellFormed() : text;

/** Paths an edit names in its input, the way the permission check reads them. */
function inputPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const fields = input as Record<string, unknown>;
  return ['file_path', 'notebook_path', 'path', 'filePath', 'paths'].flatMap((key) => {
    const value = fields[key];
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
  });
}

/** What a call named: the path of an edit or read, or the command line. Never its stdin. */
function target(event: Extract<AgentEvent, { type: 'tool.started' }>): string | null {
  const input = event.input as Record<string, unknown> | undefined;
  const command = typeof input?.command === 'string' ? input.command : null;
  const named = command ?? inputPaths(input)[0] ?? null;
  return named === null ? null : clipped(redact(named), TRACE_CHARACTERS);
}

/**
 * The thread's reads for one turn. Each call reads the store again, so a later call sees turns
 * that ended since. A turn of another thread is never found.
 */
export function createThreadReader(source: ThreadReaderSource, taskId: string): ThreadReads {
  const { store } = source;
  const rows = (): ChatTurn[] =>
    store.db
      .prepare('SELECT body FROM chat_turns WHERE task_id=? ORDER BY sequence')
      .all(taskId)
      .map((row) => ChatTurnSchema.parse(JSON.parse(row.body as string)));
  const entryText = (id: string | null): string => {
    if (!id) return '';
    const row = store.db
      .prepare('SELECT body FROM conversation_entries WHERE task_id=? AND id=?')
      .get(taskId, id);
    return row ? ConversationEntrySchema.parse(JSON.parse(row.body as string)).text : '';
  };
  const events = (turnId: string): AgentEvent[] =>
    store.db
      .prepare(
        "SELECT body FROM events WHERE task_id=? AND json_extract(body,'$.type')='agent.event' AND json_extract(body,'$.payload.turnId')=? AND json_extract(body,'$.payload.type') IN ('tool.started','tool.completed','text.delta','text.completed') ORDER BY cursor",
      )
      .all(taskId, turnId)
      .map((row) => AgentEventSchema.parse(JSON.parse(row.body as string).payload));
  const trace = (list: readonly AgentEvent[]) => {
    const ended = new Map(
      list.flatMap((event) =>
        event.type === 'tool.completed' ? [[event.callId, event.status] as const] : [],
      ),
    );
    return list
      .flatMap((event) => (event.type === 'tool.started' ? [event] : []))
      .slice(-TRACE_ENTRIES)
      .map((event) => ({
        kind: event.kind,
        title: clipped(redact(event.title), TRACE_CHARACTERS),
        target: target(event),
        outcome: ended.get(event.callId) ?? ('running' as const),
      }));
  };
  const changed = (list: readonly AgentEvent[]) => {
    const paths = new Set<string>();
    for (const event of list) {
      if (event.type === 'tool.completed' && event.diff) paths.add(event.diff.path);
      if (event.type === 'tool.started' && event.kind === 'edit')
        for (const path of inputPaths(event.input)) paths.add(path);
    }
    return [...paths];
  };
  const streamed = (list: readonly AgentEvent[]) => {
    const items = new Map<string, string>();
    for (const event of list) {
      if (event.type === 'text.delta')
        items.set(event.itemId, (items.get(event.itemId) ?? '') + event.text);
      if (event.type === 'text.completed') items.set(event.itemId, event.text);
    }
    return [...items.values()].filter((text) => text.trim()).join('\n\n');
  };
  const reply = (turn: ChatTurn, list: () => AgentEvent[]) =>
    turn.assistantMessageId ? entryText(turn.assistantMessageId) : streamed(list());

  return {
    turns(args) {
      const picked = rows()
        .filter(
          (turn) =>
            (args.since === undefined || turn.sequence > args.since) &&
            (args.family === undefined || turn.selection.family === args.family),
        )
        .slice(-Math.min(args.limit, MAX_THREAD_TURNS));
      return ThreadTurnsResultSchema.parse({
        turns: picked.map((turn) => {
          const list = events(turn.id);
          return {
            id: turn.id,
            sequence: turn.sequence,
            family: turn.selection.family,
            model: turn.selection.model,
            role: turn.role,
            status: turn.state,
            startedAt: turn.startedAt,
            endedAt: turn.endedAt,
            reply: clipped(redact(reply(turn, () => list)), REPLY_PREVIEW),
            changedFiles: changed(list).length,
          };
        }),
      });
    },

    turn(args) {
      const turn = rows().find((value) => value.id === args.id);
      if (!turn) throw new Error('No turn with that id in this thread.');
      const list = events(turn.id);
      const text = redact(reply(turn, () => list));
      const whole = Buffer.byteLength(text) <= REPLY_BYTES;
      return ThreadTurnResultSchema.parse({
        id: turn.id,
        reply: whole ? text : `${head(text, REPLY_BYTES - TRUNCATED.length)}${TRUNCATED}`,
        truncated: !whole,
        trace: trace(list),
        files: changed(list)
          .slice(0, FILES)
          .map((path) => clipped(path, 4096)),
      });
    },

    diff(args) {
      const thread = store.db.prepare('SELECT body FROM chat_threads WHERE task_id=?').get(taskId);
      const task = store.get<Task>('task', taskId);
      const base = thread ? (JSON.parse(thread.body as string).base as string | null) : null;
      const root = task && source.projectPath(task.projectId);
      if (!base || !root) return ThreadDiffResultSchema.parse({ diff: '', more: null });
      // Paths the turns after `since` touched. Their whole change against the base is shown.
      const touched =
        args.since === undefined
          ? null
          : new Set(
              rows()
                .filter((turn) => turn.sequence > (args.since ?? 0))
                .flatMap((turn) => changed(events(turn.id))),
            );
      let all: ReturnType<typeof scratchChanges>;
      try {
        all = scratchChanges(root, join(source.home, 'chat', taskId, 'scratch'), base);
      } catch (error) {
        if (!(error instanceof ScratchTooLarge)) throw error;
        return ThreadDiffResultSchema.parse({ diff: `${error.message}\n`, more: null });
      }
      const files = all
        .filter((file) => (args.path ? file.path === args.path : true))
        .filter((file) => !touched || touched.has(file.path));
      const text = redact(
        files
          .map((file) =>
            file.patch === null
              ? `Binary or too large to show: ${file.path} +${file.additions} -${file.deletions}`
              : file.patch.trimEnd(),
          )
          .join('\n'),
      );
      // The cursor is a byte offset into the whole diff. A diff that changes between calls can
      // shift it, and the next page then starts on another line.
      const start = Math.min(Number(args.cursor ?? 0) || 0, Buffer.byteLength(text));
      const rest = Buffer.from(text).subarray(start);
      if (rest.length <= DIFF_BYTES)
        return ThreadDiffResultSchema.parse({ diff: rest.toString('utf8'), more: null });
      const cut = rest.lastIndexOf(10, DIFF_BYTES - 1);
      const page = head(rest.toString('utf8'), cut > 0 ? cut + 1 : DIFF_BYTES);
      return ThreadDiffResultSchema.parse({
        diff: page,
        more: String(start + Buffer.byteLength(page)),
      });
    },

    checks() {
      const row = store.db.prepare('SELECT body FROM chat_threads WHERE task_id=?').get(taskId);
      const state = ChatChecksStateSchema.safeParse(
        row ? (JSON.parse(row.body as string) as { checks?: unknown }).checks : undefined,
      );
      // Run lines take at most three quarters of the answer, newest runs first to stay, so the
      // system lines about checks keep room. Both kinds are ordered by when they happened.
      const runs = state.success ? runLines(state.data.runs) : [];
      const kept: typeof runs = [];
      let used = 0;
      for (const group of runs.toReversed()) {
        if (used + group.lines.length > (CHECK_LINES * 3) / 4) break;
        kept.unshift(group);
        used += group.lines.length;
      }
      const entries = store.db
        .prepare(
          "SELECT body FROM conversation_entries WHERE task_id=? AND json_extract(body,'$.kind')='chat-system' AND json_extract(body,'$.text') LIKE '%check%' ORDER BY sequence DESC LIMIT ?",
        )
        .all(taskId, CHECK_LINES - used)
        .map((row) => ConversationEntrySchema.parse(JSON.parse(row.body as string)));
      const merged = [
        ...kept,
        ...entries.map((entry) => ({
          at: entry.at,
          lines: [clipped(redact(entry.text), TRACE_CHARACTERS)],
        })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      return ThreadChecksResultSchema.parse({
        lines: merged.flatMap((group) => group.lines).slice(-CHECK_LINES),
      });
    },

    live() {
      const turn = rows().findLast((value) => OPEN.has(value.state));
      if (!turn) return ThreadLiveResultSchema.parse({ state: 'none' });
      const list = events(turn.id);
      return ThreadLiveResultSchema.parse({
        state: 'running',
        turnId: turn.id,
        family: turn.selection.family,
        model: turn.selection.model,
        role: turn.role,
        elapsedMs: Math.max(0, Math.round(source.now() - Date.parse(turn.startedAt))),
        text: tail(redact(streamed(list)), LIVE_BYTES),
        trace: trace(list),
      });
    },
  };
}
