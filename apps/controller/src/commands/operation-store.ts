import {
  ArtifactSchema,
  CommandIdSchema,
  type CommandResult,
  canonicalJson,
  HashSchema,
  TaskIdSchema,
  TimestampSchema,
} from '@crewkite/contracts';
import { z } from 'zod';
import type { Store } from '../store/index.ts';

const phase = z
  .strictObject({
    name: z.enum(['command', 'metadata', 'content']),
    state: z.enum(['intent', 'owned', 'closed']),
    group: z.number().int().positive().nullable(),
  })
  .refine((value) => (value.state === 'intent') === (value.group === null));
export const OperationRecordSchema = z
  .strictObject({
    id: CommandIdSchema,
    taskId: TaskIdSchema,
    kind: z.enum(['project-command', 'github-read']),
    revision: z.number().int().nonnegative(),
    definition: ArtifactSchema,
    state: z.enum([
      'prepared',
      'running',
      'stopping',
      'succeeded',
      'failed',
      'cancelled',
      'unknown',
    ]),
    createdAt: TimestampSchema,
    observedAt: TimestampSchema,
    key: CommandIdSchema.nullable(),
    requestHash: HashSchema.nullable(),
    phases: z.array(phase).max(2),
    stdout: ArtifactSchema.nullable(),
    stderr: ArtifactSchema.nullable(),
    result: ArtifactSchema.nullable(),
    reason: z.string().max(4096).nullable(),
    next: z.string().max(4096).nullable(),
  })
  .refine(
    (value) =>
      new Set(value.phases.map((item) => item.name)).size === value.phases.length &&
      value.phases.every(
        (item) => (value.kind === 'project-command') === (item.name === 'command'),
      ) &&
      (value.key === null) === (value.requestHash === null) &&
      (value.state !== 'prepared' || (value.key === null && value.phases.length === 0)) &&
      (value.state !== 'succeeded' ||
        (value.phases.length > 0 && value.phases.every((item) => item.state === 'closed'))) &&
      Buffer.byteLength(JSON.stringify(value)) <= 16384,
  );
export type OperationRecord = z.infer<typeof OperationRecordSchema>;
const terminal = new Set<OperationRecord['state']>(['succeeded', 'failed', 'cancelled']);

// Controller transactions bind effect admission and command receipts to these ownership rows.
export class OperationStore {
  private readonly store: Store;
  private readonly now: () => string;
  constructor(store: Store, now: () => string) {
    this.store = store;
    this.now = now;
  }

  get(id: string): OperationRecord | null {
    const row = this.store.db
      .prepare('SELECT task_id,kind,state,revision,body FROM task_operations WHERE operation_id=?')
      .get(id);
    if (!row) return null;
    const value = OperationRecordSchema.parse(JSON.parse(row.body as string));
    if (
      value.id !== id ||
      value.taskId !== row.task_id ||
      value.kind !== row.kind ||
      value.state !== row.state ||
      value.revision !== row.revision
    )
      throw Error('Operation binding is invalid.');
    return value;
  }

  list(taskId: string, beforeId?: string, limit = 20): OperationRecord[] {
    TaskIdSchema.parse(taskId);
    if (beforeId !== undefined) CommandIdSchema.parse(beforeId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 21)
      throw Error('Operation page limit is invalid.');
    const rows =
      beforeId === undefined
        ? this.store.db
            .prepare(
              'SELECT operation_id FROM task_operations WHERE task_id=? ORDER BY operation_id DESC LIMIT ?',
            )
            .all(taskId, limit)
        : this.store.db
            .prepare(
              'SELECT operation_id FROM task_operations WHERE task_id=? AND operation_id<? ORDER BY operation_id DESC LIMIT ?',
            )
            .all(taskId, beforeId, limit);
    return rows.map((row) => {
      const value = this.get(row.operation_id as string);
      if (!value) throw Error('Operation is unavailable.');
      return value;
    });
  }

  create(input: Pick<OperationRecord, 'id' | 'taskId' | 'kind' | 'definition'>): OperationRecord {
    if (!this.store.get('task', input.taskId)) throw Error('Operation task is unavailable.');
    const artifact = this.store.get('artifact', input.definition.id);
    if (!artifact || canonicalJson(artifact) !== canonicalJson(input.definition))
      throw Error('Operation definition binding is invalid.');
    const at = this.now();
    const value = OperationRecordSchema.parse({
      ...input,
      revision: 0,
      state: 'prepared',
      createdAt: at,
      observedAt: at,
      key: null,
      requestHash: null,
      phases: [],
      stdout: null,
      stderr: null,
      result: null,
      reason: null,
      next: null,
    });
    this.store.db
      .prepare(
        'INSERT INTO task_operations(operation_id,task_id,kind,state,revision,body) VALUES (?,?,?,?,?,?)',
      )
      .run(value.id, value.taskId, value.kind, value.state, value.revision, canonicalJson(value));
    return value;
  }

  private update(
    id: string,
    change: (record: OperationRecord) => OperationRecord,
  ): OperationRecord {
    const current = this.get(id);
    if (!current) throw Error('Operation is unavailable.');
    if (terminal.has(current.state)) throw Error('Operation is already complete.');
    const value = OperationRecordSchema.parse({
      ...change(current),
      revision: current.revision + 1,
      observedAt: this.now(),
    });
    if (
      value.id !== id ||
      value.taskId !== current.taskId ||
      value.kind !== current.kind ||
      canonicalJson(value.definition) !== canonicalJson(current.definition) ||
      value.createdAt !== current.createdAt
    )
      throw Error('Operation identity changed.');
    const written = this.store.db
      .prepare(
        'UPDATE task_operations SET state=?,revision=?,body=? WHERE operation_id=? AND revision=?',
      )
      .run(value.state, value.revision, canonicalJson(value), id, current.revision);
    if (written.changes !== 1) throw Error('Operation changed during its update.');
    return value;
  }

