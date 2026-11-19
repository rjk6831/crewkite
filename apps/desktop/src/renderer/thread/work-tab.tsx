import type { AcceptanceAttempt, ChatThread, ChatTurn } from '@crewkite/contracts';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { coalescedRead } from '../coalesced-read.ts';
import { shortTime } from '../format-time.ts';
import { openRecipeDraft } from '../recipes/draft-bus.ts';
import { draftRecipe, readAcceptance, releaseCheck, type ThreadSource } from './commands.ts';
import { FamilyMark } from './family-mark.tsx';
import { useRemoteWrites } from './github-section.tsx';
import { modelLine } from './message-list.tsx';
import { type ModelLabel, useModelLabel } from './model-labels.ts';
import { planCard } from './plan-card.ts';
import { PrepareButton, PrepareStatus, type ThreadCopy } from './prepare-dependencies.tsx';
import { useProjectNotes } from './project-notes.tsx';
import { type CheckEvidence, holds, type WorkRow, workRows } from './work-view.ts';
import './work-tab.css';

/**
 * The Accept that holds the thread. Each change of an Accept changes the thread, so each thread
 * change reads it again. A burst of changes reads once more after the read in flight. A failed
 * read keeps what the tab showed, and the next change reads again.
 */
function useAcceptance(source: ThreadSource, taskId: string, thread: ChatThread | null) {
  const [accept, setAccept] = useState<AcceptanceAttempt | null>(null);
  const read = useMemo(() => coalescedRead(() => readAcceptance(source, taskId)), [source, taskId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a thread change is when it moves
  useEffect(() => {
    let active = true;
    read().then(
      (value) => active && setAccept(value.current),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [read, thread]);
  return accept;
}

const resultWords: Record<CheckEvidence['result'], string> = {
  running: 'running since',
  passed: 'passed',
  failed: 'failed',
  unknown: 'unconfirmed',
};

const evidenceLine = (name: string, evidence: CheckEvidence) =>
  `${name} ${resultWords[evidence.result]} ${shortTime(evidence.at)}${
    evidence.result === 'failed' && evidence.failed.length ? `: ${evidence.failed.join(', ')}` : ''
  }`;

const ownerLine = (row: WorkRow, label: ModelLabel) =>
  row.owner ? modelLine(row.owner, label) : 'Not assigned yet';

// A row is one button, so it reads as one sentence in the order the row shows it.
const rowLabel = (row: WorkRow, label: ModelLabel) =>
  [
    `Slice ${row.id}: ${row.title}`,
    row.status,
    ownerLine(row, label),
    row.after,
    row.checks && evidenceLine('Checks', row.checks),
    row.merged && evidenceLine('After merge', row.merged),
    row.turnId ? null : 'Not started',
  ]
    .filter(Boolean)
    .join('. ');

const NODE = 9;
const COLUMN = 44;
const LINE = 28;
const EDGE = 12;

/**
 * The same slices as the list, drawn by dependency: each column holds the slices one step after
 * the column before it. It adds nothing the list does not say, so readers skip it.
 */
function PlanDiagram({ rows }: { rows: readonly WorkRow[] }) {
  const filled = new Map<number, number>();
  const places = rows.map((row) => {
    const index = filled.get(row.depth) ?? 0;
    filled.set(row.depth, index + 1);
    return { row, x: EDGE + row.depth * COLUMN, y: EDGE + index * LINE };
  });
  const at = new Map(places.map((place) => [place.row.id, place]));
  const width = EDGE * 2 + Math.max(...rows.map((row) => row.depth)) * COLUMN;
  const height = EDGE * 2 + (Math.max(...filled.values()) - 1) * LINE;
  return (
    <svg
      className="th-work-graph"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      {places.flatMap(({ row, x, y }) =>
        row.depends.map((id) => {
          const from = at.get(id);
          if (!from) return null;
          const middle = (from.x + x) / 2;
          return (
            <path
              key={`${id}-${row.id}`}
              className={from.row.tone === 'done' ? 'th-work-edge is-met' : 'th-work-edge'}
              d={`M ${from.x + NODE} ${from.y} C ${middle} ${from.y}, ${middle} ${y}, ${x - NODE} ${y}`}
            />
          );
        }),
      )}
      {places.map(({ row, x, y }) => (
        <g key={row.id} className={`th-work-node is-${row.tone}`}>
          <circle cx={x} cy={y} r={NODE} />
          <text x={x} y={y} dy="0.35em" textAnchor="middle">
            {row.id}
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * The slices as a list the keyboard moves through: one stop in the tab order, arrow keys, Home
 * and End move between rows, and Enter or a click opens the slice's turn in the thread.
 */
function SliceList({
  rows,
  onOpenTurn,
}: {
  rows: readonly WorkRow[];
  onOpenTurn: (turnId: string) => void;
}) {
  const label = useModelLabel();
  const list = useRef<HTMLOListElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const current = rows.some((row) => row.id === active) ? active : (rows[0]?.id ?? null);
  function move(event: KeyboardEvent<HTMLButtonElement>, at: number) {
    const to: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowUp: at - 1,
      Home: 0,
      End: rows.length - 1,
    };
    if (!Object.hasOwn(to, event.key)) return;
    event.preventDefault();
    const row = rows[Math.min(Math.max(to[event.key], 0), rows.length - 1)];
    setActive(row.id);
    list.current?.querySelector<HTMLElement>(`[data-slice="${row.id}"]`)?.focus();
  }
  return (
    <>
      <p className="th-muted">Arrow keys move between slices. Enter opens a slice's turn.</p>
      <ol ref={list} className="th-work-slices" aria-label="Slices">
        {rows.map((row, at) => (
          <li key={row.id}>
            <button
              type="button"
              data-slice={row.id}
              className={`th-work-slice is-${row.tone}`}
              tabIndex={row.id === current ? 0 : -1}
              aria-label={rowLabel(row, label)}
              aria-disabled={row.turnId ? undefined : true}
              title={row.turnId ? 'Open its turn in the thread' : 'This slice has not started.'}
              onFocus={() => setActive(row.id)}
              onKeyDown={(event) => move(event, at)}
              onClick={() => {
                if (row.turnId) onOpenTurn(row.turnId);
              }}
            >
              <span className="th-work-line">
                <span className="th-work-id">{row.id}</span>
                <span className="th-work-title">{row.title}</span>
                <span className={`th-work-status is-${row.tone}`}>{row.status}</span>
              </span>
              <span className="th-work-meta">
                <span className="th-session">
                  {row.owner && <FamilyMark family={row.owner.family} />}
                  {ownerLine(row, label)}
                </span>
                {row.after && <span>{row.after}</span>}
              </span>
              {(row.checks || row.merged) && (
                <span className="th-work-evidence">
                  {row.checks && (
                    <span className={`is-${row.checks.result}`}>
                      {evidenceLine('Checks', row.checks)}
                    </span>
                  )}
                  {row.merged && (
                    <span className={`is-${row.merged.result}`}>
                      {evidenceLine('After merge', row.merged)}
                    </span>
                  )}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

const NOTE_BYTES = 300;

/**
 * Release the thread from a check that lost track of its process. The panel says what the person
 * risks and takes a note on what they checked. Nothing is sent until they confirm. Focus moves into
 * the panel when it opens and back to its button when it closes, and Escape closes it.
 */
function ReleaseCheck({ source, taskId }: { source: ThreadSource; taskId: string }) {
  const ids = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLFieldSetElement>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    setError(null);
    // The button comes back on the next render.
    requestAnimationFrame(() => opener.current?.focus());
  };
  const text = note.trim();
  const long = new TextEncoder().encode(text).byteLength > NOTE_BYTES;
  const ready = text !== '' && !long;
  const release = () => {
    setBusy(true);
    setError(null);
    // The panel and its button may be gone once the thread is free, so focus lands on the tab.
    const tab = panel.current?.closest<HTMLElement>('.th-work');
    // A note the schema refuses throws before any request, so it goes through the same catch.
    Promise.resolve()
      .then(() => releaseCheck(source, taskId, text))
      .then(() => {
        setOpen(false);
        requestAnimationFrame(() => {
          const first = tab?.querySelector<HTMLElement>(
            'button:not(:disabled), [href], input, textarea, select, [tabindex="0"]',
          );
          (first ?? tab)?.focus();
        });
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'The request was not accepted.'),
      )
      .finally(() => setBusy(false));
  };
  if (!open)
    return (
      <span className="th-work-step">
        <button ref={opener} type="button" className="th-button" onClick={() => setOpen(true)}>
          Release the thread
        </button>
      </span>
    );
  return (
    <fieldset
      ref={panel}
      className="th-work-release"
      aria-describedby={`${ids}-risk`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        // A release on its way still answers here, so the panel stays until it does.
        if (!busy) close();
      }}
    >
      <legend>Release this thread</legend>
      <p id={`${ids}-risk`}>
        If the check's process still runs, it can change files in this thread's copy while you work.
        Look for a leftover test or build process first, and quit it if you find one.
      </p>
      <label>
        What you checked
        <textarea
          ref={field}
          value={note}
          rows={2}
          maxLength={NOTE_BYTES}
          required
          aria-describedby={long ? `${ids}-hint ${ids}-long` : `${ids}-hint`}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <p id={`${ids}-hint`} className="th-muted">
        Kept with the check's record.
      </p>
      {long && (
        <p id={`${ids}-long`} className="th-error" role="status">
          A note is at most 300 bytes.
        </p>
      )}
      {error && (
        <p className="th-error" role="alert">
          {error}
        </p>
      )}
      <div className="th-work-release-actions">
        <button type="button" className="th-button" disabled={busy || !ready} onClick={release}>
          Release the thread
        </button>
        <button type="button" className="th-button" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

/**
 * Drafts a recipe from the finished plan and opens the Recipes page on it. The draft saves
 * nothing. The controller refuses a thread with no finished plan, and its sentence shows here.
 */
function SaveAsRecipe({ source, taskId }: { source: ThreadSource; taskId: string }) {
  const projectId = useProjectNotes()?.projectId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const draft = await draftRecipe(source, taskId);
      // The draft's name is the thread's title cut to 80 characters.
      openRecipeDraft({ projectId, draft, threadTitle: draft.recipe.name });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="th-work-recipe">
      <button type="button" className="th-button" disabled={busy || !projectId} onClick={save}>
        Save as recipe
      </button>
      {error && (
        <p className="th-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The Work tab: what holds the thread now, each with the step that clears it, then the plan's
 * slices with their owner, standing, dependencies and check results.
 */
export function WorkTab({
  source,
  taskId,
  thread,
  turns,
  copy,
  onOpenTurn,
}: {
  source: ThreadSource;
  taskId: string;
  thread: ChatThread | null;
  turns: readonly ChatTurn[];
  copy: ThreadCopy;
  /** Scrolls the thread to a turn and marks it. */
  onOpenTurn: (turnId: string) => void;
}) {
  const ids = useId();
  const accept = useAcceptance(source, taskId, thread);
  const { effects } = useRemoteWrites(source, taskId);
  const { preparations, lines: said, preparing } = copy;
  const lines = thread ? holds({ thread, turns, accept, effects, preparations, lines: said }) : [];
  const plan = thread?.plan ?? null;
  const rows = plan ? workRows(plan, thread?.checks?.runs ?? []) : [];
  return (
    // The tab takes focus after a release when nothing in it can.
    <div className="th-work" tabIndex={-1}>
      {lines.length > 0 ? (
        <section className="th-work-holds" aria-labelledby={`${ids}-holds`}>
          <h3 id={`${ids}-holds`}>Blocked by</h3>
          <ul>
            {lines.map((line) => (
              <li key={`${line.reason} ${line.action}`}>
                {line.reason} <span className="th-work-action">{line.action}</span>
                {line.prepare && (
                  <span className="th-work-step">
                    <PrepareButton preparing={preparing} />
                  </span>
                )}
                {line.release && <ReleaseCheck source={source} taskId={taskId} />}
              </li>
            ))}
          </ul>
          <PrepareStatus preparing={preparing} />
        </section>
      ) : (
        <>
          <p className="th-muted">Nothing blocks this thread now.</p>
          <PrepareStatus preparing={preparing} />
        </>
      )}
      <section className="th-work-plan" aria-labelledby={`${ids}-plan`}>
        <h3 id={`${ids}-plan`}>Plan</h3>
        {plan && thread ? (
          <>
            <p className="th-work-summary">{planCard(plan, thread.flightMode).summary}</p>
            {rows.some((row) => row.depends.length > 0) && <PlanDiagram rows={rows} />}
            <SliceList rows={rows} onOpenTurn={onOpenTurn} />
            {plan.phase === 'finished' && <SaveAsRecipe source={source} taskId={taskId} />}
          </>
        ) : (
          <p className="th-muted">
            No plan in this thread. With an orchestrator in the crew, Balanced and Glide propose one
            for work that splits into parts.
          </p>
        )}
      </section>
    </div>
  );
}
