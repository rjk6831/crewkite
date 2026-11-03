// The thread open at quit opens again at launch. The record lives in this window's profile, which
// belongs to one controller home. It keeps the project ID so a record from another home, or a
// project since removed, never matches and the rail falls back to its first thread.
export type LastThread = { projectId: string; taskId: string };
type Page = { tasks: readonly { id: string }[] };

export function parseLastThread(saved: string | null): LastThread | null {
  if (!saved) return null;
  try {
    const value: unknown = JSON.parse(saved);
    if (typeof value !== 'object' || value === null) return null;
    const { projectId, taskId } = value as Record<string, unknown>;
    return typeof projectId === 'string' && typeof taskId === 'string'
      ? { projectId, taskId }
      : null;
  } catch {
    return null;
  }
}

export type Opening =
  | { kind: 'select'; taskId: string }
  | { kind: 'load'; projectId: string }
  | { kind: 'none' };

// `unreadable` is true once a page read failed, so a page that will not arrive stops the wait.
export function openingThread(input: {
  last: LastThread | null;
  projectIds: readonly string[];
  pages: Readonly<Record<string, Page>>;
  removed: ReadonlySet<string>;
  unreadable: boolean;
}): Opening {
  const { last, pages, removed } = input;
  if (last && input.projectIds.includes(last.projectId) && !removed.has(last.taskId)) {
    const page = pages[last.projectId];
    if (!page && !input.unreadable) return { kind: 'load', projectId: last.projectId };
    if (page?.tasks.some(({ id }) => id === last.taskId))
      return { kind: 'select', taskId: last.taskId };
  }
  const first = Object.values(pages)
    .flatMap((page) => page.tasks)
    .find(({ id }) => !removed.has(id));
  return first ? { kind: 'select', taskId: first.id } : { kind: 'none' };
}
