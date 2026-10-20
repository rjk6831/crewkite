import type { Event, Snapshot, Task } from '@crewkite/contracts';
import { Activity, ArrowRight, Circle, GitBranch, ShieldCheck, Terminal } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { effectTarget, familyClass, short, titleCase } from './components.tsx';
import type { Workspace } from './source.ts';

function mergeEvents(current: Event[], incoming: Event[]) {
  const events = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((a, b) =>
    BigInt(a.cursor) < BigInt(b.cursor) ? -1 : BigInt(a.cursor) > BigInt(b.cursor) ? 1 : 0,
  );
}

function useActivityHistory(taskId: Task['id'], workspace: Workspace) {
  const { readTaskActivity, activityRevision, events: live } = workspace;
  const section = useRef<HTMLElement>(null);
  const anchor = useRef<{ row: HTMLElement; top: number; panel: HTMLElement } | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const retained = useRef<Event[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const headCursor = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = useRef<string | undefined>(undefined);
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
    async (cursor?: string, retry = false) => {
      if (busy.current) return;
      busy.current = true;
      const token = generation.current;
      const requested = retry ? failed.current : cursor;
      rememberAnchor();
      setLoading(true);
      setError(null);
      try {
        const page = await readTaskActivity({ taskId, beforeCursor: requested, limit: 100 });
        if (generation.current !== token) return;
        rememberAnchor();
        // A disjoint head reopens pagination so reconnects cannot hide retained events.
        const first = page.events[0];
        const overlaps =
          first &&
          headCursor.current !== null &&
          BigInt(first.cursor) <= BigInt(headCursor.current);
        if (requested !== undefined || !overlaps) setBefore(page.nextBeforeCursor);
        if (requested === undefined) headCursor.current = page.events.at(-1)?.cursor ?? null;
        retained.current = mergeEvents(retained.current, page.events);
        setEvents(retained.current);
        setLoaded(true);
        failed.current = undefined;
      } catch (failure) {
        if (generation.current !== token) return;
        rememberAnchor();
        failed.current = requested;
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
    else void load();
  }, [activityRevision, refreshTick, load]);
  useEffect(() => {
    const incoming = live.filter((event) => event.taskId === taskId);
    if (!incoming.some((event) => !retained.current.some(({ id }) => id === event.id))) return;
    rememberAnchor();
    retained.current = mergeEvents(retained.current, incoming);
    setEvents(retained.current);
  }, [live, taskId, rememberAnchor]);
  return { events, loading, error, loaded, before, load, section };
}

const eventNames: Record<Event['type'], string> = {
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
  const { events, loading, error, loaded, before, load, section } = useActivityHistory(
    task.id,
    workspace,
  );
  const tail = useRef<HTMLDivElement>(null);
  const visible = events.filter(({ type }) => type !== 'task.updated');
  return (
    <section className="activity-section" ref={section}>
      <div className="section-heading">
        <h2>
          <Activity size={15} />
          Activity
        </h2>
        <span>{visible.length} events received</span>
      </div>
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
          onClick={() => load(before)}
        >
          Load older activity
        </button>
      ) : loaded ? (
        <p>{events.length === 0 ? 'No retained activity.' : 'Beginning of task activity.'}</p>
      ) : null}
      {visible.length > 0 && (
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