  begin(id: string, key: string, requestHash: string, authorize: () => void): OperationRecord {
    CommandIdSchema.parse(key);
    HashSchema.parse(requestHash);
    return this.store.transaction(() => {
      const prior = this.store.receipt(key);
      if (prior)
        throw Error(
          prior.hash === requestHash ? 'operation-already-recorded' : 'idempotency-key-reused',
        );
      const prepared = this.get(id);
      if (prepared?.state !== 'prepared') throw Error('Operation cannot start again.');
      authorize();
      const value = this.update(id, (current) => {
        if (current.state !== 'prepared') throw Error('Operation cannot start again.');
        return { ...current, key, requestHash, state: 'running' };
      });
      this.store.saveReceipt(key, requestHash, 'local-owner', {
        outcome: 'blocked',
        reason: 'operation-pending',
      });
      return value;
    });
  }

  stopping(id: string): OperationRecord {
    return this.store.transaction(() =>
      this.update(id, (current) => {
        if (current.state !== 'running') throw Error('Operation is not running.');
        return { ...current, state: 'stopping' };
      }),
    );
  }

  phase(
    id: string,
    name: 'command' | 'metadata' | 'content',
    state: 'intent' | 'owned' | 'closed',
    group: number | null,
  ): OperationRecord {
    return this.store.transaction(() =>
      this.update(id, (current) => {
        if ((current.kind === 'project-command') !== (name === 'command'))
          throw Error('Operation phase kind is invalid.');
        if (!['running', 'stopping'].includes(current.state))
          throw Error('Operation is not active.');
        const previous = current.phases.find((item) => item.name === name);
        if (
          state === 'intent'
            ? previous !== undefined ||
              group !== null ||
              current.phases.some((item) => item.state !== 'closed')
            : !previous ||
              (state === 'owned'
                ? previous.state !== 'intent' || group === null
                : previous.state !== 'owned' || previous.group !== group)
        )
          throw Error('Operation phase transition is invalid.');
        const phases = current.phases.filter((item) => item.name !== name);
        phases.push({ name, state, group });
        return { ...current, phases };
      }),
    );
  }

  finish(
    id: string,
    change: { state: 'succeeded' | 'failed' | 'cancelled' | 'unknown' } & Pick<
      OperationRecord,
      'reason' | 'next'
    > &
      Partial<Pick<OperationRecord, 'stdout' | 'stderr' | 'result'>>,
    receipt: CommandResult,
  ): OperationRecord {
    if (
      receipt.outcome === 'outcome-unknown' ||
      (change.state === 'unknown' &&
        (receipt.outcome !== 'blocked' || receipt.reason !== 'operation-ownership-unknown'))
    )
      throw Error('Operation uncertainty must stay scoped to its owner.');
    return this.store.transaction(() => {
      const value = this.update(id, (current) => {
        if (terminal.has(current.state)) throw Error('Operation is already complete.');
        if (change.state !== 'unknown' && current.phases.some((item) => item.state !== 'closed'))
          throw Error('Operation ownership remains unknown.');
        return { ...current, ...change };
      });
      if (value.key) {
        const prior = this.store.receipt(value.key);
        if (
          !prior ||
          prior.hash !== value.requestHash ||
          prior.principal !== 'local-owner' ||
          !['operation-pending', 'operation-ownership-unknown'].includes(prior.result.reason ?? '')
        )
          throw Error('Operation receipt binding changed.');
        this.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run(value.key);
        this.store.saveReceipt(value.key, prior.hash, 'local-owner', receipt);
      }
      return value;
    });
  }

  // Recovery observes historical groups without signaling them or replaying an intent.
  recover(absent: (group: number) => boolean): void {
    let after = '';
    for (;;) {
      const rows = this.store.db
        .prepare(`SELECT operation_id FROM task_operations
        WHERE state IN ('running','stopping','unknown') AND operation_id>? ORDER BY operation_id LIMIT 20`)
        .all(after);
      if (rows.length === 0) return;
      for (const row of rows) {
        after = row.operation_id as string;
        const saved = this.get(after);
        if (!saved) throw Error('Operation is unavailable.');
        const known = saved.phases.every(
          (item) =>
            item.state === 'closed' ||
            (item.state === 'owned' && item.group !== null && absent(item.group)),
        );
        if (!known) {
          if (saved.state !== 'unknown' || saved.reason !== 'operation-ownership-unknown')
            this.finish(
              saved.id,
              {
                state: 'unknown',
                reason: 'operation-ownership-unknown',
                next: 'Resolve the previous process before starting more work. It will not replay.',
              },
              { outcome: 'blocked', reason: 'operation-ownership-unknown' },
            );
          continue;
        }
        this.store.transaction(() =>
          this.update(saved.id, (current) => ({
            ...current,
            phases: current.phases.map((item) => ({ ...item, state: 'closed' as const })),
          })),
        );
        this.finish(
          saved.id,
          {
            state: 'failed',
            reason: 'operation-interrupted',
            next: 'The previous operation stopped. Prepare a new explicit operation.',
          },
          { outcome: 'blocked', reason: 'operation-interrupted' },
        );
      }
    }
  }
}
