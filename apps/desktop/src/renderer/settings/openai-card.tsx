import { usageCards } from '../thread/usage-cards.ts';
import { ClientStatus, QuotaRefresh } from './client-status.tsx';
import { Allowance, type CardProps, ProviderCard } from './provider-card.tsx';

export function OpenAiCard({ header, workspace, entry, now, actions, scopes }: CardProps) {
  const cards = usageCards(
    scopes.filter(({ family }) => family === 'openai'),
    { usageReaders: [] },
  );
  return (
    <ProviderCard
      family="openai"
      entry={entry}
      detail="Signs in through its own client"
      main={
        <ClientStatus family="openai" header={header} now={now}>
          <QuotaRefresh
            family="openai"
            header={header}
            workspace={workspace}
            now={now}
            actions={actions}
          />
        </ClientStatus>
      }
      side={
        <Allowance
          label="OpenAI"
          cards={cards}
          now={now}
          none="No usage has been read. Refresh quota to read it."
        />
      }
    />
  );
}
