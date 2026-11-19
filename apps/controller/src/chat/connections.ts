import {
  type BillingMode,
  type ChatAdmission,
  type ChatFamily,
  type ChatRole,
  CONNECTION_COPY,
  type Command,
  type CommandResult,
  type Connection,
  type ConnectionAssignment,
  type ConnectionRole,
  type ConnectionsRead,
  MAX_CONNECTIONS,
  type Spend,
  SpendSchema,
} from '@crewkite/contracts';
import type { Store } from '../store/index.ts';

// Billing connections (ADR 0056). Each family has its own route: its subscription sign-in, or
// Local, which bills nothing. An API connection runs a turn only for the thread or the role the
// person assigned it to. The catalog never counts one as connected, so no ranking, default or
// preselect reaches it, and an automatic move never lands on one. The client keeps the
// credential; nothing here holds a key.

/**
 * The assignment a turn of this role reads besides the thread's. A builder turn is the assistant
 * role. An advisor and a side question have no slot of their own, so only the thread's reaches
 * them.
 */
export function connectionRole(role: ChatRole): ConnectionRole | null {
  if (role === 'assistant') return 'builder';
  if (role === 'advisor' || role === 'ask') return null;
  return role;
}

/**
 * The connection a turn of this role on this family runs on, or null for the family's own route.
 * The role's own assignment comes before the thread's. An assignment on another family never
 * reaches this one, and one role's assignment never reaches another role.
 */
export function routeFor(
  assignments: readonly Pick<ConnectionAssignment, 'role' | 'connectionId'>[],
  connection: (connectionId: string) => Connection | undefined,
  role: ChatRole,
  family: ChatFamily,
): Connection | null {
  for (const slot of [connectionRole(role), 'thread'] as const) {
    const assigned = slot && assignments.find((value) => value.role === slot);
    const found = assigned ? connection(assigned.connectionId) : undefined;
    if (found?.family === family) return found;
  }
  return null;
}

type Refusal = Extract<ChatAdmission, { outcome: 'refused' }>;
const NEXT = 'Reconnect it in Settings, or clear its assignment for this thread or role.';

/**
 * Why a turn may not start on this connection, or null when it may. The mode the client last
 * proved has to be the mode the person chose: an unknown mode blocks, and so does a client that
 * cannot run this mode on its own profile. `modes` is what the family's adapter can run there.
 */
export function connectionRefusal(
  connection: Connection,
  modes: readonly BillingMode[],
): Refusal | null {
  const api = connection.billingMode === 'api';
  const name = connection.label ?? (api ? CONNECTION_COPY.apiLabel : 'This connection');
  const refused = (message: string): Refusal => ({
    outcome: 'refused',
    reason: 'provider-not-ready',
    message,
    next: NEXT,
  });
  if (!modes.includes(connection.billingMode))
    return refused(
      api ? CONNECTION_COPY.apiUnverified : `CrewKite cannot run ${name} on this client yet.`,
    );
  if (connection.readiness === 'disconnected') return refused(`${name} is disconnected.`);
  if (connection.observedMode === null)
    return refused(`${name} has not confirmed its billing mode.`);
  if (connection.observedMode !== connection.billingMode || connection.readiness !== 'ready')
    return refused(
      api ? CONNECTION_COPY.signInChanged : `${name} reports another billing mode. Reconnect it.`,
    );
  return null;
}

/** A turn on an API connection before anything reported its cost. */
export const UNREPORTED: Spend = { reported: null, estimated: null, unreportedTurns: 1 };

/**
 * The sum of turn spends. Reported, estimated and unreported stay apart. An amount in a currency
 * other than the first one seen counts as an unreported turn, since two currencies do not add. A
 * summed estimate dates from its oldest part and counts as a price table when any part was one.
 */
export function sumSpend(spends: readonly Spend[]): Spend | null {
  if (!spends.length) return null;
  let total: Spend = { reported: null, estimated: null, unreportedTurns: 0 };
  for (const spend of spends) total = addSpend(total, spend);
  return SpendSchema.parse(total);
}

const addMicros = (a: number, b: number) => Math.min(a + b, Number.MAX_SAFE_INTEGER);

function addSpend(total: Spend, spend: Spend): Spend {
  let { reported, estimated, unreportedTurns } = total;
  unreportedTurns += spend.unreportedTurns;
  if (spend.reported) {
    if (!reported) reported = spend.reported;
    else if (reported.currency !== spend.reported.currency) unreportedTurns += 1;
    else
      reported = {
        ...reported,
        amountMicros: addMicros(reported.amountMicros, spend.reported.amountMicros),
      };
  }
  if (spend.estimated) {
    if (!estimated) estimated = spend.estimated;
    else if (estimated.currency !== spend.estimated.currency) unreportedTurns += 1;
    else
      estimated = {
        ...estimated,
        amountMicros: addMicros(estimated.amountMicros, spend.estimated.amountMicros),
        basis: spend.estimated.basis === 'price-table' ? 'price-table' : estimated.basis,
        at: spend.estimated.at < estimated.at ? spend.estimated.at : estimated.at,
      };
  }
  return { reported, estimated, unreportedTurns };
}

