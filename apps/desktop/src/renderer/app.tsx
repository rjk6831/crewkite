import type {
  Approval,
  Event,
  Role,
  Run,
  Snapshot,
  Task,
  TaskConversationState,
  TaskPage,
  TaskSummary,
  WorkspaceState,
} from '@crewkite/contracts';
import {
  CommandSchema,
  MessageIdSchema,
  ProjectSchema,
  requiredReviewMethodIds,
  TaskIdSchema,
} from '@crewkite/contracts';
import { createDemoFixtures } from '@crewkite/testkit';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  Cpu,
  Download,
  FileCode,
  Folder,
  Gauge,
  GitBranch,
  Info,
  ListChecks,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ActivityView } from './activity.tsx';
import wordmark from './assets/crewkite-wordmark.png';
import inverseWordmark from './assets/crewkite-wordmark-inverse.png';
import { CombinedTask } from './combined-task.tsx';
import {
  actionName,
  Dialog,
  effectTarget,
  Fact,
  familyClass,
  familyName,
  methodName,
  moveTabFocus,
  RouterCard,
  SourceFacts,
  short,
  TaskNext,
  titleCase,
} from './components.tsx';
import {
  adoptedPlanCurrent,
  ConversationView,
  NewGoal,
  pendingGoalProject,
  type RegisterComposerRetry,
} from './conversation-view.tsx';
import { GoogleSetup } from './google-setup.tsx';
import {
  type ExecutionPolicySeed,
  googleAcpLabel,
  Launch,
  NativeEvaluation,
  NativeHandoff,
} from './launch.tsx';
import { LocalSetup } from './local-setup.tsx';
import { useWorkspace, type Workspace } from './source.ts';
import { roleLabels } from './templates.ts';
import { type UsageCard, UsageGauges, type UsageReading } from './usage-gauges.tsx';
import {
  nativeUsageClients,
  projectUsagePresentation,
  type UsageGaugeReading,
} from './usage-presentation.ts';

