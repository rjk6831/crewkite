import type { DatabaseSync } from 'node:sqlite';
import {
  ActivityBodyReferenceSchema,
  type Event,
  EventSchema,
  MAX_TASK_ACTIVITY_PAGE_BYTES,
  TaskActivityOutputPageSchema,
  type TaskActivityPage,
  TaskActivityPageSchema,
  type TaskActivityRequest,
  TaskActivityRequestSchema,
} from '@crewkite/contracts';

export function taskActivityPage(db: DatabaseSync, input: TaskActivityRequest): TaskActivityPage {
  const { taskId, limit, beforeCursor } = TaskActivityRequestSchema.parse(input);
  const before = beforeCursor === undefined ? null : BigInt(beforeCursor);
  const bounded = before !== null && before <= 9223372036854775807n;
  const query = db.prepare(
    `SELECT CAST(cursor AS TEXT) AS cursor,event_id,task_id,
     CASE WHEN length(CAST(body AS BLOB))<=? THEN body END AS body FROM events
     WHERE task_id=?${bounded ? ' AND events.cursor<?' : ''} ORDER BY events.cursor DESC LIMIT ?`,
  );
  const rows = bounded
    ? query.iterate(MAX_TASK_ACTIVITY_PAGE_BYTES, taskId, before, limit + 1)
    : query.iterate(MAX_TASK_ACTIVITY_PAGE_BYTES, taskId, limit + 1);
  const events: Event[] = [];
  let more = false;
  for (const row of rows) {
    if (events.length === limit || row.body === null) {
      if (events.length === 0) throw Error('activity-event-too-large');
      more = true;
      break;
    }
    const event = EventSchema.parse(JSON.parse(row.body as string));
    if (event.cursor !== row.cursor || event.id !== row.event_id || event.taskId !== row.task_id)
      throw Error('activity-history-invalid');
    const next = [event, ...events];
    // Reserve the continuation cursor before admitting the whole event to this page.
    const page = { kind: 'task-activity', taskId, events: next, nextBeforeCursor: event.cursor };
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_TASK_ACTIVITY_PAGE_BYTES) {
      if (events.length === 0) throw Error('activity-event-too-large');
      more = true;
      break;
    }
    events.unshift(event);
  }
  return TaskActivityPageSchema.parse({
    kind: 'task-activity',
    taskId,
    events,
    nextBeforeCursor: more ? events[0].cursor : null,
  });
}

// The original row stays authoritative until durable publication and its mapping both finish.
export async function taskActivityOutputPage(
  db: DatabaseSync,
  input: TaskActivityRequest,
  prepare: (
    cursor: string,
    eventId: string,
    bytes: number,
  ) => Promise<import('@crewkite/contracts').Artifact>,
): Promise<import('@crewkite/contracts').TaskActivityOutputPage> {
  const { taskId, limit, beforeCursor } = TaskActivityRequestSchema.parse(input);
  const before = beforeCursor === undefined ? null : BigInt(beforeCursor);
  const bounded = before !== null && before <= 9223372036854775807n;
  const query = db.prepare(`SELECT CAST(cursor AS TEXT) AS cursor,event_id,task_id,
    length(CAST(body AS BLOB)) AS bytes,
    json_extract(body,'$.id') AS body_id,json_extract(body,'$.cursor') AS body_cursor,
    json_extract(body,'$.taskId') AS body_task_id,
    json_extract(body,'$.at') AS at,json_extract(body,'$.revision') AS revision,
    json_extract(body,'$.type') AS type FROM events WHERE task_id=?
    ${bounded ? 'AND events.cursor<?' : ''} ORDER BY events.cursor DESC LIMIT ?`);
  // Finish the SQLite iterator before asynchronous publication can run another command.
  const rows = bounded ? query.all(taskId, before, limit + 1) : query.all(taskId, limit + 1);
  const entries: import('@crewkite/contracts').TaskActivityOutputPage['entries'] = [];
  let more = false;
  for (const row of rows) {
    if (entries.length === limit) {
      more = true;
      break;
    }
    if (
      row.body_id !== row.event_id ||
      row.body_cursor !== row.cursor ||
      row.body_task_id !== taskId
    )
      throw Error('activity-history-invalid');
    const body =
      (row.bytes as number) <= MAX_TASK_ACTIVITY_PAGE_BYTES - 4096
        ? db
            .prepare('SELECT body FROM events WHERE cursor=? AND event_id=?')
            .get(BigInt(row.cursor as string), row.event_id as string)?.body
        : null;
    const entry =
      body === null
        ? ActivityBodyReferenceSchema.parse({
            kind: 'event-body',
            id: row.event_id,
            cursor: row.cursor,
            taskId: row.task_id,
            at: row.at,
            revision: row.revision,
            type: row.type,
            artifact: await prepare(
              row.cursor as string,
              row.event_id as string,
              row.bytes as number,
            ),
          })
        : { kind: 'event' as const, event: EventSchema.parse(JSON.parse(body as string)) };
    const identity = entry.kind === 'event' ? entry.event : entry;
    if (
      identity.cursor !== row.cursor ||
      identity.id !== row.event_id ||
      identity.taskId !== taskId
    )
      throw Error('activity-history-invalid');
    const page = {
      kind: 'task-activity-page',
      taskId,
      entries: [entry, ...entries],
      nextBeforeCursor: identity.cursor,
    };
    if (Buffer.byteLength(JSON.stringify(page)) > MAX_TASK_ACTIVITY_PAGE_BYTES) {
      more = true;
      break;
    }
    entries.unshift(entry);
  }
  const first = entries[0];
  return TaskActivityOutputPageSchema.parse({
    kind: 'task-activity-page',
    taskId,
    entries,
    nextBeforeCursor:
      more && first ? (first.kind === 'event' ? first.event.cursor : first.cursor) : null,
  });
}

export async function* activityBodyChunks(
  db: DatabaseSync,
  cursor: string,
  eventId: string,
  bytes: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const query = db.prepare(`SELECT substr(CAST(body AS BLOB),?,65536) AS chunk,
    length(CAST(body AS BLOB)) AS bytes,event_id FROM events WHERE cursor=?`);
  for (let offset = 0; offset < bytes; offset += 65536) {
    signal.throwIfAborted();
    const row = query.get(offset + 1, BigInt(cursor));
    if (
      !row ||
      row.event_id !== eventId ||
      row.bytes !== bytes ||
      !(row.chunk instanceof Uint8Array) ||
      row.chunk.length !== Math.min(65536, bytes - offset)
    )
      throw Error('activity-history-invalid');
    yield row.chunk;
  }
}