export class ConnectionsRefused extends Error {
  reason: 'task-not-found' | 'connection-not-found' | 'connections-full' | 'profile-unavailable';
  next: string;
  constructor(reason: ConnectionsRefused['reason'], next: string) {
    super(next);
    this.reason = reason;
    this.next = next;
  }
}

/**
 * What a family's client does for an API connection outside any turn. Each works in the
 * connection's own profile folder and never touches a sign-in CrewKite does not own.
 */
export type ConnectionClient = {
  /** Makes the profile folder, private to the person, before anyone signs in there. */
  prepare: (connection: Connection) => void;
  /** The line the person runs in their own terminal to sign the profile in. No key passes here. */
  loginLine: (connection: Connection) => string;
  /**
   * The mode the profile is signed in with, read by the client outside any turn. Null when it is
   * signed out. Undefined when the read failed or named something CrewKite cannot place.
   */
  readMode: (connection: Connection) => Promise<BillingMode | null | undefined>;
  signOut: (connection: Connection) => Promise<void>;
};

/**
 * The connection records and the person's assignments. Keeping a connection, assigning it and
 * permission to run stay three facts: a restart restores the first two and never the third.
 * Every change runs inside the caller's transaction, except a proof and the restore at startup.
 */
export class Connections {
  private readonly store: Store;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly client: ConnectionClient;
  /** Stops every open turn on a connection that just stopped being available. */
  private readonly stopTurns: (connectionId: string) => void;

  constructor(deps: {
    store: Store;
    now: () => string;
    id: () => string;
    client: ConnectionClient;
    stopTurns?: (connectionId: string) => void;
  }) {
    this.store = deps.store;
    this.now = deps.now;
    this.id = deps.id;
    this.client = deps.client;
    this.stopTurns = deps.stopTurns ?? (() => {});
  }

  /**
   * The connections, the given thread's assignments and the spend on each API connection. Spend
   * comes from the turns that ran there, in every thread.
   */
  read(taskId?: string): ConnectionsRead {
    if (taskId !== undefined && !this.store.get('task', taskId))
      throw new ConnectionsRefused('task-not-found', 'Choose a registered thread.');
    const connections = this.store.connections();
    // The rail reads this after every turn, so a home with no connection skips the turn scan.
    const rows = connections.length
      ? (this.store.db
          .prepare(
            "SELECT json_extract(body,'$.connectionId') AS connection_id, json_extract(body,'$.spend') AS spend FROM chat_turns WHERE json_extract(body,'$.connectionId') IS NOT NULL AND json_extract(body,'$.spend') IS NOT NULL",
          )
          .all() as { connection_id: string; spend: string }[])
      : [];
    const spend = connections.flatMap(({ connectionId }) => {
      const total = sumSpend(
        rows
          .filter((row) => row.connection_id === connectionId)
          .map((row) => SpendSchema.parse(JSON.parse(row.spend))),
      );
      return total ? [{ connectionId, spend: total }] : [];
    });
    const assignments =
      taskId === undefined
        ? []
        : this.store
            .connectionAssignments(taskId)
            .map(({ taskId, role, connectionId }) => ({ taskId, role, connectionId }));
    // The person can run a connection's sign-in line again at any time. One that cannot be built
    // leaves only its own line out.
    const loginLines = connections.flatMap((connection) => {
      if (connection.billingMode !== 'api' || connection.backend !== 'native-client') return [];
      try {
        return [{ connectionId: connection.connectionId, line: this.client.loginLine(connection) }];
      } catch {
        return [];
      }
    });
    return { connections, assignments, spend, loginLines };
  }

  /**
   * A new API connection with its own profile folder. It starts with no proof and Keep connected
   * off, so it admits nothing until the person signs the profile in and a check proves the mode.
   */
  add(family: 'openai' | 'anthropic', label: string | undefined) {
    if (this.store.connections().length >= MAX_CONNECTIONS)
      throw new ConnectionsRefused(
        'connections-full',
        `CrewKite keeps at most ${MAX_CONNECTIONS} connections. Forget one first.`,
      );
    const connectionId = this.id();
    const connection: Connection = {
      connectionId,
      family,
      backend: 'native-client',
      billingMode: 'api',
      profileId: `api-${connectionId.slice(4).toLowerCase()}`,
      ...(label ? { label } : {}),
      keepConnected: false,
      readiness: 'needs-attention',
      proofGeneration: 0,
      observedMode: null,
      observedAt: null,
    };
    // The folder comes first. A link in its path or a folder others can read refuses the command
    // with an answer, so the desktop does not keep the command and hold every other change. If the
    // row write fails after this, the folder stays, since it holds no sign-in yet.
    try {
      this.client.prepare(connection);
    } catch {
      throw new ConnectionsRefused(
        'profile-unavailable',
        "CrewKite could not make this connection's folder. Its path must be real folders that only you can read. Fix the folder, then add the connection again.",
      );
    }
    this.put(connection);
    return { connection, loginLine: this.client.loginLine(connection) };
  }

