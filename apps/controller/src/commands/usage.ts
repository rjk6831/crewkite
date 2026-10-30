import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type Artifact,
  type Attempt,
  type Command,
  type CommandResult,
  CommandResultSchema,
  CommandSchema,
  canonicalJson,
  NativeProfileSchema,
  type Observation,
  ObservationSchema,
  type Route,
  RouteSchema,
  type Task,
  UsageReaderSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { z } from 'zod';
import { AnthropicUsageRefresh } from '../providers/anthropic/usage-refresh.ts';
import { type ClientFamily, forgetClientReads } from '../providers/client-versions.ts';
import {
  GoogleWriterError,
  googleUsageObservations,
  startGoogleUsage,
} from '../providers/google/native-writer.ts';
import {
  type GoogleUsageClientResolution,
  googleUsageDescriptor,
  resolveGoogleUsageClient,
} from '../providers/google/profile.ts';
import { OpenAiDiscovery } from '../providers/openai/discovery.ts';
import { startNativeSession } from '../providers/openai/native-discovery.ts';
import {
  type NativeProfileResolution,
  unavailableNativeProfile,
} from '../providers/openai/profile.ts';
import { deriveWindow } from '../usage/index.ts';
import type { Controller } from './controller.ts';
import { googleTermsAcknowledged } from './google-terms.ts';
import {
  OpenAiUsageReadSchema,
  ProviderUsageBatchSchema,
  ProviderUsageDraftSchema,
} from './schemas.ts';

// The OpenAI reader's client, resolved before an ObserveUsage command opens its transaction. A
// version read can take seconds, and it never runs while the database is locked.
const preparedUsage = new WeakMap<
  Controller,
  { key: string; openai?: ReturnType<UsageCommands['openAiUsageInputs']> }
>();

// Usage readers and the provider usage observations that admission reads.
export class UsageCommands {
  anthropicUsage(this: Controller) {
    this.anthropicUsageRuntime ??= new AnthropicUsageRefresh({
      store: this.store,
      artifacts: this.artifacts,
      home: this.home,
      now: this.now,
      artifactId: () => this.id('art'),
      resolve: () => this.anthropicChatProfile(),
      client: () =>
        this.options.chatClients?.anthropic ? this.chatClientFor('anthropic').status : undefined,
      blocked: () => {
        const connection = this.nativeConnections().status();
        if (connection.state === 'unknown') return 'anthropic-connection-ownership-unknown';
        if (connection.state === 'checking') return 'anthropic-connection-ownership-pending';
        if (connection.state === 'signed-out') return 'anthropic-sign-in-required';
        if (
          this.store.intents().some((intent) => {
            if (intent.state === 'stopped') return false;
            const route = this.store.get<Route>('route', intent.route_id);
            return !route || (route.family === 'anthropic' && !route.fake);
          })
        )
          return 'anthropic-task-active';
      },
      // The status resolves the client, so it is read before the event's transaction opens.
      changed: () => {
        const status = this.anthropicUsage().status();
        this.store.transaction(() => this.event('usage.reader-updated', null, 0, status));
      },
      schedule: this.options.schedule,
      reader: this.options.anthropicUsageReader,
    });
    return this.anthropicUsageRuntime;
  }

  /**
   * The Anthropic client the quota reader and the sign-in check run: the chat client found by
   * version range, or the pinned profile when the controller has no chat resolver. A build the
   * range refuses stays refused here too.
   */
  anthropicChatProfile(this: Controller): NativeProfileResolution {
    const pinned = this.profileFor('anthropic-file-v1');
    if (!this.options.chatClients?.anthropic) return pinned;
    return (
      this.chatClientFor('anthropic').profile ?? {
        facts: NativeProfileSchema.parse({
          ...pinned.facts,
          available: false,
          reason: 'client-unavailable',
        }),
      }
    );
  }

  googleUsageReader(this: Controller) {
    const reader = this.store.googleUsageReader();
    return UsageReaderSchema.parse({
      id: googleUsageDescriptor.id,
      family: 'google',
      clientVersion: this.usageResolution.status?.version ?? googleUsageDescriptor.clientVersion,
      available: this.usageResolution.available,
      reason: this.usageResolution.reason,
      ...(this.usageResolution.status ? { client: this.usageResolution.status } : {}),
      lastObservedAt: reader.last_observed_at,
      lastAttemptAt: reader.last_attempt_at,
    });
  }

  /**
   * Check again on a provider card: forget what was read about the family's client files and
   * resolve them afresh. Nothing launches beyond each client's own version flag.
   */
  checkProviderClient(this: Controller, family: ClientFamily): CommandResult {
    forgetClientReads(family);
    try {
      if (family === 'google') {
        this.usageResolution = this.options.googleUsageClient?.() ?? resolveGoogleUsageClient();
        const status = this.usageResolution.status;
        return status
          ? { outcome: 'applied', next: status.message }
          : { outcome: 'applied', reason: this.usageResolution.reason };
      }
      if (family === 'openai') this.options.openAiUsageClient?.();
      return { outcome: 'applied', next: this.chatClientFor(family).status.message };
    } catch {
      return { outcome: 'blocked', reason: 'client-check-failed' };
    }
  }

