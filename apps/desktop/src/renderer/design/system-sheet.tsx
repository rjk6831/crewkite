import {
  canonicalJson,
  type DesignSystem,
  type DesignSystemRead,
  DesignSystemRecordSchema,
} from '@crewkite/contracts';
import { AlertTriangle, ChevronRight, ListChecks, Search, Undo2, X } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Select } from '../select.tsx';
import {
  type DesignRead,
  readDesignSystem,
  saveDesignSystem,
  setDesignDelivery,
  type ThreadSource,
} from '../thread/commands.ts';
import { DesignContext, type SheetRequest } from './context.ts';
import { CategoryEditor, type Editing, useMedia } from './editors.tsx';
import {
  CATEGORIES,
  type Category,
  categoryLabel,
  type DiffLine,
  diffLines,
  draftKey,
  type EditModel,
  EMPTY_SYSTEM,
  fromModel,
  itemIds,
  type Problem,
  revertLine,
  type TokenDraft,
  toModel,
} from './model.ts';
import { plainProblem } from './start.ts';
import { notMapped, type Started, StartPanel } from './start-panel.tsx';
import { versionLine } from './system-card.tsx';
import '../thread/subagents.css';
import './design.css';

const DEFAULT_PATH = 'design-system.json';
// Below this width the rail turns into a Select and the diff into a panel behind a button.
const NARROW = '(max-width: 959px)';

/**
 * The version the edits started from, and when it was saved. Version 0 is a project with nothing
 * saved yet. The title bar shows this one, so a version saved elsewhere changes it only when the
 * person picks it.
 */
type Base = { version: number; system: DesignSystem; key: string; updatedAt: string | null };
type Confirm = { text: string; action: string; run: () => void };
/** What the review was opened against, so a file that moves before Save is caught. */
type Basis = {
  version: number;
  disk: DesignSystem | null;
  diskKey: string | null;
  file: DesignSystemRead['file'];
};

const keyOf = (system: DesignSystem) => canonicalJson(system);
const PLURAL: Record<Category, string> = {
  color: 'colors',
  type: 'type tokens',
  spacing: 'spacing steps',
  radius: 'radius tokens',
  shadow: 'shadows',
  motion: 'motion tokens',
  components: 'components',
  rules: 'rules',
};
// An import adds every token at once. Past this many in a category, the added lines fold into one
// count that opens on a click.
const FOLD_ADDED = 3;
const isColor = (value: string) => typeof CSS !== 'undefined' && CSS.supports('color', value);
const needFixing = (count: number) =>
  `${count} ${count === 1 ? 'value needs' : 'values need'} fixing`;

/** The token a finding's value becomes. Its name is left for the person. */
function addedToken(add: NonNullable<SheetRequest['add']>): TokenDraft {
  const type =
    add.group === 'color'
      ? 'color'
      : add.group === 'type'
        ? 'fontFamily'
        : add.group === 'shadow'
          ? 'shadow'
          : 'dimension';
  return { key: draftKey(), name: '', type, value: add.value, description: '' };
}

/**
 * The editor host and the context every view opens it through. The editor is a modal dialog at
 * the app root, so Settings and the thread inspector open the same sheet, and the Escape handlers
 * behind it stand down while it is open. Focus goes back to the control that opened it.
 */
export function DesignSystemHost({
  source,
  projects,
  children,
}: {
  source: ThreadSource | undefined;
  projects: readonly { id: string; name: string }[];
  children: ReactNode;
}) {
  const [request, setRequest] = useState<(SheetRequest & { id: number }) | null>(null);
  const [saved, setSaved] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const count = useRef(0);
  const open = useCallback((next: SheetRequest) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    count.current += 1;
    setRequest({ ...next, id: count.current });
  }, []);
  // Runs once the dialog has left the page, so focus lands where the person started.
  useLayoutEffect(() => {
    if (request) return;
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected && document.activeElement !== target) target.focus();
  }, [request]);
  const value = useMemo(() => ({ open, saved }), [open, saved]);
  const project = request && projects.find(({ id }) => id === request.projectId);
  return (
    <DesignContext.Provider value={value}>
      {children}
      {request && source && (
        <DesignSystemSheet
          key={request.id}
          source={source}
          request={request}
          projectName={project?.name ?? 'Project'}
          onSaved={() => setSaved((value) => value + 1)}
          onClose={() => setRequest(null)}
        />
      )}
    </DesignContext.Provider>
  );
}