  /**
   * Asks the connection's own client for its mode, outside any turn, and records the answer in a
   * transaction of its own. A signed-out client disconnects the connection, and an answer CrewKite
   * cannot place records nothing. It never sends a prompt or starts work. `reconnect` marks the
   * person's own check, the one proof that brings back a disconnected connection.
   */
  async prove(connectionId: string, reconnect: boolean): Promise<CommandResult> {
    const gone: CommandResult = {
      outcome: 'blocked',
      reason: 'connection-not-found',
      next: 'This connection is gone. Read the connections again.',
    };
    const connection = this.store.connection(connectionId);
    if (!connection) return gone;
    const mode = await this.client.readMode(connection).catch(() => undefined);
    if (mode === undefined)
      return {
        outcome: 'blocked',
        reason: 'proof-unavailable',
        next: 'The client did not say which mode it is signed in with. Check that it is installed, then check again.',
      };
    let saved: Connection | undefined;
    try {
      saved = this.record(connectionId, mode, reconnect);
    } catch {
      return gone;
    }
    if (!saved) return gone;
    if (mode === null)
      return {
        outcome: 'blocked',
        reason: 'signed-out',
        next: 'Run the sign-in line in your terminal, then check again.',
      };
    if (saved.readiness !== 'ready')
      return { outcome: 'blocked', reason: 'mode-mismatch', next: CONNECTION_COPY.signInChanged };
    return { outcome: 'applied', data: { kind: 'connections', ...this.read() } };
  }

  /**
   * Records the mode a client proved for a connection's profile, the person's check or a turn's
   * own read, in a transaction of its own. A signed-out client disconnects the connection, and
   * every turn still running on it stops once that commits. Undefined when the connection is gone.
   */
  record(
    connectionId: string,
    mode: BillingMode | null,
    reconnect = false,
    /** The generation the proof's turn started on, when a turn sent it. */
    generation?: number,
  ): Connection | undefined {
    const effects: (() => void)[] = [];
    const saved = this.store.transaction(() => {
      const current = this.store.connection(connectionId);
      if (!current) return undefined;
      // A proof from a turn that started before the last one was made never makes the connection
      // ready again: that newer proof may have found a mismatch. A mismatch or a sign-out still
      // counts from any turn, since it only stops work.
      if (
        generation !== undefined &&
        generation < current.proofGeneration &&
        mode === current.billingMode
      )
        return current;
      return mode === null
        ? this.disconnect(connectionId, effects)
        : this.observe(connectionId, mode, reconnect);
    });
    for (const effect of effects) effect();
    return saved;
  }

  /** The connection a turn of this role on this family runs on, or null for its own route. */
  route(taskId: string, role: ChatRole, family: ChatFamily): Connection | null {
    return routeFor(
      this.store.connectionAssignments(taskId),
      (connectionId) => this.store.connection(connectionId),
      role,
      family,
    );
  }

  /** Only the person's explicit choice reaches here. The contract refuses any other consent. */
  assign(taskId: string, role: ConnectionRole, connectionId: string) {
    this.thread(taskId);
    this.find(connectionId);
    this.store.putConnectionAssignment({ taskId, role, connectionId }, this.now());
  }

  unassign(taskId: string, role: ConnectionRole) {
    this.thread(taskId);
    this.store.deleteConnectionAssignments(taskId, role);
  }

  setKeepConnected(connectionId: string, keepConnected: boolean): Connection {
    return this.put({ ...this.find(connectionId), keepConnected });
  }

  /**
   * Ends availability now. The record, its Keep connected choice and its assignments stay, so a
   * turn assigned to it is refused with a reason and never moves to another connection. A turn
   * already running on it stops once the change commits.
   */
  disconnect(connectionId: string, effects: (() => void)[] = []): Connection {
    const connection = this.put({
      ...this.find(connectionId),
      readiness: 'disconnected',
      observedMode: null,
      observedAt: null,
    });
    effects.push(() => this.stopTurns(connectionId));
    return connection;
  }

