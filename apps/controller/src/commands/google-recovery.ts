import {
  type CommandResult,
  GOOGLE_RECOVERY_HOLD_COPY,
  GoogleAcpSetupSchema,
  type GoogleMetadataRecovery,
  type GoogleRecoveryHold,
} from '@crewkite/contracts';
import type { GoogleMetadataOperation } from '../store/index.ts';
import type { Controller } from './controller.ts';
import { sweepGoogleUsageDirectories } from './google-usage-sweep.ts';

// Google metadata recovery (ADR 0054). Startup, the Recover command and Stop on an unknown setup
// step share this one rule. A row that holds the Google gate is released only when a current probe
// proves its recorded group gone and nothing in this controller could still drive it. Its result
// stays unknown. Recovery sends no prompt, opens no browser and replays nothing.

export type GoogleRecoveryConsent = 'automatic' | 'explicit';

export const SIGN_IN_RELEASED =
  'The interrupted Google sign-in is released. A sign-in already open in your browser may still complete, so sign in again to check it.';

/**
 * The zero probe. It sends no signal. Only ESRCH proves the group gone. EPERM means some process
 * this user cannot signal holds the number, so absence stays unproven.
 */
function probeGroup(group: number): 'absent' | 'present' | 'refused' {
  try {
    process.kill(-group, 0);
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'refused';
  }
}

/**
 * Why a row holds the gate. `recoverable` means a current probe proved its group gone and nothing
 * else stands in the way, so recovery may settle it.
 */
export function classifyGoogleMetadata(
  row: Pick<GoogleMetadataOperation, 'kind' | 'process_group'>,
  facts: {
    consent: GoogleRecoveryConsent;
    runtimeActive: boolean;
    // A known machine, namespace or provenance conflict. Missing identity is not one.
    conflict: boolean;
  },
): GoogleRecoveryHold {
  if (facts.runtimeActive) return 'runtime-active';
  // A row with no group may have spawned a process the journal cannot name.
  if (row.process_group === null || row.process_group <= 0) return 'no-process-identity';
  // ESRCH in this PID namespace says nothing about a process on another machine.
  if (facts.conflict) return 'provenance-conflict';
  const answer = probeGroup(row.process_group);
  if (answer === 'present') return 'owner-present';
  if (answer === 'refused') return 'owner-unconfirmed';
  // A browser sign-in may still finish after its client is gone. Only a person releases it.
  return row.kind === 'acp-authenticate' && facts.consent === 'automatic'
    ? 'authentication-needs-person'
    : 'recoverable';
}

/**
 * A Google setup or usage runtime in this controller, or a Google start that may still begin a
 * quota read. Either can drive a row, so nothing settles while one exists.
 */
function googleRuntimeActive(controller: Controller) {
  const read = controller.usageRead?.key;
  return (
    !!controller.acpSetupRuntime ||
    !!controller.acpStart ||
    (!!read && !!controller.store.googleMetadataOperation(read))
  );
}

function classify(controller: Controller, consent: GoogleRecoveryConsent) {
  const runtimeActive = googleRuntimeActive(controller);
  return controller.store.heldGoogleMetadata().map((row) => ({
    row,
    decision: classifyGoogleMetadata(row, {
      consent,
      runtimeActive,
      // shortcut: this build observes no current machine or namespace identity, so no conflict
      // is known and recorded launch identity goes unread here. Upgrade: compare it with the
      // qualified platform reader before the probe.
      conflict: false,
    }),
  }));
}

/**
 * Every row holding the gate, with why, for the snapshot. It sends the zero probe and settles
 * nothing, so a row whose group is gone reads `recoverable` until startup or Recover settles it.
 */
export function googleMetadataHolds(controller: Controller): GoogleMetadataRecovery['held'] {
  return classify(controller, 'automatic').map(({ row, decision }) => ({
    commandId: row.command_id,
    operation: row.kind,
    reason: decision,
  }));
}

/**
 * Settles each `recoverable` row, inside the caller's transaction. Startup leaves a sign-in held;
 * an explicit recovery settles it once the probe proves its group gone. The settlement, its
 * receipt and its evidence commit together, and a late callback from the old command can no
 * longer publish. Prior observations and setup proof stay. A setup step left on a settled row is
 * released, and a settled sign-in no longer counts as signed in.
 */
