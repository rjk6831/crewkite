import type { DesktopSource } from '@crewkite/client';
import { type ResultsRead, ResultsReadSchema } from '@crewkite/contracts';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { read as readCommand, type ThreadSource } from '../thread/commands.ts';
import {
  crewRows,
  exportedLine,
  isEmpty,
  moreRecipesLine,
  moreRowsLine,
  recipeRows,
  scopeLine,
} from './results-model.ts';

// What the controller recorded for one project, as counts. The view ranks nothing and suggests
// nothing. It reads again when the recipes change or the window comes back to the front, and a
// read that fails leaves the last good counts on screen under the reason.

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

export const readResults = (source: ThreadSource, projectId: string): Promise<ResultsRead> =>
  readCommand(source, 'ReadResults', { projectId }, ResultsReadSchema);

type Shown<T> = { projectId: string; value: T };

export function ResultsView({
  source,
  projectId,
}: {
  source: ThreadSource & Pick<DesktopSource, 'saveResults'>;
  projectId: string;
}) {
  const ids = useId();
  const [shownRead, setRead] = useState<Shown<ResultsRead> | null>(null);
  const [shownFailure, setFailure] = useState<Shown<string> | null>(null);
  const [changed, setChanged] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [shownLine, setLine] = useState<Shown<string> | null>(null);
  const out = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const exportButton = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLElement>(null);
  const restore = useRef(false);
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

  // What belongs to another project is never drawn under this one.
  const read = shownRead?.projectId === projectId ? shownRead.value : null;
  const failure = shownFailure?.projectId === projectId ? shownFailure.value : null;
  const line = shownLine?.projectId === projectId ? shownLine.value : null;

  const load = useCallback(async () => {
    if (!live.current) return;
    asked.current += 1;
    const mine = asked.current;
    // A control that this answer removes loses focus. It goes to the heading below.
    const keepFocus = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.dataset.results && root.current?.contains(active))
        restore.current = true;
    };
    try {
      const next = await readResults(source, projectId);
      if (!live.current || mine <= shown.current) return;
      shown.current = mine;
      keepFocus();
      setRead({ projectId, value: next });
      setFailure(null);
    } catch (error) {
      if (!live.current || mine <= shown.current) return;
      shown.current = mine;
      keepFocus();
      setFailure({ projectId, value: message(error, 'They could not be read.') });
    }
  }, [source, projectId]);

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
  // A run settles without an event from this window, so a window that comes back to the front
  // reads again, as the rest of the page does.
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

  // A control that had focus and is gone now hands it to the heading, never to the page.
  useLayoutEffect(() => {
    if (!restore.current) return;
    restore.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) heading.current?.focus();
  });

  async function exportFile() {
    if (out.current || !source.saveResults) return;
    out.current = true;
    setExporting(true);
    setLine(null);
    try {
      const answer = await source.saveResults(projectId);
      if (!live.current) return;
      // A cancelled dialog shows nothing.
      setLine(
        answer === 'cancelled'
          ? null
          : { projectId, value: exportedLine(answer.records, answer.file) },
      );
    } catch (error) {
      if (!live.current) return;
      setLine({
        projectId,
        value: message(error, 'The file could not be written there. Choose another place.'),
      });
    } finally {
      out.current = false;
      if (live.current) {
        setExporting(false);
        // Focus stays on the button unless the person took it somewhere else meanwhile.
        const active = document.activeElement;
        if ((!active || active === document.body) && exportButton.current?.isConnected)
          exportButton.current.focus();
      }
    }
  }

  const empty = read !== null && isEmpty(read);
  const scope = read ? scopeLine(read, day) : null;
  const recipes = read ? recipeRows(read.recipes) : [];
  const crew = read ? crewRows(read.crew) : [];

  return (
    <section ref={root} className="rc-results" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} ref={heading} tabIndex={-1}>
        Results
      </h2>
      <p className="rc-note">Counts from this device. Nothing here is uploaded.</p>
      {scope && <p className="rc-note">{scope}</p>}
      {failure && (
        <p className="rc-banner is-stop" role="alert">
          CrewKite could not read the results. {failure}
          <button
            type="button"
            className="button secondary"
            data-results="retry"
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
      ) : empty ? (
        <p className="rc-results-empty">No results yet. They start with the next plan run.</p>
      ) : (
        <>
          {source.saveResults && (
            <div className="rc-actions">
              <button
                ref={exportButton}
                type="button"
                className="button secondary"
                data-results="export"
                // Disabled by attribute would drop focus to the page while the file is written.
                aria-disabled={exporting ? true : undefined}
                onClick={() => void exportFile()}
              >
                Export JSON
              </button>
            </div>
          )}
          {recipes.length > 0 && (
            <div className="rc-results-part">
              <h3 id={`${ids}-recipes`}>By recipe</h3>
              <table aria-labelledby={`${ids}-recipes`}>
                <thead>
                  <tr>
                    <th scope="col">Recipe</th>
                    <th scope="col">Runs</th>
                    <th scope="col">Slices</th>
                    <th scope="col">Passed first review</th>
                    <th scope="col">Fix rounds</th>
                    <th scope="col">Accepted</th>
                    <th scope="col">Allowance used</th>
                  </tr>
                </thead>
                <tbody>
                  {recipes.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.name}</th>
                      <td data-label="Runs">{row.runs}</td>
                      <td data-label="Slices">{row.slices}</td>
                      <td data-label="Passed first review">{row.passed}</td>
                      <td data-label="Fix rounds">{row.fixRounds}</td>
                      <td data-label="Accepted">{row.accepted}</td>
                      <td data-label="Allowance used">
                        {row.allowance.map((text, index) => (
                          // The lines come in the controller's order and repeat when two windows
                          // read alike, so the place is the only key they have.
                          // biome-ignore lint/suspicious/noArrayIndexKey: see above
                          <span key={index} className="rc-results-line">
                            {text}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {read.moreRecipes > 0 && (
                <p className="rc-note">{moreRecipesLine(read.moreRecipes)}</p>
              )}
            </div>
          )}
          {crew.length > 0 && (
            <div className="rc-results-part">
              <h3 id={`${ids}-crew`}>By role and model</h3>
              <table aria-labelledby={`${ids}-crew`}>
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Model</th>
                    <th scope="col">Effort</th>
                    <th scope="col">Steps</th>
                    <th scope="col">Slices</th>
                    <th scope="col">Passed first review</th>
                    <th scope="col">Fix rounds</th>
                    <th scope="col">Accepted</th>
                    <th scope="col">Allowance used</th>
                  </tr>
                </thead>
                <tbody>
                  {crew.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.role}</th>
                      <td data-label="Model">
                        {row.model} <small>{row.provider}</small>
                      </td>
                      <td data-label="Effort">{row.effort}</td>
                      <td data-label="Steps">{row.steps}</td>
                      <td data-label="Slices">{row.slices}</td>
                      <td data-label="Passed first review">{row.passed}</td>
                      <td data-label="Fix rounds">{row.fixRounds}</td>
                      <td data-label="Accepted">{row.accepted}</td>
                      <td data-label="Allowance used">{row.allowance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {read.moreCrew > 0 && <p className="rc-note">{moreRowsLine(read.moreCrew)}</p>}
            </div>
          )}
        </>
      )}
      <p className="rc-results-status" role="status">
        {line ?? ''}
      </p>
    </section>
  );
}
