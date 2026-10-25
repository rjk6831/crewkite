import type { WorkspaceState } from '@crewkite/contracts';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Fact } from '../components.tsx';
import type { Workspace } from '../source.ts';
import { nativeUsageClients } from '../usage-presentation.ts';
import type { ProviderActions } from './provider-actions.ts';

type Family = 'openai' | 'anthropic' | 'google';

export function clientFor(header: WorkspaceState, family: Family, now: number) {
  const client = nativeUsageClients(header).find((value) => value.family === family);
  const reader = client?.reader ?? null;
  const profiles = client?.profiles ?? [];
  // A read of any outcome starts a one-minute cooldown, so the button says when it opens again.
  const nextReadAt = reader?.lastAttemptAt ? Date.parse(reader.lastAttemptAt) + 60_000 : null;
  return {
    label: client?.label ?? family,
    profiles,
    reader,
    nextReadAt,
    cooldownSeconds:
      nextReadAt !== null && nextReadAt > now
        ? Math.max(1, Math.ceil((nextReadAt - now) / 1000))
        : 0,
    codingReady: profiles.some((profile) => profile.available),
  };
}

export function ClientStatus({
  family,
  header,
  now,
  facts = true,
  children,
}: {
  family: Family;
  header: WorkspaceState;
  now: number;
  /** Google setup lists the same two facts itself. */
  facts?: boolean;
  children: ReactNode;
}) {
  const { label, profiles, reader, codingReady } = clientFor(header, family, now);
  const quota =
    family === 'anthropic' && reader?.reading
      ? `Received ${new Date(reader.reading.receivedAt).toLocaleTimeString()} · age unknown`
      : reader?.lastObservedAt
        ? 'Reported'
        : reader?.available
          ? 'Reader ready, not read'
          : 'Unknown';
  return (
    <section className="st-block" aria-label={`${label} client status`}>
      <div className="st-subhead">
        <h3>Client</h3>
        <span>{codingReady ? 'Supported client present' : 'Supported client unavailable'}</span>
      </div>
      {profiles.map((profile) => (
        <p className="st-note" key={profile.id}>
          {profile.id}: {profile.reason}
        </p>
      ))}
      {profiles.length === 0 && <p className="st-note">No native profile is registered.</p>}
      {facts && (
        <div className="facts-grid compact">
          <Fact label="Coding setup ready" value={codingReady ? 'Yes' : 'No'} />
          <Fact label="Quota available" value={quota} />
        </div>
      )}
      {children}
    </section>
  );
}

/** Refresh for the families whose quota the controller reads without asking for trust first. */
export function QuotaRefresh({
  family,
  header,
  workspace,
  now,
  actions,
}: {
  family: 'openai' | 'google';
  header: WorkspaceState;
  workspace: Workspace;
  now: number;
  actions: ProviderActions;
}) {
  const { label, reader, cooldownSeconds } = clientFor(header, family, now);
  const connected = workspace.connection === 'connected' && !workspace.preview;
  const message = actions.messages[family];
  return (
    <>
      <p className="st-note">
        Reads account quota through the supported native client. No model request.
      </p>
      <div className="st-actions">
        <button
          type="button"
          className="button secondary"
          disabled={
            !connected ||
            actions.busy[family] ||
            !reader?.available ||
            reader.readState === 'intent' ||
            reader.readState === 'owned' ||
            cooldownSeconds > 0
          }
          onClick={() => void actions.observeUsage(family)}
        >
          <RefreshCw size={14} /> Refresh {label} quota
        </button>
      </div>
      {family === 'openai' &&
        reader?.readState === 'quiescent' &&
        reader.readReason === 'observed' && <p role="status">Latest quota read successful.</p>}
      <p className="st-note">
        Reader status: {reader?.reason ?? 'unavailable'}. Updated:{' '}
        {reader?.lastObservedAt ?? 'Not observed'}.
      </p>
      {reader?.readState && (
        <p className="st-note">
          Read state: {reader.readState}. Result: {reader.readReason ?? 'No completed result'}.
          {reader.lastRequest ? ` Last request: ${reader.lastRequest}.` : ''}
        </p>
      )}
      {cooldownSeconds > 0 && (
        <p className="st-note">Refresh available in {cooldownSeconds}s. Failed reads also count.</p>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}
