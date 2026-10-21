import type { Event, Snapshot, Task, TaskActivityOutputPage } from '@crewkite/contracts';
import { Activity, ArrowRight, Circle, GitBranch, ShieldCheck, Terminal } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { effectTarget, familyClass, short, titleCase } from './components.tsx';
import { OutputView } from './output-view.tsx';
import type { Workspace } from './source.ts';

type ActivityEntry = Event | Exclude<TaskActivityOutputPage['entries'][number], { kind: 'event' }>;

function useActivityHistory(taskId: Task['id'], workspace: Workspace) {
  const { readTaskActivity, activityRevision, events: live } = workspace;
  const section = useRef<HTMLElement>(null);
  const anchor = useRef<{ row: HTMLElement; top: number; panel: HTMLElement } | null>(null);
  const [events, setEvents] = useState<ActivityEntry[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const headCursor = useRef<string | null>(null);
  const currentCursor = useRef<string | undefined>(undefined);
  const newer = useRef<Array<string | undefined>>([]);
  const [newerCount, setNewerCount] = useState(0);
  const [headChanged, setHeadChanged] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type Direction = 'head' | 'older' | 'newer';
  const failed = useRef<{ cursor: string | undefined; direction: Direction } | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const refreshPending = useRef<number | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const rememberAnchor = useCallback(() => {
    if (anchor.current) return;
    const panel = section.current?.closest<HTMLElement>('.task-panel');
    if (!panel) return;
    const bounds = panel.getBoundingClientRect();
    const rows = section.current?.querySelectorAll<HTMLElement>('[data-activity-id]') ?? [];
    const row = [...rows].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    if (row) anchor.current = { row, top: row.getBoundingClientRect().top, panel };
  }, []);
  useLayoutEffect(() => {
    const saved = anchor.current;
    anchor.current = null;
    if (saved?.row.isConnected)
      saved.panel.scrollTop += saved.row.getBoundingClientRect().top - saved.top;
  });
  const load = useCallback(
    async (cursor?: string, retry = false, direction: Direction = 'head') => {
      if (busy.current) return;
      busy.current = true;
      const token = generation.current;
      const moving = retry ? (failed.current?.direction ?? direction) : direction;
      const requested = retry
        ? failed.current?.cursor
        : moving === 'newer'
          ? newer.current.at(-1)
          : cursor;
      rememberAnchor();
      setLoading(true);
      setError(null);
      try {
        const page = await readTaskActivity({ taskId, beforeCursor: requested, limit: 100 });
        if (generation.current !== token) return;
        rememberAnchor();
        const entries = page.entries.map((entry) => (entry.kind === 'event' ? entry.event : entry));
        if (moving === 'older') newer.current.push(currentCursor.current);
        else if (moving === 'newer') newer.current.pop();
        else newer.current = [];
        if (requested === undefined) {
          headCursor.current = entries.at(-1)?.cursor ?? null;
          setHeadChanged(false);
        }
        currentCursor.current = requested;
        setNewerCount(newer.current.length);
        setBefore(page.nextBeforeCursor);
        // Retain one bounded server page. Return navigation stores only cursors.
        setEvents(entries);
        setLoaded(true);
        failed.current = null;
      } catch (failure) {
        if (generation.current !== token) return;
        rememberAnchor();
        failed.current = { cursor: requested, direction: moving };
        setError(failure instanceof Error ? failure.message : 'Task activity is unavailable.');
      } finally {
        if (generation.current === token) {
          rememberAnchor();
          busy.current = false;
          setLoading(false);
          if (refreshPending.current !== null) {
            refreshPending.current = null;
            setRefreshTick((value) => value + 1);
          }
        }
      }
    },
    [readTaskActivity, taskId, rememberAnchor],
  );
  useEffect(
    () => () => {
      generation.current += 1;
      busy.current = false;
      refreshPending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (busy.current) refreshPending.current = activityRevision + refreshTick;
    else if (currentCursor.current === undefined) void load();
    else {
      rememberAnchor();
      setHeadChanged(true);
    }
  }, [activityRevision, refreshTick, load, rememberAnchor]);
  useEffect(() => {
    if (!loaded) return;
    if (
      !live.some(
        (event) =>
          event.taskId === taskId &&
          !events.some((known) => known.id === event.id) &&
          (headCursor.current === null || BigInt(event.cursor) > BigInt(headCursor.current)),
      )
    )
      return;
    rememberAnchor();
    setHeadChanged(true);
  }, [live, taskId, rememberAnchor, loaded, events]);
  return { events, loading, error, loaded, before, load, section, newerCount, headChanged };
}

const eventNames: Record<Event['type'], string> = {
  'operation.updated': 'Operation status updated',
  'task.created': 'Task created',
  'conversation.entry': 'Conversation entry saved',
  'combined.updated': 'Combined progress updated',
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

export function ActivityView({
  workspace,
  task,
  snapshot,
}: {
  workspace: Workspace;
  task: Task;
  snapshot: Snapshot;
}) {
  const { events, loading, error, loaded, before, load, section, newerCount, headChanged } =
    useActivityHistory(task.id, workspace);
  const tail = useRef<HTMLDivElement>(null);
  const visible = events.filter((event) => 'artifact' in event || event.type !== 'task.updated');
  return (
    <section className="activity-section" ref={section}>
      <div className="section-heading">
        <h2>
          <Activity size={15} />
          Activity
        </h2>
        <span>{visible.length} events on this page</span>
      </div>
      {headChanged && (
        <p role="status">New activity is available. Read the latest page when ready.</p>
      )}
      {newerCount > 0 && (
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => void load(undefined, false, 'newer')}
        >
          Load newer activity
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading activity...</p>}
      {error ? (
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => load(undefined, true)}
        >
          Retry activity
        </button>
      ) : before !== null ? (
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => load(before, false, 'older')}
        >
          Load older activity
        </button>
      ) : loaded ? (
        <p>{events.length === 0 ? 'No retained activity.' : 'Beginning of task activity.'}</p>
      ) : null}
      {visible.length > 0 && (
        <div className="timeline">
          {visible.map((event) => {
            if ('artifact' in event)
              return (
                <article className="timeline-row" key={event.id} data-activity-id={event.id}>
                  <div className="timeline-content">
                    <strong>{event.type} · retained output</strong>
                    <p className="muted small">
                      Event {event.id} · cursor {event.cursor} · {event.at}
                    </p>
                    <OutputView
                      key={event.artifact.hash}
                      artifact={event.artifact}
                      workspace={workspace}
                    />
                  </div>
                </article>
              );
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
                data-activity-id={event.id}
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
      {(visible.length > 6 || newerCount > 0 || headChanged) && (
        <button
          type="button"
          className="text-button jump-latest"
          onClick={() => {
            if (newerCount > 0 || headChanged) void load();
            else tail.current?.scrollIntoView({ block: 'end' });
          }}
        >
          Jump to latest
          <ArrowRight size={13} />
        </button>
      )}
    </section>
  );
}
