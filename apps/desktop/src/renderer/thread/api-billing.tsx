import {
  type ChatFamily,
  CONNECTION_COPY,
  type ConnectionRole,
  type ConnectionsRead,
} from '@crewkite/contracts';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { familyName } from '../family-name.ts';
import { Select } from '../select.tsx';
import {
  CHARGES_APPLY,
  connectionAttention,
  connectionName,
  readyApiConnections,
} from '../settings/connection-view.ts';
import { connectionsChanged } from '../settings/use-catalog.ts';
import { assignConnection, type ThreadSource, unassignConnection } from './commands.ts';

/**
 * Use API billing for one crew role, or for the whole thread. It offers the ready API connections
 * on the role's family, or on any family for the whole thread, and assigns the one the person
 * picks. While one is assigned it names it, says provider charges apply and offers Remove, which
 * goes back to the subscription. With nothing to offer and nothing assigned it shows nothing.
 */
export function ApiBilling({
  source,
  taskId,
  read,
  slot,
  family,
  label,
  heading,
  onNote,
}: {
  source: ThreadSource;
  taskId: string;
  read: ConnectionsRead | null;
  /** The whole thread, or the one crew role this control assigns. */
  slot: ConnectionRole;
  /** The family the role runs on. Null for the whole thread. */
  family: ChatFamily | null;
  /** The role's name, for the control's accessible label. */
  label: string;
  /** A visible title above the control, for the whole thread's choice. */
  heading?: string;
  onNote: (note: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const assigned = read?.assignments.find((value) => value.role === slot);
  // A pick replaces the select with Remove, and Remove brings the select back. Once the read shows
  // the change, focus moves to the control that took the place of the one that had it.
  const box = useRef<HTMLSpanElement>(null);
  const changedFrom = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (changedFrom.current === undefined) return;
    if ((assigned?.connectionId ?? null) === changedFrom.current) return;
    changedFrom.current = undefined;
    box.current?.querySelector<HTMLElement>('button')?.focus();
  });
  const choices = readyApiConnections(read, family);
  if (!assigned && choices.length === 0) return null;
  async function change(step: () => Promise<unknown>) {
    const before = assigned?.connectionId ?? null;
    setBusy(true);
    try {
      await step();
      changedFrom.current = before;
      onNote(null);
    } catch (failure) {
      onNote(failure instanceof Error ? failure.message : 'The change was not saved.');
    } finally {
      setBusy(false);
      connectionsChanged();
    }
  }
  let control: ReactNode;
  if (assigned) {
    const connection = read?.connections.find(
      (value) => value.connectionId === assigned.connectionId,
    );
    // A role moved to another family keeps its assignment, which then never reaches it.
    const attention = !connection
      ? 'This connection is gone. Remove it.'
      : family && connection.family !== family
        ? `${label} runs on ${familyName(family)}, so this connection is not used.`
        : connectionAttention(connection);
    control = (
      <span className="th-crew-billing" ref={box}>
        <span className="th-crew-billing-name">
          {connection ? connectionName(connection) : CONNECTION_COPY.apiLabel}
        </span>
        <span className="th-muted">{CHARGES_APPLY}</span>
        {attention && <span className="th-crew-billing-attention">{attention}</span>}
        <button
          type="button"
          className="th-pill th-outline"
          disabled={busy}
          aria-label={`Remove API billing from ${label}`}
          onClick={() => void change(() => unassignConnection(source, taskId, slot))}
        >
          Remove
        </button>
      </span>
    );
  } else
    control = (
      <span className="th-crew-billing" ref={box}>
        <Select
          aria-label={`${label}: ${CONNECTION_COPY.useApiBilling}`}
          value=""
          disabled={busy}
          onChange={(event) => {
            const connectionId = event.target.value;
            if (connectionId)
              void change(() => assignConnection(source, { taskId, role: slot, connectionId }));
          }}
        >
          <option value="">{CONNECTION_COPY.subscriptionLabel}</option>
          <optgroup label={CONNECTION_COPY.useApiBilling}>
            {choices.map((connection) => (
              <option key={connection.connectionId} value={connection.connectionId}>
                {connectionName(connection)}
              </option>
            ))}
          </optgroup>
        </Select>
      </span>
    );
  return heading ? (
    <div className="th-billing">
      <span className="role-name">{heading}</span>
      {control}
    </div>
  ) : (
    control
  );
}
