import { Folder, SquarePen } from 'lucide-react';
import type { ReactNode } from 'react';

export function Empty({
  icon,
  title,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

/**
 * The center of the workspace when no thread is open. The action is the next step: add a project
 * first, then start a thread. A project that has threads but has not loaded one yet shows a status.
 */
export function WorkspaceEmpty({
  projects,
  canAddProject,
  busy,
  onAddProject,
  onNewThread,
}: {
  projects: readonly { taskCount: number }[];
  canAddProject: boolean;
  busy: boolean;
  onAddProject: () => void;
  onNewThread: () => void;
}) {
  if (projects.length === 0)
    return (
      <div className="loading-workspace">
        <Empty
          icon={<Folder />}
          title="No project yet"
          action={
            canAddProject && (
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={onAddProject}
              >
                Add project
              </button>
            )
          }
        >
          Add a Git repository to start a thread.
        </Empty>
      </div>
    );
  if (projects.every(({ taskCount }) => taskCount === 0))
    return (
      <div className="loading-workspace">
        <Empty
          icon={<SquarePen />}
          title="No threads yet"
          action={
            <button type="button" className="button primary" onClick={onNewThread}>
              <SquarePen size={14} aria-hidden="true" />
              New thread
            </button>
          }
        >
          Start a thread to ask about a project or describe a change.
        </Empty>
      </div>
    );
  return (
    <div className="loading-workspace" role="status">
      <p>Opening thread.</p>
    </div>
  );
}
