import { createHash, randomBytes } from 'node:crypto';
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
  type AcceptanceAttempt,
  AcceptanceAttemptSchema,
  type Artifact,
  ArtifactSchema,
  type Attempt,
  type ChatThread,
  ChatThreadSchema,
  CombinedDispatchPhaseSchema,
  type CombinedRunPreview,
  CommandIdSchema,
  type CommandResult,
  CommandResultSchema,
  type Connection,
  type ConnectionAssignment,
  ConnectionAssignmentSchema,
  ConnectionSchema,
  canonicalJson,
  type DependencyPreparation,
  DependencyPreparationSchema,
  type DesignFinding,
  DesignFindingSchema,
  type DesignPreview,
  DesignPreviewSchema,
  type DesignSystem,
  type DesignSystemRecord,
  DesignSystemRecordSchema,
  DesignSystemSchema,
  type Event,
  EventSchema,
  GoogleAcpSetupSchema,
  HashSchema,
  MAX_FRAME_BYTES,
  type PlanRecipe,
  type PlanRecipeRecord,
  PlanRecipeRecordSchema,
  type PlanRecipeRun,
  PlanRecipeRunSchema,
  PlanRecipeSchema,
  type PlanScheduleRecord,
  PlanScheduleRecordSchema,
  type RemoteEffect,
  RemoteEffectSchema,
  type RepositoryPolicy,
  RepositoryPolicySchema,
  ReviewJobSchema,
  type Route,
  type Run,
  type SliceResult,
  SliceResultSchema,
  type Task,
  TimestampSchema,
  type WorkspaceStamp,
  type WritingRulePreference,
  WritingRulePreferenceSchema,
} from '@crewkite/contracts';
import { assertSchemaCompatibility } from './schema-compatibility.ts';

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
  settlement: GoogleMetadataSettlement | null;
};
/**
 * How a Google metadata row settled. Only `closed` may publish a result. `owner-absent` means
 * recovery proved the recorded group gone; its result stays unknown for good.
 */
export type GoogleMetadataSettlement = 'closed' | 'never-spawned' | 'owner-absent' | 'legacy';
export type LaunchOwnerKind =
  | 'google-metadata'
  | 'native-phase'
  | 'launch'
  | 'chat-turn'
  | 'operation';
