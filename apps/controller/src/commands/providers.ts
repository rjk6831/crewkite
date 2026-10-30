import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Artifact,
  type Command,
  type CommandResult,
  CommandResultSchema,
  CommandSchema,
  GoogleAcpSetupSchema,
  LocalModelObservationSchema,
  type LocalSetup,
  LocalSetupSchema,
  MAX_FRAME_BYTES,
  NativeProfileSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import {
  ConnectionRecordSchema,
  NativeConnectionChecks,
} from '../providers/anthropic/native-connection.ts';
import {
  GoogleAcpInstallation,
  InstallRecordSchema,
} from '../providers/google/acp/install-operation.ts';
import {
  type AcpClientIdentity,
  type AcpProfileResolution,
  type AcpSetupProof,
  AcpSetupProofSchema,
  resolveGoogleAcpProfile,
  validateAcpSetupProof,
} from '../providers/google/acp/profile.ts';
import { startGoogleAcpSetup } from '../providers/google/acp/writer.ts';
import { probeLocalWithoutToken } from '../providers/local/chat-connect.ts';
import {
  localConfiguredConnectionHash,
  resolveLocalConnection,
  retainedSelection,
} from '../providers/local/connection.ts';
import { availableMemory, refreshAvailableMemory } from '../providers/local/hardware.ts';
import { startLocalDiscovery } from '../providers/local/replacement.ts';
import { type LocalInputResult, startLocalSecretInput } from '../providers/local/secure-input.ts';
import {
  type NativeProfileResolution,
  unavailableNativeProfile,
} from '../providers/openai/profile.ts';
import type { Controller } from './controller.ts';
import { googleTermsAcknowledged } from './google-terms.ts';
import {
  type AcpSetupCommand,
  type LocalControl,
  LocalControlSchema,
  type LocalOperationRuntime,
} from './schemas.ts';

// Provider setup: ACP install and sign-in, connection checks, the Local connection and profiles.
export class ProviderCommands {
  executeAcpSetup(
    this: Controller,
    command: AcpSetupCommand,
    principal: string,
  ): Promise<CommandResult> {
    const prior = this.acpSetupRuntime;
    const hash = hashCanonical(command);
    if (prior?.key === command.key)
      return prior.hash === hash && prior.principal === principal
        ? prior.promise
        : Promise.resolve({ outcome: 'denied', reason: 'idempotency-key-reused' });
    if (command.command === 'StopGoogleAcpSetup' || prior || this.store.receipt(command.key)) {
      let result = this.commitCommand(command, principal);
      if (result.reason === 'acp-setup-pending') {
        this.store.transaction(() => {
          const journal = this.store
            .googleMetadataOperations()
            .find((row) => row.command_id === command.key);
          const known = journal?.state === 'quiescent';
          if (!known) this.store.unknownGoogleMetadata(command.key);
          let setup = this.store.googleAcpSetup();
          if (setup.operationId === command.key) {
            setup = GoogleAcpSetupSchema.parse({
              ...setup,
              revision: setup.revision + 1,
              state: known ? 'blocked' : 'unknown',
              operationId: known ? null : command.key,
            });
            this.store.putGoogleAcpSetup(setup);
          }
          result = {
            outcome: known ? 'blocked' : 'outcome-unknown',
            reason: known ? 'acp-setup-interrupted' : 'google-ownership-unknown',
            data: { kind: 'google-acp-setup', setup },
          };
          this.finishMetadataReceipt(command.key, result);
        });
      }
      return Promise.resolve(result);
    }
    const completion = Promise.withResolvers<CommandResult>();
    const runtime = {
      key: command.key,
      hash,
      principal,
      promise: completion.promise,
      resolve: completion.resolve,
      stopped: false,
    };
    this.acpSetupRuntime = runtime;
    try {
      const result = this.commitCommand(command, principal);
      if (result.reason !== 'acp-setup-pending') completion.resolve(result);
    } catch (error) {
      if (this.acpSetupRuntime === runtime) this.acpSetupRuntime = undefined;
      throw error;
    }
    return runtime.promise.finally(() => {
      if (this.acpSetupRuntime === runtime) this.acpSetupRuntime = undefined;
    });
  }

  applyAcpSetup(
    this: Controller,
    command: AcpSetupCommand,
    effects: (() => void)[],
  ): CommandResult {
    const setup = this.store.googleAcpSetup();
    if (command.command === 'StopGoogleAcpSetup') {
      if (
        setup.operationId !== command.payload.operationId ||
        !['initializing', 'authenticating', 'discovering', 'stopping'].includes(setup.state)
      )
        return {
          outcome: 'blocked',
          reason: 'acp-setup-not-current',
          data: { kind: 'google-acp-setup', setup },
        };
      const runtime = this.acpSetupRuntime;
      const live = runtime?.key === setup.operationId;
      const next = GoogleAcpSetupSchema.parse({
        ...setup,
        revision: setup.revision + 1,
        state: live ? 'stopping' : 'unknown',
      });
      this.store.putGoogleAcpSetup(next);
      if (live)
        effects.push(() => {
          runtime.stopped = true;
          runtime.handle?.stop();
        });
      return {
        outcome: live ? 'applied' : 'outcome-unknown',
        ...(!live ? { reason: 'google-ownership-unknown' } : {}),
        data: { kind: 'google-acp-setup', setup: next },
      };
    }
    // Automatic consent is the controller's own launch-time step. From anyone else it would
    // put a click in the journal that nobody made.
    if (
      'consent' in command.payload &&
      command.payload.consent === 'automatic' &&
      command.actor.kind !== 'controller'
    )
      return {
        outcome: 'denied',
        reason: 'consent-required',
        data: { kind: 'google-acp-setup', setup },
      };
    const installBlocker = this.googleInstallationBlocker();
    if (installBlocker) return installBlocker;
    const blocker = this.store.googleOperationBlocker();
    if (blocker)
      return { outcome: 'blocked', reason: blocker, data: { kind: 'google-acp-setup', setup } };
    const resolution = this.acpResolution();
    if (!resolution.client || !resolution.environment)
      return {
        outcome: 'blocked',
        reason: resolution.facts.reason,
        data: { kind: 'google-acp-setup', setup },
      };
    const operation =
      command.command === 'InitializeGoogleAcp'
        ? 'initialize'
        : command.command === 'AuthenticateGoogleAcp'
          ? 'authenticate'
          : 'discover';
    let proof: AcpSetupProof | null = null;
    try {
      if (operation !== 'initialize') {
        if (!('proofId' in command.payload) || command.payload.proofId !== setup.proofId)
          throw Error('ACP proof changed.');
        proof = this.acpProof(command.payload.proofId);
        validateAcpSetupProof(proof, resolution.client, this.options.googleAcp?.reviewMappings);
      }
    } catch {
      return {
        outcome: 'blocked',
        reason: 'acp-proof-unavailable',
        data: { kind: 'google-acp-setup', setup },
      };
    }
    const state = {
      initialize: 'initializing',
      authenticate: 'authenticating',
      discover: 'discovering',
    }[operation];
    const next = GoogleAcpSetupSchema.parse({
      ...setup,
      revision: setup.revision + 1,
      state,
      operationId: command.key,
      reason: null,
    });
    this.store.putGoogleAcpSetup(next);
    this.store.beginGoogleMetadata(command.key, `acp-${operation}`, next.revision, this.now());
    effects.push(
      () => void this.launchAcpSetup(command.key, next.revision, operation, proof, resolution),
    );
    return {
      outcome: 'outcome-unknown',
      reason: 'acp-setup-pending',
      data: { kind: 'google-acp-setup', setup: next },
    };
  }

