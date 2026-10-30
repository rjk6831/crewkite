import type { ChatCatalogChange } from '@crewkite/contracts';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Workspace } from '../source.ts';
import { refreshModels } from '../thread/commands.ts';
import { usageCards } from '../thread/usage-cards.ts';
import { ClientStatus, QuotaRefresh } from './client-status.tsx';
import { Allowance, type CardProps, ProviderCard } from './provider-card.tsx';

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
  );
  return (
    <ProviderCard
      family="openai"
      entry={entry}
      onCheck={() => void actions.checkClient('openai')}
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
      models={entry?.connected && <ModelRefresh workspace={workspace} modelRead={modelRead} />}
    />
  );
}

/**
 * Reads the client's model list again. The other families list what their profile or setup
 * already holds, so only this card has the button.
 */
function ModelRefresh({
  workspace,
  modelRead,
}: {
  workspace: Workspace;
  modelRead: ChatCatalogChange | null;
}) {
  const [reading, setReading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Every read ends with chat.catalog, a background one too, so its reason replaces the last one.
  useEffect(() => setStatus(modelRead?.reason ?? null), [modelRead]);
  const source = workspace.source;
  const live = workspace.connection === 'connected' && !workspace.preview;
  async function refresh() {
    if (!source) return;
    setReading(true);
    try {
      const result = await refreshModels(source);
      setStatus(
        result.outcome === 'applied'
          ? null
          : (result.next ?? 'The model list could not be read. Refresh to try again.'),
      );
    } catch (failure) {
      setStatus(failure instanceof Error ? failure.message : 'The model list could not be read.');
    } finally {
      setReading(false);
    }
  }
  return (
    <>
      <div className="st-actions">
        <button
          type="button"
          className="button secondary"
          disabled={!source || !live || reading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} /> {reading ? 'Reading models' : 'Refresh models'}
        </button>
      </div>
      {status && (
        <p className="st-note" role="status">
          {status}
        </p>
      )}
    </>
  );
}
