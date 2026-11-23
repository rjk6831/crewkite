import { useState } from 'react';
import { GoogleRecovery } from '../google-recovery.tsx';
import { GoogleSetup } from '../google-setup.tsx';
import { type GoogleSetupStage, googleReasonLine } from '../google-setup-flow.ts';
import { usageCards } from '../thread/usage-cards.ts';
import { ClientStatus, QuotaRefresh } from './client-status.tsx';
import { Allowance, type CardProps, ProviderCard } from './provider-card.tsx';
import { providerEvidence } from './provider-evidence.ts';
import { ConnectLine } from './providers/connect.tsx';
import { connectedOnce } from './providers/connect-copy.ts';

export function GoogleCard({ header, workspace, entry, now, actions, scopes }: CardProps) {
  // The quota read waits for Connect. Until then the card shows no gauge and no refresh, even when
  // an older read left windows behind.
  const connected = entry?.connected === true;
  const [connecting, setConnecting] = useState<GoogleSetupStage | null>(null);
  // The card's status is the chat agent in use. Before there is one, the quota client stands in.
  const quota = header.usageReaders.find((reader) => reader.family === 'google')?.client;
  const agent = entry?.client;
  const cards = usageCards(
    scopes.filter(({ family }) => family === 'google'),
    { usageReaders: [] },
    now,
  );
  return (
    <ProviderCard
      family="google"
      entry={entry}
      evidence={providerEvidence('google', entry, header, now)}
      reasonLine={googleReasonLine(entry?.reason, header, connecting)}
      client={agent ?? quota}
      cloud={{ header, workspace }}
      main={
        <>
          <ConnectLine family="google" header={header} workspace={workspace} />
          <GoogleSetup
            snapshot={header}
            workspace={workspace}
            onConnecting={setConnecting}
            connectedOnce={connectedOnce(header, 'google')}
          />
          <GoogleRecovery header={header} workspace={workspace} />
          <ClientStatus family="google" header={header} now={now} facts={false}>
            {agent && quota && <p className="st-note">Quota client: {quota.message}</p>}
            {connected && (
              <QuotaRefresh
                family="google"
                header={header}
                workspace={workspace}
                now={now}
                actions={actions}
              />
            )}
          </ClientStatus>
        </>
      }
      side={
        <Allowance
          label="Google"
          cards={connected ? cards : []}
          now={now}
          none={
            connected
              ? 'No usage has been read. Refresh quota to read it.'
              : 'Connect Google to read its usage.'
          }
        />
      }
    />
  );
}
