import type { WorkspaceState } from '@crewkite/contracts';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Fact } from '../components.tsx';
import { usageReadLine, type Workspace } from '../source.ts';
import { nativeUsageClients, readAgo } from '../usage-presentation.ts';
import type { ProviderActions } from './provider-actions.ts';

type Family = 'openai' | 'anthropic' | 'google';

/** Google setup states that come before discovery ends. */
const googleSettling = new Set([
  'uninitialized',
  'initializing',
  'authentication-required',
  'authenticating',
  'discovery-required',
  'discovering',
  'stopping',
]);

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
    // Anthropic chat, its quota reader and its sign-in check run the client found by version
    // range. The pinned writer profiles are a separate route and go unavailable on any update.
    clientReady:
      family === 'anthropic' ? !!reader?.available : profiles.some((profile) => profile.available),
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
  const { label, reader, codingReady, clientReady } = clientFor(header, family, now);
  // While Google setup is still working, its client line would read as a failure. It shows once
  // discovery has ended.
  const googleState = header.googleAcpSetup?.state;
  const settling =
    family === 'google' &&
    !codingReady &&
    (!!header.googleAcpSetup?.operationId ||
      !!header.googleAcpInstall?.operationId ||
      (googleState !== undefined && googleSettling.has(googleState)));
  // The Anthropic report carries no time of its own, so its age runs from when CrewKite received it.
  const lastRead =
    readAgo(family === 'anthropic' ? reader?.reading?.receivedAt : reader?.lastObservedAt, now) ??
    'Not read yet';
  return (
    <section className="st-block" aria-label={`${label} client status`}>
      <div className="st-subhead">
        <h3>Client</h3>
        {!settling && (
          <span>{clientReady ? 'Supported client present' : 'Supported client unavailable'}</span>
        )}
      </div>
      {/* Profile codes read as errors here. The diagnostics export keeps them for a bug report. */}
      {facts && (
        <div className="facts-grid compact">
          {/* The Anthropic writer profiles are a separate route, so its card leaves this out. */}
          {family !== 'anthropic' && (
            <Fact label="Coding setup ready" value={codingReady ? 'Yes' : 'No'} />
          )}
          <Fact label="Last read" value={lastRead} />
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
      {reader?.readState === 'quiescent' &&
        reader.readReason &&
        reader.readReason !== 'observed' && (
          <p className="st-note">{usageReadLine(reader.readReason)}</p>
        )}
      {cooldownSeconds > 0 && (
        <p className="st-note">Refresh available in {cooldownSeconds}s. Failed reads also count.</p>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}
