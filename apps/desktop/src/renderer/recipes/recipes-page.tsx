import {
  PLAN_RECIPE_FOLDER,
  type PlanRecipeEntry,
  type PlanRecipesRead,
} from '@crewkite/contracts';
import { ArrowLeft, Plus } from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Select } from '../select.tsx';
import { useCatalog } from '../settings/use-catalog.ts';
import type { ThreadSource } from '../thread/commands.ts';
import { readRecipes, setRecipeFolder } from './commands.ts';
import type { ThreadDraft } from './draft-bus.ts';
import { fileWords, NONE_AVAILABLE, scheduleWords, triggerWords } from './model.ts';
import { RecipeEditor, type RecipeTarget, when } from './recipe-editor.tsx';
import './recipes.css';

// The Recipes page: a project's recipes on the left and one recipe on the right. Schedules and
// Results are views of the same page, so a person moves between a recipe, when it runs and what
// its runs produced without leaving it.

export type RecipesView = 'recipes' | 'schedules' | 'results';

const VIEWS: { id: RecipesView; label: string }[] = [
  { id: 'recipes', label: 'Recipes' },
  { id: 'schedules', label: 'Loops' },
  { id: 'results', label: 'Results' },
];

const keyOf = (entry: PlanRecipeEntry) => entry.record?.id ?? entry.path;

