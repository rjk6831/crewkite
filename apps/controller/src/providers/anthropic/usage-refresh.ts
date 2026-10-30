import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnthropicUsageReadingSchema,
  ArtifactSchema,
  type ClientVersionStatus,
  type Command,
  CommandIdSchema,
  type CommandResult,
  CommandSchema,
  canonicalJson,
  HashSchema,
  TimestampSchema,
  UsageReaderSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import type { ArtifactFiles } from '../../artifacts/index.ts';
import type { CatalogObservation } from '../../chat/catalog.ts';
import { defaultSchedule, groupAbsent, type Schedule } from '../../host/worker.ts';
import type { Store } from '../../store/index.ts';
import { clientStatusReason } from '../client-versions.ts';
import type { NativeProfileResolution } from '../openai/profile.ts';
import { anthropicUsageReaderScope, startAnthropicUsageReader } from './native-usage-reader.ts';
import { maximumDetail } from './usage-reader.ts';

const latest = 'usage-reader:anthropic';
// Turn readings keep a record of their own. A /usage read in flight saves its whole record when
// it ends, so a turn reading written into that record could be lost.
const latestTurn = 'usage-turn:anthropic';
// Twice the bounded native stdout leaves space for the ownership journal around a report.
const maximumRecordBytes = 256 * 1024;
// The gauge reads on its own this often while the controller runs, so the rail stays near current
// between turns. A minute is the floor, the same as the read cooldown.
const periodicReadMs = 600_000;
const minimumRecheckMs = 60_000;
const recordSchema = z.strictObject({
  operationId: CommandIdSchema,
  requestHash: HashSchema,
  scopeHash: HashSchema,
  state: z.enum(['intent', 'owned', 'quiescent', 'unknown']),
  attemptedAt: TimestampSchema,
  groups: z.array(z.number().int().positive().safe()).max(1),
  reason: z.string().min(1).max(200).nullable(),
  // A reading saved in an earlier shape no longer parses. It is dropped and the next read
  // replaces it, so an old record never blocks the reader.
  reading: AnthropicUsageReadingSchema.nullable().catch(null),
  readingScopeHash: HashSchema.nullable(),
  // What the client wrote during the last read. A record from before this field reads as null.
  detail: z.string().max(maximumDetail).nullable().catch(null),
});
type Record = z.infer<typeof recordSchema>;
const turnSchema = z.strictObject({
  reading: AnthropicUsageReadingSchema,
  readingScopeHash: HashSchema.nullable(),
});
type Current = z.infer<typeof turnSchema>;
type UsageCommand = Extract<Command, { command: 'RefreshAnthropicUsage' | 'StopAnthropicUsage' }>;

/** A manual local command uses the same durable owner as other trusted native operations. */
export class AnthropicUsageRefresh {
  private active?: {
    key: string;
    requestHash: string;
    stopped: boolean;
    handle?: ReturnType<typeof startAnthropicUsageReader>;
    done: Promise<CommandResult>;
  };
  private closed = false;
  private cancelPeriodic?: () => void;

  private readonly options: {
    store: Store;
    artifacts: ArtifactFiles;
    home: string;
    now: () => string;
    artifactId: () => string;
    resolve: () => NativeProfileResolution;
    /** The installed client against its tested build, when the controller finds it by range. */
    client?: () => ClientVersionStatus | undefined;
    blocked: () => string | undefined;
    changed: () => void;
    schedule?: Schedule;
    reader?: Parameters<typeof startAnthropicUsageReader>[1];
  };
  constructor(options: AnthropicUsageRefresh['options']) {
    this.options = options;
    this.armPeriodic();
  }

  /**
   * Arms the next periodic read for ten minutes after the last attempt, or a minute from now when
   * that has passed. A read after a turn moves the next one back, so the two never stack.
   */
  private armPeriodic() {
    if (this.closed) return;
    let delay = periodicReadMs;
    try {
      const previous = this.state();
      if (previous)
        delay = Math.min(
          periodicReadMs,
          Math.max(
            minimumRecheckMs,
            Date.parse(previous.attemptedAt) + periodicReadMs - Date.parse(this.options.now()),
          ),
        );
    } catch {}
    this.cancelPeriodic = (this.options.schedule ?? defaultSchedule)(
      () => this.periodicRead(),
      delay,
    );
  }

