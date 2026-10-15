import type { Route, Run } from '@crewkite/contracts';
import { Check, GitBranch, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';

export const familyName = (family: string) =>
  ({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', local: 'Local' })[family] ??
  family;
export const familyClass = (family: string) => `family-${family}`;
export const short = (value: string) => value.slice(0, 10);
export const titleCase = (value: string) =>
  value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ');

export function Dialog({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog dialog-wide' : 'dialog'}
      onCancel={onClose}
      aria-label={title}
    >
      <div className="dialog-heading">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
export function SourceFacts({ source }: { source: Run['source'] }) {
  return (
    <section className="card source-card">
      <div className="section-heading">
        <h2>
          <GitBranch size={15} />
          Source
        </h2>
        <span>Committed base</span>
      </div>
      <div className="facts-grid">
        <Fact label="Branch" value={source.branch} />
        <Fact label="Base" value={<code>{short(source.base)}</code>} />
        <Fact label="Dirty files" value={source.dirtyCount} />
        <Fact label="Untracked files" value={source.untrackedCount} />
      </div>
      <p className="muted small">
        Work runs in an independent scratch copy. Source changes stay in the original checkout.
      </p>
    </section>
  );
}
export function RouterCard({ run, routes }: { run: Run; routes: Route[] }) {
  const chosen = routes.find(({ id }) => id === run.decision.chosen);
  return (
    <section className="card router-card">
      <div className="section-heading">
        <h2>
          <GitBranch size={15} />
          Routing decision
        </h2>
        <span>{titleCase(run.decision.rule)}</span>
      </div>
      <div className="route-choice">
        <span className={`route-symbol ${familyClass(chosen?.family ?? '')}`}>
          {chosen?.family[0].toUpperCase() ?? '?'}
        </span>
        <div>
          <strong>{chosen?.displayName ?? 'Waiting for eligible capacity'}</strong>
          <p>
            {chosen
              ? `${chosen.model} · ${chosen.effort.effective} effort`
              : 'Review the rejected routes below.'}
          </p>
        </div>
        {chosen && (
          <span className="chosen-label">
            <Check size={12} />
            Selected
          </span>
        )}
      </div>
      {run.decision.rejected.length > 0 && (
        <div className="rejected-routes">
          {run.decision.rejected.map(({ routeId, reason }) => (
            <div key={routeId}>
              <span>{routes.find(({ id }) => id === routeId)?.family ?? short(routeId)}</span>
              <p>{reason}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function moveTabFocus(event: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}