  /** The OpenAI reader's profile and client status. This is the part that resolves. */
  openAiUsageInputs(this: Controller) {
    let resolved: NativeProfileResolution | undefined;
    try {
      resolved = this.options.openAiUsageClient?.();
    } catch {}
    return {
      profile: resolved?.facts.family === 'openai' ? resolved : unavailableNativeProfile(),
      client: this.options.chatClients?.openai ? this.chatClientFor('openai').status : undefined,
    };
  }

  openAiUsageReader(this: Controller, inputs = this.openAiUsageInputs()) {
    const profile = inputs.profile;
    const facts = profile.facts;
    if (facts.family !== 'openai') throw Error('The usage reader requires an OpenAI profile.');
    const state = this.openAiUsageState();
    return UsageReaderSchema.parse({
      id: 'openai-usage-v1',
      family: 'openai',
      clientVersion: facts.clientVersion,
      available: profile.facts.available,
      reason: profile.facts.available ? 'available' : profile.facts.reason,
      ...(inputs.client ? { client: inputs.client } : {}),
      readState: state?.state ?? 'idle',
      readReason: state?.reason ?? null,
      lastRequest: state?.lastRequest ?? null,
      lastAttemptAt: state?.attemptedAt ?? null,
      lastObservedAt: state?.lastObservedAt ?? null,
    });
  }

  refreshUsage(this: Controller, trigger: 'start' | 'connect' | 'interval'): Promise<void> {
    return Promise.allSettled([
      this.refreshGoogleUsage(trigger),
      this.refreshOpenAiUsage(trigger),
      // The Anthropic gauge reads once at start. Turns and the card's Refresh read it after that.
      trigger === 'start' ? this.anthropicUsage().refreshWhenDue(this.id('cmd')) : undefined,
    ]).then(() => {});
  }

  openAiUsageState(this: Controller) {
    if (!this.store.receipt('usage-reader:openai')) return null;
    return OpenAiUsageReadSchema.parse(this.nativeRecord('usage-reader:openai', 4096).value);
  }

  saveOpenAiUsage(this: Controller, value: z.infer<typeof OpenAiUsageReadSchema>) {
    const artifact = this.nativeArtifact(OpenAiUsageReadSchema.parse(value));
    this.store.db.prepare('DELETE FROM receipts WHERE command_key=?').run('usage-reader:openai');
    this.store.saveReceipt('usage-reader:openai', artifact.hash, 'local-owner', {
      outcome: 'applied',
      entity: artifact,
    });
  }

  openAiUsageBlocker(this: Controller, routeId: string | Route) {
    const route = typeof routeId === 'string' ? this.store.get<Route>('route', routeId) : routeId;
    if (route?.family === 'anthropic' && !route.fake) return this.anthropicUsage().blocker();
    if (route?.family !== 'openai' || route.fake) return;
    try {
      const state = this.openAiUsageState();
      if (state?.state === 'unknown') return 'openai-metadata-ownership-unknown';
      if (state && state.state !== 'quiescent') return 'openai-metadata-ownership-pending';
    } catch {
      return 'openai-metadata-ownership-unknown';
    }
  }

