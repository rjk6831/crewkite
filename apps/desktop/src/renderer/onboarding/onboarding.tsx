import {
  type ChatCatalogChange,
  type ChatCatalogRead,
  type ChatFamily,
  ChatFamilySchema,
  ProjectSchema,
  type WorkspaceState,
} from '@crewkite/contracts';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import { AnthropicCard } from '../settings/anthropic-card.tsx';
import { GoogleCard } from '../settings/google-card.tsx';
import { LocalCard } from '../settings/local-card.tsx';
import { OpenAiCard } from '../settings/openai-card.tsx';
import { useProviderActions } from '../settings/provider-actions.ts';
import type { CardProps, CatalogEntry } from '../settings/provider-card.tsx';
import { useClock } from '../settings/use-catalog.ts';
import '../settings/settings.css';
import type { Workspace } from '../source.ts';
import { FamilyMark } from '../thread/family-mark.tsx';
import { projectUsagePresentation } from '../usage-presentation.ts';
import {
  ONBOARDING_STEPS,
  type OnboardingStep,
  type OnboardingView,
  SUGGESTED_FIRST_MESSAGE,
} from './flow.ts';
import './onboarding.css';

const stepNames: Record<OnboardingStep, string> = {
  provider: 'Provider',
  project: 'Project',
  message: 'First message',
};

const familyNotes: Record<ChatFamily, string> = {
  openai: 'The OpenAI client, signed in on this computer.',
  anthropic: 'The Anthropic client, signed in with your own account.',
  google: 'Google’s own agent, signed in with your Google account. It needs your acknowledgement.',
  local: 'A model server on this computer, reached over loopback.',
};