/** A versioned, home-keyed digest of one platform observation. Null when capture failed. */
export type LaunchIdentity = Readonly<{
  boot: { source: 'darwin-boot-session-v1' | 'linux-boot-id-v1'; digest: string } | null;
  machine: { source: 'darwin-platform-uuid-v1' | 'linux-machine-id-v1'; digest: string } | null;
}>;
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
    if (path !== ':memory:' && path !== '') assertSchemaCompatibility(path);
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

  /** True while a transaction is open, so a step that opens its own can tell. */
  get inTransaction(): boolean {
    return this.transactionEvents !== null;
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

  /**
   * Whether the person connected this provider on this device at least once. Reads that run on
   * their own, such as the quota read at launch, wait for it, so a provider nobody connected never
   * starts a client. The mark is a row in receipts. Sign out and Disconnect remove it.
   */
  hasConnectedOnce(provider: Route['family']): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM receipts WHERE command_key=?')
      .get(`connected-once:${provider}`);
  }

  /** Sign-out or Disconnect ends it, so the next launch asks again. */
  forgetConnectedOnce(provider: Route['family']) {
    if (!this.transactionEvents) throw new Error('Receipt writes require a transaction.');
    this.db.prepare('DELETE FROM receipts WHERE command_key=?').run(`connected-once:${provider}`);
  }

  /**
   * Whether the person signed this provider out in Settings and has not connected it since. A
   * provider nobody ever connected is not signed out, so the send path can tell the two apart.
   */
  signedOut(provider: Route['family']): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM receipts WHERE command_key=?')
      .get(`signed-out:${provider}`);
  }

  markSignedOut(provider: Route['family']) {
    if (!this.transactionEvents) throw new Error('Receipt writes require a transaction.');
    const key = `signed-out:${provider}`;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO receipts(command_key,request_hash,principal,result) VALUES (?,?,?,?)',
      )
      .run(
        key,
        createHash('sha256').update(key).digest('hex'),
        'local-owner',
        canonicalJson({ outcome: 'applied' }),
      );
  }

  markConnectedOnce(provider: Route['family']) {
    if (!this.transactionEvents) throw new Error('Receipt writes require a transaction.');
    this.db.prepare('DELETE FROM receipts WHERE command_key=?').run(`signed-out:${provider}`);
    const key = `connected-once:${provider}`;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO receipts(command_key,request_hash,principal,result) VALUES (?,?,?,?)',
      )
      .run(
        key,
        createHash('sha256').update(key).digest('hex'),
        'local-owner',
        canonicalJson({ outcome: 'applied' }),
      );
  }

  /**
   * The person's default model for a family, from Settings, or null when they left it to the
   * client. It is a row in receipts, as the credit switch is, with the choice as its next line.
   */
  familyModel(family: string): { family: string; model: string; effort: string } | null {
    const row = this.db
      .prepare('SELECT result FROM receipts WHERE command_key=?')
      .get(`family-model:${family}`) as { result: string } | undefined;
    if (!row) return null;
    try {
      const next = CommandResultSchema.parse(JSON.parse(row.result)).next;
      const value = next ? JSON.parse(next) : null;
      return value && value.family === family && typeof value.model === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  setFamilyModel(family: string, selection: { model: string; effort: string } | null) {
    if (!this.transactionEvents) throw new Error('Receipt writes require a transaction.');
    const key = `family-model:${family}`;
    this.db.prepare('DELETE FROM receipts WHERE command_key=?').run(key);
    if (!selection) return;
    this.db
      .prepare('INSERT INTO receipts(command_key,request_hash,principal,result) VALUES (?,?,?,?)')
      .run(
        key,
        createHash('sha256').update(key).digest('hex'),
        'local-owner',
        canonicalJson(
          CommandResultSchema.parse({
            outcome: 'applied',
            next: JSON.stringify({ family, model: selection.model, effort: selection.effort }),
          }),
        ),
      );
  }

  /** The Allow credit spending switch. A row means on, so a home that never set it reads off. */
  creditSpending(family: 'openai' | 'anthropic'): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM receipts WHERE command_key=?')
      .get(`credit-spending:${family}`);
  }

  setCreditSpending(family: 'openai' | 'anthropic', allowed: boolean) {
    if (!this.transactionEvents) throw new Error('Receipt writes require a transaction.');
    const key = `credit-spending:${family}`;
    if (!allowed) {
      this.db.prepare('DELETE FROM receipts WHERE command_key=?').run(key);
      return;
    }
    this.db
      .prepare(
        'INSERT OR IGNORE INTO receipts(command_key,request_hash,principal,result) VALUES (?,?,?,?)',
      )
      .run(
        key,
        createHash('sha256').update(key).digest('hex'),
        'local-owner',
        canonicalJson({ outcome: 'applied' }),
      );
  }

  /** The webhook address, one receipts row. A home that never set one reads none. */
  webhookUrl(): string | null {
    const row = this.db
      .prepare('SELECT result FROM receipts WHERE command_key=?')
      .get('webhook:url');
    if (!row) return null;
    try {
      const { next } = JSON.parse(row.result as string) as { next?: unknown };
      return typeof next === 'string' && next ? next : null;
    } catch {
      return null;
    }
  }

  /** An empty address clears the setting. The caller has already checked a non-empty one. */
  setWebhookUrl(url: string) {
    if (!this.transactionEvents) throw new Error('Receipt writes require a transaction.');
    const key = 'webhook:url';
    this.db.prepare('DELETE FROM receipts WHERE command_key=?').run(key);
    if (!url) return;
    this.db
      .prepare('INSERT INTO receipts(command_key,request_hash,principal,result) VALUES (?,?,?,?)')
      .run(
        key,
        createHash('sha256').update(key).digest('hex'),
        'local-owner',
        canonicalJson(CommandResultSchema.parse({ outcome: 'applied', next: url })),
      );
  }

  /**
   * Runs work behind a savepoint in the open transaction. A throw undoes the rows it wrote and
   * drops the events it buffered, then goes on up. A rolled-back event's cursor is handed out
   * again, so a client that heard the first one would skip the real event that reuses it.
   */
  savepoint<T>(name: string, work: () => T): T {
    if (!this.transactionEvents) throw new Error('A savepoint requires a transaction.');
    if (!/^[a-z_]+$/.test(name)) throw new Error('A savepoint name is lower case words.');
    // Removing a task swaps the buffer for a filtered copy, so the one that stood here comes back.
    const buffered = this.transactionEvents;
    const kept = buffered.length;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = work();
      if (result instanceof Promise) throw new Error('A savepoint must be synchronous.');
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      buffered.length = kept;
      this.transactionEvents = buffered;
      throw error;
    }
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

  /** Rows still holding the gate. The partial owner index answers this without a scan. */
  heldGoogleMetadata(): GoogleMetadataOperation[] {
    return this.db
      .prepare(
        "SELECT * FROM google_metadata_operations WHERE state <> 'quiescent' ORDER BY started_at,command_id",
      )
      .all() as GoogleMetadataOperation[];
  }

  googleMetadataOperation(commandId: string): GoogleMetadataOperation | undefined {
    return this.db
      .prepare('SELECT * FROM google_metadata_operations WHERE command_id=?')
      .get(commandId) as GoogleMetadataOperation | undefined;
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

  /**
   * Settle one row. A null group means nothing spawned. With a group, `closed` is a normal end of
   * the stream and `owner-absent` is recovery's proof that the group is gone. A settled row is
   * final: the migration's trigger refuses any later change.
   */
  finishGoogleMetadata(
    commandId: string,
    group: number | null,
    at: string,
    settlement: 'closed' | 'owner-absent',
  ) {
    this.metadataWrite();
    if (!['closed', 'owner-absent'].includes(settlement))
      throw new Error('Metadata settlement is invalid.');
    const kind = group === null ? 'never-spawned' : settlement;
    const result = this.db
      .prepare(
        `UPDATE google_metadata_operations SET state='quiescent',finished_at=?,settlement=? WHERE command_id=? AND ((state='intent' AND process_group IS NULL AND ? IS NULL) OR (state IN ('owned','unknown') AND process_group=?))`,
      )
      .run(TimestampSchema.parse(at), kind, commandId, group, group);
    if (result.changes !== 1) throw new Error('Metadata process closure does not match its owner.');
  }

  /**
   * The publication fence. A result publishes only after a normal close, while the authority it
   * started from is still current: the usage reader's revision, or for setup the setup revision
   * with this command still named on it. Call it inside the publishing transaction, before that
   * transaction moves the revision. Setup takes one revision at begin and none until it publishes.
   */
  googleMetadataPublishable(commandId: string) {
    const row = this.db
      .prepare(
        "SELECT kind,authority_revision FROM google_metadata_operations WHERE command_id=? AND state='quiescent' AND settlement='closed'",
      )
      .get(commandId) as { kind: GoogleMetadataKind; authority_revision: number } | undefined;
    if (!row) return false;
    if (row.kind === 'usage')
      return this.googleUsageReader().authority_revision === row.authority_revision;
    const setup = this.googleAcpSetup();
    return (
      !!setup &&
      setup.revision === row.authority_revision &&
      (setup.operationId === commandId || setup.modelRefresh?.commandId === commandId)
    );
  }

  /** Record what this controller observed about the boot and machine before an owner spawns. */
  recordLaunchIdentity(
    kind: LaunchOwnerKind,
    ownerId: string,
    identity: LaunchIdentity,
    at: string,
  ) {
    this.db
      .prepare(
        // A relaunch under the same owner key replaces the old observation, so a stale boot can
        // never later read as proof that a live owner is gone.
        'INSERT INTO launch_identity(owner_kind,owner_id,boot_source,boot_digest,machine_source,machine_digest,recorded_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner_kind,owner_id) DO UPDATE SET boot_source=excluded.boot_source,boot_digest=excluded.boot_digest,machine_source=excluded.machine_source,machine_digest=excluded.machine_digest,recorded_at=excluded.recorded_at',
      )
      .run(
        kind,
        ownerId,
        identity.boot?.source ?? null,
        identity.boot?.digest ?? null,
        identity.machine?.source ?? null,
        identity.machine?.digest ?? null,
        TimestampSchema.parse(at),
      );
  }

  launchIdentity(kind: LaunchOwnerKind, ownerId: string): LaunchIdentity | null {
    const row = this.db
      .prepare('SELECT * FROM launch_identity WHERE owner_kind=? AND owner_id=?')
      .get(kind, ownerId) as
      | {
          boot_source: string | null;
          boot_digest: string | null;
          machine_source: string | null;
          machine_digest: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      boot: row.boot_source
        ? ({ source: row.boot_source, digest: row.boot_digest } as LaunchIdentity['boot'])
        : null,
      machine: row.machine_source
        ? ({ source: row.machine_source, digest: row.machine_digest } as LaunchIdentity['machine'])
        : null,
    };
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

  // Writing rule switches, dependency preparations, checked acceptances, connections, design
  // systems and remote writes. A body is its contract record, checked on the way in and on the way
  // out, so a row that no longer fits its contract fails where it is read. Writes need a
  // transaction.

  private recordWrite() {
    if (!this.transactionEvents) throw new Error('Record writes require a transaction.');
  }

  private bodies<T>(schema: { parse(value: unknown): T }, sql: string, ...params: string[]): T[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => schema.parse(JSON.parse(row.body as string)));
  }

  // Inserts a record or replaces its state and body. The columns in `identity` are fixed once the
  // row exists: an update that names other values changes nothing and throws.
  private upsertRecord(
    table: 'dependency_preparations' | 'acceptance_attempts' | 'design_findings' | 'remote_effects',
    record: { id: string; state: string },
    identity: Record<string, string>,
    at: string,
  ) {
    this.recordWrite();
    const names = Object.keys(identity);
    const result = this.db
      .prepare(
        `INSERT INTO ${table}(id,${names.join(',')},state,body,created_at,updated_at)
        VALUES (?,${names.map(() => '?').join(',')},?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body,updated_at=excluded.updated_at
        WHERE ${names.map((name) => `${table}.${name}=excluded.${name}`).join(' AND ')}`,
      )
      .run(
        record.id,
        ...Object.values(identity),
        record.state,
        canonicalJson(record),
        TimestampSchema.parse(at),
        at,
      );
    if (result.changes !== 1) throw new Error('A record cannot move to another owner or kind.');
  }

  private deleteForTask(
    table:
      | 'dependency_preparations'
      | 'acceptance_attempts'
      | 'connection_assignments'
      | 'design_findings'
      | 'remote_effects',
    taskId: string,
  ) {
    this.recordWrite();
    this.db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(taskId);
  }

  /**
   * The switches the person set. A rule with no row takes its catalogue default. A row may name a
   * rule a later catalogue dropped, so rows come back unchecked and the reader matches them to the
   * catalogue it holds.
   */
  writingRules(): { ruleId: string; enabled: boolean; updatedAt: string }[] {
    return this.db
      .prepare('SELECT rule_id,enabled,updated_at FROM writing_rules ORDER BY rule_id')
      .all()
      .map((row) => ({
        ruleId: row.rule_id as string,
        enabled: row.enabled === 1,
        updatedAt: row.updated_at as string,
      }));
  }

  putWritingRule(preference: WritingRulePreference) {
    this.recordWrite();
    const row = WritingRulePreferenceSchema.parse(preference);
    this.db
      .prepare(
        'INSERT INTO writing_rules(rule_id,enabled,updated_at) VALUES (?,?,?) ON CONFLICT(rule_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at',
      )
      .run(row.ruleId, row.enabled ? 1 : 0, row.updatedAt);
  }

  dependencyPreparation(id: string): DependencyPreparation | undefined {
    return this.bodies(
      DependencyPreparationSchema,
      'SELECT body FROM dependency_preparations WHERE id=?',
      id,
    )[0];
  }

  dependencyPreparations(taskId: string): DependencyPreparation[] {
    return this.bodies(
      DependencyPreparationSchema,
      'SELECT body FROM dependency_preparations WHERE task_id=? ORDER BY created_at,id',
      taskId,
    );
  }

  deleteDependencyPreparations(taskId: string) {
    this.deleteForTask('dependency_preparations', taskId);
  }

  putDependencyPreparation(record: DependencyPreparation, at: string) {
    const value = DependencyPreparationSchema.parse(record);
    this.upsertRecord(
      'dependency_preparations',
      value,
      { task_id: value.taskId, scope: value.scope, scope_key: value.scopeKey },
      at,
    );
  }

  acceptanceAttempt(id: string): AcceptanceAttempt | undefined {
    return this.bodies(
      AcceptanceAttemptSchema,
      'SELECT body FROM acceptance_attempts WHERE id=?',
      id,
    )[0];
  }

  acceptanceAttempts(taskId: string): AcceptanceAttempt[] {
    return this.bodies(
      AcceptanceAttemptSchema,
      'SELECT body FROM acceptance_attempts WHERE task_id=? ORDER BY created_at,id',
      taskId,
    );
  }

  deleteAcceptanceAttempts(taskId: string) {
    this.deleteForTask('acceptance_attempts', taskId);
  }

  /** A second active attempt for the thread throws on the partial unique index. */
  putAcceptanceAttempt(record: AcceptanceAttempt, at: string) {
    const value = AcceptanceAttemptSchema.parse(record);
    this.upsertRecord('acceptance_attempts', value, { task_id: value.taskId }, at);
  }

  connection(connectionId: string): Connection | undefined {
    return this.bodies(
      ConnectionSchema,
      'SELECT body FROM connections WHERE connection_id=?',
      connectionId,
    )[0];
  }

  /** Removes the connection and every assignment to it. */
  deleteConnection(connectionId: string) {
    this.deleteAssignmentsTo(connectionId);
    this.db.prepare('DELETE FROM connections WHERE connection_id=?').run(connectionId);
  }

  connections(): Connection[] {
    return this.bodies(
      ConnectionSchema,
      'SELECT body FROM connections ORDER BY created_at,connection_id',
    );
  }

  /** A connection keeps its family and billing mode. Another mode is another connection. */
  putConnection(record: Connection, at: string) {
    this.recordWrite();
    const value = ConnectionSchema.parse(record);
    const result = this.db
      .prepare(
        `INSERT INTO connections(connection_id,family,billing_mode,body,created_at,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(connection_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at
        WHERE connections.family=excluded.family AND connections.billing_mode=excluded.billing_mode`,
      )
      .run(
        value.connectionId,
        value.family,
        value.billingMode,
        canonicalJson(value),
        TimestampSchema.parse(at),
        at,
      );
    if (result.changes !== 1) throw new Error('A connection cannot change its family or mode.');
  }

  connectionAssignments(taskId: string): (ConnectionAssignment & { assignedAt: string })[] {
    return this.db
      .prepare(
        'SELECT task_id,role,connection_id,assigned_at FROM connection_assignments WHERE task_id=? ORDER BY role',
      )
      .all(taskId)
      .map((row) => ({
        ...ConnectionAssignmentSchema.parse({
          taskId: row.task_id,
          role: row.role,
          connectionId: row.connection_id,
        }),
        assignedAt: row.assigned_at as string,
      }));
  }

  /** One role's assignment, or with no role every assignment the thread holds. */
  deleteConnectionAssignments(taskId: string, role?: ConnectionAssignment['role']) {
    if (role === undefined) return this.deleteForTask('connection_assignments', taskId);
    this.recordWrite();
    this.db
      .prepare('DELETE FROM connection_assignments WHERE task_id=? AND role=?')
      .run(taskId, role);
  }

  /** Every thread's assignment to one connection. */
  deleteAssignmentsTo(connectionId: string) {
    this.recordWrite();
    this.db.prepare('DELETE FROM connection_assignments WHERE connection_id=?').run(connectionId);
  }

  putConnectionAssignment(assignment: ConnectionAssignment, at: string) {
    this.recordWrite();
    const value = ConnectionAssignmentSchema.parse(assignment);
    this.db
      .prepare(
        'INSERT INTO connection_assignments(task_id,role,connection_id,assigned_at) VALUES (?,?,?,?) ON CONFLICT(task_id,role) DO UPDATE SET connection_id=excluded.connection_id,assigned_at=excluded.assigned_at',
      )
      .run(value.taskId, value.role, value.connectionId, TimestampSchema.parse(at));
  }

  designSystem(projectId: string): DesignSystemRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT project_id,path,version,version_hash,delivery,updated_at FROM design_systems WHERE project_id=?',
      )
      .get(projectId);
    return row
      ? DesignSystemRecordSchema.parse({
          projectId: row.project_id,
          path: row.path,
          version: row.version,
          versionHash: row.version_hash,
          delivery: row.delivery === 1,
          updatedAt: row.updated_at,
        })
      : undefined;
  }

  putDesignSystem(record: DesignSystemRecord) {
    this.recordWrite();
    const value = DesignSystemRecordSchema.parse(record);
    this.db
      .prepare(
        `INSERT INTO design_systems(project_id,path,version,version_hash,delivery,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET path=excluded.path,version=excluded.version,
        version_hash=excluded.version_hash,delivery=excluded.delivery,updated_at=excluded.updated_at`,
      )
      .run(
        value.projectId,
        value.path,
        value.version,
        value.versionHash,
        value.delivery ? 1 : 0,
        value.updatedAt,
      );
  }

  /** The preview the project declared for its screenshot check, or null. */
  designPreview(projectId: string): DesignPreview | null {
    const row = this.db
      .prepare('SELECT preview FROM design_systems WHERE project_id=?')
      .get(projectId);
    return typeof row?.preview === 'string'
      ? DesignPreviewSchema.parse(JSON.parse(row.preview))
      : null;
  }

  /** The preview lives on the design system's row, so a project without one keeps none. */
  putDesignPreview(projectId: string, preview: DesignPreview | null) {
    this.recordWrite();
    this.db
      .prepare('UPDATE design_systems SET preview=? WHERE project_id=?')
      .run(preview ? canonicalJson(DesignPreviewSchema.parse(preview)) : null, projectId);
  }

  designSystemVersion(
    projectId: string,
    version: number,
  ): { versionHash: string; system: DesignSystem; savedAt: string } | undefined {
    const row = this.db
      .prepare(
        'SELECT version_hash,body,saved_at FROM design_system_versions WHERE project_id=? AND version=?',
      )
      .get(projectId, version);
    return row
      ? {
          versionHash: row.version_hash as string,
          system: DesignSystemSchema.parse(JSON.parse(row.body as string)),
          savedAt: row.saved_at as string,
        }
      : undefined;
  }

  /** A saved version never changes. Saving the same number again throws. */
  putDesignSystemVersion(
    projectId: string,
    version: number,
    versionHash: string,
    system: DesignSystem,
    at: string,
  ) {
    this.recordWrite();
    this.db
      .prepare(
        'INSERT INTO design_system_versions(project_id,version,version_hash,body,saved_at) VALUES (?,?,?,?,?)',
      )
      .run(
        projectId,
        version,
        HashSchema.parse(versionHash),
        canonicalJson(DesignSystemSchema.parse(system)),
        TimestampSchema.parse(at),
      );
  }

  /** The folder a project keeps its recipe files in, or undefined before the person picked one. */
  recipeFolder(projectId: string): string | undefined {
    const row = this.db
      .prepare('SELECT path FROM recipe_folders WHERE project_id=?')
      .get(projectId);
    return row ? PlanRecipeRecordSchema.shape.path.parse(row.path) : undefined;
  }

  putRecipeFolder(projectId: string, path: string, at: string) {
    this.recordWrite();
    this.db
      .prepare(
        'INSERT INTO recipe_folders(project_id,path,updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET path=excluded.path,updated_at=excluded.updated_at',
      )
      .run(projectId, PlanRecipeRecordSchema.shape.path.parse(path), TimestampSchema.parse(at));
  }

  recipe(id: string): PlanRecipeRecord | undefined {
    return this.recipeRows('WHERE id=?', id)[0];
  }

  /** Every recipe a project saved, by path. */
  recipes(projectId: string): PlanRecipeRecord[] {
    return this.recipeRows('WHERE project_id=? ORDER BY path', projectId);
  }

  private recipeRows(where: string, value: string): PlanRecipeRecord[] {
    return this.db
      .prepare(`SELECT id,project_id,path,version,version_hash,updated_at FROM recipes ${where}`)
      .all(value)
      .map((row) =>
        PlanRecipeRecordSchema.parse({
          id: row.id,
          projectId: row.project_id,
          path: row.path,
          version: row.version,
          versionHash: row.version_hash,
          updatedAt: row.updated_at,
        }),
      );
  }

  putRecipe(record: PlanRecipeRecord) {
    this.recordWrite();
    const value = PlanRecipeRecordSchema.parse(record);
    this.db
      .prepare(
        `INSERT INTO recipes(id,project_id,path,version,version_hash,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET path=excluded.path,version=excluded.version,
        version_hash=excluded.version_hash,updated_at=excluded.updated_at
        WHERE recipes.project_id=excluded.project_id`,
      )
      .run(
        value.id,
        value.projectId,
        value.path,
        value.version,
        value.versionHash,
        value.updatedAt,
      );
  }

  /** Drops the record with its versions and its schedule. Runs keep their rows. */
  deleteRecipe(id: string) {
    this.recordWrite();
    this.db.prepare('DELETE FROM recipe_schedules WHERE recipe_id=?').run(id);
    this.db.prepare('DELETE FROM recipe_versions WHERE recipe_id=?').run(id);
    this.db.prepare('DELETE FROM recipes WHERE id=?').run(id);
  }

  recipeVersion(
    id: string,
    version: number,
  ): { versionHash: string; recipe: PlanRecipe; savedAt: string } | undefined {
    const row = this.db
      .prepare(
        'SELECT version_hash,body,saved_at FROM recipe_versions WHERE recipe_id=? AND version=?',
      )
      .get(id, version);
    return row
      ? {
          versionHash: HashSchema.parse(row.version_hash),
          recipe: PlanRecipeSchema.parse(JSON.parse(row.body as string)),
          savedAt: TimestampSchema.parse(row.saved_at),
        }
      : undefined;
  }

  /** The newest `limit` versions, newest first, and how many older ones there are. */
  recipeVersions(
    id: string,
    limit: number,
  ): { versions: { version: number; versionHash: string; savedAt: string }[]; more: number } {
    const versions = this.db
      .prepare(
        'SELECT version,version_hash,saved_at FROM recipe_versions WHERE recipe_id=? ORDER BY version DESC LIMIT ?',
      )
      .all(id, limit)
      .map((row) => ({
        version: row.version as number,
        versionHash: HashSchema.parse(row.version_hash),
        savedAt: TimestampSchema.parse(row.saved_at),
      }));
    const total = this.db
      .prepare('SELECT count(*) AS total FROM recipe_versions WHERE recipe_id=?')
      .get(id)?.total as number;
    return { versions, more: Math.max(0, total - versions.length) };
  }

  /** A saved version never changes. Saving the same number again throws. */
  putRecipeVersion(
    id: string,
    version: number,
    versionHash: string,
    recipe: PlanRecipe,
    at: string,
  ) {
    this.recordWrite();
    this.db
      .prepare(
        'INSERT INTO recipe_versions(recipe_id,version,version_hash,body,saved_at) VALUES (?,?,?,?,?)',
      )
      .run(
        id,
        version,
        HashSchema.parse(versionHash),
        canonicalJson(PlanRecipeSchema.parse(recipe)),
        TimestampSchema.parse(at),
      );
  }

  /** The schedule armed for a recipe, with what the person approved. */
  recipeSchedule(recipeId: string): PlanScheduleRecord | undefined {
    const row = this.db
      .prepare('SELECT body FROM recipe_schedules WHERE recipe_id=?')
      .get(recipeId);
    return row ? PlanScheduleRecordSchema.parse(JSON.parse(row.body as string)) : undefined;
  }

  /**
   * Schedules by project and recipe path, every one or one project's, and how many lie past
   * `limit` when one is given. A row whose body does not read is left out and named by its
   * recipe in `unreadable`, so one bad row never hides the others.
   */
  recipeSchedules(
    projectId?: string,
    limit?: number,
  ): { schedules: PlanScheduleRecord[]; more: number; unreadable: string[] } {
    const where =
      projectId === undefined
        ? ''
        : 'WHERE s.recipe_id IN (SELECT id FROM recipes WHERE project_id=?)';
    const params = projectId === undefined ? [] : [projectId];
    const schedules: PlanScheduleRecord[] = [];
    const unreadable: string[] = [];
    for (const row of this.db
      .prepare(
        `SELECT s.recipe_id, s.body FROM recipe_schedules s JOIN recipes r ON r.id=s.recipe_id ${where} ORDER BY r.project_id, r.path${limit === undefined ? '' : ' LIMIT ?'}`,
      )
      .all(...params, ...(limit === undefined ? [] : [limit]))) {
      let body: unknown;
      try {
        body = JSON.parse(row.body as string);
      } catch {}
      const parsed = PlanScheduleRecordSchema.safeParse(body);
      if (parsed.success) schedules.push(parsed.data);
      else unreadable.push(String(row.recipe_id));
    }
    const total = this.db
      .prepare(`SELECT count(*) AS total FROM recipe_schedules s ${where}`)
      .get(...params)?.total as number;
    return {
      schedules,
      more: Math.max(0, total - schedules.length - unreadable.length),
      unreadable,
    };
  }

  /** Writes a schedule. The state and the next start move with the body. */
  putRecipeSchedule(schedule: PlanScheduleRecord, at: string) {
    this.recordWrite();
    const value = PlanScheduleRecordSchema.parse(schedule);
    this.db
      .prepare(
        `INSERT INTO recipe_schedules(recipe_id,state,next_at,body,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(recipe_id) DO UPDATE SET state=excluded.state,next_at=excluded.next_at,
        body=excluded.body,updated_at=excluded.updated_at`,
      )
      .run(
        value.recipeId,
        value.state,
        value.nextAt,
        canonicalJson(value),
        TimestampSchema.parse(at),
      );
  }

  deleteRecipeSchedule(recipeId: string) {
    this.recordWrite();
    this.db.prepare('DELETE FROM recipe_schedules WHERE recipe_id=?').run(recipeId);
  }

  /**
   * What a schedule reads about its recipe's runs: whether any is running, how many wait on the
   * person, the newest, and the checklist items that runs still hold. A run holds its item while
   * it runs, waits or is accepted, since Accept does not move the project's HEAD and the item
   * reads unchecked there until the person commits.
   */
  recipeRunTally(recipeId: string): {
    running: boolean;
    waiting: number;
    newest: PlanRecipeRun | undefined;
    items: string[];
  } {
    const tally = this.db
      .prepare(
        "SELECT sum(state='running') AS running, sum(state IN ('asked','ready')) AS waiting FROM recipe_runs WHERE recipe_id=?",
      )
      .get(recipeId);
    const items = this.db
      .prepare(
        "SELECT json_extract(body,'$.item') AS item FROM recipe_runs WHERE recipe_id=? AND state IN ('running','asked','ready','accepted') AND json_extract(body,'$.item') IS NOT NULL",
      )
      .all(recipeId)
      .map((row) => String(row.item));
    return {
      running: Number(tally?.running ?? 0) > 0,
      waiting: Number(tally?.waiting ?? 0),
      newest: this.recipeRuns(recipeId, 1).runs[0],
      items,
    };
  }

  /** True while a run of the recipe is running or waits on a question. */
  recipeRunning(id: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM recipe_runs WHERE recipe_id=? AND state IN ('running','asked') LIMIT 1",
      )
      .get(id);
  }

  /** Records one run of a recipe. The row outlives the thread and the recipe's record. */
  putRecipeRun(run: PlanRecipeRun) {
    this.recordWrite();
    const value = PlanRecipeRunSchema.parse(run);
    this.db
      .prepare(
        `INSERT INTO recipe_runs(id,project_id,recipe_id,task_id,origin,state,body,started_at,ended_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        value.id,
        value.projectId,
        value.recipeId,
        value.taskId,
        value.origin,
        value.state,
        canonicalJson(value),
        value.startedAt,
        value.endedAt,
      );
  }

  /** Writes a run's next state. The state and end columns move with the body. */
  updateRecipeRun(run: PlanRecipeRun) {
    this.recordWrite();
    const value = PlanRecipeRunSchema.parse(run);
    this.db
      .prepare('UPDATE recipe_runs SET state=?,body=?,ended_at=? WHERE id=?')
      .run(value.state, canonicalJson(value), value.endedAt, value.id);
  }

  /** The run a thread belongs to, if it is a recipe run. */
  recipeRunOf(taskId: string): PlanRecipeRun | undefined {
    const row = this.db.prepare('SELECT body FROM recipe_runs WHERE task_id=?').get(taskId);
    return row ? PlanRecipeRunSchema.parse(JSON.parse(row.body as string)) : undefined;
  }

  /** A recipe's newest `limit` runs, newest first, and how many older ones there are. */
  recipeRuns(recipeId: string, limit: number): { runs: PlanRecipeRun[]; more: number } {
    const runs = this.db
      .prepare(
        'SELECT body FROM recipe_runs WHERE recipe_id=? ORDER BY started_at DESC, id DESC LIMIT ?',
      )
      .all(recipeId, limit)
      .map((row) => PlanRecipeRunSchema.parse(JSON.parse(row.body as string)));
    const total = this.db
      .prepare('SELECT count(*) AS total FROM recipe_runs WHERE recipe_id=?')
      .get(recipeId)?.total as number;
    return { runs, more: Math.max(0, total - runs.length) };
  }

  /**
   * The most slices the recipe version behind this thread's run allows, or undefined for a thread
   * that is no recipe run or whose version is gone. A forgotten recipe takes its versions with it.
   */
  recipeSliceCap(taskId: string): number | undefined {
    const run = this.recipeRunOf(taskId);
    return run && this.recipeVersion(run.recipeId, run.version)?.recipe.run.maxSlices;
  }

  /** A project's runs, or one recipe's, newest first, from just older than `before` when given. */
  recipeRunsPage(
    projectId: string,
    recipeId: string | undefined,
    before: { startedAt: string; id: string } | undefined,
    limit: number,
  ): PlanRecipeRun[] {
    return this.newestFirst('recipe_runs', projectId, recipeId, before, limit).map((body) =>
      PlanRecipeRunSchema.parse(body),
    );
  }

  /** Records one step of a plan. The row outlives the thread and the recipe's record. */
  insertSliceResult(record: SliceResult) {
    this.recordWrite();
    const value = SliceResultSchema.parse(record);
    this.db
      .prepare(
        `INSERT INTO slice_results(id,project_id,task_id,anchor_turn_id,recipe_id,slice,step,body,started_at,ended_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        value.id,
        value.projectId,
        value.taskId,
        value.anchorTurnId,
        value.recipeId,
        value.slice,
        value.step,
        canonicalJson(value),
        value.startedAt,
        value.endedAt,
      );
  }

  /** Writes a step's next record, found by its anchor and step. The body and the end move. */
  updateSliceResult(record: SliceResult) {
    this.recordWrite();
    const value = SliceResultSchema.parse(record);
    this.db
      .prepare('UPDATE slice_results SET body=?,ended_at=? WHERE anchor_turn_id=? AND step=?')
      .run(canonicalJson(value), value.endedAt, value.anchorTurnId, value.step);
  }

  /** A thread's records, oldest first. */
  sliceResultsOfTask(taskId: string): SliceResult[] {
    return this.bodies(
      SliceResultSchema,
      'SELECT body FROM slice_results WHERE task_id=? ORDER BY started_at, id',
      taskId,
    );
  }

  /** Every record of a project, or of one recipe in it, oldest first. */
  sliceResults(projectId: string, recipeId?: string): SliceResult[] {
    return recipeId === undefined
      ? this.bodies(
          SliceResultSchema,
          'SELECT body FROM slice_results WHERE project_id=? ORDER BY started_at, id',
          projectId,
        )
      : this.bodies(
          SliceResultSchema,
          'SELECT body FROM slice_results WHERE project_id=? AND recipe_id=? ORDER BY started_at, id',
          projectId,
          recipeId,
        );
  }

  /** A project's records, or one recipe's, newest first, from just older than `before`. */
  sliceResultsPage(
    projectId: string,
    recipeId: string | undefined,
    before: { startedAt: string; id: string } | undefined,
    limit: number,
  ): SliceResult[] {
    return this.newestFirst('slice_results', projectId, recipeId, before, limit).map((body) =>
      SliceResultSchema.parse(body),
    );
  }

  private newestFirst(
    table: 'recipe_runs' | 'slice_results',
    projectId: string,
    recipeId: string | undefined,
    before: { startedAt: string; id: string } | undefined,
    limit: number,
  ): unknown[] {
    const where = ['project_id=?'];
    const params: (string | number)[] = [projectId];
    if (recipeId !== undefined) {
      where.push('recipe_id=?');
      params.push(recipeId);
    }
    if (before) {
      where.push('(started_at<? OR (started_at=? AND id<?))');
      params.push(before.startedAt, before.startedAt, before.id);
    }
    return this.db
      .prepare(
        `SELECT body FROM ${table} WHERE ${where.join(' AND ')} ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map((row) => JSON.parse(row.body as string));
  }

  /** A thread's record as stored, or undefined before the thread holds anything. */
  chatThread(taskId: string): ChatThread | undefined {
    const row = this.db.prepare('SELECT body FROM chat_threads WHERE task_id=?').get(taskId);
    return row ? ChatThreadSchema.parse(JSON.parse(row.body as string)) : undefined;
  }

  designFinding(id: string): DesignFinding | undefined {
    return this.bodies(DesignFindingSchema, 'SELECT body FROM design_findings WHERE id=?', id)[0];
  }

  designFindings(taskId: string): DesignFinding[] {
    return this.bodies(
      DesignFindingSchema,
      'SELECT body FROM design_findings WHERE task_id=? ORDER BY created_at,id',
      taskId,
    );
  }

  deleteDesignFindings(taskId: string) {
    this.deleteForTask('design_findings', taskId);
  }

  putDesignFinding(record: DesignFinding, projectId: string, at: string) {
    const value = DesignFindingSchema.parse(record);
    this.upsertRecord(
      'design_findings',
      value,
      { task_id: value.taskId, project_id: projectId, version_hash: value.versionHash },
      at,
    );
  }

  /** Undefined while the project uses the default policy. */
  repositoryPolicy(projectId: string): { policy: RepositoryPolicy; updatedAt: string } | undefined {
    const row = this.db
      .prepare('SELECT body,updated_at FROM repository_policies WHERE project_id=?')
      .get(projectId);
    return row
      ? {
          policy: RepositoryPolicySchema.parse(JSON.parse(row.body as string)),
          updatedAt: row.updated_at as string,
        }
      : undefined;
  }

  putRepositoryPolicy(projectId: string, policy: RepositoryPolicy, at: string) {
    this.recordWrite();
    this.db
      .prepare(
        'INSERT INTO repository_policies(project_id,body,updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at',
      )
      .run(
        projectId,
        canonicalJson(RepositoryPolicySchema.parse(policy)),
        TimestampSchema.parse(at),
      );
  }

  remoteEffect(id: string): RemoteEffect | undefined {
    return this.bodies(RemoteEffectSchema, 'SELECT body FROM remote_effects WHERE id=?', id)[0];
  }

  remoteEffects(taskId: string): RemoteEffect[] {
    return this.bodies(
      RemoteEffectSchema,
      'SELECT body FROM remote_effects WHERE task_id=? ORDER BY created_at,id',
      taskId,
    );
  }

  deleteRemoteEffects(taskId: string) {
    this.deleteForTask('remote_effects', taskId);
  }

  /** A second in-flight write of the same kind for the thread throws on the partial unique index. */
  putRemoteEffect(record: RemoteEffect, at: string) {
    const value = RemoteEffectSchema.parse(record);
    this.upsertRecord('remote_effects', value, { task_id: value.taskId, kind: value.kind }, at);
  }

  /**
   * The process group a sent write runs in. Null: no process of the write runs, because none
   * started or it was seen to end. 0: a process was being started and its group is not known.
   */
  remoteEffectProcess(id: string): number | null {
    const row = this.db.prepare('SELECT process_group FROM remote_effects WHERE id=?').get(id);
    return typeof row?.process_group === 'number' ? row.process_group : null;
  }

  setRemoteEffectProcess(id: string, group: number | null) {
    this.recordWrite();
    this.db.prepare('UPDATE remote_effects SET process_group=? WHERE id=?').run(group, id);
  }

  /**
   * Whether the thread has an Accept that has not ended or a GitHub write that is confirmed, sent
   * or unknown. Those records are the only proof of what may have reached a branch or a remote,
   * so the thread stays until they settle.
   */
  workInFlight(taskId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM acceptance_attempts WHERE task_id=? AND state IN ('reserved','checking','publishing')
        UNION ALL SELECT 1 FROM remote_effects WHERE task_id=? AND state IN ('confirmed','sent','unknown')
        LIMIT 1`,
      )
      .get(taskId, taskId);
  }

  /**
   * Whether the task has an operation that started and has not ended. Its record is the only proof
   * of what its process may still do, so the task stays with it. A prepared operation never
   * started a process and nothing ends it, so it goes with the task like a settled one.
   */
  unresolvedOperations(taskId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM task_operations WHERE task_id=? AND state IN ('running','stopping','unknown') LIMIT 1",
      )
      .get(taskId);
  }

  /**
   * The artifacts a task's operations name: each definition, output and result. Only the
   * operation names them, so they go with it. Their files may be shared.
   */
  operationArtifacts(taskId: string): Artifact[] {
    return this.db
      .prepare(
        `SELECT e.body FROM entities e JOIN (SELECT value FROM task_operations, json_each(json_array(
          json_extract(body,'$.definition.id'),json_extract(body,'$.stdout.id'),
          json_extract(body,'$.stderr.id'),json_extract(body,'$.result.id')))
          WHERE task_id=? AND value IS NOT NULL) named ON e.id=named.value WHERE e.kind='artifact'`,
      )
      .all(taskId)
      .map((row) => ArtifactSchema.parse(JSON.parse(row.body as string)));
  }

  /**
   * The settled and prepared operations of a task go with it: their artifact records, launch
   * identities, the receipts under their own keys and the rows. The caller removes the files no
   * record still names.
   */
  private deleteOperations(taskId: string) {
    for (const { id } of this.operationArtifacts(taskId))
      this.db.prepare("DELETE FROM entities WHERE kind='artifact' AND id=?").run(id);
    for (const statement of [
      `DELETE FROM launch_identity WHERE owner_kind='operation'
        AND owner_id IN (SELECT operation_id FROM task_operations WHERE task_id=?)`,
      `DELETE FROM receipts WHERE command_key IN
        (SELECT json_extract(body,'$.key') FROM task_operations WHERE task_id=?)`,
      'DELETE FROM task_operations WHERE task_id=?',
    ])
      this.db.prepare(statement).run(taskId);
  }

  /**
   * Remove a task with its conversation, chat rows and events, and with the records only a thread
   * holds: dependency preparations, acceptance attempts, connection assignments, design findings,
   * remote writes and operations with no process. Work in flight or an operation that has not
   * ended keeps the task, and so does anything else that still refers to it, such as a run or an
   * approval: the call changes nothing and returns false.
   */
  removeTask(taskId: string): boolean {
    if (!this.transactionEvents) throw new Error('Task removal requires a transaction.');
    const referenced = this.db
      .prepare("SELECT 1 FROM entities WHERE kind!='task' AND json_extract(body,'$.taskId')=?")
      .get(taskId);
    if (referenced || this.workInFlight(taskId) || this.unresolvedOperations(taskId)) return false;
    this.db.exec('SAVEPOINT remove_task');
    try {
      // Every record left here has settled, so it goes with the thread.
      this.deleteDependencyPreparations(taskId);
      this.deleteAcceptanceAttempts(taskId);
      this.deleteConnectionAssignments(taskId);
      this.deleteDesignFindings(taskId);
      this.deleteRemoteEffects(taskId);
      this.deleteOperations(taskId);
      for (const statement of [
        'DELETE FROM activity_output WHERE cursor IN (SELECT cursor FROM events WHERE task_id=?)',
        'DELETE FROM events WHERE task_id=?',
        'DELETE FROM conversation_entries WHERE task_id=?',
        'DELETE FROM task_conversations WHERE task_id=?',
        'DELETE FROM chat_turns WHERE task_id=?',
        'DELETE FROM chat_hunk_decisions WHERE task_id=?',
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
