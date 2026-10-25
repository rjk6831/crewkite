import {
  type ConversationEntry,
  ConversationEntrySchema,
  type ConversationPage,
  ConversationPageSchema,
  CursorSchema,
  TaskIdSchema,
} from '@crewkite/contracts';
import type { Store } from '../store/index.ts';

// Reads of the retained conversation log. The chat thread writes new entries through its own
// service; retained planning entries stay readable here.
export class TaskConversation {
  private readonly store: Pick<Store, 'db'>;

  constructor(store: Pick<Store, 'db'>) {
    this.store = store;
  }

  page(taskId: string, beforeCursor?: string): ConversationPage {
    TaskIdSchema.parse(taskId);
    const ceiling =
      beforeCursor === undefined ? 9223372036854775807n : BigInt(CursorSchema.parse(beforeCursor));
    const rows = this.store.db
      .prepare(
        'SELECT body FROM conversation_entries WHERE task_id=? AND sequence<? ORDER BY sequence DESC LIMIT 101',
      )
      .all(taskId, ceiling > 9223372036854775807n ? 9223372036854775807n : ceiling);
    const entries: ConversationEntry[] = [];
    for (const row of rows.slice(0, 100)) {
      const entry = ConversationEntrySchema.parse(JSON.parse(row.body as string));
      const candidate = [entry, ...entries];
      if (
        !ConversationPageSchema.safeParse({
          kind: 'conversation',
          taskId,
          entries: candidate,
          nextBeforeCursor: candidate[0].cursor,
        }).success
      )
        break;
      entries.unshift(entry);
    }
    return ConversationPageSchema.parse({
      kind: 'conversation',
      taskId,
      entries,
      nextBeforeCursor: rows.length > entries.length ? entries[0].cursor : null,
    });
  }

  pendingQuestions(taskId: string): ConversationEntry[] {
    const rows = this.store.db
      .prepare(`SELECT question.body FROM conversation_entries question
      WHERE question.task_id=? AND json_extract(question.body,'$.kind')='question'
      AND json_extract(question.body,'$.binding.runId')=(SELECT json_extract(body,'$.runId') FROM entities WHERE kind='task' AND id=question.task_id)
      AND NOT EXISTS (SELECT 1 FROM conversation_entries answer WHERE answer.task_id=question.task_id
        AND json_extract(answer.body,'$.kind')='answer' AND json_extract(answer.body,'$.replyTo')=question.id)
      ORDER BY question.sequence LIMIT 100`)
      .all(TaskIdSchema.parse(taskId));
    return rows.map((row) => ConversationEntrySchema.parse(JSON.parse(row.body as string)));
  }
}