  /**
   * The setup step that can run without the person, or null. Initialize and discover start no
   * prompt and open no browser. Authenticate opens a browser, so it waits for a click. The
   * initialize reply names sign-in methods and no sign-in status, so discover runs only on a
   * proof that already records a finished sign-in. Only a controller that registers the real
   * client prepares it; a harness that drives each step leaves registration off. Nothing starts
   * until the current Google terms text is acknowledged, and the acknowledgement runs this again.
   */
  googleAcpPreparationStep(this: Controller): 'initialize' | 'discover' | null {
    if (
      !this.options.registerGoogleAcp ||
      this.closed ||
      !googleTermsAcknowledged(this.store) ||
      this.acpSetupRuntime ||
      this.acpStart ||
      this.googleInstallationBlocker() ||
      this.store.transaction(() => this.store.googleOperationBlocker())
    )
      return null;
    const setup = this.store.googleAcpSetup();
    if (setup.operationId || setup.state === 'unknown') return null;
    const resolution = this.acpResolution();
    if (!resolution.client || !resolution.environment) return null;
    let proof: AcpSetupProof | null = null;
    try {
      const stored = this.acpProof(setup.proofId);
      if (stored)
        proof = validateAcpSetupProof(
          stored,
          resolution.client,
          this.options.googleAcp?.reviewMappings,
        );
    } catch {}
    if (proof && setup.state === 'ready') return null;
    if (proof?.auth.status === 'authenticated') return 'discover';
    // A fresh initialize would bring the same proof back. The next step is the person's sign-in.
    if (proof && setup.state === 'authentication-required') return null;
    return 'initialize';
  }

  /**
   * Takes the Google client as far toward ready as it can go without the person, one attempt
   * per step. Each step is an ordinary setup command, so ownership, the process journal and
   * stop on shutdown work as they do for a click, and a failure lands in the setup state.
   */
  async prepareGoogleAcp(this: Controller) {
    const attempted = new Set<string>();
    for (;;) {
      const step = this.googleAcpPreparationStep();
      if (!step || attempted.has(step)) return;
      attempted.add(step);
      const setup = this.store.googleAcpSetup();
      const command = CommandSchema.parse({
        protocol: 1,
        key: this.id('cmd'),
        actor: { id: 'controller', kind: 'controller' },
        command: step === 'initialize' ? 'InitializeGoogleAcp' : 'DiscoverGoogleAcp',
        expectedRevision: setup.revision,
        payload: {
          profileId: 'google-acp-v1',
          consent: 'automatic',
          ...(step === 'discover' ? { proofId: setup.proofId } : {}),
        },
      }) as AcpSetupCommand;
      await this.executeAcpSetup(command, 'local-owner');
    }
  }