/**
 * A project's design system, edited for minutes at a time with live specimens. The diff against
 * the version the edits started from is always on screen, and nothing is written until the person
 * confirms the review. Before each review the file and the record are read again, so an edit on
 * disk or a version saved elsewhere surfaces as a banner with its choices.
 */
export function DesignSystemSheet({
  source,
  request,
  projectName,
  onSaved,
  onClose,
}: {
  source: ThreadSource;
  request: SheetRequest;
  projectName: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const ids = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const confirmCancel = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const focusAfter = useRef<string | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const narrow = useMedia(NARROW);
  const { projectId } = request;

  const [read, setRead] = useState<DesignRead | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [model, setModel] = useState<EditModel | null>(null);
  const [banner, setBanner] = useState<{ text: string; skipped: number | null } | null>(null);
  const [path, setPath] = useState(DEFAULT_PATH);
  const [category, setCategory] = useState<Category>(request.add?.group ?? 'color');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [ack, setAck] = useState<string | null>(null);
  const [panel, setPanel] = useState<'editor' | 'review' | 'changes'>('editor');
  const [basis, setBasis] = useState<Basis | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [filter, setFilter] = useState('');
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [said, setSaid] = useState({ count: 0, text: '' });
  const say = (text: string) => setSaid((previous) => ({ count: previous.count + 1, text }));

  // Closing the dialog before it leaves the page ends the modal state, so the page behind is no
  // longer inert when the host puts focus back on the opener.
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the sheet loads once for the request it opened with
  useEffect(() => {
    let live = true;
    readDesignSystem(source, projectId).then(
      (next) => {
        if (!live) return;
        setRead(next);
        if (!next.record) {
          setBase({ version: 0, system: EMPTY_SYSTEM, key: keyOf(EMPTY_SYSTEM), updatedAt: null });
          return;
        }
        if (!next.system) {
          setFailure('The saved version could not be read. Close the editor and try again.');
          return;
        }
        setBase({
          version: next.record.version,
          system: next.system,
          key: keyOf(next.system),
          updatedAt: next.record.updatedAt,
        });
        setPath(next.record.path);
        const loaded = toModel(next.system);
        if (request.add) {
          const token = addedToken(request.add);
          loaded.tokens[request.add.group].push(token);
          // Escape puts the drafted token back as it came, so the found value is never lost.
          setEditing({ key: token.key, snapshot: token });
          setBanner({
            text: `Draft adds ${request.add.value} from ${request.add.file}:${request.add.line} as a new token. Name it, then review and save. Nothing is saved yet.`,
            skipped: null,
          });
        }
        setModel(loaded);
      },
      (error: unknown) =>
        live &&
        setFailure(error instanceof Error ? error.message : 'The design system could not be read.'),
    );
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const next = await readDesignSystem(source, projectId);
    setRead(next);
    return next;
  }, [source, projectId]);
  // Another window, the command line or a hand edit can change the file or the record while the
  // sheet is open. Coming back to the window reads both again.
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') void refresh().catch(() => {});
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [refresh]);

  const parsed = useMemo(() => (model ? fromModel(model, isColor) : null), [model]);
  const lines = useMemo(
    () => (parsed && base ? [...diffLines(base.system, parsed.system), ...parsed.unfinished] : []),
    [parsed, base],
  );
  const problems = parsed?.problems ?? [];
  const byKey = useMemo(() => {
    const map = new Map<string, Problem[]>();
    for (const problem of problems)
      map.set(problem.key, [...(map.get(problem.key) ?? []), problem]);
    return map;
  }, [problems]);
  const record = read?.record ?? null;
  const diskKey = read?.file === 'changed' && read.system ? keyOf(read.system) : null;
  const stale = record && base && record.version > base.version ? record : null;
  const conflict =
    !stale && diskKey !== null && base !== null && diskKey !== base.key && diskKey !== ack;
  const unsaved = lines.length > 0 || problems.length > 0;
  const pathProblem =
    record || DesignSystemRecordSchema.shape.path.safeParse(path.trim()).success
      ? null
      : 'Use a path inside the project, such as design-system.json.';
  const canReview =
    model !== null &&
    base !== null &&
    !busy &&
    !stale &&
    !conflict &&
    problems.length === 0 &&
    !pathProblem &&
    read?.file !== 'invalid' &&
    (lines.length > 0 || read?.file === 'missing' || read?.file === 'changed');

  // Focus moves to a row once the render that shows it is on screen.
  useEffect(() => {
    const key = focusAfter.current;
    if (!key) return;
    const row = dialog.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);
    if (!row) return;
    focusAfter.current = null;
    row.focus();
    row.scrollIntoView?.({ block: 'nearest' });
  });
  const focusRow = useCallback((key: string) => {
    focusAfter.current = key;
  }, []);
  useEffect(() => {
    if (confirm) confirmCancel.current?.focus();
  }, [confirm]);
  useEffect(() => {
    if (panel === 'review') reviewHeading.current?.focus();
  }, [panel]);

  const ask = (next: Confirm) => {
    returnTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirm(next);
  };
  const dismiss = () => {
    setConfirm(null);
    const target = returnTo.current;
    returnTo.current = null;
    requestAnimationFrame(() => target?.isConnected && target.focus());
  };
  const guarded = (text: string, action: string, run: () => void) => {
    if (unsaved) ask({ text, action, run });
    else run();
  };
  function requestClose() {
    if (unsaved)
      ask({
        text: 'Close without saving? Your changes are not saved.',
        action: 'Close without saving',
        run: onClose,
      });
    else onClose();
  }
  function load(system: DesignSystem, version: number, updatedAt: string | null, text: string) {
    setBase({ version, system, key: keyOf(system), updatedAt });
    setModel(toModel(system));
    setEditing(null);
    setAck(null);
    setBanner(null);
    setPanel('editor');
    say(text);
  }
  function discard() {
    if (!base) return;
    if (!record) setModel(null);
    else setModel(toModel(base.system));
    setBanner(null);
    setEditing(null);
    say('Discarded the unsaved changes.');
  }
  function start(started: Started) {
    setModel(toModel(started.system));
    setBanner({ text: started.banner, skipped: started.skipped });
    if (started.path) setPath(started.path);
    setCategory('color');
    say(started.banner);
  }

  async function openReview() {
    if (!canReview || !base) return;
    setSaveNote(null);
    let latest: DesignRead;
    try {
      latest = await refresh();
    } catch (error) {
      setSaveNote(error instanceof Error ? error.message : 'The design system could not be read.');
      return;
    }
    // A version saved elsewhere or a new edit on disk shows its banner, and the review waits.
    if ((latest.record?.version ?? 0) !== base.version) return;
    const disk = latest.file === 'changed' ? latest.system : null;
    const key = disk ? keyOf(disk) : null;
    if (key && key !== base.key && key !== ack) return;
    setBasis({ version: base.version, disk, diskKey: key, file: latest.file });
    setPanel('review');
  }

  async function save() {
    if (!parsed || !base || !basis || problems.length > 0) return;
    setBusy(true);
    setSaveNote(null);
    try {
      const latest = await refresh();
      const disk = latest.file === 'changed' ? latest.system : null;
      if (
        (latest.record?.version ?? 0) !== basis.version ||
        (disk ? keyOf(disk) : null) !== basis.diskKey
      ) {
        setPanel('editor');
        say('The file or the saved version changed while you reviewed. Review again.');
        return;
      }
      const body = parsed.system;
      const sent = model;
      const target = latest.record?.path ?? path.trim();
      let expected = base.version;
      // The file holds someone's edit. It is recorded as its own version first, so the history
      // keeps it, and the person's version lands on top.
      if (disk && keyOf(disk) !== keyOf(body)) {
        const first = await saveDesignSystem(source, {
          projectId,
          path: target,
          body: disk,
          expectedVersion: expected,
        });
        if (!('saved' in first)) {
          await refresh().catch(() => {});
          setSaveNote(first.next);
          return;
        }
        expected = first.saved.record.version;
        // The file's version is recorded now, so a refusal below compares against it.
        setBase({
          version: expected,
          system: disk,
          key: keyOf(disk),
          updatedAt: first.saved.record.updatedAt,
        });
      }
      const answer = await saveDesignSystem(source, {
        projectId,
        path: target,
        body,
        expectedVersion: expected,
      });
      if (!('saved' in answer)) {
        await refresh().catch(() => {});
        // After the file's version was recorded, the review no longer matches; the editor shows
        // the edits against that version and the sentence below says what refused.
        if ('stale' in answer || expected !== base.version) setPanel('editor');
        setSaveNote(answer.next);
        return;
      }
      const version = answer.saved.record.version;
      setBase({
        version,
        system: body,
        key: keyOf(body),
        updatedAt: answer.saved.record.updatedAt,
      });
      // Edits typed while the save ran stay; the diff then shows them against the new version.
      setModel((current) => (current === sent ? toModel(body) : current));
      setPath(answer.saved.record.path);
      setEditing(null);
      setAck(null);
      setBanner(null);
      setBasis(null);
      setPanel('editor');
      say(`Saved version ${version}.`);
      onSaved();
      await refresh().catch(() => {});
    } catch (error) {
      setSaveNote(error instanceof Error ? error.message : 'Nothing was saved.');
    } finally {
      setBusy(false);
    }
  }

  async function deliver(enabled: boolean) {
    setDelivering(true);
    try {
      await setDesignDelivery(source, projectId, enabled);
      // The card shows the switch too, and reads the record again on this signal.
      onSaved();
      await refresh();
      say(
        enabled
          ? 'Writing roles receive it from their next turn.'
          : 'Writing roles no longer receive it.',
      );
    } catch (error) {
      say(error instanceof Error ? error.message : 'The switch did not change.');
    } finally {
      setDelivering(false);
    }
  }

  async function importAgain() {
    try {
      const latest = await refresh();
      if (latest.file === 'invalid') say('The file still does not read. Fix the line named above.');
      else if (latest.file === 'changed' && latest.system && base) {
        const system = latest.system;
        guarded(
          "Load the file's version? Your unsaved changes are discarded.",
          "Load the file's version",
          () => load(system, base.version, base.updatedAt, "Loaded the file's version."),
        );
      } else
        say(
          latest.file === 'missing'
            ? 'The file is not on disk. Saving writes it again.'
            : 'The file reads again.',
        );
    } catch (error) {
      say(error instanceof Error ? error.message : 'The file could not be read.');
    }
  }

  function jump(target: { category: Category; key?: string; path?: string }) {
    setPanel('editor');
    setCategory(target.category);
    if (!model) return;
    let key = target.key;
    if (!key && target.path?.startsWith('new:')) key = target.path.slice(4);
    else if (!key && target.path) {
      if (target.category === 'components' || target.category === 'rules') {
        const drafts = model[target.category];
        key = drafts[itemIds(drafts).indexOf(target.path)]?.key;
      } else {
        const name = target.path.slice(target.category.length + 1);
        key = model.tokens[target.category].find((draft) => draft.name.trim() === name)?.key;
      }
    }
    if (key) focusRow(key);
  }
  function fix(problem: Problem) {
    setPanel('editor');
    setCategory(problem.category);
    setFilter('');
    if (!model || problem.key === 'system') return;
    const draft =
      problem.category === 'components' || problem.category === 'rules'
        ? model[problem.category].find((value) => value.key === problem.key)
        : model.tokens[problem.category].find((value) => value.key === problem.key);
    if (draft) setEditing({ key: draft.key, snapshot: draft });
  }

  // The sheet hears its keys on the window: a removed row can leave focus on the page body, and the
  // save, filter and Escape keys still belong to the sheet then. Handlers inside it that already
  // took a key stop it before it gets here.
  function keyDown(event: globalThis.KeyboardEvent) {
    // A key that composes text belongs to the field.
    if (event.isComposing) return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    // While a save runs, the sheet stays as it is: no close, no filter, no second review.
    if (busy) {
      if (event.key === 'Escape' || (command && (key === 's' || key === 'f')))
        event.preventDefault();
      return;
    }
    if (command && key === 's') {
      event.preventDefault();
      if (!event.repeat && panel === 'editor') void openReview();
      return;
    }
    if (command && key === 'f') {
      if (!model) return;
      event.preventDefault();
      setPanel('editor');
      requestAnimationFrame(() => {
        filterField.current?.focus();
        filterField.current?.select();
      });
      return;
    }
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // The sheet owns Escape, so the browser never closes the dialog behind the person's back.
    event.preventDefault();
    if (confirm) dismiss();
    else if (panel !== 'editor') setPanel('editor');
    else if (editing) setEditing(null);
    else if (filter && document.activeElement === filterField.current) setFilter('');
    else requestClose();
  }
  const keys = useRef(keyDown);
  keys.current = keyDown;
  useEffect(() => {
    const listen = (event: globalThis.KeyboardEvent) => keys.current(event);
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, []);

  const counts = (id: Category) =>
    !model ? 0 : id === 'components' || id === 'rules' ? model[id].length : model.tokens[id].length;
  const invalid = (id: Category) => problems.some((problem) => problem.category === id);
  const versionText =
    base && base.version > 0 && base.updatedAt
      ? versionLine({ version: base.version, updatedAt: base.updatedAt })
      : 'Not saved yet';
  const comparison = basis?.disk ?? base?.system ?? EMPTY_SYSTEM;
  const reviewLines = panel === 'review' && parsed ? diffLines(comparison, parsed.system) : [];
  const twoStep = basis?.disk && parsed && keyOf(basis.disk) !== keyOf(parsed.system);
  const nextVersion = (base?.version ?? 0) + (twoStep ? 2 : 1);

  const diffList = (shown: readonly DiffLine[], revert: boolean) =>
    CATEGORIES.filter(({ id }) => shown.some((line) => line.category === id)).map(
      ({ id, label }) => {
        const all = shown.filter((line) => line.category === id);
        const added = all.filter((line) => line.kind === 'added' && !line.key.startsWith('new:'));
        const fold = `${revert ? 'column' : 'review'}:${id}`;
        const folds = added.length > FOLD_ADDED;
        const open = !folds || unfolded.has(fold);
        const visible = open ? all : all.filter((line) => !added.includes(line));
        return (
          <section key={id} className="ds-diff-group" aria-label={label}>
            <h4>{label}</h4>
            <ul>
              {folds && (
                <li className="ds-diff-line is-added is-fold">
                  <button
                    type="button"
                    className="ds-diff-text"
                    aria-expanded={open}
                    onClick={() =>
                      setUnfolded((now) => {
                        const next = new Set(now);
                        if (!next.delete(fold)) next.add(fold);
                        return next;
                      })
                    }
                  >
                    {`Added ${added.length} ${PLURAL[id]}`}
                    <ChevronRight size={12} aria-hidden="true" className="ds-fold-mark" />
                  </button>
                </li>
              )}
              {visible.map((line) => (
                <li key={line.key} className={`ds-diff-line is-${line.kind}`}>
                  {revert ? (
                    <button
                      type="button"
                      className="ds-diff-text"
                      onClick={() => jump({ category: line.category, path: line.path })}
                    >
                      {line.text}
                    </button>
                  ) : (
                    <span className="ds-diff-text">{line.text}</span>
                  )}
                  {revert && model && base && (
                    <button
                      type="button"
                      className="icon-button ds-revert"
                      aria-label={`Revert: ${line.text}`}
                      title="Revert"
                      onClick={() => {
                        setModel(revertLine(model, base.system, line));
                        setEditing(null);
                        say(`Reverted: ${line.text}.`);
                      }}
                    >
                      <Undo2 size={13} aria-hidden="true" />
                    </button>
                  )}
                  {line.named && (
                    <small className="ds-named">
                      {`Still named in the example of ${line.named
                        .map((title) => `"${title.replace(/\.$/, '')}"`)
                        .join(', ')}.`}
                    </small>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      },
    );

  const changesColumn = (
    <>
      <div className="ds-diff-head">
        <h3 id={`${ids}-changes`}>
          {record
            ? `Changes against version ${base?.version ?? record.version}`
            : 'Changes in this draft'}
        </h3>
        <span className="ds-count">{lines.length === 0 ? 'None' : `${lines.length}`}</span>
      </div>
      {problems.length > 0 && (
        <div className="ds-problems">
          <p>
            <AlertTriangle size={13} aria-hidden="true" /> {needFixing(problems.length)}
          </p>
          <ul>
            {problems.map((problem) => (
              <li key={`${problem.key}-${problem.field}`}>
                <button type="button" onClick={() => fix(problem)}>
                  <code>{problem.label}</code> {problem.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {lines.length === 0 ? (
        <p className="ds-hint">
          {record
            ? `No changes against version ${base?.version ?? record.version}.`
            : 'No tokens yet.'}
        </p>
      ) : (
        diffList(lines, true)
      )}
    </>
  );

  const fileProblem =
    read?.file === 'missing' || read?.file === 'invalid' ? (
      <div className="ds-banner is-warning" role="status">
        <AlertTriangle size={15} aria-hidden="true" />
        <div>
          {read.file === 'missing' ? (
            <p>
              {record?.path} is not on disk. The editor shows version {record?.version}, and saving
              writes the file again.
            </p>
          ) : (
            <p>
              {record?.path} does not read as a design system.{' '}
              {read.problem ? plainProblem(read.problem, record?.path) : ''}
            </p>
          )}
          {read.file === 'invalid' && (
            <p className="ds-hint">
              Saving waits until the file reads. Fix it, then import it again.
            </p>
          )}
        </div>
        <div className="ds-banner-actions">
          {read.file === 'invalid' ? (
            <button type="button" className="button secondary" onClick={() => void importAgain()}>
              Import this file again
            </button>
          ) : (
            <button
              type="button"
              className="button secondary"
              disabled={!canReview}
              onClick={() => void openReview()}
            >
              Write the file again
            </button>
          )}
        </div>
      </div>
    ) : null;

  const body = !base ? (
    <div className="ds-loading" role="status">
      {failure ?? 'Reading the design system.'}
    </div>
  ) : !model ? (
    <div className="ds-body is-start">
      <StartPanel
        source={source}
        projectId={projectId}
        focus={request.start}
        isColor={isColor}
        onStart={start}
      />
    </div>
  ) : (
    <div className="ds-body" hidden={panel !== 'editor'}>
      {!narrow && (
        <nav className="ds-rail" aria-label="Categories">
          <div
            role="listbox"
            aria-label="Categories"
            onKeyDown={(event) => {
              const order = CATEGORIES.map(({ id }) => id);
              const at = order.indexOf(category);
              const to =
                event.key === 'ArrowDown'
                  ? Math.min(order.length - 1, at + 1)
                  : event.key === 'ArrowUp'
                    ? Math.max(0, at - 1)
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? order.length - 1
                        : null;
              if (to !== null) {
                event.preventDefault();
                const next = order[to] as Category;
                setCategory(next);
                setEditing(null);
                document.getElementById(`${ids}-cat-${next}`)?.focus();
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                // The first token or rule, else the first control, such as Add color.
                const body = dialog.current?.querySelector('.ds-editor-body');
                (
                  body?.querySelector<HTMLElement>('[data-row]') ??
                  body?.querySelector<HTMLElement>('button, input')
                )?.focus();
              }
            }}
          >
            {CATEGORIES.map(({ id, label }) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox around the options takes their keys
              <div
                key={id}
                id={`${ids}-cat-${id}`}
                role="option"
                tabIndex={category === id ? 0 : -1}
                aria-selected={category === id}
                className={category === id ? 'ds-rail-item is-active' : 'ds-rail-item'}
                onClick={() => {
                  setCategory(id);
                  setEditing(null);
                }}
              >
                <span>{label}</span>
                {invalid(id) && (
                  <span className="ds-rail-invalid" role="img" aria-label="needs fixing">
                    <AlertTriangle size={12} aria-hidden="true" />
                  </span>
                )}
                <span className="ds-rail-count">{counts(id)}</span>
              </div>
            ))}
          </div>
        </nav>
      )}
      <section className="ds-editor" aria-labelledby={`${ids}-category`}>
        <div className="ds-editor-head">
          {narrow ? (
            // The Select shows the category itself, so its label is for screen readers and the
            // controls in this row share one line.
            <div className="ds-category-select">
              <span className="ds-sr" id={`${ids}-category`}>
                Category
              </span>
              <Select
                aria-labelledby={`${ids}-category`}
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value as Category);
                  setEditing(null);
                }}
              >
                {CATEGORIES.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {`${label} (${counts(id)})${invalid(id) ? ', needs fixing' : ''}`}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <h3 id={`${ids}-category`}>
              {categoryLabel(category)} <span className="ds-count">{counts(category)}</span>
            </h3>
          )}
          <div className="ds-filter">
            <Search size={13} aria-hidden="true" />
            <input
              ref={filterField}
              type="search"
              aria-label="Filter by name or value"
              aria-keyshortcuts="Meta+F Control+F"
              placeholder="Filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          {narrow && (
            <button type="button" className="button secondary" onClick={() => setPanel('changes')}>
              <ListChecks size={14} aria-hidden="true" />
              Review changes ({lines.length})
            </button>
          )}
        </div>
        <div className="ds-editor-body">
          <CategoryEditor
            category={category}
            model={model}
            change={(update) => setModel((current) => (current ? update(current) : current))}
            problems={byKey}
            editing={editing}
            setEditing={setEditing}
            filter={filter.trim()}
            isColor={isColor}
            focusRow={focusRow}
          />
        </div>
      </section>
      {!narrow && (
        <aside className="ds-diff" aria-labelledby={`${ids}-changes`}>
          {changesColumn}
        </aside>
      )}
    </div>
  );

  return (
    <dialog
      ref={dialog}
      className="ds-sheet"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-meta`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && !confirm && panel === 'editor' && !editing) requestClose();
      }}
    >
      <header className="ds-titlebar">
        <div className="ds-title">
          <h2 id={`${ids}-title`}>Design system</h2>
          {/* The file field sits in the meta line, so a draft keeps the title bar's height. */}
          <div id={`${ids}-meta`} className="ds-meta">
            <span>{projectName}</span>
            {record ? (
              <code>{record.path}</code>
            ) : model ? (
              <span className="ds-path">
                <label htmlFor={`${ids}-path`}>File</label>
                <input
                  id={`${ids}-path`}
                  value={path}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={pathProblem ? true : undefined}
                  aria-describedby={pathProblem ? `${ids}-path-problem` : undefined}
                  onChange={(event) => setPath(event.target.value)}
                />
                {pathProblem && (
                  <span className="ds-meta-invalid" id={`${ids}-path-problem`}>
                    {pathProblem}
                  </span>
                )}
              </span>
            ) : null}
            <span>{versionText}</span>
            {problems.length > 0 && (
              <span className="ds-meta-invalid">{needFixing(problems.length)}</span>
            )}
          </div>
        </div>
        {record && (
          <label className="sa-switch ds-delivery">
            <input
              type="checkbox"
              role="switch"
              checked={record.delivery}
              aria-checked={record.delivery}
              disabled={delivering}
              onChange={(event) => void deliver(event.target.checked)}
            />
            <span>Send to writing roles</span>
          </label>
        )}
        <div className="ds-actions">
          {model && (
            <>
              <button
                type="button"
                className="button secondary"
                disabled={(!unsaved && !banner) || busy}
                onClick={() =>
                  ask({
                    text: 'Discard every unsaved change?',
                    action: 'Discard changes',
                    run: discard,
                  })
                }
              >
                Discard changes
              </button>
              <button
                type="button"
                className="button primary"
                disabled={!canReview || panel === 'review'}
                aria-keyshortcuts="Meta+S Control+S"
                onClick={() => void openReview()}
              >
                Review and save
              </button>
            </>
          )}
          <button
            type="button"
            className="icon-button ds-close"
            disabled={busy}
            aria-label="Close design system"
            onClick={requestClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      {confirm && (
        <div className="ds-banner ds-confirm" role="alertdialog" aria-labelledby={`${ids}-confirm`}>
          <p id={`${ids}-confirm`}>{confirm.text}</p>
          <div className="ds-banner-actions">
            <button
              type="button"
              className="button stop"
              onClick={() => {
                setConfirm(null);
                returnTo.current = null;
                confirm.run();
              }}
            >
              {confirm.action}
            </button>
            <button
              ref={confirmCancel}
              type="button"
              className="button secondary"
              onClick={dismiss}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}
      {stale && (
        <div className="ds-banner is-warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <p>Version {stale.version} was saved elsewhere.</p>
          <div className="ds-banner-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                const system = read?.system;
                if (!system) return;
                guarded(
                  `Load version ${stale.version}? Your unsaved changes are discarded.`,
                  `Load version ${stale.version}`,
                  () =>
                    load(
                      system,
                      stale.version,
                      stale.updatedAt,
                      `Loaded version ${stale.version}.`,
                    ),
                );
              }}
            >
              Load version {stale.version}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                if (!read?.system) return;
                setBase({
                  version: stale.version,
                  system: read.system,
                  key: keyOf(read.system),
                  updatedAt: stale.updatedAt,
                });
                setAck(null);
                say(`The changes column now compares against version ${stale.version}.`);
              }}
            >
              Review your changes against it
            </button>
          </div>
        </div>
      )}
      {conflict && (
        <div className="ds-banner is-warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <p>The file changed on disk since you opened it.</p>
          <div className="ds-banner-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                const system = read?.system;
                if (!system || !base) return;
                guarded(
                  "Load the file's version? Your unsaved changes are discarded.",
                  "Load the file's version",
                  () => load(system, base.version, base.updatedAt, "Loaded the file's version."),
                );
              }}
            >
              Load the file's version
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setAck(diskKey);
                say("Kept your edits. The review compares them with the file's version.");
              }}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}
      {!stale && !conflict && fileProblem}
      {!stale && !conflict && record && read?.file === 'changed' && (
        <p className="ds-note">
          The file on disk differs from version {record.version}. Saving records the file's version
          first, so the history keeps it.
        </p>
      )}
      {banner && model && (
        <div className="ds-banner is-draft" role="status">
          <p>
            {banner.text}
            {banner.skipped !== null && banner.skipped > 0 && ` ${notMapped(banner.skipped)}`}
          </p>
        </div>
      )}
      {body}
      {panel === 'changes' && narrow && model && (
        <section className="ds-panel" aria-labelledby={`${ids}-changes`}>
          {changesColumn}
          <div className="ds-panel-actions">
            <button type="button" className="button secondary" onClick={() => setPanel('editor')}>
              Back to editing
            </button>
          </div>
        </section>
      )}
      {panel === 'review' && model && (
        <section className="ds-panel ds-review" aria-labelledby={`${ids}-review`}>
          <h3 id={`${ids}-review`} ref={reviewHeading} tabIndex={-1}>
            Review version {nextVersion}
          </h3>
          <p className="ds-hint">
            {!record
              ? `Saving writes ${path.trim()} in ${projectName} and records it as version 1. Writing roles receive it from their next turn.`
              : twoStep
                ? `The file on disk differs from version ${base?.version}. Saving records the file's version as version ${(base?.version ?? 0) + 1}, then yours as version ${nextVersion}. The list compares yours with the file.`
                : basis?.file === 'missing'
                  ? `${record.path} is not on disk. Saving writes it again as version ${nextVersion}.`
                  : basis?.disk
                    ? `Saving records the file's version as version ${nextVersion}.`
                    : `Saving writes ${record.path} and records version ${nextVersion}. Nothing is committed.`}
          </p>
          {reviewLines.length === 0 ? (
            <p className="ds-hint">No token, component or rule changes.</p>
          ) : (
            diffList(reviewLines, false)
          )}
          {saveNote && (
            <p className="ds-field-error" role="alert">
              {saveNote}
            </p>
          )}
          <div className="ds-panel-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? 'Saving' : `Save version ${nextVersion}`}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setPanel('editor')}
            >
              Back to editing
            </button>
          </div>
        </section>
      )}
      {saveNote && panel !== 'review' && (
        <p className="ds-note is-error" role="alert">
          {saveNote}
        </p>
      )}
      {/* A zero-width mark on alternate lines lets the same sentence be read twice in a row. */}
      <p className="ds-sr" role="status" aria-live="polite" aria-atomic="true">
        {said.text}
        {said.count % 2 === 0 ? '' : '​'}
      </p>
    </dialog>
  );
}