  private periodicRead() {
    if (this.closed) return;
    try {
      const previous = this.state();
      const due =
        !previous ||
        Date.parse(this.options.now()) - Date.parse(previous.attemptedAt) >= periodicReadMs;
      // A running turn reports its own rate limit frames, and the read after it settles follows.
      if (due && !this.anthropicTurnRunning())
        // shortcut: the refresh has no command ID helper of its own, so a fresh artifact ID lends
        // its time-ordered suffix. Upgrade: pass the controller's ID helper in the options.
        void this.refreshWhenDue(`cmd_${this.options.artifactId().slice(4)}`);
    } catch {}
    // The read above saved its attempt time before it returned, so the next one lands ten
    // minutes after it.
    this.armPeriodic();
  }

  private anthropicTurnRunning(): boolean {
    return !!this.options.store.db
      .prepare(
        "SELECT 1 FROM chat_turns WHERE json_extract(body,'$.selection.family')='anthropic' AND json_extract(body,'$.state') IN ('queued','running','waiting-permission') LIMIT 1",
      )
      .get();
  }

  private read(key: string): unknown | null {
    const receipt = this.options.store.receipt(key);
    if (!receipt) return null;
    const artifact = ArtifactSchema.parse(receipt.result.entity);
    if (artifact.bytes > maximumRecordBytes || artifact.hash !== receipt.hash)
      throw Error('usage-state-invalid');
    const bytes = this.options.artifacts.read(artifact.hash);
    if (bytes.length !== artifact.bytes) throw Error('usage-state-invalid');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }

  private write(key: string, value: unknown, replace = false) {
    const { store, artifacts } = this.options;
    const bytes = Buffer.from(canonicalJson(value));
    if (bytes.length > maximumRecordBytes) throw Error('usage-state-limit');
    const artifact = ArtifactSchema.parse({
      id: this.options.artifactId(),
      ...artifacts.publish(bytes),
      mediaType: 'application/vnd.crewkite.native+json',
    });
    store.put('artifact', artifact.id, 0, artifact);
    if (replace) store.db.prepare('DELETE FROM receipts WHERE command_key=?').run(key);
    store.saveReceipt(key, artifact.hash, 'local-owner', { outcome: 'applied', entity: artifact });
  }

  private state(): Record | null {
    const value = this.read(latest);
    return value === null ? null : recordSchema.parse(value);
  }

  private save(record: Record, phase: string) {
    this.options.store.transaction(() => {
      const value = recordSchema.parse(record);
      this.write(`anthropic-usage:${record.operationId}:${phase}`, value);
      this.write(latest, value, true);
    });
    this.options.changed();
  }

  private binding() {
    const profile = this.options.resolve();
    if (
      profile.facts.family !== 'anthropic' ||
      !profile.facts.available ||
      !profile.client ||
      !profile.environment?.HOME ||
      !profile.locationHash
    )
      return null;
    const directory = join(this.options.home, 'anthropic-usage');
    const context = {
      operationId: 'usage-trust',
      executable: profile.client.executable,
      executableSha256: profile.client.sha256,
      clientVersion: profile.client.version,
      sessionId: '00000000-0000-4000-8000-000000000000',
      directory,
      home: profile.environment.HOME,
      temporary: join(directory, 'tmp'),
    };
    const scope = anthropicUsageReaderScope(context);
    const scopeHash = hashCanonical({
      scope,
      clientVersion: profile.client.version,
      locationHash: profile.locationHash,
    });
    return { context, scopeHash, clientVersion: profile.client.version };
  }

  /** The last /usage reading and the last turn reading, each under its own time. */
  private parts(state = this.state()): { native: Current | null; turn: Current | null } {
    const native = state?.reading
      ? { reading: state.reading, readingScopeHash: state.readingScopeHash }
      : null;
    // A turn reading saved in an earlier shape is dropped, as the /usage reading is.
    const parsed = turnSchema.safeParse(this.read(latestTurn));
    return { native, turn: parsed.success ? parsed.data : null };
  }

  /**
   * The reading the card shows: the newer of the two, with the windows the other still speaks
   * for. A turn frame names the five-hour and weekly windows, so the per-model windows of the
   * last /usage read stay, and its model and extra-usage switch stay with them. Windows from
   * another client scope are not kept, since the scope label would then cover them too.
   */
  private current(state = this.state()): Current | null {
    const { native, turn } = this.parts(state);
    if (!turn || !native) return turn ?? native;
    const turnNewer = Date.parse(turn.reading.receivedAt) >= Date.parse(native.reading.receivedAt);
    if (turn.readingScopeHash !== native.readingScopeHash) return turnNewer ? turn : native;
    const windows = new Map(native.reading.windows.map((window) => [window.windowId, window]));
    if (turnNewer) for (const window of turn.reading.windows) windows.set(window.windowId, window);
    return {
      reading: {
        ...(turnNewer ? turn.reading : native.reading),
        windows: [...windows.values()].slice(0, 64),
        extraUsage: native.reading.extraUsage,
        model: native.reading.model,
      },
      readingScopeHash: native.readingScopeHash,
    };
  }

