import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
// proves its recorded group gone, or the process table proves its number went to a later process,
// and nothing in this controller could still drive it. Its result stays unknown. Recovery sends no
// prompt, opens no browser and replays nothing.

export type GoogleRecoveryConsent = 'automatic' | 'explicit';

export const SIGN_IN_RELEASED =
  'The interrupted Google sign-in is released. A sign-in already open in your browser may still complete, so sign in again to check it.';

// The card already shows why the row holds. A refused Recover says only what it did.
export const NUMBER_STILL_IN_USE = 'The process number is still in use. Nothing was released.';

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

// PATH can name any program. These two locations cover macOS and Linux.
const PS = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path));
const MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec';
// Ordinary clock corrections stay far below an hour. On Linux, procps derives a start time from
// the boot time, which moves when the wall clock is stepped.
const REUSE_MARGIN_MS = 60 * 60 * 1000;

/**
 * When the process whose PID equals the group number started, read from the process table. It
 * sends no signal. Null when no such process exists, ps fails, or its answer does not parse.
 */
function leaderStartedAt(group: number): number | null {
  if (!PS) return null;
  let line: string;
  try {
    // shortcut: this blocks the controller for one ps run, bounded at one second, on every
    // snapshot and recovery while a held number still answers. Upgrade: read the start time off
    // the event loop and keep it per row.
    line = execFileSync(PS, ['-o', 'lstart=', '-p', String(group)], {
      env: { TZ: 'UTC', LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  // macOS and procps both print `Thu Nov 12 15:03:27 2026`, with the day padded by a space.
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
    line.trim(),
  );
  if (!match) return null;
  const month = MONTHS.indexOf(match[1] as string);
  if (month < 0) return null;
  const [day, hour, minute, second, year] = match.slice(2).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return Date.UTC(year, month / 3, day, hour, minute, second);
}

/**
 * Whether the recorded number provably belongs to a later process. The row is written at intent,
 * and the spawn follows in the same synchronous run after the commit, so the read's own process
 * started within milliseconds of `started_at`. macOS and Linux never hand out a PID while a process
 * group or session with that number exists. So a process that holds the number as its PID and
 * started more than the margin after the row was created after the read's group and session had
 * ended. A group whose leader is gone proves nothing: its members may be the read's own children.
 */
function numberReused(row: Pick<GoogleMetadataOperation, 'process_group' | 'started_at'>) {
  const started = leaderStartedAt(row.process_group as number);
  return started !== null && started - Date.parse(row.started_at) > REUSE_MARGIN_MS;
}

/**
 * Why a row holds the gate. `recoverable` means a current probe proved its group gone, or the
 * process table proved its number reused, and nothing else stands in the way, so recovery may
 * settle it.
 */
export function classifyGoogleMetadata(
  row: Pick<GoogleMetadataOperation, 'kind' | 'process_group' | 'started_at'>,
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
  // The process table is read only when the probe left absence unproven.
  if (answer !== 'absent' && !numberReused(row))
    return answer === 'present' ? 'owner-present' : 'owner-unconfirmed';
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
 * Every row holding the gate, with why, for the snapshot. It sends the zero probe, may read the
 * process table and settles nothing, so a row whose group is gone reads `recoverable` until startup
 * or Recover settles it.
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
      next:
        !recovery.settled.length && ['owner-present', 'owner-unconfirmed'].includes(hold.reason)
          ? NUMBER_STILL_IN_USE
          : GOOGLE_RECOVERY_HOLD_COPY[hold.reason],
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
