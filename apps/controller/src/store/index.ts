import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Attempt,
  CombinedDispatchPhaseSchema,
  type CombinedRunPreview,
  CommandIdSchema,
  type CommandResult,
  CommandResultSchema,
  canonicalJson,
  type Event,
  EventSchema,
  GoogleAcpSetupSchema,
  MAX_FRAME_BYTES,
  ReviewJobSchema,
  type Route,
  type Run,
  type Task,
  TimestampSchema,
  type WorkspaceStamp,
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
export type CombinedGroup = {
  run_id: string;
  task_id: string;
  preparation_id: string;
  manifest_hash: string;
  revision: number;
  generation: number;
  phase: CombinedRunPreview['phase'];
  blocker: CombinedRunPreview['blocker'];
  paused_phase: CombinedRunPreview['phase'] | null;
  integration_ref: string;
  current_head: string | null;
  final_candidate_id: string | null;
  origin_artifact_id: string | null;
  integration_started_at: string | null;
  integration_finished_at: string | null;
  integration_milliseconds: number;
  integration_active: number;
  integration_maximum_minutes: number;
};
export type CombinedMember = {
  parent_run_id: string;
  ordinal: number;
  task_id: string;
  run_id: string;
  preparation_id: string;
  scope_path: string;
  scope_hash: string;
  task_hash: string;
};
export type CombinedDispatch = {
  parent_run_id: string;
  phase: CombinedRunPreview['dispatches'][number]['phase'];
  maximum_minutes: number;
  state: CombinedRunPreview['dispatches'][number]['state'];
  attempt_id: string | null;
  candidate_id: string | null;
  check_artifact_id: string | null;
  definition_hash: string | null;
};
export type CombinedRefIntent = {
  parent_run_id: string;
  generation: number;
  operation: string;
  expected_old: string | null;
  expected_new: string | null;
  candidate_id: string | null;
  check_artifact_id: string | null;
  state: 'prepared' | 'applied' | 'unknown';
  body: string;
  intent_at: string;
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
            : family === 'local'
              ? [['native-task']]
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
  private readonly workspaceEpoch = randomBytes(16).toString('hex');
  private workspaceRevision = 0n;
  private workspaceDirty = false;
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
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
    if (current > 0 && current < files.length) this.backUpBeforeMigrating(current);
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

  // An existing database gets a consistent copy beside it before any migration runs. The copy
  // just written always stays, with the newest earlier copy from a different version. That keeps
  // the only pre-upgrade copy of another version when upgrades fail and repeat, or when an older
  // database was restored. A fresh database has nothing to lose and takes none.
  private backUpBeforeMigrating(version: number) {
    if (this.path === ':memory:' || this.path === '') return;
    const folder = dirname(this.path);
    try {
      this.writeBackup(folder, version);
    } catch (error) {
      throw new Error(
        `Could not back up the database before upgrading it. Free space in ${folder} and start again.\n${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private writeBackup(folder: string, version: number) {
    const stem = `${basename(this.path)}.before-v${version}`;
    let name = '';
    for (let attempt = 1; ; attempt++) {
      name = attempt === 1 ? `${stem}.sqlite` : `${stem}-${attempt}.sqlite`;
      try {
        // The exclusive create refuses an existing file or a planted link, and fixes the mode
        // before any content is written. SQLite accepts an empty file as the target.
        closeSync(openSync(join(folder, name), 'wx', 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const target = join(folder, name);
    try {
      this.db.prepare('VACUUM INTO ?').run(target);
      chmodSync(target, 0o600);
    } catch (error) {
      try {
        unlinkSync(target);
      } catch {}
      throw error;
    }
    const prefix = `${basename(this.path)}.before-v`;
    const earlier = readdirSync(folder)
      .flatMap((entry) => {
        const match =
          entry !== name && entry.startsWith(prefix)
            ? /^(\d+)(?:-(\d+))?\.sqlite$/.exec(entry.slice(prefix.length))
            : null;
        if (!match) return [];
        try {
          const found = lstatSync(join(folder, entry));
          if (!found.isFile()) return [];
          return [
            {
              name: entry,
              version: Number(match[1]),
              time: found.mtimeMs,
              rank: Number(match[1]) * 1e6 + Number(match[2] ?? 1),
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.time - a.time || b.rank - a.rank);
    const other = earlier.find((entry) => entry.version !== version) ?? earlier[0];
    for (const old of earlier) {
      if (old === other) continue;
      try {
        unlinkSync(join(folder, old.name));
      } catch {}
    }
  }

  transaction<T>(work: () => T): T {
    if (this.transactionEvents) throw new Error('Nested controller transactions are unsupported.');
    this.transactionEvents = [];
    this.workspaceDirty = false;
    let projectionChanged = false;
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
      projectionChanged = this.workspaceDirty;
    } catch (error) {
      if (active) {
        try {
          this.db.exec('ROLLBACK');
        } catch {}
      }
      throw error;
    } finally {
      this.transactionEvents = null;
      this.workspaceDirty = false;
    }
    if (projectionChanged) this.workspaceRevision += 1n;
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

  workspaceStamp(): WorkspaceStamp {
    return { epoch: this.workspaceEpoch, revision: this.workspaceRevision.toString() };
  }

  byIds<T>(kind: EntityKind, ids: ReadonlySet<string>): T[] {
    return [...ids].sort().flatMap((id) => {
      const value = this.get<T>(kind, id);
      return value === undefined ? [] : [value];
    });
  }

  related<T>(kind: EntityKind, field: 'taskId' | 'runId', ids: ReadonlySet<string>): T[] {
    if (ids.size === 0) return [];
    return this.db
      .prepare(
        `SELECT body FROM entities WHERE kind=? AND json_extract(body,'$.${field}') IN (${[...ids].map(() => '?').join(',')}) ORDER BY id`,
      )
      .all(kind, ...ids)
      .map((row) => JSON.parse(row.body as string) as T);
  }

  combinedGroupsForTasks(ids: ReadonlySet<string>): CombinedGroup[] {
    if (ids.size === 0) return [];
    const positions = [...ids].map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT g.* FROM combined_groups g WHERE g.run_id IN (
          SELECT run_id FROM combined_groups WHERE task_id IN (${positions})
          UNION SELECT parent_run_id FROM combined_members WHERE task_id IN (${positions})
        ) ORDER BY g.run_id`,
      )
      .all(...ids, ...ids) as CombinedGroup[];
  }

  put(kind: EntityKind, id: string, revision: number, body: unknown) {
    if (!this.transactionEvents) throw new Error('Entity writes require a transaction.');
    const projection = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return canonicalJson(value);
      const row = value as Record<string, unknown>;
      return canonicalJson(
        kind === 'task'
          ? {
              id: row.id,
              projectId: row.projectId,
              title: row.title,
              outcome: row.outcome,
              criteria: row.criteria,
            }
          : { id: row.id, name: row.name },
      );
    };
    const navigation = kind === 'task' || kind === 'project';
    const previous = navigation ? this.get(kind, id) : undefined;
    const result = this.db
      .prepare(`INSERT INTO entities(id,kind,revision,body) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body WHERE entities.kind=excluded.kind`)
      .run(id, kind, revision, canonicalJson(body));
    if (result.changes !== 1) throw new Error('Entity identity belongs to a different kind.');
    // Live status can change while a list is traversed. Membership and search changes invalidate it.
    if (navigation && (previous === undefined || projection(previous) !== projection(body)))
      this.workspaceDirty = true;
  }

  localControl(): unknown {
    const row = this.db.prepare('SELECT body FROM local_control WHERE singleton=1').get();
    return row ? JSON.parse(row.body as string) : undefined;
  }

  putLocalControl(body: unknown) {
    this.metadataWrite();
    this.db
      .prepare(
        'INSERT INTO local_control(singleton,body) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET body=excluded.body',
      )
      .run(canonicalJson(body));
  }

  localGenerationBlocker(): 'generation-active' | 'generation-unknown' | undefined {
    const intents = this.db
      .prepare(`SELECT i.* FROM launch_intents i JOIN entities r ON r.id=i.route_id
      WHERE i.state!='stopped' AND r.kind='route' AND json_extract(r.body,'$.family')='local'
      AND json_extract(r.body,'$.fake')=0`)
      .all() as LaunchIntent[];
    if (
      intents.some(
        (intent) =>
          ['outcome-unknown', 'interrupted'].includes(intent.state) ||
          this.get<Attempt>('attempt', intent.attempt_id)?.state === 'unknown',
      )
    )
      return 'generation-unknown';
    if (intents.length) return 'generation-active';
  }

  localStartBlocker(): string | undefined {
    this.metadataWrite();
    const row = this.db
      .prepare(
        "SELECT json_extract(body,'$.operation.state') AS state FROM local_control WHERE singleton=1",
      )
      .get();
    if (row?.state)
      return row.state === 'unknown' ? 'local-operation-unknown' : 'local-operation-active';
    return this.localGenerationBlocker();
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
    const budget = MAX_FRAME_BYTES - 4096;
    const rows = this.db
      .prepare(`SELECT length(CAST(body AS BLOB)) AS bytes,
      CASE WHEN length(CAST(body AS BLOB))<=? THEN body END AS body
      FROM events WHERE cursor>? ORDER BY cursor LIMIT 1001`)
      .iterate(budget, BigInt(cursor));
    const events: Event[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (events.length === 1000 || row.body === null || bytes + (row.bytes as number) > budget)
        throw new Error('history-gap');
      bytes += row.bytes as number;
      events.push(EventSchema.parse(JSON.parse(row.body as string)));
    }
    return events;
  }

  intents(): LaunchIntent[] {
    return this.db
      .prepare('SELECT * FROM launch_intents ORDER BY attempt_id')
      .all() as LaunchIntent[];
  }

  googleUsageReader(): GoogleUsageReader {
    return this.db
      .prepare(
        'SELECT authority_revision,last_attempt_at,last_observed_at FROM google_usage_reader WHERE family=?',
      )
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

  combinedGroups(): CombinedGroup[] {
    return this.db
      .prepare('SELECT * FROM combined_groups ORDER BY run_id')
      .all() as CombinedGroup[];
  }

  combinedGroup(taskOrRunId: string): CombinedGroup | undefined {
    return this.db
      .prepare(`SELECT g.* FROM combined_groups g WHERE g.task_id=? OR g.run_id=? OR EXISTS (
      SELECT 1 FROM combined_members m WHERE m.parent_run_id=g.run_id AND (m.task_id=? OR m.run_id=?)
    )`)
      .get(taskOrRunId, taskOrRunId, taskOrRunId, taskOrRunId) as CombinedGroup | undefined;
  }

  combinedMembers(parentRunId: string): CombinedMember[] {
    return this.db
      .prepare('SELECT * FROM combined_members WHERE parent_run_id=? ORDER BY ordinal')
      .all(parentRunId) as CombinedMember[];
  }

  combinedDispatches(parentRunId: string): CombinedDispatch[] {
    const rows = this.db
      .prepare('SELECT * FROM combined_dispatches WHERE parent_run_id=?')
      .all(parentRunId) as CombinedDispatch[];
    return CombinedDispatchPhaseSchema.options.map((phase) => {
      const row = rows.find((value) => value.phase === phase);
      if (!row) throw Error('The combined dispatch reservation is incomplete.');
      return row;
    });
  }

  combinedRefIntents(parentRunId: string): CombinedRefIntent[] {
    return this.db
      .prepare(
        'SELECT * FROM combined_ref_intents WHERE parent_run_id=? ORDER BY generation,operation',
      )
      .all(parentRunId) as CombinedRefIntent[];
  }

  admitCombinedDispatch(parentRunId: string, phase: CombinedDispatch['phase'], attemptId: string) {
    if (!this.transactionEvents) throw Error('Combined admission requires a transaction.');
    const group = this.combinedGroup(parentRunId);
    const attempt = this.get<Attempt>('attempt', attemptId);
    const member = this.combinedMembers(parentRunId).find(
      (value) => phase === `writer-${value.ordinal}`,
    );
    if (
      !group ||
      !attempt ||
      attempt.runId !== (member?.run_id ?? group.run_id) ||
      ['paused', 'stopping', 'stopped', 'blocked', 'unknown', 'accepted'].includes(group.phase)
    )
      throw Error('The combined dispatch has no current owner.');
    const changed = this.db
      .prepare(
        "UPDATE combined_dispatches SET state='running',attempt_id=? WHERE parent_run_id=? AND phase=? AND state='reserved'",
      )
      .run(attemptId, parentRunId, phase);
    if (changed.changes !== 1) throw Error('The combined dispatch slot was already consumed.');
  }

  retryCombinedDispatch(
    parentRunId: string,
    phase: CombinedDispatch['phase'],
    attemptId: string,
    priorAttemptId: string,
  ) {
    if (!this.transactionEvents) throw Error('Combined retry requires a transaction.');
    const group = this.combinedGroup(parentRunId);
    const attempt = this.get<Attempt>('attempt', attemptId);
    const member = this.combinedMembers(parentRunId).find(
      (value) => phase === `writer-${value.ordinal}`,
    );
    if (
      !group ||
      !attempt ||
      attempt.runId !== member?.run_id ||
      group.integration_active ||
      !['writers', 'blocked'].includes(group.phase)
    )
      throw Error('The combined retry has no current owner.');
    const changed = this.db
      .prepare(
        "UPDATE combined_dispatches SET state='running',attempt_id=?,candidate_id=NULL,check_artifact_id=NULL,definition_hash=NULL WHERE parent_run_id=? AND phase=? AND attempt_id=? AND state IN ('failed','stopped')",
      )
      .run(attemptId, parentRunId, phase, priorAttemptId);
    if (changed.changes !== 1) throw Error('The combined retry slot changed.');
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
    const job = review ? ReviewJobSchema.parse(JSON.parse(review.body as string)) : undefined;
    const reviewing =
      job &&
      !job.scripted &&
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

  /**
   * Remove a task with its conversation, chat rows and events. Anything else that still refers to
   * it, such as a run, an approval or a project command, keeps the task: the call changes nothing
   * and returns false.
   */
  removeTask(taskId: string): boolean {
    if (!this.transactionEvents) throw new Error('Task removal requires a transaction.');
    const referenced = this.db
      .prepare("SELECT 1 FROM entities WHERE kind!='task' AND json_extract(body,'$.taskId')=?")
      .get(taskId);
    if (referenced) return false;
    this.db.exec('SAVEPOINT remove_task');
    try {
      for (const statement of [
        'DELETE FROM activity_output WHERE cursor IN (SELECT cursor FROM events WHERE task_id=?)',
        'DELETE FROM events WHERE task_id=?',
        'DELETE FROM conversation_entries WHERE task_id=?',
        'DELETE FROM task_conversations WHERE task_id=?',
        'DELETE FROM chat_turns WHERE task_id=?',
        'DELETE FROM chat_threads WHERE task_id=?',
        "DELETE FROM entities WHERE kind='task' AND id=?",
      ])
        this.db.prepare(statement).run(taskId);
      this.db.exec('RELEASE remove_task');
    } catch (error) {
      this.db.exec('ROLLBACK TO remove_task; RELEASE remove_task');
      // Every other table that names a task holds a foreign key, so SQLite finds the rest.
      if (error instanceof Error && error.message.includes('FOREIGN KEY')) return false;
      throw error;
    }
    // Events this transaction wrote for the task are gone with it, so nobody hears them.
    this.transactionEvents = this.transactionEvents.filter((event) => event.taskId !== taskId);
    this.workspaceDirty = true;
    return true;
  }

  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.db.close();
  }
}
