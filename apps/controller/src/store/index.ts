import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Attempt,
  type CommandResult,
  CommandResultSchema,
  canonicalJson,
  type Event,
  EventSchema,
  NativeReviewJobSchema,
  type Run,
  type Task,
  TimestampSchema,
} from '@crewkite/contracts';

export type EntityKind =
  | 'project'
  | 'task'
  | 'run'
  | 'attempt'
  | 'route'
  | 'approval'
  | 'candidate'
  | 'artifact'
  | 'window';
type Receipt = { request_hash: string; principal: string; result: string };
export type LaunchIntent = {
  attempt_id: string;
  task_id: string;
  run_id: string;
  route_id: string;
  generation: number;
  scratch_path: string;
  state: 'intent' | 'acknowledged' | 'outcome-unknown' | 'interrupted' | 'stopped';
  pid: number | null;
  process_group: number | null;
  admitted_at: string | null;
  finished_at: string | null;
};

export type NativeProcess = {
  attempt_id: string;
  sequence: number;
  phase: 'effective-features' | 'metadata-preparation' | 'app-server-task';
  state: 'intent' | 'owned' | 'quiescent';
  pid: number | null;
  process_group: number | null;
  intent_at: string;
  quiescent_at: string | null;
};

export class Store {
  readonly db: DatabaseSync;
  private transactionEvents: Event[] | null = null;
  private readonly listeners = new Set<(event: Event) => void>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('The database cannot be a symlink.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  }

  applyMigrations(directory: string) {
    const files = readdirSync(directory)
      .filter((file) => /^\d{3}-[a-z0-9-]+\.sql$/.test(file))
      .sort();
    const current = this.db.prepare('PRAGMA user_version').get()?.user_version as number;
    if (current > files.length) throw new Error('The database needs a newer controller.');
    for (let index = current; index < files.length; index++) {
      if (Number(files[index].slice(0, 3)) !== index + 1)
        throw new Error('Migration sequence has a gap.');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(readFileSync(join(directory, files[index]), 'utf8'));
        this.db.exec(`PRAGMA user_version=${index + 1}; COMMIT;`);
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {}
        throw error;
      }
    }
  }

