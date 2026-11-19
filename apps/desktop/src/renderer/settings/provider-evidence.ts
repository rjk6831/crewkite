import {
  type ChatCatalogEntry,
  type ChatFamily,
  GOOGLE_RECOVERY_HOLD_COPY,
  type GoogleMetadataRecovery,
  type WorkspaceState,
} from '@crewkite/contracts';
import { readAgo } from '../usage-presentation.ts';

/**
 * What each provider card states as separate facts. A Ready setup, a model list, a quota read and
 * an operation that still holds the provider are different evidence with different ages, so the
 * card never folds one into another.
 */
export type ProviderEvidence = {
  signIn: string;
  models: string;
  usage: string;
  /** An operation that blocks new work on this provider, in the words the person acts on. */
  blocker: string | null;
};

function googleSignIn(header: Pick<WorkspaceState, 'googleAcpSetup'>) {
  const auth = header.googleAcpSetup?.auth.status;
  if (auth === 'authenticated') return 'Signed in';
  if (auth === 'required') return 'Sign-in needed';
  return 'Not confirmed';
}

function googleModels(count: number, header: Pick<WorkspaceState, 'googleAcpSetup'>, now: number) {
  const listed = `${count} listed`;
  const refresh = header.googleAcpSetup?.modelRefresh;
  if (!refresh) return listed;
  if (refresh.outcome === 'running') return `${listed}, refreshing`;
  if (refresh.outcome === 'refreshed')
    return `${listed}, ${readAgo(refresh.at, now)?.toLowerCase() ?? 'refreshed'}`;
  // A failed or unconfirmed refresh keeps the earlier list, and the card says so.
  const why = refresh.reason ? ` (${refresh.reason.replaceAll('-', ' ')})` : '';
  return refresh.outcome === 'failed'
    ? `${listed}. Last refresh failed${why}, earlier list kept`
    : `${listed}. Last refresh unconfirmed, earlier list kept`;
}

/** Holds that need the person. A live operation holds the gate too, and that is normal work. */
export const stuckHolds = (header: Pick<WorkspaceState, 'googleMetadataHolds'>) =>
  (header.googleMetadataHolds ?? []).filter((row) => row.reason !== 'runtime-active');

export function providerEvidence(
  family: ChatFamily,
  entry: ChatCatalogEntry | undefined,
  header: Pick<WorkspaceState, 'googleAcpSetup' | 'googleMetadataHolds'>,
  now: number,
): ProviderEvidence {
  const hold = family === 'google' ? stuckHolds(header)[0] : undefined;
  const blocker = hold ? GOOGLE_RECOVERY_HOLD_COPY[hold.reason] : null;
  if (!entry) return { signIn: 'Unknown', models: 'Not read yet', usage: 'Not read yet', blocker };
  const count = entry.models.length;
  const usage = readAgo(entry.readAt, now) ?? 'Not read yet';
  if (family === 'google') {
    return {
      signIn: googleSignIn(header),
      models: googleModels(count, header, now),
      usage,
      blocker,
    };
  }
  // The local runtime needs no account and reports no quota.
  if (family === 'local')
    return {
      signIn: entry.connected ? 'Connected' : 'Not connected',
      models: `${count} listed`,
      usage: 'None. Runs on this computer',
      blocker: null,
    };
  return {
    signIn: entry.connected
      ? 'Connected on this device'
      : entry.reason === 'signed-out'
        ? 'Sign-in needed'
        : 'Not connected',
    models: `${count} listed`,
    usage,
    blocker: null,
  };
}

export const operationName = {
  usage: 'Quota read',
  'acp-initialize': 'Client check',
  'acp-authenticate': 'Sign-in',
  'acp-discover': 'Model read',
} as const;

/** The line for one Recover result. Each held row keeps its own reason. */
export function recoveryLine(result: GoogleMetadataRecovery) {
  const settled = result.settled.length;
  if (result.outcome === 'clear') return 'Nothing was holding Google.';
  const released =
    settled === 0
      ? null
      : settled === 1
        ? 'Released one interrupted operation. Its result stays unknown.'
        : `Released ${settled} interrupted operations. Their results stay unknown.`;
  const held = result.held.map(
    (row) => `${operationName[row.operation]}: ${GOOGLE_RECOVERY_HOLD_COPY[row.reason]}`,
  );
  return [released, ...held].filter(Boolean).join(' ');
}