  refreshOpenAiUsage(
    this: Controller,
    trigger: 'start' | 'connect' | 'interval' | 'manual',
    commandId?: string,
  ): Promise<void> | undefined {
    try {
      if (this.closed || !this.options.openAiUsageClient) return;
      if (this.openAiUsageRead) return this.openAiUsageRead.done;
      const profile = this.options.openAiUsageClient();
      if (
        !profile.facts.available ||
        profile.facts.family !== 'openai' ||
        !profile.client ||
        !profile.environment ||
        !profile.locationHash
      )
        return;
      const client = profile.client;
      const environment = profile.environment;
      const profileHash = hashCanonical({
        facts: profile.facts,
        client: profile.client,
        locationHash: profile.locationHash,
      });
      const attemptedAt = this.now();
      const previous = this.openAiUsageState();
      if (
        previous &&
        (previous.state !== 'quiescent' ||
          Date.parse(attemptedAt) - Date.parse(previous.attemptedAt) <
            (trigger === 'interval' ? 270000 : 60000))
      )
        return;
      if (
        this.store.intents().some((intent) => {
          if (intent.state === 'stopped') return false;
          const route = this.store.get<Route>('route', intent.route_id);
          return !route || (route.family === 'openai' && !route.fake);
        })
      )
        return;
      const readerRoute = this.store.transaction(() => {
        const receipt = this.store.receipt('usage-route:openai');
        if (receipt) {
          const route = RouteSchema.parse(this.nativeRecord('usage-route:openai', 4096).value);
          if (
            hashCanonical(this.store.get<Route>('route', route.id)) !== hashCanonical(route) ||
            route.family !== 'openai' ||
            route.fake ||
            route.qualified
          )
            throw Error('usage-route-changed');
          return route;
        } else {
          const route = RouteSchema.parse({
            id: this.id('rte'),
            family: 'openai',
            displayName: 'OpenAI usage reader',
            model: 'unknown',
            effort: { requested: 'unknown', effective: 'unknown', supported: [] },
            billing: 'included',
            qualified: false,
            fake: false,
          });
          this.store.put('route', route.id, 0, route);
          const artifact = this.nativeArtifact(route);
          this.store.saveReceipt('usage-route:openai', artifact.hash, 'local-owner', {
            outcome: 'applied',
            entity: artifact,
          });
          return route;
        }
      });
      if (trigger === 'connect') {
        const windows = this.store
          .list<Observation>('window')
          .filter((value) => value.routeId === readerRoute.id && value.source === 'client');
        if (
          windows.length &&
          windows.every(
            (value) =>
              value.confidence === 'reported' &&
              value.remaining !== null &&
              deriveWindow(value, { nowMs: Date.parse(attemptedAt), maxAgeMs: 300000 }).state ===
                'fresh',
          )
        )
          return;
      }
      const state = OpenAiUsageReadSchema.parse({
        id: this.id('cmd'),
        state: 'intent',
        attemptedAt,
        profileHash,
        groups: [],
        reason: null,
        lastRequest: null,
        lastObservedAt: previous?.lastObservedAt ?? null,
        ...(commandId ? { commandId } : {}),
      });
      this.store.transaction(() => this.saveOpenAiUsage(state));
      const completion = Promise.withResolvers<void>();
      const runtime = {
        id: state.id,
        stopped: false,
        done: completion.promise,
        handle: undefined as { stop: () => void } | undefined,
      };
      this.openAiUsageRead = runtime;
      void (async () => {
        let invoked = false;
        const reports: { value: unknown; prior: ReadonlyMap<string, Observation> }[] = [];
        let reportBytes = 0;
        const current = () => {
          const saved = this.openAiUsageState();
          // This runs inside transactions too, so it takes only a version already read. A client
          // file that changed since then reads as unreadable and revokes the read.
          const currentProfile = this.options.openAiUsageClient?.({ cachedOnly: true });
          if (
            this.closed ||
            runtime.stopped ||
            this.openAiUsageRead !== runtime ||
            saved?.id !== state.id ||
            saved.profileHash !== state.profileHash ||
            saved.attemptedAt !== state.attemptedAt ||
            hashCanonical(saved.groups) !== hashCanonical(state.groups) ||
            !['intent', 'owned'].includes(saved.state) ||
            !currentProfile ||
            hashCanonical({
              facts: currentProfile.facts,
              client: currentProfile.client,
              locationHash: currentProfile.locationHash,
            }) !== profileHash ||
            hashCanonical(this.store.get<Route>('route', readerRoute.id)) !==
              hashCanonical(readerRoute)
          )
            throw Error('usage-read-revoked');
        };
        try {
          current();
          const directory = mkdtempSync(join(this.home, 'openai-usage-'));
          const onUsage = this.providerUsageAdapter(readerRoute.id, (value, prior) => {
            current();
            const bytes = Buffer.byteLength(canonicalJson({ value, prior: [...prior.values()] }));
            if (reports.length >= 32 || reportBytes + bytes > 32768) return false;
            reports.push({ value, prior: new Map(prior) });
            reportBytes += bytes;
            return true;
          });
          const options = {
            timeoutMs: 20000,
            schedule: this.options.schedule,
            spawn: this.options.openAiUsageSpawn,
            lifecycle: {
              beforePhase: () => current(),
              owned: (_phase: unknown, group: number) => {
                this.store.transaction(() => {
                  current();
                  state.groups.push(group);
                  state.state = 'owned';
                  this.saveOpenAiUsage(state);
                });
              },
              quiescent: () => {},
            },
          };
          const deadline = performance.now() + options.timeoutMs;
          const wallDeadline = Date.parse(this.now()) + options.timeoutMs;
          invoked = true;
          const handle = startNativeSession(
            {
              ...client,
              directory,
              repositoryRoot: this.home,
              environment,
            },
            options,
            (remaining) =>
              new OpenAiDiscovery({
                now: () => performance.now(),
                timeoutMs: remaining,
                readConfiguration: true,
                configurationDirectory: directory,
                onUsage,
              }),
          );
          runtime.handle = handle;
          if (runtime.stopped || this.closed) handle.stop();
          const outcome = await handle.result;
          const known = outcome.quiescent && state.groups.length > 0;
          // Usage follows the supported account check. A later protocol refusal
          // cannot grant authority or erase that validated read. Cancellation revokes it.
          let published = false;
          if (
            known &&
            performance.now() < deadline &&
            Date.parse(this.now()) < wallDeadline &&
            (outcome.reason === null || outcome.reason === 'protocol')
          ) {
            const publicationCurrent = () => {
              current();
              if (performance.now() >= deadline || Date.parse(this.now()) >= wallDeadline)
                throw Error('usage-read-deadline');
            };
            for (const report of reports)
              published =
                this.storeProviderUsage(
                  readerRoute.id,
                  report.value,
                  publicationCurrent,
                  report.prior,
                ) || published;
          }
          this.store.transaction(() =>
            this.saveOpenAiUsage({
              ...state,
              state: known ? 'quiescent' : 'unknown',
              reason: !known
                ? 'ownership-unknown'
                : published
                  ? 'observed'
                  : (outcome.reason ?? 'no-observations'),
              lastRequest: outcome.lastRequest,
              lastObservedAt: published ? this.now() : state.lastObservedAt,
            }),
          );
        } catch {
          try {
            this.store.transaction(() =>
              this.saveOpenAiUsage({
                ...state,
                state: invoked ? 'unknown' : 'quiescent',
                reason: 'read-failed',
              }),
            );
          } catch {}
        } finally {
          if (this.openAiUsageRead === runtime) this.openAiUsageRead = undefined;
          completion.resolve();
        }
      })();
      return runtime.done;
    } catch {
      return;
    }
  }

