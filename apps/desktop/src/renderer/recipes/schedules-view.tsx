import type { PlanScheduleState, PlanSchedulesRead } from '@crewkite/contracts';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ThreadSource } from '../thread/commands.ts';
import { readSchedules, setRecipeSchedule } from './commands.ts';
import { when } from './recipe-editor.tsx';
import {
  changedLine,
  type HasThread,
  moreLine,
  type ScheduleChange,
  type ScheduleRow,
  scheduleRows,
} from './schedules-model.ts';

// Every schedule across projects: when each runs next, what its last start came to, and why one
// is not running. A row's action sends one command, then the view reads every schedule again, so
// the row shows what the controller now holds and never a guess.

const VERB: Record<ScheduleChange, string> = {
  pause: 'Pause',
  resume: 'Resume',
  restart: 'Restart',
};
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** The controls a row has, named so focus can find the same one after the row is drawn again. */
type Slot = 'name' | 'change' | 'run';

/**
 * What a row's last action came to, with the state it reported and, for a line that names a
 * time, that time. It shows only while the row still reads both.
 */
type Line = { text: string; state: PlanScheduleState; nextAt?: string | null };
const holds = (line: Line, schedule: { state: PlanScheduleState; nextAt: string | null }) =>
  line.state === schedule.state && (line.nextAt === undefined || line.nextAt === schedule.nextAt);

