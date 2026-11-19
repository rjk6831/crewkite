import {
  type ChatThread,
  CONNECTION_COPY,
  type CommandResult,
  type Connection,
  type ConnectionAssignment,
  type ConnectionRole,
  type ConnectionsRead,
} from '@crewkite/contracts';
import { FIRST_SELECTION, SELECTION } from '../thread/preview-data.ts';
import { previewLoginLine } from './providers/preview-sign-in.ts';

// Billing connections in the browser preview. A `state` query parameter picks where they start:
// api-spend puts two connections with spend on the rail, connections-ready two ready ones and a
// crew to set them on, and every other state none. Add, Check sign-in, Keep connected,
// Disconnect, Forget and the Crew tab's choices answer from memory the way the controller does.
// In connections-mismatch, Check sign-in finds a subscription sign-in in the connection's own
// profile. Nothing leaves the window.

const connectionId = (n: number) => `con_01KA${String(n).padStart(22, '0')}`;
const profileOf = (id: string) => `api-${id.slice(4).toLowerCase()}`;
// The client's read takes a moment, so Checking sign-in shows the way it does in the app.
const CHECK_MS = 600;

function readyRecords(now: string): Connection[] {
  const ready = {
    backend: 'native-client',
    billingMode: 'api',
    readiness: 'ready',
    proofGeneration: 1,
    observedMode: 'api',
    observedAt: now,
  } as const;
  return [
    {
      ...ready,
      connectionId: connectionId(1),
      family: 'openai',
      profileId: profileOf(connectionId(1)),
      keepConnected: true,
    },
    {
      ...ready,
      connectionId: connectionId(2),
      family: 'anthropic',
      profileId: profileOf(connectionId(2)),
      label: 'Client work',
      keepConnected: false,
    },
  ];
}

export function connectionsPreview(
  named: string | null,
  now: string,
  initial: ConnectionsRead | null,
) {
  let connections: Connection[] =
    initial?.connections ?? (named === 'connections-ready' ? readyRecords(now) : []);
  let assignments: ConnectionAssignment[] = initial?.assignments ?? [];
  const spend = initial?.spend ?? [];
  let added = connections.length;
  const read = (taskId: unknown): ConnectionsRead => ({
    connections: structuredClone(connections),
    assignments: assignments.filter((row) => row.taskId === taskId),
    spend: spend.filter((row) =>
      connections.some((value) => value.connectionId === row.connectionId),
    ),
    loginLines: connections.map((value) => ({
      connectionId: value.connectionId,
      line: previewLoginLine(value.family, value.profileId),
    })),
  });
  const applied = (data?: unknown) =>
    ({ outcome: 'applied', ...(data ? { data } : {}) }) as CommandResult;
  const gone: CommandResult = {
    outcome: 'blocked',
    reason: 'connection-not-found',
    next: 'This connection is gone. Read the connections again.',
  };
  const change = (id: unknown, patch: Partial<Connection>) => {
    if (!connections.some((value) => value.connectionId === id)) return gone;
    connections = connections.map((value) =>
      value.connectionId === id ? { ...value, ...patch } : value,
    );
    return applied();
  };
  return {
    // A builder on Anthropic and a reviewer on OpenAI, so each role offers its own family's.
    thread:
      named === 'connections-ready'
        ? ({
            crew: {
              name: 'Tandem',
              members: [
                { role: 'builder', selection: SELECTION },
                { role: 'reviewer', selection: FIRST_SELECTION },
              ],
            },
          } as Partial<ChatThread>)
        : null,
    command(
      name: string,
      payload: Record<string, unknown>,
    ): CommandResult | Promise<CommandResult> | null {
      const id = payload.connectionId;
      switch (name) {
        case 'ReadConnections':
          return applied({ kind: 'connections', ...read(payload.taskId) });
        case 'AddConnection': {
          const family = payload.family === 'anthropic' ? 'anthropic' : 'openai';
          const next = connectionId(++added);
          const connection: Connection = {
            connectionId: next,
            family,
            backend: 'native-client',
            billingMode: 'api',
            profileId: profileOf(next),
            ...(typeof payload.label === 'string' ? { label: payload.label } : {}),
            keepConnected: false,
            readiness: 'needs-attention',
            proofGeneration: 0,
            observedMode: null,
            observedAt: null,
          };
          connections = [...connections, connection];
          return applied({
            kind: 'connection-added',
            connection,
            loginLine: previewLoginLine(family, connection.profileId),
          });
        }
        case 'ProveConnection': {
          const found = connections.find((value) => value.connectionId === id);
          if (!found) return gone;
          const mode = named === 'connections-mismatch' ? 'subscription' : 'api';
          return new Promise((resolve) =>
            setTimeout(() => {
              change(id, {
                proofGeneration: found.proofGeneration + 1,
                observedMode: mode,
                observedAt: now,
                readiness: mode === 'api' ? 'ready' : 'needs-attention',
              });
              resolve(
                mode === 'api'
                  ? applied({ kind: 'connections', ...read(null) })
                  : {
                      outcome: 'blocked',
                      reason: 'mode-mismatch',
                      next: CONNECTION_COPY.signInChanged,
                    },
              );
            }, CHECK_MS),
          );
        }
        case 'SetKeepConnected':
          return change(id, { keepConnected: payload.keepConnected === true });
        case 'DisconnectConnection':
          return change(id, { readiness: 'disconnected', observedMode: null, observedAt: null });
        case 'ForgetConnection': {
          const result = change(id, {});
          connections = connections.filter((value) => value.connectionId !== id);
          assignments = assignments.filter((row) => row.connectionId !== id);
          return result;
        }
        case 'AssignConnection': {
          if (!connections.some((value) => value.connectionId === id)) return gone;
          const row = {
            taskId: String(payload.taskId),
            role: payload.role as ConnectionRole,
            connectionId: String(id),
          };
          assignments = [
            ...assignments.filter(
              (value) => value.taskId !== row.taskId || value.role !== row.role,
            ),
            row,
          ];
          return applied();
        }
        case 'UnassignConnection':
          assignments = assignments.filter(
            (value) => value.taskId !== payload.taskId || value.role !== payload.role,
          );
          return applied();
        default:
          return null;
      }
    },
  };
}
