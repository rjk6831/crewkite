import type { ChatFlightMode, ChatPlanState } from '@crewkite/contracts';
import { useState } from 'react';
import { familyName } from '../components.tsx';
import { FamilyMark } from './family-mark.tsx';
import { type PlanSliceView, planCard, planOverrides } from './plan-card.ts';
import './plan-card.css';

export type PlanHandlers = {
  /** Runs the whole plan, or one slice. `overrides` are the families picked in Balanced. */
  onRun: (input: {
    sliceId?: number;
    overrides?: { sliceId: number; family: string; model: string }[];
  }) => Promise<void>;
  onCancel: () => Promise<void>;
  onStop: () => Promise<void>;
};

const failure = (error: unknown) =>
  error instanceof Error ? error.message : 'The request was not accepted.';

function SliceRow({
  view,
  pick,
  onPick,
  onRun,
  busy,
}: {
  view: PlanSliceView;
  pick: number | undefined;
  onPick: (index: number) => void;
  onRun: () => void;
  busy: boolean;
}) {
  const { slice } = view;
  const assigned = slice.assignment;
  const candidates = view.picker;
  const chosen = candidates ? candidates[pick ?? 0] : null;
  const reason = chosen?.reason ?? assigned?.reason ?? null;
  return (
    <li className={`th-plan-slice is-${slice.status}`}>
      <div className="th-plan-line">
        <span className="th-plan-id">{slice.id}</span>
        <span className="th-plan-title">{slice.title}</span>
        <span className="th-plan-difficulty">{slice.difficulty}</span>
        <span className={`th-plan-status is-${slice.status}`}>
          {slice.status === 'running' && assigned ? (
            <>
              <FamilyMark family={assigned.family} />
              <span className="th-sr">{familyName(assigned.family)}, </span>
            </>
          ) : null}
          {view.statusLabel}
        </span>
        {view.canRun && (
          <button
            type="button"
            className="th-pill th-outline"
            disabled={busy}
            aria-label={`Run slice ${slice.id}: ${slice.title}`}
            onClick={onRun}
          >
            Run
          </button>
        )}
      </div>
      {candidates ? (
        <label className="th-plan-pick">
          <span className="th-sr">Provider for slice {slice.id}</span>
          <select
            value={pick ?? 0}
            disabled={busy}
            onChange={(event) => onPick(Number(event.target.value))}
          >
            {candidates.map((candidate, index) => (
              <option key={`${candidate.family}:${candidate.model}`} value={index}>
                {familyName(candidate.family)} · {candidate.model}
              </option>
            ))}
          </select>
        </label>
      ) : (
        assigned && (
          <p className="th-plan-where">
            <FamilyMark family={assigned.family} />
            {familyName(assigned.family)} · {assigned.model}
          </p>
        )
      )}
      {reason && <p className="th-plan-reason">{reason}</p>}
      {view.waitsOn && <p className="th-plan-reason">{view.waitsOn}.</p>}
    </li>
  );
}

/**
 * The plan the orchestrator proposed and the controller assigned. The card follows the flight
 * mode: Manual waits for Run on a slice or Run plan, Balanced waits for Run plan with a provider
 * pick per slice, and Glide runs on its own and offers Stop.
 */
export function PlanCard({
  plan,
  flight,
  onRun,
  onCancel,
  onStop,
}: { plan: ChatPlanState; flight: ChatFlightMode } & PlanHandlers) {
  const view = planCard(plan, flight);
  const [picks, setPicks] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="th-plan" aria-label="Plan">
      <header className="th-plan-head">
        <h3>Plan</h3>
        <p className="th-plan-summary">{view.summary}</p>
      </header>
      <p className="th-plan-goal" title={plan.goal}>
        {plan.goal}
      </p>
      <ol className="th-plan-slices">
        {view.rows.map((row) => (
          <SliceRow
            key={row.slice.id}
            view={row}
            pick={picks[row.slice.id]}
            busy={busy}
            onPick={(index) => setPicks((current) => ({ ...current, [row.slice.id]: index }))}
            onRun={() => void act(() => onRun({ sliceId: row.slice.id }))}
          />
        ))}
      </ol>
      {(view.runPlan || view.cancel || view.stop) && (
        <div className="th-plan-actions">
          {view.runPlan && (
            <button
              type="button"
              className="th-button"
              disabled={busy}
              onClick={() => {
                const overrides = planOverrides(plan, picks);
                void act(() => onRun(overrides.length > 0 ? { overrides } : {}));
              }}
            >
              Run plan
            </button>
          )}
          {view.cancel && (
            <button
              type="button"
              className="th-pill th-outline"
              disabled={busy}
              onClick={() => void act(onCancel)}
            >
              Cancel
            </button>
          )}
          {view.stop && (
            <button
              type="button"
              className="th-pill th-outline"
              disabled={busy}
              onClick={() => void act(onStop)}
            >
              Stop
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="th-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
