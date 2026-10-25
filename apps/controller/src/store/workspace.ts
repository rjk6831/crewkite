import {
  type ChatThreadActivity,
  type ChatTurnState,
  MAX_WORKSPACE_PAGE_BYTES,
  type ProjectPageRequest,
  ProjectPageRequestSchema,
  ProjectPageSchema,
  type TaskPageRequest,
  TaskPageRequestSchema,
  TaskPageSchema,
  type TaskSummary,
  type WorkspaceContinuation,
  type WorkspaceStamp,
} from '@crewkite/contracts';
import { hashCanonical } from '@crewkite/contracts/hash';
import type { Store } from './index.ts';

/**
 * The rail state of a thread comes from its newest turn. A failed turn stays failed until another
 * turn starts. The turn index makes this one lookup per summary, and the turn row is durable, so
 * the state survives a restart. The desktop folds chat.turn events with the same rule in
 * turnActivity, apps/desktop/src/renderer/rail-activity.ts; change both together.
 */
function chatActivity(state: ChatTurnState | null): ChatThreadActivity {
  if (state === 'queued' || state === 'running') return 'running';
  if (state === 'waiting-permission') return 'waiting';
  return state === 'failed' ? 'failed' : 'idle';
}
const same = (left: WorkspaceStamp, right: WorkspaceStamp) =>
  left.epoch === right.epoch && left.revision === right.revision;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function validate(
  store: Store,
  stamp: WorkspaceStamp,
  after: WorkspaceContinuation | undefined,
  section: 'projects' | 'tasks',
  selectionHash: string,
  search: boolean,
) {
  if (!same(stamp, store.workspaceStamp())) throw Error('workspace-page-stale');
  if (
    after &&
    (!same(after.stamp, stamp) ||
      after.section !== section ||
      after.selectionHash !== selectionHash ||
      (section === 'tasks' &&
        (search !== (after.searchRank !== undefined) || (!search && after.afterId === null))))
  )
    throw Error('workspace-page-invalid');
}

export function projectPage(store: Store, input: ProjectPageRequest) {
  const request = ProjectPageRequestSchema.parse(input);
  const { stamp, after, limit, projectId } = request;
  const selectionHash = hashCanonical({ projectId: projectId ?? null });
  validate(store, stamp, after, 'projects', selectionHash, false);
  const page = {
    kind: 'project-page' as const,
    version: 1 as const,
    stamp,
    cursor: store.cursor(),
    projects: [] as { id: string; name: string; revision: number; taskCount: number }[],
    next: null as WorkspaceContinuation | null,
    complete: true,
  };
  const rows = store.db
    .prepare(`SELECT p.id,json_extract(p.body,'$.name') AS name,p.revision,
    (SELECT count(*) FROM entities t WHERE t.kind='task' AND json_extract(t.body,'$.projectId')=p.id) AS taskCount
    FROM entities p WHERE p.kind='project' AND p.id>? ${projectId ? 'AND p.id=?' : ''}
    ORDER BY p.id LIMIT ?`)
    .iterate(...[after?.afterId ?? '', ...(projectId ? [projectId] : []), limit + 1]);
  for (const row of rows) {
    const project = {
      id: row.id as string,
      name: row.name as string,
      revision: row.revision as number,
      taskCount: row.taskCount as number,
    };
    const continuation: WorkspaceContinuation = {
      version: 1,
      stamp,
      section: 'projects',
      selectionHash,
      afterId: page.projects.at(-1)?.id ?? project.id,
    };
    if (
      page.projects.length === limit ||
      bytes({
        ...page,
        projects: [...page.projects, project],
        next: continuation,
        complete: false,
      }) > MAX_WORKSPACE_PAGE_BYTES
    ) {
      if (!page.projects.length) throw Error('workspace-row-too-large');
      page.next = continuation;
      page.complete = false;
      break;
    }
    page.projects.push(project);
  }
  validate(store, stamp, undefined, 'projects', selectionHash, false);
  return ProjectPageSchema.parse(page);
}

