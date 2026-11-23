import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Artifact,
  type Command,
  type CommandResult,
  CommandResultSchema,
  CommandSchema,
  GOOGLE_RECOVERY_HOLD_COPY,
  GoogleAcpSetupSchema,
  isOpenAiLocalEndpoint,
  LocalModelObservationSchema,
  type LocalSetup,
  LocalSetupSchema,
  MAX_FRAME_BYTES,
  NativeProfileSchema,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import { logTiming, timed } from '../diagnostics/timing.ts';
import { groupAbsent } from '../host/worker.ts';
import {
  ConnectionRecordSchema,
  NativeConnectionChecks,
} from '../providers/anthropic/native-connection.ts';
import {
  newerClientVersion,
  newestByVersion,
  readManagedRecord,
} from '../providers/client-versions.ts';
import type { GoogleAgent } from '../providers/google/acp/agents.ts';
import {
  GoogleAcpInstallation,
  InstallRecordSchema,
} from '../providers/google/acp/install-operation.ts';
import {
  ACP_EARNED_REVIEW,
  type AcpClient,
  type AcpProfileResolution,
  type AcpSetupProof,
  AcpSetupProofSchema,
  acpAgentIdentity,
  isAcpBundle,
  resolveGoogleAcpProfile,
  validateAcpSetupProof,
} from '../providers/google/acp/profile.ts';
import { startGoogleAcpSetup } from '../providers/google/acp/writer.ts';
import {
  LOCAL_PROBE_TIMEOUTS_MS,
  type LocalProbe,
  probeLocal,
} from '../providers/local/chat-connect.ts';
import {
  localConfiguredConnectionHash,
  resolveLocalConnection,
  retainedSelection,
} from '../providers/local/connection.ts';
import { availableMemory, refreshAvailableMemory } from '../providers/local/hardware.ts';
import { readOpenAiObservation } from '../providers/local/openai-compat.ts';
import { startLocalDiscovery } from '../providers/local/replacement.ts';
import { type LocalInputResult, startLocalSecretInput } from '../providers/local/secure-input.ts';
import {
  type NativeProfileResolution,
  unavailableNativeProfile,
} from '../providers/openai/profile.ts';
import {
  LOCAL_SERVER_WANTS_TOKEN,
  LOCAL_TOKEN_SETUP_NOTICE,
  localTokenRefusal,
} from '../providers/platform.ts';
import type { Controller } from './controller.ts';
import { recoverGoogleMetadata, SIGN_IN_RELEASED } from './google-recovery.ts';
import { googleTermsAcknowledged } from './google-terms.ts';
import {
  type AcpSetupCommand,
  type LocalControl,
  LocalControlSchema,
  type LocalOperationRuntime,
} from './schemas.ts';

// Provider setup: ACP install and sign-in, connection checks, the Local connection and profiles.
// The diagnostics bundle carries this many of the newest Google client operations.
const GOOGLE_DIAGNOSTIC_OPERATIONS = 50;
// The connection revision at which a no-authentication connect met a runtime that wants a token.
// Memory only: the next connect probes again.
const tokenAsked = new WeakMap<object, number>();
// Connects started with no person at the window, by operation ID, per controller. Memory only:
// the operation is launched by the same controller that accepted it.
const unattendedConnects = new WeakMap<object, Set<string>>();
const unattended = (controller: object) => {
  const ids = unattendedConnects.get(controller) ?? new Set<string>();
  unattendedConnects.set(controller, ids);
  return ids;
};

/**
 * Whether a connect's probe answer opens the token window. Only a person at the window gets one,
 * and only when the runtime asked for a token this computer can take and none was supplied.
 */
export function opensTokenWindow(
  found: string,
  options: { supplied: boolean; unattended: boolean; refused: boolean },
): boolean {
  return found === 'token-required' && !options.supplied && !options.unattended && !options.refused;
}
// A deliberate model refresh runs the discover step from Ready. It has no setup state of its own.
type SetupCommand = AcpSetupCommand | Extract<Command, { command: 'RefreshGoogleAcpModels' }>;
const profileReads = new WeakMap<object, { profiles?: NativeProfileResolution[] }>();

export class ProviderCommands {
  executeAcpSetup(
    this: Controller,
    command: SetupCommand,
    principal: string,
  ): Promise<CommandResult> {
    // A quota read holds the Google journal for at most its 20 second deadline. The quota read
    // starts each time the desktop connects, so a setup step pressed on the welcome screen meets
    // it. The step waits for the read to end and then runs.
    const reading =
      command.command === 'StopGoogleAcpSetup' || this.acpSetupRuntime?.key === command.key
        ? undefined
        : this.usageRead?.promise;
    if (reading) {
      const run = () => this.startAcpSetup(command, principal);
      return reading.then(run, run);
    }
    return this.startAcpSetup(command, principal);
  }

