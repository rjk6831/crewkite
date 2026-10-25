import { GoogleSetup } from '../google-setup.tsx';
import { usageCards } from '../thread/usage-cards.ts';
import { ClientStatus, QuotaRefresh } from './client-status.tsx';
import { Allowance, type CardProps, ProviderCard } from './provider-card.tsx';

export function GoogleCard({ header, workspace, entry, now, actions, scopes }: CardProps) {
  const cards = usageCards(
    scopes.filter(({ family }) => family === 'google'),
    { usageReaders: [] },
  );
  return (
    <ProviderCard
      family="google"
      entry={entry}
      main={
        <>
          <p className="st-note">The quota read runs by default. Chat needs Connect.</p>
          <GoogleSetup snapshot={header} workspace={workspace} />
          <ClientStatus family="google" header={header} now={now} facts={false}>
            <QuotaRefresh
              family="google"
              header={header}
              workspace={workspace}
              now={now}
              actions={actions}
            />
          </ClientStatus>
        </>
      }
      side={
        <Allowance
          label="Google"
          cards={cards}
          now={now}
          none="No usage has been read. Refresh quota to read it."
        />
      }
    />
  );
}