  refreshGoogleUsage(
    this: Controller,
    trigger: 'start' | 'connect' | 'interval',
  ): Promise<CommandResult> | undefined {
    try {
      if (this.closed || this.acpStart) return;
      if (!googleTermsAcknowledged(this.store)) return;
      if (this.usageRead) return this.usageRead.promise;
      const reader = this.store.googleUsageReader();
      const nowMs = Date.parse(this.now());
      if (
        reader.last_attempt_at &&
        nowMs - Date.parse(reader.last_attempt_at) < (trigger === 'interval' ? 270000 : 60000)
      )
        return;
      if (trigger === 'connect') {
        const routes = this.store
          .list<Route>('route')
          .filter((route) => route.family === 'google' && !route.fake);
        const windows = this.store.list<Observation>('window');
        if (
          reader.last_observed_at &&
          routes.length &&
          routes.every((route) => {
            const observations = windows.filter((window) => window.routeId === route.id);
            return (
              observations.length &&
              observations.every(
                (window) =>
                  deriveWindow(window, { nowMs, maxAgeMs: 300000 }).state === 'fresh' &&
                  window.remaining !== null &&
                  window.source === 'client' &&
                  window.confidence === 'reported',
              )
            );
          })
        )
          return;
      }
      if (this.store.transaction(() => this.store.googleOperationBlocker())) return;
      try {
        this.usageResolution = this.options.googleUsageClient?.() ?? resolveGoogleUsageClient();
      } catch {
        this.usageResolution = { available: false, reason: 'client-unavailable' };
      }
      if (!this.usageResolution.available) return;
      const command = CommandSchema.parse({
        protocol: 1,
        key: this.id('cmd'),
        actor: { id: 'controller', kind: 'controller' },
        command: 'ObserveUsage',
        expectedRevision: 0,
        payload: { family: 'google' },
      }) as Extract<Command, { command: 'ObserveUsage' }>;
      return this.observeUsageCommand(command, 'local-owner');
    } catch {
      return;
    }
  }

  observeUsageCommand(
    this: Controller,
    command: Extract<Command, { command: 'ObserveUsage' }>,
    principal: string,
  ): Promise<CommandResult> {
    if (command.payload.family === 'google' && !googleTermsAcknowledged(this.store))
      return Promise.resolve({
        outcome: 'blocked',
        reason: 'google-terms-not-acknowledged',
        next: 'Acknowledge the Google terms in Settings > Google before reading Google usage.',
      });
    // Resolve the client now. observeUsage runs inside the command's transaction.
    if (command.payload.family === 'openai')
      preparedUsage.set(this, { key: command.key, openai: this.openAiUsageInputs() });
    else
      try {
        this.usageResolution = this.options.googleUsageClient?.() ?? resolveGoogleUsageClient();
      } catch {
        this.usageResolution = { available: false, reason: 'client-unavailable' };
      }
    const pendingReason =
      command.payload.family === 'openai' ? 'openai-usage-read-pending' : 'usage-read-pending';
    const prior = this.usageRead;
    const hash = hashCanonical(command);
    if (prior?.key === command.key)
      return prior.hash === hash && prior.principal === principal
        ? prior.promise
        : Promise.resolve({ outcome: 'denied', reason: 'idempotency-key-reused' });
    if (prior || this.store.receipt(command.key)) {
      let result = this.commitCommand(command, principal);
      if (result.outcome === 'outcome-unknown' && result.reason === pendingReason) {
        result = {
          outcome: 'outcome-unknown',
          reason:
            command.payload.family === 'openai'
              ? 'openai-metadata-ownership-unknown'
              : 'google-ownership-unknown',
        };
        this.store.transaction(() => this.finishMetadataReceipt(command.key, result));
      }
      return Promise.resolve(result);
    }
    const completion = Promise.withResolvers<CommandResult>();
    const pending = {
      key: command.key,
      hash,
      principal,
      abort: new AbortController(),
      promise: completion.promise,
      resolve: completion.resolve,
    };
    this.usageRead = pending;
    try {
      const result = this.commitCommand(command, principal);
      if (result.outcome !== 'outcome-unknown' || result.reason !== pendingReason)
        completion.resolve(result);
    } catch (error) {
      if (this.usageRead === pending) this.usageRead = undefined;
      throw error;
    }
    return pending.promise.finally(() => {
      if (this.usageRead === pending) this.usageRead = undefined;
    });
  }

