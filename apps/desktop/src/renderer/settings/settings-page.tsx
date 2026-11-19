import type { WorkspaceState } from '@crewkite/contracts';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesignSystems } from '../design/context.ts';
import { DesignSystemCard } from '../design/system-card.tsx';
import type { RecipesView } from '../recipes/recipes-page.tsx';
import type { Workspace } from '../source.ts';
import { projectUsagePresentation } from '../usage-presentation.ts';
import { AnthropicCard } from './anthropic-card.tsx';
import { ConnectionsCard } from './connections-card.tsx';
import { CrewsCard } from './crews-card.tsx';
import { ExtensionsCard } from './extensions-card.tsx';
import { FeedbackCard } from './feedback-card.tsx';
import { GeneralCard } from './general-card.tsx';
import { GoogleCard } from './google-card.tsx';
import { LocalCard } from './local-card.tsx';
import { McpCard } from './mcp-card.tsx';
import { NotesCard } from './notes-card.tsx';
import { OpenAiCard } from './openai-card.tsx';
import { ProjectUsageCard } from './project-usage-card.tsx';
import { PromptsCard } from './prompts-card.tsx';
import { useProviderActions } from './provider-actions.ts';
import { SetupCard } from './setup-card.tsx';
import { useCatalog, useClock } from './use-catalog.ts';
import { WebhookCard } from './webhook-card.tsx';
import { WritingRulesCard } from './writing-rules-card.tsx';
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
  threadId,
  onClose,
  onOpenThread,
  onOpenRecipes,
}: {
  workspace: Workspace;
  header: WorkspaceState;
  theme: string;
  onTheme: (theme: 'system' | 'dark' | 'light') => void;
  onShowWelcome?: () => void;
  /** The open thread, whose last events the diagnostics export carries. */
  threadId?: string;
  /** Leaves Settings for the thread that was open. */
  onClose?: () => void;
  onOpenThread?: (taskId: string) => void;
  /** Opens the Recipes page on a project and one of its views. */
  onOpenRecipes?: (projectId: string, view: RecipesView) => void;
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
  // Escape leaves Settings too, unless a field or an open dialog takes it.
  useEffect(() => {
    if (!onClose) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
      if (document.querySelector('dialog[open]')) return;
      onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onClose]);
  // The Project setup card sends the person to the notes of the project it shows.
  const [notesFor, setNotesFor] = useState<{ projectId: string } | null>(null);
  // A rule, the design system or a note saved on this page reads the card's Context row again. A
  // version saved in the design system editor counts as well.
  const [contextSaves, setContextSaves] = useState(0);
  const contextSaved = () => setContextSaves((count) => count + 1);
  const { saved: designSaves } = useDesignSystems();
  const entry = (family: string) => catalog?.families.find((value) => value.family === family);
  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <div className="st-column">
        <div className="st-title">
          <h1 id="settings-title">Settings</h1>
          {onClose && (
            <button type="button" className="button secondary" onClick={onClose}>
              <ArrowLeft size={14} aria-hidden="true" />
              Back to threads
            </button>
          )}
        </div>
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
          source={workspace.source}
          threadId={threadId}
        />
        <FeedbackCard source={workspace.source} catalog={catalog} />
        <WebhookCard source={workspace.source} />
        <CrewsCard catalog={catalog} projects={workspace.projects} />
        <GoogleCard {...card} entry={entry('google')} />
        <OpenAiCard {...card} entry={entry('openai')} modelRead={modelRead} />
        <AnthropicCard {...card} entry={entry('anthropic')} />
        <LocalCard {...card} entry={entry('local')} />
        {workspace.source && <ConnectionsCard source={workspace.source} changed={header} />}
        <McpCard />
        <ExtensionsCard source={workspace.source} />
        {workspace.source && <PromptsCard source={workspace.source} />}
        {workspace.source && (
          <WritingRulesCard
            source={workspace.source}
            projects={workspace.projects}
            onChanged={contextSaved}
          />
        )}
        {workspace.source && (
          <SetupCard
            source={workspace.source}
            workspace={workspace}
            contextChanged={contextSaves + designSaves}
            onShowNotes={(projectId) => setNotesFor({ projectId })}
            onOpenThread={onOpenThread}
            onOpenRecipes={onOpenRecipes}
          />
        )}
        {workspace.source && (
          <DesignSystemCard
            source={workspace.source}
            projects={workspace.projects}
            onChanged={contextSaved}
          />
        )}
        {workspace.source && (
          <NotesCard
            source={workspace.source}
            projects={workspace.projects}
            show={notesFor}
            onChanged={contextSaved}
          />
        )}
        {workspace.source && (
          <ProjectUsageCard source={workspace.source} projects={workspace.projects} />
        )}
      </div>
    </main>
  );
}