  async launchAcpSetup(
    this: Controller,
    commandId: string,
    revision: number,
    operation: 'initialize' | 'authenticate' | 'discover',
    priorProof: AcpSetupProof | null,
    resolution: AcpProfileResolution,
  ) {
    const runtime = this.acpSetupRuntime;
    if (!runtime || runtime.key !== commandId || !resolution.client || !resolution.environment)
      return;
    let result: CommandResult = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
    let beforeSpawn = true;
    const current = () => {
      const setup = this.store.googleAcpSetup();
      if (
        this.closed ||
        runtime.stopped ||
        setup.operationId !== commandId ||
        setup.revision !== revision ||
        !['initializing', 'authenticating', 'discovering'].includes(setup.state)
      )
        throw Error('ACP setup authority changed.');
    };
    try {
      current();
      const directory = mkdtempSync(join(this.home, 'google-acp-setup-'));
      runtime.handle = startGoogleAcpSetup({
        client: resolution.client,
        directory,
        environment: resolution.environment,
        operation,
        priorProof,
        ...this.options.googleAcp,
        spawn: this.options.googleAcp?.spawn,
        schedule: this.options.schedule,
        lifecycle: {
          beforePhase: () => {
            current();
            beforeSpawn = false;
          },
          owned: (group) => {
            this.store.transaction(() => this.store.ownGoogleMetadata(commandId, group));
            current();
          },
          quiescent: (group) =>
            this.store.transaction(() =>
              this.store.finishGoogleMetadata(commandId, group, this.now()),
            ),
        },
      });
      if (runtime.stopped || this.closed) runtime.handle.stop();
      const outcome = await runtime.handle.result;
      this.store.transaction(() => {
        let setup = this.store.googleAcpSetup();
        const journal = this.store
          .googleMetadataOperations()
          .find((row) => row.command_id === commandId);
        const known = outcome.quiescent && journal?.state === 'quiescent';
        if (!known) this.store.unknownGoogleMetadata(commandId);
        const revoked =
          this.closed ||
          runtime.stopped ||
          setup.operationId !== commandId ||
          setup.revision !== revision;
        let proofId = setup.proofId,
          client = setup.client,
          auth = setup.auth;
        let ready = false;
        if (known && !revoked && !outcome.reason && outcome.metadata) {
          const proof = validateAcpSetupProof(
            outcome.metadata,
            resolution.client as AcpClientIdentity,
            this.options.googleAcp?.reviewMappings,
          );
          proofId = this.nativeArtifact(proof).id;
          client = proof.client;
          auth = proof.auth;
          ready =
            !!proof.reviewMode && !!proof.configOptions && proof.auth.status === 'authenticated';
        }
        setup = GoogleAcpSetupSchema.parse({
          ...setup,
          revision: setup.revision + 1,
          state: !known
            ? 'unknown'
            : ready
              ? 'ready'
              : !revoked && !outcome.reason && operation === 'initialize'
                ? 'authentication-required'
                : !revoked &&
                    !outcome.reason &&
                    operation === 'authenticate' &&
                    auth.status === 'authenticated'
                  ? 'discovery-required'
                  : 'blocked',
          operationId: known ? null : commandId,
          proofId,
          client,
          auth,
          reason: ready
            ? null
            : !revoked && outcome.reason === 'deadline'
              ? 'acp-setup-timeout'
              : outcome.reason === 'authentication'
                ? 'authentication-required'
                : !revoked && operation === 'discover'
                  ? 'acp-capability-missing'
                  : null,
        });
        this.store.putGoogleAcpSetup(setup);
        result = {
          outcome: !known ? 'outcome-unknown' : revoked || outcome.reason ? 'blocked' : 'applied',
          ...(!known || revoked || outcome.reason
            ? {
                reason: !known
                  ? 'google-ownership-unknown'
                  : revoked
                    ? 'acp-setup-stopped'
                    : outcome.reason === 'deadline'
                      ? 'acp-setup-timeout'
                      : 'acp-setup-failed',
              }
            : {}),
          ...(known && !revoked && outcome.reason === 'deadline'
            ? {
                next:
                  operation === 'initialize'
                    ? 'Initialization timed out after 30 seconds. Retry Initialize; no task was submitted.'
                    : 'Native setup timed out. Retry this setup step; no task was submitted.',
              }
            : {}),
          data: { kind: 'google-acp-setup', setup },
        };
        this.finishMetadataReceipt(commandId, result);
        this.profiles = this.resolveProfiles();
      });
    } catch {
      try {
        this.store.transaction(() => {
          const journal = this.store
            .googleMetadataOperations()
            .find((row) => row.command_id === commandId);
          if (beforeSpawn && journal?.state === 'intent')
            this.store.finishGoogleMetadata(commandId, null, this.now());
          else if (journal?.state !== 'quiescent') this.store.unknownGoogleMetadata(commandId);
          const known =
            this.store.googleMetadataOperations().find((row) => row.command_id === commandId)
              ?.state === 'quiescent';
          const setup = this.store.googleAcpSetup();
          const next = GoogleAcpSetupSchema.parse({
            ...setup,
            revision: setup.revision + 1,
            state: known ? 'blocked' : 'unknown',
            operationId: known ? null : commandId,
            reason: null,
          });
          this.store.putGoogleAcpSetup(next);
          result = {
            outcome: known ? 'blocked' : 'outcome-unknown',
            reason: known ? 'acp-setup-failed' : 'google-ownership-unknown',
            data: { kind: 'google-acp-setup', setup: next },
          };
          this.finishMetadataReceipt(commandId, result);
        });
      } catch {
        result = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
      }
    } finally {
      runtime.resolve(CommandResultSchema.parse(result));
    }
  }

  googleInstallation(this: Controller): GoogleAcpInstallation {
    if (this.googleInstallOperation) return this.googleInstallOperation;
    const read = (key?: string) => {
      const row = this.store.db
        .prepare(
          'SELECT command_key FROM receipts WHERE command_key LIKE ? ORDER BY rowid DESC LIMIT 1',
        )
        .get(key ? `google-acp-install:${key}:%` : 'google-acp-install:%') as
        | { command_key: string }
        | undefined;
      return row ? InstallRecordSchema.parse(this.nativeRecord(row.command_key, 4096).value) : null;
    };
    this.googleInstallOperation = new GoogleAcpInstallation({
      now: this.now,
      latest: () => read(),
      forKey: (key) => read(key),
      append: (record) =>
        this.store.transaction(() => {
          const value = InstallRecordSchema.parse(record);
          const artifact = this.nativeArtifact(value);
          if (value.phase === 'intent')
            this.store.saveReceipt(value.key, value.requestHash, 'local-owner', {
              outcome: 'blocked',
              reason: 'google-install-pending',
              data: { kind: 'google-acp-install', install: value.status },
            });
          this.store.saveReceipt(
            `google-acp-install:${value.key}:${value.step}`,
            artifact.hash,
            'local-owner',
            { outcome: 'applied', entity: artifact },
          );
        }),
    });
    return this.googleInstallOperation;
  }

  googleInstallationBlocker(this: Controller): CommandResult | undefined {
    const status = this.googleInstallation().status();
    if (['installing', 'stopping', 'unknown'].includes(status.state))
      return {
        outcome: 'blocked',
        reason:
          status.state === 'unknown' ? 'google-install-ownership-unknown' : 'google-install-active',
        next: status.next,
        data: { kind: 'google-acp-install', install: status },
      };
  }