const tabs = [
  'Conversation',
  'Combined task',
  'Plan',
  'Changes',
  'Checks and review',
  'Handoffs',
  'Activity',
] as const;
type Tab = (typeof tabs)[number];
const roleNames: Role['role'][] = [
  'coder',
  'reviewer',
  'lead',
  'orchestrator',
  'advisor',
  'overseer',
];
function RouteSwitch({
  task,
  run,
  snapshot,
  workspace,
}: {
  task: Task;
  run: Run;
  snapshot: Snapshot;
  workspace: Workspace;
}) {
  const coder = run.roles.find((role) => role.role === 'coder');
  const ids = coder ? [coder.routeId, ...coder.approvedFallbacks] : [];
  const choices = snapshot.routes.filter((route) => ids.includes(route.id));
  const [selected, setSelected] = useState('');
  if (snapshot.nativeRuns.some((native) => native.runId === run.id)) return null;
  const target = selected || choices.find((route) => route.id !== run.decision.chosen)?.id || '';
  if (choices.length < 2) return null;
  return (
    <form
      className="route-switch"
      onSubmit={(event) => {
        event.preventDefault();
        if (!target || !ids.includes(target)) return;
        void workspace
          .command({
            command: 'SwitchRoute',
            expectedRevision: task.revision,
            payload: { taskId: task.id, runId: run.id, routeId: target },
          })
          .catch(() => {});
      }}
    >
      <label>
        Saved coder route
        <select value={target} onChange={(event) => setSelected(event.target.value)}>
          {choices.map((route) => (
            <option key={route.id} value={route.id}>
              {familyName(route.family)} · {route.model}
              {route.id === run.decision.chosen ? ' (current)' : ''}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="button secondary"
        disabled={
          !target ||
          target === run.decision.chosen ||
          workspace.pending ||
          workspace.connection !== 'connected'
        }
      >
        Switch route
      </button>
      <span className="muted small">
        Stops the current writer and rechecks the saved pin and remaining limits.
      </span>
    </form>
  );
}

function StateChip({ state }: { state: string }) {
  const Icon =
    state === 'running' || state === 'checking'
      ? Activity
      : state === 'waiting' || state === 'interrupted'
        ? Clock
        : state === 'accepted' || state === 'ready'
          ? CheckCircle
          : state === 'unknown' || state === 'failed'
            ? AlertTriangle
            : state === 'stopped'
              ? Square
              : Circle;
  return (
    <span className={`state-chip state-${state}`}>
      <Icon size={12} />
      {titleCase(state)}
    </span>
  );
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function readConversationDrafts(): {
  goal: string;
  tasks: Record<string, string>;
  answers: Record<string, string>;
  error: string | null;
} {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('crewkite-task-drafts-v1') ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored))
      throw new Error('Invalid saved drafts.');
    const tasks: Record<string, string> = Object.fromEntries(
      Object.entries(stored).flatMap(([id, text]) =>
        TaskIdSchema.safeParse(id).success && typeof text === 'string' ? [[id, text] as const] : [],
      ),
    );
    const savedAnswers: unknown = JSON.parse(
      localStorage.getItem('crewkite-answer-drafts-v1') ?? '{}',
    );
    if (!savedAnswers || typeof savedAnswers !== 'object' || Array.isArray(savedAnswers))
      throw new Error('Invalid saved answers.');
    const answers: Record<string, string> = Object.fromEntries(
      Object.entries(savedAnswers).flatMap(([id, text]) =>
        MessageIdSchema.safeParse(id).success && typeof text === 'string'
          ? [[id, text] as const]
          : [],
      ),
    );
    return {
      goal: localStorage.getItem('crewkite-goal-draft-v1') ?? '',
      tasks,
      answers,
      error: null,
    };
  } catch {
    return {
      goal: '',
      tasks: {},
      answers: {},
      error: 'Saved drafts could not be read. New drafts will remain in this window.',
    };
  }
}

// Local preferences only. Storage can be full or blocked, and the app keeps working with defaults.
function readPreference(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

type PaletteCommand = {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
  disabled?: boolean;
  // Commands with consequences are never highlighted for you, so Enter after typing cannot run them.
  explicit?: boolean;
};
type TextMatch = { index: number; length: number };
const paletteTaskPageSize = 5;

function findMatch(pattern: RegExp | null, text: string): TextMatch | null {
  const found = pattern?.exec(text);
  return found ? { index: found.index, length: found[0].length } : null;
}
function Highlight({ text, match }: { text: string; match: TextMatch | null }) {
  if (!match) return text;
  return (
    <>
      {text.slice(0, match.index)}
      <mark>{text.slice(match.index, match.index + match.length)}</mark>
      {text.slice(match.index + match.length)}
    </>
  );
}
// Outcomes and criteria can run long. Show the words around the match and keep surrogate pairs whole.
function excerpt(text: string, match: TextMatch, radius = 48) {
  let start = Math.max(0, match.index - radius);
  let end = Math.min(text.length, match.index + match.length + radius);
  if (start > 0 && /[\udc00-\udfff]/.test(text[start] ?? '')) start -= 1;
  if (/[\ud800-\udbff]/.test(text[end - 1] ?? '')) end += 1;
  const lead = start > 0 ? '…' : '';
  return {
    text: `${lead}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    match: { index: match.index - start + lead.length, length: match.length },
  };
}

function CommandPalette({
  commands,
  workspace,
  projects,
  onOpenTask,
  onClose,
}: {
  commands: PaletteCommand[];
  workspace: Workspace;
  projects: { id: string; name: string }[];
  onOpenTask: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<{
    query: string;
    rows: TaskSummary[];
    page: TaskPage | null;
  }>({ query: '', rows: [], page: null });
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchGeneration = useRef(0);
  const searchRead = useRef(false);
  const trimmedQuery = query.trim();
  const epoch = workspace.header?.stamp.epoch;
  const revision = workspace.header?.stamp.revision;
  const searchRef = useRef(search);
  searchRef.current = search;
  const readTaskPage = workspace.readTaskPage;
  const readSearch = useCallback(
    async (more = false, generation = searchGeneration.current) => {
      if (!epoch || revision === undefined || searchRead.current) return;
      const stamp = { epoch, revision };
      searchRead.current = true;
      setSearching(true);
      setSearchError(null);
      try {
        const next = await readTaskPage({
          stamp,
          ...(trimmedQuery ? { query: trimmedQuery } : {}),
          ...(more && searchRef.current.page?.next ? { after: searchRef.current.page.next } : {}),
        });
        if (searchGeneration.current !== generation) return;
        setSearch((current) => ({
          query: trimmedQuery,
          rows: more ? [...current.rows, ...next.tasks] : next.tasks,
          page: next,
        }));
      } catch (failure) {
        if (searchGeneration.current === generation)
          setSearchError(failure instanceof Error ? failure.message : 'Search is unavailable.');
      } finally {
        searchRead.current = false;
        if (searchGeneration.current === generation) setSearching(false);
      }
    },
    [epoch, revision, trimmedQuery, readTaskPage],
  );
  useEffect(() => {
    const generation = ++searchGeneration.current;
    setSearch({ query: trimmedQuery, rows: [], page: null });
    setSearching(true);
    // Coalesce typing. A previous bounded request may finish before the next one starts.
    let timer: ReturnType<typeof setTimeout>;
    const start = () => {
      if (generation !== searchGeneration.current) return;
      if (searchRead.current) {
        timer = setTimeout(start, 50);
        return;
      }
      void readSearch(false, generation);
    };
    timer = setTimeout(start, 150);
    return () => {
      clearTimeout(timer);
      searchGeneration.current += 1;
    };
  }, [trimmedQuery, readSearch]);
  const [page, setPage] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  const id = useId();
  const trimmed = query.trim();
  const pattern = trimmed
    ? new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'iu')
    : null;
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const commandResults = commands.flatMap((command) => {
    const match = findMatch(pattern, command.label);
    return !pattern || match ? [{ command, match }] : [];
  });
  const taskResults = (search.query === trimmed ? search.rows : []).map((task) => {
    const field = task.match;
    const label =
      field &&
      (
        {
          outcome: 'Outcome',
          criterion: 'Criterion',
          'task-id': 'Task ID',
          'project-id': 'Project ID',
        } as Record<string, string>
      )[field.field];
    const match = field ? findMatch(pattern, field.text) : null;
    return {
      task,
      rank: field?.field === 'project' ? 1 : 0,
      field: field && label && match ? { label, ...excerpt(field.text, match) } : null,
    };
  });
  const complete = search.query === trimmed && search.page?.complete === true;
  const pages = Math.max(1, Math.ceil(taskResults.length / paletteTaskPageSize));
  const currentPage = Math.min(page, pages - 1);
  const offset = currentPage * paletteTaskPageSize;
  const shownTasks = taskResults.slice(offset, offset + paletteTaskPageSize);
  const options = [
    ...commandResults.map(({ command }) => ({
      key: `command-${command.id}`,
      disabled: Boolean(command.disabled),
      explicit: Boolean(command.explicit),
      run: () => {
        onClose();
        command.run();
      },
    })),
    ...shownTasks.map(({ task }) => ({
      key: `task-${task.id}`,
      disabled: false,
      explicit: false,
      run: () => onOpenTask(task.id),
    })),
  ];
  const enabled = options.filter((option) => !option.disabled);
  const current =
    enabled.find((option) => option.key === active) ??
    enabled.find((option) => !option.explicit) ??
    null;
  const optionId = (key: string) => `${id}-${key}`;
  const activeId = current ? optionId(current.key) : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);
  // A new page starts on its first task, so Enter never falls back to a command off screen.
  function turnPage(next: number) {
    const target = Math.max(0, Math.min(pages - 1, next));
    if (target === currentPage) return;
    const first = taskResults[target * paletteTaskPageSize];
    setPage(target);
    setActive(first ? `task-${first.task.id}` : null);
  }
  const summary = !pattern
    ? taskResults.length
      ? `Tasks ${offset + 1}-${offset + shownTasks.length} of ${taskResults.length}${complete ? '' : ' loaded'}`
      : complete
        ? 'No tasks yet'
        : 'Searching tasks'
    : options.length
      ? `${taskResults.length} ${taskResults.length === 1 ? 'task' : 'tasks'} and ${commandResults.length} ${commandResults.length === 1 ? 'command' : 'commands'} match${taskResults.length > paletteTaskPageSize ? `. Showing ${offset + 1}-${offset + shownTasks.length}` : ''}`
      : complete
        ? 'No matches'
        : 'Searching tasks';
  function activate(key: string) {
    const option = options.find((value) => value.key === key);
    if (option && !option.disabled) option.run();
  }
  // Focus stays in the search field. Options are reached with the arrow keys or the pointer.
  const optionProps = (key: string, disabled: boolean) => ({
    type: 'button' as const,
    tabIndex: -1,
    id: optionId(key),
    role: 'option',
    'aria-selected': current?.key === key,
    'aria-disabled': disabled || undefined,
    className: `palette-option${current?.key === key ? ' is-active' : ''}`,
    onMouseMove: () => {
      if (!disabled && active !== key) setActive(key);
    },
    onClick: () => activate(key),
  });
  return (
    <div className="palette">
      <div className="palette-search">
        <Search size={16} aria-hidden="true" />
        <input
          ref={(node) => node?.setAttribute('autofocus', '')}
          type="text"
          role="combobox"
          aria-label="Search tasks and commands"
          aria-expanded="true"
          aria-controls={`${id}-results`}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={`${id}-scope`}
          placeholder="Title, outcome, criteria, ID or project"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
            setActive(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!enabled.length) return;
              const index = current ? enabled.indexOf(current) : -1;
              const next =
                event.key === 'ArrowDown'
                  ? (index + 1) % enabled.length
                  : index <= 0
                    ? enabled.length - 1
                    : index - 1;
              setActive(enabled[next].key);
            } else if (event.key === 'PageDown' || event.key === 'PageUp') {
              event.preventDefault();
              turnPage(currentPage + (event.key === 'PageDown' ? 1 : -1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (event.repeat || !current) return;
              // A held Enter keeps repeating after the palette closes and focus returns to the
              // opener, which can be an Approve or Send button. Drop repeats until the key is up.
              const drop = (repeat: KeyboardEvent) => {
                if (repeat.key !== 'Enter' || !repeat.repeat) return;
                repeat.preventDefault();
                repeat.stopImmediatePropagation();
              };
              // Only Enter's own keyup ends the hold. Other keys can come up first while typing.
              const release = (up: KeyboardEvent) => {
                if (up.key !== 'Enter') return;
                window.removeEventListener('keydown', drop, true);
                window.removeEventListener('keyup', release, true);
              };
              window.addEventListener('keydown', drop, true);
              window.addEventListener('keyup', release, true);
              activate(current.key);
            }
          }}
        />
      </div>
      <p className="palette-scope" id={`${id}-scope`}>
        Tasks and commands. Searches task titles, outcomes, criteria, IDs and projects. Conversation
        messages are not searched.
      </p>
      <div
        className="palette-results"
        id={`${id}-results`}
        role="listbox"
        aria-label="Tasks and commands"
        // Keeps the scroller out of the tab order and focus in the field on any click inside.
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
      >
        {commandResults.length > 0 && (
          <fieldset className="palette-group">
            <legend className="palette-group-label">Commands</legend>
            {commandResults.map(({ command, match }) => {
              const key = `command-${command.id}`;
              return (
                <button key={key} {...optionProps(key, Boolean(command.disabled))}>
                  <span className="palette-option-icon" aria-hidden="true">
                    {command.icon}
                  </span>
                  <span className="palette-option-text">
                    <span className="palette-option-title">
                      <Highlight text={command.label} match={match} />
                    </span>
                  </span>
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              );
            })}
          </fieldset>
        )}
        {shownTasks.length > 0 && (
          <fieldset className="palette-group">
            <legend className="palette-group-label">Tasks</legend>
            {shownTasks.map(({ task, rank, field }) => {
              const key = `task-${task.id}`;
              const project =
                projectNames.get(task.projectId) ??
                (task.match?.field === 'project' ? task.match.text : task.projectId);
              return (
                <button key={key} {...optionProps(key, false)}>
                  <span className={`status-dot state-${task.state}`} aria-hidden="true" />
                  <span className="palette-option-text">
                    <span className="palette-option-title">
                      <Highlight
                        text={task.title}
                        match={rank === 0 ? findMatch(pattern, task.title) : null}
                      />
                    </span>
                    <span className="palette-option-meta">
                      <Highlight
                        text={project}
                        match={rank === 1 ? findMatch(pattern, project) : null}
                      />
                      {` · ${titleCase(task.state)} · ${task.id.slice(-6)}`}
                    </span>
                    {field && (
                      <span className="palette-option-match">
                        {field.label}: <Highlight text={field.text} match={field.match} />
                      </span>
                    )}
                  </span>
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              );
            })}
          </fieldset>
        )}
      </div>
      {!options.length && complete && (
        <div className="palette-empty">
          <strong>No tasks or commands match “{trimmed}”.</strong>
          <span>Check the spelling, or search by task ID or project name.</span>
        </div>
      )}
      <div className="palette-footer">
        <p role="status">
          {summary}
          {!complete ? ' · Search incomplete' : ''}
        </p>
        {searchError && (
          <p role="alert">
            {searchError}{' '}
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                void workspace
                  .refresh()
                  .then(() => readSearch())
                  .catch(() => {})
              }
            >
              Refresh search
            </button>
          </p>
        )}
        {!complete && (
          <button
            type="button"
            className="button secondary"
            disabled={searching}
            onClick={() => void readSearch(Boolean(search.page?.next))}
          >
            {searching ? 'Searching' : 'Continue search'}
          </button>
        )}
        {taskResults.length > paletteTaskPageSize && (
          <div className="palette-pages">
            <button
              type="button"
              className="icon-button"
              aria-label="Previous tasks"
              disabled={currentPage === 0}
              onClick={() => turnPage(currentPage - 1)}
            >
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <span aria-hidden="true">
              {currentPage + 1}/{pages}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Next tasks"
              disabled={currentPage >= pages - 1}
              onClick={() => turnPage(currentPage + 1)}
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function App() {
  const workspace = useWorkspace();
  const {
    snapshot,
    header,
    projects,
    taskPages,
    connection,
    preview,
    error: workspaceError,
  } = workspace;
  const metadata = header ? { ...header, projects } : null;
  const connectionLabel = preview
    ? 'Preview data'
    : connection === 'connected'
      ? 'Controller connected'
      : connection === 'offline'
        ? 'Controller offline'
        : titleCase(connection);
  const [page, setPage] = useState<'tasks' | 'usage'>('tasks');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    void workspace.selectTask(selected);
  }, [selected, workspace.selectTask]);
  useEffect(() => {
    const first = projects[0];
    if (first && !taskPages[first.id]) void workspace.loadTasks(first.id);
  }, [projects, taskPages, workspace.loadTasks]);
  useEffect(() => {
    if (selected) return;
    const first = Object.values(taskPages).flatMap((page) => page.tasks)[0];
    if (first) setSelected(first.id);
  }, [selected, taskPages]);
  const [tab, setTab] = useState<Tab>('Conversation');
  const [roster, setRoster] = useState(true);
  const [theme, setTheme] = useState(() => readPreference('crewkite-theme') ?? 'dark');
  const [collapsed, setCollapsed] = useState(
    () => readPreference('crewkite-sidebar-collapsed-v1') === '1',
  );
  const [create, setCreate] = useState(false);
  const [newGoal, setNewGoal] = useState(() => Boolean(pendingGoalProject()));
  const [savedDrafts] = useState(readConversationDrafts);
  const [goalDraft, setGoalDraft] = useState(savedDrafts.goal);
  const composerRetry = useRef<(() => Promise<void>) | null>(null);
  const registerComposerRetry = useCallback<RegisterComposerRetry>((retry) => {
    composerRetry.current = retry;
    return () => {
      if (composerRetry.current === retry) composerRetry.current = null;
    };
  }, []);
  const [drafts, setDrafts] = useState(savedDrafts.tasks);
  const [answerDrafts, setAnswerDrafts] = useState(savedDrafts.answers);
  const [draftError, setDraftError] = useState(savedDrafts.error);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const error = workspaceError ?? draftError ?? preparationError;
  useEffect(() => {
    if (savedDrafts.error) return;
    try {
      localStorage.setItem('crewkite-task-drafts-v1', JSON.stringify(drafts));
      localStorage.setItem('crewkite-goal-draft-v1', goalDraft);
      localStorage.setItem('crewkite-answer-drafts-v1', JSON.stringify(answerDrafts));
    } catch {
      setDraftError('The unsent draft could not be saved locally. Keep this window open.');
    }
  }, [drafts, goalDraft, answerDrafts, savedDrafts.error]);
  const [conversationState, setConversationState] = useState<TaskConversationState | null>(null);
  const [launch, setLaunch] = useState(false);
  const [executionPolicySeed, setExecutionPolicySeed] = useState<ExecutionPolicySeed | null>(null);
  const [nativeHandoff, setNativeHandoff] = useState(false);
  const [palette, setPalette] = useState(false);
  const paletteOpener = useRef<HTMLElement | null>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const [approvalToReview, setApprovalToReview] = useState<string | null>(null);
  const approvalCard = useRef<HTMLElement>(null);
  const [about, setAbout] = useState(false);
  const task = newGoal ? undefined : snapshot?.tasks.find(({ id }) => id === selected);
  const currentConversation =
    task && conversationState?.taskId === task.id && conversationState.revision === task.revision
      ? conversationState
      : null;
  const combined = snapshot?.combinedRuns.find(
    (value) =>
      value.taskId === task?.id || value.members.some((member) => member.taskId === task?.id),
  );
  const stopRunId = combined ? task?.runId : (currentConversation?.currentRunId ?? task?.runId);
  const run = snapshot?.runs.find(({ id }) => id === task?.runId);
  const candidate = snapshot?.candidates.filter((value) => value.taskId === task?.id).at(-1);
  const changesKey = [
    task?.id,
    task?.runId,
    run?.source.base,
    candidate?.id,
    candidate?.hash,
    candidate?.artifactId,
  ].join(':');
  const nativeRun = snapshot?.nativeRuns.find((value) => value.runId === task?.runId);
  const quotaRetry = nativeRun?.quotaRetry;
  const [quotaClock, setQuotaClock] = useState(Date.now);
  useEffect(() => {
    if (quotaRetry?.mode !== 'manual' || quotaRetry.available) return;
    setQuotaClock(Date.now());
    const timer = window.setInterval(() => setQuotaClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [quotaRetry]);
  const quotaRetryReady =
    !!quotaRetry && (quotaRetry.available || Date.parse(quotaRetry.resetsAt) <= quotaClock);
  useEffect(() => {
    if (!executionPolicySeed || workspace.pending || workspace.retryAvailable) return;
    if (task?.id === executionPolicySeed.taskId && nativeRun?.stage === 'prepared') {
      setExecutionPolicySeed(null);
      return;
    }
    if (
      task?.id !== executionPolicySeed.taskId ||
      task.revision !== executionPolicySeed.taskRevision ||
      (currentConversation &&
        currentConversation.configuration?.revision !==
          executionPolicySeed.planningConfigurationRevision)
    ) {
      setExecutionPolicySeed(null);
      setLaunch(false);
      setPreparationError(
        'The task or planning configuration changed. The execution draft was discarded. Review the current task before preparing again.',
      );
    }
  }, [
    executionPolicySeed,
    workspace.pending,
    workspace.retryAvailable,
    task?.id,
    task?.revision,
    currentConversation,
    nativeRun?.stage,
  ]);
  function openPreparation(seed?: ExecutionPolicySeed) {
    if (executionPolicySeed && (workspace.pending || workspace.retryAvailable)) {
      if (!seed && task?.id === executionPolicySeed.taskId) {
        setLaunch(true);
        return;
      }
      setPreparationError('Resolve the current preparation request before changing its policy.');
      return;
    }
    if (combined) {
      setTab('Combined task');
      if (seed) setPreparationError('Choose execution authority in Combined task preparation.');
      return;
    }
    if (
      seed &&
      (workspace.pending ||
        workspace.retryAvailable ||
        workspace.connection !== 'connected' ||
        task?.id !== seed.taskId ||
        task.revision !== seed.taskRevision ||
        currentConversation?.configuration?.revision !== seed.planningConfigurationRevision ||
        currentConversation.contractStatus !== 'confirmed' ||
        !adoptedPlanCurrent(currentConversation) ||
        currentConversation.activeAttempt ||
        ['unknown', 'stopping'].includes(currentConversation.phase) ||
        task.state !== 'draft' ||
        nativeRun?.stage === 'prepared')
    ) {
      setPreparationError(
        'The execution draft is unavailable at this task revision. Resolve current work and review preparation again.',
      );
      return;
    }
    setPreparationError(null);
    setExecutionPolicySeed(seed ?? null);
    setLaunch(true);
  }
  const approval = snapshot?.approvals.find(
    (value) => value.taskId === task?.id && value.status === 'pending',
  );
  const taskEvents = workspace.events.filter((event) => event.taskId === task?.id);
  // Runs before the dialog opens and after it is removed, so focus goes back where it came from.
  // The approval effect below runs later and wins when the palette opened an approval.
  useLayoutEffect(() => {
    if (palette) {
      paletteOpener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    const opener = paletteOpener.current;
    paletteOpener.current = null;
    if (!opener) return;
    opener.focus();
    if (document.activeElement !== opener) searchButton.current?.focus();
  }, [palette]);
  useEffect(() => {
    if (palette || !approvalToReview) return;
    if (page === 'tasks' && tab === 'Activity' && approval?.approvalId === approvalToReview)
      approvalCard.current?.focus();
    setApprovalToReview(null);
  }, [palette, page, tab, approval?.approvalId, approvalToReview]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePreference('crewkite-theme', theme);
  }, [theme]);
  useEffect(() => {
    writePreference('crewkite-sidebar-collapsed-v1', collapsed ? '1' : '0');
  }, [collapsed]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        // Palette commands change the selected task. Keep them out of other open dialogs.
        const other = [...document.querySelectorAll('dialog[open]')].some(
          (dialog) => !dialog.querySelector('.palette'),
        );
        if (!other) setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  function stop() {
    if (task && stopRunId)
      void workspace
        .command({
          command: 'StopRun',
          expectedRevision: task.revision,
          payload: { taskId: task.id, runId: stopRunId },
        })
        .catch(() => {});
  }
  const stoppingPendingStart =
    !!workspace.pendingStart &&
    workspace.pendingStart.taskId === task?.id &&
    workspace.pendingStart.runId === stopRunId;
  const stopAllowed =
    stoppingPendingStart ||
    (!!combined &&
      combined.taskId === task?.id &&
      combined.runId === stopRunId &&
      !['accepted', 'stopped'].includes(combined.phase)) ||
    (combined?.members.some((member) => member.taskId === task?.id && member.runId === stopRunId) &&
      !!task &&
      ['running', 'checking', 'unknown'].includes(task.state)) ||
    (!combined &&
      currentConversation &&
      (currentConversation.purpose === 'conversation'
        ? Boolean(
            stopRunId && ['planning', 'stopping', 'unknown'].includes(currentConversation.phase),
          )
        : task?.runId &&
          (nativeRun
            ? nativeRun.stage === 'prepared' ||
              !!nativeRun.handoff?.pending ||
              ['running', 'checking', 'unknown', 'interrupted'].includes(task.state)
            : !['draft', 'ready', 'accepted', 'failed'].includes(task.state))));
  return (
    <div className="app-shell">
      <aside
        id="workspace-navigation"
        className={collapsed ? 'navigation is-collapsed' : 'navigation'}
        aria-label="Workspace navigation"
      >
        <div className="nav-head">
          <button
            type="button"
            className="brand"
            onClick={() => setAbout(true)}
            aria-label="About CrewKite"
            data-tooltip="About CrewKite"
          >
            <img
              className="brand-wordmark"
              src={theme === 'light' ? wordmark : inverseWordmark}
              alt="CrewKite"
              width={1024}
              height={341}
            />
            {preview && <span className="prototype-tag">D0</span>}
          </button>
          <button
            type="button"
            className="icon-button nav-toggle"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            aria-controls="workspace-navigation"
            data-tooltip="Expand sidebar"
          >
            {collapsed ? (
              <PanelLeftOpen size={16} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={16} aria-hidden="true" />
            )}
          </button>
        </div>
        <button
          ref={searchButton}
          type="button"
          className="search-button"
          onClick={() => setPalette(true)}
          aria-label="Search tasks and commands"
          aria-keyshortcuts="Meta+K Control+K"
          data-tooltip="Search"
        >
          <Search size={14} aria-hidden="true" />
          <span className="nav-text">Search</span>
          <kbd>⌘ K</kbd>
        </button>
        {collapsed && (
          <button
            type="button"
            className="nav-item"
            onClick={() => {
              setNewGoal(true);
              setPage('tasks');
            }}
            disabled={!header}
            data-tooltip="New task"
          >
            <Plus size={16} aria-hidden="true" />
            <span className="nav-text">New task</span>
          </button>
        )}
        {/* The list stays mounted while the rail shows, so it keeps its scroll position. */}
        <div className="nav-scroll" hidden={collapsed}>
          <div className="nav-label">
            WORKSPACE
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setNewGoal(true);
                setPage('tasks');
              }}
              aria-label="New task"
            >
              <Plus size={15} />
            </button>
          </div>
          {projects.map((project) => (
            <div key={project.id} className="project-group">
              <div className="project-name">
                <ChevronRight size={12} className="expanded" />
                <Folder size={15} />
                <span>{project.name}</span>
                <span className="count">{project.taskCount}</span>
              </div>
              {(taskPages[project.id]?.tasks ?? []).map((value) => (
                <button
                  type="button"
                  key={value.id}
                  className={`task-link ${page === 'tasks' && task?.id === value.id ? 'active' : ''}`}
                  aria-current={page === 'tasks' && task?.id === value.id ? 'page' : undefined}
                  onClick={() => {
                    setNewGoal(false);
                    setSelected(value.id);
                    setTab('Conversation');
                    setPage('tasks');
                  }}
                >
                  <span className={`status-dot state-${value.state}`} />
                  <span>{value.title}</span>
                  {value.state === 'waiting' && <span className="notification-dot" />}
                </button>
              ))}
              {project.taskCount === 0 && <p className="nav-empty">No tasks yet</p>}
              {project.taskCount > 0 && !taskPages[project.id] && (
                <button
                  type="button"
                  className="task-link"
                  disabled={workspace.navigationBusy}
                  onClick={() => void workspace.loadTasks(project.id)}
                >
                  Show tasks
                </button>
              )}
              {taskPages[project.id] && !taskPages[project.id].complete && (
                <button
                  type="button"
                  className="task-link"
                  disabled={workspace.navigationBusy}
                  onClick={() => void workspace.loadTasks(project.id, true)}
                >
                  Load more tasks
                </button>
              )}
            </div>
          ))}
          {workspace.navigationStale && (
            <p className="nav-empty" role="status">
              Navigation changed. Refresh to continue.{' '}
              <button type="button" onClick={() => void workspace.refresh().catch(() => {})}>
                Refresh navigation
              </button>
            </p>
          )}
          {workspace.projectPage && !workspace.projectPage.complete && (
            <button
              type="button"
              className="task-link"
              disabled={workspace.navigationBusy}
              onClick={() => void workspace.loadProjects()}
            >
              Load more projects
            </button>
          )}
          {workspace.canPickProject && (
            <button
              type="button"
              className="add-task"
              disabled={workspace.pending || connection !== 'connected'}
              onClick={() => void workspace.pickProject().catch(() => {})}
            >
              <Folder size={14} />
              Add project
            </button>
          )}
          <button
            type="button"
            className="add-task"
            onClick={() => {
              setNewGoal(true);
              setPage('tasks');
            }}
            disabled={!header}
          >
            <Plus size={14} />
            New task
          </button>
          <button type="button" className="add-task" onClick={() => setPage('usage')}>
            <Gauge size={14} />
            Connect providers
          </button>
        </div>
        <div className="nav-bottom">
          <button
            type="button"
            className={`nav-item ${page === 'usage' ? 'active' : ''}`}
            aria-current={page === 'usage' ? 'page' : undefined}
            onClick={() => setPage('usage')}
            data-tooltip="Usage and capacity"
          >
            <Gauge size={16} aria-hidden="true" />
            <span className="nav-text">Usage and capacity</span>
            <ChevronRight size={13} aria-hidden="true" />
          </button>
          {!collapsed && (
            <button type="button" className="nav-item" onClick={() => setAbout(true)}>
              <Info size={16} />
              About and acknowledgments
            </button>
          )}
          <div className="connection-line">
            <span className="connection-status" data-tooltip={connectionLabel}>
              <span className={`connection-dot ${connection}`} />
              <span className="nav-text">{connectionLabel}</span>
            </span>
            {!preview && connection !== 'connected' && (
              <button
                type="button"
                className="icon-button"
                onClick={() => void workspace.reconnect()}
                disabled={workspace.pending || connection === 'connecting'}
                aria-label="Reconnect controller"
                data-tooltip="Reconnect controller"
              >
                <RefreshCw size={15} />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              data-tooltip={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <div className="breadcrumbs">
            <Folder size={14} />
            <span>{projects.find(({ id }) => id === task?.projectId)?.name ?? 'Workspace'}</span>
            <ChevronRight size={12} />
            <span>{page === 'usage' ? 'Usage and capacity' : 'Tasks'}</span>
          </div>
          <div className="topbar-actions">
            <span className="demo-label">
              <span />
              {preview
                ? 'Interface preview'
                : !header
                  ? 'Route state unavailable'
                  : header.routes.length === 0
                    ? 'No routes configured'
                    : header.routes.every(({ fake }) => fake)
                      ? 'Scripted providers'
                      : 'Routes from controller'}
            </span>
            <button
              type="button"
              className="icon-button"
              onClick={() => setRoster(!roster)}
              aria-label="Toggle team roster"
              aria-pressed={roster}
            >
              <PanelRight size={17} />
            </button>
          </div>
        </header>
        {preview && (
          <div className="preview-banner">
            <Info size={14} />
            <span>Interface preview. No worker, checks or provider calls run here.</span>
          </div>
        )}
        {workspace.retryAvailable && (
          <div className="recovery-banner" role="status">
            <AlertTriangle size={15} />
            <span>
              An action has an uncertain outcome. Retry its saved command before another change.
            </span>
            <button
              type="button"
              className="button secondary"
              disabled={workspace.pending || connection !== 'connected'}
              onClick={() => {
                const retry = composerRetry.current;
                void (retry ? retry() : workspace.retryCommand()).catch(() => {});
              }}
            >
              Retry exact command
            </button>
          </div>
        )}
        {workspace.historyGap && (
          <div className="recovery-banner" role="status">
            <Info size={15} />
            <span>Some activity history is unavailable. This timeline is incomplete.</span>
          </div>
        )}
        {workspace.exportNotice && (
          <div className="recovery-banner" role="status">
            <Download size={15} />
            <span>
              {workspace.exportNotice.outcome === 'saved'
                ? 'Patch saved.'
                : workspace.exportNotice.outcome === 'cancelled'
                  ? 'Export available. Save cancelled.'
                  : 'Export available. The file could not be saved.'}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss export notice"
              onClick={workspace.dismissExportNotice}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={16} />
            <span>{error}</span>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                workspace.setError(null);
                setDraftError(null);
                setPreparationError(null);
              }}
              aria-label="Dismiss error"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {workspace.detailStale && (
          <p className="recovery-banner" role="status">
            Reconnecting task detail. Displayed task state is stale; controls resume after refresh.
          </p>
        )}
        {!header ? (
          <div className="loading-workspace">
            <Empty
              icon={connection === 'offline' ? <AlertTriangle /> : <RefreshCw className="spin" />}
              title={connection === 'offline' ? 'Controller unavailable' : 'Opening the workspace'}
            >
              Task state appears after the desktop connects to its controller.
            </Empty>
            <button
              type="button"
              className="button secondary"
              onClick={() => void workspace.reconnect()}
            >
              <RefreshCw size={14} />
              Retry connection
            </button>
          </div>
        ) : page === 'usage' ? (
          <Usage
            snapshot={header}
            attempts={snapshot?.attempts ?? []}
            run={run}
            workspace={workspace}
          />
        ) : selected && !newGoal && !snapshot ? (
          <div className="loading-workspace" role="status">
            <p>Opening selected task detail.</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => void workspace.selectTask(selected)}
            >
              Retry task detail
            </button>
          </div>
        ) : (
          <div className={`task-layout ${roster ? '' : 'roster-hidden'}`}>
            <main className="task-main">
              {task && snapshot ? (
                <>
                  <section className="task-heading">
                    <div className="task-meta">
                      <span className="eyebrow">TASK {task.id.slice(-4)}</span>
                      <StateChip state={task.state} />
                      <span className="revision">Revision {task.revision}</span>
                    </div>
                    <section className="task-summary" aria-label="Task summary">
                      <h1>{task.title}</h1>
                      <p className="task-outcome">{task.outcome}</p>
                    </section>
                    <div className="task-actions">
                      <div className="next-action">
                        <span className={`status-dot state-${task.state}`} />
                        <span>
                          {approval ? 'Needs you' : 'Next step'}
                          <strong>
                            <TaskNext text={task.next ?? 'Inspect the retained task state.'} />
                          </strong>
                        </span>
                      </div>
                      <div className="button-row">
                        {task.state === 'draft' &&
                          !combined &&
                          currentConversation?.contractStatus === 'confirmed' &&
                          adoptedPlanCurrent(currentConversation) &&
                          !currentConversation.activeAttempt &&
                          !['unknown', 'stopping'].includes(currentConversation.phase) && (
                            <button
                              type="button"
                              className="button primary"
                              onClick={() => openPreparation()}
                              disabled={workspace.pending}
                            >
                              {nativeRun?.stage === 'prepared'
                                ? 'Review prepared proposal'
                                : 'Prepare run'}
                              <ArrowRight size={14} />
                            </button>
                          )}
                        {task.runId &&
                          !combined &&
                          (!nativeRun || nativeRun.quotaRetry?.mode === 'manual') &&
                          currentConversation &&
                          currentConversation.purpose !== 'conversation' &&
                          ['interrupted', 'stopped'].includes(task.state) && (
                            <button
                              type="button"
                              className="button primary"
                              disabled={
                                workspace.pending ||
                                (nativeRun?.quotaRetry?.mode === 'manual' && !quotaRetryReady)
                              }
                              title={
                                nativeRun?.quotaRetry?.mode === 'manual' && !quotaRetryReady
                                  ? `Resume after ${new Date(nativeRun.quotaRetry.resetsAt).toLocaleString()}`
                                  : undefined
                              }
                              onClick={() =>
                                void workspace
                                  .command({
                                    command: 'ResumeRun',
                                    expectedRevision: task.revision,
                                    payload: { taskId: task.id, runId: task.runId as string },
                                  })
                                  .catch(() => {})
                              }
                            >
                              Resume
                              <ArrowRight size={14} />
                            </button>
                          )}
                        {combined?.taskId === task.id &&
                          combined.runId === task.runId &&
                          combined.phase === 'paused' && (
                            <button
                              type="button"
                              className="button secondary"
                              title="Current work must stop before admissions can resume."
                              disabled={
                                workspace.pending ||
                                workspace.retryAvailable ||
                                connection !== 'connected'
                              }
                              onClick={() =>
                                void workspace
                                  .command({
                                    command: 'ResumeRun',
                                    expectedRevision: task.revision,
                                    payload: { taskId: task.id, runId: combined.runId },
                                  })
                                  .catch(() => {})
                              }
                            >
                              Resume admissions
                              <ArrowRight size={14} />
                            </button>
                          )}
                        {!combined && nativeRun?.handoff && nativeRun.stage !== 'prepared' && (
                          <button
                            type="button"
                            className="button secondary"
                            disabled={workspace.pending}
                            onClick={() => setNativeHandoff(true)}
                          >
                            {nativeRun.handoff.pending
                              ? 'Review prepared transfer'
                              : 'Continue with another writer'}
                            <ArrowRight size={14} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="button stop"
                          disabled={
                            !stopAllowed ||
                            (workspace.pending && !stoppingPendingStart) ||
                            workspace.pendingStop ||
                            task.state === 'stopping'
                          }
                          onClick={stop}
                        >
                          <Square size={12} />
                          {task.state === 'unknown' ? 'Retry stop' : 'Stop'}
                        </button>
                      </div>
                    </div>
                    {run &&
                      !combined &&
                      currentConversation?.purpose === 'execution' &&
                      ['running', 'waiting', 'stopped', 'interrupted'].includes(task.state) && (
                        <RouteSwitch
                          key={run.id}
                          task={task}
                          run={run}
                          snapshot={snapshot}
                          workspace={workspace}
                        />
                      )}
                  </section>
                  <div
                    className="tab-bar"
                    role="tablist"
                    aria-label="Task views"
                    style={{ overflowX: 'auto', flexShrink: 0 }}
                    onKeyDown={moveTabFocus}
                  >
                    {tabs.map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="tab"
                        id={`tab-${value}`}
                        aria-selected={tab === value}
                        tabIndex={tab === value ? 0 : -1}
                        aria-controls="task-panel"
                        className={tab === value ? 'active' : ''}
                        onClick={() => setTab(value)}
                      >
                        {value}
                        {value === 'Handoffs' &&
                          taskEvents.some(({ type }) => type === 'handoff.sealed') && (
                            <span className="tab-count">
                              {taskEvents.filter(({ type }) => type === 'handoff.sealed').length}
                            </span>
                          )}
                      </button>
                    ))}
                  </div>
                  <div
                    id="task-panel"
                    role="tabpanel"
                    aria-labelledby={`tab-${tab}`}
                    className="task-panel"
                    style={
                      tab === 'Conversation'
                        ? { padding: 0, overflow: 'hidden' }
                        : tab === 'Combined task'
                          ? { padding: 16, overflow: 'hidden' }
                          : undefined
                    }
                  >
                    <div
                      hidden={tab !== 'Conversation'}
                      style={tab === 'Conversation' ? { height: '100%' } : { display: 'none' }}
                    >
                      <ConversationView
                        visible={tab === 'Conversation'}
                        key={task.id}
                        task={task}
                        snapshot={snapshot}
                        workspace={workspace}
                        registerRetry={registerComposerRetry}
                        answerDrafts={answerDrafts}
                        onAnswerDraftChange={(id, text) =>
                          setAnswerDrafts((current) => ({ ...current, [id]: text }))
                        }
                        draft={drafts[task.id] ?? ''}
                        onDraftChange={(text) =>
                          setDrafts((current) => ({ ...current, [task.id]: text }))
                        }
                        onDraftSaved={(submitted) =>
                          setDrafts((current) =>
                            current[task.id] === submitted
                              ? { ...current, [task.id]: '' }
                              : current,
                          )
                        }
                        onState={setConversationState}
                        onPrepare={openPreparation}
                      />
                    </div>
                    <div
                      hidden={tab !== 'Combined task'}
                      style={tab === 'Combined task' ? { height: '100%' } : { display: 'none' }}
                    >
                      <CombinedTaskPanel
                        key={task.id}
                        task={task}
                        snapshot={snapshot}
                        workspace={workspace}
                        onInspect={(panel) =>
                          setTab(
                            panel === 'changes'
                              ? 'Changes'
                              : panel === 'evaluation'
                                ? 'Checks and review'
                                : 'Activity',
                          )
                        }
                        onSelectTask={(id) => {
                          setSelected(id);
                          setTab('Combined task');
                        }}
                      />
                    </div>
                    {tab === 'Activity' && (
                      <>
                        {approval && (
                          <ApprovalCard
                            approval={approval}
                            task={task}
                            workspace={workspace}
                            projectName={
                              snapshot.projects.find(({ id }) => id === task.projectId)?.name
                            }
                            focusRef={approvalCard}
                          />
                        )}
                        <ActivityView
                          key={`${task.id}:${header.stamp.epoch}`}
                          task={task}
                          snapshot={snapshot}
                          workspace={workspace}
                        />
                      </>
                    )}
                    {tab === 'Plan' && (
                      <Plan
                        task={task}
                        run={run}
                        snapshot={snapshot}
                        onPrepare={() => openPreparation()}
                        conversationState={currentConversation}
                      />
                    )}
                    {tab === 'Changes' && (
                      <Changes key={changesKey} task={task} workspace={workspace} />
                    )}
                    {tab === 'Checks and review' && (
                      <Checks task={task} snapshot={snapshot} workspace={workspace} />
                    )}
                    {tab === 'Handoffs' && <Handoffs events={taskEvents} snapshot={snapshot} />}
                  </div>
                </>
              ) : (
                <NewGoal
                  snapshot={{ ...header, projects }}
                  workspace={workspace}
                  registerRetry={registerComposerRetry}
                  text={goalDraft}
                  onTextChange={setGoalDraft}
                  onManual={() => setCreate(true)}
                  onCreated={(id, submitted) => {
                    setPage('tasks');
                    setSelected(id);
                    setNewGoal(false);
                    setTab('Conversation');
                    setGoalDraft((value) => (value === submitted ? '' : value));
                  }}
                />
              )}
            </main>
            {roster && snapshot && (
              <Roster
                snapshot={snapshot}
                run={run}
                task={task}
                onConfigure={() => openPreparation()}
              />
            )}
          </div>
        )}
        <footer className="statusbar">
          <span>
            <ShieldCheck size={12} />
            Local workspace<span className="footer-separator">/</span>
            {!header
              ? 'Route state unavailable'
              : header.routes.length === 0
                ? 'No routes configured'
                : header.routes.every(({ fake }) => fake)
                  ? 'All routes are fake'
                  : 'Route state from controller'}
          </span>
          <span>
            Authority stays in the controller<kbd>⌘ K</kbd>
          </span>
        </footer>
      </div>
      {create && metadata && (
        <CreateTask
          workspace={workspace}
          snapshot={metadata}
          onClose={() => setCreate(false)}
          onCreated={(id) => {
            setSelected(id);
            setNewGoal(false);
            setPage('tasks');
            setCreate(false);
            setLaunch(true);
          }}
        />
      )}
      {launch && !combined && task && snapshot && (
        <Launch
          key={
            executionPolicySeed
              ? `${executionPolicySeed.taskId}:${executionPolicySeed.taskRevision}:${executionPolicySeed.planningConfigurationRevision}:${executionPolicySeed.authority}`
              : task.id
          }
          task={task}
          snapshot={snapshot}
          workspace={workspace}
          executionPolicySeed={executionPolicySeed ?? undefined}
          onClose={() => {
            setLaunch(false);
            if (!workspace.pending && !workspace.retryAvailable) setExecutionPolicySeed(null);
          }}
        />
      )}
      {nativeHandoff && !combined && task && snapshot && nativeRun?.handoff && (
        <NativeHandoff
          key={`${task.runId}:${task.revision}:${nativeRun.handoff.currentAttemptId}:${nativeRun.handoff.pending?.preparationId ?? ''}`}
          task={task}
          snapshot={snapshot}
          workspace={workspace}
          onClose={() => setNativeHandoff(false)}
        />
      )}
      {about && <About preview={preview} onClose={() => setAbout(false)} />}
      {palette && (
        <Dialog title="Search tasks and commands" onClose={() => setPalette(false)}>
          <CommandPalette
            commands={[
              {
                id: 'new-task',
                label: 'New task',
                icon: <Plus size={17} />,
                run: () => {
                  setNewGoal(true);
                  setPage('tasks');
                },
              },
              {
                id: 'usage',
                label: 'Open usage and capacity',
                icon: <Gauge size={17} />,
                run: () => setPage('usage'),
              },
              {
                id: 'activity',
                label: 'Show task activity',
                icon: <Activity size={17} />,
                run: () => {
                  setPage('tasks');
                  setTab('Activity');
                },
              },
              {
                id: 'approval',
                label: 'Review pending approval',
                icon: <ShieldCheck size={17} />,
                disabled: !approval,
                run: () => {
                  if (!approval) return;
                  setPage('tasks');
                  setTab('Activity');
                  setApprovalToReview(approval.approvalId);
                },
              },
              {
                id: 'stop',
                label: 'Stop current run',
                icon: <Square size={15} />,
                run: stop,
                disabled: !stopAllowed,
                explicit: true,
              },
              {
                id: 'about',
                label: 'About and acknowledgments',
                icon: <Info size={17} />,
                run: () => setAbout(true),
              },
            ]}
            workspace={workspace}
            projects={projects}
            onOpenTask={(id) => {
              setPalette(false);
              setNewGoal(false);
              setSelected(id);
              setPage('tasks');
              setTab('Conversation');
            }}
            onClose={() => setPalette(false)}
          />
        </Dialog>
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  task,
  workspace,
  projectName,
  focusRef,
}: {
  approval: Approval;
  task: Task;
  workspace: Workspace;
  projectName?: string;
  focusRef?: RefObject<HTMLElement | null>;
}) {
  function resolve(decision: 'approved' | 'denied') {
    const binding = {
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      attemptId: approval.attemptId,
      generation: approval.generation,
      action: approval.action,
      target: approval.target,
      revision: approval.revision,
      ...(approval.acpTarget ? { acpTarget: approval.acpTarget } : {}),
    };
    void workspace
      .command({
        command: 'ResolveApproval',
        expectedRevision: task.revision,
        payload: { binding, decision },
      })
      .catch(() => {});
  }
  return (
    <section className="approval-card" aria-label="Pending approval" ref={focusRef} tabIndex={-1}>
      <div className="approval-title">
        <span className="approval-symbol">
          <ShieldCheck size={18} />
        </span>
        <div>
          <span className="eyebrow">NEEDS YOUR APPROVAL</span>
          <h3>{actionName(approval.action)}</h3>
        </div>
        <span className="pending-label">Waiting</span>
      </div>
      <p>
        {approval.consequence === `Permit one ${approval.action} action for this attempt.`
          ? 'Allow this named action once for this attempt.'
          : approval.consequence}
      </p>
      {approval.acpTarget && (
        <p className="muted small">
          Allow once for session {approval.acpTarget.sessionId}, tool call{' '}
          {approval.acpTarget.toolCallId}, option {approval.acpTarget.optionId}.
        </p>
      )}
      <div className="approval-target">
        <Terminal size={14} />
        <span>{effectTarget(approval, task, projectName)}</span>
      </div>
      <details className="technical-details approval-binding">
        <summary>Details</summary>
        <code>Action {approval.action}</code>
        <code>Target {approval.target}</code>
        <code>Task {approval.taskId}</code>
        <code>Attempt {approval.attemptId}</code>
        <code>Approval {approval.approvalId}</code>
        <p>{approval.consequence}</p>
      </details>
      <div className="approval-footer">
        <span>
          {titleCase(approval.requester)} · generation {approval.generation}
          <small>Attempt {short(approval.attemptId)}</small>
        </span>
        <div className="button-row">
          <button
            type="button"
            className="button secondary"
            disabled={workspace.pending}
            onClick={() => resolve('denied')}
          >
            <X size={14} />
            Deny
          </button>
          <button
            type="button"
            className="button primary"
            disabled={workspace.pending}
            onClick={() => resolve('approved')}
          >
            <Check size={15} />
            Approve once
          </button>
        </div>
      </div>
    </section>
  );
}

function CombinedTaskPanel({
  task,
  snapshot,
  workspace,
  onInspect,
  onSelectTask,
}: {
  task: Task;
  snapshot: Snapshot;
  workspace: Workspace;
  onInspect: (panel: 'changes' | 'evaluation' | 'activity') => void;
  onSelectTask: (id: Task['id']) => void;
}) {
  const [source, setSource] = useState<Run['source'] | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const request = useRef(0);
  const command = workspace.command;
  const inspect = useCallback(async () => {
    const current = ++request.current;
    setSource(null);
    setSourceError(null);
    try {
      const result = await command({
        command: 'InspectSource',
        payload: { projectId: task.projectId },
      });
      if (current !== request.current) return;
      if (
        (result.outcome === 'applied' || result.outcome === 'already-applied') &&
        result.data?.kind === 'source' &&
        result.data.source.projectId === task.projectId
      )
        setSource(result.data.source);
      else setSourceError(result.next ?? result.reason ?? 'Source inspection is unavailable.');
    } catch (failure) {
      if (current === request.current)
        setSourceError(failure instanceof Error ? failure.message : 'Source inspection failed.');
    }
  }, [command, task.projectId]);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const connected = workspace.connection === 'connected' && !workspace.preview;
  return (
    <CombinedTask
      task={task}
      snapshot={snapshot}
      source={source}
      connected={connected}
      pending={workspace.pending}
      retryAvailable={workspace.retryAvailable}
      error={sourceError ?? workspace.error}
      onCommand={workspace.command}
      onRetry={workspace.retryCommand}
      onRefreshSource={inspect}
      onInspect={onInspect}
      onSelectTask={onSelectTask}
    />
  );
}

function Plan({
  task,
  run,
  snapshot,
  onPrepare,
  conversationState,
}: {
  task: Task;
  run?: Run;
  snapshot: Snapshot;
  onPrepare: () => void;
  conversationState: TaskConversationState | null;
}) {
  const combined = snapshot.combinedRuns.find(
    (value) =>
      value.taskId === task.id || value.members.some((member) => member.taskId === task.id),
  );
  if (combined)
    return (
      <Empty icon={<GitBranch />} title="Combined task contract">
        {combined.taskId === task.id
          ? 'This parent retains the shared limits and combined candidate. Inspect Combined task for its current actions.'
          : 'This member contributes retained work to its parent. Inspect Combined task for its scoped actions.'}
      </Empty>
    );
  if (!conversationState)
    return (
      <Empty icon={<RefreshCw />} title="Refreshing the task contract">
        Open Conversation to refresh if the current state remains unavailable.
      </Empty>
    );
  if (conversationState.purpose === 'conversation')
    return (
      <div className="view-stack">
        <section className="card">
          <h2>
            {conversationState.contractStatus === 'provisional'
              ? 'Provisional task contract'
              : 'Confirmed task contract'}
          </h2>
          <p className="muted">{task.outcome}</p>
          {conversationState.contractStatus === 'confirmed' ? (
            <ul>
              {task.criteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              Criteria remain provisional until a plan is adopted in Conversation.
            </p>
          )}
          <p className="muted small">
            Conversation retains the proposal and its decisions. Execution needs a separate source,
            team and permission review.
          </p>
          {conversationState.contractStatus === 'confirmed' &&
            adoptedPlanCurrent(conversationState) && (
              <button
                className="button primary"
                type="button"
                disabled={
                  Boolean(conversationState.activeAttempt) ||
                  ['unknown', 'stopping'].includes(conversationState.phase)
                }
                onClick={onPrepare}
              >
                Review execution contract
                <ArrowRight size={14} />
              </button>
            )}
        </section>
      </div>
    );
  const native = snapshot.nativeRuns.find((value) => value.runId === run?.id);
  const profile = snapshot.nativeProfiles.find((value) => value.id === native?.profileId);
  return (
    <div className="view-stack">
      <section className="card">
        <div className="section-heading">
          <h2>Outcome and acceptance</h2>
          <span>Task revision {task.revision}</span>
        </div>
        <p>{task.outcome}</p>
        <ul className="criteria-list">
          {task.criteria.map((criterion) => (
            <li key={criterion}>
              <Circle size={13} />
              {criterion}
            </li>
          ))}
        </ul>
      </section>
      {run ? (
        <>
          <SourceFacts source={run.source} />
          {native ? (
            <section className="card">
              <h2>{native.repository ? 'Repository work' : 'Native file proposal'}</h2>
              <div className="facts-grid">
                {native.repository ? (
                  <>
                    <Fact label="Committed base" value={short(native.repository.sourceBase)} />
                    <Fact label="Source files" value={native.repository.files} />
                    <Fact label="Source bytes" value={native.repository.bytes} />
                    <Fact
                      label="Native sandbox"
                      value={native.execution?.sandbox ?? 'Unavailable'}
                    />
                    <Fact
                      label="Native approval"
                      value={
                        native.execution?.approvalPolicy === 'never'
                          ? 'Requests refused'
                          : 'Unavailable'
                      }
                    />
                    <Fact
                      label="Native network"
                      value={native.execution?.networkAccess === false ? 'Off' : 'Unavailable'}
                    />
                  </>
                ) : (
                  <Fact label="Target" value={native.target?.path ?? 'Unavailable'} />
                )}
                <Fact
                  label={native.handoff ? 'Submissions per writer' : 'Submissions per run'}
                  value={profile?.maximumSubmissions ?? 1}
                />
                <Fact
                  label={native.handoff ? 'Writer time limit' : 'Time limit'}
                  value={`${(native.maximumTaskMs ?? profile?.maximumTaskMs ?? 300000) / 60000} min`}
                />
              </div>
              {native.handoff && (
                <p className="muted small">
                  Original run: {run.policy.policy.limits.attempts} overall attempts and{' '}
                  {run.policy.policy.limits.minutes} minutes. Manual transfer does not reset these
                  limits.
                </p>
              )}
              <p className="muted">
                Retained changes can be inspected and exported after the native process stops.
                Prepare supported checks and a separate review in Checks and review, then request
                local branch acceptance with its own permission.{' '}
                {native.handoff
                  ? 'Manual transfers use previously allowed recipients and fresh consent after confirmed Stop.'
                  : 'Handoff remains unavailable.'}
              </p>
              {native.stage === 'prepared' && (
                <button type="button" className="button primary" onClick={onPrepare}>
                  Review prepared proposal
                  <ArrowRight size={14} />
                </button>
              )}
            </section>
          ) : (
            <>
              <RouterCard run={run} routes={snapshot.routes} usage={snapshot.usage} />
              <section className="card">
                <h2>Run controls</h2>
                <div className="facts-grid">
                  <Fact label="Authority" value={titleCase(run.policy.policy.authority)} />
                  <Fact label="Quality" value={titleCase(run.policy.policy.quality)} />
                  <Fact label="Attempt limit" value={run.policy.policy.limits.attempts} />
                  <Fact label="Time limit" value={`${run.policy.policy.limits.minutes} min`} />
                  <Fact label="Concurrency" value={run.policy.policy.limits.concurrency} />
                  <Fact
                    label="Unknown usage"
                    value={titleCase(run.policy.policy.unknownUsage.rule)}
                  />
                </div>
                <p className="muted small">Policy {short(run.policy.hash)}</p>
              </section>
            </>
          )}
        </>
      ) : (
        <section className="card">
          <h2>Run has not been prepared</h2>
          <p className="muted">
            Source facts and the controller's routing decision appear before launch.
          </p>
          <button type="button" className="button primary" onClick={onPrepare}>
            Prepare run
            <ArrowRight size={14} />
          </button>
        </section>
      )}
    </div>
  );
}

function Roster({
  snapshot,
  run,
  task,
  onConfigure,
}: {
  snapshot: Snapshot;
  run?: Run;
  task?: Task;
  onConfigure: () => void;
}) {
  const activity = snapshot.attempts
    .filter(
      (attempt) =>
        attempt.runId === run?.id && ['running', 'stopping', 'unknown'].includes(attempt.state),
    )
    .map((attempt) => {
      const job = snapshot.reviewJobs?.find(
        (value) =>
          value.attemptId === attempt.id &&
          value.runId === run?.id &&
          value.taskId === task?.id &&
          value.routeId === attempt.routeId,
      );
      const method = run?.policy.policy.methods?.find((value) => value.id === job?.methodId);
      const role = job
        ? method?.reviewerRole
        : task &&
            ['running', 'waiting', 'handing_off'].includes(task.state) &&
            attempt.routeId === run?.decision.chosen
          ? 'coder'
          : undefined;
      return { attempt, role };
    });
  const unclassified = activity.filter(({ role }) => !role);
  const routeName = (id: string) => {
    const route = snapshot.routes.find((value) => value.id === id);
    return route ? `${familyName(route.family)} · ${route.model}` : id;
  };
  return (
    <aside className="roster" aria-label="Team roster">
      <div className="roster-heading">
        <h2>
          <Users size={15} />
          Team roster
        </h2>
        <span>{run?.roles.length ?? 0} assigned</span>
      </div>
      <p className="roster-note">Routes and effort stay visible for every role.</p>
      {roleNames
        .filter((role) => run?.roles.some((assignment) => assignment.role === role))
        .map((role) => {
          const assignment = run?.roles.find((value) => value.role === role);
          const jobs = activity.filter((value) => value.role === role);
          const routeId =
            role === 'coder'
              ? (run?.decision.chosen ?? assignment?.routeId)
              : (jobs[0]?.attempt.routeId ?? assignment?.routeId);
          const route = snapshot.routes.find(({ id }) => id === routeId);
          const unknown =
            jobs.some(({ attempt }) => attempt.state === 'unknown') ||
            unclassified.some(
              ({ attempt }) => attempt.routeId === routeId && attempt.state === 'unknown',
            );
          const running = jobs.some(({ attempt }) => attempt.state === 'running');
          const stopping = jobs.some(({ attempt }) => attempt.state === 'stopping');
          const status = unknown
            ? 'Ownership unknown'
            : stopping
              ? 'Stopping'
              : running
                ? 'Running'
                : 'Idle';
          return (
            <section className={`role-card ${assignment ? 'assigned' : ''}`} key={role}>
              <div className="role-card-title">
                <span>{roleLabels[role]}</span>
                {assignment?.pinned && <Pin size={12} />}
                {assignment && (
                  <span className={`role-status ${running ? 'running' : ''}`}>{status}</span>
                )}
              </div>
              {route ? (
                <>
                  <div className="role-route">
                    <span className={`provider-dot ${familyClass(route.family)}`} />
                    {familyName(route.family)}
                    {route.fake && <span className="fake-tag">Fake</span>}
                  </div>
                  <code className="role-model">{route.model}</code>
                  {role === 'coder' &&
                    snapshot.nativeRuns.some(
                      (value) => value.runId === run?.id && value.profileId === 'google-acp-v1',
                    ) && <p className="muted small">{googleAcpLabel}</p>}
                  <dl>
                    {role === 'coder' && assignment && (
                      <>
                        <div>
                          <dt>Saved primary</dt>
                          <dd>{routeName(assignment.routeId)}</dd>
                        </div>
                        <div>
                          <dt>Saved fallbacks</dt>
                          <dd>
                            {assignment.approvedFallbacks.map(routeName).join(', ') || 'None'}
                          </dd>
                        </div>
                      </>
                    )}
                    <div>
                      <dt>Requested effort</dt>
                      <dd>{route.effort.requested}</dd>
                    </div>
                    <div>
                      <dt>Effective effort</dt>
                      <dd>{route.effort.effective}</dd>
                    </div>
                    <div>
                      <dt>Slots in this run</dt>
                      <dd>
                        {unknown ? 'Unknown' : jobs.length} /{' '}
                        {run?.policy.policy.limits.concurrency ?? 1}
                      </dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="unassigned">Not assigned</p>
              )}
            </section>
          );
        })}
      {unclassified.map(({ attempt }) => (
        <p className="roster-note" key={attempt.id}>
          {attempt.state === 'unknown' ? 'Route ownership unknown' : 'Unclassified route activity'}:{' '}
          {routeName(attempt.routeId)}. {titleCase(attempt.state)}.
        </p>
      ))}
      {!run?.roles.length && (
        <p className="roster-empty">
          No roles assigned. Choose a team or build your own when configuring the run.
        </p>
      )}
      {task?.state === 'draft' && (
        <button type="button" className="button secondary configure-team" onClick={onConfigure}>
          <Users size={14} />
          Configure the run
        </button>
      )}
      <div className="roster-boundary">
        <ShieldCheck size={16} />
        <p>Roles propose work. The controller enforces admission and authority.</p>
      </div>
    </aside>
  );
}

function Changes({ task, workspace }: { task: Task; workspace: Workspace }) {
  const [changes, setChanges] = useState<Extract<
    NonNullable<Awaited<ReturnType<Workspace['command']>>['data']>,
    { kind: 'changes' }
  > | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setChanges(null);
    setSelected(null);
    setReadError(null);
    const read = () => {
      retry = undefined;
      void workspace
        .command({ command: 'GetChanges', payload: { taskId: task.id } })
        .then((result) => {
          if (!active) return;
          if (result.data?.kind === 'changes' && result.data.taskId === task.id) {
            setChanges(result.data);
            setSelected(result.data.files[0]?.path ?? null);
          } else
            setReadError(result.next ?? result.reason ?? 'The retained changes are unavailable.');
        })
        .catch((failure: unknown) => {
          if (!active) return;
          if (
            failure instanceof Error &&
            (failure.message === 'Wait for the pending desktop command.' ||
              failure.message ===
                "Error invoking remote method 'crewkite:command': Error: Wait for the pending desktop command.")
          ) {
            retry = setTimeout(read, 50);
            return;
          }
          setReadError(
            failure instanceof Error ? failure.message : 'The retained changes could not be read.',
          );
        })
        .finally(() => {
          if (active && retry === undefined) setLoading(false);
        });
    };
    read();
    return () => {
      active = false;
      clearTimeout(retry);
    };
  }, [task.id, workspace.command]);
  if (loading)
    return (
      <Empty icon={<RefreshCw className="spin" />} title="Reading retained changes">
        The controller is materializing the immutable preview.
      </Empty>
    );
  if (readError)
    return (
      <Empty icon={<AlertTriangle />} title="Retained changes unavailable">
        {readError}
      </Empty>
    );
  if (!changes?.files.length)
    return (
      <Empty icon={<FileCode />} title="No retained changes to show">
        Changes appear after a worker produces files in its scratch copy.
      </Empty>
    );
  const file = changes.files.find(({ path }) => path === selected) ?? changes.files[0];
  const sections = changes.diff.split(/(?=^diff --git )/m);
  const diff =
    sections.find((value) => value.split('\n')[0].endsWith(` b/${file.path}`)) ?? changes.diff;
  const lines = diff.split('\n').map((line, offset) => ({
    line,
    number: offset + 1,
    key: `${changes.artifactId}:${file.path}:${offset + 1}`,
  }));
  return (
    <div className="changes-view">
      <div className="section-heading">
        <h2>
          <FileCode size={15} />
          Retained changes
        </h2>
        <span>
          {changes.files.length} file(s) ·{' '}
          {changes.candidateId ? 'Sealed candidate' : 'Preview artifact'}
        </span>
      </div>
      <div className="diff-layout">
        <nav className="file-list" aria-label="Changed files">
          {changes.files.map((value) => (
            <button
              type="button"
              key={value.path}
              className={file.path === value.path ? 'active' : ''}
              onClick={() => setSelected(value.path)}
            >
              <FileCode size={14} />
              <span>{value.path}</span>
              <small>
                <i>+{value.additions}</i>
                <b>-{value.deletions}</b>
              </small>
            </button>
          ))}
        </nav>
        <section className="diff-panel">
          <header>
            <code>{file.path}</code>
            <span>{titleCase(file.status)}</span>
          </header>
          {file.binary || file.oversized ? (
            <Empty
              icon={<FileCode />}
              title={file.binary ? 'Binary file' : 'File exceeds the preview limit'}
            >
              The retained artifact records the file; its contents are not rendered here.
            </Empty>
          ) : (
            <pre className="diff-code">
              {lines.map(({ line, number, key }) => (
                <span
                  key={key}
                  className={
                    line.startsWith('+') && !line.startsWith('+++')
                      ? 'added'
                      : line.startsWith('-') && !line.startsWith('---')
                        ? 'removed'
                        : line.startsWith('@@')
                          ? 'hunk'
                          : ''
                  }
                >
                  <i aria-hidden="true">{number}</i>
                  {line || ' '}
                </span>
              ))}
            </pre>
          )}
        </section>
      </div>
      {changes.truncated && (
        <p className="notice">
          <Info size={14} />
          The displayed diff is truncated. The controller retains the immutable artifact.
        </p>
      )}
      <p className="muted small">
        Artifact {short(changes.artifactId)} · Checks apply to a sealed candidate, not this preview.
      </p>
    </div>
  );
}

function Checks({
  task,
  snapshot,
  workspace,
}: {
  task: Task;
  snapshot: Snapshot;
  workspace: Workspace;
}) {
  const combined = snapshot.combinedRuns.find(
    (value) =>
      value.taskId === task.id || value.members.some((member) => member.taskId === task.id),
  );
  const candidate =
    combined?.taskId === task.id
      ? snapshot.candidates.find(
          (value) => value.id === combined.candidate?.id && value.hash === combined.candidate.hash,
        )
      : snapshot.candidates.filter(({ taskId }) => taskId === task.id).at(-1);
  const evidence = snapshot.evidence.filter(({ candidateId }) => candidateId === candidate?.id);
  const [destination, setDestination] = useState('refs/heads/feat/net-minor');
  const native =
    snapshot.nativeRuns.some((value) => value.runId === task.runId) || combined?.taskId === task.id;
  const evaluation = snapshot.candidateEvaluations.find(
    (value) =>
      value.taskId === task.id &&
      value.runId === task.runId &&
      value.candidateId === candidate?.id &&
      value.candidateHash === candidate.hash,
  );
  const eligible = native
    ? evaluation?.localAcceptance.available && (!combined || combined.accept.available)
    : candidate && task.state === 'ready';
  const acceptanceReason = evaluation?.localAcceptance.reason ?? 'evidence-incomplete';
  const acceptanceReasons = {
    available: 'Checks and native review passed. Request acceptance for the destination below.',
    'evidence-incomplete':
      'Matching checks, native review and ownership evidence are required before acceptance.',
    'ownership-unknown': 'Execution ownership is unknown. Resolve it before acceptance.',
    'candidate-changed': 'The candidate or task changed. Inspect the current retained work.',
    'source-changed': 'The original project changed. Acceptance is unavailable for this source.',
    'git-identity-missing': 'Configure a Git name and email before acceptance.',
    'approval-pending': 'Review the pending approval in Activity.',
    'publication-prepared': 'A local publication is prepared. Inspect its receipt before retrying.',
    accepted: 'The candidate was accepted to a local branch.',
  };

  if (combined && combined.taskId !== task.id)
    return (
      <Empty icon={<GitBranch />} title="Member work belongs to the combined candidate">
        Inspect Combined task for the parent. Member candidates cannot be evaluated or accepted
        separately.
      </Empty>
    );

  return (
    <div className="view-stack">
      {native ? (
        <NativeEvaluation
          key={`${task.id}:${task.runId}:${candidate?.id}:${candidate?.hash}`}
          task={task}
          candidate={candidate}
          snapshot={snapshot}
          workspace={workspace}
        />
      ) : (
        <>
          <section className="card">
            <div className="section-heading">
              <h2>
                <ListChecks size={15} />
                Recorded evaluations
              </h2>
              <span>
                {candidate ? `Candidate ${short(candidate.hash)}` : 'No candidate sealed'}
              </span>
            </div>
            {evidence.length ? (
              <div className="evidence-list">
                {evidence.map((value) => (
                  <div key={`${value.evaluator}-${value.definitionHash}`}>
                    <span className={`result-symbol ${value.passed ? 'passed' : 'failed'}`}>
                      {value.passed ? <Check size={14} /> : <X size={14} />}
                    </span>
                    <div className="evidence-copy">
                      <strong>
                        {value.review
                          ? `Scripted ${methodName(value.review.job.methodId)} · round ${value.review.job.cycle}`
                          : value.evaluator.startsWith('node:')
                            ? 'Node checks'
                            : 'Recorded check'}
                      </strong>
                      <details>
                        <summary>Evidence identity</summary>
                        <code>Evaluator {value.evaluator}</code>
                        <code>Definition {value.definitionHash}</code>
                        <code>Candidate {value.candidateHash}</code>
                      </details>
                    </div>
                    <StateChip state={value.passed ? 'ready' : 'failed'} />
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon={<ListChecks />} title="No check evidence recorded">
                Checks bind to the exact candidate hash and appear after the controller records
                their result.
              </Empty>
            )}
          </section>
          <section className="card">
            <div className="section-heading">
              <h2>Scripted review methods</h2>
              <span>Bound to the candidate hash</span>
            </div>
            {evidence.filter((value) => value.review).length ? (
              <div className="review-results">
                {evidence
                  .flatMap((value) => (value.review ? [value.review] : []))
                  .map((result) => {
                    const route = snapshot.routes.find(({ id }) => id === result.job.routeId);
                    return (
                      <article key={`${result.job.methodId}-${result.job.cycle}`}>
                        <div className="section-heading">
                          <h3>{methodName(result.job.methodId)}</h3>
                          <span className="scripted-badge">SCRIPTED · {result.outcome}</span>
                        </div>
                        <p>{result.summary}</p>
                        <p className="muted small">
                          {'origin' in result.job
                            ? 'Combined candidate from two retained contributors. Separate review invocation.'
                            : result.job.writerRouteId === undefined
                              ? 'Last writer route unknown for this saved review.'
                              : result.job.writerRouteId === result.job.routeId
                                ? 'Same route as the last writer. Separate review invocation.'
                                : 'Different route from the last writer.'}{' '}
                          Model diversity is not established.
                        </p>
                        <div className="review-identity">
                          <span>Round {result.job.cycle}</span>
                          <span>{route ? familyName(route.family) : 'Unavailable route'}</span>
                          <code>{short(result.job.candidateHash)}</code>
                        </div>
                        {'origin' in result.job ? (
                          <details className="technical-details">
                            <summary>Combined origin</summary>
                            <code>Manifest {result.job.origin.manifestHash}</code>
                            <code>Generation {result.job.origin.generation}</code>
                            {result.job.origin.contributors.map((contributor) => (
                              <div key={contributor.attemptId}>
                                <code>Contributor task {contributor.taskId}</code>
                                <code>Writer attempt {contributor.attemptId}</code>
                                <code>Writer route {contributor.routeId}</code>
                                <code>Candidate {contributor.candidateHash}</code>
                              </div>
                            ))}
                          </details>
                        ) : result.job.writerAttemptId && result.job.writerRouteId ? (
                          <details className="technical-details">
                            <summary>Details</summary>
                            <code>Last writer attempt {result.job.writerAttemptId}</code>
                            <code>Last writer route {result.job.writerRouteId}</code>
                          </details>
                        ) : null}
                        <ul>
                          {result.findings.map((finding) => (
                            <li key={`${finding.severity}-${finding.message}`}>
                              {finding.severity}: {finding.message}
                            </li>
                          ))}
                        </ul>
                      </article>
                    );
                  })}
              </div>
            ) : (
              <p className="muted">
                No scripted review evidence is recorded for this candidate. New runs require{' '}
                {(['quick', 'standard', 'thorough'] as const)
                  .map(
                    (quality) =>
                      `${titleCase(quality)}: ${requiredReviewMethodIds(quality).map(methodName).join(', ')}`,
                  )
                  .join('; ')}
                . Existing runs keep their saved requirements.
              </p>
            )}
            <p className="muted small">
              Scripted reviews inspect fixed challenge patterns. They do not contain model judgment.
            </p>
          </section>
        </>
      )}
      <section className="card acceptance-card">
        <div className="section-heading">
          <h2>
            <GitBranch size={15} />
            Accept or export
          </h2>
          <span>Local actions</span>
        </div>
        <p className="muted">
          Acceptance creates a new local branch. Existing refs cannot be overwritten. The exact
          destination needs its own permission or approval. Nothing is merged or pushed.
        </p>
        {!(native && acceptanceReason === 'accepted') && (
          <label>
            Destination ref
            <input
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              spellCheck={false}
            />
          </label>
        )}
        <div className="button-row">
          <button
            type="button"
            className="button secondary"
            disabled={!candidate || workspace.pending || workspace.connection !== 'connected'}
            onClick={() =>
              candidate &&
              void workspace
                .command({
                  command: 'ExportPatch',
                  expectedRevision: task.revision,
                  payload: { taskId: task.id, candidateId: candidate.id },
                })
                .catch(() => {})
            }
          >
            <Download size={14} />
            Export patch
          </button>
          <button
            type="button"
            className="button primary"
            disabled={
              !eligible ||
              workspace.pending ||
              workspace.connection !== 'connected' ||
              !/^refs\/heads\/[a-z0-9][a-z0-9/-]{0,199}$/.test(destination)
            }
            onClick={() =>
              candidate &&
              void workspace
                .command({
                  command: 'AcceptCandidate',
                  expectedRevision: task.revision,
                  payload: {
                    taskId: task.id,
                    candidateId: candidate.id,
                    destinationRef: destination,
                  },
                })
                .catch(() => {})
            }
          >
            <Check size={14} />
            Accept candidate
          </button>
        </div>
        {native ? (
          <p className="muted small" role="status">
            {combined && !combined.accept.available
              ? `Combined acceptance unavailable: ${titleCase(combined.accept.reason)}.`
              : acceptanceReasons[acceptanceReason]}
          </p>
        ) : (
          !eligible && (
            <p className="muted small">
              The controller must mark this task ready before acceptance.
            </p>
          )
        )}
      </section>
    </div>
  );
}

function Handoffs({ events, snapshot }: { events: Event[]; snapshot: Snapshot }) {
  const packets = events.filter(
    (event): event is Extract<Event, { type: 'handoff.sealed' }> => event.type === 'handoff.sealed',
  );
  const [open, setOpen] = useState<string | null>(null);
  if (!packets.length)
    return (
      <Empty icon={<GitBranch />} title="No handoff received in this session">
        A transfer waits for the old writer to stop. The packet preserves facts, retained artifacts
        and unfinished work.
      </Empty>
    );
  return (
    <div className="view-stack">
      {packets.map(({ payload }) => {
        const { packet, checksum } = payload;
        const outgoing = snapshot.attempts.find(({ id }) => id === packet.attemptId);
        const from = snapshot.routes.find(({ id }) => id === outgoing?.routeId);
        const targets = packet.allowedRouteIds.map(
          (id) => snapshot.routes.find((route) => route.id === id)?.family ?? short(id),
        );
        return (
          <section className="card handoff-card" key={packet.id}>
            <div className="handoff-route">
              <span className={`provider-label ${familyClass(from?.family ?? '')}`}>
                {from?.family ?? 'Outgoing route'}
              </span>
              <ArrowRight size={16} />
              <span className="packet-symbol">
                <GitBranch size={16} />
              </span>
              <ArrowRight size={16} />
              <span>Allowed routes: {targets.join(', ') || 'None'}</span>
            </div>
            <div className="section-heading">
              <h2>Retained task packet</h2>
              <span>
                Version {packet.version} · generation {packet.generation}
              </span>
            </div>
            <div className="facts-grid">
              <Fact label="Unfinished" value={packet.unfinished.length} />
              <Fact label="Unverified" value={packet.unverified.length} />
              <Fact label="Artifacts" value={packet.artifacts.length} />
              <Fact label="Remaining attempts" value={packet.remainingBudgets.attempts} />
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => setOpen(open === packet.id ? null : packet.id)}
            >
              {open === packet.id ? 'Hide packet' : 'Inspect packet'}
              <ChevronRight size={13} />
            </button>
            {open === packet.id && (
              <div className="packet-details">
                <h3>Unfinished work</h3>
                <ul>
                  {packet.unfinished.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
                <h3>Unrun checks</h3>
                <ul>
                  {packet.unrunChecks.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
                <h3>Decisions</h3>
                <ul>
                  {packet.decisions.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
                <h3>SHA-256 checksum</h3>
                <code>{checksum}</code>
                <p className="muted small">
                  Source {short(packet.source.base)} · policy {short(packet.policy.hash)}
                </p>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function usageReading(value: UsageGaugeReading, label = value.label): UsageReading {
  const { reserveNote, ...facts } = value;
  return {
    ...facts,
    label,
    ...(reserveNote === null ? {} : { reserveNote: 'See reserve details', note: reserveNote }),
  };
}

function Usage({
  snapshot,
  attempts,
  run,
  workspace,
}: {
  snapshot: WorkspaceState;
  attempts: Snapshot['attempts'];
  run?: Run;
  workspace: Workspace;
}) {
  const [readerMessage, setReaderMessage] = useState<string | null>(null);
  const [metadataBusy, setMetadataBusy] = useState<Record<string, boolean>>({});
  const anthropicConnection = snapshot.nativeConnections.find(
    (value) => value.family === 'anthropic',
  );
  async function checkAnthropic() {
    setMetadataBusy((current) => ({ ...current, anthropic: true }));
    setReaderMessage('Checking Anthropic sign-in.');
    try {
      const result = await workspace.metadataCommand({
        command: 'CheckNativeConnection',
        expectedRevision: 0,
        payload: { family: 'anthropic', consent: 'explicit' },
      });
      setReaderMessage(
        result.outcome === 'applied' || result.outcome === 'already-applied'
          ? 'Anthropic sign-in check completed.'
          : [result.reason ?? result.outcome, result.next].filter(Boolean).join('. '),
      );
    } catch (failure) {
      setReaderMessage(
        failure instanceof Error ? failure.message : 'Anthropic sign-in could not be checked.',
      );
    } finally {
      setMetadataBusy((current) => ({ ...current, anthropic: false }));
    }
  }
  const [displayTime, setDisplayTime] = useState(Date.now);
  const fixture = workspace.preview;
  useEffect(() => {
    if (fixture) return;
    setDisplayTime(Date.now());
    const timer = window.setInterval(() => setDisplayTime(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [fixture]);
  const clients = nativeUsageClients(snapshot);
  const connected = workspace.connection === 'connected' && !workspace.preview;
  async function observeUsage(family: 'google' | 'openai') {
    setMetadataBusy((current) => ({ ...current, [family]: true }));
    setReaderMessage('Quota read in progress.');
    try {
      const result = await workspace.metadataCommand({
        command: 'ObserveUsage',
        expectedRevision: 0,
        payload: { family },
      });
      setReaderMessage(
        result.outcome === 'applied' || result.outcome === 'already-applied'
          ? 'Quota read successful.'
          : [result.reason ?? result.outcome, result.next].filter(Boolean).join('. '),
      );
    } catch (failure) {
      setReaderMessage(failure instanceof Error ? failure.message : 'The quota command failed.');
    } finally {
      setMetadataBusy((current) => ({ ...current, [family]: false }));
    }
  }
  const fixtureTime = Math.max(
    0,
    ...snapshot.usage.map(({ observation }) => Date.parse(observation.observedAt)),
  );
  const now = fixture ? fixtureTime : displayTime;
  const cloud = snapshot.routes.filter(({ family }) => family !== 'local');
  const scopes = projectUsagePresentation(snapshot, run?.policy.policy.reserves ?? null, now);
  const cards: UsageCard[] = scopes.map((scope) => ({
    id: scope.id,
    title: scope.label,
    scope: scope.scopeLabel,
    tags: scope.fixture ? ['Fixture'] : undefined,
    notice: scope.notice ?? undefined,
    primary: [
      ...(scope.primary.weekly ? [usageReading(scope.primary.weekly, 'Weekly')] : []),
      ...(scope.primary.fiveHour ? [usageReading(scope.primary.fiveHour, 'Five-hour')] : []),
    ],
    featured: scope.featured ? usageReading(scope.featured) : null,
    auxiliary: scope.satellites
      .filter((reading) => reading !== scope.featured)
      .map((reading) => usageReading(reading)),
    emptyText: 'No usage observations.',
  }));
  const local = snapshot.routes.find(({ family }) => family === 'local');
  return (
    <main className="usage-page">
      <div className="page-heading">
        <p className="eyebrow">WORKSPACE CAPACITY</p>
        <h1>Usage and capacity</h1>
        <p>Allowance stays in the provider's own units. Missing observations stay unknown.</p>
        <span className="fixture-clock">
          <Clock size={13} />
          {fixture
            ? `Fixture clock · ${new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
            : 'Controller observations'}
        </span>
      </div>
      <LocalSetup snapshot={snapshot} workspace={workspace} />
      <GoogleSetup snapshot={snapshot} workspace={workspace} />
      <section aria-labelledby="native-clients-title">
        <div className="section-heading">
          <h2 id="native-clients-title">Native clients</h2>
        </div>
        <p className="muted small">
          Client readiness is separate from retained usage and account allowance.
        </p>
        <div className="capacity-grid">
          {clients.map(({ family, label, profiles, reader }) => {
            const nextReadAt = reader?.lastAttemptAt
              ? Date.parse(reader.lastAttemptAt) + 60000
              : null;
            return (
              <section className="card" key={family} aria-label={`${label} client status`}>
                <div className="section-heading">
                  <h3>{label}</h3>
                  <span>
                    {profiles.some((profile) => profile.available)
                      ? 'Supported client present'
                      : 'Supported client unavailable'}
                  </span>
                </div>
                {profiles.map((profile) => (
                  <p className="muted small" key={profile.id}>
                    {profile.id}: {profile.reason}
                  </p>
                ))}
                {profiles.length === 0 && (
                  <p className="muted small">No native profile is registered.</p>
                )}
                {family === 'anthropic' ? (
                  <>
                    <p role="status">
                      {anthropicConnection?.state === 'signed-in'
                        ? 'Signed in with Anthropic account'
                        : anthropicConnection?.state === 'signed-out'
                          ? 'Signed out'
                          : `Sign-in ${anthropicConnection?.state ?? 'unchecked'}`}
                    </p>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={
                        !connected ||
                        !profiles.some((profile) => profile.available) ||
                        metadataBusy.anthropic ||
                        anthropicConnection?.state === 'checking'
                      }
                      onClick={() => void checkAnthropic()}
                    >
                      Check Anthropic sign-in
                    </button>
                    <p className="muted small">
                      {anthropicConnection?.next ??
                        'Check the existing native client sign-in. No model prompt is sent.'}
                    </p>
                    {anthropicConnection?.state === 'signed-out' && (
                      <p className="muted small">
                        Follow the{' '}
                        <a
                          href="https://github.com/rjk6831/crewkite/blob/main/docs/providers.md#anthropic-writer-preparation"
                          target="_blank"
                          rel="noreferrer"
                        >
                          native client sign-in instructions
                        </a>
                        , then check again.
                      </p>
                    )}
                    {anthropicConnection?.observedAt && (
                      <p className="muted small">
                        Last checked: {anthropicConnection.observedAt}. Billing and task
                        qualification remain unknown.
                      </p>
                    )}
                    <p className="muted small">
                      Standalone quota refresh is unavailable. Usage stays unknown until an
                      explicitly started task reports it. No prompt is sent to obtain quota.
                    </p>
                  </>
                ) : family === 'local' ? (
                  <p className="muted small">
                    Local resource capacity has no subscription quota reader.
                  </p>
                ) : (
                  <>
                    <p className="muted small">
                      Reads account quota through the supported native client. No model request.
                    </p>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={
                        !connected ||
                        metadataBusy[family] ||
                        !reader?.available ||
                        reader.readState === 'intent' ||
                        reader.readState === 'owned'
                      }
                      onClick={() => void observeUsage(family)}
                    >
                      <RefreshCw size={14} /> Refresh {label} quota
                    </button>
                    {family === 'openai' &&
                      reader?.readState === 'quiescent' &&
                      reader.readReason === 'observed' && (
                        <p role="status">Latest quota read successful.</p>
                      )}
                    <p className="muted small">
                      Reader status: {reader?.reason ?? 'unavailable'}. Last attempt:{' '}
                      {reader?.lastAttemptAt ?? 'None'}. Last observation:{' '}
                      {reader?.lastObservedAt ?? 'None'}.
                    </p>
                    {reader?.readState && (
                      <p className="muted small">
                        Read state: {reader.readState}. Result:{' '}
                        {reader.readReason ?? 'No completed result'}.
                        {reader.lastRequest ? ` Last request: ${reader.lastRequest}.` : ''}
                      </p>
                    )}
                    {nextReadAt !== null && nextReadAt > now && (
                      <p className="muted small">
                        Cooldown until {new Date(nextReadAt).toLocaleTimeString()}. Failed reads
                        also count.
                      </p>
                    )}
                  </>
                )}
              </section>
            );
          })}
        </div>
        {readerMessage && <p role="status">{readerMessage}</p>}
      </section>
      <section aria-labelledby="allowance-title">
        <div className="section-heading">
          <h2 id="allowance-title">Provider allowances</h2>
          <span>
            {run ? 'Reserve markers follow the selected task run' : 'Reported observations'}
          </span>
        </div>
        {cards.length ? (
          <>
            <UsageGauges cards={cards} nowMs={now} />
            <details className="technical-details">
              <summary>Represented routes</summary>
              {scopes.map((scope) => (
                <div key={scope.id}>
                  <p>
                    {scope.label}: {scope.scopeLabel}
                  </p>
                  {scope.routeIds.map((id) => (
                    <code key={id}>{id}</code>
                  ))}
                </div>
              ))}
            </details>
          </>
        ) : (
          <Empty icon={<Gauge />} title="No provider allowance scope">
            No retained cloud usage route is available. Native-client readiness is shown above.
          </Empty>
        )}
      </section>
      <div className="capacity-grid">
        <section className="card activity-capacity">
          <div className="section-heading">
            <h2>
              <Activity size={15} />
              Controller activity
            </h2>
            <span>Selected task</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Route</th>
                <th>Recorded attempts</th>
                <th>Active minutes</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.routes.map((route) => (
                <tr key={route.id}>
                  <td>
                    <span className={`provider-dot ${familyClass(route.family)}`} />
                    {familyName(route.family)}
                  </td>
                  <td>
                    {
                      attempts.filter(
                        ({ routeId, state }) => routeId === route.id && state !== 'intent',
                      ).length
                    }
                  </td>
                  <td className="muted">Not measured</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Activity counters describe the selected task detail. They do not measure workspace-wide
            or account-wide usage.
          </p>
        </section>
        <section className="card hardware-card">
          <div className="section-heading">
            <h2>
              <Cpu size={15} />
              Local hardware
            </h2>
            <span>{local?.qualified ? 'Route configured' : 'Unavailable'}</span>
          </div>
          <div className="hardware-symbol">
            <Cpu size={26} />
          </div>
          <h3>No provider quota</h3>
          <p className="muted">
            Local inference depends on resident models and available hardware.
          </p>
          <div className="hardware-row">
            <span>Memory observations</span>
            <span>Unavailable</span>
          </div>
          <div className="hardware-row">
            <span>Configured model</span>
            <span>{local?.model ?? 'Not configured'}</span>
          </div>
          <p className="muted small">Hardware measurements are unavailable.</p>
        </section>
      </div>
      <section className="card credits-card">
        <div className="section-heading">
          <h2>
            <Wallet size={15} />
            Paid credits
          </h2>
          <span>Separate from subscription allowance</span>
        </div>
        <div className="credit-grid">
          {cloud.map((route) => (
            <div className="credit-row" key={route.id}>
              <span className={`provider-dot ${familyClass(route.family)}`} />
              <div>
                <strong>{familyName(route.family)}</strong>
                <small>No account credit balance reported</small>
              </div>
              <span className="credit-off">Unknown</span>
            </div>
          ))}
        </div>
        <p className="muted small">
          Using existing credits requires a billing selection when preparing a run. A provider limit
          does not grant that permission.
        </p>
      </section>
    </main>
  );
}

function CreateTask({
  workspace,
  snapshot,
  onClose,
  onCreated,
}: {
  workspace: Workspace;
  snapshot: Pick<Snapshot, 'projects'>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [template] = useState(() => (workspace.preview ? createDemoFixtures().task : null));
  const [title, setTitle] = useState(template?.title ?? '');
  const [outcome, setOutcome] = useState(template?.outcome ?? '');
  const [criteria, setCriteria] = useState(template?.criteria.join('\n') ?? '');
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.id ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const payload = {
    projectId,
    title: title.trim(),
    outcome: outcome.trim(),
    criteria: criteria
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  };
  const valid =
    CommandSchema.options
      .find((option) => option.shape.command.value === 'CreateTask')
      ?.shape.payload.safeParse(payload).success ?? false;
  const validation = valid
    ? null
    : 'Choose a project, a title, an outcome and 1 to 100 criteria. Each criterion must fit 4096 characters.';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) {
      setMessage(validation);
      return;
    }
    setMessage(null);
    try {
      const result = await workspace.command({
        command: 'CreateTask',
        expectedRevision: 0,
        payload,
      });
      if (
        (result.outcome === 'applied' || result.outcome === 'already-applied') &&
        result.entity &&
        'state' in result.entity
      )
        onCreated(result.entity.id);
      else setMessage(result.next ?? result.reason ?? 'The task could not be created.');
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : 'The task could not be created.');
    }
  }
  return (
    <Dialog title="New task" eyebrow="BOUNDED WORK" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="form-stack">
        <label>
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {snapshot.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {workspace.canPickProject && (
          <button
            type="button"
            className="button secondary"
            disabled={workspace.pending}
            onClick={() =>
              void workspace
                .pickProject()
                .then((result) => {
                  const project = ProjectSchema.safeParse(result?.entity);
                  if (project.success) setProjectId(project.data.id);
                })
                .catch((failure: unknown) =>
                  setMessage(
                    failure instanceof Error ? failure.message : 'The project could not be opened.',
                  ),
                )
            }
          >
            <Folder size={14} />
            Choose another project
          </button>
        )}
        <label>
          Task title
          <input
            autoFocus
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Outcome
          <textarea
            rows={2}
            required
            maxLength={4096}
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
          />
        </label>
        <label>
          Acceptance criteria
          <span className="field-hint">One concrete claim per line, up to 100</span>
          <textarea
            rows={5}
            required
            maxLength={409699}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
          />
        </label>
        {(message || validation) && <p role="alert">{message ?? validation}</p>}
        <div className="dialog-footer">
          <span className="muted small">You review source and permissions before launch.</span>
          <button type="submit" className="button primary" disabled={workspace.pending || !valid}>
            Create task
            <ArrowRight size={14} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const credits = [
  {
    name: 'Ponytail',
    method: 'Keep it simple',
    description: 'A simplicity lens and the build-less ladder.',
    repository: 'DietrichGebert/ponytail',
    pin: '552acd5efd0aeae2583a12efe39373d2f076f25e',
  },
  {
    name: 'ADHD',
    method: 'Challenge assumptions',
    description: 'Bounded assumption challenges during planning.',
    repository: 'UditAkhourii/adhd',
    pin: '7b91ce601ed951c1a9658c63f6f9550d2486525b',
  },
  {
    name: 'multi',
    method: 'Second opinion and Round-robin review',
    description: 'Independent and round-robin review methods.',
    repository: 'szarkans/multi',
    pin: 'fcbe236a4fff1e513756c80e63ffb590b0fb1b19',
  },
];

function About({ onClose, preview }: { onClose: () => void; preview: boolean }) {
  return (
    <Dialog title="About CrewKite" eyebrow="LOCAL CODING WORKSPACE" onClose={onClose}>
      <div className="about-content">
        <p>
          One controller owns task state, authority and result identity. The desktop and CLI are
          clients of the same workspace.
        </p>
        {preview && (
          <div className="about-build">
            <span className="prototype-tag">D0</span>
            <span>Scripted providers · no live inference qualification</span>
          </div>
        )}
        <h3>Method acknowledgments</h3>
        <p className="muted">
          These projects shaped the review methods. Credits describe method influence. No runtime
          code from these projects is included.
        </p>
        <div className="credit-sources">
          {credits.map((credit) => (
            <section key={credit.name}>
              <div>
                <h4>{credit.method}</h4>
                <a
                  href={`https://github.com/${credit.repository}/tree/${credit.pin}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {credit.name}
                  <ArrowUpRight size={12} />
                </a>
              </div>
              <p>{credit.description}</p>
              <code>Source revision {short(credit.pin)}</code>
            </section>
          ))}
        </div>
        <p className="muted small">
          Method configuration is saved in the run policy. Candidate evidence records the checks and
          reviews that ran.
        </p>
        <div className="about-license">
          <span>Apache License 2.0</span>
          <span>Copyright 2026 Raymond J. Kraft</span>
        </div>
      </div>
    </Dialog>
  );
}