  status() {
    let binding: ReturnType<AnthropicUsageRefresh['binding']> = null;
    try {
      binding = this.binding();
    } catch {}
    const state = this.state();
    const current = this.current(state);
    const client = this.client();
    const reader = {
      id: 'anthropic-usage-v1',
      family: 'anthropic',
      clientVersion: binding?.clientVersion ?? client?.version ?? 'unknown',
      available: !!binding,
      reason: binding ? 'available' : client ? clientStatusReason(client) : 'client-unavailable',
      ...(client ? { client } : {}),
      readState: state?.state ?? 'idle',
      // Records from the earlier strict reader say only `protocol`, which tells the person nothing.
      readReason: state?.reason === 'protocol' ? 'unreadable-output' : (state?.reason ?? null),
      operationId: state && state.state !== 'quiescent' ? state.operationId : null,
      lastAttemptAt: state?.attemptedAt ?? null,
      lastObservedAt: null,
      reading: current?.reading ?? null,
      readingScopeHash: current?.readingScopeHash ?? null,
      // The resolved, hash-pinned client is the native trust profile of ADR 0009, so its /usage
      // command needs no consent of its own, as with the Google reader.
      ...(binding
        ? {
            trust: {
              scopeHash: binding.scopeHash,
              clientSha256: binding.context.executableSha256,
              command: '/usage',
              generationRequest: false,
              policyHooks: 'covered-by-native-client-trust',
              accepted: true,
            },
          }
        : {}),
    };
    return UsageReaderSchema.parse({ ...reader, detail: state?.detail ?? null });
  }

  private client(): ClientVersionStatus | undefined {
    try {
      return this.options.client?.();
    } catch {
      return undefined;
    }
  }

  /** The model the client named in its last usage read, or null. The chat catalog starts there. */
  clientModel(): string | null {
    try {
      return this.state()?.reading?.model ?? null;
    } catch {
      // A damaged record must not take the model picker down with it.
      return null;
    }
  }

  blocker() {
    const state = this.state();
    return state?.state === 'unknown'
      ? 'anthropic-metadata-ownership-unknown'
      : state && state.state !== 'quiescent'
        ? 'anthropic-metadata-ownership-pending'
        : undefined;
  }

  recover() {
    const state = this.state();
    if (!state || state.state === 'quiescent') return;
    const known = state.groups.length > 0 && state.groups.every(groupAbsent);
    const recovered = {
      ...state,
      state: known ? ('quiescent' as const) : ('unknown' as const),
      reason: 'usage-read-interrupted',
    };
    this.save(recovered, `recovery-${this.options.artifactId()}`);
    this.complete(state.operationId, {
      outcome: known ? 'blocked' : 'outcome-unknown',
      reason: known ? 'usage-read-interrupted' : 'anthropic-metadata-ownership-unknown',
    });
  }

  private complete(key: string, result: CommandResult) {
    this.options.store.db
      .prepare('UPDATE receipts SET result=? WHERE command_key=?')
      .run(canonicalJson(result), key);
  }