  transaction<T>(work: () => T): T {
    if (this.transactionEvents) throw new Error('Nested controller transactions are unsupported.');
    this.transactionEvents = [];
    let active = false;
    let result: T;
    let events: Event[] = [];
    try {
      this.db.exec('BEGIN IMMEDIATE');
      active = true;
      result = work();
      if (result instanceof Promise)
        throw new Error('Controller transactions must be synchronous.');
      this.db.exec('COMMIT');
      active = false;
      events = this.transactionEvents;
    } catch (error) {
      if (active) {
        try {
          this.db.exec('ROLLBACK');
        } catch {}
      }
      throw error;
    } finally {
      this.transactionEvents = null;
    }
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // Failed subscribers can replay committed events after reconnecting.
          this.listeners.delete(listener);
        }
      }
    }
    return result;
  }

  get<T>(kind: EntityKind, id: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM entities WHERE kind=? AND id=?').get(kind, id);
    return row ? (JSON.parse(row.body as string) as T) : undefined;
  }

  list<T>(kind: EntityKind): T[] {
    return this.db
      .prepare('SELECT body FROM entities WHERE kind=? ORDER BY id')
      .all(kind)
      .map((row) => JSON.parse(row.body as string) as T);
  }

  put(kind: EntityKind, id: string, revision: number, body: unknown) {
    if (!this.transactionEvents) throw new Error('Entity writes require a transaction.');
    const result = this.db
      .prepare(`INSERT INTO entities(id,kind,revision,body) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body WHERE entities.kind=excluded.kind`)
      .run(id, kind, revision, canonicalJson(body));
    if (result.changes !== 1) throw new Error('Entity identity belongs to a different kind.');
  }

  receipt(key: string): { hash: string; principal: string; result: CommandResult } | undefined {
    const row = this.db
      .prepare('SELECT request_hash,principal,result FROM receipts WHERE command_key=?')
      .get(key) as Receipt | undefined;
    return row
      ? {
          hash: row.request_hash,
          principal: row.principal,
          result: CommandResultSchema.parse(JSON.parse(row.result)),
        }
      : undefined;
  }

  saveReceipt(key: string, hash: string, principal: string, result: CommandResult) {
    if (!this.transactionEvents) throw new Error('Receipt writes require a transaction.');
    this.db
      .prepare('INSERT INTO receipts(command_key,request_hash,principal,result) VALUES (?,?,?,?)')
      .run(key, hash, principal, canonicalJson(CommandResultSchema.parse(result)));
  }

  append(event: Omit<Event, 'cursor'>): Event {
    if (!this.transactionEvents) throw new Error('Events require a transaction.');
    const insert = this.db.prepare('INSERT INTO events(event_id,task_id,body) VALUES (?,?,?)');
    insert.setReadBigInts(true);
    const cursor = insert.run(event.id, event.taskId, '{}').lastInsertRowid.toString();
    const validated = EventSchema.parse({ ...event, cursor });
    this.db
      .prepare('UPDATE events SET body=? WHERE cursor=?')
      .run(canonicalJson(validated), BigInt(cursor));
    this.transactionEvents.push(validated);
    return validated;
  }

  cursor(): string {
    return this.db
      .prepare('SELECT CAST(COALESCE(MAX(cursor),0) AS TEXT) AS cursor FROM events')
      .get()?.cursor as string;
  }

  eventsAfter(cursor: string): Event[] {
    if (BigInt(cursor) > BigInt(this.cursor())) throw new Error('history-gap');
    const rows = this.db
      .prepare('SELECT body FROM events WHERE cursor>? ORDER BY cursor LIMIT 1001')
      .all(BigInt(cursor));
    if (rows.length > 1000) throw new Error('history-gap');
    return rows.map((row) => EventSchema.parse(JSON.parse(row.body as string)));
  }

  intents(): LaunchIntent[] {
    return this.db
      .prepare('SELECT * FROM launch_intents ORDER BY attempt_id')
      .all() as LaunchIntent[];
  }

  nativeProcesses(attemptId: string): NativeProcess[] {
    const rows = this.db
      .prepare('SELECT * FROM native_processes WHERE attempt_id=? ORDER BY sequence')
      .all(attemptId) as NativeProcess[];
    for (const [sequence, row] of rows.entries()) {
      if (
        row.sequence !== sequence ||
        (sequence === 0 && row.phase !== 'effective-features') ||
        (sequence === 1 && row.phase === 'effective-features') ||
        (sequence === 2 &&
          (rows[1]?.phase !== 'metadata-preparation' || row.phase !== 'app-server-task')) ||
        (sequence > 0 && rows[sequence - 1]?.state !== 'quiescent')
      )
        throw new Error('Native process sequence is invalid.');
    }
    return rows;
  }

  private nativeWriter(attemptId: string) {
    if (!this.transactionEvents) throw new Error('Native ownership writes require a transaction.');
    const intent = this.intents().find((value) => value.attempt_id === attemptId);
    const attempt = this.get<Attempt>('attempt', attemptId);
    const run = intent && this.get<Run>('run', intent.run_id);
    const task = intent && this.get<Task>('task', intent.task_id);
    const lease = this.db
      .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
      .get(intent?.task_id ?? '');
    if (
      !intent ||
      intent.state === 'stopped' ||
      !attempt ||
      !run ||
      !task ||
      attempt.runId !== run.id ||
      run.taskId !== task.id ||
      task.runId !== run.id ||
      attempt.routeId !== intent.route_id ||
      attempt.generation !== intent.generation ||
      lease?.attempt_id !== attemptId ||
      lease.generation !== intent.generation
    )
      throw new Error('Native process writer lineage is invalid.');
    return { attempt, task };
  }

  intendNativePhase(
    attemptId: string,
    sequence: number,
    phase: NativeProcess['phase'],
    at: string,
  ) {
    const { attempt, task } = this.nativeWriter(attemptId);
    const review =
      task.state === 'checking'
        ? this.db.prepare('SELECT body FROM review_jobs WHERE attempt_id=?').get(attemptId)
        : undefined;
    const job = review ? NativeReviewJobSchema.parse(JSON.parse(review.body as string)) : undefined;
    const reviewing =
      job &&
      job.taskId === task.id &&
      job.runId === attempt.runId &&
      job.attemptId === attempt.id &&
      job.routeId === attempt.routeId &&
      job.generation === attempt.generation;
    if (!['intent', 'running'].includes(attempt.state) || (task.state !== 'running' && !reviewing))
      throw new Error('Native phases require a current writer or native review.');
    const previous = this.nativeProcesses(attemptId);
    if (
      sequence !== previous.length ||
      sequence > 2 ||
      (sequence === 0 && phase !== 'effective-features') ||
      (sequence === 1 && !['metadata-preparation', 'app-server-task'].includes(phase)) ||
      (sequence === 2 &&
        (previous[1]?.phase !== 'metadata-preparation' || phase !== 'app-server-task')) ||
      previous.some((row) => row.state !== 'quiescent')
    )
      throw new Error('Native phase requires its preceding process to be quiescent.');
    this.db
      .prepare(
        "INSERT INTO native_processes(attempt_id,sequence,phase,state,intent_at) VALUES (?,?,?,'intent',?)",
      )
      .run(attemptId, sequence, phase, TimestampSchema.parse(at));
  }

  ownNativePhase(attemptId: string, sequence: number, group: number) {
    this.nativeWriter(attemptId);
    if (!Number.isSafeInteger(group) || group <= 0)
      throw new Error('Native process group must be a positive integer.');
    const result = this.db
      .prepare(
        "UPDATE native_processes SET state='owned',pid=?,process_group=? WHERE attempt_id=? AND sequence=? AND state='intent'",
      )
      .run(group, group, attemptId, sequence);
    if (result.changes !== 1) throw new Error('Native phase intent is missing or already owned.');
  }

  finishNativePhase(attemptId: string, sequence: number, group: number, at: string) {
    this.nativeWriter(attemptId);
    const result = this.db
      .prepare(
        "UPDATE native_processes SET state='quiescent',quiescent_at=? WHERE attempt_id=? AND sequence=? AND state='owned' AND process_group=?",
      )
      .run(TimestampSchema.parse(at), attemptId, sequence, group);
    if (result.changes !== 1) throw new Error('Native phase ownership does not match its closure.');
  }

  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.db.close();
  }
}