export function SchedulesView({
  source,
  projects,
  hasThread,
  onOpenRecipe,
  onOpenThread,
}: {
  source: ThreadSource;
  projects: readonly { id: string; name: string }[];
  hasThread: HasThread;
  onOpenRecipe: (projectId: string, recipeId: string) => void;
  onOpenThread: (taskId: string) => void;
}) {
  const ids = useId();
  const [read, setRead] = useState<PlanSchedulesRead | null>(null);
  const shownRead = useRef<PlanSchedulesRead | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [changed, setChanged] = useState(0);
  // The command each row has out. Its button stays off until the read after the answer lands.
  // The ref answers a second click before the first one has drawn anything.
  const [pending, setPending] = useState<Record<string, ScheduleChange>>({});
  const out = useRef(new Set<string>());
  const [lines, setLines] = useState<Record<string, Line>>({});
  const root = useRef<HTMLElement>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const restore = useRef<{ id: string; slot: Slot } | null>(null);
  // Reads can land out of order. Only an answer newer than the one on screen counts, a failure
  // among them, so an older read that lands later changes nothing.
  const asked = useRef(0);
  const shown = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    // A view that is gone asks nothing more of the controller.
    if (!live.current) return;
    asked.current += 1;
    const mine = asked.current;
    try {
      const next = await readSchedules(source);
      if (!live.current || mine <= shown.current) return;
      shown.current = mine;
      // Rows move when they sort again, and a moved button loses focus. It gets it back below.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.dataset.row && root.current?.contains(active))
        restore.current = { id: active.dataset.row, slot: active.dataset.slot as Slot };
      shownRead.current = next;
      setRead(next);
      setFailure(null);
      // A line about a state the schedule has left goes, so it never comes back with that state.
      setLines((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id, line]) => {
            const schedule = next.schedules.find((entry) => entry.schedule.recipeId === id);
            return schedule !== undefined && holds(line, schedule.schedule);
          }),
        ),
      );
    } catch (error) {
      if (!live.current || mine <= shown.current) return;
      shown.current = mine;
      setFailure(message(error, 'They could not be read.'));
    }
  }, [source]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `changed` is the trigger
  useEffect(() => {
    void load();
  }, [load, changed]);
  useEffect(
    () =>
      source.subscribe((event) => {
        if (event.type === 'recipes.changed') setChanged((count) => count + 1);
      }),
    [source],
  );
  // A next run and a run's state move without an event from this window, so a window that comes
  // back to the front reads again, as the rest of the page does.
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') setChanged((count) => count + 1);
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, []);

  // Focus goes back to the control that had it, or to the one that replaced it, or to the recipe
  // name when the row has neither now.
  useLayoutEffect(() => {
    const want = restore.current;
    if (!want) return;
    restore.current = null;
    const target =
      controls.current.get(`${want.id}:${want.slot}`) ?? controls.current.get(`${want.id}:name`);
    if (target && document.activeElement !== target) target.focus();
  });

  async function act(row: ScheduleRow, action: ScheduleChange) {
    const id = row.recipeId;
    if (out.current.has(id)) return;
    out.current.add(id);
    setPending((current) => ({ ...current, [id]: action }));
    setLines(({ [id]: _old, ...rest }) => rest);
    let line: Line;
    try {
      await setRecipeSchedule(source, id, action);
      if (!live.current) return;
      await load();
      const state = action === 'pause' ? 'paused' : 'active';
      const after = shownRead.current?.schedules.find(
        (entry) => entry.schedule.recipeId === id,
      )?.schedule;
      // The time comes from the read the row now shows. Without one the line names no time.
      const nextAt = after?.state === state ? after.nextAt : null;
      line = {
        text: changedLine(action, nextAt, when),
        state,
        ...(action !== 'pause' && nextAt ? { nextAt } : {}),
      };
    } catch (error) {
      if (!live.current) return;
      const text = message(error, 'The loop did not change.');
      // What refused the command may have moved the schedule, so the row reads it again.
      await load();
      const after = shownRead.current?.schedules.find(
        (entry) => entry.schedule.recipeId === id,
      )?.schedule;
      line = { text, state: after?.state ?? row.state };
    } finally {
      out.current.delete(id);
    }
    if (!live.current) return;
    // Focus stays on the action unless the person took it somewhere else meanwhile.
    const active = document.activeElement;
    if (!active || active === document.body || active === controls.current.get(`${id}:change`))
      restore.current = { id, slot: 'change' };
    setPending(({ [id]: _done, ...rest }) => rest);
    setLines((current) => ({ ...current, [id]: line }));
  }

  const keep = (id: string, slot: Slot) => (node: HTMLButtonElement | null) => {
    if (node) controls.current.set(`${id}:${slot}`, node);
    else controls.current.delete(`${id}:${slot}`);
  };
  const rows = read ? scheduleRows(read.schedules, projects, when, hasThread) : [];

  return (
    <section ref={root} className="rc-sched" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>Loops</h2>
      <p className="rc-note">Loops run while CrewKite is open.</p>
      {failure && (
        <p className="rc-banner is-stop" role="alert">
          CrewKite could not read the loops. {failure}
          <button
            type="button"
            className="button secondary"
            onClick={() => setChanged((count) => count + 1)}
          >
            Try again
          </button>
        </p>
      )}
      {read === null ? (
        failure ? null : (
          <p className="rc-note" role="status">
            Loading
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="rc-sched-empty">No loops. Give a recipe a trigger to add one.</p>
      ) : (
        <table aria-labelledby={`${ids}-title`}>
          <thead>
            <tr>
              <th scope="col">Recipe</th>
              <th scope="col">Project</th>
              <th scope="col">Starts</th>
              <th scope="col">Next run</th>
              <th scope="col">Last result</th>
              <th scope="col">Runs</th>
              <th scope="col">State</th>
              <th scope="col">
                <span className="rc-sr">Actions</span>
              </th>
            </tr>
          </thead>
          {rows.map((row) => {
            const id = row.recipeId;
            const lineId = `${ids}-${id}-line`;
            // A command that is out keeps its button, so focus has somewhere to stay.
            const change = pending[id] ?? row.change;
            const status = lines[id];
            return (
              <tbody key={id} className="rc-sched-item">
                <tr aria-describedby={row.line ? lineId : undefined}>
                  <th scope="row">
                    <button
                      ref={keep(id, 'name')}
                      type="button"
                      className="rc-sched-open"
                      data-row={id}
                      data-slot="name"
                      aria-label={`Open ${row.name}`}
                      onClick={() => onOpenRecipe(row.projectId, id)}
                    >
                      {row.name}
                    </button>
                  </th>
                  <td data-label="Project">{row.project}</td>
                  <td data-label="Starts" className="rc-sched-short">
                    {row.starts}
                  </td>
                  <td data-label="Next run">{row.nextRun}</td>
                  <td data-label="Last result" className="rc-sched-last">
                    {row.lastResult.text}
                    {row.lastResult.time && <small>{row.lastResult.time}</small>}
                  </td>
                  <td data-label="Runs" className="rc-sched-short">
                    {row.runs}
                  </td>
                  <td className={`rc-sched-state is-${row.state}`}>{row.stateWord}</td>
                  <td className="rc-sched-actions">
                    <span className="rc-actions">
                      {change && (
                        <button
                          ref={keep(id, 'change')}
                          type="button"
                          className="button secondary"
                          data-row={id}
                          data-slot="change"
                          // Disabled by attribute would drop focus to the page while it waits.
                          aria-disabled={pending[id] ? true : undefined}
                          aria-label={`${VERB[change]} ${row.name}`}
                          onClick={() => {
                            if (!pending[id]) void act(row, change);
                          }}
                        >
                          {VERB[change]}
                        </button>
                      )}
                      {row.lastRunTask && (
                        <button
                          ref={keep(id, 'run')}
                          type="button"
                          className="button secondary"
                          data-row={id}
                          data-slot="run"
                          aria-label={`Open last run of ${row.name}`}
                          onClick={() => row.lastRunTask && onOpenThread(row.lastRunTask)}
                        >
                          Open last run
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
                <tr className="rc-sched-more">
                  <td colSpan={8}>
                    {row.line && (
                      <p id={lineId} className="rc-sched-line">
                        {row.line}
                      </p>
                    )}
                    <p className="rc-sched-status" role="status">
                      {status && holds(status, row) ? status.text : ''}
                    </p>
                  </td>
                </tr>
              </tbody>
            );
          })}
        </table>
      )}
      {read && read.more > 0 && <p className="rc-note">{moreLine(read.more)}</p>}
    </section>
  );
}