  async execute(command: UsageCommand): Promise<CommandResult> {
    const { store } = this.options;
    const requestHash = hashCanonical(command);
    const prior = store.receipt(command.key);
    if (prior) {
      if (prior.hash !== requestHash || prior.principal !== 'local-owner')
        return { outcome: 'denied', reason: 'idempotency-key-reused' };
      if (this.active?.key === command.key) return this.active.done;
      return prior.result.outcome === 'applied'
        ? { ...prior.result, outcome: 'already-applied' }
        : prior.result;
    }
    if (this.closed) return { outcome: 'blocked', reason: 'controller-closing' };
    if (command.expectedRevision !== 0) return { outcome: 'stale-revision', revision: 0 };
    if (command.command === 'StopAnthropicUsage') {
      if (this.active?.key !== command.payload.operationId)
        return { outcome: 'blocked', reason: 'usage-operation-not-active' };
      const active = this.active;
      store.transaction(() =>
        store.saveReceipt(command.key, requestHash, 'local-owner', {
          outcome: 'outcome-unknown',
          reason: 'anthropic-usage-stop-pending',
        }),
      );
      active.stopped = true;
      active.handle?.stop();
      const stopped = await active.done;
      const result: CommandResult = {
        outcome: stopped.outcome === 'outcome-unknown' ? 'outcome-unknown' : 'applied',
        reason: stopped.outcome === 'outcome-unknown' ? stopped.reason : 'usage-read-stopped',
      };
      this.complete(command.key, result);
      return result;
    }
    const refused = (reason: string, next?: string): CommandResult => {
      const result: CommandResult = { outcome: 'blocked', reason, ...(next ? { next } : {}) };
      store.transaction(() => store.saveReceipt(command.key, requestHash, 'local-owner', result));
      return result;
    };
    if (this.active) return refused('anthropic-metadata-ownership-pending');
    const blocker = this.blocker() ?? this.options.blocked();
    if (blocker) return refused(blocker);
    let binding: ReturnType<AnthropicUsageRefresh['binding']>;
    try {
      binding = this.binding();
    } catch {
      return refused('client-build-mismatch');
    }
    if (!binding) {
      // The card line says which build was found and what to do about it.
      const client = this.client();
      return client && !client.accepted
        ? refused(clientStatusReason(client), client.message)
        : refused('client-unavailable');
    }
    const previous = this.state();
    const attemptedAt = this.options.now();
    if (previous && Date.parse(attemptedAt) - Date.parse(previous.attemptedAt) < 60000)
      return refused('usage-reader-cooldown');
    // A trust payload from an earlier desktop still parses. The resolved client needs none, so the
    // payload changes nothing.
    const record: Record = {
      operationId: command.key,
      requestHash,
      scopeHash: binding.scopeHash,
      state: 'intent',
      attemptedAt,
      groups: [],
      reason: null,
      reading: previous?.reading ?? null,
      readingScopeHash: previous?.readingScopeHash ?? null,
      detail: null,
    };
    store.transaction(() => {
      store.saveReceipt(command.key, requestHash, 'local-owner', {
        outcome: 'outcome-unknown',
        reason: 'anthropic-usage-read-pending',
      });
      this.write(`anthropic-usage:${record.operationId}:prepared`, record);
      this.write(latest, record, true);
    });
    const completion = Promise.withResolvers<CommandResult>();
    const active = {
      key: command.key,
      requestHash,
      stopped: false,
      done: completion.promise,
      handle: undefined as ReturnType<typeof startAnthropicUsageReader> | undefined,
    };
    this.active = active;
    void (async () => {
      let result: CommandResult;
      let invoked = false;
      const current = () => {
        if (
          this.closed ||
          active.stopped ||
          this.active !== active ||
          this.binding()?.scopeHash !== binding.scopeHash ||
          this.state()?.operationId !== record.operationId ||
          this.options.blocked()
        )
          throw Error('usage-read-revoked');
      };
      try {
        this.options.changed();
        current();
        mkdirSync(binding.context.temporary, { recursive: true, mode: 0o700 });
        const context = { ...binding.context, operationId: command.key, sessionId: randomUUID() };
        const scope = anthropicUsageReaderScope(context);
        invoked = true;
        const handle = startAnthropicUsageReader(
          {
            ...context,
            trust: { nativeTrust: 'accepted', scopeHash: scope.scopeHash },
            lifecycle: {
              intent: (launch) => {
                current();
                this.save(record, `intent-${hashCanonical(launch)}`);
              },
              owned: (group) => {
                current();
                record.groups = [group];
                record.state = 'owned';
                this.save(record, 'owned');
              },
              quiescent: () => {},
            },
          },
          { ...this.options.reader, schedule: this.options.schedule, receivedAt: this.options.now },
        );
        active.handle = handle;
        if (active.stopped || this.closed) handle.stop();
        const outcome = await handle.result;
        const known = outcome.quiescent && record.groups.length > 0;
        const matching = this.binding()?.scopeHash === binding.scopeHash;
        record.state = known ? 'quiescent' : 'unknown';
        record.reason = !known
          ? 'ownership-unknown'
          : active.stopped || this.closed
            ? 'stopped'
            : !matching
              ? 'native-trust-scope-changed'
              : (outcome.reason ??
                (outcome.reading?.status === 'reported' ? 'reported' : 'usage-unavailable'));
        record.detail = outcome.detail;
        if (known && !active.stopped && !this.closed && matching && outcome.reading) {
          record.reading = AnthropicUsageReadingSchema.parse(outcome.reading);
          record.readingScopeHash = binding.scopeHash;
        }
        this.save(record, 'complete');
        result = {
          outcome: !known
            ? 'outcome-unknown'
            : record.reason === 'reported'
              ? 'applied'
              : 'blocked',
          reason: !known ? 'anthropic-metadata-ownership-unknown' : record.reason,
        };
      } catch {
        active.handle?.stop();
        let known = !invoked;
        if (active.handle)
          known = (await active.handle.result).quiescent && record.groups.length > 0;
        record.state = known ? 'quiescent' : 'unknown';
        record.reason = 'usage-read-failed';
        this.save(record, 'failed');
        result = {
          outcome: known ? 'blocked' : 'outcome-unknown',
          reason: known ? 'usage-read-failed' : 'anthropic-metadata-ownership-unknown',
        };
      }
      this.complete(command.key, result);
      if (this.active === active) this.active = undefined;
      completion.resolve(result);
    })().catch(async () => {
      active.handle?.stop();
      if (active.handle) await active.handle.result.catch(() => {});
      if (this.active === active) this.active = undefined;
      completion.resolve({ outcome: 'outcome-unknown', reason: 'anthropic-usage-storage-failed' });
    });
    return active.done;
  }