  startAcpSetup(
    this: Controller,
    command: SetupCommand,
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
          // A row recovery settled has no known result, so a replayed key stays unknown.
          const known = journal?.state === 'quiescent' && journal.settlement !== 'owner-absent';
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

  applyAcpSetup(this: Controller, command: SetupCommand, effects: (() => void)[]): CommandResult {
    const setup = this.store.googleAcpSetup();
    if (command.command === 'StopGoogleAcpSetup') {
      if (
        setup.state === 'unknown' &&
        setup.operationId === command.payload.operationId &&
        this.acpSetupRuntime?.key !== setup.operationId
      )
        return this.clearUnknownAcpSetup(setup);
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
      // A running step took its one revision at begin and publishes against it. Stopping it moves
      // no revision, so the step's own completion still writes the stopped state.
      const next = GoogleAcpSetupSchema.parse({
        ...setup,
        revision: live ? setup.revision : setup.revision + 1,
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
    // A qualify step sets up a copy that is not in use yet: one the controller found newer, the
    // next copy when the one in use is gone, or a copy waiting for the sign-in the person starts
    // with Connect. From Ready it runs like a refresh, so Ready and the copy in use stay unless
    // the new copy passes.
    let target = this.acpQualifyTarget?.key === command.key ? this.acpQualifyTarget : undefined;
    if (!target && command.command === 'AuthenticateGoogleAcp' && setup.state === 'ready') {
      const waiting = this.waitingGoogleAgent();
      if (waiting) target = { key: command.key, client: acpAgentIdentity(waiting), signIn: true };
    }
    const refresh =
      command.command === 'RefreshGoogleAcpModels' || (!!target && setup.state === 'ready');
    // A refresh starts from a setup that holds a proof and no step. Anything else connects first.
    if (refresh && (setup.state !== 'ready' || setup.operationId))
      return {
        outcome: 'blocked',
        reason: 'acp-setup-not-current',
        data: { kind: 'google-acp-setup', setup },
      };
    const installBlocker = this.googleInstallationBlocker();
    if (installBlocker) return installBlocker;
    const blocker = this.store.googleOperationBlocker();
    if (blocker)
      return { outcome: 'blocked', reason: blocker, data: { kind: 'google-acp-setup', setup } };
    const resolved = this.acpResolution();
    if (!resolved.client || !resolved.environment)
      return {
        outcome: 'blocked',
        reason: resolved.facts.reason,
        data: { kind: 'google-acp-setup', setup },
      };
    const client: AcpClient = target?.client ?? resolved.client;
    const resolution = { ...resolved, client };
    const operation = target
      ? 'qualify'
      : command.command === 'InitializeGoogleAcp'
        ? 'initialize'
        : refresh
          ? 'discover'
          : command.command === 'AuthenticateGoogleAcp'
            ? 'authenticate'
            : 'discover';
    let proof: AcpSetupProof | null = null;
    try {
      if (operation !== 'initialize' && operation !== 'qualify') {
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
      qualify: target?.signIn ? 'authenticating' : 'discovering',
    }[operation];
    // A refresh takes its one revision here and keeps Ready. The fence compares the row's revision
    // with the live one, so nothing else writes setup until the result publishes.
    const next = GoogleAcpSetupSchema.parse(
      refresh
        ? {
            ...setup,
            revision: setup.revision + 1,
            modelRefresh: {
              commandId: command.key,
              at: this.now(),
              outcome: 'running',
              reason: null,
              evidenceId: null,
            },
          }
        : {
            ...setup,
            revision: setup.revision + 1,
            state,
            operationId: command.key,
            reason: null,
          },
    );
    this.store.putGoogleAcpSetup(next);
    // A qualify step that signs in opens the browser like any sign-in, so recovery treats it as one.
    const kind =
      operation === 'qualify'
        ? target?.signIn
          ? 'acp-authenticate'
          : 'acp-discover'
        : (`acp-${operation}` as const);
    this.store.beginGoogleMetadata(command.key, kind, next.revision, this.now());
    this.store.recordLaunchIdentity(
      'google-metadata',
      command.key,
      this.launchIdentity,
      this.now(),
    );
    const qualify = target ? { signIn: target.signIn, previous: setup.modelRefresh } : undefined;
    effects.push(
      () =>
        void this.launchAcpSetup(
          command.key,
          next.revision,
          operation,
          proof,
          resolution,
          refresh,
          qualify,
        ),
    );
    return {
      outcome: 'outcome-unknown',
      reason: 'acp-setup-pending',
      data: { kind: 'google-acp-setup', setup: next },
    };
  }

  /**
   * An explicit Stop on a setup whose ownership is unknown, in a controller that holds no runtime
   * for it. It runs the same recovery as Recover, so the step clears only when a current probe
   * proves its group gone. The setup then goes to blocked with no operation, from where Connect
   * starts the step again, or to the person's sign-in when the step was a sign-in.
   */
  clearUnknownAcpSetup(
    this: Controller,
    setup: ReturnType<typeof GoogleAcpSetupSchema.parse>,
  ): CommandResult {
    const recovery = recoverGoogleMetadata(this, 'explicit');
    const next = this.store.googleAcpSetup();
    if (next.operationId !== setup.operationId)
      return {
        outcome: 'applied',
        ...(recovery.settled.some((row) => row.operation === 'acp-authenticate')
          ? { next: SIGN_IN_RELEASED }
          : {}),
        data: { kind: 'google-acp-setup', setup: next },
      };
    const hold = recovery.held.find((row) => row.commandId === setup.operationId);
    return {
      outcome: 'blocked',
      reason: 'google-ownership-unknown',
      next: GOOGLE_RECOVERY_HOLD_COPY[hold?.reason ?? 'no-process-identity'],
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
  googleAcpPreparationStep(
    this: Controller,
    attempted: ReadonlySet<string> = new Set(),
  ): 'initialize' | 'discover' | { qualify: AcpClient } | null {
    if (
      !this.options.registerGoogleAcp ||
      !this.store.hasConnectedOnce('google') ||
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
    // A copy newer than the one in use is checked in the background while the one in use serves
    // turns. Each copy is tried once per run, newest first.
    const untried = (clients: readonly AcpClient[]) =>
      newestByVersion(
        clients.filter((client) => !attempted.has(client.sha256)),
        (client) => client.version,
      );
    const agents = this.googleAgentPool().map(acpAgentIdentity);
    if (proof && setup.state === 'ready') {
      const inUse = resolution.client;
      const newer = untried(
        agents.filter((agent) => newerClientVersion(agent.version, inUse.version)),
      );
      return newer ? { qualify: newer } : null;
    }
    // The stored proof names an agent other than the bundle that the pool does not hold. Until
    // a scan has completed in this controller, or while the copy is on the device and only its
    // check did not finish, it is not gone, and nothing is set up in its place. Once it is truly
    // gone or refused, the next copy is set up on the saved sign-in with no press, the bundle
    // last, and turns wait meanwhile.
    let stored: AcpSetupProof | null = null;
    try {
      stored = this.acpProof(setup.proofId);
    } catch {}
    if (
      !proof &&
      stored?.reviewMode?.mappingEvidenceHash === ACP_EARNED_REVIEW &&
      stored.client.sha256 !== resolution.client.sha256
    ) {
      const named = stored.client.sha256;
      const gone =
        this.googleAgents !== null &&
        (this.googleRefused.has(named) || !this.googleUnverified.has(named));
      if (!gone || setup.auth.status !== 'authenticated') return null;
      const bundle = this.acpResolution([]).client;
      const next = untried([resolution.client, ...agents, ...(bundle ? [bundle] : [])]);
      return next ? { qualify: next } : null;
    }
    // Recovery of an interrupted sign-in marks the setup's sign-in unknown and keeps the older
    // proof. Discover would act on that sign-in, so the person signs in again first.
    if (proof?.auth.status === 'authenticated' && setup.auth.status === 'authenticated')
      return 'discover';
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
    // Steps by name, copies being qualified by digest, so a run walks down the pool.
    const attempted = new Set<string>();
    for (;;) {
      const step = this.googleAcpPreparationStep(attempted);
      const name = typeof step === 'string' || !step ? step : step.qualify.sha256;
      if (!step || !name || attempted.has(name)) return;
      attempted.add(name);
      const setup = this.store.googleAcpSetup();
      const key = this.id('cmd');
      if (typeof step !== 'string')
        this.acpQualifyTarget = { key, client: step.qualify, signIn: false };
      const command = CommandSchema.parse({
        protocol: 1,
        key,
        actor: { id: 'controller', kind: 'controller' },
        command: step === 'initialize' ? 'InitializeGoogleAcp' : 'DiscoverGoogleAcp',
        expectedRevision: setup.revision,
        payload: {
          profileId: 'google-acp-v1',
          consent: 'automatic',
          ...(step !== 'initialize' ? { proofId: setup.proofId } : {}),
        },
      }) as AcpSetupCommand;
      try {
        await this.executeAcpSetup(command, 'local-owner');
      } finally {
        if (this.acpQualifyTarget?.key === key) this.acpQualifyTarget = undefined;
      }
    }
  }

  async launchAcpSetup(
    this: Controller,
    commandId: string,
    revision: number,
    operation: 'initialize' | 'authenticate' | 'discover' | 'qualify',
    priorProof: AcpSetupProof | null,
    resolution: AcpProfileResolution,
    refresh = false,
    /** A copy not in use yet: whether the person signs in with it, and the refresh record to keep. */
    qualify?: {
      signIn: boolean;
      previous: ReturnType<typeof GoogleAcpSetupSchema.parse>['modelRefresh'];
    },
  ) {
    const runtime = this.acpSetupRuntime;
    if (!runtime || runtime.key !== commandId || !resolution.client || !resolution.environment)
      return;
    let result: CommandResult = { outcome: 'outcome-unknown', reason: 'google-ownership-unknown' };
    let beforeSpawn = true;
    // How the client run ended, once it has. Undefined while it never ran to an end.
    let ended: string | null | undefined;
    const current = () => {
      const setup = this.store.googleAcpSetup();
      if (
        this.closed ||
        runtime.stopped ||
        setup.revision !== revision ||
        (refresh
          ? setup.modelRefresh?.commandId !== commandId ||
            setup.modelRefresh.outcome !== 'running' ||
            setup.state !== 'ready'
          : setup.operationId !== commandId ||
            !['initializing', 'authenticating', 'discovering'].includes(setup.state))
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
        ...(qualify ? { signIn: qualify.signIn } : {}),
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
              this.store.finishGoogleMetadata(commandId, group, this.now(), 'closed'),
            ),
        },
      });
      if (runtime.stopped || this.closed) runtime.handle.stop();
      const outcome = await runtime.handle.result;
      ended = outcome.reason;
      this.store.transaction(() => {
        let setup = this.store.googleAcpSetup();
        const journal = this.store
          .googleMetadataOperations()
          .find((row) => row.command_id === commandId);
        // Only a normal close tells how the step ended. A row recovery settled stays unknown.
        const known = outcome.quiescent && journal?.settlement === 'closed';
        if (!known) this.store.unknownGoogleMetadata(commandId);
        if (refresh) {
          result = this.settleModelRefresh(
            commandId,
            revision,
            runtime,
            outcome,
            known,
            resolution,
            qualify,
          );
          this.finishMetadataReceipt(commandId, result);
          this.profiles = this.resolveProfiles();
          return;
        }
        // The setup moves only while it still names this step at the revision the step began
        // with. Anything newer, such as recovery's release, stays as it is.
        const current = setup.operationId === commandId && setup.revision === revision;
        // The fence reads the live authority inside this transaction, before the write below
        // moves the revision.
        const revoked =
          this.closed || runtime.stopped || !this.store.googleMetadataPublishable(commandId);
        let proofId = setup.proofId,
          client = setup.client,
          auth = setup.auth;
        let ready = false;
        // An initialize whose reply named no personal sign-in has nothing to sign in with. Its
        // proof is not kept, so the next Connect step is another initialize, never a sign-in that
        // the client would refuse as if the person had.
        let incomplete = false;
        if (known && !revoked && !outcome.reason && outcome.metadata) {
          const proof = validateAcpSetupProof(
            outcome.metadata,
            resolution.client as AcpClient,
            this.options.googleAcp?.reviewMappings,
          );
          incomplete =
            operation === 'initialize' &&
            !proof.capabilities.authMethods.includes('oauth-personal');
          proofId = incomplete ? null : this.nativeArtifact(proof).id;
          client = proof.client;
          auth = incomplete ? setup.auth : proof.auth;
          ready =
            !!proof.reviewMode && !!proof.configOptions && proof.auth.status === 'authenticated';
        }
        if (current) {
          setup = GoogleAcpSetupSchema.parse({
            ...setup,
            revision: setup.revision + 1,
            state: !known
              ? 'unknown'
              : ready
                ? 'ready'
                : !revoked && !outcome.reason && operation === 'initialize' && !incomplete
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
                  : !revoked && (operation === 'discover' || operation === 'qualify' || incomplete)
                    ? 'acp-capability-missing'
                    : null,
          });
          this.store.putGoogleAcpSetup(setup);
        }
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
    } catch (error) {
      try {
        this.store.transaction(() => {
          const journal = this.store
            .googleMetadataOperations()
            .find((row) => row.command_id === commandId);
          if (beforeSpawn && journal?.state === 'intent')
            this.store.finishGoogleMetadata(commandId, null, this.now(), 'closed');
          else if (journal?.state !== 'quiescent') this.store.unknownGoogleMetadata(commandId);
          const finished = this.store
            .googleMetadataOperations()
            .find((row) => row.command_id === commandId);
          const known = finished?.state === 'quiescent' && finished.settlement !== 'owner-absent';
          const setup = this.store.googleAcpSetup();
          // As at completion: only a setup that still names this step moves.
          // A refresh is named on the setup by its model refresh record, which keeps Ready.
          const current = refresh
            ? setup.modelRefresh?.commandId === commandId && setup.revision === revision
            : setup.operationId === commandId && setup.revision === revision;
          const next = current
            ? GoogleAcpSetupSchema.parse(
                refresh
                  ? {
                      ...setup,
                      revision: setup.revision + 1,
                      modelRefresh: {
                        ...setup.modelRefresh,
                        outcome: known ? 'failed' : 'unknown',
                        // A refresh that could not start keeps why, as a failed read does.
                        evidenceId: known
                          ? this.nativeArtifact({
                              operation: 'model-refresh',
                              commandId,
                              reason: 'start',
                              diagnostic:
                                error instanceof Error ? error.message.slice(0, 1000) : null,
                            }).id
                          : null,
                      },
                    }
                  : {
                      ...setup,
                      revision: setup.revision + 1,
                      state: known ? 'blocked' : 'unknown',
                      operationId: known ? null : commandId,
                      reason: null,
                    },
              )
            : setup;
          if (current) this.store.putGoogleAcpSetup(next);
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
      // What the step showed about a build other than the bundle goes on the card before the
      // step ends, so the next preparation step reads it. A stopped step showed nothing.
      if (
        (qualify || !isAcpBundle(resolution.client)) &&
        ended !== undefined &&
        !runtime.stopped &&
        !this.closed
      )
        try {
          const setup = this.store.googleAcpSetup();
          this.judgeGoogleAgent(
            resolution.client,
            {
              // The step itself made this build the one in use. A failed refresh leaves Ready on
              // the same build and passes nothing.
              passed:
                result.outcome === 'applied' &&
                setup.state === 'ready' &&
                setup.client?.sha256 === resolution.client.sha256,
              reason: ended,
              refusal: runtime.handle?.refusal() ?? null,
            },
            !!qualify,
          );
          this.profiles = this.resolveProfiles();
        } catch {}
      runtime.resolve(CommandResultSchema.parse(result));
    }
    // The quota read waits for Connect. The step that makes the setup ready starts the first one,
    // once this step's runtime has let go of the Google journal. A harness that drives each step
    // leaves registration off and reads when it chooses, as it does for the launch steps.
    if (
      this.options.registerGoogleAcp &&
      result.outcome === 'applied' &&
      this.store.googleAcpSetup().state === 'ready'
    )
      void runtime.promise.then(() => this.refreshGoogleUsage('connect')).catch(() => {});
  }

  /**
   * Publishes or records the end of a model refresh, inside the settling transaction. Ready and
   * the earlier proof stay unless the new catalog publishes. A failure keeps its diagnostic as an
   * artifact. A sign-in the client no longer honors is the one failure that leaves Ready, because
   * the proof then describes a session that is gone.
   */
  settleModelRefresh(
    this: Controller,
    commandId: string,
    revision: number,
    runtime: { stopped: boolean },
    outcome: Awaited<ReturnType<typeof startGoogleAcpSetup>['result']>,
    known: boolean,
    resolution: AcpProfileResolution,
    qualify?: { previous: ReturnType<typeof GoogleAcpSetupSchema.parse>['modelRefresh'] },
  ): CommandResult {
    const setup = this.store.googleAcpSetup();
    const named = setup.modelRefresh?.commandId === commandId && setup.revision === revision;
    const refreshed = (rest: Partial<ReturnType<typeof GoogleAcpSetupSchema.parse>>) => {
      const next = GoogleAcpSetupSchema.parse({ ...setup, ...rest, revision: setup.revision + 1 });
      this.store.putGoogleAcpSetup(next);
      return next;
    };
    const record = setup.modelRefresh;
    if (!known) {
      const next =
        named && record ? refreshed({ modelRefresh: { ...record, outcome: 'unknown' } }) : setup;
      return {
        outcome: 'outcome-unknown',
        reason: 'google-ownership-unknown',
        data: { kind: 'google-acp-setup', setup: next },
      };
    }
    // The fence reads the live authority before the write below moves the revision.
    if (
      this.closed ||
      runtime.stopped ||
      !named ||
      !record ||
      !this.store.googleMetadataPublishable(commandId)
    )
      return {
        outcome: 'blocked',
        reason: 'acp-setup-stopped',
        data: { kind: 'google-acp-setup', setup },
      };
    let proof: AcpSetupProof | null = null;
    if (!outcome.reason && outcome.metadata) {
      try {
        proof = validateAcpSetupProof(
          outcome.metadata,
          resolution.client as AcpClient,
          this.options.googleAcp?.reviewMappings,
        );
      } catch {}
    }
    // A copy that is not in use and did not pass changes nothing here: not Ready, not the proof,
    // not the last refresh the person sees. Its card line says why.
    if (
      qualify &&
      !(proof?.reviewMode && proof.configOptions && proof.auth.status === 'authenticated')
    ) {
      const next = refreshed({ modelRefresh: qualify.previous });
      return {
        outcome: 'blocked',
        reason: outcome.reason === 'deadline' ? 'acp-setup-timeout' : 'acp-setup-failed',
        data: { kind: 'google-acp-setup', setup: next },
      };
    }
    if (proof?.reviewMode && proof.configOptions && proof.auth.status === 'authenticated') {
      const next = refreshed({
        proofId: this.nativeArtifact(proof).id,
        client: proof.client,
        auth: proof.auth,
        modelRefresh: {
          commandId,
          at: this.now(),
          outcome: 'refreshed',
          reason: null,
          evidenceId: null,
        },
      });
      return { outcome: 'applied', data: { kind: 'google-acp-setup', setup: next } };
    }
    const reason: 'acp-setup-timeout' | 'authentication-required' | 'acp-capability-missing' =
      outcome.reason === 'deadline'
        ? 'acp-setup-timeout'
        : outcome.reason === 'authentication'
          ? 'authentication-required'
          : 'acp-capability-missing';
    const evidence = this.nativeArtifact({
      operation: 'model-refresh',
      commandId,
      reason: outcome.reason ?? 'no-review-mode',
      diagnostic: outcome.diagnostic,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderrSummary: outcome.stderrSummary,
    });
    const failed = {
      commandId,
      at: this.now(),
      outcome: 'failed' as const,
      reason,
      evidenceId: evidence.id,
    };
    const next =
      reason === 'authentication-required'
        ? refreshed({
            state: 'authentication-required',
            auth: { method: 'oauth-personal', status: 'required' },
            reason,
            modelRefresh: failed,
          })
        : refreshed({ modelRefresh: failed });
    return {
      outcome: 'blocked',
      reason: reason === 'acp-setup-timeout' ? 'acp-setup-timeout' : 'acp-setup-failed',
      ...(reason === 'acp-setup-timeout'
        ? { next: 'Reading the models timed out after 20 seconds. The earlier list is kept.' }
        : {}),
      data: { kind: 'google-acp-setup', setup: next },
    };
  }

  /**
   * What the diagnostics bundle says about Google: the setup and install state, the newest client
   * operations with whether each recorded group still exists, and every Google profile's reason.
   * A stuck connect reads from it: a row whose group is gone clears with Recover or Stop. A number
   * that still answers may belong to another program by now, so nothing here asks anyone to end it.
   */
  googleDiagnostics(this: Controller) {
    const rows = this.store.googleMetadataOperations();
    const live = new Set([this.acpSetupRuntime?.key, this.usageRead?.key]);
    const states: Record<string, number> = {};
    for (const row of rows) states[row.state] = (states[row.state] ?? 0) + 1;
    return {
      setup: this.store.googleAcpSetup(),
      install: this.googleInstallation().status(),
      running: {
        setup: this.acpSetupRuntime?.key ?? null,
        quotaRead: this.usageRead?.key ?? null,
      },
      operations: {
        total: rows.length,
        states,
        newest: rows.slice(-GOOGLE_DIAGNOSTIC_OPERATIONS).map((row) => ({
          commandId: row.command_id,
          kind: row.kind,
          state: row.state,
          authorityRevision: row.authority_revision,
          pid: row.pid,
          processGroup: row.process_group,
          groupPresent: row.process_group === null ? null : !groupAbsent(row.process_group),
          runningHere: live.has(row.command_id),
          clearedByStop: !!this.store.receipt(`google-metadata-settled:${row.command_id}`),
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        })),
      },
      profiles: this.resolveProfiles()
        .filter((profile) => profile.facts.family === 'google')
        .map((profile) => ({
          id: profile.facts.id,
          available: profile.facts.available,
          reason: 'reason' in profile.facts ? String(profile.facts.reason) : null,
        })),
    };
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
    // The same wait as a setup step: a quota read in flight ends within its deadline.
    if (command.command === 'InstallGoogleAcp' && !receipt && this.usageRead)
      await this.usageRead.promise.catch(() => {});
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
    // The card's Connect is this check. A signed-in client connects Anthropic on this device.
    if (this.nativeConnections().status().state === 'signed-in') this.connectedNow('anthropic');
    return result;
  }

  /**
   * The launch-time sign-in check for an Anthropic connection made on this device. It reads the
   * client's own sign-in, so the card says when that sign-in ended. Nothing is journaled as a
   * click.
   */
  async checkAnthropicAtLaunch(this: Controller): Promise<void> {
    if (this.closed || !this.store.hasConnectedOnce('anthropic')) return;
    this.connectLog.begin('anthropic', 'auto');
    const blocker = this.anthropicUsage().blocker();
    if (blocker) return this.connectLog.failed('anthropic', blocker);
    const key = this.id('cmd');
    const directory = join(this.home, 'native', `connection-${key}`);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      await this.nativeConnections().check(
        {
          key,
          requestHash: hashCanonical({ key, launch: true }),
          profile: this.anthropicChatProfile(),
          directory,
          repositoryRoot: this.home,
        },
        { spawn: this.options.nativeSpawn, schedule: this.options.schedule },
      );
    } catch {}
    this.settleAnthropicConnect();
  }

  /** The Anthropic connect line: connected when the client's own sign-in reads as signed in. */
  settleAnthropicConnect(this: Controller, result?: CommandResult) {
    let state: string;
    try {
      state = this.nativeConnections().status().state;
    } catch {
      state = 'unknown';
    }
    if (state === 'signed-in') return this.connectLog.ok('anthropic');
    const refused = result && result.outcome !== 'applied' && result.outcome !== 'already-applied';
    this.connectLog.failed('anthropic', refused ? (result.reason ?? state) : state);
  }

  /**
   * The Google connect line. Connected means the setup reached ready. A launch that ends short of
   * ready failed; on the card's Connect only a refused step fails, since the steps run one by one.
   */
  settleGoogleConnect(this: Controller, result?: CommandResult) {
    // A launch preparation can end after close, when the store is gone.
    if (this.closed || !this.connectLog.mode('google')) return;
    const setup = this.store.googleAcpSetup();
    if (setup.state === 'ready') return this.connectLog.ok('google');
    if (!result)
      return this.connectLog.failed(
        'google',
        googleTermsAcknowledged(this.store)
          ? (setup.reason ?? setup.state)
          : 'google-terms-not-acknowledged',
      );
    if (result.outcome !== 'applied' && result.outcome !== 'already-applied')
      this.connectLog.failed('google', result.reason ?? setup.reason ?? setup.state);
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
    // The connect line for Local. A launch reconnect keeps trying while the runtime is down, so
    // its first failure is logged and the attempt stays open until it connects.
    if (this.localConnected(next)) this.connectLog.ok('local');
    else if (next.connectionFailed)
      this.connectLog.failed(
        'local',
        'connection-failed',
        this.connectLog.mode('local') === 'auto',
      );
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

  /**
   * The line that refuses Local token mode, or null. The token window and the remembered token
   * both need the macOS keychain, so any other computer takes the no-authentication loopback mode
   * only (ADR 0013, amendment of 2026-10-31).
   */
  localTokenRefusal(this: Controller) {
    return localTokenRefusal(this.options.localInput?.platform ?? process.platform);
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
          : control.authMode === 'token' &&
              (!this.options.localInputHelper || this.localTokenRefusal())
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
    // The runtime asked a no-authentication connection for a token, or token mode was saved on a
    // computer that cannot take one. The view shows these lines in place of the generic reason.
    const notice =
      this.localTokenRefusal() && control.endpoint
        ? control.authMode === 'token'
          ? LOCAL_TOKEN_SETUP_NOTICE
          : tokenAsked.get(this) === control.connectionRevision && !connected
            ? LOCAL_SERVER_WANTS_TOKEN
            : undefined
        : undefined;
    return LocalSetupSchema.parse({
      ...(notice ? { notice } : {}),
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
      ...(control.openProbeRevision === control.connectionRevision
        ? { reconnectsWithoutToken: true }
        : {}),
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
    const refusal = this.localTokenRefusal();
    if (refusal) return { outcome: 'blocked', reason: 'local-token-needs-macos', next: refusal };
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
      this.connectLog.drop('local');
      this.store.forgetConnectedOnce('local');
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
    // A Connect on the card connects Local on this device. Later launches reconnect the saved
    // endpoint with no click.
    if (command.command === 'ConfigureLocal' || command.command === 'BeginLocalConnectionInput')
      this.store.markConnectedOnce('local');
    // A launch reconnect sends only BeginLocalConnectionInput on the saved endpoint, and stays the
    // auto attempt until it connects. A card Connect that saves an endpoint is manual. A card
    // Connect on the saved endpoint before the launch reconnect connects counts as auto.
    if (command.command === 'ConfigureLocal') this.connectLog.begin('local', 'manual');
    if (command.command === 'BeginLocalConnectionInput' && !this.connectLog.mode('local'))
      this.connectLog.begin('local', command.payload.unattended ? 'auto' : 'manual');
    if (command.command === 'ConfigureLocal') {
      // An OpenAI-compatible server takes no token here, so it never meets the macOS token rule.
      const authMode = isOpenAiLocalEndpoint(command.payload.endpoint)
        ? 'none'
        : (command.payload.authMode ?? 'token');
      const refusal = authMode === 'token' ? this.localTokenRefusal() : null;
      if (refusal) return { outcome: 'blocked', reason: 'local-token-needs-macos', next: refusal };
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
    // An OpenAI-compatible server is read in this process: no token window, no child process.
    if (isOpenAiLocalEndpoint(control.endpoint)) {
      if (command.command === 'RefreshLocalModels' && !this.localConnected(control))
        return { outcome: 'blocked', reason: 'local-connection-required' };
      const { endpoint, connectionRevision } = control;
      this.saveLocal({ ...control, connectionFailed: false });
      effects.push(() => {
        this.openAiRead = this.readOpenAiLocal(endpoint, connectionRevision);
      });
      return applied();
    }
    // A configured helper does not lift the refusal: token entry needs the macOS keychain.
    const tokenRefusal = control.authMode === 'token' ? this.localTokenRefusal() : null;
    if (control.authMode === 'token' && (!this.options.localInputHelper || tokenRefusal)) {
      const refusal = tokenRefusal;
      return {
        outcome: 'blocked',
        reason: refusal ? 'local-token-needs-macos' : 'local-input-unavailable',
        ...(refusal ? { next: refusal } : {}),
      };
    }
    if (command.command === 'RefreshLocalModels' && !this.localConnected(control))
      return { outcome: 'blocked', reason: 'local-connection-required' };
    // Connect on a setup that is connected, with a current read and nothing running, has nothing
    // to do. A second press, or a resend after a lost answer, keeps the model selection.
    if (
      command.command === 'BeginLocalConnectionInput' &&
      this.localConnected(control) &&
      control.observation &&
      !control.observationStale &&
      !control.connectionFailed
    )
      return applied();
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
    const quiet = command.command === 'BeginLocalConnectionInput' && !!command.payload.unattended;
    // Recorded once the command has committed, so a rolled back command leaves nothing behind.
    effects.push(() => {
      // Time since the controller process started, so one reopen shows how long the desktop took
      // to send the first connect.
      logTiming(
        `local connect command kind=${kind} unattended=${quiet ? 1 : 0} sinceStartMs=${Math.round(performance.now())}`,
      );
      if (quiet) unattended(this).add(binding.operationId);
      this.launchLocalOperation(binding.operationId);
    });
    return applied();
  }

  /**
   * Read an OpenAI-compatible server's models and keep them as the observation. A read that
   * answers means the server is connected. One that fails leaves the last read on view, labelled.
   * The result is dropped when the endpoint or the connection changed while the read ran.
   */
  async readOpenAiLocal(this: Controller, endpoint: string, connectionRevision: number) {
    let next: Awaited<ReturnType<typeof readOpenAiObservation>> | null = null;
    try {
      next = await readOpenAiObservation(endpoint, this.options.localFetch);
    } catch {}
    if (this.closed) return;
    this.store.transaction(() => {
      const control = this.localControl();
      if (
        control.endpoint !== endpoint ||
        control.connectionRevision !== connectionRevision ||
        control.operation
      )
        return;
      if (!next) {
        this.saveLocal({
          ...control,
          connectedWithoutToken: undefined,
          connectionFailed: true,
          observationStale: !!control.observation,
          selection: null,
          setupHash: null,
        });
        return;
      }
      const eligible = next.models.filter((choice) => choice.state === 'loaded-eligible');
      const kept =
        retainedSelection(control.selectedModelKey, next, false) ??
        (control.selectedModelKey === null && eligible.length === 1 ? eligible[0] : null);
      const selection = kept
        ? { selectionId: kept.selectionId, observationHash: next.observationHash }
        : null;
      this.saveLocal({
        ...control,
        connectedWithoutToken: true,
        openProbeRevision: connectionRevision,
        connectionFailed: false,
        observation: next,
        observedAt: this.now(),
        observationStale: false,
        selection,
        selectedModelKey: kept?.identity.modelKey ?? null,
        setupHash: selection
          ? hashCanonical({
              version: 2,
              connectionHash: localConfiguredConnectionHash(
                endpoint,
                connectionRevision,
                control.authMode,
              ),
              ...selection,
            })
          : null,
      });
    });
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
    const operation = this.closed ? null : this.localControl().operation;
    if (!operation || operation.binding.operationId !== operationId) {
      unattended(this).delete(operationId);
      return;
    }
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
            const picked = observation?.models.find(
              (choice) => choice.selectionId === selection?.selectionId,
            );
            // With no model picked yet, a runtime holding exactly one eligible model selects it.
            const eligible = nextObservation.models.filter(
              (choice) => choice.state === 'loaded-eligible',
            );
            const kept =
              retainedSelection(
                selectedModelKey,
                nextObservation,
                picked?.state === 'installed-unloaded',
              ) ?? (selectedModelKey === null && eligible.length === 1 ? eligible[0] : null);
            observation = nextObservation;
            observedAt = this.now();
            observationStale = false;
            availableMemoryBytes = availableMemory() ?? null;
            if (kept && control.endpoint) {
              selectedModelKey = kept.identity.modelKey;
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
        unattended(this).delete(operationId);
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
        // `connectedWithoutToken`. A runtime that answers without a token connects with none. Only
        // a runtime that answers 401 or 403 opens the token window, whatever mode is saved. A
        // runtime busy loading a model answers slowly, so a probe that times out is tried again
        // with a longer wait. One that never answers ends the connect as failed, with no window.
        const endpoint = control.endpoint;
        if (!endpoint) throw Error('Local endpoint is unavailable.');
        const injected = this.options.localProbe;
        // An injected yes or no stands for auth off or a missed probe.
        const probe: (endpoint: string, timeoutMs: number) => Promise<LocalProbe> = injected
          ? async (value) => {
              const found = await injected(value);
              return found === true ? 'open' : found === false ? 'timeout' : found;
            }
          : probeLocal;
        void (async () => {
          let found: LocalProbe = 'timeout';
          for (const timeoutMs of LOCAL_PROBE_TIMEOUTS_MS) {
            if (runtime.stopped || this.closed) break;
            const probeStarted = performance.now();
            found = await probe(endpoint, timeoutMs).catch((): LocalProbe => 'unavailable');
            logTiming(
              `local probe found=${found} budgetMs=${timeoutMs} ms=${Math.round(performance.now() - probeStarted)}`,
            );
            if (found !== 'timeout') break;
          }
          return found;
        })().then((found) => {
          const open = found === 'open';
          const quiet = unattended(this).has(operationId);
          tokenAsked.delete(this);
          const supplied =
            this.localSecret?.supplied && this.localSecretMatches(this.localControl());
          // The runtime wants a token now, so the earlier no-token answer no longer holds.
          if (found === 'token-required' && !this.closed)
            try {
              this.store.transaction(() => {
                const current = this.localControl();
                if (
                  current.connectionRevision === control.connectionRevision &&
                  current.openProbeRevision !== null
                )
                  this.saveLocal({ ...current, openProbeRevision: null }, false);
              });
            } catch {}
          if (
            found === 'token-required' &&
            !opensTokenWindow(found, {
              supplied: !!supplied,
              unattended: quiet,
              refused: !!this.localTokenRefusal(),
            }) &&
            !supplied &&
            !runtime.stopped &&
            !this.closed
          ) {
            // The runtime asked for a token and this computer cannot take one. No window opens;
            // the setup says so until the next connect finds the runtime open.
            tokenAsked.set(this, control.connectionRevision);
            return finish(null);
          }
          if (!open && supplied && !runtime.stopped && !this.closed) {
            // The desktop supplied the token for this connect. No window opens.
            if (this.localSecret) this.localSecret.supplied = false;
            return finish(null);
          }
          if (!open && found !== 'token-required' && !runtime.stopped && !this.closed) {
            // No answer, or one that says nothing about auth. The card says the connection failed
            // and Connect tries again. A token window would not help.
            finish(null);
            this.store.transaction(() => {
              const current = this.localControl();
              if (
                current.operation ||
                current.endpoint !== endpoint ||
                current.connectionRevision !== control.connectionRevision
              )
                return;
              this.saveLocal({ ...current, connectionFailed: true });
            });
            return;
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
              openProbeRevision: current.connectionRevision,
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
        const discoveryStarted = performance.now();
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
        void handle.result.then(
          (value) => {
            logTiming(
              `local discovery done ms=${Math.round(performance.now() - discoveryStarted)}`,
            );
            finish(value);
          },
          () => finish(null),
        );
      }
      if (runtime.stopped || this.closed) runtime.handle?.stop();
    } catch {
      finish(null);
    }
  }

  /**
   * Runs one synchronous read with the profiles resolved once. A workspace read asks for them from
   * the header, from the Anthropic reader's binding and again from the snapshot around it, and
   * nothing inside one synchronous read can change them. The kept answer ends when the read
   * returns, so a command that waits and resolves again sees fresh profiles.
   */
  withProfiles<T>(this: Controller, read: () => T): T {
    if (profileReads.has(this)) return read();
    profileReads.set(this, {});
    try {
      return read();
    } finally {
      profileReads.delete(this);
    }
  }

  resolveProfiles(this: Controller): NativeProfileResolution[] {
    const kept = profileReads.get(this);
    if (kept?.profiles) return [...kept.profiles];
    const profiles = timed('resolveProfiles', () => this.resolveProfilesNow());
    if (kept) kept.profiles = profiles;
    return kept ? [...profiles] : profiles;
  }

  resolveProfilesNow(this: Controller): NativeProfileResolution[] {
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

  /** A newer copy whose sign-in the card offers, when the record names one still in the pool. */
  waitingGoogleAgent(this: Controller): GoogleAgent | undefined {
    const root = this.options.managedClients?.root;
    const waiting = root ? readManagedRecord(root, 'google').notUsed : null;
    return waiting?.signIn
      ? this.googleAgentPool().find((agent) => agent.sha256 === waiting.sha256)
      : undefined;
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

  /**
   * The Google route's profile over the agent pool. With an empty pool it is the bundle alone, as
   * a home without any other signed agent has it.
   */
  acpResolution(
    this: Controller,
    agents: readonly GoogleAgent[] = this.googleAgentPool(),
  ): NativeProfileResolution & AcpProfileResolution {
    let proof: AcpSetupProof | null = null;
    try {
      proof = this.acpProof();
    } catch {}
    const resolved =
      this.options.googleAcp?.resolve?.(proof, agents) ??
      resolveGoogleAcpProfile({ home: this.home, proof, environment: process.env, agents });
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