  observeUsage(
    this: Controller,
    command: Extract<Command, { command: 'ObserveUsage' }>,
    effects: (() => void)[],
  ): CommandResult {
    if (this.usageRead && this.usageRead.key !== command.key)
      return { outcome: 'blocked', reason: 'usage-reader-busy' };
    if (command.payload.family === 'openai') {
      const prepared = preparedUsage.get(this);
      if (prepared?.key !== command.key || !prepared.openai)
        return { outcome: 'blocked', reason: 'client-unavailable' };
      const reader = this.openAiUsageReader(prepared.openai);
      if (!reader.available) return { outcome: 'blocked', reason: reader.reason };
      if (this.openAiUsageRead)
        return { outcome: 'blocked', reason: 'openai-metadata-ownership-pending' };
      if (reader.readState === 'unknown')
        return { outcome: 'outcome-unknown', reason: 'openai-metadata-ownership-unknown' };
      if (reader.readState === 'intent' || reader.readState === 'owned')
        return { outcome: 'blocked', reason: 'openai-metadata-ownership-pending' };
      if (reader.lastAttemptAt && Date.parse(this.now()) - Date.parse(reader.lastAttemptAt) < 60000)
        return {
          outcome: 'blocked',
          reason: 'usage-reader-cooldown',
          next: `Refresh after ${new Date(Date.parse(reader.lastAttemptAt) + 60000).toISOString()}.`,
        };
      if (
        this.store.intents().some((intent) => {
          if (intent.state === 'stopped') return false;
          const route = this.store.get<Route>('route', intent.route_id);
          return !route || (route.family === 'openai' && !route.fake);
        })
      )
        return { outcome: 'blocked', reason: 'openai-task-active' };
      effects.push(() => void this.launchOpenAiUsage(command.key));
      return { outcome: 'outcome-unknown', reason: 'openai-usage-read-pending' };
    }
    const reader = this.store.googleUsageReader();
    const now = this.now();
    if (reader.last_attempt_at && Date.parse(now) - Date.parse(reader.last_attempt_at) < 60000)
      return {
        outcome: 'blocked',
        reason: 'usage-reader-cooldown',
        next: `Refresh after ${new Date(Date.parse(reader.last_attempt_at) + 60000).toISOString()}.`,
      };
    const blocker = this.store.googleOperationBlocker();
    if (blocker) return { outcome: 'blocked', reason: blocker };
    this.store.recordGoogleUsageAttempt(now);
    // observeUsageCommand resolved the client before this transaction opened.
    if (!this.usageResolution.available)
      return {
        outcome: 'blocked',
        reason: this.usageResolution.reason,
        ...(this.usageResolution.status ? { next: this.usageResolution.status.message } : {}),
      };
    this.store.beginGoogleMetadata(command.key, 'usage', reader.authority_revision, now);
    const resolution = this.usageResolution;
    effects.push(
      () => void this.launchGoogleUsage(command.key, reader.authority_revision, resolution),
    );
    return { outcome: 'outcome-unknown', reason: 'usage-read-pending' };
  }

  async launchOpenAiUsage(this: Controller, commandId: string) {
    const runtime = this.usageRead;
    if (!runtime || runtime.key !== commandId) return;
    let result: CommandResult;
    try {
      const read = this.refreshOpenAiUsage('manual', commandId);
      await read;
      const state = this.openAiUsageState();
      result =
        !read || state?.commandId !== commandId
          ? { outcome: 'blocked', reason: 'usage-read-unavailable' }
          : state.state === 'unknown'
            ? { outcome: 'outcome-unknown', reason: 'openai-metadata-ownership-unknown' }
            : state.reason === 'observed'
              ? {
                  outcome: 'applied',
                  data: {
                    kind: 'usage',
                    windows: this.store.list<Observation>('window').map((observation) =>
                      deriveWindow(observation, {
                        nowMs: Date.parse(this.now()),
                        maxAgeMs: 300000,
                      }),
                    ),
                  },
                }
              : { outcome: 'blocked', reason: state.reason ?? 'no-observations' };
    } catch {
      result = { outcome: 'outcome-unknown', reason: 'openai-metadata-ownership-unknown' };
    }
    try {
      this.store.transaction(() => this.finishMetadataReceipt(commandId, result));
    } catch {
      result = { outcome: 'outcome-unknown', reason: 'openai-metadata-ownership-unknown' };
    } finally {
      runtime.resolve(result);
    }
  }

