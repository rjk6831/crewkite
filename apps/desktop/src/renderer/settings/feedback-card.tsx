import type { DesktopSource } from '@crewkite/client';
import type { ChatCatalogRead } from '@crewkite/contracts';
import { useId, useState } from 'react';
import { ISSUE_URL } from '../../shared/feedback.ts';
import { familyName } from '../components.tsx';

type Source = Pick<DesktopSource, 'feedbackDraft' | 'sendFeedback'>;

/**
 * Feedback the person chooses to send. Main builds the report from what they wrote and the version
 * lines they ticked, shows it here to edit, and sends nothing until they copy it or open the issue.
 */
export function FeedbackCard({
  source,
  catalog,
}: {
  source?: Source;
  catalog: ChatCatalogRead | null;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState('');
  const [include, setInclude] = useState({ app: false, os: false, clients: false });
  const [report, setReport] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const clientVersions = (catalog?.families ?? []).flatMap((entry) =>
    entry.client?.version ? [`${familyName(entry.family)} ${entry.client.version}`] : [],
  );

  async function draft(next: { what: string; include: typeof include }) {
    try {
      setReport(
        (await source?.feedbackDraft?.({
          what: next.what,
          ...next.include,
          clientVersions,
        })) ?? '',
      );
    } catch (failure) {
      setNote(failure instanceof Error ? failure.message : 'The report could not be made.');
    }
  }
  const change = (next: { what: string; include: typeof include }) => {
    setWhat(next.what);
    setInclude(next.include);
    setNote(null);
    void draft(next);
  };
  async function send(to: 'copy' | 'github') {
    const result = await source?.sendFeedback?.({ report, to }).catch(() => 'refused' as const);
    setNote(
      result === 'done'
        ? to === 'copy'
          ? 'Copied.'
          : 'Opened the new issue in your browser. Nothing is sent until you submit it there.'
        : 'That did not work. Select the report and copy it by hand.',
    );
  }

  return (
    <section className="st-card" aria-labelledby={`${ids}-title`}>
      <header className="st-card-head">
        <h2 id={`${ids}-title`}>Feedback</h2>
        <span className="st-detail">Nothing is sent without you</span>
      </header>
      {!open ? (
        <div className="st-rows">
          <div className="st-row">
            <span className="st-field">
              <span className="st-name">Send feedback</span>
              <small className="st-hint">
                Write what happened and read the exact report before anything leaves this computer.
              </small>
            </span>
            <div className="st-controls">
              <button
                type="button"
                className="button secondary"
                disabled={!source?.feedbackDraft}
                onClick={() => {
                  setOpen(true);
                  void draft({ what, include });
                }}
              >
                Send feedback
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="st-rows">
          <div className="st-row">
            <label className="st-field" htmlFor={`${ids}-what`}>
              <span className="st-name">What happened</span>
              <small className="st-hint">
                Describe it in your own words. Do not paste source, transcripts or keys.
              </small>
            </label>
            <div className="st-controls">
              <textarea
                id={`${ids}-what`}
                rows={4}
                maxLength={4000}
                value={what}
                onChange={(event) => change({ what: event.target.value, include })}
              />
            </div>
          </div>
          <div className="st-row">
            <span className="st-field">
              <span className="st-name" id={`${ids}-add`}>
                Add to the report
              </span>
              <small className="st-hint">Each line stays out until you tick it.</small>
            </span>
            <fieldset className="st-controls" aria-labelledby={`${ids}-add`}>
              {(
                [
                  ['app', 'App version'],
                  ['os', 'Operating system'],
                  ['clients', 'Provider client versions'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="check-row">
                  <input
                    type="checkbox"
                    checked={include[key]}
                    onChange={(event) =>
                      change({ what, include: { ...include, [key]: event.target.checked } })
                    }
                  />{' '}
                  {label}
                </label>
              ))}
            </fieldset>
          </div>
          <div className="st-row">
            <label className="st-field" htmlFor={`${ids}-report`}>
              <span className="st-name">Report</span>
              <small className="st-hint">
                This is exactly what is copied or opened. Edit it freely. Changing the fields above
                writes it again. CrewKite adds no source, transcripts, keys or identifiers, and
                removes keys, email addresses and your home folder from what you write.
              </small>
            </label>
            <div className="st-controls">
              <textarea
                id={`${ids}-report`}
                rows={8}
                maxLength={8000}
                value={report}
                onChange={(event) => {
                  setReport(event.target.value);
                }}
              />
            </div>
          </div>
          <div className="st-row">
            <div className="st-actions">
              <button
                type="button"
                className="button secondary"
                disabled={report.trim() === ''}
                onClick={() => void send('copy')}
              >
                Copy report
              </button>
              <button
                type="button"
                className="button primary"
                disabled={report.trim() === ''}
                onClick={() => void send('github')}
              >
                Open GitHub issue
              </button>
            </div>
          </div>
          <p className="st-note">
            Open GitHub issue fills in a new issue at {ISSUE_URL.replace('https://', '')} in your
            browser. Nothing is sent until you submit it there.
          </p>
          <p className="st-note">
            Security concern? Do not post it as an issue. Use the private route in SECURITY.md.
          </p>
        </div>
      )}
      {note && (
        <p className="st-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
