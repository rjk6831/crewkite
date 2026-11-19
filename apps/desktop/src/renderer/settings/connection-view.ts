import {
  type BillingMode,
  type ChatFamily,
  type ChatThread,
  CONNECTION_COPY,
  type Connection,
  type ConnectionRole,
  type ConnectionsRead,
} from '@crewkite/contracts';
import { familyName } from '../family-name.ts';

// What a person reads about an API connection. Settings, the Crew tab, the rail and the CLI use
// the same words, so a connection reads the same wherever it shows.

/** What a thread or role on an API connection says while it is assigned. */
export const CHARGES_APPLY = 'Provider charges apply.';

/** An API connection the person set up. A subscription or Local route is never one. */
export const isApiConnection = (connection: Connection) =>
  connection.billingMode === 'api' && connection.backend === 'native-client';

/** The person's label with its family, or the family and mode when they gave none. */
export const connectionName = (connection: Pick<Connection, 'label' | 'family'>) =>
  connection.label
    ? `${connection.label} (${familyName(connection.family)})`
    : `${familyName(connection.family)} ${CONNECTION_COPY.apiLabel}`;

/** What the connection needs before a turn can run on it, or null when it can run one now. */
export function connectionAttention(connection: Connection): string | null {
  if (connection.readiness === 'disconnected') return 'Disconnected';
  if (connection.observedMode === null) return 'Sign-in not confirmed';
  if (connection.observedMode !== connection.billingMode || connection.readiness !== 'ready')
    return CONNECTION_COPY.signInChanged;
  return null;
}

/** The mode the client last reported for the connection's own profile. */
export const observedModeText = (mode: BillingMode | null) =>
  mode === 'api'
    ? CONNECTION_COPY.apiLabel
    : mode === 'subscription'
      ? CONNECTION_COPY.subscriptionLabel
      : mode === 'local'
        ? 'Local'
        : 'Mode not confirmed';

export const readinessText: Record<Connection['readiness'], string> = {
  ready: 'Ready',
  'needs-attention': 'Needs attention',
  disconnected: 'Disconnected',
};

/**
 * The API connections a thread or role can be assigned now: proven, ready and, for a role, on
 * the family that role runs on. An assignment on another family would never reach the role, and
 * one that is not ready would refuse every turn.
 */
export function readyApiConnections(
  read: ConnectionsRead | null,
  family: ChatFamily | null,
): Connection[] {
  return (read?.connections ?? []).filter(
    (connection) =>
      isApiConnection(connection) &&
      connectionAttention(connection) === null &&
      (family === null || connection.family === family),
  );
}

/**
 * The family a role's turns run on in this thread, or null for the whole thread or a role the
 * crew does not name. A builder turn is the thread's own selection when there is no crew, and the
 * fixer is the builder again unless the crew names its own.
 */
export function roleFamily(thread: ChatThread, role: ConnectionRole): ChatFamily | null {
  if (role === 'thread') return null;
  const member = (name: ConnectionRole) =>
    thread.crew?.members.find((value) => value.role === name)?.selection.family ?? null;
  const builder = member('builder') ?? thread.selection?.family ?? null;
  if (role === 'builder') return builder;
  if (role === 'fixer') return member('fixer') ?? (thread.crew ? builder : null);
  return member(role);
}
