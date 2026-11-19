import type {
  ChatCatalogRead,
  ChatCrewRole,
  PlanRecipe,
  PlanRecipeChecks,
  PlanRecipeRead,
  PlanRecipeRun,
} from '@crewkite/contracts';
import { Play } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../components.tsx';
import { familyName } from '../family-name.ts';
import { formatLocalTime } from '../format-time.ts';
import { Select } from '../select.tsx';
import { crewRoleNames } from '../settings/preferences.ts';
import type { ThreadSource } from '../thread/commands.ts';
import { FamilyMark } from '../thread/family-mark.tsx';
import { catalogLabels } from '../thread/model-labels.ts';
import {
  forgetRecipe,
  readRecipe,
  readRecipeRuns,
  resolveRecipeChecks,
  runRecipe,
  saveRecipe,
  setRecipeSchedule,
} from './commands.ts';
import {
  type Available,
  askWords,
  blankRecipe,
  changeWords,
  defaultPath,
  filesWords,
  member,
  offLines,
  planAnswer,
  prepare,
  recipeChanges,
  recipeProblems,
  recipeSteps,
  revertChange,
  runWords,
  sameRecipe,
  saveBody,
  stripCounts,
  stripLine,
  tidy,
  triggerWords,
} from './model.ts';
import { RecipeForm, readinessLine } from './recipe-form.tsx';
import { resumable } from './schedules-model.ts';

// One recipe: what a run of it does, the form that changes it, the review that saves it, the
// panel that runs it and the runs it has had. The steps are drawn from the draft, so an edit to
// the crew or the run type shows at once.

/** Which recipe the editor shows: a record, a file CrewKite never saved, or a new draft. */
export type RecipeTarget =
  | { kind: 'record'; recipeId: string }
  | { kind: 'file'; path: string }
  | { kind: 'new'; draft?: PlanRecipe; from?: string; defaults?: string[] };

export const when = (iso: string | null | undefined) => formatLocalTime(iso) ?? 'an unknown time';
const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
// The first sentence is for a form with edits, the second for one without.
const staleWords = (version: number) =>
  `This recipe was saved again as version ${version} while you edited. Your changes are kept. Review them against version ${version}.`;
const savedAgain = (version: number) => `This recipe was saved again as version ${version}.`;
/** The element when it can take focus now: still on the page and not switched off. */
const usable = (node: HTMLElement | null | undefined) =>
  node?.isConnected && !node.matches(':disabled') ? node : null;

function Steps({
  recipe,
  catalog,
  readiness,
}: {
  recipe: PlanRecipe;
  catalog: ChatCatalogRead | null;
  readiness: Partial<Record<ChatCrewRole, string>>;
}) {
  const steps = recipeSteps(recipe);
  const label = catalogLabels(catalog);
  const row = (step: (typeof steps)[number]) => {
    const who = step.role && member(recipe, step.role);
    const line = step.role ? readiness[step.role] : undefined;
    return (
      <li key={step.key}>
        <span className="rc-step-number" aria-hidden="true">
          {step.id}
        </span>
        <span className="rc-step-body">
          <span>
            {step.text}
            {step.who ? ` ${step.who}.` : ''}
          </span>
          {who && (
            <span className="rc-step-model">
              <FamilyMark family={who.selection.family} />
              {who.selection.model
                ? label(who.selection.family, who.selection.model)
                : 'No model picked'}
              {who.selection.effort !== 'default' ? `, effort ${who.selection.effort}` : ''}
            </span>
          )}
          {line && <span className="rc-note is-warn">{line}</span>}
        </span>
      </li>
    );
  };
  const first = steps.findIndex((step) => step.perSlice);
  const last = steps.findLastIndex((step) => step.perSlice);
  return (
    <section className="rc-steps" aria-labelledby="rc-steps-title">
      <h4 id="rc-steps-title">Steps</h4>
      <p className="rc-note">
        CrewKite sets the order and who takes each step. The orchestrator splits each request into
        slices when the run starts.
      </p>
      <ol className="rc-step-list">
        {steps.slice(0, first).map(row)}
        <li className="rc-slice">
          <span className="rc-slice-title">Each slice, in its own copy</span>
          <ol className="rc-step-list" start={first + 1}>
            {steps.slice(first, last + 1).map(row)}
          </ol>
        </li>
        {steps.slice(last + 1).map(row)}
      </ol>
    </section>
  );
}