  async executeGoogleInstall(
    this: Controller,
    command: Extract<Command, { command: 'InstallGoogleAcp' | 'StopGoogleAcpInstall' }>,
    principal: string,
  ): Promise<CommandResult> {
    const hash = hashCanonical(command),
      receipt = this.store.receipt(command.key);
    if (receipt && (receipt.hash !== hash || receipt.principal !== principal))
      return { outcome: 'denied', reason: 'idempotency-key-reused' };
    if (
      receipt &&
      !['google-install-pending', 'google-install-stop-pending'].includes(
        receipt.result.reason ?? '',
      )
    )
      return {
        ...receipt.result,
        ...(receipt.result.outcome === 'applied' ? { outcome: 'already-applied' as const } : {}),
      };
    if (command.expectedRevision !== 0) return { outcome: 'stale-revision', revision: 0 };
    const operation = this.googleInstallation();
    let result: CommandResult;
    if (command.command === 'StopGoogleAcpInstall') {
      if (!receipt)
        this.store.transaction(() =>
          this.store.saveReceipt(command.key, hash, principal, {
            outcome: 'blocked',
            reason: 'google-install-stop-pending',
            data: { kind: 'google-acp-install', install: operation.status() },
          }),
        );
      result = await operation.stop(command.payload.operationId);
    } else {
      const blocker = receipt
        ? undefined
        : this.store.transaction(() => this.store.googleOperationBlocker());
      result = blocker
        ? {
            outcome: 'blocked',
            reason: blocker,
            data: { kind: 'google-acp-install', install: operation.status() },
          }
        : !receipt && (this.acpSetupRuntime || this.acpStart)
          ? {
              outcome: 'blocked',
              reason: 'google-operation-active',
              data: { kind: 'google-acp-install', install: operation.status() },
            }
          : await operation.install(
              { key: command.key, requestHash: hash, home: this.home },
              this.options.googleAcpInstall,
            );
    }
    if (result.outcome === 'denied') return result;
    try {
      this.store.transaction(() => {
        const current = this.store.receipt(command.key);
        if (current && current.hash !== hash) throw Error('Command binding changed.');
        if (
          current &&
          ['google-install-pending', 'google-install-stop-pending'].includes(
            current.result.reason ?? '',
          )
        )
          this.finishMetadataReceipt(command.key, result);
        else if (!current) this.store.saveReceipt(command.key, hash, principal, result);
      });
    } catch {
      return { outcome: 'blocked', reason: 'google-install-storage-failed' };
    }
    // A new client has no proof yet. Initializing before the reply means the card's next step
    // is the sign-in, and an install that nobody follows up still leaves the client initialized.
    if (command.command === 'InstallGoogleAcp' && result.outcome === 'applied')
      await this.prepareGoogleAcp().catch(() => {});
    return result;
  }

  nativeConnections(this: Controller): NativeConnectionChecks {
    if (this.connectionChecks) return this.connectionChecks;
    this.connectionChecks = new NativeConnectionChecks({
      now: this.now,
      latest: () => {
        const row = this.store.db
          .prepare(
            "SELECT command_key FROM receipts WHERE command_key LIKE 'native-connection:%' ORDER BY rowid DESC LIMIT 1",
          )
          .get() as { command_key: string } | undefined;
        return row
          ? ConnectionRecordSchema.parse(this.nativeRecord(row.command_key, 4096).value)
          : null;
      },
      completed: (key) =>
        this.store.receipt(`native-connection:${key}:complete`)
          ? ConnectionRecordSchema.parse(
              this.nativeRecord(`native-connection:${key}:complete`, 4096).value,
            )
          : null,
      append: (record) =>
        this.store.transaction(() => {
          const value = ConnectionRecordSchema.parse(record);
          const artifact = this.nativeArtifact(value);
          if (value.phase === 'intent')
            this.store.saveReceipt(value.key, value.requestHash, 'local-owner', {
              outcome: 'blocked',
              reason: 'anthropic-connection-check-pending',
              next: 'Wait for the native sign-in check.',
            });
          this.store.saveReceipt(
            `native-connection:${value.key}:${value.phase}`,
            artifact.hash,
            'local-owner',
            { outcome: 'applied', entity: artifact },
          );
        }),
    });
    return this.connectionChecks;
  }

