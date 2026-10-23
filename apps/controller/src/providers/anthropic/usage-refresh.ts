import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnthropicUsageReadingSchema,
  ArtifactSchema,
  type Command,
  CommandIdSchema,
  type CommandResult,
  canonicalJson,
  HashSchema,
  TimestampSchema,
  UsageReaderSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { z } from 'zod';
import type { ArtifactFiles } from '../../artifacts/index.ts';
import { groupAbsent, type Schedule } from '../../host/worker.ts';
import type { Store } from '../../store/index.ts';
import type { NativeProfileResolution } from '../openai/profile.ts';
import { anthropicUsageReaderScope, startAnthropicUsageReader } from './native-usage-reader.ts';

const latest = 'usage-reader:anthropic';
// Twice the bounded native stdout leaves space for the ownership journal around a report.
const maximumRecordBytes = 256 * 1024;
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
});
type Record = z.infer<typeof recordSchema>;
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

  private readonly options: {
    store: Store;
    artifacts: ArtifactFiles;
    home: string;
    now: () => string;
    artifactId: () => string;
    resolve: () => NativeProfileResolution;
    blocked: () => string | undefined;
    changed: () => void;
    schedule?: Schedule;
    reader?: Parameters<typeof startAnthropicUsageReader>[1];
  };
  constructor(options: AnthropicUsageRefresh['options']) {
    this.options = options;
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

  private trusted(scopeHash: string) {
    const value = this.read(`anthropic-usage-trust:${scopeHash}`);
    if (value === null) return false;
    return z
      .strictObject({
        scopeHash: z.literal(scopeHash),
        nativeTrust: z.literal('accepted'),
        acceptedAt: TimestampSchema,
      })
      .safeParse(value).success;
  }

  status() {
    let binding: ReturnType<AnthropicUsageRefresh['binding']> = null;
    try {
      binding = this.binding();
    } catch {}
    const state = this.state();
    return UsageReaderSchema.parse({
      id: 'anthropic-usage-v1',
      family: 'anthropic',
      clientVersion: binding?.clientVersion ?? 'unknown',
      available: !!binding,
      reason: binding ? 'available' : 'client-unavailable',
      readState: state?.state ?? 'idle',
      readReason: state?.reason ?? null,
      operationId: state && state.state !== 'quiescent' ? state.operationId : null,
      lastAttemptAt: state?.attemptedAt ?? null,
      lastObservedAt: null,
      reading: state?.reading ?? null,
      readingScopeHash: state?.readingScopeHash ?? null,
      ...(binding
        ? {
            trust: {
              scopeHash: binding.scopeHash,
              clientSha256: binding.context.executableSha256,
              command: '/usage',
              generationRequest: false,
              policyHooks: 'covered-by-native-client-trust',
              accepted: this.trusted(binding.scopeHash),
            },
          }
        : {}),
    });
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
    const refused = (reason: string): CommandResult => {
      const result: CommandResult = { outcome: 'blocked', reason };
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
    if (!binding) return refused('client-unavailable');
    const previous = this.state();
    const attemptedAt = this.options.now();
    if (previous && Date.parse(attemptedAt) - Date.parse(previous.attemptedAt) < 60000)
      return refused('usage-reader-cooldown');
    const trustKey = `anthropic-usage-trust:${binding.scopeHash}`;
    if (command.payload.trust && command.payload.trust.scopeHash !== binding.scopeHash)
      return refused('native-trust-scope-changed');
    if (!this.trusted(binding.scopeHash)) {
      if (!command.payload.trust) return refused('native-trust-required');
      store.transaction(() =>
        this.write(trustKey, {
          scopeHash: binding.scopeHash,
          nativeTrust: 'accepted',
          acceptedAt: attemptedAt,
        }),
      );
    }
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

  close(): Promise<unknown> | undefined {
    this.closed = true;
    if (!this.active) return;
    this.active.stopped = true;
    this.active.handle?.stop();
    return this.active.done;
  }
}