export function taskPage(store: Store, input: TaskPageRequest, now = () => performance.now()) {
  const { stamp, after, limit, projectId, taskId, query } = TaskPageRequestSchema.parse(input);
  const normalized = query?.trim() ?? '';
  const selectionHash = hashCanonical({
    projectId: projectId ?? null,
    taskId: taskId ?? null,
    query: normalized,
  });
  validate(store, stamp, after, 'tasks', selectionHash, !!normalized);
  if (projectId && taskId) {
    const task = store.db
      .prepare(
        "SELECT json_extract(body,'$.projectId') AS projectId FROM entities WHERE kind='task' AND id=?",
      )
      .get(taskId);
    if (task && task.projectId !== projectId) throw Error('workspace-page-invalid');
  }
  const page = {
    kind: 'task-page' as const,
    version: 1 as const,
    stamp,
    cursor: store.cursor(),
    tasks: [] as TaskSummary[],
    next: null as WorkspaceContinuation | null,
    complete: true,
    scanned: 0,
  };
  const pattern = normalized
    ? new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
    : null;
  const started = now();
  let rank = after?.searchRank ?? 0;
  let position = after?.afterId ?? '';
  const continuation = (): WorkspaceContinuation => ({
    version: 1,
    stamp,
    section: 'tasks',
    selectionHash,
    afterId: position || null,
    ...(pattern ? { searchRank: rank } : {}),
  });
  const finish = () => {
    validate(store, stamp, undefined, 'tasks', selectionHash, !!pattern);
    page.next = continuation();
    page.complete = false;
    return TaskPageSchema.parse(page);
  };
  for (; rank < (pattern ? 4 : 1); rank++, position = '') {
    const rows = store.db
      .prepare(`SELECT t.id,t.revision,
      json_extract(t.body,'$.projectId') AS projectId,json_extract(t.body,'$.title') AS title,
      json_extract(t.body,'$.state') AS state,json_extract(t.body,'$.waitingReason') AS waitingReason,
      json_extract(t.body,'$.runId') AS runId,json_extract(t.body,'$.next') AS next,
      (SELECT json_extract(c.body,'$.state') FROM chat_turns c WHERE c.task_id=t.id
      ORDER BY c.sequence DESC LIMIT 1) AS turnState
      ${pattern ? ",json_extract(t.body,'$.outcome') AS outcome,json_extract(t.body,'$.criteria') AS criteria,json_extract(p.body,'$.name') AS projectName" : ''}
      FROM entities t ${pattern ? "LEFT JOIN entities p ON p.kind='project' AND p.id=json_extract(t.body,'$.projectId')" : ''}
      WHERE t.kind='task' AND t.id>? ${projectId ? "AND json_extract(t.body,'$.projectId')=?" : ''}
      ${taskId ? 'AND t.id=?' : ''} ORDER BY t.id LIMIT ?`)
      .iterate(
        position,
        ...(projectId ? [projectId] : []),
        ...(taskId ? [taskId] : []),
        pattern ? 201 : limit + 1,
      );
    for (const row of rows) {
      if (
        page.tasks.length === limit ||
        (pattern && page.scanned > 0 && (page.scanned >= 200 || now() - started >= 8))
      )
        return finish();
      page.scanned++;
      let match: TaskSummary['match'];
      if (pattern) {
        const fields: {
          rank: number;
          field: NonNullable<TaskSummary['match']>['field'];
          text: string;
        }[] = [
          { rank: 0, field: 'title', text: row.title as string },
          { rank: 1, field: 'project', text: (row.projectName as string) ?? '' },
          { rank: 2, field: 'outcome', text: row.outcome as string },
          ...JSON.parse(row.criteria as string).map((text: string) => ({
            rank: 2,
            field: 'criterion' as const,
            text,
          })),
          { rank: 3, field: 'task-id', text: row.id as string },
          { rank: 3, field: 'project-id', text: row.projectId as string },
        ];
        const found = fields.find((field) => pattern.test(field.text));
        if (!found || found.rank !== rank) {
          position = row.id as string;
          continue;
        }
        match = { field: found.field, text: found.text };
      }
      const task: TaskSummary = {
        id: row.id as string,
        projectId: row.projectId as string,
        title: row.title as string,
        state: row.state as TaskSummary['state'],
        waitingReason: row.waitingReason as TaskSummary['waitingReason'],
        revision: row.revision as number,
        runId: row.runId as string | null,
        next: row.next as string | null,
        chatActivity: chatActivity(row.turnState as ChatTurnState | null),
        ...(match ? { match } : {}),
      };
      if (
        bytes({
          ...page,
          tasks: [...page.tasks, task],
          next: { ...continuation(), afterId: task.id },
          complete: false,
        }) > MAX_WORKSPACE_PAGE_BYTES
      ) {
        if (!page.tasks.length) throw Error('workspace-row-too-large');
        return finish();
      }
      page.tasks.push(task);
      position = task.id;
    }
  }
  validate(store, stamp, undefined, 'tasks', selectionHash, !!pattern);
  return TaskPageSchema.parse(page);
}