  /**
   * The gauge reads on its own when the controller starts, after each chat turn settles, since a
   * turn spent some allowance, and every ten minutes while no Anthropic turn runs. It reads only
   * when the client resolves, the last read is more than a minute old and no other read runs.
   * Anything else skips it without a receipt.
   */
  refreshWhenDue(key: string): Promise<unknown> | undefined {
    try {
      if (this.closed || this.active || this.blocker() || this.options.blocked()) return;
      const binding = this.binding();
      if (!binding) return;
      const previous = this.state();
      if (previous && Date.parse(this.options.now()) - Date.parse(previous.attemptedAt) <= 60_000)
        return;
      const command = CommandSchema.parse({
        protocol: 1,
        key,
        actor: { id: 'controller', kind: 'controller' },
        command: 'RefreshAnthropicUsage',
        expectedRevision: 0,
        payload: {},
      }) as UsageCommand;
      return this.execute(command).catch(() => undefined);
    } catch {
      return;
    }
  }

  /**
   * A turn's rate limit frame is kept on its own, with only the windows it named, so each window
   * carries the time it was read. A tool-heavy turn sends dozens of frames that mostly repeat
   * the last one; a repeat inside a minute writes nothing.
   */
  recordTurnReading(value: z.input<typeof AnthropicUsageReadingSchema>) {
    if (this.closed) return;
    const reading = AnthropicUsageReadingSchema.parse(value);
    let scopeHash: string | null = null;
    try {
      scopeHash = this.binding()?.scopeHash ?? null;
    } catch {}
    const previous = this.parts().turn;
    if (
      previous &&
      previous.readingScopeHash === scopeHash &&
      Date.parse(reading.receivedAt) - Date.parse(previous.reading.receivedAt) < 60_000 &&
      canonicalJson(previous.reading.windows) === canonicalJson(reading.windows)
    )
      return;
    const current = turnSchema.parse({ reading, readingScopeHash: scopeHash });
    this.options.store.transaction(() => this.write(latestTurn, current, true));
    this.options.changed();
  }

  /**
   * The current reading as catalog windows, so the rail and the composer see the same allowance
   * as the Settings card. The reading has no route, so these carry no route ID. A per-model
   * window (weekly-opus) is scoped to its model and the others to the provider.
   */
  catalogWindows(): { family: 'anthropic'; observation: CatalogObservation }[] {
    let parts: ReturnType<AnthropicUsageRefresh['parts']>;
    try {
      parts = this.parts();
    } catch {
      return [];
    }
    const { native, turn } = parts;
    // Each window keeps the time of the read that produced it, so a per-model percent from a
    // /usage read days ago does not pass as fresh because a turn frame came in today.
    const sources = [native, turn].filter(
      (part): part is Current =>
        part?.reading.status === 'reported' &&
        part.readingScopeHash === (native ?? turn)?.readingScopeHash,
    );
    const windows = new Map<string, CatalogObservation>();
    for (const part of sources)
      for (const window of part.reading.windows) {
        const seen = windows.get(window.windowId);
        if (seen && Date.parse(seen.observedAt) > Date.parse(part.reading.receivedAt)) continue;
        windows.set(window.windowId, {
          windowId: window.windowId,
          remaining: window.remaining,
          resetsAt: window.resetsAt,
          observedAt: part.reading.receivedAt,
          semantics: { scope: window.windowId.startsWith('weekly-') ? 'model' : 'provider' },
        });
      }
    return [...windows.values()].map((observation) => ({ family: 'anthropic', observation }));
  }

  close(): Promise<unknown> | undefined {
    this.closed = true;
    this.cancelPeriodic?.();
    if (!this.active) return;
    this.active.stopped = true;
    this.active.handle?.stop();
    return this.active.done;
  }
}
