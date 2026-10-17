import type {
  Approval,
  Event,
  Role,
  Run,
  Snapshot,
  Task,
  Window as UsageWindow,
} from '@crewkite/contracts';
import { ProjectSchema, requiredReviewMethodIds } from '@crewkite/contracts';
import { createDemoFixtures } from '@crewkite/testkit';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle,
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
import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import wordmark from './assets/crewkite-wordmark.png';
import inverseWordmark from './assets/crewkite-wordmark-inverse.png';
import {
  actionName,
  Dialog,
  duration,
  effectTarget,
  Fact,
  familyClass,
  familyName,
  methodName,
  moveTabFocus,
  RouterCard,
  SourceFacts,
  short,
  titleCase,
} from './components.tsx';
import { Launch, NativeEvaluation, NativeHandoff } from './launch.tsx';
import { useWorkspace, type Workspace } from './source.ts';
import { roleLabels } from './templates.ts';

const tabs = ['Activity', 'Plan', 'Changes', 'Checks and review', 'Handoffs'] as const;
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

export function App() {
  const workspace = useWorkspace();
  const { snapshot, connection, preview, error } = workspace;
  const [page, setPage] = useState<'tasks' | 'usage'>('tasks');
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('Activity');
  const [roster, setRoster] = useState(true);
  const [theme, setTheme] = useState(() => localStorage.getItem('crewkite-theme') ?? 'dark');
  const [create, setCreate] = useState(false);
  const [launch, setLaunch] = useState(false);
  const [nativeHandoff, setNativeHandoff] = useState(false);
  const [palette, setPalette] = useState(false);
  const [palettePage, setPalettePage] = useState(0);
  const [approvalToReview, setApprovalToReview] = useState<string | null>(null);
  const approvalCard = useRef<HTMLElement>(null);
  const [about, setAbout] = useState(false);
  const task = snapshot?.tasks.find(({ id }) => id === selected) ?? snapshot?.tasks[0];
  const run = snapshot?.runs.find(({ id }) => id === task?.runId);
  const nativeRun = snapshot?.nativeRuns.find((value) => value.runId === task?.runId);
  const approval = snapshot?.approvals.find(
    (value) => value.taskId === task?.id && value.status === 'pending',
  );
  const taskEvents = workspace.events.filter((event) => event.taskId === task?.id);
  const taskCount = snapshot?.tasks.length ?? 0;
  const taskPage = Math.min(palettePage, Math.max(0, Math.ceil(taskCount / 5) - 1));
  const taskOffset = taskPage * 5;
  useEffect(() => {
    if (palette || !approvalToReview) return;
    if (page === 'tasks' && tab === 'Activity' && approval?.approvalId === approvalToReview)
      approvalCard.current?.focus();
    setApprovalToReview(null);
  }, [palette, page, tab, approval?.approvalId, approvalToReview]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('crewkite-theme', theme);
  }, [theme]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  function stop() {
    if (task?.runId)
      void workspace
        .command({
          command: 'StopRun',
          expectedRevision: task.revision,
          payload: { taskId: task.id, runId: task.runId },
        })
        .catch(() => {});
  }
  const stopAllowed =
    task?.runId &&
    (nativeRun
      ? nativeRun.stage === 'prepared' ||
        !!nativeRun.handoff?.pending ||
        ['running', 'checking', 'unknown'].includes(task.state)
      : !['draft', 'ready', 'accepted', 'failed'].includes(task.state));
  return (
    <div className="app-shell">
      <aside className="navigation" aria-label="Workspace navigation">
        <button
          type="button"
          className="brand"
          onClick={() => setAbout(true)}
          aria-label="About CrewKite"
        >
          <img
            className="brand-wordmark"
            src={theme === 'light' ? wordmark : inverseWordmark}
            alt="CrewKite"
            width={1024}
            height={341}
          />
          <span className="prototype-tag">D0</span>
        </button>
        <button type="button" className="search-button" onClick={() => setPalette(true)}>
          <Search size={14} />
          <span>Find or run a command</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-label">
          WORKSPACE
          <button
            type="button"
            className="icon-button"
            onClick={() => setCreate(true)}
            aria-label="New task"
          >
            <Plus size={15} />
          </button>
        </div>
        {snapshot?.projects.map((project) => (
          <div key={project.id} className="project-group">
            <div className="project-name">
              <ChevronRight size={12} className="expanded" />
              <Folder size={15} />
              <span>{project.name}</span>
              <span className="count">
                {snapshot.tasks.filter((value) => value.projectId === project.id).length}
              </span>
            </div>
            {snapshot.tasks
              .filter((value) => value.projectId === project.id)
              .map((value) => (
                <button
                  type="button"
                  key={value.id}
                  className={`task-link ${page === 'tasks' && task?.id === value.id ? 'active' : ''}`}
                  onClick={() => {
                    setSelected(value.id);
                    setPage('tasks');
                  }}
                >
                  <span className={`status-dot state-${value.state}`} />
                  <span>{value.title}</span>
                  {value.state === 'waiting' && <span className="notification-dot" />}
                </button>
              ))}
            {!snapshot.tasks.some((value) => value.projectId === project.id) && (
              <p className="nav-empty">No tasks yet</p>
            )}
          </div>
        ))}
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
          onClick={() => setCreate(true)}
          disabled={!snapshot}
        >
          <Plus size={14} />
          New task
        </button>
        <div className="nav-bottom">
          <button
            type="button"
            className={`nav-item ${page === 'usage' ? 'active' : ''}`}
            onClick={() => setPage('usage')}
          >
            <Gauge size={16} />
            Usage and capacity
            <ChevronRight size={13} />
          </button>
          <button type="button" className="nav-item" onClick={() => setAbout(true)}>
            <Info size={16} />
            About and acknowledgments
          </button>
          <div className="connection-line">
            <span className={`connection-dot ${connection}`} />
            <span>
              {preview
                ? 'Preview data'
                : connection === 'connected'
                  ? 'Controller connected'
                  : titleCase(connection)}
            </span>
            {!preview && connection !== 'connected' && (
              <button
                type="button"
                className="icon-button"
                onClick={() => void workspace.reconnect()}
                disabled={workspace.pending || connection === 'connecting'}
                aria-label="Reconnect controller"
              >
                <RefreshCw size={15} />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
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
            <span>
              {snapshot?.projects.find(({ id }) => id === task?.projectId)?.name ?? 'Workspace'}
            </span>
            <ChevronRight size={12} />
            <span>{page === 'usage' ? 'Usage and capacity' : 'Tasks'}</span>
          </div>
          <div className="topbar-actions">
            <span className="demo-label">
              <span />
              {preview
                ? 'Interface preview'
                : snapshot?.routes.every(({ fake }) => fake)
                  ? 'Scripted providers'
                  : 'Connected routes'}
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
              onClick={() => void workspace.retryCommand().catch(() => {})}
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
              onClick={() => workspace.setError(null)}
              aria-label="Dismiss error"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {!snapshot ? (
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
          <Usage snapshot={snapshot} run={run} />
        ) : (
          <div className={`task-layout ${roster ? '' : 'roster-hidden'}`}>
            <main className="task-main">
              {task ? (
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
                          <strong>{task.next ?? 'Inspect the retained task state.'}</strong>
                        </span>
                      </div>
                      <div className="button-row">
                        {task.state === 'draft' && (
                          <button
                            type="button"
                            className="button primary"
                            onClick={() => setLaunch(true)}
                            disabled={workspace.pending}
                          >
                            {nativeRun?.stage === 'prepared'
                              ? 'Review prepared proposal'
                              : 'Prepare run'}
                            <ArrowRight size={14} />
                          </button>
                        )}
                        {task.runId &&
                          !nativeRun &&
                          ['interrupted', 'stopped'].includes(task.state) && (
                            <button
                              type="button"
                              className="button primary"
                              disabled={workspace.pending}
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
                        {nativeRun?.handoff && nativeRun.stage !== 'prepared' && (
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
                          disabled={!stopAllowed || workspace.pending || task.state === 'stopping'}
                          onClick={stop}
                        >
                          <Square size={12} />
                          {task.state === 'unknown' ? 'Retry stop' : 'Stop'}
                        </button>
                      </div>
                    </div>
                    {run &&
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
                  >
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
                        <ActivityView events={taskEvents} task={task} snapshot={snapshot} />
                      </>
                    )}
                    {tab === 'Plan' && (
                      <Plan
                        task={task}
                        run={run}
                        snapshot={snapshot}
                        onPrepare={() => setLaunch(true)}
                      />
                    )}
                    {tab === 'Changes' && <Changes task={task} workspace={workspace} />}
                    {tab === 'Checks and review' && (
                      <Checks task={task} snapshot={snapshot} workspace={workspace} />
                    )}
                    {tab === 'Handoffs' && <Handoffs events={taskEvents} snapshot={snapshot} />}
                  </div>
                </>
              ) : (
                <Empty icon={<Folder />} title="Start with one useful task">
                  Create a bounded outcome and its acceptance criteria. Review the source and
                  routing decision before starting.
                  <button type="button" className="button primary" onClick={() => setCreate(true)}>
                    <Plus size={14} />
                    Create task
                  </button>
                </Empty>
              )}
            </main>
            {roster && (
              <Roster
                snapshot={snapshot}
                run={run}
                task={task}
                onConfigure={() => setLaunch(true)}
              />
            )}
          </div>
        )}
        <footer className="statusbar">
          <span>
            <ShieldCheck size={12} />
            Local workspace<span className="footer-separator">/</span>
            {snapshot?.routes.every(({ fake }) => fake)
              ? 'All routes are fake'
              : 'Route state from controller'}
          </span>
          <span>
            Authority stays in the controller<kbd>⌘ K</kbd>
          </span>
        </footer>
      </div>
      {create && snapshot && (
        <CreateTask
          workspace={workspace}
          snapshot={snapshot}
          onClose={() => setCreate(false)}
          onCreated={(id) => {
            setSelected(id);
            setPage('tasks');
            setCreate(false);
            setLaunch(true);
          }}
        />
      )}
      {launch && task && snapshot && (
        <Launch
          task={task}
          snapshot={snapshot}
          workspace={workspace}
          onClose={() => setLaunch(false)}
        />
      )}
      {nativeHandoff && task && snapshot && nativeRun?.handoff && (
        <NativeHandoff
          key={`${task.runId}:${task.revision}:${nativeRun.handoff.currentAttemptId}:${nativeRun.handoff.pending?.preparationId ?? ''}`}
          task={task}
          snapshot={snapshot}
          workspace={workspace}
          onClose={() => setNativeHandoff(false)}
        />
      )}
      {about && <About onClose={() => setAbout(false)} />}
      {palette && (
        <Dialog title="Run a command" onClose={() => setPalette(false)}>
          <div className="command-list">
            {[
              { label: 'New task', icon: <Plus size={17} />, action: () => setCreate(true) },
              {
                label: 'Open usage and capacity',
                icon: <Gauge size={17} />,
                action: () => setPage('usage'),
              },
              {
                label: 'Show task activity',
                icon: <Activity size={17} />,
                action: () => {
                  setPage('tasks');
                  setTab('Activity');
                },
              },
              {
                label: 'Review pending approval',
                icon: <ShieldCheck size={17} />,
                disabled: !approval,
                action: () => {
                  if (!approval) return;
                  setPage('tasks');
                  setTab('Activity');
                  setApprovalToReview(approval.approvalId);
                },
              },
              {
                label: 'Stop current run',
                icon: <Square size={15} />,
                action: stop,
                disabled: !stopAllowed,
              },
              {
                label: 'About and acknowledgments',
                icon: <Info size={17} />,
                action: () => setAbout(true),
              },
            ].map(({ label, icon, action, disabled }) => (
              <button
                type="button"
                key={label}
                disabled={disabled}
                onClick={() => {
                  setPalette(false);
                  action();
                }}
              >
                {icon}
                {label}
                <ArrowRight size={14} />
              </button>
            ))}
            {taskCount > 0 && (
              <>
                <p className="muted small">
                  Tasks {taskOffset + 1}-{Math.min(taskOffset + 5, taskCount)} of {taskCount}
                </p>
                {snapshot?.tasks.slice(taskOffset, taskOffset + 5).map((value) => (
                  <button
                    type="button"
                    key={value.id}
                    onClick={() => {
                      setSelected(value.id);
                      setPage('tasks');
                      setTab('Activity');
                      setPalette(false);
                    }}
                  >
                    <FileCode size={17} />
                    Open task: {value.title} ·{' '}
                    {snapshot.projects.find(({ id }) => id === value.projectId)?.name ??
                      value.projectId}{' '}
                    · {value.id.slice(-6)}
                    <ArrowRight size={14} />
                  </button>
                ))}
                {taskCount > 5 && (
                  <div className="button-row">
                    <button
                      type="button"
                      disabled={taskPage === 0}
                      onClick={() => setPalettePage(taskPage - 1)}
                    >
                      Previous tasks
                    </button>
                    <button
                      type="button"
                      disabled={taskOffset + 5 >= taskCount}
                      onClick={() => setPalettePage(taskPage + 1)}
                    >
                      Next tasks
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
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

const eventNames: Record<Event['type'], string> = {
  'task.created': 'Task created',
  'task.updated': 'Task state updated',
  'run.prepared': 'Run prepared',
  'run.admitted': 'Run admitted',
  'attempt.launched': 'Worker started',
  'attempt.output': 'Worker output',
  'approval.requested': 'Approval requested',
  'approval.resolved': 'Approval resolved',
  'usage.observed': 'Usage observation received',
  'route.reserve_reached': 'Reserve reached',
  'admissions.paused': 'New admissions paused',
  'handoff.sealed': 'Handoff packet sealed',
  'attempt.stopping': 'Worker stopping',
  'attempt.stopped': 'Worker stopped',
  'ownership.unknown': 'Writer ownership unknown',
  'run.interrupted': 'Run interrupted',
  'candidate.sealed': 'Candidate sealed',
  'check.completed': 'Check completed',
  'review.completed': 'Review recorded',
  'candidate.accepted': 'Candidate accepted',
  'export.created': 'Export created',
  'run.failed': 'Run failed',
};

function ActivityView({
  events,
  task,
  snapshot,
}: {
  events: Event[];
  task: Task;
  snapshot: Snapshot;
}) {
  const tail = useRef<HTMLDivElement>(null);
  const visible = events.filter(({ type }) => type !== 'task.updated');
  return (
    <section className="activity-section">
      <div className="section-heading">
        <h2>
          <Activity size={15} />
          Activity
        </h2>
        <span>{visible.length} events received</span>
      </div>
      {visible.length === 0 ? (
        <Empty
          icon={<Terminal size={24} />}
          title={task.state === 'draft' ? 'Ready when you are' : 'Retained task state is available'}
        >
          {task.state === 'draft'
            ? 'Prepare a run to inspect the source, team and routing decision. Worker events will appear here.'
            : 'New events appear while this client is connected. Inspect the other views for retained state.'}
        </Empty>
      ) : (
        <div className="timeline">
          {visible.map((event) => {
            const routeId = 'routeId' in event.payload ? event.payload.routeId : null;
            const provider = snapshot.routes.find(({ id }) => id === routeId);
            const output = event.type === 'attempt.output' ? event.payload.text : null;
            const reason =
              'reason' in event.payload && typeof event.payload.reason === 'string'
                ? event.payload.reason
                : null;
            const outcome =
              event.type === 'check.completed' || event.type === 'review.completed'
                ? (event.payload.review?.outcome ??
                  (event.payload.passed ? 'passed' : 'not passed'))
                : null;
            const tone =
              outcome === 'passed' || event.type === 'candidate.accepted'
                ? 'success'
                : outcome === 'failed' || outcome === 'not passed' || event.type === 'run.failed'
                  ? 'failure'
                  : outcome === 'blocked' ||
                      event.type === 'approval.requested' ||
                      event.type === 'ownership.unknown' ||
                      event.type === 'run.interrupted' ||
                      event.type === 'route.reserve_reached' ||
                      event.type === 'admissions.paused'
                    ? 'warning'
                    : 'neutral';
            return (
              <article
                className={`timeline-row timeline-${tone} event-${event.type.replaceAll('.', '-')}`}
                key={event.id}
              >
                <div className="timeline-marker" aria-hidden="true">
                  {event.type === 'handoff.sealed' ? (
                    <GitBranch size={13} />
                  ) : event.type === 'approval.requested' ? (
                    <ShieldCheck size={13} />
                  ) : event.type === 'attempt.output' ? (
                    <Terminal size={12} />
                  ) : (
                    <Circle size={8} />
                  )}
                </div>
                <div className="timeline-content">
                  <div className="timeline-title">
                    <strong>
                      {eventNames[event.type]}
                      {outcome && ` · ${titleCase(outcome)}`}
                    </strong>
                    {provider && (
                      <span className={`provider-label ${familyClass(provider.family)}`}>
                        {provider.family}
                      </span>
                    )}
                    <time>
                      {new Date(event.at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}
                    </time>
                  </div>
                  {reason && <p>{reason}</p>}
                  {output && <pre className="worker-output">{output}</pre>}
                  {event.type === 'handoff.sealed' && (
                    <div className="inline-packet">
                      <GitBranch size={15} />
                      <span>
                        Version {event.payload.packet.version} ·{' '}
                        {event.payload.packet.unfinished.length} unfinished item(s)
                        <small>Checksum {short(event.payload.checksum)}</small>
                      </span>
                      <ShieldCheck size={15} />
                    </div>
                  )}
                  {event.type === 'approval.resolved' && (
                    <p>
                      {titleCase(event.payload.status)}:{' '}
                      {effectTarget(
                        event.payload,
                        task,
                        snapshot.projects.find(({ id }) => id === task.projectId)?.name,
                      )}
                    </p>
                  )}
                </div>
              </article>
            );
          })}
          <div ref={tail} />
        </div>
      )}
      {visible.length > 6 && (
        <button
          type="button"
          className="text-button jump-latest"
          onClick={() => tail.current?.scrollIntoView({ block: 'end' })}
        >
          Jump to latest
          <ArrowRight size={13} />
        </button>
      )}
    </section>
  );
}

function Plan({
  task,
  run,
  snapshot,
  onPrepare,
}: {
  task: Task;
  run?: Run;
  snapshot: Snapshot;
  onPrepare: () => void;
}) {
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
                  value={`${(profile?.maximumTaskMs ?? 300000) / 60000} min`}
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
  useEffect(() => {
    let active = true;
    setLoading(true);
    void workspace
      .command({ command: 'GetChanges', payload: { taskId: task.id } })
      .then((result) => {
        if (active && result.data?.kind === 'changes') {
          setChanges(result.data);
          setSelected(result.data.files[0]?.path ?? null);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [task.id, workspace.command]);
  if (loading)
    return (
      <Empty icon={<RefreshCw className="spin" />} title="Reading retained changes">
        The controller is materializing the immutable preview.
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
  const candidate = snapshot.candidates.filter(({ taskId }) => taskId === task.id).at(-1);
  const evidence = snapshot.evidence.filter(({ candidateId }) => candidateId === candidate?.id);
  const [destination, setDestination] = useState('refs/heads/feat/net-minor');
  const native = snapshot.nativeRuns.some((value) => value.runId === task.runId);
  const evaluation = snapshot.candidateEvaluations.find(
    (value) =>
      value.taskId === task.id &&
      value.runId === task.runId &&
      value.candidateId === candidate?.id &&
      value.candidateHash === candidate.hash,
  );
  const eligible = native
    ? evaluation?.localAcceptance.available
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
                          {result.job.writerRouteId === undefined
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
                        {result.job.writerAttemptId && result.job.writerRouteId && (
                          <details className="technical-details">
                            <summary>Details</summary>
                            <code>Last writer attempt {result.job.writerAttemptId}</code>
                            <code>Last writer route {result.job.writerRouteId}</code>
                          </details>
                        )}
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
              D0 inspects fixed challenge patterns in separate read-only jobs. Its results prove
              bounded job plumbing and carry no model judgment.
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
            {acceptanceReasons[acceptanceReason]}
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

function Usage({ snapshot, run }: { snapshot: Snapshot; run?: Run }) {
  const fixtureTime = Math.max(
    0,
    ...snapshot.usage.map(({ observation }) => Date.parse(observation.observedAt)),
  );
  const now = snapshot.routes.every(({ fake }) => fake) ? fixtureTime : Date.now();
  const cloud = snapshot.routes.filter(({ family }) => family !== 'local');
  const local = snapshot.routes.find(({ family }) => family === 'local');
  return (
    <main className="usage-page">
      <div className="page-heading">
        <p className="eyebrow">WORKSPACE CAPACITY</p>
        <h1>Usage and capacity</h1>
        <p>Allowance stays in the provider's own units. Missing observations stay unknown.</p>
        <span className="fixture-clock">
          <Clock size={13} />
          {snapshot.routes.every(({ fake }) => fake)
            ? `Fixture clock · ${new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
            : 'Controller observations'}
        </span>
      </div>
      <section aria-labelledby="allowance-title">
        <div className="section-heading">
          <h2 id="allowance-title">Route allowances</h2>
          <span>Included subscriptions</span>
        </div>
        <div className="allowance-grid">
          {cloud.map((route) => {
            const windows = snapshot.usage.filter(
              ({ observation }) => observation.routeId === route.id,
            );
            return (
              <section className="allowance-card" key={route.id}>
                <div className="allowance-heading">
                  <span className={`route-symbol ${familyClass(route.family)}`}>
                    {route.family[0].toUpperCase()}
                  </span>
                  <div>
                    <h3>{familyName(route.family)}</h3>
                    <span>{route.model}</span>
                  </div>
                  {route.fake && <span className="fake-tag">Fake</span>}
                </div>
                {windows.length ? (
                  windows.map((window) => (
                    <AllowanceWindow
                      key={window.observation.windowId}
                      window={window}
                      now={now}
                      reserve={
                        run?.policy.policy.reserves.find(
                          (reserve) =>
                            reserve.routeId === route.id &&
                            reserve.windowId === window.observation.windowId,
                        )?.value ?? null
                      }
                    />
                  ))
                ) : (
                  <Empty icon={<Gauge />} title="Unknown">
                    No usage observation has been received.
                  </Empty>
                )}
              </section>
            );
          })}
        </div>
      </section>
      <div className="capacity-grid">
        <section className="card activity-capacity">
          <div className="section-heading">
            <h2>
              <Activity size={15} />
              Controller activity
            </h2>
            <span>This workspace</span>
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
                      snapshot.attempts.filter(
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
            Activity counters describe this controller. They do not measure account-wide usage.
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
          <p className="muted small">No hardware probe is connected in this prototype.</p>
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
                <small>No paid route qualified for this demo</small>
              </div>
              <span className="credit-off">Off</span>
            </div>
          ))}
        </div>
        <p className="muted small">
          A provider limit never enables paid credit use. No billing controls are connected in D0.
        </p>
      </section>
    </main>
  );
}

function AllowanceWindow({
  window,
  now,
  reserve,
}: {
  window: UsageWindow;
  now: number;
  reserve: number | null;
}) {
  const { observation, state } = window;
  const percentage = observation.remaining?.unit === 'percent' ? observation.remaining.value : null;
  const unknown = state === 'unknown' || observation.remaining === null;
  const pending =
    state === 'reset-pending' ||
    (observation.resetsAt !== null && Date.parse(observation.resetsAt) <= now);
  const remaining = unknown
    ? 'Unknown'
    : percentage !== null
      ? `${percentage}%`
      : `${observation.remaining?.value} ${observation.remaining?.unit}`;
  const pattern = `hatch-${observation.routeId}-${observation.windowId}`;
  return (
    <div
      className={`allowance-window ${unknown ? 'is-unknown' : ''} ${pending ? 'is-pending' : ''}`}
    >
      <div className="gauge-wrap">
        <svg
          viewBox="0 0 120 120"
          role="img"
          aria-label={`${observation.windowId} allowance: ${remaining}`}
        >
          <title>
            {observation.windowId} allowance: {remaining}
          </title>
          <defs>
            <pattern
              id={pattern}
              width="5"
              height="5"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="5" stroke="var(--text-dim)" strokeWidth="2" />
            </pattern>
          </defs>
          <circle className="gauge-track" cx="60" cy="60" r="46" fill="none" strokeWidth="9" />
          <circle
            className="gauge-fill"
            cx="60"
            cy="60"
            r="46"
            fill="none"
            stroke={unknown ? `url(#${pattern})` : 'currentColor'}
            strokeWidth="9"
            strokeDasharray={unknown ? undefined : `${((percentage ?? 0) / 100) * 289.03} 289.03`}
            transform="rotate(-90 60 60)"
          />
          {percentage !== null && reserve !== null && (
            <line
              x1="60"
              y1="8"
              x2="60"
              y2="20"
              transform={`rotate(${reserve * 3.6} 60 60)`}
              stroke="var(--surface)"
              strokeWidth="3"
            />
          )}
        </svg>
        <div className="gauge-value">
          <strong className={unknown ? 'unknown-value' : ''}>{remaining}</strong>
          <span>{unknown ? 'No report' : 'remaining'}</span>
        </div>
      </div>
      <div className="window-name">
        <span>{titleCase(observation.windowId)}</span>
        {percentage !== null && (
          <span>{reserve === null ? 'No run reserve' : `${reserve}% reserve`}</span>
        )}
      </div>
      <div className="reset-line">
        <Clock size={13} />
        <span>
          {pending
            ? 'Reset pending confirmation'
            : observation.resetsAt
              ? `Resets in ${duration(Date.parse(observation.resetsAt) - now)}`
              : 'Reset time unknown'}
        </span>
      </div>
      <div className="observation-line">
        <span>Observed {duration(now - Date.parse(observation.observedAt))} ago</span>
        <span>{observation.source}</span>
      </div>
      {state === 'stale' && (
        <p className="window-warning">
          {observation.source === 'fixture'
            ? 'Scripted usage expires after five minutes. It does not refresh automatically. Before preparing a run, choose how unknown usage is handled in Policy.'
            : 'Stale observation. The percentage rule is unavailable until a fresh report arrives.'}
        </p>
      )}
      {unknown && <p className="window-warning">Waiting for a usable observation.</p>}
    </div>
  );
}

function CreateTask({
  workspace,
  snapshot,
  onClose,
  onCreated,
}: {
  workspace: Workspace;
  snapshot: Snapshot;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const template = createDemoFixtures().task;
  const [title, setTitle] = useState(template.title);
  const [outcome, setOutcome] = useState(template.outcome);
  const [criteria, setCriteria] = useState(template.criteria.join('\n'));
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.id ?? '');
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await workspace.command({
        command: 'CreateTask',
        expectedRevision: 0,
        payload: {
          projectId,
          title: title.trim(),
          outcome: outcome.trim(),
          criteria: criteria
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        },
      });
      if (result.entity && 'state' in result.entity) onCreated(result.entity.id);
    } catch {}
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
                .catch(() => {})
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
          Acceptance criteria<span className="field-hint">One concrete claim per line</span>
          <textarea
            rows={5}
            required
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
          />
        </label>
        <div className="dialog-footer">
          <span className="muted small">You review source and permissions before launch.</span>
          <button
            type="submit"
            className="button primary"
            disabled={workspace.pending || !projectId || !title.trim() || !criteria.trim()}
          >
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

function About({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="About CrewKite" eyebrow="LOCAL CODING WORKSPACE" onClose={onClose}>
      <div className="about-content">
        <p>
          One controller owns task state, authority and result identity. The desktop and CLI are
          clients of the same workspace.
        </p>
        <div className="about-build">
          <span className="prototype-tag">D0</span>
          <span>Scripted providers · no live inference qualification</span>
        </div>
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
          Method configuration and any scripted evaluation are disclosed in the launch policy. This
          prototype does not establish that model review jobs ran.
        </p>
        <div className="about-license">
          <span>Apache License 2.0</span>
          <span>Copyright 2026 Raymond J. Kraft</span>
        </div>
      </div>
    </Dialog>
  );
}
