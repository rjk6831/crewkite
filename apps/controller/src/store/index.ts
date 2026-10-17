import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Attempt,
  CommandIdSchema,
  type CommandResult,
  CommandResultSchema,
  canonicalJson,
  type Event,
  EventSchema,
  GoogleAcpSetupSchema,
  NativeReviewJobSchema,
  type Route,
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
export type GoogleMetadataKind = 'usage' | 'acp-initialize' | 'acp-authenticate' | 'acp-discover';
export type GoogleMetadataOperation = {
  command_id: string;
  family: 'google';
  kind: GoogleMetadataKind;
  authority_revision: number;
  state: 'intent' | 'owned' | 'quiescent' | 'unknown';
  pid: number | null;
  process_group: number | null;
  started_at: string;
  finished_at: string | null;
};
export type GoogleUsageReader = {
  enabled: number;
  authority_revision: number;
  last_attempt_at: string | null;
  last_observed_at: string | null;
};
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
  phase:
    | 'effective-features'
    | 'metadata-preparation'
    | 'app-server-task'
    | 'google-config'
    | 'google-acp-task'
    | 'auth-status'
    | 'native-task';
  state: 'intent' | 'owned' | 'quiescent';
  pid: number | null;
  process_group: number | null;
  intent_at: string;
  quiescent_at: string | null;
};