  /**
   * Removes the record and every assignment to it, stops a turn running on it, then signs the
   * owned profile out.
   */
  forget(connectionId: string, effects: (() => void)[]) {
    const connection = this.find(connectionId);
    this.store.deleteConnection(connectionId);
    effects.push(() => {
      this.stopTurns(connectionId);
      void this.client.signOut(connection).catch(() => {});
    });
  }

  /**
   * Records the mode the client just proved for the connection's profile, inside the caller's
   * transaction. Each proof moves the generation, so a proof read before it never admits a turn.
   * A mode other than the chosen one leaves the connection needing attention. A proof from a turn
   * or a restart leaves a disconnected connection as it is. Only the person's own check, with
   * `reconnect`, brings it back.
   */
  observe(connectionId: string, mode: BillingMode, reconnect = false): Connection {
    const connection = this.find(connectionId);
    if (connection.readiness === 'disconnected' && !reconnect) return connection;
    return this.put({
      ...connection,
      proofGeneration: connection.proofGeneration + 1,
      observedMode: mode,
      observedAt: this.now(),
      readiness: mode === connection.billingMode ? 'ready' : 'needs-attention',
    });
  }

  /**
   * At startup no earlier proof counts. A kept connection asks its client for the mode again,
   * through the same read the person's check uses, and starts no work. One not kept stays
   * disconnected until the person reconnects it. Local keeps its own setup and restore. The
   * records change before this returns, and a failure there stops startup. The proofs start once
   * startup has finished.
   */
  restore(): Promise<void> {
    const kept = this.store.transaction(() =>
      this.store.connections().flatMap((connection) => {
        if (connection.backend === 'local-runtime') return [];
        const keep = connection.keepConnected && connection.readiness !== 'disconnected';
        this.put({
          ...connection,
          readiness: keep ? 'needs-attention' : 'disconnected',
          observedMode: null,
          observedAt: null,
        });
        return keep ? [connection.connectionId] : [];
      }),
    );
    return Promise.resolve()
      .then(() => Promise.all(kept.map((connectionId) => this.prove(connectionId, false))))
      .then(() => {});
  }

  private put(connection: Connection): Connection {
    this.store.putConnection(connection, this.now());
    return connection;
  }

  private find(connectionId: string): Connection {
    const connection = this.store.connection(connectionId);
    if (!connection)
      throw new ConnectionsRefused(
        'connection-not-found',
        'This connection is gone. Read the connections again.',
      );
    return connection;
  }

  private thread(taskId: string) {
    if (!this.store.get('task', taskId))
      throw new ConnectionsRefused('task-not-found', 'Choose a registered thread.');
  }
}

export type ConnectionsCommand = Extract<
  Command,
  {
    command:
      | 'ReadConnections'
      | 'AddConnection'
      | 'AssignConnection'
      | 'UnassignConnection'
      | 'SetKeepConnected'
      | 'DisconnectConnection'
      | 'ForgetConnection';
  }
>;

/**
 * The commands that change connections. The controller does not race them on a revision. A proof
 * runs outside the journal, since it waits on the client and changes only what the client says.
 */
export const connectionMutations = [
  'AddConnection',
  'AssignConnection',
  'UnassignConnection',
  'SetKeepConnected',
  'DisconnectConnection',
  'ForgetConnection',
];

/**
 * Runs one connections command. A read answers with the records, the thread's assignments and the
 * spend. A change answers applied, and the caller reads again to see it. A refusal comes back as a
 * blocked result that carries the sentence for the person.
 */
export function connectionsCommand(
  connections: Connections,
  command: ConnectionsCommand,
  effects: (() => void)[],
): CommandResult {
  try {
    if (command.command === 'ReadConnections')
      return {
        outcome: 'applied',
        data: { kind: 'connections', ...connections.read(command.payload.taskId) },
      };
    if (command.command === 'AddConnection')
      return {
        outcome: 'applied',
        data: {
          kind: 'connection-added',
          ...connections.add(command.payload.family, command.payload.label),
        },
      };
    if (command.command === 'AssignConnection')
      connections.assign(
        command.payload.taskId,
        command.payload.role,
        command.payload.connectionId,
      );
    else if (command.command === 'UnassignConnection')
      connections.unassign(command.payload.taskId, command.payload.role);
    else if (command.command === 'SetKeepConnected')
      connections.setKeepConnected(command.payload.connectionId, command.payload.keepConnected);
    else if (command.command === 'DisconnectConnection')
      connections.disconnect(command.payload.connectionId, effects);
    else connections.forget(command.payload.connectionId, effects);
    return { outcome: 'applied' };
  } catch (failure) {
    if (failure instanceof ConnectionsRefused)
      return { outcome: 'blocked', reason: failure.reason, next: failure.next };
    throw failure;
  }
}