function Runs({
  runs,
  failure,
  version,
  onOpenThread,
}: {
  runs: readonly PlanRecipeRun[] | null;
  failure: string | null;
  version: number | null;
  onOpenThread: (taskId: string) => void;
}) {
  return (
    <section className="rc-runs" aria-labelledby="rc-runs-title">
      <h3 id="rc-runs-title">Runs</h3>
      {failure ? (
        <p className="rc-note">CrewKite could not read the runs. {failure}</p>
      ) : !runs || runs.length === 0 ? (
        <p className="rc-note">No runs yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">By</th>
              <th scope="col">State</th>
              <th scope="col">Changed</th>
              <th scope="col">Findings</th>
              <th scope="col">Version</th>
              <th scope="col">
                <span className="rc-sr">Thread</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td data-label="Started">{when(run.startedAt)}</td>
                <td data-label="By">{run.origin === 'manual' ? 'By you' : 'Loop'}</td>
                <td data-label="State" className={`rc-run-state is-${run.state}`}>
                  {runWords[run.state]}
                  {run.reason ? <small>{run.reason}</small> : null}
                </td>
                <td data-label="Changed">{filesWords(run.changedFiles)}</td>
                <td data-label="Findings">{run.findings ?? 'Unknown'}</td>
                <td data-label="Version">
                  {run.version === version ? `Version ${run.version}` : 'An earlier version'}
                </td>
                <td>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => onOpenThread(run.taskId)}
                  >
                    Open thread
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Why each member of the recipe on screen cannot take a turn now. The controller judged the
 * members of the file it read, or of the saved version when the file does not read. Its line
 * stays for a member whose provider and model are still the ones it judged, whatever else the
 * person edits. A member changed since is judged from the catalog the page holds.
 */
function crewReadiness(
  shown: PlanRecipe | null,
  read: PlanRecipeRead | null,
  catalog: ChatCatalogRead | null,
): Partial<Record<ChatCrewRole, string>> {
  const lines: Partial<Record<ChatCrewRole, string>> = {};
  if (!shown) return lines;
  const judged = read ? (read.recipe ?? read.saved) : null;
  for (const item of shown.crew.members) {
    const { family, model } = item.selection;
    const was = judged ? member(judged, item.role)?.selection : undefined;
    const known =
      was?.family === family && was.model === model
        ? read?.readiness.find((entry) => entry.role === item.role && entry.family === family)
        : undefined;
    const name = familyName(family);
    const line =
      known && !known.ready
        ? known.reason === 'terms-pending'
          ? `Accept the ${name} terms in Settings first.`
          : known.reason === 'model-unknown'
            ? `${name} does not list this model. Pick another.`
            : `${name} is not connected. Connect it in Settings, or pick another provider.`
        : readinessLine(catalog, family, model);
    if (line) lines[item.role] = line;
  }
  return lines;
}

export function RecipeEditor({
  source,
  projectId,
  target,
  folder,
  catalog,
  available,
  changed,
  guard,
  onSaved,
  onForgotten,
  onOpenThread,
  onDirty,
}: {
  source: ThreadSource;
  projectId: string;
  target: RecipeTarget;
  /** The folder a new recipe's file goes in. */
  folder: string;
  catalog: ChatCatalogRead | null;
  /** The choices the controller has switched on, from the page's list read. */
  available: Available;
  /** Changes when the controller reports that recipes, schedules or runs moved. */
  changed: unknown;
  /** Runs `go` at once, or after the person agrees to drop unsaved changes. */
  guard: (go: () => void) => void;
  onSaved: (recipeId: string) => void;
  onForgotten: () => void;
  onOpenThread: (taskId: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const ids = useId();
  const [read, setRead] = useState<PlanRecipeRead | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // `base` is the version the draft is compared against, and `baseVersion` the one a save expects.
  // `baseHash` is that version's hash, the one a run sends. All three move together.
  const [base, setBase] = useState<PlanRecipe | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanRecipe | null>(null);
  // What the draft counts as untouched against: the version it was loaded from or moved to, or the
  // blank recipe a new one starts as. Null for a draft handed over from a thread, which is unsaved
  // work from its first moment.
  const [initial, setInitial] = useState<PlanRecipe | null>(null);
  // True while the form shows a file's own version. That version is saved exactly as read.
  const [fileMode, setFileMode] = useState(false);
  const [path, setPath] = useState('');
  const [pathEdited, setPathEdited] = useState(false);
  const [older, setOlder] = useState<{ version: number; body: PlanRecipe } | null>(null);
  const [stale, setStale] = useState<number | null>(null);
  const [panel, setPanel] = useState<'review' | 'run' | 'forget' | null>(null);
  // What the review's checks run. Null while they are read and after a read failed.
  const [resolved, setResolved] = useState<PlanRecipeChecks['resolved'] | null>(null);
  const [checksFailure, setChecksFailure] = useState<string | null>(null);
  const [checksAttempt, setChecksAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [request, setRequest] = useState('');
  const [runs, setRuns] = useState<PlanRecipeRun[] | null>(null);
  const [runsFailure, setRunsFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusName = useRef(false);
  const versionAsked = useRef(0);
  const shortcut = useRef(() => {});
  // Every read asks with the next number. An answer older than the one applied last is dropped,
  // and one that lands while a step is busy waits here until the step ends.
  const askSeq = useRef(0);
  const applied = useRef(0);
  const waiting = useRef<{ next: PlanRecipeRead; asked: number } | null>(null);
  // Where focus goes once the next render is on screen, for a control that took itself away.
  const focusNext = useRef<(() => HTMLElement | null) | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fileButton = useRef<HTMLButtonElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const stripActions = useRef<HTMLSpanElement>(null);
  // What had focus when a busy step began. Its button turns off while the step runs, and a
  // control that turns off drops focus to the page.
  const held = useRef<{ node: Element | null; fallback?: () => HTMLElement | null } | null>(null);
  const begin = (fallback?: () => HTMLElement | null) => {
    held.current = { node: document.activeElement, fallback };
    stepNote.current = '';
    setBusy(true);
  };
  // What a step that did not go through wrote in the status line. An answer applied after it adds
  // its own sentence after this one, so neither is lost.
  const stepNote = useRef('');
  const note = (text: string) => {
    stepNote.current = text;
    setStatus(text);
  };
  const reverts = useRef(new Map<string, HTMLButtonElement>());
  // A closed panel gives focus back to the control that opened it, or to the Name field when that
  // control is gone or switched off by then, or to the banner's way to the file's version when
  // the form is read only for that.
  const landing = useCallback(
    () => usable(opener.current) ?? usable(nameRef.current) ?? usable(fileButton.current) ?? null,
    [],
  );
  const close = useCallback(() => {
    setPanel(null);
    setRefusal(null);
    focusNext.current = landing;
  }, [landing]);
  // A panel the page closes on its own takes focus along only when focus was in it.
  const dismiss = useCallback(() => {
    const inside = panelRef.current?.contains(document.activeElement) ?? false;
    setPanel(null);
    setRefusal(null);
    if (inside) focusNext.current = landing;
  }, [landing]);
  const label = useMemo(() => catalogLabels(catalog), [catalog]);

  const adopt = useCallback((next: PlanRecipeRead, keepFile = false) => {
    const showsFile = next.entry.file === 'unrecorded' || keepFile;
    const start = showsFile ? next.recipe : next.saved;
    setRead(next);
    setBase(next.saved);
    setBaseVersion(next.entry.record?.version ?? 0);
    setBaseHash(next.entry.record?.versionHash ?? null);
    setFileMode(showsFile);
    setDraft(start ? structuredClone(start) : null);
    // Edits are measured against the saved version, also while the file's own version is on
    // screen: going back to the saved version then leaves nothing marked as edited.
    setInitial(next.saved ?? start);
    setStale(null);
    setPath(next.entry.path);
    setPathEdited(true);
  }, []);
  // Another window saved a newer version. The draft stays and is measured against that one.
  const rebase = useCallback((next: PlanRecipeRead) => {
    setRead(next);
    setBase(next.saved);
    setInitial(next.saved);
    setBaseVersion(next.entry.record?.version ?? 0);
    setBaseHash(next.entry.record?.versionHash ?? null);
  }, []);

  const targetKey =
    target.kind === 'record' ? target.recipeId : target.kind === 'file' ? target.path : 'new';
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target's key and a retry start the read; the editor is remounted for another recipe
  useEffect(() => {
    let live = true;
    setFailure(null);
    setOlder(null);
    setPanel(null);
    setRefusal(null);
    setTried(false);
    if (target.kind === 'new') {
      const start = target.draft ? structuredClone(target.draft) : blankRecipe(catalog);
      setRead(null);
      setBase(null);
      setBaseVersion(0);
      setBaseHash(null);
      setFileMode(false);
      setDraft(start);
      setInitial(target.draft ? null : start);
      setPath(defaultPath(folder, start.name));
      setPathEdited(false);
      return;
    }
    askSeq.current += 1;
    const asked = askSeq.current;
    readRecipe(
      source,
      target.kind === 'record'
        ? { projectId, recipeId: target.recipeId }
        : { projectId, path: target.path },
    ).then(
      (next) => {
        if (!live) return;
        // The first read fills an empty editor. Once a draft is on screen, as after the first
        // save of a new recipe, this is an answer like any other.
        if (latest.current.hasDraft) receive(next, asked);
        else {
          applied.current = asked;
          adopt(next);
        }
      },
      (error: unknown) => {
        if (live && !latest.current.hasDraft) setFailure(message(error, 'It could not be read.'));
      },
    );
    return () => {
      live = false;
    };
  }, [source, projectId, targetKey, attempt]);

  const recipeId = read?.entry.record?.id ?? null;
  const fresh = recipeId === null;
  const file = read?.entry.file ?? null;
  const candidate = useMemo(
    () =>
      draft
        ? saveBody({
            draft,
            read: read ? { file: read.entry.file, recipe: read.recipe } : null,
            showsFile: fileMode,
            fresh,
          })
        : null,
    [draft, read, fileMode, fresh],
  );
  const changes = useMemo(
    () => (candidate ? recipeChanges(base, candidate, label, when) : []),
    [base, candidate, label],
  );
  // Problems read the draft with its empty check rows kept, so each line lands on its own row.
  const problems = useMemo(
    () => (draft && !fileMode ? recipeProblems(tidy(draft), available, fresh ? path : null) : []),
    [draft, available, fileMode, fresh, path],
  );
  // Both sides are compared as they would save, so a stray space or an empty row is no edit.
  const touched = useMemo(
    () =>
      !fileMode &&
      candidate !== null &&
      (initial === null || !sameRecipe(prepare(initial, fresh), candidate)),
    [fileMode, candidate, initial, fresh],
  );
  // The page asks before a draft is dropped from what it was told last. It is told after every
  // render, so no change of the draft, a restore or a stale answer among them, can leave it behind.
  useLayoutEffect(() => onDirty(touched));
  useLayoutEffect(() => () => onDirty(false), [onDirty]);
  const visible = tried ? problems : [];
  // A file changed on disk while the form shows the saved version cannot take a save: the
  // controller refuses it. The form is read only, a review of the edits opens read only, and the
  // banner leads to the file's version.
  const changedSaved = file === 'changed' && !fileMode;
  const readOnly =
    older !== null || fileMode || file === 'invalid' || changedSaved || busy || panel === 'run';
  // What the answers of slow reads check when they land, since the person may have started
  // typing, opened a panel or picked a version after the read was asked for.
  const onScreen = {
    busy,
    touched,
    panel,
    older: older !== null,
    fileMode,
    baseVersion,
    hasDraft: draft !== null,
    path: read?.entry.path ?? path,
    recipeId: read?.entry.record?.id ?? null,
    recipe: read?.recipe ?? null,
  };
  const latest = useRef(onScreen);
  latest.current = onScreen;

  // The reads of the recipe as it stands come here through `receive`: a refresh, the review's
  // read, and the read after a save, a schedule action or a step that did not go through. The
  // first read of an empty editor fills it directly. `planAnswer` decides what each one does,
  // read against the editor as it is when the answer is applied.
  const apply = (next: PlanRecipeRead) => {
    const now = latest.current;
    const had = document.activeElement;
    const version = next.entry.record?.version ?? 0;
    const plan = planAnswer(
      {
        busy: now.busy,
        touched: now.touched,
        panel: now.panel,
        older: now.older,
        showsFile: now.fileMode,
        version: now.baseVersion,
      },
      {
        version,
        fileVersion:
          (next.entry.file === 'unrecorded' || next.entry.file === 'changed') &&
          next.recipe !== null,
      },
    );
    if (plan.act === 'read') setRead(next);
    else if (plan.act === 'rebase') {
      rebase(next);
      setStale(plan.stale);
    } else if (plan.act === 'adopt') {
      if (plan.closePanel) dismiss();
      adopt(next, plan.keepFile);
      if (plan.said !== null)
        setStatus(
          stepNote.current ? `${stepNote.current} ${savedAgain(plan.said)}` : savedAgain(plan.said),
        );
    }
    // An answer can switch off the control under the caret. A schedule action's button gives
    // way to the one the strip offers next. Anything else goes to the Name field, or to the page
    // heading when the form is read only.
    if (!focusNext.current && had instanceof HTMLElement && root.current?.contains(had)) {
      const inStrip = stripActions.current?.contains(had) ?? false;
      focusNext.current = () =>
        usable(had)
          ? null
          : ((inStrip
              ? stripActions.current?.querySelector<HTMLElement>('button:not(:disabled)')
              : null) ??
            usable(nameRef.current) ??
            root.current?.closest('.recipes-page')?.querySelector<HTMLElement>('h1') ??
            null);
    }
  };
  const receive = (next: PlanRecipeRead, asked: number) => {
    // An answer counts only for the recipe on screen, by its path or its record.
    const ours =
      next.entry.path === latest.current.path ||
      (next.entry.record !== null && next.entry.record.id === latest.current.recipeId);
    if (!ours || asked <= applied.current) return;
    if (latest.current.busy) {
      if (!waiting.current || asked > waiting.current.asked) waiting.current = { next, asked };
      return;
    }
    applied.current = asked;
    apply(next);
  };
  // Reads the recipe again and hands the answer to `receive`. A read that fails changes nothing,
  // and the result says whether there was an answer.
  const readAgain = async () => {
    askSeq.current += 1;
    const asked = askSeq.current;
    const next = await readLatest().catch(() => null);
    if (next) receive(next, asked);
    return next !== null;
  };

  // A refresh is an answer like any other.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `changed` is the trigger
  useEffect(() => {
    if (!recipeId) return;
    let live = true;
    askSeq.current += 1;
    const asked = askSeq.current;
    readRecipe(source, { projectId, recipeId }).then(
      (next) => {
        if (live) receive(next, asked);
      },
      () => {},
    );
    readRecipeRuns(source, recipeId).then(
      (next) => {
        if (!live) return;
        setRuns(next.runs);
        setRunsFailure(null);
      },
      (error: unknown) => {
        if (live) setRunsFailure(message(error, 'They could not be read.'));
      },
    );
    return () => {
      live = false;
    };
  }, [source, projectId, recipeId, changed]);

  // Every edit goes through here, a Revert and the file path among them, so a status line or a
  // refusal about what was there before clears.
  const update = useCallback((edit: (current: PlanRecipe) => PlanRecipe) => {
    stepNote.current = '';
    setStatus('');
    setRefusal(null);
    setDraft((current) => (current ? edit(current) : current));
  }, []);
  const change = useCallback(
    (edit: (next: PlanRecipe) => void) =>
      update((current) => {
        const next = structuredClone(current);
        edit(next);
        return next;
      }),
    [update],
  );

  // What the review shows for each check is what the save names as seen. It is read again
  // whenever the checks in front of the person change, after a save that did not go through and
  // on Try again, so nothing is approved from an older list. Save stays off until a read succeeds.
  const commands = JSON.stringify(candidate?.checks.map((check) => check.command) ?? []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the command list, the open panel and a retry decide the read
  useEffect(() => {
    if (panel !== 'review' || !candidate) return;
    let live = true;
    setResolved(null);
    setChecksFailure(null);
    const list = candidate.checks.map((check) => check.command);
    (list.length > 0
      ? resolveRecipeChecks(source, projectId, list).then((next) => next.resolved)
      : Promise.resolve([])
    ).then(
      (next) => {
        if (live) setResolved(next);
      },
      (error: unknown) => {
        if (live) setChecksFailure(message(error, 'The checks could not be read.'));
      },
    );
    return () => {
      live = false;
    };
  }, [source, projectId, panel, commands, checksAttempt]);

  // A panel takes focus when it opens and gives it back to the control that opened it.
  useEffect(() => {
    if (panel === 'review' || panel === 'run') {
      panelRef.current?.focus();
      panelRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [panel]);
  useLayoutEffect(() => {
    const pick = focusNext.current;
    if (!pick) return;
    focusNext.current = null;
    pick()?.focus();
  });
  // When the step ends with focus on the page, it goes back to the control that started it while
  // that control is usable again, else to the open panel, else where a closed panel sends it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the end of a busy step is the trigger
  useLayoutEffect(() => {
    if (busy || !held.current) return;
    const { node, fallback } = held.current;
    held.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const back = node instanceof HTMLElement ? usable(node) : null;
    (
      back ??
      fallback?.() ??
      (panelRef.current?.isConnected ? (heading.current ?? panelRef.current) : null) ??
      landing()
    )?.focus();
  }, [busy]);
  // An answer held during a step is applied the moment the step ends, however it ended. Focus
  // has gone back to the step's control first, so an answer that closes a panel can move it on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the end of a busy step is the trigger
  useLayoutEffect(() => {
    if (busy || !waiting.current) return;
    const { next, asked } = waiting.current;
    waiting.current = null;
    if (asked <= applied.current) return;
    applied.current = asked;
    apply(next);
  }, [busy]);
  // After a save the Name field takes focus once the saved version is back, which ends the busy
  // state, and the field is drawn enabled. A form the saved version leaves read only for a file
  // changed on disk hands focus to the banner's way to the file's version.
  useEffect(() => {
    if (!focusName.current || busy) return;
    focusName.current = false;
    (usable(nameRef.current) ?? usable(fileButton.current))?.focus();
  }, [busy]);

  const shown = older?.body ?? draft;
  const record = read?.entry.record ?? null;
  const schedule = read?.entry.schedule ?? null;
  const readiness = crewReadiness(shown, read, catalog);
  const crewLine = Object.values(readiness)[0] ?? null;
  const fileBlock = file !== null && file !== 'current';
  // The controller refuses to run a report recipe while report runs are off, so Run is off too.
  const runOff = base ? offLines(base, available).run : null;
  // A run starts the version on screen, so it is off whenever the record names another one.
  const canRun =
    record !== null &&
    runOff === null &&
    record.version === baseVersion &&
    baseHash !== null &&
    !touched &&
    older === null &&
    !fileBlock &&
    !crewLine &&
    !busy;
  // An unrecorded file's banner already says why it cannot run, and so does a changed file's,
  // where saving first is no way forward.
  const runBlock =
    file === 'unrecorded' || changedSaved
      ? null
      : !record
        ? 'Save this recipe before you run it.'
        : touched
          ? 'Save your changes before you run.'
          : older || fileBlock
            ? null
            : (runOff ?? crewLine);
  const canReview =
    !busy &&
    panel === null &&
    older === null &&
    file !== 'invalid' &&
    (touched || fileMode || file === 'missing');
  const scheduled = candidate !== null && candidate.trigger.kind !== 'manual';
  const unresolved = resolved?.find((item) => item.digest === null);
  // A save needs a change line, except a file's version or a missing file, which it writes.
  const writesFile = fileMode || file === 'missing';
  const canSave =
    !busy &&
    resolved !== null &&
    problems.length === 0 &&
    !(scheduled && unresolved !== undefined) &&
    file !== 'invalid' &&
    !changedSaved &&
    (changes.length > 0 || writesFile);
  const next = baseVersion + 1;
  const strip = schedule ? stripLine(schedule) : null;

  // The recipe as the controller holds it now: by its record, or by its path for a file never
  // saved. A new recipe has nothing to read.
  const readLatest = (): Promise<PlanRecipeRead | null> =>
    recipeId
      ? readRecipe(source, { projectId, recipeId })
      : target.kind === 'file'
        ? readRecipe(source, { projectId, path: target.path })
        : Promise.resolve(null);

  // Revert takes its own line away, so focus moves to the next line's Revert, else the one
  // before, else the review's heading.
  function revert(path: string) {
    if (!base) return;
    const paths = changes.map((item) => item.path);
    const at = paths.indexOf(path);
    const order = [...paths.slice(at + 1), ...paths.slice(0, at).reverse()];
    update((current) => revertChange(base, current, path));
    focusNext.current = () =>
      order.map((other) => usable(reverts.current.get(other))).find(Boolean) ?? heading.current;
  }

  async function openReview(from: HTMLElement | null) {
    if (!candidate || !canReview) return;
    opener.current = from;
    setTried(true);
    if (problems.length > 0) {
      setStatus(problems[0]?.text ?? '');
      // The first field with a problem takes focus, so the line under it is the next thing read.
      queueMicrotask(() =>
        root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    begin();
    setRefusal(null);
    try {
      // Another window may have saved, or the file may have moved, since this page read it. The
      // answer goes through the same rule as any other once this step ends.
      if (recipeId) {
        askSeq.current += 1;
        const asked = askSeq.current;
        const again = await readRecipe(source, { projectId, recipeId });
        receive(again, asked);
        const version = again.entry.record?.version ?? 0;
        if (again.entry.file !== file && again.entry.file !== 'current') {
          note('The file changed while you edited. Read the line above, then review again.');
          return;
        }
        // With no edits the newer version simply takes the form's place, so there is no review.
        if (version !== baseVersion && !touched) return;
      }
      setPanel('review');
    } catch (error) {
      note(message(error, 'The review could not open.'));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!candidate || !canSave || resolved === null) return;
    begin();
    setRefusal(null);
    try {
      const answer = await saveRecipe(source, {
        projectId,
        ...(recipeId ? { recipeId } : {}),
        path,
        body: candidate,
        expectedVersion: baseVersion,
        ...(scheduled
          ? {
              seen: resolved.flatMap((item) =>
                item.digest ? [{ command: item.command, digest: item.digest }] : [],
              ),
            }
          : {}),
      });
      if ('saved' in answer) {
        const { record: saved } = answer.saved;
        // What was just saved is now the version on screen, so nothing asked before this save
        // can take its place, and the read below finds a draft with no edits.
        applied.current = askSeq.current;
        setBase(candidate);
        setInitial(candidate);
        setDraft(structuredClone(candidate));
        setFileMode(false);
        setBaseVersion(saved.version);
        setBaseHash(saved.versionHash);
        setPanel(null);
        setStale(null);
        setTried(false);
        setStatus(`Saved version ${saved.version}.`);
        focusName.current = true;
        onSaved(saved.id);
        askSeq.current += 1;
        const asked = askSeq.current;
        try {
          receive(await readRecipe(source, { projectId, recipeId: saved.id }), asked);
        } catch (error) {
          setFailure(message(error, 'It could not be read.'));
        }
        setBusy(false);
        return;
      }
      // The recipe is read again and the rule decides what the answer does to the form. A stale
      // answer is told by the banner or the status line the rule picks, so only a refusal, or a
      // stale answer whose read failed, gets its own line.
      if ('refused' in answer) setRefusal(answer.next);
      if (!(await readAgain()) && 'stale' in answer) setRefusal(answer.next);
    } catch (error) {
      setRefusal(message(error, 'The recipe could not be saved.'));
      await readAgain();
    }
    // What refused the save may have moved the checks too, so Save waits for a fresh read. It is
    // off from this render on, so focus never lands on it only to drop when it turns off.
    setResolved(null);
    setChecksAttempt((count) => count + 1);
    setBusy(false);
  }

  async function start() {
    if (!recipeId || !baseHash || !request.trim() || !canRun) return;
    begin();
    setRefusal(null);
    try {
      // The hash of the version on screen, so a newer one is refused, never run unseen.
      const answer = await runRecipe(source, {
        recipeId,
        request: request.trim(),
        versionHash: baseHash,
      });
      if ('run' in answer) {
        setPanel(null);
        setRequest('');
        onOpenThread(answer.run.taskId);
      } else {
        setRefusal(answer.next);
        await readAgain();
      }
    } catch (error) {
      setRefusal(message(error, 'The run could not start.'));
      await readAgain();
    } finally {
      setBusy(false);
    }
  }

  async function act(action: 'pause' | 'resume' | 'restart') {
    if (!recipeId || busy) return;
    // The strip's action may change with the answer, so focus goes to whichever it offers then.
    begin(() => stripActions.current?.querySelector<HTMLElement>('button:not(:disabled)') ?? null);
    setStatus('');
    try {
      await setRecipeSchedule(source, recipeId, action);
    } catch (error) {
      note(message(error, 'The loop did not change.'));
    }
    // Whatever the answer, the strip shows what the controller holds now.
    await readAgain();
    setBusy(false);
  }

  // The current version again. An older one still being read is dropped when it lands.
  const backToCurrent = () => {
    versionAsked.current += 1;
    setOlder(null);
  };
  async function showVersion(version: number) {
    // A panel belongs to the version on screen, so a pick closes it.
    setPanel(null);
    setRefusal(null);
    if (!recipeId || version === record?.version) {
      backToCurrent();
      return;
    }
    versionAsked.current += 1;
    const asked = versionAsked.current;
    try {
      const answer = await readRecipe(source, { projectId, recipeId, version });
      if (asked === versionAsked.current && answer.saved) setOlder({ version, body: answer.saved });
    } catch (error) {
      if (asked === versionAsked.current)
        setStatus(message(error, 'That version could not be read.'));
    }
  }

  // Cmd+S opens the review from anywhere on the page, so it still works after an answer turned
  // the form read only and focus moved to the page heading. An open dialog keeps it.
  shortcut.current = () => {
    if (canReview && !document.querySelector('dialog[open]'))
      void openReview(
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
      );
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      shortcut.current();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

  if (failure)
    return (
      <div className="rc-detail">
        <p className="rc-banner is-stop" role="alert">
          CrewKite could not read this recipe. {failure}
          <button
            type="button"
            className="button secondary"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Try again
          </button>
        </p>
      </div>
    );
  if (!shown)
    return (
      <div className="rc-detail">
        {read?.entry.problem ? (
          <p className="rc-banner is-stop" role="alert">
            This file does not read as a recipe. {read.entry.problem} Fix the file, then open it
            again.
          </p>
        ) : (
          <p className="rc-note" role="status">
            Loading
          </p>
        )}
      </div>
    );

  const descriptionProblem = visible.find((problem) => problem.field === 'description');

  return (
    <div ref={root} className="rc-detail">
      <header className="rc-head">
        <div className="rc-title">
          <label className="rc-sr" htmlFor={`${ids}-name`}>
            Name
          </label>
          <input
            ref={nameRef}
            id={`${ids}-name`}
            className="rc-name"
            type="text"
            placeholder="Name"
            maxLength={80}
            disabled={readOnly}
            aria-invalid={visible.some((problem) => problem.field === 'name') || undefined}
            aria-describedby={`${ids}-status`}
            value={shown.name}
            onChange={(event) => {
              const name = event.target.value;
              change((draftNext) => {
                draftNext.name = name;
              });
              if (!pathEdited) setPath(defaultPath(folder, name));
            }}
          />
          {touched && <span className="rc-edited">Edited</span>}
        </div>
        <div className="rc-meta">
          <span>
            {record
              ? `Version ${record.version}, saved ${when(record.updatedAt)}`
              : 'Not saved yet'}
          </span>
          <span className="rc-actions">
            <button
              type="button"
              className="button secondary"
              disabled={!canRun}
              aria-describedby={
                runBlock ? `${ids}-run-block` : fileBlock ? `${ids}-banner` : undefined
              }
              onClick={(event) => {
                opener.current = event.currentTarget;
                setRefusal(null);
                setPanel('run');
              }}
            >
              <Play size={13} aria-hidden="true" />
              Run
            </button>
            <button
              ref={reviewButton}
              type="button"
              className="button primary"
              disabled={!canReview}
              onClick={(event) => void openReview(event.currentTarget)}
            >
              {writesFile ? 'Review and save' : 'Review changes'}
            </button>
            {read && read.versions.length > 1 && (
              <span className="rc-version">
                <span id={`${ids}-version`}>Version</span>
                <Select
                  id={`${ids}-version-picker`}
                  aria-labelledby={`${ids}-version`}
                  disabled={busy || fileMode}
                  value={String(older?.version ?? record?.version ?? '')}
                  onChange={(event) => void showVersion(Number(event.target.value))}
                >
                  {read.versions.map((item) => (
                    <option key={item.version} value={String(item.version)}>
                      {item.version === record?.version
                        ? `${item.version}, Current`
                        : `${item.version}, ${day(item.savedAt)}`}
                    </option>
                  ))}
                </Select>
              </span>
            )}
          </span>
        </div>
        {runBlock && (
          <p id={`${ids}-run-block`} className="rc-note">
            {runBlock}
          </p>
        )}
        <label className="rc-field" htmlFor={`${ids}-description`}>
          <span className="rc-sr">Description</span>
        </label>
        <textarea
          id={`${ids}-description`}
          className="rc-text"
          placeholder="What this recipe is for."
          maxLength={1000}
          rows={2}
          disabled={readOnly}
          aria-invalid={descriptionProblem ? true : undefined}
          aria-describedby={descriptionProblem ? `${ids}-description-problem` : undefined}
          value={shown.description}
          onChange={(event) => {
            const description = event.target.value;
            change((draftNext) => {
              draftNext.description = description;
            });
          }}
        />
        {descriptionProblem && (
          <p id={`${ids}-description-problem`} className="rc-problem">
            {descriptionProblem.text}
          </p>
        )}
        {record || target.kind === 'file' ? (
          <p className="rc-note">File {read?.entry.path}</p>
        ) : (
          <>
            <label className="rc-path">
              <span>File</span>
              <input
                type="text"
                spellCheck={false}
                maxLength={1024}
                disabled={readOnly}
                aria-invalid={visible.some((problem) => problem.field === 'path') || undefined}
                aria-describedby={`${ids}-path-hint`}
                value={path}
                onChange={(event) => {
                  // The path sits beside the draft, so the edit passes the draft through as it is.
                  update((current) => current);
                  setPath(event.target.value);
                  setPathEdited(true);
                }}
              />
            </label>
            <p
              id={`${ids}-path-hint`}
              className={
                visible.some((problem) => problem.field === 'path') ? 'rc-problem' : 'rc-note'
              }
            >
              A path inside the project.
            </p>
          </>
        )}
        <p id={`${ids}-status`} className="rc-status" role="status" aria-live="polite">
          {status}
        </p>
      </header>

      {older && record ? (
        <div id={`${ids}-banner`} className="rc-banner">
          <p>
            Version {older.version} of {record.version}. Read only.
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() =>
              guard(() => {
                update(() => structuredClone(older.body));
                backToCurrent();
                setFileMode(false);
                focusNext.current = () => usable(nameRef.current);
              })
            }
          >
            Restore as a new version
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              backToCurrent();
              focusNext.current = () => usable(document.getElementById(`${ids}-version-picker`));
            }}
          >
            Back to version {record.version}
          </button>
          {base && (
            <ul className="rc-changes">
              {recipeChanges(older.body, base, label, when).map((item) => (
                <li key={item.path}>
                  <span>{changeWords(item)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : file === 'unrecorded' ? (
        <p id={`${ids}-banner`} className="rc-banner is-warn">
          CrewKite has not saved this file here. Review it and save before it can run.
        </p>
      ) : file === 'changed' && record && fileMode ? (
        <p id={`${ids}-banner`} className="rc-banner is-warn">
          This is the file's version, read only. Saving records it as version {next}.
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              if (base) update(() => structuredClone(base));
              setFileMode(false);
              setPanel(null);
              focusNext.current = () => usable(fileButton.current);
            }}
          >
            Back to version {record.version}
          </button>
        </p>
      ) : file === 'changed' && record ? (
        <p id={`${ids}-banner`} className="rc-banner is-warn">
          The file changed on disk since version {record.version}.
          {schedule && schedule.state !== 'stopped'
            ? ' Its loop is paused until you review it.'
            : ''}
          <button
            ref={fileButton}
            type="button"
            className="button secondary"
            disabled={busy || !read?.recipe}
            onClick={() =>
              guard(() => {
                // The file as last read, which may be newer than when the person clicked.
                const recipe = latest.current.recipe;
                if (!recipe) return;
                update(() => structuredClone(recipe));
                setFileMode(true);
                setPanel(null);
                focusNext.current = () => usable(reviewButton.current);
              })
            }
          >
            Review the file's version
          </button>
        </p>
      ) : file === 'missing' && record ? (
        <p id={`${ids}-banner`} className="rc-banner is-stop">
          The file is gone from the project. Review and save writes it again.
        </p>
      ) : file === 'invalid' && record ? (
        <p id={`${ids}-banner`} className="rc-banner is-stop">
          This file no longer reads as a recipe. {read?.entry.problem} Fix the file, or move it
          aside and write version {record.version} again.
        </p>
      ) : stale !== null && touched ? (
        <p id={`${ids}-banner`} className="rc-banner is-warn">
          {staleWords(stale)}
        </p>
      ) : target.kind === 'new' && target.from ? (
        <div id={`${ids}-banner`} className="rc-banner">
          <p>Drafted from "{target.from}". Review it, name it and save.</p>
          {target.defaults && target.defaults.length > 0 && (
            <p>
              The thread no longer records these, so the draft uses a default:{' '}
              {target.defaults.join(' ')}
            </p>
          )}
        </div>
      ) : null}

      {schedule && strip && !older && (
        <section className={`rc-strip is-${schedule.state}`} aria-label="Loop">
          <p>
            <strong>{strip.word}</strong>
            {strip.rest}
          </p>
          <p>
            {schedule.nextAt ? `Next run ${when(schedule.nextAt)}.` : 'No next run.'}{' '}
            {stripCounts(schedule)}
          </p>
          {read && read.approved.length > 0 && (
            <p>Approved checks: {read.approved.map((item) => item.command).join(', ')}</p>
          )}
          <p className="rc-note">Loops run while CrewKite is open.</p>
          <span ref={stripActions} className="rc-actions">
            {schedule.state === 'active' && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void act('pause')}
              >
                Pause
              </button>
            )}
            {resumable(schedule) && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void act('resume')}
              >
                Resume
              </button>
            )}
            {schedule.state === 'stopped' && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void act('restart')}
              >
                Restart
              </button>
            )}
          </span>
        </section>
      )}

      <div className="rc-graph">
        <h3>Graph</h3>
        <p className="rc-note">
          The crew, how many slices a request may split into, and the order the steps run in. This
          release has one fixed order.
        </p>
      </div>
      <div className="rc-body">
        <div className="rc-left">
          <Steps recipe={shown} catalog={catalog} readiness={readiness} />
        </div>
        <div className="rc-right">
          {panel === 'review' && candidate ? (
            <section
              ref={panelRef}
              className="rc-panel"
              tabIndex={-1}
              aria-labelledby={`${ids}-review`}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !busy) {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                }
              }}
            >
              <h3 id={`${ids}-review`} ref={heading} tabIndex={-1}>
                Review changes
              </h3>
              {/* The same sentence refused the save, so it is announced here and only here. */}
              {changedSaved && (
                <p className="rc-note is-warn" role="status">
                  {read?.entry.path} changed on disk since the last save. Review the file's version
                  first.
                </p>
              )}
              {changes.length > 0 ? (
                <ul className="rc-changes">
                  {changes.map((item) => (
                    <li key={item.path}>
                      <span>{changeWords(item)}</span>
                      {base && !fileMode && (
                        <button
                          ref={(node) => {
                            if (node) reverts.current.set(item.path, node);
                            else reverts.current.delete(item.path);
                          }}
                          type="button"
                          className="button secondary"
                          disabled={busy || changedSaved}
                          onClick={() => revert(item.path)}
                        >
                          Revert
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : writesFile ? (
                <p className="rc-note">
                  Nothing differs from version {baseVersion}. Saving writes the file again.
                </p>
              ) : (
                <p className="rc-note">Nothing differs from version {baseVersion}.</p>
              )}
              {scheduled && (
                <div className="rc-schedule-block">
                  <h4>This loop</h4>
                  <p>Saving arms this loop: {triggerWords(candidate.trigger, when)}.</p>
                  {checksFailure ? null : resolved === null ? (
                    <p>Reading what its checks run.</p>
                  ) : resolved.length === 0 ? (
                    <p>It has no checks.</p>
                  ) : (
                    <>
                      <p>It approves these checks for the runs this loop starts:</p>
                      <ul>
                        {resolved.map((item) => (
                          <li key={item.command}>
                            {/* The controller's line already names the command. */}
                            {item.resolved ??
                              `${item.command} resolves to nothing in this project.`}
                          </li>
                        ))}
                      </ul>
                      <p>A check whose command or script changes later asks before it runs.</p>
                    </>
                  )}
                  <p>{askWords(candidate.run)} Every run stops at ready for Accept.</p>
                  <p>Loops run while CrewKite is open.</p>
                </div>
              )}
              <div aria-live="polite">
                {problems.length > 0 && <p className="rc-problem">{problems[0]?.text}</p>}
                {checksFailure && (
                  <p className="rc-problem">
                    CrewKite could not read what these checks run. {checksFailure}{' '}
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setChecksAttempt((count) => count + 1)}
                    >
                      Try again
                    </button>
                  </p>
                )}
                {scheduled && unresolved && (
                  <p className="rc-problem">
                    {unresolved.command} resolves to nothing in this project. Fix the command or
                    remove the check.
                  </p>
                )}
                {/* On a changed file the first line already says what refused the save. */}
                {refusal && !changedSaved && <p className="rc-problem">{refusal}</p>}
              </div>
              <div className="rc-panel-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={!canSave}
                  onClick={() => void save()}
                >
                  {busy ? 'Saving' : `Save version ${next}`}
                </button>
                <button type="button" className="button secondary" disabled={busy} onClick={close}>
                  Cancel
                </button>
              </div>
            </section>
          ) : panel === 'run' && record ? (
            <section
              ref={panelRef}
              className="rc-panel"
              tabIndex={-1}
              aria-labelledby={`${ids}-run`}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !busy) {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                }
              }}
            >
              <h3 id={`${ids}-run`}>Run {shown.name}</h3>
              <label className="rc-field" htmlFor={`${ids}-request`}>
                <span>Request</span>
                <small id={`${ids}-request-hint`}>What this run should do.</small>
              </label>
              <textarea
                id={`${ids}-request`}
                className="rc-text"
                rows={5}
                maxLength={8000}
                aria-describedby={`${ids}-request-hint`}
                value={request}
                onChange={(event) => setRequest(event.target.value)}
              />
              <p className="rc-note">
                {shown.checks.length > 0
                  ? `Checks: ${shown.checks.map((check) => check.command).join(', ')}`
                  : 'No checks.'}
              </p>
              <p className="rc-note">
                {shown.crew.members
                  .map(
                    (item) =>
                      `${crewRoleNames[item.role]}: ${label(item.selection.family, item.selection.model)}`,
                  )
                  .join(', ')}
              </p>
              <div aria-live="polite">{refusal && <p className="rc-problem">{refusal}</p>}</div>
              <div className="rc-panel-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={!canRun || !request.trim()}
                  onClick={() => void start()}
                >
                  {busy ? 'Starting' : 'Start run'}
                </button>
                <button type="button" className="button secondary" disabled={busy} onClick={close}>
                  Cancel
                </button>
              </div>
            </section>
          ) : (
            <RecipeForm
              draft={shown}
              change={change}
              problems={visible}
              catalog={catalog}
              available={available}
              readiness={readiness}
              readOnly={readOnly}
            />
          )}
        </div>
      </div>

      {record && (
        <Runs
          runs={runs}
          failure={runsFailure}
          version={record.version}
          onOpenThread={(taskId) => guard(() => onOpenThread(taskId))}
        />
      )}

      {record && (
        <footer className="rc-foot">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={(event) => {
              opener.current = event.currentTarget;
              setRefusal(null);
              setPanel('forget');
            }}
          >
            Forget this recipe
          </button>
        </footer>
      )}

      {panel === 'forget' && record && (
        <Dialog title="Forget this recipe" onClose={close}>
          <div className="rc-forget">
            <p>
              CrewKite drops its record, its saved versions and its loop. The file stays in the
              project, and past results stay.
            </p>
            {touched && <p>Your unsaved changes go with it.</p>}
            <div aria-live="polite">{refusal && <p className="rc-problem">{refusal}</p>}</div>
          </div>
          <div className="dialog-footer">
            <button type="button" className="button secondary" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="button stop"
              disabled={busy}
              onClick={() => {
                begin();
                forgetRecipe(source, record.id).then(
                  () => {
                    setBusy(false);
                    setPanel(null);
                    onForgotten();
                  },
                  (error: unknown) => {
                    setBusy(false);
                    setRefusal(message(error, 'It could not be forgotten.'));
                  },
                );
              }}
            >
              Forget
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