/** Historical short preflight sequences remain readable; success requires the full task sequence. */
export function nativePhaseSequence(
  family: Route['family'],
  phases: readonly NativeProcess['phase'][],
  complete = false,
  profileId?: string,
): boolean {
  const sequences: NativeProcess['phase'][][] =
    profileId === 'google-acp-v1'
      ? family === 'google'
        ? [['google-acp-task']]
        : []
      : family === 'openai'
        ? [
            ['effective-features', 'metadata-preparation', 'app-server-task'],
            ...(complete
              ? []
              : [['effective-features', 'app-server-task'] as NativeProcess['phase'][]]),
          ]
        : family === 'anthropic'
          ? [['auth-status', 'native-task']]
          : family === 'google'
            ? [['google-config', 'native-task']]
            : [];
  return sequences.some(
    (sequence) =>
      phases.length <= sequence.length &&
      (!complete || phases.length === sequence.length) &&
      phases.every((phase, index) => phase === sequence[index]),
  );
}

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

  conversationTask(taskId: string): unknown {
    const row = this.db.prepare('SELECT body FROM task_conversations WHERE task_id=?').get(taskId);
    return row ? JSON.parse(row.body as string) : undefined;
  }

  putConversationTask(taskId: string, body: unknown) {
    if (!this.transactionEvents) throw new Error('Conversation writes require a transaction.');
    this.db
      .prepare(
        'INSERT INTO task_conversations(task_id,body) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body',
      )
      .run(taskId, canonicalJson(body));
  }

  runPurpose(runId: string): 'conversation' | 'execution' | undefined {
    const row = this.db.prepare('SELECT purpose FROM run_purposes WHERE run_id=?').get(runId);
    return row?.purpose as 'conversation' | 'execution' | undefined;
  }

  putRunPurpose(run: Run, purpose: 'conversation' | 'execution', parentRunId: string | null) {
    if (!this.transactionEvents) throw new Error('Run purpose writes require a transaction.');
    this.db
      .prepare('INSERT INTO run_purposes(run_id,task_id,purpose,parent_run_id) VALUES (?,?,?,?)')
      .run(run.id, run.taskId, purpose, parentRunId);
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

  googleUsageReader(): GoogleUsageReader {
    return this.db
      .prepare('SELECT * FROM google_usage_reader WHERE family=?')
      .get('google') as GoogleUsageReader;
  }

  googleAcpSetup(): ReturnType<typeof GoogleAcpSetupSchema.parse> {
    const row = this.db
      .prepare("SELECT body FROM google_acp_setup WHERE profile_id='google-acp-v1'")
      .get();
    return GoogleAcpSetupSchema.parse(
      row
        ? JSON.parse(row.body as string)
        : {
            profileId: 'google-acp-v1',
            revision: 0,
            state: 'uninitialized',
            operationId: null,
            proofId: null,
            client: null,
            auth: { method: null, status: 'unknown' },
            reason: null,
          },
    );
  }

  putGoogleAcpSetup(input: ReturnType<typeof GoogleAcpSetupSchema.parse>) {
    this.metadataWrite();
    const setup = GoogleAcpSetupSchema.parse(input);
    this.db
      .prepare(
        "INSERT INTO google_acp_setup(profile_id,revision,body) VALUES ('google-acp-v1',?,?) ON CONFLICT(profile_id) DO UPDATE SET revision=excluded.revision,body=excluded.body",
      )
      .run(setup.revision, canonicalJson(setup));
  }

  nativeProfileId(attemptId: string): 'google-acp-v1' | undefined {
    return this.db
      .prepare('SELECT profile_id FROM native_profile_bindings WHERE attempt_id=?')
      .get(attemptId)?.profile_id as 'google-acp-v1' | undefined;
  }

  bindNativeProfile(attemptId: string, profileId: 'google-acp-v1') {
    this.metadataWrite();
    const intent = this.intents().find((row) => row.attempt_id === attemptId);
    if (
      profileId !== 'google-acp-v1' ||
      !intent ||
      this.get<Route>('route', intent.route_id)?.family !== 'google' ||
      this.get<Route>('route', intent.route_id)?.fake
    )
      throw new Error('Native profile binding is invalid.');
    this.db
      .prepare('INSERT INTO native_profile_bindings(attempt_id,profile_id) VALUES (?,?)')
      .run(attemptId, profileId);
  }

  private metadataWrite() {
    if (!this.transactionEvents)
      throw new Error('Metadata ownership writes require a transaction.');
  }

  setGoogleUsageConsent(enabled: boolean) {
    this.metadataWrite();
    const reader = this.googleUsageReader();
    this.db
      .prepare(
        `UPDATE google_usage_reader SET enabled=?,authority_revision=? WHERE family='google'`,
      )
      .run(Number(enabled), reader.authority_revision + (enabled && reader.enabled ? 0 : 1));
  }

  recordGoogleUsageAttempt(at: string) {
    this.metadataWrite();
    this.db
      .prepare("UPDATE google_usage_reader SET last_attempt_at=? WHERE family='google'")
      .run(TimestampSchema.parse(at));
  }

  recordGoogleUsageObservation(at: string) {
    this.metadataWrite();
    this.db
      .prepare("UPDATE google_usage_reader SET last_observed_at=? WHERE family='google'")
      .run(TimestampSchema.parse(at));
  }

  googleMetadataOperations(): GoogleMetadataOperation[] {
    return this.db
      .prepare('SELECT * FROM google_metadata_operations ORDER BY started_at,command_id')
      .all() as GoogleMetadataOperation[];
  }

  googleOperationBlocker(
    exceptCommandId?: string,
  ): 'google-operation-active' | 'google-ownership-unknown' | undefined {
    this.metadataWrite();
    const operations = this.googleMetadataOperations().filter(
      (row) => row.command_id !== exceptCommandId && row.state !== 'quiescent',
    );
    const writers = this.intents().filter(
      (intent) =>
        intent.state !== 'stopped' &&
        this.get<Route>('route', intent.route_id)?.family === 'google' &&
        !this.get<Route>('route', intent.route_id)?.fake,
    );
    if (
      operations.some((row) => row.state === 'unknown') ||
      writers.some(
        (row) =>
          ['outcome-unknown', 'interrupted'].includes(row.state) ||
          this.get<Attempt>('attempt', row.attempt_id)?.state === 'unknown',
      )
    )
      return 'google-ownership-unknown';
    if (operations.length || writers.length) return 'google-operation-active';
  }

  googleStartBlocker(routeId: string) {
    this.metadataWrite();
    const route = this.get<Route>('route', routeId);
    return route?.family === 'google' && !route.fake ? this.googleOperationBlocker() : undefined;
  }

  beginGoogleMetadata(
    commandId: string,
    kind: GoogleMetadataKind,
    authorityRevision: number,
    at: string,
  ) {
    this.metadataWrite();
    const blocker = this.googleOperationBlocker();
    if (blocker) throw new Error(blocker);
    if (
      !['usage', 'acp-initialize', 'acp-authenticate', 'acp-discover'].includes(kind) ||
      !Number.isSafeInteger(authorityRevision) ||
      authorityRevision < 0
    )
      throw new Error('Metadata authority is invalid.');
    this.db
      .prepare(
        "INSERT INTO google_metadata_operations(command_id,kind,authority_revision,state,started_at) VALUES (?,?,?,'intent',?)",
      )
      .run(CommandIdSchema.parse(commandId), kind, authorityRevision, TimestampSchema.parse(at));
  }

  ownGoogleMetadata(commandId: string, group: number) {
    this.metadataWrite();
    if (!Number.isSafeInteger(group) || group <= 0)
      throw new Error('Metadata process group must be a positive integer.');
    const result = this.db
      .prepare(
        "UPDATE google_metadata_operations SET state='owned',pid=?,process_group=? WHERE command_id=? AND state='intent'",
      )
      .run(group, group, commandId);
    if (result.changes !== 1) throw new Error('Metadata process intent is unavailable.');
  }

  finishGoogleMetadata(commandId: string, group: number | null, at: string) {
    this.metadataWrite();
    const result = this.db
      .prepare(
        `UPDATE google_metadata_operations SET state='quiescent',finished_at=? WHERE command_id=? AND ((state='intent' AND process_group IS NULL AND ? IS NULL) OR (state IN ('owned','unknown') AND process_group=?))`,
      )
      .run(TimestampSchema.parse(at), commandId, group, group);
    if (result.changes !== 1) throw new Error('Metadata process closure does not match its owner.');
  }

  unknownGoogleMetadata(commandId: string) {
    this.metadataWrite();
    this.db
      .prepare(
        "UPDATE google_metadata_operations SET state='unknown' WHERE command_id=? AND state<>'quiescent'",
      )
      .run(commandId);
  }

  nativeProcesses(attemptId: string): NativeProcess[] {
    const rows = this.db
      .prepare('SELECT * FROM native_processes WHERE attempt_id=? ORDER BY sequence')
      .all(attemptId) as NativeProcess[];
    if (!rows.length) return rows;
    const attempt = this.get<Attempt>('attempt', attemptId);
    const route = attempt && this.get<Route>('route', attempt.routeId);
    if (
      !route ||
      route.fake ||
      !nativePhaseSequence(
        route.family,
        rows.map((row) => row.phase),
        false,
        this.nativeProfileId(attemptId),
      )
    )
      throw new Error('Native process sequence is invalid.');
    for (const [sequence, row] of rows.entries()) {
      if (row.sequence !== sequence || (sequence > 0 && rows[sequence - 1]?.state !== 'quiescent'))
        throw new Error('Native process sequence is invalid.');
    }
    return rows;
  }

  nativePhasesComplete(attemptId: string, expectedFamily: Route['family']): boolean {
    const attempt = this.get<Attempt>('attempt', attemptId);
    const route = attempt && this.get<Route>('route', attempt.routeId);
    const phases = this.nativeProcesses(attemptId);
    return (
      !!route &&
      !route.fake &&
      route.family === expectedFamily &&
      nativePhaseSequence(
        route.family,
        phases.map((phase) => phase.phase),
        true,
        this.nativeProfileId(attemptId),
      ) &&
      phases.every((phase) => phase.state === 'quiescent')
    );
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
    if (this.runPurpose(attempt.runId) === 'conversation') {
      const run = this.get<Run>('run', attempt.runId);
      if (
        reviewing ||
        !run?.roles.some(
          (role) =>
            ['lead', 'orchestrator'].includes(role.role) && role.routeId === attempt.routeId,
        ) ||
        !this.receipt(`conversation-turn:${attemptId}`)
      )
        throw new Error('Planning phases require their admitted conversation purpose.');
    }
    const previous = this.nativeProcesses(attemptId);
    const route = this.get<Route>('route', attempt.routeId);
    if (
      !route ||
      route.fake ||
      (reviewing && route.family !== 'openai') ||
      sequence !== previous.length ||
      !nativePhaseSequence(
        route.family,
        [...previous.map((row) => row.phase), phase],
        false,
        this.nativeProfileId(attemptId),
      ) ||
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