  async launchGoogleUsage(
    this: Controller,
    commandId: string,
    authorityRevision: number,
    resolution: Extract<GoogleUsageClientResolution, { available: true }>,
  ) {
    const runtime = this.usageRead;
    if (!runtime || runtime.key !== commandId) return;
    this.googleUsageReport = undefined;
    let result: CommandResult = { outcome: 'blocked', reason: 'usage-read-failed' };
    let beforeSpawn = true;
    const current = () => {
      const reader = this.store.googleUsageReader();
      if (
        this.closed ||
        runtime.abort.signal.aborted ||
        reader.authority_revision !== authorityRevision
      )
        throw new Error('usage-read-revoked');
      const operation = this.store
        .googleMetadataOperations()
        .find((row) => row.command_id === commandId);
      if (!operation || !['intent', 'owned'].includes(operation.state))
        throw new Error('google-ownership-unknown');
    };
    try {
      current();
      const directory = mkdtempSync(join(this.home, 'google-usage-'));
      const temporaryDirectory = mkdtempSync(join(this.home, 'google-usage-tmp-'));
      const handle = startGoogleUsage({
        client: resolution.client,
        repositoryRoot: this.home,
        directory,
        temporaryDirectory,
        environment: resolution.environment,
        timeoutMs: googleUsageDescriptor.maximumReadMs,
        signal: runtime.abort.signal,
        spawn: this.options.googleUsageSpawn,
        schedule: this.options.schedule,
        lifecycle: {
          beforePhase: () => {
            current();
            beforeSpawn = false;
          },
          owned: (_, group) => {
            this.store.transaction(() => this.store.ownGoogleMetadata(commandId, group));
            current();
          },
          quiescent: (_, group) =>
            this.store.transaction(() =>
              this.store.finishGoogleMetadata(commandId, group, this.now()),
            ),
        },
      });
      const outcome = await handle.result;
      let published: Controller['googleUsageReport'];
      this.store.transaction(() => {
        if (!outcome.quiescent) this.store.unknownGoogleMetadata(commandId);
        const reader = this.store.googleUsageReader();
        const operation = this.store
          .googleMetadataOperations()
          .find((row) => row.command_id === commandId);
        if (operation?.state !== 'quiescent') this.store.unknownGoogleMetadata(commandId);
        if (
          this.closed ||
          runtime.abort.signal.aborted ||
          reader.authority_revision !== authorityRevision
        )
          result = { outcome: 'blocked', reason: 'usage-read-revoked' };
        else if (!outcome.quiescent || operation?.state !== 'quiescent')
          result = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
        else if (!outcome.reason && outcome.metadata) {
          const observedAt = this.now();
          let routes = this.store
            .list<Route>('route')
            .filter((route) => route.family === 'google' && !route.fake);
          if (!routes.length) {
            const route = RouteSchema.parse({
              id: this.id('rte'),
              family: 'google',
              displayName: 'Google',
              model: 'unknown',
              effort: { requested: 'unknown', effective: 'unknown', supported: [] },
              billing: 'included',
              qualified: false,
              fake: false,
            });
            this.store.put('route', route.id, 0, route);
            this.store.saveReceipt('usage-route:google', hashCanonical(route), 'local-owner', {
              outcome: 'applied',
            });
            routes = [route];
          }
          // A complete account report replaces its client windows. Retaining a removed
          // bucket would leave an expired allowance blocking every Google route.
          const reported = new Set(outcome.metadata.map((bucket) => bucket.windowId));
          const live = new Set(routes.map((route) => route.id));
          for (const window of this.store.list<Observation>('window'))
            if (
              window.source === 'client' &&
              live.has(window.routeId) &&
              !reported.has(window.windowId)
            )
              this.store.db
                .prepare("DELETE FROM entities WHERE kind='window' AND id=?")
                .run(`${window.routeId}/${window.windowId}`);
          for (const observation of googleUsageObservations(
            outcome.metadata,
            routes.map((route) => route.id),
            observedAt,
          )) {
            this.store.put(
              'window',
              `${observation.routeId}/${observation.windowId}`,
              0,
              ObservationSchema.parse(observation),
            );
            this.event('usage.observed', null, 0, observation);
          }
          this.store.recordGoogleUsageObservation(observedAt);
          const bindingHash = this.googleUsageBinding(resolution);
          if (bindingHash)
            published = {
              commandId,
              authorityRevision,
              attemptedAt: reader.last_attempt_at,
              observedAt,
              bindingHash,
              home: resolution.environment.HOME,
              buckets: structuredClone(outcome.metadata),
            };
          result = {
            outcome: 'applied',
            // Inside this transaction: the windows come from the store alone. The workspace read
            // would resolve every family's client.
            data: {
              kind: 'usage',
              windows: this.store
                .list<Observation>('window')
                .map((observation) =>
                  deriveWindow(observation, { nowMs: Date.parse(this.now()), maxAgeMs: 300000 }),
                ),
            },
          };
        }
        this.finishMetadataReceipt(commandId, result);
      });
      this.googleUsageReport = published;
    } catch (error) {
      result = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
      try {
        this.store.transaction(() => {
          const operation = this.store
            .googleMetadataOperations()
            .find((row) => row.command_id === commandId);
          if (
            operation?.state === 'intent' &&
            (beforeSpawn || (error instanceof GoogleWriterError && error.reason === 'start'))
          )
            this.store.finishGoogleMetadata(commandId, null, this.now());
          else if (operation?.state !== 'quiescent') this.store.unknownGoogleMetadata(commandId);
          const reader = this.store.googleUsageReader();
          const finished = this.store
            .googleMetadataOperations()
            .find((row) => row.command_id === commandId);
          if (reader.authority_revision !== authorityRevision || this.closed)
            result = { outcome: 'blocked', reason: 'usage-read-revoked' };
          else if (finished?.state === 'quiescent')
            result = { outcome: 'blocked', reason: 'usage-read-failed' };
          this.finishMetadataReceipt(commandId, result);
        });
      } catch {
        // A failed persistence boundary leaves the committed ownership intent in place.
        result = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
      }
    } finally {
      runtime.resolve(CommandResultSchema.parse(result));
    }
  }

