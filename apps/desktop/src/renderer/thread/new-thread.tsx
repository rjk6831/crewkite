import {
  type ChatAttachment,
  type ChatCatalogRead,
  ChatFamilySchema,
  type ChatThread,
  type LocalSetup,
  type Task,
  TaskSchema,
  type WorkspaceState,
} from '@crewkite/contracts';
import { Folder, PanelRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { familyName } from '../components.tsx';
import {
  applyDraft,
  crewForProject,
  crewFromPreset,
  type DraftSettings,
  draftConfigure,
  draftSettings,
  preferredSelection,
} from '../settings/preferences.ts';
import { focusSettingsCard } from '../settings/provider-card.tsx';
import type { DesktopCommand } from '../source.ts';
import { configureThread, importAttachment, sendMessage, type ThreadSource } from './commands.ts';
import { Composer, type ComposerHandle, type SendInput } from './composer.tsx';
import { EmptyThread } from './empty-thread.tsx';
import { FamilyMark } from './family-mark.tsx';
import { Inspector, type InspectorTab } from './inspector.tsx';
import { defaultSelection } from './model-picker.tsx';
import './thread.css';

const NO_PROVIDER = 'Connect a provider in Settings';

/** What New thread shows while no family is connected. Each family links to its Settings card. */
function FirstRun({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <div className="th-empty th-first-run">
      <p>Connect a provider to start</p>
      <p className="th-muted">
        {onOpenSettings ? 'Pick one to open its card in Settings.' : 'Connect one in Settings.'}
      </p>
      <ul className="th-first-run-list" aria-label="Providers">
        {ChatFamilySchema.options.map((family) => (
          <li key={family}>
            {onOpenSettings ? (
              <button
                type="button"
                className="th-first-run-item"
                onClick={() => {
                  focusSettingsCard(family);
                  onOpenSettings();
                }}
              >
                <FamilyMark family={family} />
                <span>{familyName(family)}</span>
              </button>
            ) : (
              <span className="th-first-run-item">
                <FamilyMark family={family} />
                <span>{familyName(family)}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Project = { id: string; name: string };

/**
 * The thread record the side panel and the composer read before the first send. It has no task,
 * scratch copy, sessions or turns; only the settings the person can change are real.
 */
const draftThread = (settings: DraftSettings): ChatThread => ({
  taskId: '',
  scratchReady: false,
  base: null,
  sessions: [],
  activeTurnId: null,
  queued: [],
  crewChain: null,
  ...settings,
});

// The first message creates the thread. The task needs an outcome and one criterion, so the message
// is the outcome and the criterion says what is being asked.
// A message of files alone has no text, so the thread is named for its files.
function taskPayload(projectId: string, message: string, names: readonly string[]) {
  const text = message.trim() !== '' ? message : `Files: ${names.join(', ')}`;
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? text;
  return {
    projectId,
    title: firstLine.trim().slice(0, 80),
    outcome: text.slice(0, 4096),
    criteria: ['The request in this thread is addressed.'],
  };
}

export function NewThread({
  source,
  createTask,
  projects,
  projectId,
  onProject,
  onCreated,
  onAddProject,
  onOpenSettings,
  blocked,
  focusComposer = false,
  prefill,
  onPrefilled,
  localSetup,
  refresh,
}: {
  source: ThreadSource;
  createTask: (
    input: DesktopCommand,
  ) => Promise<{ outcome: string; entity?: unknown; reason?: string; next?: string }>;
  projects: readonly Project[];
  projectId: string;
  onProject: (id: string) => void;
  onCreated: (taskId: string) => void;
  onAddProject: (() => void) | null;
  /** Opens Settings. The first-run card focuses a family's card before calling it. */
  onOpenSettings?: () => void;
  blocked: string | null;
  /** Put the cursor in the message box, as after Add project. */
  focusComposer?: boolean;
  /** Text to put in the box once, such as the first-run suggestion. It is never sent for the person. */
  prefill?: string | null;
  onPrefilled?: () => void;
  localSetup?: LocalSetup | null;
  refresh?: () => Promise<WorkspaceState>;
}) {
  // A send that fails after the task exists keeps the task, so a retry does not create a second one.
  const created = useRef<Task | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const [catalog, setCatalog] = useState<ChatCatalogRead | null>(null);
  // The side panel edits these before the thread exists. The first send applies them once.
  const [draft, setDraft] = useState<DraftSettings>(() => draftSettings());
  const pending = useMemo(() => draftThread(draft), [draft]);
  const configured = useRef(false);
  // The project's crew, else the default crew, once the catalog says which families are
  // connected. A crew or mode the person picks in the panel stays, and so does the model picked
  // in the composer, so this runs once per project.
  const crewPicked = useRef(false);
  const crewFor = useRef<string | null>(null);
  useEffect(() => {
    if (!catalog || crewPicked.current || crewFor.current === projectId) return;
    crewFor.current = projectId;
    setDraft((current) => {
      const choice = crewForProject(projectId);
      const model = current.selection ?? preferredSelection(catalog) ?? defaultSelection(catalog);
      const crew = choice && crewFromPreset(choice.template, catalog, model, current.handoffMode);
      const base = applyDraft(current, { crew: null });
      if (!crew) return base;
      const builder = crew.members.find((member) => member.role === 'builder')?.selection;
      return applyDraft(base, {
        crew,
        ...(builder ? { selection: builder } : {}),
        ...(choice.flightMode ? { flightMode: choice.flightMode } : {}),
      });
    });
  }, [catalog, projectId]);
  const [panel, setPanel] = useState<{ open: boolean; tab: InspectorTab }>({
    open: false,
    tab: 'crew',
  });
  const toggle = useRef<HTMLButtonElement>(null);
  const closePanel = useCallback(() => {
    if (document.activeElement?.closest('.th-inspector')) toggle.current?.focus();
    setPanel((current) => ({ ...current, open: false }));
  }, []);
  const project = projects.find(({ id }) => id === projectId);
  // The box is blocked until the project is in the list, and a blocked box takes no focus.
  const ready = !!project;
  useEffect(() => {
    if (focusComposer && ready) composer.current?.focus();
  }, [focusComposer, ready]);
  useEffect(() => {
    if (!prefill || !ready) return;
    composer.current?.fill(prefill);
    onPrefilled?.();
  }, [prefill, ready, onPrefilled]);
  // Until the catalog is read, nothing says no family is connected, so Send stays open.
  const firstRun = catalog !== null && !catalog.families.some((family) => family.connected);

  // The first send creates the task. The files wait as paths until then, and the controller stores
  // them under the new task before the message goes.
  async function send({ text, files, selection }: SendInput) {
    if (!project) throw new Error('Choose a project first.');
    if (!created.current) {
      const result = await createTask({
        command: 'CreateTask',
        expectedRevision: 0,
        payload: taskPayload(
          project.id,
          text,
          files.map((item) => item.name),
        ),
      } as DesktopCommand);
      const saved = TaskSchema.safeParse(result.entity);
      if ((result.outcome !== 'applied' && result.outcome !== 'already-applied') || !saved.success)
        throw new Error(result.next ?? result.reason ?? 'The thread could not be created.');
      created.current = saved.data;
    }
    const taskId = created.current.id;
    // A failure here stops the send, so the first turn never runs on settings the person did not
    // pick. A retry applies them again on the same thread.
    if (!configured.current) {
      for (const patch of draftConfigure(draft))
        await configureThread(source, { taskId, ...patch });
      configured.current = true;
    }
    const stored: ChatAttachment[] = [];
    for (const item of files)
      stored.push(item.file ?? (await importAttachment(source, taskId, item.path ?? '')));
    await sendMessage(source, {
      taskId,
      text,
      files: stored,
      ...(selection ? { selection } : {}),
    });
    onCreated(taskId);
  }

  return (
    <div className={panel.open ? 'thread has-inspector' : 'thread'}>
      <section className="th-main" aria-label="New thread">
        <header className="th-bar">
          <h1 className="th-title">New thread</h1>
          {projects.length > 0 && (
            <label className="th-project-select">
              <span className="th-sr">Project</span>
              <Folder size={13} aria-hidden="true" />
              <select value={projectId} onChange={(event) => onProject(event.target.value)}>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            ref={toggle}
            type="button"
            className="th-icon th-bar-toggle"
            aria-label="Toggle inspector"
            aria-pressed={panel.open}
            title="Inspector"
            onClick={() => setPanel({ ...panel, open: !panel.open })}
          >
            <PanelRight size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="th-scroll-frame">
          <div className="th-blank">
            {project && firstRun ? (
              <FirstRun onOpenSettings={onOpenSettings} />
            ) : project ? (
              <EmptyThread onPick={(text) => composer.current?.fill(text)} />
            ) : (
              <div className="th-empty">
                <p>No project yet</p>
                <p className="th-muted">Add a Git repository to start a thread.</p>
                {onAddProject && (
                  <button type="button" className="th-button" onClick={onAddProject}>
                    Add project
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <Composer
          ref={composer}
          source={source}
          taskId={null}
          thread={pending}
          running={false}
          context={null}
          currentFamily={null}
          blocked={
            blocked ??
            (!project ? 'Add a project to send a message.' : firstRun ? NO_PROVIDER : null)
          }
          notice={null}
          onSend={send}
          onStop={async () => {}}
          onConfigured={() => {}}
          onHandoff={async () => {}}
          onOpenCrew={() => setPanel({ open: true, tab: 'crew' })}
          onCatalog={setCatalog}
          localState={refresh ? { setup: localSetup, refresh } : undefined}
        />
      </section>
      {panel.open && (
        <Inspector
          draft
          source={source}
          taskId=""
          title="New thread"
          thread={pending}
          turns={[]}
          messages={[]}
          loaded
          header={null}
          preview={false}
          tab={panel.tab}
          onTab={(tab) => setPanel({ ...panel, tab })}
          onClose={closePanel}
          changesKey={0}
          focusPath={null}
          onConfigure={(patch) => {
            if (patch.crew !== undefined || patch.flightMode) crewPicked.current = true;
            setDraft((current) => applyDraft(current, patch));
          }}
        />
      )}
    </div>
  );
}
