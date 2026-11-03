import { useState } from 'react';
import { GoogleSetup } from '../google-setup.tsx';
import { type GoogleSetupStage, googleReasonLine } from '../google-setup-flow.ts';
import { usageCards } from '../thread/usage-cards.ts';
import { ClientStatus, QuotaRefresh } from './client-status.tsx';
import { Allowance, type CardProps, ProviderCard } from './provider-card.tsx';
import { ConnectLine } from './providers/connect.tsx';

export function GoogleCard({ header, workspace, entry, now, actions, scopes }: CardProps) {
  // The quota read waits for Connect. Until then the card shows no gauge and no refresh, even when
  // an older read left windows behind.
  const connected = entry?.connected === true;
  const [connecting, setConnecting] = useState<GoogleSetupStage | null>(null);
  const cards = usageCards(
    scopes.filter(({ family }) => family === 'google'),
    { usageReaders: [] },
  );
  return (
    <ProviderCard
      family="google"
      entry={entry}
      reasonLine={googleReasonLine(entry?.reason, header, connecting)}
      client={header.usageReaders.find((reader) => reader.family === 'google')?.client}
      onCheck={() => actions.checkClient('google')}
      main={
        <>
          <ConnectLine family="google" header={header} workspace={workspace} />
          <GoogleSetup snapshot={header} workspace={workspace} onConnecting={setConnecting} />
          <ClientStatus family="google" header={header} now={now} facts={false}>
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