  googleUsageBinding(
    this: Controller,
    resolution: Extract<GoogleUsageClientResolution, { available: true }>,
  ) {
    try {
      const setup = this.store.googleAcpSetup();
      if (setup.state !== 'ready' || !setup.proofId) return;
      const proof = this.store.get<Artifact>('artifact', setup.proofId);
      if (!proof) return;
      return hashCanonical({
        client: resolution.client,
        environment: resolution.environment,
        setup,
        proofHash: proof.hash,
      });
    } catch {
      return;
    }
  }

  attachGoogleUsage(this: Controller, routeId: string, environment: NodeJS.ProcessEnv) {
    const report = this.googleUsageReport;
    if (!report || this.store.googleOperationBlocker()) return;
    let observations: Observation[];
    try {
      // This runs inside a preparation transaction, so it takes only a version already read.
      const resolution =
        this.options.googleUsageClient?.() ??
        resolveGoogleUsageClient(process.env, undefined, { cachedOnly: true });
      const reader = this.store.googleUsageReader();
      const operation = this.store
        .googleMetadataOperations()
        .find((row) => row.command_id === report.commandId);
      if (
        !resolution.available ||
        !report.home ||
        environment.HOME !== report.home ||
        this.googleUsageBinding(resolution) !== report.bindingHash ||
        reader.authority_revision !== report.authorityRevision ||
        reader.last_attempt_at !== report.attemptedAt ||
        reader.last_observed_at !== report.observedAt ||
        operation?.kind !== 'usage' ||
        operation.state !== 'quiescent' ||
        operation.authority_revision !== report.authorityRevision
      )
        return;
      observations = googleUsageObservations(report.buckets, [routeId], report.observedAt);
      if (
        !observations.every(
          (window) =>
            deriveWindow(window, { nowMs: Date.parse(this.now()), maxAgeMs: 300000 }).state ===
            'fresh',
        )
      )
        return;
    } catch {
      return;
    }
    // A new preparation can follow the startup read inside its cooldown.
    // Keep that complete report's original time and account assertion binding.
    for (const observation of observations) {
      this.store.put('window', `${routeId}/${observation.windowId}`, 0, observation);
      this.event('usage.observed', null, 0, observation);
    }
  }

  finishMetadataReceipt(this: Controller, commandId: string, result: CommandResult) {
    this.store.db
      .prepare('UPDATE receipts SET result=? WHERE command_key=?')
      .run(canonicalJson(CommandResultSchema.parse(result)), commandId);
  }

  storeProviderUsage(
    this: Controller,
    routeId: string,
    value: unknown,
    current: () => void,
    prior?: ReadonlyMap<string, Observation>,
  ): boolean {
    try {
      const parsed = ProviderUsageBatchSchema.safeParse(value);
      if (!parsed.success || Buffer.byteLength(canonicalJson(parsed.data)) > 32768) return false;
      const report = parsed.data;
      const ids = new Set(report.observations.map((observation) => observation.windowId));
      if (
        ids.size !== report.observations.length ||
        Date.parse(report.observedAt) > Date.parse(this.now()) ||
        report.observations.some(
          (observation) =>
            observation.routeId !== routeId ||
            observation.observedAt !== report.observedAt ||
            observation.source !== 'client' ||
            observation.confidence !== 'reported',
        )
      )
        return false;
      return this.store.transaction(() => {
        if (this.closed) return false;
        current();
        const windows = this.store
          .list<Observation>('window')
          .filter((window) => window.routeId === routeId);
        const existing = new Map(windows.map((window) => [window.windowId, window]));
        const ownedPrior = (window: Observation) =>
          window.source === 'client' &&
          prior?.has(window.windowId) &&
          hashCanonical(prior.get(window.windowId)) === hashCanonical(window);
        if (
          (report.mode === 'complete' &&
            windows.some(
              (window) =>
                window.source === 'client' &&
                Date.parse(window.observedAt) > Date.parse(report.observedAt),
            )) ||
          report.observations.some((observation) => {
            const previous = existing.get(observation.windowId);
            return (
              previous &&
              Date.parse(previous.observedAt) === Date.parse(observation.observedAt) &&
              hashCanonical(previous) !== hashCanonical(observation) &&
              !ownedPrior(previous)
            );
          })
        )
          return false;
        let removed = false;
        let written = false;
        if (report.mode === 'complete')
          for (const window of windows)
            if (
              window.source === 'client' &&
              !ids.has(window.windowId) &&
              (Date.parse(window.observedAt) < Date.parse(report.observedAt) ||
                (Date.parse(window.observedAt) === Date.parse(report.observedAt) &&
                  ownedPrior(window)))
            ) {
              this.store.db
                .prepare("DELETE FROM entities WHERE kind='window' AND id=?")
                .run(`${window.routeId}/${window.windowId}`);
              removed = true;
            }
        for (const observation of report.observations) {
          const previous = existing.get(observation.windowId);
          if (
            previous &&
            (Date.parse(previous.observedAt) > Date.parse(observation.observedAt) ||
              (Date.parse(previous.observedAt) === Date.parse(observation.observedAt) &&
                (!ownedPrior(previous) || hashCanonical(previous) === hashCanonical(observation))))
          )
            continue;
          this.store.put(
            'window',
            `${observation.routeId}/${observation.windowId}`,
            0,
            observation,
          );
          this.event('usage.observed', null, 0, observation);
          written = true;
        }
        if (removed && !written) this.event('usage.observed', null, 0, report.observations[0]);
        return true;
      });
    } catch {
      return false;
    }
  }

