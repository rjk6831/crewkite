import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { focusSection } from '../palette/focus-section.ts';
import { readRecipes, readSchedules } from '../recipes/commands.ts';
import { when } from '../recipes/recipe-editor.tsx';
import type { RecipesView } from '../recipes/recipes-page.tsx';
import { readResults } from '../recipes/results-view.tsx';
import { Select } from '../select.tsx';
import type { Workspace } from '../source.ts';
import {
  readDesignSystem,
  readNotes,
  readThread,
  readWritingRules,
  type ThreadSource,
} from '../thread/commands.ts';
import {
  type ContextParts,
  contextLine,
  contextTarget,
  graphsLine,
  type HooksParts,
  hooksLine,
  loopsLine,
  newestOfPages,
  newestThread,
  type RowRead,
  resultsLine,
  rowLine,
  type SetupLine,
} from './setup-model.ts';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * An Open button that leaves Settings goes with it, so focus moves to the heading of the page it
 * opened once that page is drawn. It waits for as long as the page shows it is opening, plus the
 * few frames before it starts to. It stops when the person moves focus, when Settings and this card
 * are on screen, or when the page went away before its heading came.
 */
function focusOpened(opener: HTMLElement, heading: string, opening: string) {
  let frame = 0;
  const look = () => {
    frame += 1;
    const active = document.activeElement;
    if (active && active !== document.body && active !== opener) return;
    if (opener.isConnected || document.getElementById('settings-project-setup')) return;
    const target = document.querySelector<HTMLElement>(heading);
    if (target) {
      // A heading takes focus only with a tab index that no key reaches.
      if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.focus();
    } else if (document.querySelector(opening) || frame < 30) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}
const checksOn = (checks: { items: { enabled: boolean }[] } | undefined) =>
  checks?.items.filter((item) => item.enabled).length;

/** The rail's own line for a page it could not read. */
const NAVIGATION_FAILED = 'Navigation changed. Refresh to continue.';

/** A read the next one replaces: its answer is dropped and the row keeps what it shows. */
class Superseded extends Error {}

/**
 * One row's read. `input` names what the read is about within the project, and null holds the
 * read until it is known. One read is out at a time for the same project and input: asked again
 * meanwhile, the row reads once more after it, however often it was asked. An answer lands only
 * while the card shows the same project and input, and only when it is newer than the answer on
 * screen, so one that arrives after the card left, after the project changed, or after a newer
 * answer or failure changes nothing. A read again keeps the last answer on screen until the new
 * one lands.
 */
function useRowRead<T>(
  projectId: string,
  input: string | null,
  load: () => Promise<T>,
  again: number,
): RowRead<T> {
  const [shown, setShown] = useState<{ projectId: string; read: RowRead<T> } | null>(null);
  const latest = useRef(load);
  latest.current = load;
  const current = useRef('');
  current.current = `${projectId} ${input}`;
  const asked = useRef(0);
  const landed = useRef(0);
  const out = useRef<string | null>(null);
  const queued = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const start = useCallback((key: string, project: string) => {
    out.current = key;
    queued.current = false;
    asked.current += 1;
    const mine = asked.current;
    const land = (read: RowRead<T>) => {
      if (!mounted.current || current.current !== key || mine <= landed.current) return;
      landed.current = mine;
      setShown({ projectId: project, read });
    };
    latest
      .current()
      .then(
        (value) => land({ state: 'read', value }),
        (error: unknown) => {
          if (error instanceof Superseded) return;
          land({ state: 'failed', reason: error instanceof Error ? error.message : '' });
        },
      )
      .finally(() => {
        if (out.current !== key) return;
        out.current = null;
        if (queued.current && mounted.current && current.current === key) start(key, project);
      });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `input` and `again` are the triggers
  useEffect(() => {
    if (!projectId || input === null) return;
    const key = `${projectId} ${input}`;
    if (out.current === key) queued.current = true;
    else start(key, projectId);
  }, [projectId, input, again, start]);
  return shown?.projectId === projectId ? shown.read : { state: 'reading' };
}

/**
 * What one project has set up, one row per part, each with a button to the place that changes
 * it. Every row reads on its own, so a read that fails leaves the other rows standing.
 */
export function SetupCard({
  source,
  workspace,
  contextChanged,
  onShowNotes,
  onOpenThread,
  onOpenRecipes,
}: {
  source: ThreadSource;
  workspace: Pick<
    Workspace,
    | 'projects'
    | 'taskPages'
    | 'loadTasks'
    | 'readTaskPage'
    | 'navigationBusy'
    | 'navigationStale'
    | 'navigationFailed'
  >;
  /** Moves when a writing rule, the design system or a note is saved on the Settings page. */
  contextChanged: number;
  /** Picks the project in the Project notes card. */
  onShowNotes: (projectId: string) => void;
  onOpenThread?: (taskId: string) => void;
  onOpenRecipes?: (projectId: string, view: RecipesView) => void;
}) {
  const {
    projects,
    taskPages,
    loadTasks,
    readTaskPage,
    navigationBusy,
    navigationStale,
    navigationFailed,
  } = workspace;
  const [chosen, setChosen] = useState('');
  const projectId = projects.some(({ id }) => id === chosen) ? chosen : (projects[0]?.id ?? '');
  const [changed, setChanged] = useState(0);
  const [checksChanged, setChecksChanged] = useState(0);
  // A page the walk could not read. Once the rail's Refresh clears the flag, the walk runs again.
  const [pageFailed, setPageFailed] = useState(false);
  useEffect(() => {
    if (!pageFailed || navigationStale) return;
    setPageFailed(false);
    setChecksChanged((count) => count + 1);
  }, [pageFailed, navigationStale]);

  // The newest thread is read from the rail's pages of the project. Until the rail has read the
  // first one, the card asks it to, as Show threads does. The pages the rail has not read yet the
  // card reads itself and keeps to itself.
  const page = taskPages[projectId];
  const taskCount = projects.find(({ id }) => id === projectId)?.taskCount ?? 0;
  const waiting = !page && taskCount > 0;
  useEffect(() => {
    if (!waiting || !projectId || navigationBusy || navigationStale) return;
    void loadTasks(projectId);
  }, [waiting, projectId, navigationBusy, navigationStale, loadTasks]);

  const context = useRowRead<ContextParts>(
    projectId,
    'context',
    async () => {
      const [rules, design, notes] = await Promise.all([
        readWritingRules(source),
        readDesignSystem(source, projectId),
        readNotes(source, projectId),
      ]);
      const record = design.record;
      return {
        rules,
        design: record && { version: record.version, sent: record.delivery },
        notes,
      };
    },
    changed + contextChanged,
  );
  // shortcut: reads the newest thread whole to count its checks. Upgrade: a per-project checks read.
  const hooks = useRowRead<HooksParts>(
    projectId,
    waiting
      ? null
      : page
        ? `${page.stamp.epoch} ${page.stamp.revision} ${page.tasks.length} ${page.complete}`
        : 'none',
    async () => {
      const found = page
        ? await newestOfPages(page, (after, limit) =>
            readTaskPage({ stamp: page.stamp, projectId, after, limit }),
          ).catch((failure: unknown) => {
            // The list moved under the walk. The rail reads it again and the walk starts over.
            if (failure instanceof Error && failure.message === 'workspace-page-stale')
              throw new Superseded();
            // Any other page failure is the rail's to show, with its Refresh, and the row says
            // the same sentence. The walk runs again once the flag clears.
            navigationFailed();
            setPageFailed(true);
            throw new Error(NAVIGATION_FAILED);
          })
        : { thread: null, over: false };
      if (!found.thread) return { ...found, checks: null, design: false };
      const [read, design] = await Promise.all([
        readThread(source, found.thread),
        readDesignSystem(source, projectId),
      ]);
      return {
        thread: found.thread,
        over: false,
        checks: checksOn(read.thread.checks) ?? 0,
        design: design.record !== null,
      };
    },
    changed + checksChanged,
  );
  const loops = useRowRead(projectId, 'loops', () => readSchedules(source, projectId), changed);
  const graphs = useRowRead(projectId, 'graphs', () => readRecipes(source, projectId), changed);
  const results = useRowRead(projectId, 'results', () => readResults(source, projectId), changed);

  // The thread the row names. A failed read keeps the button only when the rail holds every page.
  const newest =
    hooks.state === 'read'
      ? hooks.value.thread
      : hooks.state === 'failed' && page?.complete
        ? newestThread(page.tasks.map(({ id }) => id))
        : null;

  // A thread event reads the row again only when it moves the count of checks on from what the row
  // shows. Before the row has a count, its first read is still out and answers for it.
  const watched = useRef<{ taskId: string | null; checks: number | null }>({
    taskId: null,
    checks: null,
  });
  watched.current = {
    taskId: newest,
    checks: hooks.state === 'read' ? hooks.value.checks : null,
  };
  useEffect(
    () =>
      source.subscribe((event) => {
        if (event.type === 'recipes.changed') setChanged((count) => count + 1);
        else if (event.type === 'chat.thread' && event.taskId === watched.current.taskId) {
          const on = checksOn(event.payload.checks);
          if (on !== undefined && watched.current.checks !== null && on !== watched.current.checks)
            setChecksChanged((count) => count + 1);
        }
      }),
    [source],
  );

  // The Hooks button goes when the project has no thread. If it had focus, the heading takes it.
  const heading = useRef<HTMLHeadingElement>(null);
  const hooksButton = useRef<HTMLButtonElement | null>(null);
  const restore = useRef(false);
  const keepHooksButton = useCallback((node: HTMLButtonElement | null) => {
    // A button leaving the page while it has focus hands focus on, never to the page.
    if (!node && hooksButton.current === document.activeElement) restore.current = true;
    hooksButton.current = node;
  }, []);
  useLayoutEffect(() => {
    if (!restore.current) return;
    restore.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) heading.current?.focus();
  });

  const target = context.state === 'read' ? contextTarget(context.value) : 'design';
  const openContext = () => {
    if (target === 'notes') {
      onShowNotes(projectId);
      focusSection('settings-notes');
    } else focusSection(target === 'rules' ? 'settings-writing-rules' : 'settings-design-system');
  };
  const hooksFailure: RowRead<HooksParts> | null =
    waiting && navigationStale ? { state: 'failed', reason: NAVIGATION_FAILED } : null;
  const recipes = (view: RecipesView) =>
    onOpenRecipes
      ? (opener: HTMLElement) => {
          onOpenRecipes(projectId, view);
          focusOpened(opener, 'main.recipes-page h1', 'main.recipes-page');
        }
      : undefined;

  const rows: {
    name: string;
    what: string;
    state: SetupLine;
    open: ((opener: HTMLElement) => void) | undefined;
    ref?: (node: HTMLButtonElement | null) => void;
  }[] = [
    {
      name: 'Context',
      what: 'What a turn is given: project notes, and for a turn that writes, writing rules and the design system.',
      state: rowLine(context, contextLine),
      open: openContext,
    },
    {
      name: 'Hooks',
      what: 'Checks that run on their own after a write, after a merge and at Accept.',
      state: rowLine(hooksFailure ?? hooks, hooksLine),
      open:
        newest && onOpenThread
          ? (opener) => {
              onOpenThread(newest);
              focusOpened(opener, 'h1.th-title', '.th-skeleton');
            }
          : undefined,
      ref: keepHooksButton,
    },
    {
      name: 'Loops',
      what: 'Recipes that start on a trigger, inside a budget.',
      state: rowLine(loops, (read) => loopsLine(read, when)),
      open: recipes('schedules'),
    },
    {
      name: 'Graphs',
      what: 'Recipes: a crew and the fixed order its steps run in.',
      state: rowLine(graphs, graphsLine),
      open: recipes('recipes'),
    },
    {
      name: 'Results',
      what: 'What each step of a plan came to, kept on this device.',
      state: rowLine(results, (read) => resultsLine(read, day)),
      open: recipes('results'),
    },
  ];

  return (
    <section className="st-card" aria-labelledby="settings-project-setup">
      <header className="st-card-head">
        <h2 id="settings-project-setup" ref={heading} tabIndex={-1}>
          Project setup
        </h2>
      </header>
      {projects.length === 0 ? (
        <p className="st-note">No project yet.</p>
      ) : (
        <>
          <p className="st-note">
            What this project has set up. Each row opens the place that changes it.
          </p>
          <div className="st-rows">
            <div className="st-row">
              <div className="st-field">
                <label className="st-name" htmlFor="setup-project">
                  Project
                </label>
              </div>
              <div className="st-controls">
                <Select
                  id="setup-project"
                  value={projectId}
                  onChange={(event) => setChosen(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <dl className="st-setup">
              {rows.map((row) => (
                <div className="st-setup-row" key={row.name}>
                  <dt className="st-name">{row.name}</dt>
                  <dd className="st-setup-state">
                    <span className="st-hint">{row.what}</span>
                    <span className={row.state.set ? 'st-setup-line is-set' : 'st-setup-line'}>
                      {row.state.line}
                    </span>
                  </dd>
                  {row.open && (
                    <dd className="st-setup-action">
                      <button
                        ref={row.ref}
                        type="button"
                        className="button secondary"
                        aria-label={`Open ${row.name}`}
                        onClick={(event) => row.open?.(event.currentTarget)}
                      >
                        Open
                      </button>
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </div>
        </>
      )}
    </section>
  );
}