export function recoverGoogleMetadata(
  controller: Controller,
  consent: GoogleRecoveryConsent,
): GoogleMetadataRecovery {
  const { store } = controller;
  const decisions = classify(controller, consent);
  const settled: GoogleMetadataOperation[] = [];
  const held: GoogleMetadataRecovery['held'] = [];
  for (const { row, decision } of decisions) {
    if (decision !== 'recoverable') {
      held.push({ commandId: row.command_id, operation: row.kind, reason: decision });
      continue;
    }
    const group = row.process_group as number;
    const absentAt = controller.now();
    store.finishGoogleMetadata(row.command_id, group, absentAt, 'owner-absent');
    const record = controller.nativeArtifact({
      commandId: row.command_id,
      kind: row.kind,
      outcome: 'unknown',
      groups: [group],
      absentAt,
    });
    store.saveReceipt(`google-metadata-settled:${row.command_id}`, record.hash, 'local-owner', {
      outcome: 'applied',
      entity: record,
    });
    settled.push(row);
  }
  if (!googleRuntimeActive(controller)) releaseSetup(controller, settled);
  // With every row settled and no Google runtime or start in this controller, nothing registered
  // can own a usage folder. The gate is read again before each batch.
  const quiet = () =>
    !controller.usageRead &&
    !googleRuntimeActive(controller) &&
    controller.store.heldGoogleMetadata().length === 0;
  return {
    kind: 'google-metadata-recovery',
    outcome: settled.length ? 'settled' : held.length ? 'held' : 'clear',
    settled: settled.map((row) => ({ commandId: row.command_id, operation: row.kind })),
    held,
    swept: sweepGoogleUsageDirectories(controller.home, quiet),
  };
}

/**
 * Moves setup off a step whose row has settled, by recovery now or by a close the step never
 * published. Ready and its proof stay unless a sign-in settled: that sign-in's outcome is unknown,
 * so the next step is the person's own sign-in.
 */
function releaseSetup(controller: Controller, settled: GoogleMetadataOperation[]) {
  const { store } = controller;
  const setup = store.googleAcpSetup();
  const step = setup.operationId
    ? store.googleMetadataOperations().find((row) => row.command_id === setup.operationId)
    : undefined;
  const release =
    step?.state === 'quiescent' &&
    ['initializing', 'authenticating', 'discovering', 'stopping', 'unknown'].includes(setup.state);
  const signIn =
    settled.some((row) => row.kind === 'acp-authenticate') ||
    (release && step?.kind === 'acp-authenticate');
  // A refresh still shown as running whose row has settled can never finish. Its result is
  // unknown, and the card would otherwise wait on it.
  const refresh = setup.modelRefresh;
  const stale =
    refresh?.outcome === 'running' &&
    store.googleMetadataOperation(refresh.commandId)?.state === 'quiescent';
  if (!release && !signIn && !stale) return;
  const signedIn = ['ready', 'discovery-required'].includes(setup.state);
  store.putGoogleAcpSetup(
    GoogleAcpSetupSchema.parse({
      ...setup,
      revision: setup.revision + 1,
      ...(stale && refresh ? { modelRefresh: { ...refresh, outcome: 'unknown' } } : {}),
      ...(release ? { state: 'blocked', operationId: null, reason: null } : {}),
      ...(signIn
        ? {
            auth: { method: setup.auth.method, status: 'unknown' },
            ...(release || signedIn
              ? { state: setup.proofId ? 'authentication-required' : 'blocked' }
              : {}),
          }
        : {}),
    }),
  );
  controller.profiles = controller.resolveProfiles();
}

/** The person's Recover. A settled sign-in says that an old browser sign-in may still finish. */
export function recoverGoogleMetadataCommand(controller: Controller): CommandResult {
  const recovery = recoverGoogleMetadata(controller, 'explicit');
  const hold = recovery.held[0];
  if (hold)
    return {
      outcome: 'blocked',
      reason:
        hold.reason === 'runtime-active' ? 'google-operation-active' : 'google-ownership-unknown',
      next: GOOGLE_RECOVERY_HOLD_COPY[hold.reason],
      data: recovery,
    };
  return {
    outcome: 'applied',
    ...(recovery.settled.some((row) => row.operation === 'acp-authenticate')
      ? { next: SIGN_IN_RELEASED }
      : {}),
    data: recovery,
  };
}
