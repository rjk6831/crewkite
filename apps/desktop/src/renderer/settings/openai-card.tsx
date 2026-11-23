import type { ChatCatalogChange } from '@crewkite/contracts';
import { usageCards } from '../thread/usage-cards.ts';
import { creditText } from '../usage-presentation.ts';
import { ClientStatus, QuotaRefresh } from './client-status.tsx';
import { Allowance, type CardProps, CreditSwitch, ProviderCard } from './provider-card.tsx';
import { providerEvidence } from './provider-evidence.ts';
import { ConnectLine } from './providers/connect.tsx';
import { connectedOnce } from './providers/connect-copy.ts';

export function OpenAiCard({
  header,
  workspace,
  entry,
  now,
  actions,
  scopes,
  modelRead,
}: CardProps & { modelRead: ChatCatalogChange | null }) {
  const cards = usageCards(
    scopes.filter(({ family }) => family === 'openai'),
    { usageReaders: [] },
    now,
  );
  return (
    <ProviderCard
      family="openai"
      entry={entry}
      evidence={providerEvidence('openai', entry, header, now)}
      cloud={{ header, workspace, modelNote: modelRead?.reason ?? null }}
      detail="Signs in through its own client"
      main={
        <ClientStatus family="openai" header={header} now={now}>
          <ConnectLine family="openai" header={header} workspace={workspace} />
          {connectedOnce(header, 'openai') && (
            <QuotaRefresh
              family="openai"
              header={header}
              workspace={workspace}
              now={now}
              actions={actions}
            />
          )}
        </ClientStatus>
      }
      side={
        <>
          <Allowance
            label="OpenAI"
            cards={cards}
            now={now}
            none={
              connectedOnce(header, 'openai')
                ? 'No usage has been read. Refresh quota to read it.'
                : 'Connect OpenAI to read its usage.'
            }
            credit={entry ? creditText(entry, entry.defaultModel) : null}
          />
          <CreditSwitch family="openai" entry={entry} workspace={workspace} />
        </>
      }
    />
  );
}