  async checkNativeConnection(
    this: Controller,
    command: Extract<Command, { command: 'CheckNativeConnection' }>,
    principal: string,
  ): Promise<CommandResult> {
    const hash = hashCanonical(command);
    const receipt = this.store.receipt(command.key);
    if (receipt && (receipt.hash !== hash || receipt.principal !== principal))
      return { outcome: 'denied', reason: 'idempotency-key-reused' };
    if (receipt && receipt.result.reason !== 'anthropic-connection-check-pending')
      return {
        ...receipt.result,
        ...(receipt.result.outcome === 'applied' ? { outcome: 'already-applied' as const } : {}),
      };
    if (command.expectedRevision !== 0) return { outcome: 'stale-revision', revision: 0 };
    const usageBlocker = this.anthropicUsage().blocker();
    if (usageBlocker) return { outcome: 'blocked', reason: usageBlocker };
    const directory = join(this.home, 'native', `connection-${command.key}`);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      return { outcome: 'blocked', reason: 'anthropic-connection-storage-failed' };
    }
    const result = await this.nativeConnections().check(
      {
        key: command.key,
        requestHash: hash,
        profile: this.anthropicChatProfile(),
        directory,
        repositoryRoot: this.home,
      },
      { spawn: this.options.nativeSpawn, schedule: this.options.schedule },
    );
    if (result.outcome === 'denied') return result;
    // Metadata failures are terminal receipts. Task authority keeps its own fresh checks.
    try {
      this.store.transaction(() => {
        const current = this.store.receipt(command.key);
        if (current?.result.reason === 'anthropic-connection-check-pending')
          this.finishMetadataReceipt(command.key, result);
        else if (!current) this.store.saveReceipt(command.key, hash, principal, result);
      });
    } catch {
      return { outcome: 'blocked', reason: 'anthropic-connection-storage-failed' };
    }
    return result;
  }

  localControl(this: Controller): LocalControl {
    return LocalControlSchema.parse(
      this.store.localControl() ?? {
        revision: 0,
        connectionRevision: 0,
        endpoint: null,
        observation: null,
        selection: null,
        setupHash: null,
        operation: null,
      },
    );
  }

  saveLocal(this: Controller, control: LocalControl, bump = true) {
    // An unknown probe answer is a missing key; the stored JSON has no undefined.
    const { connectedWithoutToken, ...rest } = control;
    const next = LocalControlSchema.parse({
      ...rest,
      ...(connectedWithoutToken === undefined ? {} : { connectedWithoutToken }),
      revision: bump ? control.revision + 1 : control.revision,
    });
    this.store.putLocalControl(next);
    return next;
  }

  revokeLocalSecret(this: Controller) {
    this.localSecret?.secret.fill(0);
    this.localSecret = null;
  }

  localSecretMatches(this: Controller, control = this.localControl()) {
    return (
      !!control.endpoint &&
      !!this.localSecret &&
      this.localSecret.connectionRevision === control.connectionRevision &&
      this.localSecret.connectionHash ===
        localConfiguredConnectionHash(
          control.endpoint,
          control.connectionRevision,
          control.authMode,
        )
    );
  }

  /** Connected means a token is held for this connection or the probe found auth off. */
  localConnected(this: Controller, control = this.localControl()) {
    return (
      !!control.endpoint &&
      (control.connectedWithoutToken === true || this.localSecretMatches(control))
    );
  }

  /**
   * What a Local client sends. The saved mode names the connection identity and the probe decides
   * the credential, so the two can differ: a saved token mode meeting a runtime with auth off, or
   * a saved none mode meeting a runtime that wants a token.
   */
  localCredentials(this: Controller, placeholder?: string) {
    const control = this.localControl();
    if (this.localSecretMatches(control))
      return {
        token: placeholder ?? (this.localSecret?.secret.toString('utf8') as string),
        ...(control.authMode === 'none' ? { savedMode: 'none' as const } : {}),
      };
    return {
      authMode: 'none' as const,
      ...(control.authMode === 'token' ? { savedMode: 'token' as const } : {}),
    };
  }

  localConnection(this: Controller) {
    const control = this.localControl();
    const current =
      control.endpoint &&
      control.observation &&
      control.selection &&
      control.selection.observationHash === control.observation.observationHash;
    return resolveLocalConnection(
      current
        ? {
            endpoint: control.endpoint,
            authMode: control.authMode,
            connectionRevision: control.connectionRevision,
            observation: control.observation,
            selectionId: control.selection?.selectionId,
          }
        : undefined,
      {
        platform: this.options.localInput?.platform ?? process.platform,
        arch: this.options.localInput?.arch ?? process.arch,
        secretConfigured: this.localSecretMatches(control),
        connected: this.localConnected(control),
      },
    );
  }

  localSetup(this: Controller): LocalSetup {
    const control = this.localControl();
    const generation = this.store.localGenerationBlocker();
    const secretConfigured = this.localSecretMatches(control);
    const connected = this.localConnected(control);
    const choice = control.observation?.models.find(
      (value) => value.selectionId === control.selection?.selectionId,
    );
    const reason: LocalSetup['reason'] =
      generation ??
      (control.operation
        ? control.operation.kind === 'input'
          ? control.operation.state === 'unknown'
            ? 'input-unknown'
            : 'input-active'
          : control.operation.state === 'unknown'
            ? 'discovery-unknown'
            : 'discovery-active'
        : !control.endpoint
          ? 'unconfigured'
          : control.authMode === 'token' && !this.options.localInputHelper
            ? 'capability-unavailable'
            : control.connectionFailed
              ? 'connection-unavailable'
              : !connected
                ? 'connection-required'
                : !control.observation || control.observationStale
                  ? 'discovery-required'
                  : !control.selection
                    ? 'model-selection-required'
                    : control.selection.observationHash !== control.observation.observationHash
                      ? 'selection-stale'
                      : !choice
                        ? 'setup-unavailable'
                        : choice.state === 'installed-unloaded'
                          ? 'model-unloaded'
                          : choice.state !== 'loaded-eligible'
                            ? 'model-incompatible'
                            : 'qualification-pending');
    return LocalSetupSchema.parse({
      revision: control.revision,
      connectionRevision: control.connectionRevision,
      connectorId: 'local-sdk-v1',
      endpoint: control.endpoint,
      setupHash: control.setupHash,
      connectionHash: control.endpoint
        ? localConfiguredConnectionHash(
            control.endpoint,
            control.connectionRevision,
            control.authMode,
          )
        : null,
      secretConfigured,
      authMode: control.authMode,
      connected,
      ...(control.connectedWithoutToken === undefined
        ? {}
        : { connectedWithoutToken: control.connectedWithoutToken }),
      operation: control.operation
        ? {
            kind: control.operation.kind,
            operationId: control.operation.binding.operationId,
            state: control.operation.state,
          }
        : null,
      generation: generation === 'generation-unknown' ? 'unknown' : generation ? 'active' : 'idle',
      observation: control.observation,
      observedAt: control.observedAt,
      ...(control.observationStale ? { observationStale: true as const } : {}),
      contextTokens: choice?.contextLength ?? null,
      availableMemoryBytes: control.availableMemoryBytes,
      selection: control.selection,
      reason,
    });
  }

  /**
   * The remembered token's two commands. They carry no expected revision and take no receipt, so
   * the value reaches the in-memory cell and nothing else: no journal row, event or snapshot.
   */
  localTokenCommand(
    this: Controller,
    command: Extract<Command, { command: 'SupplyLocalToken' | 'ReadLocalToken' }>,
  ): CommandResult {
    if (command.actor.kind !== 'desktop')
      return { outcome: 'denied', reason: 'desktop-actor-only' };
    const control = this.localControl();
    if (command.command === 'ReadLocalToken')
      return {
        outcome: 'applied',
        data: {
          kind: 'local-token',
          token: this.localSecretMatches(control)
            ? (this.localSecret?.secret.toString('utf8') ?? null)
            : null,
        },
      };
    const { endpoint } = control;
    if (!endpoint) return { outcome: 'blocked', reason: 'local-not-configured' };
    return this.store.transaction((): CommandResult => {
      const blocker = this.store.localStartBlocker();
      if (blocker || control.operation)
        return { outcome: 'blocked', reason: blocker ?? 'local-operation-active' };
      this.revokeLocalSecret();
      this.localSecret = {
        connectionRevision: control.connectionRevision,
        connectionHash: localConfiguredConnectionHash(
          endpoint,
          control.connectionRevision,
          control.authMode,
        ),
        secret: Buffer.from(command.payload.token),
        supplied: true,
      };
      // The desktop built the connect that follows on the revision it read before this hand
      // over, so the hand over keeps that revision. That connect clears the same two marks.
      this.saveLocal({ ...control, connectedWithoutToken: false, connectionFailed: false }, false);
      return { outcome: 'applied' };
    });
  }

  localCommand(
    this: Controller,
    command: Extract<
      Command,
      {
        command:
          | 'ConfigureLocal'
          | 'BeginLocalConnectionInput'
          | 'CancelLocalConnectionInput'
          | 'DisconnectLocal'
          | 'RefreshLocalModels'
          | 'SelectLocalModel';
      }
    >,
    effects: (() => void)[],
  ): CommandResult {
    let control = this.localControl();
    const applied = (): CommandResult => {
      const setup = this.localSetup();
      return { outcome: 'applied', revision: setup.revision };
    };
    if (command.command === 'DisconnectLocal') {
      this.revokeLocalSecret();
      control = this.saveLocal({
        ...control,
        connectionRevision: control.connectionRevision + 1,
        connectedWithoutToken: undefined,
        connectionFailed: false,
        observation: null,
        observedAt: null,
        observationStale: false,
        selection: null,
        selectedModelKey: null,
        setupHash: null,
        operation: control.operation
          ? {
              ...control.operation,
              revoked: true,
              state: control.operation.state === 'unknown' ? 'unknown' : 'stopping',
            }
          : null,
      });
      effects.push(() => {
        if (this.localOperation) {
          this.localOperation.stopped = true;
          this.localOperation.handle?.stop();
        }
        for (const runtime of this.localWriters.values()) {
          runtime.stopped = true;
          runtime.handle?.stop();
        }
      });
      return applied();
    }
    if (command.command === 'CancelLocalConnectionInput') {
      if (
        control.operation?.kind !== 'input' ||
        control.operation.binding.operationId !== command.payload.operationId
      )
        return { outcome: 'blocked', reason: 'local-input-not-current' };
      this.revokeLocalSecret();
      this.saveLocal({
        ...control,
        operation: {
          ...control.operation,
          revoked: true,
          state: control.operation.state === 'unknown' ? 'unknown' : 'stopping',
        },
      });
      effects.push(() => {
        if (this.localOperation?.operationId === command.payload.operationId) {
          this.localOperation.stopped = true;
          this.localOperation.handle?.stop();
        }
      });
      return applied();
    }
    const blocker = this.store.localStartBlocker();
    if (blocker) return { outcome: 'blocked', reason: blocker };
    if (command.command === 'ConfigureLocal') {
      const authMode = command.payload.authMode ?? 'token';
      if (control.endpoint === command.payload.endpoint && control.authMode === authMode)
        return applied();
      this.revokeLocalSecret();
      this.saveLocal({
        ...control,
        endpoint: command.payload.endpoint,
        authMode,
        connectedWithoutToken: undefined,
        connectionFailed: false,
        connectionRevision: control.connectionRevision + 1,
        observation: null,
        observedAt: null,
        observationStale: false,
        selection: null,
        selectedModelKey: null,
        setupHash: null,
        operation: null,
      });
      return applied();
    }
    if (!control.endpoint) return { outcome: 'blocked', reason: 'local-not-configured' };
    if (command.command === 'SelectLocalModel') {
      const picked = control.observation?.models.find(
        (value) => value.selectionId === command.payload.selectionId,
      );
      if (
        !control.observation ||
        control.observationStale ||
        command.payload.observationHash !== control.observation.observationHash ||
        !picked
      )
        return { outcome: 'blocked', reason: 'local-selection-stale' };
      this.saveLocal({
        ...control,
        selection: command.payload,
        selectedModelKey: picked.identity.modelKey,
        setupHash: hashCanonical({
          version: 2,
          connectionHash: localConfiguredConnectionHash(
            control.endpoint,
            control.connectionRevision,
            control.authMode,
          ),
          ...command.payload,
        }),
      });
      return applied();
    }
    if (control.authMode === 'token' && !this.options.localInputHelper)
      return { outcome: 'blocked', reason: 'local-input-unavailable' };
    if (command.command === 'RefreshLocalModels' && !this.localConnected(control))
      return { outcome: 'blocked', reason: 'local-connection-required' };
    const kind = command.command === 'BeginLocalConnectionInput' ? 'input' : 'discovery';
    // A token the desktop supplied for this connection survives the connect that uses it.
    if (kind === 'input' && !(this.localSecret?.supplied && this.localSecretMatches(control)))
      this.revokeLocalSecret();
    const suppliedHeld = kind === 'input' && this.localSecretMatches(control);
    const binding = {
      version: kind === 'input' ? (2 as const) : (1 as const),
      operationId: command.key,
      nonce: hashCanonical({
        operationId: command.key,
        connectionRevision: control.connectionRevision,
        at: this.now(),
      }),
      connectionHash: localConfiguredConnectionHash(
        control.endpoint,
        control.connectionRevision,
        control.authMode,
      ),
      connectionRevision: control.connectionRevision,
    };
    this.saveLocal({
      ...control,
      // A new connect starts from nothing known. The probe answers it.
      connectedWithoutToken:
        kind === 'input' ? (suppliedHeld ? false : undefined) : control.connectedWithoutToken,
      connectionFailed: false,
      observationStale: kind === 'input' ? !!control.observation : control.observationStale,
      selection: kind === 'discovery' ? control.selection : null,
      setupHash: kind === 'discovery' ? control.setupHash : null,
      operation: {
        kind,
        binding,
        state: 'intent',
        group: null,
        revoked: false,
        clientQuiescent: false,
      },
    });
    effects.push(() => this.launchLocalOperation(binding.operationId));
    return applied();
  }

  localOperationCurrent(this: Controller, operationId: string) {
    const control = this.localControl();
    const operation = control.operation;
    if (
      this.closed ||
      !control.endpoint ||
      !operation ||
      operation.binding.operationId !== operationId ||
      operation.revoked ||
      operation.state === 'unknown' ||
      operation.binding.connectionRevision !== control.connectionRevision ||
      operation.binding.connectionHash !==
        localConfiguredConnectionHash(
          control.endpoint,
          control.connectionRevision,
          control.authMode,
        ) ||
      this.store.localGenerationBlocker()
    )
      throw Error('Local operation authority changed.');
    return { control, operation };
  }

  launchLocalOperation(this: Controller, operationId: string) {
    if (this.closed) return;
    const initial = this.localControl();
    const operation = initial.operation;
    if (!operation || operation.binding.operationId !== operationId) return;
    const completion = Promise.withResolvers<void>();
    const runtime: LocalOperationRuntime = {
      operationId,
      stopped: false,
      done: completion.promise,
    };
    this.localOperation = runtime;
    let requested = false;
    const finish = (
      value: LocalInputResult | Awaited<ReturnType<typeof startLocalDiscovery>['result']> | null,
    ) => {
      try {
        this.store.transaction(() => {
          const control = this.localControl();
          const current = control.operation;
          if (!current || current.binding.operationId !== operationId) {
            if (value && 'candidate' in value) value.candidate.discard();
            return;
          }
          const clientQuiescent =
            !requested ||
            (value !== null &&
              ('kind' in value
                ? value.kind === 'ready' || value.clientQuiescent
                : value.clientQuiescent));
          const ownershipUnknown =
            value &&
            ('terminal' in value
              ? value.terminal.kind === 'unavailable' && value.terminal.reason === 'ownership'
              : value.kind !== 'ready' && value.reason === 'ownership');
          // Closing the token window by hand, or revoking it, ends in a known state. The window
          // holds no runtime session, and the value it read is discarded either way.
          const windowClosed =
            current.kind === 'input' &&
            current.group !== null &&
            current.state !== 'unknown' &&
            (current.revoked ||
              (value !== null && 'kind' in value && value.kind === 'cancelled')) &&
            !(value && 'kind' in value && value.kind === 'ready');
          const known =
            windowClosed ||
            (!ownershipUnknown &&
              clientQuiescent &&
              (!requested ||
                (current.group !== null &&
                  current.state !== 'unknown' &&
                  (current.kind === 'input' || current.clientQuiescent))));
          const live =
            !this.closed &&
            !runtime.stopped &&
            !current.revoked &&
            current.binding.connectionRevision === control.connectionRevision &&
            !!control.endpoint &&
            current.binding.connectionHash ===
              localConfiguredConnectionHash(
                control.endpoint,
                control.connectionRevision,
                control.authMode,
              ) &&
            !this.store.localGenerationBlocker();
          let observation = control.observation;
          let { observedAt, observationStale, availableMemoryBytes, selectedModelKey } = control;
          let { connectedWithoutToken } = control;
          let selection = control.selection;
          let setupHash = control.setupHash;
          if (known && live && value && 'kind' in value && value.kind === 'ready') {
            const secret = value.candidate.take(current.binding);
            if (secret)
              this.localSecret = {
                connectionRevision: control.connectionRevision,
                connectionHash: current.binding.connectionHash,
                secret: Buffer.from(secret),
              };
            // The probe found the runtime wants a token, and this connection now holds one.
            if (secret) connectedWithoutToken = false;
          } else if (value && 'candidate' in value) value.candidate.discard();
          if (
            known &&
            live &&
            value &&
            'terminal' in value &&
            value.terminal.kind === 'observed' &&
            hashCanonical(value.terminal.binding) === hashCanonical(current.binding)
          ) {
            const nextObservation = LocalModelObservationSchema.parse(value.terminal.observation);
            // Setups saved before the key existed name the model through their selected choice.
            selectedModelKey ??=
              observation?.models.find((choice) => choice.selectionId === selection?.selectionId)
                ?.identity.modelKey ?? null;
            const kept = retainedSelection(selectedModelKey, nextObservation);
            observation = nextObservation;
            observedAt = this.now();
            observationStale = false;
            availableMemoryBytes = availableMemory() ?? null;
            if (kept && control.endpoint) {
              selection = {
                selectionId: kept.selectionId,
                observationHash: nextObservation.observationHash,
              };
              setupHash = hashCanonical({
                version: 2,
                connectionHash: localConfiguredConnectionHash(
                  control.endpoint,
                  control.connectionRevision,
                  control.authMode,
                ),
                ...selection,
              });
            } else {
              selection = null;
              selectedModelKey = null;
              setupHash = null;
            }
          } else if (known && live && current.kind === 'discovery') {
            // A read that failed leaves the last one on view, labelled, with the selection off. The
            // model key stays, so the next read selects the same model again.
            observationStale = !!observation;
            selection = null;
            setupHash = null;
          }
          const proof = this.nativeArtifact({
            operationId,
            kind: current.kind,
            binding: current.binding,
            clientQuiescent,
            known,
            revoked: !live,
            observation,
          });
          this.store.saveReceipt(`local-operation:${operationId}`, proof.hash, 'local-owner', {
            outcome: known ? 'applied' : 'outcome-unknown',
            entity: proof,
          });
          const failedConnection =
            control.connectedWithoutToken === true &&
            known &&
            live &&
            current.kind === 'discovery' &&
            (!value || !('terminal' in value) || value.terminal.kind !== 'observed');
          this.saveLocal({
            ...control,
            connectedWithoutToken: failedConnection ? undefined : connectedWithoutToken,
            connectionFailed: failedConnection,
            observation,
            observedAt,
            observationStale,
            availableMemoryBytes,
            selection,
            selectedModelKey,
            setupHash,
            operation: known ? null : { ...current, state: 'unknown' },
          });
        });
      } catch {
        this.revokeLocalSecret();
        if (value && 'candidate' in value) value.candidate.discard();
        try {
          this.store.transaction(() => {
            const control = this.localControl();
            if (control.operation?.binding.operationId === operationId)
              this.saveLocal({ ...control, operation: { ...control.operation, state: 'unknown' } });
          });
        } catch {}
      } finally {
        if (this.localOperation === runtime) this.localOperation = undefined;
        completion.resolve();
      }
    };
    try {
      if (this.closed || operation.revoked) return finish(null);
      const { control } = this.localOperationCurrent(operationId);
      const directory = join(this.home, 'local-operations', operationId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const own = (group: number) => {
        this.store.transaction(() => {
          const { control, operation } = this.localOperationCurrent(operationId);
          if (!Number.isSafeInteger(group) || group <= 0 || operation.state !== 'intent')
            throw Error('Local operation group is invalid.');
          this.saveLocal({ ...control, operation: { ...operation, group, state: 'owned' } });
        });
      };
      if (operation.kind === 'input') {
        const launchInput = () => {
          runtime.handle = startLocalSecretInput(
            { binding: operation.binding, endpoint: control.endpoint },
            this.options.localInputHelper,
            {
              ...this.options.localInput,
              schedule: this.options.schedule,
              launch: (executable, settings) => {
                requested = true;
                const child =
                  this.options.localInput?.launch?.(executable, settings) ??
                  (() => {
                    const child = spawn(executable, [], settings);
                    return {
                      group: child.pid ?? 0,
                      input: child.stdin,
                      output: child.stdio[3],
                      onSpawn: (handler: () => void) => {
                        child.once('spawn', handler);
                      },
                      onError: (handler: () => void) => {
                        child.once('error', handler);
                      },
                      onClose: (
                        handler: (code: number | null, signal: NodeJS.Signals | null) => void,
                      ) => {
                        child.once('close', handler);
                      },
                    };
                  })();
                try {
                  own(child.group);
                  return child;
                } catch {
                  return { ...child, input: null };
                }
              },
            },
          );
          const handle = runtime.handle as ReturnType<typeof startLocalSecretInput>;
          void handle.result.then(finish, () => finish(null));
        };
        // The probe runs on every connect, in both saved modes, and writes only the connection's
        // `connectedWithoutToken`. A runtime that answers without a token connects with none. One
        // that does not opens the token window for this connection, whatever mode is saved. A cold
        // runtime can miss the first probe, so a miss is tried once more before the window opens.
        const endpoint = control.endpoint;
        if (!endpoint) throw Error('Local endpoint is unavailable.');
        const probe = this.options.localProbe ?? probeLocalWithoutToken;
        void (async () => {
          let open = await probe(endpoint).catch(() => false);
          if (!open && !runtime.stopped && !this.closed)
            open = await probe(endpoint).catch(() => false);
          return open;
        })().then((open) => {
          const supplied =
            this.localSecret?.supplied && this.localSecretMatches(this.localControl());
          if (!open && supplied && !runtime.stopped && !this.closed) {
            // The desktop supplied the token for this connect. No window opens.
            if (this.localSecret) this.localSecret.supplied = false;
            return finish(null);
          }
          if (!open || runtime.stopped || this.closed) {
            try {
              if (runtime.stopped || this.closed) return finish(null);
              this.localOperationCurrent(operationId);
              this.revokeLocalSecret();
              launchInput();
            } catch {
              finish(null);
            }
            return;
          }
          finish(null);
          this.store.transaction(() => {
            const current = this.localControl();
            if (
              current.operation ||
              current.endpoint !== endpoint ||
              current.connectionRevision !== control.connectionRevision
            )
              return;
            this.revokeLocalSecret();
            this.saveLocal({
              ...current,
              connectedWithoutToken: true,
              connectionFailed: false,
              observationStale: !!current.observation,
              selection: null,
              setupHash: null,
            });
          });
        });
      } else {
        if (!this.localConnected(control)) throw Error('Local connection is unavailable.');
        // Read once per observation. The read is far shorter than discovery, so it lands first.
        void refreshAvailableMemory();
        const credentials = this.localCredentials();
        const handle = startLocalDiscovery(
          {
            kind: 'discovery',
            binding: { ...operation.binding, version: 1 },
            endpoint: control.endpoint as string,
            ...credentials,
            timeoutMs: 20000,
          },
          directory,
          {
            ...this.options.localDiscovery,
            schedule: this.options.schedule,
            lifecycle: {
              beforePhase: () => {
                this.localOperationCurrent(operationId);
                requested = true;
              },
              owned: (_phase, group) => {
                own(group);
              },
              quiescent: (_phase, group) => {
                this.store.transaction(() => {
                  const current = this.localControl();
                  if (
                    current.operation?.binding.operationId !== operationId ||
                    current.operation.group !== group
                  )
                    throw Error('Local discovery closure changed.');
                  this.saveLocal({
                    ...current,
                    operation: { ...current.operation, clientQuiescent: true },
                  });
                });
              },
            },
          },
        );
        runtime.handle = handle;
        void handle.result.then(finish, () => finish(null));
      }
      if (runtime.stopped || this.closed) runtime.handle?.stop();
    } catch {
      finish(null);
    }
  }

  resolveProfiles(this: Controller): NativeProfileResolution[] {
    const profiles = [
      ...(this.options.nativeProfiles?.() ?? [
        this.options.nativeProfile?.() ?? unavailableNativeProfile(),
      ]),
    ];
    if (this.options.registerGoogleAcp || this.options.googleAcp)
      profiles.push(this.acpResolution());
    const localIndex = profiles.findIndex((profile) => profile.facts.family === 'local');
    if (localIndex >= 0) profiles.splice(localIndex, 1);
    profiles.push({ facts: this.localConnection().facts });
    if (
      profiles.length > 7 ||
      new Set(profiles.map((profile) => profile.facts.id)).size !== profiles.length
    )
      throw Error('Native profile identities are invalid.');
    for (const profile of profiles) NativeProfileSchema.parse(profile.facts);
    return profiles;
  }

  profileFor(this: Controller, id: string): NativeProfileResolution {
    this.profiles = this.resolveProfiles();
    return this.profiles.find((profile) => profile.facts.id === id) ?? unavailableNativeProfile();
  }

  acpProof(this: Controller, proofId = this.store.googleAcpSetup().proofId): AcpSetupProof | null {
    if (!proofId) return null;
    const artifact = this.store.get<Artifact>('artifact', proofId);
    if (!artifact || artifact.bytes > MAX_FRAME_BYTES)
      throw Error('ACP setup proof is unavailable.');
    const bytes = this.artifacts.read(artifact.hash);
    if (bytes.length !== artifact.bytes) throw Error('ACP setup proof changed.');
    return AcpSetupProofSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  }

  acpResolution(this: Controller): NativeProfileResolution & AcpProfileResolution {
    let proof: AcpSetupProof | null = null;
    try {
      proof = this.acpProof();
    } catch {}
    const resolved =
      this.options.googleAcp?.resolve?.(proof) ??
      resolveGoogleAcpProfile({ home: this.home, proof, environment: process.env });
    return {
      ...resolved,
      ...(resolved.client && resolved.environment
        ? {
            locationHash: hashCanonical({
              executable: resolved.client.executable,
              client: resolved.client.sha256,
              home: resolved.environment.HOME,
            }),
          }
        : {}),
    };
  }
}
