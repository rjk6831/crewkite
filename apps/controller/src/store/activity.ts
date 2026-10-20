import type { DatabaseSync } from 'node:sqlite';
import {
  type Event,
  EventSchema,
  MAX_TASK_ACTIVITY_PAGE_BYTES,
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
