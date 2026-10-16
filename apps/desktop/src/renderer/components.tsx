import type { Effect, Route, Run, Snapshot, SourceDetails, Task } from '@crewkite/contracts';
import { parseReviewTarget } from '@crewkite/contracts';
import { Check, GitBranch, Info, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react';

export const familyName = (family: string) =>
  ({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', local: 'Local' })[family] ??
  family;
export const familyClass = (family: string) => `family-${family}`;
export const short = (value: string) => value.slice(0, 10);
export const titleCase = (value: string) =>
  value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ');
export function duration(milliseconds: number) {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60000));
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} days`;
  if (minutes >= 60) return `${Math.round(minutes / 60)} hours`;
  return `${minutes} min`;
}

export const methodName = (id: string) =>
  ({
    'keep-it-simple': 'Keep it simple',
    'challenge-assumptions': 'Challenge assumptions',
    'second-opinion': 'Second opinion',
    'round-robin': 'Round-robin review',
  })[id] ?? 'Review';

export const actionName = (action: Effect['action']) =>
  ({
    'read-source': 'Read the committed source',
    'write-scratch': 'Write the scratch copy',
    'run-check': 'Run candidate checks',
    'run-review': 'Run a review',
    'accept-candidate': 'Create the named local branch',
    'export-patch': 'Export the retained patch',
  })[action];

export function effectTarget(effect: Effect, task: Task, projectName?: string) {
  if (effect.action === 'run-review') {
    const review = parseReviewTarget(effect.target);
    return review ? `${methodName(review.methodId)} · round ${review.cycle}` : 'Named review';
  }
  if (effect.action === 'export-patch') return `Patch for ${task.title}`;
  if (effect.action === 'run-check') return `Checks for ${task.title}`;
  if (effect.action === 'write-scratch' || effect.action === 'read-source')
    return projectName ? `${projectName} workspace` : 'Named workspace';
  return effect.target;
}

export function Help({ label, children }: { label: string; children: ReactNode }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const anchor = `--help-${id}`;
  const content = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <span className="help">
      <button
        ref={trigger}
        type="button"
        className="help-button"
        style={{ anchorName: anchor }}
        aria-label={`About ${label}`}
        aria-describedby={`help-${id}`}
        onFocus={() => content.current?.showPopover()}
        onBlur={() => content.current?.hidePopover()}
        onClick={() => content.current?.showPopover()}
        onMouseEnter={() => content.current?.showPopover()}
        onMouseLeave={(event) => {
          if (
            document.activeElement !== trigger.current &&
            !(event.relatedTarget instanceof Node && content.current?.contains(event.relatedTarget))
          )
            content.current?.hidePopover();
        }}
      >
        <Info size={13} aria-hidden="true" />
      </button>
      <span
        ref={content}
        id={`help-${id}`}
        role="tooltip"
        popover="auto"
        className="help-content"
        style={{ positionAnchor: anchor }}
        onMouseLeave={() => {
          if (document.activeElement !== trigger.current) content.current?.hidePopover();
        }}
      >
        {children}
      </span>
    </span>
  );
}

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
export function CurrentCheckoutChanges({
  source,
  details,
  receivedAt,
}: {
  source: Run['source'];
  details: SourceDetails;
  receivedAt: string;
}) {
  return (
    <details className="card checkout-changes">
      <summary>
        Current checkout changes
        <span className="checkout-count">
          {source.dirtyCount} changed · {source.untrackedCount} untracked
        </span>
      </summary>
      <p className="muted small">
        Inspection received at {new Date(receivedAt).toLocaleTimeString()}. This is the current
        checkout, separate from a saved run's source snapshot. Scratch starts from the committed
        base; these local changes stay in the original checkout.
      </p>
      <ul>
        {details.files.map((file) => (
          <li key={file.path}>
            <code>{file.path}</code>
            <span className="checkout-status">
              {titleCase(file.status.replaceAll('-', ' '))}
              {file.status !== 'untracked' &&
                ` · ${[file.staged ? 'staged' : '', file.unstaged ? 'unstaged' : ''].filter(Boolean).join(', ')}`}
            </span>
          </li>
        ))}
      </ul>
      {(details.omittedDirty > 0 || details.omittedUntracked > 0) && (
        <p className="muted small">
          {details.omittedDirty} other changed files and {details.omittedUntracked} untracked files
          are not shown.
        </p>
      )}
      {source.dirtyCount + source.untrackedCount === 0 && (
        <p className="muted small">No local changes in this inspection.</p>
      )}
    </details>
  );
}
export function RouterCard({
  run,
  routes,
  usage,
}: {
  run: Run;
  routes: Route[];
  usage: Snapshot['usage'];
}) {
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
              <span>
                {familyName(routes.find(({ id }) => id === routeId)?.family ?? short(routeId))}
              </span>
              <div>
                <p>{reason}</p>
                {usage.filter(({ observation }) => observation.routeId === routeId).length ? (
                  usage
                    .filter(({ observation }) => observation.routeId === routeId)
                    .map(({ observation, state }) => {
                      const age = Date.now() - Date.parse(observation.observedAt);
                      return (
                        <p className="muted small" key={observation.windowId}>
                          {observation.windowId} · {observation.source} · {state} ·{' '}
                          <time
                            dateTime={observation.observedAt}
                            title={new Date(observation.observedAt).toLocaleString()}
                          >
                            {age < 0 ? 'future timestamp' : `${duration(age)} ago`}
                          </time>
                        </p>
                      );
                    })
                ) : (
                  <p className="muted small">No current usage observation is available.</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="muted small">
        Decision saved for this run. Observations shown are current reports.
      </p>
      {!run.decision.chosen && (
        <details className="technical-details">
          <summary>Usage options</summary>
          <p>
            For a never-started draft, choose Edit configuration, then Policy &gt; Unknown usage:
            Wait for fresh observations, Limit unknown usage to 1 launch and 5 min, or Allow
            selected routes within run limits. Scripted observations do not refresh automatically.
          </p>
        </details>
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
