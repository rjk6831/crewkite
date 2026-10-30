import type { WorkspaceState } from '@crewkite/contracts';
import { useEffect } from 'react';
import type { Workspace } from '../source.ts';
import { projectUsagePresentation } from '../usage-presentation.ts';
import { AnthropicCard } from './anthropic-card.tsx';
import { ExtensionsCard } from './extensions-card.tsx';
import { GeneralCard } from './general-card.tsx';
import { GoogleCard } from './google-card.tsx';
import { LocalCard } from './local-card.tsx';
import { McpCard } from './mcp-card.tsx';
import { OpenAiCard } from './openai-card.tsx';
import { PromptsCard } from './prompts-card.tsx';
import { useProviderActions } from './provider-actions.ts';
import { useCatalog, useClock } from './use-catalog.ts';
import './settings.css';

/**
 * Providers and defaults in one place. The cards read the same catalog the composer offers, so the
 * models and the connection state here match what a thread can use.
 */
export function SettingsPage({
  workspace,
  header,
  theme,
  onTheme,
  onShowWelcome,
}: {
  workspace: Workspace;
  header: WorkspaceState;
  theme: string;
  onTheme: (theme: 'system' | 'dark' | 'light') => void;
  onShowWelcome?: () => void;
}) {
  const { catalog, error, modelRead } = useCatalog(workspace.source, header);
  const actions = useProviderActions(workspace);
  // A preview shows its fixtures at the time they were observed. A live page ticks each second so
  // the quota cooldown counts down.
  const fixtureTime = workspace.preview
    ? Math.max(0, ...header.usage.map(({ observation }) => Date.parse(observation.observedAt)))
    : null;
  const now = useClock(fixtureTime, 1000);
  const scopes = projectUsagePresentation(header, null, now);
  const refresh = workspace.refresh;
  // Hardware and setup facts are sampled by the controller, so read them when the page opens.
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  const card = {
    header,
    workspace,
    now,
    actions,
    scopes,
  };
  const entry = (family: string) => catalog?.families.find((value) => value.family === family);
  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <div className="st-column">
        <h1 id="settings-title">Settings</h1>
        {error && (
          <p className="st-error" role="status">
            {error} Model lists and connection state are unavailable until it reads again.
          </p>
        )}
        <GeneralCard
          catalog={catalog}
          theme={theme}
          onTheme={onTheme}
          onShowWelcome={onShowWelcome}
        />
        <OpenAiCard {...card} entry={entry('openai')} modelRead={modelRead} />
        <AnthropicCard {...card} entry={entry('anthropic')} />
        <GoogleCard {...card} entry={entry('google')} />
        <LocalCard {...card} entry={entry('local')} />
        <McpCard />
        <ExtensionsCard source={workspace.source} />
        {workspace.source && <PromptsCard source={workspace.source} />}
      </div>
    </main>
  );
}