function FamilyRow({
  family,
  entry,
  ready,
  needsAcknowledgement,
  children,
}: {
  family: ChatFamily;
  entry: CatalogEntry | undefined;
  ready: boolean;
  needsAcknowledgement: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const state = ready
    ? 'Ready'
    : needsAcknowledgement
      ? 'Needs acknowledgement'
      : entry
        ? 'Not connected'
        : 'Unknown';
  return (
    <li className="onb-family">
      <div className="onb-family-head">
        <FamilyMark family={family} />
        <div className="onb-family-text">
          <span className="onb-family-name">{familyName(family)}</span>
          <span className="onb-family-note">{familyNotes[family]}</span>
        </div>
        <span className={ready ? 'st-pill is-on' : 'st-pill'}>{state}</span>
        <button
          type="button"
          className="button secondary"
          aria-expanded={open}
          aria-controls={panel}
          aria-label={`${open ? 'Hide' : ready ? 'Review' : 'Set up'} ${familyName(family)}`}
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          {open ? 'Hide' : ready ? 'Review' : 'Set up'}
        </button>
      </div>
      {/* The panel holds the same card Settings shows, so every setup rule and gate stays in it. */}
      <div id={panel} className="onb-family-card" hidden={!open}>
        {open && children}
      </div>
    </li>
  );
}

function ProviderStep({
  workspace,
  header,
  catalog,
  modelRead,
  ready,
}: {
  workspace: Workspace;
  header: WorkspaceState;
  catalog: ChatCatalogRead | null;
  modelRead: ChatCatalogChange | null;
  ready: readonly ChatFamily[];
}) {
  const actions = useProviderActions(workspace);
  // A preview shows its fixtures at the time they were observed. A live page ticks each second so
  // the quota cooldown counts down.
  const fixtureTime = workspace.preview
    ? Math.max(0, ...header.usage.map(({ observation }) => Date.parse(observation.observedAt)))
    : null;
  const now = useClock(fixtureTime, 1000);
  const refresh = workspace.refresh;
  // Hardware and setup facts are sampled by the controller, so read them when the step opens.
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  const shared = {
    header,
    workspace,
    now,
    actions,
    scopes: projectUsagePresentation(header, null, now),
  };
  const entry = (family: ChatFamily) => catalog?.families.find((value) => value.family === family);
  const card = (family: ChatFamily): ReactNode => {
    const props: CardProps = { ...shared, entry: entry(family) };
    return family === 'openai' ? (
      <OpenAiCard {...props} modelRead={modelRead} />
    ) : family === 'anthropic' ? (
      <AnthropicCard {...props} />
    ) : family === 'google' ? (
      <GoogleCard {...props} />
    ) : (
      <LocalCard {...props} />
    );
  };
  return (
    <>
      <p className="onb-lead">
        CrewKite runs threads on OpenAI, Anthropic, Google or Local models. Connect one to continue.
        Each setup below is the one Settings has.
      </p>
      <ul className="onb-families" aria-label="Providers">
        {ChatFamilySchema.options.map((family) => (
          <FamilyRow
            key={family}
            family={family}
            entry={entry(family)}
            ready={ready.includes(family)}
            needsAcknowledgement={
              family === 'google' && !!entry(family)?.connected && !ready.includes(family)
            }
          >
            {card(family)}
          </FamilyRow>
        ))}
      </ul>
    </>
  );
}

function ProjectStep({
  workspace,
  projectId,
  onProject,
}: {
  workspace: Workspace;
  projectId: string | null;
  onProject: (id: string) => void;
}) {
  const { projects } = workspace;
  const [added, setAdded] = useState('');
  const select = useId();
  async function addProject() {
    const result = await workspace.pickProject().catch(() => null);
    const project = ProjectSchema.safeParse(result?.entity);
    if (
      !project.success ||
      (result?.outcome !== 'applied' && result?.outcome !== 'already-applied')
    )
      return;
    onProject(project.data.id);
    setAdded(project.data.name);
  }
  return (
    <>
      <p className="onb-lead">
        Choose the root of a Git repository. A thread works in a scratch copy, so your checkout
        stays as it is until you accept a change.
      </p>
      {projects.length > 0 && (
        <div className="onb-field">
          <label htmlFor={select}>Project</label>
          <select
            id={select}
            value={projectId ?? projects[0].id}
            onChange={(event) => onProject(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="onb-actions">
        {workspace.canPickProject ? (
          <button
            type="button"
            className={projects.length > 0 ? 'button secondary' : 'button primary'}
            disabled={workspace.pending || workspace.connection !== 'connected'}
            onClick={() => void addProject()}
          >
            <Folder size={14} aria-hidden="true" />
            {projects.length > 0 ? 'Add another project' : 'Add project'}
          </button>
        ) : (
          <p className="st-note">Adding a project needs the desktop app.</p>
        )}
      </div>
      <p className="st-note" role="status">
        {added ? `Added ${added}.` : ''}
      </p>
    </>
  );
}

function MessageStep() {
  return (
    <>
      <p className="onb-lead">
        This message goes into the composer when you open it. CrewKite does not send it, and you can
        edit it first.
      </p>
      <blockquote className="onb-message">{SUGGESTED_FIRST_MESSAGE}</blockquote>
    </>
  );
}

/**
 * The first-run welcome: connect a provider, add a project, then open the composer with a first
 * message in it. Every step can be skipped, and Skip ends the welcome for good.
 */
export function Onboarding({
  workspace,
  header,
  catalog,
  modelRead,
  view,
  onContinue,
  onBack,
  onSkip,
  onFinish,
}: {
  workspace: Workspace;
  header: WorkspaceState;
  catalog: ChatCatalogRead | null;
  modelRead: ChatCatalogChange | null;
  view: Extract<OnboardingView, { visible: true }>;
  onContinue: () => void;
  onBack: () => void;
  onSkip: () => void;
  /** Finish with the first message in the composer of this project. */
  onFinish: (projectId: string) => void;
}) {
  const { step, ready, canContinue, skipLabel } = view;
  const heading = useRef<HTMLHeadingElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const project = workspace.projects.find(({ id }) => id === chosen) ?? workspace.projects[0];
  const hint = useId();
  // A step change moves focus to its heading, so a screen reader starts at the new step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `step` is the trigger
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  const index = ONBOARDING_STEPS.indexOf(step);
  const titles: Record<OnboardingStep, string> = {
    provider: 'Connect a provider',
    project: 'Add a project',
    message: 'Start with a message',
  };
  return (
    <main className="onboarding" aria-labelledby="onb-title">
      <div className="onb-column">
        <header className="onb-head">
          <div>
            <p className="onb-eyebrow">Welcome</p>
            <h1 id="onb-title">Welcome to CrewKite</h1>
            <p className="onb-sub">
              {'Three short steps to your first thread. Settings > General brings this back.'}
            </p>
          </div>
          <button type="button" className="button secondary" onClick={onSkip}>
            {skipLabel}
          </button>
        </header>
        <ol className="onb-steps" aria-label="Steps">
          {ONBOARDING_STEPS.map((name, position) => (
            <li
              key={name}
              aria-current={name === step ? 'step' : undefined}
              className={position < index ? 'is-done' : name === step ? 'is-current' : undefined}
            >
              <span className="onb-step-number" aria-hidden="true">
                {position + 1}
              </span>
              {stepNames[name]}
            </li>
          ))}
        </ol>
        <section className="onb-panel" aria-labelledby="onb-step-title">
          <h2 id="onb-step-title" ref={heading} tabIndex={-1}>
            {titles[step]}
          </h2>
          {step === 'provider' && (
            <ProviderStep
              workspace={workspace}
              header={header}
              catalog={catalog}
              modelRead={modelRead}
              ready={ready}
            />
          )}
          {step === 'project' && (
            <ProjectStep
              workspace={workspace}
              projectId={project?.id ?? null}
              onProject={setChosen}
            />
          )}
          {step === 'message' && <MessageStep />}
        </section>
        <footer className="onb-foot">
          {step !== 'provider' && (
            <button type="button" className="button secondary" onClick={onBack}>
              Back
            </button>
          )}
          <span className="onb-foot-gap" />
          {!canContinue && (
            <p className="st-note" id={hint}>
              {step === 'provider'
                ? 'Connect a provider to continue, or skip for now.'
                : 'Add a project to continue.'}
            </p>
          )}
          {step === 'message' ? (
            <button
              type="button"
              className="button primary"
              disabled={!project}
              onClick={() => project && onFinish(project.id)}
            >
              Open the composer
            </button>
          ) : (
            <button
              type="button"
              className="button primary"
              disabled={!canContinue}
              aria-describedby={canContinue ? undefined : hint}
              onClick={onContinue}
            >
              Continue
            </button>
          )}
        </footer>
      </div>
    </main>
  );
}