  providerUsageAdapter(
    this: Controller,
    routeId: string,
    onReport: (report: unknown, prior: ReadonlyMap<string, Observation>) => boolean,
  ) {
    const seen = new Map<string, Observation>();
    return (value: unknown) => {
      try {
        const parsed = ProviderUsageDraftSchema.safeParse(value);
        if (!parsed.success) return false;
        const complete =
          parsed.data.complete === true &&
          this.store.get<Route>('route', routeId)?.family === 'openai';
        const windows = parsed.data.windows.map((window) => {
          if ('remainingPercent' in window)
            return {
              windowId: window.windowId,
              kind: window.kind,
              semantics: window.semantics,
              remaining: { value: window.remainingPercent, unit: 'percent' as const },
              resetsAt: window.resetsAt,
              source: 'client' as const,
              confidence: 'reported' as const,
            };
          return window;
        });
        if (
          !complete &&
          new Set([...seen.keys(), ...windows.map((window) => window.windowId)]).size > 32
        )
          return false;
        const changed = complete
          ? windows
          : windows.filter((window) => {
              const previous = seen.get(window.windowId);
              if (!previous) return true;
              const { routeId: _route, observedAt: _time, ...reading } = previous;
              return hashCanonical(reading) !== hashCanonical(window);
            });
        if (!changed.length) return true;
        const observedAt = this.now();
        const observations = changed.map((window) => ({ ...window, routeId, observedAt }));
        if (onReport({ mode: complete ? 'complete' : 'partial', observedAt, observations }, seen)) {
          if (complete) seen.clear();
          for (const observation of observations) seen.set(observation.windowId, observation);
          return true;
        }
      } catch {}
      return false;
    };
  }

  providerUsage(
    this: Controller,
    attempt: Attempt,
    current: () => void,
    ownsRuntime: () => boolean,
    phases: readonly string[],
  ) {
    const route = this.store.get<Route>('route', attempt.routeId);
    const routeHash = hashCanonical(route ?? null);
    const onReport = (value: unknown, prior?: ReadonlyMap<string, Observation>) =>
      this.storeProviderUsage(
        attempt.routeId,
        value,
        () => {
          if (
            this.closed ||
            !ownsRuntime() ||
            !route ||
            route.fake ||
            !['openai', 'anthropic'].includes(route.family)
          )
            throw Error('Provider usage ownership changed.');
          current();
          const saved = this.store.get<Attempt>('attempt', attempt.id);
          const intent = this.store.intents().find((row) => row.attempt_id === attempt.id);
          const task = intent && this.store.get<Task>('task', intent.task_id);
          const lease =
            intent &&
            this.store.db
              .prepare('SELECT attempt_id,generation FROM writer_leases WHERE task_id=?')
              .get(intent.task_id);
          const phase = this.store.nativeProcesses(attempt.id).at(-1);
          if (
            !saved ||
            !['intent', 'running'].includes(saved.state) ||
            saved.generation !== attempt.generation ||
            saved.routeId !== attempt.routeId ||
            saved.runId !== attempt.runId ||
            !intent ||
            intent.state !== 'acknowledged' ||
            intent.run_id !== attempt.runId ||
            intent.route_id !== attempt.routeId ||
            intent.generation !== attempt.generation ||
            task?.runId !== intent.run_id ||
            lease?.attempt_id !== attempt.id ||
            lease.generation !== attempt.generation ||
            !phase ||
            phase.state !== 'owned' ||
            !phases.includes(phase.phase) ||
            hashCanonical(this.store.get<Route>('route', attempt.routeId) ?? null) !== routeHash
          )
            throw Error('Provider usage ownership changed.');
        },
        prior,
      );
    return {
      usage: {
        routeId: attempt.routeId,
        observedAt: this.now,
        onReport: (value: unknown) => onReport(value),
      },
      onUsage: this.providerUsageAdapter(attempt.routeId, onReport),
    };
  }
}
