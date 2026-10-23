import { RefreshCw } from 'lucide-react';
import { Dialog } from '../components.tsx';
import { usageCards } from '../thread/usage-cards.ts';
import { ClientStatus, clientFor } from './client-status.tsx';
import { Allowance, type CardProps, ProviderCard } from './provider-card.tsx';

const signInText = (state: string | undefined) =>
  state === 'signed-in'
    ? 'Signed in with Anthropic account'
    : state === 'signed-out'
      ? 'Signed out'
      : `Sign-in ${state ?? 'unchecked'}`;

export function AnthropicCard({ header, workspace, entry, now, actions, scopes }: CardProps) {
  const connection = header.nativeConnections.find(({ family }) => family === 'anthropic');
  const { reader, profiles, nextReadAt, cooldownSeconds } = clientFor(header, 'anthropic', now);
  const connected = workspace.connection === 'connected' && !workspace.preview;
  const busy = actions.busy.anthropic;
  const message = actions.messages.anthropic;
  const cards = usageCards(
    scopes.filter(({ family }) => family === 'anthropic'),
    header,
  );
  return (
    <ProviderCard
      family="anthropic"
      entry={entry}
      detail={connection?.state === 'signed-in' ? 'Signed in with a subscription' : undefined}
      main={
        <ClientStatus family="anthropic" header={header} now={now}>
          <p role="status">{signInText(connection?.state)}</p>
          <div className="st-actions">
            <button
              type="button"
              className="button secondary"
              disabled={
                !connected ||
                !profiles.some((profile) => profile.available) ||
                busy ||
                connection?.state === 'checking'
              }
              onClick={() => void actions.checkAnthropic()}
            >
              Check Anthropic sign-in
            </button>
          </div>
          <p className="st-note">
            {connection?.next ??
              'Check the existing native client sign-in. No model prompt is sent.'}
          </p>
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
              Last checked: {connection.observedAt}. Billing and task qualification remain unknown.
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
              onClick={() =>
                reader?.trust?.accepted
                  ? void actions.refreshAnthropic()
                  : actions.setTrust(reader?.trust ?? null)
              }
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
          <p className="st-note">
            Invokes the native local /usage command and sends no generation request. Sign-in does
            not grant native-client trust. Reported quota can be cached; its age stays unknown.
          </p>
          {reader?.readReason && <p role="status">Last refresh: {reader.readReason}.</p>}
          {cooldownSeconds > 0 && nextReadAt !== null && (
            <p className="st-note">
              Refresh available after {new Date(nextReadAt).toLocaleTimeString()}. Failed reads also
              count.
            </p>
          )}
          {message && <p role="status">{message}</p>}
          {actions.trust && (
            <Dialog title="Trust the native usage command" onClose={() => actions.setTrust(null)}>
              <p>
                CrewKite will invoke the pinned native client’s local /usage command. It sends no
                generation request.
              </p>
              <p>
                Your native client can apply user or administrator policy hooks. Those hooks are
                covered by this native-client trust.
              </p>
              <p>
                Trust is remembered for this exact client, command and reader policy. A changed
                scope requires consent again. Sign-in alone does not grant trust.
              </p>
              <details>
                <summary>Command identity</summary>
                <p>Command: {actions.trust.command}</p>
                <p>Client checksum: {actions.trust.clientSha256}</p>
                <p>Scope checksum: {actions.trust.scopeHash}</p>
              </details>
              <button
                type="button"
                className="button secondary"
                onClick={() => actions.setTrust(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => actions.trust && void actions.refreshAnthropic(actions.trust)}
              >
                Trust and refresh quota
              </button>
            </Dialog>
          )}
        </ClientStatus>
      }
      side={
        <Allowance
          label="Anthropic"
          cards={cards}
          now={now}
          none="No usage has been read. Refresh quota to read it."
        />
      }
    />
  );
}
