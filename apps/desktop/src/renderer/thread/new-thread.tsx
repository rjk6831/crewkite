import { type Task, TaskSchema } from '@crewkite/contracts';
import { Folder } from 'lucide-react';
import { useRef } from 'react';
import type { DesktopCommand } from '../source.ts';
import { sendMessage, type ThreadSource } from './commands.ts';
import { Composer, type ComposerHandle, type SendInput } from './composer.tsx';
import { EmptyThread } from './empty-thread.tsx';
import './thread.css';

type Project = { id: string; name: string };

// The first message creates the thread. The task needs an outcome and one criterion, so the message
// is the outcome and the criterion says what is being asked.
function taskPayload(projectId: string, text: string) {
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
  blocked,
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
  blocked: string | null;
}) {
  // A send that fails after the task exists keeps the task, so a retry does not create a second one.
  const created = useRef<Task | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const project = projects.find(({ id }) => id === projectId);

  async function send({ text, attachments, selection }: SendInput) {
    if (!project) throw new Error('Choose a project first.');
    if (!created.current) {
      const result = await createTask({
        command: 'CreateTask',
        expectedRevision: 0,
        payload: taskPayload(project.id, text),
      } as DesktopCommand);
      const saved = TaskSchema.safeParse(result.entity);
      if ((result.outcome !== 'applied' && result.outcome !== 'already-applied') || !saved.success)
        throw new Error(result.next ?? result.reason ?? 'The thread could not be created.');
      created.current = saved.data;
    }
    await sendMessage(source, {
      taskId: created.current.id,
      text,
      attachments,
      ...(selection ? { selection } : {}),
    });
    onCreated(created.current.id);
  }

  return (
    <div className="thread">
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
        </header>
        <div className="th-scroll-frame">
          <div className="th-blank">
            {project ? (
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
          thread={null}
          running={false}
          context={null}
          currentFamily={null}
          blocked={blocked ?? (project ? null : 'Add a project to send a message.')}
          notice={null}
          onSend={send}
          onStop={async () => {}}
          onConfigured={() => {}}
          onHandoff={async () => {}}
        />
      </section>
    </div>
  );
}
