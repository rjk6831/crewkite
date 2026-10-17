import {
  AttemptSchema,
  type ConversationContextRefs,
  ConversationContextRefsSchema,
  type ConversationEntry,
  ConversationEntrySchema,
  type ConversationPage,
  ConversationPageSchema,
  ConversationTextSchema,
  type ConversationTurnBinding,
  ConversationTurnBindingSchema,
  ConversationTurnResultSchema,
  CursorSchema,
  canonicalJson,
  HashSchema,
  MessageIdSchema,
  NativeTargetPathSchema,
  RunSchema,
  type Task,
  TaskIdSchema,
  TaskSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import type { Store } from '../store/index.ts';

const scopeSchema = z.strictObject({
  paths: z.array(NativeTargetPathSchema).max(10000),
  roles: z
    .array(z.enum(['coder', 'reviewer', 'advisor']))
    .min(1)
    .max(3),
  checks: z.array(z.string().min(1).max(200)).max(20),
});
export type ConversationScope = z.infer<typeof scopeSchema>;
export type FrozenConversationTurn = {
  binding: ConversationTurnBinding;
  bindingHash: string;
  scope: ConversationScope;
};
type EntryDraft = ConversationEntry extends infer Entry
  ? Entry extends ConversationEntry
    ? Omit<Entry, 'id' | 'taskId' | 'revision' | 'cursor' | 'at'>
    : never
  : never;
export type ConversationWrite =
  | { applied: true; task: Task; entries: ConversationEntry[] }
  | { applied: false; reason: string };
type Options = {
  now: () => string;
  messageId: () => string;
  publish: (entries: ConversationEntry[], task: Task) => void;
  ownsTurn: (binding: ConversationTurnBinding, phase: 'input' | 'result') => boolean;
};

export class TaskConversation {
  private readonly store: Pick<Store, 'db' | 'get' | 'put'>;
  private readonly options: Options;

  constructor(store: Pick<Store, 'db' | 'get' | 'put'>, options: Options) {
    this.store = store;
    this.options = options;
  }

  revision(taskId: string): number {
    const row = this.store.db
      .prepare(
        'SELECT COALESCE(MAX(sequence),0) AS revision FROM conversation_entries WHERE task_id=?',
      )
      .get(TaskIdSchema.parse(taskId));
    return z.number().int().nonnegative().safe().parse(row?.revision);
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

  pendingInputs(taskId: string, throughRevision = this.revision(taskId)): ConversationEntry[] {
    const rows = this.store.db
      .prepare(`SELECT input.body FROM conversation_entries input
      WHERE input.task_id=? AND input.sequence<=?
      AND json_extract(input.body,'$.kind') IN ('user-message','guidance','answer')
      AND NOT EXISTS (SELECT 1 FROM conversation_entries delivery WHERE delivery.task_id=input.task_id
        AND json_extract(delivery.body,'$.kind')='input-delivery' AND json_extract(delivery.body,'$.replyTo')=input.id)
      ORDER BY input.sequence LIMIT 100`)
      .all(
        TaskIdSchema.parse(taskId),
        z.number().int().nonnegative().safe().parse(throughRevision),
      );
    return rows.map((row) => ConversationEntrySchema.parse(JSON.parse(row.body as string)));
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

  recordMessage(
    taskId: string,
    text: string,
    kind: 'user-message' | 'guidance' = 'user-message',
    context?: ConversationContextRefs,
  ): ConversationWrite {
    const task = this.task(taskId);
    if (!task) return { applied: false, reason: 'task-not-found' };
    return this.append(task, [
      {
        kind,
        author: { kind: 'user' },
        text: ConversationTextSchema.parse(text),
        ...(context === undefined ? {} : { context: ConversationContextRefsSchema.parse(context) }),
      },
    ]);
  }

  answerQuestion(
    taskId: string,
    questionId: string,
    text: string,
    context?: ConversationContextRefs,
  ): ConversationWrite {
    const task = this.task(taskId);
    if (!task) return { applied: false, reason: 'task-not-found' };
    const question = this.entry(taskId, questionId);
    if (question?.kind !== 'question') return { applied: false, reason: 'question-not-found' };
    if (question.binding.runId !== task.runId)
      return { applied: false, reason: 'question-not-current' };
    if (this.reference(taskId, 'answer', questionId))
      return { applied: false, reason: 'question-already-answered' };
    return this.append(task, [
      {
        kind: 'answer',
        author: { kind: 'user' },
        replyTo: question.id,
        text: ConversationTextSchema.parse(text),
        ...(context === undefined ? {} : { context: ConversationContextRefsSchema.parse(context) }),
      },
    ]);
  }

  includeInputs(turn: FrozenConversationTurn, messageIds: string[]): ConversationWrite {
    const task = this.currentTurn(turn, 'input');
    if (!task) return { applied: false, reason: 'turn-binding-changed' };
    if (
      messageIds.length === 0 ||
      messageIds.length > 100 ||
      new Set(messageIds).size !== messageIds.length
    )
      return { applied: false, reason: 'conversation-input-invalid' };
    const inputs = messageIds.map((id) => this.entry(task.id, id));
    if (
      inputs.some(
        (entry) =>
          !entry ||
          !['user-message', 'guidance', 'answer'].includes(entry.kind) ||
          BigInt(entry.cursor) > BigInt(turn.binding.conversationRevision) ||
          this.reference(task.id, 'input-delivery', entry.id),
      )
    )
      return { applied: false, reason: 'conversation-input-invalid' };
    return this.append(
      task,
      messageIds.map((replyTo) => ({
        kind: 'input-delivery',
        author: { kind: 'controller' },
        binding: turn.binding,
        replyTo,
        text: 'Included in the frozen turn input.',
      })),
    );
  }

  recordReply(turn: FrozenConversationTurn, input: unknown): ConversationWrite {
    const task = this.currentTurn(turn, 'result');
    if (!task) return { applied: false, reason: 'turn-binding-changed' };
    const parsed = ConversationTurnResultSchema.safeParse(input);
    if (!parsed.success || parsed.data.bindingHash !== turn.bindingHash)
      return { applied: false, reason: 'conversation-output-invalid' };
    const result = parsed.data;
    if (
      this.store.db
        .prepare(`SELECT 1 FROM conversation_entries WHERE task_id=?
      AND json_extract(body,'$.kind')='agent-message' AND json_extract(body,'$.binding.attemptId')=?`)
        .get(task.id, turn.binding.attemptId)
    )
      return { applied: false, reason: 'conversation-turn-recorded' };
    if (
      result.proposal &&
      (result.proposal.slices.some(
        (slice) =>
          !turn.scope.roles.includes(slice.role) ||
          slice.scope.some((path) => !turn.scope.paths.includes(path)),
      ) ||
        result.proposal.checks.some((check) => !turn.scope.checks.includes(check)))
    )
      return { applied: false, reason: 'conversation-proposal-outside-scope' };
    if (this.pendingQuestions(task.id).length + result.questions.length > 100)
      return { applied: false, reason: 'conversation-question-limit' };
    const author = {
      kind: 'agent' as const,
      role: turn.binding.role,
      attemptId: turn.binding.attemptId,
      routeId: turn.binding.routeId,
    };
    const common = { author, binding: turn.binding };
    const drafts: EntryDraft[] = [{ ...common, kind: 'agent-message', text: result.message }];
    for (const text of result.questions) drafts.push({ ...common, kind: 'question', text });
    if (result.proposal)
      drafts.push({
        ...common,
        kind: 'plan-proposal',
        text: result.proposal.summary,
        proposal: result.proposal,
      });
    return this.append(task, drafts);
  }

  private currentTurn(turn: FrozenConversationTurn, phase: 'input' | 'result'): Task | undefined {
    const binding = ConversationTurnBindingSchema.safeParse(turn.binding);
    const scope = scopeSchema.safeParse(turn.scope);
    if (
      !binding.success ||
      !scope.success ||
      !HashSchema.safeParse(turn.bindingHash).success ||
      hashCanonical(scope.data) !== binding.data.scopeHash
    )
      return;
    const task = this.task(binding.data.taskId);
    const run = RunSchema.safeParse(this.store.get('run', binding.data.runId));
    const attempt = AttemptSchema.safeParse(this.store.get('attempt', binding.data.attemptId));
    if (
      !task ||
      !run.success ||
      !attempt.success ||
      task.runId !== run.data.id ||
      run.data.taskId !== task.id ||
      task.revision < binding.data.taskRevision ||
      this.revision(task.id) < binding.data.conversationRevision ||
      attempt.data.runId !== run.data.id ||
      attempt.data.routeId !== binding.data.routeId ||
      attempt.data.generation !== binding.data.generation ||
      !run.data.roles.some(
        (role) => role.role === binding.data.role && role.routeId === binding.data.routeId,
      ) ||
      !this.options.ownsTurn(binding.data, phase)
    )
      return;
    return task;
  }

  private task(taskId: string): Task | undefined {
    const task = this.store.get('task', TaskIdSchema.parse(taskId));
    return task === undefined ? undefined : TaskSchema.parse(task);
  }

  private entry(taskId: string, id: string): ConversationEntry | undefined {
    const row = this.store.db
      .prepare('SELECT body FROM conversation_entries WHERE task_id=? AND id=?')
      .get(taskId, MessageIdSchema.parse(id));
    return row ? ConversationEntrySchema.parse(JSON.parse(row.body as string)) : undefined;
  }

  private reference(taskId: string, kind: 'answer' | 'input-delivery', id: string): boolean {
    return !!this.store.db
      .prepare(`SELECT 1 FROM conversation_entries WHERE task_id=?
      AND json_extract(body,'$.kind')=? AND json_extract(body,'$.replyTo')=? LIMIT 1`)
      .get(taskId, kind, id);
  }

  private append(task: Task, drafts: EntryDraft[]): ConversationWrite {
    const updated = TaskSchema.parse({ ...task, revision: task.revision + 1 });
    const entries = drafts.map((draft) =>
      ConversationEntrySchema.parse({
        ...draft,
        id: this.options.messageId(),
        taskId: task.id,
        revision: updated.revision,
        cursor: '0',
        at: this.options.now(),
      }),
    );
    // Store.put refuses writes outside the controller's command transaction.
    this.store.put('task', updated.id, updated.revision, updated);
    for (const entry of entries) {
      const insert = this.store.db.prepare(
        'INSERT INTO conversation_entries(id,task_id,body) VALUES (?,?,?)',
      );
      insert.setReadBigInts(true);
      entry.cursor = insert.run(entry.id, task.id, '{}').lastInsertRowid.toString();
      const validated = ConversationEntrySchema.parse(entry);
      this.store.db
        .prepare('UPDATE conversation_entries SET body=? WHERE id=?')
        .run(canonicalJson(validated), entry.id);
    }
    this.options.publish(entries, updated);
    return { applied: true, task: updated, entries };
  }
}
