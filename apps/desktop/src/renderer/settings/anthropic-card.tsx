import { RefreshCw } from 'lucide-react';
import { formatLocalTime } from '../format-time.ts';
import { usageCards } from '../thread/usage-cards.ts';
import { anthropicReadReason, creditText } from '../usage-presentation.ts';
import { ClientStatus, clientFor } from './client-status.tsx';
import { Allowance, type CardProps, CreditSwitch, ProviderCard } from './provider-card.tsx';
import { ConnectLine } from './providers/connect.tsx';

const signInText = (state: string | undefined) =>
  state === 'signed-in'
    ? 'Signed in with Anthropic account'
    : state === 'signed-out'
      ? 'Signed out'
      : `Sign-in ${state ?? 'unchecked'}`;

export function AnthropicCard({ header, workspace, entry, now, actions, scopes }: CardProps) {
  const connection = header.nativeConnections.find(({ family }) => family === 'anthropic');
  const { reader, clientReady, nextReadAt, cooldownSeconds } = clientFor(header, 'anthropic', now);
  const connected = workspace.connection === 'connected' && !workspace.preview;
  const busy = actions.busy.anthropic;
  const message = actions.messages.anthropic;
  const detail = reader?.detail;
  const failure = reader?.readReason
    ? anthropicReadReason(reader.readReason, reader.clientVersion)
    : null;
  const cards = usageCards(
    scopes.filter(({ family }) => family === 'anthropic'),
    header,
  );
  return (
    <ProviderCard
      family="anthropic"
      entry={entry}
      onCheck={() => actions.checkClient('anthropic')}
      detail={connection?.state === 'signed-in' ? 'Signed in with a subscription' : undefined}
      main={
        <ClientStatus family="anthropic" header={header} now={now}>
          {/* Connect is the sign-in check. A signed-in client connects Anthropic on this device. */}
          <ConnectLine
            family="anthropic"
            header={header}
            workspace={workspace}
            connect={clientReady ? () => actions.checkAnthropic() : undefined}
          />
          <p role="status">{signInText(connection?.state)}</p>
          <div className="st-actions">
            <button
              type="button"
              className="button secondary"
              disabled={!connected || !clientReady || busy || connection?.state === 'checking'}
              onClick={() => void actions.checkAnthropic()}
            >
              Check Anthropic sign-in
            </button>
          </div>
          {/* The signed-in line above says enough. Other states carry the step to take. */}
          {connection?.next && connection.state !== 'signed-in' && (
            <p className="st-note">{connection.next}</p>
          )}
          {connection?.state === 'signed-out' && (
            <p className="st-note">
              Follow the{' '}
              <a
                href="https://github.com/rjk6831/crewkite/blob/main/docs/providers.md#anthropic-writer-preparation"
                target="_blank"
                rel="noreferrer"
              >
                native client sign-in instructions
              </a>
              , then check again.
            </p>
          )}
          {connection?.observedAt && (
            <p className="st-note">
              Last checked: {formatLocalTime(connection.observedAt) ?? 'unknown'}.
            </p>
          )}
          <div className="st-actions">
            <button
              type="button"
              className="button secondary"
              disabled={
                !connected ||
                !reader?.available ||
                busy ||
                reader.readState === 'intent' ||
                reader.readState === 'owned' ||
                reader.readState === 'unknown' ||
                (nextReadAt !== null && nextReadAt > now)
              }
              onClick={() => void actions.refreshAnthropic()}
            >
              <RefreshCw size={14} /> Refresh Anthropic quota
            </button>
            {reader?.operationId &&
              (reader.readState === 'intent' || reader.readState === 'owned') && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void actions.stopAnthropicUsage(reader.operationId as string)}
                >
                  Stop quota refresh
                </button>
              )}
          </div>
          <p className="st-note">Usage is read again every five minutes while Anthropic is idle.</p>
          {failure && <p role="status">{failure}</p>}
          {detail && reader?.readReason && reader.readReason !== 'reported' && (
            <>
              <p className="st-note">The client wrote</p>
              <pre className="st-code">{detail}</pre>
            </>
          )}
          {cooldownSeconds > 0 && nextReadAt !== null && (
            <p className="st-note">
              Refresh available after {new Date(nextReadAt).toLocaleTimeString()}. Failed reads also
              count.
            </p>
          )}
          {/* A failed read returns its reason code, which the line above already explains. */}
          {message && message !== reader?.readReason && <p role="status">{message}</p>}
        </ClientStatus>
      }
      side={
        <>
          <Allowance
            label="Anthropic"
            cards={cards}
            now={now}
            none="No usage has been read. Refresh quota to read it."
            credit={entry ? creditText(entry, entry.defaultModel) : null}
          />
          <CreditSwitch family="anthropic" entry={entry} workspace={workspace} />
        </>
      }
    />
  );
}
