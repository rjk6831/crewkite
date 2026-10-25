import type { TaskPage, TaskSummary } from '@crewkite/contracts';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Folder,
  Info,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquarePen,
  Sun,
  X,
} from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import wordmark from './assets/crewkite-wordmark.png';
import inverseWordmark from './assets/crewkite-wordmark-inverse.png';
import { Dialog, short, titleCase } from './components.tsx';
import { Empty, WorkspaceEmpty } from './empty-state.tsx';
import { ExternalLink } from './external-link.tsx';
import { withThreadDefaults } from './settings/preferences.ts';
import { SettingsPage } from './settings/settings-page.tsx';
import { useWorkspace, type Workspace } from './source.ts';
import { NewThread } from './thread/new-thread.tsx';
import { RailUsage } from './thread/rail-usage.tsx';
import { OpeningThread, ThreadView } from './thread/thread-view.tsx';

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
// Matched text can run long. Show the words around the match and keep surrogate pairs whole.
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
          outcome: 'First message',
          criterion: 'Criterion',
          'task-id': 'Thread ID',
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
      ? `Threads ${offset + 1}-${offset + shownTasks.length} of ${taskResults.length}${complete ? '' : ' loaded'}`
      : complete
        ? 'No threads yet'
        : 'Searching threads'
    : options.length
      ? `${taskResults.length} ${taskResults.length === 1 ? 'thread' : 'threads'} and ${commandResults.length} ${commandResults.length === 1 ? 'command' : 'commands'} match${taskResults.length > paletteTaskPageSize ? `. Showing ${offset + 1}-${offset + shownTasks.length}` : ''}`
      : complete
        ? 'No matches'
        : 'Searching threads';
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
          aria-label="Search threads and commands"
          aria-expanded="true"
          aria-controls={`${id}-results`}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={`${id}-scope`}
          placeholder="Title, first message, ID or project"
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
        Threads and commands. Searches thread titles, project names, the first message of each
        thread and IDs. Later messages are not searched.
      </p>
      <div
        className="palette-results"
        id={`${id}-results`}
        role="listbox"
        aria-label="Threads and commands"
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
            <legend className="palette-group-label">Threads</legend>
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
          <strong>No threads or commands match “{trimmed}”.</strong>
          <span>Check the spelling, or search by thread ID or project name.</span>
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
              aria-label="Previous threads"
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
              aria-label="Next threads"
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
  const connectionLabel = preview
    ? 'Preview data'
    : connection === 'connected'
      ? 'Controller connected'
      : connection === 'offline'
        ? 'Controller offline'
        : titleCase(connection);
  const [page, setPage] = useState<'tasks' | 'settings'>('tasks');
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
  const [theme, setTheme] = useState(() => readPreference('crewkite-theme') ?? 'dark');
  const [collapsed, setCollapsed] = useState(
    () => readPreference('crewkite-sidebar-collapsed-v1') === '1',
  );
  // The project a new thread will be created in. Null while a saved thread is open.
  const [newThread, setNewThread] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const paletteOpener = useRef<HTMLElement | null>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const [about, setAbout] = useState(false);
  const task = newThread === null ? snapshot?.tasks.find(({ id }) => id === selected) : undefined;
  const selectedProjectId = task?.projectId;
  useEffect(() => {
    if (selectedProjectId && !taskPages[selectedProjectId])
      void workspace.loadTasks(selectedProjectId);
  }, [selectedProjectId, taskPages, workspace.loadTasks]);
  function startThread(projectId?: string) {
    setNewThread(projectId ?? task?.projectId ?? projects[0]?.id ?? '');
    setPage('tasks');
  }
  function openThread(id: string) {
    setNewThread(null);
    setSelected(id);
    setPage('tasks');
  }
  // Runs before the dialog opens and after it is removed, so focus goes back where it came from.
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
        // Palette commands change the selected thread. Keep them out of other open dialogs.
        const other = [...document.querySelectorAll('dialog[open]')].some(
          (dialog) => !dialog.querySelector('.palette'),
        );
        if (!other) setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  const inThread = !!header && page === 'tasks' && (newThread !== null || !!task);
  const threadSource = workspace.source;
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
          type="button"
          className="nav-item"
          onClick={() => startThread()}
          disabled={!header}
          data-tooltip="New thread"
          aria-label="New thread"
        >
          <SquarePen size={16} aria-hidden="true" />
          <span className="nav-text">New thread</span>
        </button>
        <button
          ref={searchButton}
          type="button"
          className="search-button"
          onClick={() => setPalette(true)}
          aria-label="Search threads and commands"
          aria-keyshortcuts="Meta+K Control+K"
          data-tooltip="Search"
        >
          <Search size={14} aria-hidden="true" />
          <span className="nav-text">Search</span>
          <kbd>⌘ K</kbd>
        </button>
        {/* The list stays mounted while the rail shows, so it keeps its scroll position. */}
        <div className="nav-scroll" hidden={collapsed}>
          <div className="nav-label">PROJECTS</div>
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
          {projects.map((project) => (
            <div key={project.id} className="project-group">
              <div className="project-name">
                <ChevronRight size={12} className="expanded" />
                <Folder size={15} />
                <span className="project-title" title={project.name}>
                  {project.name}
                </span>
                <span className="count">{project.taskCount}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`New thread in ${project.name}`}
                  title={`New thread in ${project.name}`}
                  onClick={() => startThread(project.id)}
                >
                  <Plus size={14} aria-hidden="true" />
                </button>
              </div>
              {(taskPages[project.id]?.tasks ?? []).map((value) => {
                const current = page === 'tasks' && newThread === null && task?.id === value.id;
                return (
                  <button
                    type="button"
                    key={value.id}
                    className={`task-link ${current ? 'active' : ''}`}
                    aria-current={current ? 'page' : undefined}
                    onClick={() => openThread(value.id)}
                  >
                    <span className={`status-dot state-${value.state}`} />
                    <span>{value.title}</span>
                    {value.state === 'waiting' && <span className="notification-dot" />}
                  </button>
                );
              })}
              {project.taskCount === 0 && <p className="nav-empty">No threads yet</p>}
              {project.taskCount > 0 && !taskPages[project.id] && (
                <button
                  type="button"
                  className="task-link"
                  disabled={workspace.navigationBusy}
                  onClick={() => void workspace.loadTasks(project.id)}
                >
                  Show threads
                </button>
              )}
              {taskPages[project.id] && !taskPages[project.id].complete && (
                <button
                  type="button"
                  className="task-link"
                  disabled={workspace.navigationBusy}
                  onClick={() => void workspace.loadTasks(project.id, true)}
                >
                  Load more threads
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
        </div>
        {header && !collapsed && (
          <RailUsage
            source={threadSource}
            header={header}
            onOpenSettings={() => setPage('settings')}
          />
        )}
        <div className="nav-bottom">
          <button
            type="button"
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            aria-current={page === 'settings' ? 'page' : undefined}
            onClick={() => setPage('settings')}
            data-tooltip="Settings"
          >
            <Settings size={16} aria-hidden="true" />
            <span className="nav-text">Settings</span>
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
      <div className={inThread ? 'workspace-body is-thread' : 'workspace-body'}>
        <header className="topbar">
          <div className="breadcrumbs">
            <Folder size={14} />
            <span>Workspace</span>
            <ChevronRight size={12} />
            <span>{page === 'settings' ? 'Settings' : 'Threads'}</span>
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
              onClick={() => void workspace.retryCommand().catch(() => {})}
            >
              Retry exact command
            </button>
          </div>
        )}
        {workspaceError && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={16} />
            <span>{workspaceError}</span>
            <button
              type="button"
              className="icon-button"
              onClick={() => workspace.setError(null)}
              aria-label="Dismiss error"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {workspace.detailStale && (
          <p className="recovery-banner" role="status">
            Reconnecting thread detail. Displayed state is stale; controls resume after refresh.
          </p>
        )}
        {!header ? (
          <div className="loading-workspace">
            <Empty
              icon={connection === 'offline' ? <AlertTriangle /> : <RefreshCw className="spin" />}
              title={connection === 'offline' ? 'Controller unavailable' : 'Opening the workspace'}
            >
              Threads appear after the desktop connects to its controller.
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
        ) : page === 'settings' ? (
          <SettingsPage workspace={workspace} header={header} theme={theme} onTheme={setTheme} />
        ) : !threadSource ? (
          <div className="loading-workspace" role="alert">
            <p>The desktop bridge is unavailable.</p>
          </div>
        ) : newThread !== null ? (
          <NewThread
            source={threadSource}
            createTask={withThreadDefaults(threadSource, workspace.command)}
            projects={projects}
            projectId={newThread}
            onProject={setNewThread}
            onCreated={openThread}
            onAddProject={
              workspace.canPickProject ? () => void workspace.pickProject().catch(() => {}) : null
            }
            blocked={connection === 'connected' ? null : 'Reconnect to the controller to send.'}
          />
        ) : selected && !snapshot ? (
          <OpeningSnapshot key={selected} onRetry={() => void workspace.selectTask(selected)} />
        ) : task ? (
          <ThreadView
            key={task.id}
            source={threadSource}
            task={task}
            projectName={projects.find(({ id }) => id === task.projectId)?.name ?? 'Project'}
            header={header}
            preview={preview}
            connection={connection}
          />
        ) : (
          <WorkspaceEmpty
            projects={projects}
            canAddProject={workspace.canPickProject}
            busy={workspace.pending || connection !== 'connected'}
            onAddProject={() => void workspace.pickProject().catch(() => {})}
            onNewThread={() => startThread()}
          />
        )}
        <footer className="statusbar">
          <span>
            Local workspace<span className="footer-separator">/</span>
            {connectionLabel}
          </span>
          <span>
            Search<kbd>⌘ K</kbd>
          </span>
        </footer>
      </div>
      {about && <About preview={preview} onClose={() => setAbout(false)} />}
      {palette && (
        <Dialog title="Search threads and commands" onClose={() => setPalette(false)}>
          <CommandPalette
            commands={[
              {
                id: 'new-thread',
                label: 'New thread',
                icon: <SquarePen size={17} />,
                run: () => startThread(),
              },
              {
                id: 'settings',
                label: 'Open settings',
                icon: <Settings size={17} />,
                run: () => setPage('settings'),
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
              openThread(id);
            }}
            onClose={() => setPalette(false)}
          />
        </Dialog>
      )}
    </div>
  );
}

const credits = [
  {
    name: 'Ponytail',
    description: 'The contribution ladder in CONTRIBUTING.md is adapted from it.',
    repository: 'DietrichGebert/ponytail',
    pin: '552acd5efd0aeae2583a12efe39373d2f076f25e',
  },
  {
    name: 'ADHD',
    description: 'Influenced the design of bounded assumption challenges.',
    repository: 'UditAkhourii/adhd',
    pin: '7b91ce601ed951c1a9658c63f6f9550d2486525b',
  },
  {
    name: 'multi',
    description: 'Influenced the design of independent and round-robin review.',
    repository: 'szarkans/multi',
    pin: 'fcbe236a4fff1e513756c80e63ffb590b0fb1b19',
  },
];
const noticesLink = 'https://github.com/rjk6831/crewkite/blob/main/docs/credits.md';

function About({ onClose, preview }: { onClose: () => void; preview: boolean }) {
  return (
    <Dialog title="About CrewKite" eyebrow="LOCAL CODING WORKSPACE" onClose={onClose}>
      <div className="about-content">
        <div className="about-attribution">
          <strong>CrewKite by Roots No Limits LLC</strong>
          <span>Soar to new heights with CrewKite.</span>
          <span>Created by Raymond J. Kraft</span>
        </div>
        <p>
          CrewKite runs coding threads against Anthropic, OpenAI, Google and Local models. Each
          thread works in a scratch copy of your project, and edits reach your repository only when
          you accept them from the Changes tab.
        </p>
        {preview && (
          <div className="about-build">
            <span>Preview data with scripted replies</span>
          </div>
        )}
        <h3>Credits</h3>
        <p className="muted">
          These projects influenced the design. No runtime code from them is included.{' '}
          <ExternalLink href={noticesLink}>Notices and license texts</ExternalLink>
        </p>
        <div className="credit-sources">
          {credits.map((credit) => (
            <section key={credit.name}>
              <div>
                <h4>{credit.name}</h4>
                <ExternalLink href={`https://github.com/${credit.repository}/tree/${credit.pin}`}>
                  {credit.repository}
                  <ArrowUpRight size={12} />
                </ExternalLink>
              </div>
              <p>{credit.description}</p>
              <code>Source revision {short(credit.pin)}</code>
            </section>
          ))}
        </div>
        <div className="about-license">
          <span>Roots No Limits LLC</span>
          <span>Apache License 2.0 · Copyright 2026 Raymond J. Kraft</span>
        </div>
      </div>
    </Dialog>
  );
}

// The task read for a new thread usually lands within a second. A skeleton holds the space, and
// Try again shows only when ten seconds pass without it.
function OpeningSnapshot({ onRetry }: { onRetry: () => void }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), 10_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="loading-workspace" role="status">
      <OpeningThread />
      {late && (
        <button type="button" className="button secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