function RecipeList({
  entries,
  selected,
  onSelect,
}: {
  entries: readonly PlanRecipeEntry[];
  selected: string | null;
  onSelect: (entry: PlanRecipeEntry) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.max(
    0,
    entries.findIndex((entry) => keyOf(entry) === selected),
  );
  // One stop in the tab order. The arrow keys, Home and End move between recipes.
  const move = (event: KeyboardEvent, index: number) => {
    const target =
      event.key === 'ArrowDown'
        ? Math.min(entries.length - 1, index + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, index - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? entries.length - 1
              : -1;
    if (target < 0) return;
    event.preventDefault();
    refs.current[target]?.focus();
  };
  return (
    <ul className="rc-list">
      {entries.map((entry, index) => {
        const word = fileWords[entry.file];
        return (
          <li key={keyOf(entry)}>
            <button
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              className="rc-list-item"
              tabIndex={index === at ? 0 : -1}
              aria-current={keyOf(entry) === selected ? 'true' : undefined}
              onKeyDown={(event) => move(event, index)}
              onClick={() => onSelect(entry)}
            >
              <span className="rc-list-name">{entry.name ?? entry.path}</span>
              <span className="rc-list-meta">
                {entry.trigger ? triggerWords(entry.trigger, when) : 'Unknown'}
                {entry.schedule ? `, ${scheduleWords[entry.schedule.state]}` : ''}
              </span>
              {word && <span className={`rc-list-file is-${entry.file}`}>{word}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function RecipesPage({
  source,
  projects,
  projectId: startProject,
  view: startView,
  catalogChanged,
  threadDraft,
  schedules,
  results,
  onOpenThread,
  onClose,
  registerGuard,
}: {
  source: ThreadSource;
  projects: readonly { id: string; name: string }[];
  /** The project of the thread the person came from. */
  projectId: string | null;
  /** The view the page opens on. Without one it opens on Recipes. */
  view?: RecipesView;
  /** Changes when a provider connects or a model list is read, so readiness reads again. */
  catalogChanged: unknown;
  threadDraft: ThreadDraft | null;
  /** The Schedules and Results views, drawn by their own modules. */
  schedules?: (props: {
    source: ThreadSource;
    projects: readonly { id: string; name: string }[];
    onOpenRecipe: (projectId: string, recipeId: string) => void;
  }) => React.ReactNode;
  results?: (props: { projectId: string }) => React.ReactNode;
  onOpenThread: (taskId: string) => void;
  onClose: () => void;
  /** Hands the app the page's guard, so its own navigation asks before a draft is dropped. */
  registerGuard?: (guard: ((go: () => void, late?: boolean) => void) | null) => void;
}) {
  const ids = useId();
  const { catalog } = useCatalog(source, catalogChanged);
  const [view, setView] = useState<RecipesView>(startView ?? 'recipes');
  const [chosen, setChosen] = useState<string | null>(threadDraft?.projectId ?? startProject);
  // A project picked here or opened from the Schedules view stays the one shown, even one the
  // app does not list: its list read says what is wrong with it. Only with no pick yet does the
  // page start on the first project.
  const projectId = chosen ?? projects[0]?.id ?? null;
  const [list, setList] = useState<PlanRecipesRead | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [target, setTarget] = useState<RecipeTarget | null>(
    threadDraft
      ? {
          kind: 'new',
          draft: threadDraft.draft.recipe,
          from: threadDraft.threadTitle,
          defaults: threadDraft.draft.defaults,
        }
      : null,
  );
  const [changed, setChanged] = useState(0);
  // The editor is remounted for each recipe the person picks, and kept through its own save.
  const [slot, setSlot] = useState(0);
  const pick = (next: RecipeTarget | null) => {
    setTarget(next);
    setSlot((count) => count + 1);
  };
  // Whether the editor holds edits that are not saved. The editor reports it after every render,
  // and only `leave` reads it, so the page cannot act on an answer older than the draft.
  const dirty = useRef(false);
  const onDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(
    () =>
      source.subscribe((event) => {
        if (event.type === 'recipes.changed') setChanged((count) => count + 1);
      }),
    [source],
  );
  // The schedule's next run and a run's state move without an event from this window, so a
  // window that comes back to the front reads again.
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `changed` is the trigger
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    readRecipes(source, projectId).then(
      (next) => {
        if (!live) return;
        setList(next);
        setFailure(null);
        // The first recipe opens on its own, so the page never shows an empty detail beside a list.
        setTarget((current) => {
          if (current) return current;
          const first = next.recipes[0];
          if (!first) return null;
          return first.record
            ? { kind: 'record', recipeId: first.record.id }
            : { kind: 'file', path: first.path };
        });
      },
      (error: unknown) => {
        if (live) setFailure(error instanceof Error ? error.message : 'They could not be read.');
      },
    );
    return () => {
      live = false;
    };
  }, [source, projectId, changed]);

  // An unsaved draft is kept only in this window, so leaving it asks first, in the page: another
  // recipe, view or project, New recipe, Back to threads, Escape, a run's thread, and the app's
  // own navigation, such as the rail, the shortcuts and the palette, which reaches this through
  // `registerGuard`. Closing or reloading the window does not ask.
  const [ask, setAsk] = useState<{ run: () => void; from: HTMLElement | null } | null>(null);
  const askRef = useRef(ask);
  askRef.current = ask;
  const keep = useRef<HTMLButtonElement>(null);
  // `late` marks a draft from a thread that arrived on its own. One that lands while the page
  // asks about another way out is dropped, so the question and its way out stay as they were.
  const leave = useCallback((go: () => void, late = false) => {
    if (!dirty.current) {
      go();
      return;
    }
    if (late && askRef.current) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A second way out while the page asks keeps the first focus to return to.
    setAsk((current) => ({ run: go, from: current ? current.from : active }));
  }, []);
  // Focus goes back to what had it before the page asked.
  const keepEditing = useCallback(() => {
    const from = askRef.current?.from;
    setAsk(null);
    from?.focus();
  }, []);
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(() => {
    registerGuard?.((go, late) => leaveRef.current(go, late));
    return () => registerGuard?.(null);
  }, [registerGuard]);
  useEffect(() => {
    if (ask) keep.current?.focus();
  }, [ask]);

  // Escape leaves the page the way it leaves Settings, unless a field, a panel or a dialog takes
  // it. While the page asks about unsaved changes, Escape keeps editing wherever focus is.
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (askRef.current) {
        event.preventDefault();
        keepEditing();
        return;
      }
      const from = event.target as HTMLElement | null;
      if (from?.closest('input, textarea, select, [contenteditable="true"], dialog, .rc-panel'))
        return;
      if (document.querySelector('dialog[open], .ck-select-list, .rc-panel')) return;
      leaveRef.current(onClose);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onClose, keepEditing]);

  // A forgotten recipe's editor goes, so focus goes to the list's first recipe, else to New
  // recipe, and again once the list read after the Forget lands and its rows are drawn anew.
  const page = useRef<HTMLElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const focusList = useRef(false);
  useLayoutEffect(() => {
    if (!focusList.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (page.current?.querySelector<HTMLElement>('.rc-list-item') ?? newButton.current)?.focus();
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list read after a Forget ends it
  useEffect(() => {
    focusList.current = false;
  }, [list, failure]);

  const folder = list?.folder ?? PLAN_RECIPE_FOLDER;
  const entries = list?.recipes ?? [];
  const selected =
    target?.kind === 'record' ? target.recipeId : target?.kind === 'file' ? target.path : null;
  const empty = list !== null && entries.length === 0 && target === null;
  // A failed first read shows alone unless a recipe is open. Once a list is on screen, a failed
  // refresh shows above it and leaves the list and the recipe open, edits and all.
  const failureLine = failure && (
    <p className="rc-banner is-stop" role="alert">
      CrewKite could not read this project's recipes. {failure}
      <button
        type="button"
        className="button secondary"
        onClick={() => setChanged((count) => count + 1)}
      >
        Try again
      </button>
    </p>
  );

  return (
    <main ref={page} className="recipes-page" aria-labelledby={`${ids}-title`}>
      <div className="rc-frame">
        <div className="rc-top">
          <h1 id={`${ids}-title`} tabIndex={-1}>
            Recipes
          </h1>
          <div className="rc-views" role="tablist" aria-label="Recipes views">
            {VIEWS.map((item, index) => (
              <button
                key={item.id}
                ref={(node) => {
                  tabs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`${ids}-tab-${item.id}`}
                aria-selected={view === item.id}
                aria-controls={`${ids}-view`}
                tabIndex={view === item.id ? 0 : -1}
                onKeyDown={(event) => {
                  const nextIndex =
                    event.key === 'ArrowRight'
                      ? (index + 1) % VIEWS.length
                      : event.key === 'ArrowLeft'
                        ? (index - 1 + VIEWS.length) % VIEWS.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? VIEWS.length - 1
                            : -1;
                  if (nextIndex < 0) return;
                  event.preventDefault();
                  tabs.current[nextIndex]?.focus();
                  const nextView = VIEWS[nextIndex];
                  if (nextView) leave(() => setView(nextView.id));
                }}
                onClick={() => leave(() => setView(item.id))}
              >
                {item.label}
              </button>
            ))}
          </div>
          {view !== 'schedules' && projects.length > 0 && projectId && (
            <span className="rc-project">
              <span id={`${ids}-project`}>Project</span>
              <Select
                aria-labelledby={`${ids}-project`}
                value={projectId}
                onChange={(event) =>
                  leave(() => {
                    setChosen(event.target.value);
                    setList(null);
                    setFailure(null);
                    pick(null);
                  })
                }
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </span>
          )}
          <button type="button" className="button secondary" onClick={() => leave(onClose)}>
            <ArrowLeft size={14} aria-hidden="true" />
            Back to threads
          </button>
        </div>

        {ask && (
          <div
            className="rc-banner is-warn"
            role="alertdialog"
            aria-label="Unsaved changes"
            aria-describedby={`${ids}-ask`}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              keepEditing();
            }}
          >
            <span id={`${ids}-ask`}>This recipe has changes that are not saved.</span>
            <button
              type="button"
              className="button stop"
              onClick={() => {
                const { run, from } = ask;
                setAsk(null);
                run();
                // Focus goes back to the control that asked to leave while it is still on the
                // page. A control the step replaces hands focus on itself.
                if (from?.isConnected) from.focus();
              }}
            >
              Discard changes
            </button>
            <button ref={keep} type="button" className="button secondary" onClick={keepEditing}>
              Keep editing
            </button>
          </div>
        )}

        <div id={`${ids}-view`} role="tabpanel" aria-labelledby={`${ids}-tab-${view}`}>
          {view === 'schedules' ? (
            (schedules?.({
              source,
              projects,
              onOpenRecipe: (project, recipeId) =>
                leave(() => {
                  // Another project's list is read fresh, so the old one never shows under it.
                  if (project !== projectId) {
                    setList(null);
                    setFailure(null);
                  }
                  setChosen(project);
                  pick({ kind: 'record', recipeId });
                  setView('recipes');
                }),
            }) ?? (
              <section className="rc-empty">
                <h2>Loops</h2>
                <p>Loops run while CrewKite is open.</p>
                <p>No loops. Give a recipe a trigger to add one.</p>
              </section>
            ))
          ) : view === 'results' ? (
            ((projectId && results?.({ projectId })) ?? (
              <section className="rc-empty">
                <h2>Results</h2>
                <p>Counts from this device. Nothing here is uploaded.</p>
                <p>No results yet. They start with the next plan run.</p>
              </section>
            ))
          ) : !projectId ? (
            <section className="rc-empty">
              <h2>No project yet.</h2>
              <p>Add a project from the rail, then come back to keep a recipe in it.</p>
            </section>
          ) : failure && list === null && target === null ? (
            failureLine
          ) : empty ? (
            <>
              {failureLine}
              <section className="rc-empty">
                <h2>No recipes in this project yet.</h2>
                <p>
                  A recipe keeps a crew, its checks and its limits so a plan that worked can run
                  again.
                </p>
                <button
                  ref={newButton}
                  type="button"
                  className="button primary"
                  onClick={() => pick({ kind: 'new' })}
                >
                  <Plus size={14} aria-hidden="true" />
                  New recipe
                </button>
                <p>
                  To start from a plan that worked, open its thread and choose Save as recipe on the
                  Work tab.
                </p>
              </section>
            </>
          ) : (
            <>
              {failureLine}
              <div className="rc-columns">
                <nav className="rc-side" aria-label="Recipes in this project">
                  {list === null ? (
                    failure ? null : (
                      <p className="rc-note" role="status">
                        Loading
                      </p>
                    )
                  ) : (
                    <RecipeList
                      entries={entries}
                      selected={selected}
                      onSelect={(entry) =>
                        leave(() =>
                          pick(
                            entry.record
                              ? { kind: 'record', recipeId: entry.record.id }
                              : { kind: 'file', path: entry.path },
                          ),
                        )
                      }
                    />
                  )}
                  {list && list.more > 0 && (
                    <p className="rc-note">{list.more} more files in this folder are not shown.</p>
                  )}
                  <button
                    type="button"
                    className="button secondary"
                    ref={newButton}
                    onClick={() => leave(() => pick({ kind: 'new' }))}
                  >
                    <Plus size={13} aria-hidden="true" />
                    New recipe
                  </button>
                  {folderDraft === null ? (
                    <p className="rc-folder">
                      <span>Folder: {folder}</span>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setFolderDraft(folder)}
                      >
                        Change
                      </button>
                    </p>
                  ) : (
                    <form
                      className="rc-folder"
                      onSubmit={(event) => {
                        event.preventDefault();
                        setRecipeFolder(source, projectId, folderDraft.trim()).then(
                          () => {
                            setFolderDraft(null);
                            setNote('');
                            setChanged((count) => count + 1);
                          },
                          (error: unknown) =>
                            setNote(
                              error instanceof Error ? error.message : 'That did not go through.',
                            ),
                        );
                      }}
                    >
                      <input
                        type="text"
                        aria-label="Folder"
                        spellCheck={false}
                        maxLength={1024}
                        value={folderDraft}
                        onChange={(event) => setFolderDraft(event.target.value)}
                      />
                      <button type="submit" className="button secondary">
                        Save
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          setFolderDraft(null);
                          setNote('');
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  )}
                  {note && (
                    <p className="rc-problem" role="alert">
                      {note}
                    </p>
                  )}
                </nav>
                {target && (
                  <RecipeEditor
                    key={`${projectId}-${slot}`}
                    source={source}
                    projectId={projectId}
                    target={target}
                    folder={folder}
                    catalog={catalog}
                    available={list?.available ?? NONE_AVAILABLE}
                    changed={changed}
                    guard={leave}
                    onDirty={onDirty}
                    onSaved={(recipeId) => {
                      setTarget({ kind: 'record', recipeId });
                      setChanged((count) => count + 1);
                    }}
                    onForgotten={() => {
                      focusList.current = true;
                      pick(null);
                      setChanged((count) => count + 1);
                    }}
                    onOpenThread={onOpenThread}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
